import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Send,
  Play,
  Square,
  Plus,
  Trash2,
  Clock,
  Brackets,
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  Save,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  KeyRound,
  Globe,
  FolderPlus,
  History,
  FileCode2,
  AlignLeft,
  CheckCircle2,
  XCircle,
  Paperclip,
} from 'lucide-react';
import { inferFields, flattenFields, type ApiField } from '@/lib/toolbox/api-doc';
import {
  getCollection,
  getEnvironments,
  getActiveEnvId,
  getApiRequestHistory,
  addApiRequestHistory,
  clearApiRequestHistory,
  setCollection as persistCollection,
  setEnvironments as persistEnvironments,
  setActiveEnvId as persistActiveEnv,
  type RequestConfig,
  type ApiEnvironment,
  type ApiRequestHistory,
  type BodyType,
  type AuthConfig,
  type ApiAssertion,
} from '@/lib/toolbox/api-debug-storage';
import { cn } from '@/lib/utils';

/* ── types & constants ──────────────────────────────────────────────────── */

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
const WS_ID = 'api-debug-ws';
const MAX_MULTIPART_FILE_BYTES = 25 * 1024 * 1024;

interface MultipartFile {
  fieldName: string;
  fileName: string;
  dataBase64: string;
}

const EMPTY_AUTH: AuthConfig = {
  type: 'none',
  username: '',
  password: '',
  token: '',
  apiKeyName: '',
  apiKeyValue: '',
  apiKeyIn: 'header',
};

export interface RestResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  bodyIsBase64: boolean;
  durationMs: number;
  bodySizeBytes?: number;
  contentLength?: number;
  truncated?: boolean;
}

