import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Database,
  FileCode2,
  Filter,
  FolderTree,
  KeyRound,
  ListPlus,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Table2,
  Undo2,
  Unplug,
  X,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CodeEditor } from "@/components/code-editor";
import { generateId } from "@/lib/toolbox/toolbox-storage";
import { ConnectionStorageManager } from "@/lib/connection-storage";
import { PostgresConnectionsStorage } from "@/lib/toolbox/postgres-storage";
import type {
  PostgreSQLConnectionConfig,
  PostgreSQLConnectionProfile,
  PostgreSQLSslMode,
} from "@/lib/database/postgresql-profile-adapter";
import { createPostgresQueryEditorContext } from "@/lib/database/postgresql-query-editor";
import type { PostgresCatalogLookup } from "@/lib/postgres-completion";
import { resolveDatabaseCommand } from "@/lib/database/command-registry";
import {
  buildFieldValueFilter,
  isEmptyFilter,
  resolveFilterShortcut,
} from "@/lib/database/table-filter";
import {
  DEFAULT_GRID_LAYOUT,
  gridLayoutKey,
  loadGridLayout,
  saveGridLayout,
} from "@/lib/database/grid-layout-storage";
import {
  findCellMatches,
  nextFindIndex,
  previousFindIndex,
} from "@/lib/database/find-matches";
import { postgresqlProvider } from "@/lib/database/provider-registry";
import {
  DatabaseNavigator,
  type DatabaseNavigatorLoadState,
} from "@/components/toolbox/database-navigator";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import {
  FilterSortDialog,
  type FilterSortDialogLabels,
} from "@/components/toolbox/filter-sort-dialog";
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
  type PostgresNavigatorGroupLabels,
  type PostgresRelationReference,
} from "@/lib/database/postgresql-object-loader";
import {
  adaptPostgresQueryResult,
  adaptPostgresTableResult,
  type PostgresQueryRuntimeResult,
  type PostgresTableRuntimeResult,
} from "@/lib/database/postgresql-result-adapter";
import type {
  DatabaseResult,
  DatabaseResultRow,
  DatabaseTabularResult,
  GridLayoutState,
  TableFilterState,
} from "@/lib/database/result-types";
import type {
  DatabaseObjectNode,
  DatabaseObjectNodeId,
} from "@/lib/database/types";

type TableObject = { schema: string; name: string };
/** A row staged for INSERT. Only `edited` column indexes are submitted; the
 * remaining columns keep their server-side DEFAULT. */
type PendingInsertRow = {
  id: string;
  values: readonly (string | null)[];
  edited: readonly number[];
};
type WorkspaceTab = {
  id: string;
  type: "query" | "table";
  title: string;
  object?: TableObject;
  sql: string;
  result: DatabaseResult | null;
  baseline?: DatabaseTabularResult;
  dirty?: boolean;
  pendingInserts?: readonly PendingInsertRow[];
  pendingDeleteRows?: readonly number[];
  /**
   * Filter/order currently applied to the loaded page (B18). The dialog
   * applies immediately, so there is no separate draft state.
   */
  activeFilter?: TableFilterState;
};
type DialogPage = "general" | "ssh" | "tls";
type PendingPostgresSshTrust = {
  profile: PostgreSQLConnectionProfile;
  fingerprint: string;
};

const pageSize = 100;

type NavigatorChildren = Partial<
  Record<DatabaseObjectNodeId, readonly DatabaseObjectNode[]>
>;
type NavigatorLoadStates = Partial<
  Record<DatabaseObjectNodeId, DatabaseNavigatorLoadState>
>;

async function loadNavigatorChildren(
  node: DatabaseObjectNode,
  labels: PostgresNavigatorGroupLabels,
  setNavigatorChildren: Dispatch<SetStateAction<NavigatorChildren>>,
  setNavigatorLoadStates: Dispatch<SetStateAction<NavigatorLoadStates>>,
) {
  setNavigatorLoadStates((current) => ({ ...current, [node.id]: { state: "loading" } }));
  try {
    const children = await loadPostgresNavigatorChildren(node, labels);
    setNavigatorChildren((current) => ({ ...current, [node.id]: children }));
    setNavigatorLoadStates((current) => {
      const { [node.id]: _loaded, ...next } = current;
      return next;
    });
    return children;
  } catch {
    setNavigatorLoadStates((current) => ({ ...current, [node.id]: { state: "error" } }));
    return [];
  }
}

function quoteQualifiedPostgresName(reference: PostgresRelationReference): string {
  const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
  return `${quote(reference.schema)}.${quote(reference.relation)}`;
}

