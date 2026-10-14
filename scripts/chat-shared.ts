/**
 * channel-web's chat page (`registry/components/channel-web/chat/`, a UI project of its own:
 * features/channel-web.md sections 1 and 5) carries copies of what it shares with the dashboard, made
 * from the dashboard's sources, never written by hand:
 *
 *   bun scripts/chat-shared.ts generate   write the copies
 *   bun scripts/chat-shared.ts check      exit 1 when one is not what generate writes
 *
 * The copies (`chatCopies`), as paths from each project's root:
 * - the dashboard's shared UI pieces (`SHARED_UI_FILES`, `scripts/ui-shared.ts`): lib-ui, shadcn's
 *   utils, Beautiful UI's primitives, `message`, `markdown`, `markdown-engine`, `error-note`;
 * - its look: `src/index.css` (the tokens, both themes, the keyframes), `public/theme.js` (the theme
 *   before the first paint) and the mark's two files (the favicon);
 * - channel-web's `api.ts` (the chat API's JSON) as `src/lib/chat-api.ts`.
 *
 * `chatBoundaryViolations` keeps the admin client out: no file of the chat's `src/` reaches (by `@/` or
 * a relative path) a file of `ADMIN_CLIENT` (`@/lib/api`, `admin-api`, `chats`, `settings`, `views`,
 * `router`, `shell`) or the dashboard's `src/views/`; and the chat's `src/lib/` holds none of them.
 * The chat's build refuses a bundle with `/admin/api` in it (its `scripts/embed.ts`).
 * `scripts/chat.test.ts` runs both.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { isRelative, scanImports } from "../packages/cli/src/registry/imports.ts";
import { ADMIN_CLIENT, DASHBOARD, SHARED_UI_FILES } from "./ui-shared.ts";

const REPO = join(import.meta.dir, "..");
export const CHAT = join(REPO, "registry/components/channel-web/chat");
const CHANNEL_WEB_API = join(REPO, "registry/components/channel-web/files/src/pikit/channel-web/api.ts");

/** The dashboard's look, besides the shared pieces. */
const LOOK: readonly string[] = ["src/index.css", "public/theme.js", "public/mark.svg", "public/mark-light.svg"];

/** Every copy: its path in the chat → the absolute path it is made from. */
export function chatCopies(): Map<string, string> {
  const copies = new Map<string, string>();
  for (const file of [...SHARED_UI_FILES, ...LOOK]) copies.set(file, join(DASHBOARD, file));
  copies.set("src/lib/chat-api.ts", CHANNEL_WEB_API);
  return copies;
}

/** The copies of `root` (the chat's root) that differ from their source or are missing, sorted. */
export function staleCopies(root = CHAT): string[] {
  return [...chatCopies()]
    .filter(([target, source]) => !existsSync(join(root, target)) || readFileSync(join(root, target), "utf8") !== readFileSync(source, "utf8"))
    .map(([target]) => target)
    .sort();
}

const EXTENSION = /\.tsx?$/;

/** The file `specifier` (in `from`, a path from the project's root) names, without its extension; `undefined` for a package. */
function target(from: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`.replace(EXTENSION, "");
  if (isRelative(specifier)) return posix.join(dirname(from), specifier).replace(EXTENSION, "");
  return undefined;
}

/** Every source file under `dir` (`.ts`, `.tsx`), as paths from `root`, sorted. */
function sources(root: string, dir = "src"): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir))
    .sort()
    .flatMap((name) => {
      const path = `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) return sources(root, path);
      return EXTENSION.test(name) ? [path] : [];
    });
}

/** The admin client's files (`src/lib/api`…) and the dashboard's views, as import targets without extensions. */
const ADMIN = new Set(ADMIN_CLIENT.map((file) => `src/lib/${file.replace(EXTENSION, "")}`));
const forbidden = (reached: string): boolean => ADMIN.has(reached) || reached === "src/views" || reached.startsWith("src/views/");

/**
 * What of the chat (`root`) reaches the admin client: each import of one of its files that names a file
 * of `ADMIN_CLIENT` or the dashboard's `src/views/`, and each such file in its own `src/`.
 */
export function chatBoundaryViolations(root = CHAT): { file: string; specifier: string }[] {
  const found: { file: string; specifier: string }[] = [];
  for (const file of sources(root)) {
    if (forbidden(file.replace(EXTENSION, ""))) found.push({ file, specifier: "(the file itself)" });
    for (const specifier of scanImports(readFileSync(join(root, file), "utf8"))) {
      const reached = target(file, specifier);
      if (reached !== undefined && forbidden(reached)) found.push({ file, specifier });
    }
  }
  return found;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "generate") {
    const copies = chatCopies();
    for (const [file, source] of copies) {
      mkdirSync(dirname(join(CHAT, file)), { recursive: true });
      writeFileSync(join(CHAT, file), readFileSync(source));
    }
    console.log(`chat-shared: wrote ${copies.size} copies into ${relative(REPO, CHAT)}`);
  } else if (command === "check") {
    const stale = staleCopies();
    const violations = chatBoundaryViolations();
    if (stale.length > 0) console.error(`chat-shared: out of date (${stale.join(", ")}): run \`bun scripts/chat-shared.ts generate\``);
    for (const { file, specifier } of violations) console.error(`chat-shared: ${file} reaches the admin client (${specifier})`);
    if (stale.length + violations.length > 0) process.exit(1);
    console.log("chat-shared: up to date, no admin client");
  } else {
    console.error("usage: bun scripts/chat-shared.ts generate | check");
    process.exit(2);
  }
}
