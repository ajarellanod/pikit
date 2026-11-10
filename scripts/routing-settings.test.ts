/**
 * router-rules' Routing section (`registry/components/router-rules/settings/`): its logic apart from
 * React, `rules.ts`. The section itself is checked by `bun scripts/dashboard-build.ts` (it compiles and
 * bundles) and by eye.
 */

import { expect, test } from "bun:test";
import { channelsOf, cleaned, covers, DENIED, groupsOf, idsIn, moved, placeIds, problemsOf, type Rule, withoutId } from "../registry/components/router-rules/settings/rules.ts";

test("channelsOf: each channel-* component's channel, in the order installed, then its accounts; other components left out", () => {
  const app = {
    components: [{ name: "channel-web" }, { name: "admin-api" }, { name: "channel-telegram" }, { name: "channel-http" }, { name: "channel-google-chat" }, { name: "channel-telegram-webhook" }, { name: "channel-slack" }],
    config: { "channel-telegram": { accounts: ["support", ""] }, "channel-telegram-webhook": { accounts: ["support", "ops"] } },
  };
  expect(channelsOf(app)).toEqual(["web", "telegram", "telegram:support", "http", "googlechat", "telegram:ops", "slack"]);
  expect(channelsOf({ components: [], config: {} })).toEqual([]);
});

test("channelsOf: Google Chat's named apps are its config's instances (googlechat:ops), and its Worker half's on Cloudflare, each once", () => {
  const server = { components: [{ name: "channel-google-chat" }, { name: "channel-web" }], config: { "channel-google-chat": { instances: ["ops", "", 7] } } };
  expect(channelsOf(server)).toEqual(["googlechat", "googlechat:ops", "web"]);
  const cloudflare = { components: [{ name: "channel-google-chat" }], config: { "channel-google-chat": { instances: ["ops"] }, "channel-google-chat-worker": { instances: ["ops", "sales"] } } };
  expect(channelsOf(cloudflare)).toEqual(["googlechat", "googlechat:ops", "googlechat:sales"]);
  expect(channelsOf({ components: [{ name: "channel-google-chat" }], config: { "channel-google-chat-worker": { instances: ["ops"] } } })).toEqual(["googlechat", "googlechat:ops"]);
  // accounts is Telegram's field, not Google Chat's; instances is not Telegram's.
  expect(channelsOf({ components: [{ name: "channel-google-chat" }, { name: "channel-telegram" }], config: { "channel-google-chat": { accounts: ["x"] }, "channel-telegram": { instances: ["y"] } } })).toEqual(["googlechat", "telegram"]);
});

test("idsIn: the ids of a pasted text, split at spaces, new lines, commas and semicolons, each once", () => {
  expect(idsIn("spaces/A, spaces/B\nspaces/C;spaces/A  spaces/D\t")).toEqual(["spaces/A", "spaces/B", "spaces/C", "spaces/D"]);
  expect(idsIn("  ,\n ")).toEqual([]);
});

test("cleaned: a rule as stored, texts trimmed, each list's ids trimmed and once; an empty list stays (never a catch-all)", () => {
  expect(cleaned({ channel: " web ", conversations: [" 1 ", "2", "1", ""], actors: ["  "], agent: "researcher" })).toEqual({ channel: "web", conversations: ["1", "2"], actors: [], agent: "researcher" });
  expect(cleaned({ channel: "", agent: "a" })).toEqual({ agent: "a" });
  expect(cleaned({ channel: "telegram", deny: true, reason: " spam ", agent: "x" })).toEqual({ channel: "telegram", deny: true, reason: "spam" });
  expect(cleaned({ deny: true, reason: "" })).toEqual({ deny: true });
  expect(cleaned({})).toEqual({ agent: "" });
});

test("covers: an earlier rule takes every message of a later one when each field it gives takes it (a kind takes its accounts, a list its own ids)", () => {
  expect(covers({ agent: "a" }, { channel: "web", agent: "b" })).toBe(true);
  expect(covers({ channel: "telegram", agent: "a" }, { channel: "telegram:support", agent: "b" })).toBe(true);
  expect(covers({ channel: "telegram:support", agent: "a" }, { channel: "telegram", agent: "b" })).toBe(false);
  expect(covers({ channel: "web", agent: "a" }, { agent: "b" })).toBe(false);
  expect(covers({ channel: "web", agent: "a" }, { channel: "web", actors: ["42"], agent: "b" })).toBe(true);
  expect(covers({ channel: "web", actors: ["42"], agent: "a" }, { channel: "web", agent: "b" })).toBe(false);
  expect(covers({ conversations: ["1"], agent: "a" }, { conversations: ["2"], agent: "b" })).toBe(false);
  // A list takes a later list only when it holds every id of it.
  expect(covers({ conversations: ["1", "2", "3"], agent: "a" }, { conversations: ["3", "1"], agent: "b" })).toBe(true);
  expect(covers({ conversations: ["1", "2"], agent: "a" }, { conversations: ["2", "4"], agent: "b" })).toBe(false);
  expect(covers({ conversations: ["1"], agent: "a" }, { agent: "b" })).toBe(false);
  expect(covers({ conversations: ["1"], agent: "a" }, { conversations: ["1"], actors: ["ana"], agent: "b" })).toBe(true);
  expect(covers({ conversations: ["1"], actors: ["ana"], agent: "a" }, { conversations: ["1"], agent: "b" })).toBe(false);
});

