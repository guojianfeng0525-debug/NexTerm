/**
 * Host-key TOFU (Trust On First Use) desktop E2E — real SSH server.
 *
 * Security baseline: direct SSH/SFTP connections show an in-app fingerprint
 * confirmation dialog on first connect (application dialog, never
 * window.confirm), persist the accepted fingerprint with the connection, and
 * refuse to connect when the user declines (fail-closed).
 *
 * Runtime dependency: an SSH server reachable at 127.0.0.1:2222 (docker
 * container `nexterm-centos-stream`, user `nexterm`, password
 * `NexTermSSH!2026`). The same fixture backs src-tauri/src/ssh/tests.rs.
 *
 * Covered (visible UI flow):
 *   1. First connect probes the host key, the in-app confirmation dialog
 *      appears with the SHA256 fingerprint; confirming persists the
 *      fingerprint and the SSH terminal connects.
 *   2. Declining the confirmation aborts the connection and keeps the
 *      connection dialog open — nothing connects without trust.
 *
 * The "fingerprint rotated → refuse" path is backend-covered by unit tests
 * (`ssh::Client::check_server_key` in src-tauri/src/ssh/mod.rs and
 * `postgres_ssh_host_key_requires_a_pin_and_rejects_mismatch` in
 * src-tauri/src/postgres.rs) because it requires rewriting a persisted
 * fingerprint behind the frontend connection cache, which the desktop E2E
 * cannot safely mutate through the visible UI.
 */
import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

const UNIQUE = `tofu${Date.now()}`;
const CONNECTION_NAME = `TOFU E2E ${UNIQUE}`;
const SSH_HOST = '127.0.0.1';
const SSH_PORT = '2222';
const SSH_USER = 'nexterm';
const SSH_PASS = 'NexTermSSH!2026';

async function unlock() {
  await unlockApp(`E2E_${UNIQUE}`);
}

/** Open the New Connection dialog (Servers view, the initial section). */
async function openConnectionDialog() {
  const newButton = await waitForVisible('button=新建连接');
  await newButton.click();
  await $('[role="dialog"]').waitForExist({ timeout: 10_000 });
}

/** Fill an SSH password-auth form (protocol defaults to SSH, port 22). */
async function fillSshForm() {
  await $('#host').setValue(SSH_HOST);
  // The port input is a controlled React number input — set through the native
  // value setter + an input event (same pattern as postgres-visual.e2e.ts).
  await browser.execute((input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, await $('#port'), SSH_PORT);
  await $('#username').setValue(SSH_USER);
  await $('[role="tab"]=认证方式').click();
  await $('#password').setValue(SSH_PASS);
}

/** The in-app host-key confirmation dialog, identified by its fingerprint text. */
async function hostKeyPrompt() {
  return waitForVisible('text*=SHA256:', 15_000);
}

/** Click a footer button inside the TOFU dialog that owns the given element. */
async function clickPromptButton(prompt: WebdriverIO.Element, label: string) {
  const button = await prompt.$(
    `xpath=ancestor::div[@data-slot="dialog-content"]//button[normalize-space()="${label}"]`,
  );
  await button.click();
}

describe('Host-key TOFU desktop flow', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
  });

  it('probes the host key on first connect, confirms it and connects', async () => {
    await openConnectionDialog();

    const dialog = await $('[role="dialog"]');
    await $('#connection-name').setValue(CONNECTION_NAME);
    // Persist the connection so the accepted fingerprint can be verified in SQLite.
    await $('#save-connection').click();
    await fillSshForm();

    await dialog.$('button=连接').click();

    // The in-app TOFU dialog appears with the probed SHA256 fingerprint.
    await hostKeyPrompt();

    // Accept: proceed with the fingerprint and connect.
    const prompt = await hostKeyPrompt();
    await clickPromptButton(prompt, '确认');

    // The SSH terminal mounts after the trusted fingerprint connects.
    await waitForVisible('.xterm', 25_000);

    // The accepted fingerprint was persisted with the saved connection.
    const rows = await browser.execute(() => {
      const api = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      return api.invoke('row_list', { table: 'connections' }) as Promise<Array<Record<string, unknown>>>;
    });
    const saved = rows.filter((row) => String(row.name).includes(UNIQUE));
    expect(saved.length).toBe(1);
    expect(String(saved[0].host_key_fingerprint)).toMatch(/^SHA256:/);
  });

  it('aborts the connection when the host key is declined (fail-closed)', async () => {
    // A terminal tab is open from the previous test — open a fresh connection
    // dialog from the tab bar's "+" button.
    const clicked = await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const plus = buttons.filter((b) => b.querySelector('svg.lucide-plus'));
      const visible = plus.find((b) => {
        const rect = b.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(b).display !== 'none' &&
          getComputedStyle(b).visibility !== 'hidden'
        );
      });
      if (visible) {
        visible.click();
        return true;
      }
      return false;
    });
    expect(clicked).toBe(true);
    await $('[role="dialog"]').waitForExist({ timeout: 10_000 });

    const dialog = await $('[role="dialog"]');
    await fillSshForm();
    await dialog.$('button=连接').click();

    // The same in-app TOFU confirmation appears for this brand-new connection.
    const prompt = await hostKeyPrompt();
    await clickPromptButton(prompt, '取消');

    // Declining closes the TOFU prompt but does NOT connect: the connection
    // dialog stays open and no terminal is created for this attempt.
    await expect($('text*=SHA256:')).not.toBeExisting();
    await expect($('[role="dialog"]')).toBeExisting();
  });
});
