import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  Database,
  FolderTree,
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
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/code-editor";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import { DatabaseProviderSelect } from "@/components/toolbox/database-provider-select";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import { DatabaseWorkspaceShell } from "@/components/toolbox/database-workspace-shell";
import { generateId } from "@/lib/toolbox/toolbox-storage";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
import { mysqlProvider } from "@/lib/database/provider-registry";
import {
  createMySQLNavigatorConnectionNode,
  getMySQLRelationReference,
  loadMySQLNavigatorChildren,
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
  const execute = async () => {
    if (!tab || !tab.sql.trim()) return;
    setRunning(true);
    try {
      const result = adaptMySQLQueryResult(
        await invoke<MySQLQueryRuntimeResult>("mysql_execute", {
          request: { connectionId: draft.id, sql: tab.sql },
        }),
      );
      setTabs((current) =>
        current.map((item) =>
          item.id === tab.id ? { ...item, result } : item,
        ),
      );
    } catch (error) {
      toast.error(t("toolbox.mysql.queryFailed"), {
        description: String(error),
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
              onOpen={(node) => {
                const relation = getMySQLRelationReference(node);
                if (relation) {
                  const next = newTab();
                  next.sql = `SELECT * FROM \`${relation.relation.replace(/`/g, "``")}\` LIMIT 100;`;
                  setTabs((current) => [...current, next]);
                  setActiveTab(next.id);
                }
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
      onCloseTab={(id) => {
        setTabs((current) => current.filter((item) => item.id !== id));
        if (id === activeTab)
          setActiveTab(tabs.find((item) => item.id !== id)?.id ?? "");
      }}
      tabClassName={(_, active) =>
        `group flex h-8 min-w-28 items-center gap-1 border-r px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${active ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"}`
      }
      workspace={
        tab && (
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
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
                className="h-full"
              />
            </div>
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
            />
          </section>
        )
      }
    >
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="!inset-0 !m-auto !h-[min(600px,calc(100vh-32px))] !w-[560px] !max-w-[calc(100vw-32px)] !translate-x-0 !translate-y-0 gap-0 overflow-hidden rounded-md p-0"
          data-testid="mysql-connection-dialog"
        >
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle className="text-sm">{t("toolbox.mysql.connectionSettings")}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="grid gap-3">
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
          </div>
          </div>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <Button
              size="sm"
              type="button"
              variant="outline"
              className="rounded-sm"
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
            <Button
              size="sm"
              type="button"
              className="rounded-sm"
              onClick={() => void connect()}
              disabled={connecting}
            >
              {t("toolbox.mysql.connect")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
    <div className="grid gap-1">
      <Label>{label}</Label>
      {children}
    </div>
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
      className="h-7 gap-1 rounded-sm px-2 text-[12px]"
      onClick={onClick}
      disabled={disabled}
      title={label}
      data-testid={testId}
    >
      {icon}
      <span>{label}</span>
    </Button>
  );
}
