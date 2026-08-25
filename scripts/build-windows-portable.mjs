#!/usr/bin/env node
/**
 * NexTerm Windows Portable builder.
 *
 * Assembles the final portable distribution:
 *
 *   dist/NexTerm-portable/
 *   ├── NexTerm.exe            (release binary, self-contained)
 *   └── WebView2/              (Fixed Version WebView2 Runtime, x64)
 *       ├── msedgewebview2.exe
 *       ├── msedge.dll
 *       └── ...
 *
 * then validates it and produces dist/NexTerm-portable.zip. The ZIP's root
 * holds exactly `NexTerm.exe` + `WebView2/` (no wrapper directory), so
 * unzipping yields a directly runnable folder.
 *
 * Usage:
 *   node scripts/build-windows-portable.mjs [--exe <path>] [--runtime <dir>] [--out <dir>]
 *
 * Run on Windows (or any host with the artifacts present). The release EXE is
 * produced by `pnpm tauri build --no-bundle`; the WebView2 Fixed Version
 * Runtime is extracted by the CI workflow into `src-tauri/runtime/webview2`.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const EXE_SOURCE = argValue('--exe', path.join(PROJECT_ROOT, 'src-tauri', 'target', 'release', 'nexterm.exe'));
const RUNTIME_SOURCE = argValue('--runtime', path.join(PROJECT_ROOT, 'src-tauri', 'runtime', 'webview2'));
const OUT_DIR = argValue('--out', path.join(PROJECT_ROOT, 'dist'));
const ARCH = argValue('--arch', 'x64');
if (ARCH !== 'x64' && ARCH !== 'x86') {
  throw new Error(`Unsupported portable architecture: ${ARCH}`);
}
const PORTABLE_NAME = ARCH === 'x64' ? 'NexTerm-portable' : `NexTerm-portable-${ARCH}`;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function log(step, msg) {
  console.log(`[portable] ${step}: ${msg}`);
}

/** Read the PE machine type of a Windows executable (x64 = 0x8664). */
function peArchitecture(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    if (read < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // no MZ header
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 6 > read || buf.toString('latin1', peOff, peOff + 4) !== 'PE\x00\x00') return null;
    const machine = buf.readUInt16LE(peOff + 4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0x14c) return 'x86';
    return `unknown(0x${machine.toString(16)})`;
  } catch {
    return null;
  }
}

/** Locate the real runtime root: the folder that directly contains msedgewebview2.exe. */
function findRuntimeRoot(dir) {
  // Quick check on the obvious locations first.
  for (const c of [dir, path.join(dir, 'EBWebView')]) {
    if (fs.existsSync(path.join(c, 'msedgewebview2.exe')) && fs.existsSync(path.join(c, 'msedge.dll'))) {
      return c;
    }
  }
  // Otherwise walk the tree (bounded) for msedgewebview2.exe and use its parent.
  const queue = [dir];
  let visited = 0;
  const MAX = 5000;
  while (queue.length > 0 && visited < MAX) {
    visited += 1;
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      } else if (entry.name === 'msedgewebview2.exe') {
        const parent = current;
        if (fs.existsSync(path.join(parent, 'msedge.dll'))) return parent;
      }
    }
  }
  return null;
}

