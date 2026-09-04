import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

/**
 * 真实 x11vnc 原生桌面复连测试。先构建/启动本地夹具：
 * `docker run -d --name nexterm-vnc-reconnect -p 15900:5900 nexterm-vnc-fixture:local`，
 * 再使用 `VNC_E2E_ENABLED=1 E2E_VISIBLE=1 pnpm exec wdio run wdio.conf.ts
 * --spec e2e/desktop/vnc-reconnect.e2e.ts` 执行。
 */
const UNIQUE = `vnc${Date.now()}`;
const CONNECTION_NAME = `VNC 复连 ${UNIQUE}`;
const SHOT = './test-results/vnc-reconnect';
const VNC_E2E_ENABLED = process.env.VNC_E2E_ENABLED === '1';
const testWithVncFixture = VNC_E2E_ENABLED ? it : it.skip;

/** 用原生 value setter 写入 React 受控输入框。 */
async function setValue(selector: string, value: string): Promise<void> {
  const input = await browser.$(selector);
  await input.waitForExist({ timeout: 10_000 });
  await browser.execute((node: HTMLInputElement, nextValue: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, nextValue);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, input, value);
}

/** 按可见文本点击按钮，并补齐 WebKit/Radix 需要的鼠标事件。 */
async function clickText(text: string, rootSelector = 'body'): Promise<void> {
  const result = await browser.execute((label: string, scope: string) => {
    const root = document.querySelector(scope);
    if (!root) return `scope-not-found:${scope}`;
    const target = Array.from(root.querySelectorAll('button, [role="tab"]'))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (element.textContent ?? '').trim() === label;
      })
      .at(0) as HTMLElement | undefined;
    if (!target) return `target-not-found:${label}`;
    const rect = target.getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      detail: 1,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    target.dispatchEvent(new MouseEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new MouseEvent('pointerup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    target.focus();
    return 'ok';
  }, text, rootSelector);
  if (result !== 'ok') throw new Error(`点击失败：${result}`);
}

/** 解锁并等待主界面真正出现。 */
async function unlock(): Promise<void> {
  await unlockApp(`E2E_${UNIQUE}`);
  await browser.waitUntil(async () => !(await $('#app-lock-password').isExisting()), {
    timeout: 30_000,
    timeoutMsg: '应用锁初始化超时',
  });
}

/** 打开终端工作区的新建连接弹窗。 */
async function openConnectionDialog(): Promise<void> {
  await browser.execute(() => {
    const nav = document.querySelector('[data-testid="toolbox-nav-terminal"]') as HTMLButtonElement | null;
    if (nav && nav.getAttribute('aria-current') !== 'page') nav.click();
  });
  await browser.pause(300);
  const clicked = await browser.execute(() => {
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const emptyState = Array.from(document.querySelectorAll('button'))
      .find(button => (button.textContent ?? '').trim() === '新建连接' && isVisible(button));
    if (emptyState) {
      emptyState.click();
      return true;
    }
    const tabAdd = Array.from(document.querySelectorAll('button'))
      .find(button => /h-8\b/.test(button.className) && /w-8\b/.test(button.className)
        && button.querySelector('svg.lucide-plus') && isVisible(button));
    tabAdd?.click();
    return Boolean(tabAdd);
  });
  expect(clicked).toBe(true);
  await $('[role="dialog"]').waitForExist({ timeout: 10_000 });
}

/** 选择 VNC 协议。 */
async function selectVnc(): Promise<void> {
  await browser.execute(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const trigger = dialog?.querySelector('button[role="combobox"]') as HTMLElement | null;
    trigger?.click();
  });
  await browser.pause(300);
  await browser.saveScreenshot(`${SHOT}-protocol-menu.png`);
  await browser.execute(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find(element => (element.textContent ?? '').trim() === 'VNC') as HTMLElement | undefined;
    option?.click();
  });
  await browser.pause(200);
  await browser.saveScreenshot(`${SHOT}-after-vnc.png`);
}

describe('VNC 原生桌面复连', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
  });

  testWithVncFixture('首次直连后可以从断开界面重新连接', async () => {
    await openConnectionDialog();
    await setValue('#connection-name', CONNECTION_NAME);
    await selectVnc();
    await setValue('#host', '127.0.0.1');
    await setValue('#port', '15900');
    await clickText('认证', '[role="dialog"]');
    await setValue('#password', 'vncpass');
    await clickText('连接', '[data-slot="dialog-footer"]');

    const canvas = await waitForVisible('canvas', 30_000);
    expect(canvas).toBeExisting();
    await browser.saveScreenshot(`${SHOT}-first-connected.png`);

    // 工具栏 3 秒后自动隐藏；直接触发同名按钮，不依赖鼠标悬停。
    const disconnected = await browser.execute(() => {
      const button = document.querySelector('button[title="断开连接"]') as HTMLButtonElement | null;
      button?.click();
      return Boolean(button);
    });
    expect(disconnected).toBe(true);
    await browser.waitUntil(async () => (await browser.$('button=重新连接').isExisting()), {
      timeout: 15_000,
      timeoutMsg: 'VNC 未进入断开状态',
    });
    await browser.saveScreenshot(`${SHOT}-disconnected.png`);

    // 稳定模拟慢 WebView 队列：延迟旧 WebSocket 的 CloseDesktop，
    // 让它落后于新的 desktop_connect。Windows 上该竞态不需要人工延迟。
    await browser.execute(() => {
      const prototype = WebSocket.prototype as WebSocket & {
        __nextermOriginalSend?: typeof WebSocket.prototype.send;
        __nextermOriginalClose?: typeof WebSocket.prototype.close;
      };
      if (!prototype.__nextermOriginalSend) {
        prototype.__nextermOriginalSend = prototype.send;
        prototype.__nextermOriginalClose = prototype.close;
        prototype.send = function send(data: unknown) {
          if (typeof data === 'string' && data.includes('"CloseDesktop"')) {
            const original = prototype.__nextermOriginalSend!;
            window.setTimeout(() => original.call(this, data), 1500);
            return;
          }
          return prototype.__nextermOriginalSend!.call(this, data);
        };
        prototype.close = function close(...args: Parameters<typeof WebSocket.prototype.close>) {
          const original = prototype.__nextermOriginalClose!;
          window.setTimeout(() => original.apply(this, args), 1600);
        };
      }
    });
    await clickText('重新连接');
    await browser.waitUntil(async () => {
      const toolbar = await browser.$('button[title="断开连接"]');
      return toolbar.isExisting();
    }, {
      timeout: 30_000,
      timeoutMsg: 'VNC 复连后未出现已连接工具栏',
    });
    await browser.saveScreenshot(`${SHOT}-reconnected.png`);
    await browser.pause(2500);
    const staleDisconnectView = await browser.$('button=重新连接').isExisting();
    expect(staleDisconnectView).toBe(false);
  });
});
