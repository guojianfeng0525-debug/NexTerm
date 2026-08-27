import { useEffect, useRef } from "react";
import {
  type CommandBinding,
  type KeyboardScope,
  type ScopeAnchors,
  resolveScope,
  routeKeyEvent,
} from "./scope-router";
import { NAVICAT_BINDINGS } from "./bindings";
import {
  commandsWithBindings,
  getDatabaseCommand,
  type DatabaseCommandId,
  type DatabaseCommandScope,
} from "@/lib/database/command-registry";

/**
 * Database toolbox keyboard integration (feature-design §1.2).
 *
 * Mounts a capture-phase window keydown that routes events through
 * `scope-router.routeKeyEvent` against `NAVICAT_BINDINGS` + command-registry
 * `defaultBinding`s, then dispatches to the tool-provided handlers. The hook
 * owns the scope bookkeeping the tools previously hand-rolled (tool-postgres
 * keydown) while leaving the routing engine untouched.
 */

export type DatabaseCommandHandler = () => void;

export interface DatabaseKeyboardShortcutOptions {
  /** Workspace container testid of the current tool, e.g. "postgres-workspace".
   *  Used for scope anchors and own-workspace ownership (all three tools mount
   *  simultaneously). */
  readonly testId: "postgres-workspace" | "mysql-workspace" | "sqlite-workspace";
  /** Modal dialogs open (configOpen / managerOpen / filterDialog / layoutDialog …)
   *  short-circuit all DB commands — the dialog keeps the keyboard. */
  readonly dialogOpen: boolean;
  /** command id → handler. Missing commands are not registered (MySQL/SQLite
   *  only pass a `execute` subset). */
  readonly handlers: Partial<Record<DatabaseCommandId, DatabaseCommandHandler>>;
  /** Only for QUERY_EDITOR scope: whether the event target belongs to this
   *  tool's editor instance (tools without a queryEditorViewRef may omit it). */
  readonly isOwnEditor?: (el: Element) => boolean;
}

const DESIGNER_ANCHOR_SELECTOR = '[data-testid="table-designer"]';

/**
 * True when the active element is inside the table designer. The DESIGNER
 * domain routes only `database.design.save` / `database.design.revert` and
 * never participates in the shared scope router (feature-design §1.3).
 */
export function resolveDesignerScope(activeElement: Element | null): boolean {
  if (!activeElement) return false;
  return Boolean(activeElement.closest(DESIGNER_ANCHOR_SELECTOR));
}

/**
 * Consumption guard (feature-design §1.2 boundary 3):
 * - QUERY_EDITOR / DATA_GRID: modifier combos (Ctrl/Cmd/Alt/Shift) are always
 *   consumed (IDE convention); plain combos (Insert / Escape / Enter / F5) are
 *   consumed only when the target is not typing in a field.
 * - NAVIGATOR / DATABASE_WORKSPACE: always consumed.
 * - DIALOG: never consumed (handled separately as an early short-circuit).
 */
export function shouldConsumeShortcut(
  event: KeyboardEvent,
  scope: KeyboardScope,
  typingInField: boolean,
): boolean {
  if (scope === "DIALOG") return false;
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
  if (scope === "QUERY_EDITOR" || scope === "DATA_GRID") {
    return hasModifier || !typingInField;
  }
  return true;
}

/** Maps command-registry scopes to router scopes. DESIGNER is excluded — it is
 *  routed exclusively by `resolveDesignerScope`. */
function toKeyboardScopes(
  scopes: readonly DatabaseCommandScope[],
): readonly KeyboardScope[] {
  const result: KeyboardScope[] = [];
  for (const scope of scopes) {
    switch (scope) {
      case "DATABASE":
      case "WORKSPACE":
        result.push("DATABASE_WORKSPACE");
        break;
      case "NAVIGATOR":
        result.push("NAVIGATOR");
        break;
      case "QUERY_EDITOR":
        result.push("QUERY_EDITOR");
        break;
      case "DATA_GRID":
        result.push("DATA_GRID");
        break;
      case "DESIGNER":
        break; // handled separately
    }
  }
  return result;
}

