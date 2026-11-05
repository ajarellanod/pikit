# provider-failover

Models that fail over to others. A chain is a list of models of your installed providers; an agent
names it `failover/<chain>`, and each request goes to the first of its models that is not failing.

```ts
// pikit.config.ts
"provider-failover": {
  chains: {
    main: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6", "openrouter/z-ai/glm-5.3-flash"],
  },
},
// an agent
defineAgent({ name: "assistant", model: "failover/main" })
```

- **Provides:** `model.provider`, under the key `failover`.
- **Uses:** the other `model.provider`s (each chain's models), and, when installed,
  `model.credentials`, `secrets`, `health`, and `actor.mailbox`, `actor.inbox` and `storage.sql`
  (the shared cooldowns).
- **Targets:** `server` and `durable`.
- **Installs to:** `src/pikit/provider-failover/`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

A request goes to the chain's models in order, skipping those cooling down. When a model fails
**before its answer shows anything**, the same request goes to the next model at once, and the
failed one is skipped for a while:

| Why it failed | Examples | Skipped for (default) |
|---|---|---|
| `rate` | 429, 402, 403, a subscription's usage limit, a quota | 15 minutes (`cooldownSeconds.rate`) |
| `auth` | 401, refused or missing credentials: **the whole provider** | 15 minutes (`cooldownSeconds.auth`) |
| `unavailable` | 404, a model or endpoint that is not there | 1 hour (`cooldownSeconds.unavailable`) |
| `transient` | 5xx, a timeout, a network failure, a cut stream | 30 seconds (`cooldownSeconds.transient`) |

What another model would fail the same way never moves: an abort, a request too big for any model
(a context overflow, which pi-durable compacts for; a 413), a bad request (a 400). The answer is
that failure.

A failure **after the answer has started** is that answer's: it is never replayed on another model,
so nothing is said twice. pi-durable's retry runs the request again, and since the failed model
cools down, the retry starts on the next one.

### Shared cooldowns

With `actor.mailbox` installed (mailbox-local on a server, actors-do on Cloudflare), what one
conversation learns protects the others and survives a restart. The cooldowns are one actor's,
`provider-failover:cooldowns`: on a server that is the App itself, on Cloudflare the Durable Object
of that key. It keeps them in its `storage.sql`, the table `provider_failover_cooldowns`: the model
or provider, why, until when and when it was learnt. It never stores an error's text or a credential.

Each App keeps its own copy, so requests do not wait on the owner:

- a failure (or an answer that clears one) updates the copy at once, and is reported to the owner.
  The owner answers with every cooldown it holds, which refreshes the copy;
- the copy is read at start. An App's first requests wait for that read for up to one second. After
  that, a request reads the copy again once it is `refreshSeconds` old (10 by default), without
  waiting for the answer;
- each entry carries when it was learnt, and the newest one wins, both at the owner and in each
  copy. So a report that is sent again, or arrives late, changes nothing.

If the owner cannot be reached (it is not installed, its storage fails, or it takes more than 5 s),
that is logged once per streak and the App carries on with its own copy. What the owner did not
take is sent with the next read. A request never fails because of the owner. Without `actor.mailbox`,
the cooldowns are kept in this App's memory only.

When every model fails, the answer is the last failure, and its message lists what was tried
(`… (provider-failover "main" tried openai/gpt-5.5: rate, anthropic/claude-sonnet-4-6: transient)`).
When every model is cooling down, they are all tried anyway, in chain order: a cooldown is a guess,
not a refusal.

Each model answers with its own provider's credentials (a ChatGPT login, an API key), read as
runtime-pi reads them. The answer is the model's that gave it: the conversation shows it, and its
usage is priced by it. A model of the chain with no credentials at all fails as refused credentials.

## Credentials

A chain has none of its own: it is configured when one of its providers is. Set up each provider of
its models as that provider's README says: a login (`pikit configure --login openai`, `pikit
configure --login anthropic`) or its key in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
`pikit configure` asks only for the providers agents name, here `failover`, so it does not offer
the chain's providers by itself: name them with `--login`, or set their keys.

### The model a chain is

`failover/<chain>` is what all its models can take: its context window and maximum output are the
smallest of them (pi-durable compacts by it), its inputs those all take (no images unless every
model takes them), and it reasons when one of them does (each model's own API ignores what it
cannot do). Moving between providers mid-conversation is pi-ai's: it converts the transcript, as
when you switch models in Pi.

### Health

With `health` installed (`health-registry`), each chain reports as `provider-failover:<chain>`:

- `up`: none of its models is cooling down;
- `degraded`: some are, with why and until when, and which model answers meanwhile
  (`openai/gpt-5.5 credentials refused, log in to openai again, until 2026-05-12T14:30:00.000Z;
  answering with anthropic/claude-sonnet-4-6`);
- `down`: all of them are (a non-essential `down`: the App is `degraded`, never restarted for it).

Refused credentials need someone to log in again (`pikit configure --login openai`); waiting does
not fix them. The report is updated after each request, when a cooldown ends, and when a read of the
shared cooldowns brings news from other conversations.

## Limits

- **Shared, eventually.** An App that is already running sees another App's failure at its first
  request after its copy is `refreshSeconds` old, and uses it from the request after that. Until then
  it can still try the failing model once, and a provider that fails slowly (a timeout) slows that
  request. A new App (a conversation's object that just started) sees the failure from its first
  request, unless the owner takes more than a second to answer. Cooldowns are timed by each App's
  clock, and Durable Objects' clocks agree closely enough for this.
- **Without `actor.mailbox`, the cooldowns are in memory.** A restart forgets them: the first
  request after it tries the first model again.
- **One credential per provider.** A chain cannot go from a ChatGPT subscription to an OpenAI API
  key, nor between two accounts of one provider: `openai` has one credential.
- **Configuration** is checked at start: a chain that names a model no installed provider has, or
  another chain, refuses to start the App.

## Tests

`provider-failover.test.ts` is copied with the component and runs in your project. Its providers
are fakes whose requests answer as each test scripts (an answer, a failure before or after its
text); no network, no credential. It covers the chain's model, the start's refusals, moving a
request and cooling down, a failure after the answer started, what never moves, every model
failing, refused credentials cooling a provider, and the health reports. `shared.test.ts` covers the
shared cooldowns: Apps over one owner through a fake mailbox (a failure seen by another App, read
again after `refreshSeconds`, answers clearing them, expiry, health), a restart over the same
storage, an owner that refuses or never answers, and the owner keeping the newest entry of each key.
In the pikit repository, the workerd lane (`tests/workerd/test/provider-failover.workerd.ts`)
composes it with runtime-pi, provider-openai and provider-anthropic in a real Durable Object:
OpenAI's fake API refuses with a 429, the agent answers through Anthropic's, and the next message
goes to Anthropic alone. A second case runs two conversations' `PlatformConversation` objects with
actors-do: after one of them meets the 429, the other's first message goes to Anthropic alone,
through the owner object `provider-failover:cooldowns`.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
