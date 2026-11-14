//! Pure verification decisions over an explicit required-check inventory.

use std::sync::Arc;

use omp_core::{FastHashMap, Hash32, Str};

/// Immutable identities a host binds to every observation in one assessment.
///
/// These are supplied identities, not a snapshot-capture implementation. The
/// input digest must cover source, dependencies, tools, test inputs and
/// execution environment; the policy digest must cover the complete selected
/// policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerificationScope {
	/// Digest of the complete captured input and execution-environment closure.
	pub inputs: Hash32,
	/// Digest of the policy, including its required-check inventory.
	pub policy: Hash32,
}

/// One declared check, including checks whose failures are only advisory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckRequirement {
	/// Exact check identity. Matching never normalizes or guesses names.
	pub id:       Str,
	/// Whether current passing evidence for this check is required.
	pub required: bool,
}

/// Why a check cannot establish a current passing or failing result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InconclusiveReason {
	/// The declared check has no observation.
	MissingResult,
	/// The result belongs to another input closure or policy.
	ScopeMismatch,
	/// The observation has no retained evidence identity.
	MissingEvidence,
	/// The check did not execute, for example because its executable is absent.
	NotRun,
	/// The check was cancelled before its result could be established.
	Cancelled,
	/// Execution may have produced effects whose settlement is unknown.
	EffectsUnknown,
	/// Execution or observed coverage did not complete.
	Incomplete,
	/// The host could not establish evidence provenance or integrity.
	Untrusted,
	/// A skipped or neutral result does not satisfy a required check.
	Neutral,
}

/// A host-observed result; a model's completion claim is not an observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckOutcome {
	/// The host established successful completion and required coverage.
	Passed,
	/// The host confirmed a violation of this check's acceptance condition.
	Failed,
	/// The check's result could not be established.
	Inconclusive(InconclusiveReason),
}

/// One check result already admitted by the host's evidence validation.
///
/// An evidence digest identifies bytes, not producer trust. This pure reducer
/// does not inspect those bytes or verify a tool's coverage. Adapters must emit
/// `Inconclusive` when provenance, integrity or completion cannot be
/// established.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckObservation {
	/// Exact identity declared by the policy.
	pub id:       Str,
	/// Inputs and policy actually checked.
	pub scope:    VerificationScope,
	/// Retained result evidence; required for a decisive outcome.
	pub evidence: Option<Hash32>,
	/// Host-validated result, not reviewer-supplied confidence.
	pub outcome:  CheckOutcome,
}

/// The applicability-checked disposition of one declared check.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckDisposition {
	/// A current successful result with retained evidence.
	Passed {
		/// Content identity of the admitted result.
		evidence: Hash32,
	},
	/// A current confirmed violation with retained evidence.
	Failed {
		/// Content identity of the admitted result.
		evidence: Hash32,
	},
	/// Missing, stale or otherwise inconclusive evidence.
	Inconclusive(InconclusiveReason),
}

/// One declared check's result, in policy order, including advisory checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckAssessment {
	/// Exact policy check identity.
	pub id:          Str,
	/// Whether this check participates in the verdict.
	pub required:    bool,
	/// Observed applicability and result; never inferred from missing output.
	pub disposition: CheckDisposition,
}

/// A verdict about the declared contract, not universal program correctness.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateVerdict {
	/// Every required check has current admitted passing evidence.
	Pass,
	/// At least one required check has a current confirmed violation.
	Fail,
	/// No required violation was confirmed, but required evidence is incomplete.
	Inconclusive,
}

/// Complete policy-ordered results, preserving uncertainty even on failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GateAssessment {
	/// Input and policy identities evaluated by this assessment.
	pub scope:   VerificationScope,
	/// Aggregate verdict for required checks only.
	pub verdict: GateVerdict,
	/// Every declared check, including optional failures and missing results.
	pub checks:  Arc<[CheckAssessment]>,
}

