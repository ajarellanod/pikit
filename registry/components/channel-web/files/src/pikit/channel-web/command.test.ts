/**
 * `pikit channel-web` against a fake of the App's operator routes (`/admin/api/channel-web/*`, as
 * `admin-api.ts` says they answer), served by `Bun.serve` on a free port.
 */

import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminChatUser } from "./admin-api.ts";
import { type CommandIO, type CommandOptions, command, localOrigin } from "./command.ts";

const TOKEN = "t".repeat(64);

type Call = { method: string; path: string; body?: unknown };
let users: AdminChatUser[] = [];
let calls: Call[] = [];

const user = (id: string, email: string, extra: Partial<AdminChatUser> = {}): AdminChatUser => ({
  id,
  name: id.toUpperCase(),
  email,
  emailVerified: true,
  methods: ["password"],
  createdAt: Date.UTC(2026, 0, 1),
  banned: false,
  ...extra,
});

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" && request.headers.get("content-type") === "application/json" ? await request.json() : undefined;
    calls.push({ method: request.method, path: url.pathname + url.search, ...(body !== undefined && { body }) });
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    const parts = url.pathname.split("/").slice(4); // after /admin/api/channel-web
    if (!url.pathname.startsWith("/admin/api/channel-web/")) return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method === "GET" && parts[0] === "users" && parts.length === 1) {
      // Two a page, to make the command read on.
      const from = Number(url.searchParams.get("offset") ?? 0);
      const items = users.slice(from, from + 2);
      return Response.json({ items, total: users.length, counts: { all: users.length, active: 0, invited: 0, banned: 0 } });
    }
    if (request.method === "POST" && parts[0] === "invitations") {
      const { email } = body as { email: string };
      if (users.some((each) => each.email === email)) return Response.json({ error: "exists", message: "that person already has an account" }, { status: 409 });
      return Response.json({ userId: "new1", link: "https://chat.test/chat/#/set-password?token=INVITE&invite=1", expiresAt: Date.UTC(2026, 0, 4), emailed: false }, { status: 201 });
    }
    const target = users.find((each) => each.id === decodeURIComponent(parts[1] ?? ""));
    if (parts[0] !== "users" || target === undefined) return Response.json({ error: "not_found", message: "no such user" }, { status: 404 });
    if (request.method === "POST" && (parts[2] === "ban" || parts[2] === "unban")) {
      target.banned = parts[2] === "ban";
      return Response.json({ id: target.id, banned: target.banned });
    }
    if (request.method === "POST" && parts[2] === "password-reset") return Response.json({ link: "https://chat.test/chat/#/set-password?token=RESET", expiresAt: Date.UTC(2026, 0, 2), emailed: true });
    if (request.method === "DELETE" && parts.length === 2) {
      users = users.filter((each) => each !== target);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});
afterAll(() => server.stop(true));
const ORIGIN = `http://127.0.0.1:${server.port}`;

beforeEach(() => {
  users = [user("ana", "ana@example.com", { lastSeenAt: Date.UTC(2026, 0, 3, 9, 30) }), user("ben", "ben@example.com", { banned: true }), user("cy", "cy@example.com", { methods: [], name: "" })];
  calls = [];
});

/** Runs `pikit channel-web <args>`: its problems and what it said. */
async function run(args: string[], env: Record<string, string> = { PIKIT_ADMIN_TOKEN: TOKEN, PIKIT_PUBLIC_URL: ORIGIN }, options: CommandOptions = { confirm: undefined }) {
  const said: string[] = [];
  const io: CommandIO = { args, config: async () => ({}), get: (name) => env[name], say: (line) => said.push(line) };
  const problems = await command(io, { localOrigin: async () => "http://127.0.0.1:9", ...options });
  return { problems, said, out: said.join("\n") };
}

test("users lists every user, page after page, with the operator's token", async () => {
  const { problems, said } = await run(["users"]);

  expect(problems).toEqual([]);
  expect(calls.map((call) => call.path)).toEqual(["/admin/api/channel-web/users?limit=100&offset=0", "/admin/api/channel-web/users?limit=100&offset=2"]);
  expect(said[0]).toMatch(/^ID +EMAIL +NAME +SIGNS IN WITH +CREATED +LAST SEEN +STATE$/);
  expect(said[1]).toMatch(/^ana +ana@example\.com +ANA +password +2026-01-01 00:00 +2026-01-03 09:30 +active$/);
  expect(said[2]).toMatch(/ben@example\.com .* never +banned$/);
  expect(said[3]).toMatch(/cy@example\.com +- +2026-01-01 00:00 +never +invited$/);
  expect(said.at(-1)).toBe("3 users (UTC)");
});

test("invite sends the email and the name, and prints the link once, saying whether it was emailed", async () => {
  const { problems, out } = await run(["invite", "Dee@Example.com", "--name", "Dee Dee"]);

  expect(problems).toEqual([]);
  expect(calls).toEqual([{ method: "POST", path: "/admin/api/channel-web/invitations", body: { email: "Dee@Example.com", name: "Dee Dee" } }]);
  expect(out).toContain("Invited dee@example.com (user new1).");
  expect(out.split("token=INVITE").length).toBe(2);
  expect(out).toContain("not emailed");
  expect(out).toContain("2026-01-04T00:00:00.000Z");
});

