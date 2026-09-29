# Multi-tenant isolation

**Public appeal:** —

**Specified:** partly (moved from the former SPEC §16; `tenant` was `[planned]` in `InboundMessage`
and `RouteDecision` in the former §5)

**Needed by:** nothing required.

## What it gives
One pikit serving several clients (tenants) whose conversations, data, tools and secrets cannot
reach each other: the agency case of IDEA.md.

## How it fits pikit
- Routing is not isolation. Today every conversation of an app shares one process, one
  `storage.sql` database and one `execution`.
- `tenant` enters `InboundMessage` and `RouteDecision` with the component that produces it, and the
  conversation key (`tenant:channel:conversationId`, `ConversationRef.key` in
  `packages/contracts/src/agent.ts`).
- A `tenant-isolation` component maps tenants to separate Durable Object namespaces or database
  files; execution per tenant is [sandboxed execution](sandboxed-execution.md); secrets per tenant
  are a `secrets` provider's.
- What it guarantees is documented as precisely as `execution-local`'s "not a sandbox".
- Absent: one tenant, as today.

## Pi first
Nothing in Pi: tenants are a property of the service around it.

## Open questions
- Isolation by process (one app per tenant) versus inside one app; which one the kit recommends.
- Its kind prefix, and whether it needs a contract or only selection per tenant.

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Multi-tenant isolation guarantees: routing is not isolation. Document clearly; consider a
  `tenant-isolation` component that maps tenants to separate DO namespaces / DB files.
