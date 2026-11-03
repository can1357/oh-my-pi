//! Acceptance: the skeleton scripts behave like bash 5.3, and the fault
//! injector (pause/resume, externalize → drop → restore at every k-th
//! safepoint, k ∈ {1, 7, 97}) leaves output, status and events unchanged.

use std::{fs, path::PathBuf, sync::Arc};

use bstr::BString;

use crate::{
	bash::{CallOutcome, IoPoll, Script, ShellApi},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init, run_script},
};

const ARGS: [&str; 3] = ["a", "b c", "d"];

struct Case {
	name:   String,
	src:    Vec<u8>,
	out:    Vec<u8>,
	err:    Vec<u8>,
	status: i32,
}

fn cases() -> Vec<Case> {
	let dir = super::fixtures("skeleton");
	let mut names: Vec<PathBuf> = fs::read_dir(&dir)
		.unwrap()
		.map(|e| e.unwrap().path())
		.filter(|p| p.extension().is_some_and(|e| e == "sh"))
		.collect();
	names.sort();
	names
		.into_iter()
		.map(|p| {
			let read = |ext: &str| fs::read(p.with_extension(ext)).unwrap();
			Case {
				name:   p.file_stem().unwrap().to_string_lossy().into_owned(),
				src:    fs::read(&p).unwrap(),
				out:    read("out"),
				err:    read("err"),
				status: String::from_utf8(read("status"))
					.unwrap()
					.trim()
					.parse()
					.unwrap(),
			}
		})
		.collect()
}

#[test]
fn skeleton_has_fifty_scripts() {
	assert!(cases().len() >= 50, "acceptance runs the injector over 50 skeleton scripts");
}

