# Maintenance lessons

- External-registry fixtures must satisfy the complete `ManifestSchema`, including the required `optional.capabilities`, before exercising another validation failure.
- For files shared with a background agent, reread the exact current block before editing. Every replacement must be unique; merge overlapping edits and omit speculative/nonexistent matches.
