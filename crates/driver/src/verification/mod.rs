//! Source-bound verification policy owned by the production driver.
//!
//! Evaluates an explicit inventory of host-observed checks and captures native
//! source/context identities for conservative applicability keys. Retains
//! evidence through the existing session journal and blob CAS.
//! It performs no check execution, model inference or commit admission.
//! Callers must validate evidence provenance and admit complete supplemental
//! input identities before submitting observations. Later adapters will supply
//! that joined path.
//!
//! ```
//! use omp_core::{Hash32, Str};
//! use omp_driver::verification::{
//! 	CheckRequirement, GateVerdict, VerificationPolicy, VerificationScope,
//! };
//!
//! let scope = VerificationScope {
//! 	inputs: Hash32::sum(b"captured inputs"),
//! 	policy: Hash32::sum(b"required package check policy"),
//! };
//! let policy = VerificationPolicy::new(scope, vec![CheckRequirement {
//! 	id:       Str::new_static("package-check"),
//! 	required: true,
//! }])?;
//! // No observation is incomplete evidence, not a successful check.
//! assert_eq!(policy.evaluate(&[])?.verdict, GateVerdict::Inconclusive);
//! # Ok::<(), omp_driver::verification::PolicyError>(())
//! ```

mod evidence;
mod policy;
mod snapshot;

pub use evidence::{
	EvidenceArtifact, EvidenceError, EvidenceLimits, EvidencePayload, EvidenceProvenance,
	EvidencePublication, EvidenceRecord, EvidenceSubmission, evidence_observation,
	evidence_publications, load_evidence, publish_evidence,
};
pub use policy::{
	CheckAssessment, CheckDisposition, CheckObservation, CheckOutcome, CheckRequirement,
	GateAssessment, GateVerdict, InconclusiveReason, PolicyError, VerificationPolicy,
	VerificationScope,
};
pub use snapshot::{
	ContextField, SnapshotContext, SnapshotError, VerificationSnapshot,
	capture_verification_snapshot,
};
