/**
 * Connection import/export (B22).
 *
 * Export produces a single JSON file (`nexterm-connections` format v1). By
 * default secrets are stripped (passwords/keys are never written in plain
 * text); optionally the user may pick a passphrase and the secret fields are
 * AES-GCM encrypted with a PBKDF2-derived key (reusing vault-crypto's
 * `encryptPayload` envelope: `v1:<base64(iv‖ciphertext)>`).
 *
 * Import validates the file strictly (size / nesting depth / field
 * whitelist / prototype keys / group & color formats) before any connection
 * is touched. It never executes SQL and never leaks file content in errors.
 */
import {
  adaptPostgreSQLPersistedProfile,
  toPostgreSQLPersistedProfile,
  type PostgreSQLConnectionProfile,
  type PostgreSQLPersistedProfile,
} from "./database/postgresql-profile-adapter";
import { base64ToBytes, bytesToBase64, decryptPayload, deriveKey, encryptPayload, generateSalt } from "./toolbox/vault-crypto";

export const CONNECTIONS_FILE_FORMAT = "nexterm-connections" as const;
export const CONNECTIONS_FILE_VERSION = 1 as const;
export const CONNECTIONS_FILE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_NESTING_DEPTH = 8;
const DEFAULT_KDF_ITERATIONS = 150_000;

/** Secret profile fields that must never be exported in plain text. */
export const CONNECTION_SECRET_FIELDS = [
  "password",
  "sslClientKey",
  "sslKeyPassphrase",
  "sshPassword",
  "sshPrivateKey",
  "sshPrivateKeyPassphrase",
] as const;

export type ConnectionSecretField = (typeof CONNECTION_SECRET_FIELDS)[number];

/** Known persisted-profile fields (whitelist for import). */
const PROFILE_FIELDS = new Set<string>([
  "id", "name", "group", "environment",
  "host", "port", "database", "username", "password",
  "color", "defaultSchema", "readOnly", "autoCommit",
  "sslMode", "sslRootCert", "sslClientCert", "sslClientKey", "sslKeyPassphrase",
  "sshEnabled", "sshConnectionId", "sshHost", "sshPort", "sshUsername",
  "sshAuthMethod", "sshPassword", "sshPrivateKey", "sshPrivateKeyPath",
  "sshPrivateKeyPassphrase", "sshHostKeyFingerprint",
  "createdAt", "updatedAt",
]);

const VALID_ENVIRONMENTS = new Set(["development", "test", "production"]);

/** Marker written next to stripped secret fields on plaintext exports. */
export const HAS_PASSWORD_MARKER = "__hasPassword";

export interface ConnectionsExportOptions {
  /** When set, secret fields are AES-GCM encrypted with this passphrase. */
  readonly encryptWithPassphrase?: string;
}

export interface ConnectionsFileEnvelope {
  readonly format: typeof CONNECTIONS_FILE_FORMAT;
  readonly version: typeof CONNECTIONS_FILE_VERSION;
  readonly exportedAt: string;
  readonly credentialsEncrypted: boolean;
  readonly kdf?: { readonly salt: string; readonly iterations: number };
  readonly connections: readonly PostgreSQLPersistedProfile[];
}

export type ConnectionMergeMode = "append" | "overwrite";

export interface ImportedConnection {
  readonly profile: PostgreSQLConnectionProfile;
  /** Original (decrypted) secret fields; undefined when not exported. */
  readonly secrets?: Partial<Record<ConnectionSecretField, string>>;
}

export interface ImportConnectionsResult {
  readonly connections: readonly ImportedConnection[];
  /** Imported entries whose secret decryption failed (wrong passphrase). */
  readonly secretFailures: readonly number[];
}

/* ── validation helpers (shared with storage, per security constraints) ──── */

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates a virtual group name. Length ≤128, no `/` `\` `..`, no control
 * characters (used as a group header label only; must never become a path).
 */
export function isValidGroupName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  if (hasControlChars(name)) return false;
  return true;
}

/** Validates an accent color; only `#RRGGBB` hex values are accepted. */
export function isValidColor(color: string): boolean {
  return COLOR_PATTERN.test(color);
}

/* ── export ──────────────────────────────────────────────────────────────── */

async function buildEncryptionKey(
  passphrase: string,
  salt?: Uint8Array,
  iterations?: number,
): Promise<{ key: CryptoKey; saltB64: string; iterations: number }> {
  const effectiveSalt = salt ?? generateSalt();
  const effectiveIterations = iterations ?? DEFAULT_KDF_ITERATIONS;
  const key = await deriveKey(passphrase, effectiveSalt, effectiveIterations);
  return { key, saltB64: bytesToBase64(effectiveSalt), iterations: effectiveIterations };
}

/**
 * Serializes connections to the `nexterm-connections` JSON text. Secret
 * fields are either stripped (plaintext export, marked `__hasPassword`) or
 * AES-GCM encrypted (passphrase export) — never written in plain text.
 */
