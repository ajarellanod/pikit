/**
 * What the bench measures, on one side (one kit revision's project): every number is the client's
 * wall clock (Bun's `performance.now()`), the only clock that sees CPU inside workerd; the objects
 * each step started are counted from `wrangler dev`'s output (`pikit: object started`), with whatever
 * fields the host logs on that line (from object composition on: `kind`, `components`, `composeMs`,
 * `startMs`, the host's clock, which moves only on I/O: the start's waits, not its CPU).
 *
 * 0. the script start: `wrangler.script.json`'s first request (the bundle evaluated), less a warm one;
 *    and the Worker's App start: the bench Worker's first `GET /bench/ping`, less a warm one;
 * 1. a fresh owner key's first call (`memory:space:<fresh>`, `memory-sql.list`), `fresh` times, in a
 *    warm isolate: a cold object with its owners warm, then the same key again (warm);
 * 2. the fixed owners cold (`wrangler dev` restarted first), called in series, then again warm;
 * 3. a fresh conversation's first message through channel-http to `faux/scripted`, with the owners
 *    cold (after a restart), then `conversations` more with them warm.
 */

import { BENCH_CONFIG, type BenchProject, SCRIPT_CONFIG } from "./project.ts";
import { type Dev, startDev } from "./process.ts";

/** An object start as `wrangler dev` printed it: the object's id, its key when the bench knows it, and the line's other fields. */
export interface ObjectStart {
  object: string;
  key?: string;
  fields: Record<string, string | number | boolean>;
}

export interface Step {
  name: string;
  ms: number;
  ok: boolean;
  code?: string;
  /** Objects started before the answer came back: on its critical path. */
  during: ObjectStart[];
  /** Objects started after it, before the output went quiet (alarms set by those starts). */
  after: ObjectStart[];
}

export interface SideResult {
  label: string;
  kit: string;
  commit: string;
  components: number;
  scriptStartMs: number[];
  workerStartMs: number[];
  pingMs: number[];
  fresh: { cold: Step[]; warm: Step[] };
  owners: { cold: Step[][]; warm: Step[][] };
  conversation: { cold: Step[]; warm: Step[] };
}

export interface Options {
  rounds: number;
  fresh: number;
  conversations: number;
  port: number;
  inspectorPort: number;
}

/** The fixed owners of scenario 2, in the order the design note lists them, each with a call it answers. */
export const OWNERS: readonly { key: string; type: string; message: unknown }[] = [
  { key: "settings-store:settings", type: "settings-store.read", message: { version: -1 } },
  { key: "credentials-do", type: "credentials-do.read", message: { providerId: "openrouter" } },
  { key: "provider-failover:cooldowns", type: "provider-failover.sync", message: { entries: [] } },
  { key: "admin-api:index", type: "admin-api.list", message: { limit: 10 } },
  { key: "projects:index", type: "projects-sql.locate", message: { id: "bench" } },
  { key: "tool-mcp-oauth", type: "tool-mcp-oauth.list", message: null },
  { key: "approvals-sql:approvals", type: "approvals-sql.list", message: {} },
];

const START_LINE = /pikit: object started \{([^}]*)\}/g;
const FIELD = /(\w+): (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)|(true|false|null))/g;

/** The object starts in a piece of `wrangler dev`'s output. */
export function parseStarts(output: string): ObjectStart[] {
  const starts: ObjectStart[] = [];
  for (const line of output.matchAll(START_LINE)) {
    const fields: Record<string, string | number | boolean> = {};
    for (const field of (line[1] ?? "").matchAll(FIELD)) {
      const [, name, single, double, number, bool] = field;
      if (name === undefined) continue;
      // `null` (a key of no actor kind) reads "none": a value the table can print.
      fields[name] = number !== undefined ? Number(number) : bool === "null" ? "none" : bool !== undefined ? bool === "true" : (single ?? double ?? "");
    }
    const { object, ...rest } = fields;
    starts.push({ object: String(object ?? "?"), fields: rest });
  }
  return starts;
}

