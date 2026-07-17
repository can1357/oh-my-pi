# Persistent Context S3 Lifecycle

`lifecycle.s3.json` is a deployment template for an explicitly enabled persistent-context remote store. It is not used by the default configuration: `example.local.json` keeps remote storage disabled and names no provider. The in-cluster RustFS service documented under `infra/docs/04-arc-and-caching.md` is only the `sccache` backend; never apply this policy to that bucket.

## Required upload and hold contract

**Deployment decision:** AWS S3 deployments of this store require an Object-Lock-enabled bucket with versioning enabled. Providers without S3 Object Lock are acceptable only when they provide equivalent per-version WORM retention and legal-hold semantics. Immutable hold protection is mandatory; the AWS feature itself is not mandatory for non-AWS providers.

Do not configure blanket bucket-default retention. Categories have different expiry windows, and `workflow_state` cannot calculate its retention deadline until a case closes. If an uploader applies a finite Object Lock retention period to a fixed-TTL artifact, its `RetainUntilDate` must be no later than the artifact's policy `expiresAt`. The same upper bound applies once a case-closed deadline is known. A native legal hold is the authorized exception and may outlive the ordinary expiry window until an authorized release.

Every ordinary remote artifact must be uploaded with `legal_hold=false`. When `ContextArtifactPolicy.legalHold` is true, the upload request must instead set `legal_hold=true` and native Object Lock Legal Hold to `ON` (or the provider equivalent) before the artifact is accepted as durable. A finite retention lock is not a substitute for a legal hold. If either state cannot be applied, reject the upload rather than storing a partially protected artifact.

An authorized hold-release workflow must operate on the same object version: release the native legal hold, then set its `legal_hold` tag to `false` so ordinary lifecycle expiry resumes. If either step fails, the release is incomplete and the version must remain lifecycle-ineligible; record and remediate the failure before treating the hold as released.

The tag is the lifecycle eligibility gate; native Object Lock is the immutable enforcement layer. Provider integration must verify versioning, lifecycle prefix-and-tag filters, per-version retention, legal holds, and version-specific hold release before applying this template.

## Canonical category-to-prefix mapping

Key prefixes are the `ContextCategory` names from `@pk-nerdsaver-ai/context-policy` verbatim (`<category>/`), via `remotePrefixForCategory()`. Uploaders and lifecycle rules must both derive prefixes from that function; `packages/context-policy/test/remote-lifecycle.test.ts` asserts this template matches the policy exactly, so a policy TTL change without a template update fails the suite.

| Category | Prefix | Expiration |
|---|---|---|
| `temporary` | `temporary/` | 7 days |
| `quarantine` | `quarantine/` | 14 days |
| `raw_capture` | `raw_capture/` | 30 days |
| `error_log` | `error_log/` | 60 days |
| `extracted_text` | `extracted_text/` | 90 days |
| `session_summary` | `session_summary/` | 90 days |
| `preference` | `preference/` | 365 days |
| `audit_action` | `audit_action/` | 730 days |
| `workflow_state` | `workflow_state/` | none (case-closed + 30 days, application-driven) |
| `final_deliverable` | `final_deliverable/` | none (governed, application-driven) |

`workflow_state` and `final_deliverable` deliberately have **no** static rule: their retention depends on case state or governance decisions that a bucket lifecycle cannot evaluate. The application deletion path owns them.

## Versioning, lifecycle, and Object Lock semantics

On a versioned bucket, `Expiration` makes the current version noncurrent by writing a delete marker; it does not remove the bytes. Every fixed-TTL rule therefore also uses `NoncurrentVersionExpiration`. AWS measures `NoncurrentDays` from the time a version becomes noncurrent—not from object creation. The template uses the category day count for both actions so an overwritten version retains the full category recovery window after replacement. Consequently, when lifecycle itself creates the delete marker at the current-version deadline, permanent deletion becomes eligible only after a second category-length interval; this bounded cleanup is not an exact erasure deadline.

S3 lifecycle dates are eligibility dates, not exact deletion deadlines: evaluation and removal are asynchronous, and day calculations round to midnight UTC. A deployment with a hard deletion SLA must explicitly delete eligible versions after lock release and verify removal with `ListObjectVersions` or S3 Inventory rather than relying on lifecycle alone.

The final prefix-only rule removes expired delete markers after all versions are gone. `ExpiredObjectDeleteMarker` cannot be combined with tag filters or `Days`, so this cleanup must remain a separate untagged action; it never deletes object data.

Object Lock remains authoritative over lifecycle. A locked version cannot be permanently deleted before its retention date, and an active legal hold blocks deletion indefinitely. This is why finite retention must not extend beyond the category deadline and why legal holds are documented exceptions. Tag filters are evaluated per version; changing `legal_hold` never bypasses native lock state.

## Retention policy

The template contains only expiration rules. It intentionally has no storage-class transitions because no remote provider or cold tier is configured. Do not add AWS-specific storage classes until the selected provider and its minimum-duration billing rules have been verified.
