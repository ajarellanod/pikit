/**
 * proposals-github's tests, against a fake GitHub on a local port (`fake-github.test-support.ts`): the
 * `proposals` conformance suite, then what it does with GitHub. They are copied with the component and
 * keep running in your project.
 */

import { afterEach, expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, type Handle, type Logger, silentLogger } from "@pikit/core";
import { type Proposals, ProposalsError, type Settings, SettingsError, type SettingsSchema, type SettingsValue } from "@pikit/contracts";
import { createProposalsConformance } from "@pikit/contracts/testing";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.test-support.ts";
import proposalsGithub, { MAX_PATCH } from "./index.ts";

const OPERATOR = { id: "ops" };
const SHA = "1234567890abcdef1234567890abcdef12345678";

let fakes: FakeGitHub[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()));
  fakes = [];
});

/** The secrets a test's App reads. */
const secretsOf = (values: Record<string, string>) =>
  defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => values[name] }) });

const hex = (n: number) => n.toString(16).padStart(40, "0");

// The contract, against the fake GitHub: the steward pushes a branch, whose pull request this opens.
for (const c of createProposalsConformance(() => {
  const github = startFakeGitHub();
  let commits = 100;
  const pushed = new Map<string, { message: string; files: { filename: string; status: string; additions: number; patch: string }[] }>();
  return {
    components: () => [secretsOf({ GITHUB_TOKEN: github.readToken, PIKIT_MERGE_TOKEN: github.mergeToken }), proposalsGithub],
    config: { "proposals-github": { repository: github.repository, apiBase: github.url } },
    target: "durable",
    async propose({ topic, title, body, file, text }) {
      const head = hex(commits++);
      const files = [{ filename: file, status: "added", additions: text.split("\n").length - 1, patch: `@@ -0,0 +1 @@\n${text.split("\n").filter((line) => line !== "").map((line) => `+${line}`).join("\n")}` }];
      pushed.set(topic, { message: `${title}\n\n${body}`, files });
      github.addBranch(`pikit/self/${topic}`, head, `${title}\n\n${body}`, files);
      return { id: topic, head };
    },
    async pushAgain(id) {
      const head = hex(commits++);
      const before = pushed.get(id);
      github.addBranch(`pikit/self/${id}`, head, before?.message ?? "Again", before?.files ?? []);
      return head;
    },
    async other(branch) {
      github.addBranch(branch, hex(commits++), "Not a proposal");
    },
    dispose: () => github.stop(),
  };
})) {
  test(`proposals-github ${c.group}: ${c.name}`, () => c.run());
}

/**
 * A `settings` in memory, as the contract says (stored keys over the defaults, kept while the schema's
 * `pattern`s accept them, enough here); `unreadable` makes `get` reject, as an unreachable store does.
 */
function memorySettings() {
  const declared = new Map<string, { schema: SettingsSchema; defaults: SettingsValue }>();
  const stored = new Map<string, SettingsValue>();
  const store = {
    unreadable: false,
    declared,
    settings: {
      declare(component, schema, defaults) {
        if (declared.has(component)) throw new Error(`${component} declared already`);
        declared.set(component, { schema, defaults });
      },
      async get<T extends SettingsValue>(component: string, _ctx: AppContext): Promise<T> {
        if (store.unreadable) throw new Error("the settings object could not be reached");
        const found = declared.get(component);
        if (found === undefined) throw new SettingsError("unknown_component", component);
        return { ...found.defaults, ...stored.get(component) } as T;
      },
      async set(component, value) {
        const found = declared.get(component);
        if (found === undefined) throw new SettingsError("unknown_component", component);
        const properties = (found.schema as { properties: Record<string, { pattern?: string }> }).properties;
        for (const [key, each] of Object.entries(value)) {
          const pattern = properties[key]?.pattern;
          if (pattern !== undefined && !new RegExp(pattern).test(String(each))) throw new SettingsError("invalid_value", `/${key}`);
        }
        stored.set(component, value);
        return { ...found.defaults, ...value };
      },
      sections: async () => [],
    } as Settings,
  };
  return store;
}

