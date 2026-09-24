// @pikit/pi-adapter/providers/anthropic: pi-ai's Anthropic provider, by subpath like every pi-ai
// provider, so a bundle carries only the providers it installs (Cloudflare's 10 MB, SPEC §6.2). It
// signs in with an API key (`ANTHROPIC_API_KEY`, or stored) or with OAuth (a Claude subscription);
// the credentials live in `model.credentials`.

export { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
