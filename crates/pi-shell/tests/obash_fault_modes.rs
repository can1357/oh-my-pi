//! obash's fault modes: `pause` and `exec` leave output and
//! status unchanged, `exec` restores in a new process image with the
//! signal state intact, and the Lost policies and counters behave as
//! documented in `src/fault.rs`.
#![cfg(unix)]

mod obash_support;

use std::{collections::HashMap, fs, path::Path, process::Output};

use pi_shell::testkit::golden;

use crate::obash_support::open_fds;

/// Run `program args` with `env` hermetically and bounded
/// ([`obash_support::command`]): the output and its pid.
fn bounded(program: &str, args: &[&str], env: &[(&str, &str)]) -> (Output, u32) {
	obash_support::run(
		obash_support::command(program)
			.args(args)
			.envs(env.iter().copied()),
	)
}

fn obash(args: &[&str], env: &[(&str, &str)]) -> (Output, u32) {
	bounded(env!("CARGO_BIN_EXE_obash"), args, env)
}

/// The `key=value` fields of every stats line.
fn stats(path: &Path) -> Vec<HashMap<String, String>> {
	fs::read_to_string(path)
		.unwrap_or_default()
		.lines()
		.map(|line| {
			line
				.split(' ')
				.filter_map(|kv| kv.split_once('='))
				.map(|(k, v)| (k.to_owned(), v.to_owned()))
				.collect()
		})
		.collect()
}

fn num(fields: &HashMap<String, String>, key: &str) -> u64 {
	fields[key].parse().unwrap()
}

/// Run `script` plainly and under `fault`/`mode` (plus `env`); assert both
/// give the same stdout, stderr and status; the faulted run's stats line
/// (exactly one: an `exec` successor keeps the pid).
fn same_as_plain(
	script: &str,
	fault: &str,
	mode: &str,
	env: &[(&str, &str)],
) -> (Output, HashMap<String, String>) {
	let dir = tempfile::tempdir().unwrap();
	let stats_path = dir.path().join("stats");
	let (plain, _) = obash(&["-c", script], &[]);
	let fault = format!("--fault={fault}");
	let mode = format!("--fault-mode={mode}");
	let mut env = env.to_vec();
	let stats_text = stats_path.to_str().unwrap();
	env.push(("PI_SHELL_FAULT_STATS", stats_text));
	let (hit, pid) = obash(&[&fault, &mode, "-c", script], &env);
	assert_eq!(
		(
			String::from_utf8_lossy(&hit.stdout),
			String::from_utf8_lossy(&hit.stderr),
			hit.status.code()
		),
		(
			String::from_utf8_lossy(&plain.stdout),
			String::from_utf8_lossy(&plain.stderr),
			plain.status.code()
		),
		"{mode} {fault} differs from the plain run"
	);
	let mut lines = stats(&stats_path);
	assert_eq!(lines.len(), 1, "one stats line per process: {lines:?}");
	let line = lines.remove(0);
	assert_eq!(num(&line, "pid"), u64::from(pid), "the successor keeps the pid");
	(plain, line)
}

const LOOPS: &str = "f() { local i; for i in 1 2 3; do echo \"$1 $i\"; done; }; f a; f b; x=$((6 \
                     * 7)); echo $x; p=$$; i=0; while [ $i -lt 30 ]; do i=$((i + 1)); done; [ \
                     \"$p\" = \"$$\" ] && echo same-pid; echo end $i";

#[test]
fn exec_mode_restores_in_a_new_process_like_the_plain_run() {
	let (plain, line) = same_as_plain(LOOPS, "1:3", "exec", &[]);
	assert!(String::from_utf8_lossy(&plain.stdout).ends_with("same-pid\nend 30\n"));
	assert_eq!(line["mode"], "exec");
	assert!(num(&line, "restored") > 0, "{line:?}");
	assert_eq!(num(&line, "restored"), num(&line, "snapshots"), "{line:?}");
	assert_eq!(num(&line, "skipped"), 0, "{line:?}");
}

