/**
 * `pikit configure`'s decisions (`configure-plan.ts`), on pure inputs: which variables it sets, takes,
 * generates, asks for or fails on, and, per model provider an agent names, how it offers to reach it
 * on a server (with or without a deployment that runs the app) and on Cloudflare. The components'
 * records are this repository's manifests, so the key variables are the ones they declare.
 */

import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { EnvironmentVariable } from "../registry/manifest.ts";
import { declaredVariables, type ModelInput, planModels, planVariables, type VariableStep } from "./configure-plan.ts";
import { canLogIn, type CheckedCredentials, usedOnly } from "./model-credentials.ts";
import type { InstalledComponent, ProjectManifest } from "./pikit-json.ts";
import { openRegistry } from "./registry-source.ts";

const registry = openRegistry(DEFAULT_REGISTRY);

/** A component's `pikit.json` record, with what `environment` says (its manifest's, by default). */
const record = (name: string, environment = registry.manifest(name).environment ?? []): InstalledComponent => ({
  registry: "default",
  version: "0.0.0",
  requires: { pikit: "0.0.0" },
  addedDependencies: [],
  files: {},
  dependencies: {},
  environment,
});

const installed = (...names: string[]): ProjectManifest["components"] => Object.fromEntries(names.map((name) => [name, record(name)]));

const variable = (name: string, fields: Partial<EnvironmentVariable> = {}): EnvironmentVariable => ({ name, secret: false, required: false, ...fields });

/** `steps` as name → action, the value or `generable` after it. */
const actions = (steps: VariableStep[]) =>
  Object.fromEntries(steps.map((s) => [s.variable.name, s.action === "environment" ? `environment:${s.value}` : s.action === "ask" ? `ask:${s.generable ? "generable" : "typed"}` : s.action]));

test("each variable once, required or secret when any component says so", () => {
  const components = {
    one: record("one", [variable("SHARED", { required: false }), variable("ONLY_ONE", { secret: true })]),
    two: record("two", [variable("SHARED", { required: true, secret: true, description: "two's" })]),
  };
  expect(declaredVariables(components)).toEqual([variable("SHARED", { required: true, secret: true }), variable("ONLY_ONE", { secret: true })]);
});

test("a variable is owned by a component's own step, kept when set, generated, taken from the shell, asked, or missing; never in another order", () => {
  const variables = [
    variable("OWNED", { required: true }),
    variable("IN_DOT_ENV", { required: true }),
    variable("WEBHOOK_TOKEN", { required: true, secret: true }),
    variable("SET_AND_GENERATE_TOKEN", { required: true, secret: true }),
    variable("EXPORTED", { required: true }),
    variable("EMPTY_EXPORT", { required: true }),
    variable("PIKIT_ADMIN_TOKEN", { required: true, secret: true }),
    variable("CHAT_ID_TOKEN", { required: true }),
    variable("API_SECRET", { required: true, secret: true }),
    variable("ANTHROPIC_OAUTH_TOKEN", { secret: true }),
  ];
  const input = {
    owned: new Set(["OWNED"]),
    current: new Map([["IN_DOT_ENV", "x"], ["SET_AND_GENERATE_TOKEN", "kept"], ["EMPTY_EXPORT", ""]]),
    environment: { EXPORTED: "from-shell", EMPTY_EXPORT: "", OWNED: "ignored" },
    generate: ["WEBHOOK_TOKEN", "SET_AND_GENERATE_TOKEN"],
  };
  const common = {
    OWNED: "owned",
    IN_DOT_ENV: "set",
    // --generate fills what is unset; it never replaces a value .env has.
    WEBHOOK_TOKEN: "generate",
    SET_AND_GENERATE_TOKEN: "set",
    EXPORTED: "environment:from-shell",
    // An optional variable (a provider's key, its OAuth token) is never asked one by one nor generated.
    ANTHROPIC_OAUTH_TOKEN: "skip",
  };
  // In a terminal: a required secret `*_TOKEN` is generated on Enter; a non-secret one, or another secret, is typed.
  expect(actions(planVariables(variables, { ...input, interactive: true }))).toEqual({
    ...common,
    EMPTY_EXPORT: "ask:typed",
    PIKIT_ADMIN_TOKEN: "ask:generable",
    CHAT_ID_TOKEN: "ask:typed",
    API_SECRET: "ask:typed",
  });
  // Without one (or --yes), nothing is asked: what is required and not given is missing.
  expect(actions(planVariables(variables, { ...input, interactive: false }))).toEqual({
    ...common,
    EMPTY_EXPORT: "missing",
    PIKIT_ADMIN_TOKEN: "missing",
    CHAT_ID_TOKEN: "missing",
    API_SECRET: "missing",
  });
});

