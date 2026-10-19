/**
 * approvals-sql: the `approvals` capability (`contract.ts`) on `storage.sql`. Every approval lives with
 * one owner, the actor `approvals-sql:approvals` (`APPROVALS_KEY`): every operation is
 * `actor.mailbox.call(APPROVALS_KEY, "approvals-sql.<op>", …)`, answered by the handlers it registers
 * with `actor.inbox`, which read and write the table of the App they run in. On a server
 * (mailbox-local) that App is this one; the same path would reach one Durable Object on Cloudflare,
 * which is not tested yet, so the target is `server`.
 *
 * - **One table**, `approvals_sql`, created in `start`: the action as proposed, its hash, who may
 *   decide, and the state (`pending` → `approved` | `rejected`; `approved` → `claimed` → `executed` |
 *   `failed`). `expired` is computed when read, with the App's clock.
 * - **What the contract guarantees is enforced here, once**: the request's shape, idempotency by key
 *   (a unique column), the approvers (`isApprover`), and claim and decide in one transaction each, so
 *   two claimants never take one approval.
 * - **Nothing is held in memory** between calls.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { ActorCallError, isJsonObject, type JsonValue, type Sender } from "@pikit/contracts";
import { type Approval, type ApprovalRequest, type ApprovalStatus, type ApprovalStore, actionHash, type DecideOutcome } from "./contract.ts";

export const TABLE = "approvals_sql";
/** The actor that owns every approval. */
export const APPROVALS_KEY = "approvals-sql:approvals";
export const CALL = {
  propose: "approvals-sql.propose",
  list: "approvals-sql.list",
  decide: "approvals-sql.decide",
  claim: "approvals-sql.claim",
  settle: "approvals-sql.settle",
} as const;

const APPROVER = /^[^:\s]+:\S+$/;
const STATUSES: readonly ApprovalStatus[] = ["pending", "approved", "rejected", "expired", "claimed", "executed", "failed"];

/** Whether `sender` matches one of `approvers` (`<channel>:<id>`, or `<channel>:*` for anyone on that channel). */
export function isApprover(approvers: readonly string[], sender: Sender): boolean {
  return approvers.some((pattern) => {
    const at = pattern.indexOf(":");
    const id = pattern.slice(at + 1);
    return pattern.slice(0, at) === sender.channel && (id === "*" || id === sender.id);
  });
}

const invalid = (what: string) => new ActorCallError("invalid", `approvals-sql: ${what}`);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const isSender = (value: unknown): value is Sender => isJsonObject(value) && text(value.channel, 200) && text(value.id, 500);

/** The request, checked as it arrives (it crossed an actor as JSON). */
function requestOf(message: JsonValue): ApprovalRequest {
  if (!isJsonObject(message)) throw invalid("a request is a JSON object");
  const { idempotencyKey, action, title, summary, approvers, requestedBy, expiresAt } = message;
  if (!text(idempotencyKey, 500)) throw invalid("idempotencyKey is non-empty text");
  if (!isJsonObject(action) || !text(action.type, 200) || action.payload === undefined) throw invalid("action is { type, payload }");
  if (!text(title, 500)) throw invalid("title is non-empty text");
  if (summary !== undefined && (typeof summary !== "string" || summary.length > 4000)) throw invalid("summary is text");
  if (!Array.isArray(approvers) || approvers.length === 0 || !approvers.every((a) => typeof a === "string" && APPROVER.test(a))) {
    throw invalid("approvers are one or more <channel>:<id> or <channel>:*");
  }
  const conversation = isJsonObject(requestedBy) ? requestedBy.conversation : undefined;
  if (!isJsonObject(requestedBy) || !isJsonObject(conversation) || !text(conversation.key, 1000) || !text(conversation.agent, 200) || !text(conversation.conversationId, 500)) {
    throw invalid("requestedBy.conversation is a conversation ref");
  }
  if (requestedBy.sender !== undefined && !isSender(requestedBy.sender)) throw invalid("requestedBy.sender is { channel, id }");
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isInteger(expiresAt))) throw invalid("expiresAt is epoch ms");
  return message as unknown as ApprovalRequest;
}

type Row = Record<string, unknown>;
const optional = <K extends string>(key: K, value: unknown, read: (v: unknown) => unknown) => (value === null || value === undefined ? {} : { [key]: read(value) });

