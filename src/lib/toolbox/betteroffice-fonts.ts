/**
 * BetterOffice bundled-font provider setup.
 *
 * The DOCX engine measures text with real font bytes to paginate like Word.
 * Without a provider it falls back to browser `measureText`, which varies by
 * OS font and breaks page fidelity. This wires `@betteroffice/fonts` (metric
 * -compatible Latin + RTL faces) and `@betteroffice/fonts-cjk` (Noto
 * SC/TC/JP/KR coverage) into the engine's default font registry.
 *
 * The call MUST happen before any editor loads: the registry keeps its
 * provider once created, so configuring after first render is a no-op. The
 * editor component imports this module at its top level, which runs before
 * the lazily-imported editor chunk.
 */
import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { createFontProvider } from '@betteroffice/fonts';

let configured = false;

/** Configure the engine's default font provider once. Idempotent. */
export function ensureBetterOfficeFonts(): void {
  if (configured) return;
  configured = true;
  try {
    configureDefaultFonts({ fonts: { createFontProvider } });
  } catch (error) {
    // Never break document opening over font setup; the engine degrades to
    // browser measurement if fonts are unavailable.
    console.warn('[betteroffice] font provider setup failed:', error);
  }
}
