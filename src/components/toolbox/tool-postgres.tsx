import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText as writeClipboardText, readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile as writeBinaryFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Braces,
  ClipboardPaste,
  Copy,
  CopyCheck,
  CopyMinus,
  Database,
  Eraser,
  Eye,
  FileCode,
  FileCode2,
  FileDown,
  FilePlus2,
  FileSpreadsheet,
  Filter,
  Fingerprint,
  FolderTree,
  Hash,
  History,
  KeyRound,
  LineChart,
  ListChecks,
  ListFilter,
  ListPlus,
  Loader2,
  CircleAlert,
  MoveHorizontal,
  Pencil,
  PencilRuler,
  Pin,
  PinOff,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RemoveFormatting,
  RotateCcw,
  Rows3,
  Save,
  Scissors,
  Search,
  Server,
  Shrink,
  Square,
  Table2,
  Trash2,
  Undo2,
  Unplug,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
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
import { EditorView as EditorViewImpl } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { undo, redo, selectAll } from "@codemirror/commands";
import { StateEffect } from "@codemirror/state";
import {
  currentStatementAt,
  toggleLineComment,
  type SqlStatementRange,
} from "@/lib/database/sql-statement-tokenizer";
import { formatSql, formatSqlSelection } from "@/lib/database/sql-formatter";
import {
  databaseErrorResult,
  parseProviderError,
  type ParsedDatabaseError,
} from "@/lib/database/database-error";
import { revealEditorLine } from "@/lib/database/editor-error-reveal";
import {
  generateInsertSql,
  generateInsertValuesSql,
  generateSelectSql,
  generateUpdateSql,
  type ColumnMetadata,
  type SqlGenerationOptions,
} from "@/lib/database/sql-generation";
import { addQueryHistory } from "@/lib/database/query-history";
import { flashEditorRange } from "@/lib/database/editor-flash";
import { useDatabaseKeyboardShortcuts } from "@/lib/keyboard/use-database-keyboard-shortcuts";
import { generateId, NotesStorage } from "@/lib/toolbox/toolbox-storage";
import type { NoteItem } from "@/lib/toolbox/toolbox-types";
import { ConnectionStorageManager } from "@/lib/connection-storage";
import { PostgresConnectionsStorage } from "@/lib/toolbox/postgres-storage";
import type {
  PostgreSQLConnectionConfig,
  PostgreSQLConnectionProfile,
  PostgreSQLSslMode,
} from "@/lib/database/postgresql-profile-adapter";
import { createPostgresQueryEditorContext } from "@/lib/database/postgresql-query-editor";
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
import { DatabaseResultErrorPane } from "@/components/toolbox/database-result-error";
import { QueryHistoryView } from "@/components/toolbox/query-history-view";
import { formatShortcut } from "@/components/toolbox/db-context-menus";
import {
  ObjectViewerTab,
  type ObjectViewerTabState,
} from "@/components/toolbox/object-viewer-tab";
import { TableDesignerTab } from "@/components/toolbox/table-designer-tab";
import type { TableDesign, TableDesignChange } from "@/lib/database/table-design";
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
  PostgresConnectionManager,
  CONNECTION_ACCENT_COLORS,
  type ConnectionTestOutcome,
} from "@/components/toolbox/postgres-connection-manager";
import { listConnectionGroupNames } from "@/lib/database/connection-groups";

import {
  createPostgresNavigatorConnectionNode,
  createPostgresNavigatorGroupNode,
  getPostgresObjectReference,
  getPostgresRelationReference,
  loadPostgresNavigatorChildren,
  type PostgresNavigatorGroupLabels,
  type PostgresObjectReference,
  type PostgresRelationReference,
} from "@/lib/database/postgresql-object-loader";
import { groupConnectionsByGroup } from "@/lib/database/connection-groups";
import type { DatabaseNodeStatusBadge } from "@/lib/database/types";
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
/** Column metadata returned by `postgres_catalog_objects { kind: "columns" }`
 *  (the loader keeps `PostgresCatalogObjectItem` internal). */
type PostgresCatalogColumnItem = {
  readonly kind: string;
  readonly schema: string;
  readonly name: string;
  readonly dataType?: string;
  readonly nullable?: boolean;
  readonly default?: string;
  readonly ordinal?: number;
  /** True when the column is part of the table's primary key (P0-1). */
  readonly isPrimaryKey?: boolean;
};
/** A row staged for INSERT. Only `edited` column indexes are submitted; the
 * remaining columns keep their server-side DEFAULT. */
type PendingInsertRow = {
  id: string;
  values: readonly (string | null)[];
  edited: readonly number[];
};
type WorkspaceTab = {
  id: string;
  /**
   * The immutable backend session this tab belongs to.  Never infer this
   * from the navigator's currently selected connection: users can keep
   * development and production sessions open at the same time.
   */
  connectionId: string;
  type: "query" | "table" | "object" | "designer";
  title: string;
  object?: TableObject;
  /**
   * Relation kind for table-type tabs: "view" / "materializedView" are
   * read-only and must not expose edit controls (visual review M2).
   */
  objectRole?: "table" | "view" | "materializedView";
  /** B21 object viewer payload (function/sequence/index/constraint/trigger/column). */
  objectReference?: PostgresObjectReference;
  /** True = new-table designer (CREATE TABLE, no load). */
  createMode?: boolean;
  sql: string;
  result: DatabaseResult | null;
  /** Action verb recorded when `result` is an error, so the error card title
   *  reads "<action> failed" (ux-spec §2.4 / P2-13) instead of a generic
   *  "Execution failed". */
  errorAction?: "query" | "explain" | "browse";
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
type SavedQueryTab = Pick<WorkspaceTab, "id" | "title" | "sql">;

function savedQueryStorageKey(connectionId: string): string {
  return `nexterm.postgres.savedQueries.${connectionId}`;
}

function loadSavedQueryTabs(connectionId: string): readonly SavedQueryTab[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(savedQueryStorageKey(connectionId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.title === "string" && typeof row.sql === "string"
        ? [{ id: row.id, title: row.title, sql: row.sql }]
        : [];
    });
  } catch {
    return [];
  }
}

function persistQueryTab(tab: WorkspaceTab): void {
  if (tab.type !== "query" || !tab.connectionId || !tab.sql.trim()) return;
  const saved = loadSavedQueryTabs(tab.connectionId);
  const next = [...saved.filter((item) => item.id !== tab.id), {
    id: tab.id,
    title: tab.title,
    sql: tab.sql,
  }];
  localStorage.setItem(savedQueryStorageKey(tab.connectionId), JSON.stringify(next));
}
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

/** Escapes a string for use inside a single-quoted PG literal (e.g. the
 *  `'schema.table'::regclass` cast used by table statistics). */
