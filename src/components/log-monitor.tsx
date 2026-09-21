/**
 * Log Monitor — Business-grade log viewer
 *
 * Inspired by Datadog Log Explorer / Grafana Loki / Kibana:
 *  • Multi-source: log files, journalctl services, Docker containers, custom paths
 *  • Level filter chips (ERROR / WARN / INFO / DEBUG / TRACE)
 *  • Regex search with match highlighting
 *  • Line numbers + parsed timestamps + level badges
 *  • Live tail with configurable refresh interval
 *  • Level statistics in status bar
 *  • Download support
 */

import React, {
  createContext,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useContext,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listCustomLogSourcesForConnection, type CustomLogSource } from "@/lib/log-sources-storage";
import { LogCommandManager } from "./log-command-manager";
import { toast } from "sonner";
import {
  Search,
  RefreshCw,
  Download,
  Plus,
  X,
  Lock,
  Unlock,
  FileText,
  ScrollText,
  Container,
  FolderOpen,
  Play,
  Pause,
  ChevronDown,
  AlertCircle,
  Terminal,
  Settings2,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

import {
  Command as CommandMenu,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Toggle } from "./ui/toggle";
import { Separator } from "./ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "./ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";
import { cn } from "@/lib/utils";

// ── Types ──

interface LogMonitorProps {
  connectionId?: string;
  /** When set, auto-add this file path as a custom source and select it */
  externalLogPath?: string;
  /** Increment to re-trigger loading the same externalLogPath */
  externalLogPathKey?: number;
  /** Only the visible instance fetches or refreshes logs. */
  isActive?: boolean;
}

export interface LogSource {
  id: string;
  name: string;
  source_type: "file" | "journal" | "docker" | "command";
  /** For `command` sources this is the FULL command to execute. */
  path: string;
  category: string;
  size_human?: string;
}

interface LogMonitorState {
  sources: LogSource[];
  /** Persisted user-authored command sources for the active connection. */
  customCommands: CustomLogSource[];
  selectedSourceId: string;
  customPath: string;
  showCustomInput: boolean;
  rawLines: string[];
  searchTerm: string;
  isRegex: boolean;
  activeFilters: Set<LogLevel>;
  lineCount: number;
  autoRefresh: boolean;
  refreshInterval: number;
  scrollLocked: boolean;
}

type LogMonitorStateContext = LogMonitorState & {
  setSources: React.Dispatch<React.SetStateAction<LogSource[]>>;
  setCustomCommands: React.Dispatch<React.SetStateAction<CustomLogSource[]>>;
  setSelectedSourceId: React.Dispatch<React.SetStateAction<string>>;
  setCustomPath: React.Dispatch<React.SetStateAction<string>>;
  setShowCustomInput: React.Dispatch<React.SetStateAction<boolean>>;
  setRawLines: React.Dispatch<React.SetStateAction<string[]>>;
  setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  setIsRegex: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveFilters: React.Dispatch<React.SetStateAction<Set<LogLevel>>>;
  setLineCount: React.Dispatch<React.SetStateAction<number>>;
  setAutoRefresh: React.Dispatch<React.SetStateAction<boolean>>;
  setRefreshInterval: React.Dispatch<React.SetStateAction<number>>;
  setScrollLocked: React.Dispatch<React.SetStateAction<boolean>>;
};

const LogMonitorContext = createContext<LogMonitorStateContext | null>(null);

export function LogMonitorStateProvider({ children }: { children: React.ReactNode }) {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [customCommands, setCustomCommands] = useState<CustomLogSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<LogLevel>>(new Set());
  const [lineCount, setLineCount] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(3);
  const [scrollLocked, setScrollLocked] = useState(true);

  return (
    <LogMonitorContext.Provider value={{
      sources, setSources, customCommands, setCustomCommands, selectedSourceId, setSelectedSourceId,
      customPath, setCustomPath, showCustomInput, setShowCustomInput,
      rawLines, setRawLines, searchTerm, setSearchTerm, isRegex, setIsRegex,
      activeFilters, setActiveFilters, lineCount, setLineCount,
      autoRefresh, setAutoRefresh, refreshInterval, setRefreshInterval,
      scrollLocked, setScrollLocked,
    }}>
      {children}
    </LogMonitorContext.Provider>
  );
}

function useLogMonitorState(): LogMonitorStateContext {
  const state = useContext(LogMonitorContext);
  if (!state) throw new Error("LogMonitor must be rendered inside LogMonitorStateProvider");
  return state;
}

interface LogSourcesResponse {
  success: boolean;
  sources: LogSource[];
  error?: string;
}

type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "unknown";

interface ParsedLogLine {
  lineNumber: number;
  raw: string;
  level: LogLevel;
  timestamp?: string;
  message: string;
}

// ── Constants ──

const LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"];

const LEVEL_COLORS: Record<LogLevel, { bg: string; text: string; badge: string }> = {
  error: {
    bg: "bg-red-500/10",
    text: "text-red-400",
    badge: "bg-red-500/20 text-red-400 border-red-500/30",
  },
  warn: {
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  },
  info: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    badge: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  },
  debug: {
    bg: "bg-gray-500/10",
    text: "text-gray-400",
    badge: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  },
  trace: {
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    badge: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  },
  unknown: {
    bg: "",
    text: "text-foreground",
    badge: "bg-muted text-muted-foreground border-border",
  },
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  error: "E",
  warn: "W",
  info: "I",
  debug: "D",
  trace: "T",
  unknown: "?",
};

