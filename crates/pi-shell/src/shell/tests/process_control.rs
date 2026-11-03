use tokio::process::Command;

use super::*;

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pgrep_matches_name_and_pkills_signal_probe() {
	let (_dir, command, name) = process_test_command("opg");
	let mut child = process_test_child(&command, Duration::from_secs(30))
		.spawn()
		.expect("matching process");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	wait_for_process_name(pid, &name).await;

	let (pgrep_result, output) = execute_captured(format!("pgrep -x -p {pid} {name}")).await;
	let (pkill_result, pkill_output) =
		execute_captured(format!("pkill -0 -x -p {pid} {name}")).await;

	let still_running = child.try_wait().expect("probe child status").is_none();
	let _ = child.start_kill();
	let _ = child.wait().await;
	assert_eq!(pgrep_result.exit_code, Some(0));
	assert_eq!(output, format!("{pid}\n"));
	assert_eq!(pkill_result.exit_code, Some(0));
	assert_eq!(pkill_output, "");
	assert!(still_running, "signal 0 must not terminate a matching process");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pkill_accepts_platform_signal_names() {
	#[cfg(target_os = "macos")]
	let signal = "INFO";
	#[cfg(not(target_os = "macos"))]
	let signal = "WINCH";
	let dir = tempfile::tempdir().expect("signal test directory");
	let ready = dir.path().join("ready");
	let script = format!("trap '' {signal}; : > \"$1\"; while :; do sleep 0.05; done");
	let mut command = Command::new("sh");
	command
		.args(["-c", &script, "sh", ready.to_str().expect("utf8 ready path")])
		.kill_on_drop(true);
	let mut child = command.spawn().expect("signal test process");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	time::timeout(Duration::from_secs(2), async {
		while !ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("signal trap was not installed");

	let (result, _) = execute_captured(format!("pkill -{signal} -p {pid}")).await;
	let still_running = child.try_wait().expect("signal child status").is_none();
	let _ = child.start_kill();
	let _ = child.wait().await;
	assert_eq!(result.exit_code, Some(0));
	assert!(still_running, "{signal} should be ignored by the test process");
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn pkill_queue_option_consumes_its_value() {
	let (_dir, command, name) = process_test_command("opq");
	let mut command = process_test_child(&command, Duration::from_secs(30));
	command.kill_on_drop(true);
	let mut child = command.spawn().expect("queue test process");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	wait_for_process_name(pid, &name).await;

	let (result, output) = execute_captured(format!("pkill -0 -q 37 -x -p {pid} {name}")).await;
	let still_running = child.try_wait().expect("queue child status").is_none();
	let _ = child.start_kill();
	let _ = child.wait().await;
	assert_eq!(result.exit_code, Some(0));
	assert!(output.is_empty());
	assert!(still_running, "queued signal 0 must only probe the process");
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn pkill_interactive_prompt_honors_cancellation() {
	let (_dir, command, name) = process_test_command("opi");
	let mut command = process_test_child(&command, Duration::from_secs(30));
	command.kill_on_drop(true);
	let mut child = command.spawn().expect("interactive target");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	wait_for_process_name(pid, &name).await;

	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let execution = tokio::spawn(execute_shell(
		ShellExecuteOptions {
			command: format!("sleep 30 | pkill -I -x -p {pid} {name}"),
			..Default::default()
		},
		None,
		cancel,
	));
	time::sleep(Duration::from_millis(100)).await;
	abort.abort(crate::cancel::AbortReason::User);
	let result = time::timeout(Duration::from_secs(2), execution)
		.await
		.expect("interactive pkill remained blocked after cancellation")
		.expect("interactive execution task")
		.expect("interactive shell execution");
	let still_running = child
		.try_wait()
		.expect("interactive target status")
		.is_none();
	let _ = child.start_kill();
	let _ = child.wait().await;
	assert_ne!(result.exit_code, Some(0));
	assert!(still_running, "cancelled pkill must not signal its pending target");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pgrep_reads_pidfile_from_standard_input() {
	let (_dir, command, name) = process_test_command("opf");
	let mut child = process_test_child(&command, Duration::from_secs(30))
		.spawn()
		.expect("pidfile process");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	wait_for_process_name(pid, &name).await;

	let (result, output) =
		execute_captured(format!("printf '%s\\n' {pid} | pgrep -F - -x {name}")).await;
	let _ = child.start_kill();
	let _ = child.wait().await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, format!("{pid}\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pgrep_requires_an_externally_locked_pidfile() {
	let python = Command::new("python3").arg("--version").output().await;
	if !python.is_ok_and(|output| output.status.success()) {
		eprintln!("skipping pgrep_requires_an_externally_locked_pidfile: python3 unavailable");
		return;
	}

	let (_dir, command, name) = process_test_command("opl");
	let mut child = process_test_child(&command, Duration::from_secs(30))
		.spawn()
		.expect("locked pidfile process");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	wait_for_process_name(pid, &name).await;

	let files = tempfile::tempdir().expect("pidfile directory");
	let pidfile = files.path().join("service.pid");
	let ready = files.path().join("locked");
	let pid_arg = pid.to_string();
	let mut locker = Command::new("python3")
		.args([
			"-c",
			"import fcntl,pathlib,sys,time; f=open(sys.argv[1],'w'); f.write(sys.argv[2]+'\\n'); \
			 f.flush(); fcntl.lockf(f,fcntl.LOCK_EX); pathlib.Path(sys.argv[3]).touch(); \
			 time.sleep(30)",
			pidfile.to_str().expect("utf8 pidfile"),
			&pid_arg,
			ready.to_str().expect("utf8 ready path"),
		])
		.spawn()
		.expect("pidfile locker");
	let ready_result = time::timeout(Duration::from_secs(2), async {
		while !ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await;
	if ready_result.is_err() {
		let _ = locker.start_kill();
		let _ = child.start_kill();
		let _ = locker.wait().await;
		let _ = child.wait().await;
		panic!("pidfile locker did not become ready");
	}

	let command =
		format!("pgrep -L -F {} -x {name}", quote_arg(pidfile.to_str().expect("utf8 pidfile")));
	let (locked_result, locked_output) = execute_captured(command.clone()).await;
	let _ = locker.start_kill();
	let _ = locker.wait().await;
	let (unlocked_result, unlocked_output) = execute_captured(command).await;
	let _ = child.start_kill();
	let _ = child.wait().await;

	assert_eq!(locked_result.exit_code, Some(0));
	assert_eq!(locked_output, format!("{pid}\n"));
	assert_eq!(unlocked_result.exit_code, Some(3));
	assert!(unlocked_output.contains("is not locked"), "{unlocked_output:?}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pkill_signals_every_matching_process() {
	let (_dir, command, name) = process_test_command("opk");
	let mut first = process_test_child(&command, Duration::from_secs(30))
		.spawn()
		.expect("first matching process");
	let mut second = process_test_child(&command, Duration::from_secs(30))
		.spawn()
		.expect("second matching process");
	let first_pid = i32::try_from(first.id().expect("first pid")).expect("pid fits i32");
	let second_pid = i32::try_from(second.id().expect("second pid")).expect("pid fits i32");
	wait_for_process_name(first_pid, &name).await;
	wait_for_process_name(second_pid, &name).await;

	let (result, output) = execute_captured(format!("pkill -TERM -x {name}")).await;
	let statuses =
		time::timeout(Duration::from_secs(2), async { tokio::join!(first.wait(), second.wait()) })
			.await;
	if statuses.is_err() {
		let _ = first.start_kill();
		let _ = second.start_kill();
		let _ = first.wait().await;
		let _ = second.wait().await;
	}
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, "");
	assert!(statuses.is_ok(), "pkill did not signal every matching process");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn pidwait_returns_after_the_matching_process_exits() {
	let (_dir, command, name) = process_test_command("opw");
	let mut command = process_test_child(&command, Duration::from_secs(30));
	command.kill_on_drop(true);
	let mut child = command.spawn().expect("waited process");
	let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
	wait_for_process_name(pid, &name).await;

	// `-e` reports selection before pidwait starts its exit wait. Seeing this
	// line proves it selected the still-live child, so the test can release
	// the child without a wall-clock race.
	// `-e` prints the kernel command name, which on macOS is the resolved
	// executable rather than the symlink name `-x` matches.
	let command_name = pi_builtins::ProcInfo::all()
		.into_iter()
		.find(|process| process.pid() == pid)
		.expect("waited process info")
		.command_name();
	let (tx, rx) = flume::unbounded();
	let waiting_for = format!("waiting for {command_name} (pid {pid})\n");
	let pidwait_command = format!("pidwait -e -x -p {pid} {name}");
	let mut pidwait = tokio::spawn(async move {
		execute_shell(
			ShellExecuteOptions { command: pidwait_command, ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("pidwait execution")
	});
	let mut output = String::new();
	time::timeout(Duration::from_secs(30), async {
		while !output.contains(&waiting_for) {
			output.push_str(
				&rx.recv_async()
					.await
					.expect("pidwait output closed before it selected the child"),
			);
		}
	})
	.await
	.expect("pidwait did not select the child");
	tokio::task::yield_now().await;
	assert!(!pidwait.is_finished(), "pidwait returned while its matching process was still running");
	assert!(
		child.try_wait().expect("waited child status").is_none(),
		"pidwait selected a child that already exited"
	);

	let _ = child.start_kill();
	let result = time::timeout(Duration::from_secs(30), &mut pidwait)
		.await
		.expect("pidwait did not return after its matching process exited")
		.expect("pidwait task");
	while let Ok(chunk) = rx.recv_async().await {
		output.push_str(&chunk);
	}
	let mut status = child.try_wait().expect("waited child status");
	if status.is_none() {
		let _ = child.start_kill();
		let _ = child.wait().await;
		status = child.try_wait().expect("reaped child status");
	}
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, waiting_for);
	assert!(status.is_some(), "pidwait returned while its matching process was still running");
}

#[tokio::test(flavor = "multi_thread")]
async fn ps_builtin_supports_common_bsd_and_posix_forms() {
	let pid = std::process::id();
	let (custom_result, custom) =
		execute_captured(format!("ps -p {pid} -o pid=,ppid=,stat=,comm=")).await;
	let (posix_result, posix) = execute_captured(format!("ps -ef -p {pid}")).await;
	let (bsd_result, bsd) = execute_captured(format!("ps aux -p {pid}")).await;

	assert_eq!(custom_result.exit_code, Some(0));
	assert_eq!(custom.lines().count(), 1);
	let mut fields = custom.split_whitespace();
	assert_eq!(fields.next(), Some(pid.to_string().as_str()));
	assert!(
		fields
			.next()
			.and_then(|value| value.parse::<i32>().ok())
			.is_some()
	);
	assert!(fields.next().is_some_and(|value| !value.is_empty()));
	assert!(fields.next().is_some_and(|value| !value.is_empty()));

	assert_eq!(posix_result.exit_code, Some(0));
	assert!(
		posix
			.lines()
			.next()
			.is_some_and(|line| line.contains("PPID"))
	);
	assert!(posix.lines().skip(1).any(|line| {
		line
			.split_whitespace()
			.any(|value| value == pid.to_string())
	}));

	assert_eq!(bsd_result.exit_code, Some(0));
	assert!(bsd.lines().next().is_some_and(|line| line.contains("%CPU")));
	assert!(bsd.lines().skip(1).any(|line| {
		line
			.split_whitespace()
			.any(|value| value == pid.to_string())
	}));
}

#[tokio::test(flavor = "multi_thread")]
async fn ps_builtin_formats_parseable_long_start_without_a_header() {
	let pid = std::process::id();
	let (result, output) = execute_captured(format!("ps -p {pid} -o lstart=")).await;
	assert_eq!(result.exit_code, Some(0));
	assert!(jiff::fmt::strtime::parse("%a %b %e %H:%M:%S %Y", output.trim()).is_ok(), "{output:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ps_builtin_supports_extended_format_specifiers() {
	let pid = std::process::id();
	let (result, output) = execute_captured(format!(
		"ps -p {pid} -o \
		 pid=,tpgid=,ruid=,rgid=,egid=,pri=,f=,min_flt=,maj_flt=,times=,sz=,s=,ruser=,rgroup=,tgid="
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	let fields: Vec<&str> = output.split_whitespace().collect();
	assert_eq!(fields.len(), 15, "{output:?}");
	assert_eq!(fields[0], pid.to_string());
	assert_eq!(fields[14], pid.to_string(), "tgid aliases pid");
	#[cfg(unix)]
	{
		// tpgid is an integer; -1 without a controlling terminal.
		assert!(fields[1].parse::<i32>().is_ok(), "tpgid: {:?}", fields[1]);
		for (index, name) in [(2, "ruid"), (3, "rgid"), (4, "egid")] {
			assert!(fields[index].parse::<u32>().is_ok(), "{name}: {:?}", fields[index]);
		}
		assert!(fields[5].parse::<i64>().is_ok(), "pri: {:?}", fields[5]);
		assert!(u64::from_str_radix(fields[6], 16).is_ok(), "flags: {:?}", fields[6]);
		assert!(fields[7].parse::<u64>().is_ok(), "min_flt: {:?}", fields[7]);
		assert!(fields[8].parse::<u64>().is_ok(), "maj_flt: {:?}", fields[8]);
		assert!(fields[9].parse::<u64>().is_ok(), "times: {:?}", fields[9]);
		assert!(fields[10].parse::<u64>().is_ok(), "sz: {:?}", fields[10]);
		assert_eq!(fields[11].chars().count(), 1, "state: {:?}", fields[11]);
		assert_ne!(fields[12], "?", "ruser should resolve to a name");
		assert_ne!(fields[13], "?", "rgroup should resolve to a name");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn ps_builtin_accepts_tpgid_alongside_job_control_columns() {
	// Exact form from the field report that failed with
	// "unknown output format specifier 'tpgid'".
	let pid = std::process::id();
	let (result, output) =
		execute_captured(format!("ps -o pid,ppid,pgid,tpgid,sess,stat,tty,command -p {pid}")).await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	let header = output.lines().next().unwrap_or_default();
	for label in ["PID", "PPID", "PGID", "TPGID", "SID", "STAT", "TTY", "COMMAND"] {
		assert!(header.contains(label), "missing {label} in {header:?}");
	}
	assert!(output.lines().skip(1).any(|line| {
		line
			.split_whitespace()
			.next()
			.is_some_and(|value| value == pid.to_string())
	}));
}

/// Contract: `read` from a file consumes exactly one line of the shared
/// offset — the next `read`, and any later reader of the same descriptor,
/// resumes right after it.
#[tokio::test(flavor = "multi_thread")]
async fn read_from_a_file_leaves_the_rest_for_the_next_reader() {
	let dir = tempfile::tempdir().expect("temporary directory");
	let path = dir.path().join("lines.txt");
	std::fs::write(&path, "one\ntwo\nthree\nfour\n").expect("write fixture");
	let path = path.to_string_lossy().replace('\\', "/");
	let (result, output) =
		execute_captured(format!("{{ read -r a; read -r b; echo \"[$a][$b]\"; cat; }} < '{path}'"))
			.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert_eq!(output, "[one][two]\nthree\nfour\n");
}

/// Contract: `read` assigns UTF-8 input as text, not one Latin-1
/// character per byte.
#[tokio::test(flavor = "multi_thread")]
async fn read_decodes_utf8_input() {
	let (result, output) = execute_captured(
		"printf 'é ü\\n' | { read -r first rest; echo \"$first|$rest\"; }".to_owned(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert_eq!(output, "é|ü\n");
}

/// Contract: `read -n` counts characters, not bytes, as bash does in a
/// UTF-8 locale; a multibyte character is never split. The locale is set
/// here: in the C locale bash counts bytes, and test runners differ.
#[tokio::test(flavor = "multi_thread")]
async fn read_count_takes_whole_utf8_characters() {
	let (result, output) = execute_captured(
		"LC_ALL=C.UTF-8; printf 'éa\\n' | { read -r -n 1 first; read -r rest; echo \
		 \"$first|$rest\"; }"
			.to_owned(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert_eq!(output, "é|a\n");
}

/// Contract: `mapfile -n` from a file consumes exactly the lines it
/// stores; a later reader of the descriptor gets the rest.
#[tokio::test(flavor = "multi_thread")]
async fn mapfile_count_from_a_file_leaves_the_rest_for_the_next_reader() {
	let dir = tempfile::tempdir().expect("temporary directory");
	let path = dir.path().join("lines.txt");
	std::fs::write(&path, "one\ntwo\nthree\nfour\n").expect("write fixture");
	let path = path.to_string_lossy().replace('\\', "/");
	let (result, output) = execute_captured(format!(
		"{{ mapfile -t -n 2 lines; echo \"${{lines[*]}}\"; cat; }} < '{path}'"
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert_eq!(output, "one two\nthree\nfour\n");
}

/// Contract: a `mapfile -C` callback that reads the same piped stdin gets
/// the lines after the one mapfile stored, as in bash; mapfile must not
/// have read them ahead.
#[tokio::test(flavor = "multi_thread")]
async fn mapfile_callback_reads_the_next_line_of_a_pipe() {
	let (result, output) = execute_captured(
		"cb() { read -r x; echo \"cb:$1:$2:$x\"; }; seq 1 4 | { mapfile -t -C cb -c 1 arr; echo \
		 \"arr=${arr[*]}\"; }"
			.to_owned(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert_eq!(output, "cb:0:1:2\ncb:1:3:4\narr=1 3\n");
}

/// Contract: the same holds for a regular file, whose read-ahead mapfile
/// gives back to the shared offset before each callback.
#[tokio::test(flavor = "multi_thread")]
async fn mapfile_callback_reads_the_next_line_of_a_file() {
	let dir = tempfile::tempdir().expect("temporary directory");
	let path = dir.path().join("lines.txt");
	std::fs::write(&path, "1\n2\n3\n4\n").expect("write fixture");
	let path = path.to_string_lossy().replace('\\', "/");
	let (result, output) = execute_captured(format!(
		"cb() {{ read -r x; echo \"cb:$1:$2:$x\"; }}; {{ mapfile -t -C cb -c 1 arr; echo \
		 \"arr=${{arr[*]}}\"; }} < '{path}'"
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert_eq!(output, "cb:0:1:2\ncb:1:3:4\narr=1 3\n");
}

/// Contract: `mapfile` into a readonly array fails before reading, as in
/// bash: the array is unchanged and the piped input stays for the next
/// reader.
#[tokio::test(flavor = "multi_thread")]
async fn mapfile_into_a_readonly_array_leaves_the_input_unread() {
	let (_, output) = execute_captured(
		"printf 'a\\nb\\n' | { arr=(x); readonly arr; mapfile -t -O 1 arr; echo \"rc=$? \
		 ${arr[*]}\"; cat; }"
			.to_owned(),
	)
	.await;
	assert!(output.ends_with("rc=1 x\na\nb\n"), "{output:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ps_builtin_lists_one_line_per_thread_with_m() {
	// Field report: `ps -M -p <pid>` failed with "unsupported option '-M'".
	let pid = std::process::id().to_string();
	let (result, output) = execute_captured(format!("ps -M -p {pid}")).await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	let mut lines = output.lines();
	let header: Vec<&str> = lines
		.next()
		.unwrap_or_default()
		.split_whitespace()
		.collect();
	assert_eq!(header, ["USER", "PID", "TT", "%CPU", "STAT", "PRI", "STIME", "UTIME", "COMMAND"]);
	let threads: Vec<Vec<&str>> = lines
		.map(|line| line.split_whitespace().collect())
		.collect();
	// The multi-threaded tokio runtime guarantees several threads.
	assert!(threads.len() > 1, "{output:?}");
	// USER, TT and COMMAND print only on the first thread line.
	assert_eq!(threads[0].get(1), Some(&pid.as_str()), "{output:?}");
	assert!(threads[0].len() >= 9, "{output:?}");
	for fields in &threads[1..] {
		assert_eq!(fields.len(), 6, "{output:?}");
		assert_eq!(fields[0], pid);
		assert!(fields[1].parse::<f64>().is_ok(), "%CPU: {:?}", fields[1]);
		#[cfg(target_os = "macos")]
		assert!(fields[5].contains(':'), "UTIME: {:?}", fields[5]);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn top_builtin_emits_one_finite_snapshot() {
	#[cfg(target_os = "macos")]
	let command = "top -l 1 -n 3";
	#[cfg(not(target_os = "macos"))]
	let command = "top -b -n 1 -r 3";
	let (result, output) = execute_captured(command.to_string()).await;
	assert_eq!(result.exit_code, Some(0));
	assert!(output.contains("top - snapshot 1"));
	assert!(output.contains("PID"));
	assert!(output.contains("COMMAND"));
}

#[tokio::test(flavor = "multi_thread")]
async fn top_builtin_stops_when_its_output_pipe_closes() {
	#[cfg(target_os = "macos")]
	let command = "top -s 0 | head -n 1";
	#[cfg(not(target_os = "macos"))]
	let command = "top -d 0 | head -n 1";
	// top observes head's closed pipe on its next write, after completing a
	// full synchronous process snapshot. Under host load that scan takes
	// seconds; this is only a bound against a broken pipe-close loop.
	let execution = time::timeout(Duration::from_secs(30), execute_captured(command.to_string()))
		.await
		.expect("top kept sampling after its output pipe closed");
	assert_eq!(execution.0.exit_code, Some(0));
	assert!(execution.1.contains("top - snapshot 1"), "{:?}", execution.1);
}

/// Regression: builtin tail upstream of an early-exiting consumer printed
/// "tail: Broken pipe" and failed (`tail -c N big.jsonl | jq …` with jq
/// aborting on a parse error). Real tail dies silently from SIGPIPE; the
/// builtin must exit 141 with no diagnostic. `pipefail` exposes tail's own
/// status, so rc=141 proves the broken pipe actually fired (head closed
/// the pipe early) and was mapped to the silent SIGPIPE exit, not 1.
#[tokio::test(flavor = "multi_thread")]
async fn tail_builtin_is_silent_when_downstream_closes_pipe() {
	let dir = tempfile::tempdir().expect("tempdir");
	let file = dir.path().join("big.txt");
	// ~589 KiB: forces the seekable bounded_tail path, and the 400 KB tail
	// overflows the OS pipe buffer so tail is still writing when head exits.
	let command = format!(
		"seq 1 100000 > '{file}'; set -o pipefail; tail -c 400000 '{file}' | head -c 10 > \
		 /dev/null; echo rc=$?",
		file = file.display()
	);
	let (result, output) = execute_captured(command).await;
	assert_eq!(result.exit_code, Some(0));
	assert!(output.contains("rc=141"), "{output:?}");
	assert!(!output.contains("Broken pipe"), "{output:?}");
}

/// Regression: every ported utility upstream of a stage that quits early
/// printed `<name>: Broken pipe (os error 32)` (and `write error`
/// variants) and exited 1 — `cut f | sed 'bad'` when sed died at parse
/// time, `sed … | head`, `ls | head`. SIGPIPE emulation lives in the host
/// boundary, so ports that know nothing about broken pipes must still die
/// silently with 141.
#[tokio::test(flavor = "multi_thread")]
async fn builtins_upstream_of_closed_pipe_are_silent_and_exit_141() {
	let dir = tempfile::tempdir().expect("tempdir");
	let file = dir.path().join("big.txt");
	let file = file.display();
	// Large enough that the writer is still producing when the reader exits.
	let cases = [
		format!("cut -c1-5 '{file}' | sed -n 1-30p"),
		format!("sed -n p '{file}' | head -n 1 > /dev/null"),
		format!("sort -n '{file}' | head -n 1 > /dev/null"),
		format!("uniq '{file}' | head -n 1 > /dev/null"),
		format!("cat '{file}' | head -n 1 > /dev/null"),
		format!("tr a-z A-Z < '{file}' | head -n 1 > /dev/null"),
	];
	for case in cases {
		let command =
			format!("seq 1 200000 > '{file}'; set -o pipefail; {case}; echo rc=${{PIPESTATUS[0]}}");
		let (result, output) = execute_captured(command).await;
		assert_eq!(result.exit_code, Some(0), "{case}: {output:?}");
		assert!(output.contains("rc=141"), "{case}: {output:?}");
		assert!(!output.contains("Broken pipe"), "{case}: {output:?}");
		assert!(!output.contains("write error"), "{case}: {output:?}");
	}
}

/// The kill builtin accepts a numeric signal and applies it to every process
/// operand.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_accepts_numeric_signal_for_multiple_processes() {
	let mut first = Command::new("sleep")
		.arg("30")
		.spawn()
		.expect("first sleep");
	let mut second = Command::new("sleep")
		.arg("30")
		.spawn()
		.expect("second sleep");
	let first_pid = first.id().expect("first pid");
	let second_pid = second.id().expect("second pid");
	let (mut session, stdio) = kill_test_context().await;

	let result = session
		.run_test(format!("kill -9 {first_pid} {second_pid}"), &stdio)
		.await
		.expect("kill command");
	let code = exit_code(&result);
	if code != 0 {
		let _ = first.kill().await;
		let _ = second.kill().await;
		let _ = first.wait().await;
		let _ = second.wait().await;
		assert_eq!(code, 0, "numeric multi-process kill should succeed");
	}

	let statuses =
		time::timeout(Duration::from_secs(5), async { tokio::join!(first.wait(), second.wait()) })
			.await;
	if statuses.is_err() {
		let _ = first.kill().await;
		let _ = second.kill().await;
		let _ = first.wait().await;
		let _ = second.wait().await;
		panic!("kill must signal every process operand");
	}
	let (first_status, second_status) = statuses.expect("checked timeout");
	assert_eq!(first_status.expect("first wait").signal(), Some(libc::SIGKILL));
	assert_eq!(second_status.expect("second wait").signal(), Some(libc::SIGKILL));
}

/// The kill builtin defaults to SIGTERM so processes can shut down
/// gracefully.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_defaults_to_sigterm() {
	let dir = tempfile::tempdir().expect("temp dir");
	let ready = dir.path().join("ready");
	let mut child = Command::new("sh")
		.args([
			"-c",
			"trap 'exit 42' TERM; : > \"$1\"; while :; do :; done",
			"sh",
			ready.to_str().expect("utf8 path"),
		])
		.spawn()
		.expect("trapping child");
	let pid = child.id().expect("child pid");
	let ready_result = time::timeout(Duration::from_secs(5), async {
		while !ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await;
	if ready_result.is_err() {
		let _ = child.kill().await;
		let _ = child.wait().await;
		panic!("child did not install its SIGTERM trap");
	}

	let (mut session, stdio) = kill_test_context().await;
	let result = session
		.run_test(format!("kill {pid}"), &stdio)
		.await
		.expect("kill command");
	let code = exit_code(&result);

	let status = time::timeout(Duration::from_secs(5), child.wait()).await;
	if status.is_err() {
		let _ = child.kill().await;
		let _ = child.wait().await;
		panic!("default kill signal did not terminate the child");
	}
	assert_eq!(code, 0, "default kill should succeed");
	assert_eq!(status.expect("checked timeout").expect("child wait").code(), Some(42));
}

/// A negative PID after `--` targets a process group per `kill(2)` instead
/// of being parsed as a numeric signal, and a plain PID in the same command
/// is still signaled.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_preserves_negative_pid_process_group_operands() {
	let dir = tempfile::tempdir().expect("temp dir");
	let group_ready = dir.path().join("group-ready");
	let plain_ready = dir.path().join("plain-ready");
	let spawn_trapping = |ready: &std::path::Path, own_group: bool| {
		let mut cmd = Command::new("sh");
		cmd.args([
			"-c",
			"trap 'exit 42' TERM; : > \"$1\"; while :; do sleep 0.05; done",
			"sh",
			ready.to_str().expect("utf8 path"),
		]);
		if own_group {
			// pgid becomes this child's own pid, so `-pid` addresses the group.
			cmd.process_group(0);
		}
		cmd.spawn().expect("trapping child")
	};

	let mut group_child = spawn_trapping(&group_ready, true);
	let mut plain_child = spawn_trapping(&plain_ready, false);
	let group_pid = group_child.id().expect("group pid");
	let plain_pid = plain_child.id().expect("plain pid");

	let ready_result = time::timeout(Duration::from_secs(5), async {
		while !group_ready.exists() || !plain_ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await;
	if ready_result.is_err() {
		let _ = group_child.start_kill();
		let _ = plain_child.start_kill();
		let _ = group_child.wait().await;
		let _ = plain_child.wait().await;
		panic!("children did not install their SIGTERM traps");
	}

	let (mut session, stdio) = kill_test_context().await;
	let result = session
		.run_test(format!("kill -TERM -- -{group_pid} {plain_pid}"), &stdio)
		.await
		.expect("kill command");
	let code = exit_code(&result);

	let statuses = time::timeout(Duration::from_secs(5), async {
		tokio::join!(group_child.wait(), plain_child.wait())
	})
	.await;
	if statuses.is_err() {
		let _ = group_child.start_kill();
		let _ = plain_child.start_kill();
		let _ = group_child.wait().await;
		let _ = plain_child.wait().await;
		panic!("negative-PID kill must signal the process group and the plain PID");
	}
	let (group_status, plain_status) = statuses.expect("checked timeout");
	assert_eq!(code, 0, "negative-PID kill should succeed");
	assert_eq!(group_status.expect("group wait").code(), Some(42));
	assert_eq!(plain_status.expect("plain wait").code(), Some(42));
}

/// After a `--` marker (alone, or after `-s SIG`), a negative PID is an
/// operand, not a signal: `kill -- -<pgid>` defaults to SIGTERM for the
/// group, and `kill -s TERM -- -<pgid>` sends the named signal to the group.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_signals_group_when_marker_precedes_negative_pid() {
	let dir = tempfile::tempdir().expect("temp dir");
	let default_ready = dir.path().join("default-ready");
	let named_ready = dir.path().join("named-ready");
	let spawn_group_leader = |ready: &std::path::Path| {
		Command::new("sh")
			.args([
				"-c",
				"trap 'exit 42' TERM; : > \"$1\"; while :; do sleep 0.05; done",
				"sh",
				ready.to_str().expect("utf8 path"),
			])
			.process_group(0)
			.spawn()
			.expect("group leader")
	};

	let mut default_child = spawn_group_leader(&default_ready);
	let mut named_child = spawn_group_leader(&named_ready);
	let default_pid = default_child.id().expect("default pid");
	let named_pid = named_child.id().expect("named pid");

	let ready_result = time::timeout(Duration::from_secs(5), async {
		while !default_ready.exists() || !named_ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await;
	if ready_result.is_err() {
		let _ = default_child.start_kill();
		let _ = named_child.start_kill();
		let _ = default_child.wait().await;
		let _ = named_child.wait().await;
		panic!("group leaders did not install their SIGTERM traps");
	}

	let (mut session, stdio) = kill_test_context().await;
	// Default signal (SIGTERM) after the marker.
	let default_result = session
		.run_test(format!("kill -- -{default_pid}"), &stdio)
		.await
		.expect("default kill command");
	// Named signal via -s, then the marker.
	let named_result = session
		.run_test(format!("kill -s TERM -- -{named_pid}"), &stdio)
		.await
		.expect("named kill command");

	let statuses = time::timeout(Duration::from_secs(5), async {
		tokio::join!(default_child.wait(), named_child.wait())
	})
	.await;
	if statuses.is_err() {
		let _ = default_child.start_kill();
		let _ = named_child.start_kill();
		let _ = default_child.wait().await;
		let _ = named_child.wait().await;
		panic!("marker-preceded negative PID must signal the process group");
	}
	let (default_status, named_status) = statuses.expect("checked timeout");
	assert_eq!(exit_code(&default_result), 0, "`kill -- -<pgid>` should succeed");
	assert_eq!(exit_code(&named_result), 0, "`kill -s TERM -- -<pgid>` should succeed");
	assert_eq!(default_status.expect("default wait").code(), Some(42));
	assert_eq!(named_status.expect("named wait").code(), Some(42));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_signals_every_process_in_a_jobspec_pipeline() {
	const MARKER: &str = "PI_SHELL_TEST_KILL_JOBSPEC_PIPELINE";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::kill_builtin_signals_every_process_in_a_jobspec_pipeline",
			MARKER,
			true,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("jobspec directory");
	let first_pidfile = dir.path().join("first.pid");
	let second_pidfile = dir.path().join("second.pid");
	let _cleanup = PidfileProcessCleanup(vec![first_pidfile.clone(), second_pidfile.clone()]);
	let first_ready = dir.path().join("first.ready");
	let second_ready = dir.path().join("second.ready");
	let first_script = "trap 'exit 42' TERM; echo $$ > \"$1\"; : > \"$2\"; kill -STOP $$; while :; \
	                    do sleep 0.05; done";
	let second_script = "trap 'exit 43' TERM; echo $$ > \"$1\"; : > \"$2\"; kill -STOP $$; while \
	                     :; do sleep 0.05; done";
	let command = format!(
		"sh -c {} sh {} {} | sh -c {} sh {} {} &",
		quote_arg(first_script),
		quote_arg(first_pidfile.to_str().expect("utf8 first pidfile")),
		quote_arg(first_ready.to_str().expect("utf8 first ready path")),
		quote_arg(second_script),
		quote_arg(second_pidfile.to_str().expect("utf8 second pidfile")),
		quote_arg(second_ready.to_str().expect("utf8 second ready path")),
	);
	let (mut session, stdio) = kill_test_context().await;

	let started = session
		.run_test(command, &stdio)
		.await
		.expect("background pipeline");
	assert_eq!(exit_code(&started), 0, "starting the background pipeline");
	time::timeout(Duration::from_secs(5), async {
		while !first_ready.exists() || !second_ready.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("pipeline processes did not become ready");
	let pids = [&first_pidfile, &second_pidfile].map(|pidfile| {
		fs::read_to_string(pidfile)
			.expect("pipeline pidfile")
			.trim()
			.parse::<i32>()
			.expect("pipeline pid")
	});
	for pid in pids {
		wait_until_stopped(pid).await;
	}
	assert_eq!(
		session
			.session
			.live_external_jobs()
			.await
			.expect("live background jobs"),
		1,
		"the stopped pipeline must stay one job holding its externals",
	);

	let killed = session
		.run_test("kill -CONT %1; kill %1", &stdio)
		.await
		.expect("kill jobspec");
	assert_eq!(exit_code(&killed), 0, "`kill %1` should signal every pipeline process");
	let _ = session
		.run_test("wait %1", &stdio)
		.await
		.expect("reap jobspec");
	for pid in pids {
		assert!(process::Process::from_pid(pid).is_none(), "pipeline process {pid} survived");
	}
}

/// Without job control a stage that stops does not end the wait for its
/// foreground pipeline (bash waits for it without `WUNTRACED`): the run
/// finishes once the stage is continued, and the producer upstream of it is
/// not left blocked on a full pipe.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn stopped_later_pipeline_stage_finishes_once_continued() {
	const MARKER: &str = "PI_SHELL_TEST_STOPPED_LATER_STAGE";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::stopped_later_pipeline_stage_finishes_once_continued",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("stage directory");
	let pidfile = dir.path().join("stage.pid");
	let _cleanup = PidfileProcessCleanup(vec![pidfile.clone()]);
	let command = format!(
		"/usr/bin/yes | sh -c {} sh {}",
		quote_arg("echo $$ > \"$1\"; kill -STOP $$"),
		quote_arg(pidfile.to_str().expect("utf8 pidfile")),
	);
	let (mut session, stdio) = kill_test_context().await;
	let continue_stage = async {
		let pid = wait_for_pidfile(&pidfile).await;
		wait_until_stopped(pid).await;
		// SAFETY: kill takes any pid and signal number; `pid` is the stopped
		// stage this test started.
		assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0, "continue the stopped stage");
	};
	let (result, ()) = tokio::join!(
		time::timeout(Duration::from_secs(20), session.run_test(command, &stdio)),
		continue_stage,
	);
	let result = result
		.expect("pipeline did not finish after its stopped stage continued")
		.expect("pipeline run");
	assert_eq!(exit_code(&result), 0);
}

/// Under job control (`set -m` on a terminal) a stop of the job reaches
/// every stage, although each stage leads a session of its own as every
/// pi external does: the job is reported stopped and no stage keeps
/// running.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn stopped_interactive_job_stops_every_pipeline_stage() {
	const MARKER: &str = "PI_SHELL_TEST_STOPPED_INTERACTIVE_JOB";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::stopped_interactive_job_stops_every_pipeline_stage",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("stage directory");
	let pidfiles = [dir.path().join("first.pid"), dir.path().join("second.pid")];
	let _cleanup = PidfileProcessCleanup(pidfiles.to_vec());
	let command = format!(
		"sh -c {} sh {} | sh -c {} sh {} &",
		quote_arg("echo $$ > \"$1\"; exec /usr/bin/yes"),
		quote_arg(pidfiles[0].to_str().expect("utf8 first pidfile")),
		quote_arg("echo $$ > \"$1\"; exec cat > /dev/null"),
		quote_arg(pidfiles[1].to_str().expect("utf8 second pidfile")),
	);
	let (_pty_master, pty_slave) = pseudo_terminal_session();
	let (mut session, stdio) = interactive_kill_test_context(&pty_slave).await;
	let started = session
		.run_test(command, &stdio)
		.await
		.expect("background pipeline");
	assert_eq!(exit_code(&started), 0, "starting the background pipeline");
	let mut pids = Vec::with_capacity(pidfiles.len());
	for pidfile in &pidfiles {
		pids.push(wait_for_pidfile(pidfile).await);
	}

	let stopped = session
		.run_test("kill -STOP %1", &stdio)
		.await
		.expect("stop the job");
	assert_eq!(exit_code(&stopped), 0);
	for &pid in &pids {
		wait_until_stopped(pid).await;
	}
	let jobs = tempfile::tempfile().expect("jobs capture");
	session
		.run_test("jobs -s", &TestStdio::null().stdin(&pty_slave).stdout(&jobs))
		.await
		.expect("list stopped jobs");
	let listed = read_capture(&jobs);
	assert!(listed.contains("Stopped"), "the job must be reported stopped: {listed:?}");

	let _ = session
		.run_test("kill -CONT %1; kill -KILL %1; wait %1", &stdio)
		.await;
}

/// fg on a job whose stages were stopped and then continued from outside
/// the shell waits for the pipeline to complete: no stop report of any
/// selected stage is left to end the wait early.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn resumed_pipeline_drains_every_selected_stop_report() {
	const MARKER: &str = "PI_SHELL_TEST_DRAINED_STOP_REPORTS";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::resumed_pipeline_drains_every_selected_stop_report",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let script = "echo $$ > \"$1\"; : > \"$2\"; if test \"$3\" -eq 1; then kill -STOP $$; fi; \
	              while ! test -e \"$4\"; do sleep 0.01; done";
	let (_pty_master, pty_slave) = pseudo_terminal_session();
	for stage_count in [2_usize, 3] {
		for stopped_subset in 1..(1_usize << stage_count) {
			let files = tempfile::tempdir().expect("pipeline files");
			let release = files.path().join("release");
			let pidfiles: Vec<_> = (0..stage_count)
				.map(|stage| files.path().join(format!("{stage}.pid")))
				.collect();
			let _cleanup = PidfileProcessCleanup(pidfiles.clone());
			let readyfiles: Vec<_> = (0..stage_count)
				.map(|stage| files.path().join(format!("{stage}.ready")))
				.collect();
			let mut command = (0..stage_count)
				.map(|stage| {
					let stopped = usize::from(stopped_subset & (1 << stage) != 0);
					format!(
						"sh -c {} sh {} {} {stopped} {}",
						quote_arg(script),
						quote_arg(pidfiles[stage].to_str().expect("utf8 pidfile")),
						quote_arg(readyfiles[stage].to_str().expect("utf8 readyfile")),
						quote_arg(release.to_str().expect("utf8 release")),
					)
				})
				.collect::<Vec<_>>()
				.join(" | ");
			command.push_str(" &");
			let (mut session, stdio) = interactive_kill_test_context(&pty_slave).await;
			let started = session
				.run_test(command, &stdio)
				.await
				.expect("background pipeline");
			assert_eq!(exit_code(&started), 0, "subset {stopped_subset:#b}");
			time::timeout(Duration::from_secs(20), async {
				while !readyfiles.iter().all(|file| file.exists()) {
					time::sleep(Duration::from_millis(10)).await;
				}
			})
			.await
			.expect("pipeline stages did not become ready");
			let pids: Vec<i32> = pidfiles
				.iter()
				.map(|file| {
					fs::read_to_string(file)
						.expect("stage pidfile")
						.trim()
						.parse()
						.expect("stage pid")
				})
				.collect();
			for (stage, &pid) in pids.iter().enumerate() {
				if stopped_subset & (1 << stage) != 0 {
					wait_until_stopped(pid).await;
				}
			}
			// The stages finish only once released, which happens after
			// every stage is running again and fg had time to start waiting:
			// a job that ended before fg would be refused as terminated.
			let resume = format!(
				"kill -CONT {} || exit 97; fg %1",
				pids
					.iter()
					.map(ToString::to_string)
					.collect::<Vec<_>>()
					.join(" ")
			);
			let release_stages = async {
				time::timeout(Duration::from_secs(20), async {
					while pids.iter().any(|&pid| is_stopped(pid)) {
						time::sleep(Duration::from_millis(10)).await;
					}
				})
				.await
				.expect("stopped stages were not continued");
				time::sleep(Duration::from_millis(200)).await;
				fs::write(&release, "").expect("release stages");
			};
			let (resumed, ()) = tokio::join!(
				time::timeout(Duration::from_secs(20), session.run_test(resume, &stdio)),
				release_stages,
			);
			let resumed = resumed
				.expect("resumed pipeline did not complete")
				.expect("foreground resumed pipeline");
			assert_eq!(
				exit_code(&resumed),
				0,
				"subset {stopped_subset:#b} reported a stale stop after fg"
			);
		}
	}
}

/// A job that stops before `wait` begins is still reported as stopped:
/// with job control, `wait` ends at once with 128 + the stop signal instead
/// of waiting for an exit that cannot come.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn wait_reports_a_stop_that_precedes_the_wait() {
	const MARKER: &str = "PI_SHELL_TEST_STOP_BEFORE_WAIT";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::wait_reports_a_stop_that_precedes_the_wait",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("job directory");
	let pidfile = dir.path().join("job.pid");
	let _cleanup = PidfileProcessCleanup(vec![pidfile.clone()]);
	let (mut session, stdio) = kill_test_context().await;
	let started = session
		.run_test(
			format!(
				"set -m; sh -c {} sh {} &",
				quote_arg("echo $$ > \"$1\"; exec sleep 30"),
				quote_arg(pidfile.to_str().expect("utf8 pidfile")),
			),
			&stdio,
		)
		.await
		.expect("background job");
	assert_eq!(exit_code(&started), 0);
	let pid = wait_for_pidfile(&pidfile).await;
	let stopped = session
		.run_test("kill -STOP %1", &stdio)
		.await
		.expect("stop the job");
	assert_eq!(exit_code(&stopped), 0);
	wait_until_stopped(pid).await;

	let waited = time::timeout(Duration::from_secs(20), session.run_test("wait %1", &stdio))
		.await
		.expect("wait missed a stop that happened before it began")
		.expect("wait for the stopped job");
	assert_eq!(exit_code(&waited), 128 + libc::SIGSTOP);

	let _ = session
		.run_test("kill -CONT %1; kill -KILL %1; wait %1", &stdio)
		.await;
}

/// A stopped background process must not make the next foreground process
/// look stopped. The inner run is isolated: after the background child
/// stops, the foreground command is the only new child that could report
/// status to the shell.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn stopped_background_job_does_not_stop_foreground_process() {
	const MARKER: &str = "PI_SHELL_TEST_STOPPED_BACKGROUND_JOB";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::stopped_background_job_does_not_stop_foreground_process",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("job directory");
	let pidfile = dir.path().join("background.pid");
	let _cleanup = PidfileProcessCleanup(vec![pidfile.clone()]);
	let (mut session, stdio) = kill_test_context().await;
	let background = session
		.run_test(
			format!(
				"sh -c {} sh {} &",
				quote_arg("echo $$ > \"$1\"; kill -STOP $$"),
				quote_arg(pidfile.to_str().expect("utf8 pidfile")),
			),
			&stdio,
		)
		.await
		.expect("start stopped background process");
	assert_eq!(exit_code(&background), 0);
	let background_pid = wait_for_pidfile(&pidfile).await;
	wait_until_stopped(background_pid).await;

	let foreground = session
		.run_test("/bin/sleep 1", &stdio)
		.await
		.expect("foreground sleep");
	assert_eq!(
		exit_code(&foreground),
		0,
		"a stopped background process must not stop the foreground sleep"
	);
	let jobs = tempfile::tempfile().expect("jobs capture");
	session
		.run_test("jobs -p", &TestStdio::null().stdout(&jobs))
		.await
		.expect("list jobs");
	let listed = read_capture(&jobs);
	assert_eq!(listed.lines().count(), 1, "foreground sleep must not become a job: {listed:?}");

	let _ = session
		.run_test("kill -CONT %1; kill %1; wait %1", &stdio)
		.await;
}

/// Whether `pid` is stopped (state `T`).
#[cfg(unix)]
fn is_stopped(pid: i32) -> bool {
	pi_builtins::ProcInfo::all()
		.into_iter()
		.any(|process| process.pid() == pid && process.state() == 'T')
}

/// Waits until `pid` is stopped.
#[cfg(unix)]
async fn wait_until_stopped(pid: i32) {
	time::timeout(Duration::from_secs(20), async {
		while !is_stopped(pid) {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.unwrap_or_else(|_| panic!("process {pid} did not stop"));
}

/// The pid a test script wrote to `pidfile` (`echo $$ > pidfile`).
#[cfg(unix)]
async fn wait_for_pidfile(pidfile: &std::path::Path) -> i32 {
	time::timeout(Duration::from_secs(20), async {
		loop {
			if let Some(pid) = fs::read_to_string(pidfile)
				.ok()
				.and_then(|text| text.trim().parse::<i32>().ok())
			{
				return pid;
			}
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.unwrap_or_else(|_| panic!("no pid in {}", pidfile.display()))
}

/// A failed target makes `kill` return non-zero without preventing later
/// process operands from receiving the selected signal.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_continues_after_target_failure() {
	let mut first = Command::new("sleep")
		.arg("30")
		.spawn()
		.expect("first sleep");
	let mut second = Command::new("sleep")
		.arg("30")
		.spawn()
		.expect("second sleep");
	let mut stale = Command::new("true").spawn().expect("stale process");
	let first_pid = first.id().expect("first pid");
	let second_pid = second.id().expect("second pid");
	let stale_pid = stale.id().expect("stale pid");
	stale.wait().await.expect("stale wait");

	let (mut session, stdio) = kill_test_context().await;
	let result = session
		.run_test(format!("kill -KILL {first_pid} {stale_pid} {second_pid}"), &stdio)
		.await
		.expect("kill command");
	let code = exit_code(&result);

	let statuses =
		time::timeout(Duration::from_secs(5), async { tokio::join!(first.wait(), second.wait()) })
			.await;
	if statuses.is_err() {
		let _ = first.start_kill();
		let _ = second.start_kill();
		let _ = first.wait().await;
		let _ = second.wait().await;
		panic!("kill must continue signaling after an intermediate target fails");
	}
	let (first_status, second_status) = statuses.expect("checked timeout");
	assert_ne!(code, 0, "a failed target should make kill return non-zero");
	assert_eq!(first_status.expect("first wait").signal(), Some(libc::SIGKILL));
	assert_eq!(second_status.expect("second wait").signal(), Some(libc::SIGKILL));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_translates_signal_names_and_numbers() {
	let (result, output) = execute_captured("kill -l KILL; kill -l 9".to_string()).await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, "9\nKILL\n");
}

/// pi's PID is the shell's `$$`: `kill -0` probes it, and a nonzero signal
/// aimed at it reaches the shell, as `kill $$` does in bash, not pi. The
/// run ends as the signal dictates (`KILL`: 128 + 9); pi and the next run
/// are unaffected.
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_signals_only_the_shell_at_its_own_pid() {
	const MARKER: &str = "PI_SHELL_TEST_KILL_OWN_PID";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::kill_builtin_signals_only_the_shell_at_its_own_pid",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let pid = std::process::id();
	let (probe, _) = execute_captured(format!("kill -0 {pid}")).await;
	assert_eq!(probe.exit_code, Some(0), "signal 0 should probe the shell process");
	let (result, output) =
		execute_captured(format!("kill -KILL {pid}; printf 'not reached\\n'")).await;
	assert_eq!(result.exit_code, Some(137), "KILL ends the shell's run: {output:?}");
	assert!(!output.contains("not reached"), "{output:?}");
	let (after, output) = execute_captured("printf 'survived\\n'".to_owned()).await;
	assert_eq!(after.exit_code, Some(0));
	assert_eq!(output, "survived\n");
}

/// A process-group operand that contains the shell is rejected before the
/// `kill(2)` group operation can signal any member.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_refuses_own_process_group() {
	const MARKER: &str = "PI_SHELL_TEST_KILL_OWN_GROUP";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::kill_builtin_refuses_own_process_group",
			MARKER,
			true,
		)
		.await;
		return;
	}

	let (result, output) = execute_captured(
		"kill -KILL -- 0; status=$?; printf 'status=%s survived\\n' \"$status\"; test \"$status\" \
		 -ne 0"
			.to_string(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "the shell must survive a group kill attempt");
	assert!(output.contains("refusing to signal the shell process"), "{output:?}");
	assert!(output.contains("survived"), "{output:?}");
}

/// An agent that runs `kill <terminal pid>` or `pkill <terminal>` must not
/// be able to take down the terminal the session lives in. Self-kill was
/// already refused, but an ancestor is a different process in a different
/// process group and session, so it slipped straight through.
///
/// Uses `CONT` rather than a lethal signal: the guard runs for any real
/// signal (only `-0` is exempt), so `CONT` exercises exactly the same code
/// path while staying harmless if the guard ever regresses. A lethal signal
/// here could terminate the test harness. `TERM` appears once, aimed only
/// at a child this test spawned, to prove the guard has not over-blocked
/// into uselessness.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_builtin_refuses_ancestors_but_not_unrelated_processes() {
	let sleep = test_executable("sleep");
	let command = format!(
		"parent=$(ps -o ppid= -p $$ | tr -d ' ')\nkill -CONT \"$parent\"; printf 'ancestor=%s\\n' \
		 \"$?\"\n{} 30 &\nchild=$!\nkill -TERM \"$child\"; printf 'child=%s\\n' \"$?\"\nprintf \
		 'survived\\n'",
		quote_arg(sleep.to_str().expect("utf8 sleep path"))
	);
	let (result, output) = execute_captured(command).await;
	assert_eq!(result.exit_code, Some(0), "the shell must survive: {output:?}");
	assert!(output.contains("survived"), "{output:?}");
	assert!(
		output.contains("refusing to signal the shell process"),
		"signalling an ancestor must be refused: {output:?}"
	);
	assert!(output.contains("ancestor=1"), "the ancestor kill must report failure: {output:?}");
	// The same guard must leave a process outside our ancestry alone, or
	// `kill` would be useless.
	assert!(output.contains("child=0"), "an unrelated child must remain signallable: {output:?}");
}

/// `pkill` removes the shell PID from the candidate set before sending the
/// selected signal, even when that PID is requested explicitly.
#[tokio::test(flavor = "multi_thread")]
async fn pkill_builtin_excludes_own_pid() {
	const MARKER: &str = "PI_SHELL_TEST_PKILL_OWN_PID";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::process_control::pkill_builtin_excludes_own_pid",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let pid = std::process::id();
	let (result, output) = execute_captured(format!(
		"pkill -KILL -p {pid}; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
		 \"$status\" -eq 1"
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "the shell must survive an explicit pkill");
	assert!(output.contains("survived"), "{output:?}");
}