function quoteLiteralText(value: string): string {
  return value.replace(/'/g, "''");
}

function postgresNavigatorLabels(t: TFunction): PostgresNavigatorGroupLabels {
  return {
    tables: t("toolbox.postgres.tables"),
    views: t("toolbox.postgres.views"),
    materializedViews: t("toolbox.postgres.materializedViews"),
    functions: t("toolbox.postgres.functions"),
    sequences: t("toolbox.postgres.sequences"),
    columns: t("toolbox.postgres.columns"),
    indexes: t("toolbox.postgres.indexes"),
    constraints: t("toolbox.postgres.constraints"),
    triggers: t("toolbox.postgres.triggers"),
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

function newQuery(connectionId: string): WorkspaceTab {
  return {
    id: generateId("pg-query"),
    connectionId,
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
    group: profile.group?.trim() || undefined,
    accentColor: profile.providerConfig.color?.trim() || undefined,
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
  // Step 2: DDL preview panel state (single-click navigator → formatted DDL).
  const [ddlPreview, setDdlPreview] = useState<{
    schema: string;
    name: string;
    objectType: string;
    ddl: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const ddlPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expanded, setExpanded] = useState<
    Partial<Record<DatabaseObjectNodeId, boolean>>
  >({});
  const [navigatorChildren, setNavigatorChildren] =
    useState<NavigatorChildren>({});
  const [navigatorLoadStates, setNavigatorLoadStates] =
    useState<NavigatorLoadStates>({});
  const [selectedNavigatorNodeId, setSelectedNavigatorNodeId] =
    useState<DatabaseObjectNodeId | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([newQuery(draft.id)]);
  const [activeTab, setActiveTab] = useState<string>(() => tabs[0]?.id ?? "");
  const [resultHeight, setResultHeight] = useState(260);
  const [resultDragging, setResultDragging] = useState(false);
  /** Query-history panel toggle (feature-design §5.3): swaps the result area
   *  between the grid and the in-pane history view (ux-spec §4.5). */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [running, setRunning] = useState(false);
  /** L3 connection-level error banner text (ux-spec §2.2.3 / P2-10). Non-null
   *  renders the persistent banner below the toolbar until reconnect succeeds. */
  const [connectionError, setConnectionError] = useState<string | null>(null);
  /** True when the query editor has an active selection — drives cut/copy
   *  menu-item enablement (ux-spec §1.1.4 / P2-2.5). */
  const [editorHasSelection, setEditorHasSelection] = useState(false);
  /** Run id of the in-flight query, used by `postgres_cancel` (B19). */
  const runIdRef = useRef(0);
  const activeRunIdRef = useRef<number | null>(null);
  /** CodeMirror view of the active query editor (B19 statement ops). */
  const queryEditorViewRef = useRef<EditorView | null>(null);
  /** Statement range of the last failed execution, so the error pane's
   *  "jump to line" can map the server `LINE n` back into the editor
   *  (feature-design §2.5). Null = the whole document was sent. */
  const lastErrorRangeRef = useRef<SqlStatementRange | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  /** Connection id staged for the delete-confirmation AlertDialog
   *  (ux-spec §1.2.1: 删除连接 needs AlertDialog, not window.confirm). */
  const [deleteConnectionTarget, setDeleteConnectionTarget] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [dialogPage, setDialogPage] = useState<DialogPage>("general");
  const [transactionActive, setTransactionActive] = useState(false);
  const [pendingSshTrust, setPendingSshTrust] = useState<PendingPostgresSshTrust | null>(null);
  const [saving, setSaving] = useState(false);
  /** Row index (into committed result rows) awaiting delete confirmation. */
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  /** B21: object awaiting destructive Drop confirmation. */
  const [objectDropTarget, setObjectDropTarget] = useState<{
    reference: PostgresObjectReference;
    kind: string;
    qualified: string;
  } | null>(null);
  /** B21: drop dry-run result (dependents) shown in the confirmation dialog. */
  const [objectDropPreview, setObjectDropPreview] = useState<{
    objectExists: boolean;
    dependentCount: number | null;
    sampleDependents: readonly string[];
  } | null>(null);
  /** Tab id awaiting dirty-discard confirmation before closing. */
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  /** Save-to-notes dialog state: target note id (or "__new__") and the
   *  editable title used when creating a new note. */
  const [noteDialog, setNoteDialog] = useState<{
    target: string;
    title: string;
  } | null>(null);
  /** SQL snapshot taken when the save-to-notes dialog opens, so confirming
   *  after switching tabs still writes the intended statement. */
  const noteContentRef = useRef<string>("");
  /** Content-source label for the query editor's "Save to notes" menu item. */
  const [editorMenuSource, setEditorMenuSource] = useState<
    "selection" | "statement" | "document" | null
  >(null);
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
      const detail = (event as CustomEvent<{ content?: string; handled?: boolean; provider?: string }>).detail;
      // Only this provider responds to provider-scoped paste events; events
      // without a provider keep working for backward compatibility.
      if (detail?.provider !== undefined && detail.provider !== "postgres") return;
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
  const tabConnection = tab
    ? connections.find((connection) => connection.id === tab.connectionId) ??
      (draft.id === tab.connectionId ? draft : undefined)
    : undefined;
  const tabPostgresConfig = tabConnection?.providerConfig;
  const tableEditingEnabled =
    tab?.type === "table" &&
    // Views and materialized views are read-only: never show edit controls
    // (visual review M2, v2.8.0).
    tab.objectRole !== "view" &&
    tab.objectRole !== "materializedView" &&
    !tabPostgresConfig?.readOnly &&
    tab.result?.kind === "tabular" &&
    tab.result.editability.editable;
  const navigatorConnections = connections.length
    ? connections
    : connected
      ? [draft]
      : connections;
  // B22: group connections by their profile.group into virtual group headers
  // (ungrouped last). Each connection node carries its accent color and the
  // live session badge.
  const groupedConnections = groupConnectionsByGroup(navigatorConnections);
  const navigatorRoots = groupedConnections.flatMap((group) => {
    const nodes = group.connections.map((connection) => {
      const live = connection.id === draft.id;
      const statusBadge: DatabaseNodeStatusBadge = !connected && !connecting
        ? "disconnected"
        : connecting && live
          ? "connecting"
          : connected && live
            ? "connected"
            : "disconnected";
      return createPostgresNavigatorConnectionNode({
        ...toPostgresNavigatorConnection(connection),
        statusBadge: live || !connected ? statusBadge : undefined,
      });
    });
    if (!group.groupName) return nodes;
    return [createPostgresNavigatorGroupNode(group.groupName), ...nodes];
  });
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
  const updateProfile = <K extends "name" | "environment" | "group">(
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

  // Clear DDL preview when switching tabs
  useEffect(() => {
    setDdlPreview(null);
  }, [activeTab]);

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
    // Saving a connection closes the editor, matching the connect flow.
    setConfigOpen(false);
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
  /** Heuristic: is this a connection-level (disconnect) failure rather than a
   *  statement error? Drives the L3 persistent banner (P2-10). */
  const isConnectionLevelError = (message: string) =>
    /connection (closed|is already closed|reset)|broken pipe|server closed|connection refused|not connected|terminating connection/i.test(
      message,
    );
  /** Surfaces a connection-level failure as the persistent banner (P2-10). */
  const reportConnectionError = (message: string) => {
    if (isConnectionLevelError(message)) setConnectionError(message);
  };
  /**
   * Points every untouched query tab at `connectionId`.
   *
   * The workspace boots with one placeholder query tab bound to the initial
   * draft id, and "New connection" mints a fresh profile id. Without this
   * rebind the placeholder keeps the stale id, so the first Run in a brand new
   * connection executes against an id the backend has never seen and fails
   * with "PostgreSQL connection is not active" — the user has no way to tell
   * why their first query does nothing. Tabs that have already been executed
   * (result != null) are left alone so real work is never silently moved to
   * another connection.
   */
  const rebindUntouchedQueryTabs = (connectionId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.type === "query" && !tab.result
          ? { ...tab, connectionId }
          : tab,
      ),
    );
  };
  const connectEstablished = async (
    profile: PostgreSQLConnectionProfile,
  ): Promise<boolean> => {
    setConnecting(true);
    try {
      const saved = { ...profile, updatedAt: Date.now() };
      if (!(await PostgresConnectionsStorage.upsert(saved))) {
        toast.error(t("toolbox.postgres.saveFailed"));
        return false;
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
      setConnectionError(null);
      rebindUntouchedQueryTabs(saved.id);
      const savedQueries = loadSavedQueryTabs(saved.id);
      if (savedQueries.length) {
        setTabs((current) => [
          ...current,
          ...savedQueries
            .filter((savedTab) => !current.some((tab) => tab.id === savedTab.id))
            .map((savedTab): WorkspaceTab => ({
              ...savedTab,
              connectionId: saved.id,
              type: "query",
              result: null,
              dirty: false,
            })),
        ]);
        setActiveTab(savedQueries[0].id);
      }
      setConfigOpen(false);
      toast.success(
        t("toolbox.postgres.connected", { version: status.serverVersion }),
      );
      return true;
    } catch (error) {
      const message = String(error);
      const isHostKeyMismatch = message.includes("host key fingerprint changed");
      setConnectionError(
        isHostKeyMismatch
          ? t("toolbox.postgres.hostKeyMismatch")
          : message,
      );
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
      return false;
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
  useEffect(() => {
    const quickExecute = (event: Event) => {
      const detail = (event as CustomEvent<{ content?: string; connectionId?: string }>).detail;
      const sql = detail?.content?.trim();
      const connection = connections.find((item) => item.id === detail?.connectionId);
      if (!sql || !connection) return;
      void (async () => {
        if (!connected || draft.id !== connection.id) await connectEstablished(connection);
        const quickTab = { ...newQuery(connection.id), title: t("toolbox.postgres.quickQuery"), sql };
        openTab(quickTab);
        try {
          const result = await invoke<PostgresQueryRuntimeResult>("postgres_execute", {
            request: { connectionId: connection.id, sql, maxRows: 1_000 },
          });
          patchTab(quickTab.id, { result: adaptPostgresQueryResult(result), dirty: false });
        } catch (error) {
          toast.error(t("toolbox.postgres.queryFailed"), { description: String(error) });
        }
      })();
    };
    window.addEventListener("nexterm:quick-execute-postgres", quickExecute);
    return () => window.removeEventListener("nexterm:quick-execute-postgres", quickExecute);
  }, [connected, connections, draft.id, t]);
  useEffect(() => {
    const pasteToQuery = (event: Event) => {
      const detail = (event as CustomEvent<{ content?: string; connectionId?: string; sourceTitle?: string }>).detail;
      const sql = detail?.content?.trim();
      const connection = connections.find((item) => item.id === detail?.connectionId);
      if (!sql) return;
      if (!connection) {
        toast.error(t("toolbox.postgres.pasteConnectionNotFound"));
        return;
      }
      void (async () => {
        if (!connected || draft.id !== connection.id) {
          toast.info(t("toolbox.postgres.connecting"));
          const ok = await connectEstablished(connection);
          if (!ok) return; // connectEstablished already surfaced the error toast
        }
        const next = {
          ...newQuery(connection.id),
          title: detail?.sourceTitle?.trim() || t("toolbox.postgres.quickQuery"),
          sql,
          dirty: true,
        };
        openTab(next);
        // Focus the new tab's editor and place the caret at the end of the document.
        requestAnimationFrame(() => {
          const view = queryEditorViewRef.current;
          if (!view) return;
          const end = view.state.doc.length;
          view.dispatch({ selection: { anchor: end } });
          view.focus();
        });
      })();
    };
    window.addEventListener("nexterm:paste-sql-to-query", pasteToQuery);
    return () => window.removeEventListener("nexterm:paste-sql-to-query", pasteToQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectEstablished is a stable inline fn; adding it re-binds the listener on every render
  }, [connected, connections, draft.id, t]);
  // Keep the backend session's search_path aligned with the navigator's
  // selected schema so bare table names in user SQL resolve like DBeaver:
  // picking `myschema` in the tree makes `SELECT * FROM users` hit
  // `myschema.users` first (public stays as fallback). Fires on connect and
  // on every schema switch; failures are surfaced as a passive toast only —
  // the session still works with the server-default search_path.
  useEffect(() => {
    if (!connected || !schema) return;
    void invoke("postgres_set_search_path", {
      request: { connectionId: draft.id, schema },
    }).catch((error: unknown) => {
      toast.warning(t("toolbox.postgres.searchPathSyncFailed"), {
        description: String(error),
      });
    });
  }, [connected, schema, draft.id, t]);
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
  const testConnection = async (
    profile: PostgreSQLConnectionProfile,
  ): Promise<ConnectionTestOutcome> => {
    // Probe over a throwaway connection id so the session registry and the
    // connections table are never touched (AC-22C-4).
    const probeId = `probe-${profile.id}-${Date.now()}`;
    const started = performance.now();
    try {
      const status = await invoke<{ serverVersion: string }>("postgres_connect", {
        request: {
          connectionId: probeId,
          host: profile.providerConfig.host,
          port: profile.providerConfig.port,
          database: profile.providerConfig.database,
          username: profile.providerConfig.username,
          password: profile.providerConfig.password,
          readOnly: true,
          sslMode: profile.providerConfig.sslMode,
          sslRootCert: profile.providerConfig.sslRootCert,
          sslClientCert: profile.providerConfig.sslClientCert,
          sslClientKey: profile.providerConfig.sslClientKey,
          ssh: profile.providerConfig.sshEnabled
            ? {
                host: profile.providerConfig.sshHost,
                port: profile.providerConfig.sshPort ?? 22,
                username: profile.providerConfig.sshUsername,
                authMethod: profile.providerConfig.sshAuthMethod ?? "password",
                password: profile.providerConfig.sshPassword,
                privateKey: profile.providerConfig.sshPrivateKey,
                privateKeyPath: profile.providerConfig.sshPrivateKeyPath,
                privateKeyPassphrase: profile.providerConfig.sshPrivateKeyPassphrase,
                hostKeyFingerprint: profile.providerConfig.sshHostKeyFingerprint,
              }
            : undefined,
        },
      });
      await invoke("postgres_disconnect", { connectionId: probeId });
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        version: status.serverVersion,
      };
    } catch (error) {
      await invoke("postgres_disconnect", { connectionId: probeId }).catch(
        () => undefined,
      );
      return { ok: false, error: String(error) };
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
  const openDesigner = (schema: string, table: string, createMode = false) => {
    openTab({
      id: createMode
        ? `designer:new:${draft.id}:${schema}:${crypto.randomUUID()}`
        : `designer:${draft.id}:${schema}.${table}`,
      connectionId: draft.id,
      type: "designer",
      title: createMode
        ? t("toolbox.postgres.newTable")
        : `${table} (Design)`,
      object: { schema, name: table },
      objectRole: "table",
      createMode,
      sql: "",
      result: null,
    });
  };
  const openViewDesigner = async (schema: string, view: string) => {
    try {
      const ddl = await invoke<string>("postgres_object_ddl", {
        request: {
          connectionId: draft.id,
          objectType: "view",
          schema,
          name: view,
        },
      });
      openTab({
        id: `designer:${draft.id}:${schema}.${view}`,
        connectionId: draft.id,
        type: "designer",
        title: `${view} (View)`,
        object: { schema, name: view },
        objectRole: "view",
        sql: ddl,
        result: null,
      });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: String(error),
      });
    }
  };
  const closeTab = (id: string) =>
    setTabs((current) => {
      const next = current.filter((item) => item.id !== id);
      setActiveTab(next.at(-1)?.id ?? "");
      return next.length ? next : [newQuery(draft.id)];
    });
  const execute = async (explain = false) => {
    if (!connected || !tab?.sql.trim()) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    activeRunIdRef.current = runId;
    setRunning(true);
    try {
      const result = adaptPostgresQueryResult(
        await invoke<PostgresQueryRuntimeResult>(
          explain ? "postgres_explain" : "postgres_execute",
          {
            request: {
              connectionId: tab.connectionId,
              sql: tab.sql,
              maxRows: 1_000,
              runId,
            },
          },
        ),
      );
      patchTab(tab.id, { result });
      addQueryHistory({
        sql: tab.sql,
        connectionId: tab.connectionId,
        connectionName: tabConnection?.name ?? tab.connectionId,
        providerId: "postgresql",
        success: true,
      });
    } catch (error) {
      const parsed = showQueryError(tab.id, error, explain ? "explain" : "query");
      reportConnectionError(parsed.message);
      // Whole-document execution: the server LINE n is relative to the first
      // editor line, so the statement range is null (feature-design §2.5).
      lastErrorRangeRef.current = null;
      toast.error(
        t(
          explain
            ? "toolbox.postgres.explainFailed"
            : "toolbox.postgres.queryFailed",
        ),
        { description: parsed.message },
      );
      if (parsed.lineNumber != null && tab.type === "query") {
        const view = queryEditorViewRef.current;
        if (view) revealEditorLine(view, null, parsed.lineNumber);
      }
      addQueryHistory({
        sql: tab.sql,
        connectionId: tab.connectionId,
        connectionName: tabConnection?.name ?? tab.connectionId,
        providerId: "postgresql",
        success: false,
      });
    } finally {
      setRunning(false);
      if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
    }
  };
  const saveCurrentSql = () => {
    if (!tab || tab.type !== "query") return;
    persistQueryTab(tab);
    patchTab(tab.id, { dirty: false });
    toast.success(t("toolbox.postgres.sqlSaved"));
  };
  const appendSqlToNotes = (contentOverride?: string) => {
    if (!tab || tab.type !== "query") return;
    // Selection first (same resolution as the editor right-click menu): a
    // non-empty selection wins, then the statement under the caret, then the
    // whole document. Guard: onClick handlers can forward a DOM event object
    // as the first arg.
    let content: string;
    if (typeof contentOverride === "string") {
      content = contentOverride;
    } else {
      const view = queryEditorViewRef.current;
      let source = tab.sql;
      if (view) {
        const sel = view.state.selection.main;
        const selected = view.state.doc.sliceString(sel.from, sel.to).trim();
        source = selected ? selected : currentStatementSql() || tab.sql;
      }
      content = source;
    }
    content = content.trim();
    if (!content) return;
    noteContentRef.current = content;
    const notes = NotesStorage.load();
    const savedTarget = localStorage.getItem("nexterm.notes.lastSaveTarget");
    const target =
      savedTarget && savedTarget !== "__new__" &&
      notes.some((note) => note.id === savedTarget)
        ? savedTarget
        : "__new__";
    setNoteDialog({ target, title: tab.title });
  };
  /** True when the target note already contains a `-- {title}` header block,
   *  which would indicate the same SQL was appended before. */
  const noteHasDuplicateBlock = (note: NoteItem | undefined, title: string) =>
    !!note &&
    note.content
      .split("\n")
      .some((line) => line.trim() === `-- ${title.trim().replace(/[\r\n]+/g, " ")}`);
  const confirmAppendSqlToNotes = () => {
    if (!noteDialog) return;
    const content = noteContentRef.current;
    const now = Date.now();
    // Ask the notes view to flush any pending (debounced) edits, then read
    // the latest store state so the target/duplicate checks are authoritative.
    window.dispatchEvent(new Event("nexterm:toolbox-flush-request"));
    const notes = NotesStorage.load();
    let targetId = noteDialog.target;
    const targetNote =
      targetId !== "__new__"
        ? notes.find((note) => note.id === targetId)
        : undefined;
    let createdFallback = false;
    if (targetId !== "__new__" && !targetNote) {
      // The selected note was deleted while the dialog was open — fall back
      // to creating a new note.
      targetId = "__new__";
      createdFallback = true;
    }
    const title = (
      targetId === "__new__"
        ? noteDialog.title
        : targetNote?.title ?? noteDialog.title
    )
      .trim()
      .replace(/[\r\n]+/g, " ");
    if (!title || !content.trim()) return;
    let savedToId: string;
    let next: NoteItem[];
    if (targetId !== "__new__" && targetNote) {
      next = notes.map((note) =>
        note.id === targetNote.id
          ? {
              ...note,
              language: "sql" as const,
              content: note.content.trim()
                ? `${note.content.trimEnd()}\n-- ${title}\n${content}`
                : `-- ${title}\n${content}`,
              updatedAt: now,
            }
          : note,
      );
      savedToId = targetNote.id;
    } else {
      const note: NoteItem = {
        id: generateId("note"),
        title,
        language: "sql" as const,
        content: `-- ${title}\n${content}`,
        createdAt: now,
        updatedAt: now,
      };
      next = [note, ...notes];
      savedToId = note.id;
    }
    NotesStorage.save(next);
    localStorage.setItem("nexterm.notes.lastSaveTarget", savedToId);
    window.dispatchEvent(new Event("nexterm:toolbox-changed"));
    if (createdFallback) toast.info(t("toolbox.postgres.saveTargetFallback"));
    toast.success(t("toolbox.postgres.saveToNotesDone", { title }), {
      action: {
        label: t("toolbox.postgres.saveToNotesView"),
        onClick: () =>
          window.dispatchEvent(
            new CustomEvent("nexterm:select-note", {
              detail: { noteId: savedToId },
            }),
          ),
      },
    });
    setNoteDialog(null);
  };
  /** Line count of the current editor selection (for the menu subtitle). */
  const countEditorSelectionLines = (): number => {
    const view = queryEditorViewRef.current;
    if (!view) return 0;
    const selection = view.state.selection.main;
    if (selection.to <= selection.from) return 0;
    return view.state.doc.sliceString(selection.from, selection.to).split("\n").length;
  };
  /** Determine which slice of the document a right-click "save to notes"
   *  would take: a non-empty selection, the current statement, or the whole
   *  document (fallback). */
  const editorMenuSourceKind = (): "selection" | "statement" | "document" | null => {
    const view = queryEditorViewRef.current;
    if (!view) return null;
    const selection = view.state.selection.main;
    if (
      selection.to > selection.from &&
      view.state.doc.sliceString(selection.from, selection.to).trim()
    ) {
      return "selection";
    }
    if (currentStatementSql()) return "statement";
    return "document";
  };
  /** Text captured by the editor's "Copy" context-menu item (selection →
   *  current statement → whole document). */
  const editorCopyValue = (): string => {
    const view = queryEditorViewRef.current;
    if (!view) return tab?.sql ?? "";
    const selection = view.state.selection.main;
    if (selection.to > selection.from) {
      return view.state.doc.sliceString(selection.from, selection.to);
    }
    return currentStatementSql() || tab?.sql || "";
  };
  /** Open the save-to-notes dialog with the right-click source resolution. */
  const openSaveToNotesFromEditorMenu = () => {
    if (!tab || tab.type !== "query") return;
    const view = queryEditorViewRef.current;
    let content = "";
    if (view) {
      const selection = view.state.selection.main;
      content = selection.to > selection.from
        ? view.state.doc.sliceString(selection.from, selection.to).trim()
        : "";
    }
    appendSqlToNotes(content || currentStatementSql() || tab.sql);
  };
  /** Stop the in-flight query (B19): triggers server-side pg_cancel_backend. */
  const stopQuery = async () => {
    if (!connected || !running || activeRunIdRef.current === null) return;
    try {
      await invoke("postgres_cancel", {
        connectionId: tab.connectionId,
        runId: activeRunIdRef.current,
      });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryStopFailed"), {
        description: String(error),
      });
    }
  };
  /** Executes only the selected text, or the current statement when no
   * selection spans multiple lines (Ctrl+E / Ctrl+Enter, B19-A). The sent
   * range is captured so a failure can reveal the exact editor line. */
  const runSelectionOrStatement = () => {
    const view = queryEditorViewRef.current;
    if (!connected || !view) return;
    const selection = view.state.selection.main;
    const selected = view.state.doc.sliceString(selection.from, selection.to).trim();
    if (selected) {
      void runSql(selected, { start: selection.from, end: selection.to });
      return;
    }
    const doc = view.state.doc.toString();
    const range = currentStatementAt(doc, selection.head);
    if (!range) return;
    const sql = doc.slice(range.start, range.end).trim();
    if (sql) void runSql(sql, range);
  };
  const currentStatementSql = (): string => {
    const view = queryEditorViewRef.current;
    if (!view) return "";
    const doc = view.state.doc.toString();
    const range = currentStatementAt(doc, view.state.selection.main.head);
    return range ? doc.slice(range.start, range.end).trim() : "";
  };
  /** Toggles -- line comments on the current selection (Ctrl+/, B19-B). */
  const toggleSqlComment = () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    const doc = view.state.doc.toString();
    const next = toggleLineComment(doc, selection.from, selection.to);
    if (next === doc) return;
    view.dispatch({ changes: { from: 0, to: doc.length, insert: next } });
  };
  /** Formats SQL in the editor (Ctrl+Shift+F, Step 2).
   *  No selection = format full document; with selection = format selection only. */
  const formatSqlInEditor = () => {
    const view = queryEditorViewRef.current;
    if (!view || !tab || tab.type !== "query") return;
    const selection = view.state.selection.main;
    const hasSelection = selection.to > selection.from;
    if (hasSelection) {
      const selected = view.state.doc.sliceString(selection.from, selection.to);
      const formatted = formatSqlSelection(selected);
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
      patchTab(tab.id, { sql: formatted });
    }
  };
  const runSql = async (
    sql: string,
    /** Range of the sent statement in the editor; null = whole document sent.
     *  Used to map a server `LINE n` back to an editor line (feature-design
     *  §2.5). */
    sentRange?: SqlStatementRange | null,
  ) => {
    if (!tab) return;
    patchTab(tab.id, { sql });
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    activeRunIdRef.current = runId;
    setRunning(true);
    try {
      const result = adaptPostgresQueryResult(
        await invoke<PostgresQueryRuntimeResult>("postgres_execute", {
          request: {
            connectionId: tab.connectionId,
            sql,
            maxRows: 1_000,
            runId,
          },
        }),
      );
      patchTab(tab.id, { result });
      addQueryHistory({
        sql,
        connectionId: tab.connectionId,
        connectionName: tabConnection?.name ?? tab.connectionId,
        providerId: "postgresql",
        success: true,
      });
    } catch (error) {
      const parsed = showQueryError(tab.id, error, "query");
      reportConnectionError(parsed.message);
      lastErrorRangeRef.current = sentRange ?? null;
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: parsed.message,
      });
      if (parsed.lineNumber != null) {
        const view = queryEditorViewRef.current;
        if (view) revealEditorLine(view, sentRange ?? null, parsed.lineNumber);
      }
      addQueryHistory({
        sql,
        connectionId: tab.connectionId,
        connectionName: tabConnection?.name ?? tab.connectionId,
        providerId: "postgresql",
        success: false,
      });
    } finally {
      setRunning(false);
      if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
    }
  };
  /** Normalizes a failed invocation into the tab's persistent error result and
   *  returns the parsed error (feature-design §2.4). `action` records the verb
   *  for the error-card title (P2-13). */
  const showQueryError = (
    targetTabId: string,
    raw: unknown,
    action: "query" | "explain" | "browse" = "query",
  ): ParsedDatabaseError => {
    const parsed = parseProviderError("postgres", String(raw));
    patchTab(targetTabId, { result: databaseErrorResult(parsed), errorAction: action });
    return parsed;
  };
  /** Loads column metadata (incl. primary-key flags) for a relation through
   *  the navigator's catalog command (feature-design §4.1). Empty on
   *  failure — callers degrade to `SELECT *`. */
  const loadRelationColumns = async (
    reference: PostgresRelationReference,
  ): Promise<readonly ColumnMetadata[]> => {
    try {
      const items = await invoke<PostgresCatalogColumnItem[]>("postgres_catalog_objects", {
        request: {
          connectionId: reference.connectionId,
          kind: "columns",
          schema: reference.schema,
          relation: reference.relation,
        },
      });
      return items.map((item) => ({
        name: item.name,
        dataType: item.dataType,
        nullable: item.nullable,
        default: item.default,
        isPrimaryKey: item.isPrimaryKey,
      }));
    } catch {
      return [];
    }
  };
  /** PG identifier quoting shared by the generated statements. */
  const postgresSqlOptions = (): SqlGenerationOptions => ({
    quoteIdentifier: (id: string) => `"${id.replace(/"/g, '""')}"`,
  });
  /** Quick action: run `SELECT COUNT(*)` against a relation and surface the
   *  result as a toast — zero-tab feedback for the most common "how many rows
   *  does this table have" question. Reuses the quick-execute error path. */
  const quickCountRows = async (reference: PostgresRelationReference) => {
    if (!connected) return;
    const sql = `SELECT COUNT(*) AS count FROM ${quoteQualifiedPostgresName(reference)};`;
    try {
      const result = await invoke<PostgresQueryRuntimeResult>("postgres_execute", {
        request: { connectionId: reference.connectionId, sql, maxRows: 1 },
      });
      const value = result.rows[0]?.[0];
      toast.success(t("toolbox.postgres.quickCountDone", { count: value ?? "0" }));
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), { description: String(error) });
    }
  };
  /** Quick action: open a query tab pre-filled with table statistics
   *  (estimated rows, on-disk + total size, dead tuples, last analyze) and
   *  execute it immediately — mirrors pgAdmin's "Statistics" tab using only
   *  catalog tables available to non-superusers. */
  const openTableStats = async (reference: PostgresRelationReference) => {
    if (!connected) return;
    const sql = [
      `SELECT c.relname AS table_name,`,
      `       c.reltuples::bigint AS estimated_rows,`,
      `       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,`,
      `       pg_size_pretty(pg_relation_size(c.oid)) AS table_size,`,
      `       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_size,`,
      `       n_dead_tup AS dead_tuples,`,
      `       last_analyze, last_autoanalyze`,
      `  FROM pg_catalog.pg_class c`,
      `  JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid`,
      ` WHERE c.oid = '${quoteLiteralText(`${reference.schema}.${reference.relation}`)}'::regclass;`,
    ].join("\n");
    const quickTab = { ...newQuery(reference.connectionId), title: t("toolbox.postgres.tableStats"), sql };
    openTab(quickTab);
    setRunning(true);
    try {
      const result = await invoke<PostgresQueryRuntimeResult>("postgres_execute", {
        request: { connectionId: reference.connectionId, sql, maxRows: 100 },
      });
      patchTab(quickTab.id, { result: adaptPostgresQueryResult(result), dirty: false });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), { description: String(error) });
    } finally {
      setRunning(false);
    }
  };
  /** Quick action (result grid): copy one committed row as a runnable INSERT
   *  statement. Column names come from the result header; values are escaped
   *  as PG string literals / NULL. Insert-staged rows are not offered this
   *  action (they have no committed values yet). */
  const copyRowAsInsert = async (
    row: readonly (string | null)[],
    result: DatabaseResult | null,
  ) => {
    const tableObject = tab.type === "table" ? tab.object : undefined;
    const qualifier = tableObject?.schema ?? "";
    const table = tableObject?.name;
    const columnNames = result?.kind === "tabular" ? result.columns.map((column) => column.label) : [];
    if (!table || columnNames.length === 0) {
      toast.error(t("toolbox.postgres.copyAsInsertUnavailable"));
      return;
    }
    await copyText(
      generateInsertValuesSql(qualifier, table, columnNames, row, postgresSqlOptions()),
    );
  };
  /** Appends generated SQL to the active query editor (selected + focused +
   *  dirty), or opens a fresh query tab when no editor is mounted
   *  (feature-design §4.2). The caret lands at the statement end and the
   *  inserted text gets a transient highlight — never a whole-document
   *  selection (P1-UX: typing must not replace the generated statement). */
  const insertGeneratedSql = (sql: string, connectionId?: string) => {
    const view = queryEditorViewRef.current;
    if (view) {
      const doc = view.state.doc;
      const insertAt = doc.length;
      const needsLeadingNewline =
        insertAt > 0 && doc.sliceString(insertAt - 1, insertAt) !== "\n";
      const insertText = (needsLeadingNewline ? "\n" : "") + sql + "\n";
      view.dispatch({ changes: { from: insertAt, to: insertAt, insert: insertText } });
      const end = insertAt + insertText.length;
      view.dispatch({ selection: { anchor: end, head: end } });
      const flashFrom = insertAt + (needsLeadingNewline ? 1 : 0);
      flashEditorRange(view, flashFrom, flashFrom + sql.length);
      view.focus();
      patchTab(tab.id, { dirty: true });
      return;
    }
    openTab({
      ...newQuery(connectionId ?? draft.id),
      sql,
      dirty: true,
    });
    requestAnimationFrame(() => {
      const nextView = queryEditorViewRef.current;
      if (!nextView) return;
      const end = nextView.state.doc.length;
      nextView.dispatch({ selection: { anchor: end, head: end } });
      flashEditorRange(nextView, 0, Math.min(sql.length, end));
      nextView.focus();
    });
  };
  /** Builds a generated statement for a relation and inserts it into the
   *  editor. INSERT/UPDATE need column metadata; when columns cannot be
   *  loaded the menu degrades to a `SELECT *` template (feature-design §4.1). */
  const generateRelationSql = async (
    reference: PostgresRelationReference,
    kind: "select" | "insert" | "update",
  ) => {
    const columns = await loadRelationColumns(reference);
    const options = postgresSqlOptions();
    let sql: string;
    if (kind === "select") {
      sql = generateSelectSql(
        reference.schema,
        reference.relation,
        columns.length ? columns : null,
        options,
      );
    } else if (columns.length === 0) {
      // Degradation rule: without column metadata, only a SELECT * template
      // is valid (feature-design §4.1).
      sql = generateSelectSql(reference.schema, reference.relation, null, options);
    } else if (kind === "insert") {
      sql = generateInsertSql(reference.schema, reference.relation, columns, options);
    } else {
      // Primary-key discovery rides on the column metadata (P0-1): PG reports
      // `isPrimaryKey` per column; empty list falls through to the
      // `WHERE 1=1 -- TODO` placeholder in generateUpdateSql (AC-F4.3/4.4).
      const primaryKeys = columns
        .filter((column) => column.isPrimaryKey)
        .map((column) => column.name);
      sql = generateUpdateSql(
        reference.schema,
        reference.relation,
        columns,
        primaryKeys,
        options,
      );
    }
    insertGeneratedSql(sql, reference.connectionId);
  };
  const generateDeleteSql = (reference: PostgresRelationReference): string =>
    `-- 全表删除：此语句将删除全部行，请添加 WHERE 条件\nDELETE FROM ${quoteQualifiedPostgresName(reference)};`;
  // ── Query-history cross-component events (feature-design §5.4) ────────────
  // The history view dispatches these; the provider check is authoritative and
  // the connection check keeps multi-connection sessions from cross-firing.
  const onHistoryExecute = useEffectEvent((event: Event) => {
    const detail = (event as CustomEvent<{ providerId?: string; sql?: string; connectionId?: string }>).detail;
    if (detail?.providerId !== "postgresql") return;
    const sql = detail?.sql?.trim();
    if (!sql || !tab) return;
    if (detail.connectionId && detail.connectionId !== tab.connectionId) return;
    patchTab(tab.id, { sql });
    void runSql(sql);
  });
  const onHistoryInsert = useEffectEvent((event: Event) => {
    const detail = (event as CustomEvent<{ providerId?: string; sql?: string }>).detail;
    if (detail?.providerId !== "postgresql") return;
    const sql = detail?.sql;
    if (!sql) return;
    insertGeneratedSql(sql);
  });
  useEffect(() => {
    const handleExecute = (event: Event) => onHistoryExecute(event);
    const handleInsert = (event: Event) => onHistoryInsert(event);
    window.addEventListener("nexterm:db-query-history-execute", handleExecute);
    window.addEventListener("nexterm:db-query-history-insert", handleInsert);
    return () => {
      window.removeEventListener("nexterm:db-query-history-execute", handleExecute);
      window.removeEventListener("nexterm:db-query-history-insert", handleInsert);
    };
  }, []);
  /** B21: open the read-only object viewer tab for a navigator object. */
  const openObjectViewer = (reference: PostgresObjectReference) => {
    const tab: WorkspaceTab = {
      id: `object:${reference.connectionId}:${reference.schema}.${reference.name}.${reference.objectKind}`,
      connectionId: reference.connectionId,
      type: "object",
      title: reference.name,
      objectReference: reference,
      sql: "",
      result: null,
    };
    openTab(tab);
  };

  /** B21: generate DDL for an object into a read-only query tab. */
  const generateObjectDdl = async (reference: PostgresObjectReference) => {
    try {
      const response = await invoke<{ ddl: string }>("postgres_object_ddl", {
        request: {
          connectionId: reference.connectionId,
          objectType: reference.objectKind,
          schema: reference.schema,
          name: reference.name,
          ...(reference.table ? { relation: reference.table } : {}),
          ...(reference.signature ? { signature: reference.signature } : {}),
        },
      });
      openTab({
        id: `ddl:${reference.connectionId}:${reference.schema}.${reference.name}.${reference.objectKind}`,
        connectionId: reference.connectionId,
        type: "query",
        title: `${reference.name}.ddl`,
        // Same formatting as the single-click DDL preview panel (Step 2);
        // raw catalog DDL (e.g. pg_get_viewdef) is otherwise single-line.
        sql: formatSql(response.ddl),
        result: null,
        dirty: false,
      });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: String(error),
      });
    }
  };
  /** Step 2: Load DDL for preview panel (single-click navigator relation). */
  const loadDdlPreview = async (schemaName: string, name: string, objectType: string) => {
    setDdlPreview({ schema: schemaName, name, objectType, ddl: "", loading: true, error: null });
    try {
      const response = await invoke<{ ddl: string }>("postgres_object_ddl", {
        request: {
          connectionId: draft.id,
          objectType,
          schema: schemaName,
          name,
        },
      });
      const formatted = formatSql(response.ddl);
      setDdlPreview({ schema: schemaName, name, objectType, ddl: formatted, loading: false, error: null });
    } catch (error) {
      setDdlPreview({ schema: schemaName, name, objectType, ddl: "", loading: false, error: String(error) });
    }
  };
  /** Step 2: Debounced DDL preview trigger from navigator onSelect. */
  const scheduleDdlPreview = (schemaName: string, name: string, objectType: string) => {
    if (ddlPreviewTimerRef.current) clearTimeout(ddlPreviewTimerRef.current);
    ddlPreviewTimerRef.current = setTimeout(() => {
      void loadDdlPreview(schemaName, name, objectType);
    }, 300);
  };

  /** Drop kind → localized menu label (B21 §5.3). */
  const dropLabel = (reference: PostgresObjectReference) => {
    switch (reference.objectKind) {
      case "table":
        return t("toolbox.postgres.dropTable");
      case "view":
        return t("toolbox.postgres.dropView");
      case "materializedView":
        return t("toolbox.postgres.dropMaterializedView");
      case "function":
        return t("toolbox.postgres.dropFunction");
      case "sequence":
        return t("toolbox.postgres.dropSequence");
      case "index":
        return t("toolbox.postgres.dropIndex");
      case "constraint":
        return t("toolbox.postgres.dropConstraint");
      case "trigger":
        return t("toolbox.postgres.dropTrigger");
      default:
        return t("toolbox.postgres.dropObject");
    }
  };

  const quoteQualified = (schema: string, name: string) =>
    `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;

  /** B21: dry-run the drop (existence + dependents) then open the dialog. */
  const requestObjectDrop = async (reference: PostgresObjectReference) => {
    try {
      const preview = await invoke<{
        objectExists: boolean;
        dependentCount: number | null;
        sampleDependents: string[];
      }>("postgres_drop_object", {
        request: {
          connectionId: reference.connectionId,
          kind: reference.objectKind,
          schema: reference.schema,
          name: reference.name,
          ...(reference.table ? { relation: reference.table } : {}),
          ...(reference.signature ? { signature: reference.signature } : {}),
          cascade: false,
          confirmed: false,
        },
      });
      setObjectDropPreview(preview);
      setObjectDropTarget({
        reference,
        kind: reference.objectKind,
        qualified: quoteQualified(reference.schema, reference.name),
      });
    } catch (error) {
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: String(error),
      });
    }
  };

  /** B21: confirm and execute the destructive drop. */
  const confirmObjectDrop = async () => {
    if (!objectDropTarget) return;
    const target = objectDropTarget;
    setObjectDropTarget(null);
    setObjectDropPreview(null);
    try {
    await invoke("postgres_drop_object", {
      request: {
          connectionId: target.reference.connectionId,
          kind: target.reference.objectKind,
          schema: target.reference.schema,
          name: target.reference.name,
          ...(target.reference.table
            ? { relation: target.reference.table }
            : {}),
          ...(target.reference.signature
            ? { signature: target.reference.signature }
            : {}),
          cascade: false,
          confirmed: true,
        },
      });
      toast.success(t("toolbox.postgres.dropSucceeded"));
      // Refresh the expanded navigator subtree so the object disappears.
      void refreshNavigator();
      // Close any object viewer tab bound to the dropped object.
      setTabs((current) =>
        current.filter((item) => {
          if (item.type !== "object" || !item.objectReference) return true;
          const ref = item.objectReference;
          return !(
            ref.schema === target.reference.schema &&
            ref.name === target.reference.name &&
            ref.objectKind === target.reference.objectKind
          );
        }),
      );
    } catch (error) {
      toast.error(t("toolbox.postgres.dropFailed"), {
        description: String(error),
      });
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
    const id = `table:${reference.connectionId}:${object.schema}.${object.name}`;
    openTab({
      id,
      connectionId: reference.connectionId,
      type: "table",
      title: object.name,
      object,
      objectRole: reference.objectRole,
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
      // Table browsing has no editor statement to reveal — the error still
      // persists in the table tab's result pane for copy/retry.
      const parsed = showQueryError(id, error, "browse");
      reportConnectionError(parsed.message);
      lastErrorRangeRef.current = null;
      toast.error(t("toolbox.postgres.queryFailed"), {
        description: parsed.message,
      });
    } finally {
      setRunning(false);
    }
  };
  const tableReference = (): PostgresRelationReference | null =>
    tab?.type === "table" && tab.object
      ? {
          connectionId: tab.connectionId,
          database: tabPostgresConfig?.database ?? "",
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
    valueEmptyWarning: t("toolbox.postgres.filterValueEmptyWarning"),
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
  const completeDisconnect = async (connectionId: string) => {
    await invoke("postgres_disconnect", { connectionId });
    setTabs((current) => {
      const next = current.filter((item) => item.connectionId !== connectionId);
      setActiveTab(next.at(-1)?.id ?? "");
      return next.length ? next : [newQuery("")];
    });
    setConnected(false);
    setTransactionActive(false);
    // Manual disconnect is intentional, not a failure — drop the L3 banner.
    setConnectionError(null);
  };
  const disconnect = () => {
    const dirtyTabs = tabs.filter((item) => item.connectionId === draft.id && item.dirty);
    if (dirtyTabs.length) {
      setDisconnectTarget(draft.id);
      return;
    }
    void completeDisconnect(draft.id);
  };
  const createQuery = () => openTab(newQuery(draft.id));
  const copyText = async (value: string) => {
    try {
      await writeClipboardText(value);
    } catch (error) {
      toast.error(t("toolbox.postgres.copyFailed"), { description: String(error) });
    }
  };
  /** Runs a CodeMirror command on the query editor (undo/redo/selectAll…):
   *  focus first so the command operates on the visible editor. */
  const runCmCommand = (cmd: (view: EditorView) => boolean) => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    view.focus();
    cmd(view);
  };
  /** Cut: write the selected text to the clipboard, then delete it. */
  const cutEditorSelection = async () => {
    const view = queryEditorViewRef.current;
    if (!view) return;
    view.focus();
    const selection = view.state.selection.main;
    if (selection.to <= selection.from) return;
    try {
      await writeClipboardText(view.state.doc.sliceString(selection.from, selection.to));
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: "" } });
    } catch (error) {
      toast.error(t("toolbox.postgres.copyFailed"), { description: String(error) });
    }
  };
  /** Paste: insert clipboard text at the caret, replacing the selection. */
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
  const exportExcel = async () => {
    if (tab?.result?.kind !== "tabular") return;
    try {
      const XLSX = await import("xlsx");
      const header = tab.result.columns.map((column) => column.label);
      const rows = tab.result.rows.map((row) => row.map((cell) => cell ?? null));
      const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, tab.title || "Result");
      const path = await saveFile({
        defaultPath: `${tab.title || "postgres-result"}.xlsx`,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!path) return;
      await writeBinaryFile(
        path,
        new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
      );
      toast.success(t("toolbox.postgres.exportedExcel"));
    } catch (error) {
      toast.error(t("toolbox.postgres.exportFailedExcel"), { description: String(error) });
    }
  };
  const transaction = async (action: "begin" | "commit" | "rollback") => {
    if (!tab) return;
    try {
      await invoke("postgres_transaction", {
        request: { connectionId: tab.connectionId, action },
      });
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
    // B19 (M2 form B): assemble every row change as an ordered step list and
    // commit them in ONE `postgres_save_table_changes` call. The backend
    // owns BEGIN..COMMIT inside a single command, so no IPC interleaving can
    // poison the transaction; it also validates affected-row counts (M3) and
    // actively ROLLBACKs on any failure (M4).
    const steps: Array<{
      kind: "update" | "insert" | "delete";
      keyValues: Record<string, string>;
      changes: Record<string, string | null>;
      values: Record<string, string | null>;
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
      steps.push({ kind: "update", keyValues, changes, values: {} });
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
      steps.push({ kind: "delete", keyValues, changes: {}, values: {} });
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
      steps.push({ kind: "insert", keyValues: {}, changes: {}, values });
      committedInserts.push(
        columns.map((column, columnIndex) =>
          insert.edited.includes(columnIndex) ? insert.values[columnIndex] : null,
        ),
      );
    }
    if (!steps.length) return;
    setSaving(true);
    try {
      const result = await invoke<{
        insertPrimaryKeys: Array<Record<string, string>>;
        affectedRows: number[];
      }>("postgres_save_table_changes", {
        request: {
          connectionId: tab.connectionId,
          schema: tab.object.schema,
          table: tab.object.name,
          steps,
        },
      });
      // Back-fill generated primary keys into the committed insert rows.
      // The backend returns them keyed by server column name (e.g. "id"),
      // which is what `column.label` holds; `column.key` is the ordinal slot.
      let insertIndex = 0;
      const backfilled: DatabaseResultRow[] = committedInserts.map((row) => {
        const pkMap = result.insertPrimaryKeys[insertIndex] ?? {};
        insertIndex += 1;
        return columns.map((column, columnIndex) =>
          row[columnIndex] !== null ? row[columnIndex] : (pkMap[column.label] ?? null),
        );
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
          ...backfilled,
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
      // M4 is handled server-side (active ROLLBACK inside the command); the
      // frontend must NOT swallow a failed rollback — the error is surfaced.
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
  // ── Keyboard: database shortcut hook (feature-design §1.2) ────────────────
  // Modal dialogs short-circuit all DB commands (the dialog keeps the keyboard).
  const dialogOpen =
    configOpen ||
    managerOpen ||
    pendingSshTrust !== null ||
    filterDialog !== null ||
    layoutDialog !== null ||
    noteDialog !== null ||
    closeTarget !== null ||
    disconnectTarget !== null ||
    deleteTarget !== null ||
    deleteConnectionTarget !== null ||
    objectDropTarget !== null;
  useDatabaseKeyboardShortcuts({
    testId: "postgres-workspace",
    dialogOpen,
    handlers: {
      "database.query.execute": () => {
        // Ctrl+Enter / Ctrl+E / Ctrl+Shift+R all land here (the router
        // matches by command id, so the combo itself is not distinguishable).
        // Ctrl+Enter/Ctrl+E previously ran the selection-or-statement; that
        // superset also covers the old Ctrl+Shift+R "current statement" case
        // (a caret with no selection behaves identically).
        if (tab?.type === "query" && !running) runSelectionOrStatement();
      },
      "database.query.runSelection": () => {
        if (tab?.type === "query" && !running) runSelectionOrStatement();
      },
      "database.query.explain": () => {
        if (tab?.type === "query" && !running) void execute(true);
      },
      "database.query.toggleComment": () => {
        if (tab?.type === "query") toggleSqlComment();
      },
      "database.query.stop": () => {
        // Preserve the old running-only condition (:2147-2151).
        if (running) void stopQuery();
      },
      "database.query.format": () => {
        if (tab?.type === "query") formatSqlInEditor();
      },
      "database.query.save": () => {
        // P1-UX: Ctrl+S in the editor saves the current SQL (menu label was
        // misleading — the combo previously fell through to the grid's
        // data.saveChanges, a no-op for query tabs).
        if (tab?.type === "query") saveCurrentSql();
      },
      "database.workspace.newQuery": () => {
        if (connected) createQuery();
      },
      "database.tab.close": () => {
        requestCloseTab(activeTab);
      },
      "database.object.refresh": () => {
        void refreshNavigator();
      },
      "database.connection.refresh": () => {
        void refreshNavigator();
      },
      "database.data.filterSort": () => {
        // Ctrl+R: on a table grid it opens Filter & Sort; on a query tab it
        // keeps the previous refresh-navigator behaviour (old :2187-2202).
        if (tab?.type === "table") setFilterDialog({ mode: "filterSort" });
        else if (connected) void refreshNavigator();
      },
      "database.data.refresh": () => {
        if (!connected) return;
        if (tab?.type === "table" && tab.object) {
          const reference = tableReference();
          if (!reference) return;
          const decision = resolveFilterShortcut(tab.activeFilter);
          if (decision.kind === "replay") void browse(reference, 0, decision.filter);
          else void browse(reference, tableOffset);
        } else {
          void refreshNavigator();
        }
      },
      "database.data.addRecord": () => {
        if (
          tab?.type === "table" &&
          !postgresConfig.readOnly &&
          tab.result?.kind === "tabular" &&
          tab.result.editability.editable
        ) {
          addRecord();
        }
      },
      "database.data.saveChanges": () => {
        if (tab?.type === "table" && tab.dirty && !saving) void saveTableChanges();
      },
      "database.data.clearFilter": () => {
        // Two-in-one (feature-design §1.2): close find when open, else clear
        // the active filter. The router consumes Escape inside the grid even
        // when no filter exists — a no-op here keeps other behaviour intact.
        if (tab?.type !== "table") return;
        if (findState.open) closeFind();
        else if (tab.activeFilter) clearFilter();
      },
    },
  });
  // Find-bar domain (F3 / Ctrl+F / Escape-close) is NOT a command-registry
  // command, so the hook leaves it alone (feature-design §1.2 note). It stays
  // as a local listener next to the hook.
  const onFindKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typingInField = Boolean(
      target?.closest?.("input, textarea, select, [contenteditable='true']"),
    );
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
    // Escape while find is open (the hook only consumes Escape in the grid
    // body; from the find input or other focus it reaches this listener).
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
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "f" &&
      tab?.type === "table" &&
      !typingInField
    ) {
      event.preventDefault();
      setFindState((state) => ({ ...state, open: true, current: 0 }));
    }
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onFindKeyDown(event);
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
            const next = newConnection();
            setDraft(next);
            setSelectedId(null);
            // The placeholder query tab still points at the previous draft id;
            // move it onto the profile being created so the first query after
            // connecting targets the right connection.
            rebindUntouchedQueryTabs(next.id);
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
        {tab?.type === "table" && (
          <>
            <ToolButton
              icon={<Filter />}
              label={
                tab.activeFilter
                  ? t("toolbox.postgres.filterActive", {
                      count: tab.activeFilter.conditions.length,
                    })
                  : t("toolbox.postgres.filterSort")
              }
              onClick={() => setFilterDialog({ mode: "filterSort" })}
              data-testid="postgres-filter"
            />
            {tab.activeFilter && (
              <ToolButton
                icon={<X />}
                label={t("toolbox.postgres.clearFilter")}
                onClick={clearFilter}
                data-testid="postgres-clear-filter"
              />
            )}
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
              onRetryLoad={(node) => {
                // Re-run the failed subtree load (P2-9): force a reload even
                // when a (failed) entry already exists in childrenByParent.
                void loadNavigatorChildren(
                  node,
                  postgresNavigatorLabels(t),
                  setNavigatorChildren,
                  setNavigatorLoadStates,
                );
              }}
              retryLabel={t("toolbox.postgres.retry")}
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
                // DDL preview now opens on DOUBLE-click (onOpen → browse),
                // rendered in the right-hand panel — not on single-click.
                if (!relation) {
                  setDdlPreview(null);
                }
              }}
              onOpen={(node) => {
                // Double-click/Enter on a saved connection opens it (B22).
                if (node.kind === "connection") {
                  const connection = navigatorConnections.find(
                    (item) => item.id === node.reference.path[0],
                  );
                  if (connection && connection.id !== draft.id) {
                    setDraft(connection);
                    setSelectedId(connection.id);
                    setConnected(false);
                  }
                  if (connection) void connectEstablished(connection);
                  return;
                }
                const relation = getPostgresRelationReference(node);
                if (relation) {
                  void browse(relation);
                  // Double-click on a table/view/materializedView opens the
                  // data grid AND shows its formatted DDL in the right panel.
                  if (connected) {
                    const kind = relation.objectRole ?? "table";
                    scheduleDdlPreview(relation.schema, relation.relation, kind);
                  }
                  return;
                }
                const objectReference = getPostgresObjectReference(node);
                if (objectReference) {
                  // Column double-click opens its owning table (D-B21-2).
                  if (objectReference.objectKind === "column") {
                    void browse({
                      connectionId: objectReference.connectionId,
                      database: objectReference.database,
                      schema: objectReference.schema,
                      relation: objectReference.table ?? "",
                    });
                    return;
                  }
                  openObjectViewer(objectReference);
                }
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
                  const connection = connections.find((item) => item.id === connectionId);
                  const reconnect = () => {
                    if (!connection) return;
                    void connectEstablished(connection);
                  };
                  return <>
                    {connected ? <ContextMenuItem disabled={!enabled("database.connection.disconnect")} onSelect={() => void disconnect()}><Unplug className="h-3.5 w-3.5" />{t("toolbox.postgres.disconnect")}</ContextMenuItem> : <ContextMenuItem onSelect={reconnect}><RefreshCw className="h-3.5 w-3.5" />{t("common.reconnect")}</ContextMenuItem>}
                    <ContextMenuItem disabled={!connected} onSelect={createQuery}><FilePlus2 className="h-3.5 w-3.5" />{t("toolbox.postgres.newQuery")}<ContextMenuShortcut>{formatShortcut("Ctrl+N")}</ContextMenuShortcut></ContextMenuItem>
                    <ContextMenuItem disabled={!connected} onSelect={() => void refreshNavigator()}><RefreshCw className="h-3.5 w-3.5" />{t("toolbox.postgres.refresh")}<ContextMenuShortcut>{formatShortcut("F5")}</ContextMenuShortcut></ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setManagerOpen(true)}><Server className="h-3.5 w-3.5" />{t("toolbox.postgres.connectionManager.menuItem")}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => {
                      if (connection) setDraft(connection);
                      setConfigOpen(true);
                    }}><Pencil className="h-3.5 w-3.5" />{t("common.edit")}</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => setDeleteConnectionTarget(connectionId)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("common.delete")}
                    </ContextMenuItem>
                  </>;
                }
                const objectReference = getPostgresObjectReference(node);
                // Relation (table/view/materializedView) objects reuse the
                // object commands for DDL/drop; open/browse stays the grid.
                const relationAsObject: PostgresObjectReference | null = relation
                  ? {
                      connectionId: relation.connectionId,
                      database: relation.database,
                      schema: relation.schema,
                      objectKind: relation.objectRole ?? "table",
                      name: relation.relation,
                    }
                  : null;
                const activeReference = objectReference ?? relationAsObject;
                const copyValue = () => {
                  if (relation) return quoteQualifiedPostgresName(relation);
                  if (!objectReference) return node.label;
                  const quote = (value: string) =>
                    `"${value.replace(/"/g, '""')}"`;
                  switch (objectReference.objectKind) {
                    case "function":
                      return objectReference.fullSignature
                        ? `${quote(objectReference.schema)}.${quote(objectReference.name)}(${objectReference.signature ?? ""})`
                        : `${quote(objectReference.schema)}.${quote(objectReference.name)}()`;
                    case "column":
                      return objectReference.table
                        ? `${quote(objectReference.schema)}.${quote(objectReference.table)}.${quote(objectReference.name)}`
                        : `${quote(objectReference.schema)}.${quote(objectReference.name)}`;
                    default:
                      return `${quote(objectReference.schema)}.${quote(objectReference.name)}`;
                  }
                };
                const canDrop = connected && !postgresConfig.readOnly;
                return <>
                  {relation && <ContextMenuItem disabled={!enabled("database.object.open")} onSelect={() => void browse(relation)}><Table2 className="h-3.5 w-3.5" />{t("toolbox.postgres.openDataAction")}<ContextMenuShortcut>{formatShortcut("Enter")}</ContextMenuShortcut></ContextMenuItem>}
                  {relation && relation.objectRole === "table" && <ContextMenuItem disabled={!connected} onSelect={() => openDesigner(relation.schema, relation.relation)}><PencilRuler className="h-3.5 w-3.5" />{t("toolbox.postgres.designTable")}</ContextMenuItem>}
                  {relation && relation.objectRole === "view" && <ContextMenuItem disabled={!connected} onSelect={() => void openViewDesigner(relation.schema, relation.relation)}><PencilRuler className="h-3.5 w-3.5" />{t("toolbox.postgres.designView")}</ContextMenuItem>}
                  {relation && relation.objectRole === "materializedView" && <ContextMenuItem disabled title={t("toolbox.postgres.materializedViewReadonly")}><PencilRuler className="h-3.5 w-3.5" />{t("toolbox.postgres.designView")}</ContextMenuItem>}
                  {relation && (
                    <>
                      <ContextMenuItem
                        disabled={!connected}
                        onSelect={() => void quickCountRows(relation)}
                        data-testid="navigator-quick-count"
                      >
                        <Hash className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.quickCountRows")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!connected}
                        onSelect={() => void openTableStats(relation)}
                        data-testid="navigator-table-stats"
                      >
                        <LineChart className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.tableStats")}
                      </ContextMenuItem>
                    </>
                  )}
                  {relation && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger
                        data-testid="navigator-generate-sql"
                        disabled={!connected}
                      >
                        <Braces className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.generateSql")}
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        <ContextMenuItem
                          disabled={!connected}
                          onSelect={() => void generateRelationSql(relation, "select")}
                          data-testid="navigator-generate-select"
                        >
                          {t("toolbox.postgres.generateSelect")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!connected || relation.objectRole !== "table"}
                          onSelect={() => void generateRelationSql(relation, "insert")}
                          data-testid="navigator-generate-insert"
                        >
                          {t("toolbox.postgres.generateInsert")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!connected || relation.objectRole !== "table"}
                          onSelect={() => void generateRelationSql(relation, "update")}
                          data-testid="navigator-generate-update"
                        >
                          {t("toolbox.postgres.generateUpdate")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          disabled={!connected}
                          onSelect={() =>
                            insertGeneratedSql(generateDeleteSql(relation), relation.connectionId)
                          }
                          data-testid="navigator-generate-delete"
                        >
                          {t("toolbox.postgres.generateDelete")}
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                  {objectReference?.objectKind === "function" && <ContextMenuItem disabled={!connected} onSelect={() => openObjectViewer(objectReference)}><Eye className="h-3.5 w-3.5" />{t("toolbox.postgres.openFunction")}</ContextMenuItem>}
                  {(objectReference?.objectKind === "sequence" ||
                    objectReference?.objectKind === "index" ||
                    objectReference?.objectKind === "constraint" ||
                    objectReference?.objectKind === "trigger") && <ContextMenuItem disabled={!connected} onSelect={() => objectReference && openObjectViewer(objectReference)}><Eye className="h-3.5 w-3.5" />{t("toolbox.postgres.openObject")}</ContextMenuItem>}
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={!connected} onSelect={() => void copyText(copyValue())}><Copy className="h-3.5 w-3.5" />{objectReference?.objectKind === "column" ? t("toolbox.postgres.copyColumnName") : t("toolbox.postgres.copyName")}</ContextMenuItem>
                  {objectReference?.objectKind === "column" && typeof node.metadata?.dataType === "string" && (
                    <ContextMenuItem
                      disabled={!connected}
                      onSelect={() =>
                        void copyText(
                          `ALTER TABLE ${quoteQualifiedPostgresName({
                            connectionId: objectReference.connectionId,
                            database: objectReference.database,
                            schema: objectReference.schema,
                            relation: objectReference.table ?? "",
                          })} ADD COLUMN "${objectReference.name.replace(/"/g, '""')}" ${node.metadata?.dataType};`,
                        )
                      }
                      data-testid="navigator-copy-column-definition"
                    ><FileCode className="h-3.5 w-3.5" />{t("toolbox.postgres.copyColumnDefinition")}</ContextMenuItem>
                  )}
                  {activeReference && activeReference.objectKind !== "constraint" && (
                    <ContextMenuItem disabled={!connected} onSelect={() => activeReference && void generateObjectDdl(activeReference)}><FileCode className="h-3.5 w-3.5" />{t("toolbox.postgres.generateDdl")}</ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={!connected} onSelect={() => void refreshNavigator()}><RefreshCw className="h-3.5 w-3.5" />{t("toolbox.postgres.refresh")}<ContextMenuShortcut>{formatShortcut("F5")}</ContextMenuShortcut></ContextMenuItem>
                  {!activeReference && <ContextMenuItem disabled={!connected} onSelect={createQuery}><FilePlus2 className="h-3.5 w-3.5" />{t("toolbox.postgres.newQuery")}<ContextMenuShortcut>{formatShortcut("Ctrl+N")}</ContextMenuShortcut></ContextMenuItem>}
                  {node.kind === "group" && node.reference.path.at(-1) === "tables" && (
                      <ContextMenuItem
                        disabled={!connected}
                        onSelect={() => {
                          const schemaName = node.reference.path[2] ?? "public";
                          openDesigner(schemaName, "", true);
                        }}
                        data-testid="navigator-new-table"
                      ><Table2 className="h-3.5 w-3.5" />{t("toolbox.postgres.newTable")}</ContextMenuItem>
                    )}
                  {activeReference && activeReference.objectKind !== "column" && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        disabled={!canDrop}
                        onSelect={() => activeReference && void requestObjectDrop(activeReference)}
                      ><Trash2 className="h-3.5 w-3.5" />{dropLabel(activeReference)}</ContextMenuItem>
                    </>
                  )}
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
            <section className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/10 px-2">
                <span
                  className="max-w-48 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  data-testid="postgres-tab-connection"
                  title={tabConnection?.name ?? tab.connectionId}
                >
                  {tabConnection?.name ?? tab.connectionId}
                </span>
                {tab.type === "query" && (
                <ToolButton
                  icon={<Play />}
                  label={t("toolbox.postgres.run")}
                  disabled={executeCommand.state !== "enabled" || running}
                  onClick={() => void execute()}
                  data-testid="postgres-run"
                />
                )}
                {tab.type === "query" && (
                  <ToolButton
                    icon={<Save />}
                    label={t("toolbox.postgres.saveSql")}
                    disabled={!tab.sql.trim()}
                    onClick={saveCurrentSql}
                    data-testid="postgres-save-sql"
                  />
                )}
                {tab.type === "query" && (
                  <ToolButton
                    icon={<FileCode2 />}
                    label={t("toolbox.postgres.saveToNotes")}
                    disabled={!tab.sql.trim()}
                    onClick={() => appendSqlToNotes()}
                    data-testid="postgres-save-to-notes"
                  />
                )}
                {tab.type === "query" && (
                  <ToolButton
                    icon={<History />}
                    label={t("toolbox.postgres.history.title")}
                    disabled={!connected}
                    onClick={() => setHistoryOpen((open) => !open)}
                    data-testid="postgres-history"
                  />
                )}
                 {tab.type === "query" && running && (
                  <ToolButton
                    icon={<Square />}
                    label={t("toolbox.postgres.stop")}
                    onClick={() => void stopQuery()}
                    data-testid="postgres-stop"
                  />
                 )}
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
                 {tab.type === "query" && (
                   <ToolButton
                     icon={<Wand2 />}
                     label={t("toolbox.postgres.formatSql")}
                     disabled={!connected}
                     onClick={() => formatSqlInEditor()}
                     data-testid="postgres-format-sql"
                   />
                 )}
                 {tab.type === "table" && (
                   <>
                     <span className="ml-1 text-[11px] text-muted-foreground">{tab.object?.schema}.{tab.object?.name}</span>
                     <ToolButton icon={<RefreshCw />} label={t("toolbox.postgres.refresh")} disabled={running} onClick={() => tab.object && void browse({ connectionId: tab.connectionId, database: tabPostgresConfig?.database ?? "", schema: tab.object.schema, relation: tab.object.name }, tableOffset)} />
                     <ToolButton icon={<Database />} label={t("toolbox.postgres.saveChanges")} disabled={!tab.dirty || saving || running || tabPostgresConfig?.readOnly} onClick={() => void saveTableChanges()} />
                     <ToolButton icon={<RefreshCw />} label={t("toolbox.postgres.revertChanges")} disabled={!tab.dirty || running} onClick={revertTableChanges} />
                   </>
                )}
                <div className="flex-1" />
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              </div>
              {tab.type === "query" && (
                <div className="min-h-0 flex-1">
                  <ContextMenu
                    onOpenChange={(open) => {
                      if (open) setEditorMenuSource(editorMenuSourceKind());
                    }}
                  >
                    <ContextMenuTrigger asChild>
                      <div className="h-full">
                        <CodeEditor
                          value={tab.sql}
                          onChange={(sql) => patchTab(tab.id, { sql, dirty: true })}
                          language="sql"
                          queryContext={
                            tabConnection
                              ? createPostgresQueryEditorContext({
                                  connectionId: tab.connectionId,
                                  catalog: tabPostgresConfig?.database ?? "",
                                  schema: schema ?? undefined,
                                  lookup: async (request) =>
                                    invoke("postgres_catalog_search", {
                                      request: { connectionId: tab.connectionId, ...request },
                                    }),
                                })
                              : undefined
                          }                                              editorRef={(view) => {
                            queryEditorViewRef.current = view;
                            // Track selection presence for cut/copy menu
                            // enablement (ux-spec §1.1.4 / P2-2.5).
                            if (view) {
                              const sync = (v: typeof view) => {
                                const sel = v.state.selection.main;
                                setEditorHasSelection(sel.to > sel.from);
                              };
                              sync(view);
                              const listener = EditorViewImpl.updateListener.of(
                                (update) => {
                                  if (update.selectionSet) sync(update.view);
                                },
                              );
                              view.dispatch({
                                effects: StateEffect.appendConfig.of(listener),
                              });
                            } else {
                              setEditorHasSelection(false);
                            }
                          }}
                          className="h-full"
                        />
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {/* Edit group */}
                      <ContextMenuItem
                        onSelect={() => runCmCommand(undo)}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        {t("common.undo")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+Z")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => runCmCommand(redo)}
                      >
                        <Redo2 className="h-3.5 w-3.5" />
                        {t("common.redo")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+Z")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        disabled={!editorHasSelection}
                        onSelect={() => void cutEditorSelection()}
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        {t("common.cut")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+X")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!editorHasSelection}
                        onSelect={() => void copyText(editorCopyValue())}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        {t("common.copy")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+C")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => void pasteIntoEditor()}
                      >
                        <ClipboardPaste className="h-3.5 w-3.5" />
                        {t("common.paste")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+V")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => runCmCommand(selectAll)}
                      >
                        <ListChecks className="h-3.5 w-3.5" />
                        {t("common.selectAll")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+A")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {/* SQL group */}
                      <ContextMenuItem
                        data-testid="postgres-editor-execute"
                        disabled={!connected || !tab.sql.trim()}
                        onSelect={() => void execute()}
                      >
                        <Play className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.run")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+Enter")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="postgres-editor-run-selection"
                        disabled={!connected}
                        onSelect={() => runSelectionOrStatement()}
                      >
                        <ListPlus className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.runSelection")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+Enter")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="postgres-editor-explain"
                        disabled={!connected || !tab.sql.trim()}
                        onSelect={() => void execute(true)}
                      >
                        <LineChart className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.explain")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+E")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="postgres-editor-format-sql"
                        disabled={!connected}
                        onSelect={formatSqlInEditor}
                      >
                        <Wand2 className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.formatSql")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+Shift+F")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="postgres-editor-toggle-comment"
                        disabled={!connected}
                        onSelect={toggleSqlComment}
                      >
                        <Hash className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.toggleComment")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+/")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {/* Save group */}
                      <ContextMenuItem
                        data-testid="postgres-editor-save-to-notes"
                        disabled={!tab.sql.trim()}
                        onSelect={openSaveToNotesFromEditorMenu}
                      >
                        <FileCode2 className="h-3.5 w-3.5" />
                        <span className="flex flex-col">
                          <span>{t("toolbox.postgres.saveToNotes")}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {editorMenuSource === "selection"
                              ? t("toolbox.postgres.saveToNotesSourceSelection", {
                                  count: countEditorSelectionLines(),
                                })
                              : editorMenuSource === "statement"
                                ? t("toolbox.postgres.saveToNotesSourceStatement")
                                : t("toolbox.postgres.saveToNotesSourceDocument")}
                          </span>
                        </span>
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="postgres-editor-save-sql"
                        disabled={!tab.sql.trim()}
                        onSelect={saveCurrentSql}
                      >
                        <Save className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.saveSql")}
                        <ContextMenuShortcut>{formatShortcut("Ctrl+S")}</ContextMenuShortcut>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              )}
              {tab.type === "object" && tab.objectReference && (
                <ObjectViewerTab
                  tab={
                    {
                      id: tab.id,
                      type: "object",
                      title: tab.title,
                      object: tab.objectReference,
                      connectionId: tab.connectionId,
                    } satisfies ObjectViewerTabState
                  }
                />
              )}
              {tab.type === "designer" && tab.objectRole === "table" && tab.object && (
                <div className="min-h-0 flex-1" data-scope="designer" data-testid="table-designer-root">
                  <TableDesignerTab
                    connectionId={tab.connectionId}
                    schema={tab.object.schema}
                    table={tab.object.name}
                    createMode={tab.createMode}
                    onLoad={async (connId: string, schema: string, table: string) =>
                      invoke<TableDesign>("postgres_table_design_load", {
                        request: { connectionId: connId, schema, table },
                      })
                    }
                    onApply={async (connId: string, change: TableDesignChange, confirmed: boolean) =>
                      invoke<{ ddl: string; warnings: string[]; applied: boolean }>(
                        "postgres_table_design_apply",
                        { request: { connectionId: connId, change, confirmed } },
                      )
                    }
                    onCreated={(createdTable: string) => {
                      setTabs((current) =>
                        current.map((item) =>
                          item.id === tab.id
                            ? {
                                ...item,
                                title: `${createdTable} (Design)`,
                                object: { schema: tab.object!.schema, name: createdTable },
                                createMode: false,
                              }
                            : item,
                        ),
                      );
                    }}
                    onRefresh={() => void refreshNavigator()}
                    readOnly={tabPostgresConfig?.readOnly ?? true}
                  />
                </div>
              )}
              {tab.type === "designer" && tab.objectRole === "view" && tab.object && (
                <div className="flex min-h-0 flex-1 flex-col" data-scope="designer" data-testid="view-designer-root">
                  <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/10 px-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("toolbox.postgres.viewDefinition")}: {tab.object.schema}.{tab.object.name}
                    </span>
                    <div className="flex-1" />
                    <ToolButton
                      icon={<Save />}
                      label={t("toolbox.postgres.viewSave")}
                      disabled={!connected || postgresConfig.readOnly}
                      onClick={async () => {
                        if (!tab.object || !tab.sql.trim()) return;
                        try {
                          await invoke("postgres_view_save", {
                            request: {
                              connectionId: tab.connectionId,
                              schema: tab.object.schema,
                              name: tab.object.name,
                              definition: tab.sql,
                              confirmed: true,
                            },
                          });
                          toast.success(t("toolbox.postgres.viewSaved"));
                          patchTab(tab.id, { dirty: false });
                        } catch (error) {
                          toast.error(t("toolbox.postgres.viewSaveFailed"), {
                            description: String(error),
                          });
                        }
                      }}
                    />
                  </div>
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      value={tab.sql}
                      onChange={(sql) => patchTab(tab.id, { sql, dirty: true })}
                      language="sql"
                      className="h-full"
                    />
                  </div>
                </div>
              )}
              {tab.type !== "object" && tab.type !== "designer" && <>
              {tab.type === "query" && (
              <div
                className="h-1 shrink-0 cursor-row-resize border-y bg-muted/50"
                onPointerDown={() => setResultDragging(true)}
              />
              )}
              {tab.type === "query" && historyOpen ? (
                <div
                  className="shrink-0 overflow-auto border-t"
                  style={{ height: resultHeight }}
                  data-testid="postgres-history-panel"
                >
                  <QueryHistoryView
                    open
                    onOpenChange={setHistoryOpen}
                    providerId="postgresql"
                    connectionId={tab.connectionId}
                    labels={{
                      history: t("toolbox.postgres.history.title"),
                      empty: t("toolbox.postgres.history.empty"),
                      emptyHint: t("toolbox.postgres.history.emptyHint"),
                      run: t("toolbox.postgres.history.run"),
                      insertToEditor: t("toolbox.postgres.history.insertToEditor"),
                      copy: t("toolbox.postgres.history.copy"),
                      remove: t("toolbox.postgres.history.remove"),
                      clear: t("toolbox.postgres.history.clear"),
                      time: t("toolbox.postgres.history.time"),
                      error: t("toolbox.postgres.history.error"),
                      clearConfirmTitle: t("toolbox.postgres.history.clearConfirmTitle"),
                      clearConfirmDescription: t("toolbox.postgres.history.clearConfirmDescription"),
                      cancel: t("common.cancel"),
                    }}
                  />
                </div>
              ) : (
              <DatabaseResultPane
                result={tab.result}
                height={resultHeight}
                fillHeight={tab.type === "table"}
                paged={tab.type === "table"}
                onPrevious={() =>
                  tab.object &&
                  void browse(
                    {
                      connectionId: tab.connectionId,
                      database: tabPostgresConfig?.database ?? "",
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
                      connectionId: tab.connectionId,
                      database: tabPostgresConfig?.database ?? "",
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
                        <ContextMenuItem onSelect={() => void copyText(cell ?? "NULL")}><Copy className="h-3.5 w-3.5" />{t("toolbox.postgres.copyCell")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyText(row.map((value) => value ?? "NULL").join("\t"))}><CopyCheck className="h-3.5 w-3.5" />{t("toolbox.postgres.copyRow")}</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => removeInsertRow(rowIndex)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("toolbox.postgres.removeRecord")}
                        </ContextMenuItem>
                      </>
                    ) : (
                      <>
                        <ContextMenuItem onSelect={() => void copyText(cell ?? "NULL")}><Copy className="h-3.5 w-3.5" />{t("toolbox.postgres.copyCell")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyText(row.map((value) => value ?? "NULL").join("\t"))}><CopyCheck className="h-3.5 w-3.5" />{t("toolbox.postgres.copyRow")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyRowAsInsert(row, tab.result)}><ClipboardPaste className="h-3.5 w-3.5" />{t("toolbox.postgres.copyAsInsert")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyText(columnName)}><CopyMinus className="h-3.5 w-3.5" />{t("toolbox.postgres.copyColumnName")}</ContextMenuItem>
                        <ContextMenuSeparator />
                        {tab.type === "table" && <>
                          <ContextMenuItem onSelect={() => applyFilterByFieldValue(columnName, cell)}><ListFilter className="h-3.5 w-3.5" />{t("toolbox.postgres.filterByFieldValue")}</ContextMenuItem>
                          <ContextMenuItem onSelect={() => setFilterDialog({ mode: "custom" })}><Filter className="h-3.5 w-3.5" />{t("toolbox.postgres.customFilter")}</ContextMenuItem>
                          <ContextMenuSeparator />
                        </>}
                        {tab.type === "table" && tableEditingEnabled && <>
                          <ContextMenuItem
                            disabled={!canSetNull(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, null)}
                          ><Eraser className="h-3.5 w-3.5" />{t("toolbox.postgres.setNull")}</ContextMenuItem>
                          <ContextMenuItem
                            disabled={isPrimaryKeyColumn(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, "DEFAULT")}
                          ><RotateCcw className="h-3.5 w-3.5" />{t("toolbox.postgres.setDefault")}</ContextMenuItem>
                          <ContextMenuItem
                            disabled={isPrimaryKeyColumn(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, "")}
                          ><RemoveFormatting className="h-3.5 w-3.5" />{t("toolbox.postgres.setEmptyString")}</ContextMenuItem>
                          <ContextMenuItem
                            disabled={isPrimaryKeyColumn(columnIndex)}
                            onSelect={() => stageTableEdit(rowIndex, columnIndex, crypto.randomUUID())}
                          ><Fingerprint className="h-3.5 w-3.5" />{t("toolbox.postgres.generateUuid")}</ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            disabled={!rowHasPrimaryKey(row)}
                            onSelect={() => requestDeleteRow(rowIndex)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t("toolbox.postgres.deleteRecord")}
                            <ContextMenuShortcut>{formatShortcut("Ctrl+Delete")}</ContextMenuShortcut>
                          </ContextMenuItem>
                        </>}
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => void exportCsv()}><FileDown className="h-3.5 w-3.5" />{t("toolbox.postgres.exportCsv")}</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void exportExcel()}><FileSpreadsheet className="h-3.5 w-3.5" />{t("toolbox.postgres.exportExcel")}</ContextMenuItem>
                      </>
                    )}
                  </>}
                  renderColumnContextMenu={tab.type === "table" ? (columnName, columnIndex) => (
                    <>
                      <ContextMenuItem onSelect={() => {
                        setFilterDialog({ mode: "filterSort" });
                      }}><ListFilter className="h-3.5 w-3.5" />{t("toolbox.postgres.filterSort")}<ContextMenuShortcut>{formatShortcut("Ctrl+R")}</ContextMenuShortcut></ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => freezeColumn(columnIndex)}><Pin className="h-3.5 w-3.5" />{t("toolbox.postgres.freezeColumn")}</ContextMenuItem>
                      <ContextMenuItem disabled={!currentLayout().frozenCount} onSelect={unfreezeAllColumns}><PinOff className="h-3.5 w-3.5" />{t("toolbox.postgres.unfreezeAllColumns")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => setLayoutDialog({ kind: "columnWidth", columnIndex })}><MoveHorizontal className="h-3.5 w-3.5" />{t("toolbox.postgres.setColumnWidth")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => bestFitColumn(columnIndex)}><Shrink className="h-3.5 w-3.5" />{t("toolbox.postgres.bestFitColumn")}</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuCheckboxItem
                        checked={currentLayout().showFieldType}
                        onSelect={toggleFieldType}
                      >
                        {t("toolbox.postgres.showFieldType")}
                      </ContextMenuCheckboxItem>
                      <ContextMenuCheckboxItem
                        checked={currentLayout().showComment}
                        onSelect={toggleComment}
                      >
                        {t("toolbox.postgres.showComment")}
                      </ContextMenuCheckboxItem>
                    </>
                  ) : undefined}
                  renderRowHeaderContextMenu={tab.type === "table" ? () => (
                    <>
                      <ContextMenuItem
                        disabled={!tableEditingEnabled}
                        onSelect={addRecord}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.addRecord")}
                        <ContextMenuShortcut>{formatShortcut("Insert")}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={tab.result?.kind !== "tabular" || tab.result.rows.length === 0}
                        onSelect={() => {
                          if (tab.result?.kind !== "tabular" || tab.result.rows.length === 0) return;
                          void copyText(tab.result.rows[0].map((value) => value ?? "NULL").join("\t"));
                        }}
                      >
                        <CopyCheck className="h-3.5 w-3.5" />
                        {t("toolbox.postgres.copyRow")}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => setLayoutDialog({ kind: "rowHeight" })}><Rows3 className="h-3.5 w-3.5" />{t("toolbox.postgres.setRowHeight")}</ContextMenuItem>
                    </>
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
                  renderError={(error) => (
                    <DatabaseResultErrorPane
                      error={error}
                      labels={{
                        error:
                          tab.errorAction === "explain"
                            ? t("toolbox.postgres.explainFailedShort")
                            : tab.errorAction === "browse"
                              ? t("toolbox.postgres.browseFailed")
                              : t("toolbox.postgres.queryFailed"),
                        copy: t("toolbox.postgres.errorPane.copy"),
                        retry: t("toolbox.postgres.errorPane.retry"),
                        jumpToLine: t("toolbox.postgres.errorPane.jumpToLine"),
                        line: (n) => t("toolbox.postgres.errorPane.line", { n }),
                        details: t("toolbox.postgres.errorPane.details"),
                      }}
                      onRetry={
                        tab.type === "table"
                          ? () => {
                              const reference = tableReference();
                              if (reference) void browse(reference, tableOffset);
                            }
                          : () => void runSql(tab.sql)
                      }
                      onCopy={() => void copyText(error.fullText)}
                      onGoToLine={
                        error.lineNumber != null && tab.type === "query"
                          ? () => {
                              const view = queryEditorViewRef.current;
                              if (!view) return;
                              revealEditorLine(
                                view,
                                lastErrorRangeRef.current,
                                error.lineNumber!,
                              );
                            }
                          : undefined
                      }
                    />
                  )}
              />
              )}
              </>}
              </div>
              {ddlPreview && (
                <aside
                  className="flex w-72 shrink-0 flex-col border-l bg-muted/5"
                  data-testid="ddl-preview-panel"
                >
                  <div className="flex h-7 items-center gap-1 border-b bg-muted/10 px-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      DDL: {ddlPreview.schema}.{ddlPreview.name}
                    </span>
                    <div className="flex-1" />
                    {ddlPreview.loading && <Loader2 className="h-3 w-3 animate-spin" />}
                    {!ddlPreview.loading && !ddlPreview.error && (
                      <>
                        <ToolButton
                          icon={<Copy />}
                          label={t("common.copy")}
                          onClick={() => void writeClipboardText(ddlPreview.ddl)}
                        />
                        <ToolButton
                          icon={<RefreshCw />}
                          label={t("toolbox.postgres.refresh")}
                          onClick={() => void loadDdlPreview(ddlPreview.schema, ddlPreview.name, ddlPreview.objectType)}
                        />
                        <ToolButton
                          icon={<FileCode2 />}
                          label={t("toolbox.postgres.openInEditor")}
                          onClick={() => {
                            openTab({
                              id: `ddl:${draft.id}:${ddlPreview.schema}.${ddlPreview.name}.${ddlPreview.objectType}`,
                              connectionId: draft.id,
                              type: "query",
                              title: `${ddlPreview.name}.ddl`,
                              sql: ddlPreview.ddl,
                              result: null,
                              dirty: false,
                            });
                          }}
                        />
                      </>
                    )}
                    <ToolButton
                      icon={<X />}
                      label={t("common.close")}
                      onClick={() => setDdlPreview(null)}
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    {ddlPreview.error ? (
                      <div className="flex h-full items-center justify-center text-[12px] text-destructive">
                        {ddlPreview.error}
                      </div>
                    ) : ddlPreview.loading ? (
                      <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <pre className="sql-editor-container h-full overflow-auto bg-muted/5 p-2 text-[12px] leading-relaxed">
                        <code className="font-mono">{ddlPreview.ddl}</code>
                      </pre>
                    )}
                  </div>
                </aside>
              )}
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
      banner={connectionError ? (
        <div
          className="flex h-9 shrink-0 animate-in fade-in duration-200 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 text-[12px]"
          data-testid="postgres-connection-banner"
          role="alert"
        >
          <CircleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {connectionError}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 rounded-sm px-2 text-[11px]"
            onClick={() => void connectEstablished(draft)}
          >
            <RefreshCw className="size-3" />
            {t("toolbox.postgres.reconnect")}
          </Button>
        </div>
      ) : undefined}
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
        groupNames={listConnectionGroupNames(connections)}
        t={t}
      />
      <PostgresConnectionManager
        open={managerOpen}
        onOpenChange={setManagerOpen}
        profiles={connections.length ? connections : [draft]}
        connectedIds={connected ? [draft.id] : []}
        onSaveProfile={async (profile) => {
          const saved = { ...profile, updatedAt: Date.now() };
          if (!(await PostgresConnectionsStorage.upsert(saved))) return false;
          setConnections((current) => [
            ...current.filter((item) => item.id !== saved.id),
            saved,
          ]);
          if (saved.id === draft.id) setDraft(saved);
          return true;
        }}
        onDeleteProfile={async (id) => {
          await PostgresConnectionsStorage.remove(id);
          setConnections((current) =>
            current.filter((connection) => connection.id !== id),
          );
          if (id === draft.id) setConnected(false);
          return true;
        }}
        onTestConnection={testConnection}
      />
      <Dialog
        open={pendingSshTrust !== null}
        onOpenChange={(open) => !open && setPendingSshTrust(null)}
      >
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto">
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
      <AlertDialog
        open={deleteConnectionTarget !== null}
        onOpenChange={(open) => !open && setDeleteConnectionTarget(null)}
        data-testid="postgres-connection-delete-confirm"
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("toolbox.postgres.deleteConnectionConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("toolbox.postgres.deleteConnectionConfirmDescription", {
                name: deleteConnectionTarget
                  ? (connections.find((item) => item.id === deleteConnectionTarget)?.name ?? "")
                  : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = deleteConnectionTarget;
                setDeleteConnectionTarget(null);
                if (!target) return;
                void PostgresConnectionsStorage.remove(target);
                setConnections((current) =>
                  current.filter((connection) => connection.id !== target),
                );
                if (target === draft.id) setConnected(false);
              }}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={objectDropTarget !== null} onOpenChange={(open) => {
        if (!open) {
          setObjectDropTarget(null);
          setObjectDropPreview(null);
        }
      }}>
        <AlertDialogContent data-testid="postgres-object-drop-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("toolbox.postgres.dropConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              <p className="break-all font-mono text-destructive">
                {t("toolbox.postgres.dropConfirm", { object: objectDropTarget?.qualified ?? "" })}
              </p>
              {objectDropPreview && objectDropPreview.dependentCount ? (
                <p className="mt-2 text-muted-foreground">
                  {t("toolbox.postgres.dropDependents", {
                    count: String(objectDropPreview.dependentCount),
                    samples: objectDropPreview.sampleDependents.join(", ") || "-",
                  })}
                </p>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmObjectDrop()}
              data-testid="postgres-object-drop-confirm-action"
            >
              {objectDropTarget ? dropLabel(objectDropTarget.reference) : t("toolbox.postgres.dropObject")}
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
      <AlertDialog open={disconnectTarget !== null} onOpenChange={(open) => !open && setDisconnectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("toolbox.postgres.disconnectUnsavedTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("toolbox.postgres.disconnectUnsavedDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const connectionId = disconnectTarget;
                if (!connectionId) return;
                tabs.filter((item) => item.connectionId === connectionId).forEach(persistQueryTab);
                setDisconnectTarget(null);
                void completeDisconnect(connectionId);
              }}
            >{t("toolbox.postgres.saveSqlAndDisconnect")}</AlertDialogAction>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const connectionId = disconnectTarget;
                setDisconnectTarget(null);
                if (connectionId) void completeDisconnect(connectionId);
              }}
            >{t("toolbox.postgres.discardAndDisconnect")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={noteDialog !== null} onOpenChange={(open) => !open && setNoteDialog(null)}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[90vw] max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t("toolbox.postgres.saveToNotes")}</DialogTitle></DialogHeader>
          {(() => {
            const dialogNotes = NotesStorage.load();
            const targetNote = noteDialog && noteDialog.target !== "__new__"
              ? dialogNotes.find((note) => note.id === noteDialog.target)
              : undefined;
            const isNew = !noteDialog || noteDialog.target === "__new__" || !targetNote;
            const title = isNew
              ? (noteDialog?.title ?? "")
              : (targetNote?.title ?? "");
            const duplicate = noteHasDuplicateBlock(targetNote, title);
            const lines = targetNote?.content.trim()
              ? targetNote.content.split("\n").length
              : 0;
            const firstLine = targetNote?.content.split("\n")[0]?.slice(0, 40) ?? "";
            return (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t("toolbox.postgres.saveTargetNote")}</Label>
                  <Select
                    value={noteDialog?.target ?? "__new__"}
                    onValueChange={(value) =>
                      setNoteDialog((current) =>
                        current ? { ...current, target: value } : current,
                      )
                    }
                  >
                    <SelectTrigger data-testid="postgres-save-note-target" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__new__">{t("toolbox.postgres.saveNewNote")}</SelectItem>
                      {dialogNotes.map((note) => (
                        <SelectItem key={note.id} value={note.id}>
                          {note.title || t("toolbox.notes.untitled")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {isNew ? (
                  <Input
                    data-testid="postgres-save-note-title"
                    autoFocus
                    value={noteDialog?.title ?? ""}
                    onChange={(event) =>
                      setNoteDialog((current) =>
                        current ? { ...current, title: event.target.value } : current,
                      )
                    }
                    placeholder={t("toolbox.postgres.saveNoteTitlePlaceholder")}
                  />
                ) : (
                  <>
                    <Input data-testid="postgres-save-note-title" disabled value={title} />
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 shrink-0">
                        {t(`toolbox.notes.lang.${targetNote?.language ?? "plain"}` as const)}
                      </Badge>
                      <span className="shrink-0 tabular-nums">{t("toolbox.postgres.saveNoteLines", { count: lines })}</span>
                      <span className="truncate min-w-0 flex-1">{firstLine}</span>
                    </div>
                  </>
                )}
                {duplicate && (
                  <p data-testid="postgres-save-note-duplicate" className="text-[11px] text-destructive">
                    {t("toolbox.postgres.saveDuplicateBlock", { title })}
                  </p>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setNoteDialog(null)}>{t("common.cancel")}</Button>
                  <Button
                    data-testid="postgres-save-note-confirm"
                    onClick={confirmAppendSqlToNotes}
                    disabled={
                      (isNew && !noteDialog?.title.trim()) ||
                      duplicate
                    }
                  >
                    {isNew
                      ? t("toolbox.postgres.saveCreateAndSave")
                      : t("toolbox.postgres.saveAppendToNote")}
                  </Button>
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
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
      className="h-7 shrink-0 gap-1 rounded-sm px-2 text-[12px]"
      onClick={onClick}
      disabled={disabled}
      title={label}
      data-testid={testId}
    >
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
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
  groupNames,
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
  updateProfile: <K extends "name" | "environment" | "group">(
    key: K,
    value: PostgreSQLConnectionProfile[K],
  ) => void;
  save: () => Promise<void>;
  connect: () => Promise<void>;
  connecting: boolean;
  groupNames: readonly string[];
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
                  <Field label={t("toolbox.postgres.group")}>
                    <Input
                      value={draft.group ?? ""}
                      list="postgres-connection-group-datalist"
                      placeholder={t("toolbox.postgres.groupPlaceholder")}
                      onChange={(e) =>
                        updateProfile(
                          "group",
                          e.target.value.trim() ? e.target.value.trim() : undefined,
                        )
                      }
                    />
                    <datalist id="postgres-connection-group-datalist">
                      {groupNames.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label={t("toolbox.postgres.accentColor")}>
                    <div className="flex flex-wrap items-center gap-2">
                      {CONNECTION_ACCENT_COLORS.map((color) => {
                        const active = config.color === color;
                        return (
                          <button
                            key={color}
                            type="button"
                            aria-pressed={active}
                            className={`h-6 w-6 rounded-full border-2 transition ${active ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/40"}`}
                            style={{ backgroundColor: color }}
                            onClick={() => update("color", active ? undefined : color)}
                          />
                        );
                      })}
                      {config.color && (
                        <button
                          type="button"
                          className="text-[11px] text-muted-foreground underline"
                          onClick={() => update("color", undefined)}
                        >
                          {t("common.clear")}
                        </button>
                      )}
                    </div>
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
