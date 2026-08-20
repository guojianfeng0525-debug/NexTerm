/**
 * Command execution history — a browsable record of every command that was
 * run (execution result is intentionally not tracked). Useful for recalling
 * rarely-used commands you typed once and forgot. Backed by the same encrypted
 * command_history store the suggestion engine learns from.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  getCommandHistory,
  setCommandData,
  type CommandHistoryEntry,
} from '@/lib/command-history';
import { History, Search, Trash2, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

function formatTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export function ToolCommandHistory() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CommandHistoryEntry[]>(() => getCommandHistory());
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  // Refresh when the terminal emits new commands (the store is updated in
  // memory synchronously, so focus / a change event / manual refresh all work).
  const refresh = useCallback(() => {
    setEntries(getCommandHistory());
  }, []);
  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener('focus', onChanged);
    window.addEventListener('nexterm:command-history-changed', onChanged);
    return () => {
      window.removeEventListener('focus', onChanged);
      window.removeEventListener('nexterm:command-history-changed', onChanged);
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? entries.filter((e) => e.c.toLowerCase().includes(q))
      : entries;
    // Most recently used first.
    return [...list].sort((a, b) => b.t - a.t);
  }, [entries, query]);

  const handleClear = useCallback(() => {
    try {
      setCommandData({}, []);
      setEntries([]);
      setConfirmClear(false);
      toast.success(t('toolbox.history.cleared'));
    } catch {
      toast.error(t('toolbox.history.clearFailed'));
    }
  }, [t]);

  const copyCommand = useCallback(async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      toast.success(t('toolbox.history.copied'));
    } catch {
      /* clipboard unavailable */
    }
  }, [t]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium">{t('toolbox.history.title')}</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('toolbox.history.searchPlaceholder')}
              className="h-8 pl-7 text-xs w-52"
            />
          </div>
          <Button variant="outline" size="sm" onClick={refresh} className="h-8 text-xs">
            {t('toolbox.history.refresh')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-destructive hover:text-destructive"
            onClick={() => setConfirmClear(true)}
            disabled={entries.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            {t('toolbox.history.clear')}
          </Button>
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center p-8">
            <History className="h-6 w-6 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {query ? t('toolbox.history.noMatch') : t('toolbox.history.empty')}
            </p>
            {!query && (
              <p className="text-xs text-muted-foreground/70 max-w-xs">
                {t('toolbox.history.emptyDesc')}
              </p>
            )}
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {filtered.slice(0, 500).map((e) => (
              <div
                key={e.c + e.t}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
              >
                <span className="text-[10px] text-muted-foreground shrink-0 w-24 text-right tabular-nums">
                  {formatTime(e.t)}
                </span>
                <span className="font-mono text-xs truncate flex-1 min-w-0">{e.c}</span>
                <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                  ×{e.n}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground')}
                  onClick={() => void copyCommand(e.c)}
                  title={t('toolbox.history.copy')}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            ))}
            {filtered.length > 500 && (
              <p className="text-[11px] text-muted-foreground text-center py-2">
                {t('toolbox.history.truncated', { count: filtered.length })}
              </p>
            )}
          </div>
        )}
      </ScrollArea>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.history.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.history.clearDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleClear} className="bg-destructive text-destructive-foreground">
              {t('toolbox.history.clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
