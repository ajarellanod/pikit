/**
 * proposals-local: `proposals` on a server (SPEC §6), with nothing to set up. The project is a git
 * repository; its proposals are branches `pikit/self/<topic>` of a bare repository in the app's state
 * volume (`.pikit/self/project.git`), whose `main` deployment-docker's deployer keeps at the project's
 * main branch. The steward clones it with plain git (`remote`), commits on a branch under the prefix,
 * runs the tests, and pushes the branch back: that is the proposal.
 *
 * - **Read** with isomorphic-git: each branch's head commit (its subject the title, its body the
 *   description), the files changed since it left `main` (their merge base), with bounded patches.
 * - **Approve** records the head the operator read, with the operator, in `.pikit/self/decisions.json`;
 *   the deployer, next to the app (deployment-docker), picks it up: it merges it into the project's
 *   main branch, runs the checks (install, typecheck, tests), rebuilds and restarts the app, waits for
 *   `/health`, and rolls back when any step fails. It writes what happened to
 *   `.pikit/self/deployer.json`, which this reads: a proposal's deploy, its checks, and the status's
 *   deploys. No merge happens here.
 * - **Reject** records the rejection (with the comment), keeps the head under
 *   `refs/pikit/rejected/<topic>` and deletes the branch.
 *
 * **Not a lock.** The agent's shell runs in the app's container, as the same user: it can write these
 * files and that repository, so it could forge an approval. The approval is the operator's decision,
 * not a wall; the deployer trusts nothing else of the app's, and always runs the checks, waits for
 * `/health` and rolls back. A wall needs the agent's commands elsewhere
 * (features/sandboxed-execution.md).
 *
 * Target: `server`.
 */

import * as fs from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineComponent } from "@pikit/core";
import {
  type ApproveOutcome,
  type ProposalChecks,
  type ProposalDeploy,
  type ProposalDetail,
  type ProposalFile,
  type ProposalList,
  type Proposals,
  type ProposalsCheck,
  ProposalsError,
  type ProposalsStatus,
  type ProposalSummary,
  type RejectOutcome,
} from "@pikit/contracts";
import { structuredPatch } from "diff";
import git, { TREE } from "isomorphic-git";
import Type from "typebox";

const NAME = "proposals-local";

/** The most files a proposal lists. */
export const MAX_FILES = 100;
/** One file's patch is cut past this many characters. */
export const MAX_PATCH = 60_000;
/** Once the patches sent add up to this many characters, the next ones are left out. */
export const MAX_DIFF = 400_000;
/** Decisions kept in `decisions.json`, newest. */
const KEPT = 200;
/** Closed proposals listed. */
const CLOSED_LISTED = 20;
/** The deployer is running when it wrote its heartbeat this recently. */
export const HEARTBEAT_MS = 60_000;

const Config = Type.Object({
  /**
   * Where proposals live, relative to the app's working directory: in the state volume, shared with
   * the deployer (deployment-docker), which reads `decisions.json` and writes `deployer.json` there.
   */
  directory: Type.String({ minLength: 1, default: ".pikit/self" }),
  /** What a proposal's branch starts with. */
  branchPrefix: Type.String({ minLength: 1, default: "pikit/self/" }),
  /** The project's main branch, as the deployer keeps it in the proposals repository. */
  mainBranch: Type.String({ minLength: 1, default: "main" }),
});

/** An operator's decision on a proposal's head, as `decisions.json` keeps it (the deployer's input). */
export interface Decision {
  id: string;
  branch: string;
  head: string;
  decision: "approved" | "rejected";
  operator: string;
  /** ISO 8601. */
  at: string;
  title: string;
  comment?: string;
}

/** A step the deployer ran on an approved head. */
interface DeployerCheck {
  name: string;
  state: "passing" | "failing" | "pending" | "skipped";
  detail: string;
}

