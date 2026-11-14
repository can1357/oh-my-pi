//! Required-check decisions through the public driver verification contract.

use omp_core::{Hash32, Str};
use omp_driver::verification::{
	CheckDisposition, CheckObservation, CheckOutcome, CheckRequirement, GateVerdict,
	InconclusiveReason, PolicyError, VerificationPolicy, VerificationScope,
};

fn scope() -> VerificationScope {
	VerificationScope {
		inputs: Hash32::sum(b"source and environment"),
		policy: Hash32::sum(b"policy"),
	}
}

fn requirement(id: &'static str, required: bool) -> CheckRequirement {
	CheckRequirement { id: Str::new_static(id), required }
}

fn observation(id: &'static str, outcome: CheckOutcome) -> CheckObservation {
	CheckObservation {
		id: Str::new_static(id),
		scope: scope(),
		evidence: Some(Hash32::sum(id.as_bytes())),
		outcome,
	}
}

fn one_check() -> VerificationPolicy {
	VerificationPolicy::new(scope(), vec![requirement("check", true)]).expect("valid inventory")
}

#[test]
fn an_enabled_policy_cannot_pass_with_no_required_checks() {
	for inventory in [vec![], vec![requirement("advisory", false)]] {
		assert_eq!(
			VerificationPolicy::new(scope(), inventory).expect_err("no required checks"),
			PolicyError::NoRequiredChecks,
		);
	}
}

#[test]
fn ambiguous_or_blank_inventory_identities_are_rejected() {
	for id in ["", " \t\n"] {
		assert_eq!(
			VerificationPolicy::new(scope(), vec![requirement("check", true), requirement(id, false)])
				.expect_err("blank identity"),
			PolicyError::EmptyCheckId { index: 1 },
		);
	}
	assert_eq!(
		VerificationPolicy::new(scope(), vec![
			requirement("check", true),
			requirement("check", false)
		],)
		.expect_err("required and optional identities must remain unique"),
		PolicyError::DuplicateRequirement { id: Str::new_static("check") },
	);
}

#[test]
fn missing_required_result_is_explicit_and_never_passes() {
	let assessment = one_check().evaluate(&[]).expect("valid observations");
	assert_eq!(assessment.scope, scope());
	assert_eq!(assessment.verdict, GateVerdict::Inconclusive);
	assert_eq!(assessment.checks.len(), 1);
	assert_eq!(assessment.checks[0].id.as_str(), "check");
	assert!(assessment.checks[0].required);
	assert_eq!(
		assessment.checks[0].disposition,
		CheckDisposition::Inconclusive(InconclusiveReason::MissingResult),
	);
}

#[test]
fn undeclared_and_near_matching_results_cannot_replace_a_required_check() {
	for id in ["other", "CHECK", "check "] {
		assert_eq!(
			one_check()
				.evaluate(&[observation(id, CheckOutcome::Passed)])
				.expect_err("unknown result"),
			PolicyError::UnknownObservation { id: Str::new_static(id) },
		);
	}
}

#[test]
fn duplicate_results_are_errors_instead_of_votes_or_last_write_wins() {
	let policy = one_check();
	for second in [CheckOutcome::Passed, CheckOutcome::Failed] {
		for observations in [
			vec![observation("check", CheckOutcome::Passed), observation("check", second)],
			vec![observation("check", second), observation("check", CheckOutcome::Passed)],
		] {
			assert_eq!(
				policy
					.evaluate(&observations)
					.expect_err("duplicate result"),
				PolicyError::DuplicateObservation { id: Str::new_static("check") },
			);
		}
	}
}

#[test]
fn both_input_and_policy_identity_must_match_for_success_or_failure() {
	let current = scope();
	let stale_scopes = [
		VerificationScope { inputs: Hash32::sum(b"previous source"), ..current },
		VerificationScope { policy: Hash32::sum(b"previous policy"), ..current },
	];
	for stale in stale_scopes {
		for outcome in [CheckOutcome::Passed, CheckOutcome::Failed] {
			let mut result = observation("check", outcome);
			result.scope = stale;
			let assessment = one_check().evaluate(&[result]).expect("known check");
			assert_eq!(assessment.scope, current);
			assert_eq!(assessment.verdict, GateVerdict::Inconclusive);
			assert_eq!(
				assessment.checks[0].disposition,
				CheckDisposition::Inconclusive(InconclusiveReason::ScopeMismatch),
			);
		}
	}
}

