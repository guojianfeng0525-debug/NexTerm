/**
 * QA diagnostic — real-app dialog geometry verification (B20 regression suite).
 *
 * Measures every key dialog's getBoundingClientRect in the real Tauri app and
 * judges horizontal/vertical centering (|delta| <= 2px), height not stretched
 * to the full viewport, and in-viewport containment — at 1600x1000 AND a small
 * 700x500 window.
 *
 * Temporary diagnostic spec (not part of the shipped suite; delete after use).
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

const SHOTS = './test-results/dialog-geometry';
mkdirSync(SHOTS, { recursive: true });

const TOLERANCE = 2;

interface DialogRect {
  slot: string | null;
  testid: string | null;
  left: number;
  top: number;
  width: number;
  height: number;
}
interface MeasureResult {
  vw: number;
  vh: number;
  dialogs: DialogRect[];
}
interface Verdict {
  label: string;
  rect: { left: number; top: number; width: number; height: number };
  viewport: { vw: number; vh: number };
  expectedCenter: { x: number; y: number };
  delta: { x: number; y: number };
  centered: boolean;
  within: boolean;
  notStretched: boolean;
  reason: string;
  pass: boolean;
}

async function switchMain() {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await browser.tauri.switchWindow('main');
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await browser.pause(3000);
    }
  }
}

async function setWindow(w: number, h: number) {
  try {
    await browser.setWindowRect({ x: 0, y: 0, width: w, height: h });
    await browser.setWindowSize(w, h);
  } catch {
    /* best effort */
  }
  await browser.pause(300);
}

async function setSql(sql: string) {
  await browser.execute((value: string) => {
    const content = document.querySelector('.cm-content') as HTMLElement | null;
    content?.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, value);
  }, sql);
}

async function measureAll(): Promise<MeasureResult> {
  return browser.execute(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dialogs: unknown[] = [];
    document.querySelectorAll('[role="dialog"], [role="alertdialog"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      dialogs.push({
        slot: el.getAttribute('data-slot'),
        testid: el.getAttribute('data-testid'),
        left: Math.round(r.left * 10) / 10,
        top: Math.round(r.top * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
      });
    });
    return { vw, vh, dialogs };
  }) as unknown as MeasureResult;
}

function judge(label: string, m: MeasureResult): Verdict {
  const d = m.dialogs[0];
  if (!d) {
    const v: Verdict = {
      label,
      rect: { left: NaN, top: NaN, width: NaN, height: NaN },
      viewport: { vw: m.vw, vh: m.vh },
      expectedCenter: { x: NaN, y: NaN },
      delta: { x: NaN, y: NaN },
      centered: false,
      within: false,
      notStretched: false,
      reason: 'NO_DIALOG_FOUND',
      pass: false,
    };
    console.log(`DIALOG_RECT ${label} => ${JSON.stringify(v)}`);
    return v;
  }
  const cx = (m.vw - d.width) / 2;
  const cy = (m.vh - d.height) / 2;
  const dx = Math.abs(d.left - cx);
  const dy = Math.abs(d.top - cy);
  const centered = dx <= TOLERANCE && dy <= TOLERANCE;
  const within =
    d.left >= -1 && d.top >= -1 && d.left + d.width <= m.vw + 1 && d.top + d.height <= m.vh + 1;
  // "not stretched": height must be clearly below the viewport height. A fixed
  // full-screen-height dialog (the old !inset-0 bug) would have h == vh.
  const notStretched = d.height <= m.vh * 0.98;
  const reasons: string[] = [];
  if (!centered) reasons.push(`not centered (dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)})`);
  if (!within) reasons.push('overflowing viewport');
  if (!notStretched) reasons.push(`height=${d.height} ~ viewport height=${m.vh} (stretched)`);
  const v: Verdict = {
    label,
    rect: { left: d.left, top: d.top, width: d.width, height: d.height },
    viewport: { vw: m.vw, vh: m.vh },
    expectedCenter: { x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10 },
    delta: { x: Math.round(dx * 10) / 10, y: Math.round(dy * 10) / 10 },
    centered,
    within,
    notStretched,
    reason: reasons.join('; ') || 'OK',
    pass: centered && within && notStretched,
  };
  console.log(`DIALOG_RECT ${label} => ${JSON.stringify(v)}`);
  return v;
}

