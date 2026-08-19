/**
 * Full re-encryption of every sensitive field with a new app-password key.
 *
 * Used when the app-lock password is changed: all data encrypted under the
 * old key (connections passwords, vault fields, command history, notes, API
 * debugger requests, ...) must be decrypted with the old key and re-encrypted
 * with the new one, otherwise the new password could never unlock them.
 *
 * `command_usage` / `command_history` use the encrypted command text as their
 * primary key, so they are rebuilt from scratch (clear + insert) instead of
 * upserting.
 */
import { rowList, rowUpsert, rowClear, type DbTable, type Row } from './toolbox/db';
import { encryptPayload, decryptPayload } from './toolbox/vault-crypto';

/** Per-table lists of encrypted columns (must match the storage modules). */
const ENCRYPTED_FIELDS: Record<string, string[]> = {
  connections: ['password', 'passphrase', 'proxy_password', 'jump_password', 'vnc_password'],
  profiles: ['password'],
  vault_records: ['name', 'address', 'username', 'password', 'notes'],
  notes: ['title', 'content'],
  tunnels: ['jump_password'],
  api_collections: ['request'],
  api_environments: ['variables'],
};

/** Tables whose primary key is itself encrypted — rebuilt wholesale. */
const REBUILD_TABLES: DbTable[] = ['command_usage', 'command_history'];

export async function reencryptAll(oldKey: CryptoKey, newKey: CryptoKey): Promise<void> {
  // Rebuild encrypted-PK tables first.
  for (const table of REBUILD_TABLES) {
    const rows = await rowList(table);
    if (rows.length === 0) continue;
    const rebuilt: Row[] = [];
    for (const row of rows) {
      const field = table === 'command_usage' ? 'command' : 'command';
      const cipher = row[field];
      if (typeof cipher === 'string' && cipher) {
        try {
          const plain = await decryptPayload(oldKey, cipher);
          row[field] = await encryptPayload(newKey, plain);
        } catch {
          // Undecryptable (already orphaned) — drop it.
          continue;
        }
      }
      rebuilt.push(row);
    }
    await rowClear(table);
    for (const row of rebuilt) {
      await rowUpsert(table, row);
    }
  }

  // Upsert the remaining tables field-by-field.
  for (const [tableName, fields] of Object.entries(ENCRYPTED_FIELDS)) {
    const table = tableName as DbTable;
    const rows = await rowList(table);
    for (const row of rows) {
      const next = { ...row };
      let changed = false;
      for (const field of fields) {
        const value = next[field];
        if (typeof value === 'string' && value) {
          try {
            const plain = await decryptPayload(oldKey, value);
            next[field] = await encryptPayload(newKey, plain);
            changed = true;
          } catch {
            // Keep the original ciphertext (cannot be decrypted with the old key).
          }
        }
      }
      if (changed) {
        await rowUpsert(table, next);
      }
    }
  }
}
