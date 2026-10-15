/**
 * router-rules' Routing section (`registry/components/router-rules/settings/`): its logic apart from
 * React, `rules.ts`. The section itself is checked by `bun scripts/dashboard-build.ts` (it compiles and
 * bundles) and by eye.
 */

import { expect, test } from "bun:test";
import { channelsOf, cleaned, covers, moved, problemsOf } from "../registry/components/router-rules/settings/rules.ts";

test("channelsOf: each channel-* component's channel, in the order installed, then its accounts; other components left out", () => {
  const app = {
    components: [{ name: "channel-web" }, { name: "admin-api" }, { name: "channel-telegram" }, { name: "channel-http" }, { name: "channel-google-chat" }, { name: "channel-telegram-webhook" }, { name: "channel-slack" }],
    config: { "channel-telegram": { accounts: ["support", ""] }, "channel-telegram-webhook": { accounts: ["support", "ops"] } },
  };
  expect(channelsOf(app)).toEqual(["web", "telegram", "telegram:support", "http", "googlechat", "telegram:ops", "slack"]);
  expect(channelsOf({ components: [], config: {} })).toEqual([]);
});

test("cleaned: a rule as stored, texts trimmed, empty match fields gone; an agent, or a refusal with its reason", () => {
  expect(cleaned({ channel: " web ", conversation: "", actor: "  ", agent: "researcher" })).toEqual({ channel: "web", agent: "researcher" });
  expect(cleaned({ channel: "telegram", deny: true, reason: " spam ", agent: "x" })).toEqual({ channel: "telegram", deny: true, reason: "spam" });
  expect(cleaned({ deny: true, reason: "" })).toEqual({ deny: true });
  expect(cleaned({})).toEqual({ agent: "" });
});

test("covers: an earlier rule takes every message of a later one when each field it gives matches it (a kind takes its accounts)", () => {
  expect(covers({ agent: "a" }, { channel: "web", agent: "b" })).toBe(true);
  expect(covers({ channel: "telegram", agent: "a" }, { channel: "telegram:support", agent: "b" })).toBe(true);
  expect(covers({ channel: "telegram:support", agent: "a" }, { channel: "telegram", agent: "b" })).toBe(false);
  expect(covers({ channel: "web", agent: "a" }, { agent: "b" })).toBe(false);
  expect(covers({ channel: "web", agent: "a" }, { channel: "web", actor: "42", agent: "b" })).toBe(true);
  expect(covers({ channel: "web", actor: "42", agent: "a" }, { channel: "web", agent: "b" })).toBe(false);
  expect(covers({ conversation: "1", agent: "a" }, { conversation: "2", agent: "b" })).toBe(false);
});

test("problemsOf: no agent chosen and a channel with a space are errors; a rule never reached and an agent that is none now, warnings", () => {
  const problems = problemsOf(
    [
      { channel: "web", agent: "researcher" },
      { channel: "web", conversation: "", agent: "assistant" },
      { channel: "telegram", agent: "" },
      { channel: "tele gram", deny: true },
      { channel: "http", agent: "gone" },
      { channel: "googlechat", actor: "666", deny: true, reason: "spam" },
    ],
    ["researcher", "assistant"],
  );
  expect(problems.map((problem) => problem?.level)).toEqual([undefined, "warning", "error", "error", "warning", undefined]);
  expect(problems[1]?.text).toContain("rule 1 above");
  expect(problems[4]?.text).toContain("gone");
  // Agents not known yet: a name is not checked.
  expect(problemsOf([{ agent: "gone" }])).toEqual([undefined]);
  // A refused rule needs no agent.
  expect(problemsOf([{ deny: true }], [])).toEqual([undefined]);
});

test("moved: an item taken out and put back at its new place; out-of-range places are clamped", () => {
  expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(moved(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  expect(moved(["a", "b"], 0, 0)).toEqual(["a", "b"]);
});
