/**
 * Manager dialog for user-authored log source commands.
 *
 * Commands are persisted per saved-connection in `log_custom_sources`
 * (see `src/lib/log-sources-storage.ts`). They execute on the server as the
 * connection's login user — the dialog states this explicitly; no command
 * validation/whitelist is applied by design (a whitelist would defeat the
 * point of custom commands).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Pencil, Plus, Terminal, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  createCustomLogSource,
  listCustomLogSourcesForConnection,
  moveCustomLogSource,
  removeCustomLogSource,
  upsertCustomLogSource,
  type CustomLogSource,
} from "@/lib/log-sources-storage";

export function LogCommandManager({
  open,
  onOpenChange,
  connectionId,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  /** Notify the parent to re-merge the sources list. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<CustomLogSource[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!connectionId) {
      setItems([]);
      return;
    }
    try {
      setItems(await listCustomLogSourcesForConnection(connectionId));
    } catch (err) {
      toast.error(t('logMonitor.failedToLoadLog'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [connectionId, t]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setName("");
    setCommand("");
  }, []);

  useEffect(() => {
    if (open) {
      void reload();
      // Reopening starts from a blank form — leftover editing state from the
      // previous session must not leak into the fields.
      resetForm();
    }
  }, [open, reload, resetForm]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName || !trimmedCommand || !connectionId) return;
    setBusy(true);
    try {
      if (editingId) {
        const existing = items.find((item) => item.id === editingId);
        if (existing) {
          await upsertCustomLogSource({
            ...existing,
            name: trimmedName,
            command: trimmedCommand,
            updatedAt: Date.now(),
          });
        }
      } else {
        await createCustomLogSource({ connectionId, name: trimmedName, command: trimmedCommand });
      }
      resetForm();
      await reload();
      onChanged();
      toast.success(t('logMonitor.cmdAdd'));
    } catch (err) {
      toast.error(t('logMonitor.unknownError'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [command, connectionId, editingId, items, name, onChanged, reload, resetForm, t]);

  const handleDelete = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await removeCustomLogSource(id);
      setDeleteTarget(null);
      if (editingId === id) resetForm();
      await reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [editingId, onChanged, reload, resetForm]);

  const handleMove = useCallback(async (id: string, direction: 'up' | 'down') => {
    await moveCustomLogSource(id, direction);
    await reload();
    onChanged();
  }, [onChanged, reload]);

  const canSave = name.trim() !== '' && command.trim() !== '';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 flex max-h-[80vh] !w-[calc(100vw-2rem)] !max-w-none flex-col gap-0 overflow-hidden p-0 sm:!max-w-lg">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-3.5">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Terminal className="h-4 w-4" />
              {t('logMonitor.manageCommands')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t('logMonitor.commandRunsAs')}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {/* Existing commands */}
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2 text-center">
                {t('logMonitor.cmdEmpty')}
              </p>
            ) : (
              <div className="space-y-1.5">
                {items.map((item, index) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{item.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground" title={item.command}>
                        {item.command}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        size="icon" variant="ghost" className="h-6 w-6"
                        disabled={index === 0 || busy}
                        onClick={() => void handleMove(item.id, 'up')}
                        title={t('logMonitor.cmdMoveUp')}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-6 w-6"
                        disabled={index === items.length - 1 || busy}
                        onClick={() => void handleMove(item.id, 'down')}
                        title={t('logMonitor.cmdMoveDown')}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-6 w-6"
                        onClick={() => {
                          setEditingId(item.id);
                          setName(item.name);
                          setCommand(item.command);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => setDeleteTarget(item.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Create / edit form */}
            <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3">
              <div className="space-y-1">
                <Label htmlFor="log-cmd-name" className="text-xs">{t('logMonitor.cmdName')}</Label>
                <Input
                  id="log-cmd-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('logMonitor.cmdNamePlaceholder')}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="log-cmd-command" className="text-xs">{t('logMonitor.cmdCommand')}</Label>
                <Input
                  id="log-cmd-command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder={t('logMonitor.cmdCommandPlaceholder')}
                  className="h-7 font-mono text-xs"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">{t('logMonitor.commandRunsAs')}</p>
                <div className="flex gap-1.5">
                  {editingId && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={resetForm}>
                      {t('common.cancel')}
                    </Button>
                  )}
                  <Button size="sm" className="h-7 text-xs gap-1" disabled={!canSave || busy} onClick={() => void handleSave()}>
                    <Plus className="h-3 w-3" />
                    {t('logMonitor.cmdAdd')}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t border-border px-5 py-2.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onOpenChange(false)}>
              {t('logMonitor.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteTarget !== null} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
        <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !max-w-sm p-0">
          <DialogHeader className="px-5 pt-4 pb-2">
            <DialogTitle className="text-sm">{t('logMonitor.cmdDeleteTitle')}</DialogTitle>
            <DialogDescription className="text-xs">{t('logMonitor.cmdDeleteDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="px-5 pb-4 gap-2">
            <Button size="sm" variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => deleteTarget && void handleDelete(deleteTarget)}>
              {t('logMonitor.cmdDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
