import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DatabaseConnectionDialogShell,
  DatabaseConnectionField,
  DatabaseConnectionFormGrid,
} from "./database-connection-dialog-shell";

describe("DatabaseConnectionDialogShell", () => {
  it("renders shared sections, grid, and delegates footer actions", () => {
    const onSection = vi.fn();
    const onSave = vi.fn();
    const onPrimary = vi.fn();

    render(
      <DatabaseConnectionDialogShell
        open
        onOpenChange={() => undefined}
        testId="connection-dialog"
        title="Connection Settings"
        sections={[{ id: "general", label: "General" }, { id: "ssh", label: "SSH" }]}
        activeSection="general"
        onActiveSectionChange={onSection}
        saveLabel="Save"
        primaryLabel="Connect"
        onSave={onSave}
        onPrimary={onPrimary}
      >
        <DatabaseConnectionFormGrid>
          <DatabaseConnectionField label="Provider"><input /></DatabaseConnectionField>
          <DatabaseConnectionField label="Name"><input /></DatabaseConnectionField>
        </DatabaseConnectionFormGrid>
      </DatabaseConnectionDialogShell>,
    );

    expect(screen.getByTestId("connection-dialog").className).toContain("w-[720px]");
    expect(screen.getByTestId("connection-dialog").className).toContain("top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2");
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onSection).toHaveBeenCalledWith("ssh");
    expect(onSave).toHaveBeenCalledOnce();
    expect(onPrimary).toHaveBeenCalledOnce();
  });
});
