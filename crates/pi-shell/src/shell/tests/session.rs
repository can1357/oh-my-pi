use super::*;

/// Brace expansion must not turn a large sequence into one literal word or
/// silently shorten a comma product. Goldens agree in Bash 5.2 and 5.3.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn brace_limit_preserves_complete_expansions() {
	let mut failures = Vec::new();
	for (command, expected) in [
		("echo {1..2000000} | wc -w", "2000000"),
		("a=( {1..1048577} ); echo ${#a[@]}", "1048577"),
		("for i in {1..3000000}; do :; done; echo \"i=$i\"", "i=3000000"),
		("a=( {x,{1..1024}}{1..1024} ); echo ${#a[@]}", "1049600"),
		// Refused only where the word runs.
		("if false; then echo {1..5000000}; fi; echo after", "after"),
		("f() { echo {1..5000000}; }; echo defined", "defined"),
	] {
		let (result, output) = run_command_capture_within(
			Duration::from_secs(120),
			command,
			None,
			None,
			CancelToken::default(),
		)
		.await
		.expect("large brace expansion must finish");
		if result.exit_code != Some(0) || output.trim() != expected {
			failures.push(format!(
				"{command:?}: status={:?}, output={output:?}, expected={expected:?}",
				result.exit_code
			));
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Refusing an expansion must stop the command, not execute its literal or
/// partially expanded arguments. Includes run-time compound-value parsing.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn brace_limit_reports_oversized_expansions() {
	let mut failures = Vec::new();
	for (command, status) in [
		("echo {1..5000000}", 2),
		("f() { echo {1..5000000}; }; f", 2),
		("a=( {x,{1..2048}}{1..2048} ); echo ${#a[@]}", 2),
		// The sequence is counted before its items are built.
		(": {1..4194304}{1,2}", 2),
		("a=( \"${x:-\"{1..2049}\"}${x:-\"{1..2048}\"}\" ); echo ${#a[@]}", 2),
		("declare -a a='({1..5000000})'", 1),
	] {
		let (result, output) = run_command_capture_within(
			Duration::from_secs(120),
			command,
			None,
			None,
			CancelToken::default(),
		)
		.await
		.expect("oversized brace expansion must fail promptly");
		if result.exit_code != Some(status)
			|| output.lines().count() != 1
			|| !output.contains("brace expansion:")
			|| !output.contains("over the limit of 4194304")
			|| output.contains("not supported")
		{
			failures.push(format!("{command:?}: status={:?}, output={output:?}", result.exit_code));
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn uutils_diff_reads_process_substitution_fds() {
	let (result, output) = run_command_capture_within(
		Duration::from_secs(5),
		"diff <(echo a) <(echo b)",
		None,
		None,
		CancelToken::default(),
	)
	.await
	.expect("process substitution should not hang");

	assert_eq!(result.exit_code, Some(1));
	assert!(output.contains("< a\n---\n> b\n"), "diff output missing changed lines: {output:?}");
}

/// Every run reads through a cancellable filesystem, and its redirects must
/// still open a FIFO as a blocking open does. A non-blocking open let a
/// reader that reads the descriptor itself (an external `cat`, `$(< f)`)
/// see EOF before a late writer connected; the writer then blocked forever.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fifo_redirect_waits_for_a_late_writer() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(5),
		"/bin/sh -c 'sleep 0.15; echo one > f' & /bin/cat < f; /bin/sh -c 'sleep 0.15; echo two > \
		 f' & x=$(< f); echo \"x=$x\"; wait",
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("a FIFO redirect waits for its writer and returns");

	assert_eq!((result.exit_code, output.as_str()), (Some(0), "one\nx=two\n"));
}

/// A FIFO redirect's open waits for the other end, which is often a
/// background job queued on the same runtime worker: `echo hi > f & cat <
/// f` deadlocked when the open held the worker. On a one-worker runtime,
/// both orders must finish.
#[cfg(unix)]
#[test]
fn fifo_redirects_do_not_hold_the_worker_their_other_end_needs() {
	let root = tempfile::tempdir().expect("scratch directory");
	for name in ["f", "g"] {
		pi_vfs::BlockingFs::native()
			.make_node(root.path().join(name), pi_vfs::NodeKind::Fifo, 0o600)
			.expect("create FIFO");
	}
	let (result, output) = capture_on_runtime(
		"echo one > f & cat < f; cat < g & echo two > g; wait",
		Some(root.path().to_path_buf()),
		512,
	)
	.expect("a FIFO redirect must not hold the worker its other end needs");

	assert_eq!((result.exit_code, output.as_str()), (Some(0), "one\ntwo\n"));
}

/// The session driver, external spawning, output pumps and process extras
/// are cooperative tasks: on a current-thread runtime a delayed writer and a
/// process extra piped into an intrinsic must both finish, with nothing
/// blocking the only thread they share.
#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn session_runs_pipelines_on_a_current_thread_runtime() {
	let _guard = shell_test_lock().lock().await;
	let (result, output) = time::timeout(
		Duration::from_secs(5),
		capture_unlocked(
			"{ /bin/sleep 0.05; echo late; } | /bin/cat; echo after; ps --help | head -n 1 | wc -l",
			None,
			None,
			CancelToken::default(),
		),
	)
	.await
	.expect("the session must not block the runtime's only thread");

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert!(output.starts_with("late\nafter\n"), "output: {output:?}");
	assert!(output.trim_end().ends_with('1'), "output: {output:?}");
}

/// A background external command's FIFO redirect is opened by its child,
/// as in bash: the parent shell spawned it and then waited for the FIFO's
/// other end, which was the next command, so `/bin/cat < f & echo one > f`
/// never returned. Job control must still see the command's real pid:
/// `$!` is the pid the command itself reports, and `wait`, `jobs`, `kill
/// %N` and `kill $!` reach a command still waiting for its FIFO.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn background_external_command_opens_its_fifo_redirect_itself() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(10),
		concat!(
			// First, so the job is `%1`.
			"/bin/sleep 30 < f & jobs; kill %1; wait $!; echo \"kill-job=$?\"\n",
			"/bin/sleep 30 < f & kill $!; wait $!; echo \"kill-pid=$?\"\n",
			"/bin/cat < f & pid=$!; echo one > f; wait $pid; echo \"wait=$?\"\n",
			"/bin/sh -c 'echo $$' > f & bg=$!; read -r self < f; wait $bg\n",
			"[ \"$self\" = \"$bg\" ] && echo same-pid",
		),
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("the shell goes on while a background command waits for its FIFO");

	assert_eq!(result.exit_code, Some(0), "{output}");
	assert!(output.contains("Running"), "`jobs` lists the waiting command: {output}");
	assert!(output.ends_with("kill-job=143\nkill-pid=143\none\nwait=0\nsame-pid\n"), "{output}");
}

/// `kill %1` aborts a background job without polling it again, so a FIFO
/// open it was waiting in is dropped, not cancelled. Its helper thread then
/// stayed in `open` and took the next writer's connection, whose data was
/// lost. A dropped open must leave no reader behind.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn killed_job_leaves_no_reader_on_its_fifo() {
	use std::os::unix::fs::OpenOptionsExt;
	let root = tempfile::tempdir().expect("scratch directory");
	let fifo = root.path().join("f");
	pi_vfs::BlockingFs::native()
		.make_node(&fifo, pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(10),
		"cat < f & sleep 0.2; kill %1; wait; echo done",
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("the killed job ends");
	assert_eq!((result.exit_code, output.as_str()), (Some(0), "done\n"));

	// The release runs on its own thread; give it time, then a writer that
	// does not wait must find no reader.
	time::sleep(Duration::from_millis(500)).await;
	let writer = std::fs::OpenOptions::new()
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo);
	assert_eq!(
		writer.err().and_then(|err| err.raw_os_error()),
		Some(libc::ENXIO),
		"a reader was left on the FIFO"
	);
}

/// The release of a killed job's FIFO open must be done when `kill`
/// returns: a release that came later woke the next command's open of the
/// same FIFO too, so that reader read EOF, its writer's data was lost, and
/// the writer then blocked with no reader.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn killed_job_releases_its_fifo_before_the_next_command() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(30),
		concat!(
			"for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do\n",
			"  cat < f & sleep 0.05; kill %%\n",
			"  /bin/cat < f > got & sleep 0.1; echo \"hi$i\" > f; wait\n",
			"  read -r x < got; [ \"$x\" = \"hi$i\" ] || echo \"lost $i\"\n",
			"done; echo done",
		),
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("no writer is left without a reader");

	assert_eq!((result.exit_code, output.as_str()), (Some(0), "done\n"));
}

/// A background external command's descriptor path (`/dev/stdout`) reaches
/// the shell's own output pipe and looked like a FIFO, so it was left to
/// the child, which then wrote to its `/dev/null` placeholder. And the
/// `/bin/sh` that makes deferred redirects stored the FIFO path in `f1`,
/// replacing an exported `f1` in the command's environment.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn deferred_redirects_keep_descriptor_paths_and_the_environment() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(10),
		concat!(
			"/bin/echo out > /dev/stdout & wait\n",
			"export f1=orig; /usr/bin/env > f & grep '^f1=' < f; wait",
		),
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("the commands finish");

	assert_eq!((result.exit_code, output.as_str()), (Some(0), "out\nf1=orig\n"));
}

/// A later redirection of a descriptor that a deferred FIFO redirection
/// sets (`>f >/dev/null`), or a duplication, move or close of it, made
/// every deferred redirection in the parent after all: the parent opened
/// the FIFO and waited for its reader, the next command, so the shell
/// never returned. The child now makes them all, in the order written.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn later_redirects_of_a_deferred_descriptor_stay_in_the_child() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(10),
		concat!(
			"/bin/echo replaced >f >/dev/null & cat <f; wait; echo \"replace=$?\"\n",
			"/bin/echo closed 3>f >&3 3>&- & cat <f; wait\n",
			"/bin/echo moved 3>f 1>&3- & cat <f; wait\n",
			"/bin/echo both >f &>/dev/null & cat <f; wait; echo \"both=$?\"\n",
			"/bin/echo descriptor >f >/dev/stdout & cat <f; wait",
		),
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("the shell goes on while a background command waits for its FIFO");

	assert_eq!(
		(result.exit_code, output.as_str()),
		(Some(0), "replace=0\nclosed\nmoved\nboth=0\ndescriptor\n")
	);
}

