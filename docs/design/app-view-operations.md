# App View Operations

Every operation the App View offers or will offer: who may do it, where
it is done (a web page, the `zena` command, or an XRPC method), and what
exists today. It is the work list for the App View's pages and methods.

The protocol behind these operations (scopes, maintainers, thresholds,
attestations, recovery, moderation) is in
[package-manager.md](package-manager.md). The App View is a service of its
own there, which keeps its accounts on a PDS ("Managed accounts"); the
PDS written in Zena, which holds them today, is in [pds.md](pds.md). This
document does not repeat the rules, only names the operations and where
they live.

## Who acts

- **A visitor** browses without signing in.
- **A person** signs in with their atproto account, at their own PDS
  (`packages/pds-web`, "Signing in"). Everything below a visitor is a
  person in some role.
- **A scope's maintainers** are its `owner`s and `publisher`s, named in its
  maintainers record by DID, by commitment, or as a team. Publishers create
  packages in the scope; owners also change the scope and any of its
  packages' maintainers.
- **An organization** is a scope with members and teams. Its **owners**
  are its own scope's owners, and its **members** are the people its teams
  are made of. A **team's maintainers** manage that team.
- **A package's maintainers** are its `publisher`s and `owner`s, named in
  its maintainers record by DID, by commitment to a private entry, or as a
  team.
- **An automation account** publishes from CI with a token its App View
  issues; today, with an app password at the PDS. It is a maintainer like
  any other, marked `automation`.
- **The App View's admins** are the DIDs in `APP_VIEW_ADMIN_DIDS`. They see every
  account and every private entry, and handle reports and takedowns.
- **The operator** runs the deployment: Cloud Run, Firestore, the
  rotation keys, DNS. The operator acts through `deploy/` and the
  server's own commands (`main.zena`), not through the pages.

Some changes take effect only once enough people approve them. A change
to a maintainers record needs `ownerThreshold` owners' attestations (for a
package's, its own owners' or its scope's), a change to an organization's
members or teams its scope's owners' or the team's maintainers', and a
release counts once `threshold` maintainers attest it. An
operation marked _threshold_ below starts a pending change, which the
App View holds until other people approve it with `zena pkg approve`
(`getPendingChanges`, `completeChange`); with thresholds of 1, the
caller's own approval is enough.

## Where operations live

Each thing has one page: a package, a scope, a person. Those allowed to
act on it see its actions on that page, or on a settings page beside it,
so there is one URL to share for each thing whoever looks at it:

- `/packages/<handle>`, with `/packages/<handle>/settings` for its
  owners: the profile, maintainers, automation, and moving or renaming
  it.
- `/scopes/<name>`, with `/scopes/<name>/settings` for its owners: its
  maintainers, its policy and profile, and for an organization, its
  members, teams and the scopes that belong to it.
- `/people/<handle or DID>`: a person's profile, and their public roles
  here.
- `/me` and `/me/settings`: the person signed in, their memberships,
  pending approvals and settings.
- `/admin/...`: the App View's work lists, which no single page holds:
  reports, scopes waiting for approval, takedowns, and every account.

The App View's admins also see moderation actions (take down, restore,
delete) on the package and scope pages themselves, so a report can be
acted on where the reported thing is shown.

An action that changes the App View is a form post to the App View, made
with the person's web session. Those forms need a CSRF token: the session
cookie's SameSite=Lax keeps other sites' posts from carrying it, but a
token in each form also covers browsers and subdomains that Lax does not.
An action that is the person's own statement, such as an attestation, is
written to their own repository from the browser, with their OAuth
session, because the App View holds nothing that can write there
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

| Operation                                   | Who      | Exists                                          |
| ------------------------------------------- | -------- | ----------------------------------------------- |
| Sign in and out of the pages                | a person | the pages (`createWebSession`)                  |
| Sign in to `zena`                           | a person | `zena pkg login`, with OAuth or an app password |
| See your scopes, teams and packages         | a person | `/me`; `getMemberships`                         |
| Edit your profile: name, description, links | a person | no                                              |
| See approvals waiting for you               | a person | no                                              |
| Register approval keys (passkeys)           | a person | no                                              |