export async function serializeConnectionsExport(
  profiles: readonly PostgreSQLConnectionProfile[],
  options: ConnectionsExportOptions = {},
): Promise<string> {
  const encryptWithPassphrase = options.encryptWithPassphrase;
  const kdf = encryptWithPassphrase
    ? await buildEncryptionKey(encryptWithPassphrase)
    : undefined;
  const key = kdf?.key;

  const connections: PostgreSQLPersistedProfile[] = [];
  for (const profile of profiles) {
    const persisted = { ...toPostgreSQLPersistedProfile(profile) } as Record<string, unknown>;
    for (const field of CONNECTION_SECRET_FIELDS) {
      const value = persisted[field];
      if (typeof value === "string" && value.length > 0) {
        if (key) {
          persisted[field] = `v1:${await encryptPayload(key, value)}`;
        } else {
          persisted[field] = "";
          persisted[`${HAS_PASSWORD_MARKER}:${field}`] = true;
        }
      }
    }
    connections.push(persisted as unknown as PostgreSQLPersistedProfile);
  }

  const envelope: ConnectionsFileEnvelope = {
    format: CONNECTIONS_FILE_FORMAT,
    version: CONNECTIONS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    credentialsEncrypted: !!encryptWithPassphrase,
    ...(kdf ? { kdf: { salt: kdf.saltB64, iterations: kdf.iterations } } : {}),
    connections,
  };
  return JSON.stringify(envelope, null, 2);
}

/* ── import ──────────────────────────────────────────────────────────────── */

function checkNestingDepth(value: unknown, depth: number): void {
  if (depth > MAX_NESTING_DEPTH) throw new Error("invalid import file");
  if (Array.isArray(value)) {
    for (const item of value) checkNestingDepth(item, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [, item] of Object.entries(value)) checkNestingDepth(item, depth + 1);
  }
}

/** Copy only whitelisted fields; unknown keys and prototype-pollution keys are dropped. */
function pickWhitelistedFields(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (!PROFILE_FIELDS.has(key)) continue;
    clean[key] = raw[key];
  }
  return clean;
}

function validateProfile(raw: Record<string, unknown>): PostgreSQLPersistedProfile {
  const clean = pickWhitelistedFields(raw);
  const name = clean.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("invalid import file: missing connection name");
  }
  const environment = typeof clean.environment === "string" ? clean.environment : "development";
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new Error("invalid import file: unknown environment");
  }
  const group = clean.group;
  if (typeof group === "string" && group !== "" && !isValidGroupName(group)) {
    throw new Error("invalid import file: invalid group name");
  }
  const color = clean.color;
  if (typeof color === "string" && color !== "" && !isValidColor(color)) {
    throw new Error("invalid import file: invalid color");
  }
  const sslMode = typeof clean.sslMode === "string" ? clean.sslMode : "prefer";
  const knownSslModes = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];
  if (!knownSslModes.includes(sslMode)) {
    throw new Error("invalid import file: unknown ssl mode");
  }
  const sshAuthMethod = clean.sshAuthMethod;
  if (sshAuthMethod != null && sshAuthMethod !== "password" && sshAuthMethod !== "privateKey") {
    throw new Error("invalid import file: unknown ssh auth method");
  }
  return {
    id: typeof clean.id === "string" ? clean.id : "",
    name: String(name),
    group: typeof clean.group === "string" && clean.group ? String(clean.group) : undefined,
    environment: environment as PostgreSQLPersistedProfile["environment"],
    host: typeof clean.host === "string" ? clean.host : "",
    port: typeof clean.port === "number" ? clean.port : 5432,
    database: typeof clean.database === "string" ? clean.database : "",
    username: typeof clean.username === "string" ? clean.username : "",
    password: typeof clean.password === "string" ? clean.password : undefined,
    color: typeof clean.color === "string" && clean.color ? String(clean.color) : undefined,
    defaultSchema: typeof clean.defaultSchema === "string" && clean.defaultSchema ? String(clean.defaultSchema) : undefined,
    readOnly: !!clean.readOnly,
    autoCommit: clean.autoCommit !== false,
    sslMode: sslMode as PostgreSQLPersistedProfile["sslMode"],
    sslRootCert: typeof clean.sslRootCert === "string" && clean.sslRootCert ? String(clean.sslRootCert) : undefined,
    sslClientCert: typeof clean.sslClientCert === "string" && clean.sslClientCert ? String(clean.sslClientCert) : undefined,
    sslClientKey: typeof clean.sslClientKey === "string" ? clean.sslClientKey : undefined,
    sslKeyPassphrase: typeof clean.sslKeyPassphrase === "string" ? clean.sslKeyPassphrase : undefined,
    sshEnabled: !!clean.sshEnabled,
    sshConnectionId: typeof clean.sshConnectionId === "string" && clean.sshConnectionId ? String(clean.sshConnectionId) : undefined,
    sshHost: typeof clean.sshHost === "string" && clean.sshHost ? String(clean.sshHost) : undefined,
    sshPort: typeof clean.sshPort === "number" ? clean.sshPort : undefined,
    sshUsername: typeof clean.sshUsername === "string" && clean.sshUsername ? String(clean.sshUsername) : undefined,
    sshAuthMethod: sshAuthMethod === "password" || sshAuthMethod === "privateKey" ? sshAuthMethod : undefined,
    sshPassword: typeof clean.sshPassword === "string" ? clean.sshPassword : undefined,
    sshPrivateKey: typeof clean.sshPrivateKey === "string" ? clean.sshPrivateKey : undefined,
    sshPrivateKeyPath: typeof clean.sshPrivateKeyPath === "string" && clean.sshPrivateKeyPath ? String(clean.sshPrivateKeyPath) : undefined,
    sshPrivateKeyPassphrase: typeof clean.sshPrivateKeyPassphrase === "string" ? clean.sshPrivateKeyPassphrase : undefined,
    sshHostKeyFingerprint: typeof clean.sshHostKeyFingerprint === "string" && clean.sshHostKeyFingerprint ? String(clean.sshHostKeyFingerprint) : undefined,
    createdAt: typeof clean.createdAt === "number" ? clean.createdAt : Date.now(),
    updatedAt: typeof clean.updatedAt === "number" ? clean.updatedAt : Date.now(),
  };
}

