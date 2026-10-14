/**
 * Directory Transfer Dialog
 *
 * Recursively uploads or downloads a directory to the other panel,
 * showing per-file progress with cancel support.
 *
 * Like FileZilla's recursive directory transfer:
 * 1. Enumerate all files/dirs in the source directory
 * 2. Create directory structure in destination
 * 3. Transfer all files one by one with progress
 */
import React, { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { invoke, Channel } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUploadPlanner, type UploadProgress } from './use-upload-planner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { Badge } from "./ui/badge";
import {
  Upload,
  Download,
  FolderUp,
  FolderDown,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { formatSize } from "@/lib/file-entry-types";

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  return `${formatSize(bytesPerSec)}/s`;
}

// ── Types ──

export interface DirectoryTransferDialogProps {
  open: boolean;
  isActive?: boolean;
  isConnected?: boolean;
  onOpenChange: (open: boolean) => void;
  /** "upload" = local dir → remote, "download" = remote dir → local */
  direction: "upload" | "download";
  /** Connection ID for remote operations */
  connectionId: string;
  /** Full path to the source directory */
  sourcePath: string;
  /** Full path to the destination root directory */
  destPath: string;
  /** Optional child directory created below the destination root */
  destinationDirectoryName?: string;
  /** Called when transfer completes to refresh panels */
  onComplete: () => void;
}

interface TransferProgress {
  phase: "enumerating" | "transferring" | "completed" | "cancelled" | "error";
  totalFiles: number;
  totalDirs: number;
  processedFiles: number;
  processedDirs: number;
  bytesTransferred: number;
  totalBytes: number;
  currentItem?: string;
  errors: string[];
  /** Instantaneous transfer speed (bytes/sec) — shown in the status line. */
  speed?: number;
}

const initialProgress: TransferProgress = {
  phase: "enumerating",
  totalFiles: 0,
  totalDirs: 0,
  processedFiles: 0,
  processedDirs: 0,
  bytesTransferred: 0,
  totalBytes: 0,
  errors: [],
};

// ── Component ──

