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
revision `5a7adf72a23b4d311abae6ce050d7f0012bb3416`. Library: `gliner2==2.0.0`.
The pinned checkpoint uses the span architecture with DeBERTa-v3-large. Its
encoder is constructed with Transformers' built-in `DebertaV2Model`; the
upstream generic loader that enables `trust_remote_code` is bypassed. Setup
downloads data/configuration/safetensors only; inference never loads Hub code.

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
