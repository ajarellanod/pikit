/** How the dashboard shows names: no imports, so the kit's tests read it as it is. */

/**
 * An agent's name as the dashboard shows it (the stored name stays as it is): its words, split at
 * `-` and `_`, each one capitalized. `assistant` is "Assistant", `support-bot` "Support Bot".
 */
export function assistantName(name: string): string {
  const words = name.split(/[-_]+/).filter((word) => word !== "");
  return words.length === 0 ? name : words.map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(" ");
}
