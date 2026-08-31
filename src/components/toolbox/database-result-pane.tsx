import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReactNode, RefObject } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Copy,
  Trash2,
} from "lucide-react";
import type {
  DatabaseResult,
  DatabaseResultColumn,
  DatabaseErrorResult,
  GridLayoutState,
} from "@/lib/database/result-types";
import type { FindCellMatch } from "@/lib/database/find-matches";
import { useRowWindow } from "@/lib/database/use-row-window";

/** Default visual width used when computing frozen-column offsets for a
 * column that has no explicit stored width. */
const DEFAULT_COLUMN_WIDTH = 120;
/** Width of the row-number gutter column. */
const ROW_GUTTER_WIDTH = 40;

interface DatabaseResultPaneLabels {
  readonly result: string;
  readonly message: string;
  readonly ready: string;
  readonly null: string;
  readonly previous: string;
  readonly next: string;
  readonly rowsRange: (from: number, to: number) => string;
  /** Sub-caption under `ready` in the empty state (ux-spec §4.2). */
  readonly readyHint?: string;
  /** "Copy message" context-menu item label (ux-spec §1.2.9). */
  readonly copyMessage?: string;
  /** "Clear result" context-menu item label (ux-spec §1.2.9). */
  readonly clearResult?: string;
}

/** A row staged for INSERT, rendered below committed rows with a `+` gutter. */
export interface PendingInsertRowView {
  readonly id: string;
  readonly values: readonly (string | null)[];
}

export type DatabaseResultMenuSource = "row" | "insert";

interface DatabaseResultPaneProps {
  readonly result: DatabaseResult | null;
  readonly height: number;
  /** When true the pane fills its parent (table browse tab = full-screen grid)
   * instead of using the fixed `height`. */
  readonly fillHeight?: boolean;
  readonly paged: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly labels: DatabaseResultPaneLabels;
  readonly renderContextMenu?: (
    cell: string | null,
    row: readonly (string | null)[],
    columnName: string,
    rowIndex: number,
    columnIndex: number,
    source?: DatabaseResultMenuSource,
  ) => ReactNode;
  /** Column-header context menu (Filter & Sort, column layout…). Table tab
   * only; query-tab grids do not receive this prop. */
  readonly renderColumnContextMenu?: (
    columnName: string,
    columnIndex: number,
  ) => ReactNode;
  /** Row-number gutter context menu (Set Row Height…). Table tab only. */
  readonly renderRowHeaderContextMenu?: () => ReactNode;
  /** Renders the persistent inline error card for `kind: "error"` results
   *  (feature-design §2.6). When absent, the pane degrades to the ready
   *  message area. Kept as a render-function so this shared component never
   *  imports database-error internals — providers pass their own labels. */
  readonly renderError?: (error: DatabaseErrorResult["error"]) => ReactNode;
  /** Per-table layout (frozen columns, widths, row height, type/comment
   * toggles). Absent for query-tab grids. */
  readonly layout?: GridLayoutState;
  /** True while a query is running: the stale grid is dimmed and disabled
   *  so users cannot edit results mid-execution (ux-spec §4.2 / P2-11). */
  readonly overlay?: boolean;
  /** Empty-state actions (ux-spec §1.2.9). Absent → menu items disabled. */
  readonly onCopyReadyMessage?: () => void;
  readonly onClearResult?: () => void;
  /** Drag-resize callback (columnIndex, new width px). */
  readonly onColumnResize?: (columnIndex: number, width: number) => void;
  /** Double-click best-fit callback (columnIndex). */
  readonly onColumnBestFit?: (columnIndex: number) => void;
  /** Find bar state (Slice B). Absent for query-tab grids. */
  readonly find?: {
    readonly open: boolean;
    readonly text: string;
    readonly current: number;
    readonly matches: readonly FindCellMatch[];
  };
  readonly findLabels?: {
    readonly placeholder: string;
    readonly previous: string;
    readonly next: string;
    readonly close: string;
    readonly count: (current: number, total: number) => string;
    readonly noMatch: string;
  };
  readonly onFindTextChange?: (text: string) => void;
  readonly onFindNext?: () => void;
  readonly onFindPrevious?: () => void;
  readonly onFindClose?: () => void;
  readonly onEditCell?: (rowIndex: number, columnIndex: number, value: string) => void;
  readonly isCellModified?: (rowIndex: number, columnIndex: number) => boolean;
  /** Rows staged for INSERT rendered below the committed rows. */
  readonly pendingInsertRows?: readonly PendingInsertRowView[];
  /** Indexes into the committed rows that are staged for DELETE. */
  readonly deletedRowIndexes?: readonly number[];
  readonly onEditInsertCell?: (
    insertIndex: number,
    columnIndex: number,
    value: string,
  ) => void;
  readonly isInsertCellModified?: (insertIndex: number, columnIndex: number) => boolean;
}

