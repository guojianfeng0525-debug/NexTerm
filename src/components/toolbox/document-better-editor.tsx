/**
 * BetterOffice editor wrapper — lazily loads the React editor for the
 * document kind. The editor works on file bytes; save hands the edited bytes
 * back to the caller (which persists the canonical model via the backend).
 *
 * Editor chrome (toolbar menus, dialogs) follows the app language: when the
 * current i18next language is zh-CN, the official BetterOffice zh-CN locale
 * pack is lazily loaded and passed via the `i18n` prop. English needs no pack
 * (the engine's default).
 */
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Translations as DocxTranslations } from '@betteroffice/docx-i18n';
import type { Translations as XlsxTranslations } from '@betteroffice/xlsx-i18n';
import { ensureBetterOfficeFonts } from '@/lib/toolbox/betteroffice-fonts';
// DOCX editor chrome styles — required for the toolbar/menus/dialogs to render
// with surfaces, borders and colors. Without it the `--doc-*` theme variables
// and `.oox-root` rules are missing and menu backgrounds render transparent.
// Loaded in this chunk (never the app shell bundle).
import '@betteroffice/docx-react/styles.css';

// Font provider must be registered before any editor instance loads (the
// engine's font registry keeps its provider once created). This module-level
// call runs when the editor chunk is imported — before the lazy editor chunk
// below is requested.
ensureBetterOfficeFonts();

const XlsxEditor = lazy(() =>
  import('@betteroffice/xlsx-react').then((m) => ({ default: m.XlsxEditor })),
);
const DocxEditor = lazy(() =>
  import('@betteroffice/docx-react').then((m) => ({ default: m.DocxEditor })),
);

interface BetterEditorProps {
  kind: 'xlsx' | 'docx';
  /** File bytes to open. */
  bytes: Uint8Array;
  onSave: (bytes: Uint8Array) => void;
  onError?: (error: Error) => void;
}

/** Lazily load the BetterOffice zh-CN locale pack for a document kind. */
function useEditorLocale(
  kind: 'xlsx' | 'docx',
  wantZh: boolean,
): DocxTranslations | XlsxTranslations | undefined {
  const [locale, setLocale] = useState<DocxTranslations | XlsxTranslations | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!wantZh) {
      setLocale(undefined);
      return;
    }
    if (kind === 'xlsx') {
      // The official xlsx zh-CN pack is an empty shell (all null), so merge our
      // full in-repo translation over it — upstream additions win when present.
      Promise.all([
        import('@betteroffice/xlsx-i18n/zh-CN'),
        import('@/lib/toolbox/xlsx-zh-cn'),
      ])
        .then(([official, ours]) => {
          if (!cancelled) setLocale(deepMerge(official.default, ours.XLSX_ZH_CN));
        })
        .catch(() => {
          if (!cancelled) setLocale(undefined);
        });
      return () => {
        cancelled = true;
      };
    }
    import('@betteroffice/docx-i18n/zh-CN')
      .then((m) => {
        if (!cancelled) setLocale(m.default);
      })
      .catch(() => {
        // Locale pack unavailable — editor falls back to English.
        if (!cancelled) setLocale(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, wantZh]);

  return locale;
}

/** Merge `over` into `base`, recursively; `over` wins on conflicts. */
function deepMerge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) {
    return (over === null ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}

export function BetterEditor({ kind, bytes, onSave, onError }: BetterEditorProps) {
  const { i18n, t } = useTranslation();
  const wantZh = i18n.language.startsWith('zh');
  const locale = useEditorLocale(kind, wantZh);

  const fallback = (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin mr-2" />
      正在加载编辑器…
    </div>
  );

  // WebKit (macOS) renders NO web-layer scrollbar (verified pixel-identical),
  // so a hint is needed there. Chromium (Windows WebView2 / Linux) honors
  // ::-webkit-scrollbar (globals.css) — native bars are always visible and
  // draggable, so the hint would be noise (and its trackpad wording wrong for
  // desktop machines without a touchpad).
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  if (kind === 'xlsx') {
    return (
      <Suspense fallback={fallback}>
        <div className="relative h-full">
          <XlsxEditor
            file={bytes}
            onSave={(b: Uint8Array) => onSave(b)}
            className="h-full"
            i18n={locale as XlsxTranslations | undefined}
          />
          {/* macOS-only hint: the overlay bar appears when the pointer hovers
              the right edge; Shift+scroll also scrolls horizontally (works
              with a mouse wheel — no trackpad required). */}
          {isMac && (
            <p
              className="pointer-events-none absolute bottom-1.5 right-3 z-10 select-none text-[10px] leading-none text-muted-foreground/70"
              data-testid="xlsx-hscroll-hint"
            >
              {t('toolbox.documents.hScrollHint')}
            </p>
          )}
        </div>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={fallback}>
      <div className="h-full">
        <DocxEditor
          documentBuffer={bytes}
          onSave={(b: ArrayBuffer) => onSave(new Uint8Array(b))}
          onError={onError}
          showFileOpen={false}
          colorMode="system"
          className="h-full"
          i18n={locale as DocxTranslations | undefined}
        />
      </div>
    </Suspense>
  );
}
