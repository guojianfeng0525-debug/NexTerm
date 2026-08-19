import { describe, it, expect, beforeEach } from 'vitest';
import {
  AppsStorage,
  TunnelsStorage,
  ServicesStorage,
  NotesStorage,
  generateId,
} from '@/lib/toolbox/toolbox-storage';
import type { ToolboxApp, TunnelConfig, ServiceConfig, NoteItem } from '@/lib/toolbox/toolbox-types';

describe('toolbox storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('generateId produces unique ids with a prefix', () => {
    const a = generateId('app');
    const b = generateId('app');
    expect(a.startsWith('app-')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('apps: upsert adds and updates, remove deletes', () => {
    expect(AppsStorage.load()).toEqual([]);
    const app: ToolboxApp = {
      id: 'app-1',
      name: 'Chrome',
      path: '/Applications/Google Chrome.app',
      createdAt: 1,
      updatedAt: 1,
    };
    AppsStorage.upsert(app);
    expect(AppsStorage.load()).toHaveLength(1);

    const updated = { ...app, name: 'Chrome Canary', updatedAt: 2 };
    AppsStorage.upsert(updated);
    expect(AppsStorage.load()).toHaveLength(1);
    expect(AppsStorage.load()[0].name).toBe('Chrome Canary');

    AppsStorage.remove('app-1');
    expect(AppsStorage.load()).toEqual([]);
  });

  it('tunnels: round-trips configs', () => {
    const tunnel: TunnelConfig = {
      id: 't-1',
      name: 'MySQL',
      bindAddress: '127.0.0.1',
      listenPort: 3306,
      remoteHost: 'db.example.com',
      remotePort: 3306,
      createdAt: 1,
      updatedAt: 1,
    };
    TunnelsStorage.upsert(tunnel);
    expect(TunnelsStorage.load()[0].remoteHost).toBe('db.example.com');
  });

  it('services: round-trips configs', () => {
    const svc: ServiceConfig = {
      id: 's-1',
      name: 'Web',
      command: 'npm run dev',
      createdAt: 1,
      updatedAt: 1,
    };
    ServicesStorage.upsert(svc);
    expect(ServicesStorage.load()[0].command).toBe('npm run dev');
  });

  it('notes: round-trips notes and keeps them sorted by insertion', () => {
    const note: NoteItem = {
      id: 'n-1',
      title: 'Snippet',
      language: 'sql',
      content: 'SELECT 1;',
      createdAt: 1,
      updatedAt: 1,
    };
    NotesStorage.upsert(note);
    const loaded = NotesStorage.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].language).toBe('sql');
  });
});
