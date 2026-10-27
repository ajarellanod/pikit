/**
 * execution-gondolin: each conversation's tools work in a Linux micro-VM of its own (Gondolin, over
 * QEMU), with its files on the host. A real shell that cannot read the server's files: not `.pikit/`
 * (every conversation, the credentials), not another conversation's workspace, not `.env`.
 *
 * It provides `workspace`, one sandbox per chat and agent: the chat is the key of the conversation a
 * person or a channel opened (`originOf(ref).key`), so a reset (`/new`, a new `conversationId` under
 * the same key) finds the agent's files again, and a delegated child of the same agent works in its
 * parent's sandbox, a child of another agent in that agent's own of the chat (the README says why).
 * With `workspace: "agent"` (the base's or an agent's profile), the agent has one sandbox for every
 * chat. And `execution` and `execution.shell`, one more sandbox (`default`) for a tool called
 * outside a conversation. Each sandbox:
 * - has its files in `<root>/chats/<hex SHA-256 of the chat>/<agent>/` (or `<root>/agents/<agent>/`)
 *   on the host, `/workspace` in the guest
 *   (a Gondolin VFS mount), and its temporary files in `<root>/.execution-gondolin-tmp/...`,
 *   `/tmp/pikit` in the guest (emptied at start: with image checkpoints and, with `retentionDays`, old
 *   chats' sandboxes, all this component deletes).
 *   Start refuses a `root` that is the working directory, holds it, or is `/`. The file tools work on the host directories (`env.ts`, `paths.ts`): a
 *   conversation that only reads and writes files never boots a VM. No path, and no link the guest
 *   made, leads them outside these two directories. Each directory from `root` down to them must be
 *   a real one (`made`): a symbolic link there (a guest whose `/workspace` was a directory on the
 *   way, in another layout or mode, could leave one) refuses the sandbox, nothing mounted or made
 *   through it.
 * - boots its VM at its first command, closes it after `idleSeconds` without one (`pool.ts`); at most
 *   `maxVms` run at once: a new one closes the VM idle the longest, or waits `queueSeconds` for one.
 *   An image build's VM (below) is not one of them.
 *   What the VM wrote outside `/workspace` and `/tmp/pikit` goes with it.
 * - runs on its agent's machine: the profile in `agents` whose key is `ConversationRef.agent`, each
 *   field it sets replacing the base's (`packages`, `allowedHosts`, `secrets`, `memory`, `cpus`), else
 *   the base (an agent not named, and `default`, always).
 * - reaches only its machine's `allowedHosts` (and its secrets' hosts) over HTTP(S); nothing else
 *   leaves the VM. A secret is read through the `secrets` capability at each boot and command; the
 *   guest holds a placeholder in `$NAME`, which the host replaces in requests to that secret's hosts
 *   only (SPEC C7). A VM has only its machine's secrets, never another agent's. No value is logged.
 * - with `proposals` installed (proposals-local: self-improvement on a server), reaches the proposals
 *   repository with `git`, at `file://<its path>` as the steward is told, rewritten in the guest to a
 *   host that exists only there and that this process answers with the repository's `serve`: the
 *   guest can clone and push branches under the prefix, never the main branch, and holds neither the
 *   repository nor the operator's decisions. `git` is then added to the image (`packages`).
 * - starts from Gondolin's image, or, with `packages`, from a checkpoint of it with those Alpine
 *   packages, made once and kept in `<root>/.execution-gondolin-image/` (`gondolin.ts`): one per
 *   image build and packages, so each agent's machine keeps its own.
 *
 * The sandboxes of conversations are held in a bounded cache (`cache.ts`): an idle one is dropped and
 * rebuilt at its next `resolve`, its files untouched.
 *
 * With `retentionDays`, a chat's sandboxes (every agent's in it) are deleted once nothing worked in
 * them for that many days, never while one is in use (`retention.ts`); `workspace: "agent"` ones and
 * `default` never. Without it (the default), nothing a sandbox holds is ever deleted.
 *
 * Start refuses when QEMU is missing, or when secrets (the base's or a profile's) are configured
 * without a `secrets` provider; it warns when Linux has no KVM (QEMU then emulates, slowly), and, where
 * `agent.definition`s are provided, of a profile none has (a live agent's, `agent.directory`, is not
 * checked: using it would make a cycle, the README says why). Stop closes every VM.
 *
 * Target: `server` (QEMU processes beside the app).
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { type ConversationRef, originOf } from "@pikit/contracts";
import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import Type, { type Static } from "typebox";
import { SandboxCache } from "./cache.ts";
import { createSandboxEnv, type Sandbox, TMP, WORKSPACE } from "./env.ts";
import { gondolinLauncher } from "./gondolin.ts";
import type { GuestLauncher, GuestProposals, GuestSpec } from "./guest.ts";
import { Mounts } from "./paths.ts";
import { Pool, Slot } from "./pool.ts";
import { Retention, type RetentionLog } from "./retention.ts";

/**
 * A variable name: a secret's name is the guest's `$NAME` and the name in `secrets`. Never one of
 * `Object.prototype`'s special keys, so no record of secrets, here or in Gondolin, reads one.
 */
