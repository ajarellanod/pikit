/**
 * The config celld reads, derived from `wrangler.jsonc` (`celld-config.mjs`): golden tests from the
 * spike's known changes (features/deployment-celld.md) on deployment-cloudflare's own `wrangler.jsonc`
 * and on this component's, then what may reach the Worker as a variable and what stays on the machine.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommand,
  celldConfig,
  celldRules,
  dotenvText,
  exampleNames,
  GENERATED_CONFIG,
  isMachineVariable,
  parseJsonc,
  type ProjectConfig,
  readProjectConfig,
  scriptName,
  workerSecrets,
  writeGeneratedConfig,
} from "./celld-config.mjs";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-celld-config-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** deployment-cloudflare's wrangler.jsonc as the spike deployed it to celld (its comments shortened). */
const CLOUDFLARE_WRANGLER = `// The project on Cloudflare
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": "src/pikit/deployment-cloudflare/worker.ts",
  "build": {
    "command": "for project in src/*/package.json; do echo \\"$project\\"; done",
    "watch_dir": ["pikit.config.ts", "src/pikit", "src/agents", "src/extensions"]
  },
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "CONVERSATION", "class_name": "Conversation" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Conversation"] }],
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "observability": { "enabled": true },
  "rules": [
    { "type": "Text", "globs": ["**/*.md"], "fallthrough": true },
    { "type": "CompiledWasm", "globs": ["**/*.wasm", "@jitl/quickjs-wasmfile-release-sync/wasm"], "fallthrough": true },
  ],
}
`;

test("deployment-cloudflare's wrangler.jsonc: no build, observability or version_metadata; a name; rules without fallthrough and with **/*.ext globs only; the secrets and PIKIT_DEPLOYMENT as vars", () => {
  const config = celldConfig(parseJsonc(CLOUDFLARE_WRANGLER) as ProjectConfig, { name: "my-bot", secrets: { TELEGRAM_BOT_TOKEN: "123:abc" }, deployment: "d1" });
  expect(config).toEqual({
    name: "my-bot",
    $schema: "node_modules/wrangler/config-schema.json",
    main: "src/pikit/deployment-cloudflare/worker.ts",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "CONVERSATION", class_name: "Conversation" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Conversation"] }],
    rules: [
      { type: "Text", globs: ["**/*.md"] },
      { type: "CompiledWasm", globs: ["**/*.wasm"] },
    ],
    vars: { TELEGRAM_BOT_TOKEN: "123:abc", PIKIT_DEPLOYMENT: "d1" },
  });
  // `name` first, the way a person reads it.
  expect(Object.keys(config)[0]).toBe("name");
});

test("this component's wrangler.jsonc: its UI build is run by pikit, so only build goes; the rest passes as it is", () => {
  const shipped = readFileSync(join(import.meta.dir, "..", "..", "..", "wrangler.jsonc"), "utf8");
  const parsed = parseJsonc(shipped) as ProjectConfig;
  expect(buildCommand(parsed)).toContain("bun install --frozen-lockfile && bun run build");
  expect(celldConfig(parsed, { name: "my-bot", deployment: "dev" })).toEqual({
    name: "my-bot",
    main: "src/pikit/deployment-celld/worker.ts",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "CONVERSATION", class_name: "Conversation" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Conversation"] }],
    rules: [{ type: "Text", globs: ["**/*.md"] }],
    vars: { PIKIT_DEPLOYMENT: "dev" },
  });
});

test("rules keep only what celld maps to a loader: a rule left with no extension glob goes", () => {
  expect(
    celldRules([
      { type: "Data", globs: ["*.bin", "assets/**/*.bin", "**/*.{a,b}"], fallthrough: false },
      { type: "CompiledWasm", globs: ["@scope/pkg/wasm"] },
    ]),
  ).toEqual([{ type: "Data", globs: ["*.bin"] }]);
  expect(() => celldRules("nope")).toThrow(/rules is not an array/);
  const config = celldConfig({ rules: [{ type: "CompiledWasm", globs: ["pkg/wasm"] }] }, { name: "x", deployment: "d" });
  expect("rules" in config).toBe(false);
});

