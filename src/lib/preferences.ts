/**
 * UI preferences, persisted in SQLite normalized single-row tables:
 *
 * - `app_settings`        — language, theme, app settings, keyboard shortcuts,
 *                           follow-terminal-directory, show-resources, ...
 * - `layout_config`       — panel visibility/sizes + zen mode
 * - `terminal_appearance` — terminal font/cursor/theme/background
 * - `editor_config`       — code editor preferences
 *
 * These values are non-sensitive (no credentials), so they are stored as
 * plaintext columns. The module keeps an in-memory cache hydrated by
 * `hydratePreferences()` before first render (the lock screen needs the
 * correct language/theme). Reads before hydration return the fallback;
 * writes before hydration are no-ops (the app never renders UI before
 * hydration completes).
 */
import { rowGet, rowUpsert, rowDelete, legacyDbGet, type DbTable, type Row } from './toolbox/db';

type SettingsRow = Row & {
  language?: unknown;
  theme?: unknown;
  auto_reconnect?: unknown;
  log_level?: unknown;
  max_log_size?: unknown;
  save_passwords?: unknown;
  auto_lock_timeout?: unknown;
  host_key_verification?: unknown;
  enable_notifications?: unknown;
  show_connection_manager?: unknown;
  show_system_monitor?: unknown;
  show_status_bar?: unknown;
  connection_timeout?: unknown;
  keep_alive_interval?: unknown;
  default_protocol?: unknown;
  new_session_shortcut?: unknown;
  close_session_shortcut?: unknown;
  next_tab_shortcut?: unknown;
  previous_tab_shortcut?: unknown;
  follow_terminal_directory?: unknown;
  command_suggestions?: unknown;
  suggestion_debounce_ms?: unknown;
  suggestion_tui_gate_enabled?: unknown;
  show_resources?: unknown;
  api_active_env?: unknown;
};

// In-memory mirrors of the four single-row tables.
let settings: SettingsRow = {};
let layout: Row = {};
let appearance: Row = {};
let editor: Row = {};
let hydrated = false;