/** Get the FileVersion of msedgewebview2.exe (Windows PowerShell). */
function runtimeVersion(msedgeExe) {
  try {
    const ps = `(Get-Item '${msedgeExe.replace(/'/g, "''")}').VersionInfo.FileVersion`;
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      timeout: 20000,
    });
    const v = out.trim();
    return v || 'unknown';
  } catch {
    return 'unknown';
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/* ── main ────────────────────────────────────────────────────────────────── */

function main() {
  log('start', 'assembling NexTerm portable distribution');
  log('exe', EXE_SOURCE);
  log('runtime', RUNTIME_SOURCE);
  log('out', OUT_DIR);

  // 1. Inputs must exist.
  if (!fs.existsSync(EXE_SOURCE)) {
    console.error(`[portable] ERROR: release EXE not found: ${EXE_SOURCE}`);
    console.error('          Run `pnpm tauri build --no-bundle` first.');
    process.exit(1);
  }
  const runtimeRoot = findRuntimeRoot(RUNTIME_SOURCE);
  if (!runtimeRoot) {
    console.error(`[portable] ERROR: WebView2 runtime not found under ${RUNTIME_SOURCE}`);
    console.error('          Expected msedgewebview2.exe + msedge.dll (Fixed Version Runtime).');
    process.exit(1);
  }

  // 2. Architecture must match the requested portable build.
  const exeArch = peArchitecture(EXE_SOURCE);
  const runtimeArch = peArchitecture(path.join(runtimeRoot, 'msedgewebview2.exe'));
  log('exe-arch', exeArch ?? 'unknown');
  log('runtime-arch', runtimeArch ?? 'unknown');
  if (exeArch !== ARCH || runtimeArch !== ARCH) {
    console.error(`[portable] ERROR: architecture mismatch (exe=${exeArch}, runtime=${runtimeArch}); expected ${ARCH} for both.`);
    process.exit(1);
  }

  // 3. Assemble the portable directory.
  const portableDir = path.join(OUT_DIR, PORTABLE_NAME);
  rmrf(portableDir);
  fs.mkdirSync(portableDir, { recursive: true });

  fs.copyFileSync(EXE_SOURCE, path.join(portableDir, 'NexTerm.exe'));
  copyDir(runtimeRoot, path.join(portableDir, 'WebView2'));

  // 4. Write the runtime manifest with the actual version.
  const version = runtimeVersion(path.join(runtimeRoot, 'msedgewebview2.exe'));
  const manifest = {
    version,
    architecture: ARCH,
    type: 'fixed',
  };
  fs.writeFileSync(
    path.join(portableDir, 'WebView2', 'runtime-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  log('runtime-version', version);

  // 5. Validate the layout.
  const checks = [
    ['NexTerm.exe', fs.existsSync(path.join(portableDir, 'NexTerm.exe'))],
    ['WebView2/msedgewebview2.exe', fs.existsSync(path.join(portableDir, 'WebView2', 'msedgewebview2.exe'))],
    ['WebView2/msedge.dll', fs.existsSync(path.join(portableDir, 'WebView2', 'msedge.dll'))],
    // No nested WebView2/WebView2.
    ['no-nesting', !fs.existsSync(path.join(portableDir, 'WebView2', 'WebView2'))],
    // No absolute dev-machine paths leaked into manifest.
    ['no-abs-path-in-manifest', !JSON.stringify(manifest).includes(':/') && !JSON.stringify(manifest).includes(':\\')],
  ];
  for (const [name, ok] of checks) {
    log(`check-${name}`, ok ? 'PASS' : 'FAIL');
    if (!ok) {
      console.error(`[portable] ERROR: validation failed at ${name}`);
      process.exit(1);
    }
  }

  // 6. Create the ZIP. The archive's ROOT contains exactly two entries —
  //    `NexTerm.exe` and `WebView2/` — so a user unzips straight into a
  //    runnable folder (no nested `NexTerm-portable/` wrapper directory).
  const zipPath = path.join(OUT_DIR, `${PORTABLE_NAME}.zip`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  try {
    // Prefer PowerShell Compress-Archive on Windows. Use `-Path` with the
    // directory's children so the entries land at the archive root.
    const ps = [
      `Compress-Archive`,
      `-Path '${path.join(portableDir, '*').replace(/'/g, "''")}'`,
      `-DestinationPath '${zipPath.replace(/'/g, "''")}'`,
      `-CompressionLevel Optimal`,
    ].join(' ');
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      stdio: 'inherit',
      timeout: 300000,
    });
  } catch {
    // Fallback: system zip (macOS/Linux CI). `zip -r <zip> .` from inside the
    // directory keeps entries at the root instead of nesting the folder name.
    execSync(`cd "${portableDir}" && zip -r "${zipPath}" .`, {
      stdio: 'inherit',
      timeout: 300000,
    });
  }

  const zipSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
  log('zip', zipPath);
  log('zip-size', `${(zipSize / 1024 / 1024).toFixed(1)} MB`);
  log('done', `portable distribution ready: ${path.join(OUT_DIR, PORTABLE_NAME)} + ${zipPath}`);
}

main();
