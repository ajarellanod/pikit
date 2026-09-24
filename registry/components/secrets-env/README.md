# secrets-env

Secrets from the process environment.

- **Provides:** `secrets`.
- **Requires:** nothing.
- **Target:** `server`. On Cloudflare, secrets are Worker bindings, which is another component.
- **Installs to:** `src/pikit/secrets-env/`.
- **npm dependencies:** none.

## What it does

`secrets.get(name)` returns the environment variable `name` as it is when it is read. An empty
variable counts as not set, so a component that needs a token sees it missing instead of accepting
`""`.

Set secrets the way your supervisor does: systemd `Environment=` / `EnvironmentFile=`, Docker
`--env` / `env_file`, or `export` in a shell.

It never reads a `.env` file itself, and never writes or logs a value. Bun loads `.env` files from
the working directory on its own; that is Bun's behaviour, not this component's.

## Tests

`secrets-env.test.ts` is copied with the component and runs in your project. It runs the `secrets`
conformance suite from `@pikit/core/testing`: values read back exactly, unset and empty ones read
`undefined`, and no value reaches `describe()` or a log line.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
