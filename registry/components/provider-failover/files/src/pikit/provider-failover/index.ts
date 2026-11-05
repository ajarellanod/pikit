/**
 * provider-failover: models that fail over to others. A chain is a list of models of the installed
 * providers; an agent names it `failover/<chain>`, and each request goes to the first of its models
 * that is not cooling down. It provides the keyed capability `model.provider` under the key
 * `failover`.
 *
 *   "provider-failover": { chains: { main: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"] } }
 *   defineAgent({ name: "assistant", model: "failover/main" })
 *
 * A model that fails before its answer shows anything (a rate or usage limit, refused credentials,
 * a missing model, a provider or network failure) is skipped for a while, and the same request goes
 * to the next model at once. A failure after the answer has started is that answer's: pi-durable's
 * retry runs it again, on another model since the failed one cools down. An abort, a request too big
 * for any model, or a bad request is never retried elsewhere.
 *
 * With `actor.mailbox` installed, the cooldowns are shared (`shared.ts`): one actor,
 * `provider-failover:cooldowns`, keeps them in its `storage.sql` (this App on a server, a Durable
 * Object on Cloudflare), so a restart keeps them and one conversation's failure protects the others.
 * Each App reads its own copy, reports what it learns and reads the others' every `refreshSeconds`
 * at most; an owner that fails is logged, never in a request's way. Without it, they are this App's
 * memory only.
 *
 * It uses the other `model.provider`s and the App's credentials (`model.credentials`, `secrets`),
 * as runtime-pi does, so that each model answers with its own provider's credentials. With `health`
 * installed, each chain reports as `provider-failover:<chain>`: degraded while a model of it cools
 * down (saying why and until when; refused credentials mean someone has to log in again), down
 * while all of them do.
 *
 * Its `accounts` are more accounts of an installed provider, each a model provider of its own with
 * its own credential (`anthropic-2/<modelId>`, see accounts.ts), which chains and agents name.
 *
 * Targets: `server` and `durable`.
 */

import { BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import type { HealthReporter } from "@pikit/contracts";
import { type Models, modelsFrom, parseModelName } from "@pikit/pi-adapter";
import Type from "typebox";
import { type Chain, createCooldowns, failoverProvider, PROVIDER_ID } from "./failover.ts";
import { Accounts, accountProviders, checkAccounts } from "./accounts.ts";
import { answerSync, shareCooldowns } from "./shared.ts";

/** How long an App's first requests wait for its first read of the shared cooldowns. */
const FIRST_WAIT_MS = 1_000;

const seconds = (value: number, description: string) => Type.Integer({ minimum: 1, default: value, description });

const Config = Type.Object({
  /** Chain name → its models in order, each `<provider>/<modelId>` of an installed provider. */
  chains: Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9._-]*$" }), Type.Array(Type.String({ minLength: 3 }), { minItems: 1 }), { default: {} }),
  /** How long a model that failed is skipped, by why it failed. */
  cooldownSeconds: Type.Object(
    {
      rate: seconds(900, "A rate or usage limit (429, 402, 403, a quota)."),
      auth: seconds(900, "Refused or missing credentials (401): the whole provider."),
      unavailable: seconds(3600, "The model or its endpoint is not there (404)."),
      transient: seconds(30, "A provider or network failure (5xx, a timeout, a cut stream)."),
    },
    { default: {} },
  ),
  /** With `actor.mailbox`: how old this App's copy of the shared cooldowns may be before a request reads them again. */
  refreshSeconds: Type.Integer({ minimum: 1, default: 10 }),
  /** Account id → the installed provider it is another account of, and the variables it reads instead. */
  accounts: Accounts,
});

