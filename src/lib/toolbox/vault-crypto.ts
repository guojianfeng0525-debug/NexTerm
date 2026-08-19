/**
 * Vault cryptography — AES-GCM encryption of the records notebook.
 *
 * Records live in the normalized `vault_records` table — one row per record —
 * with every sensitive field (name, address, username, password, notes)
 * encrypted individually with the app-password-derived key. The vault meta
 * blob (salt + iterations + verifier ciphertext — no plaintext) lives in the
 * `app_settings` single-row table.
 */
import type { VaultMeta, VaultRecord } from './toolbox-types';
import { rowList, rowUpsert, rowDelete, encField, decField } from './db';
import { getVaultMetaColumns, setVaultMetaColumns } from '../preferences';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const VERIFIER_CONSTANT = 'nexterm-vault:v1';
const DEFAULT_ITERATIONS = 150_000;
const IV_LENGTH = 12; // bytes, AES-GCM standard

// In-memory mirrors so the sync getters keep working before async loads.
let metaCache: VaultMeta | null = null;
let entriesCache: VaultEntry[] | null = null;
let hydrated = false;

/** A decrypted vault record plus its timestamps. */
export interface VaultEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Decrypted record (only present while the vault is unlocked). */
  record: VaultRecord;
}

/* ── base64 helpers (WebCrypto / browser-safe) ───────────────────────────── */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/* ── key derivation ───────────────────────────────────────────────────────── */

export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* ── AES-GCM payload helpers: payload = base64(iv ‖ ciphertext) ──────────── */

export async function encryptPayload(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return bytesToBase64(combined);
}

