/**
 * The files `pikit new` writes before it installs any component: the project's own part, which no
 * registry has. Every project starts the same way whatever preset it uses; a preset is only the
 * list of components `new` then adds (SPEC §11).
 *
 * - `pikit.config.ts`, the composition root, listing the project's agents;
 * - one agent, `assistant` (`src/agents/assistant/agent.ts`), provided by `src/extensions/agents.ts`;
 * - Pi's own `permission-gate` example, unmodified (SPEC §6.2b), for agents that have `bash`;
 * - `package.json`, `tsconfig.json`, `.gitignore`, a README.
 *
 * Two lines depend on what gets installed, and only on that: `runtime-pi` is listed with the
 * permission gate loaded, and `router-basic` sends every message to `assistant`.
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
      "@pikit/core": kit["@pikit/core"],
    },
    devDependencies: { "@types/bun": pin("@types/bun"), typescript: pin("typescript") },
    // Kit packages depend on each other by version, which npm does not have yet: every one of them
    // resolves to its tarball in vendor/, and there is one copy of each (SPEC §10.5).
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

export const CONFIG = `/**
 * The composition root (SPEC §4.1): everything that runs is listed in \`components\`, and nothing
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

/** Values, not behaviour (SPEC §12), under each component's name. Paths are relative to the project. */
export const config = {};

export default defineApp({
  components: [
    agents,
  ],
  config,
});
`;

export function agent(tools: string[]): string {
  const workspace =
    tools.length > 0
      ? `\n    "You work in a workspace directory: use your tools to read, write and edit files there, and to run commands in it.",`
      : "";
  return `import { defineAgent } from "@pikit/core";

/**
 * Your agent. Pi runs the loop; this file says who the agent is. It names the installed tools it may
 * use (\`tool-*\` components); installing a tool gives it to no agent that does not name it.
 * Change the model, the prompt and the tools here. \`defineAgent({ state, prepare })\` changes them per
 * run (SPEC §6.2a).
 */
export default defineAgent({
  name: "${STARTER_AGENT}",
  model: "anthropic/claude-sonnet-4-6",
  systemPrompt: [
    "You are a helpful assistant reached over an HTTP API. Answer briefly and plainly.",${workspace}
  ].join(" "),
  tools: ${JSON.stringify(tools)},
});
`;
}

export const AGENTS = `/**
 * The project's agents, provided to the runtime under \`agent.definition\` (SPEC §6.1). A project
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

export function readme(name: string, components: string[]): string {
  return `# ${name}

A pikit project: Pi runs the agents, and every other behaviour is source in \`src/pikit/\`, yours to
read, edit and remove.

| Path | What it is |
|---|---|
| \`pikit.config.ts\` | the composition root: every component that runs, and their config values |
| \`src/agents/\` | your agents (\`assistant\`) |
| \`src/extensions/\` | your own components (\`agents.ts\`) and Pi extensions (\`permission-gate.ts\`) |
| \`src/pikit/<component>/\` | installed components, with their tests and a README |
| \`pikit.json\` | what \`pikit add\` installed: registry, version, commit, and each file's hash |
| \`vendor/\` | \`@pikit/core\`, \`@pikit/pi-adapter\` and \`@pikit/pi-extension-shim\`, until they are on npm |
| \`.env\` | secrets, written by \`pikit configure\` (mode 0600, never committed) |
| \`.pikit/\` | state: sessions, conversations, model credentials, the workspace |

Installed: ${components.length > 0 ? components.map((c) => `\`${c}\``).join(", ") : "nothing yet"}.

## Run it

\`\`\`sh
pikit configure   # the variables in .env.example, and a model login or API key
pikit doctor      # the component graph; green when everything is provided and configured
pikit dev         # run it here, reloading on change
pikit up          # or run it in Docker (deployment-docker): then pikit status, logs, down
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
