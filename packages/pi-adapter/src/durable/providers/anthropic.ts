// @pikit/pi-adapter/durable/providers/anthropic: pi-ai 1.0's Anthropic provider, the 1.0 twin of
// `../../providers/anthropic.ts`, by subpath so a bundle carries only the providers it installs
// (Cloudflare's 10 MB, SPEC §4). Same id (`anthropic`), models and credential order as 0.99:
//
// 1. A credential stored for `anthropic` in `model.credentials`: OAuth tokens from a Claude
//    subscription login (refreshed and written back by pi-ai), or an API key.
// 2. Only when nothing is stored, the environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`,
//    `ANTHROPIC_AUTH_TOKEN`, then (new in 1.0) workload identity federation when
//    `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`
//    are all set.
//
// Its OAuth login changed in 1.0: it first asks, with a `select` prompt, for the login method,
// `browser` (a callback on localhost:53692) or `copy_code` (Anthropic's page shows a code to paste;
// for a login where the app runs, in Docker). `loginInteraction` in `../credentials.ts` answers it.

export { anthropicProvider } from "pi-ai-v1/providers/anthropic";
