/**
 * A preset resolved for a new project, once, for everyone who needs it: the wizard (each time an
 * answer changes, to show which features are available and why not), `pikit new` (with its final
 * answers, before it writes anything) and `registry validate` (every answer and feature it checks).
 *
 * It reads the preset (`registry-source.ts`), adds the providers offered (`offers.ts`) and the
 * dashboard's components (`dashboard-manifest.ts`, `ui.ts`), and asks the one planner what the
 * composition needs of its deployment (`composition.ts`). It holds no rule of its own about
 * deployments, and no component's name: what the steward is granted, the config the preset sets, and
 * the agent layout all come from the preset (features/component-composition.md).
 *
 * - A feature is chosen when every component it installs is (`--with` it, an alias's `with`, or a
 *   group that installs it). Only the preset and the chosen features grant the steward anything; each
 *   key must be one a chosen component provides with its default config (`replay.tools`, `extensions`).
 * - A feature is available when choosing it, with these answers, introduces no composition issue
 *   and every key it grants is provided. One chosen and not available is a problem: never dropped.
 * - Pure but for reading the registry, synchronous: the wizard calls it at each answer.
 */

import { uiComponentsFor } from "../commands/ui.ts";
import { type CompositionIssue, type CompositionPlan, formatCompositionIssue, introducedIssues, planComposition } from "./composition.ts";
import { dashboardFiles } from "./dashboard.ts";
import { withOffers } from "./offers.ts";
import type { Manifest } from "../registry/manifest.ts";
import type { PresetFeature, PresetPolicy, Registry } from "./registry-source.ts";

/** What a preset (or one of its features) grants the starter agent, the steward, by key. */
export interface StewardGrants {
  /** `agent.tool` keys (`bash`), each the default config's of a chosen component (`replay.tools`). */
  tools: string[];
  /** `agent.extension` keys (`pikit-self`), each the default config's of a chosen component (`extensions`). */
  extensions: string[];
}

/** One feature the preset offers, for this answer set. */
export interface PresetFeaturePlan {
  /** Its first component's name: what `--with` names, and what the wizard returns. */
  name: string;
  /** Its first component's `title`. */
  title: string;
  /** Every component it installs, in order. */
  components: string[];
  /** Choosing it brings the dashboard (the preset says so; never a component). */
  ui: boolean;
  /** What choosing it grants the steward, beside the preset's own grants: shown before it is chosen. */
  steward: StewardGrants;
  /** Whether it can be chosen with these answers: false when choosing it would introduce an issue. */
  available: boolean;
  /** Why not, when not available: what choosing it would introduce, formatted. Empty when available. */
  unavailable: string[];
}

export interface PresetPlanOptions {
  preset: string;
  /** The new project's targets. */
  targets: readonly string[];
  /** `--with` answers and chosen features, as `registry.preset` takes them. */
  choices?: readonly string[];
  /** `--ui`. */
  ui?: boolean;
}

export interface ResolvedPresetPlan {
  preset: string;
  /** Everything `pikit new` installs, in order: the preset's with the choices, the features chosen, the providers offered, the dashboard's. */
  components: string[];
  /** The preset's `config`, for the chosen components only: component → its entry. */
  config: Record<string, Record<string, unknown>>;
  /** Whether the project gets the dashboard: `--ui`, the preset's `ui`, or a chosen feature's `ui`. */
  ui: boolean;
  /** The dashboard's components among `components` (empty without a UI). */
  uiComponents: string[];
  /** The steward's grants: the preset's, and those of the chosen features. */
  steward: StewardGrants;
  /** The preset's agent layout, when it declares one, and whether its feature was chosen. */
  agents?: { folders: { feature: string; command: string; chosen: boolean } };
  /** Every feature the preset offers for these answers (but those already installed), available or not. */
  features: PresetFeaturePlan[];
  /** What the composition needs of its deployment (`planComposition` over `components`' manifests). */
  composition: CompositionPlan;
  /** The composition's issues, as issues. */
  issues: readonly CompositionIssue[];
  /**
   * Everything that refuses this plan, one line each: the composition's issues (formatted), a grant of
   * a key no chosen component provides, a layout feature or command that does not exist, config for a
   * component that is not chosen. Empty when `pikit new` may write.
   */
  problems: string[];
}

/**
 * The preset resolved for these answers. Throws only when the preset itself cannot be read (or a
 * choice is not one it asks for or offers: `registry.preset`'s refusal).
 */
