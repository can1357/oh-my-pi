//! Foreign suspended images must be refused before their execution frames are
//! decoded. The fixtures are real `MemStore::to_bytes()` exports from upstream
//! 0edd6aab170606b90af348379386c4de10157b30 (frames version 30), suspended
//! during `set -C; echo hi OP/new; echo after` for each redirection spelling.
//!
//! To exercise both directions against another checkout, run the same-build
//! controls there with `PI_SHELL_FRAMES_EXPORT_DIR` set to an empty directory,
//! then run this checkout's cross-build tests with `PI_SHELL_FRAMES_FIXTURE_DIR`
//! pointing to those exports. Swap the checkouts and repeat. No header or body
//! bytes are edited; the exporter uses the same public APIs as the restore.

use std::path::PathBuf;

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
		RunId, Script, Shell, Step,
	},
	testkit::{
		FakeHost, MemFs,
		fault::skeleton_init,
		run::{Stop, advance, advance_or_blocked},
	},
};

const BUDGET: Budget = Budget { max_ops: 10_000, max_ns: u64::MAX };

fn suspended_image(op: &str) -> (Vec<u8>, RunId) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new().with_fs(MemFs::with_latency(5, 1.0, 30_000));
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let script = format!("set -C; echo hi {op}/new; echo after");
	let run = shell.submit(Script::command(script.as_bytes()));
	assert_eq!(
		advance_or_blocked(&mut shell, &mut host, &mut store, run, BUDGET),
		Stop::Blocked,
		"{op}: snapshot must land during the pending open"
	);
	assert!(host.stdout.bytes().is_empty());
	shell.control().request_suspend();
	for _ in 0..1_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::SuspendReady => {
				shell
					.externalize(&mut Cx { host: &mut host, store: &mut store })
					.unwrap();
				return (store.to_bytes(), run);
			},
			Step::Blocked | Step::Yield => {},
			other => panic!("{op}: expected a suspended open, got {other:?}"),
		}
	}
	panic!("{op}: suspend did not reach a safepoint");
}

fn same_build(op: &str, name: &str) {
	let (bytes, run) = suspended_image(op);
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(&bytes).unwrap();
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert_eq!(advance(&mut shell, &mut host, &mut store, run, BUDGET), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"after\n");
	assert!(host.stderr.bytes().is_empty());

	if let Some(directory) = std::env::var_os("PI_SHELL_FRAMES_EXPORT_DIR") {
		std::fs::write(PathBuf::from(directory).join(name), bytes).unwrap();
	}
}

fn cross_build(name: &str) {
	let directory = std::env::var_os("PI_SHELL_FRAMES_FIXTURE_DIR")
		.map(PathBuf::from)
		.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/frames-v30"));
	let bytes = std::fs::read(directory.join(name)).unwrap();
	let mut store = MemStore::from_bytes(&bytes).unwrap();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let error = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	assert!(
		matches!(error, Some(RestoreError::Incompatible { why: Incompatibility::Build })),
		"{name}: a valid image from the other layout must be incompatible, got {error:?}"
	);
	println!("{name}: {error:?}");
}

#[test]
fn cross_build_output_image_is_incompatible_not_corrupt() {
	cross_build("out.store");
}

#[test]
fn cross_build_ampersand_output_image_is_incompatible_not_corrupt() {
	cross_build("ampout.store");
}

#[test]
fn cross_build_output_ampersand_image_is_incompatible_not_corrupt() {
	cross_build("outamp.store");
}

#[test]
fn same_build_output_image_resumes() {
	same_build(">", "out.store");
}

#[test]
fn same_build_ampersand_output_image_resumes() {
	same_build("&>", "ampout.store");
}

#[test]
fn same_build_output_ampersand_image_resumes() {
	same_build(">&", "outamp.store");
}
