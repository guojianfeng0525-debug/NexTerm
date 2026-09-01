/**
 * Remote file editor encoding E2E.
 *
 * Creates a real GBK file over the SSH fixture through the new encoded-write
 * command, opens it in the standalone editor window, verifies the default
 * UTF-8 view is wrong/garbled, switches the visible encoding selector to GBK,
 * and confirms the same remote bytes decode to the expected Chinese text.
 * The dirty-buffer save conversion path is covered by Vitest (CodeMirror input
 * is unreliable under the embedded WebKit driver).
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';

const SHOT = './test-results/file-editor-encoding';
const UNIQUE = Date.now();
const FILE_NAME = `nexterm-gbk-${UNIQUE}.txt`;
const REMOTE_PATH = `/tmp/${FILE_NAME}`;
const CONTENT = `中文编码转换-${UNIQUE}`;

const SSH_HOST = '127.0.0.1';
const SSH_PORT = '2222';
const SSH_USER = 'nexterm';
const SSH_PASS = 'NexTermSSH!2026';

mkdirSync(SHOT, { recursive: true });

async function invokeInApp<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (command: string, parameters: Record<string, unknown>) =>
      (window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (...input: unknown[]) => Promise<T> };
      }).__TAURI_INTERNALS__!.invoke(command, parameters),
    cmd,
    args,
  );
}

async function connectSshFast() {
  const result = await browser.executeAsync((
    lockPassword: string,
    connectionName: string,
    host: string,
    port: string,
    username: string,
    sshPassword: string,
    done: (value: { ok: boolean; error?: string }) => void,
  ) => {
    const setValue = (selector: string, value: string) => {
      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const click = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
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
      element.dispatchEvent(new MouseEvent('pointerdown', init));
      element.dispatchEvent(new MouseEvent('mousedown', init));
      element.dispatchEvent(new MouseEvent('pointerup', { ...init, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    };
    const finish = (ok: boolean, error?: string) => done({ ok, error });

    if (document.querySelector('#app-lock-password')) {
      setValue('#app-lock-password', lockPassword);
      setValue('#app-lock-confirm', lockPassword);
      const submit = document.querySelector('[data-testid="app-lock-submit"]') as HTMLButtonElement | null;
      if (!submit) {
        finish(false, 'lock submit missing');
        return;
      }
      click(submit);
    }

    window.setTimeout(() => {
      const newConnection = Array.from(document.querySelectorAll('button')).find((button) => {
        const text = (button.textContent || '').trim();
        return text === '新建连接' || text === 'New Connection';
      }) as HTMLElement | undefined;
      if (!newConnection) {
        finish(false, 'new connection trigger missing');
        return;
      }
      click(newConnection);

      window.setTimeout(() => {
        const authTab = Array.from(document.querySelectorAll('[role="dialog"] [role="tab"]'))
          .find((tab) => ['认证', 'Auth'].includes((tab.textContent || '').trim())) as HTMLElement | undefined;
        const filled = authTab
          && setValue('#connection-name', connectionName)
          && setValue('#host', host)
          && setValue('#port', port)
          && setValue('#username', username);
        if (!filled || !authTab) {
          finish(false, 'connection form missing');
          return;
        }
        click(authTab);

        window.setTimeout(() => {
          const passwordSet = setValue('#password', sshPassword);
          const connect = Array.from(document.querySelectorAll('[data-slot="dialog-footer"] button'))
            .find((button) => ['连接', 'Connect'].includes((button.textContent || '').trim())) as HTMLElement | undefined;
          if (!passwordSet || !connect) {
            finish(false, 'auth form missing');
            return;
          }
          click(connect);

          const started = Date.now();
          const timer = window.setInterval(() => {
            const tofu = Array.from(document.querySelectorAll('[role="dialog"]'))
              .find((dialog) => (dialog.textContent || '').includes('SHA256:'));
            if (tofu) {
              const confirm = Array.from(tofu.querySelectorAll('button'))
                .find((button) => ['确认', 'Confirm'].includes((button.textContent || '').trim())) as HTMLElement | undefined;
              confirm?.click();
              return;
            }
            if (document.querySelector('.xterm') && document.querySelector('[data-columns-container]')) {
              window.clearInterval(timer);
              finish(true);
              return;
            }
            if (Date.now() - started > 30_000) {
              window.clearInterval(timer);
              finish(false, 'SSH connection timed out');
            }
          }, 250);
        }, 300);
      }, 300);
    }, 600);
  }, `E2E_ENCODE_${UNIQUE}`, `Encoding ${UNIQUE}`, SSH_HOST, SSH_PORT, SSH_USER, SSH_PASS);

  if (!result?.ok) throw new Error(`SSH setup failed: ${result?.error ?? 'unknown'}`);
}

async function openEditorByUrl(connectionId: string) {
  await browser.execute((
    id: string,
    path: string,
    name: string,
  ) => {
    const query = new URLSearchParams({
      mode: 'file-viewer',
      connectionId: id,
      filePath: path,
      fileName: name,
    });
    window.location.href = `${window.location.origin}/?${query.toString()}`;
  }, connectionId, REMOTE_PATH, FILE_NAME);
  const loaded = await browser.executeAsync((
    done: (value: { ok: boolean }) => void,
  ) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (document.querySelector('[data-testid="file-editor-encoding"]') && document.querySelector('.cm-content')) {
        window.clearInterval(timer);
        done({ ok: true });
        return;
      }
      if (Date.now() - started > 15_000) {
        window.clearInterval(timer);
        done({ ok: false });
      }
    }, 100);
  });
  if (!loaded?.ok) throw new Error('file editor did not load');
}

async function selectEncoding(label: string) {
  const clicked = await browser.executeAsync((
    text: string,
    done: (value: boolean) => void,
  ) => {
    const trigger = document.querySelector<HTMLElement>('[data-testid="file-editor-encoding"]');
    if (!trigger) {
      done(false);
      return;
    }
    trigger.click();
    const started = Date.now();
    const timer = window.setInterval(() => {
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((el) => (el.textContent || '').trim() === text);
      if (option) {
        window.clearInterval(timer);
        option.click();
        done(true);
        return;
      }
      if (Date.now() - started > 10_000) {
        window.clearInterval(timer);
        done(false);
      }
    }, 100);
  }, label);
  if (!clicked) throw new Error(`encoding option not found: ${label}`);
}

describe('remote file editor encoding', () => {
  it('decodes a GBK server file after switching the editor encoding', async function () {
    await connectSshFast();
    const connectionIds = await invokeInApp<string[]>('list_connections', {});
    expect(connectionIds.length).toBeGreaterThan(0);
    const connectionId = connectionIds[0];
    await invokeInApp<boolean>('create_file_with_encoding', {
      connectionId,
      path: REMOTE_PATH,
      content: CONTENT,
      encoding: 'gbk',
    });
    await openEditorByUrl(connectionId);
    await browser.saveScreenshot(`${SHOT}/01-default-utf8-view.png`);

    const utf8Text = await browser.execute(() =>
      document.querySelector('.cm-content')?.textContent ?? '');
    expect(utf8Text).not.toContain('中文编码转换');

    await selectEncoding('GBK');
    const decodedInUi = await browser.executeAsync((
      expected: string,
      done: (value: boolean) => void,
    ) => {
      const started = Date.now();
      const timer = window.setInterval(() => {
        const text = document.querySelector('.cm-content')?.textContent ?? '';
        if (text.includes(expected)) {
          window.clearInterval(timer);
          done(true);
          return;
        }
        if (Date.now() - started > 10_000) {
          window.clearInterval(timer);
          done(false);
        }
      }, 100);
    }, '中文编码转换');
    expect(decodedInUi).toBe(true);
    await browser.saveScreenshot(`${SHOT}/02-gbk-view.png`);

    const decoded = await invokeInApp<{ content: string; hadErrors: boolean }>(
      'read_file_content_with_encoding',
      {
        // Invoke runs in the main window, but the Tauri command is global to
        // the app process; the editor window's URL still has the connection id.
        connectionId,
        path: REMOTE_PATH,
        encoding: 'gbk',
      },
    );
    expect(decoded.hadErrors).toBe(false);
    expect(decoded.content).toContain(CONTENT);

    await invokeInApp<boolean>('delete_file', {
      connectionId,
      path: REMOTE_PATH,
      isDirectory: false,
    });
  });
});
