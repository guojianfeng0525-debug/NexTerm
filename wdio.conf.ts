import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Options } from '@wdio/types';

const application = resolve('src-tauri/target/debug/nexterm');
const dataDir = process.env.NEXTERM_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'nexterm-wdio-'));
mkdirSync('./test-results/wdio/failures', { recursive: true });

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
