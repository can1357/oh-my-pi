//! Source-bound snapshot identities through the real in-process Environment
//! host.

use std::{
	path::{Path, PathBuf},
	process::Command,
	sync::Arc,
};

use omp_core::{Hash32, Principal, Str, sf};
use omp_driver::verification::{
	CheckRequirement, ContextField, SnapshotContext, SnapshotError, VerificationSnapshot,
	capture_verification_snapshot,
};
use omp_env::EnvClient;
use omp_envd::{EnvServer, RegistryBridges, exthost::ConvarControlFactory, worker::ExtHostConfig};
use omp_proto::env::v1 as pb;
use omp_tool::Registry;
use tokio_util::sync::CancellationToken;

struct Fixture {
	_temp:   tempfile::TempDir,
	root:    PathBuf,
	client:  EnvClient,
	serving: tokio::task::JoinHandle<()>,
}

impl Fixture {
	async fn new() -> Self {
		let temp = tempfile::tempdir().expect("scratch directory");
		let root = temp.path().join("source");
		std::fs::create_dir(&root).expect("source directory");
		git(&root, &["init", "--initial-branch=main"]);
		git(&root, &["config", "user.email", "verification@example.invalid"]);
		git(&root, &["config", "user.name", "Verification Test"]);
		std::fs::write(root.join("source.rs"), "pub fn answer() -> u32 { 42 }\n").expect("source");
		std::fs::write(root.join(".gitignore"), "ignored.txt\n").expect("ignore rules");
		git(&root, &["add", "."]);
		git(&root, &["commit", "-m", "fixture"]);
		std::fs::create_dir(temp.path().join("state")).expect("native state directory");
		let con = Arc::new(omp_con::Ctx::new());
		let server = Arc::new(
			EnvServer::open_local(
				&root,
				&temp.path().join("state"),
				Registry::new(),
				ExtHostConfig::new(
					PathBuf::from("unused"),
					Principal::new(sf!("snapshot-test"), sf!("Snapshot Test")),
					sf!("snapshot-session"),
					1,
				),
				&con,
				Arc::new(ConvarControlFactory::new(Arc::clone(&con))),
				RegistryBridges::default(),
			)
			.await
			.expect("native Environment"),
		);
		let (client, transport) = EnvClient::in_process(64);
		let serving = tokio::spawn(async move { server.serve_in_process(transport).await });
		client
			.hello(pb::ClientHello {
				client: "snapshot-contract-tests".to_owned(),
				schema_rev: omp_proto::SCHEMA_REV,
				..Default::default()
			})
			.await
			.expect("native client handshake");
		Self { _temp: temp, root, client, serving }
	}

	async fn capture(&self, context: &SnapshotContext) -> VerificationSnapshot {
		capture_verification_snapshot(&self.client, context, &CancellationToken::new())
			.await
			.expect("complete capture")
	}
}

impl Drop for Fixture {
	fn drop(&mut self) {
		self.serving.abort();
	}
}

