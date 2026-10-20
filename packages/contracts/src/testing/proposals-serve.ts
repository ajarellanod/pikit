/**
 * `ProposalsRemote.serve` conformance: a `path` remote over git's smart HTTP, as a VM's shell reaches it
 * (`../proposals.ts`). Runner-independent: the requests are git's own, built here (pkt-lines and an
 * empty pack), so no git client is needed; the provider's `serve` may need git on the machine.
 *
 *   for (const c of createProposalsServeConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture is `createProposalsConformance`'s: an App whose `proposals` is connected, and a way to
 * make a proposal. A provider whose remote is not a `path` has no `serve`: its suite fails, saying so.
 */

import { type AppContext, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Proposals } from "../proposals.ts";
import { checker, expecter } from "./assert.ts";
import type { ProposalsFixture } from "./proposals.ts";

const GROUP = "proposals serve";
const expect = expecter(GROUP);
const check = checker(GROUP);
const BASE = "http://proposals.conformance/project.git";
const ZERO = "0".repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Serve = (request: Request) => Promise<Response>;

interface Running {
  serve: Serve;
  mainBranch: string;
  branchPrefix: string;
  proposals: Proposals;
  ctx: AppContext;
  fixture: ProposalsFixture;
}

/** One pkt-line. */
function pkt(data: string): Uint8Array {
  const bytes = encoder.encode(data);
  return concat(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The pkt-lines of `body` (a flush as `null`). */
function pktLines(body: Uint8Array): (Uint8Array | null)[] {
  const lines: (Uint8Array | null)[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const length = Number.parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (!Number.isInteger(length)) throw new Error(`${GROUP}: not a pkt-line at byte ${at}`);
    if (length === 0) {
      lines.push(null);
      at += 4;
      continue;
    }
    lines.push(body.subarray(at + 4, at + length));
    at += length;
  }
  return lines;
}

/** A pack with no object, as git sends when the objects are there already. */
async function emptyPack(): Promise<Uint8Array> {
  const header = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  return concat(header, new Uint8Array(await crypto.subtle.digest("SHA-1", header)));
}

/** A receive-pack request: `commands` (`old new ref`), the capabilities on the first, then an empty pack unless every one deletes. */
async function push(serve: Serve, commands: [string, string, string][], capabilities = "report-status"): Promise<Response> {
  const lines = commands.map(([old, next, ref], index) => pkt(`${old} ${next} ${ref}${index === 0 ? `\0${capabilities}` : ""}\n`));
  const deletesOnly = commands.every(([, next]) => next === ZERO);
  const body = concat(...lines, encoder.encode("0000"), deletesOnly ? new Uint8Array() : await emptyPack());
  return await serve(new Request(`${BASE}/git-receive-pack`, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body }));
}

/** The repository's refs as `info/refs` advertises them for `service`. */
async function advertised(serve: Serve, service = "git-receive-pack"): Promise<Map<string, string>> {
  const response = await serve(new Request(`${BASE}/info/refs?service=${service}`));
  expect(response.status, 200, `info/refs?service=${service}'s status`);
  expect(response.headers.get("content-type"), `application/x-${service}-advertisement`, `info/refs?service=${service}'s content type`);
  const lines = pktLines(new Uint8Array(await response.arrayBuffer()));
  const first = lines[0];
  check(first !== null && first !== undefined && decoder.decode(first) === `# service=${service}\n`, `info/refs to start with # service=${service}`);
  const refs = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line === null) continue;
    const text = decoder.decode(line).split("\0")[0]?.replace(/\n$/, "") ?? "";
    const [oid, ref] = text.split(" ");
    if (oid !== undefined && ref !== undefined && /^[0-9a-f]{40}$/.test(oid)) refs.set(ref, oid);
  }
  return refs;
}

/** What a refusal says: the side band's error band, or an `ERR` line; `undefined` when the answer is not one. */
function refusalOf(body: Uint8Array): string | undefined {
  const first = pktLines(body)[0];
  if (first === null || first === undefined) return undefined;
  if (first[0] === 3) return decoder.decode(first.subarray(1));
  const text = decoder.decode(first);
  return text.startsWith("ERR ") ? text.slice(4) : undefined;
}

