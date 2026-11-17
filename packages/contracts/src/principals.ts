/**
 * `principals`: the person behind a channel's identity (features/projects.md, "People and
 * collaboration"). A person may be known to an App under several principals (`{ channel, id }`): a web
 * user, a Google Chat user, a Telegram account. Membership of a project is held by principal; a caller
 * holding several principals is the same person, and the owner's role wins.
 *
 *   const principals = pikit.useOptional("principals");
 *   const mine = principals.has() ? await principals.get().of({ channel: "web", id: user }, ctx) : [{ channel: "web", id: user }];
 *
 * Optional for its users: absent, a principal is only itself (a person's web account and their Google
 * Chat identity are two people), and a member is named only by what the channel itself can name (an
 * existing web user's email, in the kit).
 *
 * What every provider guarantees:
 * - **`of(principal)` starts with `principal` itself**, then the other identities its directory links
 *   to the same person by a verified email, each once, the same answer for any of them (a person's set
 *   is one set). An identity the directory does not know is `[principal]`, never an error.
 * - **`find(email)` names only people the directory knows**, by a verified email: `[]` for any other
 *   address (never a principal made up from it). An invitation never reaches an address from outside.
 * - **Read when asked**: a link added or removed applies to the next call of every App, within the
 *   provider's bound (a minute at most). Answers are copies.
 * - Nothing it answers is a secret; it never says why an email is unknown.
 *
 * Users: channel-web (a session's principals, a member named by email), memory-recall (a sender's
 * principals for `/rules` in a project's space), projects-sql's routes (the dashboard naming a member).
 * Provider: none in the kit (rule 1: it comes with its first user's directory); neural-agents' people
 * directory provides it. One provider: `experimental`.
 */

import type { AppContext } from "@pikit/core";
import type { Principal } from "./change.ts";

/** The `principals` capability. */
export interface Principals {
  /** `principal` first, then the other identities of the same person; `[principal]` for one the directory does not know. */
  of(principal: Principal, ctx: AppContext): Promise<Principal[]>;
  /** The identities of the person a verified `email` names, the directory's preferred first; `[]` for an address it does not know. */
  find(email: string, ctx: AppContext): Promise<Principal[]>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    principals: Principals;
  }
}
