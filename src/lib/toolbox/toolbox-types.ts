/**
 * Shared type definitions for the NexTerm Toolbox.
 *
 * The Toolbox bundles five productivity tools:
 *   1. 常用应用 (Apps)      — card grid of local applications, one-click launch
 *   2. 记录本 (Vault)       — encrypted username/password records
 *   3. 远程隧道 (Tunnels)   — forward a local port to a remote host:port
 *   4. 本地服务 (Services)  — one-click start/stop of local middleware
 *   5. 记事本 (Notes)       — text notes with syntax highlighting
 */

/* ── 1. Apps ─────────────────────────────────────────────────────────────── */

export interface ToolboxApp {
  id: string;
  /** Display name shown on the card. */
  name: string;
  /** Absolute path to the executable / .app bundle / document. */
  path: string;
  /** Optional command-line arguments passed to the app. */
  args?: string;
  /** Optional working directory for the launched process. */
  cwd?: string;
  /** Optional emoji icon (e.g. "🚀"). When empty a generated letter avatar is used. */
  icon?: string;
  /** Optional path to an icon image file; takes precedence over `icon`. */
  iconPath?: string;
  /** One-line description shown under the name. */
  description?: string;
  /** Optional category used to group apps in the grid. */
  category?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LaunchAppResult {
  success: boolean;
  /** Error message when success is false. */
  error?: string;
}

/* ── 2. Vault (records) ──────────────────────────────────────────────────── */

/** Plain-text record shape — only ever held in memory while the vault is unlocked. */
export interface VaultRecord {
  id: string;
  /** Record name / title (e.g. "GitHub"). */
  name: string;
  /** Address — URL, server host or any location string. */
  address: string;
  username: string;
  password: string;
  /** Optional free-form notes. */
  notes?: string;
  /** Optional category tag used for grouping / filtering. */
  category?: string;
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Metadata describing how the vault key is derived (stored in plain SQLite). */
export interface VaultMeta {
  /** Base64 salt for PBKDF2. */
  salt: string;
  /** PBKDF2 iteration count. */
  iterations: number;
  /** AES-GCM payload (iv + ciphertext) of a known constant, used to verify the master password. */
  verifier: string;
  /** KDF: PBKDF2-SHA256 (currently the only supported option; kept for future migration). */
  kdf: 'pbkdf2-sha256';
  /** Cipher: AES-GCM (kept for future migration). */
  cipher: 'aes-gcm';
  /** When the vault was created. */
  createdAt: number;
  /** When the master password was last changed. */
  updatedAt: number;
}

/** A record as persisted on disk: only the id and an opaque encrypted blob. */
export interface EncryptedRecord {
  id: string;
  /** Base64(iv ‖ ciphertext) of the JSON-serialized VaultRecord. */
  data: string;
  createdAt: number;
  updatedAt: number;
}

/* ── 3. Tunnels ──────────────────────────────────────────────────────────── */

export interface TunnelConfig {
  id: string;
  name: string;
  /** Optional group used for filtering / batch operations. */
  group?: string;
  /** Local bind address, e.g. "127.0.0.1" or "0.0.0.0". */
  bindAddress: string;
  /** Local port that receives connections. */
  listenPort: number;
  /** Remote host to forward to. */
  remoteHost: string;
  /** Remote port to forward to. */
  remotePort: number;
  /** Optional SSH jump host the remote connection is tunnelled through. */
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPassword?: string;
  /** User-approved SSH host-key fingerprint for the jump host. */
  jumpHostKeyFingerprint?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TunnelStatus {
  id: string;
  active: boolean;
  /** Set when the tunnel failed to start. */
  error?: string;
}

export interface TunnelActivity {
  id: string;
  message: string;
  timestamp: number;
}

/* ── 4. Services ─────────────────────────────────────────────────────────── */

export interface ServiceConfig {
  id: string;
  name: string;
  /** Optional group used for filtering / batch operations. */
  group?: string;
  /** Full command line run through the platform shell (e.g. "npm run dev"). */
  command: string;
  /** Optional extra arguments appended to the command line. */
  args?: string;
  /** Optional working directory for the process. */
  cwd?: string;
  /** Optional environment variables as "KEY=VALUE" strings. */
  env?: string[];
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceStatus {
  id: string;
  running: boolean;
  pid?: number;
  startedAt?: number;
}

export interface ServiceOutputEvent {
  id: string;
  line: string;
  /** "stdout" or "stderr". */
  stream: 'stdout' | 'stderr';
}

export interface ServiceLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
}

/* ── 4b. Service orchestrations ─────────────────────────────────────────── */

/** One step of a service orchestration: reference to a tunnel or a service. */
export interface OrchestrationItem {
  /** 'tunnel' | 'service' — which kind of config this step starts. */
  kind: 'tunnel' | 'service';
  /** id of the referenced TunnelConfig / ServiceConfig. */
  id: string;
}

/**
 * An ordered runbook: "start tunnel A, then service B, then service C".
 * Items are executed strictly in order; a failure stops the run.
 */
export interface ServiceOrchestration {
  id: string;
  name: string;
  /** Ordered steps. */
  items: OrchestrationItem[];
  createdAt: number;
  updatedAt: number;
}

/* ── 5. Notes ────────────────────────────────────────────────────────────── */

/** Languages supported by the notes editor. */
export type NoteLanguage =
  | 'plain'
  | 'sql'
  | 'shell'
  | 'cmd'
  | 'powershell'
  | 'json'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'markdown'
  | 'yaml'
  | 'xml'
  | 'html'
  | 'css'
  | 'rust'
  | 'cpp'
  | 'java';

export interface NoteItem {
  id: string;
  title: string;
  language: NoteLanguage;
  content: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ── Toolbox tab view ids ────────────────────────────────────────────────── */

export type ToolboxViewId = 'apps' | 'vault' | 'tunnels' | 'services' | 'notes' | 'history' | 'documents' | 'jar' | 'postgres' | 'sqlite' | 'mysql';

export const TOOLBOX_VIEW_IDS: ToolboxViewId[] = ['apps', 'vault', 'tunnels', 'services', 'notes', 'history', 'documents', 'jar', 'postgres', 'sqlite', 'mysql'];
