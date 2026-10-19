/**
 * The agent Routing would choose for a user's new chat (`ChatMe.suggestedAgent`): a dry run of the
 * App's own `route.resolve` pipeline over the message a new chat's first one would be (`channel: "web"`,
 * the user its actor, the conversation `<user id>:<a new chat id>` as the backend builds it, no text).
 * Nothing is dispatched, no conversation is made or looked up, nothing is stored.
 *
 * It assumes `route.resolve`'s stages are side-effect free, as the kit's are: `router-basic` and
 * `router-rules` read their config and settings (and `agent.directory`) and decide; at most they log a
 * warning (settings that cannot be read, a rule naming an agent that is no agent now). A stage that
 * halts emits `pipeline.halted` (log-events logs it), as an admission would. A project stage that counts
 * or records what it routes counts this too.
 *
 * Where it runs: on a server, the App's own pipeline (the routes' default). On Cloudflare the Worker's
 * App has no router (the routers are the Durable Objects' App's): the Worker asks the accounts actor
 * (`channel-web.routed`, `calls.ts`), whose App is the conversations' and has their stages and settings.
 */

import { type AppContext, Halt } from "@pikit/core";
import type { InboundMessage } from "@pikit/contracts";
import { CHANNEL, newChatId, requestIdOf } from "./chat.ts";

/** The agent this App's `route.resolve` names for a new chat of `userId`; `undefined` when it denies, halts or no stage decides. */
export async function routedAgent(userId: string, ctx: AppContext): Promise<string | undefined> {
  const message: InboundMessage = { id: requestIdOf(undefined), channel: CHANNEL, conversationId: `${userId}:${newChatId()}`, actor: { id: userId }, text: "" };
  const routed = await ctx.run("route.resolve", { message });
  if (routed instanceof Halt) return undefined;
  const decision = routed.decision;
  return decision?.access === "allow" && decision.agent !== "" ? decision.agent : undefined;
}
