/**
 * One-time storage initialization.
 *
 * `hydratePreferences()` runs at bootstrap (main.tsx) so the lock screen and
 * theme render with the correct language/layout. `initializeAllStorage()`
 * runs after the app is unlocked and hydrates every encrypted store into its
 * synchronous in-memory cache BEFORE the application UI renders, so
 * components see consistent data on first paint.
 */
import { getAppLockKey } from './toolbox/app-lock';
import { initializeToolboxStore } from './toolbox/toolbox-storage';
import { hydrateConnectionsStorage } from './connection-storage';
import { hydrateConnectionProfiles } from './connection-profiles';
import { hydrateVaultStorage } from './toolbox/vault-crypto';
import { hydrateCommandHistory, getCommandHistory, getCommandUsage } from './command-history';
import { hydrateSuggestionStore } from './suggestion/store';
import { hydrateApiDebugStorage } from './toolbox/api-debug-storage';
import { initializeDocumentsStore } from './toolbox/documents-storage';
import { hydrateWorkspace } from './terminal-group-serializer';
import { migrateLegacyStorage } from './migration';

/**
 * Hydrate every SQLite-backed store. Never throws — each store degrades to
 * its legacy fallback when the backend is unavailable.
 */
export async function initializeAllStorage(): Promise<void> {
  // Encrypted stores require the app-password key. The lock screen
  // guarantees this key exists before the app UI renders (first run forces
  // a password setup, later runs verify), so this guard never fires in
  // production. If it ever does, fail loudly instead of silently skipping
  // hydration — otherwise every store stays empty while writes still reach
  // SQLite, which looks like data loss on the next launch.
  if (!getAppLockKey()) {
    console.warn('[storage-init] Skipping SQLite hydration: app-password key unavailable');
    return;
  }
  await Promise.all([
    initializeToolboxStore(),
    hydrateConnectionsStorage(),
    hydrateConnectionProfiles(),
    hydrateVaultStorage(),
    hydrateCommandHistory(),
    hydrateApiDebugStorage(),
    hydrateWorkspace(),
    initializeDocumentsStore(),
  ]);
  // Suggestion store migrates the (now hydrated) legacy usage/history as its
  // initial global frequency data — must run after hydrateCommandHistory.
  await hydrateSuggestionStore(getCommandUsage(), getCommandHistory());
  // Legacy tables are dropped only after every migration has read its data.
  await migrateLegacyStorage();
}
