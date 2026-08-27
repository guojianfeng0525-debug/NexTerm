/**
 * Inline error card rendered inside the result pane when a query fails
 * (feature-design §2.6 / ux-spec §2.2.2).
 *
 * The card is the single persistent home for the full error: compact
 * `message` + optional `code` on the first line, server `fullText` behind a
 * Collapsible, a `LINE n` badge when the server reported a line, and a
 * retry / copy / jump-to-line action row. The whole card is `select-text` so
 * users can copy any part of it manually (competitor consensus §2.2.4).
 */

import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  CircleAlert,
  Copy,
  Crosshair,
  Lightbulb,
  RotateCw,
  ChevronRight,
} from "lucide-react";
import type { ParsedDatabaseError } from "@/lib/database/database-error";

export interface DatabaseResultErrorPaneLabels {
  /** Error card title, e.g. "查询失败". */
  readonly error: string;
  readonly copy: string;
  readonly retry: string;
  readonly jumpToLine: string;
  /** Localized line badge, e.g. (n) => `第 ${n} 行`. */
  readonly line: (n: number) => string;
  /** Collapsible trigger text for the server detail block (optional; falls
   *  back to an English default when the caller omits it). */
  readonly details?: string;
}

export interface DatabaseResultErrorPaneProps {
  readonly error: ParsedDatabaseError;
  readonly labels: DatabaseResultErrorPaneLabels;
  /** Re-run the failed statement. Button is disabled when absent. */
  readonly onRetry?: () => void;
  /** Copy the full server error text (fullText). Disabled when absent. */
  readonly onCopy?: () => void;
  /** Scroll/reveal the offending line in the query editor. The button is
   *  hidden when absent (callers pass it only when the error is locatable). */
  readonly onGoToLine?: () => void;
}

/**
 * Static common-error hints (ux-spec §2.4 / product-spec F2-能力4). Keyed by
 * MySQL errno / PG SQLSTATE; SQLite has no codes, so match message keywords
 * instead. Codes not in the table render no suggestion row.
 */
const ERROR_SUGGESTIONS: Readonly<Record<string, string>> = {
  // MySQL errno.
  "1045": "Access denied — check the username/password and the user's allowed hosts.",
  "1049": "Unknown database — check the database name.",
  "1064": "SQL syntax error — review the statement near the reported position.",
  "1130": "Host not allowed to connect — grant access from this host in MySQL.",
  "1146": "Table does not exist — check the table name.",
  "2003": "Cannot connect to server — check host, port, and that MySQL is running.",
  "2059": "Authentication plugin mismatch — upgrade the client or fix the plugin.",
  // PostgreSQL SQLSTATE.
  "28P01": "Password authentication failed — check credentials and pg_hba.conf.",
  "42P01": "Relation does not exist — check the table/schema name.",
  "42703": "Column does not exist — check the column spelling or table structure.",
  "42601": "SQL syntax error — review the statement near the reported position.",
  "57P01": "Database server is shutting down or unavailable.",
};

const SQLITE_KEYWORD_SUGGESTIONS: Readonly<Array<{ readonly keyword: string; readonly hint: string }>> = [
  { keyword: "no such table", hint: "Table does not exist — check the table name." },
  { keyword: "no such column", hint: "Column does not exist — check the column spelling." },
  { keyword: "syntax error", hint: "SQL syntax error — review the statement." },
];

function suggestionFor(error: ParsedDatabaseError): string | null {
  if (error.code) {
    const hint = ERROR_SUGGESTIONS[error.code];
    if (hint) return hint;
  }
  if (error.source === "sqlite") {
    const lower = error.message.toLowerCase();
    for (const { keyword, hint } of SQLITE_KEYWORD_SUGGESTIONS) {
      if (lower.includes(keyword)) return hint;
    }
  }
  return null;
}

export function DatabaseResultErrorPane({
  error,
  labels,
  onRetry,
  onCopy,
  onGoToLine,
}: DatabaseResultErrorPaneProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const suggestion = suggestionFor(error);
  // Prefer the raw full server text (multi-line `LINE n:` / caret); fall back
  // to the extracted line text when no full text is available.
  const detail = error.fullText.trim() || error.lineText?.trim() || "";
  const hasDetail = detail.length > 0;

  return (
    <div
      className="m-3 select-text rounded-lg border border-destructive/30 bg-destructive/5 p-3 shadow-soft-lg"
      data-testid="database-result-error"
    >
      {/* Title row */}
      <div className="flex items-center gap-1.5">
        <CircleAlert className="size-4 shrink-0 text-destructive" />
        <span className="text-[12px] font-medium text-foreground">
          {labels.error}
        </span>
        {error.lineNumber != null && (
          <span className="ml-auto shrink-0 rounded-sm bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
            {labels.line(error.lineNumber)}
          </span>
        )}
      </div>

      {/* Compact message with error code */}
      <div className="mt-1 break-all font-mono text-[12px] text-foreground">
        {error.code ? `${error.code}: ${error.message}` : error.message}
      </div>

      {/* Static common-error hint (only when the code is known) */}
      {suggestion && (
        <div className="mt-1 flex items-start gap-1 text-[11px] text-warning">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{suggestion}</span>
        </div>
      )}

      {/* Server detail (collapsible, scrollable, selectable) */}
      {hasDetail && (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger
            className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="database-result-error-details-trigger"
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${
                detailsOpen ? "rotate-90" : ""
              }`}
            />
            {labels.details ?? "Server detail"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre
              className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] text-muted-foreground"
              data-testid="database-result-error-details"
            >
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Actions */}
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 rounded-sm px-2 text-[11px]"
          onClick={onRetry}
          disabled={!onRetry}
          data-testid="database-result-error-retry"
        >
          <RotateCw className="size-3.5" />
          {labels.retry}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 rounded-sm px-2 text-[11px]"
          onClick={onCopy}
          disabled={!onCopy}
          data-testid="database-result-error-copy"
        >
          <Copy className="size-3.5" />
          {labels.copy}
        </Button>
        {onGoToLine && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 rounded-sm px-2 text-[11px]"
            onClick={onGoToLine}
            data-testid="database-result-error-goto"
          >
            <Crosshair className="size-3.5" />
            {labels.jumpToLine}
          </Button>
        )}
      </div>
    </div>
  );
}
