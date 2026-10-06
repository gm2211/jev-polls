# Using Jev Polls as a companion agent

Your existing coding or research agent does the preparation and interpretation. Study execution calls only TypeSafe. The optional local UI assistant uses an explicitly selected ChatGPT subscription connection or an already-authenticated Codex or Claude CLI to propose drafts; it does not execute studies, scrape websites, or invent source evidence. Normal CLI commands emit JSON to stdout; `mcp` reserves stdout for MCP JSON-RPC. Progress and MCP startup errors go to stderr. Failures exit nonzero with a JSON error or a saved failed run.

`workspace` (also available as `connect`) is a long-running local server: stdout contains its workspace URL, while progress and run results are JSON lines on stderr. Its browser editor supports saved cohort and pipeline drafts, stage connections and branch conditions, explicit review, and run history. Opening the page or connecting an account never starts a study.

When handing this page to the user, keep its server alive beyond the current agent turn. Use a persistent terminal or an OS-managed user process, and verify `/status` responds after the launching command exits. A browser tab can remain visible after its server stops; that is a local availability failure, not evidence that the user's API key is invalid. After restarting the server, reload the page before entering a key so it receives the new session token.

## Start from the decision

1. Turn the user's goal into a neutral question and a bounded answer set. Separate factual context supplied by the user from assumptions. Name the intended audience and the decision that the result will inform.
2. Define the population and recruitment criteria before showing candidate answers to the cohort-building step. Choose relevant experiences, needs, and behaviors for this research question rather than importing assumptions from another study. All profiles must be adults.
3. Research relevant audience dimensions using primary studies, transparent datasets, customer research, and documented subject facts. Save source URLs, retrieval dates, what each source supports, and its limitations. A product page is evidence about that product; it is not evidence about audience demographics or population weights.
4. Create or reuse a cohort. Source-backed traits and synthetic details must remain distinguishable. Keep profiles question-independent; do not insert an answer preference, advocacy position, candidate-specific sentiment, or a conclusion merely to influence a result. When preexisting views are relevant, record the evidence and define how they were sampled. Avoid cloning real private individuals.
5. Use researched population weights only when the source supports this population and measurement. Otherwise mark weights `assumed` or `user`, describe assumptions, and inspect segment results. Preserve correlations in observed data when available; do not independently combine traits into implausible biographies. Record gaps rather than filling them with fabricated facts.
6. Draft a pipeline. Use Choice for candidate selection, Score for described degrees, Noul for yes/no. Every question contains complete meaning: question IDs are not sent as instructions. Add a no-match option when the candidate set is incomplete. A closed preference comparison may intentionally require one candidate, but say so.
7. Validate and plan before inference. Open `jev-polls workspace`, or import an existing project with `jev-polls connect <pipeline>`. The local page checks a new key with one real request and saves it in Keychain. Finish editing cohorts and stages, save, review the request budget, then explicitly choose Run study. For an existing key, `jev-polls auth check` verifies live access. Developer mock passes can inspect branching, but never satisfy a request for a working study.
8. Run live inference and inspect the saved results. A failed respondent invalidates its stage instead of silently narrowing the audience. Retry with a new output directory to reuse validated cached evaluations. Existing run artifacts are protected; `--overwrite` explicitly replaces them. Use `--refresh` to request new evaluations; change seed to vary selection and option presentation.
9. Interpret weighted distributions, segment differences, repeated runs and model certainty separately. A reviewer panel contributes another synthetic judgment. Show its disagreement with the audience instead of presenting it as verified expert consensus.
10. Export the standalone report. Distinguish a recommendation from a prediction of human behavior. Test useful conclusions against held-out human observations when available.

## Commands

```sh
jev-polls workspace
jev-polls init study
jev-polls workspace --directory study
jev-polls schema cohort
jev-polls schema pipeline
jev-polls validate study/pipeline.json
jev-polls plan study/pipeline.json
jev-polls connect study/pipeline.json
jev-polls auth check
jev-polls run study/pipeline.json --out .jev-polls/live --seed 17 --concurrency 8
jev-polls run study/pipeline.json --size audience=12 --repeats 3 --out .jev-polls/replicate
jev-polls compare .jev-polls/live/run.json .jev-polls/replicate/run.json --stage audience --question favorite
jev-polls simulate .jev-polls/live/run.json --stage audience --question favorite --draws 1000
jev-polls report .jev-polls/live/run.json --out .jev-polls/report.html
jev-polls cohort import study/players.json
jev-polls cohort list
jev-polls cohort sample study/players.json --size 12 --seed 17 --out study/players-small.json
```

When using a checkout without installing the CLI, replace `jev-polls` with `npm run dev --` or `node dist/cli.js` after `npm run build`.

