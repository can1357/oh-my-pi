//! Explicit extension upgrade, rollback, pin, uninstall, and generation GC.

use std::{
	cmp,
	collections::{BTreeMap, BTreeSet},
	fs,
	future::Future,
	io,
	num::NonZeroUsize,
	path::{Path, PathBuf},
	time::Duration,
};

use futures::{StreamExt as _, stream};
use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString};

use super::{
	ExtensionCode, ExtensionError, Layer,
	config::{FeatureManifest, FeatureSelection},
	index::{IndexArtifact, IndexRelease, SignedIndex},
	lock::{InstalledRecord, LockFile, atomic_toml},
	trust::{
		RevocationFreshness, RevocationsFile, verify_artifact_signature, verify_publisher_rotation,
	},
};

/// Bounds applied to one batch of update availability checks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdateCheckLimits {
	concurrency: NonZeroUsize,
	timeout:     Duration,
}

impl UpdateCheckLimits {
	/// Builds positive concurrency and timeout limits.
	pub fn new(concurrency: usize, timeout: Duration) -> Option<Self> {
		Some(Self {
			concurrency: NonZeroUsize::new(concurrency)?,
			timeout:     (timeout > Duration::ZERO).then_some(timeout)?,
		})
	}

	/// Maximum checks allowed to run at once.
	pub const fn concurrency(self) -> usize {
		self.concurrency.get()
	}

	/// Wall-clock deadline applied independently to each check.
	pub const fn timeout(self) -> Duration {
		self.timeout
	}
}

impl Default for UpdateCheckLimits {
	fn default() -> Self {
		Self {
			concurrency: NonZeroUsize::new(4).expect("four is non-zero"),
			timeout:     Duration::from_secs(10),
		}
	}
}

/// Typed terminal state of one bounded update check.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateCheckOutcome<T, E> {
	/// The check completed successfully.
	Ready(T),
	/// The check completed with a typed source failure.
	Failed(E),
	/// The check exceeded its independent deadline.
	TimedOut,
}

/// Runs update checks with a fixed concurrency ceiling and per-check timeout.
///
/// Results retain input order even though checks complete out of order.
#[tracing::instrument(
	name = "extension_index_fetch",
	level = "debug",
	skip_all,
	fields(
		concurrency = limits.concurrency(),
		timeout_ms = %limits.timeout().as_millis()
	)
)]
pub async fn run_bounded_update_checks<I, F, Fut, T, E>(
	items: I,
	limits: UpdateCheckLimits,
	check: F,
) -> Vec<UpdateCheckOutcome<T, E>>
where
	I: IntoIterator,
	I::Item: Send,
	F: Fn(I::Item) -> Fut + Copy,
	Fut: Future<Output = Result<T, E>>,
{
	let mut completed = stream::iter(items.into_iter().enumerate())
		.map(|(ordinal, item)| async move {
			let outcome = match tokio::time::timeout(limits.timeout(), check(item)).await {
				Ok(Ok(value)) => UpdateCheckOutcome::Ready(value),
				Ok(Err(error)) => UpdateCheckOutcome::Failed(error),
				Err(_) => UpdateCheckOutcome::TimedOut,
			};
			(ordinal, outcome)
		})
		.buffer_unordered(limits.concurrency())
		.collect::<Vec<_>>()
		.await;
	completed.sort_by_key(|(ordinal, _)| *ordinal);
	let outcomes = completed
		.into_iter()
		.map(|(_, outcome)| outcome)
		.collect::<Vec<_>>();
	let failed = outcomes
		.iter()
		.filter(|outcome| matches!(outcome, UpdateCheckOutcome::Failed(_)))
		.count();
	let timed_out = outcomes
		.iter()
		.filter(|outcome| matches!(outcome, UpdateCheckOutcome::TimedOut))
		.count();
	if failed == 0 && timed_out == 0 {
		tracing::debug!(check_count = outcomes.len(), "extension index fetch completed");
	} else {
		tracing::warn!(
			check_count = outcomes.len(),
			failed,
			timed_out,
			"extension index fetch failed"
		);
	}
	outcomes
}

/// Durable exact-version pins used only by explicit resolver operations.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct PinsFile {
	/// File format version.
	#[serde(default = "one")]
	pub version: u32,
	/// Exact extension pins.
	#[serde(default, rename = "pin")]
	pub pins:    Vec<Pin>,
}

