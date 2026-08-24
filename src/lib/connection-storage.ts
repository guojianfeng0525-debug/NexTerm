/**
 * Connection Storage Management
 * Handles saving, loading, and managing SSH connections with hierarchical
 * organization.
 *
 * Storage is SQLite-backed with normalized tables: `connections` (one row per
 * connection), `folders` (one row per folder) and `active_connections` (one
 * row per open tab). Sensitive fields (password, passphrase, proxy password,
 * jump password, VNC password) are encrypted individually with the app-password key before
 * being written; the rest of the row stays plaintext.
 *
 * The public API stays synchronous: an in-memory cache is hydrated by
 * `hydrateConnectionsStorage()` after the app is unlocked (before any UI
 * renders).
 */
import { rowList, rowUpsert, rowDelete, encField, decField } from './toolbox/db';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface ConnectionData {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: string;
  folder?: string; // Path to parent folder (e.g., 'All Connections/Work')
  profileId?: string; // Link to connection profile if created from one
  createdAt: string;
  lastConnected?: string;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  description?: string;
  // Authentication details
  authMethod?: 'password' | 'publickey' | 'keyboard-interactive' | 'anonymous';
  password?: string; // Encrypted at rest via the SQLite store
  privateKeyPath?: string;
  passphrase?: string;
  // FTP-specific
  ftpsEnabled?: boolean;
  // Proxy
  proxyType?: 'none' | 'http' | 'socks4' | 'socks5';
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  // SSH jump host (bastion / ProxyJump)
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPassword?: string; // Encrypted at rest via the SQLite store
  jumpUseKey?: boolean; // Authenticate on the jump host with the same key as the target
  // SSH-specific advanced
  defaultDirectory?: string; // initial working directory on connect
  compression?: boolean;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;
  // RDP-specific
  domain?: string;
  rdpResolution?: string;
  // VNC-specific
  vncColorDepth?: string;
  vncPassword?: string;
  // Ordering
  sortOrder?: number;
}

export interface ConnectionFolder {
  id: string;
  name: string;
  path: string; // Full path (e.g., 'All Connections/Work/Production')
  parentPath?: string; // Parent folder path
  createdAt: string;
  sortOrder?: number;
}

interface SqlCache {
  connections: ConnectionData[];
  folders: ConnectionFolder[];
  active: ActiveConnectionState[];
}

// In-memory cache; null until hydrateConnectionsStorage() completes.
let sqlCache: SqlCache | null = null;

export function isConnectionsHydrated(): boolean {
  return sqlCache !== null;
}

/** Reset the in-memory cache (used by tests for isolation). */
export function resetConnectionsCache(): void {
  sqlCache = null;
}

/* ── row mapping (plaintext in memory, sensitive fields encrypted at rest) ── */

function connToRow(c: ConnectionData): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    protocol: c.protocol,
    folder: c.folder ?? null,
    profile_id: c.profileId ?? null,
    created_at: c.createdAt,
    last_connected: c.lastConnected ?? null,
    favorite: c.favorite ? 1 : 0,
    color: c.color ?? null,
    tags: c.tags ? JSON.stringify(c.tags) : null,
    description: c.description ?? null,
    auth_method: c.authMethod ?? null,
    private_key_path: c.privateKeyPath ?? null,
    ftps_enabled: c.ftpsEnabled ? 1 : 0,
    proxy_type: c.proxyType ?? null,
    proxy_host: c.proxyHost ?? null,
    proxy_port: c.proxyPort ?? null,
    proxy_username: c.proxyUsername ?? null,
    jump_host: c.jumpHost ?? null,
    jump_port: c.jumpPort ?? null,
    jump_username: c.jumpUsername ?? null,
    default_directory: c.defaultDirectory ?? null,
    compression: c.compression ? 1 : 0,
    keep_alive: c.keepAlive ? 1 : 0,
    keep_alive_interval: c.keepAliveInterval ?? null,
    server_alive_count_max: c.serverAliveCountMax ?? null,
    domain: c.domain ?? null,
    rdp_resolution: c.rdpResolution ?? null,
    vnc_color_depth: c.vncColorDepth ?? null,
    sort_order: c.sortOrder ?? null,
  };
}

