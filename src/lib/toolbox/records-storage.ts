/**
 * Encrypted record CRUD for the vault.
 *
 * Records live in the normalized `vault_records` table with per-field
 * encryption; these helpers keep the synchronous-style API used by the UI.
 */
import type { VaultRecord } from './toolbox-types';
import { loadVaultEntries, saveVaultEntries, type VaultEntry } from './vault-crypto';
import { generateId } from './toolbox-storage';

export type { VaultEntry } from './vault-crypto';

/** Decrypt every stored record. Returns [] when nothing is stored. */
export async function loadRecords(_key: CryptoKey): Promise<VaultEntry[]> {
  return loadVaultEntries();
}

/** Save a full list of decrypted records, encrypting each field. */
export async function saveRecords(_key: CryptoKey, entries: VaultEntry[]): Promise<void> {
  await saveVaultEntries(entries);
}

/** Create a new record and persist it. Returns the stored entry. */
export async function addRecord(
  key: CryptoKey,
  input: Omit<VaultRecord, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<VaultEntry> {
  const entries = await loadRecords(key);
  const now = Date.now();
  const entry: VaultEntry = {
    id: generateId('record'),
    createdAt: now,
    updatedAt: now,
    record: { ...input, id: '', createdAt: now, updatedAt: now },
  };
  entry.record.id = entry.id;
  entries.push(entry);
  await saveRecords(key, entries);
  return entry;
}

/** Update an existing record. */
export async function updateRecord(
  key: CryptoKey,
  id: string,
  patch: Partial<Omit<VaultRecord, 'id' | 'createdAt'>>,
): Promise<VaultEntry[]> {
  const entries = await loadRecords(key);
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) return entries;
  entries[index] = {
    ...entries[index],
    updatedAt: Date.now(),
    record: { ...entries[index].record, ...patch, id, updatedAt: Date.now() },
  };
  await saveRecords(key, entries);
  return entries;
}

/** Delete a record. */
export async function deleteRecord(key: CryptoKey, id: string): Promise<VaultEntry[]> {
  const entries = await loadRecords(key);
  const next = entries.filter((e) => e.id !== id);
  await saveRecords(key, next);
  return next;
}
