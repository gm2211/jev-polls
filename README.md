# Jev Polls

A companion CLI for an existing research or coding agent. Build reusable synthetic audiences, ask Jev structured questions in parallel, route results through arbitrary branching panels, and inspect the outcome in a standalone HTML report.

The host agent handles research and cohort preparation. Jev Polls handles validated artifacts, execution, caching, aggregation and reporting. No additional generative-model subscription or integration is required; live inference uses your TypeSafe account.

## Quick start

Node.js 22 or newer is required.

```sh
npm install
npm run build
npm start
```

Open the local workspace URL printed by `npm start`. Create cohorts with source notes, weighted segments and synthetic adult profiles. Create a study, write questions, and connect poll, aggregate and decision stages in the visual pipeline editor. Drafts are saved locally and can be reused or exported as JSON.

Connect your TypeSafe account from the workspace when needed. The password field verifies the key with one small request and saves it in macOS Keychain. Connecting never runs a study. Review the stage plan and request budget, then choose **Run study** to start live inference. Completed and failed runs remain in **Runs**, with standalone reports.

The workspace serves only on your own computer. Keys never enter reports, project files, command arguments, or chat. Subsequent studies reuse the saved connection. Normal runs use TypeSafe with no mock fallback. The initial workspace is empty; example names and profiles are imported only when you choose them.

Keep the `npm start` terminal running while using the workspace. If the server stops, restart it and reload the page. Drafts and reports persist in `.jev-polls/workspace`; an expired local page does not mean your TypeSafe key is invalid. TypeSafe console sign-in can happen in your usual browser; enter the resulting API key in the local workspace.

To put `jev-polls` on your PATH for local use, run `npm link`. Every example also works as `node dist/cli.js ...` after building.

```sh
node dist/cli.js init my-study
node dist/cli.js validate my-study/pipeline.json
node dist/cli.js plan my-study/pipeline.json
node dist/cli.js connect my-study/pipeline.json
node dist/cli.js auth check
node dist/cli.js run my-study/pipeline.json --out .jev-polls/my-study
```

`workspace` opens the browser editor. `connect <pipeline>` imports an existing CLI project into that workspace for editing, without running it. Connecting through the browser or using the `auth set` hidden terminal prompt verifies the key before saving it in macOS Keychain. `auth check` verifies a saved connection with one live request. An existing secret manager can instead inject `TYPESAFE_API_KEY` into the process environment or pipe the key to `auth set --stdin`. Keys never belong in command arguments or project files.

Each normal run gets a new output directory. An explicit `--out` refuses to replace existing run artifacts unless `--overwrite` is supplied.

## What is included

- Browser workspace with reusable cohort forms, typed question editors, a connected stage graph, branch conditions, saved drafts, explicit run review and run history.
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

`npm run demo` is a developer-only offline fixture. It writes explicitly labeled mock outputs to `.jev-polls/demo/report.html`, replacing previous demo artifacts. It does not test your TypeSafe connection. Use `npm start` to prepare and explicitly start a live study.

Tests exercise weighted math, DAG execution, branches, failures, cache behavior, limits, provider validation, credential handling, CLI contracts and report escaping. Live TypeSafe verification requires a configured key; offline tests never need one.

See [implementation contracts](CONTRACT.md) for module responsibilities and [TypeSafe documentation](https://docs.typesafe.ai/llms.txt) for current API behavior.
