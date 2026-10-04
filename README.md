# Jev Polls

A companion CLI for an existing research or coding agent. Build reusable synthetic audiences, ask Jev structured questions in parallel, route results through arbitrary branching panels, and inspect the outcome in a standalone HTML report.

The host agent handles research and cohort preparation. Jev Polls handles validated artifacts, execution, caching, aggregation and reporting. No additional generative-model subscription or integration is required; live inference uses your TypeSafe account.

## Quick start

Node.js 22 or newer is required.

```sh
npm install
npm run build
npm run demo
```

Open `.jev-polls/demo/report.html`. Demo mode is completely offline and visibly labeled **mock**. It exercises the real pipeline engine with deterministic fixture distributions, not real Jev results.

Each normal run gets a new output directory. An explicit `--out` refuses to replace existing run artifacts unless `--overwrite` is supplied. `npm run demo` deliberately replaces only its demo artifacts.

To put `jev-polls` on your PATH for local use, run `npm link`. Every example also works as `node dist/cli.js ...` after building.

```sh
node dist/cli.js init my-study
node dist/cli.js validate my-study/pipeline.json
node dist/cli.js plan my-study/pipeline.json
node dist/cli.js auth set
node dist/cli.js run my-study/pipeline.json --out .jev-polls/my-study
```

`auth set` uses a hidden prompt and macOS Keychain. An existing secret manager can instead inject `TYPESAFE_API_KEY` into the process environment or pipe the key to `auth set --stdin`. Keys never belong in command arguments or project files.

## What is included

- Portable, validated cohort JSON with source references, synthetic-field labels, adult profiles, explicit segment weights and assumptions.
- Reusable cohort revisions, deterministic sampling without replacement, configurable cohort size and repeated evaluations.
- Arbitrary acyclic pipelines: parallel panels, compound conditions, split/rejoin paths, weighted aggregation and explicit decisions.
- Choice, Score and Noul questions through the official TypeSafe SDK. All questions for a profile are batched; unrelated profiles remain isolated.
- A global concurrency limit, request budget, provider retries/timeouts, exact-response cache and resumable runs. Failed respondents make the stage fail rather than silently shrinking its audience.
- Weighted probability distributions, segment and repeat breakdowns, run comparisons, and seeded conditional ballot simulation.
- Standalone interactive HTML with a stage map, visible skipped/failed branches, distributions, profile drilldown, source provenance, assumptions and raw JSON export. No server, CDN or external fonts required.
- JSON stdout, progress JSON lines on stderr, nonzero failure exits, JSON Schema, an agent guide, and a programmatic TypeScript API.

## Agent workflow

Ask your existing agent to read [the workflow guide](docs/agent-guide.md), then run `jev-polls guide`. The schemas are available through `jev-polls schema pipeline` and `jev-polls schema cohort`.

The bundled example follows the user's macro-RTS brief: a large industrial economy, substantial armies, underground infrastructure and orbital expansion. Its candidate names are placeholders. Audience dimensions reference primary research and official game descriptions; biographies and weights are explicitly synthetic assumptions. They are a starting hypothesis, not a representative market sample.

```sh
node dist/cli.js run my-study/pipeline.json --size audience=12 --repeats 3 --seed 42 --out .jev-polls/round-2
node dist/cli.js compare .jev-polls/my-study/run.json .jev-polls/round-2/run.json --stage audience --question favorite
node dist/cli.js simulate .jev-polls/my-study/run.json --stage audience --question favorite --draws 1000
node dist/cli.js cohort import my-study/players.json
node dist/cli.js cohort list
```

Audience favorites and reviewer recommendations remain separate stages. Decision stages retain uncertainty. A large number of synthetic profiles is not an equivalent number of independent surveyed humans; repeated simulation measures behavior under saved model outputs. Human data is needed to assess predictive validity.

## Development

```sh
npm run verify
npm run demo
```

Tests exercise weighted math, DAG execution, branches, failures, cache behavior, limits, provider validation, credential handling, CLI contracts and report escaping. Live TypeSafe verification requires a configured key; offline tests never need one.

See [implementation contracts](CONTRACT.md) for module responsibilities and [TypeSafe documentation](https://docs.typesafe.ai/llms.txt) for current API behavior.
