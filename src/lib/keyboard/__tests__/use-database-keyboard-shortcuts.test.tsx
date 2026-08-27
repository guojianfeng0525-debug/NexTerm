import { describe, expect, it, afterEach } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import type { DatabaseCommandId } from "@/lib/database/command-registry";
import {
  buildEffectiveBindings,
  resolveDesignerScope,
  shouldConsumeShortcut,
  useDatabaseKeyboardShortcuts,
  type DatabaseCommandHandler,
} from "../use-database-keyboard-shortcuts";
import { NAVICAT_BINDINGS } from "../bindings";
import {
  commandsWithBindings,
  DATABASE_COMMAND_IDS,
  getDatabaseCommand,
} from "@/lib/database/command-registry";

type TestId = "postgres-workspace" | "mysql-workspace" | "sqlite-workspace";

/** Minimal workspace DOM: navigator node, CodeMirror editor, grid body. */
const DEFAULT_CHILDREN = (
  <>
    <button data-node-id="users">users</button>
    <div className="cm-editor" contentEditable="true">
      SELECT 1
    </div>
    <table>
      <tbody>
        <tr>
          <td data-testid="cell" tabIndex={-1}>
            v
          </td>
        </tr>
      </tbody>
    </table>
    <div data-testid="table-designer">
      <button data-testid="designer-apply">apply</button>
      <input data-testid="designer-input" />
    </div>
  </>
);

function Harness({
  testId,
  dialogOpen = false,
  handlers = {},
  isOwnEditor,
  children = DEFAULT_CHILDREN,
}: {
  testId: TestId;
  dialogOpen?: boolean;
  handlers?: Partial<Record<DatabaseCommandId, DatabaseCommandHandler>>;
  isOwnEditor?: (el: Element) => boolean;
  children?: ReactNode;
}) {
  useDatabaseKeyboardShortcuts({ testId, dialogOpen, handlers, isOwnEditor });
  // tabIndex lets jsdom focus the container itself (workspace-background scope).
  return (
    <div data-testid={testId} tabIndex={-1}>
      {children}
    </div>
  );
}

