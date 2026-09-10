//! Offline validator for checked-in catalog artifacts.
use std::{
	env,
	error::Error,
	fs, io,
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

fn main() -> Result<(), Box<dyn Error>> {
	let manifest = PathBuf::from(
		env::var_os("CARGO_MANIFEST_DIR")
			.ok_or_else(|| invalid_data("CARGO_MANIFEST_DIR is not set"))?,
	);
	let data = manifest.join("data");
	let source_lock_path = data.join("sources.lock.json");
	let snapshot_path = data.join("catalog.postcard");

	for path in [&source_lock_path, &snapshot_path] {
		println!("cargo:rerun-if-changed={}", path.display());
	}

	let lock_bytes = read_required(&source_lock_path)?;
	let lock: SourceLock = serde_json::from_slice(&lock_bytes).map_err(|error| {
		invalid_data(format!("invalid catalog source lock {}: {error}", source_lock_path.display()))
	})?;
	if lock.schema_version != SCHEMA_VERSION {
		return Err(
			invalid_data(format!(
				"unsupported source-lock schema {} (expected {SCHEMA_VERSION})",
				lock.schema_version
			))
			.into(),
		);
	}
	validate_source_lock(&lock)?;
	let source_digest = source_digest(&lock.inputs);
	let expected_digest = hex(&source_digest);
	if lock.source_digest != expected_digest {
		return Err(
			invalid_data(format!(
				"catalog source-lock digest mismatch: declared {}, computed {expected_digest}",
				lock.source_digest
			))
			.into(),
		);
	}

	let snapshot = read_required(&snapshot_path)?;
	validate_snapshot(&snapshot, &source_digest)?;
	println!("cargo:rustc-env=OMP_LLM_CATALOG_SOURCE_DIGEST={}", lock.source_digest);
	Ok(())
}

fn invalid_data(message: impl Into<String>) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn read_required(path: &Path) -> Result<Vec<u8>, io::Error> {
	fs::read(path).map_err(|error| {
		io::Error::new(
			error.kind(),
			format!("cannot read required catalog artifact {}: {error}", path.display()),
		)
	})
}

fn validate_source_lock(lock: &SourceLock) -> Result<(), io::Error> {
	if lock.inputs.is_empty() {
		return Err(invalid_data("catalog source lock contains no inputs"));
	}
	let mut prior: Option<&str> = None;
	for input in &lock.inputs {
		if input.id.is_empty() {
			return Err(invalid_data("catalog source input id is empty"));
		}
		if input.path.is_empty() {
			return Err(invalid_data(format!(
				"catalog source input `{}` has an empty path",
				input.id
			)));
		}
		if input.source.is_empty() {
			return Err(invalid_data(format!(
				"catalog source input `{}` has empty provenance",
				input.id
			)));
		}
		if decode_hash(&input.sha256).is_none() {
			return Err(invalid_data(format!(
				"invalid SHA-256 for catalog source `{}` ({})",
				input.id, input.path
			)));
		}
		if let Some(previous) = prior
			&& previous >= input.id.as_str()
		{
			return Err(invalid_data(format!(
				"catalog source inputs are not uniquely sorted by id: `{previous}` then `{}`",
				input.id
			)));
		}
		prior = Some(&input.id);
	}
	Ok(())
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
fn validate_snapshot(bytes: &[u8], source_digest: &[u8; 32]) -> Result<(), io::Error> {
	if env::var_os("OMP_LLM_CATALOG_REGEN").is_some() {
		// Bootstrap escape: the generator example rebuilds the snapshot from the
		// current lock; header assertions would otherwise forbid compiling it.
		return Ok(());
	}
	if bytes.len() < HEADER_LEN {
		return Err(invalid_data("catalog snapshot is truncated"));
	}
	if &bytes[..8] != MAGIC {
		return Err(invalid_data("invalid catalog snapshot magic"));
	}
	let schema = u32::from_le_bytes(
		bytes[8..12]
			.try_into()
			.map_err(|_| invalid_data("catalog snapshot schema field is truncated"))?,
	);
	if schema != SCHEMA_VERSION {
		return Err(invalid_data(format!(
			"unsupported catalog snapshot schema {schema} (expected {SCHEMA_VERSION})",
		)));
	}
	if &bytes[12..44] != source_digest {
		return Err(invalid_data("catalog snapshot source digest mismatch"));
	}
	let expected_payload_hash: [u8; 32] = bytes[76..108]
		.try_into()
		.map_err(|_| invalid_data("catalog snapshot payload hash field is truncated"))?;
	let payload_hash: [u8; 32] = Sha256::digest(&bytes[HEADER_LEN..]).into();
	if expected_payload_hash != payload_hash {
		return Err(invalid_data("catalog snapshot payload hash mismatch"));
	}
	Ok(())
}

fn decode_hash(value: &str) -> Option<[u8; 32]> {
	if value.len() != 64 {
		return None;
	}
	let mut bytes = [0_u8; 32];
	for (byte, &[high, low]) in bytes.iter_mut().zip(value.as_bytes().as_chunks::<2>().0) {
		let nibble = |value| match value {
			b'0'..=b'9' => Some(value - b'0'),
			b'a'..=b'f' => Some(value - b'a' + 10),
			b'A'..=b'F' => Some(value - b'A' + 10),
			_ => None,
		};
		*byte = (nibble(high)? << 4) | nibble(low)?;
	}
	Some(bytes)
}

fn hex(bytes: &[u8; 32]) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		output.push(char::from(DIGITS[usize::from(byte >> 4)]));
		output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
	}
	output
}