const LINE_COUNT_OPTIONS = [50, 100, 200, 500, 1000];
const REFRESH_INTERVALS = [
  { value: 1, label: "1s" },
  { value: 2, label: "2s" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
];

// ── Utility Functions ──

/** Detect log level from a raw log line */
function detectLevel(line: string): LogLevel {
  const lower = line.toLowerCase();
  if (/\b(error|err\b|fatal|crit(?:ical)?|panic|exception|fail(?:ed|ure)?)\b/.test(lower))
    return "error";
  if (/\b(warn(?:ing)?)\b/.test(lower)) return "warn";
  if (/\b(info|notice)\b/.test(lower)) return "info";
  if (/\b(debug|dbg)\b/.test(lower)) return "debug";
  if (/\b(trace|verbose)\b/.test(lower)) return "trace";
  return "unknown";
}

/** Extract timestamp from common log formats */
function extractTimestamp(line: string): { timestamp?: string; rest: string } {
  // ISO format: 2024-01-15T10:30:01.123Z or 2024-01-15 10:30:01
  const isoMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/
  );
  if (isoMatch) {
    return { timestamp: isoMatch[1], rest: isoMatch[2] };
  }

  // Syslog format: Jan 15 10:30:01
  const syslogMatch = line.match(
    /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/
  );
  if (syslogMatch) {
    return { timestamp: syslogMatch[1], rest: syslogMatch[2] };
  }

  // Brackets format: [2024-01-15 10:30:01]
  const bracketMatch = line.match(
    /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/
  );
  if (bracketMatch) {
    return { timestamp: bracketMatch[1], rest: bracketMatch[2] };
  }

  // Time only: 10:30:01 or 10:30:01.123
  const timeMatch = line.match(
    /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.*)$/
  );
  if (timeMatch) {
    return { timestamp: timeMatch[1], rest: timeMatch[2] };
  }

  return { rest: line };
}

/** Parse raw lines into structured log entries */
/** Streaming line buffer cap — older lines are dropped from the top. */
export const STREAM_LINE_CAP = 5000;

/**
 * Append a streaming chunk to the line buffer.
 *
 * Chunks arrive at arbitrary byte boundaries: a chunk may end mid-line, so
 * the trailing partial line is carried in `pending` and prepended to the
 * next chunk. When the buffer exceeds `cap` lines the OLDEST lines are
 * dropped (a live tail only ever needs the recent window).
 * Pure function — unit-tested directly.
 */
export function appendChunk(
  lines: readonly string[],
  pending: string,
  chunk: string,
  cap: number,
): { lines: string[]; pending: string } {
  const merged = pending + chunk;
  const parts = merged.split("\n");
  const nextPending = parts.pop() ?? "";
  const out = lines.length >= cap ? lines.slice(lines.length - cap) : [...lines];
  for (const part of parts) {
    if (out.length >= cap) out.shift();
    out.push(part);
  }
  return { lines: out, pending: nextPending };
}

