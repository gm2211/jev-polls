/**
 * Readable persona attributes. Keep this factory self-contained: the workspace and the report serialize
 * `createAttributeFormat.toString()` into their inline client scripts, and the unit tests call it directly.
 * A list of records becomes a compact table, a single record becomes label/value rows, and keys become plain words.
 */
export function createAttributeFormat() {
  const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const CURRENCIES: Record<string, string> = { usd: '$', eur: '€', gbp: '£' };
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

  /** Words of a key: camelCase, acronyms, digits, snake, kebab and dotted paths all split. */
  function words(key: string): string[] {
    return String(key).replace(/^attributes\./, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
      .split(/[\s_.\-]+/).filter(Boolean);
  }
  /** "Top10Games" → "Top 10 games", "costUsd" → "Cost (USD)", "NPSScore" → "NPS score". */
  function label(key: string): string {
    const parts = words(key);
    if (!parts.length) return String(key);
    const shouting = !/[a-z]/.test(String(key));
    const unit = parts.length > 1 ? CURRENCIES[parts[parts.length - 1].toLowerCase()] : undefined;
    const body = (unit ? parts.slice(0, -1) : parts).map((word, i) => {
      const keep = !shouting && word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
      const lower = keep ? word : word.toLowerCase();
      return i === 0 && !keep ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    }).join(' ');
    return unit ? `${body} (${parts[parts.length - 1].toUpperCase()})` : body;
  }
  function currencyOf(key: string): string | undefined {
    const parts = words(key).map(word => word.toLowerCase());
    return parts.length > 1 ? CURRENCIES[parts[parts.length - 1]] : undefined;
  }
  /** A scalar as plain text; money keys read as $5 or Free. */
  function scalar(value: unknown, key = ''): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number' && Number.isFinite(value)) {
      const symbol = currencyOf(key);
      if (symbol) return value === 0 && /cost|price|fee/i.test(key) ? 'Free' : symbol + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return String(value);
  }
  /** Plain-text form for tooltips, sorting and narrow summaries. */
  function text(value: unknown, key = ''): string {
    if (Array.isArray(value)) return value.length ? value.map(item => text(item, key)).join(isRecord(value[0]) ? '; ' : ', ') : '—';
    if (isRecord(value)) {
      const entries = Object.entries(value);
      return entries.length ? entries.map(([k, v]) => `${label(k)}: ${text(v, k)}`).join(' · ') : '—';
    }
    return scalar(value, key);
  }
  function table(rows: Record<string, unknown>[]): string {
    const columns: string[] = [];
    rows.forEach(row => Object.keys(row).forEach(k => { if (!columns.includes(k)) columns.push(k); }));
    const numeric = new Set(columns.filter(k => rows.every(row => row[k] === undefined || row[k] === null || typeof row[k] === 'number')));
    const cell = (k: string, tag: string, body: string): string => `<${tag}${numeric.has(k) ? ' class="num"' : ''}>${body}</${tag}>`;
    return `<div class="attr-table-wrap"><table class="attr-table"><thead><tr>${columns.map(k => cell(k, 'th', esc(label(k)))).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(k => cell(k, 'td', esc(text(row[k], k)))).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  /** Escaped markup for one attribute value. */
  function html(value: unknown, key = ''): string {
    if (Array.isArray(value)) {
      if (value.length && value.every(isRecord)) return table(value as Record<string, unknown>[]);
      if (value.some(item => item !== null && typeof item === 'object')) return `<ul class="attr-list">${value.map(item => `<li>${html(item, key)}</li>`).join('')}</ul>`;
      return esc(text(value, key));
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      return entries.length ? `<dl class="attr-record">${entries.map(([k, v]) => `<div><dt>${esc(label(k))}</dt><dd>${html(v, k)}</dd></div>`).join('')}</dl>` : '—';
    }
    return esc(scalar(value, key));
  }
  /** Values that need a full row: tables and nested records. */
  const wide = (value: unknown): boolean => (Array.isArray(value) && value.some(item => item !== null && typeof item === 'object')) || isRecord(value);
  return { label, text, html, wide };
}

/** Shared look for attribute tables and records; uses only tokens both the workspace and the report define. */
export const ATTRIBUTE_FORMAT_CSS = `
.attr-table-wrap{max-width:100%;overflow-x:auto;margin-top:2px}
.attr-table{border-collapse:collapse;font-size:var(--text-sm);line-height:1.35;min-width:100%;text-transform:none;letter-spacing:0}
.attr-table th{font-weight:600;font-size:var(--text-xs);color:var(--muted);text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid var(--line);white-space:nowrap;text-transform:none;letter-spacing:0}
.attr-table td{padding:5px 10px 5px 0;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:normal}
.attr-table tr:last-child td{border-bottom:0}
.attr-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.attr-table th:last-child,.attr-table td:last-child{padding-right:0}
dl.attr-record{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 12px;margin:0}
dl.attr-record>div{display:contents}
dl.attr-record dt{color:var(--muted);font-size:var(--text-sm);text-transform:none;letter-spacing:0;font-weight:400}
dl.attr-record dd{margin:0;overflow-wrap:anywhere}
.attr-list{margin:0;padding-left:18px}
dd.attr-wide{grid-column:1/-1}
`;

/** Defines `personaAttrs` in an inline client script. */
export const PERSONA_ATTRIBUTES_CLIENT = `const personaAttrs=(()=>{const __name=value=>value;return (${createAttributeFormat.toString()})()})();`;