/** What the deployer writes (`deployer.json`): deployment-docker's `DeployerState`. */
export interface DeployerFile {
  startedAt?: string;
  heartbeatAt?: string;
  /** Whether the project's checkout can be deployed from, and why not. */
  project?: { ok: boolean; message: string };
  deploying?: string;
  outcomes?: Record<string, ProposalDeploy & { id?: string; checks?: DeployerCheck[] }>;
  lastDeploy?: { head: string; id?: string; message: string; at: string };
  lastRollback?: { head: string; id?: string; message: string; at: string };
  lastFailure?: { head: string; id?: string; message: string; at: string };
}

const NO_CHECKS: ProposalChecks = { state: "none", passed: 0, failed: 0, pending: 0, items: [] };

/** The steps the deployer ran, summed up as the contract's checks. */
export function checksOf(items: readonly DeployerCheck[] | undefined): ProposalChecks {
  if (items === undefined || items.length === 0) return NO_CHECKS;
  const count = (state: DeployerCheck["state"]) => items.filter((item) => item.state === state).length;
  const failed = count("failing");
  const pending = count("pending");
  const passed = count("passing");
  return { state: failed > 0 ? "failing" : pending > 0 ? "pending" : passed > 0 ? "passing" : "none", passed, failed, pending, items: [...items] };
}

