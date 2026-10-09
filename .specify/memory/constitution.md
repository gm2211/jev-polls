<!--
Sync Impact Report
- Version change: (template) → 1.0.0
- Added principles: I. Evidence Honesty; II. Explicit Inference; III. Local-First Secrets;
  IV. Validated, Revision-Safe State; V. Deterministic, Typed Engine; VI. Focused, Reachable UI;
  VII. Machine-Readable Interfaces
- Added sections: Quality Gates; Governance
- Templates reviewed: plan-template.md (Constitution Check reads this file, no edit needed),
  spec-template.md (no edit needed), tasks-template.md (no edit needed)
- Sources: AGENTS.md, CONTRACT.md, docs/design-direction.md, docs/agent-guide.md
- Follow-up TODOs: none
-->

# Jev Polls Constitution

## Core Principles

### I. Evidence Honesty (NON-NEGOTIABLE)

Jev Polls produces modeled judgments from synthetic profiles. It MUST NOT present mock
distributions, synthetic personas, or simulated ballots as observed human data.

- Sourced facts and synthetic assumptions MUST stay distinguishable in every cohort,
  report, and export. Sources carry URL, retrieval date, what they support, and limits.
- Cohort weights MUST state their basis (`researched`, `assumed`, or `user`).
- Profiles MUST be adults and MUST stay question-independent: no answer preference is
  inserted to steer a result.
- Uncertainty is preserved: decisions declare a selection without manufacturing
  certainty; simulation intervals are labeled conditional on model outputs; repeats are
  never counted as additional people.
- Progress readouts use real counts and observed activity. Never invent progress or
  model reasoning.

### II. Explicit Inference

Paid or live model inference happens only after an explicit, reviewed action.

- Opening the workspace, connecting an account, saving, drafting, searching, and
  navigating MUST NOT start a study.
- A run requires a review of the exact saved revision, its request plan, and a request
  budget. Review tokens are single-use and revision-bound.
- Normal runs use the selected live provider with no silent mock fallback. Mock output is
  developer-only and prominently labeled.
- A failed respondent fails its stage; the audience is never silently narrowed.

### III. Local-First Secrets

The workspace serves only on loopback and keeps the user's credentials local.

- API keys and drafting tokens live in the OS keychain or an injected environment
  variable. They MUST NOT appear in command arguments, project files, reports, exports,
  logs, browser storage, or chat.
- Mutating requests MUST pass Host, Origin, and CSRF checks.
- Drafting agents (ChatGPT subscription, Codex, Claude Code) run with their existing
  logins; prompts go via stdin, work happens in isolated temporary directories, and CLI
  diagnostics are never exposed.

### IV. Validated, Revision-Safe State

Drafts are freely editable; runnable contracts are strictly validated.

- Input JSON uses strict, versioned schemas. Pipelines are acyclic; every input source
  is a declared dependency with a compatible projection.
- Persistence is atomic and revision-controlled. Concurrent edits from the browser, MCP
  agents, or drafting proposals never overwrite each other silently; unsaved browser
  edits are preserved and conflicts are surfaced.
- Generated proposals stay separate until the user reviews and applies them.

### V. Deterministic, Typed Engine

- Sampling, option order, and simulation are reproducible from a seed.
- Provider answers are validated before caching or aggregation. The exact-response cache
  only reuses validated responses.
- Concurrency is globally bounded; the request budget is enforced.
- Outputs are typed judgments and probabilities (Choice, Score, Noul). No text
  generation is implied by a study result.

### VI. Focused, Reachable UI

The workspace is a working research instrument (see `docs/design-direction.md`).

- Prefer focused tabs and pagination over long pages or stacked editors.
- Buttons and editable controls MUST stay outside collapsible disclosures; disclosures
  hold explanatory text only.
- Unsaved fields persist across section and page switches.
- Controls are at least 44px, keyboard reachable, readable in light and dark modes, and
  usable without clipping at 375, 768, 1024, and 1440px and under zoom.

### VII. Machine-Readable Interfaces

- CLI machine output is JSON on stdout; progress is JSON lines on stderr; failures exit
  nonzero with a JSON error or a saved failed run. The `mcp` command reserves stdout for
  JSON-RPC.
- Reports are standalone HTML with no network dependencies and escape all untrusted data.

## Quality Gates

- `npm run verify` and `npm run demo` pass before any merge.
- Report and workspace UI changes are inspected in a browser at desktop and narrow
  viewports.
- TypeSafe integrations follow the live documentation at https://docs.typesafe.ai/llms.txt.
- Vendored BYOS source is never patched locally; fixes go upstream and are synced by
  pinned commit.

## Governance

This constitution supersedes conflicting guidance in feature specs and plans. `AGENTS.md`
holds runtime agent guidance and MUST stay consistent with it. Every spec, plan, and
review checks compliance with the principles above; any deviation is justified in the
plan's Complexity Tracking section. Amendments update this file with a version bump
(MAJOR for removed or redefined principles, MINOR for new principles or sections, PATCH
for wording) and a refreshed Sync Impact Report.

**Version**: 1.0.0 | **Ratified**: 2026-10-09 | **Last Amended**: 2026-10-09
