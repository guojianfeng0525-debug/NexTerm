import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  DatabaseResult,
  GridLayoutState,
} from "@/lib/database/result-types";
import type { FindCellMatch } from "@/lib/database/find-matches";

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
  /** Per-table layout (frozen columns, widths, row height, type/comment
   * toggles). Absent for query-tab grids. */
  readonly layout?: GridLayoutState;
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
  layout,
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
  const commandTags = result?.kind === "empty" ? [] : result?.commandTags ?? [];
  const pagination = tabularResult?.pagination;

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
  const cellStyle = (columnIndex: number) => {
    const width = columnWidth(columnIndex);
    const sticky =
      frozenCount > 0 && columnIndex < frozenCount
        ? ({
            position: "sticky",
            left: frozenOffsets[columnIndex] ?? ROW_GUTTER_WIDTH,
            zIndex: 5,
          } as const)
        : undefined;
    return { width: width ? `${width}px` : undefined, ...sticky };
  };

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

  // Scroll the active match into view (B-2).
  useEffect(() => {
    if (!find?.open || !currentFindKey) return;
    const cell = document.querySelector<HTMLElement>(
      `[data-find-current="true"]`,
    );
    cell?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [find?.open, currentFindKey]);

  return (
    <section
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
      {tabularResult ? (
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
              {tabularResult.rows.map((row, index) => {
                const isDeleted = deletedRowIndexes.includes(index);
                const rowStyle = layout?.rowHeight
                  ? { height: `${layout.rowHeight}px` }
                  : undefined;
                return (
                  <tr
                    key={pagination ? pagination.offset + index : index}
                    style={rowStyle}
                    className={`hover:bg-primary/5 ${isDeleted ? "bg-red-500/5 opacity-70" : ""}`}
                  >
                    <td
                      className="border-b border-r px-2 text-right text-muted-foreground"
                      style={
                        layout?.frozenCount
                          ? { position: "sticky", left: 0, zIndex: 4, background: "inherit" }
                          : undefined
                      }
                    >
                      {(pagination?.offset ?? 0) + index + 1}
                    </td>
                    {row.map((cell, cellIndex) => {
                      const cellKey = `${index}:${cellIndex}`;
                      const isFindMatch = findMatchKeys.has(cellKey);
                      const isFindCurrent = currentFindKey === cellKey;
                      return (
                      <td
                        key={cellKey}
                        style={cellStyle(cellIndex)}
                        data-find-current={isFindCurrent ? "true" : undefined}
                        className={`whitespace-nowrap border-b border-r px-2 py-1 select-text ${isCellModified?.(index, cellIndex) ? "bg-amber-500/10" : ""} ${isFindMatch ? "bg-yellow-200/40" : ""} ${isFindCurrent ? "ring-2 ring-inset ring-yellow-500" : ""}`}
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
                                    onEditCell?.(index, cellIndex, event.target.value);
                                    setEditing(null);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") event.currentTarget.blur();
                                    if (event.key === "Escape") setEditing(null);
                                  }}
                                />
                              ) : (
                                <button
                                  type="button"
                                  className="w-full text-left"
                                  disabled={
                                    !onEditCell ||
                                    !tabularResult.editability.editable ||
                                    tabularResult.editability.primaryKeyColumnKeys.includes(
                                      tabularResult.columns[cellIndex]?.key ?? "",
                                    )
                                  }
                                  onDoubleClick={() =>
                                    setEditing({ source: "row", row: index, column: cellIndex })
                                  }
                                >
                                  {cell ?? (
                                    <span className="text-muted-foreground">{labels.null}</span>
                                  )}
                                </button>
                              )}
                            </div>
                          </ContextMenuTrigger>
                          {renderContextMenu && (
                            <ContextMenuContent data-testid="database-result-context-menu">
                              {renderContextMenu(
                                cell,
                                row,
                                tabularResult.columns[cellIndex]?.label ?? "",
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
              })}
              {pendingInsertRows.map((insertRow, insertIndex) => (
                <tr key={insertRow.id} className="bg-emerald-500/5 hover:bg-primary/5">
                  <td
                    className="border-b border-r px-2 text-right text-emerald-600"
                    style={
                      layout?.frozenCount
                        ? { position: "sticky", left: 0, zIndex: 4, background: "inherit" }
                        : undefined
                    }
                  >
                    +
                  </td>
                  {insertRow.values.map((cell, cellIndex) => (
                    <td
                      key={`${insertRow.id}:${cellIndex}`}
                      style={cellStyle(cellIndex)}
                      className={`whitespace-nowrap border-b border-r px-2 py-1 select-text ${isInsertCellModified?.(insertIndex, cellIndex) ? "bg-amber-500/10" : ""}`}
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
                                  onEditInsertCell?.(
                                    insertIndex,
                                    cellIndex,
                                    event.target.value,
                                  );
                                  setEditing(null);
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                  if (event.key === "Escape") setEditing(null);
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="w-full text-left"
                                disabled={!onEditInsertCell}
                                onDoubleClick={() =>
                                  setEditing({
                                    source: "insert",
                                    row: insertIndex,
                                    column: cellIndex,
                                  })
                                }
                              >
                                {cell ?? (
                                  <span className="text-muted-foreground">{labels.null}</span>
                                )}
                              </button>
                            )}
                          </div>
                        </ContextMenuTrigger>
                        {renderContextMenu && (
                          <ContextMenuContent data-testid="database-result-context-menu">
                            {renderContextMenu(
                              cell,
                              insertRow.values,
                              tabularResult.columns[cellIndex]?.label ?? "",
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
              ))}
              {!tabularResult.rows.length && !pendingInsertRows.length && (
                <tr>
                  <td
                    colSpan={tabularResult.columns.length + 1}
                    className="h-16 px-3 text-center text-[12px] text-muted-foreground"
                  >
                    {labels.ready}
                  </td>
                </tr>
              )}
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
      ) : (
        <div className="p-3 text-[12px] text-muted-foreground">{labels.ready}</div>
      )}
    </section>
  );
}