#[test]
fn skeleton_matches_bash_5_3() {
	let mut failures = Vec::new();
	for c in cases() {
		let o = run_script(FakeHost::new(), &c.src, &ARGS, Fault::None);
		if (o.stdout.as_slice(), o.stderr.as_slice(), o.status)
			!= (c.out.as_slice(), c.err.as_slice(), c.status)
		{
			failures.push(format!(
				"{}: status {} (bash {})\n--- stdout\n{}--- bash\n{}--- stderr\n{}--- bash\n{}",
				c.name,
				o.status,
				c.status,
				String::from_utf8_lossy(&o.stdout),
				String::from_utf8_lossy(&c.out),
				String::from_utf8_lossy(&o.stderr),
				String::from_utf8_lossy(&c.err),
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} scripts differ from bash 5.3:\n{}",
		failures.len(),
		failures.join("\n")
	);
}

fn injector(fault: Fault) {
	let mut failures = Vec::new();
	let mut faults = 0;
	for c in cases() {
		let base = run_script(FakeHost::new(), &c.src, &ARGS, Fault::None);
		let hit = run_script(FakeHost::new(), &c.src, &ARGS, fault);
		faults += hit.snapshots + hit.pauses;
		for (what, same) in [
			("stdout", base.stdout == hit.stdout),
			("stderr", base.stderr == hit.stderr),
			("status", base.status == hit.status),
			("events", base.events == hit.events),
		] {
			if !same {
				failures.push(format!("{}: {what} differs under {fault:?}", c.name));
			}
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
	assert!(faults > 0, "{fault:?} injected nothing");
}

#[test]
fn fault_pause_resume_k1() {
	injector(Fault::PauseResume { every: 1 });
}

#[test]
fn fault_pause_resume_k7() {
	injector(Fault::PauseResume { every: 7 });
}

#[test]
fn fault_pause_resume_k97() {
	injector(Fault::PauseResume { every: 97 });
}

#[test]
fn fault_snapshot_k1() {
	injector(Fault::Snapshot { every: 1 });
}

#[test]
fn fault_snapshot_k7() {
	injector(Fault::Snapshot { every: 7 });
}

#[test]
fn fault_snapshot_k97() {
	injector(Fault::Snapshot { every: 97 });
}

#[test]
fn fault_mixed_seeded() {
	injector(Fault::Mixed { every: 3, seed: 0x5eed });
}

/// Pause/resume with p = 1/50 at every safepoint.
#[test]
fn fault_random_pause_one_in_50() {
	injector(Fault::RandomPause { one_in: 50, seed: 1 });
}

/// Dense random pauses (p = 1/2) land between almost every pair of ops.
#[test]
fn fault_random_pause_one_in_2() {
	injector(Fault::RandomPause { one_in: 2, seed: 0x5eed });
}

/// With every fs operation `Pending`, PATH search parks the vproc
/// instead of blocking, and the result is the same.
#[test]
fn fault_every_fs_op_pending_gives_the_same_result() {
	let src = b"nosuch_a x\necho s=$?\nfor i in 1 2; do nosuch_$i; done\n";
	let base = run_script(FakeHost::new(), src, &[], Fault::None);
	let fs = MemFs::with_latency(11, 1.0, 2);
	fs.add_dir("/usr/bin");
	fs.add_dir("/bin");
	let probe = fs.clone();
	let slow = run_script(FakeHost::new().with_fs(fs), src, &[], Fault::None);
	assert_eq!(
		(slow.stdout, slow.stderr, slow.status),
		(base.stdout.clone(), base.stderr.clone(), base.status)
	);
	assert!(
		probe.pending_count() >= 6,
		"every stat was answered Pending ({})",
		probe.pending_count()
	);
	assert_eq!(base.stdout, b"s=127\n");
}

/// A suspend while a PATH probe is pending drops it (idempotent) and the
/// restored shell re-issues it.
#[test]
fn fault_snapshot_during_pending_fs_reissues_the_probe() {
	let src = b"nosuch_a\nnosuch_b\necho done\n";
	let fs = MemFs::with_latency(3, 1.0, 1);
	let hit = run_script(FakeHost::new().with_fs(fs), src, &[], Fault::Snapshot { every: 1 });
	assert_eq!(hit.stdout, b"done\n");
	assert_eq!(
		hit.stderr,
		b"bash: line 1: nosuch_a: command not found\nbash: line 2: nosuch_b: command not found\n"
	);
	assert_eq!(hit.status, 0);
}

/// Partial and `Pending` writes resume where they stopped, also across
/// snapshots.
#[test]
fn fault_write_storm_keeps_output_exact() {
	for c in cases() {
		let base = run_script(FakeHost::new(), &c.src, &ARGS, Fault::None);
		let storm =
			run_script(FakeHost::new().with_write_storm(9, 0.5), &c.src, &ARGS, Fault::Snapshot {
				every: 5,
			});
		assert_eq!(
			(&storm.stdout, &storm.stderr, storm.status),
			(&base.stdout, &base.stderr, base.status),
			"{}",
			c.name
		);
	}
}

fn rig_with_callouts() -> Rig {
	let mut host = FakeHost::new();
	host.tool(
		"greet",
		Arc::new(|api: &mut ShellApi<'_, '_>, argv: &[BString]| {
			let msg = format!("hi {}\n", String::from_utf8_lossy(&argv[1]));
			match api.write(1, msg.as_bytes()) {
				IoPoll::Ready(Ok(n)) if n == msg.len() => CallOutcome::Exit(0),
				_ => CallOutcome::Error("short write".into()),
			}
		}),
	);
	host.tool(
		"fail",
		Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Error("boom".into())),
	);
	host.countdown("slow", 25, 3);
	Rig::new(host, skeleton_init(&[]))
}

#[test]
fn fault_callouts_and_tasks_survive_snapshots() {
	let src = b"for i in 1 2; do greet $i; slow; echo s=$?; done\nfail\necho s=$?\n";
	let mut base = rig_with_callouts();
	let base_status = base.run(Script::command(&src[..]), Fault::None);
	let mut hit = rig_with_callouts();
	let hit_status = hit.run(Script::command(&src[..]), Fault::Snapshot { every: 2 });
	assert_eq!(base.host.stdout.bytes(), b"hi 1\ns=3\nhi 2\ns=3\ns=1\n");
	assert_eq!(base.host.stderr.bytes(), b"bash: line 2: fail: boom\n");
	assert_eq!(
		(hit.host.stdout.bytes(), hit.host.stderr.bytes(), hit_status),
		(base.host.stdout.bytes(), base.host.stderr.bytes(), base_status)
	);
	assert!(hit.snapshots > 10, "snapshots landed while the task was pending ({})", hit.snapshots);
}

/// "command not found" goes to the command's own redirected stderr, as in
/// bash, where the redirections are in place before the search fails.
#[test]
fn command_not_found_honours_the_commands_redirections() {
	let src = b"x=$(nosuch 2>&1); echo \"[$x]\"; nosuch 2>&-; echo $?\n";
	let out = run_script(FakeHost::new(), src, &[], Fault::None);
	assert_eq!(out.stdout, b"[bash: line 1: nosuch: command not found]\n127\n");
	assert_eq!(out.stderr, b"");
}

/// A function defined before a snapshot keeps its line numbers afterwards:
/// externalize stores function bodies by id, so the restored shell does not
/// recompile them from their canonical text (dbg-support2 and test.tests
/// under the fault injector).
#[test]
fn functions_keep_line_numbers_across_restore() {
	let src = b"\n\nf() {\n\techo $LINENO\n\ttest 4+3 -eq 7\n}\nf\nf\n";
	let base = run_script(FakeHost::new(), src, &[], Fault::None);
	assert_eq!(base.stdout, b"4\n4\n");
	assert_eq!(
		base.stderr,
		b"bash: line 5: test: 4+3: integer expected\nbash: line 5: test: 4+3: integer expected\n"
	);
	let hit = run_script(FakeHost::new(), src, &[], Fault::Snapshot { every: 1 });
	assert_eq!((hit.stdout, hit.stderr, hit.status), (base.stdout, base.stderr, base.status));
}

/// A command substitution inside arithmetic runs from a run-time compiled
/// text unit; a snapshot while it runs must restore that unit (its block
/// jump needs a target past the body).
#[test]
fn comsub_in_arithmetic_survives_restore() {
	let src = b"echo $(( $(echo 1) + 1 ))\nfor ((i=0; i < $(echo 2); i++)); do echo $i; done\n";
	let base = run_script(FakeHost::new(), src, &[], Fault::None);
	assert_eq!(base.stdout, b"2\n0\n1\n");
	let hit = run_script(FakeHost::new(), src, &[], Fault::Snapshot { every: 1 });
	assert_eq!((hit.stdout, hit.stderr, hit.status), (base.stdout, base.stderr, base.status));
}

/// Pause/resume requests are not wake-ups: a vproc waiting on a task keeps
/// waiting through them and finishes exactly as in a plain run.
#[test]
fn pause_resume_while_a_task_finishes_changes_nothing() {
	let src = b"slow; echo s=$?\nslow & wait; echo w=$?\n";
	let mut base = rig_with_callouts();
	let base_status = base.run(Script::command(&src[..]), Fault::None);
	let mut hit = rig_with_callouts();
	let hit_status = hit.run(Script::command(&src[..]), Fault::PauseResume { every: 1 });
	assert_eq!(base.host.stdout.bytes(), b"s=3\nw=0\n");
	assert_eq!(
		(hit.host.stdout.bytes(), hit.host.stderr.bytes(), hit_status),
		(base.host.stdout.bytes(), base.host.stderr.bytes(), base_status)
	);
	assert!(hit.pauses > 0, "pauses landed while the task ran ({})", hit.pauses);
}
