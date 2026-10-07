import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { THEME_INIT, WORKSPACE_PALETTES } from '../src/workspace-theme.js';
import { renderWorkspace } from '../src/workspace-ui.js';

function browser(saved: string | null = null, blocked = false, writeBlocked = false) {
  const storage = new Map([['jev-workspace-theme', saved], ['jev-workspace-draft', 'unsaved research draft']]);
  const root = { dataset: {} as Record<string, string> };
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Function>();
  const label = { textContent: '' };
  let mounted = false;
  const button = { setAttribute: (key: string, value: string) => attrs.set(key, value), addEventListener: (name: string, fn: Function) => listeners.set(name, fn) };
  new Script(THEME_INIT).runInNewContext({
    document: { documentElement: root, getElementById: (id: string) => !mounted ? null : id === 'themeToggle' ? button : label, addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    localStorage: { getItem: (key: string) => { if (blocked) throw Error('blocked'); return storage.get(key); }, setItem: (key: string, value: string) => { if (blocked || writeBlocked) throw Error('blocked'); storage.set(key, value); } },
  });
  return { root, attrs, label, saved: () => storage.get('jev-workspace-theme'), draft: () => storage.get('jev-workspace-draft'), mount() { mounted = true; listeners.get('DOMContentLoaded')!(); }, click() { listeners.get('click')!(); }, storage(value: string | null, key: string | null = 'jev-workspace-theme') { listeners.get('storage')!({ key, newValue: value }); } };
}

test('legacy sepia migrates before paint, toggles accessibly, and preserves research drafts', () => {
  const first = browser('sepia');
  assert.equal(first.root.dataset.theme, 'dark');
  assert.equal(first.saved(), 'dark');
  assert.equal(first.draft(), 'unsaved research draft');
  first.mount();
  assert.equal(first.attrs.get('aria-checked'), 'true');
  assert.equal(first.label.textContent, 'Dark');
  first.click();
  assert.equal(first.root.dataset.theme, 'light');
  assert.equal(first.attrs.get('aria-checked'), 'false');
  assert.equal(first.saved(), 'light');
  first.click();
  const reload = browser(first.saved()); reload.mount();
  assert.equal(reload.root.dataset.theme, 'dark');
  assert.equal(first.draft(), 'unsaved research draft');
  reload.storage('light');
  assert.equal(reload.attrs.get('aria-checked'), 'false');
  reload.storage('sepia');
  assert.equal(reload.root.dataset.theme, 'dark');
  reload.storage('light', 'jev-workspace-draft');
  assert.equal(reload.root.dataset.theme, 'dark');
  reload.storage(null, null);
  assert.equal(reload.root.dataset.theme, 'light');
});

test('invalid preferences and blocked storage leave the switch usable', () => {
  for (const value of [null, 'invalid']) {
    const page = browser(value, true); page.mount();
    assert.equal(page.root.dataset.theme, 'light');
    assert.doesNotThrow(() => page.click());
    assert.equal(page.root.dataset.theme, 'dark');
  }
  assert.equal(browser('invalid').root.dataset.theme, 'light');
  const readOnly = browser('sepia', false, true); readOnly.mount();
  assert.equal(readOnly.root.dataset.theme, 'dark');
  assert.equal(readOnly.saved(), 'sepia');
  assert.doesNotThrow(() => readOnly.click());
  assert.equal(readOnly.root.dataset.theme, 'light');
});

test('theme bootstrap is nonce-protected and precedes stylesheet and body', () => {
  const html = renderWorkspace('safe-nonce', 'token');
  const start = html.indexOf('<script nonce="safe-nonce" data-theme-init>');
  assert.ok(start > 0 && start < html.indexOf('<style') && start < html.indexOf('<body>'));
  assert.match(html, /id="themeToggle"[^>]+role="switch"[^>]+aria-label="Dark mode"/);
});

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('both theme palettes keep normal, muted, placeholder, and disabled text readable', () => {
  for (const [theme, palette] of Object.entries(WORKSPACE_PALETTES)) {
    for (const text of ['ink', 'muted', 'faint'] as const) {
      for (const surface of ['paper', 'surface', 'raised', 'field', 'hover'] as const) {
        assert.ok(contrast(palette[text], palette[surface]) >= 4.5, `${theme} ${text} on ${surface} needs 4.5:1`);
      }
    }
    for (const accent of ['blue', 'teal', 'amber'] as const) {
      assert.ok(contrast(palette[accent], palette[`${accent}-soft`]) >= 4.5, `${theme} ${accent} status text needs 4.5:1`);
    }
    assert.ok(contrast(palette['button-ink'], palette.blue) >= 4.5, `${theme} primary and selected controls need 4.5:1`);
    assert.ok(contrast(palette['disabled-ink'], palette.raised) >= 4.5, `${theme} disabled controls need 4.5:1`);
  }
});

test('both theme palettes distinguish control boundaries and focus from nearby surfaces', () => {
  for (const [theme, palette] of Object.entries(WORKSPACE_PALETTES)) {
    for (const indicator of ['control-line', 'focus'] as const) {
      for (const surface of ['paper', 'surface', 'raised', 'field', 'hover'] as const) {
        assert.ok(contrast(palette[indicator], palette[surface]) >= 3, `${theme} ${indicator} against ${surface} needs 3:1`);
      }
    }
  }
});