test("the variables of installed components, as the registry declares them: the admin token is generable, a provider's keys are left to the model step", () => {
  const steps = planVariables(declaredVariables(installed("admin-auth-token", "provider-anthropic", "provider-openrouter")), {
    owned: new Set(),
    current: new Map(),
    environment: {},
    generate: [],
    interactive: true,
  });
  expect(actions(steps)).toEqual({
    PIKIT_ADMIN_TOKEN: "ask:generable",
    ANTHROPIC_API_KEY: "skip",
    ANTHROPIC_OAUTH_TOKEN: "skip",
    ANTHROPIC_AUTH_TOKEN: "skip",
    OPENROUTER_API_KEY: "skip",
  });
});

/** What `credentials.ts check` returns for these providers, none configured, with the project's `model.credentials` (`store`) or none. */
const checked = (store: string | undefined, providers: Record<string, boolean> = { anthropic: false, openrouter: false, "openai-compatible": false }): CheckedCredentials => ({
  ok: true,
  providers,
  store,
  owners: { anthropic: "provider-anthropic", openrouter: "provider-openrouter", "openai-compatible": "provider-openai-compatible", faux: "provider-faux" },
  // pi-ai has an OAuth login for Anthropic only, of these.
  oauth: ["anthropic"],
  unused: [],
});

const components = installed("provider-anthropic", "provider-openrouter", "provider-openai-compatible", "provider-faux");

/** Each provider's offered choices, by value; `has` when it has credentials somewhere. */
const offered = (input: ModelInput) => Object.fromEntries(planModels(input).map((s) => [s.id, s.has === "none" ? s.choices.map((c) => c.value) : s.has]));

test("only the providers the agents name are planned", () => {
  const all = { ...checked("credentials-file"), providers: { anthropic: false, openrouter: false, faux: true } };
  const used = usedOnly(all, new Set(["openrouter"]));
  expect(planModels({ checked: { ...used, unused: used.unused }, there: undefined, components, exec: false }).map((s) => s.id)).toEqual(["openrouter"]);
  expect(used.unused).toEqual(["anthropic", "faux"]);
  // Not known which (the app does not compose): every installed one.
  expect(planModels({ checked: usedOnly(all, undefined), there: undefined, components, exec: false }).map((s) => s.id)).toEqual(["anthropic", "openrouter", "faux"]);
});

test("a provider's key goes in the variable its component's manifest declares; one that declares none is offered no key", () => {
  const plan = planModels({ checked: checked(undefined), there: undefined, components, exec: false });
  expect(Object.fromEntries(plan.map((s) => [s.id, s.keyName]))).toEqual({ anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY", "openai-compatible": undefined });
  const anthropic = plan.find((s) => s.id === "anthropic");
  expect(anthropic?.choices.find((c) => c.value === "key")?.hint).toBe("stored in .env as ANTHROPIC_API_KEY; `pikit up` and `pikit dev` both read it");
});

test("on a server running the app in Docker: a login for `pikit up` first, a key, a login for `pikit dev`; a login only where pi-ai has one", () => {
  const input = { checked: checked("credentials-file"), there: { anthropic: false, openrouter: false, "openai-compatible": false }, components, exec: true };
  expect(offered(input)).toEqual({
    anthropic: ["up", "key", "dev", "skip"],
    openrouter: ["key", "skip"],
    // No login and no key variable (it is config): nothing to offer, it is left (its README says how).
    "openai-compatible": [],
  });
  const labels = planModels(input).find((s) => s.id === "anthropic")?.choices.map((c) => c.label);
  expect(labels?.[0]).toBe("Log in with your subscription, for `pikit up`");
  expect(labels?.[2]).toBe("Log in with your subscription, for `pikit dev` only");
});

test("credentials here, or only where the app runs, are not asked for again", () => {
  const input = { checked: checked("credentials-file", { anthropic: false, openrouter: true }), there: { anthropic: true, openrouter: false }, components, exec: true };
  expect(offered(input)).toEqual({ anthropic: "there", openrouter: "here" });
});

test("on a server without a deployment that runs the app, the login is here; when the deployment could not check, it is for `pikit dev` only", () => {
  const alone = planModels({ checked: checked("credentials-file"), there: undefined, components, exec: false }).find((s) => s.id === "anthropic");
  expect(alone?.choices.map((c) => c.value)).toEqual(["dev", "key", "skip"]);
  expect(alone?.choices[0]?.label).toBe("Log in with your subscription");
  const unchecked = planModels({ checked: checked("credentials-file"), there: undefined, components, exec: true }).find((s) => s.id === "anthropic");
  expect(unchecked?.choices[0]?.label).toBe("Log in with your subscription, for `pikit dev` only");
});

test("on Cloudflare (no model.credentials to store a login): keys only, and no login is suggested", () => {
  const cloudflare = checked(undefined);
  expect(offered({ checked: cloudflare, there: undefined, components, exec: false })).toEqual({
    anthropic: ["key", "skip"],
    openrouter: ["key", "skip"],
    "openai-compatible": [],
  });
  expect(canLogIn(cloudflare, "anthropic")).toBe(false);
  expect(canLogIn(checked("credentials-file"), "anthropic")).toBe(true);
  expect(canLogIn(checked("credentials-file"), "openrouter")).toBe(false);
});
