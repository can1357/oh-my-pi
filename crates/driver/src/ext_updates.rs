//! Session-start extension update scheduling and durable due-window coalescing.

use std::{
	fs::{self, File, OpenOptions},
	future::Future,
	io,
	path::PathBuf,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_ext::{
	ExtensionCode,
	config::{UpdateMode, UpdatePolicy},
	upgrade::CandidateReport,
};
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString};
use tokio::task::JoinHandle;
use tracing::Instrument as _;

/// Independently coalesced update authority.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum UpdateScope {
	/// Operator-owned client lock and generation store.
	Client,
	/// Workspace-owned platform lock and store.
	Workspace,
}

/// Stable class for a failed background check.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateFailureKind {
	/// Signed metadata could not be fetched.
	Network,
	/// Signed metadata or a candidate failed verification.
	Verification,
	/// Durable scope state could not be read or written.
	Storage,
	/// The environment session protocol rejected the check.
	Protocol,
}

/// Typed failure journaled once for one due window.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct UpdateFailure {
	/// Stable failure class.
	pub kind: UpdateFailureKind,
	/// Closed extension diagnostic when the failure came from verification.
	pub code: Option<ExtensionCode>,
}

/// One deduplicated notification emitted by a due check.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateNotification {
	/// Scope that owned the check.
	pub scope:         UpdateScope,
	/// Verified semantic candidate report, when the check completed.
	pub report:        Option<CandidateReport>,
	/// Typed failure, when the check could not complete.
	pub failure:       Option<UpdateFailure>,
	/// High severity is reserved for quarantine of the startup generation.
	pub high_severity: bool,
}

/// Durable per-scope due-window record.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct UpdateJournal {
	/// Completion timestamp of the latest attempted due check.
	pub last_checked_ms: u64,
	/// Latest typed failure; cleared by a successful check.
	pub last_failure:    Option<UpdateFailure>,
}

/// Filesystem-backed coalescing authority shared by concurrent sessions.
#[derive(Clone, Debug)]
pub struct UpdateCoordinator {
	root: PathBuf,
}

impl UpdateCoordinator {
	/// Creates a coordinator beneath an installer-owned state directory.
	pub fn new(root: impl Into<PathBuf>) -> Self {
		Self { root: root.into() }
	}

	/// Reads the durable state for one scope. An absent file is never-due state.
	pub fn journal(&self, scope: UpdateScope) -> io::Result<UpdateJournal> {
		let path = self.state_path(scope);
		if !path.exists() {
			return Ok(UpdateJournal::default());
		}
		let text = fs::read_to_string(path)?;
		toml::from_str(&text).map_err(io::Error::other)
	}

	fn acquire_due(
		&self,
		scope: UpdateScope,
		interval_ms: u64,
		now_ms: u64,
	) -> io::Result<Option<DueLease>> {
		fs::create_dir_all(&self.root)?;
		let lock_path = self.root.join(format!("{scope}.lock"));
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(lock_path)?;
		if !try_lock(&file)? {
			return Ok(None);
		}
		let journal = self.journal(scope)?;
		if now_ms.saturating_sub(journal.last_checked_ms) < interval_ms {
			unlock(&file);
			return Ok(None);
		}
		Ok(Some(DueLease { file: Some(file), state_path: self.state_path(scope), now_ms }))
	}

	fn state_path(&self, scope: UpdateScope) -> PathBuf {
		self.root.join(format!("{scope}.toml"))
	}
}

struct DueLease {
	file:       Option<File>,
	state_path: PathBuf,
	now_ms:     u64,
}

impl DueLease {
	fn complete(mut self, failure: Option<UpdateFailure>) -> io::Result<()> {
		let journal = UpdateJournal { last_checked_ms: self.now_ms, last_failure: failure };
		let encoded = toml::to_string_pretty(&journal).map_err(io::Error::other)?;
		let temporary = self.state_path.with_extension("toml.tmp");
		fs::write(&temporary, encoded)?;
		fs::rename(temporary, &self.state_path)?;
		if let Some(file) = self.file.take() {
			unlock(&file);
		}
		Ok(())
	}
}

