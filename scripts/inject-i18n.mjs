#!/usr/bin/env node
/**
 * Inject i18n keys into `src/locales/*.json`.
 *
 * Reads a flat `key → [zh-CN, en]` mapping from a JSON file and merges it into
 * both locale files under a namespace. Idempotent — re-running overwrites,
 * never duplicates. Output is `JSON.stringify(…, 2)`, which round-trips
 * byte-identically against the committed locale files.
 *
 * Usage:
 *   node scripts/inject-i18n.mjs /tmp/keys.json topology
 */
import { readFileSync, writeFileSync } from 'node:fs';

const LOCALES = [
  { path: 'src/locales/zh-CN.json', index: 0 },
  { path: 'src/locales/en.json', index: 1 },
];

const [source, namespace] = process.argv.slice(2);
if (!source || !namespace) {
  console.error('usage: node scripts/inject-i18n.mjs <keys.json> <namespace>');
  process.exit(1);
}

const mapping = JSON.parse(readFileSync(source, 'utf8'));

function merge(target, dotted, leaf, value) {
  let node = target;
  for (const part of dotted.split('.')) {
    if (node[part] !== undefined && typeof node[part] !== 'object') {
      throw new Error(`conflict: "${part}" of "${dotted}" is not an object`);
    }
    node[part] ??= {};
    node = node[part];
  }
  node[leaf] = value;
}

for (const { path, index } of LOCALES) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const [key, pair] of Object.entries(mapping)) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`key "${key}" must map to [zh-CN, en]`);
    }
    merge(data, namespace, key, pair[index]);
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`updated ${path} (+${Object.keys(mapping).length} keys under ${namespace})`);
}
