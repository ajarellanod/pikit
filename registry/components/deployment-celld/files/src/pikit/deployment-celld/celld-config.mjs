/**
 * The Wrangler config celld accepts, derived from the project's `wrangler.jsonc` at each deploy and
 * each `pikit dev`: `wrangler.jsonc` stays the project's one Worker config (the same shape as on
 * Cloudflare, edited the same way), and `wrangler.celld.jsonc` is what `celld deploy` and `celld dev`
 * read. Nobody edits or commits the derived file: the deploy writes it (mode 0600, it holds the
 * secrets while the deploy runs) and deletes it after.
 *
 * What changes (celld 0.6, measured by the spike, features/deployment-celld.md):
 * - `build`, `observability` and `version_metadata` are dropped: celld refuses any key it does not
 *   know. `build.command` (the UI projects' build) is run by pikit before celld bundles
 *   (`runBuild`); `/health` reports `PIKIT_DEPLOYMENT` instead of the version binding.
 * - `name` is required: `wrangler.jsonc`'s own, else `package.json`'s, in the letters celld accepts.
 * - `rules` keep `type` and `globs` only (no `fallthrough`), and only the globs of the form
 *   `**\/*.ext`: celld maps a rule to an esbuild loader by extension. A rule naming a module
 *   (`@jitl/quickjs-wasmfile-release-sync/wasm`) is not needed there: esbuild resolves the import to
 *   its `.wasm` file, which celld's own `**\/*.wasm` rule compiles.
 * - `vars` gain the secrets (celld has no secrets, denoland/celld#190: they reach the Worker as
 *   variables, and land in the bucket's deployment manifest) and `PIKIT_DEPLOYMENT`, the id `/health`
 *   reports, so `pikit up` knows when the fleet serves what it deployed.
 *
 * Plain JavaScript with no dependency: Node runs it in CI (`deploy.mjs`) as well as Bun under pikit.
 * Its types are in `celld-config.d.mts`.
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** The project's Worker config: the source of truth. */
export const PROJECT_CONFIG = "wrangler.jsonc";
/** What celld reads, written at the project's root (celld resolves `main` from the config's directory). */
export const GENERATED_CONFIG = "wrangler.celld.jsonc";
/** The variable `/health` reports as its version: a new id at each deploy. */
export const DEPLOYMENT_VAR = "PIKIT_DEPLOYMENT";

/** Keys of `wrangler.jsonc` that are Cloudflare's only, and what stands for each on celld. */
export const CLOUDFLARE_ONLY = {
  build: "pikit runs build.command itself before celld bundles",
  observability: "Workers Logs: on celld, each node's own log (`pikit logs`), or CELLD_OTEL",
  version_metadata: `celld has no version binding: /health reports ${DEPLOYMENT_VAR}`,
};

