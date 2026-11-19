/**
 * What the Worker and each `Conversation` Durable Object do with the project's two Apps (SPEC §4.1,
 * C1, C4, C5), with no `cloudflare:*` import: `entrypoint.ts` hands them the platform's objects, typed
 * here by what is used of them, so this file runs under `bun test` as well as in workerd.
 *
 * - **The object** (`createObjectHost`) composes its App once per object, on its first event (an RPC
 *   or an alarm), inside `blockConcurrencyWhile`: no other event reaches the object before its App has
 *   started. Which App is its key's (SPEC C9): an object whose key belongs to an actor kind (a
 *   component's `actor.kind`) runs that kind's App, its owners and what they use
 *   (`actorComposition`); any other (a conversation's, `pikit:health`, one whose key is not known)
 *   runs `pikit.config.ts`'s whole default export. See "Actor kinds" below. Its start context carries `WORKERS_HOST` with the object: its
 *   id, its storage, and the hooks its alarm and its `deliver` RPC call. A start that fails or passes
 *   its deadline is rolled back within a deadline of its own and rethrown, so Cloudflare resets the
 *   object and the next event starts over (K2, K6). The App is never stopped otherwise: an object is
 *   evicted without warning, and whatever must survive is already committed.
 * - **The guard alarm.** Cloudflare retries an alarm that throws 6 times, from 2 s apart, doubling,
 *   then drops it (https://developers.cloudflare.com/durable-objects/api/alarms/: "Because alarms are
 *   only retried up to 6 times on error, it's recommended to catch any exceptions inside your alarm()
 *   handler and schedule a new alarm"): a start that keeps failing for 2 minutes would leave the
 *   object's pending work until its chat's next message. So an alarm whose start failed before (a
 *   retry, or failed starts counted in the object's storage) sets the alarm again before it starts the
 *   App, `GUARD_FIRST_MS` ahead, doubling at each failed start in a row up to `GUARD_MAX_MS`. An alarm
 *   set during a handler that throws replaces the platform's retry (workerd's `alarm-scheduler.c++`:
 *   "If an alarm is queued, there's no point in retrying the current one"), so the guard is the retry,
 *   and it never ends. Once the App runs, its alarm's owner (actors-do's `wakeups`) sets the
 *   alarm as its rows say, which replaces the guard.
 * - **Actor kinds.** Once per isolate, on its first object event, the whole default export is composed
 *   (setups only, never started) with a reader of `actor.kind` (named `deployment-cloudflare`, as the
 *   Worker's server is): its `describe()` and declarations kept, the App dropped. A declaration
 *   problem fails every start. An object learns its key, before it composes anything, from the event
 *   (`deliver`, `call` and `stream` carry it, checked to be the object's: `ctx.id.name`, or
 *   `idFromName(key)` against its id; another key is refused, it never chooses an App), else from
 *   `ctx.id.name` (an alarm), else from its storage (`pikit:key`, written at its first keyed event
 *   where the platform gives no name), else not at all: the whole App. `health()` also creates (never
 *   starts) every kind's App, so a kind that does not compose fails `/health` and the deploy rolls
 *   back; a call or message a kind's object has no handler for says which kind it runs.
 * - **The Worker** (`createWorkerHost`) composes `export const worker` once per isolate, on its first
 *   request, with `WORKERS_HOST` `{ env, origin }` on its start context (`origin`: that request's, where
 *   the Worker is reached), and serves its `http.route`s, as
 *   `server-bun` does on a server. `GET /health` is its own: public, it starts the Worker's App and
 *   one object's App, and answers `{ ok, version }` with the version Cloudflare is running, which is
 *   how `up` knows a deploy has reached every request (C8).
 */

import {
  type App,
  type AppContext,
  type AppDefinition,
  BACKGROUND_CONTEXT,
  type Clock,
  type ComponentDefinition,
  type Context,
  consoleLogger,
  type KeyedHandle,
  defineApp,
  defineComponent,
  type Logger,
  withAbortSignal,
  withContextValue,
} from "@pikit/core";
import {
  type ActorCallOutcome,
  type ActorKind,
  type ActorKindDeclaration,
  type ActorKindMatch,
  type ActorStreamOutcome,
  actorComposition,
  actorKindDeclarations,
  actorKindOf,
  actorKindOptions,
  actorKindProblems,
  actorKinds,
  compareHttpRoutes, type HttpRoute, type HttpRouteKey, type JsonValue, matchesHttpRoute, parseHttpRouteKey, withClientAddress } from "@pikit/contracts";
