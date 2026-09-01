import { beforeEach, describe, expect, it } from 'vitest';

import {
  defaultLightTerminalTheme,
  getThemeAwareTerminalTheme,
  normalizeAppearanceSettings,
} from '../terminal-config';

describe('terminal appearance theme normalization', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('maps the legacy default sentinel to the selectable VS Code preset', () => {
    expect(
      normalizeAppearanceSettings({
        fontSize: 14,
        fontFamily: 'monospace',
        lineHeight: 1.2,
        letterSpacing: 0,
        cursorStyle: 'block',
        cursorBlink: true,
        theme: 'default',
        scrollback: 10_000,
        allowTransparency: false,
        opacity: 100,
        backgroundImage: '',
        backgroundImageOpacity: 30,
        backgroundImageBlur: 0,
        backgroundImagePosition: 'cover',
      }).theme,
    ).toBe('vs-code-dark');
  });

  it('uses the light terminal variant when the app theme is light', () => {
    const theme = getThemeAwareTerminalTheme({
      fontSize: 14,
      fontFamily: 'monospace',
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorStyle: 'block',
      cursorBlink: true,
      theme: 'vs-code-dark',
      scrollback: 10_000,
      allowTransparency: false,
      opacity: 100,
      backgroundImage: '',
      backgroundImageOpacity: 30,
      backgroundImageBlur: 0,
      backgroundImagePosition: 'cover',
    });

    expect(theme.background).toBe(defaultLightTerminalTheme.background);
  });
});
