# Proposal for pi-ai: OAuth refresh and `toAuth` reachable in a bundle

Status: draft for upstream (`@earendil-works/pi-ai`, against 1.2.0). From pikit, whose agents run in
Cloudflare Workers (one Durable Object per conversation), bundled by wrangler (esbuild).

## Problem

A provider with a subscription login (`anthropic`, `openai`, `openai-codex`, `github-copilot`…)
declares its OAuth through `lazyOAuth({ load })`, and `load` is one of `auth/oauth/load.ts`'s loaders:
an `import()` of a variable specifier, on purpose, so that a bundler leaves the flow out (its login
starts a callback server on `node:http`).

The flow is not only the login. `Models.getAuth()` reaches the same lazy module for every request
made with a stored OAuth credential (`oauth.toAuth`) and for every refresh (`oauth.refresh`). In a
bundle, both fail, so a stored subscription credential cannot be used at all, let alone refreshed:

- the loader first reads `import.meta.url.endsWith(".js")`, and `import.meta.url` is `undefined` in a
  Worker bundle: `TypeError: Cannot read properties of undefined (reading 'endsWith')`;
- past that, the `import()` names a module the bundle does not have.

The one way around it is `@earendil-works/pi-ai/bun-oauth`'s `registerBunOAuthFlows()`, documented
for Bun's standalone binaries: all or nothing, it imports every flow statically, with their
callback servers and GitHub Copilot's model catalog.

## Evidence

- pi-ai 1.2.0: `dist/auth/oauth/load.js` (`importOAuthModule`), `dist/auth/helpers.js` (`lazyOAuth`:
  `refresh` and `toAuth` go through `load` like `login`), `dist/providers/anthropic.js`.
- pikit's `packages/pi-adapter/src/oauth-flows.test.ts`: a Worker bundled by wrangler 4.143 and run in
  workerd (`wrangler dev`). `anthropicProvider().auth.oauth.refresh(…)` fails with the `TypeError`
  above; after `registerBunOAuthFlows()`, the same bundle refreshes against a fake token endpoint and
  `toAuth` answers.
- Vitest's Workers integration does not show it: its module runner resolves the variable `import()`
  at run time, as no deployed Worker does.

## pikit's workaround

`@pikit/pi-adapter/oauth-flows` exports `bundleOAuthFlows()`, which calls `registerBunOAuthFlows()`
once per isolate. The component that keeps OAuth credentials on Cloudflare (credentials-do) calls it
in its `start`; every flow is then in the Worker's bundle, logins and their Node servers included,
none of which a Worker ever runs.

## Proposal

Any one of these, in order of preference:

1. **Keep only `login` lazy.** `refresh` and `toAuth` are a `fetch` and a field read in every flow
   (`refreshAnthropicToken`, `openai-chatgpt.ts`'s `refreshAccessToken`): move them to small modules
   the provider imports statically, and let `lazyOAuth` load only the login. A bundle can then use and
   refresh a stored credential with no registration, and still carries no callback server.
2. **One flow at a time.** Export each flow by subpath (`@earendil-works/pi-ai/oauth/anthropic` →
   `anthropicOAuth`) and register one with `registerOAuthFlow("anthropic", anthropicOAuth)`, so a
   bundle carries only the flows of its providers.
3. At least, read `import.meta.url` safely (`import.meta.url?.endsWith(…)`), so a bundle fails with
   the import's error rather than a `TypeError` (the crash is a one-line bug; it does not make the
   flow reachable).

## Compatibility

Additive: the loaders, `registerBundledOAuthFlowLoaders` and `registerBunOAuthFlows` stay.

## To delete when it ships

`packages/pi-adapter/src/oauth-flows.ts`, its export and README rows, credentials-do's call in
`start`; `oauth-flows.test.ts` then bundles a Worker without any registration.
