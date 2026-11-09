use super::*;

/// A session over the native filesystem that starts in `cwd` with exactly
/// `vars` (as the host env copy produced them).
#[cfg(windows)]
fn session_with(vars: HashMap<String, String>, cwd: &std::path::Path) -> ShellSessionCore {
	let runtime = tokio::runtime::Handle::current();
	let slot = VfsFs::new(Fs::native(), runtime.clone());
	let cwd = path_bytes(cwd);
	let session = Session::new(SessionConfig {
		env: vars
			.into_iter()
			.map(|(key, value)| (BString::from(key), BString::from(value)))
			.collect(),
		cwd: cwd.clone(),
		fs: Box::new(slot.clone()),
		vfs: Some(slot.clone()),
		runtime,
		output_decoding: None,
	})
	.expect("start session");
	ShellSessionCore { session, slot, filesystem: Fs::native(), cwd }
}

/// The shell starts in, and a run's requested working directory moves it
/// to, the long form of a directory handed over in its 8.3 short spelling.
/// (A `cd` written in a command keeps the spelling it names, as bash's does;
/// the long form is pi's for the directories it hands the shell.)
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn working_dir_stores_long_form() {
	let Some((_root, _long, short)) = short_alias_fixture() else {
		return;
	};

	let shell = Shell::new(None);
	let parent = short
		.parent()
		.expect("parent")
		.to_string_lossy()
		.into_owned();
	for cwd in [parent, short.to_string_lossy().into_owned()] {
		shell
			.run(
				ShellRunOptions { command: ":".into(), cwd: Some(cwd), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run in requested cwd");
	}
	let result = shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("run");
	let working_dir = std::path::PathBuf::from(result.working_dir.expect("working dir"));
	assert_eq!(
		working_dir.file_name(),
		Some(std::ffi::OsStr::new(LONG_DIR_NAME)),
		"cd {}",
		short.display()
	);
}

/// Host TEMP/TMP paths must not export the short profile spelling after
/// entering the directory.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn inherited_short_temp_matches_pwd_after_cd() {
	let Some((short, expected, _guard)) = short_temp_fixture() else {
		return;
	};
	let mut vars = HashMap::new();
	copy_env_into(
		&mut vars,
		["TEMP", "TMP", "TMPDIR"]
			.into_iter()
			.map(|key| (std::ffi::OsString::from(key), short.as_os_str().to_os_string())),
	);
	let mut shell = session_with(vars, short.parent().expect("parent"));

	assert_cd_temp_matches_pwd(&mut shell, &expected).await;
}

/// The agent forwards its host env as `session_env`, applied after the
/// direct host copy; a short TEMP arriving that way must be expanded too,
/// or it overwrites the expanded host value.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn session_env_short_temp_matches_pwd_after_cd() {
	let Some((short, expected, _guard)) = short_temp_fixture() else {
		return;
	};
	let short_str = short.to_str().expect("utf8 short temp").to_string();
	let env = ["TEMP", "TMP", "TMPDIR"]
		.into_iter()
		.map(|key| (key.to_string(), short_str.clone()))
		.collect();
	let config = ShellConfig {
		session_env:   Some(env),
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");

	assert_cd_temp_matches_pwd(&mut session, &expected).await;
}

/// Windows env names are case-insensitive: a host `Temp`/`Tmp`/`TmpDir`
/// must surface as the uppercase names shell scripts read. Relative values
/// are not paths to expand and pass through verbatim.
#[cfg(windows)]
#[test]
fn inherited_temp_keys_fold_to_uppercase() {
	let mut vars = HashMap::new();
	copy_env_into(
		&mut vars,
		[("Temp", "rel\\temp"), ("Tmp", "rel\\tmp"), ("TmpDir", "rel\\tmpdir")]
			.into_iter()
			.map(|(key, value)| (key.into(), value.into())),
	);

	assert_eq!(vars.get("TEMP").map(String::as_str), Some("rel\\temp"));
	assert_eq!(vars.get("TMP").map(String::as_str), Some("rel\\tmp"));
	assert_eq!(vars.get("TMPDIR").map(String::as_str), Some("rel\\tmpdir"));
	assert_eq!(vars.get("Temp"), None);
}

/// A host cwd spelled with 8.3 short names matches the stored long form of
/// the same directory, so no redundant directory change runs.
#[cfg(windows)]
#[test]
fn short_spelled_cwd_matches_stored_long_form() {
	let Some((_root, long, short)) = short_alias_fixture() else {
		return;
	};

	assert!(
		working_dir_matches(&path_bytes(&long), &short.to_string_lossy()),
		"short spelling {} should match stored {}",
		short.display(),
		long.display()
	);
}

/// Shell initialization must recover when a long-running host's inherited
/// working directory is deleted. This runs in a child process because cwd is
/// process-global.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn shell_initializes_after_process_cwd_is_deleted() {
	const MARKER: &str = "PI_SHELL_TEST_DELETED_CWD";
	if std::env::var_os(MARKER).is_none() {
		run_isolated_kill_test(
			"shell::tests::env_cwd::shell_initializes_after_process_cwd_is_deleted",
			MARKER,
			false,
		)
		.await;
		return;
	}

	let dir = tempfile::tempdir().expect("temporary cwd");
	std::env::set_current_dir(dir.path()).expect("enter temporary cwd");
	std::fs::remove_dir(dir.path()).expect("delete process cwd");

	let mut session = default_session().await;
	let fallback = std::env::var_os("HOME").map_or_else(|| "/".into(), std::path::PathBuf::from);
	assert_eq!(session.working_dir(), fallback);
	// The shell works there.
	let ran = session
		.run_test("pwd", &TestStdio::null())
		.await
		.expect("run");
	assert_eq!(ran.status, 0);
}

