/**
 * JAR decompiler tool — open a JAR, browse classes, decompile (CFR), edit
 * (CodeMirror 6), compile (javac) and rebuild a new JAR. The original JAR is
 * never modified.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import {
  Archive,
  FolderOpen,
  FileCode2,
  RefreshCw,
  Search,
  Play,
  Hammer,
  RotateCcw,
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
} from 'lucide-react';
import { jarApi, type ClassView, type PackageNode, type ProjectSummary, type CompileDiagnostic } from '@/lib/toolbox/jar-api';
import { useWebviewFileDrop } from '@/lib/use-webview-file-drop';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorState, StateField, StateEffect, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { java } from '@codemirror/lang-java';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

type BottomTab = 'problems' | 'output' | 'search';

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

/** Extract the identifier word at a document position (shared by click + hover). */
function wordAt(view: EditorView, pos: number): { word: string; from: number; to: number } | null {
  if (pos === null || pos < 0 || pos > view.state.doc.length) return null;
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

interface TreeNodeProps {
  node: PackageNode;
  depth: number;
  selected: string | null;
  modifiedSet: Set<string>;
  onSelect: (entryPath: string) => void;
  onResourceOpen: (entryPath: string) => void;
  /** When filtering, force every branch open so matches are visible. */
  forceOpen?: boolean;
  onContextMenu?: (e: React.MouseEvent, entryPath: string, className: string, kind: string) => void;
}

function TreeNode({ node, depth, selected, modifiedSet, onSelect, onResourceOpen, forceOpen, onContextMenu }: TreeNodeProps) {
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
        <span className="truncate">{node.name.split('.').pop()}</span>
      </button>
      {isOpen && (
        <div>
          {Object.values(node.packages).map((sub) => (
            <TreeNode key={sub.name} node={sub} depth={depth + 1} selected={selected} modifiedSet={modifiedSet} onSelect={onSelect} onResourceOpen={onResourceOpen} forceOpen={forceOpen} onContextMenu={onContextMenu} />
          ))}
          {node.classes.map((cls) => {
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
                onClick={() => (isRes ? onResourceOpen(cls.entryPath) : onSelect(cls.entryPath))}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, cls.entryPath, cls.className, cls.kind) : undefined}
              >
                <span className="w-3 shrink-0" />
                {isRes ? (
                  <span className="text-[9px] text-muted-foreground">📄</span>
                ) : (
                  <FileCode2 className="h-3 w-3 shrink-0 text-blue-500" />
                )}
                <span className="truncate">{cls.className.split('/').pop()?.split('.').pop()}</span>
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
function SubTypeNodes({ nodes, depth, onOpen }: { nodes: SubTypeNode[]; depth: number; onOpen: (className: string, entryPath: string | null) => void }) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.className}>
          <button
            type="button"
            className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/60 text-left"
            style={{ paddingLeft: `${depth * 16}px` }}
            onClick={() => onOpen(n.className, classNameToEntryPath(n.className))}
          >
            <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <span className="truncate">{n.className}</span>
            {n.children.length > 0 && <span className="ml-auto text-[9px] text-muted-foreground">({n.children.length})</span>}
          </button>
          {n.children.length > 0 && <SubTypeNodes nodes={n.children} depth={depth + 1} onOpen={onOpen} />}
        </div>
      ))}
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
  const [bottomTab, setBottomTab] = useState<BottomTab>('problems');
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
  /** Recent-files dropdown open state. */
  const [recentOpen, setRecentOpen] = useState(false);
  /** Cursor position in the editor (status bar). */
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  /** Right-click tab menu position + target. */
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  /** Tree node context menu (copy qualified name). */
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; entryPath: string; className: string; kind: string } | null>(null);
  /** Open Type dialog (Ctrl+T): pattern + results + selected index. */
  const [openTypeOpen, setOpenTypeOpen] = useState(false);
  const [openTypePattern, setOpenTypePattern] = useState('');
  const [openTypeScope, setOpenTypeScope] = useState<'current' | 'all'>('current');
  const [openTypeResults, setOpenTypeResults] = useState<{ entryPath: string; className: string; packageName: string; libraryId: string; projectId: string; projectName: string; isInnerClass: boolean; modified: boolean }[]>([]);
  const [openTypeBusy, setOpenTypeBusy] = useState(false);
  const [openTypeSel, setOpenTypeSel] = useState(0);
  /** Type hierarchy dialog (Ctrl+H). */
  const [hierarchyOpen, setHierarchyOpen] = useState(false);
  const [hierarchyData, setHierarchyData] = useState<{ target: string; targetEntryPath: string; parents: string[]; subTypes: SubTypeNode[] } | null>(null);
  const [hierarchyBusy, setHierarchyBusy] = useState(false);
  /** Go to Line dialog (Ctrl+L). */
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoLine, setGotoLine] = useState('');
  /** Search in constant pools dialog (Ctrl+Shift+S). */
  const [constSearchOpen, setConstSearchOpen] = useState(false);
  const [constPattern, setConstPattern] = useState('');
  const [constFlags, setConstFlags] = useState<{ strings: boolean; fields: boolean; methods: boolean }>({ strings: true, fields: true, methods: true });
  const [constResults, setConstResults] = useState<{ kind: string; value: string; className: string; libraryId: string }[]>([]);
  const [constBusy, setConstBusy] = useState(false);
  /** Preferences dialog (Ctrl+Shift+P). */
  const [prefsOpen, setPrefsOpen] = useState(false);
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
  /** Navigation history (Alt+← / Alt+→, JD-GUI Back/Forward). */
  const [navHistory, setNavHistory] = useState<{ entryPath: string; libraryId: string }[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  /** Class file info (version/major/size) fetched on selection. */
  const [classInfo, setClassInfo] = useState<{ className: string; javaVersion: string; major: number; minor: number; size: number } | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** True while a programmatic doc replacement is in flight (don't mark dirty). */
  const editorSuppressDirtyRef = useRef(false);
  /** Latest navigate handler (click-to-jump in the editor). */
  const navigateRef = useRef<(name: string, kind: 'class' | 'method', methodOwner?: string) => void>(() => {});
  /** Jump to a method declared in the currently-open class (same page). */
  const jumpToOwnMethodRef = useRef<(methodName: string) => void>(() => {});
  /** Latest word→reference resolver (used by editor hover/click). */
  const resolveWordRef = useRef<(word: string) => { internalTypeName: string; kind: string } | undefined>(() => undefined);
  /** Line to scroll to after the next decompile finishes (method jump). */
  const pendingGotoLineRef = useRef<number | null>(null);
  /** Known class names (simple + fully qualified) for hover underline + click jump. */
  const classNameSetRef = useRef<Set<string>>(new Set());
  /** Bytecode-level references of the current class: simpleName → target. */
  const refsMapRef = useRef<Map<string, { internalTypeName: string; kind: string }>>(new Map());
  /** Own method declarations of the current class: name → source line. */
  const ownMethodsRef = useRef<Map<string, number>>(new Map());
  /** Internal name (slash form) of the currently open class. */
  const currentClassInternalRef = useRef<string | null>(null);
  /** Every indexed class name (dotted + simple + slash) for resolvability. */
  const knownNamesRef = useRef<{ dotted: Set<string>; simple: Set<string>; slash: Set<string> }>({ dotted: new Set(), simple: new Set(), slash: new Set() });

  // JDK detect on mount ──
  useEffect(() => {
    void jarApi.jdkDetect().then((info) => {
      if (info.found) {
        setJdk({ label: info.javaVersion || info.javacPath || 'JDK' });
      } else {
        setJdk(null);
      }
    });
  }, []);

  // Load every indexed class name (resolvability check for references).
  useEffect(() => {
    if (!project) return;
    void jarApi.knownClassNames(project.id).then((r) => {
      knownNamesRef.current = {
        dotted: new Set(r.names),
        simple: new Set(r.simple),
        slash: new Set(r.names),
      };
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
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        click: (event, view) => {
          // JD-GUI: single-click a resolvable reference → jump (no modifier).
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return;
          const w = wordAt(view, pos);
          if (!w) return;
          // 1) Precise: bytecode-level ref of the current class, only when the
          //    target type is indexed (JD-GUI indexesChanged → enabled=false
          //    for unresolvable references, which are not links at all).
          const ref = resolveWordRef.current(w.word);
          if (ref) {
            event.preventDefault();
            const dotted = ref.internalTypeName.replace(/\//g, '.');
            if (ref.kind === 'type') {
              navigateRef.current(dotted, 'class');
            } else if (ref.kind === 'method') {
              if (ref.internalTypeName === currentClassInternalRef.current) {
                // Same-class method: jump inside the current editor (JD-GUI).
                jumpToOwnMethodRef.current(w.word);
              } else {
                navigateRef.current(dotted, 'method', ref.internalTypeName);
              }
            } else {
              // Field reference: open the owning class (JD-GUI would jump to
              // the field declaration; we open the class as a safe fallback).
              navigateRef.current(dotted, 'class');
            }
            return;
          }
          // 2) Known class name (another indexed jar/library).
          const known = classNameSetRef.current.has(w.word) || classNameSetRef.current.has(w.word.split('.').pop() ?? w.word);
          if (known) {
            event.preventDefault();
            navigateRef.current(w.word, 'class');
            return;
          }
          // 3) Ctrl/Cmd+click any symbol → class or method navigation.
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const kind = /^[A-Z]/.test(w.word) ? 'class' : 'method';
            navigateRef.current(w.word, kind as 'class' | 'method');
          }
        },
        mousemove: (event, view) => {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          const w = pos === null ? null : wordAt(view, pos);
          const ref = w !== null ? resolveWordRef.current(w.word) : undefined;
          const known =
            ref !== undefined ||
            (w !== null && (classNameSetRef.current.has(w.word) || classNameSetRef.current.has(w.word.split('.').pop() ?? w.word)));
          const cur = view.state.field(hoverField, false);
          const from = cur?.from ?? -1;
          const to = cur?.to ?? -1;
          if (known) {
            if (from !== w!.from || to !== w!.to) {
              view.dispatch({ effects: setHoverEffect.of({ from: w!.from, to: w!.to }) });
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
          const next = Math.min(28, Math.max(8, cur + delta));
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
    }
  }, [editorText, selectedEntry]);

  // ── Open a JAR by path (shared by dialog + drag&drop + recent history). ──
  const openProjectByPath = useCallback(
    async (path: string) => {
      setBusy(true);
      setBusyLabel(t('toolbox.jar.opening'));
      try {
        const p = await jarApi.openProject(path);
        setProject(p);
        const idx = await jarApi.classIndex(p.id);
        setTree(idx);
        const names = new Set<string>();
        collectClassNames(idx, names);
        classNameSetRef.current = names;
        setSelectedEntry(null);
        setView(null);
        setEditorText('');
        setDirty(false);
        setDiagnostics([]);
        setBuildLog([`Opened ${p.name} (${p.classCount} classes)`]);
        setLibraries([]);
        setActiveLibraryId(null);
        setPomInfo(null);
        setTabs([]);
        // Record in recent history (most-recent first, dedupe).
        setRecent((prev) => {
          const next = [{ path, name: p.name, at: Date.now() }, ...prev.filter((r) => r.path !== path)].slice(0, 8);
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
      setProject(p);
      setTree(r.classTree);
      setLibraries(r.libraries);
      setPomInfo(r.pom);
      setActiveLibraryId(null);
      setSelectedEntry(null);
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
  const handleSelectLibrary = useCallback(
    async (libraryId: string) => {
      if (!project) return;
      setActiveLibraryId(libraryId);
      setSelectedEntry(null);
      setView(null);
      setEditorText('');
      setDirty(false);
      setClassInfo(null);
      refsMapRef.current = new Map();
      ownMethodsRef.current = new Map();
      currentClassInternalRef.current = null;
      if (!libraryId) {
        // Main project tree (already loaded at open; re-read from index).
        try {
          const idx = await jarApi.classIndex(project.id);
          setTree(idx);
          const names = new Set<string>();
          collectClassNames(idx, names);
          classNameSetRef.current = names;
        } catch (e) {
          toast.error(String(e));
        }
        return;
      }
      try {
        const idx = await jarApi.libraryIndex(project.id, libraryId);
        setTree(idx);
        const names = new Set<string>();
        collectClassNames(idx, names);
        classNameSetRef.current = names;
      } catch (e) {
        toast.error(String(e));
      }
    },
    [project, t],
  );

  // ── Navigate (click class/method name → open target). ──
  // ── Select a class → decompile on demand. ──
  const handleSelect = useCallback(
    async (entryPath: string, opts?: { history?: boolean }) => {
      if (!project) return;
      const libraryId = activeLibraryId ?? '';
      const pushHistory = opts?.history ?? true;
      // JD-GUI: clicking a class opens it (reuse tab if already open).
      setTabs((prev) => {
        const key = `${libraryId}:${entryPath}`;
        if (prev.some((tab) => tab.key === key)) return prev;
        const title = entryPath.split('/').pop()?.replace('.class', '') ?? entryPath;
        return [...prev, { key, entryPath, libraryId, title }];
      });
      if (pushHistory) {
        setNavHistory((prev) => {
          const next = [...prev.slice(0, navIndex + 1), { entryPath, libraryId }];
          return next.slice(-100);
        });
        setNavIndex((i) => Math.min(i + 1, 99));
      }
      setSelectedEntry(entryPath);
      setDirty(false);
      setView(null);
      setEditorText('');
      setResourceImage(null);
      setDecompileError(null);
      setClassInfo(null);
      setBusy(true);
      setBusyLabel(t('toolbox.jar.decompiling'));
      try {
        const cv = await jarApi.decompile(project.id, entryPath);
        setView(cv);
        setEditorText(cv.source);
        setOriginalSource(cv.originalSource ?? null);
        // Bytecode-level refs → simple-name lookup for precise click-to-jump.
        const refMap = new Map<string, { internalTypeName: string; kind: string }>();
        for (const ref of cv.refs ?? []) {
          const simple = ref.internalTypeName.split('/').pop() ?? ref.internalTypeName;
          if (simple.length > 0) {
            refMap.set(simple, { internalTypeName: ref.internalTypeName, kind: ref.kind });
            // Also allow clicking the dotted form of inner classes.
            refMap.set(ref.internalTypeName.replace(/\//g, '.'), { internalTypeName: ref.internalTypeName, kind: ref.kind });
          }
          // Method/field references are clicked by their MEMBER name
          // (e.g. `toString` in `IOUtils.toString(...)`), so index those too.
          if (ref.kind !== 'type' && ref.name) {
            refMap.set(ref.name, { internalTypeName: ref.internalTypeName, kind: ref.kind });
          }
        }
        refsMapRef.current = refMap;
        // Own method declarations (name → line) for same-page jumps.
        const ownMap = new Map<string, number>();
        for (const m of cv.methods ?? []) ownMap.set(m.name, m.line);
        ownMethodsRef.current = ownMap;
        // Internal name (slash form) of this class, for self-reference checks.
        currentClassInternalRef.current = cv.className.replace(/\./g, '/');
        setModifiedSet((prev) => {
          const next = new Set(prev);
          if (cv.modified) next.add(entryPath);
          else next.delete(entryPath);
          return next;
        });
        // Class file info (JD-GUI "class file information").
        try {
          const info = await jarApi.classInfo(project.id, entryPath, libraryId || undefined);
          setClassInfo(info);
        } catch {
          setClassInfo(null);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setDecompileError(msg);
        toast.error(t('toolbox.jar.decompileFailed'), { description: msg });
      } finally {
        setBusy(false);
      }
    },
    [project, t, activeLibraryId, navIndex],
  );

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
          setSelectedEntry(null);
          setView(null);
          setEditorText('');
          setDirty(false);
          setLibraries([]);
          setActiveLibraryId(null);
          setPomInfo(null);
          setTabs([]);
          if (libraryId) await handleSelectLibrary(libraryId);
        } else if (libraryId && libraryId !== activeLibraryId) {
          await handleSelectLibrary(libraryId);
        }
        if (line !== null) pendingGotoLineRef.current = line;
        await handleSelect(entryPath);
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
          // Fall back to opening the owner class (no line).
          try {
            if (methodOwner) {
              await openAndJump(
                (await jarApi.methodLocation(project.id, methodOwner, name)).entryPath,
                undefined,
                null,
              );
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
  resolveWordRef.current = (word: string): { internalTypeName: string; kind: string } | undefined => {
    const ref = refsMapRef.current.get(word) ?? refsMapRef.current.get(word.split('.').pop() ?? '');
    if (!ref) return undefined;
    // JD-GUI: a reference to the class ITSELF (e.g. `Foo.class`, `new Foo()`)
    // is not a link — the declaration is the page itself, nothing to jump to.
    if (ref.kind === 'type' && ref.internalTypeName === currentClassInternalRef.current) {
      return undefined;
    }
    // A method OF this class is jumpable (same-page, resolved below); a method
    // of another class needs that class to be indexed.
    if (ref.kind === 'method' && ref.internalTypeName === currentClassInternalRef.current) {
      return ref;
    }
    const k = knownNamesRef.current;
    const dotted = ref.internalTypeName.replace(/\//g, '.');
    const simple = ref.internalTypeName.split('/').pop() ?? ref.internalTypeName;
    if (k.dotted.has(dotted) || k.simple.has(simple) || k.slash.has(ref.internalTypeName)) {
      return ref;
    }
    return undefined;
  };

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

  // ── Tab management (JD-GUI style). ──
  const handleSwitchTab = useCallback(
    (tabKey: string) => {
      const tab = tabs.find((t) => t.key === tabKey);
      if (!tab || !project) return;
      // Switch library context if needed.
      const targetLib = tab.libraryId;
      if (targetLib !== activeLibraryId) {
        void handleSelectLibrary(targetLib).then(() => {
          void handleSelect(tab.entryPath);
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
            void handleSelectLibrary(targetLib).then(() => handleSelect(neighbor.entryPath));
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
    setView(null);
    setEditorText('');
    setDirty(false);
    setTabMenu(null);
    refsMapRef.current = new Map();
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
          void handleSelectLibrary(targetLib).then(() => handleSelect(keep.entryPath));
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
  const handleTreeContextMenu = useCallback((e: React.MouseEvent, entryPath: string, className: string, kind: string) => {
    e.preventDefault();
    setTreeMenu({ x: e.clientX, y: e.clientY, entryPath, className, kind });
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
  const handleSave = useCallback(async () => {
    if (!project || !selectedEntry) return;
    setBusy(true);
    setBusyLabel(t('toolbox.jar.saving'));
    try {
      const cur = editorViewRef.current?.state.doc.toString() ?? editorText;
      await jarApi.save(project.id, selectedEntry, cur);
      setDirty(false);
      setEditorText(cur);
      setModifiedSet((prev) => new Set(prev).add(selectedEntry));
      setBuildLog((l) => [...l, `Saved ${selectedEntry}`]);
      toast.success(t('toolbox.jar.saved'));
    } catch (e) {
      toast.error(t('toolbox.jar.saveFailed'), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [project, selectedEntry, editorText, t]);

  // ── Compile. ──
  const handleCompile = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    setBusyLabel(t('toolbox.jar.compiling'));
    setBottomTab('problems');
    try {
      const result = await jarApi.compile(project.id, selectedEntry ?? undefined);
      setDiagnostics(result.diagnostics ?? []);
      setBuildLog((l) => [...l, result.success ? `Compile OK (${result.classCount} class(es))` : `Compile FAILED (${(result.diagnostics ?? []).length} error(s))`]);
      if (result.success) {
        toast.success(t('toolbox.jar.compileOk'));
        // Refresh modified marker — compile status changed.
      } else {
        toast.error(t('toolbox.jar.compileFailed'));
      }
    } catch (e) {
      toast.error(t('toolbox.jar.compileFailed'), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [project, selectedEntry, t]);

  // ── Build new JAR. ──
  const handleBuild = useCallback(async () => {
    if (!project) return;
    const outPath = await save({
      defaultPath: project.name.replace(/\.jar$/, '') + '-modified.jar',
      filters: [{ name: 'JAR', extensions: ['jar'] }],
    });
    if (typeof outPath !== 'string' || !outPath) return;
    setBusy(true);
    setBusyLabel(t('toolbox.jar.building'));
    setBottomTab('output');
    try {
      const result = await jarApi.build(project.id, outPath);
      setBuildLog((l) => [...l, `Build OK → ${result.outputPath} (${result.size} bytes)`]);
      toast.success(t('toolbox.jar.buildOk'), { description: result.outputPath });
    } catch (e) {
      setBuildLog((l) => [...l, `Build FAILED: ${e}`]);
      toast.error(t('toolbox.jar.buildFailed'), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [project, t]);

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
      setBottomTab('output');
      try {
        const result = await jarApi.exportAll(project.id, dir);
        setBuildLog((l) => [
          ...l,
          `Export: ${result.exported}/${result.total} sources → ${result.outputDir}`,
          result.failed > 0 ? `  ${result.failed} failed: ${result.failedClasses.slice(0, 5).join(', ')}` : '  all OK',
        ]);
        toast.success(`${result.exported}/${result.total} ${t('toolbox.jar.exportAll')}`);
      } catch (e) {
        setBuildLog((l) => [...l, `Export FAILED: ${e}`]);
        toast.error(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    setBusyLabel(t('toolbox.jar.exportAll'));
    setBottomTab('output');
    try {
      const result = await jarApi.exportAll(project.id, zipPath);
      setBuildLog((l) => [
        ...l,
        `Export ZIP: ${result.exported}/${result.total} sources → ${result.outputDir}`,
        result.failed > 0 ? `  ${result.failed} failed: ${result.failedClasses.slice(0, 5).join(', ')}` : '  all OK',
      ]);
      toast.success(`${result.exported}/${result.total} ${t('toolbox.jar.exportAll')}`);
    } catch (e) {
      setBuildLog((l) => [...l, `Export ZIP FAILED: ${e}`]);
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }, [project, t]);

  // ── Open a resource (text preview / image / hex) in a new tab. ──
  const handleOpenResource = useCallback(
    async (entryPath: string) => {
      if (!project) return;
      const libraryId = activeLibraryId ?? '';
      setTabs((prev) => {
        const key = `${libraryId}:${entryPath}`;
        if (prev.some((tab) => tab.key === key)) return prev;
        return [...prev, { key, entryPath, libraryId, title: entryPath.split('/').pop() ?? entryPath }];
      });
      setSelectedEntry(entryPath);
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
  const handleRevert = useCallback(async () => {
    if (!project || !selectedEntry) return;
    setBusy(true);
    try {
      const cv = await jarApi.revert(project.id, selectedEntry);
      setView(cv);
      setEditorText(cv.source);
      setDirty(false);
      setModifiedSet((prev) => {
        const next = new Set(prev);
        next.add(selectedEntry);
        return next;
      });
      toast.success(t('toolbox.jar.reverted'));
    } catch (e) {
      toast.error(t('toolbox.jar.revertFailed'), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [project, selectedEntry, t]);

  // ── Search classes. ──
  const handleSearch = useCallback(async () => {
    if (!project || !query.trim()) return;
    const results = await jarApi.search(project.id, query.trim());
    setSearchResults(results);
    setBottomTab('search');
  }, [project, query]);

  // ── Open Type (Ctrl+T): JD-GUI global type search dialog. ──
  const openTypeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleOpenTypeOpen = useCallback(() => {
    setOpenTypePattern('');
    setOpenTypeResults([]);
    setOpenTypeSel(0);
    setOpenTypeOpen(true);
  }, []);

  const handleOpenTypeInput = useCallback(
    (value: string) => {
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
            setSelectedEntry(null);
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
            await handleSelect(entryPath);
          } catch (e) {
            toast.error(String(e));
          }
        })();
        return;
      }
      if (libraryId && libraryId !== activeLibraryId) {
        void handleSelectLibrary(libraryId).then(() => handleSelect(entryPath));
      } else {
        void handleSelect(entryPath);
      }
    },
    [project, activeLibraryId, handleSelectLibrary, handleSelect],
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
      setHierarchyData(data as { target: string; targetEntryPath: string; parents: string[]; subTypes: SubTypeNode[] });
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

  const handleHierarchyOpenClass = useCallback(
    (className: string, entryPath: string | null) => {
      setHierarchyOpen(false);
      if (!entryPath) return;
      if (project) void handleSelect(entryPath);
    },
    [project, handleSelect],
  );

  // ── Go to Line (Ctrl+L): JD-GUI navigation. ──
  const handleGotoLine = useCallback(() => {
    if (!selectedEntry) return;
    setGotoLine('');
    setGotoOpen(true);
  }, [selectedEntry]);

  const handleGotoSubmit = useCallback(() => {
    const n = parseInt(gotoLine, 10);
    setGotoOpen(false);
    if (Number.isNaN(n) || n <= 0) return;
    const view2 = editorViewRef.current;
    if (!view2) return;
    const maxLine = view2.state.doc.lines;
    const target = Math.min(n, maxLine);
    const pos = view2.state.doc.line(target).from;
    view2.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }, [gotoLine]);

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
  const constTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runConstSearch = useCallback(
    async (pattern: string, flags: typeof constFlags) => {
      const projectId = project?.id;
      if (!projectId) return;
      const bit = (b: boolean, n: number) => (b ? 1 << n : 0);
      const flagBits = bit(flags.strings, 0) | bit(flags.fields, 1) | bit(flags.methods, 2);
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
    [project],
  );

  const handleConstSearchOpen = useCallback(() => {
    setConstPattern('');
    setConstResults([]);
    setConstSearchOpen(true);
  }, []);

  const handleConstInput = useCallback(
    (value: string) => {
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
      if (libraryId && libraryId !== activeLibraryId) {
        void handleSelectLibrary(libraryId).then(() => handleSelect(entryPath));
      } else {
        void handleSelect(entryPath);
      }
    },
    [project, activeLibraryId, handleSelectLibrary, handleSelect],
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
        if (item.libraryId !== activeLibraryId) {
          void handleSelectLibrary(item.libraryId).then(() => handleSelect(item.entryPath, { history: false }));
        } else {
          void handleSelect(item.entryPath, { history: false });
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
        if (item.libraryId !== activeLibraryId) {
          void handleSelectLibrary(item.libraryId).then(() => handleSelect(item.entryPath, { history: false }));
        } else {
          void handleSelect(item.entryPath, { history: false });
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
    const filtered = normalizeTree(tree);
    // Aggregate single-chain packages (JD-GUI) at the top level.
    const out: Record<string, PackageNode> = {};
    for (const [name, node] of Object.entries(filtered)) {
      out[name] = aggregatePackages(node);
    }
    return out;
  }, [tree]);

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
                  setOpenTypeSel((s) => Math.min(s + 1, Math.max(openTypeResults.length - 1, 0)));
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
          <div className="max-h-[46vh] overflow-auto p-1.5">
            {openTypeResults.length === 0 ? (
              <p className="px-3 py-8 text-xs text-muted-foreground text-center">
                {openTypeBusy ? '…' : t('toolbox.jar.openTypeEmpty')}
              </p>
            ) : (
              openTypeResults.map((r, i) => (
                <button
                  key={`${r.libraryId}:${r.entryPath}`}
                  type="button"
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-xs ${
                    i === openTypeSel ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'hover:bg-accent'
                  }`}
                  onMouseEnter={() => setOpenTypeSel(i)}
                  onClick={() => handleOpenTypePick(r.entryPath, r.libraryId, r.projectId)}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                  <span className="truncate font-mono">{r.className}</span>
                  {openTypeScope === 'all' && r.projectName && (
                    <span className="shrink-0 text-[9px] text-muted-foreground border border-border rounded px-1 max-w-[120px] truncate">{r.projectName}</span>
                  )}
                  {r.libraryId && <span className="shrink-0 text-[9px] text-muted-foreground">dep</span>}
                  {r.modified && <span className="shrink-0 text-[9px] text-amber-600">改</span>}
                </button>
              ))
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
      {/* Type hierarchy dialog (JD-GUI Ctrl+H) */}
      <Dialog open={hierarchyOpen} onOpenChange={(o) => { if (!o) setHierarchyOpen(false); }}>
        <DialogContent className="top-[8vh] translate-y-0 sm:max-w-[500px] p-0 gap-0 overflow-hidden">
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
                {/* Parents (reversed: root first) */}
                {[...hierarchyData.parents].reverse().map((p, i) => (
                  <button
                    key={p}
                    type="button"
                    className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-accent text-left"
                    style={{ paddingLeft: `${(i + 1) * 16}px` }}
                    onClick={() => handleHierarchyOpenClass(p, classNameToEntryPath(p))}
                  >
                    <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                    <span className="truncate">{p}</span>
                  </button>
                ))}
                {/* Target */}
                <div className="flex items-center gap-1 px-2 py-1 rounded bg-primary/10 text-primary ring-1 ring-primary/20 font-semibold" style={{ paddingLeft: `${(hierarchyData.parents.length + 1) * 16}px` }}>
                  <CornerDownRight className="h-3 w-3 shrink-0" />
                  <span className="truncate">{hierarchyData.target}</span>
                </div>
                {/* Subtypes tree */}
                <SubTypeNodes nodes={(hierarchyData.subTypes as unknown) as SubTypeNode[]} depth={hierarchyData.parents.length + 2} onOpen={handleHierarchyOpenClass} />
              </div>
            ) : (
              <p className="py-6 text-center text-muted-foreground">{t('toolbox.jar.hierarchyEmpty')}</p>
            )}
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex justify-between">
            <span>{t('toolbox.jar.hierarchyHint')}</span>
            <span>esc {t('toolbox.jar.openTypeEsc')}</span>
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
              onChange={(e) => setGotoLine(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setGotoOpen(false);
                if (e.key === 'Enter') handleGotoSubmit();
              }}
              placeholder={t('toolbox.jar.gotoPlaceholder')}
              className="h-9 text-sm font-mono"
            />
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex justify-between">
            <span>↵ {t('toolbox.jar.openTypeEnter')}</span>
            <span>esc {t('toolbox.jar.openTypeEsc')}</span>
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
              }}
              placeholder={t('toolbox.jar.constPlaceholder')}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{constBusy ? '…' : constResults.length}</span>
          </div>
          <div className="flex items-center gap-4 px-3 py-2 border-b text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.strings} onChange={(e) => handleConstFlag('strings', e.target.checked)} />
              {t('toolbox.jar.constStrings')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.fields} onChange={(e) => handleConstFlag('fields', e.target.checked)} />
              {t('toolbox.jar.constFields')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="accent-primary" checked={constFlags.methods} onChange={(e) => handleConstFlag('methods', e.target.checked)} />
              {t('toolbox.jar.constMethods')}
            </label>
          </div>
          <div className="max-h-[42vh] overflow-auto p-1.5">
            {constResults.length === 0 ? (
              <p className="px-3 py-8 text-xs text-muted-foreground text-center">{constBusy ? '…' : t('toolbox.jar.constEmpty')}</p>
            ) : (
              constResults.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-xs hover:bg-accent"
                  onClick={() => handleConstOpenClass(r.className, r.libraryId)}
                >
                  <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded ${r.kind === 'string' ? 'bg-green-500/15 text-green-600' : r.kind === 'field' ? 'bg-blue-500/15 text-blue-600' : 'bg-purple-500/15 text-purple-600'}`}>
                    {r.kind === 'string' ? 'S' : r.kind === 'field' ? 'F' : 'M'}
                  </span>
                  <span className="truncate font-mono">{r.value}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground truncate max-w-[40%]">{r.className}</span>
                </button>
              ))
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
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => applyFontSize(Math.max(8, prefsFontSize - 1))}>−</Button>
                <span className="w-10 text-center text-sm font-mono">{prefsFontSize}px</span>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => applyFontSize(Math.min(28, prefsFontSize + 1))}>+</Button>
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
          </div>
          <div className="px-3 py-2 border-t text-[10px] text-muted-foreground flex justify-end">
            <span>esc {t('toolbox.jar.openTypeEsc')}</span>
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
                        <span className="font-mono truncate flex-1">{r.name}</span>
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
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={navIndex <= 0} onClick={handleNavBack} title={t('toolbox.jar.back')}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={navIndex >= navHistory.length - 1} onClick={handleNavForward} title={t('toolbox.jar.forward')}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          {jdk ? (
            <Badge variant="outline" className="text-[10px] gap-1">
              <Hammer className="h-3 w-3" /> {jdk.label}
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px]">{t('toolbox.jar.noJdk')}</Badge>
          )}
          {modifiedCount > 0 && (
            <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">{modifiedCount} 改</Badge>
          )}
          {busy && (
            <Badge variant="outline" className="text-[10px] gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> {busyLabel}
            </Badge>
          )}
          {project && (
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => void handleRevert()} disabled={!selectedEntry}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('toolbox.jar.revert')}
            </Button>
          )}
          {project && (
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => void handleCompile()} disabled={!project}>
              <Play className="h-3.5 w-3.5" />
              {t('toolbox.jar.compile')}
            </Button>
          )}
          {project && (
            <Button size="sm" className="h-7 text-xs gap-1" onClick={() => void handleBuild()}>
              <Hammer className="h-3.5 w-3.5" />
              {t('toolbox.jar.build')}
            </Button>
          )}
          {project && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void handleExportAll()}>
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
          {/* Library selector (when opened via pom) */}
          {libraries.length > 0 && (
            <div className="p-1.5 border-b border-border shrink-0 space-y-1">
              <select
                className="w-full h-7 rounded-md border border-border bg-input-background px-2 text-xs font-mono"
                value={activeLibraryId ?? ''}
                onChange={(e) => void handleSelectLibrary(e.target.value)}
              >
                <option value="">{t('toolbox.jar.mainProject')}</option>
                {libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name.split('|')[0]} {lib.editable ? '' : lib.name.startsWith('[nested]') ? t('toolbox.jar.nestedLib') : '(dep)'}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground">{t('toolbox.jar.libHint')}</p>
            </div>
          )}
          <ScrollArea className="flex-1 min-h-0">
            {!project ? (
              <div className="p-6 text-center text-xs text-muted-foreground space-y-2">
                <Archive className="h-8 w-8 mx-auto opacity-40" />
                <p>{t('toolbox.jar.emptyDesc')}</p>
              </div>
            ) : tree ? (
              <div className="p-1.5 space-y-0.5">
                {(Object.values(normalizedTree ?? {}).map((node) => filterTree(node, query.trim())).filter((n): n is PackageNode => n !== null) as PackageNode[]).map((node) => (
                  <TreeNode key={node.name} node={node} depth={0} selected={selectedEntry} modifiedSet={modifiedSet} forceOpen={query.trim().length > 0} onSelect={(e) => void handleSelect(e)} onResourceOpen={handleOpenResource} onContextMenu={handleTreeContextMenu} />
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mx-auto" /></div>
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
                {tabs.length > 1 && (
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
                    setTreeMenu(null);
                    void handleSelect(ep);
                  }}
                >
                  {t('toolbox.jar.openClass')}
                </button>
              </div>
            </>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
            <FileCode2 className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs font-mono truncate">{selectedEntry || t('toolbox.jar.noSelection')}</span>
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
            {selectedEntry && (
              <Button size="sm" variant="outline" className="h-6 text-[11px] ml-auto" onClick={() => void handleSave()} disabled={!dirty}>
                {t('toolbox.jar.save')}
              </Button>
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
                <pre className="p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/80">{logText}</pre>
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
          {(['problems', 'output', 'search'] as BottomTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`px-2 py-0.5 text-[11px] rounded ${bottomTab === tab ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
              onClick={() => setBottomTab(tab)}
            >
              {tab === 'problems' ? t('toolbox.jar.problems') : tab === 'output' ? t('toolbox.jar.output') : t('toolbox.jar.searchResults')}
            </button>
          ))}
          <div className="ml-auto" />
        </div>
        <ScrollArea className="flex-1 min-h-0">
          {bottomTab === 'problems' && (
            <div className="p-2 space-y-0.5">
              {diagnostics.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('toolbox.jar.noProblems')}</p>
              ) : (
                diagnostics.map((d, i) => (
                  <div key={i} className={`text-[11px] font-mono ${d.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
                    {d.file}:{d.line}:{d.column} {d.level}: {d.message}
                  </div>
                ))
              )}
            </div>
          )}
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