/// A deferred duplication reads the descriptor this process holds, so the
/// null device that stands in for a deferred descriptor must not take its
/// place: `>f 1>&3 3>/dev/null` sent the output to the null device, the
/// move `>f 1>&4-` lost it, and so did the swap idiom.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn deferred_duplications_read_the_descriptors_the_parent_holds() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(10),
		concat!(
			"{ /bin/echo dup3 >f 1>&3 3>/dev/null & cat <f; wait; } 3>out3; cat out3\n",
			"{ /bin/echo moved4 >f 1>&4- & cat <f; wait; } 4>out4; cat out4\n",
			"/bin/echo sw 2>f 3>&1 1>&2 2>&3 3>&- & cat <f; wait",
		),
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("the shell goes on while a background command waits for its FIFO");

	assert_eq!((result.exit_code, output.as_str()), (Some(0), "dup3\nmoved4\nsw\n"));
}

/// On macOS `poll` and kqueue report a FIFO's data but never its EOF, so
/// a builtin waiting for more input hung once the writer closed: `mapfile`
/// and `read` until cancelled, and `read -t` timed out instead of reading
/// EOF. Each writer here closes while its reader waits.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn builtins_waiting_on_a_fifo_see_its_writer_close() {
	let root = tempfile::tempdir().expect("scratch directory");
	pi_vfs::BlockingFs::native()
		.make_node(root.path().join("f"), pi_vfs::NodeKind::Fifo, 0o600)
		.expect("create FIFO");
	let (result, output) = run_command_capture_within(
		Duration::from_secs(10),
		concat!(
			"{ echo a; sleep 0.2; } > f & mapfile -t lines < f; wait; echo \"mapfile=${#lines[@]}\"\n",
			"{ echo b; sleep 0.2; } > f & while read -r l; do echo \"read=$l\"; done < f; wait\n",
			"{ printf c; sleep 0.2; } > f & read -t 5 -r x < f; echo \"read-t=$? $x\"; wait",
		),
		Some(root.path()),
		None,
		CancelToken::default(),
	)
	.await
	.expect("each reader ends at its writer's EOF");

	assert_eq!((result.exit_code, output.as_str()), (Some(0), "mapfile=1\nread=b\nread-t=1 c\n"));
}

/// Owned-shell pipeline stages already hold a blocking worker. Two `read`
/// stages fill a two-thread pool; offloading each read again would queue it
/// behind the workers its own stages hold, forever.
#[cfg(unix)]
#[test]
fn pipeline_reads_do_not_nest_on_a_full_blocking_pool() {
	let (result, output) =
		capture_on_runtime("printf 'a\\n' | read -r x | read -r y; printf 'done\\n'", None, 2)
			.expect("read must not wait on a blocking worker it cannot get");

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "done\n");
}

#[cfg(unix)]
#[test]
fn async_utilities_wait_for_a_slow_producer_without_blocking_the_worker() {
	let (result, output) =
		capture_on_runtime("{ sleep 0.3; echo hit; } | grep hit | rg hit", None, 512)
			.expect("async utilities must not block the runtime's only worker");

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "hit\n");
}

#[cfg(unix)]
#[test]
fn async_utilities_pipe_more_than_a_pipe_buffer() {
	let dir = tempfile::tempdir().expect("temp dir");
	for i in 0..3000 {
		std::fs::write(dir.path().join(format!("{}{i:05}", "f".repeat(40))), b"")
			.expect("create file");
	}

	let find = capture_on_runtime("find . -type f | grep -c f", Some(dir.path().to_path_buf()), 512);
	let fd = capture_on_runtime("fd -t f . | rg -c f", Some(dir.path().to_path_buf()), 512);

	let (result, output) = find.expect("find | grep must not deadlock on a full pipe");
	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "3000\n");
	let (result, output) = fd.expect("fd | rg must not deadlock on a full pipe");
	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "3000\n");
}

#[cfg(unix)]
#[test]
fn async_utility_waiting_on_stdin_is_cancelled_by_timeout() {
	// The pipeline ends with its producer (1 s); `grep` must be cancelled at
	// 0.3 s while the producer still needs the worker.
	let (result, output) =
		capture_on_runtime("{ sleep 1; echo x; } | timeout 0.3 grep x", None, 512)
			.expect("timeout must cancel a utility waiting on stdin");

	assert_eq!((result.exit_code, output.as_str()), (Some(124), ""));
}

#[cfg(unix)]
#[test]
fn read_process_substitution_assigns_line() {
	let (result, output) =
		capture_on_single_worker("read -r line < <(printf 'ok\\n'); printf '%s\\n' \"$line\"");

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "ok\n");
}

#[cfg(unix)]
#[test]
fn read_process_substitution_delivers_lines_and_reaches_eof() {
	let (result, output) = capture_on_single_worker(
		"while IFS= read -r l; do export X=\"$l\"; done < <(printf 'v\\n'); printf '%s\\n' \"$X\"",
	);

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "v\n");
}

/// Builtins share the host process, so a descriptor path must reach the
/// command's descriptors rather than the host's: the host's fd 0 is its
/// terminal (`cat /dev/stdin` once blocked on the TUI's keystrokes for
/// good) and its fd 2 is not the capture pipe. Covers a utility operand,
/// a redirect, a utility output file, and `source`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn descriptor_paths_reach_the_commands_descriptors() {
	// The first command is the shape that hung the TUI.
	let command = "for f in $(cat /dev/stdin <<'EOF'\na\nb\nEOF\n); do echo \"$f\"; done\necho \
	               to-stderr > /dev/stderr\necho via-tee | tee /dev/stderr > /dev/null\nsource \
	               /dev/stdin <<< 'echo sourced'";
	let (result, output) = run_command_capture_within(
		Duration::from_secs(5),
		command,
		None,
		None,
		CancelToken::default(),
	)
	.await
	.expect("descriptor paths must not read the host terminal");

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "a\nb\nto-stderr\nvia-tee\nsourced\n");
}

/// A descriptor the shell does not have fails like a closed one, instead
/// of reaching whatever the host process holds at that number.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn descriptor_paths_never_reach_host_only_descriptors() {
	use std::os::fd::AsRawFd as _;

	let dir = unique_temp_dir("host-fd");
	let host_path = dir.join("host-only.txt");
	std::fs::write(&host_path, "host-only\n").expect("write host file");
	let host_file = std::fs::File::open(&host_path).expect("open host file");
	let fd = host_file.as_raw_fd();
	let command =
		format!("cat /dev/fd/{fd}; echo \"rc=$?\"; cat < /proc/self/fd/{fd}; echo \"rc=$?\"");

	let (_, output) = run_command_capture_within(
		Duration::from_secs(5),
		&command,
		None,
		None,
		CancelToken::default(),
	)
	.await
	.expect("closed descriptor paths should fail fast");
	drop(host_file);
	let _ = std::fs::remove_dir_all(&dir);

	assert!(!output.contains("host-only"), "read a host-only descriptor: {output:?}");
	assert_eq!(output.matches("rc=1").count(), 2, "both opens should fail: {output:?}");
}

/// `<(…)` operands resolve through the shell's descriptor table, so
/// utilities report the name the shell passed and script-file options read
/// them too.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn process_substitution_operands_keep_the_shell_fd_name() {
	let command = "wc -l <(printf 'a\\nb\\n'); ls <(true); sed -n -f <(echo p) <<< from-sed";
	let (result, output) = run_command_capture_within(
		Duration::from_secs(5),
		command,
		None,
		None,
		CancelToken::default(),
	)
	.await
	.expect("process substitution should not hang");

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "2 /dev/fd/63\n/dev/fd/63\nfrom-sed\n");
}

/// `sed`'s `w /dev/stdout` writes through sed's own output, as GNU sed
/// does: a second open of a redirected stdout truncates it and races the
/// primary output at its own offset.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn sed_w_dev_stdout_shares_sed_output() {
	let dir = unique_temp_dir("sed-w-stdout");
	let command = format!(
		"cd '{}'; printf 'a\\nb\\n' | sed 'w /dev/stdout' > f; cat f; printf 'c\\n' | sed -n \
		 's/c/d/w /dev/stdout'",
		dir.display()
	);
	let (result, output) = run_command_capture_within(
		Duration::from_secs(5),
		&command,
		None,
		None,
		CancelToken::default(),
	)
	.await
	.expect("sed should not hang");
	let _ = std::fs::remove_dir_all(&dir);

	assert_eq!(result.exit_code, Some(0), "output: {output:?}");
	assert_eq!(output, "a\na\nb\nb\nd\n");
}

/// A descriptor the shell lacks is reported under the name the user
/// typed, and `readlink` reads `/dev/stdin` as the symlink it is instead
/// of the descriptor behind it.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn descriptor_paths_keep_their_spelling() {
	let command = "pgrep -F /dev/fd/9; sed 'w /dev/fd/9' <<< x; readlink /dev/stdin <<< x";
	let (_, output) = run_command_capture_within(
		Duration::from_secs(5),
		command,
		None,
		None,
		CancelToken::default(),
	)
	.await
	.expect("closed descriptor paths should fail fast");

	assert!(!output.contains("/dev/fd/-1"), "leaked the placeholder path: {output:?}");
	assert!(output.contains("cannot read pidfile '/dev/fd/9'"), "output: {output:?}");
	assert!(output.contains("creating file '/dev/fd/9'"), "output: {output:?}");
	assert!(output.ends_with("/proc/self/fd/0\n"), "output: {output:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn one_shot_completion_aborts_internal_background_jobs() {
	let marker = tempfile::NamedTempFile::new().expect("marker file");
	let marker_path = marker.path().to_string_lossy();
	std::fs::remove_file(marker.path()).expect("remove initial marker");
	let command = format!("{{ sleep 1; echo leaked > {}; }} &", quote_arg(&marker_path));

	execute_shell(
		ShellExecuteOptions { command, ..Default::default() },
		None,
		CancelToken::default(),
	)
	.await
	.expect("one-shot shell execution");
	// `execute_shell` returns after its short post-exit idle drain (~250ms),
	// while the background job cannot write the marker until its 1s sleep
	// elapses. Wait well past that delay so a job that outlived the dropped
	// session has demonstrably had its chance to run — the pre-fix leak fires
	// at ~1s and is caught here; the fixed path aborts the task on drop and
	// the marker never appears.
	time::sleep(Duration::from_millis(2000)).await;

	assert!(
		!marker.path().exists(),
		"an internal background job outlived its one-shot shell session"
	);
}

/// A background builtin started in a subshell ends with the subshell, as an
/// external one does. Left running it was out of reach — no process for
/// `pkill`, no job for `kill %N` — and spun for the life of the host.
#[tokio::test(flavor = "multi_thread")]
async fn subshell_exit_ends_its_background_builtins() {
	let _guard = shell_test_lock().lock().await;
	let output = tempfile::NamedTempFile::new().expect("output file");
	let shell = Shell::new(None);
	let command = format!("(yes > {} &)", quote_arg(&output.path().to_string_lossy()));

	shell
		.run(ShellRunOptions { command, ..Default::default() }, None, CancelToken::default())
		.await
		.expect("run subshell");

	assert!(!still_written(output.path()).await, "background `yes` outlived its subshell");
}

