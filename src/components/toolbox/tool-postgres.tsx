import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Database,
  FileCode2,
  FolderTree,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Table2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CodeEditor } from "@/components/code-editor";
import { generateId } from "@/lib/toolbox/toolbox-storage";
import { PostgresConnectionsStorage } from "@/lib/toolbox/postgres-storage";
import type {
  PostgresConnection,
  PostgresEnvironment,
  PostgresSslMode,
} from "@/lib/toolbox/toolbox-types";
import { createPostgresQueryEditorContext } from "@/lib/database/postgresql-query-editor";
import type { PostgresCatalogLookup } from "@/lib/postgres-completion";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
import { postgresqlProvider } from "@/lib/database/provider-registry";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import {
  createPostgresNavigatorConnectionNode,
  getPostgresRelationReference,
  loadPostgresNavigatorChildren,
  type PostgresRelationReference,
} from "@/lib/database/postgresql-object-loader";
import type {
  DatabaseObjectNode,
  DatabaseObjectNodeId,
} from "@/lib/database/types";

type Result = {
  columns: string[];
  rows: Array<Array<string | null>>;
  commandTags?: string[];
  primaryKeyColumns?: string[];
  truncated: boolean;
};
type TableObject = { schema: string; name: string };
type WorkspaceTab = {
  id: string;
  type: "query" | "table";
  title: string;
  object?: TableObject;
  sql: string;
  result: Result | null;
  dirty?: boolean;
};
type DialogPage = "general" | "ssh" | "tls";

const pageSize = 100;

type NavigatorChildren = Partial<
  Record<DatabaseObjectNodeId, readonly DatabaseObjectNode[]>
>;

async function loadNavigatorChildren(
  node: DatabaseObjectNode,
  tablesLabel: string,
  setNavigatorChildren: Dispatch<SetStateAction<NavigatorChildren>>,
) {
  try {
    const children = await loadPostgresNavigatorChildren(node, tablesLabel);
    setNavigatorChildren((current) => ({ ...current, [node.id]: children }));
    return children;
  } catch {
    setNavigatorChildren((current) => ({ ...current, [node.id]: [] }));
    return [];
  }
}