/// One extension version pin.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Pin {
	/// Extension identity.
	pub id:      Str,
	/// Exact pinned version.
	pub version: Str,
}

impl PinsFile {
	/// Reads an absent pin file as an empty set.
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		if !path.exists() {
			return Ok(Self { version: 1, pins: Vec::new() });
		}
		let value = fs::read_to_string(path)
			.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))?;
		toml::from_str(&value)
			.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))
	}

	/// Sets or replaces one exact pin and persists atomically.
	pub fn set(&mut self, path: &Path, id: Str, version: Str) -> io::Result<()> {
		if let Some(pin) = self.pins.iter_mut().find(|pin| pin.id == id) {
			pin.version = version;
		} else {
			self.pins.push(Pin { id, version });
		}
		self.pins.sort_by(|left, right| left.id.cmp(&right.id));
		atomic_toml(path, self)
	}

	/// Removes one pin and persists atomically.
	pub fn remove(&mut self, path: &Path, id: &str) -> io::Result<bool> {
		let before = self.pins.len();
		self.pins.retain(|pin| pin.id != id);
		if self.pins.len() == before {
			return Ok(false);
		}
		atomic_toml(path, self)?;
		Ok(true)
	}
}

const fn one() -> u32 {
	1
}

/// Dry-run description of records affected by an uninstall.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct UninstallPlan {
	/// Installed identities that will be removed.
	pub installed: Vec<Str>,
	/// Lock identities that will be removed.
	pub locked:    Vec<Str>,
	/// Requested identities not present in either authority.
	pub missing:   Vec<Str>,
}

/// Computes uninstall effects without mutating either state file.
pub fn plan_uninstall(
	installed: &InstalledRecord,
	lock: &LockFile,
	ids: impl IntoIterator<Item = Str>,
	keep_lock: bool,
) -> UninstallPlan {
	let mut plan = UninstallPlan::default();
	for id in ids {
		let present_installed = installed.extensions.iter().any(|entry| entry.id == id);
		let present_locked = lock.extensions.iter().any(|entry| entry.id == id);
		if present_installed {
			plan.installed.push(id.clone());
		}
		if present_locked && !keep_lock {
			plan.locked.push(id.clone());
		}
		if !present_installed && !present_locked {
			plan.missing.push(id);
		}
	}
	plan
}

/// Applies a previously reviewed uninstall plan in memory.
pub fn apply_uninstall(installed: &mut InstalledRecord, lock: &mut LockFile, plan: &UninstallPlan) {
	let installed_ids: BTreeSet<&Str> = plan.installed.iter().collect();
	installed
		.extensions
		.retain(|entry| !installed_ids.contains(&entry.id));
	let locked_ids: BTreeSet<&Str> = plan.locked.iter().collect();
	lock
		.extensions
		.retain(|entry| !locked_ids.contains(&entry.id));
	lock.packages.retain_mut(|package| {
		package.requested_by.retain(|id| !locked_ids.contains(id));
		!package.requested_by.is_empty()
	});
}

/// Enables or disables exactly one installed extension.
pub fn set_enabled(
	installed: &mut InstalledRecord,
	id: &str,
	enabled: bool,
) -> Result<(), ExtensionError> {
	let entry = installed
		.extensions
		.iter_mut()
		.find(|entry| entry.id == id)
		.ok_or_else(|| {
			ExtensionError::new(ExtensionCode::ENoManifest, "extension is not installed")
		})?;
	entry.enabled = enabled;
	Ok(())
}

/// Expands an install request into the concrete feature set persisted in the
/// lock and install record.
///
/// An absent selection preserves the previous set on reinstall and expands
/// manifest defaults only for a new install.
pub fn concrete_features(
	request: &FeatureSelection,
	manifest: &BTreeMap<Str, FeatureManifest>,
	previous: Option<&[Str]>,
) -> Result<Vec<Str>, ExtensionError> {
	let mut selected = match request {
		FeatureSelection::Absent => previous.map_or_else(
			|| {
				manifest
					.iter()
					.filter(|(_, feature)| feature.default)
					.map(|(name, _)| name.clone())
					.collect()
			},
			<[Str]>::to_vec,
		),
		FeatureSelection::None => Vec::new(),
		FeatureSelection::All => manifest.keys().cloned().collect(),
		FeatureSelection::Named(names) => names.clone(),
	};
	selected.sort();
	selected.dedup();
	for name in &selected {
		if !manifest.contains_key(name) {
			return Err(ExtensionError::new(
				ExtensionCode::EFeature,
				format!("unknown feature {name}"),
			));
		}
	}
	Ok(selected)
}

