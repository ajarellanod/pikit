/**
 * The sample's composition for its tests: the same components as `pikit.config.ts`, over real HTTP
 * on a free port, with state in a temporary directory. Two things are swapped, as a test must:
 * - the model is Pi's faux provider, scripted by `@pikit/pi-adapter/testing` (no API key);
 * - the token comes from a test environment instead of the process's.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentDefinition, type App, type ComponentDefinition, defineApp, silentLogger } from "@pikit/core";
import type { PiExtension } from "@pikit/pi-adapter";
import { testComponents } from "@pikit/pi-adapter/testing";
import channelHttp from "../../../registry/components/channel-http/files/src/pikit/channels/http/index.ts";
import conversationsFile from "../../../registry/components/conversations-file/files/src/pikit/conversations-file/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router/basic/index.ts";
import { createRuntimePi } from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { createSecretsEnv } from "../../../registry/components/secrets-env/files/src/pikit/secrets-env/index.ts";
import { createServerBun } from "../../../registry/components/server-bun/files/src/pikit/server/bun/index.ts";
import sessionsJsonl from "../../../registry/components/sessions-jsonl/files/src/pikit/sessions-jsonl/index.ts";

export const TOKEN = "sample-test-token-0123456789abcdef";

export interface SampleOptions {
  /** The agents; the first one is the router's default. */
  agents: AgentDefinition[];
  /** Pi extensions for the runtime, unmodified (SPEC §6.2b). */
  extensions?: PiExtension[];
  /** Reuse a previous sample's state: a restart. Default: a new temporary directory. */
  dataDir?: string;
  /** Components added after the sample's own (tests that watch the lifecycle). */
  extra?: ComponentDefinition[];
}

export interface Sample {
  app: App;
  dataDir: string;
  /** Resolves with the server's URL once it listens. */
  listening: Promise<URL>;
  /** Send a request with the bearer token (or `token`), and read the JSON answer. */
  post(path: string, body?: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The status of a GET. */
  status(path: string): Promise<number>;
  /** Stop the app (idempotent). The data directory stays until `dispose`. */
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createSample(options: SampleOptions): Promise<Sample> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "pikit-sample-http-"));
  let listened!: (url: URL) => void;
  const listening = new Promise<URL>((resolve) => (listened = resolve));
  const { agents, provider } = testComponents({ agents: options.agents });
  const defaultAgent = options.agents[0]?.name ?? "";

  const app = await defineApp({
    components: [
      createSecretsEnv({ env: { PIKIT_HTTP_TOKEN: TOKEN } }),
      sessionsJsonl,
      conversationsFile,
      provider,
      agents,
      createRuntimePi(options.extensions !== undefined ? { extensions: options.extensions } : {}),
      routerBasic,
      channelHttp,
      createServerBun({ onListening: listened }),
      ...(options.extra ?? []),
    ],
    config: {
      "sessions-jsonl": { root: join(dataDir, "sessions") },
      "conversations-file": { path: join(dataDir, "conversations.json") },
      "router-basic": { defaultAgent },
      "server-bun": { port: 0, hostname: "127.0.0.1" },
    },
    logger: silentLogger,
  }).create();

  return {
    app,
    dataDir,
    listening,
    async post(path, body, token = TOKEN) {
      const response = await fetch(new URL(path, await listening), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async status(path) {
      return (await fetch(new URL(path, await listening))).status;
    },
    stop: () => app.stop(),
    async dispose() {
      await app.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