function rowToConn(row: Record<string, unknown>): ConnectionData {
  const conn: ConnectionData = {
    id: str(row.id),
    name: str(row.name),
    host: str(row.host),
    port: (row.port as number) ?? 22,
    username: str(row.username),
    protocol: typeof row.protocol === 'string' ? row.protocol : 'SSH',
    folder: (row.folder as string) ?? undefined,
    profileId: (row.profile_id as string) ?? undefined,
    createdAt: str(row.created_at),
    lastConnected: (row.last_connected as string) ?? undefined,
    favorite: !!row.favorite,
    color: (row.color as string) ?? undefined,
    description: (row.description as string) ?? undefined,
    authMethod: (row.auth_method as ConnectionData['authMethod']) ?? undefined,
    privateKeyPath: (row.private_key_path as string) ?? undefined,
    ftpsEnabled: !!row.ftps_enabled,
    proxyType: (row.proxy_type as ConnectionData['proxyType']) ?? undefined,
    proxyHost: (row.proxy_host as string) ?? undefined,
    proxyPort: (row.proxy_port as number) ?? undefined,
    proxyUsername: (row.proxy_username as string) ?? undefined,
    jumpHost: (row.jump_host as string) ?? undefined,
    jumpPort: (row.jump_port as number) ?? undefined,
    jumpUsername: (row.jump_username as string) ?? undefined,
    jumpUseKey: !!row.jump_use_key,
    defaultDirectory: (row.default_directory as string) ?? undefined,
    compression: !!row.compression,
    keepAlive: !!row.keep_alive,
    keepAliveInterval: (row.keep_alive_interval as number) ?? undefined,
    serverAliveCountMax: (row.server_alive_count_max as number) ?? undefined,
    domain: (row.domain as string) ?? undefined,
    rdpResolution: (row.rdp_resolution as string) ?? undefined,
    vncColorDepth: (row.vnc_color_depth as string) ?? undefined,
    sortOrder: (row.sort_order as number) ?? undefined,
  };
  if (row.tags) {
    try {
      conn.tags = JSON.parse(str(row.tags)) as string[];
    } catch {
      /* ignore */
    }
  }
  return conn;
}

async function persistConnection(c: ConnectionData): Promise<void> {
  const row = connToRow(c);
  row.password = await encField(c.password);
  row.passphrase = await encField(c.passphrase);
  row.proxy_password = await encField(c.proxyPassword);
  row.jump_password = await encField(c.jumpPassword);
  // NOT NULL column — never write null (0 = disabled), or the whole row upsert fails.
  row.jump_use_key = c.jumpUseKey ? 1 : 0;
  row.vnc_password = await encField(c.vncPassword);
  await rowUpsert('connections', row);
}

async function rowToConnDecrypted(row: Record<string, unknown>): Promise<ConnectionData> {
  const conn = rowToConn(row);
  conn.password = await decField(row.password as string);
  conn.passphrase = await decField(row.passphrase as string);
  conn.proxyPassword = await decField(row.proxy_password as string);
  conn.jumpPassword = await decField(row.jump_password as string);
  conn.vncPassword = await decField(row.vnc_password as string);
  return conn;
}

function folderToRow(f: ConnectionFolder): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    path: f.path,
    parent_path: f.parentPath ?? null,
    created_at: f.createdAt,
    sort_order: f.sortOrder ?? null,
  };
}

function rowToFolder(row: Record<string, unknown>): ConnectionFolder {
  return {
    id: str(row.id),
    name: str(row.name),
    path: str(row.path),
    parentPath: (row.parent_path as string) ?? undefined,
    createdAt: str(row.created_at),
    sortOrder: (row.sort_order as number) ?? undefined,
  };
}

async function persistFolder(f: ConnectionFolder): Promise<void> {
  await rowUpsert('folders', folderToRow(f));
}

