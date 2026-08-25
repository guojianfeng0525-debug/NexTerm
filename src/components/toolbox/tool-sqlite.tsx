import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Database, FileCode2, FolderTree, Loader2, Play, Plus, RefreshCw, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CodeEditor } from "@/components/code-editor";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import { DatabaseProviderSelect } from "@/components/toolbox/database-provider-select";
import { createSqliteNavigatorConnectionNode, getSqliteRelationReference, loadSqliteNavigatorChildren } from "@/lib/database/sqlite-object-loader";
import { createSqliteQueryEditorContext } from "@/lib/database/sqlite-query-editor";
import { adaptSqliteQueryResult, type SqliteQueryRuntimeResult } from "@/lib/database/sqlite-result-adapter";
import { sqliteProvider } from "@/lib/database/provider-registry";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
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

export function ToolSqlite() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState(() => SqliteConnectionsStorage.load());
  const [draft, setDraft] = useState<SQLiteConnectionProfile>(() => SqliteConnectionsStorage.load()[0] ?? newProfile());
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SQLiteConnectionProfile | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<DatabaseObjectNodeId, boolean>>>({});
  const [children, setChildren] = useState<Children>({});
  const [selected, setSelected] = useState<DatabaseObjectNodeId | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [activeTab, setActiveTab] = useState(() => tabs[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const roots = connections.map((connection) => createSqliteNavigatorConnectionNode({ id: connection.id, name: connection.name, filePath: connection.providerConfig.filePath }));
  const nodes = [...roots, ...Object.values(children).flatMap((items) => items ?? [])];
  const executeCommand = resolveDatabaseCommand("database.query.execute", { scope: "QUERY_EDITOR", provider: sqliteProvider, connectionState: connected ? "connected" : "disconnected" });
  const explainCommand = resolveDatabaseCommand("database.query.explain", { scope: "QUERY_EDITOR", provider: sqliteProvider, connectionState: connected ? "connected" : "disconnected" });

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
  const execute = async () => {
    if (!connected || !tab?.sql.trim()) return;
    setRunning(true);
    try { patchTab(tab.id, { result: adaptSqliteQueryResult(await invoke<SqliteQueryRuntimeResult>("sqlite_execute", { request: { connectionId: draft.id, sql: tab.sql } })) }); }
    catch (error) { toast.error(t("toolbox.sqlite.queryFailed"), { description: String(error) }); }
    finally { setRunning(false); }
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

  return <div className="h-full min-h-0 flex flex-col bg-background text-foreground" data-testid="sqlite-workspace">
    <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/25 px-2">
      <ToolButton icon={<Plus />} label={t("toolbox.sqlite.newConnection")} onClick={() => { setDraft(newProfile()); setDialogOpen(true); }} testId="sqlite-new-connection" />
      <ToolButton icon={<Database />} label={t("toolbox.sqlite.editConnection")} disabled={!connections.some((item) => item.id === draft.id)} onClick={() => setDialogOpen(true)} testId="sqlite-edit-connection" />
      <ToolButton icon={<X />} label={t("toolbox.sqlite.deleteConnection")} disabled={!connections.some((item) => item.id === draft.id)} onClick={() => setDeleteTarget(draft)} testId="sqlite-delete-connection" />
      <ToolButton icon={<FileCode2 />} label={t("toolbox.sqlite.newQuery")} disabled={!connected} onClick={() => { const next = newTab(); setTabs((current) => [...current, next]); setActiveTab(next.id); }} testId="sqlite-new-query" />
      <ToolButton icon={<RefreshCw />} label={t("toolbox.sqlite.refresh")} disabled={!connected} onClick={() => Promise.all(nodes.filter((node) => expanded[node.id]).map(load)).then(() => undefined)} testId="sqlite-refresh" />
      <span className="ml-auto mr-2 text-[11px] text-muted-foreground">{connected ? t("toolbox.sqlite.experimental") : t("toolbox.sqlite.disconnected")}</span>
      {connected ? <ToolButton icon={<Unplug />} label={t("toolbox.sqlite.disconnect")} onClick={() => invoke("sqlite_disconnect", { connectionId: draft.id }).then(() => setConnected(false))} testId="sqlite-disconnect" /> : <ToolButton icon={<Database />} label={t("toolbox.sqlite.connect")} onClick={() => setDialogOpen(true)} testId="sqlite-connect" />}
    </header>
    <div className="flex min-h-0 flex-1"><aside className="w-72 shrink-0 border-r bg-muted/10"><div className="flex h-8 items-center gap-1 border-b px-2"><FolderTree className="h-3.5 w-3.5" /><span className="text-[11px] font-semibold">{t("toolbox.sqlite.navigator")}</span></div><div className="overflow-auto py-1"><DatabaseNavigator roots={roots} childrenByParent={children} expanded={expanded} selectedNodeId={selected} filter="" onToggle={(node) => { const next = !expanded[node.id]; setExpanded((current) => ({ ...current, [node.id]: next })); if (next && !children[node.id]) void load(node); }} onSelect={(node) => { setSelected(node.id); if (node.kind === "connection") { const profile = connections.find((item) => item.id === node.reference.path[0]); if (profile) { setDraft(profile); setConnected(false); } } }} onOpen={(node) => { const relation = getSqliteRelationReference(node); if (relation) { const next = newTab(); next.sql = `SELECT * FROM "${relation.relation.replace(/"/g, '""')}" LIMIT 100;`; setTabs((current) => [...current, next]); setActiveTab(next.id); } }} /></div></aside>
      <main className="flex min-w-0 flex-1 flex-col"><nav className="flex h-8 shrink-0 border-b">{tabs.map((item) => <button key={item.id} type="button" className="flex h-8 min-w-28 items-center gap-1 border-r px-2 text-[12px]" onClick={() => setActiveTab(item.id)}><FileCode2 className="h-3.5 w-3.5" />{t("toolbox.sqlite.query")}<X className="ml-auto h-3 w-3" onClick={(event) => { event.stopPropagation(); setTabs((current) => current.filter((candidate) => candidate.id !== item.id)); }} /></button>)}</nav>
        {tab && <section className="flex min-h-0 flex-1 flex-col"><div className="flex h-8 shrink-0 items-center gap-1 border-b px-2"><ToolButton icon={<Play />} label={t("toolbox.sqlite.run")} disabled={executeCommand.state !== "enabled" || running} onClick={() => void execute()} testId="sqlite-run" />{explainCommand.state !== "hidden" && null}{running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}</div><div className="min-h-0 flex-1"><CodeEditor value={tab.sql} onChange={(sql) => patchTab(tab.id, { sql })} language="sql" queryContext={connected ? createSqliteQueryEditorContext({ connectionId: draft.id, lookup: async () => (await invoke<readonly { readonly name: string }[]>("sqlite_catalog_objects", { connectionId: draft.id })).map((item) => item.name) }) : undefined} className="h-full" /></div><DatabaseResultPane result={tab.result} height={260} paged={false} onPrevious={() => undefined} onNext={() => undefined} labels={{ result: t("toolbox.sqlite.result"), message: t("toolbox.sqlite.message"), ready: t("toolbox.sqlite.ready"), null: t("toolbox.sqlite.null"), previous: t("toolbox.sqlite.previous"), next: t("toolbox.sqlite.next"), rowsRange: (from, to) => t("toolbox.sqlite.rowsRange", { from, to }) }} /></section>}</main></div>
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="!inset-0 !m-auto !h-fit !w-[560px] !max-w-[calc(100vw-32px)] !translate-x-0 !translate-y-0" data-testid="sqlite-connection-dialog"><DialogHeader><DialogTitle>{t("toolbox.sqlite.connectionSettings")}</DialogTitle></DialogHeader><div className="grid gap-3"><Field label={t("toolbox.sqlite.provider")}><DatabaseProviderSelect value="sqlite" disabled={connections.some((item) => item.id === draft.id)} onValueChange={(providerId) => { if (providerId !== "sqlite") { setDialogOpen(false); window.dispatchEvent(new CustomEvent("nexterm:database-provider-selected", { detail: providerId })); } }} /></Field><Field label={t("toolbox.sqlite.name")}><Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field><Field label={t("toolbox.sqlite.databaseFile")}><div className="flex gap-2"><Input value={draft.providerConfig.filePath} onChange={(event) => setDraft((current) => ({ ...current, providerConfig: { ...current.providerConfig, filePath: event.target.value } }))} /><Button type="button" variant="outline" onClick={() => void chooseFile()}>{t("toolbox.sqlite.browse")}</Button></div></Field><div className="flex items-center gap-2"><Switch checked={draft.providerConfig.readOnly} onCheckedChange={(readOnly) => setDraft((current) => ({ ...current, providerConfig: { ...current.providerConfig, readOnly } }))} /><Label>{t("toolbox.sqlite.readOnly")}</Label></div></div><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => void save()}>{t("common.save")}</Button><Button type="button" onClick={() => void connect()} disabled={connecting}>{t("toolbox.sqlite.connect")}</Button></div></DialogContent></Dialog>
    <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("toolbox.sqlite.deleteConnection")}</AlertDialogTitle><AlertDialogDescription>{t("toolbox.sqlite.deleteConfirm", { name: deleteTarget?.name })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void remove()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t("common.delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}

function ToolButton({ icon, label, onClick, disabled, testId }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; testId?: string }) { return <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 rounded-sm px-2 text-[12px]" onClick={onClick} disabled={disabled} title={label} data-testid={testId}>{icon}<span>{label}</span></Button>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label className="text-[11px] text-muted-foreground">{label}</Label>{children}</div>; }
