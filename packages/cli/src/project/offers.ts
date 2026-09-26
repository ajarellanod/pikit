/**
 * Offered providers (SPEC §10.5): what a component brings along, decided by capabilities, never by
 * naming other components (S4).
 *
 * - A capability a component can use (`useOptional`) and the catalogue marks `offer` (durable
 *   delivery, `outbound.queue`), which nothing installed provides: its provider is offered.
 * - A capability an offered component requires (`use`), which nothing provides: its provider comes
 *   too (`outbound-durable` needs `storage.sql`: `storage-sqlite`).
 *
 * Only when the registry has exactly one provider: with several, choosing is the user's, and `pikit
 * doctor` says what is missing. What is installed this way is recorded as installed *for* the
 * component that brought it, and leaves with it when nothing else uses it (`pikit remove`).
 */

import { capabilityEntry } from "../registry/capabilities.ts";
import type { Registry } from "./registry-source.ts";

export interface Offer {
  /** The provider to install. */
  component: string;
  /** What it provides that is missing. */
  capability: string;
  /** The component that uses it (can use it, or requires it). */
  for: string;
  /** `recommended`: an optional capability marked `offer`; `required`: an offered component needs it. */
  why: "recommended" | "required";
}

/**
 * The providers `names` bring, given what `installed` already provides; dependencies first (the
 * order to install them in). `names` themselves are never offered.
 */
export function offeredProviders(registry: Registry, names: readonly string[], installed: readonly string[] = []): Offer[] {
  const provided = new Set<string>();
  const known = (name: string) => {
    try {
      return registry.manifest(name);
    } catch {
      return undefined; // Installed from another registry: `pikit doctor` checks the real app.
    }
  };
  for (const name of [...installed, ...names]) for (const capability of known(name)?.provides ?? []) provided.add(capability);

  const providersOf = (capability: string) => registry.names().filter((name) => known(name)?.provides.includes(capability) === true);
  const offers: Offer[] = [];
  const visit = (name: string, depth: number): void => {
    const manifest = known(name);
    if (manifest === undefined) return;
    const wanted: [string, Offer["why"]][] = [
      // What an offered component requires comes with it; what a component the user chose requires
      // is theirs to provide (`pikit add` warns, `pikit doctor` fails).
      ...(depth > 0 ? manifest.requires.capabilities.map((c): [string, Offer["why"]] => [c, "required"]) : []),
      ...manifest.optional.capabilities.filter((c) => capabilityEntry(c)?.offer === true).map((c): [string, Offer["why"]] => [c, "recommended"]),
    ];
    for (const [capability, why] of wanted) {
      if (provided.has(capability) || capabilityEntry(capability)?.mode !== "single") continue;
      const providers = providersOf(capability);
      if (providers.length !== 1) continue;
      const component = providers[0] as string;
      for (const c of known(component)?.provides ?? []) provided.add(c);
      const offer: Offer = { component, capability, for: name, why };
      visit(component, depth + 1);
      offers.push(offer);
    }
  };
  for (const name of names) visit(name, 0);
  return offers;
}

/**
 * `components` with what they bring, each provider placed right before the component it came for
 * (the order `pikit new` installs them in), and what each was installed for.
 */
export function withOffers(registry: Registry, components: readonly string[]): { order: string[]; installedFor: Map<string, string> } {
  const offers = offeredProviders(registry, components);
  const installedFor = new Map(offers.map((o) => [o.component, o.for]));
  /** The component the user chose that an offer, directly or through another offer, came for. */
  const rootOf = (name: string): string => {
    const parent = installedFor.get(name);
    return parent === undefined ? name : rootOf(parent);
  };
  const order: string[] = [];
  for (const component of components) {
    for (const offer of offers) if (rootOf(offer.component) === component) order.push(offer.component);
    order.push(component);
  }
  return { order, installedFor };
}
