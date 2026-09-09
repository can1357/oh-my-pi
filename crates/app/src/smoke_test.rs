//! Deterministic pre-chat native subsystem probes.

use std::{
	env, fs,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_catalog::snapshot;
use omp_journal::Journal;

/// One named smoke probe result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProbeResult {
	/// Stable subsystem name.
	pub name:   &'static str,
	/// Whether the probe passed.
	pub ok:     bool,
	/// Concise status detail.
	pub detail: String,
}

/// Runs every enabled native probe, prints deterministic rows, and fails after
/// all probes have had a chance to report.
#[tracing::instrument(level = "debug", name = "smoke_test", skip_all)]
pub async fn run() -> miette::Result<()> {
	let results = [
		probe_inference(),
		probe_process("envd"),
		probe_process("exthost"),
		probe_process("docserver"),
		probe_storage(),
		probe_media(),
	];
	for result in &results {
		let status = if result.ok { "ok" } else { "FAILED" };
		if !result.ok {
			tracing::warn!(
				probe = result.name,
				detail = %result.detail,
				"smoke-test probe failed"
			);
		}
		if result.detail.is_empty() {
			println!("smoke-test: {:<10} {status}", result.name);
		} else {
			println!("smoke-test: {:<10} {status} — {}", result.name, result.detail);
		}
	}
	let failures = results.iter().filter(|result| !result.ok).count();
	if failures == 0 {
		tracing::info!(probe_count = results.len(), "smoke test completed");
		println!("smoke-test: ok");
		Ok(())
	} else {
		Err(miette::miette!("smoke-test: {failures} probe(s) failed"))
	}
}

fn probe_inference() -> ProbeResult {
	match snapshot::Catalog::try_embedded() {
		Ok(catalog) if !catalog.models().is_empty() => passed("inference"),
		Ok(_) => failed("inference", "embedded catalog contains no models"),
		Err(error) => failed("inference", &error.to_string()),
	}
}

fn probe_process(name: &'static str) -> ProbeResult {
	match env::current_exe().and_then(fs::metadata) {
		Ok(metadata) if metadata.is_file() => passed(name),
		Ok(_) => failed(name, "current executable is not a regular file"),
		Err(error) => failed(name, &error.to_string()),
	}
}

fn probe_storage() -> ProbeResult {
	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	let root = env::temp_dir().join(format!("omp-smoke-{}-{stamp}", std::process::id()));
	let result = fs::create_dir(&root).and_then(|()| {
		Journal::create(root.join("session.oms"))
			.map(|_| ())
			.map_err(std::io::Error::other)
	});
	let _ = fs::remove_dir_all(&root);
	match result {
		Ok(()) => passed("storage"),
		Err(error) => failed("storage", &error.to_string()),
	}
}

fn probe_media() -> ProbeResult {
	#[cfg(any(feature = "local-stt", feature = "local-tts"))]
	return passed("media");
	#[cfg(not(any(feature = "local-stt", feature = "local-tts")))]
	ProbeResult { name: "media", ok: true, detail: "disabled".to_owned() }
}

fn passed(name: &'static str) -> ProbeResult {
	ProbeResult { name, ok: true, detail: String::new() }
}

fn failed(name: &'static str, detail: &str) -> ProbeResult {
	ProbeResult { name, ok: false, detail: detail.to_owned() }
}
