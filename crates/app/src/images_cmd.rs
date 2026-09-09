//! Image blob-store inspection and integrity probing.

use std::{
	fs,
	path::{Path, PathBuf},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_core::Hash32;
use omp_journal::blob::{BlobRef, BlobStore};
use serde_json::{Value, json};

use crate::cli::{ImagesAction, ImagesArgs};

#[derive(Debug)]
struct Inventory {
	blobs:           Vec<BlobRef>,
	bytes:           u64,
	malformed:       Vec<PathBuf>,
	temporary_count: u64,
	temporary_bytes: u64,
}

/// Runs one image blob-store operation against the profile's authoritative
/// store.
pub fn run(args: ImagesArgs) -> miette::Result<()> {
	if args.timeout == Some(0) {
		return Err(miette!("--timeout must be a positive integer"));
	}
	let data_dir = omp_core::dirs::data_dir(args.dir).into_diagnostic()?;
	let store = BlobStore::open(&data_dir).into_diagnostic()?;
	match args.action {
		ImagesAction::Status => status(&store, args.json),
		ImagesAction::Doctor => doctor(&store, args.json),
		ImagesAction::Probe => probe(&store, args.timeout, args.json),
	}
}

fn status(store: &BlobStore, json_output: bool) -> miette::Result<()> {
	let inventory = inventory(store)?;
	let report = json!({
		"action": "status",
		"enabled": true,
		"backends": ["content-addressed"],
		"store": store.root(),
		"blobs": inventory.blobs.len(),
		"bytes": inventory.bytes,
		"malformed": inventory.malformed.len(),
		"temporaryFiles": inventory.temporary_count,
		"temporaryBytes": inventory.temporary_bytes,
	});
	if json_output {
		print_json(&report)?;
	} else {
		println!("Image backends: content-addressed");
		println!("Enabled: yes");
		println!("Image blob store: {}", store.root().display());
		println!("Blobs: {} ({})", inventory.blobs.len(), format_bytes(inventory.bytes));
		println!(
			"Temporary files: {} ({})",
			inventory.temporary_count,
			format_bytes(inventory.temporary_bytes)
		);
		if !inventory.malformed.is_empty() {
			println!("Malformed entries: {}", inventory.malformed.len());
		}
	}
	Ok(())
}

fn doctor(store: &BlobStore, json_output: bool) -> miette::Result<()> {
	let inventory = inventory(store)?;
	let mut corrupt = Vec::new();
	for reference in &inventory.blobs {
		if !store.verify(reference).into_diagnostic()? {
			corrupt.push(reference.to_hex().to_string());
		}
	}
	let healthy = inventory.malformed.is_empty() && corrupt.is_empty();
	let malformed = inventory
		.malformed
		.iter()
		.map(|path| path.display().to_string())
		.collect::<Vec<_>>();
	let report = json!({
		"action": "doctor",
		"healthy": healthy,
		"checks": [
			{
				"name": "layout",
				"severity": if inventory.malformed.is_empty() { "ok" } else { "error" },
				"detail": if inventory.malformed.is_empty() {
					"Blob shard layout is canonical".to_owned()
				} else {
					format!("{} malformed store entries", inventory.malformed.len())
				},
			},
			{
				"name": "integrity",
				"severity": if corrupt.is_empty() { "ok" } else { "error" },
				"detail": if corrupt.is_empty() {
					format!("Verified {} blob digests", inventory.blobs.len())
				} else {
					format!("{} blobs failed digest verification", corrupt.len())
				},
			},
			{
				"name": "temporary-files",
				"severity": if inventory.temporary_count == 0 { "ok" } else { "warn" },
				"detail": if inventory.temporary_count == 0 {
					"No abandoned staging files".to_owned()
				} else {
					format!("{} staging files remain", inventory.temporary_count)
				},
			},
		],
		"malformedEntries": malformed,
		"corruptBlobs": corrupt,
	});
	if json_output {
		print_json(&report)?;
	} else {
		for check in report["checks"]
			.as_array()
			.expect("doctor checks are an array")
		{
			println!(
				"[{}] {}: {}",
				check["severity"]
					.as_str()
					.expect("doctor severity is text")
					.to_ascii_uppercase(),
				check["name"].as_str().expect("doctor name is text"),
				check["detail"].as_str().expect("doctor detail is text")
			);
		}
		for path in &inventory.malformed {
			println!("Malformed: {}", path.display());
		}
		for hash in report["corruptBlobs"]
			.as_array()
			.expect("corrupt blobs are an array")
		{
			println!("Corrupt: {}", hash.as_str().expect("corrupt hash is text"));
		}
		println!("Image diagnostics {}.", if healthy { "passed" } else { "found errors" });
	}
	if healthy {
		Ok(())
	} else {
		Err(miette!("image blob-store diagnostics found errors"))
	}
}

fn probe(store: &BlobStore, timeout_seconds: Option<u64>, json_output: bool) -> miette::Result<()> {
	let started = Instant::now();
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.into_diagnostic()?
		.as_nanos();
	let payload = format!("omp-images-probe-{}-{timestamp}", std::process::id());
	let expected = BlobRef {
		hash: Hash32::sum(payload.as_bytes()),
		size: u64::try_from(payload.len()).expect("probe payload length fits in u64"),
	};
	let existed = store.has(&expected);
	let result = (|| {
		let reference = store.put(payload.as_bytes())?;
		let verified = store.verify(&reference)?;
		let round_trip = store.get(&reference)? == payload.as_bytes();
		Ok::<bool, omp_journal::blob::Error>(reference == expected && verified && round_trip)
	})();
	let cleanup = if existed {
		Ok(())
	} else {
		fs::remove_file(store.path(&expected))
	};
	let ok = result.into_diagnostic()?;
	cleanup.into_diagnostic()?;
	let elapsed = started.elapsed();
	let within_timeout =
		timeout_seconds.is_none_or(|seconds| elapsed < Duration::from_secs(seconds));
	let passed = ok && within_timeout;
	let detail = if !ok {
		"Blob write or verified read returned inconsistent data"
	} else if !within_timeout {
		"Blob-store probe exceeded the requested timeout"
	} else {
		"Blob write, verified read, and cleanup succeeded"
	};
	let duration_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
	let report = json!({
		"action": "probe",
		"ok": passed,
		"durationMs": duration_ms,
		"detail": detail,
	});
	if json_output {
		print_json(&report)?;
	} else {
		println!(
			"Image probe {} in {} ms: {}",
			if passed { "passed" } else { "failed" },
			duration_ms,
			detail
		);
	}
	if passed {
		Ok(())
	} else {
		Err(miette!("image blob-store probe failed"))
	}
}

fn inventory(store: &BlobStore) -> miette::Result<Inventory> {
	let mut blobs = Vec::new();
	let mut bytes = 0_u64;
	let mut malformed = Vec::new();
	let blobs_dir = store.root().join("blobs");
	for first in fs::read_dir(&blobs_dir).into_diagnostic()? {
		let first = first.into_diagnostic()?;
		if !first.file_type().into_diagnostic()?.is_dir() {
			malformed.push(first.path());
			continue;
		}
		for second in fs::read_dir(first.path()).into_diagnostic()? {
			let second = second.into_diagnostic()?;
			if !second.file_type().into_diagnostic()?.is_dir() {
				malformed.push(second.path());
				continue;
			}
			for entry in fs::read_dir(second.path()).into_diagnostic()? {
				let entry = entry.into_diagnostic()?;
				let path = entry.path();
				let file_type = entry.file_type().into_diagnostic()?;
				let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
					malformed.push(path);
					continue;
				};
				let canonical_shards = first.file_name().to_str() == name.get(..2)
					&& second.file_name().to_str() == name.get(2..4);
				if !file_type.is_file() || !canonical_shards {
					malformed.push(path);
					continue;
				}
				let size = entry.metadata().into_diagnostic()?.len();
				match BlobRef::parse_hex(&name, size) {
					Ok(reference) => {
						bytes = bytes.saturating_add(size);
						blobs.push(reference);
					},
					Err(_) => malformed.push(path),
				}
			}
		}
	}
	let (temporary_count, temporary_bytes) = temporary_inventory(&store.root().join("tmp"))?;
	Ok(Inventory { blobs, bytes, malformed, temporary_count, temporary_bytes })
}

fn temporary_inventory(path: &Path) -> miette::Result<(u64, u64)> {
	let mut count = 0_u64;
	let mut bytes = 0_u64;
	for entry in fs::read_dir(path).into_diagnostic()? {
		let entry = entry.into_diagnostic()?;
		count = count.saturating_add(1);
		if let Ok(metadata) = entry.metadata() {
			bytes = bytes.saturating_add(metadata.len());
		}
	}
	Ok((count, bytes))
}

fn print_json(value: &Value) -> miette::Result<()> {
	println!("{}", serde_json::to_string(value).into_diagnostic()?);
	Ok(())
}

fn format_bytes(bytes: u64) -> String {
	const KIB: f64 = 1024.0;
	const MIB: f64 = KIB * 1024.0;
	const GIB: f64 = MIB * 1024.0;
	let bytes_float = bytes as f64;
	if bytes < 1024 {
		format!("{bytes} B")
	} else if bytes_float < MIB {
		format!("{:.1} KiB", bytes_float / KIB)
	} else if bytes_float < GIB {
		format!("{:.1} MiB", bytes_float / MIB)
	} else {
		format!("{:.1} GiB", bytes_float / GIB)
	}
}
