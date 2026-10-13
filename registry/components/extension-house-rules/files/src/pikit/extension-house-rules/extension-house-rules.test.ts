/**
 * extension-house-rules' tests. They are copied with the component and keep running in your project.
 *
 * A component never imports another's files (SPEC P4), so these check what the component provides and
 * what its section and hook decide. The same extension in a real App, through runtime-pi with a faux
 * model, is `app.test.ts` beside `files/` in the registry: in your project, a test of the project's own
 * (it may import `src/pikit/runtime-pi/`) does the same, as `src/pikit/runtime-pi/extensions.test.ts`.
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import type {} from "@pikit/pi-adapter";
import houseRules, { createHouseRules, HOUSE_RULES, houseRulesBlock, houseRulesText, senderBlock } from "./index.ts";

const config = { rules: ["Answer in English.", "Never share a customer's email address."], deniedTools: ["bash", "write"], senderTools: [] };
const none = { rules: [], deniedTools: [], senderTools: [] };

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [houseRules], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "extension-house-rules")).toMatchObject({
    provides: ["agent.extension"],
    requires: [],
    optional: [],
  });
  expect(app.describe().capabilities["agent.extension"]?.keys).toEqual({ "house-rules": "extension-house-rules" });
});

test("it provides one extension named like its key, with one section and one hook", () => {
  const extension = createHouseRules(config);

  expect(extension.name).toBe(HOUSE_RULES);
  expect(extension.sections?.map((section) => section.key)).toEqual(["house-rules"]);
  expect(extension.hooks?.map((hook) => hook.task)).toHaveLength(1);
  expect(extension.tools).toBeUndefined();
});

test("the section lists the rules and the refused tools; with neither, there is no section", async () => {
  expect(houseRulesText(config)).toBe(
    "- Answer in English.\n- Never share a customer's email address.\n- Do not call these tools, they are refused here: bash, write.",
  );
  expect(houseRulesText({ ...none, rules: ["Be brief."] })).toBe("- Be brief.");
  expect(houseRulesText(none)).toBeUndefined();
  expect(houseRulesText({ ...none, senderTools: [{ tool: "bash", senders: ["telegram:1"] }] })).toBe(
    "- These tools run only for some of the people you answer, and are refused for the others: bash.",
  );

  // The section renders the same text on every request: it reads nothing but config.
  const section = createHouseRules(config).sections?.[0];
  const input = {} as Parameters<NonNullable<typeof section>["render"]>[0];
  const first = await section?.render(input, {} as never);
  expect(await section?.render(input, {} as never)).toBe(first);
});

test("a denied tool is blocked with a reason the model reads; any other runs", () => {
  expect(houseRulesBlock(config, "bash")).toBe('The tool "bash" is not allowed here (house rules).');
  expect(houseRulesBlock(config, "read")).toBeUndefined();
  expect(houseRulesBlock(none, "bash")).toBeUndefined();
});

test("a tool kept for some senders runs only when every request of the run came from one of them", () => {
  const kept = { ...none, senderTools: [{ tool: "bash", senders: ["telegram:1", "dashboard:ops"] }] };
  const from = (channel: string, id: string) => ({ requestId: `${channel}-${id}`, sender: { channel, id } });

  expect(senderBlock(kept, "bash", [from("telegram", "1")])).toBeUndefined();
  expect(senderBlock(kept, "bash", [from("telegram", "1"), from("dashboard", "ops")])).toBeUndefined();
  expect(senderBlock(kept, "read", [from("telegram", "2")])).toBeUndefined();
  // Anyone else in the run, a request without a sender, or no run at all: refused.
  for (const requests of [[from("telegram", "1"), from("telegram", "2")], [{ requestId: "r1" }], [], undefined]) {
    expect(senderBlock(kept, "bash", requests)).toBe('The tool "bash" runs only for some senders, and this run answers someone else (house rules).');
  }
});

test("config is checked when the App is defined: an empty rule or a tool name a model cannot call is refused", () => {
  for (const bad of [{ rules: [""] }, { deniedTools: ["rm -rf"] }, { senderTools: [{ tool: "bash", senders: [] }] }, { senderTools: [{ tool: "bash", senders: ["alice"] }] }]) {
    expect(() => defineApp({ components: [houseRules], config: { "extension-house-rules": bad }, logger: silentLogger })).toThrow("/extension-house-rules/");
  }
});
