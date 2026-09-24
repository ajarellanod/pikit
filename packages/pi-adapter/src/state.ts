/**
 * `agent.state` over the Pi session (SPEC §6.2a, §6.4). Pi's durable runtime will hold it as a
 * conversation-scoped document; until the adapter moves there it is one session value,
 * `pikit` / `agent.state`. A session value survives a new harness over the same stored session and
 * a new session starts without it (`pi-facts.test.ts`), which is exactly "survives restarts, starts
 * fresh after a reset". pikit keeps no store of its own.
 *
 * Only what was updated is stored: `get()` merges it over the agent's initial state, so a key an
 * agent adds to its initial state later reaches conversations that already have a state.
 */

import { type Context, type JsonValue, type Session, value } from "@earendil-works/pi-agent-core";
import type { AgentState } from "@pikit/core";
import { toPi } from "./context.ts";

const STATE = value<JsonValue>("pikit", "agent.state");

/**
 * The state of the conversation whose session is `session`. One per open conversation: its updates
 * run one at a time, so concurrent tools never lose each other's keys. A conversation has one worker
 * (SPEC §7.2), so no other writer exists.
 */
export function sessionState(session: Session, initial: object = {}): AgentState {
  let line: Promise<unknown> = Promise.resolve();

  const stored = async (ctx: Context): Promise<Record<string, unknown>> => {
    const current = (await session.getValue(STATE, toPi(ctx)))?.value;
    return isJsonObject(current) ? current : {};
  };
  const read = async (ctx: Context) => structuredClone({ ...initial, ...(await stored(ctx)) });

  return {
    get: read,
    update(patch, ctx) {
      if (!isJsonObject(patch)) return Promise.reject(new TypeError("agent.state: a patch must be a JSON object"));
      const copy = structuredClone(patch);
      const next = line.then(async () => {
        await session.setValue(STATE, { ...(await stored(ctx)), ...copy } as JsonValue, toPi(ctx));
        return read(ctx);
      });
      line = next.catch(() => {});
      return next;
    },
  };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isJson);
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isJsonObject(value);
}