/** Latest-callback handle passed to memoized rows through a stable ref so the
 * rows can re-render only when their data actually changes while always
 * calling the freshest parent callbacks. */
interface RowHandlers {
  readonly labels: DatabaseResultPaneLabels;
  readonly renderContextMenu?: DatabaseResultPaneProps["renderContextMenu"];
  readonly onEditCell?: DatabaseResultPaneProps["onEditCell"];
  readonly isCellModified?: DatabaseResultPaneProps["isCellModified"];
  readonly onEditInsertCell?: DatabaseResultPaneProps["onEditInsertCell"];
  readonly isInsertCellModified?: DatabaseResultPaneProps["isInsertCellModified"];
  readonly editable: boolean;
  readonly onEditRequest: (
    source: "row" | "insert",
    row: number,
    column: number,
  ) => void;
  readonly editingReset: () => void;
}

interface CommittedRowProps {
  readonly row: readonly (string | null)[];
  readonly index: number;
  readonly isDeleted: boolean;
  readonly rowHeight: number | undefined;
  readonly frozen: boolean;
  readonly cellStyles: readonly (React.CSSProperties | undefined)[];
  readonly columns: readonly DatabaseResultColumn[];
  readonly pkKeySet: ReadonlySet<string>;
  readonly findMatchKeys: ReadonlySet<string>;
  readonly currentFindKey: string | null;
  readonly paginationOffset: number;
  readonly editing: {
    source: "row" | "insert";
    row: number;
    column: number;
  } | null;
  readonly handlersRef: RefObject<RowHandlers>;
}

/** One committed data row. memo() lets unrelated parent re-renders skip every
 * untouched row (row arrays keep their identity when a sibling is edited). */
