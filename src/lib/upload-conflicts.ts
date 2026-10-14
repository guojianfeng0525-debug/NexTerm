export interface UploadVersion {
  kind: 'File' | 'Directory' | 'Symlink' | 'Queued';
  size: number;
  modified: string | null;
}

export interface UploadTarget { path: string; version: UploadVersion | null }
export type ConflictPolicy = 'ask' | 'replace' | 'keep-both' | 'skip';
export interface UploadApproval {
  expectedTarget?: UploadVersion;
  conflictPolicy?: ConflictPolicy;
  batchId?: string;
  skip?: boolean;
}

export function canReplaceUpload(target: UploadTarget) { return target.version?.kind === 'File'; }

export function validateUploadTargets(value: unknown, paths: string[]): UploadTarget[] {
  if (!Array.isArray(value) || value.length !== paths.length) throw new Error('Invalid upload inspection response');
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || !('path' in entry) || entry.path !== paths[index] || !('version' in entry)) {
      throw new Error('Upload inspection target mismatch');
    }
    const version: unknown = entry.version;
    if (version === null) return { path: paths[index], version: null };
    if (!version || typeof version !== 'object' || !('kind' in version) || !['File', 'Directory', 'Symlink'].includes(String(version.kind))
      || !('size' in version) || typeof version.size !== 'number' || !Number.isFinite(version.size) || version.size < 0
      || !('modified' in version) || version.modified !== null && typeof version.modified !== 'string') {
      throw new Error('Invalid upload target metadata');
    }
    return { path: paths[index], version: { kind: version.kind as UploadVersion['kind'], size: version.size, modified: version.modified } };
  });
}