/// Every node event of an `exec`-mode run names a unit announced before it
/// since the last `Restored`: each successor process announces again the
/// units it can still run (function bodies, the frames' units), as a host
/// in a new process needs them.
#[test]
fn exec_mode_events_name_only_announced_units() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("events.jsonl");
	let sink = format!("--events-out={}", path.display());
	let script = "f() { local i; for i in 1 2 3; do echo \"$1 $i\"; done; }; f a; eval 'g() { f g; \
	              }'; g; i=0; while [ $i -lt 30 ]; do i=$((i + 1)); done; f end";
	let args = ["--events=jsonl", &sink, "--fault=1:3", "--fault-mode=exec", "-c", script];
	let (out, _) = obash(&args, &[]);
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert!(String::from_utf8_lossy(&out.stdout).ends_with("end 3\n"));
	let events = golden::parse_jsonl(&fs::read_to_string(&path).unwrap()).unwrap();
	assert!(events.iter().any(|e| e["kind"] == "Restored"), "no successor process");
	let (missing, nodes) = golden::unannounced(&events);
	assert!(nodes > 20, "{nodes} node events");
	assert!(missing.is_empty(), "unannounced units in {missing:#?}");
}

/// What a failed fd test needs to say: the descriptors obash passes to an
/// external (its host fds and stdio), the losses a snapshot of `script`
/// reports, and this test process's own fds.
fn fd_report(script: &str) -> String {
	let (ls, _) = obash(&["-c", "/bin/ls -l /dev/fd/"], &[]);
	let dir = tempfile::tempdir().unwrap();
	let log = dir.path().join("lost.log");
	obash(&["-c", script], &[
		("PI_SHELL_FAULT", "3:1"),
		("PI_SHELL_FAULT_LOST", "restore"),
		("PI_SHELL_LOST_LOG", log.to_str().unwrap()),
	]);
	let lost = fs::read_to_string(&log).unwrap_or_default();
	let first: Vec<&str> = lost.lines().take(8).collect();
	format!(
		"fds an external of obash gets:\n{}\nlost (first 8):\n{}\ntest process fds: {:?}",
		String::from_utf8_lossy(&ls.stdout),
		first.join("\n"),
		open_fds()
	)
}

/// Started as a test runner starts it (stdin `/dev/null`, stdout and
/// stderr pipes, nothing else inherited), obash holds no host fd, so no
/// snapshot is skipped for one: every step snapshot is restored. A
/// descriptor a library loaded into obash opens before `main` (cango's
/// file-access tracer keeps its log at fd 256, close-on-exec) is obash's
/// own, not an inherited one.
#[test]
fn a_shell_started_with_only_stdio_restores_every_snapshot() {
	let dir = tempfile::tempdir().unwrap();
	let stats_path = dir.path().join("stats");
	let (out, _) = obash(&["-c", LOOPS], &[
		("PI_SHELL_FAULT", "3:1"),
		("PI_SHELL_FAULT_STATS", stats_path.to_str().unwrap()),
	]);
	assert!(String::from_utf8_lossy(&out.stdout).ends_with("same-pid\nend 30\n"));
	let lines = stats(&stats_path);
	assert_eq!(lines.len(), 1);
	assert!(num(&lines[0], "snapshots") > 0, "{lines:?}");
	let skipped_fd = num(&lines[0], "skipped_fd");
	assert!(skipped_fd == 0, "{lines:?}\n{}", fd_report(LOOPS));
	assert_eq!(num(&lines[0], "restored"), num(&lines[0], "snapshots"), "{lines:?}");
}

