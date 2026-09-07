import { describe, expect, it } from 'vitest';
import { canBeJumpHost, selectJumpHostCandidates } from '../jump-host';

describe('jump-host candidates', () => {
  it('accepts direct SSH/SFTP servers only', () => {
    expect(canBeJumpHost({ protocol: 'SSH', jumpHost: undefined })).toBe(true);
    expect(canBeJumpHost({ protocol: 'sftp', jumpHost: '' })).toBe(true);
    expect(canBeJumpHost({ protocol: 'RDP', jumpHost: undefined })).toBe(false);
  });

  it('rejects servers that themselves require another jump host', () => {
    expect(canBeJumpHost({ protocol: 'SSH', jumpHost: 'bastion.internal' })).toBe(false);
    expect(canBeJumpHost({ protocol: 'SSH', jumpHost: '  ' })).toBe(true);
  });

  it('filters and excludes candidates in one pass', () => {
    const candidates = selectJumpHostCandidates(
      [
        { id: 'direct-a', protocol: 'SSH', jumpHost: undefined },
        { id: 'via-jump', protocol: 'SSH', jumpHost: 'bastion.internal' },
        { id: 'editing', protocol: 'SFTP', jumpHost: undefined },
        { id: 'rdp', protocol: 'RDP', jumpHost: undefined },
      ],
      'editing',
    );
    expect(candidates.map((item) => item.id)).toEqual(['direct-a']);
  });
});
