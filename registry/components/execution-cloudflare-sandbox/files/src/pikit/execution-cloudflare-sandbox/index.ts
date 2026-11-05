/**
 * execution-cloudflare-sandbox: a sandbox host on Cloudflare Containers, speaking execution-serve's
 * protocol (`protocol.ts`), so `execution-remote` (in any pikit App, server or durable) reaches it as
 * one more host. A Worker of its own (SPEC §6: a Worker with containers gets no Previews): no runtime,
 * no agents, no channels.
 *
 * Two halves, one in each App of the host project's `pikit.config.ts`:
 * - **The Worker's** (`worker`, `worker.ts`): the route `POST /execution/v1/sandboxes/:sandbox/:operation`,
 *   with execution-serve's checks (the token first, the sandbox id as sent, `Pikit-Agent`, the body's
 *   schema), forwarding each operation to the sandbox's object.
 * - **This one, the default export**: in each `Sandbox` Durable Object (`entrypoint.ts`), one per
 *   sandbox id and agent, its container started with the agent's image, its workspace saved to
 *   `storage.blob` when idle and restored when its container is new (`sandbox.ts`, `snapshot.ts`). In
 *   any other object of the project (deployment-cloudflare's `/health` one), it does nothing.
 *
 * **No secrets** (owner's decision): this host never gets a workspace secret. The config has no
 * `secrets`, and one given (on the base or a profile) is refused at setup, saying so; nothing secret
 * travels through the protocol. An agent that needs a credential in its sandbox runs on a host that
 * injects it outside the sandbox (execution-gondolin's).
 *
 * Target: `durable` (Cloudflare: Containers are Cloudflare's; celld's Containers are not supported).
 */

import { defineComponent } from "@pikit/core";
import Type, { type Static } from "typebox";
import { SANDBOX_OBJECT } from "./context.ts";
import { AGENT_NAME, MAX_AGENT_LENGTH } from "./protocol.ts";
import { type Profile, Sandbox } from "./sandbox.ts";
import { SNAPSHOT_NAMESPACE } from "./snapshot.ts";

export { worker, WORKER_NAME } from "./worker.ts";
export { objectName } from "./sandbox.ts";

export const NAME = "execution-cloudflare-sandbox";

/** Cloudflare's named instance types a container may start as (`instance` of `ctx.container.start`). */
const INSTANCE = Type.Union([Type.Literal("lite"), Type.Literal("standard-1"), Type.Literal("standard-2"), Type.Literal("standard-3"), Type.Literal("standard-4")]);

/** A machine: which image, how large, the internet or not. `secrets` is in the schema only to be refused, by name. */
const ProfileSchema = Type.Object(
  {
    /** A name of `wrangler.jsonc`'s `containers[].images` (its `ctx.container.images`). */
    image: Type.Optional(Type.String({ minLength: 1 })),
    instance: Type.Optional(INSTANCE),
    /** Whether the container reaches the internet (`enableInternet`). */
    internet: Type.Optional(Type.Boolean()),
    secrets: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const Config = Type.Object({
  /** The base machine's image, what an agent `agents` does not name gets: a name of `containers[].images`. */
  image: Type.String({ minLength: 1, default: "base" }),
  instance: Type.Optional(INSTANCE),
  internet: Type.Boolean({ default: false }),
  /** A machine per agent, field by field over the base (agent sandboxes' decision 2). */
  agents: Type.Record(Type.String(), ProfileSchema, { default: {}, propertyNames: { pattern: AGENT_NAME.source, maxLength: MAX_AGENT_LENGTH } }),
  secrets: Type.Optional(Type.Unknown()),
  /** The workspace in the container: the agent's working directory, and what a snapshot saves. */
  root: Type.String({ pattern: "^/[^\\0]*[^/]$", default: "/workspace" }),
  /** A sandbox nobody used this long is saved to `storage.blob` and its container released. */
  idleMinutes: Type.Integer({ minimum: 1, maximum: 1440, default: 10 }),
  /** The platform's inactivity timeout, this long after `idleMinutes`: the backstop when a save never releases the container. */
  backstopMinutes: Type.Integer({ minimum: 1, maximum: 1440, default: 15 }),
  /** A command nobody reads this long is stopped; a reader unused this long is closed. */
  leaseSeconds: Type.Integer({ minimum: 10, maximum: 3600, default: 120 }),
  /** Each call of the helper in the container. */
  callSeconds: Type.Integer({ minimum: 1, maximum: 300, default: 30 }),
  /** A new container's start, until its helper answers (8 to 10 s measured; past `max_instances`, never). */
  startSeconds: Type.Integer({ minimum: 1, maximum: 300, default: 45 }),
  /** Making or restoring a snapshot (tar in the container). */
  snapshotSeconds: Type.Integer({ minimum: 1, maximum: 840, default: 300 }),
  /** A snapshot's archive unpacks to at most this many bytes, or it is refused. */
  maxUnpackedBytes: Type.Integer({ minimum: 1024 * 1024, default: 4 * 1024 * 1024 * 1024 }),
});

export type SandboxConfig = Static<typeof Config>;

/** The machine of `agent` (the header's; none for an agentless sandbox): its profile's fields over the base. */
export function profileOf(config: SandboxConfig, agent: string | undefined): Profile {
  const own = agent !== undefined && Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
  const instance = own?.instance ?? config.instance;
  return { image: own?.image ?? config.image, internet: own?.internet ?? config.internet, ...(instance !== undefined && { instance }) };
}

/** Refused at setup: this host never gets secrets (the owner's decision). */
export function refuseSecrets(config: SandboxConfig): void {
  const holders = [...(config.secrets !== undefined ? ["the base"] : []), ...Object.entries(config.agents).filter(([, profile]) => profile.secrets !== undefined).map(([agent]) => `agents.${agent}`)];
  if (holders.length > 0) {
    throw new Error(`${NAME}: ${holders.join(", ")} names secrets, but this host never gets secrets (a Cloudflare sandbox is given none, by decision): run that agent on a host that injects them outside its sandbox (execution-gondolin behind execution-serve)`);
  }
}

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    refuseSecrets(config);
    const blobs = pikit.use("storage.blob");
    return {
      start(ctx) {
        const object = ctx.value(SANDBOX_OBJECT);
        // Not a Sandbox object (deployment-cloudflare's `/health` one): nothing to serve.
        if (object === undefined) return;
        const storage = blobs.get();
        const sandbox = new Sandbox({
          container: object.container,
          storage: object.storage,
          snapshots: storage.namespace(SNAPSHOT_NAMESPACE),
          maxBlobBytes: storage.maxBytes,
          profile: (agent) => profileOf(config, agent),
          root: config.root,
          idleMs: config.idleMinutes * 60_000,
          backstopMs: (config.idleMinutes + config.backstopMinutes) * 60_000,
          leaseMs: config.leaseSeconds * 1000,
          callMs: config.callSeconds * 1000,
          startMs: config.startSeconds * 1000,
          snapshotMs: config.snapshotSeconds * 1000,
          maxUnpackedBytes: config.maxUnpackedBytes,
          now: () => ctx.clock.now(),
          logger: ctx.logger,
        });
        object.onServe((request) => sandbox.serve(request));
        object.onAlarm(() => sandbox.alarm());
      },
    };
  },
});