import { WORKERS_HOST, type WorkersHost } from "@pikit/contracts/cloudflare";

/**
 * Longest an App's start may take. An object's start runs inside `blockConcurrencyWhile`, which
 * Cloudflare cuts at 30 s by resetting the object: the start and its rollback end well before.
 */
export const START_DEADLINE_MS = 20_000;
/** Longest the rollback of a failed start may take, after which the error is rethrown anyway. */
export const ROLLBACK_DEADLINE_MS = 5_000;
/** The guard alarm's wait after the first failed start of an alarm's retries; it doubles at each one after. */
export const GUARD_FIRST_MS = 30_000;
/** The guard alarm's longest wait. */
export const GUARD_MAX_MS = 60 * 60_000;
/** In the object's key-value storage: its alarms' failed starts in a row, while there are some. */
export const START_FAILURES_KEY = "pikit:start-failures";
/**
 * In the object's key-value storage: its key (SPEC C9), written at its first keyed event where the
 * platform does not give the object its name (`ctx.id.name`), so that its alarm finds its App again.
 */
export const OBJECT_KEY = "pikit:key";
/** The Durable Object binding in `wrangler.jsonc`: the `Conversation` class. */
export const OBJECT_BINDING = "CONVERSATION";
/** The object `GET /health` starts: one of its own, never a conversation's. */
export const HEALTH_OBJECT = "pikit:health";
/** The `version_metadata` binding in `wrangler.jsonc`: the version `GET /health` reports. */
export const VERSION_BINDING = "CF_VERSION_METADATA";

export interface HostOptions {
  /** Default: the core's `consoleLogger`: Workers Logs and `wrangler tail` show it. */
  logger?: Logger;
  /** Default: `START_DEADLINE_MS`. */
  startDeadlineMs?: number;
  /** Default: `ROLLBACK_DEADLINE_MS`. */
  rollbackDeadlineMs?: number;
  /** The Apps' clock. Default: the core's `systemClock`; tests pass a manual one. */
  clock?: Clock;
  /**
   * The binding of the objects' class, against which an event's key is checked when the platform does
   * not give an object its name (`idFromName(key)` must be its id). Default: `OBJECT_BINDING`.
   */
  binding?: string;
}

/** What the host uses of a `DurableObjectStorage` (Cloudflare's type, written structurally): the guard alarm's. */
export interface ObjectStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: number | string): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

