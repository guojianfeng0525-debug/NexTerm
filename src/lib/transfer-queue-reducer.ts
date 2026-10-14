// Transfer Queue State Management
// Manages file transfers between local and remote panels.
import type { UploadApproval } from './upload-conflicts';

export type TransferStatus =
  | "queued"
  | "transferring"
  | "waiting"
  | "committing"
  | "skipped"
  | "completed"
  | "failed"
  | "cancelled";

export type TransferDirection = "upload" | "download";

export interface TransferItem extends UploadApproval {
  /** Immutable connection that owned the transfer when it was queued. */
  connectionId?: string;
  id: string;
  fileName: string;
  direction: TransferDirection;
  sourcePath: string;
  destinationPath: string;
  status: TransferStatus;
  progress: number; // 0-100
  bytesTransferred: number;
  totalBytes: number;
  speed: number; // bytes/sec
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export type TransferAction =
  | {
      type: "ENQUEUE";
      items: Array<UploadApproval & {
        fileName: string;
        direction: TransferDirection;
        sourcePath: string;
        destinationPath: string;
        totalBytes: number;
        connectionId?: string;
      }>;
    }
  | { type: "START"; id: string }
  | { type: "WAIT"; id: string }
  | { type: "COMMIT"; id: string }
  | { type: "SKIP"; id: string }
  | {
      type: "PROGRESS";
      id: string;
      progress: number;
      bytesTransferred: number;
      speed: number;
    }
  | { type: "COMPLETE"; id: string; destinationPath?: string; committed?: boolean }
  | { type: "FAIL"; id: string; error: string }
  | { type: "CANCEL"; id: string }
  | { type: "RETRY"; id: string }
  | { type: 'EXPIRE_APPROVALS'; connectionId: string }
  | { type: "CLEAR_COMPLETED" }
  | { type: "CLEAR_ALL" };

let nextId = 1;

/** Generate a unique transfer ID. */
export function generateTransferId(): string {
  return `transfer-${nextId++}-${Date.now()}`;
}

/** Reset the ID counter (for testing). */
export function resetTransferIdCounter(): void {
  nextId = 1;
}

export function transferQueueReducer(
  state: TransferItem[],
  action: TransferAction,
): TransferItem[] {
  switch (action.type) {
    case "ENQUEUE": {
      const newItems: TransferItem[] = action.items.map((item) => ({
        ...item,
        ...(item.connectionId ? { connectionId: item.connectionId } : {}),
        id: generateTransferId(),
        fileName: item.fileName,
        direction: item.direction,
        sourcePath: item.sourcePath,
        destinationPath: item.destinationPath,
        status: item.skip ? "skipped" as const : "queued" as const,
        progress: 0,
        bytesTransferred: 0,
        totalBytes: item.totalBytes,
        speed: 0,
      }));
      return [...state, ...newItems];
    }

    case "START": {
      return state.map((item) =>
        item.id === action.id && (item.status === 'queued' || item.status === 'waiting')
          ? { ...item, status: "transferring" as const, startedAt: Date.now() }
          : item,
      );
    }

    case "WAIT":
    case "COMMIT":
    case "SKIP": {
      return state.map(item => item.id === action.id && (item.status === 'transferring' || item.status === 'waiting')
        ? { ...item, status: action.type === 'WAIT' ? 'waiting' : action.type === 'COMMIT' ? 'committing' : 'skipped' } : item);
    }

    case "PROGRESS": {
      return state.map((item) =>
        item.id === action.id && (item.status === "transferring" || item.status === 'committing')
          ? {
              ...item,
              progress: action.progress,
              bytesTransferred: action.bytesTransferred,
              speed: action.speed,
            }
          : item,
      );
    }

    case "COMPLETE": {
      return state.map((item) =>
        // A cancelled request may still resolve after the UI cancellation.
        // Never let that late completion resurrect it as a successful transfer.
        item.id === action.id && (item.status === "transferring" || item.status === 'committing' || item.status === 'cancelled' && action.committed === true)
          ? {
              ...item,
              status: "completed" as const,
              progress: 100,
              ...(action.destinationPath ? { destinationPath: action.destinationPath, fileName: action.destinationPath.split('/').pop() ?? item.fileName } : {}),
              completedAt: Date.now(),
            }
          : item,
      );
    }

    case "FAIL": {
      return state.map((item) =>
        item.id === action.id && ['transferring', 'waiting', 'committing'].includes(item.status)
          ? {
              ...item,
              status: "failed" as const,
              error: action.error,
              completedAt: Date.now(),
            }
          : item,
      );
    }

    case "CANCEL": {
      return state.map((item) =>
        item.id === action.id && item.status !== "completed" && item.status !== 'committing'
          ? { ...item, status: "cancelled" as const, completedAt: Date.now() }
          : item,
      );
    }

    case "RETRY": {
      return state.map((item) =>
        item.id === action.id &&
        (item.status === "failed" || item.status === "cancelled")
          ? {
              ...item,
              status: "queued" as const,
              progress: 0,
              bytesTransferred: 0,
              speed: 0,
              error: undefined,
              expectedTarget: undefined,
              conflictPolicy: 'ask',
              skip: false,
              startedAt: undefined,
              completedAt: undefined,
            }
          : item,
      );
    }

    case 'EXPIRE_APPROVALS': {
      return state.map(item => item.connectionId === action.connectionId && item.direction === 'upload' && item.status === 'queued'
        ? { ...item, expectedTarget: undefined, conflictPolicy: 'ask' } : item);
    }

    case "CLEAR_COMPLETED": {
      return state.filter(
        (item) =>
          item.status !== "completed" &&
          item.status !== "failed" &&
          item.status !== "cancelled" && item.status !== 'skipped',
      );
    }

    case "CLEAR_ALL": {
      // Only keep items that are currently transferring
      return state.filter((item) => item.status === "transferring" || item.status === 'committing');
    }

    default:
      return state;
  }
}

// ---- Selectors ----

export function getActiveTransferCount(state: TransferItem[]): number {
  return state.filter(
    (item) => ['queued', 'transferring', 'waiting', 'committing'].includes(item.status),
  ).length;
}

export function getNextQueuedTransfer(
  state: TransferItem[],
): TransferItem | undefined {
  const hasTransferring = state.some(
    (item) => item.status === "transferring" || item.status === 'committing',
  );
  if (hasTransferring) return undefined;
  return state.find((item) => item.status === "queued");
}