/// Verified replacement state staged for one explicit upgrade or rollback.
#[derive(Clone, Debug)]
pub struct Generation {
	/// Reproducible lock state.
	pub lock:      LockFile,
	/// Local enabled/link selection state.
	pub installed: InstalledRecord,
}
/// Stable reason that a verified candidate cannot be committed automatically.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum UpdateRefusal {
	/// The candidate no longer declares the current concrete feature set.
	FeatureRemoved,
	/// The selected effective capability digest changed.
	CapabilityChanged,
	/// An exact operator pin excludes the candidate version.
	Pinned,
	/// Revocation metadata is not fresh enough for mutation.
	StaleRevocations,
	/// The publisher artifact signature did not verify.
	BadSignature,
	/// Index review/attestation is absent.
	AttestationMissing,
	/// The candidate publisher key differs from the pinned publisher.
	PublisherChanged,
	/// The advertised release is yanked.
	Yanked,
	/// The candidate version is revoked.
	Revoked,
	/// The candidate lock does not match signed index metadata.
	Integrity,
}

/// Semantic change between an immutable startup lock and one candidate.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct UpdateDiff {
	/// Extension identity.
	pub id: Str,
	/// Version observed by the starting session.
	pub from_version: Str,
	/// Verified candidate version.
	pub to_version: Str,
	/// Concrete features retained from the startup generation.
	pub features: Vec<Str>,
	/// Startup selected declaration digest.
	pub from_declaration_digest: Str,
	/// Candidate selected declaration digest.
	pub to_declaration_digest: Str,
	/// Startup effective capability digest.
	pub from_capability_digest: Str,
	/// Candidate effective capability digest.
	pub to_capability_digest: Str,
	/// Startup complete capability-graph digest.
	pub from_manifest_capability_digest: Str,
	/// Candidate complete capability-graph digest.
	pub to_manifest_capability_digest: Str,
}

/// One candidate update and its auto-commit eligibility.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct UpdateItem {
	/// Semantic version and manifest difference.
	pub diff:    UpdateDiff,
	/// Typed refusal; absent only for an auto-eligible item.
	pub refusal: Option<UpdateRefusal>,
}

/// Result of verifying one fully resolved temporary generation.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct CandidateReport {
	/// Version changes in stable lock order.
	pub items:       Vec<UpdateItem>,
	/// Startup extensions newly found to be revoked.
	pub quarantined: Vec<Str>,
}

impl CandidateReport {
	/// Returns whether the generation contains updates and every update is
	/// eligible for an atomic client-layer commit.
	pub fn can_commit(&self) -> bool {
		!self.items.is_empty()
			&& self.items.iter().all(|item| item.refusal.is_none())
			&& self.quarantined.is_empty()
	}
}

/// Resolves the newest signed-index roots into a temporary generation without
/// mutating active files.
///
/// The dependency closure remains owned by the caller's resolver. This helper
/// updates root records after a complete candidate lock has been built, and is
/// also sufficient when root requirements leave the existing closure unchanged.
pub fn resolve_candidate_generation(
	current: &Generation,
	index: &SignedIndex,
	target: &str,
) -> Result<Generation, ExtensionError> {
	let mut candidate = current.clone();
	for locked in &mut candidate.lock.extensions {
		let Some(extension) = index
			.extensions
			.iter()
			.find(|extension| extension.id == locked.id)
		else {
			continue;
		};
		let mut release = None;
		for advertised in &extension.releases {
			super::resolver::compare_versions(
				advertised.version.as_str(),
				advertised.version.as_str(),
			)?;
			if release.is_none_or(|latest: &IndexRelease| {
				super::resolver::compare_versions(advertised.version.as_str(), latest.version.as_str())
					.is_ok_and(|ordering| ordering.is_gt())
			}) {
				release = Some(advertised);
			}
		}
		let Some(release) = release else {
			continue;
		};
		if super::resolver::compare_versions(release.version.as_str(), locked.version.as_str())?
			.is_le()
		{
			continue;
		}
		let Some(artifact) = release_artifact(release, target) else {
			continue;
		};
		let projection = release.deployment_manifest().project(&locked.features)?;
		locked.version = release.version.clone();
		locked.publisher = extension.publisher_key.clone();
		locked.manifest_digest = release.manifest_digest.clone();
		locked.declaration_digest = projection.declaration_digest;
		locked.capability_digest = projection.capability_digest;
		locked.manifest_capability_digest = projection.manifest_capability_digest;
		locked.signature = artifact.signature.clone();
		locked.requires = projection.requires;
		locked.wheel = super::lock::Wheel {
			file:   artifact.file.clone(),
			tag:    artifact.tag.clone(),
			size:   artifact.size,
			blake3: artifact.blake3.clone(),
			sha256: artifact.sha256.clone(),
		};
		if let Some(source) = locked.source.as_table_mut() {
			source.insert("version".to_owned(), toml::Value::String(release.version.to_string()));
		}
	}
	Ok(candidate)
}

