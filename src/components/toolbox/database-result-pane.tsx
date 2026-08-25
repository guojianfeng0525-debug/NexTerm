import { Button } from "@/components/ui/button";
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

interface DatabaseResultPaneProps {
  readonly result: DatabaseResult | null;
  readonly height: number;
  readonly paged: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly labels: DatabaseResultPaneLabels;
}

export function DatabaseResultPane({
  result,
  height,
  paged,
  onPrevious,
  onNext,
  labels,
}: DatabaseResultPaneProps) {
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
              {tabularResult.rows.map((row, index) => (
                <tr key={pagination ? pagination.offset + index : index} className="hover:bg-primary/5">
                  <td className="border-b border-r px-2 text-right text-muted-foreground">
                    {(pagination?.offset ?? 0) + index + 1}
                  </td>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${index}:${cellIndex}`}
                      className="whitespace-nowrap border-b border-r px-2 py-1 select-text"
                    >
                      {cell ?? <span className="text-muted-foreground">{labels.null}</span>}
                    </td>
                  ))}
                </tr>
              ))}
              {!tabularResult.rows.length && (
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
