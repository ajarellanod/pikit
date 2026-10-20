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
 * CONTRACT (fixed by the coordinator): the owner implements these signatures; nobody changes them.
 */

import type { CompositionIssue, CompositionPlan } from "./composition.ts";
import type { Registry } from "./registry-source.ts";

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

/** The preset resolved for these answers. Throws only when the preset itself cannot be read. */
export function resolvePresetPlan(_registry: Registry, _options: PresetPlanOptions): ResolvedPresetPlan {
  throw new Error("resolvePresetPlan: not implemented yet");
}
