//! Compiles checked-in vendor protobuf schemas into `OUT_DIR`.

use std::{collections::BTreeSet, env, fs, path::Path};

use prost::Message as _;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

const CURSOR_SCHEMA_SHA256: &str =
	"fc1ac3ed472676e6d863fe2238ab1529247b68d3ea21f33b3fae1abae481892c";

fn main() {
	let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
	let schema = manifest.join("../../fixtures/llm-oracle/vendor-schemas/cursor/agent.proto");
	println!("cargo::rerun-if-changed={}", schema.display());
	let source = fs::read(&schema).expect("checked-in Cursor agent.proto is missing");
	let actual = format!("{:x}", Sha256::digest(&source));
	assert_eq!(
		actual, CURSOR_SCHEMA_SHA256,
		"Cursor agent.proto drifted from its verified b6e01c8a3c source; update provenance and the \
		 binding contract together"
	);

	let descriptors =
		protox::compile([&schema], [schema.parent().expect("Cursor schema has no parent")])
			.expect("protox failed to compile the verified Cursor schema");
	let descriptor_bytes = descriptors.encode_to_vec();
	fs::write(
		Path::new(&env::var_os("OUT_DIR").expect("Cargo did not set OUT_DIR"))
			.join("cursor-agent-descriptor.bin"),
		descriptor_bytes,
	)
	.expect("failed to write Cursor descriptor set");

	let mut config = prost_build::Config::new();
	config.bytes(["."]);
	config.btree_map(["."]);
	config
		.compile_fds(descriptors)
		.expect("prost-build failed to generate Cursor bindings");

	compile_devin(manifest);
}

#[derive(Deserialize)]
struct VendorManifest {
	fixtures: Vec<VendorFixture>,
}

#[derive(Deserialize)]
struct VendorFixture {
	path:        String,
	secret_free: bool,
	sha256:      String,
	source:      String,
}

#[derive(Deserialize)]
struct Provenance {
	providers: ProvenanceProviders,
}

#[derive(Deserialize)]
struct ProvenanceProviders {
	devin: DevinProvenance,
}

#[derive(Deserialize)]
struct DevinProvenance {
	commit:        String,
	compile_roots: Vec<String>,
}

#[derive(Deserialize)]
struct DriftReport {
	providers: DriftProviders,
}

#[derive(Deserialize)]
struct DriftProviders {
	devin: DevinDrift,
}

#[derive(Deserialize)]
struct DevinDrift {
	binding_conflict_count: usize,
	binding_conflicts:      Vec<serde::de::IgnoredAny>,
}

fn compile_devin(manifest_dir: &Path) {
	const COMMIT: &str = "fc01e3b6cba6e1add44a1613baa891a9b873f8a9";
	const ROOTS: [&str; 4] = [
		"devin/exa/api_server_pb/api_server.proto",
		"devin/exa/auth_pb/auth.proto",
		"devin/exa/chat_pb/chat.proto",
		"devin/exa/codeium_common_pb/codeium_common.proto",
	];

	let vendor = manifest_dir.join("../../fixtures/llm-oracle/vendor-schemas");
	let manifest_path = vendor.join("manifest.json");
	let provenance_path = vendor.join("provenance.json");
	let drift_path = vendor.join("drift.json");
	for path in [&manifest_path, &provenance_path, &drift_path] {
		println!("cargo::rerun-if-changed={}", path.display());
	}

	let manifest: VendorManifest =
		serde_json::from_slice(&fs::read(&manifest_path).expect("vendor schema manifest is missing"))
			.expect("vendor schema manifest is malformed");
	let devin: Vec<_> = manifest
		.fixtures
		.iter()
		.filter(|fixture| fixture.path.starts_with("devin/"))
		.collect();
	assert_eq!(devin.len(), 20, "Devin transitive schema closure must contain 20 files");
	for fixture in devin {
		assert!(fixture.secret_free, "vendor schema source must be secret-free");
		assert!(
			fixture.source.starts_with(COMMIT),
			"Devin schema provenance does not name the verified commit"
		);
		let path = vendor.join(&fixture.path);
		println!("cargo::rerun-if-changed={}", path.display());
		let source = fs::read(&path).expect("verified Devin schema file is missing");
		let actual = format!("{:x}", Sha256::digest(&source));
		assert_eq!(
			actual, fixture.sha256,
			"Devin schema drifted from its verified source: {}",
			fixture.path
		);
	}

	let provenance: Provenance = serde_json::from_slice(
		&fs::read(&provenance_path).expect("vendor schema provenance is missing"),
	)
	.expect("vendor schema provenance is malformed");
	assert_eq!(provenance.providers.devin.commit, COMMIT);
	let actual_roots: BTreeSet<_> = provenance
		.providers
		.devin
		.compile_roots
		.iter()
		.map(String::as_str)
		.collect();
	assert_eq!(actual_roots, ROOTS.into_iter().collect());

	let drift: DriftReport =
		serde_json::from_slice(&fs::read(&drift_path).expect("schema drift report is missing"))
			.expect("schema drift report is malformed");
	assert_eq!(drift.providers.devin.binding_conflict_count, 0);
	assert_eq!(drift.providers.devin.binding_conflicts.len(), 0);

	let roots: Vec<_> = ROOTS.into_iter().map(|root| vendor.join(root)).collect();
	let include = vendor.join("devin");
	let descriptors = protox::compile(&roots, [&include])
		.expect("protox failed to compile the verified Devin schema closure");
	fs::write(
		Path::new(&env::var_os("OUT_DIR").expect("Cargo did not set OUT_DIR"))
			.join("devin-descriptor.bin"),
		descriptors.encode_to_vec(),
	)
	.expect("failed to write Devin descriptor set");

	let mut config = prost_build::Config::new();
	config.bytes(["."]);
	config.btree_map(["."]);
	config
		.compile_fds(descriptors)
		.expect("prost-build failed to generate Devin bindings");
}
