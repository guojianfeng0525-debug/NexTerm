/**
 * PostgreSQL connection manager dialog (B22).
 *
 * Hosted from the navigator context menu / toolbar (wired by fe-dev). Covers:
 * - per-connection accent color + virtual group editing
 * - single & batched connection tests (concurrency ≤5)
 * - connection export (plaintext secrets stripped or AES-GCM encrypted)
 * - connection import (strict validation + merge strategy)
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, PlugZap, RefreshCw, Upload, Download, X, Check, AlertTriangle } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONNECTION_SECRET_FIELDS,
  CONNECTIONS_FILE_MAX_BYTES,
  isValidColor,
  isValidGroupName,
  mergeConnections,
  parseConnectionsImport,
  serializeConnectionsExport,
  type ConnectionMergeMode,
} from "@/lib/connections-io";
import { groupConnectionsByGroup, listConnectionGroupNames } from "@/lib/database/connection-groups";
import type { PostgreSQLConnectionProfile } from "@/lib/database/postgresql-profile-adapter";

/** Theme-palette accent colors (no arbitrary values, D-B22-1). */
export const CONNECTION_ACCENT_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
] as const;

/** UI strings for `toolbox.postgres.connectionManager.*`; used only when the
 *  locale resources do not carry the key yet (B22 wiring in flight). */
const CM_FALLBACK: Record<string, string> = {
  title: "连接管理器",
  subtitle: "管理连接的颜色、分组与连接测试",
  ungrouped: "未分组",
  noColor: "无",
  groupPlaceholder: "分组",
  test: "测试连接",
  batchTest: "批量测试",
  batchResults: "批量测试结果",
  saveFailed: "保存失败",
  invalidGroup: "分组名不合法",
  invalidColor: "颜色不合法",
  testFailed: "连接失败",
  unknownError: "未知错误",
  export: "导出",
  import: "导入",
  exportPassphrase: "导出口令",
  encryptExport: "加密凭据",
  importPassphrase: "导入口令",
  unlockImport: "解锁导入",
  importPreview: "导入预览",
  importAppend: "追加（跳过同名）",
  importOverwrite: "覆盖（替换同名）",
  applyImport: "确认导入",
  imported: "导入完成",
  invalidFile: "无效的导入文件",
  importFailed: "导入失败",
  fileTooLarge: "文件过大",
  passwordMasked: "密码将重新填写",
  secretFailures: "部分凭据解密失败",
  noConnections: "无连接可导出",
  passphraseTooShort: "口令至少 8 位",
};

export interface ConnectionTestOutcome {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly version?: string;
  readonly error?: string;
}

export interface PostgresConnectionManagerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profiles: readonly PostgreSQLConnectionProfile[];
  /** Ids of currently connected sessions (drives status badges). */
  readonly connectedIds?: readonly string[];
  readonly onSaveProfile: (profile: PostgreSQLConnectionProfile) => Promise<boolean>;
  readonly onDeleteProfile: (id: string) => Promise<boolean>;
  readonly onTestConnection: (profile: PostgreSQLConnectionProfile) => Promise<ConnectionTestOutcome>;
}

interface TestRow {
  readonly profileId: string;
  readonly name: string;
  outcome?: ConnectionTestOutcome;
  testing: boolean;
}

interface ImportPendingState {
  readonly profiles: readonly PostgreSQLConnectionProfile[];
  readonly mode: ConnectionMergeMode;
}

