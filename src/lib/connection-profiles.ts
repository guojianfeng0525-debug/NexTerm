/**
 * Connection Profile Management
 * Handles saving, loading, and managing SSH connection profiles
 *
 * Profiles may contain passwords, stored encrypted per-field (AES-GCM via the
 * app-password key) in the normalized `profiles` table — one row per profile.
 * The public API stays synchronous via an in-memory cache hydrated by
 * `hydrateConnectionProfiles()` after unlock.
 */
import { rowList, rowUpsert, rowDelete, encField, decField } from './toolbox/db';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password?: string; // Encrypted at rest via the SQLite store
  privateKey?: string;
  createdAt: string;
  updatedAt: string;
  favorite?: boolean;
  color?: string; // Optional color tag
  tags?: string[]; // Optional tags for organization
}

// In-memory cache; null until hydrateConnectionProfiles() completes. Writes
// through the manager always update the cache (so sync reads work) and are
// flushed to SQLite asynchronously.
let profileCache: ConnectionProfile[] | null = null;

export function isConnectionProfilesHydrated(): boolean {
  return profileCache !== null;
}

/** Reset the in-memory cache (used by tests for isolation). */
export function resetProfileCache(): void {
  profileCache = null;
}

function profileToRow(p: ConnectionProfile): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    auth_method: p.authMethod,
    private_key: p.privateKey ?? null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    favorite: p.favorite ? 1 : 0,
    color: p.color ?? null,
    tags: p.tags ? JSON.stringify(p.tags) : null,
  };
}

function rowToProfile(row: Record<string, unknown>): ConnectionProfile {
  const profile: ConnectionProfile = {
    id: str(row.id),
    name: str(row.name),
    host: str(row.host),
    port: (row.port as number) ?? 22,
    username: str(row.username),
    authMethod: (row.auth_method as ConnectionProfile['authMethod']) ?? 'password',
    privateKey: (row.private_key as string) ?? undefined,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    favorite: !!row.favorite,
    color: (row.color as string) ?? undefined,
  };
  if (row.tags) {
    try {
      profile.tags = JSON.parse(str(row.tags)) as string[];
    } catch {
      /* ignore */
    }
  }
  return profile;
}

async function persistProfile(p: ConnectionProfile): Promise<void> {
  const row = profileToRow(p);
  row.password = await encField(p.password);
  await rowUpsert('profiles', row);
}

/** Hydrate the profile cache from SQLite. */
export async function hydrateConnectionProfiles(): Promise<void> {
  try {
    const rows = await rowList('profiles');
    if (rows.length > 0) {
      profileCache = await Promise.all(
        rows.map(async (r) => {
          const p = rowToProfile(r);
          p.password = await decField(r.password as string);
          return p;
        }),
      );
    } else {
      profileCache = [];
    }
  } catch {
    profileCache = [];
  }
}

async function persistAll(): Promise<void> {
  if (!profileCache) return;
  await Promise.all(profileCache.map(persistProfile));
}

/** Persist the given list: update the cache and flush to SQLite. */
function persistProfiles(profiles: ConnectionProfile[]): void {
  profileCache = profiles;
  void persistAll();
}

export class ConnectionProfileManager {
  /**
   * Get all saved connection profiles
   */
  static getProfiles(): ConnectionProfile[] {
    if (profileCache) return profileCache;
    return [];
  }

  /**
   * Get a single profile by ID
   */
  static getProfile(id: string): ConnectionProfile | undefined {
    const profiles = this.getProfiles();
    return profiles.find(p => p.id === id);
  }

  /**
   * Save a new connection profile
   */
  static saveProfile(profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>): ConnectionProfile {
    const profiles = this.getProfiles();

    const newProfile: ConnectionProfile = {
      ...profile,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    profiles.push(newProfile);
    persistProfiles(profiles);

    return newProfile;
  }

  /**
   * Update an existing profile
   */
  static updateProfile(id: string, updates: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>): ConnectionProfile | null {
    const profiles = this.getProfiles();
    const index = profiles.findIndex(p => p.id === id);

    if (index === -1) return null;

    profiles[index] = {
      ...profiles[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    persistProfiles(profiles);
    return profiles[index];
  }

  /**
   * Delete a profile
   */
  static deleteProfile(id: string): boolean {
    const profiles = this.getProfiles();
    const filtered = profiles.filter(p => p.id !== id);

    if (filtered.length === profiles.length) return false;

    profileCache = filtered;
    void rowDelete('profiles', id);
    return true;
  }

  /**
   * Export profiles as JSON
   */
  static exportProfiles(): string {
    const profiles = this.getProfiles();
    return JSON.stringify(profiles, null, 2);
  }

  /**
   * Import profiles from JSON
   */
  static importProfiles(json: string, merge: boolean = false): number {
    try {
      const imported = JSON.parse(json) as ConnectionProfile[];

      if (!Array.isArray(imported)) {
        throw new Error('Invalid JSON format');
      }

      const profiles = merge ? this.getProfiles() : [];

      // Add imported profiles with new IDs to avoid conflicts
      imported.forEach(profile => {
        profiles.push({
          ...profile,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });

      persistProfiles(profiles);
      return imported.length;
    } catch (error) {
      console.error('Failed to import profiles:', error);
      throw error;
    }
  }

  /**
   * Get favorite profiles
   */
  static getFavorites(): ConnectionProfile[] {
    return this.getProfiles().filter(p => p.favorite);
  }

  /**
   * Get profiles by tag
   */
  static getProfilesByTag(tag: string): ConnectionProfile[] {
    return this.getProfiles().filter(p => p.tags?.includes(tag));
  }

  /**
   * Get all unique tags
   */
  static getAllTags(): string[] {
    const profiles = this.getProfiles();
    const tags = new Set<string>();

    profiles.forEach(p => {
      p.tags?.forEach(tag => tags.add(tag));
    });

    return Array.from(tags).sort();
  }

  /**
   * Clear all profiles (use with caution!)
   */
  static clearAll(): void {
    const removed = profileCache ?? [];
    profileCache = [];
    for (const p of removed) void rowDelete('profiles', p.id);
  }
}