export function isPreferencesHydrated(): boolean {
  return hydrated;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  // SQLite INTEGER boolean columns come back as 0/1 numbers, not booleans.
  return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/* ── key → storage mapping ────────────────────────────────────────────────── */

/** Assemble the legacy `sshClientSettings` object from app_settings columns. */
function assembleSshSettings(): Record<string, unknown> {
  return {
    theme: str(settings.theme, 'dark'),
    autoReconnect: bool(settings.auto_reconnect, true),
    logLevel: str(settings.log_level, 'info'),
    maxLogSize: num(settings.max_log_size, 100),
    savePasswords: bool(settings.save_passwords, false),
    autoLockTimeout: num(settings.auto_lock_timeout, 30),
    hostKeyVerification: bool(settings.host_key_verification, true),
    enableNotifications: bool(settings.enable_notifications, true),
    showConnectionManager: bool(settings.show_connection_manager, true),
    showSystemMonitor: bool(settings.show_system_monitor, true),
    showStatusBar: bool(settings.show_status_bar, true),
    commandSuggestions: bool(settings.command_suggestions, true),
    suggestionDebounceMs: num(settings.suggestion_debounce_ms, 50),
    suggestionTuiGateEnabled: bool(settings.suggestion_tui_gate_enabled, true),
    connectionTimeout: num(settings.connection_timeout, 30),
    keepAliveInterval: num(settings.keep_alive_interval, 60),
    defaultProtocol: str(settings.default_protocol, 'SSH'),
    newSession: str(settings.new_session_shortcut, 'Ctrl+N'),
    closeSession: str(settings.close_session_shortcut, 'Ctrl+W'),
    nextTab: str(settings.next_tab_shortcut, 'Ctrl+Tab'),
    previousTab: str(settings.previous_tab_shortcut, 'Ctrl+Shift+Tab'),
  };
}

/** Split an `sshClientSettings` object back into app_settings columns. */
function applySshSettings(obj: Record<string, unknown>): void {
  settings.theme = obj.theme;
  settings.auto_reconnect = obj.autoReconnect;
  settings.log_level = obj.logLevel;
  settings.max_log_size = obj.maxLogSize;
  settings.save_passwords = obj.savePasswords;
  settings.auto_lock_timeout = obj.autoLockTimeout;
  settings.host_key_verification = obj.hostKeyVerification;
  settings.enable_notifications = obj.enableNotifications;
  settings.show_connection_manager = obj.showConnectionManager;
  settings.show_system_monitor = obj.showSystemMonitor;
  settings.show_status_bar = obj.showStatusBar;
  settings.command_suggestions = obj.commandSuggestions;
  settings.suggestion_debounce_ms = obj.suggestionDebounceMs;
  settings.suggestion_tui_gate_enabled = obj.suggestionTuiGateEnabled;
  settings.connection_timeout = obj.connectionTimeout;
  settings.keep_alive_interval = obj.keepAliveInterval;
  settings.default_protocol = obj.defaultProtocol;
  settings.new_session_shortcut = obj.newSession;
  settings.close_session_shortcut = obj.closeSession;
  settings.next_tab_shortcut = obj.nextTab;
  settings.previous_tab_shortcut = obj.previousTab;
}

function assembleLayout(): Record<string, unknown> {
  return {
    leftSidebarVisible: bool(layout.left_sidebar_visible, true),
    leftSidebarSize: num(layout.left_sidebar_size, 15),
    rightSidebarVisible: bool(layout.right_sidebar_visible, true),
    rightSidebarSize: num(layout.right_sidebar_size, 20),
    bottomPanelVisible: bool(layout.bottom_panel_visible, true),
    bottomPanelSize: num(layout.bottom_panel_size, 30),
    zenMode: bool(layout.zen_mode, false),
  };
}

function applyLayout(obj: Record<string, unknown>): void {
  layout.left_sidebar_visible = obj.leftSidebarVisible;
  layout.left_sidebar_size = obj.leftSidebarSize;
  layout.right_sidebar_visible = obj.rightSidebarVisible;
  layout.right_sidebar_size = obj.rightSidebarSize;
  layout.bottom_panel_visible = obj.bottomPanelVisible;
  layout.bottom_panel_size = obj.bottomPanelSize;
  layout.zen_mode = obj.zenMode;
}

function assembleAppearance(): Record<string, unknown> {
  return {
    fontSize: num(appearance.font_size, 14),
    fontFamily: str(appearance.font_family, 'Menlo, Monaco, monospace'),
    lineHeight: num(appearance.line_height, 1.2),
    letterSpacing: num(appearance.letter_spacing, 0),
    cursorStyle: str(appearance.cursor_style, 'block'),
    cursorBlink: bool(appearance.cursor_blink, true),
    theme: str(appearance.theme, 'vs-code-dark'),
    scrollback: num(appearance.scrollback, 10000),
    allowTransparency: bool(appearance.allow_transparency, false),
    opacity: num(appearance.opacity, 1),
    backgroundImage: str(appearance.background_image, ''),
    backgroundImageOpacity: num(appearance.background_image_opacity, 100),
    backgroundImageBlur: num(appearance.background_image_blur, 0),
    backgroundImagePosition: str(appearance.background_image_position, 'cover'),
  };
}

function applyAppearance(obj: Record<string, unknown>): void {
  appearance.font_size = obj.fontSize;
  appearance.font_family = obj.fontFamily;
  appearance.line_height = obj.lineHeight;
  appearance.letter_spacing = obj.letterSpacing;
  appearance.cursor_style = obj.cursorStyle;
  appearance.cursor_blink = obj.cursorBlink;
  appearance.theme = obj.theme;
  appearance.scrollback = obj.scrollback;
  appearance.allow_transparency = obj.allowTransparency;
  appearance.opacity = obj.opacity;
  appearance.background_image = obj.backgroundImage;
  appearance.background_image_opacity = obj.backgroundImageOpacity;
  appearance.background_image_blur = obj.backgroundImageBlur;
  appearance.background_image_position = obj.backgroundImagePosition;
}

function assembleEditor(): Record<string, unknown> {
  return {
    theme: str(editor.theme, 'oneDark'),
    fontSize: num(editor.font_size, 14),
    fontFamily: str(editor.font_family, "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace"),
    lineNumbers: bool(editor.line_numbers, true),
    wordWrap: bool(editor.word_wrap, true),
    tabSize: num(editor.tab_size, 2),
    highlightActiveLine: bool(editor.highlight_active_line, true),
    foldGutter: bool(editor.fold_gutter, true),
    bracketMatching: bool(editor.bracket_matching, true),
    matchBrackets: bool(editor.match_brackets, true),
  };
}

function applyEditor(obj: Record<string, unknown>): void {
  editor.theme = obj.theme;
  editor.font_size = obj.fontSize;
  editor.font_family = obj.fontFamily;
  editor.line_numbers = obj.lineNumbers;
  editor.word_wrap = obj.wordWrap;
  editor.tab_size = obj.tabSize;
  editor.highlight_active_line = obj.highlightActiveLine;
  editor.fold_gutter = obj.foldGutter;
  editor.bracket_matching = obj.bracketMatching;
  editor.match_brackets = obj.matchBrackets;
}

/* ── persistence ──────────────────────────────────────────────────────────── */

function persistSettings(): void {
  void rowUpsert('app_settings', { ...settings, id: 1, updated_at: Date.now() });
}
function persistLayout(): void {
  void rowUpsert('layout_config', { ...layout, id: 1, updated_at: Date.now() });
}
function persistAppearance(): void {
  void rowUpsert('terminal_appearance', { ...appearance, id: 1, updated_at: Date.now() });
}
function persistEditor(): void {
  void rowUpsert('editor_config', { ...editor, id: 1, updated_at: Date.now() });
}

/* ── hydration + legacy migration ─────────────────────────────────────────── */

async function migrateFromLegacy(): Promise<void> {
  try {
    const raw = await legacyDbGet('preferences_legacy', 'nexterm-language');
    if (raw !== null) settings.language = raw;
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'sshClientSettings');
    if (raw !== null) {
      try {
        applySshSettings(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'nexterm-layout-config');
    if (raw !== null) {
      try {
        applyLayout(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'terminalAppearance');
    if (raw !== null) {
      try {
        applyAppearance(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'nexterm-editor-config');
    if (raw !== null) {
      try {
        applyEditor(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'nexterm-follow-terminal-directory');
    if (raw !== null) settings.follow_terminal_directory = raw === 'true' || raw === '1';
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'nexterm:toolbox:show-resources');
    if (raw !== null) settings.show_resources = raw === 'true' || raw === '1';
  } catch {
    /* ignore */
  }
  try {
    const raw = await legacyDbGet('preferences_legacy', 'api-active-env');
    if (raw !== null) settings.api_active_env = raw;
  } catch {
    /* ignore */
  }
  // Persist whatever was migrated (no-op when nothing existed).
  if (Object.keys(settings).length > 0) persistSettings();
  if (Object.keys(layout).length > 0) persistLayout();
  if (Object.keys(appearance).length > 0) persistAppearance();
  if (Object.keys(editor).length > 0) persistEditor();
}

/** Load every preference from SQLite and migrate legacy data. */
export async function hydratePreferences(): Promise<void> {
  try {
    const row = await rowGet('app_settings', '1');
    if (row) settings = row;
  } catch {
    /* ignore */
  }
  try {
    const row = await rowGet('layout_config', '1');
    if (row) layout = row;
  } catch {
    /* ignore */
  }
  try {
    const row = await rowGet('terminal_appearance', '1');
    if (row) appearance = row;
  } catch {
    /* ignore */
  }
  try {
    const row = await rowGet('editor_config', '1');
    if (row) editor = row;
  } catch {
    /* ignore */
  }
  await migrateFromLegacy();
  hydrated = true;
}

/* ── public sync API ──────────────────────────────────────────────────────── */

/**
 * Synchronous read. Maps known preference keys to their normalized columns;
 * unknown keys return `fallback`.
 */
export function prefGet<T>(key: string, fallback: T): T {
  if (hydrated) {
    switch (key) {
      case 'nexterm-language':
        return (str(settings.language, 'auto') as unknown) as T;
      case 'sshClientSettings':
        return (assembleSshSettings() as unknown) as T;
      case 'nexterm-layout-config':
        return (assembleLayout() as unknown) as T;
      case 'terminalAppearance':
        return (assembleAppearance() as unknown) as T;
      case 'nexterm-editor-config':
        return (assembleEditor() as unknown) as T;
      case 'nexterm-follow-terminal-directory':
        return (bool(settings.follow_terminal_directory, true) as unknown) as T;
      case 'nexterm:toolbox:show-resources':
        return (bool(settings.show_resources, false) as unknown) as T;
      default:
        break;
    }
  }
  return fallback;
}

/** Synchronous raw read (used for the language preference + exports). */
export function prefGetRaw(key: string): string | null {
  if (hydrated && key === 'nexterm-language') {
    return str(settings.language, 'auto');
  }
  return null;
}

/** Persist a preference value (normalized columns when hydrated). */
export function prefSet(key: string, value: unknown): void {
  if (hydrated) {
    switch (key) {
      case 'nexterm-language':
        settings.language = value;
        persistSettings();
        return;
      case 'sshClientSettings':
        applySshSettings((value as Record<string, unknown>) ?? {});
        persistSettings();
        return;
      case 'nexterm-layout-config':
        applyLayout((value as Record<string, unknown>) ?? {});
        persistLayout();
        return;
      case 'terminalAppearance':
        applyAppearance((value as Record<string, unknown>) ?? {});
        persistAppearance();
        return;
      case 'nexterm-editor-config':
        applyEditor((value as Record<string, unknown>) ?? {});
        persistEditor();
        return;
      case 'nexterm-follow-terminal-directory':
        settings.follow_terminal_directory = !!value;
        persistSettings();
        return;
      case 'nexterm:toolbox:show-resources':
        settings.show_resources = !!value;
        persistSettings();
        return;
      default:
        break;
    }
  }
}

/** Persist a raw string preference (language, serialized blobs). */
export function prefSetRaw(key: string, raw: string): void {
  if (hydrated && key === 'nexterm-language') {
    settings.language = raw;
    persistSettings();
  }
}

/** Delete a stored preference (layout reset etc.). */
export function prefDelete(key: string): void {
  if (hydrated) {
    switch (key) {
      case 'nexterm-layout-config':
        layout = {};
        void rowDelete('layout_config', '1');
        return;
      default:
        break;
    }
  }
}

/** Reset in-memory preference caches (used by tests for isolation). */
export function resetPreferenceCaches(): void {
  settings = {};
  layout = {};
  appearance = {};
  editor = {};
  hydrated = false;
}

/** Raw access to the api-active-env column (used by the API debugger). */
export function getApiActiveEnv(): string {
  return hydrated ? str(settings.api_active_env, '') : '';
}

export function setApiActiveEnv(id: string): void {
  if (!hydrated) return;
  settings.api_active_env = id;
  persistSettings();
}

/** Raw access to the vault-meta columns (legacy master-password vault). */
export function getVaultMetaColumns(): { salt?: unknown; iterations?: unknown; verifier?: unknown; createdAt?: unknown; updatedAt?: unknown } {
  return {
    salt: settings.vault_salt,
    iterations: settings.vault_iterations,
    verifier: settings.vault_verifier,
    createdAt: settings.vault_created_at,
    updatedAt: settings.vault_updated_at,
  };
}

export function setVaultMetaColumns(meta: { salt: string; iterations: number; verifier: string; createdAt: number; updatedAt: number } | null): void {
  if (meta) {
    settings.vault_salt = meta.salt;
    settings.vault_iterations = meta.iterations;
    settings.vault_verifier = meta.verifier;
    settings.vault_created_at = meta.createdAt;
    settings.vault_updated_at = meta.updatedAt;
  } else {
    delete settings.vault_salt;
    delete settings.vault_iterations;
    delete settings.vault_verifier;
    delete settings.vault_created_at;
    delete settings.vault_updated_at;
  }
  persistSettings();
}

export type { DbTable };
