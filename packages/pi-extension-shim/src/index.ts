// `@earendil-works/pi-coding-agent`, as far as a Pi extension running in pikit needs it (SPEC §6.2b).
// A project installs this package under that name (`"@earendil-works/pi-coding-agent":
// "npm:@pikit/pi-extension-shim@…"`), so an extension's imports resolve here and the 19 MB coding
// agent is never installed. Everything lives in `@pikit/pi-adapter/extensions`.

export * from "@pikit/pi-adapter/extensions";
