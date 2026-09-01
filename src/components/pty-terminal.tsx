import React from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils';
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { loadAppearanceSettings, getThemeAwareTerminalOptions, getThemeAwareTerminalTheme, terminalThemes, defaultTerminalTheme } from '../lib/terminal-config';
import { TerminalContextMenu } from './terminal/terminal-context-menu';
import { TerminalSearchBar, type TerminalSearchState } from './terminal/terminal-search-bar';
import { toast } from 'sonner';
import { signalReady } from '../lib/restoration-manager';
import { useTerminalCallbacks } from '../lib/terminal-callbacks-context';
import { prefGet } from '../lib/preferences';
import { APP_SETTINGS_STORAGE_KEY, APP_SETTINGS_CHANGED_EVENT } from '@/lib/keyboard-shortcuts';
import { registerTerminalWorkingDirectoryHandler } from '../lib/terminal-working-directory';
import { TERMINAL_COMMAND_EVENT, type TerminalCommandDetail } from '../lib/terminal-commands';
import { SCOPE_GLOBAL } from '../lib/suggestion/types';
import { isAlternateBuffer, isInputInPromptContext, isPasteStart, isPasteEnd, normalizeSuggestionDebounceMs } from '../lib/suggestion/gate';
import {
  rankSuggestions,
} from '../lib/suggestion/engine';
import {
  getStatsForScopes,
  recordUse,
  recordSelection,
  recordRejection,
  connectionScope,
  cwdScope,
} from '../lib/suggestion/store';
import { recordExecutedCommand } from '../lib/command-history';
import { generateId, NotesStorage } from '../lib/toolbox/toolbox-storage';
import '@xterm/xterm/css/xterm.css';

interface PtyTerminalProps {
  connectionId: string;
  connectionName: string;
  defaultDirectory?: string;
  terminalEncoding?: 'utf-8' | 'gbk' | 'gb18030';
  host?: string;
  username?: string;
  appearanceKey?: number;
  themeKey?: number;
  isActive?: boolean;
  onConnectionStatusChange?: (connectionId: string, status: 'connected' | 'connecting' | 'disconnected' | 'pending') => void;
}

/**
 * PTY-based Interactive Terminal Component
 * 
 * This terminal uses a persistent PTY (pseudo-terminal) session for full interactivity.
 * It supports all interactive commands like vim, less, more, top, etc.
 * 
 * Communication is done via WebSocket for low-latency bidirectional streaming.
 */

/** Per-session output cap. When cumulative bytes written to xterm exceed this
 *  value the scrollback is cleared automatically so V8 heap stays bounded.
 *  2 MB of decoded text ≈ ~25k typical 80-char terminal lines. Kept low to
 *  prevent V8 heap fragmentation and WebGL texture-cache bloat during
 *  sustained high-throughput output (e.g. `yes`). */
const SESSION_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

/** Curated per-command candidates (options, subcommands, common combos).
 *  Sourced from real man-page knowledge so suggestions are always valid —
 *  e.g. typing `ps -` lists real ps flags, never unrelated commands. */
const COMMAND_CANDIDATES: Record<string, string[]> = {
  /* process / system */
  ps: ['-A', '-e', '-a', '-u', '-x', '-f', '-F', '-H', '-j', '-l', '-M', '-N', '-o', '-p', '-r', '-s', '-t', '-T', '-v', '-w', '-C', '-G', '-U', '-g', 'aux', 'ef', 'eaux', 'aef', '-ef', '-eaux', '-efl', '-aux', '-axu', '-eF'],
  pstree: ['-p', '-a', '-u', '-h', '-s'],
  pgrep: ['-u', '-f', '-l', '-a', '-c', '-x', '-n', '-o', '-P'],
  pkill: ['-f', '-u', '-9', '-15', '-i', '-x', '-n', '-o'],
  top: ['-b', '-n', '-p', '-d', '-o', '-u', '-H'],
  htop: ['-d', '-p', '-u', '-s', '--tree'],
  jobs: ['-l', '-p', '-r', '-s'],
  watch: ['-n', '-d', '-t', '-b', '-x'],
  nohup: ['&', '-v'],
  timeout: ['-s', '-k', '-v', '5', '10', '30'],
  uptime: ['-p', '-s'],
  uname: ['-a', '-s', '-r', '-m', '-n', '-p'],
  hostname: ['-i', '-I', '-f', '-s', '-d'],
  date: ['-u', '-R', '-I', '-s', '+%Y-%m-%d', '+%H:%M:%S'],
  cal: ['-y', '-3', '-m', '-j'],
  time: ['-p', '-v', '-o'],
  env: ['-i', '-u', 'PATH='],
  export: ['PATH=', 'HOME=', 'LANG=', 'EDITOR=', 'JAVA_HOME='],
  alias: ['-p', 'll=', 'ls='],
  echo: ['-n', '-e', '-E'],
  printf: ['%s', '%d', '%f', '%x'],
  sleep: ['1', '5', '10', '60'],
  yes: ['', '| head'],
  seq: ['-s', '-w', '-f', '1 10', '1 2 10'],
  shuf: ['-n', '-i', '-e', '-r'],
  history: ['-c', '-d', '| grep'],
  crontab: ['-l', '-e', '-r', '-u', '-i'],
  at: ['now', 'tomorrow', 'midnight', 'noon', '-l', '-r'],
  ulimit: ['-a', '-n', '-u', '-c', '-s'],
  umask: ['022', '002', '077'],
  /* file ops */
  ls: ['-a', '-A', '-l', '-h', '-R', '-r', '-S', '-t', '-i', '-d', '-F', '-1', '--color', '--time', '--sort', '--block-size', '-la', '-lah', '-ltr'],
  cat: ['-n', '-b', '-s', '-A', '-E', '-T'],
  head: ['-n', '-c', '-q', '-v'],
  tail: ['-n', '-f', '-F', '-c', '-q', '-v', '-f -n 100'],
  less: ['-N', '-S', '-i', '-R', '-F', '-X'],
  more: ['-d', '-c', '-f'],
  touch: ['-a', '-m', '-t', '-c', '-d'],
  ln: ['-s', '-f', '-n', '-v', '-i'],
  stat: ['-c', '-f', '-t', '-L'],
  file: ['-b', '-i', '-f'],
  readlink: ['-f', '-e', '-m', '-n'],
  realpath: ['-e', '-m', '-s', '-L'],
  basename: ['-s', '-a'],
  dirname: [],
  tree: ['-a', '-d', '-f', '-L', '-h', '-i'],
  locate: ['-i', '-c', '-l', '-r'],
  which: ['-a', '-s'],
  whereis: ['-b', '-m', '-s'],
  md5sum: ['-c', '-b'],
  sha256sum: ['-c', '-b'],
  find: ['-name', '-iname', '-type', '-mtime', '-size', '-exec', '-delete', '-print', '-maxdepth', '-mindepth', '-user', '-group', '-perm', '-newer', '-f'],
  rm: ['-r', '-f', '-i', '-v', '-R', '--recursive', '--force', '--interactive', '-rf'],
  cp: ['-r', '-R', '-v', '-i', '-f', '-p', '-a', '-n', '-u'],
  mv: ['-v', '-i', '-f', '-n', '-u'],
  mkdir: ['-p', '-v', '-m'],
  rmdir: ['-p', '-v'],
  chmod: ['-R', '-v', '-c', '-f', '755', '644', '777', '600', '700', '+x', '-x', '+r', 'a+x', 'u+x', 'g+x'],
  chown: ['-R', '-v', '-c', '-f', 'root:', ':group'],
  chgrp: ['-R', '-v', '-c', '-f'],
  lsattr: ['-a', '-d', '-R', '-v'],
  chattr: ['-R', '+i', '-i', '+a', '+e'],
  setfacl: ['-m', '-x', '-R', '-b', '-k', '-d'],
  getfacl: ['-R', '-p', '-t', '-c'],
  su: ['-', '-l', '-c', '-s'],
  sudo: ['-i', '-s', '-u', '-E', '-k', '-l', '-v', '-H'],
  visudo: ['-c', '-f', '-s'],
  sync: ['-f', '-d', '-w'],

  /* users */
  useradd: ['-m', '-s', '-d', '-G', '-g', '-u', '-p', '-c', '-r'],
  usermod: ['-aG', '-s', '-d', '-g', '-u', '-L', '-U', '-l'],
  userdel: ['-r', '-f'],
  passwd: ['-l', '-u', '-d', '-e', '-S', '-x'],
  groupadd: ['-g', '-r', '-f'],
  groupdel: [],
  id: ['-u', '-g', '-G', '-n', '-un'],
  whoami: [],
  who: ['-a', '-b', '-H', '-u'],
  w: ['-h', '-s', '-f'],
  last: ['-n', '-f', '-x'],
  groups: ['root', 'sudo', 'docker', 'www-data'],

  /* text processing */
  grep: ['-i', '-v', '-r', '-R', '-n', '-c', '-l', '-L', '-w', '-x', '-E', '-P', '-F', '-A', '-B', '-C', '-m', '-o', '--color', '--include', '--exclude', '--line-number', '-rn', '-ri'],
  sed: ['-i', '-n', '-e', '-r', "s/foo/bar/g", '/pattern/d', 's/old/new/', '1,10p'],
  awk: ["'{print $1}'", '-F', '-v', "BEGIN{}", "END{}", '$1', '$NF'],
  wc: ['-l', '-w', '-c', '-m', '-L'],
  sort: ['-n', '-r', '-u', '-k', '-t', '-h', '-f'],
  uniq: ['-c', '-d', '-u', '-i', '-s', '-w'],
  cut: ['-d', '-f', '-c', '-s', '--complement'],
  tr: ['-d', '-s', '-c', "a-z", 'A-Z'],
  xargs: ['-n', '-I', '-0', '-P', '-d', '-t'],
  tee: ['-a', '-i'],
  diff: ['-u', '-c', '-r', '-N', '-q', '-i', '-b', '-B'],
  comm: ['-1', '-2', '-3'],
  join: ['-t', '-i', '-1', '-2'],
  paste: ['-d', '-s'],
  nl: ['-ba', '-s', '-w'],
  fold: ['-w', '-s', '-b'],
  split: ['-b', '-l', '-d', '-a'],
  rev: [],
  column: ['-t', '-s', '-n', '-c'],
  /* archive */
  tar: ['-c', '-x', '-t', '-z', '-j', '-v', '-f', '-C', '-p', '--exclude', '--strip-components', '-czf', '-xzf', '-tf', '-xvf', '-cvzf'],
  gzip: ['-d', '-k', '-c', '-r', '-9', '-v'],
  gunzip: ['-k', '-c', '-f', '-r'],
  zip: ['-r', '-q', '-o', '-e', '-9', '-x'],
  unzip: ['-o', '-l', '-d', '-q', '-j'],
  bzip2: ['-d', '-k', '-c', '-9'],
  xz: ['-d', '-k', '-c', '-9', '-z'],
  '7z': ['x', 'a', 'l', 't', '-r', '-o'],
  zcat: [],

  /* network */
  ssh: ['-p', '-i', '-L', '-R', '-D', '-o', '-v', '-N', '-f', '-l', '-g', '-C', '-q', '--identity-file', '--port', 'root@'],
  scp: ['-P', '-i', '-r', '-C', '-v', '-q', '-l', '-o'],
  sftp: ['-P', '-i', '-o', '-b'],
  ping: ['-c', '-i', '-t', '-s', '-W', '-q', '-f'],
  traceroute: ['-n', '-m', '-w', '-p', '-I', '-T'],
  mtr: ['-r', '-n', '-c', '-i', '-p'],
  dig: ['+short', '+trace', '+noall', '+answer', 'A', 'MX', 'TXT', 'NS', 'AAAA'],
  nslookup: ['-type=A', '-type=MX', '-timeout', '-port'],
  host: ['-t', '-a', '-v'],
  curl: ['-X', '-H', '-d', '-F', '-o', '-O', '-L', '-k', '-v', '-s', '-S', '-u', '-c', '-b', '-m', '-I', '-A', '-e', '--max-time', '--connect-timeout', '--header', '--data', '--output', '-i', '-w'],
  wget: ['-O', '-P', '-q', '-v', '-c', '-r', '-l', '-k', '-N', '-b', '-t', '--limit-rate', '--no-check-certificate'],
  nc: ['-l', '-p', '-v', '-n', '-u', '-z', '-w', '-lk', '-k'],
  nmap: ['-sS', '-sT', '-sU', '-sV', '-O', '-p', '-Pn', '-A', '-T4', '--open'],
  telnet: ['-l', '-p'],
  iptables: ['-A', '-D', '-L', '-F', '-P', '-I', '-t', '-s', '-d', '-p', '--dport', '--sport', '-j', 'INPUT', 'OUTPUT', 'FORWARD', 'ACCEPT', 'DROP', 'REJECT'],
  nft: ['list', 'add', 'delete', 'flush', 'table', 'chain', 'rule', 'ruleset'],
  ss: ['-t', '-u', '-l', '-p', '-n', '-a', '-s', '-tulnp', '-s'],
  netstat: ['-t', '-u', '-l', '-p', '-n', '-a', '-r', '-i', '-tulnp', '-s'],
  ip: ['addr', 'link', 'route', 'add', 'del', 'show', 'set', 'a', 'l', 'r', 'address', 'neigh'],
  route: ['-n', 'add', 'del', 'default', 'gw'],
  arp: ['-a', '-d', '-s'],
  ifconfig: ['-a', 'up', 'down', 'eth0', 'inet', 'netmask'],
  ethtool: ['-S', '-i', '-p', '-s', 'eth0'],
  tcpdump: ['-i', '-n', '-v', '-c', '-w', '-r', '-X', 'port', 'host', 'tcp', 'udp'],
  rsync: ['-avz', '-r', '-a', '-v', '-z', '-e', '--delete', '--exclude', '--progress', '-au'],
  mount: ['-t', '-o', '-a', '-r', '-w', 'ext4', 'nfs', 'proc'],
  umount: ['-l', '-f', '-a', '-t'],
  fdisk: ['-l', '--list'],
  parted: ['print', 'mkpart', 'rm', 'resizepart', '-s'],
  mkfs: ['-t', 'ext4', '-L', '-f', '-V'],
  fsck: ['-f', '-y', '-a', '-V'],
  blkid: ['-s', '-o', '-p'],
  lsblk: ['-f', '-a', '-l', '-o', '-p', '-t'],
  df: ['-h', '-T', '-i', '-a', '-k', '-l'],
  du: ['-h', '-s', '-a', '-c', '--max-depth', '-sh', '--total'],
  swapon: ['-s', '-a', '-f'],
  swapoff: ['-a', '-v'],

  /* dev */
  go: ['run', 'build', 'test', 'mod', 'get', 'install', 'fmt', 'vet', 'env', 'list', 'tidy', 'init', 'work'],
  pip: ['install', 'uninstall', 'freeze', 'list', 'show', 'search', 'upgrade', 'download', '--user', '-r', '-i'],
  pip3: ['install', 'uninstall', 'freeze', 'list', 'show', 'search', 'upgrade', 'download', '--user', '-r', '-i'],
  python: ['-m', '-c', '-V', '-i', 'pip', 'venv', 'http.server', 'unittest'],
  python3: ['-m', '-c', '-V', '-i', 'pip', 'venv', 'http.server', 'unittest'],
  node: ['-v', '-e', '-p', '--version', 'index.js', 'server.js'],
  java: ['-version', '-jar', '-cp', '-D', '-Xmx', '-Xms', '-Xdebug'],
  javac: ['-d', '-cp', '-encoding', '-version'],
  cargo: ['build', 'run', 'test', 'check', 'add', 'remove', 'update', 'fmt', 'clippy', 'doc', 'init', 'new', 'install', 'publish'],
  rustc: ['-o', '-O', '-g', '--edition'],
  gcc: ['-o', '-c', '-g', '-O2', '-Wall', '-I', '-L', '-l', '-std'],
  'g++': ['-o', '-c', '-g', '-O2', '-Wall', '-I', '-L', '-l', '-std'],
  clang: ['-o', '-c', '-g', '-O2', '-Wall', '-I', '-L', '-l', '-std'],
  make: ['install', 'clean', 'test', 'run', 'build', 'all', '-j', '-f', '-C'],
  cmake: ['..', '-B', '-S', '-G', '-D', '--build'],
  gofmt: ['-w', '-l', '-s', '-r'],
  git: ['status', 'add', 'commit', 'push', 'pull', 'clone', 'checkout', 'branch', 'merge', 'log', 'diff', 'stash', 'tag', 'remote', 'fetch', 'rebase', 'reset', 'init', 'config', 'show', 'blame', 'revert', '-a', '-m', '-am', '--all', '--force', '--hard'],
  docker: ['run', 'exec', 'ps', 'images', 'build', 'pull', 'push', 'logs', 'stop', 'start', 'restart', 'rm', 'rmi', 'network', 'volume', 'compose', 'info', 'version', '-it', '-d', '-p', '-v', '--rm', '--name', '--network'],
  'docker-compose': ['up', 'down', 'logs', 'ps', 'build', 'pull', 'restart', 'stop', 'start', '-d', '-f'],
  npm: ['install', 'uninstall', 'run', 'start', 'test', 'build', 'publish', 'update', 'list', 'init', 'exec', 'audit', 'i', '-g', '--save', '--save-dev'],
  pnpm: ['install', 'add', 'remove', 'run', 'start', 'test', 'build', 'publish', 'update', 'list', 'init', '-g', '--save-dev'],
  yarn: ['install', 'add', 'remove', 'run', 'start', 'test', 'build', 'publish', 'upgrade', 'list', 'init'],
  nginx: ['-t', '-s', 'reload', 'stop', 'start', '-c'],
  systemctl: ['start', 'stop', 'restart', 'status', 'enable', 'disable', 'reload', 'daemon-reload', 'list-units', 'list-timers', 'list-sockets', 'mask', 'unmask', '--user', '--no-pager', 'nginx', 'docker', 'mysql', 'ssh', 'cron'],
  service: ['start', 'stop', 'restart', 'status', 'reload', 'enable', 'nginx', 'mysql', 'docker'],
  journalctl: ['-u', '-f', '-b', '-p', '-n', '--since', '--until', '--no-pager', '-xe'],

  /* pkg mgmt */
  apt: ['install', 'remove', 'update', 'upgrade', 'search', 'show', 'purge', 'autoremove', 'list', '--fix-broken', '-y'],
  'apt-get': ['install', 'remove', 'update', 'upgrade', 'autoremove', 'purge', 'dist-upgrade', 'clean', 'autoclean', '-y'],
  'apt-cache': ['search', 'show', 'policy', 'depends'],
  yum: ['install', 'remove', 'update', 'search', 'info', 'list', 'clean', 'repolist', '-y'],
  dnf: ['install', 'remove', 'update', 'search', 'info', 'list', 'clean', 'repolist', '-y'],
  pacman: ['-S', '-Sy', '-Syu', '-Ss', '-S', '-R', '-Rs', '-Q', '-Qs', '--noconfirm'],
  apk: ['add', 'del', 'update', 'upgrade', 'search', 'info', '--no-cache'],
  brew: ['install', 'uninstall', 'update', 'upgrade', 'search', 'list', 'info', 'services', 'cleanup'],
  snap: ['install', 'remove', 'list', 'refresh', 'info', 'services'],

  /* databases */
  mysql: ['-u', '-p', '-h', '-P', '-e', '-D', '--host', '--user', '--password', '--port', '--database', 'root', 'localhost'],
  mysqldump: ['-u', '-p', '-h', '-P', '--all-databases', '--single-transaction', '-d', '--no-data'],
  psql: ['-U', '-h', '-p', '-d', '-c', '-f', '-l', '-W'],
  sqlite3: ['.tables', '.schema', '.databases', '.quit', '.headers', '.mode'],
  'redis-cli': ['-h', '-p', '-a', '--raw', 'ping', 'get', 'set', 'del', 'keys', 'info', '--scan', 'flushall', 'incr', 'expire', 'ttl'],
  mongosh: ['--host', '--port', '--username', '--password', '--authenticationDatabase', 'show dbs', 'use'],
};

