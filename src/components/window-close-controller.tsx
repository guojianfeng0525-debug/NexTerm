import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { snapshotWorkspaceForWindowAction } from '@/lib/workspace-window-snapshot';
import { flushWorkspace } from '@/lib/terminal-group-serializer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface WindowCloseControllerProps {
  /** Injectable for testing; the tray choice is available on Windows. */
  windows?: boolean;
}

export function WindowCloseController({
  windows = /Windows/i.test(navigator.userAgent),
}: WindowCloseControllerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const persistWorkspace = useCallback(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      snapshotWorkspaceForWindowAction();
      await Promise.race([
        flushWorkspace(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_000); }),
      ]);
    } catch (error) {
      console.error('[workspace] close-time persistence failed:', error);
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const leave = useCallback(async (choice: 'exit' | 'hide') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    await persistWorkspace();
    try {
      if (choice === 'hide') {
        await getCurrentWindow().hide();
        setOpen(false);
      } else if (windows) {
        // A Windows tray icon keeps the event loop alive after window destroy.
        await exit(0);
      } else {
        try {
          await getCurrentWindow().destroy();
        } catch (error) {
          console.error('[workspace] window destroy failed, falling back to process exit:', error);
          await exit(0);
        }
      }
    } catch (error) {
      console.error('[window] requested action failed:', error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [persistWorkspace, windows]);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      if (windows) {
        setOpen(true);
      } else {
        await leave('exit');
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error: unknown) => {
      console.error('[window] failed to register close handler:', error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [leave, windows]);

  if (!windows) return null;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent data-testid="window-close-choice">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('app.close.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('app.close.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="window-close-cancel">
            {t('common.cancel')}
          </AlertDialogCancel>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="window-close-hide"
            onClick={() => void leave('hide')}
          >
            {t('app.close.hideToTray')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            data-testid="window-close-exit"
            onClick={() => void leave('exit')}
          >
            {t('app.close.exit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
