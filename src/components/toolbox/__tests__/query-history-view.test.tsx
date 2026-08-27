import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  QueryHistoryView,
  type QueryHistoryViewLabels,
} from "@/components/toolbox/query-history-view";
import type { QueryHistoryEntry } from "@/lib/database/query-history";

const mocks = vi.hoisted(() => ({
  loadQueryHistory: vi.fn(),
  removeQueryHistory: vi.fn(),
  clearQueryHistory: vi.fn(),
}));

vi.mock("@/lib/database/query-history", () => ({
  loadQueryHistory: mocks.loadQueryHistory,
  addQueryHistory: vi.fn(),
  removeQueryHistory: mocks.removeQueryHistory,
  clearQueryHistory: mocks.clearQueryHistory,
  QUERY_HISTORY_CHANGED_EVENT: "nexterm:db-query-history-changed",
}));

const labels: QueryHistoryViewLabels = {
  history: "历史",
  empty: "暂无查询历史",
  run: "再次执行",
  insertToEditor: "插入到编辑器",
  copy: "复制 SQL",
  remove: "删除本条",
  clear: "清空历史",
  time: "执行时间",
  clearConfirmTitle: "清空历史？",
  clearConfirmDescription: "将删除当前连接的全部历史记录。",
  cancel: "取消",
};

const entries: readonly QueryHistoryEntry[] = [
  {
    id: "1",
    sql: "SELECT * FROM users LIMIT 100;",
    connectionId: "conn-a",
    connectionName: "A",
    providerId: "postgresql",
    executedAt: 1000,
    success: true,
  },
  {
    id: "2",
    sql: "UPDATE orders SET status='x' WHERE id=1;",
    connectionId: "conn-a",
    connectionName: "A",
    providerId: "postgresql",
    executedAt: 2000,
    success: false,
  },
  {
    id: "3",
    sql: "SELECT 1;",
    connectionId: "conn-b",
    connectionName: "B",
    providerId: "postgresql",
    executedAt: 3000,
    success: true,
  },
];

function renderView(overrides: Partial<Parameters<typeof QueryHistoryView>[0]> = {}) {
  return render(
    <QueryHistoryView
      open
      onOpenChange={() => undefined}
      providerId="postgresql"
      connectionId="conn-a"
      labels={labels}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadQueryHistory.mockReturnValue(entries);
});

describe("QueryHistoryView", () => {
  it("renders nothing when closed", () => {
    renderView({ open: false });
    expect(screen.queryByTestId("query-history-view")).toBeNull();
  });

  it("shows the empty state when there is no history", () => {
    mocks.loadQueryHistory.mockReturnValue([]);
    renderView();
    expect(screen.getByText("暂无查询历史")).not.toBeNull();
  });

  it("filters entries by the current connection", () => {
    renderView();
    expect(screen.getByTestId("query-history-item-0").textContent).toContain(
      "SELECT * FROM users",
    );
    expect(screen.getByTestId("query-history-item-1").textContent).toContain(
      "UPDATE orders",
    );
    // conn-b entry excluded.
    expect(screen.queryByText("SELECT 1;")).toBeNull();
  });

  it("dispatches nexterm:db-query-history-execute from the context menu", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    renderView();
    fireEvent.contextMenu(screen.getByTestId("query-history-item-0"));
    const menuItem = await screen.findByTestId("query-history-menu-run");
    fireEvent.click(menuItem);
    const event = dispatchSpy.mock.calls
      .map(([arg]) => arg)
      .find((e) => e.type === "nexterm:db-query-history-execute") as CustomEvent<{
      providerId: string;
      sql: string;
      connectionId: string;
    }>;
    expect(event).toBeDefined();
    expect(event.detail).toEqual({
      providerId: "postgresql",
      sql: "SELECT * FROM users LIMIT 100;",
      connectionId: "conn-a",
    });
  });

  it("dispatches nexterm:db-query-history-insert from the context menu", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    renderView();
    fireEvent.contextMenu(screen.getByTestId("query-history-item-1"));
    const menuItem = await screen.findByTestId("query-history-menu-insert");
    fireEvent.click(menuItem);
    const event = dispatchSpy.mock.calls
      .map(([arg]) => arg)
      .find((e) => e.type === "nexterm:db-query-history-insert") as CustomEvent<{
      providerId: string;
      sql: string;
    }>;
    expect(event).toBeDefined();
    expect(event.detail).toEqual({
      providerId: "postgresql",
      sql: "UPDATE orders SET status='x' WHERE id=1;",
    });
  });

  it("removes one entry via the context menu and calls removeQueryHistory", async () => {
    renderView();
    fireEvent.contextMenu(screen.getByTestId("query-history-item-0"));
    const menuItem = await screen.findByTestId("query-history-menu-remove");
    fireEvent.click(menuItem);
    expect(mocks.removeQueryHistory).toHaveBeenCalledWith("postgresql", "1");
  });

  it("clears all history through the confirmed AlertDialog", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("query-history-clear"));
    expect(screen.getByText("清空历史？")).not.toBeNull();
    fireEvent.click(screen.getByTestId("query-history-clear-confirm"));
    expect(mocks.clearQueryHistory).toHaveBeenCalledWith("postgresql");
  });
});
