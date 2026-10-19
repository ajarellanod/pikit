/**
 * extension-approvals: the tools in config run only with a person's approval of that exact call, for
 * the agents that name the extension (`extensions: ["approvals"]`). The approval is recorded by code
 * (`approvals`, `contract.ts`), never by the model reading "approved".
 *
 * 1. **`request_approval`** (`{ tool, args, title, reason }`, for a tool in config only) proposes the
 *    action `{ type: "tool:<name>", payload: args }`, idempotent by `<conversation>:<call>` (so
 *    `replay: "safe"`), and ends the run with a `question` part (`approval:<id>`, one `confirm` field),
 *    as `askUser` does. A channel draws it or sends its fallback.
 * 2. **The answer** comes back as a message whose text is `answerText`'s (Google Chat's buttons write
 *    it; elsewhere the person types it, as the question says). A stage of `inbound.normalize` reads it
 *    before the model does and records the decision as the channel authenticated the sender
 *    (`<channel>:<actor id>`); whether that sender may decide is the store's check against the
 *    approvers. A note of what was recorded is added to the text. A redelivered answer records nothing
 *    twice (the store answers the same verdict as it was). A store that cannot be reached throws, so the
 *    channel does not acknowledge and the platform delivers the message again.
 * 3. **`beforeTool`** on the tools in config claims an approval of that exact call (hash of its name and
 *    arguments as they will run) from this conversation, for this tool task (`<conversation>:<task>`).
 *    pi-durable runs the hook again when the task recovers before its intent was committed: the same
 *    claimant gets the same approval, so it is safe. Without one, the call is blocked and the model is
 *    told to ask with exactly these arguments. A store that fails blocks (a hook that throws blocks).
 * 4. **`afterTool`** settles it: `executed`, or `failed` with the error's first line.
 *
 * Name it last among extensions whose hooks block or rewrite calls: a later hook that blocks or
 * rewrites a call this one claimed leaves the approval claimed and unexecuted.
 *
 * Targets: `server` (as approvals-sql); it imports nothing platform-specific.
 */

import { type AppContext, BACKGROUND_CONTEXT, type Context, defineComponent } from "@pikit/core";
import { answerText, CONVERSATION, type JsonValue, type Question, questionPart, RUN_REQUESTS } from "@pikit/contracts";
import { defineExtension, defineTool, type Extension, hook, ToolTask } from "@pikit/pi-adapter/extensions";
import { type ToolExecutionResult, withParts } from "@pikit/pi-adapter/tools";
import Type, { type Static } from "typebox";
import { type ApprovalAction, type ApprovalStore, actionHash, canonicalJson, type DecideOutcome } from "./contract.ts";

/** The name agents give it, and its key under `agent.extension`. */
export const APPROVALS_EXTENSION = "approvals";
export const REQUEST_APPROVAL = "request_approval";
/** A question's id for an approval: `approval:<id>`. */
export const QUESTION_PREFIX = "approval:";

const Config = Type.Object({
  /** Tools that run only with a person's approval of that exact call. */
  tools: Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }), { default: [] }),
  /** Who may approve: `<channel>:<id>` as the channel authenticated them, or `<channel>:*` (`dashboard:*`: any operator). */
  approvers: Type.Array(Type.String({ pattern: "^[^:\\s]+:\\S+$" }), { default: [] }),
  /** How long an approval may be decided and used, in ms. */
  expiresInMs: Type.Integer({ minimum: 60_000, default: 86_400_000 }),
});

export type ApprovalsConfig = Static<typeof Config>;

/** The action a call of `tool` with `args` is. */
export const toolAction = (tool: string, args: JsonValue): ApprovalAction => ({ type: `tool:${tool}`, payload: args });

/** The question that asks for approval `id`: one `confirm` field. */
export function approvalQuestion(id: string, title: string, description: string): Question {
  return { id: `${QUESTION_PREFIX}${id}`, title, description, fields: [{ kind: "confirm", name: "approve", label: "Approve", required: true }] };
}

/** An answer to an approval question, in `answerText`'s words: the approval's id and the verdict, or `undefined`. */
export function parseAnswer(text: string): { id: string; verdict: "approve" | "reject" } | undefined {
  // The last `(question approval:<id>):` line and the one field after it: a title cannot fake another id.
  const match = /^Answer to "[\s\S]*" \(question approval:([^\s)]+)\):\n- [^\n]*: (yes|no)$/.exec(text.replace(/\r\n/g, "\n").trim());
  if (match === null) return undefined;
  return { id: match[1] as string, verdict: match[2] === "yes" ? "approve" : "reject" };
}

/** What the model reads after an answer, said by code. */
export function decisionNote(id: string, by: string, outcome: DecideOutcome): string {
  if (outcome.ok) return `[approvals] Recorded: approval ${id} is ${outcome.approval.status}, decided by ${outcome.approval.decidedBy?.channel}:${outcome.approval.decidedBy?.id}.`;
  const why = {
    forbidden: `${by} may not decide approval ${id}`,
    not_found: `there is no approval ${id}`,
    not_pending: `approval ${id} was already decided otherwise`,
    expired: `approval ${id} has expired`,
  }[outcome.code];
  return `[approvals] Not recorded: ${why}.`;
}