/**
 * Hydrate the in-memory cache from SQLite. Called once after the app is
 * unlocked, before any application UI renders. Creates the default folder
 * structure when the store is completely empty. Never throws.
 */
export async function hydrateConnectionsStorage(): Promise<void> {
  try {
    const [cRows, fRows, aRows] = await Promise.all([
      rowList('connections'),
      rowList('folders'),
      rowList('active_connections'),
    ]);

    if (cRows.length > 0 || fRows.length > 0 || aRows.length > 0) {
      sqlCache = {
        connections: await Promise.all(cRows.map(rowToConnDecrypted)),
        folders: fRows.map(rowToFolder),
        active: aRows.map(rowToActive),
      };
      return;
    }

    // First run: empty store, create the default folder structure.
    sqlCache = {
      connections: [],
      folders: [],
      active: [],
    };
    createDefaultFolders();
    await persistAll();
  } catch {
    // SQLite unavailable (non-Tauri runtime): stay unhydrated.
    sqlCache = null;
  }
}

function createDefaultFolders(): void {
  if (!sqlCache) return;
  sqlCache.folders.push({
    id: crypto.randomUUID(),
    name: 'All Connections',
    path: 'All Connections',
    parentPath: undefined,
    createdAt: new Date().toISOString(),
  });
  sqlCache.folders.push({
    id: crypto.randomUUID(),
    name: 'Personal',
    path: 'All Connections/Personal',
    parentPath: 'All Connections',
    createdAt: new Date().toISOString(),
  });
  sqlCache.folders.push({
    id: crypto.randomUUID(),
    name: 'Work',
    path: 'All Connections/Work',
    parentPath: 'All Connections',
    createdAt: new Date().toISOString(),
  });
}

/** Persist every row of the cache (used after bulk edits). */
async function persistAll(): Promise<void> {
  if (!sqlCache) return;
  await Promise.all([
    Promise.all(sqlCache.connections.map(persistConnection)),
    Promise.all(sqlCache.folders.map(persistFolder)),
    Promise.all(sqlCache.active.map(persistActive)),
  ]);
}

/**
 * Notify UI listeners (ServersView, ConnectionManager) that the connection /
 * folder data changed, so they can reload without waiting for a
 * refreshTrigger prop from the parent. Dispatched synchronously after any
 * cache mutation — the in-memory cache is already up to date at that point.
 */
function notifyConnectionsChanged(): void {
  try {
    window.dispatchEvent(new Event('nexterm:connections-changed'));
  } catch {
    /* ignore */
  }
}

/** Persist the given connections list: update the cache, then flush to SQLite. */
function persistConnections(connections: ConnectionData[]): void {
  if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
  sqlCache.connections = connections;
  notifyConnectionsChanged();
  void persistAll();
}

/** Persist the given folders list: update the cache, then flush to SQLite. */
function persistFolders(folders: ConnectionFolder[]): void {
  if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
  sqlCache.folders = folders;
  notifyConnectionsChanged();
  void persistAll();
}

function persistBoth(connections: ConnectionData[], folders: ConnectionFolder[]): void {
  if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
  sqlCache.connections = connections;
  sqlCache.folders = folders;
  notifyConnectionsChanged();
  void persistAll();
}

export class ConnectionStorageManager {
  /**
   * Initialize default folder structure if not exists
   */
  static initialize(): void {
    const folders = this.getFolders();
    if (folders.length === 0) {
      this.createFolder('All Connections', undefined);
      this.createFolder('Personal', 'All Connections');
      this.createFolder('Work', 'All Connections');
    }
  }

  /**
   * Get all saved connections
   */
  static getConnections(): ConnectionData[] {
    if (sqlCache) return sqlCache.connections;
    return [];
  }

  /**
   * Get a single connection by ID
   */
  static getConnection(id: string): ConnectionData | undefined {
    const connections = this.getConnections();
    return connections.find(c => c.id === id);
  }