/// Native Windows tools write the ANSI code page to pipes. On a Chinese
/// system that is GBK; treating it as UTF-8 used to turn `echo 中文` into
/// replacement characters.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn cmd_echo_chinese_decodes_from_system_acp() {
	// SAFETY: GetACP has no preconditions.
	let acp = unsafe { windows_sys::Win32::Globalization::GetACP() };
	if acp != 936 {
		return;
	}
	let (result, output) = execute_captured("cmd.exe /c echo 中文".to_string()).await;
	assert_eq!(result.exit_code, Some(0), "{output:?}");
	assert!(output.contains("中文"), "garbled command output: {output:?}");
}

/// Regression for issue #8925: a host env entry whose key or value is not
/// valid Unicode must be skipped, not fatal. `std::env::vars()` panics on
/// the first one (e.g. the corrupt `GHOSTTY_BIN_DIR` cmux/Ghostty stages,
/// bytes `9d d9 50`) before any command runs; `copy_env_into` reads via
/// `vars_os()` and drops corrupt entries while still copying the rest and
/// merging duplicate `PATH` values.
#[cfg(unix)]
#[test]
fn copy_env_skips_non_utf8_entries_and_merges_path() {
	use std::os::unix::ffi::OsStringExt;

	// GHOSTTY_BIN_DIR with the corrupt bytes, a normal var, a corrupt key,
	// and a duplicate PATH — in host-env iteration order.
	let entries = vec![
		(std::ffi::OsString::from("PATH"), std::ffi::OsString::from("/usr/bin:/bin")),
		(
			std::ffi::OsString::from("GHOSTTY_BIN_DIR"),
			std::ffi::OsString::from_vec(vec![0x9d, 0xd9, 0x50]),
		),
		(std::ffi::OsString::from("HOME"), std::ffi::OsString::from("/home/tester")),
		(std::ffi::OsString::from_vec(vec![0xff, b'B', b'A', b'D']), std::ffi::OsString::from("x")),
		(std::ffi::OsString::from("PATH"), std::ffi::OsString::from("/opt/bin")),
	];
	let mut vars = HashMap::new();
	copy_env_into(&mut vars, entries.into_iter());

	let value = |name: &str| vars.get(name).cloned();
	assert_eq!(value("PATH").as_deref(), Some("/opt/bin"), "PATH is merged/preserved");
	assert_eq!(value("HOME").as_deref(), Some("/home/tester"), "valid entry copied");
	assert!(value("GHOSTTY_BIN_DIR").is_none(), "non-UTF-8 value must be skipped");
	assert!(value("BAD").is_none(), "non-UTF-8 key must be skipped");
}

/// The strip must stay narrowly scoped: unrelated `GIT_*` names are part of
/// the shell contract (`GIT_EDITOR`, author identity) and must survive.
#[test]
fn git_repo_location_vars_exclude_unrelated_git_names() {
	assert!(!is_git_repo_location_var("GIT_EDITOR"));
	assert!(!is_git_repo_location_var("GIT_AUTHOR_NAME"));
}

/// Regression for issue #11082: the embedded shell copies the host
/// environment, and repo-location overrides in it (git hooks, `git
/// --git-dir` wrappers) must not reach child commands — `git` would ignore
/// the command's `cwd` and mutate the worktree the agent was launched from.
#[test]
fn copy_env_skips_git_repo_location_overrides() {
	let entries = vec![
		(std::ffi::OsString::from("GIT_DIR"), std::ffi::OsString::from("/primary/.git")),
		(std::ffi::OsString::from("GIT_WORK_TREE"), std::ffi::OsString::from("/primary")),
		(std::ffi::OsString::from("GIT_INDEX_FILE"), std::ffi::OsString::from("/primary/.git/index")),
		(std::ffi::OsString::from("GIT_EDITOR"), std::ffi::OsString::from("true")),
	];
	let mut vars = HashMap::new();
	copy_env_into(&mut vars, entries.into_iter());

	let value = |name: &str| vars.get(name).cloned();
	assert!(value("GIT_DIR").is_none(), "GIT_DIR must not reach child commands");
	assert!(value("GIT_WORK_TREE").is_none(), "GIT_WORK_TREE must not reach child commands");
	assert!(value("GIT_INDEX_FILE").is_none(), "GIT_INDEX_FILE must not reach child commands");
	assert_eq!(value("GIT_EDITOR").as_deref(), Some("true"), "unrelated git vars are kept");
}