export function createApprovals(config: ApprovalsConfig, store: () => ApprovalStore, within: (context: Context) => AppContext): Extension {
  const gated = new Set(config.tools);
  const listed = config.tools.join(", ") || "none";
  const claimant = (api: { conversationId: unknown; taskId: unknown }) => `${String(api.conversationId)}:${String(api.taskId)}`;

  const requestApproval = defineTool({
    name: REQUEST_APPROVAL,
    description: [
      `Asks a person to approve one call of a tool that needs approval here (${listed}), with exactly the arguments you will call it with, and ends your turn.`,
      "Their answer arrives later as a new message. Once approved, call the tool with exactly the same arguments: it runs once; any other call is refused.",
    ].join("\n"),
    parameters: Type.Object({
      tool: Type.String({ description: "The tool to call." }),
      args: Type.Record(Type.String(), Type.Unknown(), { description: "The exact arguments you will call it with." }),
      title: Type.String({ minLength: 1, maxLength: 200, description: "What it does, in one line, for the person." }),
      reason: Type.String({ minLength: 1, maxLength: 2000, description: "Why it is needed." }),
    }),
    // Safe to run again: the proposal is idempotent by this call's id, and the part is the same.
    replay: "safe",
    async execute(args, api, context) {
      if (!gated.has(args.tool)) throw new Error(`"${args.tool}" needs no approval here; only these do: ${listed}`);
      const conversation = context.value(CONVERSATION);
      if (conversation === undefined) throw new Error("request_approval: not in a conversation");
      const ctx = within(context);
      const sender = (await context.value(RUN_REQUESTS)?.list(context))?.[0]?.sender;
      const action = toolAction(args.tool, args.args as JsonValue);
      const approval = await store().propose(
        {
          idempotencyKey: `${conversation.conversationId}:${api.callId}`,
          action,
          title: args.title,
          summary: args.reason,
          approvers: config.approvers,
          requestedBy: { conversation, ...(sender !== undefined && { sender }) },
          expiresAt: ctx.clock.now() + config.expiresInMs,
        },
        ctx,
      );
      const exact = canonicalJson(approval.action.payload);
      const asked = approvalQuestion(approval.id, approval.title, "");
      const description = [
        approval.summary ?? "",
        "",
        `Action: ${args.tool} ${exact}`,
        ...(approval.expiresAt === undefined ? [] : [`Expires: ${new Date(approval.expiresAt).toISOString()}`]),
        "",
        "To answer in a message, send these two lines, with yes to approve or no to reject:",
        answerText(asked, { approve: true }),
      ].join("\n");
      const output = `Asked for approval ${approval.id}. Your turn ends here. Once approved, call ${args.tool} with exactly ${exact}; until then it is refused.`;
      return withParts({ output: [{ type: "text", text: output }], control: { terminate: true } }, [questionPart({ ...asked, description })]);
    },
  });

  return defineExtension({
    name: APPROVALS_EXTENSION,
    tools: [requestApproval],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (!gated.has(call.name)) return undefined;
          const hash = await actionHash(toolAction(call.name, call.arguments as JsonValue));
          const claimed = await store().claim({ actionHash: hash, conversationId: String(api.conversationId), claimant: claimant(api) }, within(context));
          if (claimed !== undefined) return undefined;
          return {
            block: `"${call.name}" needs a person's approval of this exact call. Call ${REQUEST_APPROVAL} with tool "${call.name}" and args ${canonicalJson(call.arguments as JsonValue)}, then call it again once approved.`,
          };
        },
        afterTool: async (call, result, api, context) => {
          if (!gated.has(call.name)) return undefined;
          await store().settle(claimant(api), result.isError === true ? { kind: "failed", detail: firstLine(result) } : { kind: "executed" }, within(context));
          return undefined;
        },
      }),
    ],
  });
}

const firstLine = (result: ToolExecutionResult): string => {
  const text = result.output?.find((part) => part.type === "text");
  return (text?.type === "text" ? text.text : "").split("\n")[0]?.slice(0, 500) ?? "";
};

export default defineComponent({
  name: "extension-approvals",
  config: Config,
  setup(pikit, config) {
    if (config.tools.length > 0 && config.approvers.length === 0) throw new Error("extension-approvals: tools need approvers (<channel>:<id> or <channel>:*) who may approve them");
    const approvals = pikit.use("approvals");
    let app: AppContext | undefined;
    const within = (context: Context): AppContext => {
      if (app === undefined) throw new Error("extension-approvals: used while the App is not running");
      return app.derive(() => context);
    };

    pikit.provideKeyed("agent.extension", APPROVALS_EXTENSION, createApprovals(config, () => approvals.get(), within));

    // An answer to an approval question is recorded before the model reads it, as the channel authenticated its sender.
    pikit.pipeline(
      "inbound.normalize",
      async (message, ctx) => {
        const answer = parseAnswer(message.text);
        if (answer === undefined) return message;
        const by = { channel: message.channel, id: message.actor.id };
        const outcome = await approvals.get().decide(answer.id, { verdict: answer.verdict, by }, ctx);
        ctx.logger.info("extension-approvals: an answer to an approval", { approval: answer.id, verdict: answer.verdict, by: `${by.channel}:${by.id}`, outcome: outcome.ok ? "recorded" : outcome.code });
        return { ...message, text: `${message.text}\n\n${decisionNote(answer.id, `${by.channel}:${by.id}`, outcome)}` };
      },
      { id: "extension-approvals" },
    );

    return {
      start(ctx) {
        app = ctx.derive(() => BACKGROUND_CONTEXT);
      },
      stop() {
        app = undefined;
      },
    };
  },
});
