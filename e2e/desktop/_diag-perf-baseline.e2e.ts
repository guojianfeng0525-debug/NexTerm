/**
 * QA diagnostic — 数据网格渲染性能基线（只读，不改代码）。
 *
 * 测量「触发加载 → 网格可交互（首行数据单元格出现）」端到端耗时：
 *  - 打开已有表（browse_fixture 150 行 / users 70 行）
 *  - 执行大结果集查询（generate_series 1000 行 / 2000 行）
 *  - 打开建表生成的大表（qa_perf_big，2000 行）
 *
 * 计时用页面内 performance.now()：在同一个 browser.execute 中设置 t0 并
 * 触发动作（dblclick / click run），页面内 setInterval 轮询 tbody 首行
 * 数据格非空，记录 t1。耗时 = t1 - t0（含 SQL 执行 + IPC + React 渲染）。
 *
 * 输出 PERF 行（name, ms, rows, cols），截图存档于 test-results/perf/。
 */
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

const SHOTS = './test-results/perf';
mkdirSync(SHOTS, { recursive: true });

interface PerfResult {
  name: string;
  ms: number;
  rows: number;
  cols: number;
}

declare global {
  interface Window {
    __perf?: {
      t0: number;
      done: { t1: number; rows: number; cols: number } | null;
    };
  }
}

/** 在页面内设置 t0 + 轮询 + 触发动作，返回端到端耗时。 */
async function timed(
  name: string,
  setup: () => void,
  timeout = 30_000,
): Promise<PerfResult> {
  await browser.execute(() => {
    window.__perf = { t0: performance.now(), done: null };
    const tick = () => {
      const row = document.querySelector(
        '[data-testid="postgres-workspace"] tbody tr',
      ) as HTMLTableRowElement | null;
      // 行号 gutter 是第一 td，数据列从 index=1 开始；数据格非空才算可交互。
      const dataCell = row?.querySelectorAll('td')[1] as HTMLTableCellElement | null;
      if (dataCell?.textContent?.trim()) {
        window.__perf.done = {
          t1: performance.now(),
          rows: document.querySelectorAll(
            '[data-testid="postgres-workspace"] tbody tr',
          ).length,
          cols: row.querySelectorAll('td').length,
        };
        return;
      }
      setTimeout(tick, 30);
    };
    setTimeout(tick, 30);
  });
  await setup();
  await browser.waitUntil(
    async () => !!(await browser.execute(() => window.__perf?.done)),
    { timeout, timeoutMsg: `PERF ${name} timed out` },
  );
  const perf = await browser.execute(() => {
    const p = window.__perf;
    return p?.done ? { t0: p.t0, t1: p.done.t1, rows: p.done.rows, cols: p.done.cols } : null;
  });
  const ms = Math.round((perf.t1 - perf.t0) * 10) / 10;
  console.log(`PERF ${name} => ${ms}ms rows=${perf.rows} cols=${perf.cols}`);
  await browser.saveScreenshot(`${SHOTS}/${name}.png`);
  return { name, ms, rows: perf.rows, cols: perf.cols };
}

/** 在页面内设置 t0 + 轮询 + dblclick 打开表（表必须已在 navigator 可见）。 */
function openTableInPage(tableName: string) {
  return browser.execute((name) => {
    window.__perf = { t0: performance.now(), done: null };
    // 竞态保护：若上一个表网格仍在 DOM（同一 workspace 重渲染），要求行数
    // 发生变化才算新网格可交互，避免误测到旧网格。
    const oldRows = document.querySelectorAll(
      '[data-testid="postgres-workspace"] tbody tr',
    ).length;
    const tick = () => {
      const row = document.querySelector(
        '[data-testid="postgres-workspace"] tbody tr',
      ) as HTMLTableRowElement | null;
      const dataCell = row?.querySelectorAll('td')[1] as HTMLTableCellElement | null;
      if (dataCell?.textContent?.trim()) {
        const rows = document.querySelectorAll(
          '[data-testid="postgres-workspace"] tbody tr',
        ).length;
        if (oldRows === 0 || rows !== oldRows) {
          window.__perf.done = {
            t1: performance.now(),
            rows,
            cols: row.querySelectorAll('td').length,
          };
          return;
        }
      }
      setTimeout(tick, 30);
    };
    setTimeout(tick, 30);
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === name,
    );
    if (!btn) {
      window.__perf.done = { t1: -1, rows: -1, cols: -1 };
      return;
    }
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, tableName);
}

/** 在页面内设置 t0 + 轮询 + 点击 run 执行查询。 */
function runQueryInPage() {
  return browser.execute(() => {
    window.__perf = { t0: performance.now(), done: null };
    const tick = () => {
      const row = document.querySelector(
        '[data-testid="postgres-workspace"] tbody tr',
      ) as HTMLTableRowElement | null;
      const dataCell = row?.querySelectorAll('td')[1] as HTMLTableCellElement | null;
      if (dataCell?.textContent?.trim()) {
        window.__perf.done = {
          t1: performance.now(),
          rows: document.querySelectorAll(
            '[data-testid="postgres-workspace"] tbody tr',
          ).length,
          cols: row.querySelectorAll('td').length,
        };
        return;
      }
      setTimeout(tick, 30);
    };
    setTimeout(tick, 30);
    (document.querySelector('[data-testid="postgres-run"]') as HTMLElement | null)?.click();
  });
}

