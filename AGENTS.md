# Project instructions

## Standing merge approval

The user authorizes agents to merge PRs for `gm2211/jev-polls` without asking again.
Complete implementation, review, required checks, and browser acceptance when
applicable; resolve failures and conflicts, push scoped changes, and merge the PR.
Verify the result on `origin/main` and leave the local checkout clean and current.
Do not stop at an open PR or wait for another user prompt. Preserve unrelated work.

Use the `typesafe-ai` skill when working on this project. Read
`.agents/skills/typesafe-ai/SKILL.md` and follow its guidance for relevant work.

Before designing or implementing TypeSafe integrations, consult the live
documentation index at https://docs.typesafe.ai/llms.txt and read the relevant
API or SDK reference, question guidance, and cookbook.

Jev Polls is an agent-driven research companion CLI. Read `docs/agent-guide.md`
before preparing cohorts or studies. Preserve sourced facts versus synthetic
assumptions, profile-independent question preparation, and explicit weighting.
Never present mock distributions or synthetic profiles as observed human data.

Run `npm run verify` and `npm run demo` after changes. For report changes, inspect
the rendered report in Codex's built-in browser on desktop and narrow viewports.
Keep machine output as JSON on stdout and progress as JSON lines on stderr.

## Workspace interaction

Prefer focused tabs and pagination over long pages or stacked editors. Keep
navigation, save actions, and page controls easy to reach. Preserve unsaved fields
when switching sections or pages; retain natural overflow for zoom, narrow
screens, and unusually long content rather than clipping controls.
