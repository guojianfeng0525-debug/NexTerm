import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

/**
 * Regression spec: navigator object listings must not be truncated by the
 * `postgres_catalog_search` completion limit (LIMIT 100). A schema with 150
 * tables previously showed only the first 100; the fix makes the navigator
 * pass an explicit large limit.
 *
 * Fixture: z_e2e_loadtest.t_001..t_150 are created idempotently through the
 * query editor. The schema name sorts AFTER `public`, so the default
 * auto-expanded schema stays `public` and other specs are unaffected. The
 * spec expands z_e2e_loadtest manually and drops it in `after`.
 */

const LOAD_SCHEMA = 'z_e2e_loadtest';

async function connectPostgres() {
  const password = `E2E_${Date.now()}`;
  await unlockApp(password, '[data-testid="postgres-disconnect"]');
  const postgres = await waitForVisible('[data-testid="toolbox-nav-postgres"]');
  if (await $('[data-testid="postgres-disconnect"]').isExisting()) return;
  await postgres.click();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue('Load Complete');
  await inputs[1].setValue('127.0.0.1');
  await browser.execute((input: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '55432');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, inputs[2]);
  await inputs[3].setValue('nexterm_e2e');
  await inputs[4].setValue('nexterm_e2e');
  await inputs[5].setValue('nexterm_e2e');
  await dialog.$('button=连接').click();
  await $('[data-testid="postgres-run"]').waitForEnabled();
}

/** Runs DDL through the query editor (opens the Query tab when needed). */
async function runSql(sql: string) {
  const workspace = await $('[data-testid="postgres-workspace"]');
  const queryTab = await workspace.$('button=Query');
  if (await queryTab.isExisting()) await queryTab.click();
  const editors = await workspace.$$('.cm-content');
  const editor = editors[editors.length - 1];
  await editor.click();
  await editor.clearValue();
  await editor.setValue(sql);
  await $('[data-testid="postgres-run"]').click();
  await browser.pause(2000);
}

/** Creates z_e2e_loadtest.t_001..t_150 idempotently. */
async function ensureLoadTestSchema() {
  await runSql(
    `CREATE SCHEMA IF NOT EXISTS ${LOAD_SCHEMA}; ` +
      'DO $$ DECLARE i int; BEGIN' +
      '  FOR i IN 1..150 LOOP' +
      `    EXECUTE format('CREATE TABLE IF NOT EXISTS ${LOAD_SCHEMA}.t_%s (id int)', lpad(i::text, 3, '0'));` +
      '  END LOOP;' +
      'END $$;',
  );
  await $('[data-testid="postgres-refresh"]').click();
  await browser.pause(1200);
}

/** Expands a navigator node matching all `parts` substrings of its id. */
async function expandNode(parts: string[]) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const nodes = await $$('[data-testid="database-navigator-node"]');
    for (const node of nodes) {
      const nodeId = (await node.getAttribute('data-node-id')) || '';
      if (parts.every((part) => nodeId.includes(part))) {
        if (await node.$('.lucide-chevron-down').isExisting()) {
          return;
        }
        await node.click();
        await browser.pause(900);
        return;
      }
    }
    await browser.pause(400);
  }
  throw new Error(`Navigator node not found: ${parts.join(' / ')}`);
}

/** Waits for and counts table nodes under the load-test schema. */
async function countLoadTestTables(timeoutMs = 25_000): Promise<number> {
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < timeoutMs) {
    const nodes = await $$('[data-testid="database-navigator-node"]');
    let count = 0;
    for (const node of nodes) {
      const nodeId = (await node.getAttribute('data-node-id')) || '';
      if (
        nodeId.includes(`/schema:${LOAD_SCHEMA}/group:tables/object:t_`)
      ) {
        count += 1;
      }
    }
    last = count;
    if (count === 150) return count;
    await browser.pause(400);
  }
  return last;
}

describe('Navigator loads complete object listings (limit regression)', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await connectPostgres();
    await ensureLoadTestSchema();
    // public stays auto-expanded; expand the load-test schema manually.
    await expandNode([`/schema:${LOAD_SCHEMA}`]);
    await expandNode([`/schema:${LOAD_SCHEMA}/group:tables`]);
  });

  after(async () => {
    try {
      await runSql(`DROP SCHEMA IF EXISTS ${LOAD_SCHEMA} CASCADE;`);
    } catch {
      /* cleanup best-effort: schema persists harmlessly (sorts after public) */
    }
  });

  it('shows all 150 tables instead of only the first 100', async () => {
    const count = await countLoadTestTables();
    expect(count).toBe(150);
    await browser.saveScreenshot('./test-results/postgres-load-complete.png');
  });

  it('includes tables beyond the old 100-row completion cap', async () => {
    const start = Date.now();
    let found = false;
    while (Date.now() - start < 20_000) {
      const nodes = await $$('[data-testid="database-navigator-node"]');
      for (const node of nodes) {
        const nodeId = (await node.getAttribute('data-node-id')) || '';
        if (nodeId.includes(`/schema:${LOAD_SCHEMA}/group:tables/object:t_150`)) {
          found = true;
          break;
        }
      }
      if (found) break;
      await browser.pause(400);
    }
    expect(found).toBe(true);
  });

  it('still shows the last table alphabetically (t_150)', async () => {
    const start = Date.now();
    let last = '';
    while (Date.now() - start < 20_000) {
      const nodes = await $$('[data-testid="database-navigator-node"]');
      const ids: string[] = [];
      for (const node of nodes) {
        const nodeId = (await node.getAttribute('data-node-id')) || '';
        if (nodeId.includes(`/schema:${LOAD_SCHEMA}/group:tables/object:t_`)) {
          ids.push(nodeId);
        }
      }
      ids.sort();
      last = ids.at(-1) ?? '';
      if (last.includes('t_150')) break;
      await browser.pause(400);
    }
    expect(last).toContain('t_150');
  });
});
