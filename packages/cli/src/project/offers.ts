/**
 * Offered providers: what a component brings along, decided by capabilities, never by naming
 * other components (SPEC P4).
 *
 * - A capability a component can use (`useOptional`) or requires (`use`) and the catalogue marks
 *   `offer` (durable delivery, `outbound.queue`; a place for small values, `storage.kv`), which
 *   nothing installed provides: its provider is offered. The catalogue is the registry's
 *   (`catalogueOf`): the kit's, with the capabilities its components declare, `offer` included.
 * - A capability an offered component requires (`use`), which nothing provides: its provider comes
 *   too (`outbound-durable` needs `storage.sqlite`: `storage-sqlite`).
 *
 * Only when the registry has exactly one provider that runs on every one of the project's targets
 * (`storage-sqlite` on a server, `storage-do` on Cloudflare): with several, choosing is the user's.
 * A required one is then missing, which `pikit add` warns about and `pikit doctor` fails on; an
 * optional one is not, so `unchosenProviders` names it, or the project would silently lack it
 * (durable delivery) with doctor green. Both are named by `unchosenProviders`, with their
 * candidates: an optional one may be left out, a required one leaves the project not composing
 * until one of them is installed. What is installed this way is recorded as installed *for* the
 * component that brought it, and leaves with it when nothing else uses it (`pikit remove`).
 *
 * Per App (`apps.ts`): on Cloudflare, what a component's Worker half needs must be provided in the
 * Worker's App, by a component that goes there, and what its object's half needs in the default App.
 *
 * What a project provides is what its `pikit.config.ts` composes (`providedByApp`: its own components
 * and their config included), never what a registry's manifests say of the installed names: a
 * component of that name in the registry may not be the one installed. Manifests count only for what
 * is about to be installed (`providedByManifests`). A new project has nothing installed: manifests
 * alone (`withOffers`). A project whose composition is unknown gets no offer.
 */

import { capabilityEntry, type RegistryCatalogue, registryCatalogue } from "../registry/capabilities.ts";
import type { Manifest } from "../registry/manifest.ts";
import { type AppName, declaredByApp, workerHalfName } from "./apps.ts";
import { NEW_PROJECT_TARGETS } from "./pikit-json.ts";
import type { AppDescription, ProbeResult } from "./probe.ts";
import type { Registry } from "./registry-source.ts";

/** The capabilities each App provides. */
export type ProvidedCapabilities = Record<AppName, ReadonlySet<string>>;

/**
 * `registry`'s catalogue: the kit's, extended with what its components declare (`registryCatalogue`).
 * A manifest that does not read is left out, and so are conflicting declarations but the first:
 * `registry validate` reports both.
 */
export function catalogueOf(registry: Registry): RegistryCatalogue {
  const manifests = registry.names().flatMap((name) => {
    try {
      return [registry.manifest(name)];
    } catch {
      return [];
    }
  });
  return registryCatalogue(manifests).catalogue;
}

/**
 * What each App of a composed project provides (`probe`), but for `excluding` (components about to
 * be replaced: their Worker halves too); undefined when it does not compose.
 */
export function providedByApp(result: ProbeResult, excluding: readonly string[] = []): ProvidedCapabilities | undefined {
  if (!result.ok) return undefined;
  const skipped = new Set(excluding.flatMap((name) => [name, workerHalfName(name)]));
  const of = (description: AppDescription | undefined) =>
    new Set((description?.components ?? []).filter((c) => !skipped.has(c.name)).flatMap((c) => c.provides));
  return { default: of(result.description), worker: of(result.worker) };
}

/** What `manifests` declare they provide in each App, on `targets`: components not installed yet. */
export function providedByManifests(manifests: readonly Manifest[], targets: readonly string[]): ProvidedCapabilities {
  const provided = { default: new Set<string>(), worker: new Set<string>() };
  for (const manifest of manifests) {
    for (const [app, half] of declaredByApp(manifest, targets)) for (const capability of half.provides) provided[app].add(capability);
  }
  return provided;
}

