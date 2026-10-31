# Package Host Operations

Every operation the package host offers or will offer: who may do it, where
it is done (a web page, the `zena` command, or an XRPC method), and what
exists today. It is the work list for the host's pages and methods.

The protocol behind these operations (scopes, maintainers, thresholds,
attestations, recovery, moderation) is in
[package-manager.md](package-manager.md); the PDS that hosts packages is
in [pds.md](pds.md). This document does not repeat the rules, only names
the operations and where they live.

## Who acts

- **A visitor** browses without signing in.
- **A person** signs in with their atproto account, at their own PDS
  (`packages/pds-web`, "Signing in"). Everything below a visitor is a
  person in some role.
- **Members of an organization** have a role in its members record:
  `member`, `admin` or `owner`. A **team's maintainers** manage that team.
- **A package's maintainers** are its `publisher`s and `owner`s, named in
  its maintainers record by DID, by commitment to a private entry, or as a
  team.
- **An automation account** publishes from CI with an app password. It
  is a maintainer like any other, marked `automation`.
- **The host's admins** are the DIDs in `PDS_ADMIN_DIDS`. They see every
  account and every private entry, and handle reports and takedowns.
- **The operator** runs the deployment: Cloud Run, Firestore, the
  rotation keys, DNS. The operator acts through `deploy/` and the
  server's own commands (`main.zena`), not through the pages.

Some changes take effect only once enough people approve them. A change
to a maintainers or members record needs `ownerThreshold` owners'
attestations, a change to a team its maintainers' or the organization's
admins', and a release counts once `threshold` maintainers attest it. An
operation marked _threshold_ below starts a pending change, which the
host holds until other people approve it with `zena approve`
(`getPendingChanges`, `completeChange`); with thresholds of 1, the
caller's own approval is enough.

## Where operations live

Each thing has one page: a package, a scope, a person. Those allowed to
act on it see its actions on that page, or on a settings page beside it,
so there is one URL to share for each thing whoever looks at it:

- `/packages/<handle>`, with `/packages/<handle>/settings` for its
  owners: the profile, maintainers, automation, and moving or renaming
  it.
- `/scopes/<name>`, with `/scopes/<name>/settings` for its owners and
  admins: members, teams, and the scope itself.
- `/people/<handle or DID>`: a person's profile, and their public roles
  here.
- `/me` and `/me/settings`: the person signed in, their memberships,
  pending approvals and settings.
- `/admin/...`: the host's work lists, which no single page holds:
  reports, scopes waiting for approval, takedowns, and every account.

The host's admins also see moderation actions (take down, restore,
delete) on the package and scope pages themselves, so a report can be
acted on where the reported thing is shown.

An action that changes the host is a form post to the host, made with
the person's web session. Those forms need a CSRF token: the session
cookie's SameSite=Lax keeps other sites' posts from carrying it, but a
token in each form also covers browsers and subdomains that Lax does not.
An action that is the person's own statement, such as an attestation,
is written to their own repository from the browser, with their OAuth
session, because the host holds nothing that can write there
(package-manager.md, "The management interface").

## Browsing

| Operation                                                  | Who    | Exists                                                   |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------- |
| List and search packages and scopes                        | anyone | `/`, `/scopes/<name>`; `listPackages`, `listScopes`      |
| See a package: profile, versions, retractions, maintainers | anyone | `/packages/<handle>`                                     |
| See a package's dependencies, by handle                    | anyone | `/packages/<handle>`, by handle for packages hosted here |
| See a package's dependents                                 | anyone | no; needs the index (#637)                               |
| See who attested each release                              | anyone | `/packages/<handle>`, for its ten newest releases        |
| See a person's profile and public roles                    | anyone | `/people/<handle or DID>`                                |
| Report a package, release or scope                         | anyone | no; `com.atproto.moderation.createReport`                |

## People and accounts

| Operation                                   | Who      | Exists                                            |
| ------------------------------------------- | -------- | ------------------------------------------------- |
| Sign in and out of the pages                | a person | the pages (`createWebSession`)                    |
| Sign in to `zena`                           | a person | `zena login`, with an app password; OAuth to come |
| See your scopes, teams and packages         | a person | `/me`; `getMemberships`                           |
| Edit your profile: name, description, links | a person | no                                                |
| See approvals waiting for you               | a person | no                                                |
| Register approval keys (passkeys)           | a person | no                                                |

## Scopes and organizations

