/**
 * Virtual connection grouping (B22). A group is just the profile's `group`
 * field value; the navigator renders connections under group headers. There
 * is no separate group entity — renaming/deleting a group edits the field on
 * its member connections.
 */
import type { DatabaseConnectionProfile } from "./profile-types";

export interface ConnectionGroup<TProfile = DatabaseConnectionProfile<string, unknown>> {
  /** Group name; null represents the "ungrouped" bucket (always last). */
  readonly groupName: string | null;
  readonly connections: readonly TProfile[];
}

/**
 * Groups profiles by their `group` field. Grouped connections sort by group
 * name (case-insensitive); members sort by name; the ungrouped bucket always
 * renders last.
 */
export function groupConnectionsByGroup<
  TProfile extends DatabaseConnectionProfile<string, unknown>,
>(profiles: readonly TProfile[]): readonly ConnectionGroup<TProfile>[] {
  const groups = new Map<string, TProfile[]>();
  const ungrouped: TProfile[] = [];

  for (const profile of profiles) {
    const group = profile.group?.trim();
    if (group) {
      const list = groups.get(group);
      if (list) list.push(profile);
      else groups.set(group, [profile]);
    } else {
      ungrouped.push(profile);
    }
  }

  const byName = (a: TProfile, b: TProfile) => a.name.localeCompare(b.name);
  const sortedGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([groupName, connections]) => ({
      groupName,
      connections: [...connections].sort(byName),
    }));

  return [
    ...sortedGroups,
    ...(ungrouped.length ? [{ groupName: null, connections: [...ungrouped].sort(byName) }] : []),
  ];
}

/** Distinct group names from profiles, sorted, for the group-input datalist. */
export function listConnectionGroupNames(
  profiles: readonly DatabaseConnectionProfile<string, unknown>[],
): readonly string[] {
  const names = new Set<string>();
  for (const profile of profiles) {
    const group = profile.group?.trim();
    if (group) names.add(group);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
