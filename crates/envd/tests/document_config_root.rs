//! The document authority probes the user configuration root (`~/.o2`,
//! `OMP_CONFIG_DIR`) for `lsp.json`/`dap.json`, never the data directory.

use std::fs;

use omp_envd::docserver::lsp_config::{LspConfigSourceKind, discover_native_lsp_sources};

#[test]
fn document_authority_probes_the_user_config_root_for_lsp_overrides() {
	let config = tempfile::tempdir().expect("config directory");
	let data = tempfile::tempdir().expect("data directory");
	let project = tempfile::tempdir().expect("project directory");
	// SAFETY: nextest runs each test in its own process; nothing else reads the
	// variables concurrently.
	unsafe {
		std::env::set_var("OMP_CONFIG_DIR", config.path());
		std::env::set_var("OMP_DATA_DIR", data.path());
	}
	fs::write(
		config.path().join("lsp.json"),
		r#"{"servers":{"rust":{"command":"rust-analyzer","languages":["rust"]}}}"#,
	)
	.expect("user lsp.json");
	fs::write(data.path().join("lsp.json"), r#"{"servers":{}}"#).expect("data-dir lsp.json");

	let root = omp_envd::document_user_config_root().expect("user configuration root");
	assert_eq!(root, config.path());

	let sources = discover_native_lsp_sources(Some(&root), project.path()).expect("sources");
	let user: Vec<&str> = sources
		.iter()
		.filter(|source| source.provenance.kind == LspConfigSourceKind::User)
		.map(|source| source.provenance.source.as_str())
		.collect();
	let expected = config.path().join("lsp.json");
	assert_eq!(user, [expected.to_str().expect("utf-8 path")]);
	assert!(
		!sources.iter().any(|source| source
			.provenance
			.source
			.starts_with(data.path().to_str().unwrap())),
		"data directory must never be probed for user configuration"
	);
}
