# Game-name study demo

Inputs used to record the two-phase naming demo (2026-10-10).

- `name-picks-for-jev.json`: the 14 candidate names with one-line descriptions, as supplied by Giulio.
- `gamer-cohort-prompt.txt`: the cohort prompt used to generate 1,000 synthetic gamers (Claude Code drafting, batches of 25, six at a time).
- `study-request.txt`: the request typed into **Draft with assistant**, sent with the names file attached.

The study: 1,000 gamers pick the name that most makes them want to find out more; 8 synthetic board members read every gamer vote in batches (map-reduce) and pick the name to ship; one synthesis chair reads the 8 board votes and gives one weighted ranking. All personas are synthetic and results are model judgments, not observed people.

The recorded MP4 is kept out of git (`demos/*.mp4`).