impl Drop for DueLease {
	fn drop(&mut self) {
		if let Some(file) = self.file.take() {
			unlock(&file);
		}
	}
}

/// Schedules one non-blocking, due-checked startup task.
///
/// The advisory lease is acquired before spawning so concurrent sessions can
/// never enqueue duplicate work. The returned task is intentionally not part of
/// the first-prompt dependency chain.
pub fn schedule_due_update<F, Fut>(
	coordinator: &UpdateCoordinator,
	scope: UpdateScope,
	policy: UpdatePolicy,
	now_ms: u64,
	notifications: flume::Sender<UpdateNotification>,
	check: F,
) -> io::Result<Option<JoinHandle<()>>>
where
	F: FnOnce() -> Fut + Send + 'static,
	Fut: Future<Output = Result<CandidateReport, UpdateFailure>> + Send + 'static,
{
	if policy.mode == UpdateMode::Off {
		tracing::debug!(scope = %scope, "extension update check disabled");
		return Ok(None);
	}
	let interval_ms = u64::try_from(policy.interval.duration().as_millis()).unwrap_or(u64::MAX);
	let Some(lease) = coordinator.acquire_due(scope, interval_ms, now_ms)? else {
		tracing::debug!(scope = %scope, "extension update check coalesced or not due");
		return Ok(None);
	};
	let span = tracing::debug_span!("extension_update_check", scope = %scope);
	Ok(Some(tokio::spawn(
		async move {
			let result = check().await;
			let (report, failure, high_severity) = match result {
				Ok(report) => {
					let high_severity = !report.quarantined.is_empty();
					if high_severity {
						tracing::warn!(
							scope = %scope,
							quarantined_count = report.quarantined.len(),
							"extension update check quarantined extensions"
						);
					}
					if report.items.is_empty() {
						tracing::debug!(scope = %scope, "extension update check completed");
					} else {
						tracing::info!(
							scope = %scope,
							candidate_count = report.items.len(),
							"extension updates verified"
						);
					}
					(Some(report), None, high_severity)
				},
				Err(failure) => {
					tracing::warn!(
						scope = %scope,
						kind = ?failure.kind,
						code = ?failure.code,
						"extension update check failed"
					);
					(None, Some(failure), false)
				},
			};
			if let Err(error) = lease.complete(failure) {
				tracing::warn!(
					scope = %scope,
					error = %error,
					"failed to persist extension update check"
				);
			}
			if notifications
				.send_async(UpdateNotification { scope, report, failure, high_severity })
				.await
				.is_err()
			{
				tracing::debug!(scope = %scope, "extension update notification receiver closed");
			}
		}
		.instrument(span),
	)))
}

/// Returns the current Unix timestamp used for durable due checks.
pub fn update_now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

/// Client-layer files consumed by the background verifier.
#[derive(Clone, Debug)]
pub struct ClientUpdatePaths {
	/// Active client lock.
	pub lock:        PathBuf,
	/// Active client install selection.
	pub installed:   PathBuf,
	/// Restorable verified generation store.
	pub generations: PathBuf,
	/// Exact-version pins.
	pub pins:        PathBuf,
	/// Ordered signed-index sources.
	pub indexes:     PathBuf,
	/// Cached signed index.
	pub index:       PathBuf,
	/// Configured index public key.
	pub index_key:   PathBuf,
	/// Cached signed revocations.
	pub revocations: PathBuf,
}

impl ClientUpdatePaths {
	/// Uses the canonical installer-owned layout beneath the client data dir.
	pub fn for_data_dir(data_dir: &std::path::Path) -> Self {
		let root = data_dir.join("ext");
		Self {
			lock:        root.join("omp.lock"),
			installed:   root.join("installed.toml"),
			generations: root.join("generations"),
			pins:        root.join("pins.toml"),
			indexes:     root.join("indexes.toml"),
			index:       root.join("index.json"),
			index_key:   root.join("index.key"),
			revocations: root.join("revocations.json"),
		}
	}
}

