# macOS signing & notarization

The compiled macOS `omp` binaries shipped on GitHub Releases can be signed with a
**Developer ID Application** certificate and **notarized** by Apple. This makes
them eligible for Gatekeeper acceptance when the notarization ticket is
available. The repository also maintains a Homebrew tap; formula installs
have different quarantine behavior from browser downloads (see below).

Like every other release build, the macOS binaries are built and signed on
Linux: the Darwin legs of the `release_binary` matrix
(`.github/workflows/ci.yml`) cross-compile them with bun and sign them with
`scripts/ci-macos-sign.sh`, which drives
[rcodesign](https://github.com/indygreg/apple-platform-rs) (the open-source
implementation of `codesign` and `notarytool`, pinned and sha256-checked by the
script). With all five `APPLE_*` repository secrets below configured, the
script signs with the Developer ID and notarizes; with none, it signs ad hoc
(same entitlements) so releases still run. A partial set is an error.

## How it works

1. `ci:release:build-binaries` cross-compiles the binary on Linux. Bun's own
   signature is not shippable: arm64 gets a bare linker signature, and x86_64
   keeps the Bun runtime's Developer ID signature, which no longer matches the
   appended payload.
2. `scripts/ci-macos-sign.sh` replaces it. With credentials it:
   - signs with the Developer ID certificate, the hardened runtime
     (`--code-signature-flags runtime`), a secure timestamp
     (`--for-notarization`), and `scripts/macos-entitlements.plist`, keeping
     the file name (`omp-darwin-<arch>`) as the signing identifier;
   - packages the binary in a ZIP and submits it with
     `rcodesign notary-submit --wait`, retrying a failed submission up to three
     times. Credential files are removed on exit.
3. `release_smoke` runs each binary on its own hardware (`macos-15-intel`,
   `macos-15`) before anything publishes: `codesign --verify --strict`,
   then `--version` and `--smoke-test` under the final signature, which is the
   hardened-runtime launch check. When signing secrets are configured it also
   asserts that the signature is not ad-hoc. `release_github` publishes these
   same artifacts, so nothing re-verifies the published assets.
4. For non-canary releases, `release_brew` regenerates and pushes the tap formula
   once the GitHub release is published. It skips when
   `HOMEBREW_TAP_DEPLOY_KEY` is absent; that secret is separate from signing.

### Why the entitlements are mandatory

The binary is a Bun single-file executable that also launches Xcode's MCP
bridge, so the hardened runtime needs:

| Entitlement                                              | Reason                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | JavaScriptCore JITs at runtime.                                                                                                                                                                                                                                                                                               |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JSC executable memory pages.                                                                                                                                                                                                                                                                                                  |
| `com.apple.security.automation.apple-events`             | Allows macOS to prompt for Automation permission when `xcrun mcpbridge` connects to Xcode; without it, first-time Xcode MCP initialization hangs until timeout.                                                                                                                                                                |
| `com.apple.security.cs.disable-library-validation`       | omp extracts its native addon (`pi_natives.<triple>.node`) and other optional dylibs to a runtime cache and `dlopen()`s them. They do not share the main binary's Team ID, so without this the hardened runtime aborts with _"mapping process and mapped file have different Team IDs"_ — breaking effectively every command. |

Without `disable-library-validation`, a signed+notarized binary signs and
notarizes fine but **fails at first real use**. `release_smoke` runs
`--smoke-test` under the shipped signature specifically to catch this before
anything publishes.

### Stapling limitation (important)

A bare Mach-O executable **cannot be stapled** (`stapler` only supports
`.app`/`.pkg`/`.dmg`). The binary is genuinely notarized — the notary service
returns `Accepted` and the ticket exists on Apple's servers keyed to its cdhash — but
the ticket must be fetched online rather than read from the executable.
`release_smoke` reports `spctl -a -t exec -vv` for visibility but does
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
  (`rcodesign staple` works on those). That is not required for the
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

### Uploading credential files

`scripts/ci-macos-upload-secrets.sh` requires exactly one `.p12` and one `.p8`,
imports the certificate into a temporary keychain to verify its password and
Developer ID identity, and checks that the `.p8` contains a PEM private-key
header. It pipes each uploaded value to `gh secret set` over stdin rather than
putting it in `gh` arguments or printing the credential payloads. Validation
does pass the certificate password to `security import -P`, so the password
can appear in that subprocess's arguments. The script prints the filenames
and Key ID.

```sh
scripts/ci-macos-upload-secrets.sh ~/omp-signing --dry-run   # validate first
scripts/ci-macos-upload-secrets.sh ~/omp-signing             # upload all five
gh secret list --repo can1357/oh-my-pi                       # confirm
```

Re-run it whenever the certificate is renewed. `OMP_SIGNING_DIR` changes the
default input directory; `OMP_REPO=owner/repo` changes the target repository
(default `can1357/oh-my-pi`). The validation path requires macOS `security`;
uploading also requires an authenticated `gh` CLI.

### Finding your signing identity / Team ID (sanity check)

```sh
security find-identity -v -p codesigning
# e.g. "Developer ID Application: Your Name (TEAMID1234)"
```

The `.p12` carries a single identity, which rcodesign signs with; you do not
need to store the identity string or Team ID as a secret.

## Local dry run

You can exercise the full sign+notarize path on a Linux machine (real cert +
API key) by exporting the five env vars and running:

```sh
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries
APPLE_CERTIFICATE_P12=… APPLE_CERTIFICATE_PASSWORD=… \
APPLE_API_KEY_ID=… APPLE_API_ISSUER_ID=… APPLE_API_KEY=… \
  bash scripts/ci-macos-sign.sh packages/coding-agent/binaries/omp-darwin-arm64
```

Without the env vars the same command signs ad hoc.