/// Verifies the root records of a fully resolved temporary generation and
/// computes a typed semantic diff.
///
/// Resolution and artifact download happen before this boundary. This function
/// is the shared explicit/background verifier: it never mutates either
/// generation and classifies every policy refusal for notification.
pub fn verify_candidate_generation(
	current: &Generation,
	candidate: &Generation,
	index: &SignedIndex,
	pins: &PinsFile,
	revocations: &RevocationsFile,
	freshness: RevocationFreshness,
	target: &str,
) -> Result<CandidateReport, ExtensionError> {
	current.lock.validate_for(current.lock.layer)?;
	candidate.lock.validate_for(candidate.lock.layer)?;
	if current.lock.layer != candidate.lock.layer {
		return Err(ExtensionError::new(
			ExtensionCode::ELockLayer,
			"candidate generation belongs to a different layer",
		));
	}
	let mut report = CandidateReport::default();
	for locked in &current.lock.extensions {
		if revocations
			.revocation_for(&locked.id, &locked.version)?
			.is_some()
		{
			report.quarantined.push(locked.id.clone());
		}
		let Some(replacement) = candidate
			.lock
			.extensions
			.iter()
			.find(|replacement| replacement.id == locked.id)
		else {
			report.items.push(UpdateItem {
				diff:    missing_candidate_diff(locked),
				refusal: Some(UpdateRefusal::FeatureRemoved),
			});
			continue;
		};
		if super::resolver::compare_versions(replacement.version.as_str(), locked.version.as_str())?
			.is_le()
		{
			continue;
		}
		let diff = update_diff(locked, replacement);
		let refusal = candidate_refusal(
			locked,
			replacement,
			candidate,
			index,
			pins,
			revocations,
			freshness,
			target,
		)?;
		report.items.push(UpdateItem { diff, refusal });
	}
	report.quarantined.sort();
	report.quarantined.dedup();
	Ok(report)
}