/// Runs the complete client resolve/verify/diff/commit transaction.
///
/// Revocations are fetched and verified before the signed index. Notify mode
/// never calls the generation commit boundary; auto mode commits only when the
/// shared verifier marks every item eligible.
#[tracing::instrument(
	level = "debug",
	skip_all,
	name = "client_update_check",
	fields(mode = %policy.mode)
)]
pub async fn check_client_updates(
	paths: &ClientUpdatePaths,
	policy: UpdatePolicy,
	now_ms: u64,
) -> Result<CandidateReport, UpdateFailure> {
	use omp_ext::{
		Layer,
		index::{IndexConfig, SignedIndex},
		lock::{InstalledRecord, LockFile},
		trust::RevocationsFile,
		upgrade::{
			Generation, PinsFile, commit_auto_generation, resolve_candidate_generation,
			verify_candidate_generation,
		},
	};

	if !paths.lock.exists() {
		return Ok(CandidateReport::default());
	}
	let key = fs::read_to_string(&paths.index_key).map_err(|_| storage_failure())?;
	let sources = IndexConfig::read(&paths.indexes).map_err(extension_failure)?;
	if let Some(source) = sources.entries.first() {
		let prefix = source
			.url
			.rsplit_once('/')
			.map(|(prefix, _)| prefix)
			.ok_or(UpdateFailure {
				kind: UpdateFailureKind::Protocol,
				code: Some(ExtensionCode::EIntegrity),
			})?;
		let revocation_bytes = fetch_update_metadata(&format!("{prefix}/revocations.json")).await?;
		let revocations: RevocationsFile =
			serde_json::from_slice(&revocation_bytes).map_err(|_| verification_failure())?;
		revocations.verify(key.trim()).map_err(extension_failure)?;
		write_atomic(&paths.revocations, &revocation_bytes).map_err(|_| storage_failure())?;

		let index_bytes = fetch_update_metadata(&source.url).await?;
		let index: SignedIndex =
			serde_json::from_slice(&index_bytes).map_err(|_| verification_failure())?;
		index.verify(key.trim()).map_err(extension_failure)?;
		write_atomic(&paths.index, &index_bytes).map_err(|_| storage_failure())?;
	}
	let index = SignedIndex::read(&paths.index, key.trim()).map_err(extension_failure)?;
	let revocations = RevocationsFile::read(&paths.revocations).map_err(extension_failure)?;
	revocations.verify(key.trim()).map_err(extension_failure)?;
	let current = Generation {
		lock:      LockFile::read(&paths.lock, Layer::Client).map_err(extension_failure)?,
		installed: InstalledRecord::read(&paths.installed).map_err(extension_failure)?,
	};
	let target = current
		.lock
		.targets
		.first()
		.map_or("any", omp_core::Str::as_str);
	let candidate =
		resolve_candidate_generation(&current, &index, target).map_err(extension_failure)?;
	let pins = PinsFile::read(&paths.pins).map_err(extension_failure)?;
	let now = jiff::Timestamp::now().to_string();
	let freshness = revocations.freshness(&now, false);
	let report = verify_candidate_generation(
		&current,
		&candidate,
		&index,
		&pins,
		&revocations,
		freshness,
		target,
	)
	.map_err(extension_failure)?;
	if policy.mode == UpdateMode::Auto && report.can_commit() {
		let generation_id = format!("auto-{now_ms}");
		commit_auto_generation(
			&paths.lock,
			&paths.installed,
			&paths.generations,
			&generation_id,
			&candidate,
			&report,
		)
		.map_err(extension_failure)?;
	}
	Ok(report)
}

