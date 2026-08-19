import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory SQLite stand-in for the row API.
const { store } = vi.hoisted(() => {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  return { store };
});

vi.mock('@/lib/toolbox/db', () => ({
  rowList: vi.fn(async (table: string) => [...(store.get(table) ?? new Map()).values()]),
  rowUpsert: vi.fn(async (table: string, row: Record<string, unknown>) => {
    const pk = table === 'command_usage' || table === 'command_history' ? 'command' : (row.id !== undefined ? 'id' : 'node_id');
    const key = String(row[pk]);
    if (!store.has(table)) store.set(table, new Map());
    store.get(table)!.set(key, row);
  }),
  rowClear: vi.fn(async (table: string) => store.set(table, new Map())),
}));

import { reencryptAll } from '@/lib/reencrypt';
import { deriveKey, encryptPayload, decryptPayload } from '@/lib/toolbox/vault-crypto';

function makeKey(pw: string): Promise<CryptoKey> {
  return deriveKey(pw, new Uint8Array(16), 1000);
}

describe('reencryptAll', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('re-encrypts connection passwords so the new key works and the old key does not', async () => {
    const oldKey = await makeKey('old-pass');
    const newKey = await makeKey('new-pass');

    store.set('connections', new Map([
      ['c1', { id: 'c1', name: 'Server', host: '1.2.3.4', password: await encryptPayload(oldKey, 'hunter2'), vnc_password: null }],
    ]));

    await reencryptAll(oldKey, newKey);

    const row = store.get('connections')!.get('c1')!;
    expect(await decryptPayload(newKey, row.password as string)).toBe('hunter2');
    await expect(decryptPayload(oldKey, row.password as string)).rejects.toThrow();
  });

  it('rebuilds command tables (encrypted primary keys) without leftovers', async () => {
    const oldKey = await makeKey('old-pass');
    const newKey = await makeKey('new-pass');

    const cipher = await encryptPayload(oldKey, 'ps -ef');
    store.set('command_history', new Map([
      [cipher, { command: cipher, count: 3, last_used: 1 }],
    ]));

    await reencryptAll(oldKey, newKey);

    const rows = [...(store.get('command_history')!.values())];
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(await decryptPayload(newKey, rows[0].command as string)).toBe('ps -ef');
  });

  it('leaves undecryptable rows untouched', async () => {
    const oldKey = await makeKey('old-pass');
    const newKey = await makeKey('new-pass');

    store.set('notes', new Map([
      ['n1', { id: 'n1', title: 'garbage', content: 'not-a-cipher' }],
    ]));

    await reencryptAll(oldKey, newKey);
    expect(store.get('notes')!.get('n1')!.content).toBe('not-a-cipher');
  });
});
