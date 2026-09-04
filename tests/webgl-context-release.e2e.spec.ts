import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SCREENSHOT_DIR = 'test-results/webgl';
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.use({ launchOptions: { args: ['--max-active-webgl-contexts=2'] } });

async function createWebglTerminal(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    document.body.replaceChildren();
    const container = document.createElement('div');
    container.id = 'webgl-context-test';
    container.style.cssText = 'width:640px;height:360px;background:#202020;';
    document.body.append(container);

    const [{ Terminal }, { WebglAddon }] = await Promise.all([
      import('/node_modules/@xterm/xterm/lib/xterm.mjs'),
      import('/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'),
    ]);
    const globals = window as typeof window & {
      __webglTestTerminal: InstanceType<typeof Terminal>;
      __webglTestAddon: InstanceType<typeof WebglAddon>;
    };
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      theme: { background: '#202020' },
    });
    terminal.open(container);
    const addon = new WebglAddon(true);
    terminal.loadAddon(addon);
    terminal.write('CONTEXT_RELEASE');
    globals.__webglTestTerminal = terminal;
    globals.__webglTestAddon = addon;
  });
}

test('disposing the app WebGL addon deterministically releases its GL context', async ({ page }) => {
  await createWebglTerminal(page);

  const result = await page.evaluate(async () => {
    const proto = WebGL2RenderingContext.prototype;
    const originalGetExtension = proto.getExtension;
    let loseContextCalls = 0;
    proto.getExtension = function getExtensionSpied(name: string) {
      const extension = originalGetExtension.call(this, name);
      if (name === 'WEBGL_lose_context' && extension && !extension.__nextermSpied) {
        const originalLoseContext = extension.loseContext.bind(extension);
        extension.__nextermSpied = true;
        extension.loseContext = () => {
          loseContextCalls += 1;
          originalLoseContext();
        };
      }
      return extension;
    };

    try {
      const globals = window as typeof window & {
        __webglTestTerminal?: { dispose(): void };
        __webglTestAddon?: { dispose(): void };
      };
      const addon = globals.__webglTestAddon;
      const { disposeWebglAddon } = await import('/src/lib/webgl-lifecycle.ts');
      const callsBeforeDispose = loseContextCalls;
      if (addon) {
        disposeWebglAddon(addon as never);
      }
      return {
        rendererAttached: Boolean((addon as unknown as { _renderer?: unknown } | undefined)?._renderer),
        callsBeforeDispose,
        callsAfterDispose: loseContextCalls,
      };
    } finally {
      proto.getExtension = originalGetExtension;
    }
  });

  expect(result.rendererAttached, 'the browser must expose the addon renderer for lifecycle verification').toBe(true);
  expect(result.callsBeforeDispose).toBe(0);
  expect(result.callsAfterDispose, 'dispose must release the WebGL context before Chromium evicts a live terminal').toBe(1);
});

function ptyFrame(connectionId: string, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const id = Buffer.from(connectionId, 'utf8');
  const header = Buffer.from([0x01, (id.length >> 8) & 0xff, id.length & 0xff]);
  return Buffer.concat([header, id, payload]);
}

async function installTerminalAppMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('nexterm:feature-app-ready', 'true');
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string): unknown => {
          if (command === 'get_websocket_port') return Promise.resolve(9001);
          if (command === 'ssh_connect') return Promise.resolve({ success: true });
          if (command === 'discover_log_sources') {
            return Promise.resolve({ success: true, sources: [] });
          }
          if (command === 'ssh_host_key_fingerprint') {
            return Promise.resolve({ fingerprint: 'AA:BB:CC:DD:EE:FF:00:11' });
          }
          return Promise.resolve(undefined);
        },
      },
    });
  });

  await page.routeWebSocket('ws://127.0.0.1:9001', (websocket) => {
    websocket.onMessage((raw) => {
      let message: { type?: string; connection_id?: string };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'StartPty' && message.connection_id) {
        const connectionId = message.connection_id;
        websocket.send(JSON.stringify({ type: 'Success', message: 'PTY connection started' }));
        websocket.send(JSON.stringify({
          type: 'PtyStarted',
          connection_id: connectionId,
          generation: 1,
        }));
        websocket.send(ptyFrame(connectionId, 'root@host:~# '));
      }
    });
  });
}

