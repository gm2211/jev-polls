import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { MODAL_DISMISS_CLIENT } from '../src/modal-dismiss-ui.js';
import { WORKSPACE_SELECTION_CSS } from '../src/text-selection.js';
import { THEME_CSS } from '../src/workspace-theme.js';

function harness(busy = false) {
  const listeners = new Map<string, Function>();
  const calls: string[] = [];
  const rect = { left: 400, right: 800, top: 200, bottom: 600 };
  const fields: Record<string, { value: string }> = {};
  const dialog = (id: string, closeAct: string | null) => ({ id, tagName: 'DIALOG', open: true, getBoundingClientRect: () => rect,
    querySelector(selector: string) { if (selector === '[data-act$="-close"]') return closeAct ? { click: () => calls.push('click:' + closeAct) } : null; return fields[selector] ?? null; },
    close: () => calls.push('close:' + id) });
  const backdrop = { classList: { contains: (name: string) => name === 'command-backdrop' } };
  const context: any = { commandState: { busy }, answerListDraft: null, commandClose: () => calls.push('command-close'), say: (m: string) => calls.push('say:' + m), fail: (e: Error) => calls.push('error:' + e.message),
    document: { addEventListener: (type: string, fn: Function) => listeners.set(type, fn) } };
  new Script(MODAL_DISMISS_CLIENT).runInNewContext(context);
  const press = (target: unknown, x: number, y: number, upTarget = target) => {
    let prevented = false;
    listeners.get('pointerdown')!({ button: 0, target, clientX: x, clientY: y });
    listeners.get('click')!({ target: upTarget, clientX: x, clientY: y, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    return prevented;
  };
  return { calls, dialog, backdrop, press, fields, context };
}

test('a click on a dialog backdrop runs that dialog’s own close action', () => {
  const h = harness(), d = h.dialog('deleteStepDialog', 'step-delete-close');
  assert.equal(h.press(d, 20, 20), true);
  assert.deepEqual(h.calls, ['click:step-delete-close']);
});

test('a click inside a dialog, or a drag that ends outside it, leaves it open', () => {
  const h = harness(), d = h.dialog('dataToolsDialog', 'data-close');
  h.press(d, 500, 300);
  h.press({ classList: { contains: () => false } }, 500, 300, d);
  assert.deepEqual(h.calls, []);
});

test('dialogs holding typed text stay open and say how to discard it', () => {
  const h = harness(), d = h.dialog('importDialog', 'import-close');
  h.fields['#importJson'] = { value: '{"version":1}' };
  h.press(d, 20, 20);
  assert.deepEqual(h.calls, ['say:Your text is still here. Close the dialog to discard it.']);
  h.fields['#importJson'].value = '  ';
  h.calls.length = 0; h.press(d, 20, 20);
  assert.deepEqual(h.calls, ['click:import-close']);
});

test('the command palette closes on its backdrop unless an AI request is running', () => {
  const idle = harness(); idle.press(idle.backdrop, 10, 10);
  assert.deepEqual(idle.calls, ['command-close']);
  const busy = harness(true); busy.press(busy.backdrop, 10, 10);
  assert.deepEqual(busy.calls, ['say:Jev is still working on your request. Press Esc to stop it.']);
});

test('workspace chrome is unselectable while produced content and fields stay selectable', () => {
  assert.match(WORKSPACE_SELECTION_CSS, /body,dialog\{ -webkit-user-select:none;user-select:none \}/);
  for (const content of ['.persona-story', '.source-line', '.lv-answers', '.proposal-explanation', '.command-status', '[role=alert]']) assert.ok(WORKSPACE_SELECTION_CSS.includes(content), content);
  assert.ok(THEME_CSS.includes(WORKSPACE_SELECTION_CSS));
  assert.match(THEME_CSS, /input,textarea,\[contenteditable\]:not\(\[contenteditable=false\]\)\{ -webkit-user-select:text;user-select:text \}/);
});