`init study` creates an empty browser workspace, not a CLI pipeline. The `validate`, `plan`, `connect <pipeline>`, and `run` commands above expect a pipeline JSON prepared separately by your agent. The naming example is opt-in only: `jev-polls init naming-example --example game-naming`. Never substitute it for the user's actual research question.

## Browser workspace

`jev-polls workspace --port 4180` opens an empty workspace by default. Use Cohorts to maintain sources, weighted segments and adult synthetic profiles; use Pipelines to define context, questions and an acyclic phase graph. Named input bindings select which earlier outputs a phase receives. Save unfinished drafts freely; Review checks full runnable contracts and shows an upper bound on profile evaluations. Only the Run study action starts study inference. Key verification is a separate small request.

Workspace drafts are stored in `.jev-polls/workspace/workspace.json` with a revision number. Multiple tabs use optimistic conflict detection; reload a stale tab instead of overwriting newer work. Workspace JSON references saved cohort IDs, whereas CLI pipeline JSON references relative cohort file paths. Use `connect <pipeline>` to import a CLI project. Browser export/import transfers the whole workspace document; import replaces the draft only after confirmation. Run records capture the exact cohort and pipeline snapshots used at execution.

The browser lists past `.jev-polls/runs` reports alongside workspace runs. Failed or interrupted runs remain visible. Editing a cohort never changes historical results. Saved review tokens expire and become invalid after any saved edit; review again before running a changed study.

## Drafting from the local UI

In Cohorts, start with a short audience prompt and a count of up to 20,000 personas per cohort (the workspace storage limit). The selected provider generates the cohort in batches with progress and cancellation, including segments, weights, assumptions and synthetic-field labels. Expand persona cards to inspect details, then choose **Review and edit cohort** to adopt it into the browser draft. Edit or remove personas and save explicitly. The cohort retains its optional `generationPrompt` for future regeneration. Regeneration replaces only the selected cohort and preserves its saved sources, assumptions, segment weights and weight provenance. Validation rejects metadata changes or a different persona count. Manual creation and editing remain available.

Regenerating a single persona drafts that whole selected profile. Its ID, segment and within-segment weight stay fixed; its label, age, background, attributes and synthetic-field labels can change. Only existing cohort source IDs are allowed. The provider receives cohort metadata, the selected persona and up to four short neighboring examples, so a large cohort does not require sending every profile. The backend constructs the replacement and preserves every other persona, cohort and pipeline. Review the proposal before adopting it, and save explicitly. A newer saved revision invalidates a pending proposal.

Optional `distributionTargets` on a saved cohort guide full-cohort regeneration. Each target has a `field` (`age`, `segment` or an `attributes.` dot path), `kind` (`numeric` or `categorical`), and nonoverlapping `buckets` totaling 100 percent. A bucket has a `label` and `percent`; categorical buckets specify an exact primitive `value`, while numeric buckets specify both `min` and `max`, with inclusive minimum and exclusive maximum. These are unweighted synthetic persona-count targets, separate from study weights and sourced population claims. Code allocates exact whole-person quotas with largest remainder rounding, assigns every slot before generation, and verifies those assignments across batches. A mismatched output fails without a partial proposal or a silent approximation. Marginal targets do not supply observed correlations; inspect the resulting biographies for plausibility and keep assumptions explicit.

For ChatGPT drafting, choose ChatGPT subscription, select Continue with ChatGPT, approve access in the browser, and choose one of the account’s available models. If a newly available model is missing from the catalog, select **Enter model ID…** and supply its exact ID. The provider checks access when generation starts. This direct local connection does not require Codex. Account and model selection are separate from the TypeSafe connection used by Run study. Plus/Pro eligibility and app-specific allowance are controlled by ChatGPT; inspect ChatGPT Settings → Usage when a limit is reached. No automatic switch to API billing occurs. Reconnect to renew consent; disconnect removes this app’s connection, not your Codex login. If remote revocation fails, the interface tells you to review connected apps in ChatGPT.

The local runtime stores ChatGPT credentials in macOS Keychain under a separate namespace. Tokens never enter browser storage, workspace JSON, cohort exports, or assistant prompts. Shared OAuth, account binding, refresh, and Responses transport come from the SHA-pinned BYOS package; update the BYOS source and sync it rather than editing vendored files.

For an explicit CLI fallback, choose Codex or Claude Code. The local assistant invokes installed Codex or Claude CLIs using their existing login. The relevant saved draft context and user brief go to the selected provider. CLI prompts travel through stdin; the ChatGPT adapter sends them directly from the local runtime. Drafting runs in an isolated temporary directory, with tool access disabled or constrained, and does not receive TypeSafe credentials. Its structured output is validated as a workspace proposal, then shown for explicit application. Only the original saved revision can accept that proposal. Cancellation, failures, or invalid JSON leave the saved workspace unchanged. No TypeSafe study runs from this flow.