/** A started App with proposals-github over a fake GitHub and its secrets. */
async function started(options: { github?: FakeGitHub; secrets?: Record<string, string>; config?: Record<string, unknown>; settings?: Settings } = {}) {
  const github = options.github ?? startFakeGitHub();
  fakes.push(github);
  const values: Record<string, string> = options.secrets ?? { GITHUB_TOKEN: github.readToken, PIKIT_MERGE_TOKEN: github.mergeToken };
  const logged: { message: string; fields: unknown }[] = [];
  const record = (message: string, fields?: unknown) => void logged.push({ message, fields });
  const logger: Logger = { ...silentLogger, info: record, warn: record } as Logger;
  let handle: Handle<Proposals> | undefined;
  const providers = defineComponent({
    name: "providers-test",
    setup(pikit) {
      pikit.provide("secrets", { get: async (name) => values[name] });
      if (options.settings !== undefined) pikit.provide("settings", options.settings);
    },
  });
  const consumer = defineComponent({ name: "consumer-test", setup: (pikit) => void (handle = pikit.use("proposals")) });
  const config = { "proposals-github": { repository: github.repository, apiBase: github.url, ...options.config } };
  const app = await defineApp({ components: [providers, proposalsGithub, consumer], config, logger }).create();
  await app.start();
  const proposals = handle?.get() as Proposals;
  const ctx = app.context();
  return { github, app, proposals, ctx, logged };
}

/** What `work` rejected with: its code and status, or `ok`. */
async function failure(work: Promise<unknown>): Promise<[string, number] | "ok"> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof ProposalsError) return [error.code, error.status];
    throw error;
  }
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [proposalsGithub], config: { "proposals-github": { repository: "ana/bot" } }, logger: silentLogger }).create().catch((error: unknown) => error);
  // It requires secrets: alone it does not compose, and says what is missing.
  expect(String(app)).toContain("secrets");

  const { app: whole } = await started();
  expect(whole.describe().components.find((component) => component.name === "proposals-github")).toEqual({
    name: "proposals-github",
    provides: ["proposals"],
    requires: ["secrets"],
    optional: ["settings"],
  });
  await whole.stop();
  // A repository is owner/name, or nothing.
  await expect(started({ config: { repository: "not a repository" } })).rejects.toThrow("repository");
});

test("dormant until connected: without a repository it starts, and every call but status is not_connected, saying what to set", async () => {
  const { github, proposals, ctx, app } = await started({ config: { repository: "" }, secrets: {} });
  for (const work of [proposals.list(ctx), proposals.get("a", ctx), proposals.approve("a", { operator: OPERATOR }, ctx), proposals.reject("a", { operator: OPERATOR }, ctx)]) {
    const error = await work.then(
      () => undefined,
      (thrown: unknown) => thrown as ProposalsError,
    );
    expect([error?.code, error?.status]).toEqual(["not_connected", 503]);
    expect(error?.message).toContain("Settings → Self-improvement on GitHub");
  }
  expect(await proposals.remote(ctx)).toBeUndefined();
  expect(github.requests).toEqual([]);
  await app.stop();

  // A repository and no token: the token is what is missing.
  const noToken = await started({ secrets: {} });
  const error = (await noToken.proposals.list(noToken.ctx).catch((thrown: unknown) => thrown)) as ProposalsError;
  expect([error.code, error.status]).toEqual(["not_connected", 503]);
  expect(error.message).toContain("GITHUB_TOKEN is not set");
  await noToken.app.stop();
});

