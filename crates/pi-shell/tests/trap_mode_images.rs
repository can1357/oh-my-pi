//! Real images captured inside WINCH and after a CHLD action returns.
//! The same executable writes and reads them at different revisions; neither
//! the image bytes nor its identity checks are patched by the reader.
#![cfg(unix)]

use bstr::BStr;
use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, Shell, ShellInit, SigSet,
		Step,
		store::{Key, Record, Var, VarValue},
	},
	process::{NativeHost, no_callouts, wait_runnable},
	sys::Parker,
};

#[test]
fn an_image_carries_the_running_signal_mode_without_new_wire_fields() {
	let engine = Engine::new(EngineConfig::default());
	let root = pi_shell::bash::Vpid(EngineConfig::default().vpid_base);
	let mut host = NativeHost::new(None, false, Vec::new(), SigSet::EMPTY, 0, true);
	let mut parker = Parker::new();
	let window = std::env::var("TRAP_MODE_SCENARIO").as_deref() == Ok("return-window");
	let image = std::env::var_os("TRAP_MODE_IMAGE");
	let operation = std::env::var("TRAP_MODE_IMAGE_OPERATION").unwrap_or_default();
	let mut store = if operation == "read" {
		MemStore::from_bytes(&std::fs::read(image.as_ref().unwrap()).unwrap()).unwrap()
	} else {
		MemStore::new()
	};
	let mut shell = if operation == "read" {
		let (shell, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.unwrap();
		assert!(report.lost.is_empty() && report.abandoned.is_empty(), "{report:?}");
		shell
	} else {
		let mut shell = Shell::create(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			ShellInit::default(),
		)
		.unwrap();
		let script: &[u8] = if window {
			b"n=0; f() { trap 'n=$((n+1)); return 23' CHLD; /bin/true; }; f; marker=ready; /bin/true; observed=$n"
		} else {
			b"n=0; trap 'n=$((n+1)); marker=ready; if [ $n -lt 3 ]; then kill -WINCH $BASHPID; fi' WINCH; kill -WINCH $BASHPID; observed=$n"
		};
		shell.submit(Script::command(script));
		let one = Budget { max_ops: 1, max_ns: u64::MAX };
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, one) {
				Step::Yield => parker.poll_exits(),
				Step::Blocked | Step::Paused => wait_runnable(&mut parker, &shell, root),
				Step::Call { id, .. } => no_callouts(&mut shell, id),
				other => panic!("never reached checkpoint: {other:?}"),
			}
			if store.record(Key::Var(BStr::new("marker"))).is_some() {
				break;
			}
		}
		assert!(store.record(Key::Var(BStr::new("marker"))).is_some(), "never entered action");
		let report = shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.unwrap();
		assert!(report.lost.is_empty(), "{report:?}");
		let bytes = store.to_bytes();
		if operation == "write" {
			std::fs::write(image.as_ref().unwrap(), bytes).unwrap();
			println!(
				"wrote image at {}",
				if window {
					"CHLD return window"
				} else {
					"first WINCH action"
				}
			);
			return;
		}
		drop(shell);
		store = MemStore::from_bytes(&bytes).unwrap();
		Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.unwrap()
		.0
	};
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { status, .. } => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Call { id, .. } => no_callouts(&mut shell, id),
			Step::Yield => parker.poll_exits(),
			Step::Blocked | Step::Paused => wait_runnable(&mut parker, &shell, root),
			other => panic!("unexpected checkpoint continuation: {other:?}"),
		}
	}
	assert!(done, "image never finished");
	let expected = std::env::var("TRAP_MODE_EXPECTED_COUNT")
		.unwrap_or_else(|_| if window { "2" } else { "1" }.to_owned());
	let observed = store.record(Key::Var(BStr::new("observed")));
	println!("observed action count: {observed:?}");
	assert!(
		matches!(observed, Some(Record::Var(Var { value: VarValue::Str(n), .. })) if n == expected.as_bytes())
	);
}
