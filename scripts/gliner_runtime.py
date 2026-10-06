#!/usr/bin/env python3
"""Persistent, offline GLiNER classifier. Stdout is JSON lines only."""

import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import sys

MODEL = "fastino/GLiNER2.5-Decide"
REVISION = "5a7adf72a23b4d311abae6ce050d7f0012bb3416"
LIBRARY_VERSION = "2.0.0"
MAX_LINE_BYTES = 1_048_576
MAX_TEXT_CHARS = 65_536
MAX_HEADS = 32
MAX_LABELS = 64


class RequestError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class DiscardOutput:
    """Discard upstream output without buffering private text or unbounded logs."""
    def write(self, text):
        return len(text)

    def flush(self):
        pass


@contextlib.contextmanager
def quiet_library():
    sink = DiscardOutput()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        yield


def emit(value, stream=None):
    print(json.dumps(value, ensure_ascii=True, allow_nan=False), file=stream or sys.stdout, flush=True)


def sigmoid(value):
    if not math.isfinite(value):
        raise RequestError("invalid_scores", "Model returned a non-finite logit")
    if value >= 0:
        return 1 / (1 + math.exp(-value))
    exp = math.exp(value)
    return exp / (1 + exp)


def safe_schema_text(text):
    # GLiNER's schema compiler reserves structural markers and parentheses.
    # Preserve user-visible meaning while preventing marker parsing collisions.
    return text.replace("[", "［").replace("]", "］").replace("(", "（").replace(")", "）")


def validate_request(request):
    if not isinstance(request, dict):
        raise RequestError("invalid_request", "Request must be an object")
    text, heads = request.get("text"), request.get("heads")
    if not isinstance(text, str) or not text.strip():
        raise RequestError("invalid_request", "text must be a non-empty string")
    if len(text) > MAX_TEXT_CHARS:
        raise RequestError("input_too_large", f"text exceeds {MAX_TEXT_CHARS} characters; shorten state")
    if not isinstance(heads, dict) or not 1 <= len(heads) <= MAX_HEADS:
        raise RequestError("invalid_request", f"heads must contain 1..{MAX_HEADS} questions")
    for name, head in heads.items():
        if not isinstance(name, str) or not name or not isinstance(head, dict):
            raise RequestError("invalid_request", "Each head must have a non-empty ID and object value")
        labels, prompt = head.get("labels"), head.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise RequestError("invalid_request", "Each head needs a non-empty prompt")
        if not isinstance(labels, dict) or not 2 <= len(labels) <= MAX_LABELS:
            raise RequestError("invalid_request", f"Each head needs 2..{MAX_LABELS} labels")
        if any(not isinstance(k, str) or not k.strip() or not isinstance(v, str) or not v.strip()
               for k, v in labels.items()):
            raise RequestError("invalid_request", "Label IDs and descriptions must be non-empty strings")
    return text, heads


