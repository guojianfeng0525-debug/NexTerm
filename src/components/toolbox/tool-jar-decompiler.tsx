/**
 * JAR decompiler tool — open a JAR, browse classes, decompile (jd-core, JD-GUI engine), edit
 * (CodeMirror 6), compile (javac) and rebuild a new JAR. The original JAR is
 * never modified.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { open, save } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import {
  Archive,
  FolderOpen,
  FileCode2,
  RefreshCw,
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  X,
  Download,
  History,
  Info,
  GitBranch,
  CornerDownRight,
  ChevronLeft,
  Settings,
  FileText,
  Filter,
  FileSearch,
} from 'lucide-react';
import { jarApi, type ClassView, type PackageNode, type ProjectSummary, type CompileDiagnostic, type ClassRef } from '@/lib/toolbox/jar-api';
import { useWebviewFileDrop } from '@/lib/use-webview-file-drop';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorState, StateField, StateEffect, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { java } from '@codemirror/lang-java';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

type BottomTab = 'output' | 'search';

interface ExportProgressEvent {
  projectId: string;
  phase: 'preparing' | 'processing' | 'decompiling' | 'failed' | 'packing' | 'completed' | 'cancelled';
  completed: number;
  total: number;
  className?: string;
  message?: string;
}

/** Hover underline for a known class reference (JD-GUI style). */
const setHoverEffect = StateEffect.define<{ from: number; to: number } | null>();
const hoverField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHoverEffect)) return e.value;
    }
    if (tr.docChanged) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (range) =>
      range
        ? Decoration.set([Decoration.mark({ attributes: { style: 'text-decoration: underline dotted #3b82f6; cursor: pointer;' } }).range(range.from, range.to)])
        : Decoration.none,
    ),
});

/** Double-click word → green highlight of every occurrence (JD-GUI). */
const setDblClickWordEffect = StateEffect.define<{ from: number; to: number }[] | null>();
const dblClickWordField = StateField.define<{ from: number; to: number }[] | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDblClickWordEffect)) return e.value;
    }
    if (tr.docChanged) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (ranges) =>
      ranges && ranges.length > 0
        ? Decoration.set(
            ranges.map((r) =>
              Decoration.mark({ attributes: { style: 'background-color: rgba(34,197,94,0.25); border-radius: 2px;' } }).range(r.from, r.to),
            ),
          )
        : Decoration.none,
    ),
});

/** JD-GUI Find: every occurrence of the query is highlighted (amber), and the
 *  active match gets a stronger border. `setFindEffect` carries the query,
 *  case flag and active range; the field recomputes matches on doc change. */
const setFindEffect = StateEffect.define<{ query: string; caseSensitive: boolean; active: { from: number; to: number } | null } | null>();
interface FindState {
  query: string;
  caseSensitive: boolean;
  active: { from: number; to: number } | null;
  ranges: { from: number; to: number }[];
}
const findHighlightField = StateField.define<FindState>({
  create: () => ({ query: '', caseSensitive: false, active: null, ranges: [] }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindEffect)) {
        const v = e.value;
        if (!v || !v.query) return { query: '', caseSensitive: false, active: null, ranges: [] };
        const ranges: { from: number; to: number }[] = [];
        const doc = tr.state.doc.toString();
        const needle = v.caseSensitive ? v.query : v.query.toLowerCase();
        let idx = 0;
        if (needle) {
          const hay = v.caseSensitive ? doc : doc.toLowerCase();
          while ((idx = hay.indexOf(needle, idx)) !== -1) {
            ranges.push({ from: idx, to: idx + needle.length });
            idx += needle.length;
          }
        }
        return { query: v.query, caseSensitive: v.caseSensitive, active: v.active, ranges };
      }
    }
    if (tr.docChanged) {
      // Recompute on edits while keeping the query.
      if (!value.query) return value;
      const ranges: { from: number; to: number }[] = [];
      const doc = tr.state.doc.toString();
      const needle = value.caseSensitive ? value.query : value.query.toLowerCase();
      let idx = 0;
      if (needle) {
        const hay = value.caseSensitive ? doc : doc.toLowerCase();
        while ((idx = hay.indexOf(needle, idx)) !== -1) {
          ranges.push({ from: idx, to: idx + needle.length });
          idx += needle.length;
        }
      }
      return { ...value, ranges };
    }
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (s) => {
      const decos: import('@codemirror/state').Range<Decoration>[] = [];
      for (const r of s.ranges) {
        const isActive = s.active && r.from === s.active.from && r.to === s.active.to;
        decos.push(
          Decoration.mark({
            attributes: isActive
              ? { style: 'background-color: rgba(245,158,11,0.4); outline: 1px solid rgba(245,158,11,0.9); border-radius: 2px;' }
              : { style: 'background-color: rgba(245,158,11,0.18); border-radius: 2px;' },
          }).range(r.from, r.to),
        );
      }
      return decos.length ? Decoration.set(decos) : Decoration.none;
    }),
});

/** JD-GUI reduceRecentFilePath: shorten long paths with a middle ellipsis. */
function shortenRecentPath(path: string): string {
  const MAX = 200; // JD-GUI reduceRecentFilePath cap
  if (path.length <= MAX) return path;
  const keep = Math.floor((MAX - 3) / 2);
  return `${path.slice(0, keep)}...${path.slice(path.length - keep)}`;
}

/** Extract the identifier word at a document position (shared by click + hover). */
function wordAt(view: EditorView, pos: number): { word: string; from: number; to: number } | null {  if (pos === null || pos < 0 || pos > view.state.doc.length) return null;
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const before = lineText.slice(0, pos - line.from);
  const after = lineText.slice(pos - line.from);
  // Walk backwards from the cursor to the identifier start. (A naive
  // regex search on `before` would fail when the clicked identifier is the
  // first word on the line, e.g. `import org.apache.commons.io.IOUtils`.)
  let wordStart = before.length;
  while (wordStart > 0 && /[A-Za-z0-9_$]/.test(before[wordStart - 1])) wordStart--;
  let wordEnd = 0;
  while (wordEnd < after.length && /[A-Za-z0-9_$]/.test(after[wordEnd])) wordEnd++;
  const word = lineText.slice(wordStart, (pos - line.from) + wordEnd);
  if (!word || !/^[A-Za-z_$]/.test(word)) return null;
  return { word, from: line.from + wordStart, to: line.from + (pos - line.from) + wordEnd };
}

/**
 * Class binary name (com.example.Foo) → entry path (com/example/Foo.class).
 */
function classNameToEntryPath(name: string): string {
  return name.replace(/\./g, '/') + '.class';
}

/**
 * Collect every known class simple-name into a Set (for hover underline +
 * click-to-jump). Recurses package nodes; adds both the simple name and the
 * fully-qualified name.
 */
function collectClassNames(tree: Record<string, PackageNode> | null, set: Set<string>) {
  if (!tree) return;
  const visit = (node: PackageNode) => {
    for (const cls of node.classes) {
      if (cls.kind === 'class') {
        const simple = cls.className.split('.').pop() ?? cls.className;
        set.add(simple);
        set.add(cls.className);
      }
    }
    for (const sub of Object.values(node.packages)) visit(sub);
  };
  for (const node of Object.values(tree)) visit(node);
}

/**
 * JD-GUI tree normalization:
 *  - hide inner classes (Foo$Inner) from the main tree
 *  - mark META-INF nodes distinctly (they already carry a "meta-inf" kind)
 * Returns a new tree without mutating the source.
 */
function normalizeTree(tree: Record<string, PackageNode>): Record<string, PackageNode> {
  const visit = (node: PackageNode): PackageNode => {
    const classes = node.classes.filter((c) => !c.isInnerClass);
    const packages: Record<string, PackageNode> = {};
    for (const [name, sub] of Object.entries(node.packages)) {
      packages[name] = visit(sub);
    }
    return { name: node.name, classes, packages };
  };
  const out: Record<string, PackageNode> = {};
  for (const [name, node] of Object.entries(tree)) {
    out[name] = visit(node);
  }
  return out;
}

/**
 * JD-GUI package aggregation: a package branch that is just a single chain of
 * one-child packages (no classes along the way) collapses into one node whose
 * label shows the joined dotted name (com → example → demo becomes
 * "com.example.demo"). Mirrors PackageTreeNodeFactoryProvider's aggregation
 * loop. The label rendering already shows the LAST segment; this keeps the
 * tree from showing empty intermediate levels.
 */
function aggregatePackages(node: PackageNode): PackageNode {
  // Recursively aggregate children first.
  const packages: Record<string, PackageNode> = {};
  for (const [name, sub] of Object.entries(node.packages)) {
    packages[name] = aggregatePackages(sub);
  }
  let merged: PackageNode = { ...node, packages };
  // If this node has no classes and exactly one child package, merge: the
  // child's content inherits this node's name chain.
  while (merged.classes.length === 0 && Object.keys(merged.packages).length === 1) {
    const [childName, child] = Object.entries(merged.packages)[0];
    const joined = merged.name ? `${merged.name}.${childName}` : childName;
    merged = { ...child, name: joined };
  }
  return merged;
}

/** Build the clickability index from the backend's dotted class names. */
function buildKnownNames(names: string[], simple: string[]) {
  return {
    dotted: new Set(names),
    simple: new Set(simple),
    slash: new Set(names.map((n) => n.replace(/\./g, '/'))),
  };
}

/**
 * JD-GUI style live tree filter: keep only package branches that contain a
 * class/resource whose name or path matches `q` (case-insensitive substring).
 */
function filterTree(node: PackageNode, q: string): PackageNode | null {
  const needle = q.toLowerCase();
  const classes = node.classes.filter((c) => c.className.toLowerCase().includes(needle) || c.entryPath.toLowerCase().includes(needle));
  const packages: Record<string, PackageNode> = {};
  for (const [name, sub] of Object.entries(node.packages)) {
    const kept = filterTree(sub, q);
    if (kept) packages[name] = kept;
  }
  if (classes.length === 0 && Object.keys(packages).length === 0) return null;
  return { name: node.name, classes, packages };
}

/**
 * Normalize one container's raw tree (normalizeTree + aggregate single-chain
 * packages), same as the main jar's `normalizedTree`. Used for every
 * dependency-library container in the JD-GUI style tree.
 */
function normalizeContainerTree(tree: Record<string, PackageNode>): Record<string, PackageNode> {
  const filtered = normalizeTree(tree);
  const out: Record<string, PackageNode> = {};
  for (const [name, node] of Object.entries(filtered)) {
    out[name] = aggregatePackages(node);
  }
  return out;
}

interface TreeNodeProps {
  node: PackageNode;
  depth: number;
  selected: string | null;
  modifiedSet: Set<string>;
  onSelect: (entryPath: string, libraryId?: string) => void;
  onResourceOpen: (entryPath: string, libraryId?: string) => void;
  /** Container (jar) this tree belongs to — '' = main project jar. */
  containerLibraryId?: string;
  /** When filtering, force every branch open so matches are visible. */
  forceOpen?: boolean;
  onContextMenu?: (e: React.MouseEvent, entryPath: string, className: string, kind: string, libraryId?: string) => void;
}

