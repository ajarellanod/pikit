/**
 * The files `pikit new` writes before it installs any component: the project's own part, which no
 * registry has. Every project starts the same way whatever preset it uses; a preset is only the
 * list of components `new` then adds.
 *
 * - `pikit.config.ts`, the composition root, listing the project's agents;
 * - one agent, `assistant` (`src/agents/assistant/agent.ts`), provided by `src/extensions/agents.ts`;
 * - `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.gitattributes`, a README. A project may keep a
 *   registry of its own components in `registry/` (`pikit add <name> --registry registry` installs
 *   from it): `tsc` and `bun test` leave that folder out from the start, since the installed copy in
 *   `src/pikit/` is the one checked (two copies of one contract file that differ fail `tsc`, TS2717,
 *   and every test would run twice);
 * - the kit's skills for AI agents, `.agents/skills/` (`skillFiles`): how to write a component and an
 *   agent extension.
 *   They are the kit's, not a component's: no capability, nothing that runs, and every project gets
 *   them; a newer CLI's `pikit new` brings newer ones (an existing project copies them by hand).
 *
 * One line depends on what gets installed, and only on that: `router-basic` sends every message to
 * `assistant`.
 *
 * A few depend on the project's target (`pikit new --target`): on Cloudflare, `pikit.config.ts` has
 * two Apps (SPEC C1), the agent's model is one whose provider runs there (`STARTER_MODEL`, unless the
 * preset declares its `model`), and `.gitignore` and the README say so. What a component needs in
 * `package.json` (deployment-cloudflare's `wrangler`) its `component.json` declares, and `pikit add`
 * installs it: never the starter.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PIKIT_ROOT } from "../paths.ts";
import { DASHBOARD_DIR } from "../project/dashboard.ts";
import type { ComponentEntry } from "../project/config-file.ts";
import { starterModel } from "../project/starter-model.ts";

// The starter model lives with the check `registry validate` shares.
export { STARTER_MODEL, starterModel } from "../project/starter-model.ts";

export const STARTER_AGENT = "assistant";

/** How `pikit.config.ts` lists a component when the starter wires it differently from its default export. */
export const STARTER_WIRING: Record<string, Omit<ComponentEntry, "name">> = {};

/** The starter's config values, written for the components that are installed. */
export const STARTER_CONFIG: Record<string, string> = {
  "router-basic": `{ defaultAgent: "${STARTER_AGENT}" }`,
};

/** Where the skills for AI agents are, in the kit and in a project (the `.agents/skills/` convention). */
export const SKILLS_DIR = ".agents/skills";