## Scopes and organizations

These rows follow package-manager.md, "Scopes": a scope's maintainers
record decides who acts on it, and an organization is a scope with members
and teams.

| Operation                                            | Who                                                                                      | Exists                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Create a scope                                       | a person the App View allows                                                             | `zena pkg scope create`; `createScope`                                                                                      |
| List who may create scopes, while only those may     | App View admins                                                                          | `zena pkg admin`; `putScopeCreator`, `listScopeCreators`; seen on `/admin`                                                  |
| Approve a scope request                              | App View admins                                                                          | no; `create-scope` for the operator                                                                                         |
| Claim a scope by domain or GitHub org                | a person                                                                                 | no                                                                                                                          |
| See a scope's maintainers                            | its maintainers; owners see all                                                          | `/scopes/<name>`, `zena pkg scope maintainers`; `getEntries`                                                                |
| See and approve changes waiting                      | maintainers; owners approve                                                              | `zena pkg approve <scope>`; `getPendingChanges`, `completeChange`, `withdrawChange`                                         |
| Add and remove owners and publishers                 | owners (_threshold_)                                                                     | `zena pkg scope add --role`, `scope remove`; `putScopeMaintainers`                                                          |
| Change the scope's thresholds                        | owners (_threshold_)                                                                     | `zena pkg scope settings`; `putScopeMaintainers`                                                                            |
| Set minimums and defaults for the scope's packages   | owners (_threshold_)                                                                     | `zena pkg scope policy`; `putPolicy`                                                                                        |
| Change any of the scope's packages' maintainers      | owners (_threshold_)                                                                     | `zena pkg owner`; `putMaintainers`, approved by the package's owners or the scope's                                         |
| Edit the scope's profile: name, description, website | owners                                                                                   | `zena pkg scope profile`; `putScopeProfile`                                                                                 |
| Upgrade a scope to an organization                   | owners (_threshold_)                                                                     | `zena pkg scope upgrade`; `upgradeScope`                                                                                    |
| Add and remove an organization's members             | the organization's owners (_threshold_)                                                  | `zena pkg org add`, `org remove`, `org members`; `putMembers`                                                               |
| Create, change and delete teams                      | the organization's owners; a team's maintainers (_threshold_)                            | `zena pkg team`; `putTeam`, `deleteTeam`                                                                                    |
| Put a scope in an organization, or take it out       | joining, the scope's owners and the organization's; leaving, either side's (_threshold_) | `zena pkg scope join`, `scope leave`; `putScopeOrganization`, which takes a scope out at once, for one owner of either side |
| Rename a scope                                       | owners, the operator                                                                     | no; `renameScope` is designed                                                                                               |
| Reclaim a scope no one uses, or one in dispute       | the operator                                                                             | no; package-manager.md, "Changing names"                                                                                    |
| Release a name a rename reserved, in the scope       | owners, the package that held it                                                         | no; `releaseName` is designed (package-manager.md, "Changing names")                                                        |
| Dissolve a scope                                     | owners, App View admins                                                                  | no                                                                                                                          |
| Create an automation account                         | owners                                                                                   | `zena pkg ci create`; `createAutomationAccount`                                                                             |
| Reset or revoke an automation account's token        | owners                                                                                   | `zena pkg ci token`; `issueAutomationToken`, which replaces it                                                              |
| Retire an automation account                         | owners                                                                                   | `zena pkg ci retire`; `retireAutomationAccount`, refused while maintainers name it                                          |

## Packages

