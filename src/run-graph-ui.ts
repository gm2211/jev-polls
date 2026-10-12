/**
 * The study's steps as a graph for a run: what each step reads and what it gives out, with wires between them.
 * Pure string builders over plain pipeline data, so the live run view, the report and the unit tests run the same code.
 * Keep the factory self-contained: it is serialized into inline client scripts.
 */
export function createRunGraphView() {
  const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const KIND: Record<string, string> = { poll: 'Ask the audience', aggregate: 'Combine answers', decision: 'Final answer', choose: 'Final answer' };
  const READS: Record<string, string> = { summary: 'summary', winner: 'top option', mean: 'mean', probabilities: 'shares', responses: 'every answer' };
  const METRIC: Record<string, string> = { margin: 'lead', topProbability: 'top share', mean: 'mean', winner: 'top option' };
  const OP: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' };
  /** Geometry shared by the markup and the wires, so ports line up without measuring the DOM (the report has no layout pass). */
  const SIZE = {
    compact: { width: 200, gapX: 40, gapY: 10, height: 52 },
    full: { width: 228, gapX: 44, gapY: 14, header: 44, row: 22, sep: 9, pad: 7 },
  };

  type Field = { id: string; label: string; type: string; short: string; detail: string };
  type Read = { from?: string; question?: string; label: string; form: string; detail: string; kind: 'step' | 'audience' | 'condition' };
  type Schema = { inputs: Read[]; outputs: Field[] };

  const choiceLabel = (question: any, key: string): string => {
    const meaning = question?.criteria?.[key];
    return meaning && typeof meaning === 'object' ? String(meaning.label || key) : typeof meaning === 'string' && meaning.trim() && meaning.trim().length <= 48 ? meaning.trim() : key;
  };
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** A question's answer shape: the short chip on the node and the full field description for the tooltip. */
  function fieldOf(pipeline: any, id: string, question: any, label?: string): Field {
    const name = String(label || question?.label || id);
    if (question?.type === 'score') {
      const levels: string[] = Array.isArray(question.criteria) ? question.criteria.map(String) : [];
      return { id, label: name, type: 'score', short: `Scale · ${levels.length}`, detail: `${name}: ordered scale, ${plural(levels.length, 'level')}${levels.length ? ` (${levels.map((level, index) => `${index} ${level}`).join('; ')})` : ''}` };
    }
    if (question?.type === 'noul') return { id, label: name, type: 'noul', short: 'Yes / no', detail: `${name}: yes / no probability` };
    if (question?.type === 'choice') {
      const keys = Object.keys(question.criteria || {});
      const source = question.optionsFrom ? (pipeline.stages || []).findIndex((stage: any) => stage.id === question.optionsFrom.stage) : -1;
      const from = question.optionsFrom ? ` taken from step ${source + 1}${question.optionsFrom.top ? `, top ${question.optionsFrom.top}` : ''}` : '';
      return { id, label: name, type: 'choice', short: question.optionsFrom ? `Choice · from ${source + 1}` : `Choice · ${keys.length}`, detail: `${name}: choice of ${plural(keys.length, 'option')}${from}${keys.length ? ` (${keys.map(key => choiceLabel(question, key)).join(', ')})` : ''}` };
    }
    return { id, label: name, type: 'result', short: 'Result', detail: `${name}: result` };
  }

  /** The question a step's output answers, following combine and final-answer steps back to where it was asked. */
  function questionFor(pipeline: any, stageId: string, questionId: string, seen: string[] = []): any {
    if (seen.includes(stageId)) return undefined;
    const stage = (pipeline.stages || []).find((item: any) => item.id === stageId);
    if (!stage) return undefined;
    if (stage.kind === 'poll' || stage.kind === 'choose') return stage.questions?.[questionId];
    if (stage.kind === 'aggregate') { const first = stage.inputs?.[0]; return first ? questionFor(pipeline, first.stage, first.question, [...seen, stageId]) : undefined; }
    if (stage.kind === 'decision') return stage.from ? questionFor(pipeline, stage.from.stage, stage.from.question, [...seen, stageId]) : undefined;
    return undefined;
  }

  function outputsOf(pipeline: any, stage: any): Field[] {
    if (stage.kind === 'poll' || stage.kind === 'choose') return Object.entries(stage.questions || {}).map(([id, question]) => fieldOf(pipeline, id, question));
    const question = questionFor(pipeline, stage.id, stage.outputQuestion);
    if (stage.kind === 'decision') {
      const keys = question?.type === 'choice' ? Object.keys(question.criteria || {}) : [];
      return [{ id: stage.outputQuestion, label: String(stage.label || 'Top option'), type: 'decision', short: 'Top option', detail: `${stage.label || 'Top option'}: the leading option${keys.length ? `, one of ${keys.map(key => choiceLabel(question, key)).join(', ')}` : ''}` }];
    }
    return [fieldOf(pipeline, stage.outputQuestion, question, stage.label)];
  }

  function conditionText(pipeline: any, condition: any): string {
    if (!condition) return '';
    if (condition.all) return condition.all.map((item: any) => conditionText(pipeline, item)).join(' and ');
    if (condition.any) return condition.any.map((item: any) => conditionText(pipeline, item)).join(' or ');
    if (condition.not) return `not (${conditionText(pipeline, condition.not)})`;
    const stage = (pipeline.stages || []).find((item: any) => item.id === condition.stage);
    const question = questionFor(pipeline, condition.stage, condition.question);
    const value = typeof condition.value === 'number' && (condition.metric === 'margin' || condition.metric === 'topProbability')
      ? `${Math.round(condition.value * 1000) / 10}${condition.metric === 'margin' ? ' pts' : '%'}`
      : question?.type === 'choice' && typeof condition.value === 'string' ? choiceLabel(question, condition.value) : String(condition.value);
    return `${question?.label || condition.question} ${METRIC[condition.metric] || condition.metric} ${OP[condition.op] || condition.op} ${value}${stage ? ` in ${stage.label}` : ''}`;
  }

  function inputsOf(pipeline: any, stage: any, audiences: Record<string, string>): Read[] {
    const reads: Read[] = [];
    const step = (from: string, questionId: string | undefined, form: string, extra = ''): Read => {
      const source = (pipeline.stages || []).find((item: any) => item.id === from);
      const field = source && questionId ? outputsOf(pipeline, source).find(output => output.id === questionId) : undefined;
      const label = field?.label || (questionId ? questionId : String(source?.label || from));
      const detail = questionId
        ? `${label} (${form}${extra}) from ${source?.label || from}${field ? ` · ${field.detail.slice(field.label.length + 2)}` : ''}`
        : `Every result of ${source?.label || from}${source ? `: ${outputsOf(pipeline, source).map(output => output.label).join(', ')}` : ''}`;
      return { from, question: questionId, label, form, detail, kind: 'step' };
    };
    if (stage.kind === 'poll') {
      const audience = audiences[stage.cohort] || stage.cohort;
      reads.push({ label: String(audience), form: 'audience', detail: `Audience: ${audience}${stage.size ? `, ${stage.size} people` : ''}${stage.repeats > 1 ? `, each asked ${stage.repeats} times` : ''}`, kind: 'audience' });
    }
    if (stage.kind === 'decision' && stage.from) reads.push(step(stage.from.stage, stage.from.question, 'top option'));
    else if (stage.kind === 'aggregate') for (const input of stage.inputs || []) reads.push(step(input.stage, input.question, `×${input.weight}`, ', weight'));
    else if (stage.inputs && (stage.kind === 'poll' || stage.kind === 'choose')) for (const input of Object.values(stage.inputs) as any[]) reads.push(step(input.stage, input.question, (READS[input.select || 'summary'] || input.select) + (input.batch ? ' · in batches' : '')));
    else if (stage.kind === 'poll') for (const from of stage.dependsOn || []) reads.push(step(from, undefined, 'all results'));
    if (stage.when) reads.push({ label: conditionText(pipeline, stage.when), form: 'if', detail: `Runs only if ${conditionText(pipeline, stage.when)}`, kind: 'condition' });
    return reads;
  }

  function schemaOf(pipeline: any, stage: any, audiences: Record<string, string> = {}): Schema {
    return { inputs: inputsOf(pipeline, stage, audiences), outputs: outputsOf(pipeline, stage) };
  }

  /** One line for a compact node: what comes in, and what goes out. */
  function summaryOf(schema: Schema): string {
    const steps = schema.inputs.filter(read => read.kind === 'step');
    const audience = schema.inputs.find(read => read.kind === 'audience');
    const sources = new Set(steps.map(read => read.from)).size;
    const into = audience ? (sources ? `Audience + ${plural(sources, 'step')}` : 'Audience') : sources === 1 ? String(steps[0]!.label) : sources ? plural(sources, 'input') : 'Start';
    const out = schema.outputs.length === 1 ? schema.outputs[0]!.short : plural(schema.outputs.length, 'answer');
    return `${into} → ${out}`;
  }

  /** Column per depth (longest path from a first step), so every wire runs left to right. */
  function columnsOf(stages: any[]): any[][] {
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    const depth = new Map<string, number>();
    const visit = (stage: any, trail: string[]): number => {
      if (depth.has(stage.id)) return depth.get(stage.id)!;
      if (trail.includes(stage.id)) return 0;
      const parents = (stage.dependsOn || []).map((id: string) => byId.get(id)).filter(Boolean);
      const value = parents.length ? Math.max(...parents.map((parent: any) => visit(parent, [...trail, stage.id]) + 1)) : 0;
      depth.set(stage.id, value); return value;
    };
    stages.forEach(stage => visit(stage, []));
    const columns: any[][] = [];
    stages.forEach(stage => { const d = depth.get(stage.id) ?? 0; (columns[d] ??= []).push(stage); });
    return columns.filter(Boolean);
  }

  type Box = { stage: any; index: number; schema: Schema; x: number; y: number; h: number };

  function layout(pipeline: any, full: boolean, audiences: Record<string, string>) {
    const stages: any[] = pipeline.stages || [];
    const size = full ? SIZE.full : SIZE.compact;
    const heightOf = (schema: Schema): number => {
      if (!full) return SIZE.compact.height;
      const f = SIZE.full;
      return f.header + schema.inputs.length * f.row + (schema.inputs.length ? f.sep : 0) + schema.outputs.length * f.row + f.pad;
    };
    const columns = columnsOf(stages).map(column => column.map(stage => { const schema = schemaOf(pipeline, stage, audiences); return { stage, index: stages.indexOf(stage), schema, h: heightOf(schema) }; }));
    const columnHeight = (column: { h: number }[]) => column.reduce((sum, box) => sum + box.h, 0) + Math.max(0, column.length - 1) * size.gapY;
    const height = Math.max(0, ...columns.map(columnHeight));
    const boxes: Box[] = [];
    columns.forEach((column, c) => {
      let y = Math.round((height - columnHeight(column)) / 2);
      for (const box of column) { boxes.push({ ...box, x: c * (size.width + size.gapX), y }); y += box.h + size.gapY; }
    });
    return { boxes, width: columns.length ? columns.length * size.width + (columns.length - 1) * size.gapX : 0, height, size };
  }

  /** Port heights inside a full node, in the same order the rows are drawn. */
  function inputY(box: Box, index: number): number { const f = SIZE.full; return box.y + f.header + index * f.row + f.row / 2; }
  function outputY(box: Box, index: number): number { const f = SIZE.full; return box.y + f.header + box.schema.inputs.length * f.row + (box.schema.inputs.length ? f.sep : 0) + index * f.row + f.row / 2; }

  function wire(x1: number, y1: number, x2: number, y2: number): string {
    const bend = Math.max(24, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }

  function edgesOf(boxes: Box[], full: boolean, width: number) {
    const byId = new Map(boxes.map(box => [box.stage.id, box]));
    const edges: { d: string; title: string; from: string; to: string }[] = [];
    const seen = new Set<string>();
    for (const target of boxes) {
      target.schema.inputs.forEach((read, index) => {
        if (read.kind !== 'step' || !read.from) return;
        const source = byId.get(read.from); if (!source) return;
        const key = full ? `${read.from}>${target.stage.id}:${index}` : `${read.from}>${target.stage.id}`;
        if (seen.has(key)) return; seen.add(key);
        const out = read.question ? source.schema.outputs.findIndex(field => field.id === read.question) : -1;
        const x1 = source.x + width, x2 = target.x;
        const y1 = full ? (out >= 0 ? outputY(source, out) : source.y + SIZE.full.header / 2) : source.y + source.h / 2;
        const y2 = full ? inputY(target, index) : target.y + target.h / 2;
        const passed = full ? `${read.label} (${read.form})` : target.schema.inputs.filter(item => item.from === read.from).map(item => `${item.label} (${item.form})`).join(', ');
        edges.push({ d: wire(x1, y1, x2, y2), title: `${source.stage.label} → ${target.stage.label}: ${passed}`, from: source.stage.id, to: target.stage.id });
      });
    }
    return edges;
  }

  function nodeTitle(box: Box, status: string): string {
    const lines = [`${box.index + 1}. ${box.stage.label} · ${KIND[box.stage.kind] || box.stage.kind}${status ? ` · ${status}` : ''}`];
    if (box.schema.inputs.length) lines.push('In:', ...box.schema.inputs.map(read => `  ${read.detail}`));
    lines.push('Out:', ...box.schema.outputs.map(field => `  ${field.detail}`));
    return lines.join('\n');
  }

  function readRow(read: Read, boxes: Box[]): string {
    const source = read.from ? boxes.find(box => box.stage.id === read.from) : undefined;
    const badge = read.kind === 'audience' ? '<b class="rg-src rg-src-aud" aria-hidden="true">A</b>' : read.kind === 'condition' ? '<b class="rg-src rg-src-if" aria-hidden="true">if</b>' : `<b class="rg-src" aria-hidden="true">${source ? source.index + 1 : '?'}</b>`;
    return `<li class="rg-row rg-in" data-kind="${read.kind}" title="${esc(read.detail)}">${badge}<span class="rg-name">${esc(read.label)}</span>${read.kind === 'condition' ? '' : `<em>${esc(read.form)}</em>`}</li>`;
  }

  /**
   * The graph. `mode` 'compact' shows a one-line schema summary per step (full detail in the tooltip); 'full' gives every
   * input and output its own row and wires each output to the exact input that reads it.
   */
  function html(input: { pipeline: any; statuses?: Record<string, string>; notes?: Record<string, string>; audiences?: Record<string, string>; selected?: string; act?: string; mode?: 'compact' | 'full'; label?: string }): string {
    const pipeline = input.pipeline || { stages: [] };
    const full = input.mode === 'full';
    const audiences = input.audiences || {};
    const { boxes, width, height, size } = layout(pipeline, full, audiences);
    if (!boxes.length) return '';
    const edges = edgesOf(boxes, full, size.width);
    const nodes = boxes.map(box => {
      const status = input.statuses?.[box.stage.id] || '';
      const note = input.notes?.[box.stage.id];
      const tag = input.act ? 'button' : 'div';
      const attrs = input.act ? ` type="button" data-act="${esc(input.act)}" data-stage="${esc(box.stage.id)}" aria-pressed="${box.stage.id === input.selected}"` : '';
      const head = `<span class="rg-head"><i class="rg-dot" aria-hidden="true"></i><b class="rg-n">${box.index + 1}</b><strong>${esc(box.stage.label)}</strong></span>`;
      const body = full
        ? `<span class="rg-kind">${esc(note || KIND[box.stage.kind] || box.stage.kind)}</span>${box.schema.inputs.length ? `<ul class="rg-rows" aria-label="Inputs">${box.schema.inputs.map(read => readRow(read, boxes)).join('')}</ul><hr class="rg-sep">` : ''}<ul class="rg-rows" aria-label="Outputs">${box.schema.outputs.map(field => `<li class="rg-row rg-out" data-type="${field.type}" title="${esc(field.detail)}"><span class="rg-name">${esc(field.label)}</span><em>${esc(field.short)}</em></li>`).join('')}</ul>`
        : `<span class="rg-sum">${esc(summaryOf(box.schema))}</span>`;
      const feedsAll = full && boxes.some(other => other.schema.inputs.some(read => read.kind === 'step' && read.from === box.stage.id && !read.question));
      return `<${tag} class="rg-node" data-stage-id="${esc(box.stage.id)}" data-state="${esc(status)}"${feedsAll ? ' data-feeds-all=""' : ''} style="left:${box.x}px;top:${box.y}px;width:${size.width}px;height:${box.h}px"${attrs} title="${esc(nodeTitle(box, status))}">${head}${body}</${tag}>`;
    }).join('');
    const svg = `<svg class="rg-wires" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${edges.map(edge => `<path d="${edge.d}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}"><title>${esc(edge.title)}</title></path>`).join('')}</svg>`;
    return `<div class="rg" data-mode="${full ? 'full' : 'compact'}" role="group" aria-label="${esc(input.label || 'Study steps with their inputs and outputs')}"><div class="rg-canvas" style="width:${width}px;height:${height}px">${svg}${nodes}</div></div>`;
  }

  return { html, schemaOf, summaryOf, columnsOf, conditionText };
}

export const runGraph = createRunGraphView();

/** Serialized for inline scripts (`window.runGraph` in the workspace, a local in the report). */
export const RUN_GRAPH_FACTORY = `(() => { const __name = (value) => value; return (${createRunGraphView.toString()})(); })()`;

/** Uses only the shared palette variables, so it themes the same in the workspace and the report. */
export const RUN_GRAPH_CSS = `
.rg{overflow:auto;max-width:100%;contain:inline-size;box-sizing:border-box;padding:2px 6px 6px;-webkit-overflow-scrolling:touch}
.rg-canvas{position:relative;flex:none}
.rg-wires{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.rg-wires path{fill:none;stroke:var(--control-line);stroke-width:1.5;opacity:.7}
.rg-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;margin:0;padding:0;border:0;border-radius:8px;background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line);font:inherit;font-size:var(--text-sm);text-align:left;overflow:visible}
button.rg-node{cursor:pointer}
button.rg-node:hover{box-shadow:inset 0 0 0 1px var(--control-line)}
.rg-node[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--blue);background:var(--selection)}
.rg-node:focus-visible{outline:2px solid var(--focus,var(--blue));outline-offset:2px}
.rg-node[data-state=skipped]{border:0;box-shadow:inset 0 0 0 1px var(--line);opacity:.62;background-image:repeating-linear-gradient(135deg,transparent 0 6px,var(--raised) 6px 7px)}
.rg-head{display:flex;align-items:center;gap:6px;min-width:0;padding:7px 10px 0;line-height:18px}
.rg-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-sm);font-weight:600}
.rg-n{flex:none;display:inline-grid;place-items:center;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;border-radius:4px;background:var(--raised);color:var(--muted);font-size:var(--text-xs);font-weight:600;font-variant-numeric:tabular-nums}
.rg-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--line)}
.rg-node[data-state=running] .rg-dot{background:var(--blue)}
.rg-node[data-state=completed] .rg-dot{background:#0f9d78}
.rg-node[data-state=failed] .rg-dot{background:var(--red)}
.rg-node[data-state=skipped] .rg-dot{background:transparent;box-shadow:inset 0 0 0 1px var(--control-line)}
.rg-sum,.rg-kind{display:block;padding:2px 10px 0 24px;color:var(--muted);font-size:var(--text-xs);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rg-kind{height:19px;box-sizing:border-box}
.rg-rows{list-style:none;margin:0;padding:0}
.rg-row{position:relative;display:flex;align-items:center;gap:6px;height:22px;padding:0 10px;font-size:var(--text-xs);line-height:22px;min-width:0}
.rg-row .rg-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.rg-row em{flex:none;font-style:normal;padding:0 6px;border-radius:999px;background:var(--raised);color:var(--muted);line-height:16px;font-size:10.5px;font-variant-numeric:tabular-nums}
.rg-out em{background:var(--selection);color:var(--blue)}
.rg-in::before,.rg-out::after{content:"";position:absolute;top:7px;width:8px;height:8px;border-radius:50%;box-sizing:border-box;background:var(--surface);border:1.5px solid var(--control-line)}
.rg-in::before{left:-4px}
.rg-out::after{right:-4px;background:var(--blue);border-color:var(--blue)}
.rg-in[data-kind=audience]::before,.rg-in[data-kind=condition]::before{display:none}
.rg-src{flex:none;display:inline-grid;place-items:center;min-width:14px;height:14px;padding:0 2px;box-sizing:border-box;border-radius:3px;border:1px solid var(--line);color:var(--muted);font-size:10px;font-weight:600;line-height:1}
.rg-src-aud{border-style:dashed}
.rg-src-if{border:0;font-style:italic;font-weight:500;padding:0}
.rg-in[data-kind=condition] .rg-name{color:var(--muted);font-style:italic}
.rg-node[data-feeds-all] .rg-head::after{content:"";position:absolute;right:-4px;top:18px;width:8px;height:8px;border-radius:50%;box-sizing:border-box;background:var(--control-line);border:1.5px solid var(--control-line)}
.rg-sep{height:0;margin:4px 10px 4px;border:0;border-top:1px dashed var(--line)}
`;
