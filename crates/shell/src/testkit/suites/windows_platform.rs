//! The shell on a Windows engine (`EngineConfig::platform`), run on any
//! host: what `omp zsh` and the bash tool show a Windows user.

use bstr::BString;

use crate::{
	bash::{EngineConfig, ModeId, Platform, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig},
};

/// Run `src` as zsh on a Windows engine with `env`; stdout and stderr.
fn zsh_on_windows(env: &[(&str, &str)], src: &str) -> (String, String) {
	let init = ShellInit {
		mode: ModeId::Zsh,
		argv0: "zsh".into(),
		env: env
			.iter()
			.map(|(k, v)| (BString::from(*k), BString::from(*v)))
			.collect(),
		..ShellInit::default()
	};
	let cfg = EngineConfig { platform: Platform::Windows, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
	)
}

/// Windows paths hold `:` (`C:\…`): `$path` splits `PATH` on `;`, and an
/// assignment to `path` joins with `;`, the separator child programs read.
/// Split on `:`, `${path[1]}` was `C`.
#[test]
fn path_tie_uses_the_windows_separator() {
	let (out, err) = zsh_on_windows(
		&[("PATH", "C:\\Windows;C:\\Program Files\\Git\\cmd")],
		"print -rl -- ${#path} ${path[1]}; path+=('D:\\tools'); print -r -- $PATH",
	);
	assert_eq!(out, "2\nC:\\Windows\nC:\\Windows;C:\\Program Files\\Git\\cmd;D:\\tools\n");
	assert_eq!(err, "");
}

/// Without an imported `PATH`, zsh's default list uses the Windows
/// separator too, so the tie sees its four directories.
#[test]
fn default_path_splits_into_its_directories() {
	let (out, _) = zsh_on_windows(&[], "print -r -- ${#path} ${path[1]}");
	assert_eq!(out, "4 /bin\n");
}

/// zsh on Windows reports MSYS2's `OSTYPE` (plugins branch on
/// `[[ $OSTYPE == msys* ]]`), not `linux-gnu`.
#[test]
fn ostype_is_msys() {
	let (out, _) = zsh_on_windows(&[], "print -r -- $OSTYPE");
	assert_eq!(out, "msys\n");
}

/// `PWD` and `HOME` start in the `/` spelling `cd` keeps, so `~`, `%~`
/// and `:t` agree with them from the first prompt.
#[test]
fn pwd_and_home_start_with_slashes() {
	let init = ShellInit {
		mode: ModeId::Zsh,
		argv0: "zsh".into(),
		env: vec![(BString::from("HOME"), BString::from(r"C:\Users\b"))],
		cwd: BString::from(r"C:\Users\b\src"),
		..ShellInit::default()
	};
	let cfg = EngineConfig { platform: Platform::Windows, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(b"print -r -- $PWD $HOME ${PWD:t} ${(D)PWD}".to_vec()), Fault::None);
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stdout.bytes()),
		"C:/Users/b/src C:/Users/b src ~/src\n"
	);
}

/// Windows always exports `USERNAME`; reading it in zsh printed a lossy
/// emulation-mode-boundary warning ("bash variable … shadowed by the zsh
/// special") on every run.
#[test]
fn an_imported_username_is_no_lossy_crossing() {
	let (out, err) = zsh_on_windows(&[("USERNAME", "b")], "print -r -- ${+USERNAME}");
	assert_eq!(out, "1\n");
	assert_eq!(err, "");
}

