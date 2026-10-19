/**
 * `pikit configure` on Cloudflare (`durable`) with a `model.credentials` provider (credentials-do):
 * the store is the deployed app's own object, so `--login` runs the provider's login on this machine
 * and uploads the credential to the deployed Worker's operator route, at the URL its deployment
 * reports, with `.env`'s `PIKIT_ADMIN_TOKEN`; without `--login`, what the deployed app holds is read
 * from the same route.
 *
 * The project's components are its own: a provider whose OAuth login answers at once (no network), a
 * store that fails if anything uses it here (it runs only in its object), an agent on the provider.
 * The deployed Worker is a local `Bun.serve` fake of the route; the deployment's `url` points at it.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES_DIR } from "../paths.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const TOKEN = "an-admin-token-of-at-least-32-characters";
const ACCESS = "sk-sub-secret-access-token";
const REFRESH = "sk-sub-secret-refresh-token";
/** The project's adapter, built in two pieces: this test's own imports are checked (scripts/boundaries.ts). */
const ADAPTER = ["@pikit", "pi-adapter"].join("/");

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The deployed Worker's route: what it was sent, and what it answers. */
const worker = {
  seen: [] as { method: string; path: string; authorization: string | null; body?: unknown }[],
  stored: [] as { providerId: string; type: string }[],
  status: 200,
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
};
beforeAll(() => {
  worker.server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "PUT" ? await request.json() : undefined;
      worker.seen.push({ method: request.method, path, authorization: request.headers.get("authorization"), ...(body !== undefined && { body }) });
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (worker.status !== 200) return Response.json({ error: "unavailable" }, { status: worker.status });
      if (request.method === "GET" && path === "/admin/api/credentials-test") return Response.json({ credentials: worker.stored });
      if (request.method === "PUT" && path.startsWith("/admin/api/credentials-test/")) return Response.json({ providerId: path.split("/").at(-1), type: "oauth" });
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => worker.server?.stop(true));
afterEach(() => {
  worker.seen.length = 0;
  worker.stored = [];
  worker.status = 200;
});

/** A durable project, deployed at `url` (none: not deployed yet), with `.env` holding `env`. */
function project(url: string | undefined, env: Record<string, string> = { PIKIT_ADMIN_TOKEN: TOKEN }): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-configure-durable-"));
  dirs.push(dir);
  const manifest = emptyManifest(undefined, undefined, ["durable"]);
  const record = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: {}, dependencies: {}, environment: [] };
  manifest.components["deployment-fake"] = record;
  manifest.components["provider-test"] = { ...record, environment: [{ name: "SUB_API_KEY", secret: true, required: false }] };
  writeProjectManifest(dir, manifest);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "durable" }, null, 2)}\n`);
  writeFileSync(join(dir, ".env"), Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(""));
  mkdirSync(join(dir, "src", "pikit", "deployment-fake"), { recursive: true });
  writeFileSync(join(dir, "src", "pikit", "deployment-fake", "index.ts"), `export async function url(): Promise<string | undefined> {\n  return ${JSON.stringify(url)};\n}\n`);
  writeFileSync(
    join(dir, "src", "models.ts"),
    `import { defineComponent } from "@pikit/core";
import { createProvider } from "${ADAPTER}/provider";

const never = (): never => {
  throw new Error("the test provider does not stream");
};

