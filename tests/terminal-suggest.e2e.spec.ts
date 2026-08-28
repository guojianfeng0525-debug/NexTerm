/**
 * QA — 命令提示框（Command Suggestion）页面级验证 + 截图。
 *
 * 验证路径：浏览器模式（Playwright）+ __TAURI_INTERNALS__ invoke mock +
 * routeWebSocket 假 PTY 服务器。命令提示框的弹出/抑制逻辑（suggestion
 * gate + engine + store）完全在前端，mock 即可产出真实渲染证据，无需
 * 真实 SSH 或桌面包。
 *
 * 场景：
 *   A. shell 输入 `git ` 时命令提示框弹出（截图 01-popup-visible.png）
 *   B. 进入 vim（alternate buffer）后输入按键不弹（截图 02-vim-suppressed.png）
 *   C. Esc 关闭后 recordRejection 负反馈生效（引擎降权，截图 03-esc-rejection.png）
 *
 * 截图落点：test-results/suggest/（命名带序号与动作）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOT = 'test-results/suggest';
mkdirSync(SHOT, { recursive: true });

declare global {
  interface Window {
    __rowUpsertCalls?: Array<{ table: string; row: Record<string, unknown> }>;
  }
}

/** mock 所有 Tauri invoke，并记录 row_upsert 以便断言负反馈持久化。 */
async function installInvokeMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      __rowUpsertCalls: [],
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown): unknown => {
          switch (command) {
            case 'get_websocket_port':
              return Promise.resolve(9001);
            case 'ssh_connect':
              return Promise.resolve({ success: true });
            case 'ssh_host_key_fingerprint':
              return Promise.resolve({ fingerprint: 'AA:BB:CC:DD:EE:FF:00:11' });
            case 'row_list':
              return Promise.resolve([]);
            case 'row_get':
              return Promise.resolve(undefined);
            case 'row_upsert': {
              const row = (args as { row?: Record<string, unknown> })?.row ?? {};
              window.__rowUpsertCalls!.push({
                table: (args as { table?: string })?.table ?? '',
                row,
              });
              return Promise.resolve(true);
            }
            case 'row_insert':
            case 'row_update':
            case 'row_delete':
              return Promise.resolve(true);
            default:
              return Promise.resolve(undefined);
          }
        },
      },
    });
  });
}

/** PtyTerminal 期望的二进制输出帧：[0x01][id_len:u16BE][connection_id][payload]。 */
function ptyFrame(connectionId: string, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const id = Buffer.from(connectionId, 'utf8');
  const header = Buffer.from([0x01, (id.length >> 8) & 0xff, id.length & 0xff]);
  return Buffer.concat([header, id, payload]);
}

interface PtyServer {
  /** 当前 shell 行（含 prompt），供断言/诊断。 */
  line: string;
  /** 是否处于 vim（alternate screen）模式。 */
  inVim: boolean;
}

/** 假 PTY 服务器：回显按键维护 prompt 行；`vim`+Enter 进入 alternate screen。 */
async function installFakePty(page: Page): Promise<PtyServer> {
  const server: PtyServer = { line: '', inVim: false };
  await page.routeWebSocket('ws://127.0.0.1:9001', (ws) => {
    const PROMPT = 'root@host:~# ';
    server.line = PROMPT;
    ws.onMessage((raw) => {
      let msg: { type?: string; connection_id?: string; data?: number[] };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'StartPty' && msg.connection_id) {
        const connId = msg.connection_id;
        server.line = PROMPT;
        ws.send(JSON.stringify({ type: 'Success', message: 'PTY connection started' }));
        ws.send(JSON.stringify({ type: 'PtyStarted', connection_id: connId, generation: 1 }));
        ws.send(ptyFrame(connId, PROMPT));
      } else if (msg.type === 'Input' && msg.connection_id && Array.isArray(msg.data)) {
        const chars = Buffer.from(msg.data).toString('utf8');
        const connId = msg.connection_id;
        for (const ch of chars) {
          if (server.inVim) continue; // vim 模式：按键不回到 shell 行
          if (ch === '\r' || ch === '\n') {
            const typed = server.line.slice(PROMPT.length);
            if (typed.trim() === 'vim') {
              server.inVim = true;
              ws.send(ptyFrame(connId, '\r\n\x1b[?1049h\x1b[?1h\x1b=\r\n~                                                 \r\n~                                                 \r\n~                                                 \r\n~                                                 \r\n~                                                 \r\n\x1b[23;1H'));
            } else {
              server.line = PROMPT;
              ws.send(ptyFrame(connId, '\r\n' + PROMPT));
            }
          } else if (ch === '\x7f') {
            server.line = server.line.slice(0, -1);
            ws.send(ptyFrame(connId, '\b \b'));
          } else if (ch === '\x03' || ch === '\x04') {
            server.line = PROMPT;
            ws.send(ptyFrame(connId, '^C\r\n' + PROMPT));
          } else {
            server.line += ch;
            ws.send(ptyFrame(connId, ch));
          }
        }
      }
    });
  });
  return server;
}

