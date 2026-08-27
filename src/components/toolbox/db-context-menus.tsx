/**
 * Shared DB-domain context menus (feature-design §3.2 / ux-spec §1.2).
 *
 * Pure render functions: each takes `actions` + `labels` and returns the menu
 * item JSX fragment — the caller wraps it in `<ContextMenuContent>`
 * (database-navigator / database-result-pane / query editor / tab strip).
 * They intentionally import no i18n so unit tests stay dependency-free; the
 * three tools pass their own `toolbox.<provider>.*` labels.
 *
 * Rules followed from ux-spec §1.1:
 * - disabled = greyed out (never hidden), except optional actions (export,
 *   saveToNotes, remove) that are omitted entirely when the caller has no
 *   implementation.
 * - Destructive items use variant="destructive".
 * - Shortcut badges use ContextMenuShortcut with the effective binding.
 */

import type { ReactNode } from "react";
import {
  Braces,
  ClipboardPaste,
  Copy,
  CopyCheck,
  CopyMinus,
  FileCode2,
  FileDown,
  FilePlus2,
  FileSpreadsheet,
  Hash,
  ListChecks,
  ListPlus,
  Play,
  Redo2,
  RefreshCw,
  Scissors,
  Table2,
  Trash2,
  Undo2,
  Wand2,
} from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

/** macOS symbol shortcuts (⌘⇧⌥) vs Ctrl+Shift+Alt text on other platforms. */
function formatShortcut(combo: string): string {
  if (
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().includes("MAC")
  ) {
    return combo
      .replace("Ctrl", "⌘")
      .replace("Shift", "⇧")
      .replace("Alt", "⌥")
      .replace(/\+/g, "");
  }
  return combo;
}

// ---------------------------------------------------------------------------
// Navigator relation menu (ux-spec §1.2.2 subset)
// ---------------------------------------------------------------------------

export interface NavigatorRelationMenuLabels {
  readonly openData: string;
  readonly copyName: string;
  readonly generateSql: string;
  readonly generateSqlSelect: string;
  readonly generateSqlInsert: string;
  readonly generateSqlUpdate: string;
  readonly generateSqlDelete: string;
  readonly refresh: string;
  readonly newQuery: string;
}

export interface NavigatorRelationMenuActions {
  readonly openData: () => void;
  readonly copyName: () => void;
  readonly generateSelect: () => void;
  /** Absent when column metadata is unavailable → INSERT item greyed out. */
  readonly generateInsert?: () => void;
  readonly generateUpdate?: () => void;
  readonly generateDelete?: () => void;
  readonly refresh: () => void;
  readonly newQuery: () => void;
  /** True when disconnected — every action is greyed out. */
  readonly disabled: boolean;
}

