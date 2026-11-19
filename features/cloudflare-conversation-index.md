# A conversation index on Cloudflare (superseded)

**Public appeal:** —

**Specified:** yes, for the dashboard (SPEC §5; moved from the former SPEC §16)

**Superseded** by the [conversation directory](completed/conversation-directory.md)
(`conversations.directory`, conversations-directory): its actor `conversations-directory:index` lists
every conversation on Cloudflare as `admin-api:index` did, filled off the message's path from each
object's outbox. admin-api's index (`conversation-index.ts`, `admin_api_conversations`,
`admin-api.seen`, `admin-api.list`) is removed. Its open question, pending work across objects
(`agent.submissions.pending()` is per object), is in [kit follow-ups](kit-follow-ups.md).

What it decided stays the directory's: an actor of the conversations' own class, not D1 (a component
cannot add a wrangler binding); one object takes every update (fine for teams, not a global query
engine); events can be missed (K3), repaired at the next activity or the object's next start.

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Where the conversation registry lives on Cloudflare when a *global* view is needed (list
  all conversations): D1 index vs per-DO only. Answered: per-DO, and an index actor (above).