/** 通过首次运行 app-lock，并等待存储初始化完成。 */
async function passAppLock(page: Page): Promise<void> {
  await page.locator('#app-lock-password').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#app-lock-password').fill('qa-e2e-password');
  if (await page.locator('#app-lock-confirm').isVisible()) {
    await page.locator('#app-lock-confirm').fill('qa-e2e-password');
  }
  await page.locator('[data-testid="app-lock-submit"]').click();
  await page.locator('[data-testid="toolbox-nav-postgres"]').waitFor({ state: 'visible', timeout: 30_000 });
}

/** 新建 SSH 连接并进入终端（走 hostkey TOFU 确认）。 */
async function connectSsh(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /New Connection|新建连接/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  await page.locator('#connection-name').fill(name);
  await page.locator('#host').fill('127.0.0.1');
  await page.locator('#username').fill('root');
  await dialog.getByRole('tab', { name: /Auth/ }).click();
  await page.locator('#password').fill('pass');
  await dialog.getByRole('button', { name: /Connect|连接/ }).click();

  const hostKeyConfirm = dialog.getByRole('button', { name: /Confirm|确认/ });
  if (await hostKeyConfirm.isVisible({ timeout: 5000 }).catch(() => false)) {
    await hostKeyConfirm.click();
  }
  await page.locator('.xterm-viewport').waitFor({ state: 'visible', timeout: 15_000 });
  // 点击 xterm 使隐藏 textarea 获得焦点。
  await page.locator('.xterm-screen, .xterm-helper-textarea').first().click();
  await page.waitForTimeout(500);
}

const suggestionBar = (page: Page) => page.locator('[data-suggestion-bar]');

/** 建立 git 学习数据并输入 `git `，断言建议框弹出。 */
async function popupGit(page: Page): Promise<void> {
  await page.keyboard.type('git status');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.keyboard.type('git commit');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.keyboard.type('git ');
  await expect(suggestionBar(page)).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(300);
}

