//! Integrity and runtime-health diagnostics for `omp ext doctor`.

use std::{
	fs,
	path::{Path, PathBuf},
};

use omp_core::{Str, encoding::hex};
use sha2::{Digest as _, Sha256};

use super::{
	ExtensionCode, Layer, WorkspaceUri,
	lock::{InstalledRecord, LockFile, LockedExtension},
	trust::{
		GrantsFile, KeysFile, RevocationFreshness, RevocationsFile, grant_covers,
		verify_artifact_signature,
	},
};

/// Diagnostic severity emitted by the extension doctor.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum DoctorSeverity {
	/// Healthy evidence.
	Ok,
	/// Degraded or mechanically repairable evidence.
	Warning,
	/// Fail-closed integrity or runtime prerequisite failure.
	Error,
}

/// One stable doctor finding with repair evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DoctorFinding {
	/// Stable extension diagnostic code when applicable.
	pub code:         Option<ExtensionCode>,
	/// Finding severity.
	pub severity:     DoctorSeverity,
	/// Extension identity, when scoped to one extension.
	pub extension_id: Option<Str>,
	/// Human-readable evidence.
	pub detail:       Str,
	/// Whether this invocation repaired deterministic local state.
	pub repaired:     bool,
}

/// Paths and policy consumed by one doctor pass.
#[derive(Clone, Debug)]
pub struct DoctorRequest<'a> {
	/// Owning lock layer.
	pub layer:                 Layer,
	/// Portable lock path.
	pub lock_path:             &'a Path,
	/// Local install-record path.
	pub installed_path:        &'a Path,
	/// Local TOFU key path.
	pub keys_path:             &'a Path,
	/// Local operator-grant path.
	pub grants_path:           &'a Path,
	/// Canonical workspace identity for workspace-layer grants.
	pub workspace:             Option<&'a WorkspaceUri>,
	/// Optional signed revocation snapshot.
	pub revocations_path:      Option<&'a Path>,
	/// Managed site tree root.
	pub site_root:             &'a Path,
	/// Content-addressed immutable artifact store.
	pub artifact_store:        &'a Path,
	/// Ambient unmanaged `OMP_PY_SITE`, when configured.
	pub ambient_site_override: Option<&'a Path>,
	/// Foreign extension-shaped roots that are diagnostic-only.
	pub foreign_roots:         &'a [PathBuf],
	/// Whether deterministic local repairs are allowed.
	pub fix:                   bool,
}

/// Runtime health facts supplied by the Environment and inference authorities.
pub trait RuntimeHealth {
	/// Returns whether the Environment worker boundary is reachable.
	fn environment_ready(&self) -> bool;
	/// Returns a credential-health diagnostic for one installed extension.
	fn credential_health(&self, extension_id: &str) -> CredentialHealth;
}

/// Credential readiness without exposing credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialHealth {
	/// No credential is required.
	NotRequired,
	/// Required credential is available through inference authority.
	Ready,
	/// Required credential is missing or disabled.
	Unavailable(Str),
}