test("wrangler.jsonc's vars stay, beside the secrets; a secret may not shadow a var, a binding, or PIKIT_DEPLOYMENT", () => {
  const base = { vars: { MODE: "fleet" }, durable_objects: { bindings: [{ name: "CONVERSATION", class_name: "Conversation" }] }, kv_namespaces: [{ binding: "CACHE", id: "x" }] };
  expect(celldConfig(base, { name: "x", secrets: { KEY: "k" }, deployment: "d" }).vars).toEqual({ MODE: "fleet", KEY: "k", PIKIT_DEPLOYMENT: "d" });
  expect(() => celldConfig(base, { name: "x", secrets: { MODE: "k" }, deployment: "d" })).toThrow("MODE is both a var of wrangler.jsonc and a secret");
  expect(() => celldConfig(base, { name: "x", secrets: { CONVERSATION: "k" }, deployment: "d" })).toThrow("CONVERSATION is a secret and the name of another binding");
  expect(() => celldConfig(base, { name: "x", secrets: { CACHE: "k" }, deployment: "d" })).toThrow(/CACHE is a secret/);
  expect(() => celldConfig(base, { name: "x", secrets: { PIKIT_DEPLOYMENT: "k" }, deployment: "d" })).toThrow(/deployment-celld's own/);
  expect(() => celldConfig(base, { name: "x", secrets: { "MY-KEY": "k" }, deployment: "d" })).toThrow(/cannot reach the Worker/);
  expect(() => celldConfig({ vars: { PIKIT_DEPLOYMENT: "x" } }, { name: "x", deployment: "d" })).toThrow(/sets PIKIT_DEPLOYMENT/);
  expect(() => celldConfig({ vars: { N: 1 } }, { name: "x", deployment: "d" })).toThrow(/string vars only/);
  expect(() => celldConfig({}, { name: "x", deployment: "" })).toThrow(/deployment id/);
});

test("the bucket's settings and keys, deployment-celld's own and Cloudflare's stay on the machine; empty values go nowhere", () => {
  for (const name of ["CELLD_BUCKET", "S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AZURE_STORAGE_ACCOUNT_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "PIKIT_CELLD_URL", "PIKIT_CELLD_SSH", "CLOUDFLARE_API_TOKEN"]) {
    expect([name, isMachineVariable(name)]).toEqual([name, true]);
  }
  expect(isMachineVariable("TELEGRAM_BOT_TOKEN")).toBe(false);
  expect(workerSecrets({ TELEGRAM_BOT_TOKEN: "t", OPENROUTER_API_KEY: "", BRAVE_API_KEY: undefined, CELLD_BUCKET: "s3://b", AWS_SECRET_ACCESS_KEY: "s" })).toEqual({ TELEGRAM_BOT_TOKEN: "t" });
});

test("the Worker is named after wrangler.jsonc's name, else package.json's in the letters celld accepts", () => {
  const dir = project({ "package.json": JSON.stringify({ name: "@acme/My_Bot.v2" }) });
  expect(scriptName(dir)).toBe("acme-my-bot-v2");
  expect(scriptName(dir, { name: "fleet-bot" })).toBe("fleet-bot");
  expect(() => scriptName(dir, { name: "Fleet_Bot" })).toThrow(/not one celld accepts/);
  expect(scriptName(project({ "package.json": JSON.stringify({ name: `${"a".repeat(62)}-b` }) }))).toBe("a".repeat(62));
  expect(() => scriptName(project({ "package.json": JSON.stringify({ name: "___" }) }))).toThrow(/no letter or digit/);
  expect(() => scriptName(project({}))).toThrow(/has no package.json/);
});

test("the derived config is written readable by its owner only, even over a file left by a run before", () => {
  const dir = project({ [GENERATED_CONFIG]: "old" });
  const path = writeGeneratedConfig(dir, { name: "x", vars: { KEY: "secret" } });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const text = readFileSync(path, "utf8");
  expect(text.startsWith("// Written by deployment-celld")).toBe(true);
  expect(parseJsonc(text)).toEqual({ name: "x", vars: { KEY: "secret" } });
});

test("wrangler.jsonc missing or malformed is named; .env.example's names are read", () => {
  expect(() => readProjectConfig(project({}))).toThrow(/wrangler.jsonc is missing/);
  expect(() => readProjectConfig(project({ "wrangler.jsonc": "{ nope" }))).toThrow(/wrangler.jsonc cannot be read/);
  expect(() => readProjectConfig(project({ "wrangler.jsonc": "[]" }))).toThrow(/not a JSON object/);
  expect(exampleNames(project({ ".env.example": "# a\nA=\n\n# b\nB=x\n" }))).toEqual(["A", "B"]);
  expect(buildCommand({ build: { command: "  " } })).toBeUndefined();
});

test(".dev.vars text: each value in one pair of quotes, as celld's reader takes them off, a multi-line one too", () => {
  expect(dotenvText({ A: "plain", B: 'with "quotes" inside', C: "line 1\nline 2" }, "# header\n")).toBe('# header\nA="plain"\nB="with "quotes" inside"\nC="line 1\nline 2"\n');
  expect(dotenvText({})).toBe("");
});
