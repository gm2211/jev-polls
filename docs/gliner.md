# Local GLiNER2.5-Decide

GLiNER is an optional local provider for synthetic research judgments. It runs
Fastino's English specialist classifier, not a general chat model. Synthetic
persona responses remain model judgments, never observed human survey data.

Install Python 3.11–3.13 (3.11 recommended), then run:

```sh
npm run setup:gliner
```

Alternatively, use an explicit compatible interpreter:

```sh
python3.11 scripts/gliner_setup.py
```

Setup creates `.jev-polls/gliner/`, installs pinned local dependencies, downloads
the public safetensors model, and runs a real positive-review smoke check. It
writes `ready.json` only after successful inference. No API key is required.
The initial download needs network access and about 2 GB for model weights, plus
Python/PyTorch dependencies. Inference uses CPU and stays offline afterward.
Keep several GB of RAM available. No global Python packages are installed.

Model: [`fastino/GLiNER2.5-Decide`](https://huggingface.co/fastino/GLiNER2.5-Decide),
revision `5a7adf72a23b4d311abae6ce050d7f0012bb3416`. Library: `gliner2==2.1.0`
on `transformers==5.20.2` and `huggingface-hub==1.33.0` (all pins live in
`scripts/gliner_requirements.txt`). The pinned checkpoint uses the span
architecture with DeBERTa-v3-large. Its encoder is constructed with
Transformers' built-in `DebertaV2Model`; the upstream generic loader that
enables `trust_remote_code` is bypassed. Setup downloads
data/configuration/safetensors only; inference never loads Hub code.

After upgrading from an older checkout, re-run `npm run setup:gliner` once. The
worker refuses to start on an older `gliner2` (`Expected gliner2==2.1.0`) until
setup has upgraded the venv in place; the model download is reused, not repeated.

## Dependency pins and score stability

`transformers` 4.57.6 carried several Hub and Trainer advisories whose fixes are
all in 5.x, and `gliner2` 2.0.0 caps `transformers<5`. Moving to `gliner2` 2.1.0
(`transformers<6`) lifts that cap. `huggingface-hub` moves to the 1.x line that
Transformers 5 requires (1.31 or newer); the pins avoid anything published less
than 72 hours before the bump.

The upgrade does not change what the model computes. The old pins (`gliner2`
2.0.0, `transformers` 4.57.6, `huggingface-hub` 0.36.2, `tokenizers` 0.22.2) and
the new pins were run side by side on CPU against the same checkpoint:

- All 419 loaded tensors hash identically, so nothing is silently re-initialized.
- 69 scored requests (docs example, setup smoke check, marker characters,
  non-ASCII text, multi-question heads, the provider test fixture, 43 persona
  requests from `examples/game-naming`, and the six full-context blind-review
  requests) covering 122 questions and 353 labels returned bit-identical logits
  and sigmoid scores. Maximum drift: 0.0. No label ranking or chosen option
  changed, and `inputTokens` matched on every request.
- 50 over-limit requests (including the 48 full-context `audience` requests in
  that example) are rejected with `input_too_large` and the same token counts
  as before. The 512-token window is unchanged, so that example's `audience`
  stage still does not fit.
- Worker stdout stays JSON-only, stderr carries only the loading event, and no
  `trust_remote_code` call or network access happens during load or inference.
  Upstream's own `_load_encoder` still passes `trust_remote_code=True` under
  `gliner2` 2.1.0, so the bypass in `scripts/gliner_runtime.py` is still needed
  and still works unchanged.

Re-measure with the same side-by-side run whenever any pin above changes.

## Model scores

The official GLiNER `Classifier.score` returns every label's native logit. The
Python bridge exposes those logits plus their independent sigmoid activations.
These scores need not sum to one and are not TypeSafe-calibrated probabilities.
The Node adapter owns typed question conversion and any documented normalization.
No selected-label one-hot distribution, confidence, or usage measurement is
fabricated. Structural marker characters in question text/label descriptions
are rendered as fullwidth characters to keep GLiNER schema parsing unambiguous.

## Worker protocol

`scripts/gliner_runtime.py` runs once per provider session, loads the model once,
and reads UTF-8 JSON lines on stdin. Stdout contains JSON lines only; stderr
contains loading progress. EOF or an explicit shutdown closes the process.

Ready response:

```json
{"type":"ready","protocol":1,"model":"fastino/GLiNER2.5-Decide","revision":"5a7adf72a23b4d311abae6ce050d7f0012bb3416","device":"cpu","maxInputTokens":512}
```

Request:

```json
{"id":"1","action":"evaluate","text":"I love this product.","heads":{"sentiment":{"prompt":"Classify review sentiment.","labels":{"positive":"Favorable review","negative":"Unfavorable review"}}}}
```

Evaluation replies include matching `id`, `model`, `revision`, `scores`,
`logits`, `scoreSemantics: "independent_sigmoid"`, and actual combined
`inputTokens`. Both score maps contain every requested head and label ID.
Errors have `{ "id": ..., "error": { "code": ..., "message": ... } }`.
`{"id":"end","action":"shutdown"}` receives
`{"id":"end","type":"shutdown"}` before normal exit.

The bridge rejects overlong inputs explicitly: 1 MiB per JSON line, 65,536 text
characters, 32 heads, 64 labels per head, and the checkpoint's 512 combined
text/schema subword tokens. It never silently truncates state or questions.
Shorten state or split questions when `input_too_large` is returned.

Run protocol boundary checks without downloading a model:

```sh
python3.11 -m unittest discover -s test -p '*_test.py'
```