export function NavigatorRelationMenu({
  actions,
  labels,
}: {
  readonly actions: NavigatorRelationMenuActions;
  readonly labels: NavigatorRelationMenuLabels;
}): ReactNode {
  return (
    <>
      <ContextMenuItem
        disabled={actions.disabled}
        onSelect={actions.openData}
        data-testid="navigator-menu-open-data"
      >
        <Table2 className="h-3.5 w-3.5" />
        {labels.openData}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={actions.disabled}
        onSelect={actions.copyName}
        data-testid="navigator-menu-copy-name"
      >
        <Copy className="h-3.5 w-3.5" />
        {labels.copyName}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={actions.disabled}>
          <Braces className="h-3.5 w-3.5" />
          {labels.generateSql}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent data-testid="navigator-menu-generate-sql">
          <ContextMenuItem
            disabled={actions.disabled}
            onSelect={actions.generateSelect}
            data-testid="navigator-menu-generate-select"
          >
            {labels.generateSqlSelect}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={actions.disabled || !actions.generateInsert}
            onSelect={() => actions.generateInsert?.()}
            data-testid="navigator-menu-generate-insert"
          >
            {labels.generateSqlInsert}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={actions.disabled || !actions.generateUpdate}
            onSelect={() => actions.generateUpdate?.()}
            data-testid="navigator-menu-generate-update"
          >
            {labels.generateSqlUpdate}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={actions.disabled || !actions.generateDelete}
            onSelect={() => actions.generateDelete?.()}
            data-testid="navigator-menu-generate-delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {labels.generateSqlDelete}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={actions.disabled}
        onSelect={actions.refresh}
        data-testid="navigator-menu-refresh"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {labels.refresh}
        <ContextMenuShortcut>{formatShortcut("F5")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={actions.disabled}
        onSelect={actions.newQuery}
        data-testid="navigator-menu-new-query"
      >
        <FilePlus2 className="h-3.5 w-3.5" />
        {labels.newQuery}
        <ContextMenuShortcut>{formatShortcut("Ctrl+N")}</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

// ---------------------------------------------------------------------------
// Result grid cell menu (ux-spec §1.2.6 subset)
// ---------------------------------------------------------------------------

export interface ResultCellMenuLabels {
  readonly copyCell: string;
  readonly copyRow: string;
  readonly copyColumnName: string;
  readonly exportCsv: string;
  readonly exportExcel: string;
  readonly removeRecord: string;
}

export interface ResultCellMenuActions {
  readonly copyCell: () => void;
  readonly copyRow: () => void;
  readonly copyColumnName: () => void;
  readonly exportCsv?: () => void;
  readonly exportExcel?: () => void;
  /** Only wired for insert rows (remove staged row). */
  readonly remove?: () => void;
}

export function ResultCellMenu({
  actions,
  source,
  labels,
}: {
  readonly actions: ResultCellMenuActions;
  readonly source: "row" | "insert";
  readonly labels: ResultCellMenuLabels;
}): ReactNode {
  if (source === "insert") {
    return (
      <>
        <ContextMenuItem onSelect={actions.copyCell} data-testid="result-menu-copy-cell">
          <Copy className="h-3.5 w-3.5" />
          {labels.copyCell}
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.copyRow} data-testid="result-menu-copy-row">
          <CopyCheck className="h-3.5 w-3.5" />
          {labels.copyRow}
        </ContextMenuItem>
        {actions.remove && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={actions.remove}
              data-testid="result-menu-remove-record"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {labels.removeRecord}
            </ContextMenuItem>
          </>
        )}
      </>
    );
  }
  return (
    <>
      <ContextMenuItem onSelect={actions.copyCell} data-testid="result-menu-copy-cell">
        <Copy className="h-3.5 w-3.5" />
        {labels.copyCell}
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.copyRow} data-testid="result-menu-copy-row">
        <CopyCheck className="h-3.5 w-3.5" />
        {labels.copyRow}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={actions.copyColumnName}
        data-testid="result-menu-copy-column-name"
      >
        <CopyMinus className="h-3.5 w-3.5" />
        {labels.copyColumnName}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {actions.exportCsv && (
        <ContextMenuItem onSelect={actions.exportCsv} data-testid="result-menu-export-csv">
          <FileDown className="h-3.5 w-3.5" />
          {labels.exportCsv}
        </ContextMenuItem>
      )}
      {actions.exportExcel && (
        <ContextMenuItem
          onSelect={actions.exportExcel}
          data-testid="result-menu-export-excel"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          {labels.exportExcel}
        </ContextMenuItem>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Query editor menu (ux-spec §1.2.5)
// ---------------------------------------------------------------------------

export interface QueryEditorMenuLabels {
  readonly undo: string;
  readonly redo: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly selectAll: string;
  readonly run: string;
  readonly runSelection: string;
  readonly formatSql: string;
  readonly toggleComment: string;
  /** Omitted together with the saveToNotes action when not provided. */
  readonly saveToNotes?: string;
}

export interface QueryEditorMenuActions {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly cut: () => void;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
  readonly execute: () => void;
  readonly runSelection: () => void;
  readonly formatSql: () => void;
  readonly toggleComment: () => void;
  readonly saveToNotes?: () => void;
  /** Grey out the whole execution group (disconnected / empty SQL). */
  readonly disabledExecute: boolean;
}

export function QueryEditorMenu({
  actions,
  labels,
}: {
  readonly actions: QueryEditorMenuActions;
  readonly labels: QueryEditorMenuLabels;
}): ReactNode {
  return (
    <>
      {/* Edit group */}
      <ContextMenuItem onSelect={actions.undo} data-testid="editor-menu-undo">
        <Undo2 className="h-3.5 w-3.5" />
        {labels.undo}
        <ContextMenuShortcut>{formatShortcut("Ctrl+Z")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.redo} data-testid="editor-menu-redo">
        <Redo2 className="h-3.5 w-3.5" />
        {labels.redo}
        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+Z")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={actions.cut} data-testid="editor-menu-cut">
        <Scissors className="h-3.5 w-3.5" />
        {labels.cut}
        <ContextMenuShortcut>{formatShortcut("Ctrl+X")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.copy} data-testid="editor-menu-copy">
        <Copy className="h-3.5 w-3.5" />
        {labels.copy}
        <ContextMenuShortcut>{formatShortcut("Ctrl+C")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.paste} data-testid="editor-menu-paste">
        <ClipboardPaste className="h-3.5 w-3.5" />
        {labels.paste}
        <ContextMenuShortcut>{formatShortcut("Ctrl+V")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.selectAll} data-testid="editor-menu-select-all">
        <ListChecks className="h-3.5 w-3.5" />
        {labels.selectAll}
        <ContextMenuShortcut>{formatShortcut("Ctrl+A")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* Execution group */}
      <ContextMenuItem
        disabled={actions.disabledExecute}
        onSelect={actions.execute}
        data-testid="editor-menu-execute"
      >
        <Play className="h-3.5 w-3.5" />
        {labels.run}
        <ContextMenuShortcut>{formatShortcut("Ctrl+Enter")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={actions.disabledExecute}
        onSelect={actions.runSelection}
        data-testid="editor-menu-run-selection"
      >
        <ListPlus className="h-3.5 w-3.5" />
        {labels.runSelection}
        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+Enter")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={actions.disabledExecute}
        onSelect={actions.formatSql}
        data-testid="editor-menu-format-sql"
      >
        <Wand2 className="h-3.5 w-3.5" />
        {labels.formatSql}
        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+F")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={actions.disabledExecute}
        onSelect={actions.toggleComment}
        data-testid="editor-menu-toggle-comment"
      >
        <Hash className="h-3.5 w-3.5" />
        {labels.toggleComment}
        <ContextMenuShortcut>{formatShortcut("Ctrl+/")}</ContextMenuShortcut>
      </ContextMenuItem>
      {actions.saveToNotes && labels.saveToNotes && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={actions.disabledExecute}
            onSelect={actions.saveToNotes}
            data-testid="editor-menu-save-to-notes"
          >
            <FileCode2 className="h-3.5 w-3.5" />
            {labels.saveToNotes}
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