fn git(root: &Path, args: &[&str]) {
	let output = Command::new("git")
		.args(args)
		.current_dir(root)
		.output()
		.expect("git");
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

fn context() -> SnapshotContext {
	let known = Some(Hash32::sum(b"explicit fixture context"));
	SnapshotContext {
		dependencies:      known,
		toolchain:         known,
		environment:       known,
		tests:             known,
		requirements:      known,
		policy:            known,
		verifier:          known,
		required_paths:    Arc::from([Str::new_static("source.rs")]),
		unresolved_inputs: Arc::from([]),
	}
}

fn check(id: &'static str, required: bool) -> CheckRequirement {
	CheckRequirement { id: Str::new_static(id), required }
}

#[tokio::test]
async fn stable_native_captures_ignore_response_counters_and_canonicalize_required_paths() {
	let fixture = Fixture::new().await;
	let mut ordered = context();
	ordered.required_paths =
		Arc::from([Str::new_static(".gitignore"), Str::new_static("source.rs")]);
	let original = fixture.capture(&ordered).await;
	let mut reordered = ordered;
	reordered.required_paths = Arc::from([
		Str::new_static("source.rs"),
		Str::new_static(".gitignore"),
		Str::new_static("source.rs"),
	]);
	let repeated = fixture.capture(&reordered).await;
	assert_eq!(original.inputs_digest(), repeated.inputs_digest());
	assert_eq!(original.manifest(), repeated.manifest());
	assert_eq!(original.inputs_digest(), Hash32::sum(original.canonical_bytes()));
}

#[tokio::test]
async fn tracked_untracked_and_deleted_bytes_change_identity() {
	let fixture = Fixture::new().await;
	let initial = fixture.capture(&context()).await;
	std::fs::write(fixture.root.join("source.rs"), "pub fn answer() -> u32 { 43 }\n").unwrap();
	let dirty = fixture.capture(&context()).await;
	assert_ne!(initial.inputs_digest(), dirty.inputs_digest());
	std::fs::write(fixture.root.join("additional.rs"), "// additional input\n").unwrap();
	let untracked = fixture.capture(&context()).await;
	assert_ne!(dirty.inputs_digest(), untracked.inputs_digest());
	std::fs::remove_file(fixture.root.join("source.rs")).unwrap();
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &context(), &CancellationToken::new()).await,
		Err(SnapshotError::MissingRequiredInput { .. })
	));
}

#[tokio::test]
async fn every_admitted_context_category_invalidates_the_action_key() {
	let fixture = Fixture::new().await;
	let original = fixture.capture(&context()).await;
	let policy = original.policy(vec![check("compile", true)]).unwrap();
	let configuration = Hash32::sum(b"exact command and resource policy");
	let original_key = original
		.applicability_key(&policy, "compile", configuration)
		.unwrap();
	for field in 0..7 {
		let mut changed = context();
		let value = Some(Hash32::sum(b"changed admitted input"));
		match field {
			0 => changed.dependencies = value,
			1 => changed.toolchain = value,
			2 => changed.environment = value,
			3 => changed.tests = value,
			4 => changed.requirements = value,
			5 => changed.policy = value,
			_ => changed.verifier = value,
		}
		let snapshot = fixture.capture(&changed).await;
		assert_ne!(snapshot.inputs_digest(), original.inputs_digest(), "category {field}");
		let policy = snapshot.policy(vec![check("compile", true)]).unwrap();
		assert_ne!(
			snapshot
				.applicability_key(&policy, "compile", configuration)
				.unwrap(),
			original_key
		);
	}
}

#[tokio::test]
async fn inventory_configuration_and_snapshot_are_bound_to_declared_actions() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture(&context()).await;
	let policy = snapshot.policy(vec![check("compile", true)]).unwrap();
	let config = Hash32::sum(b"check --locked");
	let key = snapshot
		.applicability_key(&policy, "compile", config)
		.unwrap();
	assert_eq!(
		snapshot
			.applicability_key(&policy, "compile", config)
			.unwrap(),
		key
	);
	assert_ne!(
		snapshot
			.applicability_key(&policy, "compile", Hash32::sum(b"check without lock"))
			.unwrap(),
		key
	);
	let extended = snapshot
		.policy(vec![check("compile", true), check("tests", false)])
		.unwrap();
	assert_ne!(
		snapshot
			.applicability_key(&extended, "compile", config)
			.unwrap(),
		key
	);
	let required = snapshot
		.policy(vec![check("compile", true), check("tests", true)])
		.unwrap();
	let reordered = snapshot
		.policy(vec![check("tests", false), check("compile", true)])
		.unwrap();
	assert_ne!(required.scope().policy, extended.scope().policy);
	assert_ne!(reordered.scope().policy, extended.scope().policy);
	let mut unrelated_scope = policy.scope();
	unrelated_scope.policy = Hash32::sum(b"unrelated policy rules");
	let unrelated = omp_driver::verification::VerificationPolicy::new(unrelated_scope, vec![check(
		"compile", true,
	)])
	.unwrap();
	assert!(matches!(
		snapshot.applicability_key(&unrelated, "compile", config),
		Err(SnapshotError::PolicySnapshotMismatch)
	));
	assert!(matches!(
		snapshot.applicability_key(&policy, "undeclared", config),
		Err(SnapshotError::UnknownCheck { .. })
	));
	assert!(matches!(snapshot.policy(vec![]), Err(SnapshotError::Policy(_))));
	assert!(matches!(
		snapshot.policy(vec![check("compile", true), check("compile", false)]),
		Err(SnapshotError::Policy(_))
	));
	std::fs::write(fixture.root.join("source.rs"), "// changed\n").unwrap();
	let next = fixture.capture(&context()).await;
	assert!(matches!(
		next.applicability_key(&policy, "compile", config),
		Err(SnapshotError::PolicySnapshotMismatch)
	));
}

