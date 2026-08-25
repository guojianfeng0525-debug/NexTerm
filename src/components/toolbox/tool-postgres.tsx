import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
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
  PostgreSQLConnectionConfig,
  PostgreSQLConnectionProfile,
  PostgreSQLSslMode,
} from "@/lib/database/postgresql-profile-adapter";
import { createPostgresQueryEditorContext } from "@/lib/database/postgresql-query-editor";
import type { PostgresCatalogLookup } from "@/lib/postgres-completion";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
import { postgresqlProvider } from "@/lib/database/provider-registry";
import { DatabaseNavigator } from "@/components/toolbox/database-navigator";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import { DatabaseWorkspaceShell } from "@/components/toolbox/database-workspace-shell";
import { DatabaseProviderSelect } from "@/components/toolbox/database-provider-select";
import {
  DatabaseConnectionDialogShell,
  DatabaseConnectionField,
  DatabaseConnectionFormGrid,
  DatabaseConnectionToggleRow,
} from "@/components/toolbox/database-connection-dialog-shell";
import {
  createPostgresNavigatorConnectionNode,
  getPostgresRelationReference,
  loadPostgresNavigatorChildren,
  type PostgresRelationReference,
} from "@/lib/database/postgresql-object-loader";
import {
  adaptPostgresQueryResult,
  adaptPostgresTableResult,
  type PostgresQueryRuntimeResult,
  type PostgresTableRuntimeResult,
} from "@/lib/database/postgresql-result-adapter";
import type { DatabaseResult, DatabaseTabularResult } from "@/lib/database/result-types";
import type {
  DatabaseObjectNode,
  DatabaseObjectNodeId,
} from "@/lib/database/types";

