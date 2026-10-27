# storage-blob-fs

`storage.blob` in a directory of the server: what components keep by key that is too large for a
row of `storage.sql` or a value of `storage.kv` (a space's saved files, a workspace's snapshot).
Each component opens the namespace named after it.

```sh
pikit add storage-blob-fs
```

## What it guarantees

Everything the `storage.blob` contract promises (`createBlobConformance` passes):

- **Bytes in, the same bytes out**, every byte value, with the content type they were put with.
  `get` and `put` copy: changing an array afterwards changes nothing stored.
- **Atomic replace.** `put` writes the value to a temporary file in the same directory, syncs it,
  then renames it over the key's file: a reader sees the old value or the new one, never a mix, and a
  crash leaves the old one.
- **Namespaces apart**: one directory each, `<root>/<namespace>/`.
- **Keys as the contract has them**: case-sensitive even on a file system that ignores case (macOS),
  a key and the keys under it (`a`, `a/b`) separate values, up to 512 characters.
- **`list`** in code-unit order, a page at a time (at most 1000 keys), with a cursor.
- **Nothing outside the root.** The contract's keys and names cannot leave it, every path is still
  checked to be inside its namespace's directory, and listing never follows a symbolic link. A key,
  a value or a content type the contract refuses is refused before any file is touched.

## On disk

```
.pikit/blobs/tool-space-files/spaces~/s1~/notes.md     the key spaces/s1/notes.md
.pikit/blobs/tool-space-files/spaces~/s1~/^r^e^a^d^m^e  the key spaces/s1/README
```

A directory's name ends in `~` (or `+` when a segment longer than 200 characters goes on in it), a
value's file has none. An upper-case letter is `^` and the letter. Each file starts with a header of
256 bytes, the content type, before the value's bytes. Deleting a key removes the directories it
emptied. In Docker, `.pikit/` is the volume, so the values survive `down`, `up` and new images.

## Config

```ts
"storage-blob-fs": {
  root: ".pikit/blobs",      // relative to the working directory
  maxBytes: 26214400,        // the largest value, in bytes: at least 25 MiB (the default)
}
```

## Limits

- **Values whole, in memory**: `put` and `get` hold the value (and its copy); no streaming. Raise
  `maxBytes` with the server's memory in mind.
- **A page of `list` walks** the part of the namespace's tree that can hold its keys, then sorts what
  it found: listing a namespace of very many keys a page at a time reads its directories once per
  page.
- **One process per root.** Puts and deletes in one process never race on a directory; a second
  process over the same root is retried a few times when a delete removes a directory under a put,
  but is not what it is built for.
- On macOS a path is at most 1024 bytes: a key of hundreds of upper-case letters under a long root
  can be refused by the system (`ENAMETOOLONG`). Linux allows 4096.
- A crash during a `put` can leave a temporary file (`#<uuid>`) that nothing lists or reads; delete
  it by hand if it matters.

## Removing it

`pikit remove storage-blob-fs` refuses while a component requires `storage.blob`. The directory stays:
it is your data, and deleting it is yours to do.

## Tests

Copied with the component, they run in your project: the `storage.blob` conformance suite (bytes,
copies, replace, concurrent puts, delete, case and nesting, long keys, refused input, namespaces,
order, paging, sizes at `maxBytes`, restarts), the lifecycle suite, the layout on disk, directories
removed on delete, racing puts and deletes, files it did not write (temporary, stray, links out of
the root) never listed, refused keys touching nothing, and the start failure.