/// An fd obash does inherit (`obash … 7</dev/null`) belongs to the host and
/// no snapshot can carry it: every one is skipped as `skipped_fd`, and the
/// run is unchanged.
#[test]
fn an_inherited_fd_skips_every_snapshot() {
	let dir = tempfile::tempdir().unwrap();
	let stats_path = dir.path().join("stats");
	let wrap = "exec \"$0\" -c \"$1\" 7</dev/null";
	let (out, _) = bounded("/bin/sh", &["-c", wrap, env!("CARGO_BIN_EXE_obash"), LOOPS], &[
		("PI_SHELL_FAULT", "3:1"),
		("PI_SHELL_FAULT_STATS", stats_path.to_str().unwrap()),
	]);
	assert!(String::from_utf8_lossy(&out.stdout).ends_with("same-pid\nend 30\n"));
	let lines = stats(&stats_path);
	assert_eq!(lines.len(), 1);
	assert!(num(&lines[0], "snapshots") > 0, "{lines:?}");
	assert_eq!(num(&lines[0], "skipped_fd"), num(&lines[0], "snapshots"), "{lines:?}");
	assert_eq!(num(&lines[0], "restored"), 0, "{lines:?}");
}

#[test]
fn pause_mode_pauses_without_changing_anything() {
	let (_, line) = same_as_plain(LOOPS, "7:2", "pause", &[]);
	assert_eq!(line["mode"], "pause");
	assert!(num(&line, "pauses") > 0, "{line:?}");
	assert_eq!(num(&line, "snapshots"), 0, "{line:?}");
}

#[test]
fn step_mode_is_the_default_and_restores_in_process() {
	let dir = tempfile::tempdir().unwrap();
	let stats_path = dir.path().join("stats");
	let (plain, _) = obash(&["-c", LOOPS], &[]);
	let (hit, _) = obash(&["-c", LOOPS], &[
		("PI_SHELL_FAULT", "3:1"),
		("PI_SHELL_FAULT_STATS", stats_path.to_str().unwrap()),
	]);
	assert_eq!(
		(hit.stdout, hit.stderr, hit.status.code()),
		(plain.stdout, plain.stderr, plain.status.code())
	);
	let lines = stats(&stats_path);
	assert_eq!(lines.len(), 1);
	assert_eq!(lines[0]["mode"], "step");
	assert!(num(&lines[0], "restored") > 0 && num(&lines[0], "pauses") > 0, "{lines:?}");
}

/// A foreground external sends the shell a signal it traps, then the shell
/// prints: bash runs the trap before the next command.
const KILL_SELF: &str = "trap 'echo caught' USR1; i=0; while [ $i -lt 20 ]; do i=$((i + 1)); \
                         done; /bin/kill -USR1 $$; echo after $i";

/// Handlers do not survive `exec`: the restored process re-installs the
/// disposition of every trapped signal, or USR1 would kill it.
#[test]
fn a_trapped_signal_still_runs_its_trap_after_exec() {
	let (plain, _) = same_as_plain(KILL_SELF, "1:5", "exec", &[]);
	assert_eq!(plain.stdout, b"caught\nafter 20\n");
}

/// obash forwards caught OS signals to the engine between steps; the step
/// that reaps `/bin/kill` must not run `echo after` before the USR1 the
/// child sent is delivered (the exit hands it over first). Lost about one
/// run in 20 on Linux, plain and under `exec` faults alike.
#[test]
fn a_signal_from_a_reaped_child_is_trapped_before_the_next_command() {
	for i in 0..200 {
		let (out, _) = obash(&["-c", KILL_SELF], &[]);
		assert_eq!(
			(out.stdout.as_slice(), out.status.code()),
			(&b"caught\nafter 20\n"[..], Some(0)),
			"plain run {i}: stderr {}",
			String::from_utf8_lossy(&out.stderr)
		);
	}
	for i in 0..50 {
		let (out, _) = obash(&["--fault=1:5", "--fault-mode=exec", "-c", KILL_SELF], &[]);
		assert_eq!(
			(out.stdout.as_slice(), out.status.code()),
			(&b"caught\nafter 20\n"[..], Some(0)),
			"exec run {i}: stderr {}",
			String::from_utf8_lossy(&out.stderr)
		);
	}
}

