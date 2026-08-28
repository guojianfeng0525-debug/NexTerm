import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  writeText as writeClipboardText,
  readText as readClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile as writeBinaryFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import { undo, redo, selectAll } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import {
  Database,
  FolderTree,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Unplug,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CodeEditor } from "@/components/code-editor";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import { DatabaseProviderSelect } from "@/components/toolbox/database-provider-select";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import { DatabaseResultErrorPane } from "@/components/toolbox/database-result-error";
import { DatabaseWorkspaceShell } from "@/components/toolbox/database-workspace-shell";
import {
  NavigatorRelationMenu,
  QueryEditorMenu,
  ResultCellMenu,
  type NavigatorRelationMenuLabels,
  type QueryEditorMenuLabels,
  type ResultCellMenuLabels,
} from "@/components/toolbox/db-context-menus";
import { QueryHistoryView } from "@/components/toolbox/query-history-view";
import {
  DatabaseConnectionDialogShell,
  DatabaseConnectionField,
  DatabaseConnectionFormGrid,
} from "@/components/toolbox/database-connection-dialog-shell";
import { generateId } from "@/lib/toolbox/toolbox-storage";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
import { mysqlProvider } from "@/lib/database/provider-registry";
import {
  createMySQLNavigatorConnectionNode,
  getMySQLRelationReference,
  loadMySQLNavigatorChildren,
  type MySQLRelationReference,
} from "@/lib/database/mysql-object-loader";
import { createMySQLQueryEditorContext } from "@/lib/database/mysql-query-editor";
import {
  adaptMySQLQueryResult,
  type MySQLQueryRuntimeResult,
} from "@/lib/database/mysql-result-adapter";
import {
  isValidMySQLPort,
  type MySQLConnectionProfile,
} from "@/lib/database/mysql-profile";
import type {
  DatabaseObjectNode,
  DatabaseObjectNodeId,
} from "@/lib/database/types";
import type { DatabaseResult } from "@/lib/database/result-types";
import { databaseErrorResult, parseProviderError } from "@/lib/database/database-error";
import { generateSelectSql } from "@/lib/database/sql-generation";
import { addQueryHistory } from "@/lib/database/query-history";
import { flashEditorRange } from "@/lib/database/editor-flash";
import {
  currentStatementAt,
  toggleLineComment,
} from "@/lib/database/sql-statement-tokenizer";
import { formatSql } from "@/lib/database/sql-formatter";
import { useDatabaseKeyboardShortcuts } from "@/lib/keyboard/use-database-keyboard-shortcuts";
import { MySQLConnectionsStorage } from "@/lib/toolbox/mysql-storage";

type Tab = { id: string; sql: string; result: DatabaseResult | null };
const newProfile = (): MySQLConnectionProfile => {
  const now = Date.now();
  return {
    id: generateId("mysql"),
    name: "MySQL",
    providerId: "mysql",
    environment: "development",
    createdAt: now,
    updatedAt: now,
    providerConfig: {
      host: "127.0.0.1",
      port: 3306,
      database: "",
      username: "",
      password: "",
    },
  };
};
const newTab = (): Tab => ({
  id: generateId("mysql-query"),
  sql: "SELECT 1;",
  result: null,
});

/** MySQL identifier quoting: double inner backticks (`` ` `` → `` `` ``). */
const quoteMySqlIdentifier = (id: string): string =>
  `\`${id.replace(/`/g, "``")}\``;