interface WsMessageItem {
  dir: 'in' | 'out';
  data: string;
  time: number;
  truncated?: boolean;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newParam(): [string, string] {
  return ['', ''];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function newAssertion(): ApiAssertion {
  return { target: 'status', operator: 'equals', value: '200' };
}

function assertionForTarget(target: ApiAssertion['target']): ApiAssertion {
  switch (target) {
    case 'header': return { target, name: '', operator: 'equals', value: '' };
    case 'body': return { target, path: '$', operator: 'equals', value: '' };
    case 'responseTime': return { target, operator: 'lessThanOrEqual', value: '1000' };
    default: return { target, operator: 'equals', value: '200' };
  }
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'bg-success/10 text-success border-success/30';
  if (status >= 300 && status < 400) return 'bg-primary/10 text-primary border-primary/30';
  if (status >= 400 && status < 500) return 'bg-warning/10 text-warning border-warning/30';
  return 'bg-destructive/10 text-destructive border-destructive/30';
}

/** Replace {{variable}} tokens using the given variable map. */
function resolveTemplate(text: string, vars: [string, string][]): string {
  let result = text;
  for (const [key, value] of vars) {
    if (key.trim()) {
      result = result.split(`{{${key.trim()}}}`).join(value);
    }
  }
  return result;
}

function authToHeaders(auth: AuthConfig): [string, string][] {
  switch (auth.type) {
    case 'basic':
      if (auth.username || auth.password) {
        const token = btoa(`${auth.username}:${auth.password}`);
        return [['Authorization', `Basic ${token}`]];
      }
      return [];
    case 'bearer':
      if (auth.token) return [['Authorization', `Bearer ${auth.token.trim()}`]];
      return [];
    case 'apikey':
      if (auth.apiKeyIn === 'header' && auth.apiKeyName.trim()) {
        return [[auth.apiKeyName.trim(), auth.apiKeyValue]];
      }
      return [];
    default:
      return [];
  }
}

export function parseUrlParams(value: string): [string, string][] | null {
  try {
    return Array.from(new URL(value).searchParams.entries());
  } catch {
    return null;
  }
}

interface ApiRequestInput {
  method: string;
  url: string;
  params: [string, string][];
  headers: [string, string][];
  bodyType: BodyType;
  bodyText: string;
  formFields?: [string, string][];
  multipartFiles?: MultipartFile[];
  auth: AuthConfig;
  timeoutMs: string;
  variables: [string, string][];
}

/** Resolve the editor state into the request sent to the backend. */
export function buildApiRequest({
  method,
  url,
  params,
  headers,
  bodyType,
  bodyText,
  formFields,
  multipartFiles,
  auth,
  timeoutMs,
  variables,
}: ApiRequestInput) {
  const finalUrl = new URL(resolveTemplate(url.trim(), variables));
  const activeParams = params
    .filter(([key]) => key.trim())
    .map(([key, value]) => [resolveTemplate(key.trim(), variables), resolveTemplate(value, variables)] as [string, string]);

  // Params edited in the table are authoritative over matching URL query keys.
  // URLSearchParams also keeps the query before any #fragment automatically.
  for (const [key] of activeParams) finalUrl.searchParams.delete(key);
  for (const [key, value] of activeParams) finalUrl.searchParams.append(key, value);

  const headerMap = new Map<string, [string, string]>();
  const setHeader = (key: string, value: string) => {
    const name = key.trim();
    if (name) headerMap.set(name.toLowerCase(), [name, value]);
  };
  for (const [key, value] of headers) setHeader(key, resolveTemplate(value, variables));

  const resolvedAuth: AuthConfig = {
    ...auth,
    username: resolveTemplate(auth.username, variables),
    password: resolveTemplate(auth.password, variables),
    token: resolveTemplate(auth.token, variables),
    apiKeyName: resolveTemplate(auth.apiKeyName, variables),
    apiKeyValue: resolveTemplate(auth.apiKeyValue, variables),
  };
  for (const [key, value] of authToHeaders(resolvedAuth)) setHeader(key, value);
  if (resolvedAuth.type === 'apikey' && resolvedAuth.apiKeyIn === 'query' && resolvedAuth.apiKeyName.trim()) {
    finalUrl.searchParams.set(resolvedAuth.apiKeyName.trim(), resolvedAuth.apiKeyValue);
  }

  const finalBody = bodyType === 'none' ? null : resolveTemplate(bodyText, variables);
  const resolvedFormFields = formFields
    ?.filter(([key]) => key.trim())
    .map(([key, value]) => [resolveTemplate(key.trim(), variables), resolveTemplate(value, variables)] as [string, string]);
  if (bodyType === 'json' && !headerMap.has('content-type')) {
    setHeader('Content-Type', 'application/json');
  } else if (bodyType === 'form' && !headerMap.has('content-type')) {
    setHeader('Content-Type', 'application/x-www-form-urlencoded');
  }

  return {
    method,
    url: finalUrl.toString(),
    headers: Array.from(headerMap.values()),
    body: finalBody,
    formFields: bodyType === 'form' && resolvedFormFields?.length ? resolvedFormFields : undefined,
    multipart: bodyType === 'multipart' ? { fields: resolvedFormFields ?? [], files: multipartFiles ?? [] } : undefined,
    timeoutMs: Number(timeoutMs) || 30000,
  };
}

/** Build a persisted request without restoring transient multipart files. */
export function buildApiRequestFromConfig(config: RequestConfig, variables: [string, string][]) {
  return buildApiRequest({
    method: config.method,
    url: config.url,
    params: config.params,
    headers: config.headers,
    bodyType: config.bodyType,
    bodyText: config.bodyText,
    formFields: config.formFields,
    auth: config.auth,
    timeoutMs: String(config.timeoutMs),
    variables,
  });
}

export function parseJsonResponse(text: string): { valid: true; value: unknown } | { valid: false } {
  try {
    return { valid: true, value: JSON.parse(text) as unknown };
  } catch {
    return { valid: false };
  }
}

export interface ApiAssertionResult {
  assertion: ApiAssertion;
  passed: boolean;
  actual: string;
}

/** Parse only $.property and [index] JSON paths, never expressions or filters. */
function readJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined;
  const tokens = path.slice(1).match(/(?:\.([A-Za-z_$][\w$]*))|(?:\[(\d+)\])/g) ?? [];
  if (tokens.join('') !== path.slice(1)) return undefined;
  let current: unknown = value;
  for (const token of tokens) {
    const property = /^\.([A-Za-z_$][\w$]*)$/.exec(token)?.[1];
    const index = /^\[(\d+)\]$/.exec(token)?.[1];
    if (property !== undefined && current !== null && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[property];
    } else if (index !== undefined && Array.isArray(current)) {
      current = current[Number(index)];
    } else {
      return undefined;
    }
  }
  return current;
}

function displayAssertionValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function equalityExpected(value: string): unknown {
  const parsed = parseJsonResponse(value);
  return parsed.valid ? parsed.value : value;
}

/** Evaluates fixed assertion types against a completed response, without eval. */
export function evaluateApiAssertions(response: RestResponse, assertions: ApiAssertion[]): ApiAssertionResult[] {
  const json = response.bodyIsBase64 ? { valid: false as const } : parseJsonResponse(response.body);
  return assertions.map((assertion) => {
    let actual: unknown;
    if (assertion.target === 'status') actual = response.status;
    if (assertion.target === 'responseTime') actual = response.durationMs;
    if (assertion.target === 'header') {
      actual = response.headers.find(([name]) => name.toLowerCase() === assertion.name.trim().toLowerCase())?.[1];
    }
    if (assertion.target === 'body') actual = json.valid ? readJsonPath(json.value, assertion.path.trim()) : undefined;
    const actualText = actual === undefined ? '' : displayAssertionValue(actual);
    let passed: boolean;
    if (assertion.operator === 'equals') {
      passed = actual !== undefined && JSON.stringify(actual) === JSON.stringify(equalityExpected(assertion.value));
    } else if (assertion.operator === 'contains') {
      const expected = equalityExpected(assertion.value);
      passed = typeof actual === 'string'
        ? actual.includes(String(expected))
        : Array.isArray(actual) && actual.some((item) => JSON.stringify(item) === JSON.stringify(expected));
    } else {
      passed = typeof actual === 'number' && Number.isFinite(Number(assertion.value)) && actual <= Number(assertion.value);
    }
    return { assertion, passed, actual: actual === undefined ? '(missing)' : actualText };
  });
}

export interface CollectionRunResult {
  config: RequestConfig;
  response?: RestResponse;
  assertionResults: ApiAssertionResult[];
  error?: string;
  durationMs: number;
}

export function didCollectionRunPass(result: CollectionRunResult): boolean {
  return !result.error
    && !!result.response
    && result.response.status >= 200
    && result.response.status < 400
    && result.assertionResults.every((assertion) => assertion.passed);
}

/** Run saved requests in order using only their declarative request/assertion data. */
export async function runApiCollection(
  configs: RequestConfig[],
  variables: [string, string][],
  execute: (request: ReturnType<typeof buildApiRequest>) => Promise<RestResponse>,
  shouldStop: () => boolean = () => false,
  stopOnFailure = false,
  onResult?: (result: CollectionRunResult) => void,
): Promise<CollectionRunResult[]> {
  const results: CollectionRunResult[] = [];
  for (const config of configs) {
    if (shouldStop()) break;
    const startedAt = performance.now();
    let result: CollectionRunResult;
    try {
      const response = await execute(buildApiRequestFromConfig(config, variables));
      result = {
        config,
        response,
        assertionResults: evaluateApiAssertions(response, config.assertions ?? []),
        durationMs: response.durationMs,
      };
    } catch (error) {
      result = {
        config,
        assertionResults: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
    results.push(result);
    onResult?.(result);
    if (stopOnFailure && !didCollectionRunPass(result)) break;
  }
  return results;
}



function formatJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}



/* ── Formatted JSON view (collapsible blocks, no field tree) ───────────── */

// Cap for JSON.parse of response bodies — above this the formatted view is
// skipped and only raw text is shown.
const MAX_PARSE_BODY_CHARS = 2 * 1024 * 1024; // 2 MiB
// Cap for schema inference (inferFields walks the whole tree).
const MAX_FIELD_INFER_CHARS = 512 * 1024; // 512 KiB
// Raw view renders the response body in chunks of this many characters.
const RAW_CHUNK_CHARS = 200_000;
// Blocks deeper than this depth start collapsed (initial render stays small
// even for huge payloads). Depth 1 is the root object itself; depth 2 is its
// direct children — keeping those expanded shows the actual payload, only
// deeper nesting collapses.
const DEFAULT_COLLAPSE_DEPTH = 2;

interface JsonBlockLine {
  indent: number;
  text: string;
  /** This line opens a `{`/`[` block. */
  open: boolean;
  depth: number;
  /** Index of the matching closing line when `open`. */
  closeIndex: number;
  /** This line closes a block. */
  isClose: boolean;
}

/** Parse pretty-printed JSON into indented lines with block ranges. */
function buildJsonLines(text: string): JsonBlockLine[] {
  const lines = text.split('\n');
  const out: JsonBlockLine[] = [];
  const stack: number[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const indent = /^\s*/.exec(lines[i])?.[0].length ?? 0;
    const trimmed = lines[i].trim();
    // JSON.stringify emits structural openers at the end of their line. Using
    // that shape avoids confusing braces inside string values with blocks.
    const open = trimmed.endsWith('{') || trimmed.endsWith('[');
    const isClose = trimmed.startsWith('}') || trimmed.startsWith(']');
    if (isClose && stack.length > 0) {
      depth = Math.max(0, depth - 1);
      const openIdx = stack.pop()!;
      out[openIdx].closeIndex = i;
    }
    out.push({ indent, text: lines[i], open, depth, closeIndex: -1, isClose });
    if (open) {
      stack.push(i);
      depth += 1;
    }
  }
  return out;
}

const CollapsibleJson = React.memo(function CollapsibleJson({ text }: { text: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => buildJsonLines(text), [text]);
  // Block lines that are currently collapsed (keyed by the opening line index).
  // Default: collapse only deep nesting (>= depth 2) so the top-level payload
  // is visible immediately. Very large bodies collapse deeper so the initial
  // render stays cheap.
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    const init = new Set<number>();
    const bigBody = lines.length > 5000;
    for (const l of lines) {
      if (l.open && l.depth >= (bigBody ? 1 : DEFAULT_COLLAPSE_DEPTH)) {
        init.add(lines.indexOf(l));
      }
    }
    return init;
  });

  const toggle = useCallback((lineIndex: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(lineIndex)) next.delete(lineIndex);
      else next.add(lineIndex);
      return next;
    });
  }, []);

  // Expand / collapse everything — handy when a payload is deeply nested and
  // the initial auto-collapse hid too much (or the whole tree is huge).
  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    const next = new Set<number>();
    for (const l of lines) if (l.open && l.depth >= 1) next.add(lines.indexOf(l));
    setCollapsed(next);
  }, [lines]);

  const rows: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isCollapsed = line.open && collapsed.has(i);
    const pad = { paddingLeft: `${line.indent * 0.6 + 0.25}rem` };
    if (line.open) {
      rows.push(
        <div key={i} className="flex items-start leading-5" style={pad}>
          <button
            type="button"
            className="w-4 h-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-primary"
            onClick={() => toggle(i)}
            aria-label={isCollapsed ? t('toolbox.apiDebug.expand') : t('toolbox.apiDebug.collapse')}
          >
            {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          <span className="break-all">
            {isCollapsed ? (
              <>
                <span className="text-muted-foreground/60">{line.text} …</span>
                {line.closeIndex >= 0 && <span className="text-muted-foreground/60">{lines[line.closeIndex]?.text}</span>}
              </>
            ) : (
              line.text
            )}
          </span>
        </div>,
      );
      if (isCollapsed) {
        // Guard: a block whose closer was never matched must not loop forever.
        i = line.closeIndex > i ? line.closeIndex + 1 : i + 1;
        continue;
      }
    } else {
      rows.push(
        <div key={i} className="flex items-start leading-5" style={pad}>
          <span className="w-4 h-4 shrink-0" />
          <span className="break-all">{line.text}</span>
        </div>,
      );
    }
    i++;
  }

  return (
    <div className="font-mono text-xs text-foreground/90">
      <div className="mb-1.5 flex items-center gap-1 text-[10px]">
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={expandAll}
        >
          ⤢ {t('toolbox.apiDebug.expandAll')}
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={collapseAll}
        >
          ⤡ {t('toolbox.apiDebug.collapseAll')}
        </button>
      </div>
      {rows}
    </div>
  );
});


const FieldTable = React.memo(function FieldTable({ root }: { root: ApiField }) {
  const rows = flattenFields(root);
  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1 pr-3 font-medium text-[10px] uppercase tracking-wider">{'name'}</th>
          <th className="py-1 pr-3 font-medium text-[10px] uppercase tracking-wider">{'type'}</th>
          <th className="py-1 pr-3 font-medium text-[10px] uppercase tracking-wider">{'required'}</th>
          <th className="py-1 font-medium text-[10px] uppercase tracking-wider">{'example'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ field, depth }, index) => (
          <tr key={index} className="border-t border-border/60 align-top">
            <td className="py-1 pr-3 font-mono text-foreground/90" style={{ paddingLeft: `${depth * 14 + 4}px` }}>
              {field.name}
            </td>
            <td className="py-1 pr-3 font-mono text-primary">{field.type}</td>
            <td className="py-1 pr-3">
              {field.required ? (
                <span className="text-success">●</span>
              ) : (
                <span className="text-muted-foreground">○</span>
              )}
            </td>
            <td className="py-1 font-mono text-muted-foreground break-all">{field.example}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});