/// The per-session env overlay is built from the same host environment, so
/// it must not reintroduce the repo-location overrides.
#[tokio::test(flavor = "multi_thread")]
async fn session_env_does_not_export_git_repo_location_overrides() {
	let dir = tempfile::tempdir().expect("probe directory");
	let out = dir.path().join("probe");
	let mut env = HashMap::new();
	env.insert("GIT_DIR".to_string(), "/primary/.git".to_string());
	env.insert("OMP_GIT_ENV_PROBE".to_string(), "kept".to_string());
	let config = ShellConfig {
		session_env:   Some(env),
		snapshot_path: None,
		minimizer:     None,
		filesystem:    Fs::native(),
		seed:          None,
	};
	let mut session = create_session(&config).await.expect("create_session");

	let command = format!(
		"printf '%s|%s' \"${{GIT_DIR-unset}}\" \"$OMP_GIT_ENV_PROBE\" > {}",
		quote_arg(out.to_str().expect("utf8 probe path"))
	);
	session
		.run_test(command, &TestStdio::null())
		.await
		.expect("run probe");

	assert_eq!(fs::read_to_string(&out).expect("probe output"), "unset|kept");
}

/// The per-run env is the command's only: exported to what it runs, then
/// every name is back to what it was, and shell-owned names are not
/// overridden.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn per_run_env_is_scoped_to_the_run() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(None);
	let run = async |command: &str, env: Option<HashMap<String, String>>| {
		let (tx, rx) = flume::unbounded();
		let result = shell
			.run(
				ShellRunOptions { command: command.into(), env, ..Default::default() },
				Some(tx),
				CancelToken::default(),
			)
			.await
			.expect("run");
		assert_eq!(result.exit_code, Some(0), "{command}");
		rx.drain().collect::<String>()
	};
	run("PI_SCOPED=before", None).await;
	let env = HashMap::from([
		("PI_SCOPED".to_owned(), "during".to_owned()),
		("PI_ONLY".to_owned(), "one".to_owned()),
		("SHLVL".to_owned(), "99".to_owned()),
	]);
	let during =
		run("printf '%s %s ' \"$PI_SCOPED\" \"$SHLVL\"; sh -c 'printf %s \"$PI_ONLY\"'", Some(env))
			.await;
	assert!(during.starts_with("during "), "{during}");
	assert!(!during.contains("99"), "a shell-owned name was overridden: {during}");
	assert!(during.ends_with("one"), "not exported to children: {during}");
	assert_eq!(
		run("printf '%s/%s' \"$PI_SCOPED\" \"${PI_ONLY-unset}\"", None).await,
		"before/unset"
	);
}

/// `cd -P`, `pwd -P` and `set -P` resolve symlinks (`..` is the real
/// parent); `cd -L`/`pwd` keep the name as typed.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn physical_cd_and_pwd_resolve_symlinks() {
	let dir = tempfile::tempdir().expect("scratch");
	let root = dir.path().canonicalize().expect("canonical scratch");
	std::fs::create_dir_all(root.join("real/sub")).expect("real dir");
	std::os::unix::fs::symlink(root.join("real/sub"), root.join("link")).expect("symlink");
	let (result, output) = run_command_capture(
		"cd link && pwd && pwd -P && cd -P .. && pwd; cd -P ../link && echo \"$PWD\"; cd ..; set \
		 -P; cd ../link && pwd",
		Some(&root),
		None,
		CancelToken::default(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let (link, real) = (root.join("link"), root.join("real/sub"));
	let expected = [link.as_path(), &real, &root.join("real"), &real, &real]
		.map(|p| format!("{}\n", p.display()))
		.concat();
	assert_eq!(output, expected);
}

/// A run's `cwd` moves the shell and is reported; a missing directory fails
/// the run (as a failed `cd` would), and the next run starts over with a
/// fresh session.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn run_cwd_moves_the_shell_and_rejects_missing_directories() {
	let _guard = shell_test_lock().lock().await;
	let dir = tempfile::tempdir().expect("cwd");
	let dir_path = dir.path().canonicalize().expect("canonical cwd");
	let shell = Shell::new(None);
	let result = shell
		.run(
			ShellRunOptions {
				command: "cd ..; cd - >/dev/null".into(),
				cwd: Some(dir_path.to_string_lossy().into_owned()),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.expect("run in cwd");
	assert_eq!(result.working_dir.as_deref(), Some(dir_path.to_string_lossy().as_ref()));
	let missing = dir_path.join("missing");
	let err = shell
		.run(
			ShellRunOptions {
				command: ":".into(),
				cwd: Some(missing.to_string_lossy().into_owned()),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.expect_err("a missing cwd fails the run");
	assert!(err.to_string().contains("Failed to set cwd"), "{err}");
}
