import { createArenaModel } from './workspace-arena-model.js';

/**
 * Markup for the live voting map. Everything here is a pure string builder over plain data, so the unit tests
 * and the browser run the same code; the browser glue that keeps the DOM current lives in workspace-arena-controls.
 * Keep the factory self-contained: it is serialized into the inline client script.
 */
export function createLiveVotingView(model: ReturnType<typeof createArenaModel>) {
  type Member = Parameters<typeof model.tileVisual>[0];
  type Question = NonNullable<Parameters<typeof model.tileVisual>[1]>;
  type Board = ReturnType<typeof model.leaderboard>;
  const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const pct = (share: number): string => `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
  const BOARD_ROWS = 10;
  const number = (value: number): string => value.toLocaleString('en-US');

  const statusWord = (member: Member): string => member.status === 'queued' ? 'waiting' : member.status === 'running' ? 'thinking' : member.status === 'failed' ? 'failed' : 'voted';

  /** One sentence that names a tile for screen readers, tooltips and the detail panel. */
  function describeTile(member: Member, question: Question | undefined, segmentLabel: string): string {
    const parts = [member.label, segmentLabel, statusWord(member)];
    if (member.repeat > 1) parts.push(`repeat ${member.repeat}`);
    if (member.status === 'completed') {
      const pick = model.topPick(model.answerFor(member, question), question);
      if (pick) parts.push(question?.type === 'choice' ? `top pick ${pick.label}${pick.probability === null ? '' : ` ${Math.round(pick.probability * 100)}%`}` : pick.label);
    } else if (member.status === 'running' && member.batch) parts.push(`${member.batch.phase === 'map' ? 'reading batches' : 'combining'}, ${Math.min(member.batch.done, member.batch.total)} of ${member.batch.total} steps`);
    else if (member.status === 'failed' && member.reason) parts.push(member.reason);
    return parts.join(', ');
  }

  function tileHtml(member: Member, o: { question?: Question; colorBy: 'status' | 'pick' | 'confidence'; segmentLabel: string; selected: boolean; tabbable: boolean; pop?: boolean }): string {
    const visual = model.tileVisual(member, o.question, o.colorBy);
    let fill = '';
    if (visual.fill === 'option') fill = visual.index < model.PALETTE ? ` data-c="${visual.index}"` : ` data-c="x" style="--c:${model.optionColor(visual.index)}"`;
    else if (visual.fill === 'scale') fill = ` data-c="s" style="--v:${Math.round(visual.value * 1000) / 1000}"`;
    else if (visual.progress !== null) fill = ` style="--p:${Math.round(visual.progress * 1000) / 1000};--n:${member.batch?.total ?? 1}"`;
    const text = esc(describeTile(member, o.question, o.segmentLabel));
    return `<button type="button" class="lv-tile${o.pop ? ' is-pop' : ''}" data-act="live-member" data-key="${esc(model.memberKey(member))}" data-s="${visual.state}" data-i="${esc(model.initials(member.label))}"${fill} tabindex="${o.tabbable ? 0 : -1}" aria-pressed="${o.selected}" aria-label="${text}"></button>`;
  }

  /** Answer rows for the detail panel. Labels come from the study's options when they are known. */
  function answerView(id: string, value: unknown, question: Question | undefined): string {
    const label = (optionId: string): string => question?.options.find(option => option.id === optionId)?.label ?? optionId;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `<div class="lv-answer"><strong>${esc(id)}</strong><span>${esc(JSON.stringify(value))}</span></div>`;
    const answer = value as Record<string, unknown>;
    const bars = (): string => Object.entries((answer.probabilities ?? {}) as Record<string, unknown>).map(([name, raw]) => {
      const probability = Number(raw);
      if (!Number.isFinite(probability)) return '';
      const percent = Math.max(0, Math.min(100, probability * 100));
      return `<div class="lv-prob"><span>${esc(label(name))}</span><span class="lv-prob-bar"><i style="width:${percent}%"></i></span><strong>${percent.toFixed(0)}%</strong></div>`;
    }).join('');
    if (answer.type === 'choice') return `<div class="lv-answer"><strong>${esc(question?.label || id)}</strong><p>Selected: ${esc(label(String(answer.choice ?? 'No choice recorded')))}</p>${bars()}</div>`;
    if (answer.type === 'score') { const score = Number(answer.score); return `<div class="lv-answer"><strong>${esc(question?.label || id)}</strong><p>Score: ${Number.isFinite(score) ? esc(score) : 'Not reported'}</p>${bars()}</div>`; }
    if (answer.type === 'noul') { const probability = Number(answer.noul); return `<div class="lv-answer"><strong>${esc(question?.label || id)}</strong><p>${Number.isFinite(probability) ? `Yes · ${Math.max(0, Math.min(100, probability * 100)).toFixed(0)}%` : 'No probability reported'}</p></div>`; }
    return `<div class="lv-answer"><strong>${esc(id)}</strong><span>Answer format unavailable</span></div>`;
  }

  function detailHtml(member: Member | undefined, o: { question?: Question; questions: Question[]; segmentLabel: string; hidden?: boolean }): string {
    if (!member) return `<div class="lv-detail-empty"><strong>Pick a tile</strong><p>Hover to see who voted and what they picked. Click, or move with the arrow keys and press Enter, to read their full answer.</p></div>`;
    const initial = esc(member.label.slice(0, 1).toUpperCase());
    if (o.hidden) return `<div class="lv-detail-mark" aria-hidden="true">·</div><h3>Not revealed yet</h3><p>Play the replay forward to see this synthetic profile’s saved result.</p>`;
    const batch = member.batch && member.status === 'running' ? `<p>${member.batch.phase === 'map' ? 'Reading the responses in batches' : 'Combining the batch verdicts'}: ${Math.min(member.batch.done, member.batch.total)} of ${member.batch.total} steps done.</p>` : '';
    const answers = member.answers ? Object.entries(member.answers).map(([id, answer]) => answerView(id, answer, o.questions.find(item => item.id === id) ?? (id === o.question?.id ? o.question : undefined))).join('') : '<p class="lv-muted">No model answer recorded yet.</p>';
    return `<div class="lv-detail-mark" aria-hidden="true">${initial}</div><h3>${esc(member.label)}</h3><p>${esc(o.segmentLabel)} · age ${esc(member.age)} · ${esc(statusWord(member))}${member.repeat > 1 ? ` · repeat ${member.repeat}` : ''}</p>${member.model ? `<p>Model: ${esc(member.model)}${member.cacheHit ? ' · cached result' : ''}</p>` : ''}${batch}${member.reason ? `<p role="alert">${esc(member.reason)}</p>` : ''}<p class="lv-synthetic">Synthetic profile; model output is not observed human behavior.</p><div class="lv-answers"><h4>Model answers</h4>${answers}</div>`;
  }

  function tooltipHtml(member: Member, o: { question?: Question; segmentLabel: string }): string {
    const visual = model.tileVisual(member, o.question, 'pick');
    const pick = member.status === 'completed' ? model.topPick(model.answerFor(member, o.question), o.question) : undefined;
    const swatch = pick && visual.fill === 'option' ? `<i class="lv-tip-swatch" style="background:${model.optionColor(visual.index)}"></i>` : '';
    const line = member.status === 'completed' ? (pick ? `${swatch}${esc(pick.label)}${pick.probability !== null && o.question?.type === 'choice' ? ` · ${Math.round(pick.probability * 100)}%` : ''}` : 'No answer recorded') : member.status === 'failed' ? 'Evaluation failed' : member.status === 'running' ? (member.batch ? `Thinking · step ${Math.min(member.batch.done, member.batch.total)} of ${member.batch.total}` : 'Thinking…') : 'Waiting for a turn';
    return `<strong>${esc(member.label)}</strong><span>${esc(o.segmentLabel)}${member.repeat > 1 ? ` · repeat ${member.repeat}` : ''}</span><span class="lv-tip-line">${line}</span>`;
  }

  function boardRows(board: Board, question: Question | undefined, colorBy: string): string {
    if (!question) return '<li class="lv-row-empty">This step has no question to tally.</li>';
    const rows = question.type === 'score' || question.type === 'noul' ? board.rows : board.rows;
    const max = Math.max(0.0001, ...rows.map(row => row.share));
    const seeded = rows.length ? rows : question.options.map((option, index) => ({ id: option.id, label: option.label, index, share: 0 }));
    return seeded.map((row, rank) => {
      const color = question.type === 'choice' ? model.optionColor(row.index) : `color-mix(in srgb, var(--lv-seq-hi) ${Math.round((question.options.length > 1 ? row.index / (question.options.length - 1) : 1) * 100)}%, var(--lv-seq-lo))`;
      return `<li class="lv-row" data-opt="${esc(row.id)}" data-leader="${board.leader === row.id}" data-hidden="${rank >= BOARD_ROWS}" style="--rank:${Math.min(rank, BOARD_ROWS)};--w:${Math.round(row.share / max * 1000) / 1000};--c:${color}"><span class="lv-swatch" aria-hidden="true"></span><span class="lv-name">${esc(row.label)}</span><span class="lv-bar" aria-hidden="true"><i></i></span><strong class="lv-pct">${pct(row.share)}</strong></li>`;
    }).join('');
  }

  function boardHtml(board: Board, question: Question | undefined, colorBy: string): string {
    const shown = Math.min(BOARD_ROWS, Math.max(1, question?.options.length ?? 1));
    const more = question && question.options.length > BOARD_ROWS ? `<p class="lv-more">${question.options.length - BOARD_ROWS} lower-ranked options not shown.</p>` : '';
    const heading = question?.type === 'score' ? 'Score distribution' : question?.type === 'noul' ? 'Likelihood of yes' : 'Leaderboard';
    const sub = question?.type === 'score' && board.mean !== null ? `Mean score ${Math.round(board.mean * 100) / 100}` : board.evaluated ? `${board.weighted ? 'Weighted share' : 'Equal-weight share'} of ${number(board.evaluated)} evaluated` : 'Fills in as members vote';
    return `<div class="lv-board-head"><h3>${heading}</h3><span data-lv="board-sub">${esc(sub)}</span></div><ol class="lv-rows" style="--rows:${shown}">${boardRows(board, question, colorBy)}</ol>${more}`;
  }

  function legendHtml(colorBy: string, question: Question | undefined, stats: { queued: number; running: number; done: number; failed: number }): string {
    if (colorBy === 'status') return ['queued|Waiting|queued', 'running|Thinking|running', 'done|Voted|done', 'failed|Failed|failed'].map(entry => { const [state, label, key] = entry.split('|'); return `<span class="lv-legend-item"><i class="lv-tile-key" data-s="${state}" aria-hidden="true"></i>${label} <b data-lv="count-${key}">${number(stats[key as 'queued'])}</b></span>`; }).join('');
    if (colorBy === 'confidence') return `<span class="lv-legend-item">Unsure</span><i class="lv-gradient" aria-hidden="true"></i><span class="lv-legend-item">Certain</span><span class="lv-legend-item lv-legend-quiet">Top option’s probability. Grey tiles have not voted.</span>`;
    if (question && question.type !== 'choice') return `<span class="lv-legend-item">${question.type === 'noul' ? 'Unlikely' : 'Low'}</span><i class="lv-gradient" aria-hidden="true"></i><span class="lv-legend-item">${question.type === 'noul' ? 'Likely' : 'High'}</span>`;
    return `<span class="lv-legend-item lv-legend-quiet">Tile colour is the member’s top pick, matching the leaderboard. Grey tiles have not voted.</span>`;
  }

  function statsHtml(stats: { done: number; total: number; failed: number; running: number; rateText: string; leftText: string }, live: boolean, replaying = false): string {
    const finished = stats.done + stats.failed;
    const percent = stats.total ? Math.round(finished / stats.total * 1000) / 10 : 0;
    const chip = (key: string, label: string, value: string): string => `<div class="lv-stat"><span>${label}</span><strong data-lv="${key}">${value}</strong></div>`;
    return `<div class="lv-progress" role="progressbar" aria-label="Evaluations finished" aria-valuemin="0" aria-valuemax="${stats.total}" aria-valuenow="${finished}"><i data-lv="bar" style="--f:${percent / 100}"></i></div><div class="lv-stats">${chip('done', replaying ? 'Revealed' : 'Evaluated', `${number(finished)} / ${number(stats.total)}`)}${chip('running', 'Thinking', number(stats.running))}${chip('failed', 'Failed', number(stats.failed))}${live ? chip('rate', 'Speed', stats.rateText) + chip('left', 'Time left', stats.leftText) : ''}</div>`;
  }

  function segmented(action: string, label: string, options: [string, string][], value: string): string {
    return `<div class="lv-field" role="group" aria-label="${esc(label)}"><span class="lv-field-label">${esc(label)}</span><div class="lv-seg">${options.map(([key, text]) => `<button type="button" data-act="${action}" data-value="${esc(key)}" aria-pressed="${key === value}">${esc(text)}</button>`).join('')}</div></div>`;
  }

  function groupsHtml(input: any): string {
    const byKey = new Map<string, Member>(input.members.map((member: Member) => [model.memberKey(member), member]));
    return input.groups.map((group: { id: string; label: string; keys: string[] }, index: number) => {
      const tiles = group.keys.map(key => {
        const member = byKey.get(key)!;
        return tileHtml(member, { question: input.question, colorBy: input.colorBy, segmentLabel: input.segmentLabels[member.segment] || member.segment, selected: key === input.selectedKey, tabbable: key === input.tabKey });
      }).join('');
      return `<section class="lv-group" data-group="${esc(group.id)}" aria-label="${esc(group.label)}, ${number(group.keys.length)} members"><h3 title="${esc(group.label)}"><span>${esc(group.label)}</span><b>${number(group.keys.length)}</b></h3><div class="lv-tiles" style="--cols:${input.layout.columns[index] ?? 1}">${tiles}</div></section>`;
    }).join('');
  }

  function replayControls(replay: any): string {
    const speeds = [1, 2, 4, 8];
    return `<div class="lv-replay" role="group" aria-label="Replay controls"><div class="lv-replay-actions"><button type="button" class="lv-play" data-act="arena-play" aria-pressed="${!!replay.playing}">${replay.playing ? 'Pause' : 'Play'}</button><button type="button" data-act="arena-step" aria-label="Reveal next member">Step</button><button type="button" data-act="arena-reset" aria-label="Restart replay">Restart</button><button type="button" data-act="arena-live">Show all</button></div><div class="lv-seg" role="group" aria-label="Replay speed">${speeds.map(speed => `<button type="button" data-act="arena-speed" data-speed="${speed}" aria-pressed="${replay.speed === speed}">${speed}×</button>`).join('')}</div><label class="lv-scrub"><span data-lv="scrub-text">${number(Math.floor(replay.cursor))} of ${number(replay.total)} ${replay.total === 1 ? 'member' : 'members'} revealed</span><input type="range" min="0" max="${replay.total}" step="any" value="${replay.cursor}" data-arena-scrub aria-label="Replay position"></label></div>`;
  }

  function stageNav(input: any): string {
    if (input.stages.length < 2) return '';
    return `<nav class="lv-stages" aria-label="Study steps">${input.stages.map((stage: any) => {
      const dependencies = (stage.dependsOn || []).map((id: string) => input.stages.find((candidate: any) => candidate.id === id)?.label || id);
      const detail = `${stage.kind || 'step'} · ${stage.status || 'pending'} · ${dependencies.length ? `after ${dependencies.join(', ')}` : 'first step'}`;
      return `<button type="button" data-act="live-stage" data-stage="${esc(stage.id)}" aria-pressed="${stage.id === input.stageId}" data-stage-state="${esc(stage.status)}" title="${esc(detail)}" aria-label="${esc(`${stage.label}, ${detail}`)}"><i aria-hidden="true"></i><span>${esc(stage.label)}</span></button>`;
    }).join('')}</nav>`;
  }

  /** The whole view for one step of one run. */
  function html(input: any): string {
    const live = input.status === 'running';
    const kicker = live ? 'Live voting' : 'Voting replay';
    const members: Member[] = input.members;
    const note = live
      ? 'Each tile is one synthetic member evaluation; repeats are separate tiles. Tiles count evaluations, not audience share.'
      : input.replay ? `Replay reveals the saved synthetic judgments ${input.replay.ordered ? 'in the order their evaluations finished' : 'in saved order'}; its speed is illustrative, not the real timing. Tiles count evaluations, not audience share.` : 'Each tile is one synthetic member evaluation. Tiles count evaluations, not audience share.';
    const empty = !members.length;
    const groupOptions: [string, string][] = input.groupOptions;
    const controls = empty ? '' : `<div class="lv-controls">${segmented('lv-color', 'Colour by', [['status', 'Status'], ['pick', input.question?.type === 'choice' ? 'Top pick' : 'Result'], ['confidence', 'Confidence']], input.colorBy)}<label class="lv-field"><span class="lv-field-label">Group by</span><select data-lv-group aria-label="Group by">${groupOptions.map(([value, text]) => `<option value="${esc(value)}"${value === input.groupBy ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>${input.questions.length > 1 ? `<label class="lv-field"><span class="lv-field-label">Question</span><select data-lv-question aria-label="Question">${input.questions.map((question: Question) => `<option value="${esc(question.id)}"${question.id === input.question?.id ? ' selected' : ''}>${esc(question.label)}</option>`).join('')}</select></label>` : ''}${segmented('lv-zoom', 'Zoom', [['fit', 'Fit all'], ['1', '1:1'], ['2', 'Large']], input.zoom)}</div>`;
    const player = live || empty ? '' : input.replay ? replayControls(input.replay) : '<div class="lv-replay lv-replay-start"><button type="button" class="lv-play" data-act="arena-replay">Replay voting</button></div>';
    const body = empty
      ? `<div class="lv-empty"><strong>${esc(input.title)}</strong><span>${esc(input.emptyReason)}</span></div>`
      : `<div class="lv-body"><div class="lv-stage"><div class="lv-map" data-zoom="${esc(input.zoom)}" aria-label="Member evaluations grouped by ${esc(groupOptions.find(([value]) => value === input.groupBy)?.[1] || 'segment')}"><div class="lv-groups" data-big="${input.layout.tile >= 30}" style="--tile:${input.layout.tile}px">${groupsHtml(input)}</div></div><div class="lv-under"><div class="lv-legend" data-lv="legend">${legendHtml(input.colorBy, input.question, input.stats)}</div>${player}</div></div><aside class="lv-side"><section class="lv-board" aria-label="${input.question?.type === 'choice' ? 'Leaderboard' : 'Tally'} for ${esc(input.question?.label || 'the question')}"><p class="lv-board-question">${esc(input.question?.label || '')}</p><div data-lv="board">${boardHtml(input.board, input.question, input.colorBy)}</div></section><section class="lv-detail" aria-live="polite" data-lv="detail" data-has="${!!input.selected}">${detailHtml(input.selected, { question: input.question, questions: input.questions, segmentLabel: input.selected ? input.segmentLabels[input.selected.segment] || input.selected.segment : '', hidden: input.selectedHidden })}</section><p class="lv-note">${esc(note)}</p></aside></div>`;
    return `<section class="live-voting" data-run="${esc(input.runId)}" data-stage="${esc(input.stageId)}" data-mode="${live ? 'live' : input.replay ? 'replay' : 'done'}" aria-label="${kicker}"><header class="lv-head"><div class="lv-title"><p class="lv-kicker">${kicker}<span class="lv-message" data-lv="message">${esc(input.message || '')}</span></p><h2>${esc(input.title)}</h2></div><div class="lv-strip" role="status" aria-label="Voting progress" data-lv="strip">${statsHtml({ ...input.stats, total: input.stats.total }, live, !!input.replay)}</div></header><div class="lv-toolbar">${stageNav(input)}${controls}</div>${body}${empty ? `<p class="lv-note">${esc(note)}</p>` : ''}<div class="lv-tip" role="tooltip" hidden></div></section>`;
  }

  return { esc, describeTile, tileHtml, detailHtml, tooltipHtml, boardHtml, boardRows, legendHtml, statsHtml, groupsHtml, html, BOARD_ROWS };
}

/** Browser build of the model and view: one `window.liveVoting` the workspace script drives. */
export const WORKSPACE_LIVE_UI_CLIENT = `window.liveVoting = (() => { const __name = (value) => value; const model = (${createArenaModel.toString()})(); return { model, view: (${createLiveVotingView.toString()})(model) }; })();`;

/** Styles are namespaced `.live-voting` / `.lv-*` for workspace-ui integration. */
export const WORKSPACE_LIVE_UI_CSS = `
:root{--lv-c0:#d98e04;--lv-c1:#1f78c8;--lv-c2:#0f9d78;--lv-c3:#c4508d;--lv-c4:#7d5fc9;--lv-c5:#d4552a;--lv-c6:#8aa326;--lv-c7:#6d7e8f;--lv-queued:#dbe3ec;--lv-queued-line:#c2cedb;--lv-run:#1f78c8;--lv-done:#0f9d78;--lv-fail:#c93a32;--lv-seq-lo:#e9eef4;--lv-seq-hi:#124e8c;--lv-map-bg:var(--raised,#e6ecf3)}
[data-theme=dark]{--lv-c0:#f2b134;--lv-c1:#5aaeff;--lv-c2:#34d3a5;--lv-c3:#ec8dc0;--lv-c4:#a58cf0;--lv-c5:#ff8a5c;--lv-c6:#bcd54c;--lv-c7:#9fb0c1;--lv-queued:#2b3846;--lv-queued-line:#3a4a5b;--lv-run:#5aaeff;--lv-done:#34d3a5;--lv-fail:#ff6a60;--lv-seq-lo:#233140;--lv-seq-hi:#7cc2ff}
.live-voting{position:relative;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:clamp(12px,2vw,20px);margin-top:12px;min-width:0}
.lv-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px 18px;flex-wrap:wrap}.lv-title{min-width:0;flex:1 1 260px}.lv-kicker{margin:0 0 3px;font-size:10px;letter-spacing:.16em;font-weight:800;color:var(--blue);text-transform:uppercase}.lv-title h2{margin:0;font-size:clamp(18px,2vw,23px);letter-spacing:-.03em;overflow-wrap:anywhere}.lv-message{margin-left:10px;font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--muted)}
.lv-strip{flex:2 1 420px;min-width:0}.lv-progress{height:8px;border-radius:5px;background:var(--lv-queued);overflow:hidden}.lv-progress i{display:block;height:100%;width:100%;background:linear-gradient(90deg,var(--lv-run),var(--lv-done));transform:scaleX(var(--f,0));transform-origin:left;transition:transform .5s ease}.lv-stats{display:flex;gap:8px 22px;flex-wrap:wrap;margin-top:8px}.lv-stat{display:flex;flex-direction:column;min-width:0}.lv-stat span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.lv-stat strong{font:700 clamp(15px,1.8vw,20px)/1.15 var(--display,inherit);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.lv-toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 18px;margin:10px 0 8px}.lv-stages{display:flex;gap:6px;flex-wrap:wrap;min-width:0}.lv-stages button{display:flex;align-items:center;gap:7px;max-width:210px;min-height:36px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;font:inherit;font-size:12px}.lv-stages button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lv-stages button i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--lv-queued-line)}.lv-stages button[data-stage-state=running] i{background:var(--lv-run)}.lv-stages button[data-stage-state=completed] i{background:var(--lv-done)}.lv-stages button[data-stage-state=failed] i{background:var(--lv-fail)}.lv-stages button[aria-pressed=true]{border-color:var(--blue);background:var(--selection);font-weight:600}
.lv-replay{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:4px 8px;border-radius:8px;background:var(--raised);font-size:12px;flex:1 1 420px;min-width:0}.lv-replay-start{flex:0 0 auto}.lv-replay-actions{display:flex;gap:6px;flex-wrap:wrap}.lv-replay button,.lv-controls button{min-height:36px;padding:4px 12px;border:1px solid var(--control-line,var(--line));border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;font:inherit;font-size:12px}.lv-replay button:hover,.lv-controls button:hover{background:var(--hover);border-color:var(--blue)}.lv-replay button[aria-pressed=true],.lv-controls button[aria-pressed=true]{background:var(--selection);border-color:var(--blue);color:var(--button-ink,var(--ink));font-weight:600}.lv-play{background:var(--blue)!important;color:var(--surface)!important;border-color:var(--blue)!important;font-weight:700;min-width:84px}.lv-scrub{flex:1 1 260px;display:flex;align-items:center;gap:12px;color:var(--muted);min-width:0}.lv-scrub span{white-space:nowrap;font-variant-numeric:tabular-nums}.lv-scrub input{flex:1;min-width:80px;min-height:36px;accent-color:var(--blue)}
.lv-controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-end;margin-left:auto}.lv-field{display:flex;flex-direction:column;gap:3px;min-width:0}.lv-field-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.lv-seg{display:inline-flex;gap:4px;flex-wrap:wrap}.lv-controls select{min-height:36px;max-width:220px;padding:4px 8px;border:1px solid var(--control-line,var(--line));border-radius:8px;background:var(--field,var(--surface));color:var(--ink);font:inherit;font-size:12px}
.lv-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,300px);gap:14px;align-items:start}.lv-stage{min-width:0}
.lv-map{overflow:auto;background:var(--lv-map-bg);border-radius:8px;padding:6px;min-height:200px;scrollbar-width:thin}.lv-groups{display:flex;flex-wrap:wrap;align-content:flex-start;gap:10px;width:max-content;min-width:100%;max-width:100%}.lv-map[data-zoom="1"] .lv-groups,.lv-map[data-zoom="2"] .lv-groups{max-width:100%}.lv-map[data-wide] .lv-groups{max-width:none}
.lv-group{border:1px solid var(--line);border-radius:8px;padding:7px;background:var(--surface);min-width:0}.lv-group h3{margin:0 0 6px;display:flex;justify-content:space-between;gap:10px;align-items:baseline;font-size:11px;font-weight:600;line-height:1.3;color:var(--ink)}.lv-group h3 span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}.lv-group h3 b{font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
.lv-tiles{display:grid;grid-template-columns:repeat(var(--cols,10),var(--tile,18px));gap:2px}
.lv-tile{width:var(--tile,18px);height:var(--tile,18px);padding:0;border:0;border-radius:max(2px,calc(var(--tile,18px)*.18));background:var(--lv-queued);cursor:pointer;position:relative;outline-offset:1px;box-shadow:inset 0 0 0 1px var(--lv-queued-line);}
.lv-tile[data-s=running]{background:var(--lv-queued);box-shadow:inset 0 0 0 2px var(--lv-run)}.lv-tile[data-s=running]::before{content:'';position:absolute;inset:0;border-radius:inherit;background:color-mix(in srgb,var(--lv-run) 35%,transparent);pointer-events:none;animation:lv-ping 1.1s ease-in-out infinite alternate}.lv-tile[data-s=running][style*="--p"]{background:conic-gradient(from 0deg,var(--lv-run) calc(var(--p,0)*360deg),var(--lv-queued) 0)}
.lv-tile[data-s=failed]{background:var(--lv-fail);box-shadow:none;background-image:linear-gradient(45deg,transparent 42%,rgba(255,255,255,.85) 42% 58%,transparent 58%),linear-gradient(-45deg,transparent 42%,rgba(255,255,255,.85) 42% 58%,transparent 58%)}
.lv-tile[data-s=done]{background:var(--lv-done);box-shadow:none}.lv-tile[data-c="0"]{--c:var(--lv-c0)}.lv-tile[data-c="1"]{--c:var(--lv-c1)}.lv-tile[data-c="2"]{--c:var(--lv-c2)}.lv-tile[data-c="3"]{--c:var(--lv-c3)}.lv-tile[data-c="4"]{--c:var(--lv-c4)}.lv-tile[data-c="5"]{--c:var(--lv-c5)}.lv-tile[data-c="6"]{--c:var(--lv-c6)}.lv-tile[data-c="7"]{--c:var(--lv-c7)}.lv-tile[data-s=done][data-c]:not([data-c=s]){background:var(--c)}.lv-tile[data-s=done][data-c=s]{background:color-mix(in srgb,var(--lv-seq-hi) calc(var(--v,0)*100%),var(--lv-seq-lo))}
.lv-groups[data-big=true] .lv-tile{border-radius:50%}.lv-groups[data-big=true] .lv-tile::after{content:attr(data-i);position:absolute;inset:0;display:grid;place-items:center;font:700 calc(var(--tile,18px)*.3)/1 var(--body,inherit);letter-spacing:.02em;color:var(--muted);pointer-events:none}.lv-groups[data-big=true] .lv-tile[data-s=done]::after,.lv-groups[data-big=true] .lv-tile[data-s=failed]::after{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.45)}.lv-groups[data-big=true] .lv-tile[data-s=running]{box-shadow:inset 0 0 0 2px var(--lv-run)}.lv-groups[data-big=true] .lv-tile[data-s=running][style*="--p"]::before{display:none}.lv-groups[data-big=true] .lv-tile[data-s=running][style*="--p"]{box-shadow:none;background:repeating-conic-gradient(from 0deg,transparent 0 calc(360deg/var(--n,1) - 6deg),var(--surface) 0 calc(360deg/var(--n,1))),radial-gradient(closest-side,var(--surface) 0 62%,transparent 64%),conic-gradient(var(--lv-run) calc(var(--p,0)*360deg),var(--lv-queued) 0)}.lv-groups[data-big=true] .lv-tile[data-s=failed]{background-image:none}
.lv-tile:hover{outline:2px solid var(--ink);z-index:2}.lv-tile[aria-pressed=true]{outline:3px solid var(--blue);outline-offset:1px;z-index:3}.lv-tile:focus-visible{outline:3px solid var(--focus,var(--blue));outline-offset:2px;z-index:3}
.lv-tile.is-pop{animation:lv-pop .4s cubic-bezier(.2,.9,.3,1.35) both}
@keyframes lv-pop{0%{opacity:.15;transform:scale(.5)}100%{opacity:1;transform:scale(1)}}@keyframes lv-ping{0%{opacity:.1}100%{opacity:1}}
.lv-under{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 16px;margin-top:8px}.lv-legend{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;margin:0 2px;font-size:11px;color:var(--muted);min-width:0}.lv-legend-item{display:inline-flex;align-items:center;gap:6px}.lv-legend-item b{color:var(--ink);font-variant-numeric:tabular-nums}.lv-tile-key{width:12px;height:12px;border-radius:3px;display:inline-block;background:var(--lv-queued);box-shadow:inset 0 0 0 1px var(--lv-queued-line)}.lv-tile-key[data-s=running]{box-shadow:inset 0 0 0 2px var(--lv-run)}.lv-tile-key[data-s=done]{background:var(--lv-done);box-shadow:none}.lv-tile-key[data-s=failed]{background:var(--lv-fail);box-shadow:none}.lv-gradient{display:inline-block;width:120px;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--lv-seq-lo),var(--lv-seq-hi));box-shadow:inset 0 0 0 1px var(--lv-queued-line)}.lv-legend-quiet{flex-basis:auto}
.lv-side{display:flex;flex-direction:column;gap:10px;min-width:0}.lv-side>*{flex:none}.lv-board,.lv-detail{border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--surface);min-width:0}.lv-board-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.lv-board h3,.lv-detail h3{margin:0;font-size:14px}.lv-board-head span{font-size:11px;color:var(--muted);text-align:right}.lv-board-question{margin:0 0 6px;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-rows{list-style:none;margin:10px 0 0;padding:0;position:relative;height:calc(var(--rows,1)*30px)}.lv-row{position:absolute;left:0;right:0;height:28px;display:grid;grid-template-columns:12px minmax(60px,1fr) minmax(60px,1.2fr) 48px;align-items:center;gap:8px;transform:translateY(calc(var(--rank,0)*30px));transition:transform .6s cubic-bezier(.3,.8,.3,1);font-size:12px}.lv-row[data-hidden=true]{display:none}.lv-swatch{width:12px;height:12px;border-radius:3px;background:var(--c)}.lv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lv-row[data-leader=true] .lv-name,.lv-row[data-leader=true] .lv-pct{font-weight:700}.lv-row[data-leader=true]::before{content:'';position:absolute;inset:-1px -6px;border-radius:7px;background:color-mix(in srgb,var(--c) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 55%,transparent);z-index:-1}.lv-row>*{position:relative}.lv-bar{height:12px;border-radius:6px;background:var(--lv-queued);overflow:hidden}.lv-bar i{display:block;height:100%;width:100%;background:var(--c);transform:scaleX(var(--w,0));transform-origin:left;transition:transform .6s cubic-bezier(.3,.8,.3,1)}.lv-pct{font-variant-numeric:tabular-nums;text-align:right}.lv-more,.lv-muted{font-size:11px;color:var(--muted);margin:6px 0 0}.lv-row-empty{font-size:12px;color:var(--muted)}
.lv-detail{flex:1 1 auto;min-height:110px;overflow:visible;overflow-wrap:anywhere;font-size:12px}.lv-detail p{margin:5px 0;color:var(--muted)}.lv-detail-mark{float:right;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;background:var(--selection);color:var(--blue);font-weight:800}.lv-detail-empty strong{font-size:13px}.lv-synthetic{border-left:3px solid var(--amber);padding-left:8px}.lv-answers h4{font-size:12px;margin:12px 0 4px;color:var(--ink)}.lv-answer{border-top:1px solid var(--line);padding-top:6px;margin-top:6px}.lv-answer strong{font-size:11px}.lv-prob{display:grid;grid-template-columns:minmax(50px,90px) 1fr 34px;gap:6px;align-items:center;font-size:10px;margin:4px 0}.lv-prob-bar{height:7px;background:var(--line);border-radius:5px;overflow:hidden}.lv-prob-bar i{display:block;height:100%;background:var(--blue)}
.lv-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:36px 12px;text-align:center;color:var(--muted);background:var(--raised);border-radius:8px}.lv-empty strong{color:var(--ink)}.lv-note{margin:2px 2px 0;font-size:11px;color:var(--muted)}
.lv-tip{position:fixed;z-index:30;pointer-events:none;display:flex;flex-direction:column;gap:2px;max-width:260px;padding:8px 10px;border-radius:8px;background:var(--ink);color:var(--surface);font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.28)}.lv-tip span{opacity:.82;font-size:11px}.lv-tip .lv-tip-line{opacity:1;font-weight:600;display:flex;align-items:center;gap:6px}.lv-tip-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.live-voting button:focus-visible,.live-voting select:focus-visible,.live-voting input:focus-visible{outline:3px solid var(--focus,var(--blue));outline-offset:2px}
.live-shell{padding-top:12px;padding-bottom:12px}
@media(max-width:900px){.lv-body{grid-template-columns:1fr}.lv-side{display:contents}.lv-board{order:-1}.lv-detail{order:2;max-height:none;flex:none}.lv-note{order:3}}
@media(max-width:760px){.lv-head{align-items:stretch}.lv-controls{gap:10px 12px}.lv-controls select{max-width:100%}.lv-map{max-height:62vh}.lv-replay-actions button,.lv-seg button{min-height:40px}.lv-scrub{flex-basis:100%}}
@media(pointer:coarse){.lv-tile{min-width:var(--tile,18px)}}
@media(prefers-reduced-motion:reduce){.live-voting *{animation:none!important;transition:none!important}}
`;