test("problemsOf: no agent, a channel with a space and an empty list are errors; a rule never reached, an agent that is none now, warnings", () => {
  const problems = problemsOf(
    [
      { channel: "web", agent: "researcher" },
      { channel: "web", actors: ["7"], agent: "assistant" },
      { channel: "telegram", agent: "" },
      { channel: "tele gram", deny: true },
      { channel: "http", agent: "gone" },
      { channel: "googlechat", actors: ["666"], deny: true, reason: "spam" },
      { channel: "googlechat", conversations: [], agent: "assistant" },
      { channel: "googlechat", conversations: ["spaces/A"], actors: [" "], agent: "assistant" },
    ],
    ["researcher", "assistant"],
  );
  expect(problems.map((problem) => problem?.level)).toEqual([undefined, "warning", "error", "error", "warning", undefined, "error", "error"]);
  expect(problems[1]?.text).toContain("rule 1 above");
  expect(problems[4]?.text).toContain("gone");
  expect(problems[6]?.text).toBe("No chats listed: add one, or take the condition away.");
  expect(problems[7]?.text).toBe("No senders listed: add one, or take the condition away.");
  // Agents not known yet: a name is not checked.
  expect(problemsOf([{ agent: "gone" }])).toEqual([undefined]);
  // A refused rule needs no agent.
  expect(problemsOf([{ deny: true }], [])).toEqual([undefined]);
});

test("problemsOf: a chat listed in two rules is a warning on the later one, naming the chat and the rule that takes it first", () => {
  const rules = [
    { channel: "googlechat", conversations: ["spaces/A", "spaces/B"], agent: "trader" },
    { channel: "googlechat", conversations: ["spaces/C"], agent: "designer" },
    { channel: "googlechat", conversations: ["spaces/B", "spaces/D"], agent: "designer" },
    { channel: "googlechat", conversations: ["spaces/A", "spaces/C", "spaces/E"], agent: "admin" },
    { channel: "googlechat", conversations: ["spaces/A", "spaces/C"], agent: "admin" },
  ];
  const problems = problemsOf(rules, ["trader", "designer", "admin"]);
  expect(problems.map((problem) => problem?.level)).toEqual([undefined, undefined, "warning", "warning", "warning"]);
  expect(problems[2]).toEqual({ level: "warning", text: "spaces/B: rule 1 above takes this chat first, so here it never matches.", shadowed: [{ field: "conversations", id: "spaces/B", by: 0 }] });
  expect(problems[3]?.text).toBe("2 of these are taken first by rules above (rule 1, rule 2), so here they never match.");
  expect(problems[3]?.shadowed?.map((each) => each.id)).toEqual(["spaces/A", "spaces/C"]);
  // Every id taken first: the whole rule is never used.
  expect(problems[4]?.text).toContain("Never used");
  // Not shadowed when the earlier rule asks more (a sender too), or is of another channel.
  expect(problemsOf([{ conversations: ["1"], actors: ["ana"], agent: "a" }, { conversations: ["1"], agent: "b" }], ["a", "b"])).toEqual([undefined, undefined]);
  expect(problemsOf([{ channel: "web", conversations: ["1"], agent: "a" }, { channel: "telegram", conversations: ["1"], agent: "b" }], ["a", "b"])).toEqual([undefined, undefined]);
  // Senders too.
  expect(problemsOf([{ actors: ["ana"], deny: true }, { actors: ["ana", "bob"], agent: "a" }], ["a"])[1]?.shadowed).toEqual([{ field: "actors", id: "ana", by: 0 }]);
});

test("groupsOf: rules by what they decide, each agent where its first rule is, the refusals last", () => {
  const rules = [
    { conversations: ["1"], agent: "trader" },
    { actors: ["666"], deny: true as const },
    { conversations: ["2"], agent: "admin" },
    { channel: "web", agent: "trader" },
  ];
  expect(groupsOf(rules)).toEqual([
    { outcome: "trader", rules: [0, 3] },
    { outcome: "admin", rules: [2] },
    { outcome: DENIED, rules: [1] },
  ]);
  expect(groupsOf([])).toEqual([]);
});

