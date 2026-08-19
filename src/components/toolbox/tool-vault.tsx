import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PasswordInput } from '@/components/ui/password-input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { getAppLockKey } from '@/lib/toolbox/app-lock';
import { parseVaultExcel, buildVaultExcel, buildVaultTemplate, type VaultExcelRow } from '@/lib/toolbox/vault-excel';
import {
  loadRecords,
  addRecord,
  updateRecord,
  deleteRecord,
  type VaultEntry,
} from '@/lib/toolbox/records-storage';
import type { VaultRecord } from '@/lib/toolbox/toolbox-types';
import {
  KeyRound,
  Plus,
  Search,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  MoreVertical,
  ShieldCheck,
  Star,
  StarOff,
  Download,
  Upload,
} from 'lucide-react';

interface RecordFormState {
  name: string;
  address: string;
  username: string;
  password: string;
  category: string;
  notes: string;
}

const EMPTY_RECORD_FORM: RecordFormState = {
  name: '',
  address: '',
  username: '',
  password: '',
  category: '',
  notes: '',
};

/**
 * Records notebook. Records are encrypted with the app password key
 * (AES-256-GCM); there is no separate vault password — unlocking the app is
 * the only gate.
 */
export function ToolVault() {
  const { t } = useTranslation();
  const key = getAppLockKey();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Record form
  const [formOpen, setFormOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<VaultEntry | null>(null);
  const [form, setForm] = useState<RecordFormState>({ ...EMPTY_RECORD_FORM });
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<VaultEntry | null>(null);

  // Load records with the app-password key.
  useEffect(() => {
    if (!key) return;
    setLoading(true);
    void loadRecords(key)
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [key]);

  const openAdd = useCallback(() => {
    setEditingEntry(null);
    setForm({ ...EMPTY_RECORD_FORM });
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((entry: VaultEntry) => {
    setEditingEntry(entry);
    setForm({
      name: entry.record.name,
      address: entry.record.address,
      username: entry.record.username,
      password: entry.record.password,
      category: entry.record.category ?? '',
      notes: entry.record.notes ?? '',
    });
    setFormOpen(true);
  }, []);

  const handleSaveRecord = useCallback(async () => {
    if (!key) return;
    if (!form.name.trim()) {
      toast.error(t('toolbox.vault.nameRequired'));
      return;
    }
    const record: VaultRecord = {
      id: editingEntry?.record.id ?? '',
      name: form.name.trim(),
      address: form.address.trim(),
      username: form.username.trim(),
      password: form.password,
      category: form.category.trim() || undefined,
      notes: form.notes.trim() || undefined,
      favorite: editingEntry?.record.favorite ?? false,
      createdAt: editingEntry?.record.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    try {
      if (editingEntry) {
        setEntries(await updateRecord(key, editingEntry.id, record));
        toast.success(t('toolbox.vault.recordUpdated'));
      } else {
        await addRecord(key, record);
        setEntries(await loadRecords(key));
        toast.success(t('toolbox.vault.recordAdded'));
      }
      setFormOpen(false);
    } catch (error) {
      toast.error(t('toolbox.vault.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [key, form, editingEntry, t]);

  /** Download the designated Excel import template. */
  const handleDownloadTemplate = useCallback(async () => {
    try {
      const path = await saveDialog({
        defaultPath: 'nexterm-vault-template.xlsx',
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });
      if (!path) return;
      await writeFile(path, await buildVaultTemplate());
      toast.success(t('toolbox.vault.templateDownloaded'));
    } catch (error) {
      toast.error(t('toolbox.vault.exportFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [t]);

  /** Export all records to an Excel (.xlsx) file. */
  const handleExport = useCallback(async () => {
    if (!key) return;
    try {
      const entries = await loadRecords(key);
      const rows: VaultExcelRow[] = entries.map((e) => ({
        name: e.record.name,
        address: e.record.address,
        username: e.record.username,
        password: e.record.password,
        category: e.record.category ?? '',
        notes: e.record.notes ?? '',
        favorite: e.record.favorite ?? false,
      }));
      const path = await saveDialog({
        defaultPath: 'nexterm-vault.xlsx',
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });
      if (!path) return;
      await writeFile(path, await buildVaultExcel(rows));
      toast.success(t('toolbox.vault.exported'), {
        description: t('toolbox.vault.exportedDesc', { count: entries.length }),
      });
    } catch (error) {
      toast.error(t('toolbox.vault.exportFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [key, t]);

  /** Import records from the designated Excel template (rejects others). */
  const handleImport = useCallback(async () => {
    if (!key) return;
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      });
      if (typeof path !== 'string' || !path) return;

      const bytes = await readFile(path);
      let rows: VaultExcelRow[];
      try {
        rows = await parseVaultExcel(bytes);
      } catch (parseError) {
        toast.error(t('toolbox.vault.importInvalid'), {
          description: parseError instanceof Error ? parseError.message : String(parseError),
        });
        return;
      }

      const current = await loadRecords(key);
      const existingNames = new Set(current.map((e) => e.record.name));
      let added = 0;
      let skipped = 0;
      for (const row of rows) {
        if (existingNames.has(row.name)) { skipped++; continue; }
        await addRecord(key, {
          name: row.name,
          address: row.address,
          username: row.username,
          password: row.password,
          category: row.category || undefined,
          notes: row.notes || undefined,
          favorite: row.favorite,
        });
        existingNames.add(row.name);
        added++;
      }
      setEntries(await loadRecords(key));
      if (added === 0) {
        toast.info(t('toolbox.vault.importNoNew'), {
          description: skipped > 0 ? t('toolbox.vault.importSkipped', { count: skipped }) : undefined,
        });
      } else {
        toast.success(t('toolbox.vault.imported', { count: added }), {
          description: skipped > 0 ? t('toolbox.vault.importSkipped', { count: skipped }) : undefined,
        });
      }
    } catch (error) {
      toast.error(t('toolbox.vault.importFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [key, t]);

  const handleDeleteRecord = useCallback(async () => {
    if (!key || !deleteTarget) return;
    try {
      setEntries(await deleteRecord(key, deleteTarget.id));
      toast.success(t('toolbox.vault.recordDeleted'));
      setDeleteTarget(null);
    } catch (error) {
      toast.error(t('toolbox.vault.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [key, deleteTarget, t]);

  const handleToggleFavorite = useCallback(
    async (entry: VaultEntry) => {
      if (!key) return;
      try {
        setEntries(await updateRecord(key, entry.id, { favorite: !entry.record.favorite }));
      } catch (error) {
        toast.error(t('toolbox.vault.saveFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [key, t],
  );

  const copyText = useCallback(
    async (text: string, label: string) => {
      try {
        await writeText(text);
        toast.success(t('toolbox.vault.copied'), { description: label });
      } catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          toast.success(t('toolbox.vault.copied'), { description: label });
        } catch {
          toast.error(t('toolbox.vault.copyFailed'));
        }
      }
    },
    [t],
  );

  const toggleReveal = useCallback((id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.record.name, e.record.address, e.record.username, e.record.category ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [entries, search]);

  const favorites = useMemo(() => filteredEntries.filter((e) => e.record.favorite), [filteredEntries]);
  const others = useMemo(() => filteredEntries.filter((e) => !e.record.favorite), [filteredEntries]);

  if (!key) {
    // Should never happen after the app lock is verified; guard for safety.
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-8 text-center">
        {t('toolbox.vault.unlockRequired')}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            {t('toolbox.vault.title')}
            <Badge variant="outline" className="text-[10px] text-success border-success/30 bg-success/10 gap-1">
              <ShieldCheck className="h-3 w-3" />
              {t('toolbox.vault.encrypted')}
            </Badge>
          </h3>
          <p className="text-xs text-muted-foreground truncate">{t('toolbox.vault.description')}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="outline" onClick={() => void handleDownloadTemplate()} title={t('toolbox.vault.template')} className="gap-1">
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('toolbox.vault.template')}</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleImport()} title={t('toolbox.vault.import')} className="gap-1">
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('toolbox.vault.import')}</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleExport()} title={t('toolbox.vault.export')} className="gap-1">
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('toolbox.vault.export')}</span>
          </Button>
          <Button size="sm" onClick={openAdd} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('toolbox.vault.add')}
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-border shrink-0">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('toolbox.vault.searchPlaceholder')}
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      {/* Records */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {loading ? (
            <p className="text-xs text-muted-foreground text-center py-10">{t('common.loading')}</p>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border p-10 text-center">
              <div className="p-3 rounded-full bg-primary/10 text-primary">
                <KeyRound className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('toolbox.vault.empty')}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('toolbox.vault.emptyDesc')}</p>
              </div>
              <Button size="sm" onClick={openAdd} className="gap-1.5">
                <Plus className="h-4 w-4" />
                {t('toolbox.vault.addFirst')}
              </Button>
            </div>
          ) : (
            <>
              {favorites.length > 0 && (
                <div className="space-y-2">
                  <h5 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Star className="h-3 w-3" /> {t('toolbox.vault.favorites')}
                  </h5>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {favorites.map((entry) => (
                      <RecordCard
                        key={entry.id}
                        entry={entry}
                        revealed={revealedIds.has(entry.id)}
                        onReveal={() => toggleReveal(entry.id)}
                        onCopy={copyText}
                        onEdit={() => openEdit(entry)}
                        onDelete={() => setDeleteTarget(entry)}
                        onToggleFavorite={() => void handleToggleFavorite(entry)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {others.length > 0 && (
                <div className="space-y-2">
                  <h5 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <KeyRound className="h-3 w-3" /> {t('toolbox.vault.allRecords')}
                  </h5>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {others.map((entry) => (
                      <RecordCard
                        key={entry.id}
                        entry={entry}
                        revealed={revealedIds.has(entry.id)}
                        onReveal={() => toggleReveal(entry.id)}
                        onCopy={copyText}
                        onEdit={() => openEdit(entry)}
                        onDelete={() => setDeleteTarget(entry)}
                        onToggleFavorite={() => void handleToggleFavorite(entry)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {filteredEntries.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-8">
                  {t('toolbox.vault.noMatches')}
                </p>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Record form */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingEntry ? t('toolbox.vault.editRecord') : t('toolbox.vault.addRecord')}
            </DialogTitle>
            <DialogDescription>{t('toolbox.vault.recordFormDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rec-name">{t('toolbox.vault.name')}</Label>
                <Input
                  id="rec-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('toolbox.vault.namePlaceholder')}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rec-category">{t('toolbox.vault.category')}</Label>
                <Input
                  id="rec-category"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  placeholder={t('toolbox.vault.categoryPlaceholder')}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-address">{t('toolbox.vault.address')}</Label>
              <Input
                id="rec-address"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder={t('toolbox.vault.addressPlaceholder')}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rec-username">{t('toolbox.vault.username')}</Label>
                <Input
                  id="rec-username"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder={t('toolbox.vault.usernamePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rec-password">{t('toolbox.vault.password')}</Label>
                <PasswordInput
                  id="rec-password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-notes">{t('toolbox.vault.notes')}</Label>
              <Textarea
                id="rec-notes"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder={t('toolbox.vault.notesPlaceholder')}
                className="min-h-[60px] resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSaveRecord()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete record */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.vault.deleteRecordTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.vault.deleteRecordDesc', { name: deleteTarget?.record.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDeleteRecord()}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── Record card ──────────────────────────────────────────────────────────── */

interface RecordCardProps {
  entry: VaultEntry;
  revealed: boolean;
  onReveal: () => void;
  onCopy: (text: string, label: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
}

function RecordCard({
  entry,
  revealed,
  onReveal,
  onCopy,
  onEdit,
  onDelete,
  onToggleFavorite,
}: RecordCardProps) {
  const { t } = useTranslation();
  const record = entry.record;
  const hasUsername = record.username.length > 0;
  const hasPassword = record.password.length > 0;

  return (
    <div className="group rounded-xl border border-border bg-card p-4 space-y-3 transition-all hover:shadow-md hover:border-primary/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            <KeyRound className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
              {record.name}
              {record.favorite && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
            </h4>
            {record.address && (
              <p className="text-[11px] text-muted-foreground font-mono truncate">{record.address}</p>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground transition-opacity"
              aria-label={t('common.more')}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[150px]">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 h-4 w-4" />
              {t('common.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggleFavorite}>
              {record.favorite ? (
                <StarOff className="mr-2 h-4 w-4" />
              ) : (
                <Star className="mr-2 h-4 w-4" />
              )}
              {record.favorite ? t('toolbox.vault.unfavorite') : t('toolbox.vault.favorite')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {record.category && (
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            {record.category}
          </Badge>
        </div>
      )}

      <div className="space-y-1.5 text-xs">
        {hasUsername && (
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-muted-foreground">{t('toolbox.vault.username')}</span>
            <span className="font-mono flex-1 min-w-0 truncate text-foreground">{record.username}</span>
            <button
              type="button"
              onClick={() => onCopy(record.username, record.name)}
              className="text-muted-foreground hover:text-foreground shrink-0"
              title={t('toolbox.vault.copyUsername')}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {hasPassword && (
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-muted-foreground">{t('toolbox.vault.password')}</span>
            <span className="font-mono flex-1 min-w-0 truncate text-foreground">
              {revealed ? record.password : '••••••••••••'}
            </span>
            <button
              type="button"
              onClick={onReveal}
              className="text-muted-foreground hover:text-foreground shrink-0"
              title={revealed ? t('toolbox.vault.hide') : t('toolbox.vault.show')}
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => onCopy(record.password, record.name)}
              className="text-muted-foreground hover:text-foreground shrink-0"
              title={t('toolbox.vault.copyPassword')}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {record.notes && (
        <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{record.notes}</p>
      )}
    </div>
  );
}
