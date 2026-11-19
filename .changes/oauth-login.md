## cli

### Added

- `zena pkg login <handle or DID>` signs in with atproto OAuth, in the browser. The registry's sign-in page hands the answer back to `zena`; with `--no-browser`, or where there is no browser to open, as over SSH, it shows a line to paste into the terminal. `BROWSER` names the command that opens the address. An app password also signs in, from `--password-stdin` or `ZENA_APP_PASSWORD`.
- `zena pkg logout` revokes an OAuth session at the PDS.
- When an OAuth session has ended, after two weeks or once revoked, the commands that act as you say to sign in again with `zena pkg login`.

## atproto

### Added

- `OAuthSession.refreshGuard`, a `RefreshGuard` that a refresh runs under, such as a lock on the file the session is kept in, and `OAuthSession.takeTokens`, for a session another program refreshed.
- `AccountSession.refreshed`, `handleOrDid()` and `toJson()`.

## package-manager

### Added

- `testing/fake-oauth`: revoking a refresh token ends its session's access tokens too, as a PDS does.