/** 展开 public schema 下的表，并确保目标表按钮可见。 */
async function ensureTableVisible(tableName: string) {
  const tablesGroup = await $('[data-node-id*="/group:tables"]');
  if (!(await $(`button=${tableName}`).isExisting())) {
    await tablesGroup.click();
  }
  await waitForVisible(`button=${tableName}`, 15_000);
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
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20_000 });
}

/** 打开一个新的 Query tab 并写入 SQL。 */
async function newQueryTab(sql: string) {
  await $('[data-testid="postgres-new-query"]').click();
  const workspace = await $('[data-testid="postgres-workspace"]');
  const editors = await workspace.$$('.cm-content');
  const editor = editors[editors.length - 1];
  await editor.click();
  await editor.clearValue();
  await editor.setValue(sql);
  // CodeMirror onChange 需要同步到 tab.sql 后 run 才会 enabled；等它可用，
  // 避免 runQueryInPage 点击一个 disabled 按钮导致计时超时。
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 5_000 });
  await browser.pause(100);
}

/** 通过 Query tab 执行 DDL/DML（用于建大表，非计时）。 */
async function runSql(sql: string) {
  await newQueryTab(sql);
  await $('[data-testid="postgres-run"]').click();
  await browser.pause(2500);
}

const BIG_SQL = `CREATE TABLE IF NOT EXISTS qa_perf_big AS
  SELECT g AS id,
         'row_' || g AS name,
         g % 10 AS bucket,
         (g * 1.5)::numeric(12,2) AS score,
         md5(g::text) AS hash,
         g::text || ' padded padding padding' AS note
  FROM generate_series(1, 2000) AS g;
TRUNCATE qa_perf_big; INSERT INTO qa_perf_big
  SELECT g AS id,
         'row_' || g AS name,
         g % 10 AS bucket,
         (g * 1.5)::numeric(12,2) AS score,
         md5(g::text) AS hash,
         g::text || ' padded padding padding' AS note
  FROM generate_series(1, 2000) AS g;`;

const Q1000 = `SELECT g AS id, 'row_' || g AS name, g % 7 AS bucket,
  (g * 1.5)::numeric AS score, md5(g::text) AS hash
  FROM generate_series(1, 1000) AS g;`;

const Q2000 = `SELECT g AS id, 'row_' || g AS name, g % 7 AS bucket,
  (g * 1.5)::numeric AS score, md5(g::text) AS hash
  FROM generate_series(1, 2000) AS g;`;

/** 1000 行 × 14 列宽表：观察列多对渲染的影响。 */
const Q1000_WIDE = `SELECT g AS c01, g AS c02, g AS c03, g AS c04, g AS c05,
  g AS c06, g AS c07, g AS c08, g AS c09, g AS c10,
  g AS c11, g AS c12, g AS c13, g AS c14
  FROM generate_series(1, 1000) AS g;`;

describe('PostgreSQL 数据网格渲染性能基线（只读诊断）', () => {
  const results: PerfResult[] = [];

  before(async () => {
    await browser.tauri.switchWindow('main');
    await browser.setWindowSize(1600, 1000);
    await browser.pause(700);
    await unlockApp(`E2E_${Date.now()}`, '[data-testid="toolbox-nav-postgres"]');
    await connectPostgres(`PerfBaseline ${Date.now()}`);
  });

  after(async () => {
    try {
      await runSql('DROP TABLE IF EXISTS qa_perf_big;');
    } catch {
      /* 清理尽力而为 */
    }
    console.log(
      `PERF_SUMMARY ${results.map((r) => `${r.name}=${r.ms}ms(${r.rows}r)`.replace(' ', '')).join(' ')}`,
    );
  });

  it('打开已有表 browse_fixture（150 行）', async function () {
    this.timeout(120_000);
    await ensureTableVisible('browse_fixture');
    const r = await timed('open-browse_fixture', () => openTableInPage('browse_fixture'));
    results.push(r);
  });

  it('打开已有表 users（70 行）', async function () {
    this.timeout(120_000);
    await ensureTableVisible('users');
    const r = await timed('open-users', () => openTableInPage('users'));
    results.push(r);
  });

  it('查询生成 1000 行结果集', async function () {
    this.timeout(120_000);
    await newQueryTab(Q1000);
    const r = await timed('query-1000', () => runQueryInPage());
    results.push(r);
  });

  it('查询生成 2000 行结果集', async function () {
    this.timeout(120_000);
    await newQueryTab(Q2000);
    const r = await timed('query-2000', () => runQueryInPage());
    results.push(r);
  });

  it('查询生成 1000 行 × 14 列宽结果集', async function () {
    this.timeout(120_000);
    await newQueryTab(Q1000_WIDE);
    const r = await timed('query-1000-wide', () => runQueryInPage());
    results.push(r);
  });

  it('建表并打开 2000 行大表（qa_perf_big）', async function () {
    this.timeout(120_000);
    await runSql(BIG_SQL);
    await $('[data-testid="postgres-refresh"]').click();
    // refresh 后导航器重渲染时间不定，轮询等待目标表按钮出现。
    const waitStart = Date.now();
    while (Date.now() - waitStart < 25_000) {
      if (await $(`button=qa_perf_big`).isExisting()) break;
      await browser.pause(500);
    }
    await ensureTableVisible('qa_perf_big');
    const r = await timed('open-qa_perf_big-2000', () => openTableInPage('qa_perf_big'));
    results.push(r);
  });
});