function dispatchKey(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

function handlerMock() {
  return { called: 0 };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("shouldConsumeShortcut rule table (feature-design §1.2 boundary 3)", () => {
  function ev(key: string, mods: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  }

  it("QUERY_EDITOR: consumes modifier combos even while typing", () => {
    expect(shouldConsumeShortcut(ev("Enter", { ctrlKey: true }), "QUERY_EDITOR", true)).toBe(true);
    expect(shouldConsumeShortcut(ev("/", { ctrlKey: true }), "QUERY_EDITOR", true)).toBe(true);
  });

  it("QUERY_EDITOR: plain combos are consumed only outside editable fields", () => {
    expect(shouldConsumeShortcut(ev("Insert"), "QUERY_EDITOR", false)).toBe(true);
    expect(shouldConsumeShortcut(ev("Enter"), "QUERY_EDITOR", true)).toBe(false);
    expect(shouldConsumeShortcut(ev("Escape"), "QUERY_EDITOR", true)).toBe(false);
  });

  it("DATA_GRID: same modifier/plain split as QUERY_EDITOR", () => {
    expect(shouldConsumeShortcut(ev("r", { ctrlKey: true }), "DATA_GRID", true)).toBe(true);
    expect(shouldConsumeShortcut(ev("Insert"), "DATA_GRID", false)).toBe(true);
    expect(shouldConsumeShortcut(ev("Escape"), "DATA_GRID", true)).toBe(false);
  });

  it("NAVIGATOR / DATABASE_WORKSPACE: everything is consumed", () => {
    expect(shouldConsumeShortcut(ev("F5"), "NAVIGATOR", true)).toBe(true);
    expect(shouldConsumeShortcut(ev("Escape"), "NAVIGATOR", true)).toBe(true);
    expect(shouldConsumeShortcut(ev("Escape"), "DATABASE_WORKSPACE", true)).toBe(true);
  });

  it("DIALOG: never consumed", () => {
    expect(shouldConsumeShortcut(ev("n", { ctrlKey: true }), "DIALOG", true)).toBe(false);
    expect(shouldConsumeShortcut(ev("F5"), "DIALOG", false)).toBe(false);
  });
});

describe("resolveDesignerScope", () => {
  it("detects focus inside the table designer", () => {
    const designer = document.createElement("div");
    designer.setAttribute("data-testid", "table-designer");
    const button = document.createElement("button");
    designer.appendChild(button);
    expect(resolveDesignerScope(button)).toBe(true);
    expect(resolveDesignerScope(designer)).toBe(true);
  });

  it("returns false for everything else", () => {
    const el = document.createElement("button");
    expect(resolveDesignerScope(el)).toBe(false);
    expect(resolveDesignerScope(null)).toBe(false);
  });
});

describe("scope routing via the hook", () => {
  it("QUERY_EDITOR: Ctrl+Enter runs the execute handler and prevents default", () => {
    const execute = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.query.execute": () => void execute.called++ }}
      />,
    );
    const editor = document.querySelector(".cm-editor") as HTMLElement;
    editor.focus();
    const event = dispatchKey(editor, "Enter", { ctrlKey: true });
    expect(execute.called).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("DATA_GRID: Ctrl+R routes to filterSort", () => {
    const filterSort = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.data.filterSort": () => void filterSort.called++ }}
      />,
    );
    const cell = document.querySelector('[data-testid="cell"]') as HTMLElement;
    cell.focus();
    dispatchKey(cell, "r", { ctrlKey: true });
    expect(filterSort.called).toBe(1);
  });

  it("NAVIGATOR: F5 routes to object.refresh", () => {
    const refresh = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.object.refresh": () => void refresh.called++ }}
      />,
    );
    const node = document.querySelector('[data-node-id="users"]') as HTMLElement;
    node.focus();
    dispatchKey(node, "F5");
    expect(refresh.called).toBe(1);
  });

  it("DATABASE_WORKSPACE: Ctrl+N routes to newQuery from workspace background", () => {
    const newQuery = handlerMock();
    const { container } = render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.workspace.newQuery": () => void newQuery.called++ }}
      />,
    );
    const workspace = container.firstElementChild as HTMLElement;
    workspace.focus();
    dispatchKey(workspace, "n", { ctrlKey: true });
    expect(newQuery.called).toBe(1);
  });

  it("unbound combos are left untouched (no preventDefault)", () => {
    const newQuery = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.workspace.newQuery": () => void newQuery.called++ }}
      />,
    );
    const node = document.querySelector('[data-node-id="users"]') as HTMLElement;
    node.focus();
    const event = dispatchKey(node, "q", { ctrlKey: true });
    expect(newQuery.called).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("missing handlers still consume the combo silently", () => {
    render(<Harness testId="postgres-workspace" handlers={{}} />);
    const editor = document.querySelector(".cm-editor") as HTMLElement;
    editor.focus();
    const event = dispatchKey(editor, "Enter", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("DIALOG short-circuit (boundary 1)", () => {
  it("drops all DB routing while a dialog is open", () => {
    const newQuery = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        dialogOpen
        handlers={{ "database.workspace.newQuery": () => void newQuery.called++ }}
      />,
    );
    const node = document.querySelector('[data-node-id="users"]') as HTMLElement;
    node.focus();
    const event = dispatchKey(node, "n", { ctrlKey: true });
    expect(newQuery.called).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("own-workspace ownership (boundary 2)", () => {
  it("does not respond when focus is outside the workspace", () => {
    const newQuery = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.workspace.newQuery": () => void newQuery.called++ }}
      />,
    );
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const event = dispatchKey(outside, "n", { ctrlKey: true });
    expect(newQuery.called).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("routes to the matching tool when two workspaces are mounted", () => {
    const pgNewQuery = handlerMock();
    const myNewQuery = handlerMock();
    render(
      <>
        <Harness
          testId="postgres-workspace"
          handlers={{ "database.workspace.newQuery": () => void pgNewQuery.called++ }}
        />
        <Harness
          testId="mysql-workspace"
          handlers={{ "database.workspace.newQuery": () => void myNewQuery.called++ }}
        />
      </>,
    );
    const mysqlNode = document.querySelector(
      '[data-testid="mysql-workspace"] [data-node-id="users"]',
    ) as HTMLElement;
    mysqlNode.focus();
    dispatchKey(mysqlNode, "n", { ctrlKey: true });
    expect(pgNewQuery.called).toBe(0);
    expect(myNewQuery.called).toBe(1);
  });
});

describe("isOwnEditor (boundary 4)", () => {
  it("leaves a foreign .cm-editor untouched", () => {
    const execute = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.query.execute": () => void execute.called++ }}
        isOwnEditor={() => false}
      />,
    );
    const editor = document.querySelector(".cm-editor") as HTMLElement;
    editor.focus();
    const event = dispatchKey(editor, "Enter", { ctrlKey: true });
    expect(execute.called).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("DESIGNER domain (feature-design §1.3)", () => {
  it("Ctrl+S routes to design.save", () => {
    const save = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.design.save": () => void save.called++ }}
      />,
    );
    const apply = document.querySelector('[data-testid="designer-apply"]') as HTMLElement;
    apply.focus();
    const event = dispatchKey(apply, "s", { ctrlKey: true });
    expect(save.called).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Escape routes to design.revert outside input fields", () => {
    const revert = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.design.revert": () => void revert.called++ }}
      />,
    );
    const apply = document.querySelector('[data-testid="designer-apply"]') as HTMLElement;
    apply.focus();
    dispatchKey(apply, "Escape");
    expect(revert.called).toBe(1);
  });

  it("Escape does not revert while typing in a field", () => {
    const revert = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.design.revert": () => void revert.called++ }}
      />,
    );
    const input = document.querySelector('[data-testid="designer-input"]') as HTMLElement;
    input.focus();
    dispatchKey(input, "Escape");
    expect(revert.called).toBe(0);
  });

  it("non-design combos are not routed inside the designer", () => {
    const newQuery = handlerMock();
    render(
      <Harness
        testId="postgres-workspace"
        handlers={{ "database.workspace.newQuery": () => void newQuery.called++ }}
      />,
    );
    const apply = document.querySelector('[data-testid="designer-apply"]') as HTMLElement;
    apply.focus();
    const event = dispatchKey(apply, "n", { ctrlKey: true });
    expect(newQuery.called).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("buildEffectiveBindings", () => {
  it("includes Ctrl+Enter for execute plus the legacy aliases", () => {
    const bindings = buildEffectiveBindings();
    const execute = bindings.filter((b) => b.commandId === "database.query.execute");
    const combos = execute.map((b) => b.combo);
    expect(combos).toContain("Ctrl+Enter");
    expect(combos).toContain("Ctrl+Shift+R");
    expect(combos).toContain("Ctrl+E");
  });

  it("includes runSelection with Ctrl+Shift+Enter", () => {
    const bindings = buildEffectiveBindings();
    const runSelection = bindings.find((b) => b.commandId === "database.query.runSelection");
    expect(runSelection?.combo).toBe("Ctrl+Shift+Enter");
    expect(runSelection?.scopes).toContain("QUERY_EDITOR");
  });

  it("every binding references an existing command id; DESIGNER-only scopes are filtered", () => {
    const bindings = buildEffectiveBindings();
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(DATABASE_COMMAND_IDS).toContain(binding.commandId);
      if (binding.scopes.length === 0) {
        // DESIGNER commands are routed exclusively by resolveDesignerScope.
        expect(getDatabaseCommand(binding.commandId)?.scopes).toContain("DESIGNER");
      }
    }
  });

  it("merges NAVICAT_BINDINGS with command-registry default bindings", () => {
    const bindings = buildEffectiveBindings();
    const navicatIds = new Set(NAVICAT_BINDINGS.map((b) => `${b.commandId}:${b.combo}`));
    for (const binding of NAVICAT_BINDINGS) {
      expect(navicatIds.has(`${binding.commandId}:${binding.combo}`)).toBe(true);
      expect(bindings.some((b) => b.commandId === binding.commandId && b.combo === binding.combo)).toBe(true);
    }
    const registryIds = new Set(commandsWithBindings().map((e) => e.commandId));
    for (const id of registryIds) {
      expect(bindings.some((b) => b.commandId === id)).toBe(true);
    }
  });
});
