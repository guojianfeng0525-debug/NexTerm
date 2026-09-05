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

// The port-topology target needs persisted server/port rows before the app's
// frontend cache initializes. Create a real (unencrypted) SQLite store in the
// isolated data dir; DbState::open later adds the remaining application tables
// and opens this store without importing the developer's production database.
const seedPortTopologyE2E = process.argv.some((arg) => arg.includes('network-port-topology.e2e.ts'));
const topologyDbPath = join(dataDir, 'nexterm.db');
if (seedPortTopologyE2E) {
  const topologyNow = Date.now();
  execFileSync('sqlite3', [topologyDbPath, `
CREATE TABLE IF NOT EXISTS net_nodes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, hostname TEXT NOT NULL DEFAULT '', os_name TEXT NOT NULL DEFAULT '', primary_ip TEXT NOT NULL DEFAULT '', role_hint TEXT NOT NULL DEFAULT 'unknown', display_name TEXT NOT NULL DEFAULT '', node_type TEXT NOT NULL DEFAULT '', environment TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, pos_x REAL, pos_y REAL, last_probe_at INTEGER, last_probe_status TEXT NOT NULL DEFAULT 'never', last_probe_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS net_firewalls (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, fw_type TEXT NOT NULL DEFAULT 'unknown', active INTEGER NOT NULL DEFAULT 0, default_in_policy TEXT NOT NULL DEFAULT '', default_out_policy TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', zones TEXT NOT NULL DEFAULT '[]', detect_note TEXT NOT NULL DEFAULT '', manual_note TEXT NOT NULL DEFAULT '', last_seen_at INTEGER NOT NULL, missing_since INTEGER);
CREATE TABLE IF NOT EXISTS net_firewall_rules (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, firewall_id TEXT NOT NULL, table_name TEXT NOT NULL DEFAULT '', chain TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT '', src TEXT NOT NULL DEFAULT '', dst TEXT NOT NULL DEFAULT '', src_port TEXT NOT NULL DEFAULT '', dst_port TEXT NOT NULL DEFAULT '', in_iface TEXT NOT NULL DEFAULT '', out_iface TEXT NOT NULL DEFAULT '', raw_rule TEXT NOT NULL DEFAULT '', rule_hash TEXT NOT NULL DEFAULT '', manual_purpose TEXT NOT NULL DEFAULT '', last_seen_at INTEGER NOT NULL, missing_since INTEGER);
CREATE TABLE IF NOT EXISTS net_ports (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'tcp', port INTEGER NOT NULL DEFAULT 0, listen_addr TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', process_name TEXT NOT NULL DEFAULT '', pid INTEGER, process_user TEXT NOT NULL DEFAULT '', reachability TEXT NOT NULL DEFAULT 'untested', reachability_at INTEGER, service_name TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL, missing_since INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS net_port_links (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL, source_port_id TEXT NOT NULL, source_ip TEXT, source_protocol TEXT NOT NULL DEFAULT 'tcp', source_port INTEGER NOT NULL DEFAULT 0, target_node_id TEXT, target_port_id TEXT, target_protocol TEXT NOT NULL DEFAULT 'tcp', target_port INTEGER NOT NULL DEFAULT 0, target_ip TEXT, status TEXT NOT NULL DEFAULT 'unknown', source TEXT NOT NULL DEFAULT 'manual', evidence TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', manual_label TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL, last_confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO net_nodes VALUES ('e2e-node-a','e2e-conn-a','web-a','Ubuntu 22.04','10.10.1.20','web','web-a','vm','dev','',0,NULL,NULL,${topologyNow},'ok',NULL,${topologyNow},${topologyNow});
INSERT OR IGNORE INTO net_nodes VALUES ('e2e-node-b','e2e-conn-b','api-b','Ubuntu 22.04','10.10.1.21','web','api-b','vm','dev','',0,NULL,NULL,${topologyNow},'ok',NULL,${topologyNow},${topologyNow});
INSERT OR IGNORE INTO net_firewalls VALUES ('e2e-fw-b','e2e-node-b','ufw',1,'drop','allow','','[]','','',${topologyNow},NULL);
INSERT OR IGNORE INTO net_firewall_rules VALUES ('e2e-rule-b8080','e2e-node-b','e2e-fw-b','ufw','ufw','ALLOW','tcp','Anywhere','','','8080','','','ALLOW 8080/tcp','e2e-rule-b8080','',${topologyNow},NULL);
INSERT OR IGNORE INTO net_ports VALUES ('e2e-port-a','e2e-node-a','tcp',8080,'0.0.0.0','LISTEN','app-a',101,'ubuntu','untested',NULL,'gateway-a','web entry','manual note','["web"]',0,${topologyNow},NULL,${topologyNow});
INSERT OR IGNORE INTO net_ports VALUES ('e2e-port-b','e2e-node-b','tcp',8080,'0.0.0.0','LISTEN','app-b',202,'ubuntu','blocked',${topologyNow},'gateway-b','internal API','','[]',0,${topologyNow},NULL,${topologyNow});
INSERT OR IGNORE INTO net_port_links VALUES ('e2e-plink-out','e2e-node-a','e2e-port-a',NULL,'tcp',8080,'e2e-node-b','e2e-port-b','tcp',8080,NULL,'active','auto','ss ESTABLISHED local:45678 -> 10.10.1.21:8080','','',0,${topologyNow},${topologyNow},${topologyNow},${topologyNow});
INSERT OR IGNORE INTO net_port_links VALUES ('e2e-plink-in','','','203.0.113.9','tcp',51000,'e2e-node-b','e2e-port-b','tcp',8080,NULL,'active','auto','ss ESTABLISHED 203.0.113.9:51000 -> local:8080','','',0,${topologyNow},${topologyNow},${topologyNow},${topologyNow});
`]);
}

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