### Inspecting and shaping a cohort

Open a cohort, then choose **Personas**, **Distributions & targets**, **Weights**, **Sources**, or **Cohort brief**. Persona cards open a complete individual view with background, all structured attributes, source notes, synthetic-field labels, and a relative within-segment weight. Changing a weight updates the displayed effective population share; save separately to persist it. Group the paginated persona list by any available attribute, or select a histogram bar to inspect that group.

Distribution charts discover numeric and categorical attributes, including nested fields. Age uses whole-year histogram ranges. Arrays are treated as complete category combinations. Missing values are shown explicitly; ethnicity and other traits are never inferred from a name or biography. Switch between raw persona counts and effective shares computed from segment and persona weights. Missing positive-weight segments are disclosed rather than normalized away.

Set targets from a histogram or add a dimension that has not yet been generated. Numeric bounds are inclusive at the start and exclusive at the end; categorical targets use explicit values. Percentages must total 100. Targets govern persona counts, while population weights remain separate. Save targets, then select **Regenerate cohort with targets** to review a new proposal. Exact counts use deterministic rounding when percentages cannot divide the cohort size evenly. Separate marginal targets do not establish real-world correlations or empirical population estimates.

From an individual view, choose **Regenerate this persona**. Optional instructions describe the replacement, and the selected connected provider drafts it. The review shows current and proposed profiles, ages, source references and synthetic fields. **Use replacement persona** changes only that individual in the browser draft; save explicitly to keep it. ID, segment and weight remain stable. Other personas and historical runs remain unchanged.

The drafting assistant has no research tools. Treat new personas, weights, and traits as synthetic assumptions unless supported by sources already supplied in the brief or workspace. Research sources through the existing agent/MCP flow when needed.

## Connecting an existing agent

Open Advanced MCP settings in the workspace's Assistant tab or run `jev-polls mcp-config --workspace-url http://127.0.0.1:4180/` for client settings. The workspace URL must point to the running loopback server. MCP uses that server's validation, persistence, and execution controls; it does not open a second workspace. No API key belongs in MCP settings. The browser owns the saved TypeSafe connection.

1. Call `get_guide`, `get_schema`, and `get_workspace` to read current contracts and the saved revision. Workspace pipeline aliases refer to cohort IDs, not filesystem paths.
2. Use your host agent's research capabilities to prepare sourced, question-independent adult profiles. Preserve evidence gaps, synthetic fields, assumptions, and weight provenance.
3. Save each cohort or pipeline with `save_cohort` or `save_pipeline` and `expectedRevision`. Re-read after each save. On a revision conflict, inspect the newer draft and reconcile changes instead of blindly overwriting them. Other cohorts and pipelines remain intact.
4. Call `review_study` after edits are saved. Inspect the cohort sizes, branch graph, warnings, and request bound. Saving, connecting, and review make no study inference calls.
5. Call `run_study` only within the user's authorization to send these profiles and questions to TypeSafe and spend the reviewed request budget. Supply the reviewed revision and token. Poll `get_run`; inspect `get_run_record` for actual results and failed/skipped stages. Never claim success from a completed transport request alone.

The browser applies external changes when its local draft is clean. A dirty browser draft is preserved with a conflict notice until the user chooses how to reconcile it. Agent connection exposes tools. The local drafting assistant can invoke the installed CLIs from the UI; this does not add shell/custom-agent execution stages to the study graph.

## Portable artifacts

- **Cohort:** version, identity, target population, sources, segments, personas, assumptions. A persona contains a relevant background, structured attributes, source references, explicitly synthetic fields and a within-segment weight. Each segment has a weight and its provenance. Age is at least 18.
- **Pipeline:** shared context, relative paths to cohort files, and stage graph. Each poll can override context, sample size and repeats. Polls on different cohorts can run concurrently. Profiles are sampled without replacement; asking for more people requires additional researched profiles.
- **Run:** complete pipeline and cohort snapshots, raw distributions, resolved model identifiers per vote, segment and repeat summaries, stage statuses, usage and warnings. This is sufficient to re-render the report without credentials or the original files.
- **Cache:** content-addressed successful model evaluations. Requests contain no credentials. Cache is provider-separated and includes model, effective state, question definitions, seed and repetition. Reusing an answer is not a new observation.

Importing a cohort saves an immutable content-addressed revision. Reuse it across studies by pointing the pipeline at that revision. Update evidence by creating another cohort file and importing it again. Both revisions remain available. Cohort sources can be reused by the agent; the CLI does not download, refresh, or validate their factual claims automatically.

## Stages and branching