function parseLogLines(rawLines: string[]): ParsedLogLine[] {
  return rawLines
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      const level = detectLevel(line);
      const { timestamp, rest } = extractTimestamp(line);
      return {
        lineNumber: i + 1,
        raw: line,
        level,
        timestamp,
        message: rest,
      };
    });
}

/** Group log sources by type for the dropdown */
function groupSources(sources: LogSource[]) {
  const groups: Record<string, LogSource[]> = {};
  for (const src of sources) {
    const key = src.source_type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(src);
  }
  return groups;
}

type SourceTypeLabelKey =
  | "logMonitor.sourceTypeFile"
  | "logMonitor.sourceTypeJournal"
  | "logMonitor.sourceTypeDocker"
  | "logMonitor.sourceTypeCommand";

const SOURCE_TYPE_LABELS: Record<string, { icon: React.ReactNode; labelKey: SourceTypeLabelKey }> = {
  file: { icon: <FileText className="h-3 w-3 inline mr-1" />, labelKey: "logMonitor.sourceTypeFile" },
  journal: { icon: <ScrollText className="h-3 w-3 inline mr-1" />, labelKey: "logMonitor.sourceTypeJournal" },
  docker: { icon: <Container className="h-3 w-3 inline mr-1" />, labelKey: "logMonitor.sourceTypeDocker" },
  command: { icon: <Terminal className="h-3 w-3 inline mr-1" />, labelKey: "logMonitor.sourceTypeCommand" },
};

// ── Component ──