function approvalOf(row: Row, now: number): Approval {
  const stored = String(row.status) as ApprovalStatus;
  const expiresAt = row.expires_at === null ? undefined : Number(row.expires_at);
  const expired = (stored === "pending" || stored === "approved") && expiresAt !== undefined && expiresAt <= now;
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    action: { type: String(row.action_type), payload: JSON.parse(String(row.action_payload)) as JsonValue },
    actionHash: String(row.action_hash),
    title: String(row.title),
    ...optional("summary", row.summary, String),
    approvers: JSON.parse(String(row.approvers)) as string[],
    requestedBy: JSON.parse(String(row.requested_by)) as ApprovalRequest["requestedBy"],
    ...optional("expiresAt", expiresAt, Number),
    status: expired ? "expired" : stored,
    createdAt: Number(row.created_at),
    ...optional("decidedBy", row.decided_by, (v) => JSON.parse(String(v))),
    ...optional("decidedAt", row.decided_at, Number),
    ...optional("claimedBy", row.claimed_by, String),
    ...optional("claimedAt", row.claimed_at, Number),
    ...optional("settledAt", row.settled_at, Number),
    ...optional("detail", row.detail, String),
  } as Approval;
}

/** The SQL condition of a status as read (`expired` is pending or approved past its time). */
function statusWhere(status: ApprovalStatus, now: number): [string, (string | number)[]] {
  const live = "(expires_at IS NULL OR expires_at > ?)";
  if (status === "expired") return ["status IN ('pending', 'approved') AND expires_at <= ?", [now]];
  if (status === "pending" || status === "approved") return [`status = ? AND ${live}`, [status, now]];
  return ["status = ?", [status]];
}