type TableObject = { schema: string; name: string };
type WorkspaceTab = {
  id: string;
  type: "query" | "table";
  title: string;
  object?: TableObject;
  sql: string;
  result: DatabaseResult | null;
  baseline?: DatabaseTabularResult;
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

function newConnection(): PostgreSQLConnectionProfile {
  const now = Date.now();
  return {
    id: generateId("postgres"),
    name: "PostgreSQL",
    providerId: "postgresql",
    environment: "development",
    createdAt: now,
    updatedAt: now,
    providerConfig: {
      host: "127.0.0.1",
      port: 5432,
      database: "postgres",
      username: "",
      readOnly: false,
      autoCommit: true,
      sslMode: "prefer",
      sshEnabled: false,
    },
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

function toPostgresNavigatorConnection(profile: PostgreSQLConnectionProfile) {
  return {
    id: profile.id,
    name: profile.name,
    database: profile.providerConfig.database,
  };
}

export function ToolPostgres() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState(() =>
    PostgresConnectionsStorage.load(),
  );
  const [draft, setDraft] = useState<PostgreSQLConnectionProfile>(
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
  const [transactionActive, setTransactionActive] = useState(false);

  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const tableOffset =
    tab?.result?.kind === "tabular" ? tab.result.pagination?.offset ?? 0 : 0;
  const postgresConfig = draft.providerConfig;
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
    createPostgresNavigatorConnectionNode(toPostgresNavigatorConnection(connection)),
  );
  const navigatorNodes = [
    ...navigatorRoots,
    ...Object.values(navigatorChildren).flatMap((children) => children ?? []),
  ];
  const update = <K extends keyof PostgreSQLConnectionConfig>(
    key: K,
    value: PostgreSQLConnectionConfig[K],
  ) => setDraft((current) => ({
    ...current,
    providerConfig: { ...current.providerConfig, [key]: value },
  }));
  const updateProfile = <K extends "name" | "environment">(
    key: K,
    value: PostgreSQLConnectionProfile[K],
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
      const connection = createPostgresNavigatorConnectionNode(
        toPostgresNavigatorConnection(draft),
      );
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
      !postgresConfig.host.trim() ||
      !postgresConfig.database.trim() ||
      !postgresConfig.username.trim()
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
            host: postgresConfig.host,
            port: postgresConfig.port,
            database: postgresConfig.database,
            username: postgresConfig.username,
            password: postgresConfig.password,
            readOnly: postgresConfig.readOnly,
            sslMode: postgresConfig.sslMode,
            sslRootCert: postgresConfig.sslRootCert,
            sslClientCert: postgresConfig.sslClientCert,
            sslClientKey: postgresConfig.sslClientKey,
            ssh: postgresConfig.sshEnabled
              ? {
                  host: postgresConfig.sshHost,
                  port: postgresConfig.sshPort ?? 22,
                  username: postgresConfig.sshUsername,
                  authMethod: postgresConfig.sshAuthMethod ?? "password",
                  password: postgresConfig.sshPassword,
                  privateKey: postgresConfig.sshPrivateKey,
                  privateKeyPath: postgresConfig.sshPrivateKeyPath,
                  privateKeyPassphrase: postgresConfig.sshPrivateKeyPassphrase,
                  hostKeyFingerprint: postgresConfig.sshHostKeyFingerprint,
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
        result: adaptPostgresQueryResult(
          await invoke<PostgresQueryRuntimeResult>(
            explain ? "postgres_explain" : "postgres_execute",
            { request: { connectionId: draft.id, sql: tab.sql } },
          ),
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
    setRunning(true);
    try {
      const result = adaptPostgresTableResult(
          await invoke<PostgresTableRuntimeResult>("postgres_table_data", {
            request: {
              connectionId: reference.connectionId,
              schema: object.schema,
              table: object.name,
              limit: pageSize,
              offset,
            },
          }),
          { offset, limit: pageSize },
        );
      patchTab(id, { result, baseline: result, dirty: false });
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
  const disconnect = async () => {
    await invoke("postgres_disconnect", { connectionId: draft.id });
    setConnected(false);
    setTransactionActive(false);
  };
  const createQuery = () => openTab(newQuery());
  const copyText = async (value: string) => {
    try {
      await writeClipboardText(value);
    } catch (error) {
      toast.error(t("toolbox.postgres.copyFailed"), { description: String(error) });
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
        defaultPath: `${tab.title || "postgres-result"}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, csv);
      toast.success(t("toolbox.postgres.exported"));
    } catch (error) {
      toast.error(t("toolbox.postgres.exportFailed"), { description: String(error) });
    }
  };
  const transaction = async (action: "begin" | "commit" | "rollback") => {
    try {
      await invoke("postgres_transaction", { request: { connectionId: draft.id, action } });
      setTransactionActive(action === "begin");
    } catch (error) {
      toast.error(t("toolbox.postgres.transaction.failed"), { description: String(error) });
    }
  };
  const stageTableEdit = (rowIndex: number, columnIndex: number, value: string | null) => {
    if (!tab || tab.type !== "table" || tab.result?.kind !== "tabular") return;
    const rows = tab.result.rows.map((row, index) =>
      index === rowIndex ? row.map((cell, cellIndex) => cellIndex === columnIndex ? value : cell) : row,
    );
    patchTab(tab.id, { result: { ...tab.result, rows }, dirty: true });
  };
  const isTableCellModified = (rowIndex: number, columnIndex: number) =>
    tab?.type === "table" &&
    tab.result?.kind === "tabular" &&
    tab.baseline?.rows[rowIndex]?.[columnIndex] !== tab.result.rows[rowIndex]?.[columnIndex];
  const saveTableChanges = async () => {
    if (!tab?.object || tab.result?.kind !== "tabular" || !tab.baseline || !tab.dirty) return;
    try {
      const columns = tab.result.columns;
      const keyNames = new Set(tab.result.editability.primaryKeyColumnKeys);
      for (let rowIndex = 0; rowIndex < tab.result.rows.length; rowIndex += 1) {
        const row = tab.result.rows[rowIndex];
        const original = tab.baseline.rows[rowIndex];
        if (!original || row.every((value, index) => value === original[index])) continue;
        const changes = Object.fromEntries(columns.flatMap((column, index) =>
          !keyNames.has(column.key) && row[index] !== original[index]
            ? [[column.label, row[index]]]
            : [],
        ));
        if (!Object.keys(changes).length) continue;
        const keyValues = Object.fromEntries(columns.flatMap((column, index) =>
          keyNames.has(column.key) && original[index] !== null
            ? [[column.label, original[index]]]
            : [],
        ));
        await invoke("postgres_table_update", {
          request: { connectionId: draft.id, schema: tab.object.schema, table: tab.object.name, keyValues, changes },
        });
      }
      patchTab(tab.id, { baseline: tab.result, dirty: false });
      toast.success(t("toolbox.postgres.changesSaved"));
    } catch (error) {
      toast.error(t("toolbox.postgres.saveChangesFailed"), { description: String(error) });
    }
  };
  const revertTableChanges = () => {
    if (tab?.baseline) patchTab(tab.id, { result: tab.baseline, dirty: false });
  };
  const onDatabaseKeyDown = useEffectEvent((event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === "n" && connected) {
        event.preventDefault();
        createQuery();
      }
      if (event.key === "Enter" && tab?.type === "query" && !running) {
        event.preventDefault();
        void execute();
      }
      if (event.key.toLowerCase() === "e" && event.shiftKey && tab?.type === "query" && !running) {
        event.preventDefault();
        void execute(true);
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        closeTab(activeTab);
      }
      if (event.key.toLowerCase() === "r" && connected) {
        event.preventDefault();
        if (tab?.type === "table" && tab.object) {
          void browse({ connectionId: draft.id, database: postgresConfig.database, schema: tab.object.schema, relation: tab.object.name }, tableOffset);
        } else {
          void refreshNavigator();
        }
      }
    });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onDatabaseKeyDown(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <DatabaseWorkspaceShell
      testId="postgres-workspace"
      toolbarTestId="postgres-toolbar"
      toolbar={<>
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
             createQuery();
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
            ? `${postgresConfig.database} / ${schema ?? ""}`
            : t("toolbox.postgres.disconnected")}
        </span>
        {connected ? (
          <ToolButton
            icon={<Unplug />}
            label={t("toolbox.postgres.disconnect")}
            disabled={disconnectCommand.state !== "enabled"}
            onClick={() =>
              void disconnect()
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
      </>}
      navigator={<aside
          className="relative flex min-h-0 shrink-0 flex-col border-r bg-muted/10"
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
            <div className="min-h-0 flex-1 overflow-auto py-1">
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
                    const switchingConnection = connection.id !== draft.id;
                    setDraft(connection);
                    setSelectedId(connection.id);
                    if (switchingConnection) setConnected(false);
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
              renderContextMenu={(node) => {
                const relation = getPostgresRelationReference(node);
                const nodeContext = {
                  scope: "NAVIGATOR" as const,
                  provider: postgresqlProvider,
                  connectionState: connected ? "connected" as const : "disconnected" as const,
                };
                const enabled = (id: Parameters<typeof resolveDatabaseCommand>[0]) =>
                  resolveDatabaseCommand(id, nodeContext).state === "enabled";
                if (node.kind === "connection") {
                  const connectionId = node.reference.path[0];
                  return <>
                    {connected ? <ContextMenuItem disabled={!enabled("database.connection.disconnect")} onSelect={() => void disconnect()}>{t("toolbox.postgres.disconnect")}</ContextMenuItem> : <ContextMenuItem onSelect={() => setConfigOpen(true)}>{t("toolbox.postgres.connect")}</ContextMenuItem>}
                    <ContextMenuItem disabled={!connected} onSelect={createQuery}>{t("toolbox.postgres.newQuery")}</ContextMenuItem>
                    <ContextMenuItem disabled={!connected} onSelect={() => void refreshNavigator()}>{t("toolbox.postgres.refresh")}</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => {
                      const connection = connections.find((item) => item.id === connectionId);
                      if (connection) setDraft(connection);
                      setConfigOpen(true);
                    }}>{t("common.edit")}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => {
                      if (window.confirm(t("toolbox.postgres.deleteConfirm", { name: node.label }))) {
                        void PostgresConnectionsStorage.remove(connectionId);
                        setConnections((current) => current.filter((connection) => connection.id !== connectionId));
                        if (connectionId === draft.id) setConnected(false);
                      }
                    }}>{t("common.delete")}</ContextMenuItem>
                  </>;
                }
                return <>
                  {relation && <ContextMenuItem disabled={!enabled("database.object.open")} onSelect={() => void browse(relation)}>{t("toolbox.postgres.openDataAction")}</ContextMenuItem>}
                  <ContextMenuItem disabled={!connected} onSelect={() => void refreshNavigator()}>{t("toolbox.postgres.refresh")}</ContextMenuItem>
                  <ContextMenuItem disabled={!connected} onSelect={() => void copyText(node.label)}>{t("toolbox.postgres.copyName")}</ContextMenuItem>
                  {!relation && <ContextMenuItem disabled={!connected} onSelect={createQuery}>{t("toolbox.postgres.newQuery")}</ContextMenuItem>}
                </>;
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
        </aside>}
       tabs={tabs}
      activeTabId={activeTab}
      onActivateTab={setActiveTab}
       onCloseTab={closeTab}
       renderTabContextMenu={(item) => <>
         <ContextMenuItem onSelect={() => closeTab(item.id)}>{t("common.close")}</ContextMenuItem>
         <ContextMenuItem disabled={tabs.length < 2} onSelect={() => {
            setTabs((current) => current.filter((tab) => tab.id === item.id));
           setActiveTab(item.id);
         }}>{t("toolbox.postgres.closeOtherTabs")}</ContextMenuItem>
       </>}
      tabClassName={(_, active) => `group flex h-8 min-w-28 items-center gap-1 border-r px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${active ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
      workspace={tab && (
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
                 {tab.type === "query" && (
                   <>
                     <ToolButton icon={<Play />} label={t("toolbox.postgres.transaction.begin")} disabled={!connected || transactionActive} onClick={() => void transaction("begin")} />
                     <ToolButton icon={<Play />} label={t("toolbox.postgres.transaction.commit")} disabled={!transactionActive} onClick={() => void transaction("commit")} />
                     <ToolButton icon={<Play />} label={t("toolbox.postgres.transaction.rollback")} disabled={!transactionActive} onClick={() => void transaction("rollback")} />
                   </>
                 )}
                 {tab.type === "table" && (
                   <>
                     <span className="ml-1 text-[11px] text-muted-foreground">{tab.object?.schema}.{tab.object?.name}</span>
                     <ToolButton icon={<RefreshCw />} label={t("toolbox.postgres.refresh")} disabled={running} onClick={() => tab.object && void browse({ connectionId: draft.id, database: postgresConfig.database, schema: tab.object.schema, relation: tab.object.name }, tableOffset)} />
                     <ToolButton icon={<Database />} label={t("toolbox.postgres.saveChanges")} disabled={!tab.dirty || running || postgresConfig.readOnly} onClick={() => void saveTableChanges()} />
                     <ToolButton icon={<RefreshCw />} label={t("toolbox.postgres.revertChanges")} disabled={!tab.dirty || running} onClick={revertTableChanges} />
                   </>
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
                            catalog: postgresConfig.database,
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
              <DatabaseResultPane
                result={tab.result}
                height={resultHeight}
                paged={tab.type === "table"}
                onPrevious={() =>
                  tab.object &&
                  void browse(
                    {
                      connectionId: draft.id,
                      database: postgresConfig.database,
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
                      database: postgresConfig.database,
                      schema: tab.object.schema,
                      relation: tab.object.name,
                    },
                    tableOffset + pageSize,
                  )
                }
                 labels={{
                  result: t("toolbox.postgres.result"),
                  message: t("toolbox.postgres.message"),
                  ready: t("toolbox.postgres.ready"),
                  null: t("toolbox.postgres.null"),
                  previous: t("toolbox.postgres.previous"),
                  next: t("toolbox.postgres.next"),
                   rowsRange: (from, to) =>
                    t("toolbox.postgres.rowsRange", { from, to }),
                 }}
                  renderContextMenu={(cell, row, columnName, rowIndex, columnIndex) => <>
                    <ContextMenuItem onSelect={() => void copyText(cell ?? "NULL")}>{t("toolbox.postgres.copyCell")}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copyText(row.map((value) => value ?? "NULL").join("\t"))}>{t("toolbox.postgres.copyRow")}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copyText(columnName)}>{t("toolbox.postgres.copyColumnName")}</ContextMenuItem>
                    <ContextMenuSeparator />
                    {tab.type === "table" && <ContextMenuItem
                      disabled={postgresConfig.readOnly || tab.result?.kind !== "tabular" || !tab.result.editability.editable || !tab.result.editability.nullableColumnKeys?.includes(tab.result.columns[columnIndex]?.key ?? "")}
                      onSelect={() => stageTableEdit(rowIndex, columnIndex, null)}
                    >{t("toolbox.postgres.setNull")}</ContextMenuItem>}
                    <ContextMenuItem onSelect={() => void exportCsv()}>{t("toolbox.postgres.exportCsv")}</ContextMenuItem>
                  </>}
                  onEditCell={tab.type === "table" && !postgresConfig.readOnly ? stageTableEdit : undefined}
                  isCellModified={isTableCellModified}
              />
            </section>
          )}
      status={<footer className="flex h-6 shrink-0 items-center border-t bg-muted/25 px-2 text-[11px] text-muted-foreground">
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
      </footer>}
    >
      <ConnectionDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        page={dialogPage}
        setPage={setDialogPage}
        draft={draft}
        update={update}
        updateProfile={updateProfile}
        save={save}
        connect={connect}
        connecting={connecting}
        t={t}
      />
    </DatabaseWorkspaceShell>
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
function ConnectionDialog({
  open,
  onOpenChange,
  page,
  setPage,
  draft,
  update,
  updateProfile,
  save,
  connect,
  connecting,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: DialogPage;
  setPage: (page: DialogPage) => void;
  draft: PostgreSQLConnectionProfile;
  update: <K extends keyof PostgreSQLConnectionConfig>(
    key: K,
    value: PostgreSQLConnectionConfig[K],
  ) => void;
  updateProfile: <K extends "name" | "environment">(
    key: K,
    value: PostgreSQLConnectionProfile[K],
  ) => void;
  save: () => Promise<void>;
  connect: () => Promise<void>;
  connecting: boolean;
  t: TFunction;
}) {
  const config = draft.providerConfig;
  return (
    <DatabaseConnectionDialogShell
      open={open}
      onOpenChange={onOpenChange}
      testId="postgres-connection-dialog"
      title={t("toolbox.postgres.connectionSettings")}
      sections={(["general", "ssh", "tls"] as DialogPage[]).map((id) => ({ id, label: t(`toolbox.postgres.connectionTabs.${id}`) }))}
      activeSection={page}
      onActiveSectionChange={(section) => setPage(section as DialogPage)}
      saveLabel={t("common.save")}
      primaryLabel={t("toolbox.postgres.connect")}
      onSave={() => void save()}
      onPrimary={() => void connect()}
      busy={connecting}
    >
      <DatabaseConnectionFormGrid>
              {page === "general" && (
                <>
                  <Field label={t("toolbox.postgres.provider")}>
                    <DatabaseProviderSelect
                      value="postgresql"
                      onValueChange={(providerId) => {
                        if (providerId !== "postgresql") {
                          onOpenChange(false);
                          window.dispatchEvent(new CustomEvent("nexterm:database-provider-selected", { detail: providerId }));
                        }
                      }}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.name")}>
                    <Input
                      value={draft.name}
                      onChange={(e) => updateProfile("name", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.host")}>
                    <Input
                      value={config.host}
                      onChange={(e) => update("host", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.port")}>
                    <Input
                      type="number"
                      value={config.port}
                      onChange={(e) => update("port", Number(e.target.value))}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.database")}>
                    <Input
                      value={config.database}
                      onChange={(e) => update("database", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.username")}>
                    <Input
                      value={config.username}
                      onChange={(e) => update("username", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.password")}>
                    <Input
                      type="password"
                      value={config.password ?? ""}
                      onChange={(e) => update("password", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.environment")}>
                    <Select
                      value={draft.environment}
                      onValueChange={(v) =>
                        updateProfile("environment", v as PostgreSQLConnectionProfile["environment"])
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
                  <DatabaseConnectionToggleRow>
                    <Switch
                      checked={config.readOnly}
                      onCheckedChange={(v) => update("readOnly", v)}
                    />
                    <Label>{t("toolbox.postgres.readOnlyConnection")}</Label>
                  </DatabaseConnectionToggleRow>
                </>
              )}
              {page === "ssh" && (
                <>
                  <div className="col-span-2 flex items-center gap-2">
                    <Switch
                      checked={config.sshEnabled}
                      onCheckedChange={(v) => update("sshEnabled", v)}
                    />
                    <Label>{t("toolbox.postgres.sshTunnel")}</Label>
                  </div>
                  <Field label={t("toolbox.postgres.sshHost")}>
                    <Input
                      value={config.sshHost ?? ""}
                      onChange={(e) => update("sshHost", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.sshPort")}>
                    <Input
                      type="number"
                      value={config.sshPort ?? 22}
                      onChange={(e) =>
                        update("sshPort", Number(e.target.value))
                      }
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.sshUsername")}>
                    <Input
                      value={config.sshUsername ?? ""}
                      onChange={(e) => update("sshUsername", e.target.value)}
                    />
                  </Field>
                  <Field label={t("toolbox.postgres.sshPassword")}>
                    <Input
                      type="password"
                      value={config.sshPassword ?? ""}
                      onChange={(e) => update("sshPassword", e.target.value)}
                    />
                  </Field>
                  <div className="col-span-2">
                    <Field label={t("toolbox.postgres.sshFingerprint")}>
                      <Input
                        value={config.sshHostKeyFingerprint ?? ""}
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
                      checked={config.sslMode !== "disable"}
                      onCheckedChange={(enabled) =>
                        update("sslMode", enabled ? "prefer" : "disable")
                      }
                    />
                    <Label>{t("toolbox.postgres.tlsEnabled")}</Label>
                  </div>
                  <div className="col-span-2">
                    <Field label={t("toolbox.postgres.sslMode")}>
                      <Select
                        value={config.sslMode}
                        onValueChange={(v) =>
                          update("sslMode", v as PostgreSQLSslMode)
                        }
                      >
                        <SelectTrigger disabled={config.sslMode === "disable"}>
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
                  {config.sslMode !== "disable" && (
                    <>
                      <TextField
                        label={t("toolbox.postgres.sslRootCert")}
                        value={config.sslRootCert ?? ""}
                        onChange={(v) => update("sslRootCert", v)}
                      />
                      <TextField
                        label={t("toolbox.postgres.sslClientCert")}
                        value={config.sslClientCert ?? ""}
                        onChange={(v) => update("sslClientCert", v)}
                      />
                      <TextField
                        label={t("toolbox.postgres.sslClientKey")}
                        value={config.sslClientKey ?? ""}
                        onChange={(v) => update("sslClientKey", v)}
                      />
                    </>
                  )}
                </>
              )}
      </DatabaseConnectionFormGrid>
    </DatabaseConnectionDialogShell>
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
    <DatabaseConnectionField label={label}>{children}</DatabaseConnectionField>
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
         className="h-16 w-full resize-none rounded-sm border bg-input-background p-2 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