`poll` evaluates one profile at a time with all that stage's questions batched. Other profiles are not placed in the same request. Its state contains the current persona, shared context, stage context and completed direct dependencies' summaries. Unexposed panels have no dependencies.

`aggregate` combines compatible question summaries with explicit stage weights. It supports Choice, Score and Noul; options or score levels must match. This composes judgments; it does not manufacture additional independent respondents.

`decision` chooses the highest-probability option from a Choice summary while retaining that distribution and its uncertainty. It does not convert the distribution to 100% certainty.

Every reference in an aggregate, decision or condition must be declared in `dependsOn`. Cycles and unknown references are rejected. This version supports arbitrary acyclic stage graphs. Feedback rounds are explicit new stages, which keeps execution, costs and evidence auditable.

Conditions use `all`, `any`, `not`, or a leaf with `stage`, `question`, `metric`, `op`, `value`. Choice metrics: `winner`, `margin`, `topProbability`. Score/Noul metric: `mean`. Numeric operators: `gt`, `gte`, `lt`, `lte`, `eq`, `ne`; winner permits `eq` or `ne`.

Example: run another panel when a modeled preference margin is narrow:

```json
{"stage":"audience","question":"favorite","metric":"margin","op":"lt","value":0.15}
```

Default `join: "all"` runs only after every dependency completes successfully. `join: "any"` waits for all dependencies to finish or skip, then runs if at least one completed. This lets mutually exclusive branches rejoin. Skipped branches are visible in the report. Any failed stage makes the overall run failed, even if an independent branch completes.

Conditions require available results. Missing evidence remains unknown, including under `not`; only a true condition starts a stage. Entry stages have no dependency requirement. The request budget counts new profile evaluations; SDK transport retries can make additional HTTP attempts. Use a pinned model version to make comparisons reproducible.

## Explicit phase inputs and outputs

A poll phase exposes each question ID as a named output. New visual phases start with one question, although imported multiquestion phases remain valid. Optional `inputs` maps input names to `{stage, question, select}`. `select` defaults to `summary`; `winner` accepts Choice, `mean` accepts Score/Noul, `probabilities` accepts Choice/Score, and `responses` accepts every type. Responses include only the selected question answer with its persona and weighting metadata.

The engine places these values under `state.inputs`, so instructions can reference `inputs.prior_preference`. Explicit inputs replace automatic upstream summaries: unrelated outputs are not copied. An empty input map means no upstream data; absent `inputs` preserves the legacy `state.upstream` array for compatibility. Each source must be a declared direct dependency. For optional branches that did not produce an available result, the named input is `null`; write downstream questions to handle that absence explicitly.

## Interpreting numbers

For each option, the audience distribution is the weighted mean of profile probabilities. Within each segment, persona weights normalize to that segment's chosen share. Repeats divide each profile's weight instead of increasing the sample size. More profiles or repeated calls cannot establish accuracy against humans on their own.

`simulate` samples virtual ballots conditional on saved distributions. Its intervals and winner frequencies describe that simulation only. They are not human-population confidence intervals. `compare` preserves run-level variation, reports equal-run averages and spread, and rejects incompatible provider/model/question contracts. Different sample sizes and repeat counts are allowed. Cohort and weight changes are disclosed because reweighting changes the modeled target population.

Simulation intervals are the 2.5th and 97.5th percentiles of virtual election results. Winner frequency counts outright wins; ties have their own count and rate. Comparison spread is the standard deviation across the supplied run summaries, using equal run weights. Neither measure estimates uncertainty in a real human population.

TypeSafe Choice/Score confidence describes how concentrated one model answer is. It does not prove that a modeled person's preference is correct, or that a cohort represents a population. See [TypeSafe confidence](https://docs.typesafe.ai/confidence). Preserve disagreement and make assumptions inspectable.

## Credentials

On macOS, `jev-polls auth set` reads a hidden prompt and stores the key in Keychain. For an existing secret manager, pipe its output into `jev-polls auth set --stdin`, or inject `TYPESAFE_API_KEY` into the process environment in memory. Never pass an API key as a command argument, paste it into a pipeline, or commit it. Reports and caches contain no credentials.

`jev-polls connect [pipeline]` opens the workspace, optionally importing a pipeline and its cohorts for editing. Its password field verifies Choice, Score, and Noul together in one small live request before saving a new key. It never runs the imported study automatically. Keep the command running while using the page; Ctrl-C stops the local server. Account sign-in or key entry must be completed by the user when no saved credential exists. Do not present an offline mock report as completion of account setup.

## Boundaries

No human outreach, purchases, publishing, or deployment happens through this CLI. Reports are local standalone files with inline CSS/JavaScript and no network dependencies. A chat application that permits HTML previews can display them; applications that disallow scripts may require opening the file in a browser.
