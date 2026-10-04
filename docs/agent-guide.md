# Using Jev Polls as a companion agent

Your existing coding or research agent does the preparation and interpretation. The CLI calls only TypeSafe for live inference. It does not call another generative model, scrape websites, or invent sources. Every command except help/version emits JSON to stdout; run progress is JSON lines on stderr. Failures exit nonzero with a JSON error or a saved failed run.

## Start from the decision

1. Turn the user's goal into a neutral question and a bounded answer set. Separate factual context supplied by the user from assumptions. Name the intended audience and the decision that the result will inform.
2. Define the population and recruitment criteria before showing candidate answers to the cohort-building step. For game naming, prefer gaming motivations, genres, platform and purchasing behavior over unrelated personal characteristics. All profiles must be adults.
3. Research relevant audience dimensions using primary studies, transparent datasets, customer research, and documented game facts. Save source URLs, retrieval dates, what each source supports, and its limitations. A game feature page is evidence about the game; it is not evidence about audience demographics or population weights.
4. Create or reuse a cohort. Source-backed traits and synthetic details must remain distinguishable. Keep profiles question-independent; do not insert an answer preference, advocacy position, candidate-specific sentiment, or a conclusion merely to influence a result. When preexisting views are relevant, record the evidence and define how they were sampled. Avoid cloning real private individuals.
5. Use researched population weights only when the source supports this population and measurement. Otherwise mark weights `assumed` or `user`, describe assumptions, and inspect segment results. Preserve correlations in observed data when available; do not independently combine traits into implausible biographies. Record gaps rather than filling them with fabricated facts.
6. Draft a pipeline. Use Choice for candidate selection, Score for described degrees, Noul for yes/no. Every question contains complete meaning: question IDs are not sent as instructions. Add a no-match option when the candidate set is incomplete. A closed preference comparison may intentionally require one candidate, but say so.
7. Validate and plan before inference. Run a mock pass to inspect branching and output contracts. Mock scores are deterministic test data, not Jev judgments.
8. Run live inference when credentials are configured. Inspect failures; a failed respondent invalidates its stage instead of silently narrowing the audience. Retry with a new output directory to reuse validated cached evaluations. Existing run artifacts are protected; `--overwrite` explicitly replaces them. Use `--refresh` to request new evaluations; change seed to vary selection and option presentation.
9. Interpret weighted distributions, segment differences, repeated runs and model certainty separately. A reviewer panel contributes another synthetic judgment. Show its disagreement with the audience instead of presenting it as verified expert consensus.
10. Export the standalone report. Distinguish a recommendation from a prediction of human behavior. Test useful conclusions against held-out human observations when available.

## Commands

```sh
jev-polls init study
jev-polls schema cohort
jev-polls schema pipeline
jev-polls validate study/pipeline.json
jev-polls plan study/pipeline.json
jev-polls run study/pipeline.json --provider mock --out .jev-polls/demo
jev-polls auth status
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

## Interpreting numbers

For each option, the audience distribution is the weighted mean of profile probabilities. Within each segment, persona weights normalize to that segment's chosen share. Repeats divide each profile's weight instead of increasing the sample size. More profiles or repeated calls cannot establish accuracy against humans on their own.

`simulate` samples virtual ballots conditional on saved distributions. Its intervals and winner frequencies describe that simulation only. They are not human-population confidence intervals. `compare` preserves run-level variation, reports equal-run averages and spread, and rejects incompatible provider/model/question contracts. Different sample sizes and repeat counts are allowed. Cohort and weight changes are disclosed because reweighting changes the modeled target population.

Simulation intervals are the 2.5th and 97.5th percentiles of virtual election results. Winner frequency counts outright wins; ties have their own count and rate. Comparison spread is the standard deviation across the supplied run summaries, using equal run weights. Neither measure estimates uncertainty in a real human population.

TypeSafe Choice/Score confidence describes how concentrated one model answer is. It does not prove that a modeled person's preference is correct, or that a cohort represents a population. See [TypeSafe confidence](https://docs.typesafe.ai/confidence). Preserve disagreement and make assumptions inspectable.

## Credentials

On macOS, `jev-polls auth set` reads a hidden prompt and stores the key in Keychain. For an existing secret manager, pipe its output into `jev-polls auth set --stdin`, or inject `TYPESAFE_API_KEY` into the process environment in memory. Never pass an API key as a command argument, paste it into a pipeline, or commit it. Reports and caches contain no credentials.

## Boundaries

No human outreach, purchases, publishing, or deployment happens through this CLI. Reports are local standalone files with inline CSS/JavaScript and no network dependencies. A chat application that permits HTML previews can display them; applications that disallow scripts may require opening the file in a browser.
