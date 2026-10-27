/**
 * Who a conversation's call comes from, in tool-delegate's delegations: the depth and the chain its
 * `delegate:` key says (`depthOf`, `chainOf`), and the agents above it and its own, checked against
 * the origin the runtime fixed (`callersOf`). Only tool-delegate writes `delegate:` keys.
 *
 * The same file in tool-delegate and tool-notify (components never import each other, C6); the
 * registry's `tool-notify/twins.test.ts` keeps the two identical.
 */

import { type ConversationRef, originOf } from "@pikit/contracts";

/** The prefix of a delegated task's conversation key, which tool-delegate makes and reads. */
export const DELEGATE_KEY_PREFIX = "delegate:";

/** The separator of a key's chain: agent names are kebab-case, so never hold it (nor a `:`). */
export const CHAIN_SEPARATOR = ".";
/** An agent's name as `defineAgent` takes it; a key's chain holds only such names. */
const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** How deep a conversation is in delegations: 0 for one a person (or a channel) started. */
export function depthOf(key: string): number {
  if (!key.startsWith(DELEGATE_KEY_PREFIX)) return 0;
  const depth = Number(key.slice(DELEGATE_KEY_PREFIX.length).split(":", 1)[0]);
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * The agents above a conversation in its delegation, root first, as its key says: `[]` for one not
 * delegated (its key is not `delegate:`), `undefined` for a `delegate:` key that does not say them
 * (malformed, or a chain written empty because it could not be trusted). As many as its depth.
 */
export function chainOf(key: string): string[] | undefined {
  if (!key.startsWith(DELEGATE_KEY_PREFIX)) return [];
  const rest = key.slice(DELEGATE_KEY_PREFIX.length);
  const first = rest.indexOf(":");
  const second = first < 0 ? -1 : rest.indexOf(":", first + 1);
  // The task id after the chain: a key without one is not tool-delegate's.
  if (second < 0 || second === rest.length - 1) return undefined;
  const chain = rest.slice(first + 1, second).split(CHAIN_SEPARATOR);
  return chain.every((agent) => AGENT_NAME.test(agent)) && chain.length === depthOf(key) ? chain : undefined;
}

/**
 * The agents a call in `conversation` comes from, root first: those above it and its own, or
 * `undefined` when they cannot be trusted. Above it is its key's chain, which only tool-delegate
 * writes, and whose first agent must be its origin's (the runtime fixes the origin, never a ref or the
 * model). A conversation not delegated is its own root, with no origin.
 */
export function callersOf(conversation: ConversationRef): string[] | undefined {
  if (!AGENT_NAME.test(conversation.agent)) return undefined;
  // Not tool-delegate's key but delegated (an origin): who is above it is unknown.
  if (!conversation.key.startsWith(DELEGATE_KEY_PREFIX)) return conversation.origin === undefined ? [conversation.agent] : undefined;
  const chain = chainOf(conversation.key);
  if (chain === undefined || conversation.origin === undefined || chain[0] !== originOf(conversation).agent) return undefined;
  return [...chain, conversation.agent];
}