#[test]
fn decisive_outcomes_without_retained_evidence_are_not_confirmed() {
	for outcome in [CheckOutcome::Passed, CheckOutcome::Failed] {
		let mut result = observation("check", outcome);
		result.evidence = None;
		let assessment = one_check().evaluate(&[result]).expect("known check");
		assert_eq!(assessment.verdict, GateVerdict::Inconclusive);
		assert_eq!(
			assessment.checks[0].disposition,
			CheckDisposition::Inconclusive(InconclusiveReason::MissingEvidence),
		);
	}
}

#[test]
fn host_reported_uncertainty_survives_even_when_a_log_digest_exists() {
	for reason in [
		InconclusiveReason::MissingResult,
		InconclusiveReason::ScopeMismatch,
		InconclusiveReason::MissingEvidence,
		InconclusiveReason::NotRun,
		InconclusiveReason::Cancelled,
		InconclusiveReason::EffectsUnknown,
		InconclusiveReason::Incomplete,
		InconclusiveReason::Untrusted,
		InconclusiveReason::Neutral,
	] {
		let result = observation("check", CheckOutcome::Inconclusive(reason));
		let assessment = one_check().evaluate(&[result]).expect("known check");
		assert_eq!(assessment.verdict, GateVerdict::Inconclusive);
		assert_eq!(assessment.checks[0].disposition, CheckDisposition::Inconclusive(reason));
	}
}

#[test]
fn advisory_failures_and_missing_advisories_remain_visible_without_blocking() {
	let policy = VerificationPolicy::new(scope(), vec![
		requirement("check", true),
		requirement("advisory", false),
		requirement("not-run", false),
	])
	.expect("required check declared");
	let results =
		[observation("check", CheckOutcome::Passed), observation("advisory", CheckOutcome::Failed)];
	let assessment = policy.evaluate(&results).expect("unique known checks");
	assert_eq!(assessment.verdict, GateVerdict::Pass);
	assert_eq!(assessment.checks.len(), 3);
	assert!(!assessment.checks[1].required);
	assert_eq!(assessment.checks[1].disposition, CheckDisposition::Failed {
		evidence: Hash32::sum(b"advisory"),
	},);
	assert_eq!(
		assessment.checks[2].disposition,
		CheckDisposition::Inconclusive(InconclusiveReason::MissingResult),
	);
}

#[test]
fn a_confirmed_required_failure_dominates_but_preserves_other_missing_evidence() {
	for inventory in [vec![requirement("failed", true), requirement("missing", true)], vec![
		requirement("missing", true),
		requirement("failed", true),
	]] {
		let policy = VerificationPolicy::new(scope(), inventory).expect("valid inventory");
		let assessment = policy
			.evaluate(&[observation("failed", CheckOutcome::Failed)])
			.expect("known check");
		assert_eq!(assessment.verdict, GateVerdict::Fail);
		assert!(assessment.checks.iter().any(|check| {
			check.id.as_str() == "missing"
				&& check.disposition
					== CheckDisposition::Inconclusive(InconclusiveReason::MissingResult)
		}));
	}
}

#[test]
fn assessment_order_and_evidence_are_stable_under_observation_permutations() {
	let policy = VerificationPolicy::new(scope(), vec![
		requirement("types", true),
		requirement("tests", true),
		requirement("lint", false),
	])
	.expect("valid inventory");
	let results = [
		observation("types", CheckOutcome::Passed),
		observation("tests", CheckOutcome::Passed),
		observation("lint", CheckOutcome::Passed),
	];
	let expected = policy.evaluate(&results).expect("all current evidence");
	assert_eq!(expected.verdict, GateVerdict::Pass);
	assert_eq!(expected.scope, scope());
	assert_eq!(
		expected
			.checks
			.iter()
			.map(|check| check.id.as_str())
			.collect::<Vec<_>>(),
		["types", "tests", "lint"],
	);
	for permutation in [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
		let reordered = permutation.map(|index| results[index].clone());
		assert_eq!(policy.evaluate(&reordered).expect("same facts"), expected);
	}
	for (check, result) in expected.checks.iter().zip(results) {
		assert_eq!(check.disposition, CheckDisposition::Passed {
			evidence: result.evidence.expect("retained passing evidence"),
		});
	}
}
