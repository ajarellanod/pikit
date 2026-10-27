/**
 * admin-approvals: the dashboard's routes for `approvals` (`contract.ts`). An operator lists the
 * approvals and approves or rejects one as `{ channel: "dashboard", id: <operator> }`, held to the
 * approvers the proposer gave like anyone else (`dashboard:*` lets every operator decide). After a
 * decision, the conversation that asked is told, once: a message dispatched with the request id
 * `approval-decided:<id>`, which the runtime takes once however often the operator clicks.
 *
 * - **Every route asks `admin.auth` first** (without a provider, nobody is an operator): `401`, and
 *   `approvals` is not asked.
 *   - `GET /admin/api/approvals?status=&cursor=&limit=`: a page, newest first (`ApprovalPage`).
 *   - `POST /admin/api/approvals/:id/decision` `{ verdict: "approve" | "reject" }`: `{ approval }`, or
 *     `404 not_found`, `403 forbidden`, `409 not_pending | expired`.
 * - **Decisions are logged** with the operator and the approval.
 * - **Told through the asking conversation's actor** (`actor.mailbox.send` to its key,
 *   `admin-approvals.decided`), whose App dispatches it (this default export's handler): on a server
 *   that is this App; on `durable` the routes are the Worker half's (`worker.ts`) and the conversation
 *   is in its own Durable Object. The handler takes only a decision for its own key's conversation.
 */

import { type AppContext, defineComponent, type Pikit } from "@pikit/core";
import { type AgentRequest, isJsonObject, type JsonValue, type Operator } from "@pikit/contracts";
import type { Approval, ApprovalStatus } from "./contract.ts";

const ROUTE = "/admin/api/approvals";
const MAX_BODY = 4 * 1024;
const STATUS = { not_found: 404, forbidden: 403, not_pending: 409, expired: 409 } as const;
/** The request id of the message that tells the asking conversation: once per approval. */
export const decidedRequestId = (id: string) => `approval-decided:${id}`;
/** The actor message that carries it to the asking conversation's App. */
export const DECIDED = "admin-approvals.decided";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The message telling `approval`'s conversation of an operator's verdict. */
export function decidedRequest(approval: Approval, verdict: "approve" | "reject"): AgentRequest {
  const by = approval.decidedBy as NonNullable<Approval["decidedBy"]>;
  return {
    requestId: decidedRequestId(approval.id),
    conversation: approval.requestedBy.conversation,
    prompt: `[approvals] Approval ${approval.id} ("${approval.title}") was ${verdict === "approve" ? "approved" : "rejected"} by dashboard:${by.id}.`,
    sender: by,
  };
}

/** The routes, in whichever App serves them; `mailbox` carries each decision to its conversation's actor. */
export function provideRoutes(pikit: Pikit): void {
  const auth = pikit.useOptional("admin.auth");
  const approvals = pikit.use("approvals");
  const mailbox = pikit.use("actor.mailbox");

  const route =
    (work: (request: Request, ctx: AppContext, operator: Operator) => Promise<Response>) =>
    async (request: Request, ctx: AppContext): Promise<Response> => {
      const operator = await auth.get()?.verify(request, ctx);
      if (operator === undefined) return json({ error: "unauthorized" }, 401);
      return work(request, ctx, operator);
    };

  pikit.provideKeyed(
    "http.route",
    `GET ${ROUTE}`,
    route(async (request, ctx) => {
      const params = new URL(request.url).searchParams;
      const limit = params.get("limit");
      try {
        return json(
          await approvals.get().list(
            {
              ...(params.get("status") !== null && { status: params.get("status") as ApprovalStatus }),
              ...(params.get("cursor") !== null && { cursor: params.get("cursor") as string }),
              ...(limit !== null && { limit: Number(limit) }),
            },
            ctx,
          ),
        );
      } catch (error) {
        // The store refuses a bad status, cursor or limit as `invalid`.
        if ((error as { code?: string }).code === "invalid") return json({ error: "invalid_request", message: (error as Error).message }, 400);
        throw error;
      }
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/decision`,
    route(async (request, ctx, operator) => {
      let id: string;
      try {
        id = decodeURIComponent(new URL(request.url).pathname.split("/")[4] ?? "");
      } catch {
        return json({ error: "not_found" }, 404);
      }
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
      let verdict: unknown;
      try {
        verdict = (JSON.parse(text) as { verdict?: unknown }).verdict;
      } catch {
        verdict = undefined;
      }
      if (verdict !== "approve" && verdict !== "reject") return json({ error: "invalid_request", message: 'the body is { "verdict": "approve" | "reject" }' }, 400);
      const by = { channel: "dashboard", id: operator.id };
      const outcome = await approvals.get().decide(id, { verdict, by }, ctx);
      if (!outcome.ok) return json({ error: outcome.code }, STATUS[outcome.code]);
      const { approval } = outcome;
      ctx.logger.info("admin-approvals: decided", { operator: operator.id, approval: approval.id, verdict });
      // Told once whatever the repeats (a decision recorded before a crash is told on the next click);
      // one decided in the chat was told there, by the answer itself.
      if (approval.decidedBy?.channel === "dashboard") {
        const told = decidedRequest(approval, verdict);
        await mailbox.get().send(told.conversation.key, DECIDED, told as unknown as JsonValue, ctx);
      }
      return json({ approval });
    }),
  );
}

export { worker } from "./worker.ts";

export default defineComponent({
  name: "admin-approvals",
  setup(pikit) {
    const runtime = pikit.use("agent.runtime");
    const inbox = pikit.use("actor.inbox");
    provideRoutes(pikit);
    return {
      start() {
        inbox.get().handle(DECIDED, async (key, message, ctx) => {
          const told = isJsonObject(message) ? message : {};
          const conversation = isJsonObject(told.conversation) ? told.conversation : undefined;
          // Only a decision for this key's own conversation, under the request id only this component makes.
          if (conversation?.key !== key || typeof told.requestId !== "string" || !told.requestId.startsWith(decidedRequestId(""))) {
            ctx.logger.warn("admin-approvals: a decision for another conversation was ignored", { key });
            return;
          }
          await runtime.get().dispatch(told as unknown as AgentRequest, ctx);
        });
      },
    };
  },
});