| Operation                                        | Who                                         | Exists                                                              |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| Create a package                                 | the scope's publishers and owners           | `zena pkg create`, `zena pkg publish`; `createPackage`              |
| Edit the profile: description, license, links    | owners                                      | no; `putProfile` is designed                                        |
| Add and remove maintainers and owners            | owners, or the scope's owners (_threshold_) | `zena pkg owner add --role`, `owner remove`; `putMaintainers`       |
| See and approve changes of maintainers waiting   | maintainers; owners approve                 | `zena pkg approve <package>`; `getPendingChanges`, `completeChange` |
| Add a team as maintainers                        | owners (_threshold_)                        | `zena pkg owner add --team`; `putMaintainers`                       |
| Add a collaborator from outside the scope        | owners (_threshold_)                        | `zena pkg owner add <handle or DID>`; `putMaintainers`              |
| Change the thresholds                            | owners (_threshold_)                        | `zena pkg owner settings`; `putMaintainers`                         |
| Rename the package                               | owners                                      | no; `renamePackage` is designed                                     |
| Release the name a rename left it                | owners                                      | no; `releaseName` is designed                                       |
| Move it to another scope on the App View         | owners, and the new scope's owners          | no                                                                  |
| Move it to another App View                      | owners (_threshold_)                        | no; designed, without methods                                       |
| Deprecate it, with a pointer to a replacement    | owners                                      | no                                                                  |
| Recover it (reset maintainers via recovery keys) | recovery key holders                        | no; designed                                                        |
| See its PLC history and recovery keys            | anyone                                      | no                                                                  |

## Releases

| Operation                          | Who                       | Exists                                                                                    |
| ---------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| Publish a release                  | maintainers               | `zena pkg publish`; `uploadArtifact`, `publish`, `completeRelease`                        |
| See releases waiting for approval  | maintainers               | `zena pkg approve`; the package page and `/me`; `getPendingReleases`                      |
| Approve a release                  | maintainers (_threshold_) | `zena pkg publish` attests its own, `zena pkg approve --yes` another's; `completeRelease` |
| Withdraw a release before approval | its publisher, owners     | `withdrawRelease`                                                                         |
| Retract a release, with a reason   | maintainers               | `zena pkg retract`; `retract`                                                             |
| Withdraw a retraction              | maintainers               | no                                                                                        |

## Moderation

These are the App View's admins' work, on the pages. Each is described in
package-manager.md, "Reports and takedowns".

| Operation                                 | Exists                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| See every account                         | `/admin`                                                |
| See every private entry                   | the scope and package pages, as an admin                |
| See which `zena` published each release   | the package page, as an admin                           |
| Read and close reports                    | no                                                      |
| Take down a release, package or scope     | no                                                      |
| Restore what was taken down               | no                                                      |
| Delete a release for a legal notice       | no                                                      |
| Refuse a maintainer's requests            | no                                                      |
| Reserve scope names                       | `APP_VIEW_RESERVED_SCOPES`, by the operator             |
| Let only listed accounts create scopes    | `APP_VIEW_SCOPE_CREATORS`, by the operator              |
| Label what was taken down, and why        | no; needs the labeler                                   |
| See a log of operations and refused calls | `/admin/log` (operations) and `CallLog` (refused calls) |

The three ways to remove a release differ in who does it and what stays:

- **A retraction** is the maintainers'. The release and its artifact stay
  and are served; choosing a version skips it, and builds that pinned it
  keep working.
- **A takedown** is the App View's admins'. The record and blob stay in
  storage, but the App View stops serving them, and the labeler says why. It
  can be undone.
- **A deletion** is for a legal notice that requires the content to be
  gone. The App View deletes the record and the blob, and the blocks of the
  record from storage. The checksum log keeps the release's CIDs, which
  are hashes, not the content. It cannot be undone.

## The operator

| Operation                                  | Exists                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| Deploy, set up keys and secrets            | `deploy/` (`deploy:setup`, `deploy`)                   |
| Back up the data, and watch the services   | `deploy:setup` (backups), `deploy:alerts`              |
| Check a deploy                             | `deploy:smoke`                                         |
| Make the offline rotation key              | `main.zena generate-key`                               |
| Undo a misused online key's PLC operations | `main.zena plc-restore`                                |
| Create a reserved scope                    | `main.zena create-scope`, through `deploy/operator.sh` |
| Rewrite every handle's DNS records         | `main.zena sync-handles`                               |
| Rewrite the summaries and mentions indexes | `main.zena sync-indexes`                               |
| Raise a limit for a package, scope, caller | `main.zena set-limit`, through `deploy/operator.sh`    |
| Name the App View's admins                 | `APP_VIEW_ADMIN_DIDS`                                  |
