/**
 * Pure logic behind the live voting map: tile colours, grouping, the leaderboard, layout fitting,
 * throughput, incremental patch plans and replay ordering. Keep this factory self-contained (no imports
 * at runtime, no outer references): the workspace serializes `createArenaModel.toString()` into its
 * inline client script, and the unit tests run the very same function.
 */
export function createArenaModel() {
  type Answer = { type?: string; choice?: string; score?: number; noul?: number; probabilities?: Record<string, number> } & Record<string, unknown>;
  type Member = {
    stage: string; personaId: string; label: string; segment: string; age: number; repeat: number;
    status: 'queued' | 'running' | 'completed' | 'failed'; weight?: number; order?: number;
    batch?: { phase: 'map' | 'combine'; done: number; total: number };
    answers?: Record<string, unknown>; model?: string; cacheHit?: boolean; reason?: string;
  };
  type Option = { id: string; label: string };
  type Question = { id: string; label: string; type: 'choice' | 'score' | 'noul'; options: Option[] };
  type Persona = { age?: number; attributes?: Record<string, unknown> } | undefined;
  type Visual = { state: 'queued' | 'running' | 'failed' | 'done'; /** 'option' tiles use palette `index`; 'scale' tiles use `value` 0..1. */ fill: 'none' | 'option' | 'scale'; index: number; value: number; progress: number | null };

  /** Option colours are palette slots; the first PALETTE slots are curated in CSS, later ones are generated. */
  const PALETTE = 8;
  const GROUP_LIMIT = 12;
  const AGE_BANDS: [number, number, string][] = [[0, 30, '18–29'], [30, 40, '30–39'], [40, 50, '40–49'], [50, 60, '50–59'], [60, 70, '60–69'], [70, 1000, '70+']];

  const clamp01 = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const memberKey = (member: { stage: string; personaId: string; repeat: number }): string => `${member.stage}:${member.personaId}:${member.repeat}`;

  /** The questions of a step as the map needs them: choice options (label + id), score levels, or a yes-probability. */
  function describeQuestions(questions: Record<string, any> | undefined, members: Member[] = []): Question[] {
    const result: Question[] = [];
    for (const [id, raw] of Object.entries(questions ?? {})) {
      const type = raw?.type === 'score' || raw?.type === 'noul' ? raw.type : 'choice';
      let options: Option[] = [];
      if (type === 'choice') options = Object.entries(raw?.criteria ?? {}).map(([optionId, value]: [string, any]) => ({ id: optionId, label: typeof value === 'string' ? optionId : String(value?.label || optionId) }));
      else if (type === 'score') options = (Array.isArray(raw?.criteria) ? raw.criteria : []).map((value: unknown, index: number) => ({ id: String(index), label: typeof value === 'string' ? value : String((value as any)?.label ?? index) }));
      else options = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
      result.push({ id, label: String(raw?.label || id), type, options });
    }
    if (result.length) return result;
    // Saved runs whose study was edited or removed: recover the options from the recorded answers.
    const seen = new Map<string, Question>();
    for (const member of members) for (const [id, value] of Object.entries(member.answers ?? {})) {
      const answer = value as Answer;
      if (!answer || typeof answer !== 'object') continue;
      const type = answer.type === 'score' || answer.type === 'noul' ? answer.type : 'choice';
      const question = seen.get(id) ?? { id, label: id, type: type as Question['type'], options: type === 'noul' ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] : [] };
      if (type !== 'noul') for (const optionId of Object.keys(answer.probabilities ?? {})) if (!question.options.some(option => option.id === optionId)) question.options.push({ id: optionId, label: optionId });
      seen.set(id, question);
    }
    return [...seen.values()];
  }

  function answerFor(member: Member, question: Question | undefined): Answer | undefined {
    const value = question ? member.answers?.[question.id] : undefined;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Answer : undefined;
  }

  /** What a finished member voted for and how strongly: the tooltip, the tile colour and the detail all read this. */
  function topPick(answer: Answer | undefined, question: Question | undefined): { label: string; index: number; probability: number | null; value: number | null } | undefined {
    if (!answer || !question) return undefined;
    if (answer.type === 'noul') {
      const yes = Number(answer.noul);
      return Number.isFinite(yes) ? { label: `Yes ${Math.round(clamp01(yes) * 100)}%`, index: yes >= 0.5 ? 0 : 1, probability: clamp01(yes), value: clamp01(yes) } : undefined;
    }
    if (answer.type === 'score') {
      const score = Number(answer.score);
      if (!Number.isFinite(score)) return undefined;
      const levels = Math.max(1, question.options.length);
      const top = Object.values(answer.probabilities ?? {}).reduce((best, next) => Math.max(best, Number(next) || 0), 0);
      return { label: `Score ${Math.round(score * 100) / 100}`, index: Math.min(levels - 1, Math.max(0, Math.round(score))), probability: top || null, value: levels > 1 ? clamp01(score / (levels - 1)) : 0.5 };
    }
    const probabilities = answer.probabilities ?? {};
    const choice = typeof answer.choice === 'string' && answer.choice ? answer.choice : Object.entries(probabilities).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
    if (!choice) return undefined;
    const index = question.options.findIndex(option => option.id === choice);
    const probability = Number(probabilities[choice]);
    return { label: question.options[index]?.label ?? choice, index: index < 0 ? question.options.length : index, probability: Number.isFinite(probability) ? clamp01(probability) : null, value: null };
  }

  /** How sure the answer is, 0..1 (1 = certain), for the Confidence colouring. */
  function confidenceOf(answer: Answer | undefined, question: Question | undefined): number | undefined {
    if (!answer || !question) return undefined;
    if (answer.type === 'noul') { const yes = Number(answer.noul); return Number.isFinite(yes) ? clamp01(Math.abs(yes - 0.5) * 2) : undefined; }
    const values = Object.values(answer.probabilities ?? {}).map(Number).filter(Number.isFinite);
    if (!values.length) return undefined;
    const top = Math.max(...values);
    const floor = 1 / Math.max(2, values.length);
    return clamp01((top - floor) / (1 - floor));
  }

  /** What a tile looks like for one colouring. Failed and running are always visible whatever the colouring. */
  function tileVisual(member: Member, question: Question | undefined, colorBy: 'status' | 'pick' | 'confidence'): Visual {
    if (member.status === 'queued') return { state: 'queued', fill: 'none', index: 0, value: 0, progress: null };
    if (member.status === 'failed') return { state: 'failed', fill: 'none', index: 0, value: 0, progress: null };
    if (member.status === 'running') {
      const batch = member.batch;
      return { state: 'running', fill: 'none', index: 0, value: 0, progress: batch && batch.total > 0 ? clamp01(batch.done / batch.total) : null };
    }
    if (colorBy === 'status') return { state: 'done', fill: 'none', index: 0, value: 0, progress: null };
    const answer = answerFor(member, question);
    if (colorBy === 'confidence') {
      const confidence = confidenceOf(answer, question);
      return confidence === undefined ? { state: 'done', fill: 'none', index: 0, value: 0, progress: null } : { state: 'done', fill: 'scale', index: 0, value: confidence, progress: null };
    }
    const pick = topPick(answer, question);
    if (!pick) return { state: 'done', fill: 'none', index: 0, value: 0, progress: null };
    if (question?.type === 'choice') return { state: 'done', fill: 'option', index: pick.index, value: 0, progress: null };
    return { state: 'done', fill: 'scale', index: pick.index, value: pick.value ?? 0, progress: null };
  }

  /** Palette slot to CSS colour: slots below PALETTE come from theme variables; later ones spread hues. */
  function optionColor(index: number): string {
    return index < PALETTE ? `var(--lv-c${index})` : `hsl(${Math.round((index * 137.508) % 360)} 58% 52%)`;
  }

  // ---- grouping ----------------------------------------------------------------------------------------

  function attributeValue(persona: Persona, field: string): unknown {
    let value: any = persona?.attributes;
    for (const part of field.replace(/^attributes\./, '').split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }

  /** One scalar group value for a member: arrays group by their one item, or "Several" when they hold more. */
  function scalarGroupValue(raw: unknown): string | number {
    if (raw === undefined || raw === null || raw === '') return 'Not specified';
    if (Array.isArray(raw)) return raw.length === 0 ? 'Not specified' : raw.length === 1 ? scalarGroupValue(raw[0]) : 'Several';
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 'Not specified';
    if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
    if (typeof raw === 'object') return JSON.stringify(raw);
    return String(raw);
  }

  function niceStep(span: number, bins: number): number {
    const desired = span / bins || 1;
    const power = 10 ** Math.floor(Math.log10(desired));
    const fraction = desired / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  }

  /**
   * Split members into labelled groups. `lookup` finds the persona behind a member (for attributes and age).
   * Groups come out in a stable, readable order: segments as they appear, ages ascending, other attributes
   * by size. More than GROUP_LIMIT groups fold the smallest into "Other".
   */
  function groupMembers(members: Member[], groupBy: string, lookup: (member: Member) => Persona, segmentLabels: Record<string, string> = {}): { id: string; label: string; keys: string[] }[] {
    if (!members.length) return [];
    const buckets = new Map<string, { id: string; label: string; keys: string[]; sort: number }>();
    const add = (id: string, label: string, key: string, sort: number): void => {
      const bucket = buckets.get(id) ?? { id, label, keys: [], sort };
      bucket.keys.push(key);
      buckets.set(id, bucket);
    };
    if (groupBy === 'none' || !groupBy) {
      return [{ id: 'all', label: 'All members', keys: members.map(memberKey) }];
    }
    if (groupBy === 'segment') {
      members.forEach(member => add(member.segment, segmentLabels[member.segment] || member.segment, memberKey(member), buckets.size));
      return [...buckets.values()].map(({ id, label, keys }) => ({ id, label, keys }));
    }
    if (groupBy === 'age') {
      for (const member of members) {
        const age = Number(lookup(member)?.age ?? member.age);
        const band = AGE_BANDS.findIndex(([low, high]) => age >= low && age < high);
        add(band < 0 ? 'unknown' : AGE_BANDS[band]![2], band < 0 ? 'Not specified' : AGE_BANDS[band]![2], memberKey(member), band < 0 ? 99 : band);
      }
    } else {
      const raw = members.map(member => scalarGroupValue(attributeValue(lookup(member), groupBy)));
      const numbers = raw.filter((value): value is number => typeof value === 'number');
      const numeric = numbers.length > 0 && numbers.length === raw.filter(value => value !== 'Not specified').length && new Set(numbers).size > 6;
      if (numeric) {
        const low = Math.min(...numbers), high = Math.max(...numbers), step = niceStep(high - low, 5), start = Math.floor(low / step) * step;
        const fmt = (value: number): string => String(Number(value.toPrecision(4)));
        members.forEach((member, index) => {
          const value = raw[index]!;
          if (typeof value !== 'number') { add('Not specified', 'Not specified', memberKey(member), 9e9); return; }
          const from = start + Math.floor((value - start) / step) * step;
          add(`n${from}`, `${fmt(from)}–${fmt(from + step)}`, memberKey(member), from);
        });
      } else {
        members.forEach((member, index) => add(String(raw[index]), String(raw[index]), memberKey(member), 0));
      }
    }
    let groups = [...buckets.values()];
    const bySize = groupBy === 'age' || (groupBy !== 'age' && groups.every(group => group.sort === 0));
    groups.sort((a, b) => groupBy === 'age' || !bySize ? a.sort - b.sort : (a.id === 'Not specified' ? 1 : b.id === 'Not specified' ? -1 : b.keys.length - a.keys.length || a.label.localeCompare(b.label)));
    if (groups.length > GROUP_LIMIT) {
      const kept = groups.slice(0, GROUP_LIMIT - 1);
      const rest = groups.slice(GROUP_LIMIT - 1);
      groups = [...kept, { id: 'other', label: `Other (${rest.length})`, keys: rest.flatMap(group => group.keys), sort: 9e9 }];
    }
    return groups.map(({ id, label, keys }) => ({ id, label, keys }));
  }

  /** Attributes worth grouping by: 2 to 24 distinct groups once arrays and numbers are folded. */
  function groupFields(fields: { field: string }[], members: Member[], lookup: (member: Member) => Persona): string[] {
    const sample = members.length > 1500 ? members.filter((_, index) => index % Math.ceil(members.length / 1500) === 0) : members;
    return fields.map(entry => entry.field).filter(field => field.startsWith('attributes.')).filter(field => {
      const count = groupMembers(sample, field, lookup).length;
      return count >= 2 && count <= GROUP_LIMIT * 2;
    });
  }

  // ---- leaderboard -------------------------------------------------------------------------------------

  /**
   * Weighted share of each option among the members evaluated so far. Matches the report: the mean of the
   * members' answer probabilities, weighted by the audience share each evaluation stands for. Members with no
   * recorded weight (runs saved before weights were kept) count equally; `weighted` says which happened.
   */
  function leaderboard(members: Member[], question: Question | undefined): { rows: { id: string; label: string; index: number; share: number }[]; evaluated: number; weighted: boolean; mean: number | null; leader: string | null } {
    const empty = { rows: [] as { id: string; label: string; index: number; share: number }[], evaluated: 0, weighted: true, mean: null, leader: null };
    if (!question) return empty;
    const done = members.filter(member => member.status === 'completed' && answerFor(member, question));
    const weighted = done.length > 0 && done.every(member => typeof member.weight === 'number' && member.weight > 0);
    const weightOf = (member: Member): number => weighted ? member.weight! : 1;
    let total = 0;
    const mass = new Map<string, number>();
    let scoreSum = 0;
    for (const member of done) {
      const answer = answerFor(member, question)!, weight = weightOf(member);
      total += weight;
      if (question.type === 'noul') {
        const yes = clamp01(Number(answer.noul));
        mass.set('yes', (mass.get('yes') ?? 0) + weight * yes);
        mass.set('no', (mass.get('no') ?? 0) + weight * (1 - yes));
      } else {
        for (const option of question.options) mass.set(option.id, (mass.get(option.id) ?? 0) + weight * (Number(answer.probabilities?.[option.id]) || 0));
        if (question.type === 'score') scoreSum += weight * (Number(answer.score) || 0);
      }
    }
    if (!total) return { ...empty, weighted: weighted || done.length === 0 };
    const rows = question.options.map((option, index) => ({ id: option.id, label: option.label, index, share: (mass.get(option.id) ?? 0) / total }));
    const ranked = question.type === 'score' ? rows : [...rows].sort((a, b) => b.share - a.share || a.index - b.index);
    return { rows: ranked, evaluated: done.length, weighted, mean: question.type === 'score' ? scoreSum / total : question.type === 'noul' ? (mass.get('yes') ?? 0) / total : null, leader: question.type === 'score' ? null : ranked[0]?.id ?? null };
  }

  // ---- layout ------------------------------------------------------------------------------------------

  /**
   * Choose the largest tile that fits every group in width x height, packing groups left to right in rows.
   * Every group uses the same column count (as many as that shape needs), searched for the shortest total height.
   * When even the smallest tile does not fit, the map scrolls.
   */
  function fitLayout(counts: number[], width: number, height: number, options: { gap?: number; min?: number; max?: number; header?: number; padding?: number; groupGap?: number } = {}): { tile: number; columns: number[]; height: number; fits: boolean } {
    const gap = options.gap ?? 2, header = options.header ?? 20, pad = options.padding ?? 7, groupGap = options.groupGap ?? 8;
    const min = options.min ?? 8, max = options.max ?? 22;
    const safeWidth = Math.max(60, width);
    const widest = Math.max(1, ...counts);
    const attempt = (tile: number, shared: number): { columns: number[]; height: number } => {
      const cell = tile + gap;
      const columns = counts.map(count => Math.max(1, Math.min(count, shared)));
      let rowWidth = 0, rowHeight = 0, total = 0;
      counts.forEach((count, index) => {
        const w = columns[index]! * cell - gap + 2 * pad, h = header + Math.ceil(count / columns[index]!) * cell - gap + 2 * pad;
        if (rowWidth > 0 && rowWidth + groupGap + w > safeWidth) { total += rowHeight + groupGap; rowWidth = 0; rowHeight = 0; }
        rowWidth += (rowWidth > 0 ? groupGap : 0) + w;
        rowHeight = Math.max(rowHeight, h);
      });
      return { columns, height: total + rowHeight };
    };
    const best = (tile: number): { columns: number[]; height: number } => {
      const room = Math.max(1, Math.min(widest, Math.floor((safeWidth - 2 * pad + gap) / (tile + gap))));
      let winner = attempt(tile, 1);
      for (let shared = 1; shared <= room; shared += 1) { const candidate = attempt(tile, shared); if (candidate.height < winner.height) winner = candidate; }
      return winner;
    };
    if (!counts.length) return { tile: max, columns: [], height: 0, fits: true };
    for (let tile = max; tile >= min; tile -= 1) {
      const result = best(tile);
      if (result.height <= height) return { tile, columns: result.columns, height: result.height, fits: true };
    }
    const last = best(min);
    return { tile: min, columns: last.columns, height: last.height, fits: false };
  }

  /** Biggest tile worth drawing: a handful of members get large tiles with room for a progress ring. */
  function tileCap(total: number): number { return total <= 24 ? 64 : total <= 90 ? 44 : total <= 260 ? 30 : 22; }
  function tileFor(total: number, zoom: string): number { const cap = tileCap(total); return zoom === '2' ? Math.round(cap * (cap >= 44 ? 1.25 : 1.45)) : cap; }
  /** Two letters for the middle of a big tile. */
  function initials(label: string): string {
    const words = String(label || '?').split(/[\s/_-]+/).filter(word => /[\p{L}\p{N}]/u.test(word));
    const first = words[0]?.match(/[\p{L}\p{N}]/u)?.[0] ?? '?', last = words.length > 1 ? words[words.length - 1]!.match(/[\p{L}\p{N}]/u)?.[0] ?? '' : '';
    return (first + last).toUpperCase();
  }

  /** Columns for a fixed tile size (1:1 and large zoom): groups are wide so the map scrolls vertically. */
  function fixedLayout(counts: number[], width: number, tile: number, gap = 2, pad = 7): { tile: number; columns: number[] } {
    const cell = tile + gap, room = Math.max(1, Math.floor((Math.max(60, width) - 2 * pad + gap) / cell));
    return { tile, columns: counts.map(count => Math.max(1, Math.min(count, room, Math.ceil(Math.sqrt(count * 2.6))))) };
  }

  // ---- status strip ------------------------------------------------------------------------------------

  /** Evaluations per second over the trailing window, or null until two readings span enough time. */
  function rate(samples: { t: number; done: number }[], now: number, windowMs = 20000): number | null {
    const recent = samples.filter(sample => now - sample.t <= windowMs);
    if (recent.length < 2) return null;
    const first = recent[0]!, last = recent[recent.length - 1]!;
    const seconds = (last.t - first.t) / 1000;
    return seconds >= 1.5 ? Math.max(0, (last.done - first.done) / seconds) : null;
  }

  function secondsLeft(remaining: number, perSecond: number | null): number | null {
    return remaining <= 0 ? 0 : perSecond && perSecond > 0 ? remaining / perSecond : null;
  }

  function duration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return '—';
    if (seconds < 1) return 'under 1s';
    if (seconds < 90) return `${Math.round(seconds)}s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
    return `${Math.round(seconds / 3600 * 10) / 10} h`;
  }

  // ---- incremental updates -----------------------------------------------------------------------------

  /** Changes whenever anything a tile shows changes; answers are replaced, never edited, so identity is enough. */
  function signature(member: Member): string {
    return `${member.status}|${member.batch ? `${member.batch.phase}${member.batch.done}/${member.batch.total}` : ''}|${member.answers ? 'a' : ''}|${member.reason ? 'r' : ''}|${member.order ?? ''}`;
  }

  /** What to touch after a poll: only keys whose signature changed, plus keys that appeared or vanished. */
  function patchPlan(previous: Map<string, string>, members: Member[]): { added: string[]; changed: string[]; removed: string[] } {
    const added: string[] = [], changed: string[] = [], seen = new Set<string>();
    for (const member of members) {
      const key = memberKey(member), sig = signature(member);
      seen.add(key);
      const before = previous.get(key);
      if (before === undefined) added.push(key);
      else if (before !== sig) changed.push(key);
    }
    const removed = [...previous.keys()].filter(key => !seen.has(key));
    return { added, changed, removed };
  }

  /** Fold a `?since=` poll (only members that changed) into the members already known, in place of the same keys. */
  function mergeMembers(known: Member[], delta: Member[]): Member[] {
    if (!delta.length) return known;
    const index = new Map(known.map((member, position) => [memberKey(member), position]));
    const next = known.slice();
    for (const member of delta) {
      const position = index.get(memberKey(member));
      if (position === undefined) { index.set(memberKey(member), next.length); next.push(member); }
      else next[position] = member;
    }
    return next;
  }

  // ---- replay ------------------------------------------------------------------------------------------

  /** Finished members in the order they finished (saved order for runs recorded before that was kept). */
  function replayOrder(members: Member[]): Member[] {
    const finished = members.map((member, position) => ({ member, position })).filter(({ member }) => member.status === 'completed' || member.status === 'failed');
    return finished.sort((a, b) => (a.member.order ?? Number.MAX_SAFE_INTEGER) - (b.member.order ?? Number.MAX_SAFE_INTEGER) || a.position - b.position).map(({ member }) => member);
  }

  /**
   * The members as a replay shows them at `cursor` reveals: revealed ones as saved, the rest queued. A fractional
   * cursor shows the next member part-way through: running, and for a step read in batches with its layers
   * (map batches, then combine rounds, from the run record) filling in.
   */
  function replayMembers(members: Member[], cursor: number, batching?: { batches: number; reduceRounds: number }): Member[] {
    const order = replayOrder(members);
    const whole = Math.max(0, Math.min(order.length, Math.floor(cursor)));
    const fraction = Math.max(0, cursor - whole);
    const revealed = new Set(order.slice(0, whole).map(memberKey));
    const next = fraction > 0 && order[whole] ? order[whole] : undefined;
    const layers = batching ? batching.batches + batching.reduceRounds : 0;
    return members.map(member => {
      const key = memberKey(member);
      if (revealed.has(key) || member.status === 'queued') return member;
      const hidden: Member = { ...member, status: 'queued', answers: undefined, batch: undefined, reason: undefined, model: undefined, cacheHit: undefined };
      if (next && key === memberKey(next)) {
        const done = Math.min(layers, Math.floor(fraction * (layers + 1)));
        return { ...hidden, status: 'running', ...(layers ? { batch: { phase: done < (batching?.batches ?? 0) ? 'map' as const : 'combine' as const, done, total: layers } } : {}) };
      }
      return hidden;
    });
  }

  /** How many reveals per second a replay makes, so any size takes a watchable 4 to 40 seconds at 1x. */
  function replayRate(total: number, speed: number): number {
    const seconds = Math.max(4, Math.min(40, total * 0.35));
    return Math.max(0.5, total / seconds) * (speed || 1);
  }

  /** Whole steps a ticking replay advances; keeps the fraction so slow rates still move. */
  function replayAdvance(cursor: number, perSecond: number, elapsedMs: number, total: number): number {
    return Math.min(total, cursor + perSecond * elapsedMs / 1000);
  }

  return { PALETTE, GROUP_LIMIT, tileCap, tileFor, initials, memberKey, describeQuestions, answerFor, topPick, confidenceOf, tileVisual, optionColor, groupMembers, groupFields, leaderboard, fitLayout, fixedLayout, rate, secondsLeft, duration, signature, patchPlan, mergeMembers, replayOrder, replayMembers, replayRate, replayAdvance };
}

export const arenaModel = createArenaModel();