export function DirectoryTransferDialog({
  open,
  isActive = true,
  isConnected = true,
  onOpenChange,
  direction,
  connectionId,
  sourcePath,
  destPath,
  destinationDirectoryName,
  onComplete,
}: DirectoryTransferDialogProps) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<TransferProgress>({
    ...initialProgress,
  });
  const cancelRef = useRef(false);
  const activeTransferIdRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const runAbortRef = useRef<AbortController | null>(null);
  const [committing, setCommitting] = useState(false);
  const scopeRef = useRef({ open, connectionId, sourcePath, destPath });
  scopeRef.current = { open, connectionId, sourcePath, destPath };
  const ownsScope = useCallback(() => !cancelRef.current && scopeRef.current.open
    && scopeRef.current.connectionId === connectionId && scopeRef.current.sourcePath === sourcePath
    && scopeRef.current.destPath === destPath, [connectionId, sourcePath, destPath]);
  const { planUploads, upload, conflictDialog } = useUploadPlanner({
    connectionId, label: `${connectionId}: ${destPath}`, active: open && isActive, connected: isConnected, canOperate: ownsScope,
  });

  // Auto-start transfer when dialog opens
  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      cancelRef.current = false;
      setProgress({ ...initialProgress });
      const controller = new AbortController();
      runAbortRef.current = controller;
      void runTransfer(controller.signal);
    }
    if (!open) {
      startedRef.current = false;
    }
    return () => { runAbortRef.current?.abort(); startedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId, sourcePath, destPath]);

  const runTransfer = useCallback(async (signal: AbortSignal) => {
    try {
      // Phase 1: Enumerate source directory
      setProgress((p) => ({ ...p, phase: "enumerating" }));

      let entries: Array<{
        relative_path: string;
        name: string;
        size: number;
        modified: string | null;
        file_type: string;
      }>;

      if (direction === "upload") {
        // List local files recursively
        entries = await invoke<typeof entries>("list_local_files_recursive", {
          path: sourcePath,
          excludePatterns: [],
        });
      } else {
        // List remote files recursively
        entries = await invoke<typeof entries>(
          "list_remote_files_recursive",
          {
            connectionId,
            path: sourcePath,
            excludePatterns: [],
          },
        );
      }

      if (cancelRef.current || signal.aborted) {
        setProgress((p) => ({ ...p, phase: "cancelled" }));
        return;
      }

      const dirs = entries.filter((e) => e.file_type === "Directory");
      const files = entries.filter((e) => e.file_type !== "Directory");
      const totalBytes = files.reduce((s, f) => s + f.size, 0);

      setProgress((p) => ({
        ...p,
        phase: "transferring",
        totalFiles: files.length,
        totalDirs: dirs.length,
        totalBytes,
      }));

      const destinationPrefix = destinationDirectoryName
        ? `${destinationDirectoryName}/`
        : "";
      const destinationRelativePath = (relativePath: string) =>
        `${destinationPrefix}${relativePath}`;

      const plannedUploads = direction === 'upload' && files.length ? await planUploads(files.map(file => ({
        connectionId, fileName: file.name, direction: 'upload',
        sourcePath: `${sourcePath.replace(/\/+$/, '')}/${file.relative_path}`,
        destinationPath: `${destPath.replace(/\/+$/, '')}/${file.relative_path}`, totalBytes: file.size,
      })), signal) : [];
      if (direction === 'upload' && !plannedUploads || signal.aborted) {
        if (!signal.aborted) setProgress(p => ({ ...p, phase: 'cancelled' }));
        return;
      }
      if (direction === 'upload') setProgress(p => ({ ...p, totalBytes: plannedUploads?.filter(item => !item.skip).reduce((sum, item) => sum + item.totalBytes, 0) ?? 0 }));
      let skippedFiles = 0;

      // Phase 2: Create directory structure
      // Sort dirs by path depth so parents come first
      const sortedDirs = [...dirs].sort(
        (a, b) => a.relative_path.split("/").length - b.relative_path.split("/").length,
      );

      // Create the root destination directory first
      if (direction === "upload") {
        try {
          await invoke<{ success: boolean; error?: string }>(
            "create_remote_directory",
            { connectionId, path: destPath },
          );
        } catch {
          // May already exist, continue
        }
      } else if (destinationDirectoryName) {
        try {
          await invoke<void>("create_local_directory_confined", {
            destinationRoot: destPath,
            relativePath: destinationDirectoryName,
          });
        } catch {
          // May already exist, continue
        }
      } else {
        try {
          await invoke<void>("create_local_directory", { path: destPath });
        } catch {
          // May already exist, continue
        }
      }

      let processedDirs = 0;
      for (const dir of sortedDirs) {
        if (cancelRef.current || signal.aborted) {
          setProgress((p) => ({ ...p, phase: "cancelled" }));
          return;
        }

        setProgress((p) => ({
          ...p,
          currentItem: dir.relative_path,
          processedDirs,
        }));

        try {
          if (direction === "upload") {
            const dirDestPath =
              destPath === "/"
                ? `/${dir.relative_path}`
                : `${destPath}/${dir.relative_path}`;
            await invoke<{ success: boolean; error?: string }>(
              "create_remote_directory",
              { connectionId, path: dirDestPath },
            );
          } else {
            await invoke<void>("create_local_directory_confined", {
              destinationRoot: destPath,
              relativePath: destinationRelativePath(dir.relative_path),
            });
          }
        } catch (err) {
          // Directory may already exist — log but continue
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("already exist")) {
            setProgress((p) => ({
              ...p,
              errors: [...p.errors, `mkdir ${dir.relative_path}: ${msg}`],
            }));
          }
        }
        processedDirs++;
      }

      setProgress((p) => ({ ...p, processedDirs }));

      // Phase 3: Transfer all files
      let processedFiles = 0;
      let bytesTransferred = 0;
      // Speed sampling state (shared across the whole transfer).
      const speedSample = { bytes: 0, time: Date.now() };

      const emitProgress = (doneBytes: number) => {
        const now = Date.now();
        const dt = (now - speedSample.time) / 1000;
        const dB = doneBytes - speedSample.bytes;
        const speed = dt > 0 && dB >= 0 ? Math.round(dB / dt) : 0;
        speedSample.bytes = doneBytes;
        speedSample.time = now;
        bytesTransferred = doneBytes;
        setProgress((p) => ({ ...p, bytesTransferred: doneBytes, speed }));
      };

      for (const file of files) {
        if (cancelRef.current || signal.aborted) {
          setProgress((p) => ({ ...p, phase: "cancelled" }));
          return;
        }

        const fileSrcPath =
          sourcePath === "/"
            ? `/${file.relative_path}`
            : `${sourcePath}/${file.relative_path}`;
        const transferId = `directory-${Date.now()}-${processedFiles}`;
        activeTransferIdRef.current = transferId;

        setProgress((p) => ({
          ...p,
          currentItem: file.relative_path,
          processedFiles,
          bytesTransferred,
        }));

        // Per-file real-time progress channel from the backend.
        const fileStartBytes = bytesTransferred;
        const channel = new Channel<UploadProgress>();
        channel.onmessage = (p) => {
          if (p.phase === 'committing') setCommitting(true);
          emitProgress(fileStartBytes + p.transferredBytes);
        };

        try {
          if (direction === "upload") {
            const planned = plannedUploads?.find(item => item.sourcePath === fileSrcPath);
            if (!planned) throw new Error(t('uploadConflict.planExpired'));
            const result = await upload(planned, transferId, channel, signal);
            if (result.cancelled) { setProgress(p => ({ ...p, phase: 'cancelled' })); return; }
            if (result.skipped) { skippedFiles++; processedFiles++; activeTransferIdRef.current = null; continue; }
            if (!result.success) {
              throw new Error(result.error ?? "Upload failed");
            }
          } else {
            const result = await invoke<{
              success: boolean;
              error?: string;
            }>("download_remote_file_confined", {
              connectionId,
              remoteRoot: sourcePath,
              destinationRoot: destPath,
              remoteRelativePath: file.relative_path,
              destinationRelativePath: destinationRelativePath(file.relative_path),
              onProgress: channel,
              transferId,
            });
            if (!result.success) {
              throw new Error(result.error ?? "Download failed");
            }
          }
          // Ensure the counter reflects the file even if the backend sent no
          // progress events (e.g. tiny files that finished in one chunk).
          emitProgress(fileStartBytes + file.size);
        } catch (err) {
          setProgress((p) => ({
            ...p,
            errors: [
              ...p.errors,
              `${file.relative_path}: ${err instanceof Error ? err.message : String(err)}`,
            ],
          }));
        }
        setCommitting(false);
        activeTransferIdRef.current = null;

        processedFiles++;
      }

      // Done
      setProgress((p) => ({
        ...p,
        phase: "completed",
        processedFiles,
        processedDirs,
        bytesTransferred,
      }));

      const errorCount = (
        await new Promise<TransferProgress>((resolve) =>
          setProgress((p) => {
            resolve(p);
            return p;
          }),
        )
      ).errors.length;

      if (errorCount === 0) {
        toast.success(
          t('directoryTransferDialog.toast.complete', { context: direction, processedFiles: processedFiles - skippedFiles, processedDirs }),
        );
      } else {
        toast.warning(
          t('directoryTransferDialog.toast.failed', { errorCount }),
        );
      }

      if (skippedFiles) toast.info(t('uploadConflict.skippedCount', { count: skippedFiles }));
      onComplete();
    } catch (err) {
      if (signal.aborted) return;
      setProgress((p) => ({
        ...p,
        phase: "error",
        errors: [
          ...p.errors,
          err instanceof Error ? err.message : String(err),
        ],
      }));
      toast.error(t('directoryTransferDialog.toast.error'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [direction, connectionId, sourcePath, destPath, destinationDirectoryName, onComplete, planUploads, upload, t]);

  const isBusy =
    progress.phase === "enumerating" || progress.phase === "transferring";
  const isDone = progress.phase === "completed" || progress.phase === "cancelled" || progress.phase === "error";
  const totalItems = progress.totalFiles + progress.totalDirs;
  const processedItems = progress.processedFiles + progress.processedDirs;
  // Byte-based progress (real-time from the backend channel) — falls back to
  // item counts when total bytes are unknown (e.g. FTP downloads).
  const progressPercent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesTransferred / progress.totalBytes) * 100))
      : totalItems > 0
        ? Math.round((processedItems / totalItems) * 100)
        : 0;

  const _dirName = sourcePath.split("/").filter(Boolean).pop() ?? sourcePath;

  return (
    <Dialog open={open && isActive} onOpenChange={isBusy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {direction === "upload" ? (
              <FolderUp className="h-5 w-5 text-blue-500" />
            ) : (
              <FolderDown className="h-5 w-5 text-green-500" />
            )}
            {direction === "upload"
              ? t('directoryTransferDialog.title.upload')
              : t('directoryTransferDialog.title.download')}
          </DialogTitle>
        </DialogHeader>

        {/* Path info */}
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs shrink-0">
          <span className="text-muted-foreground">{t('directoryTransferDialog.label.source')}</span>
          <span className="font-mono truncate" title={sourcePath}>
            {sourcePath}
          </span>
          <span className="text-muted-foreground">{t('directoryTransferDialog.label.dest')}</span>
          <span className="font-mono truncate" title={destPath}>
            {destPath}
          </span>
        </div>

        {/* Progress section */}
        <div className="space-y-2 shrink-0">
          {/* Status */}
          <div className="flex items-center gap-2">
            {progress.phase === "enumerating" && (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {t('directoryTransferDialog.status.enumerating')}
                </span>
              </>
            )}
            {progress.phase === "transferring" && (
              <>
                {direction === "upload" ? (
                  <Upload className="h-4 w-4 text-blue-500" />
                ) : (
                  <Download className="h-4 w-4 text-green-500" />
                )}
                <span className="text-sm">
                  {progress.currentItem ?? t('directoryTransferDialog.status.preparing')}
                </span>
              </>
            )}
            {progress.phase === "completed" && (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-600 dark:text-green-400">
                  {t('directoryTransferDialog.status.complete')}
                </span>
              </>
            )}
            {progress.phase === "cancelled" && (
              <>
                <X className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {t('directoryTransferDialog.status.cancelled')}
                </span>
              </>
            )}
            {progress.phase === "error" && (
              <>
                <AlertCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm text-destructive">
                  {t('directoryTransferDialog.status.failed')}
                </span>
              </>
            )}
          </div>

          {/* Progress bar */}
          {progress.phase === "transferring" && (
            <div className="space-y-1">
              <Progress value={progressPercent} className="h-1.5" />
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  {t('directoryTransferDialog.progress.counts', {
                    files: progress.processedFiles,
                    totalFiles: progress.totalFiles,
                    dirs: progress.processedDirs,
                    totalDirs: progress.totalDirs,
                  })}
                </span>
                <span>
                  {formatSize(progress.bytesTransferred)} /{" "}
                  {formatSize(progress.totalBytes)}
                </span>
                {progress.speed !== undefined && progress.speed > 0 && (
                  <span className="text-green-600 dark:text-green-400">
                    {formatSpeed(progress.speed)}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Summary badges */}
          {isDone && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="text-[10px] gap-1 h-5">
                {t('directoryTransferDialog.badge.files', { count: progress.processedFiles })}
              </Badge>
              <Badge variant="secondary" className="text-[10px] gap-1 h-5">
                {t('directoryTransferDialog.badge.dirs', { count: progress.processedDirs })}
              </Badge>
              <Badge variant="secondary" className="text-[10px] gap-1 h-5">
                {formatSize(progress.bytesTransferred)}
              </Badge>
              {progress.errors.length > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 h-5 border-destructive text-destructive"
                >
                  {t('directoryTransferDialog.badge.errors', { count: progress.errors.length })}
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Error log — viewportClassName bounds the actual scroller (see
            scroll-area.tsx note: a max-h-only Root never scrolls). */}
        {progress.errors.length > 0 && (
          <ScrollArea className="max-h-24 border rounded text-[10px] font-mono p-2" viewportClassName="max-h-24">
            {progress.errors.map((err, i) => (
              <div key={i} className="text-destructive">
                {err}
              </div>
            ))}
          </ScrollArea>
        )}

        {/* Footer */}
        <DialogFooter className="gap-2 sm:gap-2 shrink-0">
          {isBusy && (
            <Button
              variant="destructive"
              disabled={committing}
              size="sm"
              onClick={() => {
                cancelRef.current = true;
                runAbortRef.current?.abort();
                const transferId = activeTransferIdRef.current;
                if (transferId) {
                  void invoke("cancel_file_transfer", { connectionId, transferId });
                }
              }}
            >
              <X className="h-4 w-4 mr-1" />
              {t('common.cancel')}
            </Button>
          )}
          {isDone && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              {t('common.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {conflictDialog}
    </Dialog>
  );
}
