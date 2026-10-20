/**
 * execution-gondolin: each conversation's tools work in a Linux micro-VM of its own (Gondolin, over
 * QEMU), with its files on the host. A real shell that cannot read the server's files: not `.pikit/`
 * (every conversation, the credentials), not another conversation's workspace, not `.env`.
 *
 * It provides `workspace`, one sandbox per conversation, keyed by `ConversationRef.conversationId`
 * alone (the README says why), and `execution` and `execution.shell`, one more sandbox (`default`)
 * for a tool called outside a conversation. Each sandbox:
 * - has its files in `<root>/conversations/<conversationId>/` on the host, `/workspace` in the guest
 *   (a Gondolin VFS mount), and its temporary files in `<root>/.execution-gondolin-tmp/...`,
 *   `/tmp/pikit` in the guest (emptied at start: the one directory this component deletes).
 *   Start refuses a `root` that is the working directory, holds it, or is `/`. The file tools work on the host directories (`env.ts`, `paths.ts`): a
 *   conversation that only reads and writes files never boots a VM. No path, and no link the guest
 *   made, leads them outside these two directories.
 * - boots its VM at its first command, closes it after `idleSeconds` without one (`pool.ts`); at most
 *   `maxVms` run at once: a new one closes the VM idle the longest, or waits `queueSeconds` for one.
 *   What the VM wrote outside `/workspace` and `/tmp/pikit` goes with it.
 * - reaches only `allowedHosts` (and its secrets' hosts) over HTTP(S); nothing else leaves the VM.
 *   A secret (`secrets`) is read through the `secrets` capability at each boot and command; the guest
 *   holds a placeholder in `$NAME`, which the host replaces in requests to that secret's hosts only
 *   (SPEC C7). No value is logged.
 * - with `proposals` installed (proposals-local: self-improvement on a server), reaches the proposals
 *   repository with `git`, at `file://<its path>` as the steward is told, rewritten in the guest to a
 *   host that exists only there and that this process answers with the repository's `serve`: the
 *   guest can clone and push branches under the prefix, never the main branch, and holds neither the
 *   repository nor the operator's decisions. `git` is then added to the image (`packages`).
 * - starts from Gondolin's image, or, with `packages`, from a checkpoint of it with those Alpine
 *   packages, made once and kept in `<root>/.execution-gondolin-image/` (`gondolin.ts`).
 *
 * The sandboxes of conversations are held in a bounded cache (`cache.ts`): an idle one is dropped and
 * rebuilt at its next `resolve`, its files untouched.
 *
 * Start refuses when QEMU is missing, or when secrets are configured without a `secrets` provider; it
 * warns when Linux has no KVM (QEMU then emulates, slowly). Stop closes every VM.
 *
 * Target: `server` (QEMU processes beside the app).
 */

import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ConversationRef } from "@pikit/contracts";
import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import Type from "typebox";
import { SandboxCache } from "./cache.ts";
import { createSandboxEnv, type Sandbox, TMP, WORKSPACE } from "./env.ts";
import { gondolinLauncher } from "./gondolin.ts";
import type { GuestLauncher, GuestProposals, GuestSpec } from "./guest.ts";
import { Mounts } from "./paths.ts";
import { Pool, type PoolLog, Slot } from "./pool.ts";

/** A variable name: a secret's name is the guest's `$NAME` and the name in `secrets`. */
const VARIABLE = "^[A-Za-z_][A-Za-z0-9_]*$";