const CommittedRow = memo(function CommittedRow({
  row,
  index,
  isDeleted,
  rowHeight,
  frozen,
  cellStyles,
  columns,
  pkKeySet,
  findMatchKeys,
  currentFindKey,
  paginationOffset,
  editing,
  handlersRef,
}: CommittedRowProps) {
  const handlers = handlersRef.current;
  return (
    <tr
      style={rowHeight ? { height: `${rowHeight}px` } : undefined}
      className={`hover:bg-primary/5 ${isDeleted ? "bg-red-500/5 opacity-70" : ""}`}
    >
      <td
        className="border-b border-r px-2 text-right text-muted-foreground"
        style={
          frozen
            ? { position: "sticky", left: 0, zIndex: 4, background: "inherit" }
            : undefined
        }
      >
        {paginationOffset + index + 1}
      </td>
      {/* eslint-disable-next-line react-hooks/refs -- deliberate: read the freshest parent handlers */}
      {row.map((cell, cellIndex) => {
        const cellKey = `${index}:${cellIndex}`;
        const isFindMatch = findMatchKeys.has(cellKey);
        const isFindCurrent = currentFindKey === cellKey;
        return (
          <td
            key={cellIndex}
            style={cellStyles[cellIndex]}
            data-find-current={isFindCurrent ? "true" : undefined}
            className={`whitespace-nowrap border-b border-r px-2 py-1 select-text ${handlers.isCellModified?.(index, cellIndex) ? "bg-amber-500/10" : ""} ${isFindMatch ? "bg-yellow-200/40" : ""} ${isFindCurrent ? "ring-2 ring-inset ring-yellow-500" : ""}`}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="min-w-24">
                  {editing?.source === "row" &&
                  editing.row === index &&
                  editing.column === cellIndex ? (
                    <input
                      autoFocus
                      className="w-full min-w-24 bg-transparent outline-none"
                      defaultValue={cell ?? ""}
                      onBlur={(event) => {
                        handlers.onEditCell?.(index, cellIndex, event.target.value);
                        handlersRef.current.editingReset();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") handlersRef.current.editingReset();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="w-full text-left"
                      disabled={
                        !handlers.onEditCell ||
                        !handlers.editable ||
                        pkKeySet.has(columns[cellIndex]?.key ?? "")
                      }
                      onDoubleClick={() =>
                        handlers.onEditRequest("row", index, cellIndex)
                      }
                    >
                      {cell ?? (
                        <span className="text-muted-foreground">{handlers.labels.null}</span>
                      )}
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              {handlers.renderContextMenu && (
                <ContextMenuContent data-testid="database-result-context-menu">
                  {handlers.renderContextMenu(
                    cell,
                    row,
                    columns[cellIndex]?.label ?? "",
                    index,
                    cellIndex,
                    "row",
                  )}
                </ContextMenuContent>
              )}
            </ContextMenu>
          </td>
        );
      })}
    </tr>
  );
});

interface InsertRowProps {
  readonly id: string;
  readonly values: readonly (string | null)[];
  readonly insertIndex: number;
  readonly rowHeight: number | undefined;
  readonly frozen: boolean;
  readonly cellStyles: readonly (React.CSSProperties | undefined)[];
  readonly columns: readonly DatabaseResultColumn[];
  readonly editing: {
    source: "row" | "insert";
    row: number;
    column: number;
  } | null;
  readonly handlersRef: RefObject<RowHandlers>;
}

/** One staged-INSERT row rendered below the committed rows. */
const InsertRow = memo(function InsertRow({
  id,
  values,
  insertIndex,
  rowHeight,
  frozen,
  cellStyles,
  columns,
  editing,
  handlersRef,
}: InsertRowProps) {
  const handlers = handlersRef.current;
  return (
    <tr
      style={rowHeight ? { height: `${rowHeight}px` } : undefined}
      className="bg-emerald-500/5 hover:bg-primary/5"
    >
      <td
        className="border-b border-r px-2 text-right text-emerald-600"
        style={
          frozen
            ? { position: "sticky", left: 0, zIndex: 4, background: "inherit" }
            : undefined
        }
      >
        +
      </td>
      {/* eslint-disable-next-line react-hooks/refs -- deliberate: read the freshest parent handlers */}
      {values.map((cell, cellIndex) => (
        <td
          key={`${id}:${cellIndex}`}
          style={cellStyles[cellIndex]}
          className={`whitespace-nowrap border-b border-r px-2 py-1 select-text ${handlers.isInsertCellModified?.(insertIndex, cellIndex) ? "bg-amber-500/10" : ""}`}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="min-w-24">
                {editing?.source === "insert" &&
                editing.row === insertIndex &&
                editing.column === cellIndex ? (
                  <input
                    autoFocus
                    className="w-full min-w-24 bg-transparent outline-none"
                    defaultValue={cell ?? ""}
                    onBlur={(event) => {
                      handlers.onEditInsertCell?.(insertIndex, cellIndex, event.target.value);
                      handlersRef.current.editingReset();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") handlersRef.current.editingReset();
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="w-full text-left"
                    disabled={!handlers.onEditInsertCell}
                    onDoubleClick={() =>
                      handlers.onEditRequest("insert", insertIndex, cellIndex)
                    }
                  >
                    {cell ?? (
                      <span className="text-muted-foreground">{handlers.labels.null}</span>
                    )}
                  </button>
                )}
              </div>
            </ContextMenuTrigger>
            {handlers.renderContextMenu && (
              <ContextMenuContent data-testid="database-result-context-menu">
                {handlers.renderContextMenu(
                  cell,
                  values,
                  columns[cellIndex]?.label ?? "",
                  insertIndex,
                  cellIndex,
                  "insert",
                )}
              </ContextMenuContent>
            )}
          </ContextMenu>
        </td>
      ))}
    </tr>
  );
});

export function DatabaseResultPane({
  result,
  height,
  fillHeight = false,
  paged,
  onPrevious,
  onNext,
  labels,
  renderContextMenu,
  renderColumnContextMenu,
  renderRowHeaderContextMenu,
  renderError,
  layout,
  overlay = false,
  onCopyReadyMessage,
  onClearResult,
  onColumnResize,
  onColumnBestFit,
  find,
  findLabels,
  onFindTextChange,
  onFindNext,
  onFindPrevious,
  onFindClose,
  onEditCell,
  isCellModified,
  pendingInsertRows = [],
  deletedRowIndexes = [],
  onEditInsertCell,
  isInsertCellModified,
}: DatabaseResultPaneProps) {
  const [editing, setEditing] = useState<{
    source: "row" | "insert";
    row: number;
    column: number;
  } | null>(null);
  const [resizing, setResizing] = useState<{
    columnIndex: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const tabularResult = result?.kind === "tabular" ? result : null;
  // Errors render through renderError (or the degraded ready area below);
  // header keeps the "message" label and an empty command-tags slot.
  const errorResult = result?.kind === "error" ? result : null;
  const commandTags =
    result && result.kind !== "empty" && result.kind !== "error"
      ? result.commandTags
      : [];
  const pagination = tabularResult?.pagination;
  // Effective row height used both by the grid and the windowing math. Default
  // layouts store rowHeight = 0 (means "unset"), so treat 0 as the 24px base.
  const effectiveRowHeight = layout?.rowHeight || 24;
  // The scroll container (the <section>) that owns the grid viewport.
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const totalRows = (tabularResult?.rows.length ?? 0) + pendingInsertRows.length;
  const rowWindow = useRowWindow(scrollContainerRef, totalRows, effectiveRowHeight);
  /** Staged INSERT rows live at the very end of the grid. Under windowing the
   * viewport is usually parked far above them, so a row staged by "Add Record"
   * would never be mounted — the click would look like a no-op. Keep every
   * staged row mounted (they are user-staged, so bounded) and scroll the
   * newest one into view. */
  const pendingInsertCount = pendingInsertRows.length;
  const previousInsertCountRef = useRef(pendingInsertCount);
  useEffect(() => {
    const staged = pendingInsertCount > previousInsertCountRef.current;
    previousInsertCountRef.current = pendingInsertCount;
    if (!staged) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [pendingInsertCount, totalRows]);

  const columnWidth = (columnIndex: number) =>
    layout?.widths[tabularResult?.columns[columnIndex]?.key ?? ""];
  const frozenCount = Math.min(
    layout?.frozenCount ?? 0,
    tabularResult?.columns.length ?? 0,
  );
  // Accumulated sticky offsets: gutter (40px) + each frozen column's width.
  const frozenOffsets: number[] = [];
  if (tabularResult) {
    let offset = ROW_GUTTER_WIDTH;
    for (let index = 0; index < frozenCount; index += 1) {
      frozenOffsets.push(offset);
      offset += columnWidth(index) ?? DEFAULT_COLUMN_WIDTH;
    }
  }
  // Column styles (width + frozen sticky offset) are computed once per column
  // per layout change — the grid calls this for EVERY rendered cell, so
  // caching avoids repeating the offset loop per cell (perf: wide/large
  // tables, e.g. 100 rows × many columns).
  const columnStyles = useMemo(() => {
    if (!tabularResult) return [];
    return tabularResult.columns.map((column, columnIndex) => {
      const width = layout?.widths[column.key ?? ""];
      const sticky =
        frozenCount > 0 && columnIndex < frozenCount
          ? ({
              position: "sticky",
              left: frozenOffsets[columnIndex] ?? ROW_GUTTER_WIDTH,
              zIndex: 5,
            } as const)
          : undefined;
      return { width: width ? `${width}px` : undefined, ...sticky };
    });
    // frozenCount/frozenOffsets derive from tabularResult/layout; keep the
    // memo keyed on the two stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [tabularResult, layout]);
  /** Primary-key column keys as a Set for O(1) lookups per cell. */
  const pkKeySet = useMemo(
    () => new Set(tabularResult?.editability.primaryKeyColumnKeys ?? []),
    [tabularResult],
  );
  const cellStyle = (columnIndex: number) => columnStyles[columnIndex] ?? undefined;

  const startResize = (
    event: React.PointerEvent,
    columnIndex: number,
  ) => {
    if (!onColumnResize) return;
    event.preventDefault();
    event.stopPropagation();
    const current = columnWidth(columnIndex) ?? DEFAULT_COLUMN_WIDTH;
    setResizing({ columnIndex, startX: event.clientX, startWidth: current });
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!resizing) return;
    const width = Math.max(60, resizing.startWidth + event.clientX - resizing.startX);
    onColumnResize?.(resizing.columnIndex, width);
  };
  const endResize = () => setResizing(null);

  // Find highlight lookups (B-6): raw-value case-insensitive contains.
  const findMatchKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const match of find?.matches ?? []) {
      keys.add(`${match.row}:${match.column}`);
    }
    return keys;
  }, [find?.matches]);
  const currentFindKey =
    find && find.matches[find.current]
      ? `${find.matches[find.current].row}:${find.matches[find.current].column}`
      : null;

  // Stable handle for memoized rows: .current is refreshed every render so rows
  // skip re-rendering while always calling the freshest callbacks.
  const rowHandlersRef = useRef<RowHandlers>({
    labels,
    editable: tabularResult?.editability.editable ?? false,
    onEditRequest: () => undefined,
    editingReset: () => undefined,
  });
  // eslint-disable-next-line react-hooks/refs -- deliberate latest-callback ref refresh during render
  rowHandlersRef.current = {
    labels,
    renderContextMenu,
    onEditCell,
    isCellModified,
    onEditInsertCell,
    isInsertCellModified,
    editable: tabularResult?.editability.editable ?? false,
    onEditRequest: (source, row, column) => setEditing({ source, row, column }),
    editingReset: () => setEditing(null),
  };
  /** O(1) membership for rows staged for DELETE. */
  const deletedRowSet = useMemo(() => new Set(deletedRowIndexes), [deletedRowIndexes]);

  // Scroll the active match into view (B-2). Under windowing the target row may
  // not be mounted yet, so scroll the container by pixel first; once the window
  // has mounted it, the cell fine-tunes the exact (incl. horizontal) alignment.
  useEffect(() => {
    if (!find?.open || !currentFindKey || !find.matches[find.current]) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (!rowWindow.enabled) {
      // Small grids: the target row is always mounted — keep the original
      // scroll-into-view behavior (vertical + horizontal).
      const cell = document.querySelector<HTMLElement>(`[data-find-current="true"]`);
      cell?.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    container.scrollTop = find.matches[find.current].row * effectiveRowHeight;
    requestAnimationFrame(() => {
      const cell = document.querySelector<HTMLElement>(`[data-find-current="true"]`);
      cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matched row is captured via currentFindKey; `find` is an always-fresh inline object
  }, [find?.open, currentFindKey, effectiveRowHeight, rowWindow.enabled]);

  return (
    <section
      ref={scrollContainerRef}
      className={
        fillHeight
          ? "min-h-0 flex-1 overflow-auto border-t"
          : "shrink-0 overflow-auto border-t"
      }
      style={fillHeight ? undefined : { height }}
    >
      <div className="flex h-7 items-center border-b bg-muted/20 px-2 text-[11px]">
        <span className="border-r pr-3 font-medium">
          {tabularResult ? labels.result : labels.message}
        </span>
        <span className="ml-2 text-muted-foreground">
          {commandTags.join(" · ")}
        </span>
      </div>
      {errorResult ? (
        renderError ? (
          renderError(errorResult.error)
        ) : (
          <div className="p-3 text-[12px] text-muted-foreground">{labels.ready}</div>
        )
      ) : tabularResult ? (
        <div
          className={overlay ? "opacity-60 pointer-events-none" : undefined}
          data-testid="database-result-grid-wrap"
        >
        <>
          {find?.open && findLabels && (
            <div
              className="flex h-8 items-center gap-1.5 border-b bg-muted/30 px-2"
              data-testid="database-result-find-bar"
            >
              <Input
                autoFocus
                value={find.text}
                onChange={(event) => onFindTextChange?.(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onFindNext?.();
                  }
                }}
                placeholder={findLabels.placeholder}
                className="h-6 w-52 rounded-sm text-[12px]"
                data-testid="database-result-find-input"
              />
              <span className="text-[11px] text-muted-foreground">
                {find.matches.length
                  ? findLabels.count(find.current + 1, find.matches.length)
                  : find.text
                    ? findLabels.noMatch
                    : ""}
              </span>
              <div className="ml-auto flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  disabled={!find.matches.length}
                  onClick={() => onFindPrevious?.()}
                >
                  {findLabels.previous}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  disabled={!find.matches.length}
                  onClick={() => onFindNext?.()}
                >
                  {findLabels.next}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  onClick={() => onFindClose?.()}
                  aria-label={findLabels.close}
                >
                  ✕
                </Button>
              </div>
            </div>
          )}
          <table className="w-full border-collapse text-[12px]">
            {layout && (
              <colgroup>
                <col style={{ width: ROW_GUTTER_WIDTH }} />
                {tabularResult.columns.map((column, columnIndex) => {
                  const width = columnWidth(columnIndex);
                  return <col key={column.key} style={{ width: width ? `${width}px` : undefined }} />;
                })}
              </colgroup>
            )}
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th
                  className="w-10 border-b border-r px-2 text-right font-normal text-muted-foreground"
                  style={
                    layout?.frozenCount
                      ? { position: "sticky", left: 0, zIndex: 6 }
                      : undefined
                  }
                >
                  {renderRowHeaderContextMenu ? (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div className="w-full cursor-context-menu select-none text-right">
                          #
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent data-testid="database-result-row-header-context-menu">
                        {renderRowHeaderContextMenu()}
                      </ContextMenuContent>
                    </ContextMenu>
                  ) : (
                    "#"
                  )}
                </th>
                {tabularResult.columns.map((column, columnIndex) => (
                  <th
                    key={column.key}
                    className="relative whitespace-nowrap border-b border-r px-2 py-1 text-left font-medium"
                    style={cellStyle(columnIndex)}
                    title={[column.providerType, column.providerComment]
                      .filter(Boolean)
                      .join("\n") || undefined}
                  >
                    {renderColumnContextMenu ? (
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div className="w-full cursor-context-menu select-none">
                            {column.label}
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent data-testid="database-result-column-context-menu">
                          {renderColumnContextMenu(column.label, columnIndex)}
                        </ContextMenuContent>
                      </ContextMenu>
                    ) : (
                      column.label
                    )}
                    {(layout?.showFieldType || layout?.showComment) && (
                      <div className="text-[10px] font-normal leading-tight text-muted-foreground">
                        {layout?.showFieldType && column.providerType
                          ? column.providerType
                          : ""}
                        {layout?.showComment && column.providerComment
                          ? `${column.providerType ? " · " : ""}${column.providerComment}`
                          : ""}
                      </div>
                    )}
                    {onColumnResize && (
                      <div
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none"
                        onPointerDown={(event) => startResize(event, columnIndex)}
                        onPointerMove={onPointerMove}
                        onPointerUp={endResize}
                        onDoubleClick={() => onColumnBestFit?.(columnIndex)}
                        data-testid={`database-column-resize-${columnIndex}`}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody onPointerMove={onPointerMove} onPointerUp={endResize}>
              {(() => {
                const committedCount = tabularResult.rows.length;
                // Keep the committed row being edited mounted even if the
                // scroll window would otherwise unload it (unmounting the
                // input commits it). Staged INSERT rows are always mounted
                // below, so they need no window extension.
                let start = rowWindow.start;
                let end = rowWindow.end;
                if (rowWindow.enabled && editing?.source === "row") {
                  start = Math.min(start, editing.row);
                  end = Math.max(end, editing.row + 1);
                }
                const windowedRows: React.ReactNode[] = [];
                if (rowWindow.enabled && start > 0) {
                  windowedRows.push(
                    <tr key="spacer-top" aria-hidden="true" data-testid="database-result-window-spacer-top">
                      <td
                        colSpan={tabularResult.columns.length + 1}
                        className="p-0"
                        style={{ height: start * effectiveRowHeight }}
                      />
                    </tr>,
                  );
                }
                const committedEnd = Math.min(end, committedCount);
                for (let global = start; global < committedEnd; global += 1) {
                  windowedRows.push(
                    <CommittedRow
                      key={pagination ? pagination.offset + global : global}
                      row={tabularResult.rows[global]}
                      index={global}
                      isDeleted={deletedRowSet.has(global)}
                      rowHeight={
                        rowWindow.enabled ? effectiveRowHeight : layout?.rowHeight
                      }
                      frozen={Boolean(layout?.frozenCount)}
                      cellStyles={columnStyles}
                      columns={tabularResult.columns}
                      pkKeySet={pkKeySet}
                      findMatchKeys={findMatchKeys}
                      currentFindKey={currentFindKey}
                      paginationOffset={pagination?.offset ?? 0}
                      editing={editing}
                      handlersRef={rowHandlersRef}
                    />,
                  );
                }
                // The gap between the window and the committed rows is
                // spacer-filled BEFORE the staged rows, so the staged rows keep
                // their position below every committed row.
                if (rowWindow.enabled && committedEnd < committedCount) {
                  windowedRows.push(
                    <tr key="spacer-bottom" aria-hidden="true" data-testid="database-result-window-spacer-bottom">
                      <td
                        colSpan={tabularResult.columns.length + 1}
                        className="p-0"
                        style={{
                          height: (committedCount - committedEnd) * effectiveRowHeight,
                        }}
                      />
                    </tr>,
                  );
                }
                pendingInsertRows.forEach((insertRow, insertIndex) => {
                  windowedRows.push(
                    <InsertRow
                      key={insertRow.id}
                      id={insertRow.id}
                      values={insertRow.values}
                      insertIndex={insertIndex}
                      rowHeight={
                        rowWindow.enabled ? effectiveRowHeight : layout?.rowHeight
                      }
                      frozen={Boolean(layout?.frozenCount)}
                      cellStyles={columnStyles}
                      columns={tabularResult.columns}
                      editing={editing}
                      handlersRef={rowHandlersRef}
                    />,
                  );
                });
                if (!windowedRows.length) {
                  windowedRows.push(
                    <tr key="empty">
                      <td
                        colSpan={tabularResult.columns.length + 1}
                        className="h-16 px-3 text-center text-[12px] text-muted-foreground"
                      >
                        {labels.ready}
                      </td>
                    </tr>,
                  );
                }
                return windowedRows;
              })()}
            </tbody>
          </table>
          {paged && pagination && (
            <div className="sticky bottom-0 flex h-7 items-center gap-1 border-t bg-background px-2 text-[11px]">
              <span>
                {labels.rowsRange(
                  pagination.offset + 1,
                  pagination.offset + tabularResult.rows.length,
                )}
              </span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 rounded-sm px-2 text-[11px]" disabled={!pagination.offset} onClick={onPrevious}>
                  {labels.previous}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 rounded-sm px-2 text-[11px]" disabled={!pagination.hasMore} onClick={onNext}>
                  {labels.next}
                </Button>
              </div>
            </div>
          )}
        </>
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center gap-2 text-muted-foreground" data-testid="database-result-empty">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex cursor-context-menu items-center gap-2">
                <Inbox className="size-5 shrink-0" />
                <span className="text-[12px]">{labels.ready}</span>
                {labels.readyHint && (
                  <span className="text-[11px] text-muted-foreground/70">
                    {labels.readyHint}
                  </span>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent data-testid="database-result-empty-context-menu">
              <ContextMenuItem
                onSelect={onCopyReadyMessage}
                disabled={!onCopyReadyMessage}
                data-testid="database-result-empty-copy-message"
              >
                <Copy className="h-3.5 w-3.5" />
                {labels.copyMessage ?? "Copy message"}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={onClearResult}
                disabled={!onClearResult}
                data-testid="database-result-empty-clear-result"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {labels.clearResult ?? "Clear result"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      )}
    </section>
  );
}