function newConnection(): PostgresConnection {
  const now = Date.now();
  return {
    id: generateId("postgres"),
    name: "PostgreSQL",
    environment: "development",
    host: "127.0.0.1",
    port: 5432,
    database: "postgres",
    username: "",
    readOnly: false,
    autoCommit: true,
    sslMode: "prefer",
    sshEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
}

function newQuery(): WorkspaceTab {
  return {
    id: generateId("pg-query"),
    type: "query",
    title: "Query",
    sql: "SELECT current_database(), current_user;",
    result: null,
  };
}

export function ToolPostgres() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState(() =>
    PostgresConnectionsStorage.load(),
  );
  const [draft, setDraft] = useState<PostgresConnection>(
    () => PostgresConnectionsStorage.load()[0] ?? newConnection(),
  );
  const [, setSelectedId] = useState<string | null>(
    () => PostgresConnectionsStorage.load()[0]?.id ?? null,
  );
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [navigatorWidth, setNavigatorWidth] = useState(276);
  const [dragging, setDragging] = useState(false);
  const [schema, setSchema] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<
    Partial<Record<DatabaseObjectNodeId, boolean>>
  >({});
  const [navigatorChildren, setNavigatorChildren] =
    useState<NavigatorChildren>({});
  const [selectedNavigatorNodeId, setSelectedNavigatorNodeId] =
    useState<DatabaseObjectNodeId | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([newQuery()]);
  const [activeTab, setActiveTab] = useState<string>(() => tabs[0]?.id ?? "");
  const [resultHeight, setResultHeight] = useState(260);
  const [resultDragging, setResultDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [dialogPage, setDialogPage] = useState<DialogPage>("general");
  const [tableOffset, setTableOffset] = useState(0);

  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const executeCommand = resolveDatabaseCommand("database.query.execute", {
    scope: "QUERY_EDITOR",
    provider: postgresqlProvider,
    connectionState: connected ? "connected" : "disconnected",
  });
  const explainCommand = resolveDatabaseCommand("database.query.explain", {
    scope: "QUERY_EDITOR",
    provider: postgresqlProvider,
    connectionState: connected ? "connected" : "disconnected",
  });
  const disconnectCommand = resolveDatabaseCommand(
    "database.connection.disconnect",
    {
      scope: "DATABASE",
      provider: postgresqlProvider,
      connectionState: connected ? "connected" : "disconnected",
    },
  );
  const newQueryCommand = resolveDatabaseCommand(
    "database.workspace.newQuery",
    {
      scope: "DATABASE",
      provider: postgresqlProvider,
      connectionState: connected ? "connected" : "disconnected",
    },
  );
  const catalogLookup: PostgresCatalogLookup | undefined = connected
    ? async (request) =>
        invoke("postgres_catalog_search", {
          request: { connectionId: draft.id, ...request },
        })
    : undefined;
  const navigatorConnections = connections.length
    ? connections
    : connected
      ? [draft]
      : connections;
  const navigatorRoots = navigatorConnections.map((connection) =>
    createPostgresNavigatorConnectionNode(connection),
  );
  const navigatorNodes = [
    ...navigatorRoots,
    ...Object.values(navigatorChildren).flatMap((children) => children ?? []),
  ];
  const update = <K extends keyof PostgresConnection>(
    key: K,
    value: PostgresConnection[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const updateConnections = () =>
      setConnections(PostgresConnectionsStorage.load());
    window.addEventListener("nexterm:toolbox-changed", updateConnections);
    return () =>
      window.removeEventListener("nexterm:toolbox-changed", updateConnections);
  }, []);
  useEffect(() => {
    if (!connected) return;

    const loadInitialNavigatorPath = async () => {
      const connection = createPostgresNavigatorConnectionNode(draft);
      const catalog = await loadNavigatorChildren(
        connection,
        t("toolbox.postgres.tables"),
        setNavigatorChildren,
      );
      const firstCatalog = catalog[0];
      if (!firstCatalog) return;
      const schemas = await loadNavigatorChildren(
        firstCatalog,
        t("toolbox.postgres.tables"),
        setNavigatorChildren,
      );
      const firstSchema = schemas[0];
      if (!firstSchema) return;
      const groups = await loadNavigatorChildren(
        firstSchema,
        t("toolbox.postgres.tables"),
        setNavigatorChildren,
      );
      const firstGroup = groups[0];
      if (firstGroup)
        await loadNavigatorChildren(
          firstGroup,
          t("toolbox.postgres.tables"),
          setNavigatorChildren,
        );

      setSchema(firstSchema.label);
      setSelectedNavigatorNodeId(connection.id);
      setExpanded({
        [connection.id]: true,
        [firstCatalog.id]: true,
        [firstSchema.id]: true,
        ...(firstGroup ? { [firstGroup.id]: true } : {}),
      });
    };

    void loadInitialNavigatorPath();
  }, [connected, draft, t]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (dragging)
        setNavigatorWidth(Math.max(210, Math.min(440, event.clientX)));
      if (resultDragging)
        setResultHeight(
          Math.max(150, Math.min(520, window.innerHeight - event.clientY - 32)),
        );
    };
    const end = () => {
      setDragging(false);
      setResultDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
  }, [dragging, resultDragging]);

  const save = async () => {
    if (
      !draft.name.trim() ||
      !draft.host.trim() ||
      !draft.database.trim() ||
      !draft.username.trim()
    ) {
      toast.error(t("toolbox.postgres.required"));
      return;
    }
    const saved = { ...draft, updatedAt: Date.now() };
    if (!(await PostgresConnectionsStorage.upsert(saved))) {
      toast.error(t("toolbox.postgres.saveFailed"));
      return;
    }
    setDraft(saved);
    setSelectedId(saved.id);
    toast.success(t("toolbox.postgres.saved"));
  };
  const connect = async () => {
    setConnecting(true);
    try {
      const saved = { ...draft, updatedAt: Date.now() };
      if (!(await PostgresConnectionsStorage.upsert(saved))) {
        toast.error(t("toolbox.postgres.saveFailed"));
        return;
      }
      setDraft(saved);
      setSelectedId(saved.id);
      setConnections((current) => [
        ...current.filter((connection) => connection.id !== saved.id),
        saved,
      ]);
      const status = await invoke<{ serverVersion: string }>(
        "postgres_connect",
        {
          request: {
            connectionId: draft.id,
            host: draft.host,
            port: draft.port,
            database: draft.database,
            username: draft.username,
            password: draft.password,
            readOnly: draft.readOnly,
            sslMode: draft.sslMode,
            sslRootCert: draft.sslRootCert,
            sslClientCert: draft.sslClientCert,
            sslClientKey: draft.sslClientKey,
            ssh: draft.sshEnabled
              ? {
                  host: draft.sshHost,
                  port: draft.sshPort ?? 22,
                  username: draft.sshUsername,
                  authMethod: draft.sshAuthMethod ?? "password",
                  password: draft.sshPassword,
                  privateKey: draft.sshPrivateKey,
                  privateKeyPath: draft.sshPrivateKeyPath,
                  privateKeyPassphrase: draft.sshPrivateKeyPassphrase,
                  hostKeyFingerprint: draft.sshHostKeyFingerprint,
                }
              : undefined,
          },
        },
      );
      setExpanded((current) => ({
        ...current,
        [`connection:${saved.id}`]: true,
      }));
      setConnected(true);
      setConfigOpen(false);
      toast.success(
        t("toolbox.postgres.connected", { version: status.serverVersion }),
      );
    } catch (error) {
      toast.error(t("toolbox.postgres.connectFailed"), {
        description: String(error),
      });
    } finally {
      setConnecting(false);
    }
  };
  const openTab = (next: WorkspaceTab) => {
    setTabs((current) =>
      current.some((item) => item.id === next.id)
        ? current
        : [...current, next],
    );
    setActiveTab(next.id);
  };
  const closeTab = (id: string) =>
    setTabs((current) => {
      const next = current.filter((item) => item.id !== id);
      setActiveTab(next.at(-1)?.id ?? "");
      return next.length ? next : [newQuery()];
    });
  const patchTab = (id: string, patch: Partial<WorkspaceTab>) =>
    setTabs((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const execute = async (explain = false) => {
    if (!connected || !tab?.sql.trim()) return;
    setRunning(true);
    try {
      patchTab(tab.id, {
        result: await invoke<Result>(
          explain ? "postgres_explain" : "postgres_execute",
          { request: { connectionId: draft.id, sql: tab.sql } },
        ),
      });
    } catch (error) {
      toast.error(
        t(
          explain
            ? "toolbox.postgres.explainFailed"
            : "toolbox.postgres.queryFailed",
        ),
        { description: String(error) },
      );
    } finally {
      setRunning(false);
    }
  };
  const browse = async (
    reference: PostgresRelationReference,
    offset = 0,
  ) => {
    if (!connected) return;
    const object: TableObject = {
      schema: reference.schema,
      name: reference.relation,
    };
    const id = `table:${object.schema}.${object.name}`;
    openTab({
      id,
      type: "table",
      title: object.name,
      object,
      sql: "",
      result: null,
    });
    setTableOffset(offset);
    setRunning(true);
    try {
      patchTab(id, {
        result: await invoke<Result>("postgres_table_data", {
          request: {
            connectionId: reference.connectionId,
            schema: object.schema,
            table: object.name,
            limit: pageSize,
            offset,
          },
        }),
      });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: String(error),
      });
    } finally {
      setRunning(false);
    }
  };
  const treeToggle = (node: DatabaseObjectNode) => {
    const willExpand = !(expanded[node.id] ?? false);
    setExpanded((current) => ({ ...current, [node.id]: !current[node.id] }));
    if (willExpand && !navigatorChildren[node.id]) {
      void loadNavigatorChildren(
        node,
        t("toolbox.postgres.tables"),
        setNavigatorChildren,
      );
    }
  };
  const refreshNavigator = async () => {
    const expandedNodes = navigatorNodes.filter(
      (node) => node.expandable && expanded[node.id],
    );
    const refreshed = await Promise.all(
      expandedNodes.map(async (node) => [
        node.id,
        await loadNavigatorChildren(
          node,
          t("toolbox.postgres.tables"),
          setNavigatorChildren,
        ),
      ] as const),
    );
    setNavigatorChildren((current) => ({ ...current, ...Object.fromEntries(refreshed) }));
  };

  return (
    <div
      className="h-full min-h-0 flex flex-col bg-background text-foreground"
      data-testid="postgres-workspace"
    >
      <header
        className="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/25 px-2"
        data-testid="postgres-toolbar"
      >
        <ToolButton
          icon={<Plus />}
          label={t("toolbox.postgres.newConnection")}
          onClick={() => {
            setDraft(newConnection());
            setSelectedId(null);
            setDialogPage("general");
            setConfigOpen(true);
          }}
          data-testid="postgres-new-connection"
        />
        <ToolButton
          icon={<FileCode2 />}
          label={t("toolbox.postgres.newQuery")}
          disabled={newQueryCommand.state !== "enabled"}
          onClick={() => {
            const query = newQuery();
            openTab(query);
          }}
          data-testid="postgres-new-query"
        />
        <Separator />
          <ToolButton
            icon={<Table2 />}
            label={t("toolbox.postgres.tables")}
            disabled={!connected}
            onClick={() => {
              const group = navigatorNodes.find(
                (node) =>
                  node.kind === "group" &&
                  node.parentId === selectedNavigatorNodeId,
              );
              if (group) treeToggle(group);
            }}
        />
        <ToolButton
            icon={<RefreshCw />}
            label={t("toolbox.postgres.refresh")}
            disabled={!connected}
            onClick={() => void refreshNavigator()}
            data-testid="postgres-refresh"
        />
        <div className="flex-1" />
        <span className="mr-2 text-[11px] text-muted-foreground">
          {connected
            ? `${draft.database} / ${schema ?? ""}`
            : t("toolbox.postgres.disconnected")}
        </span>
        {connected ? (
          <ToolButton
            icon={<Unplug />}
            label={t("toolbox.postgres.disconnect")}
            disabled={disconnectCommand.state !== "enabled"}
            onClick={() =>
              void invoke("postgres_disconnect", {
                connectionId: draft.id,
              }).then(() => setConnected(false))
            }
            data-testid="postgres-disconnect"
          />
        ) : (
          <ToolButton
            icon={<Database />}
            label={t("toolbox.postgres.connect")}
            onClick={() => setConfigOpen(true)}
            data-testid="postgres-connect"
          />
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className="relative shrink-0 border-r bg-muted/10"
          style={{ width: navigatorWidth }}
        >
          <div className="flex h-8 items-center gap-1 border-b px-2">
            <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("toolbox.postgres.navigator")}
            </span>
            <Plus className="h-3.5 w-3.5" />
          </div>
          <div className="border-b p-1.5">
            <div className="flex h-6 items-center gap-1 border bg-background px-1.5">
              <Search className="h-3 w-3 text-muted-foreground" />
              <input
                className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t("toolbox.postgres.filterObjects")}
              />
            </div>
          </div>
          <div className="overflow-auto py-1">
            <DatabaseNavigator
              roots={navigatorRoots}
              childrenByParent={navigatorChildren}
              expanded={expanded}
              selectedNodeId={selectedNavigatorNodeId}
              filter={filter}
              onToggle={treeToggle}
              onSelect={(node) => {
                setSelectedNavigatorNodeId(node.id);
                if (node.kind === "connection") {
                  const connection = navigatorConnections.find(
                    (item) => item.id === node.reference.path[0],
                  );
                  if (connection) {
                    setDraft(connection);
                    setSelectedId(connection.id);
                    setConnected(false);
                  }
                }
                if (node.kind === "schema") setSchema(node.label);
                const relation = getPostgresRelationReference(node);
                if (relation) setSchema(relation.schema);
              }}
              onOpen={(node) => {
                const relation = getPostgresRelationReference(node);
                if (relation) void browse(relation);
              }}
            />
            {!connections.length && (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                {t("toolbox.postgres.noConnections")}
              </p>
            )}
          </div>
          <div
            className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize"
            onPointerDown={() => setDragging(true)}
          />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <nav className="flex h-8 shrink-0 items-end overflow-x-auto border-b bg-muted/15">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`group flex h-8 min-w-28 items-center gap-1 border-r px-2 text-[12px] ${item.id === activeTab ? "bg-background font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                <span className="max-w-32 truncate">{item.title}</span>
                {item.dirty && (
                  <i className="h-1.5 w-1.5 rounded-full bg-primary" />
                )}
                <X
                  className="ml-auto h-3 w-3 opacity-0 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(item.id);
                  }}
                />
              </button>
            ))}
          </nav>
          {tab && (
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/10 px-2">
                <ToolButton
                  icon={<Play />}
                  label={t("toolbox.postgres.run")}
                  disabled={executeCommand.state !== "enabled" || running}
                  onClick={() => void execute()}
                  data-testid="postgres-run"
                />
                {tab.type === "query" && (
                  <ToolButton
                    icon={<KeyRound />}
                    label={t("toolbox.postgres.explain")}
                    disabled={explainCommand.state !== "enabled" || running}
                    onClick={() => void execute(true)}
                    data-testid="postgres-explain"
                  />
                )}
                {tab.type === "table" && (
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    {tab.object?.schema}.{tab.object?.name}
                  </span>
                )}
                <div className="flex-1" />
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              </div>
              {tab.type === "query" && (
                <div className="min-h-0 flex-1">
                  <CodeEditor
                    value={tab.sql}
                    onChange={(sql) => patchTab(tab.id, { sql, dirty: true })}
                    language="sql"
                    queryContext={
                      catalogLookup
                        ? createPostgresQueryEditorContext({
                            connectionId: draft.id,
                            catalog: draft.database,
                            schema: schema ?? undefined,
                            lookup: catalogLookup,
                          })
                        : undefined
                    }
                    className="h-full"
                  />
                </div>
              )}
              {tab.type === "table" && (
                <div className="min-h-0 flex-1 bg-background" />
              )}
              <div
                className="h-1 shrink-0 cursor-row-resize border-y bg-muted/50"
                onPointerDown={() => setResultDragging(true)}
              />
              <ResultPane
                result={tab.result}
                height={resultHeight}
                table={tab.type === "table"}
                offset={tableOffset}
                onPrevious={() =>
                  tab.object &&
                  void browse(
                    {
                      connectionId: draft.id,
                      database: draft.database,
                      schema: tab.object.schema,
                      relation: tab.object.name,
                    },
                    Math.max(0, tableOffset - pageSize),
                  )
                }
                onNext={() =>
                  tab.object &&
                  void browse(
                    {
                      connectionId: draft.id,
                      database: draft.database,
                      schema: tab.object.schema,
                      relation: tab.object.name,
                    },
                    tableOffset + pageSize,
                  )
                }
                t={t}
              />
            </section>
          )}
        </main>
      </div>
      <footer className="flex h-6 shrink-0 items-center border-t bg-muted/25 px-2 text-[11px] text-muted-foreground">
        <span>
          {connected
            ? `PostgreSQL · ${draft.environment}`
            : t("toolbox.postgres.disconnected")}
        </span>
        <span className="mx-2">|</span>
        <span>{schema ?? "-"}</span>
        <span className="ml-auto">
          {running
            ? t("toolbox.postgres.executing")
            : t("toolbox.postgres.ready")}
        </span>
      </footer>
      <ConnectionDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        page={dialogPage}
        setPage={setDialogPage}
        draft={draft}
        update={update}
        save={save}
        connect={connect}
        connecting={connecting}
        t={t}
      />
    </div>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  "data-testid": testId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  "data-testid"?: string;
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
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span>{label}</span>
    </Button>
  );
}
function Separator() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}
function ResultPane({
  result,
  height,
  table,
  offset,
  onPrevious,
  onNext,
  t,
}: {
  result: Result | null;
  height: number;
  table: boolean;
  offset: number;
  onPrevious: () => void;
  onNext: () => void;
  t: TFunction;
}) {
  return (
    <section className="shrink-0 overflow-auto border-t" style={{ height }}>
      <div className="flex h-7 items-center border-b bg-muted/20 px-2 text-[11px]">
        <span className="border-r pr-3 font-medium">
          {result ? "Result 1" : t("toolbox.postgres.message")}
        </span>
        <span className="ml-2 text-muted-foreground">
          {result?.commandTags?.join(" · ")}
        </span>
      </div>
      {result ? (
        <>
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="w-10 border-b border-r px-2 text-right font-normal text-muted-foreground">
                  #
                </th>
                {result.columns.map((column) => (
                  <th
                    key={column}
                    className="whitespace-nowrap border-b border-r px-2 py-1 text-left font-medium"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index} className="hover:bg-primary/5">
                  {" "}
                  <td className="border-b border-r px-2 text-right text-muted-foreground">
                    {offset + index + 1}
                  </td>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${index}:${cellIndex}`}
                      className="whitespace-nowrap border-b border-r px-2 py-1.5 select-text"
                    >
                      {cell ?? (
                        <span className="text-muted-foreground">NULL</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table && (
            <div className="sticky bottom-0 flex h-7 items-center gap-1 border-t bg-background px-2 text-[11px]">
              <span>
                {t("toolbox.postgres.rowsRange", {
                  from: offset + 1,
                  to: offset + result.rows.length,
                })}
              </span>
              <div className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  disabled={!offset}
                  onClick={onPrevious}
                >
                  {t("toolbox.postgres.previous")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  disabled={result.rows.length < pageSize}
                  onClick={onNext}
                >
                  {t("toolbox.postgres.next")}
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="p-3 text-[12px] text-muted-foreground">
          {t("toolbox.postgres.ready")}
        </div>
      )}
    </section>
  );
}
function ConnectionDialog({
  open,
  onOpenChange,
  page,
  setPage,
  draft,
  update,
  save,
  connect,
  connecting,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: DialogPage;
  setPage: (page: DialogPage) => void;
  draft: PostgresConnection;
  update: <K extends keyof PostgresConnection>(
    key: K,
    value: PostgresConnection[K],
  ) => void;
  save: () => Promise<void>;
  connect: () => Promise<void>;
  connecting: boolean;
  t: TFunction;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!inset-0 !m-auto !h-[560px] !w-[720px] !max-w-[calc(100vw-32px)] !translate-x-0 !translate-y-0 overflow-hidden rounded-md p-0"
        data-testid="postgres-connection-dialog"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {t("toolbox.postgres.connectionSettings")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="w-36 shrink-0 border-r bg-muted/20 p-1.5">
            {(["general", "ssh", "tls"] as DialogPage[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`block h-7 w-full rounded-sm px-2 text-left text-[12px] ${page === item ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
                onClick={() => setPage(item)}
              >
                {t(`toolbox.postgres.connectionTabs.${item}`)}
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1 overflow-auto p-4">
            <div className="grid grid-cols-2 gap-3">
              {page === "general" && (
                <>
                  <Field label={t("toolbox.postgres.name")}>
                    <Input
                      value={draft.name}
                      onChange={(e) => update("name", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.host")}>
                    <Input
                      value={draft.host}
                      onChange={(e) => update("host", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.port")}>
                    <Input
                      type="number"
                      value={draft.port}
                      onChange={(e) => update("port", Number(e.target.value))}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.database")}>
                    <Input
                      value={draft.database}
                      onChange={(e) => update("database", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.username")}>
                    <Input
                      value={draft.username}
                      onChange={(e) => update("username", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.password")}>
                    <Input
                      type="password"
                      value={draft.password ?? ""}
                      onChange={(e) => update("password", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.environment")}>
                    <Select
                      value={draft.environment}
                      onValueChange={(v) =>
                        update("environment", v as PostgresEnvironment)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["development", "test", "production"] as const).map(
                          (v) => (
                            <SelectItem key={v} value={v}>
                              {t(`toolbox.postgres.environments.${v}`)}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex items-center gap-2 pt-6">
                    <Switch
                      checked={draft.readOnly}
                      onCheckedChange={(v) => update("readOnly", v)}
                    />
                    <Label>{t("toolbox.postgres.readOnlyConnection")}</Label>
                  </div>
                </>
              )}
              {page === "ssh" && (
                <>
                  <div className="col-span-2 flex items-center gap-2">
                    <Switch
                      checked={draft.sshEnabled}
                      onCheckedChange={(v) => update("sshEnabled", v)}
                    />
                    <Label>{t("toolbox.postgres.sshTunnel")}</Label>
                  </div>
                  <Field label={t("toolbox.postgres.sshHost")}>
                    <Input
                      value={draft.sshHost ?? ""}
                      onChange={(e) => update("sshHost", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.sshPort")}>
                    <Input
                      type="number"
                      value={draft.sshPort ?? 22}
                      onChange={(e) =>
                        update("sshPort", Number(e.target.value))
                      }
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.sshUsername")}>
                    <Input
                      value={draft.sshUsername ?? ""}
                      onChange={(e) => update("sshUsername", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.sshPassword")}>
                    <Input
                      type="password"
                      value={draft.sshPassword ?? ""}
                      onChange={(e) => update("sshPassword", e.target.value)}
                    />
                  </Field>
                  <div className="col-span-2">
                    <Field label={t("toolbox.postgres.sshFingerprint")}>
                      <Input
                        value={draft.sshHostKeyFingerprint ?? ""}
                        onChange={(e) =>
                          update("sshHostKeyFingerprint", e.target.value)
                        }
                      />
                    </Field>
                  </div>
                </>
              )}
              {page === "tls" && (
                <>
                  <div className="col-span-2 flex items-center gap-2">
                    <Switch
                      checked={draft.sslMode !== "disable"}
                      onCheckedChange={(enabled) =>
                        update("sslMode", enabled ? "prefer" : "disable")
                      }
                    />
                    <Label>{t("toolbox.postgres.tlsEnabled")}</Label>
                  </div>
                  <div className="col-span-2">
                    <Field label={t("toolbox.postgres.sslMode")}>
                      <Select
                        value={draft.sslMode}
                        onValueChange={(v) =>
                          update("sslMode", v as PostgresSslMode)
                        }
                      >
                        <SelectTrigger disabled={draft.sslMode === "disable"}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(
                            [
                              "disable",
                              "allow",
                              "prefer",
                              "require",
                              "verify-ca",
                              "verify-full",
                            ] as const
                          ).map((v) => (
                            <SelectItem key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  {draft.sslMode !== "disable" && (
                    <>
                      <TextField
                        label={t("toolbox.postgres.sslRootCert")}
                        value={draft.sslRootCert ?? ""}
                        onChange={(v) => update("sslRootCert", v)}
                      />
                      <TextField
                        label={t("toolbox.postgres.sslClientCert")}
                        value={draft.sslClientCert ?? ""}
                        onChange={(v) => update("sslClientCert", v)}
                      />
                      <TextField
                        label={t("toolbox.postgres.sslClientKey")}
                        value={draft.sslClientKey ?? ""}
                        onChange={(v) => update("sslClientKey", v)}
                      />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            className="rounded-sm"
            onClick={() => void save()}
          >
            {t("common.save")}
          </Button>
          <Button
            size="sm"
            className="rounded-sm"
            onClick={() => void connect()}
            disabled={connecting}
          >
            {connecting && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            {t("toolbox.postgres.connect")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="col-span-2 space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <textarea
        className="h-16 w-full resize-none rounded-sm border bg-background p-2 font-mono text-[11px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