export default defineComponent({
  name: "approvals-sql",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const mailbox = pikit.use("actor.mailbox");
    const inbox = pikit.use("actor.inbox");
    const now = () => pikit.clock.now();

    const call = (type: string, message: unknown, ctx: AppContext) => mailbox.get().call(APPROVALS_KEY, type, message as JsonValue, ctx);
    const store: ApprovalStore = {
      propose: async (request, ctx) => (await call(CALL.propose, request, ctx)) as unknown as Approval,
      list: async (query, ctx) => (await call(CALL.list, query, ctx)) as unknown as Awaited<ReturnType<ApprovalStore["list"]>>,
      decide: async (id, decision, ctx) => (await call(CALL.decide, { id, ...decision }, ctx)) as unknown as DecideOutcome,
      claim: async (claim, ctx) => ((await call(CALL.claim, claim, ctx)) ?? undefined) as unknown as Approval | undefined,
      settle: async (claimant, outcome, ctx) => ((await call(CALL.settle, { claimant, ...outcome }, ctx)) ?? undefined) as unknown as Approval | undefined,
    };
    pikit.provide("approvals", store);

    /** Only the owner answers: a call that reached another key is refused. */
    const owned = (key: string, message: JsonValue): Record<string, unknown> => {
      if (key !== APPROVALS_KEY) throw invalid(`${key} does not hold the approvals (${APPROVALS_KEY} does)`);
      if (!isJsonObject(message)) throw invalid("a call's message is a JSON object");
      return message;
    };
    const answer = (row: Row | undefined): JsonValue => (row === undefined ? null : (approvalOf(row, now()) as unknown as JsonValue));

    return {
      async start() {
        const db = sql.get();
        await db.run(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, action_type TEXT NOT NULL, ` +
            "action_payload TEXT NOT NULL, action_hash TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, approvers TEXT NOT NULL, " +
            "requested_by TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT, status TEXT NOT NULL, " +
            "decided_by TEXT, decided_at BIGINT, claimed_by TEXT UNIQUE, claimed_at BIGINT, settled_at BIGINT, detail TEXT)",
        );
        await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_claim ON ${TABLE} (action_hash, conversation_id, status)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_created ON ${TABLE} (created_at, id)`);

        const calls = inbox.get();
        calls.answer(CALL.propose, async (key, message) => {
          const request = requestOf(owned(key, message) as JsonValue);
          const hash = await actionHash(request.action);
          const byKey = `SELECT * FROM ${TABLE} WHERE idempotency_key = ?`;
          // Idempotent by key: the unique column makes two concurrent proposals one.
          await db.run(
            `INSERT INTO ${TABLE} (id, idempotency_key, action_type, action_payload, action_hash, title, summary, approvers, requested_by, ` +
              "conversation_id, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT (idempotency_key) DO NOTHING",
            [
              crypto.randomUUID(),
              request.idempotencyKey,
              request.action.type,
              JSON.stringify(request.action.payload),
              hash,
              request.title,
              request.summary ?? null,
              JSON.stringify(request.approvers),
              JSON.stringify(request.requestedBy),
              request.requestedBy.conversation.conversationId,
              now(),
              request.expiresAt ?? null,
            ],
          );
          const [row] = await db.query(byKey, [request.idempotencyKey]);
          if (row === undefined) throw new ActorCallError("failed", "approvals-sql: the approval was not stored");
          if (row.action_hash !== hash) throw new ActorCallError("conflict", `approvals-sql: the key "${request.idempotencyKey}" already holds another action`);
          return answer(row);
        });

        calls.answer(CALL.list, async (key, message) => {
          const { status, cursor, limit } = owned(key, message);
          if (status !== undefined && !STATUSES.includes(status as ApprovalStatus)) throw invalid(`status is one of ${STATUSES.join(", ")}`);
          if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw invalid("limit is 1 to 200");
          const where: string[] = [];
          const params: (string | number)[] = [];
          if (status !== undefined) {
            const [condition, values] = statusWhere(status as ApprovalStatus, now());
            where.push(condition);
            params.push(...values);
          }
          if (cursor !== undefined) {
            const match = typeof cursor === "string" ? /^(\d+):(.+)$/.exec(cursor) : null;
            if (match === null) throw invalid("cursor is the one a page gave");
            where.push("(created_at < ? OR (created_at = ? AND id < ?))");
            params.push(Number(match[1]), Number(match[1]), match[2] as string);
          }
          const size = (limit as number | undefined) ?? 50;
          const rows = await db.query(
            `SELECT * FROM ${TABLE}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
            [...params, size + 1],
          );
          const items = rows.slice(0, size);
          const last = items.at(-1);
          return { items: items.map(answer), ...(rows.length > size && last !== undefined && { next: `${Number(last.created_at)}:${String(last.id)}` }) };
        });

        calls.answer(CALL.decide, async (key, message) => {
          const { id, verdict, by } = owned(key, message);
          if (!text(id, 200)) throw invalid("id is non-empty text");
          if (verdict !== "approve" && verdict !== "reject") throw invalid('verdict is "approve" or "reject"');
          if (!isSender(by)) throw invalid("by is { channel, id }");
          return db.transaction(async (tx) => {
            const [row] = await tx.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
            if (row === undefined) return { ok: false, code: "not_found" };
            const approval = approvalOf(row, now());
            if (!isApprover(approval.approvers, by)) return { ok: false, code: "forbidden" };
            const stored = String(row.status);
            if (stored !== "pending") {
              // The same verdict again (a redelivered answer) is answered as it was recorded.
              const same = verdict === "reject" ? stored === "rejected" : stored !== "rejected";
              return same ? { ok: true, approval: approval as unknown as JsonValue } : { ok: false, code: "not_pending" };
            }
            if (approval.status === "expired") return { ok: false, code: "expired" };
            await tx.run(`UPDATE ${TABLE} SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`, [
              verdict === "approve" ? "approved" : "rejected",
              JSON.stringify({ channel: by.channel, id: by.id }),
              now(),
              id,
            ]);
            const [decided] = await tx.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
            return { ok: true, approval: answer(decided) };
          });
        });

        calls.answer(CALL.claim, async (key, message) => {
          const { actionHash: hash, conversationId, claimant } = owned(key, message);
          if (!text(hash, 200) || !text(conversationId, 500) || !text(claimant, 1000)) throw invalid("a claim is { actionHash, conversationId, claimant }");
          return db.transaction(async (tx) => {
            // The same claimant again (a hook run again after a crash) gets what it holds.
            const [held] = await tx.query(`SELECT * FROM ${TABLE} WHERE claimed_by = ?`, [claimant]);
            if (held !== undefined) return held.action_hash === hash && held.conversation_id === conversationId ? answer(held) : null;
            const [free] = await tx.query(
              `SELECT id FROM ${TABLE} WHERE action_hash = ? AND conversation_id = ? AND status = 'approved' AND (expires_at IS NULL OR expires_at > ?) ` +
                "ORDER BY decided_at, id LIMIT 1",
              [hash, conversationId, now()],
            );
            if (free === undefined) return null;
            await tx.run(`UPDATE ${TABLE} SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'approved'`, [claimant, now(), String(free.id)]);
            const [claimed] = await tx.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [String(free.id)]);
            return answer(claimed);
          });
        });

        calls.answer(CALL.settle, async (key, message) => {
          const { claimant, kind, detail } = owned(key, message);
          if (!text(claimant, 1000)) throw invalid("claimant is non-empty text");
          if (kind !== "executed" && kind !== "failed") throw invalid('kind is "executed" or "failed"');
          if (detail !== undefined && typeof detail !== "string") throw invalid("detail is text");
          // Once: a settled approval keeps what was said first.
          await db.run(`UPDATE ${TABLE} SET status = ?, settled_at = ?, detail = ? WHERE claimed_by = ? AND status = 'claimed'`, [
            kind,
            now(),
            typeof detail === "string" ? detail.slice(0, 2000) : null,
            claimant,
          ]);
          const [row] = await db.query(`SELECT * FROM ${TABLE} WHERE claimed_by = ?`, [claimant]);
          return answer(row);
        });
      },
    };
  },
});
