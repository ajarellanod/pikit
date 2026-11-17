import { describe, expect, test } from "bun:test";
import { CHANGE_TITLE_MAX, ChangeInputError, changeTitle, parseAuthor, parseChangePageRequest, parsePrincipal, pastRetention, principalKey, samePrincipal } from "./change.ts";

describe("parseAuthor", () => {
  test("each kind, copied with only its fields", () => {
    expect(parseAuthor({ kind: "person", principal: { channel: "web", id: "u1", name: " Ana ", extra: 1 }, conversation: "web:u1:c1", role: "admin" })).toEqual({
      kind: "person",
      principal: { channel: "web", id: "u1", name: "Ana" },
      conversation: "web:u1:c1",
    });
    expect(parseAuthor({ kind: "agent", agent: "trader", conversation: "k", for: { channel: "googlechat", id: "users/1" } })).toEqual({
      kind: "agent",
      agent: "trader",
      conversation: "k",
      for: { channel: "googlechat", id: "users/1" },
    });
    expect(parseAuthor({ kind: "operator", id: "admin" })).toEqual({ kind: "operator", id: "admin" });
    expect(parseAuthor({ kind: "component", name: "memory-summaries" })).toEqual({ kind: "component", name: "memory-summaries" });
  });

  test("anything else is refused, never quoting the value", () => {
    const bad: unknown[] = [
      null,
      "person",
      [],
      { kind: "robot" },
      { kind: "person" },
      { kind: "person", principal: { channel: "", id: "x" } },
      { kind: "person", principal: { channel: "web", id: "x", name: "two\nlines" } },
      { kind: "agent", agent: "trader" },
      { kind: "agent", agent: "trader", conversation: "k", for: "ana" },
      { kind: "operator", id: 3 },
      { kind: "component", name: "x".repeat(2000) },
    ];
    for (const value of bad) {
      expect(() => parseAuthor(value)).toThrow(ChangeInputError);
    }
    try {
      parseAuthor({ kind: "operator", id: { secret: "sk-ant-zzz" } });
    } catch (error) {
      expect(String(error)).not.toContain("sk-ant");
    }
  });
});

test("principals: the same identity whatever its name; one key each, a channel with ':' never colliding", () => {
  expect(samePrincipal({ channel: "web", id: "1", name: "A" }, { channel: "web", id: "1" })).toBe(true);
  expect(samePrincipal({ channel: "web", id: "1" }, { channel: "googlechat", id: "1" })).toBe(false);
  expect(principalKey({ channel: "telegram:ops", id: "1" })).not.toBe(principalKey({ channel: "telegram", id: "ops:1" }));
  expect(parsePrincipal({ channel: "web", id: "u1", name: "" })).toEqual({ channel: "web", id: "u1" });
});

test("changeTitle: one line, folded, cut to the most", () => {
  expect(changeTitle("  Target\n CPA   18 EUR ")).toBe("Target CPA 18 EUR");
  const long = changeTitle("word ".repeat(100));
  expect(long.length).toBeLessThanOrEqual(CHANGE_TITLE_MAX);
  expect(long.endsWith("...")).toBe(true);
});

test("retention and page requests", () => {
  expect(pastRetention(0, 365 * 86_400_000)).toBe(false);
  expect(pastRetention(0, 365 * 86_400_000 + 1)).toBe(true);
  expect(parseChangePageRequest({ limit: 10 })).toEqual({ limit: 10 });
  expect(parseChangePageRequest({ limit: 10, before: 5 })).toEqual({ limit: 10, before: 5 });
  for (const bad of [{}, { limit: 0 }, { limit: 201 }, { limit: 1, before: 0 }, { limit: 1, before: 1.5 }]) expect(() => parseChangePageRequest(bad)).toThrow(ChangeInputError);
});