#[allow(
	clippy::too_many_arguments,
	reason = "the verifier boundary names each independent signed policy input"
)]
fn candidate_refusal(
	current: &super::lock::LockedExtension,
	candidate: &super::lock::LockedExtension,
	generation: &Generation,
	index: &SignedIndex,
	pins: &PinsFile,
	revocations: &RevocationsFile,
	freshness: RevocationFreshness,
	target: &str,
) -> Result<Option<UpdateRefusal>, ExtensionError> {
	if pins
		.pins
		.iter()
		.any(|pin| pin.id == current.id && pin.version != candidate.version)
	{
		return Ok(Some(UpdateRefusal::Pinned));
	}
	if current.features != candidate.features {
		return Ok(Some(UpdateRefusal::FeatureRemoved));
	}
	let Some(index_extension) = index
		.extensions
		.iter()
		.find(|extension| extension.id == current.id)
	else {
		return Ok(Some(UpdateRefusal::Integrity));
	};
	if index_extension.publisher_key != current.publisher {
		let Some(rotation) = index_extension.key_rotation.as_ref() else {
			return Ok(Some(UpdateRefusal::PublisherChanged));
		};
		if candidate.publisher != index_extension.publisher_key
			|| verify_publisher_rotation(
				current.publisher.as_str(),
				&current.id,
				index_extension.publisher_key.as_str(),
				rotation,
			)
			.is_err()
		{
			return Ok(Some(UpdateRefusal::PublisherChanged));
		}
	} else if candidate.publisher != current.publisher {
		return Ok(Some(UpdateRefusal::PublisherChanged));
	}
	let Some(release) = index_extension
		.releases
		.iter()
		.find(|release| release.version == candidate.version)
	else {
		return Ok(Some(UpdateRefusal::Integrity));
	};
	if release.yanked {
		return Ok(Some(UpdateRefusal::Yanked));
	}
	if !release.attested {
		return Ok(Some(UpdateRefusal::AttestationMissing));
	}
	if current
		.features
		.iter()
		.any(|feature| !release.features.contains_key(feature))
	{
		return Ok(Some(UpdateRefusal::FeatureRemoved));
	}
	if revocations
		.revocation_for(&candidate.id, &candidate.version)?
		.is_some()
	{
		return Ok(Some(UpdateRefusal::Revoked));
	}
	if freshness != RevocationFreshness::Fresh {
		return Ok(Some(UpdateRefusal::StaleRevocations));
	}
	let projection = release.deployment_manifest().project(&current.features)?;
	if projection.capability_digest != current.capability_digest
		|| candidate.capability_digest != projection.capability_digest
	{
		return Ok(Some(UpdateRefusal::CapabilityChanged));
	}
	if candidate.manifest_digest != release.manifest_digest
		|| candidate.manifest_capability_digest != release.manifest_capability_digest
		|| candidate.manifest_capability_digest != projection.manifest_capability_digest
		|| candidate.declaration_digest != projection.declaration_digest
		|| candidate.requires != projection.requires
		|| candidate.requires != current.requires
	{
		return Ok(Some(UpdateRefusal::Integrity));
	}
	let Some(artifact) = release_artifact(release, target) else {
		return Ok(Some(UpdateRefusal::Integrity));
	};
	if !locked_artifact_matches(candidate, artifact)
		|| generation
			.installed
			.extensions
			.iter()
			.find(|installed| installed.id == candidate.id)
			.is_none_or(|installed| installed.features != current.features)
	{
		return Ok(Some(UpdateRefusal::Integrity));
	}
	if verify_artifact_signature(
		index_extension.publisher_key.as_str(),
		artifact.blake3.as_str(),
		artifact.sha256.as_str(),
		release.signature_capability_digest().as_str(),
		artifact.signature.as_str(),
	)
	.is_err()
	{
		return Ok(Some(UpdateRefusal::BadSignature));
	}
	Ok(None)
}

fn release_artifact<'a>(release: &'a IndexRelease, target: &str) -> Option<&'a IndexArtifact> {
	release
		.artifacts
		.iter()
		.find(|artifact| artifact.target == target)
		.or_else(|| {
			release
				.artifacts
				.iter()
				.find(|artifact| artifact.target == "any")
		})
}

fn locked_artifact_matches(
	locked: &super::lock::LockedExtension,
	artifact: &IndexArtifact,
) -> bool {
	locked.wheel.file == artifact.file
		&& locked.wheel.tag == artifact.tag
		&& locked.wheel.size == artifact.size
		&& locked.wheel.blake3 == artifact.blake3
		&& locked.wheel.sha256 == artifact.sha256
		&& locked.signature == artifact.signature
}

fn update_diff(
	current: &super::lock::LockedExtension,
	candidate: &super::lock::LockedExtension,
) -> UpdateDiff {
	UpdateDiff {
		id: current.id.clone(),
		from_version: current.version.clone(),
		to_version: candidate.version.clone(),
		features: current.features.clone(),
		from_declaration_digest: current.declaration_digest.clone(),
		to_declaration_digest: candidate.declaration_digest.clone(),
		from_capability_digest: current.capability_digest.clone(),
		to_capability_digest: candidate.capability_digest.clone(),
		from_manifest_capability_digest: current.manifest_capability_digest.clone(),
		to_manifest_capability_digest: candidate.manifest_capability_digest.clone(),
	}
}

fn missing_candidate_diff(current: &super::lock::LockedExtension) -> UpdateDiff {
	UpdateDiff {
		id: current.id.clone(),
		from_version: current.version.clone(),
		to_version: Str::new_static(""),
		features: current.features.clone(),
		from_declaration_digest: current.declaration_digest.clone(),
		to_declaration_digest: Str::new_static(""),
		from_capability_digest: current.capability_digest.clone(),
		to_capability_digest: Str::new_static(""),
		from_manifest_capability_digest: current.manifest_capability_digest.clone(),
		to_manifest_capability_digest: Str::new_static(""),
	}
}