export function createProposalsServeConformance(factory: () => ProposalsFixture | Promise<ProposalsFixture>): readonly ConformanceCase[] {
  const serveCase = (name: string, run: (running: Running) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      let handle: Handle<Proposals> | undefined;
      const consumer = defineComponent({ name: "proposals-serve-conformance", setup: (pikit) => void (handle = pikit.use("proposals")) });
      const app = await defineApp({
        components: [...fixture.components(), consumer],
        logger: silentLogger,
        ...(fixture.config !== undefined && { config: fixture.config }),
        ...(fixture.target !== undefined && { target: fixture.target }),
      }).create();
      try {
        await app.start();
        if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
        const proposals = handle.get();
        const ctx = app.context();
        const remote = await proposals.remote(ctx);
        if (remote?.kind !== "path") throw new Error(`${GROUP}: a connected fixture with a path remote (and its serve), not ${remote === undefined ? "none" : remote.kind}`);
        await run({ serve: remote.serve, mainBranch: remote.mainBranch, branchPrefix: remote.branchPrefix, proposals, ctx, fixture });
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    serveCase("info/refs advertises the main branch and the proposals, for a clone and for a push; anything else is 404", async ({ serve, mainBranch, branchPrefix, fixture }) => {
      const made = await fixture.propose({ topic: "served", title: "Served", body: "", file: "served.txt", text: "served\n" });
      for (const service of ["git-upload-pack", "git-receive-pack"]) {
        const refs = await advertised(serve, service);
        check(refs.has(`refs/heads/${mainBranch}`), `${service}'s advertisement to name refs/heads/${mainBranch}`);
        expect(refs.get(`refs/heads/${branchPrefix}served`), made.head, `${service}'s advertisement of the proposal`);
      }
      for (const [method, path] of [["GET", "/HEAD"], ["GET", "/objects/info/packs"], ["GET", "/info/refs"], ["GET", "/info/refs?service=git-other"], ["POST", "/info/refs?service=git-upload-pack"], ["GET", "/git-receive-pack"]] as const) {
        const response = await serve(new Request(`${BASE}${path}`, { method, ...(method === "POST" && { body: "0000" }) }));
        expect(response.status, 404, `${method} ${path}`);
      }
    }),

    serveCase("a push that creates or updates branches under the prefix is taken", async ({ serve, mainBranch, branchPrefix, proposals, ctx, fixture }) => {
      const made = await fixture.propose({ topic: "update-me", title: "Update me", body: "", file: "u.txt", text: "u\n" });
      const main = (await advertised(serve)).get(`refs/heads/${mainBranch}`) ?? "";
      const created = `refs/heads/${branchPrefix}created`;
      const updated = `refs/heads/${branchPrefix}update-me`;
      const response = await push(serve, [
        [ZERO, main, created],
        [made.head, main, updated],
      ]);
      expect(response.status, 200, "the push's status");
      const body = new Uint8Array(await response.arrayBuffer());
      const said = pktLines(body).flatMap((line) => (line === null ? [] : [decoder.decode(line)]));
      expect(refusalOf(body), undefined, "a refusal of an allowed push");
      check(said.includes("unpack ok\n"), `git to unpack it (${JSON.stringify(said)})`);
      check(said.includes(`ok ${created}\n`) && said.includes(`ok ${updated}\n`), `git to take both branches (${JSON.stringify(said)})`);
      const refs = await advertised(serve);
      expect(refs.get(created), main, "the created branch");
      expect(refs.get(updated), main, "the updated branch");
      check((await proposals.list(ctx)).proposals.some((each) => each.id === "created"), "the created branch to be listed as a proposal");
    }),

    serveCase("a push to the main branch, outside the prefix, a deletion, or one of them beside an allowed branch is refused whole, saying why, and writes nothing", async ({ serve, mainBranch, branchPrefix, fixture }) => {
      const made = await fixture.propose({ topic: "keep", title: "Keep", body: "", file: "k.txt", text: "k\n" });
      const before = await advertised(serve);
      const main = before.get(`refs/heads/${mainBranch}`) ?? "";
      const pushes: [string, [string, string, string][]][] = [
        ["moving the main branch", [[main, made.head, `refs/heads/${mainBranch}`]]],
        ["a branch outside the prefix", [[ZERO, made.head, "refs/heads/feature/not-a-proposal"]]],
        ["a tag", [[ZERO, made.head, "refs/tags/v1"]]],
        ["a ref that is no branch", [[ZERO, made.head, "refs/pikit/rejected/keep"]]],
        ["the prefix itself, with no topic", [[ZERO, made.head, `refs/heads/${branchPrefix}`]]],
        ["deleting a proposal", [[made.head, ZERO, `refs/heads/${branchPrefix}keep`]]],
        ["an allowed branch and the main branch", [[ZERO, made.head, `refs/heads/${branchPrefix}fine`], [main, made.head, `refs/heads/${mainBranch}`]]],
      ];
      for (const [what, commands] of pushes) {
        for (const capabilities of ["report-status", "report-status side-band-64k"]) {
          const response = await push(serve, commands, capabilities);
          const reason = refusalOf(new Uint8Array(await response.arrayBuffer()));
          check(reason !== undefined && reason.trim() !== "", `${what} (${capabilities}) to be refused, saying why`);
        }
      }
      const unreadable = await serve(new Request(`${BASE}/git-receive-pack`, { method: "POST", body: "not a push" }));
      check(refusalOf(new Uint8Array(await unreadable.arrayBuffer())) !== undefined, "a push that cannot be read to be refused");
      const after = await advertised(serve);
      expect([...after].sort(), [...before].sort(), "the refs after the refused pushes");
    }),
  ];
}
