/**
 * credentials-file's tests. They are copied with the component and keep running in your project.
 * No test reads a real credential: every file is a temporary one with made-up values.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { CredentialStore } from "@pikit/pi-adapter";
import { createCredentialStoreConformance } from "@pikit/pi-adapter/testing";
import credentialsFile from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-credentials-file-"));
  directories.push(dir);
  return join(dir, "state", "credentials.json");
}

/** A started app with this component over `path`, and the store it provides. */
async function started(path: string, logger: Logger = silentLogger): Promise<{ app: App; store: CredentialStore }> {
  let store: CredentialStore | undefined;
  const reader = defineComponent({
    name: "credentials-reader",
    setup(pikit) {
      const handle = pikit.use("model.credentials");
      return { start: () => void (store = handle.get()) };
    },
  });
  const app = await defineApp({
    components: [credentialsFile, reader],
    config: { "credentials-file": { path } },
    logger,
  }).create();
  await app.start();
  if (store === undefined) throw new Error("model.credentials was not resolved");
  return { app, store };
}

async function startFailure(path: string): Promise<Error> {
  const app = await defineApp({ components: [credentialsFile], config: { "credentials-file": { path } }, logger: silentLogger }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  return error;
}

// pi-ai's CredentialStore contract (SPEC §14), with persistence and pi-ai's refresh written back.
for (const c of createCredentialStoreConformance(async () => {
  const path = temporaryPath();
  const apps: App[] = [];
  const open = async () => {
    const { app, store } = await started(path);
    apps.push(app);
    return store;
  };
  return {
    store: await open(),
    reopen: open,
    async dispose() {
      for (const app of apps) await app.stop();
    },
  };
})) {
  test(`credentials-file ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline.
const lifecyclePath = temporaryPath();
for (const c of createLifecycleConformance(() => ({ component: credentialsFile, config: { "credentials-file": { path: lifecyclePath } } }))) {
  test(`credentials-file ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [credentialsFile], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "credentials-file", provides: ["model.credentials"], requires: [], optional: [] }]);
});

test("the file is created at start with mode 0600, and written credentials keep it", async () => {
  const path = temporaryPath();
  const { app, store } = await started(path);
  const created = statSync(path).mode & 0o777;

  await store.modify("anthropic", async () => ({ type: "api_key", key: "made-up-key" }));

  expect(created).toBe(0o600);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "made-up-key" } });
  await app.stop();
});

test("a credential written by another process is seen at the next read", async () => {
  const path = temporaryPath();
  const { app, store } = await started(path);

  writeFileSync(path, JSON.stringify({ anthropic: { type: "oauth", access: "made-up-access", refresh: "made-up-refresh", expires: 1 } }));

  expect(await store.read("anthropic")).toEqual({ type: "oauth", access: "made-up-access", refresh: "made-up-refresh", expires: 1 });
  await app.stop();
});

test("a broken file fails the start, and the error names the file without quoting it", async () => {
  const path = temporaryPath();
  const { app } = await started(path);
  await app.stop();
  writeFileSync(path, '{"anthropic": {"type": "oauth", "access": "made-up-secret-7d1f"');

  const error = await startFailure(path);

  const reported = `${error.message} ${(error.cause as Error).message} ${String((error.cause as Error).cause ?? "")}`;
  expect(reported).toContain("is not valid JSON");
  expect(reported).not.toContain("made-up-secret-7d1f");
});

test("a file whose entries are not credentials fails the start", async () => {
  const path = temporaryPath();
  const { app } = await started(path);
  await app.stop();
  writeFileSync(path, JSON.stringify({ anthropic: { type: "password", value: "made-up" } }));

  expect(String((await startFailure(path)).cause)).toContain('the credential of "anthropic"');
});

test("a file readable by other users starts, with a warning that shows no value", async () => {
  const path = temporaryPath();
  const first = await started(path);
  await first.store.modify("anthropic", async () => ({ type: "api_key", key: "made-up-secret-2c4a" }));
  await first.app.stop();
  chmodSync(path, 0o644);
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (message, fields) => void warnings.push(`${message} ${JSON.stringify(fields)}`) };

  const { app } = await started(path, logger);

  expect(warnings.join("\n")).toContain("readable by other users");
  expect(warnings.join("\n")).not.toContain("made-up-secret-2c4a");
  await app.stop();
});

test("it refuses to start where the file cannot be written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-credentials-file-"));
  directories.push(dir);
  writeFileSync(join(dir, "blocked"), "a file where the directory should be");

  expect((await startFailure(join(dir, "blocked", "credentials.json"))).message).toContain('"credentials-file" failed to start');
});
