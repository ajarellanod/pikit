/**
 * admin-proposals: the gate of the agent's changes to itself (SPEC §6). The agent proposes a change as
 * a GitHub pull request from a branch under `branchPrefix` (`pikit/self/`) of the project's
 * repository; the operator reads it in the dashboard (its view, `view/`) and approves (merges) or
 * rejects (closes) it there. The deploy follows the merge: Workers Builds on Cloudflare.
 *
 * - **Two tokens, never the agent's for a merge.** `tokenSecret` (`GITHUB_TOKEN`, the agent's own in
 *   execution-do) only reads: the pull requests, their files, their checks. `mergeTokenSecret`
 *   (`PIKIT_MERGE_TOKEN`) merges, comments and closes, and only these routes read it: nothing an agent
 *   can call. The same token in both is refused (`503 not_configured`). A ruleset on the default
 *   branch (a pull request required, no direct push) keeps the gate even if the agent's token leaks.
 * - **Only proposals.** A pull request whose head is not a branch under the prefix of this same
 *   repository (a fork's `pikit/self/x` is not) is no proposal: not listed, not shown, never merged
 *   or closed. Approve also refuses a base other than the default branch, a head that moved since the
 *   operator read it (`sha`), and failing, pending or missing checks unless `override` says so.
 * - **Every route asks `admin.auth` first**, and answers JSON (`api.ts`), errors as `{ error, message }`
 *   that name a secret, never hold one. Approve and reject are logged with the operator and the number.
 * - **GitHub's REST API over `fetch`** (`github.ts`), so the same code serves a server and a Worker.
 *   Its rate limit is `429 rate_limited` with a `retry-after`; a refused token, a missing repository
 *   or GitHub down are `502`, saying which.
 *
 * Targets: `server` and `durable`. On Cloudflare it goes in both Apps (`apps.worker: "default"`): the
 * Worker's App serves its routes; the objects' copy is never reached (admin-api does the same).
 */

import { type AppContext, defineComponent } from "@pikit/core";
import type { Operator } from "@pikit/contracts";
import Type from "typebox";
import {
  type ApproveResponse,
  MAX_COMMENT,
  MAX_DIFF,
  MAX_FILES,
  MAX_PATCH,
  type ProposalChecks,
  type ProposalDetail,
  type ProposalFile,
  type ProposalList,
  type ProposalSummary,
  type RejectResponse,
} from "./api.ts";
import { createGitHub, findPreviewUrl, GitHubError, type GitHubFile, type GitHubPull } from "./github.ts";

export * from "./api.ts";

