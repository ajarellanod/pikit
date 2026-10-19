# credentials-do

The model providers' credentials on Cloudflare: API keys and subscription logins (OAuth tokens, a
Claude Pro/Max or ChatGPT login) alike, kept by one Durable Object that every conversation asks. An
expiring token is refreshed once, under that object's lock, and every conversation gets the new one.
On a server, `credentials-file` keeps them in a file.

- **Provides:** `model.credentials` (pi-ai's `CredentialStore`) to every object's App; the Worker's
  half provides `http.route`: the operator's routes below.
- **Requires:** `storage.sql` (the credentials, in one object: storage-do), `actor.inbox` and
  `actor.mailbox` (actors-do). The Worker's half requires `actor.mailbox`; **uses, if installed,**
  `admin.auth` (who is an operator; without it, its routes answer nobody).
- **Targets:** `durable`.
- **Installs to:** `src/pikit/credentials-do/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

```sh
pikit add credentials-do
pikit up                                  # the routes must be deployed before a login is uploaded
pikit configure --login anthropic         # log in on this machine; the tokens go to the deployed app
```

`pikit add` puts the default export in the objects' App and the Worker's half
(`credentials-do-worker`) in the Worker's.

**Check your subscription's terms first.** A subscription login lets a deployed bot answer with your
personal plan (Claude Pro/Max, ChatGPT Plus/Pro). Whether a provider allows a plan to serve a bot,
other people or automated traffic is its terms' to say, and they change: read them for each
subscription before you log in here. An API key is the provider's way for a deployed app.

## How it works

- **One copy, one object.** The credentials are one object's, `credentials-do` (of the
  conversations' class, never a conversation), in its SQLite. Each conversation's object reads them
  with a call (`actor.mailbox`) before each model request; nothing is copied into a conversation.
- **One refresh at a time, from the latest tokens.** pi-ai refreshes an OAuth token inside the
  store's `modify`, which runs under the owner object's lock for that provider: the conversation
  that finds the token expiring first takes the lock, refreshes with pi-ai's own flow and writes
  the new tokens back; the others, which found it expiring meanwhile, wait for the lock and get the
  new tokens, so nothing is refreshed twice. Refresh tokens rotate: two refreshes at once would
  leave one of them with a revoked token. A lock whose holder died is free again after 30 s.
- **A failed refresh is reported, never looped.** The run that needed it fails with pi-ai's error;
  the conversations waiting behind it are refused at once, and for `retryAfterMs` (a minute) no
  conversation asks the provider again. Then one may try. A new login ends it at once. The stored
  login stays as it was: log in again when the provider revoked it.
- **The OAuth flows bundled.** pi-ai loads each provider's OAuth flow (refresh, and turning tokens
  into a request's auth) with an import no bundler follows, which a Worker cannot resolve. `start`
  registers every flow statically (`bundleOAuthFlows`, `@pikit/pi-adapter/oauth-flows`): the Worker's
  bundle carries them.
- **Logged in from your machine.** `pikit configure --login <provider>` runs pi-ai's login on your
  machine (the code login by default: open a URL, paste the code the page shows; `--login-method
  browser` works too, its callback is on your machine), then uploads the credential to
  `PUT /admin/api/credentials-do/<provider>` of the deployed Worker (the URL `pikit up` recorded),
  with `PIKIT_ADMIN_TOKEN` from `.env`. Nothing of it is kept on your machine. `pikit dev` (wrangler
  dev) has objects of its own: it uses API keys.

Why the conversations refresh, under the owner's lock, rather than the owner itself: refreshing
takes the provider (`model.provider`), and a component that uses the providers cannot provide
`model.credentials`, which a provider uses (provider-failover): the App would not compose.

## API

Every route asks `admin.auth` first (`401` otherwise, before anything else). JSON; an error is
`{ error, message? }`. No route ever answers a credential: an operator replaces or deletes one, never
reads it back.

| Route | Answers |
|---|---|
| `GET /admin/api/credentials-do` | `{ credentials: [{ providerId, type }] }`: what is stored, `api_key` or `oauth` |
| `PUT /admin/api/credentials-do/<providerId>` | the body is pi-ai's `Credential`, `{ "type": "oauth", "access", "refresh", "expires", … }` or `{ "type": "api_key", "key" }` → `{ providerId, type }`; `400 invalid_request` for anything else |
| `DELETE /admin/api/credentials-do/<providerId>` | `{ deleted }` |

```sh
curl -H "Authorization: Bearer $PIKIT_ADMIN_TOKEN" https://<worker>/admin/api/credentials-do
```

## Configure

```ts
"credentials-do": {
  retryAfterMs: 60000, // default: after a failed OAuth refresh, how long no conversation tries again
}
```

The Worker's half (`credentials-do-worker`) has no config.

## Security

- **Operators only.** The routes ask `admin.auth`; the owner object is reached only by the app's own
  components (`actor.mailbox`), which use `model.credentials` as they would on a server.
- **Never logged, never answered.** No log line, error or route answer holds a credential; a refused
  upload says what is wrong with its shape, never what it held. The list holds provider ids and types.
- **At rest.** In the clear in the owner object's SQLite, as credentials-file keeps them in a `0600`
  file and Pi in `auth.json`: only the Worker's code reads a Durable Object's storage.
- **The lock is the owner's memory.** A deploy restarts every object: a refresh in flight then may
  meet another, and one of them fails (log in again if the provider revoked the token).

## Guarantees

`credentials-do.test.ts`, with a double of the objects (each App is one object, a call reaches the
App of its key) and pi-ai's own Anthropic flow against a local fake of the token endpoint
(`Bun.serve`):
- the `model.credentials` suite (`createCredentialStoreConformance`) from a conversation's object,
  across an owner restart;
- an expired token found by six requests in three conversations at once: one refresh, with the
  stored refresh token; every request gets the new access token; the rotated tokens stored;
- a refused refresh: reported to the three runs waiting for it, with one request to the provider;
  none during the cooldown; one after it; a new upload ends it; the stored login unchanged;
- a lock whose holder died: free after 30 s, its late release refused; an upload during a refresh
  waits for it and wins;
- the routes: upload, list, delete for an operator; `401` for anyone else (and for everyone without
  `admin.auth`) before the owner is asked; a bad body refused without echoing it; no secret in any
  answer, error or log line.

In the pikit repository, the workerd lane (`tests/workerd/test/credentials-do.workerd.ts`) runs a
conversation's object and the owner object as real Durable Objects, uploads a login through
deployment-cloudflare's server, and an agent answers after the token was refreshed against a fake
OAuth endpoint; `packages/pi-adapter/src/oauth-flows.test.ts` bundles a Worker with wrangler and
refreshes a token in workerd.

## Remove it

`pikit remove credentials-do` takes the routes and `model.credentials` away: providers then read
their API keys from the Worker's secrets. The credentials stay in the owner object's table
(`credentials_do`); delete them first (`DELETE` above) if they should not.
