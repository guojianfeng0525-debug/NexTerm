import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isTerminalTarget,
  resolveScope,
  routeKeyEvent,
  type CommandBinding,
  type ScopeContext,
} from "../scope-router";
import { NAVICAT_BINDINGS, TERMINAL_RESERVED_COMBOS } from "../bindings";
import { commandsWithBindings, DATABASE_COMMAND_IDS } from "../../database/command-registry";

function anchorContext(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    dialogOpen: false,
    activeElement: null,
    anchors: {
      queryEditor: ".cm-editor",
      dataGrid: '[data-testid="postgres-workspace"]',
      navigator: '[data-testid="database-navigator"]',
    },
    ...overrides,
  };
}

function keyEvent(init: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  target?: Element | null;
}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (init.target !== undefined) {
    Object.defineProperty(event, "target", { value: init.target, configurable: true });
  }
  return event;
}

const bindings: readonly CommandBinding[] = [
  { commandId: "database.data.filterSort", combo: "Ctrl+R", scopes: ["DATA_GRID"] },
  { commandId: "database.query.execute", combo: "Ctrl+Shift+R", scopes: ["QUERY_EDITOR"] },
  { commandId: "database.workspace.newQuery", combo: "Ctrl+N", scopes: ["DATABASE_WORKSPACE"] },
  { commandId: "database.tab.close", combo: "Ctrl+W", scopes: ["DATABASE_WORKSPACE", "DATA_GRID"] },
];

describe("isTerminalTarget (xterm hard boundary)", () => {
  it("returns true for elements inside .xterm", () => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const textarea = document.createElement("textarea");
    terminal.appendChild(textarea);
    expect(isTerminalTarget(textarea)).toBe(true);
  });

  it("returns false for ordinary inputs", () => {
    const input = document.createElement("input");
    expect(isTerminalTarget(input)).toBe(false);
  });
});

describe("resolveScope (D2 priority)", () => {
  it("DIALOG wins over every focused scope", () => {
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    const context = anchorContext({ dialogOpen: true, activeElement: cm });
    expect(resolveScope(context)).toBe("DIALOG");
  });

  it("QUERY_EDITOR when CodeMirror is focused", () => {
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    expect(resolveScope(anchorContext({ activeElement: cm }))).toBe("QUERY_EDITOR");
  });

  it("DATA_GRID when the grid container is focused", () => {
    const grid = document.createElement("div");
    grid.setAttribute("data-testid", "postgres-workspace");
    expect(resolveScope(anchorContext({ activeElement: grid }))).toBe("DATA_GRID");
  });

  it("NAVIGATOR when the tree is focused", () => {
    const nav = document.createElement("div");
    nav.setAttribute("data-testid", "database-navigator");
    expect(resolveScope(anchorContext({ activeElement: nav }))).toBe("NAVIGATOR");
  });

  it("falls back to DATABASE_WORKSPACE for unmatched focus", () => {
    const body = document.createElement("body");
    expect(resolveScope(anchorContext({ activeElement: body }))).toBe("DATABASE_WORKSPACE");
  });
});

describe("routeKeyEvent (scope priority routing)", () => {
  it("routes Ctrl+R to filterSort in DATA_GRID, not the query binding", () => {
    const event = keyEvent({ key: "r", ctrlKey: true });
    const result = routeKeyEvent(event, "DATA_GRID", bindings);
    expect(result?.commandId).toBe("database.data.filterSort");
  });

  it("routes Ctrl+Shift+R to query.execute in QUERY_EDITOR", () => {
    const event = keyEvent({ key: "r", ctrlKey: true, shiftKey: true });
    const result = routeKeyEvent(event, "QUERY_EDITOR", bindings);
    expect(result?.commandId).toBe("database.query.execute");
  });

  it("returns null for unbound combos (no preventDefault)", () => {
    const event = keyEvent({ key: "f5" });
    expect(routeKeyEvent(event, "DATA_GRID", bindings)).toBeNull();
  });

  it("returns null when the target is inside xterm", () => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const event = keyEvent({ key: "r", ctrlKey: true, target: terminal });
    expect(routeKeyEvent(event, "DATA_GRID", bindings)).toBeNull();
  });
});

describe("macOS Cmd/Ctrl equivalence", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(navigator, "platform", { value: "", configurable: true });
  });

  it("treats Cmd as Ctrl on Mac for a Ctrl binding", () => {
    const event = keyEvent({ key: "r", metaKey: true });
    const result = routeKeyEvent(event, "DATA_GRID", bindings);
    expect(result?.commandId).toBe("database.data.filterSort");
  });

  it("still matches Ctrl on Mac", () => {
    const event = keyEvent({ key: "r", ctrlKey: true });
    const result = routeKeyEvent(event, "DATA_GRID", bindings);
    expect(result?.commandId).toBe("database.data.filterSort");
  });
});

describe("NAVICAT_BINDINGS completeness (18 groups)", () => {
  it("registers at least the active Navicat groups", () => {
    const active = NAVICAT_BINDINGS.filter((binding) => binding.scopes.length > 0);
    expect(active.length).toBeGreaterThanOrEqual(14);
  });

  it("every active binding references an existing command id", () => {
    for (const binding of NAVICAT_BINDINGS) {
      if (binding.scopes.length === 0) continue;
      expect(DATABASE_COMMAND_IDS).toContain(binding.commandId);
    }
  });

  it("never registers terminal-reserved combos at GLOBAL scope", () => {
    for (const binding of NAVICAT_BINDINGS) {
      if (binding.scopes.includes("GLOBAL")) {
        expect(TERMINAL_RESERVED_COMBOS).not.toContain(binding.combo);
      }
    }
  });

  it("Ctrl+R is scoped to DATA_GRID only (query collision resolved)", () => {
    const ctrlR = NAVICAT_BINDINGS.filter((b) => b.combo === "Ctrl+R");
    for (const binding of ctrlR) {
      expect(binding.scopes).not.toContain("QUERY_EDITOR");
    }
  });
});

describe("command-registry default bindings feed the router", () => {
  it("exposes every defaultBinding as a router binding", () => {
    const fromRegistry = commandsWithBindings();
    expect(fromRegistry.length).toBeGreaterThanOrEqual(10);
    for (const entry of fromRegistry) {
      expect(entry.combo.length).toBeGreaterThan(0);
      expect(DATABASE_COMMAND_IDS).toContain(entry.commandId);
    }
  });

  it("query.execute defaults to Ctrl+Shift+R (pm combo decision)", () => {
    const execute = commandsWithBindings().find((e) => e.commandId === "database.query.execute");
    expect(execute?.combo).toBe("Ctrl+Shift+R");
  });

  it("query.stop defaults to Ctrl+T", () => {
    const stop = commandsWithBindings().find((e) => e.commandId === "database.query.stop");
    expect(stop?.combo).toBe("Ctrl+T");
  });
});
