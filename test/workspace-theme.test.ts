import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { THEME_INIT } from '../src/workspace-theme.js';
import { renderWorkspace } from '../src/workspace-ui.js';

function browser(saved: string | null = null, blocked = false) {
  const root = { dataset: {} as Record<string, string> };
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Function>();
  const label = { textContent: '' };
  let mounted = false;
  const button = { setAttribute: (key: string, value: string) => attrs.set(key, value), addEventListener: (name: string, fn: Function) => listeners.set(name, fn) };
  new Script(THEME_INIT).runInNewContext({
    document: { documentElement: root, getElementById: (id: string) => !mounted ? null : id === 'themeToggle' ? button : label, addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    localStorage: { getItem: () => { if (blocked) throw Error('blocked'); return saved; }, setItem: (_: string, value: string) => { if (blocked) throw Error('blocked'); saved = value; } },
  });
  return { root, attrs, label, saved: () => saved, mount() { mounted = true; listeners.get('DOMContentLoaded')!(); }, click() { listeners.get('click')!(); }, storage(value: string | null) { listeners.get('storage')!({ key: 'jev-workspace-theme', newValue: value }); } };
}

test('theme restores before paint, toggles accessibly, and persists across reload', () => {
  const first = browser('sepia');
  assert.equal(first.root.dataset.theme, 'sepia');
  first.mount();
  assert.equal(first.attrs.get('aria-checked'), 'true');
  assert.equal(first.label.textContent, 'Sepia');
  first.click();
  assert.equal(first.root.dataset.theme, 'light');
  assert.equal(first.attrs.get('aria-checked'), 'false');
  assert.equal(first.saved(), 'light');
  first.click();
  const reload = browser(first.saved()); reload.mount();
  assert.equal(reload.root.dataset.theme, 'sepia');
  reload.storage('light');
  assert.equal(reload.attrs.get('aria-checked'), 'false');
});

test('invalid preferences and blocked storage leave the switch usable', () => {
  for (const value of [null, 'invalid']) {
    const page = browser(value, true); page.mount();
    assert.equal(page.root.dataset.theme, 'light');
    assert.doesNotThrow(() => page.click());
    assert.equal(page.root.dataset.theme, 'sepia');
  }
  assert.equal(browser('invalid').root.dataset.theme, 'light');
});

test('theme bootstrap is nonce-protected and precedes stylesheet and body', () => {
  const html = renderWorkspace('safe-nonce', 'token');
  const start = html.indexOf('<script nonce="safe-nonce" data-theme-init>');
  assert.ok(start > 0 && start < html.indexOf('<style') && start < html.indexOf('<body>'));
  assert.match(html, /id="themeToggle"[^>]+role="switch"[^>]+aria-label="Dark sepia mode"/);
});