const VARIABLE = "^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$";

/** An agent's name, as `@pikit/contracts` checks it (`defineAgent`): the keys of `agents`. */
const AGENT_NAME = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";

/** The fields of a machine, with `options`: the base's have defaults, a profile's are optional. */
const hostList = (options = {}) => Type.Array(Type.String({ minLength: 1 }), options);
const secretList = (options = {}) =>
  Type.Array(
    Type.Object({
      name: Type.String({ pattern: VARIABLE }),
      hosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    options,
  );
const memory = (options = {}) => Type.String({ pattern: "^[0-9]+[MG]$", ...options });
const cpus = (options = {}) => Type.Integer({ minimum: 1, ...options });
const packageList = (options = {}) => Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9+._-]*$" }), options);
/** Whose a workspace is: the chat's and the agent's (`chat`), or the agent's in every chat (`agent`). */
const workspaceMode = (options = {}) => Type.Union([Type.Literal("chat"), Type.Literal("agent")], options);

/**
 * An agent's machine: each field it sets replaces the base's (its `allowedHosts` are not added to the
 * base's), each it leaves out is the base's. `root`, `idleSeconds`, `maxVms` and `queueSeconds` are
 * global only: a profile with one is refused.
 */
const Profile = Type.Object(
  {
    packages: Type.Optional(packageList()),
    allowedHosts: Type.Optional(hostList()),
    secrets: Type.Optional(secretList()),
    memory: Type.Optional(memory()),
    cpus: Type.Optional(cpus()),
    workspace: Type.Optional(workspaceMode()),
  },
  { additionalProperties: false },
);

const Config = Type.Object({
  /** Where the sandboxes' files are on the host, relative to the server's working directory. Created at start. */
  root: Type.String({ minLength: 1, default: ".pikit/gondolin" }),
  /** Seconds a VM stays up with no command running; then it is closed (its `/workspace` stays). */
  idleSeconds: Type.Number({ exclusiveMinimum: 0, default: 300 }),
  /** The most VMs running at once, every agent's together. */
  maxVms: Type.Integer({ minimum: 1, default: 4 }),
  /** Seconds a command waits for a VM when `maxVms` are all running commands, then fails. */
  queueSeconds: Type.Number({ minimum: 0, default: 60 }),
  // The base machine, from here to `packages`: what an agent `agents` does not name gets.
  /** Hosts the guest may reach over HTTP and HTTPS (`api.github.com`, `*.npmjs.org`). Empty: none. */
  allowedHosts: hostList({ default: [] }),
  /**
   * Secrets the guest may use without seeing them: `$NAME` holds a placeholder, which the host replaces
   * with the value of `NAME` in `secrets` in the headers of requests to `hosts` only (reachable even
   * when not in `allowedHosts`).
   */
  secrets: secretList({ default: [] }),
  /** Each VM's memory (QEMU's syntax: `512M`, `2G`) and CPUs. */
  memory: memory({ default: "1G" }),
  cpus: cpus({ default: 2 }),
  /**
   * Alpine packages added to the guest's image (`python3-dev`, `make`): once, by a VM that reaches only
   * the Alpine mirror, then kept as a checkpoint every VM starts from. `git` comes with `proposals`.
   */
  packages: packageList({ default: [] }),
  /**
   * Whose workspace an agent's sandbox is: `chat`, one per chat (`originOf(ref).key`) and agent,
   * found again after a reset and shared with the agent's delegated children in that chat; or
   * `agent`, one per agent for every chat (an agent with the context of everything: every chat's
   * commands in one VM and one directory).
   */
  workspace: workspaceMode({ default: "chat" }),
  /**
   * A machine per agent, by agent name (`ConversationRef.agent`, exactly): its `packages`,
   * `allowedHosts`, `secrets`, `memory`, `cpus` and `workspace`, each replacing the base's. An agent not named here
   * (a misspelled key too) gets the base.
   */
  agents: Type.Record(Type.String(), Profile, { default: {}, propertyNames: { pattern: AGENT_NAME, maxLength: 100 } }),
  /**
   * Deletes a chat's sandboxes (every agent's in it, `workspace: "chat"`) once nothing has worked in
   * them for this many days: no command, no file read or written. Never one in use, never a
   * `workspace: "agent"` one. Absent (the default): kept forever. Global only.
   */
  retentionDays: Type.Optional(Type.Integer({ minimum: 1 })),
});

type Profile = Static<typeof Profile>;
type Secret = Static<ReturnType<typeof secretList>>[number];

/** The directory of a chat: the hex SHA-256 of its key (keys are any string; this is one safe name). */
function chatDirectory(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The sandbox directories under `root`, by mode: `chats/<chat>/<agent>` and `agents/<agent>`. */
const CHATS_DIR = "chats";
const AGENTS_DIR = "agents";

/** The most characters of a chat key a message shows. */
const SHOWN_KEY = 80;

/**
 * A `ConversationRef.agent` that is safe as one directory name (no `/`, no `.`, never empty) and lowercase:
 * two agents never share a directory on a case-insensitive filesystem (agent names and execution-serve's
 * `_<sandbox>` are lowercase).
 */
const AGENT_DIR = /^[a-z0-9_-]{1,128}$/;

/** The directory under `root` this component empties at start: its temporary area, named so nothing else is. */
export const TMP_DIR = ".execution-gondolin-tmp";

/** Where the image with `packages` is kept, under `root`: made when needed, its stale checkpoints removed then. */
export const IMAGE_DIR = ".execution-gondolin-image";

/** Where each chat's last use is noted, under `root`, with `retentionDays` (`retention.ts`). */
export const USED_DIR = ".execution-gondolin-used";

/** The warning for a profile no `agent.definition` has. */
export const PROFILE_WARNING =
  "execution-gondolin: `agents` names a profile no agent.definition has (misspelled?): no agent gets it, unless it is a live agent's (agents-live), which is not checked";

/** Idle sandboxes of conversations kept built; more are dropped, least recently resolved first (`cache.ts`). */
export const KEEP_SANDBOXES = 64;

/**
 * Makes `<root>/<parts...>` (`root` exists) one directory at a time, each a real directory: nothing is
 * made through a symbolic link found on the way. The first path that is not a directory of its own (a
 * link, a file), or `undefined` when none.
 */
async function realDirectories(root: string, parts: readonly string[]): Promise<string | undefined> {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    // Not recursive: its parent was checked; on a link (even a dangling one) it is EEXIST.
    await mkdir(path).catch((error: { code?: string }) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(path)).isDirectory()) return path;
  }
  return undefined;
}

