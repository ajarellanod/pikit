/**
 * `bundleOAuthFlows` in a real Worker bundle: a throwaway Worker bundled by wrangler (esbuild, as
 * `wrangler deploy` bundles) and run in workerd (`wrangler dev`, locally: no account, no network).
 * It refreshes an Anthropic subscription's token through pi-ai's own OAuth flow against a local fake
 * of the token endpoint (a `Bun.serve`; the Worker sends pi-ai's `fetch` there), and turns the new
 * credential into a request's auth (`toAuth`).
 *
 * The same bundle, before `bundleOAuthFlows` ran, fails: pi-ai's lazy loader cannot load the flow in a
 * bundle (it reads `import.meta.url`, undefined there, then would `import()` a module the bundle does not
 * have). That is what the vitest lane (tests/workerd) cannot show: its module runner
 * resolves such an import at run time, as no deployed Worker does.
 *
 * Needs the repository's wrangler (`node_modules/.bin/wrangler`), which runs on Node.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const WORKER = `
import { bundleOAuthFlows } from "@pikit/pi-adapter/oauth-flows";
import { anthropicProvider } from "@pikit/pi-adapter/providers/anthropic";

const realFetch = globalThis.fetch;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/refresh") return new Response("up");
    // pi-ai posts to Anthropic's token endpoint: here, the test's fake.
    globalThis.fetch = (input, init) => {
      const outgoing = new Request(input, init);
      return realFetch(new Request(env.FAKE_OAUTH + new URL(outgoing.url).pathname, outgoing));
    };
    if (url.searchParams.get("register") === "1") bundleOAuthFlows();
    // A new provider each time: pi-ai keeps a flow's load, failed or not, per provider.
    const oauth = anthropicProvider().auth.oauth;
    try {
      const refreshed = await oauth.refresh({ type: "oauth", access: "old-access", refresh: "refresh-1", expires: 0 }, AbortSignal.timeout(10000));
      const auth = await oauth.toAuth(refreshed);
      return Response.json({ refresh: refreshed.refresh, access: refreshed.access, auth });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};
`;

const CONFIG = {
  name: "oauth-flows-check",
  main: "worker.js",
  compatibility_date: "2026-09-01",
  compatibility_flags: ["nodejs_compat"],
};

/** What the fake token endpoint received: each body, as pi-ai's Anthropic flow posts it. */
const received: Record<string, unknown>[] = [];
let fake: ReturnType<typeof Bun.serve> | undefined;
let project = "";
let dev: { base: string; stop(): Promise<void>; logs(): string } | undefined;

beforeAll(async () => {
  fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/oauth/token") return new Response("not found", { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      received.push(body);
      return Response.json({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 });
    },
  });
  project = mkdtempSync(join(tmpdir(), "pikit-oauth-flows-"));
  symlinkSync(nodeModules(), join(project, "node_modules"), "dir");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "oauth-flows-check", type: "module" }));
  writeFileSync(join(project, "worker.js"), WORKER);
  writeFileSync(join(project, "wrangler.json"), JSON.stringify(CONFIG));
  dev = await wranglerDev(project, `http://127.0.0.1:${fake.port}`);
}, 120_000);

afterAll(async () => {
  await dev?.stop();
  await fake?.stop(true);
  if (project !== "") rmSync(project, { recursive: true, force: true });
});

test("in a wrangler bundle, pi-ai's OAuth flow is not reachable until bundleOAuthFlows; then a token refreshes in workerd", async () => {
  const base = (dev as NonNullable<typeof dev>).base;
  const before = await fetch(`${base}/refresh`);
  expect(before.status).toBe(500);
  // pi-ai's loader fails in a bundle (with wrangler 4.143, before its import(): `import.meta.url` is
  // undefined there; the flow's module is not in the bundle anyway), and nothing was posted.
  expect(((await before.json()) as { error: string }).error).toMatch(/Error/);
  expect(received).toEqual([]);

  const after = await fetch(`${base}/refresh?register=1`);
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ refresh: "refresh-2", access: "new-access", auth: { apiKey: "new-access" } });
  expect(received).toEqual([expect.objectContaining({ grant_type: "refresh_token", refresh_token: "refresh-1" })]);
}, 60_000);

/** The repository's node_modules (with the workspace's packages and wrangler). */
function nodeModules(): string {
  for (let dir = import.meta.dir; dir !== dirname(dir); dir = dirname(dir)) {
    const modules = join(dir, "node_modules");
    if (existsSync(join(modules, "@pikit", "pi-adapter")) && existsSync(join(modules, ".bin", "wrangler"))) return modules;
  }
  throw new Error("no node_modules with @pikit/pi-adapter and wrangler above this test");
}

/** A port nothing listens on now. */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

/** `wrangler dev` on `cwd`, on a free port, `FAKE_OAUTH` set; resolves once the Worker answers. */
async function wranglerDev(cwd: string, fakeOAuth: string): Promise<{ base: string; stop(): Promise<void>; logs(): string }> {
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(
    [join(cwd, "node_modules", ".bin", "wrangler"), "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(freePort()), "--var", `FAKE_OAUTH:${fakeOAuth}`],
    { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let logs = "";
  const decoder = new TextDecoder();
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += decoder.decode(chunk);
  };
  const collected = Promise.all([collect(child.stdout), collect(child.stderr)]);
  const stop = async () => {
    child.kill("SIGINT");
    const stopped = await Promise.race([child.exited, Bun.sleep(15_000).then(() => undefined)]);
    if (stopped === undefined) child.kill("SIGKILL");
    await child.exited;
    await collected;
  };
  for (let i = 0; i < 90; i++) {
    const up = await fetch(base).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return { base, stop, logs: () => logs };
    if (child.exitCode !== null) break;
    await Bun.sleep(1_000);
  }
  await stop();
  throw new Error(`wrangler dev did not answer:\n${logs}`);
}
