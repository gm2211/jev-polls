# Jev: instrument panel

The approved direction is a working research instrument: clear readouts, aligned records, visible controls, and one focused task surface. Avoid ornamental dashboards and nested rounded cards.

- Use Space Grotesk for headings and numeric readouts; IBM Plex Sans for controls and prose. Licensed font subsets ship locally in `assets/fonts`; no CDN is needed.
- Use a pale chassis in light mode and graphite in dark mode. Orange identifies primary actions and the active channel; green identifies successful progress. Text and field boundaries must remain readable in both modes.
- Separate regions with alignment, rules, and surface contrast. Use small radii and no decorative elevation. Reserve shadows for dialogs.
- Keep the workspace bar compact and visible. Cohort sections form a side selector on wide screens and wrapping tabs on narrow screens.
- Present cohort libraries as records and personas as rows. Show effective cohort share next to each persona. Paginate collections; keep page membership stable when the viewport changes.
- Keep actions visible. Collapsible sections may contain explanatory text, never buttons or editable fields.
- Use real job counts, elapsed time, and observed activity in the generation readout. Estimates must identify uncertainty; never invent progress or model reasoning.
- Preserve form edits across section changes. Allow natural scrolling at narrow widths, enlarged text, and for unusually long content instead of clipping controls.
- Verify keyboard focus, at least 44px control targets, and page overflow at 375, 768, 1024, and 1440px.

The active workspace theme lives in `src/workspace-theme.ts`. Keep changes coherent across cohort, study, connection, and progress views rather than adding another unrelated visual theme.