const Config = Type.Object({
  /** Where the sandboxes' files are on the host, relative to the server's working directory. Created at start. */
  root: Type.String({ minLength: 1, default: ".pikit/gondolin" }),
  /** Seconds a VM stays up with no command running; then it is closed (its `/workspace` stays). */
  idleSeconds: Type.Number({ exclusiveMinimum: 0, default: 300 }),
  /** The most VMs running at once. */
  maxVms: Type.Integer({ minimum: 1, default: 4 }),
  /** Seconds a command waits for a VM when `maxVms` are all running commands, then fails. */
  queueSeconds: Type.Number({ minimum: 0, default: 60 }),
  /** Hosts the guest may reach over HTTP and HTTPS (`api.github.com`, `*.npmjs.org`). Empty: none. */
  allowedHosts: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  /**
   * Secrets the guest may use without seeing them: `$NAME` holds a placeholder, which the host replaces
   * with the value of `NAME` in `secrets` in the headers of requests to `hosts` only (reachable even
   * when not in `allowedHosts`).
   */
  secrets: Type.Array(
    Type.Object({
      name: Type.String({ pattern: VARIABLE }),
      hosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    { default: [] },
  ),
  /** Each VM's memory (QEMU's syntax: `512M`, `2G`) and CPUs. */
  memory: Type.String({ pattern: "^[0-9]+[MG]$", default: "1G" }),
  cpus: Type.Integer({ minimum: 1, default: 2 }),
  /**
   * Alpine packages added to the guest's image (`python3-dev`, `make`): once, by a VM that reaches only
   * the Alpine mirror, then kept as a checkpoint every VM starts from. `git` comes with `proposals`.
   */
  packages: Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9+._-]*$" }), { default: [] }),
});

/**
 * A `conversationId` that is safe as one directory name: no `/`, no `.`, never empty. pikit's runtime
 * numbers its conversations (`"1"`); anything else that resolves a workspace names it so.
 */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The directory under `root` this component empties at start: its temporary area, named so nothing else is. */
export const TMP_DIR = ".execution-gondolin-tmp";

/** Where the image with `packages` is kept, under `root`: made when needed, its stale checkpoints removed then. */
export const IMAGE_DIR = ".execution-gondolin-image";

/** Idle conversation sandboxes kept built; more are dropped, least recently resolved first (`cache.ts`). */
export const KEEP_SANDBOXES = 64;

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
      const root = resolve(config.root);
      const allowedHosts = [...new Set([...config.allowedHosts, ...config.secrets.flatMap((secret) => secret.hosts)])];
      let log: PoolLog = { info: () => {}, warn: () => {} };
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
          const values: Record<string, string | undefined> = {};
          for (const secret of config.secrets) values[secret.name] = store === undefined ? undefined : await store.get(secret.name);
          return values;
        },
      });

      /** A sandbox over `<root>/<path>` and `<root>/<TMP_DIR>/<path>`, its VM labelled `label`. Builds nothing on disk. */
      function sandbox(name: string, path: string, label: string): Sandbox {
        const workspace = join(root, path);
        const tmp = join(root, TMP_DIR, path);
        const spec = (values: Record<string, string | undefined>): GuestSpec => {
          const unset = config.secrets.filter((secret) => !values[secret.name]).map((secret) => secret.name);
          if (unset.length > 0) log.warn("execution-gondolin: secrets not set, left out of this VM until its next boot", { sandbox: name, secrets: unset });
          return {
            label,
            mounts: { [WORKSPACE]: workspace, [TMP]: tmp },
            allowedHosts,
            secrets: config.secrets.flatMap((secret) => {
              const value = values[secret.name];
              return value ? [{ name: secret.name, hosts: secret.hosts, value }] : [];
            }),
            memory: config.memory,
            cpus: config.cpus,
            // The steward's git, with proposals here.
            packages: [...new Set([...(proposals.get() === undefined ? [] : ["git"]), ...config.packages])],
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
        };
      }

      /** Makes a sandbox's directories (again, if someone removed them). */
      const made = async (box: Sandbox) => {
        await mkdir(box.tmp, { recursive: true });
        await mkdir(box.workspace, { recursive: true });
      };

      const fallback = sandbox("default", "default", "pikit default");
      const defaultEnv = createSandboxEnv(fallback);
      pikit.provide("execution", defaultEnv);
      pikit.provide("execution.shell", defaultEnv);

      // Bounded: an entry with a VM or a running command is never dropped, so a conversation never has two.
      const conversations = new SandboxCache<{ box: Sandbox; env: ExecutionEnv }>(
        KEEP_SANDBOXES,
        ({ box }) => box.slot.guest === undefined && box.slot.busy === 0 && box.running.size === 0,
      );
      const provider: WorkspaceProvider = {
        async resolve(conversation: ConversationRef) {
          const id = conversation.conversationId;
          if (!CONVERSATION_ID.test(id)) {
            throw new Error(`execution-gondolin: conversation id ${JSON.stringify(id)} is not a safe directory name (letters, digits, _ and -, at most 128)`);
          }
          const found = conversations.get(id, () => {
            const box = sandbox(`conversation-${id}`, join("conversations", id), `pikit ${conversation.agent} ${id}`);
            return { box, env: createSandboxEnv(box) };
          });
          // Every call: a directory removed meanwhile is made again, and one made already costs nothing.
          await made(found.box);
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
          const names = config.secrets.map((secret) => secret.name);
          if (names.length > 0 && secrets.get() === undefined) {
            throw new Error(`execution-gondolin: secrets are configured (${names.join(", ")}) but no \`secrets\` provider is installed: add one (secrets-env)`);
          }
          const warning = launcher.warning();
          if (warning !== undefined) ctx.logger.warn(`execution-gondolin: ${warning}`);
          // Temporary files and spilled output of an earlier process: no VM and no tool refers to them now.
          await rm(join(root, TMP_DIR), { recursive: true, force: true });
          await made(fallback);
        },
        async stop() {
          await pool.stop();
        },
      };
    },
  });
}

export default createExecutionGondolin(gondolinLauncher);