test("the repository is a setting: its default the config's, changed from the dashboard and used by the next call", async () => {
  const store = memorySettings();
  const { github, proposals, ctx, app } = await started({ settings: store.settings, config: { repository: "" } });
  github.addPull({ number: 1, branch: "pikit/self/a" });
  const declared = store.declared.get("proposals-github");
  expect(declared?.defaults).toEqual({ repository: "" });
  expect(Object.keys((declared?.schema as { properties: object }).properties)).toEqual(["repository"]);

  expect(await failure(proposals.list(ctx))).toEqual(["not_connected", 503]);
  await expect(store.settings.set("proposals-github", { repository: "no slash" }, OPERATOR, app.context())).rejects.toThrow("/repository");
  await store.settings.set("proposals-github", { repository: github.repository }, OPERATOR, app.context());
  expect((await proposals.list(ctx)).proposals.map((proposal) => proposal.number)).toEqual([1]);
  expect(await proposals.remote(ctx)).toMatchObject({ kind: "https", url: "https://github.com/ana/bot.git", branchPrefix: "pikit/self/" });
  // Another repository: GitHub is asked for that one.
  await store.settings.set("proposals-github", { repository: "ana/other" }, OPERATOR, app.context());
  expect(await failure(proposals.list(ctx))).toEqual(["missing_repository", 502]);
  await app.stop();

  // A store that cannot be read: the config's repository applies, logged.
  const unreadable = memorySettings();
  unreadable.unreadable = true;
  const fallback = await started({ settings: unreadable.settings });
  expect(await failure(fallback.proposals.list(fallback.ctx))).toBe("ok");
  expect(fallback.logged.map((line) => line.message)).toContain("proposals-github: its settings could not be read; the config's repository applies");
  await fallback.app.stop();
});

test("remote: the repository's clone URL, authorized with the read token by trusted code", async () => {
  const { github, proposals, ctx, app } = await started();
  const remote = await proposals.remote(ctx);
  if (remote?.kind !== "https") throw new Error("an https remote");
  expect(await remote.authorization()).toBe(`Basic ${btoa(`x-access-token:${github.readToken}`)}`);
  expect(JSON.stringify(remote)).not.toContain(github.readToken);
  await app.stop();
});

test("status: each part of the connection checked live, the merge token never sent", async () => {
  const { github, proposals, ctx, app } = await started();
  const parts = async (of = proposals, at = ctx) => {
    const status = await of.status(at);
    return { status, by: Object.fromEntries(status.checks.map((check) => [check.id, check])) };
  };
  const first = await parts();
  expect(first.status).toMatchObject({ connected: true, where: "ana/bot on GitHub", branchPrefix: "pikit/self/" });
  expect(first.status.checks.map((check) => [check.id, check.state])).toEqual([
    ["repository", "ok"],
    ["readToken", "ok"],
    ["mergeToken", "ok"],
    ["ruleset", "missing"],
  ]);
  expect(first.by.readToken?.label).toBe("GITHUB_TOKEN (reads)");
  expect(first.by.ruleset?.message).toContain("No ruleset requires a pull request on main");

  github.rules = [{ type: "pull_request" }, { type: "required_status_checks" }, { type: "non_fast_forward" }];
  const ruled = await parts();
  expect(ruled.by.ruleset).toEqual({ id: "ruleset", label: "Ruleset on main", state: "ok", message: "A ruleset requires a pull request on main, and status checks." });
  expect(github.requests.map((request) => [request.path, request.token])).toEqual([
    ["/repos/ana/bot", github.readToken],
    ["/repos/ana/bot/rules/branches/main?per_page=100", github.readToken],
    ["/repos/ana/bot", github.readToken],
    ["/repos/ana/bot/rules/branches/main?per_page=100", github.readToken],
  ]);
  github.failWith = "down";
  const down = await parts();
  expect([down.status.connected, down.by.repository?.state, down.by.ruleset?.state]).toEqual([false, "unknown", "unknown"]);
  github.failWith = undefined;
  await app.stop();

  const nothing = await started({ config: { repository: "" }, secrets: {} });
  const none = await parts(nothing.proposals, nothing.ctx);
  expect(none.status.connected).toBe(false);
  expect(none.status.checks.map((check) => check.state)).toEqual(["missing", "missing", "missing", "unknown"]);
  expect(nothing.github.requests).toEqual([]);
  await nothing.app.stop();

  const wrong = await started({ secrets: { GITHUB_TOKEN: "expired-token", PIKIT_MERGE_TOKEN: "expired-token" } });
  const refused = await parts(wrong.proposals, wrong.ctx);
  expect([refused.by.readToken?.state, refused.by.mergeToken?.state]).toEqual(["failing", "failing"]);
  expect(JSON.stringify(refused.status)).not.toContain("expired-token");
  await wrong.app.stop();

  const elsewhere = await started({ config: { repository: "ana/other" } });
  const missing = await parts(elsewhere.proposals, elsewhere.ctx);
  expect([missing.status.connected, missing.by.repository?.state]).toEqual([false, "failing"]);
  await elsewhere.app.stop();
});