function StatusDot({ ok }: { readonly ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`}
      data-testid="connection-test-status-dot"
    />
  );
}

export function PostgresConnectionManager({
  open,
  onOpenChange,
  profiles,
  connectedIds = [],
  onSaveProfile,
  onDeleteProfile,
  onTestConnection,
}: PostgresConnectionManagerProps) {
  const { t } = useTranslation();
  const lookup = t as (key: string) => string;
  const translate = (key: string, options?: Record<string, unknown>): string => {
    const raw = lookup(key);
    if (raw !== key) return raw;
    // Locale resource missing (wiring in flight) → built-in fallback.
    const sub = key.split(".").pop() ?? "";
    let fallback = CM_FALLBACK[sub] ?? key;
    if (options) {
      for (const [name, value] of Object.entries(options)) {
        fallback = fallback.split(`{{${name}}}`).join(String(value));
      }
    }
    return fallback;
  };
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string | undefined>>({});
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestOutcome>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<TestRow[] | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [encryptExport, setEncryptExport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<ImportPendingState | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importSource, setImportSource] = useState<string | null>(null);
  const [importNeedsPassphrase, setImportNeedsPassphrase] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextGroup = { ...groupNames };
    const nextColor = { ...colors };
    for (const profile of profiles) {
      if (!(profile.id in nextGroup)) nextGroup[profile.id] = profile.group ?? "";
      if (!(profile.id in nextColor)) nextColor[profile.id] = profile.providerConfig.color;
    }
    setGroupNames(nextGroup);
    setColors(nextColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grouped = useMemo(() => groupConnectionsByGroup(profiles), [profiles]);
  const knownGroups = useMemo(() => listConnectionGroupNames(profiles), [profiles]);

  async function saveRow(profile: PostgreSQLConnectionProfile, patch: Partial<PostgreSQLConnectionProfile>) {
    const next: PostgreSQLConnectionProfile = {
      ...profile,
      ...patch,
      providerConfig: {
        ...profile.providerConfig,
        ...(patch.providerConfig ?? {}),
      },
    };
    const ok = await onSaveProfile(next);
    if (!ok) toast.error(translate("toolbox.postgres.connectionManager.saveFailed"));
  }

  function patchGroup(profileId: string, value: string) {
    const next = { ...groupNames, [profileId]: value };
    setGroupNames(next);
  }

  function patchColor(profileId: string, value: string | undefined) {
    const next = { ...colors, [profileId]: value };
    setColors(next);
  }

  function applyRowEdits(profile: PostgreSQLConnectionProfile) {
    const group = groupNames[profile.id]?.trim() ?? "";
    if (group && !isValidGroupName(group)) {
      toast.error(translate("toolbox.postgres.connectionManager.invalidGroup"));
      return;
    }
    const color = colors[profile.id];
    if (color && !isValidColor(color)) {
      toast.error(translate("toolbox.postgres.connectionManager.invalidColor"));
      return;
    }
    const profilePatch = group !== (profile.group ?? "")
      ? { group: group || undefined }
      : {};
    const configPatch = color !== profile.providerConfig.color
      ? { color: color || undefined }
      : {};
    if (Object.keys(profilePatch).length || Object.keys(configPatch).length) {
      void saveRow(profile, {
        ...(Object.keys(profilePatch).length ? profilePatch : {}),
        ...(Object.keys(configPatch).length ? { providerConfig: configPatch } : {}),
      } as Partial<PostgreSQLConnectionProfile>);
    }
  }

  async function testOne(profile: PostgreSQLConnectionProfile) {
    setTesting((current) => new Set(current).add(profile.id));
    setTestResults((current) => ({ ...current, [profile.id]: undefined as unknown as ConnectionTestOutcome }));
    try {
      const outcome = await onTestConnection(profile);
      setTestResults((current) => ({ ...current, [profile.id]: outcome }));
      if (!outcome.ok) {
        toast.error(translate("toolbox.postgres.connectionManager.testFailed", { name: profile.name, error: outcome.error ?? "" }));
      }
    } finally {
      setTesting((current) => {
        const next = new Set(current);
        next.delete(profile.id);
        return next;
      });
    }
  }

  async function runBatchTest() {
    setBatchRunning(true);
    const rows: TestRow[] = profiles.map((profile) => ({ profileId: profile.id, name: profile.name, testing: false }));
    setBatchResults(rows);
    const queue = [...rows];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        const row = queue.shift();
        if (!row) return;
        const profile = profiles.find((item) => item.id === row.profileId);
        if (!profile) continue;
        row.testing = true;
        row.outcome = await onTestConnection(profile).catch<ConnectionTestOutcome>(() => ({
          ok: false,
          error: translate("toolbox.postgres.connectionManager.unknownError"),
        }));
        row.testing = false;
      }
    });
    await Promise.all(workers);
    setBatchRunning(false);
    setBatchResults([...rows]);
  }

  async function exportConnections() {
    const selected = profiles;
    if (!selected.length) {
      toast.error(translate("toolbox.postgres.connectionManager.noConnections"));
      return;
    }
    const passphrase = encryptExport ? exportPassphrase : undefined;
    if (encryptExport && (!passphrase || passphrase.length < 8)) {
      toast.error(translate("toolbox.postgres.connectionManager.passphraseTooShort"));
      return;
    }
    const path = await saveDialog({
      defaultPath: `nexterm-connections-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "NexTerm Connections", extensions: ["json"] }],
    });
    if (!path) return;
    const text = await serializeConnectionsExport(selected, passphrase ? { encryptWithPassphrase: passphrase } : {});
    await writeTextFile(path, text);
    toast.success(translate("toolbox.postgres.connectionManager.exported"));
  }

  async function importConnections() {
    const path = await openDialog({
      filters: [{ name: "NexTerm Connections", extensions: ["json"] }],
      multiple: false,
      directory: false,
    });
    if (!path || Array.isArray(path)) return;
    try {
      const meta = await stat(path);
      if (meta.size > CONNECTIONS_FILE_MAX_BYTES) {
        toast.error(translate("toolbox.postgres.connectionManager.fileTooLarge"));
        return;
      }
      setImporting(true);
      const text = await readTextFile(path);
      setImportSource(text);
      await parseImportSource(text);
    } catch (error) {
      reportImportError(error);
    } finally {
      setImporting(false);
    }
  }

  async function parseImportSource(text: string, passphrase?: string) {
    const parsed = await parseConnectionsImport(text, passphrase || undefined);
    if (parsed.secretFailures.length) {
      toast.warning(translate("toolbox.postgres.connectionManager.secretFailures"));
    }
    setPendingImport({
      profiles: parsed.connections.map((entry) => {
        // Decrypted secrets replace stripped/encrypted placeholders. The
        // storage layer re-encrypts them with encField on persist.
        const secrets = entry.secrets ?? {};
        const providerConfig = { ...entry.profile.providerConfig } as Record<string, unknown>;
        for (const field of CONNECTION_SECRET_FIELDS) {
          const secret = secrets[field];
          if (secret !== undefined) providerConfig[field] = secret;
        }
        return { ...entry.profile, providerConfig } as unknown as PostgreSQLConnectionProfile;
      }),
      mode: "append",
    });
    setImportNeedsPassphrase(false);
  }

  function reportImportError(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (message === "passphrase required") {
      setImportNeedsPassphrase(true);
      return;
    }
    setImportNeedsPassphrase(false);
    toast.error(message && message.startsWith("invalid import file")
      ? translate("toolbox.postgres.connectionManager.invalidFile")
      : translate("toolbox.postgres.connectionManager.importFailed"));
  }

  async function retryImportWithPassphrase() {
    if (!importSource) return;
    try {
      setImporting(true);
      await parseImportSource(importSource, importPassphrase);
    } catch (error) {
      reportImportError(error);
    } finally {
      setImporting(false);
    }
  }

  async function applyImport() {
    if (!pendingImport) return;
    const merged = mergeConnections(profiles, pendingImport.profiles, pendingImport.mode);
    for (const profile of merged) {
      const ok = await onSaveProfile(profile);
      if (!ok) {
        toast.error(translate("toolbox.postgres.connectionManager.saveFailed"));
        return;
      }
    }
    setPendingImport(null);
    setImportSource(null);
    setImportPassphrase("");
    toast.success(translate("toolbox.postgres.connectionManager.imported"));
  }

  async function deleteProfile(profile: PostgreSQLConnectionProfile) {
    if (!window.confirm(translate("toolbox.postgres.deleteConfirm", { name: profile.name }))) return;
    await onDeleteProfile(profile.id);
  }

  const colorLabel = (color: string | undefined) => color ?? translate("toolbox.postgres.connectionManager.noColor");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="postgres-connection-manager">
        <DialogHeader>
          <DialogTitle>{translate("toolbox.postgres.connectionManager.title")}</DialogTitle>
          <DialogDescription>
            {translate("toolbox.postgres.connectionManager.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: "55vh" }}>
          {grouped.map((group) => (
            <div key={group.groupName ?? "__ungrouped__"}>
              <div className="mb-1 flex items-center gap-2 border-b border-border/60 px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground" data-testid="connection-group-header">
                <span>{group.groupName ?? translate("toolbox.postgres.connectionManager.ungrouped")}</span>
                <span className="rounded bg-accent px-1 text-[10px] leading-4">{group.connections.length}</span>
              </div>
              {group.connections.map((profile) => {
                const testingThis = testing.has(profile.id);
                const result = testResults[profile.id];
                const connected = connectedIds.includes(profile.id);
                return (
                  <div key={profile.id} className="flex items-center gap-2 border-b border-border/40 px-1 py-1.5" data-testid="connection-manager-row">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: colors[profile.id] ?? "transparent" }}
                      data-testid="connection-accent-preview"
                    />
                    <span className="w-40 truncate text-[12px]" title={profile.name}>{profile.name}</span>
                    <span
                      className={`ml-1 h-2 w-2 shrink-0 rounded-full ${connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      data-testid="connection-status-badge"
                    />
                    <div className="ml-auto flex items-center gap-1">
                      <Select
                        value={colors[profile.id] ?? "none"}
                        onValueChange={(value) => patchColor(profile.id, value === "none" ? undefined : value)}
                        onOpenChange={(open) => { if (!open) applyRowEdits(profile); }}
                      >
                        <SelectTrigger className="h-6 w-28 text-[11px]" data-testid="connection-color-select">
                          <SelectValue placeholder={colorLabel(colors[profile.id])} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{translate("toolbox.postgres.connectionManager.noColor")}</SelectItem>
                          {CONNECTION_ACCENT_COLORS.map((color) => (
                            <SelectItem key={color} value={color}>
                              <span className="flex items-center gap-1.5">
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                                {color}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-6 w-28 text-[11px]"
                        placeholder={translate("toolbox.postgres.connectionManager.groupPlaceholder")}
                        value={groupNames[profile.id] ?? ""}
                        list="connection-group-names"
                        onChange={(event) => patchGroup(profile.id, event.target.value)}
                        onBlur={() => applyRowEdits(profile)}
                        onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
                        data-testid="connection-group-input"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-7 px-0 text-[11px]"
                        onClick={() => void testOne(profile)}
                        disabled={testingThis}
                        title={translate("toolbox.postgres.connectionManager.test")}
                        data-testid="connection-test"
                      >
                        {testingThis ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-7 px-0 text-[11px] text-destructive"
                        onClick={() => void deleteProfile(profile)}
                        title={translate("common.delete")}
                        data-testid="connection-delete"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {result && !testingThis && (
                      <span className={`ml-2 flex items-center gap-1 text-[11px] ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`} data-testid="connection-test-result">
                        {result.ok ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        <span className="max-w-48 truncate">
                          {result.ok
                            ? `${result.version ?? "OK"}${result.latencyMs != null ? ` · ${result.latencyMs}ms` : ""}`
                            : (result.error ?? translate("toolbox.postgres.connectionManager.unknownError"))}
                        </span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <datalist id="connection-group-names">
            {knownGroups.map((name) => <option key={name} value={name} />)}
          </datalist>
        </div>

        {batchResults && (
          <div className="max-h-40 overflow-y-auto rounded border border-border/60 p-2" data-testid="batch-test-results">
            <div className="mb-1 text-[11px] font-medium">{translate("toolbox.postgres.connectionManager.batchResults")}</div>
            {batchResults.map((row) => (
              <div key={row.profileId} className="flex items-center gap-2 py-0.5 text-[11px]">
                {row.testing
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : row.outcome
                    ? <StatusDot ok={row.outcome.ok} />
                    : <span className="h-2 w-2" />}
                <span className="w-36 truncate">{row.name}</span>
                {row.outcome && (
                  <span className={`truncate ${row.outcome.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                    {row.outcome.ok
                      ? `${row.outcome.version ?? "OK"}${row.outcome.latencyMs != null ? ` · ${row.outcome.latencyMs}ms` : ""}`
                      : (row.outcome.error ?? "")}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {pendingImport && (
          <div className="rounded border border-border/60 p-2" data-testid="import-preview">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium">{translate("toolbox.postgres.connectionManager.importPreview")}</span>
              <Select value={pendingImport.mode} onValueChange={(value) => setPendingImport({ ...pendingImport, mode: value as ConnectionMergeMode })}>
                <SelectTrigger className="h-6 w-28 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">{translate("toolbox.postgres.connectionManager.importAppend")}</SelectItem>
                  <SelectItem value="overwrite">{translate("toolbox.postgres.connectionManager.importOverwrite")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {pendingImport.profiles.map((profile) => (
              <div key={profile.id} className="flex items-center gap-2 py-0.5 text-[11px]">
                <span className="w-36 truncate">{profile.name}</span>
                <span className="truncate text-muted-foreground">{profile.providerConfig.host}:{profile.providerConfig.port}</span>
                <span className="text-muted-foreground">{translate("toolbox.postgres.connectionManager.passwordMasked")}</span>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="flex-wrap items-center gap-2">
          {encryptExport && (
            <Input
              type="password"
              className="h-7 w-44 text-[11px]"
              placeholder={translate("toolbox.postgres.connectionManager.exportPassphrase")}
              value={exportPassphrase}
              onChange={(event) => setExportPassphrase(event.target.value)}
              data-testid="connection-export-passphrase"
            />
          )}
          <label className="flex items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={encryptExport}
              onChange={(event) => setEncryptExport(event.target.checked)}
              data-testid="connection-export-encrypt"
            />
            {translate("toolbox.postgres.connectionManager.encryptExport")}
          </label>
          <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void exportConnections()} data-testid="connection-export">
            <Download className="mr-1 h-3.5 w-3.5" />{translate("toolbox.postgres.connectionManager.export")}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void importConnections()} disabled={importing} data-testid="connection-import">
            <Upload className="mr-1 h-3.5 w-3.5" />{translate("toolbox.postgres.connectionManager.import")}
          </Button>
          {pendingImport && (
            <Button type="button" size="sm" className="h-7 text-[11px]" onClick={() => void applyImport()} data-testid="import-confirm">
              {translate("toolbox.postgres.connectionManager.applyImport")}
            </Button>
          )}
          {importNeedsPassphrase && (
            <Input
              type="password"
              className="h-7 w-44 text-[11px]"
              placeholder={translate("toolbox.postgres.connectionManager.importPassphrase")}
              value={importPassphrase}
              onChange={(event) => setImportPassphrase(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void retryImportWithPassphrase(); }}
              data-testid="connection-import-passphrase"
            />
          )}
          {importNeedsPassphrase && (
            <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void retryImportWithPassphrase()} disabled={importing} data-testid="import-unlock">
              {translate("toolbox.postgres.connectionManager.unlockImport")}
            </Button>
          )}
          <Button type="button" variant="default" size="sm" className="h-7 text-[11px]" onClick={() => void runBatchTest()} disabled={batchRunning || !profiles.length} data-testid="connection-batch-test">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${batchRunning ? "animate-spin" : ""}`} />{translate("toolbox.postgres.connectionManager.batchTest")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => onOpenChange(false)}>
            {translate("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