/// Runs integrity, ownership, ABI, revocation, Environment, and credential
/// checks. `fix` may remove stale staging paths; it never disables an
/// extension, selects versions, grants capabilities, changes a tier, rewrites
/// a lock, or mutates publisher trust.
pub fn diagnose(request: &DoctorRequest<'_>, health: &impl RuntimeHealth) -> Vec<DoctorFinding> {
	let mut findings = Vec::new();
	let (lock, lock_error) = match LockFile::read(request.lock_path, request.layer) {
		Ok(lock) => (Some(lock), None),
		Err(error) => (None, Some(error)),
	};
	let installed = match InstalledRecord::read(request.installed_path) {
		Ok(installed) => installed,
		Err(error) => {
			findings.push(finding(Some(error.code), DoctorSeverity::Error, None, error.detail, false));
			InstalledRecord::default()
		},
	};
	if let Some(error) = lock_error
		&& installed.extensions.iter().any(|entry| {
			!entry
				.source
				.as_table()
				.is_some_and(|source| source.contains_key("link") || source.contains_key("path"))
		}) {
		findings.push(finding(Some(error.code), DoctorSeverity::Error, None, error.detail, false));
	}
	let keys = match KeysFile::read(request.keys_path) {
		Ok(keys) => Some(keys),
		Err(error) => {
			findings.push(finding(Some(error.code), DoctorSeverity::Error, None, error.detail, false));
			None
		},
	};
	let grants = match GrantsFile::read(request.grants_path) {
		Ok(grants) => Some(grants),
		Err(error) => {
			findings.push(finding(Some(error.code), DoctorSeverity::Error, None, error.detail, false));
			None
		},
	};
	if let Some(path) = request.ambient_site_override {
		findings.push(finding(
			Some(ExtensionCode::WSiteOverride),
			DoctorSeverity::Warning,
			None,
			Str::new(format!(
				"ambient OMP_PY_SITE {} bypasses managed per-extension site trees",
				path.display()
			)),
			false,
		));
	}
	for root in request.foreign_roots.iter().filter(|root| root.exists()) {
		findings.push(finding(
			Some(ExtensionCode::WForeignRoot),
			DoctorSeverity::Warning,
			None,
			Str::new(format!("foreign extension-shaped root {} is ignored", root.display())),
			false,
		));
	}
	if !health.environment_ready() {
		findings.push(finding(
			Some(ExtensionCode::EOffline),
			DoctorSeverity::Error,
			None,
			Str::new_static("Environment extension boundary is unavailable"),
			false,
		));
	}

	for entry in &installed.extensions {
		let Some(locked) = lock
			.as_ref()
			.and_then(|lock| lock.extensions.iter().find(|locked| locked.id == entry.id))
		else {
			if let Some(source) = entry.source.as_table()
				&& let Some(path) = source.get("link").and_then(toml::Value::as_str)
			{
				findings.push(finding(
					None,
					DoctorSeverity::Ok,
					Some(entry.id.clone()),
					Str::from(format!("linked source {path}; unsigned (signature verification exempt)")),
					false,
				));
				continue;
			}
			if entry
				.source
				.as_table()
				.is_some_and(|source| source.contains_key("path"))
			{
				continue;
			}
			findings.push(finding(
				Some(ExtensionCode::WNoLock),
				DoctorSeverity::Warning,
				Some(entry.id.clone()),
				Str::new_static("installed extension has no reproducible lock entry"),
				false,
			));
			continue;
		};
		if !keys.as_ref().is_some_and(|keys| {
			keys
				.keys
				.iter()
				.any(|pin| pin.id == entry.id && pin.key == locked.publisher)
		}) {
			findings.push(finding(
				Some(ExtensionCode::EKeyChanged),
				DoctorSeverity::Error,
				Some(entry.id.clone()),
				Str::new_static("lock publisher does not match the local TOFU pin"),
				false,
			));
		}
		if let Some(revocations) = request
			.revocations_path
			.and_then(|path| RevocationsFile::read(path).ok())
		{
			if revocations
				.revocation_for(&entry.id, &locked.version)
				.is_ok_and(|revocation| revocation.is_some())
			{
				findings.push(finding(
					Some(ExtensionCode::ERevoked),
					DoctorSeverity::Error,
					Some(entry.id.clone()),
					Str::new_static("installed extension matches the signed revocation set"),
					false,
				));
			}
			if matches!(
				revocations.freshness(&jiff::Timestamp::now().to_string(), false),
				RevocationFreshness::Warn(_)
			) {
				findings.push(finding(
					Some(ExtensionCode::WRevocationStale),
					DoctorSeverity::Warning,
					Some(entry.id.clone()),
					Str::new_static("signed revocation snapshot is stale"),
					false,
				));
			}
		}
		if entry.enabled
			&& !grants.as_ref().is_some_and(|grants| {
				grant_covers(
					grants,
					&locked.id,
					&locked.publisher,
					request.layer,
					request.workspace,
					&locked.capability_digest,
					locked.tier,
					&locked.ship,
				)
			}) {
			findings.push(finding(
				Some(ExtensionCode::WUngranted),
				DoctorSeverity::Warning,
				Some(entry.id.clone()),
				Str::new_static(
					"installed extension is not covered by an exact current operator grant",
				),
				false,
			));
		}
		if let Some(root) = entry
			.source
			.as_table()
			.and_then(|source| source.get("root"))
			.and_then(toml::Value::as_str)
			.map(Path::new)
			&& !root.is_dir()
		{
			findings.push(finding(
				Some(ExtensionCode::ESiteMissing),
				DoctorSeverity::Error,
				Some(entry.id.clone()),
				Str::new(format!("materialized site tree {} is missing", root.display())),
				false,
			));
		}
		let artifact = request
			.artifact_store
			.join(locked.wheel.blake3.as_str().trim_start_matches("b3:"));
		match verify_artifact(&artifact, locked) {
			Ok(()) => {},
			Err(detail) => findings.push(finding(
				Some(ExtensionCode::EIntegrity),
				DoctorSeverity::Error,
				Some(entry.id.clone()),
				detail,
				false,
			)),
		}
		if let CredentialHealth::Unavailable(detail) = health.credential_health(&entry.id) {
			findings.push(finding(
				None,
				DoctorSeverity::Warning,
				Some(entry.id.clone()),
				detail,
				false,
			));
		}
	}
	inspect_site(request, &mut findings);
	if findings.is_empty() {
		findings.push(finding(
			None,
			DoctorSeverity::Ok,
			None,
			Str::new_static("extension state is healthy"),
			false,
		));
	}
	findings
}

