import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
import {
  isAppLockConfigured,
  setupAppLock,
  verifyAppLock,
  hydrateAppLockMeta,
} from '@/lib/toolbox/app-lock';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

describe('app-lock', () => {
  beforeEach(async () => {
    for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
    await hydrateAppLockMeta();
  });

  it('is not configured initially', () => {
    expect(isAppLockConfigured()).toBe(false);
  });

  it('setup stores only a salted verifier, never the password', async () => {
    await setupAppLock('secret123');
    expect(isAppLockConfigured()).toBe(true);
    const row = ipc.DB.app_lock?.[0];
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('secret123');
    expect(row?.salt).toBeDefined();
    expect(row?.verifier).toBeDefined();
    expect(row?.iterations).toBe(150_000);
  });

  it('verifies the correct password and rejects wrong ones', async () => {
    await setupAppLock('secret123');
    expect(await verifyAppLock('secret123')).toBe(true);
    expect(await verifyAppLock('wrong')).toBe(false);
    expect(await verifyAppLock('')).toBe(false);
  });

  it('verify returns false when no password is configured', async () => {
    expect(await verifyAppLock('anything')).toBe(false);
  });

  it('rejects a too-short password', async () => {
    await expect(setupAppLock('abc')).rejects.toThrow();
    expect(isAppLockConfigured()).toBe(false);
  });
});
