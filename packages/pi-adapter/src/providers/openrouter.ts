// @pikit/pi-adapter/providers/openrouter: pi-ai's OpenRouter provider, by subpath like every pi-ai
// provider, so a bundle carries only the providers it installs (Cloudflare's 10 MB, SPEC §6.2). It
// signs in with an API key (`OPENROUTER_API_KEY`, or stored in `model.credentials`). Its module
// imports nothing node-only: its OAuth login (a local callback server, `node:http`) is loaded only
// when someone logs in, through a specifier bundlers do not follow, so an API key never reaches it.

export { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
