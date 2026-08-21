import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ServiceOrchestrations,
  reorderSteps,
} from '../components/toolbox/tool-service-orchestrations';
import { OrchestrationsStorage, ServicesStorage, TunnelsStorage, resetToolboxStore } from '../lib/toolbox/toolbox-storage';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
  },
}));

// Mock Radix-heavy UI primitives so the tests run in jsdom without portals/animations.
vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock('../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));

vi.mock('../components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? ''}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // SelectItem intentionally renders no children: the option list would
  // duplicate config names already shown in orchestration cards.
  SelectItem: () => <span />,
}));

// @dnd-kit sortable rows use PointerSensor (distance activation) which is hard to
// drive via jsdom fireEvent; the pure reorderSteps helper is tested directly and
// the sortable row renders with a plain div fallback.
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  arrayMove: (arr: unknown[], from: number, to: number) => {
    const next = [...arr];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  },
  verticalListSortingStrategy: {},
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: () => undefined,
  PointerSensor: class {},
  useSensor: (s: unknown) => s,
  useSensors: (...s: unknown[]) => s,
}));

const now = 1_700_000_000_000;

function seed() {
  resetToolboxStore();
  TunnelsStorage.upsert({
    id: 'tunnel-a',
    name: 'MySQL 隧道',
    bindAddress: '127.0.0.1',
    listenPort: 3306,
    remoteHost: 'db.internal',
    remotePort: 3306,
    createdAt: now,
    updatedAt: now,
  });
  TunnelsStorage.upsert({
    id: 'tunnel-b',
    name: 'Redis 隧道',
    bindAddress: '127.0.0.1',
    listenPort: 6379,
    remoteHost: 'redis.internal',
    remotePort: 6379,
    createdAt: now,
    updatedAt: now,
  });
  ServicesStorage.upsert({
    id: 'svc-api',
    name: 'API 服务',
    command: 'npm run dev',
    createdAt: now,
    updatedAt: now,
  });
  ServicesStorage.upsert({
    id: 'svc-web',
    name: 'Web 前端',
    command: 'npm run web',
    createdAt: now,
    updatedAt: now,
  });
}

describe('reorderSteps', () => {
  it('moves an item to the target index', () => {
    const steps = [
      { key: 'a', item: { kind: 'tunnel' as const, id: 't1' } },
      { key: 'b', item: { kind: 'service' as const, id: 's1' } },
      { key: 'c', item: { kind: 'service' as const, id: 's2' } },
    ];
    expect(reorderSteps(steps, 'a', 'c').map((s) => s.key)).toEqual(['b', 'c', 'a']);
  });

  it('handles same-key no-op', () => {
    const steps = [{ key: 'a', item: { kind: 'tunnel' as const, id: 't1' } }];
    expect(reorderSteps(steps, 'a', 'a')).toBe(steps);
  });

  it('handles unknown keys without mutation', () => {
    const steps = [{ key: 'a', item: { kind: 'tunnel' as const, id: 't1' } }];
    expect(reorderSteps(steps, 'zzz', 'a')).toBe(steps);
    expect(reorderSteps(steps, 'a', 'zzz')).toBe(steps);
  });
});

describe('ServiceOrchestrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'dispatchEvent');
    seed();
  });

  afterEach(cleanup);

  it('renders seeded orchestrations with their ordered steps', () => {
    OrchestrationsStorage.upsert({
      id: 'orch-1',
      name: '启动开发环境',
      items: [
        { kind: 'tunnel', id: 'tunnel-a' },
        { kind: 'service', id: 'svc-api' },
        { kind: 'service', id: 'svc-web' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    render(<ServiceOrchestrations />);
    expect(screen.getByText('启动开发环境')).toBeTruthy();
    expect(screen.getByText('MySQL 隧道')).toBeTruthy();
    expect(screen.getByText('API 服务')).toBeTruthy();
    expect(screen.getByText('Web 前端')).toBeTruthy();
  });

  it('runs steps strictly in order and stops at the first failure', async () => {
    OrchestrationsStorage.upsert({
      id: 'orch-2',
      name: '失败即停流程',
      items: [
        { kind: 'tunnel', id: 'tunnel-a' },
        { kind: 'service', id: 'svc-api' },
        { kind: 'service', id: 'svc-web' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'tunnel_start') return undefined;
      if (command === 'service_start' && mocks.invoke.mock.calls.filter((c) => c[0] === 'service_start').length === 1) {
        throw new Error('port in use');
      }
      return undefined;
    });
    render(<ServiceOrchestrations />);

    // Click the flow's Start button.
    const startButtons = screen.getAllByRole('button', { name: /Start/ });
    // The seeded flow renders exactly one orchestration card with one Start button.
    await act(async () => {
      fireEvent.click(startButtons[0]);
    });

    const calls = mocks.invoke.mock.calls.map((c) => c[0]).filter((c) => c === 'tunnel_start' || c === 'service_start');
    // tunnel_start first, then one service_start; the second service_start must
    // never run because the first failed (fail-fast).
    expect(calls).toEqual(['tunnel_start', 'service_start']);
    expect(mocks.error).toHaveBeenCalled();
  });

  it('runs every step when all succeed, in order', async () => {
    OrchestrationsStorage.upsert({
      id: 'orch-3',
      name: '全成功流程',
      items: [
        { kind: 'tunnel', id: 'tunnel-b' },
        { kind: 'service', id: 'svc-api' },
        { kind: 'service', id: 'svc-web' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    mocks.invoke.mockResolvedValue(undefined);
    render(<ServiceOrchestrations />);

    const startButtons = screen.getAllByRole('button', { name: /Start/ });
    await act(async () => {
      fireEvent.click(startButtons[0]);
    });

    const calls = mocks.invoke.mock.calls.map((c) => c[0]).filter((c) => c === 'tunnel_start' || c === 'service_start');
    expect(calls).toEqual(['tunnel_start', 'service_start', 'service_start']);
    expect(mocks.success).toHaveBeenCalled();
    // The window event lets the tunnels/services views resync their running state.
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'nexterm:orchestration-ran' }),
    );
  });

  it('skips a flow whose config references were deleted (missing config)', async () => {
    OrchestrationsStorage.upsert({
      id: 'orch-4',
      name: '缺失配置流程',
      items: [
        { kind: 'tunnel', id: 'ghost-tunnel' },
        { kind: 'service', id: 'svc-api' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    mocks.invoke.mockResolvedValue(undefined);
    render(<ServiceOrchestrations />);

    const startButtons = screen.getAllByRole('button', { name: /Start/ });
    await act(async () => {
      fireEvent.click(startButtons[0]);
    });

    // First step fails-fast (config missing) → no start commands invoked.
    const startCalls = mocks.invoke.mock.calls
      .map((c) => c[0])
      .filter((c) => c === 'tunnel_start' || c === 'service_start');
    expect(startCalls).toEqual([]);
    expect(mocks.error).toHaveBeenCalled();
  });
});
