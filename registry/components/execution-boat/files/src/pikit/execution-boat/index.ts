/**
 * execution-boat: each agent's tools work, in each chat, in a boat.dev VM of its own (a persistent
 * Ubuntu machine in boat's cloud), behind a sandbox host: execution-serve serves this component's
 * `workspace` to execution-remote clients (a Cloudflare Durable Object, another server).
 *
 * - **A VM per chat and agent**: the chat is `originOf(ref).key` (behind execution-serve, the
 *   sandbox: `execution-serve:<id>`), and the workspace is the hex SHA-256 of `"<chat>\n<agent>"`,
 *   carried as the VM's label (`vms.ts`): created on first use with the agent's machine (the profile
 *   in `agents` whose key is the agent, field by field over the base: `size`, `template`, a saved
 *   snapshot it starts from), stopped after `idleSeconds` without use (boat keeps the disk, billing
 *   stops), resumed by the next use, deleted once stopped for `retentionDays`.
 *   `execution` and `execution.shell` are one more VM (`default`, the base machine), for a tool
 *   called outside a conversation.
 * - **Files and commands** are the VM's (`env.ts`): its `/home/user/workspace` is the cwd.
 * - **No secrets in a VM** (the owner's decision): every VM is boat's `noEnv` (none of the account's
 *   variables, secret files or credentials), nothing of this App's `secrets` is sent to one, and a
 *   profile with `secrets` is refused. boat cannot restrict a VM's network (no egress policy in its
 *   API), so `allowedHosts` is refused too, rather than promised.
 * - **The API key** is the gateway's own secret (`BOAT_API_KEY`), read at start through `secrets`,
 *   sent only to boat's API, never in a VM, a log or an error (`api.ts` redacts it).
 * - **Portable**, with `snapshots: true` (needs `storage.blob`): a workspace is exported in the shared
 *   snapshot format before each stop and before its VM is deleted, and restored when a chat's agent
 *   has no VM (`portable.ts`, `snapshot.ts`).
 * - **Bounded**: `maxVms` up at once (the idlest stopped for a new one, else a bounded wait), every
 *   boat call with a deadline, a boat outage answered `shell_unavailable` (commands) or `unknown`
 *   (files), as execution-gondolin's failed boots.
 *
 * Target: `server` (the gateway's timers, its view of the VMs it runs).
 */

import { createHash } from "node:crypto";
import { type BlobStorage, type ConversationRef, originOf } from "@pikit/contracts";
import { type AppContext, defineComponent } from "@pikit/core";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT } from "@pikit/pi-adapter/execution";
import Type, { type Static } from "typebox";
import { BoatApi, SIZES, type Size } from "./api.ts";
import { createBoatEnv, type VmPaths } from "./env.ts";
import { MARKER } from "./helper.ts";
import { boatSnapshots, helper } from "./portable.ts";
import { type Machine, type VmLog, Vms } from "./vms.ts";

/** An agent's name, as `@pikit/contracts` checks it (`defineAgent`): the keys of `agents`. */
const AGENT_NAME = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** A `ConversationRef.agent` this component takes: an agent's name, or execution-serve's `_<sandbox>`. */
const AGENT = /^[a-z0-9_-]{1,128}$/;
/** A saved snapshot's name on boat (1-63 lowercase letters, digits, dashes), or a share code (`bsh_...`). */
const TEMPLATE = "^([a-z0-9][a-z0-9-]{0,62}|bsh_[A-Za-z0-9_-]{1,200})$";

const size = (options = {}) => Type.Union(SIZES.map((name) => Type.Literal(name)), options);

/**
 * An agent's machine: each field it sets replaces the base's. `secrets` and `allowedHosts` are named
 * only to be refused with a reason (no secret reaches a boat VM; boat cannot restrict egress).
 */
