/**
 * QA diagnostic — dialog geometry at SMALL window (700x500 CSS viewport).
 *
 * The embedded driver maps setWindowSize to PHYSICAL pixels (dpr=2 on this
 * Retina display), so CSS viewport 700x500 requires setWindowSize(1400,1000).
 * Every key dialog must stay centered and inside the viewport at this size.
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

const SHOTS = './test-results/dialog-geometry';
mkdirSync(SHOTS, { recursive: true });

/** Physical -> CSS (this machine's devicePixelRatio is 2). */
async function resizeCss(w: number, h: number) {
  await browser.setWindowSize(w * 2, h * 2);
  await browser.pause(700);
  const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  console.log(`RESIZE_CSS target=(${w}x${h}) actual=${JSON.stringify(vp)}`);
  return vp as { w: number; h: number };
}

interface Verdict {
  label: string;
  rect: { left: number; top: number; width: number; height: number };
  viewport: { vw: number; vh: number };
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

async function measure(): Promise<{ vw: number; vh: number; dialogs: unknown[] }> {
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
  }) as unknown as { vw: number; vh: number; dialogs: unknown[] };
}

function judge(label: string, m: { vw: number; vh: number; dialogs: unknown[] }): Verdict {
  const d = (m.dialogs as Array<{ left: number; top: number; width: number; height: number }>)[0];
  if (!d) {
    const fail: Verdict = {
      label, rect: { left: NaN, top: NaN, width: NaN, height: NaN },
      viewport: { vw: m.vw, vh: m.vh }, delta: { x: NaN, y: NaN },
      centered: false, within: false, notStretched: false, reason: 'NO_DIALOG_FOUND', pass: false,
    };
    console.log(`DIALOG_RECT ${label} => ${JSON.stringify(fail)}`);
    return fail;
  }
  const cx = (m.vw - d.width) / 2;
  const cy = (m.vh - d.height) / 2;
  const dx = Math.abs(d.left - cx);
  const dy = Math.abs(d.top - cy);
  const centered = dx <= 2 && dy <= 2;
  const within = d.left >= -1 && d.top >= -1 && d.left + d.width <= m.vw + 1 && d.top + d.height <= m.vh + 1;
  const notStretched = d.height <= m.vh * 0.98;
  const reasons: string[] = [];
  if (!centered) reasons.push(`not centered (dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)})`);
  if (!within) reasons.push('overflowing viewport');
  if (!notStretched) reasons.push('height ~ viewport height (stretched)');
  const v: Verdict = {
    label, rect: { left: d.left, top: d.top, width: d.width, height: d.height },
    viewport: { vw: m.vw, vh: m.vh }, delta: { x: Math.round(dx * 10) / 10, y: Math.round(dy * 10) / 10 },
    centered, within, notStretched, reason: reasons.join('; ') || 'OK',
    pass: centered && within && notStretched,
  };
  console.log(`DIALOG_RECT ${label} => ${JSON.stringify(v)}`);
  return v;
}

async function measureAndShot(label: string, shot: string): Promise<Verdict> {
  await browser.pause(500);
  const v = judge(label, await measure());
  await browser.saveScreenshot(`${SHOTS}/${shot}.png`);
  return v;
}

async function closeDialog(): Promise<void> {
  try { await browser.keys(['Escape']); } catch { /* ignore */ }
  await browser.pause(400);
  const stillOpen = await $('[role="dialog"], [role="alertdialog"]').isExisting();
  if (!stillOpen) return;
  const x = await $('[role="dialog"] button:has(svg.lucide-x), [role="alertdialog"] button:has(svg.lucide-x)');
  if (await x.isExisting()) { await x.click(); }
  else {
    const cancel = await $('[role="dialog"] button=取消, [role="alertdialog"] button=取消');
    if (await cancel.isExisting()) await cancel.click();
  }
  await browser.pause(300);
}

const RESULTS: Verdict[] = [];

