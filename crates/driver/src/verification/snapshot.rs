//! Coarse verification input identity over native content-addressed captures.

use std::{collections::BTreeSet, io, sync::Arc};

use omp_core::{Hash32, Str};
use omp_env::EnvClient;
use omp_exec::Digest;
use omp_proto::env::v1::{
	CaptureInputsReply, CaptureInputsRequest, RepositoryAvailability, RepositorySnapshot,
	RepositorySnapshotRequest, WorkspaceRootSetRequest,
};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::{CheckRequirement, PolicyError, VerificationPolicy, VerificationScope};
use crate::exec_composer::EnvironmentInputs;

pub(super) const KEY_VERSION: u32 = 1;
pub(super) const SNAPSHOT_DOMAIN: &str = "omp.verification.snapshot";

/// A required category of host-admitted verification inputs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "kebab-case")]
pub enum ContextField {
	/// Resolved dependencies, enabled features and supplemental generated
	/// inputs.
	Dependencies,
	/// Actual compiler, linker, formatter and other tool
	/// identities/configuration.
	Toolchain,
	/// Runner/platform, permitted environment, confinement and external inputs.
	Environment,
	/// Test selection, fixtures, seeds and corpora not already covered by
	/// source.
	Tests,
	/// Requirement and invariant references.
	Requirements,
	/// Trusted policy rules; the selected inventory is bound separately.
	Policy,
	/// Verifier implementation/version and shared configuration.
	Verifier,
}

/// Host-admitted identities supplementing the native regular-file capture.
///
/// These are digests of actual inputs/provenance, not model assertions or
/// merely version pins in a source file. `None` means unknown, never an empty
/// input set. A host may hash an explicitly established empty category.
/// Ignored/generated inputs must be covered by supplemental digests or declared
/// required paths; genuinely unresolved inputs must be listed and prevent a
/// reusable snapshot.
#[derive(Clone, Debug, Default)]
pub struct SnapshotContext {
	/// Resolved dependency/feature and supplemental-input identity.
	pub dependencies:      Option<Hash32>,
	/// Actual tool binaries/versions and configuration identity.
	pub toolchain:         Option<Hash32>,
	/// Complete execution environment/posture identity; use no raw secrets.
	pub environment:       Option<Hash32>,
	/// Test selection, fixtures and other test-input identity.
	pub tests:             Option<Hash32>,
	/// Requirement/invariant artifact identity.
	pub requirements:      Option<Hash32>,
	/// Trusted policy-rule identity, excluding the separately bound inventory.
	pub policy:            Option<Hash32>,
	/// Verifier version and shared configuration identity.
	pub verifier:          Option<Hash32>,
	/// Workspace-relative inputs that must occur in the native capture.
	pub required_paths:    Arc<[Str]>,
	/// Known unaccounted-for inputs; any entry refuses reusable identity.
	pub unresolved_inputs: Arc<[Str]>,
}