export default defineComponent({
  name: "provider-failover",
  config: Config,
  setup(pikit, config) {
    const providers = pikit.useKeyed("model.provider");
    const credentials = pikit.useOptional("model.credentials");
    const secrets = pikit.useOptional("secrets");
    const health = pikit.useOptional("health");
    // The shared cooldowns (shared.ts): reached with the mailbox; kept by the App with an inbox and SQL that owns them.
    const mailbox = pikit.useOptional("actor.mailbox");
    const inbox = pikit.useOptional("actor.inbox");
    const sql = pikit.useOptional("storage.sql");

    let chains = new Map<string, Chain>();
    let models: Models | undefined;
    let now = () => Date.now();
    let changed: (() => void) | undefined;
    let failedOver: ((event: { chain: string; from: string; kind: string; to: string | undefined }) => void) | undefined;
    let log: ((level: "warn" | "info", message: string, fields?: Record<string, unknown>) => void) | undefined;
    const cooldowns = createCooldowns(
      {
        rate: config.cooldownSeconds.rate * 1000,
        auth: config.cooldownSeconds.auth * 1000,
        unavailable: config.cooldownSeconds.unavailable * 1000,
        transient: config.cooldownSeconds.transient * 1000,
      },
      () => now(),
      (entries) => sharing.learnt(entries),
    );
    const sharing = shareCooldowns({
      mailbox: () => mailbox.get(),
      cooldowns: () => cooldowns,
      now: () => now(),
      refreshMs: config.refreshSeconds * 1000,
      firstWaitMs: FIRST_WAIT_MS,
      changed: () => changed?.(),
      log: (level, message, fields) => log?.(level, message, fields),
    });
    // Building the provider opens nothing: its chains and their providers are read at start.
    const provider = failoverProvider({
      chains: () => chains,
      models: () => models,
      cooldowns,
      ready: () => sharing.ready(),
      now: () => now(),
      changed: () => changed?.(),
      failedOver: (event) => failedOver?.(event),
    });
    pikit.provideKeyed("model.provider", PROVIDER_ID, provider);
    for (const account of accountProviders(config.accounts, PROVIDER_ID, (id) => providers.get(id))) pikit.provideKeyed("model.provider", account.id, account);

    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      start(ctx) {
        const background = ctx.derive(() => BACKGROUND_CONTEXT);
        now = () => background.clock.now();
        checkAccounts(config.accounts, PROVIDER_ID, providers.keys());
        const own = providers.keys().flatMap((key) => (key === PROVIDER_ID ? [] : (providers.get(key) ?? [])));
        const made = modelsFrom(own, { credentials: credentials.get(), secrets: secrets.get() });

        const resolved = new Map<string, Chain>();
        for (const [id, names] of Object.entries(config.chains)) {
          const candidates = names.map((name) => {
            const ref = parseModelName(name);
            if (ref?.provider === PROVIDER_ID) throw new Error(`provider-failover: chain "${id}" names "${name}", another chain: a chain lists models of other providers`);
            const model = ref === undefined ? undefined : made.getModel(ref.provider, ref.modelId);
            if (model === undefined) throw new Error(`provider-failover: chain "${id}" names "${name}", which no model.provider provides (installed: ${own.map((p) => p.id).join(", ") || "none"})`);
            return { name, model };
          });
          resolved.set(id, { id, candidates });
        }
        chains = resolved;
        models = made;

        const reporters = new Map<string, HealthReporter>();
        const registry = health.get();
        if (registry !== undefined) for (const id of chains.keys()) reporters.set(id, registry.reporter(`provider-failover:${id}`));
        // Each chain's state now; again when the next cooldown ends, so that an idle chain does not stay degraded.
        const report = () => {
          for (const [id, chain] of chains) {
            const reporter = reporters.get(id);
            if (reporter === undefined) continue;
            const cooling = chain.candidates.flatMap((candidate) => {
              const state = cooldowns.of(candidate);
              return state === undefined ? [] : [{ candidate, state }];
            });
            const answering = chain.candidates.find((candidate) => cooldowns.of(candidate) === undefined);
            if (cooling.length === 0) reporter.up();
            else {
              const why = cooling
                .map(({ candidate, state }) => `${candidate.name} ${state.kind === "auth" ? `credentials refused, log in to ${candidate.model.provider} again` : state.kind}, until ${new Date(state.until).toISOString()}`)
                .join("; ");
              if (answering === undefined) reporter.down(`every model cooling down: ${why}`);
              else reporter.degraded(`${why}; answering with ${answering.name}`);
            }
          }
          clearTimeout(timer);
          const end = cooldowns.nextEnd();
          if (end !== undefined && reporters.size > 0) timer = setTimeout(report, Math.max(0, end - now()) + 1);
        };
        changed = report;
        failedOver = (event) =>
          background.logger.warn(
            event.to === undefined ? "provider-failover: a model failed; the request is not moved to another" : "provider-failover: a model failed; the request moves to the next",
            event,
          );
        report();

        log = (level, message, fields) => background.logger[level](message, fields);
        const calls = inbox.get();
        const db = sql.get();
        if (calls !== undefined && db !== undefined) answerSync(calls, () => db, () => now());
        sharing.start(background);
      },
      stop() {
        sharing.stop();
        log = undefined;
        clearTimeout(timer);
        changed = undefined;
        failedOver = undefined;
      },
    };
  },
});