| Operation                                            | Who                                        | Exists                                                                           |
| ---------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Create a scope                                       | a person the host allows                   | `zena scope create`; `createOrganization`                                        |
| Approve a scope request                              | host admins                                | no; `create-scope` for the operator                                              |
| Claim a scope by domain or GitHub org                | a person                                   | no                                                                               |
| See a scope's members and teams                      | members; owners and admins see all         | `/scopes/<name>`; `zena scope members`, `getEntries`                             |
| See and approve changes waiting                      | members; owners and admins approve         | `zena approve @<scope>`; `getPendingChanges`, `completeChange`, `withdrawChange` |
| Add, remove and change members' roles                | owners (_threshold_)                       | `zena scope add --role`, `scope remove`; `putMembers`                            |
| Create, change and delete teams                      | admins; a team's maintainers (_threshold_) | `zena team`; `putTeam`, `deleteTeam`                                             |
| Change the scope's thresholds                        | owners (_threshold_)                       | `zena scope settings`; `putMembers`                                              |
| Set minimums and defaults for the scope's packages   | owners (_threshold_)                       | `zena scope policy`; `putPolicy`                                                 |
| Let a team create packages                           | owners (_threshold_)                       | `zena scope policy --creators`; `putPolicy`                                      |
| Edit the scope's profile: name, description, website | admins                                     | `zena scope profile`; `putScopeProfile`                                          |
| Rename a scope                                       | owners, host admins                        | no                                                                               |
| Dissolve a scope                                     | owners, host admins                        | no                                                                               |
| Create an automation account                         | admins                                     | `zena ci create`; `createAutomationAccount`                                      |
| Reset or revoke an automation account's app password | admins                                     | no                                                                               |

## Packages

| Operation                                        | Who                                | Exists                                                          |
| ------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| Create a package                                 | admins, or a team they allow       | `zena package create`, `zena publish`; `createPackage`          |
| Edit the profile: description, license, links    | owners                             | no; `putProfile` is designed                                    |
| Add and remove maintainers and owners            | owners (_threshold_)               | `zena owner add --role`, `owner remove`; `putMaintainers`       |
| See and approve changes of maintainers waiting   | maintainers; owners approve        | `zena approve <package>`; `getPendingChanges`, `completeChange` |
| Add a team as maintainers                        | owners (_threshold_)               | `zena owner add --team`; `putMaintainers`                       |
| Add a collaborator from outside the scope        | owners (_threshold_)               | `zena owner add <handle or DID>`; `putMaintainers`              |
| Change the thresholds                            | owners (_threshold_)               | `zena owner settings`; `putMaintainers`                         |
| Rename the package                               | owners                             | no; `renamePackage` is designed                                 |
| Move it to another scope on the host             | owners, and the new scope's admins | no                                                              |
| Move it to another host                          | owners (_threshold_)               | no; designed, without methods                                   |
| Deprecate it, with a pointer to a replacement    | owners                             | no                                                              |
| Recover it (reset maintainers via recovery keys) | recovery key holders               | no; designed                                                    |
| See its PLC history and recovery keys            | anyone                             | no                                                              |

## Releases

| Operation                          | Who                       | Exists                                                                            |
| ---------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Publish a release                  | maintainers               | `zena publish`; `uploadArtifact`, `publish`, `completeRelease`                    |
| See releases waiting for approval  | maintainers               | `zena approve`; the package page and `/me`; `getPendingReleases`                  |
| Approve a release                  | maintainers (_threshold_) | `zena publish` attests its own, `zena approve --yes` another's; `completeRelease` |
| Withdraw a release before approval | its publisher, owners     | `withdrawRelease`                                                                 |
| Retract a release, with a reason   | maintainers               | `zena retract`; `retract`                                                         |
| Withdraw a retraction              | maintainers               | no                                                                                |

## Moderation

These are the host's admins' work, on the pages. Each is described in
package-manager.md, "Reports and takedowns".

| Operation                                    | Exists                                   |
| -------------------------------------------- | ---------------------------------------- |
| See every account                            | `/admin`                                 |
| See every private entry                      | the scope and package pages, as an admin |
| Read and close reports                       | no                                       |
| Take down a release, package or organization | no                                       |
| Restore what was taken down                  | no                                       |
| Delete a release for a legal notice          | no                                       |
| Refuse a maintainer's requests               | no                                       |
| Reserve scope names                          | `PDS_RESERVED_SCOPES`, by the operator   |
| Label what was taken down, and why           | no; needs the labeler                    |
| See a log of admin actions                   | no                                       |

The three ways to remove a release differ in who does it and what stays:

- **A retraction** is the maintainers'. The release and its artifact stay
  and are served; choosing a version skips it, and builds that pinned it
  keep working.
- **A takedown** is the host's admins'. The record and blob stay in
  storage, but the host stops serving them, and the labeler says why. It
  can be undone.
- **A deletion** is for a legal notice that requires the content to be
  gone. The host deletes the record and the blob, and the blocks of the
  record from storage. The checksum log keeps the release's CIDs, which
  are hashes, not the content. It cannot be undone.

## The operator

| Operation                                  | Exists                               |
| ------------------------------------------ | ------------------------------------ |
| Deploy, set up keys and secrets            | `deploy/` (`deploy:setup`, `deploy`) |
| Make the offline rotation key              | `main.zena generate-key`             |
| Undo a misused online key's PLC operations | `main.zena plc-restore`              |
| Create a scope for an organization         | `main.zena create-scope`             |
| Rewrite every handle's DNS records         | `main.zena sync-handles`             |
| Rewrite every package's summary            | `main.zena sync-indexes`             |
| Encrypt signing keys kept in the clear     | `main.zena encrypt-keys`             |
| Name the host's admins                     | `PDS_ADMIN_DIDS`                     |
