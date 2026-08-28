import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQLiteConnectionProfile } from "@/lib/database/sqlite-profile";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  load: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  addQueryHistory: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/lib/toolbox/sqlite-storage", () => ({
  SqliteConnectionsStorage: {
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
vi.mock("@/components/code-editor", () => ({ CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="SQL editor" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("@/components/toolbox/database-navigator", () => ({ DatabaseNavigator: () => <div data-testid="shared-database-navigator" /> }));
vi.mock("@/components/toolbox/database-result-pane", () => ({
  DatabaseResultPane: ({ result, renderError }: { result?: { kind: string; error?: unknown }; renderError?: (error: unknown) => React.ReactNode }) =>
    result?.kind === "error" && renderError && result.error
      ? <>{renderError(result.error)}</>
      : <div data-testid="shared-database-result-pane" />,
}));
vi.mock("@/components/toolbox/query-history-view", () => ({
  QueryHistoryView: () => <div data-testid="mock-query-history-view" />,
}));

import { ToolSqlite } from "./tool-sqlite";

const profile: SQLiteConnectionProfile = {
  id: "sqlite-profile",
  name: "Fixture SQLite",
  providerId: "sqlite",
  environment: "test",
  createdAt: 1,
  updatedAt: 1,
  providerConfig: { filePath: "/fixtures/original.db", readOnly: false },
};

describe("ToolSqlite profile form", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockReturnValue([profile]);
    mocks.upsert.mockResolvedValue(true);
    mocks.remove.mockResolvedValue(true);
  });

  it("shows only SQLite file-backed fields and persists edits before reporting success", async () => {
    render(<ToolSqlite />);
    fireEvent.click(screen.getByTestId("sqlite-edit-connection"));

    const dialog = screen.getByTestId("sqlite-connection-dialog");
    expect(dialog.textContent).toContain("SQLite (Experimental)");
    expect(screen.getByDisplayValue("Fixture SQLite")).not.toBeNull();
    expect(screen.getByDisplayValue("/fixtures/original.db")).not.toBeNull();
    expect(dialog.querySelector('input[value="127.0.0.1"]')).toBeNull();
    expect(dialog.textContent).not.toContain("SSH");
    expect(dialog.textContent).not.toContain("SSL / TLS");

    fireEvent.change(screen.getByDisplayValue("/fixtures/original.db"), { target: { value: "/fixtures/edited.db" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: { filePath: "/fixtures/edited.db", readOnly: false } })));
  });

  it("keeps a profile in memory when persistent deletion fails", async () => {
    mocks.remove.mockResolvedValue(false);
    render(<ToolSqlite />);
    fireEvent.click(screen.getByTestId("sqlite-delete-connection"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(profile.id));
    const editButton = screen.getByTestId("sqlite-edit-connection");
    if (!(editButton instanceof HTMLButtonElement)) throw new Error("expected edit button");
    expect(editButton.disabled).toBe(false);
  });

  it("removes the active profile from in-memory state only after persistent deletion succeeds", async () => {
    mocks.remove.mockImplementation(async () => {
      mocks.load.mockReturnValue([]);
      window.dispatchEvent(new Event("nexterm:toolbox-changed"));
      return true;
    });
    render(<ToolSqlite />);
    fireEvent.click(screen.getByTestId("sqlite-delete-connection"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const editButton = screen.getByTestId("sqlite-edit-connection");
      if (!(editButton instanceof HTMLButtonElement)) throw new Error("expected edit button");
      expect(editButton.disabled).toBe(true);
    });
  });
});

describe("ToolSqlite toolbox menus, shortcuts & errors", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockReturnValue([profile]);
    mocks.upsert.mockResolvedValue(true);
    mocks.remove.mockResolvedValue(true);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "sqlite_connect") return Promise.resolve();
      if (command === "sqlite_catalog_objects") return Promise.resolve([]);
      return Promise.resolve();
    });
  });

  async function connect() {
    fireEvent.click(screen.getByTestId("sqlite-edit-connection"));
    const dialog = screen.getByTestId("sqlite-connection-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("sqlite_connect", expect.anything()),
    );
  }

  it("renders the workspace with a History toggle that swaps the result area", () => {
    render(<ToolSqlite />);
    expect(screen.getByTestId("sqlite-workspace")).not.toBeNull();
    expect(screen.getByTestId("sqlite-history")).not.toBeNull();
    expect(screen.getByTestId("shared-database-result-pane")).not.toBeNull();
    fireEvent.click(screen.getByTestId("sqlite-history"));
    expect(screen.getByTestId("mock-query-history-view")).not.toBeNull();
  });

  it("persists a structured error into the result pane and records failed history on execute error", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "sqlite_connect") return Promise.resolve();
      if (command === "sqlite_catalog_objects") return Promise.resolve([]);
      if (command === "sqlite_execute") {
        return Promise.reject(new Error("SQLite query failed: error returned from database: near \"SELEC\": syntax error"));
      }
      return Promise.resolve();
    });
    render(<ToolSqlite />);
    await connect();

    fireEvent.click(screen.getByTestId("sqlite-run"));
    await waitFor(() =>
      expect(mocks.addQueryHistory).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "sqlite", success: false }),
      ),
    );
    // Structured error renders through DatabaseResultErrorPane (renderError).
    const errorPane = screen.getByTestId("database-result-error");
    expect(errorPane).not.toBeNull();
    expect(errorPane.textContent).toContain("syntax error");
    // Retry re-runs the failed statement.
    fireEvent.click(screen.getByTestId("database-result-error-retry"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "sqlite_execute",
        expect.objectContaining({
          request: expect.objectContaining({
            sql: "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;",
          }),
        }),
      ),
    );
  });

  it("records successful execution to query history", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "sqlite_connect") return Promise.resolve();
      if (command === "sqlite_catalog_objects") return Promise.resolve([]);
      if (command === "sqlite_execute") {
        return Promise.resolve({
          columns: ["name"],
          rows: [["users"]],
          rowsAffected: 0,
          truncated: false,
        });
      }
      return Promise.resolve();
    });
    render(<ToolSqlite />);
    await connect();

    fireEvent.click(screen.getByTestId("sqlite-run"));
    await waitFor(() =>
      expect(mocks.addQueryHistory).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "sqlite", success: true }),
      ),
    );
    expect(screen.getByTestId("shared-database-result-pane")).not.toBeNull();
  });
});
