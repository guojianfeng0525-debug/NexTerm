/**
 * Adaptive Command Suggestion — shared types and tunable weights.
 *
 * The engine is a pure, offline, LLM-free scoring layer over per-command
 * usage statistics. All weights live here so they can be tuned without
 * touching the engine or UI code.
 */

/** Learning scopes for per-context weighting. */
export const SCOPE_GLOBAL = 'G';
export const SCOPE_CONNECTION_PREFIX = 'C:';
export const SCOPE_CWD_PREFIX = 'D:';

export interface CommandStat {
  /** Full command line (plaintext in memory; encrypted at rest). */
  command: string;
  /** 'G' | 'C:<connectionHash>' | 'D:<cwdHash>' */
  scope: string;
  use_count: number;
  selection_count: number;
  rejection_count: number;
  last_used: number; // epoch ms
}

export interface ScoredCandidate {
  command: string;
  score: number;
  /** True when the candidate is an exact completion of the current token. */
  exact: boolean;
}

export type SuggestionMode = 'hidden' | 'popup';

export interface SuggestionResult {
  mode: SuggestionMode;
  candidates: ScoredCandidate[];
}

/** Tunable ranking weights. */
export const WEIGHTS = {
  /** Multiplier for raw usage frequency. */
  frequency: 1.0,
  /** Multiplier for connection-scoped usage (scope matches current connection). */
  connectionBoost: 1.6,
  /** Multiplier for cwd-scoped usage (scope matches current directory). */
  cwdBoost: 1.3,
  /** Bonus per user acceptance of this suggestion. */
  selectionBonus: 0.8,
  /** Penalty per rejection (user ignored/avoided it). */
  rejectionPenalty: 1.2,
  /** Recency half-life in ms — usage older than this loses half its weight. */
  halfLifeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  /** Minimum top score to show anything at all ("自动安静"). */
  minScoreToShow: 4.0,
  /** Minimum gap between top-1 and top-2 to collapse to a single choice. */
  singleChoiceGap: 20.0,
  /** Maximum popup entries. */
  maxCandidates: 6,
  /** Commands must be used this many times before they qualify for display. */
  minUsesToSuggest: 1,
} as const;

/** Hard cap on the in-memory cache size (rows kept after pruning). */
export const STORE_CAP = 2000;
