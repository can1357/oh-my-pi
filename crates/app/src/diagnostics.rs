//! Size-bounded, redacted diagnostic bundle collection.
pub mod profile;

use std::{
	collections::BTreeMap,
	env, fs, io,
	path::{Component, Path, PathBuf},
	str,
	time::SystemTime,
};

use serde::Serialize;
use thiserror::Error;

use crate::debug;

/// Default maximum uncompressed bytes admitted to one bundle.
pub const DEFAULT_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Default maximum bytes admitted from one file.
pub const DEFAULT_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// One optional native diagnostic capture with an honest format label.
#[derive(Clone, Debug)]
pub struct ProfilePayload {
	/// Archive-relative output path.
	pub path:   String,
	/// Exact capture format, such as `pprof`, `folded`, `svg`, or
	/// `allocator-summary-json`.
	pub format: String,
	/// Already-bounded native capture bytes.
	pub bytes:  Vec<u8>,
}

/// Inputs collected into a support bundle.
pub struct BundleSpec {
	/// Destination `.tar.gz` path.
	pub output:         PathBuf,
	/// Durable session JSONL to include.
	pub journal:        PathBuf,
	/// Referenced artifacts paired with their nested archive-relative paths.
	pub artifacts:      Vec<(String, PathBuf)>,
	/// Candidate same-day process log files.
	pub logs:           Vec<PathBuf>,
	/// Settings snapshot supplied by the sole settings authority.
	pub settings:       serde_json::Value,
	/// Optional native profiles and redacted raw-stream dumps.
	pub profiles:       Vec<ProfilePayload>,
	/// Total uncompressed byte cap.
	pub max_bytes:      u64,
	/// Per-file byte cap.
	pub max_file_bytes: u64,
}

impl BundleSpec {
	/// Applies production bundle limits to the required inputs.
	pub fn new(output: PathBuf, journal: PathBuf, settings: serde_json::Value) -> Self {
		Self {
			output,
			journal,
			artifacts: Vec::new(),
			logs: Vec::new(),
			settings,
			profiles: Vec::new(),
			max_bytes: DEFAULT_MAX_BYTES,
			max_file_bytes: DEFAULT_FILE_BYTES,
		}
	}
}

/// Completed bundle accounting.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BundleSummary {
	/// Archive path.
	pub output:             PathBuf,
	/// Members written.
	pub files:              usize,
	/// Uncompressed bytes written.
	pub uncompressed_bytes: u64,
	/// Candidate members omitted due to bounds or freshness.
	pub omitted:            usize,
}