/// Malformed policy or observations; these cannot produce a passing assessment.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PolicyError {
	/// An enabled policy must declare at least one required check.
	#[error("verification policy has no required checks")]
	NoRequiredChecks,
	/// Empty or whitespace-only identities cannot name checks.
	#[error("verification check at inventory index {index} has an empty identity")]
	EmptyCheckId {
		/// Position in the caller's inventory.
		index: usize,
	},
	/// A policy cannot declare the same exact identity twice.
	#[error("verification policy declares check `{id}` more than once")]
	DuplicateRequirement {
		/// Repeated identity.
		id: Str,
	},
	/// Results may not silently enlarge or substitute the declared inventory.
	#[error("verification observation names undeclared check `{id}`")]
	UnknownObservation {
		/// Undeclared identity.
		id: Str,
	},
	/// Repeated observations are ambiguous, not votes or last-write-wins
	/// updates.
	#[error("verification received more than one observation for check `{id}`")]
	DuplicateObservation {
		/// Repeated identity.
		id: Str,
	},
}

/// A validated explicit inventory and its immutable assessment scope.
#[derive(Clone, Debug)]
pub struct VerificationPolicy {
	scope:  VerificationScope,
	checks: Arc<[CheckRequirement]>,
	index:  FastHashMap<Str, usize>,
}

impl VerificationPolicy {
	/// Validates an inventory without executing or trusting any check.
	///
	/// At least one check must be required. Optional-only and empty inventories
	/// are errors rather than vacuously passing gates. The caller supplies a
	/// policy digest covering this inventory; digest construction is separate.
	pub fn new(
		scope: VerificationScope,
		checks: impl Into<Arc<[CheckRequirement]>>,
	) -> Result<Self, PolicyError> {
		let checks = checks.into();
		let mut index = FastHashMap::default();
		for (position, check) in checks.iter().enumerate() {
			if check.id.trim().is_empty() {
				return Err(PolicyError::EmptyCheckId { index: position });
			}
			if index.insert(check.id.clone(), position).is_some() {
				return Err(PolicyError::DuplicateRequirement { id: check.id.clone() });
			}
		}
		if !checks.iter().any(|check| check.required) {
			return Err(PolicyError::NoRequiredChecks);
		}
		Ok(Self { scope, checks, index })
	}

	/// Evaluates observations deterministically, retaining every declared
	/// result.
	///
	/// Unknown or duplicate observation identities are errors. For known checks,
	/// applicability is checked before the outcome: an old failure cannot fail
	/// current code and an old success cannot pass it. A current confirmed
	/// required failure dominates uncertainty, which remains visible in
	/// `checks`. Optional check results never change the required-check
	/// verdict.
	pub fn evaluate(
		&self,
		observations: &[CheckObservation],
	) -> Result<GateAssessment, PolicyError> {
		let mut observed = vec![None; self.checks.len()];
		for observation in observations {
			let Some(&position) = self.index.get(&observation.id) else {
				return Err(PolicyError::UnknownObservation { id: observation.id.clone() });
			};
			if observed[position].replace(observation).is_some() {
				return Err(PolicyError::DuplicateObservation { id: observation.id.clone() });
			}
		}

		let mut verdict = GateVerdict::Pass;
		let checks = self
			.checks
			.iter()
			.zip(observed)
			.map(|(check, observation)| {
				let disposition = self.disposition(observation);
				if check.required {
					match disposition {
						CheckDisposition::Failed { .. } => verdict = GateVerdict::Fail,
						CheckDisposition::Inconclusive(_) if verdict != GateVerdict::Fail => {
							verdict = GateVerdict::Inconclusive;
						},
						_ => {},
					}
				}
				CheckAssessment { id: check.id.clone(), required: check.required, disposition }
			})
			.collect();
		Ok(GateAssessment { scope: self.scope, verdict, checks })
	}

	fn disposition(&self, observation: Option<&CheckObservation>) -> CheckDisposition {
		let Some(observation) = observation else {
			return CheckDisposition::Inconclusive(InconclusiveReason::MissingResult);
		};
		if observation.scope != self.scope {
			return CheckDisposition::Inconclusive(InconclusiveReason::ScopeMismatch);
		}
		if let CheckOutcome::Inconclusive(reason) = observation.outcome {
			return CheckDisposition::Inconclusive(reason);
		}
		let Some(evidence) = observation.evidence else {
			return CheckDisposition::Inconclusive(InconclusiveReason::MissingEvidence);
		};
		match observation.outcome {
			CheckOutcome::Passed => CheckDisposition::Passed { evidence },
			CheckOutcome::Failed => CheckDisposition::Failed { evidence },
			CheckOutcome::Inconclusive(reason) => CheckDisposition::Inconclusive(reason),
		}
	}
}
