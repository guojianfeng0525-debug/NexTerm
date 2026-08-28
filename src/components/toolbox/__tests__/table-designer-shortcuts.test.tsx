import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TableDesignerTab } from "@/components/toolbox/table-designer-tab";
import type { TableDesign } from "@/lib/database/table-design";

const design: TableDesign = {
  schema: "public",
  table: "users",
  columns: [],
  primaryKey: null,
  constraints: [],
  indexes: [],
  foreignKeys: [],
  comment: null,
  hasData: false,
};

afterEach(cleanup);

describe("TableDesignerTab shortcuts", () => {
  const onSaveShortcut = vi.fn();
  const onRevertShortcut = vi.fn();
  const onRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderDesigner(overrides: Partial<React.ComponentProps<typeof TableDesignerTab>> = {}) {
    const onLoad = vi.fn().mockResolvedValue(design);
    const onApply = vi
      .fn()
      .mockResolvedValue({ ddl: "", warnings: [], applied: true });
    const utils = render(
      <TableDesignerTab
        connectionId="conn-1"
        schema="public"
        table="users"
        onLoad={onLoad}
        onApply={onApply}
        onRefresh={onRefresh}
        readOnly={false}
        onSaveShortcut={onSaveShortcut}
        onRevertShortcut={onRevertShortcut}
        {...overrides}
      />,
    );
    // Wait until the loading placeholder is replaced by the designer root.
    await screen.findByTestId("table-designer");
    return utils;
  }

  it("renders a table-designer anchor for the DESIGNER scope", async () => {
    await renderDesigner();
    expect(screen.getByTestId("table-designer")).not.toBeNull();
    expect(screen.getByTestId("table-designer-tab")).not.toBeNull();
  });

  it("fires onSaveShortcut on Ctrl+S", async () => {
    await renderDesigner();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(onSaveShortcut).toHaveBeenCalledTimes(1);
  });

  it("does not fire onRevertShortcut for Escape while typing in an input", async () => {
    await renderDesigner();
    // The table-comment input is always rendered in normal mode.
    const comment = screen.getByPlaceholderText("—");
    fireEvent.keyDown(comment, { key: "Escape" });
    expect(onRevertShortcut).not.toHaveBeenCalled();
  });

  it("fires onRevertShortcut for Escape outside an editable field", async () => {
    await renderDesigner();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onRevertShortcut).toHaveBeenCalledTimes(1);
  });

  it("still applies via the internal handler when no shortcut callback is provided", async () => {
    const onApply = vi
      .fn()
      .mockResolvedValue({ ddl: "", warnings: [], applied: true });
    render(
      <TableDesignerTab
        connectionId="conn-1"
        schema="public"
        table="users"
        onLoad={vi.fn().mockResolvedValue(design)}
        onApply={onApply}
        onRefresh={onRefresh}
        readOnly={false}
      />,
    );
    await screen.findByTestId("table-designer");
    // Make an actual change so Ctrl+S produces a non-empty diff to apply.
    const comment = screen.getByPlaceholderText("—");
    fireEvent.change(comment, { target: { value: "hello" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(onApply).toHaveBeenCalled();
  });
});
