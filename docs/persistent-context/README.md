# Persistent Screen Context

Persistent screen context is an **exclusively opt-in** OMPK capability. Desktop Tag remains transient by default: manual capture is sent to the agent and discarded without initializing persistent storage.

## Foundations merged now

- `@pk-nerdsaver-ai/pi-context-policy` supplies consent admission and retention primitives.
- `@pk-nerdsaver-ai/pi-context-storage` supplies artifact-store contracts and disk-pressure admission controls.
- The default retention policy is disabled by default and remote storage defaults to disabled.
- S3-compatible lifecycle guidance is under `infra/context-storage/`.

No Desktop Tag capture, Mnemopi ingestion, remote storage adapter, audit ledger, agent tool, or UI control is enabled by this foundation. Those integrations must each preserve the opt-in guarantees below before they are wired in.

## Opt-in guarantees

- Persistent context is disabled by default.
- No persistence occurs without explicit, verified user consent.
- Remote upload requires separate opt-in and encryption.
- The agent cannot enable persistent context on the user's behalf.
- Revocation stops persistent capture before cleanup begins.
- Raw screen content is never inserted into prompts or directly enumerable by the agent.
- Transient Desktop Tag capture remains fully supported.

See [architecture](ARCHITECTURE.md), [opt-in UX](OPT_IN_UX.md), [operations](OPERATIONS.md), and [acceptance criteria](ACCEPTANCE_TESTS.md).