test.describe('命令提示框页面级验证（Slice 2/3）', () => {
  test('场景 A: shell 输入 `git ` 弹出命令提示框', async ({ page }) => {
    await installInvokeMock(page);
    await installFakePty(page);
    await page.goto('/');
    await passAppLock(page);
    await connectSsh(page, 'QA Suggest A');

    await popupGit(page);

    const bar = suggestionBar(page);
    const text = (await bar.textContent()) ?? '';
    expect(text).toContain('git status');
    expect(text).toContain('git commit');

    // P0 落位核验：弹层必须贴在光标行下方（或空间不足时贴其上方），
    // 绝不飘回顶部 fallback（top≈12）。BOX_H 实高 + rAF 重算后，弹层
    // 的 top 应显著大于 xterm 内容区顶部。
    await page.waitForTimeout(200); // 等 rAF 重算落位
    const pos = await page.evaluate(() => {
      const barEl = document.querySelector('[data-suggestion-bar]');
      const container = barEl?.parentElement;
      const xterm = document.querySelector('.xterm');
      if (!barEl || !container || !xterm) return null;
      const barRect = barEl.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      const xRect = xterm.getBoundingClientRect();
      return {
        barTopInContainer: barRect.top - cRect.top,
        xtermTopInContainer: xRect.top - cRect.top,
        xtermHeight: xRect.height,
        barHeight: barRect.height,
      };
    });
    expect(pos).not.toBeNull();
    expect(pos!.barTopInContainer).toBeGreaterThan(pos!.xtermTopInContainer + 24);

    await page.screenshot({ path: `${SHOT}/01-popup-visible.png` });
  });

  test('场景 B: 进入 vim（alternate buffer）后按键不弹', async ({ page }) => {
    await installInvokeMock(page);
    const pty = await installFakePty(page);
    await page.goto('/');
    await passAppLock(page);
    await connectSsh(page, 'QA Suggest B');

    await popupGit(page);
    await page.keyboard.press('Escape');
    await expect(suggestionBar(page)).toHaveCount(0);
    await page.keyboard.press('Control+c'); // 清行（Esc 只关建议框不清行）
    await page.waitForTimeout(300);

    await page.keyboard.type('vim');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    expect(pty.inVim).toBe(true);

    // vim 内导航/输入按键均不得弹出建议。
    await page.keyboard.type('j');
    await page.keyboard.type('i');
    await page.waitForTimeout(500);
    await expect(suggestionBar(page)).toHaveCount(0);

    await page.screenshot({ path: `${SHOT}/02-vim-suppressed.png` });
  });

  test('场景 C: Esc 关闭建议框并触发 recordRejection 负反馈', async ({ page }) => {
    await installInvokeMock(page);
    await installFakePty(page);
    await page.goto('/');
    await passAppLock(page);
    await connectSsh(page, 'QA Suggest C');

    await popupGit(page);
    await page.keyboard.press('Escape');
    await expect(suggestionBar(page)).toHaveCount(0);
    await page.waitForTimeout(400);

    // 负反馈必须持久化到 command_stats（rejection_count 递增）。
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__rowUpsertCalls ?? [])
            .filter((c) => c.table === 'command_stats' && (c.row.rejection_count ?? 0) > 0)
            .map((c) => c.row.rejection_count),
        ),
      )
      .not.toHaveLength(0);

    await page.screenshot({ path: `${SHOT}/03-esc-rejection.png` });
  });

  test('场景 D: 设置界面中的命令提示相关控件（E1 证据）', async ({ page }) => {
    await installInvokeMock(page);
    await page.goto('/');
    await passAppLock(page);

    // 打开设置对话框（toolbar 齿轮按钮）。
    await page.locator('button:has(svg.lucide-settings)').first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });

    // 切到「界面」tab。
    await dialog.getByRole('tab', { name: /Interface|界面/ }).click();
    await page.waitForTimeout(400);

    // 三个控件必须存在：commandSuggestions 开关、防抖选择器、TUI 抑制开关。
    const suggestionsLabel = dialog.locator('span', { hasText: /Command Suggestions|命令提示/ });
    await suggestionsLabel.waitFor({ state: 'visible', timeout: 10_000 });
    const debounceLabel = dialog.locator('span', { hasText: /Suggestion Debounce|命令提示防抖/ });
    await debounceLabel.waitFor({ state: 'visible', timeout: 5000 });
    const tuiGateLabel = dialog.locator('span', { hasText: /Suppress in Full-Screen|全屏应用中抑制/ });
    await tuiGateLabel.waitFor({ state: 'visible', timeout: 5000 });

    // 滚动到命令提示区域，确保三个控件同框入镜。
    await suggestionsLabel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT}/04-settings-controls.png` });

    // 断言控件交互存在（开关/选择器）。
    await expect(suggestionsLabel.locator('xpath=..').locator('button[role="switch"]')).toHaveCount(1);
    await expect(tuiGateLabel.locator('xpath=..').locator('button[role="switch"]')).toHaveCount(1);
    await expect(debounceLabel.locator('xpath=..').locator('button[role="combobox"]')).toHaveCount(1);
  });
});
