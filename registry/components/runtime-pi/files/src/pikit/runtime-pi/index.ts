/**
 * runtime-pi: the agent runtime (SPEC §6). Pi runs the agent; this component wires it into the app.
 *
 * It provides `agent.runtime` and uses:
 * - `sessions.store`: where each conversation's Pi session lives;
 * - `agent.definition`: your agents, one per name (a project component provides them);
 * - `model.provider`: the model providers your agents name as `provider/modelId`;
 * - `agent.tool`: the installed tools (`tool-*` components) that agents name in their `tools`;
 * - `agent.extension`: the installed Pi extensions that agents name in their `extensions`;
 * - `model.credentials`, if installed: where the providers' credentials live. Without it, providers
 *   read only their environment variables (`ANTHROPIC_API_KEY`).
 * - `agent.submissions`, if installed (`submissions-sql`): where each admitted message and each run's
 *   end are recorded. At start, the conversations holding a message nobody answered are resumed in the
 *   background (`resume.ts`), with no new message needed; channels deliver answers from its feed.
 *   Messages that can never be answered are abandoned, and their senders told: at once when their
 *   agent or session is gone, and after `abandonPendingAfterHours` when resuming did not answer them.
 *
 * Everything that talks to Pi is in `@pikit/pi-adapter`, an npm dependency pinned with Pi: it
 * changes when Pi changes, and this file does not. What is here is the wiring, which is yours to
 * edit: which capabilities the runtime reads, and what it refuses to start without.
 *
 * Delivery: `dispatch` resolves once the message is durable in the conversation's session, and in
 * `agent.submissions` when installed (the point where a channel may acknowledge it); the answer
 * arrives as `agent.settled`, also for a run resumed after a crash. At-least-once: a crash can repeat
 * an answer, never lose an accepted message. Without `agent.submissions`, a crash leaves a run for the
 * next message to that conversation to resume, and an answer that ends while its channel is stopped
 * reaches nobody but the session.
 */

import { BACKGROUND_CONTEXT, defineComponent, withAbortSignal } from "@pikit/core";
import { type AgentRuntime } from "@pikit/contracts";
import { createPiRuntime, type HarnessHook, modelsFrom, type PiExtension, type PiRuntime } from "@pikit/pi-adapter";
import Type from "typebox";
import { resumePending } from "./resume.ts";

const Config = Type.Object({
  /**
   * With `agent.submissions`: how long, in hours, a conversation's oldest pending message may wait
   * before the ones still unanswered after resuming it at start are abandoned (their channel tells the
   * user to send them again) instead of being retried at every start. At least 1: a message must
   * survive a deploy and the run that answers it.
   */
  abandonPendingAfterHours: Type.Integer({
    minimum: 1,
    default: 72,
    description: "Hours after which messages still unanswered at start are abandoned, and their senders told. At least 1.",
  }),
});

export interface RuntimePiOptions {
  /**
   * Pi extensions, unmodified, for every agent: `createRuntimePi({ extensions: [permissionGate] })`
   * in `pikit.config.ts`. Each conversation loads them when it opens, as Pi loads them per session,
   * then the extensions its agent names (`agent.extension`). There is no terminal UI: `ctx.hasUI` is
   * false and `ctx.ui.*` does nothing (SPEC §6.2b).
   */
  extensions?: readonly PiExtension[];
  /** Attach Pi hooks to each conversation's harness when it opens (tests). */
  onHarness?: HarnessHook;
}

