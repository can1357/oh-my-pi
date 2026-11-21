//! Opt-in deterministic package checks over native captured input leases.

use std::{collections::BTreeSet, io, path::Path, str::from_utf8, sync::Arc, time::Duration};

use bytes::Bytes;
use omp_adw::{ApprovalScope, NetworkScope, Posture, WriteScope};
use omp_core::{EnvPath, Hash32, Str, sf};
use omp_dom::{NodeSpec, Op, PropKey, Tag, Txn, Value};
use omp_env::EnvClient;
use omp_envd::verification::{
	HostToolPaths, VerificationCommandResult, VerificationRuntime, VerificationRuntimeError,
	VerificationRuntimeOptions,
};
use omp_journal::idempotency::IdempotencyKey;
use omp_proto::{
	blob::v1::StatRequest,
	env::v1::{
		CaptureInputsRequest, CapturedInputsSource, CloseSessionRequest, MaterializeRequest,
		OpenSessionRequest, ReleaseMaterialization, WorkspaceRootSetRequest,
	},
	prost::Message as _,
};
use omp_session::Session;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	CheckObservation, CheckOutcome, CheckRequirement, EvidenceError, EvidenceLimits,
	EvidencePayload, EvidenceProvenance, EvidencePublication, EvidenceSubmission, GateAssessment,
	GateVerdict, InconclusiveReason, InventoryError, PolicyError, SnapshotContext, SnapshotError,
	VerificationPolicy, VerificationSnapshot, capture_verification_snapshot, evidence_observation,
	inventory::{
		parse_doctest_results, parse_nextest_inventory, validate_just_recipes,
		validate_nextest_results,
	},
	publish_evidence,
	snapshot::capture_digest,
};
use crate::{
	cleanse::{BinaryResolver, FilesystemResolver},
	exec_composer::EnvironmentInputs,
};

const POLICY: &[u8] = b"omp.native-package-checks.v1:explicit-packages;compile;complete-nextest;doctests;fresh-inputs;offline;strict-source-readonly";
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const fn default_timeout() -> u64 {
	900
}
const fn default_tests() -> u64 {
	1
}
const fn default_output() -> usize {
	MAX_OUTPUT
}

/// Explicit deterministic checks; no model calls or automatic repair.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeVerificationSpec {
	/// Exact package names; an empty or duplicate selection is refused.
	pub packages:         Vec<Str>,
	/// Native host admission/process budget in seconds, at most thirty minutes.
	/// Original Environment capture/publication transport and cleanup are
	/// separate.
	#[serde(default = "default_timeout")]
	pub timeout_seconds:  u64,
	/// Minimum nonignored nextest cases required for each package.
	#[serde(default = "default_tests")]
	pub minimum_tests:    u64,
	/// Maximum combined raw output bytes; overflow is inconclusive.
	#[serde(default = "default_output")]
	pub max_output_bytes: usize,
}

impl NativeVerificationSpec {
	/// Refuses ambiguous selection and unbounded budgets before execution.
	pub fn validate(&self) -> Result<(), NativeVerificationError> {
		let mut names = BTreeSet::new();
		if self.packages.is_empty()
			|| self.packages.len() > 8
			|| self.timeout_seconds == 0
			|| self.timeout_seconds > 1800
			|| self.minimum_tests == 0
			|| self.max_output_bytes == 0
			|| self.max_output_bytes > MAX_OUTPUT
			|| self.packages.iter().any(|p| {
				p.is_empty()
					|| p.starts_with('-')
					|| p.len() > 128
					|| !p
						.bytes()
						.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
					|| !names.insert(p.as_str())
			}) {
			return Err(NativeVerificationError::InvalidSpec);
		}
		Ok(())
	}
}

/// Durable evidence and the verdict of the explicitly selected checks.
#[derive(Debug)]
pub struct NativeVerificationReport {
	/// PASS requires every selected check and the final freshness fence.
	pub verdict:      GateVerdict,
	/// Short operator-facing summary, never untrusted process output.
	pub feedback:     Str,
	/// Journal-rooted evidence publications for this attempt.
	pub publications: Vec<EvidencePublication>,
	/// Complete policy assessment, when a captured scope was admitted.
	pub assessment:   Option<GateAssessment>,
	/// Raw check observations for downstream re-evaluation.
	pub observations: Vec<CheckObservation>,
}

