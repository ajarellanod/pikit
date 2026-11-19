/**
 * The measured project, made by a kit's own CLI (`<kit>/packages/cli/src/main.ts`) from that kit's
 * registry and packages, so a revision is measured as `pikit new` would give it:
 *
 * - `pikit new --target durable --preset cloudflare` with channel-http, agents-live (router-rules and
 *   settings-store) and tool-mcp, then `pikit add` of the owners the design note lists (memory-sql,
 *   projects-sql, approvals-sql, provider-failover, tool-mcp-oauth, credentials-do) and provider-faux;
 * - the steward on `faux/scripted` (no model account, no network);
 * - the bench's part (`part.ts`) in the Worker's App, and `.env` with the three tokens;
 * - the UI projects built once, and `wrangler.bench.json`: the project's config with no build
 *   command, so each `wrangler dev` restart bundles the Worker only;
 * - `wrangler.script.json`: a Worker of `script-start.ts` alone, which imports the project's Worker
 *   module on its first request (the script start, measured apart from any App's start).
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.ts";

/** `pikit new` answers: a channel to measure a conversation through, and the features with owners. */
export const NEW_FLAGS = ["--target", "durable", "--preset", "cloudflare", "--with", "channel-http", "--with", "agents-live", "--with", "tool-mcp"];
/** Added after: the owners of the design note's measurement, and the fake model. */
export const ADDED = ["memory-sql", "projects-sql", "approvals-sql", "provider-failover", "tool-mcp-oauth", "credentials-do", "provider-faux"];
export const BENCH_CONFIG = "wrangler.bench.json";
export const SCRIPT_CONFIG = "wrangler.script.json";

export interface BenchProject {
  dir: string;
  /** The Worker's name (`--name`): the project's directory name. */
  name: string;
  tokens: { http: string; admin: string; bench: string };
  /** How many components the object's App (the default export) lists. */
  components: number;
}

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Inserts `text` after the one place `anchor` is found in `source`; throws when it is not exactly once. */
function insertAfter(source: string, anchor: string, text: string, file: string): string {
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + 1) >= 0) throw new Error(`bench: ${file} does not have "${anchor.trim()}" exactly once`);
  return source.slice(0, at + anchor.length) + text + source.slice(at + anchor.length);
}

export async function makeProject(kit: string, parent: string, name: string, log: (line: string) => void): Promise<BenchProject> {
  const cli = [process.execPath, join(kit, "packages", "cli", "src", "main.ts")];
  const dir = join(parent, name);
  log(`pikit new ${name} (kit ${kit})`);
  await run([...cli, "new", name, ...NEW_FLAGS], parent);
  log(`pikit add ${ADDED.join(" ")}`);
  await run([...cli, "add", ...ADDED, "--yes"], dir);

  const agentFile = join(dir, "src", "agents", "steward", "agent.ts");
  const agent = readFileSync(agentFile, "utf8");
  if (!/model: "[^"]*"/.test(agent)) throw new Error(`bench: no model line in ${agentFile}`);
  writeFileSync(agentFile, agent.replace(/model: "[^"]*"/, 'model: "faux/scripted"'));

  mkdirSync(join(dir, "src", "bench"), { recursive: true });
  cpSync(join(import.meta.dir, "part.ts"), join(dir, "src", "bench", "index.ts"));
  cpSync(join(import.meta.dir, "script-start.ts"), join(dir, "src", "bench", "script-start.ts"));
  const configFile = join(dir, "pikit.config.ts");
  let config = readFileSync(configFile, "utf8");
  config = insertAfter(config, 'import { defineApp } from "@pikit/core";\n', 'import bench from "./src/bench/index.ts";\n', configFile);
  config = insertAfter(config, "export const worker = defineApp({\n  components: [\n", "    bench,\n", configFile);
  writeFileSync(configFile, config);
  const defaultApp = /export default defineApp\(\{\s*components: \[([^\]]*)\]/.exec(config)?.[1] ?? "";
  const components = defaultApp.split(",").filter((entry) => entry.trim() !== "").length;

  const tokens = { http: hex(24), admin: hex(32), bench: hex(24) };
  writeFileSync(join(dir, ".env"), `PIKIT_HTTP_TOKEN=${tokens.http}\nPIKIT_ADMIN_TOKEN=${tokens.admin}\nPIKIT_BENCH_TOKEN=${tokens.bench}\n`);

  // What wrangler.jsonc's build command does, once: every UI project of src/ (the dashboard).
  log("building the UI projects once");
  await run(["sh", "-c", 'for p in src/*/package.json; do d="${p%/package.json}"; [ -f "$p" ] && [ "$d" != src/pikit ] || continue; (cd "$d" && bun install --frozen-lockfile && bun run build) || exit 1; done'], dir);
  const wrangler = Bun.JSONC.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  const { build: _build, ...bench } = wrangler;
  writeFileSync(join(dir, BENCH_CONFIG), JSON.stringify(bench, null, 2));
  const { compatibility_date, compatibility_flags, rules } = wrangler;
  writeFileSync(join(dir, SCRIPT_CONFIG), JSON.stringify({ main: "src/bench/script-start.ts", compatibility_date, compatibility_flags, rules }, null, 2));
  return { dir, name, tokens, components };
}
