/**
 * A registry's dashboard descriptor, `dashboard/dashboard.json`, beside its `dashboard/files/`: the
 * components a project with this dashboard needs, in the order `pikit ui on` installs them, and the
 * capability each default stands for (another provider of it, in every App, takes its place). It
 * replaces the CLI's list of the kit's components (`UI_COMPONENTS`, `UI_DEFAULT_FOR`): which components
 * a dashboard needs is its registry's to say, under any names.
 *
 * CONTRACT (fixed by the coordinator): the owner implements these signatures; nobody changes them.
 */

import type { Registry } from "./registry-source.ts";

/** Where a registry keeps it, from its root. */
export const DASHBOARD_MANIFEST = "dashboard/dashboard.json";

export interface DashboardManifest {
  /** What a project with this dashboard needs, providers first: the order they are installed in. */
  components: string[];
  /** A default of `components` → the capability it stands for (`admin.auth`). */
  defaultFor: Record<string, string>;
}

/**
 * The registry's descriptor: `undefined` when the registry has no dashboard (`dashboard/files/`);
 * throws, naming the file, when the dashboard has no descriptor or it is not of the schema's shape.
 */
export function dashboardManifest(_registry: Registry): DashboardManifest | undefined {
  throw new Error("dashboardManifest: not implemented yet");
}

/**
 * What `registry validate` reports of it, one line each: its shape, a component the registry does not
 * have, a default that is not one of `components` or does not provide the capability it stands for.
 * Empty when the registry has no dashboard.
 */
export function dashboardManifestProblems(_registry: Registry): string[] {
  throw new Error("dashboardManifestProblems: not implemented yet");
}
