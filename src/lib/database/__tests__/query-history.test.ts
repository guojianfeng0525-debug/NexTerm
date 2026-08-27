import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addQueryHistory,
  clearQueryHistory,
  loadQueryHistory,
  QUERY_HISTORY_CHANGED_EVENT,
  removeQueryHistory,
} from "../query-history";

const BASE = {
  sql: "SELECT 1;",
  connectionId: "conn-a",
  connectionName: "Local",
  providerId: "postgresql" as const,
  success: true,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addQueryHistory", () => {
  it("stores a new entry with id and executedAt and returns it on load", () => {
    addQueryHistory(BASE);
    const entries = loadQueryHistory("postgresql");
    expect(entries).toHaveLength(1);
    expect(entries[0].sql).toBe("SELECT 1;");
    expect(entries[0].id).toBeTruthy();
    expect(entries[0].executedAt).toBeGreaterThan(0);
  });

  it("de-duplicates same sql + connectionId by moving to top and refreshing state", () => {
    const before = Date.now();
    addQueryHistory(BASE);
    addQueryHistory({ ...BASE, success: false });
    addQueryHistory({ ...BASE, connectionId: "conn-b" });

    const entries = loadQueryHistory("postgresql");
    expect(entries).toHaveLength(2);
    // Latest add (conn-b) sits on top; the repeated (sql, conn-a) pair
    // collapsed into a single entry with the refreshed failure state.
    expect(entries[0].connectionId).toBe("conn-b");
    expect(entries[1].connectionId).toBe("conn-a");
    expect(entries[1].success).toBe(false);
    expect(entries[1].executedAt).toBeGreaterThanOrEqual(before);
  });

  it("caps the list at 200 entries, dropping the oldest", () => {
    for (let i = 0; i < 205; i += 1) {
      addQueryHistory({ ...BASE, sql: `SELECT ${i};` });
    }
    const entries = loadQueryHistory("postgresql");
    expect(entries).toHaveLength(200);
    expect(entries[0].sql).toBe("SELECT 204;");
    expect(entries[199].sql).toBe("SELECT 5;");
    expect(entries.some((e) => e.sql === "SELECT 4;")).toBe(false);
  });

  it("dispatches the changed event with the provider id", () => {
    const listener = vi.fn();
    window.addEventListener(QUERY_HISTORY_CHANGED_EVENT, listener);
    addQueryHistory(BASE);
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{ providerId: string }>;
    expect(event.detail.providerId).toBe("postgresql");
    window.removeEventListener(QUERY_HISTORY_CHANGED_EVENT, listener);
  });
});

describe("per-provider isolation", () => {
  it("keys storage by provider id", () => {
    addQueryHistory(BASE);
    addQueryHistory({ ...BASE, providerId: "mysql" });
    addQueryHistory({ ...BASE, providerId: "sqlite" });

    expect(loadQueryHistory("postgresql")).toHaveLength(1);
    expect(loadQueryHistory("mysql")).toHaveLength(1);
    expect(loadQueryHistory("sqlite")).toHaveLength(1);
    expect(loadQueryHistory("postgresql")[0].providerId).toBe("postgresql");
  });

  it("returns [] for providers with no history or corrupt data", () => {
    expect(loadQueryHistory("mysql")).toEqual([]);
    localStorage.setItem("nexterm.dbQueryHistory.mysql", "not json");
    expect(loadQueryHistory("mysql")).toEqual([]);
  });
});

describe("removeQueryHistory", () => {
  it("removes only the matching entry and dispatches the event", () => {
    addQueryHistory(BASE);
    addQueryHistory({ ...BASE, sql: "SELECT 2;" });
    const target = loadQueryHistory("postgresql").find((e) => e.sql === "SELECT 2;")!;

    const listener = vi.fn();
    window.addEventListener(QUERY_HISTORY_CHANGED_EVENT, listener);
    removeQueryHistory("postgresql", target.id);

    const entries = loadQueryHistory("postgresql");
    expect(entries).toHaveLength(1);
    expect(entries[0].sql).toBe("SELECT 1;");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(QUERY_HISTORY_CHANGED_EVENT, listener);
  });
});

describe("clearQueryHistory", () => {
  it("removes all entries for the provider and dispatches the event", () => {
    addQueryHistory(BASE);
    addQueryHistory({ ...BASE, providerId: "mysql" });

    const listener = vi.fn();
    window.addEventListener(QUERY_HISTORY_CHANGED_EVENT, listener);
    clearQueryHistory("postgresql");

    expect(loadQueryHistory("postgresql")).toEqual([]);
    expect(loadQueryHistory("mysql")).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(QUERY_HISTORY_CHANGED_EVENT, listener);
  });
});
