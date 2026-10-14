import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './alert-dialog';
import { Button } from './button';
import { Input } from './input';

type Request = {
  kind: 'prompt' | 'confirm';
  message: string;
  initialValue?: string;
  validate?: (value: string) => boolean;
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
  scopeKey: string;
  resolve: (value: string | null) => void;
};

/** Styled replacements for browser dialogs; a request expires with its page/scope. */
export function useDialogRequest({ active, scopeKey = '', canConfirm }: {
  active: boolean;
  scopeKey?: string;
  canConfirm?: () => boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const pendingRef = useRef<Request | null>(null);
  const scopeRef = useRef({ active, scopeKey, canConfirm });
  useLayoutEffect(() => {
    scopeRef.current = { active, scopeKey, canConfirm };
  }, [active, scopeKey, canConfirm]);

  const finish = useCallback((result: string | null) => {
    const request = pendingRef.current;
    if (!request) return;
    const scope = scopeRef.current;
    const valid = scope.active && request.scopeKey === scope.scopeKey && (scope.canConfirm?.() ?? true);
    pendingRef.current = null;
    setPending(null);
    request.resolve(valid ? result : null);
  }, []);

  useLayoutEffect(() => {
    if (!active || pendingRef.current?.scopeKey !== scopeKey) finish(null);
  }, [active, scopeKey, finish]);
  useLayoutEffect(() => () => {
    pendingRef.current?.resolve(null);
    pendingRef.current = null;
  }, []);

  const request = useCallback((options: Omit<Request, 'scopeKey' | 'resolve'>) => {
    finish(null);
    if (!scopeRef.current.active || !(scopeRef.current.canConfirm?.() ?? true)) return Promise.resolve(null);
    return new Promise<string | null>(resolve => {
      const next = { ...options, scopeKey: scopeRef.current.scopeKey, resolve };
      pendingRef.current = next;
      setValue(options.initialValue ?? '');
      setPending(next);
    });
  }, [finish]);

  const prompt = useCallback((message: string, initialValue = '', validate?: (value: string) => boolean) =>
    request({ kind: 'prompt', message, initialValue, validate }), [request]);
  const confirm = useCallback(async (message: string, options?: Pick<Request, 'title' | 'confirmLabel' | 'destructive'>) =>
    (await request({ kind: 'confirm', message, ...options })) !== null, [request]);
  const visible = !!pending && active && pending.scopeKey === scopeKey;
  const validValue = value.length > 0 && (pending?.validate?.(value) ?? true);
  const dialog = pending?.kind === 'confirm' ? (
    <AlertDialog open={visible} onOpenChange={open => { if (!open) finish(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{pending.title ?? t('common.confirm')}</AlertDialogTitle><AlertDialogDescription>{pending.message}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel onClick={() => finish(null)}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction className={pending.destructive ? 'bg-destructive hover:bg-destructive/90' : undefined} onClick={event => { event.preventDefault(); finish('confirmed'); }}>{pending.confirmLabel ?? t('common.confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : pending ? (
    <Dialog open={visible} onOpenChange={open => { if (!open) finish(null); }}>
      <DialogContent className="max-w-sm" aria-describedby={undefined}>
        <form className="flex min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (validValue) finish(value); }}>
          <DialogHeader><DialogTitle>{pending.message}</DialogTitle></DialogHeader>
          <Input autoFocus aria-label={pending.message} value={value} onChange={event => setValue(event.target.value)} />
          <DialogFooter><Button type="button" variant="outline" onClick={() => finish(null)}>{t('common.cancel')}</Button><Button type="submit" disabled={!validValue}>{t('common.confirm')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  ) : null;
  return { prompt, confirm, dialog };
}
