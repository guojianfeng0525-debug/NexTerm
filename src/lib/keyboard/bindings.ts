import type { CommandBinding } from "./scope-router";

/**
 * B20: 18 Navicat shortcut groups (D-B20-3). Source of truth is
 * docs/database/navicat-premium-shortcuts.md (M17 pp.379-381). Only groups
 * whose command already exists are registered; unbuilt groups (ER diagram,
 * clipboard stack) are tracked as hidden comments and wired in B23/B24.
 */
export const NAVICAT_BINDINGS: readonly CommandBinding[] = [
  // ---- Data grid (DATA_GRID scope) ----
  {
    commandId: "database.data.filterSort",
    combo: "Ctrl+R",
    scopes: ["DATA_GRID"],
  },
  {
    commandId: "database.data.addRecord",
    combo: "Insert",
    scopes: ["DATA_GRID"],
  },
  {
    commandId: "database.data.deleteRecord",
    combo: "Ctrl+Delete",
    scopes: ["DATA_GRID"],
  },
  {
    commandId: "database.data.saveChanges",
    combo: "Ctrl+S",
    scopes: ["DATA_GRID"],
  },
  {
    commandId: "database.data.clearFilter",
    combo: "Escape",
    scopes: ["DATA_GRID"],
  },
  // ---- Query editor (QUERY_EDITOR scope) ----
  {
    commandId: "database.query.execute",
    combo: "Ctrl+Shift+R",
    scopes: ["QUERY_EDITOR"],
  },
  {
    commandId: "database.query.execute",
    combo: "Ctrl+E",
    scopes: ["QUERY_EDITOR"],
  },
  {
    // UX spec §3.1: Ctrl+Enter is the primary run combo (DBeaver/Beekeeper/VS Code).
    commandId: "database.query.execute",
    combo: "Ctrl+Enter",
    scopes: ["QUERY_EDITOR"],
  },
  {
    commandId: "database.query.explain",
    combo: "Ctrl+Shift+E",
    scopes: ["QUERY_EDITOR"],
  },
  {
    commandId: "database.query.toggleComment",
    combo: "Ctrl+/",
    scopes: ["QUERY_EDITOR"],
  },
  {
    commandId: "database.query.openFile",
    combo: "Ctrl+O",
    scopes: ["QUERY_EDITOR"],
  },
  // ---- Navigator (NAVIGATOR scope) ----
  {
    commandId: "database.object.open",
    combo: "Enter",
    scopes: ["NAVIGATOR"],
  },
  {
    commandId: "database.object.refresh",
    combo: "F5",
    scopes: ["NAVIGATOR"],
  },
  {
    commandId: "database.connection.refresh",
    combo: "F5",
    scopes: ["NAVIGATOR"],
  },
  // ---- Workspace-wide (DATABASE_WORKSPACE scope) ----
  {
    commandId: "database.workspace.newQuery",
    combo: "Ctrl+N",
    scopes: ["DATABASE_WORKSPACE"],
  },
  {
    commandId: "database.tab.close",
    combo: "Ctrl+W",
    scopes: ["DATABASE_WORKSPACE", "DATA_GRID", "QUERY_EDITOR"],
  },
  // ---- Global fallbacks that must not collide with terminals ----
  {
    commandId: "database.data.refresh",
    combo: "Ctrl+R",
    scopes: ["DATABASE_WORKSPACE"],
  },
];

/**
 * Hidden groups (registered for conflict tracking only, never active until
 * their feature batch lands). ER diagram = B24, clipboard stack = B19/C.
 */
export const HIDDEN_BINDINGS: readonly CommandBinding[] = [
  // ER diagram (B24): Ctrl+Enter open cell editor, R new FK, F5 refresh
  // { commandId: "er.refresh", combo: "F5", scopes: [] },
  // { commandId: "er.newForeignKey", combo: "R", scopes: [] },
  // { commandId: "er.deleteForeignKey", combo: "Delete", scopes: [] },
  // Query editor clipboard stack (B19/C): Ctrl+Shift+V
  // { commandId: "query.clipboardStack", combo: "Ctrl+Shift+V", scopes: [] },
];

/** All bindings, active + hidden (hidden entries have empty scopes). */
export const ALL_BINDINGS: readonly CommandBinding[] = [
  ...NAVICAT_BINDINGS,
  ...HIDDEN_BINDINGS,
];

/** Combo strings that must never reach GLOBAL (terminal/app collision). */
export const TERMINAL_RESERVED_COMBOS: readonly string[] = [
  "Ctrl+N",
  "Ctrl+W",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  "Ctrl+B",
  "Ctrl+J",
  "Ctrl+M",
  "Ctrl+Z",
  "Ctrl+\\",
  "Ctrl+1",
  "Ctrl+2",
  "Ctrl+3",
  "Ctrl+4",
  "Ctrl+5",
  "Ctrl+6",
  "Ctrl+7",
  "Ctrl+8",
  "Ctrl+9",
  "F5",
];
