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
- **Streams** (`putStream`, `getStream`): the chunks are written to the temporary file as they come
  (hashed with `node:crypto`), then synced and renamed as `put` does; a body that fails, is larger
  than `maxStreamBytes` or has another SHA-256 removes the temporary file, and the key is as it was.
  `getStream` reads the file it opened a piece at a time: a value replaced meanwhile is still read
  whole (the open file is the old one). A `get` of a value larger than `maxBytes` is refused.
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
  maxBytes: 26214400,        // the largest whole value (put, get), in bytes: at least 25 MiB (the default)
  maxStreamBytes: 1099511627776, // the largest stream (putStream): at least maxBytes, 1 TiB by default
}
```

## Limits

- **Whole values in memory**: `put` and `get` hold the value (and its copy). Raise `maxBytes` with
  the server's memory in mind; a larger value goes through `putStream` and `getStream`.
- **A page of `list` walks** the part of the namespace's tree that can hold its keys, then sorts what
  it found: listing a namespace of very many keys a page at a time reads its directories once per
  page.
- **One process per root.** Puts and deletes in one process never race on a directory; a second
  process over the same root is retried a few times when a delete removes a directory under a put,
  but is not what it is built for.
- On macOS a path is at most 1024 bytes: a key of hundreds of upper-case letters under a long root
  can be refused by the system (`ENAMETOOLONG`). Linux allows 4096.
- A crash during a `put` or a `putStream` can leave a temporary file (`#<uuid>`) that nothing lists or reads; delete
  it by hand if it matters.

## Removing it

`pikit remove storage-blob-fs` refuses while a component requires `storage.blob`. The directory stays:
it is your data, and deleting it is yours to do.

## Tests

Copied with the component, they run in your project: the `storage.blob` conformance suite (bytes,
copies, replace, concurrent puts, delete, case and nesting, long keys, refused input, namespaces,
order, paging, sizes at `maxBytes`, restarts, streams: their chunks, one larger than `maxBytes`, one
that fails, one with another SHA-256, one past `maxStreamBytes`), the lifecycle suite, a stream that
fails leaving no temporary file, a value replaced while a stream reads it read whole (mutation-checked:
writing a stream straight to the key's file fails the stream cases), the layout on disk, directories
removed on delete, racing puts and deletes, files it did not write (temporary, stray, links out of
the root) never listed, refused keys touching nothing, and the start failure.
