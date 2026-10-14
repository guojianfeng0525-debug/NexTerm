import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './ui/alert-dialog';
import { canReplaceUpload, type ConflictPolicy, type UploadTarget } from '@/lib/upload-conflicts';
import { formatSize } from '@/lib/file-entry-types';

export interface UploadConflictRow {
  index: number;
  sourcePath: string;
  size: number | null;
  modified: string | null;
  target: UploadTarget;
}

export function UploadConflictDialog({ open, label, rows, onCancel, onConfirm }: {
  open: boolean;
  label: string;
  rows: UploadConflictRow[];
  onCancel: () => void;
  onConfirm: (policies: Map<number, ConflictPolicy>) => void;
}) {
  const { t } = useTranslation();
  const [policies, setPolicies] = useState<Map<number, ConflictPolicy>>(new Map());
  const [bulk, setBulk] = useState<ConflictPolicy>('skip');
  const policyFor = (index: number) => policies.get(index) ?? 'skip';
  const replacing = rows.some(row => policyFor(row.index) === 'replace');
  const options = (allowReplace: boolean) => <>
    <option value="skip">{t('uploadConflict.skip')}</option>
    <option value="keep-both">{t('uploadConflict.keepBoth')}</option>
    <option value="replace" disabled={!allowReplace}>{t('uploadConflict.replace')}</option>
  </>;
  return (
    <AlertDialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <AlertDialogContent className="max-w-[560px]">
        <AlertDialogHeader className="shrink-0">
          <AlertDialogTitle>{t('uploadConflict.title', { count: rows.length })}</AlertDialogTitle>
          <AlertDialogDescription>{t('uploadConflict.description', { target: label })}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto text-sm">
          <label className="flex flex-wrap items-center gap-2">
            <span>{t('uploadConflict.applyAll')}</span>
            <select aria-label={t('uploadConflict.applyAll')} className="rounded border bg-background px-2 py-1.5" value={bulk}
              onChange={event => {
                const policy = event.target.value as ConflictPolicy;
                setBulk(policy);
                setPolicies(new Map(rows.map(row => [row.index, policy === 'replace' && !canReplaceUpload(row.target) ? 'skip' : policy])));
              }}>{options(rows.some(row => canReplaceUpload(row.target)))}</select>
          </label>
          <ul className="space-y-3">
            {rows.map(row => <li key={row.index} className="min-w-0 space-y-2 rounded-md border p-3">
              <p className="break-all font-mono text-[13px] select-text">{row.target.path}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><p className="font-medium">{t('uploadConflict.local')}</p><p className="break-all font-mono">{row.sourcePath}</p>
                  <p>{row.size === null ? t('uploadConflict.unknownSize') : formatSize(row.size)}</p><p>{row.modified ?? t('uploadConflict.unknownTime')}</p></div>
                <div><p className="font-medium">{t('uploadConflict.remote')}</p><p>{t(`uploadConflict.kind.${row.target.version?.kind ?? 'File'}`)}</p>
                  <p>{formatSize(row.target.version?.size ?? 0)}</p><p>{row.target.version?.modified ?? t('uploadConflict.unknownTime')}</p></div>
              </div>
              {!canReplaceUpload(row.target) && <p className="text-xs text-muted-foreground">{t('uploadConflict.typeConflict')}</p>}
              <label className="flex flex-wrap items-center justify-between gap-2">
                <span>{t('uploadConflict.action')}</span>
                <select aria-label={t('uploadConflict.actionFor', { path: row.target.path })} className="rounded border bg-background px-2 py-1.5" value={policyFor(row.index)}
                  onChange={event => setPolicies(current => new Map(current).set(row.index, event.target.value as ConflictPolicy))}>
                  {options(canReplaceUpload(row.target))}
                </select>
              </label>
            </li>)}
          </ul>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction className={replacing ? 'bg-destructive hover:bg-destructive/90' : undefined}
            onClick={event => { event.preventDefault(); onConfirm(new Map(rows.map(row => [row.index, policyFor(row.index)]))); }}>
            {t('uploadConflict.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