/// Requests the environment-owned workspace check and projects its structured
/// report into the shared notification shape.
#[tracing::instrument(
	level = "debug",
	skip_all,
	name = "workspace_update_check",
	fields(mode = %policy.mode)
)]
pub async fn check_workspace_updates(
	client: &omp_env::EnvClient,
	policy: UpdatePolicy,
	now_ms: u64,
) -> Result<CandidateReport, UpdateFailure> {
	let response = client
		.check_workspace_updates(omp_proto::env::v1::WorkspaceUpdateCheck {
			mode: policy.mode.to_string(),
			interval_ms: u64::try_from(policy.interval.duration().as_millis()).unwrap_or(u64::MAX),
			now_ms,
		})
		.await
		.map_err(|_| UpdateFailure { kind: UpdateFailureKind::Protocol, code: None })?;
	if let Some(failure) = response.failure {
		return Err(UpdateFailure {
			kind: match failure.code.as_str() {
				"network" => UpdateFailureKind::Network,
				"storage" => UpdateFailureKind::Storage,
				"update-policy" | "index-url" => UpdateFailureKind::Protocol,
				_ => UpdateFailureKind::Verification,
			},
			code: failure.code.parse().ok(),
		});
	}
	let items = response
		.items
		.into_iter()
		.map(|item| {
			let diff = item.diff.unwrap_or_default();
			omp_ext::upgrade::UpdateItem {
				diff:    omp_ext::upgrade::UpdateDiff {
					id: item.id.into(),
					from_version: item.from_version.into(),
					to_version: item.to_version.into(),
					features: item.features.into_iter().map(Into::into).collect(),
					from_declaration_digest: diff.declaration_digest_from.into(),
					to_declaration_digest: diff.declaration_digest_to.into(),
					from_capability_digest: diff.capability_digest_from.into(),
					to_capability_digest: diff.capability_digest_to.into(),
					from_manifest_capability_digest: diff.manifest_digest_from.into(),
					to_manifest_capability_digest: diff.manifest_digest_to.into(),
				},
				refusal: item.refusal.and_then(update_refusal_from_wire),
			}
		})
		.collect();
	let quarantined = response
		.quarantined
		.into_iter()
		.map(|entry| entry.id.into())
		.collect();
	Ok(CandidateReport { items, quarantined })
}

fn update_refusal_from_wire(value: i32) -> Option<omp_ext::upgrade::UpdateRefusal> {
	use omp_ext::upgrade::UpdateRefusal;
	use omp_proto::env::v1::ExtensionUpdateRefusal;
	match ExtensionUpdateRefusal::try_from(value).ok()? {
		ExtensionUpdateRefusal::FeatureRemoved => Some(UpdateRefusal::FeatureRemoved),
		ExtensionUpdateRefusal::CapabilityChanged => Some(UpdateRefusal::CapabilityChanged),
		ExtensionUpdateRefusal::Pinned => Some(UpdateRefusal::Pinned),
		ExtensionUpdateRefusal::StaleRevocations => Some(UpdateRefusal::StaleRevocations),
		ExtensionUpdateRefusal::BadSignature => Some(UpdateRefusal::BadSignature),
		ExtensionUpdateRefusal::Attestation => Some(UpdateRefusal::AttestationMissing),
		ExtensionUpdateRefusal::KeyChanged | ExtensionUpdateRefusal::PublisherChanged => {
			Some(UpdateRefusal::PublisherChanged)
		},
		ExtensionUpdateRefusal::Yanked => Some(UpdateRefusal::Yanked),
		ExtensionUpdateRefusal::Revoked => Some(UpdateRefusal::Revoked),
		ExtensionUpdateRefusal::Integrity => Some(UpdateRefusal::Integrity),
		ExtensionUpdateRefusal::Unspecified => None,
	}
}

async fn fetch_update_metadata(url: &str) -> Result<Vec<u8>, UpdateFailure> {
	const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
	let response = reqwest::get(url).await.map_err(|_| network_failure())?;
	if !response.status().is_success() {
		return Err(network_failure());
	}
	let bytes = response.bytes().await.map_err(|_| network_failure())?;
	if bytes.len() > MAX_METADATA_BYTES {
		return Err(verification_failure());
	}
	Ok(bytes.to_vec())
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let temporary = path.with_extension("tmp");
	fs::write(&temporary, bytes)?;
	fs::rename(temporary, path)
}

const fn network_failure() -> UpdateFailure {
	UpdateFailure { kind: UpdateFailureKind::Network, code: None }
}

const fn verification_failure() -> UpdateFailure {
	UpdateFailure { kind: UpdateFailureKind::Verification, code: Some(ExtensionCode::EIntegrity) }
}

const fn storage_failure() -> UpdateFailure {
	UpdateFailure { kind: UpdateFailureKind::Storage, code: None }
}