function isSecretEnvelope(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("v1:");
}

/**
 * Parses and validates an exported connections file. Returns profiles with
 * decrypted secrets when the file was passphrase-encrypted and the correct
 * passphrase is supplied. Never mutates storage.
 */
export async function parseConnectionsImport(
  text: string,
  passphrase?: string,
): Promise<ImportConnectionsResult> {
  if (typeof text !== "string" || text.length === 0 || text.length > CONNECTIONS_FILE_MAX_BYTES) {
    throw new Error("invalid import file: file too large or empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid import file");
  }
  checkNestingDepth(parsed, 0);

  if (!parsed || typeof parsed !== "object") throw new Error("invalid import file");
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== CONNECTIONS_FILE_FORMAT || envelope.version !== CONNECTIONS_FILE_VERSION) {
    throw new Error("invalid import file: unsupported format");
  }
  if (!Array.isArray(envelope.connections)) {
    throw new Error("invalid import file: missing connections");
  }

  const credentialsEncrypted = envelope.credentialsEncrypted === true;
  let key: CryptoKey | undefined;
  if (credentialsEncrypted) {
    const kdf = envelope.kdf as Record<string, unknown> | undefined;
    if (!kdf || typeof kdf.salt !== "string" || typeof kdf.iterations !== "number") {
      throw new Error("invalid import file: missing key metadata");
    }
    if (!passphrase) throw new Error("passphrase required");
    key = await deriveKey(passphrase, base64ToBytes(kdf.salt), kdf.iterations);
  }

  const connections: ImportedConnection[] = [];
  const secretFailures: number[] = [];
  for (let index = 0; index < envelope.connections.length; index++) {
    const raw = envelope.connections[index];
    if (!raw || typeof raw !== "object") throw new Error("invalid import file");
    const persisted = validateProfile(raw as Record<string, unknown>);

    const secrets: Partial<Record<ConnectionSecretField, string>> = {};
    for (const field of CONNECTION_SECRET_FIELDS) {
      const value = (raw as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) {
        if (isSecretEnvelope(value)) {
          if (!key) {
            // A plaintext export would never contain `v1:` envelopes — treat
            // as corrupted data and keep the connection without this secret.
            continue;
          }
          try {
            secrets[field] = await decryptPayload(key, value.slice(3));
          } catch {
            secretFailures.push(index);
            continue;
          }
        } else if (credentialsEncrypted) {
          // Encrypted export must not contain plaintext secrets.
          secretFailures.push(index);
          continue;
        } else {
          // Plaintext import (e.g. hand-authored file): secrets are carried
          // as-is; the storage layer re-encrypts them with encField.
          secrets[field] = value;
        }
      }
    }

    // Replace profile secret fields with decrypted values (empty when absent).
    // Strip any leftover ciphertext/placeholder so storage never persists a
    // secret twice (decrypt → encField only on real values).
    const cleanProfile = { ...persisted } as Record<string, unknown>;
    for (const field of CONNECTION_SECRET_FIELDS) {
      if (!secrets[field]) cleanProfile[field] = undefined;
    }
    connections.push({
      profile: adaptPostgreSQLPersistedProfile(cleanProfile as unknown as PostgreSQLPersistedProfile),
      secrets: Object.keys(secrets).length ? secrets : undefined,
    });
  }

  return { connections, secretFailures: [...new Set(secretFailures)] };
}

/**
 * Applies a merge strategy to existing profiles. `append` skips profiles with
 * an existing name; `overwrite` replaces them (keeping the imported config).
 */
export function mergeConnections(
  current: readonly PostgreSQLConnectionProfile[],
  imported: readonly PostgreSQLConnectionProfile[],
  mode: ConnectionMergeMode,
): PostgreSQLConnectionProfile[] {
  const next = [...current];
  for (const profile of imported) {
    const existingIndex = next.findIndex((item) => item.name === profile.name);
    if (existingIndex === -1) {
      next.push(profile);
    } else if (mode === "overwrite") {
      next[existingIndex] = profile;
    }
  }
  return next;
}
