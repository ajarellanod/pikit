# Pi's example extensions, unmodified

Copied byte for byte from `earendil-works/pi` at tag `v0.87.1`,
`packages/coding-agent/examples/extensions/`. They are MIT licensed, © Mario Zechner; see
`NOTICE` at the repository root. They are **not edited**: scenario 7 (SPEC §15) is that an existing
Pi extension runs in pikit as it is.

- `permission-gate.ts`: blocks dangerous `bash` commands; with no UI it blocks without asking.
- `protected-paths.ts`: blocks `write` / `edit` to protected paths.
- `hello.ts`: registers a tool with `defineTool`, a value imported from
  `@earendil-works/pi-coding-agent`.

They import `@earendil-works/pi-coding-agent`, which this repository installs as an alias of
`@pikit/pi-extension-shim` (see the root `package.json`). `compat.test.ts` runs them, and `tsc`
checks them against pikit's vendored `ExtensionAPI`.