fn extension_failure(error: omp_ext::ExtensionError) -> UpdateFailure {
	UpdateFailure { kind: UpdateFailureKind::Verification, code: Some(error.code) }
}

#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<bool> {
	use std::os::fd::AsRawFd as _;
	// SAFETY: `file` owns a valid descriptor and flock stores no borrowed pointer.
	let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
	if result == 0 {
		return Ok(true);
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::EWOULDBLOCK) || error.raw_os_error() == Some(libc::EAGAIN)
	{
		Ok(false)
	} else {
		Err(error)
	}
}

#[cfg(unix)]
fn unlock(file: &File) {
	use std::os::fd::AsRawFd as _;
	// SAFETY: `file` owns a valid descriptor and flock stores no borrowed pointer.
	let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(not(unix))]
fn try_lock(_file: &File) -> io::Result<bool> {
	// Windows production uses the environment daemon's platform lock. This
	// fallback retains durable due checking for in-process embedders.
	Ok(true)
}

#[cfg(not(unix))]
fn unlock(_file: &File) {}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	use omp_ext::config::UpdateInterval;

	use super::*;

	#[tokio::test]
	async fn concurrent_sessions_coalesce_one_due_check_per_scope() {
		let root = tempfile::tempdir().expect("state");
		let coordinator = UpdateCoordinator::new(root.path());
		let policy = UpdatePolicy {
			mode:     UpdateMode::Notify,
			interval: UpdateInterval::new(std::time::Duration::from_secs(60)).expect("interval"),
		};
		let (tx, rx) = flume::unbounded();
		let calls = Arc::new(AtomicUsize::new(0));
		let first_calls = Arc::clone(&calls);
		let first = schedule_due_update(
			&coordinator,
			UpdateScope::Client,
			policy,
			120_000,
			tx.clone(),
			move || async move {
				first_calls.fetch_add(1, Ordering::SeqCst);
				tokio::task::yield_now().await;
				Ok(CandidateReport::default())
			},
		)
		.expect("schedule first")
		.expect("first due");
		let second_calls = Arc::clone(&calls);
		let second = schedule_due_update(
			&coordinator,
			UpdateScope::Client,
			policy,
			120_000,
			tx,
			move || async move {
				second_calls.fetch_add(1, Ordering::SeqCst);
				Ok(CandidateReport::default())
			},
		)
		.expect("schedule second");
		assert!(second.is_none());
		first.await.expect("check task");
		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert!(rx.recv_async().await.is_ok());
		assert_eq!(
			coordinator
				.journal(UpdateScope::Client)
				.expect("journal")
				.last_checked_ms,
			120_000
		);
	}

	#[tokio::test]
	async fn off_schedules_no_check_and_failures_are_once_per_window() {
		let root = tempfile::tempdir().expect("state");
		let coordinator = UpdateCoordinator::new(root.path());
		let (tx, rx) = flume::unbounded();
		let off = schedule_due_update(
			&coordinator,
			UpdateScope::Client,
			UpdatePolicy { mode: UpdateMode::Off, ..UpdatePolicy::default() },
			1,
			tx.clone(),
			|| async { Ok(CandidateReport::default()) },
		)
		.expect("off");
		assert!(off.is_none());
		assert!(rx.is_empty());

		let policy = UpdatePolicy {
			mode:     UpdateMode::Notify,
			interval: UpdateInterval::new(std::time::Duration::from_secs(60)).expect("interval"),
		};
		let failure = UpdateFailure { kind: UpdateFailureKind::Network, code: None };
		let task = schedule_due_update(
			&coordinator,
			UpdateScope::Workspace,
			policy,
			120_000,
			tx.clone(),
			move || async move { Err(failure) },
		)
		.expect("failure schedule")
		.expect("due");
		task.await.expect("failure task");
		let notification = rx.recv_async().await.expect("notification");
		assert_eq!(notification.failure, Some(failure));
		assert!(
			schedule_due_update(&coordinator, UpdateScope::Workspace, policy, 120_001, tx, || async {
				Ok(CandidateReport::default())
			},)
			.expect("deduplicated")
			.is_none()
		);
	}
}
