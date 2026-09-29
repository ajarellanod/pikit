/**
 * Offered providers: what a component brings along, decided by capabilities, never by naming
 * other components (SPEC P4).
 *
 * - A capability a component can use (`useOptional`) or requires (`use`) and the catalogue marks
 *   `offer` (durable delivery, `outbound.queue`; a place for small values, `storage.kv`), which
 *   nothing installed provides: its provider is offered.
 * - A capability an offered component requires (`use`), which nothing provides: its provider comes
 *   too (`outbound-durable` needs `storage.sql`: `storage-sqlite`).
 *
 * Only when the registry has exactly one provider that runs on every one of the project's targets
 * (`storage-sqlite` on a server, `storage-do` on Cloudflare): with several, choosing is the user's,
 * and `pikit doctor` says what is missing. What is installed this way is recorded as installed *for* the
 * component that brought it, and leaves with it when nothing else uses it (`pikit remove`).
 *
 * Per App (`apps.ts`): on Cloudflare, what a component's Worker half needs must be provided in the
 * Worker's App, by a component that goes there, and what its object's half needs in the default App.
 */

import { capabilityEntry } from "../registry/capabilities.ts";
import type { Manifest } from "../registry/manifest.ts";
import { type AppName, declaredByApp } from "./apps.ts";
import { NEW_PROJECT_TARGETS } from "./pikit-json.ts";
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
  /** Where it is missing, when not the default App: the Worker's (a Cloudflare project, SPEC C1). */
  app?: "worker";
}

/**
 * The providers `names` bring, given what `installed` already provides, among those that run on
 * `targets` (the project's); dependencies first (the order to install them in). `names` themselves
 * are never offered.
 */
export function offeredProviders(
  registry: Registry,
  names: readonly string[],
  installed: readonly string[] = [],
  targets: readonly string[] = NEW_PROJECT_TARGETS,
): Offer[] {
  const provided: Record<AppName, Set<string>> = { default: new Set(), worker: new Set() };
  const known = (name: string) => {
    try {
      return registry.manifest(name);
    } catch {
      return undefined; // Installed from another registry: `pikit doctor` checks the real app.
    }
  };
  const provide = (manifest: Manifest) => {
    for (const [app, half] of declaredByApp(manifest, targets)) for (const capability of half.provides) provided[app].add(capability);
  };
  for (const name of [...installed, ...names]) {
    const manifest = known(name);
    if (manifest !== undefined) provide(manifest);
  }

  const runsHere = (name: string) => targets.every((target) => known(name)?.targets.includes(target) === true);
  /** The components that provide `capability` in `app`: a provider of the other App does not help. */
  const providersOf = (capability: string, app: AppName) =>
    registry.names().filter((name) => {
      const manifest = known(name);
      if (manifest === undefined || !runsHere(name)) return false;
      return declaredByApp(manifest, targets).some(([where, half]) => where === app && half.provides.includes(capability));
    });
  const offers: Offer[] = [];
  const visit = (name: string, depth: number): void => {
    const manifest = known(name);
    if (manifest === undefined) return;
    for (const [app, half] of declaredByApp(manifest, targets)) {
      const wanted: [string, Offer["why"]][] = [
        // What an offered component requires comes with it. What a component the user chose requires
        // is theirs to provide (`pikit add` warns, `pikit doctor` fails), unless the catalogue marks
        // it `offer`: `conversations-kv` brings `storage-kv-sql` as `channel-telegram` does.
        ...half.requires.filter((c) => depth > 0 || capabilityEntry(c)?.offer === true).map((c): [string, Offer["why"]] => [c, "required"]),
        ...half.optional.filter((c) => capabilityEntry(c)?.offer === true).map((c): [string, Offer["why"]] => [c, "recommended"]),
      ];
      for (const [capability, why] of wanted) {
        if (provided[app].has(capability) || capabilityEntry(capability)?.mode !== "single") continue;
        const providers = providersOf(capability, app);
        if (providers.length !== 1) continue;
        const component = providers[0] as string;
        provide(known(component) as Manifest);
        const offer: Offer = { component, capability, for: name, why, ...(app === "worker" && { app }) };
        visit(component, depth + 1);
        offers.push(offer);
      }
    }
  };
  for (const name of names) visit(name, 0);
  return offers;
}

/**
 * `components` with what they bring, each provider placed right before the component it came for
 * (the order `pikit new` installs them in), and what each was installed for.
 */
export function withOffers(
  registry: Registry,
  components: readonly string[],
  targets: readonly string[] = NEW_PROJECT_TARGETS,
): { order: string[]; installedFor: Map<string, string> } {
  const offers = offeredProviders(registry, components, [], targets);
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