export function createRuntimePi(options: RuntimePiOptions = {}) {
  return defineComponent({
    name: "runtime-pi",
    config: Config,
    setup(pikit, config) {
      const sessions = pikit.use("sessions.store");
      const agents = pikit.useKeyed("agent.definition");
      const providers = pikit.useKeyed("model.provider");
      const credentials = pikit.useOptional("model.credentials");
      const tools = pikit.useKeyed("agent.tool");
      const extensions = pikit.useKeyed("agent.extension");
      // Optional: with it, admitted messages and run ends are recorded, and resumed at start.
      const submissions = pikit.useOptional("agent.submissions");

      // Created in start, when the capabilities can be read; consumers start after this component.
      let runtime: PiRuntime | undefined;
      /** The resumption started by `start`, which `stop` cancels and waits for. */
      let resuming: { controller: AbortController; done: Promise<void> } | undefined;
      const current = (): PiRuntime => {
        if (runtime === undefined) throw new Error("runtime-pi: agent.runtime used while the app is not running");
        return runtime;
      };
      const agentRuntime: AgentRuntime = {
        dispatch: (request, ctx) => current().dispatch(request, ctx),
        abort: (conversation, ctx) => current().abort(conversation, ctx),
        resume: (conversation, ctx) => current().resume(conversation, ctx),
      };
      pikit.provide("agent.runtime", agentRuntime);

      return {
        async start(ctx) {
          const models = modelsFrom(
            providers.keys().flatMap((key) => providers.get(key) ?? []),
            { credentials: credentials.get() },
          );
          // Fail at start, not at the first message: an agent that cannot run is a broken deployment.
          if (agents.keys().length === 0) throw new Error("runtime-pi: no agent.definition is provided");
          for (const key of tools.keys()) {
            const tool = tools.get(key);
            if (tool !== undefined && tool.name !== key) {
              throw new Error(`runtime-pi: the agent.tool "${key}" is a tool named "${tool.name}"; a tool is provided under its own name`);
            }
          }
          for (const name of agents.keys()) {
            for (const tool of agents.get(name)?.tools ?? []) {
              if (typeof tool === "string" && tools.get(tool) === undefined) {
                throw new Error(`runtime-pi: agent "${name}" names the tool "${tool}", which no agent.tool provides (install tool-${tool}?)`);
              }
            }
            for (const extension of agents.get(name)?.extensions ?? []) {
              if (extensions.get(extension) === undefined) {
                throw new Error(`runtime-pi: agent "${name}" names the extension "${extension}", which no agent.extension provides`);
              }
            }
            const model = agents.get(name)?.model ?? "";
            const slash = model.indexOf("/");
            if (models.getModel(model.slice(0, slash), model.slice(slash + 1)) === undefined) {
              throw new Error(`runtime-pi: agent "${name}" names model "${model}", which no model.provider provides`);
            }
            // Checked without a network call or an OAuth refresh: is anything configured at all?
            const provider = model.slice(0, slash);
            if ((await models.checkAuth(provider, ctx.abortSignal ? { signal: ctx.abortSignal } : {})) === undefined) {
              throw new Error(
                `runtime-pi: agent "${name}" uses provider "${provider}", which has no credentials: ` +
                  "log in to store one in model.credentials, or set the provider's API key in the environment",
              );
            }
          }
          const recorded = submissions.get();
          // Runs outlive the calls that admit them; never keep start's context (its deadline).
          const background = ctx.derive(() => BACKGROUND_CONTEXT);
          const created = createPiRuntime({
            sessions: sessions.get(),
            agent: (name) => agents.get(name),
            tool: (name) => tools.get(name),
            extension: (name) => extensions.get(name),
            models,
            events: background,
            ...(options.onHarness !== undefined && { onHarness: options.onHarness }),
            ...(options.extensions !== undefined && { extensions: options.extensions }),
            ...(recorded !== undefined && { submissions: recorded }),
          });
          runtime = created;
          if (recorded !== undefined) {
            // In the background: start does not wait for runs to resume, and stop cancels it.
            const controller = new AbortController();
            const done = resumePending(created, recorded, background.derive((inner) => withAbortSignal(controller.signal, inner)), {
              abandonAfterMs: config.abandonPendingAfterHours * 60 * 60 * 1_000,
            });
            resuming = { controller, done };
          }
        },
        async stop(ctx) {
          // Runs in progress stay open in their sessions; the next process resumes them.
          const stopping = runtime;
          runtime = undefined;
          const resumed = resuming;
          resuming = undefined;
          resumed?.controller.abort(new Error("runtime-pi: stopping"));
          await stopping?.close(ctx);
          // Settles once `close` ended the conversations it opened; bounded by the stop deadline all the same.
          if (resumed !== undefined) await Promise.race([resumed.done, aborted(ctx.abortSignal)]);
        },
      };
    },
  });
}

/** Resolves when `signal` aborts; never, without one. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export default createRuntimePi();
