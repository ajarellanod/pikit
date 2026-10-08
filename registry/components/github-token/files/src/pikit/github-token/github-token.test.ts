/**
 * github-token's tests. They are copied with the component and keep running in your project: the
 * `github` suite (a secret and a repository in memory), what it says when one is missing, the
 * repository as a setting over the config's, and the token in no log line.
 */

import { expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { type GitHubAccess, isGitHubNotConnected, type Settings, SettingsError, type SettingsValue } from "@pikit/contracts";
import { createGitHubConformance } from "@pikit/contracts/testing";
import githubToken from "./index.ts";

/** A `settings` in memory: stored keys over the defaults; `unreadable` makes `get` reject. */
function memorySettings() {
  const declared = new Map<string, SettingsValue>();
  const stored = new Map<string, SettingsValue>();
  const store = {
    unreadable: false,
    declared,
    settings: {
      declare: (component, _schema, defaults) => void declared.set(component, defaults),
      async get<T extends SettingsValue>(component: string, _ctx: AppContext): Promise<T> {
        if (store.unreadable) throw new Error("the settings could not be reached");
        if (!declared.has(component)) throw new SettingsError("unknown_component", component);
        return { ...declared.get(component), ...stored.get(component) } as T;
      },
      async set(component, value) {
        stored.set(component, value);
        return { ...declared.get(component), ...value };
      },
      sections: async () => [],
    } as Settings,
  };
  return store;
}

const operator = { id: "ops" };

for (const c of createGitHubConformance(() => {
  const secrets: Record<string, string> = {};
  const store = memorySettings();
  return {
    components: () => [
      defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => secrets[name] }) }),
      defineComponent({ name: "settings-test", setup: (pikit) => pikit.provide("settings", store.settings) }),
      githubToken,
    ],
    async connect(repository, ctx) {
      secrets.GITHUB_TOKEN = `github_pat_${repository.replace("/", "_")}_conformance`;
      await store.settings.set("github-token", { repository }, operator, ctx);
    },
    async disconnect(ctx) {
      await store.settings.set("github-token", { repository: "" }, operator, ctx);
    },
    accepts: async (token, repository) => token === `github_pat_${repository.replace("/", "_")}_conformance`,
  };
})) {
  test(`github-token ${c.group}: ${c.name}`, () => c.run());
}

/** A started App with github-token over `secrets` (and `settings`), and its `github`. */
async function started(options: { secrets?: Record<string, string>; config?: Record<string, unknown>; settings?: Settings } = {}) {
  let access: GitHubAccess | undefined;
  const logged: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields)}`), info: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields)}`) };
  const app = await defineApp({
    components: [
      defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => options.secrets?.[name] }) }),
      defineComponent({ name: "settings-test", setup: (pikit) => void (options.settings !== undefined && pikit.provide("settings", options.settings)) }),
      githubToken,
      defineComponent({
        name: "reader-test",
        setup(pikit) {
          const github = pikit.use("github");
          return { start: () => void (access = github.get()) };
        },
      }),
    ],
    config: { "github-token": options.config ?? {} },
    logger,
  }).create();
  await app.start();
  return { app, github: access as GitHubAccess, ctx: app.context(), logged };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const { app } = await started();
  expect(app.describe().components.find((each) => each.name === "github-token")).toEqual({ name: "github-token", provides: ["github"], requires: ["secrets"], optional: ["settings"] });
  await app.stop();
  await expect(started({ config: { repository: "no slash" } })).rejects.toThrow("repository");
});

test("connected needs both, the repository and the secret; each missing one is said, never the token", async () => {
  const none = await started();
  expect(await none.github.repository(none.ctx)).toBeUndefined();
  expect(((await none.github.token(none.ctx).catch((error: unknown) => error)) as Error).message).toContain("no repository is set (the dashboard's Settings → GitHub");

  const noSecret = await started({ config: { repository: "ana/bot" } });
  expect(await noSecret.github.repository(noSecret.ctx)).toBeUndefined();
  const missing = await noSecret.github.token(noSecret.ctx).catch((error: unknown) => error);
  expect(isGitHubNotConnected(missing)).toBe(true);
  expect((missing as Error).message).toContain("the secret GITHUB_TOKEN is not set");

  const both = await started({ config: { repository: "ana/bot", tokenSecret: "BOT_GITHUB_TOKEN" }, secrets: { BOT_GITHUB_TOKEN: "github_pat_secret-value" } });
  expect([await both.github.repository(both.ctx), await both.github.token(both.ctx)]).toEqual(["ana/bot", "github_pat_secret-value"]);
  expect(both.logged.join("\n")).not.toContain("github_pat_secret-value");
  for (const each of [none, noSecret, both]) await each.app.stop();
});

test("the repository is a setting over the config's, read at each call; the config's when the settings cannot be read", async () => {
  const store = memorySettings();
  const { app, github, ctx } = await started({ settings: store.settings, config: { repository: "ana/bot" }, secrets: { GITHUB_TOKEN: "github_pat_x" } });
  expect(store.declared.get("github-token")).toEqual({ repository: "ana/bot" });
  await store.settings.set("github-token", { repository: "ana/other" }, operator, ctx);
  expect(await github.repository(ctx)).toBe("ana/other");
  store.unreadable = true;
  expect(await github.repository(ctx)).toBe("ana/bot");
  await app.stop();
});
