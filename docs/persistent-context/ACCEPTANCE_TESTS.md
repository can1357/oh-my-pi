# Acceptance Criteria

## Consent

- Persistent context is disabled on first launch.
- No durable artifact is created before explicit consent.
- The agent cannot enable consent by tool call.
- Session-only consent expires when its session ends.
- Revocation prevents the next persistent capture.
- Remote upload remains disabled until separately enabled.

## Storage safety

- A write is rejected before it violates the free-space reserve.
- Raw persistence stops at critical pressure.
- Non-audit writes stop in emergency pressure.
- Capture queues are bounded.
- Duplicate screenshots do not duplicate blobs.
- Startup removes orphaned temporary files.
- A crash cannot create unbounded temporary files or WAL growth.

## Privacy and retrieval

- Password and secret regions are excluded.
- Classification failures enter encrypted quarantine.
- Raw artifacts never enter prompts.
- Cross-user and cross-project reads are denied by default.
- Retrieved fragments include provenance.
- Retrieval obeys token and byte caps before large object reads.

## Retention

- Every artifact has a category and expiration.
- Expiry removes database rows, blobs, embeddings, and summaries.
- Legal hold blocks ordinary expiry.
- User deletion cascades to derived artifacts unless a valid legal hold applies.
- Deletion produces a verifiable receipt.
