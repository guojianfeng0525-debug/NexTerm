/**
 * Suggestion engine — pure, offline, zero-IO candidate generation, ranking
 * and "自动安静" (auto-quiet) decision logic.
 *
 * The engine never touches the terminal, the network or storage; the UI feeds
 * it the current input plus the pre-fetched per-scope stats and gets back a
 * ranked, filtered candidate list and a display mode.
 */
import { SuggestionMode, ScoredCandidate, SuggestionResult, WEIGHTS, type CommandStat } from './types';

interface RankInput {
  input: string;
  stats: CommandStat[];
  now: number;
  connectionScope?: string | null;
  cwdScopeKey?: string | null;
  /** Static curated options (e.g. per-command flags) — always eligible. */
  curated?: string[];
}

/** Recency weight in [0,1]. */
function decay(lastUsed: number, now: number): number {
  if (lastUsed <= 0) return 0.2;
  const age = Math.max(0, now - lastUsed);
  return Math.pow(2, -age / WEIGHTS.halfLifeMs);
}

/** How strongly the input matches this command (0-100). */
function matchScore(command: string, input: string, lastToken: string): number {
  const cmd = command.trim();
  const inputTrim = input.trim();
  if (!inputTrim) return 0;
  if (cmd === inputTrim) return 0; // selecting the typed text itself is useless
  if (cmd.startsWith(inputTrim)) return 100;

  // Token-level match on the last token (subcommand / argument position).
  if (lastToken) {
    const tokens = cmd.split(/\s+/);
    const first = tokens[0] ?? '';
    if (first === inputTrim.split(/\s+/)[0] && first) {
      for (const tok of tokens.slice(1)) {
        if (tok.startsWith(lastToken)) return 85;
      }
    }
    if (first.startsWith(inputTrim)) return 70;
    if (tokens.some((tok) => tok.includes(lastToken) && tok !== lastToken)) return 40;
  }
  return 0;
}

/**
 * Rank the stats and decide whether/how to display.
 *
 * Auto-quiet: nothing is shown unless the top candidate clears the minimum
 * score; a huge gap between top-1 and top-2 still shows a popup (Ghost Text
 * is deferred to a later phase), but we never pad with low-quality entries.
 */
export function rankSuggestions(input: string, stats: CommandStat[], opts: Partial<RankInput> = {}): SuggestionResult {
  const now = opts.now ?? Date.now();
  const lastToken = input.trim().split(/\s+/).pop() ?? '';
  const firstToken = input.trim().split(/\s+/)[0] ?? '';
  const scored: ScoredCandidate[] = [];

  /** Best evidence for a command across all provided scopes. */
  const bestEvidence = (command: string): { use: number; last: number; sel: number; rej: number } => {
    let use = 0;
    let last = 0;
    let sel = 0;
    let rej = 0;
    for (const stat of stats) {
      if (stat.command !== command) continue;
      use = Math.max(use, stat.use_count);
      last = Math.max(last, stat.last_used);
      sel = Math.max(sel, stat.selection_count);
      rej = Math.max(rej, stat.rejection_count);
    }
    return { use, last, sel, rej };
  };

  const seen = new Set<string>();
  const consider = (command: string, isCurated: boolean) => {
    if (seen.has(command)) return;
    if (command === input.trim()) return;
    if (command.trim().length < 2) return;
    seen.add(command);
    const m = matchScore(command, input, lastToken);
    if (m <= 0) return;

    const ev = bestEvidence(command);

    // Curated static options only ride along when the user already has real
    // usage evidence for this command family — never invent suggestions from
    // static lists alone, and never show zero-usage entries.
    if (isCurated) {
      const hasContext = stats.some((st) => {
        const first = st.command.split(/\s+/)[0] ?? '';
        return first === firstToken || st.command.startsWith(firstToken);
      });
      if (!hasContext) return;
      const score = m * 0.25; // static options never dominate real usage
      if (score >= WEIGHTS.minScoreToShow) scored.push({ command, score, exact: m >= 100 });
      return;
    }

    if (ev.use < WEIGHTS.minUsesToSuggest) return;
    const freq = Math.log1p(ev.use) * decay(ev.last, now);
    const boost = scopeBoostForStats(command, stats, opts);
    const score = m * 0.8 + freq + boost + ev.sel * WEIGHTS.selectionBonus - ev.rej * WEIGHTS.rejectionPenalty;
    if (score >= 0) scored.push({ command, score, exact: m >= 100 });
  };

  for (const stat of stats) {
    consider(stat.command, false);
  }

  // Curated static options (per-command flags) act as low-priority defaults.
  for (const c of opts.curated ?? []) {
    consider(c, true);
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, WEIGHTS.maxCandidates);
  const topScore = top[0]?.score ?? 0;

  let mode: SuggestionMode = 'hidden';
  if (topScore >= WEIGHTS.minScoreToShow && top.length > 0) {
    mode = 'popup';
  }

  return { mode, candidates: top };
}

function scopeBoostForStats(command: string, stats: CommandStat[], opts: Partial<RankInput>): number {
  let best = 0;
  for (const stat of stats) {
    if (stat.command !== command) continue;
    best = Math.max(best, scopeBoostFor(stat.scope, opts));
  }
  return best;
}

function scopeBoostFor(scope: string, opts: Partial<RankInput>): number {
  if (opts.connectionScope && scope === opts.connectionScope) return WEIGHTS.connectionBoost;
  if (opts.cwdScopeKey && scope === opts.cwdScopeKey) return WEIGHTS.cwdBoost;
  return 0;
}