/// Capture, completeness or applicability could not be established.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
	/// A required input category has not been identified.
	#[error("verification context is unknown: {field}")]
	UnknownContext {
		/// Missing category.
		field: ContextField,
	},
	/// The host still knows of inputs outside the captured/declared closure.
	#[error("verification has unresolved inputs")]
	UnresolvedInputs {
		/// Host-provided descriptions, never secret values.
		inputs: Arc<[Str]>,
	},
	/// A required path is not a normalized relative capture path.
	#[error("invalid required verification path `{path}`")]
	InvalidRequiredPath {
		/// Rejected path spelling.
		path: Str,
	},
	/// A required file is missing or omitted, including Git-ignored files.
	#[error("required verification input was not captured: `{path}`")]
	MissingRequiredInput {
		/// Missing exact path.
		path: Str,
	},
	/// Native capture refused a tracked input.
	#[error("verification capture refused `{path}` under `{rule}`")]
	Refused {
		/// Refused path, not its contents.
		path: Str,
		/// Native refusal rule.
		rule: Str,
	},
	/// Untracked inputs were omitted by native security filtering.
	#[error("verification capture excluded {files} inputs under `{rule}`")]
	Excluded {
		/// Exclusion rule.
		rule:  Str,
		/// Omitted file count.
		files: u64,
	},
	/// Untracked symlinks are not captured by the native contract.
	#[error("verification capture omitted {count} symlinks")]
	ExcludedSymlinks {
		/// Omitted symlink count.
		count: u64,
	},
	/// The Environment has no complete committed repository identity.
	#[error("verification requires a complete versioned repository identity")]
	RepositoryUnavailable,
	/// A nested repository does not match the Environment's primary capture
	/// root.
	#[error("verification repository does not match the primary workspace root")]
	RootMismatch,
	/// Observed source identity or captured bytes changed during collection.
	#[error("verification inputs changed while being captured")]
	ChangedDuringCapture,
	/// A native reply has the wrong schema, malformed identity or inconsistent
	/// counts.
	#[error("verification capture reply or manifest is invalid")]
	InvalidCapture,
	/// A capture containing no files cannot establish this source-check
	/// contract.
	#[error("verification capture contains no files")]
	EmptyCapture,
	/// Native transport/capability failure, not an empty successful capture.
	#[error("verification environment request failed")]
	Environment(#[from] omp_env::ClientError),
	/// Manifest/blob verification or reading failed.
	#[error("verification capture evidence could not be read")]
	Manifest(#[source] io::Error),
	/// Canonical key serialization failed.
	#[error("verification input identity could not be encoded")]
	Encode(#[from] serde_json::Error),
	/// Required-check inventory validation failed.
	#[error("verification snapshot policy is invalid")]
	Policy(#[from] PolicyError),
	/// The selected policy belongs to a different snapshot.
	#[error("verification applicability policy belongs to another input snapshot")]
	PolicySnapshotMismatch,
	/// A cache key may not stand in for an undeclared check.
	#[error("verification applicability names undeclared check `{id}`")]
	UnknownCheck {
		/// Unknown exact check identity.
		id: Str,
	},
	/// Collection was interrupted; no snapshot is returned.
	#[error("verification capture was cancelled")]
	Cancelled,
}

#[derive(Clone, Debug, Serialize)]
struct ClosedContext {
	dependencies:   Hash32,
	toolchain:      Hash32,
	environment:    Hash32,
	tests:          Hash32,
	requirements:   Hash32,
	policy:         Hash32,
	verifier:       Hash32,
	required_paths: BTreeSet<Str>,
}

impl TryFrom<&SnapshotContext> for ClosedContext {
	type Error = SnapshotError;

	fn try_from(context: &SnapshotContext) -> Result<Self, Self::Error> {
		if !context.unresolved_inputs.is_empty() {
			return Err(SnapshotError::UnresolvedInputs { inputs: context.unresolved_inputs.clone() });
		}
		let required_paths = context
			.required_paths
			.iter()
			.map(|path| {
				if !valid_path(path) {
					return Err(SnapshotError::InvalidRequiredPath { path: path.clone() });
				}
				Ok(path.clone())
			})
			.collect::<Result<_, _>>()?;
		let known =
			|value: Option<Hash32>, field| value.ok_or(SnapshotError::UnknownContext { field });
		Ok(Self {
			dependencies: known(context.dependencies, ContextField::Dependencies)?,
			toolchain: known(context.toolchain, ContextField::Toolchain)?,
			environment: known(context.environment, ContextField::Environment)?,
			tests: known(context.tests, ContextField::Tests)?,
			requirements: known(context.requirements, ContextField::Requirements)?,
			policy: known(context.policy, ContextField::Policy)?,
			verifier: known(context.verifier, ContextField::Verifier)?,
			required_paths,
		})
	}
}

pub(super) fn valid_path(path: &str) -> bool {
	!path.contains(['\\', '\0'])
		&& !path.contains(':')
		&& path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct RepositoryIdentity {
	worktree_root: Str,
	primary_root:  Str,
	head:          Str,
	branch:        Str,
	staged:        u32,
	unstaged:      u32,
	untracked:     u32,
}

fn repository_identity(reply: &RepositorySnapshot) -> Result<RepositoryIdentity, SnapshotError> {
	if reply.availability != RepositoryAvailability::Available as i32
		|| reply.head.is_empty()
		|| reply.worktree_root_uri.is_empty()
		|| reply.primary_root_uri.is_empty()
		|| reply.truncated
	{
		return Err(SnapshotError::RepositoryUnavailable);
	}
	Ok(RepositoryIdentity {
		worktree_root: Str::new(reply.worktree_root_uri.trim_end_matches('/')),
		primary_root:  Str::new(reply.primary_root_uri.trim_end_matches('/')),
		head:          Str::new(&reply.head),
		branch:        Str::new(&reply.branch),
		staged:        reply.staged,
		unstaged:      reply.unstaged,
		untracked:     reply.untracked,
	})
}

pub(super) fn capture_digest(reply: &CaptureInputsReply) -> Result<Digest, SnapshotError> {
	if reply.wire_revision != omp_proto::SCHEMA_REV {
		return Err(SnapshotError::InvalidCapture);
	}
	if let Some(refused) = reply.refused.first() {
		return Err(SnapshotError::Refused {
			path: Str::new(&refused.path),
			rule: Str::new(&refused.rule),
		});
	}
	if let Some(excluded) = reply.excluded_rules.iter().find(|rule| rule.files != 0) {
		return Err(SnapshotError::Excluded {
			rule:  Str::new(&excluded.rule),
			files: excluded.files,
		});
	}
	if reply.excluded_symlinks != 0 {
		return Err(SnapshotError::ExcludedSymlinks { count: reply.excluded_symlinks });
	}
	if reply.files == 0 {
		return Err(SnapshotError::EmptyCapture);
	}
	let hash = reply
		.manifest_hash
		.as_ref()
		.try_into()
		.map_err(|_| SnapshotError::InvalidCapture)?;
	if reply.manifest_size < 11 {
		return Err(SnapshotError::InvalidCapture);
	}
	Ok(Digest::new(Hash32::new(hash), reply.manifest_size))
}

fn admit_stable_capture(
	first: &CaptureInputsReply,
	second: &CaptureInputsReply,
	before: &RepositoryIdentity,
	after: &RepositoryIdentity,
) -> Result<(), SnapshotError> {
	if capture_digest(first)? != capture_digest(second)?
		|| first.files != second.files
		|| first.bytes != second.bytes
		|| before != after
	{
		return Err(SnapshotError::ChangedDuringCapture);
	}
	Ok(())
}

#[derive(Serialize)]
struct SnapshotKey<'a> {
	domain:     &'static str,
	version:    u32,
	repository: &'a RepositoryIdentity,
	manifest:   Digest,
	files:      u64,
	bytes:      u64,
	context:    &'a ClosedContext,
}

/// Immutable captured-byte identity with observed repository stability fences.
///
/// Two matching captures detect ordinary drift; they do not lock out external
/// writers or prove an atomic live worktree. Checks must execute from frozen
/// captured inputs, or establish their own live-input fence, in S4. No gate or
/// cross-revision receipt is published by this type.
#[derive(Clone, Debug)]
pub struct VerificationSnapshot {
	inputs:    Hash32,
	manifest:  Digest,
	context:   ClosedContext,
	canonical: Arc<[u8]>,
}

impl VerificationSnapshot {
	/// SHA-256 over the versioned canonical source/context record.
	pub const fn inputs_digest(&self) -> Hash32 {
		self.inputs
	}

	/// Existing Environment CAS manifest; no second source/blob store is
	/// created.
	pub const fn manifest(&self) -> Digest {
		self.manifest
	}

	/// Exact canonical record bytes, suitable for later evidence-store
	/// retention.
	pub fn canonical_bytes(&self) -> &[u8] {
		&self.canonical
	}

	/// Constructs an S1 policy binding both rule identities and exact inventory.
	pub fn policy(
		&self,
		checks: impl Into<Arc<[CheckRequirement]>>,
	) -> Result<VerificationPolicy, SnapshotError> {
		#[derive(Serialize)]
		struct Check<'a> {
			id:       &'a str,
			required: bool,
		}
		#[derive(Serialize)]
		struct Policy<'a> {
			domain:       &'static str,
			version:      u32,
			rules:        Hash32,
			requirements: Hash32,
			checks:       Vec<Check<'a>>,
		}
		let checks = checks.into();
		let policy = Hash32::sum(serde_json::to_vec(&Policy {
			domain:       "omp.verification.policy",
			version:      KEY_VERSION,
			rules:        self.context.policy,
			requirements: self.context.requirements,
			checks:       checks
				.iter()
				.map(|check| Check { id: check.id.as_str(), required: check.required })
				.collect(),
		})?);
		Ok(VerificationPolicy::new(VerificationScope { inputs: self.inputs, policy }, checks)?)
	}

	/// Identifies one declared verifier action over this entire captured
	/// closure.
	///
	/// `configuration` must identify exact command/rule arguments, selected
	/// inputs, resource/timeout semantics and other per-check configuration. It
	/// is supplied by the trusted adapter, never inferred from a check's
	/// display name.
	pub fn applicability_key(
		&self,
		policy: &VerificationPolicy,
		check: &str,
		configuration: Hash32,
	) -> Result<Hash32, SnapshotError> {
		#[derive(Serialize)]
		struct Action<'a> {
			domain:        &'static str,
			version:       u32,
			inputs:        Hash32,
			policy:        Hash32,
			check:         &'a str,
			configuration: Hash32,
		}
		if policy.scope() != self.policy(policy.requirements())?.scope() {
			return Err(SnapshotError::PolicySnapshotMismatch);
		}
		if !policy
			.requirements()
			.iter()
			.any(|entry| entry.id.as_str() == check)
		{
			return Err(SnapshotError::UnknownCheck { id: Str::new(check) });
		}
		Ok(Hash32::sum(serde_json::to_vec(&Action {
			domain: "omp.verification.action",
			version: KEY_VERSION,
			inputs: self.inputs,
			policy: policy.scope().policy,
			check,
			configuration,
		})?))
	}
}