  /**
   * Get connections by folder path
   */
  static getConnectionsByFolder(folderPath: string): ConnectionData[] {
    const connections = this.getConnections();
    return connections.filter(c => c.folder === folderPath);
  }

  /**
   * Get all connections in a folder and its subfolders (recursive)
   */
  static getConnectionsByFolderRecursive(folderPath: string): ConnectionData[] {
    const connections = this.getConnections();
    return connections.filter(c => c.folder === folderPath || c.folder?.startsWith(folderPath + '/'));
  }

  /**
   * Get all subfolders recursively
   */
  static getSubfoldersRecursive(folderPath: string): ConnectionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.path.startsWith(folderPath + '/'));
  }

  /**
   * Save a new connection
   */
  static saveConnection(connection: Omit<ConnectionData, 'id' | 'createdAt'>): ConnectionData {
    const connections = this.getConnections();

    const newConnection: ConnectionData = {
      ...connection,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      folder: connection.folder || 'All Connections',
    };

    connections.push(newConnection);
    persistConnections(connections);

    return newConnection;
  }

  /**
   * Save a new connection with a specific ID
   * This is used to ensure the connection ID matches the tab ID for proper tracking
   */
  static saveConnectionWithId(id: string, connection: Omit<ConnectionData, 'id' | 'createdAt'>): ConnectionData {
    const connections = this.getConnections();

    // Check if connection with this ID already exists
    const existingIndex = connections.findIndex(c => c.id === id);

    const newConnection: ConnectionData = {
      ...connection,
      id,
      createdAt: new Date().toISOString(),
      lastConnected: new Date().toISOString(),
      folder: connection.folder || 'All Connections',
    };

    if (existingIndex !== -1) {
      // Update existing connection
      connections[existingIndex] = newConnection;
    } else {
      // Add new connection
      connections.push(newConnection);
    }

    persistConnections(connections);

    return newConnection;
  }

  /**
   * Update an existing connection
   */
  static updateConnection(id: string, updates: Partial<Omit<ConnectionData, 'id' | 'createdAt'>>): ConnectionData | null {
    const connections = this.getConnections();
    const index = connections.findIndex(c => c.id === id);

    if (index === -1) return null;

    connections[index] = {
      ...connections[index],
      ...updates,
    };

    persistConnections(connections);
    return connections[index];
  }

  /**
   * Update last connected timestamp
   */
  static updateLastConnected(id: string): void {
    this.updateConnection(id, {
      lastConnected: new Date().toISOString(),
    });
  }

  /**
   * Delete a connection
   */
  static deleteConnection(id: string): boolean {
    const connections = this.getConnections();
    const filtered = connections.filter(c => c.id !== id);

    if (filtered.length === connections.length) return false;

    if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
    sqlCache.connections = filtered;
    notifyConnectionsChanged();
    void rowDelete('connections', id);
    return true;
  }

  /**
   * Move connection to a different folder
   */
  static moveConnection(connectionId: string, newFolderPath: string): boolean {
    return this.updateConnection(connectionId, { folder: newFolderPath }) !== null;
  }

  /**
   * Reorder an item (folder or connection) to a specific position among same-type
   * siblings in the target parent. Also handles moving between parents.
   * The tree renders folders first, then connections — each group ordered by sortOrder.
   * @param itemId - ID of the folder or connection
   * @param itemType - 'folder' or 'connection'
   * @param targetParentPath - Parent folder path for the new position (undefined = root level)
   * @param newIndex - Position among same-type siblings in the target parent
   */
  static reorderItem(
    itemId: string,
    itemType: 'folder' | 'connection',
    targetParentPath: string | undefined,
    newIndex: number
  ): boolean {
    const folders = this.getFolders();
    const connections = this.getConnections();

    // Find the dragged item
    const folderIndex = itemType === 'folder' ? folders.findIndex(f => f.id === itemId) : -1;
    const connectionIndex = itemType === 'connection' ? connections.findIndex(c => c.id === itemId) : -1;

    if (folderIndex === -1 && connectionIndex === -1) return false;

    // Determine current parent path
    const currentParentPath = itemType === 'folder'
      ? folders[folderIndex].parentPath
      : connections[connectionIndex].folder || 'All Connections';

    const sameParent = currentParentPath === targetParentPath;

    // Get same-type siblings at a parent, sorted by sortOrder, optionally excluding an item
    const getTypeSiblings = (parentPath: string | undefined, type: 'folder' | 'connection', excludeId?: string) => {
      if (type === 'folder') {
        return folders
          .filter(f => f.parentPath === parentPath && f.id !== excludeId)
          .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
      }
      return connections
        .filter(c => (c.folder || 'All Connections') === (parentPath ?? 'All Connections') && c.id !== excludeId)
        .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    };

    // Re-assign sortOrder 0..n for a list of items
    const reindex = (items: { id: string }[], type: 'folder' | 'connection') => {
      items.forEach((entry, index) => {
        if (type === 'folder') {
          const f = folders.find(fo => fo.id === entry.id);
          if (f) f.sortOrder = index;
        } else {
          const c = connections.find(co => co.id === entry.id);
          if (c) c.sortOrder = index;
        }
      });
    };

    // Build target sibling list (excluding dragged item if same parent) and insert
    const siblings = getTypeSiblings(targetParentPath, itemType, sameParent ? itemId : undefined);
    const clampedIndex = Math.max(0, Math.min(newIndex, siblings.length));
    const ordered: { id: string }[] = [...siblings];
    ordered.splice(clampedIndex, 0, { id: itemId });
    reindex(ordered, itemType);

    // Update the dragged item's parent reference
    if (itemType === 'folder') {
      const folderName = folders[folderIndex].name;
      folders[folderIndex].parentPath = targetParentPath;
      folders[folderIndex].path = targetParentPath ? `${targetParentPath}/${folderName}` : folderName;
    } else {
      connections[connectionIndex].folder = targetParentPath ?? 'All Connections';
    }

    // If moved between parents, re-index the source parent's same-type group
    if (!sameParent) {
      const sourceSiblings = getTypeSiblings(currentParentPath, itemType, itemId);
      reindex(sourceSiblings, itemType);
    }

    persistBoth(connections, folders);
    return true;
  }

  /**
   * Rename a folder, rewriting the paths of all subfolders and the folder
   * references of all nested connections. The root folder cannot be renamed.
   * @param oldPath - Current full path of the folder
   * @param newName - New folder name (single segment, no '/')
   * @returns true if the rename succeeded
   */
  static renameFolder(oldPath: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed || trimmed.includes('/')) return false;

    const folders = this.getFolders();
    const connections = this.getConnections();
    const folder = folders.find(f => f.path === oldPath);
    if (!folder) return false;

    if (trimmed === folder.name) return true; // no-op

    const newPath = folder.parentPath ? `${folder.parentPath}/${trimmed}` : trimmed;
    // Name collision with another folder at the same level.
    if (folders.some(f => f.path === newPath && f.id !== folder.id)) return false;

    // Rename the folder itself.
    folder.name = trimmed;
    folder.path = newPath;
    // Rewrite paths for all subfolders.
    for (const f of folders) {
      if (f.id === folder.id) continue;
      if (f.path === oldPath) {
        f.path = newPath;
        f.parentPath = folder.parentPath;
      } else if (f.path.startsWith(oldPath + '/')) {
        f.path = newPath + f.path.substring(oldPath.length);
        if (f.parentPath === oldPath) {
          f.parentPath = newPath;
        } else if (f.parentPath?.startsWith(oldPath + '/')) {
          f.parentPath = newPath + f.parentPath.substring(oldPath.length);
        }
      }
    }
    // Rewrite folder references for all nested connections.
    for (const c of connections) {
      if (c.folder === oldPath) {
        c.folder = newPath;
      } else if (c.folder?.startsWith(oldPath + '/')) {
        c.folder = newPath + c.folder.substring(oldPath.length);
      }
    }

    persistBoth(connections, folders);
    return true;
  }

  /**
   * Move a folder (with all subfolders and nested connections) to a new parent.
   * @param folderPath - Current full path of the folder to move
   * @param newParentPath - New parent folder path (undefined = root level)
   * @returns true if the move succeeded
   */
  static moveFolderRecursive(folderPath: string, newParentPath: string | undefined): boolean {
    // Cannot move root folder
    if (folderPath === 'All Connections') return false;

    // Cannot move into itself or own subtree
    if (newParentPath === folderPath || newParentPath?.startsWith(folderPath + '/')) return false;

    const folders = this.getFolders();
    const connections = this.getConnections();

    const folder = folders.find(f => f.path === folderPath);
    if (!folder) return false;

    const newPath = newParentPath ? `${newParentPath}/${folder.name}` : folder.name;

    // No-op if already in the target parent
    if (folder.parentPath === newParentPath) return true;

    // Rewrite paths for all subfolders
    for (const f of folders) {
      if (f.path === folderPath) {
        f.path = newPath;
        f.parentPath = newParentPath;
      } else if (f.path.startsWith(folderPath + '/')) {
        f.path = newPath + f.path.substring(folderPath.length);
        if (f.parentPath === folderPath) {
          f.parentPath = newPath;
        } else if (f.parentPath?.startsWith(folderPath + '/')) {
          f.parentPath = newPath + f.parentPath.substring(folderPath.length);
        }
      }
    }

    // Rewrite folder references for all nested connections
    for (const c of connections) {
      if (c.folder === folderPath) {
        c.folder = newPath;
      } else if (c.folder?.startsWith(folderPath + '/')) {
        c.folder = newPath + c.folder.substring(folderPath.length);
      }
    }

    persistBoth(connections, folders);
    return true;
  }

  /**
   * Get all folders
   */
  static getFolders(): ConnectionFolder[] {
    if (sqlCache) return sqlCache.folders;
    return [];
  }

  /**
   * Create a new folder
   */
  static createFolder(name: string, parentPath?: string): ConnectionFolder {
    const folders = this.getFolders();

    const path = parentPath ? `${parentPath}/${name}` : name;

    // Check if folder already exists
    const existing = folders.find(f => f.path === path);
    if (existing) return existing;

    const newFolder: ConnectionFolder = {
      id: crypto.randomUUID(),
      name,
      path,
      parentPath,
      createdAt: new Date().toISOString(),
    };

    folders.push(newFolder);
    persistFolders(folders);

    return newFolder;
  }

  /**
   * Delete a folder and all its connections
   */
  static deleteFolder(path: string, deleteSubfolders: boolean = false): boolean {
    // Don't allow deleting root folder
    if (path === 'All Connections') return false;

    const folders = this.getFolders();
    const connections = this.getConnections();

    // Filter out the folder and optionally subfolders
    const filteredFolders = folders.filter(f => {
      if (f.path === path) return false;
      if (deleteSubfolders && f.path.startsWith(path + '/')) return false;
      return true;
    });

    // Filter out connections in the folder and optionally subfolders
    const filteredConnections = connections.filter(c => {
      if (c.folder === path) return false;
      if (deleteSubfolders && c.folder?.startsWith(path + '/')) return false;
      return true;
    });

    if (filteredFolders.length === folders.length) return false;

    if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
    const removedFolders = folders.filter(f => !filteredFolders.some(nf => nf.id === f.id));
    const removedConns = connections.filter(c => !filteredConnections.some(nc => nc.id === c.id));
    sqlCache.folders = filteredFolders;
    sqlCache.connections = filteredConnections;
    notifyConnectionsChanged();
    for (const f of removedFolders) void rowDelete('folders', f.id);
    for (const c of removedConns) void rowDelete('connections', c.id);

    return true;
  }

  /**
   * Get subfolders of a parent path
   */
  static getSubfolders(parentPath: string): ConnectionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.parentPath === parentPath);
  }

  /**
   * Get all valid folders that are part of the tree hierarchy
   * This excludes orphaned folders that don't have a valid parent chain
   */
  static getValidFolders(): ConnectionFolder[] {
    const allFolders = this.getFolders();
    const validPaths = new Set<string>();

    // Recursively collect valid folder paths starting from root
    const collectValidPaths = (parentPath?: string) => {
      const children = allFolders.filter(f => f.parentPath === parentPath);
      for (const child of children) {
        validPaths.add(child.path);
        collectValidPaths(child.path);
      }
    };

    collectValidPaths(undefined);

    return allFolders.filter(f => validPaths.has(f.path));
  }

  /**
   * Build hierarchical connection tree. Every connection is reachable: folder
   * nodes show their child folders AND their servers; connections stored at
   * the root level ("All Connections" / empty folder) are listed at the top.
   */
  static buildConnectionTree(activeConnections: Set<string> = new Set()): ConnectionTreeNode[] {
    const folders = this.getFolders();
    const connections = this.getConnections();

    const bySortOrder = <T extends { sortOrder?: number }>(items: T[]): T[] =>
      [...items].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));

    const toConnectionNode = (c: ConnectionData): ConnectionTreeNode => ({
      id: c.id,
      name: c.name,
      type: 'connection' as const,
      protocol: c.protocol,
      host: c.host,
      username: c.username,
      port: c.port,
      profileId: c.profileId,
      lastConnected: c.lastConnected,
      isConnected: activeConnections.has(c.id),
      favorite: c.favorite,
      color: c.color,
      tags: c.tags,
    });

    // Build folder hierarchy
    const buildFolderTree = (parentPath?: string): ConnectionTreeNode[] => {
      const result: ConnectionTreeNode[] = [];

      // Get direct subfolders sorted by sortOrder (stable)
      const subfolders = bySortOrder(folders.filter(f => f.parentPath === parentPath));

      for (const folder of subfolders) {
        const folderNode: ConnectionTreeNode = {
          id: folder.id,
          name: folder.name,
          type: 'folder',
          path: folder.path,
          isExpanded: true,
          children: [
            ...buildFolderTree(folder.path),
            ...bySortOrder(connections.filter(c => c.folder === folder.path)).map(toConnectionNode),
          ],
        };
        result.push(folderNode);
      }

      return result;
    };

    // Root level: connections that live directly under "All Connections"
    // (explicit folder, empty folder, or legacy connections without one),
    // plus any connection whose folder no longer exists (orphaned by a past
    // rename/move bug) — those must stay visible, never disappear from the
    // tree ("show the servers, not just the folders").
    const knownFolderPaths = new Set(folders.map(f => f.path));
    const rootConnections = bySortOrder(
      connections.filter(
        c => !c.folder || c.folder === 'All Connections' || !knownFolderPaths.has(c.folder),
      ),
    ).map(toConnectionNode);

    return [...buildFolderTree(undefined), ...rootConnections];
  }

  /**
   * Get favorite connections
   */
  static getFavorites(): ConnectionData[] {
    return this.getConnections().filter(c => c.favorite);
  }

  /**
   * Get recent connections (sorted by lastConnected)
   */
  static getRecentConnections(limit: number = 10): ConnectionData[] {
    const connections = this.getConnections();
    return connections
      .filter(c => c.lastConnected)
      .sort((a, b) => {
        const dateA = a.lastConnected ? new Date(a.lastConnected).getTime() : 0;
        const dateB = b.lastConnected ? new Date(b.lastConnected).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  /**
   * Export connections as JSON
   */
  static exportConnections(): string {
    const connections = this.getConnections();
    const folders = this.getFolders();
    return JSON.stringify({ connections, folders }, null, 2);
  }

  /**
   * Import connections from JSON
   */
  static importConnections(json: string, merge: boolean = false): number {
    try {
      const imported = JSON.parse(json) as {
        connections: ConnectionData[];
        folders?: ConnectionFolder[];
      };

      if (!imported.connections || !Array.isArray(imported.connections)) {
        throw new Error('Invalid JSON format');
      }

      const existingConnections = this.getConnections();
      const existingFolders = this.getFolders();
      const connections = merge ? existingConnections : [];
      const folders = merge ? existingFolders : [];

      // A replacement import must remove rows omitted by the archive; otherwise
      // they return after the next cache hydration.
      if (!merge) {
        for (const connection of existingConnections) void rowDelete('connections', connection.id);
        for (const folder of existingFolders) void rowDelete('folders', folder.id);
      }

      // Import folders with new IDs
      if (imported.folders) {
        imported.folders.forEach(folder => {
          if (!folders.find(f => f.path === folder.path)) {
            folders.push({
              ...folder,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            });
          }
        });
      }

      // Import connections with new IDs
      imported.connections.forEach(connection => {
        connections.push({
          ...connection,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        });
      });

      persistBoth(connections, folders);

      return imported.connections.length;
    } catch (error) {
      console.error('Failed to import connections:', error);
      throw error;
    }
  }

  /**
   * Clear all connections and folders (use with caution!)
   */
  static clearAll(): void {
    if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
    const removedConns = sqlCache.connections;
    const removedFolders = sqlCache.folders;
    sqlCache.connections = [];
    sqlCache.folders = [];
    sqlCache.active = [];
    notifyConnectionsChanged();
    for (const c of removedConns) void rowDelete('connections', c.id);
    for (const f of removedFolders) void rowDelete('folders', f.id);
    this.initialize();
  }
}

/**
 * Connection tree node structure for UI rendering
 */
export interface ConnectionTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  profileId?: string;
  lastConnected?: string;
  isConnected?: boolean;
  isExpanded?: boolean;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  children?: ConnectionTreeNode[];
}

/**
 * Active Connections Manager
 * Tracks currently open tabs for connection persistence
 */
export interface ActiveConnectionState {
  tabId: string;
  connectionId: string;
  order: number;
  originalConnectionId?: string; // For duplicated tabs, reference to the original connection
  tabType?: 'terminal' | 'file-browser' | 'desktop' | 'editor' | 'tools'; // Tab type for SFTP/FTP, RDP/VNC, SSH, remote file editing, or the Toolbox
  protocol?: string; // Protocol used (SSH, SFTP, FTP)
}

function activeToRow(a: ActiveConnectionState): Record<string, unknown> {
  return {
    tab_id: a.tabId,
    connection_id: a.connectionId,
    order_num: a.order,
    original_connection_id: a.originalConnectionId ?? null,
    tab_type: a.tabType ?? null,
    protocol: a.protocol ?? null,
  };
}

function rowToActive(row: Record<string, unknown>): ActiveConnectionState {
  return {
    tabId: str(row.tab_id),
    connectionId: str(row.connection_id),
    order: (row.order_num as number) ?? 0,
    originalConnectionId: (row.original_connection_id as string) ?? undefined,
    tabType: (row.tab_type as ActiveConnectionState['tabType']) ?? undefined,
    protocol: (row.protocol as string) ?? undefined,
  };
}

async function persistActive(a: ActiveConnectionState): Promise<void> {
  await rowUpsert('active_connections', activeToRow(a));
}

export class ActiveConnectionsManager {
  /**
   * Get active connection states
   */
  static getActiveConnections(): ActiveConnectionState[] {
    if (sqlCache) return sqlCache.active;
    return [];
  }

  /**
   * Save active connection states
   */
  static saveActiveConnections(connections: ActiveConnectionState[]): void {
    if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
    const removed = sqlCache.active.filter(a => !connections.some(n => n.tabId === a.tabId));
    sqlCache.active = connections;
    for (const a of connections) void persistActive(a);
    for (const a of removed) void rowDelete('active_connections', a.tabId);
  }

  /**
   * Clear active connections
   */
  static clearActiveConnections(): void {
    if (!sqlCache) sqlCache = { connections: [], folders: [], active: [] };
    for (const a of sqlCache.active) void rowDelete('active_connections', a.tabId);
    sqlCache.active = [];
  }
}
