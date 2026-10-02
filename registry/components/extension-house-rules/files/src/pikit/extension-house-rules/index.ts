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
 *    again if the call is retried after a crash, so it decides from the call alone, with no effect.
 * 4. **The component** provides it as `agent.extension` under its name. An agent runs with it only
 *    when it names it; runtime-pi checks the name and the key match.
 * 5. **Config holds values** (the rules, the tool names), checked when the App is defined.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { defineComponent } from "@pikit/core";
import { defineExtension, type Extension, hook, section, ToolTask } from "@pikit/pi-adapter/extensions";
import Type, { type Static } from "typebox";

/** The name agents give it, its key under `agent.extension`, and its section's key. */
export const HOUSE_RULES = "house-rules";

const Config = Type.Object({
  /** Each rule, one line of the section. None: no section. */
  rules: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  /** Tools the agents that name this extension may not call, by the name the model calls them. */
  deniedTools: Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }), { default: [] }),
});

export type HouseRulesConfig = Static<typeof Config>;

/** The section's text: the rules as a list, and the tools refused. `undefined` when there is neither. */
export function houseRulesText(config: HouseRulesConfig): string | undefined {
  const lines = config.rules.map((rule) => `- ${rule}`);
  if (config.deniedTools.length > 0) lines.push(`- Do not call these tools, they are refused here: ${config.deniedTools.join(", ")}.`);
  return lines.length === 0 ? undefined : lines.join("\n");
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
        beforeTool: (call) => {
          const block = houseRulesBlock(config, call.name);
          return block === undefined ? undefined : { block };
        },
      }),
    ],
  });
}

export default defineComponent({
  name: "extension-house-rules",
  config: Config,
  setup(pikit, config) {
    pikit.provideKeyed("agent.extension", HOUSE_RULES, createHouseRules(config));
  },
});