/** Waits until `dev` has printed nothing new for `quietMs` (at most `maxMs`). */
async function settle(dev: Dev, quietMs = 300, maxMs = 3_000): Promise<void> {
  const end = Date.now() + maxMs;
  let length = dev.output().length;
  let since = Date.now();
  while (Date.now() < end) {
    await Bun.sleep(50);
    const now = dev.output().length;
    if (now !== length) {
      length = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
}

class Session {
  readonly ids = new Map<string, string>();
  constructor(
    readonly dev: Dev,
    readonly project: BenchProject,
  ) {}

  async name(keys: string[]): Promise<void> {
    const unknown = keys.filter((key) => ![...this.ids.values()].includes(key));
    if (unknown.length === 0) return;
    const response = await fetch(`${this.dev.url}/bench/ids`, { method: "POST", headers: { authorization: `Bearer ${this.project.tokens.bench}` }, body: JSON.stringify({ keys: unknown }) });
    const body = (await response.json()) as { ids?: Record<string, string> };
    for (const [key, id] of Object.entries(body.ids ?? {})) this.ids.set(id, key);
  }

  /** Runs `request`, timing it, and reads which objects started during it and after it. */
  async step(name: string, request: () => Promise<{ ok: boolean; code?: string }>): Promise<Step> {
    await settle(this.dev);
    const before = this.dev.output().length;
    const started = performance.now();
    const outcome = await request();
    const ms = performance.now() - started;
    const answered = this.dev.output().length;
    await settle(this.dev);
    const named = (start: ObjectStart): ObjectStart => {
      const key = this.ids.get(start.object);
      return key === undefined ? start : { ...start, key };
    };
    const output = this.dev.output();
    return {
      name,
      ms,
      ok: outcome.ok,
      ...(outcome.code !== undefined && { code: outcome.code }),
      during: parseStarts(output.slice(before, answered)).map(named),
      after: parseStarts(output.slice(answered)).map(named),
    };
  }

  call(key: string, type: string, message: unknown): Promise<Step> {
    return this.step(key, async () => {
      const response = await fetch(`${this.dev.url}/bench/call`, { method: "POST", headers: { authorization: `Bearer ${this.project.tokens.bench}` }, body: JSON.stringify({ key, type, message }) });
      const body = (await response.json()) as { ok: boolean; code?: string };
      return body.ok ? { ok: true } : { ok: false, code: body.code ?? String(response.status) };
    });
  }

  message(conversationId: string): Promise<Step> {
    return this.step(`conversation ${conversationId}`, async () => {
      const response = await fetch(`${this.dev.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${this.project.tokens.http}`, "content-type": "application/json" }, body: JSON.stringify({ conversationId, text: "hello" }) });
      const body = (await response.json()) as { text?: string; error?: string };
      return response.ok && body.text === "faux: hello" ? { ok: true } : { ok: false, code: body.error ?? `${response.status} ${JSON.stringify(body).slice(0, 120)}` };
    });
  }
}

async function timed(url: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`bench: GET ${url} answered ${response.status}`);
  return ms;
}

/** A fresh `wrangler dev` of the bench Worker, its isolate's first request made (`/bench/ping`): the Worker App's start, less warm pings. */
async function boot(project: BenchProject, options: Options, result: SideResult): Promise<Session> {
  const dev = await startDev(project.dir, BENCH_CONFIG, project.name, options.port, options.inspectorPort);
  const first = await timed(`${dev.url}/bench/ping`);
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) warm.push(await timed(`${dev.url}/bench/ping`));
  const ping = median(warm);
  result.workerStartMs.push(first - ping);
  result.pingMs.push(ping);
  const session = new Session(dev, project);
  await session.name(OWNERS.map((owner) => owner.key));
  return session;
}

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

export async function measureSide(project: BenchProject, label: string, kit: string, commit: string, options: Options, log: (line: string) => void): Promise<SideResult> {
  const result: SideResult = {
    label,
    kit,
    commit,
    components: project.components,
    scriptStartMs: [],
    workerStartMs: [],
    pingMs: [],
    fresh: { cold: [], warm: [] },
    owners: { cold: [], warm: [] },
    conversation: { cold: [], warm: [] },
  };
  const run = `${Date.now().toString(36)}`;

  log(`${label}: 0. script start, ${options.rounds} cold isolates`);
  for (let round = 0; round < options.rounds; round++) {
    const dev = await startDev(project.dir, SCRIPT_CONFIG, `${project.name}-script`, options.port, options.inspectorPort);
    try {
      const first = await timed(`${dev.url}/`);
      const warm: number[] = [];
      for (let i = 0; i < 5; i++) warm.push(await timed(`${dev.url}/`));
      result.scriptStartMs.push(first - median(warm));
    } finally {
      await dev.stop();
    }
  }

  for (let round = 0; round < options.rounds; round++) {
    log(`${label}: round ${round + 1}/${options.rounds}: 2. the owners cold, in series${round === 0 ? `, then 1. ${options.fresh} fresh owner keys` : ""}`);
    let session = await boot(project, options, result);
    try {
      const cold: Step[] = [];
      for (const owner of OWNERS) cold.push(await session.call(owner.key, owner.type, owner.message));
      result.owners.cold.push(cold);
      const warm: Step[] = [];
      for (const owner of OWNERS) warm.push(await session.call(owner.key, owner.type, owner.message));
      result.owners.warm.push(warm);
      if (round === 0) {
        for (let n = 0; n < options.fresh; n++) {
          const space = `bench-${run}-${n}`;
          const key = `memory:space:${space}`;
          await session.name([key]);
          const message = { owner: { type: "space", space }, kinds: ["fact"], limit: 10 };
          result.fresh.cold.push(await session.call(key, "memory-sql.list", message));
          result.fresh.warm.push(await session.call(key, "memory-sql.list", message));
        }
      }
    } finally {
      await session.dev.stop();
    }

    log(`${label}: round ${round + 1}/${options.rounds}: 3. a conversation with the owners cold, then ${options.conversations} with them warm`);
    session = await boot(project, options, result);
    try {
      result.conversation.cold.push(await session.message(`bench-${run}-r${round}-cold`));
      for (let n = 0; n < options.conversations; n++) result.conversation.warm.push(await session.message(`bench-${run}-r${round}-w${n}`));
    } finally {
      await session.dev.stop();
    }
  }
  return result;
}
