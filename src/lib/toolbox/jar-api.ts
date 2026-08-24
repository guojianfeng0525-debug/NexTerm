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
  kind: string; // 'type' | 'field' | 'method' | 'constructor'
  descriptor?: string | null;
  /** Owner internal name passed by jd-core (class containing the reference). */
  owner?: string | null;
  /** Exact start offset in the decompiled source (JD-GUI hyperlink position). */
  offset?: number;
  /** Length of the referenced token in the source. */
  len?: number;
}

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  level: 'error' | 'warning';
  message: string;
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
  /** JD-GUI SelectLocation: when `kind === 'multiple'`, the candidates. */
  candidates?: { entryPath: string; libraryId: string; projectId: string }[];
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
  decompile(projectId: string, entryPath: string, libraryId?: string | null, opts?: { escapeUnicode?: boolean | null; realign?: boolean | null }): Promise<ClassView> {
    return withTimeout(invoke<ClassView>('jar_decompile', {
      projectId,
      entryPath,
      libraryId: libraryId ?? null,
      escapeUnicode: opts?.escapeUnicode ?? null,
      realign: opts?.realign ?? null,
    }), 120000);
  },
  decompileCancel(projectId: string): Promise<void> {
    return withTimeout(invoke('jar_decompile_cancel', { projectId }), 10000);
  },
  readResource(projectId: string, entryPath: string, libraryId?: string | null): Promise<string> {
    return withTimeout(invoke<string>('jar_resource_read', { projectId, entryPath, libraryId: libraryId ?? null }), 60000);
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

  constantSearch(projectId: string, pattern: string, flags: number): Promise<{ results: { entryPath: string; className: string; libraryId: string; matches: { kind: string; scope: string; value: string; internalTypeName: string }[] }[] }> {
    return withTimeout(invoke('jar_constant_search', { projectId, pattern, flags }), 120000);
  },

  resourceBytes(projectId: string, entryPath: string, libraryId?: string): Promise<{ bytes: string; size: number; isText: boolean }> {
    return withTimeout(invoke('jar_resource_bytes', { projectId, entryPath, libraryId: libraryId ?? null }), 60000);
  },
  exportAll(projectId: string, outputDir: string, opts?: { writeMetadata?: boolean; writeLineNumbers?: boolean; escapeUnicode?: boolean | null; realign?: boolean | null }): Promise<{ exported: number; total: number; failed: number; failedClasses: string[]; outputDir: string }> {
    // Exports can legitimately run longer than a fixed client-side deadline.
    // Progress and cancellation are delivered through jar://export-progress.
    return invoke('jar_export_all', {
      projectId,
      outputDir,
      writeMetadata: opts?.writeMetadata ?? true,
      writeLineNumbers: opts?.writeLineNumbers ?? true,
      escapeUnicode: opts?.escapeUnicode ?? null,
      realign: opts?.realign ?? null,
    });
  },
  classInfo(projectId: string, entryPath: string, libraryId?: string): Promise<{ className: string; javaVersion: string; major: number; minor: number; size: number }> {
    return withTimeout(invoke('jar_class_info', { projectId, entryPath, libraryId: libraryId ?? null }), 30000);
  },
  /** JD-GUI MavenOrgSourceLoader: download the library's -sources.jar. */
  mavenSources(projectId: string, libraryId: string, filters?: string): Promise<{ root: string; groupId: string; artifactId: string; version: string }> {
    return withTimeout(invoke('jar_maven_sources', { projectId, libraryId, filters: filters ?? null }), 180000);
  },
  /** Read a .java file from an extracted Maven sources root. */
  readSourceFile(root: string, entryPath: string): Promise<{ source: string; size: number }> {
    return withTimeout(invoke('jar_read_source_file', { root, entryPath }), 30000);
  },
};
