# Responses from the live network

Fetched on 2026-10-21 for the account of atproto.com,
`did:plc:ewvi7nxzyoun6zhxrhs64oiz`:

- `atproto-com-did.json`: its DID document, from
  `https://plc.directory/did:plc:ewvi7nxzyoun6zhxrhs64oiz`.
- `atproto-com-profile.car`: `com.atproto.sync.getRecord` for
  `app.bsky.actor.profile/self`, from the PDS the DID document names,
  `https://enoki.us-east.host.bsky.network`.

The commit in the CAR file is signed with the secp256k1 key in the DID
document, so the pair tests a whole record proof, signature included.
