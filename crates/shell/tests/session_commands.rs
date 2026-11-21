//! Session commands a host installs for one `Shell::run`: each name is a
//! command of its own, served by the host's handler, composing like any other
//! command and scoped to the run that installed it.

use std::{
	path::Path,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use omp_shell::{
	SessionCommandFuture, SessionCommandHandler, SessionCommandRequest, SessionCommandResult,
	SessionCommands, Shell, ShellRunOptions, ShellRunResult, cancel::CancelToken,
	reserved_command_names,
};

/// A handler answering with `reply`.
struct FnHandler<F>(F);

impl<F> SessionCommandHandler for FnHandler<F>
where
	F: Fn(SessionCommandRequest) -> SessionCommandFuture + Send + Sync,
{
	fn call(&self, request: SessionCommandRequest) -> SessionCommandFuture {
		(self.0)(request)
	}
}

type Log = Arc<Mutex<Vec<SessionCommandRequest>>>;

/// `names`, served by `reply`.
fn commands(
	names: &[&str],
	reply: impl Fn(SessionCommandRequest) -> SessionCommandFuture + Send + Sync + 'static,
) -> SessionCommands {
	SessionCommands::new(names.iter().map(|&name| name.to_owned()), Arc::new(FnHandler(reply)))
}

/// `names`, each answering `NAME|ARGV,…|STDIN` on stdout, recorded in `log`.
fn echoing(names: &[&str], log: &Log) -> SessionCommands {
	let log = Arc::clone(log);
	commands(names, move |request| {
		log.lock().expect("log").push(request.clone());
		Box::pin(async move {
			tokio::task::yield_now().await;
			Ok(ok(&format!("{}|{}|{}\n", request.name, request.argv.join(","), request.stdin)))
		})
	})
}

fn ok(stdout: &str) -> SessionCommandResult {
	SessionCommandResult { stdout: stdout.to_owned(), stderr: String::new(), exit_code: 0 }
}

/// Sets its flag when dropped: the call it lives in was abandoned.
struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Release);
	}
}

/// Commands whose calls never answer; `dropped` is set once one is abandoned,
/// and `started` is created when one begins.
fn hanging(names: &[&str], dropped: &Arc<AtomicBool>, started: Option<&Path>) -> SessionCommands {
	let dropped = Arc::clone(dropped);
	let started = started.map(Path::to_path_buf);
	commands(names, move |_| {
		let flag = DropFlag(Arc::clone(&dropped));
		if let Some(started) = &started {
			std::fs::write(started, b"").expect("mark started");
		}
		Box::pin(async move {
			let _flag = flag;
			std::future::pending::<Result<SessionCommandResult, String>>().await
		})
	})
}

async fn run(
	shell: &Shell,
	command: &str,
	commands: Option<SessionCommands>,
	cwd: Option<&Path>,
	timeout_ms: Option<u32>,
) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions {
				command: command.to_owned(),
				cwd: cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
				commands,
				..Default::default()
			},
			Some(tx),
			CancelToken::new(timeout_ms),
		)
		.await
		.expect("run");
	(result, rx.drain().collect())
}

/// Wait up to a second for `flag`.
async fn eventually(flag: &AtomicBool) -> bool {
	let deadline = Instant::now() + Duration::from_secs(1);
	while !flag.load(Ordering::Acquire) {
		if Instant::now() > deadline {
			return false;
		}
		tokio::time::sleep(Duration::from_millis(5)).await;
	}
	true
}

/// Output feeds pipelines and substitutions; stdin reaches the handler only
/// through a bare `-`.
#[tokio::test(flavor = "multi_thread")]
async fn commands_compose_and_read_stdin_only_for_dash() {
	let log = Log::default();
	let (result, output) = run(
		&Shell::new(None),
		"printf payload | probe read - | tr a-z A-Z; printf '<%s>' \"$(probe sub value)\"",
		Some(echoing(&["probe"], &log)),
		None,
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "PROBE|READ,-|PAYLOAD\n<probe|sub,value|>");
	let requests = log.lock().expect("log");
	let seen: Vec<(Vec<&str>, &str)> = requests
		.iter()
		.map(|request| (request.argv.iter().map(String::as_str).collect(), request.stdin.as_str()))
		.collect();
	assert_eq!(seen, [(vec!["read", "-"], "payload"), (vec!["sub", "value"], "")]);
}

