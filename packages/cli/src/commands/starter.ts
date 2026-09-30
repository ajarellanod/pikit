/**
 * The files `pikit new` writes before it installs any component: the project's own part, which no
 * registry has. Every project starts the same way whatever preset it uses; a preset is only the
 * list of components `new` then adds.
 *
 * - `pikit.config.ts`, the composition root, listing the project's agents;
 * - one agent, `assistant` (`src/agents/assistant/agent.ts`), provided by `src/extensions/agents.ts`;
 * - Pi's own `permission-gate` example, unmodified, for agents that have `bash`;
 * - `package.json`, `tsconfig.json`, `.gitignore`, a README.
 *
 * Two lines depend on what gets installed, and only on that: `runtime-pi` is listed with the
 * permission gate loaded, and `router-basic` sends every message to `assistant`.
 *
 * A few depend on the project's target (`pikit new --target`): on Cloudflare, `pikit.config.ts` has
 * two Apps (SPEC C1), the agent's model is one whose provider runs there (`STARTER_MODEL`, unless the
 * preset declares its `model`), and `.gitignore` and the README say so. What a component needs in
 * `package.json` (deployment-cloudflare's `wrangler`) its `component.json` declares, and `pikit add`
 * installs it: never the starter.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES_DIR, PIKIT_ROOT } from "../paths.ts";
import type { ComponentEntry } from "../project/config-file.ts";
import { EXTENSION_ALIAS } from "../project/vendor.ts";

export const STARTER_AGENT = "assistant";

/** How `pikit.config.ts` lists a component when the starter wires it differently from its default export. */
export const STARTER_WIRING: Record<string, Omit<ComponentEntry, "name">> = {
  "runtime-pi": { importClause: "{ createRuntimePi }", entry: "createRuntimePi({ extensions: [permissionGate] })" },
};

/** The starter's config values, written for the components that are installed. */
export const STARTER_CONFIG: Record<string, string> = {
  "router-basic": `{ defaultAgent: "${STARTER_AGENT}" }`,
};

