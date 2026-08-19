import { describe, it, expect, beforeEach } from 'vitest';
import {
  createVault,
  unlockVault,
  changeVaultPassword,
  destroyVault,
  isVaultCreated,
  getVaultMeta,
  encryptPayload,
  decryptPayload,
  resetVaultCaches,
} from '@/lib/toolbox/vault-crypto';
import {
  loadRecords,
  saveRecords,
  addRecord,
  updateRecord,
  deleteRecord,
  type VaultEntry,
} from '@/lib/toolbox/records-storage';
import type { VaultRecord } from '@/lib/toolbox/toolbox-types';

function makeRecord(name: string, password: string): VaultRecord {
  return {
    id: '',
    name,
    address: 'https://example.com',
    username: 'user',
    password,
    category: 'test',
    notes: 'note',
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('vault-crypto', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVaultCaches();
  });

  it('creates a vault and stores only encrypted metadata', async () => {
    expect(isVaultCreated()).toBe(false);
    const { key, meta } = await createVault('master123');
    expect(key).toBeDefined();
    expect(isVaultCreated()).toBe(true);
    expect(meta.salt.length).toBeGreaterThan(0);
    expect(meta.iterations).toBeGreaterThan(0);
    // Vault metadata now lives in the SQLite app_settings columns — never
    // written to localStorage (which would contain no plaintext anyway).
    expect(localStorage.getItem('nexterm:vault:meta')).toBeNull();
    expect(getVaultMeta()).not.toBeNull();
  });

  it('unlocks with the correct password and rejects a wrong one', async () => {
    await createVault('master123');
    const good = await unlockVault('master123');
    expect(good).not.toBeNull();
    const bad = await unlockVault('wrong-password');
    expect(bad).toBeNull();
  });

  it('rejects a too-short master password', async () => {
    await expect(createVault('abc')).rejects.toThrow();
  });

  it('encrypt/decrypt round-trips text and produces different ciphertexts', async () => {
    const { key } = await createVault('master123');
    const a = await encryptPayload(key, 'secret-value');
    const b = await encryptPayload(key, 'secret-value');
    expect(a).not.toBe(b); // random IV per encryption
    expect(await decryptPayload(key, a)).toBe('secret-value');
  });

  it('fails to decrypt with a different key', async () => {
    const { key } = await createVault('master123');
    await destroyVault('master123');
    const { key: key2 } = await createVault('other-pass');
    const payload = await encryptPayload(key, 'data');
    await expect(decryptPayload(key2, payload)).rejects.toThrow();
  });

  it('persists records encrypted so plaintext never hits localStorage', async () => {
    const { key } = await createVault('master123');
    await addRecord(key, makeRecord('GitHub', 'hunter2'));
    // Regression guard: production must never write vault data to
    // localStorage, so these reads are always empty.
    const raw = localStorage.getItem('nexterm:vault:records') ?? '';
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('GitHub');
    const entries = await loadRecords(key);
    expect(entries).toHaveLength(1);
    expect(entries[0].record.password).toBe('hunter2');
  });

  it('changeVaultPassword re-encrypts records and old password stops working', async () => {
    const { key } = await createVault('old-pass');
    await addRecord(key, makeRecord('Record A', 'pw-a'));
    const newKey = await changeVaultPassword('old-pass', 'new-pass');
    expect(newKey).toBeDefined();

    const entries = await loadRecords(newKey);
    expect(entries).toHaveLength(1);
    expect(entries[0].record.password).toBe('pw-a');
    expect(await unlockVault('old-pass')).toBeNull();
    expect(await unlockVault('new-pass')).not.toBeNull();
  });

  it('changeVaultPassword rejects a wrong current password', async () => {
    await createVault('old-pass');
    await expect(changeVaultPassword('nope', 'new-pass')).rejects.toThrow();
  });

  it('destroyVault wipes metadata and records', async () => {
    const { key } = await createVault('master123');
    await addRecord(key, makeRecord('A', 'pw'));
    await destroyVault('master123');
    expect(isVaultCreated()).toBe(false);
    expect(localStorage.getItem('nexterm:vault:records')).toBeNull();
    expect(await loadRecords(key)).toHaveLength(0);
  });

  it('destroyVault rejects a wrong password', async () => {
    await createVault('master123');
    await expect(destroyVault('wrong')).rejects.toThrow();
    expect(isVaultCreated()).toBe(true);
  });
});

describe('records-storage', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVaultCaches();
  });

  it('adds, updates and deletes records', async () => {
    const { key } = await createVault('master123');
    const added = await addRecord(key, makeRecord('First', 'pw1'));
    expect(added.record.name).toBe('First');

    await updateRecord(key, added.id, { password: 'pw2' });
    let entries = await loadRecords(key);
    expect(entries[0].record.password).toBe('pw2');

    entries = await deleteRecord(key, added.id);
    expect(entries).toHaveLength(0);
  });

  it('saveRecords round-trips a full list', async () => {
    const { key } = await createVault('master123');
    const entry: VaultEntry = {
      id: 'record-1',
      createdAt: 10,
      updatedAt: 11,
      record: { ...makeRecord('A', 'pw'), id: 'record-1' },
    };
    await saveRecords(key, [entry]);
    const loaded = await loadRecords(key);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].record.name).toBe('A');
  });
});