const Profile = Type.Object(
  {
    size: Type.Optional(size()),
    template: Type.Optional(Type.String({ pattern: TEMPLATE })),
    secrets: Type.Optional(Type.Array(Type.Unknown())),
    allowedHosts: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const Config = Type.Object({
  /** boat's API. */
  apiUrl: Type.String({ pattern: "^https?://", default: "https://boat.dev/api/v1" }),
  /** The name of the secret holding the API key: never the key. */
  apiKeySecret: Type.String({ minLength: 1, default: "BOAT_API_KEY" }),
  /** This gateway's label on its VMs (`pikit-gateway`): two gateways on one boat account keep apart. */
  gateway: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$", default: "pikit" }),
  // The base machine: what an agent `agents` does not name gets.
  /** boat's machine size: `small` (2 vCPU, 4 GB), `default` (4, 8), `large` (8, 16), `xlarge` (16, 32). */
  size: size({ default: "small" }),
  /** A saved snapshot every new VM starts from (your prepared image), absent for boat's own. */
  template: Type.Optional(Type.String({ pattern: TEMPLATE })),
  secrets: Type.Optional(Type.Array(Type.Unknown())),
  allowedHosts: Type.Optional(Type.Array(Type.String())),
  /** A machine per agent, by agent name (`ConversationRef.agent`, exactly). */
  agents: Type.Record(Type.String(), Profile, { default: {}, propertyNames: { pattern: AGENT_NAME, maxLength: 100 } }),
  /** Seconds a VM stays up with no file operation or command (and nothing a command left running); then it is stopped. */
  idleSeconds: Type.Number({ exclusiveMinimum: 0, default: 600 }),
  /** Days a stopped VM is kept before it is deleted. boat keeps a stopped VM's disk at least 14 days. */
  retentionDays: Type.Number({ exclusiveMinimum: 0, maximum: 14, default: 13 }),
  /** The most VMs up at once, every agent's together. */
  maxVms: Type.Integer({ minimum: 1, default: 4 }),
  /** Seconds a use waits when `maxVms` are all in use, then fails. */
  queueSeconds: Type.Number({ minimum: 0, default: 60 }),
  /** Seconds a create or a resume may take until the VM is ready. */
  startSeconds: Type.Number({ exclusiveMinimum: 0, default: 120 }),
  /** Seconds one boat API call may take (a file operation's included). */
  callSeconds: Type.Number({ minimum: 1, maximum: 590, default: 60 }),
  /** boat's own auto-stop, the safety net if this gateway dies: pushed forward while a VM is in use. */
  autoStopSeconds: Type.Integer({ minimum: 60, default: 3600 }),
  /** Export workspaces in the shared snapshot format (needs `storage.blob`), and restore them into new VMs. */
  snapshots: Type.Boolean({ default: false }),
  /** The program that runs the file helper in the VM. */
  node: Type.String({ pattern: "^[A-Za-z0-9._/-]+$", default: "node" }),
});

type Profile = Static<typeof Profile>;

/** What the tests replace: the API's `fetch`, where a VM's files are, how often boat is polled, the `/proc` the idle check reads. */
export interface BoatSeams {
  fetch?: typeof fetch;
  paths?: (key: string) => VmPaths;
  pollMs?: number;
  proc?: string;
}

export const DEFAULT_PATHS: VmPaths = { home: "/home/user", tmp: "/tmp/pikit" };
const HOUR = 3_600_000;

/** A workspace: the hex SHA-256 of `"<chat key>\n<agent>"`, as the shared snapshot format keys it. */
export function workspaceOf(chat: string, agent: string): string {
  return createHash("sha256").update(`${chat}\n${agent}`).digest("hex");
}
const DAY = 24 * HOUR;

/** Refuses what a boat VM cannot honour: secrets (owner's decision: none in a cloud VM) and an egress policy. */
function refuseUnenforceable(where: string, machine: { secrets?: unknown[] | undefined; allowedHosts?: string[] | undefined }): void {
  if (machine.secrets !== undefined && machine.secrets.length > 0) {
    throw new Error(`execution-boat: ${where} asks for secrets: no secret reaches a boat VM (a cloud sandbox), so it is refused; give that agent a Gondolin host instead`);
  }
  if (machine.allowedHosts !== undefined) {
    throw new Error(`execution-boat: ${where} sets allowedHosts: boat cannot restrict a VM's network (its outbound traffic is open), so it is refused rather than promised`);
  }
}

export function createExecutionBoat(seams: BoatSeams = {}) {
  return defineComponent({
    name: "execution-boat",
    config: Config,
    setup(pikit, config) {
      refuseUnenforceable("the base machine", config);
      for (const [agent, profile] of Object.entries(config.agents)) refuseUnenforceable(`the profile of ${JSON.stringify(agent)}`, profile);
      const secrets = pikit.use("secrets");
      const blob = pikit.useOptional("storage.blob");
      const paths = seams.paths ?? (() => DEFAULT_PATHS);
      const proc = seams.proc ?? "/proc";
      const pollMs = seams.pollMs ?? 1000;
      let key: string | undefined;
      let log: VmLog = { debug: () => {}, info: () => {}, warn: () => {} };
      const api = new BoatApi({
        baseUrl: config.apiUrl,
        key: () => {
          if (key === undefined) throw new Error("execution-boat has not started");
          return key;
        },
        fetch: seams.fetch ?? fetch,
        timeoutMs: config.callSeconds * 1000,
      });
      const base: Machine = { size: config.size as Size, ...(config.template !== undefined && { template: config.template }) };
      const machineOf = (profile: Profile | undefined): Machine => {
        const template = profile?.template ?? config.template;
        return { size: (profile?.size ?? config.size) as Size, ...(template !== undefined && { template }) };
      };
      const vms = new Vms({
        api,
        clock: pikit.clock,
        gateway: config.gateway,
        maxVms: config.maxVms,
        queueMs: config.queueSeconds * 1000,
        idleMs: config.idleSeconds * 1000,
        startMs: config.startSeconds * 1000,
        retentionMs: config.retentionDays * DAY,
        autoStopSeconds: config.autoStopSeconds,
        base,
        pollMs,
        prepare: async (id, vm) => {
          const where = paths(vm.key);
          for (const dir of [`${where.home}/workspace`, where.tmp]) await helper(api, id, config.node, { op: "mkdir", path: dir, recursive: true }, config.callSeconds);
        },
        probe: (id) => helper<number>(api, id, config.node, { op: "probe", proc, marker: MARKER }, config.callSeconds),
        ...(config.snapshots && {
          snapshots: boatSnapshots({
            api,
            blob: () => blob.get() as BlobStorage,
            paths,
            node: config.node,
            clock: pikit.clock,
            log: () => log,
          }),
        }),
        log: { debug: (m, f) => log.debug(m, f), info: (m, f) => log.info(m, f), warn: (m, f) => log.warn(m, f) },
      });

      const envs = new Map<string, ExecutionEnv>();
      /** The environment of workspace `workspace` (hex SHA-256 of `"<chat>\n<agent>"`), on `machine`. */
      const envOf = (workspace: string, agent: string, machine: Machine): ExecutionEnv => {
        const vm = vms.vm(workspace, agent, machine);
        let env = envs.get(workspace);
        if (env === undefined) {
          env = createBoatEnv(`execution-boat:${workspace}`, { vms, vm, api, paths: paths(workspace), node: config.node, callSeconds: config.callSeconds, pollMs });
          envs.set(workspace, env);
        }
        return env;
      };

      // `execution`'s own VM: no conversation, no agent, the base machine.
      const fallback = envOf(workspaceOf("execution-boat:default", "_default"), "_default", base);
      pikit.provide("execution", fallback);
      pikit.provide("execution.shell", fallback);

      const provider: WorkspaceProvider = {
        async resolve(conversation: ConversationRef) {
          const agent = conversation.agent;
          if (typeof agent !== "string" || !AGENT.test(agent)) {
            throw new Error(`execution-boat: agent ${JSON.stringify(agent)} is not an agent's name (lowercase letters, digits, _ and -, at most 128)`);
          }
          const chat = originOf(conversation).key;
          if (typeof chat !== "string" || chat === "") {
            throw new Error(`execution-boat: the conversation's chat (its origin's key) is ${JSON.stringify(chat)}: a VM needs a non-empty key`);
          }
          const profile = Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
          return { env: envOf(workspaceOf(chat, agent), agent, machineOf(profile)) };
        },
      };
      pikit.provide("workspace", provider);

      let stopped = false;
      const loop = async (everyMs: number, work: () => Promise<unknown>, what: string, first = false) => {
        if (first) await work().catch((error: unknown) => log.warn(`execution-boat: ${what} failed`, { reason: error instanceof Error ? error.message : String(error) }));
        while (!stopped) {
          await pikit.clock.sleep(everyMs);
          if (stopped) return;
          await work().catch((error: unknown) => log.warn(`execution-boat: ${what} failed`, { reason: error instanceof Error ? error.message : String(error) }));
        }
      };

      return {
        async start(ctx: AppContext) {
          log = ctx.logger;
          const value = await secrets.get().get(config.apiKeySecret);
          if (value === undefined || value === "") {
            throw new Error(`execution-boat: the secret ${config.apiKeySecret} (boat's API key) is not set: create a key in boat's dashboard and set it in .env`);
          }
          key = value;
          if (config.snapshots && blob.get() === undefined) {
            throw new Error("execution-boat: snapshots is on but no storage.blob provider is installed: add one (storage-blob-s3)");
          }
          // In the background: start does not wait on boat.
          void loop(Math.min(30_000, (config.idleSeconds * 1000) / 2), () => vms.idleTick(), "the idle check");
          void loop(HOUR, () => vms.sweep(), "the retention sweep", true);
        },
        async stop() {
          stopped = true;
          for (const env of envs.values()) await env.cleanup(BACKGROUND_CONTEXT);
          vms.close();
        },
      };
    },
  });
}

export default createExecutionBoat();