export function ToolMySql() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState(() =>
    MySQLConnectionsStorage.load(),
  );
  const [draft, setDraft] = useState<MySQLConnectionProfile>(
    () => MySQLConnectionsStorage.load()[0] ?? newProfile(),
  );
  // Keep an empty value while editing so native input can replace the default port.
  const [portInput, setPortInput] = useState(() =>
    String((MySQLConnectionsStorage.load()[0] ?? newProfile()).providerConfig.port),
  );
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<MySQLConnectionProfile | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [activeTab, setActiveTab] = useState(() => tabs[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const [roots, setRoots] = useState<readonly DatabaseObjectNode[]>([]);
  const [children, setChildren] = useState<
    Partial<Record<DatabaseObjectNodeId, readonly DatabaseObjectNode[]>>
  >({});
  const [expanded, setExpanded] = useState<
    Partial<Record<DatabaseObjectNodeId, boolean>>
  >({});
  const [selected, setSelected] = useState<DatabaseObjectNodeId | null>(null);
  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const queryEditorViewRef = useRef<EditorView | null>(null);
  const executeCommand = resolveDatabaseCommand("database.query.execute", {
    scope: "QUERY_EDITOR",
    provider: mysqlProvider,
    connectionState: connected ? "connected" : "disconnected",
  });
  const newQueryCommand = resolveDatabaseCommand(
    "database.workspace.newQuery",
    {
      scope: "DATABASE",
      provider: mysqlProvider,
      connectionState: connected ? "connected" : "disconnected",
    },
  );

  const navigatorMenuLabels: NavigatorRelationMenuLabels = {
    openData: t("toolbox.mysql.openData"),
    copyName: t("toolbox.mysql.copyName"),
    generateSql: t("toolbox.mysql.generateSql"),
    generateSqlSelect: t("toolbox.mysql.generateSqlSelect"),
    generateSqlInsert: t("toolbox.mysql.generateSqlInsert"),
    generateSqlUpdate: t("toolbox.mysql.generateSqlUpdate"),
    generateSqlDelete: t("toolbox.mysql.generateSqlDelete"),
    refresh: t("toolbox.mysql.refresh"),
    newQuery: t("toolbox.mysql.newQuery"),
  };
  const editorMenuLabels: QueryEditorMenuLabels = {
    undo: t("common.undo"),
    redo: t("common.redo"),
    cut: t("common.cut"),
    copy: t("common.copy"),
    paste: t("common.paste"),
    selectAll: t("common.selectAll"),
    run: t("toolbox.mysql.run"),
    runSelection: t("toolbox.mysql.runSelection"),
    formatSql: t("toolbox.mysql.formatSql"),
    toggleComment: t("toolbox.mysql.toggleComment"),
  };
  const resultMenuLabels: ResultCellMenuLabels = {
    copyCell: t("toolbox.mysql.copyCell"),
    copyRow: t("toolbox.mysql.copyRow"),
    copyColumnName: t("toolbox.mysql.copyColumnName"),
    exportCsv: t("toolbox.mysql.exportCsv"),
    exportExcel: t("toolbox.mysql.exportExcel"),
    removeRecord: t("toolbox.mysql.removeRecord"),
  };

  useEffect(() => {
    const pasteSqlNote = (event: Event) => {
      const detail = (event as CustomEvent<{ content?: string; handled?: boolean; provider?: string }>).detail;
      if (detail?.provider !== undefined && detail.provider !== "mysql") return;
      if (!detail?.content || !tab) return;
      setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, sql: detail.content! } : item));
      detail.handled = true;
    };
    window.addEventListener('nexterm:paste-sql-note', pasteSqlNote);
    return () => window.removeEventListener('nexterm:paste-sql-note', pasteSqlNote);
  }, [tab]);

  // Query-history round-trip: "run again" re-executes, "insert" appends to the editor.
  useEffect(() => {
    const onExecuteHistory = (event: Event) => {
      const detail = (event as CustomEvent<{ providerId?: string; sql?: string; connectionId?: string }>).detail;
      if (!detail?.sql || detail.providerId !== "mysql") return;
      if (detail.connectionId && detail.connectionId !== draft.id) return;
      if (!tab) return;
      patchTab(tab.id, { sql: detail.sql });
      void execute(detail.sql);
    };
    const onInsertHistory = (event: Event) => {
      const detail = (event as CustomEvent<{ providerId?: string; sql?: string }>).detail;
      if (!detail?.sql || detail.providerId !== "mysql") return;
      insertGeneratedSql(detail.sql);
    };
    window.addEventListener("nexterm:db-query-history-execute", onExecuteHistory);
    window.addEventListener("nexterm:db-query-history-insert", onInsertHistory);
    return () => {
      window.removeEventListener("nexterm:db-query-history-execute", onExecuteHistory);
      window.removeEventListener("nexterm:db-query-history-insert", onInsertHistory);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- execute/insertGeneratedSql close over the render-scoped tab
  }, [tab, draft.id]);

  useEffect(() => {
    const update = () => setConnections(MySQLConnectionsStorage.load());
    window.addEventListener("nexterm:toolbox-changed", update);
    return () => window.removeEventListener("nexterm:toolbox-changed", update);
  }, []);
  const load = async (node: DatabaseObjectNode) => {
    try {
      const next = await loadMySQLNavigatorChildren(
        node,
        t("toolbox.mysql.tables"),
      );
      setChildren((current) => ({ ...current, [node.id]: next }));
      return next;
    } catch (error) {
      toast.error(t("toolbox.mysql.metadataFailed"), {
        description: String(error),
      });
      return [];
    }
  };
  const connect = async () => {
    const port = Number(portInput);
    if (
      !draft.name.trim() ||
      !draft.providerConfig.host.trim() ||
      !draft.providerConfig.database.trim() ||
      !draft.providerConfig.username.trim() ||
      !isValidMySQLPort(port)
    ) {
      toast.error(t("toolbox.mysql.required"));
      return;
    }
    setConnecting(true);
    try {
      const saved = {
        ...draft,
        updatedAt: Date.now(),
        providerConfig: { ...draft.providerConfig, port },
      };
      if (!(await MySQLConnectionsStorage.upsert(saved)))
        throw new Error(t("toolbox.mysql.saveFailed"));
      setDraft(saved);
      await invoke("mysql_connect", {
        request: { connectionId: saved.id, ...saved.providerConfig },
      });
      setConnected(true);
      setDialogOpen(false);
      const root = createMySQLNavigatorConnectionNode({
        id: saved.id,
        name: saved.name,
        database: saved.providerConfig.database,
      });
      setRoots([root]);
      const catalog = (await load(root))[0];
      if (catalog) {
        const group = (await load(catalog))[0];
        if (group) await load(group);
        setExpanded({ [root.id]: true, [catalog.id]: true, [group.id]: true });
      }
      toast.success(t("toolbox.mysql.connected"));
    } catch (error) {
      toast.error(t("toolbox.mysql.connectFailed"), {
        description: String(error),
      });
    } finally {
      setConnecting(false);
    }
  };
  const execute = async (sqlOverride?: string) => {
    const sql = sqlOverride ?? tab?.sql ?? "";
    if (!sql.trim()) return;
    setRunning(true);
    try {
      const result = adaptMySQLQueryResult(
        await invoke<MySQLQueryRuntimeResult>("mysql_execute", {
          request: { connectionId: draft.id, sql },
        }),
      );
      setTabs((current) =>
        current.map((item) =>
          item.id === tab.id ? { ...item, result } : item,
        ),
      );
      addQueryHistory({
        sql,
        connectionId: draft.id,
        connectionName: draft.name,
        providerId: "mysql",
        success: true,
      });
    } catch (error) {
      const parsed = parseProviderError("mysql", String(error));
      patchTab(tab.id, { result: databaseErrorResult(parsed) });
      toast.error(t("toolbox.mysql.queryFailed"), {
        description: parsed.message,
      });
      addQueryHistory({
        sql,
        connectionId: draft.id,
        connectionName: draft.name,
        providerId: "mysql",
        success: false,
      });
    } finally {
      setRunning(false);
    }
  };
  const patchTab = (id: string, patch: Partial<Tab>) =>
    setTabs((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const addQuery = () => {
    const next = newTab();
    setTabs((current) => [...current, next]);
    setActiveTab(next.id);
  };
  useDatabaseKeyboardShortcuts({
    testId: "mysql-workspace",
    dialogOpen,
    handlers: {
      "database.query.execute": () => void execute(),
      "database.workspace.newQuery": addQuery,
    },
  });
  const closeTab = (id: string) => {
    setTabs((current) => current.filter((item) => item.id !== id));
    if (id === activeTab)
      setActiveTab(tabs.find((item) => item.id !== id)?.id ?? "");
  };
  const copyText = async (value: string) => {
    try {
      await writeClipboardText(value);
    } catch {
      /* clipboard unavailable */
    }
  };
  const qualifiedMySqlName = (relation: MySQLRelationReference): string =>
    relation.database
      ? `${quoteMySqlIdentifier(relation.database)}.${quoteMySqlIdentifier(relation.relation)}`
      : quoteMySqlIdentifier(relation.relation);
  const selectSqlFor = (relation: MySQLRelationReference): string =>
    generateSelectSql(relation.database, relation.relation, null, {
      quoteIdentifier: quoteMySqlIdentifier,
    });
  /** Opens a new query tab pre-filled with a `SELECT *` browse statement. */
  const openRelationData = (node: DatabaseObjectNode) => {
    const relation = getMySQLRelationReference(node);
    if (!relation) return;
    const next = newTab();
    next.sql = selectSqlFor(relation);
    setTabs((current) => [...current, next]);
    setActiveTab(next.id);
  };
  /** Appends generated SQL to the current editor (or a new query tab when the
   *  editor is not mounted). Caret lands at the statement end with a transient
   *  highlight — never a whole-document selection (P1-UX). */
  const insertGeneratedSql = (sql: string) => {
    const view = queryEditorViewRef.current;
    if (!view) {
      const next = newTab();
      next.sql = sql;
      setTabs((current) => [...current, next]);
      setActiveTab(next.id);
      requestAnimationFrame(() => {
        const nextView = queryEditorViewRef.current;
        if (!nextView) return;
        const end = nextView.state.doc.length;
        nextView.dispatch({ selection: { anchor: end, head: end } });
        flashEditorRange(nextView, 0, Math.min(sql.length, end));
        nextView.focus();
      });
      return;
    }
    const doc = view.state.doc;
    const insertAt = doc.length;
    const needsLeadingNewline =
      insertAt > 0 && doc.sliceString(insertAt - 1, insertAt) !== "\n";
    const insertText = (needsLeadingNewline ? "\n" : "") + sql + "\n";
    view.dispatch({
      changes: { from: insertAt, to: insertAt, insert: insertText },
    });
    const end = insertAt + insertText.length;
    view.dispatch({ selection: { anchor: end, head: end } });
    const flashFrom = insertAt + (needsLeadingNewline ? 1 : 0);
    flashEditorRange(view, flashFrom, flashFrom + sql.length);
    view.focus();
  };
  const runCmCommand = (cmd: (view: EditorView) => boolean) => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    view.focus();
    cmd(view);
  };
  const cutEditorSelection = async () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    view.focus();
    const selection = view.state.selection.main;
    if (selection.to <= selection.from) return;
    try {
      await writeClipboardText(
        view.state.doc.sliceString(selection.from, selection.to),
      );
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: "" },
      });
    } catch {
      /* clipboard unavailable */
    }
  };
  const pasteIntoEditor = async () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    view.focus();
    try {
      const text = await readClipboardText();
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: selection.from + text.length },
      });
    } catch {
      /* clipboard unavailable */
    }
  };
  /** Text captured by the editor "Copy" item: selection → current statement → document. */
  const editorCopyValue = (): string => {
    const view = queryEditorViewRef.current;
    if (!view) return tab?.sql ?? "";
    const selection = view.state.selection.main;
    if (selection.to > selection.from) {
      return view.state.doc.sliceString(selection.from, selection.to);
    }
    return currentStatementSql() || tab?.sql || "";
  };
  const currentStatementSql = (): string => {
    const view = queryEditorViewRef.current;
    if (!view) return "";
    const doc = view.state.doc.toString();
    const range = currentStatementAt(doc, view.state.selection.main.head);
    return range ? doc.slice(range.start, range.end).trim() : "";
  };
  /** Runs the selected text, or the current statement when nothing is selected. */
  const runSelectionOrStatement = () => {
    const view = queryEditorViewRef.current;
    const selected = view
      ? view.state.doc
          .sliceString(
            view.state.selection.main.from,
            view.state.selection.main.to,
          )
          .trim()
      : "";
    const sql = selected || currentStatementSql() || (tab?.sql ?? "");
    if (sql.trim()) void execute(sql);
  };
  /** Toggles `--` line comments on the current selection (Ctrl+/, B19-B). */
  const toggleSqlComment = () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    const doc = view.state.doc.toString();
    const next = toggleLineComment(doc, selection.from, selection.to);
    if (next === doc) return;
    view.dispatch({ changes: { from: 0, to: doc.length, insert: next } });
  };
  /** Formats the selection, or the whole document when nothing is selected. */
  const formatSqlInEditor = () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    if (selection.to > selection.from) {
      const selected = view.state.doc.sliceString(selection.from, selection.to);
      const formatted = formatSql(selected);
      if (formatted === selected) return;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: formatted },
        selection: {
          anchor: selection.from,
          head: selection.from + formatted.length,
        },
      });
    } else {
      const doc = view.state.doc.toString();
      const formatted = formatSql(doc);
      if (formatted === doc) return;
      view.dispatch({ changes: { from: 0, to: doc.length, insert: formatted } });
    }
  };
  const exportCsv = async () => {
    if (tab?.result?.kind !== "tabular") return;
    const quote = (value: string | null) =>
      value === null ? "NULL" : `"${value.replace(/"/g, '""')}"`;
    const csv = [
      tab.result.columns.map((column) => quote(column.label)).join(","),
      ...tab.result.rows.map((row) => row.map(quote).join(",")),
    ].join("\n");
    try {
      const path = await saveFile({
        defaultPath: `mysql-result.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, csv);
      toast.success(t("toolbox.mysql.exported"));
    } catch (error) {
      toast.error(t("toolbox.mysql.exportFailed"), {
        description: String(error),
      });
    }
  };
  const exportExcel = async () => {
    if (tab?.result?.kind !== "tabular") return;
    try {
      const XLSX = await import("xlsx");
      const header = tab.result.columns.map((column) => column.label);
      const rows = tab.result.rows.map((row) => row.map((cell) => cell ?? null));
      const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "MySQL Result");
      const path = await saveFile({
        defaultPath: `mysql-result.xlsx`,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!path) return;
      await writeBinaryFile(
        path,
        new Uint8Array(
          XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
        ),
      );
      toast.success(t("toolbox.mysql.exportedExcel"));
    } catch (error) {
      toast.error(t("toolbox.mysql.exportFailedExcel"), {
        description: String(error),
      });
    }
  };
  const save = async () => {
    const port = Number(portInput);
    if (!isValidMySQLPort(port)) {
      toast.error(t("toolbox.mysql.required"));
      return;
    }
    const saved = {
      ...draft,
      updatedAt: Date.now(),
      providerConfig: { ...draft.providerConfig, port },
    };
    if (!(await MySQLConnectionsStorage.upsert(saved))) {
      toast.error(t("toolbox.mysql.saveFailed"));
      return;
    }
    setDraft(saved);
    setPortInput(String(port));
  };
  const remove = async () => {
    if (
      !deleteTarget ||
      !(await MySQLConnectionsStorage.remove(deleteTarget.id))
    )
      return;
    if (draft.id === deleteTarget.id) {
      setDraft(newProfile());
      setConnected(false);
      setRoots([]);
    }
    setDeleteTarget(null);
  };
  return (
    <DatabaseWorkspaceShell
      testId="mysql-workspace"
      toolbar={
        <>
          <ToolButton
            icon={<Plus />}
            label={t("toolbox.mysql.newConnection")}
             onClick={() => {
              const profile = newProfile();
              setDraft(profile);
              setPortInput(String(profile.providerConfig.port));
              setDialogOpen(true);
            }}
            testId="mysql-new-connection"
          />
          <ToolButton
            icon={<Database />}
            label={t("toolbox.mysql.editConnection")}
            disabled={!connections.some((item) => item.id === draft.id)}
            onClick={() => {
              setPortInput(String(draft.providerConfig.port));
              setDialogOpen(true);
            }}
            testId="mysql-edit-connection"
          />
          <ToolButton
            icon={<X />}
            label={t("toolbox.mysql.deleteConnection")}
            disabled={!connections.some((item) => item.id === draft.id)}
            onClick={() => setDeleteTarget(draft)}
            testId="mysql-delete-connection"
          />
          <ToolButton
            icon={<Plus />}
            label={t("toolbox.mysql.newQuery")}
            disabled={newQueryCommand.state !== "enabled"}
            onClick={addQuery}
            testId="mysql-new-query"
          />
          <ToolButton
            icon={<History />}
            label={t("toolbox.mysql.history")}
            onClick={() => setHistoryOpen((open) => !open)}
            testId="mysql-history"
          />
          <ToolButton
            icon={<RefreshCw />}
            label={t("toolbox.mysql.refresh")}
            disabled={!connected}
            onClick={() => Promise.all(roots.map(load)).then(() => undefined)}
            testId="mysql-refresh"
          />
          <span className="ml-auto mr-2 text-[11px] text-muted-foreground">
            {connected
              ? t("toolbox.mysql.experimental")
              : t("toolbox.mysql.disconnected")}
          </span>
          {connected ? (
            <ToolButton
              icon={<Unplug />}
              label={t("toolbox.mysql.disconnect")}
              onClick={() =>
                invoke("mysql_disconnect", { connectionId: draft.id }).then(
                  () => setConnected(false),
                )
              }
              testId="mysql-disconnect"
            />
          ) : (
            <ToolButton
              icon={<Database />}
              label={t("toolbox.mysql.connect")}
              onClick={() => setDialogOpen(true)}
              testId="mysql-connect"
            />
          )}
        </>
      }
      navigator={
        <aside className="flex min-h-0 w-72 shrink-0 flex-col border-r bg-muted/10">
          <div className="flex h-8 items-center gap-1 border-b px-2">
            <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("toolbox.mysql.navigator")}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <DatabaseNavigator
              roots={roots}
              childrenByParent={children}
              expanded={expanded}
              selectedNodeId={selected}
              filter=""
              onToggle={(node) => {
                const next = !expanded[node.id];
                setExpanded((current) => ({ ...current, [node.id]: next }));
                if (next && !children[node.id]) void load(node);
              }}
              onSelect={(node) => setSelected(node.id)}
              onOpen={(node) => openRelationData(node)}
              renderContextMenu={(node) => {
                const relation = getMySQLRelationReference(node);
                if (!relation) {
                  return (
                    <>
                      <ContextMenuItem
                        disabled={!connected}
                        onSelect={() => void load(node)}
                        data-testid="navigator-menu-refresh"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t("toolbox.mysql.refresh")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!connected}
                        onSelect={addQuery}
                        data-testid="navigator-menu-new-query"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("toolbox.mysql.newQuery")}
                      </ContextMenuItem>
                    </>
                  );
                }
                return (
                  <NavigatorRelationMenu
                    actions={{
                      openData: () => openRelationData(node),
                      copyName: () => void copyText(qualifiedMySqlName(relation)),
                      generateSelect: () => insertGeneratedSql(selectSqlFor(relation)),
                      refresh: () => void load(node),
                      newQuery: addQuery,
                      disabled: !connected,
                    }}
                    labels={navigatorMenuLabels}
                  />
                );
              }}
            />
          </div>
        </aside>
      }
      tabs={tabs.map((item) => ({
        id: item.id,
        title: t("toolbox.mysql.query"),
      }))}
      activeTabId={activeTab}
      onActivateTab={setActiveTab}
      onCloseTab={closeTab}
      renderTabContextMenu={(item) => (
        <>
          <ContextMenuItem onSelect={() => closeTab(item.id)}>
            <X className="h-3.5 w-3.5" />
            {t("common.close")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabs.length < 2}
            onSelect={() => {
              setTabs((current) => current.filter((candidate) => candidate.id === item.id));
              setActiveTab(item.id);
            }}
          >
            {t("toolbox.mysql.closeOtherTabs")}
          </ContextMenuItem>
        </>
      )}
      tabClassName={(_, active) =>
        `group flex h-8 min-w-28 items-center gap-1 border-r px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${active ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"}`
      }
      workspace={
        tab && (
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
              <ToolButton
                icon={<Play />}
                label={t("toolbox.mysql.run")}
                disabled={executeCommand.state !== "enabled" || running}
                onClick={() => void execute()}
                testId="mysql-run"
              />
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </div>
            <div className="min-h-0 flex-1">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="h-full">
                    <CodeEditor
                      value={tab.sql}
                      onChange={(sql) => patchTab(tab.id, { sql })}
                      language="sql"
                      queryContext={
                        connected
                          ? createMySQLQueryEditorContext({
                              connectionId: draft.id,
                              database: draft.providerConfig.database,
                              lookup: async () =>
                                (
                                  await invoke<readonly { readonly name: string }[]>(
                                    "mysql_catalog_objects",
                                    { connectionId: draft.id },
                                  )
                                ).map((item) => item.name),
                            })
                          : undefined
                      }
                      editorRef={(view) => {
                        queryEditorViewRef.current = view;
                      }}
                      className="h-full"
                    />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <QueryEditorMenu
                    actions={{
                      undo: () => runCmCommand(undo),
                      redo: () => runCmCommand(redo),
                      cut: () => void cutEditorSelection(),
                      copy: () => void copyText(editorCopyValue()),
                      paste: () => void pasteIntoEditor(),
                      selectAll: () => runCmCommand(selectAll),
                      execute: () => void execute(),
                      runSelection: runSelectionOrStatement,
                      formatSql: formatSqlInEditor,
                      toggleComment: toggleSqlComment,
                      disabledExecute: !connected || !tab.sql.trim(),
                    }}
                    labels={editorMenuLabels}
                  />
                </ContextMenuContent>
              </ContextMenu>
            </div>
            <div className="h-[260px] shrink-0" data-testid="mysql-result-area">
              {historyOpen ? (
                <QueryHistoryView
                  open={historyOpen}
                  onOpenChange={setHistoryOpen}
                  providerId="mysql"
                  connectionId={draft.id}
                  labels={{
                    history: t("toolbox.mysql.history"),
                    empty: t("toolbox.mysql.historyEmpty"),
                    run: t("toolbox.mysql.historyRun"),
                    insertToEditor: t("toolbox.mysql.historyInsertToEditor"),
                    copy: t("toolbox.mysql.historyCopy"),
                    remove: t("toolbox.mysql.historyRemove"),
                    clear: t("toolbox.mysql.historyClear"),
                    time: t("toolbox.mysql.historyTime"),
                    error: t("toolbox.mysql.historyError"),
                    clearConfirmTitle: t("toolbox.mysql.historyClearConfirmTitle"),
                    clearConfirmDescription: t(
                      "toolbox.mysql.historyClearConfirmDescription",
                    ),
                    cancel: t("common.cancel"),
                  }}
                />
              ) : (
                <DatabaseResultPane
                  result={tab.result}
                  height={260}
                  paged={false}
                  onPrevious={() => undefined}
                  onNext={() => undefined}
                  labels={{
                    result: t("toolbox.mysql.result"),
                    message: t("toolbox.mysql.message"),
                    ready: t("toolbox.mysql.ready"),
                    null: t("toolbox.mysql.null"),
                    previous: t("toolbox.mysql.previous"),
                    next: t("toolbox.mysql.next"),
                    rowsRange: (from, to) =>
                      t("toolbox.mysql.rowsRange", { from, to }),
                  }}
                  renderContextMenu={(
                    cell,
                    row,
                    columnName,
                    _rowIndex,
                    _columnIndex,
                    source = "row",
                  ) => (
                    <ResultCellMenu
                      source={source}
                      actions={{
                        copyCell: () => void copyText(cell ?? "NULL"),
                        copyRow: () =>
                          void copyText(
                            row.map((value) => value ?? "NULL").join("\t"),
                          ),
                        copyColumnName: () => void copyText(columnName),
                        exportCsv: () => void exportCsv(),
                        exportExcel: () => void exportExcel(),
                      }}
                      labels={resultMenuLabels}
                    />
                  )}
                  renderError={(error) => (
                    <DatabaseResultErrorPane
                      error={error}
                      labels={{
                        error: t("toolbox.mysql.queryFailed"),
                        retry: t("toolbox.mysql.errorRetry"),
                        copy: t("toolbox.mysql.errorCopy"),
                        jumpToLine: t("toolbox.mysql.errorJumpToLine"),
                        line: (n) => t("toolbox.mysql.errorLine", { n }),
                        details: t("toolbox.mysql.errorDetails"),
                      }}
                      onRetry={() => void execute()}
                      onCopy={() => void copyText(error.fullText)}
                    />
                  )}
                />
              )}
            </div>
          </section>
        )
      }
    >
      <DatabaseConnectionDialogShell
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        testId="mysql-connection-dialog"
        title={t("toolbox.postgres.connectionSettings")}
        sections={[{ id: "general", label: t("toolbox.postgres.connectionTabs.general") }]}
        activeSection="general"
        onActiveSectionChange={() => undefined}
        saveLabel={t("common.save")}
        primaryLabel={t("toolbox.mysql.connect")}
        onSave={() => void save()}
        onPrimary={() => void connect()}
        busy={connecting}
      >
          <DatabaseConnectionFormGrid>
            <Field label={t("toolbox.mysql.provider")}>
              <DatabaseProviderSelect
                value="mysql"
                disabled={connections.some((item) => item.id === draft.id)}
                onValueChange={(providerId) => {
                  if (providerId !== "mysql") {
                    setDialogOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("nexterm:database-provider-selected", {
                        detail: providerId,
                      }),
                    );
                  }
                }}
              />
            </Field>
            <Field label={t("toolbox.mysql.name")}>
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label={t("toolbox.mysql.host")}>
              <Input
                value={draft.providerConfig.host}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    providerConfig: {
                      ...current.providerConfig,
                      host: event.target.value,
                    },
                  }))
                }
              />
            </Field>
            <Field label={t("toolbox.mysql.port")}>
              <Input
                type="number"
                value={portInput}
                onChange={(event) => setPortInput(event.target.value)}
              />
            </Field>
            <Field label={t("toolbox.mysql.database")}>
              <Input
                value={draft.providerConfig.database}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    providerConfig: {
                      ...current.providerConfig,
                      database: event.target.value,
                    },
                  }))
                }
              />
            </Field>
            <Field label={t("toolbox.mysql.username")}>
              <Input
                value={draft.providerConfig.username}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    providerConfig: {
                      ...current.providerConfig,
                      username: event.target.value,
                    },
                  }))
                }
              />
            </Field>
            <Field label={t("toolbox.mysql.password")}>
              <Input
                type="password"
                value={draft.providerConfig.password ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    providerConfig: {
                      ...current.providerConfig,
                      password: event.target.value,
                    },
                  }))
                }
              />
            </Field>
          </DatabaseConnectionFormGrid>
      </DatabaseConnectionDialogShell>
      {deleteTarget && (
        <Dialog open onOpenChange={() => setDeleteTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("toolbox.mysql.deleteConnection")}</DialogTitle>
            </DialogHeader>
            <p>
              {t("toolbox.mysql.deleteConfirm", { name: deleteTarget.name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteTarget(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="button" onClick={() => void remove()}>
                {t("common.delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </DatabaseWorkspaceShell>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <DatabaseConnectionField label={label}>{children}</DatabaseConnectionField>
  );
}
function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  testId,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 rounded-sm px-2 text-[12px]"
      onClick={onClick}
      disabled={disabled}
      title={label}
      data-testid={testId}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </Button>
  );
}