export function resolvePresetPlan(registry: Registry, options: PresetPlanOptions): ResolvedPresetPlan {
  const cached = withCachedManifests(registry);
  const choices = [...(options.choices ?? [])];
  const policy = cached.presetPolicy(options.preset);
  const current = candidate(cached, options, policy, choices);

  const features = cached.features(options.preset, options.targets).map((feature): PresetFeaturePlan => {
    const unavailable = unavailableReasons(cached, options, policy, choices, current, feature);
    return { ...feature, steward: copyGrants(feature.steward), available: unavailable.length === 0, unavailable };
  });
  // A chosen feature that is not available refuses the plan, saying why; its issues are said there.
  const said = new Set<string>();
  const refused: string[] = [];
  for (const feature of features) {
    if (!current.chosenFeatures.has(feature.name) || feature.available) continue;
    for (const reason of feature.unavailable) said.add(reason);
    refused.push(`${feature.name} is not available with these answers: ${feature.unavailable.join("; ")}`);
  }

  const problems = [
    ...current.composition.issues.map(formatCompositionIssue).filter((issue) => !said.has(issue)),
    ...refused,
    ...current.uiProblems,
    ...current.grantProblems.filter((problem) => !said.has(problem)),
  ];

  let agents: ResolvedPresetPlan["agents"];
  const folders = policy.agents?.folders;
  if (folders !== undefined) {
    const chosen = current.chosenFeatures.has(folders.feature);
    agents = { folders: { ...folders, chosen } };
    const head = cached.manifest(folders.feature);
    if (head.commands?.[folders.command] === undefined) {
      problems.push(`the preset "${options.preset}" runs \`pikit ${folders.command}\` for agent folders (agents.folders), which ${folders.feature} does not declare (its component.json \`commands\`)`);
    } else if (chosen) {
      const declaring = current.components.filter((name) => cached.manifest(name).commands?.[folders.command] !== undefined);
      if (declaring.length > 1) problems.push(`\`pikit ${folders.command}\` (agents.folders) is declared by ${declaring.join(" and ")}: choose only one of them`);
    }
  }

  const installed = new Set(current.components);
  const config = Object.fromEntries(Object.entries(policy.config).filter(([component]) => installed.has(component)));

  return {
    preset: options.preset,
    components: current.components,
    config,
    ui: current.ui,
    uiComponents: current.uiComponents,
    steward: current.steward,
    ...(agents !== undefined && { agents }),
    features,
    composition: current.composition,
    issues: current.composition.issues,
    problems,
  };
}

/** One answer set, composed: what `pikit new` would install, and what it would refuse of it. */
interface Candidate {
  components: string[];
  ui: boolean;
  uiComponents: string[];
  /** The features every component of which is chosen, by name. */
  chosenFeatures: Set<string>;
  composition: CompositionPlan;
  /** The keys the components provide with their default config, in component order. */
  provided: StewardGrants;
  /** The granted keys that are provided, in the order they are provided. */
  steward: StewardGrants;
  /** Each granted key no component provides, one line, said by who grants it. */
  grantProblems: string[];
  /** Why the dashboard cannot be added (no dashboard, a default provided in some Apps only). */
  uiProblems: string[];
}