/// `trap ''` ignores a signal at the OS level, which `exec` keeps; the
/// restored shell must still let `trap -` restore the default.
#[test]
fn an_ignore_set_by_trap_does_not_look_inherited_after_exec() {
	let script = "trap '' INT; i=0; while [ $i -lt 20 ]; do i=$((i + 1)); done; trap - INT; trap \
	              -p INT; echo done";
	let (plain, _) = same_as_plain(script, "1:5", "exec", &[]);
	assert_eq!(plain.stdout, b"done\n");
}

/// A signal ignored when the first process started stays ignored (and
/// untrappable) in every successor.
#[test]
fn a_signal_ignored_on_entry_stays_ignored_after_exec() {
	let script = "i=0; while [ $i -lt 20 ]; do i=$((i + 1)); done; trap - INT; trap 'echo no' INT; \
	              trap -p INT";
	let wrap = "trap '' INT; exec \"$@\"";
	let obash = env!("CARGO_BIN_EXE_obash");
	let (plain, _) = bounded("/bin/sh", &["-c", wrap, "_", obash, "-c", script], &[]);
	assert_eq!(plain.stdout, b"trap -- '' SIGINT\n");
	let (hit, _) = bounded(
		"/bin/sh",
		&["-c", wrap, "_", obash, "--fault=1:5", "--fault-mode=exec", "-c", script],
		&[],
	);
	assert_eq!((hit.stdout, hit.status.code()), (plain.stdout, plain.status.code()));
}

/// A script read from stdin continues at the right line in the successor
/// (the stdin offset is shared across `exec`, nothing read ahead is lost).
#[test]
fn a_script_on_stdin_continues_after_exec() {
	let dir = tempfile::tempdir().unwrap();
	let script = dir.path().join("script");
	fs::write(
		&script,
		"i=0\nwhile [ $i -lt 10 ]; do i=$((i + 1)); done\necho one $i\nread line\nthis line is \
		 data\necho \"got: $line\"\n",
	)
	.unwrap();
	let run = |args: &str| {
		let cmd = format!("exec \"$0\" {args} < \"$1\"");
		bounded("/bin/sh", &["-c", &cmd, env!("CARGO_BIN_EXE_obash"), script.to_str().unwrap()], &[])
	};
	let (plain, _) = run("");
	assert_eq!(plain.stdout, b"one 10\ngot: this line is data\n");
	let (hit, _) = run("--fault=1:3 --fault-mode=exec");
	assert_eq!(
		(hit.stdout, hit.stderr, hit.status.code()),
		(plain.stdout, plain.stderr, plain.status.code())
	);
}

/// A suspend used to drop a FIFO read in flight as if it were an
/// idempotent fs op: the reader closed, the writer died of SIGPIPE with
/// obash, or the re-issued read waited forever (source6.sub). Now the read
/// is reported lost and the snapshot skipped, in either mode.
#[test]
fn a_fifo_read_in_flight_survives_snapshots() {
	let dir = tempfile::tempdir().unwrap();
	let fifo = dir.path().join("fifo");
	let script = format!(
		"f='{}'; /bin/rm -f \"$f\"; mkfifo \"$f\"; echo 'echo four - OK' > \"$f\" & /bin/sleep 0.2; \
		 . \"$f\"; echo $?; i=0; while [ $i -lt 20 ]; do i=$((i + 1)); done; echo end $i",
		fifo.display()
	);
	for (fault, mode) in [("1:1", "step"), ("2:1", "exec"), ("3:5", "exec")] {
		let (plain, _) = same_as_plain(&script, fault, mode, &[]);
		assert_eq!(plain.stdout, b"four - OK\n0\nend 20\n");
	}
}

/// The main vproc's slice would run the whole loop before the background
/// job starts its external; `/bin/sh -c :` blocks it first, so the job's
/// `sleep` is in flight at every snapshot of the loop.
const EXTERNAL_IN_FLIGHT: &str = "/bin/sleep 0.3 & /bin/sh -c :; i=0; while [ $i -lt 100 ]; do \
                                  i=$((i + 1)); done; wait; echo done $i";

