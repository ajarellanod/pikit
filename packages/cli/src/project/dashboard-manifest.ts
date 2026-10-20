/**
 * A registry's dashboard descriptor, `dashboard/dashboard.json`, beside its `dashboard/files/`: the
 * components a project with this dashboard needs, in the order `pikit ui on` installs them, and the
 * capability each default stands for (another provider of it, in every App, takes its place). Which
 * components a dashboard needs is its registry's to say, under any names: the CLI names none.
 */

import { existsSync, readFileSync } from "node:fs";
import Type from "typebox";
import { type Manifest, schemaProblems, TARGETS } from "../registry/manifest.ts";
import { APP_LABEL, type AppName, declaredByApp, hasWorkerApp } from "./apps.ts";
import { dashboardFiles } from "./dashboard.ts";
import { confinedPath } from "./paths.ts";
import type { Registry } from "./registry-source.ts";

/** Where a registry keeps it, from its root. */
export const DASHBOARD_MANIFEST = "dashboard/dashboard.json";

export interface DashboardManifest {
  /** What a project with this dashboard needs, providers first: the order they are installed in. */
  components: string[];
  /** A default of `components` → the capability it stands for (`admin.auth`). */
  defaultFor: Record<string, string>;
}

const KEBAB = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
const CAPABILITY = "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*$";

export const DashboardManifestSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    components: Type.Array(Type.String({ pattern: KEBAB }), {
      minItems: 1,
      uniqueItems: true,
      description: "What a project with this dashboard needs, providers first: the order `pikit ui on` (and `pikit new --ui`) installs them in.",
    }),
    defaultFor: Type.Record(Type.String({ pattern: KEBAB }), Type.String({ pattern: CAPABILITY }), {
      description:
        "A default of `components` → the capability it stands for: another provider of it, in every App of the project, takes its place. A component it does not name is always installed.",
    }),
  },
  { additionalProperties: false },
);

/** The descriptor as read, or why it cannot be: `undefined` without a dashboard. */
function read(registry: Registry): { manifest: DashboardManifest } | { problems: string[] } | undefined {
  if (dashboardFiles(registry) === undefined) return undefined;
  const path = confinedPath(registry.root, DASHBOARD_MANIFEST);
  if (!existsSync(path)) return { problems: [`${DASHBOARD_MANIFEST} is missing: the dashboard (dashboard/files/) needs it to name the components it needs`] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problems: [`${DASHBOARD_MANIFEST}: not valid JSON (${error instanceof Error ? error.message : String(error)})`] };
  }
  const problems = schemaProblems(DashboardManifestSchema, raw).map((problem) => `${DASHBOARD_MANIFEST} ${problem}`);
  if (problems.length > 0) return { problems };
  const { components, defaultFor } = raw as DashboardManifest;
  return { manifest: { components, defaultFor } };
}

/**
 * The registry's descriptor: `undefined` when the registry has no dashboard (`dashboard/files/`);
 * throws, naming the file, when the dashboard has no descriptor or it is not of the schema's shape.
 */
export function dashboardManifest(registry: Registry): DashboardManifest | undefined {
  const result = read(registry);
  if (result === undefined) return undefined;
  if ("problems" in result) throw new Error(`the registry ${registry.root}: ${result.problems.join("; ")}`);
  return result.manifest;
}

/**
 * What `registry validate` reports of it, one line each: its shape, a component the registry does not
 * have, a default that is not one of `components` or does not provide the capability it stands for.
 * Empty when the registry has no dashboard.
 */
export function dashboardManifestProblems(registry: Registry): string[] {
  const result = read(registry);
  if (result === undefined) return [];
  if ("problems" in result) return result.problems;
  const { components, defaultFor } = result.manifest;
  const problems: string[] = [];
  const names = new Set(registry.names());
  const manifests = new Map<string, Manifest>();
  for (const component of components) {
    if (!names.has(component)) {
      problems.push(`${DASHBOARD_MANIFEST}: "${component}" is not a component of the registry`);
      continue;
    }
    let manifest: Manifest;
    try {
      manifest = registry.manifest(component);
    } catch {
      continue; // its own problem, which `registry validate` reports with the component
    }
    manifests.set(component, manifest);
    // The dashboard goes on every target: so must what it needs.
    const missing = TARGETS.filter((target) => !manifest.targets.includes(target));
    if (missing.length > 0) problems.push(`${DASHBOARD_MANIFEST}: "${component}" does not run on ${missing.join(" or ")}, and the dashboard does`);
  }
  for (const [component, capability] of Object.entries(defaultFor)) {
    if (!components.includes(component)) {
      problems.push(`${DASHBOARD_MANIFEST}: "defaultFor" names "${component}", which is not one of its "components"`);
      continue;
    }
    const manifest = manifests.get(component);
    if (manifest === undefined) continue;
    // In every App of each target it runs on, as the dashboard needs it (`missingUiComponents`).
    for (const target of TARGETS.filter((t) => manifest.targets.includes(t))) {
      const apps: AppName[] = hasWorkerApp([target]) ? ["default", "worker"] : ["default"];
      const declared = new Map(declaredByApp(manifest, [target]));
      const lacking = apps.filter((app) => declared.get(app)?.provides.includes(capability) !== true);
      if (lacking.length > 0) {
        problems.push(
          `${DASHBOARD_MANIFEST}: "${component}" stands for ${capability}, which it does not provide in ${lacking.map((app) => APP_LABEL[app]).join(" and ")} on ${target}`,
        );
      }
    }
  }
  return problems;
}
