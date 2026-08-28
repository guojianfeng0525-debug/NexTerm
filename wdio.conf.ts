import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Options } from '@wdio/types';

// ── Serial-execution invariant (do not break) ───────────────────────────────
// The desktop specs chain application state inside the shared data dir: one
// spec creates connections / fixtures that later specs reuse (e.g.
// b22-connections → postgres-*). That state lives in the single application
// data directory, so the suite MUST run serially — `maxInstances` stays 1.
// Raising it to parallelise the suite is only safe after every spec stops
// depending on state written by another spec.
//
// `dataDir` below is per-process: each WDIO worker is a separate process that
// re-parses this config file (runner.run → new ConfigParser(configFile)), so
// the `mkdtempSync` fallback gives every worker its own unique directory when
// `NEXTERM_DATA_DIR` is unset. A pinned `NEXTERM_DATA_DIR` is meant as a
// *single-run* override (debugging against a known dir); sharing one across
// parallel workers/processes would corrupt each other's app state. The guard
// below refuses that combination instead of failing in confusing ways later.
const maxInstances = 1;
if (maxInstances > 1 && process.env.NEXTERM_DATA_DIR) {
  throw new Error(
    '[wdio] NEXTERM_DATA_DIR is shared between parallel WDIO workers; ' +
      'keep maxInstances = 1, or unset NEXTERM_DATA_DIR so each worker gets ' +
      'its own isolated directory.',
  );
}

const application = resolve('src-tauri/target/debug/nexterm');
const dataDir = process.env.NEXTERM_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'nexterm-wdio-'));
const sqliteFixturePath = join(dataDir, `sqlite-e2e-${Date.now()}.db`);
mkdirSync('./test-results/wdio/failures', { recursive: true });
mkdirSync('./test-results/database-visual', { recursive: true });

// The fixture lives beside the isolated application data directory, never in a
// user-selected location. The desktop spec only types this real path into the UI.
execFileSync('sqlite3', [sqliteFixturePath, [
  'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL);',
  "INSERT INTO users (id, name, active) VALUES (1, 'Alice', 1), (2, 'Bob', 0);",
  'CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
  "INSERT INTO projects (id, name) VALUES (10, 'NexTerm');",
].join('\n')]);
process.env.NEXTERM_SQLITE_E2E_PATH = sqliteFixturePath;

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./e2e/desktop/**/*.e2e.ts'],
  // Serial: see the data-dir invariant at the top of this file. maxInstances
  // is the per-capability worker count; >1 would run specs in parallel and
  // the shared app data dir would corrupt cross-spec state.
  maxInstances,
  logLevel: 'info',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  services: [[
    '@wdio/tauri-service',
    {
      appBinaryPath: application,
      driverProvider: 'embedded',
      env: {
        NEXTERM_DATA_DIR: dataDir,
        RUST_LOG: 'info',
      },
      captureBackendLogs: true,
      logDir: './test-results/wdio/logs',
      startTimeout: 90_000,
    },
  ]],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': { application },
  }],
  mochaOpts: {
    ui: 'bdd',
    timeout: 90_000,
  },
  // The app window can restore to an off-screen position (multi-monitor /
  // session restore), which makes every element "exists but not displayed"
  // and breaks waitForDisplayed-based specs (S1-6 dist saga root cause).
  // Force the window to a known on-screen size at the start of every session.
  before: async () => {
    try {
      await browser.tauri.switchWindow('main');
      // Keep the window within the primary screen (1728x1010 logical here).
      // Requesting a window larger than the screen (e.g. 2048x1200) pushes it
      // off-screen and WebDriver isDisplayed() then returns false for every
      // element — the S1-6 dist-saga root cause. Use a screen-fitting size.
      await browser.setWindowRect({ x: 0, y: 0, width: 1600, height: 1000 });
      await browser.setWindowSize(1600, 1000);
    } catch {
      /* window not ready yet; individual specs retry their own setup */
    }
  },
  afterTest: async (_test, _context, { error }) => {
    if (error) {
      await browser.saveScreenshot('./test-results/wdio/failures/screenshot.png');
    }
  },
};
