/**
 * Documents module — Excel / Word files stored as canonical models in SQLite.
 * Each file is one record; clicking opens the BetterOffice editor inline.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  FileText,
  Sheet,
  Upload,
  Download,
  Search,
  Trash2,
  History,
  ChevronLeft,
} from 'lucide-react';
import {
  listDocuments,
  refreshDocuments,
  importDocument,
  exportDocument,
  saveDocument,
  listVersions,
  deleteDocument,
  type DocumentMeta,
  type DocumentKind,
  type DocumentVersion,
} from '@/lib/toolbox/documents-storage';
import { BetterEditor } from './document-better-editor';
import { useWebviewFileDrop } from '@/lib/use-webview-file-drop';

/** Maximum import size in bytes (10 MiB). */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export function ToolDocuments() {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<DocumentMeta[]>(() => listDocuments());
  const [query, setQuery] = useState('');
  const [viewing, setViewing] = useState<DocumentMeta | null>(null);
  const [editorBytes, setEditorBytes] = useState<Uint8Array | null>(null);
  const [headVersion, setHeadVersion] = useState(0);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DocumentMeta | null>(null);

  useEffect(() => {
    void refreshDocuments().then(setDocs);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.name.toLowerCase().includes(q));
  }, [docs, query]);

  /** Import raw bytes under a file name (shared by picker and drag & drop). */
  const importBytes = useCallback(
    async (name: string, bytes: Uint8Array) => {
      if (bytes.byteLength > MAX_IMPORT_BYTES) {
        toast.error(t('toolbox.documents.tooLarge'), { description: t('toolbox.documents.tooLargeDesc') });
        return;
      }
      const meta = await importDocument(name, bytes);
      setDocs((prev) => [meta, ...prev]);
      toast.success(t('toolbox.documents.imported'), { description: name });
    },
    [t],
  );

  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Excel / Word', extensions: ['xlsx', 'xls', 'docx', 'doc'] }],
      });
      if (typeof selected !== 'string' || !selected) return;
      const bytes = await readFile(selected);
      if (bytes.byteLength > MAX_IMPORT_BYTES) {
        toast.error(t('toolbox.documents.tooLarge'), { description: t('toolbox.documents.tooLargeDesc') });
        return;
      }
      const name = selected.split(/[\\/]/).pop() || selected;
      await importBytes(name, bytes);
    } catch (error) {
      toast.error(t('toolbox.documents.importFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [importBytes, t]);

  /** Export a document to a real file on disk via the OS save dialog. */
  const handleDownload = useCallback(
    async (doc: DocumentMeta) => {
      try {
        const target = await save({
          defaultPath: doc.name,
          filters: [
            {
              name: doc.kind === 'xlsx' ? 'Excel Workbook' : 'Word Document',
              extensions: [doc.kind],
            },
          ],
        });
        if (typeof target !== 'string' || !target) return;
        const bytes = await exportDocument(doc.id);
        await writeFile(target, bytes);
        toast.success(t('toolbox.documents.downloaded'), { description: doc.name });
      } catch (error) {
        toast.error(t('toolbox.documents.downloadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [t],
  );

  /** Drag & drop — OS-native via the Tauri webview singleton (returns paths). */
  const listRef = React.useRef<HTMLDivElement>(null);
  const { isDragOver: osDragOver } = useWebviewFileDrop({
    enabled: !viewing,
    targetRef: listRef,
    priority: 2,
    onDrop: async (paths) => {
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() || path;
        const lower = name.toLowerCase();
        const ok = lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.docx') || lower.endsWith('.doc');
        if (!ok) continue;
        try {
          const bytes = await readFile(path);
          await importBytes(name, bytes);
        } catch (error) {
          toast.error(t('toolbox.documents.importFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  });

  const handleOpen = useCallback(async (doc: DocumentMeta) => {
    setViewing(doc);
    setEditorBytes(null);
    setHeadVersion(doc.headVersion);
    try {
      const bytes = await exportDocument(doc.id);
      setEditorBytes(bytes);
      setVersions(await listVersions(doc.id));
    } catch (error) {
      toast.error(t('toolbox.documents.openFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      setViewing(null);
    }
  }, [t]);

  const handleEditorSave = useCallback(
    async (bytes: Uint8Array) => {
      if (!viewing) return;
      try {
        const next = await saveDocument(viewing.id, headVersion, viewing.name, bytes);
        setHeadVersion(next);
        setDocs((prev) => prev.map((d) => (d.id === viewing.id ? { ...d, headVersion: next } : d)));
        setVersions(await listVersions(viewing.id));
        toast.success(t('toolbox.documents.saved'));
      } catch (error) {
        toast.error(t('toolbox.documents.saveFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [viewing, headVersion, t],
  );

  const handleRestore = useCallback(
    async (version: number) => {
      if (!viewing) return;
      try {
        const bytes = await exportDocument(viewing.id, version);
        setEditorBytes(bytes);
        setHeadVersion(version);
        toast.success(t('toolbox.documents.restored'));
      } catch (error) {
        toast.error(t('toolbox.documents.restoreFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [viewing, t],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteDocument(deleteTarget.id);
      setDocs((prev) => prev.filter((d) => d.id !== deleteTarget.id));
      toast.success(t('toolbox.documents.deleted'), { description: deleteTarget.name });
    } catch (error) {
      toast.error(t('toolbox.documents.deleteFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setDeleteTarget(null);
  }, [deleteTarget, t]);

  const kindIcon = (kind: DocumentKind) =>
    kind === 'xlsx' ? (
      <Sheet className="h-5 w-5 text-green-600" />
    ) : (
      <FileText className="h-5 w-5 text-blue-600" />
    );

  return (
    <div
      ref={listRef}
      className="h-full relative flex flex-col bg-background"
    >
      {viewing && (
        /* ── Full-screen editor view ── */
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border shrink-0">
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => { setViewing(null); setEditorBytes(null); }}>
              <ChevronLeft className="h-3.5 w-3.5" />
              {t('common.back')}
            </Button>
            {kindIcon(viewing.kind)}
            <span className="text-sm font-medium text-foreground truncate">{viewing.name}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">{t('toolbox.documents.v', { n: headVersion })}</span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                title={t('toolbox.documents.download')}
                onClick={() => void handleDownload(viewing)}
              >
                <Download className="h-4 w-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                    title={t('toolbox.documents.history')}
                  >
                    <History className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto min-w-[180px]">
                  <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                    {t('toolbox.documents.history')}
                  </DropdownMenuItem>
                  {versions.map((v) => (
                    <DropdownMenuItem key={v.version} onClick={() => void handleRestore(v.version)} className="justify-between">
                      <span className="text-xs">{t('toolbox.documents.versionLabel', { n: v.version })}</span>
                      {v.version === headVersion && <span className="text-[10px] text-primary">✓</span>}
                    </DropdownMenuItem>
                  ))}
                  {versions.length === 0 && (
                    <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                      {t('toolbox.documents.noVersions')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {editorBytes ? (
              <BetterEditor
                kind={viewing.kind}
                bytes={editorBytes}
                onSave={(bytes) => void handleEditorSave(bytes)}
                onError={(e) => toast.error(t('toolbox.documents.openFailed'), { description: e.message })}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                正在加载…
              </div>
            )}
          </div>
        </div>
      )}

      {!viewing && (
      <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            {t('toolbox.documents.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('toolbox.documents.description')}</p>
        </div>
        <Button size="sm" onClick={() => void handleImport()} className="gap-1.5">
          <Upload className="h-3.5 w-3.5" />
          {t('toolbox.documents.import')}
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('toolbox.documents.searchPlaceholder')}
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1 min-h-0">
        {filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-10 text-center">
            <div className="p-3 rounded-full bg-primary/10 text-primary">
              <FileText className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-foreground">{t('toolbox.documents.empty')}</p>
            <p className="text-xs text-muted-foreground max-w-sm">{t('toolbox.documents.emptyDesc')}</p>
            <p className="text-[11px] text-muted-foreground/70">{t('toolbox.documents.dropHint')}</p>
            <Button size="sm" onClick={() => void handleImport()} className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              {t('toolbox.documents.importFirst')}
            </Button>
          </div>
        ) : (
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filtered.map((doc) => (
              <div
                key={doc.id}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 cursor-pointer transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5"
                onClick={() => void handleOpen(doc)}
                title={t('toolbox.documents.open')}
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted/60 border border-border">
                  {kindIcon(doc.kind)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{doc.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className={cnBadge(doc.kind)}>{doc.kind.toUpperCase()}</span>
                    <span className="text-[11px] text-muted-foreground">{formatSize(doc.size)}</span>
                    {doc.headVersion > 1 && (
                      <span className="text-[10px] text-amber-500">{t('toolbox.documents.v', { n: doc.headVersion })}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent"
                    onClick={(e) => { e.stopPropagation(); void handleDownload(doc); }}
                    aria-label={t('toolbox.documents.download')}
                    title={t('toolbox.documents.download')}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(doc); }}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Drag & drop overlay */}
      {osDragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-card/80 px-8 py-6 text-center">
            <Upload className="h-8 w-8 text-primary" />
            <p className="text-sm font-medium text-foreground">{t('toolbox.documents.dropActive')}</p>
            <p className="text-xs text-muted-foreground">.xlsx · .xls · .docx · .doc</p>
          </div>
        </div>
      )}

      </>
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.documents.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.documents.deleteDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function cnBadge(kind: DocumentKind): string {
  const base = 'rounded px-1.5 py-0.5 text-[10px] font-medium border';
  if (kind === 'xlsx') return `${base} bg-green-500/10 text-green-600 border-green-500/20`;
  return `${base} bg-blue-500/10 text-blue-600 border-blue-500/20`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
