/**
 * The names agents give by key: tools (`agent.tool`), extensions (`agent.extension`) and the model's provider (`model.provider`, the part of `provider/modelId` before the first slash). The runtime
 * resolves them only at start, so a name with no installed key is a project that composes and does
 * not start. `doctor` reports them; `remove` refuses to break one.
 *
 * What is not checked, because it is known only at start or at run time:
 * - a model id within its provider: the provider's model list is Pi's (`pi-ai`), read by the adapter;
 * - what `prepare(state)` names per run: only an agent's static fields are read;
 * - the agent a router names (`defaultAgent`, rules): that is each router's own config, not a
 *   contract the CLI can read; each router refuses it at start.
 *
 * A reference is checked only when an installed component uses its capability (the runtime): a
 * project with no runtime resolves no name, so nothing it names is broken.
 */

import type { Manifest } from "../registry/manifest.ts";
import type { AgentReferences, ProbeResult } from "./probe.ts";

type Composed = Extract<ProbeResult, { ok: true }>;

interface Kind {
  capability: string;
  /** What the agent names, and who provides it: `the tool "bash", which only tool-bash provides`. */
  describe(agent: AgentReferences, key: string, who: string): string;
  keys(agent: AgentReferences): string[];
}

const KINDS: Kind[] = [
  { capability: "agent.tool", describe: (_, key, who) => `the tool "${key}", which ${who} provides`, keys: (agent) => agent.tools },
  { capability: "agent.extension", describe: (_, key, who) => `the extension "${key}", which ${who} provides`, keys: (agent) => agent.extensions },
  {
    capability: "model.provider",
    describe: (agent, key, who) => `the model "${agent.model}", whose provider "${key}" ${who} provides`,
    keys: (agent) => {
      const key = modelProvider(agent.model);
      return key === undefined ? [] : [key];
    },
  },
];

/** The `model.provider` key a model names: the part of `provider/modelId` before the first slash. */
export function modelProvider(model: string): string | undefined {
  return model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
}

/** The registry components that provide `key` of `capability`. */
export type KeyProviders = (capability: string, key: string) => string[];

/**
 * The components of `manifests` that provide a key with their default config, as their generated
 * fields record it: a tool in `replay.tools`, a model provider in `modelProviders`. Nothing for a key
 * only a config gives (an MCP server's tools, `tool-mcp`'s) or for an extension.
 */
export function manifestProviders(manifests: readonly Manifest[]): KeyProviders {
  return (capability, key) =>
    manifests
      .filter((manifest) =>
        capability === "agent.tool" ? manifest.replay?.tools?.[key] !== undefined : capability === "model.provider" && (manifest.modelProviders ?? []).includes(key),
      )
      .map((manifest) => manifest.name);
}

/**
 * The references that are broken now, or, with `removing`, that removing that component would
 * break: the keys only it provides. The agents it provides itself go with it. With `providers`, a
 * broken one names what to install.
 */
export function brokenReferences(result: Composed, removing?: string, providers?: KeyProviders): string[] {
  const { components, capabilities } = result.description;
  const broken: string[] = [];
  for (const kind of KINDS) {
    const used = components.some((c) => c.name !== removing && [...c.requires, ...c.optional].includes(kind.capability));
    if (!used) continue;
    const owners = capabilities[kind.capability]?.keys ?? {};
    for (const agent of result.agents) {
      if (agent.component === removing) continue;
      for (const key of kind.keys(agent)) {
        const owner = owners[key];
        if (removing === undefined && owner === undefined) {
          const candidates = providers?.(kind.capability, key) ?? [];
          const install = candidates.length === 0 ? "" : `: install ${candidates.length === 1 ? candidates[0] : `one of ${candidates.join(", ")}`}`;
          broken.push(`agent "${agent.agent}" names ${kind.describe(agent, key, "no installed component")} (${kind.capability})${install}`);
        } else if (removing !== undefined && owner === removing) {
          broken.push(`agent "${agent.agent}" names ${kind.describe(agent, key, `only ${removing}`)}`);
        }
      }
    }
  }
  return broken;
}
