# credentials-file

The model providers' credentials in one JSON file, readable only by its owner (mode `0600`).

- **Provides:** `model.credentials` (pi-ai's `CredentialStore`).
- **Requires:** nothing.
- **Target:** `server` (it uses the filesystem).
- **Installs to:** `src/pikit/credentials/file/`.
- **npm dependencies:** `@pikit/pi-adapter` (for the `CredentialStore` type), `typebox`.

## What it does

The file holds one credential per provider id, either an API key or OAuth tokens. It has the same
shape as Pi's own `auth.json`:

```json
{ "anthropic": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1790000000000 } }
```

- Before each model request, pi-ai reads the provider's credential from here.
- When an OAuth token is about to expire, pi-ai refreshes it and writes the new tokens back through
  this store, so a restart keeps them.
- A refresh holds the store's write line, so two requests never refresh (and rotate) one token
  twice.
- When a provider has nothing stored, pi-ai uses its environment variables instead
  (`ANTHROPIC_API_KEY`).

Every read opens the file again, so a login written by another process takes effect at the next
request. Writes run one at a time and replace the file atomically: a temporary file is created with
mode `0600`, flushed, and renamed over the old one.

It creates the file (and its directory, mode `0700`) at start if they do not exist. It refuses to
start when the file is not valid JSON or holds something that is not a credential. The error names
the file and never quotes it. A file that other users can read starts with a warning.

No value from the file is ever logged. Keep the file out of version control (`.pikit/` in
`.gitignore`).

Do not point `path` at Pi's own `~/.pi/agent/auth.json`. A refresh rotates the refresh token, and
the Pi CLI would lose its session.

## Logging in

A credential gets here through pi-ai's login flow:
`modelsFrom([provider], { credentials }).login("anthropic", "oauth", interaction)`, from
`@pikit/pi-adapter`. The `http` sample has a script that does it (`samples/http/scripts/login.ts`).
`pikit configure` will do it once the CLI exists.

## Config

```ts
"credentials-file": {
  path: ".pikit/credentials.json", // default; relative to the working directory
}
```

## Tests

`credentials-file.test.ts` is copied with the component and runs in your project. It covers:
- the `model.credentials` conformance suite from `@pikit/pi-adapter/testing`. This includes
  persistence across restarts, and a token refreshed by pi-ai written back to the file;
- the lifecycle conformance suite;
- the file mode, a write by another process, and the start failures above, without leaking a value.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
