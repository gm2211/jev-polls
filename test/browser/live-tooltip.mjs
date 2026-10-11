// Real-browser check for the live-view tile tooltip. Not part of `npm test`: it needs Playwright and a running workspace.
//   WORKSPACE_URL=http://127.0.0.1:4308 PROJECT_ID=... RUN_ID=... SHOTS=./shots node test/browser/live-tooltip.mjs
// Run it from a directory where `playwright` is installed (set PLAYWRIGHT_DIR to that directory if needed).
// RUN_ID must be a completed run with live members (a 1,000-person run works well). Exits non-zero on failure.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire((process.env.PLAYWRIGHT_DIR || process.cwd()) + '/');
const { chromium } = require('playwright');
const { WORKSPACE_URL = 'http://127.0.0.1:4308', PROJECT_ID, RUN_ID, SHOTS = './shots' } = process.env;
if (!PROJECT_ID || !RUN_ID) throw new Error('Set PROJECT_ID and RUN_ID.');
mkdirSync(SHOTS, { recursive: true });
const url = `${WORKSPACE_URL}/#project=${PROJECT_ID}&tab=runs&run=${RUN_ID}`;
const failures = [];
const tip = page => page.evaluate(() => {
  const t = document.querySelector('.lv-tip'), r = t.getBoundingClientRect();
  return { shown: !t.hidden && r.width > 0, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: t.textContent.slice(0, 40) };
});
const expect = (ok, message) => { console.log(ok ? 'ok  ' : 'FAIL', message); if (!ok) failures.push(message); };
const centre = (page, index) => page.evaluate(i => { const t = document.querySelectorAll('.lv-tile')[i].getBoundingClientRect(); return [t.x + t.width / 2, t.y + t.height / 2]; }, index);

const browser = await chromium.launch();
try {
  // 1. Completed run: hover, wait, click, move to empty canvas.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(url); await page.waitForSelector('.lv-tile');
  const c = await centre(page, 300);
  await page.mouse.move(...c); await page.waitForTimeout(800);
  const hovered = await tip(page);
  expect(hovered.shown && hovered.x > 0 && hovered.y > 0, `hover shows the tooltip near the tile (${hovered.x},${hovered.y})`);
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(300);
  expect((await tip(page)).shown === false, 'click hides the tooltip');
  await page.mouse.move(700, 880); await page.waitForTimeout(800);
  expect((await tip(page)).shown === false, 'moving to empty canvas leaves no tooltip');
  await page.click('[data-act=lv-zoom][data-value="2"]'); await page.waitForTimeout(600);
  const big = await centre(page, 0);
  await page.mouse.move(...big); await page.waitForTimeout(500);
  expect((await tip(page)).shown, 'hover shows the tooltip at the Large zoom');
  await page.mouse.wheel(0, 200); await page.waitForTimeout(300);
  expect((await tip(page)).shown === false, 'wheel scroll inside the map hides the tooltip');
  await page.close();

  // 2. Keyboard focus still shows the tooltip.
  const kb = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await kb.goto(url); await kb.waitForSelector('.lv-tile');
  await kb.focus('.lv-tile[tabindex="0"]'); await kb.keyboard.press('ArrowRight'); await kb.waitForTimeout(300);
  const focused = await tip(kb);
  expect(focused.shown && focused.x > 0 && focused.y > 0, 'keyboard arrow navigation shows the tooltip');
  await kb.evaluate(() => document.activeElement.blur()); await kb.waitForTimeout(200);
  expect((await tip(kb)).shown === false, 'blur hides the keyboard tooltip');
  await kb.close();

  // 3. Live run that completes while the pointer rests after a click: the rebuild must not resurrect the tooltip.
  const live = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let phase = 0;
  await live.route('**/api/workspace', async route => {
    const response = await route.fetch(), body = await response.json(), run = body.runs?.find(r => r.id === RUN_ID);
    if (run && phase < 2) {
      run.status = 'running'; run.message = 'Running'; const n = run.liveMembers.length, keep = Math.floor(n * (phase === 0 ? 0.5 : 0.8));
      run.liveMembers = run.liveMembers.map((m, i) => i < keep ? m : { ...m, status: 'queued', answers: undefined });
      run.progress = { stage: run.liveMembers[0].stage, completed: keep, total: n };
    }
    await route.fulfill({ response, json: body });
  });
  await live.goto(url); await live.waitForSelector('.lv-tile');
  const lc = await centre(live, 0);
  await live.mouse.move(...lc); await live.waitForTimeout(800);
  await live.screenshot({ path: `${SHOTS}/live-1-hover.png` });
  await live.mouse.down(); await live.mouse.up(); await live.waitForTimeout(300);
  await live.mouse.move(700, 880);
  await live.keyboard.press('Shift'); // after any key press Chrome treats scripted focus as focus-visible
  phase = 1; await live.waitForTimeout(6000);
  phase = 2; await live.waitForTimeout(6500);
  const mode = await live.evaluate(() => document.querySelector('.live-voting')?.dataset.mode);
  const done = await tip(live);
  await live.screenshot({ path: `${SHOTS}/live-2-completed.png` });
  expect(mode === 'done', `run reached the results view (mode ${mode})`);
  expect(done.shown === false, `no tooltip pinned after the run completes${done.shown ? ` (at ${done.x},${done.y}: ${done.text})` : ''}`);
  await live.mouse.move(...lc); await live.waitForTimeout(500);
  const again = await tip(live);
  expect(again.shown && again.x > 0 && again.y > 0, 'hovering after completion shows the tooltip again');
  await live.close();
} finally { await browser.close(); }
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
