import { expect, test } from "bun:test";
import { type AgentTool, defineAgent, defineSkill, SKILL_TOOL, skillProblem } from "./index.ts";

const REVIEW = `---
name: code-review
description: Reviews a change for bugs and risky patterns. Use when asked to review a diff or a pull request.
license: MIT
metadata:
  author: someone
  version: "1.0"
---

# Code review

1. Read the diff.
2. Run \`scripts/lint.sh\`.
`;

test("defineSkill reads a SKILL.md: name and description from the frontmatter, the body as instructions", () => {
  expect(defineSkill(REVIEW)).toEqual({
    name: "code-review",
    description: "Reviews a change for bugs and risky patterns. Use when asked to review a diff or a pull request.",
    instructions: "# Code review\n\n1. Read the diff.\n2. Run `scripts/lint.sh`.",
  });
  expect(defineSkill(REVIEW, { location: "/app/skills/code-review", name: "code-review" }).location).toBe("/app/skills/code-review");
});

test("defineSkill reads folded and literal blocks, quoted values, CRLF lines and a BOM", () => {
  const folded = defineSkill(
    "\uFEFF---\r\nname: 'dv360-setup'\r\ndescription: >\r\n  Checklist to set up\r\n  campaigns.\r\n\r\n  Use it before activating.\r\nversion: 3.0.0\r\n---\r\nBody\r\n",
  );
  expect(folded).toEqual({ name: "dv360-setup", description: "Checklist to set up campaigns.\nUse it before activating.", instructions: "Body" });

  const literal = defineSkill('---\nname: "notes"\ndescription: |\n  First line\n  Second line\n---\n');
  expect(literal).toEqual({ name: "notes", description: "First line\nSecond line", instructions: "" });

  expect(defineSkill("---\nname: plain\ndescription: Does a thing # not this\n---\nx").description).toBe("Does a thing");
});

test("defineSkill refuses what is not a skill, saying why", () => {
  expect(() => defineSkill("# no frontmatter")).toThrow("starts with a frontmatter");
  expect(() => defineSkill("---\ndescription: x\n---\n")).toThrow("lowercase letters, digits and single hyphens");
  expect(() => defineSkill("---\nname: Review\ndescription: x\n---\n")).toThrow("lowercase letters");
  expect(() => defineSkill("---\nname: a--b\ndescription: x\n---\n")).toThrow("single hyphens");
  expect(() => defineSkill(`---\nname: ${"a".repeat(65)}\ndescription: x\n---\n`)).toThrow("at most 64");
  expect(() => defineSkill("---\nname: review\n---\n")).toThrow("description must be text");
  expect(() => defineSkill(`---\nname: review\ndescription: ${"x".repeat(1025)}\n---\n`)).toThrow("1 to 1024");
  expect(() => defineSkill(REVIEW, { name: "review" })).toThrow('its folder is "review"');
});

test("skillProblem checks a skill given as data", () => {
  expect(skillProblem({ name: "ok", description: "d", instructions: "" })).toBeUndefined();
  expect(skillProblem({ name: "ok", description: "d" })).toContain("instructions must be text");
  expect(skillProblem({ name: "ok", description: "d", instructions: "", location: "" })).toContain("location must be a path");
  expect(skillProblem("review")).toContain("must be an object");
});

test("an agent has skills, once each, and never beside a tool of its own named skill", () => {
  const review = defineSkill(REVIEW);
  expect(defineAgent({ name: "coder", model: "faux/scripted", skills: [review] }).skills).toEqual([review]);
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", skills: [review, review] })).toThrow('skill "code-review" is given twice');
  // A name is an installed skill's (agent.skill), resolved by the runtime; it is still one name once.
  expect(defineAgent({ name: "coder", model: "faux/scripted", skills: ["deploy", review] }).skills).toEqual(["deploy", review]);
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", skills: ["code-review", review] })).toThrow('skill "code-review" is given twice');
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", skills: ["Review"] })).toThrow("must be lowercase letters");
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", skills: [3 as never] })).toThrow("must be an object");
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", tools: [SKILL_TOOL], skills: ["deploy"] })).toThrow(`a tool named "${SKILL_TOOL}"`);
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", tools: [SKILL_TOOL], skills: [review] })).toThrow(`a tool named "${SKILL_TOOL}"`);
  const own = { name: SKILL_TOOL } as unknown as AgentTool;
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", tools: [own], skills: [review] })).toThrow("rename the tool");
  // Without skills, a tool of that name is the agent's own.
  expect(defineAgent({ name: "coder", model: "faux/scripted", tools: [SKILL_TOOL] }).tools).toEqual([SKILL_TOOL]);
});
