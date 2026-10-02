# Maintenance lessons

- External-registry fixtures must satisfy the complete `ManifestSchema`, including the required `optional.capabilities` and adapter range when depended on, before exercising another validation failure.
- Failed-install rollback tests must explicitly assert the unfinished-operation marker, then compare the other restored files; the marker intentionally survives because `node_modules` is not restored.
- Validation worktree dependency links must remap workspace source directories only, never local `node_modules` directories (otherwise `.bin/vitest` can link to itself).
- For files shared with a background agent, reread the exact current block before editing. Every replacement must be unique; merge overlapping edits and omit speculative/nonexistent matches.

# Downloaded references

- `/Users/alex/Projects/Personal/pi` — Pi monorepo (`earendil-works/pi`); read `origin/main` (v1.0.0: `packages/durable`, `packages/chord`, `packages/server`) after `git fetch`, the local `main` checkout is stale.
- `/Users/alex/Projects/Personal/shadcn-ui` — shadcn CLI and registry (sparse: `packages/shadcn`, `packages/registry`, `apps/v4/content/docs/registry`), checked at 4.21.1.
