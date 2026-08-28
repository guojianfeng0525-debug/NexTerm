import React, { useRef, useEffect, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, dropCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, setSearchQuery, findNext, findPrevious, SearchQuery } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { loadEditorConfig, EDITOR_CONFIG_CHANGED_EVENT, type EditorConfig } from "@/lib/editor-config";
import { genericSqlQueryEditorContext, type DatabaseQueryEditorContext } from "@/lib/database/query-editor";
import { queryEditorCompletionSource, queryEditorDialect } from "@/components/query-editor-codemirror";
import { errorLineMarkExtension } from "@/lib/database/editor-error-reveal";
import type { NoteLanguage } from "@/lib/toolbox/toolbox-types";

// Language imports
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { php } from "@codemirror/lang-php";
import { shell as legacyShell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell as legacyPowerShell } from "@codemirror/legacy-modes/mode/powershell";
import { simpleMode } from "@codemirror/legacy-modes/mode/simple-mode";

/** Minimal batch/cmd highlighter built with CodeMirror's simple-mode helper. */
const batchMode = simpleMode({
  start: [
    // Comments: `:: comment` or `REM comment`
    { regex: /::.*/, token: "comment" },
    { regex: /@?rem\b.*/i, token: "comment" },
    // Labels: `:label`
    { regex: /:[A-Za-z_][\w-]*/, token: "labelName" },
    // Variables: %NAME%, %~1, %*
    { regex: /%[~]?[A-Za-z_][\w]*%/, token: "variableName" },
    { regex: /%[0-9]|%\*/, token: "variableName" },
    // Double-quoted strings
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    // Keywords
    {
      regex: /@?(?:echo|set|if|else|for|goto|call|exit|pause|cd|dir|copy|del|erase|mkdir|md|rmdir|rd|cls|title|color|pushd|popd|shift|start|timeout|taskkill|where|findstr|type|move|ren|rename|attrib|ver|setlocal|endlocal|chcp|choice|wmic|reg|sc|net|ping|ipconfig|more|sort|find)\b/i,
      token: "keyword",
    },
    { regex: /\b\d+\b/, token: "number" },
    { regex: /[&|<>^]/, token: "operator" },
  ],
  languageData: { commentTokens: { line: "::" } },
});

/** Map a NoteLanguage id to a CodeMirror language extension (null = plain text). */
export function getLanguageByName(language: NoteLanguage): Extension | null {
  switch (language) {
    case "sql":
      return sql();
    case "shell":
      return StreamLanguage.define(legacyShell);
    case "cmd":
      return StreamLanguage.define(batchMode);
    case "powershell":
      return StreamLanguage.define(legacyPowerShell);
    case "json":
      return json();
    case "javascript":
      return javascript();
    case "typescript":
      return javascript({ typescript: true });
    case "python":
      return python();
    case "markdown":
      return markdown();
    case "yaml":
      return yaml();
    case "xml":
      return xml();
    case "html":
      return html();
    case "css":
      return css();
    case "rust":
      return rust();
    case "cpp":
      return cpp();
    case "java":
      return java();
    case "plain":
    default:
      return null;
  }
}

/** Map file extension to a CodeMirror language extension */
function getLanguageExtension(filename: string): Extension | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ jsx: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
      return json();
    case "py":
    case "pyw":
      return python();
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "xml":
    case "svg":
    case "xsl":
    case "xslt":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return cpp();
    case "java":
    case "kt":
    case "kts":
      return java();
    case "sql":
      return sql();
    case "php":
      return php();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "conf":
    case "ini":
    case "toml":
    case "cfg":
    case "env":
    case "log":
    case "txt":
    default:
      return null;
  }
}

interface CodeEditorProps {
  /** Initial document content */
  value: string;
  /** Called whenever the document changes */
  onChange?: (value: string) => void;
  /** Filename used for language detection */
  filename?: string;
  /** Explicit language id — overrides filename-based detection. */
  language?: NoteLanguage;
  /** Read-only mode */
  readOnly?: boolean;
  /** Use dark theme (defaults to true). Ignored when the user has chosen a theme via editor settings. */
  dark?: boolean;
  /** Additional CSS class for the wrapper */
  className?: string;
  /** Provider-neutral database query context. */
  queryContext?: DatabaseQueryEditorContext;
  /** Exposes the underlying CodeMirror EditorView (B19: statement select,
   * comment toggling, selection access). */
  editorRef?: (view: EditorView | null) => void;
}