test("an invitation for an email in use says to make a reset link instead", async () => {
  const { problems } = await run(["invite", "ana@example.com"]);

  expect(problems).toEqual([expect.stringContaining("make a password-reset link instead")]);
});

test("reset, ban and unban find a user by email or id", async () => {
  const reset = await run(["reset", "ANA@example.com"]);
  expect(reset.problems).toEqual([]);
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/admin/api/channel-web/users/ana/password-reset" });
  expect(reset.out).toContain("token=RESET");
  expect(reset.out).toContain("emailed to them too");

  expect((await run(["ban", "ana"])).problems).toEqual([]);
  expect(users[0]?.banned).toBe(true);
  expect((await run(["unban", "ben@example.com"])).problems).toEqual([]);
  expect(users[1]?.banned).toBe(false);
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/admin/api/channel-web/users/ben/unban" });

  expect((await run(["ban", "nobody@example.com"])).problems).toEqual([expect.stringContaining("no user nobody@example.com")]);
});

test("remove asks first; without a terminal it needs --yes", async () => {
  expect((await run(["remove", "cy@example.com"])).problems).toEqual([expect.stringContaining("pass --yes")]);
  expect(users).toHaveLength(3);

  const declined = await run(["remove", "cy"], undefined, { confirm: async () => false });
  expect(declined.problems).toEqual([]);
  expect(declined.out).toBe("Not removed.");
  expect(users).toHaveLength(3);

  const asked: string[] = [];
  expect((await run(["remove", "cy"], undefined, { confirm: async (question) => (asked.push(question), true) })).problems).toEqual([]);
  expect(asked[0]).toContain("cy@example.com");
  expect(users.map((each) => each.id)).toEqual(["ana", "ben"]);

  const forced = await run(["remove", "ben", "--yes"]);
  expect(forced.problems).toEqual([]);
  expect(forced.out).toBe("Removed ben@example.com (ben).");
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/admin/api/channel-web/users/ben" });
});

test("--url names the App; without it and PIKIT_PUBLIC_URL, this machine's", async () => {
  expect((await run(["users", "--url", `${ORIGIN}/`], { PIKIT_ADMIN_TOKEN: TOKEN, PIKIT_PUBLIC_URL: "http://127.0.0.1:9" })).problems).toEqual([]);
  expect((await run(["users"], { PIKIT_ADMIN_TOKEN: TOKEN }, { localOrigin: async () => ORIGIN })).problems).toEqual([]);
  expect(calls).toHaveLength(4);
});

test("this machine's App is wrangler's with deployment-cloudflare, else server-bun's port from pikit.config.ts", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pikit-channel-web-command-"));
  try {
    expect(await localOrigin(dir)).toBe("http://127.0.0.1:3000");
    writeFileSync(join(dir, "pikit.config.ts"), 'export default { config: { "server-bun": { port: 4123 } } };\n');
    expect(await localOrigin(dir)).toBe("http://127.0.0.1:4123");
    writeFileSync(join(dir, "pikit.json"), JSON.stringify({ components: { "deployment-cloudflare": {} } }));
    expect(await localOrigin(dir)).toBe("http://127.0.0.1:8787");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what goes wrong is said: no token, a wrong one, no App, no routes, bad arguments", async () => {
  expect((await run(["users"], { PIKIT_PUBLIC_URL: ORIGIN })).problems).toEqual([expect.stringContaining("PIKIT_ADMIN_TOKEN is not set")]);
  expect((await run(["users"], { PIKIT_ADMIN_TOKEN: "wrong", PIKIT_PUBLIC_URL: ORIGIN })).problems).toEqual([expect.stringContaining("refused PIKIT_ADMIN_TOKEN (401)")]);
  expect((await run(["users"], { PIKIT_ADMIN_TOKEN: TOKEN, PIKIT_PUBLIC_URL: "http://127.0.0.1:9" })).problems).toEqual([expect.stringContaining("cannot reach http://127.0.0.1:9")]);
  expect((await run(["users", "--url", `${ORIGIN}/elsewhere`])).problems).toEqual([expect.stringContaining("is not an origin")]);

  const missing = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "not_found" }, { status: 404 }) });
  try {
    expect((await run(["users", "--url", `http://127.0.0.1:${missing.port}`])).problems).toEqual([expect.stringContaining("no channel-web operator routes")]);
  } finally {
    missing.stop(true);
  }

  for (const args of [[], ["nope"], ["users", "x"], ["invite"], ["invite", "not-an-email"], ["ban"], ["ban", "ana", "--yes"], ["remove", "ana", "--name"], ["users", "--what"]]) {
    const { problems } = await run(args);
    expect(problems.at(-1)).toStartWith("usage: pikit channel-web");
  }
  // Only the wrong token reached the App: nothing is sent before the arguments and the token are right.
  expect(calls).toHaveLength(1);
});