function TreeNode({ node, depth, selected, modifiedSet, onSelect, onResourceOpen, containerLibraryId = '', forceOpen, onContextMenu }: TreeNodeProps) {
  const [open2, setOpen2] = useState(depth < 2);
  const hasChildren = Object.keys(node.packages).length > 0;
  const isOpen = forceOpen || open2;
  // Standard tree indentation: every row (package or class) indents by depth.
  const indent = { paddingLeft: `${depth * 14}px` };

  return (
    <div>
      <button
        type="button"
        style={indent}
        className="w-full flex items-center gap-1 pr-1 py-0.5 text-[11px] hover:bg-muted/60 rounded text-left"
        onClick={() => setOpen2((v) => !v)}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <FolderOpen className="h-3 w-3 shrink-0 text-amber-500" />
        <span className="truncate">{node.name}</span>
      </button>
      {isOpen && (
        <div>
          {Object.values(node.packages).map((sub) => (
            <TreeNode key={sub.name} node={sub} depth={depth + 1} selected={selected} modifiedSet={modifiedSet} onSelect={onSelect} onResourceOpen={onResourceOpen} containerLibraryId={containerLibraryId} forceOpen={forceOpen} onContextMenu={onContextMenu} />
          ))}
          {node.classes.map((cls) => {
            // JD-GUI JarContainerEntryUtil.removeInnerTypeEntries: inner-class
            // entries ($ names declared in an outer's InnerClasses) are NOT
            // shown as tree nodes — opening the outer class shows the whole
            // source. Obfuscated `$` names (not real inner classes) stay.
            if (cls.isInnerClass) return null;
            const isSel = selected === cls.entryPath;
            const mod = modifiedSet.has(cls.entryPath);
            const isRes = cls.kind !== 'class';
            return (
              <button
                key={cls.entryPath}
                type="button"
                data-entry-path={cls.entryPath}
                style={indent}
                className={`w-full flex items-center gap-1 pr-1 py-0.5 text-[11px] rounded text-left truncate ${
                  isSel ? 'bg-primary/15 text-primary' : 'hover:bg-muted/60'
                }`}
                onClick={() => (isRes ? onResourceOpen(cls.entryPath, containerLibraryId) : onSelect(cls.entryPath, containerLibraryId))}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, cls.entryPath, cls.className, cls.kind, containerLibraryId) : undefined}
                title={isRes ? cls.entryPath : `Location: ${cls.entryPath}\n${cls.className.split('/').pop() ?? ''}`}
              >
                <span className="w-3 shrink-0" />
                {isRes ? (
                  <span className="text-[9px] text-muted-foreground">📄</span>
                ) : (
                  <FileCode2 className="h-3 w-3 shrink-0 text-blue-500" />
                )}
                <span className="truncate">{isRes ? cls.entryPath.split('/').pop() : cls.className.split('/').pop()?.split('.').pop()}</span>
                {mod && <span className="ml-auto shrink-0 rounded bg-amber-500/20 px-1 text-[9px] text-amber-600">改</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Recursive subtype tree node for the hierarchy dialog. */
interface SubTypeNode {
  className: string;
  children: SubTypeNode[];
}
function SubTypeNodes({
  nodes,
  depth,
  selected,
  isJdk,
  onSelect,
  onOpen,
}: {
  nodes: SubTypeNode[];
  depth: number;
  selected: string | null;
  isJdk: (name: string) => boolean;
  onSelect: (className: string) => void;
  onOpen: (className: string, entryPath: string | null) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const jdk = isJdk(n.className);
        return (
          <div key={n.className}>
            {jdk ? (
              // JD-GUI: JDK types are root markers — rendered, not clickable.
              <div
                className="w-full flex items-center gap-1 px-2 py-1 rounded text-left opacity-70"
                style={{ paddingLeft: `${depth * 16}px` }}
              >
                <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <span className="truncate">{n.className}</span>
                {n.children.length > 0 && <span className="ml-auto text-[9px] text-muted-foreground">({n.children.length})</span>}
              </div>
            ) : (
              <button
                type="button"
                className={`w-full flex items-center gap-1 px-2 py-1 rounded text-left ${selected === n.className ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'hover:bg-muted/60'}`}
                style={{ paddingLeft: `${depth * 16}px` }}
                onClick={() => onSelect(n.className)}
                onDoubleClick={() => onOpen(n.className, classNameToEntryPath(n.className))}
              >
                <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <span className="truncate">{n.className}</span>
                {n.children.length > 0 && <span className="ml-auto text-[9px] text-muted-foreground">({n.children.length})</span>}
              </button>
            )}
            {n.children.length > 0 && (
              <SubTypeNodes nodes={n.children} depth={depth + 1} selected={selected} isJdk={isJdk} onSelect={onSelect} onOpen={onOpen} />
            )}
          </div>
        );
      })}
    </>
  );
}

export function ToolJarDecompiler() {
  const { t } = useTranslation();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [tree, setTree] = useState<Record<string, PackageNode> | null>(null);
  /** JD-GUI style open tabs: each opened class is one tab. */
  interface JarTab {
    key: string; // entryPath + libraryId
    entryPath: string;
    libraryId: string;
    title: string;
  }
  const [tabs, setTabs] = useState<JarTab[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const [view, setView] = useState<ClassView | null>(null);
  const [editorText, setEditorText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [modifiedSet, setModifiedSet] = useState<Set<string>>(new Set());
  const [jdk, setJdk] = useState<{ label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [exportProgress, setExportProgress] = useState<ExportProgressEvent | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('output');
  const [diagnostics, setDiagnostics] = useState<CompileDiagnostic[]>([]);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<unknown[]>([]);
  const [originalSource, setOriginalSource] = useState<string | null>(null);
  /** Decompile error to show in the editor area instead of blank space. */
  const [decompileError, setDecompileError] = useState<string | null>(null);
  /** Image resource preview (data URL) when the selected entry is an image. */
  const [resourceImage, setResourceImage] = useState<string | null>(null);
  /** Dependency libraries loaded from a pom (read-only jars). */
  const [libraries, setLibraries] = useState<{ id: string; name: string; editable: boolean; classCount: number }[]>([]);
  /** Currently viewed library id ('' = main project, null = none/pom). */
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  /** JD-GUI container tree: lazily-loaded normalized tree per dependency jar
   *  (libraryId → tree). The main jar's tree lives in `tree`. */
  const [libTrees, setLibTrees] = useState<Record<string, Record<string, PackageNode>>>({});
  /** Expanded containers in the tree ('' = main project jar, lib ids). */
  const [expandedLibs, setExpandedLibs] = useState<Set<string>>(() => new Set(['']));
  /** Pom metadata when opened via pom.xml. */
  const [pomInfo, setPomInfo] = useState<{ groupId: string; artifactId: string; version: string; resolvedCount: number } | null>(null);
  /** Recent files (JD-GUI "File → Recent"). Persisted to localStorage. */
  const [recent, setRecent] = useState<{ path: string; name: string; at: number }[]>(() => {
    try {
      const raw = localStorage.getItem('nexterm.jar.recent');
      if (raw) return JSON.parse(raw) as { path: string; name: string; at: number }[];
    } catch { /* ignore */ }
    return [];
  });
  /** Drop overlay visible while dragging a file over the panel. */
  const [dropOverlay, setDropOverlay] = useState(false);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    void listen<ExportProgressEvent>('jar://export-progress', (event) => {
      if (event.payload.projectId !== project?.id) return;
      setExportProgress(event.payload);
      setBottomTab('output');
      if (event.payload.phase === 'failed') {
        setBuildLog((log) => [...log, t('toolbox.jar.exportItemFailed', { name: event.payload.className, error: event.payload.message })]);
      } else if (event.payload.phase === 'preparing') {
        setBuildLog((log) => [...log, t('toolbox.jar.exportPreparing')]);
      } else if (event.payload.phase === 'packing') {
        setBuildLog((log) => [...log, t('toolbox.jar.exportPacking')]);
      } else if (event.payload.phase === 'completed') {
        setBuildLog((log) => [...log, t('toolbox.jar.exportCompleted', { completed: event.payload.completed, total: event.payload.total })]);
      } else if (event.payload.phase === 'cancelled') {
        setBuildLog((log) => [...log, t('toolbox.jar.exportCancelled')]);
      } else if (event.payload.phase === 'processing' && event.payload.className) {
        setBuildLog((log) => [...log, t('toolbox.jar.exportProcessing', { completed: event.payload.completed, total: event.payload.total, name: event.payload.className })]);
      }
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => {
      for (const unlisten of unlisteners) unlisten();
    };
  }, [project?.id, t]);
  /** Recent-files dropdown open state. */
  const [recentOpen, setRecentOpen] = useState(false);
  /** Cursor position in the editor (status bar). */
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  /** JD-GUI Find panel state (Ctrl+F): query + case sensitivity + history. */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findHistory, setFindHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('nexterm.jar.findHistory');
      if (raw) return JSON.parse(raw) as string[];
    } catch { /* ignore */ }
    return [];
  });
  /** Current match index (1-based) for the status display; -1 = no match. */
  const [findMatchIndex, setFindMatchIndex] = useState(-1);
  /** Total match count for the status display. */
  const [findMatchCount, setFindMatchCount] = useState(0);
  /** Position of the currently active match (to scroll to on Next/Prev). */
  const findMatchPosRef = useRef<{ from: number; to: number } | null>(null);
  const findQueryRef = useRef('');
  const findCaseRef = useRef(false);
  const findNextFnRef = useRef<(() => void) | null>(null);
  const findPrevFnRef = useRef<(() => void) | null>(null);
  /** Highlight to apply once the next class finishes loading (JD-GUI opens
   *  constant-pool search results with a highlight query). */
  const pendingHighlightRef = useRef<string | null>(null);
  /** Cache of extracted Maven -sources.jar roots keyed by libraryId. */
  const mavenSourceRootRef = useRef<Record<string, string>>({});
  /** Right-click tab menu position + target. */
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  /** Tree node context menu (copy qualified name). */
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; entryPath: string; className: string; kind: string; libraryId?: string } | null>(null);
  /** JD-GUI SelectLocation: the same type exists in several containers. */
  const [selectLoc, setSelectLoc] = useState<{ x: number; y: number; className: string; candidates: { entryPath: string; libraryId: string; projectId: string; className?: string }[] } | null>(null);
  /** Open Type dialog (Ctrl+T): pattern + results + selected index. */
  const openTypeInputRef = useRef<HTMLInputElement | null>(null);
  const openTypeListRef = useRef<HTMLDivElement | null>(null);
  const [openTypeOpen, setOpenTypeOpen] = useState(false);
  const [openTypePattern, setOpenTypePattern] = useState('');
  const [openTypeScope, setOpenTypeScope] = useState<'current' | 'all'>('current');
  const [openTypeResults, setOpenTypeResults] = useState<{ entryPath: string; className: string; packageName: string; libraryId: string; projectId: string; projectName: string; isInnerClass: boolean; modified: boolean }[]>([]);
  const [openTypeBusy, setOpenTypeBusy] = useState(false);
  const [openTypeSel, setOpenTypeSel] = useState(0);
  /** Type hierarchy dialog (Ctrl+H). */
  const [hierarchyOpen, setHierarchyOpen] = useState(false);
  const [hierarchyData, setHierarchyData] = useState<{ target: string; targetEntryPath: string; parents: string[]; parentSubTypes: string[][]; subTypes: SubTypeNode[] } | null>(null);
  /** Selected node in the hierarchy dialog (JD-GUI: single-click selects,
   *  double-click or Open opens). */
  const [hierarchySel, setHierarchySel] = useState<string | null>(null);
  const hierarchyDataRef = useRef<{ target: string; targetEntryPath: string; parents: string[]; parentSubTypes: string[][]; subTypes: SubTypeNode[] } | null>(null);
  const hierarchySelRef = useRef<string | null>(null);
  const handleHierarchyOpenClassRef = useRef<(className: string, entryPath: string | null) => void>(() => {});
  const [hierarchyBusy, setHierarchyBusy] = useState(false);
  /** Go to Line dialog (Ctrl+L). */
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoLine, setGotoLine] = useState('');
  /** JD-GUI GoToView error hint ("1..max" when out of range). */
  const [gotoError, setGotoError] = useState<string | null>(null);
  /** Search in constant pools dialog (Ctrl+Shift+S). */
  const [constSearchOpen, setConstSearchOpen] = useState(false);
  const [constPattern, setConstPattern] = useState('');
  const [constFlags, setConstFlags] = useState<{ type: boolean; constructor: boolean; method: boolean; field: boolean; string: boolean; module: boolean; declaration: boolean; reference: boolean }>({
    // JD-GUI SearchInConstantPoolsView defaults: Type + Declarations + References.
    type: true,
    constructor: false,
    method: false,
    field: false,
    string: false,
    module: false,
    declaration: true,
    reference: true,
  });
  // JD-GUI constant-pool search results: one entry PER MATCHING FILE, each
  // with its own matched values (JD-GUI displays matching files, not a flat
  // value list).
  const [constResults, setConstResults] = useState<{ entryPath: string; className: string; libraryId: string; matches: { kind: string; scope: string; value: string; internalTypeName: string }[] }[]>([]);
  const [constBusy, setConstBusy] = useState(false);
  /** Preferences dialog (Ctrl+Shift+P). */
  const [prefsOpen, setPrefsOpen] = useState(false);
  /** JD-GUI About dialog (F1). */
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Pasted log text (JD-GUI Paste Log: clipboard → viewer tab). */
  const [logText, setLogText] = useState<string | null>(null);
  const [prefsFontSize, setPrefsFontSize] = useState(() => {
    try {
      return parseInt(localStorage.getItem('nexterm.jar.fontSize') ?? '', 10) || 12;
    } catch { return 12; }
  });
  const [prefsSingleLineTabs, setPrefsSingleLineTabs] = useState(() => {
    try {
      return localStorage.getItem('nexterm.jar.singleLineTabs') === 'true';
    } catch { return false; }
  });
  // JD-GUI preferences (ClassFileDecompilerPreferencesProvider +
  // ClassFileSaverPreferencesProvider). Persisted to localStorage.
  const loadPref = (key: string, def: boolean) => {
    try { return localStorage.getItem(key) === 'true'; } catch { return def; }
  };
  const savePref = (key: string, v: boolean) => {
    try { localStorage.setItem(key, v ? 'true' : 'false'); } catch { /* ignore */ }
  };
  const [prefEscapeUnicode, setPrefEscapeUnicode] = useState(() => loadPref('nexterm.jar.escapeUnicode', false));
  const [prefRealignLineNumbers, setPrefRealignLineNumbers] = useState(() => loadPref('nexterm.jar.realignLineNumbers', false));
  const [prefWriteLineNumbers, setPrefWriteLineNumbers] = useState(() => loadPref('nexterm.jar.writeLineNumbers', true));
  const [prefWriteMetadata, setPrefWriteMetadata] = useState(() => loadPref('nexterm.jar.writeMetadata', true));
  // JD-GUI MavenOrgSourceLoaderPreferencesProvider: toggle + group filter.
  const [prefMavenEnabled, setPrefMavenEnabled] = useState(() => loadPref('nexterm.jar.mavenEnabled', true));
  const [prefMavenFilters, setPrefMavenFilters] = useState(() => {
    try { return localStorage.getItem('nexterm.jar.mavenFilters') ?? '+org.springframework +org.apache +org.hibernate'; } catch { return '+org.springframework +org.apache +org.hibernate'; }
  });
  /** Navigation history (Alt+← / Alt+→, JD-GUI Back/Forward). JD-GUI records
   *  the caret position too, so Back restores it. */
  const [navHistory, setNavHistory] = useState<{ entryPath: string; libraryId: string; position?: number }[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  /** Class file info (version/major/size) fetched on selection. */
  const [classInfo, setClassInfo] = useState<{ className: string; javaVersion: string; major: number; minor: number; size: number } | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<ProjectSummary | null>(null);
  const lifecycleRef = useRef(0);
  const openTypeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const constTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest selected entry, for async race guards (e.g. source swap). */
  const selectedEntryRef = useRef<string | null>(null);
  /** True while a programmatic doc replacement is in flight (don't mark dirty). */
  const editorSuppressDirtyRef = useRef(false);
  /** Latest navigate handler (click-to-jump in the editor). */
  const navigateRef = useRef<(name: string, kind: 'class' | 'method', methodOwner?: string) => void>(() => {});
  /** Jump to a method declared in the currently-open class (same page). */
  const jumpToOwnMethodRef = useRef<(methodName: string) => void>(() => {});
  /** Jump to the class declaration on the current page (self-reference). */
  const jumpToTypeDeclarationRef = useRef<(className: string) => void>(() => {});
  /** Line to scroll to after the next decompile finishes (method jump). */
  const pendingGotoLineRef = useRef<number | null>(null);
  /** JD-GUI position restore: caret offset to apply after the editor loads. */
  const pendingGotoPositionRef = useRef<number | null>(null);
  /** Known class names (simple + fully qualified) for hover underline + click jump. */
  const classNameSetRef = useRef<Set<string>>(new Set());
  /** Position-sorted references of the currently open class (JD-GUI links). */
  const posRefsRef = useRef<ClassRef[]>([]);
  /** Own method declarations of the current class: name → source line. */
  const ownMethodsRef = useRef<Map<string, number>>(new Map());
  /** Internal name (slash form) of the currently open class. */
  const currentClassInternalRef = useRef<string | null>(null);
  /** Every indexed class name (dotted + simple + slash) for resolvability. */
  const knownNamesRef = useRef<{ dotted: Set<string>; simple: Set<string>; slash: Set<string> }>({ dotted: new Set(), simple: new Set(), slash: new Set() });
  /** Count of indexed types (status bar) — state so it re-renders. */
  const [knownNamesCount, setKnownNamesCount] = useState(0);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => () => {
    lifecycleRef.current += 1;
    if (openTypeTimerRef.current) clearTimeout(openTypeTimerRef.current);
    if (constTimerRef.current) clearTimeout(constTimerRef.current);
    const currentProject = projectRef.current;
    if (currentProject) void jarApi.deleteProject(currentProject.id);
  }, []);



  // Load every indexed class name (resolvability check for references).
  useEffect(() => {
    if (!project) return;
    void jarApi.knownClassNames(project.id).then((r) => {
      knownNamesRef.current = buildKnownNames(r.names, r.simple);
      setKnownNamesCount(r.names.length);
    }).catch(() => { /* non-fatal */ });
  }, [project]);

  // ── Build the CodeMirror editor. ──
  useEffect(() => {
    if (!editorRef.current) return;
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle),
      java(),
      highlightSelectionMatches(),
      // View-only (JD-GUI): decompiled sources are read-only.
      EditorState.readOnly.of(true),
      findHighlightField,
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        click: (event, view) => {
          // JD-GUI: single-click a resolvable reference → jump (no modifier).
          // References are bound to their EXACT source position by jd-core's
          // printer (printReference at stringBuffer.length()) — never resolved
          // by simple names.
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return;
          const ref = refAt(pos);
          if (ref && isRefEnabled(ref)) {
            event.preventDefault();
            jumpToRef(ref);
            return;
          }
          // Ctrl/Cmd+click on a fully-qualified name (no bytecode ref there).
          if ((event.ctrlKey || event.metaKey) && ref === undefined) {
            const w = wordAt(view, pos);
            if (w && w.word.includes('.')) {
              event.preventDefault();
              const kind = /^[A-Z]/.test(w.word) ? 'class' : 'method';
              navigateRef.current(w.word, kind as 'class' | 'method');
            }
          }
        },
        mousemove: (event, view) => {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          const ref = pos === null ? undefined : refAt(pos);
          const known = ref !== undefined && isRefEnabled(ref);
          const cur = view.state.field(hoverField, false);
          const from = cur?.from ?? -1;
          const to = cur?.to ?? -1;
          if (known) {
            const r = ref!;
            const f = r.offset ?? 0;
            const t = f + (r.len ?? 0);
            if (from !== f || to !== t) {
              view.dispatch({ effects: setHoverEffect.of({ from: f, to: t }) });
            }
            if (view.dom.style.cursor !== 'pointer') view.dom.style.cursor = 'pointer';
          } else if (cur !== null) {
            view.dispatch({ effects: setHoverEffect.of(null) });
            if (view.dom.style.cursor !== '') view.dom.style.cursor = '';
          }
        },
        mouseleave: (_event, view) => {
          const cur = view.state.field(hoverField, false);
          if (cur !== null) {
            view.dispatch({ effects: setHoverEffect.of(null) });
          }
          if (view.dom.style.cursor !== '') view.dom.style.cursor = '';
        },
        dblclick: (event, view) => {
          // JD-GUI: double-click a word → highlight all occurrences (green).
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return;
          const w = wordAt(view, pos);
          if (!w || w.word.length < 2) return;
          event.preventDefault();
          view.dispatch({ selection: { anchor: w.from, head: w.to } });
          const ranges: { from: number; to: number }[] = [];
          const re = new RegExp(`\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          const doc = view.state.doc.toString();
          let m: RegExpExecArray | null;
          while ((m = re.exec(doc))) {
            ranges.push({ from: m.index, to: m.index + m[0].length });
          }
          view.dispatch({ effects: setDblClickWordEffect.of(ranges) });
        },
        wheel: (event, view) => {
          // JD-GUI: Ctrl+wheel zooms the font (persisted to localStorage).
          if (!(event.ctrlKey || event.metaKey)) return false;
          event.preventDefault();
          const delta = event.deltaY < 0 ? 1 : -1;
          const cur = parseFloat(view.dom.style.fontSize) || 12;
          const next = Math.min(40, Math.max(2, cur + delta)); // JD-GUI 2..40
          view.dom.style.fontSize = `${next}px`;
          view.requestMeasure();
          try {
            localStorage.setItem('nexterm.jar.fontSize', String(next));
          } catch { /* ignore */ }
          return true;
        },
      }),
      hoverField,
      dblClickWordField,
      EditorView.updateListener.of((update) => {
        // Ignore programmatic replacements (marked via editorSuppressDirtyRef).
        if (update.docChanged && !editorSuppressDirtyRef.current) {
          setDirty(true);
        }
        // Track cursor for the status bar.
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        setCursor({ line: line.number, col: head - line.from + 1 });
      }),
    ];
    const state = EditorState.create({ doc: editorText, extensions: exts });
    const view2 = new EditorView({ state, parent: editorRef.current });
    // Restore persisted font size (Ctrl+wheel zoom).
    try {
      const saved = localStorage.getItem('nexterm.jar.fontSize');
      if (saved) view2.dom.style.fontSize = `${parseFloat(saved)}px`;
    } catch { /* ignore */ }
    editorViewRef.current = view2;
    return () => {
      view2.destroy();
      editorViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntry]);

  // Replace the editor content when a class's source arrives (decompile/revert).
  // The editor instance is created once per selection; pushing content through
  // the view (not React state) is what actually displays it.
  useEffect(() => {
    const view2 = editorViewRef.current;
    if (!view2) return;
    const current = view2.state.doc.toString();
    if (current === editorText) return;
    editorSuppressDirtyRef.current = true;
    view2.dispatch({
      changes: { from: 0, to: current.length, insert: editorText },
    });
    editorSuppressDirtyRef.current = false;
    // Method jump: scroll to the requested declaration line.
    const line = pendingGotoLineRef.current;
    if (line !== null) {
      pendingGotoLineRef.current = null;
      const max = view2.state.doc.lines;
      const target = Math.min(Math.max(line, 1), max);
      const pos = view2.state.doc.line(target).from;
      view2.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    } else if (pendingGotoPositionRef.current !== null) {
      // JD-GUI Back/Forward: restore the caret offset.
      const pos = pendingGotoPositionRef.current;
      pendingGotoPositionRef.current = null;
      const len = view2.state.doc.length;
      if (pos >= 0 && pos <= len) {
        view2.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
    }
  }, [editorText, selectedEntry]);

  // ── Open a JAR by path (shared by dialog + drag&drop + recent history). ──
  const openProjectByPath = useCallback(
    async (path: string) => {
      const lifecycle = lifecycleRef.current;
      setBusy(true);
      setBusyLabel(t('toolbox.jar.opening'));
      try {
        const p = await jarApi.openProject(path);
        if (lifecycle !== lifecycleRef.current) {
          void jarApi.deleteProject(p.id);
          return;
        }
        projectRef.current = p;
        setProject(p);
        const idx = await jarApi.classIndex(p.id);
        setTree(idx);
        const names = new Set<string>();
        collectClassNames(idx, names);
        classNameSetRef.current = names;
        // JD-GUI indexesChanged: load the full "types in opened containers"
        // index synchronously so every reference's clickability is decided
        // correctly (main jar + dependency libraries + nested jars).
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await jarApi.knownClassNames(p.id);
            knownNamesRef.current = buildKnownNames(r.names, r.simple);
            setKnownNamesCount(r.names.length);
            break;
          } catch {
            if (attempt === 1) {
              knownNamesRef.current = { dotted: new Set(), simple: new Set(), slash: new Set() };
            }
          }
        }
        setSelectedEntry(null);
      selectedEntryRef.current = null;
        setView(null);
        setEditorText('');
        setDirty(false);
        setDiagnostics([]);
        setBuildLog([`Opened ${p.name} (${p.classCount} classes)`]);
        // JD-GUI recursive container model: a plain (fat) jar may embed
        // dependency jars (BOOT-INF/lib, WEB-INF/lib, ...). Load them so the
        // tree shows each nested jar as its own read-only container.
        try {
          const libs = await jarApi.libraries(p.id);
          setLibraries(libs);
        } catch {
          setLibraries([]);
        }
        setActiveLibraryId(null);
        setLibTrees({});
        setExpandedLibs(new Set(['']));
        setPomInfo(null);
        setTabs([]);
        // Record in recent history (most-recent first, dedupe).
        setRecent((prev) => {
          const next = [{ path, name: p.name, at: Date.now() }, ...prev.filter((r) => r.path !== path)].slice(0, 10); // JD-GUI RECENT_FILES_MAX=10
          try {
            localStorage.setItem('nexterm.jar.recent', JSON.stringify(next));
          } catch { /* storage unavailable */ }
          return next;
        });
      } catch (e) {
        toast.error(t('toolbox.jar.openFailed'), { description: String(e) });
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  // ── Drag & drop to open a JAR (JD-GUI style). ──
  const { isDragOver: osDragOver, clearDragOver } = useWebviewFileDrop({
    enabled: true,
    targetRef: rootRef,
    onDrop: async (paths) => {
      clearDragOver();
      setDropOverlay(false);
      const jar = paths.find((p) => /\.(jar|war|ear|zip)$/i.test(p));
      if (!jar) {
        toast.error(t('toolbox.jar.dropHint'));
        return;
      }
      await openProjectByPath(jar);
    },
  });
  useEffect(() => {
    setDropOverlay(osDragOver);
  }, [osDragOver]);

  // ── Open a JAR (dialog). ──
  const handleOpenJar = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Archive (jar/war/ear/zip)', extensions: ['jar', 'war', 'ear', 'zip'] }],
    });
    if (typeof path !== 'string' || !path) return;
    await openProjectByPath(path);
  }, [openProjectByPath]);

  // ── Open a Maven pom.xml: main jar + dependency libraries. ──
  const handleOpenPom = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Maven POM', extensions: ['xml', 'pom'] }],
    });
    if (typeof path !== 'string' || !path) return;
    setBusy(true);
    setBusyLabel(t('toolbox.jar.opening'));
    try {
      const r = await jarApi.pomOpen(path);
      if (lifecycle !== lifecycleRef.current) {
        void jarApi.deleteProject(r.projectId);
        return;
      }
      const p: ProjectSummary = {
        id: r.projectId,
        name: r.name,
        jarPath: '',
        jarHash: '',
        size: 0,
        classCount: 0,
        resourceCount: 0,
        classTree: r.classTree,
        createdAt: 0,
        updatedAt: 0,
      };
      projectRef.current = p;
      setProject(p);
      setTree(r.classTree);
      setLibraries(r.libraries);
      setLibTrees({});
      setExpandedLibs(new Set(['']));
      setPomInfo(r.pom);
      setActiveLibraryId(null);
      // JD-GUI indexesChanged: preload the clickability index (main jar +
      // dependency libraries), so references are clickable immediately.
      try {
        const kn = await jarApi.knownClassNames(r.projectId);
        knownNamesRef.current = buildKnownNames(kn.names, kn.simple);
        setKnownNamesCount(kn.names.length);
        setKnownNamesCount(kn.names.length);
      } catch {
        /* fall back to the project effect */
      }
      setSelectedEntry(null);
      selectedEntryRef.current = null;
      setView(null);
      setEditorText('');
      setDirty(false);
      setBuildLog([
        `Opened pom ${r.pom.groupId}:${r.pom.artifactId}:${r.pom.version}`,
        `${r.libraries.length} dependency jar(s), ${r.pom.resolvedCount} resolved`,
      ]);
    } catch (e) {
      toast.error(t('toolbox.jar.openFailed'), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [t]);

  // ── Switch the tree to a dependency library (read-only) or main project. ──
  // ── Ensure a container (main jar '' or a dependency library) is loaded and
  //    expanded in the tree. JD-GUI container model: every jar is its own tree
  //    root; library trees are lazily fetched on first expansion. ──
  const handleSelectLibrary = useCallback(
    async (libraryId: string) => {
      if (!project) return;
      setActiveLibraryId(libraryId);
      setSelectedEntry(null);
      selectedEntryRef.current = null;
      setView(null);
      setEditorText('');
      setDirty(false);
      setClassInfo(null);
      posRefsRef.current = [];
      ownMethodsRef.current = new Map();
      currentClassInternalRef.current = null;
      if (!libraryId) {
        // Main project tree (already loaded at open; re-read from index).
        try {
          const idx = await jarApi.classIndex(project.id);
          setTree(idx);
          const names = new Set<string>();
          collectClassNames(idx, names);
          // Aggregate class names across the main jar + all loaded libraries
          // so editor click-to-jump works for every open container.
          for (const libTree of Object.values(libTrees)) collectClassNames(libTree, names);
          classNameSetRef.current = names;
          setExpandedLibs((prev) => new Set(prev).add(''));
        } catch (e) {
          toast.error(String(e));
        }
        return;
      }
      setExpandedLibs((prev) => new Set(prev).add(libraryId));
      if (!libTrees[libraryId]) {
        try {
          const idx = await jarApi.libraryIndex(project.id, libraryId);
          setLibTrees((prev) => ({ ...prev, [libraryId]: idx }));
          const names = new Set(classNameSetRef.current);
          collectClassNames(idx, names);
          classNameSetRef.current = names;
        } catch (e) {
          toast.error(String(e));
        }
      }
    },
    [project, t, libTrees],
  );

  // ── JD-GUI Find: live highlight in the editor (defined before handleSelect
  //    so constant-pool search results can reuse it on open). ──
  const applyFind = useCallback((query: string, caseSensitive: boolean) => {
    findQueryRef.current = query;
    findCaseRef.current = caseSensitive;
    const view = editorViewRef.current;
    // JD-GUI ignores queries of length ≤ 1 (AbstractTextPage).
    if (!view || !query || query.length <= 1) {
      setFindMatchIndex(-1);
      setFindMatchCount(0);
      findMatchPosRef.current = null;
      if (view) view.dispatch({ effects: setFindEffect.of(null) });
      return;
    }
    const doc = view.state.doc.toString();
    const needle = caseSensitive ? query : query.toLowerCase();
    const hay = caseSensitive ? doc : doc.toLowerCase();
    const ranges: { from: number; to: number }[] = [];
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      ranges.push({ from: idx, to: idx + needle.length });
      idx += needle.length;
    }
    setFindMatchCount(ranges.length);
    // Select the first match after the cursor, else the first.
    const cursorPos = view.state.selection.main.head;
    const active: { from: number; to: number } | null = ranges.find((r) => r.from >= cursorPos) ?? ranges[0] ?? null;
    findMatchPosRef.current = active;
    setFindMatchIndex(active ? ranges.indexOf(active) + 1 : -1);
    view.dispatch({ effects: setFindEffect.of({ query, caseSensitive, active }) });
    if (active) {
      view.dispatch({ selection: { anchor: active.from, head: active.to }, scrollIntoView: true });
    }
  }, []);

  // ── Navigate (click class/method name → open target). ──
  // ── Select a class → decompile on demand. ──
  const handleSelect = useCallback(
    async (entryPath: string, opts?: { history?: boolean; libraryId?: string }) => {
      if (!project) return;
      // The class's own container (JD-GUI container model): tree clicks pass
      // the container's libraryId; jumps/tabs fall back to the active one.
      const libraryId = opts?.libraryId ?? activeLibraryId ?? '';
      // Keep the "active container" in sync so save/export/revert follow the
      // class that is actually open (React bails out when unchanged).
      if (libraryId !== activeLibraryId) setActiveLibraryId(libraryId);
      const pushHistory = opts?.history ?? true;
      // JD-GUI UriUtil: opening an inner class (D$E.class) opens its OUTER
      // class (D.class) and highlights the inner-type declaration. We do the
      // same by redirecting to the outer file and highlighting the simple name.
      let realPath = entryPath;
      let innerHighlight: string | null = null;
      if (entryPath.includes('$') && entryPath.endsWith('.class')) {
        const lastSlash = entryPath.lastIndexOf('/');
        const base = lastSlash === -1 ? entryPath : entryPath.slice(lastSlash + 1);
        const dollar = base.indexOf('$');
        if (dollar !== -1) {
          const outerBase = base.slice(0, dollar);
          const outer = lastSlash === -1 ? `${outerBase}.class` : `${entryPath.slice(0, lastSlash + 1)}${outerBase}.class`;
          // The inner simple name is what follows the last '$' (e.g. "Bar"
          // for Foo$Bar, "1" for Foo$1).
          const simple = base.slice(dollar + 1).replace(/\.class$/, '');
          innerHighlight = simple || null;
          realPath = outer;
        }
      }
      // JD-GUI: clicking a class opens it (reuse tab if already open).
      setTabs((prev) => {
        const key = `${libraryId}:${realPath}`;
        if (prev.some((tab) => tab.key === key)) return prev;
        const title = realPath.split('/').pop()?.replace('.class', '') ?? realPath;
        return [...prev, { key, entryPath: realPath, libraryId, title }];
      });
      if (pushHistory) {
        // JD-GUI addURI("position=offset"): remember the caret before leaving.
        // History dedupes: revisiting a page moves it to the front.
        const caretPos = editorViewRef.current?.state.selection.main.head;
        setNavHistory((prev) => {
          const deduped = prev.filter(
            (h) => !(h.entryPath === realPath && (h.libraryId || '') === (libraryId || '')),
          );
          const next = [...deduped.slice(0, navIndex + 1), { entryPath: realPath, libraryId, position: caretPos }];
          return next.slice(-100);
        });
        setNavIndex((i) => Math.min(i + 1, 99));
      }
      if (innerHighlight) {
        // Will be applied after the outer class's source renders.
        pendingHighlightRef.current = innerHighlight;
      }
      // JD-GUI reuses the open page: selecting the already-open class just
      // activates it instead of re-decompiling. Same entryPath can exist in
      // several containers, so compare the container too.
      if (selectedEntry === realPath && (activeLibraryId ?? '') === libraryId && view && !pendingHighlightRef.current) {
        return;
      }
      setSelectedEntry(realPath);
      selectedEntryRef.current = realPath;
      setDirty(false);
      setView(null);
      setEditorText('');
      setResourceImage(null);
      setDecompileError(null);
      setClassInfo(null);
      setBusy(true);
      setBusyLabel(t('toolbox.jar.decompiling'));
      try {
        const cv = await jarApi.decompile(project.id, realPath, libraryId || null, {
          escapeUnicode: prefEscapeUnicode || null,
          realign: prefRealignLineNumbers || null,
        });
        setView(cv);
        setEditorText(cv.source);
        setOriginalSource(cv.originalSource ?? null);
        // JD-GUI links: position-bound references streamed by jd-core's
        // printer — every type/field/method reference carries its exact
        // source offset + full internal type name (+ descriptor). Sorted by
        // offset so hover/click resolve by position, never by simple name.
        posRefsRef.current = (cv.refs ?? [])
          .filter((r) => typeof r.offset === 'number' && r.offset > 0 && typeof r.len === 'number' && r.len > 0)
          .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
        // Own method declarations (name → line) for same-page jumps.
        const ownMap = new Map<string, number>();
        for (const m of cv.methods ?? []) ownMap.set(m.name, m.line);
        ownMethodsRef.current = ownMap;
        // Internal name (slash form) of this class, for self-reference checks.
        currentClassInternalRef.current = cv.className.replace(/\./g, '/');
        setModifiedSet((prev) => {
          const next = new Set(prev);
          if (cv.modified) next.add(realPath);
          else next.delete(realPath);
          return next;
        });
        // Class file info (JD-GUI "class file information").
        try {
          const info = await jarApi.classInfo(project.id, realPath, libraryId || undefined);
          setClassInfo(info);
        } catch {
          setClassInfo(null);
        }
        // JD-GUI: when this class was opened from a constant-pool search,
        // highlight the matched pattern in the freshly shown source.
        if (pendingHighlightRef.current) {
          const hl = pendingHighlightRef.current;
          pendingHighlightRef.current = null;
          requestAnimationFrame(() => {
            const view2 = editorViewRef.current;
            if (!view2) return;
            applyFind(hl, false);
            setFindOpen(false); // don't force the find bar open
          });
        }
        // JD-GUI DynamicPage: after decompiling, try to load the ORIGINAL
        // .java source (if the jar bundles it) and replace the view with it.
        void (async () => {
          const javaPath = realPath.replace(/\.class$/i, '.java');
          if (javaPath === realPath) return;
          try {
            const src = await jarApi.readResource(project.id, javaPath, libraryId || null);
            // Only replace when the user hasn't navigated away meanwhile.
            if (selectedEntryRef.current === realPath) {
              setView({ ...cv, source: src, originalSource: src });
              setEditorText(src);
              setOriginalSource(src);
            }
          } catch {
            // JD-GUI MavenOrgSourceLoader: no bundled source — try to fetch
            // the library's -sources.jar from Maven Central (pom-opened
            // libraries only, one download cached per library).
            const key = libraryId || project.id;
            if (mavenSourceRootRef.current[key]) {
              try {
                const src2 = await jarApi.readSourceFile(mavenSourceRootRef.current[key], javaPath);
                if (selectedEntryRef.current === realPath) {
                  setView({ ...cv, source: src2.source, originalSource: src2.source });
                  setEditorText(src2.source);
                  setOriginalSource(src2.source);
                }
              } catch {
                /* no sources available */
              }
              return;
            }
            if (!libraryId) return; // main project has no Maven coordinates
            // JD-GUI MavenOrgSourceLoader: enabled toggle; the group filter is
            // enforced on the backend (it knows the library's groupId).
            if (!prefMavenEnabled) return;
            try {
              const info = await jarApi.mavenSources(project.id, libraryId, prefMavenFilters);
              mavenSourceRootRef.current[key] = info.root;
              const src2 = await jarApi.readSourceFile(info.root, javaPath);
              if (selectedEntryRef.current === realPath) {
                setView({ ...cv, source: src2.source, originalSource: src2.source });
                setEditorText(src2.source);
                setOriginalSource(src2.source);
              }
            } catch {
              /* download failed or filtered — keep the decompiled view */
            }
          }
        })();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setDecompileError(msg);
        toast.error(t('toolbox.jar.decompileFailed'), { description: msg });
      } finally {
        setBusy(false);
      }
    },
    [project, t, activeLibraryId, navIndex, applyFind, view],
  );

  // ── Jump to a word's reference(s). Resolves by FULL internal type name
  //    (JD-GUI) — never by simple name — and when the same member/name exists
  //    in several classes, asks the user via SelectLocation. ──
  // ── JD-GUI position-bound links ──
  // jd-core's printer emits every reference with its EXACT source offset
  // (printReference at stringBuffer.length()). References are looked up by
  // position — never by simple name — which is the only way to be correct
  // when the same member name exists in many classes.
  const refAt = useCallback((pos: number): ClassRef | undefined => {
    const arr = posRefsRef.current;
    let lo = 0;
    let hi = arr.length - 1;
    let best: ClassRef | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const off = arr[mid].offset ?? 0;
      if (off <= pos) {
        best = arr[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best && pos < (best.offset ?? 0) + (best.len ?? 0) ? best : undefined;
  }, []);
  /** JD-GUI TypePage.indexesChanged: enabled iff the type is in an OPENED
   *  container (main jar, dependency libs, nested jars). */
  const isRefEnabled = useCallback(
    (r: ClassRef): boolean => {
      const k = knownNamesRef.current;
      const dotted = r.internalTypeName.replace(/\//g, '.');
      const simple = r.internalTypeName.split('/').pop() ?? '';
      return k.dotted.has(dotted) || k.simple.has(simple) || k.slash.has(r.internalTypeName);
    },
    [],
  );
  const jumpToRef = useCallback((ref: ClassRef) => {
    const dotted = ref.internalTypeName.replace(/\//g, '.');
    if (ref.kind === 'type') {
      if (ref.internalTypeName === currentClassInternalRef.current) {
        jumpToTypeDeclarationRef.current(dotted);
      } else {
        navigateRef.current(dotted, 'class');
      }
    } else if (ref.kind === 'method') {
      if (ref.internalTypeName === currentClassInternalRef.current) {
        jumpToOwnMethodRef.current(ref.name ?? '');
      } else {
        navigateRef.current(dotted, 'method', ref.internalTypeName);
      }
    } else {
      // field / constructor → open the owning class.
      navigateRef.current(dotted, 'class');
    }
  }, []);

  // ── Navigate (click class/method name → open target). ──
  const handleNavigate = useCallback(
    async (name: string, kind: 'class' | 'method', methodOwner?: string) => {
      if (!project) return;
      const openAndJump = async (entryPath: string, libraryId: string | undefined, line: number | null, ownerProjectId?: string) => {
        if (ownerProjectId && ownerProjectId !== project.id) {
          const p = await jarApi.openProjectFromId(ownerProjectId);
          setProject(p);
          const idx = await jarApi.classIndex(p.id);
          setTree(idx);
          const names = new Set<string>();
          collectClassNames(idx, names);
          classNameSetRef.current = names;
          try {
            const kn = await jarApi.knownClassNames(p.id);
            knownNamesRef.current = buildKnownNames(kn.names, kn.simple);
        setKnownNamesCount(kn.names.length);
          } catch {
            /* ignore */
          }
          setSelectedEntry(null);
      selectedEntryRef.current = null;
          setView(null);
          setEditorText('');
          setDirty(false);
          setLibraries([]);
          setActiveLibraryId(null);
          setLibTrees({});
          setExpandedLibs(new Set(['']));
          setPomInfo(null);
          setTabs([]);
          if (libraryId) await handleSelectLibrary(libraryId);
        } else if (libraryId && libraryId !== activeLibraryId) {
          await handleSelectLibrary(libraryId);
        }
        if (line !== null) pendingGotoLineRef.current = line;
        // Pass the container explicitly: handleSelectLibrary sets state
        // asynchronously, and handleSelect's closure would read a stale
        // activeLibraryId → wrong jar → "entry not found".
        await handleSelect(entryPath, { libraryId: libraryId ?? '' });
      };

      try {
        // Precise method jump: bytecode reference already tells us the owner
        // class and method name — decompile the owner and locate the line.
        if (kind === 'method' && methodOwner) {
          const loc = await jarApi.methodLocation(project.id, methodOwner, name);
          await openAndJump(loc.entryPath, loc.libraryId, loc.line);
          return;
        }
        const target = await jarApi.navigate(project.id, name, kind);
        if (target.kind === 'multiple') {
          // JD-GUI SelectLocation: same type in several containers — ask.
          const cands = (target.candidates ?? []) as { entryPath: string; libraryId: string; projectId: string }[];
          if (cands.length === 0) return;
          if (cands.length === 1) {
            const c = cands[0];
            await openAndJump(c.entryPath, c.libraryId, null, c.projectId);
            return;
          }
          setSelectLoc({ x: Math.round(window.innerWidth / 2 - 150), y: Math.round(window.innerHeight / 2 - 60), className: name, candidates: cands });
          return;
        }
        // JD-GUI: opening a type reference highlights its declaration.
        if (target.kind === 'class' || (target.kind === 'method' && !target.line)) {
          pendingHighlightRef.current = name.split('.').pop() ?? name;
        }
        await openAndJump(
          target.entryPath,
          target.libraryId,
          target.kind === 'method' && typeof target.line === 'number' ? target.line : null,
          target.projectId,
        );
      } catch (e) {
        // JD-GUI: an unresolvable reference is simply not a link — stay quiet
        // instead of surfacing "Class not found" noise on every click.
        const msg = e instanceof Error ? e.message : String(e);
        if (/method not found/i.test(msg) && kind === 'method') {
          // The member does not exist on its owner (e.g. a typo like
          // saveEmsMeasurationn). JD-GUI still opens the OWNING class — the
          // reference targets it — instead of staying silent.
          try {
            if (methodOwner) {
              const t = await jarApi.navigate(project.id, methodOwner.replace(/\//g, '.'), 'class');
              if (t.kind === 'class') {
                await openAndJump(t.entryPath, t.libraryId, null, t.projectId);
              }
              return;
            }
            const target2 = await jarApi.navigate(project.id, name, 'class');
            await openAndJump(target2.entryPath, target2.libraryId, null, target2.projectId);
            return;
          } catch {
            /* quiet */
          }
        }
        if (/class not found|method not found/i.test(msg)) return;
        toast.error(`${name}: ${msg}`);
      }
    },
    [project, activeLibraryId, handleSelectLibrary, handleSelect],
  );

  // Keep navigateRef fresh so the editor click handler sees the latest fn.
  navigateRef.current = handleNavigate;

  // Keep the word→reference resolver fresh (JD-GUI resolvability check).


  // Same-page method jump (JD-GUI: reference to the class's own method moves
  // the caret to the declaration inside the current editor).
  jumpToOwnMethodRef.current = (methodName: string) => {
    const view2 = editorViewRef.current;
    if (!view2) return;
    const line = ownMethodsRef.current.get(methodName);
    if (line === undefined) return;
    const max = view2.state.doc.lines;
    const target = Math.min(Math.max(line, 1), max);
    const pos = view2.state.doc.line(target).from;
    view2.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  };

  // JD-GUI: clicking a reference to the class ITSELF highlights the type
  // declaration on this page. We find the "class/interface/enum/… Name" line
  // and place the caret + highlight it.
  jumpToTypeDeclarationRef.current = (className: string) => {
    const view2 = editorViewRef.current;
    if (!view2) return;
    const simple = className.split('.').pop() ?? className;
    const doc = view2.state.doc.toString();
    const lines = doc.split('\n');
    let found = -1;
    const re = new RegExp(`\\b(class|interface|enum|@interface)\\s+${simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        found = i + 1;
        break;
      }
    }
    if (found === -1) return;
    const target = Math.min(Math.max(found, 1), view2.state.doc.lines);
    const pos = view2.state.doc.line(target).from;
    view2.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    // Highlight the declaration token (JD-GUI SELECT_HIGHLIGHT_COLOR).
    const line = view2.state.doc.line(target);
    const nameStart = line.text.indexOf(simple);
    if (nameStart !== -1) {
      const from = line.from + nameStart;
      const to = from + simple.length;
      pendingHighlightRef.current = simple;
      view2.dispatch({ effects: setFindEffect.of({ query: simple, caseSensitive: true, active: { from, to } }) });
    }
  };

  // ── Tab management (JD-GUI style). ──
  const handleSwitchTab = useCallback(
    (tabKey: string) => {
      const tab = tabs.find((t) => t.key === tabKey);
      if (!tab || !project) return;
      // Switch library context if needed.
      const targetLib = tab.libraryId;
      if (targetLib !== activeLibraryId) {
        void handleSelectLibrary(targetLib).then(() => {
          void handleSelect(tab.entryPath, { libraryId: targetLib });
        });
        return;
      }
      void handleSelect(tab.entryPath);
    },
    [tabs, project, activeLibraryId, handleSelectLibrary, handleSelect],
  );

  const handleCloseTab = useCallback(
    (tabKey: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.key === tabKey);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.key !== tabKey);
        // If closing the active tab, switch to a neighbor.
        const closed = prev[idx];
        if (closed.entryPath === selectedEntry && next.length > 0) {
          const neighbor = next[Math.min(idx, next.length - 1)];
          const targetLib = neighbor.libraryId;
          if (targetLib !== activeLibraryId) {
            void handleSelectLibrary(targetLib).then(() => handleSelect(neighbor.entryPath, { libraryId: targetLib }));
          } else {
            void handleSelect(neighbor.entryPath);
          }
        }
        return next;
      });
    },
    [selectedEntry, activeLibraryId, handleSelectLibrary, handleSelect],
  );

  const handleCloseAllTabs = useCallback(() => {
    setTabs([]);
    setSelectedEntry(null);
      selectedEntryRef.current = null;
    setView(null);
    setEditorText('');
    setDirty(false);
    setTabMenu(null);
    posRefsRef.current = [];
    ownMethodsRef.current = new Map();
    currentClassInternalRef.current = null;
  }, []);

  // ── Tab context menu (JD-GUI: close others / copy class name). ──
  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent, tabKey: string) => {
      e.preventDefault();
      setTabMenu({ key: tabKey, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleCloseOtherTabs = useCallback(
    (tabKey: string) => {
      setTabs((prev) => prev.filter((t) => t.key === tabKey));
      const keep = tabs.find((t) => t.key === tabKey);
      if (keep) {
        const targetLib = keep.libraryId;
        if (targetLib !== activeLibraryId) {
          void handleSelectLibrary(targetLib).then(() => handleSelect(keep.entryPath, { libraryId: targetLib }));
        } else {
          void handleSelect(keep.entryPath);
        }
      }
      setTabMenu(null);
    },
    [tabs, activeLibraryId, handleSelectLibrary, handleSelect],
  );

  const handleCopyTabName = useCallback((tabKey: string) => {
    const tab = tabs.find((t) => t.key === tabKey);
    if (tab) {
      const name = tab.entryPath.split('/').pop()?.replace(/\.class$/, '') ?? tab.entryPath;
      void navigator.clipboard.writeText(name).then(() => {
        toast.success(`Copied ${name}`);
      });
    }
    setTabMenu(null);
  }, [tabs]);

  // ── Tree node context menu: copy qualified name (JD-GUI). ──
  const handleTreeContextMenu = useCallback((e: React.MouseEvent, entryPath: string, className: string, kind: string, libraryId?: string) => {
    e.preventDefault();
    setTreeMenu({ x: e.clientX, y: e.clientY, entryPath, className, kind, libraryId });
  }, []);

  const handleCopyQualifiedName = useCallback(
    (className: string, kind: string) => {
      setTreeMenu(null);
      const name = kind === 'class' ? className : className;
      void navigator.clipboard.writeText(name).then(() => {
        toast.success(`Copied ${name}`);
      });
    },
    [],
  );

  // ── Save modified source. ──
  // ── Export all decompiled sources (JD-GUI "Save All Sources"). ──
  const handleExportAll = useCallback(async () => {
    if (!project) return;
    // Offer both: a directory export and a zip bundle (JD-GUI Save All Sources).
    const zipPath = await save({
      defaultPath: (project.name.replace(/\.jar$/i, '') || 'sources') + '-sources.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (typeof zipPath !== 'string' || !zipPath) {
      // Fall back to directory export.
      const dir = await open({
        multiple: false,
        directory: true,
      });
      if (typeof dir !== 'string' || !dir) return;
      setBusy(true);
      setBusyLabel(t('toolbox.jar.exportAll'));
      setExportProgress({ projectId: project.id, phase: 'preparing', completed: 0, total: 0 });
      setBottomTab('output');
      try {
        const result = await jarApi.exportAll(project.id, dir, { writeMetadata: prefWriteMetadata, writeLineNumbers: prefWriteLineNumbers, escapeUnicode: prefEscapeUnicode || null, realign: prefRealignLineNumbers || null });
        setBuildLog((l) => [
          ...l,
          t('toolbox.jar.exportResult', { exported: result.exported, total: result.total, outputDir: result.outputDir }),
          result.failed > 0 ? t('toolbox.jar.exportPartialFailure', { count: result.failed, classes: result.failedClasses.slice(0, 5).join(', ') }) : t('toolbox.jar.exportAllOk'),
        ]);
        toast.success(t('toolbox.jar.exportSucceeded', { exported: result.exported, total: result.total }));
      } catch (e) {
        setBuildLog((l) => [...l, t('toolbox.jar.exportFailed', { error: String(e) })]);
        toast.error(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    setBusyLabel(t('toolbox.jar.exportAll'));
    setExportProgress({ projectId: project.id, phase: 'preparing', completed: 0, total: 0 });
    setBottomTab('output');
    try {
      const result = await jarApi.exportAll(project.id, zipPath, { writeMetadata: prefWriteMetadata, writeLineNumbers: prefWriteLineNumbers, escapeUnicode: prefEscapeUnicode || null, realign: prefRealignLineNumbers || null });
      setBuildLog((l) => [
        ...l,
        t('toolbox.jar.exportResult', { exported: result.exported, total: result.total, outputDir: result.outputDir }),
        result.failed > 0 ? t('toolbox.jar.exportPartialFailure', { count: result.failed, classes: result.failedClasses.slice(0, 5).join(', ') }) : t('toolbox.jar.exportAllOk'),
      ]);
      toast.success(t('toolbox.jar.exportSucceeded', { exported: result.exported, total: result.total }));
    } catch (e) {
      setBuildLog((l) => [...l, t('toolbox.jar.exportFailed', { error: String(e) })]);
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }, [project, t, prefWriteMetadata, prefWriteLineNumbers, prefEscapeUnicode, prefRealignLineNumbers]);

  const handleCancelExport = useCallback(() => {
    if (!project || !busy) return;
    void jarApi.decompileCancel(project.id).catch((error: unknown) => {
      toast.error(String(error));
    });
  }, [project, busy]);

  // ── Open a resource (text preview / image / hex) in a new tab. ──
  const handleOpenResource = useCallback(
    async (entryPath: string, libraryIdArg?: string) => {
      if (!project) return;
      const libraryId = libraryIdArg ?? activeLibraryId ?? '';
      if (libraryId !== activeLibraryId) setActiveLibraryId(libraryId);
      setTabs((prev) => {
        const key = `${libraryId}:${entryPath}`;
        if (prev.some((tab) => tab.key === key)) return prev;
        return [...prev, { key, entryPath, libraryId, title: entryPath.split('/').pop() ?? entryPath }];
      });
      setSelectedEntry(entryPath);
      selectedEntryRef.current = entryPath;
      setDirty(false);
      setView(null);
      setDecompileError(null);
      setBusy(true);
      setBusyLabel(t('toolbox.jar.decompiling'));
      try {
        const r = await jarApi.resourceBytes(project.id, entryPath, libraryId || undefined);
        // Decode base64 → text or image data URL.
        const bin = atob(r.bytes);
        const isImage = /\.(png|jpe?g|gif|bmp|ico|webp)$/i.test(entryPath);
        if (isImage) {
          setResourceImage(`data:image/*;base64,${r.bytes}`);
          setEditorText('');
          setView({ entryPath, className: entryPath, packageName: '', kind: 'resource', isInnerClass: false, source: '', modified: false, compileStatus: 'none' });
        } else if (r.isText) {
          const text = new TextDecoder('utf-8').decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
          setEditorText(text);
          setView({ entryPath, className: entryPath, packageName: '', kind: 'resource', isInnerClass: false, source: text, modified: false, compileStatus: 'none' });
        } else {
          // Binary hex preview.
          const hex = Array.from(Uint8Array.from(bin, (c) => c.charCodeAt(0)).slice(0, 1024))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          setEditorText(`[binary, ${r.size} bytes]\n${hex}`);
          setView({ entryPath, className: entryPath, packageName: '', kind: 'resource', isInnerClass: false, source: `[binary]`, modified: false, compileStatus: 'none' });
        }
      } catch (e) {
        setDecompileError(String(e));
        toast.error(String(e));
      } finally {
        setBusy(false);
      }
    },
    [project, activeLibraryId, t],
  );

  // ── Revert current class. ──
  // ── Search classes. ──
  const handleSearch = useCallback(async () => {
    if (!project || !query.trim()) return;
    const results = await jarApi.search(project.id, query.trim());
    setSearchResults(results);
    setBottomTab('search');
  }, [project, query]);

  // ── Open Type (Ctrl+T): JD-GUI global type search dialog. ──
  const handleOpenTypeOpen = useCallback(() => {
    setOpenTypePattern('');
    setOpenTypeResults([]);
    setOpenTypeSel(0);
    setOpenTypeOpen(true);
  }, []);

  const handleOpenTypeInput = useCallback(
    (raw: string) => {
      // JD-GUI OpenTypeView: forbid '=', '(', ')', '{', '}', '[', ']' and a
      // leading digit.
      let value = raw.replace(/[=(){}[\]]/g, '');
      if (/^\d/.test(value)) value = value.slice(1);
      setOpenTypePattern(value);
      setOpenTypeSel(0);
      const projectId = project?.id;
      if (!projectId) return;
      if (openTypeTimerRef.current) clearTimeout(openTypeTimerRef.current);
      if (value.trim().length === 0) {
        setOpenTypeResults([]);
        return;
      }
      openTypeTimerRef.current = setTimeout(async () => {
        setOpenTypeBusy(true);
        try {
          const results = await jarApi.openType(projectId, value.trim(), openTypeScope);
          setOpenTypeResults(results);
        } catch (e) {
          toast.error(String(e));
        } finally {
          setOpenTypeBusy(false);
        }
      }, 120);
    },
    [project, openTypeScope],
  );

  const handleOpenTypePick = useCallback(
    (entryPath: string, libraryId: string, targetProjectId?: string) => {
      setOpenTypeOpen(false);
      if (!project) return;
      // JD-GUI OpenTypeController: when the SAME type exists in several
      // containers, show a SelectLocation popup instead of picking silently.
      const sameType = openTypeResults.filter(
        (r) => r.entryPath === entryPath && !(r.libraryId === libraryId && (r.projectId ?? project.id) === (targetProjectId ?? project.id)),
      );
      if (sameType.length > 0) {
        const candidates = [
          { entryPath, libraryId, projectId: targetProjectId ?? project.id },
          ...sameType.map((r) => ({ entryPath: r.entryPath, libraryId: r.libraryId, projectId: r.projectId ?? project.id })),
        ];
        setSelectLoc({ x: Math.round(window.innerWidth / 2 - 150), y: Math.round(window.innerHeight / 2 - 60), className: entryPath.split('/').pop()?.replace('.class', '') ?? '', candidates });
        return;
      }
      // Cross-project result: reopen that jar first (its index is persisted).
      if (targetProjectId && targetProjectId !== project.id) {
        void (async () => {
          try {
            const p = await jarApi.openProjectFromId(targetProjectId);
            setProject(p);
            const idx = await jarApi.classIndex(p.id);
            setTree(idx);
            const names = new Set<string>();
            collectClassNames(idx, names);
            classNameSetRef.current = names;
            try {
              const kn = await jarApi.knownClassNames(p.id);
              knownNamesRef.current = buildKnownNames(kn.names, kn.simple);
        setKnownNamesCount(kn.names.length);
            } catch {
              /* ignore */
            }
            setSelectedEntry(null);
      selectedEntryRef.current = null;
            setView(null);
            setEditorText('');
            setDirty(false);
            setLibraries([]);
            setActiveLibraryId(null);
            setPomInfo(null);
            setTabs([]);
            if (libraryId) {
              await handleSelectLibrary(libraryId);
            }
            await handleSelect(entryPath, { libraryId: libraryId ?? '' });
          } catch (e) {
            toast.error(String(e));
          }
        })();
        return;
      }
      if (libraryId && libraryId !== activeLibraryId) {
        void handleSelectLibrary(libraryId).then(() => handleSelect(entryPath, { libraryId }));
      } else {
        void handleSelect(entryPath, { libraryId: libraryId ?? '' });
      }
    },
    [project, activeLibraryId, handleSelectLibrary, handleSelect, openTypeResults],
  );

  // Ctrl+T opens the dialog (also works when the CodeMirror editor has focus).
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleOpenTypeOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handleOpenTypeOpen]);

  // Tab switch ↔ tree selection sync: scroll the selected class into view.
  useEffect(() => {
    if (!selectedEntry) return;
    const el = rootRef.current?.querySelector(`[data-entry-path="${CSS.escape(selectedEntry)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedEntry, tree, activeLibraryId]);

  // JD-GUI window title: "<class> - <jar>" while a class is open.
  useEffect(() => {
    const base = 'NexTerm';
    if (project && selectedEntry) {
      const name = selectedEntry.split('/').pop()?.replace(/\.class$/, '') ?? selectedEntry;
      document.title = `${name} - ${project.name} - ${base}`;
    } else if (project) {
      document.title = `${project.name} - ${base}`;
    } else {
      document.title = base;
    }
    return () => {
      document.title = base;
    };
  }, [project, selectedEntry]);

  // ── Type hierarchy (Ctrl+H): JD-GUI Open Type Hierarchy. ──
  const handleOpenHierarchy = useCallback(async () => {
    if (!project || !selectedEntry) return;
    setHierarchyOpen(true);
    setHierarchyBusy(true);
    try {
      const data = await jarApi.typeHierarchy(project.id, selectedEntry, activeLibraryId ?? undefined);
      const d = data as { target: string; targetEntryPath: string; parents: string[]; parentSubTypes?: string[][]; subTypes: SubTypeNode[] };
      const d2 = { ...d, parentSubTypes: d.parentSubTypes ?? [] };
      setHierarchyData(d2);
      hierarchyDataRef.current = d2;
      // Default selection: the target itself (JD-GUI selects the current type).
      setHierarchySel(d.target);
      hierarchySelRef.current = d.target;
    } catch (e) {
      toast.error(String(e));
      setHierarchyOpen(false);
    } finally {
      setHierarchyBusy(false);
    }
  }, [project, selectedEntry, activeLibraryId]);

  // Ctrl+H opens hierarchy for the current class (editor focus included).
  useEffect(() => {
    if (!project || !selectedEntry) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void handleOpenHierarchy();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, selectedEntry, handleOpenHierarchy]);

  /** JD-GUI: a JDK type (java.*) is a root marker — no entry to open. */
  /** JD-GUI: a type is a ROOT marker when it has no entry in the index (e.g.
   *  java.lang.Object, sun.*, com.sun.* — anything not in any opened jar).
   *  Those render as plain text, not clickable. */
  const isRootType = useCallback((name: string) => {
    const k = knownNamesRef.current;
    const dotted = name.replace(/\//g, '.');
    const simple = name.split('.').pop() ?? name;
    const slash = name.replace(/\./g, '/');
    return !(k.dotted.has(dotted) || k.simple.has(simple) || k.slash.has(slash));
  }, []);

  const handleHierarchySelect = useCallback((className: string) => {
    setHierarchySel(className);
    hierarchySelRef.current = className;
  }, []);

  // JD-GUI: opening a hierarchy node resolves the type to its real container
  // (jar_navigate) — a type may live in the main jar, a dependency library or
  // a nested jar, and guessing the entry path/container here would hit the
  // wrong jar.
  const openHierarchyType = useCallback(
    async (className: string) => {
      if (!project || isRootType(className)) return;
      setHierarchyOpen(false);
      try {
        const t = await jarApi.navigate(project.id, className.replace(/\//g, '.'), 'class');
        if (t.kind === 'multiple') {
          const cands = (t.candidates ?? []) as { entryPath: string; libraryId: string; projectId: string }[];
          if (cands.length === 1) {
            const c = cands[0];
            await handleSelect(c.entryPath, { libraryId: c.libraryId ?? '' });
            return;
          }
          setSelectLoc({ x: Math.round(window.innerWidth / 2 - 150), y: Math.round(window.innerHeight / 2 - 60), className: className.split('.').pop() ?? className, candidates: cands });
          return;
        }
        if (t.kind === 'class') {
          await handleSelect(t.entryPath, { libraryId: t.libraryId ?? '' });
        }
      } catch {
        /* unresolvable — stay quiet */
      }
    },
    [project, isRootType, handleSelect],
  );

  const handleHierarchyOpen = useCallback(() => {
    const sel = hierarchySelRef.current;
    if (!sel || isRootType(sel)) return;
    void openHierarchyType(sel);
  }, [isRootType, openHierarchyType]);

  const handleHierarchyOpenClass = useCallback(
    (className: string, _entryPath: string | null) => {
      if (isRootType(className)) return;
      void openHierarchyType(className);
    },
    [isRootType, openHierarchyType],
  );
  handleHierarchyOpenClassRef.current = handleHierarchyOpenClass;

  // F4 refreshes the hierarchy from the selected node (JD-GUI).
  const handleHierarchyRefresh = useCallback(async () => {
    const sel = hierarchySelRef.current ?? hierarchyDataRef.current?.target;
    if (!sel || !project) return;
    setHierarchyBusy(true);
    try {
      const data = await jarApi.typeHierarchy(project.id, classNameToEntryPath(sel), activeLibraryId ?? undefined);
      const d = data as { target: string; targetEntryPath: string; parents: string[]; parentSubTypes?: string[][]; subTypes: SubTypeNode[] };
      const d2 = { ...d, parentSubTypes: d.parentSubTypes ?? [] };
      setHierarchyData(d2);
      hierarchyDataRef.current = d2;
      setHierarchySel(d.target);
      hierarchySelRef.current = d.target;
    } catch (e) {
      toast.error(String(e));
    } finally {
      setHierarchyBusy(false);
    }
  }, [project, activeLibraryId]);

  // F4 key in the dialog refreshes (JD-GUI OpenTypeHierarchyView).
  const handleHierarchyKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault();
        void handleHierarchyRefresh();
      } else if (e.key === 'Escape') {
        setHierarchyOpen(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleHierarchyOpen();
      }
    },
    [handleHierarchyRefresh, handleHierarchyOpen],
  );

  // ── Go to Line (Ctrl+L): JD-GUI navigation. ──
  const handleGotoLine = useCallback(() => {
    if (!selectedEntry) return;
    setGotoLine('');
    setGotoOpen(true);
  }, [selectedEntry]);

  const handleGotoSubmit = useCallback(() => {
    const view2 = editorViewRef.current;
    if (!view2) return;
    const n = parseInt(gotoLine, 10);
    const maxLine = view2.state.doc.lines;
    setGotoOpen(false);
    setGotoError(null);
    if (Number.isNaN(n) || n <= 0 || n > maxLine) return;
    const pos = view2.state.doc.line(n).from;
    view2.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }, [gotoLine]);

  // JD-GUI GoToView validation: show the valid range and mark errors.
  const gotoMaxLine = editorViewRef.current?.state.doc.lines ?? 0;
  const gotoNum = parseInt(gotoLine, 10);
  const gotoInvalid = gotoLine !== '' && (Number.isNaN(gotoNum) || gotoNum < 1 || gotoNum > gotoMaxLine);
  const handleGotoInput = useCallback((v: string) => {
    setGotoLine(v.replace(/[^0-9]/g, ''));
    const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
    setGotoError(
      v.replace(/[^0-9]/g, '') !== '' && (Number.isNaN(n) || n < 1 || n > (editorViewRef.current?.state.doc.lines ?? 0))
        ? (editorViewRef.current ? `1..${editorViewRef.current.state.doc.lines}` : '')
        : null,
    );
  }, []);

  // Ctrl+L opens the dialog (editor focus included).
  useEffect(() => {
    if (!project || !selectedEntry) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleGotoLine();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, selectedEntry, handleGotoLine]);

  // ── Search in constant pools (Ctrl+Shift+S): JD-GUI. ──

  // JD-GUI SearchInConstantPools flag bits (exact values from source):
  // TYPE=1 CTOR=2 METHOD=4 FIELD=8 STRING=16 MODULE=32 DECL=64 REF=128.
  const buildConstFlags = useCallback(
    (f: typeof constFlags): number => {
      const bit = (b: boolean, n: number) => (b ? 1 << n : 0);
      return (
        bit(f.type, 0) | bit(f.constructor, 1) | bit(f.method, 2) | bit(f.field, 3) |
        bit(f.string, 4) | bit(f.module, 5) | bit(f.declaration, 6) | bit(f.reference, 7)
      );
    },
    [],
  );

  const runConstSearch = useCallback(
    async (pattern: string, flags: typeof constFlags) => {
      const projectId = project?.id;
      if (!projectId) return;
      const flagBits = buildConstFlags(flags);
      setConstBusy(true);
      try {
        const r = await jarApi.constantSearch(projectId, pattern, flagBits);
        setConstResults(r.results);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setConstBusy(false);
      }
    },
    [project, buildConstFlags],
  );

  const handleConstSearchOpen = useCallback(() => {
    setConstPattern('');
    setConstResults([]);
    setConstSearchOpen(true);
  }, []);

  const handleConstInput = useCallback(
    (raw: string) => {
      // JD-GUI SearchInConstantPoolsView: forbid '=', '(', ')', '{', '}',
      // '[', ']' and a leading digit.
      let value = raw.replace(/[=(){}[\]]/g, '');
      if (/^\d/.test(value)) value = value.slice(1);
      setConstPattern(value);
      if (constTimerRef.current) clearTimeout(constTimerRef.current);
      if (!value.trim()) {
        setConstResults([]);
        return;
      }
      constTimerRef.current = setTimeout(() => void runConstSearch(value.trim(), constFlags), 200);
    },
    [runConstSearch, constFlags],
  );

  const handleConstFlag = useCallback(
    (key: keyof typeof constFlags, v: boolean) => {
      const next = { ...constFlags, [key]: v };
      setConstFlags(next);
      if (constPattern.trim()) void runConstSearch(constPattern.trim(), next);
    },
    [constFlags, constPattern, runConstSearch],
  );

  const handleConstOpenClass = useCallback(
    (className: string, libraryId: string) => {
      setConstSearchOpen(false);
      if (!project) return;
      const entryPath = classNameToEntryPath(className);
      // JD-GUI: opening a constant-pool result highlights the matched text.
      if (constPattern.trim()) {
        pendingHighlightRef.current = constPattern.trim();
      }
      if (libraryId && libraryId !== activeLibraryId) {
        void handleSelectLibrary(libraryId).then(() => handleSelect(entryPath, { libraryId }));
      } else {
        void handleSelect(entryPath, { libraryId: libraryId ?? '' });
      }
    },
    [project, activeLibraryId, constPattern, handleSelectLibrary, handleSelect],
  );

  // Ctrl+Shift+S opens the dialog.
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's' && !e.altKey) {
        e.preventDefault();
        handleConstSearchOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handleConstSearchOpen]);

  // ── Preferences (Ctrl+Shift+P): font size / tab layout. ──
  const handlePrefsOpen = useCallback(() => {
    setPrefsOpen(true);
  }, []);

  // ── Paste Log (Ctrl+V): open clipboard text as a log viewer. ──
  const handlePasteLog = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error(t('toolbox.jar.pasteLogEmpty'));
        return;
      }
      setLogText(text);
      setSelectedEntry('__log__');
      setView(null);
      setEditorText('');
      setDirty(false);
      setResourceImage(null);
      setDecompileError(null);
      setClassInfo(null);
      toast.success(t('toolbox.jar.pasteLogOk'));
    } catch (e) {
      toast.error(String(e));
    }
  }, [t]);

  // Global Ctrl+V when not typing in an input (JD-GUI Paste Log).
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
        e.preventDefault();
        void handlePasteLog();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handlePasteLog]);

  // JD-GUI keyboard shortcuts: Ctrl+O open file, Ctrl+W close tab, F1 about.
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
      if (e.key === 'F1') {
        e.preventDefault();
        setAboutOpen(true);
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'o') {
          e.preventDefault();
          void handleOpenJar();
        } else if (k === 'w') {
          e.preventDefault();
          // JD-GUI: close the CURRENTLY SELECTED tab, not the last one.
          const activeTab = tabs.find(
            (t) => t.entryPath === selectedEntry && (t.libraryId || '') === (activeLibraryId ?? ''),
          ) ?? tabs[tabs.length - 1];
          handleCloseTab(activeTab?.key ?? '');
        } else if (k === 's' && !e.shiftKey && e.altKey) {
          // JD-GUI Save All Sources (Ctrl+Alt+S).
          e.preventDefault();
          void handleExportAll();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handleOpenJar, handleCloseTab, tabs, selectedEntry, activeLibraryId, handleExportAll]);

  const applyFontSize = useCallback((size: number) => {
    setPrefsFontSize(size);
    try {
      localStorage.setItem('nexterm.jar.fontSize', String(size));
    } catch { /* ignore */ }
    if (editorViewRef.current) {
      editorViewRef.current.dom.style.fontSize = `${size}px`;
      editorViewRef.current.requestMeasure();
    }
  }, []);

  const applyTabLayout = useCallback((single: boolean) => {
    setPrefsSingleLineTabs(single);
    try {
      localStorage.setItem('nexterm.jar.singleLineTabs', single ? 'true' : 'false');
    } catch { /* ignore */ }
  }, []);

  // ── JD-GUI Find panel (Ctrl+F): live highlight + Next/Prev + case. ──
  const runFind = useCallback(
    (query: string, caseSensitive: boolean) => {
      setFindQuery(query);
      setFindCaseSensitive(caseSensitive);
      applyFind(query, caseSensitive);
    },
    [applyFind],
  );

  const findStep = useCallback((dir: 1 | -1) => {
    const view = editorViewRef.current;
    const query = findQueryRef.current;
    if (!view || !query) return;
    const doc = view.state.doc.toString();
    const needle = findCaseRef.current ? query : query.toLowerCase();
    const hay = findCaseRef.current ? doc : doc.toLowerCase();
    const ranges: { from: number; to: number }[] = [];
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      ranges.push({ from: idx, to: idx + needle.length });
      idx += needle.length;
    }
    if (ranges.length === 0) {
      setFindMatchIndex(-1);
      setFindMatchCount(0);
      findMatchPosRef.current = null;
      view.dispatch({ effects: setFindEffect.of({ query, caseSensitive: findCaseRef.current, active: null }) });
      return;
    }
    const cur = findMatchPosRef.current;
    const curIdx = cur ? ranges.findIndex((r) => r.from === cur.from && r.to === cur.to) : -1;
    const nextIdx = dir === 1 ? (curIdx + 1 + ranges.length) % ranges.length : (curIdx - 1 + ranges.length) % ranges.length;
    const active = ranges[nextIdx];
    findMatchPosRef.current = active;
    setFindMatchIndex(nextIdx + 1);
    setFindMatchCount(ranges.length);
    view.dispatch({
      effects: setFindEffect.of({ query, caseSensitive: findCaseRef.current, active }),
      selection: { anchor: active.from, head: active.to },
      scrollIntoView: true,
    });
  }, []);

  const handleFindOpen = useCallback(() => {
    setFindOpen(true);
    const view = editorViewRef.current;
    if (view && findQuery) {
      applyFind(findQuery, findCaseSensitive);
      findNextFnRef.current = () => findStep(1);
      findPrevFnRef.current = () => findStep(-1);
    }
    // Focus the find input after render.
    setTimeout(() => {
      (document.getElementById('jar-find-input') as HTMLInputElement | null)?.focus();
      (document.getElementById('jar-find-input') as HTMLInputElement | null)?.select();
    }, 0);
  }, [findQuery, findCaseSensitive, applyFind, findStep]);

  const handleFindClose = useCallback(() => {
    setFindOpen(false);
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({ effects: setFindEffect.of(null) });
    }
    setFindMatchIndex(-1);
    setFindMatchCount(0);
    findMatchPosRef.current = null;
  }, []);

  // Ctrl+F opens the Find panel (works even when the editor has focus).
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        // Let the CodeMirror editor handle its own find when focused.
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
        e.preventDefault();
        handleFindOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handleFindOpen]);

  // Persist find history (most recent first, dedupe, cap 10).
  const commitFindHistory = useCallback((q: string) => {
    if (!q) return;
    setFindHistory((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, 10);
      try {
        localStorage.setItem('nexterm.jar.findHistory', JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Enter in the find input: commit history + jump to next.
  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitFindHistory(findQuery);
        findNextFnRef.current?.();
      } else if (e.key === 'Escape') {
        handleFindClose();
      }
    },
    [findQuery, commitFindHistory, handleFindClose],
  );

  // Ctrl+Shift+P opens preferences.
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p' && !e.altKey) {
        e.preventDefault();
        handlePrefsOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handlePrefsOpen]);

  // ── Back / Forward navigation (Alt+← / Alt+→, JD-GUI). ──
  const handleNavBack = useCallback(() => {
    setNavIndex((i) => {
      const target = i - 1;
      if (target < 0) return i;
      const item = navHistory[target];
      if (item) {
        // JD-GUI: restore the caret position saved for this page.
        if (typeof item.position === 'number') pendingGotoPositionRef.current = item.position;
        if (item.libraryId !== activeLibraryId) {
          void handleSelectLibrary(item.libraryId).then(() => handleSelect(item.entryPath, { history: false, libraryId: item.libraryId ?? '' }));
        } else {
          void handleSelect(item.entryPath, { history: false, libraryId: item.libraryId ?? '' });
        }
      }
      return target;
    });
  }, [navHistory, activeLibraryId, handleSelectLibrary, handleSelect]);

  const handleNavForward = useCallback(() => {
    setNavIndex((i) => {
      const target = i + 1;
      if (target >= navHistory.length) return i;
      const item = navHistory[target];
      if (item) {
        if (typeof item.position === 'number') pendingGotoPositionRef.current = item.position;
        if (item.libraryId !== activeLibraryId) {
          void handleSelectLibrary(item.libraryId).then(() => handleSelect(item.entryPath, { history: false, libraryId: item.libraryId ?? '' }));
        } else {
          void handleSelect(item.entryPath, { history: false, libraryId: item.libraryId ?? '' });
        }
      }
      return target;
    });
  }, [navHistory, activeLibraryId, handleSelectLibrary, handleSelect]);

  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          handleNavBack();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          handleNavForward();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, handleNavBack, handleNavForward]);

  const modifiedCount = modifiedSet.size;
  const normalizedTree = useMemo(() => {
    if (!tree) return null;
    return normalizeContainerTree(tree);
  }, [tree]);

  const normalizedLibTrees = useMemo(() => {
    const out: Record<string, Record<string, PackageNode>> = {};
    for (const [id, t] of Object.entries(libTrees)) {
      out[id] = normalizeContainerTree(t);
    }
    return out;
  }, [libTrees]);

  // ── JD-GUI container tree: expand/collapse a container; lazily load a
  //    dependency library's tree on first expansion (no editor side effects —
  //    unlike handleSelectLibrary, which also switches the active container). ──
  const ensureLibTree = useCallback(
    async (libraryId: string) => {
      if (!project || libTrees[libraryId]) return;
      try {
        const idx = await jarApi.libraryIndex(project.id, libraryId);
        setLibTrees((prev) => ({ ...prev, [libraryId]: idx }));
        const names = new Set(classNameSetRef.current);
        collectClassNames(idx, names);
        classNameSetRef.current = names;
      } catch (e) {
        toast.error(String(e));
      }
    },
    [project, libTrees],
  );

  const toggleContainer = useCallback(
    (libraryId: string) => {
      setExpandedLibs((prev) => {
        const next = new Set(prev);
        if (next.has(libraryId)) next.delete(libraryId);
        else next.add(libraryId);
        return next;
      });
      if (libraryId) void ensureLibTree(libraryId);
    },
    [ensureLibTree],
  );

  // While filtering, every container is force-expanded so matches are visible.
  const filterActive = query.trim().length > 0;

  // Filtering force-expands library containers → make sure their trees are
  // actually loaded (lazy loading is normally triggered by expansion clicks).
  useEffect(() => {
    if (!filterActive || !project) return;
    for (const lib of libraries) {
      if (!libTrees[lib.id]) void ensureLibTree(lib.id);
    }
  }, [filterActive, libraries, libTrees, ensureLibTree, project]);

  return (
    <div ref={rootRef} className="h-full flex flex-col overflow-hidden bg-background relative">
      {/* Drop overlay (drag a .jar onto the panel to open it). */}
      {dropOverlay && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 border-2 border-dashed border-primary rounded-lg pointer-events-none">
          <div className="text-sm text-primary font-medium flex items-center gap-2">
            <Archive className="h-5 w-5" />
            {t('toolbox.jar.dropHere')}
          </div>
        </div>
      )}

      {/* Open Type dialog (JD-GUI Ctrl+T) */}
      <Dialog open={openTypeOpen && !!project} onOpenChange={(o) => { if (!o) setOpenTypeOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[540px] p-0 gap-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={openTypeInputRef}
              autoFocus
              value={openTypePattern}
              onChange={(e) => handleOpenTypeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpenTypeOpen(false);
                if (e.key === 'Enter' && openTypeResults.length > 0) {
                  const r = openTypeResults[Math.min(openTypeSel, openTypeResults.length - 1)];
                  handleOpenTypePick(r.entryPath, r.libraryId, r.projectId);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (openTypeResults.length > 0) {
                    setOpenTypeSel(0);
                    // JD-GUI: ↓ moves focus into the result list.
                    openTypeListRef.current?.focus();
                  }
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setOpenTypeSel((s) => Math.max(s - 1, 0));
                }
              }}
              placeholder={t('toolbox.jar.openTypePlaceholder')}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] border border-border hover:bg-muted"
              onClick={() => {
                const next = openTypeScope === 'current' ? 'all' : 'current';
                setOpenTypeScope(next);
                setOpenTypeSel(0);
                if (openTypePattern.trim()) {
                  void (async () => {
                    setOpenTypeBusy(true);
                    try {
                      const results = await jarApi.openType(project!.id, openTypePattern.trim(), next);
                      setOpenTypeResults(results);
                    } catch (e) {
                      toast.error(String(e));
                    } finally {
                      setOpenTypeBusy(false);
                    }
                  })();
                }
              }}
              title={t('toolbox.jar.openTypeScopeHint')}
            >
              {openTypeScope === 'current' ? t('toolbox.jar.openTypeScopeCurrent') : t('toolbox.jar.openTypeScopeAll')}
            </button>
            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
              {openTypeBusy ? '…' : `${openTypeResults.length}`}
            </span>
          </div>
          <div
            ref={openTypeListRef}
            tabIndex={-1}
            className="max-h-[46vh] overflow-auto p-1.5 outline-none"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpenTypeSel((s) => Math.min(s + 1, Math.min(openTypeResults.length - 1, 79)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setOpenTypeSel((s) => {
                  if (s <= 0) {
                    // JD-GUI: ↑ from the first row returns focus to the field.
                    openTypeInputRef.current?.focus();
                    return 0;
                  }
                  return s - 1;
                });
              } else if (e.key === 'Enter' && openTypeResults.length > 0) {
                e.preventDefault();
                const r = openTypeResults[Math.min(openTypeSel, openTypeResults.length - 1)];
                handleOpenTypePick(r.entryPath, r.libraryId, r.projectId);
              } else if (e.key === 'Escape') {
                setOpenTypeOpen(false);
              }
            }}
          >
            {openTypeResults.length === 0 ? (
              <p className="px-3 py-8 text-xs text-muted-foreground text-center">
                {openTypeBusy ? '…' : t('toolbox.jar.openTypeEmpty')}
              </p>
            ) : (
              <>
                {openTypeResults.slice(0, 80).map((r, i) => (
                  <button
                    key={`${r.libraryId}:${r.entryPath}`}
                    type="button"
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-xs ${
                      i === openTypeSel ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'hover:bg-accent'
                    }`}
                    onMouseEnter={() => setOpenTypeSel(i)}
                    onDoubleClick={() => handleOpenTypePick(r.entryPath, r.libraryId, r.projectId)}
                    onClick={() => handleOpenTypePick(r.entryPath, r.libraryId, r.projectId)}
                  >
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                    {/* JD-GUI: "shortName - package" */}
                    <span className="truncate">
                      <span className="font-medium">{r.className.split('.').pop()}</span>
                      {r.packageName ? <span className="text-muted-foreground"> - {r.packageName}</span> : null}
                    </span>
                    {openTypeScope === 'all' && r.projectName && (
                      <span className="shrink-0 text-[9px] text-muted-foreground border border-border rounded px-1 max-w-[120px] truncate">{r.projectName}</span>
                    )}
                    {r.libraryId && <span className="shrink-0 text-[9px] text-muted-foreground">dep</span>}
                    {r.modified && <span className="shrink-0 text-[9px] text-amber-600">改</span>}
                  </button>
                ))}
                {openTypeResults.length > 80 && (
                  <p className="px-3 py-1 text-[10px] text-muted-foreground text-center">… +{openTypeResults.length - 80} {t('toolbox.jar.moreResults')}</p>
                )}
              </>
            )}
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex gap-3">
            <span>↑↓ {t('toolbox.jar.openTypeNav')}</span>
            <span>↵ {t('toolbox.jar.openTypeEnter')}</span>
            <span>esc {t('toolbox.jar.openTypeEsc')}</span>
          </div>
        </DialogContent>
      </Dialog>

      {/* Type hierarchy dialog (JD-GUI Ctrl+H) */}
      <Dialog open={hierarchyOpen} onOpenChange={(o) => { if (!o) setHierarchyOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[500px] p-0 gap-0 overflow-hidden" onKeyDown={handleHierarchyKeyDown}>
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-semibold">{t('toolbox.jar.hierarchy')}</span>
            <span className="ml-auto text-[10px] text-muted-foreground truncate font-mono">{hierarchyData?.target ?? selectedEntry}</span>
          </div>
          <div className="max-h-[52vh] overflow-auto p-2 font-mono text-xs">
            {hierarchyBusy ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> {t('toolbox.jar.hierarchyLoading')}
              </div>
            ) : hierarchyData ? (
              <div className="space-y-0.5">
                {/* Parents (reversed: root first). Root (unresolvable) markers. */}
                {[...hierarchyData.parents].reverse().map((p, i) => {
                  const jdk = isRootType(p);
                  // parentSubTypes aligns with parents[] (unreversed); the
                  // reversed position i maps to index parents.length-1-i.
                  const pIdx = hierarchyData.parents.length - 1 - i;
                  const siblings = hierarchyData.parentSubTypes?.[pIdx] ?? [];
                  const node = jdk ? (
                    <div
                      key={p}
                      className="w-full flex items-center gap-1 px-2 py-1 rounded opacity-70 text-left"
                      style={{ paddingLeft: `${(i + 1) * 16}px` }}
                    >
                      <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                      <span className="truncate">{p}</span>
                    </div>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      className={`w-full flex items-center gap-1 px-2 py-1 rounded text-left ${hierarchySel === p ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'hover:bg-accent'}`}
                      style={{ paddingLeft: `${(i + 1) * 16}px` }}
                      onClick={() => handleHierarchySelect(p)}
                      onDoubleClick={() => handleHierarchyOpenClass(p, classNameToEntryPath(p))}
                    >
                      <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                      <span className="truncate">{p}</span>
                    </button>
                  );
                  // JD-GUI populateTreeNode: show this level's sibling types.
                  const childOnPath = i === 0 ? hierarchyData.target : hierarchyData.parents[hierarchyData.parents.length - i];
                  const siblingsExcept = siblings.filter((s) => s !== childOnPath);
                  return (
                    <div key={`grp-${p}`}>
                      {node}
                      {siblingsExcept.length > 0 && (
                        <div className="ml-4 border-l border-border/50 pl-1">
                          {siblingsExcept.map((s) => (
                            <button
                              key={s}
                              type="button"
                              className={`w-full flex items-center gap-1 px-2 py-0.5 rounded text-left text-[11px] ${hierarchySel === s ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60'}`}
                              style={{ paddingLeft: `${(i + 1) * 16}px` }}
                              onClick={() => handleHierarchySelect(s)}
                              onDoubleClick={() => handleHierarchyOpenClass(s, classNameToEntryPath(s))}
                            >
                              <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                              <span className="truncate">{s}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Target (always selectable) */}
                <button
                  type="button"
                  className={`w-full flex items-center gap-1 px-2 py-1 rounded text-left font-semibold ${hierarchySel === hierarchyData.target ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'bg-primary/5 text-primary'}`}
                  style={{ paddingLeft: `${(hierarchyData.parents.length + 1) * 16}px` }}
                  onClick={() => handleHierarchySelect(hierarchyData.target)}
                  onDoubleClick={() => handleHierarchyOpenClass(hierarchyData.target, hierarchyData.targetEntryPath)}
                >
                  <CornerDownRight className="h-3 w-3 shrink-0" />
                  <span className="truncate">{hierarchyData.target}</span>
                </button>
                {/* Subtypes tree */}
                <SubTypeNodes
                  nodes={(hierarchyData.subTypes as unknown) as SubTypeNode[]}
                  depth={hierarchyData.parents.length + 2}
                  selected={hierarchySel}
                  isJdk={isRootType}
                  onSelect={handleHierarchySelect}
                  onOpen={handleHierarchyOpenClass}
                />
              </div>
            ) : (
              <p className="py-6 text-center text-muted-foreground">{t('toolbox.jar.hierarchyEmpty')}</p>
            )}
          </div>
          <div className="flex items-center gap-2 px-3 py-2 border-t text-[10px] text-muted-foreground">
            <span>{t('toolbox.jar.hierarchyHint')}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">F4 {t('toolbox.jar.hierarchyRefresh')}</span>
            <div className="flex items-center gap-1.5 ml-3">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setHierarchyOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleHierarchyOpen} disabled={!hierarchySel || isRootType(hierarchySel ?? '')}>
                {t('toolbox.jar.openTypeOpen')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Go to Line dialog (JD-GUI Ctrl+L) */}
      <Dialog open={gotoOpen} onOpenChange={(o) => { if (!o) setGotoOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[320px] p-0 gap-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <CornerDownRight className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t('toolbox.jar.gotoLine')}</span>
          </div>
          <div className="p-3">
            <Input
              autoFocus
              value={gotoLine}
              onChange={(e) => handleGotoInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setGotoOpen(false);
                if (e.key === 'Enter' && !gotoInvalid) handleGotoSubmit();
              }}
              placeholder={t('toolbox.jar.gotoPlaceholder')}
              className={`h-9 text-sm font-mono ${gotoError ? 'border-destructive ring-1 ring-destructive/40' : ''}`}
            />
            {/* JD-GUI GoToView: show the valid range and a red error hint. */}
            {gotoLine !== '' && (
              <p className={`mt-1.5 text-[10px] font-mono ${gotoInvalid ? 'text-destructive' : 'text-muted-foreground'}`}>
                {gotoInvalid
                  ? t('toolbox.jar.gotoOutOfRange', { range: gotoMaxLine })
                  : t('toolbox.jar.gotoRangeHint', { range: gotoMaxLine })}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t text-[10px] text-muted-foreground">
            <span>↵ {t('toolbox.jar.openTypeEnter')}</span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setGotoOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleGotoSubmit} disabled={gotoInvalid}>
                {t('toolbox.jar.openTypeOpen')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Search in constant pools dialog (JD-GUI Ctrl+Shift+S) */}
      <Dialog open={constSearchOpen && !!project} onOpenChange={(o) => { if (!o) setConstSearchOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[580px] p-0 gap-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={constPattern}
              onChange={(e) => handleConstInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setConstSearchOpen(false);
                // JD-GUI default button: Enter opens the first result.
                if (e.key === 'Enter' && constResults.length > 0) {
                  const first = constResults[0];
                  handleConstOpenClass(first.className, first.libraryId);
                }
              }}
              placeholder={t('toolbox.jar.constPlaceholder')}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{constBusy ? '…' : constResults.length}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-b text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.type} onChange={(e) => handleConstFlag('type', e.target.checked)} />
              {t('toolbox.jar.constType')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.constructor} onChange={(e) => handleConstFlag('constructor', e.target.checked)} />
              {t('toolbox.jar.constConstructor')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.method} onChange={(e) => handleConstFlag('method', e.target.checked)} />
              {t('toolbox.jar.constMethods')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.field} onChange={(e) => handleConstFlag('field', e.target.checked)} />
              {t('toolbox.jar.constFields')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.string} onChange={(e) => handleConstFlag('string', e.target.checked)} />
              {t('toolbox.jar.constStrings')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.module} onChange={(e) => handleConstFlag('module', e.target.checked)} />
              {t('toolbox.jar.constModule')}
            </label>
            <span className="mx-1 text-muted-foreground/50">|</span>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.declaration} onChange={(e) => handleConstFlag('declaration', e.target.checked)} />
              {t('toolbox.jar.constDeclaration')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.reference} onChange={(e) => handleConstFlag('reference', e.target.checked)} />
              {t('toolbox.jar.constReference')}
            </label>
          </div>
          <div className="max-h-[42vh] overflow-auto p-1.5">
            {constResults.length === 0 ? (
              <p className="px-3 py-8 text-xs text-muted-foreground text-center">{constBusy ? '…' : t('toolbox.jar.constEmpty')}</p>
            ) : (
              // JD-GUI groups results by CONTAINER (main jar / each library).
              (() => {
                const groups = new Map<string, typeof constResults>();
                for (const f of constResults) {
                  const key = f.libraryId || '(main)';
                  const arr = groups.get(key) ?? [];
                  arr.push(f);
                  groups.set(key, arr);
                }
                return [...groups.entries()].map(([libKey, files]) => (
                  <div key={libKey} className="mb-1.5">
                    <div className="sticky top-0 z-10 bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground border-b border-border/60">
                      {libKey === '(main)' ? t('toolbox.jar.mainProject') : `${t('toolbox.jar.constLibrary')} ${libKey.slice(0, 16)}`}
                      <span className="ml-1 text-muted-foreground/60">({files.length})</span>
                    </div>
                    {files.map((file) => {
                      // Package = path before the class file name.
                      const pkg = file.entryPath.includes('/') ? file.entryPath.substring(0, file.entryPath.lastIndexOf('/')) : '';
                      return (
                        <button
                          key={`${file.libraryId}:${file.entryPath}`}
                          type="button"
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-xs hover:bg-accent"
                          style={{ paddingLeft: `${8 + Math.min(pkg.split('/').length, 6) * 10}px` }}
                          onClick={() => handleConstOpenClass(file.className, file.libraryId)}
                        >
                          <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                            {file.matches.length}
                          </span>
                          <span className="truncate font-mono">{file.className}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground truncate max-w-[40%]">
                            {file.matches.slice(0, 2).map((m) => m.kind === 'string' ? `"${m.value}"` : m.value).join(' · ')}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            )}
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex justify-between">
            <span>{t('toolbox.jar.constHint')}</span>
            <span>esc {t('toolbox.jar.openTypeEsc')}</span>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preferences dialog (JD-GUI Ctrl+Shift+P) */}
      <Dialog open={prefsOpen} onOpenChange={(o) => { if (!o) setPrefsOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[360px] p-0 gap-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <Settings className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t('toolbox.jar.preferences')}</span>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <div className="text-xs font-medium mb-1.5">{t('toolbox.jar.prefFontSize')}</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => applyFontSize(Math.max(2, prefsFontSize - 1))}>−</Button>
                <span className="w-10 text-center text-sm font-mono">{prefsFontSize}px</span>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => applyFontSize(Math.min(40, prefsFontSize + 1))}>+</Button>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium mb-1.5">{t('toolbox.jar.prefTabLayout')}</div>
              <div className="flex gap-2">
                <Button size="sm" variant={prefsSingleLineTabs ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => applyTabLayout(true)}>
                  {t('toolbox.jar.prefTabsSingle')}
                </Button>
                <Button size="sm" variant={prefsSingleLineTabs ? 'outline' : 'default'} className="h-7 text-xs" onClick={() => applyTabLayout(false)}>
                  {t('toolbox.jar.prefTabsWrap')}
                </Button>
              </div>
            </div>
            {/* JD-GUI decompiler / saver preferences */}
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-xs font-medium mb-1.5">{t('toolbox.jar.prefDecompiler')}</div>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" className="accent-primary" checked={prefEscapeUnicode} onChange={(e) => { setPrefEscapeUnicode(e.target.checked); savePref('nexterm.jar.escapeUnicode', e.target.checked); }} />
                {t('toolbox.jar.prefEscapeUnicode')}
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" className="accent-primary" checked={prefRealignLineNumbers} onChange={(e) => { setPrefRealignLineNumbers(e.target.checked); savePref('nexterm.jar.realignLineNumbers', e.target.checked); }} />
                {t('toolbox.jar.prefRealignLines')}
              </label>
            </div>
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-xs font-medium mb-1.5">{t('toolbox.jar.prefSaver')}</div>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" className="accent-primary" checked={prefWriteLineNumbers} onChange={(e) => { setPrefWriteLineNumbers(e.target.checked); savePref('nexterm.jar.writeLineNumbers', e.target.checked); }} />
                {t('toolbox.jar.prefWriteLineNumbers')}
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" className="accent-primary" checked={prefWriteMetadata} onChange={(e) => { setPrefWriteMetadata(e.target.checked); savePref('nexterm.jar.writeMetadata', e.target.checked); }} />
                {t('toolbox.jar.prefWriteMetadata')}
              </label>
            </div>
            {/* JD-GUI MavenOrgSourceLoader preferences */}
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-xs font-medium mb-1.5">{t('toolbox.jar.prefMaven')}</div>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" className="accent-primary" checked={prefMavenEnabled} onChange={(e) => { setPrefMavenEnabled(e.target.checked); savePref('nexterm.jar.mavenEnabled', e.target.checked); }} />
                {t('toolbox.jar.prefMavenEnabled')}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <span className="shrink-0">{t('toolbox.jar.prefMavenFilters')}</span>
                <Input
                  value={prefMavenFilters}
                  onChange={(e) => { setPrefMavenFilters(e.target.value); try { localStorage.setItem('nexterm.jar.mavenFilters', e.target.value); } catch { /* ignore */ } }}
                  className="h-7 text-[11px] font-mono"
                  placeholder="+org.springframework +org.apache"
                />
              </label>
            </div>
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex justify-end">
            <span>esc {t('toolbox.jar.openTypeEsc')}</span>
          </div>
        </DialogContent>
      </Dialog>
      {/* About dialog (JD-GUI F1) */}
      <Dialog open={aboutOpen} onOpenChange={(o) => { if (!o) setAboutOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[360px] p-0 gap-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <Archive className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t('toolbox.jar.about')}</span>
          </div>
          <div className="p-4 space-y-2">
            <p className="text-sm font-semibold">{t('toolbox.jar.aboutName')}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{t('toolbox.jar.aboutDesc')}</p>
            <p className="text-[10px] font-mono text-muted-foreground">{t('toolbox.jar.aboutVersion')}</p>
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex justify-end">
            <Button size="sm" className="h-7 text-xs" onClick={() => setAboutOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Archive className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">{t('toolbox.jar.title')}</span>
        </div>
        <div className="flex items-center gap-1 ml-2">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void handleOpenJar()}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t('toolbox.jar.openJar')}
          </Button>
          {recent.length > 0 && (
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                onClick={() => setRecentOpen((v) => !v)}
              >
                <History className="h-3.5 w-3.5" />
                {t('toolbox.jar.recentFiles')}
              </Button>
              {recentOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setRecentOpen(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[240px] rounded-md border border-border bg-popover shadow-md p-1">
                    {recent.map((r) => (
                      <button
                        key={r.path}
                        type="button"
                        className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted flex items-center gap-2"
                        onClick={() => {
                          setRecentOpen(false);
                          void openProjectByPath(r.path);
                        }}
                      >
                        <Archive className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="font-mono truncate flex-1" title={r.path}>
                          {shortenRecentPath(r.path)}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {new Date(r.at).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void handleOpenPom()}>
            <FileCode2 className="h-3.5 w-3.5" />
            pom.xml
          </Button>
          {pomInfo && (
            <Badge variant="outline" className="text-[10px] font-mono max-w-[160px] truncate" title={`${pomInfo.groupId}:${pomInfo.artifactId}:${pomInfo.version}`}>
              {pomInfo.artifactId}:{pomInfo.version}
            </Badge>
          )}
          {project && (
            <>
              <Badge variant="outline" className="text-[10px] font-mono max-w-[200px] truncate">
                {project.name}
              </Badge>
              <Badge variant="outline" className="text-[10px]">{project.classCount} cls</Badge>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {project && (
            <div className="flex items-center gap-0.5 mr-1">
              {/* JD-GUI toolbar: OpenType (Ctrl+T) and Search (Ctrl+Shift+S). */}
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleOpenTypeOpen} title={`${t('toolbox.jar.openType')} (Ctrl+T)`}>
                <Search className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleConstSearchOpen} title={`${t('toolbox.jar.searchConstants')} (Ctrl+Shift+S)`}>
                <Filter className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleFindOpen} title={`${t('toolbox.jar.findLabel')} (Ctrl+F)`}>
                <FileSearch className="h-4 w-4" />
              </Button>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={navIndex <= 0} onClick={handleNavBack} title={t('toolbox.jar.back')}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={navIndex >= navHistory.length - 1} onClick={handleNavForward} title={t('toolbox.jar.forward')}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          {busy && (
            <div className="w-44 flex items-center gap-2">
              <Progress value={exportProgress?.total ? (exportProgress.completed / exportProgress.total) * 100 : 0} className="h-1.5" />
              <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                {exportProgress?.total ? t('toolbox.jar.exportProgress', { completed: exportProgress.completed, total: exportProgress.total }) : busyLabel}
              </span>
              <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]" onClick={handleCancelExport}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
          {project && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={busy} onClick={() => void handleExportAll()}>
              <Download className="h-3.5 w-3.5" />
              {t('toolbox.jar.exportAll')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Left: JAR tree */}
        <div className="w-72 shrink-0 border-r border-border flex flex-col min-h-0">
          <div className="p-2 border-b border-border shrink-0">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
                placeholder={t('toolbox.jar.searchPlaceholder')}
                className="pl-7 h-7 text-xs"
              />            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            {!project ? (
              <div className="p-6 text-center text-xs text-muted-foreground space-y-2">
                <Archive className="h-8 w-8 mx-auto opacity-40" />
                <p>{t('toolbox.jar.emptyDesc')}</p>
                <p className="text-[10px] leading-relaxed">
                  {t('toolbox.jar.emptyHints')}
                </p>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void handleOpenJar()}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('toolbox.jar.openJar')}
                </Button>
              </div>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {/* JD-GUI container tree: every jar (main project + dependency
                    libraries) is its own root node; library trees load lazily
                    on first expansion. */}
                {/* Main project container */}
                <div>
                  <button
                    type="button"
                    className="w-full flex items-center gap-1 pr-1 py-1 text-[11px] font-medium hover:bg-muted/60 rounded text-left"
                    onClick={() => toggleContainer('')}
                  >
                    {expandedLibs.has('') ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    <Archive className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    <span className="truncate">{project.name}</span>
                    {libraries.length > 0 && (
                      <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">{t('toolbox.jar.mainProject')}</span>
                    )}
                  </button>
                  {(filterActive || expandedLibs.has('')) && normalizedTree && (
                    <div className="ml-2 border-l border-border/60 pl-1">
                      {(Object.values(normalizedTree)
                        .map((node) => filterTree(node, query.trim()))
                        .filter((n): n is PackageNode => n !== null) as PackageNode[])
                        .map((node) => (
                          <TreeNode
                            key={node.name}
                            node={node}
                            depth={0}
                            selected={selectedEntry}
                            modifiedSet={modifiedSet}
                            containerLibraryId=""
                            forceOpen={query.trim().length > 0}
                            onSelect={(e, libId) => void handleSelect(e, { libraryId: libId })}
                            onResourceOpen={(e, libId) => void handleOpenResource(e, libId)}
                            onContextMenu={handleTreeContextMenu}
                          />
                        ))}
                    </div>
                  )}
                </div>
                {/* Dependency library containers */}
                {libraries.map((lib) => {
                  const libLabel = lib.name.split('|')[0];
                  const isNested = lib.name.startsWith('[nested]');
                  const badge = lib.editable ? '' : isNested ? t('toolbox.jar.nestedLib') : t('toolbox.jar.depLib');
                  const libOpen = filterActive || expandedLibs.has(lib.id);
                  const libTree = normalizedLibTrees[lib.id] ?? null;
                  return (
                    <div key={lib.id}>
                      <button
                        type="button"
                        className="w-full flex items-center gap-1 pr-1 py-1 text-[11px] font-medium hover:bg-muted/60 rounded text-left"
                        onClick={() => toggleContainer(lib.id)}
                        title={lib.name}
                      >
                        {libOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                        <Archive className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                        <span className="truncate">{libLabel}</span>
                        {badge && <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">{badge}</span>}
                      </button>
                      {libOpen && (
                        <div className="ml-2 border-l border-border/60 pl-1">
                          {libTree ? (
                            (Object.values(libTree)
                              .map((node) => filterTree(node, query.trim()))
                              .filter((n): n is PackageNode => n !== null) as PackageNode[])
                              .map((node) => (
                                <TreeNode
                                  key={node.name}
                                  node={node}
                                  depth={0}
                                  selected={selectedEntry}
                                  modifiedSet={modifiedSet}
                                  containerLibraryId={lib.id}
                                  forceOpen={query.trim().length > 0}
                                  onSelect={(e, libId) => void handleSelect(e, { libraryId: libId })}
                                  onResourceOpen={(e, libId) => void handleOpenResource(e, libId)}
                                  onContextMenu={handleTreeContextMenu}
                                />
                              ))
                          ) : (
                            <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t('toolbox.jar.loadingLib')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Center: editor */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar (JD-GUI style) */}
          {tabs.length > 0 && (
            <div className={`flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/20 shrink-0 ${prefsSingleLineTabs ? 'overflow-x-auto' : 'flex-wrap'}`}>
              {tabs.map((tab) => {
                const active = tab.entryPath === selectedEntry;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    className={`group flex items-center gap-1 px-2 py-1 rounded-t text-[11px] font-mono whitespace-nowrap ${
                      active ? 'bg-background border border-b-0 border-border text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                    }`}
                    onClick={() => handleSwitchTab(tab.key)}
                    onContextMenu={(e) => handleTabContextMenu(e, tab.key)}
                    title={`${tab.entryPath}${tab.libraryId ? ` · ${tab.libraryId}` : ''}`}
                  >
                    <span className="max-w-[140px] truncate">{tab.title}</span>
                    {modifiedSet.has(tab.entryPath) && <span className="text-amber-500">●</span>}
                    <span
                      role="button"
                      className="ml-0.5 rounded hover:bg-muted text-muted-foreground/60 group-hover:text-foreground px-0.5"
                      onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.key); }}
                      aria-label={t('common.close')}
                    >
                      ✕
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                className="ml-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted rounded"
                onClick={handleCloseAllTabs}
                title={t('toolbox.jar.closeAllTabs')}
              >
                {t('toolbox.jar.closeAllTabs')}
              </button>
            </div>
          )}
          {/* Tab context menu */}
          {tabMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setTabMenu(null)} />
              <div
                className="fixed z-50 min-w-[150px] rounded-md border border-border bg-popover shadow-md p-1"
                style={{ left: tabMenu.x, top: tabMenu.y }}
              >
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted"
                  onClick={() => {
                    const k = tabMenu.key;
                    setTabMenu(null);
                    handleCloseTab(k);
                  }}
                >
                  {t('toolbox.jar.closeTab')}
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted"
                  onClick={() => handleCloseOtherTabs(tabMenu.key)}
                >
                  {t('toolbox.jar.closeOthers')}
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted"
                  onClick={() => handleCopyTabName(tabMenu.key)}
                >
                  {t('toolbox.jar.copyClassName')}
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted"
                  onClick={handleCloseAllTabs}
                >
                  {t('toolbox.jar.closeAllTabs')}
                </button>
                {/* JD-GUI TabbedPanel: "Select Tab" only when tabs are on a
                    single line (non-Mac: WRAP layout hides it). */}
                {tabs.length > 1 && prefsSingleLineTabs && (
                  <>
                    <div className="my-1 border-t border-border" />
                    <div className="px-2 py-1 text-[10px] text-muted-foreground font-medium">{t('toolbox.jar.selectTab')}</div>
                    {tabs.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        className={`w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-muted ${tab.key === tabMenu.key ? 'font-semibold text-primary' : ''}`}
                        onClick={() => {
                          setTabMenu(null);
                          handleSwitchTab(tab.key);
                        }}
                      >
                        {tab.title}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
          {/* Tree node context menu */}
          {treeMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setTreeMenu(null)} />
              <div
                className="fixed z-50 min-w-[190px] rounded-md border border-border bg-popover shadow-md p-1"
                style={{ left: treeMenu.x, top: treeMenu.y }}
              >
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted"
                  onClick={() => handleCopyQualifiedName(treeMenu.className, treeMenu.kind)}
                >
                  {t('toolbox.jar.copyQualifiedName')}
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted"
                  onClick={() => {
                    const ep = treeMenu.entryPath;
                    const libId = treeMenu.libraryId;
                    setTreeMenu(null);
                    void handleSelect(ep, { libraryId: libId });
                  }}
                >
                  {t('toolbox.jar.openClass')}
                </button>
              </div>
            </>
          )}
          {/* JD-GUI SelectLocation: same type in several containers. */}
          {selectLoc && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSelectLoc(null)} />
              <div
                className="fixed z-50 min-w-[280px] max-w-[420px] rounded-md border border-border bg-popover shadow-md p-1"
                style={{ left: Math.max(8, Math.min(selectLoc.x, window.innerWidth - 300)), top: Math.max(8, selectLoc.y) }}
              >
                <div className="px-2 py-1.5 text-[10px] text-muted-foreground font-medium border-b border-border mb-1">
                  {t('toolbox.jar.selectLocation')} — {selectLoc.className}
                </div>
                {selectLoc.candidates.map((c) => (
                  <button
                    key={`${c.projectId}:${c.libraryId}:${c.entryPath}`}
                    type="button"
                    className="w-full text-left px-2 py-1.5 rounded text-xs font-mono hover:bg-muted flex items-center gap-2"
                    onClick={() => {
                      const cand = selectLoc;
                      setSelectLoc(null);
                      const c2 = c;
                      void (async () => {
                        if (c2.projectId && c2.projectId !== project?.id) {
                          const p = await jarApi.openProjectFromId(c2.projectId);
                          setProject(p);
                          const idx = await jarApi.classIndex(p.id);
                          setTree(idx);
                          const names = new Set<string>();
                          collectClassNames(idx, names);
                          classNameSetRef.current = names;
                          setSelectedEntry(null);
                          selectedEntryRef.current = null;
                          setView(null);
                          setEditorText('');
                          setDirty(false);
                          setLibraries([]);
                          setActiveLibraryId(null);
                          setPomInfo(null);
                          setTabs([]);
                          if (c2.libraryId) await handleSelectLibrary(c2.libraryId);
                          await handleSelect(c2.entryPath);
                        } else if (c2.libraryId && c2.libraryId !== activeLibraryId) {
                          await handleSelectLibrary(c2.libraryId);
                          await handleSelect(c2.entryPath);
                        } else {
                          await handleSelect(c2.entryPath);
                        }
                      })();
                    }}
                  >
                    <span className="truncate flex-1">{c.className ?? c.entryPath.split('/').pop()}</span>
                    {c.libraryId ? <span className="shrink-0 text-[9px] text-muted-foreground">dep</span> : null}
                    {c.projectId && c.projectId !== project?.id && (
                      <span className="shrink-0 text-[9px] text-muted-foreground">{c.projectId.slice(0, 12)}</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
            <FileCode2 className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs font-mono truncate">{selectedEntry || t('toolbox.jar.noSelection')}</span>
            <span className="shrink-0 text-[9px] text-muted-foreground" title="types in opened containers (clickability index)">
              idx:{knownNamesCount}
            </span>
            {view?.compileStatus && view.compileStatus !== 'none' && (
              <Badge
                variant={view.compileStatus === 'ok' ? 'default' : 'destructive'}
                className="text-[9px] ml-auto"
              >
                {view.compileStatus.toUpperCase()}
              </Badge>
            )}
            {dirty && <Badge variant="outline" className="text-[9px] border-amber-500/40 text-amber-600">● {t('toolbox.jar.dirty')}</Badge>}
            {view?.modified && <Badge variant="outline" className="text-[9px]">{t('toolbox.jar.modified')}</Badge>}
            {classInfo && (
              <span
                className="text-[10px] font-mono text-muted-foreground ml-auto hidden md:inline-flex items-center gap-1"
                title={`${classInfo.className} · major=${classInfo.major} minor=${classInfo.minor} · ${classInfo.size} bytes`}
              >
                <Info className="h-3 w-3" />
                {classInfo.javaVersion} · {classInfo.major}.{classInfo.minor} · {(classInfo.size / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {decompileError ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
                <div className="text-xs font-medium text-red-600">{t('toolbox.jar.decompileFailed')}</div>
                <pre className="max-w-full max-h-40 overflow-auto text-[11px] font-mono text-red-500/80 whitespace-pre-wrap break-all">
                  {decompileError}
                </pre>
              </div>
            ) : logText !== null ? (
              <div className="h-full overflow-auto">
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-mono truncate">{t('toolbox.jar.pasteLogTitle')}</span>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] ml-auto" onClick={() => setLogText(null)}>
                    {t('toolbox.jar.closeLog')}
                  </Button>
                </div>
                <div className="p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/80">
                  {logText.split('\n').map((line, li) => {
                    // JD-GUI LogPage: "at com.example.Foo.bar(Foo.java:42)"
                    // is a clickable link that opens the class and jumps to
                    // the line. "Native Method" links to the class itself.
                    const m = line.match(/^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.([A-Za-z_$][\w$]*)\(([^)]*)\)\s*$/);
                    if (!m) {
                      return <div key={li}>{line || '\u00A0'}</div>;
                    }
                    const [, qualified, , loc] = m;
                    const lineNum = /:(\d+)$/.exec(loc)?.[1];
                    const clsName = qualified;
                    return (
                      <div key={li}>
                        <span className="opacity-60">  at </span>
                        <button
                          type="button"
                          className="text-sky-600 dark:text-sky-400 underline decoration-dotted underline-offset-2 hover:brightness-110"
                          onClick={() => {
                            if (lineNum) pendingGotoLineRef.current = parseInt(lineNum, 10);
                            const p = classNameToEntryPath(clsName);
                            void handleSelect(p);
                          }}
                        >
                          {qualified}
                        </button>
                        <span className="opacity-60">({loc})</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : resourceImage ? (
              <div className="h-full flex items-center justify-center p-4 overflow-auto">
                <img src={resourceImage} alt={selectedEntry ?? ''} className="max-w-full max-h-full object-contain" />
              </div>
            ) : selectedEntry ? (
              <div ref={editorRef} className="h-full overflow-auto text-[12px]" />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                {t('toolbox.jar.selectHint')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom panel */}
      <div className="h-40 shrink-0 border-t border-border flex flex-col">
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
          {(['output', 'search'] as BottomTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`px-2 py-0.5 text-[11px] rounded ${bottomTab === tab ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
              onClick={() => setBottomTab(tab)}
            >
              {tab === 'output' ? t('toolbox.jar.output') : t('toolbox.jar.searchResults')}
            </button>
          ))}
          <div className="ml-auto" />
        </div>
        <ScrollArea className="flex-1 min-h-0">

          {bottomTab === 'output' && (
            <div className="p-2 space-y-0.5">
              {buildLog.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('toolbox.jar.noOutput')}</p>
              ) : (
                buildLog.map((l, i) => (
                  <div key={i} className="text-[11px] font-mono text-foreground/80">{l}</div>
                ))
              )}
            </div>
          )}
          {bottomTab === 'search' && (
            <div className="p-2 space-y-0.5">
              {searchResults.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('toolbox.jar.noResults')}</p>
              ) : (
                (searchResults as { className?: string; entryPath?: string; modified?: boolean }[]).map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    className="w-full text-left text-[11px] font-mono hover:bg-muted/60 rounded px-1"
                    onClick={() => r.entryPath && void handleSelect(r.entryPath)}
                  >
                    {r.className} {r.modified ? ' ✎' : ''}
                  </button>
                ))
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* JD-GUI Find panel (Ctrl+F) */}
      {findOpen && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-muted/20 shrink-0 text-xs">
          <span className="text-[10px] text-muted-foreground shrink-0">{t('toolbox.jar.findLabel')}</span>
          <input
            id="jar-find-input"
            value={findQuery}
            onChange={(e) => {
              const q = e.target.value;
              setFindQuery(q);
              applyFind(q, findCaseSensitive);
            }}
            onKeyDown={handleFindKeyDown}
            placeholder={t('toolbox.jar.findPlaceholder')}
            list="jar-find-history"
            className="h-7 w-48 shrink-0 rounded-md border border-border bg-background px-2 text-xs font-mono outline-none focus:ring-1 focus:ring-primary"
          />
          <datalist id="jar-find-history">
            {findHistory.map((h) => <option key={h} value={h} />)}
          </datalist>
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              className="accent-primary"
              checked={findCaseSensitive}
              onChange={(e) => {
                setFindCaseSensitive(e.target.checked);
                applyFind(findQuery, e.target.checked);
              }}
            />
            {t('toolbox.jar.findCaseSensitive')}
          </label>
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
            {findMatchCount === 0 ? '0/0' : `${findMatchIndex}/${findMatchCount}`}
          </span>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => findStep(-1)} title={t('toolbox.jar.findPrev')}>
              {t('toolbox.jar.findPrev')}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => findStep(1)} title={t('toolbox.jar.findNext')}>
              {t('toolbox.jar.findNext')}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-xs" onClick={handleFindClose} aria-label={t('common.close')}>
              ✕
            </Button>
          </div>
        </div>
      )}

      {/* Status bar (JD-GUI style) */}
      <div className="flex items-center gap-3 px-3 py-1 border-t border-border bg-muted/20 shrink-0 text-[10px] text-muted-foreground font-mono">
        <span className="truncate flex-1">
          {project ? `${project.name} · ${project.classCount} cls` : '—'}
        </span>
        {view?.kind === 'resource' && <span className="shrink-0">{t('toolbox.jar.resource')}</span>}
        {cursor && selectedEntry && (
          <span className="shrink-0">
            {cursor.line}:{cursor.col}
          </span>
        )}
        <span className="shrink-0">
          {view ? `${editorText.length} chars` : ''}
        </span>
      </div>
    </div>
  );
}
