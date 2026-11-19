## package-manager

### Added

- A dependency on a package on disk can give the range it is published with beside its path, `{"path": "../semver", "version": "~0.0.3"}`. `Manifest.pathRanges` holds the ranges, `publishedRange` gives the range a release states for a path dependency, and `writeDependencies` keeps a range the file has.

## cli

### Added

- `zena pkg publish` publishes a path dependency with the range its entry gives in `version`, and refuses a range that leaves out the version at the path. Without one it publishes `^` that version.
