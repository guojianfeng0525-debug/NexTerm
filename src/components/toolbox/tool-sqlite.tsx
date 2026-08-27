import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile as writeBinaryFile } from "@tauri-apps/plugin-fs";
import {
  writeText as writeClipboardText,
  readText as readClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import { undo, redo, selectAll } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import {
  Database,
  FileCode2,
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
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CodeEditor } from "@/components/code-editor";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import { DatabaseResultErrorPane } from "@/components/toolbox/database-result-error";
import { DatabaseWorkspaceShell } from "@/components/toolbox/database-workspace-shell";
import { DatabaseProviderSelect } from "@/components/toolbox/database-provider-select";
import { DatabaseConnectionDialogShell, DatabaseConnectionField, DatabaseConnectionFormGrid, DatabaseConnectionToggleRow } from "@/components/toolbox/database-connection-dialog-shell";
import {
  NavigatorRelationMenu,
  QueryEditorMenu,
  ResultCellMenu,
  type NavigatorRelationMenuLabels,
  type QueryEditorMenuLabels,
  type ResultCellMenuLabels,
} from "@/components/toolbox/db-context-menus";
import { QueryHistoryView } from "@/components/toolbox/query-history-view";
import { createSqliteNavigatorConnectionNode, getSqliteRelationReference, loadSqliteNavigatorChildren, type SqliteRelationReference } from "@/lib/database/sqlite-object-loader";
import { createSqliteQueryEditorContext } from "@/lib/database/sqlite-query-editor";
import { adaptSqliteQueryResult, type SqliteQueryRuntimeResult } from "@/lib/database/sqlite-result-adapter";
import { sqliteProvider } from "@/lib/database/provider-registry";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
import { databaseErrorResult, parseProviderError } from "@/lib/database/database-error";
import { generateSelectSql } from "@/lib/database/sql-generation";
import { addQueryHistory } from "@/lib/database/query-history";
import {
  currentStatementAt,
  toggleLineComment,
} from "@/lib/database/sql-statement-tokenizer";
import { formatSql } from "@/lib/database/sql-formatter";
import { useDatabaseKeyboardShortcuts } from "@/lib/keyboard/use-database-keyboard-shortcuts";
import type { DatabaseObjectNode, DatabaseObjectNodeId } from "@/lib/database/types";
import type { DatabaseResult } from "@/lib/database/result-types";
import type { SQLiteConnectionProfile } from "@/lib/database/sqlite-profile";
import { SqliteConnectionsStorage } from "@/lib/toolbox/sqlite-storage";
import { generateId } from "@/lib/toolbox/toolbox-storage";

type Tab = { id: string; sql: string; result: DatabaseResult | null };
type Children = Partial<Record<DatabaseObjectNodeId, readonly DatabaseObjectNode[]>>;

function newProfile(): SQLiteConnectionProfile {
  const now = Date.now();
  return { id: generateId("sqlite"), name: "SQLite", providerId: "sqlite", environment: "development", createdAt: now, updatedAt: now, providerConfig: { filePath: "", readOnly: false } };
}
function newTab(): Tab { return { id: generateId("sqlite-query"), sql: "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;", result: null }; }

/** SQLite identifier quoting: double inner double quotes. */
const quoteSqliteIdentifier = (id: string): string =>
  `"${id.replace(/"/g, '""')}"`;

export function ToolSqlite() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState(() => SqliteConnectionsStorage.load());
  const [draft, setDraft] = useState<SQLiteConnectionProfile>(() => SqliteConnectionsStorage.load()[0] ?? newProfile());
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SQLiteConnectionProfile | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<DatabaseObjectNodeId, boolean>>>({});
  const [children, setChildren] = useState<Children>({});
  const [selected, setSelected] = useState<DatabaseObjectNodeId | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [activeTab, setActiveTab] = useState(() => tabs[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const queryEditorViewRef = useRef<EditorView | null>(null);
  const roots = connections.map((connection) => createSqliteNavigatorConnectionNode({ id: connection.id, name: connection.name, filePath: connection.providerConfig.filePath }));
  const nodes = [...roots, ...Object.values(children).flatMap((items) => items ?? [])];
  const executeCommand = resolveDatabaseCommand("database.query.execute", { scope: "QUERY_EDITOR", provider: sqliteProvider, connectionState: connected ? "connected" : "disconnected" });
  const explainCommand = resolveDatabaseCommand("database.query.explain", { scope: "QUERY_EDITOR", provider: sqliteProvider, connectionState: connected ? "connected" : "disconnected" });

  const navigatorMenuLabels: NavigatorRelationMenuLabels = {
    openData: t("toolbox.sqlite.openData"),
    copyName: t("toolbox.sqlite.copyName"),
    generateSql: t("toolbox.sqlite.generateSql"),
    generateSqlSelect: t("toolbox.sqlite.generateSqlSelect"),
    generateSqlInsert: t("toolbox.sqlite.generateSqlInsert"),
    generateSqlUpdate: t("toolbox.sqlite.generateSqlUpdate"),
    generateSqlDelete: t("toolbox.sqlite.generateSqlDelete"),
    refresh: t("toolbox.sqlite.refresh"),
    newQuery: t("toolbox.sqlite.newQuery"),
  };
  const editorMenuLabels: QueryEditorMenuLabels = {
    undo: t("common.undo"),
    redo: t("common.redo"),
    cut: t("common.cut"),
    copy: t("common.copy"),
    paste: t("common.paste"),
    selectAll: t("common.selectAll"),
    run: t("toolbox.sqlite.run"),
    runSelection: t("toolbox.sqlite.runSelection"),
    formatSql: t("toolbox.sqlite.formatSql"),
    toggleComment: t("toolbox.sqlite.toggleComment"),
  };
  const resultMenuLabels: ResultCellMenuLabels = {
    copyCell: t("toolbox.sqlite.copyCell"),
    copyRow: t("toolbox.sqlite.copyRow"),
    copyColumnName: t("toolbox.sqlite.copyColumnName"),
    exportCsv: t("toolbox.sqlite.exportCsv"),
    exportExcel: t("toolbox.sqlite.exportExcel"),
    removeRecord: t("toolbox.sqlite.removeRecord"),
  };

  useEffect(() => {
    const pasteSqlNote = (event: Event) => {
      const detail = (event as CustomEvent<{ content?: string; handled?: boolean; provider?: string }>).detail;
      if (detail?.provider !== undefined && detail.provider !== "sqlite") return;
      if (!detail?.content || !tab) return;
      patchTab(tab.id, { sql: detail.content });
      detail.handled = true;
    };
    window.addEventListener('nexterm:paste-sql-note', pasteSqlNote);
    return () => window.removeEventListener('nexterm:paste-sql-note', pasteSqlNote);
  }, [tab]);

  // Query-history round-trip: "run again" re-executes, "insert" appends to the editor.
  useEffect(() => {
    const onExecuteHistory = (event: Event) => {
      const detail = (event as CustomEvent<{ providerId?: string; sql?: string; connectionId?: string }>).detail;
      if (!detail?.sql || detail.providerId !== "sqlite") return;
      if (detail.connectionId && detail.connectionId !== draft.id) return;
      if (!tab) return;
      patchTab(tab.id, { sql: detail.sql });
      void execute(detail.sql);
    };
    const onInsertHistory = (event: Event) => {
      const detail = (event as CustomEvent<{ providerId?: string; sql?: string }>).detail;
      if (!detail?.sql || detail.providerId !== "sqlite") return;
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
    const update = () => setConnections(SqliteConnectionsStorage.load());
    window.addEventListener("nexterm:toolbox-changed", update);
    return () => window.removeEventListener("nexterm:toolbox-changed", update);
  }, []);

  const patchTab = (id: string, patch: Partial<Tab>) => setTabs((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const load = async (node: DatabaseObjectNode) => {
    try { const next = await loadSqliteNavigatorChildren(node, t("toolbox.sqlite.tables")); setChildren((current) => ({ ...current, [node.id]: next })); return next; }
    catch (error) { toast.error(t("toolbox.sqlite.metadataFailed"), { description: String(error) }); return []; }
  };
  const connect = async () => {
    if (!draft.name.trim() || !draft.providerConfig.filePath.trim()) { toast.error(t("toolbox.sqlite.required")); return; }
    setConnecting(true);
    try {
      const saved = { ...draft, updatedAt: Date.now() };
      if (!(await SqliteConnectionsStorage.upsert(saved))) throw new Error(t("toolbox.sqlite.saveFailed"));
      setDraft(saved);
      await invoke("sqlite_connect", { request: { connectionId: saved.id, filePath: saved.providerConfig.filePath, readOnly: saved.providerConfig.readOnly } });
      setConnected(true); setDialogOpen(false);
      const root = createSqliteNavigatorConnectionNode({ id: saved.id, name: saved.name, filePath: saved.providerConfig.filePath });
      const catalog = (await load(root))[0];
      const group = catalog ? (await load(catalog))[0] : undefined;
      if (group) await load(group);
      setExpanded({ [root.id]: true, ...(catalog ? { [catalog.id]: true } : {}), ...(group ? { [group.id]: true } : {}) }); setSelected(root.id);
      toast.success(t("toolbox.sqlite.connected"));
    } catch (error) { toast.error(t("toolbox.sqlite.connectFailed"), { description: String(error) }); }
    finally { setConnecting(false); }
  };
  const execute = async (sqlOverride?: string) => {
    const sql = sqlOverride ?? tab?.sql ?? "";
    if (!connected || !sql.trim()) return;
    setRunning(true);
    try {
      patchTab(tab.id, {
        result: adaptSqliteQueryResult(
          await invoke<SqliteQueryRuntimeResult>("sqlite_execute", {
            request: { connectionId: draft.id, sql },
          }),
        ),
      });
      addQueryHistory({
        sql,
        connectionId: draft.id,
        connectionName: draft.name,
        providerId: "sqlite",
        success: true,
      });
    } catch (error) {
      const parsed = parseProviderError("sqlite", String(error));
      patchTab(tab.id, { result: databaseErrorResult(parsed) });
      toast.error(t("toolbox.sqlite.queryFailed"), {
        description: parsed.message,
      });
      addQueryHistory({
        sql,
        connectionId: draft.id,
        connectionName: draft.name,
        providerId: "sqlite",
        success: false,
      });
    } finally { setRunning(false); }
  };
  const addQuery = () => {
    const next = newTab();
    setTabs((current) => [...current, next]);
    setActiveTab(next.id);
  };
  const closeTab = (id: string) => {
    setTabs((current) => current.filter((candidate) => candidate.id !== id));
    if (id === activeTab) setActiveTab(tabs.find((candidate) => candidate.id !== id)?.id ?? "");
  };
  const copyText = async (value: string) => {
    try { await writeClipboardText(value); } catch { /* clipboard unavailable */ }
  };
  const qualifiedSqliteName = (relation: SqliteRelationReference): string =>
    quoteSqliteIdentifier(relation.relation);
  const selectSqlFor = (relation: SqliteRelationReference): string =>
    generateSelectSql("", relation.relation, null, {
      quoteIdentifier: quoteSqliteIdentifier,
    });
  const openRelationData = (node: DatabaseObjectNode) => {
    const relation = getSqliteRelationReference(node);
    if (!relation) return;
    const next = newTab();
    next.sql = selectSqlFor(relation);
    setTabs((current) => [...current, next]);
    setActiveTab(next.id);
  };
  const insertGeneratedSql = (sql: string) => {
    const view = queryEditorViewRef.current;
    if (!view) {
      const next = newTab();
      next.sql = sql;
      setTabs((current) => [...current, next]);
      setActiveTab(next.id);
      return;
    }
    const doc = view.state.doc;
    const insertAt = doc.length;
    const needsLeadingNewline = insertAt > 0 && doc.sliceString(insertAt - 1, insertAt) !== "\n";
    const insertText = (needsLeadingNewline ? "\n" : "") + sql + "\n";
    view.dispatch({ changes: { from: insertAt, to: insertAt, insert: insertText } });
    view.dispatch({ selection: { anchor: insertAt, head: insertAt + insertText.length } });
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
      await writeClipboardText(view.state.doc.sliceString(selection.from, selection.to));
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: "" } });
    } catch { /* clipboard unavailable */ }
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
    } catch { /* clipboard unavailable */ }
  };
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
  const runSelectionOrStatement = () => {
    const view = queryEditorViewRef.current;
    const selected = view
      ? view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to).trim()
      : "";
    const sql = selected || currentStatementSql() || (tab?.sql ?? "");
    if (sql.trim()) void execute(sql);
  };
  const toggleSqlComment = () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    const doc = view.state.doc.toString();
    const next = toggleLineComment(doc, selection.from, selection.to);
    if (next === doc) return;
    view.dispatch({ changes: { from: 0, to: doc.length, insert: next } });
  };
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
        selection: { anchor: selection.from, head: selection.from + formatted.length },
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
        defaultPath: "sqlite-result.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, csv);
      toast.success(t("toolbox.sqlite.exported"));
    } catch (error) {
      toast.error(t("toolbox.sqlite.exportFailed"), { description: String(error) });
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
      XLSX.utils.book_append_sheet(workbook, sheet, "SQLite Result");
      const path = await saveFile({
        defaultPath: "sqlite-result.xlsx",
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!path) return;
      await writeBinaryFile(
        path,
        new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
      );
      toast.success(t("toolbox.sqlite.exportedExcel"));
    } catch (error) {
      toast.error(t("toolbox.sqlite.exportFailedExcel"), { description: String(error) });
    }
  };
  const chooseFile = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }] });
    if (typeof path === "string") setDraft((current) => ({ ...current, providerConfig: { ...current.providerConfig, filePath: path } }));
  };
  const save = async () => {
    const saved = { ...draft, updatedAt: Date.now() };
    if (!(await SqliteConnectionsStorage.upsert(saved))) {
      toast.error(t("toolbox.sqlite.saveFailed"));
      return;
    }
    setDraft(saved);
    toast.success(t("toolbox.sqlite.saved"));
  };
  const remove = async () => {
    if (!deleteTarget) return;
    try {
      if (!(await SqliteConnectionsStorage.remove(deleteTarget.id))) {
        throw new Error(t("toolbox.sqlite.deleteFailed"));
      }
      if (draft.id === deleteTarget.id) setDraft(newProfile());
      setDeleteTarget(null);
      toast.success(t("toolbox.sqlite.deleted"));
    } catch (error) {
      toast.error(t("toolbox.sqlite.deleteFailed"), { description: String(error) });
    }
  };

  useDatabaseKeyboardShortcuts({
    testId: "sqlite-workspace",
    dialogOpen,
    handlers: {
      "database.query.execute": () => void execute(),
      "database.workspace.newQuery": addQuery,
    },
  });

  return <DatabaseWorkspaceShell
    testId="sqlite-workspace"
    toolbar={<>
      <ToolButton icon={<Plus />} label={t("toolbox.sqlite.newConnection")} onClick={() => { setDraft(newProfile()); setDialogOpen(true); }} testId="sqlite-new-connection" />
      <ToolButton icon={<Database />} label={t("toolbox.sqlite.editConnection")} disabled={!connections.some((item) => item.id === draft.id)} onClick={() => setDialogOpen(true)} testId="sqlite-edit-connection" />
      <ToolButton icon={<X />} label={t("toolbox.sqlite.deleteConnection")} disabled={!connections.some((item) => item.id === draft.id)} onClick={() => setDeleteTarget(draft)} testId="sqlite-delete-connection" />
      <ToolButton icon={<FileCode2 />} label={t("toolbox.sqlite.newQuery")} disabled={!connected} onClick={addQuery} testId="sqlite-new-query" />
      <ToolButton icon={<History />} label={t("toolbox.sqlite.history")} onClick={() => setHistoryOpen((open) => !open)} testId="sqlite-history" />
      <ToolButton icon={<RefreshCw />} label={t("toolbox.sqlite.refresh")} disabled={!connected} onClick={() => Promise.all(nodes.filter((node) => expanded[node.id]).map(load)).then(() => undefined)} testId="sqlite-refresh" />
      <span className="ml-auto mr-2 text-[11px] text-muted-foreground">{connected ? t("toolbox.sqlite.experimental") : t("toolbox.sqlite.disconnected")}</span>
      {connected ? <ToolButton icon={<Unplug />} label={t("toolbox.sqlite.disconnect")} onClick={() => invoke("sqlite_disconnect", { connectionId: draft.id }).then(() => setConnected(false))} testId="sqlite-disconnect" /> : <ToolButton icon={<Database />} label={t("toolbox.sqlite.connect")} onClick={() => setDialogOpen(true)} testId="sqlite-connect" />}
    </>}
    navigator={<aside className="flex min-h-0 w-72 shrink-0 flex-col border-r bg-muted/10"><div className="flex h-8 items-center gap-1 border-b px-2"><FolderTree className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("toolbox.sqlite.navigator")}</span></div><div className="min-h-0 flex-1 overflow-auto py-1"><DatabaseNavigator roots={roots} childrenByParent={children} expanded={expanded} selectedNodeId={selected} filter="" onToggle={(node) => { const next = !expanded[node.id]; setExpanded((current) => ({ ...current, [node.id]: next })); if (next && !children[node.id]) void load(node); }} onSelect={(node) => { setSelected(node.id); if (node.kind === "connection") { const profile = connections.find((item) => item.id === node.reference.path[0]); if (profile) { setDraft(profile); setConnected(false); } } }} onOpen={(node) => openRelationData(node)} renderContextMenu={(node) => {
      const relation = getSqliteRelationReference(node);
      if (!relation) {
        return <>
          <ContextMenuItem disabled={!connected} onSelect={() => void load(node)} data-testid="navigator-menu-refresh"><RefreshCw className="h-3.5 w-3.5" />{t("toolbox.sqlite.refresh")}</ContextMenuItem>
          <ContextMenuItem disabled={!connected} onSelect={addQuery} data-testid="navigator-menu-new-query"><Plus className="h-3.5 w-3.5" />{t("toolbox.sqlite.newQuery")}</ContextMenuItem>
        </>;
      }
      return <NavigatorRelationMenu actions={{
        openData: () => openRelationData(node),
        copyName: () => void copyText(qualifiedSqliteName(relation)),
        generateSelect: () => insertGeneratedSql(selectSqlFor(relation)),
        refresh: () => void load(node),
        newQuery: addQuery,
        disabled: !connected,
      }} labels={navigatorMenuLabels} />;
    }} /></div></aside>}
    tabs={tabs.map((item) => ({ id: item.id, title: t("toolbox.sqlite.query") }))}
    activeTabId={activeTab}
    onActivateTab={setActiveTab}
    onCloseTab={closeTab}
    renderTabContextMenu={(item) => <>
      <ContextMenuItem onSelect={() => closeTab(item.id)}><X className="h-3.5 w-3.5" />{t("common.close")}</ContextMenuItem>
      <ContextMenuItem disabled={tabs.length < 2} onSelect={() => { setTabs((current) => current.filter((candidate) => candidate.id === item.id)); setActiveTab(item.id); }}>{t("toolbox.sqlite.closeOtherTabs")}</ContextMenuItem>
    </>}
    tabClassName={(_, active) => `group flex h-8 min-w-28 items-center gap-1 border-r px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${active ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
    workspace={tab && <section className="flex min-h-0 flex-1 flex-col"><div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b px-2"><ToolButton icon={<Play />} label={t("toolbox.sqlite.run")} disabled={executeCommand.state !== "enabled" || running} onClick={() => void execute()} testId="sqlite-run" />{explainCommand.state !== "hidden" && null}{running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}</div><div className="min-h-0 flex-1"><ContextMenu><ContextMenuTrigger asChild><div className="h-full"><CodeEditor value={tab.sql} onChange={(sql) => patchTab(tab.id, { sql })} language="sql" queryContext={connected ? createSqliteQueryEditorContext({ connectionId: draft.id, lookup: async () => (await invoke<readonly { readonly name: string }[]>("sqlite_catalog_objects", { connectionId: draft.id })).map((item) => item.name) }) : undefined} editorRef={(view) => { queryEditorViewRef.current = view; }} className="h-full" /></div></ContextMenuTrigger><ContextMenuContent><QueryEditorMenu actions={{ undo: () => runCmCommand(undo), redo: () => runCmCommand(redo), cut: () => void cutEditorSelection(), copy: () => void copyText(editorCopyValue()), paste: () => void pasteIntoEditor(), selectAll: () => runCmCommand(selectAll), execute: () => void execute(), runSelection: runSelectionOrStatement, formatSql: formatSqlInEditor, toggleComment: toggleSqlComment, disabledExecute: !connected || !tab.sql.trim() }} labels={editorMenuLabels} /></ContextMenuContent></ContextMenu></div><div className="h-[260px] shrink-0" data-testid="sqlite-result-area">{historyOpen ? <QueryHistoryView open={historyOpen} onOpenChange={setHistoryOpen} providerId="sqlite" connectionId={draft.id} labels={{ history: t("toolbox.sqlite.history"), empty: t("toolbox.sqlite.historyEmpty"), run: t("toolbox.sqlite.historyRun"), insertToEditor: t("toolbox.sqlite.historyInsertToEditor"), copy: t("toolbox.sqlite.historyCopy"), remove: t("toolbox.sqlite.historyRemove"), clear: t("toolbox.sqlite.historyClear"), time: t("toolbox.sqlite.historyTime"), error: t("toolbox.sqlite.historyError"), clearConfirmTitle: t("toolbox.sqlite.historyClearConfirmTitle"), clearConfirmDescription: t("toolbox.sqlite.historyClearConfirmDescription"), cancel: t("common.cancel") }} /> : <DatabaseResultPane result={tab.result} height={260} paged={false} onPrevious={() => undefined} onNext={() => undefined} labels={{ result: t("toolbox.sqlite.result"), message: t("toolbox.sqlite.message"), ready: t("toolbox.sqlite.ready"), null: t("toolbox.sqlite.null"), previous: t("toolbox.sqlite.previous"), next: t("toolbox.sqlite.next"), rowsRange: (from, to) => t("toolbox.sqlite.rowsRange", { from, to }) }} renderContextMenu={(cell, row, columnName, _rowIndex, _columnIndex, source = "row") => <ResultCellMenu source={source} actions={{ copyCell: () => void copyText(cell ?? "NULL"), copyRow: () => void copyText(row.map((value) => value ?? "NULL").join("\t")), copyColumnName: () => void copyText(columnName), exportCsv: () => void exportCsv(), exportExcel: () => void exportExcel() }} labels={resultMenuLabels} />} renderError={(error) => <DatabaseResultErrorPane error={error} labels={{ error: t("toolbox.sqlite.queryFailed"), retry: t("toolbox.sqlite.errorRetry"), copy: t("toolbox.sqlite.errorCopy"), jumpToLine: t("toolbox.sqlite.errorJumpToLine"), line: (n) => t("toolbox.sqlite.errorLine", { n }), details: t("toolbox.sqlite.errorDetails") }} onRetry={() => void execute()} onCopy={() => void copyText(error.fullText)} />} />}</div></section>}
  >
    <DatabaseConnectionDialogShell open={dialogOpen} onOpenChange={setDialogOpen} testId="sqlite-connection-dialog" title={t("toolbox.postgres.connectionSettings")} sections={[{ id: "general", label: t("toolbox.postgres.connectionTabs.general") }]} activeSection="general" onActiveSectionChange={() => undefined} saveLabel={t("common.save")} primaryLabel={t("toolbox.sqlite.connect")} onSave={() => void save()} onPrimary={() => void connect()} busy={connecting}><DatabaseConnectionFormGrid><DatabaseConnectionField label={t("toolbox.sqlite.provider")}><DatabaseProviderSelect value="sqlite" disabled={connections.some((item) => item.id === draft.id)} onValueChange={(providerId) => { if (providerId !== "sqlite") { setDialogOpen(false); window.dispatchEvent(new CustomEvent("nexterm:database-provider-selected", { detail: providerId })); } }} /></DatabaseConnectionField><DatabaseConnectionField label={t("toolbox.sqlite.name")}><Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></DatabaseConnectionField><DatabaseConnectionField fullWidth label={t("toolbox.sqlite.databaseFile")}><div className="flex gap-2"><Input value={draft.providerConfig.filePath} onChange={(event) => setDraft((current) => ({ ...current, providerConfig: { ...current.providerConfig, filePath: event.target.value } }))} /><Button type="button" variant="outline" onClick={() => void chooseFile()}>{t("toolbox.sqlite.browse")}</Button></div></DatabaseConnectionField><DatabaseConnectionToggleRow><Switch checked={draft.providerConfig.readOnly} onCheckedChange={(readOnly) => setDraft((current) => ({ ...current, providerConfig: { ...current.providerConfig, readOnly } }))} /><Label>{t("toolbox.sqlite.readOnly")}</Label></DatabaseConnectionToggleRow></DatabaseConnectionFormGrid></DatabaseConnectionDialogShell>
    <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("toolbox.sqlite.deleteConnection")}</AlertDialogTitle><AlertDialogDescription>{t("toolbox.sqlite.deleteConfirm", { name: deleteTarget?.name })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void remove()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t("common.delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </DatabaseWorkspaceShell>;
}

function ToolButton({ icon, label, onClick, disabled, testId }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; testId?: string }) { return <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 gap-1 rounded-sm px-2 text-[12px]" onClick={onClick} disabled={disabled} title={label} data-testid={testId}>{icon}<span className="whitespace-nowrap">{label}</span></Button>; }
