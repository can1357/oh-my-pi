//! Sanitized host fact collectors used by native debug services.

use std::{
	env::{self, consts},
	fs, io,
	path::{Path, PathBuf},
	process, thread, time,
	time::Duration,
};

use serde::Serialize;

/// Sanitized host facts suitable for an overlay or diagnostic archive.
#[derive(Clone, Debug, Serialize)]
pub struct SystemFacts {
	/// Operating-system family.
	pub os:            &'static str,
	/// CPU architecture.
	pub architecture:  &'static str,
	/// Logical processors visible to the process.
	pub logical_cpus:  usize,
	/// Physical memory in bytes when cheaply available.
	pub memory_bytes:  Option<u64>,
	/// OMP package version.
	pub omp_version:   &'static str,
	/// Rust target family.
	pub target_family: &'static str,
	/// User shell executable after mandatory credential masking.
	pub shell:         String,
	/// Current working directory after mandatory credential masking.
	pub cwd:           String,
}

/// Collects bounded host facts without invoking platform debuggers.
pub fn collect_system_facts() -> SystemFacts {
	let shell = env::var("SHELL")
		.or_else(|_| env::var("COMSPEC"))
		.unwrap_or_default();
	let cwd = env::current_dir()
		.unwrap_or_else(|_| PathBuf::from("."))
		.display()
		.to_string();
	SystemFacts {
		os:            consts::OS,
		architecture:  consts::ARCH,
		logical_cpus:  thread::available_parallelism().map_or(1, usize::from),
		memory_bytes:  platform_memory_bytes(),
		omp_version:   env!("CARGO_PKG_VERSION"),
		target_family: consts::FAMILY,
		shell:         omp_observability::redact::redact_sensitive_credentials(&shell),
		cwd:           omp_observability::redact::redact_sensitive_credentials(&cwd),
	}
}

/// Writes a redacted visible transcript into an environment-created temporary
/// artifact.
pub fn export_transcript(directory: &Path, text: &str) -> io::Result<PathBuf> {
	fs::create_dir_all(directory)?;
	let nonce = time::SystemTime::now()
		.duration_since(time::UNIX_EPOCH)
		.unwrap_or(Duration::ZERO)
		.as_nanos();
	let path = directory.join(format!("omp-transcript-{}-{nonce}.txt", process::id()));
	let redacted = omp_observability::redact::redact_sensitive_credentials(text);
	fs::write(&path, redacted)?;
	Ok(path)
}

#[cfg(target_os = "linux")]
fn platform_memory_bytes() -> Option<u64> {
	let text = fs::read_to_string("/proc/meminfo").ok()?;
	let kb = text.lines().find_map(|line| {
		line
			.strip_prefix("MemTotal:")?
			.split_ascii_whitespace()
			.next()?
			.parse::<u64>()
			.ok()
	})?;
	kb.checked_mul(1024)
}
#[cfg(not(target_os = "linux"))]
const fn platform_memory_bytes() -> Option<u64> {
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn transcript_export_writes_a_redacted_real_file() {
		let directory = tempfile::tempdir().expect("temp directory");
		let secret = format!("gho_{}", "A".repeat(36));
		let path = export_transcript(directory.path(), &format!("visible {secret}"))
			.expect("export transcript");
		assert!(path.is_file());
		let text = fs::read_to_string(path).expect("read transcript");
		assert!(text.contains("visible"));
		assert!(!text.contains(&secret));
	}
}
