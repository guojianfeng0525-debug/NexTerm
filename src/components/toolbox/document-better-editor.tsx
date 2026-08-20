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
    const loader =
      kind === 'xlsx'
        ? import('@betteroffice/xlsx-i18n/zh-CN')
        : import('@betteroffice/docx-i18n/zh-CN');
    loader
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

export function BetterEditor({ kind, bytes, onSave, onError }: BetterEditorProps) {
  const { i18n } = useTranslation();
  const wantZh = i18n.language.startsWith('zh');
  const locale = useEditorLocale(kind, wantZh);

  const fallback = (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin mr-2" />
      正在加载编辑器…
    </div>
  );

  if (kind === 'xlsx') {
    return (
      <Suspense fallback={fallback}>
        <div className="h-full">
          <XlsxEditor
            file={bytes}
            onSave={(b: Uint8Array) => onSave(b)}
            className="h-full"
            i18n={locale as XlsxTranslations | undefined}
          />
        </div>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={fallback}>
      <div className="h-full">
        <DocxEditor
          documentBuffer={bytes as unknown as ArrayBuffer}
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
