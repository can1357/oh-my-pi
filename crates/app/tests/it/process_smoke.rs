//! End-to-end construction and command-line parsing smoke tests.

use std::{path::Path, sync::Arc};

use clap::Parser as _;
use omp_ai::auth::{CredentialStore, HeadlessKeySource, KeyId};
use omp_app::cli::OmpCli;
use omp_driver::registry::{open_credential_store_with_key_source, production_registry};

fn credential_store(path: &Path) -> Arc<CredentialStore> {
	open_credential_store_with_key_source(
		path,
		Arc::new(HeadlessKeySource::new(KeyId::new("process-smoke"), [0x31; 32])),
	)
	.expect("credential store")
}

#[tokio::test]
async fn production_registry_constructs_every_advertised_route() {
	let state = tempfile::tempdir().expect("temporary state");
	let store = credential_store(&state.path().join("credentials.db"));
	let registry = production_registry(state.path(), store)
		.await
		.expect("production registry");
	for route in registry.catalog().routes() {
		assert_ne!(
			registry.contains_service(&route.id),
			registry.unavailability(&route.id).is_some(),
			"route {} must have exactly one service or typed construction failure",
			route.id,
		);
	}
}

#[test]
fn all_executable_command_paths_parse_with_omp_names() {
	#[cfg(unix)]
	let endpoint = "/tmp/omp-process-smoke.sock";
	#[cfg(windows)]
	let endpoint = r"\\.\pipe\omp-process-smoke";
	for args in [
		vec!["omp", "serve", "--endpoint", endpoint],
		vec!["omp", "infer", "--model", "model", "--prompt", "hello"],
		vec!["omp", "auth", "list"],
		vec!["omp", "envd"],
		vec![
			"omp",
			"catalog",
			"import",
			"--providers",
			"providers.toml",
			"--oauth",
			"oauth.toml",
			"--models",
			"models.json.zst",
			"--destination",
			"catalog.json",
		],
		vec!["omp", "local", "infer", "--prompt", "hello"],
	] {
		let parsed = OmpCli::try_parse_from(args).expect("OMP command parses");
		assert!(parsed.command.is_some(), "explicit subcommands must parse to Some");
	}
}

#[test]
fn catalog_import_requires_explicit_oauth_manifest() {
	let result = OmpCli::try_parse_from([
		"omp",
		"catalog",
		"import",
		"--providers",
		"providers.toml",
		"--models",
		"models.json.zst",
		"--destination",
		"catalog.json",
	]);
	assert!(result.is_err(), "explicit catalog import must require --oauth");
}