/// Commits an eligible verified client generation. Workspace locks are always
/// notify-only and are rejected at this final mutation boundary.
pub fn commit_auto_generation(
	lock_path: &Path,
	installed_path: &Path,
	generation_root: &Path,
	generation_id: &str,
	generation: &Generation,
	report: &CandidateReport,
) -> Result<PathBuf, ExtensionError> {
	if generation.lock.layer != Layer::Client {
		return Err(ExtensionError::new(
			ExtensionCode::EUpdatePolicy,
			"background auto-update never commits workspace locks",
		));
	}
	if !report.can_commit() {
		return Err(ExtensionError::new(
			ExtensionCode::EUpdatePolicy,
			"candidate generation is notify-only",
		));
	}
	commit_generation(lock_path, installed_path, generation_root, generation_id, generation)
}

/// Writes a verified generation while retaining a restorable copy of the prior
/// generation. Verification must happen before calling this function.
pub fn commit_generation(
	lock_path: &Path,
	installed_path: &Path,
	generation_root: &Path,
	generation_id: &str,
	generation: &Generation,
) -> Result<PathBuf, ExtensionError> {
	generation.lock.validate_for(generation.lock.layer)?;
	validate_generation_id(generation_id)?;
	fs::create_dir_all(generation_root).map_err(integrity)?;
	let stage_id = format!("{generation_id}.staging");
	let stage = contained_generation_path(generation_root, &stage_id, false)?;
	let committed = contained_generation_path(generation_root, generation_id, false)?;
	remove_contained_directory(generation_root, &stage)?;
	fs::create_dir(&stage).map_err(integrity)?;
	generation
		.lock
		.write(&stage.join("omp.lock"))
		.map_err(integrity)?;
	generation
		.installed
		.write(&stage.join("installed.toml"))
		.map_err(integrity)?;
	remove_contained_directory(generation_root, &committed)?;
	fs::rename(&stage, &committed).map_err(integrity)?;

	let old_lock = fs::read(lock_path).ok();
	let old_installed = fs::read(installed_path).ok();
	if let Err(error) = generation.lock.write(lock_path) {
		return Err(integrity(error));
	}
	if let Err(error) = generation.installed.write(installed_path) {
		restore(lock_path, old_lock.as_deref());
		restore(installed_path, old_installed.as_deref());
		return Err(integrity(error));
	}
	Ok(committed)
}

/// Loads an immutable prior generation for an explicit rollback.
pub fn load_generation(
	generation_root: &Path,
	generation_id: &str,
	layer: Layer,
) -> Result<Generation, ExtensionError> {
	validate_generation_id(generation_id)?;
	let root = contained_generation_path(generation_root, generation_id, true)?;
	Ok(Generation {
		lock:      LockFile::read(&root.join("omp.lock"), layer)?,
		installed: InstalledRecord::read(&root.join("installed.toml"))?,
	})
}

/// GC report. Collection is a dry run unless `apply` is true.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GcReport {
	/// Unreachable generation directories.
	pub generations: Vec<PathBuf>,
	/// Total bytes reachable beneath those directories.
	pub bytes:       u64,
}

/// Retains the newest `keep` immutable generations and reports or removes the
/// remainder. Active lock/install files are outside this cache and cannot be
/// collected.
pub fn gc_generations(root: &Path, keep: usize, apply: bool) -> Result<GcReport, ExtensionError> {
	if !root.exists() {
		return Ok(GcReport::default());
	}
	let mut entries = fs::read_dir(root)
		.map_err(integrity)?
		.filter_map(Result::ok)
		.filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
		.collect::<Vec<_>>();
	entries.sort_by_key(|entry| cmp::Reverse(entry.file_name()));
	let mut report = GcReport::default();
	for entry in entries.into_iter().skip(keep) {
		let path = entry.path();
		report.bytes = report.bytes.saturating_add(directory_bytes(&path)?);
		report.generations.push(path.clone());
		if apply {
			fs::remove_dir_all(path).map_err(integrity)?;
		}
	}
	Ok(report)
}

