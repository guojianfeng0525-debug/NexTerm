import { describe, expect, it } from 'vitest';
import { isDirectRemoteChild, isFileEntryName, remoteDeleteParent } from '../file-deletion';

describe('Remote deletion target validation', () => {
  it.each(['/', '', 'relative/path', '/srv/../file', '/srv/./file', '/srv//file', '/srv/file/', '/srv/file\0'])('rejects unsafe path %j', path => {
    expect(remoteDeleteParent(path)).toBeNull();
  });
  it('accepts exact filenames without collapsing whitespace', () => {
    expect(isDirectRemoteChild('/srv/a  b\tc.txt  ', '/srv/')).toBe(true);
    expect(isDirectRemoteChild("/srv/a'b.txt", '/srv')).toBe(true);
    expect(isDirectRemoteChild('/file', '/')).toBe(true);
  });
  it('refuses parents and descendants outside the displayed directory', () => {
    expect(isDirectRemoteChild('/srv', '/srv/app')).toBe(false);
    expect(isDirectRemoteChild('/srv/app/child/file', '/srv/app')).toBe(false);
    expect(isDirectRemoteChild('/other/file', '/srv/app')).toBe(false);
  });
  it.each(['.', '..', '', 'child/file', 'file\0'])('rejects navigation and invalid entry %j', name => {
    expect(isFileEntryName(name)).toBe(false);
  });
});
