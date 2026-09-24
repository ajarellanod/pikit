/**
 * Pi's exact types for the core's opaque agent payloads and for the capabilities whose contract is
 * Pi's own (SPEC §6.1, "Who owns these types"). Importing `@pikit/pi-adapter` anywhere in a project
 * makes them precise everywhere, by declaration merging, as `AppEvents` is extended.
 */

import type { AgentHarnessTool, AgentMessage, SessionRepo } from "@earendil-works/pi-agent-core";
import type { CredentialStore, Provider, Usage } from "@earendil-works/pi-ai";

/**
 * Any `SessionRepo`: JSONL, memory, SQLite. Their metadata and options differ; the adapter only
 * lists, opens and creates, so it accepts them all.
 */
// biome-ignore lint/suspicious/noExplicitAny: the repo's metadata type is the store's own
export type SessionStore = SessionRepo<any, any, any>;

declare module "@pikit/core" {
  interface AgentPayloads {
    message: AgentMessage;
    // The tool context (Pi's own tools take `{ env }`) is decided with the tool-* components (§6.3).
    // biome-ignore lint/suspicious/noExplicitAny: see above
    tool: AgentHarnessTool<any>;
    usage: Usage;
  }
  interface AppCapabilities {
    /** Pi's `SessionRepo` (SPEC §7.5): where conversations' sessions live. */
    "sessions.store": SessionStore;
    /**
     * pi-ai's `CredentialStore`: the credentials the model providers use, stored per provider id.
     * Tokens that Pi refreshes are written back through it. Without it, providers read only their
     * environment variables (`ANTHROPIC_API_KEY`).
     */
    "model.credentials": CredentialStore;
  }
  interface AppKeyedCapabilities {
    /** One pi-ai model provider per key (its id): `anthropic`, `openai`, `faux` in tests. */
    "model.provider": Provider;
  }
}