fn directory_bytes(root: &Path) -> Result<u64, ExtensionError> {
	let mut total = 0_u64;
	let mut pending = vec![root.to_path_buf()];
	while let Some(path) = pending.pop() {
		for entry in fs::read_dir(path).map_err(integrity)? {
			let entry = entry.map_err(integrity)?;
			let metadata = entry.metadata().map_err(integrity)?;
			if metadata.is_dir() {
				pending.push(entry.path());
			} else {
				total = total.saturating_add(metadata.len());
			}
		}
	}
	Ok(total)
}

fn validate_generation_id(generation_id: &str) -> Result<(), ExtensionError> {
	if generation_id.is_empty()
		|| matches!(generation_id, "." | "..")
		|| generation_id.len() > 128
		|| !generation_id
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
	{
		return Err(ExtensionError::new(ExtensionCode::EIntegrity, "invalid generation id"));
	}
	Ok(())
}

fn contained_generation_path(
	generation_root: &Path,
	generation_id: &str,
	must_exist: bool,
) -> Result<PathBuf, ExtensionError> {
	validate_generation_id(generation_id)?;
	let canonical_root = generation_root.canonicalize().map_err(integrity)?;
	let candidate = canonical_root.join(generation_id);
	if must_exist {
		let metadata = fs::symlink_metadata(&candidate).map_err(integrity)?;
		if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
			return Err(ExtensionError::new(
				ExtensionCode::EIntegrity,
				"generation is not an owned directory",
			));
		}
		let canonical_candidate = candidate.canonicalize().map_err(integrity)?;
		if canonical_candidate.parent() != Some(canonical_root.as_path()) {
			return Err(ExtensionError::new(
				ExtensionCode::EIntegrity,
				"generation escapes the generation root",
			));
		}
		return Ok(canonical_candidate);
	}
	if candidate.parent() != Some(canonical_root.as_path()) {
		return Err(ExtensionError::new(
			ExtensionCode::EIntegrity,
			"generation escapes the generation root",
		));
	}
	Ok(candidate)
}

fn remove_contained_directory(generation_root: &Path, path: &Path) -> Result<(), ExtensionError> {
	let Ok(metadata) = fs::symlink_metadata(path) else {
		return Ok(());
	};
	if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
		return Err(ExtensionError::new(
			ExtensionCode::EIntegrity,
			"generation cache entry is not an owned directory",
		));
	}
	let canonical_root = generation_root.canonicalize().map_err(integrity)?;
	let canonical_path = path.canonicalize().map_err(integrity)?;
	if canonical_path.parent() != Some(canonical_root.as_path()) {
		return Err(ExtensionError::new(
			ExtensionCode::EIntegrity,
			"generation cache entry escapes the generation root",
		));
	}
	fs::remove_dir_all(canonical_path).map_err(integrity)
}

fn restore(path: &Path, bytes: Option<&[u8]>) {
	match bytes {
		Some(bytes) => {
			let _ = fs::write(path, bytes);
		},
		None => {
			let _ = fs::remove_file(path);
		},
	}
}

fn integrity(error: io::Error) -> ExtensionError {
	ExtensionError::new(ExtensionCode::EIntegrity, error.to_string())
}

#[cfg(test)]
mod tests {
	use super::*;
	#[tokio::test]
	async fn bounded_update_checks_timeout_and_retain_input_order() {
		let limits = UpdateCheckLimits::new(2, Duration::from_millis(10)).expect("positive limits");
		let outcomes = run_bounded_update_checks([30_u64, 1], limits, |delay| async move {
			tokio::time::sleep(Duration::from_millis(delay)).await;
			Ok::<_, ()>(delay)
		})
		.await;
		assert_eq!(outcomes, [UpdateCheckOutcome::TimedOut, UpdateCheckOutcome::Ready(1)]);
	}

	fn empty_generation(layer: Layer) -> Generation {
		Generation {
			lock:      LockFile {
				version: 2,
				generated_by: String::new(),
				generated_at: String::new(),
				layer,
				requires_python: Str::new_static("==3.14.*"),
				abi: Str::new_static("cp314t"),
				targets: Vec::new(),
				exclude_newer: None,
				indexes: Vec::new(),
				index_strategy: Str::new_static("first-index"),
				extensions: Vec::new(),
				packages: Vec::new(),
				frozen: Vec::new(),
			},
			installed: InstalledRecord::default(),
		}
	}