/// Without `-` the command leaves stdin to its reader: a `while read` loop
/// keeps every line, a reader after the command still gets the piped input,
/// and an endless producer does not stall the pipeline.
#[tokio::test(flavor = "multi_thread")]
async fn commands_without_dash_leave_stdin_and_report_the_shell_cwd() {
	let root = tempfile::tempdir().expect("tempdir");
	let sub = root.path().join("sub");
	std::fs::create_dir(&sub).expect("mkdir");
	let log = Log::default();
	let (result, output) = run(
		&Shell::new(None),
		"printf 'one\\ntwo\\n' | while read -r line; do probe \"$line\"; done; yes x | probe flood; \
		 printf 'a\\nb\\n' | { probe first; cat; }",
		Some(echoing(&["probe"], &log)),
		Some(&sub),
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "probe|one|\nprobe|two|\nprobe|flood|\nprobe|first|\na\nb\n");
	let requests = log.lock().expect("log");
	assert_eq!(requests.len(), 4);
	let sub = std::fs::canonicalize(&sub).expect("canonical sub");
	for request in requests.iter() {
		assert!(request.stdin.is_empty());
		assert_eq!(std::fs::canonicalize(&request.cwd).expect("canonical cwd"), sub);
	}
}

/// The reply's stderr follows `2>` and its exit code (clamped to a status)
/// drives `&&`, `||` and `$?`; a failed call reports its reason on stderr
/// with status 1.
#[tokio::test(flavor = "multi_thread")]
async fn replies_set_stderr_and_status_and_failures_report_their_reason() {
	let reply = commands(&["probe"], |request| {
		Box::pin(async move {
			let code = match request.argv[0].as_str() {
				"pass" => return Ok(ok("")),
				"fail" => 23,
				"big" => 300,
				"neg" => -4,
				_ => return Err("boom".to_owned()),
			};
			Ok(SessionCommandResult {
				stdout:    "partial\n".to_owned(),
				stderr:    "diag\n".to_owned(),
				exit_code: code,
			})
		})
	});
	let root = tempfile::tempdir().expect("tempdir");
	let (result, output) = run(
		&Shell::new(None),
		"probe fail 2> err && echo yes || echo \"no=$?\"; cat err; probe pass && echo and-ran; \
		 probe big >/dev/null 2>&1; echo \"s=$?\"; probe neg >/dev/null 2>&1; echo \"s=$?\"; probe \
		 reject 2>&1; echo \"s=$?\"",
		Some(reply),
		Some(root.path()),
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "partial\nno=23\ndiag\nand-ran\ns=255\ns=0\nprobe: boom\ns=1\n");
}

/// The names a session command can never take: reserved words, builtins,
/// pi's tools and utilities, and the in-engine shells.
#[test]
fn reserved_names_cover_every_earlier_resolution() {
	let reserved = reserved_command_names();
	for name in ["if", "[[", "echo", "cd", "cat", "grep", "timeout", "git", "bash", "sh", "zsh"] {
		assert!(reserved.contains(&name), "{name} is not listed as reserved");
	}
	assert!(!reserved.contains(&"probe"));
}

/// A session command wins over a `PATH` program of its name, while an
/// intrinsic (`echo`), an extra (`cat`), a tool (`timeout`) and an in-engine
/// shell (`bash`) win over a session command of theirs; a path is never a
/// session command.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn session_commands_resolve_between_builtins_and_path() {
	use std::os::unix::fs::PermissionsExt as _;

	let root = tempfile::tempdir().expect("tempdir");
	let bin = root.path().join("bin");
	std::fs::create_dir(&bin).expect("mkdir bin");
	let program = bin.join("probe");
	std::fs::write(&program, "#!/bin/sh\necho from-path\n").expect("write program");
	std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("chmod");
	let on_path = "PATH=\"$PWD/bin:$PATH\"; probe";

	let shell = Shell::new(None);
	let (result, output) = run(&shell, on_path, None, Some(root.path()), Some(10_000)).await;
	assert_eq!((result.exit_code, output.as_str()), (Some(0), "from-path\n"));

	let log = Log::default();
	let (result, output) = run(
		&shell,
		&format!(
			"{on_path}; echo hi; printf x | cat; echo; type -t probe; command -v probe; ./probe \
			 2>/dev/null || echo no-path"
		),
		Some(echoing(&["echo", "cat", "timeout", "bash", "probe"], &log)),
		Some(root.path()),
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "probe||\nhi\nx\nbuiltin\nprobe\nno-path\n");
	assert_eq!(log.lock().expect("log").len(), 1);
}

