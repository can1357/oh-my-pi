# Architecture

```text
User explicitly enables Persistent Context
        |
        v
Consent Registry
        |
        v
Capture Admission Gate
  - identity
  - scope
  - app allowlist
  - rate limit
  - disk reserve
  - session budget
        |
        v
Event-Driven Capture
  - accessibility/DOM
  - window metadata
  - optional screenshot
        |
        v
In-Memory Redaction and Classification
        |
        +---- reject prohibited content
        |
        +---- quarantine uncertain content
        |
        v
Hash, Diff, and Deduplicate
        |
        v
Encrypted Artifact Store
        |
        +---- processed text / summaries ----> Mnemopi
        |
        +---- audit event --------------------> Audit Ledger
        |
        v
Policy-Guarded Retrieval
```

## Trust boundaries

- **Device:** raw screen data is captured and redacted locally; remote storage receives only encrypted artifacts.
- **User:** ownership is part of every artifact authorization key; cross-user reads are denied.
- **Project and case:** project and workflow-case identifiers are authorization inputs, not optional search metadata.
- **Agent:** only processed, redacted, provenance-bearing context can reach the agent; raw storage cannot be enumerated directly.

## Package ownership

- `packages/context-policy`: canonical types, consent admission, policy evaluation, retention calculation, and deletion planning.
- `packages/desktop-tag/src/persistent-context`: future consent controls, event observers, in-memory capture, redaction, deduplication, and status indicators.
- `packages/context-storage`: encrypted local store and optional remote adapters.
- `packages/mnemopi/src/policy`: future retention metadata, retrieval guards, lineage, expiry sweeps, and cascading deletion.
- `packages/audit-ledger`: future append-only consent, capture, retrieval, and deletion events.

The no-persistence path remains `manual capture -> in-memory image -> agent turn -> discard` and must never initialize persistent-context storage.
