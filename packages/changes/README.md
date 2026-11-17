# changes

Reads the change files in `.changes/` and works out the next release of
each package in this repository. The design is
[docs/design/change-files.md](../../docs/design/change-files.md), and
[.changes/README.md](../../.changes/README.md) says how to write a change
file.

Run it from the repository root, after `npm run build -w @zena-lang/zena-cli`:

```sh
npm run changes -- status   # the entries waiting, and the versions they would give
npm run changes -- check    # what is wrong with .changes/, exit 1 when anything is
```

`status` prints each group and independent package that has entries:

```
toolchain 0.0.2 -> 0.0.3
  zena-cli
    Added
      - Raw mode.
  no changes: zena-compiler, zena-runtime

terminal 0.3.1 -> 0.3.2
  Added
    - Prompts.
```

The commands that make a release (`version`) and write a change file
(`add`) are not built yet.
