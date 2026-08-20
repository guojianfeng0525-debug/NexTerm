/**
 * JAR decompiler — frontend API layer.
 * Thin wrappers around the Tauri jar_* commands with a timeout guard.
 */
import { invoke } from '@tauri-apps/api/core';

function withTimeout<T>(promise: Promise<T>, ms = 120000): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`操作超时（${ms / 1000}s）`)), ms),
  );
  return Promise.race([promise, timer]);
}

export interface JarEntryInfo {
  entryPath: string;
  className: string;
  packageName: string;
  kind: 'class' | 'resource' | 'meta-inf';
  isInnerClass: boolean;
  size: number;
  compressedSize: number;
}

export interface PackageNode {
  name: string;
  classes: JarEntryInfo[];
  packages: Record<string, PackageNode>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  jarPath: string;
  jarHash: string;
  size: number;
  classCount: number;
  resourceCount: number;
  classTree: Record<string, PackageNode>;
  createdAt: number;
  updatedAt: number;
}

export interface ClassView {
  entryPath: string;
  className: string;
  packageName: string;
  kind: string;
  isInnerClass: boolean;
  source: string;
  originalSource?: string;
  modified: boolean;
  compileStatus: string;
  compileOutput?: string;
  refs?: ClassRef[];
  methods?: { name: string; line: number }[];
}

export interface ClassRef {
  internalTypeName: string;
  name?: string | null;
  kind: string; // 'type' | 'field' | 'method'
  descriptor?: string | null;
}

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  level: 'error' | 'warning';
  message: string;
}

export interface JdkInfo {
  found: boolean;
  javacPath?: string;
  javaVersion?: string;
  javaHome?: string;
  error?: string;
}

export interface PomOpenResult {
  projectId: string;
  name: string;
  pom: { groupId: string; artifactId: string; version: string; resolvedCount: number };
  libraries: { id: string; name: string; editable: boolean; classCount: number }[];
  classTree: Record<string, PackageNode>;
}

export interface LibraryInfo {
  id: string;
  name: string;
  groupId: string;
  artifactId: string;
  version: string;
  jarPath: string;
  classCount: number;
  editable: boolean;
}

export interface NavigateResult {
  kind: string;
  className: string;
  entryPath: string;
  libraryId?: string;
  projectId?: string;
  line?: number | null;
}