/** JSON with comments and trailing commas, as wrangler and celld read it. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("an unterminated /* comment");
      i = end + 1;
    } else if (c === "}" || c === "]") {
      out = `${out.replace(/,\s*$/, "")}${c}`;
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/** The project's `wrangler.jsonc`, parsed; it throws, naming the file, when it is missing or malformed. */
export function readProjectConfig(cwd) {
  const path = join(cwd, PROJECT_CONFIG);
  if (!existsSync(path)) throw new Error(`${PROJECT_CONFIG} is missing: deployment-celld deploys the Worker it describes (\`pikit upgrade deployment-celld\` writes it again)`);
  let config;
  try {
    config = parseJsonc(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${PROJECT_CONFIG} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error(`${PROJECT_CONFIG} is not a JSON object`);
  return config;
}

/** celld's rule for a Worker's name: 1 to 63 lowercase ASCII letters, digits and internal hyphens. */
const SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The Worker's name: `wrangler.jsonc`'s `name` when it has one, else `package.json`'s, in the letters
 * celld accepts (`my_bot.v2` becomes `my-bot-v2`). Two projects on one bucket would deploy over each
 * other: give each fleet its bucket, or its prefix (`s3://bucket/prefix`).
 */
export function scriptName(cwd, project = {}) {
  if (typeof project.name === "string" && project.name !== "") {
    if (!SCRIPT_NAME.test(project.name)) throw new Error(`${PROJECT_CONFIG}'s name "${project.name}" is not one celld accepts: 1 to 63 lowercase letters, digits and inner hyphens`);
    return project.name;
  }
  const path = join(cwd, "package.json");
  if (!existsSync(path)) throw new Error(`${cwd} has no package.json: the Worker is named after its "name"`);
  const { name } = JSON.parse(readFileSync(path, "utf8"));
  if (typeof name !== "string" || name === "") throw new Error(`package.json has no "name": the Worker is named after it`);
  const script = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (script === "") throw new Error(`package.json's name "${name}" has no letter or digit to name a Worker with`);
  return script;
}

/** A glob celld maps to an esbuild loader: `**\/*.ext` or `*.ext`. */
const EXTENSION_GLOB = /^(?:\*\*\/)?\*\.[^*?./\\[{]+$/;

/** `rules` as celld takes them: `type` and `globs` only, extension globs only, no rule left empty. */
export function celldRules(rules) {
  if (!Array.isArray(rules)) throw new Error(`${PROJECT_CONFIG}'s rules is not an array`);
  return rules.flatMap((rule) => {
    const globs = Array.isArray(rule?.globs) ? rule.globs.filter((glob) => typeof glob === "string" && EXTENSION_GLOB.test(glob)) : [];
    return globs.length === 0 ? [] : [{ type: rule.type, globs }];
  });
}

/** A Worker binding's name, as celld checks a variable's (and a JavaScript identifier is). */
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every binding name of `project` that is not a variable: a secret of the same name would shadow it. */
function bindingNames(project) {
  const names = new Set();
  const add = (list, field = "binding") => {
    if (Array.isArray(list)) for (const entry of list) if (typeof entry?.[field] === "string") names.add(entry[field]);
  };
  add(project.durable_objects?.bindings, "name");
  add(project.kv_namespaces);
  add(project.d1_databases);
  add(project.r2_buckets);
  add(project.services);
  add(project.workflows);
  add(project.queues?.producers);
  add(project.worker_loaders);
  if (typeof project.assets?.binding === "string") names.add(project.assets.binding);
  return names;
}

/**
 * The config celld deploys: `project` (a parsed `wrangler.jsonc`) without its Cloudflare-only keys,
 * named `name`, its rules as celld takes them, and its `vars` plus `secrets` and the deployment's id
 * (`DEPLOYMENT_VAR`). A secret may not take the name of a variable of `wrangler.jsonc` (which value
 * would win is not obvious), of another binding, or the reserved `PIKIT_DEPLOYMENT`.
 */
export function celldConfig(project, { name, secrets = {}, deployment }) {
  if (typeof deployment !== "string" || deployment === "") throw new Error("a deployment id is required");
  const own = project.vars ?? {};
  if (typeof own !== "object" || own === null || Array.isArray(own)) throw new Error(`${PROJECT_CONFIG}'s vars is not an object`);
  const taken = bindingNames(project);
  for (const [key, value] of Object.entries(own)) {
    if (typeof value !== "string") throw new Error(`${PROJECT_CONFIG}'s var ${key} is not a string: celld takes string vars only`);
    if (key === DEPLOYMENT_VAR) throw new Error(`${PROJECT_CONFIG} sets ${DEPLOYMENT_VAR}, which deployment-celld sets at each deploy: remove it`);
  }
  for (const key of Object.keys(secrets)) {
    if (!BINDING.test(key)) throw new Error(`the variable "${key}" cannot reach the Worker: a binding's name is letters, digits and _, not starting with a digit`);
    if (key === DEPLOYMENT_VAR) throw new Error(`${DEPLOYMENT_VAR} is deployment-celld's own: take it out of .env`);
    if (key in own) throw new Error(`${key} is both a var of ${PROJECT_CONFIG} and a secret: keep one`);
    if (taken.has(key)) throw new Error(`${key} is a secret and the name of another binding of ${PROJECT_CONFIG}: rename one`);
  }
  const config = { name };
  for (const [key, value] of Object.entries(project)) {
    if (key === "name" || key === "vars" || key === "rules" || Object.hasOwn(CLOUDFLARE_ONLY, key)) continue;
    config[key] = value;
  }
  if (project.rules !== undefined) {
    const rules = celldRules(project.rules);
    if (rules.length > 0) config.rules = rules;
  }
  config.vars = { ...own, ...secrets, [DEPLOYMENT_VAR]: deployment };
  return config;
}

/**
 * Variables that stay on the machine that deploys, never the Worker's: the bucket's credentials and
 * location (celld's, the AWS SDK's, Azure's, Google's), deployment-celld's own settings, and
 * Cloudflare's.
 */
export function isMachineVariable(name) {
  return (
    /^(CELLD_|AWS_|AZURE_|PIKIT_CELLD_|CLOUDFLARE_)/.test(name) ||
    ["S3_ENDPOINT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_KEY", "RUST_LOG"].includes(name)
  );
}

/** `entries`' values for the Worker: set, and not the machine's (`isMachineVariable`). */
export function workerSecrets(entries) {
  const secrets = {};
  for (const [name, value] of Object.entries(entries)) {
    if (value === undefined || value === "" || isMachineVariable(name)) continue;
    secrets[name] = value;
  }
  return secrets;
}

/** The project's `.env`, or nothing. */
export function readDotEnv(cwd) {
  const path = join(cwd, ".env");
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

/** The names `.env.example` lists: the variables the installed components read (and any you add). */
export function exampleNames(cwd) {
  const path = join(cwd, ".env.example");
  return existsSync(path) ? Object.keys(parseEnv(readFileSync(path, "utf8"))) : [];
}

const HEADER =
  "// Written by deployment-celld from wrangler.jsonc for `celld deploy` / `celld dev`, and deleted after.\n" +
  "// Never edit it (edit wrangler.jsonc), never commit it: during a deploy it holds .env's secrets.\n";

/**
 * Writes `text` to `path`, created anew readable by its owner only (0600): a file left by a previous
 * run is removed first, so its mode never carries over.
 */
export function writePrivate(path, text) {
  rmSync(path, { force: true });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Writes `config` as the generated config in `cwd`; returns its path. */
export function writeGeneratedConfig(cwd, config) {
  const path = join(cwd, GENERATED_CONFIG);
  writePrivate(path, `${HEADER}${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/**
 * dotenv text of `entries` (`.dev.vars` for `celld dev`). celld's reader takes one pair of quotes off
 * and nothing else (no escapes), and joins a quoted value over lines: each value goes in double quotes
 * as it is.
 */
export function dotenvText(entries, header = "") {
  const lines = Object.entries(entries).map(([name, value]) => `${name}="${value}"`);
  return `${header}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** The UI build `wrangler.jsonc` declares (`build.command`), run before every bundle; undefined without one. */
export function buildCommand(project) {
  const command = project.build?.command;
  return typeof command === "string" && command.trim() !== "" ? command : undefined;
}
