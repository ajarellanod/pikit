/**
 * github-token: the project's GitHub access from a token you made (`github`, @pikit/contracts'
 * github.ts): a `GITHUB_TOKEN` secret and the repository, `owner/name`. For a project run from the
 * CLI or on a server, where creating a GitHub App from the dashboard (github-app) is not the way.
 *
 * - **The repository** is a setting (`settings`, when a provider is installed: the dashboard's
 *   Settings → GitHub, its section `settings/`), its default the config's `repository`; read at each
 *   call, so a change applies without a deploy. When the settings cannot be read, the config's applies
 *   (logged).
 * - **The token** is the secret named `tokenSecret` (`GITHUB_TOKEN`), read through `secrets` at each
 *   call: a fine-grained personal access token for that repository only (Contents and Pull requests
 *   read and write, Checks and Commit statuses read). It is long-lived: the contract's "at least five
 *   minutes" holds while you keep it valid.
 * - **Connected** means both: without either, `repository()` is `undefined` and `token()` rejects with
 *   `GitHubNotConnectedError`, saying which is missing.
 *
 * Targets: `server` and `durable`. On Cloudflare it goes in both Apps (`apps.worker: "default"`), with
 * its config in both: the Worker's App (the proposals' routes) and the objects' (the agent's `git`)
 * each read the secret and the setting (settings-store's halves).
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { type GitHubAccess, GitHubNotConnectedError } from "@pikit/contracts";
import Type from "typebox";

const NAME = "github-token";
/** `owner/name`, or empty: not connected. */
const REPOSITORY = "^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?$";

const Config = Type.Object({
  /** The project's repository on GitHub, `owner/name`: the setting's default. Empty: not connected until set. */
  repository: Type.String({ pattern: REPOSITORY, default: "" }),
  /** The secret holding the token. */
  tokenSecret: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$", default: "GITHUB_TOKEN" }),
});

/** Its settings: the repository. */
export type GitHubTokenSettings = { repository: string };

const SettingsSchema = Type.Object(
  {
    repository: Type.String({
      pattern: REPOSITORY,
      title: "Repository",
      description: "The project's repository on GitHub, owner/name: where the agent pushes its pikit/self/ branches. Empty: GitHub is not connected.",
    }),
  },
  { additionalProperties: false },
);

const WHERE = "the dashboard's Settings → GitHub, or github-token's repository in pikit.config.ts";

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const settings = pikit.useOptional("settings");
    let declared = false;

    /** The repository now: the operator's setting, else the config's (also when the settings cannot be read). */
    const repositoryNow = async (ctx: AppContext): Promise<string> => {
      const store = settings.get();
      if (store === undefined || !declared) return config.repository;
      try {
        return (await store.get<GitHubTokenSettings>(NAME, ctx)).repository;
      } catch (error) {
        ctx.logger.warn("github-token: its settings could not be read; the config's repository applies", { error: error instanceof Error ? error.message : String(error) });
        return config.repository;
      }
    };
    const tokenNow = async (): Promise<string | undefined> => {
      const value = await secrets.get().get(config.tokenSecret);
      return value === undefined || value === "" ? undefined : value;
    };

    const github: GitHubAccess = {
      async repository(ctx) {
        const repository = await repositoryNow(ctx);
        return repository === "" || (await tokenNow()) === undefined ? undefined : repository;
      },
      async token(ctx) {
        if ((await repositoryNow(ctx)) === "") throw new GitHubNotConnectedError(`GitHub is not connected: no repository is set (${WHERE})`);
        const token = await tokenNow();
        if (token === undefined) throw new GitHubNotConnectedError(`GitHub is not connected: the secret ${config.tokenSecret} is not set (github-token's README says how to make it)`);
        return token;
      },
    };
    pikit.provide("github", github);

    return {
      start() {
        const store = settings.get();
        if (store === undefined) return;
        store.declare(NAME, SettingsSchema, { repository: config.repository });
        declared = true;
      },
      stop() {
        declared = false;
      },
    };
  },
});
