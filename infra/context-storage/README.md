# Persistent Context S3 Lifecycle

`lifecycle.s3.json` is a deployment template for an explicitly enabled persistent-context remote store. It is not used by the default configuration: `example.local.json` keeps remote storage disabled and names no provider. The in-cluster RustFS service documented under `infra/docs/04-arc-and-caching.md` is only the `sccache` backend; never apply this policy to that bucket.

## Required upload contract

Every remote artifact must be tagged before upload with `legal_hold=false`. The lifecycle rules match both the category prefix and that exact tag; an untagged object intentionally does **not** expire.

When `ContextArtifactPolicy.legalHold` is true, the uploader must set `legal_hold=true` before the object can become eligible for expiry. Never change that tag to `false` until an authorized hold-release workflow completes. Where the selected provider supports S3 Object Lock, it must also apply a legal hold or retention lock; the tag is the lifecycle eligibility gate, not a replacement for immutable retention.

This fail-safe contract prevents ordinary lifecycle expiration from deleting a held artifact. Any provider integration must verify its support for lifecycle prefix-and-tag filters and Object Lock or enforce equivalent hold protection in the application deletion path before this template is applied.

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

## Versioning and Object Lock semantics

Object Lock requires bucket versioning, and on a versioned bucket `Expiration` only writes a delete marker — the data survives as a noncurrent version. The template therefore pairs every expiration with `NoncurrentVersionExpiration` (same day count), which is what actually removes the bytes, and a final prefix-only rule expires lingering delete markers (`ExpiredObjectDeleteMarker` cannot be combined with tag filters or `Days`, so it is a separate untagged rule; it only removes markers with no remaining versions and never deletes data).

Tag filters are evaluated per object version, so a version whose tag is flipped to `legal_hold=true` stops matching both the current-version and noncurrent-version actions. Object Lock retention is the second, independent layer: a locked version cannot be permanently deleted by lifecycle regardless of tags.

## Retention policy

The template contains only expiration rules. It intentionally has no storage-class transitions because no remote provider or cold tier is configured. Do not add AWS-specific storage classes until the selected provider and its minimum-duration billing rules have been verified.
