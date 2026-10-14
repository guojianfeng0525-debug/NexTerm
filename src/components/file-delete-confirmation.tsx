import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import type { FileDeletionTarget } from '@/lib/file-deletion';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from './ui/alert-dialog';

export function FileDeleteConfirmation({ open, targetLabel, files, remote, recursive = false, busy = false, onCancel, onConfirm }: {
  open: boolean;
  targetLabel: string;
  files: readonly FileDeletionTarget[];
  remote: boolean;
  recursive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <AlertDialogContent ref={dialogRef} className="max-w-[480px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(remote ? 'fileDeletion.remoteTitle' : 'fileDeletion.localTitle', { count: files.length })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('fileDeletion.description', { count: files.length })}
            {recursive && files.some(file => file.isDirectory) && (
              <span className="mt-2 block font-medium text-destructive">{t('fileDeletion.recursiveWarning')}</span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-h-0 flex-col gap-2 text-sm">
          <p className="max-h-24 shrink-0 overflow-auto">{t(remote ? 'fileDeletion.server' : 'fileDeletion.location', { target: targetLabel })}</p>
          <ul className="min-h-0 max-h-48 space-y-2 overflow-auto rounded border p-3">
            {files.map(file => <li key={file.path} className="break-all">
              <span className="text-xs text-muted-foreground">{t(file.isDirectory ? 'fileDeletion.directory' : 'fileDeletion.file')}</span>
              <div className="whitespace-pre-wrap font-mono">{file.path}</div>
            </li>)}
          </ul>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={busy || files.length === 0} className="bg-destructive hover:bg-destructive/90"
            onClick={event => {
              event.preventDefault();
              if (dialogRef.current?.contains(document.activeElement)) void onConfirm();
            }}>
            {t(busy ? 'fileDeletion.deleting' : 'fileDeletion.confirm', { count: files.length })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