/** The kit's skills, each file by its path in a project, sorted: what `pikit new` copies. */
export function skillFiles(root = PIKIT_ROOT): { path: string; text: string }[] {
  const dir = join(root, SKILLS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort()
    .map((file) => ({ path: `${SKILLS_DIR}/${file}`, text: readFileSync(join(dir, file), "utf8") }));
}

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

/** Where a project keeps a registry of its own components; `tsc` and `bun test` leave it out. */
export const PROJECT_REGISTRY = "registry";

/** The kit's compiler options (the same `lib` the components are checked with). */
export function tsconfig(): string {
  const base = JSON.parse(readFileSync(join(PIKIT_ROOT, "tsconfig.base.json"), "utf8")) as { compilerOptions: unknown };
  return `${JSON.stringify({ compilerOptions: base.compilerOptions, exclude: ["node_modules", "vendor", ".pikit", PROJECT_REGISTRY, DASHBOARD_DIR] }, null, 2)}\n`;
}

export const BUNFIG = `[test]
# ${PROJECT_REGISTRY}/ holds the source of your own components; their installed copies in src/pikit/ are the ones tested.
# ${DASHBOARD_DIR}/, when the project has a UI, is a project of its own, with its own toolchain.
pathIgnorePatterns = ["${PROJECT_REGISTRY}/**", "${DASHBOARD_DIR}/**"]
`;

export const GITIGNORE = `node_modules/
# Secrets: pikit configure writes them here (mode 0600). Never committed, never in an image.
.env
.env.*
!.env.example
# State: the database (conversations, the registry), model credentials, the agents' workspace.
.pikit/
`;

/**
 * `.gitattributes`: the dashboard's built files, a module of ~1 MB that its build writes into admin-api
 * (when the project has a UI), are generated: GitHub collapses them in a diff, and `git diff` says
 * only that they changed. Committed, so a clone runs and type-checks as it is; every deploy builds
 * them again (deployment-cloudflare's wrangler `build.command`, deployment-docker's image).
 */
export const GITATTRIBUTES = `# The dashboard's build writes this (src/dashboard/: bun run build); every deploy builds it again.
src/pikit/admin-api/dashboard-files.ts linguist-generated=true -diff
`;

/** `.gitignore` for a project on `target`. */
export function gitignore(target = "server"): string {
  if (target !== "durable") return GITIGNORE;
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
 *   router, the runtime, the registry, storage, delivery. \`pikit add\` lists every component here.
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
  return target === "durable" ? CLOUDFLARE_CONFIG : CONFIG;
}

/**
 * Where people reach the agent, per channel component, for the starter's prompt: the model answers
 * differently to a program calling an API and to a person in a chat. A channel not listed here is
 * named by its `component.json` title (the part before `:`).
 */
export const CHANNEL_REACH: Readonly<Record<string, string>> = {
  "channel-http": "reached over an HTTP API, by programs and the people behind them",
  "channel-telegram": "that people talk to in Telegram chats",
  "channel-telegram-webhook": "that people talk to in Telegram chats",
};

/** A channel being installed: its name and its `component.json` title. */
export interface StarterChannel {
  name: string;
  title?: string | undefined;
}

/** The starter prompt's first sentence: who the agent is, and where it is reached. */
export function introduction(channels: readonly StarterChannel[]): string {
  const reach = [
    ...new Set(channels.map((channel) => CHANNEL_REACH[channel.name] ?? `reached through ${(channel.title ?? channel.name).split(":")[0]?.trim()}`)),
  ];
  return reach.length === 0 ? "You are a helpful assistant." : `You are a helpful assistant ${reach.join(", and ")}.`;
}

export function agent(tools: string[], model = starterModel(), channels: readonly StarterChannel[] = []): string {
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
    ${JSON.stringify(`${introduction(channels)} Answer briefly and plainly.`)},${workspace}
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

export function readme(name: string, components: string[], target = "server", ui = false): string {
  const run =
    target === "durable"
      ? `pikit configure   # the variables in .env.example (they go up as the Worker's secrets), and a model API key
pikit doctor      # the component graph; green when everything is provided and configured
pikit dev         # run it here in workerd (wrangler dev), reloading on change
pikit up          # or deploy it to Cloudflare (deployment-cloudflare): then pikit status, logs`
      : `pikit configure   # the variables in .env.example, and a model login or API key
pikit doctor      # the component graph; green when everything is provided and configured
pikit dev         # run it here, reloading on change
pikit up          # or run it in Docker (deployment-docker): then pikit status, logs, down`;
  const composition =
    target === "durable"
      ? "the composition root: two Apps, the default export in each conversation's Durable Object and `worker` in the Worker, and their config values"
      : "the composition root: every component that runs, and their config values";
  return `# ${name}

A pikit project: Pi runs the agents, and every other behaviour is source in \`src/pikit/\`, yours to
read, edit and remove.

| Path | What it is |
|---|---|
| \`pikit.config.ts\` | ${composition} |
| \`src/agents/\` | your agents (\`assistant\`) |
| \`src/extensions/\` | your own components (\`agents.ts\`) |
| \`src/pikit/<component>/\` | installed components, each with its README and its tests |
| \`registry/\` | if you make one: your own components, to \`pikit add <name> --registry registry\` (\`tsc\` and \`bun test\` skip it and check the installed copy) |${ui ? "\n| \`src/dashboard/\` | the dashboard: a shadcn/ui project of its own (its README says how to run it and add a view), served at \`/admin/\` by \`admin-api\` |" : ""}
| \`pikit.json\` | what \`pikit add\` installed: registry, version, commit, and each file's hash |
| \`.agents/skills/\` | skills for your AI agent: how to write a component (\`pikit-component\`) and an agent extension (\`pikit-extension\`) for this project |
| \`vendor/\` | \`@pikit/core\`, \`@pikit/contracts\` and \`@pikit/pi-adapter\`, until they are on npm |
| \`.env\` | secrets, written by \`pikit configure\` (mode 0600, never committed) |
| \`.pikit/\` | state: the database (conversations, the registry), model credentials, the workspace |

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
