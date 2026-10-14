/**
 * The build's last step (`bun run build`: `tsc -b && vite build && bun scripts/embed.ts`): `dist/` as a
 * module, `../pikit/channel-web/chat-files.ts` (path → its bytes in base64), which channel-web imports
 * and serves at `/chat/`. Bundled with the app, the page is served the same way on every host, a
 * Cloudflare Worker included: no disk, no binding.
 *
 * Only where channel-web is installed (`src/pikit/channel-web/` next to this page's folder); elsewhere
 * (the kit's registry) `dist/` is all the build makes. The module changes only when the built files do.
 *
 * A bundle that names the admin API (`/admin/api`) is refused, written nowhere: the users' page never
 * carries the operator's client (features/channel-web.md, "The UI split").
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const channel = join(root, "..", "pikit", "channel-web");
const target = join(channel, "chat-files.ts");
const ADMIN_API = "/admin/api";

if (!existsSync(join(dist, "index.html"))) {
  console.error("embed: dist/index.html is missing: run `vite build` first");
  process.exit(1);
}

/** Every file under `dir`, as paths relative to `dist` with `/`, sorted. */
function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

const all = files(dist);
const admin = all.filter((path) => readFileSync(join(dist, path), "latin1").includes(ADMIN_API));
if (admin.length > 0) {
  console.error(`embed: ${admin.join(", ")} name the admin API (${ADMIN_API}): the chat page never carries the admin client`);
  process.exit(1);
}
if (!existsSync(channel)) {
  console.log("embed: no ../pikit/channel-web/ next to the page (channel-web is not installed): dist/ only");
  process.exit(0);
}

const entries = all.map((path) => `  ${JSON.stringify(path)}: ${JSON.stringify(readFileSync(join(dist, path)).toString("base64"))},`);
const text = `/**
 * The chat page's built files, written by its build (\`src/chat/\`: \`bun run build\`, whose last step
 * is \`scripts/embed.ts\`): do not edit. Path under \`dist/\` → its bytes in base64.
 */

import type { ChatFiles } from "./assets.ts";

export const CHAT_FILES: ChatFiles = {
${entries.join("\n")}
};
`;

if (existsSync(target) && readFileSync(target, "utf8") === text) {
  console.log(`embed: ${target} is up to date (${entries.length} files)`);
} else {
  writeFileSync(target, text);
  console.log(`embed: ${entries.length} files into ${target}`);
}