/* ── row-level memoised KV editor ──────────────────────────────────────────
 * Each row is memoised and updated via functional setState, so typing in one
 * param/header row only re-renders that row instead of the whole page. */

interface KvRowProps {
  row: [string, string];
  isLast: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (key: string, value: string) => void;
  onAdd: () => void;
  onRemove: () => void;
}

const KvRow = React.memo(function KvRow({
  row,
  isLast,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
  onAdd,
  onRemove,
}: KvRowProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={row[0]}
        onChange={(e) => onChange(e.target.value, row[1])}
        placeholder={keyPlaceholder}
        className="h-7 text-xs flex-1 font-mono"
      />
      <Input
        value={row[1]}
        onChange={(e) => onChange(row[0], e.target.value)}
        placeholder={valuePlaceholder}
        className="h-7 text-xs flex-1 font-mono"
      />
      {isLast ? (
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0 text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
});

interface KeyValueEditorProps {
  rows: [string, string][];
  onRowsChange: (rows: [string, string][]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}

const KeyValueEditor = React.memo(function KeyValueEditor({
  rows,
  onRowsChange,
  keyPlaceholder,
  valuePlaceholder,
}: KeyValueEditorProps) {
  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => (
        <KvRow
          key={index}
          row={row}
          isLast={index === rows.length - 1}
          keyPlaceholder={keyPlaceholder}
          valuePlaceholder={valuePlaceholder}
          onChange={(k, v) => {
            const next = [...rows];
            next[index] = [k, v];
            onRowsChange(next);
          }}
          onAdd={() => onRowsChange([...rows, ['', ''] as [string, string]])}
          onRemove={() => onRowsChange(rows.filter((_, ri) => ri !== index))}
        />
      ))}
    </div>
  );
});

/* ── WebSocket panel (memoised so REST-page keystrokes never rebuild it) ── */
interface WsPanelProps {
  mode: 'rest' | 'ws';
  wsUrl: string;
  wsStatus: 'idle' | 'connecting' | 'connected' | 'closed';
  wsInput: string;
  wsMessages: WsMessageItem[];
  onUrlChange: (v: string) => void;
  onInputChange: (v: string) => void;
  onConnect: () => void;
  onSend: () => void;
  onClear: () => void;
}

