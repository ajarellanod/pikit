# channel-google-chat

Talk to your agents in Google Chat: spaces, group chats and DMs, through a Chat app of your own
([features/channel-google-chat.md](https://github.com/ajarellanod/pikit/blob/main/features/channel-google-chat.md)). Every answer goes to its message's thread; each thread is a
conversation by default, or a whole chat is one (a setting). "Thinking…" is written into the answer as
the model writes it; tables and code are drawn as cards, images as image cards; photos and files are
read; a quoted message is the reply's context; the agent's questions (`askUser`, tool-ask-user) are
asked with buttons, selects and dialogs.

> **Being built.** This is the component's skeleton: its wiring, config, secrets, setting, event
> types and test support are done; the modules marked "not implemented" in their header (ingress,
> admission, transport, questions) are being written. It is not usable yet.

- **Provides:** `http.route`: `POST /google-chat` (and `POST /google-chat/<name>` per named app), the
  app's endpoint.
- **Requires:** `secrets`, `conversations.registry`, `agent.runtime`, `agent.submissions`,
  `storage.kv`, `wakeups`. **Uses, if installed:** `outbound.queue` (answers stored before they are
  sent), `settings` (the `conversations` setting, editable from the dashboard), `workspace` or
  `execution` (where other files go), and on Cloudflare `actor.inbox` and `actor.mailbox`.
- **Targets:** `server` and `durable` (Cloudflare). One code on both: in `start`, `actor.inbox`'s
  `scope` says where it runs.
- **Installs to:** `src/pikit/channel-google-chat/`.
- **npm dependencies:** `typebox`.

## On each target

- **A server** (no `actor.inbox`, or scope `"all"`): the default export is everything. Its route
  verifies Google's token, keys the event, and hands it to the handler in process; answers go by the
  REST API. Run it with `server-bun`, `storage-sqlite`, `wakeups-timers`, `outbound-durable` (an answer
  survives a restart) and `workspace-local`. Google calls an HTTPS URL: `pikit expose` gives one.
- **Cloudflare** (scope `"one"`, each conversation's Durable Object): the Worker's half
  (`export const worker`, `channel-google-chat-worker`) serves the route and hands each event to its
  conversation's object through `actor.mailbox` (`google-chat.event`, sent; `google-chat.click`,
  called); the object admits, answers and draws.

## Secrets

Per app (`GOOGLE_CHAT_<NAME>_…` for a named one):

| Name | What |
|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | the app's service account JSON key, whole: the REST API is called as it |
| `GOOGLE_CHAT_PROJECT_NUMBER` | the app's Google Cloud project number: every event's token is signed by `service-<number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` |
| `GOOGLE_CHAT_AUDIENCE` | the endpoint URL exactly as the Chat API's configuration has it |
| `GOOGLE_CHAT_ALLOWED_SPACES` | the spaces answered (`spaces/AAA` or the id), separated by commas; any other is told its id |

## Config

```ts
"channel-google-chat": {
  instances: [],                                  // more Chat apps by name: ["ops"] runs googlechat:ops at /google-chat/ops
  conversations: { default: "thread", chats: {} }, // the setting's defaults: { "spaces/AAA": "chat" } makes that chat one conversation
  thinkingText: "Thinking…",
  previewEveryMs: 3000,                           // 0 keeps "Thinking…" until the answer
  apiBase: "https://chat.googleapis.com",         // values, for a test double
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
},
// On Cloudflare, the Worker's half (workerConfig): the same instances, conversations, apiBase and jwksUrl.
"channel-google-chat-worker": { instances: [], conversations: { default: "thread", chats: {} } },
```

## Tests

`channel-google-chat.test.ts`: the component composed on a server and in a Durable Object's shape,
its Worker's half, its secrets, keys and setting, the event parser, and the fake Google
(`fake-google-chat.test-support.ts`: the REST API, the token endpoint and the signing keys as a `fetch`
double and on a local port, ID tokens signed with a test key pair, event builders).
