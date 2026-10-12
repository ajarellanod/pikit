/**
 * `settings`: values an operator changes live, from the dashboard, read when used (SPEC §6: "What
 * changes live is data"; features/settings.md). The agent's system prompt, which agent answers by
 * default, a channel's options: no deploy, no restart, the next run reads them.
 *
 *   const settings = pikit.useOptional("settings");
 *   // in start (setup only registers; a handle is read from start on):
 *   settings.get()?.declare("router-basic", Type.Object({ defaultAgent: Type.String() }), { defaultAgent: config.defaultAgent });
 *   // when used:
 *   const { defaultAgent } = await settings.get().get<{ defaultAgent: string }>("router-basic", ctx);
 *
 * **Config or setting, never both.** Config (`pikit.config.ts`) is deployed and read at start; it
 * changes through a commit. A setting is changed by an operator and read when used. A component says
 * which of its values are settings, by declaring them; a setting's default may come from its config.
 * A setting is never a secret: secrets stay in `secrets`, and a setting may only name one
 * (`tokenSecret: "GITHUB_TOKEN"`). A provider holds every component to it, the same way, with the two
 * checks below: `secretSettingProblem` in `declare` (a schema whose secret-named string is free),
 * `credentialSettingProblem` on the defaults and on every operator's change (a known credential's
 * shape, anywhere in the value), refusing both and never echoing the value.
 *
 * The contract is what a component sees: it declares and reads. Operators change the values through
 * the provider's own operator surface (settings-store: the dashboard's routes), which validates a
 * change against the declared schema; that surface is the provider's, not this contract's.
 *
 * What every provider guarantees:
 * - **A component declares its settings once per App**, in its `start`: a JSON Schema of an object
 *   (TypeBox's `Type.Object`, as its config's) and its defaults, which the schema must accept
 *   (`declare` throws otherwise, when the component already declared, and when the schema lets a
 *   setting hold a secret or the defaults hold a credential: the two checks above). Its schema's `title`,
 *   `description` and `default` keywords are for the dashboard to show, never applied: `defaults` are.
 * - **`get` is the stored value over the defaults, valid.** An operator stores a component's whole
 *   value; each top-level key it holds replaces the default's, and what it leaves out takes its
 *   default. A stored key the schema no longer accepts (a deploy changed it, an agent was removed) is
 *   left out, its default used, and logged. The answer is a copy.
 * - **An operator's change applies to the next `get`** of every App of the deployment within the
 *   provider's bound (settings-store on Cloudflare: a Durable Object's cache, a second at most): to
 *   the next run, not to one already going.
 * - **It outlives a restart**, as storage does.
 * - **Errors are typed** (`SettingsError`): `unknown_component` for a component that declared
 *   nothing. Any other rejection is the store's: unreachable, its storage failing. A consumer then
 *   keeps what it read last, or its config.
 */

import type { AppContext } from "@pikit/core";
import type { JsonValue } from "./json.ts";
import { isKnownCredential, isSecretKey, isSecretName, SECRET_NAME_PATTERN } from "./secrets.ts";

/** A JSON object, as settings are. */
export type SettingsValue = { readonly [key: string]: JsonValue };

/** A JSON Schema of an object, as TypeBox builds it (`Type.Object`): JSON. */
export type SettingsSchema = object;

/**
 * Where `schema` lets a setting hold a secret, or `undefined`. A string a key names as a secret
 * (`token`, `apiKey`, `password`, `secret`, `authorization`...) may only be a secret's name: its schema
 * has `pattern: SECRET_NAME_PATTERN` (or is a `const` or `enum` of names), so a setting names a secret
 * (`tokenSecret: "GITHUB_TOKEN"`) and never holds one. Checked at every depth (`properties`, `items`,
 * `additionalProperties`, `anyOf`/`oneOf`/`allOf`). A provider calls it in `declare` and refuses on a
 * problem: the component's author learns at start, and no operator is ever asked for a secret there.
 */
