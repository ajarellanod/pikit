/**
 * The dashboard's shared UI pieces (features/completed/channel-web.md, "The UI split"): what a UI project other
 * than the dashboard (channel-web's chat page) may carry, because none of it knows the admin API.
 *
 * - `LIB_UI` (`@pikit/lib-ui`): the generic helpers of `src/lib/`. shadcn's `utils.ts` (`SHADCN_UTILS`)
 *   is shared too, but in no item: every shadcn project has its own.
 * - `ADMIN_CLIENT` (`@pikit/admin-client`): the rest of `src/lib/`, the admin API's client and the
 *   dashboard's shell. Every file of `src/lib/` is in exactly one of the two.
 * - `SHARED_UI_FILES`: the lib-ui files, Beautiful UI's primitives (`src/components/bui/`, its
 *   `ActionsMenu` too) and the pieces that take everything by props and never fetch (`message`,
 *   `error-note`, `markdown`, `markdown-engine`, and a settings dialog's frame and rows:
 *   `settings-shell`, `settings-rows`), as paths from the dashboard's root.
 *
 * `sharedUiViolations` keeps them so: a shared file reaches (by `@/` or a relative path) only other
 * shared files, never the admin client. `scripts/ui-shared.test.ts` runs it on the template.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isRelative, scanImports } from "../packages/cli/src/registry/imports.ts";

export const DASHBOARD = join(import.meta.dir, "../registry/dashboard/files");

/** `src/lib/` files of `@pikit/lib-ui` (`utils.ts` is shadcn's: shared, not in the item). */
export const LIB_UI: readonly string[] = ["activity.ts", "format.ts", "messages.ts", "names.ts", "sounds.ts", "theme.ts"];
/** `src/lib/` files of `@pikit/admin-client`. */
export const ADMIN_CLIENT: readonly string[] = ["admin-api.ts", "api.ts", "chats.tsx", "router.tsx", "settings.ts", "shell.tsx", "views.ts"];
/** shadcn's own `src/lib/` file: in neither item. */
export const SHADCN_UTILS = "utils.ts";

/** The pieces of `src/components/pikit/` that need lib-ui only. */
const SHARED_PIECES = ["error-note.tsx", "markdown-engine.tsx", "markdown.tsx", "message.tsx", "settings-rows.tsx", "settings-shell.tsx"];

/** The shared files, from the dashboard's root `root`, sorted. */
export function sharedUiFiles(root = DASHBOARD): string[] {
  return [
    ...[...LIB_UI, SHADCN_UTILS].map((file) => `src/lib/${file}`),
    ...SHARED_PIECES.map((file) => `src/components/pikit/${file}`),
    ...readdirSync(join(root, "src/components/bui")).map((file) => `src/components/bui/${file}`),
  ].sort();
}

/** The template's shared files: what a UI project's copies are made from. */
export const SHARED_UI_FILES: readonly string[] = sharedUiFiles();

const EXTENSION = /\.tsx?$/;

/** The file `specifier` (in `from`, a path from the dashboard's root) names, without its extension; `undefined` for a package. */
function target(from: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`.replace(EXTENSION, "");
  if (isRelative(specifier)) return posix.join(dirname(from), specifier).replace(EXTENSION, "");
  return undefined;
}

/**
 * Every import of a shared file (of `root`, the dashboard's root) that reaches a file of the dashboard
 * that is not shared: `@/lib/api`, `@/lib/admin-api`, `@/lib/chats`, `@/lib/settings`, `@/lib/views`,
 * `@/lib/router`, `@/lib/shell`, or anything else of the dashboard's own. Packages are left out.
 */
export function sharedUiViolations(root = DASHBOARD): { file: string; specifier: string }[] {
  const files = sharedUiFiles(root);
  const shared = new Set(files.map((file) => file.replace(EXTENSION, "")));
  const found: { file: string; specifier: string }[] = [];
  for (const file of files) {
    for (const specifier of scanImports(readFileSync(join(root, file), "utf8"))) {
      const reached = target(file, specifier);
      if (reached !== undefined && !shared.has(reached)) found.push({ file, specifier });
    }
  }
  return found;
}
