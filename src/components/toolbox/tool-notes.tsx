import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
const CodeEditor = lazy(() => import('@/components/code-editor').then((m) => ({ default: m.CodeEditor })));
import { NotesStorage, generateId } from '@/lib/toolbox/toolbox-storage';
import type { NoteItem, NoteLanguage } from '@/lib/toolbox/toolbox-types';
import { StickyNote, Plus, Search, Trash2, Copy, Pin, PinOff, FileCode2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type NoteLangLabelKey =
  | 'toolbox.notes.lang.plain'
  | 'toolbox.notes.lang.sql'
  | 'toolbox.notes.lang.shell'
  | 'toolbox.notes.lang.cmd'
  | 'toolbox.notes.lang.powershell'
  | 'toolbox.notes.lang.json'
  | 'toolbox.notes.lang.javascript'
  | 'toolbox.notes.lang.typescript'
  | 'toolbox.notes.lang.python'
  | 'toolbox.notes.lang.markdown'
  | 'toolbox.notes.lang.yaml'
  | 'toolbox.notes.lang.xml'
  | 'toolbox.notes.lang.html'
  | 'toolbox.notes.lang.css'
  | 'toolbox.notes.lang.rust'
  | 'toolbox.notes.lang.cpp'
  | 'toolbox.notes.lang.java';

const LANGUAGE_OPTIONS: { value: NoteLanguage; labelKey: NoteLangLabelKey }[] = [
  { value: 'plain', labelKey: 'toolbox.notes.lang.plain' },
  { value: 'sql', labelKey: 'toolbox.notes.lang.sql' },
  { value: 'shell', labelKey: 'toolbox.notes.lang.shell' },
  { value: 'cmd', labelKey: 'toolbox.notes.lang.cmd' },
  { value: 'powershell', labelKey: 'toolbox.notes.lang.powershell' },
  { value: 'json', labelKey: 'toolbox.notes.lang.json' },
  { value: 'javascript', labelKey: 'toolbox.notes.lang.javascript' },
  { value: 'typescript', labelKey: 'toolbox.notes.lang.typescript' },
  { value: 'python', labelKey: 'toolbox.notes.lang.python' },
  { value: 'markdown', labelKey: 'toolbox.notes.lang.markdown' },
  { value: 'yaml', labelKey: 'toolbox.notes.lang.yaml' },
  { value: 'xml', labelKey: 'toolbox.notes.lang.xml' },
  { value: 'html', labelKey: 'toolbox.notes.lang.html' },
  { value: 'css', labelKey: 'toolbox.notes.lang.css' },
  { value: 'rust', labelKey: 'toolbox.notes.lang.rust' },
  { value: 'cpp', labelKey: 'toolbox.notes.lang.cpp' },
  { value: 'java', labelKey: 'toolbox.notes.lang.java' },
];

function formatRelativeTime(ts: number, t: TFunction<'translation', undefined>): string {
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('toolbox.notes.justNow');
  if (diff < hour) return t('toolbox.notes.minutesAgo', { count: Math.floor(diff / minute) });
  if (diff < day) return t('toolbox.notes.hoursAgo', { count: Math.floor(diff / hour) });
  if (diff < 7 * day) return t('toolbox.notes.daysAgo', { count: Math.floor(diff / day) });
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function ToolNotes() {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteItem[]>(() => NotesStorage.load());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<NoteItem | null>(null);
  const selectedRef = useRef<NoteItem | null>(null);
  selectedRef.current = notes.find((n) => n.id === selectedId) ?? null;

  const selected = selectedRef.current;

  // Debounced persistence: write to the encrypted SQLite store 500ms after
  // the last change, and flush any pending write on unmount.
  useEffect(() => {
    const timer = setTimeout(() => {
      NotesStorage.save(notes);
    }, 500);
    return () => clearTimeout(timer);
  }, [notes]);

  const notesRef = useRef<NoteItem[]>(notes);
  notesRef.current = notes;

  useEffect(() => {
    const flush = () => NotesStorage.save(notesRef.current);
    return () => flush();
  }, []);

  const patchSelected = useCallback(
    (patch: Partial<Pick<NoteItem, 'title' | 'language' | 'content' | 'pinned'>>) => {
      const id = selectedId;
      if (!id) return;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? { ...n, ...patch, updatedAt: Date.now() }
            : n,
        ),
      );
    },
    [selectedId],
  );

  const createNote = useCallback(() => {
    const now = Date.now();
    const note: NoteItem = {
      id: generateId('note'),
      title: t('toolbox.notes.untitled'),
      language: 'plain',
      content: '',
      createdAt: now,
      updatedAt: now,
    };
    setNotes((prev) => [note, ...prev]);
    setSelectedId(note.id);
    setSearch('');
  }, [t]);

  const deleteNote = useCallback(() => {
    if (!deleteTarget) return;
    setNotes((prev) => prev.filter((n) => n.id !== deleteTarget.id));
    if (selectedId === deleteTarget.id) setSelectedId(null);
    toast.success(t('toolbox.notes.deleted'), { description: deleteTarget.title });
    setDeleteTarget(null);
  }, [deleteTarget, selectedId, t]);

  const copyContent = useCallback(async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      toast.success(t('toolbox.notes.copied'));
    } catch {
      toast.error(t('toolbox.notes.copyFailed'));
    }
  }, [selected, t]);

  const togglePin = useCallback(() => {
    patchSelected({ pinned: !selected?.pinned });
  }, [patchSelected, selected?.pinned]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
      : notes;
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [notes, search]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <StickyNote className="h-4 w-4 text-primary" />
            {t('toolbox.notes.title')}
            <Badge variant="outline" className="text-[10px] gap-1 text-muted-foreground">
              <FileCode2 className="h-3 w-3" />
              {t('toolbox.notes.highlighted')}
            </Badge>
          </h3>
          <p className="text-xs text-muted-foreground truncate">{t('toolbox.notes.description')}</p>
        </div>
        <Button size="sm" onClick={createNote} className="shrink-0 gap-1.5">
          <Plus className="h-4 w-4" />
          {t('toolbox.notes.new')}
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Notes list */}
        <div className="w-60 sm:w-64 shrink-0 border-r border-border flex flex-col overflow-hidden bg-muted/20">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('toolbox.notes.searchPlaceholder')}
                className="pl-8 h-8 text-xs"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-1.5 space-y-0.5">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8 px-2">
                  {notes.length === 0 ? t('toolbox.notes.empty') : t('toolbox.notes.noMatches')}
                </p>
              ) : (
                filtered.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => setSelectedId(note.id)}
                    className={cn(
                      'w-full text-left rounded-lg px-2.5 py-2 transition-colors group',
                      selectedId === note.id
                        ? 'bg-primary/10 text-foreground'
                        : 'hover:bg-accent/60 text-foreground/90',
                    )}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {note.pinned && <Pin className="h-3 w-3 text-amber-400 shrink-0 fill-amber-400" />}
                      <span className="text-xs font-medium truncate flex-1">{note.title || t('toolbox.notes.untitled')}</span>
                      <span className="text-[9px] text-muted-foreground shrink-0">{formatRelativeTime(note.updatedAt, t)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                        {t(`toolbox.notes.lang.${note.language}` as const)}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground truncate">
                        {note.content.split('\n')[0]?.slice(0, 40) || ''}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Editor */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {selected ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
                <Input
                  value={selected.title}
                  onChange={(e) => patchSelected({ title: e.target.value })}
                  placeholder={t('toolbox.notes.titlePlaceholder')}
                  className="h-8 text-sm font-medium border-transparent bg-transparent focus-visible:bg-background flex-1 min-w-0"
                />
                <Select
                  value={selected.language}
                  onValueChange={(value) => patchSelected({ language: value as NoteLanguage })}
                >
                  <SelectTrigger className="h-8 w-[130px] text-xs shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {t(option.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={togglePin} title={selected.pinned ? t('toolbox.notes.unpin') : t('toolbox.notes.pin')}>
                  {selected.pinned ? <PinOff className="h-4 w-4 text-amber-400" /> : <Pin className="h-4 w-4" />}
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => void copyContent()} title={t('toolbox.notes.copyContent')}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(selected)} title={t('common.delete')}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex-1 min-h-0 p-2">
                <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{'...'}</div>}>
                  <CodeEditor
                    value={selected.content}
                    language={selected.language}
                    onChange={(value) => patchSelected({ content: value })}
                    className="h-full rounded-lg border-border"
                  />
                </Suspense>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
              <div className="p-3 rounded-full bg-primary/10 text-primary">
                <StickyNote className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('toolbox.notes.selectNote')}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">{t('toolbox.notes.selectNoteDesc')}</p>
              </div>
              <Button size="sm" onClick={createNote} className="gap-1.5">
                <Plus className="h-4 w-4" />
                {t('toolbox.notes.new')}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.notes.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.notes.deleteDesc', { title: deleteTarget?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={deleteNote}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
