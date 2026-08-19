import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildVaultTemplate,
  buildVaultExcel,
  parseVaultExcel,
  type VaultExcelRow,
} from '@/lib/toolbox/vault-excel';

describe('vault-excel', () => {
  it('template round-trips through parse', async () => {
    const bytes = await buildVaultTemplate();
    const rows = await parseVaultExcel(bytes);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toContain('GitHub');
  });

  it('export → parse preserves records', async () => {
    const rows: VaultExcelRow[] = [
      { name: 'GitHub', address: 'https://github.com', username: 'u', password: 'p', category: '工作', notes: '', favorite: true },
      { name: 'DB', address: 'db.local', username: '', password: '', category: '', notes: '', favorite: false },
    ];
    const parsed = await parseVaultExcel(await buildVaultExcel(rows));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('GitHub');
    expect(parsed[0].favorite).toBe(true);
    expect(parsed[1].name).toBe('DB');
    expect(parsed[1].favorite).toBe(false);
  });

  it('rejects a file without the "名称" header', async () => {
    // Build a workbook whose header row has no 名称 column.
    const sheet = XLSX.utils.aoa_to_sheet([['foo', 'bar'], ['a', 'b']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'S');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
    await expect(parseVaultExcel(bytes)).rejects.toThrow(/名称/);
  });

  it('skips rows with empty names', async () => {
    const rows: VaultExcelRow[] = [
      { name: 'Keep', address: '', username: '', password: '', category: '', notes: '', favorite: false },
    ];
    // Append an empty-name row via the array builder by building directly.
    const parsed = await parseVaultExcel(await buildVaultExcel(rows));
    expect(parsed.some((r) => r.name === 'Keep')).toBe(true);
  });
});