class Runtime:
    def __init__(self, runtime_dir):
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                          HF_HUB_DISABLE_IMPLICIT_TOKEN="1", HF_HUB_DISABLE_PROGRESS_BARS="1",
                          TOKENIZERS_PARALLELISM="false")
        import importlib.metadata
        if importlib.metadata.version("gliner2") != LIBRARY_VERSION:
            raise RuntimeError(f"Expected gliner2=={LIBRARY_VERSION}; rerun setup:gliner")
        import torch
        from transformers import DebertaV2Config, DebertaV2Model
        from gliner2 import SpanExtractor
        from gliner2.classification import Classifier

        class SafeSpanExtractor(SpanExtractor):
            @staticmethod
            def _load_encoder(model_name, encoder_config=None, attn_implementation=None,
                              use_flashdeberta=None):
                # Upstream's generic loader enables remote code. This fixed model
                # uses Transformers' built-in DeBERTa; never call that loader.
                if not isinstance(encoder_config, DebertaV2Config):
                    raise RuntimeError("Pinned model must use built-in DebertaV2Config")
                return DebertaV2Model(encoder_config).float()

        model_dir = runtime_dir / "model"
        config = json.loads((model_dir / "config.json").read_text())
        if config.get("architecture") != "span" or config.get("model_name") != "microsoft/deberta-v3-large":
            raise RuntimeError("Unexpected pinned model architecture")
        if not (model_dir / "model.safetensors").is_file():
            raise RuntimeError("Pinned safetensors model missing; run npm run setup:gliner")
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        self.model = SafeSpanExtractor.from_pretrained(str(model_dir), local_files_only=True,
                                                      map_location="cpu", use_flashdeberta=False)
        self.classifier = Classifier(self.model).eval()
        self.max_input_tokens = int(self.model.encoder.config.max_position_embeddings)

    def evaluate(self, request):
        text, heads = validate_request(request)
        from gliner2.classification import ClassificationSchema
        schema = ClassificationSchema()
        mapping = {}
        for i, (head_id, head) in enumerate(heads.items()):
            task_id = f"question_{i}"
            labels, label_map = {}, {}
            for j, (label_id, description) in enumerate(head["labels"].items()):
                # Keep semantic names such as yes/no while isolating arbitrary IDs.
                model_label = safe_schema_text(label_id)
                while model_label in labels:
                    model_label = f"_{model_label}_{j}"
                labels[model_label] = safe_schema_text(description)
                label_map[model_label] = label_id
            schema.single(task_id, labels, instruction=safe_schema_text(head["prompt"]), activation="sigmoid")
            mapping[task_id] = (head_id, label_map)
        compiled = self.classifier.compile_schema(schema)
        # Count the actual combined text + schema subwords, without truncation or
        # the library's default malformed-record fallback.
        batch = self.model.processor.collate_fn_inference([(text, compiled.build())],
                                                          max_len=None, error_policy="raise")
        tokens = int(batch.input_ids.shape[-1])
        if tokens > self.max_input_tokens:
            raise RequestError("input_too_large", f"Input and question schema use {tokens} tokens; limit "
                               f"{self.max_input_tokens}. Shorten state or split questions; nothing was truncated.")
        raw = self.classifier.score(text, compiled)
        if set(raw.tasks) != set(mapping):
            raise RequestError("invalid_scores", "Model did not score every requested question")
        scores, logits = {}, {}
        for task_id, (head_id, label_map) in mapping.items():
            task_logits = raw.tasks[task_id]
            if set(task_logits) != set(label_map):
                raise RequestError("invalid_scores", "Model did not score every requested label")
            logits[head_id] = {label_map[k]: float(v) for k, v in task_logits.items()}
            scores[head_id] = {k: sigmoid(v) for k, v in logits[head_id].items()}
        return {"id": request.get("id"), "model": MODEL, "revision": REVISION,
                "scoreSemantics": "independent_sigmoid", "scores": scores, "logits": logits,
                "inputTokens": tokens}


def serve(runtime, incoming=sys.stdin, outgoing=sys.stdout):
    emit({"type": "ready", "protocol": 1, "model": MODEL, "revision": REVISION,
          "device": "cpu", "maxInputTokens": runtime.max_input_tokens}, outgoing)
    while True:
        line = incoming.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        request = None
        try:
            if len(line.encode("utf-8")) > MAX_LINE_BYTES:
                while line and not line.endswith("\n"):
                    line = incoming.readline(MAX_LINE_BYTES + 1)
                raise RequestError("input_too_large", "JSON line exceeds 1 MiB")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise RequestError("invalid_request", "Request must be an object")
            if request.get("action") == "shutdown":
                emit({"id": request.get("id"), "type": "shutdown"}, outgoing)
                return
            if request.get("action") != "evaluate":
                raise RequestError("invalid_request", "action must be evaluate or shutdown")
            with quiet_library():
                result = runtime.evaluate(request)
            emit(result, outgoing)
        except Exception as exc:
            # Do not echo private state, malformed JSON, or library exception data.
            code = exc.code if isinstance(exc, RequestError) else "inference_failed"
            message = str(exc) if isinstance(exc, RequestError) else (
                "Malformed JSON" if isinstance(exc, json.JSONDecodeError) else
                "GLiNER inference failed; verify setup and input schema")
            emit({"id": request.get("id") if isinstance(request, dict) else None,
                  "error": {"code": code, "message": message}}, outgoing)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", type=Path,
                        default=Path(__file__).resolve().parent.parent / ".jev-polls" / "gliner")
    args = parser.parse_args()
    try:
        emit({"event": "gliner_loading", "model": MODEL, "revision": REVISION}, sys.stderr)
        with quiet_library():
            runtime = Runtime(args.runtime_dir)
        serve(runtime)
    except Exception:
        emit({"type": "error", "error": {"code": "setup_required", "message":
             "GLiNER could not load its pinned local model. Run npm run setup:gliner."}})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
