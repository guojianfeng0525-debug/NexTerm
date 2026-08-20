import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AppsStorage, generateId } from '@/lib/toolbox/toolbox-storage';
import type { ToolboxApp } from '@/lib/toolbox/toolbox-types';
import { AppWindow, Plus, Play, Rocket, FolderOpen, MoreVertical, Pencil, Trash2, Image as ImageIcon, Wand2, X } from 'lucide-react';


/** Resolve an icon path for <img>: data URLs pass through, filesystem paths go through convertFileSrc. */
function iconSrc(path?: string): string | undefined {
  if (!path) return undefined;
  return path.startsWith('data:') ? path : convertFileSrc(path);
}

// Icons above this many characters are dropped on save (see handleSave).
const MAX_ICON_CHARS = 1024 * 1024;

const EMPTY_FORM = {
  name: '',
  path: '',
  args: '',
  cwd: '',
  icon: '',
  iconPath: '',
  category: '',
  description: '',
};

export function ToolApps() {
  const { t } = useTranslation();
  const [apps, setApps] = useState<ToolboxApp[]>(() => AppsStorage.load());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ToolboxApp | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ToolboxApp | null>(null);

  // Group apps by category (uncategorized apps are grouped under '').
  const groupedApps = useMemo(() => {
    const map = new Map<string, ToolboxApp[]>();
    for (const app of apps) {
      const cat = app.category?.trim() ?? '';
      const list = map.get(cat) ?? [];
      list.push(app);
      map.set(cat, list);
    }
    return Array.from(map.entries());
  }, [apps]);
  /** Render a single app card. */
  const renderAppCard = (app: ToolboxApp) => (
    <div
      key={app.id}
      className="group relative rounded-xl border border-border bg-card p-4 flex flex-col gap-3 transition-all hover:shadow-md hover:border-primary/40 cursor-pointer"
      onClick={() => void handleLaunch(app)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void handleLaunch(app);
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted text-lg shrink-0 overflow-hidden">
          {app.iconPath ? (
            <img src={iconSrc(app.iconPath)} alt="" className="h-full w-full object-cover" />
          ) : app.icon ? (
            <span className="text-xl">{app.icon}</span>
          ) : (
            <AppWindow className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground transition-opacity"
              onClick={(e) => e.stopPropagation()}
              aria-label={t('common.more')}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                openEdit(app);
              }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t('common.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(app);
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium text-foreground truncate">{app.name}</h4>
        {app.description ? (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {app.description}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground mt-0.5 font-mono truncate">
            {app.path}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary" className="text-[10px] font-mono max-w-[60%] truncate">
          {app.path.split(/[\\/]/).pop() || app.path}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 gap-1 text-xs shrink-0"
          disabled={launchingId === app.id}
          onClick={(e) => {
            e.stopPropagation();
            void handleLaunch(app);
          }}
        >
          <Play className="h-3.5 w-3.5" />
          {launchingId === app.id ? t('toolbox.apps.launching') : t('toolbox.apps.launch')}
        </Button>
      </div>
    </div>
  );


  useEffect(() => {
    AppsStorage.save(apps);
  }, [apps]);

  const openAdd = useCallback(() => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((app: ToolboxApp) => {
    setEditing(app);
    setForm({
      name: app.name,
      path: app.path,
      args: app.args ?? '',
      cwd: app.cwd ?? '',
      icon: app.icon ?? '',
      iconPath: app.iconPath ?? '',
      category: app.category ?? '',
      description: app.description ?? '',
    });
    setDialogOpen(true);
  }, []);

  const pickPath = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: t('toolbox.apps.pickPath'),
      });
      if (typeof selected === 'string' && selected) {
        setForm((f) => ({ ...f, path: selected }));
      }
    } catch {
      /* dialog cancelled */
    }
  }, [t]);

  const pickIconImage = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: t('toolbox.apps.pickIcon'),
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'] },
        ],
      });
      if (typeof selected === 'string' && selected) {
        setForm((f) => ({ ...f, iconPath: selected }));
      }
    } catch {
      /* cancelled */
    }
  }, [t]);


  const extractIcon = useCallback(async () => {
    const target = form.path.trim();
    if (!target) {
      toast.error(t('toolbox.apps.extractIconNoPath'));
      return;
    }
    try {
      const dataUrl = await invoke<string>('extract_app_icon', { path: target });
      setForm((f) => ({ ...f, iconPath: dataUrl }));
      toast.success(t('toolbox.apps.extractIconOk'));
    } catch (e) {
      toast.error(typeof e === 'string' ? e : String(e));
    }
  }, [form.path, t]);

  const pickCwd = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: true,
        title: t('toolbox.apps.pickCwd'),
      });
      if (typeof selected === 'string' && selected) {
        setForm((f) => ({ ...f, cwd: selected }));
      }
    } catch {
      /* dialog cancelled */
    }
  }, [t]);

  const handleSave = useCallback(() => {
    if (!form.name.trim() || !form.path.trim()) {
      toast.error(t('toolbox.apps.formIncomplete'), {
        description: t('toolbox.apps.formIncompleteDesc'),
      });
      return;
    }
    const now = Date.now();
    // Very large icon data-URLs can bloat the row and risk failing the whole
    // upsert (which would lose the app entry on restart). Guard the size: the
    // app still saves, just without the icon (it can be re-picked later).
    const rawIcon = form.iconPath.trim();
    const iconSafe = rawIcon && rawIcon.length <= MAX_ICON_CHARS ? rawIcon : undefined;
    const item: ToolboxApp = {
      id: editing?.id ?? generateId('app'),
      name: form.name.trim(),
      path: form.path.trim(),
      args: form.args.trim() || undefined,
      cwd: form.cwd.trim() || undefined,
      icon: form.icon.trim() || undefined,
      iconPath: iconSafe,
      category: form.category.trim() || undefined,
      description: form.description.trim() || undefined,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    };
    setApps(AppsStorage.upsert(item));
    setDialogOpen(false);
    if (rawIcon && !iconSafe) {
      toast.warning(t('toolbox.apps.iconTooLarge'), {
        description: t('toolbox.apps.iconTooLargeDesc'),
      });
    } else {
      toast.success(editing ? t('toolbox.apps.updated') : t('toolbox.apps.added'), {
        description: item.name,
      });
    }
  }, [editing, form, t]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    setApps(AppsStorage.remove(deleteTarget.id));
    toast.success(t('toolbox.apps.deleted'), { description: deleteTarget.name });
    setDeleteTarget(null);
  }, [deleteTarget, t]);

  const handleLaunch = useCallback(
    async (app: ToolboxApp) => {
      setLaunchingId(app.id);
      try {
        await invoke('launch_app', {
          request: { path: app.path, args: app.args ?? null, cwd: app.cwd ?? null },
        });
        toast.success(t('toolbox.apps.launched'), { description: app.name });
      } catch (error) {
        toast.error(t('toolbox.apps.launchFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setLaunchingId(null);
      }
    },
    [t],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Tool header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AppWindow className="h-4 w-4 text-primary" />
            {t('toolbox.apps.title')}
          </h3>
          <p className="text-xs text-muted-foreground truncate">{t('toolbox.apps.description')}</p>
        </div>
        <Button size="sm" onClick={openAdd} className="shrink-0 gap-1.5">
          <Plus className="h-4 w-4" />
          {t('toolbox.apps.add')}
        </Button>
      </div>

      {/* Card grid */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {apps.length === 0 ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border text-center p-8">
              <div className="p-3 rounded-full bg-primary/10 text-primary">
                <Rocket className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('toolbox.apps.empty')}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  {t('toolbox.apps.emptyDesc')}
                </p>
              </div>
              <Button size="sm" onClick={openAdd} className="gap-1.5">
                <Plus className="h-4 w-4" />
                {t('toolbox.apps.addFirst')}
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              {groupedApps.map(([category, list]) => (
                <div key={category || '__uncategorized__'} className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-0.5">
                    {category || t('toolbox.apps.uncategorized')}
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {list.map((app) => renderAppCard(app))}
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={openAdd}
                className="w-full rounded-xl border-2 border-dashed border-border hover:border-primary/50 hover:bg-muted/40 flex flex-col items-center justify-center gap-2 p-4 min-h-[120px] text-muted-foreground transition-colors"
              >
                <Plus className="h-6 w-6" />
                <span className="text-xs">{t('toolbox.apps.add')}</span>
              </button>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('toolbox.apps.editTitle') : t('toolbox.apps.addTitle')}
            </DialogTitle>
            <DialogDescription>{t('toolbox.apps.formDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="app-name">{t('toolbox.apps.name')}</Label>
                <Input
                  id="app-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('toolbox.apps.namePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="app-icon">{t('toolbox.apps.icon')}</Label>
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted overflow-hidden">
                    {form.iconPath ? (
                      <img src={iconSrc(form.iconPath)} alt="" className="h-full w-full object-cover" />
                    ) : form.icon ? (
                      <span className="text-lg">{form.icon}</span>
                    ) : (
                      <AppWindow className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <Input
                    id="app-icon"
                    value={form.icon}
                    onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                    placeholder={t('toolbox.apps.iconPlaceholder')}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => void pickIconImage()}
                    title={t('toolbox.apps.pickIcon')}
                  >
                    <ImageIcon className="h-4 w-4" />
                  </Button>
                  {form.iconPath && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setForm((f) => ({ ...f, iconPath: '' }))}
                      title={t('common.remove')}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="app-path">{t('toolbox.apps.path')}</Label>
              <div className="flex gap-2">
                <Input
                  id="app-path"
                  value={form.path}
                  onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                  placeholder={t('toolbox.apps.pathPlaceholder')}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => void pickPath()}
                  title={t('toolbox.apps.browse')}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => void extractIcon()}
                  title={t('toolbox.apps.extractIcon')}
                  disabled={!form.path.trim()}
                >
                  <Wand2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="app-args">{t('toolbox.apps.args')}</Label>
                <Input
                  id="app-args"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder={t('toolbox.apps.argsPlaceholder')}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="app-cwd">{t('toolbox.apps.cwd')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="app-cwd"
                    value={form.cwd}
                    onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                    placeholder={t('toolbox.apps.cwdPlaceholder')}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => void pickCwd()}
                    title={t('toolbox.apps.browse')}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="app-category">{t('toolbox.apps.category')}</Label>
              <Input
                id="app-category"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                placeholder={t('toolbox.apps.categoryPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-desc">{t('toolbox.apps.fieldDescription')}</Label>
              <Textarea
                id="app-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t('toolbox.apps.descriptionPlaceholder')}
                className="min-h-[60px] resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.apps.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.apps.deleteDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