/// Diagnostic collection failure.
#[derive(Debug, Error)]
pub enum Error {
	/// Required input could not be read.
	#[error("cannot read diagnostic input {path}")]
	Read {
		/// Input path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// Destination archive could not be written.
	#[error("cannot write diagnostic archive {path}")]
	Write {
		/// Destination path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A caller supplied an unsafe archive member path.
	#[error("unsafe diagnostic member path {path}")]
	UnsafePath {
		/// Rejected path.
		path: String,
	},
	/// TAR.GZ encoding failed.
	#[error("cannot encode diagnostic archive")]
	Archive(#[from] omp_ar::Error),
	/// Settings or manifest serialization failed.
	#[error("cannot serialize diagnostic metadata")]
	Serialize(#[from] serde_json::Error),
}

/// Collects, redacts, bounds, and writes a deterministic TAR.GZ bundle.
#[tracing::instrument(
	level = "debug",
	name = "diagnostic_bundle",
	skip_all,
	fields(output = %spec.output.display())
)]
pub fn create_bundle(spec: BundleSpec) -> Result<BundleSummary, Error> {
	let mut collector = Collector::new(spec.max_bytes, spec.max_file_bytes);
	collector.add_file("session/session.jsonl", &spec.journal, true)?;
	for (nested, path) in &spec.artifacts {
		let member = format!("artifacts/{nested}");
		collector.add_file(&member, path, false)?;
	}
	let today = SystemTime::now()
		.duration_since(SystemTime::UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs()
		/ 86_400;
	for path in &spec.logs {
		let recent = path
			.metadata()
			.and_then(|metadata| metadata.modified())
			.is_ok_and(|modified| {
				modified
					.duration_since(SystemTime::UNIX_EPOCH)
					.unwrap_or_default()
					.as_secs() / 86_400
					== today
			});
		if recent {
			let name = path
				.file_name()
				.and_then(|name| name.to_str())
				.unwrap_or("process.log");
			collector.add_file(&format!("logs/{}-{name}", collector.entries.len()), path, true)?;
		} else {
			collector.omitted += 1;
		}
	}
	let settings = serde_json::to_vec_pretty(&sanitize_json(spec.settings))?;
	collector.add_bytes("facts/settings.json", settings, true)?;
	let system = serde_json::to_vec_pretty(&debug::collect_system_facts())?;
	collector.add_bytes("facts/system.json", system, true)?;
	let environment = serde_json::to_vec_pretty(&sanitized_environment())?;
	collector.add_bytes("facts/environment.json", environment, true)?;
	for profile in spec.profiles {
		let path = format!("profiles/{}", profile.path);
		collector.add_bytes(&path, profile.bytes, true)?;
		collector.profile_formats.insert(path, profile.format);
	}
	let manifest = serde_json::to_vec_pretty(&serde_json::json!({
		"schema": "omp.diagnostics.v1", "profile_formats": collector.profile_formats,
		"redacted": true, "omitted": collector.omitted,
	}))?;
	collector.add_bytes("manifest.json", manifest, true)?;
	let uncompressed_bytes = collector.used;
	let files = collector.entries.len();
	let archive = omp_ar::tar::encode_gzip(
		collector
			.entries
			.iter()
			.map(|(path, bytes)| (path.as_str(), bytes.as_slice())),
	)?;
	if let Some(parent) = spec
		.output
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
	{
		fs::create_dir_all(parent)
			.map_err(|source| Error::Write { path: spec.output.clone(), source })?;
	}
	fs::write(&spec.output, archive)
		.map_err(|source| Error::Write { path: spec.output.clone(), source })?;
	let summary =
		BundleSummary { output: spec.output, files, uncompressed_bytes, omitted: collector.omitted };
	tracing::info!(
		files = summary.files,
		uncompressed_bytes = summary.uncompressed_bytes,
		omitted = summary.omitted,
		output = %summary.output.display(),
		"diagnostic bundle created"
	);
	Ok(summary)
}

struct Collector {
	entries:         Vec<(String, Vec<u8>)>,
	used:            u64,
	max:             u64,
	file_max:        u64,
	omitted:         usize,
	profile_formats: BTreeMap<String, String>,
}
impl Collector {
	fn new(max: u64, file_max: u64) -> Self {
		Self {
			entries:         Vec::new(),
			used:            0,
			max:             max.max(1),
			file_max:        file_max.max(1),
			omitted:         0,
			profile_formats: BTreeMap::new(),
		}
	}

	fn add_file(&mut self, member: &str, source_path: &Path, textual: bool) -> Result<(), Error> {
		validate_member(member)?;
		let metadata = fs::metadata(source_path)
			.map_err(|source| Error::Read { path: source_path.to_path_buf(), source })?;
		if metadata.len() > self.file_max || metadata.len() > self.max.saturating_sub(self.used) {
			self.omitted += 1;
			return Ok(());
		}
		let bytes = fs::read(source_path)
			.map_err(|source| Error::Read { path: source_path.to_path_buf(), source })?;
		self.add_bytes(member, bytes, textual)
	}

	fn add_bytes(&mut self, member: &str, mut bytes: Vec<u8>, textual: bool) -> Result<(), Error> {
		validate_member(member)?;
		if textual || str::from_utf8(&bytes).is_ok() {
			let text = String::from_utf8_lossy(&bytes);
			bytes = omp_observability::redact::redact_sensitive_credentials(&text).into_bytes();
		}
		let size = bytes.len() as u64;
		if size > self.file_max || size > self.max.saturating_sub(self.used) {
			self.omitted += 1;
			return Ok(());
		}
		self.used += size;
		self.entries.push((member.to_owned(), bytes));
		Ok(())
	}
}

fn validate_member(path: &str) -> Result<(), Error> {
	let safe = !path.is_empty()
		&& Path::new(path)
			.components()
			.all(|component| matches!(component, Component::Normal(_)));
	if safe {
		Ok(())
	} else {
		Err(Error::UnsafePath { path: path.to_owned() })
	}
}
fn sanitize_json(value: serde_json::Value) -> serde_json::Value {
	match value {
		serde_json::Value::String(text) => {
			serde_json::Value::String(omp_observability::redact::redact_sensitive_credentials(&text))
		},
		serde_json::Value::Array(values) => {
			serde_json::Value::Array(values.into_iter().map(sanitize_json).collect())
		},
		serde_json::Value::Object(values) => serde_json::Value::Object(
			values
				.into_iter()
				.map(|(key, value)| (key, sanitize_json(value)))
				.collect(),
		),
		other => other,
	}
}
fn sanitized_environment() -> BTreeMap<&'static str, String> {
	const SAFE: &[&str] = &[
		"TERM",
		"COLORTERM",
		"LANG",
		"LC_ALL",
		"SHELL",
		"COMSPEC",
		"TMUX",
		"STY",
		"ZELLIJ",
		"OMP_PROFILE",
	];
	SAFE
		.iter()
		.filter_map(|name| {
			env::var(name)
				.ok()
				.map(|value| (*name, omp_observability::redact::redact_sensitive_credentials(&value)))
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bundle_writes_real_bounded_archive_with_profiles() {
		let directory = tempfile::tempdir().expect("temp directory");
		let journal = directory.path().join("session.oms");
		fs::write(&journal, "event: journal@1\ndata: {}\n").expect("journal");
		let output = directory.path().join("report.tar.gz");
		let mut spec =
			BundleSpec::new(output.clone(), journal, serde_json::json!({ "model": "test" }));
		spec.profiles.push(ProfilePayload {
			path:   "work.folded".to_owned(),
			format: "folded-stacks-microseconds".to_owned(),
			bytes:  b"omp;test 1\n".to_vec(),
		});
		let summary = create_bundle(spec).expect("bundle");
		assert_eq!(summary.output, output);
		assert!(summary.files >= 5);
		assert!(summary.uncompressed_bytes > 0);
		assert!(summary.output.is_file());
		assert!(
			fs::metadata(summary.output)
				.expect("archive metadata")
				.len() > 0
		);
	}
}