/// `kill %N` ends a background job running inside the shell, which has no
/// process to deliver the signal to.
#[tokio::test(flavor = "multi_thread")]
async fn kill_jobspec_ends_in_process_background_job() {
	let _guard = shell_test_lock().lock().await;
	let output = tempfile::NamedTempFile::new().expect("output file");
	let shell = Shell::new(None);
	let command = format!("yes > {} & kill %1", quote_arg(&output.path().to_string_lossy()));

	let result = shell
		.run(ShellRunOptions { command, ..Default::default() }, None, CancelToken::default())
		.await
		.expect("run kill");

	assert_eq!(result.exit_code, Some(0), "kill %1 failed");
	assert!(!still_written(output.path()).await, "`yes` kept running after kill %1");
}

/// `VictorCano`'s #12309 follow-up trigger (2026-10-21): a backgrounded
/// compound loop — not a simple builtin command at job level — inside a
/// subshell must also end with the subshell, like a backgrounded `yes`.
#[tokio::test(flavor = "multi_thread")]
async fn subshell_exit_ends_backgrounded_compound_loops() {
	let _guard = shell_test_lock().lock().await;
	let output = tempfile::NamedTempFile::new().expect("output file");
	let shell = Shell::new(None);
	let command =
		format!("(while :; do echo x >> {}; done &)", quote_arg(&output.path().to_string_lossy()));

	shell
		.run(ShellRunOptions { command, ..Default::default() }, None, CancelToken::default())
		.await
		.expect("run compound loop");

	assert!(!still_written(output.path()).await, "background compound loop outlived its subshell");
}

/// `kill %N` must reach a backgrounded compound loop in a retained session
/// (the bash-tool persistent shell keeps its job table alive, so the loop
/// legitimately outlives the call — the agent's only off-switch is the
/// jobspec). Uses a writing loop so liveness is observable without timing,
/// and bounds both calls: a hanging `kill %1` is exactly the wedge the
/// reporter hit on 18.12.5, not a pass.
#[tokio::test(flavor = "multi_thread")]
async fn kill_jobspec_ends_backgrounded_compound_loop_in_retained_session() {
	let _guard = shell_test_lock().lock().await;
	let output = tempfile::NamedTempFile::new().expect("output file");
	let shell = Shell::new(None);
	let sub =
		format!("(while :; do echo x >> {}; done) &", quote_arg(&output.path().to_string_lossy()));

	time::timeout(
		Duration::from_secs(10),
		shell.run(
			ShellRunOptions { command: sub, ..Default::default() },
			None,
			CancelToken::default(),
		),
	)
	.await
	.expect("backgrounding a subshell loop must return promptly")
	.expect("run backgrounded subshell loop");
	assert!(still_written(output.path()).await, "loop never started");

	let kill = time::timeout(
		Duration::from_secs(10),
		shell.run(
			ShellRunOptions { command: "kill %1".into(), ..Default::default() },
			None,
			CancelToken::default(),
		),
	)
	.await
	.expect("kill %1 must return instead of wedging the session")
	.expect("kill %1");
	assert_eq!(kill.exit_code, Some(0), "kill %1 failed");
	assert!(!still_written(output.path()).await, "kill %1 did not end the compound loop");
}

