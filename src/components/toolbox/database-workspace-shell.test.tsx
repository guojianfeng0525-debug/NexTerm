import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabaseWorkspaceShell } from "./database-workspace-shell";

describe("DatabaseWorkspaceShell", () => {
  it("renders all shared regions and delegates tab commands", () => {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    render(
      <DatabaseWorkspaceShell
        testId="workspace"
        toolbar={<button type="button">Connect</button>}
        navigator={<aside>Navigator</aside>}
        tabs={[{ id: "query-1", title: "Query" }]}
        activeTabId="query-1"
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        tabClassName={() => "tab"}
        workspace={<div>Editor and result</div>}
        status={<footer>Ready</footer>}
      />,
    );

    expect(screen.getByTestId("workspace")).not.toBeNull();
    expect(screen.getByText("Connect")).not.toBeNull();
    expect(screen.getByText("Navigator")).not.toBeNull();
    expect(screen.getByText("Editor and result")).not.toBeNull();
    expect(screen.getByText("Ready")).not.toBeNull();
    fireEvent.click(screen.getByText("Query"));
    expect(onActivateTab).toHaveBeenCalledWith("query-1");
    fireEvent.click(screen.getByTestId("database-workspace-close-query-1"));
    expect(onCloseTab).toHaveBeenCalledWith("query-1");
  });
});
