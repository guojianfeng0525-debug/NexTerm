import { rowDelete, rowGet, rowList, rowUpsert } from './db';

export interface JarPreferences {
  fontSize: number;
  singleLineTabs: boolean;
  escapeUnicode: boolean;
  realignLineNumbers: boolean;
  writeLineNumbers: boolean;
  writeMetadata: boolean;
  mavenEnabled: boolean;
  mavenFilters: string;
}

export interface JarRecentFile {
  path: string;
  name: string;
  at: number;
}

const defaults: JarPreferences = {
  fontSize: 12,
  singleLineTabs: false,
  escapeUnicode: false,
  realignLineNumbers: false,
  writeLineNumbers: true,
  writeMetadata: true,
  mavenEnabled: true,
  mavenFilters: '+org.springframework +org.apache +org.hibernate',
};

let preferences = { ...defaults };
let recentFiles: JarRecentFile[] = [];
let findHistory: string[] = [];

const bool = (value: unknown, fallback: boolean) => typeof value === 'number' ? value !== 0 : typeof value === 'boolean' ? value : fallback;
const num = (value: unknown, fallback: number) => typeof value === 'number' ? value : fallback;
const str = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback;

export async function hydrateJarStorage(): Promise<void> {
  const [prefs, recentRows, historyRows] = await Promise.all([
    rowGet('jar_preferences', '1'),
    rowList('jar_recent_files'),
    rowList('jar_find_history'),
  ]);
  if (prefs) {
    preferences = {
      fontSize: Math.min(40, Math.max(2, num(prefs.font_size, defaults.fontSize))),
      singleLineTabs: bool(prefs.single_line_tabs, defaults.singleLineTabs),
      escapeUnicode: bool(prefs.escape_unicode, defaults.escapeUnicode),
      realignLineNumbers: bool(prefs.realign_line_numbers, defaults.realignLineNumbers),
      writeLineNumbers: bool(prefs.write_line_numbers, defaults.writeLineNumbers),
      writeMetadata: bool(prefs.write_metadata, defaults.writeMetadata),
      mavenEnabled: bool(prefs.maven_enabled, defaults.mavenEnabled),
      mavenFilters: str(prefs.maven_filters, defaults.mavenFilters),
    };
  }
  recentFiles = recentRows
    .map((row) => ({ path: str(row.path, ''), name: str(row.name, ''), at: num(row.opened_at, 0) }))
    .filter((row) => row.path)
    .sort((a, b) => b.at - a.at)
    .slice(0, 10);
  findHistory = historyRows
    .map((row) => ({ query: str(row.query, ''), at: num(row.used_at, 0) }))
    .filter((row) => row.query)
    .sort((a, b) => b.at - a.at)
    .slice(0, 10)
    .map((row) => row.query);
}

export function getJarPreferences(): JarPreferences { return preferences; }
export function getJarRecentFiles(): JarRecentFile[] { return recentFiles; }
export function getJarFindHistory(): string[] { return findHistory; }

export function setJarPreferences(next: Partial<JarPreferences>): void {
  preferences = { ...preferences, ...next };
  void rowUpsert('jar_preferences', {
    id: 1,
    font_size: preferences.fontSize,
    single_line_tabs: preferences.singleLineTabs,
    escape_unicode: preferences.escapeUnicode,
    realign_line_numbers: preferences.realignLineNumbers,
    write_line_numbers: preferences.writeLineNumbers,
    write_metadata: preferences.writeMetadata,
    maven_enabled: preferences.mavenEnabled,
    maven_filters: preferences.mavenFilters,
    updated_at: Date.now(),
  });
}

export function saveJarRecentFiles(files: JarRecentFile[]): void {
  recentFiles = files.slice(0, 10);
  void (async () => {
    const saved = await rowList('jar_recent_files');
    const keep = new Set(recentFiles.map((file) => file.path));
    await Promise.all(saved
      .map((row) => str(row.id, ''))
      .filter((id) => id && !keep.has(id))
      .map((id) => rowDelete('jar_recent_files', id)));
    for (const file of recentFiles) {
      await rowUpsert('jar_recent_files', { id: file.path, path: file.path, name: file.name, opened_at: file.at });
    }
  })();
}

export function saveJarFindHistory(history: string[]): void {
  findHistory = history.slice(0, 10);
  void (async () => {
    const saved = await rowList('jar_find_history');
    const keep = new Set(findHistory);
    await Promise.all(saved
      .map((row) => str(row.id, ''))
      .filter((id) => id && !keep.has(id))
      .map((id) => rowDelete('jar_find_history', id)));
    for (const [index, query] of findHistory.entries()) {
      await rowUpsert('jar_find_history', { id: query, query, used_at: Date.now() - index });
    }
  })();
}
