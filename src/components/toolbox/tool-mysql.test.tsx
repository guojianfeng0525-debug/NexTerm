import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySQLConnectionProfile } from "@/lib/database/mysql-profile";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  load: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  addQueryHistory: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/toolbox/mysql-storage", () => ({
  MySQLConnectionsStorage: {
    load: mocks.load,
    upsert: mocks.upsert,
    remove: mocks.remove,
  },
}));
vi.mock("@/lib/database/query-history", () => ({
  addQueryHistory: mocks.addQueryHistory,
  loadQueryHistory: () => [],
  removeQueryHistory: vi.fn(),
  clearQueryHistory: vi.fn(),
  QUERY_HISTORY_CHANGED_EVENT: "nexterm:db-query-history-changed",
}));
vi.mock("@/components/code-editor", () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="SQL editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/components/toolbox/database-navigator", () => ({
  DatabaseNavigator: () => <div data-testid="shared-database-navigator" />,
}));
vi.mock("@/components/toolbox/database-result-pane", () => ({
  DatabaseResultPane: ({ result, renderError }: { result?: { kind: string; error?: unknown }; renderError?: (error: unknown) => React.ReactNode }) =>
    result?.kind === "error" && renderError && result.error
      ? <>{renderError(result.error)}</>
      : <div data-testid="shared-database-result-pane" />,
}));
vi.mock("@/components/toolbox/query-history-view", () => ({
  QueryHistoryView: () => <div data-testid="mock-query-history-view" />,
}));

import { ToolMySql } from "./tool-mysql";

const profile: MySQLConnectionProfile = {
  id: "mysql-profile",
  name: "Fixture MySQL",
  providerId: "mysql",
  environment: "test",
  createdAt: 1,
  updatedAt: 1,
  providerConfig: {
    host: "127.0.0.1",
    port: 3306,
    database: "fixture",
    username: "root",
    password: "secret",
  },
};

async function connect() {
  fireEvent.click(screen.getByTestId("mysql-edit-connection"));
  const dialog = screen.getByTestId("mysql-connection-dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("mysql_connect", expect.anything()),
  );
}

describe("ToolMySql toolbox menus & errors", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockReturnValue([profile]);
    mocks.upsert.mockResolvedValue(true);
    mocks.remove.mockResolvedValue(true);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "mysql_connect") return Promise.resolve();
      if (command === "mysql_catalog_objects") return Promise.resolve([]);
      return Promise.resolve();
    });
  });

  it("renders the workspace toolbar with a History toggle that swaps the result area", () => {
    render(<ToolMySql />);
    expect(screen.getByTestId("mysql-workspace")).not.toBeNull();
    expect(screen.getByTestId("mysql-history")).not.toBeNull();
    expect(screen.getByTestId("shared-database-result-pane")).not.toBeNull();
    fireEvent.click(screen.getByTestId("mysql-history"));
    expect(screen.getByTestId("mock-query-history-view")).not.toBeNull();
  });

  it("persists a structured error into the result pane and records failed history on execute error", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "mysql_connect") return Promise.resolve();
      if (command === "mysql_catalog_objects") return Promise.resolve([]);
      if (command === "mysql_execute") {
        return Promise.reject(new Error("Error 1064 (42000): You have an error in your SQL syntax"));
      }
      return Promise.resolve();
    });
    render(<ToolMySql />);
    await connect();

    fireEvent.click(screen.getByTestId("mysql-run"));
    await waitFor(() =>
      expect(mocks.addQueryHistory).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "mysql", success: false }),
      ),
    );
    // Structured error renders through DatabaseResultErrorPane (renderError).
    expect(screen.getByTestId("database-result-error")).not.toBeNull();
    expect(screen.getByText(/Error 1064/)).not.toBeNull();
    // Retry re-runs the failed statement.
    fireEvent.click(screen.getByTestId("database-result-error-retry"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "mysql_execute",
        expect.objectContaining({ request: expect.objectContaining({ sql: "SELECT 1;" }) }),
      ),
    );
  });

  it("records successful execution to query history", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "mysql_connect") return Promise.resolve();
      if (command === "mysql_catalog_objects") return Promise.resolve([]);
      if (command === "mysql_execute") {
        return Promise.resolve({
          columns: ["a"],
          rows: [["1"]],
          commandTags: ["OK"],
          truncated: false,
        });
      }
      return Promise.resolve();
    });
    render(<ToolMySql />);
    await connect();

    fireEvent.click(screen.getByTestId("mysql-run"));
    await waitFor(() =>
      expect(mocks.addQueryHistory).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "mysql", success: true }),
      ),
    );
    expect(screen.getByTestId("shared-database-result-pane")).not.toBeNull();
  });
});