/// An attempt could not establish its deterministic contract.
#[derive(Debug, thiserror::Error, strum::IntoStaticStr)]
#[strum(serialize_all = "kebab-case")]
pub enum NativeVerificationError {
	/// Invalid selection or resource budget.
	#[error("invalid native verification specification")]
	InvalidSpec,
	/// A required host binary is absent.
	#[error("native verification tool is unavailable: {name}")]
	MissingTool {
		/// Required executable name.
		name: &'static str,
	},
	/// Source URI/path or returned lease is malformed.
	#[error("invalid native verification path or lease")]
	InvalidLease,
	/// Captured configuration can replace trusted commands or their inputs.
	#[error("unsupported Cargo configuration in native verification")]
	UnsupportedConfiguration,
	/// Native environment transport failed.
	#[error("native verification environment request failed")]
	Environment(#[from] omp_env::ClientError),
	/// Native host admission or execution failed.
	#[error("native verification host failed")]
	Runtime(#[from] VerificationRuntimeError),
	/// Source/context identity is incomplete or changed.
	#[error("native verification snapshot failed")]
	Snapshot(#[from] SnapshotError),
	/// Raw machine output did not establish complete coverage.
	#[error("native verification coverage admission failed")]
	Inventory(#[from] InventoryError),
	/// Durable evidence publication/validation failed.
	#[error("native verification evidence failed")]
	Evidence(#[from] EvidenceError),
	/// Invalid required-check inventory.
	#[error("native verification policy failed")]
	Policy(#[from] PolicyError),
	/// A captured configuration could not be read.
	#[error("native verification captured input read failed")]
	Input(#[from] io::Error),
	/// Canonical metadata encoding failed.
	#[error("native verification metadata encoding failed")]
	Encode(#[from] serde_json::Error),
	/// Captured Cargo TOML is invalid.
	#[error("native verification Cargo TOML is invalid")]
	Toml(#[from] toml::de::Error),
	/// The authoritative attempt journal could not be updated.
	#[error("native verification journal update failed")]
	Journal(#[from] omp_session::SessionError),
}

/// Reports strict native confinement only when the real backend admits it.
pub fn native_verification_posture(root: &Path) -> Result<Posture, NativeVerificationError> {
	let strict = omp_envd::verification::strict_sandbox_available(root)?;
	Ok(Posture {
		write:    if strict {
			WriteScope::WorkspaceWrite
		} else {
			WriteScope::Unconfined
		},
		network:  if strict {
			NetworkScope::Disabled
		} else {
			NetworkScope::Unrestricted
		},
		approval: ApprovalScope::Yolo,
	})
}

fn tools() -> Result<HostToolPaths, NativeVerificationError> {
	let resolve = |name| {
		FilesystemResolver
			.resolve(&[name])
			.ok_or(NativeVerificationError::MissingTool { name })
	};
	Ok(HostToolPaths {
		just:    resolve("just")?,
		cargo:   resolve("cargo")?,
		rustc:   resolve("rustc")?,
		nextest: resolve("cargo-nextest")?,
	})
}

/// Runs only the selected native contract against a private frozen capture.
/// The live source and admitted external bytes are fenced again before PASS.
/// Cleanup settles the child host before releasing its source lease.
pub async fn run_native_verification(
	environment: &EnvClient,
	session: &mut Session,
	project_root: &Path,
	state_dir: &Path,
	spec: &NativeVerificationSpec,
	requirements: Hash32,
	cancel: &CancellationToken,
) -> Result<NativeVerificationReport, NativeVerificationError> {
	spec.validate()?;
	journal_fact(
		session,
		"native-verification-attempt",
		&serde_json::json!({"spec": spec, "requirements": requirements, "completed": false}),
	)?;
	if cancel.is_cancelled() {
		return Err(SnapshotError::Cancelled.into());
	}
	let source = EnvPath::new(Str::new(project_root.to_string_lossy()))
		.map_err(|_| NativeVerificationError::InvalidLease)?;
	let opened = match environment
		.open_session(&source, OpenSessionRequest::default())
		.await
	{
		Ok(opened) => opened,
		Err(error) => {
			let error = NativeVerificationError::Environment(error);
			let class: &'static str = (&error).into();
			journal_fact(
				session,
				"native-verification-inconclusive",
				&serde_json::json!({"error_class": class, "passed": false, "completed": false}),
			)?;
			return Err(error);
		},
	};
	let result = async {
		let roots = environment
			.workspace_roots(WorkspaceRootSetRequest { wire_revision: omp_proto::SCHEMA_REV })
			.await?;
		if roots.wire_revision != omp_proto::SCHEMA_REV
			|| roots.primary.as_ref().is_none_or(|root| {
				root.canonical_uri.trim_end_matches('/') != opened.cwd_uri.trim_end_matches('/')
			}) {
			return Err(SnapshotError::RootMismatch.into());
		}
		// The capture and host tool admission must refer to the same primary
		// source root, including canonicalization performed by EnvD.
		let project_root = Url::parse(&opened.cwd_uri)
			.ok()
			.and_then(|uri| uri.to_file_path().ok())
			.ok_or(NativeVerificationError::InvalidLease)?;
		with_session(
			environment,
			session,
			&project_root,
			state_dir,
			spec,
			requirements,
			cancel,
			opened.session.clone(),
		)
		.await
	}
	.await;
	let closed = environment
		.close_session(CloseSessionRequest { session: opened.session, ..Default::default() })
		.await;
	let result = match (result, closed) {
		(Ok(report), Ok(_)) => {
			if cancel.is_cancelled() {
				return Err(SnapshotError::Cancelled.into());
			}
			journal_fact(
				session,
				"native-verification-gate",
				&serde_json::json!({"passed": report.verdict == GateVerdict::Pass, "failed": report.verdict == GateVerdict::Fail, "cleanup_complete": true, "completed": true, "evidence": report.publications.iter().map(|p| p.identity).collect::<Vec<_>>()}),
			)?;
			Ok(report)
		},
		(Err(error), _) => Err(error),
		(_, Err(error)) => Err(error.into()),
	};
	if let Err(error) = &result
		&& !matches!(
			error,
			NativeVerificationError::Journal(_) | NativeVerificationError::Evidence(_)
		) {
		// Evidence/journal failures may follow a partially committed write. Do
		// not append anything after those until the session is reopened.
		let class: &'static str = error.into();
		journal_fact(
			session,
			"native-verification-inconclusive",
			&serde_json::json!({"error_class": class, "passed": false, "completed": false}),
		)?;
	}
	result
}

async fn with_session(
	environment: &EnvClient,
	session: &mut Session,
	project_root: &Path,
	state_dir: &Path,
	spec: &NativeVerificationSpec,
	requirements: Hash32,
	cancel: &CancellationToken,
	parent: Bytes,
) -> Result<NativeVerificationReport, NativeVerificationError> {
	let capture = environment
		.capture_inputs(CaptureInputsRequest {
			include_untracked: true,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		})
		.await?;
	let manifest = capture_digest(&capture)?;
	let lease = environment
		.materialize(MaterializeRequest {
			session: parent,
			max_bytes: 256 * 1024 * 1024,
			ttl_ms: (spec.timeout_seconds + 60) * 1000,
			wire_revision: omp_proto::SCHEMA_REV,
			captured_inputs: Some(CapturedInputsSource {
				manifest_hash: Bytes::copy_from_slice(manifest.hash.as_bytes()),
				manifest_size: manifest.size,
			}),
			..Default::default()
		})
		.await?;
	let result = async {
		if lease.content_hash.as_ref() != manifest.hash.as_bytes() {
			return Err(NativeVerificationError::InvalidLease);
		}
		let root = Url::parse(&lease.environment_uri)
			.ok()
			.and_then(|u| u.to_file_path().ok())
			.ok_or(NativeVerificationError::InvalidLease)?;
		let runtime = VerificationRuntime::open(
			VerificationRuntimeOptions {
				run_root:         root,
				state_dir:        state_dir.join(omp_core::Ulid::generate().to_string()),
				project_root:     project_root.to_path_buf(),
				tools:            tools()?,
				timeout:          Duration::from_secs(spec.timeout_seconds),
				max_output_bytes: spec.max_output_bytes,
			},
			cancel,
		)
		.await?;
		let result =
			verify(environment, session, spec, requirements, cancel, manifest, &runtime).await;
		let closed = runtime.close().await;
		match (result, closed) {
			(Ok(report), Ok(())) => Ok(report),
			(Err(error), _) => Err(error),
			(_, Err(error)) => Err(error.into()),
		}
	}
	.await;
	let released = environment
		.release_materialization(ReleaseMaterialization {
			lease_id:      lease.lease_id,
			wire_revision: omp_proto::SCHEMA_REV,
		})
		.await;
	match (result, released) {
		(Ok(report), Ok(_)) => Ok(report),
		(Err(error), _) => Err(error),
		(_, Err(error)) => Err(error.into()),
	}
}

async fn verify(
	environment: &EnvClient,
	session: &mut Session,
	spec: &NativeVerificationSpec,
	requirements: Hash32,
	cancel: &CancellationToken,
	manifest: omp_exec::Digest,
	runtime: &VerificationRuntime,
) -> Result<NativeVerificationReport, NativeVerificationError> {
	let config = Hash32::sum(serde_json::to_vec(spec)?);
	let context = SnapshotContext {
		dependencies:      Some(runtime.dependencies_digest()),
		toolchain:         Some(runtime.toolchain_digest()),
		environment:       Some(runtime.environment_digest()),
		tests:             Some(config),
		requirements:      Some(requirements),
		policy:            Some(Hash32::sum(POLICY)),
		verifier:          Some(Hash32::sum(
			[
				include_bytes!("runner.rs").as_slice(),
				include_bytes!("inventory.rs").as_slice(),
				include_bytes!("policy.rs").as_slice(),
				include_bytes!("snapshot.rs").as_slice(),
				include_bytes!("evidence.rs").as_slice(),
				include_bytes!("../../../envd/src/verification.rs").as_slice(),
				include_bytes!("../../../envd/src/resource_materializer.rs").as_slice(),
			]
			.concat(),
		)),
		required_paths:    Arc::from([sf!("Cargo.toml"), sf!("Cargo.lock"), sf!("justfile")]),
		unresolved_inputs: Arc::from([]),
	};
	let snapshot = capture_verification_snapshot(environment, &context, cancel).await?;
	if snapshot.manifest() != manifest {
		return Err(SnapshotError::ChangedDuringCapture.into());
	}
	admit_cargo_configuration(environment, manifest).await?;
	let timeout = Duration::from_secs(spec.timeout_seconds);
	let dump = runtime
		.command(
			&[path_arg(&runtime.tools().just)?, sf!("--dump"), sf!("--dump-format"), sf!("json")],
			timeout,
			cancel,
		)
		.await?;
	if !dump.succeeded() {
		return Err(NativeVerificationError::UnsupportedConfiguration);
	}
	validate_just_recipes(&dump.stdout)?;
	let mut checks = Vec::new();
	for package in &spec.packages {
		for prefix in ["a1", "c1", "doctest"] {
			checks.push(CheckRequirement { id: sf!("{prefix}:{package}"), required: true });
		}
	}
	checks.push(CheckRequirement { id: sf!("inputs-current"), required: true });
	let policy = snapshot.policy(checks)?;
	let mut observations = Vec::new();
	let mut publications = Vec::new();
	for package in &spec.packages {
		let argv = vec![
			path_arg(&runtime.tools().cargo)?,
			sf!("check"),
			sf!("-p"),
			package.clone(),
			sf!("--locked"),
			sf!("--offline"),
		];
		let result = runtime.command(&argv, timeout, cancel).await?;
		retain(
			environment,
			session,
			&snapshot,
			&policy,
			&sf!("a1:{package}"),
			&argv,
			outcome(&result),
			&result,
			None,
			cancel,
			&mut publications,
			&mut observations,
		)
		.await?;
		let mut list_args = vec![
			path_arg(&runtime.tools().nextest)?,
			sf!("nextest"),
			sf!("list"),
			sf!("-p"),
			package.clone(),
			sf!("--locked"),
			sf!("--offline"),
			sf!("--config-file"),
			path_arg(&runtime.tools().nextest_config)?,
			sf!("--user-config-file"),
			sf!("none"),
			sf!("--ignore-default-filter"),
			sf!("--message-format"),
			sf!("json"),
		];
		let list = runtime.command(&list_args, timeout, cancel).await?;
		let inventory = if list.succeeded() {
			parse_nextest_inventory(&list.stdout, package).ok()
		} else {
			None
		};
		list_args[2] = sf!("run");
		list_args.pop();
		list_args.push(sf!("libtest-json-plus"));
		list_args.extend([
			sf!("--no-tests"),
			sf!("fail"),
			sf!("--retries"),
			sf!("0"),
			sf!("--no-fail-fast"),
		]);
		let result = runtime.command(&list_args, timeout, cancel).await?;
		let coverage = inventory
			.as_ref()
			.and_then(|i| validate_nextest_results(&result.stdout, i).ok());
		let test_outcome = match (outcome(&result), coverage) {
			(CheckOutcome::Passed, Some(c))
				if c.complete && c.selected >= spec.minimum_tests && c.failed == 0 =>
			{
				CheckOutcome::Passed
			},
			(CheckOutcome::Failed, Some(c)) if c.complete && c.failed > 0 => CheckOutcome::Failed,
			_ => CheckOutcome::Inconclusive(InconclusiveReason::Incomplete),
		};
		retain(
			environment,
			session,
			&snapshot,
			&policy,
			&sf!("c1:{package}"),
			&list_args,
			test_outcome,
			&result,
			Some(&list.stdout),
			cancel,
			&mut publications,
			&mut observations,
		)
		.await?;
		let argv = vec![
			path_arg(&runtime.tools().cargo)?,
			sf!("test"),
			sf!("--doc"),
			sf!("-p"),
			package.clone(),
			sf!("--locked"),
			sf!("--offline"),
			sf!("--"),
			sf!("--format=json"),
			sf!("-Z"),
			sf!("unstable-options"),
		];
		let result = runtime.command(&argv, timeout, cancel).await?;
		let doctest = match (outcome(&result), parse_doctest_results(&result.stdout)) {
			(CheckOutcome::Passed, Ok(c)) if c.complete && c.failed == 0 => CheckOutcome::Passed,
			(CheckOutcome::Failed, Ok(c)) if c.complete && c.failed > 0 => CheckOutcome::Failed,
			_ => CheckOutcome::Inconclusive(InconclusiveReason::Incomplete),
		};
		retain(
			environment,
			session,
			&snapshot,
			&policy,
			&sf!("doctest:{package}"),
			&argv,
			doctest,
			&result,
			None,
			cancel,
			&mut publications,
			&mut observations,
		)
		.await?;
	}
	let external_current = runtime.revalidate(cancel).await?;
	let source_current = capture_verification_snapshot(environment, &context, cancel)
		.await
		.map(|s| s.inputs_digest() == snapshot.inputs_digest())
		.unwrap_or(false);
	let fence = if external_current && source_current {
		CheckOutcome::Passed
	} else {
		CheckOutcome::Inconclusive(InconclusiveReason::ScopeMismatch)
	};
	let facts = serde_json::to_vec(&(external_current, source_current))?;
	let publication = publish_evidence(
		session,
		environment,
		EvidenceSubmission {
			snapshot:      &snapshot,
			policy:        &policy,
			check:         "inputs-current",
			configuration: config,
			outcome:       fence,
			provenance:    provenance(),
			payloads:      &[EvidencePayload { name: "freshness.json", bytes: &facts }],
		},
		EvidenceLimits::default(),
		cancel,
	)
	.await?;
	observations.push(evidence_observation(session, publication, &snapshot, &policy, config)?);
	publications.push(publication);
	let assessment = policy.evaluate(&observations)?;
	let feedback = match assessment.verdict {
		GateVerdict::Pass => {
			sf!("PASS: selected compilation, test coverage and input freshness checks completed.")
		},
		GateVerdict::Fail => {
			sf!("FAIL: a selected deterministic check failed; inspect retained evidence.")
		},
		GateVerdict::Inconclusive => {
			sf!("INCONCLUSIVE: required execution, coverage or input freshness was not established.")
		},
	};
	Ok(NativeVerificationReport {
		verdict: assessment.verdict,
		feedback,
		publications,
		assessment: Some(assessment),
		observations,
	})
}

fn path_arg(path: &Path) -> Result<Str, NativeVerificationError> {
	path
		.to_str()
		.map(Str::new)
		.ok_or(NativeVerificationError::InvalidLease)
}
fn provenance() -> EvidenceProvenance {
	EvidenceProvenance {
		provider: sf!("omp-native-package-checks"),
		version:  sf!(env!("CARGO_PKG_VERSION")),
	}
}
fn outcome(result: &VerificationCommandResult) -> CheckOutcome {
	if result.cancelled {
		CheckOutcome::Inconclusive(InconclusiveReason::Cancelled)
	} else if !result.effects_known {
		CheckOutcome::Inconclusive(InconclusiveReason::EffectsUnknown)
	} else if !result.complete || result.timed_out || result.status.is_none() {
		CheckOutcome::Inconclusive(InconclusiveReason::Incomplete)
	} else {
		use omp_proto::env::v1::ExecOutcome;
		let status = result.status.as_ref().expect("status admitted above");
		if status.aborted {
			return CheckOutcome::Inconclusive(InconclusiveReason::Incomplete);
		}
		match ExecOutcome::try_from(status.outcome) {
			Ok(ExecOutcome::Exited) if status.signal.is_empty() => match status.exit_code {
				Some(0) => CheckOutcome::Passed,
				Some(_) => CheckOutcome::Failed,
				None => CheckOutcome::Inconclusive(InconclusiveReason::Incomplete),
			},
			Ok(ExecOutcome::Cancelled) => CheckOutcome::Inconclusive(InconclusiveReason::Cancelled),
			Ok(ExecOutcome::Denied) => CheckOutcome::Inconclusive(InconclusiveReason::Untrusted),
			Ok(ExecOutcome::Failed)
				if status.signal.is_empty() && status.exit_code.is_some_and(|code| code != 0) =>
			{
				CheckOutcome::Failed
			},
			Ok(ExecOutcome::Failed) => CheckOutcome::Inconclusive(InconclusiveReason::EffectsUnknown),
			_ => CheckOutcome::Inconclusive(InconclusiveReason::Incomplete),
		}
	}
}

#[allow(
	clippy::too_many_arguments,
	reason = "explicit borrowed attempt state and evidence destinations"
)]
async fn retain(
	environment: &EnvClient,
	session: &mut Session,
	snapshot: &VerificationSnapshot,
	policy: &VerificationPolicy,
	check: &str,
	argv: &[Str],
	outcome: CheckOutcome,
	result: &VerificationCommandResult,
	inventory: Option<&[u8]>,
	cancel: &CancellationToken,
	publications: &mut Vec<EvidencePublication>,
	observations: &mut Vec<CheckObservation>,
) -> Result<(), NativeVerificationError> {
	let command = serde_json::to_vec(&(
		argv,
		result.complete,
		result.cancelled,
		result.timed_out,
		result.effects_known,
	))?;
	let configuration = Hash32::sum(serde_json::to_vec(argv)?);
	let status = result
		.status
		.as_ref()
		.map(|s| s.encode_to_vec())
		.unwrap_or_default();
	let mut payloads = vec![
		EvidencePayload { name: "stdout", bytes: &result.stdout },
		EvidencePayload { name: "stderr", bytes: &result.stderr },
		EvidencePayload { name: "command.json", bytes: &command },
		EvidencePayload { name: "terminal-status.pb", bytes: &status },
	];
	if let Some(bytes) = inventory {
		payloads.push(EvidencePayload { name: "inventory.json", bytes });
	}
	let publication = publish_evidence(
		session,
		environment,
		EvidenceSubmission {
			snapshot,
			policy,
			check,
			configuration,
			outcome,
			provenance: provenance(),
			payloads: &payloads,
		},
		EvidenceLimits::default(),
		cancel,
	)
	.await?;
	observations.push(evidence_observation(session, publication, snapshot, policy, configuration)?);
	publications.push(publication);
	Ok(())
}

fn journal_fact(
	session: &mut Session,
	label: &'static str,
	fact: &serde_json::Value,
) -> Result<(), NativeVerificationError> {
	let cause = session
		.head()
		.ok_or(NativeVerificationError::InvalidLease)?;
	let txn = Txn {
		cause,
		label: Some(Str::new_static(label)),
		ops: vec![Op::Ins {
			parent: session.dom().meta(),
			after:  None,
			node:   NodeSpec::new(Tag::Custom(Str::new_static(label))).with_prop(
				PropKey::Custom(sf!("record")),
				Value::Json(serde_json::value::to_raw_value(fact)?),
			),
		}],
	};
	session.patch_keyed(
		txn,
		IdempotencyKey::new(sf!("native-verification:{}", omp_core::Ulid::generate())),
		fact,
	)?;
	Ok(())
}

async fn admit_cargo_configuration(
	environment: &EnvClient,
	manifest: omp_exec::Digest,
) -> Result<(), NativeVerificationError> {
	let inputs = EnvironmentInputs::new(environment.clone());
	let bytes = inputs.bytes(manifest).await?;
	for entry in omp_exec::capture_entries(&bytes)? {
		if entry.path.ends_with("Cargo.toml")
			|| entry.path.ends_with(".cargo/config")
			|| entry.path.ends_with(".cargo/config.toml")
		{
			let stat = environment
				.blob_stat(StatRequest { hash: Bytes::copy_from_slice(entry.hash.as_bytes()) })
				.await?;
			if !stat.present || stat.size > 8 * 1024 * 1024 {
				return Err(NativeVerificationError::UnsupportedConfiguration);
			}
			let bytes = inputs
				.bytes(omp_exec::Digest::new(entry.hash, stat.size))
				.await?;
			let text =
				from_utf8(&bytes).map_err(|_| NativeVerificationError::UnsupportedConfiguration)?;
			let value: toml::Value = toml::from_str(text)?;
			admit_config_value(&value, !entry.path.ends_with("Cargo.toml"))?;
		}
	}
	Ok(())
}

fn admit_config_value(
	value: &toml::Value,
	cargo_config: bool,
) -> Result<(), NativeVerificationError> {
	if let Some(table) = value.as_table() {
		for (key, value) in table {
			if cargo_config
				&& matches!(
					key.as_str(),
					"include"
						| "runner" | "rustc"
						| "rustdoc" | "rustc-wrapper"
						| "rustc-workspace-wrapper"
				) {
				return Err(NativeVerificationError::UnsupportedConfiguration);
			}
			if key == "codegen-backend" && !matches!(value.as_str(), Some("llvm" | "cranelift")) {
				return Err(NativeVerificationError::UnsupportedConfiguration);
			}
			if cargo_config && key == "env" {
				if let Some(env) = value.as_table() {
					for (name, setting) in env {
						if setting.get("force").and_then(toml::Value::as_bool) == Some(true) {
							return Err(NativeVerificationError::UnsupportedConfiguration);
						}
						if name.starts_with("CARGO_")
							|| name.starts_with("RUST")
							|| name.starts_with("LD_")
							|| name.starts_with("DYLD_")
							|| name.starts_with("NEXTEST_")
							|| matches!(name.as_str(), "PATH" | "HOME" | "SHELL" | "BASH_ENV" | "ENV")
						{
							return Err(NativeVerificationError::UnsupportedConfiguration);
						}
					}
				}
			}
			admit_config_value(value, cargo_config)?;
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[test]
	fn selection_and_budget_are_explicit_and_bounded() {
		let mut spec: NativeVerificationSpec =
			serde_json::from_str(r#"{"packages":["omp-core"]}"#).expect("spec");
		assert!(spec.validate().is_ok());
		spec.packages.push(sf!("omp-core"));
		assert!(matches!(spec.validate(), Err(NativeVerificationError::InvalidSpec)));
		spec.packages = vec![sf!("--workspace")];
		assert!(spec.validate().is_err());
		spec.packages = vec![sf!("omp-core")];
		spec.minimum_tests = 0;
		assert!(spec.validate().is_err());
		assert!(
			serde_json::from_str::<NativeVerificationSpec>(
				r#"{"packages":["omp-core"],"model":"unused"}"#
			)
			.is_err()
		);
	}

	#[test]
	fn captured_configuration_cannot_replace_runner_or_compiler() {
		for source in [
			"[target.x86_64-unknown-linux-gnu]\nrunner = 'echo'",
			"[build]\nrustc-wrapper = 'echo'",
			"[env]\nRUSTFLAGS = '-V'",
			"[env]\nPYO3_CONFIG_FILE = { value = 'unfenced', force = true }",
			"include = 'outside'",
		] {
			let value = toml::from_str(source).expect("toml");
			assert!(matches!(
				admit_config_value(&value, true),
				Err(NativeVerificationError::UnsupportedConfiguration)
			));
		}
		let value = toml::from_str(
			"[profile.dev]\ncodegen-backend = 'cranelift'\n[env]\nCMAKE_GENERATOR = 'Ninja'",
		)
		.expect("toml");
		assert!(admit_config_value(&value, true).is_ok());
	}

	#[test]
	fn incomplete_or_cancelled_transport_is_never_failure_or_pass() {
		let mut result = VerificationCommandResult {
			stdout:        Bytes::new(),
			stderr:        Bytes::new(),
			status:        None,
			complete:      false,
			cancelled:     false,
			timed_out:     false,
			effects_known: false,
		};
		assert_eq!(outcome(&result), CheckOutcome::Inconclusive(InconclusiveReason::EffectsUnknown));
		result.cancelled = true;
		assert_eq!(outcome(&result), CheckOutcome::Inconclusive(InconclusiveReason::Cancelled));
		result.cancelled = false;
		result.effects_known = true;
		assert_eq!(outcome(&result), CheckOutcome::Inconclusive(InconclusiveReason::Incomplete));
	}

	#[test]
	fn only_normal_exit_establishes_a_check_result() {
		use omp_proto::env::v1::{ExecOutcome, ExecStatusMsg};
		let mut result = VerificationCommandResult {
			stdout:        Bytes::new(),
			stderr:        Bytes::new(),
			status:        Some(ExecStatusMsg {
				outcome: ExecOutcome::Exited as i32,
				exit_code: Some(0),
				..Default::default()
			}),
			complete:      true,
			cancelled:     false,
			timed_out:     false,
			effects_known: true,
		};
		assert_eq!(outcome(&result), CheckOutcome::Passed);
		result.status.as_mut().expect("status").exit_code = Some(101);
		assert_eq!(outcome(&result), CheckOutcome::Failed);
		result.status.as_mut().expect("status").outcome = ExecOutcome::Failed as i32;
		assert_eq!(outcome(&result), CheckOutcome::Failed);
		result.status.as_mut().expect("status").exit_code = None;
		for (terminal, reason) in [
			(ExecOutcome::Denied, InconclusiveReason::Untrusted),
			(ExecOutcome::Timeout, InconclusiveReason::Incomplete),
			(ExecOutcome::Cancelled, InconclusiveReason::Cancelled),
			(ExecOutcome::Failed, InconclusiveReason::EffectsUnknown),
			(ExecOutcome::Unspecified, InconclusiveReason::Incomplete),
		] {
			result.status.as_mut().expect("status").outcome = terminal as i32;
			assert_eq!(outcome(&result), CheckOutcome::Inconclusive(reason));
		}
		let status = result.status.as_mut().expect("status");
		status.outcome = ExecOutcome::Exited as i32;
		status.aborted = true;
		assert_eq!(outcome(&result), CheckOutcome::Inconclusive(InconclusiveReason::Incomplete));
	}
}