const SECRET_NAME = "^[A-Z][A-Z0-9_]*$";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const Config = Type.Object({
  /** The project's repository on GitHub, `owner/name`: where the agent opens its pull requests (checked at start). */
  repository: Type.String({ minLength: 3 }),
  /** What a proposal's branch starts with: execution-do's `git.branchPrefix`. */
  branchPrefix: Type.String({ minLength: 1, default: "pikit/self/" }),
  /** The secret holding the token that reads (pull requests, files, checks): the agent's may do. */
  tokenSecret: Type.String({ pattern: SECRET_NAME, default: "GITHUB_TOKEN" }),
  /** The secret holding the token that merges and closes: never the agent's. */
  mergeTokenSecret: Type.String({ pattern: SECRET_NAME, default: "PIKIT_MERGE_TOKEN" }),
  /** GitHub's REST API. A value, for GitHub Enterprise Server or a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://api.github.com" }),
});

/** Recently closed pull requests read for the list, and closed proposals listed. */
const CLOSED_READ = 30;
const CLOSED_LISTED = 20;
/** Open proposals whose checks the list reads (two requests each: a Worker's subrequests are counted). */
const CHECKED = 20;
/** The largest body an action takes. */
const MAX_BODY = 64 * 1024;
const ROUTE = "/admin/api/admin-proposals";

/** An answer that is not a success. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message ?? code);
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const stateOf = (pull: GitHubPull): ProposalSummary["state"] => (pull.state === "open" ? "open" : pull.merged_at !== null ? "merged" : "closed");

export default defineComponent({
  name: "admin-proposals",
  config: Config,
  setup(pikit, config) {
    if (config.tokenSecret === config.mergeTokenSecret) {
      throw new Error(`admin-proposals: mergeTokenSecret must name another secret than tokenSecret (both are ${config.tokenSecret}): the merge token is never the agent's`);
    }
    const auth = pikit.use("admin.auth");
    const secrets = pikit.use("secrets");
    const github = createGitHub(config.repository, config.apiBase, () => pikit.clock.now());
    const repository = config.repository.toLowerCase();

    const isProposal = (pull: GitHubPull) => pull.head.ref.startsWith(config.branchPrefix) && pull.head.repo?.full_name.toLowerCase() === repository;

    const secret = async (name: string, purpose: string): Promise<string> => {
      const value = await secrets.get().get(name);
      if (value === undefined) throw new Refusal(503, "not_configured", `${name} is not set: it is the GitHub token admin-proposals ${purpose} with`);
      return value;
    };
    const readToken = () => secret(config.tokenSecret, "reads the proposals");
    /** The merge token, and the read token for the reads around it; refused when they are the same. */
    const tokens = async () => {
      const read = await readToken();
      const merge = await secret(config.mergeTokenSecret, "merges and closes proposals");
      if (merge === read) {
        throw new Refusal(503, "not_configured", `${config.mergeTokenSecret} holds the same token as ${config.tokenSecret}: give merging a token of its own, which the agent never holds`);
      }
      return { read, merge };
    };

    /** `error` from GitHub as an answer; `notFound` for a 404 that means something to the caller. */
    const fromGitHub = (error: GitHubError, secretName: string, notFound?: Refusal): Refusal => {
      if (error.retryAfter !== undefined) {
        return new Refusal(429, "rate_limited", `GitHub's rate limit for ${secretName}: try again in ${error.retryAfter} s`, { "retry-after": String(error.retryAfter) });
      }
      if (error.status === 401) return new Refusal(502, "github_unauthorized", `GitHub refused ${secretName}: it is wrong, expired or revoked`);
      if (error.status === 403) return new Refusal(502, "github_forbidden", `GitHub refused ${secretName} on ${config.repository}: ${error.message}. It lacks a permission (admin-proposals' README, "Tokens")`);
      if (error.status === 404) return notFound ?? new Refusal(502, "github_not_found", `GitHub has no ${config.repository} that ${secretName} can read: check admin-proposals' repository and the token's repositories`);
      if (error.status === 0 || error.status >= 500) return new Refusal(502, "github_unavailable", `GitHub did not answer well (${error.status === 0 ? error.message : `HTTP ${error.status}`}): try again`);
      return new Refusal(502, "github_refused", `GitHub refused (${error.status}): ${error.message}`);
    };

    const notFound = (number: number) => new Refusal(404, "not_found", `${config.repository} has no pull request #${number}`);
    const notProposal = (number: number, status: number) =>
      new Refusal(status, "not_a_proposal", `#${number} is not a proposal: its branch is not under ${config.branchPrefix} of ${config.repository}`);

    const summaryOf = (pull: GitHubPull, checks?: ProposalChecks, previewUrl?: string): ProposalSummary => ({
      number: pull.number,
      title: pull.title,
      author: pull.user?.login ?? "unknown",
      branch: pull.head.ref,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      ...(pull.closed_at !== null && { closedAt: pull.closed_at }),
      state: stateOf(pull),
      draft: pull.draft === true,
      ...(checks !== undefined && { checks }),
      url: pull.html_url,
      ...(previewUrl !== undefined && { previewUrl }),
    });

    /** The files with their patches bounded: each cut at `MAX_PATCH`, none past `MAX_DIFF` in all. */
    const filesOf = (files: readonly GitHubFile[]): ProposalFile[] => {
      let sent = 0;
      return files.slice(0, MAX_FILES).map((file) => {
        const base = {
          path: file.filename,
          status: file.status,
          ...(file.previous_filename !== undefined && { previousPath: file.previous_filename }),
          additions: file.additions,
          deletions: file.deletions,
        };
        if (file.patch === undefined) return { ...base, truncated: false };
        if (sent >= MAX_DIFF) return { ...base, truncated: true };
        const patch = file.patch.slice(0, Math.min(MAX_PATCH, MAX_DIFF - sent));
        sent += patch.length;
        return { ...base, patch, truncated: patch.length < file.patch.length };
      });
    };

    /** The operator, or a `401`; then `work`'s answer, a refusal as JSON. */
    const route =
      (work: (request: Request, ctx: AppContext, operator: Operator) => Promise<Response>) =>
      async (request: Request, ctx: AppContext): Promise<Response> => {
        const operator = await auth.get().verify(request, ctx);
        if (operator === undefined) return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="pikit"' });
        try {
          return await work(request, ctx, operator);
        } catch (error) {
          if (error instanceof Refusal) return json({ error: error.code, message: error.message }, error.status, error.headers);
          throw error;
        }
      };

    /** `:number` of the request's path. */
    const numberOf = (request: Request): number => {
      const segment = new URL(request.url).pathname.split("/")[4] ?? "";
      if (!/^[1-9][0-9]{0,9}$/.test(segment)) throw new Refusal(404, "not_found", "a proposal is named by its pull request's number");
      return Number(segment);
    };

    /** The request's JSON object (`{}` when it has no body). */
    const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new Refusal(413, "too_large");
      const text = await request.text();
      if (text.length > MAX_BODY) throw new Refusal(413, "too_large");
      if (text.trim() === "") return {};
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Refusal(400, "invalid_request", "the body is not JSON");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Refusal(400, "invalid_request", "the body is a JSON object");
      return body as Record<string, unknown>;
    };

    /** GitHub's answer to `call`, a refusal saying why it failed. */
    const ask = async <T>(call: () => Promise<T>, secretName: string, notFoundAs?: Refusal): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (error instanceof GitHubError) throw fromGitHub(error, secretName, notFoundAs);
        throw error;
      }
    };

    /** The open proposal `number`, read with `token`: refused when it is not one, or not open. */
    const openProposal = async (number: number, token: string, signal: AbortSignal | undefined) => {
      const pull = await ask(() => github.pull(token, number, signal), config.tokenSecret, notFound(number));
      if (!isProposal(pull)) throw notProposal(number, 409);
      if (pull.state !== "open") throw new Refusal(409, "not_open", `#${number} is already ${stateOf(pull)}`);
      return pull;
    };

    pikit.provideKeyed(
      "http.route",
      `GET ${ROUTE}`,
      route(async (_request, ctx) => {
        const token = await readToken();
        const signal = ctx.abortSignal;
        const [open, closed] = await Promise.all([
          ask(() => github.pulls(token, "open", 100, signal), config.tokenSecret),
          ask(() => github.pulls(token, "closed", CLOSED_READ, signal), config.tokenSecret),
        ]);
        const proposals = open.filter(isProposal);
        // Best effort: a proposal whose checks cannot be read is listed without them.
        const checked = await Promise.all(proposals.slice(0, CHECKED).map((pull) => github.checks(token, pull.head.sha, signal).catch(() => undefined)));
        const list: ProposalList = {
          repository: config.repository,
          branchPrefix: config.branchPrefix,
          proposals: [
            ...proposals.map((pull, i) => summaryOf(pull, checked[i]?.checks, checked[i] === undefined ? undefined : findPreviewUrl(checked[i].texts))),
            ...closed
              .filter(isProposal)
              .slice(0, CLOSED_LISTED)
              .map((pull) => summaryOf(pull)),
          ],
        };
        return json(list);
      }),
    );

    pikit.provideKeyed(
      "http.route",
      `GET ${ROUTE}/:number`,
      route(async (request, ctx) => {
        const number = numberOf(request);
        const token = await readToken();
        const signal = ctx.abortSignal;
        const pull = await ask(() => github.pull(token, number, signal), config.tokenSecret, notFound(number));
        if (!isProposal(pull)) throw notProposal(number, 404);
        const [files, head, comments] = await Promise.all([
          ask(() => github.files(token, number, signal), config.tokenSecret),
          ask(() => github.checks(token, pull.head.sha, signal), config.tokenSecret),
          // Only where a preview may be named: best effort.
          github.comments(token, number, signal).catch(() => [] as string[]),
        ]);
        const detail: ProposalDetail = {
          ...summaryOf(pull, head.checks, findPreviewUrl([...head.texts, ...comments])),
          checks: head.checks,
          body: pull.body ?? "",
          base: pull.base.ref,
          defaultBranch: pull.base.repo.default_branch,
          headSha: pull.head.sha,
          mergeable: pull.mergeable ?? null,
          mergeableState: pull.mergeable_state ?? "unknown",
          additions: pull.additions ?? 0,
          deletions: pull.deletions ?? 0,
          changedFiles: pull.changed_files ?? files.length,
          files: filesOf(files),
        };
        return json(detail);
      }),
    );

    pikit.provideKeyed(
      "http.route",
      `POST ${ROUTE}/:number/approve`,
      route(async (request, ctx, operator) => {
        const number = numberOf(request);
        const body = await bodyOf(request);
        if (body.override !== undefined && typeof body.override !== "boolean") throw new Refusal(400, "invalid_request", "override is true or false");
        if (body.sha !== undefined && (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha))) throw new Refusal(400, "invalid_request", "sha is a commit's 40 hexadecimal digits");
        const override = body.override === true;
        const { read, merge } = await tokens();
        const signal = ctx.abortSignal;
        const pull = await openProposal(number, read, signal);
        if (pull.base.ref !== pull.base.repo.default_branch) {
          throw new Refusal(409, "wrong_base", `#${number} would merge into ${pull.base.ref}, not ${pull.base.repo.default_branch}, the default branch`);
        }
        if (body.sha !== undefined && body.sha !== pull.head.sha) throw new Refusal(409, "changed", `#${number} changed since you read it: read it again`);
        const { checks } = await ask(() => github.checks(read, pull.head.sha, signal), config.tokenSecret);
        if (checks.state !== "passing" && !override) {
          const why = checks.state === "failing" ? `${checks.failed} failing` : checks.state === "pending" ? `${checks.pending} still running` : "none ran";
          throw new Refusal(409, "checks_failing", `#${number}'s checks: ${why}. Approve it anyway only if you read the change`);
        }
        let sha: string;
        try {
          sha = await github.merge(merge, number, pull.head.sha, `${pull.title} (#${number})`, signal);
        } catch (error) {
          if (!(error instanceof GitHubError)) throw error;
          if (error.status === 409) throw new Refusal(409, "changed", `#${number} changed since it was checked: read it again`);
          if (error.status === 405 || error.status === 422) throw new Refusal(409, "not_mergeable", `GitHub cannot merge #${number}: ${error.message}`);
          throw fromGitHub(error, config.mergeTokenSecret, notFound(number));
        }
        ctx.logger.info("admin-proposals: approved and merged", { operator: operator.id, number, head: pull.head.sha, checks: checks.state, override: override && checks.state !== "passing" });
        const answer: ApproveResponse = { number, merged: true, sha };
        return json(answer);
      }),
    );

    pikit.provideKeyed(
      "http.route",
      `POST ${ROUTE}/:number/reject`,
      route(async (request, ctx, operator) => {
        const number = numberOf(request);
        const body = await bodyOf(request);
        if (body.comment !== undefined && (typeof body.comment !== "string" || body.comment.length > MAX_COMMENT)) {
          throw new Refusal(400, "invalid_request", `comment is text of at most ${MAX_COMMENT} characters`);
        }
        const comment = typeof body.comment === "string" ? body.comment.trim() : "";
        const { read, merge } = await tokens();
        const signal = ctx.abortSignal;
        await openProposal(number, read, signal);
        if (comment !== "") await ask(() => github.comment(merge, number, comment, signal), config.mergeTokenSecret, notFound(number));
        await ask(() => github.close(merge, number, signal), config.mergeTokenSecret, notFound(number));
        ctx.logger.info("admin-proposals: rejected and closed", { operator: operator.id, number, commented: comment !== "" });
        const answer: RejectResponse = { number, closed: true };
        return json(answer);
      }),
    );

    return {
      start() {
        if (!REPOSITORY.test(config.repository)) throw new Error(`admin-proposals: repository is the project's repository on GitHub as owner/name, not "${config.repository}"`);
      },
    };
  },
});