/** Common shell commands for instant prefix filtering on the command
 *  position — typing `p` lists every `p*` command locally, then narrows as
 *  you keep typing, before any remote round-trip completes. */
export function PtyTerminal({
  connectionId,
  connectionName,
  defaultDirectory,
  terminalEncoding = 'utf-8',
  host = 'localhost', 
  username = 'user',
  appearanceKey = 0,
  themeKey = 0,
  isActive = true,
  onConnectionStatusChange
}: PtyTerminalProps) {
  const { t } = useTranslation();
  const { onReconnectTab, onWorkingDirectoryChange, getWorkingDirectory } = useTerminalCallbacks();

  // Suggestion context: per-connection scope key + current cwd scope key.
  const connScope = React.useMemo(() => connectionScope(connectionId), [connectionId]);
  const currentCwdScope = React.useMemo(() => {
    const path = getWorkingDirectory?.(connectionId);
    return path ? cwdScope(path) : null;
  }, [connectionId, getWorkingDirectory]);
  // The WS/onData effect closures are mounted once; reading a ref keeps the
  // latest cwd scope (OSC 7 updates) without remounting the terminal.
  const cwdScopeRef = React.useRef<string | null>(currentCwdScope);
  React.useEffect(() => {
    cwdScopeRef.current = currentCwdScope;
  }, [currentCwdScope]);

  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const rendererRef = React.useRef<string>('canvas');
  const webglAddonRef = React.useRef<WebglAddon | null>(null);
  // Renderer-occlusion recovery, installed by the main terminal effect. Kept
  // in a ref so the isActive effect can run it when a hidden tab is shown
  // again (tab switches do not fire visibilitychange/focus).
  const recoverRendererRef = React.useRef<(() => void) | null>(null);
  const clipboardAddonRef = React.useRef<ClipboardAddon | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const initialIsActiveRef = React.useRef(isActive);
  const wasActiveRef = React.useRef(isActive);
  
  // Search bar state
  const [searchVisible, setSearchVisible] = React.useState(false);
  const [searchFocusTrigger, setSearchFocusTrigger] = React.useState(0);
  const searchStateRef = React.useRef<TerminalSearchState>({ query: '', caseSensitive: false, regex: false });
  const [hasSelection, setHasSelection] = React.useState(false);

  // Scrollbar visibility — only show when buffer overflows the visible rows
  const [hasScrollableContent, setHasScrollableContent] = React.useState(false);

  // Unique CSS scoping class for this instance — prevents dynamic scrollbar rules
  // injected via <style> from bleeding across multiple mounted terminals on the page.
  const scopeId = React.useId().replace(/:/g, '');
  
  // Track whether terminal was created with background image (determines renderer choice)
  const hadBackgroundImageRef = React.useRef<boolean | null>(null);
  // Track connection status to avoid duplicate notifications
  const connectionStatusRef = React.useRef<'connected' | 'connecting' | 'disconnected'>('connecting');
  
  // PTY session generation — used in Close to avoid stale-close races
  const ptyGenerationRef = React.useRef<number | null>(null);
  
  // Reconnect key — incrementing this forces the main effect to tear down and rebuild
  const [reconnectKey, setReconnectKey] = React.useState(0);

  // Command suggestion (Tab-completion hints from the remote shell)
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [suggestionsVisible, setSuggestionsVisible] = React.useState(false);
  // -1 = nothing selected: Enter runs the typed command unless the user has
  // explicitly picked a suggestion with ↑/↓ (or mouse).
  const [selectedIndex, setSelectedIndex] = React.useState(-1);
  // -1 = no hover. Hover is a *preview* only — it never drives Enter (only
  // selectedIndex does). Keyboard selection clears hover so ↑/↓ wins.
  const [hoverIndex, setHoverIndex] = React.useState(-1);
  const [suggestionPos, setSuggestionPos] = React.useState({ left: 12, top: 12 });
  const inputBufferRef = React.useRef('');
  const suggestTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionsRef = React.useRef<string[]>([]);
  const suggestionsVisibleRef = React.useRef(false);
  const selectedIndexRef = React.useRef(-1);
  const hoverIndexRef = React.useRef(-1);
  const suppressSuggestionsRef = React.useRef(false);
  const suggestionBarRef = React.useRef<HTMLDivElement | null>(null);
  // TUI gate: true while a full-screen app (vim/less/top/htop/...) owns the
  // terminal (alternate screen buffer active). While true the suggestion popup
  // is hard-disabled — keys belong to the app, not to the shell.
  const tuiActiveRef = React.useRef(false);
  // Command-suggestion master switch (settings → app_settings → event).
  const suggestionsEnabledRef = React.useRef(true);
  // TUI hard-gate master switch: when false, the G1 alternate-buffer gate is
  // disabled entirely (restores pre-Slice-1 behavior). Defaults to true.
  const tuiGateEnabledRef = React.useRef(true);
  // IME composition gate: while a CJK/IME composition session is active the
  // key stream is not shell input yet — never track or pop suggestions.
  const imeComposingRef = React.useRef(false);
  // Bracketed-paste gate: while a bracketed paste (\x1b[200~ … \x1b[201~)
  // streams in, the text is not interactive typing — never track or pop.
  const pastingRef = React.useRef(false);
  // Suggestion debounce delay (ms), from settings (default 50).
  const suggestDebounceRef = React.useRef(50);
  React.useEffect(() => {
    const read = () => {
      try {
        const parsed = prefGet<{
          commandSuggestions?: unknown;
          suggestionDebounceMs?: unknown;
          suggestionTuiGateEnabled?: unknown;
        } | null>(
          APP_SETTINGS_STORAGE_KEY,
          null,
        );
        suggestionsEnabledRef.current = parsed?.commandSuggestions !== false;
        tuiGateEnabledRef.current = parsed?.suggestionTuiGateEnabled !== false;
        suggestDebounceRef.current = normalizeSuggestionDebounceMs(parsed?.suggestionDebounceMs);
        if (!suggestionsEnabledRef.current) {
          setSuggestionsVisible(false);
          suggestionsVisibleRef.current = false;
        }
      } catch {
        suggestionsEnabledRef.current = true;
        tuiGateEnabledRef.current = true;
        suggestDebounceRef.current = 50;
      }
    };
    read();
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, read);
    return () => window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, read);
  }, []);

  // Remote Tab-completion tracking: Tab is passed through to the shell, which
  // completes the line remotely; we remember the pre-completion input so the
  // completed command can be captured from the terminal line afterwards and
  // recorded for future suggestions.
  const preTabInputRef = React.useRef('');
  const tabPendingRef = React.useRef(false);
  // Keep refs in sync for use inside the key handler closure.
  suggestionsRef.current = suggestions;
  suggestionsVisibleRef.current = suggestionsVisible;
  selectedIndexRef.current = selectedIndex;
  hoverIndexRef.current = hoverIndex;
  
  // Exponential backoff reconnection tracking
  const reconnectAttemptsRef = React.useRef(0);
  /** How long to wait after a full-reconnect call before assuming it failed
   *  and scheduling the next backoff attempt (ms). */
  const RECONNECT_PROBE_MS = 15_000;
  
  // Auto-reconnect attempt counter (kept across the backoff loop; only
  // informational — the loop never stops on its own).
  const autoReconnectAfterDropRef = React.useRef(0);

  // Cumulative bytes written to xterm this session — reset on clear.
  const sessionOutputRef = React.useRef(0);
  const inputEncoderRef = React.useRef(new TextEncoder());

  const sendInputToPty = React.useCallback((data: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const dataBytes = Array.from(inputEncoderRef.current.encode(data));
    ws.send(JSON.stringify({
      type: 'Input',
      connection_id: connectionId,
      data: dataBytes,
    }));
    return true;
  }, [connectionId]);

  const pasteClipboardIntoPty = React.useCallback(async () => {
    try {
      const text = await readClipboardText();
      if (!text) return;
      const term = xtermRef.current;
      if (!term) {
        toast.error(t('ptyTerminal.terminalNotConnected'));
        return;
      }
      // term.paste() routes through xterm's onData handler,
      // which calls sendInputToPty with proper bracketed paste wrapping
      term.paste(text);
    } catch (_error) {
      toast.error(t('ptyTerminal.failedToReadClipboard'));
    }
  }, [t]);

  // Get appearance settings - reloads when appearanceKey changes
  const appearance = React.useMemo(() => loadAppearanceSettings(), [appearanceKey]);
  
  // Track whether we need to switch renderers due to background image change
  // This is necessary because WebGL renderer doesn't support transparency
  const hasBackgroundImage = !!appearance.backgroundImage;
  
  // Use a key that only changes when we need to switch renderers
  const terminalKey = React.useMemo(() => {
    // Update the ref to track current state
    const key = hasBackgroundImage ? 'bg' : 'no-bg';
    hadBackgroundImageRef.current = hasBackgroundImage;
    return key;
  }, [hasBackgroundImage]);
  
  /* ── command suggestion (remote Tab-completion hints) ────────────────── */

  /** Read the full text of the current terminal line (prompt + command). */
  const readTerminalLine = (): string => {
    const term = xtermRef.current;
    if (!term) return '';
    const buffer = term.buffer.active;
    const line = buffer.getLine(buffer.cursorY);
    return line ? line.translateToString(true).trimEnd() : '';
  };

  /** After a remote Tab-completion, extract the completed command from the line. */
  const extractCompletedCommand = (fullLine: string): string => {
    const pre = preTabInputRef.current.trim();
    if (!pre) return fullLine.trim();
    const idx = fullLine.lastIndexOf(pre);
    return idx >= 0 ? fullLine.slice(idx).trim() : fullLine.trim();
  };

  const computeCursorPosition = () => {
    const term = xtermRef.current;
    const container = containerRef.current;
    if (!term || !container) return { left: 12, top: 12 };
    const element = term.element;
    if (!element) return { left: 12, top: 12 };
    const buffer = term.buffer.active;
    const cursorX = buffer.cursorX;
    const cursorY = buffer.cursorY;
    // Use the xterm root element geometry (always present, works with the
    // WebGL renderer too — no per-row DOM elements exist there).
    const containerRect = container.getBoundingClientRect();
    const elRect = element.getBoundingClientRect();
    const offsetX = elRect.left - containerRect.left;
    const offsetY = elRect.top - containerRect.top;
    const lineHeight = (element.clientHeight || container.clientHeight) / Math.max(1, term.rows);
    const cellWidth = (element.clientWidth || container.clientWidth) / Math.max(1, term.cols);
    const BOX_W = 340;
    // Use the REAL popup height once it is committed to the DOM; fall back to
    // an estimate on the very first paint (suggestionBarRef is still null
    // before React commits). Estimate: 156 px ≈ 24 px header (label + kbd +
    // padding) + 6 × 22 px candidate rows (slice(0, 6) caps the list). A wrong
    // below/above flip from the estimate is corrected on the next frame by
    // refreshSuggestionPosition, which re-runs this function with the actual
    // height.
    const BOX_H = suggestionBarRef.current?.offsetHeight ?? 156;
    const left = Math.max(8, Math.min(offsetX + cursorX * cellWidth, container.clientWidth - BOX_W - 8));
    const below = offsetY + cursorY * lineHeight + lineHeight + 6;
    const top = below + BOX_H <= container.clientHeight
      ? Math.max(8, below)
      : Math.max(8, offsetY + cursorY * lineHeight - BOX_H - 6);
    return { left, top };
  };

  /** Recompute the suggestion box position on the next frame, after xterm has
   *  updated the buffer/cursor (remote echo, local input). No-op when hidden. */
  const refreshSuggestionPosition = () => {
    requestAnimationFrame(() => {
      if (suggestionsVisibleRef.current) {
        setSuggestionPos(computeCursorPosition());
      }
    });
  };

  const cycleSuggestion = (dir: number) => {
    const count = suggestionsRef.current.length;
    if (count === 0) return;
    // From "nothing selected", ↓ goes to the first, ↑ to the last.
    let next: number;
    if (selectedIndexRef.current === -1) {
      next = dir > 0 ? 0 : count - 1;
    } else {
      next = (selectedIndexRef.current + dir + count) % count;
    }
    selectedIndexRef.current = next;
    setSelectedIndex(next);
    // Keyboard selection wins over mouse preview: drop any hover highlight.
    hoverIndexRef.current = -1;
    setHoverIndex(-1);
  };

  /** Record executed commands so frequent ones rank higher in suggestions. */
  /** Record an executed command into the learning store (sensitive-filtered). */
  const recordCommand = (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    // Only keep COMPLETE, meaningful commands: drop obvious junk — single
    // characters (accidental keys), pure punctuation, and commands that end
    // with a line continuation (they were split across lines / unfinished).
    if (trimmed.length < 2) return;
    if (trimmed.endsWith('\\')) return;
    if (!/[a-zA-Z0-9_./-]/.test(trimmed)) return; // no command word at all
    // A command that starts a new shell/editor (interactive session) is not a
    // recordable one-shot — the user keeps typing inside it.
    const interactive = ['ssh ', 'sftp ', 'mysql ', 'psql ', 'redis-cli', 'vim ', 'vi ', 'nano ', 'top', 'htop', 'python', 'python3', 'node', 'bash', 'sh ', 'zsh', 'fish'];
    if (interactive.some((p) => trimmed === p.trim() || trimmed.startsWith(`${p} `))) return;
    try {
      recordUse(trimmed, connScope, cwdScopeRef.current);
      // Also persist to the command-history view (command_usage/history tables).
      recordExecutedCommand(trimmed);
    } catch {
      /* suggestion learning must never break the terminal */
    }
  };

  /** Curated static options for the current command (from COMMAND_CANDIDATES). */
  const curatedOptionsFor = (input: string): string[] => {
    const afterSepRaw = input.split(/[|;&]/).pop() ?? '';
    const segWords = afterSepRaw.trim().split(/\s+/);
    const first = segWords[0] ?? '';
    const curated = COMMAND_CANDIDATES[first];
    return curated ?? [];
  };

  /** Build the ranked candidate list + display mode via the suggestion engine. */
  const computeSuggestions = (input: string) => {
    // Global learning is always relevant; connection + cwd scopes boost it.
    const scopes = [SCOPE_GLOBAL, connScope];
    const cwdKey = cwdScopeRef.current;
    if (cwdKey) scopes.push(cwdKey);
    const stats = getStatsForScopes(scopes);
    const result = rankSuggestions(input, stats, {
      connectionScope: connScope,
      cwdScopeKey: cwdKey,
      curated: curatedOptionsFor(input),
    });
    return result;
  };

  const trackInputForSuggestion = (data: string) => {
    // IME gate: keys during a composition session are candidate text, not
    // shell input — never track them.
    if (imeComposingRef.current) return;
    // Paste gate: bracketed-paste text streaming in is not typing.
    if (pastingRef.current) return;
    // TUI gate: keys belong to a full-screen app, never track them as shell
    // input. The hard gate can be disabled via settings (suggestionTuiGateEnabled).
    if (tuiActiveRef.current && tuiGateEnabledRef.current) return;
    for (const ch of data) {
      // Tab itself is handled by the remote shell (readline completion); the
      // completed line is captured on the next keystroke or on Enter.
      if (ch === '\t') continue;

      // Any input arriving after a remote Tab-completion: the terminal line
      // has (usually) been redrawn with the completed command — resync the
      // tracked buffer so subsequent suggestions and history records use the
      // full command.
      if (tabPendingRef.current) {
        const fullCmd = extractCompletedCommand(readTerminalLine());
        if (fullCmd && fullCmd !== preTabInputRef.current.trim()) {
          inputBufferRef.current = fullCmd;
        }
        tabPendingRef.current = false;
      }

      if (ch === '\r' || ch === '\n') {
        // Command submitted — remember it for future suggestions.
        recordCommand(inputBufferRef.current);
        inputBufferRef.current = '';
        setSuggestionsVisible(false);
        suggestionsVisibleRef.current = false;
      } else if (ch === '\x03' || ch === '\x04' || ch === '\x1b') {
        // Ctrl+C / Ctrl+D / escape sequences reset the readline buffer
        inputBufferRef.current = '';
        setSuggestionsVisible(false);
        suggestionsVisibleRef.current = false;
      } else if (ch === '\x7f') {
        // Backspace: update the buffer AND refresh suggestions, just like
        // typing a character.
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        if (!inputBufferRef.current.trim()) {
          setSuggestionsVisible(false);
          suggestionsVisibleRef.current = false;
        }
        if (suggestionsVisibleRef.current) {
          setSuggestionPos(computeCursorPosition());
        }
        scheduleSuggestion();
      } else if (ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127) {
        inputBufferRef.current += ch;
        // The box follows the cursor on every keystroke.
        if (suggestionsVisibleRef.current) {
          setSuggestionPos(computeCursorPosition());
        }
        scheduleSuggestion();
      }
    }
  };

  const scheduleSuggestion = () => {
    if (!suggestionsEnabledRef.current) return;
    if (suppressSuggestionsRef.current) return;
    // IME gate: never schedule while a composition session is active.
    if (imeComposingRef.current) return;
    // Paste gate: never schedule while a bracketed paste is streaming in.
    if (pastingRef.current) return;
    if (tuiActiveRef.current && tuiGateEnabledRef.current) return;
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(() => {
      const input = inputBufferRef.current;
      if (!input.trim()) {
        setSuggestionsVisible(false);
        suggestionsVisibleRef.current = false;
        return;
      }
      // TUI gate (re-check after the debounce window): if a full-screen app
      // took over meanwhile, never pop the suggestion.
      if (tuiActiveRef.current && tuiGateEnabledRef.current) return;
      // Prompt-line gate: only suggest while the shell is actually waiting for
      // input on a line that contains what the user typed. Keys consumed by a
      // line-editor app (mysql/psql) or by TUI navigation never reach the line,
      // so no popup.
      if (!isInputInPromptContext(readTerminalLine(), input)) {
        setSuggestionsVisible(false);
        suggestionsVisibleRef.current = false;
        return;
      }
      try {
        const result = computeSuggestions(input);
        if (result.mode === 'popup' && result.candidates.length > 0) {
          setSuggestions(result.candidates.map((c) => c.command));
          setSuggestionsVisible(true);
          suggestionsVisibleRef.current = true;
          // No suggestion is pre-selected: the user must pick one with ↑/↓ or
          // the mouse, so Enter executes what they typed instead.
          setSelectedIndex(-1);
          selectedIndexRef.current = -1;
          // Candidates were recomputed — a stale selection/hover index could
          // point past the new list length (Enter would become a dead key).
          setHoverIndex(-1);
          hoverIndexRef.current = -1;
          setSuggestionPos(computeCursorPosition());
          // The synchronous estimate above runs BEFORE the popup DOM is
          // committed, so suggestionBarRef is still null and BOX_H fell back
          // to 190. Re-run on the next frame (after commit) so the real popup
          // height drives the below/above flip — keeps the box glued to the
          // cursor even at the bottom of the viewport.
          refreshSuggestionPosition();
        } else {
          setSuggestionsVisible(false);
          suggestionsVisibleRef.current = false;
        }
      } catch {
        // Engine failure must never affect the terminal — suggestions just hide.
        setSuggestionsVisible(false);
        suggestionsVisibleRef.current = false;
      }
    }, suggestDebounceRef.current);
  };

  const acceptSuggestion = (cmd: string) => {
    const buf = inputBufferRef.current;
    // Positive feedback: the user picked this suggestion — boost it for the
    // global and connection scopes (cwd scope if it matches current dir).
    try {
      recordSelection(cmd, connScope);
      if (cwdScopeRef.current) recordSelection(cmd, cwdScopeRef.current);
    } catch {
      /* non-critical */
    }

    // ── Mid-line cursor: the cursor is NOT at the end of the line. Replace
    // the token at/under the cursor instead of assuming end-of-line, keeping
    // any text after the token intact. Only runs when the tracked buffer still
    // aligns with the visible line (line = prompt + buf), otherwise we fall
    // back to the end-of-line logic below.
    const term = xtermRef.current;
    const buffer = term?.buffer.active;
    const line = buffer?.getLine(buffer.cursorY);
    if (term && buffer && line) {
      const lineRaw = line.translateToString(false);
      const cursorX = buffer.cursorX;
      let atLineEnd = cursorX >= lineRaw.length;
      if (!atLineEnd) {
        atLineEnd = true;
        for (let i = cursorX; i < lineRaw.length; i++) {
          if (lineRaw[i] !== ' ') { atLineEnd = false; break; }
        }
      }
      if (!atLineEnd) {
        // Prompt length estimate: the visible line is `prompt + buf` when the
        // tracked buffer matches what the user typed.
        let promptLen = -1;
        if (lineRaw.endsWith(buf)) promptLen = lineRaw.length - buf.length;
        else if (lineRaw.trimEnd().endsWith(buf.trim())) promptLen = lineRaw.trimEnd().length - buf.trim().length;
        if (promptLen >= 0 && cursorX >= promptLen) {
          // The candidate equals the whole typed input — nothing to change,
          // just move the cursor to the end of the line.
          if (cmd.trim() === lineRaw.slice(promptLen).trim()) {
            let charsToEnd = 0;
            for (let i = cursorX; i < lineRaw.length; i++) {
              if (lineRaw[i] !== ' ') charsToEnd++;
            }
            sendInputToPty('\x1b[C'.repeat(charsToEnd));
            inputBufferRef.current = lineRaw.slice(promptLen);
            hideSuggestions();
            suppressSuggestionsRef.current = true;
            window.setTimeout(() => {
              suppressSuggestionsRef.current = false;
            }, 250);
            return;
          }
          // Otherwise replace the token at the cursor (on a space → the token
          // on its left).
          let tokenStart: number;
          let tokenEnd: number;
          let rightLen: number;
          if (lineRaw[cursorX] === ' ') {
            tokenEnd = cursorX;
            let s = cursorX - 1;
            while (s >= 0 && lineRaw[s] !== ' ') s--;
            tokenStart = s + 1;
            rightLen = 0;
          } else {
            let e = cursorX;
            while (e < lineRaw.length && lineRaw[e] !== ' ') e++;
            tokenEnd = e;
            let s = cursorX - 1;
            while (s >= 0 && lineRaw[s] !== ' ') s--;
            tokenStart = s + 1;
            rightLen = tokenEnd - cursorX;
          }
          const tokLen = tokenEnd - tokenStart;
          if (tokLen > 0) {
            // Move the cursor past the token, backspace it, then insert the
            // candidate — anything after the token shifts right untouched.
            sendInputToPty('\x1b[C'.repeat(rightLen) + '\x7f'.repeat(tokLen) + cmd);
            inputBufferRef.current = lineRaw.slice(promptLen, tokenStart) + cmd + lineRaw.slice(tokenEnd);
            hideSuggestions();
            suppressSuggestionsRef.current = true;
            window.setTimeout(() => {
              suppressSuggestionsRef.current = false;
            }, 250);
            return;
          }
        }
      }
    }

    // ── End-of-line segment replacement ────────────────────────────────
    // Segment = everything after the last `|` (pipeline). Only the final
    // segment is completed; earlier pipeline stages stay untouched.
    const seg = buf.split('|').pop() ?? '';
    const segTrimmed = seg.trimStart();
    const L = seg.trim();
    // Everything before the segment (keeps the `| ` separator space: the
    // backspaces below only erase the trimmed segment text, never the space).
    const prefix = buf.slice(0, buf.length - segTrimmed.length);

    // A1: the candidate equals what was already typed — nothing to change.
    if (cmd === L) {
      hideSuggestions();
      return;
    }
    // A2: the candidate extends the typed segment — send only the missing
    // tail. trimStart() drops the leading space of the tail when the typed
    // segment already ends with a space (`git ` → tail `commit`, not
    // ` commit`), so no double-space ever reaches the shell.
    if (cmd.startsWith(L) && cmd.length > L.length) {
      const tail = cmd.slice(L.length).trimStart();
      sendInputToPty(tail + ' ');
      // buf already ends with the typed segment → append the tail.
      inputBufferRef.current = buf + tail + ' ';
      hideSuggestions();
      // Briefly suppress re-popup while the pasted characters stream through.
      suppressSuggestionsRef.current = true;
      window.setTimeout(() => {
        suppressSuggestionsRef.current = false;
      }, 250);
      return;
    }
    // A3: replace the whole segment — backspace it, then type the candidate.
    // Send through the key-input path (NOT term.paste): paste routes through
    // bracketed-paste mode where control chars like backspace are inserted
    // literally (showing as ^?). Direct input lets readline process them.
    const backspaces = '\x7f'.repeat(segTrimmed.length);
    sendInputToPty(backspaces + cmd + ' ');
    // Direct send bypasses onData, so sync the tracked input buffer manually.
    inputBufferRef.current = prefix + cmd + ' ';
    hideSuggestions();
    suppressSuggestionsRef.current = true;
    window.setTimeout(() => {
      suppressSuggestionsRef.current = false;
    }, 250);
  };

  const acceptSelected = () => {
    const list = suggestionsRef.current;
    if (list.length === 0) return;
    const idx = selectedIndexRef.current;
    if (idx < 0 || idx >= list.length) return; // nothing selected
    const cmd = list[idx];
    acceptSuggestion(cmd);
  };

  /** Accept the inline grey hint (completes the command tail). */
  // Keep the suggestion box glued to the cursor on window resize.
  React.useEffect(() => {
    const updatePos = () => {
      if (suggestionsVisibleRef.current) setSuggestionPos(computeCursorPosition());
    };
    window.addEventListener('resize', updatePos);
    return () => window.removeEventListener('resize', updatePos);
  }, []);

  const hideSuggestions = () => {
    setSuggestionsVisible(false);
    suggestionsVisibleRef.current = false;
    setSelectedIndex(-1);
    selectedIndexRef.current = -1;
    setHoverIndex(-1);
    hoverIndexRef.current = -1;
  };

  React.useEffect(() => {
    if (!terminalRef.current) return;

    // Load appearance settings
    const appearance = loadAppearanceSettings();
    const termOptions = getThemeAwareTerminalOptions(appearance);

    // Create terminal with user's appearance settings
    const term = new XTerm(termOptions);
    const workingDirectoryDisposable = registerTerminalWorkingDirectoryHandler(
      term.parser,
      (path) => onWorkingDirectoryChange?.(connectionId, path),
    );

    const fitAddon = new FitAddon();
    const webLinks = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    term.loadAddon(searchAddon);
    // Unicode 11 width tables — CJK (Chinese/Japanese/Korean) characters must
    // occupy two cells, otherwise the cursor position and IME output drift.
    term.loadAddon(new Unicode11Addon());
    if (term.unicode) {
      term.unicode.activeVersion = '11';
    }
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(clipboardAddon);
    clipboardAddonRef.current = clipboardAddon;
    
    term.open(terminalRef.current);
    
    // --- WebGL renderer setup + occlusion (花屏) recovery ---------------
    // WKWebView (Tauri on macOS) can discard the drawing buffer — and
    // sometimes kill the whole GL context without firing webglcontextlost —
    // whenever a canvas stops being composited: hidden terminal tabs
    // (display:none), an occluded/minimized window, or App Nap suspension
    // ("放一会"). xterm only re-renders dirty rows, so nothing repaints and
    // the screen stays garbled until new output arrives. Two defences:
    //   1. preserveDrawingBuffer=true keeps the last good frame in the
    //      buffer so an evicted composite shows stale-but-valid pixels.
    //   2. On visibility/focus regain, rebuild the renderer if the GL
    //      context died and force a full-row repaint.
    const fallBackFromWebgl = () => {
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        webglAddonRef.current = null;
      }
      rendererRef.current = 'canvas';
      console.warn('[PTY Terminal] WebGL context lost, falling back to DOM renderer');
    };
    const attachWebglAddon = () => {
      const webglAddon = new WebglAddon(true);
      webglAddon.onContextLoss(fallBackFromWebgl);
      term.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
      rendererRef.current = 'webgl';
    };
    const recoverFromOcclusion = () => {
      if (webglAddonRef.current && (terminalRef.current?.offsetWidth ?? 0) > 0) {
        const glCanvas = terminalRef.current?.querySelector('canvas');
        const gl =
          (glCanvas as HTMLCanvasElement | null)?.getContext('webgl2') ??
          (glCanvas as HTMLCanvasElement | null)?.getContext('webgl') ??
          null;
        if (gl?.isContextLost()) {
          console.warn('[PTY Terminal] WebGL context lost while occluded, rebuilding renderer');
          try { webglAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
          webglAddonRef.current = null;
          try {
            attachWebglAddon();
          } catch (e) {
            rendererRef.current = 'canvas';
            console.warn('[PTY Terminal] WebGL rebuild failed, staying on DOM renderer:', e);
          }
        }
      }
      if (term.rows > 0) {
        term.refresh(0, term.rows - 1);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        recoverFromOcclusion();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', recoverFromOcclusion);
    recoverRendererRef.current = recoverFromOcclusion;

    // Load WebGL renderer for better performance
    // NOTE: WebGL doesn't support transparency, so skip it when background image is set
    if (!appearance.backgroundImage) {
      try {
        attachWebglAddon();
        console.log('[PTY Terminal] WebGL renderer loaded');
      } catch (e) {
        rendererRef.current = 'canvas';
        console.warn('[PTY Terminal] WebGL not supported, falling back to canvas:', e);
      }
    } else {
      rendererRef.current = 'canvas';
      console.log('[PTY Terminal] Using canvas renderer (background image requires transparency)');
    }
    
    fitAddon.fit();

    // Store refs
    xtermRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;

    // Scrollbar visibility: show only when content overflows the viewport.
    const checkScrollability = () => {
      setHasScrollableContent(term.buffer.active.length > term.rows);
    };
    const lineFeedDisposable = term.onLineFeed(checkScrollability);

    // TUI gate: when a full-screen app enters the alternate screen buffer
    // (vim/less/top/htop/fzf...), hard-disable the command-suggestion popup —
    // the keys now belong to that app, not to the shell. Restore tracking as
    // soon as the app exits back to the normal buffer.
    const bufferChangeDisposable = term.buffer.onBufferChange((buffer) => {
      const inTui = isAlternateBuffer(buffer.type);
      tuiActiveRef.current = inTui;
      // When the TUI hard gate is disabled via settings, entering the
      // alternate buffer must NOT tear down the tracked input / popup state
      // (that would restore the gate even though the toggle is off). The
      // tracking/scheduling checks already consult tuiGateEnabledRef.
      if (inTui && tuiGateEnabledRef.current) {
        if (suggestTimerRef.current) {
          clearTimeout(suggestTimerRef.current);
          suggestTimerRef.current = null;
        }
        inputBufferRef.current = '';
        // Clear Tab-completion bookkeeping too: a stale preTabInputRef /
        // tabPendingRef would otherwise poison the resync path after exiting
        // the TUI, recording a garbage command (prompt text included) on Enter.
        preTabInputRef.current = '';
        tabPendingRef.current = false;
        setSuggestionsVisible(false);
        suggestionsVisibleRef.current = false;
        setSelectedIndex(-1);
        selectedIndexRef.current = -1;
      }
    });

    // Suggestion-dismissal gates (focus loss / scroll / IME composition).
    // xterm v6 has no onFocus/onBlur events and no IME event API, so these
    // listen on the hidden input textarea — the same element xterm's own
    // CompositionHelper and focus handling use, so the events are guaranteed
    // to target it (term.textarea is created once during term.open()).
    //
    // G2 IME gate: while a composition session is active the key stream is
    // candidate text, not shell input — hide the popup and block tracking.
    const suggestionGateTextarea = term.textarea;
    const onSuggestionImeStart = () => {
      imeComposingRef.current = true;
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = null;
      }
      setSuggestionsVisible(false);
      suggestionsVisibleRef.current = false;
    };
    const onSuggestionImeEnd = () => {
      imeComposingRef.current = false;
    };
    // G4 focus gate: leaving the terminal hides the popup (inputBuffer kept,
    // so returning + typing resumes tracking naturally).
    const onSuggestionBlur = () => {
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = null;
      }
      setSuggestionsVisible(false);
      suggestionsVisibleRef.current = false;
    };
    if (suggestionGateTextarea) {
      suggestionGateTextarea.addEventListener('compositionstart', onSuggestionImeStart);
      suggestionGateTextarea.addEventListener('compositionend', onSuggestionImeEnd);
      suggestionGateTextarea.addEventListener('blur', onSuggestionBlur);
    }

    // G5 scroll gate: scrolling the scrollback away from the prompt line
    // dismisses the popup (candidates no longer align with the cursor).
    const scrollDisposable = term.onScroll(() => {
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = null;
      }
      setSuggestionsVisible(false);
      suggestionsVisibleRef.current = false;
    });

    // Focus terminal to enable keyboard input when this tab is mounted active.
    if (initialIsActiveRef.current) {
      term.focus();
    }
    
    // Track selection changes for context menu
    term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

    // NOTE: No custom paste event listener needed — xterm.js registers its own
    // paste handler on the textarea that reads clipboard data, applies bracketed
    // paste mode wrapping (ESC[200~/ESC[201~), and fires onData → sendInputToPty.
    // Adding a second listener here caused double-paste on Ctrl+V.
    // The context menu paste path (handlePaste → pasteClipboardIntoPty → term.paste())
    // remains intact for right-click paste.

    // Custom key event handler to allow certain shortcuts to pass through to the app
    term.attachCustomKeyEventHandler((event) => {
      // During IME composition (Chinese/Japanese/Korean input methods, or any
      // input-method software), hand the event straight to xterm's internal
      // CompositionHelper.  Returning `true` means "let xterm process it",
      // and xterm will then check `_compositionHelper.keydown()` which knows
      // how to handle composition key events (keyCode 229, etc.).
      //
      // Without this guard, fast typing during composition or pressing Space
      // to select a candidate can race with the custom-handler logic and
      // cause characters to be swallowed or duplicated.
      //
      // Reference: VS Code terminal does the same early-return.
      if (event.isComposing || event.keyCode === 229) {
        return true;
      }

      // xterm.js invokes this handler for keydown, keypress, AND keyup events.
      // Without this guard, clipboard shortcuts (Ctrl+C copy, Ctrl+V paste, etc.)
      // fire once per event type — causing 2-3× duplicate operations.
      // Only process keydown; let xterm handle keypress/keyup normally.
      if (event.type !== 'keydown') {
        return true;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();

      // ── Suggestion selection ────────────────────────────────────────────
      const hasCandidates = suggestionsRef.current.length > 0;

      // ↑ / ↓ select ONLY while the suggestion box is visible; otherwise they
      // pass through to the shell (command history navigation / remote
      // completion). The box is auto-shown while typing, so this still gives
      // ↑↓ selection in the normal flow.
      if (
        suggestionsVisibleRef.current &&
        hasCandidates &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        cycleSuggestion(event.key === 'ArrowUp' ? -1 : 1);
        return false;
      }

      if (suggestionsVisibleRef.current && hasCandidates) {
        // Enter: apply the suggestion ONLY when the user has explicitly
        // selected one with ↑/↓ (or mouse). With nothing selected, Enter
        // passes through and executes exactly what was typed.
        if (event.key === 'Enter') {
          if (selectedIndexRef.current >= 0) {
            event.preventDefault();
            acceptSelected();
            return false;
          }
          // No selection → execute the typed command; hide the box so the
          // suggestion doesn't linger over the executed line.
          hideSuggestions();
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          // Negative feedback: the user dismissed the popup without taking any
          // suggestion — penalise every candidate currently on screen so they
          // rank lower next time. Mirrors recordSelection's scope semantics.
          if (hasCandidates) {
            for (const cmd of suggestionsRef.current) {
              try {
                recordRejection(cmd, connScope);
                if (cwdScopeRef.current) recordRejection(cmd, cwdScopeRef.current);
              } catch {
                /* suggestion learning must never break the terminal */
              }
            }
          }
          hideSuggestions();
          return false;
        }
      }

      // Tab: ALWAYS pass through to the shell for remote readline completion —
      // never intercepted, never surfaced in the suggestion box. We remember
      // the pre-completion input so the completed command can be captured from
      // the terminal line afterwards and recorded for future suggestions.
      if (event.key === 'Tab') {
        preTabInputRef.current = inputBufferRef.current;
        tabPendingRef.current = true;
        // The remote shell will complete the line — close the suggestion box
        // so its options are not mixed into (or shown alongside) the box.
        hideSuggestions();
        return true;
      }

      // Handle copy shortcut — only when a selection exists; otherwise the
      // event passes through to the shell as the normal SIGINT (Ctrl+C).
      if (modKey && key === 'c' && term.hasSelection()) {
        // Allow copy to happen
        const selection = term.getSelection();
        writeClipboardText(selection).catch(() => {
          console.error('Failed to copy');
        });
        return false;
      }

      // Handle paste shortcut — Ctrl+V / Cmd+V. xterm's own textarea paste
      // handler relies on the browser clipboard API which can be unavailable
      // in the Tauri WebView (CSP / permissions); route through the Tauri
      // clipboard plugin instead so paste always works. term.paste() wraps the
      // text in bracketed-paste mode and fires onData → sendInputToPty.
      if (modKey && key === 'v') {
        event.preventDefault();
        void pasteClipboardIntoPty();
        return false;
      }

      // Handle search shortcut
      if (modKey && key === 'f') {
        event.preventDefault();
        setSearchVisible(true);
        setSearchFocusTrigger(prev => prev + 1);
        return false;
      }
      
      // Handle select all shortcut
      if (modKey && key === 'a') {
        event.preventDefault();
        term.selectAll();
        return false;
      }
      
      // Handle F3 for search navigation
      if (event.key === 'F3') {
        event.preventDefault();
        const search = searchRef.current;
        const { query, caseSensitive, regex } = searchStateRef.current;
        if (search && query) {
          if (event.shiftKey) {
            search.findPrevious(query, { caseSensitive, regex });
          } else {
            search.findNext(query, { caseSensitive, regex });
          }
        } else {
          setSearchVisible(true);
          setSearchFocusTrigger(prev => prev + 1);
        }
        return false;
      }
      
      // Let terminal handle all other keys normally
      return true;
    });

    // WKWebView can swallow the native `mouseup` entirely — it never reaches any
    // JS listener (not xterm's document listener, nor a container-level relay).
    // When that happens xterm.js's SelectionService stays stuck in "drag" mode:
    // its document-level mousemove listener keeps extending the selection even
    // though no button is held, and only ESC (which fires onUserInput →
    // clearSelection) recovers.
    //
    // mouseup-based relays cannot fix this because the event never arrives. But
    // `mousemove` IS still delivered (that's exactly what causes the runaway
    // selection). So we track the drag ourselves and detect the swallowed
    // mouseup on the next mousemove: if the mouse moves with no buttons held
    // (`e.buttons === 0`) while a left-button drag is supposedly active, the
    // mouseup was lost. We then dispatch a synthetic mouseup on the document so
    // xterm's SelectionService._handleMouseUp runs and removes its stuck
    // document-level mousemove/mouseup listeners — without clearing the visible
    // selection (unlike clearSelection()).
    //
    // Capture-phase listeners are used so they run before xterm's own
    // bubble-phase handlers, guaranteeing the stuck listener is removed before
    // it can extend the selection for the current event.
    const selectionDoc = term.element?.ownerDocument;
    let selectionDragInProgress = false;
    const trackSelectionDragStart = (e: MouseEvent) => {
      if (e.button === 0) selectionDragInProgress = true;
    };
    const trackSelectionDragEnd = () => {
      selectionDragInProgress = false;
    };
    const detectStuckSelectionDrag = (e: MouseEvent) => {
      if (selectionDragInProgress && e.buttons === 0 && selectionDoc) {
        selectionDragInProgress = false;
        selectionDoc.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 0,
          clientX: e.clientX,
          clientY: e.clientY,
          detail: e.detail,
        }));
      }
    };
    if (selectionDoc) {
      selectionDoc.addEventListener('mousedown', trackSelectionDragStart, true);
      selectionDoc.addEventListener('mouseup', trackSelectionDragEnd, true);
      selectionDoc.addEventListener('mousemove', detectStuckSelectionDrag, true);
    }

    // Welcome message
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.writeln(`\x1b[1;36m  ${connectionName}\x1b[0m`);
    term.writeln(`\x1b[90m  ${username}@${host}\x1b[0m`);
    term.writeln(`\x1b[90m  Renderer: ${rendererRef.current.toUpperCase()}\x1b[0m`);
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.write('\r\n');
    term.writeln('\x1b[33m🚀 Starting interactive shell (WebSocket + PTY mode)...\x1b[0m');
    term.write('\r\n');

    let isRunning = true;
    // Tracks whether a PTY session has been successfully established in this
    // effect run. Reset to false when we initiate an auto-reconnect after a
    // drop so the reconnect loop can function normally.
    let hasEverConnected = false;
    // Set when a drop triggers auto-reconnect, so the Success message can
    // warn the user that a fresh shell was started.
    let isReconnectAfterDrop = false;

    // Unified auto-reconnect loop (effect-scoped so cleanup can cancel it):
    // exponential backoff, each attempt performs a FULL reconnect through App
    // (onReconnectTab) which rebuilds the backend SSH session and remounts the
    // terminal on success. On failure the component stays mounted and the
    // probe timer schedules the next attempt — retries never stop on their own
    // and the countdown message keeps appearing.
    let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectProbeTimer: ReturnType<typeof setTimeout> | null = null;

    // RAF write batching state — lifted to effect scope so cleanup can cancel.
    let writeBuffer = '';
    let watermark = 0;
    let rafId: number | null = null;
    let creditsGranted = 0;
    
    // CRITICAL: Wait for terminal to have proper dimensions before connecting
    // Hidden terminals (display: none) may have cols=10, rows=5 which breaks PTY.
    // A short wait avoids opening the terminal "slowly"; once the tab is
    // visible the fit addon re-fits and sends Resize anyway.
    const waitForProperSize = () => {
      return new Promise<void>((resolve) => {
        const MAX_WAIT_MS = 2_000; // give up quickly, re-fit on visibility
        const startTime = Date.now();

        const checkSize = () => {
          if (!isRunning) return;

          // Refit to get latest dimensions
          fitAddon.fit();

          // Consider terminal properly sized if it has reasonable dimensions
          if (term.cols >= 40 && term.rows >= 10) {
            console.log(`[PTY Terminal] [${connectionId}] Terminal properly sized: ${term.cols}x${term.rows}`);
            resolve();
          } else if (Date.now() - startTime > MAX_WAIT_MS) {
            // Tab is likely hidden (display: none). Proceed with fallback size;
            // the terminal will re-fit and send Resize when it becomes visible.
            console.log(`[PTY Terminal] [${connectionId}] Size wait timed out (${term.cols}x${term.rows}), proceeding with fallback`);
            resolve();
          } else {
            // Terminal still too small (probably hidden), retry after 100ms
            setTimeout(checkSize, 100);
          }
        };

        // Start checking after a brief delay
        setTimeout(checkSize, 50);
      });
    };

    // Connect to WebSocket server
    const connectWebSocket = async () => {
      // CRITICAL: Wait for terminal to be properly sized before starting PTY
      await waitForProperSize();
      // The await above may have raced with cleanup (component unmounted or
      // effect re-run) — bail out instead of creating an orphan WebSocket.
      if (!isRunning) return;

      // Notify parent that we're connecting
      if (connectionStatusRef.current !== 'connecting') {
        connectionStatusRef.current = 'connecting';
        onConnectionStatusChange?.(connectionId, 'connecting');
      }

      // Get the dynamically assigned WebSocket port from the backend
      let wsPort = 9001; // fallback default
      try {
        wsPort = await invoke<number>('get_websocket_port');
        console.log(`[PTY Terminal] [${connectionId}] WebSocket port: ${wsPort}`);
      } catch (e) {
        console.warn(`[PTY Terminal] [${connectionId}] Failed to get WebSocket port, using default:`, e);
      }
      // Re-check after the invoke await — cleanup may have run while waiting.
      if (!isRunning) return;

      console.log(`[PTY Terminal] [${connectionId}] Connecting to WebSocket...`);
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      // Receive PTY output as ArrayBuffer so we can avoid the JSON overhead of
      // encoding Vec<u8> as integer arrays.  The backend sends binary output
      // frames with the format: [0x01][id_len: u16 BE][connection_id][payload]
      ws.binaryType = 'arraybuffer';
      // One streaming TextDecoder per WebSocket connection: preserves UTF-8
      // multi-byte sequences that may be split across successive output frames.
      const outputDecoder = new TextDecoder(terminalEncoding);
      // If cleanup completed while the WebSocket constructor was pending,
      // close it right away — onopen would otherwise send StartPty and leak a
      // backend PTY session nobody will ever close.
      if (!isRunning) {
        ws.onopen = null;
        ws.close();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        console.log(`[PTY Terminal] [${connectionId}] WebSocket connected`);
        term.writeln('\x1b[32m✓ WebSocket connected\x1b[0m');
        
        // Start PTY session
        const startMsg = {
          type: 'StartPty',
          connection_id: connectionId,
          cols: term.cols,
          rows: term.rows,
          default_directory: defaultDirectory?.trim() || null,
        };
        console.log(`[PTY Terminal] [${connectionId}] Starting PTY connection with ${term.cols}x${term.rows}`);
        ws.send(JSON.stringify(startMsg));
      };

      // =========================================================================
      // RAF-Based Write Batching + Watermark Flow Control
      //
      // Based on xterm.js best practices:
      // - http://xtermjs.org/docs/guides/flowcontrol/
      // - https://github.com/github/copilot-cli/issues/1805 (4-layer solution)
      //
      // Problem: calling term.write() for every WebSocket frame creates hundreds
      // of write operations per second, each with its own callback. This
      // overwhelms xterm's internal write buffer (hardcoded 50 MB limit) and
      // creates massive GC pressure from per-chunk closures.
      //
      // Solution:
      // 1. Accumulate all incoming frames in a string buffer.
      // 2. Flush once per requestAnimationFrame (~60 writes/s instead of 100+).
      // 3. Use watermark-based flow control: send Resume credits only when the
      //    pending byte count drops below LOW_WATER, avoiding per-frame ACKs.
      // =========================================================================

      /** High watermark (bytes): above this, the buffer is considered "full" and
       *  we stop granting credits until xterm drains below LOW_WATER.  128 KB
       *  keeps the emulator snappy for keystrokes under fast input (xterm guide
       *  recommends ≤ 500 KB for responsiveness). */
      const HIGH_WATER = 128 * 1024;
      /** Low watermark (bytes): below this, we grant a batch of credits to the
       *  backend so it can send more data. */
      const LOW_WATER = 16 * 1024;
      /** How many credits to grant each time watermark drops below LOW_WATER.
       *  Keeps the pipeline flowing without flooding the WS receive queue. */
      const CREDIT_BATCH = 4;

      const grantCredits = (count: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Send a single Resume per credit (backend Semaphore.add_permits(1))
          const msg = JSON.stringify({ type: 'Resume', connection_id: connectionId });
          for (let i = 0; i < count; i++) {
            ws.send(msg);
          }
          creditsGranted += count;
        }
      };

      const flushWriteBuffer = () => {
        rafId = null;
        if (!writeBuffer) return;

        const data = writeBuffer;
        writeBuffer = '';

        // Enforce per-session memory cap so xterm's scrollback buffer can't
        // grow without bound on sustained high-throughput output (e.g. `yes`).
        sessionOutputRef.current += data.length;
        if (sessionOutputRef.current >= SESSION_OUTPUT_LIMIT_BYTES) {
          term.reset();
          term.clear();
          sessionOutputRef.current = 0;
          term.writeln('\x1b[33m[Output limit reached \u2014 scrollback cleared to free memory]\x1b[0m');
        }

        // Single write per animation frame — the key optimisation.
        // Reduces term.write() calls from hundreds/s to ~60/s.
        term.write(data, () => {
          // xterm finished processing this batch — the buffer/cursor are now
          // final, so re-glue the suggestion box to the cursor.
          if (suggestionsVisibleRef.current) {
            refreshSuggestionPosition();
          }
          // xterm finished processing this batch — update watermark
          watermark = Math.max(watermark - data.length, 0);

          // Watermark-based flow control: grant credits only when the
          // pending buffer has drained below LOW_WATER.  Skip granting
          // if watermark is still above HIGH_WATER (buffer still full).
          if (watermark < LOW_WATER && watermark < HIGH_WATER && creditsGranted < CREDIT_BATCH * 2) {
            grantCredits(CREDIT_BATCH);
            creditsGranted = 0; // reset counter after granting
          }
        });

        // If more data arrived during the write, schedule another flush
        if (writeBuffer) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };

      const enqueueOutput = (text: string) => {
        writeBuffer += text;
        watermark += text.length;
        if (rafId === null) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };

      // Reused for decoding the connection-id prefix of every binary frame —
      // never with stream:true (that decoder is `outputDecoder` below).
      const idDecoder = new TextDecoder();

      ws.onmessage = (event) => {
        // Binary frames carry raw PTY output.
        // Format: [0x01][id_len: u16 BE][connection_id bytes][payload bytes]
        if (event.data instanceof ArrayBuffer) {
          const data = new Uint8Array(event.data);
          if (data.length < 3 || data[0] !== 0x01) return;
          const idLen = (data[1] << 8) | data[2];
          const payloadOffset = 3 + idLen;
          if (data.length < payloadOffset) return;
          const frameConnectionId = idDecoder.decode(data.subarray(3, payloadOffset));
          if (frameConnectionId !== connectionId) return;
          const payload = data.subarray(payloadOffset);
          if (payload.length === 0) return;
          enqueueOutput(outputDecoder.decode(payload, { stream: true }));
          return;
        }

        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'Success':
              console.log(`[PTY Terminal] [${connectionId}]`, msg.message);
              if (msg.message.includes('PTY connection started')) {
                reconnectAttemptsRef.current = 0;
                autoReconnectAfterDropRef.current = 0; // Reset drop-reconnect counter on success
                if (hasEverConnected || isReconnectAfterDrop) {
                  // Reconnected after a drop — warn that a fresh shell was started
                  term.writeln('\x1b[33m⚠ Previous session lost. New shell session started.\x1b[0m');
                } else {
                  term.writeln('\x1b[32m✓ PTY connection started\x1b[0m');
                  term.writeln('\x1b[90mYou can now use interactive commands: vim, less, more, top, etc.\x1b[0m');
                }
                hasEverConnected = true;
                isReconnectAfterDrop = false;
                term.write('\r\n');
                if (connectionStatusRef.current !== 'connected') {
                  connectionStatusRef.current = 'connected';
                  onConnectionStatusChange?.(connectionId, 'connected');
                }
              }
              break;
            
            case 'PtyStarted': {
              if (msg.connection_id === connectionId && typeof msg.generation === 'number') {
                ptyGenerationRef.current = msg.generation;
                console.log(`[PTY Terminal] [${connectionId}] PTY generation: ${msg.generation}`);
                signalReady(connectionId);
                // Credit-based flow control: seed the pipeline with initial
                // credits so the PTY reader can start sending immediately.
                // Ongoing credits are managed by the watermark-based flow
                // control in the flush callback above.
                const INITIAL_WINDOW = 2;
                grantCredits(INITIAL_WINDOW);
              }
              break;
            }
              
            case 'Output':
              if (msg.data && msg.data.length > 0) {
                enqueueOutput(idDecoder.decode(new Uint8Array(msg.data)));
              }
              break;
              
            case 'Error': {
              console.error('[PTY Terminal] Error:', msg.message);
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              const errorMsgLower = msg.message.toLowerCase();
              // A missing backend session is NOT permanent: the unified
              // auto-reconnect loop rebuilds the session via App on the next
              // attempt. We only mark the tab disconnected so the loop's
              // "connecting" status transition is visible.
              if (errorMsgLower.includes('session not found') || 
                  errorMsgLower.includes('ssh') || 
                  errorMsgLower.includes('connection') ||
                  errorMsgLower.includes('disconnected') ||
                  errorMsgLower.includes('closed') ||
                  errorMsgLower.includes('lost') ||
                  errorMsgLower.includes('pty')) {
                if (connectionStatusRef.current !== 'disconnected') {
                  connectionStatusRef.current = 'disconnected';
                  onConnectionStatusChange?.(connectionId, 'disconnected');
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.close();
                }
              }
              break;
            }
              
            default:
              console.log('[PTY Terminal] Unknown message type:', msg.type);
          }
        } catch (e) {
          console.error('[PTY Terminal] Failed to parse message:', e);
        }
      };

      ws.onerror = (error) => {
        console.error('[PTY Terminal] WebSocket error:', error);
        term.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
        // Report disconnected status on WebSocket error
        if (connectionStatusRef.current !== 'disconnected') {
          connectionStatusRef.current = 'disconnected';
          onConnectionStatusChange?.(connectionId, 'disconnected');
        }
      };

      // ── Unified auto-reconnect ──────────────────────────────────────────
      // Any WS drop (first-connect failure OR session loss after a successful
      // connection) enters one backoff loop. Every attempt goes through the
      // App-level full reconnect (onReconnectTab), which rebuilds the backend
      // SSH session and remounts this terminal on success; on failure the
      // component stays mounted, the probe timer notices and the loop
      // continues with the next (longer) delay — retries never silently stop.
      const scheduleAutoReconnect = () => {
        if (autoReconnectTimer) {
          clearTimeout(autoReconnectTimer);
          autoReconnectTimer = null;
        }
        const attempt = autoReconnectAfterDropRef.current;
        // No hard stop: keep retrying with a capped backoff so a recovering
        // network is picked up automatically. The attempt counter is only
        // informational in the countdown message.
        const delay = Math.min(2000 * Math.pow(2, Math.min(attempt, 5)), 30000);
        autoReconnectAfterDropRef.current = attempt + 1;

        if (connectionStatusRef.current !== 'connecting') {
          connectionStatusRef.current = 'connecting';
          onConnectionStatusChange?.(connectionId, 'connecting');
        }
        term.write(`\r\n\x1b[33m[Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})...]\x1b[0m\r\n`);

        autoReconnectTimer = setTimeout(() => {
          autoReconnectTimer = null;
          if (!isRunning) return;
          // Full reconnect: rebuild the backend session via App.
          isReconnectAfterDrop = true;
          hasEverConnected = false;
          reconnectAttemptsRef.current = 0;
          void onReconnectTab?.(connectionId);
          // If the reconnect succeeded, App remounts this terminal (cleanup
          // sets isRunning=false) and this probe is cancelled by cleanup.
          // If it failed, the component is still mounted → schedule next.
          reconnectProbeTimer = setTimeout(() => {
            reconnectProbeTimer = null;
            if (isRunning) {
              scheduleAutoReconnect();
            }
          }, RECONNECT_PROBE_MS);
        }, delay);
      };

      ws.onclose = () => {
        console.log('[PTY Terminal] WebSocket closed');
        if (isRunning) {
          scheduleAutoReconnect();
        }
      };
    };

    connectWebSocket();

    // Handle user input
    const inputDisposable = term.onData((data: string) => {
      // G3 paste gate: xterm wraps pasted text in bracketed-paste markers
      // (\x1b[200~ … \x1b[201~) when the shell enabled that mode. While the
      // markers are present the text is not interactive typing — trackInput
      // and schedule both short-circuit, but sendInputToPty is unaffected.
      // The end marker is cleared AFTER tracking so the marker chunk itself
      // (whose \x1b would otherwise reset the tracked buffer) is skipped too.
      if (isPasteStart(data)) pastingRef.current = true;
      trackInputForSuggestion(data);
      sendInputToPty(data);
      if (isPasteEnd(data)) pastingRef.current = false;
    });

    // Handle terminal resize — deduplicate to avoid flooding the PTY with
    // identical resize signals when the layout is settling (e.g. after closing
    // an adjacent terminal group). Each redundant SIGWINCH causes the remote
    // shell to redraw its prompt, producing the repeated "root@host:~#" lines.
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      checkScrollability(); // row count changed — re-evaluate scrollability

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const resizeMsg = {
          type: 'Resize',
          connection_id: connectionId,
          cols,
          rows,
        };
        ws.send(JSON.stringify(resizeMsg));
        console.log(`[PTY Terminal] Terminal resized to ${cols}x${rows}`);
      }
    });

    // Debounced fit: coalesce rapid resize events into a single fit + PTY resize message.
    // After fitting, schedule a follow-up fit to catch CSS transitions that may still
    // be settling. This ensures the terminal gets the final correct dimensions.
    // Note: duplicate resize messages are already filtered in the onResize handler above,
    // so even if fitAddon.fit() fires multiple times, only actual size changes reach the PTY.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFit = () => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        const container = containerRef.current;
        if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
          fitAddon.fit();
          // Schedule a follow-up fit after layout fully settles (CSS transitions)
          fitTimer = setTimeout(() => {
            fitTimer = null;
            if (containerRef.current && containerRef.current.offsetWidth > 0) {
              fitAddon.fit();
            }
          }, 300);
        }
      }, 150);
    };

    // Handle window resize
    const handleWindowResize = () => {
      debouncedFit();
    };
    window.addEventListener('resize', handleWindowResize);

    // Handle tab visibility changes using ResizeObserver
    // When tab becomes visible again or panel is resized, fit the terminal
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Only refit if the container has a reasonable size
        if (entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          debouncedFit();
        }
      }
    });
    
    // Observe the outer container for more reliable resize detection during panel splits
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    // Cleanup
    return () => {
      console.log(`[PTY Terminal] [${connectionId}] Cleaning up`);
      isRunning = false;
      if (autoReconnectTimer) {
        clearTimeout(autoReconnectTimer);
        autoReconnectTimer = null;
      }
      if (reconnectProbeTimer) {
        clearTimeout(reconnectProbeTimer);
        reconnectProbeTimer = null;
      }

      // Cancel any pending RAF write batch and discard queued data so no
      // stale writes reach a terminal that is about to be disposed.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      writeBuffer = '';
      watermark = 0;

      // Close PTY connection via WebSocket — include generation so the
      // backend can ignore this close if a newer session already exists.
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const closeMsg: Record<string, unknown> = {
          type: 'Close',
          connection_id: connectionId,
        };
        if (ptyGenerationRef.current !== null) {
          closeMsg.generation = ptyGenerationRef.current;
        }
        ws.send(JSON.stringify(closeMsg));
      }
      // Close the socket itself in every state (OPEN and CONNECTING): a
      // still-connecting socket would otherwise finish its handshake after
      // unmount and stay open until the app quits. ws.close() on a
      // CONNECTING socket aborts the connection.
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      ptyGenerationRef.current = null;

      // CRITICAL: Null out WebSocket handlers to break closure reference chains.
      // The onmessage/onclose/onerror handlers capture `term`, `outputDecoder`,
      // and `enqueueOutput` via closures. Without nulling them out, V8 cannot GC
      // these objects even after term.dispose(), causing ~1 GB of retained heap.
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onopen = null;
      }
      wsRef.current = null;
      
      inputDisposable.dispose();
      resizeDisposable.dispose();
      lineFeedDisposable.dispose();
      bufferChangeDisposable.dispose();
      scrollDisposable.dispose();
      workingDirectoryDisposable.dispose();
      if (suggestionGateTextarea) {
        suggestionGateTextarea.removeEventListener('compositionstart', onSuggestionImeStart);
        suggestionGateTextarea.removeEventListener('compositionend', onSuggestionImeEnd);
        suggestionGateTextarea.removeEventListener('blur', onSuggestionBlur);
      }
      window.removeEventListener('resize', handleWindowResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', recoverFromOcclusion);
      recoverRendererRef.current = null;
      resizeObserver.disconnect();
      if (selectionDoc) {
        selectionDoc.removeEventListener('mousedown', trackSelectionDragStart, true);
        selectionDoc.removeEventListener('mouseup', trackSelectionDragEnd, true);
        selectionDoc.removeEventListener('mousemove', detectStuckSelectionDrag, true);
      }
      if (fitTimer) clearTimeout(fitTimer);
      
      // Dispose WebGL addon FIRST so GPU textures are released before the
      // terminal canvas is removed from the DOM.
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        webglAddonRef.current = null;
      }
      if (clipboardAddonRef.current) {
        try { clipboardAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        clipboardAddonRef.current = null;
      }
      term.reset(); // clear scrollback + viewport so GC can reclaim xterm buffers sooner
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, host, username, terminalKey, reconnectKey, sendInputToPty, onWorkingDirectoryChange]);
  // NOTE: themeKey, appearanceKey, and connectionName are intentionally NOT
  // in the deps above. Including them would tear down the WebSocket + PTY
  // session on every theme change (e.g. macOS auto Dark/Light switch), killing
  // any running remote processes. Including connectionName would do the same
  // when the user renames the connection via edit dialog — the tab title
  // already updates via UPDATE_TAB_NAME without reconnecting.

  // Update terminal colors and font in-place when theme or appearance changes.
  React.useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const currentAppearance = loadAppearanceSettings();
    const opts = getThemeAwareTerminalOptions(currentAppearance);
    term.options.theme = opts.theme;
    term.options.fontSize = opts.fontSize;
    term.options.fontFamily = opts.fontFamily;
    term.options.cursorStyle = opts.cursorStyle;
    term.options.cursorBlink = opts.cursorBlink;
    term.options.scrollback = opts.scrollback;
    // Refit so any font-size change propagates as a PTY resize.
    fitRef.current?.fit();
    // WKWebView's WebGL renderer can retain the previous theme in its glyph
    // atlas. Clear the atlas and explicitly refresh visible rows so switching
    // the app between light/dark repaints immediately instead of leaving a
    // dark terminal inside a light window (or vice versa).
    // Test doubles may omit this renderer-specific API.
    if (typeof term.clearTextureAtlas === "function") {
      term.clearTextureAtlas();
    }
    term.refresh(0, Math.max(0, term.rows - 1));
  }, [themeKey, appearanceKey]);

  React.useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      return;
    }

    if (wasActiveRef.current) {
      return;
    }

    wasActiveRef.current = true;

    const frameId = window.requestAnimationFrame(() => {
      const term = xtermRef.current;
      const fitAddon = fitRef.current;
      const container = containerRef.current;
      if (!term || !fitAddon || !container) return;
      if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

      fitAddon.fit();
      // A hidden tab (display:none) can lose its WebGL context without
      // webglcontextlost ever firing in WKWebView — a plain refresh() would
      // draw into the dead context and the tab would come back garbled
      // (花屏). The recovery routine rebuilds the renderer if needed before
      // repainting (it also refreshes all rows).
      recoverRendererRef.current?.();
      term.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isActive]);

  // Context menu handlers
  const handleCopy = React.useCallback(() => {
    const term = xtermRef.current;
    if (term?.hasSelection()) {
      const selection = term.getSelection();
      writeClipboardText(selection).then(() => {
        toast.success(t('ptyTerminal.copiedToClipboard'));
      }).catch(() => {
        toast.error(t('ptyTerminal.failedToCopyClipboard'));
      });
    }
  }, [t]);

  const handlePaste = React.useCallback(async () => {
    await pasteClipboardIntoPty();
  }, [pasteClipboardIntoPty]);

  const handleClear = React.useCallback(() => {
    xtermRef.current?.clear();
    setHasScrollableContent(false);
  }, []);

  const handleClearScrollback = React.useCallback(() => {
    const term = xtermRef.current;
    if (term) {
      term.clear();
      // Note: clearScrollback method doesn't exist in newer xterm versions
      // clear() already clears both viewport and scrollback
      setHasScrollableContent(false);
    }
  }, []);

  const handleSearch = React.useCallback(() => {
    setSearchVisible(true);
    setSearchFocusTrigger(prev => prev + 1);
  }, []);

  const handleFindNext = React.useCallback(() => {
    const search = searchRef.current;
    const { query, caseSensitive, regex } = searchStateRef.current;
    if (search && query) {
      search.findNext(query, { caseSensitive, regex });
    } else {
      handleSearch();
    }
  }, [handleSearch]);

  const handleFindPrevious = React.useCallback(() => {
    const search = searchRef.current;
    const { query, caseSensitive, regex } = searchStateRef.current;
    if (search && query) {
      search.findPrevious(query, { caseSensitive, regex });
    } else {
      handleSearch();
    }
  }, [handleSearch]);

  const handleSelectAll = React.useCallback(() => {
    xtermRef.current?.selectAll();
  }, []);

  const handleSearchStateChange = React.useCallback((state: TerminalSearchState) => {
    searchStateRef.current = state;
  }, []);

  React.useEffect(() => {
    const handleTerminalCommand = (event: Event) => {
      const { tabId, command } = (event as CustomEvent<TerminalCommandDetail>).detail;
      if (tabId !== connectionId) return;

      switch (command) {
        case 'copy': handleCopy(); break;
        case 'paste': void handlePaste(); break;
        case 'select-all': handleSelectAll(); break;
        case 'find': handleSearch(); break;
        case 'find-next': handleFindNext(); break;
        case 'find-previous': handleFindPrevious(); break;
        case 'clear-screen': handleClear(); break;
      }
    };

    window.addEventListener(TERMINAL_COMMAND_EVENT, handleTerminalCommand);
    return () => window.removeEventListener(TERMINAL_COMMAND_EVENT, handleTerminalCommand);
  }, [connectionId, handleClear, handleCopy, handleFindNext, handleFindPrevious, handlePaste, handleSearch, handleSelectAll]);

  const handleReconnect = React.useCallback(() => {
    if (onReconnectTab) {
      // Delegate to App.tsx which re-establishes the SSH session before
      // remounting this component via the RECONNECT_TAB reducer action.
      void onReconnectTab(connectionId);
    } else {
      // Fallback: reconnect only the WebSocket/PTY loop (no SSH re-auth).
      toast.info(t('ptyTerminal.reconnectingTerminal'));
      reconnectAttemptsRef.current = 0;
      connectionStatusRef.current = 'connecting';
      onConnectionStatusChange?.(connectionId, 'connecting');
      setReconnectKey((k) => k + 1);
    }
  }, [connectionId, onConnectionStatusChange, onReconnectTab]);

  const handleSaveToFile = React.useCallback(async () => {
    const term = xtermRef.current;
    if (!term) return;

    try {
      // Get all buffer content
      const buffer = term.buffer.active;
      let content = '';
      
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) {
          content += line.translateToString(true) + '\n';
        }
      }

      // Create blob and download
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terminal-output-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success(t('ptyTerminal.outputSaved'));
    } catch (error) {
      toast.error(t('ptyTerminal.failedToSaveOutput'));
      console.error('Save error:', error);
    }
  }, []);

  const handleSaveSelectionToNotes = React.useCallback(() => {
    const content = xtermRef.current?.getSelection().trim();
    if (!content) return;
    const now = Date.now();
    NotesStorage.upsert({
      id: generateId('note'),
      title: content.split('\n')[0].slice(0, 80) || t('toolbox.notes.untitled'),
      language: 'shell',
      content,
      createdAt: now,
      updatedAt: now,
    });
    toast.success(t('ptyTerminal.selectionSavedToNotes'));
  }, [t]);

  React.useEffect(() => {
    const pasteSavedShellCommand = (event: Event) => {
      if (!isActive) return;
      const detail = (event as CustomEvent<{ content?: string; handled?: boolean }>).detail;
      if (!detail?.content || !xtermRef.current) return;
      xtermRef.current.paste(detail.content);
      detail.handled = true;
    };
    window.addEventListener('nexterm:paste-shell-note', pasteSavedShellCommand);
    return () => window.removeEventListener('nexterm:paste-shell-note', pasteSavedShellCommand);
  }, [isActive]);

  return (
    <TerminalContextMenu
      onCopy={handleCopy}
      onPaste={handlePaste}
      onClear={handleClear}
      onClearScrollback={handleClearScrollback}
      onSearch={handleSearch}
      onFindNext={handleFindNext}
      onFindPrevious={handleFindPrevious}
      onSelectAll={handleSelectAll}
      onSaveToFile={handleSaveToFile}
      onSaveSelectionToNotes={handleSaveSelectionToNotes}
      onReconnect={handleReconnect}
      hasSelection={hasSelection}
      searchActive={searchVisible}
    >
    <div 
      ref={containerRef}
      className={`relative h-full w-full pty-terminal-container pty-term-${scopeId} overflow-hidden`}
      onClick={(e) => {
        // Don't refocus terminal if clicking on search bar or other interactive
        // elements. The suggestion bar candidates handle their own clicks
        // (accept), so a click inside the bar must not steal focus or dismiss.
        const target = e.target as HTMLElement;
        if (target.closest('[data-search-bar]')) {
          return;
        }
        if (target.closest('[data-suggestion-bar]')) {
          return;
        }
        // Clicking the terminal body leaves the suggestion interaction —
        // dismiss the popup and refocus the terminal.
        hideSuggestions();
        xtermRef.current?.focus();
      }}
      style={{
        opacity: appearance.allowTransparency ? appearance.opacity / 100 : 1,
        // Use the theme-aware resolved background so the container matches the
        // xterm theme exactly. The raw terminalThemes[appearance.theme] lookup
        // skips light-mode auto-switching, which left a mismatched dark strip at
        // the bottom of a light terminal (and vice versa).
        backgroundColor: getThemeAwareTerminalTheme(appearance).background || (terminalThemes[appearance.theme] || defaultTerminalTheme).background || '#1e1e1e',
      }}
    >
      {/* Background image layer */}
      {appearance.backgroundImage && (
        <div 
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${appearance.backgroundImage})`,
            backgroundSize: appearance.backgroundImagePosition === 'tile' ? 'auto' : appearance.backgroundImagePosition,
            backgroundPosition: 'center',
            backgroundRepeat: appearance.backgroundImagePosition === 'tile' ? 'repeat' : 'no-repeat',
            opacity: appearance.backgroundImageOpacity / 100,
            filter: appearance.backgroundImageBlur > 0 ? `blur(${appearance.backgroundImageBlur}px)` : 'none',
            zIndex: 0,
          }}
        />
      )}
      
      {/* Search bar */}
      {searchRef.current && (
        <TerminalSearchBar
          searchAddon={searchRef.current}
          visible={searchVisible}
          focusTrigger={searchFocusTrigger}
          onClose={() => setSearchVisible(false)}
          onSearchStateChange={handleSearchStateChange}
        />
      )}

      {/* Command suggestion bar — fixed near the cursor */}
      {suggestionsVisible && suggestions.length > 0 && (
        <div
          ref={suggestionBarRef}
          data-suggestion-bar
          className="absolute z-30 flex flex-col rounded-lg border border-border/60 bg-popover shadow-xl backdrop-blur p-1.5 max-w-[340px]"
          style={{ left: suggestionPos.left, top: suggestionPos.top }}
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground mb-0.5 shrink-0">
              {t('ptyTerminal.suggestions')} <kbd className="rounded border border-border bg-muted px-1">↑↓</kbd> {t('ptyTerminal.select')} · <kbd className="rounded border border-border bg-muted px-1">Enter</kbd> {t('ptyTerminal.useOrRun')} · <kbd className="rounded border border-border bg-muted px-1">Esc</kbd> {t('ptyTerminal.close')}
            </span>
            {suggestions.slice(0, 6).map((cmd, index) => (
              <button
                key={cmd}
                type="button"
                onClick={() => acceptSuggestion(cmd)}
                // Keep focus on the terminal: mousedown on a <button> would
                // move focus away from the hidden textarea, firing the G4
                // blur gate which dismisses the popup before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                // Hover is ONLY a preview: it never writes selectedIndexRef,
                // so Enter (which keys off selectedIndex) can never be hijacked
                // by a mouse pass-over. Leave resets the preview.
                onMouseEnter={() => setHoverIndex(index)}
                onMouseLeave={() => setHoverIndex(-1)}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1 text-left text-[11px] font-mono transition-colors shrink-0',
                  index === selectedIndex
                    ? 'bg-primary text-primary-foreground'
                    : index === hoverIndex
                      ? 'bg-accent/50 text-foreground ring-1 ring-primary/60'
                      : 'text-foreground hover:bg-accent',
                )}
              >
                <span className="w-3 shrink-0 text-[9px] opacity-70">{index + 1}</span>
                <span className="truncate">{cmd}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      
      {/* Terminal wrapper — inset-0 fills the entire container so the terminal
           occupies all available space. The container background matches the
           terminal theme so any partial-row gap at the bottom is invisible. */}
      <div className="absolute inset-0 z-10">
        <div ref={terminalRef} className="h-full w-full" />
      </div>
      <style>{`
        /* Scrollbar appearance — scoped to this terminal instance */
        .pty-term-${scopeId} .xterm-viewport {
          scrollbar-color: rgba(148, 163, 184, 0.55) transparent;
          scrollbar-width: ${hasScrollableContent ? 'thin' : 'none'};
          scrollbar-gutter: ${hasScrollableContent ? 'stable' : 'auto'};
          overflow-y: ${hasScrollableContent ? 'auto' : 'hidden'};
        }
        ${hasScrollableContent ? `
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar-thumb {
          background-color: rgba(148, 163, 184, 0.55);
          border: 2px solid transparent;
          border-radius: 999px;
          background-clip: content-box;
          min-height: 40px;
        }
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar-thumb:hover {
          background-color: rgba(148, 163, 184, 0.75);
        }
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar-track {
          background: transparent;
          border-radius: 999px;
          margin: 4px 0;
        }` : ''}
        /* Make xterm background transparent when background image is set */
        ${appearance.backgroundImage ? `
        .pty-term-${scopeId} .xterm {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-viewport {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-screen {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-rows {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} canvas {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-helper-textarea {
          background-color: transparent !important;
        }
        ` : ''}
      `}</style>
    </div>
    </TerminalContextMenu>
  );
}
