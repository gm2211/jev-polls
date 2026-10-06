# Jev Polls

A local visual workspace for virtual research cohorts and studies. Configure synthetic personas, give each phase a cohort and a question, connect named outputs to later phases, and inspect modeled results. A companion CLI and MCP tools support existing research agents.

Use forms directly or ask an installed, authenticated Codex or Claude CLI to draft changes from the UI. No separate model API key is required for drafting; the selected CLI uses its existing account. TypeSafe performs live profile evaluations. Source research can still happen in your existing agent; the local drafting assistant uses the supplied brief and saved workspace.

## Quick start

Node.js 22 or newer is required.

```sh
npm install
npm run build
npm start
```

Open the local workspace URL printed by `npm start`. Choose a drafting provider and model once from the **AI** pill in the header: your ChatGPT subscription or an installed Codex or Claude CLI. In **Cohorts**, describe the audience in a short prompt, choose a persona count, then choose **Generate cohort**. Current edits save automatically before generation; a separate Save click is not required. Review the generated personas, choose **Review and edit cohort**, adjust any details, and save. The brief stays with the cohort for later regeneration; manual creation remains available. In **Studies**, choose **Create study**, give each phase a question and cohort, and use **Add next phase** for a linear flow. Named input connections also support branches and joins. Drafts are saved locally and can be reused or exported as JSON.

Connect your TypeSafe account from the workspace when needed. The password field verifies the key with one small request and saves it in macOS Keychain. Connecting never runs a study. Review the stage plan and request budget, then choose **Run study** to start live inference. Completed and failed runs remain in **Runs**, with standalone reports.

The workspace serves only on your own computer. Keys never enter reports, project files, command arguments, or chat. Subsequent studies reuse the saved connection. Normal runs use TypeSafe with no mock fallback. The initial workspace is empty; example names and profiles are imported only when you choose them.

Keep the `npm start` terminal running while using the workspace. If the server stops, restart it and reload the page. Drafts and reports persist in `.jev-polls/workspace`; an expired local page does not mean your TypeSafe key is invalid. TypeSafe console sign-in can happen in your usual browser; enter the resulting API key in the local workspace.

To put `jev-polls` on your PATH for local use, run `npm link`. Every example also works as `node dist/cli.js ...` after building.

```sh
node dist/cli.js init my-study
node dist/cli.js workspace --directory my-study
```

`init` creates an empty workspace. Define your own research question, cohorts, options, and stages in the browser; no naming study is selected for you. To inspect the optional CLI example, explicitly run `node dist/cli.js init naming-example --example game-naming`, then `node dist/cli.js connect naming-example/pipeline.json`.

`workspace` opens the browser editor. `connect <pipeline>` imports an existing CLI project into that workspace for editing, without running it. Connecting through the browser or using the `auth set` hidden terminal prompt verifies the key before saving it in macOS Keychain. `auth check` verifies a saved connection with one live request. An existing secret manager can instead inject `TYPESAFE_API_KEY` into the process environment or pipe the key to `auth set --stdin`. Keys never belong in command arguments or project files.

Each normal run gets a new output directory. An explicit `--out` refuses to replace existing run artifacts unless `--overwrite` is supplied.

## What is included

- Prompt-first cohort generation, persona review and editing, segment composition, typed phase editors, explicit input/output connections, saved drafts, run review and history.
- Local CLI drafting with installed Codex or Claude, cancellation, validated proposals, and revision-safe explicit application.
- MCP tools for existing agents to read and update the same workspace, prepare cohorts and pipelines, review request budgets, start authorized runs, and inspect saved results.
- Portable, validated cohort JSON with source references, synthetic-field labels, adult profiles, explicit segment weights and assumptions.
- Reusable cohort revisions, deterministic sampling without replacement, configurable cohort size and repeated evaluations.
- Arbitrary acyclic pipelines: parallel panels, compound conditions, split/rejoin paths, weighted aggregation and explicit decisions.
- Choice, Score and Noul questions through the official TypeSafe SDK. All questions for a profile are batched; unrelated profiles remain isolated.
- A global concurrency limit, request budget, provider retries/timeouts, exact-response cache and resumable runs. Failed respondents make the stage fail rather than silently shrinking its audience.
- Weighted probability distributions, segment and repeat breakdowns, run comparisons, and seeded conditional ballot simulation.
- Standalone interactive HTML with a stage map, visible skipped/failed branches, distributions, profile drilldown, source provenance, assumptions and raw JSON export. No server, CDN or external fonts required.
- JSON stdout, progress JSON lines on stderr, nonzero failure exits, JSON Schema, an agent guide, and a programmatic TypeScript API.

