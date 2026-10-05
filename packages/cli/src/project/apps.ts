/**
 * The Apps of a project, and what each component declares in each (SPEC §4.1, C1).
 *
 * A project on Cloudflare has two Apps in `pikit.config.ts`: the default export (each conversation's
 * Durable Object) and `export const worker` (the Worker). A component goes in the default App; its
 * `component.json`'s `apps.worker` puts it in the Worker's too: a named export is its Worker half
 * (the component `<name>-worker`, what `halves.worker` declares), and `"default"` is the component
 * itself in both. A server project has one App, and every component is in it whole.
 *
 * What each App provides and needs is what `pikit add` checks and offers by: a capability provided
 * in the object's App does not reach the Worker's.
 */

import { type AppName, BOTH_APPS, type Half, type Manifest } from "../registry/manifest.ts";

export type { AppName };

/** How the CLI names an App to a person. */
export const APP_LABEL: Record<AppName, string> = {
  default: "the default App",
  worker: "the Worker's App (export const worker)",
};

/** A project on the durable target (Cloudflare) has the Worker's App besides the default one (SPEC C1). */
export function hasWorkerApp(targets: readonly string[]): boolean {
  return targets.includes("durable");
}

/** The Apps `manifest` goes in on a project of `targets`, each with what it declares there. */
export function declaredByApp(manifest: Manifest, targets: readonly string[]): [AppName, Half][] {
  const whole: Half = { provides: manifest.provides, requires: manifest.requires.capabilities, optional: manifest.optional.capabilities };
  const worker = manifest.apps?.worker;
  if (worker === undefined) return [["default", whole]];
  // On a server only the default export is listed: what its own half declares, when the manifest says.
  if (!hasWorkerApp(targets)) return [["default", manifest.halves?.default ?? whole]];
  // A registry that does not say what each half declares: the whole, in each (doctor has the truth).
  if (worker === BOTH_APPS || manifest.halves === undefined) return [["default", whole], ["worker", whole]];
  return [["default", manifest.halves.default], ["worker", manifest.halves.worker]];
}

/** The name, and config key, of `name`'s half in the Worker's App when it has one of its own. */
export function workerHalfName(name: string): string {
  return `${name}-worker`;
}
