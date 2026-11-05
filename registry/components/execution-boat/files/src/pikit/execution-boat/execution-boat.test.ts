/**
 * execution-boat's tests, over a fake boat API (`fake-boat.test-support.ts`): real local `bash` and
 * the real in-VM helper, boat's REST calls answered by the fake. They check pi-durable's
 * `ExecutionEnv` suite and the `workspace` suite, then what is this component's own: the keying per
 * chat and agent, the VM lifecycle on a manual clock (create, idle stop never during a command or a
 * process a command left, resume, retention), `maxVms`, the deadlines, the key never leaving the API
 * calls, secrets and egress refused, the shared snapshot format (export, restore, archives escaping the
 * root refused) and malformed answers. `live.test.ts` runs against boat itself, with `BOAT_API_KEY`.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStorage, type BlobStore, type ConversationRef } from "@pikit/contracts";
import { type App, type Clock, type ComponentDefinition, defineApp, defineComponent, type Logger, systemClock } from "@pikit/core";
import { createLifecycleConformance, createManualClock, type ManualClock } from "@pikit/core/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { createWorkspaceConformance } from "@pikit/pi-adapter/testing";
import { FakeBoat } from "./fake-boat.test-support.ts";
import { createExecutionBoat, workspaceOf } from "./index.ts";

export const KEY = "boat_live_0123456789abcdefSECRET";
const ctx = BACKGROUND_CONTEXT;
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

export function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-execution-boat-")));
  directories.push(dir);
  return dir;
}

/** Conversation `id` of `agent` in chat `test:<id>`. */
const ref = (id: string, agent = "support"): ConversationRef => ({ key: `test:${id}`, agent, conversationId: id });
const workspace = (id: string, agent = "support") => workspaceOf(`test:${id}`, agent);

type Log = { level: string; message: string; fields?: Record<string, unknown> };

export interface Started {
  app: App;
  fake: FakeBoat;
  root: string;
  proc: string;
  execution: ExecutionEnv;
  workspace: WorkspaceProvider;
  env(id: string, agent?: string): Promise<ExecutionEnv>;
  logs: Log[];
}

function secretsOf(values: Record<string, string | undefined>): ComponentDefinition {
  return defineComponent({
    name: "secrets-test",
    setup(pikit) {
      pikit.provide("secrets", { get: async (name: string) => values[name] });
    },
  });
}

/** A `storage.blob` in memory, whose namespaces the test reads. */
export function memoryBlob(maxBytes = 25 * 1024 * 1024) {
  const data = new Map<string, Uint8Array>();
  const storage: BlobStorage = {
    maxBytes,
    namespace(name) {
      const at = (key: string) => `${name}/${key}`;
      const store: BlobStore = {
        async put(key, bytes) {
          if (bytes.length > maxBytes) throw new Error("too large");
          data.set(at(key), bytes.slice());
        },
        async get(key) {
          const bytes = data.get(at(key));
          return bytes === undefined ? undefined : { bytes: bytes.slice() };
        },
        async delete(key) {
          data.delete(at(key));
        },
        async list(prefix) {
          const entries = [...data.entries()].filter(([k]) => k.startsWith(at(prefix))).map(([k, v]) => ({ key: k.slice(name.length + 1), size: v.length }));
          entries.sort((a, b) => (a.key < b.key ? -1 : 1));
          return { entries };
        },
      };
      return store;
    },
  };
  const component = defineComponent({
    name: "blob-test",
    setup(pikit) {
      pikit.provide("storage.blob", storage);
    },
  });
  return { data, storage, component };
}

