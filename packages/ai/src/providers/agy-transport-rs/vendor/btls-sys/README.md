# Low-level bindings to BoringSSL

[BoringSSL](https://boringssl.googlesource.com/boringssl) is Google's fork of OpenSSL for Chrome/Chromium and Android.

This crate builds the BoringSSL library (or optionally links a pre-built version) and generates FFI bindings for it.
It supports [FIPS-compatible builds of BoringSSL](https://boringssl.googlesource.com/boringssl/+/master/crypto/fipsmodule/FIPS.md),
as well as [Post-Quantum crypto](https://datatracker.ietf.org/doc/draft-ietf-tls-ecdhe-mlkem/)
and [Raw Public Key](https://docs.rs/btls/latest/btls/ssl/struct.SslRef.html#method.peer_pubkey) extensions.

To use BoringSSL from Rust, prefer the [higher-level safe API](https://docs.rs/btls).

## Local measured-ClientHello fork

The bundled `deps/boringssl` remains pristine. Its source is the `btls-sys`
0.5.6 crate (SHA-256
`9b1b8638a2e1c38a5ae4efa90ae57e643baec35a30d03fc5b399b893adc4954b`),
from btls revision `4edbf5d716ba014384569ac5c631cea83827abfc`, whose BoringSSL
gitlink is
[`91a66a59b6c1435120ff83e245d7719411294386`](https://github.com/google/boringssl/tree/91a66a59b6c1435120ff83e245d7719411294386).
Do not edit the bundled C/C++ files in place or build against an assumed-patched
tree when checking reproducibility.

`build/main.rs` copies that source to its output directory and applies:

1. `boring-pq.patch`
2. `boringssl.patch`
3. `boringssl-loongarch.patch`
4. `boringssl-windows.patch`
5. `agy-clienthello.patch`

The optional `underscore-wildcards.patch` still follows this stack. The fifth
patch is generated against the source after the first four, with their existing
whitespace-fix behavior. The first four patches are unchanged.

The local `btls`/`wreq` bindings expose real extension ordering, explicit
`tls13_ciphers_last`, and separate `cert_sigalgs` (extension `0x0032`) settings.
The signature and group wire-advertisement APIs retain unsupported IDs only in
ClientHello; the implemented subset remains the negotiation/verification list.
Strict existing native setters, key-share checks, signature/key compatibility
checks, and certificate verification are retained. The extension-order shuffle
also fixes an out-of-bounds seed index and avoids randomization when disabled.
The connector requires DNS subjectAltName instead of falling back to Common
Name, matching Go hostname-verification policy.

### Clean capture and comparison

Run from the checkout root in WSL, with no other target-qualified
`BORING_BSSL_*` overrides in the environment:

```sh
target="$(mktemp -d /tmp/agy-wreq-probe.XXXXXX)"
printf 'Fresh CARGO_TARGET_DIR=%s\n' "$target"
env -u BORING_BSSL_PATH -u BORING_BSSL_SOURCE_PATH -u BORING_BSSL_ASSUME_PATCHED \
  CARGO_TARGET_DIR="$target" \
  cargo run --locked --release --target x86_64-unknown-linux-gnu \
  --manifest-path agy/wreq-probe/Cargo.toml \
  -- "$PWD/agy/wreq-probe/captured-hello-clean.bin"
```

Then run the existing comparator from the checkout root (Windows Bun is also
suitable):

```sh
bun agy/hello-diff.ts agy/reference-hello.bin agy/wreq-probe/captured-hello-clean.bin
```

The probe reads the complete TLS record rather than assuming one TCP read
contains it, disables proxy routing, and keeps certificate and hostname checks
enabled. Its loopback peer intentionally aborts before authentication. It does
not contact a production service. A successful capture is not a successful TLS
negotiation. The reference contains 1,528 bytes and extension `0x0032` contains
15 algorithms, including the three ML-DSA IDs and trailing `0x0201`, `0x0203`.
The pre-repair capture was reported as **9/12**, not 11/12, structurally equal.
Only a fresh capture and actual comparator output establish the new result.

The fifth patch adds `SSLTest.ClientHelloAdvertisementsPreserveValidation`
and `SSLTest.ClientHelloTLS13CiphersLast`; the sixth adds ML-DSA TLS and
X.509 tests; the seventh adds P-256/ML-KEM-768 and P-384/ML-KEM-1024
negotiation, HelloRetryRequest, and rejection tests. The `btls` connector
tests cover SAN-only hostname verification.

Clean Linux and Windows captures of the same local fixture are 1,528 bytes
each. All 12 structural fields, JA3, JA4, and every invariant record byte
match the reference after masking only random, session, and ephemeral key
share bytes. The capture server closes before TLS authentication.

### Security and compatibility gate

The new native TLS cases pass, and a Windows Rust helper successfully
completes verified TLS 1.3 requests to independent Go servers that select
groups `0x11eb` and `0x11ed` (both via HelloRetryRequest) or serve
ML-DSA44/65/87 certificate chains. That validates those local cases, not
all servers, platform trust semantics, attestation, or account standing.
The upstream four-patch baseline and this fork have the same five existing
failures in the full `ssl_test` suite; the new targeted cases pass.

wreq's static Mozilla roots are not Go's system trust store. The Rust helper
imports system roots plus `NODE_EXTRA_CA_CERTS` and keeps certificate and
hostname verification enabled; native OS chain-policy equivalence and
production request behavior still require evidence before replacing Go.

## Contribution

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in the work by you, as defined in the Apache-2.0
license, shall be dual licensed under the terms of both the Apache License,
Version 2.0 and the MIT license without any additional terms or conditions.
