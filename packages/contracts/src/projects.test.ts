import { describe, expect, test } from "bun:test";
import type { ProjectSearchHit } from "./projects.ts";
import {
  addedToProject,
  authorOf,
  estimateTokens,
  formatItemRef,
  isProjectId,
  linkUrlProblem,
  memberIsCurrent,
  mergeSearchHits,
  parseCaller,
  parseItemRef,
  ProjectError,
  projectNameProblem,
  projectSpace,
  restoreNeedsOwner,
  roleOfMembers,
} from "./projects.ts";

const ana = { channel: "web", id: "u-ana" };
const eva = { channel: "googlechat", id: "users/31" };

test("ids, spaces, names, tokens", () => {
  expect(isProjectId("3f2a9c1b3f2a9c1b3f2a9c1b3f2a9c1b")).toBe(true);
  expect(isProjectId("3F2A9C1B3F2A9C1B3F2A9C1B3F2A9C1B")).toBe(false);
  expect(isProjectId("project:3f2a")).toBe(false);
  expect(projectSpace("abc")).toBe("project:abc");
  expect(projectNameProblem("AECC 2027")).toBeUndefined();
  expect(projectNameProblem(" ")).toBeDefined();
  expect(projectNameProblem("two\nlines")).toBeDefined();
  expect(projectNameProblem("x".repeat(61))).toBeDefined();
  expect(estimateTokens(0)).toBe(0);
  expect(estimateTokens(5)).toBe(2);
});

test("links: absolute http(s), no user or password", () => {
  expect(linkUrlProblem("https://drive.google.com/drive/folders/1")).toBeUndefined();
  for (const bad of ["", "drive.google.com", "javascript:alert(1)", "ftp://x.example.com", "https://user:pw@example.com", `https://example.com/${"a".repeat(2050)}`]) {
    expect(linkUrlProblem(bad)).toBeDefined();
  }
});

describe("callers", () => {
  test("authorOf: a person is the session's first principal; an agent its chat and the person it answered", () => {
    expect(authorOf({ kind: "people", principals: [ana, eva], conversation: "web:u-ana:c1" })).toEqual({ kind: "person", principal: ana, conversation: "web:u-ana:c1" });
    expect(authorOf({ kind: "agent", agent: "trader", conversation: "k", space: "project:1", for: eva })).toEqual({ kind: "agent", agent: "trader", conversation: "k", for: eva });
    expect(authorOf({ kind: "operator", id: "admin" })).toEqual({ kind: "operator", id: "admin" });
    expect(() => authorOf({ kind: "people", principals: [] })).toThrow(ProjectError);
  });

  test("parseCaller: checked and copied; malformed is invalid", () => {
    expect(parseCaller({ kind: "people", principals: [{ ...ana, extra: true }] })).toEqual({ kind: "people", principals: [ana] });
    expect(parseCaller({ kind: "agent", agent: "a", conversation: "k", space: "s" })).toEqual({ kind: "agent", agent: "a", conversation: "k", space: "s" });
    for (const bad of [null, { kind: "people", principals: [] }, { kind: "people", principals: [{ channel: "web" }] }, { kind: "agent", agent: "a", conversation: "k" }, { kind: "x" }]) {
      let code: unknown;
      try {
        parseCaller(bad);
      } catch (error) {
        code = (error as ProjectError).code;
      }
      expect(code).toBe("invalid");
    }
  });
});

test("roleOf's rule: owner wins, a stale sourced member has none, a manual member never expires", () => {
  const members = [
    { principal: ana, role: "member" as const, source: "manual", checkedAt: 0 },
    { principal: eva, role: "member" as const, source: "googlechat:spaces/AAA", checkedAt: 1_000 },
    { principal: { channel: "web", id: "u-owner" }, role: "owner" as const, source: "manual", checkedAt: 0 },
  ];
  expect(roleOfMembers(members, [ana], 10_000_000, 1_000)).toBe("member");
  expect(roleOfMembers(members, [eva], 2_000, 1_000)).toBe("member");
  expect(roleOfMembers(members, [eva], 2_001, 1_000)).toBeUndefined();
  expect(roleOfMembers(members, [ana, { channel: "web", id: "u-owner" }], 0, 1_000)).toBe("owner");
  expect(roleOfMembers(members, [{ channel: "web", id: "u-x" }], 0, 1_000)).toBeUndefined();
  expect(memberIsCurrent({ source: "manual", checkedAt: 0 }, Number.MAX_SAFE_INTEGER, 1)).toBe(true);
});

test("owner-only restores: the record and its members", () => {
  expect(restoreNeedsOwner({ item: { kind: "member", id: "x", title: "x" } })).toBe(true);
  expect(restoreNeedsOwner({ item: { kind: "project", id: "x", title: "x" } })).toBe(true);
  expect(restoreNeedsOwner({ item: { kind: "document", id: "x", title: "x" } })).toBe(false);
});

test("item refs round-trip; anything else is none", () => {
  for (const ref of [
    { kind: "document" as const, id: "d-91c2" },
    { kind: "file" as const, id: "report: Q1.pdf" },
    { kind: "rule" as const, id: "r-3f2a9c1b" },
  ]) {
    expect(parseItemRef(formatItemRef(ref))).toEqual(ref);
  }
  expect(formatItemRef({ kind: "instructions", id: "" })).toBe("instructions");
  expect(parseItemRef("instructions")).toEqual({ kind: "instructions", id: "" });
  for (const bad of ["", "document", "document:", "secret:x", ":x", "instructions:x"]) expect(parseItemRef(bad)).toBeUndefined();
});

test("mergeSearchHits: one from each list in turn, each ref once, at most limit", () => {
  const hit = (ref: string): ProjectSearchHit => ({ ref, kind: "note", title: ref, snippet: ref, at: 0 });
  const merged = mergeSearchHits(
    [
      [hit("document:a"), hit("document:b"), hit("document:c")],
      [hit("note:x"), hit("document:a")],
      [hit("file:f")],
    ],
    5,
  );
  expect(merged.map((each) => each.ref)).toEqual(["document:a", "note:x", "file:f", "document:b", "document:c"]);
  expect(mergeSearchHits([[hit("a:1"), hit("a:2")]], 1).length).toBe(1);
  expect(mergeSearchHits([], 8)).toEqual([]);
});

test("the line a tool that adds to a project ends with", () => {
  expect(addedToProject("rule  Target CPA\n18 EUR")).toBe("Added to the project: rule Target CPA 18 EUR");
});
