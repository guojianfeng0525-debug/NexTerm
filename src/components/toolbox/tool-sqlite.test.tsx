import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQLiteConnectionProfile } from "@/lib/database/sqlite-profile";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  load: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
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
vi.mock("@/components/code-editor", () => ({ CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="SQL editor" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("@/components/toolbox/database-navigator", () => ({ DatabaseNavigator: () => <div data-testid="shared-database-navigator" /> }));
vi.mock("@/components/toolbox/database-result-pane", () => ({ DatabaseResultPane: () => <div data-testid="shared-database-result-pane" /> }));

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