/** What the entrypoint uses of a `DurableObjectState` (Cloudflare's type, written structurally). */
export interface ObjectState {
  /** `name`: the one `idFromName` was given, where the platform says it (Cloudflare does since March 2026). */
  id: { toString(): string; readonly name?: string | undefined };
  /** The object's `DurableObjectStorage`, passed on untouched in `WORKERS_HOST`. */
  storage: ObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** The `alarmInfo` Cloudflare passes to an object's alarm. */
export interface AlarmInfo {
  retryCount: number;
  isRetry: boolean;
}

/** What the `Conversation` class forwards to: one per object instance. */
export interface ObjectHost {
  /** Starts the App if it has not started; rejects as the start did. */
  health(): Promise<{ ok: true }>;
  /**
   * The object's alarm: the handler a component registered with `onAlarm`. A rejection makes
   * Cloudflare retry it; one from a start that failed before leaves the guard alarm set.
   */
  alarm(info?: AlarmInfo): Promise<void>;
  /** A message for this object (`actor.mailbox`'s RPC): the handler a component registered with `onDeliver`. */
  deliver(type: string, key: string, message: JsonValue): Promise<void>;
  /** A call for this object (`actor.mailbox.call`'s RPC): the handler a component registered with `onCall`. */
  call(type: string, key: string, message: JsonValue): Promise<ActorCallOutcome>;
  /** A stream opened on this object (`actor.mailbox.stream`'s RPC): the handler a component registered with `onStream`. */
  stream(type: string, key: string, message: JsonValue): Promise<ActorStreamOutcome>;
}

type AlarmHandler = () => Promise<void>;
type DeliverHandler = (type: string, key: string, message: JsonValue) => Promise<void>;
type CallHandler = (type: string, key: string, message: JsonValue) => Promise<ActorCallOutcome>;
type StreamHandler = (type: string, key: string, message: JsonValue) => Promise<ActorStreamOutcome>;

export function createObjectHost(definition: AppDefinition, state: ObjectState, env: WorkersHost["env"], options: HostOptions = {}): ObjectHost {
  const logger = options.logger ?? consoleLogger;
  const binding = options.binding ?? OBJECT_BINDING;
  let onAlarm: AlarmHandler | undefined;
  let onDeliver: DeliverHandler | undefined;
  let onCall: CallHandler | undefined;
  let onStream: StreamHandler | undefined;
  /** The App this instance runs, once it started: its kind (none for the whole App) and its components. */
  let running: ObjectApp | undefined;
  const host: WorkersHost = {
    env,
    object: {
      id: state.id.toString(),
      storage: state.storage,
      // One of each: the object has one alarm and one RPC entry, and one component multiplexes each
      // (actors-do's wakeups and mailbox). A second one is a composition mistake, said loudly.
      onAlarm(handler) {
        if (onAlarm !== undefined) throw new Error("deployment-cloudflare: the object's alarm already has a handler; one component multiplexes the alarm (wakeups)");
        onAlarm = handler;
      },
      onDeliver(handler) {
        if (onDeliver !== undefined) throw new Error("deployment-cloudflare: the object's deliveries already have a handler; one component receives them (actor.inbox)");
        onDeliver = handler;
      },
      onCall(handler) {
        if (onCall !== undefined) throw new Error("deployment-cloudflare: the object's calls already have a handler; one component answers them (actor.inbox)");
        onCall = handler;
      },
      onStream(handler) {
        if (onStream !== undefined) throw new Error("deployment-cloudflare: the object's streams already have a handler; one component answers them (actor.inbox)");
        onStream = handler;
      },
    },
  };

  /**
   * Why an event's `key` is not this object's, or `undefined` when it is: the platform's name for the
   * object, else `idFromName(key)` against its id. Never the key itself: it may name a person.
   */
  const notOurs = (key: unknown): string | undefined => {
    if (typeof key !== "string" || key === "") return "its key is empty";
    const name = state.id.name;
    if (name !== undefined) return name === key ? undefined : "its key is not this object's name";
    const namespace = env[binding] as Partial<ObjectNamespace> | undefined;
    if (typeof namespace?.idFromName !== "function") return `no ${binding} binding to check its key against (wrangler.jsonc)`;
    return String(namespace.idFromName(key)) === state.id.toString() ? undefined : "its key names another object";
  };
  const refusal = (what: string, why: string): string => {
    logger.warn("pikit: an event with a key that is not the object's was refused", { object: host.object?.id, why });
    return `deployment-cloudflare: ${what} reached the object ${host.object?.id} but ${why}: refused (a wrong key never chooses an object's App)`;
  };

  /** The object's key, before its App is composed: the platform's name, the event's (kept where there is no name), the kept one, or none. */
  const keyOf = async (eventKey: string | undefined): Promise<string | undefined> => {
    if (state.id.name !== undefined) return state.id.name;
    const kept = await state.storage.get(OBJECT_KEY);
    if (eventKey === undefined) return typeof kept === "string" ? kept : undefined;
    if (kept !== eventKey) await state.storage.put(OBJECT_KEY, eventKey);
    return eventKey;
  };

  let started: Promise<void> | undefined;
  const start = (eventKey?: string): Promise<void> =>
    (started ??= state
      .blockConcurrencyWhile(async () => {
        // A new App registers its own handlers; a failed one's are gone with it.
        onAlarm = undefined;
        onDeliver = undefined;
        onCall = undefined;
        onStream = undefined;
        running = undefined;
        const kinds = await kindsOf(definition, logger, options.clock);
        const chosen = kinds.appFor(await keyOf(eventKey));
        const composing = Date.now();
        const app = await compose(chosen.options, [], logger, options.clock);
        const starting = Date.now();
        await startWithin(app, withContextValue(WORKERS_HOST, host, BACKGROUND_CONTEXT), options, logger);
        running = chosen;
        // The kind's pattern, never the key (it may name a person). `startMs` is the start's waits:
        // workerd's clock moves only on I/O.
        logger.info("pikit: object started", {
          object: host.object?.id,
          kind: chosen.kind?.pattern ?? null,
          components: chosen.options.components.length,
          composeMs: starting - composing,
          startMs: Date.now() - starting,
          isolate: objectsStarted++ === 0 ? "new" : "warm",
        });
      })
      .catch((error: unknown) => {
        // Rethrown from inside blockConcurrencyWhile, the error resets the object; should the instance
        // live on anyway, its next event starts a new App.
        started = undefined;
        logger.error("pikit: the object's App failed to start", { object: host.object?.id, error });
        throw error;
      }));

  /** In an actor kind's object, what it runs, for a message about a handler it lacks; nothing in the whole App's. */
  const kindNote = (type: string): string => {
    const kind = running?.kind;
    if (kind === undefined) return "";
    const names = (running?.options.components ?? []).map((c) => c.name).join(", ");
    return ` (this object runs the actor kind "${kind.pattern}": ${names}, not the whole App; a component that handles "${type}" on these keys declares actor.kind for them too, SPEC C9)`;
  };

  /**
   * Before an alarm starts the App: when its start failed before, sets the guard alarm (unless a
   * sooner one is set) and counts this start as failed until it succeeds. Says whether it did.
   */
  const guard = async (info: AlarmInfo | undefined): Promise<boolean> => {
    const { storage } = state;
    const stored = await storage.get(START_FAILURES_KEY);
    const failures = typeof stored === "number" ? stored : 0;
    if (failures === 0 && info?.isRetry !== true) return false;
    const waitMs = Math.min(GUARD_MAX_MS, GUARD_FIRST_MS * 2 ** failures);
    const time = Date.now() + waitMs;
    const current = await storage.getAlarm();
    if (current === null || current > time) await storage.setAlarm(time);
    await storage.put(START_FAILURES_KEY, failures + 1);
    logger.warn("pikit: the object's alarm starts its App after a failed start; a guard alarm wakes it again if this one fails too", {
      object: host.object?.id,
      failures,
      retryCount: info?.retryCount,
      guardInMs: Math.min(waitMs, (current ?? Infinity) - Date.now()),
    });
    return true;
  };

  return {
    async health() {
      await start();
      // Every kind's App composes, or this version is not healthy: /health fails and the deploy rolls back.
      await (await kindsOf(definition, logger, options.clock)).composeEvery();
      return { ok: true };
    },
    async alarm(info) {
      // An instance whose App started (or is starting, for another event) does not need it.
      const guarded = started === undefined && (await guard(info));
      await start();
      if (guarded) await state.storage.delete(START_FAILURES_KEY);
      if (onAlarm === undefined) {
        logger.warn("pikit: the object's alarm fired, but no component handles it", { object: host.object?.id, kind: running?.kind?.pattern ?? null });
        return;
      }
      await onAlarm();
    },
    async deliver(type, key, message) {
      const wrong = notOurs(key);
      if (wrong !== undefined) throw new Error(refusal(`a "${type}" message`, wrong));
      await start(key);
      // Rejected, so the sender (`actor.mailbox.send`) rejects and its platform retries (C2).
      if (onDeliver === undefined) throw new Error(`deployment-cloudflare: a "${type}" message was delivered, but no component in the object's App handles deliveries (onDeliver)${kindNote(type)}`);
      try {
        await onDeliver(type, key, message);
      } catch (error) {
        if (running?.kind === undefined) throw error;
        throw new Error(`${error instanceof Error ? error.message : String(error)}${kindNote(type)}`, { cause: error });
      }
    },
    async call(type, key, message) {
      const wrong = notOurs(key);
      if (wrong !== undefined) return { ok: false, code: "invalid", message: refusal(`a "${type}" call`, wrong) };
      await start(key);
      if (onCall === undefined) return { ok: false, code: "no_handler", message: `deployment-cloudflare: a "${type}" call was made, but no component in the object's App answers calls (onCall)${kindNote(type)}` };
      const outcome = await onCall(type, key, message);
      return !outcome.ok && outcome.code === "no_handler" ? { ...outcome, message: `${outcome.message}${kindNote(type)}` } : outcome;
    },
    async stream(type, key, message) {
      const wrong = notOurs(key);
      if (wrong !== undefined) return { ok: false, code: "invalid", message: refusal(`a "${type}" stream`, wrong) };
      await start(key);
      if (onStream === undefined) return { ok: false, code: "no_handler", message: `deployment-cloudflare: a "${type}" stream was opened, but no component in the object's App answers streams (onStream)${kindNote(type)}` };
      const outcome = await onStream(type, key, message);
      return !outcome.ok && outcome.code === "no_handler" ? { ...outcome, message: `${outcome.message}${kindNote(type)}` } : outcome;
    },
  };
}

/** Objects whose App started in this isolate: the first one's log line says `isolate: "new"`. */
let objectsStarted = 0;

/** What an object's App is made of: its kind (none for the whole default export) and `defineApp`'s components and config. */
interface ObjectApp {
  kind: ActorKindMatch | undefined;
  options: ProjectApp;
}

/** The project's components and config, as `AppDefinition` holds them. */
type ProjectApp = { readonly components: readonly ComponentDefinition[]; readonly config: Readonly<Record<string, unknown>> };

/** The default export's actor kinds (SPEC C9), read once per isolate. */
interface Kinds {
  declarations: readonly ActorKindDeclaration[];
  /** The App an object of `key` runs: its kind's, or the whole one (no key, or a key of no kind). */
  appFor(key: string | undefined): ObjectApp;
  /** Creates (never starts) every kind's App once; rejects naming the first kind that does not compose. */
  composeEvery(): Promise<void>;
}

/**
 * Per isolate, per definition: its kinds, read again only when the definition's components or config
 * are other objects than they were (the workerd lane recomposes one definition between tests).
 */
const isolateKinds = new WeakMap<AppDefinition, { project: ProjectApp; kinds: Promise<Kinds> }>();

function kindsOf(definition: AppDefinition, logger: Logger, clock: Clock | undefined): Promise<Kinds> {
  const project: ProjectApp = { components: definition.components, config: definition.config };
  const cached = isolateKinds.get(definition);
  if (cached !== undefined && cached.project.components === project.components && cached.project.config === project.config) return cached.kinds;
  const kinds = readKinds(project, logger, clock);
  isolateKinds.set(definition, { project, kinds });
  // A failed read is read again by the next start (it fails again, loudly, until the deploy is fixed).
  kinds.catch(() => {
    if (isolateKinds.get(definition)?.kinds === kinds) isolateKinds.delete(definition);
  });
  return kinds;
}

/** Composes the whole App with a reader of `actor.kind`, keeps its description and declarations, and drops it. */
async function readKinds(project: ProjectApp, logger: Logger, clock: Clock | undefined): Promise<Kinds> {
  let handle: KeyedHandle<ActorKind> | undefined;
  const reader = defineComponent({
    name: "deployment-cloudflare",
    setup(pikit) {
      handle = pikit.useKeyed("actor.kind");
    },
  });
  const reading = Date.now();
  const description = (await compose(project, [reader], logger, clock)).describe();
  const declarations = actorKindDeclarations(description, handle as KeyedHandle<ActorKind>);
  const problems = actorKindProblems(declarations);
  if (problems.length > 0) throw new Error(`deployment-cloudflare: the default export's actor kinds are refused (SPEC C9):\n  ${problems.join("\n  ")}`);
  const whole: ObjectApp = { kind: undefined, options: project };
  const apps = new Map<string, ObjectApp>();
  const appOf = (kind: ActorKindMatch): ObjectApp => {
    const id = `${kind.exact ? "key" : "prefix"}:${kind.pattern}`;
    let app = apps.get(id);
    if (app === undefined) {
      app = { kind, options: actorKindOptions(project, actorComposition(description, kind.owners)) };
      apps.set(id, app);
    }
    return app;
  };
  logger.info("pikit: actor kinds read", { kinds: actorKinds(declarations).length, components: project.components.length, ms: Date.now() - reading });
  let composed: Promise<void> | undefined;
  return {
    declarations,
    appFor(key) {
      const kind = key === undefined ? undefined : actorKindOf(declarations, key);
      return kind === undefined ? whole : appOf(kind);
    },
    composeEvery: () =>
      (composed ??= (async () => {
        for (const kind of actorKinds(declarations)) {
          const app = appOf(kind);
          try {
            await compose(app.options, [], logger, clock);
          } catch (error) {
            logger.error("pikit: an actor kind's App does not compose", { kind: kind.pattern, components: app.options.components.map((c) => c.name), error });
            throw new Error(`deployment-cloudflare: the actor kind "${kind.pattern}" (${kind.owners.join(", ")}) does not compose: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
      })().catch((error: unknown) => {
        composed = undefined;
        throw error;
      })),
  };
}

/** What the Worker's fetch uses of a Durable Object namespace binding. */
export interface ObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { health(): Promise<unknown> };
}

export interface WorkerHost {
  fetch(request: Request, env: WorkersHost["env"]): Promise<Response>;
}

/**
 * The Worker's fetch. `definition` is `export const worker` in `pikit.config.ts`; without one the
 * Worker serves only `GET /health`.
 */
export function createWorkerHost(definition: AppDefinition | undefined, options: HostOptions = {}): WorkerHost {
  const logger = options.logger ?? consoleLogger;
  let serving: Promise<WorkerServer> | undefined;
  /** Once per isolate, from its first request (`/health` too); a failed start is retried by the next request. */
  const boot = (env: WorkersHost["env"], origin: string): Promise<WorkerServer> =>
    (serving ??= (async () => {
      const server = createWorkerServer(logger);
      const app = await compose(definition, [server.component], logger, options.clock);
      await startWithin(app, withContextValue(WORKERS_HOST, { env, origin }, BACKGROUND_CONTEXT), options, logger);
      const keys = server.keys();
      if (keys === undefined) throw new Error("deployment-cloudflare: the Worker's App started without its server");
      logger.info("pikit: Worker started", { routes: keys });
      return server;
    })().catch((error: unknown) => {
      serving = undefined;
      logger.error("pikit: the Worker's App failed to start", { error });
      throw error;
    }));

  const health = async (env: WorkersHost["env"], origin: string): Promise<Response> => {
    const version = (env[VERSION_BINDING] as { id?: unknown } | undefined)?.id;
    const answer = (ok: boolean, error?: string) =>
      Response.json({ ok, version: typeof version === "string" ? version : null, ...(error !== undefined && { error }) }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
    // Public: it says which half failed, never why. The why is in the logs (`pikit logs`).
    try {
      await boot(env, origin);
    } catch {
      return answer(false, "the Worker's App did not start");
    }
    const objects = env[OBJECT_BINDING] as ObjectNamespace | undefined;
    if (objects === undefined) return answer(false, `no ${OBJECT_BINDING} binding: see wrangler.jsonc`);
    try {
      await objects.get(objects.idFromName(HEALTH_OBJECT)).health();
    } catch (error) {
      logger.error("pikit: /health: the object's App did not start", { error });
      return answer(false, "the object's App did not start");
    }
    return answer(true);
  };

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return await health(env, url.origin);
      let server: WorkerServer;
      try {
        server = await boot(env, url.origin);
      } catch {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return await server.serve(request);
    },
  };
}

/**
 * Starts `app` with `parent`'s values and a deadline. At the deadline, and after a failed start, the
 * app is stopped with a deadline of its own, which bounds the rollback of whatever had started (K2).
 * Rejects as the start did, or with the deadline's error once the rollback settles if the deadline
 * stopped the app although its start resolved (a `runtime.ready` listener past the deadline is
 * abandoned, not failed): a stopped App is never handed to the caller.
 */
async function startWithin(app: App, parent: Context, options: HostOptions, logger: Logger): Promise<void> {
  const startDeadlineMs = options.startDeadlineMs ?? START_DEADLINE_MS;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= app
      .stop(withAbortSignal(AbortSignal.timeout(options.rollbackDeadlineMs ?? ROLLBACK_DEADLINE_MS), BACKGROUND_CONTEXT))
      .catch((error: unknown) => logger.error("pikit: the failed start did not roll back cleanly", { error })));
  // A timer cleared once the start settles, not `AbortSignal.timeout`: a pending timer is work in
  // flight, and an object waits for it before it can be evicted.
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`deployment-cloudflare: the App did not start within ${startDeadlineMs} ms`));
    void stop();
  }, startDeadlineMs);
  try {
    await app.start(withAbortSignal(deadline.signal, parent));
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (stopping !== undefined) {
    await stopping;
    throw deadline.signal.reason;
  }
}

/**
 * The App as `pikit.config.ts` composes it (or an actor kind's part of it), recomposed with this
 * deployment's target and logger (as `deployment-docker`'s entrypoint does), plus the entrypoint's own
 * components.
 */
function compose(definition: ProjectApp | undefined, own: AppDefinition["components"], logger: Logger, clock?: Clock): Promise<App> {
  return defineApp({
    components: [...(definition?.components ?? []), ...own],
    config: { ...(definition?.config ?? {}) },
    target: "durable",
    logger,
    ...(clock !== undefined && { clock }),
  }).create();
}

/** The Worker's server: a component of the Worker's App, and how a request reaches it. */
export interface WorkerServer {
  /** Serves the App's `http.route`s; it shows in `describe()` as `deployment-cloudflare`. */
  component: ComponentDefinition;
  /** A request to the routes: 503 while the App is not running. */
  serve(request: Request): Promise<Response>;
  /** The keys it serves, most specific first, while it runs; `undefined` otherwise. */
  keys(): string[] | undefined;
}

/**
 * The Worker's server, which serves the routes by key as `server-bun` does (the `http.route`
 * contract's grammar and order: a literal path wins over one with parameters, which wins over a
 * prefix, the longest first; @pikit/contracts' `parseHttpRouteKey`): a request no route matches is a
 * 404, and a route that throws is a 500 that does not reveal why. `GET /health` is answered before it
 * (`createWorkerHost`), so no prefix (`GET /*`) shadows it. Each request has a context of its own,
 * cancelled when the client goes away or the App stops. The client's address a route sees
 * (`x-pikit-client-address`) is `cf-connecting-ip`, which Cloudflare sets on every request it
 * forwards (a client's own copy never reaches the Worker), any copy of the reserved header dropped
 * (`withClientAddress`). It passes the `http.route` suite.
 */
export function createWorkerServer(logger: Logger = consoleLogger): WorkerServer {
  type Entry = HttpRouteKey & { route: HttpRoute; key: string };
  let running: { table: Entry[]; base: AppContext; shutdown: AbortController } | undefined;
  const component = defineComponent({
    name: "deployment-cloudflare",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      return {
        start(ctx) {
          const table: Entry[] = [];
          for (const key of routes.keys()) {
            const parsed = parseHttpRouteKey(key);
            if (parsed === undefined) throw new Error(`deployment-cloudflare: cannot serve the http.route key "${key}" (expected "METHOD /path" or "METHOD /prefix/*")`);
            if (key === "GET /health") throw new Error(`deployment-cloudflare: "${key}" is the Worker's own route`);
            const route = routes.get(key);
            if (route !== undefined) table.push({ ...parsed, route, key });
          }
          // Requests must not inherit the start's deadline; each derives its own context.
          running = { table: table.sort(compareHttpRoutes), base: ctx.derive(() => BACKGROUND_CONTEXT), shutdown: new AbortController() };
        },
        stop() {
          running?.shutdown.abort(new Error("deployment-cloudflare: stopping"));
          running = undefined;
        },
      };
    },
  });
  return {
    component,
    keys: () => running?.table.map((entry) => entry.key),
    async serve(request) {
      const serving = running;
      if (serving === undefined) return Response.json({ error: "unavailable" }, { status: 503 });
      const entry = serving.table.find((e) => matchesHttpRoute(e, request.method, new URL(request.url).pathname));
      if (entry === undefined) return Response.json({ error: "not_found" }, { status: 404 });
      const signal = AbortSignal.any([request.signal, serving.shutdown.signal]);
      const addressed = withClientAddress(request, request.headers.get("cf-connecting-ip") ?? undefined);
      try {
        return await entry.route(addressed, serving.base.derive(() => withAbortSignal(signal, BACKGROUND_CONTEXT)));
      } catch (error) {
        logger.error("pikit: a route failed", { route: entry.key, error: String(error) });
        return Response.json({ error: "internal" }, { status: 500 });
      }
    },
  };
}