/// Run `src` in `mode` on a `platform` engine; stdout.
fn run_on(mode: ModeId, platform: Platform, src: &str) -> String {
	let argv0 = if mode == ModeId::Zsh { "zsh" } else { "bash" };
	let init = ShellInit { mode, argv0: argv0.into(), ..ShellInit::default() };
	let cfg = EngineConfig { platform, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned()
}

/// On Windows an asynchronous command without job control ignores `INT`
/// (and in zsh `QUIT`), as zsh and bash have it, so the console's Ctrl-C
/// passes it by: it lists the ignore, zsh's may trap it, bash's (ignored
/// on entry) may not, and the shell's own traps stay unset. Elsewhere it
/// keeps the shell's dispositions.
#[test]
fn async_commands_ignore_interrupts_on_windows_only() {
	let zsh =
		"( trap; trap 'print own' INT; trap ) & wait; print -r -- $(< <(trap)); trap; print done";
	let bash = "( trap; trap 'echo own' INT; trap -p INT ) & wait; trap -p INT; echo done";
	assert_eq!(
		run_on(ModeId::Zsh, Platform::Windows, zsh),
		"trap -- '' INT\ntrap -- '' QUIT\ntrap -- 'print own' INT\ntrap -- '' QUIT\ntrap -- '' INT \
		 trap -- '' QUIT\ndone\n"
	);
	assert_eq!(
		run_on(ModeId::Bash, Platform::Windows, bash),
		"trap -- '' SIGINT\ntrap -- '' SIGINT\ndone\n"
	);
	assert_eq!(run_on(ModeId::Zsh, Platform::Linux, zsh), "trap -- 'print own' INT\n\ndone\n");
	assert_eq!(run_on(ModeId::Bash, Platform::Linux, bash), "trap -- 'echo own' SIGINT\ndone\n");
}

/// Asynchronous commands forked from the same state share its ignores; one
/// forked after the shell set a trap lists it beside the ignore.
#[test]
fn async_commands_list_traps_set_between_them_on_windows() {
	let bash = "( trap -p ) & wait; trap 'echo t' TERM; ( trap -p ) & wait; echo done";
	assert_eq!(
		run_on(ModeId::Bash, Platform::Windows, bash),
		"trap -- '' SIGINT\ntrap -- '' SIGINT\ntrap -- 'echo t' SIGTERM\ndone\n"
	);
}

/// Windows `CreateProcessW` surfaces memory/pagefile exhaustion as raw OS
/// errors `ERROR_NOT_ENOUGH_MEMORY` (8), `ERROR_OUTOFMEMORY` (14) and
/// `ERROR_COMMITMENT_LIMIT` (1455), which Rust leaves uncategorized rather
/// than `ErrorKind::OutOfMemory`. `refused` must report `Diag::Refused`
/// directly without opening or slurping the executable into memory.
#[test]
fn windows_oom_spawn_errors_report_refused_without_reading_executable() {
	let mut pe = vec![b'M', b'Z', 0x90, 0x00];
	pe.resize(256 * 1024, 0xcc);
	for code in [8, 14, 1455] {
		let fs = crate::testkit::MemFs::new();
		fs.add_file("/bin/gh.exe", &pe, 0o755);
		let host = FakeHost::new()
			.with_fs(fs.clone())
			.with_spawner(Box::new(move |_| Err(std::io::Error::from_raw_os_error(code))));
		let init = ShellInit {
			mode: ModeId::Bash,
			argv0: "bash".into(),
			env: vec![
				(BString::from("PATH"), BString::from("/bin")),
				(BString::from("PATHEXT"), BString::from(".EXE")),
			],
			..ShellInit::default()
		};
		let cfg = EngineConfig { platform: Platform::Windows, ..EngineConfig::default() };
		let mut rig = Rig::with_config(host, init, cfg);
		let status = rig.run(Script::command(b"gh".to_vec()), Fault::None);
		let stderr = String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned();
		assert_eq!(status, 126, "code={code} stderr={stderr}");
		assert!(
			stderr.starts_with("bash: line 1: /bin/gh.exe: ")
				&& !stderr.contains("cannot execute binary file")
				&& !stderr.contains("bad interpreter"),
			"code={code} stderr={stderr}"
		);
		assert_eq!(fs.opens(), 0, "code={code} must not open executable on OOM");
		assert_eq!(fs.bytes_read(), 0, "code={code} must not read executable on OOM");
	}
}

/// When `refused`, `ENOEXEC` (`193` on Windows) or `bash /path/to/bin`
/// inspects a file for `#!` or binary NUL bytes, it reads only a bounded
/// header prefix instead of slurping multi-megabyte binaries, while text
/// scripts larger than the header cap still execute in full.
#[test]
fn binary_and_shebang_inspection_bounds_header_reads_without_truncating_scripts() {
	let mut pe = vec![b'M', b'Z', 0x90, 0x00];
	pe.resize(256 * 1024, 0xcc);
	let mut long_script = b"# ".to_vec();
	long_script.extend(std::iter::repeat_n(b'x', 4096));
	long_script.extend_from_slice(b"\necho full-script-ran\n");

	let run_case = |mode: ModeId, code: i32, cmd: &[u8]| -> (i32, String, String, u64) {
		let fs = crate::testkit::MemFs::new();
		fs.add_file("/bin/gh.exe", &pe, 0o755);
		fs.add_file("/bin/long.sh", &long_script, 0o755);
		fs.reset_io_counts();
		let host = FakeHost::new()
			.with_fs(fs.clone())
			.with_spawner(Box::new(move |_| Err(std::io::Error::from_raw_os_error(code))));
		let argv0 = if mode == ModeId::Zsh { "zsh" } else { "bash" };
		let init = ShellInit {
			mode,
			argv0: argv0.into(),
			env: vec![
				(BString::from("PATH"), BString::from("/bin")),
				(BString::from("PATHEXT"), BString::from(".EXE")),
			],
			..ShellInit::default()
		};
		let cfg = EngineConfig { platform: Platform::Windows, ..EngineConfig::default() };
		let mut rig = Rig::with_config(host, init, cfg);
		let status = rig.run(Script::command(cmd.to_vec()), Fault::None);
		(
			status,
			String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
			String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
			fs.bytes_read(),
		)
	};

	// 1. Bash `refused` on non-OOM error (e.g. ERROR_ACCESS_DENIED = 5) checks
	//    `#!` in <= 1 KiB.
	let (st, _, err, read) = run_case(ModeId::Bash, 5, b"gh");
	assert_eq!(st, 126, "{err}");
	assert!(read <= 1024, "expected bounded header read in bash refused, got {read} bytes");

	// 2. Zsh `zsh_refused` on `ERROR_BAD_EXE_FORMAT` (193) checks `#!` + binary
	//    in <= 2 KiB total.
	let (st, _, err, read) = run_case(ModeId::Zsh, 193, b"/bin/gh.exe");
	assert_eq!(st, 126, "{err}");
	assert!(err.contains("cannot execute binary file"), "{err}");
	assert!(read <= 2048, "expected bounded header read in zsh enoexec, got {read} bytes");

	// 3. Bash `ENOEXEC` (`ERROR_BAD_EXE_FORMAT` = 193) rejects binary in <= 1
	//    KiB.
	let (st, _, err, read) = run_case(ModeId::Bash, 193, b"/bin/gh.exe");
	assert_eq!(st, 126, "{err}");
	assert!(err.contains("cannot execute binary file"), "{err}");
	assert!(read <= 1024, "expected bounded header read in run_script_file, got {read} bytes");

	// 4. Nested `bash /bin/gh.exe` rejects binary in <= 1 KiB.
	let (st, _, err, read) = run_case(ModeId::Bash, 193, b"bash /bin/gh.exe");
	assert_eq!(st, 126, "{err}");
	assert!(err.contains("cannot execute binary file"), "{err}");
	assert!(read <= 1024, "expected bounded header read in nested script, got {read} bytes");

	// 5. Text script larger than the 1 KiB header cap still reads and executes
	//    completely.
	let (st, out, err, read) = run_case(ModeId::Bash, 193, b"/bin/long.sh");
	assert_eq!(st, 0, "{err}");
	assert_eq!(out, "full-script-ran\n");
	assert!(read >= long_script.len() as u64, "expected full script read, got {read}");
}