export const jarApi = {
  openProject(path: string): Promise<ProjectSummary> {
    return withTimeout(invoke<ProjectSummary>('jar_project_open', { path }));
  },
  openProjectFromId(projectId: string): Promise<ProjectSummary> {
    return withTimeout(invoke<ProjectSummary>('jar_project_reopen', { projectId }), 30000);
  },
  listProjects(): Promise<ProjectSummary[]> {
    return withTimeout(invoke<ProjectSummary[]>('jar_project_list'), 30000);
  },
  deleteProject(projectId: string): Promise<void> {
    return withTimeout(invoke('jar_project_delete', { projectId }), 30000);
  },
  classIndex(projectId: string): Promise<Record<string, PackageNode>> {
    return withTimeout(invoke('jar_class_index', { projectId }), 30000);
  },
  search(projectId: string, query: string): Promise<unknown[]> {
    return withTimeout(invoke('jar_class_search', { projectId, query }), 30000);
  },
  decompile(projectId: string, entryPath: string): Promise<ClassView> {
    return withTimeout(invoke<ClassView>('jar_decompile', { projectId, entryPath }));
  },
  decompileCancel(projectId: string): Promise<void> {
    return withTimeout(invoke('jar_decompile_cancel', { projectId }), 10000);
  },
  readResource(projectId: string, entryPath: string): Promise<string> {
    return withTimeout(invoke<string>('jar_resource_read', { projectId, entryPath }), 60000);
  },
  save(projectId: string, entryPath: string, source: string): Promise<{ saved: boolean; modified: boolean }> {
    return withTimeout(invoke('jar_class_save', { projectId, entryPath, source }), 30000);
  },
  revert(projectId: string, entryPath: string, version?: number): Promise<ClassView> {
    return withTimeout(invoke<ClassView>('jar_class_revert', { projectId, entryPath, version: version ?? null }), 30000);
  },
  reset(projectId: string): Promise<void> {
    return withTimeout(invoke('jar_project_reset', { projectId }), 30000);
  },
  jdkDetect(): Promise<JdkInfo> {
    return withTimeout(invoke<JdkInfo>('jar_jdk_detect'), 20000);
  },
  compile(projectId: string, entryPath?: string): Promise<{ success: boolean; diagnostics: CompileDiagnostic[]; classCount: number; message?: string }> {
    return withTimeout(invoke('jar_compile', { projectId, entryPath: entryPath ?? null }), 120000);
  },
  build(projectId: string, outputPath: string): Promise<{ success: boolean; size: number; outputPath: string }> {
    return withTimeout(invoke('jar_build', { projectId, outputPath }), 120000);
  },
  pomOpen(path: string): Promise<PomOpenResult> {
    return withTimeout(invoke<PomOpenResult>('jar_pom_open', { path }), 120000);
  },
  libraries(projectId: string): Promise<LibraryInfo[]> {
    return withTimeout(invoke<LibraryInfo[]>('jar_libraries', { projectId }), 30000);
  },
  libraryIndex(projectId: string, libraryId: string): Promise<Record<string, PackageNode>> {
    return withTimeout(invoke('jar_library_index', { projectId, libraryId }), 30000);
  },
  navigate(projectId: string, name: string, kind: 'class' | 'method'): Promise<NavigateResult> {
    return withTimeout(invoke<NavigateResult>('jar_navigate', { projectId, name, kind }), 30000);
  },

  methodLocation(projectId: string, classInternalName: string, methodName: string, descriptor?: string | null): Promise<{ entryPath: string; className: string; libraryId: string; line: number }> {
    return withTimeout(invoke('jar_method_location', { projectId, classInternalName, methodName, descriptor: descriptor ?? null }), 120000);
  },

  openType(projectId: string, pattern: string, scope?: 'current' | 'all'): Promise<{ entryPath: string; className: string; packageName: string; libraryId: string; projectId: string; projectName: string; isInnerClass: boolean; modified: boolean }[]> {
    return withTimeout(invoke('jar_open_type', { projectId, pattern, scope: scope ?? 'current' }), 30000);
  },

  knownClassNames(projectId: string): Promise<{ names: string[]; simple: string[] }> {
    return withTimeout(invoke('jar_known_class_names', { projectId }), 30000);
  },

  typeHierarchy(projectId: string, entryPath: string, libraryId?: string): Promise<{ target: string; targetEntryPath: string; parents: string[]; subTypes: unknown[] }> {
    return withTimeout(invoke('jar_type_hierarchy', { projectId, entryPath, libraryId: libraryId ?? null }), 120000);
  },

  constantSearch(projectId: string, pattern: string, flags: number): Promise<{ results: { kind: string; value: string; className: string; libraryId: string }[] }> {
    return withTimeout(invoke('jar_constant_search', { projectId, pattern, flags }), 120000);
  },

  resourceBytes(projectId: string, entryPath: string, libraryId?: string): Promise<{ bytes: string; size: number; isText: boolean }> {
    return withTimeout(invoke('jar_resource_bytes', { projectId, entryPath, libraryId: libraryId ?? null }), 60000);
  },
  exportAll(projectId: string, outputDir: string): Promise<{ exported: number; total: number; failed: number; failedClasses: string[]; outputDir: string }> {
    return withTimeout(invoke('jar_export_all', { projectId, outputDir }), 300000);
  },
  classInfo(projectId: string, entryPath: string, libraryId?: string): Promise<{ className: string; javaVersion: string; major: number; minor: number; size: number }> {
    return withTimeout(invoke('jar_class_info', { projectId, entryPath, libraryId: libraryId ?? null }), 30000);
  },
};