export function secretSettingProblem(schema: SettingsSchema): string | undefined {
  return schemaProblem(schema, "");
}

/**
 * Where `value` holds what has the shape of a known credential (an API key `sk-...`, a GitHub token, a
 * bot token, a JWT, a private key, a URL with a password), whole or as a word of a text (a key pasted
 * into a prompt), or `undefined`: a JSON pointer (`/prompt`), never the value. Only known shapes, so
 * prose (a prompt with a long hash) is never refused. A provider
 * calls it on the defaults in `declare` and on every operator's change, and refuses on a problem.
 */
export function credentialSettingProblem(value: JsonValue): string | undefined {
  const at = credentialPath(value, "");
  if (at === undefined) return undefined;
  return `${at === "" ? "the value" : at} looks like a credential: a setting is never a secret; keep it in \`secrets\` and name it in the setting instead`;
}

type Node = { readonly [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const branches = (node: Node): Node[] =>
  ["anyOf", "oneOf", "allOf"].flatMap((key) => (Array.isArray(node[key]) ? (node[key] as unknown[]).filter(isNode) : []));

/** Whether `node` lets a string be anything but a secret's name. */
function freeString(node: Node): boolean {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("string")) {
    if (node.pattern === SECRET_NAME_PATTERN) return false;
    if (typeof node.const === "string") return !isSecretName(node.const);
    if (Array.isArray(node.enum)) return !node.enum.every((each) => typeof each === "string" && isSecretName(each));
    return true;
  }
  if (typeof node.const === "string") return !isSecretName(node.const);
  return branches(node).some(freeString);
}

function schemaProblem(node: unknown, path: string): string | undefined {
  if (!isNode(node)) return undefined;
  if (isNode(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      const at = `${path}/${key}`;
      if (isSecretKey(key) && isNode(child) && freeString(child)) {
        return `${at} would hold a secret: a setting may only name one (a string with \`pattern: "${SECRET_NAME_PATTERN}"\`, \`tokenSecret: "GITHUB_TOKEN"\`); the secret stays in \`secrets\``;
      }
      const deeper = schemaProblem(child, at);
      if (deeper !== undefined) return deeper;
    }
  }
  for (const [child, at] of [
    [node.items, `${path}/*`],
    [node.additionalProperties, `${path}/*`],
  ] as const) {
    const deeper = schemaProblem(child, at);
    if (deeper !== undefined) return deeper;
  }
  for (const branch of branches(node)) {
    const deeper = schemaProblem(branch, path);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** A word's quotes and punctuation around it: `"sk-...".` is the key it holds. */
const AROUND = /^["'`([{<]+|["'`)\]}>.,;:!?]+$/g;

/** Whether `text` is a credential, or holds one as a word of it (a key pasted into a prompt). */
function holdsCredential(text: string): boolean {
  return isKnownCredential(text) || text.split(/\s+/).some((word) => isKnownCredential(word.replace(AROUND, "")));
}

function credentialPath(value: JsonValue, path: string): string | undefined {
  if (typeof value === "string") return holdsCredential(value) ? path : undefined;
  if (Array.isArray(value)) {
    for (const [index, each] of value.entries()) {
      const at = credentialPath(each, `${path}/${index}`);
      if (at !== undefined) return at;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, each] of Object.entries(value)) {
      const at = credentialPath(each, `${path}/${key}`);
      if (at !== undefined) return at;
    }
  }
  return undefined;
}

export type SettingsErrorCode = "unknown_component";

/** A refusal of `get`; its message says why. */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

export interface Settings {
  /** Declares `component`'s settings: in its `start`, once per App. Throws when `defaults` do not fit `schema`, or `component` declared already. */
  declare(component: string, schema: SettingsSchema, defaults: SettingsValue): void;
  /** `component`'s value now: what an operator stored over its defaults, valid. */
  get<T extends SettingsValue = SettingsValue>(component: string, ctx: AppContext): Promise<T>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    settings: Settings;
  }
}
