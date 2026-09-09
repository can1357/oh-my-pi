//! Regenerates the checked-in catalog artifacts from the offline oracle
//! fixtures.

use std::{
	error, fs,
	path::{Path, PathBuf},
};

use omp_catalog::{Catalog, SnapshotProvenance, compile_oracle};
use serde::Deserialize;
use sha2::{Digest, Sha256};

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

fn main() -> Result<(), Box<dyn error::Error>> {
	let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let workspace = crate_dir
		.parent()
		.and_then(Path::parent)
		.expect("catalog crate is in workspace/crates");
	let lock_path = crate_dir.join("data/sources.lock.json");
	let lock: SourceLock = serde_json::from_slice(&fs::read(&lock_path)?)?;
	if lock.schema_version != 2 {
		return Err(format!("unsupported source-lock schema {}", lock.schema_version).into());
	}
	let source_digest = verify_sources(workspace, &lock)?;
	let providers =
		fs::read_to_string(workspace.join("fixtures/llm-oracle/catalog/providers.toml"))?;
	let models = fs::read(workspace.join("fixtures/llm-oracle/catalog/models.json.zst"))?;
	let oauth = fs::read_to_string(workspace.join("fixtures/llm-oracle/catalog/oauth.toml"))?;
	let catalog = compile_oracle(&providers, &models, &oauth)?;
	let artifacts = Catalog::encode(catalog, SnapshotProvenance { source_digest })?;
	fs::write(crate_dir.join("data/catalog.postcard"), artifacts.postcard)?;
	// The normalized JSON is a review artifact only: reproducible from the
	// postcard (its hash rides the snapshot header), so it stays out of git.
	let review = workspace.join("target/catalog.normalized.json");
	fs::write(&review, artifacts.normalized_json)?;
	println!("review artifact: {}", review.display());
	Ok(())
}

fn verify_sources(workspace: &Path, lock: &SourceLock) -> Result<[u8; 32], Box<dyn error::Error>> {
	let mut source_hasher = Sha256::new();
	let mut previous: Option<&str> = None;
	for input in &lock.inputs {
		if previous.is_some_and(|prior| prior >= input.id.as_str()) {
			return Err("source-lock inputs are not uniquely sorted".into());
		}
		if input.source.is_empty() {
			return Err(format!("source {} has no provenance", input.id).into());
		}
		let bytes = fs::read(workspace.join(&input.path))?;
		let actual = hex(&Sha256::digest(bytes).into());
		if actual != input.sha256 {
			return Err(format!("source {} hash mismatch", input.id).into());
		}
		source_hasher.update(input.id.as_bytes());
		source_hasher.update([0]);
		source_hasher.update(input.path.as_bytes());
		source_hasher.update([0]);
		source_hasher.update(input.sha256.as_bytes());
		source_hasher.update([0]);
		previous = Some(&input.id);
	}
	let digest: [u8; 32] = source_hasher.finalize().into();
	if hex(&digest) != lock.source_digest {
		return Err("source-lock aggregate digest mismatch".into());
	}
	Ok(digest)
}

fn hex(bytes: &[u8; 32]) -> String {
	use std::fmt::Write as _;
	let mut output = String::with_capacity(64);
	for byte in bytes {
		write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
	}
	output
}