/// `live_background_job_count` reports 0 when the session has no live
/// external background jobs and 1 while one is running. The host relies on
/// this to retain a per-call shell whose `&`/`nohup` child is still alive
/// instead of dropping it (which would SIGKILL the child via kill-on-drop).
/// `sh -c` forces an external process because the bare `sleep` builtin runs
/// in-process and is intentionally not counted.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn live_background_job_count_tracks_external_background_jobs() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);

	// No session core materialized yet.
	assert_eq!(shell.live_background_job_count().await, 0);

	// A foreground-only command leaves nothing in the background.
	shell
		.run(
			ShellRunOptions { command: "true".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("run true");
	assert_eq!(shell.live_background_job_count().await, 0);

	// An external background process is tracked while it runs.
	shell
		.run(
			ShellRunOptions { command: "sh -c 'sleep 30' &".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("run sleep");
	assert_eq!(shell.live_background_job_count().await, 1);

	// Dropping the shell at scope end reaps the child via kill-on-drop.
	shell.abort().await;
}

/// An exited `&` child must be waited on while the persistent shell is
/// idle, not only when the host submits another command. Keep its status
/// for a later explicit `wait` after the OS process has disappeared.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn persistent_shell_reaps_background_child_without_followup_run() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	// `$!` names the job for `wait`; the child reports its OS pid itself.
	let pidfile = tempfile::NamedTempFile::new().expect("child pidfile");
	let started = shell
		.run(
			ShellRunOptions {
				command: format!(
					"/bin/sh -c 'echo $$ > \"$1\"; sleep 1; exit 7' _ {} >/dev/null 2>&1 & pid=$!",
					quote_arg(&pidfile.path().to_string_lossy())
				),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.expect("start external background child");
	assert_eq!(started.exit_code, Some(0));
	let pid = time::timeout(Duration::from_secs(2), async {
		loop {
			if let Ok(pid) = fs::read_to_string(pidfile.path())
				.unwrap_or_default()
				.trim()
				.parse::<i32>()
			{
				break pid;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await
	.expect("background child did not record its pid");
	assert!(pid > 0);

	// No calls to the shell (including the live-job counter) until this
	// child has exited and its parent has reaped it.
	time::timeout(Duration::from_secs(5), async {
		loop {
			// SAFETY: signal 0 only probes this pid's existence.
			if unsafe { libc::kill(pid, 0) } == -1 {
				let err = io::Error::last_os_error();
				assert_eq!(err.raw_os_error(), Some(libc::ESRCH), "probe child: {err}");
				break;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await
	.expect("background child remained a zombie after exit");

	assert_eq!(shell.live_background_job_count().await, 0);

	let waited = shell
		.run(
			ShellRunOptions { command: "wait \"$pid\"".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("wait for already-reaped child");
	assert_eq!(waited.exit_code, Some(7));
}

/// A short-lived stage of a background pipeline must be reaped even if
/// another stage is still running. The pipeline's last-stage status must
/// remain available to `wait` after both children have been reaped.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn persistent_shell_reaps_early_exiting_background_pipeline_stage() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	let first_pidfile = tempfile::NamedTempFile::new().expect("pipeline pidfile");
	let last_pidfile = tempfile::NamedTempFile::new().expect("last stage pidfile");
	// `$!` names the job for `wait`; each stage reports its OS pid itself.
	let command = format!(
		"/bin/sh -c 'echo $$ > \"$1\"; exec /bin/sleep 15' _ {} | /bin/sh -c 'echo $$ > \"$1\"; \
		 sleep 1; exit 9' _ {} >/dev/null 2>&1 & pid=$!",
		quote_arg(&first_pidfile.path().to_string_lossy()),
		quote_arg(&last_pidfile.path().to_string_lossy())
	);
	let started = shell
		.run(ShellRunOptions { command, ..Default::default() }, None, CancelToken::default())
		.await
		.expect("start background pipeline");
	assert_eq!(started.exit_code, Some(0));
	let recorded = |pidfile: &std::path::Path| {
		let pidfile = pidfile.to_path_buf();
		time::timeout(Duration::from_secs(2), async move {
			loop {
				if let Ok(pid) = fs::read_to_string(&pidfile)
					.unwrap_or_default()
					.trim()
					.parse::<i32>()
				{
					break pid;
				}
				time::sleep(Duration::from_millis(20)).await;
			}
		})
	};
	let last_pid = recorded(last_pidfile.path())
		.await
		.expect("last pipeline stage did not record its pid");
	assert!(last_pid > 0);
	let first_pid = recorded(first_pidfile.path())
		.await
		.expect("first pipeline stage did not record its pid");
	assert_ne!(first_pid, last_pid, "pipeline stages need distinct pids");

	// A zombie still responds to signal 0. The last stage must disappear
	// while the first is alive, without another shell/tool invocation.
	time::timeout(Duration::from_secs(5), async {
		loop {
			// SAFETY: signal 0 only probes this pid's existence.
			if unsafe { libc::kill(last_pid, 0) } == -1 {
				let err = io::Error::last_os_error();
				assert_eq!(err.raw_os_error(), Some(libc::ESRCH), "probe child: {err}");
				break;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await
	.expect("early exiting pipeline stage remained a zombie");
	// SAFETY: signal 0 only probes the other child, which must still be
	// running for this to prove independent reaping.
	assert_eq!(unsafe { libc::kill(first_pid, 0) }, 0, "first stage exited too soon");
	// SAFETY: end only this test-owned sleep so the final wait is prompt.
	assert_eq!(unsafe { libc::kill(first_pid, libc::SIGTERM) }, 0);

	let waited = shell
		.run(
			ShellRunOptions { command: "wait \"$pid\"".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("wait for background pipeline");
	assert_eq!(waited.exit_code, Some(9), "wait must report the pipeline's last stage");
}

/// `exit` and errexit end the command, not the session: later runs keep
/// the variables, functions, and options set before them.
#[tokio::test(flavor = "multi_thread")]
async fn exit_and_errexit_keep_session_state() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	let exit_code = async |command: &str| {
		shell
			.run(
				ShellRunOptions { command: command.into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run")
			.exit_code
	};
	let state_intact = "test \"$PI_KEPT\" = kept && pi_kept_fn";

	assert_eq!(exit_code("set -e; PI_KEPT=kept; pi_kept_fn() { true; }").await, Some(0));
	assert_eq!(exit_code("false; true").await, Some(1), "errexit stops the command");
	assert_eq!(exit_code(state_intact).await, Some(0), "state lost after errexit");
	assert_eq!(exit_code("exit 3").await, Some(3));
	assert_eq!(exit_code(state_intact).await, Some(0), "state lost after exit");
	assert_eq!(exit_code("false; exit 0").await, Some(1), "errexit option lost");
}

/// An EXIT trap belongs to one run, while signal traps persist in the session.
#[tokio::test(flavor = "multi_thread")]
async fn exit_trap_fires_once_per_session_run() {
	async fn run(shell: &mut ShellSessionCore, command: &str) -> (i32, String) {
		let output = tempfile::tempfile().expect("capture file");
		let result = shell
			.run_test(command, &TestStdio::null().stdout(&output))
			.await
			.expect("run");
		(exit_code(&result), read_capture(&output))
	}

	let mut shell = default_session().await;
	assert_eq!(
		run(&mut shell, "trap 'echo E' EXIT; trap 'echo T' USR1; echo a").await,
		(0, "a\nE\n".into())
	);
	assert_eq!(
		run(&mut shell, "trap -p EXIT; trap -p USR1; echo b").await,
		(0, "trap -- 'echo T' SIGUSR1\nb\n".into())
	);
	assert_eq!(run(&mut shell, "echo c").await, (0, "c\n".into()));
	assert_eq!(run(&mut shell, "echo d").await, (0, "d\n".into()));
	assert_eq!(run(&mut shell, "trap 'echo N' EXIT; echo e").await, (0, "e\nN\n".into()));
	assert_eq!(run(&mut shell, "echo f").await, (0, "f\n".into()));

	let mut shell = default_session().await;
	assert_eq!(run(&mut shell, "trap 'echo X' EXIT; exit 3").await, (3, "X\n".into()));
	assert_eq!(run(&mut shell, "echo g").await, (0, "g\n".into()));
	assert_eq!(run(&mut shell, "trap 'echo F' EXIT; f() { exit 3; }; f").await, (3, "F\n".into()));
	assert_eq!(run(&mut shell, "echo h").await, (0, "h\n".into()));
}

/// `Shell::pids` reports the in-flight run's live external children without
/// waiting on the session lock that the running command holds, and goes
/// empty once the run returns — including through cancellation.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pids_reports_in_flight_children_until_run_returns() {
	let _guard = shell_test_lock().lock().await;
	let shell = Arc::new(Shell::new(None));
	assert!(shell.pids().is_empty(), "no run in flight");

	// The bare `sleep` builtin runs in-process; use the external binary.
	let sleep = test_executable("sleep");
	let run = tokio::spawn({
		let shell = shell.clone();
		async move {
			shell
				.run(
					ShellRunOptions {
						command: format!("'{}' 30", sleep.display()),
						..Default::default()
					},
					None,
					CancelToken::default(),
				)
				.await
		}
	});

	let pids = time::timeout(Duration::from_secs(5), async {
		loop {
			let pids = shell.pids();
			if !pids.is_empty() {
				break pids;
			}
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("in-flight run never reported a pid");
	assert_eq!(pids.len(), 1, "exactly the sleep child: {pids:?}");
	let child = proctree::Process::from_pid(pids[0]).expect("reported pid is alive");
	assert_eq!(child.status(), proctree::ProcessStatus::Running);

	shell.abort().await;
	let result = time::timeout(Duration::from_secs(5), run)
		.await
		.expect("aborted run returns")
		.expect("run task")
		.expect("run result");
	assert!(result.cancelled, "run was aborted");
	assert!(shell.pids().is_empty(), "pids cleared once the run returns");
}

/// A fork taken while a command runs starts from the state that command
/// started from (variables, functions, cwd), without waiting for it; what the
/// fork sets stays in the fork; sibling forks draw different `$RANDOM`s.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fork_starts_from_the_state_before_the_running_command() {
	async fn run(shell: &Shell, command: &str) -> String {
		let (tx, rx) = flume::unbounded();
		let result = shell
			.run(
				ShellRunOptions { command: command.into(), ..Default::default() },
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("run");
		assert_eq!(result.exit_code, Some(0), "{command}");
		rx.drain().collect()
	}

	let _guard = shell_test_lock().lock().await;
	let dir = tempfile::tempdir().expect("scratch directory");
	let dir_path = dir.path().canonicalize().expect("canonical dir");
	let started = dir_path.join("started");
	let gate = dir_path.join("gate");
	let shell = Arc::new(Shell::new(None));
	run(
		&shell,
		&format!(
			"PI_FORK_VAR=before; pi_fork_fn() {{ printf 'fn:%s' \"$1\"; }}; cd {}; RANDOM=7",
			quote_arg(&dir_path.to_string_lossy())
		),
	)
	.await;

	let owner = tokio::spawn({
		let shell = shell.clone();
		let command = format!(
			"PI_FORK_VAR=during; : > {}; while [ ! -e {} ]; do sleep 0.01; done",
			quote_arg(&started.to_string_lossy()),
			quote_arg(&gate.to_string_lossy())
		);
		async move { run(&shell, &command).await }
	});
	time::timeout(Duration::from_secs(5), async {
		while !started.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("owner command never started");

	let fork = shell.fork();
	let seen = time::timeout(
		Duration::from_secs(5),
		run(
			&fork,
			"printf '%s|%s|%s' \"$PI_FORK_VAR\" \"$(pi_fork_fn x)\" \"$PWD\"; PI_FORK_VAR=fork",
		),
	)
	.await
	.expect("fork waited for the running command");
	assert_eq!(seen, format!("before|fn:x|{}", dir_path.display()));
	let random = "echo $RANDOM $RANDOM $RANDOM";
	assert_ne!(run(&shell.fork(), random).await, run(&shell.fork(), random).await);

	fs::write(&gate, "").expect("open gate");
	time::timeout(Duration::from_secs(5), owner)
		.await
		.expect("owner finishes")
		.expect("owner task");
	assert_eq!(run(&shell, "printf %s \"$PI_FORK_VAR\"").await, "during");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_minimizer_trace_spans_submissions_without_early_completion() {
	use crate::bash::{
		event::NodeKind,
		trace::{RunTrace, history::HistoryData},
	};
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("trace chain directory");
	let gate = root.path().join("gate");
	let minimizer = printf_minimizer(&root.path().join("minimizer.toml"), None);
	let repeated = format!("printf '{}'", "hello\\n".repeat(200));
	let gate_command =
		format!("/bin/sh -c 'while [ ! -e \"{}\" ]; do sleep 0.01; done'", gate.display());
	let command =
		format!("{repeated}; {gate_command}; {repeated}; false && printf skipped; {repeated}; false");
	let trace = Arc::new(RunTrace::new(command.as_str()));
	let shell = Shell::new(Some(ShellOptions { minimizer: Some(minimizer), ..Default::default() }));
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellRunOptions {
		command: command.clone(),
		trace: Some(trace.clone()),
		..Default::default()
	};
	let probe = async {
		loop {
			let snapshot = trace.snapshot();
			if snapshot.history.iter().any(|entry| entry.segment == Some(1)
				&& matches!(&entry.data, HistoryData::CmdExpanded { argv, .. } if argv.first().is_some_and(|arg| arg.as_slice() == b"/bin/sh")))
			{
				assert_eq!(snapshot.status, None, "first segment RunEnd cannot end the logical call");
				assert!(snapshot.history.iter().any(|entry| entry.segment == Some(0)
					&& matches!(entry.data, HistoryData::RunEnd { status: 0 }) && !entry.logical_end));
				std::fs::write(&gate, []).expect("release second segment");
				break;
			}
			tokio::task::yield_now().await;
		}
	};
	let (result, ()) = time::timeout(Duration::from_secs(10), async {
		tokio::join!(shell.run(options, Some(tx), CancelToken::default()), probe)
	})
	.await
	.expect("segmented trace completes");
	let result = result.expect("real segmented run");
	assert_eq!(result.exit_code, Some(1));
	assert_eq!(rx.drain().collect::<String>(), "hello\n".repeat(600));
	let minimized = result
		.minimized
		.expect("segmentation/minimization stays active");
	assert_eq!(minimized.filter, "chain");
	assert_eq!(minimized.text, "HI\n".repeat(600));
	let snapshot = trace.snapshot();
	assert_eq!(snapshot.status, Some(1));
	let output: String = snapshot
		.history
		.iter()
		.filter_map(|entry| match &entry.data {
			HistoryData::Output { text, .. } => Some(String::from_utf8_lossy(text).into_owned()),
			_ => None,
		})
		.collect();
	assert_eq!(output, "hello\n".repeat(600));
	let mut source_offsets = std::collections::HashSet::new();
	for entry in &snapshot.history {
		if matches!(entry.data, HistoryData::Output { .. }) {
			let unit = &snapshot.units[entry.u.expect("exact segment unit") as usize];
			let node = &unit.nodes[entry.n.expect("exact segment producer") as usize];
			let at = unit.at.expect("AST-planned source location") as usize;
			assert_eq!(
				&command.as_bytes()[at + node.lo as usize..at + node.hi as usize],
				repeated.as_bytes()
			);
			source_offsets.insert(at);
		}
	}
	assert_eq!(
		source_offsets.len(),
		3,
		"identical repeated commands before and after a skipped operand have distinct authoritative \
		 spans"
	);
	let boundaries: Vec<_> = snapshot
		.history
		.iter()
		.filter(|entry| {
			matches!(entry.data, HistoryData::RunEnd { .. }) && entry.vpid == snapshot.root_vpid
		})
		.collect();
	assert_eq!(
		boundaries.len(),
		6,
		"skipped && operand is never submitted, but later semicolon operands continue"
	);
	assert!(boundaries[..5].iter().all(|entry| !entry.logical_end));
	assert!(boundaries[5].logical_end);
	assert_eq!(boundaries[5].logical_status, Some(1));
	assert_eq!(snapshot.history.first().unwrap().t_ns, 0);
	assert!(
		snapshot
			.history
			.windows(2)
			.filter(|entries| entries[0].segment != entries[1].segment)
			.all(|entries| entries[1].t_ns >= entries[0].t_ns),
		"actual segment transitions share one measured clock"
	);
	assert!(
		snapshot.history.iter().any(|entry| entry.segment == Some(3)
			&& matches!(entry.data, HistoryData::CmdEnd { status: 1, .. })
			&& entry.n.zip(entry.u).is_some_and(|(n, u)| {
				let unit = &snapshot.units[u as usize];
				let node = &unit.nodes[n as usize];
				node.k == NodeKind::Simple
					&& unit.at.is_some_and(|at| {
						&command.as_bytes()
							[at as usize + node.lo as usize..at as usize + node.hi as usize]
							== b"false"
					})
			})),
		"known brace wrapper maps false back to its original bytes"
	);
	assert!(!snapshot.history.iter().any(|entry| matches!(&entry.data,
		HistoryData::CmdExpanded { argv, .. } if argv.iter().any(|arg| arg.as_slice() == b"skipped"))));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_false_and_printf_skips_second_and_returns_nonzero() {
	let root = unique_temp_dir("false-and");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let (result, output) =
		run_command_capture("false && printf skipped", None, Some(minimizer), CancelToken::default())
			.await;
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!(result.exit_code, Some(1));
	assert!(!result.cancelled);
	assert!(!result.timed_out);
	assert_eq!(output, "");
	// `false && printf` short-circuits: nothing is rewritten, so a no-op
	// chain must surface no minimizer telemetry (None).
	assert!(result.minimized.is_none(), "chain noop must not surface telemetry");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_false_semicolon_printf_continues_and_returns_last_code() {
	let root = unique_temp_dir("false-semi");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let expected = "hello\n".repeat(200);
	let command = format!("false ; printf '{}'", "hello\\n".repeat(200));
	let (result, output) =
		run_command_capture(&command, None, Some(minimizer), CancelToken::default()).await;
	let _ = std::fs::remove_dir_all(&root);
	let minimized = result.minimized.expect("long output should be minimized");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, expected);
	assert_eq!(minimized.filter, "chain");
	assert_eq!(minimized.original_text, expected);
	assert_eq!(minimized.text, "HI\n".repeat(200));
}

/// Like jq, the built-in jq reports an input that fails and exits 0 when it
/// is not the last. Such a run is never shortened, even when the error does
/// not start a line; long successful output that only looks like an error
/// still is.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn jq_run_that_reported_an_error_is_not_minimized() {
	let root = unique_temp_dir("jq-error");
	std::fs::write(root.join("in.jsonl"), "1\n2\n3\n").expect("write input");
	let _guard = shell_test_lock().lock().await;
	let run = async |command: &str| {
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions {
			command: command.to_string(),
			cwd: Some(root.to_string_lossy().into_owned()),
			// the built-in jq even when the environment turns builtins off
			session_env: Some(HashMap::from([(
				"PI_DISABLE_UUTILS_BUILTINS".to_string(),
				"0".to_string(),
			)])),
			minimizer: Some(minimizer::MinimizerOptions { enabled: Some(true), ..Default::default() }),
			..Default::default()
		};
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute_shell");
		let output: String = rx.drain().collect();
		(result, output)
	};
	let rows = r#"range(0; 200) | "row with many fields and a longer string value""#;
	// `stderr` writes no newline, so the error lands mid-line
	let failing = format!(
		r#"jq -r 'if . == 2 then "prefix" | stderr | error("boom") else {rows} end' in.jsonl"#
	);
	for command in [failing.clone(), format!("cd . && {failing}")] {
		let (result, output) = run(&command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert!(output.contains("prefixjq: error (at in.jsonl:2): boom"), "{command}: {output:?}");
		assert!(result.minimized.is_none(), "{command}: {:?}", result.minimized);
		// Without the reported error the jq filter would shorten this capture.
		let filtered = minimizer::apply(&failing, &output, 0, &minimizer::MinimizerConfig {
			enabled: true,
			..Default::default()
		});
		assert!(filtered.changed, "{command}");
	}
	for value in ["Error: expected user data", "jq: error is data"] {
		let command = format!(r#"jq -nr 'range(0; 1000) | "{value}"'"#);
		let (result, _) = run(&command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert!(result.minimized.is_some(), "{command} is shortened");
	}
	let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_cd_tmp_and_pwd_persists_state_across_segments() {
	let root = unique_temp_dir("cwd");
	let tmp_dir = root.join("tmp");
	std::fs::create_dir_all(&tmp_dir).expect("create nested tmp dir");
	let settings_path = root.join("minimizer.toml");
	std::fs::write(
		&settings_path,
		r#"
schema_version = 1

[filters.pwd]
match_command = "^pwd$"
replace = [{ pattern = "^.+$", replacement = "PWD" }]
"#,
	)
	.expect("write settings");
	let minimizer = minimizer::MinimizerOptions {
		enabled: Some(true),
		settings_path: Some(settings_path.to_string_lossy().into_owned()),
		..Default::default()
	};

	let expected = format!("{}\n", tmp_dir.display());
	let (result, output) =
		run_command_capture("cd tmp && pwd", Some(&root), Some(minimizer), CancelToken::default())
			.await;
	let _ = std::fs::remove_dir_all(&root);
	assert!(result.minimized.is_none(), "short pwd output must not be minimized");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, expected);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn whole_command_exceeding_capture_cap_streams_raw_without_minimized() {
	let root = unique_temp_dir("whole-cap");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), Some(1024));
	let (result, output) =
		run_command_capture("printf '%1200s' x", None, Some(minimizer), CancelToken::default()).await;
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output.len(), 1200);
	assert!(output.ends_with('x'));
	// Output exceeded the capture cap: streamed raw and never buffered, so
	// nothing was minimized. `minimized` must be absent (not a `too-large`
	// result with empty `text`, which would mislead presence-keyed
	// consumers).
	assert!(result.minimized.is_none());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_printf_chain_preserves_raw_original_text() {
	let root = unique_temp_dir("minimizer");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let hello = "hello\n".repeat(200);
	let world = "world\n".repeat(200);
	let command =
		format!("printf '{}' ; printf '{}'", "hello\\n".repeat(200), "world\\n".repeat(200));
	let (result, output) =
		run_command_capture(&command, None, Some(minimizer), CancelToken::default()).await;
	let _ = std::fs::remove_dir_all(&root);
	let minimized = result.minimized.expect("long output should be minimized");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, format!("{hello}{world}"));
	assert_eq!(minimized.filter, "chain");
	assert_eq!(minimized.original_text, format!("{hello}{world}"));
	assert_eq!(minimized.text, format!("{}{}", "HI\n".repeat(200), world));
	assert_eq!(minimized.input_bytes, (hello.len() + world.len()) as u32);
	assert_eq!(minimized.output_bytes, ("HI\n".repeat(200).len() + world.len()) as u32);
}

/// Regression: a quoted here-doc followed by another command must execute
/// instead of failing with "unterminated here document". The minimizer's
/// segmented runner used to rebuild each segment by re-printing the parsed
/// AST, which re-emitted the `<<'PY'` close tag as the quoted `'PY'` — an
/// invalid delimiter that left the body unterminated. Here-doc-bearing
/// commands now bail out of segmentation and run whole via the single path.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn quoted_heredoc_in_chain_runs_via_single_path() {
	let root = unique_temp_dir("heredoc-chain");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let (result, output) = run_command_capture(
		"cat <<'PY'\nhello $USER\nPY\nprintf 'after\\n'",
		None,
		Some(minimizer),
		CancelToken::default(),
	)
	.await;
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!(result.exit_code, Some(0));
	// Quoted delimiter keeps the body literal ($USER unexpanded) and the
	// trailing command still runs in order.
	assert_eq!(output, "hello $USER\nafter\n");
	assert!(!output.contains("unterminated"));
}

/// Regression: a `&&` / `;` chain whose later pipeline stage is a compound
/// command (`while … done`) must execute instead of failing with
/// "pi-natives:command: syntax error at end of input". The segmented chain
/// runner rebuilt each segment by re-printing the parsed AST, but only
/// validated the *first* pipeline stage — so a compound later stage was
/// reconstructed without its terminator and re-run as invalid shell. Such a
/// command now bails out of segmentation and runs whole via the single path.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn compound_stage_in_chain_runs_via_single_path() {
	let root = unique_temp_dir("compound-chain");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let (result, output) = run_command_capture(
		"printf 'start\\n' && seq 5 | while read n; do echo \"n=$n\"; done | head -2",
		None,
		Some(minimizer),
		CancelToken::default(),
	)
	.await;
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, "start\nn=1\nn=2\n");
	assert!(!output.contains("syntax error"));
	// Ran whole (unsegmented), so nothing was minimized.
	assert!(result.minimized.is_none());
}

/// A segment that carries a file redirect is still segmented, and the
/// segment text the runner executes must carry the redirect through to the
/// shell **without losing it**.
/// `echo hidden >/dev/null` suppresses its own stdout: if the segment text
/// dropped the redirect, `hidden` would leak into the captured output.
/// Proves the segmented path is semantically sound for the
/// redirect-bearing shapes the per-stage whitelist accepts (not just
/// syntactically parseable).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_chain_with_redirect_executes_correctly() {
	let root = unique_temp_dir("redirect-chain");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let expected = "hello\n".repeat(200);
	let command = format!("echo hidden >/dev/null && printf '{}'", "hello\\n".repeat(200));
	let (result, output) =
		run_command_capture(&command, None, Some(minimizer), CancelToken::default()).await;
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!(result.exit_code, Some(0));
	// The redirect survived reconstruction: segment 1's stdout went to
	// /dev/null, so only segment 2's output is captured.
	assert!(!output.contains("hidden"), "redirect must suppress segment-1 stdout");
	assert_eq!(output, expected);
	let minimized = result.minimized.expect("long output should be minimized");
	assert_eq!(minimized.original_text, expected);
	assert_eq!(minimized.text, "HI\n".repeat(200));
	assert!(!output.contains("syntax error"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_chain_exceeding_aggregate_capture_cap_stays_raw() {
	let root = unique_temp_dir("aggregate-cap");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), Some(1024));
	let (result, output) = run_command_capture(
		"printf '%600s' x ; printf '%600s' y",
		None,
		Some(minimizer),
		CancelToken::default(),
	)
	.await;
	let _ = std::fs::remove_dir_all(&root);
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output.len(), 1200);
	assert!(output.ends_with('y'));
	// Aggregate cap exceeded: the chain streamed its output raw and was not
	// minimized, so `minimized` is absent (not an empty-text `too-large`).
	assert!(result.minimized.is_none());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_timeout_in_first_segment_prevents_later_segments() {
	let root = unique_temp_dir("timeout");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let (result, output) = run_command_capture(
		"sleep 1 && printf later",
		None,
		Some(minimizer),
		CancelToken::new(Some(10)),
	)
	.await;
	let _ = std::fs::remove_dir_all(&root);
	assert!(result.exit_code.is_none());
	assert!(!result.cancelled);
	assert!(result.timed_out);
	assert!(result.minimized.is_none());
	assert!(!output.contains("later"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_cancel_in_first_segment_prevents_later_segments() {
	let root = unique_temp_dir("cancel");
	let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
	let mut cancel_token = CancelToken::default();
	let abort_token = cancel_token.emplace_abort_token();
	let cancel_task = tokio::spawn(async move {
		time::sleep(Duration::from_millis(10)).await;
		abort_token.abort(AbortReason::Signal);
	});
	let (result, output) =
		run_command_capture("sleep 1 && printf later", None, Some(minimizer), cancel_token).await;
	let _ = cancel_task.await;
	let _ = std::fs::remove_dir_all(&root);
	assert!(result.exit_code.is_none());
	assert!(result.cancelled);
	assert!(!result.timed_out);
	assert!(result.minimized.is_none());
	assert!(!output.contains("later"));
}
/// End-to-end verification that the embedded shell, as `create_session`
/// builds it, spawns external commands in a **separate session** from the
/// host.
///
/// It boots a real session, runs a child that prints its PID then sleeps,
/// and asks the kernel for that PID's session via `getsid(2)` while the
/// child is still alive. A child left in the host's session would report
/// `getsid(child_pid) == getsid(0)`; with `setsid` the child is its own
/// session leader (`getsid(child_pid) == child_pid`).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn embedded_external_command_runs_in_its_own_session() {
	use std::io::Read as _;

	// SAFETY: `getsid(0)` only queries the current process session; the
	// return value is checked. Inside a PID namespace (the containerized CI
	// runner) the host's session leader can live outside the namespace, so
	// `getsid(0)` legitimately reports 0 — only -1 is a real failure. The
	// child-session invariants below (own session, distinct from host) stay
	// meaningful.
	let host_sid = unsafe { libc::getsid(0) };
	assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

	// Build the same kind of session pi-natives uses in production.
	let mut session = default_session().await;

	// Output pipe shared between the child and a concurrent reader. The
	// reader runs on a blocking thread because pipe reads are blocking. The
	// run holds its own duplicates of the write end, so the reader sees EOF
	// once the run ends.
	let (mut reader, writer) = pipe_to_files("e2e").expect("pipe");
	let stdio = TestStdio::null().stdout(&writer).stderr(&writer);
	drop(writer);

	// (pid_tx, pid_rx) — reader task signals the test as soon as it has the
	// PID.
	let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
	let reader_handle = tokio::task::spawn_blocking(move || {
		let mut buf = Vec::new();
		// Read just enough to capture the PID line. The child sleeps after
		// printing so the pipe will not back-pressure.
		let mut chunk = [0u8; 64];
		let mut pid_tx = Some(pid_tx);
		while let Ok(n) = reader.read(&mut chunk)
			&& n > 0
		{
			buf.extend_from_slice(&chunk[..n]);
			if pid_tx.is_some()
				&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
				&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
				&& let Ok(pid) = line.trim().parse::<i32>()
			{
				let _ = pid_tx
					.take()
					.expect("pid sender should be present")
					.send(pid);
			}
		}
		buf
	});

	// Run the session in the background so we can call `getsid(child_pid)`
	// while the child is still alive.
	let shell_handle = tokio::spawn(async move {
		// `printf '%d\n' "$$"` then `sleep 0.5`. Long enough for our `getsid`.
		let exec = session
			.run_test("sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'", &stdio)
			.await
			.expect("run_test");
		drop(stdio);
		(session, exec)
	});

	let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
		.await
		.expect("timed out waiting for child PID")
		.expect("reader closed pid channel without sending");
	assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

	// Snapshot the child's session ID immediately, while the child is still
	// in `sleep`. POSIX guarantees `getsid` against a live PID returns the
	// session of that process.
	// SAFETY: `child_pid` is a positive PID from the child; errors are
	// reported via the checked return value.
	let child_sid = unsafe { libc::getsid(child_pid) };
	assert!(
		child_sid > 0,
		"getsid({child_pid}) failed: {} (child may have already exited)",
		std::io::Error::last_os_error(),
	);

	// Drain the session task and the pipe reader.
	let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
		.await
		.expect("shell timed out")
		.expect("shell task panicked");
	assert_eq!(exec.status, 0, "unexpected exit: {}", exit_code(&exec));
	let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

	assert_ne!(
		child_sid, host_sid,
		"child PID {child_pid} inherited host session {host_sid}; setsid() did not run — the \
		 embedded-host bug is back",
	);
	assert_eq!(
		child_sid, child_pid,
		"child PID {child_pid} should be its own session leader after setsid",
	);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn cancellation_allows_background_term_cleanup_while_builtin_is_running() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("cleanup directory");
	let script = root.path().join("cleanup.sh");
	fs::write(
		&script,
		"trap 'sleep 0.2; printf cleaned >> cleaned; exit 0' TERM\n: > ready\nwhile :; do :; done\n",
	)
	.expect("cleanup script");
	let shell = Shell::new(None);
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let cwd = root.path().to_str().expect("utf8 cwd").to_owned();
	let task = tokio::spawn(async move {
		shell
			.run(
				ShellRunOptions {
					command: "sh cleanup.sh & sleep 30".into(),
					cwd: Some(cwd),
					..Default::default()
				},
				None,
				cancel,
			)
			.await
	});
	time::timeout(Duration::from_secs(5), async {
		while !root.path().join("ready").exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("background child ready");
	abort.abort(AbortReason::Signal);
	let result = time::timeout(Duration::from_secs(5), task)
		.await
		.expect("cancel finished")
		.expect("run task")
		.expect("shell result");
	assert!(result.cancelled);
	assert_eq!(fs::read_to_string(root.path().join("cleaned")).expect("TERM cleanup"), "cleaned");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn cancellation_keeps_output_open_for_a_term_trap_that_writes() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("cleanup directory");
	// The trap writes once the readers' old 500 ms cancel would have closed
	// them, and finishes well inside the 1 s TERM grace even when a loaded
	// runner is slow to start `sleep`.
	fs::write(
		root.path().join("cleanup.sh"),
		"trap 'sleep 0.55; echo flushing; printf cleaned > cleaned; exit 0' TERM\n: > ready\nwhile \
		 :; do :; done\n",
	)
	.expect("cleanup script");
	let shell = Shell::new(None);
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let cwd = root.path().to_str().expect("utf8 cwd").to_owned();
	let task = tokio::spawn(async move {
		shell
			.run(
				ShellRunOptions {
					command: "sh cleanup.sh".into(),
					cwd: Some(cwd),
					..Default::default()
				},
				None,
				cancel,
			)
			.await
	});
	time::timeout(Duration::from_secs(5), async {
		while !root.path().join("ready").exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("child ready");
	abort.abort(AbortReason::Signal);
	let result = time::timeout(Duration::from_secs(5), task)
		.await
		.expect("cancel finished")
		.expect("run task")
		.expect("shell result");
	assert!(result.cancelled);
	assert_eq!(
		fs::read_to_string(root.path().join("cleaned")).expect("TERM cleanup after writing output"),
		"cleaned"
	);
}

/// A cancelled run whose child exits on TERM returns as soon as the child
/// is gone, without waiting out the 1 s grace before KILL.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn termination_returns_early_after_the_child_exits() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("scratch directory");
	let shell = Shell::new(None);
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let cwd = root.path().to_str().expect("utf8 cwd").to_owned();
	let task = tokio::spawn(async move {
		shell
			.run(
				ShellRunOptions {
					command: "sh -c ': > ready; exec sleep 30'".into(),
					cwd: Some(cwd),
					..Default::default()
				},
				None,
				cancel,
			)
			.await
	});
	time::timeout(Duration::from_secs(5), async {
		while !root.path().join("ready").exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("child ready");
	let started = time::Instant::now();
	abort.abort(AbortReason::Signal);
	let result = time::timeout(Duration::from_secs(5), task)
		.await
		.expect("cancel finished")
		.expect("run task")
		.expect("shell result");
	assert!(result.cancelled);
	assert!(started.elapsed() < Duration::from_millis(750), "exited child consumed TERM grace");
}

/// Cancelling one `Shell::run` must only signal processes spawned by that
/// run. Run B starts first so its old host-descendant baseline would not
/// include run A's later-spawned child; pre-fix, cancelling B classified A's
/// child as "new" and SIGTERM'd it, so run A returned 143 instead of 0.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_one_run_spares_a_concurrent_runs_child() {
	let _guard = shell_test_lock().lock().await;

	let shell_b = Shell::new(None);
	let (tx_b, rx_b) = flume::unbounded::<String>();
	let mut ct_b = CancelToken::default();
	let abort_b = ct_b.emplace_abort_token();
	let handle_b = tokio::spawn(async move {
		shell_b
			.run(
				ShellRunOptions {
					command: "sh -c 'printf \"ready\\n\"; sleep 30'".into(),
					..Default::default()
				},
				Some(tx_b),
				ct_b,
			)
			.await
	});

	let mut b_output = String::new();
	let b_ready = time::timeout(Duration::from_secs(5), async {
		loop {
			let chunk = rx_b
				.recv_async()
				.await
				.expect("run B ended before printing readiness");
			b_output.push_str(&chunk);
			if let Some(line_end) = b_output.find('\n') {
				return b_output[..line_end].to_string();
			}
		}
	})
	.await
	.expect("timed out waiting for run B readiness");
	assert_eq!(b_ready.trim(), "ready", "run B should reach its long sleep before run A starts");

	let shell_a = Shell::new(None);
	let (tx_a, rx_a) = flume::unbounded::<String>();
	let handle_a = tokio::spawn(async move {
		shell_a
			.run(
				ShellRunOptions {
					command: "sh -c 'printf \"%d\\n\" \"$$\"; sleep 2'".into(),
					..Default::default()
				},
				Some(tx_a),
				CancelToken::default(),
			)
			.await
	});

	let mut a_output = String::new();
	let a_child_pid = time::timeout(Duration::from_secs(5), async {
		loop {
			let chunk = rx_a
				.recv_async()
				.await
				.expect("run A ended before printing its child pid");
			a_output.push_str(&chunk);
			if let Some(line_end) = a_output.find('\n') {
				return a_output[..line_end]
					.trim()
					.parse::<i32>()
					.expect("run A pid line should be an integer");
			}
		}
	})
	.await
	.expect("timed out waiting for run A child pid");
	assert!(a_child_pid > 0, "got non-positive run A child pid: {a_child_pid}");

	abort_b.abort(AbortReason::Signal);

	let result_a = time::timeout(Duration::from_secs(10), handle_a)
		.await
		.expect("run A timed out")
		.expect("run A task panicked")
		.expect("run A failed");
	let result_b = time::timeout(Duration::from_secs(10), handle_b)
		.await
		.expect("run B timed out")
		.expect("run B task panicked")
		.expect("run B failed");

	assert_eq!(result_a.exit_code, Some(0), "cancelling run B must not SIGTERM run A's child");
	assert!(!result_a.cancelled, "run A was never cancelled");
	assert!(result_b.cancelled, "run B should report cancellation");
}

/// Cancelling while `Shell::run` is still sourcing a snapshot must terminate
/// the foreground process spawned by that snapshot. The snapshot runs before
/// the user command, so this specifically guards the shared cancel token and
/// spawn registry wiring passed into `source_snapshot`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_while_sourcing_snapshot_kills_snapshot_foreground_child() {
	let _guard = shell_test_lock().lock().await;
	let root = unique_temp_dir("snapshot-cancel");
	let snapshot_path = root.join("snapshot.sh");
	let pid_path = root.join("snapshot-child.pid");
	let escaped_pid_path = pid_path.to_string_lossy().replace('\'', "'\\''");
	std::fs::write(
		&snapshot_path,
		format!("sh -c 'printf \"%d\\n\" \"$$\" > \"$1\"; sleep 30' sh '{escaped_pid_path}'\n"),
	)
	.expect("write snapshot file");

	let shell = Shell::new(Some(ShellOptions {
		snapshot_path: Some(snapshot_path.to_string_lossy().into_owned()),
		..Default::default()
	}));
	let mut cancel_token = CancelToken::default();
	let abort_token = cancel_token.emplace_abort_token();
	let run_handle = tokio::spawn(async move {
		shell
			.run(
				ShellRunOptions { command: "printf done".into(), ..Default::default() },
				None,
				cancel_token,
			)
			.await
	});

	let child_pid = time::timeout(Duration::from_secs(5), async {
		loop {
			if let Ok(pid_text) = std::fs::read_to_string(&pid_path)
				&& let Ok(pid) = pid_text.trim().parse::<i32>()
				&& pid > 0
			{
				return pid;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await
	.expect("timed out waiting for snapshot foreground child to write its positive PID");

	abort_token.abort(AbortReason::Signal);

	let result = time::timeout(Duration::from_secs(10), run_handle)
		.await
		.expect("timed out waiting for cancellation while sourcing snapshot")
		.expect("snapshot sourcing run task panicked")
		.expect("shell run failed while cancelling snapshot sourcing");
	assert!(result.cancelled, "cancelling while sourcing a snapshot should report cancellation");
	assert_eq!(
		result.exit_code, None,
		"cancelled snapshot sourcing run should not report an exit code"
	);
	assert!(
		!result.timed_out,
		"signal cancellation during snapshot sourcing must not report timeout"
	);

	let child_dead = time::timeout(Duration::from_secs(5), async {
		loop {
			// SAFETY: `child_pid` came from the foreground `sh` spawned by the
			// snapshot; `kill(pid, 0)` only probes whether that process still
			// exists.
			let kill_result = unsafe { libc::kill(child_pid, 0) };
			if kill_result == -1 {
				let err = std::io::Error::last_os_error();
				if err.raw_os_error() == Some(libc::ESRCH) {
					return;
				}
				panic!(
					"kill({child_pid}, 0) failed with unexpected error while checking snapshot child \
					 cleanup: {err}"
				);
			}
			time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await;
	let _ = std::fs::remove_dir_all(&root);
	assert!(
		child_dead.is_ok(),
		"snapshot foreground child PID {child_pid} was still alive after cancelling while sourcing \
		 snapshot; cancel bridge did not terminate the snapshot-spawned process"
	);
}

/// Regression for the `suspended (tty input)` bug: an **interactive child
/// inside a pipeline** (`zsh -i ... | awk`) used to stay in the host
/// session, open `/dev/tty`, `tcsetpgrp` itself to the foreground, and
/// leave the embedded host (OMP) stopped on its next tty read. The earlier
/// embedded-host fix carved pipelines out of `detach_session` because a
/// later stage that `setpgid`-joined a detached leader failed with EPERM.
///
/// This test boots a real embedded session and runs a two-stage
/// pipeline whose first stage prints its PID then sleeps (forwarded to us
/// by `cat`). It asserts two contracts at once:
///   1. the first stage runs in its **own session** (`getsid == own pid`), so
///      it can never reach the host's controlling tty — guards the decision;
///      and
///   2. the pipeline still exits **successfully**, proving the second stage
///      spawned without the cross-session `setpgid` EPERM — guards the wiring
///      that skips `process_group(...)` for detached children.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn embedded_pipeline_stage_runs_in_its_own_session() {
	use std::io::Read as _;

	// SAFETY: `getsid(0)` only queries the current process session; checked
	// below. In a PID namespace (containerized CI) the host's session leader
	// can live outside the namespace, so `getsid(0)` reports 0, not an error;
	// only -1 is a real failure.
	let host_sid = unsafe { libc::getsid(0) };
	assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

	let mut session = default_session().await;

	// The run holds its own duplicates of the write end, so the reader sees
	// EOF once the run ends.
	let (mut reader, writer) = pipe_to_files("e2e-pipe").expect("pipe");
	let stdio = TestStdio::null().stdout(&writer).stderr(&writer);
	drop(writer);

	let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
	let reader_handle = tokio::task::spawn_blocking(move || {
		let mut buf = Vec::new();
		let mut chunk = [0u8; 64];
		let mut pid_tx = Some(pid_tx);
		while let Ok(n) = reader.read(&mut chunk)
			&& n > 0
		{
			buf.extend_from_slice(&chunk[..n]);
			if pid_tx.is_some()
				&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
				&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
				&& let Ok(pid) = line.trim().parse::<i32>()
			{
				let _ = pid_tx
					.take()
					.expect("pid sender should be present")
					.send(pid);
			}
		}
		buf
	});

	let shell_handle = tokio::spawn(async move {
		// First stage prints its own PID and sleeps; `sh -c cat` forwards
		// the PID line to our reader and exits on EOF. The first stage
		// leads the pipeline's process group, while the second stage is the
		// join-or-detach process that would EPERM without the wiring fix.
		let exec = session
			.run_test("sh -c 'printf \"%d\\n\" \"$$\"; sleep 1' | sh -c cat", &stdio)
			.await
			.expect("run_test");
		drop(stdio);
		(session, exec)
	});

	let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
		.await
		.expect("timed out waiting for first-stage PID")
		.expect("reader closed pid channel without sending");
	assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

	// SAFETY: `child_pid` is a live positive PID (still in `sleep`); the
	// return value is checked.
	let child_sid = unsafe { libc::getsid(child_pid) };
	assert!(
		child_sid > 0,
		"getsid({child_pid}) failed: {} (child may have already exited)",
		std::io::Error::last_os_error(),
	);

	let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
		.await
		.expect("shell timed out")
		.expect("shell task panicked");
	// Guards the wiring: the second stage spawned without a cross-session
	// `setpgid` EPERM, so the whole pipeline succeeded.
	assert_eq!(
		exec.status,
		0,
		"pipeline did not succeed (second stage may have hit setpgid EPERM): {}",
		exit_code(&exec),
	);
	let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

	// Guards the decision: a pipeline stage must not share the host session,
	// or it could seize the controlling tty and SIGTTIN the host.
	assert_ne!(
		child_sid, host_sid,
		"pipeline stage PID {child_pid} inherited host session {host_sid}; it could seize the \
		 controlling tty — the pipeline tty-suspend bug is back",
	);
	assert_eq!(
		child_sid, child_pid,
		"pipeline stage PID {child_pid} should be its own session leader after setsid",
	);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn wait_accepts_last_background_process_id() {
	let options = ShellExecuteOptions {
		command: "sh -c 'exit 7' & mover=$!; wait \"$mover\"".to_string(),
		..Default::default()
	};

	let result = execute_shell(options, None, CancelToken::default())
		.await
		.expect("execute should succeed");

	assert_eq!(result.exit_code, Some(7));
	assert!(!result.cancelled);
	assert!(!result.timed_out);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn wait_n_p_records_completed_process_id() {
	let options = ShellExecuteOptions {
		command: "sh -c 'sleep 0.2; exit 42' & slow=$!; sh -c 'exit 13' & fast=$!; wait -n -p hit \
		          \"$slow\" \"$fast\"; status=$?; wait \"$slow\"; [ \"$status\" -eq 13 ] && [ \
		          \"$hit\" = \"$fast\" ]"
			.to_string(),
		..Default::default()
	};

	let result = execute_shell(options, None, CancelToken::default())
		.await
		.expect("execute should succeed");

	assert_eq!(result.exit_code, Some(0));
	assert!(!result.cancelled);
	assert!(!result.timed_out);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn wait_f_accepts_process_id() {
	let options = ShellExecuteOptions {
		command: "sh -c 'exit 5' & child=$!; wait -f \"$child\"".to_string(),
		..Default::default()
	};

	let result = execute_shell(options, None, CancelToken::default())
		.await
		.expect("execute should succeed");

	assert_eq!(result.exit_code, Some(5));
	assert!(!result.cancelled);
	assert!(!result.timed_out);
}
#[tokio::test]
async fn abort_state_signals_cancel_token() {
	let abort_state = ShellAbortState::default();
	let mut cancel_token = CancelToken::default();
	let abort_token = cancel_token.emplace_abort_token();

	abort_state.set(abort_token).await;
	abort_state.abort().await;

	let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
		.await
		.expect("cancel token should be signalled");
	assert!(matches!(reason, AbortReason::Signal));
}

#[cfg(unix)]
#[tokio::test]
async fn read_output_stops_when_cancelled_before_pipe_eof() {
	let (reader, _writer) = pipe_to_files("test").expect("test pipe should be created");
	let cancel = CancellationToken::new();
	let (activity_tx, _activity_rx) = flume::bounded(1);
	let handle = tokio::spawn(read_output(reader, None, cancel.clone(), activity_tx));

	time::sleep(Duration::from_millis(10)).await;
	cancel.cancel();

	time::timeout(Duration::from_millis(100), handle)
		.await
		.expect("reader task should stop after cancellation")
		.expect("reader task should not panic");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_streams_separates_stdout_and_stderr() {
	let (stdout_tx, stdout_rx) = flume::unbounded::<Bytes>();
	let (stderr_tx, stderr_rx) = flume::unbounded::<Bytes>();
	let options =
		ShellExecuteOptions { command: "echo out; echo err 1>&2".to_string(), ..Default::default() };
	let streams = StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) };
	let result = execute_shell_streams(options, streams, CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.cancelled);

	let mut stdout = Vec::new();
	while let Ok(chunk) = stdout_rx.recv_async().await {
		stdout.extend_from_slice(&chunk);
	}
	let mut stderr = Vec::new();
	while let Ok(chunk) = stderr_rx.recv_async().await {
		stderr.extend_from_slice(&chunk);
	}
	assert_eq!(stdout, b"out\n");
	assert_eq!(stderr, b"err\n");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_streams_works_when_sinks_are_none() {
	// Both sinks `None` — pipes must still drain so the child can exit.
	let options = ShellExecuteOptions {
		command: "yes done | head -n 100 1>&2; echo final".to_string(),
		..Default::default()
	};
	let result = execute_shell_streams(options, StreamSinks::default(), CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));
}

/// The shell expands `$env:NAME` against the `env` shell variable by default,
/// collapsing PowerShell references like `Write-Host $env:OMPCODE` to
/// `:OMPCODE`. The session-level fallback below defines `env=$env` so the
/// expansion is the literal `$env:OMPCODE`, preserving the PowerShell
/// token when the command is forwarded to a child shell.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn powershell_env_reference_survives_expansion() {
	let (tx, rx) = flume::unbounded::<Bytes>();
	let options = ShellExecuteOptions {
		command: "printf '%s' \"$env:SystemRoot\"".to_string(),
		..Default::default()
	};
	let streams = StreamSinks { stdout: Some(tx), stderr: None };
	let result = execute_shell_streams(options, streams, CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));

	let mut stdout = Vec::new();
	while let Ok(chunk) = rx.recv_async().await {
		stdout.extend_from_slice(&chunk);
	}
	assert_eq!(stdout, b"$env:SystemRoot");
}

/// A user assignment to `env` in the command itself must shadow the
/// session-level fallback so callers that genuinely use a POSIX variable
/// named `env` see their value, not the literal `$env`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn user_env_assignment_shadows_powershell_fallback() {
	let (tx, rx) = flume::unbounded::<Bytes>();
	let options = ShellExecuteOptions {
		command: "env=prod; printf '%s' \"$env:8080\"".to_string(),
		..Default::default()
	};
	let streams = StreamSinks { stdout: Some(tx), stderr: None };
	let result = execute_shell_streams(options, streams, CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));

	let mut stdout = Vec::new();
	while let Ok(chunk) = rx.recv_async().await {
		stdout.extend_from_slice(&chunk);
	}
	assert_eq!(stdout, b"prod:8080");
}

/// Quoted heredoc delimiters at EOF must behave like bash. The previous
/// parser rejected that shape unless the input stream ended with a newline,
/// which surfaced as `unterminated here document sequence; tag(s) [...]` for
/// normal paste-run Python snippets.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn quoted_heredoc_without_trailing_newline_runs() {
	let (result, output) =
		run_command_capture("cat <<'PY'\nhello $USER\nPY", None, None, CancelToken::default()).await;

	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, "hello $USER\n");
}

/// Regression for a Windows/macOS deadlock in
/// the shell's here-document setup (the old interpreter's
/// `setup_open_file_with_contents`). The body is
/// 256 KiB — well past the default pipe buffer on every platform
/// (Windows ~4 KiB, macOS 16-64 KiB, Linux 64 KiB), so any inline
/// `write_all` on the calling thread blocks forever. The `:` builtin
/// never reads its stdin, so the only way `echo done` runs is if the
/// heredoc writer is decoupled from the main thread (or, on Linux,
/// the pipe buffer was grown via `F_SETPIPE_SZ`). The
/// `tokio::time::timeout` is the safety net that turns a regression
/// into a 10 s failure instead of hanging CI for the full
/// hard-timeout window.
#[tokio::test(flavor = "multi_thread")]
async fn large_heredoc_does_not_deadlock() {
	let body = "X".repeat(256 * 1024);
	let command = format!(": <<'EOF'\n{body}\nEOF\necho done");
	let options = ShellExecuteOptions { command, ..Default::default() };

	let result =
		time::timeout(Duration::from_secs(10), execute_shell(options, None, CancelToken::default()))
			.await
			.expect("execute_shell hung past 10 s — heredoc writer deadlocked")
			.expect("execute_shell errored");

	assert_eq!(result.exit_code, Some(0), "command did not run to completion");
}

/// The `nohup` builtin runs its operand command and surfaces that command's
/// own exit status — not nohup's (`125`/`126`/`127`) error codes.
#[tokio::test(flavor = "multi_thread")]
async fn nohup_builtin_propagates_command_exit_code() {
	let command = if cfg!(windows) {
		"nohup cmd /C exit 7"
	} else {
		"nohup sh -c 'exit 7'"
	};
	let options = ShellExecuteOptions { command: command.to_string(), ..Default::default() };
	let result = execute_shell(options, None, CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(7));
	assert!(!result.cancelled);
	assert!(!result.timed_out);
}

/// `nohup` is a no-op builtin in this embedded shell, but `nohup cmd &`
/// must still behave like a process-launching background command for `$!`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn nohup_background_captures_operand_pid() {
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellExecuteOptions {
		command: "nohup sh -c 'exit 0' >/dev/null 2>&1 & pid=$!; printf 'pid=%s\n' \"$pid\"; test \
		          -n \"$pid\""
			.to_string(),
		..Default::default()
	};
	let result = execute_shell(options, Some(tx), CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.cancelled);
	assert!(!result.timed_out);

	let mut out = String::new();
	while let Ok(chunk) = rx.recv_async().await {
		out.push_str(&chunk);
	}
	let pid = out
		.trim()
		.strip_prefix("pid=")
		.expect("nohup background PID output should include pid= prefix");
	assert!(pid.parse::<i32>().is_ok_and(|pid| pid > 0), "invalid PID output: {out:?}");
}

/// `nohup` with no operand mirrors coreutils: a `missing operand` diagnostic
/// and exit code 125 (a nohup-level error, distinct from any command code).
#[tokio::test(flavor = "multi_thread")]
async fn nohup_builtin_without_command_reports_missing_operand() {
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellExecuteOptions { command: "nohup".to_string(), ..Default::default() };
	let result = execute_shell(options, Some(tx), CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(125));
	let mut out = String::new();
	while let Ok(chunk) = rx.recv_async().await {
		out.push_str(&chunk);
	}
	assert!(out.contains("missing operand"), "expected a missing-operand diagnostic, got: {out:?}");
}

/// The contract that makes this a *builtin* and not the external tool: the
/// child must **not** inherit `SIGHUP = SIG_IGN`. Real `nohup` masks SIGHUP
/// (and it survives `exec`), so a process launched through `/usr/bin/nohup`
/// reports `IGN` here; the builtin runs the command as an ordinary
/// descendant, so it reports `DFL` and dies with the host on hangup. The
/// probe needs `getsid`-style signal introspection, so it is gated on
/// `python3` (skipped, not failed, when absent — matching the embedded
/// session-detach e2e suite).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn nohup_builtin_does_not_mask_sighup() {
	let python_ok = std::process::Command::new("python3")
		.arg("-c")
		.arg("pass")
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.status()
		.is_ok_and(|status| status.success());
	if !python_ok {
		eprintln!("skipping nohup_builtin_does_not_mask_sighup: python3 unavailable");
		return;
	}

	let probe = "import signal,sys; sys.stdout.write('IGN' if \
	             signal.getsignal(signal.SIGHUP)==signal.SIG_IGN else 'DFL')";
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellExecuteOptions {
		command: format!("nohup python3 -c \"{probe}\""),
		..Default::default()
	};
	let result = execute_shell(options, Some(tx), CancelToken::default())
		.await
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));
	let mut out = String::new();
	while let Ok(chunk) = rx.recv_async().await {
		out.push_str(&chunk);
	}
	assert!(
		out.contains("DFL") && !out.contains("IGN"),
		"builtin nohup masked SIGHUP like the external tool (output: {out:?})",
	);
}

/// Regression for #4078: the JS bridge hands the pipe readers a *bounded*
/// chunk channel. With a consumer slower than the producer the readers
/// must park on `send_async` (backpressuring the child through its pipe)
/// rather than buffer unboundedly — and, unlike a drop-on-full design,
/// every produced byte must still reach the consumer.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn streaming_output_backpressures_on_bounded_channel_without_loss() {
	const TOTAL_BYTES: usize = 1_048_576;
	let (tx, rx) = flume::bounded::<String>(4);
	let options = ShellExecuteOptions {
		command: format!("yes x | head -c {TOTAL_BYTES}"),
		..Default::default()
	};
	let run = tokio::spawn(execute_shell(options, Some(tx), CancelToken::default()));

	let mut received = 0usize;
	while let Ok(chunk) = rx.recv_async().await {
		received += chunk.len();
		// Slow consumer: forces the bounded queue to fill and the readers
		// to park between chunks.
		time::sleep(Duration::from_micros(50)).await;
	}

	let result = time::timeout(Duration::from_secs(30), run)
		.await
		.expect("command should finish despite backpressure")
		.expect("run task should not panic")
		.expect("execute should succeed");
	assert_eq!(result.exit_code, Some(0));
	assert!(!result.cancelled);
	assert!(!result.timed_out);
	assert_eq!(received, TOTAL_BYTES, "streamed bytes were dropped under backpressure");
}

/// The point of the tap: while `tail` holds its input back, the bytes the
/// producer already wrote are readable as stream 1.
#[tokio::test(flavor = "multi_thread")]
async fn pipe_tap_exposes_input_a_later_stage_holds_back() {
	let _guard = shell_test_lock().lock().await;
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let (taps, run, rx) = run_tapped("{ printf 'a\\nb\\nc\\n'; sleep 30; } | tail -n 1", cancel);

	let seen = time::timeout(Duration::from_secs(10), async {
		loop {
			if let Some(read) = taps.read(1, None)
				&& read.data == b"a\nb\nc\n"
			{
				return read;
			}
			time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await
	.expect("producer output never reached stream 1");
	assert!(seen.open);
	assert!(rx.try_recv().is_err(), "tail printed before its input ended");
	let [stream] = taps.list().try_into().expect("one pipe");
	assert!(stream.producer.contains("printf"), "producer text: {}", stream.producer);
	assert!(stream.consumer.contains("tail"), "consumer text: {}", stream.consumer);

	abort.abort(AbortReason::Signal);
	let result = time::timeout(Duration::from_secs(10), run)
		.await
		.expect("run did not stop after abort")
		.expect("run task panicked")
		.expect("run");
	assert!(result.cancelled);
	assert!(!taps.read(1, None).expect("stream 1").open);
}

/// A consumer that exits early still ends the pipeline at once through a
/// tapped pipe: the relay lets go of the producer's end when `head`
/// leaves, so `tail -f` (idle, no further writes) sees its pipe widowed.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pipe_tap_widows_the_producer_when_the_consumer_exits() {
	let _guard = shell_test_lock().lock().await;
	let log = tempfile::NamedTempFile::new().expect("log file");
	std::fs::write(log.path(), "first\nsecond\n").expect("write log");
	let command = format!("tail -f {} | head -n 1", quote_arg(&log.path().to_string_lossy()));
	let (_taps, run, rx) = run_tapped(&command, CancelToken::default());

	let result = time::timeout(Duration::from_secs(10), run)
		.await
		.expect("tail -f kept following after head exited")
		.expect("run task panicked")
		.expect("run");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(collect_output(&rx).await, "first\n");
}

/// Every byte reaches the consumer unchanged, and the stream counts all of
/// them while retaining only its newest megabyte.
#[tokio::test(flavor = "multi_thread")]
async fn pipe_tap_forwards_every_byte_and_counts_them() {
	let _guard = shell_test_lock().lock().await;
	const LAST: usize = 200_000;
	let (taps, run, rx) = run_tapped(&format!("seq 1 {LAST} | wc -l"), CancelToken::default());

	let result = time::timeout(Duration::from_secs(30), run)
		.await
		.expect("run did not finish")
		.expect("run task panicked")
		.expect("run");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(collect_output(&rx).await.trim(), LAST.to_string());
	let written: usize = (1..=LAST).map(|n| n.to_string().len() + 1).sum();
	let read = taps.read(1, None).expect("stream 1");
	assert_eq!(read.end, written as u64);
	assert_eq!(read.data.len(), written.min(1 << 20));
	assert!(read.data.ends_with(format!("\n{LAST}\n").as_bytes()));
	assert!(!read.open);
}
