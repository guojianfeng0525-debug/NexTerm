/**
 * App lock — a startup password gate for the whole application.
 *
 * The unlock password is never stored. Like the vault, we derive an AES-GCM
 * key via PBKDF2-SHA256 from the password and store only a salted verifier.
 * The verifier blob lives in the normalized single-row `app_lock` table.
 */
import {
  base64ToBytes,
  bytesToBase64,
  decryptPayload,
  deriveKey,
  encryptPayload,
  generateSalt,
} from './vault-crypto';
import { rowGet, rowUpsert } from './db';
import { reencryptAll } from '../reencrypt';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const VERIFIER_CONSTANT = 'nexterm-applock:v1';
const ITERATIONS = 150_000;

interface AppLockMeta {
  salt: string;
  iterations: number;
  verifier: string;
  createdAt: number;
}

/**
 * The AES-GCM key derived from the app password, kept in memory after unlock.
 * The vault (records notebook) reuses this key so records stay encrypted with
 * the app password and need no separate password gate.
 */
let memoryKey: CryptoKey | null = null;

// In-memory mirror of the meta blob + whether it was hydrated from SQLite.
let meta: AppLockMeta | null = null;
let metaHydrated = false;

async function loadMeta(): Promise<AppLockMeta | null> {
  try {
    const row = await rowGet('app_lock', '1');
    if (row && row.salt && row.verifier) {
      return {
        salt: str(row.salt),
        iterations: (row.iterations as number) ?? ITERATIONS,
        verifier: str(row.verifier),
        createdAt: (row.created_at as number) ?? 0,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Persist the lock meta. Returns true when the SQLite write succeeded. */
async function storeMeta(next: AppLockMeta): Promise<boolean> {
  const ok = await rowUpsert('app_lock', {
    id: 1,
    salt: next.salt,
    iterations: next.iterations,
    verifier: next.verifier,
    created_at: next.createdAt,
  });
  if (ok) {
    meta = next;
  }
  return ok;
}

/** Load the lock meta into memory (called by the lock screen on mount). */
export async function hydrateAppLockMeta(): Promise<void> {
  meta = await loadMeta();
  metaHydrated = true;
}

/** Whether an unlock password has been configured. */
export function isAppLockConfigured(): boolean {
  if (metaHydrated) return meta !== null;
  return false;
}

/** Set (or reset) the unlock password. */
export async function setupAppLock(password: string): Promise<void> {
  if (password.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  const salt = generateSalt();
  const key = await deriveKey(password, salt, ITERATIONS);
  const next: AppLockMeta = {
    salt: bytesToBase64(salt),
    iterations: ITERATIONS,
    verifier: await encryptPayload(key, VERIFIER_CONSTANT),
    createdAt: Date.now(),
  };
  // First-run setup tolerates a failed SQLite write; the change-password
  // path is stricter.
  await storeMeta(next);
  memoryKey = key;
}

/** Verify a password against the stored verifier. Returns false on any error. */
export async function verifyAppLock(password: string): Promise<boolean> {
  try {
    const current = meta ?? (await loadMeta());
    if (!current) return false;
    const key = await deriveKey(password, base64ToBytes(current.salt), current.iterations);
    const text = await decryptPayload(key, current.verifier);
    if (text === VERIFIER_CONSTANT) {
      memoryKey = key;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Change the app-lock password. Verifies the current password, re-encrypts
 * every sensitive field with the new key, then replaces the stored verifier.
 * @returns true on success; false when the current password is wrong.
 */
export async function changeAppLockPassword(
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  if (newPassword.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  const ok = await verifyAppLock(currentPassword);
  if (!ok) return false;
  // verifyAppLock has now set memoryKey to the old key.
  const oldKey = getAppLockKey();
  if (!oldKey) return false;

  const salt = generateSalt();
  const newKey = await deriveKey(newPassword, salt, ITERATIONS);

  // Re-encrypt every sensitive field under the new key BEFORE swapping the
  // verifier — if this fails we must not leave the store half-migrated.
  await reencryptAll(oldKey, newKey);

  const persisted = await storeMeta({
    salt: bytesToBase64(salt),
    iterations: ITERATIONS,
    verifier: await encryptPayload(newKey, VERIFIER_CONSTANT),
    createdAt: Date.now(),
  });
  if (!persisted) {
    // The verifier could not be persisted, so the stored verifier still
    // matches the OLD key — roll the data back to the old key too, otherwise
    // the next launch verifies with the old key but cannot decrypt the
    // (new-key) data, locking the user out.
    try {
      await reencryptAll(newKey, oldKey);
    } catch {
      // Best effort: if rollback fails we still keep the old in-memory key so
      // the current session remains usable; the user is told to retry.
    }
    memoryKey = oldKey;
    throw new Error(
      'Failed to persist the new app lock configuration; data was re-encrypted and rolled back, please retry',
    );
  }
  memoryKey = newKey;
  return true;
}

/**
 * The in-memory encryption key derived from the app password (non-null only
 * after the app has been unlocked). The vault reuses it for record encryption.
 */
export function getAppLockKey(): CryptoKey | null {
  return memoryKey;
}
