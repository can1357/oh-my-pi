//! Genuine upstream pairs are selected by stored identity, never rewritten.
#![cfg(unix)]

mod upstream_frames_support;

use pi_shell::{
	bash::{
		Cx, Engine, EngineConfig, Incompatibility, RestoreError, RestoreOpts, RestoreReport, Shell,
	},
	testkit::FakeHost,
};
use upstream_frames_support::Identity;

fn restores_genuine_upstream(parent_wait: bool, runs: u32) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = upstream_frames_support::store(parent_wait, Identity::Same);
	let (_, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("genuine upstream execution must survive");
	println!("genuine_upstream={report:?}");
	assert_eq!(report, RestoreReport { vprocs: 2, runs, ..RestoreReport::default() });
}

#[test]
fn upstream_active_child_with_parent_wait_restores_without_loss() {
	restores_genuine_upstream(true, 1);
}

#[test]
fn upstream_active_child_without_parent_wait_restores_without_loss() {
	restores_genuine_upstream(false, 0);
}

#[test]
fn genuine_foreign_identity_is_refused_without_rewriting_any_fixture_bytes() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = upstream_frames_support::store(true, Identity::Different);
	let before = store.to_bytes();
	let error = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err()
	.expect("a foreign identity must return no shell");
	assert!(matches!(error, RestoreError::Incompatible { why: Incompatibility::Build }));
	assert_eq!(store.to_bytes(), before);
}
