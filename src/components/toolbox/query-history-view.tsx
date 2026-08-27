/**
 * DB-domain query history view (feature-design §5 / ux-spec §4.5).
 *
 * A VS Code-panel style in-pane view (NOT a dialog): the toolbar "History"
 * toggle swaps the result area between the grid and this list. Entries are
 * filtered to the current connection; each row has a success/error dot,
 * timestamp, mono SQL summary, a hover "run again" button and a context menu
 * (run / insert into editor / copy / remove) plus an AlertDialog-confirmed
 * clear-all in the header. Keyboard: ↑/↓ move, Enter re-runs, Esc closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Copy, FileInput, Inbox, Play, Trash2 } from "lucide-react";
import {
  clearQueryHistory,
  loadQueryHistory,
  QUERY_HISTORY_CHANGED_EVENT,
  removeQueryHistory,
  type QueryHistoryEntry,
} from "@/lib/database/query-history";

export type QueryHistoryProviderId = "postgresql" | "mysql" | "sqlite";

export interface QueryHistoryViewLabels {
  readonly history: string;
  readonly empty: string;
  readonly run: string;
  readonly insertToEditor: string;
  readonly copy: string;
  readonly remove: string;
  readonly clear: string;
  /** Tooltip label for the full execution timestamp. */
  readonly time: string;
  /** Tooltip label for a failed history entry (ux-spec §4.5: "执行失败"). */
  readonly error?: string;
  readonly clearConfirmTitle: string;
  readonly clearConfirmDescription: string;
  readonly cancel?: string;
}

export interface QueryHistoryViewProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerId: QueryHistoryProviderId;
  /** Entries are filtered to this connection; empty means "show all". */
  readonly connectionId: string;
  readonly labels: QueryHistoryViewLabels;
}

