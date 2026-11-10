use super::*;

/// `cmp` remains available with no executable search path, proving the shell
/// dispatches the in-process builtin rather than a platform binary.
#[tokio::test(flavor = "multi_thread")]
async fn cmp_is_registered_as_an_in_process_builtin() {
	let dir = tempfile::tempdir().expect("temp dir");
	let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");
	std::fs::write(root.join("a"), b"same").expect("write a");
	std::fs::write(root.join("b"), b"same").expect("write b");
	std::fs::write(root.join("c"), b"different").expect("write c");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(
			format!("cd {}", quote_arg(root.to_str().expect("utf8 temp path"))),
			&TestStdio::null(),
		)
		.await
		.expect("set cwd");
	let params = TestStdio::null();

	let equal = session
		.run_test("PATH=/definitely-missing cmp -s a b", &params)
		.await
		.expect("equal cmp");
	assert_eq!(exit_code(&equal), 0);

	let different = session
		.run_test("PATH=/definitely-missing cmp -s a c", &params)
		.await
		.expect("different cmp");
	assert_eq!(exit_code(&different), 1);
}

/// The moreutils-style builtins (`ts`, `sponge`, `isutf8`, `combine`,
/// `ifne`, `errno`) dispatch in-process: the script runs with no usable
/// executable search path, and the `ts | sponge` pipeline must land its
/// output in the shell's working directory.
#[tokio::test(flavor = "multi_thread")]
async fn moreutils_builtins_are_registered_in_process() {
	let dir = tempfile::tempdir().expect("temp dir");
	let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(
			format!("cd {}", quote_arg(root.to_str().expect("utf8 temp path"))),
			&TestStdio::null(),
		)
		.await
		.expect("set cwd");
	let params = TestStdio::null();

	let script = "PATH=/definitely-missing\necho x | ts -s '%H:%M:%S' | sponge out || exit \
	              10\nisutf8 out || exit 11\necho x | combine - and out || exit 12\nifne \
	              /definitely-missing/tool || exit 13";
	let result = session
		.run_test(script, &params)
		.await
		.expect("moreutils script");
	assert_eq!(exit_code(&result), 0);

	// `ts -s` stamps the first line with zero elapsed time: `HH:MM:SS x`.
	let out = std::fs::read_to_string(root.join("out")).expect("sponge output");
	assert!(out.len() == 11 && out.ends_with(" x\n"), "unexpected ts+sponge output: {out:?}");

	#[cfg(unix)]
	{
		let errno = session
			.run_test("errno ENOENT", &params)
			.await
			.expect("errno lookup");
		assert_eq!(exit_code(&errno), 0);
	}
}

/// `sort --compress-program` spawns real children from inside the
/// external-sort temp-file machinery. Those children must inherit the
/// *shell's* context, not the host process's: the program is resolved
/// against the shell's exported `PATH` (here a directory that exists only
/// there), it runs in the shell working directory, and its stderr is
/// forwarded to the command's own fd 2 instead of being inherited — an
/// inherited fd 2 belongs to the TUI and would corrupt the rendered frame.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn uutils_sort_compress_program_uses_shell_path_and_stderr() {
	use std::os::unix::fs::PermissionsExt as _;

	let tmp = std::env::temp_dir().join(format!("pi-sort-compress-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	let bin = tmp.join("bin");
	std::fs::create_dir_all(&bin).expect("bin dir");

	// An identity "compressor" that also proves it was started with the
	// shell's working directory and reaches the command's stderr.
	let shim = bin.join("pi-test-compress");
	let shell = test_executable("sh");
	let cat = test_executable("cat");
	let shim_source = format!(
		"#!{}\nprintf 'compressor cwd=%s\\n' \"$PWD\" >&2\nexec {}\n",
		shell.display(),
		quote_arg(cat.to_str().expect("utf8 cat path"))
	);
	std::fs::write(&shim, shim_source).expect("write shim");
	std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).expect("chmod shim");

	// Enough distinct lines that the 1K buffer forces spilling through the
	// compressor rather than sorting entirely in memory.
	let mut input = String::new();
	for n in (0..400).rev() {
		use std::fmt::Write as _;
		let _ = writeln!(input, "line{n:04}");
	}
	std::fs::write(tmp.join("in.txt"), &input).expect("write input");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(
			format!("cd {}", quote_arg(tmp.to_str().expect("utf8 temp path"))),
			&TestStdio::null(),
		)
		.await
		.expect("set cwd");
	let params = TestStdio::null();

	// `PATH` holds only the shim directory, so the compressor is reachable
	// solely through the shell's exported environment.
	let script = format!(
		"export PATH={}\nsort -S 1K --compress-program=pi-test-compress in.txt > out.txt 2> err.txt",
		bin.to_str().expect("utf8 bin path")
	);
	let exec = session.run_test(script, &params).await.expect("run sort");
	assert_eq!(exit_code(&exec), 0, "sort --compress-program failed");

	let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
	let mut expected: Vec<&str> = input.lines().collect();
	expected.sort_unstable();
	assert_eq!(out.lines().collect::<Vec<_>>(), expected, "compressed external sort misordered");

	// The compressor really ran (so the spill path was exercised), its
	// stderr reached the command's redirected fd 2, and it started in the
	// shell working directory.
	let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
	assert!(
		err.contains("compressor cwd="),
		"compressor stderr never reached the command's fd 2: {err:?}"
	);
	// The shell reports the working directory as it was set; macOS also
	// exposes it under `/private`, so accept either spelling.
	let canonical = std::fs::canonicalize(&tmp).expect("canonical tmp");
	assert!(
		err.contains(&format!("cwd={}\n", tmp.display()))
			|| err.contains(&format!("cwd={}\n", canonical.display())),
		"compressor did not start in the shell working directory ({}): {err:?}",
		tmp.display()
	);

	let _ = std::fs::remove_dir_all(&tmp);
}

