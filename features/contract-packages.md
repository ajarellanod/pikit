# Contract packages

**Public appeal:** —

**Specified:** no. Decided: a contract that is not the kit's is a package of its own, which its
registry ships and the CLI vendors (option B, below). Nothing is built.

**Needed by:** nothing required. It is on the roadmap on one condition: pikit succeeds, and others
build registries with contracts of their own. See [When to build it](#when-to-build-it). Until then,
contracts keep going into `@pikit/contracts` (SPEC §3.2 stays as it is).

## Why

Today a contract lives in one of two places, and they are not equals:

- **The kit's** (`@pikit/contracts`): a versioned package, a range per component
  (`requires.contracts`), suites importable from `@pikit/contracts/testing`, names reserved.
- **A registry's own** (`declares.capabilities`, [docs/contracts.md](../docs/contracts.md), the
  worked example [memory](memory.md)): the defining component declares the name, and every component
  that uses it carries an identical copy of `contract.ts`. Copies that differ fail `tsc` (TS2717).

The second way breaks down across registries:

- **No version.** When registry A changes `memory`, a provider from registry B only learns it from a
  TS2717 in the user's project, with no range saying which side is behind.
- **No shared suite.** The suite lives in the defining component, and no other component may import
  it (SPEC P4). So a third-party provider cannot prove that it is interchangeable, and "stable after two
  independent providers pass the suite" cannot be checked across registries.
- **Global names.** Two registries that declare `memory` differently clash. `registry validate` sees
  this only inside one registry, and the project sees only a `tsc` error.
- **Unused.** No component in this registry uses `declares`, so the path third parties would take is
  untested, while the kit takes a better one.

So every first-party feature's contract went into `@pikit/contracts` (SPEC §3.2), and the package
grows with each feature: it is already bigger than the core.

## When to build it

It is built when one of these happens, not before (SPEC §7: a feature is built when a user needs
it):
- [Open registries](open-registries.md) are going to be built: pikit is published, and registries
  other than the official one are expected.
- A registry author outside the kit needs a contract of their own that other registries provide or
  use.

Until then, what is cheap and needs none of the machinery may still be done: a first-party contract
used by a single feature can be written so that moving it later is a move, not a redesign (its own
file, its own suite, no imports from other feature contracts).

## Decision

A contract that is not the kit's is **a package of its own: an interface, several implementations,
one shared compatibility suite.** This is the pattern of `@opentelemetry/api` and its SDKs, of SLF4J,
and of Jakarta EE and its TCKs, which works when several authors who do not coordinate implement one
interface. Providers and consumers depend on the package. There are no copies.

**Its registry ships it; the CLI vendors it.** The package lives in the registry
(`registry/contracts/<name>/`), and `pikit add` packs it into the project's `vendor/`, as
`packages/cli/src/project/vendor.ts` does for the kit. So:
- an author publishes nothing: a feature is still a registry, not a registry plus an npm package;
- a private registry works with the same Git credentials the registry is read with;
- it works although bun cannot install a package from a subdirectory of a Git repository.

Publishing to npm stays possible; it is never required.

Options weighed:
- **A.** A contract as a registry entry that the CLI copies once to a known path, with a range per
  component. It is not a package, so its suite and its types have no import path of their own.
- **B. (chosen)** A contract package. It is the same model as `@pikit/contracts`, so there is one way
  for everyone: semver ranges, an importable `/testing` suite, one copy in `node_modules`.
- **C.** Copies with a version and hash checked by the CLI. This is the smallest fix, but it still
  leaves the suite unshared.

## The shape of a contract package

- **Exports.** `.`: the types, by declaration merging on `AppCapabilities`,
  `AppKeyedCapabilities` and `AppEvents`, plus its errors and small protocol helpers (policy passed
  in, SPEC §3.3). `./testing`: the conformance suite and in-memory doubles.
- **`peerDependencies`, never `dependencies`, for `@pikit/core`** (and for `@pikit/contracts` when
  it uses its types): one core in `node_modules`, or there are two sets of capabilities.
- **Neutral.** It has no runtime dependencies besides those peers and no `node:*`, `bun:*` or
  `cloudflare:*` imports: it runs on every target.