export async function decryptPayload(key: CryptoKey, payload: string): Promise<string> {
  const combined = base64ToBytes(payload);
  const iv = combined.subarray(0, IV_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/* ── vault lifecycle (legacy master-password flow, kept for tests) ───────── */

export function isVaultCreated(): boolean {
  return metaCache !== null;
}

export function getVaultMeta(): VaultMeta | null {
  return metaCache;
}

async function loadVaultMeta(): Promise<VaultMeta | null> {
  const cols = getVaultMetaColumns();
  if (cols.salt && cols.verifier) {
    const parsed: VaultMeta = {
      salt: typeof cols.salt === 'string' ? cols.salt : '',
      iterations: typeof cols.iterations === 'number' ? cols.iterations : DEFAULT_ITERATIONS,
      verifier: typeof cols.verifier === 'string' ? cols.verifier : '',
      kdf: 'pbkdf2-sha256',
      cipher: 'aes-gcm',
      createdAt: (cols.createdAt as number) ?? 0,
      updatedAt: (cols.updatedAt as number) ?? 0,
    };
    metaCache = parsed;
    return parsed;
  }
  return null;
}

async function storeVaultMeta(meta: VaultMeta): Promise<void> {
  metaCache = meta;
  setVaultMetaColumns({
    salt: meta.salt,
    iterations: meta.iterations,
    verifier: meta.verifier,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  });
}

/** Preload vault metadata + records from SQLite (post-unlock). */
export async function hydrateVaultStorage(): Promise<void> {
  hydrated = true;
  await loadVaultEntries();
  await loadVaultMeta();
}

async function buildVerifier(key: CryptoKey): Promise<string> {
  return encryptPayload(key, VERIFIER_CONSTANT);
}

async function checkVerifier(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    const text = await decryptPayload(key, verifier);
    return text === VERIFIER_CONSTANT;
  } catch {
    return false;
  }
}

/** Create a brand-new vault with the given master password. */
export async function createVault(
  password: string,
): Promise<{ key: CryptoKey; meta: VaultMeta }> {
  if (password.length < 4) {
    throw new Error('Master password must be at least 4 characters');
  }
  const salt = generateSalt();
  const key = await deriveKey(password, salt, DEFAULT_ITERATIONS);
  const meta: VaultMeta = {
    salt: bytesToBase64(salt),
    iterations: DEFAULT_ITERATIONS,
    verifier: await buildVerifier(key),
    kdf: 'pbkdf2-sha256',
    cipher: 'aes-gcm',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await storeVaultMeta(meta);
  return { key, meta };
}

/** Unlock an existing vault. Returns the in-memory key, or null on wrong password. */
export async function unlockVault(password: string): Promise<CryptoKey | null> {
  const meta = (await loadVaultMeta()) ?? metaCache;
  if (!meta) return null;
  const key = await deriveKey(password, base64ToBytes(meta.salt), meta.iterations);
  const ok = await checkVerifier(key, meta.verifier);
  return ok ? key : null;
}

/** Change the master password. Records are encrypted with the app key, so
 *  only the verifier blob is re-derived. */
export async function changeVaultPassword(
  oldPassword: string,
  newPassword: string,
): Promise<CryptoKey> {
  const oldKey = await unlockVault(oldPassword);
  if (!oldKey) {
    throw new Error('Current master password is incorrect');
  }

  const salt = generateSalt();
  const newKey = await deriveKey(newPassword, salt, DEFAULT_ITERATIONS);
  const meta = (await loadVaultMeta()) ?? metaCache;
  if (meta) {
    meta.salt = bytesToBase64(salt);
    meta.iterations = DEFAULT_ITERATIONS;
    meta.verifier = await buildVerifier(newKey);
    meta.updatedAt = Date.now();
    await storeVaultMeta(meta);
  }
  return newKey;
}

/** Wipe the vault (meta + records). Requires the current password. */
export async function destroyVault(password: string): Promise<void> {
  const key = await unlockVault(password);
  if (!key) {
    throw new Error('Master password is incorrect');
  }
  await clearVaultStorage();
}

/**
 * Clear all vault storage (records + meta) from SQLite and reset the
 * in-memory mirrors.
 */
export async function clearVaultStorage(): Promise<void> {
  const current = entriesCache ?? [];
  for (const entry of current) {
    await rowDelete('vault_records', entry.id);
  }
  entriesCache = [];
  metaCache = null;
  setVaultMetaColumns(null);
}

/* ── normalized records table (vault_records, per-field encryption) ───────── */

async function entryToRowEncrypted(entry: VaultEntry): Promise<Record<string, unknown>> {
  const record = entry.record;
  return {
    id: entry.id,
    name: (await encField(record.name)) ?? '',
    address: await encField(record.address),
    username: await encField(record.username),
    password: await encField(record.password),
    category: record.category ?? null,
    notes: await encField(record.notes),
    favorite: record.favorite ? 1 : 0,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

async function rowToEntry(row: Record<string, unknown>): Promise<VaultEntry> {
  const record: VaultRecord = {
    id: str(row.id),
    name: (await decField(row.name as string)) ?? str(row.name),
    address: (await decField(row.address as string)) ?? '',
    username: (await decField(row.username as string)) ?? '',
    password: (await decField(row.password as string)) ?? '',
    notes: await decField(row.notes as string),
    category: (row.category as string) ?? undefined,
    favorite: !!row.favorite,
    createdAt: (row.created_at as number) ?? 0,
    updatedAt: (row.updated_at as number) ?? 0,
  };
  return {
    id: str(row.id),
    createdAt: (row.created_at as number) ?? 0,
    updatedAt: (row.updated_at as number) ?? 0,
    record,
  };
}

/** Load every decrypted record from the `vault_records` table. */
export async function loadVaultEntries(): Promise<VaultEntry[]> {
  if (!hydrated) return entriesCache ?? [];
  const rows = await rowList('vault_records');
  const entries = await Promise.all(rows.map(rowToEntry));
  entriesCache = entries;
  return entries;
}

/** Reset in-memory caches (used by tests for isolation). */
export function resetVaultCaches(): void {
  metaCache = null;
  entriesCache = null;
  hydrated = false;
}

/** Persist the full record list — upsert each row, delete removed rows. */
export async function saveVaultEntries(entries: VaultEntry[]): Promise<void> {
  const previous = entriesCache ?? [];
  const removedIds = new Set(previous.map(e => e.id));
  for (const e of entries) removedIds.delete(e.id);
  entriesCache = entries;
  if (!hydrated) return;
  await Promise.all([
    ...entries.map(async (e) => rowUpsert('vault_records', await entryToRowEncrypted(e))),
    ...[...removedIds].map(async (id) => rowDelete('vault_records', id)),
  ]);
}
