import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu, ContextMenuContent } from "@/components/ui/context-menu";
import {
  NavigatorRelationMenu,
  QueryEditorMenu,
  ResultCellMenu,
  type NavigatorRelationMenuActions,
  type NavigatorRelationMenuLabels,
  type QueryEditorMenuActions,
  type QueryEditorMenuLabels,
  type ResultCellMenuActions,
  type ResultCellMenuLabels,
} from "@/components/toolbox/db-context-menus";

afterEach(cleanup);

/** Radix menu items require a Root; an open controlled ContextMenu renders
 *  the content through its portal in jsdom. */
function renderMenu(content: React.ReactNode) {
  return render(
    <ContextMenu open>
      <ContextMenuContent>{content}</ContextMenuContent>
    </ContextMenu>,
  );
}

const navigatorLabels: NavigatorRelationMenuLabels = {
  openData: "打开数据",
  copyName: "复制限定名",
  generateSql: "生成 SQL",
  generateSqlSelect: "SELECT",
  generateSqlInsert: "INSERT",
  generateSqlUpdate: "UPDATE",
  generateSqlDelete: "DELETE",
  generateSqlHint: "仅支持生成 SELECT（列元数据不可用）",
  refresh: "刷新",
  newQuery: "新建查询",
};

function navigatorActions(
  overrides: Partial<NavigatorRelationMenuActions> = {},
): NavigatorRelationMenuActions {
  return {
    openData: vi.fn(),
    copyName: vi.fn(),
    generateSelect: vi.fn(),
    refresh: vi.fn(),
    newQuery: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

describe("NavigatorRelationMenu", () => {
  it("renders open data / copy name / generate SQL / refresh / new query", () => {
    renderMenu(
      <NavigatorRelationMenu actions={navigatorActions()} labels={navigatorLabels} />,
    );
    expect(screen.getByTestId("navigator-menu-open-data").textContent).toContain("打开数据");
    expect(screen.getByTestId("navigator-menu-copy-name").textContent).toContain("复制限定名");
    expect(screen.getByText("生成 SQL")).not.toBeNull();
    expect(screen.getByTestId("navigator-menu-refresh").textContent).toContain("刷新");
    expect(screen.getByTestId("navigator-menu-new-query").textContent).toContain("新建查询");
  });

  it("invokes actions on select", () => {
    const actions = navigatorActions();
    renderMenu(<NavigatorRelationMenu actions={actions} labels={navigatorLabels} />);
    fireEvent.click(screen.getByTestId("navigator-menu-open-data"));
    fireEvent.click(screen.getByTestId("navigator-menu-copy-name"));
    expect(actions.openData).toHaveBeenCalledTimes(1);
    expect(actions.copyName).toHaveBeenCalledTimes(1);
  });

  it("greys out every action when disabled", () => {
    renderMenu(
      <NavigatorRelationMenu actions={navigatorActions({ disabled: true })} labels={navigatorLabels} />,
    );
    const item = screen.getByTestId("navigator-menu-open-data");
    expect(item.getAttribute("data-disabled")).toBe("");
  });

  it("hides INSERT/UPDATE/DELETE when column metadata is unavailable and shows a hint", async () => {
    renderMenu(
      <NavigatorRelationMenu
        actions={navigatorActions({ generateInsert: undefined, generateUpdate: undefined, generateDelete: undefined })}
        labels={navigatorLabels}
      />,
    );
    fireEvent.click(screen.getByText("生成 SQL"));
    // SELECT stays available.
    expect(screen.getByTestId("navigator-menu-generate-select").getAttribute("data-disabled")).toBeNull();
    // INSERT/UPDATE/DELETE are hidden (not greyed) when metadata is unavailable (F4.6).
    expect(screen.queryByTestId("navigator-menu-generate-insert")).toBeNull();
    expect(screen.queryByTestId("navigator-menu-generate-update")).toBeNull();
    expect(screen.queryByTestId("navigator-menu-generate-delete")).toBeNull();
    // A disabled hint explains the degradation.
    const hint = await screen.findByTestId("navigator-menu-generate-hint");
    expect(hint.getAttribute("data-disabled")).toBe("");
    expect(hint.textContent).toContain("列元数据不可用");
  });

  it("enables INSERT/UPDATE/DELETE when actions are provided", async () => {
    const actions = navigatorActions({
      generateInsert: vi.fn(),
      generateUpdate: vi.fn(),
      generateDelete: vi.fn(),
    });
    renderMenu(<NavigatorRelationMenu actions={actions} labels={navigatorLabels} />);
    fireEvent.click(screen.getByText("生成 SQL"));
    const insert = await screen.findByTestId("navigator-menu-generate-insert");
    expect(insert.getAttribute("data-disabled")).toBeNull();
    fireEvent.click(insert);
    expect(actions.generateInsert).toHaveBeenCalledTimes(1);
  });

  it("renders DELETE in the generate SQL submenu as a plain item (danger is conveyed by the generated -- 全表删除 comment)", async () => {
    const actions = navigatorActions({ generateDelete: vi.fn() });
    renderMenu(<NavigatorRelationMenu actions={actions} labels={navigatorLabels} />);
    fireEvent.click(screen.getByText("生成 SQL"));
    const del = await screen.findByTestId("navigator-menu-generate-delete");
    // Not a destructive-styled item — the risk is signalled by the SQL comment.
    expect(del.getAttribute("data-variant")).not.toBe("destructive");
    fireEvent.click(del);
    expect(actions.generateDelete).toHaveBeenCalledTimes(1);
  });

  it("annotates refresh (F5) and new query (Ctrl+N) shortcuts", () => {
    renderMenu(<NavigatorRelationMenu actions={navigatorActions()} labels={navigatorLabels} />);
    expect(screen.getByTestId("navigator-menu-refresh").textContent).toContain("F5");
    expect(screen.getByTestId("navigator-menu-new-query").textContent).toContain("Ctrl+N");
  });
});

const resultLabels: ResultCellMenuLabels = {
  copyCell: "复制单元格",
  copyRow: "复制行",
  copyColumnName: "复制列名",
  exportCsv: "导出 CSV",
  exportExcel: "导出 Excel",
  removeRecord: "移除记录",
};

function resultActions(overrides: Partial<ResultCellMenuActions> = {}): ResultCellMenuActions {
  return {
    copyCell: vi.fn(),
    copyRow: vi.fn(),
    copyColumnName: vi.fn(),
    exportCsv: vi.fn(),
    exportExcel: vi.fn(),
    ...overrides,
  };
}

describe("ResultCellMenu", () => {
  it("renders copy cell / row / column name plus export items for data rows", () => {
    renderMenu(<ResultCellMenu actions={resultActions()} source="row" labels={resultLabels} />);
    expect(screen.getByTestId("result-menu-copy-cell").textContent).toContain("复制单元格");
    expect(screen.getByTestId("result-menu-copy-row").textContent).toContain("复制行");
    expect(screen.getByTestId("result-menu-copy-column-name").textContent).toContain("复制列名");
    expect(screen.getByTestId("result-menu-export-csv").textContent).toContain("导出 CSV");
    expect(screen.getByTestId("result-menu-export-excel").textContent).toContain("导出 Excel");
  });

  it("hides exports when no action is provided", () => {
    renderMenu(
      <ResultCellMenu
        actions={resultActions({ exportCsv: undefined, exportExcel: undefined })}
        source="row"
        labels={resultLabels}
      />,
    );
    expect(screen.queryByTestId("result-menu-export-csv")).toBeNull();
    expect(screen.queryByTestId("result-menu-export-excel")).toBeNull();
  });

  it("renders only copy cell / row and remove for insert rows", () => {
    const actions = resultActions({ remove: vi.fn() });
    renderMenu(<ResultCellMenu actions={actions} source="insert" labels={resultLabels} />);
    expect(screen.getByTestId("result-menu-copy-cell")).not.toBeNull();
    expect(screen.getByTestId("result-menu-copy-row")).not.toBeNull();
    expect(screen.queryByTestId("result-menu-copy-column-name")).toBeNull();
    expect(screen.getByTestId("result-menu-remove-record").textContent).toContain("移除记录");
    fireEvent.click(screen.getByTestId("result-menu-remove-record"));
    expect(actions.remove).toHaveBeenCalledTimes(1);
  });

  it("omits remove when absent on insert rows", () => {
    renderMenu(<ResultCellMenu actions={resultActions()} source="insert" labels={resultLabels} />);
    expect(screen.queryByTestId("result-menu-remove-record")).toBeNull();
  });
});

const editorLabels: QueryEditorMenuLabels = {
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  copy: "复制",
  paste: "粘贴",
  selectAll: "全选",
  run: "运行",
  runSelection: "运行选择",
  formatSql: "格式化 SQL",
  toggleComment: "注释 / 取消注释",
};

function editorActions(
  overrides: Partial<QueryEditorMenuActions> = {},
): QueryEditorMenuActions {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    execute: vi.fn(),
    runSelection: vi.fn(),
    formatSql: vi.fn(),
    toggleComment: vi.fn(),
    disabledExecute: false,
    ...overrides,
  };
}

describe("QueryEditorMenu", () => {
  it("renders edit + execution groups with shortcut badges", () => {
    renderMenu(<QueryEditorMenu actions={editorActions()} labels={editorLabels} />);
    expect(screen.getByTestId("editor-menu-undo").textContent).toContain("撤销");
    expect(screen.getByTestId("editor-menu-execute").textContent).toContain("运行");
    expect(screen.getByTestId("editor-menu-execute").textContent).toContain("Ctrl+Enter");
    expect(screen.getByTestId("editor-menu-run-selection").textContent).toContain("Ctrl+Shift+Enter");
    expect(screen.getByTestId("editor-menu-format-sql").textContent).toContain("Ctrl+Shift+F");
    expect(screen.getByTestId("editor-menu-toggle-comment").textContent).toContain("Ctrl+/");
  });

  it("greys out the execution group when disabledExecute", () => {
    renderMenu(
      <QueryEditorMenu actions={editorActions({ disabledExecute: true })} labels={editorLabels} />,
    );
    expect(screen.getByTestId("editor-menu-execute").getAttribute("data-disabled")).toBe("");
    // Edit group stays enabled.
    expect(screen.getByTestId("editor-menu-copy").getAttribute("data-disabled")).toBeNull();
  });

  it("omits save-to-notes when not provided", () => {
    renderMenu(<QueryEditorMenu actions={editorActions()} labels={editorLabels} />);
    expect(screen.queryByTestId("editor-menu-save-to-notes")).toBeNull();
  });

  it("renders save-to-notes when the action is provided", () => {
    const actions = editorActions({ saveToNotes: vi.fn() });
    renderMenu(
      <QueryEditorMenu
        actions={actions}
        labels={{ ...editorLabels, saveToNotes: "保存到记事本" }}
      />,
    );
    expect(screen.getByTestId("editor-menu-save-to-notes").textContent).toContain("保存到记事本");
  });
});