test("withoutId: an id taken out of one rule's list; a rule left with none is taken away, never left matching everything", () => {
  const rules = [
    { channel: "googlechat", conversations: ["spaces/A", "spaces/B"], agent: "trader" },
    { channel: "googlechat", conversations: ["spaces/C"], agent: "designer" },
  ];
  expect(withoutId(rules, 0, "conversations", "spaces/A")).toEqual([{ channel: "googlechat", conversations: ["spaces/B"], agent: "trader" }, rules[1] as Rule]);
  expect(withoutId(rules, 1, "conversations", "spaces/C")).toEqual([rules[0] as Rule]);
  // Another rule, or a list it does not have: unchanged.
  expect(withoutId(rules, 1, "conversations", "spaces/A")).toEqual(rules);
  expect(withoutId(rules, 0, "actors", "spaces/A")).toEqual(rules);
});

test("placeIds: chats join the agent's list, leaving the other agents' lists of that channel; a chat is one agent's", () => {
  const rules = [
    { channel: "googlechat", conversations: ["spaces/A", "spaces/B"], agent: "trader" },
    { channel: "googlechat", conversations: ["spaces/C"], agent: "designer" },
    { channel: "googlechat", conversations: ["spaces/B"], actors: ["ana"], agent: "admin" },
    { channel: "web", conversations: ["spaces/A"], agent: "admin" },
    { channel: "googlechat", deny: true as const },
  ];
  const moved = placeIds(rules, "designer", "googlechat", "conversations", ["spaces/A", "spaces/D"]);
  expect(moved.at).toBe(1);
  expect(moved.rules).toEqual([
    { channel: "googlechat", conversations: ["spaces/B"], agent: "trader" },
    { channel: "googlechat", conversations: ["spaces/C", "spaces/A", "spaces/D"], agent: "designer" },
    // Not a plain list of chats (it asks for a sender too), or another channel's: left as they are.
    rules[2] as Rule,
    rules[3] as Rule,
    rules[4] as Rule,
  ]);
  // The last chat of a list moved: its rule goes, and the place found counts it.
  const emptied = placeIds(rules, "trader", "googlechat", "conversations", ["spaces/C"]);
  expect(emptied.rules.map((rule) => rule.agent ?? "deny")).toEqual(["trader", "admin", "admin", "deny"]);
  expect(emptied.rules[0]?.conversations).toEqual(["spaces/A", "spaces/B", "spaces/C"]);
  expect(emptied.at).toBe(0);
  const later = placeIds([{ conversations: ["x"], agent: "a" }, { conversations: ["y"], agent: "b" }], "b", undefined, "conversations", ["x"]);
  expect(later).toEqual({ rules: [{ conversations: ["y", "x"], agent: "b" }], at: 0 });
});

test("placeIds: a new agent's rule goes before the first rule that would take its chats first, else last; never where it cannot match", () => {
  const rules = [
    { channel: "googlechat", conversations: ["spaces/A", "spaces/B"], agent: "trader" },
    { channel: "googlechat", deny: true as const, reason: "no route" },
    { channel: "web", agent: "admin" },
  ];
  const added = placeIds(rules, "designer", "googlechat", "conversations", ["spaces/A", " spaces/Z ", "spaces/Z"]);
  expect(added.at).toBe(1);
  expect(added.rules).toEqual([
    { channel: "googlechat", conversations: ["spaces/B"], agent: "trader" },
    { channel: "googlechat", conversations: ["spaces/A", "spaces/Z"], agent: "designer" },
    rules[1] as Rule,
    rules[2] as Rule,
  ]);
  expect(problemsOf(added.rules, ["trader", "designer", "admin"])).toEqual([undefined, undefined, undefined, undefined]);
  // Nothing would take them first: last.
  expect(placeIds(rules, "admin", "telegram", "actors", ["7"])).toEqual({ rules: [...rules, { channel: "telegram", actors: ["7"], agent: "admin" }], at: 3 });
  // Refused: a deny rule of its own.
  expect(placeIds([], DENIED, "googlechat", "conversations", ["spaces/X"])).toEqual({ rules: [{ channel: "googlechat", conversations: ["spaces/X"], deny: true }], at: 0 });
});

test("moved: an item taken out and put back at its new place; out-of-range places are clamped", () => {
  expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(moved(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  expect(moved(["a", "b"], 0, 0)).toEqual(["a", "b"]);
});