/** Every capability any of `all` provides, per App. */
export function mergeProvided(...all: ProvidedCapabilities[]): ProvidedCapabilities {
  return {
    default: new Set(all.flatMap((p) => [...p.default])),
    worker: new Set(all.flatMap((p) => [...p.worker])),
  };
}

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
 * The providers `names` bring, given what the project `provided` (`providedByApp`), among those that
 * run on `targets` (the project's); dependencies first (the order to install them in). `names`
 * themselves, and the `installed` ones, are never offered. Without `provided`, only a project with
 * nothing installed gets offers: what an installed component provides is never guessed.
 */
export function offeredProviders(
  registry: Registry,
  names: readonly string[],
  installed: readonly string[] = [],
  targets: readonly string[] = NEW_PROJECT_TARGETS,
  provided?: ProvidedCapabilities,
): Offer[] {
  return resolveOffers(registry, names, installed, targets, provided).offers;
}

/** A capability nothing provides, left out because several components could (`Offer["why"]` says which kind). */
export interface UnchosenOffer {
  capability: string;
  /** `recommended`: an optional capability marked `offer`; `required`: a hard requirement left unmet. */
  why: Offer["why"];
  /** The component that can use it. */
  for: string;
  /** Those that provide it, on the project's targets: the user picks one with `pikit add`. */
  providers: string[];
  app?: "worker";
}

/** What `offeredProviders` leaves out because the registry has several providers of an optional capability. */
export function unchosenProviders(
  registry: Registry,
  names: readonly string[],
  installed: readonly string[] = [],
  targets: readonly string[] = NEW_PROJECT_TARGETS,
  provided?: ProvidedCapabilities,
): UnchosenOffer[] {
  return resolveOffers(registry, names, installed, targets, provided).unchosen;
}

function resolveOffers(
  registry: Registry,
  names: readonly string[],
  installed: readonly string[],
  targets: readonly string[],
  composed: ProvidedCapabilities | undefined,
): { offers: Offer[]; unchosen: UnchosenOffer[] } {
  // Installed components whose composition is unknown: nothing is offered rather than guessed.
  if (composed === undefined && installed.length > 0) return { offers: [], unchosen: [] };
  const catalogue = catalogueOf(registry);
  const entry = (capability: string) => capabilityEntry(capability, catalogue);
  const provided: Record<AppName, Set<string>> = { default: new Set(composed?.default), worker: new Set(composed?.worker) };
  const known = (name: string) => {
    try {
      return registry.manifest(name);
    } catch {
      return undefined;
    }
  };
  const provide = (manifest: Manifest) => {
    for (const [app, half] of declaredByApp(manifest, targets)) for (const capability of half.provides) provided[app].add(capability);
  };
  for (const name of names) {
    const manifest = known(name);
    if (manifest !== undefined) provide(manifest);
  }

  const runsHere = (name: string) => targets.every((target) => known(name)?.targets.includes(target) === true);
  /**
   * The components that provide `capability` in `app`: a provider of the other App does not help. An
   * installed name is not one: it is not reinstalled, and the registry's may not be the installed one.
   */
  const providersOf = (capability: string, app: AppName) =>
    registry.names().filter((name) => {
      if (installed.includes(name)) return false;
      const manifest = known(name);
      if (manifest === undefined || !runsHere(name)) return false;
      return declaredByApp(manifest, targets).some(([where, half]) => where === app && half.provides.includes(capability));
    });
  const offers: Offer[] = [];
  const unchosen: UnchosenOffer[] = [];
  const visit = (name: string, depth: number): void => {
    const manifest = known(name);
    if (manifest === undefined) return;
    for (const [app, half] of declaredByApp(manifest, targets)) {
      const wanted: [string, Offer["why"]][] = [
        // What an offered component requires comes with it. What a component the user chose requires
        // is theirs to provide (`pikit add` warns, `pikit doctor` fails), unless the catalogue marks
        // it `offer`: `conversations-kv` brings `storage-kv-sql` as `channel-telegram` does.
        ...half.requires.filter((c) => depth > 0 || entry(c)?.offer === true).map((c): [string, Offer["why"]] => [c, "required"]),
        ...half.optional.filter((c) => entry(c)?.offer === true).map((c): [string, Offer["why"]] => [c, "recommended"]),
      ];
      for (const [capability, why] of wanted) {
        if (provided[app].has(capability) || entry(capability)?.mode !== "single") continue;
        const providers = providersOf(capability, app);
        // Several providers, none installed: choosing is the user's. Named either way: an optional
        // one may be left out silently, a required one leaves the project not composing until one is.
        if (providers.length > 1) unchosen.push({ capability, why, for: name, providers, ...(app === "worker" && { app }) });
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
  // An offer made later may provide what an earlier one requires (storage-sqlite, brought for the
  // outbox's storage.sqlite, serves the key-value store's storage.sql too): providers still come
  // first, and what it provides is not left to choose.
  const order = dependencyOrder(offers.map((offer) => known(offer.component) as Manifest), targets);
  offers.sort((a, b) => order.indexOf(a.component) - order.indexOf(b.component));
  return { offers, unchosen: unchosen.filter((u) => !provided[u.app ?? "default"].has(u.capability)) };
}

/**
 * `offer` again, when the component it came for was declined: for one of `consumers` (the named
 * components, and the providers accepted so far) that still requires what it provides, in an App
 * where `provided` (the project's, with what the consumers declare) lacks it. Undefined when none
 * does: it leaves with what it came for. An optional need never keeps it.
 */
export function rehomedOffer(registry: Registry, offer: Offer, consumers: readonly string[], targets: readonly string[], provided: ProvidedCapabilities): Offer | undefined {
  for (const [app, half] of declaredByApp(registry.manifest(offer.component), targets)) {
    for (const consumer of consumers) {
      const needs = declaredByApp(registry.manifest(consumer), targets).find(([where]) => where === app)?.[1].requires ?? [];
      const capability = needs.find((c) => half.provides.includes(c) && !provided[app].has(c));
      if (capability !== undefined) return { component: offer.component, capability, for: consumer, why: "required", ...(app === "worker" && { app }) };
    }
  }
  return undefined;
}

/**
 * `manifests` (the components one `pikit add` names) in install order: one that provides, in an App,
 * what another requires or can use there comes before it (so it is listed before it in
 * `pikit.config.ts`, as `pikit new` lists them, and the other's plan sees it provided); otherwise the
 * order they were named in. A cycle keeps that order.
 */
export function dependencyOrder(manifests: readonly Manifest[], targets: readonly string[]): string[] {
  const provides = (manifest: Manifest, app: AppName, capability: string) =>
    declaredByApp(manifest, targets).some(([where, half]) => where === app && half.provides.includes(capability));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (manifest: Manifest): void => {
    if (order.includes(manifest.name) || visiting.has(manifest.name)) return;
    visiting.add(manifest.name);
    for (const [app, half] of declaredByApp(manifest, targets)) {
      for (const capability of [...half.requires, ...half.optional]) {
        for (const other of manifests) if (other !== manifest && provides(other, app, capability)) visit(other);
      }
    }
    order.push(manifest.name);
  };
  for (const manifest of manifests) visit(manifest);
  return order;
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
