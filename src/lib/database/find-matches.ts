/** Coordinates of a cell whose raw value matches the find text. */
export interface FindCellMatch {
  readonly row: number;
  readonly column: number;
}

/**
 * Case-insensitive `contains` over raw cell values. NULL cells never match
 * (B-6). Empty find text yields no matches.
 */
export function findCellMatches(
  rows: readonly (readonly (string | null)[])[],
  text: string,
): FindCellMatch[] {
  if (!text) return [];
  const needle = text.toLowerCase();
  const matches: FindCellMatch[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (cell !== null && cell.toLowerCase().includes(needle)) {
        matches.push({ row: rowIndex, column: columnIndex });
      }
    });
  });
  return matches;
}

/** Advances to the next match, wrapping around (B-2). */
export function nextFindIndex(current: number, total: number): number {
  if (total === 0) return 0;
  return (current + 1) % total;
}

/** Steps back to the previous match, wrapping around. */
export function previousFindIndex(current: number, total: number): number {
  if (total === 0) return 0;
  return (current - 1 + total) % total;
}