export function LogMonitor({ connectionId, externalLogPath, externalLogPathKey, isActive = true }: LogMonitorProps) {
  const { t } = useTranslation();
  const {
    sources, setSources, customCommands, setCustomCommands, selectedSourceId, setSelectedSourceId,
    customPath, setCustomPath, showCustomInput, setShowCustomInput,
    rawLines, setRawLines, searchTerm, setSearchTerm, isRegex, setIsRegex,
    activeFilters, setActiveFilters, lineCount, setLineCount,
    autoRefresh, setAutoRefresh, refreshInterval, setRefreshInterval,
    scrollLocked, setScrollLocked,
  } = useLogMonitorState();
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [sourceSearchOpen, setSourceSearchOpen] = useState(false);

  // ── Streaming (command sources: tail -f style) ──
  const [streamId, setStreamId] = useState<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const pendingLineRef = useRef<string>("");
  const stopStream = useCallback(async (id: string | null) => {
    const target = id ?? streamIdRef.current;
    streamIdRef.current = null;
    setStreamId(null);
    if (target) {
      try { await invoke("log_stream_stop", { streamId: target }); } catch { /* already ended */ }
    }
  }, []);

  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);

  // ── Source discovery ──

  const discoverSources = useCallback(async () => {
    if (!connectionId) return;
    setIsDiscovering(true);
    try {
      const result = await invoke<LogSourcesResponse>("discover_log_sources", {
        connectionId,
      });
      if (result.success) {
        setSources(result.sources);
        if (result.sources.length === 0) {
          toast.info(t('logMonitor.noSourcesDiscovered'));
        }
      } else if (result.error && (
        result.error.includes('Connection not found') ||
        result.error.includes('Session not found')
      )) {
        // Transient: the SSH session was just created and may not be fully
        // initialized yet. Silently skip — the user can rediscover later.
        console.debug('[LogMonitor] Session not ready yet, skipping source discovery:', result.error);
      } else {
        toast.error(t('logMonitor.failedToDiscoverSources'), {
          description: result.error,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Connection not found') || msg.includes('Session not found')) {
        console.debug('[LogMonitor] Session not ready yet, skipping source discovery:', msg);
      } else {
        toast.error(t('logMonitor.failedToDiscoverSources'), {
          description: msg,
        });
      }
    } finally {
      setIsDiscovering(false);
    }
  }, [connectionId, setSources, t]);

  // Auto-discover on mount
  useEffect(() => {
    if (connectionId && isActive) {
      void discoverSources();
    }
  }, [connectionId, discoverSources, isActive]);

  // ── Persisted custom command sources (per connection) ──
  const reloadCustomCommands = useCallback(async () => {
    if (!connectionId) {
      setCustomCommands([]);
      return;
    }
    try {
      setCustomCommands(await listCustomLogSourcesForConnection(connectionId));
    } catch (err) {
      console.error("[LogMonitor] failed to load custom log sources:", err);
    }
  }, [connectionId, setCustomCommands]);

  useEffect(() => {
    void reloadCustomCommands();
  }, [reloadCustomCommands]);

  // ── Unified source list: discovered + persisted custom commands ──
  const allSources = useMemo(() => {
    const cmdSources: LogSource[] = customCommands.map((c) => ({
      id: `cmd:${c.id}`,
      name: c.name,
      source_type: "command" as const,
      path: c.command,
      category: "command",
    }));
    return [...sources, ...cmdSources];
  }, [sources, customCommands]);

  // ── Find selected source ──
  const selectedSource = useMemo(
    () => allSources.find((s) => s.id === selectedSourceId) ?? null,
    [allSources, selectedSourceId]
  );

  // ── log-stream event listener (single subscription, filters by id) ──
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<{
      type: "data" | "end" | "error";
      streamId: string;
      data?: string;
      exitCode?: number;
      message?: string;
    }>("log-stream", (event) => {
      const payload = event.payload;
      if (payload.streamId !== streamIdRef.current) return;
      if (payload.type === "data" && payload.data) {
        // Function-state update keeps the listener independent of the render
        // cycle (no re-subscribe on every line, no lost chunk between
        // unlisten/listen).
        setRawLines((prev) => {
          const { lines, pending } = appendChunk(prev, pendingLineRef.current, payload.data ?? "", STREAM_LINE_CAP);
          pendingLineRef.current = pending;
          return lines;
        });
        if (scrollLocked) {
          requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          });
        }
      } else if (payload.type === "end") {
        streamIdRef.current = null;
        setStreamId(null);
        if ((payload.exitCode ?? 0) !== 0 && payload.exitCode !== undefined && payload.exitCode !== 4294967295) {
          toast.warning(t('logMonitor.streamExited'), { description: `exit ${payload.exitCode}` });
        }
      } else if (payload.type === "error") {
        streamIdRef.current = null;
        setStreamId(null);
        toast.error(t('logMonitor.streamFailed'), { description: payload.message ?? "" });
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [scrollLocked, setRawLines, t]);

  // Start a streaming command source (tail -f style).
  const startStream = useCallback(async (command: string) => {
    await stopStream(null);
    pendingLineRef.current = "";
    setRawLines([]);
    setIsLoading(true);
    try {
      const id = await invoke<string>("log_stream_start", { connectionId, command });
      streamIdRef.current = id;
      setStreamId(id);
    } catch (err) {
      toast.error(t('logMonitor.streamFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  }, [connectionId, setRawLines, stopStream, t]);

  // ── Load log content ──

  const loadLog = useCallback(
    async (isAutoRefresh = false) => {
      if (!connectionId || !selectedSourceId) return;

      // Determine source type and path
      let sourceType = "file";
      let path = selectedSourceId;

      if (selectedSourceId.startsWith("custom:")) {
        sourceType = "custom";
        path = selectedSourceId.replace("custom:", "");
      } else if (selectedSource) {
        sourceType = selectedSource.source_type;
        path = selectedSource.path;
      }

      if (!isAutoRefresh) setIsLoading(true);

      try {
        const result = await invoke<{
          success: boolean;
          output?: string;
          error?: string;
        }>("read_log", {
          connectionId,
          sourceType,
          path,
          lines: lineCount,
        });

        if (result.success && result.output) {
          const _prevScrollHeight = scrollRef.current?.scrollHeight ?? 0;
          const wasAtBottom = scrollRef.current
            ? scrollRef.current.scrollHeight -
                scrollRef.current.scrollTop -
                scrollRef.current.clientHeight <
              50
            : true;

          setRawLines(result.output.split("\n"));

          // Auto-scroll to bottom if locked
          if (scrollLocked || wasAtBottom) {
            requestAnimationFrame(() => {
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            });
          }
        } else if (!isAutoRefresh) {
          toast.error(t('logMonitor.failedToLoadLog'), {
            description: result.error ?? t('logMonitor.unknownError'),
          });
        }
      } catch (err) {
        if (!isAutoRefresh) {
          toast.error(t('logMonitor.failedToLoadLog'), {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!isAutoRefresh) setIsLoading(false);
      }
    },
    [connectionId, selectedSourceId, selectedSource, lineCount, scrollLocked, setRawLines, t]
  );

  // Load when source changes. Command sources STREAM (tail -f) instead of
  // one-shot read; any previous stream is stopped first.
  useEffect(() => {
    if (!isActive || !selectedSourceId) {
      void stopStream(null);
      return;
    }
    if (selectedSource?.source_type === "command" && selectedSource.path) {
      void startStream(selectedSource.path);
      return;
    }
    void stopStream(null);
    void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, selectedSourceId]);

  // Stop the stream when the component unmounts.
  useEffect(() => () => { void stopStream(null); }, [stopStream]);

  // Auto-refresh timer (poll sources only; command sources stream instead)
  useEffect(() => {
    if (!isActive || !autoRefresh || !selectedSourceId) return;
    if (selectedSource?.source_type === "command") return;
    const interval = setInterval(
      () => { void loadLog(true); },
      refreshInterval * 1000
    );
    return () => clearInterval(interval);
  }, [isActive, autoRefresh, selectedSourceId, refreshInterval, loadLog]);

  // Handle external log path (sent from file browser)
  useEffect(() => {
    if (!isActive || !externalLogPath) return;
    const path = externalLogPath.trim();
    if (!path) return;

    const id = `custom:${path}`;
    const name = path.split("/").pop() ?? path;

    // Add to sources if not already present
    setSources((prev) => {
      if (prev.some((s) => s.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          name,
          source_type: "file" as const,
          path,
          category: "custom",
          size_human: undefined,
        },
      ];
    });

    // Select and load it
    setSelectedSourceId(id);
  }, [isActive, externalLogPath, externalLogPathKey, setSelectedSourceId, setSources]);

  // ── Parse and filter lines ──

  const parsedLines = useMemo(() => parseLogLines(rawLines), [rawLines]);

  const filteredLines = useMemo(() => {
    let lines = parsedLines;

    // Filter by level
    if (activeFilters.size > 0) {
      lines = lines.filter((l) => activeFilters.has(l.level));
    }

    // Filter by search term
    if (searchTerm) {
      if (isRegex) {
        try {
          const re = new RegExp(searchTerm, "i");
          lines = lines.filter((l) => re.test(l.raw));
        } catch {
          // Invalid regex, fall back to literal
          const lower = searchTerm.toLowerCase();
          lines = lines.filter((l) => l.raw.toLowerCase().includes(lower));
        }
      } else {
        const lower = searchTerm.toLowerCase();
        lines = lines.filter((l) => l.raw.toLowerCase().includes(lower));
      }
    }

    return lines;
  }, [parsedLines, activeFilters, searchTerm, isRegex]);

  // ── Level statistics ──

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
      trace: 0,
      unknown: 0,
    };
    for (const line of parsedLines) {
      counts[line.level]++;
    }
    return counts;
  }, [parsedLines]);

  // ── Event handlers ──

  const handleSourceChange = useCallback((value: string) => {
    setSelectedSourceId(value);
    setAutoRefresh(false);
  }, [setAutoRefresh, setSelectedSourceId]);

  const handleAddCustomPath = useCallback(() => {
    const path = customPath.trim();
    if (!path) return;

    const id = `custom:${path}`;
    const name = path.split("/").pop() ?? path;

    // Add to sources if not already present
    setSources((prev) => {
      if (prev.some((s) => s.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          name,
          source_type: "file" as const,
          path,
          category: "custom",
          size_human: undefined,
        },
      ];
    });

    setSelectedSourceId(id);
    setCustomPath("");
    setShowCustomInput(false);
  }, [customPath, setCustomPath, setSelectedSourceId, setShowCustomInput, setSources]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, [setActiveFilters]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;

    if (isAtBottom && !scrollLocked) {
      setScrollLocked(true);
    } else if (
      !isAtBottom &&
      scrollLocked &&
      el.scrollTop < lastScrollTop.current
    ) {
      setScrollLocked(false);
    }

    lastScrollTop.current = el.scrollTop;
  }, [scrollLocked, setScrollLocked]);

  const handleDownload = useCallback(() => {
    const text = rawLines.join("\n");
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const sourceName =
      selectedSource?.name ?? selectedSourceId.replace("custom:", "").split("/").pop() ?? "log";
    a.download = `${sourceName}_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    // WebKit requires the anchor to be in the document for the click to fire
    // a download (matches PtyTerminal's download implementation).
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rawLines, selectedSource, selectedSourceId]);

  // ── Search highlight helper ──

  const highlightSearch = useCallback(
    (text: string) => {
      if (!searchTerm) return text;

      try {
        const re = isRegex
          ? new RegExp(`(${searchTerm})`, "gi")
          : new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");

        const parts = text.split(re);
        if (parts.length <= 1) return text;

        return parts.map((part, i) =>
          re.test(part) ? (
            <mark
              key={i}
              className="bg-yellow-400/40 text-yellow-200 rounded-sm px-0.5"
            >
              {part}
            </mark>
          ) : (
            part
          )
        );
      } catch {
        return text;
      }
    },
    [searchTerm, isRegex]
  );

  // ── Grouped sources for dropdown ──

  const groupedSources = useMemo(() => groupSources(allSources), [allSources]);

  // ── No connection state ──

  if (!connectionId) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        {t('logMonitor.connectToViewLogs')}
      </div>
    );
  }

  // ── Render ──

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full flex flex-col text-foreground">
        {/* ── Row 1: Source selector ── */}
        <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/30 shrink-0">
          <Popover open={sourceSearchOpen} onOpenChange={setSourceSearchOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="h-7 text-xs flex-1 min-w-0 justify-between font-normal"
              >
                <span className="truncate">
                  {selectedSource ? selectedSource.name : t('logMonitor.selectLogSource')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-0" align="start">
              <CommandMenu>
                <CommandInput placeholder={t('logMonitor.searchSources')} className="h-8 text-xs" />
                <CommandList>
                  <CommandEmpty className="text-xs py-3 text-center">
                    {t('logMonitor.noSourceMatch')}
                  </CommandEmpty>
                  {Object.entries(groupedSources).map(([type, items]) => {
                    const meta = SOURCE_TYPE_LABELS[type] ?? {
                      icon: <FileText className="h-3 w-3 inline mr-1" />,
                      labelKey: "logMonitor.sourceTypeFile",
                    };
                    return (
                      <CommandGroup
                        key={type}
                        heading={
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                            {meta.icon}
                            {t(meta.labelKey)}
                          </span>
                        }
                      >
                        {items.map((src) => (
                          <CommandItem
                            key={src.id}
                            value={`${src.name} ${src.path}`}
                            onSelect={() => {
                              handleSourceChange(src.id);
                              setSourceSearchOpen(false);
                            }}
                            className="text-xs"
                          >
                            <div className="flex items-center justify-between gap-2 w-full min-w-0" title={src.path}>
                              <span className="truncate min-w-0 flex-1">
                                {src.source_type === "command" ? `${src.name}` : src.name}
                              </span>
                              {src.size_human ? (
                                <span className="text-[10px] text-muted-foreground shrink-0">{src.size_human}</span>
                              ) : src.source_type === "command" ? (
                                <Terminal className="h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : null}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    );
                  })}

                  {/* Ad-hoc custom paths (file-browser handoff / quick add) */}
                  {sources.some((s) => s.category === "custom") && (
                    <CommandGroup
                      heading={
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                          <FolderOpen className="h-3 w-3 inline mr-1" />
                          {t('logMonitor.customPaths')}
                        </span>
                      }
                    >
                      {sources
                        .filter((s) => s.category === "custom")
                        .map((src) => (
                          <CommandItem
                            key={src.id}
                            value={src.path}
                            onSelect={() => {
                              handleSourceChange(src.id);
                              setSourceSearchOpen(false);
                            }}
                            className="text-xs"
                          >
                            <span className="truncate">{src.path}</span>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </CommandMenu>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={discoverSources}
                disabled={isDiscovering}
              >
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5",
                    isDiscovering && "animate-spin"
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.rediscoverSources')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={showCustomInput ? "secondary" : "ghost"}
                className="h-7 w-7 shrink-0"
                onClick={() => setShowCustomInput(!showCustomInput)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.addCustomPath')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => setManageOpen(true)}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.manageCommands')}</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-4 mx-0.5" />

          {/* Auto-refresh toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={selectedSource?.source_type === "command" ? (streamId ? "default" : "ghost") : (autoRefresh ? "default" : "ghost")}
                className={cn(
                  "h-7 w-7 shrink-0",
                  ((selectedSource?.source_type === "command" && streamId) || (selectedSource?.source_type !== "command" && autoRefresh)) &&
                    "bg-green-600 hover:bg-green-700 text-white"
                )}
                onClick={() => {
                  if (selectedSource?.source_type === "command") {
                    if (streamId) void stopStream(null);
                    else if (selectedSource.path) void startStream(selectedSource.path);
                    return;
                  }
                  setAutoRefresh(!autoRefresh);
                }}
                disabled={!selectedSourceId}
              >
                {(selectedSource?.source_type === "command" ? Boolean(streamId) : autoRefresh) ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {selectedSource?.source_type === "command"
                ? streamId
                  ? t('logMonitor.streamStop')
                  : t('logMonitor.streamStart')
                : autoRefresh
                  ? t('logMonitor.stopLiveTail')
                  : t('logMonitor.startLiveTail')}
            </TooltipContent>
          </Tooltip>

          {/* Refresh interval selector */}
          {autoRefresh && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-[10px] shrink-0 gap-0.5"
                >
                  {refreshInterval}s
                  <ChevronDown className="h-2.5 w-2.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" side="bottom" align="end">
                <div className="flex flex-col gap-0.5">
                  {REFRESH_INTERVALS.map((opt) => (
                    <Button
                      key={opt.value}
                      variant={
                        refreshInterval === opt.value ? "secondary" : "ghost"
                      }
                      size="sm"
                      className="h-6 text-xs justify-start"
                      onClick={() => setRefreshInterval(opt.value)}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={handleDownload}
                disabled={rawLines.length === 0}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.downloadLogs')}</TooltipContent>
          </Tooltip>
        </div>

        {/* ── Optional: Custom path input ── */}
        {showCustomInput && (
          <div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/20 shrink-0">
            <Input
              placeholder={t('logMonitor.customPathPlaceholder')}
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddCustomPath()}
              className="h-7 text-xs flex-1"
              autoFocus
            />
            <Button
              size="sm"
              className="h-7 text-xs px-2"
              onClick={handleAddCustomPath}
              disabled={!customPath.trim()}
            >
              {t('logMonitor.add')}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setShowCustomInput(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* ── Row 2: Filters ── */}
        <div className="flex items-center gap-1 px-2 py-1 border-b shrink-0">
          {/* Search input */}
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <Input
              placeholder={t('logMonitor.searchLogs')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-7 text-xs pl-7 pr-7"
            />
            {searchTerm && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchTerm("")}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Regex toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={isRegex}
                onPressedChange={setIsRegex}
                className="h-7 w-7 shrink-0 text-[10px] font-mono data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                .*
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.toggleRegex')}</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-4 mx-0.5" />

          {/* Level filter chips */}
          {LOG_LEVELS.map((level) => {
            const active = activeFilters.has(level);
            const count = levelCounts[level];
            const colors = LEVEL_COLORS[level];
            return (
              <Tooltip key={level}>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "h-6 min-w-6 px-1.5 rounded text-[10px] font-semibold border transition-all shrink-0",
                      active ? colors.badge : "border-transparent text-muted-foreground/50 hover:text-muted-foreground"
                    )}
                    onClick={() => toggleLevel(level)}
                  >
                    {LEVEL_LABELS[level]}
                    {count > 0 && active && (
                      <span className="ml-0.5 font-normal">{count}</span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('logMonitor.filterLevel', { level: level.toUpperCase(), count })}
                </TooltipContent>
              </Tooltip>
            );
          })}

          <Separator orientation="vertical" className="h-4 mx-0.5" />

          {/* Line count selector */}
          <Select
            value={String(lineCount)}
            onValueChange={(v) => setLineCount(Number(v))}
            disabled={selectedSource?.source_type === "command"}
          >
            <SelectTrigger className="h-7 w-[70px] text-[10px] shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINE_COUNT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">
                  {t('logMonitor.nLines', { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Manual load button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className="h-7 text-xs px-2 shrink-0"
                onClick={() => {
                  if (selectedSource?.source_type === "command" && selectedSource.path) {
                    void startStream(selectedSource.path);
                  } else {
                    void loadLog();
                  }
                }}
                disabled={!selectedSourceId || isLoading}
              >
                {isLoading ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  t('logMonitor.load')
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.reloadContent')}</TooltipContent>
          </Tooltip>
        </div>

        {/* ── Log content area ── */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-[18px]"
          onScroll={handleScroll}
        >
          {!selectedSourceId ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <FileText className="h-8 w-8 opacity-40" />
              <p className="text-xs">{t('logMonitor.selectSourceToBegin')}</p>
              {sources.length === 0 && !isDiscovering && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={discoverSources}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {t('logMonitor.discoverSources')}
                </Button>
              )}
            </div>
          ) : isLoading && rawLines.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-xs">{t('logMonitor.loadingLogs')}</span>
            </div>
          ) : filteredLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-1">
              <AlertCircle className="h-6 w-6 opacity-40" />
              <p className="text-xs">
                {rawLines.length > 0
                  ? t('logMonitor.noMatchingLines')
                  : t('logMonitor.noLogContent')}
              </p>
            </div>
          ) : (
            <div className="py-0.5">
              {filteredLines.map((line) => (
                <div
                  key={`${line.lineNumber}-${line.raw.substring(0, 20)}`}
                  className={cn(
                    "flex items-start px-1 py-0 hover:bg-muted/40 transition-colors group",
                    line.level !== "unknown" && LEVEL_COLORS[line.level].bg
                  )}
                >
                  {/* Line number */}
                  <span className="w-9 text-right text-[10px] text-muted-foreground/40 select-none shrink-0 pr-2 pt-px">
                    {line.lineNumber}
                  </span>

                  {/* Timestamp */}
                  {line.timestamp && (
                    <span className="text-muted-foreground shrink-0 mr-1.5 whitespace-nowrap text-[10px] pt-px">
                      {line.timestamp}
                    </span>
                  )}

                  {/* Level badge */}
                  {line.level !== "unknown" && (
                    <span
                      className={cn(
                        "inline-block w-[3ch] text-center text-[10px] font-bold shrink-0 mr-1.5 pt-px",
                        LEVEL_COLORS[line.level].text
                      )}
                    >
                      {LEVEL_LABELS[line.level]}
                    </span>
                  )}

                  {/* Message */}
                  <span
                    className={cn(
                      "break-all whitespace-pre-wrap min-w-0",
                      LEVEL_COLORS[line.level].text
                    )}
                  >
                    {highlightSearch(line.message)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="flex items-center justify-between px-2 py-0.5 text-[10px] text-muted-foreground border-t bg-muted/30 shrink-0">
          {/* Line counts */}
          <span>
            {filteredLines.length === parsedLines.length
              ? t('logMonitor.nLines', { count: parsedLines.length })
              : t('logMonitor.filteredLines', { filtered: filteredLines.length, total: parsedLines.length })}
          </span>

          {/* Level statistics */}
          <div className="flex items-center gap-1.5">
            {LOG_LEVELS.map((level) => {
              const count = levelCounts[level];
              if (count === 0) return null;
              return (
                <span
                  key={level}
                  className={cn("font-medium", LEVEL_COLORS[level].text)}
                >
                  {LEVEL_LABELS[level]}:{count}
                </span>
              );
            })}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1.5">
            {autoRefresh && (
              <span className="flex items-center gap-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <span className="text-green-400">{t('logMonitor.live')}</span>
              </span>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="hover:text-foreground transition-colors"
                  onClick={() => setScrollLocked(!scrollLocked)}
                >
                  {scrollLocked ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Unlock className="h-3 w-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {scrollLocked
                  ? t('logMonitor.scrollLocked')
                  : t('logMonitor.scrollUnlocked')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

        <LogCommandManager
          open={manageOpen}
          onOpenChange={setManageOpen}
          connectionId={connectionId}
          onChanged={() => { void reloadCustomCommands(); }}
        />
    </TooltipProvider>
  );
}
