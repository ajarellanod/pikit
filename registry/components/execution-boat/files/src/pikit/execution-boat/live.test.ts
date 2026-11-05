/**
 * execution-boat against boat.dev itself: skipped (saying so) unless `BOAT_API_KEY` is set. Opt-in,
 * since it creates real (billed) VMs: one `small` VM for the whole `ExecutionEnv` suite (each case in
 * a fresh directory of its workspace), then its idle stop, its resume (the latency is printed), an
 * export to and a restore from the shared snapshot format, and the key absent from the VM. Every VM
 * it made (label `pikit-gateway: pikit-live-<run>`) is deleted at the end.
 *
 *   BOAT_API_KEY=boat_... bun test registry/components/execution-boat/files/src/pikit/execution-boat/live.test.ts
 *
 * `BOAT_API_URL` overrides the API (`https://boat.dev/api/v1`).
 */

import { afterAll, expect, test } from "bun:test";
import type { BlobStorage, BlobStore } from "@pikit/contracts";
import { type App, defineApp, defineComponent, systemClock } from "@pikit/core";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd, BACKGROUND_CONTEXT } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { BoatApi } from "./api.ts";
import { createExecutionBoat } from "./index.ts";

const KEY = process.env.BOAT_API_KEY;
const URL = process.env.BOAT_API_URL ?? "https://boat.dev/api/v1";
const GATEWAY = `pikit-live-${Date.now().toString(36)}`;
const ctx = BACKGROUND_CONTEXT;
const live = KEY === undefined || KEY === "" ? test.skip : test;
if (KEY === undefined || KEY === "") console.log("execution-boat live.test.ts: skipped (set BOAT_API_KEY to run against boat.dev)");

const data = new Map<string, Uint8Array>();
const blob: BlobStorage = {
  maxBytes: 25 * 1024 * 1024,
  namespace(name) {
    const store: BlobStore = {
      put: async (key, bytes) => void data.set(`${name}/${key}`, bytes.slice()),
      get: async (key) => {
        const bytes = data.get(`${name}/${key}`);
        return bytes === undefined ? undefined : { bytes: bytes.slice() };
      },
      delete: async (key) => void data.delete(`${name}/${key}`),
      list: async (prefix) => ({ entries: [...data.entries()].filter(([k]) => k.startsWith(`${name}/${prefix}`)).map(([k, v]) => ({ key: k.slice(name.length + 1), size: v.length })).sort((a, b) => (a.key < b.key ? -1 : 1)) }),
    };
    return store;
  },
};

let app: App | undefined;
let provider: WorkspaceProvider | undefined;
const logs: { message: string; fields?: Record<string, unknown> }[] = [];

async function workspace(): Promise<{ app: App; provider: WorkspaceProvider }> {
  if (app !== undefined && provider !== undefined) return { app, provider };
  const made = await defineApp({
    components: [
      defineComponent({ name: "secrets-live", setup: (pikit) => void pikit.provide("secrets", { get: async (name: string) => (name === "BOAT_API_KEY" ? KEY : undefined) }) }),
      defineComponent({ name: "blob-live", setup: (pikit) => void pikit.provide("storage.blob", blob) }),
      createExecutionBoat({ pollMs: 500 }),
      defineComponent({
        name: "reader",
        setup(pikit) {
          const w = pikit.use("workspace");
          return { start: () => void (provider = w.get()) };
        },
      }),
    ],
    config: { "execution-boat": { apiUrl: URL, gateway: GATEWAY, size: "small", idleSeconds: 20, snapshots: true, maxVms: 2 } },
    logger: {
      debug() {},
      info: (message, fields) => void logs.push({ message, ...(fields !== undefined && { fields }) }),
      warn: (message, fields) => void logs.push({ message, ...(fields !== undefined && { fields }) }),
      error: (message, fields) => void logs.push({ message, ...(fields !== undefined && { fields }) }),
    },
    clock: systemClock,
  }).create();
  await made.start();
  app = made;
  return { app: made, provider: provider as WorkspaceProvider };
}

const ref = { key: "live:1", agent: "support", conversationId: "1" };
const envOf = async () => {
  const w = await workspace();
  return (await w.provider.resolve(ref, w.app.context())).env;
};

afterAll(async () => {
  await app?.stop();
  if (KEY === undefined || KEY === "") return;
  const api = new BoatApi({ baseUrl: URL, key: () => KEY, fetch, timeoutMs: 60_000 });
  for (const sandbox of await api.list({ "pikit-gateway": GATEWAY })) await api.remove(sandbox.id).catch(() => {});
}, 120_000);

let n = 0;
for (const c of createDurableExecutionConformance(async () => {
  const env = await envOf();
  const dir = `case-${n++}`;
  const made = await env.createDir(dir, { recursive: true }, ctx);
  if (!made.ok) throw made.error;
  return { env: await atCwd(env, `${env.cwd}/${dir}`, ctx) };
}, { expect, shell: true, watch: false, symlinks: true })) {
  live(`execution-boat live ${c.group}: ${c.name}`, () => c.run(), 180_000);
}

live("the VM is Ubuntu with node, holds no key, and its user's home is /home/user", async () => {
  const env = await envOf();
  expect(env.cwd).toBe("/home/user/workspace");
  const out = { text: "" };
  const result = await env.exec("cat /etc/os-release; command -v node tar; env", { onOutput: (t) => void (out.text += t) }, ctx);
  expect(result.ok).toBe(true);
  expect(out.text).toContain("Ubuntu");
  expect(out.text).toContain("/node");
  expect(out.text).not.toContain(KEY as string);
}, 180_000);

const until = async (condition: () => boolean, what: string, ms = 180_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(500);
  }
};
const stops = () => logs.filter((log) => log.message === "execution-boat: VM stopped").length;

live("idle stop (exported), resume (latency printed), deletion, and a new VM restored from the shared format", async () => {
  const env: ExecutionEnv = await envOf();
  expect((await env.writeFile("portable/a.txt", "survives", ctx)).ok).toBe(true);
  const before = stops();
  await until(() => stops() > before, "the idle stop");
  expect([...data.keys()].some((key) => key.startsWith("workspace-snapshots/") && key.endsWith("/manifest.json"))).toBe(true);

  const began = Date.now();
  expect(await env.readTextFile("portable/a.txt", ctx)).toEqual({ ok: true, value: "survives" });
  console.log(`execution-boat live: resume and first read took ${Date.now() - began} ms (logged: ${JSON.stringify(logs.findLast((log) => log.message === "execution-boat: VM resumed")?.fields)})`);

  const again = stops();
  await until(() => stops() > again, "the second idle stop");
  const api = new BoatApi({ baseUrl: URL, key: () => KEY as string, fetch, timeoutMs: 60_000 });
  for (const sandbox of await api.list({ "pikit-gateway": GATEWAY })) await api.remove(sandbox.id);
  expect(await env.readTextFile("portable/a.txt", ctx)).toEqual({ ok: true, value: "survives" });
  expect(logs.some((log) => log.message === "execution-boat: workspace restored from its snapshot")).toBe(true);
}, 900_000);