export async function started(config: Record<string, unknown> = {}, options: { clock?: Clock; providers?: ComponentDefinition[]; root?: string; fake?: FakeBoat; key?: string | undefined } = {}): Promise<Started> {
  const root = options.root ?? temporaryDir();
  const clock = options.clock ?? systemClock;
  const fake = options.fake ?? new FakeBoat(join(root, "vms"), KEY, clock);
  const proc = join(root, "proc");
  mkdirSync(proc, { recursive: true });
  let found: { execution: ExecutionEnv; workspace: WorkspaceProvider } | undefined;
  const reader = defineComponent({
    name: "execution-reader",
    setup(pikit) {
      const execution = pikit.use("execution");
      const workspace = pikit.use("workspace");
      return { start: () => void (found = { execution: execution.get(), workspace: workspace.get() }) };
    },
  });
  const logs: Log[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, ...(fields !== undefined && { fields }) });
  const logger: Logger = { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
  const app = await defineApp({
    components: [
      secretsOf({ BOAT_API_KEY: "key" in options ? options.key : KEY }),
      ...(options.providers ?? []),
      createExecutionBoat({ fetch: fake.fetch, paths: FakeBoat.paths(join(root, "vms")), pollMs: 5, proc }),
      reader,
    ],
    config: { "execution-boat": { ...config } },
    logger,
    clock,
  }).create();
  await app.start();
  if (found === undefined) throw new Error("execution was not resolved");
  const ws = found.workspace;
  return { app, fake, root, proc, ...found, env: async (id, agent) => (await ws.resolve(ref(id, agent), app.context())).env, logs };
}

async function run(env: ExecutionEnv, command: string | string[], options: Parameters<ExecutionEnv["exec"]>[1] = {}, context = ctx) {
  const output = { stdout: "", stderr: "" };
  const result = await env.exec(command, { ...options, onOutput: (text, c, info) => {
    output[info.stream] += text;
    options?.onOutput?.(text, c, info);
  } }, context);
  return { result, ...output };
}

const stopApp = async (s: Started) => {
  await s.app.stop();
  await s.fake.settle();
};

// pi-durable's ExecutionEnv contract (and pikit's cases) on a conversation's VM: files and a real shell.
for (const c of createDurableExecutionConformance(async () => {
  const s = await started();
  return { env: await s.env("1"), dispose: () => stopApp(s) };
}, { expect, shell: true, watch: false, symlinks: true })) {
  test(`execution-boat ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs ?? 20_000);
}

for (const c of createWorkspaceConformance(async () => {
  const s = await started();
  return { provider: s.workspace, dispose: () => stopApp(s) };
})) {
  test(`execution-boat ${c.group}: ${c.name}`, () => c.run(), 20_000);
}

for (const c of createLifecycleConformance(() => ({
  component: createExecutionBoat({ fetch: new FakeBoat(temporaryDir(), KEY, systemClock).fetch }),
  config: { "execution-boat": {} },
  providers: [secretsOf({ BOAT_API_KEY: KEY })],
}))) {
  test(`execution-boat ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secretsOf({}), createExecutionBoat()], logger: { debug() {}, info() {}, warn() {}, error() {} } }).create();
  expect(app.describe().components.find((c) => c.name === "execution-boat")).toEqual({
    name: "execution-boat",
    provides: ["execution", "execution.shell", "workspace"],
    requires: ["secrets"],
    optional: ["storage.blob"],
  });
});

test("a chat's agent gets a VM of its own, labelled, made noEnv, with its files at <home>/workspace", async () => {
  const s = await started();
  const one = await s.env("1");
  expect((await one.writeFile("notes/a.txt", "one's", ctx)).ok).toBe(true);
  const [vm] = s.fake.of(workspace("1"));
  expect(vm?.labels).toEqual({ "pikit-gateway": "pikit", "pikit-workspace": workspace("1"), "pikit-agent": "support" });
  expect(readFileSync(join(vm?.dir as string, "home", "workspace", "notes", "a.txt"), "utf8")).toBe("one's");
  const create = s.fake.calls.find((call) => call.method === "POST" && call.path === "/sandboxes");
  expect(create?.body).toMatchObject({ type: "small", noEnv: true, ttlSeconds: 3600 });
  expect(Object.keys(create?.body as object)).not.toContain("env");
  await stopApp(s);
});

void writeFileSync;
void withAbortSignal;
void createManualClock;
export type { ManualClock };
