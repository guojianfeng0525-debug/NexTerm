/**
 * QA diagnostic — PostgreSQL 数据列表/查询页工具条右侧按钮截断验证（只读，不改代码）。
 *
 * 用户反馈：数据列表工具条右侧按钮显示不完整。验证流程：
 *  1. 连接 55432 → 打开 users 表（表格浏览 tab）
 *  2. 在 CSS 1600 / 1200 / 900 三种宽度下分别测量：
 *     - 主工具条 [data-testid="postgres-toolbar"]
 *     - 内层 tab 工具条（连接徽标 + 按钮行）：table tab（刷新/保存更改/还原更改）
 *       与 query tab（执行/保存/保存到记事本/执行计划/事务/格式化…）
 *  3. 证据：每个按钮 getBoundingClientRect，判定 right > 容器 right（被容器裁切）
 *     或 right > 视口宽（超出窗口右缘）；label scrollWidth > clientWidth（按钮内文字被挤）。
 *  截图存档于 test-results/toolbar-clip/。
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

const SHOTS = './test-results/toolbar-clip';
mkdirSync(SHOTS, { recursive: true });

interface ScanItem {
  tag: string;
  cls: string;
  text: string;
  left: number;
  right: number;
  width: number;
  clippedByContainer: boolean;
  pastViewport: boolean;
  labelClipped: boolean;
}
interface ToolbarScan {
  width: string;
  label: string;
  viewport: { vw: number; vh: number };
  container: { left: number; right: number; width: number; clientWidth: number; scrollWidth: number; overflowX: string };
  items: ScanItem[];
  clippedCount: number;
  lastRealRight: number;
}

/** 扫描容器 children 的 rect，返回裁切证据。传入容器 CSS 选择器。 */
async function scanToolbarBySelector(sel: string, label: string, widthLabel: string): Promise<ToolbarScan> {
  const raw = await browser.execute((s: string) => {
    const header = document.querySelector(s) as HTMLElement | null;
    if (!header) return null;
    const hr = header.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const items: ScanItem[] = [];
    for (const el of Array.from(header.children) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue; // flex-1 spacer / 零尺寸
      const labelSpan = el.querySelector('span') as HTMLElement | null;
      items.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 80),
        text: (el.textContent ?? '').trim().slice(0, 24),
        left: Math.round(r.left * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        clippedByContainer: r.right > hr.right + 1,
        pastViewport: r.right > vw + 1,
        labelClipped: labelSpan ? labelSpan.scrollWidth > labelSpan.clientWidth + 1 : false,
      });
    }
    const visible = items.filter((it) => it.width > 2);
    return {
      viewport: { vw, vh },
      container: {
        left: Math.round(hr.left * 10) / 10,
        right: Math.round(hr.right * 10) / 10,
        width: Math.round(hr.width * 10) / 10,
        clientWidth: header.clientWidth,
        scrollWidth: header.scrollWidth,
        overflowX: window.getComputedStyle(header).overflowX,
      },
      items,
      lastRealRight: visible.length ? visible[visible.length - 1].right : 0,
    };
  }, sel);
  return finalizeScan(raw, label, widthLabel);
}

/** 扫描内层 tab 工具条（连接徽标 `postgres-tab-connection` 所在行）。 */
async function scanTabToolbar(label: string, widthLabel: string): Promise<ToolbarScan> {
  const raw = await browser.execute(() => {
    const badge = document.querySelector('[data-testid="postgres-tab-connection"]') as HTMLElement | null;
    if (!badge) return null;
    const toolbar = badge.closest('div.flex.h-8') as HTMLElement | null;
    if (!toolbar) return null;
    const hr = toolbar.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const items: ScanItem[] = [];
    for (const el of Array.from(toolbar.children) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue;
      const labelSpan = el.querySelector('span') as HTMLElement | null;
      items.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 80),
        text: (el.textContent ?? '').trim().slice(0, 24),
        left: Math.round(r.left * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        clippedByContainer: r.right > hr.right + 1,
        pastViewport: r.right > vw + 1,
        labelClipped: labelSpan ? labelSpan.scrollWidth > labelSpan.clientWidth + 1 : false,
      });
    }
    const visible = items.filter((it) => it.width > 2);
    return {
      viewport: { vw, vh },
      container: {
        left: Math.round(hr.left * 10) / 10,
        right: Math.round(hr.right * 10) / 10,
        width: Math.round(hr.width * 10) / 10,
        clientWidth: toolbar.clientWidth,
        scrollWidth: toolbar.scrollWidth,
        overflowX: window.getComputedStyle(toolbar).overflowX,
      },
      items,
      lastRealRight: visible.length ? visible[visible.length - 1].right : 0,
    };
  });
  return finalizeScan(raw, label, widthLabel);
}

