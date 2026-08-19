/**
 * Sensitive-command filter.
 *
 * Commands that clearly carry credentials are never persisted by the
 * learning store. The policy is deliberately conservative: when in doubt, do
 * not learn. Detection is substring/token based — no LLM, no heuristics on
 * command semantics beyond the obvious.
 */

// Contains-match (no word boundaries): variable-style names like
// AWS_SECRET_ACCESS_KEY or GITHUB_TOKEN are underscore-joined, so \b would
// miss them. Conservative by design — when in doubt, do not learn.
const SENSITIVE_TOKEN_RE =
  /(password|passwd|token|secret|api[_-]?key|auth[_-]?token|access[_-]?key|private[_-]?key|authorization|credential)/i;

/** Flag-like options that strongly indicate secrets on the command line. */
const SENSITIVE_FLAGS = [
  '--password',
  '--passwd',
  '--token',
  '--secret',
  '--api-key',
  '--auth-token',
  '--access-key',
  '--private-key',
];

/**
 * Commands where a short `-p`/`-P` flag conventionally carries a password.
 * `-p` is far too common elsewhere (ssh -p port, mkdir -p, scp -P) to block
 * globally — only these commands are treated as sensitive when -p/-P appears.
 */
const SENSITIVE_PWD_COMMANDS = [
  'mysql',
  'psql',
  'sshpass',
  'openssl',
  'pg_dump',
  'pg_restore',
  'mysqldump',
  'sqlplus',
  'redis-cli',
  'mongo',
  'mongosh',
  'sqlcmd',
];

/**
 * True when the command line should NOT be recorded.
 *
 * Examples that are rejected:
 *   curl -H "Authorization: Bearer xxxxx"
 *   mysql -u root -p s3cr3t
 *   sshpass -p 'p@ss'
 *   export AWS_SECRET_ACCESS_KEY=...
 *
 * Plain `passwd` / `kubectl create secret ...` are also rejected because the
 * command text may embed the new secret.
 */
export function isSensitiveCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SENSITIVE_TOKEN_RE.test(trimmed)) return true;
  if (SENSITIVE_FLAGS.some((flag) => trimmed.includes(flag))) return true;
  // `mysql -u root -p s3cr3t` / `sshpass -p 'p@ss'` — only for commands
  // whose -p/-P flag conventionally carries a password.
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (SENSITIVE_PWD_COMMANDS.includes(first)) {
    if (/\s-[pP](\s|\S)/.test(trimmed)) return true;
  }
  return false;
}
