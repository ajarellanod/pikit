import { expect, test } from "bun:test";
import { credentialSettingProblem, SECRET_NAME_PATTERN, secretSettingProblem } from "./index.ts";

const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
/** A key in the shape of Anthropic's, which no test value may echo. */
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

test("secretSettingProblem: a string a key names as a secret must be a secret's name", () => {
  expect(secretSettingProblem(object({ apiKey: { type: "string" } }))).toContain("/apiKey would hold a secret");
  expect(secretSettingProblem(object({ botToken: { type: "string", minLength: 1 } }))).toContain("/botToken");
  expect(secretSettingProblem(object({ apiKey: { type: "string", pattern: SECRET_NAME_PATTERN } }))).toBeUndefined();
  expect(secretSettingProblem(object({ tokenSecret: { type: "string", enum: ["GITHUB_TOKEN", "OTHER_TOKEN"] } }))).toBeUndefined();
  expect(secretSettingProblem(object({ tokenSecret: { anyOf: [{ const: "GITHUB_TOKEN" }, { const: "OTHER_TOKEN" }] } }))).toBeUndefined();
  expect(secretSettingProblem(object({ tokenSecret: { anyOf: [{ const: "GITHUB_TOKEN" }, { const: "lowercase" }] } }))).toContain("/tokenSecret");
});

test("secretSettingProblem: what is not a free string is fine, whatever its key", () => {
  expect(secretSettingProblem(object({ maxTokens: { type: "integer" }, prompt: { type: "string" }, model: { type: "string" } }))).toBeUndefined();
  expect(secretSettingProblem(object({ cookies: { type: "boolean" } }))).toBeUndefined();
  expect(secretSettingProblem({ type: "object" })).toBeUndefined();
});

test("secretSettingProblem: it looks at every depth, and through unions", () => {
  const nested = object({ servers: { type: "array", items: object({ headers: object({ authorization: { type: "string" } }) }) } });
  expect(secretSettingProblem(nested)).toContain("/servers/*/headers/authorization");
  expect(secretSettingProblem(object({ extra: { type: "object", additionalProperties: object({ password: { type: "string" } }) } }))).toContain(
    "/extra/*/password",
  );
  expect(secretSettingProblem(object({ apiKey: { anyOf: [{ type: "null" }, { type: "string" }] } }))).toContain("/apiKey");
  expect(secretSettingProblem(object({ apiKey: { anyOf: [{ type: "null" }, { type: "string", pattern: SECRET_NAME_PATTERN }] } }))).toBeUndefined();
});

test("credentialSettingProblem: a known credential's shape anywhere is refused, by its path, never echoed", () => {
  const problem = credentialSettingProblem({ agents: [{ name: "support", systemPrompt: KEY }] });
  expect(problem).toContain("/agents/0/systemPrompt looks like a credential");
  expect(problem).not.toContain(KEY);
  expect(credentialSettingProblem({ token: "ghp_abcdefghijklmnopqrstuvwxyz0123" })).toContain("/token");
  // A key pasted into prose is found as a word of it, quotes and punctuation aside.
  expect(credentialSettingProblem({ prompt: `You may call the API with "${KEY}".` })).toContain("/prompt");
  expect(credentialSettingProblem({ prompt: "push with ghp_abcdefghijklmnopqrstuvwxyz0123, then stop" })).toContain("/prompt");
});

test("credentialSettingProblem: prose, names and long ids are not credentials", () => {
  expect(
    credentialSettingProblem({
      prompt: "Answer briefly. The build is 3f9a2c7e1b4d8f0a6c5e9b2d7f1a3c8e4b6d0f2a.",
      tokenSecret: "GITHUB_TOKEN",
      model: "openrouter/anthropic/claude-sonnet-4",
      limit: 3,
      on: true,
      nothing: null,
    }),
  ).toBeUndefined();
});
