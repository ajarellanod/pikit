# Config files and profiles

**Public appeal:** —

**Specified:** partly (moved from the former SPEC §12 and §16)

**Needed by:** nothing required. The kernel takes a plain, validated object whatever it came from
(SPEC K4).

## What it gives
Values in YAML next to the project (`config/<profile>.yaml`), with a profile per environment
(`--profile staging`), instead of only `export const config` in `pikit.config.ts`.

## How it fits pikit
- The CLI (and the `deployment-*` entrypoint) reads the file, merges the profile, and passes the
  object to `defineApp`; the kernel never reads a file (SPEC K4).
- YAML is parsed with a YAML 1.2 parser (never `Bun.YAML`, which is YAML 1.1), so `on` / `off` /
  `yes` / `no` stay strings.
- `pikit config check` validates it against the merged schemas without starting anything.
- Only values: a key that selects a strategy is a capability selector (MANIFESTO.md, principle 8).
- Absent: `pikit.config.ts` holds the values, as today.

## Pi first
Nothing to take from Pi: Pi's `settings.json` configures one agent process, not a composition.

## Open questions
- YAML or TypeScript only (below).
- How a profile merges: deep or per component.

## Moved from the former SPEC
The former SPEC §12:

First bullet, its last sentence:

> A values file (YAML) and profiles are features of the CLI, `[planned]`; the kernel never reads a file.

Third bullet:

- When a values file exists: `config/<profile>.yaml` overlays for `--profile`, and YAML is parsed
  with a YAML 1.2 parser, so `on/off/yes/no` are strings. `[decision]`

The former SPEC §16, "Open questions":

- Config format for values (YAML or TypeScript only): a CLI question, not the kernel's, which takes a
  plain object (SPEC K4).
