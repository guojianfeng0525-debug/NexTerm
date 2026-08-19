/**
 * Records notebook Excel import/export.
 *
 * Import requires the designated template — the first row must contain the
 * "名称" (Name) header. Any file without that header is rejected so arbitrary
 * spreadsheets cannot be imported.
 */
import * as XLSX from 'xlsx';

/** Column definition: header text (zh) + fallback english header + field key. */
interface ColumnDef {
  key: string;
  headers: string[];
  required?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: 'name', headers: ['名称', 'Name'], required: true },
  { key: 'address', headers: ['地址', 'Address', 'URL'] },
  { key: 'username', headers: ['用户名', 'Username', '账号', 'Account'] },
  { key: 'password', headers: ['密码', 'Password'] },
  { key: 'category', headers: ['分类', 'Category'] },
  { key: 'notes', headers: ['备注', 'Notes', 'Note'] },
  { key: 'favorite', headers: ['收藏', 'Favorite'] },
];

export interface VaultExcelRow {
  name: string;
  address: string;
  username: string;
  password: string;
  category: string;
  notes: string;
  favorite: boolean;
}

const HEADER_ROW = COLUMNS.map((c) => c.headers[0]);

/** Normalize a header cell for comparison. */
function normalizeHeader(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Find the column index for a field, or undefined if absent. */
function findColumn(headers: unknown[]): Record<string, number | undefined> {
  const map: Record<string, number | undefined> = {};
  headers.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    for (const col of COLUMNS) {
      if (col.headers.some((h) => h.toLowerCase() === normalized)) {
        map[col.key] = index;
      }
    }
  });
  return map;
}

function parseFavorite(value: unknown): boolean {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s === '是' || s === 'yes' || s === 'true' || s === '1' || s === 'y' || s === '收藏';
}

/**
 * Parse an Excel/CSV workbook into rows. Throws if the required "名称" header
 * is missing.
 */
export function parseVaultExcel(data: Uint8Array | ArrayBuffer): VaultExcelRow[] {
  const workbook = XLSX.read(data, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('empty workbook');
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });

  if (rows.length === 0) throw new Error('empty sheet');

  const headers = rows[0];
  const colMap = findColumn(headers);
  if (colMap.name === undefined) {
    throw new Error('missing required "名称" header');
  }

  const result: VaultExcelRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (key: string): string => {
      const idx = colMap[key];
      if (idx === undefined) return '';
      const raw = row[idx];
      return typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    };
    const name = cell('name');
    if (!name) continue; // skip empty rows
    result.push({
      name,
      address: cell('address'),
      username: cell('username'),
      password: cell('password'),
      category: cell('category'),
      notes: cell('notes'),
      favorite: colMap.favorite !== undefined ? parseFavorite(row[colMap.favorite]) : false,
    });
  }
  return result;
}

/** Build a workbook (Uint8Array) from rows for export. */
export function buildVaultExcel(rows: VaultExcelRow[]): Uint8Array {
  const aoa: unknown[][] = [HEADER_ROW];
  for (const row of rows) {
    aoa.push([
      row.name,
      row.address,
      row.username,
      row.password,
      row.category,
      row.notes,
      row.favorite ? '是' : '否',
    ]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '记录本');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

/** Build the empty template workbook (header + one example row). */
export function buildVaultTemplate(): Uint8Array {
  return buildVaultExcel([
    {
      name: '示例：GitHub',
      address: 'https://github.com',
      username: 'user',
      password: 'password',
      category: '工作',
      notes: '示例记录，导入前可删除本行',
      favorite: false,
    },
  ]);
}
