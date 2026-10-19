/**
 * A sandbox host for tests: a real App of server-bun, execution-serve, and workspace-local over
 * execution-local in a temporary directory (each sandbox a directory of its own: not a sandbox, the
 * real processes of this machine), on `Bun.serve` on a free port of 127.0.0.1. Registry only: it
 * imports other components' files, which a component's own files never do.
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
import executionLocal from "../execution-local/files/src/pikit/execution-local/index.ts";
import executionServe from "../execution-serve/files/src/pikit/execution-serve/index.ts";
import { createServerBun } from "../server-bun/files/src/pikit/server-bun/index.ts";
import workspaceLocal from "../workspace-local/files/src/pikit/workspace-local/index.ts";

/** `secrets` holding `values`. */
export function secretsOf(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

export interface SandboxHost {
  url: URL;
  app: App;
  /** The directory every sandbox is in (`<root>/sandboxes/<sandbox id>`). */
  root: string;
  stop(): Promise<void>;
}

export async function startSandboxHost(options: { token: string; leaseSeconds?: number }): Promise<SandboxHost> {
  const root = mkdtempSync(join(tmpdir(), "pikit-sandbox-host-"));
  let url: URL | undefined;
  const app = await defineApp({
    components: [secretsOf({ PIKIT_SANDBOX_TOKEN: options.token }), executionLocal, workspaceLocal, executionServe, createServerBun({ onListening: (listening) => void (url = listening) })],
    config: {
      "server-bun": { port: 0, hostname: "127.0.0.1" },
      "execution-local": { root },
      "workspace-local": { root: "sandboxes" },
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