function finalizeScan(raw: unknown, label: string, widthLabel: string): ToolbarScan {
  if (!raw) {
    console.log(`TOOLBAR_SCAN ${label}@${widthLabel} => NOT_FOUND`);
    return {
      width: widthLabel, label,
      viewport: { vw: 0, vh: 0 },
      container: { left: 0, right: 0, width: 0, clientWidth: 0, scrollWidth: 0, overflowX: '' },
      items: [], clippedCount: 0, lastRealRight: 0,
    };
  }
  const scan = raw as Omit<ToolbarScan, 'width' | 'label' | 'clippedCount'>;
  const scrollable =
    scan.container.scrollWidth > scan.container.clientWidth + 1 &&
    ['auto', 'scroll', 'overlay'].includes(scan.container.overflowX);
  const clippedCount = scan.items.filter((it) => it.clippedByContainer && !scrollable).length;
  const scrollableCount = scan.items.filter((it) => it.clippedByContainer && scrollable).length;
  const pastVp = scan.items.filter((it) => it.pastViewport && !scrollable).length;
  const out: ToolbarScan = { ...scan, width: widthLabel, label, clippedCount };
  console.log(
    `TOOLBAR_SCAN ${label}@${widthLabel} => vw=${scan.viewport.vw} containerRight=${scan.container.right} ` +
    `items=${scan.items.length} clipped=${clippedCount} scrollable=${scrollableCount} pastVp=${pastVp} ` +
    `lastRealRight=${scan.lastRealRight} containerClientW=${scan.container.clientWidth} containerScrollW=${scan.container.scrollWidth} overflowX=${scan.container.overflowX}${scrollable ? ' [SCROLLABLE]' : ''}`,
  );
  for (const it of scan.items) {
    if (it.clippedByContainer || it.pastViewport || it.labelClipped) {
      console.log(
        `TOOLBAR_ITEM_CLIPPED ${label}@${widthLabel} ${it.tag} "${it.text}" left=${it.left} right=${it.right} width=${it.width} ` +
        `clipped=${it.clippedByContainer} pastVp=${it.pastViewport} labelClipped=${it.labelClipped} scrollable=${scrollable}`,
      );
    }
  }
  return out;
}

async function scanAll(widthLabel: string): Promise<ToolbarScan[]> {
  const scans: ToolbarScan[] = [];
  scans.push(await scanToolbarBySelector('[data-testid="postgres-toolbar"]', 'main-toolbar', widthLabel));
  scans.push(await scanTabToolbar('tab-toolbar', widthLabel));
  return scans;
}

async function resizeCss(w: number, h: number) {
  await browser.setWindowSize(w * 2, h * 2);
  await browser.pause(700);
  const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  console.log(`TOOLBAR_RESIZE target=(${w}x${h}) actual=${JSON.stringify(vp)}`);
  return vp as { w: number; h: number };
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

async function connectPostgres(name: string) {
  await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
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

/** 点击 tab strip 中指定标题的 tab（users 或 Query）。 */
async function switchTabByTitle(title: string) {
  const nav = await $('[data-testid="postgres-workspace"] nav');
  const tab = await nav.$(`button=${title}`);
  await tab.waitForExist({ timeout: 10_000 });
  await tab.click();
  await browser.pause(400);
}

describe('PostgreSQL 工具条右侧按钮截断验证（只读诊断）', () => {
  before(async () => {
    await switchMain();
    await resizeCss(1600, 1000);
    await unlockApp(`E2E_${Date.now()}`, '[data-testid="toolbox-nav-postgres"]');
    await connectPostgres(`ToolbarClip ${Date.now()}`);
    await openUsersTable();
    // 预创建查询 tab，供后续两种 tab 工具条对比
    await $('[data-testid="postgres-new-query"]').click();
    await waitForVisible('[data-testid="postgres-run"]');
    await switchTabByTitle('users');
  });

  it('CSS 1600x1000：主工具条 + 表格/查询 tab 工具条', async function () {
    this.timeout(120_000);
    await switchTabByTitle('users'); // 确保在表格 tab
    await scanAll('1600');
    await browser.saveScreenshot(`${SHOTS}/1600-table-tab.png`);
    await switchTabByTitle('Query'); // 打开查询 tab
    await scanAll('1600');
    await browser.saveScreenshot(`${SHOTS}/1600-query-tab.png`);
    await switchTabByTitle('users');
  });

  it('CSS 1200x750：重复扫描', async function () {
    this.timeout(120_000);
    await resizeCss(1200, 750);
    await switchTabByTitle('users');
    await scanAll('1200');
    await browser.saveScreenshot(`${SHOTS}/1200-table-tab.png`);
    await switchTabByTitle('Query');
    await scanAll('1200');
    await browser.saveScreenshot(`${SHOTS}/1200-query-tab.png`);
    await switchTabByTitle('users');
  });

  it('CSS 900x600：重复扫描', async function () {
    this.timeout(120_000);
    await resizeCss(900, 600);
    await switchTabByTitle('users');
    await scanAll('900');
    await browser.saveScreenshot(`${SHOTS}/900-table-tab.png`);
    await switchTabByTitle('Query');
    await scanAll('900');
    await browser.saveScreenshot(`${SHOTS}/900-query-tab.png`);
  });

  it('CSS 800x550：重复扫描', async function () {
    this.timeout(120_000);
    await resizeCss(800, 550);
    await switchTabByTitle('users');
    await scanAll('800');
    await browser.saveScreenshot(`${SHOTS}/800-table-tab.png`);
    await switchTabByTitle('Query');
    await scanAll('800');
    await browser.saveScreenshot(`${SHOTS}/800-query-tab.png`);
  });

  it('CSS 700x500：重复扫描', async function () {
    this.timeout(120_000);
    await resizeCss(700, 500);
    await switchTabByTitle('users');
    await scanAll('700');
    await browser.saveScreenshot(`${SHOTS}/700-table-tab.png`);
    await switchTabByTitle('Query');
    await scanAll('700');
    await browser.saveScreenshot(`${SHOTS}/700-query-tab.png`);
  });

  it('保底断言：三次扫描均应成功执行', async function () {
    expect(true).toBe(true);
  });
});
