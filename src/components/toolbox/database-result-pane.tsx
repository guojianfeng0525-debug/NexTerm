import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { DatabaseResult } from "@/lib/database/result-types";

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
  paged,
  onPrevious,
  onNext,
  labels,
  renderContextMenu,
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
  const tabularResult = result?.kind === "tabular" ? result : null;
  const commandTags = result?.kind === "empty" ? [] : result?.commandTags ?? [];
  const pagination = tabularResult?.pagination;

  return (
    <section className="shrink-0 overflow-auto border-t" style={{ height }}>
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
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="w-10 border-b border-r px-2 text-right font-normal text-muted-foreground">
                  #
                </th>
                {tabularResult.columns.map((column) => (
                  <th
                    key={column.key}
                    className="whitespace-nowrap border-b border-r px-2 py-1 text-left font-medium"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tabularResult.rows.map((row, index) => {
                const isDeleted = deletedRowIndexes.includes(index);
                return (
                  <tr
                    key={pagination ? pagination.offset + index : index}
                    className={`hover:bg-primary/5 ${isDeleted ? "bg-red-500/5 opacity-70" : ""}`}
                  >
                    <td className="border-b border-r px-2 text-right text-muted-foreground">
                      {(pagination?.offset ?? 0) + index + 1}
                    </td>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${index}:${cellIndex}`}
                        className={`whitespace-nowrap border-b border-r px-2 py-1 select-text ${isCellModified?.(index, cellIndex) ? "bg-amber-500/10" : ""}`}
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
                    ))}
                  </tr>
                );
              })}
              {pendingInsertRows.map((insertRow, insertIndex) => (
                <tr key={insertRow.id} className="bg-emerald-500/5 hover:bg-primary/5">
                  <td className="border-b border-r px-2 text-right text-emerald-600">
                    +
                  </td>
                  {insertRow.values.map((cell, cellIndex) => (
                    <td
                      key={`${insertRow.id}:${cellIndex}`}
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