## Phase data flow

New phases ask one question across the selected cohort. Each question ID names an output. A downstream phase can map an output to a named input, selecting its full summary, winning option (Choice), mean (Score/Noul), probability distribution (Choice/Score), or individual weighted responses. For example, map `screening.preference` to `prior_preference`, then refer to `inputs.prior_preference` in the next question. No text generation is implied: Jev outputs typed judgments and probabilities.

Every input source is an explicit graph dependency; cycles and incompatible projections fail validation. Optional skipped branches supply `null` for their mapped inputs. Existing multiquestion phases remain supported, and imported pipelines without explicit inputs retain their legacy upstream-summary behavior.

## Agent workflow

The assistant uses your ChatGPT subscription or installed Codex or Claude CLI with its existing login. Manage providers, models, accounts, TypeSafe, and external-agent connections from the shared **AI** pill. Generation validates and saves current edits before starting; failed saves or conflicting revisions leave the draft intact and prevent generation. Cohort generation accepts a brief and up to 20,000 personas per cohort (the workspace storage limit), generates larger cohorts in batches, validates only the selected cohort can change, and opens an editable draft after review. Other cohorts and studies stay intact. The Assistant tab can propose broader workspace changes for explicit application. Generated proposals stay separate until review and adoption. Generation never starts a TypeSafe study. If the saved workspace changes meanwhile, the proposal must be regenerated against the new revision. The assistant cannot browse for evidence: supplied sources and synthetic assumptions remain distinct.

Advanced MCP connection settings also support Codex, Claude Code, or another client. Keep the workspace server running. The adapter uses local stdio and the same revision checks and run controls as the browser; it never asks the agent to copy your TypeSafe key. Start a new agent session after registering the server so its tools are loaded.

Your existing agent supplies research and conversation. It can edit persona backgrounds, attributes, source references, segment weights, questions, and branches through MCP. TypeSafe supplies the live typed judgments for each profile. The workspace can invoke those installed CLIs for drafting; it does not automatically research sources.

```sh
node dist/cli.js mcp-config --workspace-url http://127.0.0.1:4180/
```

Use the returned setup command for your client, or add the returned `mcpConfig` to its MCP settings. The server tools include `get_workspace`, `save_cohort`, `save_pipeline`, `review_study`, `run_study`, and `get_run_record`. Reads, edits, and reviews never perform study inference; `run_study` requires the exact reviewed revision, a fresh plan token, and a request budget. The browser picks up saved agent edits automatically when your local draft is clean; unsaved edits are preserved and a conflict notice offers a reload.

Ask your existing agent to read [the workflow guide](docs/agent-guide.md), then run `jev-polls guide`. The schemas are available through `jev-polls schema pipeline` and `jev-polls schema cohort`.

The optional `game-naming` example illustrates one possible use of the general engine. It is never loaded by default. Its candidate names are placeholders; biographies and weights are explicitly synthetic assumptions, not a representative market sample. The commands below apply to a CLI pipeline prepared by your agent, with stage and question IDs chosen for that study.

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

### ChatGPT subscription drafting

In the cohort generator or Assistant, select **ChatGPT subscription**, click **Continue with ChatGPT**, approve access, and choose an available model. If the catalog omits a model you can access, choose **Enter model ID…** and enter its exact ID (for example, `gpt-6.1-sol`); inference verifies access when you generate. The local BYOS adapter calls Responses directly; no Codex installation is needed for this option. ChatGPT controls eligible plans, models, and per-app usage limits. Account switching and disconnect are available in the same controls. Tokens stay in local Keychain storage and never enter browser storage or workspace exports.

Drafting proposes editable cohorts and studies. Review and save remain explicit; studies still run through TypeSafe with its separate credential and billing. Codex and Claude Code remain explicit alternatives using their existing CLI logins. See [the agent guide](docs/agent-guide.md) for boundaries and reconnection details.

The native adapter is vendored from `gm2211/byos`; `vendor/BYOS_REVISION` records its full commit SHA. On a fresh checkout use Node 22.23.2 or newer, run `npm ci`, then `npm start`. The npm start/dev/check/build/test/demo commands build the adapter from its pinned source automatically.

To update it, fetch the intended BYOS commit in a separate local checkout and run:

```sh
npm run sync:byos -- /path/to/byos FULL_40_CHARACTER_COMMIT_SHA
npm install
npm run verify
npm run demo
```

The sync command runs BYOS’s exporter from that same immutable commit and exports only the native ChatGPT package and required package dependencies. Review and commit the vendor changes, revision record, and lockfile together. Make shared fixes upstream in BYOS; never patch vendored source.