/// While a name is installed, a function or alias of that name defined
/// earlier in the persistent shell, or a function defined earlier on the same
/// line, does not run in its place, and `type`/`command -v` report the
/// session command; other names keep theirs, and a run that does not install
/// the name gets the function and alias back.
#[tokio::test(flavor = "multi_thread")]
async fn functions_and_aliases_never_stand_in_for_session_commands() {
	let shell = Shell::new(None);
	let (result, output) = run(
		&shell,
		"shopt -s expand_aliases; github() { echo function; }; alias ghx='echo alias'; other() { \
		 echo other-fn; }",
		None,
		None,
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let (_, output) = run(&shell, "github; ghx", None, None, Some(10_000)).await;
	assert_eq!(output, "function\nalias\n", "the function and alias are not in effect");

	let log = Log::default();
	let (result, output) = run(
		&shell,
		"github; ghx; other; type -t github; type -t ghx; command -v github; command -v ghx",
		Some(echoing(&["github", "ghx"], &log)),
		None,
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "github||\nghx||\nother-fn\nbuiltin\nbuiltin\ngithub\nghx\n");

	let (result, output) = run(
		&shell,
		"github() { echo redefined; }; github",
		Some(echoing(&["github"], &log)),
		None,
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "github||\n");
	assert_eq!(log.lock().expect("log").len(), 3);

	let (_, output) = run(&shell, "github; ghx", None, None, Some(10_000)).await;
	assert_eq!(output, "redefined\nalias\n");
}

/// Functions, subshells, background jobs and the tools that run command lines
/// in subshells of the caller all reach the command.
#[tokio::test(flavor = "multi_thread")]
async fn commands_run_wherever_the_shell_runs_a_command() {
	let root = tempfile::tempdir().expect("tempdir");
	let log = Log::default();
	let (result, output) = run(
		&Shell::new(None),
		"timeout 5 probe t; echo x | xargs probe xa; env probe e; f() { probe fn; }; f; (probe \
		 sub); probe bg & wait; find . -maxdepth 0 -exec probe fx {} \\;",
		Some(echoing(&["probe"], &log)),
		Some(root.path()),
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		"probe|t|\nprobe|xa,x|\nprobe|e|\nprobe|fn|\nprobe|sub|\nprobe|bg|\nprobe|fx,.|\n"
	);
}

/// Stdin past the limit, or not UTF-8, fails the command with status 2
/// without calling the handler.
#[tokio::test(flavor = "multi_thread")]
async fn unusable_stdin_fails_with_status_2() {
	let log = Log::default();
	let (result, output) = run(
		&Shell::new(None),
		"yes | head -c 16777217 | probe - 2>&1; echo \"s=$?\"; printf '\\377' | probe - 2>&1; echo \
		 \"s=$?\"",
		Some(echoing(&["probe"], &log)),
		None,
		Some(30_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let lines: Vec<&str> = output.lines().collect();
	assert_eq!(lines.len(), 4, "{output}");
	assert!(lines[0].starts_with("probe: "), "{output}");
	assert_eq!(lines[1], "s=2");
	assert!(lines[2].starts_with("probe: "), "{output}");
	assert_eq!(lines[3], "s=2");
	assert!(log.lock().expect("log").is_empty());
}

/// Calls of commands running at once are in flight at once.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_invocations_are_in_flight_together() {
	let barrier = Arc::new(tokio::sync::Barrier::new(2));
	let reply = commands(&["probe"], move |request| {
		let barrier = Arc::clone(&barrier);
		Box::pin(async move {
			barrier.wait().await;
			Ok(ok(&format!("{}\n", request.argv.join(","))))
		})
	});
	let (result, output) =
		run(&Shell::new(None), "probe a & probe b & wait", Some(reply), None, Some(10_000)).await;
	assert!(!result.timed_out, "the second call never started while the first waited");
	assert_eq!(result.exit_code, Some(0));
	let mut lines: Vec<&str> = output.lines().collect();
	lines.sort_unstable();
	assert_eq!(lines, ["a", "b"]);
}

/// A timed-out run ends promptly and abandons the pending call; the shell
/// then serves the next run's commands.
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_the_run_abandons_a_pending_call() {
	let shell = Shell::new(None);
	let dropped = Arc::new(AtomicBool::new(false));
	let started = Instant::now();
	let (result, _) =
		run(&shell, "probe pending", Some(hanging(&["probe"], &dropped, None)), None, Some(100))
			.await;
	let elapsed = started.elapsed();
	assert!(elapsed < Duration::from_millis(1500), "the cancelled run took {elapsed:?}");
	assert!(result.timed_out);
	assert_eq!(result.exit_code, None);
	assert!(eventually(&dropped).await, "the pending call was not abandoned");

	let log = Log::default();
	let (result, output) =
		run(&shell, "probe after", Some(echoing(&["probe"], &log)), None, Some(10_000)).await;
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(output, "probe|after|\n");
}

/// `kill -TERM` ends a session command as it ends an in-process utility.
#[tokio::test(flavor = "multi_thread")]
async fn term_cancels_like_an_extra() {
	let root = tempfile::tempdir().expect("tempdir");
	let dropped = Arc::new(AtomicBool::new(false));
	let started = root.path().join("started");
	let (result, output) = run(
		&Shell::new(None),
		"sleep 100 & p=$!; sleep 0.3; kill -TERM $p; wait $p; echo \"extra=$?\"; probe hang & p=$!; \
		 while [ ! -e started ]; do sleep 0.01; done; kill -TERM $p; wait $p; echo \"command=$?\"",
		Some(hanging(&["probe"], &dropped, Some(&started))),
		Some(root.path()),
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let status = |key: &str| {
		output
			.lines()
			.find_map(|line| line.strip_prefix(key))
			.map(str::to_owned)
	};
	let extra = status("extra=").expect("extra status");
	assert_eq!(status("command=").as_deref(), Some(extra.as_str()), "{output}");
	assert_ne!(extra, "0");
	assert!(eventually(&dropped).await, "the cancelled call was not abandoned");
}

/// Each run's commands are its own: a later run replaces them, and one without
/// any leaves the name to `PATH`; a name outside the run's set is not found.
#[tokio::test(flavor = "multi_thread")]
async fn each_run_installs_its_own_commands() {
	let shell = Shell::new(None);
	let first = commands(&["omp_probe"], |_| Box::pin(async { Ok(ok("first")) }));
	let second = commands(&["omp_probe"], |_| Box::pin(async { Ok(ok("second")) }));
	let (_, output) = run(&shell, "omp_probe", Some(first), None, Some(10_000)).await;
	assert_eq!(output, "first");
	let (_, output) = run(&shell, "omp_probe", Some(second.clone()), None, Some(10_000)).await;
	assert_eq!(output, "second");
	let (result, output) =
		run(&shell, "omp_other 2>&1; echo \"s=$?\"", Some(second), None, Some(10_000)).await;
	assert!(output.contains("omp_other"), "{output}");
	assert!(output.contains("command not found"), "{output}");
	assert!(output.ends_with("s=127\n"), "{output}");
	assert_eq!(result.exit_code, Some(0));
	let (result, _) = run(&shell, "omp_probe 2>/dev/null", None, None, Some(10_000)).await;
	assert_eq!(result.exit_code, Some(127));
}

/// A background job that outlives its run cannot reach the handler: a call
/// still waiting for its input fails once the run ends, and a later
/// invocation no longer resolves.
#[tokio::test(flavor = "multi_thread")]
async fn background_jobs_lose_the_commands_when_their_run_ends() {
	let root = tempfile::tempdir().expect("tempdir");
	let shell = Shell::new(None);
	let calls = Arc::new(AtomicUsize::new(0));
	let counted = {
		let calls = Arc::clone(&calls);
		commands(&["omp_probe"], move |_| {
			calls.fetch_add(1, Ordering::AcqRel);
			Box::pin(async { Ok(ok("must-not-run")) })
		})
	};
	let (result, output) = run(
		&shell,
		"{ while [ ! -e go ]; do sleep 0.01; done; } | omp_probe - 2> pending & { while [ ! -e go \
		 ]; do sleep 0.01; done; omp_probe late 2>/dev/null; echo \"status=$?\" > late; } & sleep \
		 0.3; printf done",
		Some(counted),
		Some(root.path()),
		Some(10_000),
	)
	.await;
	assert_eq!((result.exit_code, output.as_str()), (Some(0), "done"));

	let (result, output) = run(
		&shell,
		"while [ ! -s pending ]; do sleep 0.01; done; cat pending; touch go; while [ ! -s late ]; \
		 do sleep 0.01; done; cat late",
		None,
		Some(root.path()),
		Some(10_000),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let lines: Vec<&str> = output.lines().collect();
	assert_eq!(lines.len(), 2, "{output}");
	assert!(lines[0].starts_with("omp_probe: "), "{output}");
	assert_eq!(lines[1], "status=127");
	assert_eq!(calls.load(Ordering::Acquire), 0);
}
