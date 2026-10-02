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
- `tenant` enters `InboundMessage` and `RouteDecision` with the component that produces it. The
  conversation key has no tenant part today: `ConversationRef.key`
  (`packages/contracts/src/agent.ts`) is an opaque address its channel makes and alone reads back
  (`<instance>:<chat id>`). Nothing rewrites a key ([conversation routing](conversation-routing.md)):
  a tenant reaches it through the channel's instance (`telegram:acme:12345`), which the channel
  builds and reads back itself, so answers still reach their chat on a server and on Cloudflare.
- A `tenant-isolation` component maps tenants to separate Durable Object namespaces or database
  files; execution per tenant is [sandboxed execution](sandboxed-execution.md); secrets per tenant
  are a `secrets` provider's.
- What it guarantees is documented as precisely as `execution-local`'s "not a sandbox".
- Absent: one tenant, as today.

## Pi first
Nothing in Pi: tenants are a property of the service around it.

But pi-durable weighs on it: a caller's context values (the tenant a message belongs to, a trace
id) no longer reach tools, since a run is durable tasks the scheduler starts with its own context
(`packages/pi-adapter/src/README.md`). Isolation needs every tool call to know its tenant
without trusting the model, durably across restarts. Meanwhile a tenant fixed per conversation can
live in a conversation document that tools read; per-message values cannot. The ask is durable
submission attributes ([upstream proposal 3](../docs/upstream/README.md#3-caller-context-values-reach-tools)),
which this feature should wait for or design around.

## Open questions
- Isolation by process (one app per tenant) versus inside one app; which one the kit recommends.
- Its kind prefix, and whether it needs a contract or only selection per tenant.

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Multi-tenant isolation guarantees: routing is not isolation. Document clearly; consider a
  `tenant-isolation` component that maps tenants to separate DO namespaces / DB files.