test("the list: open proposals with their checks and preview, then the closed ones; other branches and forks left out", async () => {
  const { github, proposals, ctx, app } = await started();
  github.addPull({ number: 1, branch: "pikit/self/calendar", sha: SHA, title: "A calendar tool" });
  github.addPull({ number: 2, branch: "feature/by-a-person" });
  github.addPull({ number: 3, branch: "pikit/self/from-a-fork", headRepository: "mallory/bot" });
  github.addPull({ number: 4, branch: "pikit/self/merged", state: "closed", merged: true });
  github.addPull({ number: 5, branch: "pikit/self/rejected", state: "closed" });
  github.setChecks(SHA, [
    { name: "checks", status: "completed", conclusion: "success" },
    { name: "Workers Builds: pikit-bot", status: "completed", conclusion: "success", summary: "| Preview URL | https://8a3b2c1d-pikit-bot.ana.workers.dev |" },
  ]);

  const list = await proposals.list(ctx);
  expect(list).toMatchObject({ where: "ana/bot on GitHub", url: "https://github.com/ana/bot/pulls", branchPrefix: "pikit/self/", checksRun: "before-approval" });
  expect(list.proposals.map((proposal) => [proposal.id, proposal.state])).toEqual([
    ["calendar", "open"],
    ["rejected", "closed"],
    ["merged", "merged"],
  ]);
  expect(list.proposals[0]).toMatchObject({
    id: "calendar",
    number: 1,
    title: "A calendar tool",
    author: "pikit-agent",
    branch: "pikit/self/calendar",
    url: "https://github.com/ana/bot/pull/1",
    previewUrl: "https://8a3b2c1d-pikit-bot.ana.workers.dev",
    checks: { state: "passing", passed: 2, failed: 0, pending: 0 },
  });
  expect(list.proposals[1]?.checks).toBeUndefined();
  // Read with the read token only.
  expect(new Set(github.requests.map((request) => request.token))).toEqual(new Set([github.readToken]));
  await app.stop();
});

