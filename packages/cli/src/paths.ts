/**
 * Where the CLI lives. In M1 the CLI runs from a checkout of the pikit repository (the installer
 * clones it), so the default registry and the `@pikit/*` packages it vendors into a project are
 * that checkout's own.
 */

import { join } from "node:path";

/** The root of the pikit checkout this CLI runs from. */
export const PIKIT_ROOT = join(import.meta.dir, "..", "..", "..");

/** The registry `pikit new` and `pikit add` use when no `--registry` is given. */
export const DEFAULT_REGISTRY = join(PIKIT_ROOT, "registry");

/** The kit packages a project depends on, vendored until they are published (SPEC §10.5). */
export const PACKAGES_DIR = join(PIKIT_ROOT, "packages");
