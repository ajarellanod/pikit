# github-token

The project's GitHub access from a token you made: the `GITHUB_TOKEN` secret and the project's
repository. It provides the same `github` contract as `github-app`, so the agent's `git`
(execution-do, execution-local) and the proposals work the same with either; use this one for a
project run from the CLI or on a server, `github-app` (two clicks in the dashboard, no token to make)
on Cloudflare.

- **Provides:** `github` (`@pikit/contracts`' github.ts): the repository and its token.
- **Requires:** `secrets` (the token). **Uses, if installed:** `settings` (the repository, live;
  `settings-store`).
- **Settings:** `settings/`, the Settings dialog's GitHub: the repository (installed to
  `src/dashboard/src/settings/github-token/`).
- **Targets:** `server` and `durable`. On Cloudflare it goes in both Apps (`apps.worker: "default"`),
  with its config in both.
- **Installs to:** `src/pikit/github-token/`.
- **npm dependencies:** `typebox`.

```sh
pikit add github-token
```

## Connect it

1. **A token**: a [fine-grained personal access
   token](https://github.com/settings/personal-access-tokens/new), Repository access *Only select
   repositories*, the project's only, with Contents and Pull requests *Read and write*, Checks and
   Commit statuses *Read-only*. It is the secret `GITHUB_TOKEN` (`tokenSecret`): in `.env` on a server
   (`pikit configure` asks for it), in the Worker's secrets on Cloudflare.
2. **The repository**, `owner/name`: the config's `repository` (its default), or the setting, set in
   Settings → GitHub and read at each call.

Connected means both: until then `repository()` is `undefined` and `token()` rejects with
`GitHubNotConnectedError`, saying which is missing. The token is never logged, never in an error, and
sent only to GitHub by the components that ask for it.

## Configure

```ts
"github-token": {
  repository: "ana/my-bot",    // default "": the setting's default (empty: not connected)
  tokenSecret: "GITHUB_TOKEN", // default: the secret holding the token
}
```

## Security

The token is long-lived: scope it to the repository alone, and give it no more than the permissions
above. The agent never reads it (no tool reads `secrets` for it, and execution-do's shell has no
process); on a server, a shell of the app's user can read the process's environment
(execution-local's README). A ruleset on the default branch is an extra layer.

## Tests

`github-token.test.ts`: the `github` suite (`createGitHubConformance`), what it says when the
repository or the secret is missing, the repository as a setting over the config's (the config's when
the settings cannot be read), and the token in no log line.
