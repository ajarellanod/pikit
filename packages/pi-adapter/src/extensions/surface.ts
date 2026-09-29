/**
 * The Pi events pikit fires to extensions: the events of tier A, the surface pikit promises.
 * An extension may register any other event, and it never fires.
 *
 * Data only, with no imports: `pikit doctor` needs the same list and must not load the adapter, so
 * the CLI keeps a generated copy (`packages/cli/src/project/pi-extension-surface.ts`, written by
 * `bun scripts/pi-extension-surface.ts`), and `scripts/pi-extension-surface.test.ts` fails when the
 * two differ, or when this list and the `on(...)` overloads of `ExtensionAPI` in `api.ts` differ.
 */
export const SUPPORTED_EVENTS = [
  "session_start",
  "session_shutdown",
  "context",
  "before_provider_request",
  "after_provider_response",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
] as const;
