/**
 * extension-house-rules: house rules for the agents that name them (`extensions: ["house-rules"]`).
 * The rules in config are a system prompt section, and the tools in config are refused before they
 * run, whatever the model asks.
 *
 * A reference: this is how an agent extension component is built.
 * 1. **The extension** is pi-durable's `defineExtension`, from `@pikit/pi-adapter/extensions` (a
 *    component never imports Pi itself): a name, and what it brings (`sections`, `hooks`, `tools`,
 *    `wraps`, `tasks`).
 * 2. **A section** (`section(key, render)`) is part of the system prompt, rendered before every model
 *    request and wrapped as `<key>…</key>`; `undefined` leaves it out. This one is built from config
 *    once, so it is the same text on every request: pi-durable sends a section again only when it
 *    changes, and the provider's prompt cache stays warm.
 * 3. **A hook** (`hook(ToolTask, { beforeTool })`) sees every tool call before it runs. `{ block }`
 *    refuses it: nothing runs, and the model reads the reason as the call's error result. It runs
 *    again if the call is retried after a crash, so it decides from the call and what it reads, with
 *    no effect. It reads who the run answers from its context (`RUN_REQUESTS`: each request and its
 *    sender, as the channel authenticated it), never from the model: a tool kept for some senders
 *    runs only when every message of the run came from one of them.
 * 4. **The component** provides it as `agent.extension` under its name. An agent runs with it only
 *    when it names it; runtime-pi checks the name and the key match.
 * 5. **Config holds values** (the rules, the tool names), checked when the App is defined.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { type Context, defineComponent } from "@pikit/core";
import { RUN_REQUESTS, type RunRequest } from "@pikit/contracts";
import { defineExtension, type Extension, hook, section, ToolTask } from "@pikit/pi-adapter/extensions";
import Type, { type Static } from "typebox";

/** The name agents give it, its key under `agent.extension`, and its section's key. */
export const HOUSE_RULES = "house-rules";

const ToolName = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" });

const Config = Type.Object({
  /** Each rule, one line of the section. None: no section. */
  rules: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  /** Tools the agents that name this extension may not call, by the name the model calls them. */
  deniedTools: Type.Array(ToolName, { default: [] }),
  /**
   * Tools kept for some senders: each runs only in a run every message of which came from one of its
   * `senders`, written `<channel>:<id>` as the channel authenticated them (`telegram:12345`,
   * `dashboard:operator`). A run that answers anyone else, or a message with no sender, has the call
   * refused.
   */
  senderTools: Type.Array(Type.Object({ tool: ToolName, senders: Type.Array(Type.String({ minLength: 3, pattern: "^[^:]+:.+$" }), { minItems: 1 }) }), { default: [] }),
});

export type HouseRulesConfig = Static<typeof Config>;

/** The section's text: the rules as a list, and the tools refused. `undefined` when there is neither. */
export function houseRulesText(config: HouseRulesConfig): string | undefined {
  const lines = config.rules.map((rule) => `- ${rule}`);
  if (config.deniedTools.length > 0) lines.push(`- Do not call these tools, they are refused here: ${config.deniedTools.join(", ")}.`);
  const kept = config.senderTools.map((entry) => entry.tool);
  if (kept.length > 0) lines.push(`- These tools run only for some of the people you answer, and are refused for the others: ${kept.join(", ")}.`);
  return lines.length === 0 ? undefined : lines.join("\n");
}

/** A sender as `senderTools` writes it: `<channel>:<id>`. */
export const senderName = (request: RunRequest): string | undefined => (request.sender === undefined ? undefined : `${request.sender.channel}:${request.sender.id}`);

/**
 * Why a call to `tool` is refused for the run that answers `requests`, or `undefined` when it may run:
 * a tool of `senderTools` runs only when every request came from one of its senders.
 */
export function senderBlock(config: HouseRulesConfig, tool: string, requests: readonly RunRequest[] | undefined): string | undefined {
  const kept = config.senderTools.filter((entry) => entry.tool === tool);
  if (kept.length === 0) return undefined;
  const allowed = new Set(kept.flatMap((entry) => entry.senders));
  const others = (requests ?? []).filter((request) => !allowed.has(senderName(request) ?? ""));
  if (requests !== undefined && requests.length > 0 && others.length === 0) return undefined;
  return `The tool "${tool}" runs only for some senders, and this run answers someone else (house rules).`;
}

/** Why a call to `tool` is refused, or `undefined` when it may run. */
export function houseRulesBlock(config: HouseRulesConfig, tool: string): string | undefined {
  return config.deniedTools.includes(tool) ? `The tool "${tool}" is not allowed here (house rules).` : undefined;
}

/** The extension, for `config`. */
export function createHouseRules(config: HouseRulesConfig): Extension {
  // Rendered once: the same text on every request (see 2 above).
  const text = houseRulesText(config);
  return defineExtension({
    name: HOUSE_RULES,
    sections: [section(HOUSE_RULES, () => text)],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, context) => {
          const block = houseRulesBlock(config, call.name) ?? (await keptBlock(config, call.name, context));
          return block === undefined ? undefined : { block };
        },
      }),
    ],
  });
}

/** `senderBlock` for the run `context` belongs to; read only for a tool `senderTools` keeps. */
async function keptBlock(config: HouseRulesConfig, tool: string, context: Context): Promise<string | undefined> {
  if (!config.senderTools.some((entry) => entry.tool === tool)) return undefined;
  return senderBlock(config, tool, await context.value(RUN_REQUESTS)?.list(context));
}

export default defineComponent({
  name: "extension-house-rules",
  config: Config,
  setup(pikit, config) {
    pikit.provideKeyed("agent.extension", HOUSE_RULES, createHouseRules(config));
  },
});