	fn empty_diff() -> UpdateDiff {
		UpdateDiff {
			id: Str::new_static("acme.demo"),
			from_version: Str::new_static("1"),
			to_version: Str::new_static("2"),
			features: Vec::new(),
			from_declaration_digest: Str::new_static("from-decl"),
			to_declaration_digest: Str::new_static("to-decl"),
			from_capability_digest: Str::new_static("same-cap"),
			to_capability_digest: Str::new_static("same-cap"),
			from_manifest_capability_digest: Str::new_static("from-manifest"),
			to_manifest_capability_digest: Str::new_static("to-manifest"),
		}
	}

	#[test]
	fn auto_commit_boundary_rejects_workspace_and_typed_refusals() {
		let temporary = tempfile::tempdir().expect("state");
		let report = CandidateReport {
			items:       vec![UpdateItem {
				diff:    empty_diff(),
				refusal: Some(UpdateRefusal::Pinned),
			}],
			quarantined: Vec::new(),
		};
		let workspace = empty_generation(Layer::Workspace);
		let error = commit_auto_generation(
			&temporary.path().join("omp.lock"),
			&temporary.path().join("installed.toml"),
			&temporary.path().join("generations"),
			"workspace",
			&workspace,
			&report,
		)
		.expect_err("workspace is always notify-only");
		assert_eq!(error.code, ExtensionCode::EUpdatePolicy);

		let client = empty_generation(Layer::Client);
		let error = commit_auto_generation(
			&temporary.path().join("omp.lock"),
			&temporary.path().join("installed.toml"),
			&temporary.path().join("generations"),
			"refused",
			&client,
			&report,
		)
		.expect_err("typed refusal blocks commit");
		assert_eq!(error.code, ExtensionCode::EUpdatePolicy);
		assert!(!temporary.path().join("omp.lock").exists());
	}

	#[test]
	fn generation_ids_are_single_safe_components() {
		for invalid in ["", ".", "..", "../outside", "a/b", "a\\b", "white space"] {
			assert!(validate_generation_id(invalid).is_err(), "{invalid:?}");
		}
		for valid in ["01J6FZB5QNF3J1XW7TG6QY7A4V", "plugin-1.2.3", "rollback_2"] {
			assert!(validate_generation_id(valid).is_ok(), "{valid:?}");
		}
	}

	#[test]
	fn concrete_feature_matrix_and_reinstall_preservation() {
		let manifest = [
			(Str::new_static("a"), FeatureManifest {
				entry: Str::new_static("pkg.a"),
				..FeatureManifest::default()
			}),
			(Str::new_static("b"), FeatureManifest {
				default: true,
				entry: Str::new_static("pkg.b"),
				..FeatureManifest::default()
			}),
		]
		.into_iter()
		.collect();
		assert_eq!(concrete_features(&FeatureSelection::Absent, &manifest, None).unwrap(), vec![
			Str::new_static("b")
		]);
		assert!(
			concrete_features(&FeatureSelection::None, &manifest, None)
				.unwrap()
				.is_empty()
		);
		assert_eq!(concrete_features(&FeatureSelection::All, &manifest, None).unwrap(), vec![
			Str::new_static("a"),
			Str::new_static("b")
		]);
		let named = FeatureSelection::Named(vec![
			Str::new_static("b"),
			Str::new_static("a"),
			Str::new_static("a"),
		]);
		assert_eq!(concrete_features(&named, &manifest, None).unwrap(), vec![
			Str::new_static("a"),
			Str::new_static("b")
		]);
		assert_eq!(
			concrete_features(&FeatureSelection::Absent, &manifest, Some(&[Str::new_static("a")]),)
				.unwrap(),
			vec![Str::new_static("a")]
		);
		assert!(
			concrete_features(
				&FeatureSelection::Named(vec![Str::new_static("unknown")]),
				&manifest,
				None,
			)
			.is_err()
		);
	}

	#[cfg(unix)]
	#[test]
	fn generation_load_rejects_symlink_escape() {
		use std::os::unix::fs::symlink;

		let temporary = tempfile::tempdir().unwrap();
		let root = temporary.path().join("generations");
		let outside = temporary.path().join("outside");
		fs::create_dir_all(&root).unwrap();
		fs::create_dir_all(&outside).unwrap();
		symlink(&outside, root.join("escaped")).unwrap();

		let error = load_generation(&root, "escaped", Layer::Client).unwrap_err();
		assert_eq!(error.code, ExtensionCode::EIntegrity);
	}
}
