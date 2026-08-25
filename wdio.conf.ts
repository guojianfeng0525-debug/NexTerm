import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Options } from '@wdio/types';

const application = resolve('src-tauri/target/debug/nexterm');
const dataDir = process.env.NEXTERM_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'nexterm-wdio-'));
const sqliteFixturePath = join(dataDir, `sqlite-e2e-${Date.now()}.db`);
mkdirSync('./test-results/wdio/failures', { recursive: true });

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
  maxInstances: 1,
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
  afterTest: async (_test, _context, { error }) => {
    if (error) {
      await browser.saveScreenshot('./test-results/wdio/failures/screenshot.png');
    }
  },
};