const decoder = new TextDecoder();
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    const directory = resolve(config.directory);
    const gitdir = join(directory, "project.git");
    const decisionsPath = join(directory, "decisions.json");
    const deployerPath = join(directory, "deployer.json");
    const prefix = config.branchPrefix;
    const main = config.mainBranch;
    const now = () => new Date(pikit.clock.now()).toISOString();
    // Decisions are written one at a time.
    let writing: Promise<unknown> = Promise.resolve();

    const readJson = async <T>(path: string, empty: T): Promise<T> => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as T;
      } catch {
        return empty;
      }
    };
    const decisions = async () => (await readJson<{ decisions?: Decision[] }>(decisionsPath, {})).decisions ?? [];
    const deployer = () => readJson<DeployerFile>(deployerPath, {});
    const record = (decision: Decision) => {
      const done = writing.then(async () => {
        const kept = [decision, ...(await decisions())].slice(0, KEPT);
        await mkdir(directory, { recursive: true });
        // Whole or not at all: the deployer may read it at any moment.
        const temporary = `${decisionsPath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ decisions: kept }, null, 2)}\n`);
        await rename(temporary, decisionsPath);
      });
      writing = done.catch(() => {});
      return done;
    };

    /** `main`'s commit, or `undefined` while the deployer has not made the repository. */
    const mainHead = async () => git.resolveRef({ fs, gitdir, ref: `refs/heads/${main}` }).catch(() => undefined);
    const notReady = () =>
      new ProposalsError("not_connected", 503, `Self-improvement is not ready: the proposals repository ${gitdir} has no ${main} yet. The deployer makes it when it starts: \`pikit up\`, with the project a git repository`);
    const ready = async () => {
      const head = await mainHead();
      if (head === undefined) throw notReady();
      return head;
    };
    const branchOf = (id: string) => `${prefix}${id}`;
    const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(id) && !id.includes("..") && !id.endsWith("/");
    const headOf = async (id: string) => (validId(id) ? git.resolveRef({ fs, gitdir, ref: `refs/heads/${branchOf(id)}` }).catch(() => undefined) : undefined);
    const branches = async () => (await git.listBranches({ fs, gitdir }).catch(() => [] as string[])).filter((branch) => branch.startsWith(prefix) && validId(branch.slice(prefix.length)));

    /** The commits from `head` back to `base` (excluded), newest first; at most 50. */
    const commitsSince = async (head: string, base: string | undefined) => {
      const found: Awaited<ReturnType<typeof git.log>> = [];
      for (const entry of await git.log({ fs, gitdir, ref: head, depth: 50 })) {
        if (entry.oid === base) break;
        found.push(entry);
      }
      return found;
    };
    const baseOf = async (head: string, mainOid: string) => ((await git.findMergeBase({ fs, gitdir, oids: [mainOid, head] })) as string[])[0];

    /** A decision's state, and its deploy as the deployer wrote it. */
    const decided = (decision: Decision | undefined, file: DeployerFile): { state: ProposalSummary["state"]; deploy?: ProposalDeploy; checks?: ProposalChecks } => {
      if (decision === undefined) return { state: "open" };
      if (decision.decision === "rejected") return { state: "closed" };
      const outcome = file.outcomes?.[decision.head];
      const deploy: ProposalDeploy = outcome === undefined ? { outcome: "waiting", message: "Waiting for the deployer to pick it up.", at: decision.at } : { outcome: outcome.outcome, message: outcome.message, at: outcome.at };
      const state = deploy.outcome === "deployed" ? "merged" : deploy.outcome === "rolled back" || deploy.outcome === "failed" ? "failed" : "approved";
      return { state, deploy, checks: checksOf(outcome?.checks) };
    };
    const decisionOf = (all: readonly Decision[], id: string, head: string) => all.find((decision) => decision.id === id && decision.head === head);

    const summaryOf = async (id: string, head: string, mainOid: string, all: readonly Decision[], file: DeployerFile): Promise<ProposalSummary> => {
      const base = await baseOf(head, mainOid).catch(() => undefined);
      const commits = await commitsSince(head, base);
      const top = commits[0] ?? (await git.log({ fs, gitdir, ref: head, depth: 1 }))[0];
      const oldest = commits.at(-1) ?? top;
      const decision = decisionOf(all, id, head);
      const { state, deploy, checks } = decided(decision, file);
      return {
        id,
        title: top?.commit.message.split("\n")[0]?.trim() || branchOf(id),
        author: top?.commit.author.name ?? "unknown",
        branch: branchOf(id),
        createdAt: iso(oldest?.commit.author.timestamp ?? 0),
        updatedAt: iso(top?.commit.committer.timestamp ?? 0),
        ...(decision !== undefined && { closedAt: decision.at }),
        state,
        draft: false,
        ...(checks !== undefined && { checks }),
        ...(deploy !== undefined && { deploy }),
      };
    };

    /** The files `head` changed since `base`, with their patches bounded. */
    const filesOf = async (base: string | undefined, head: string) => {
      const changed: { path: string; before?: Uint8Array; after?: Uint8Array }[] = [];
      await git.walk({
        fs,
        gitdir,
        trees: base === undefined ? [TREE({ ref: head })] : [TREE({ ref: base }), TREE({ ref: head })],
        map: async (path, entries) => {
          if (path === ".") return true;
          const [a, b] = base === undefined ? [null, entries[0] ?? null] : [entries[0] ?? null, entries[1] ?? null];
          const typeA = a === null ? undefined : await a.type();
          const typeB = b === null ? undefined : await b.type();
          // The same object at the same path: nothing under it changed.
          if (typeA === typeB && (await a?.oid()) === (await b?.oid())) return null;
          if (typeA === "blob" || typeB === "blob") {
            changed.push({
              path,
              ...(typeA === "blob" && { before: (await a?.content()) ?? new Uint8Array() }),
              ...(typeB === "blob" && { after: (await b?.content()) ?? new Uint8Array() }),
            });
          }
          // Into a tree on either side (a file replaced by a directory too).
          return typeA === "tree" || typeB === "tree" ? true : null;
        },
      });
      changed.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      let sent = 0;
      let additions = 0;
      let deletions = 0;
      const files: ProposalFile[] = changed.map((change) => {
        const status = change.before === undefined ? "added" : change.after === undefined ? "removed" : "modified";
        const before = change.before ?? new Uint8Array();
        const after = change.after ?? new Uint8Array();
        if (before.includes(0) || after.includes(0)) return { path: change.path, status, additions: 0, deletions: 0, truncated: false };
        const patch = structuredPatch(`a/${change.path}`, `b/${change.path}`, decoder.decode(before), decoder.decode(after), "", "", { context: 3 });
        const lines = patch.hunks.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]);
        const added = lines.filter((line) => line.startsWith("+")).length;
        const removed = lines.filter((line) => line.startsWith("-")).length;
        additions += added;
        deletions += removed;
        const text = lines.join("\n");
        const base = { path: change.path, status, additions: added, deletions: removed };
        if (sent >= MAX_DIFF) return { ...base, truncated: true };
        const cut = text.slice(0, Math.min(MAX_PATCH, MAX_DIFF - sent));
        sent += cut.length;
        return { ...base, patch: cut, truncated: cut.length < text.length };
      });
      return { files: files.slice(0, MAX_FILES), additions, deletions, changedFiles: files.length };
    };

    const proposals: Proposals = {
      async status(): Promise<ProposalsStatus> {
        const head = await mainHead();
        const file = await deployer();
        const beat = file.heartbeatAt === undefined ? undefined : Date.parse(file.heartbeatAt);
        const running = beat !== undefined && pikit.clock.now() - beat < HEARTBEAT_MS;
        const checks: ProposalsCheck[] = [
          head === undefined
            ? { id: "repository", label: "Proposals repository", state: "missing", message: `${gitdir} has no ${main} yet: the deployer makes it from the project's main branch when it starts (\`pikit up\`). The project must be a git repository with a commit.` }
            : { id: "repository", label: "Proposals repository", state: "ok", message: `${gitdir}: ${main} at ${head.slice(0, 7)}. The agent clones it, and pushes branches ${prefix}<topic>.` },
          beat === undefined
            ? { id: "deployer", label: "Deployer", state: "missing", message: "The deployer has never run: `pikit up` starts it next to the app (deployment-docker, Docker)." }
            : running
              ? { id: "deployer", label: "Deployer", state: "ok", message: `Running, seen ${Math.round((pikit.clock.now() - beat) / 1000)} s ago: it deploys what you approve.` }
              : { id: "deployer", label: "Deployer", state: "failing", message: `Not seen since ${file.heartbeatAt}: approvals wait until it runs again (\`pikit up\`; \`pikit logs\`).` },
        ];
        if (file.project !== undefined) {
          checks.push({ id: "project", label: "Project checkout", state: file.project.ok ? "ok" : "failing", message: file.project.message });
        }
        return {
          connected: head !== undefined && running && file.project?.ok !== false,
          where: "this server's proposals repository",
          branchPrefix: prefix,
          checks,
          deploys: {
            ...(file.lastDeploy !== undefined && { lastDeploy: file.lastDeploy }),
            ...(file.lastRollback !== undefined && { lastRollback: file.lastRollback }),
            ...(file.lastFailure !== undefined && { lastFailure: file.lastFailure }),
            ...(file.deploying !== undefined && { deploying: file.deploying }),
          },
        };
      },

      async list(): Promise<ProposalList> {
        const mainOid = await ready();
        const [all, file] = await Promise.all([decisions(), deployer()]);
        const live = new Set<string>();
        const open: ProposalSummary[] = [];
        for (const branch of await branches()) {
          const id = branch.slice(prefix.length);
          const head = await headOf(id);
          if (head === undefined) continue;
          live.add(id);
          open.push(await summaryOf(id, head, mainOid, all, file));
        }
        const rank = (summary: ProposalSummary) => (summary.state === "open" ? 0 : summary.state === "approved" ? 1 : 2);
        open.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        // What was decided and has no branch now (rejected, or moved on), the newest decision of each.
        const seen = new Set(live);
        const closed: ProposalSummary[] = [];
        for (const decision of all) {
          if (seen.has(decision.id) || closed.length >= CLOSED_LISTED) continue;
          seen.add(decision.id);
          const { state, deploy } = decided(decision, file);
          closed.push({
            id: decision.id,
            title: decision.title,
            author: decision.operator,
            branch: decision.branch,
            createdAt: decision.at,
            updatedAt: decision.at,
            closedAt: decision.at,
            state,
            draft: false,
            ...(deploy !== undefined && { deploy }),
          });
        }
        return { where: "this server's proposals repository", branchPrefix: prefix, checksRun: "after-approval", proposals: [...open, ...closed] };
      },

      async get(id): Promise<ProposalDetail> {
        const mainOid = await ready();
        const [all, file] = await Promise.all([decisions(), deployer()]);
        const head = (await headOf(id)) ?? all.find((decision) => decision.id === id)?.head;
        if (head === undefined || !(await git.readCommit({ fs, gitdir, oid: head }).then(() => true, () => false))) {
          throw new ProposalsError("not_found", 404, `no proposal ${id}: no branch ${branchOf(id)}`);
        }
        const summary = await summaryOf(id, head, mainOid, all, file);
        const base = await baseOf(head, mainOid).catch(() => undefined);
        const commits = await commitsSince(head, base);
        const message = commits[0]?.commit.message ?? "";
        const body = message.split("\n").slice(1).join("\n").trim();
        const others = commits.slice(1).map((entry) => `- ${entry.commit.message.split("\n")[0]}`);
        const decision = decisionOf(all, id, head);
        const { files, additions, deletions, changedFiles } = await filesOf(base, head);
        return {
          ...summary,
          body: [body, others.length > 0 ? `Earlier commits:\n${others.join("\n")}` : "", decision?.comment === undefined ? "" : `Rejected by ${decision.operator}: ${decision.comment}`].filter((part) => part !== "").join("\n\n"),
          base: main,
          defaultBranch: main,
          head,
          mergeable: base === undefined ? false : null,
          mergeableState: base === undefined ? "unrelated" : base === mainOid ? "clean" : "behind",
          additions,
          deletions,
          changedFiles,
          files,
          checks: summary.checks ?? NO_CHECKS,
          checksRun: "after-approval",
        };
      },

      async approve(id, request): Promise<ApproveOutcome> {
        await ready();
        const head = await headOf(id);
        const all = await decisions();
        if (head === undefined) {
          return all.some((decision) => decision.id === id) ? { ok: false, code: "not_open", message: `${id} was decided already` } : { ok: false, code: "not_found", message: `no proposal ${id}` };
        }
        if (decisionOf(all, id, head) !== undefined) return { ok: false, code: "not_open", message: `${id} at ${head.slice(0, 7)} was decided already` };
        if (request.head !== undefined && request.head !== head) return { ok: false, code: "moved", message: `${id} changed since you read it: read it again` };
        const title = (await git.log({ fs, gitdir, ref: head, depth: 1 }))[0]?.commit.message.split("\n")[0]?.trim() ?? branchOf(id);
        await record({ id, branch: branchOf(id), head, decision: "approved", operator: request.operator.id, at: now(), title });
        return { ok: true, id, head, merged: false, message: "Approved: the deployer merges it into main, runs the checks, rebuilds and restarts the app, and rolls back if it is unhealthy." };
      },

      async reject(id, request): Promise<RejectOutcome> {
        await ready();
        const head = await headOf(id);
        const all = await decisions();
        if (head === undefined) {
          return all.some((decision) => decision.id === id) ? { ok: false, code: "not_open", message: `${id} was decided already` } : { ok: false, code: "not_found", message: `no proposal ${id}` };
        }
        if (decisionOf(all, id, head) !== undefined) return { ok: false, code: "not_open", message: `${id} at ${head.slice(0, 7)} was decided already` };
        const title = (await git.log({ fs, gitdir, ref: head, depth: 1 }))[0]?.commit.message.split("\n")[0]?.trim() ?? branchOf(id);
        // Kept, not lost: the head stays reachable under refs/pikit/rejected/.
        await git.writeRef({ fs, gitdir, ref: `refs/pikit/rejected/${id}`, value: head, force: true });
        await git.deleteRef({ fs, gitdir, ref: `refs/heads/${branchOf(id)}` });
        await record({ id, branch: branchOf(id), head, decision: "rejected", operator: request.operator.id, at: now(), title, ...(request.comment !== undefined && { comment: request.comment }) });
        return { ok: true, id, message: "Rejected: the branch is closed, never deployed." };
      },

      async remote() {
        if ((await mainHead()) === undefined) return undefined;
        return { kind: "path", path: gitdir, mainBranch: main, branchPrefix: prefix };
      },
    };
    pikit.provide("proposals", proposals);

    return {
      async start() {
        // The shared directory, where the deployer writes and reads: made by the app, whose user owns the volume.
        await mkdir(directory, { recursive: true });
      },
    };
  },
});