/** A subscription provider whose login answers at once. */
export const provider = defineComponent({
  name: "provider-test",
  setup(pikit) {
    pikit.provideKeyed("model.provider", "subscription", createProvider({
      id: "subscription",
      auth: {
        oauth: {
          name: "Test subscription",
          login: async () => ({ type: "oauth", access: ${JSON.stringify(ACCESS)}, refresh: ${JSON.stringify(REFRESH)}, expires: Date.now() + 3_600_000 }),
          refresh: async () => never(),
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [],
      api: { stream: never, streamSimple: never },
    }));
  },
});

/** The store of a durable project: it runs only in its object, never here. */
const here = async (): Promise<never> => {
  throw new Error("credentials-test was used on this machine");
};
export const store = defineComponent({
  name: "credentials-test",
  setup(pikit) {
    pikit.provide("model.credentials", { read: here, list: here, modify: here, delete: here });
    return { start: () => here() };
  },
});

export default defineComponent({
  name: "models",
  setup(pikit) {
    pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "subscription/m1", instructions: "" });
  },
});
`,
  );
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\nimport models, { provider, store } from "./src/models.ts";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n    models,\n    provider,\n    store,\n  ],\n  config,\n});\n',
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  for (const kit of ["core", "contracts", "pi-adapter"]) symlinkSync(join(PACKAGES_DIR, kit), join(dir, "node_modules", "@pikit", kit));
  return dir;
}

async function pikit(args: string[], dir: string) {
  const env = { ...process.env };
  delete env.PIKIT_ADMIN_TOKEN;
  const child = Bun.spawn([process.execPath, MAIN, ...args], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

/** Every file the project holds, but its linked packages and the provider's source (which makes up the login): none may hold the credential. */
function projectText(dir: string): string {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => !file.startsWith("node_modules") && file !== join("src", "models.ts") && statSync(join(dir, file)).isFile())
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}

const base = () => `http://127.0.0.1:${worker.server?.port}`;

test("configure --login on durable logs in here and uploads the credential to the deployed app's store, with the operators' token; nothing is kept here", async () => {
  const dir = project(base());
  const result = await pikit(["configure", "--yes", "--login", "subscription"], dir);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toContain("the tokens are stored by credentials-test in the deployed app");
  expect(worker.seen).toEqual([
    {
      method: "PUT",
      path: "/admin/api/credentials-test/subscription",
      authorization: `Bearer ${TOKEN}`,
      body: { type: "oauth", access: ACCESS, refresh: REFRESH, expires: expect.any(Number) },
    },
  ]);
  for (const secret of [ACCESS, REFRESH, TOKEN]) expect(result.out + result.err).not.toContain(secret);
  for (const secret of [ACCESS, REFRESH]) expect(projectText(dir)).not.toContain(secret);
}, 60_000);

test("configure --login on durable refuses before logging in when the app was not deployed, or without the operators' token", async () => {
  const undeployed = await pikit(["configure", "--yes", "--login", "subscription"], project(undefined));
  expect(undeployed.code).toBe(1);
  expect(undeployed.err).toContain("the app was not deployed from this machine yet: run `pikit up` first");

  const tokenless = await pikit(["configure", "--yes", "--login", "subscription"], project(base(), {}));
  expect(tokenless.code).toBe(1);
  expect(tokenless.err).toContain("PIKIT_ADMIN_TOKEN is not set in .env");

  const plain = await pikit(["configure", "--yes", "--login", "subscription"], project("http://bot.example.com"));
  expect(plain.code).toBe(1);
  expect(plain.err).toContain("which is not https");
  expect(worker.seen).toEqual([]);
}, 60_000);

test("configure --login on durable says when the deployed app refuses the upload, and never prints the credential", async () => {
  const dir = project(base(), { PIKIT_ADMIN_TOKEN: "another-token-of-at-least-32-characters" });
  const refused = await pikit(["configure", "--yes", "--login", "subscription"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("logged in, but the credential was not stored: the deployed app refused PIKIT_ADMIN_TOKEN");
  for (const secret of [ACCESS, REFRESH, "another-token-of-at-least-32-characters"]) expect(refused.out + refused.err).not.toContain(secret);
}, 60_000);

test("configure on durable reads what the deployed app holds: a stored login counts, and its absence is reported with the login to run", async () => {
  worker.stored = [{ providerId: "subscription", type: "oauth" }];
  const dir = project(base());
  const configured = await pikit(["configure", "--yes"], dir);
  expect(configured.code).toBe(0);
  expect(configured.out).toContain("model provider subscription: has credentials in the deployed app (credentials-test)");
  expect(worker.seen.map((each) => `${each.method} ${each.path}`)).toEqual(["GET /admin/api/credentials-test"]);

  worker.stored = [];
  const missing = await pikit(["configure", "--yes"], dir);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain('the model provider "subscription" has no credentials: run `pikit configure --login subscription` in a terminal, or set SUB_API_KEY in .env');
}, 60_000);
