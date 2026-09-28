/** Three-way reconciliation of immutable cache rows; no storage or UI effects. */
export function reconcileRows<T extends { id: string }>(
  before: readonly T[],
  fresh: readonly T[],
  current: readonly T[],
): { items: T[]; rebased: T[] } {
  if (current === before) return { items: [...fresh], rebased: [] };

  const previous = new Map(before.map(row => [row.id, row]));
  const incoming = new Map(fresh.map(row => [row.id, row]));
  const currentIds = new Set(current.map(row => row.id));
  const items: T[] = [];
  const rebased: T[] = [];

  for (const row of current) {
    const old = previous.get(row.id);
    const next = incoming.get(row.id);
    if (row === old) {
      if (next) items.push(next);
    } else if (!old || !next) {
      items.push(row);
    } else {
      // Apply only fields changed locally while the async operation ran.
      const changed = Object.fromEntries(Object.entries(row)
        .filter(([key, value]) => value !== (old as Record<string, unknown>)[key]));
      const merged = { ...next, ...changed };
      items.push(merged);
      rebased.push(merged);
    }
  }
  for (const row of fresh) {
    // Missing existing rows were deleted locally. Only genuinely new rows
    // from the incoming snapshot may be appended.
    if (!previous.has(row.id) && !currentIds.has(row.id)) items.push(row);
  }
  return { items, rebased };
}
