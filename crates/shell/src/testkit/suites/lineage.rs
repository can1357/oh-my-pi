//! Host lineage of the subshells a callout starts
//! (`ShellApi::run_subshell_in`): inherited by the whole tree and handed to
//! its externals, signalled as a group (`SigTarget::Label`), reached by
//! signals to the callout's caller, and, when detached, spared by cancel.

use std::sync::Arc;

use bstr::BString;
use parking_lot::Mutex;

use crate::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Lineage, RunId, Script, Shell, ShellApi, SigTarget, Signal,
		SpawnSpec, Step,
	},
	testkit::{FakeHost, Rig, fault::skeleton_init, run::wait_runnable},
};

const LABEL: u32 = 5;

/// A rig whose `wrap` callout runs its operands (`"$@"`) in a subshell with
/// `lineage`, and whose spawner records what each external was spawned with
/// (then fails it: 127, nothing runs).
fn rig(spawns: &Arc<Mutex<Vec<(BString, Lineage)>>>) -> Rig {
	let seen = Arc::clone(spawns);
	let mut host = FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| {
		seen.lock().push((spec.argv[0].clone(), spec.lineage));
		Err(std::io::ErrorKind::NotFound.into())
	}));
	host.tool(
		"wrap",
		Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| -> CallOutcome {
			unreachable!("the test driver answers `wrap`")
		}),
	);
	Rig::new(host, skeleton_init(&[]))
}

/// Runs `src` to completion, answering each `wrap` with its subshell's
/// status; `on_yield` sees the shell at every budget yield (count from 1).
fn drive(
	r: &mut Rig,
	src: &str,
	lineage: Lineage,
	mut on_yield: impl FnMut(&mut Shell, u32),
) -> i32 {
	let (shell, host, store) = r.parts();
	let main = shell.submit(Script::command(src.as_bytes().to_vec()));
	let mut pending: Vec<(CallId, RunId)> = Vec::new();
	let mut yields = 0;
	let budget = Budget { max_ops: 200, max_ns: u64::MAX };
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, budget) {
			Step::Done { run, status } if run == main => return status,
			Step::Done { run, status } => {
				if let Some(at) = pending.iter().position(|&(_, r)| r == run) {
					let (id, _) = pending.remove(at);
					shell.complete(id, CallOutcome::Exit(status));
				}
			},
			Step::Call { id, call } => {
				let mut cx = Cx { host: &mut *host, store: &mut *store };
				let mut api = shell.api(&mut cx, id).expect("call is outstanding");
				let mut script = Script::command(&b"\"$@\""[..]);
				script.args = Some(call.argv[1..].to_vec());
				pending.push((id, api.run_subshell_in(script, lineage)));
			},
			Step::Yield => {
				yields += 1;
				assert!(yields < 10_000, "`{src}` never finished");
				on_yield(shell, yields);
			},
			Step::Blocked => {
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
			},
			other => panic!("{other:?} while `{src}` runs"),
		}
	}
}

const LABELED: Lineage = Lineage { label: LABEL, detached: false };

#[test]
fn the_whole_subshell_tree_and_its_externals_carry_the_lineage() {
	let spawns = Arc::default();
	let mut r = rig(&spawns);
	let src = "/fake/plain; wrap /fake/direct; wrap sh -c '/fake/nested | /fake/stage; (/fake/sub)'";
	drive(&mut r, src, LABELED, |_, _| {});
	let mut seen = spawns.lock().clone();
	seen.sort_by(|a, b| a.0.cmp(&b.0));
	let none = Lineage::default();
	assert_eq!(seen, [
		(BString::from("/fake/direct"), LABELED),
		(BString::from("/fake/nested"), LABELED),
		(BString::from("/fake/plain"), none),
		(BString::from("/fake/stage"), LABELED),
		(BString::from("/fake/sub"), LABELED),
	]);
}

#[test]
fn a_label_signal_ends_the_tree_and_spares_the_caller() {
	let mut r = rig(&Arc::default());
	let src = "wrap sh -c 'while :; do :; done'; echo st=$?";
	let status = drive(&mut r, src, LABELED, |shell, n| {
		if n == 5 {
			assert!(shell.label_live(LABEL));
			shell
				.control()
				.signal(SigTarget::Label(LABEL), Signal::Term);
		}
	});
	assert_eq!(status, 0);
	assert_eq!(r.host.stdout.bytes(), b"st=143\n");
	assert!(!r.shell().label_live(LABEL));
}

/// `kill $!` of a backgrounded callout reaches the tree it started, as a
/// signal to `nohup` reaches the program it `exec`s.
#[test]
fn a_signal_to_the_caller_reaches_its_tree() {
	let mut r = rig(&Arc::default());
	// The busy loop lets the job reach its callout before the `kill`.
	let src = "wrap sh -c 'while :; do :; done' & pid=$!
		i=0; while [ $i -lt 2000 ]; do i=$((i + 1)); done
		kill $pid; wait $pid; echo st=$?";
	drive(&mut r, src, LABELED, |_, _| {});
	assert_eq!(r.host.stdout.bytes(), b"st=143\n");
	assert!(!r.shell().label_live(LABEL));
}

/// Cancel ends everything but a detached tree, which runs on.
#[test]
fn cancel_spares_a_detached_tree() {
	let mut r = rig(&Arc::default());
	let detached = Lineage { label: LABEL, detached: true };
	let status = drive(&mut r, "wrap sh -c 'while :; do :; done'", detached, |shell, n| {
		if n == 5 {
			shell.control().cancel(Signal::Term);
		}
	});
	assert_eq!(status, 143);
	assert!(r.shell().label_live(LABEL), "the detached tree outlived the cancel");
	r.shell()
		.control()
		.signal(SigTarget::Label(LABEL), Signal::Kill);
	let (shell, host, store) = r.parts();
	while shell.label_live(LABEL) {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Done { .. } | Step::Yield => {},
			other => panic!("{other:?} while the detached tree ends"),
		}
	}
}
