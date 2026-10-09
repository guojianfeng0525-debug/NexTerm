export interface FileDeletionTarget {
  name: string;
  path: string;
  isDirectory: boolean;
}

export function isFileEntryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

/** Remote paths are POSIX paths, including when NexTerm itself runs on Windows. */
export function remoteDeleteParent(path: string): string | null {
  if (!path.startsWith('/') || path === '/' || path.endsWith('/') || path.includes('\0')) return null;
  const parts = path.slice(1).split('/');
  if (parts.some(part => !isFileEntryName(part))) return null;
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function isDirectRemoteChild(path: string, directory: string): boolean {
  const parent = directory === '/' ? '/' : directory.replace(/\/+$/, '');
  return remoteDeleteParent(path) === parent;
}
