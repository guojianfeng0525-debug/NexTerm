import { describe, expect, it } from 'vitest';
import { isSensitiveCommand } from '../suggestion/sensitive';
import { connectionScope, cwdScope, stableHash } from '../suggestion/store';

describe('suggestion sensitive filter', () => {
  it('rejects commands carrying obvious credentials', () => {
    expect(isSensitiveCommand('curl -H "Authorization: Bearer xxxxx"')).toBe(true);
    expect(isSensitiveCommand('mysql -u root -p s3cr3t')).toBe(true);
    expect(isSensitiveCommand('export AWS_SECRET_ACCESS_KEY=abc')).toBe(true);
    expect(isSensitiveCommand('sshpass -p p@ss scp a b')).toBe(true);
    expect(isSensitiveCommand('kubectl create secret generic my-secret --from-literal=key=val')).toBe(true);
    expect(isSensitiveCommand('passwd')).toBe(true);
  });

  it('allows ordinary commands', () => {
    expect(isSensitiveCommand('git status')).toBe(false);
    expect(isSensitiveCommand('systemctl start nginx')).toBe(false);
    expect(isSensitiveCommand('docker ps -a')).toBe(false);
    expect(isSensitiveCommand('ls -la /opt/project')).toBe(false);
    expect(isSensitiveCommand('npm run dev')).toBe(false);
  });

  it('does not block harmless pwd / -p usage, still blocks credential flags', () => {
    expect(isSensitiveCommand('pwd')).toBe(false);
    expect(isSensitiveCommand('mkdir -p /var/log/app')).toBe(false);
    expect(isSensitiveCommand('ssh -p 2222 user@host')).toBe(false);
    expect(isSensitiveCommand('scp -P 2222 a b')).toBe(false);
    // Password-carrying short flags on known credential commands ARE blocked.
    expect(isSensitiveCommand('mysql -u root -p s3cr3t')).toBe(true);
    expect(isSensitiveCommand('sshpass -p p@ss scp a b')).toBe(true);
    expect(isSensitiveCommand('mysqldump -uroot -pSecret db')).toBe(true);
    expect(isSensitiveCommand('ls -la --token xyz')).toBe(true);
  });
});

describe('suggestion scope keys', () => {
  it('connection scope is a stable hash of the connection id', () => {
    const a = connectionScope('conn-123');
    const b = connectionScope('conn-123');
    expect(a).toBe(b);
    expect(a.startsWith('C:')).toBe(true);
    expect(connectionScope('conn-456')).not.toBe(a);
  });

  it('cwd scope uses the FULL normalized path hash, not the basename', () => {
    // Two different full paths with the same basename must NOT collide.
    const key1 = cwdScope('/opt/project-a')!;
    const key2 = cwdScope('/srv/project-a')!;
    expect(key1).not.toBe(key2);
    expect(key1.startsWith('D:')).toBe(true);
    // Stable across calls.
    expect(cwdScope('/opt/project-a')).toBe(key1);
    // Normalisation: backslashes unify to forward slashes on any platform.
    expect(cwdScope('C:\\Users\\me\\proj')).toBe(cwdScope('C:/Users/me/proj'));
    // Empty / undefined paths yield no scope key.
    expect(cwdScope('')).toBeNull();
    expect(cwdScope('   ')).toBeNull();
    expect(cwdScope(undefined)).toBeNull();
  });

  it('stableHash is deterministic and compact', () => {
    expect(stableHash('/a/very/long/path/that/keeps/going')).toBe(stableHash('/a/very/long/path/that/keeps/going'));
    expect(stableHash('x').length).toBeLessThan(12);
  });
});