export function packageJson(name: string, kit: Record<string, string>): string {
  const root = JSON.parse(readFileSync(join(PIKIT_ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
  // The versions this repository is checked with, pinned exactly.
  const pin = (pkg: string): string => (root.devDependencies[pkg] ?? "").replace(/^[\^~]/, "");
  const pkg = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    engines: { bun: ">=1.4.0" },
    scripts: { dev: "pikit dev", doctor: "pikit doctor", test: "bun test", typecheck: "tsc --noEmit" },
    dependencies: {
      [EXTENSION_ALIAS]: kit["@pikit/pi-extension-shim"],
      "@pikit/contracts": kit["@pikit/contracts"],
      "@pikit/core": kit["@pikit/core"],
    },
    devDependencies: {
      "@types/bun": pin("@types/bun"),
      typescript: pin("typescript"),
    },
    // Kit packages depend on each other by version, which npm does not have yet: every one of them
    // resolves to its tarball in vendor/, and there is one copy of each (`project/vendor.ts`).
    overrides: kit,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function tsconfig(): string {
  const base = JSON.parse(readFileSync(join(PIKIT_ROOT, "tsconfig.base.json"), "utf8")) as { compilerOptions: unknown };
  return `${JSON.stringify({ compilerOptions: base.compilerOptions, exclude: ["node_modules", "vendor", ".pikit"] }, null, 2)}\n`;
}

export const GITIGNORE = `node_modules/
# Secrets: pikit configure writes them here (mode 0600). Never committed, never in an image.
.env
.env.*
!.env.example
# State: sessions, conversations, model credentials, the agents' workspace.
.pikit/
`;

/** `.gitignore` for a project on `target`. */
export function gitignore(target = "server"): string {
  if (target !== "cloudflare") return GITIGNORE;
  return `${GITIGNORE}# wrangler's own: local secrets, the local objects' state and its build cache.
.dev.vars*
.wrangler/
`;
}

export const CONFIG = `/**
 * The composition root: everything that runs is listed in \`components\`, and nothing
 * else runs. Follow the imports to read it all.
 *
 * \`pikit add\` and \`pikit remove\` edit this file: one import line per component, one entry per line
 * in \`components\`, and one key per component in \`config\`. Edit it yourself too; keep that shape.
 */

import { defineApp } from "@pikit/core";
import agents from "./src/extensions/agents.ts";
// Pi's own permission-gate extension, unmodified: it blocks \`rm -rf\`, \`sudo\` and \`chmod 777\` in
// \`bash\`. A policy, not a sandbox.
import permissionGate from "./src/extensions/permission-gate.ts";

/** Values, not behaviour, under each component's name. Paths are relative to the project. */
export const config = {};

export default defineApp({
  components: [
    agents,
  ],
  config,
});
`;

/**
 * The composition root of a project on Cloudflare: two Apps (SPEC C1). `pikit add` lists components in
 * the default export, the object's App, and, as their `component.json`'s `apps` says, their Worker half
 * (or themselves) in `worker`.
 */
export const CLOUDFLARE_CONFIG = `/**
 * The composition root of a project on Cloudflare: two Apps (SPEC C1), and everything
 * that runs is listed in their \`components\`. Follow the imports to read it all.
 *
 * - The default export runs in each conversation's Durable Object: the channel's other half, the
 *   router, the runtime, sessions, storage, delivery. \`pikit add\` lists every component here.
 * - \`worker\` runs in the Worker, which receives every request first: the ingress half of each
 *   channel, the mailbox, secrets. The Worker checks and routes; the object owns the conversation.
 *   \`pikit add\` lists here a component's Worker half (\`channelTelegramWebhookWorker\`, configured
 *   under \`"channel-telegram-webhook-worker"\` in \`workerConfig\`), or a component that works in both
 *   Apps (\`secrets-cloudflare\`).
 *
 * \`pikit add\` and \`pikit remove\` edit this file: one import line per component, one entry per line
 * in \`components\`, and one key per component in \`config\`. Edit it yourself too; keep that shape.
 * deployment-cloudflare runs both Apps (\`src/pikit/deployment-cloudflare/worker.ts\`).
 */

import { defineApp } from "@pikit/core";
import agents from "./src/extensions/agents.ts";
// Pi's own permission-gate extension, unmodified: it blocks \`rm -rf\`, \`sudo\` and \`chmod 777\` in
// \`bash\`. A policy, not a sandbox.
import permissionGate from "./src/extensions/permission-gate.ts";

/** Values, not behaviour, under each component's name: the object's App. */
export const config = {};

/** Each conversation's Durable Object runs this App. */
export default defineApp({
  components: [
    agents,
  ],
  config,
});

/** The Worker's config, under each of its components' names. */
export const workerConfig = {};

/** The Worker runs this App: its components' \`http.route\`s are what it serves, besides \`GET /health\`. */
export const worker = defineApp({
  components: [
  ],
  config: workerConfig,
});
`;

/** `pikit.config.ts` for a project on `target`. */
export function configFile(target = "server"): string {
  return target === "cloudflare" ? CLOUDFLARE_CONFIG : CONFIG;
}

/**
 * The starter agent's model, by the project's target, when the preset declares none: one whose provider
 * runs there. On a server, Anthropic's (`provider-anthropic`, which the server presets install). On
 * Cloudflare, OpenRouter's (`provider-openrouter`, with an API key): `provider-anthropic` is
 * server-only. `pikit new` refuses, before writing, a project that would not install its provider.
 */
export const STARTER_MODEL: Record<string, string> = {
  server: "anthropic/claude-sonnet-4-6",
  cloudflare: "openrouter/z-ai/glm-5.3-flash",
};

export function starterModel(target = "server"): string {
  return STARTER_MODEL[target] ?? (STARTER_MODEL.server as string);
}

export function agent(tools: string[], model = starterModel()): string {
  const workspace =
    tools.length > 0
      ? `\n    "You work in a workspace directory: use your tools to read, write and edit files there, and to run commands in it.",`
      : "";
  return `import { defineAgent } from "@pikit/contracts";

/**
 * Your agent. Pi runs the loop; this file says who the agent is. It names the installed tools it may
 * use (\`tool-*\` components); installing a tool gives it to no agent that does not name it.
 * Change the model, the prompt and the tools here. \`defineAgent({ state, prepare })\` changes them per
 * run.
 */
export default defineAgent({
  name: "${STARTER_AGENT}",
  model: "${model}",
  systemPrompt: [
    "You are a helpful assistant reached over an HTTP API. Answer briefly and plainly.",${workspace}
  ].join(" "),
  tools: ${JSON.stringify(tools)},
});
`;
}

export const AGENTS = `/**
 * The project's agents, provided to the runtime under \`agent.definition\`. A project
 * component: it lives here, not in \`src/pikit/\`, because the agents are yours.
 */

import { defineComponent } from "@pikit/core";
import ${STARTER_AGENT} from "../agents/${STARTER_AGENT}/agent.ts";

export default defineComponent({
  name: "agents",
  setup(pikit) {
    pikit.provideKeyed("agent.definition", ${STARTER_AGENT}.name, ${STARTER_AGENT});
  },
});
`;

/** Pi's example, byte for byte: the adapter keeps the copy its compatibility tests run. */
export function permissionGate(): string {
  return readFileSync(join(PACKAGES_DIR, "pi-adapter", "src", "extensions", "pi-examples", "permission-gate.ts"), "utf8");
}

export function readme(name: string, components: string[], target = "server"): string {
  const run =
    target === "cloudflare"
      ? `pikit configure   # the variables in .env.example (they go up as the Worker's secrets), and a model API key
pikit doctor      # the component graph; green when everything is provided and configured
pikit dev         # run it here in workerd (wrangler dev), reloading on change
pikit up          # or deploy it to Cloudflare (deployment-cloudflare): then pikit status, logs`
      : `pikit configure   # the variables in .env.example, and a model login or API key
pikit doctor      # the component graph; green when everything is provided and configured
pikit dev         # run it here, reloading on change
pikit up          # or run it in Docker (deployment-docker): then pikit status, logs, down`;
  const composition =
    target === "cloudflare"
      ? "the composition root: two Apps, the default export in each conversation's Durable Object and `worker` in the Worker, and their config values"
      : "the composition root: every component that runs, and their config values";
  return `# ${name}

A pikit project: Pi runs the agents, and every other behaviour is source in \`src/pikit/\`, yours to
read, edit and remove.

| Path | What it is |
|---|---|
| \`pikit.config.ts\` | ${composition} |
| \`src/agents/\` | your agents (\`assistant\`) |
| \`src/extensions/\` | your own components (\`agents.ts\`) and Pi extensions (\`permission-gate.ts\`) |
| \`src/pikit/<component>/\` | installed components, with their tests and a README |
| \`pikit.json\` | what \`pikit add\` installed: registry, version, commit, and each file's hash |
| \`vendor/\` | \`@pikit/core\`, \`@pikit/contracts\`, \`@pikit/pi-adapter\` and \`@pikit/pi-extension-shim\`, until they are on npm |
| \`.env\` | secrets, written by \`pikit configure\` (mode 0600, never committed) |
| \`.pikit/\` | state: sessions, conversations, model credentials, the workspace |

Installed: ${components.length > 0 ? components.map((c) => `\`${c}\``).join(", ") : "nothing yet"}.

## Run it

\`\`\`sh
${run}
\`\`\`

## Change it

\`\`\`sh
pikit add <component>      # copy a component in and list it in pikit.config.ts
pikit remove <component>   # and take it out again, leaving the rest as it was
bun test                   # the installed components' own tests, and yours
\`\`\`

The installed files are yours: edit them. \`pikit doctor\` lists the ones you changed.
`;
}