/** First non-empty line, truncated to 96 chars with an ellipsis (ux-spec §4.5). */
function summarizeSql(sql: string): string {
  const firstLine = sql.split("\n").find((line) => line.trim().length > 0);
  const text = (firstLine ?? "").trim();
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

/** HH:mm:ss for today, MM-DD HH:mm across days (ux-spec §4.5). */
function formatTime(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const pad = (x: number) => String(x).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === n.toDateString()) return clock;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock.slice(0, 5)}`;
}

export function QueryHistoryView({
  open,
  onOpenChange,
  providerId,
  connectionId,
  labels,
}: QueryHistoryViewProps) {
  const [entries, setEntries] = useState<readonly QueryHistoryEntry[]>(() =>
    loadQueryHistory(providerId),
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Refresh when history changes for this provider (same-listener pattern as
  // tool-command-history; the event carries the providerId it belongs to).
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ providerId?: string }>).detail;
      if (detail?.providerId && detail.providerId !== providerId) return;
      setEntries(loadQueryHistory(providerId));
    };
    window.addEventListener(QUERY_HISTORY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(QUERY_HISTORY_CHANGED_EVENT, refresh);
  }, [providerId]);

  // When the panel opens, reset selection and re-read storage.
  useEffect(() => {
    if (open) {
      setSelected(null);
      setEntries(loadQueryHistory(providerId));
    }
  }, [open, providerId]);

  // Esc closes the panel no matter where the focus is.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const filtered = useMemo(
    () =>
      connectionId
        ? entries.filter((entry) => entry.connectionId === connectionId)
        : entries,
    [entries, connectionId],
  );

  // Keep the selected index valid if the list shrank while something was
  // selected (removal / clear-all / connection switch).
  useEffect(() => {
    setSelected((current) =>
      current == null || current < filtered.length ? current : null,
    );
  }, [filtered.length]);

  const dispatchExecute = useCallback(
    (sql: string) => {
      window.dispatchEvent(
        new CustomEvent("nexterm:db-query-history-execute", {
          detail: { providerId, sql, connectionId },
        }),
      );
    },
    [providerId, connectionId],
  );

  const dispatchInsert = useCallback(
    (sql: string) => {
      window.dispatchEvent(
        new CustomEvent("nexterm:db-query-history-insert", {
          detail: { providerId, sql },
        }),
      );
    },
    [providerId],
  );

  const copySql = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const handleClear = useCallback(() => {
    clearQueryHistory(providerId);
    setConfirmClear(false);
  }, [providerId]);

  const handleRowKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      setSelected((current) => {
        const base = current ?? (event.key === "ArrowDown" ? -1 : 0);
        const next =
          event.key === "ArrowDown"
            ? Math.min(base + 1, filtered.length - 1)
            : Math.max(base - 1, 0);
        return next;
      });
    } else if (event.key === "Enter" && selected != null) {
      const entry = filtered[selected];
      if (entry) {
        event.preventDefault();
        dispatchExecute(entry.sql);
      }
    }
  };

  if (!open) return null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="query-history-view">
      {/* Header (same h-7 language as the result pane) */}
      <div className="flex h-7 shrink-0 items-center border-b bg-muted/20 px-2 text-[11px]">
        <span className="border-r pr-3 font-medium">{labels.history}</span>
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 rounded-sm px-2 text-[11px] text-destructive hover:text-destructive"
            onClick={() => setConfirmClear(true)}
            disabled={filtered.length === 0}
            data-testid="query-history-clear"
          >
            <Trash2 className="size-3.5" />
            {labels.clear}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="flex h-24 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Inbox className="size-5" />
            <span className="text-[12px]">{labels.empty}</span>
          </div>
        ) : (
          <div
            ref={listRef}
            tabIndex={0}
            className="flex flex-col gap-px p-1 outline-none"
            onKeyDown={handleRowKeyDown}
            data-testid="query-history-list"
          >
            {filtered.map((entry, index) => (
              <ContextMenu key={entry.id}>
                <ContextMenuTrigger asChild>
                  <div
                    data-testid={`query-history-item-${index}`}
                    className={`group flex h-7 cursor-pointer items-center gap-2 rounded-sm px-2 text-[12px] hover:bg-accent/60 ${
                      selected === index ? "bg-primary/10 text-primary" : ""
                    }`}
                    onClick={() => listRef.current?.focus()}
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        entry.success ? "bg-emerald-500" : "bg-red-500"
                      }`}
                      title={entry.success ? undefined : (labels.error ?? labels.run)}
                    />
                    <span
                      className="w-16 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums"
                      title={`${labels.time}: ${new Date(entry.executedAt).toLocaleString()}`}
                    >
                      {formatTime(entry.executedAt, Date.now())}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={entry.sql}>
                      {summarizeSql(entry.sql)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        dispatchExecute(entry.sql);
                      }}
                      title={labels.run}
                      data-testid={`query-history-run-${index}`}
                    >
                      <Play className="size-3.5" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent data-testid="query-history-context-menu">
                  <ContextMenuItem
                    onSelect={() => dispatchExecute(entry.sql)}
                    data-testid="query-history-menu-run"
                  >
                    <Play className="size-3.5" />
                    {labels.run}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => dispatchInsert(entry.sql)}
                    data-testid="query-history-menu-insert"
                  >
                    <FileInput className="size-3.5" />
                    {labels.insertToEditor}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => void copySql(entry.sql)}
                    data-testid="query-history-menu-copy"
                  >
                    <Copy className="size-3.5" />
                    {labels.copy}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => removeQueryHistory(providerId, entry.id)}
                    data-testid="query-history-menu-remove"
                  >
                    <Trash2 className="size-3.5" />
                    {labels.remove}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        )}
      </ScrollArea>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.clearConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {labels.clearConfirmDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{labels.cancel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClear}
              className="bg-destructive text-destructive-foreground"
              data-testid="query-history-clear-confirm"
            >
              {labels.clear}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