describe('Dialog geometry — small window 700x500', () => {
  before(async () => {
    await switchMain();
    await unlockApp(`E2E_${Date.now()}`, '[data-testid="toolbox-nav-postgres"]');
    await resizeCss(700, 500);
  });

  it('1. save-to-notes (700x500)', async function () {
    this.timeout(120_000);
    await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await waitForVisible('[data-testid="postgres-connection-dialog"]');
    const inputs = await dialog.$$('input');
    for (const input of inputs) await input.clearValue();
    await inputs[0].setValue(`SmallWin ${Date.now()}`);
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
    await browser.execute((value: string) => {
      const content = document.querySelector('.cm-content') as HTMLElement | null;
      content?.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, value);
    }, 'SELECT 9090');
    await $('[data-testid="postgres-save-to-notes"]').click();
    await waitForVisible('[data-testid="postgres-save-note-confirm"]');
    const v = await measureAndShot('save-to-notes-700x500', 's1-save-to-notes');
    RESULTS.push(v);
    await closeDialog();
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('2. postgres-connection-dialog (700x500)', async function () {
    this.timeout(90_000);
    await $('[data-testid="postgres-new-connection"]').click();
    await waitForVisible('[data-testid="postgres-connection-dialog"]');
    const v = await measureAndShot('postgres-connection-dialog-700x500', 's2-connection');
    RESULTS.push(v);
    await closeDialog();
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('3. Filter & Sort (700x500)', async function () {
    this.timeout(150_000);
    const tablesGroup = await $('[data-node-id*="/group:tables"]');
    if (!(await $('button=users').isExisting())) {
      await tablesGroup.click();
    }
    await waitForVisible('button=users', 15_000);
    await browser.execute((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }, await $('button=users'));
    await $('[data-testid="postgres-workspace"] tbody tr').waitForDisplayed({ timeout: 15000 });
    const filterBtn = await $('[data-testid="postgres-filter"]');
    await filterBtn.waitForDisplayed({ timeout: 10_000 });
    await filterBtn.click();
    await waitForVisible('[role="dialog"]');
    const v = await measureAndShot('filter-sort-700x500', 's3-filter-sort');
    RESULTS.push(v);
    await closeDialog();
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('4. notes delete confirm (700x500)', async function () {
    this.timeout(90_000);
    await (await waitForVisible('[data-testid="toolbox-nav-notes"]')).click();
    await browser.pause(300);
    const newBtn = await $('button=新建笔记');
    if (await newBtn.isExisting()) await newBtn.click();
    await browser.pause(500);
    const delBtn = await $('button:has(svg.lucide-trash-2)');
    await delBtn.waitForExist({ timeout: 10_000 });
    await browser.execute((node: HTMLElement) => node.click(), delBtn);
    await waitForVisible('[role="alertdialog"]');
    const v = await measureAndShot('notes-delete-700x500', 's4-notes-delete');
    RESULTS.push(v);
    await closeDialog();
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('5. settings (700x500)', async function () {
    this.timeout(90_000);
    let settingsBtn = await $('button:has(svg.lucide-settings)');
    if (!(await settingsBtn.isExisting())) {
      await browser.keys(['Command', ',']);
      await browser.pause(500);
      settingsBtn = await $('button:has(svg.lucide-settings)');
    }
    if (await settingsBtn.isExisting()) await settingsBtn.click();
    await waitForVisible('[role="dialog"]');
    const v = await measureAndShot('settings-700x500', 's5-settings');
    RESULTS.push(v);
    await closeDialog();
    console.log(`VERDICT ${v.label}: ${v.pass ? 'PASS' : 'FAIL'} (${v.reason})`);
    expect(v.pass).toBe(true);
  });

  it('6. summary', async function () {
    console.log('SMALL_WINDOW_SUMMARY=' + JSON.stringify(RESULTS, null, 2));
    expect(RESULTS.length).toBe(5);
  });
});