/**
 * Effective binding table = NAVICAT_BINDINGS + every command-registry
 * defaultBinding. Also the read entry point for a future shortcut-customization
 * panel (feature-design §6.2).
 */
export function buildEffectiveBindings(): readonly CommandBinding[] {
  return [
    ...NAVICAT_BINDINGS,
    ...commandsWithBindings().map(({ commandId, combo }) => {
      const descriptor = getDatabaseCommand(commandId);
      return {
        commandId,
        combo,
        scopes: toKeyboardScopes(descriptor?.scopes ?? []),
      };
    }),
  ];
}

/** DESIGNER-only matching: Ctrl/Cmd+S → save, Escape → revert (never while
 *  typing in a field, e.g. a column-name input). */
function matchDesignerCommand(
  event: KeyboardEvent,
  typingInField: boolean,
): DatabaseCommandId | null {
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
    return "database.design.save";
  }
  if (!typingInField && !hasModifier && event.key === "Escape") {
    return "database.design.revert";
  }
  return null;
}

/**
 * Registers the DB shortcut router for the calling tool. Safe to mount for all
 * three tools simultaneously — ownership is decided per keydown by the focus
 * location (boundary 2).
 */
export function useDatabaseKeyboardShortcuts(
  options: DatabaseKeyboardShortcutOptions,
): void {
  const optionsRef = useRef(options);
  const bindingsRef = useRef<readonly CommandBinding[] | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  });

  // Effective bindings are static constants; build once per mount.
  if (bindingsRef.current === null) {
    bindingsRef.current = buildEffectiveBindings();
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const opts = optionsRef.current;

      // Boundary 1 — DIALOG short-circuit: hand the keyboard entirely to the
      // dialog controls (resolveScope would otherwise fall through to DB scopes).
      if (opts.dialogOpen) return;

      // Boundary 2 — own-workspace ownership: all three tools are mounted at
      // once; ignore events whose focus is outside this tool's workspace.
      const activeElement = document.activeElement;
      if (!(activeElement instanceof Element)) return;
      if (!activeElement.closest(`[data-testid="${opts.testId}"]`)) return;

      const typingInField =
        event.target instanceof Element &&
        Boolean(event.target.closest("input, textarea, [contenteditable='true']"));

      // DESIGNER domain: route only design.save / design.revert. When the tool
      // does not register a design handler (e.g. MySQL/SQLite without a table
      // designer), the event is left untouched so TableDesignerTab's own
      // useDesignerShortcuts keeps working (feature-design §1.3).
      if (resolveDesignerScope(activeElement)) {
        const command = matchDesignerCommand(event, typingInField);
        if (command && opts.handlers[command]) {
          event.preventDefault();
          event.stopPropagation();
          opts.handlers[command]();
        }
        return;
      }

      const anchors: ScopeAnchors = {
        queryEditor: ".cm-editor",
        dataGrid: `[data-testid="${opts.testId}"] tbody`,
        navigator: "[data-node-id]",
      };
      const scope = resolveScope({
        dialogOpen: false,
        activeElement,
        anchors,
      });

      // Boundary 4 — multiple CodeMirror instances: when the tool declares an
      // ownership check (notes / object-viewer editors are also `.cm-editor`),
      // a foreign editor is left alone.
      if (scope === "QUERY_EDITOR" && opts.isOwnEditor) {
        const target = event.target instanceof Element ? event.target : null;
        if (target && !opts.isOwnEditor(target)) return;
      }

      // Boundary 3 — typingInField guard.
      if (!shouldConsumeShortcut(event, scope, typingInField)) return;

      const result = routeKeyEvent(event, scope, bindingsRef.current ?? []);
      if (!result) return;

      event.preventDefault();
      event.stopPropagation();
      // Missing handler ⇒ consume silently (feature-design §1.2).
      opts.handlers[result.commandId as DatabaseCommandId]?.();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, []);
}
