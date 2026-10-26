/**
 * The Settings dialog's entries (the left column), apart from React and Vite (pure, no imports, so a
 * test reads it as it is): one per section, or one for every section of the same `entry`, each such
 * section a part of it, shown one after another. Each part is its own component's and edits only its own
 * settings: Agents is runtime-pi's agents of the code and agents-live's agents made here; Routing,
 * router-rules' rules and router-basic's default agent.
 */

/** What a section says of itself that places it (`SettingsSectionDefinition`'s). */
export interface Placed {
  id: string;
  title: string;
  group?: string;
  order?: number;
  keywords?: string[];
  /** The entry it is a part of; its own id when not given. */
  entry?: string;
}

/** An entry: its parts, in order; its title, icon and group the first part's, its order the lowest. */
export interface Entry<T extends Placed> {
  id: string;
  title: string;
  group: string;
  order: number;
  /** Every part's title, id and keywords: the search finds the entry by any of its parts. */
  keywords: string[];
  parts: T[];
}

/** The groups listed first, in this order; any other after them, by name. */
export const GROUPS = ["Dashboard", "Agents", "Components"];

export const groupOf = (section: Pick<Placed, "group">): string => section.group ?? "Components";

/** By group (`GROUPS` first), then order (default 100), then title. */
export function byOrder(a: Pick<Placed, "group" | "order" | "title">, b: Pick<Placed, "group" | "order" | "title">): number {
  const rank = (group: string) => (GROUPS.includes(group) ? GROUPS.indexOf(group) : GROUPS.length);
  return rank(groupOf(a)) - rank(groupOf(b)) || groupOf(a).localeCompare(groupOf(b)) || (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);
}

/** `sections` as entries: those of one `entry` together, its parts by order, then the entries by order. */
export function entriesOf<T extends Placed>(sections: readonly T[]): Entry<T>[] {
  const byEntry = new Map<string, T[]>();
  for (const section of sections) {
    const id = section.entry ?? section.id;
    byEntry.set(id, [...(byEntry.get(id) ?? []), section]);
  }
  return [...byEntry]
    .map(([id, unordered]): Entry<T> => {
      const parts = [...unordered].sort(byOrder);
      const first = parts[0] as T;
      return {
        id,
        title: first.title,
        group: groupOf(first),
        order: Math.min(...parts.map((part) => part.order ?? 100)),
        keywords: [...new Set(parts.flatMap((part) => [part.title, part.id, ...(part.keywords ?? [])]))],
        parts,
      };
    })
    .sort(byOrder);
}

/** The entry holding `id`, a part's id or an entry's own: a section opens another by its component's name. */
export function entryIdOf(entries: readonly Entry<Placed>[], id: string): string {
  return entries.find((entry) => entry.id === id || entry.parts.some((part) => part.id === id))?.id ?? id;
}
