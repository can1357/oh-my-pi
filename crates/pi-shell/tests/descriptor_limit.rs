//! Nested shell execution under a low open-file limit. Each test reruns its
//! body in a child process whose soft `RLIMIT_NOFILE` is [`LIMIT`], since the
//! limit is process-wide.

#![cfg(unix)]

use std::{fmt::Write as _, os::unix::process::CommandExt as _};

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

/// Set in the child process that runs a test body.
const CHILD: &str = "PI_SHELL_TEST_DESCRIPTOR_LIMIT_CHILD";

/// The soft open-file limit of the child. Low, so that a level holding even
/// one descriptor of its own exhausts it within a few hundred levels.
const LIMIT: libc::rlim_t = 128;

/// Stack of each shell worker thread.
const STACK_BYTES: usize = 512 << 20;

fn soft_nofile() -> libc::rlim_t {
	let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: `lim` is a valid, writable `rlimit` for the duration of the call.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) }, 0);
	lim.rlim_cur
}

/// Returns `true` in the child, where the test body runs under a soft limit
/// of [`LIMIT`] open files. In the test process, runs test `name` in that
/// child, checks that it ran and passed, and returns `false`.
fn in_limited_child(name: &str) -> bool {
	if std::env::var_os(CHILD).is_some() {
		assert_eq!(soft_nofile(), LIMIT, "the child must run under the lowered limit");
		return true;
	}

	let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
	command
		.args(["--exact", name, "--nocapture"])
		.env(CHILD, "1");
	// SAFETY: runs in the forked child before exec; `getrlimit` and `setrlimit`
	// are async-signal-safe and the closure allocates nothing.
	unsafe {
		command.pre_exec(|| {
			let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			if libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) != 0 {
				return Err(std::io::Error::last_os_error());
			}
			lim.rlim_cur = LIMIT;
			if libc::setrlimit(libc::RLIMIT_NOFILE, &raw const lim) != 0 {
				return Err(std::io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let output = command.output().expect("child test process");
	let stdout = String::from_utf8_lossy(&output.stdout);
	let stderr = String::from_utf8_lossy(&output.stderr);
	assert!(
		output.status.success() && stdout.contains("1 passed"),
		"child test {name} under a soft limit of {LIMIT} open files: \
		 {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
		output.status
	);
	false
}

/// Runs `command` in a one-shot shell; returns its exit code and the merged
/// stdout and stderr.
fn run(command: &str) -> (Option<i32>, String) {
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.thread_stack_size(STACK_BYTES)
		.enable_all()
		.build()
		.expect("tokio runtime");
	runtime.block_on(async {
		let (tx, rx) = flume::unbounded::<String>();
		let result = execute_shell(
			ShellExecuteOptions { command: command.to_string(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell execution");
		(result.exit_code, rx.try_iter().collect())
	})
}

/// A nesting level that redirects nothing holds no descriptor of its own, so
/// 200 levels fit under 128 open files. Regression: each level duplicated the
/// standard streams and stopped near 40 levels under a 1,024 limit.
#[test]
fn nesting_holds_no_descriptor_per_level() {
	if !in_limited_child("nesting_holds_no_descriptor_per_level") {
		return;
	}

	let dir = tempfile::tempdir().expect("tempdir");
	let again = dir.path().join("again.sh");
	std::fs::write(
		&again,
		format!(
			"if [ $n -lt 200 ]; then n=$((n+1)); . '{}'; else echo reached=$n; fi\n",
			again.display()
		),
	)
	.expect("write the sourced script");

	let outcomes: Vec<_> = [
		(
			"function",
			"f() { if [ \"$1\" -lt 200 ]; then f $(( $1 + 1 )); else echo reached=$1; fi; }; f 0; \
			 echo after=$?"
				.to_string(),
		),
		("source", format!("n=0; . '{}'; echo after=$?", again.display())),
	]
	.into_iter()
	.map(|(shape, command)| (shape, run(&command)))
	.collect();

	let reached = (Some(0), "reached=200\nafter=0\n".to_string());
	assert_eq!(outcomes, [("function", reached.clone()), ("source", reached)]);
}

/// Running out of descriptors prints one diagnostic naming the limit (bash's
/// `file: strerror` redirection error, the limit appended), and the next
/// command still runs. Regression: the shell printed nothing.
#[test]
fn running_out_of_descriptors_names_the_limit() {
	if !in_limited_child("running_out_of_descriptors_names_the_limit") {
		return;
	}

	let (code, output) = run(
		"f() { if [ \"$1\" -lt 1000 ]; then f $(( $1 + 1 )) < /dev/null; else echo reached; fi; }; \
		 f 0; echo after=$?",
	);
	let lines: Vec<_> = output.lines().collect();
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(lines.len(), 2, "{output}");
	assert_eq!(lines[1], "after=1");
	for part in ["/dev/null: Too many open files", "limit of 128 open files", "ulimit -n"] {
		assert!(lines[0].contains(part), "missing {part:?} in {output}");
	}
}

/// An external given many fds holds one descriptor here per distinct
/// source, not one or two per fd: under a limit of 128, 120 fds naming one
/// standard stream and 100 opened files run, for every spelling below, as
/// in Bash 5.2 and 5.3. The fds still reach the child in order: a saved
/// standard stream, a swap through the standard streams and a ring.
/// Regression: each fd was given its own copy (or pipe) of its source, at a
/// number above every fd given, so `Too many open files` ended each row.
#[test]
fn a_child_holds_one_descriptor_per_source() {
	if !in_limited_child("a_child_holds_one_descriptor_per_source") {
		return;
	}

	let aliases = |to: &str| {
		(3..=122)
			.map(|fd| format!("{fd}{to}"))
			.collect::<Vec<_>>()
			.join(" ")
	};
	let (out, err, inp) = (aliases(">&1"), aliases(">&2"), aliases("<&0"));
	let mixed = (3..=122)
		.map(|fd| format!("{fd}{}", ["<&0", ">&1", ">&2", ">&-"][fd % 4]))
		.collect::<Vec<_>>()
		.join(" ");
	let files = (3..=102)
		.map(|fd| format!("{fd}>/dev/null"))
		.collect::<Vec<_>>()
		.join(" ");
	let rows = [
		("stdout", format!("/bin/true {out}")),
		("stderr", format!("/bin/true {err}")),
		("stdin", format!("/bin/true {inp}")),
		("mixed", format!("/bin/true {mixed}")),
		("file stdout", format!("{{ /bin/true {out}; }} >f")),
		("background", format!("/bin/true {out} & wait $!")),
		("pipeline", format!("/bin/true {out} | /bin/cat")),
		("subshell", format!("( /bin/true {err} )")),
		("function", format!("f() {{ /bin/true; }}; f {out}")),
		("group", format!("{{ /bin/true; }} {err}")),
		("here-string", format!("/bin/true <<<x {inp}")),
		("files", format!("/bin/true {files}")),
		("files background", format!("/bin/true {files} & wait $!")),
	];
	let dir = tempfile::tempdir().expect("tempdir");
	let mut script = format!("cd '{}'\n", dir.path().display());
	let mut expected = String::new();
	for (name, command) in &rows {
		let _ = writeln!(script, "{command}; echo \"{name}=$?\"");
		let _ = writeln!(expected, "{name}=0");
	}
	for line in [
		"/bin/sh -c 'printf SAVED >&3' 3>&1 >redirected; echo; echo \"saved=[$(cat redirected)]\"",
		"{ /bin/sh -c 'echo out; echo err >&2' 3>&1 1>&2 2>&3 3>&-; } >o 2>e; echo \"swap=$(cat \
		 o),$(cat e)\"",
		"printf A>a; printf B>b; { /bin/sh -c 'cat <&3; cat <&4' 5<&3 3<&4 4<&5 5<&-; } 3<a 4<b; \
		 echo \" ring=$?\"",
	] {
		script.push_str(line);
		script.push('\n');
	}
	expected.push_str("SAVED\nsaved=[]\nswap=err,out\nBA ring=0\n");
	assert_eq!(run(&script), (Some(0), expected));
}

/// An fd already at its own number costs no descriptor here: under a limit
/// of 128, a command given 90 of them runs, in the foreground and as a
/// background job, and one mixed with a real duplication still reaches the
/// child with both. Regression: each such fd was moved to a spare number
/// first, so 90 of them needed 90 more descriptors before any `dup2` ran
/// and the command died with `Too many open files`, which is the very cost
/// this one-descriptor-per-source rule exists to remove.
#[test]
fn a_self_targeted_fd_costs_no_descriptor() {
	if !in_limited_child("a_self_targeted_fd_costs_no_descriptor") {
		return;
	}

	let hold = (14..=103)
		.map(|fd| format!("{fd}>/dev/null"))
		.collect::<Vec<_>>()
		.join(" ");
	let selves = (14..=103)
		.map(|fd| format!("{fd}>&{fd}"))
		.collect::<Vec<_>>()
		.join(" ");
	let mut script = format!("exec {hold}\n");
	let _ = writeln!(script, "/bin/true {selves}; echo \"self=$?\"");
	let _ = writeln!(script, "/bin/true {selves} & wait $!; echo \"background=$?\"");
	script.push_str("exec 7>&1 8>&1\n");
	script.push_str("/bin/sh -c 'printf S >&7' 7>&7 8>&8 1>/dev/null; echo \" mixed=$?\"\n");
	assert_eq!(run(&script), (Some(0), "self=0\nbackground=0\nS mixed=0\n".to_string()));
}
