use std::{
	collections::BTreeSet,
	fs,
	path::{Path, PathBuf},
};

use omp_core::Hash32;
use omp_tools::security_scan::Fault;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::model::{Scan, State};

const STATE_SCHEMA: u64 = 2;

pub(super) struct Store {
	pub root:       PathBuf,
	pub state_path: PathBuf,
}

impl Store {
	pub fn open(workspace: &Path, state_root: &Path) -> Result<(Self, State), Fault> {
		let canonical = workspace
			.canonicalize()
			.unwrap_or_else(|_| workspace.to_path_buf());
		let digest = Hash32::sum(canonical.to_string_lossy().as_bytes()).to_hex();
		let root = state_root.join("security").join(digest.as_str());
		private_dir(&root)?;
		let state_path = root.join("state.json");
		let state = if state_path.exists() {
			let bytes = fs::read(&state_path).map_err(|_| Fault::Storage)?;
			let value: Value = serde_json::from_slice(&bytes).map_err(|_| Fault::Storage)?;
			if value.get("schema_version").and_then(Value::as_u64) != Some(STATE_SCHEMA) {
				return Err(Fault::Storage);
			}
			serde_json::from_value(value.get("state").cloned().ok_or(Fault::Storage)?)
				.map_err(|_| Fault::Storage)?
		} else {
			State::default()
		};
		validate_state(&state)?;
		Ok((Self { root, state_path }, state))
	}

	pub fn save(&self, state: &State) -> Result<(), Fault> {
		let value = json!({"schema_version": STATE_SCHEMA, "state": state});
		write_json_atomic(&self.state_path, &value)
	}
}

pub(super) fn public_scan(scan: &Scan) -> Value {
	redact_value(json!({
		"document_type": "omp-security.scan",
		"schema_version": "1.0",
		"id": scan.id,
		"plan_id": scan.plan_id,
		"status": scan.status,
		"created_at": scan.created_at,
		"completed_at": scan.completed_at,
		"target": scan.target,
		"producer": scan.producer,
		"provenance": scan.provenance,
		"finding_ids": scan.findings.iter().map(|finding| &finding.id).collect::<Vec<_>>(),
	}))
}

pub(super) fn public_bundle(scan: &Scan) -> Value {
	redact_value(json!({
		"scan": public_scan(scan),
		"findings": scan.findings,
		"report": scan.report,
		"sarif": scan.sarif,
	}))
}

pub(super) fn redact_value(value: Value) -> Value {
	match value {
		Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
		Value::Object(values) => {
			let mut result = Map::new();
			for (key, value) in values {
				let normalized = key
					.chars()
					.filter(|character| character.is_ascii_alphanumeric())
					.flat_map(char::to_lowercase)
					.collect::<String>();
				if matches!(
					normalized.as_str(),
					"account"
						| "accountid"
						| "accesstoken"
						| "apikey" | "authorization"
						| "bearer" | "clientsecret"
						| "cookie" | "credentialid"
						| "email" | "organizationid"
						| "organizationname"
						| "orgid" | "orgname"
						| "password" | "privatekey"
						| "refreshtoken"
						| "secret" | "sessionid"
						| "token"
				) {
					continue;
				}
				result.insert(key, redact_value(value));
			}
			Value::Object(result)
		},
		other => other,
	}
}

pub(super) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Fault> {
	let mut bytes = serde_json::to_vec_pretty(value).map_err(|_| Fault::Storage)?;
	bytes.push(b'\n');
	write_bytes_atomic(path, &bytes)
}

pub(super) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), Fault> {
	let parent = path.parent().ok_or(Fault::Storage)?;
	private_dir(parent)?;
	let nonce = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_err(|_| Fault::Storage)?
		.as_nanos();
	let temporary = path.with_extension(format!("tmp-{nonce}"));
	let result = (|| {
		use std::io::Write as _;
		let mut options = fs::OpenOptions::new();
		options.write(true).create_new(true);
		#[cfg(unix)]
		{
			use std::os::unix::fs::OpenOptionsExt as _;
			options.mode(0o600);
		}
		let mut file = options.open(&temporary).map_err(|_| Fault::Storage)?;
		file.write_all(bytes).map_err(|_| Fault::Storage)?;
		file.sync_all().map_err(|_| Fault::Storage)?;
		fs::rename(&temporary, path).map_err(|_| Fault::Storage)
	})();
	if result.is_err() {
		let _ = fs::remove_file(&temporary);
	}
	result
}

fn validate_state(state: &State) -> Result<(), Fault> {
	for (id, plan) in &state.plans {
		if id != &plan.id || !valid_id(id, "secplan_") {
			return Err(Fault::Storage);
		}
	}
	for (id, scan) in &state.scans {
		if id != &scan.id || !valid_id(id, "secscan_") {
			return Err(Fault::Storage);
		}
		let mut finding_ids = BTreeSet::new();
		for finding in &scan.findings {
			if finding.scan_id != scan.id
				|| !valid_id(&finding.id, "secf_")
				|| !finding_ids.insert(&finding.id)
			{
				return Err(Fault::Storage);
			}
			let evidence_ids = finding
				.evidence
				.iter()
				.map(|evidence| &evidence.id)
				.collect::<BTreeSet<_>>();
			if evidence_ids.len() != finding.evidence.len()
				|| finding
					.validation
					.evidence_ids
					.iter()
					.any(|id| !evidence_ids.contains(id))
			{
				return Err(Fault::Storage);
			}
		}
	}
	for (id, operation) in &state.operations {
		if id != &operation.id
			|| !valid_id(id, "secop_")
			|| !state.plans.contains_key(&operation.plan_id)
			|| !state.scans.contains_key(&operation.scan_id)
		{
			return Err(Fault::Storage);
		}
	}
	for (id, remediation) in &state.remediations {
		let Some(scan) = state.scans.get(&remediation.scan_id) else {
			return Err(Fault::Storage);
		};
		if id != &remediation.id
			|| !valid_remediation_id(id)
			|| remediation.finding_ids.iter().any(|finding_id| {
				!scan
					.findings
					.iter()
					.any(|finding| finding.id == *finding_id)
			}) {
			return Err(Fault::Storage);
		}
	}
	Ok(())
}

fn valid_id(value: &str, prefix: &str) -> bool {
	let suffix = value.strip_prefix(prefix).unwrap_or_default();
	!suffix.is_empty()
		&& suffix
			.chars()
			.all(|character| character.is_ascii_alphanumeric())
}

fn valid_remediation_id(value: &str) -> bool {
	let suffix = value
		.strip_prefix("security-remediation-")
		.unwrap_or_default();
	!suffix.is_empty()
		&& suffix
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn private_dir(path: &Path) -> Result<(), Fault> {
	fs::create_dir_all(path).map_err(|_| Fault::Storage)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| Fault::Storage)?;
	}
	Ok(())
}