/// Under the default policy a snapshot that would lose the external in
/// flight is not restored; the run matches the plain one.
#[test]
fn snapshots_losing_an_external_are_skipped_by_default() {
	let (_, line) = same_as_plain(EXTERNAL_IN_FLIGHT, "1:7", "exec", &[]);
	assert!(num(&line, "skipped_ext") > 0, "{line:?}");
	assert_eq!(num(&line, "skipped"), num(&line, "skipped_ext"), "{line:?}");
	assert_eq!(num(&line, "lost"), 0, "{line:?}");
}

/// `PI_SHELL_FAULT_LOST=defer` keeps the shell while the external runs and
/// retries at every following safepoint: the snapshot is restored as soon
/// as the external is gone (here: after `wait`), and nothing is logged lost.
#[test]
fn the_defer_policy_restores_once_the_external_is_gone() {
	let script = format!("{EXTERNAL_IN_FLIGHT}; echo after; echo end");
	let dir = tempfile::tempdir().unwrap();
	let log = dir.path().join("lost.log");
	let env = [("PI_SHELL_FAULT_LOST", "defer"), ("PI_SHELL_LOST_LOG", log.to_str().unwrap())];
	let (plain, line) = same_as_plain(&script, "1:7", "exec", &env);
	assert_eq!(plain.stdout, b"done 100\nafter\nend\n");
	assert!(num(&line, "deferred") > 0, "{line:?}");
	assert_eq!(num(&line, "skipped"), num(&line, "deferred"), "{line:?}");
	assert_eq!(num(&line, "skipped_ext"), num(&line, "deferred"), "{line:?}");
	assert!(num(&line, "restored") > 0, "{line:?}");
	assert_eq!(num(&line, "snapshots"), num(&line, "restored") + num(&line, "skipped"), "{line:?}");
	assert_eq!(num(&line, "lost"), 0, "{line:?}");
	assert!(!log.exists(), "defer never restores a loss");
}

/// `PI_SHELL_FAULT_LOST=restore` restores anyway and logs the loss, which
/// makes the kit exclude the run.
#[test]
fn the_restore_policy_restores_and_logs_the_loss() {
	let dir = tempfile::tempdir().unwrap();
	let log = dir.path().join("lost.log");
	let stats_path = dir.path().join("stats");
	let (out, _) = obash(&["--fault=1:7", "--fault-mode=exec", "-c", EXTERNAL_IN_FLIGHT], &[
		("PI_SHELL_FAULT_LOST", "restore"),
		("PI_SHELL_LOST_LOG", log.to_str().unwrap()),
		("PI_SHELL_FAULT_STATS", stats_path.to_str().unwrap()),
	]);
	assert_eq!(out.stdout, b"done 100\n", "{}", String::from_utf8_lossy(&out.stderr));
	let logged = fs::read_to_string(&log).unwrap();
	assert!(logged.lines().any(|l| l.starts_with("lost Ext")), "{logged}");
	let lines = stats(&stats_path);
	assert_eq!(lines.len(), 1);
	assert!(num(&lines[0], "lost") > 0 && num(&lines[0], "skipped") == 0, "{lines:?}");
}

#[test]
fn an_unknown_fault_mode_fails_loudly() {
	let (out, _) =
		obash(&["-c", "echo hi"], &[("PI_SHELL_FAULT", "1:3"), ("PI_SHELL_FAULT_MODE", "bogus")]);
	assert_eq!(out.status.code(), Some(2));
	assert!(out.stdout.is_empty());
	assert!(
		String::from_utf8_lossy(&out.stderr).contains("PI_SHELL_FAULT_MODE: invalid value `bogus'"),
		"{}",
		String::from_utf8_lossy(&out.stderr)
	);
}
