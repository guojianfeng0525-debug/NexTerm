import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { UploadConflictDialog, type UploadConflictRow } from './upload-conflict-dialog';
import type { UploadQueueInput } from '@/lib/upload-paths';
import { validateUploadTargets, type ConflictPolicy, type UploadTarget } from '@/lib/upload-conflicts';

export interface UploadResult {
  success: boolean;
  committed?: boolean;
  error?: string;
  conflict?: UploadTarget | null;
  destination_path?: string;
  bytes_transferred?: number;
  skipped?: boolean;
  cancelled?: boolean;
}
export interface UploadProgress { totalBytes: number; transferredBytes: number; phase?: 'committing' }
interface Pending {
  id: string;
  connectionId: string;
  label: string;
  rows: UploadConflictRow[];
  resolve: (policies: Map<number, ConflictPolicy> | null) => void;
}

/** Batches keep their immutable connection/destinations while the user browses.
 * Hidden workspaces retain requests without opening a modal or approving them. */
export function useUploadPlanner({ connectionId, label, active, connected = true, canOperate }: {
  connectionId: string; label: string; active: boolean; connected?: boolean; canOperate: () => boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending[]>([]);
  const [checkingCount, setCheckingCount] = useState(0);
  const pendingRef = useRef<Pending[]>([]);
  const mountedRef = useRef(true);
  const ownerRef = useRef({ connectionId, label, active, connected, canOperate });
  useLayoutEffect(() => { ownerRef.current = { connectionId, label, active, connected, canOperate }; }, [connectionId, label, active, connected, canOperate]);
  const publish = useCallback((next: Pending[]) => { pendingRef.current = next; setPending(next); }, []);
  const settle = useCallback((id: string, policies: Map<number, ConflictPolicy> | null) => {
    const request = pendingRef.current.find(item => item.id === id);
    if (!request) return;
    publish(pendingRef.current.filter(item => item !== request));
    const owner = ownerRef.current;
    request.resolve(policies && owner.active && owner.connected && owner.connectionId === request.connectionId
      && owner.label === request.label && owner.canOperate() ? policies : null);
  }, [publish]);
  useEffect(() => {
    const obsolete = pendingRef.current.filter(item => item.connectionId !== connectionId || item.label !== label || !connected);
    obsolete.forEach(item => item.resolve(null));
    publish(pendingRef.current.filter(item => item.connectionId === connectionId && item.label === label && connected));
  }, [connectionId, label, connected, publish]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current.forEach(item => item.resolve(null));
      pendingRef.current = [];
    };
  }, []);

  const plan = useCallback(async (items: UploadQueueInput[], signal?: AbortSignal): Promise<UploadQueueInput[] | null> => {
    const owner = { ...ownerRef.current };
    const owns = () => mountedRef.current && !signal?.aborted && ownerRef.current.connected
      && ownerRef.current.connectionId === owner.connectionId && ownerRef.current.label === owner.label;
    if (!items.length || !owns() || items.some(item => item.connectionId && item.connectionId !== owner.connectionId)) return null;
    const paths = items.map(item => item.destinationPath);
    let inspected: unknown;
    setCheckingCount(count => count + 1);
    try { inspected = await invoke('inspect_remote_uploads', { connectionId: owner.connectionId, paths }); }
    catch (error) { if (!owns()) return null; throw error; }
    finally { if (mountedRef.current) setCheckingCount(count => count - 1); }
    let targets: UploadTarget[];
    try { targets = validateUploadTargets(inspected, paths); }
    catch { throw new Error(t('uploadConflict.invalidInspection')); }
    if (!owns()) return null;
    const batchId = crypto.randomUUID();
    const seen = new Set<string>();
    const rows: UploadConflictRow[] = [];
    items.forEach((item, index) => {
      const target = seen.has(item.destinationPath) ? { path: item.destinationPath,
        version: { kind: 'Queued' as const, size: item.totalBytes, modified: null } } : targets[index];
      seen.add(item.destinationPath);
      if (target.version) rows.push({ index, sourcePath: item.sourcePath, size: item.totalBytes || null, modified: null, target });
    });
    // Obtain local comparison metadata only for conflicts; do not add one IPC
    // per file to the normal transfer path.
    await Promise.all(rows.map(async row => {
      const stat = await invoke<{ exists: boolean; size: number; modified?: string | null }>('stat_local_path', { path: row.sourcePath });
      if (!stat?.exists) throw new Error(t('uploadConflict.sourceMissing', { path: row.sourcePath }));
      row.size = stat.size; row.modified = stat.modified ?? null;
    }));
    if (!owns()) return null;
    let policies: Map<number, ConflictPolicy> | null = new Map();
    if (rows.length) {
      policies = await new Promise<Map<number, ConflictPolicy> | null>(resolve => {
        const request: Pending = { id: batchId, connectionId: owner.connectionId, label: owner.label, rows, resolve };
        publish([...pendingRef.current, request]);
        signal?.addEventListener('abort', () => settle(batchId, null), { once: true });
      });
    }
    if (!policies || !owns()) return null;
    return items.map((item, index) => {
      const policy = policies.get(index) ?? 'ask';
      return { ...item, connectionId: owner.connectionId, batchId, conflictPolicy: policy,
        expectedTarget: policy === 'replace' ? targets[index].version ?? undefined : undefined, skip: policy === 'skip' };
    });
  }, [publish, settle, t]);

  const upload = useCallback(async (item: UploadQueueInput, transferId: string,
    onProgress: Channel<UploadProgress>, signal?: AbortSignal, onWaiting?: (waiting: boolean) => void): Promise<UploadResult> => {
    let approved = item;
    while (!signal?.aborted) {
      if (approved.skip) return { success: false, skipped: true };
      let result: UploadResult;
      try {
        result = await invoke<UploadResult>('upload_remote_file', {
          connectionId: approved.connectionId ?? connectionId,
          localPath: approved.sourcePath, remotePath: approved.destinationPath,
          expectedTarget: approved.expectedTarget ?? null, conflictPolicy: approved.conflictPolicy ?? 'ask',
          transferId, onProgress,
        });
      } catch (error) { if (signal?.aborted) return { success: false, cancelled: true }; throw error; }
      if (!result.conflict) return signal?.aborted && !result.committed ? { success: false, cancelled: true } : result;
      if (signal?.aborted || ownerRef.current.connectionId !== (approved.connectionId ?? connectionId)) return { success: false, cancelled: true };
      onWaiting?.(true);
      const next = await plan([{ ...approved, expectedTarget: undefined, conflictPolicy: 'ask', skip: false }], signal);
      if (!next) return { success: false, cancelled: true };
      approved = next[0];
      onWaiting?.(false);
    }
    return { success: false, cancelled: true };
  }, [connectionId, plan]);

  const first = pending[0];
  const conflictDialog = first ? <UploadConflictDialog key={first.id}
    open={active && first.connectionId === connectionId} label={first.label} rows={first.rows}
    onCancel={() => settle(first.id, null)} onConfirm={policies => settle(first.id, policies)} /> : null;
  return { planUploads: plan, upload, conflictDialog, pendingCount: pending.length, checkingCount };
}