fn verify_artifact(path: &Path, locked: &LockedExtension) -> Result<(), Str> {
	let bytes = fs::read(path).map_err(|error| Str::new(error.to_string()))?;
	if bytes.len() as u64 != locked.wheel.size {
		return Err(Str::new_static("artifact byte length differs from lock"));
	}
	let blake3 = format!("b3:{}", blake3::hash(&bytes).to_hex());
	if blake3 != locked.wheel.blake3.as_str() {
		return Err(Str::new_static("artifact BLAKE3 differs from lock"));
	}
	let sha256 = format!("sha256:{}", hex::encode(&Sha256::digest(&bytes)));
	if sha256 != locked.wheel.sha256.as_str() {
		return Err(Str::new_static("artifact SHA-256 differs from lock"));
	}
	verify_artifact_signature(
		locked.publisher.as_str(),
		locked.wheel.blake3.as_str(),
		locked.wheel.sha256.as_str(),
		locked.manifest_capability_digest.as_str(),
		locked.signature.as_str(),
	)
	.map_err(|error| error.detail)
}

fn inspect_site(request: &DoctorRequest<'_>, findings: &mut Vec<DoctorFinding>) {
	let staging = request.site_root.join(".staging");
	if !staging.exists() {
		return;
	}
	let repaired = request.fix && fs::remove_dir_all(&staging).is_ok();
	findings.push(finding(
		Some(ExtensionCode::WSiteExtra),
		DoctorSeverity::Warning,
		None,
		Str::new_static("stale site materialization staging tree exists"),
		repaired,
	));
}

const fn finding(
	code: Option<ExtensionCode>,
	severity: DoctorSeverity,
	extension_id: Option<Str>,
	detail: Str,
	repaired: bool,
) -> DoctorFinding {
	DoctorFinding { code, severity, extension_id, detail, repaired }
}

/// Returns paths referenced by the active lock/install generation. GC callers
/// retain these even when their version cache is otherwise unreachable.
pub fn active_paths(request: &DoctorRequest<'_>) -> Vec<PathBuf> {
	vec![
		request.lock_path.to_path_buf(),
		request.installed_path.to_path_buf(),
		request.site_root.to_path_buf(),
		request.artifact_store.to_path_buf(),
	]
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{TrustTier, lock::InstalledExtension};

	struct Healthy;
	impl RuntimeHealth for Healthy {
		fn environment_ready(&self) -> bool {
			true
		}

		fn credential_health(&self, _extension_id: &str) -> CredentialHealth {
			CredentialHealth::NotRequired
		}
	}

	#[test]
	fn linked_extension_is_reported_as_unsigned_and_signature_exempt() {
		let tree = tempfile::tempdir().expect("doctor tree");
		let link = tree.path().join("demo");
		fs::create_dir(&link).expect("link root");
		let installed_path = tree.path().join("installed.toml");
		InstalledRecord {
			version:    2,
			extensions: vec![InstalledExtension {
				id:       Str::new_static("demo"),
				features: Vec::new(),
				source:   toml::Value::Table(toml::Table::from_iter([(
					"link".to_owned(),
					toml::Value::String(link.display().to_string()),
				)])),
				tier:     TrustTier::Sandboxed,
				enabled:  true,
			}],
		}
		.write(&installed_path)
		.expect("installed record");
		let request = DoctorRequest {
			layer:                 Layer::Client,
			lock_path:             &tree.path().join("omp.lock"),
			installed_path:        &installed_path,
			keys_path:             &tree.path().join("keys.toml"),
			grants_path:           &tree.path().join("grants.toml"),
			workspace:             None,
			revocations_path:      None,
			site_root:             &tree.path().join("sites"),
			artifact_store:        &tree.path().join("artifacts"),
			ambient_site_override: None,
			foreign_roots:         &[],
			fix:                   false,
		};
		let findings = diagnose(&request, &Healthy);
		assert!(
			!findings
				.iter()
				.any(|finding| finding.severity == DoctorSeverity::Error)
		);
		assert!(findings.iter().any(|finding| {
			finding.extension_id.as_deref() == Some("demo")
				&& finding.severity == DoctorSeverity::Ok
				&& finding.detail.contains("linked source")
				&& finding.detail.contains("unsigned")
		}));
	}
}
