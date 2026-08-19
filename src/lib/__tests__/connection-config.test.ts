/**
 * Regression: `toConnectionConfig` must carry every persisted field back into
 * the edit dialog — jump host and default directory were dropped, so a saved
 * connection "lost" its jump config and working directory when edited.
 */
import { describe, expect, it } from 'vitest';
import { toConnectionConfig } from '../connection-config';
import type { ConnectionData } from '../connection-storage';

describe('toConnectionConfig', () => {
  it('round-trips jump host + default directory for editing', () => {
    const data: ConnectionData = {
      id: 'conn-1',
      name: 'Target',
      host: '10.0.0.50',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      createdAt: '2026-01-01T00:00:00.000Z',
      authMethod: 'password',
      password: 'target-pass',
      jumpHost: 'bastion.example.com',
      jumpPort: 2222,
      jumpUsername: 'jumpuser',
      jumpPassword: 'jump-secret',
      jumpUseKey: false,
      defaultDirectory: '/srv/data',
    };

    const cfg = toConnectionConfig(data);
    expect(cfg.jumpHost).toBe('bastion.example.com');
    expect(cfg.jumpPort).toBe(2222);
    expect(cfg.jumpUsername).toBe('jumpuser');
    expect(cfg.jumpPassword).toBe('jump-secret');
    expect(cfg.jumpUseKey).toBe(false);
    expect(cfg.defaultDirectory).toBe('/srv/data');
  });

  it('defaults jump port to 22 when missing', () => {
    const data: ConnectionData = {
      id: 'conn-2',
      name: 'T',
      host: 'h',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      createdAt: '2026-01-01T00:00:00.000Z',
      jumpHost: 'jump.local',
    };
    expect(toConnectionConfig(data).jumpPort).toBe(22);
  });

  it('defaults jumpUseKey to undefined when not stored', () => {
    const data: ConnectionData = {
      id: 'conn-3',
      name: 'T',
      host: 'h',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(toConnectionConfig(data).jumpUseKey).toBeUndefined();
    expect(toConnectionConfig(data).defaultDirectory).toBeUndefined();
  });
});
