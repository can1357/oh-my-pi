//! Joined native verification through the real Environment, process host and
//! journal.

#[cfg(target_os = "linux")]
use std::{env::args_os, process::exit};
use std::{
	fs,
	path::{Path, PathBuf},
	process::Command,
	sync::Arc,
	time::Duration,
};

use omp_core::{Hash32, Principal, Str, sf};
use omp_driver::verification::{
	GateVerdict, NativeVerificationError, NativeVerificationReport, NativeVerificationSpec,
	evidence_publications, load_evidence, run_native_verification,
};
use omp_env::EnvClient;
use omp_envd::{EnvServer, RegistryBridges, exthost::ConvarControlFactory, worker::ExtHostConfig};
use omp_proto::env::v1 as pb;
use omp_session::{ComponentRegistry, Session};
use omp_tool::Registry;
use tokio::{
	task::JoinHandle,
	time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;

// Linux confinement reexecutes the current image before entering the child
// program. Dispatch that existing native entry before libtest parses argv,
// exactly as the application does; no alternate sandbox host is introduced.
#[cfg(target_os = "linux")]
#[ctor::ctor]
fn sandbox_child_entry() {
	if args_os()
		.nth(1)
		.is_some_and(|arg| arg == omp_sandbox::HIDDEN_CHILD_ARG)
	{
		match omp_sandbox::run_child_entry() {
			Ok(()) => exit(0),
			Err(error) => {
				eprintln!("native verification sandbox child: {error}");
				exit(1);
			},
		}
	}
}

const PACKAGE: &str = "native-verification-fixture";
const JUSTFILE: &str = "set shell := [\"bash\", \"-euo\", \"pipefail\", \"-c\"]\n\ncheck-pkg \
                        pkg:\n    cargo check -p {{pkg}} --locked\n\ntest-pkg pkg:\n    cargo \
                        nextest run -p {{pkg}} --locked\n    cargo test --doc -p {{pkg}} \
                        --locked\n";
const PASSING_SOURCE: &str = "/// Returns the fixture answer.\n/// ```\n/// \
                              assert_eq!(native_verification_fixture::answer(), 42);\n/// \
                              ```\npub fn answer() -> u32 { 42 }\n#[cfg(test)] mod tests { \
                              #[test] fn answer_is_correct() { assert_eq!(super::answer(), 42); \
                              assert_eq!(env!(\"CONTROL_WRITES_DENIED\"), \"true\"); } }\n";
const CONTROL_PROBE: &str = r##"
fn main() {
    let home = std::path::PathBuf::from(std::env::var_os("CARGO_HOME").unwrap());
    let mut denied = true;
    for name in ["config", "config.toml"] {
        let file = home.join(name);
        denied &= std::fs::write(&file, "# attempted control mutation\n").is_err();
        denied &= std::fs::remove_file(&file).is_err();
        denied &= std::fs::rename(&file, home.join(format!("{name}-moved"))).is_err();
    }
    denied &= std::fs::rename(&home, home.with_file_name("cargo-moved")).is_err();
    let source = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    denied &= std::fs::create_dir_all(source.parent().unwrap().join(".cargo")).is_err();
    println!("cargo:rustc-env=CONTROL_WRITES_DENIED={denied}");
}
"##;

struct Fixture {
	_temp:   tempfile::TempDir,
	root:    PathBuf,
	state:   PathBuf,
	client:  EnvClient,
	serving: JoinHandle<()>,
}

impl Fixture {
	async fn new() -> Self {
		let temp = tempfile::tempdir().expect("scratch directory");
		let root = temp.path().join("source");
		fs::create_dir_all(root.join("src")).unwrap();
		fs::write(
			root.join("Cargo.toml"),
			"[package]\nname = \"native-verification-fixture\"\nversion = \"0.1.0\"\nedition = \
			 \"2024\"\n",
		)
		.unwrap();
		fs::write(
			root.join("Cargo.lock"),
			"version = 4\n\n[[package]]\nname = \"native-verification-fixture\"\nversion = \
			 \"0.1.0\"\n",
		)
		.unwrap();
		fs::write(root.join("rust-toolchain.toml"), include_bytes!("../../../rust-toolchain.toml"))
			.unwrap();
		fs::write(root.join("justfile"), JUSTFILE).unwrap();
		fs::write(root.join("src/lib.rs"), PASSING_SOURCE).unwrap();
		fs::write(root.join("build.rs"), CONTROL_PROBE).unwrap();
		git(&root, &["init", "--initial-branch=main"]);
		git(&root, &["config", "user.email", "verification@example.invalid"]);
		git(&root, &["config", "user.name", "Verification Test"]);
		git(&root, &["add", "."]);
		git(&root, &["commit", "-m", "native verification fixture"]);
		let state = temp.path().join("state");
		fs::create_dir_all(state.join("environment")).unwrap();
		let con = Arc::new(omp_con::Ctx::new());
		let server = Arc::new(
			EnvServer::open_local(
				&root,
				&state.join("environment"),
				Registry::new(),
				ExtHostConfig::new(
					PathBuf::from("unused"),
					Principal::new(sf!("native-verification-test"), sf!("Native Verification Test")),
					sf!("native-verification-session"),
					1,
				),
				&con,
				Arc::new(ConvarControlFactory::new(Arc::clone(&con))),
				RegistryBridges::default(),
			)
			.await
			.expect("native environment"),
		);
		let (client, transport) = EnvClient::in_process(64);
		let serving = tokio::spawn(async move { server.serve_in_process(transport).await });
		client
			.hello(pb::ClientHello {
				client: "native-verification-contract-tests".into(),
				schema_rev: omp_proto::SCHEMA_REV,
				..Default::default()
			})
			.await
			.expect("native handshake");
		Self { _temp: temp, root, state, client, serving }
	}

	fn session(&self) -> (PathBuf, Session) {
		let journal = self
			.state
			.join(format!("{}.oms", omp_core::Ulid::generate()));
		let session =
			Session::create(&journal, ComponentRegistry::default()).expect("session creates");
		(journal, session)
	}

	async fn run(
		&self,
		session: &mut Session,
		cancel: &CancellationToken,
	) -> Result<NativeVerificationReport, NativeVerificationError> {
		run_native_verification(
			&self.client,
			session,
			&self.root,
			&self.state.join("runtime"),
			&spec(),
			Hash32::sum(b"fixture requirements v1"),
			cancel,
		)
		.await
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
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

fn spec() -> NativeVerificationSpec {
	NativeVerificationSpec {
		packages:         vec![Str::new_static(PACKAGE)],
		timeout_seconds:  900,
		minimum_tests:    1,
		max_output_bytes: 1024 * 1024,
	}
}

fn assert_not_pass(result: Result<NativeVerificationReport, NativeVerificationError>) {
	if let Ok(report) = result {
		assert_ne!(report.verdict, GateVerdict::Pass);
	}
}

#[test]
fn explicit_inventory_and_finite_budgets_are_required() {
	assert!(spec().validate().is_ok());
	let mut invalid = spec();
	invalid.packages.clear();
	assert!(invalid.validate().is_err());
	invalid = spec();
	invalid.packages.push(Str::new_static(PACKAGE));
	assert!(invalid.validate().is_err());
	invalid = spec();
	invalid.minimum_tests = 0;
	assert!(invalid.validate().is_err());
	invalid = spec();
	invalid.timeout_seconds = 0;
	assert!(invalid.validate().is_err());
	invalid = spec();
	invalid.max_output_bytes = 0;
	assert!(invalid.validate().is_err());
}

#[tokio::test]
async fn requested_root_must_match_the_captured_primary_source() {
	let mut fixture = Fixture::new().await;
	let (_, mut session) = fixture.session();
	fixture.root = fixture.root.join("src");
	assert_not_pass(fixture.run(&mut session, &CancellationToken::new()).await);
	assert!(evidence_publications(&session).unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_admission_cannot_pass_or_publish_success() {
	let fixture = Fixture::new().await;
	let (_, mut session) = fixture.session();
	let cancel = CancellationToken::new();
	cancel.cancel();
	assert_not_pass(fixture.run(&mut session, &cancel).await);
	for publication in evidence_publications(&session).expect("valid durable metadata") {
		let record = load_evidence(&session, publication).expect("receipt closure verifies");
		assert_ne!(record.outcome, omp_driver::verification::CheckOutcome::Passed);
	}
}

#[tokio::test]
async fn unavailable_strict_confinement_never_falls_back_to_host_execution() {
	let fixture = Fixture::new().await;
	if omp_envd::verification::strict_sandbox_available(&fixture.root).expect("sandbox probe") {
		eprintln!("strict confinement is available: unsupported-host branch does not apply");
		return;
	}
	let (_, mut session) = fixture.session();
	assert_not_pass(fixture.run(&mut session, &CancellationToken::new()).await);
	assert!(evidence_publications(&session).unwrap().is_empty());
}

#[tokio::test]
async fn supported_host_runs_exact_tests_retains_receipts_and_rejects_bad_inputs() {
	let fixture = Fixture::new().await;
	if !omp_envd::verification::strict_sandbox_available(&fixture.root).expect("sandbox probe") {
		eprintln!(
			"SKIPPED supported-host execution proof: verified Bubblewrap closed-input profile \
			 unavailable"
		);
		return;
	}
	let cancel = CancellationToken::new();
	let (journal, mut session) = fixture.session();
	let report = fixture
		.run(&mut session, &cancel)
		.await
		.expect("supported native verification executes");
	if report.verdict != GateVerdict::Pass {
		for publication in &report.publications {
			let record = load_evidence(&session, *publication).unwrap();
			eprintln!("native check {}: {:?}", record.check, record.outcome);
			for artifact in record.artifacts.iter() {
				if matches!(artifact.name.as_str(), "stdout" | "stderr") {
					let bytes = session.blobs().get(&artifact.blob).unwrap();
					eprintln!("{}: {}", artifact.name, String::from_utf8_lossy(&bytes));
				}
			}
		}
	}
	assert_eq!(report.verdict, GateVerdict::Pass, "{}", report.feedback);
	let publications = evidence_publications(&session).unwrap();
	assert_eq!(publications.len(), 4, "A1, C1, doctests and final input fence");
	for publication in &publications {
		let record = load_evidence(&session, *publication).expect("complete evidence closure");
		assert_eq!(record.outcome, omp_driver::verification::CheckOutcome::Passed);
	}
	drop(session);
	let reopened = Session::open(&journal, ComponentRegistry::default()).expect("journal replays");
	assert_eq!(evidence_publications(&reopened).unwrap(), publications);
	for publication in publications {
		load_evidence(&reopened, publication).unwrap();
	}
	drop(reopened);

	fs::write(fixture.root.join("src/lib.rs"), "pub fn broken() { definitely_missing(); }\n")
		.unwrap();
	let (_, mut session) = fixture.session();
	let report = fixture
		.run(&mut session, &cancel)
		.await
		.expect("compiler failure is observed");
	assert_eq!(report.verdict, GateVerdict::Fail);
	drop(session);

	fs::write(fixture.root.join("src/lib.rs"), "#[test] fn regression() { assert_eq!(1, 2); }\n")
		.unwrap();
	let (_, mut session) = fixture.session();
	let report = fixture
		.run(&mut session, &cancel)
		.await
		.expect("test failure is observed");
	assert_eq!(report.verdict, GateVerdict::Fail);
	drop(session);

	fs::write(fixture.root.join("src/lib.rs"), "pub fn answer() -> u32 { 42 }\n").unwrap();
	let (_, mut session) = fixture.session();
	assert_not_pass(fixture.run(&mut session, &cancel).await);
	drop(session);

	// Nextest's ignored-test wire sequence is not admitted by this first
	// profile. Refuse it rather than counting an ignored helper as coverage.
	fs::write(
		fixture.root.join("src/lib.rs"),
		format!(
			"{PASSING_SOURCE}\n#[test] #[ignore = \"unsupported reporter shape\"] fn ignored_case() \
			 {{ panic!(\"ignored\"); }}\n"
		),
	)
	.unwrap();
	let (_, mut session) = fixture.session();
	assert_not_pass(fixture.run(&mut session, &cancel).await);
	drop(session);

	fs::write(fixture.root.join("src/lib.rs"), PASSING_SOURCE).unwrap();
	fs::write(
		fixture.root.join("justfile"),
		"check-pkg pkg:\n    echo PASS\ntest-pkg pkg:\n    echo PASS\n",
	)
	.unwrap();
	let (_, mut session) = fixture.session();
	assert_not_pass(fixture.run(&mut session, &cancel).await);
}

#[tokio::test]
async fn supported_host_refuses_current_source_drift_after_frozen_test_started() {
	let fixture = Fixture::new().await;
	if !omp_envd::verification::strict_sandbox_available(&fixture.root).expect("sandbox probe") {
		eprintln!(
			"SKIPPED current-source drift proof: verified Bubblewrap closed-input profile unavailable"
		);
		return;
	}
	// The checked test writes only into its admitted output directory. Seeing
	// this marker proves that the frozen source passed A1 and reached C1
	// execution before the host edits the original source revision.
	let source = r#"
#[test]
fn holds_verification_window() {
    let target = std::path::PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap());
    std::fs::write(target.join("verification-started"), b"started").unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));
}
"#;
	fs::write(fixture.root.join("src/lib.rs"), source).unwrap();
	let (_, mut session) = fixture.session();
	let cancel = CancellationToken::new();
	let run = fixture.run(&mut session, &cancel);
	tokio::pin!(run);
	let marker = async {
		loop {
			let leases = fs::read_dir(fixture.state.join("environment/materializations"))
				.expect("native materialization directory");
			if leases.filter_map(Result::ok).any(|lease| {
				lease
					.path()
					.join("out/target/verification-started")
					.is_file()
			}) {
				break;
			}
			sleep(Duration::from_millis(20)).await;
		}
	};
	tokio::select! {
		result = &mut run => panic!("verification ended before the frozen test marker: {result:?}"),
		result = timeout(Duration::from_secs(180), marker) => {
			if result.is_err() {
				cancel.cancel();
				let _ = timeout(Duration::from_secs(10), &mut run).await;
				panic!("frozen test did not start within bounded admission and compilation window");
			}
		}
	}
	let changed = format!("{source}\n// host edit after the frozen test started\n");
	fs::write(fixture.root.join("src/lib.rs"), &changed).unwrap();
	assert_not_pass(run.await);
	assert_eq!(std::fs::read_to_string(fixture.root.join("src/lib.rs")).unwrap(), changed);
}
