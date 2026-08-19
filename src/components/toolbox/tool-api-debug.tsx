import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
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
} from 'lucide-react';
import { inferFields, flattenFields, type ApiField } from '@/lib/toolbox/api-doc';
import {
  getCollection,
  getEnvironments,
  getActiveEnvId,
  setCollection as persistCollection,
  setEnvironments as persistEnvironments,
  setActiveEnvId as persistActiveEnv,
  type RequestConfig,
  type ApiEnvironment,
  type BodyType,
  type AuthConfig,
} from '@/lib/toolbox/api-debug-storage';
import { cn } from '@/lib/utils';

/* ── types & constants ──────────────────────────────────────────────────── */

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
const WS_ID = 'api-debug-ws';

const EMPTY_AUTH: AuthConfig = {
  type: 'none',
  username: '',
  password: '',
  token: '',
  apiKeyName: '',
  apiKeyValue: '',
  apiKeyIn: 'header',
};

interface RestResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  bodyIsBase64: boolean;
  durationMs: number;
}

interface WsMessageItem {
  dir: 'in' | 'out';
  data: string;
  time: number;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newParam(): [string, string] {
  return ['', ''];
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
      if (auth.apiKeyName.trim()) {
        return [[auth.apiKeyName.trim(), auth.apiKeyValue]];
      }
      return [];
    default:
      return [];
  }
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
// even for huge payloads).
const DEFAULT_COLLAPSE_DEPTH = 1;

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
  const lines = useMemo(() => buildJsonLines(text), [text]);
  // Block lines that are currently collapsed (keyed by the opening line index).
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    const init = new Set<number>();
    for (const l of lines) {
      if (l.open && l.depth >= DEFAULT_COLLAPSE_DEPTH) init.add(lines.indexOf(l));
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
            aria-label={isCollapsed ? 'expand' : 'collapse'}
          >
            {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          <span className="break-all">
            {isCollapsed ? (
              <>
                <span className="text-muted-foreground/60">{line.text} …</span>
                <span className="text-muted-foreground/60">{lines[line.closeIndex].text}</span>
              </>
            ) : (
              line.text
            )}
          </span>
        </div>,
      );
      if (isCollapsed) {
        i = line.closeIndex + 1;
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

  return <div className="font-mono text-xs text-foreground/90">{rows}</div>;
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
                      {msg.data}
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

  /* request editor state */
  const [method, setMethod] = useState<string>('GET');
  const [url, setUrl] = useState('');
  const [params, setParams] = useState<[string, string][]>([newParam()]);
  const [headers, setHeaders] = useState<[string, string][]>([newParam()]);
  const [bodyType, setBodyType] = useState<BodyType>('none');
  const [bodyText, setBodyText] = useState('');
  const [auth, setAuth] = useState<AuthConfig>({ ...EMPTY_AUTH });
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [configTab, setConfigTab] = useState('params');

  const [loading, setLoading] = useState(false);
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
  const wsConnectingRef = useRef(false);

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
    void listen<{ id: string; data: string; timestamp: number }>('api://ws-message', (event) => {
      if (event.payload.id !== WS_ID) return;
      setWsMessages((prev) => [...prev.slice(-499), { dir: 'in', data: event.payload.data, time: Date.now() }]);
    }).then((fn) => unlisteners.push(fn));
    void listen<{ id: string; status: string; error?: string }>('api://ws-status', (event) => {
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

  const applyConfig = useCallback((cfg: RequestConfig) => {
    setMethod(cfg.method);
    setUrl(cfg.url);
    setParams(cfg.params.length > 0 ? cfg.params.map((p) => [...p] as [string, string]) : [newParam()]);
    setHeaders(cfg.headers.length > 0 ? cfg.headers.map((h) => [...h] as [string, string]) : [newParam()]);
    setBodyType(cfg.bodyType);
    setBodyText(cfg.bodyText);
    setAuth({ ...EMPTY_AUTH, ...cfg.auth });
    setTimeoutMs(String(cfg.timeoutMs || 30000));
    setResponse(null);
    setSelectedId(cfg.id);
  }, []);

  /** Parse a pasted URL's query string into the params table so they can be
   *  inspected/edited (like Postman/Insomnia). Runs on every URL edit. */
  const handleUrlChange = useCallback((value: string) => {
    setUrl(value);
    const qIndex = value.indexOf('?');
    if (qIndex === -1) return;
    const qs = value.slice(qIndex + 1).split('#')[0];
    if (!qs) return;
    const safeDecode = (raw: string) => {
      try {
        return decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        return raw;
      }
    };
    const parsed: [string, string][] = qs
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return [safeDecode(pair), ''] as [string, string];
        return [safeDecode(pair.slice(0, eq)), safeDecode(pair.slice(eq + 1))] as [string, string];
      })
      .filter(([k]) => k.trim().length > 0);
    if (parsed.length === 0) return;
    setParams((prev) => {
      // Keep any hand-typed rows; drop the trailing blank row before merging.
      const kept = prev.filter(([k]) => k.trim().length > 0);
      return [...parsed, ...kept];
    });
  }, []);

  const buildRequest = useCallback(() => {
    const vars = activeEnv?.variables ?? [];
    let finalUrl = resolveTemplate(url.trim(), vars);
    const activeParams = params.filter(([k]) => k.trim());
    if (activeParams.length > 0) {
      const qs = activeParams
        .map(([k, v]) => `${encodeURIComponent(k.trim())}=${encodeURIComponent(resolveTemplate(v, vars))}`)
        .join('&');
      finalUrl = finalUrl.includes('?') ? `${finalUrl}&${qs}` : `${finalUrl}?${qs}`;
    }

    const headerMap = new Map<string, string>();
    for (const [k, v] of headers) {
      if (k.trim()) headerMap.set(k.trim(), resolveTemplate(v, vars));
    }
    for (const [k, v] of authToHeaders(auth)) {
      headerMap.set(k, v);
    }
    if (auth.type === 'apikey' && auth.apiKeyIn === 'query' && auth.apiKeyName.trim()) {
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${sep}${encodeURIComponent(auth.apiKeyName.trim())}=${encodeURIComponent(auth.apiKeyValue)}`;
    }

    const finalBody = bodyType === 'none' ? null : resolveTemplate(bodyText, vars);
    if (bodyType === 'form' && finalBody) {
      headerMap.set('Content-Type', 'application/x-www-form-urlencoded');
    }

    return {
      method,
      url: finalUrl,
      headers: Array.from(headerMap.entries()),
      body: finalBody,
      timeoutMs: Number(timeoutMs) || 30000,
    };
  }, [url, params, headers, bodyType, bodyText, auth, timeoutMs, activeEnv, method]);

  const handleSend = useCallback(async () => {
    if (!url.trim()) {
      toast.error(t('toolbox.apiDebug.urlRequired'));
      return;
    }
    setLoading(true);
    setResponse(null);
    try {
      const req = buildRequest();
      const resp = await invoke<RestResponse>('api_request', { request: req });
      setResponse(resp);
      // Huge bodies can't be parsed into a tree — land on the raw view.
      setRespView(resp.body.length > MAX_PARSE_BODY_CHARS ? 'raw' : 'tree');
    } catch (error) {
      toast.error(t('toolbox.apiDebug.requestFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [url, buildRequest, t]);

  const openSaveDialog = useCallback(() => {
    setSaveName(url.split('/').filter(Boolean).pop() || t('toolbox.apiDebug.untitledRequest'));
    setSaveGroup('');
    setSaveDialogOpen(true);
  }, [url, t]);

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
      auth: { ...auth },
      timeoutMs: Number(timeoutMs) || 30000,
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
  }, [saveName, saveGroup, selectedId, method, url, params, headers, bodyType, bodyText, auth, timeoutMs, t]);

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
    setWsStatus('connecting');
    wsConnectingRef.current = true;
    try {
      await invoke('api_ws_connect', { id: WS_ID, url: wsUrl.trim() });
      setWsMessages([]);
      setWsStatus('connected');
    } catch (error) {
      setWsStatus('closed');
      wsConnectingRef.current = false;
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

  const parsedBody = useMemo(() => {
    if (!response || response.bodyIsBase64) return null;
    // Huge bodies are never JSON.parse'd — the formatted view is skipped and
    // only raw (chunked) text is shown.
    if (response.body.length > MAX_PARSE_BODY_CHARS) return null;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return null;
    }
  }, [response]);

  // Pretty-printed JSON text for the formatted (collapsible) view.
  const prettyBody = useMemo(() => {
    if (parsedBody === null) return '';
    try {
      return JSON.stringify(parsedBody, null, 2);
    } catch {
      return '';
    }
  }, [parsedBody]);

  const responseFields = useMemo(() => {
    if (!parsedBody || response?.bodyIsBase64) return null;
    if ((response?.body.length ?? 0) > MAX_FIELD_INFER_CHARS) return null;
    return inferFields(parsedBody);
  }, [parsedBody, response]);

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
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground" onClick={openSaveDialog} title={t('toolbox.apiDebug.newRequest')}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="px-1 pb-2 space-y-0.5">
              {collection.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">{t('toolbox.apiDebug.noCollection')}</p>
              ) : (
                groups.map(([group, items]) => (
                  <div key={group || '__root__'} className="space-y-0.5">
                    {group && (
                      <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                        <FolderOpen className="h-3 w-3" /> {group}
                      </p>
                    )}
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
                  <Button size="sm" className="h-9 gap-1.5 shrink-0" disabled={loading} onClick={() => void handleSend()}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {t('toolbox.apiDebug.send')}
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 gap-1 shrink-0" onClick={openSaveDialog} title={t('toolbox.apiDebug.saveRequest')}>
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
                      {bodyType !== 'none' && (
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
                        {t('toolbox.apiDebug.size')}: {response.bodyIsBase64 ? `[binary] ${response.body.length}` : `${response.body.length} B`}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        {parsedBody !== null && (
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
                    <ScrollArea className="flex-1 min-h-0">
                      {/* Views stay mounted and toggle via hidden — switching
                          tree/raw/fields never rebuilds a large JSON tree. */}
                      {!!responseFields && (
                        <div className={cn('p-3', respView !== 'fields' && 'hidden')}>
                          <FieldTable root={responseFields} />
                        </div>
                      )}
                      {!!parsedBody && (
                        <div className={cn('p-3', respView !== 'tree' && 'hidden')}>
                          <CollapsibleJson text={prettyBody} />
                        </div>
                      )}
                      {!parsedBody && respView === 'tree' && (
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