/// Captures the primary repository through native Environment APIs only.
///
/// Refuses reported omissions and unknown declared inputs; requires matching
/// repository identity and two CAS manifests. Native metadata response counters
/// are not source generations and never enter keys. Cancelling stops the driver
/// waiting; a host-side blocking read may finish after its request future is
/// dropped.
pub async fn capture_verification_snapshot(
	environment: &EnvClient,
	context: &SnapshotContext,
	cancel: &CancellationToken,
) -> Result<VerificationSnapshot, SnapshotError> {
	tokio::select! {
		biased;
		() = cancel.cancelled() => Err(SnapshotError::Cancelled),
		result = capture(environment, context) => result,
	}
}

async fn capture(
	environment: &EnvClient,
	context: &SnapshotContext,
) -> Result<VerificationSnapshot, SnapshotError> {
	let context = ClosedContext::try_from(context)?;
	let roots = environment
		.workspace_roots(WorkspaceRootSetRequest { wire_revision: omp_proto::SCHEMA_REV })
		.await?;
	if roots.wire_revision != omp_proto::SCHEMA_REV {
		return Err(SnapshotError::InvalidCapture);
	}
	let root = roots.primary.ok_or(SnapshotError::RootMismatch)?;
	let before = repository_identity(&repository(environment).await?)?;
	if before.worktree_root.as_str() != root.canonical_uri.trim_end_matches('/') {
		return Err(SnapshotError::RootMismatch);
	}
	let first = capture_inputs(environment).await?;
	let manifest = capture_digest(&first)?;
	let files = EnvironmentInputs::new(environment.clone())
		.captured_files(manifest)
		.await
		.map_err(SnapshotError::Manifest)?;
	let mut bytes = 0_u64;
	let mut paths = BTreeSet::new();
	for (path, size) in &files {
		if !valid_path(path) || !paths.insert(path.as_str()) {
			return Err(SnapshotError::InvalidCapture);
		}
		bytes = bytes
			.checked_add(*size)
			.ok_or(SnapshotError::InvalidCapture)?;
	}
	if first.files != files.len() as u64 || first.bytes != bytes {
		return Err(SnapshotError::InvalidCapture);
	}
	for path in &context.required_paths {
		if !paths.contains(path.as_str()) {
			return Err(SnapshotError::MissingRequiredInput { path: path.clone() });
		}
	}
	let second = capture_inputs(environment).await?;
	let after = repository_identity(&repository(environment).await?)?;
	admit_stable_capture(&first, &second, &before, &after)?;
	let canonical: Arc<[u8]> = serde_json::to_vec(&SnapshotKey {
		domain: SNAPSHOT_DOMAIN,
		version: KEY_VERSION,
		repository: &before,
		manifest,
		files: first.files,
		bytes: first.bytes,
		context: &context,
	})?
	.into();
	Ok(VerificationSnapshot { inputs: Hash32::sum(&canonical), manifest, context, canonical })
}

async fn repository(environment: &EnvClient) -> Result<RepositorySnapshot, omp_env::ClientError> {
	environment
		.repository_snapshot(RepositorySnapshotRequest {
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		})
		.await
}

async fn capture_inputs(
	environment: &EnvClient,
) -> Result<CaptureInputsReply, omp_env::ClientError> {
	environment
		.capture_inputs(CaptureInputsRequest {
			include_untracked: true,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		})
		.await
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