const WsPanel = React.memo(function WsPanel({
  wsUrl,
  wsStatus,
  wsInput,
  wsMessages,
  mode,
  onUrlChange,
  onInputChange,
  onConnect,
  onSend,
  onClear,
}: WsPanelProps) {
  const { t } = useTranslation();
  const wsIsLive = wsStatus === 'connected' || wsStatus === 'connecting';

  return (
    <TabsContent value="ws" forceMount className={cn('flex-1 min-h-0 flex flex-col', mode !== 'ws' && 'hidden')}>
      <div className="px-3 pt-2 shrink-0">
        <div className="flex items-center gap-2">
          <Input
            value={wsUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder={t('toolbox.apiDebug.wsUrlPlaceholder')}
            className="flex-1 h-9 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConnect();
            }}
          />
          <Button
            size="sm"
            className={cn('h-9 gap-1.5 shrink-0', wsIsLive && 'bg-destructive hover:bg-destructive/90')}
            disabled={wsStatus === 'connecting'}
            onClick={onConnect}
          >
            {wsStatus === 'connecting' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : wsIsLive ? (
              <Square className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {wsIsLive ? t('toolbox.apiDebug.wsDisconnect') : t('toolbox.apiDebug.wsConnect')}
          </Button>
          <Badge
            variant="outline"
            className={cn(
              'shrink-0 text-[10px]',
              wsStatus === 'connected' && 'bg-success/10 text-success border-success/30',
              wsStatus === 'connecting' && 'bg-warning/10 text-warning border-warning/30',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full mr-1', wsStatus === 'connected' ? 'bg-success animate-pulse' : wsStatus === 'connecting' ? 'bg-warning animate-pulse' : 'bg-muted-foreground/40')} />
            {wsStatus === 'connected' ? t('toolbox.apiDebug.wsConnected') : wsStatus === 'connecting' ? t('toolbox.apiDebug.wsConnecting') : wsStatus === 'closed' ? t('toolbox.apiDebug.wsClosed') : t('toolbox.apiDebug.wsIdle')}
          </Badge>
        </div>
      </div>

        <div className="flex-1 min-h-0 p-3 flex flex-col">
          <div className="flex justify-end pb-2 shrink-0">
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" disabled={wsMessages.length === 0} onClick={onClear}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('toolbox.apiDebug.wsClearMessages')}
            </Button>
          </div>
          <div className="flex-1 min-h-0 rounded-lg border border-border overflow-hidden flex flex-col">
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-2">
              {wsMessages.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">{t('toolbox.apiDebug.wsEmpty')}</p>
              ) : (
                wsMessages.map((msg, index) => (
                  <div key={index} className={cn('flex gap-2', msg.dir === 'out' ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cn(
                        'max-w-[80%] rounded-lg px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all',
                        msg.dir === 'out' ? 'bg-primary/10 text-foreground' : 'bg-muted text-foreground',
                      )}
                    >
                      <div className={cn('flex items-center gap-1 mb-1 text-[10px]', msg.dir === 'out' ? 'text-primary' : 'text-muted-foreground')}>
                        {msg.dir === 'out' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
                        {new Date(msg.time).toLocaleTimeString()}
                      </div>
                      {msg.data}{msg.truncated ? `\n${t('toolbox.apiDebug.wsMessageTruncated')}` : ''}
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
        <div className="flex items-center gap-2 pt-2 shrink-0">
          <Input
            value={wsInput}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={t('toolbox.apiDebug.wsSendPlaceholder')}
            className="flex-1 h-8 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSend();
            }}
          />
          <Button size="sm" className="h-8 gap-1 shrink-0" disabled={wsStatus !== 'connected'} onClick={onSend}>
            <Send className="h-3.5 w-3.5" />
            {t('toolbox.apiDebug.send')}
          </Button>
        </div>
      </div>
    </TabsContent>
  );
});

/* ── main component ─────────────────────────────────────────────────────── */

interface ToolApiDebugProps {
  /** False while another toolbox module is shown — big response state is
   *  cleared so memory returns to baseline (views stay mounted otherwise). */
  active?: boolean;
}

export function ToolApiDebug({ active = true }: ToolApiDebugProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'rest' | 'ws'>('rest');

  /* collection & environments */
  const [collection, setCollection] = useState<RequestConfig[]>(() => getCollection());
  const [environments, setEnvironments] = useState<ApiEnvironment[]>(() => getEnvironments());
  const [activeEnvId, setActiveEnvId] = useState<string>(() => getActiveEnvId());
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveGroup, setSaveGroup] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RequestConfig | null>(null);
  const [history, setHistory] = useState<ApiRequestHistory[]>(() => getApiRequestHistory());
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [collectionRun, setCollectionRun] = useState<{ group: string; results: CollectionRunResult[]; running: boolean; stopped: boolean } | null>(null);
  const stopCollectionRunRef = useRef(false);

  /* request editor state */
  const [method, setMethod] = useState<string>('GET');
  const [url, setUrl] = useState('');
  const [params, setParams] = useState<[string, string][]>([newParam()]);
  const [headers, setHeaders] = useState<[string, string][]>([newParam()]);
  const [bodyType, setBodyType] = useState<BodyType>('none');
  const [bodyText, setBodyText] = useState('');
  const [formFields, setFormFields] = useState<[string, string][]>([newParam()]);
  const [multipartFiles, setMultipartFiles] = useState<MultipartFile[]>([]);
  const [auth, setAuth] = useState<AuthConfig>({ ...EMPTY_AUTH });
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [assertions, setAssertions] = useState<ApiAssertion[]>([]);
  const [configTab, setConfigTab] = useState('params');

  const [loading, setLoading] = useState(false);
  const activeRequestId = useRef<string | null>(null);
  const [response, setResponse] = useState<RestResponse | null>(null);
  const [showRespHeaders, setShowRespHeaders] = useState(false);
  // Raw view renders the body in chunks so a multi-MB response never becomes
  // one giant text node (which freezes layout). Chunks grow on demand.
  const [rawChars, setRawChars] = useState(RAW_CHUNK_CHARS);
  const [respView, setRespView] = useState<'tree' | 'raw' | 'fields'>('tree');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);

  /* websocket */
  const [wsUrl, setWsUrl] = useState('');
  const [wsStatus, setWsStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle');
  const [wsMessages, setWsMessages] = useState<WsMessageItem[]>([]);
  const [wsInput, setWsInput] = useState('');

  useEffect(() => {
    persistCollection(collection);
  }, [collection]);
  useEffect(() => {
    persistEnvironments(environments);
  }, [environments]);
  useEffect(() => {
    persistActiveEnv(activeEnvId);
  }, [activeEnvId]);

  // Release the (potentially huge) response + ws buffers when the user
  // switches to another module — the view stays mounted, so without this the
  // memory would never return to baseline.
  useEffect(() => {
    if (!active) {
      setResponse(null);
      setWsMessages([]);
      setShowRespHeaders(false);
      setRawChars(RAW_CHUNK_CHARS);
    }
  }, [active]);

  const activeEnv = useMemo(
    () => environments.find((e) => e.id === activeEnvId) ?? null,
    [environments, activeEnvId],
  );

  /* ── websocket events ─────────────────────────────────────────────────── */
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    void listen<{ id: string; data: string; timestamp: number; truncated?: boolean }>('api://ws-message', (event) => {
      if (event.payload.id !== WS_ID) return;
      setWsMessages((prev) => [...prev.slice(-499), {
        dir: 'in', data: event.payload.data, time: event.payload.timestamp, truncated: event.payload.truncated,
      }]);
    }).then((fn) => unlisteners.push(fn));
    void listen<{ id: string; status: string; error?: string; reason?: string }>('api://ws-status', (event) => {
      if (event.payload.id !== WS_ID) return;
      setWsStatus(event.payload.status === 'connected' ? 'connected' : 'closed');
      if (event.payload.error) {
        toast.error(t('toolbox.apiDebug.wsError'), { description: event.payload.error });
      }
    }).then((fn) => unlisteners.push(fn));
    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [t]);

  /* ── helpers ──────────────────────────────────────────────────────────── */

  const applyConfig = useCallback((cfg: RequestConfig, selectRequest = true) => {
    setMethod(cfg.method);
    setUrl(cfg.url);
    setParams(cfg.params.length > 0 ? cfg.params.map((p) => [...p] as [string, string]) : [newParam()]);
    setHeaders(cfg.headers.length > 0 ? cfg.headers.map((h) => [...h] as [string, string]) : [newParam()]);
    setBodyType(cfg.bodyType);
    setBodyText(cfg.bodyText);
    setFormFields(cfg.formFields?.length ? cfg.formFields.map((field) => [...field] as [string, string]) : [newParam()]);
    // Files are intentionally not persisted with request configurations.
    setMultipartFiles([]);
    setAuth({ ...EMPTY_AUTH, ...cfg.auth });
    setTimeoutMs(String(cfg.timeoutMs || 30000));
    setAssertions(cfg.assertions ?? []);
    setResponse(null);
    if (selectRequest) setSelectedId(cfg.id);
  }, []);

  /** Parse a pasted URL's query string into the params table so they can be
   *  inspected/edited (like Postman/Insomnia). Runs on every URL edit. */
  const handleUrlChange = useCallback((value: string) => {
    setUrl(value);
    const parsed = parseUrlParams(value);
    if (parsed === null) return;
    setParams(parsed.length > 0 ? parsed : [newParam()]);
  }, []);

  const buildRequest = useCallback(() => {
    return buildApiRequest({
      method,
      url,
      params,
      headers,
      bodyType,
      bodyText,
      formFields,
      multipartFiles,
      auth,
      timeoutMs,
      variables: activeEnv?.variables ?? [],
    });
  }, [url, params, headers, bodyType, bodyText, formFields, multipartFiles, auth, timeoutMs, activeEnv, method]);

  const addMultipartFile = useCallback(async () => {
    const path = await openDialog({ multiple: false });
    if (typeof path !== 'string') return;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_MULTIPART_FILE_BYTES) {
        toast.error(t('toolbox.apiDebug.fileTooLarge', { size: MAX_MULTIPART_FILE_BYTES / (1024 * 1024) }));
        return;
      }
      const fileName = path.split(/[\\/]/).pop() || path;
      setMultipartFiles((files) => [...files, { fieldName: 'file', fileName, dataBase64: bytesToBase64(bytes) }]);
    } catch (error) {
      toast.error(t('toolbox.apiDebug.fileReadFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [t]);

  const handleSend = useCallback(async () => {
    if (!url.trim()) {
      toast.error(t('toolbox.apiDebug.urlRequired'));
      return;
    }
    setLoading(true);
    setResponse(null);
    try {
      const requestId = crypto.randomUUID();
      activeRequestId.current = requestId;
      const req = { ...buildRequest(), requestId };
      const resp = await invoke<RestResponse>('api_request', { request: req });
      setResponse(resp);
      const config: RequestConfig = {
        id: selectedId ?? newId('api-history-request'),
        name: '',
        group: '',
        method,
        url: url.trim(),
        params: params.filter(([key]) => key.trim()).map((param) => [...param] as [string, string]),
        headers: headers.filter(([key]) => key.trim()).map((header) => [...header] as [string, string]),
        bodyType,
        bodyText,
        formFields: formFields.filter(([key]) => key.trim()).map((field) => [...field] as [string, string]),
        auth: { ...auth },
        timeoutMs: Number(timeoutMs) || 30000,
        assertions,
        updatedAt: Date.now(),
      };
      addApiRequestHistory({
        method: req.method,
        url: req.url,
        status: resp.status,
        statusText: resp.statusText,
        durationMs: resp.durationMs,
        config,
        responsePreview: resp.body,
        responseBodyIsBase64: resp.bodyIsBase64,
      });
      setHistory(getApiRequestHistory());
      // Non-JSON and oversized responses cannot use the formatted JSON view.
      // Send them straight to raw output instead of incorrectly calling them
      // "too large" (for example a 586 B HTML response).
      const isSmallJson = !resp.bodyIsBase64
        && resp.body.length <= MAX_PARSE_BODY_CHARS
        && parseJsonResponse(resp.body).valid;
      setRespView(isSmallJson ? 'tree' : 'raw');
    } catch (error) {
      toast.error(t('toolbox.apiDebug.requestFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      activeRequestId.current = null;
      setLoading(false);
    }
  }, [url, buildRequest, t, selectedId, method, params, headers, bodyType, bodyText, formFields, auth, timeoutMs, assertions]);

  const handleCancelRequest = useCallback(() => {
    const requestId = activeRequestId.current;
    if (requestId) void invoke('api_request_cancel', { requestId });
  }, []);

  const openSaveDialog = useCallback((saveAsNew = false) => {
    const selected = saveAsNew ? null : collection.find((item) => item.id === selectedId);
    if (saveAsNew) setSelectedId(null);
    setSaveName(selected?.name ?? (url.split('/').filter(Boolean).pop() || t('toolbox.apiDebug.untitledRequest')));
    setSaveGroup(selected?.group ?? '');
    setSaveDialogOpen(true);
  }, [collection, selectedId, url, t]);

  const handleSaveRequest = useCallback(() => {
    if (!saveName.trim()) {
      toast.error(t('toolbox.apiDebug.nameRequired'));
      return;
    }
    const cfg: RequestConfig = {
      id: selectedId ?? newId('api'),
      name: saveName.trim(),
      group: saveGroup.trim(),
      method,
      url: url.trim(),
      params: params.filter(([k]) => k.trim()).map((p) => [...p] as [string, string]),
      headers: headers.filter(([k]) => k.trim()).map((h) => [...h] as [string, string]),
      bodyType,
      bodyText,
      formFields: formFields.filter(([key]) => key.trim()).map((field) => [...field] as [string, string]),
      auth: { ...auth },
      timeoutMs: Number(timeoutMs) || 30000,
      assertions,
      updatedAt: Date.now(),
    };
    setCollection((prev) => {
      const idx = prev.findIndex((c) => c.id === cfg.id);
      const next = idx === -1 ? [...prev, cfg] : prev.map((c) => (c.id === cfg.id ? cfg : c));
      return next;
    });
    setSelectedId(cfg.id);
    setSaveDialogOpen(false);
    toast.success(t('toolbox.apiDebug.saved'));
  }, [saveName, saveGroup, selectedId, method, url, params, headers, bodyType, bodyText, formFields, auth, timeoutMs, assertions, t]);

  const handleDeleteRequest = useCallback(() => {
    if (!deleteTarget) return;
    setCollection((prev) => prev.filter((c) => c.id !== deleteTarget.id));
    if (selectedId === deleteTarget.id) setSelectedId(null);
    setDeleteTarget(null);
  }, [deleteTarget, selectedId]);

  const groups = useMemo(() => {
    const map = new Map<string, RequestConfig[]>();
    for (const item of collection) {
      const g = item.group || '';
      const list = map.get(g) ?? [];
      list.push(item);
      map.set(g, list);
    }
    return Array.from(map.entries());
  }, [collection]);

  const handleRunGroup = useCallback(async (group: string, configs: RequestConfig[]) => {
    if (configs.length === 0) return;
    stopCollectionRunRef.current = false;
    setCollectionRun({ group, results: [], running: true, stopped: false });
    const variables = activeEnv?.variables ?? [];
    await runApiCollection(
      configs,
      variables,
      (request) => invoke<RestResponse>('api_request', { request }),
      () => stopCollectionRunRef.current,
      stopOnFailure,
      (result) => {
        if (result.response) {
          addApiRequestHistory({
            method: result.config.method,
            url: buildApiRequestFromConfig(result.config, variables).url,
            status: result.response.status,
            statusText: result.response.statusText,
            durationMs: result.response.durationMs,
            config: result.config,
            responsePreview: result.response.body,
            responseBodyIsBase64: result.response.bodyIsBase64,
          });
          setHistory(getApiRequestHistory());
        }
        setCollectionRun((previous) => previous ? { ...previous, results: [...previous.results, result] } : previous);
      },
    );
    setCollectionRun((previous) => previous ? { ...previous, running: false, stopped: stopCollectionRunRef.current } : previous);
  }, [activeEnv, stopOnFailure]);

  const handleStopCollectionRun = useCallback(() => {
    stopCollectionRunRef.current = true;
  }, []);

  /* ── environment dialog ───────────────────────────────────────────────── */

  const [envDraft, setEnvDraft] = useState<ApiEnvironment[]>([]);
  const openEnvDialog = useCallback(() => {
    setEnvDraft(environments.map((e) => ({ ...e, variables: e.variables.map((v) => [...v] as [string, string]) })));
    setEnvDialogOpen(true);
  }, [environments]);

  const handleEnvSave = useCallback(() => {
    const cleaned = envDraft
      .filter((e) => e.name.trim())
      .map((e) => ({ ...e, name: e.name.trim(), variables: e.variables.filter(([k]) => k.trim()) }));
    setEnvironments(cleaned);
    if (activeEnvId && !cleaned.some((e) => e.id === activeEnvId)) {
      setActiveEnvId('');
    }
    setEnvDialogOpen(false);
  }, [envDraft, activeEnvId]);

  /* ── websocket actions ────────────────────────────────────────────────── */

  const handleWsConnect = useCallback(async () => {
    if (!wsUrl.trim()) {
      toast.error(t('toolbox.apiDebug.wsUrlRequired'));
      return;
    }
    if (wsStatus === 'connected' || wsStatus === 'connecting') {
      try {
        await invoke('api_ws_close', { id: WS_ID });
      } catch {
        /* ignore */
      }
      setWsStatus('closed');
      return;
    }
    setWsMessages([]);
    setWsStatus('connecting');
    try {
      await invoke('api_ws_connect', { id: WS_ID, url: wsUrl.trim() });
    } catch (error) {
      setWsStatus('closed');
      toast.error(t('toolbox.apiDebug.wsConnectFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [wsUrl, wsStatus, t]);

  const handleWsSend = useCallback(async () => {
    if (!wsInput.trim() || wsStatus !== 'connected') return;
    const message = wsInput;
    try {
      await invoke('api_ws_send', { id: WS_ID, message });
      setWsMessages((prev) => [...prev.slice(-499), { dir: 'out', data: message, time: Date.now() }]);
      setWsInput('');
    } catch (error) {
      toast.error(t('toolbox.apiDebug.wsSendFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [wsInput, wsStatus, t]);

  const handleWsClear = useCallback(() => {
    setWsMessages([]);
  }, []);

  /* ── KV row editor (shared for params/headers) ────────────────────────── */


  /* ── parsed response body for tree view ───────────────────────────────── */

  const requestBodyJson = useMemo(() => {
    if (bodyType !== 'json' || !bodyText.trim()) return null;
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return null;
    }
  }, [bodyType, bodyText]);

  const parsedResponse = useMemo(() => {
    if (!response || response.bodyIsBase64) return { valid: false } as const;
    // Huge bodies are never JSON.parse'd — the formatted view is skipped and
    // only raw (chunked) text is shown.
    if (response.body.length > MAX_PARSE_BODY_CHARS) return { valid: false } as const;
    return parseJsonResponse(response.body);
  }, [response]);
  const parsedBody = parsedResponse.valid ? parsedResponse.value : undefined;

  // Pretty-printed JSON text for the formatted (collapsible) view.
  const prettyBody = useMemo(() => {
    if (!parsedResponse.valid) return '';
    try {
      return JSON.stringify(parsedBody, null, 2);
    } catch {
      return '';
    }
  }, [parsedBody, parsedResponse.valid]);

  const responseFields = useMemo(() => {
    if (!parsedResponse.valid || response?.bodyIsBase64) return null;
    if ((response?.body.length ?? 0) > MAX_FIELD_INFER_CHARS) return null;
    return inferFields(parsedBody);
  }, [parsedBody, parsedResponse.valid, response]);

  const assertionResults = useMemo(
    () => response ? evaluateApiAssertions(response, assertions) : [],
    [response, assertions],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <div className="p-1.5 rounded-lg bg-primary/10 text-primary shrink-0">
          <Brackets className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {t('toolbox.apiDebug.title')}
            {activeEnv && (
              <Badge variant="outline" className="text-[10px] text-primary border-primary/30 bg-primary/10 gap-1">
                <Globe className="h-3 w-3" />
                {activeEnv.name}
              </Badge>
            )}
          </h3>
          <p className="text-[11px] text-muted-foreground truncate">{t('toolbox.apiDebug.description')}</p>
        </div>
        <Button size="sm" variant="outline" className="h-8 gap-1 shrink-0" onClick={openEnvDialog} title={t('toolbox.apiDebug.manageEnv')}>
          <Globe className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{t('toolbox.apiDebug.env')}</span>
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── collection sidebar ── */}
        <div className="w-56 shrink-0 border-r border-border flex flex-col bg-muted/20">
           <div className="px-2 pt-2 pb-1 flex items-center justify-between">
             <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
               {t('toolbox.apiDebug.collection')}
            </span>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground" onClick={() => openSaveDialog(true)} title={t('toolbox.apiDebug.newRequest')}>
               <Plus className="h-3.5 w-3.5" />
             </Button>
           </div>
          <div className="px-2 pb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Switch checked={stopOnFailure} onCheckedChange={setStopOnFailure} className="scale-75 origin-left" />
            <span>{t('toolbox.apiDebug.stopOnFailure')}</span>
          </div>
          {collectionRun && (
            <div className="mx-2 mb-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[10px]">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-medium">{t('toolbox.apiDebug.runReport', { group: collectionRun.group || t('toolbox.apiDebug.ungrouped') })}</span>
                {collectionRun.running && <Loader2 className="h-3 w-3 animate-spin" />}
                {collectionRun.running && <Button variant="ghost" size="sm" className="h-5 px-1 text-[10px]" onClick={handleStopCollectionRun}>{t('toolbox.apiDebug.stop')}</Button>}
              </div>
              <div className="mt-1 text-muted-foreground">
                {t('toolbox.apiDebug.runSummary', {
                  passed: collectionRun.results.filter(didCollectionRunPass).length,
                  failed: collectionRun.results.filter((result) => !didCollectionRunPass(result)).length,
                  total: collectionRun.results.length,
                  duration: collectionRun.results.reduce((total, result) => total + result.durationMs, 0),
                })}{collectionRun.stopped ? ` · ${t('toolbox.apiDebug.runStopped')}` : ''}
              </div>
              {collectionRun.results.slice(-3).map((result) => (
                <div key={result.config.id} className={cn('mt-1 flex items-center gap-1 truncate', didCollectionRunPass(result) ? 'text-success' : 'text-destructive')}>
                  {didCollectionRunPass(result) ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <XCircle className="h-3 w-3 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{result.config.name}</span>
                  <span className="font-mono">{result.response?.status ?? t('toolbox.apiDebug.runError')}</span>
                  <span className="text-muted-foreground">{result.durationMs} ms</span>
                </div>
              ))}
            </div>
          )}
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-1 pb-2 space-y-0.5">
              {collection.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">{t('toolbox.apiDebug.noCollection')}</p>
              ) : (
                groups.map(([group, items]) => (
                  <div key={group || '__root__'} className="space-y-0.5">
                    <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" /> <span className="min-w-0 flex-1 truncate">{group || t('toolbox.apiDebug.ungrouped')}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1 text-[10px]"
                        disabled={collectionRun?.running === true}
                        onClick={() => void handleRunGroup(group, items)}
                        title={t('toolbox.apiDebug.runGroup', { group: group || t('toolbox.apiDebug.ungrouped') })}
                        aria-label={t('toolbox.apiDebug.runGroup', { group: group || t('toolbox.apiDebug.ungrouped') })}
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                    </div>
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className={cn(
                          'group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs cursor-pointer',
                          selectedId === item.id ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60 text-foreground/90',
                        )}
                        onClick={() => applyConfig(item)}
                      >
                        <Badge variant="outline" className="text-[9px] font-mono shrink-0 px-1">{item.method}</Badge>
                        <span className="flex-1 min-w-0 truncate">{item.name}</span>
                        <button
                          type="button"
                          className="h-4 w-4 shrink-0 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(item);
                          }}
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
          <div className="border-t border-border shrink-0">
            <div className="px-2 pt-2 pb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('toolbox.apiDebug.history')}
              </span>
              {history.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    clearApiRequestHistory();
                    setHistory([]);
                  }}
                  title={t('toolbox.apiDebug.clearHistory')}
                  aria-label={t('toolbox.apiDebug.clearHistory')}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
            <ScrollArea className="h-36">
              <div className="px-1 pb-2 space-y-0.5">
                {history.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{t('toolbox.apiDebug.noHistory')}</p>
                ) : history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
                    onClick={() => applyConfig(item.config, false)}
                    title={item.responsePreview}
                    aria-label={t('toolbox.apiDebug.restoreHistory')}
                  >
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px] font-mono shrink-0 px-1">{item.method}</Badge>
                      <Badge variant="outline" className={cn('text-[9px] font-mono shrink-0 px-1', statusColor(item.status))}>{item.status}</Badge>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{item.url}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {item.durationMs} ms · {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>

        {/* ── main area ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'rest' | 'ws')} className="flex-1 flex flex-col min-h-0">
            <TabsList className="mx-3 mt-2 w-auto">
              <TabsTrigger value="rest" className="text-xs px-3 gap-1">
                <ArrowDownLeft className="h-3.5 w-3.5" /> {t('toolbox.apiDebug.rest')}
              </TabsTrigger>
              <TabsTrigger value="ws" className="text-xs px-3 gap-1">
                <History className="h-3.5 w-3.5" /> {t('toolbox.apiDebug.websocket')}
              </TabsTrigger>
            </TabsList>

            {/* ── REST ── */}
            <TabsContent value="rest" className="flex-1 min-h-0 flex flex-col">
              <div className="px-3 pt-2 shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                  <Select value={method} onValueChange={setMethod}>
                    <SelectTrigger className="w-24 h-9 shrink-0 font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHODS.map((m) => (
                        <SelectItem key={m} value={m} className="font-mono text-xs">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={url}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    placeholder={t('toolbox.apiDebug.urlPlaceholder')}
                    className="flex-1 h-9 font-mono text-xs"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSend();
                    }}
                  />
                  <Button size="sm" className="h-9 gap-1.5 shrink-0" onClick={loading ? handleCancelRequest : () => void handleSend()}>
                    {loading ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                    {loading ? t('common.cancel') : t('toolbox.apiDebug.send')}
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 gap-1 shrink-0" onClick={() => openSaveDialog()} title={t('toolbox.apiDebug.saveRequest')}>
                    <Save className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 gap-1 shrink-0" onClick={() => setDocOpen(true)} title={t('toolbox.apiDebug.doc')}>
                    <FileCode2 className="h-4 w-4" />
                  </Button>
                </div>

                {/* Config tabs */}
                <Tabs value={configTab} onValueChange={setConfigTab} className="space-y-2">
                  <TabsList className="w-auto h-8">
                    <TabsTrigger value="params" className="text-[11px] px-2.5 h-7">{t('toolbox.apiDebug.params')}</TabsTrigger>
                    <TabsTrigger value="headers" className="text-[11px] px-2.5 h-7">{t('toolbox.apiDebug.headers')}</TabsTrigger>
                    <TabsTrigger value="body" className="text-[11px] px-2.5 h-7">{t('toolbox.apiDebug.body')}</TabsTrigger>
                    <TabsTrigger value="auth" className="text-[11px] px-2.5 h-7 gap-1">
                      <KeyRound className="h-3 w-3" /> {t('toolbox.apiDebug.auth')}
                    </TabsTrigger>
                    <TabsTrigger value="assertions" className="text-[11px] px-2.5 h-7">{t('toolbox.apiDebug.assertions')}</TabsTrigger>
                  </TabsList>

                  <div className="rounded-lg border border-border p-2">
                    <TabsContent value="params" className="mt-0">
                      {<KeyValueEditor rows={params} onRowsChange={setParams} keyPlaceholder={t('toolbox.apiDebug.key')} valuePlaceholder={t('toolbox.apiDebug.value')} />}
                    </TabsContent>
                    <TabsContent value="headers" className="mt-0">
                      {<KeyValueEditor rows={headers} onRowsChange={setHeaders} keyPlaceholder={t('toolbox.apiDebug.headerName')} valuePlaceholder={t('toolbox.apiDebug.headerValue')} />}
                    </TabsContent>
                    <TabsContent value="body" className="mt-0 space-y-2">
                      <Select value={bodyType} onValueChange={(v) => setBodyType(v as BodyType)} disabled={method === 'GET' || method === 'HEAD'}>
                        <SelectTrigger className="h-7 w-[170px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-xs">{t('toolbox.apiDebug.bodyNone')}</SelectItem>
                          <SelectItem value="json" className="text-xs">JSON</SelectItem>
                          <SelectItem value="text" className="text-xs">{t('toolbox.apiDebug.bodyText')}</SelectItem>
                          <SelectItem value="form" className="text-xs">x-www-form-urlencoded</SelectItem>
                          <SelectItem value="multipart" className="text-xs">multipart/form-data</SelectItem>
                        </SelectContent>
                      </Select>
                      {bodyType === 'json' && (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 gap-1 text-[11px]"
                            onClick={() => setBodyText(formatJsonText(bodyText))}
                          >
                            <AlignLeft className="h-3 w-3" />
                            {t('toolbox.apiDebug.formatJson')}
                          </Button>
                          <span className="text-[10px] text-muted-foreground">
                            {requestBodyJson ? `${t('toolbox.apiDebug.fields')}: ${flattenFields(inferFields(requestBodyJson)).length}` : ''}
                          </span>
                        </div>
                      )}
                      {(bodyType === 'form' || bodyType === 'multipart') && (
                        <div className="space-y-2">
                          <KeyValueEditor rows={formFields} onRowsChange={setFormFields} keyPlaceholder={t('toolbox.apiDebug.key')} valuePlaceholder={t('toolbox.apiDebug.value')} />
                          {bodyType === 'multipart' && (
                            <div className="space-y-1.5 border-t border-border pt-2">
                              {multipartFiles.map((file, index) => (
                                <div key={`${file.fileName}-${index}`} className="flex items-center gap-1.5">
                                  <Input
                                    value={file.fieldName}
                                    onChange={(event) => setMultipartFiles((files) => files.map((item, itemIndex) => itemIndex === index ? { ...item, fieldName: event.target.value } : item))}
                                    placeholder={t('toolbox.apiDebug.fileField')}
                                    className="h-7 w-32 font-mono text-xs"
                                  />
                                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{file.fileName}</span>
                                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => setMultipartFiles((files) => files.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('common.delete')}><Trash2 className="h-3.5 w-3.5" /></Button>
                                </div>
                              ))}
                              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => void addMultipartFile()}>
                                <Paperclip className="h-3.5 w-3.5" />{t('toolbox.apiDebug.chooseFile')}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                      {bodyType !== 'none' && bodyType !== 'form' && bodyType !== 'multipart' && (
                        <Textarea
                          value={bodyText}
                          onChange={(e) => setBodyText(e.target.value)}
                          placeholder={bodyType === 'json' ? '{\n  "key": "value"\n}' : t('toolbox.apiDebug.bodyPlaceholder')}
                          className="min-h-[90px] font-mono text-xs resize-y"
                        />
                      )}
                    </TabsContent>
                    <TabsContent value="auth" className="mt-0 space-y-2">
                      <Select value={auth.type} onValueChange={(v) => setAuth((prev) => ({ ...prev, type: v as AuthConfig['type'] }))}>
                        <SelectTrigger className="h-7 w-[180px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-xs">{t('toolbox.apiDebug.authNone')}</SelectItem>
                          <SelectItem value="basic" className="text-xs">{t('toolbox.apiDebug.authBasic')}</SelectItem>
                          <SelectItem value="bearer" className="text-xs">{t('toolbox.apiDebug.authBearer')}</SelectItem>
                          <SelectItem value="apikey" className="text-xs">{t('toolbox.apiDebug.authApiKey')}</SelectItem>
                        </SelectContent>
                      </Select>
                      {auth.type === 'basic' && (
                        <div className="grid grid-cols-2 gap-2">
                          <Input value={auth.username} onChange={(e) => setAuth((p) => ({ ...p, username: e.target.value }))} placeholder={t('toolbox.apiDebug.username')} className="h-7 text-xs font-mono" />
                          <Input value={auth.password} onChange={(e) => setAuth((p) => ({ ...p, password: e.target.value }))} placeholder={t('toolbox.apiDebug.password')} type="password" className="h-7 text-xs font-mono" />
                        </div>
                      )}
                      {auth.type === 'bearer' && (
                        <Input value={auth.token} onChange={(e) => setAuth((p) => ({ ...p, token: e.target.value }))} placeholder={t('toolbox.apiDebug.bearerToken')} className="h-7 text-xs font-mono" />
                      )}
                      {auth.type === 'apikey' && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <Input value={auth.apiKeyName} onChange={(e) => setAuth((p) => ({ ...p, apiKeyName: e.target.value }))} placeholder={t('toolbox.apiDebug.apiKeyName')} className="h-7 text-xs font-mono" />
                            <Input value={auth.apiKeyValue} onChange={(e) => setAuth((p) => ({ ...p, apiKeyValue: e.target.value }))} placeholder={t('toolbox.apiDebug.apiKeyValue')} className="h-7 text-xs font-mono" />
                          </div>
                          <Select value={auth.apiKeyIn} onValueChange={(v) => setAuth((p) => ({ ...p, apiKeyIn: v as 'header' | 'query' }))}>
                            <SelectTrigger className="h-7 w-[140px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="header" className="text-xs">{t('toolbox.apiDebug.apiKeyInHeader')}</SelectItem>
                              <SelectItem value="query" className="text-xs">{t('toolbox.apiDebug.apiKeyInQuery')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </TabsContent>
                    <TabsContent value="assertions" className="mt-0 space-y-2">
                      <p className="text-[10px] text-muted-foreground">{t('toolbox.apiDebug.assertionsDesc')}</p>
                      {assertions.map((assertion, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                          <Select value={assertion.target} onValueChange={(target) => setAssertions((items) => items.map((item, itemIndex) => itemIndex === index ? assertionForTarget(target as ApiAssertion['target']) : item))}>
                            <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="status" className="text-xs">{t('toolbox.apiDebug.assertStatus')}</SelectItem>
                              <SelectItem value="header" className="text-xs">{t('toolbox.apiDebug.assertHeader')}</SelectItem>
                              <SelectItem value="body" className="text-xs">{t('toolbox.apiDebug.assertBody')}</SelectItem>
                              <SelectItem value="responseTime" className="text-xs">{t('toolbox.apiDebug.assertResponseTime')}</SelectItem>
                            </SelectContent>
                          </Select>
                          {assertion.target === 'header' && <Input value={assertion.name} onChange={(e) => setAssertions((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, name: e.target.value } as ApiAssertion : item))} placeholder={t('toolbox.apiDebug.assertHeaderName')} className="h-7 w-32 font-mono text-xs" />}
                          {assertion.target === 'body' && <Input value={assertion.path} onChange={(e) => setAssertions((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, path: e.target.value } as ApiAssertion : item))} placeholder="$.data.items[0].id" className="h-7 w-40 font-mono text-xs" />}
                          <Select value={assertion.operator} onValueChange={(operator) => setAssertions((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, operator } as ApiAssertion : item))}>
                            <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="equals" className="text-xs" disabled={assertion.target === 'responseTime'}>{t('toolbox.apiDebug.assertEquals')}</SelectItem>
                              <SelectItem value="contains" className="text-xs" disabled={assertion.target === 'status' || assertion.target === 'responseTime'}>{t('toolbox.apiDebug.assertContains')}</SelectItem>
                              <SelectItem value="lessThanOrEqual" className="text-xs" disabled={assertion.target !== 'responseTime'}>{t('toolbox.apiDebug.assertMaxTime')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input value={assertion.value} onChange={(e) => setAssertions((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, value: e.target.value } : item))} placeholder={assertion.target === 'responseTime' ? '1000' : t('toolbox.apiDebug.assertValue')} className="h-7 flex-1 min-w-20 font-mono text-xs" />
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => setAssertions((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('common.delete')}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      ))}
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAssertions((items) => [...items, newAssertion()])}><Plus className="h-3.5 w-3.5" />{t('toolbox.apiDebug.addAssertion')}</Button>
                    </TabsContent>
                  </div>
                </Tabs>
              </div>

              {/* Response */}
              <div className="flex-1 min-h-0 p-3 flex flex-col">
                {response ? (
                  <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border overflow-hidden">
                    <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-muted/30 shrink-0 flex-wrap">
                      <Badge variant="outline" className={cn('text-xs font-mono', statusColor(response.status))}>
                        {response.status} {response.statusText}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {response.durationMs} ms
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {t('toolbox.apiDebug.size')}: {response.bodySizeBytes ?? (response.bodyIsBase64 ? response.body.length : response.body.length)} B
                      </span>
                      {response.truncated && (
                        <span className="text-[11px] text-warning">{t('toolbox.apiDebug.truncated')}</span>
                      )}
                      {assertionResults.length > 0 && (
                        <span className={cn('text-[11px] flex items-center gap-1', assertionResults.every((result) => result.passed) ? 'text-success' : 'text-destructive')}>
                          {assertionResults.every((result) => result.passed) ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                          {t('toolbox.apiDebug.assertionSummary', { passed: assertionResults.filter((result) => result.passed).length, total: assertionResults.length })}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {parsedResponse.valid && (
                          <Tabs value={respView} onValueChange={(v) => setRespView(v as 'tree' | 'raw' | 'fields')} className="h-6">
                            <TabsList className="h-6 w-auto">
                              <TabsTrigger value="tree" className="h-5 px-2 text-[10px]">{t('toolbox.apiDebug.viewTree')}</TabsTrigger>
                              <TabsTrigger value="raw" className="h-5 px-2 text-[10px]">{t('toolbox.apiDebug.viewRaw')}</TabsTrigger>
                              <TabsTrigger value="fields" className="h-5 px-2 text-[10px]">{t('toolbox.apiDebug.viewFields')}</TabsTrigger>
                            </TabsList>
                          </Tabs>
                        )}
                        <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setShowRespHeaders((v) => !v)}>
                          {t('toolbox.apiDebug.responseHeaders')}
                        </Button>
                      </div>
                    </div>
                    {showRespHeaders && (
                      <div className="max-h-32 overflow-y-auto px-3 py-2 border-b border-border bg-muted/10 shrink-0">
                        {response.headers.map(([k, v], index) => (
                          <div key={index} className="text-[11px] font-mono text-foreground/80">
                            <span className="text-muted-foreground">{k}:</span> {v}
                          </div>
                        ))}
                      </div>
                    )}
                    {assertionResults.length > 0 && (
                      <div className="border-b border-border bg-muted/10 px-3 py-2 space-y-1 shrink-0">
                        {assertionResults.map((result, index) => (
                          <div key={index} className={cn('flex items-center gap-1.5 text-[11px]', result.passed ? 'text-success' : 'text-destructive')}>
                            {result.passed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                            <span className="font-mono">{result.assertion.target === 'body' ? result.assertion.path : result.assertion.target === 'header' ? result.assertion.name : result.assertion.target}</span>
                            <span className="text-muted-foreground">{result.assertion.operator} {result.assertion.value} ({result.actual})</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <ScrollArea className="flex-1 min-h-0">
                      {/* Views stay mounted and toggle via hidden — switching
                          tree/raw/fields never rebuilds a large JSON tree. */}
                      {!!responseFields && (
                        <div className={cn('p-3', respView !== 'fields' && 'hidden')}>
                          <FieldTable root={responseFields} />
                        </div>
                      )}
                       {parsedResponse.valid && (
                        <div className={cn('p-3', respView !== 'tree' && 'hidden')}>
                          <CollapsibleJson text={prettyBody} />
                        </div>
                      )}
                       {!parsedResponse.valid && respView === 'tree' && (
                        <div className="p-6 text-center text-xs text-muted-foreground">
                          {t('toolbox.apiDebug.bodyTooLarge')}
                        </div>
                      )}
                      <pre
                        className={cn(
                          'p-3 text-xs font-mono whitespace-pre-wrap break-all text-foreground/90',
                          respView !== 'raw' && 'hidden',
                        )}
                      >
                        {response.bodyIsBase64
                          ? `[binary, base64]\n${response.body.slice(0, rawChars)}`
                          : response.body.slice(0, rawChars)}
                      </pre>
                      {respView === 'raw' && response.body.length > rawChars && (
                        <div className="p-2 flex justify-center border-t border-border shrink-0">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRawChars((c) => c + RAW_CHUNK_CHARS)}>
                            {t('toolbox.apiDebug.loadMore')} ({((response.body.length - rawChars) / 1024).toFixed(0)} KB)
                          </Button>
                        </div>
                      )}
                    </ScrollArea>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-muted-foreground p-8 text-center">
                    <Brackets className="h-8 w-8" />
                    <p className="text-sm">{t('toolbox.apiDebug.responseEmpty')}</p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ── WebSocket ── */}
            <WsPanel
                        mode={mode}
                        wsUrl={wsUrl}
                        wsStatus={wsStatus}
                        wsInput={wsInput}
                        wsMessages={wsMessages}
                        onUrlChange={setWsUrl}
                        onInputChange={setWsInput}
                        onConnect={() => void handleWsConnect()}
                        onSend={() => void handleWsSend()}
                        onClear={handleWsClear}
                      />
          </Tabs>
        </div>
      </div>

      <Separator />

      {/* Save request dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('toolbox.apiDebug.saveRequest')}</DialogTitle>
            <DialogDescription>{t('toolbox.apiDebug.saveRequestDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={t('toolbox.apiDebug.requestName')} className="h-8 text-sm" autoFocus />
            <Input value={saveGroup} onChange={(e) => setSaveGroup(e.target.value)} placeholder={t('toolbox.apiDebug.groupPlaceholder')} className="h-8 text-sm" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveRequest}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete request */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.apiDebug.deleteRequest')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.apiDebug.deleteRequestDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteRequest}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── API document dialog ── */}
      <Dialog open={docOpen} onOpenChange={setDocOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-primary" />
              {t('toolbox.apiDebug.doc')}
            </DialogTitle>
            <DialogDescription>{t('toolbox.apiDebug.docDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* Basic info */}
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs font-mono text-primary border-primary/30">{method}</Badge>
                <span className="text-sm font-mono text-foreground break-all flex-1 min-w-0">{url || '—'}</span>
                {auth.type !== 'none' && (
                  <Badge variant="secondary" className="text-[10px] gap-1">
                    <KeyRound className="h-3 w-3" />
                    {auth.type === 'basic' ? t('toolbox.apiDebug.authBasic') : auth.type === 'bearer' ? t('toolbox.apiDebug.authBearer') : t('toolbox.apiDebug.authApiKey')}
                  </Badge>
                )}
              </div>
            </div>

            {/* Request params */}
            <div className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('toolbox.apiDebug.requestParams')}
              </p>
              {params.filter(([k]) => k.trim()).length === 0 ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    {params.filter(([k]) => k.trim()).map(([k, v], i) => (
                      <tr key={i} className="border-t border-border/60">
                        <td className="py-1 pr-3 font-mono text-foreground/90">{k}</td>
                        <td className="py-1 font-mono text-muted-foreground break-all">{v || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Request headers */}
            <div className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('toolbox.apiDebug.requestHeaders')}
              </p>
              {headers.filter(([k]) => k.trim()).length === 0 ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    {headers.filter(([k]) => k.trim()).map(([k, v], i) => (
                      <tr key={i} className="border-t border-border/60">
                        <td className="py-1 pr-3 font-mono text-foreground/90">{k}</td>
                        <td className="py-1 font-mono text-muted-foreground break-all">{v || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Request body */}
            <div className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('toolbox.apiDebug.requestBody')}
              </p>
              {bodyType === 'none' || !bodyText.trim() ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                <>
                  <pre className="rounded-md bg-muted/40 p-2 text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/90 max-h-48 overflow-y-auto">
                    {formatJsonText(bodyText)}
                  </pre>
                  {requestBodyJson && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t('toolbox.apiDebug.requestFields')}
                      </p>
                      <FieldTable root={inferFields(requestBodyJson)} />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Response */}
            <div className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('toolbox.apiDebug.response')}
              </p>
              {!response ? (
                <p className="text-xs text-muted-foreground">{t('toolbox.apiDebug.docNoResponse')}</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={cn('text-xs font-mono', statusColor(response.status))}>
                      {response.status} {response.statusText}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">{response.durationMs} ms</span>
                  </div>
                  <pre className="rounded-md bg-muted/40 p-2 text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/90 max-h-48 overflow-y-auto">
                    {response.bodyIsBase64 ? `[binary, base64]\n${response.body}` : formatJsonText(response.body)}
                  </pre>
                  {responseFields && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t('toolbox.apiDebug.responseFields')}
                      </p>
                      <FieldTable root={responseFields} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setDocOpen(false)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Environments dialog */}
      <Dialog open={envDialogOpen} onOpenChange={setEnvDialogOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('toolbox.apiDebug.manageEnv')}</DialogTitle>
            <DialogDescription>{t('toolbox.apiDebug.manageEnvDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="flex items-center justify-between">
              <Select
                value={activeEnvId}
                onValueChange={(v) => setActiveEnvId(v === '__none__' ? '' : v)}
              >
                <SelectTrigger className="h-8 w-[200px] text-xs">
                  <SelectValue placeholder={t('toolbox.apiDebug.noEnv')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" className="text-xs">{t('toolbox.apiDebug.noEnv')}</SelectItem>
                  {environments.map((e) => (
                    <SelectItem key={e.id} value={e.id} className="text-xs">
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={() =>
                  setEnvDraft((prev) => [
                    ...prev,
                    { id: newId('env'), name: '', variables: [['', '']] as [string, string][] },
                  ])
                }
              >
                <FolderPlus className="h-3.5 w-3.5" />
                {t('toolbox.apiDebug.addEnv')}
              </Button>
            </div>

            {envDraft.map((env, envIndex) => (
              <div key={env.id} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={env.name}
                    onChange={(e) =>
                      setEnvDraft((prev) => prev.map((x, i) => (i === envIndex ? { ...x, name: e.target.value } : x)))
                    }
                    placeholder={t('toolbox.apiDebug.envName')}
                    className="h-7 text-xs flex-1"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-destructive"
                    onClick={() => setEnvDraft((prev) => prev.filter((_, i) => i !== envIndex))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('toolbox.apiDebug.envVars')}
                </div>
                {env.variables.map(([k, v], varIndex) => (
                  <div key={varIndex} className="flex items-center gap-1.5">
                    <Input
                      value={k}
                      onChange={(e) =>
                        setEnvDraft((prev) =>
                          prev.map((x, i) =>
                            i === envIndex
                              ? { ...x, variables: x.variables.map((row, j) => (j === varIndex ? [e.target.value, row[1]] : row)) }
                              : x,
                          ),
                        )
                      }
                      placeholder={t('toolbox.apiDebug.varName')}
                      className="h-7 text-xs flex-1 font-mono"
                    />
                    <Input
                      value={v}
                      onChange={(e) =>
                        setEnvDraft((prev) =>
                          prev.map((x, i) =>
                            i === envIndex
                              ? { ...x, variables: x.variables.map((row, j) => (j === varIndex ? [row[0], e.target.value] : row)) }
                              : x,
                          ),
                        )
                      }
                      placeholder={t('toolbox.apiDebug.varValue')}
                      className="h-7 text-xs flex-1 font-mono"
                    />
                    {varIndex === env.variables.length - 1 ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() =>
                          setEnvDraft((prev) =>
                            prev.map((x, i) => (i === envIndex ? { ...x, variables: [...x.variables, ['', '']] } : x)),
                          )
                        }
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-destructive"
                        onClick={() =>
                          setEnvDraft((prev) =>
                            prev.map((x, i) =>
                              i === envIndex ? { ...x, variables: x.variables.filter((_, j) => j !== varIndex) } : x,
                            ),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnvDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleEnvSave}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