/** `path` with its links resolved when it exists, else as given. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `root` is `/`, the working directory, or one of its ancestors: never a place to keep sandboxes in. */
export function holdsWorkingDirectory(root: string, cwd = process.cwd()): boolean {
  return [root, real(root)].some((dir) =>
    [cwd, real(cwd)].some((here) => dir === sep || here === dir || here.startsWith(dir.endsWith(sep) ? dir : dir + sep)),
  );
}

/** The component over `launcher`: `gondolinLauncher` (QEMU) for real, a fake in the tests. */
export function createExecutionGondolin(launcher: GuestLauncher) {
  return defineComponent({
    name: "execution-gondolin",
    config: Config,
    setup(pikit, config) {
      const secrets = pikit.useOptional("secrets");
      const proposals = pikit.useOptional("proposals");
      // Only to warn of a profile no agent has: none here (a sandbox host) is a normal state.
      const definitions = pikit.useKeyed("agent.definition");
      const root = resolve(config.root);
      /** Every secret name, of the base and of every profile: what the pool reads. */
      const secretNames = [...new Set([config.secrets, ...Object.values(config.agents).map((profile) => profile.secrets ?? [])].flat().map((secret) => secret.name))];
      let log: RetentionLog = { debug: () => {}, info: () => {}, warn: () => {} };
      let background: AppContext | undefined;
      /** The proposals repository when it is a path on this machine (proposals-local), read at each use. */
      const guestProposals: GuestProposals = {
        async remote() {
          const provider = proposals.get();
          if (provider === undefined || background === undefined) return undefined;
          const remote = await provider.remote(background);
          return remote?.kind === "path" ? { path: remote.path, serve: remote.serve } : undefined;
        },
      };

      const pool = new Pool({
        launcher,
        maxVms: config.maxVms,
        idleMs: config.idleSeconds * 1000,
        queueMs: config.queueSeconds * 1000,
        log: { info: (message, fields) => log.info(message, fields), warn: (message, fields) => log.warn(message, fields) },
        async secrets() {
          const store = secrets.get();
          const values: Record<string, string | undefined> = Object.create(null);
          for (const name of secretNames) values[name] = store === undefined ? undefined : await store.get(name);
          return values;
        },
      });

      /**
       * A sandbox over `<root>/<path>` and `<root>/<TMP_DIR>/<path>`, its VM labelled `label`, with the
       * machine of `profile` (the base where it sets nothing). Builds nothing on disk.
       */
      function sandbox(name: string, path: string, label: string, profile: Profile | undefined): Sandbox {
        const workspace = join(root, path);
        const tmp = join(root, TMP_DIR, path);
        // Field by field: the profile's when set, else the base's. Its hosts: its own plus its own secrets'.
        const own: Secret[] = profile?.secrets ?? config.secrets;
        const allowedHosts = [...new Set([...(profile?.allowedHosts ?? config.allowedHosts), ...own.flatMap((secret) => secret.hosts)])];
        const spec = (values: Record<string, string | undefined>): GuestSpec => {
          const unset = own.filter((secret) => !values[secret.name]).map((secret) => secret.name);
          if (unset.length > 0) log.warn("execution-gondolin: secrets not set, left out of this VM until its next boot", { sandbox: name, secrets: unset });
          return {
            label,
            mounts: { [WORKSPACE]: workspace, [TMP]: tmp },
            allowedHosts,
            secrets: own.flatMap((secret) => {
              const value = values[secret.name];
              return value ? [{ name: secret.name, hosts: secret.hosts, value }] : [];
            }),
            memory: profile?.memory ?? config.memory,
            cpus: profile?.cpus ?? config.cpus,
            // The steward's git, with proposals here.
            packages: [...new Set([...(proposals.get() === undefined ? [] : ["git"]), ...(profile?.packages ?? config.packages)])],
            imageDir: join(root, IMAGE_DIR),
            ...(proposals.get() !== undefined && { proposals: guestProposals }),
          };
        };
        return {
          name,
          mounts: new Mounts([
            { guest: WORKSPACE, host: workspace },
            { guest: TMP, host: tmp },
          ]),
          workspace,
          tmp,
          pool,
          slot: new Slot(name, spec),
          running: new Set(),
          changed: new Set(),
          active: 0,
        };
      }

      /**
       * Makes a sandbox's directories (again, if someone removed them), refusing it (`whose` names it)
       * when one on the way from `root` is not a real directory: a guest whose `/workspace` was one of
       * those on the way (an earlier layout, the other `workspace` mode) may have left the next one as
       * a link to anywhere, which the VM's mount and the file tools would otherwise follow.
       */
      const made = async (box: Sandbox, whose: string) => {
        await mkdir(root, { recursive: true });
        for (const dir of [box.tmp, box.workspace]) {
          const wrong = await realDirectories(root, relative(root, dir).split(sep));
          if (wrong !== undefined) {
            throw new Error(
              `execution-gondolin: the sandbox of ${whose} is refused: ${relative(root, wrong)} (under root) is a symbolic link or a file, not a directory of its own (a guest's, of another layout or mode?); nothing was mounted or made through it: move it away`,
            );
          }
        }
      };

      // No conversation, no agent: always the base machine.
      const fallback = sandbox("default", "default", "pikit default", undefined);
      const defaultEnv = createSandboxEnv(fallback);
      pikit.provide("execution", defaultEnv);
      pikit.provide("execution.shell", defaultEnv);

      // By the sandbox's path under `root` (`chats/<chat>/<agent>`, `agents/<agent>`). Bounded: an entry
      // with a VM, a running command or a file operation in flight is never dropped, so a sandbox never
      // has two, and retention sees every sandbox in use among the entries.
      const idle = (box: Sandbox) => box.slot.guest === undefined && box.slot.busy === 0 && box.running.size === 0 && box.active === 0;
      const conversations = new SandboxCache<{ box: Sandbox; env: ExecutionEnv }>(KEEP_SANDBOXES, ({ box }) => idle(box));
      const retention =
        config.retentionDays === undefined
          ? undefined
          : new Retention({
              chats: join(root, CHATS_DIR),
              tmp: join(root, TMP_DIR, CHATS_DIR),
              markers: join(root, USED_DIR),
              trash: join(root, TMP_DIR, "retired"),
              days: config.retentionDays,
              clock: pikit.clock,
              live: (chat) => {
                const prefix = join(CHATS_DIR, chat) + sep;
                for (const [path, { box }] of conversations.all()) if (path.startsWith(prefix) && !idle(box)) return true;
                return false;
              },
              log: { debug: (message, fields) => log.debug(message, fields), info: (message, fields) => log.info(message, fields), warn: (message, fields) => log.warn(message, fields) },
            });
      const provider: WorkspaceProvider = {
        async resolve(conversation: ConversationRef) {
          const agent = conversation.agent;
          if (typeof agent !== "string" || !AGENT_DIR.test(agent)) {
            throw new Error(`execution-gondolin: agent ${JSON.stringify(agent)} is not a safe directory name (lowercase letters, digits, _ and -, at most 128)`);
          }
          // The agent's own profile, by exact key (an own property: `constructor` is no profile), else the base.
          const profile = Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
          let path: string;
          let label: string;
          let whose: string;
          /** The chat's directory, for retention; none for an agent's one sandbox. */
          let chatDir: string | undefined;
          if ((profile?.workspace ?? config.workspace) === "agent") {
            path = join(AGENTS_DIR, agent);
            label = `pikit ${agent}`;
            whose = `agent ${JSON.stringify(agent)} (one for every chat)`;
          } else {
            // The chat: the conversation a person or a channel opened, the same through resets and for its delegated children.
            const chat = originOf(conversation).key;
            if (typeof chat !== "string" || chat === "") {
              throw new Error(`execution-gondolin: the conversation's chat (its origin's key) is ${JSON.stringify(chat)}: a sandbox needs a non-empty key`);
            }
            const dir = chatDirectory(chat);
            chatDir = dir;
            path = join(CHATS_DIR, dir, agent);
            label = `pikit ${agent} ${dir.slice(0, 12)}`;
            whose = `agent ${JSON.stringify(agent)} in chat ${JSON.stringify(chat.slice(0, SHOWN_KEY))}`;
          }
          const found = conversations.get(path, () => {
            const box = sandbox(path, path, label, profile);
            return { box, env: createSandboxEnv(box) };
          });
          // Noted before anything awaits; waits for a retirement of the chat in progress, which leaves no directory.
          if (chatDir !== undefined) await retention?.use(chatDir);
          // Every call: a directory removed meanwhile is made again, and one made already costs nothing.
          await made(found.box, whose);
          return { env: found.env };
        },
      };
      pikit.provide("workspace", provider);

      return {
        async start(ctx) {
          log = ctx.logger;
          background = ctx.derive(() => BACKGROUND_CONTEXT);
          if (holdsWorkingDirectory(root)) {
            throw new Error(`execution-gondolin: root ${JSON.stringify(config.root)} is the working directory, holds it, or is /: give the sandboxes a directory of their own (the default is .pikit/gondolin)`);
          }
          const problem = launcher.check();
          if (problem !== undefined) throw new Error(`execution-gondolin: ${problem}`);
          if (secretNames.length > 0 && secrets.get() === undefined) {
            throw new Error(`execution-gondolin: secrets are configured (${secretNames.join(", ")}) but no \`secrets\` provider is installed: add one (secrets-env)`);
          }
          // A misspelled profile gives its agent the base (fails closed); say so where agents are known.
          // Only the code's: a live agent (`agent.directory`) cannot be read here without a cycle
          // (agents-live uses `agent.tool`s, which use `execution.shell`), so the message allows for one.
          const known = definitions.keys();
          const unknown = Object.keys(config.agents).filter((name) => !known.includes(name));
          if (known.length > 0 && unknown.length > 0) {
            ctx.logger.warn(PROFILE_WARNING, { profiles: unknown, agents: known });
          }
          const warning = launcher.warning();
          if (warning !== undefined) ctx.logger.warn(`execution-gondolin: ${warning}`);
          // Temporary files and spilled output of an earlier process: no VM and no tool refers to them now.
          await rm(join(root, TMP_DIR), { recursive: true, force: true });
          await made(fallback, '"default" (execution)');
          // In the background: a first sweep may have much to delete.
          retention?.start();
        },
        async stop() {
          await retention?.stop();
          await pool.stop();
        },
      };
    },
  });
}

export default createExecutionGondolin(gondolinLauncher);