async function measureAndShot(label: string, shot: string): Promise<Verdict> {
  await browser.pause(500); // let the Radix open animation settle
  const v = judge(label, await measureAll());
  await browser.saveScreenshot(`${SHOTS}/${shot}.png`);
  return v;
}

/** Escape, falling back to the dialog X / footer cancel button. */
async function closeDialog(): Promise<void> {
  try {
    await browser.keys(['Escape']);
  } catch {
    /* ignore */
  }
  await browser.pause(400);
  const stillOpen = await $('[role="dialog"], [role="alertdialog"]').isExisting();
  if (!stillOpen) return;
  const x = await $('[role="dialog"] [data-slot="dialog-close"], [role="alertdialog"] button:has(svg.lucide-x), [role="dialog"] button:has(svg.lucide-x)');
  if (await x.isExisting()) {
    await x.click();
  } else {
    const cancel = await $('[role="dialog"] button=取消, [role="alertdialog"] button=取消');
    if (await cancel.isExisting()) await cancel.click();
  }
  await browser.pause(300);
}

async function connectPostgres(name: string) {
  const postgresNav = await waitForVisible('[data-testid="toolbox-nav-postgres"]');
  await postgresNav.click();
  if (await $('[data-testid="postgres-disconnect"]').isExisting()) return;
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await waitForVisible('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue(name);
  await inputs[1].setValue('127.0.0.1');
  await browser.execute((input: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '55432');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, inputs[2]);
  await inputs[3].setValue('nexterm_e2e');
  await inputs[4].setValue('nexterm_e2e');
  await inputs[5].setValue('nexterm_e2e');
  await dialog.$('button=连接').click();
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
}

async function openUsersTable() {
  const tablesGroup = await $('[data-node-id*="/group:tables"]');
  if (!(await $('button=users').isExisting())) {
    await tablesGroup.click();
  }
  await waitForVisible('button=users', 15_000);
  await browser.execute((node: HTMLElement) => {
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, await $('button=users'));
  await $('[data-testid="postgres-workspace"] tbody tr').waitForDisplayed({ timeout: 15000 });
}

const RESULTS: Verdict[] = [];
const PASSWORD = `E2E_${Date.now()}`;
const CONN_NAME = `DiagGeom ${Date.now()}`;

describe('Dialog geometry (diagnostic)', () => {
  before(async () => {
    await switchMain();
    await setWindow(1600, 1000);
    await unlockApp(PASSWORD, '[data-testid="toolbox-nav-postgres"]');
  });

  it('1. 保存到记事本 save-to-notes (1600x1000)', async function () {
    this.timeout(150_000);
    await connectPostgres(CONN_NAME);
    await setSql('SELECT 9090');
    await $('[data-testid="postgres-save-to-notes"]').click();
    await waitForVisible('[data-testid="postgres-save-note-confirm"]');
    const v = await measureAndShot('save-to-notes', '1-save-to-notes');
    RESULTS.push(v);
    await closeDialog();
    // eslint-disable-next-line no-console
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('2. 连接对话框 postgres-connection-dialog (1600x1000)', async function () {
    this.timeout(90_000);
    await $('[data-testid="postgres-new-connection"]').click();
    await waitForVisible('[data-testid="postgres-connection-dialog"]');
    const v = await measureAndShot('postgres-connection-dialog', '2-postgres-connection-dialog');
    RESULTS.push(v);
    await closeDialog();
    // eslint-disable-next-line no-console
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('3. 小窗口 700x500: save-to-notes + connection + settings', async function () {
    this.timeout(150_000);
    await setWindow(700, 500);

    // save-to-notes (still on the query page after test 2; retry in case the
    // view is momentarily busy)
    await browser.pause(400);
    const saveBtn = await $('[data-testid="postgres-save-to-notes"]');
    await saveBtn.waitForExist({ timeout: 10_000 });
    await saveBtn.click();
    await waitForVisible('[data-testid="postgres-save-note-confirm"]');
    const v1 = await measureAndShot('save-to-notes-small', '3a-save-to-notes-700x500');
    RESULTS.push(v1);
    await closeDialog();

    // connection dialog
    await $('[data-testid="postgres-new-connection"]').click();
    await waitForVisible('[data-testid="postgres-connection-dialog"]');
    const v2 = await measureAndShot('postgres-connection-dialog-small', '3b-connection-700x500');
    RESULTS.push(v2);
    await closeDialog();

    // settings
    const settingsBtn = await $('button:has(svg.lucide-settings)');
    await settingsBtn.waitForExist({ timeout: 10_000 });
    await settingsBtn.click();
    await waitForVisible('[role="dialog"]');
    const v3 = await measureAndShot('settings-dialog-small', '3c-settings-700x500');
    RESULTS.push(v3);
    await closeDialog();

    await setWindow(1600, 1000);
    // eslint-disable-next-line no-console
    console.log(`VERDICT small-window: ${[v1, v2, v3].map((v) => `${v.label}=${v.pass ? 'PASS' : 'FAIL'}`).join(' | ')}`);
    for (const v of [v1, v2, v3]) {
      // eslint-disable-next-line no-console
      console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
      expect(v.pass).toBe(true);
    }
  });

  it('4. Filter & Sort 对话框 (1600x1000)', async function () {
    this.timeout(150_000);
    await openUsersTable();
    const filterBtn = await $('[data-testid="postgres-filter"]');
    await filterBtn.waitForDisplayed({ timeout: 10_000 });
    await filterBtn.click();
    await waitForVisible('[role="dialog"]');
    const v = await measureAndShot('filter-sort-dialog', '4-filter-sort');
    RESULTS.push(v);
    await closeDialog();
    // eslint-disable-next-line no-console
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('5. 删除笔记确认 AlertDialog (1600x1000)', async function () {
    this.timeout(90_000);
    await (await waitForVisible('[data-testid="toolbox-nav-notes"]')).click();
    await browser.pause(300);
    const newBtn = await $('button=新建笔记');
    if (await newBtn.isExisting()) await newBtn.click();
    else {
      // header button might read differently; fall back to first visible
      const anyNew = await $('button:has(svg.lucide-plus)');
      if (await anyNew.isExisting()) await anyNew.click();
    }
    await browser.pause(500);
    const delBtn = await $('[role="main"] button:has(svg.lucide-trash-2), button:has(svg.lucide-trash-2)');
    await delBtn.waitForExist({ timeout: 10_000 });
    await browser.execute((node: HTMLElement) => node.click(), delBtn);
    await waitForVisible('[role="alertdialog"]');
    const v = await measureAndShot('notes-delete-confirm', '5-notes-delete-confirm');
    RESULTS.push(v);
    await closeDialog();
    // eslint-disable-next-line no-console
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('6. 设置 Settings (1600x1000)', async function () {
    this.timeout(90_000);
    const settingsBtn = await $('button:has(svg.lucide-settings)');
    await settingsBtn.waitForExist({ timeout: 10_000 });
    await settingsBtn.click();
    await waitForVisible('[role="dialog"]');
    const v = await measureAndShot('settings-dialog', '6-settings');
    RESULTS.push(v);
    await closeDialog();
    // eslint-disable-next-line no-console
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('7. 汇总 summary', async function () {
    // eslint-disable-next-line no-console
    console.log('DIALOG_GEOMETRY_SUMMARY=' + JSON.stringify(RESULTS, null, 2));
    expect(RESULTS.length).toBe(8);
  });
});