async function connectSshTab(page: Page, name: string): Promise<void> {
  const emptyStateButton = page.getByRole('button', { name: /New Connection|新建连接/ }).first();
  if (await emptyStateButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await emptyStateButton.click();
  } else {
    await page.locator('button:has(svg.lucide-plus)').locator('visible=true').first().click();
  }
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#connection-name').fill(name);
  await page.locator('#host').fill('127.0.0.1');
  await page.locator('#username').fill('root');
  await dialog.getByRole('tab', { name: /Auth/ }).click();
  await page.locator('#password').fill('password');
  await dialog.getByRole('button', { name: /Connect|连接/ }).click();

  const confirm = dialog.getByRole('button', { name: /Confirm|确认/ });
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirm.click();
  }
  await page.locator('.xterm-viewport').last().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(200);
}

async function passAppLock(page: Page): Promise<void> {
  await page.locator('#app-lock-password').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#app-lock-password').fill('qa-e2e-password');
  const confirm = page.locator('#app-lock-confirm');
  if (await confirm.isVisible()) {
    await confirm.fill('qa-e2e-password');
  }
  await page.locator('[data-testid="app-lock-submit"]').click();
}

async function canvasChangeRatio(
  page: Page,
  before: Buffer,
  after: Buffer,
): Promise<number> {
  return page.evaluate(async ({ beforeBase64, afterBase64 }) => {
    const decode = async (base64: string) => {
      const bitmap = await (
        await fetch(`data:image/png;base64,${base64}`)
      ).blob().then((blob) => createImageBitmap(blob));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context?.drawImage(bitmap, 0, 0);
      void bitmap.close();
      return {
        data: context?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray(),
        width: canvas.width,
        height: canvas.height,
      };
    };

    const beforeData = await decode(beforeBase64);
    const afterData = await decode(afterBase64);
    if (
      beforeData.width !== afterData.width ||
      beforeData.height !== afterData.height
    ) return Number.POSITIVE_INFINITY;

    // Compare all rows except the prompt/cursor blink region. The startup
    // banner above it must remain pixel-stable while unrelated tabs churn.
    const comparableRows = Math.floor((beforeData.height * 21) / 24);
    const width = beforeData.width;
    let changed = 0;
    let total = 0;
    for (let y = 0; y < comparableRows; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        total++;
        if (
          Math.abs(beforeData[offset] - afterData[offset]) > 14 ||
          Math.abs(beforeData[offset + 1] - afterData[offset + 1]) > 14 ||
          Math.abs(beforeData[offset + 2] - afterData[offset + 2]) > 14
        ) {
          changed++;
        }
      }
    }
    return total === 0 ? Number.POSITIVE_INFINITY : changed / total;
  }, {
    beforeBase64: before.toString('base64'),
    afterBase64: after.toString('base64'),
  });
}

// Two live contexts are enough for the active tab and the retained previous
// tab. A disposed-but-unreleased context makes the third create call exceed
// this cap, reproducing the Windows WebView2 eviction path deterministically.
test('terminal tab churn keeps a live WebGL terminal stable', async ({ page }) => {
  test.setTimeout(120_000);

  await installTerminalAppMocks(page);
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.goto('/');
  await passAppLock(page);

  await connectSshTab(page, 'kept-live');
  const canvasBefore = await page.locator('.xterm-screen canvas').first().screenshot({
    path: `${SCREENSHOT_DIR}/tab-churn-before.png`,
  });
  for (let index = 0; index < 5; index++) {
    await connectSshTab(page, `churn-${index}`);
    const tab = page.locator('[data-tab-id]').last();
    await tab.hover();
    await tab.locator('button').first().click();
    await page.locator('.xterm-viewport').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
  }

  const evictionWarnings = consoleMessages.filter((message) =>
    message.includes('Too many active WebGL contexts'),
  );
  expect(evictionWarnings).toEqual([]);
  await expect(page.locator('.xterm-viewport').first()).toBeVisible();
  await expect(page.locator('[data-tab-id]').first()).toContainText('kept-live');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/tab-churn-live-terminal.png` });
  const canvasAfter = await page.locator('.xterm-screen canvas').first().screenshot({
    path: `${SCREENSHOT_DIR}/tab-churn-live-terminal-canvas.png`,
  });
  const changedRatio = await canvasChangeRatio(page, canvasBefore, canvasAfter);
  expect(
    changedRatio,
    'retained terminal glyphs must not change during unrelated tab churn',
  ).toBeLessThanOrEqual(0.001);
});
