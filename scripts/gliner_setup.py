#!/usr/bin/env python3
"""Install isolated Python dependencies, pinned model, and real smoke check."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

sys.dont_write_bytecode = True
from gliner_runtime import LIBRARY_VERSION, MODEL, REVISION, Runtime, emit, quiet_library


def download_and_check(runtime_dir):
    os.environ.update(HF_HUB_DISABLE_IMPLICIT_TOKEN="1", HF_HUB_DISABLE_PROGRESS_BARS="1",
                      TOKENIZERS_PARALLELISM="false")
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL, revision=REVISION, local_dir=str(runtime_dir / "model"), token=False,
                      allow_patterns=["*.json", "*.txt", "*.model", "*.spm", "model.safetensors"])
    with quiet_library():
        runtime = Runtime(runtime_dir)
        result = runtime.evaluate({"id": "setup-smoke", "text": "I love this product. It works perfectly.",
                                   "heads": {"sentiment": {"prompt": "Classify the review sentiment.",
                                              "labels": {"positive": "A favorable review",
                                                         "negative": "An unfavorable review"}}}})
    scores = result["scores"]["sentiment"]
    if scores["positive"] <= scores["negative"]:
        raise RuntimeError("Real model smoke check did not recognize positive synthetic text")
    stamp = {"model": MODEL, "revision": REVISION, "protocol": 1, "libraryVersion": LIBRARY_VERSION,
             "device": "cpu", "maxInputTokens": runtime.max_input_tokens}
    temporary = runtime_dir / "ready.json.tmp"
    temporary.write_text(json.dumps(stamp) + "\n")
    temporary.replace(runtime_dir / "ready.json")
    emit({"ready": True, **stamp, "smoke": result})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path,
                        default=Path(__file__).resolve().parent.parent / ".jev-polls" / "gliner")
    parser.add_argument("--download", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    runtime_dir = args.runtime_dir.resolve()
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "ready.json").unlink(missing_ok=True)
    try:
        if args.download:
            emit({"event": "gliner_download", "model": MODEL, "revision": REVISION}, sys.stderr)
            download_and_check(runtime_dir)
            return 0
        if not (3, 10) <= sys.version_info[:2] <= (3, 13):
            emit({"ready": False, "error": "Use Python 3.10–3.13; Python 3.11 recommended."})
            return 1
        emit({"event": "gliner_install", "runtimeDir": str(runtime_dir)}, sys.stderr)
        python = runtime_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.is_file():
            venv.EnvBuilder(with_pip=True).create(runtime_dir)
        install = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                                  "--quiet", "-r", str(Path(__file__).with_name("gliner_requirements.txt"))],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if install.returncode:
            emit({"ready": False, "error": "GLiNER dependency installation failed. Check Python version and network access."})
            return install.returncode
        return subprocess.run([str(python), str(Path(__file__).resolve()), "--download",
                               "--runtime-dir", str(runtime_dir)]).returncode
    except Exception:
        emit({"ready": False, "error": "GLiNER setup failed. Check model download/network access and available memory."})
        return 1


if __name__ == "__main__":
    sys.exit(main())