function postgresNavigatorLabels(t: TFunction): PostgresNavigatorGroupLabels {
  return {
    tables: t("toolbox.postgres.tables"),
    views: t("toolbox.postgres.views"),
    materializedViews: t("toolbox.postgres.materializedViews"),
  };
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
  const [navigatorLoadStates, setNavigatorLoadStates] =
    useState<NavigatorLoadStates>({});
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
  const [pendingSshTrust, setPendingSshTrust] = useState<PendingPostgresSshTrust | null>(null);
  const [saving, setSaving] = useState(false);
  /** Row index (into committed result rows) awaiting delete confirmation. */
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  /** Tab id awaiting dirty-discard confirmation before closing. */
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  /** Filter & Sort / Custom Filter dialog mode for the active table tab. */
  const [filterDialog, setFilterDialog] = useState<
    { mode: "custom" | "filterSort" } | null
  >(null);
  /** Per-table grid layout (frozen columns, widths, row height, toggles). */
  const [layoutByTable, setLayoutByTable] = useState<
    Record<string, GridLayoutState>
  >({});
  /** Set Column Width / Set Row Height value dialog. */
  const [layoutDialog, setLayoutDialog] = useState<
    { kind: "columnWidth"; columnIndex: number } | { kind: "rowHeight" } | null
  >(null);
  /** Find bar state for the table grid (Slice B). */
  const [findState, setFindState] = useState<{
    open: boolean;
    text: string;
    current: number;
  }>({ open: false, text: "", current: 0 });

  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const patchTab = (id: string, patch: Partial<WorkspaceTab>) =>
    setTabs((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  useEffect(() => {
    const pasteSqlNote = (event: Event) => {
      const detail = (event as CustomEvent<{ content?: string; handled?: boolean }>).detail;
      if (!detail?.content || !tab) return;
      patchTab(tab.id, { sql: detail.content, dirty: true });
      detail.handled = true;
    };
    window.addEventListener('nexterm:paste-sql-note', pasteSqlNote);
    return () => window.removeEventListener('nexterm:paste-sql-note', pasteSqlNote);
  }, [tab]);
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
  const tableEditingEnabled =
    tab?.type === "table" &&
    !postgresConfig.readOnly &&
    tab.result?.kind === "tabular" &&
    tab.result.editability.editable;
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
  ) => setDraft((current) => {
    const endpointChanged = (key === "sshHost" || key === "sshPort")
      && current.providerConfig[key] !== value;
    return {
      ...current,
      providerConfig: {
        ...current.providerConfig,
        [key]: value,
        ...(endpointChanged ? { sshHostKeyFingerprint: undefined } : {}),
      },
    };
  });
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
        postgresNavigatorLabels(t),
        setNavigatorChildren,
        setNavigatorLoadStates,
      );
      const firstCatalog = catalog[0];
      if (!firstCatalog) return;
      const schemas = await loadNavigatorChildren(
        firstCatalog,
        postgresNavigatorLabels(t),
        setNavigatorChildren,
        setNavigatorLoadStates,
      );
      const firstSchema = schemas[0];
      if (!firstSchema) return;
      const groups = await loadNavigatorChildren(
        firstSchema,
        postgresNavigatorLabels(t),
        setNavigatorChildren,
        setNavigatorLoadStates,
      );
      const firstGroup = groups[0];
      if (firstGroup)
        await loadNavigatorChildren(
          firstGroup,
          postgresNavigatorLabels(t),
          setNavigatorChildren,
          setNavigatorLoadStates,
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
  const probeSshFingerprint = async () => {
    if (!postgresConfig.sshEnabled || !postgresConfig.sshHost?.trim()) {
      toast.error(t("toolbox.postgres.sshHostRequired"));
      return;
    }
    setConnecting(true);
    try {
      const probe = await invoke<{ fingerprint: string }>("postgres_ssh_fingerprint", {
        request: { host: postgresConfig.sshHost, port: postgresConfig.sshPort ?? 22 },
      });
      setPendingSshTrust({ profile: draft, fingerprint: probe.fingerprint });
    } catch (error) {
      toast.error(t("toolbox.postgres.fingerprintFailed"), { description: String(error) });
    } finally {
      setConnecting(false);
    }
  };
  const connectEstablished = async (profile: PostgreSQLConnectionProfile) => {
    setConnecting(true);
    try {
      const saved = { ...profile, updatedAt: Date.now() };
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
            connectionId: saved.id,
            host: saved.providerConfig.host,
            port: saved.providerConfig.port,
            database: saved.providerConfig.database,
            username: saved.providerConfig.username,
            password: saved.providerConfig.password,
            readOnly: saved.providerConfig.readOnly,
            sslMode: saved.providerConfig.sslMode,
            sslRootCert: saved.providerConfig.sslRootCert,
            sslClientCert: saved.providerConfig.sslClientCert,
            sslClientKey: saved.providerConfig.sslClientKey,
            ssh: saved.providerConfig.sshEnabled
              ? {
                  host: saved.providerConfig.sshHost,
                  port: saved.providerConfig.sshPort ?? 22,
                  username: saved.providerConfig.sshUsername,
                  authMethod: saved.providerConfig.sshAuthMethod ?? "password",
                  password: saved.providerConfig.sshPassword,
                  privateKey: saved.providerConfig.sshPrivateKey,
                  privateKeyPath: saved.providerConfig.sshPrivateKeyPath,
                  privateKeyPassphrase: saved.providerConfig.sshPrivateKeyPassphrase,
                  hostKeyFingerprint: saved.providerConfig.sshHostKeyFingerprint,
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
      const message = String(error);
      const isHostKeyMismatch = message.includes("host key fingerprint changed");
      toast.error(
        isHostKeyMismatch
          ? t("toolbox.postgres.hostKeyMismatch")
          : t("toolbox.postgres.connectFailed"),
        {
          description: message,
          ...(isHostKeyMismatch
            ? {
                action: {
                  label: t("toolbox.postgres.retrustHostKey"),
                  onClick: () => void probeSshFingerprint(),
                },
              }
            : {}),
        },
      );
    } finally {
      setConnecting(false);
    }
  };
  const connect = async () => {
    if (!postgresConfig.sshEnabled || postgresConfig.sshHostKeyFingerprint) {
      await connectEstablished(draft);
      return;
    }
    await probeSshFingerprint();
  };
  const trustAndConnect = async () => {
    if (!pendingSshTrust) return;
    const trusted = {
      ...pendingSshTrust.profile,
      providerConfig: {
        ...pendingSshTrust.profile.providerConfig,
        sshHostKeyFingerprint: pendingSshTrust.fingerprint,
      },
    };
    setPendingSshTrust(null);
    await connectEstablished(trusted);
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
    /** undefined → keep the tab's applied filter; a state → apply it; null → clear. */
    filterOverride?: TableFilterState | null,
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
    // Load any persisted layout for this table the first time it is opened.
    const layoutKey = gridLayoutKey(
      postgresqlProvider.id,
      draft.id,
      object.schema,
      object.name,
    );
    setLayoutByTable((current) =>
      current[layoutKey]
        ? current
        : { ...current, [layoutKey]: loadGridLayout(layoutKey) },
    );
    // Paging or re-querying clears the find state (B-5).
    setFindState({ open: false, text: "", current: 0 });
    setRunning(true);
    try {
      // Paging/reload reads the applied filter from the open tab; applying a
      // new filter passes it explicitly because `tabs` has not re-rendered yet.
      const filter =
        filterOverride === undefined
          ? tabs.find((item) => item.id === id)?.activeFilter
          : (filterOverride ?? undefined);
      const result = adaptPostgresTableResult(
          await invoke<PostgresTableRuntimeResult>("postgres_table_data", {
            request: {
              connectionId: reference.connectionId,
              schema: object.schema,
              table: object.name,
              limit: pageSize,
              offset,
              ...(filter
                ? {
                    filter: {
                      logic: filter.logic,
                      conditions: filter.conditions.map((condition) => ({
                        column: condition.column,
                        operator: condition.operator,
                        value: condition.value ?? null,
                      })),
                    },
                    orderBy: filter.orderBy.map((sort) => ({
                      column: sort.column,
                      direction: sort.direction,
                    })),
                  }
                : {}),
            },
          }),
          { offset, limit: pageSize },
        );
      patchTab(id, {
        result,
        baseline: result,
        dirty: false,
        // Row indexes in pendingDeleteRows are invalidated by the reload:
        // keeping them could delete a different row on the next save.
        // Staged inserts are keyed by id, but clearing them too keeps the
        // reload semantics predictable ("reload = fresh snapshot").
        pendingInserts: [],
        pendingDeleteRows: [],
      });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: String(error),
      });
    } finally {
      setRunning(false);
    }
  };
  const tableReference = (): PostgresRelationReference | null =>
    tab?.type === "table" && tab.object
      ? {
          connectionId: draft.id,
          database: postgresConfig.database,
          schema: tab.object.schema,
          relation: tab.object.name,
        }
      : null;

  const applyFilter = (next: TableFilterState) => {
    if (!tab || tab.type !== "table") return;
    // An empty filter (no conditions, no sort) equals clearing it (A-12).
    if (isEmptyFilter(next)) {
      clearFilter();
      return;
    }
    patchTab(tab.id, { activeFilter: next });
    const reference = tableReference();
    if (reference) void browse(reference, 0, next);
  };

  const applyFilterByFieldValue = (
    column: string,
    value: string | null,
  ) => {
    if (!tab || tab.type !== "table") return;
    applyFilter(buildFieldValueFilter(column, value));
  };

  const clearFilter = () => {
    if (!tab || tab.type !== "table") return;
    patchTab(tab.id, { activeFilter: undefined });
    const reference = tableReference();
    if (reference) void browse(reference, 0, null);
  };

  const tabularRows =
    tab?.result?.kind === "tabular" ? tab.result.rows : [];
  const findMatches = useMemo(
    () => findCellMatches(tabularRows, findState.text),
    [tabularRows, findState.text],
  );
  const findNext = () =>
    setFindState((state) => ({
      ...state,
      current: nextFindIndex(state.current, findMatches.length),
    }));
  const findPrevious = () =>
    setFindState((state) => ({
      ...state,
      current: previousFindIndex(state.current, findMatches.length),
    }));
  const closeFind = () =>
    setFindState({ open: false, text: "", current: 0 });

  const filterSortLabels = (): FilterSortDialogLabels => ({
    title: t("toolbox.postgres.filterSortTitle"),
    conditions: t("toolbox.postgres.filterConditions"),
    column: t("toolbox.postgres.filterColumn"),
    operator: t("toolbox.postgres.filterOperator"),
    value: t("toolbox.postgres.filterValue"),
    valueLikeHint: t("toolbox.postgres.filterValueLikeHint"),
    addCondition: t("toolbox.postgres.filterAddCondition"),
    removeCondition: t("toolbox.postgres.filterRemoveCondition"),
    logicAnd: t("toolbox.postgres.filterLogicAnd"),
    logicOr: t("toolbox.postgres.filterLogicOr"),
    sort: t("toolbox.postgres.filterSortSection"),
    addSort: t("toolbox.postgres.filterAddSort"),
    sortAsc: t("toolbox.postgres.sortAsc"),
    sortDesc: t("toolbox.postgres.sortDesc"),
    apply: t("toolbox.postgres.filterApply"),
    cancel: t("toolbox.postgres.filterCancel"),
    clear: t("toolbox.postgres.filterClear"),
    operatorNames: {
      eq: t("toolbox.postgres.operatorEq"),
      neq: t("toolbox.postgres.operatorNeq"),
      gt: t("toolbox.postgres.operatorGt"),
      gte: t("toolbox.postgres.operatorGte"),
      lt: t("toolbox.postgres.operatorLt"),
      lte: t("toolbox.postgres.operatorLte"),
      like: t("toolbox.postgres.operatorLike"),
      isNull: t("toolbox.postgres.operatorIsNull"),
      isNotNull: t("toolbox.postgres.operatorIsNotNull"),
    },
  });

  const currentLayoutKey = (): string | null => {
    if (!tab?.object) return null;
    return gridLayoutKey(
      postgresqlProvider.id,
      draft.id,
      tab.object.schema,
      tab.object.name,
    );
  };

  const currentLayout = (): GridLayoutState => {
    const key = currentLayoutKey();
    return (key ? layoutByTable[key] : undefined) ?? DEFAULT_GRID_LAYOUT;
  };

  const patchLayout = (patch: Partial<GridLayoutState>) => {
    const key = currentLayoutKey();
    if (!key) return;
    const next = { ...currentLayout(), ...patch };
    setLayoutByTable((current) => ({ ...current, [key]: next }));
    saveGridLayout(key, next);
  };

  const freezeColumn = (columnIndex: number) => {
    if (tab?.result?.kind !== "tabular") return;
    const columnKey = tab.result.columns[columnIndex]?.key;
    if (!columnKey) return;
    const widths = { ...currentLayout().widths };
    // Frozen columns need a deterministic width so sticky offsets stay exact.
    if (!widths[columnKey]) widths[columnKey] = 120;
    patchLayout({ frozenCount: columnIndex + 1, widths });
  };

  const unfreezeAllColumns = () => patchLayout({ frozenCount: 0 });

  const setColumnWidth = (columnIndex: number, width: number) => {
    if (tab?.result?.kind !== "tabular") return;
    const columnKey = tab.result.columns[columnIndex]?.key;
    if (!columnKey) return;
    patchLayout({
      widths: {
        ...currentLayout().widths,
        [columnKey]: Math.max(60, Math.round(width)),
      },
    });
  };

  const bestFitColumn = (columnIndex: number) => {
    if (tab?.result?.kind !== "tabular") return;
    const column = tab.result.columns[columnIndex];
    if (!column) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = "12px sans-serif";
    let max = context.measureText(column.label).width;
    for (const row of tab.result.rows) {
      const value = row[columnIndex];
      if (value) max = Math.max(max, context.measureText(value).width);
    }
    // Padding + border allowance.
    setColumnWidth(columnIndex, Math.ceil(max + 24));
  };

  const setRowHeight = (rowHeight: number) =>
    patchLayout({ rowHeight: Math.max(16, Math.round(rowHeight)) });

  const toggleFieldType = () =>
    patchLayout({ showFieldType: !currentLayout().showFieldType });

  const toggleComment = () =>
    patchLayout({ showComment: !currentLayout().showComment });

  const treeToggle = (node: DatabaseObjectNode) => {
    const willExpand = !(expanded[node.id] ?? false);
    setExpanded((current) => ({ ...current, [node.id]: !current[node.id] }));
    if (willExpand && !navigatorChildren[node.id]) {
      void loadNavigatorChildren(
        node,
        postgresNavigatorLabels(t),
        setNavigatorChildren,
        setNavigatorLoadStates,
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
          postgresNavigatorLabels(t),
          setNavigatorChildren,
          setNavigatorLoadStates,
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
  const addRecord = () => {
    if (tab?.type !== "table" || tab.result?.kind !== "tabular") return;
    const row: PendingInsertRow = {
      id: generateId("pg-insert"),
      values: tab.result.columns.map(() => null),
      edited: [],
    };
    patchTab(tab.id, {
      pendingInserts: [...(tab.pendingInserts ?? []), row],
      dirty: true,
    });
  };
  const editInsertCell = (insertIndex: number, columnIndex: number, value: string) => {
    if (tab?.type !== "table") return;
    const inserts = tab.pendingInserts ?? [];
    const row = inserts[insertIndex];
    if (!row) return;
    const next: PendingInsertRow = {
      ...row,
      values: row.values.map((cell, index) =>
        index === columnIndex ? value : cell,
      ),
      edited: row.edited.includes(columnIndex)
        ? row.edited
        : [...row.edited, columnIndex],
    };
    patchTab(tab.id, {
      pendingInserts: inserts.map((item, index) =>
        index === insertIndex ? next : item,
      ),
      dirty: true,
    });
  };
  const isInsertCellModified = (insertIndex: number, columnIndex: number) =>
    Boolean(tab?.pendingInserts?.[insertIndex]?.edited.includes(columnIndex));
  const isPrimaryKeyColumn = (columnIndex: number) =>
    Boolean(
      tab?.result?.kind === "tabular" &&
        tab.result.editability.primaryKeyColumnKeys.includes(
          tab.result.columns[columnIndex]?.key ?? "",
        ),
    );
  const canSetNull = (columnIndex: number) =>
    !isPrimaryKeyColumn(columnIndex) &&
    Boolean(
      tab?.result?.kind === "tabular" &&
        tab.result.editability.nullableColumnKeys?.includes(
          tab.result.columns[columnIndex]?.key ?? "",
        ),
    );
  const rowHasPrimaryKey = (row: readonly (string | null)[]) => {
    if (tab?.result?.kind !== "tabular") return false;
    const result = tab.result;
    return result.editability.primaryKeyColumnKeys.every((key) => {
      const index = result.columns.findIndex((column) => column.key === key);
      return index >= 0 && row[index] !== null;
    });
  };
  const requestDeleteRow = (rowIndex: number) => setDeleteTarget(rowIndex);
  const stageDeleteRow = () => {
    if (tab?.type !== "table" || deleteTarget === null) return;
    const current = tab.pendingDeleteRows ?? [];
    if (!current.includes(deleteTarget)) {
      patchTab(tab.id, {
        pendingDeleteRows: [...current, deleteTarget].sort((a, b) => a - b),
        dirty: true,
      });
    }
    setDeleteTarget(null);
  };
  const removeInsertRow = (insertIndex: number) => {
    if (tab?.type !== "table") return;
    patchTab(tab.id, {
      pendingInserts: (tab.pendingInserts ?? []).filter(
        (_, index) => index !== insertIndex,
      ),
      dirty: true,
    });
  };
  const requestCloseTab = (id: string) => {
    const target = tabs.find((item) => item.id === id);
    if (target?.dirty) {
      setCloseTarget(id);
      return;
    }
    closeTab(id);
  };
  const isCellModified = (rowIndex: number, columnIndex: number) =>
    tab?.type === "table" &&
    tab.result?.kind === "tabular" &&
    tab.baseline?.rows[rowIndex]?.[columnIndex] !==
      tab.result.rows[rowIndex]?.[columnIndex];
  const saveTableChanges = async () => {
    if (
      !tab?.object ||
      tab.result?.kind !== "tabular" ||
      !tab.baseline ||
      !tab.dirty
    ) {
      return;
    }
    const columns = tab.result.columns;
    const keyNames = new Set(tab.result.editability.primaryKeyColumnKeys);
    const inserts = tab.pendingInserts ?? [];
    const deleteIndexes = tab.pendingDeleteRows ?? [];
    const updates: Array<{
      keyValues: Record<string, string>;
      changes: Record<string, string | null>;
    }> = [];
    for (let rowIndex = 0; rowIndex < tab.result.rows.length; rowIndex += 1) {
      if (deleteIndexes.includes(rowIndex)) continue;
      const row = tab.result.rows[rowIndex];
      const original = tab.baseline.rows[rowIndex];
      if (!original || row.every((value, index) => value === original[index])) continue;
      const changes = Object.fromEntries(
        columns.flatMap((column, index) =>
          !keyNames.has(column.key) && row[index] !== original[index]
            ? [[column.label, row[index]]]
            : [],
        ),
      );
      if (!Object.keys(changes).length) continue;
      const keyValues = Object.fromEntries(
        columns.flatMap((column, index) =>
          keyNames.has(column.key) && original[index] !== null
            ? [[column.label, original[index]]]
            : [],
        ),
      );
      updates.push({ keyValues, changes });
    }
    if (!updates.length && !inserts.length && !deleteIndexes.length) return;
    setSaving(true);
    try {
      await invoke("postgres_transaction", {
        request: { connectionId: draft.id, action: "begin" },
      });
      for (const update of updates) {
        await invoke("postgres_table_update", {
          request: {
            connectionId: draft.id,
            schema: tab.object.schema,
            table: tab.object.name,
            ...update,
          },
        });
      }
      for (const rowIndex of deleteIndexes) {
        const row = tab.baseline.rows[rowIndex];
        if (!row) continue;
        const keyValues = Object.fromEntries(
          columns.flatMap((column, index) =>
            keyNames.has(column.key) && row[index] !== null
              ? [[column.label, row[index]]]
              : [],
          ),
        );
        if (!Object.keys(keyValues).length) continue;
        await invoke("postgres_table_delete", {
          request: {
            connectionId: draft.id,
            schema: tab.object.schema,
            table: tab.object.name,
            keyValues,
          },
        });
      }
      const committedInserts: DatabaseResultRow[] = [];
      for (const insert of inserts) {
        // Skip rows the user staged but never edited: submitting an empty
        // column set would fail server-side and roll back the whole batch.
        if (!insert.edited.length) continue;
        const values = Object.fromEntries(
          insert.edited.map((columnIndex) => [
            columns[columnIndex].label,
            insert.values[columnIndex],
          ]),
        );
        const inserted = await invoke<{
          primaryKeyValues: Record<string, string>;
        }>("postgres_table_insert", {
          request: {
            connectionId: draft.id,
            schema: tab.object.schema,
            table: tab.object.name,
            values,
          },
        });
        committedInserts.push(
          columns.map((column, columnIndex) =>
            insert.edited.includes(columnIndex)
              ? insert.values[columnIndex]
              // Back-end back-fills primary-key values keyed by the server
              // column name (e.g. "id"), which is what `column.label` holds;
              // `column.key` is only the ordinal slot (`column:0`).
              : (inserted.primaryKeyValues[column.label] ?? null),
          ),
        );
      }
      await invoke("postgres_transaction", {
        request: { connectionId: draft.id, action: "commit" },
      });
      if (tab.activeFilter && tab.object) {
        // Filtered view: re-query so staged rows land inside/outside the
        // filter set as the server sees them (§4.4.6). browse() resets
        // baseline/dirty and clears pending rows on success.
        const reference = tableReference();
        if (reference) await browse(reference, tableOffset, tab.activeFilter);
        toast.success(t("toolbox.postgres.changesSaved"));
      } else {
        const nextRows = [
          ...tab.result.rows.filter(
            (_, rowIndex) => !deleteIndexes.includes(rowIndex),
          ),
          ...committedInserts,
        ];
        const nextResult: DatabaseTabularResult = {
          ...tab.result,
          rows: nextRows,
        };
        patchTab(tab.id, {
          result: nextResult,
          baseline: nextResult,
          dirty: false,
          pendingInserts: [],
          pendingDeleteRows: [],
        });
        toast.success(t("toolbox.postgres.changesSaved"));
      }
    } catch (error) {
      await invoke("postgres_transaction", {
        request: { connectionId: draft.id, action: "rollback" },
      }).catch(() => undefined);
      toast.error(t("toolbox.postgres.saveChangesFailed"), {
        description: String(error),
      });
    } finally {
      setSaving(false);
    }
  };
  const revertTableChanges = () => {
    if (tab?.baseline) {
      patchTab(tab.id, {
        result: tab.baseline,
        dirty: false,
        pendingInserts: [],
        pendingDeleteRows: [],
      });
    }
  };
  const onDatabaseKeyDown = useEffectEvent((event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typingInField = Boolean(
        target?.closest?.("input, textarea, select, [contenteditable='true']"),
      );
      if (event.key === "Insert" && !typingInField && tab?.type === "table" &&
          !postgresConfig.readOnly && tab.result?.kind === "tabular" &&
          tab.result.editability.editable) {
        event.preventDefault();
        addRecord();
        return;
      }
      // Find navigation (B-2/B-4): respond while the find bar is open, from
      // the find input or anywhere outside a cell editor.
      const inFindInput = Boolean(
        target?.closest?.('[data-testid="database-result-find-input"]'),
      );
      if (
        event.key === "F3" &&
        findState.open &&
        tab?.type === "table" &&
        (inFindInput || !typingInField)
      ) {
        event.preventDefault();
        findNext();
        return;
      }
      if (
        event.key === "Escape" &&
        findState.open &&
        tab?.type === "table" &&
        (inFindInput || !typingInField)
      ) {
        event.preventDefault();
        closeFind();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      // Focus guard (R-B18-2): while editing a cell or form field, let the
      // browser keep Ctrl+F/Ctrl+R default behavior instead of finding or
      // applying filters in the grid.
      if (tab?.type === "table" && typingInField) return;
      if (event.key.toLowerCase() === "f" && tab?.type === "table") {
        event.preventDefault();
        setFindState((state) => ({ ...state, open: true, current: 0 }));
        return;
      }
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
        requestCloseTab(activeTab);
      }
      if (event.key.toLowerCase() === "s" && !event.shiftKey && tab?.type === "table" &&
          tab.dirty && !saving) {
        event.preventDefault();
        void saveTableChanges();
      }
      if (event.key.toLowerCase() === "r" && connected) {
        event.preventDefault();
        if (tab?.type === "table" && tab.object) {
          const reference = tableReference();
          if (!reference) return;
          // B18: the dialog applies immediately, so Ctrl+R either replays
          // the active filter from offset 0 or refreshes the current page.
          const decision = resolveFilterShortcut(tab.activeFilter);
          if (decision.kind === "replay") {
            void browse(reference, 0, decision.filter);
          } else {
            void browse(reference, tableOffset);
          }
        } else {
          void refreshNavigator();
        }
      }    });
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
        {tab?.type === "table" && tab.activeFilter && (
          <>
            <ToolButton
              icon={<Filter />}
              label={t("toolbox.postgres.filterActive", {
                count: tab.activeFilter.conditions.length,
              })}
              onClick={() => setFilterDialog({ mode: "filterSort" })}
              data-testid="postgres-filter-badge"
            />
            <ToolButton
              icon={<X />}
              label={t("toolbox.postgres.clearFilter")}
              onClick={clearFilter}
              data-testid="postgres-clear-filter"
            />
            <Separator />
          </>
        )}
        <Separator />
        {tableEditingEnabled && (
          <>
            <ToolButton
              icon={<ListPlus />}
              label={t("toolbox.postgres.addRecord")}
              onClick={addRecord}
              data-testid="postgres-add-record"
            />
            <ToolButton
              icon={<Save />}
              label={t("toolbox.postgres.saveChanges")}
              disabled={!tab.dirty || saving}
              onClick={() => void saveTableChanges()}
              data-testid="postgres-save-changes"
            />
            <ToolButton
              icon={<Undo2 />}
              label={t("toolbox.postgres.revertChanges")}
              disabled={!tab.dirty}
              onClick={revertTableChanges}
              data-testid="postgres-revert-changes"
            />
            <Separator />
          </>
        )}
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
              loadStates={navigatorLoadStates}
              loadingLabel={t("toolbox.postgres.navigatorLoading")}
              emptyLabel={t("toolbox.postgres.navigatorEmpty")}
              errorLabel={t("toolbox.postgres.navigatorLoadFailed")}
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
                  <ContextMenuItem disabled={!connected} onSelect={() => void copyText(relation ? quoteQualifiedPostgresName(relation) : node.label)}>{t("toolbox.postgres.copyName")}</ContextMenuItem>
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
       onCloseTab={requestCloseTab}
       renderTabContextMenu={(item) => <>
         <ContextMenuItem onSelect={() => requestCloseTab(item.id)}>{t("common.close")}</ContextMenuItem>
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
                     <ToolButton icon={<Database />} label={t("toolbox.postgres.saveChanges")} disabled={!tab.dirty || saving || running || postgresConfig.readOnly} onClick={() => void saveTableChanges()} />
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
                  renderContextMenu={(cell, row, columnName, rowIndex, columnIndex, source = "row") => <>
                    {source === "insert" ? (
                      <>
                        <ContextMenuItem onSelect={() => void copyText(cell ?? "NULL")}>{t("toolbox.postgres.copyCell")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyText(row.map((value) => value ?? "NULL").join("\t"))}>{t("toolbox.postgres.copyRow")}</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => removeInsertRow(rowIndex)}>{t("toolbox.postgres.removeRecord")}</ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    ) : (
                      <>
                        <ContextMenuItem onSelect={() => void copyText(cell ?? "NULL")}>{t("toolbox.postgres.copyCell")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyText(row.map((value) => value ?? "NULL").join("\t"))}>{t("toolbox.postgres.copyRow")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyText(columnName)}>{t("toolbox.postgres.copyColumnName")}</ContextMenuItem>
                        <ContextMenuSeparator />
                        {tab.type === "table" && <>
                          <ContextMenuItem onSelect={() => applyFilterByFieldValue(columnName, cell)}>{t("toolbox.postgres.filterByFieldValue")}</ContextMenuItem>
                          <ContextMenuItem onSelect={() => setFilterDialog({ mode: "custom" })}>{t("toolbox.postgres.customFilter")}</ContextMenuItem>
                          <ContextMenuSeparator />
                        </>}
                        {tab.type === "table" && tableEditingEnabled && <>
                          <ContextMenuItem
                            disabled={!canSetNull(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, null)}
                          >{t("toolbox.postgres.setNull")}</ContextMenuItem>
                          <ContextMenuItem
                            disabled={isPrimaryKeyColumn(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, "")}
                          >{t("toolbox.postgres.setEmptyString")}</ContextMenuItem>
                          <ContextMenuItem
                            disabled={isPrimaryKeyColumn(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, crypto.randomUUID())}
                          >{t("toolbox.postgres.generateUuid")}</ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            disabled={!rowHasPrimaryKey(row)}
                            onSelect={() => requestDeleteRow(rowIndex)}
                          >{t("toolbox.postgres.deleteRecord")}</ContextMenuItem>
                        </>}
                      </>
                    )}
                    <ContextMenuItem onSelect={() => void exportCsv()}>{t("toolbox.postgres.exportCsv")}</ContextMenuItem>
                  </>}
                  renderColumnContextMenu={tab.type === "table" ? (columnName, columnIndex) => (
                    <>
                      <ContextMenuItem onSelect={() => {
                        setFilterDialog({ mode: "filterSort" });
                      }}>{t("toolbox.postgres.filterSort")}</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => freezeColumn(columnIndex)}>{t("toolbox.postgres.freezeColumn")}</ContextMenuItem>
                      <ContextMenuItem disabled={!currentLayout().frozenCount} onSelect={unfreezeAllColumns}>{t("toolbox.postgres.unfreezeAllColumns")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => setLayoutDialog({ kind: "columnWidth", columnIndex })}>{t("toolbox.postgres.setColumnWidth")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => bestFitColumn(columnIndex)}>{t("toolbox.postgres.bestFitColumn")}</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={toggleFieldType}>
                        {t("toolbox.postgres.showFieldType")}
                        {currentLayout().showFieldType ? " ✓" : ""}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={toggleComment}>
                        {t("toolbox.postgres.showComment")}
                        {currentLayout().showComment ? " ✓" : ""}
                      </ContextMenuItem>
                    </>
                  ) : undefined}
                  renderRowHeaderContextMenu={tab.type === "table" ? () => (
                    <ContextMenuItem onSelect={() => setLayoutDialog({ kind: "rowHeight" })}>{t("toolbox.postgres.setRowHeight")}</ContextMenuItem>
                  ) : undefined}
                  layout={tab.type === "table" ? currentLayout() : undefined}
                  onColumnResize={tab.type === "table" ? setColumnWidth : undefined}
                  onColumnBestFit={tab.type === "table" ? bestFitColumn : undefined}
                  find={tab.type === "table" ? { ...findState, matches: findMatches } : undefined}
                  findLabels={tab.type === "table" ? {
                    placeholder: t("toolbox.postgres.findPlaceholder"),
                    previous: t("toolbox.postgres.findPrevious"),
                    next: t("toolbox.postgres.findNext"),
                    close: t("toolbox.postgres.findClose"),
                    count: (current, total) =>
                      t("toolbox.postgres.findCount", { current, total }),
                    noMatch: t("toolbox.postgres.findNoMatch"),
                  } : undefined}
                  onFindTextChange={tab.type === "table" ? (text) => setFindState({ open: true, text, current: 0 }) : undefined}
                  onFindNext={tab.type === "table" ? findNext : undefined}
                  onFindPrevious={tab.type === "table" ? findPrevious : undefined}
                  onFindClose={tab.type === "table" ? closeFind : undefined}
                  onEditCell={tab.type === "table" && !postgresConfig.readOnly ? stageTableEdit : undefined}
                  isCellModified={isCellModified}
                  pendingInsertRows={tab.type === "table" ? tab.pendingInserts?.map((insert) => ({ id: insert.id, values: insert.values })) : undefined}
                  deletedRowIndexes={tab.type === "table" ? tab.pendingDeleteRows : undefined}
                  onEditInsertCell={tableEditingEnabled ? editInsertCell : undefined}
                  isInsertCellModified={isInsertCellModified}
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
      <Dialog
        open={pendingSshTrust !== null}
        onOpenChange={(open) => !open && setPendingSshTrust(null)}
      >
        <DialogContent className="!inset-0 !m-auto w-[520px] max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>{t("toolbox.postgres.trustHostKeyTitle")}</DialogTitle>
            <DialogDescription>
              {t("toolbox.postgres.trustHostKeyDescription")}
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-md border bg-muted/30 p-3 text-sm">
            <dt className="text-muted-foreground">{t("toolbox.postgres.sshHost")}</dt>
            <dd className="break-all font-mono">{pendingSshTrust?.profile.providerConfig.sshHost}</dd>
            <dt className="text-muted-foreground">{t("toolbox.postgres.sshPort")}</dt>
            <dd className="font-mono">{pendingSshTrust?.profile.providerConfig.sshPort ?? 22}</dd>
            <dt className="text-muted-foreground">{t("toolbox.postgres.sshFingerprint")}</dt>
            <dd className="break-all font-mono text-xs">{pendingSshTrust?.fingerprint}</dd>
          </dl>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSshTrust(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void trustAndConnect()}>
              {t("toolbox.postgres.trustAndConnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("toolbox.postgres.deleteRecordConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("toolbox.postgres.deleteRecordConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={stageDeleteRow}>
              {t("toolbox.postgres.deleteRecord")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={closeTarget !== null} onOpenChange={(open) => !open && setCloseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("toolbox.postgres.discardConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("toolbox.postgres.discardConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (closeTarget) closeTab(closeTarget);
                setCloseTarget(null);
              }}
            >
              {t("toolbox.postgres.discardConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {tab?.type === "table" && tab.result?.kind === "tabular" && (
        <FilterSortDialog
          open={filterDialog !== null}
          onOpenChange={(open) => !open && setFilterDialog(null)}
          columns={tab.result.columns}
          initialFilter={tab.activeFilter}
          includeSort={filterDialog?.mode === "filterSort"}
          labels={filterSortLabels()}
          onApply={applyFilter}
          onClear={clearFilter}
        />
      )}
      <LayoutValueDialog
        open={layoutDialog !== null}
        onOpenChange={(open) => !open && setLayoutDialog(null)}
        title={
          layoutDialog?.kind === "rowHeight"
            ? t("toolbox.postgres.setRowHeight")
            : t("toolbox.postgres.setColumnWidth")
        }
        defaultValue={
          layoutDialog?.kind === "rowHeight"
            ? currentLayout().rowHeight || 24
            : (currentLayout().widths[
                tab?.result?.kind === "tabular"
                  ? (tab.result.columns[layoutDialog?.columnIndex ?? 0]?.key ??
                    "")
                  : ""
              ] ?? 120)
        }
        onSubmit={(value) => {
          if (layoutDialog?.kind === "rowHeight") setRowHeight(value);
          else if (layoutDialog) setColumnWidth(layoutDialog.columnIndex, value);
        }}
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

/** Shared value dialog for Set Column Width / Set Row Height (Slice C). */
function LayoutValueDialog({
  open,
  title,
  defaultValue,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  defaultValue: number;
  onSubmit: (value: number) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(String(defaultValue));
  const { t } = useTranslation();
  useEffect(() => {
    if (open) setValue(String(defaultValue));
  }, [open, defaultValue]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 py-2">
          <Input
            type="number"
            min={16}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const numeric = Number(value);
                if (Number.isFinite(numeric)) onSubmit(numeric);
                onOpenChange(false);
              }
            }}
            data-testid="postgres-layout-value-input"
          />
          <span className="text-[11px] text-muted-foreground">px</span>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-sm px-3 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            {t("toolbox.postgres.filterCancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-sm px-3 text-[12px]"
            onClick={() => {
              const numeric = Number(value);
              if (Number.isFinite(numeric)) onSubmit(numeric);
              onOpenChange(false);
            }}
          >
            {t("toolbox.postgres.filterApply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  const sshServers = ConnectionStorageManager.getConnections().filter((connection) =>
    connection.protocol === "SSH" || connection.protocol === "SFTP",
  );
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
                  <div className="col-span-2">
                    <Field label={t("toolbox.postgres.jumpServer")}>
                      <Select
                        value={config.sshConnectionId ?? "manual"}
                        onValueChange={(id) => {
                          if (id === "manual") {
                            update("sshConnectionId", undefined);
                            return;
                          }
                          const server = sshServers.find((item) => item.id === id);
                          if (!server) return;
                          update("sshEnabled", true);
                          update("sshConnectionId", server.id);
                          update("sshHost", server.host);
                          update("sshPort", server.port);
                          update("sshUsername", server.username);
                          update("sshAuthMethod", server.authMethod === "publickey" ? "privateKey" : "password");
                          update("sshPassword", server.password);
                          update("sshPrivateKeyPath", server.privateKeyPath);
                          update("sshPrivateKeyPassphrase", server.passphrase);
                          update("sshHostKeyFingerprint", server.hostKeyFingerprint);
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={t("toolbox.postgres.selectJumpServer")} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manual">{t("toolbox.postgres.sshHost")}</SelectItem>
                          {sshServers.map((server) => (
                            <SelectItem key={server.id} value={server.id}>{server.name} ({server.username}@{server.host}:{server.port})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
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
