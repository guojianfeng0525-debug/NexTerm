import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { prefGet } from "./preferences";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ThemeMode = 'dark' | 'light' | 'auto';

export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

export function getSavedTheme(): ThemeMode {
  const settings = prefGet<{ theme?: unknown } | null>('sshClientSettings', null);
  if (settings && typeof settings === 'object') {
    const theme = settings.theme;
    if (theme === 'dark' || theme === 'light' || theme === 'auto') {
      return theme;
    }
  }
  return 'dark';
}

export function initializeTheme(): void {
  const theme = getSavedTheme();
  applyTheme(theme);
  
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const currentTheme = getSavedTheme();
    if (currentTheme === 'auto') {
      document.documentElement.classList.toggle('dark', e.matches);
    }
  });
}

export function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function getAppTheme(): 'dark' | 'light' {
  return isDarkMode() ? 'dark' : 'light';
}