test("a pushed branch without a pull request gets one, titled from its head commit, with the read token; one closed at its head is never opened again", async () => {
  const { github, proposals, ctx, app, logged } = await started();
  github.addBranch("pikit/self/shorter", SHA, "Shorter answers\n\nWhy: people read on phones.\n");
  github.addBranch("pikit/self/rejected", "9".repeat(40), "Rejected once");
  github.addPull({ number: 4, branch: "pikit/self/rejected", state: "closed", sha: "9".repeat(40) });
  github.addBranch("feature/person", "8".repeat(40), "A person's");

  const list = await proposals.list(ctx);
  expect(list.proposals.map((proposal) => [proposal.id, proposal.state, proposal.title])).toEqual([
    ["shorter", "open", "Shorter answers"],
    ["rejected", "closed", "Proposal 4"],
  ]);
  const opened = github.requests.filter((request) => request.method === "POST");
  expect(opened.map((request) => [request.path, request.token, request.body])).toEqual([
    ["/repos/ana/bot/pulls", github.readToken, { head: "pikit/self/shorter", base: "main", title: "Shorter answers", body: "Why: people read on phones." }],
  ]);
  expect(logged.map((line) => line.message)).toContain("proposals-github: opened a pull request for a pushed branch");
  // Listed again: nothing more is opened.
  await proposals.list(ctx);
  expect(github.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect((await proposals.get("shorter", ctx)).body).toBe("Why: people read on phones.");

  // The agent pushes the rejected branch again: a new head, a new pull request.
  github.addBranch("pikit/self/rejected", "7".repeat(40), "Better this time");
  expect((await proposals.get("rejected", ctx)).title).toBe("Better this time");
  await app.stop();
});

test("a proposal: the description, files with bounded patches, checks, mergeable state; a non-proposal is not_found", async () => {
  const { github, proposals, ctx, app } = await started();
  github.setFiles(7, [
    { filename: "src/pikit/tool-calendar/index.ts", status: "added", additions: 40, patch: "@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;" },
    { filename: "big.txt", additions: 9000, patch: `@@ -1 +1 @@\n${"+x\n".repeat(30_000)}` },
    { filename: "logo.png", status: "added" },
  ]);
  github.addPull({ number: 7, branch: "pikit/self/calendar", sha: SHA, body: "Adds **a calendar tool**.\n\nTests: `bun test` passes." });
  github.addPull({ number: 8, branch: "main-fix" });
  github.setChecks(SHA, [{ name: "checks", status: "in_progress" }], [{ context: "ci/other", state: "success" }]);
  github.comments.set(7, ["Deploying with Cloudflare Workers: https://pikit-calendar-pikit-bot.ana.workers.dev"]);

  const detail = await proposals.get("calendar", ctx);
  expect(detail).toMatchObject({
    id: "calendar",
    number: 7,
    body: "Adds **a calendar tool**.\n\nTests: `bun test` passes.",
    base: "main",
    defaultBranch: "main",
    head: SHA,
    mergeable: true,
    mergeableState: "clean",
    changedFiles: 3,
    previewUrl: "https://pikit-calendar-pikit-bot.ana.workers.dev",
    checks: { state: "pending", passed: 1, pending: 1, failed: 0 },
  });
  expect(detail.files.map((file) => [file.path, file.status, file.truncated])).toEqual([
    ["src/pikit/tool-calendar/index.ts", "added", false],
    ["big.txt", "modified", true],
    ["logo.png", "added", false],
  ]);
  expect(detail.files[1]?.patch?.length).toBe(MAX_PATCH);
  expect(detail.files[2]?.patch).toBeUndefined();

  expect(await failure(proposals.get("main-fix", ctx))).toEqual(["not_found", 404]);
  expect(await failure(proposals.get("nothing", ctx))).toEqual(["not_found", 404]);
  expect(await failure(proposals.get("../main", ctx))).toEqual(["not_found", 404]);
  await app.stop();
});

test("approve merges a proposal whose checks pass (squash, its reviewed head), with the merge token only, and logs who", async () => {
  const { github, proposals, ctx, app, logged } = await started();
  github.addPull({ number: 3, branch: "pikit/self/prompt", sha: SHA, title: "Shorter answers" });
  github.setChecks(SHA, [{ name: "checks", status: "completed", conclusion: "success" }]);

  expect(await proposals.approve("prompt", { head: SHA, operator: OPERATOR }, ctx)).toMatchObject({ ok: true, id: "prompt", head: SHA, merged: true });
  expect(github.pull(3)).toMatchObject({ state: "closed", merged: true });

  const writes = github.requests.filter((request) => request.method !== "GET");
  expect(writes.map((request) => [request.method, request.path, request.token])).toEqual([["PUT", "/repos/ana/bot/pulls/3/merge", github.mergeToken]]);
  expect(writes[0]?.body).toEqual({ merge_method: "squash", sha: SHA, commit_title: "Shorter answers (#3)" });
  // The read token never writes; the merge token never reads.
  expect(github.requests.filter((request) => request.method === "GET").every((request) => request.token === github.readToken)).toBe(true);
  expect(logged).toContainEqual({ message: "proposals-github: approved and merged", fields: { operator: "ops", number: 3, head: SHA, checks: "passing", override: false } });
  expect(JSON.stringify(logged)).not.toContain(github.mergeToken);
  expect(JSON.stringify(logged)).not.toContain(github.readToken);
  await app.stop();
});

test("approve refuses failing, pending or missing checks unless overridden", async () => {
  const { github, proposals, ctx, app, logged } = await started();
  const failing = "1".repeat(40);
  const pending = "2".repeat(40);
  const none = "3".repeat(40);
  github.addPull({ number: 1, branch: "pikit/self/a", sha: failing });
  github.addPull({ number: 2, branch: "pikit/self/b", sha: pending });
  github.addPull({ number: 3, branch: "pikit/self/c", sha: none });
  github.setChecks(failing, [{ name: "checks", status: "completed", conclusion: "failure" }]);
  github.setChecks(pending, [], [{ context: "ci", state: "pending" }]);

  for (const id of ["a", "b", "c"]) {
    expect([id, await proposals.approve(id, { operator: OPERATOR }, ctx)]).toEqual([id, expect.objectContaining({ ok: false, code: "checks_failing" })]);
  }
  expect(github.requests.some((request) => request.method === "PUT")).toBe(false);

  expect((await proposals.approve("a", { override: true, operator: OPERATOR }, ctx)).ok).toBe(true);
  expect(github.pull(1)?.merged).toBe(true);
  expect(logged.at(-1)?.fields).toMatchObject({ number: 1, checks: "failing", override: true });
  await app.stop();
});

test("approve refuses what is not an open proposal into the default branch, or a head that moved", async () => {
  const { github, proposals, ctx, app } = await started();
  github.addPull({ number: 1, branch: "feature/x", sha: SHA });
  github.addPull({ number: 2, branch: "pikit/self/fork", headRepository: "mallory/bot", sha: SHA });
  github.addPull({ number: 3, branch: "pikit/self/elsewhere", base: "release", sha: SHA });
  github.addPull({ number: 4, branch: "pikit/self/done", state: "closed", merged: true, sha: SHA });
  github.addPull({ number: 5, branch: "pikit/self/moved", sha: SHA });
  github.setChecks(SHA, [{ name: "checks", status: "completed", conclusion: "success" }]);

  const refusal = async (id: string, head?: string) => {
    const outcome = await proposals.approve(id, { override: true, operator: OPERATOR, ...(head !== undefined && { head }) }, ctx);
    return outcome.ok ? "approved" : outcome.code;
  };
  expect(await refusal("x")).toBe("not_found");
  expect(await refusal("fork")).toBe("not_found");
  expect(await refusal("elsewhere")).toBe("wrong_base");
  expect(await refusal("done")).toBe("not_open");
  expect(await refusal("moved", "9".repeat(40))).toBe("moved");
  expect(await refusal("nothing")).toBe("not_found");
  expect(github.requests.some((request) => request.method !== "GET")).toBe(false);

  github.mergeRefusal = { status: 405, message: "Pull Request is not mergeable" };
  expect(await refusal("moved")).toBe("not_mergeable");
  github.mergeRefusal = { status: 409, message: "Head branch was modified." };
  expect(await refusal("moved")).toBe("moved");
  await app.stop();
});

test("reject closes the proposal with the operator's comment, with the merge token", async () => {
  const { github, proposals, ctx, app, logged } = await started();
  github.addPull({ number: 6, branch: "pikit/self/risky" });
  github.addPull({ number: 7, branch: "feature/person" });

  expect(await proposals.reject("risky", { comment: "Not now: it reads every file.", operator: OPERATOR }, ctx)).toMatchObject({ ok: true, id: "risky" });
  expect(github.pull(6)).toMatchObject({ state: "closed", merged: false });
  expect(github.comments.get(6)).toEqual(["Not now: it reads every file."]);
  const writes = github.requests.filter((request) => request.method !== "GET");
  expect(writes.map((request) => [request.method, request.path, request.token])).toEqual([
    ["POST", "/repos/ana/bot/issues/6/comments", github.mergeToken],
    ["PATCH", "/repos/ana/bot/pulls/6", github.mergeToken],
  ]);
  expect(logged.at(-1)).toEqual({ message: "proposals-github: rejected and closed", fields: { operator: "ops", number: 6, commented: true } });

  // Without a comment, closed only; a person's pull request is not the dashboard's to close.
  github.addPull({ number: 8, branch: "pikit/self/other" });
  expect((await proposals.reject("other", { operator: OPERATOR }, ctx)).ok).toBe(true);
  expect(github.comments.get(8)).toBeUndefined();
  expect(await proposals.reject("person", { operator: OPERATOR }, ctx)).toMatchObject({ ok: false, code: "not_found" });
  expect(github.pull(7)?.state).toBe("open");
  await app.stop();
});

test("tokens: a missing one is not_connected, the same in both secrets not_configured, naming the secret and never the token", async () => {
  const shared = await started({ secrets: { GITHUB_TOKEN: "same-token", PIKIT_MERGE_TOKEN: "same-token" } });
  shared.github.addPull({ number: 1, branch: "pikit/self/a" });
  const same = await shared.proposals.approve("a", { override: true, operator: OPERATOR }, shared.ctx).catch((error: unknown) => error as ProposalsError);
  expect([(same as ProposalsError).code, (same as ProposalsError).status]).toEqual(["not_configured", 503]);
  expect((same as ProposalsError).message).toContain("PIKIT_MERGE_TOKEN");
  expect((same as ProposalsError).message).not.toContain("same-token");
  await shared.app.stop();

  const readOnly = await started({ secrets: { GITHUB_TOKEN: "read-token-for-tests" } });
  readOnly.github.addPull({ number: 1, branch: "pikit/self/a" });
  expect(await failure(readOnly.proposals.list(readOnly.ctx))).toBe("ok");
  const noMerge = await readOnly.proposals.reject("a", { operator: OPERATOR }, readOnly.ctx).catch((error: unknown) => error as ProposalsError);
  expect([(noMerge as ProposalsError).code, (noMerge as ProposalsError).message]).toEqual(["not_connected", expect.stringContaining("PIKIT_MERGE_TOKEN is not set")]);
  expect(readOnly.github.pull(1)?.state).toBe("open");
  await readOnly.app.stop();

  await expect(started({ config: { mergeTokenSecret: "GITHUB_TOKEN" } })).rejects.toThrow("mergeTokenSecret must name another secret");
});

test("GitHub's errors: a rate limit is 429 with retry-after, a refused token or GitHub down 502, never a token", async () => {
  const { github, proposals, ctx, app } = await started();
  github.failWith = "rate_limit";
  const limited = await proposals.list(ctx).catch((error: unknown) => error as ProposalsError);
  expect([(limited as ProposalsError).code, (limited as ProposalsError).status]).toEqual(["rate_limited", 429]);
  expect((limited as ProposalsError).retryAfter).toBeGreaterThan(60);

  github.failWith = "secondary_rate_limit";
  const secondary = await proposals.get("a", ctx).catch((error: unknown) => error as ProposalsError);
  expect([(secondary as ProposalsError).status, (secondary as ProposalsError).retryAfter]).toEqual([429, 30]);

  github.failWith = "down";
  expect(await failure(proposals.list(ctx))).toEqual(["unavailable", 502]);
  github.failWith = undefined;
  await app.stop();

  const wrong = await started({ secrets: { GITHUB_TOKEN: "expired-token", PIKIT_MERGE_TOKEN: "other-token" } });
  const refused = await wrong.proposals.list(wrong.ctx).catch((error: unknown) => error as ProposalsError);
  expect([(refused as ProposalsError).code, (refused as ProposalsError).status]).toEqual(["unauthorized", 502]);
  expect((refused as ProposalsError).message).not.toContain("expired-token");
  await wrong.app.stop();
});

test("a read-only token in the merge secret: GitHub's 403 is forbidden, and nothing is merged", async () => {
  const github = startFakeGitHub();
  const { proposals, ctx, app } = await started({ github, secrets: { GITHUB_TOKEN: github.mergeToken, PIKIT_MERGE_TOKEN: github.readToken } });
  github.addPull({ number: 2, branch: "pikit/self/b", sha: SHA });
  github.setChecks(SHA, [{ name: "checks", status: "completed", conclusion: "success" }]);
  const error = await proposals.approve("b", { operator: OPERATOR }, ctx).catch((thrown: unknown) => thrown as ProposalsError);
  expect([(error as ProposalsError).code, (error as ProposalsError).status]).toEqual(["forbidden", 502]);
  expect((error as ProposalsError).message).toContain("PIKIT_MERGE_TOKEN");
  expect(github.pull(2)?.state).toBe("open");
  await app.stop();
});
