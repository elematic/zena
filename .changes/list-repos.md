## pds

### Added

- `com.atproto.sync.listRepos`: every account's repository, its head and its revision, in the order of the accounts' DIDs, a page at a time. Relays crawl a PDS with it, and explorers list its accounts.
- `Storage.listAccounts`, in memory and in Firestore.

## atproto

### Added

- `SYNC_LIST_REPOS` in `atproto/methods`.
