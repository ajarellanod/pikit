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
 *
 * Everything that talks to Pi is in `@pikit/pi-adapter`, an npm dependency pinned with Pi: it
 * changes when Pi changes, and this file does not. What is here is the wiring, which is yours to
 * edit: which capabilities the runtime reads, and what it refuses to start without.
 *
 * Delivery: `dispatch` resolves once the message is durable in the conversation's session (the
 * point where a channel may acknowledge it); the answer arrives as `agent.settled`, also for a run
 * resumed after a crash. At-least-once: a crash can repeat an answer, never lose an accepted message.
 */

import { type AgentRuntime, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { createPiRuntime, type HarnessHook, modelsFrom, type PiExtension, type PiRuntime } from "@pikit/pi-adapter";

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
    setup(pikit) {
      const sessions = pikit.use("sessions.store");
      const agents = pikit.useKeyed("agent.definition");
      const providers = pikit.useKeyed("model.provider");
      const credentials = pikit.useOptional("model.credentials");
      const tools = pikit.useKeyed("agent.tool");
      const extensions = pikit.useKeyed("agent.extension");

      // Created in start, when the capabilities can be read; consumers start after this component.
      let runtime: PiRuntime | undefined;
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
          runtime = createPiRuntime({
            sessions: sessions.get(),
            agent: (name) => agents.get(name),
            tool: (name) => tools.get(name),
            extension: (name) => extensions.get(name),
            models,
            // Runs outlive the calls that admit them; never keep start's context (its deadline).
            events: ctx.derive(() => BACKGROUND_CONTEXT),
            ...(options.onHarness !== undefined && { onHarness: options.onHarness }),
            ...(options.extensions !== undefined && { extensions: options.extensions }),
          });
        },
        async stop(ctx) {
          // Runs in progress stay open in their sessions; the next process resumes them.
          const stopping = runtime;
          runtime = undefined;
          await stopping?.close(ctx);
        },
      };
    },
  });
}

export default createRuntimePi();