/// The uutils-backed `mkdir` builtin must (1) create directories under the
/// shell's working directory rather than the host process cwd, (2) route
/// `-v` output through the command's (here redirected) stdout, and (3)
/// display the original operand, not the resolved absolute path.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_mkdir_resolves_cwd_and_displays_operand() {
	let tmp = std::env::temp_dir().join(format!("pi-mkdir-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	let tmp_str = tmp.to_str().expect("utf8 temp path");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("set cwd");

	let params = TestStdio::null();

	let exec = session
		.run_test("mkdir -v -p a/b/c rel > out.txt", &params)
		.await
		.expect("run");
	assert!(exec.status == 0, "exit {}", exit_code(&exec));

	// (1) created under the shell working dir, and (2) not leaked into the
	// host process cwd.
	assert!(tmp.join("a/b/c").is_dir(), "nested dirs not created under shell cwd");
	assert!(tmp.join("rel").is_dir(), "rel not created under shell cwd");
	assert!(!std::path::Path::new("a/b/c").exists(), "mkdir leaked into process cwd");

	// (2)+(3): -v output reached the redirected file, names the operand, and
	// does not leak the absolute resolved path.
	let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
	assert!(out.contains("'rel'"), "verbose output missing operand `rel`: {out:?}");
	assert!(!out.contains(tmp_str), "verbose output leaked absolute path: {out:?}");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// `command -v`/`-V` must iterate over every operand like bash/zsh, printing
/// one line per name that resolves and skipping the misses, rather than
/// honoring only the first operand. Regression test for silently dropped
/// operands in `command -v a b c` (issue #10544).
#[tokio::test(flavor = "multi_thread")]
async fn command_v_iterates_all_operands() {
	let tmp = std::env::temp_dir().join(format!("pi-command-v-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	let tmp_str = tmp.to_str().expect("utf8 temp path");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("set cwd");

	let params = TestStdio::null();

	// Three always-registered builtins plus a name that never resolves. bash
	// prints one line per resolved builtin and skips the miss, exiting 0.
	let exec = session
		.run_test("command -v true false pwd nope-xyz-10544 > out.txt", &params)
		.await
		.expect("run");
	assert_eq!(exit_code(&exec), 0, "command -v exit code with a resolvable name");

	let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
	let lines: Vec<&str> = out.lines().collect();
	assert_eq!(
		lines,
		vec!["true", "false", "pwd"],
		"command -v must print one line per resolved operand and skip misses: {out:?}"
	);

	// When no operand resolves, the exit status is a general error.
	let exec = session
		.run_test("command -v nope-a-10544 nope-b-10544", &params)
		.await
		.expect("run");
	assert_eq!(exit_code(&exec), 1, "command -v exit code when nothing resolves");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// Every utility `pi-builtins` offers must actually be dispatchable in
/// process, under the name it is registered as.
///
/// The registry (`pi_builtins::extras::extras()`, its
/// [`pi_builtins::extras::ExtraKind::Utility`] rows) maps a name to an
/// implementation, and each renders its help from its own `clap` command.
/// Wiring a name to the wrong module — easy to do, since the
/// mapping is written by hand — still compiles and still runs; the only
/// visible symptom is that `NAME --help` describes some other utility. With
/// `PATH` emptied there is no binary to fall back on, so this also proves
/// the whole set resolves as builtins rather than as system commands.
#[tokio::test(flavor = "multi_thread")]
async fn every_utility_builtin_is_registered_under_its_own_name() {
	let tmp = std::env::temp_dir().join(format!("pi-utility-help-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(
			format!("cd {}", quote_arg(tmp.to_str().expect("utf8 temp path"))),
			&TestStdio::null(),
		)
		.await
		.expect("set cwd");
	let params = TestStdio::null();

	// Pin the registry contents rather than iterating whatever it happens to
	// contain: a loop over the registry cannot notice a name missing from it.
	// Adding a utility is expected to update this list.
	let expected = [
		"ast-grep",
		"b2sum",
		"base32",
		"base64",
		"basename",
		"cat",
		#[cfg(unix)]
		"chmod",
		"cksum",
		"cmp",
		"combine",
		"comm",
		"cp",
		"cut",
		"date",
		"dd",
		"df",
		"diff",
		"dirname",
		"du",
		"env",
		#[cfg(unix)]
		"errno",
		"fd",
		"find",
		"fold",
		"grep",
		"head",
		"hostname",
		#[cfg(unix)]
		"id",
		"ifne",
		"isutf8",
		"jq",
		"ln",
		"ls",
		"md5sum",
		"mkdir",
		"mktemp",
		"mv",
		"nl",
		"nproc",
		"od",
		"paste",
		"printenv",
		"readlink",
		"realpath",
		"rg",
		"rm",
		"rmdir",
		"rsync",
		"sd",
		"sed",
		"seq",
		"sg",
		"sha1sum",
		"sha224sum",
		"sha256sum",
		"sha384sum",
		"sha512sum",
		"sort",
		"sponge",
		"stat",
		"tac",
		"tail",
		"tee",
		"touch",
		"tr",
		"truncate",
		"ts",
		"uname",
		"uniq",
		"uptime",
		"wc",
		"which",
		"whoami",
		"xargs",
		"yes",
	];
	let mut names: Vec<&'static str> = pi_builtins::extras::extras()
		.filter(|(_, kind)| matches!(kind, pi_builtins::extras::ExtraKind::Utility { .. }))
		.map(|(name, _)| name)
		.collect();
	names.sort_unstable();
	assert_eq!(names, expected, "the utility builtin registry changed");

	for name in names {
		// The session resolves the name as a builtin of its own, not a file
		// on a search path.
		let exec = session
			.run_test(format!("PATH= type -t {name} > type.txt"), &params)
			.await
			.unwrap_or_else(|err| panic!("type -t {name} failed to run: {err}"));
		assert_eq!(exit_code(&exec), 0, "type -t {name} found nothing");
		let kind = std::fs::read_to_string(tmp.join("type.txt")).expect("type.txt");
		assert_eq!(kind, "builtin\n", "{name} is not a session builtin");

		let exec = session
			.run_test(format!("PATH= {name} --help > help.txt 2> err.txt"), &params)
			.await
			.unwrap_or_else(|err| panic!("{name} --help failed to run: {err}"));
		assert_eq!(exit_code(&exec), 0, "{name} --help exited nonzero");

		let help = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
		let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
		assert!(err.is_empty(), "{name} --help wrote to stderr: {err:?}");
		// Some builtins are registered under the familiar command name but
		// keep their implementation's own help text, exactly as the
		// standalone versions did: `rg` is ripgrep, `jq` is jaq, `sg`
		// is ast-grep (whose help names itself only through its usage
		// line, here `sg`).
		let expected = match name {
			"rg" => "ripgrep",
			"jq" => "jaq",
			"sg" => "using AST pattern",
			other => other,
		};
		assert!(
			help.contains(expected),
			"{name} --help does not mention {expected:?}, so it is wired to the wrong utility: \
			 {help:.200?}"
		);
	}

	let _ = std::fs::remove_dir_all(&tmp);
}

/// Every process builtin pi offers must be installed and dispatch in
/// process: `pi-builtins`' process extras and the engine tools `nohup` and
/// `timeout` (`src/tools`).
///
/// `pi_builtins::extras` maps each name to a struct by hand, so a mis-wire
/// compiles and runs — and with `PATH` emptied there is no binary to silently
/// fall back to, which is the failure this catches. Each command gets an
/// invocation that is benign but must reach the builtin: exit 127 means the
/// name never resolved.
#[tokio::test(flavor = "multi_thread")]
async fn every_process_builtin_is_installed_and_dispatches() {
	let tmp = std::env::temp_dir().join(format!("pi-process-builtins-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(
			format!("cd {}", quote_arg(tmp.to_str().expect("utf8 temp path"))),
			&TestStdio::null(),
		)
		.await
		.expect("set cwd");
	let params = TestStdio::null();

	// Bounded, side-effect-free invocations. `pgrep`/`pkill`/`pidwait` render
	// their own help; `sleep`/`timeout`/`top` are given the smallest amount
	// of work that still exercises dispatch; `nohup` with no operand is a
	// usage error, which is still the builtin answering.
	let probes = [
		("nohup", "nohup"),
		("pgrep", "pgrep --help"),
		("pidwait", "pidwait --help"),
		("pkill", "pkill --help"),
		("ps", "ps --help"),
		("sleep", "sleep 0"),
		("timeout", "timeout 1 true"),
		("top", "top -n 0"),
	];

	// Pin the registry contents rather than deriving the probe list from it:
	// a test that skips whatever the registry omits cannot notice an
	// omission. `nohup` and `timeout` are engine tools, not extras; the
	// session loop below proves they are installed like the rest.
	// `kill` is the engine's own intrinsic (with pi's refusal policy), so it
	// is checked alongside but not listed here even when the table carries it.
	let tools = ["nohup", "timeout"];
	let mut registered: Vec<&'static str> = pi_builtins::extras::extras()
		.filter(|(name, kind)| {
			*name != "kill" && !matches!(kind, pi_builtins::extras::ExtraKind::Utility { .. })
		})
		.map(|(name, _)| name)
		.collect();
	registered.sort_unstable();
	assert_eq!(
		registered,
		["pgrep", "pidwait", "pkill", "ps", "sleep", "top"],
		"the process builtin registry changed"
	);
	let mut offered: Vec<&'static str> = registered.iter().copied().chain(tools).collect();
	offered.sort_unstable();
	let expected: Vec<&'static str> = probes.iter().map(|(name, _)| *name).collect();
	assert_eq!(offered, expected, "every process builtin and tool has a probe");

	for (name, command) in probes.iter().copied().chain([("kill", "kill -l")]) {
		let exec = session
			.run_test(format!("PATH= type -t {name} > type.txt"), &params)
			.await
			.unwrap_or_else(|err| panic!("type -t {name} failed to run: {err}"));
		assert_eq!(exit_code(&exec), 0, "type -t {name} found nothing");
		let kind = std::fs::read_to_string(tmp.join("type.txt")).expect("type.txt");
		assert_eq!(kind, "builtin\n", "{name} is not a session builtin");

		let exec = session
			.run_test(format!("PATH= {command}"), &params)
			.await
			.unwrap_or_else(|err| panic!("{name} failed to run: {err}"));
		assert_ne!(
			exit_code(&exec),
			127,
			"{name} resolved to nothing: it is not registered as a builtin"
		);
	}

	let _ = std::fs::remove_dir_all(&tmp);
}

/// Regression test for issue #5819: `mkdir -p ~/proj/{a,b}` must create both
/// `a` and `b` under `$HOME/proj`. Brace expansion runs before tilde
/// expansion and previously left every element after the first with a
/// literal `~`, so `b` was created as `./~/proj/b` in the shell cwd instead.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_mkdir_expands_tilde_for_every_brace_element() {
	let base = std::env::temp_dir().join(format!("pi-mkdir-brace-{}", std::process::id()));
	let home = base.join("home");
	let cwd = base.join("cwd");
	let _ = std::fs::remove_dir_all(&base);
	std::fs::create_dir_all(&home).expect("home dir");
	std::fs::create_dir_all(&cwd).expect("cwd dir");
	let cwd_str = cwd.to_str().expect("utf8 cwd path");

	let mut env = HashMap::new();
	env.insert("HOME".to_string(), home.to_string_lossy().to_string());
	let config = ShellConfig {
		session_env:   Some(env),
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(cwd_str)), &TestStdio::null())
		.await
		.expect("set cwd");

	let params = TestStdio::null();

	let exec = session
		.run_test("mkdir -p ~/proj/{a,b}", &params)
		.await
		.expect("run");
	assert!(exec.status == 0, "exit {}", exit_code(&exec));

	// Both elements' tildes expanded: dirs land under $HOME/proj.
	assert!(home.join("proj/a").is_dir(), "~/proj/a not created under HOME");
	assert!(home.join("proj/b").is_dir(), "~/proj/b not created under HOME");
	// The buggy path created a literal `~` tree in the shell cwd.
	assert!(!cwd.join("~").exists(), "literal ~ tree leaked into cwd");
	assert!(!cwd.join("a").exists(), "unexpanded element leaked into cwd");

	let _ = std::fs::remove_dir_all(&base);
}

/// `mkdir --help` and an invalid flag must be handled in-process: rendered
/// to the command streams and returned as an exit code. The upstream
/// `uumain` parser calls `std::process::exit`, which would terminate the
/// whole host (and this test binary); reaching the asserts proves the
/// vendored `run` entry point bypasses that path.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_mkdir_help_and_bad_flag_do_not_exit_process() {
	let tmp = std::env::temp_dir().join(format!("pi-mkdir-help-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	let tmp_str = tmp.to_str().expect("utf8 temp path");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("set cwd");

	let params = TestStdio::null();

	let help = session
		.run_test("mkdir --help > help.txt", &params)
		.await
		.expect("run help");
	assert_eq!(exit_code(&help), 0, "mkdir --help should succeed");
	let help_text = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
	assert!(help_text.contains("mkdir"), "help text missing util name: {help_text:?}");

	let bad = session
		.run_test("mkdir --no-such-flag 2> err.txt", &params)
		.await
		.expect("run bad flag");
	assert_ne!(exit_code(&bad), 0, "invalid flag should be a usage error");
	let err_text = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
	assert!(!err_text.is_empty(), "usage error should be reported to stderr");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// The uutils-backed `head` builtin must read piped stdin through the
/// context, read file operands resolved against the shell working directory,
/// honor the obsolete `-NUM` syntax, and write to the command's (here
/// redirected) stdout.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_head_streams_stdin_and_reads_files() {
	let tmp = std::env::temp_dir().join(format!("pi-head-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	std::fs::write(tmp.join("data.txt"), "l1\nl2\nl3\nl4\nl5\n").expect("write data");
	let tmp_str = tmp.to_str().expect("utf8 temp path");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("set cwd");

	let params = TestStdio::null();

	// File operand, resolved against the shell working directory.
	let f = session
		.run_test("head -2 data.txt > out_file.txt", &params)
		.await
		.expect("run file");
	assert_eq!(exit_code(&f), 0, "head file read should succeed");
	assert_eq!(std::fs::read_to_string(tmp.join("out_file.txt")).unwrap(), "l1\nl2\n");

	// Piped stdin (head is the final stage; reads the pipe through the ctx).
	let p = session
		.run_test("printf 'a\\nb\\nc\\nd\\n' | head -2 > out_pipe.txt", &params)
		.await
		.expect("run pipe");
	assert_eq!(exit_code(&p), 0, "head stdin read should succeed");
	assert_eq!(std::fs::read_to_string(tmp.join("out_pipe.txt")).unwrap(), "a\nb\n");

	// Obsolete `-NUM` syntax, normalized by arg_iterate.
	let o = session
		.run_test("printf '1\\n2\\n3\\n' | head -1 > out_obs.txt", &params)
		.await
		.expect("run obsolete");
	assert_eq!(exit_code(&o), 0, "head -1 should succeed");
	assert_eq!(std::fs::read_to_string(tmp.join("out_obs.txt")).unwrap(), "1\n");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// `head --help` / invalid flag must be handled in-process (rendered to the
/// command streams, returned as an exit code) — head has its own `run`
/// entry point bypassing uutils' process-exiting parser, and literalized
/// help strings.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_head_help_and_bad_flag_do_not_exit_process() {
	let tmp = std::env::temp_dir().join(format!("pi-head-help-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	let tmp_str = tmp.to_str().expect("utf8 temp path");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("set cwd");

	let params = TestStdio::null();

	let help = session
		.run_test("head --help > help.txt", &params)
		.await
		.expect("run head help");
	assert_eq!(exit_code(&help), 0, "head --help should succeed");
	let help_text = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
	assert!(help_text.contains("first"), "help text not localized: {help_text:?}");

	let bad = session
		.run_test("head --no-such-flag 2> err.txt", &params)
		.await
		.expect("run head bad flag");
	assert_ne!(exit_code(&bad), 0, "invalid flag should be a usage error");
	assert_ne!(std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt"), "");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// Smoke-test the read-only uutils filter/listing builtins end-to-end
/// through the shell: piped stdin (sort/wc/tail), file reads + cwd
/// resolution (grep/ls/find), and redirected stdout capture.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_filters_listing_find_grep() {
	let tmp = std::env::temp_dir().join(format!("pi-utils-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(tmp.join("sub")).expect("temp dirs");
	std::fs::write(tmp.join("data.txt"), "foo\nbar\nbaz\n").expect("data");
	std::fs::write(tmp.join("sub/nested.txt"), "deep\n").expect("nested");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	// sort: reads piped stdin, parallel sort, writes sorted output.
	session
		.run_test("printf 'c\\na\\nb\\n' | sort > sort.txt", &params)
		.await
		.expect("sort");
	assert_eq!(read("sort.txt"), "a\nb\nc\n");
	// wc -l: line count from stdin.
	session
		.run_test("printf 'x\\ny\\nz\\n' | wc -l > wc.txt", &params)
		.await
		.expect("wc");
	assert_eq!(read("wc.txt").trim(), "3");
	// tail: last N lines from stdin.
	session
		.run_test("printf '1\\n2\\n3\\n4\\n' | tail -2 > tail.txt", &params)
		.await
		.expect("tail");
	assert_eq!(read("tail.txt"), "3\n4\n");
	// grep: matching lines from a cwd-resolved file (single file => no
	// prefix).
	session
		.run_test("grep ba data.txt > grep.txt", &params)
		.await
		.expect("grep");
	assert_eq!(read("grep.txt"), "bar\nbaz\n");
	// ls: non-tty listing of the cwd.
	session.run_test("ls > ls.txt", &params).await.expect("ls");
	let ls = read("ls.txt");
	assert!(ls.contains("data.txt") && ls.contains("sub"), "ls output: {ls:?}");
	// find: recursive name match. Paths must keep the `.` operand prefix
	// (GNU/BSD contract) instead of leaking the working-dir-resolved absolute
	// root the walk is physically rooted at.
	session
		.run_test("find . -name '*.txt' > find.txt", &params)
		.await
		.expect("find");
	let found = read("find.txt");
	assert!(!found.trim().is_empty(), "find produced no output");
	for line in found.lines() {
		assert!(
			line.starts_with("./"),
			"find path is not operand-relative: {line:?} (full: {found:?})"
		);
	}
	assert!(
		found.contains("./data.txt") && found.contains("./sub/nested.txt"),
		"find output: {found:?}"
	);
	// cat: concatenate a cwd-resolved file with -n line numbering.
	session
		.run_test("cat -n data.txt > cat.txt", &params)
		.await
		.expect("cat");
	assert_eq!(read("cat.txt"), "     1\tfoo\n     2\tbar\n     3\tbaz\n");
	// uniq: collapse adjacent duplicate lines from piped stdin.
	session
		.run_test("printf 'a\\na\\nb\\nb\\nb\\nc\\n' | uniq > uniq.txt", &params)
		.await
		.expect("uniq");
	assert_eq!(read("uniq.txt"), "a\nb\nc\n");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// `rg` is not an alias for `grep`: it recurses by default, respects
/// ripgrep's ignore/hidden/binary filters, and keeps `-h` as help.
#[tokio::test(flavor = "multi_thread")]
async fn rg_builtin_uses_ripgrep_defaults() {
	let tmp = std::env::temp_dir().join(format!("pi-rg-defaults-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(tmp.join("sub")).expect("sub dir");
	std::fs::create_dir_all(tmp.join(".git")).expect("git dir");
	std::fs::write(tmp.join("data.txt"), "alpha\nneedle\n").expect("data");
	std::fs::write(tmp.join("sub/nested.txt"), "needle\n").expect("nested");
	std::fs::write(tmp.join(".hidden.txt"), "needle\n").expect("hidden");
	std::fs::write(tmp.join("ignored.log"), "needle\n").expect("ignored");
	std::fs::write(tmp.join(".gitignore"), "ignored.log\n").expect("gitignore");
	std::fs::write(tmp.join("binary.bin"), b"needle\0hidden\n").expect("binary");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	let exec = session
		.run_test("rg needle > rg.txt", &params)
		.await
		.expect("rg");
	assert_eq!(exit_code(&exec), 0, "rg recursive search should match");
	let out = read("rg.txt");
	assert!(out.contains("data.txt:needle"), "rg missed visible file: {out:?}");
	assert!(out.contains("sub/nested.txt:needle"), "rg missed nested file: {out:?}");
	assert!(!out.contains(".hidden.txt"), "rg searched hidden file by default: {out:?}");
	assert!(!out.contains("ignored.log"), "rg ignored .gitignore by default: {out:?}");
	assert!(!out.contains("binary.bin"), "rg printed binary file by default: {out:?}");

	let single = session
		.run_test("rg -nH needle data.txt > single.txt", &params)
		.await
		.expect("rg single");
	assert_eq!(exit_code(&single), 0, "rg explicit file should match");
	assert_eq!(read("single.txt"), "data.txt:2:needle\n");

	let explicit_binary = session
		.run_test("rg needle binary.bin > explicit-binary.txt", &params)
		.await
		.expect("rg explicit binary");
	assert_eq!(exit_code(&explicit_binary), 0, "explicit binary file should be searched");
	assert_eq!(read("explicit-binary.txt"), "needle\n");

	let help = session
		.run_test("rg -h > help.txt", &params)
		.await
		.expect("rg help");
	assert_eq!(exit_code(&help), 0, "rg -h should be help, not no-filename");
	assert!(
		read("help.txt").contains("ripgrep recursively searches"),
		"help text should describe ripgrep"
	);

	let _ = std::fs::remove_dir_all(&tmp);
}

/// `fd` recurses from the shell working directory, respects hidden and
/// ignore filters (including `.fdignore`), preserves explicit search-path
/// prefixes, and renders help to stdout with a success status.
#[tokio::test(flavor = "multi_thread")]
async fn fd_builtin_uses_fd_defaults() {
	let tmp = std::env::temp_dir().join(format!("pi-fd-defaults-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(tmp.join("sub")).expect("sub dir");
	std::fs::create_dir_all(tmp.join(".git/info")).expect("git info dir");
	std::fs::write(tmp.join("needle.txt"), "visible\n").expect("visible");
	std::fs::write(tmp.join("sub/needle.rs"), "nested\n").expect("nested");
	std::fs::write(tmp.join(".hidden-needle.txt"), "hidden\n").expect("hidden");
	std::fs::write(tmp.join("ignored-needle.log"), "ignored\n").expect("ignored");
	std::fs::write(tmp.join("excluded-needle.vcs"), "excluded\n").expect("excluded");
	std::fs::write(tmp.join("fdignored-needle.tmp"), "fdignored\n").expect("fdignored");
	std::fs::write(tmp.join(".gitignore"), "ignored-needle.log\n").expect("gitignore");
	std::fs::write(tmp.join(".git/info/exclude"), "excluded-needle.vcs\n").expect("exclude");
	std::fs::write(tmp.join(".fdignore"), "fdignored-needle.tmp\n").expect("fdignore");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	let exec = session
		.run_test("fd needle > fd.txt", &params)
		.await
		.expect("fd");
	assert_eq!(exit_code(&exec), 0, "fd should match visible files");
	let out = read("fd.txt");
	assert!(out.contains("needle.txt"), "fd missed visible file: {out:?}");
	assert!(out.contains("sub/needle.rs"), "fd missed nested file: {out:?}");
	assert!(!out.contains(".hidden-needle.txt"), "fd searched hidden file: {out:?}");
	assert!(!out.contains("ignored-needle.log"), "fd ignored .gitignore: {out:?}");
	assert!(!out.contains("fdignored-needle.tmp"), "fd ignored .fdignore: {out:?}");
	assert!(!out.contains("excluded-needle.vcs"), "fd ignored .git/info/exclude: {out:?}");

	session
		.run_test("fd -u needle > unrestricted.txt", &params)
		.await
		.expect("fd -u");
	let unrestricted = read("unrestricted.txt");
	assert!(unrestricted.contains(".hidden-needle.txt"), "-u should include hidden files");
	assert!(unrestricted.contains("ignored-needle.log"), "-u should include gitignored files");
	assert!(unrestricted.contains("fdignored-needle.tmp"), "-u should include fdignored files");

	session
		.run_test("fd --no-ignore-vcs needle > no-ignore-vcs.txt", &params)
		.await
		.expect("fd --no-ignore-vcs");
	let no_ignore_vcs = read("no-ignore-vcs.txt");
	assert!(
		no_ignore_vcs.contains("ignored-needle.log"),
		"--no-ignore-vcs should include .gitignore matches"
	);
	assert!(
		no_ignore_vcs.contains("excluded-needle.vcs"),
		"--no-ignore-vcs should include .git/info/exclude matches"
	);
	assert!(
		!no_ignore_vcs.contains("fdignored-needle.tmp"),
		"--no-ignore-vcs must still respect .fdignore"
	);

	session
		.run_test("fd --glob '*.rs' sub > glob.txt", &params)
		.await
		.expect("fd glob");
	assert_eq!(read("glob.txt"), "sub/needle.rs\n");

	let no_match = session
		.run_test("fd definitely-absent > no-match.txt", &params)
		.await
		.expect("fd no match");
	assert_eq!(exit_code(&no_match), 0, "ordinary fd no-match should still succeed");
	assert_eq!(read("no-match.txt"), "");

	let quiet_miss = session
		.run_test("fd -q definitely-absent > quiet-miss.txt", &params)
		.await
		.expect("fd quiet miss");
	assert_eq!(exit_code(&quiet_miss), 1, "quiet fd no-match should fail");
	assert_eq!(read("quiet-miss.txt"), "");

	let quiet_hit = session
		.run_test("fd -q needle > quiet-hit.txt", &params)
		.await
		.expect("fd quiet hit");
	assert_eq!(exit_code(&quiet_hit), 0, "quiet fd match should succeed");
	assert_eq!(read("quiet-hit.txt"), "");

	let help = session
		.run_test("fd --help > help.txt 2> help.err", &params)
		.await
		.expect("fd help");
	assert_eq!(exit_code(&help), 0, "fd help should succeed");
	assert!(read("help.txt").contains("A program to find entries in your filesystem"));
	assert_eq!(read("help.err"), "");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// Plain `rg PATTERN` uses the shell working directory when the host wired
/// stdin to null, but a real pipeline remains stdin input. Pattern stdin
/// (`-f -`) must not consume the implicit search path decision.
#[tokio::test(flavor = "multi_thread")]
async fn rg_builtin_defaults_to_cwd_unless_stdin_is_pipeline() {
	let tmp = std::env::temp_dir().join(format!("pi-rg-stdin-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	std::fs::write(tmp.join("data.txt"), "from-cwd\nfrom-pattern\n").expect("data");
	std::fs::write(tmp.join("z-output.txt"), "from-cwd\n").expect("output seed");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	session
		.run_test("rg --sort path --max-count 1 from-cwd >> z-output.txt", &params)
		.await
		.expect("rg cwd");
	assert_eq!(read("z-output.txt"), "from-cwd\ndata.txt:from-cwd\n");

	session
		.run_test("printf 'from-pipe\\n' | rg from-pipe > pipe.txt", &params)
		.await
		.expect("rg pipe");
	assert_eq!(read("pipe.txt"), "from-pipe\n");

	session
		.run_test("printf 'from-pattern\\n' | rg -f - > pattern.txt", &params)
		.await
		.expect("rg pattern stdin");
	assert_eq!(read("pattern.txt"), "data.txt:from-pattern\n");

	session
		.run_test("printf 'not-a-path\\n' | rg --files > files.txt", &params)
		.await
		.expect("rg files");
	let files = read("files.txt");
	assert!(files.contains("data.txt"), "--files should list cwd files: {files:?}");
	assert!(!files.contains("not-a-path"), "--files must not read piped stdin: {files:?}");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// `grep -q` must suppress all stdout and drive the exit status (0 on match,
/// 1 otherwise) so shell conditionals work; `-x` must anchor whole lines.
/// Mirrors busybox applet probing: `grep -qx "$applet" <(strings bin)`.
#[tokio::test(flavor = "multi_thread")]
async fn grep_quiet_and_line_regexp() {
	let tmp = std::env::temp_dir().join(format!("pi-walkerq-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	std::fs::write(tmp.join("data.txt"), "foo\nbar\nbaz\n").expect("data");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	// -q: no stdout even on a match.
	session
		.run_test("grep -q ba data.txt > qout.txt", &params)
		.await
		.expect("grep -q");
	assert_eq!(read("qout.txt"), "", "-q must not print matches");
	// -q exit code drives `&&` (match) and `||` (no match).
	session
		.run_test("grep -q ba data.txt && echo HIT > hit.txt", &params)
		.await
		.expect("grep -q hit");
	assert_eq!(read("hit.txt"), "HIT\n", "-q match must exit 0");
	session
		.run_test("grep -q zzz data.txt || echo MISS > miss.txt", &params)
		.await
		.expect("grep -q miss");
	assert_eq!(read("miss.txt"), "MISS\n", "-q no-match must exit 1");
	// -qx: whole-line match succeeds on an exact line ...
	session
		.run_test("grep -qx bar data.txt && echo XHIT > xhit.txt", &params)
		.await
		.expect("grep -qx hit");
	assert_eq!(read("xhit.txt"), "XHIT\n", "-x must match a whole line");
	// ... and fails on a substring that is not a whole line.
	session
		.run_test("grep -qx ba data.txt || echo XMISS > xmiss.txt", &params)
		.await
		.expect("grep -qx miss");
	assert_eq!(read("xmiss.txt"), "XMISS\n", "-x must reject a partial-line match");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// The destructive uutils builtins (`rm`, `mv`) must operate on paths
/// resolved against the shell working directory, not the host process cwd.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_rm_and_mv_operate_on_shell_cwd() {
	let tmp = std::env::temp_dir().join(format!("pi-rmmv-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(tmp.join("tree/inner")).expect("tree");
	std::fs::write(tmp.join("a.txt"), "hello").expect("a");
	std::fs::write(tmp.join("tree/inner/leaf.txt"), "x").expect("leaf");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();

	// mv: rename within the shell cwd.
	let mv = session
		.run_test("mv a.txt b.txt", &params)
		.await
		.expect("mv");
	assert_eq!(exit_code(&mv), 0, "mv should succeed");
	assert!(!tmp.join("a.txt").exists(), "source should be gone");
	assert_eq!(std::fs::read_to_string(tmp.join("b.txt")).unwrap(), "hello");

	// rm -rf: recursive removal resolved against the shell cwd.
	let rm = session.run_test("rm -rf tree", &params).await.expect("rm");
	assert_eq!(exit_code(&rm), 0, "rm -rf should succeed");
	assert!(!tmp.join("tree").exists(), "tree should be removed");
	// and the host process cwd must be untouched.
	assert!(tmp.join("b.txt").exists());

	let _ = std::fs::remove_dir_all(&tmp);
}

/// Removing a nonexistent file must print exactly one diagnostic (like GNU
/// rm) and exit non-zero — not a second, message-less `rm:` line. Regression
/// guard: the in-process entry point used to re-print the status-only
/// `Err(1)` returned after `remove()` had already reported each failure.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_rm_missing_file_prints_single_diagnostic() {
	let tmp = std::env::temp_dir().join(format!("pi-rm-missing-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();

	let rm = session
		.run_test("rm nonexistent.txt 2> err.txt", &params)
		.await
		.expect("rm");
	assert_ne!(exit_code(&rm), 0, "rm of a missing file must report failure");
	let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
	let lines: Vec<&str> = err.lines().collect();
	assert_eq!(lines.len(), 1, "rm should emit exactly one diagnostic line, got: {err:?}");
	assert!(lines[0].contains("nonexistent.txt"), "diagnostic should name the file: {err:?}");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// The find display/match surface must use the operand-relative path while
/// filesystem actions still target the real (resolved) path: `-path` and
/// `-printf %p` see `./...`, while `-delete` removes the correct file.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_find_display_and_actions_split_paths() {
	let tmp = std::env::temp_dir().join(format!("pi-find-split-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(tmp.join("sub")).expect("dirs");
	std::fs::write(tmp.join("keep.log"), "k").expect("keep");
	std::fs::write(tmp.join("sub/drop.tmp"), "d").expect("drop");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	// -path matches against the operand-relative path.
	session
		.run_test("find . -path './sub/*' > p.txt", &params)
		.await
		.expect("path");
	assert_eq!(read("p.txt"), "./sub/drop.tmp\n", "-path should match the operand-relative path");

	// -printf %p emits the operand-relative path.
	session
		.run_test("find . -name keep.log -printf '%p\\n' > pf.txt", &params)
		.await
		.expect("printf");
	assert_eq!(read("pf.txt"), "./keep.log\n", "-printf %p should be operand-relative");

	// -delete operates on the real (resolved) path, removing the right file.
	let del = session
		.run_test("find . -name '*.tmp' -delete", &params)
		.await
		.expect("delete");
	assert_eq!(exit_code(&del), 0, "find -delete should succeed");
	assert!(!tmp.join("sub/drop.tmp").exists(), "-delete should remove the matched file");
	assert!(tmp.join("keep.log").exists(), "-delete must not touch unmatched files");

	// -exec substitutes the operand-relative path and runs in the shell cwd,
	// so the relative `{}` resolves and the child's redirect lands in the
	// cwd.
	session
		.run_test("find . -name keep.log -exec sh -c 'printf %s \"$1\" > ex.txt' sh {} ';'", &params)
		.await
		.expect("exec");
	assert_eq!(
		read("ex.txt"),
		"./keep.log",
		"-exec {{}} should be operand-relative and run in the shell cwd"
	);

	// -exec children must write through the scope streams — an inherited
	// process stdout would bypass the shell redirect and spam the host
	// TUI's terminal — and must see the shell's exported environment.
	session
		.run_test(
			"export PI_EXEC_ENV=zed; find . -name keep.log -exec sh -c 'echo \"$PI_EXEC_ENV $1\"' sh \
			 {} ';' > cap.txt",
			&params,
		)
		.await
		.expect("exec capture");
	assert_eq!(
		read("cap.txt"),
		"zed ./keep.log\n",
		"-exec child stdout must flow through the shell redirect with the shell's exported env"
	);

	let _ = std::fs::remove_dir_all(&tmp);
}

/// The vendored `sed` builtin must stream pipeline stdin through scripts and
/// perform `-i` in-place edits (with backup suffix) against the shell
/// working directory rather than the host process cwd.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_sed_substitutes_streams_and_edits_in_place() {
	let tmp = std::env::temp_dir().join(format!("pi-sed-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	std::fs::write(tmp.join("conf.txt"), "x=1\n").expect("conf");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	// Piped stdin through a quiet substitute-and-print script.
	session
		.run_test("printf 'hello\\nworld\\n' | sed -n 's/hello/HI/p' > sed.txt", &params)
		.await
		.expect("sed pipeline");
	assert_eq!(read("sed.txt"), "HI\n");
	// In-place edit of a cwd-relative operand, keeping the requested backup.
	session
		.run_test("sed -i.bak 's/1/2/' conf.txt", &params)
		.await
		.expect("sed -i");
	assert_eq!(read("conf.txt"), "x=2\n", "in-place edit must land in the shell cwd");
	assert_eq!(read("conf.txt.bak"), "x=1\n", "backup must keep the original");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// `declare -r` lists readonly variables; it must not also require the
/// trace attribute (`-t`).
#[tokio::test(flavor = "multi_thread")]
async fn declare_readonly_listing_does_not_require_trace() {
	let (result, output) =
		execute_captured("readonly OMP_DECLARE_RO=1; declare -r | grep -c OMP_DECLARE_RO".into())
			.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output.trim(), "1");
}

/// `exec` would replace the host process and `suspend` would stop it.
/// `enable` (a no-op on these always-enabled builtins) must not change that:
/// an external `exec` spawns the command and ends the run with its status —
/// on regression the test process itself turns into `false` and fails — and
/// `suspend` refuses.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn enable_cannot_restore_exec_or_suspend() {
	let (result, output) =
		execute_captured("enable exec suspend; exec false; echo after-exec".into()).await;
	assert_eq!(result.exit_code, Some(1), "exec'd `false` ends the run with its status: {output}");
	assert!(!output.contains("after-exec"), "exec ends the run: {output}");

	let (result, output) =
		execute_captured("enable exec suspend; suspend -f; echo suspend-refused".into()).await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert!(output.contains("suspend: not available in this shell"), "{output}");
	assert!(output.contains("suspend-refused"), "{output}");
}

/// `sort -m -o f - g < f` truncates `f` for its output while stdin is still
/// reading it, so stdin must be copied first or the rest of `f` is lost.
/// The input is far larger than what stdin reads ahead, and the small
/// buffer makes the merge read it in many chunks.
#[tokio::test(flavor = "multi_thread")]
async fn sort_merge_into_the_file_on_stdin_keeps_all_input() {
	let dir = tempfile::tempdir().expect("temp dir");
	use std::fmt::Write as _;
	let mut odd = String::new();
	let mut even = String::new();
	for n in 0..20_000 {
		let _ = writeln!(odd, "{:06}", 2 * n + 1);
		let _ = writeln!(even, "{:06}", 2 * n);
	}
	std::fs::write(dir.path().join("f"), odd).expect("write f");
	std::fs::write(dir.path().join("g"), even).expect("write g");
	let (result, output) =
		execute_captured(format!("cd '{}' && sort -m -S 1K -o f - g < f", dir.path().display()))
			.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let merged = std::fs::read_to_string(dir.path().join("f")).expect("read f");
	let mut expected = String::new();
	for n in 0..40_000 {
		let _ = writeln!(expected, "{n:06}");
	}
	assert!(merged == expected, "merged {} of 40000 lines", merged.lines().count());
}

/// `umask` belongs to the shell: it masks files the shell, its builtins,
/// and its external commands create, subshells keep their own copy, and
/// the host process umask never changes.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn umask_is_scoped_to_the_shell() {
	use std::os::unix::fs::PermissionsExt;

	let host_umask = || pi_builtins::read_process_umask().expect("read host umask");
	let before = host_umask();
	let dir = tempfile::tempdir().expect("temp dir");
	let (result, output) = execute_captured(format!(
		"cd '{}' && umask 077 && : > redirect && touch builtin && sh -c ': > external' && mkdir \
		 made && (umask 000) && umask",
		dir.path().display()
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output.trim(), "0077", "a subshell's umask must not leak out");
	let mode = |name: &str| {
		std::fs::metadata(dir.path().join(name))
			.expect("created file")
			.permissions()
			.mode()
			& 0o777
	};
	assert_eq!(mode("redirect"), 0o600, "redirections use the shell umask");
	assert_eq!(mode("builtin"), 0o600, "builtins use the shell umask");
	assert_eq!(mode("external"), 0o600, "external commands inherit the shell umask");
	assert_eq!(mode("made"), 0o700, "mkdir uses the shell umask");

	// A mask looser than the host's keeps the bits the host umask clears.
	let (result, output) = execute_captured(format!(
		"cd '{}' && umask 000 && : > loose-redirect && touch loose-builtin && mkdir loose-dir",
		dir.path().display()
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(mode("loose-redirect"), 0o666);
	assert_eq!(mode("loose-builtin"), 0o666);
	assert_eq!(mode("loose-dir"), 0o777);
	assert_eq!(host_umask(), before, "the host process umask must not change");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn executable_text_without_shebang_preserves_arguments_and_exit_status() {
	use std::os::unix::fs::PermissionsExt;

	let dir = tempfile::tempdir().expect("temp dir");
	let script = dir.path().join("plain-script");
	std::fs::write(&script, "printf '%s|%s|%s\\n' \"$1\" \"$2\" \"$SCRIPT_TOKEN\"\nexit 23\n")
		.expect("write executable text");
	std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
		.expect("make script executable");
	for invocation in ["./plain-script", "plain-script"] {
		let (result, output) = execute_captured(format!(
			"cd {} && SCRIPT_TOKEN=from-env PATH=\"$PWD:$PATH\" {invocation} 'two words' ';literal' \
			 > captured; status=$?; cat captured; exit \"$status\"",
			quote_arg(dir.path().to_str().expect("utf8 path")),
		))
		.await;
		assert_eq!(result.exit_code, Some(23), "{invocation}: {output}");
		assert_eq!(output, "two words|;literal|from-env\n", "{invocation}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn shebangless_background_script_with_fifo_stdin() {
	use std::os::unix::fs::PermissionsExt;

	let dir = tempfile::tempdir().expect("temp dir");
	let script = dir.path().join("s");
	std::fs::write(&script, "echo hi; cat\n").expect("write script");
	std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
		.expect("make script executable");
	std::fs::write(dir.path().join("input"), "data\n").expect("write input");
	for (invocation, expected) in [
		("./s < input & wait; echo status=$?", "hi\ndata\nstatus=0\n"),
		("./s & wait; echo status=$?", "hi\nstatus=0\n"),
		("mkfifo f; printf 'data\\n' > f & ./s < f; wait; echo status=$?", "hi\ndata\nstatus=0\n"),
		(
			"./s < f & timeout 2 sh -c \"printf 'data\\n' > f\"; wait; echo status=$?",
			"hi\ndata\nstatus=0\n",
		),
	] {
		let (result, output) = execute_captured(format!(
			"cd {}; {invocation}",
			quote_arg(dir.path().to_str().expect("utf8 path")),
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "{invocation}: {output}");
		assert_eq!(output, expected, "{invocation}");
	}

	let dir = tempfile::tempdir().expect("acceptance temp dir");
	let command = format!(
		"cd {}; mkfifo f; printf 'echo hi; cat\\n' > s; chmod +x s; ./s < f & printf 'data\\n' > f; \
		 wait; echo status=$?",
		quote_arg(dir.path().to_str().expect("utf8 path")),
	);
	let (result, output) =
		tokio::time::timeout(std::time::Duration::from_secs(10), execute_captured(command))
			.await
			.expect("FIFO script must finish");
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "hi\ndata\nstatus=0\n");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn external_command_receives_extra_file_descriptor() {
	let (result, output) =
		execute_captured("sh -c 'printf descriptor-output >&3' 3>&1".into()).await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "descriptor-output");
}

/// The `xargs` builtin spawns real child processes, but their stdout must
/// flow back into the shell pipeline (ctx streams, not the host fds), items
/// must batch per `-n`, and a failing invocation must surface GNU's 123.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn uutils_xargs_children_feed_pipeline_and_report_failure() {
	let tmp = std::env::temp_dir().join(format!("pi-xargs-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	// Default echo action: child stdout is captured into the redirect.
	session
		.run_test("printf 'a b c\\n' | xargs > xargs.txt", &params)
		.await
		.expect("xargs default");
	assert_eq!(read("xargs.txt"), "a b c\n");
	// -n batching, with child output feeding a downstream builtin stage.
	session
		.run_test("printf '1\\n2\\n3\\n4\\n' | xargs -n2 echo | wc -l > batches.txt", &params)
		.await
		.expect("xargs -n2");
	assert_eq!(read("batches.txt").trim(), "2");
	// A child exiting 1-125 makes xargs exit 123 (GNU contract).
	session
		.run_test("printf 'x\\n' | xargs false; printf %s $? > code.txt", &params)
		.await
		.expect("xargs false");
	assert_eq!(read("code.txt"), "123");

	let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn xargs_signal_death_reports_125() {
	let (result, output) =
		execute_captured("echo x | xargs sh -c 'kill -9 $$' 2>&1 >/dev/null".into()).await;
	assert_eq!(result.exit_code, Some(125), "{output}");
	assert!(output.contains("xargs: sh: terminated by signal 9"), "{output}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn xargs_signal_death_stops_sequential_commands() {
	let (result, output) = execute_captured(
		"printf 'first\\nsecond\\n' | xargs -n1 sh -c 'if [ \"$1\" = first ]; then kill -9 $$; else \
		 echo unexpected; fi' _"
			.into(),
	)
	.await;
	assert_eq!(result.exit_code, Some(125), "{output}");
	assert!(!output.contains("unexpected"), "{output}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn xargs_exit_137_is_not_signal_death() {
	let (result, output) = execute_captured("echo x | xargs sh -c 'exit 137'".into()).await;
	assert_eq!(result.exit_code, Some(123), "{output}");
	assert!(!output.contains("terminated by signal"), "{output}");

	let (result, output) = execute_captured("echo x | xargs -I% exit 137".into()).await;
	assert_eq!(result.exit_code, Some(123), "{output}");
	assert!(!output.contains("terminated by signal"), "{output}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn xargs_parallel_signal_death_stops_scheduling() {
	let (result, output) = execute_captured(
		"printf 'first\\nsecond\\nthird\\n' | xargs -n1 -P2 sh -c 'case \"$1\" in first) sleep 1;; \
		 second) kill -9 $$;; third) echo unexpected;; esac' _"
			.into(),
	)
	.await;
	assert_eq!(result.exit_code, Some(125), "{output}");
	assert!(output.contains("xargs: sh: terminated by signal 9"), "{output}");
	assert!(!output.contains("unexpected"), "{output}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn xargs_unlimited_parallel_observes_signal_before_next_launch() {
	let (result, output) = execute_captured(
		"{ printf 'first\\nsecond\\n'; sleep 1; printf 'third\\n'; } | xargs -n1 -P0 sh -c 'if [ \
		 \"$1\" = first ]; then kill -9 $$; else echo unexpected; fi' _"
			.into(),
	)
	.await;
	assert_eq!(result.exit_code, Some(125), "{output}");
	assert!(output.contains("xargs: sh: terminated by signal 9"), "{output}");
	assert!(!output.contains("unexpected"), "{output}");
}

/// The `jq` builtin must evaluate filters over piped JSON, resolve file
/// operands against the shell working directory, and propagate `-e`'s
/// null/false exit status through the shell.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_jq_filters_json_and_propagates_exit_status() {
	let tmp = std::env::temp_dir().join(format!("pi-jq-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&tmp);
	std::fs::create_dir_all(&tmp).expect("temp dir");
	std::fs::write(tmp.join("in.json"), "{\"name\":\"pi\"}\n").expect("in.json");
	let tmp_str = tmp.to_str().expect("utf8");

	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");
	session
		.run_test(format!("cd {}", quote_arg(tmp_str)), &TestStdio::null())
		.await
		.expect("cwd");
	let params = TestStdio::null();
	let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

	// Compact filter over piped stdin.
	session
		.run_test("printf '{\"a\":{\"b\":2}}' | jq -c .a > jq.txt", &params)
		.await
		.expect("jq pipeline");
	assert_eq!(read("jq.txt"), "{\"b\":2}\n");
	// Raw output from a cwd-relative file operand.
	session
		.run_test("jq -r .name in.json > name.txt", &params)
		.await
		.expect("jq file");
	assert_eq!(read("name.txt"), "pi\n");
	// -e maps a null result to exit status 1.
	session
		.run_test("printf 'null' | jq -e . > /dev/null; printf %s $? > code.txt", &params)
		.await
		.expect("jq -e");
	assert_eq!(read("code.txt"), "1");

	let _ = std::fs::remove_dir_all(&tmp);
}

/// A stdin-reading builtin blocked on an open pipe must honor abort/timeout:
/// the context's cancel flag makes the read return EOF so the utility
/// unwinds promptly and the run reports cancelled (143) — it must not
/// hang or leak a detached thread that keeps the fds alive.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn uutils_head_stdin_read_is_cancellable() {
	let config = ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");

	// Hold the pipe's write end open with no data so `head` blocks reading.
	let (reader, _writer) = pipe_to_files("cancel").expect("pipe");
	let params = TestStdio::null().stdin(&reader);
	drop(reader);
	let token = CancellationToken::new();
	let cancel = token.clone();

	let canceller = tokio::spawn(async move {
		time::sleep(Duration::from_millis(150)).await;
		token.cancel();
	});
	let result = time::timeout(
		Duration::from_secs(5),
		session.run_test_with("head -n 1000000", &params, cancel),
	)
	.await;
	let _ = canceller.await;

	let exec = result
		.expect("head must return promptly after cancel, not hang on the open pipe")
		.expect("run");
	// Core contract: prompt return (the 5s timeout did NOT fire) proves the
	// read unblocked and the blocking task unwound cleanly — no hang, no
	// detached thread. The session cancels a run with TERM to everything it
	// started and reports the TERM-cancelled run as 128 + 15.
	assert!(exec.cancelled, "the run must report that it was cancelled");
	assert_eq!(exit_code(&exec), 143, "cancelled stdin read should report TERM's status");
}

/// The disable env vars must actually gate registration: the global switch
/// drops the whole set, and the per-utility destructive switches drop only
/// the risky shadows.
#[tokio::test(flavor = "multi_thread")]
async fn uutils_builtins_respect_disable_env() {
	let session_with = |pairs: &[(&str, &str)]| {
		let map: std::collections::HashMap<String, String> = pairs
			.iter()
			.map(|(k, v)| ((*k).to_string(), (*v).to_string()))
			.collect();
		ShellConfig {
			session_env:   Some(map),
			snapshot_path: None,
			minimizer:     None,
			filesystem:    Fs::native(),
			seed:          None,
		}
	};

	let mut default = create_session(&ShellConfig {
		session_env:   None,
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	})
	.await
	.expect("create_session");
	for name in ["head", "rg", "rm", "mv"] {
		assert!(is_session_builtin(&mut default, name).await, "{name} registered by default");
	}

	let mut all_off = create_session(&session_with(&[("PI_DISABLE_UUTILS_BUILTINS", "1")]))
		.await
		.expect("create_session");
	for name in ["head", "rg", "rm"] {
		assert!(!is_session_builtin(&mut all_off, name).await, "kill-switch drops {name}");
	}

	let mut rm_off = create_session(&session_with(&[("PI_DISABLE_RM_BUILTIN", "1")]))
		.await
		.expect("create_session");
	assert!(!is_session_builtin(&mut rm_off, "rm").await, "rm disabled individually");
	assert!(is_session_builtin(&mut rm_off, "mv").await, "mv stays enabled");
	assert!(is_session_builtin(&mut rm_off, "head").await, "head stays enabled");
}

/// Whether `name` resolves in `session` as a builtin (`type -t`), searched
/// with no executable path so a system binary cannot stand in.
async fn is_session_builtin(session: &mut ShellSessionCore, name: &str) -> bool {
	let out = tempfile::tempfile().expect("type capture");
	session
		.run_test(format!("PATH= type -t {name}"), &TestStdio::null().stdout(&out))
		.await
		.expect("type -t");
	read_capture(&out) == "builtin\n"
}

/// On Windows a utility written in the syntax of the System32 program it
/// shadows runs that program: `find /c /v ""` counts lines with cmd's
/// `FIND` (pi's GNU `find` read `/c` as drive `C:` and walked it), and its
/// search string reaches `FIND` quoted, as `FIND` requires, even when it
/// starts with `/`. GNU syntax keeps pi's `find`.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn windows_switch_syntax_runs_the_shadowed_system_program() {
	// Varied text: `FIND` guesses UTF-16 (`IsTextUnicode`) for tiny uniform
	// input such as `a\nb\n`.
	let input = r"printf 'apple pie\r\nbanana split\r\nGET /api/users\r\n'";
	let (result, output) = execute_captured(format!(
		"{input} | find /c /v \"\"; {input} | find /i \"BANANA\"; {input} | find /i \"/API\"; find \
		 . -maxdepth 0"
	))
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let lines: Vec<&str> = output
		.lines()
		.map(str::trim_end)
		.filter(|l| !l.is_empty())
		.collect();
	assert_eq!(lines, ["3", "banana split", "GET /api/users", "."]);
}