export function CodeEditor({
  value,
  onChange,
  filename = "",
  language,
  readOnly = false,
  dark = true,
  className = "",
  queryContext,
  editorRef,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorRefRef = useRef(editorRef);
  const onChangeRef = useRef(onChange);
  const queryContextRef = useRef<DatabaseQueryEditorContext>(queryContext ?? genericSqlQueryEditorContext);
  const { t } = useTranslation();
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(() => loadEditorConfig());
  // Custom themed + i18n search panel (replaces CodeMirror's built-in panel).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the editorRef callback fresh and call it on view create/destroy.
  useEffect(() => {
    editorRefRef.current = editorRef;
  }, [editorRef]);
  useEffect(() => {
    editorRefRef.current?.(viewRef.current);
  }, []);

  // Reload config whenever it changes in settings
  useEffect(() => {
    const handler = () => setEditorConfig(loadEditorConfig());
    window.addEventListener(EDITOR_CONFIG_CHANGED_EVENT, handler);
    return () => window.removeEventListener(EDITOR_CONFIG_CHANGED_EVENT, handler);
  }, []);

  // Keep callback ref fresh without recreating the editor
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    queryContextRef.current = queryContext ?? genericSqlQueryEditorContext;
  }, [queryContext]);

  const buildExtensions = useCallback((): Extension[] => {
    const exts: Extension[] = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        ...completionKeymap,
        indentWithTab,
        // Override the built-in find panel with our themed search bar.
        {
          key: "Mod-f",
          run: () => {
            setSearchOpen(true);
            setSearchCount(0);
            requestAnimationFrame(() => searchInputRef.current?.focus());
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            if (searchOpen) {
              setSearchOpen(false);
              const view = viewRef.current;
              if (view) {
                view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
                view.focus();
              }
              return true;
            }
            return false;
          },
        },
      ]),
      // Dispatch listener for onChange
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChangeRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      // Tab size from config
      EditorState.tabSize.of(editorConfig.tabSize),
    ];

    // Conditional extensions based on user config
    if (editorConfig.lineNumbers) {
      exts.push(lineNumbers());
      exts.push(highlightActiveLineGutter());
    }
    if (editorConfig.highlightActiveLine) {
      exts.push(highlightActiveLine());
    }
    if (editorConfig.foldGutter) {
      exts.push(foldGutter());
    }
    if (editorConfig.bracketMatching || editorConfig.matchBrackets) {
      exts.push(bracketMatching());
    }
    // SQL/query editors default to no word-wrap so long statements scroll
    // horizontally instead of wrapping and truncating (visual review B-2,
    // v2.9.0). A user's explicit editor-config choice still wins.
    const isSqlEditor =
      language === "sql" || filename.toLowerCase().endsWith(".sql");
    if (editorConfig.wordWrap && !isSqlEditor) {
      exts.push(EditorView.lineWrapping);
    }
    // SQL editors support the error-line wavy-underline mark driven by
    // `revealEditorLine` (ux-spec §2.2.1) — register its state field here.
    if (isSqlEditor) {
      exts.push(...errorLineMarkExtension());
    }

    // Theme: follow the application UI theme by default; a user's explicit
    // editor-config choice overrides it. Light UI must never keep a dark
    // editor (visual review M1, v2.8.0) — so a dark-configured editor is
    // only applied when the app itself is in dark mode.
    const themeId = editorConfig.theme;
    const appDark = document.documentElement.classList.contains("dark");
    if (themeId === "oneDark" && appDark) {
      exts.push(oneDark);
    } else if (themeId === "light") {
      // No extra extension needed — CodeMirror's base chrome is light
    } else if (dark && appDark) {
      exts.push(oneDark);
    }

    if (readOnly) {
      exts.push(EditorState.readOnly.of(true));
    }

    // Explicit language takes precedence over filename-based detection
    const isSql = language === "sql" || filename.toLowerCase().endsWith(".sql");
    const lang = isSql
      ? sql({ dialect: queryEditorDialect(queryContextRef.current) })
      : language
        ? getLanguageByName(language)
        : getLanguageExtension(filename);
    if (lang) {
      exts.push(lang);
    }

    if (isSql) {
      exts.push(autocompletion({ override: [(context) => queryEditorCompletionSource(queryContextRef.current)(context)], activateOnTyping: true }));
    }

    return exts;
  }, [filename, language, readOnly, dark, editorConfig]);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: buildExtensions(),
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    editorRefRef.current?.(view);

    return () => {
      view.destroy();
      viewRef.current = null;
      editorRefRef.current?.(null);
    };
    // Only recreate when language/readOnly/dark changes, not on every value change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildExtensions]);

  // Sync external value changes (e.g. loading a new file) without recreating the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  // Apply the search query to the editor (highlights + counts matches).
  const applySearch = useCallback((text: string, next = false) => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({ search: text, caseSensitive: false });
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (text.trim()) {
      // Count matches for the "n / total" indicator.
      const doc = view.state.doc.toString();
      const lower = text.toLowerCase();
      let count = 0;
      let idx = 0;
      while ((idx = doc.toLowerCase().indexOf(lower, idx)) !== -1) {
        count++;
        idx += Math.max(lower.length, 1);
      }
      setSearchCount(count);
      if (next) findNext(view);
    } else {
      setSearchCount(0);
    }
  }, []);

  const handleSearchInput = useCallback(
    (text: string) => {
      setSearchText(text);
      applySearch(text, true);
    },
    [applySearch],
  );

  const handleSearchNext = useCallback(() => {
    const view = viewRef.current;
    if (view) findNext(view);
  }, []);

  const handleSearchPrev = useCallback(() => {
    const view = viewRef.current;
    if (view) findPrevious(view);
  }, []);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchText("");
    setSearchCount(0);
    const view = viewRef.current;
    if (view) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      view.focus();
    }
  }, []);

  return (
    <div className={`relative h-full flex flex-col overflow-hidden border rounded-md ${className}`}>
      {searchOpen && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b bg-background/95 backdrop-blur shrink-0 z-10" data-editor-search>
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            ref={searchInputRef}
            value={searchText}
            onChange={(e) => handleSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) handleSearchPrev();
                else handleSearchNext();
              }
              if (e.key === "Escape") handleSearchClose();
            }}
            placeholder={t("editor.searchPlaceholder")}
            className="h-7 text-xs flex-1 min-w-0"
          />
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-10 text-right">
            {searchText.trim() ? `${searchCount}` : ""}
          </span>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={handleSearchPrev} title={t("editor.findPrev")}>
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={handleSearchNext} title={t("editor.findNext")}>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={handleSearchClose} title={t("editor.close")}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto"
        style={{
          fontSize: `${editorConfig.fontSize}px`,
          fontFamily: editorConfig.fontFamily,
        }}
      />
    </div>
  );
}

export default CodeEditor;