- **It declares its capabilities in its `package.json`** (`"pikit": { "capabilities": { "memory":
  { "mode", "stability", "summary" } } }`). This replaces `component.json`'s
  `declares.capabilities`. A kind is a component name's prefix, not a contract, so `declares.kinds`
  stays in `component.json`.
- **Version.** Semver: 0.x while `experimental`.

A component that provides or uses it lists it in `dependencies` (`checkImports` already requires
every imported package to be there) and imports its types. The suite comes through the same
dependency (`/testing`).

## How a contract evolves

A project holds one version of each contract package, so incompatible ranges block an install:
registry A wants `memory ^1`, registry B wants `memory ^2`, and the user cannot have both. Rules that
keep this rare:
- **`stable` only after two independent providers pass its suite** (the rule `checkStability`
  applies to the kit today), from two registries when it is not the kit's.
- **A stable contract only grows.** It gains optional fields, new methods that consumers use only
  when present, and new events. A field is never removed or changed in meaning.
- **A major version is a decision**, written down with what replaces the old shape, and rare.
- **`experimental` (0.x) may change in any minor.** A component that depends on one pins a minor.

## What the CLI does

1. **`registry validate`** builds the catalogue from the kit's and from the `pikit` field of the
   registry's contract packages. A provided or used capability must be in one of them. It refuses a
   package that redeclares a kit name, and two packages that declare one name.
2. **`pikit add`** vendors the contract packages that the component depends on, from its registry.
   Before any write and unless `--force`, it requires one version of each contract package per
   project (the ranges of the installed components and of the new one must intersect, as `checkKit`
   does for the kit), and no two packages that declare the same capability name.
3. **`pikit doctor`** runs the same checks on the installed project. **`pikit upgrade`** checks the
   ranges again and refreshes the vendored packages.
4. **`pikit registry capabilities`** shows `definedIn` as `<package>@<version>`.
5. **`declares.capabilities` is removed** (pikit is unreleased: no compatibility).

## The kit's own feature contracts

The kit uses the same mechanism for its own features. A contract stays in `@pikit/contracts` only
when one of these holds:
- **The platform or protocol needs it:** storage, secrets, actor, wakeups, `http.route`,
  `conversations.registry`, inbound and delivery.
- **The runtime seam needs it:** the `agent.*` contracts that the runtime provides.
- **Components of several unrelated features use it:** `settings`, `health`, `admin.auth`.

The others move to packages of their own. The first candidates are `proposals`, `github` and
`agent.directory`.

## Order of work, once it is built

1. **SPEC first.** Amend §3.2 (each capability "in `@pikit/contracts`") and §3.3 (the kit layer) to
   say where a contract lives, and write the evolution rules above into it.
2. **The kit's first move.** Move `proposals` to a contract package and generalise `vendor.ts` to
   pack it. This proves the mechanism on a real case before any third party depends on it.
3. **The mechanism, with a fixture.** Turn [memory](memory.md)'s `contract.ts` into a contract
   package of a second registry in a test fixture, with its suite. Add the CLI changes above. Tests:
   - two components from two registries share one package;
   - a version conflict is refused before any write;
   - a name clash is refused;
   - the catalogue comes from the package.
4. **The rest of the kit's.** Move `github` and `agent.directory`. Update their providers and
   consumers (`proposals-*`, `admin-proposals`, `extension-pikit-self`, `github-*`, `execution-do`,
   `agents-live`, `runtime-pi`).
5. **Docs.** Update [docs/contracts.md](../docs/contracts.md) ("A registry's own contracts"),
   [memory](memory.md), [building components](building-components.md) and the `pikit-component`
   skill.
6. **Then [open registries](open-registries.md)** (Git registries) need no contract work of their
   own.

## Open questions

- **Naming.** A package name convention (`@scope/pikit-contract-<name>`?). Should capability names
  stay global strings, refused on a clash, or carry a prefix from their package?
- **One mechanism for all.** Should a component's `dependencies` range for `@pikit/contracts` replace
  `requires.contracts` too, so the kit and third parties are checked the same way?
- **Where the kit's live.** In this repository's `registry/contracts/`, like any registry's, or in
  `packages/`, like the kit's?
- **A package published to npm and vendored from a registry at once.** Which one wins in a project,
  and how `upgrade` tells them apart.
- **Before the kit is published.** A contract package's peer `@pikit/core` resolves to the project's
  vendored tarball through `overrides`. This should be checked in the fixture.
