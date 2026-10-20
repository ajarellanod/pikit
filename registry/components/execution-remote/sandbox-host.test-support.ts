/**
 * A sandbox host for tests: a real App of server-bun, execution-serve, and a `workspace` provider over
 * execution-local in a temporary directory, on `Bun.serve` on a free port of 127.0.0.1. The provider
 * gives each sandbox and agent a directory of its own, as execution-gondolin does behind execution-serve
 * (its chat is the sandbox's key, one to one with the `conversationId` this double keys by):
 * `<root>/sandboxes/<conversationId>/<agent>` (not a sandbox: the real processes of this machine). With
 * `workspace: "workspace-local"`, it is workspace-local instead
 * (`<root>/sandboxes/<agent>/_chats/<hash of execution-serve:<sandbox>>`, the trial setup). Registry only: it imports other components' files, which a component's own files
 * never do.
 *
 * `app.test.ts` starts it in its process. The workerd lane (`tests/workerd/test/sandbox-outbound.ts`)
 * runs this file with Bun (`bun sandbox-host.test-support.ts <token>`): it prints the host's URL on its
 * first line, and stops at SIGTERM or when its stdin closes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { SecretStore } from "@pikit/contracts";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd } from "@pikit/pi-adapter/execution";
import executionLocal from "../execution-local/files/src/pikit/execution-local/index.ts";
import executionServe from "../execution-serve/files/src/pikit/execution-serve/index.ts";
import { createServerBun } from "../server-bun/files/src/pikit/server-bun/index.ts";
import workspaceLocal from "../workspace-local/files/src/pikit/workspace-local/index.ts";

/** `secrets` holding `values`. */
export function secretsOf(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

/** A safe directory name: execution-serve's rule for `conversationId`, execution-gondolin's for `agent` (and more). */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** `workspace` per sandbox and agent: `sandboxes/<conversationId>/<agent>` in `execution`; an unsafe name throws. */
const sandboxDirectories = defineComponent({
  name: "workspace-sandboxes-test",
  setup(pikit) {
    const execution = pikit.use("execution");
    const provider: WorkspaceProvider = {
      async resolve(conversation, context) {
        if (!SAFE_NAME.test(conversation.conversationId) || !SAFE_NAME.test(conversation.agent)) throw new Error(`unsafe conversationId or agent: ${conversation.conversationId} ${conversation.agent}`);
        const env = execution.get();
        const cwd = `sandboxes/${conversation.conversationId}/${conversation.agent}`;
        const made = await env.createDir(cwd, { recursive: true }, toChord(context));
        if (!made.ok) throw made.error;
        return { env: await atCwd(env, cwd, toChord(context)) };
      },
    };
    pikit.provide("workspace", provider);
  },
});

export interface SandboxHost {
  url: URL;
  app: App;
  /** The directory every sandbox is in (`<root>/sandboxes/remote-<sandbox id>/<agent>`, or `<root>/sandboxes/<agent>/_chats/<hash>` behind workspace-local). */
  root: string;
  stop(): Promise<void>;
}

export async function startSandboxHost(options: { token: string; leaseSeconds?: number; workspace?: "sandboxes" | "workspace-local" }): Promise<SandboxHost> {
  const root = mkdtempSync(join(tmpdir(), "pikit-sandbox-host-"));
  let url: URL | undefined;
  const workspace = options.workspace === "workspace-local" ? workspaceLocal : sandboxDirectories;
  const app = await defineApp({
    components: [secretsOf({ PIKIT_SANDBOX_TOKEN: options.token }), executionLocal, workspace, executionServe, createServerBun({ onListening: (listening) => void (url = listening) })],
    config: {
      "server-bun": { port: 0, hostname: "127.0.0.1" },
      "execution-local": { root },
      ...(workspace === workspaceLocal && { "workspace-local": { root: "sandboxes" } }),
      "execution-serve": { leaseSeconds: options.leaseSeconds ?? 120 },
    },
    logger: silentLogger,
  }).create();
  await app.start();
  if (url === undefined) throw new Error("sandbox host: server-bun did not listen");
  return {
    url,
    app,
    root,
    async stop() {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const token = process.argv[2];
  if (token === undefined) throw new Error("usage: bun sandbox-host.test-support.ts <token>");
  const host = await startSandboxHost({ token });
  console.log(host.url.href);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await host.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.resume();
}
