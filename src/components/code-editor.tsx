import React, { useRef, useEffect, useCallback, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, dropCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { loadEditorConfig, EDITOR_CONFIG_CHANGED_EVENT, type EditorConfig } from "@/lib/editor-config";
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
}

export function CodeEditor({
  value,
  onChange,
  filename = "",
  language,
  readOnly = false,
  dark = true,
  className = "",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(() => loadEditorConfig());

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
        indentWithTab,
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
    if (editorConfig.wordWrap) {
      exts.push(EditorView.lineWrapping);
    }

    // Theme: user-configured theme takes precedence over the `dark` prop
    const themeId = editorConfig.theme;
    if (themeId === "oneDark") {
      exts.push(oneDark);
    } else if (themeId === "light") {
      // No extra extension needed — CodeMirror's base chrome is light
    } else if (dark) {
      exts.push(oneDark);
    }

    if (readOnly) {
      exts.push(EditorState.readOnly.of(true));
    }

    // Explicit language takes precedence over filename-based detection
    const lang = language ? getLanguageByName(language) : getLanguageExtension(filename);
    if (lang) {
      exts.push(lang);
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

    return () => {
      view.destroy();
      viewRef.current = null;
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

  return (
    <div
      ref={containerRef}
      className={`overflow-auto border rounded-md ${className}`}
      style={{
        height: "100%",
        fontSize: `${editorConfig.fontSize}px`,
        fontFamily: editorConfig.fontFamily,
      }}
    />
  );
}
