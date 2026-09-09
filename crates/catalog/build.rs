//! Offline validator for checked-in catalog artifacts.
use std::{
	env, fs,
	path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const SCHEMA_VERSION: u32 = 2;
const MAGIC: &[u8; 8] = b"OMPLLCAT";
const HEADER_LEN: usize = 8 + 4 + 32 + 32 + 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceLock {
	schema_version: u32,
	source_digest:  String,
	inputs:         Vec<SourceInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceInput {
	id:     String,
	path:   String,
	sha256: String,
	source: String,
}

fn main() {
	let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
	let data = manifest.join("data");
	let source_lock_path = data.join("sources.lock.json");
	let snapshot_path = data.join("catalog.postcard");

	for path in [&source_lock_path, &snapshot_path] {
		println!("cargo:rerun-if-changed={}", path.display());
	}

	let lock_bytes = read_required(&source_lock_path);
	let lock: SourceLock = serde_json::from_slice(&lock_bytes).unwrap_or_else(|error| {
		panic!("invalid catalog source lock {}: {error}", source_lock_path.display())
	});
	assert_eq!(lock.schema_version, SCHEMA_VERSION, "unsupported source-lock schema");
	validate_source_lock(&lock);
	let source_digest = source_digest(&lock.inputs);
	assert_eq!(lock.source_digest, hex(&source_digest), "catalog source-lock digest mismatch");

	let snapshot = read_required(&snapshot_path);
	validate_snapshot(&snapshot, &source_digest);
	println!("cargo:rustc-env=OMP_LLM_CATALOG_SOURCE_DIGEST={}", lock.source_digest);
}

fn read_required(path: &Path) -> Vec<u8> {
	fs::read(path).unwrap_or_else(|error| {
		panic!("cannot read required catalog artifact {}: {error}", path.display())
	})
}

fn validate_source_lock(lock: &SourceLock) {
	assert!(!lock.inputs.is_empty(), "catalog source lock contains no inputs");
	let mut prior: Option<&str> = None;
	for input in &lock.inputs {
		assert!(!input.id.is_empty(), "catalog source input id is empty");
		assert!(!input.path.is_empty(), "catalog source input path is empty");
		assert!(!input.source.is_empty(), "catalog source provenance is empty");
		assert!(
			decode_hash(&input.sha256).is_some(),
			"invalid SHA-256 for catalog source {}",
			input.id
		);
		if let Some(previous) = prior {
			assert!(
				previous < input.id.as_str(),
				"catalog source inputs are not uniquely sorted by id"
			);
		}
		prior = Some(&input.id);
	}
}

fn source_digest(inputs: &[SourceInput]) -> [u8; 32] {
	let mut digest = Sha256::new();
	for input in inputs {
		digest.update(input.id.as_bytes());
		digest.update([0]);
		digest.update(input.path.as_bytes());
		digest.update([0]);
		digest.update(input.sha256.as_bytes());
		digest.update([0]);
	}
	digest.finalize().into()
}

fn validate_snapshot(bytes: &[u8], source_digest: &[u8; 32]) {
	if env::var_os("OMP_LLM_CATALOG_REGEN").is_some() {
		// Bootstrap escape: the generator example rebuilds the snapshot from the
		// current lock; header assertions would otherwise forbid compiling it.
		return;
	}
	assert!(bytes.len() >= HEADER_LEN, "catalog snapshot is truncated");
	assert_eq!(&bytes[..8], MAGIC, "invalid catalog snapshot magic");
	let schema = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed schema field"));
	assert_eq!(schema, SCHEMA_VERSION, "unsupported catalog snapshot schema");
	assert_eq!(&bytes[12..44], source_digest, "catalog snapshot source digest mismatch");
	let payload_hash: [u8; 32] = Sha256::digest(&bytes[HEADER_LEN..]).into();
	assert_eq!(&bytes[76..108], &payload_hash, "catalog snapshot payload hash mismatch");
}

fn decode_hash(value: &str) -> Option<[u8; 32]> {
	if value.len() != 64 {
		return None;
	}
	let mut bytes = [0_u8; 32];
	for (index, byte) in bytes.iter_mut().enumerate() {
		let pair = &value[index * 2..index * 2 + 2];
		*byte = u8::from_str_radix(pair, 16).ok()?;
	}
	Some(bytes)
}

fn hex(bytes: &[u8; 32]) -> String {
	use std::fmt::Write as _;
	let mut output = String::with_capacity(64);
	for byte in bytes {
		write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
	}
	output
}
