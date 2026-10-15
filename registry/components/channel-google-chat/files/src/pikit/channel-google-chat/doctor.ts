// Owner: skeleton. The check that the Worker's half and the default export are configured alike.
/**
 * channel-google-chat's step of `pikit doctor`, which `pikit dev` and `pikit up` run first: on
 * Cloudflare, the Worker's half (`channel-google-chat-worker` in `workerConfig`) and the default export
 * (`channel-google-chat` in `config`) must have the same values of what both read (`WorkerConfig`:
 * `apiBase`, `jwksUrl`, `instances`, `conversations`), defaults included. The Worker serves and keys
 * the events its config names, and the objects answer the ones theirs does: an instance only one half
 * runs, or a `conversations` default that differs, sends a chat's events to conversations the objects
 * do not key that way. This is the one place that rule is enforced; on a server (no Worker's App)
 * there is nothing to compare. It writes nothing and reaches no network.
 *
 * `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`); the CLI calls `doctor(io)` in the
 * project's directory, in its own process, never in the app.
 */

import Value from "typebox/value";
import { NAME, WorkerConfig } from "./instance.ts";

/** What the CLI gives the check (`component-doctor.ts`). */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  /** The Worker half's config, on Cloudflare; absent on a server. */
  workerConfig?: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

/** The keys both halves read: `WorkerConfig`'s, the one list. */
const SHARED = Object.keys(WorkerConfig.properties) as (keyof WorkerConfig)[];

/** `value` as JSON with its objects' keys sorted: two configs compare whatever order they were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** The shared values of `config`, its defaults filled in as the App fills them. */
function shared(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const filled = Value.Default(WorkerConfig, structuredClone({ ...config })) as Record<string, unknown>;
  return Object.fromEntries(SHARED.map((key) => [key, filled[key]]));
}

/**
 * What differs between the default export's config (`objects`) and the Worker half's (`worker`), one
 * problem per key: empty when they agree.
 */
export function configProblems(objects: Readonly<Record<string, unknown>>, worker: Readonly<Record<string, unknown>>): string[] {
  const inObjects = shared(objects);
  const inWorker = shared(worker);
  return SHARED.filter((key) => canonical(inObjects[key]) !== canonical(inWorker[key])).map(
    (key) =>
      `${key} differs between the Worker's half (workerConfig "${NAME}-worker": ${canonical(inWorker[key])}) and the default export (config "${NAME}": ${canonical(inObjects[key])}), defaults included: both halves must have the same ${SHARED.join(", ")}`,
  );
}

export async function doctor(io: DoctorIO): Promise<string[]> {
  return io.workerConfig === undefined ? [] : configProblems(io.config, io.workerConfig);
}
