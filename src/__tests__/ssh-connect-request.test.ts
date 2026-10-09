import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSshConnectRequest, type SshConnectRequestSource } from '../lib/ssh-connect-request';

const defaults = vi.hoisted(() => ({ interval: 15 }));
vi.mock('../lib/preferences', () => ({
  prefGet: () => ({ keepAliveInterval: defaults.interval }),
}));
beforeEach(() => { defaults.interval = 15; });

const baseSource: SshConnectRequestSource = {
  host: 'example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  password: 'secret',
};

describe('buildSshConnectRequest', () => {
  it('sends basic credentials with connection defaults', () => {
    const req = buildSshConnectRequest('conn-1', baseSource);

    expect(req.connection_id).toBe('conn-1');
    expect(req.host).toBe('example.com');
    expect(req.port).toBe(22);
    expect(req.username).toBe('alice');
    expect(req.auth_method).toBe('password');
    expect(req.password).toBe('secret');
    expect(req.key_path).toBeNull();
    expect(req.passphrase).toBeNull();
  });

  it('keeps an intentionally empty password instead of sending null', () => {
    // A blank password must round-trip as `""` so the backend attempts
    // password auth with an empty value (some servers allow blank passwords)
    // instead of failing with "Password required".
    const req = buildSshConnectRequest('conn-1', { ...baseSource, password: '' });

    expect(req.password).toBe('');
  });

  it('applies default advanced settings matching the UI (keepalive 15/20, no proxy)', () => {
    const req = buildSshConnectRequest('conn-1', baseSource);

    expect(req.keepalive_enabled).toBe(true);
    expect(req.keepalive_interval).toBe(15);
    expect(req.keepalive_max).toBe(20);
    expect(req.proxy_type).toBe('none');
    expect(req.proxy_host).toBeNull();
    expect(req.proxy_port).toBeNull();
    expect(req.proxy_username).toBeNull();
    expect(req.proxy_password).toBeNull();
  });

  it('inherits the global interval unless the connection overrides it', () => {
    defaults.interval = 25;
    expect(buildSshConnectRequest('conn-1', baseSource).keepalive_interval).toBe(25);
    expect(buildSshConnectRequest('conn-1', { ...baseSource, keepAliveInterval: 10 }).keepalive_interval).toBe(10);
  });

  it('replaces invalid heartbeat values instead of disabling or spinning', () => {
    defaults.interval = 0;
    const req = buildSshConnectRequest('conn-1', { ...baseSource, keepAliveInterval: NaN, serverAliveCountMax: 0 });
    expect(req.keepalive_interval).toBe(15);
    expect(req.keepalive_max).toBe(20);
  });

  it('supports a five second interval and enforces that minimum', () => {
    defaults.interval = 5;
    expect(buildSshConnectRequest('conn-1', baseSource).keepalive_interval).toBe(5);
    expect(buildSshConnectRequest('conn-1', { ...baseSource, keepAliveInterval: 5 }).keepalive_interval).toBe(5);
    expect(buildSshConnectRequest('conn-1', { ...baseSource, keepAliveInterval: 2 }).keepalive_interval).toBe(5);
  });

  it('forwards custom advanced settings', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      keepAlive: true,
      keepAliveInterval: 30,
      serverAliveCountMax: 5,
    });

    expect(req.keepalive_enabled).toBe(true);
    expect(req.keepalive_interval).toBe(30);
    expect(req.keepalive_max).toBe(5);
  });

  it('disables keepalive when the keepAlive toggle is off', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      keepAlive: false,
    });

    expect(req.keepalive_enabled).toBe(false);
    expect(req.keepalive_interval).toBeNull();
    expect(req.keepalive_max).toBeNull();
  });

  it('sends the proxy fields when a proxy type is selected', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      proxyType: 'socks5',
      proxyHost: 'proxy.local',
      proxyPort: 1080,
      proxyUsername: 'proxy-user',
      proxyPassword: 'proxy-pass',
    });

    expect(req.proxy_type).toBe('socks5');
    expect(req.proxy_host).toBe('proxy.local');
    expect(req.proxy_port).toBe(1080);
    expect(req.proxy_username).toBe('proxy-user');
    expect(req.proxy_password).toBe('proxy-pass');
  });

  it('sends null proxy fields when no proxy type is selected', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      proxyType: 'none',
      proxyHost: 'proxy.local',
      proxyPort: 1080,
    });

    expect(req.proxy_type).toBe('none');
    expect(req.proxy_host).toBeNull();
    expect(req.proxy_port).toBeNull();
  });

  it('defaults keepalive numbers when only the toggle is set', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      keepAlive: true,
    });

    expect(req.keepalive_enabled).toBe(true);
    expect(req.keepalive_interval).toBe(15);
    expect(req.keepalive_max).toBe(20);
  });

  it('falls back to port 22 and password auth for partial sources', () => {
    const req = buildSshConnectRequest('conn-1', {
      host: 'example.com',
      port: 0,
      username: '',
    });

    expect(req.port).toBe(22);
    expect(req.auth_method).toBe('password');
    expect(req.username).toBe('');
  });
});

describe('buildSshConnectRequest - jump host', () => {
  it('sends null jump fields when no jump host is configured', () => {
    const req = buildSshConnectRequest('conn-1', baseSource);

    expect(req.jump_host).toBeNull();
    expect(req.jump_port).toBeNull();
    expect(req.jump_username).toBeNull();
    expect(req.jump_password).toBeNull();
    expect(req.jump_use_key).toBe(false);
  });

  it('sends jump fields with password auth when a jump host is set', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      jumpHost: 'bastion.example.com',
      jumpPort: 2222,
      jumpUsername: 'jumpuser',
      jumpPassword: 'jumppass',
    });

    expect(req.jump_host).toBe('bastion.example.com');
    expect(req.jump_port).toBe(2222);
    expect(req.jump_username).toBe('jumpuser');
    expect(req.jump_password).toBe('jumppass');
    expect(req.jump_use_key).toBe(false);
  });

  it('omits the jump password and flags key reuse when jumpUseKey is set', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      jumpHost: 'bastion.example.com',
      jumpUsername: 'jumpuser',
      jumpPassword: 'ignored',
      jumpUseKey: true,
    });

    expect(req.jump_host).toBe('bastion.example.com');
    expect(req.jump_port).toBe(22);
    expect(req.jump_password).toBeNull();
    expect(req.jump_use_key).toBe(true);
  });

  it('ignores empty jump host (treated as disabled)', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      jumpHost: '   ',
      jumpUsername: 'jumpuser',
    });

    expect(req.jump_host).toBeNull();
    expect(req.jump_use_key).toBe(false);
  });
});
