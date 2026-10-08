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
 * A setting is never a secret: secrets stay in `secrets`.
 *
 * What every provider guarantees:
 * - **A component declares its settings once per App**, in its `start`: a JSON Schema of an object
 *   (TypeBox's `Type.Object`, as its config's) and its defaults, which the schema must accept
 *   (`declare` throws otherwise, and when the component already declared). Its schema's `title`,
 *   `description` and `default` keywords are for the dashboard to show, never applied: `defaults` are.
 * - **`get` is the stored value over the defaults, valid.** Each top-level key the operator stored
 *   replaces the default's; a stored key the schema no longer accepts (a deploy changed it, an agent
 *   was removed) is left out, its default used, and logged. The answer is a copy.
 * - **`set` validates, then stores, whole.** `value` is the component's whole value (what it leaves
 *   out takes its default); a value the schema refuses is `invalid_value` and stores nothing. It is
 *   logged with the operator and the component, never the value. The next `get` of the App that set
 *   it reads it, and of every other App of the deployment within the provider's bound (a Durable
 *   Object's cache: a second at most): a change applies to the next run, not to one already going.
 * - **It outlives a restart**, as storage does.
 * - **`sections`** lists every declared component (sorted by name) with its schema, defaults and
 *   value: what the dashboard renders. The provider serves it to operators as `GET
 *   /admin/api/settings`, one component's as `GET /admin/api/settings/:component`, and `PUT
 *   /admin/api/settings/:component` sets it, behind `admin.auth`.
 * - **Errors are typed** (`SettingsError`): `unknown_component` for a component that declared
 *   nothing, `invalid_value`. Any other rejection is the store's: unreachable, its storage failing. A
 *   consumer then keeps what it read last, or its config.
 */

import type { AppContext } from "@pikit/core";
import type { Operator } from "./admin.ts";
import type { JsonValue } from "./json.ts";

/** A JSON object, as settings are. */
export type SettingsValue = { readonly [key: string]: JsonValue };

/** A JSON Schema of an object, as TypeBox builds it (`Type.Object`): JSON. */
export type SettingsSchema = object;

/** One component's settings, as `sections` lists them. JSON. */
export interface SettingsSection {
  component: string;
  schema: SettingsSchema;
  defaults: SettingsValue;
  /** `get`'s answer. */
  value: SettingsValue;
}

export type SettingsErrorCode = "unknown_component" | "invalid_value";

/** A refusal of `get` or `set`; its message says why (for `invalid_value`, where the value is wrong, never the value). */
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
  /** `component`'s value now: what was stored over its defaults, valid. */
  get<T extends SettingsValue = SettingsValue>(component: string, ctx: AppContext): Promise<T>;
  /** Stores `value` as `component`'s whole value, `operator`'s change; answers the value `get` now gives. */
  set(component: string, value: SettingsValue, operator: Operator, ctx: AppContext): Promise<SettingsValue>;
  /** Every declared component's settings, by name. */
  sections(ctx: AppContext): Promise<SettingsSection[]>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    settings: Settings;
  }
}
