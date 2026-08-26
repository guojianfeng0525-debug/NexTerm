import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import type { DatabaseObjectNode } from "@/lib/database/types";
import {
  groupConnectionsByGroup,
  listConnectionGroupNames,
} from "@/lib/database/connection-groups";
import type { PostgreSQLConnectionProfile } from "@/lib/database/postgresql-profile-adapter";

function makeNode(overrides: Partial<DatabaseObjectNode>): DatabaseObjectNode {
  return {
    id: overrides.id ?? ("id" as DatabaseObjectNode["id"]),
    providerId: "postgresql",
    kind: overrides.kind ?? "object",
    label: overrides.label ?? "node",
    iconRole: overrides.iconRole ?? "table",
    expandable: overrides.expandable ?? false,
    selectable: overrides.selectable ?? true,
    openable: overrides.openable ?? true,
    reference: { providerId: "postgresql", path: [] },
    ...overrides,
  };
}

function renderNavigator(nodes: readonly DatabaseObjectNode[], handlers: {
  onSelect?: (node: DatabaseObjectNode) => void;
  onToggle?: (node: DatabaseObjectNode) => void;
  onOpen?: (node: DatabaseObjectNode) => void;
} = {}) {
  return render(
    <DatabaseNavigator
      roots={nodes}
      childrenByParent={{}}
      expanded={{}}
      selectedNodeId={null}
      filter=""
      onToggle={handlers.onToggle ?? vi.fn()}
      onSelect={handlers.onSelect ?? vi.fn()}
      onOpen={handlers.onOpen ?? vi.fn()}
    />,
  );
}

describe("DatabaseNavigator interaction semantics (B21)", () => {
  afterEach(() => cleanup());

  it("single-click selects and toggles expandable nodes but never opens", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const table = makeNode({ id: "t1" as DatabaseObjectNode["id"], label: "orders", expandable: true, openable: true });
    renderNavigator([table], { onSelect, onToggle, onOpen });

    fireEvent.click(screen.getByText("orders"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("single-click on a leaf object only selects (no open, no toggle)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const leaf = makeNode({ id: "f1" as DatabaseObjectNode["id"], label: "add", openable: true });
    renderNavigator([leaf], { onSelect, onToggle, onOpen });

    fireEvent.click(screen.getByText("add"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("double-click opens openable nodes (two clicks + one open)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const table = makeNode({ id: "t2" as DatabaseObjectNode["id"], label: "users", expandable: true, openable: true });
    renderNavigator([table], { onSelect, onToggle, onOpen });

    // Real double-click: two click events then a dblclick event.
    const button = screen.getByText("users");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.doubleClick(button);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(2);
    // Expandable openable node: both clicks toggle (net unchanged).
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("double-click on an expandable non-openable group toggles it (net single toggle)", () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const group = makeNode({
      id: "g1" as DatabaseObjectNode["id"],
      kind: "group",
      label: "Tables",
      iconRole: "group",
      expandable: true,
      openable: false,
    });
    renderNavigator([group], { onToggle, onOpen });

    const button = screen.getByText("Tables");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.doubleClick(button);

    // Two clicks each toggle + one explicit dblclick toggle = net open state.
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Enter opens openable nodes and prevents the default click", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const table = makeNode({ id: "t3" as DatabaseObjectNode["id"], label: "orders", expandable: true, openable: true });
    renderNavigator([table], { onOpen, onToggle });

    const button = screen.getByText("orders");
    fireEvent.keyDown(button, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("Enter does nothing for non-openable nodes", () => {
    const onOpen = vi.fn();
    const connection = makeNode({
      id: "c1" as DatabaseObjectNode["id"],
      kind: "connection",
      label: "prod",
      iconRole: "connection",
      expandable: true,
      openable: false,
    });
    renderNavigator([connection], { onOpen });

    fireEvent.keyDown(screen.getByText("prod"), { key: "Enter" });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders the accent color dot on connection nodes", () => {
    const node = makeNode({
      id: "c2" as DatabaseObjectNode["id"],
      kind: "connection",
      label: "prod",
      iconRole: "connection",
      openable: false,
      accentColor: "#ef4444",
    });
    renderNavigator([node]);

    const dot = screen.getByTestId("database-navigator-accent");
    expect(dot).toBeDefined();
    expect((dot as HTMLElement).style.backgroundColor).toBe("rgb(239, 68, 68)");
  });

  it("renders the lifecycle status badge with the right status", () => {
    const node = makeNode({
      id: "c3" as DatabaseObjectNode["id"],
      kind: "connection",
      label: "prod",
      iconRole: "connection",
      openable: false,
      statusBadge: "connected",
    });
    renderNavigator([node]);

    const badge = screen.getByTestId("database-navigator-status");
    expect(badge.getAttribute("data-status")).toBe("connected");
  });

  it("renders the meta badge text", () => {
    const node = makeNode({
      id: "c4" as DatabaseObjectNode["id"],
      kind: "connection",
      label: "prod",
      iconRole: "connection",
      openable: false,
      metaBadge: "5",
    });
    renderNavigator([node]);
    expect(screen.getByText("5")).toBeDefined();
  });

  it("renders a virtual connection group header node", () => {
    const node = makeNode({
      id: "g2" as DatabaseObjectNode["id"],
      kind: "group",
      label: "prod",
      iconRole: "group",
      expandable: true,
      openable: false,
      groupKind: "connection",
    });
    const { container } = renderNavigator([node]);
    expect(container.querySelector("[data-node-id]")?.getAttribute("data-node-id")).toBe("g2");
    // Group header style includes uppercase tracking.
    expect(container.textContent).toContain("prod");
  });
});

describe("connection grouping (B22)", () => {
  const profile = (id: string, name: string, group?: string): PostgreSQLConnectionProfile => ({
    id,
    name,
    providerId: "postgresql",
    group,
    environment: "development",
    createdAt: 1,
    updatedAt: 1,
    providerConfig: { host: "h", port: 5432, database: "d", username: "u", readOnly: false, autoCommit: true, sslMode: "prefer", sshEnabled: false },
  });

  it("groups by group field, sorts members by name, ungrouped last", () => {
    const grouped = groupConnectionsByGroup([
      profile("1", "zeta"),
      profile("2", "alpha", "prod"),
      profile("3", "beta", "prod"),
      profile("4", "gamma", "dev"),
    ]);

    expect(grouped).toHaveLength(3);
    expect(grouped[0].groupName).toBe("dev");
    expect(grouped[0].connections.map((c) => c.name)).toEqual(["gamma"]);
    expect(grouped[1].groupName).toBe("prod");
    expect(grouped[1].connections.map((c) => c.name)).toEqual(["alpha", "beta"]);
    expect(grouped[2].groupName).toBeNull();
    expect(grouped[2].connections.map((c) => c.name)).toEqual(["zeta"]);
  });

  it("omits the ungrouped bucket when every connection is grouped", () => {
    const grouped = groupConnectionsByGroup([profile("1", "a", "g"), profile("2", "b", "g")]);
    expect(grouped).toHaveLength(1);
  });

  it("lists distinct group names sorted", () => {
    const names = listConnectionGroupNames([
      profile("1", "a", "prod"),
      profile("2", "b", "dev"),
      profile("3", "c", "prod"),
      profile("4", "d"),
    ]);
    expect(names).toEqual(["dev", "prod"]);
  });
});
