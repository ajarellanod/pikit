# Open registries

**Public appeal:** —

**Specified:** partly (the former SPEC §10.3, §10.4)

**Needed by:** partly by `pikit upgrade` (P6): it fetches a pinned commit again, which is when Git
registries are read. HTTP registries, private registries beyond that, and a gallery are
not required.

## What it gives
Official, third-party, private (Git over SSH) and local registries as equals, for any kind of
component (IDEA.md, "What's ours" 7), and a static gallery to browse them.

## How it fits pikit
- A registry is a Git repository or a static HTTP root with `registry.json`, components and
  presets; no server-side logic; private ones use the user's Git credentials.
- `pikit.json` records each registry's location so that it resolves on any clone;
  `pikit registry add|remove|list|init` manage them.
- A gallery is a static site generated from `registry.json` and each component's README.
- Absent: the `builtin` registry and local paths, as today.

## Pi first
Pi packages come from npm, git or a local path, pinned (`docs/packages.md` of `pi-coding-agent`):
the same shape for Pi's resources. pikit's registries carry components, which Pi has no notion of.

## Open questions
- Trust: pinned commits only, or signatures as well.
- Skills as registry entries ([skills hub](skills-hub.md)).

## Moved from the former ROADMAP
"Later, only if demanded":

> - A static registry gallery.
