/**
 * github-app on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`): the objects' App has github-app's default export over
 * storage-do and platform-cloudflare, the Worker's App serves its Worker half through
 * deployment-cloudflare's own server. GitHub is the fake (`fake-github.test-support.ts`) behind the
 * isolate's `fetch`, which the test and the objects share: nothing reaches the network.
 *
 * The connection goes through the Worker's routes into the github-app object (`github-app:credentials`,
 * its own SQLite): the App's private key sealed there (AES-GCM, HKDF in workerd), tokens minted with an
 * RS256 JWT signed by workerd's Web Crypto from GitHub's PKCS#1 key and verified by the fake; a
 * conversation's object gets the same token through its own `github` (a real RPC to the github-app
 * object); and the `github` suite on the Worker's half over the real github-app object.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { type AppContext, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type AdminAuth, type GitHubAccess, isGitHubNotConnected, type JsonValue } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createGitHubConformance, withWorkersHost } from "@pikit/contracts/testing";
import { afterEach, expect, it } from "vitest";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import type { GitHubAppStatus, StartResponse } from "../../../registry/components/github-app/files/src/pikit/github-app/api.ts";
import { CALL, GITHUB_APP_KEY } from "../../../registry/components/github-app/files/src/pikit/github-app/calls.ts";
import { createFakeGitHubApp } from "../../../registry/components/github-app/files/src/pikit/github-app/fake-github.test-support.ts";
import githubApp, { worker as githubAppWorker } from "../../../registry/components/github-app/files/src/pikit/github-app/index.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const ADMIN = "a-workerd-admin-token-of-32-characters-or-more";
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetObjects();
});

const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => (name === "PIKIT_ADMIN_TOKEN" ? ADMIN : undefined) }) });

/** The github-app object's storage wiped, its instance reset: the next call finds nothing connected. */
async function forgetConnection(): Promise<void> {
  await resetObjects();
  const object = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(GITHUB_APP_KEY));
  await runInDurableObject(object, (_instance, state) => state.storage.deleteAll());
  await resetObjects();
}

/**
 * The `github` suite on github-app's Worker half, over the real github-app object (its storage wiped
 * before each case): what admin-proposals' routes read in the Worker.
 */
for (const c of createGitHubConformance(async () => {
  await forgetConnection();
  composeObjects([storageDo, platformCloudflare, secrets, githubApp], { "github-app": { freshMs: 0 } });
  const github = await createFakeGitHubApp();
  globalThis.fetch = github.fetch as typeof fetch;
  let mailbox: ActorMailbox | undefined;
  const ask = async (type: string, message: unknown, ctx: AppContext) => (await (mailbox as ActorMailbox).call(GITHUB_APP_KEY, type, message as JsonValue, ctx)) as Record<string, unknown>;
  const reader = defineComponent({
    name: "mailbox-test",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  return {
    components: () => withWorkersHost({ env: workerEnv }, [platformCloudflare, githubAppWorker, reader]),
    config: { "platform-cloudflare": { binding: PLATFORM_BINDING } },
    target: "durable" as const,
    // The Worker's half keeps an answer a second.
    freshMs: 1_000,
    async connect(repository, ctx) {
      if ((await ask(CALL.status, { check: false }, ctx)).app === undefined) {
        const started = (await ask(CALL.start, { origin: "https://bot.ana.workers.dev", operator: "ops" }, ctx)) as unknown as StartResponse & { nonce: string };
        const state = new URL(started.action).searchParams.get("state") as string;
        await ask(CALL.connect, { state, nonce: started.nonce, operator: "ops", code: github.approve(started.manifest) }, ctx);
      }
      await ask(CALL.install, { installationId: github.install([repository]), operator: "ops" }, ctx);
    },
    disconnect: async (ctx) => void (await ask(CALL.disconnect, { operator: "ops" }, ctx)),
    accepts: async (token, repository) => github.accepts(token, repository),
  };
})) {
  it(`github-app on Cloudflare ${c.group}: ${c.name}`, () => c.run());
}

const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** A conversation object's half: answers `test.token` with what its own `github` gives. */
const consumer = defineComponent({
  name: "test-consumer",
  setup(pikit) {
    const inbox = pikit.use("actor.inbox");
    const github = pikit.use("github");
    return {
      start() {
        inbox.get().answer("test.token", async (_key, _message, ctx) => ({ repository: (await github.get().repository(ctx)) ?? null, token: await github.get().token(ctx) }));
      },
    };
  },
});

it("connect through the Worker: the manifest, the callback, the install; the key sealed in the github-app object; tokens signed in workerd, for the Worker and a conversation's object", async () => {
  await forgetConnection();
  const github = await createFakeGitHubApp();
  globalThis.fetch = github.fetch as typeof fetch;
  composeObjects([storageDo, platformCloudflare, secrets, githubApp, consumer], { "github-app": { freshMs: 0 } });
  const server = createWorkerServer(silentLogger);
  let mailbox: ActorMailbox | undefined;
  let access: GitHubAccess | undefined;
  const reader = defineComponent({
    name: "test-reader",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      const github = pikit.use("github");
      return { start: () => void ((mailbox = handle.get()), (access = github.get())) };
    },
  });
  const app = await defineApp({
    components: [platformCloudflare, auth, githubAppWorker, reader, server.component],
    config: { "platform-cloudflare": { binding: PLATFORM_BINDING } },
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  const fetchWorker = (path: string, init: RequestInit = {}) =>
    server.serve(new Request(`https://bot.ana.workers.dev${path}`, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } }));
  try {
    const started = await fetchWorker("/admin/api/github-app/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(started.status).toBe(200);
    const form = (await started.json()) as StartResponse;
    const nonce = (started.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const state = new URL(form.action).searchParams.get("state") as string;

    const callback = await fetchWorker(`/admin/api/github-app/callback?code=${github.approve(form.manifest)}&state=${state}`, { headers: { cookie: nonce } });
    expect([callback.status, callback.headers.get("location")]).toEqual([302, "https://github.com/apps/pikit-bot-ana/installations/new"]);
    const installation = github.install(["ana/bot"]);
    const setup = await fetchWorker(`/admin/api/github-app/setup?installation_id=${installation}`);
    expect([setup.status, setup.headers.get("location")]).toEqual([302, "/admin/?settings=github-app"]);
    const status = (await (await fetchWorker("/admin/api/github-app/status")).json()) as GitHubAppStatus;
    expect(status).toMatchObject({ connected: true, repository: "ana/bot", app: { slug: "pikit-bot-ana" } });

    // The Worker's github, and a conversation's object's (a real RPC to the github-app object): the same token, which GitHub takes.
    const token = await (access as GitHubAccess).token(app.context());
    expect(github.accepts(token, "ana/bot")).toBe(true);
    const fromObject = (await (mailbox as ActorMailbox).call(`test:${crypto.randomUUID()}`, "test.token", null, app.context())) as { repository: string; token: string };
    expect(fromObject).toEqual({ repository: "ana/bot", token });

    // The github-app object's SQLite holds the key only sealed.
    const stub = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(GITHUB_APP_KEY));
    const rows = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT slug, sealed FROM github_app").toArray());
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.sealed)).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE KEY");

    // Disconnected: no repository, no token, for every App.
    expect((await fetchWorker("/admin/api/github-app", { method: "DELETE" })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(isGitHubNotConnected(await (access as GitHubAccess).token(app.context()).catch((error: unknown) => error))).toBe(true);
    expect(github.accepts(token, "ana/bot")).toBe(false);
  } finally {
    await app.stop();
  }
});
