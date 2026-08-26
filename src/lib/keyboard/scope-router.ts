import { parseKeyboardShortcut, isEditableTarget } from "../keyboard-shortcuts";

/**
 * B20 keyboard scope router (D-B20-1/2).
 *
 * Dispatch priority (architect constraints, master plan D2):
 *   DIALOG > QUERY_EDITOR / DATA_GRID > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL
 *
 * xterm textareas are a hard no-intercept boundary: if the event target is
 * inside `.xterm`, the router returns null immediately and never calls
 * preventDefault (terminal IME rules preserved).
 */

/** Active input scopes, from highest priority to lowest. */
export type KeyboardScope =
  | "DIALOG"
  | "QUERY_EDITOR"
  | "DATA_GRID"
  | "NAVIGATOR"
  | "DATABASE_WORKSPACE"
  | "GLOBAL";

/** Raw key-combo parsed from a binding string like "Ctrl+Shift+R". */
export interface KeyCombo {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** A command binding: which combo triggers which command in which scopes. */
export interface CommandBinding {
  /** Command id from the database command registry (e.g. "database.query.execute"). */
  commandId: string;
  /** Combo string, e.g. "Ctrl+Shift+R". */
  combo: string;
  /**
   * Scopes where this binding is active. Empty array = hidden binding
   * (registered for conflict tracking only, e.g. ER group before B24).
   */
  scopes: readonly KeyboardScope[];
}

export interface RouteResult {
  commandId: string;
  /** The scope in which the binding was matched (for diagnostics). */
  scope: KeyboardScope;
  combo: KeyCombo;
}

/** Context used to resolve the current scope from the DOM/focus. */
export interface ScopeContext {
  /** A modal/dialog is open → DIALOG wins over everything. */
  dialogOpen: boolean;
  /** The element that currently has focus (may be null). */
  activeElement: Element | null;
  /** DOM anchors (selectors) used to detect each scope. */
  anchors: ScopeAnchors;
}

export interface ScopeAnchors {
  /** e.g. '[data-testid="filter-sort-dialog"]' */
  dialog?: string;
  /** CodeMirror editor container, e.g. '.cm-editor' */
  queryEditor?: string;
  /** Data grid container, e.g. '[data-testid="postgres-workspace"] tbody' or '.data-grid' */
  dataGrid?: string;
  /** Navigator tree, e.g. '[data-testid="database-navigator"]' */
  navigator?: string;
}

/** True when the event target is inside an xterm terminal (never intercept). */
export function isTerminalTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(".xterm") !== null;
}

/** Resolves the active scope from the context, following the D2 priority. */
export function resolveScope(context: ScopeContext): KeyboardScope {
  if (context.dialogOpen) return "DIALOG";
  const el = context.activeElement;
  if (el) {
    if (context.anchors.queryEditor && el.closest(context.anchors.queryEditor)) {
      return "QUERY_EDITOR";
    }
    if (context.anchors.dataGrid && el.closest(context.anchors.dataGrid)) {
      return "DATA_GRID";
    }
    if (context.anchors.navigator && el.closest(context.anchors.navigator)) {
      return "NAVIGATOR";
    }
  }
  return "DATABASE_WORKSPACE";
}

/**
 * Routes a keydown event through the bindings. Returns the matched command or
 * null when nothing matches (caller must not preventDefault in that case).
 *
 * Matching semantics (keyboard-shortcuts.ts parity): on macOS Ctrl and Cmd are
 * treated as equivalent unless the binding declares an explicit Meta.
 */
export function routeKeyEvent(
  event: KeyboardEvent,
  scope: KeyboardScope,
  bindings: readonly CommandBinding[],
): RouteResult | null {
  // xterm hard boundary.
  if (isTerminalTarget(event.target)) return null;

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const scopeRank: Record<KeyboardScope, number> = {
    DIALOG: 6,
    QUERY_EDITOR: 5,
    DATA_GRID: 5,
    NAVIGATOR: 4,
    DATABASE_WORKSPACE: 3,
    GLOBAL: 1,
  };
  const requestedRank = scopeRank[scope] ?? 0;

  // Gather every binding whose scope is active at-or-below the requested
  // scope, then pick the one with the highest scope rank (priority routing).
  let best: { result: RouteResult; rank: number } | null = null;
  for (const binding of bindings) {
    if (binding.scopes.length === 0) continue; // hidden binding
    let bindingRank = 0;
    for (const s of binding.scopes) {
      const rank = scopeRank[s] ?? 0;
      if (rank > bindingRank) bindingRank = rank;
    }
    // A binding applies when its (highest) scope rank is <= requested rank
    // (i.e. we fall back from DIALOG down to lower scopes).
    if (bindingRank > requestedRank) continue;

    const combo = parseKeyboardShortcut(binding.combo);
    if (!combo) continue;
    if (!matchesCombo(event, combo, isMac)) continue;

    if (!best || bindingRank > best.rank) {
      best = { result: { commandId: binding.commandId, scope, combo }, rank: bindingRank };
    }
  }
  return best?.result ?? null;
}

function matchesCombo(
  event: KeyboardEvent,
  combo: KeyCombo,
  isMac: boolean,
): boolean {
  const keyMatch = event.key.toLowerCase() === combo.key.toLowerCase();
  if (!keyMatch) return false;

  // macOS: Ctrl and Cmd are interchangeable unless the binding explicitly
  // requests Meta (mirrors keyboard-shortcuts.ts behaviour).
  const ctrlOrCmd = isMac ? event.metaKey || event.ctrlKey : event.ctrlKey;
  const usesExplicitMeta = combo.metaKey && !combo.ctrlKey;
  const ctrlMatch = usesExplicitMeta
    ? ctrlOrCmd === true
    : combo.ctrlKey === undefined || ctrlOrCmd === combo.ctrlKey;
  const shiftMatch = combo.shiftKey === undefined || event.shiftKey === combo.shiftKey;
  const altMatch = combo.altKey === undefined || event.altKey === combo.altKey;
  let metaMatch = combo.metaKey === undefined || event.metaKey === combo.metaKey;
  if (usesExplicitMeta) {
    metaMatch = event.metaKey === true;
  } else if (isMac && combo.ctrlKey !== undefined) {
    metaMatch = true;
  }
  return ctrlMatch && shiftMatch && altMatch && metaMatch;
}

/** Re-exported helper for tests: whether a target is an editable input. */
export { isEditableTarget };