#[tokio::test]
async fn ignored_required_files_and_filtered_inputs_never_produce_a_snapshot() {
	let fixture = Fixture::new().await;
	std::fs::write(fixture.root.join("ignored.txt"), "needed build input").unwrap();
	let mut required = context();
	required.required_paths = Arc::from([Str::new_static("ignored.txt")]);
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &required, &CancellationToken::new()).await,
		Err(SnapshotError::MissingRequiredInput { .. })
	));
	std::fs::write(fixture.root.join(".env"), "EXAMPLE=value\n").unwrap();
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &context(), &CancellationToken::new()).await,
		Err(SnapshotError::Excluded { .. })
	));
	git(&fixture.root, &["add", ".env"]);
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &context(), &CancellationToken::new()).await,
		Err(SnapshotError::Refused { .. })
	));
}

#[tokio::test]
async fn unknown_unresolved_invalid_and_cancelled_inputs_are_explicit_errors() {
	let fixture = Fixture::new().await;
	let mut unknown = context();
	unknown.toolchain = None;
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &unknown, &CancellationToken::new()).await,
		Err(SnapshotError::UnknownContext { field: ContextField::Toolchain })
	));
	let mut unresolved = context();
	unresolved.unresolved_inputs = Arc::from([Str::new_static("external fixture not identified")]);
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &unresolved, &CancellationToken::new()).await,
		Err(SnapshotError::UnresolvedInputs { .. })
	));
	for path in ["../escape", "/absolute", "source/../source.rs", "source\\file"] {
		let mut invalid = context();
		invalid.required_paths = Arc::from([Str::new(path)]);
		assert!(matches!(
			capture_verification_snapshot(&fixture.client, &invalid, &CancellationToken::new()).await,
			Err(SnapshotError::InvalidRequiredPath { .. })
		));
	}
	let cancel = CancellationToken::new();
	cancel.cancel();
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &context(), &cancel).await,
		Err(SnapshotError::Cancelled)
	));
}

#[cfg(unix)]
#[tokio::test]
async fn executable_mode_changes_identity_and_symlinks_refuse_completeness() {
	use std::os::unix::fs::{PermissionsExt, symlink};
	let fixture = Fixture::new().await;
	let before = fixture.capture(&context()).await;
	std::fs::set_permissions(fixture.root.join("source.rs"), std::fs::Permissions::from_mode(0o755))
		.unwrap();
	let after = fixture.capture(&context()).await;
	assert_ne!(before.inputs_digest(), after.inputs_digest());
	symlink("source.rs", fixture.root.join("linked.rs")).unwrap();
	assert!(matches!(
		capture_verification_snapshot(&fixture.client, &context(), &CancellationToken::new()).await,
		Err(SnapshotError::ExcludedSymlinks { count: 1 })
	));
}
