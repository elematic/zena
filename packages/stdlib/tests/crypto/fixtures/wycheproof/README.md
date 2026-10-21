# Wycheproof ECDSA vectors

ECDSA verification vectors for SHA-256 signatures in the IEEE P1363 form
(r and s as two 32-byte numbers), one file per curve, from Project
Wycheproof:

- `ecdsa_secp256r1_sha256_p1363_test.json` (P-256): 262 tests, 173 valid
  and 89 invalid.
- `ecdsa_secp256k1_sha256_p1363_test.json` (secp256k1): 252 tests, 167
  valid and 85 invalid.

Neither file has tests marked "acceptable".

Source: https://github.com/C2SP/wycheproof, directory `testvectors_v1`, at
commit `7a325932231bd7a724c791c8b0d65ea4d6d2f435`. The files are
unmodified copies, so `.prettierignore` skips them.

License: Apache License 2.0
(https://github.com/C2SP/wycheproof/blob/7a325932231bd7a724c791c8b0d65ea4d6d2f435/LICENSE).

`ecdsa_wycheproof_test.zena` verifies every test with high-S signatures
allowed, since Wycheproof counts them as valid, and then checks that the
default strict mode rejects each valid signature whose s is above n / 2.