function candidate(registry: Registry, options: PresetPlanOptions, policy: PresetPolicy, choices: readonly string[]): Candidate {
  const chosen = registry.preset(options.preset, choices);
  const set = new Set(chosen);
  const chosenFeatures = policy.features.filter((feature) => feature.components.every((c) => set.has(c)));
  const ui = options.ui === true || registry.presetUi(options.preset) || chosenFeatures.some((feature) => feature.ui);
  const memo = memoOf(registry);
  const uiProblems: string[] = [];
  let uiComponents: string[] = [];
  memo.hasDashboard ??= dashboardFiles(registry) !== undefined;
  if (ui && !memo.hasDashboard) uiProblems.push(`the registry ${registry.root} has no dashboard (dashboard/files/)`);
  else if (ui) {
    const result = remember(memo.ui, [chosen, options.targets], () => {
      try {
        return uiComponentsFor(registry, chosen, options.targets);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    });
    if (result instanceof Error) uiProblems.push(result.message);
    else uiComponents = [...result];
  }
  const asked = [...chosen, ...uiComponents];
  const components = [...remember(memo.offers, [asked, options.targets], () => withOffers(registry, asked, options.targets).order)];
  const manifests = components.map((name) => registry.manifest(name));
  const composition = planComposition(manifests);
  const provided = providedKeys(manifests);

  const granters: { who: string; grants: StewardGrants }[] = [
    { who: `the preset "${options.preset}"`, grants: policy.steward },
    ...chosenFeatures.map((feature) => ({ who: `the feature ${feature.name}`, grants: feature.steward })),
  ];
  const granted = { tools: new Set(granters.flatMap((g) => g.grants.tools)), extensions: new Set(granters.flatMap((g) => g.grants.extensions)) };
  const grantProblems = granters.flatMap(({ who, grants }) => grantMisses(who, grants, provided));
  return {
    components,
    ui,
    uiComponents,
    chosenFeatures: new Set(chosenFeatures.map((feature) => feature.name)),
    composition,
    provided,
    steward: { tools: provided.tools.filter((key) => granted.tools.has(key)), extensions: provided.extensions.filter((key) => granted.extensions.has(key)) },
    grantProblems: [...new Set(grantProblems)],
    uiProblems,
  };
}

/**
 * Why `feature` cannot be chosen with these answers: the composition issues choosing it introduces
 * (against the answers without it, when it is chosen), the dashboard it cannot bring, and each key it
 * grants that nothing with it provides. Empty when it can.
 */
function unavailableReasons(registry: Registry, options: PresetPlanOptions, policy: PresetPolicy, choices: readonly string[], current: Candidate, feature: PresetFeature): string[] {
  try {
    const chosen = current.chosenFeatures.has(feature.name);
    const without = chosen ? (choices.includes(feature.name) ? candidate(registry, options, policy, choices.filter((c) => c !== feature.name)) : current) : current;
    const withIt = chosen ? current : candidate(registry, options, policy, [...choices, feature.name]);
    const known = new Set(without.uiProblems);
    return [
      ...introducedIssues(without.composition, withIt.composition).map(formatCompositionIssue),
      ...withIt.uiProblems.filter((problem) => !known.has(problem)),
      ...grantMisses(`the feature ${feature.name}`, feature.steward, withIt.provided),
    ];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** The `agent.tool` and `agent.extension` keys `manifests` provide with their default config, once each, in their order. */
function providedKeys(manifests: readonly Manifest[]): StewardGrants {
  const tools = new Set<string>();
  const extensions = new Set<string>();
  for (const manifest of manifests) {
    for (const tool of Object.keys(manifest.replay?.tools ?? {})) tools.add(tool);
    for (const extension of manifest.extensions ?? []) extensions.add(extension);
  }
  return { tools: [...tools], extensions: [...extensions] };
}

function grantMisses(who: string, grants: StewardGrants, provided: StewardGrants): string[] {
  return [
    ...grants.tools.filter((key) => !provided.tools.includes(key)).map((key) => `${who} grants the steward the tool "${key}", which no chosen component provides (their component.json \`replay.tools\`)`),
    ...grants.extensions.filter((key) => !provided.extensions.includes(key)).map((key) => `${who} grants the steward the extension "${key}", which no chosen component provides (their component.json \`extensions\`)`),
  ];
}

function copyGrants(grants: StewardGrants): StewardGrants {
  return { tools: [...grants.tools], extensions: [...grants.extensions] };
}

/**
 * What a plan reads of a registry, kept for as long as that registry object lives: a plan composes the
 * same components many times, and `registry validate` resolves hundreds of plans. A registry is opened
 * per command, and what is read here (manifests, the dashboard's files) does not change during one.
 */
interface RegistryMemo {
  manifests: Map<string, Manifest>;
  hasDashboard?: boolean;
  ui: Map<string, string[] | Error>;
  offers: Map<string, string[]>;
}

const memos = new WeakMap<Registry, RegistryMemo>();

function memoOf(registry: Registry): RegistryMemo {
  const base = (registry as Registry & { [UNCACHED]?: Registry })[UNCACHED] ?? registry;
  let memo = memos.get(base);
  if (memo === undefined) {
    memo = { manifests: new Map(), ui: new Map(), offers: new Map() };
    memos.set(base, memo);
  }
  return memo;
}

function remember<T>(cache: Map<string, T>, key: unknown, make: () => T): T {
  const id = JSON.stringify(key);
  if (!cache.has(id)) cache.set(id, make());
  return cache.get(id) as T;
}

const UNCACHED = Symbol("uncached registry");

/** `registry`, each manifest read once (`memoOf`). */
function withCachedManifests(registry: Registry): Registry {
  const manifests = memoOf(registry).manifests;
  const wrapped: Registry & { [UNCACHED]: Registry } = {
    ...registry,
    [UNCACHED]: (registry as Registry & { [UNCACHED]?: Registry })[UNCACHED] ?? registry,
    manifest(name) {
      let manifest = manifests.get(name);
      if (manifest === undefined) {
        manifest = registry.manifest(name);
        manifests.set(name, manifest);
      }
      return manifest;
    },
  };
  return wrapped;
}

