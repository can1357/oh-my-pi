//! Source-bound verification policy owned by the production driver.
//!
//! Evaluates an explicit inventory of host-observed checks and captures native
//! source/context identities for conservative applicability keys. Retains
//! evidence through the existing session journal and blob CAS.
//! The opt-in native package runner composes frozen source, isolated EnvD
//! execution, complete test inventory and current-input fences. The pure
//! reducer remains available to callers that admit their own observations.
//! It performs no model inference or commit admission; a passing result covers
//! only the declared deterministic check contract.
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
mod inventory;
mod policy;
mod runner;
mod snapshot;

pub use evidence::{
	EvidenceArtifact, EvidenceError, EvidenceLimits, EvidencePayload, EvidenceProvenance,
	EvidencePublication, EvidenceRecord, EvidenceSubmission, evidence_observation,
	evidence_publications, load_evidence, publish_evidence,
};
pub use inventory::{InventoryError, ProtocolFault};
pub use policy::{
	CheckAssessment, CheckDisposition, CheckObservation, CheckOutcome, CheckRequirement,
	GateAssessment, GateVerdict, InconclusiveReason, PolicyError, VerificationPolicy,
	VerificationScope,
};
pub use runner::{
	NativeVerificationError, NativeVerificationReport, NativeVerificationSpec,
	native_verification_posture, run_native_verification,
};
pub use snapshot::{
	ContextField, SnapshotContext, SnapshotError, VerificationSnapshot,
	capture_verification_snapshot,
};
