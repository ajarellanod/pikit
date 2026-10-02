// @pikit/pi-adapter/providers/faux: pi-ai 1.0's faux provider, for tests only (provider-faux): a
// `Provider` whose model answers what its responses say, with no network, no key and no cost but its
// own token estimate. `fauxProvider({ provider, models })` makes one; `setResponses` and
// `appendResponses` script what it answers, each response a message or a function of the request.
// Neutral: it imports nothing node-only.

export { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
export type { FauxProviderHandle, FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
