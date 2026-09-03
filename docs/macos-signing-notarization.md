# macOS signing & notarization

The compiled macOS `omp` binaries shipped on GitHub Releases can be signed with a
**Developer ID Application** certificate and **notarized** by Apple. This makes
them Gatekeeper-acceptable and is the prerequisite for an official Homebrew
submission (see [#776](https://github.com/can1357/oh-my-pi/issues/776)).

Signing happens in CI in the `release_binary_darwin` matrix legs
(`.github/workflows/ci.yml`), via `scripts/ci-macos-sign.sh`. The workflow step
**auto-skips** unless all five `APPLE_*` repository secrets below are configured,
so releases remain ad-hoc signed when credentials are absent. The script itself
does not skip: invoking it without any required credential is an error.

## How it works

1. `ci:release:build-binaries` builds and **ad-hoc** signs the binary (so it can
   run on the build runner).
2. `scripts/ci-macos-sign.sh` then:
   - imports the Developer ID cert into a throwaway keychain;
   - re-signs with `--options runtime --timestamp` (hardened runtime + secure
     timestamp) and `--entitlements scripts/macos-entitlements.plist`;
   - runs `--version` and `--smoke-test` under the new signature to fail fast;
   - notarizes the binary via `notarytool submit --wait`.
3. `release_github_verify` re-downloads the published arm64 asset, runs
   `codesign --verify --strict` and both launch checks, and—when signing secrets
   are configured—also asserts that the signature is not ad-hoc.

### Why the entitlements are mandatory

The binary is a Bun single-file executable, so the hardened runtime needs:

| Entitlement                                              | Reason                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | JavaScriptCore JITs at runtime.                                                                                                                                                                                                                                                                                               |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JSC executable memory pages.                                                                                                                                                                                                                                                                                                  |
| `com.apple.security.cs.disable-library-validation`       | omp extracts its native addon (`pi_natives.<triple>.node`) and other optional dylibs to a runtime cache and `dlopen()`s them. They do not share the main binary's Team ID, so without this the hardened runtime aborts with _"mapping process and mapped file have different Team IDs"_ — breaking effectively every command. |

Without `disable-library-validation`, a signed+notarized binary signs and
notarizes fine but **fails at first real use**. `scripts/ci-macos-sign.sh` runs
`--smoke-test` after signing specifically to catch this before notarizing.

### Stapling limitation (important)

A bare Mach-O executable **cannot be stapled** (`stapler` only supports
`.app`/`.pkg`/`.dmg`). The binary is genuinely notarized — `notarytool` returns
`Accepted` and the ticket exists on Apple's servers keyed to its cdhash — but
the ticket must be fetched online rather than read from the executable.
`release_github_verify` reports `spctl -a -t exec -vv` for visibility but does
not gate the release on it: an unstapled bare binary can produce a non-zero
assessment when the online ticket is unavailable, which is not by itself a
signing or credential failure.

What this means in practice:

- `curl https://omp.sh/install | sh` — `curl` sets no quarantine bit, so
  Gatekeeper is not consulted.
- Homebrew **formula** installs — Homebrew does not quarantine formula files, so
  Gatekeeper is not consulted.
- Anything that **quarantines** the binary (a browser download, or a Homebrew
  **cask**) needs Apple's online ticket lookup. For an offline-distributable
  artifact, wrap the binary in a stapleable, notarized **`.pkg` or `.dmg`**
  (`xcrun stapler staple` works on those). That is not required for the
  `curl`/formula paths.

## Required GitHub secrets

Add these under **Settings → Secrets and variables → Actions** (repo secrets).
All five secrets (cert, password, and API key trio) must be present for
signing to engage.

| Secret                       | What it is                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12`      | base64 of the exported Developer ID Application `.p12` (cert + private key). |
| `APPLE_CERTIFICATE_PASSWORD` | password you set when exporting the `.p12`.                                  |
| `APPLE_API_KEY_ID`           | App Store Connect API **Key ID**.                                            |
| `APPLE_API_ISSUER_ID`        | App Store Connect API **Issuer ID** (UUID).                                  |
| `APPLE_API_KEY`              | base64 of the App Store Connect `.p8` private key.                           |

### Producing the credential files

Drop these into a working directory (default `~/omp-signing`):

| File                 | How                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.p12`              | **Keychain Access** → right-click your _Developer ID Application: …_ identity (the entry that expands to a cert **with** a private key) → **Export…** → save as `.p12` and set a password.                                              |
| `p12-password.txt`   | the password you just set on the `.p12`.                                                                                                                                                                                                |
| `AuthKey_<KEYID>.p8` | App Store Connect → **Users and Access → Integrations → App Store Connect API** → create a key (**Account Holder** role also allows API cert creation; **Developer** is enough for notarization) → **download once** (non-recoverable). |
| `issuer-id.txt`      | the **Issuer ID** (UUID) shown above the keys table.                                                                                                                                                                                    |
| `key-id.txt`         | _optional_ — the Key ID; otherwise read from the `.p8` filename.                                                                                                                                                                        |

The App Store Connect API key is the one credential that **cannot** be minted
from a CLI — it is the bootstrap credential for the API itself, and the `.p8`
downloads exactly once. Everything else is local.

### Uploading without printing secret values

`scripts/ci-macos-upload-secrets.sh` validates the files (opens the `.p12` with
your password, sanity-checks the `.p8`) and pipes each value to `gh secret set`
over stdin — no secret is ever printed to the terminal, argv, or shell history:

```sh
scripts/ci-macos-upload-secrets.sh ~/omp-signing --dry-run   # validate first
scripts/ci-macos-upload-secrets.sh ~/omp-signing             # upload all five
gh secret list --repo can1357/oh-my-pi                       # confirm
```

Re-run it whenever the certificate is renewed.

### Finding your signing identity / Team ID (sanity check)

```sh
security find-identity -v -p codesigning
# e.g. "Developer ID Application: Your Name (TEAMID1234)"
```

The script selects the first `Developer ID Application` identity automatically;
you do not need to store the identity string or Team ID as a secret.

## Local dry run

You can exercise the full sign+notarize path locally (real cert + API key) by
exporting the five env vars and running:

```sh
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries
APPLE_CERTIFICATE_P12=… APPLE_CERTIFICATE_PASSWORD=… \
APPLE_API_KEY_ID=… APPLE_API_ISSUER_ID=… APPLE_API_KEY=… \
  bash scripts/ci-macos-sign.sh packages/coding-agent/binaries/omp-darwin-arm64
```
