//! `pi_shell::process`: the engine as a process shell.
//!
//! [`main`] takes a shell's command line (`zsh [zsh options] …`,
//! `bash [GNU long option] [option] …`, `sh …`; `argv[0]`'s base name picks
//! the dialect) to its exit status, the way the real shell does: bash's or
//! zsh's option parsing and messages, `--help`/`--version`, the startup
//! files, a `-c` command, a script operand or a script read from stdin a
//! line at a time, run over this process's own terminal, signals and
//! descriptors by [`NativeHost`].
//!
//! Two callers: the `obash` binary (a standalone process; it adds its test
//! modes on top of the pieces here) and `omp zsh|bash|sh`, which runs the
//! shell inside Bun through pi-natives' `runShellMain`
//! ([`ProcessOptions::embedded`]). Embedded, the shell shares its process
//! with a runtime that owns signal handlers and descriptors: see
//! [`ProcessOptions::embedded`] for what changes.

mod host;
mod pending_fs;
pub mod pretty;
mod signals;
mod timer;

use std::{
	fs,
	io::{self, IsTerminal, Read, Write},
	mem,
	path::PathBuf,
	task::Context,
	time::Duration,
};

use bstr::BString;

pub use self::host::{NativeHost, ignored_on_entry, inherited_fds};
use self::signals::RuntimeSignals;
use crate::{
	bash::{
		Budget, CallOutcome, Cx, Dialect, Engine, EngineConfig, EventMask, MemStore, ModeId, Origin,
		Profile, RunId, Script, Shell, ShellInit, Step, Vpid,
		diag::strerror,
		invocation::{self, ShellArgs},
		store::OptId,
		zshopt::ZshOpt,
	},
	sys::Parker,
};

/// How [`main`] runs the shell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProcessOptions {
	/// The shell runs inside another runtime's process (Bun, for
	/// `omp zsh`), which keeps running or exits after [`main`] returns:
	///
	/// - signals: of HUP, INT, QUIT, TERM, PIPE, ALRM, TSTP, TTIN, TTOU, CHLD,
	///   WINCH and CONT, those the runtime caught with a handler (and `SIGPIPE`,
	///   which it ignores) are reset to `SIG_DFL` for the run and restored after
	///   it; no other disposition is touched. `SIGPIPE` is therefore not
	///   reported as ignored on entry: externals start with the default action;
	/// - descriptors: the inherited ones above 2 (`3>file`) are duplicated,
	///   never taken over, and the runtime's own are left alone;
	/// - exits of externals are observed by a waiter thread each, beside the
	///   runtime's own child handling, and the process umask is read without
	///   changing it;
	/// - terminal modes the shell changed are restored when it ends;
	/// - teardown: the engine's caches and the variable store are freed before
	///   [`main`] returns. Standalone, the process is about to exit, so that
	///   memory is left to the OS; the shell itself (its externals, tasks and
	///   descriptors) is torn down the same either way.
	///
	/// Nothing outlives the call: a second [`main`] in the same process
	/// starts from the same state.
	pub embedded: bool,
}

/// What to run, and as whom.
pub struct Input {
	/// The script text (empty for [`Origin::Stdin`]: the engine reads it).
	pub source: Vec<u8>,
	/// Where it comes from.
	pub origin: Origin,
	/// `$0`.
	pub argv0:  BString,
	/// The positional parameters.
	pub args:   Vec<BString>,
}

/// A script operand the shell refuses to run: the message (complete stderr
/// text) and the exit status.
pub struct ScriptError {
	/// What goes to stderr.
	pub text:   Vec<u8>,
	/// The exit status.
	pub status: u8,
}

impl ScriptError {
	/// `NAME: FILE: what`.
	fn new(name: &[u8], file: &[u8], what: &str, status: u8) -> Self {
		let mut text = Vec::with_capacity(name.len() + file.len() + what.len() + 5);
		text.extend_from_slice(name);
		text.extend_from_slice(b": ");
		text.extend_from_slice(file);
		text.extend_from_slice(b": ");
		text.extend_from_slice(what.as_bytes());
		text.push(b'\n');
		Self { text, status }
	}
}

/// `bytes` as a path.
#[cfg(unix)]
fn os_path(bytes: &[u8]) -> PathBuf {
	use std::os::unix::ffi::OsStrExt;
	PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

/// `bytes` as a path.
#[cfg(not(unix))]
fn os_path(bytes: &[u8]) -> PathBuf {
	PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
}

/// `PATH` of `env`, or the shell's default when unset.
fn search_path(env: &[(BString, BString)]) -> BString {
	env.iter()
		.find(|(n, _)| n.as_slice() == b"PATH")
		.map_or_else(|| BString::from(invocation::DEFAULT_PATH), |(_, v)| v.clone())
}

/// Read the script operand as bash's `open_shell_script` does.
///
/// zsh's `setupshin` for the zsh dialect ([`read_zsh_script`]): a name without
/// `/` that is not in the current directory is looked up in `PATH` (bash's
/// default when unset); a directory or a binary file (a NUL on the first
/// line of the first 80 bytes) is refused (126); a missing file is 127.
/// Errors before the file opens are prefixed with the shell's name, later
/// ones with the script's (`$0`). Returns the path opened and the text.
///
/// # Errors
///
/// The shell's message and status for a script it refuses.
pub fn read_script(
	args: &ShellArgs,
	script: &[u8],
	env: &[(BString, BString)],
) -> Result<(BString, Vec<u8>), ScriptError> {
	if args.mode.dialect() == Dialect::Zsh {
		return read_zsh_script(args, script, env);
	}
	let mut path = BString::from(script);
	let mut opened = fs::File::open(os_path(&path));
	if let Err(err) = &opened
		&& err.kind() == io::ErrorKind::NotFound
		&& !script.contains(&b'/')
	{
		// bash's `find_path_file`: the first file of that name in `PATH` (an
		// empty entry is the current directory).
		let found = search_path(env).split(|&c| c == b':').find_map(|dir| {
			let mut cand = BString::from(if dir.is_empty() { &b"."[..] } else { dir });
			cand.push(b'/');
			cand.extend_from_slice(script);
			fs::metadata(os_path(&cand))
				.is_ok_and(|m| !m.is_dir())
				.then_some(cand)
		});
		if let Some(found) = found {
			opened = fs::File::open(os_path(&found));
			path = found;
		}
	}
	let mut file = opened.map_err(|err| {
		let status = if err.kind() == io::ErrorKind::NotFound {
			127
		} else {
			126
		};
		ScriptError::new(&args.shell_name, &path, &strerror(&err), status)
	})?;
	let dollar0 = &args.dollar0;
	if file.metadata().is_ok_and(|m| m.is_dir()) {
		return Err(ScriptError::new(dollar0, &path, "Is a directory", 126));
	}
	let mut text = Vec::new();
	file
		.read_to_end(&mut text)
		.map_err(|err| ScriptError::new(dollar0, &path, &strerror(&err), 126))?;
	let head = &text[..text.len().min(80)];
	let first_line = head.split(|&c| c == b'\n').next().unwrap_or(head);
	if first_line.contains(&0) {
		return Err(ScriptError::new(dollar0, &path, "cannot execute binary file", 126));
	}
	Ok((path, text))
}

/// zsh 5.9 `setupshin`: the script operand as given (not a directory).
///
/// Failing that, under `pathscript` (on in the sh and ksh emulations) a
/// name without `/` is looked up in `PATH` (`pathprog`). Anything else is
/// zsh's `NAME: can't open input file: SCRIPT`, status 127.
///
/// # Errors
///
/// zsh's message and status when the script cannot be read.
pub fn read_zsh_script(
	args: &ShellArgs,
	script: &[u8],
	env: &[(BString, BString)],
) -> Result<(BString, Vec<u8>), ScriptError> {
	let usable = |p: &[u8]| fs::metadata(os_path(p)).is_ok_and(|m| !m.is_dir());
	let pathscript = args
		.zsh_options
		.iter()
		.rev()
		.find(|(opt, _)| *opt == ZshOpt::Pathscript)
		.map_or(args.mode != ModeId::Zsh, |&(_, on)| on);
	let path = if usable(script) {
		Some(BString::from(script))
	} else if pathscript && !script.contains(&b'/') {
		search_path(env).split(|&c| c == b':').find_map(|dir| {
			let mut cand = BString::from(dir);
			cand.push(b'/');
			cand.extend_from_slice(script);
			usable(&cand).then_some(cand)
		})
	} else {
		None
	};
	if let Some(path) = path
		&& let Ok(text) = fs::read(os_path(&path))
	{
		return Ok((path, text));
	}
	let mut text = args.shell_name.to_vec();
	text.extend_from_slice(b": can't open input file: ");
	text.extend_from_slice(script);
	text.push(b'\n');
	Err(ScriptError { text, status: 127 })
}

/// What the command line `args` runs: the `-c` command, the script operand
/// ([`read_script`]) or stdin.
///
/// A script on stdin is left to the engine,
/// which reads it a line at a time as the shells do (commands that read
/// stdin get the lines that follow), unless `whole_stdin` (tool modes that
/// take the whole text) reads it all now.
///
/// # Errors
///
/// The shell's message and status for a script it refuses, or a failed
/// read of stdin (status 2).
pub fn input(
	args: &ShellArgs,
	env: &[(BString, BString)],
	whole_stdin: bool,
) -> Result<Input, ScriptError> {
	let argv0 = args.dollar0_in(env);
	match &args.input {
		invocation::Input::Command(cmd) => {
			Ok(Input { source: cmd.to_vec(), origin: Origin::Command, argv0, args: args.args.clone() })
		},
		invocation::Input::Script(script) => {
			let (path, source) = read_script(args, script, env)?;
			Ok(Input { source, origin: Origin::File(path), argv0, args: args.args.clone() })
		},
		invocation::Input::Stdin if whole_stdin => {
			let mut source = Vec::new();
			io::stdin()
				.read_to_end(&mut source)
				.map_err(|err| ScriptError::new(&args.shell_name, b"-", &strerror(&err), 2))?;
			Ok(Input { source, origin: Origin::Command, argv0, args: args.args.clone() })
		},
		invocation::Input::Stdin => {
			Ok(Input { source: Vec::new(), origin: Origin::Stdin, argv0, args: args.args.clone() })
		},
	}
}

/// Write `bytes` to stdout (help, version and option listings); the
/// status, 1 when the write failed.
pub fn print_out(bytes: &[u8]) -> u8 {
	let mut out = io::stdout().lock();
	u8::from(out.write_all(bytes).and_then(|()| out.flush()).is_err())
}

/// The process environment, as the shell imports it.
///
/// On Windows, where
/// names are case-insensitive, the search path (spelled `Path` there) and
/// the temp variables take the spelling the shell reads (`PATH`, `TEMP`,
/// …), temp paths their long form, and `PATH` gains Git for Windows' tool
/// directories: the same starting environment the agent's shell gets.
pub fn environment() -> Vec<(BString, BString)> {
	#[cfg(windows)]
	{
		windows_environment(std::env::vars_os())
	}
	#[cfg(not(windows))]
	{
		std::env::vars_os()
			.map(|(k, v)| (BString::from(k.as_encoded_bytes()), BString::from(v.as_encoded_bytes())))
			.collect()
	}
}

/// [`environment`] on Windows, from the entries `env`. Entries that are not
/// valid Unicode pass through unchanged.
#[cfg(windows)]
fn windows_environment(
	env: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(BString, BString)> {
	use bstr::ByteSlice;

	use crate::shell::{inherited_env_value, normalize_inherited_env_key};
	let mut out: Vec<(BString, BString)> = Vec::new();
	let mut path_at = None;
	for (key, value) in env {
		let (Some(k), Some(v)) = (key.to_str(), value.to_str()) else {
			out.push((BString::from(key.as_encoded_bytes()), BString::from(value.as_encoded_bytes())));
			continue;
		};
		let k = normalize_inherited_env_key(k);
		if k == "PATH" {
			path_at = Some(out.len());
		}
		out.push((BString::from(k), BString::from(inherited_env_value(k, v).as_ref())));
	}
	let mut path = std::collections::HashMap::new();
	if let Some(i) = path_at {
		path.insert("PATH".to_owned(), out[i].1.to_str_lossy().into_owned());
	}
	crate::windows::configure_windows_path(&mut path);
	if let Some(value) = path.remove("PATH") {
		match path_at {
			Some(i) => out[i].1 = BString::from(value),
			None => out.push((BString::from("PATH"), BString::from(value))),
		}
	}
	// A Windows console sets no `TERM` but takes xterm's sequences (the
	// shell turns virtual-terminal processing on): name it as MSYS2 does,
	// so ZLE and the programs the shell runs drive it as a terminal.
	if !out.iter().any(|(k, _)| k == "TERM") && std::io::IsTerminal::is_terminal(&std::io::stdout())
	{
		out.push((BString::from("TERM"), BString::from("xterm-256color")));
	}
	out
}

/// The process's working directory (`/` when it cannot be read), in its
/// long form on Windows, as `cd` stores `PWD`.
pub fn current_dir() -> BString {
	std::env::current_dir().map_or_else(
		|_| BString::from("/"),
		|p| {
			#[cfg(windows)]
			let p = crate::windows::expand_to_long_path(&p);
			BString::from(p.as_os_str().as_encoded_bytes())
		},
	)
}

/// A parsed command line ready to run ([`start`]).
pub struct Launch {
	/// The shell's command line.
	pub args:  ShellArgs,
	/// The process environment ([`environment`]).
	pub env:   Vec<(BString, BString)>,
	/// What to run.
	pub input: Input,
}

/// How [`start`] ended.
pub enum Start {
	/// Run this.
	Run(Box<Launch>),
	/// Nothing to run: exit with this status (a bad option, `--help`,
	/// `--version`, a script that cannot be read; the message is written).
	Exit(i32),
}

/// The shell's command line `argv` up to what it runs.
///
/// Option errors, `--help` and `--version` are handled here (written, with
/// their status), as is bash's `-o`/`+O` listing without a command; then the
/// environment is taken and the input read ([`input`]; `whole_stdin` as there).
pub fn start(argv: &[BString], whole_stdin: bool) -> Start {
	// The executable's own name keeps zsh zsh under another `argv[0]`.
	let exe = std::env::current_exe().map_or_default(|p| p.into_os_string().into_encoded_bytes());
	let args = match ShellArgs::parse_exe(argv, &exe) {
		Ok(args) => args,
		Err(err) => {
			let name = argv
				.first()
				.cloned()
				.unwrap_or_else(|| BString::from("bash"));
			let _ = io::stderr().write_all(&err.render(&name));
			return Start::Exit(err.status());
		},
	};
	let zsh = args.mode.dialect() == Dialect::Zsh;
	if args.help {
		let text = if zsh {
			zsh_help_text(argv.first().map_or(&b"zsh"[..], |a| a.as_slice()), &args)
		} else {
			invocation::help_text(&args.shell_name)
		};
		return Start::Exit(i32::from(print_out(&text)));
	}
	if args.version {
		let text = if zsh {
			zsh_version_text()
		} else {
			invocation::version_text()
		};
		return Start::Exit(i32::from(print_out(&text)));
	}
	// bash lists the options and goes on: a failed write does not stop it.
	if let Some(text) = args.listing_text() {
		let _ = print_out(&text);
	}
	let env = environment();
	match input(&args, &env, whole_stdin) {
		Ok(input) => Start::Run(Box::new(Launch { args, env, input })),
		Err(err) => {
			let _ = io::stderr().write_all(&err.text);
			Start::Exit(i32::from(err.status))
		},
	}
}

/// zsh 5.9 `printhelp`: the usage with `argv[0]` as given, then the option
/// list. Its shape depends only on whether the options before `--help` set
/// `SHOPTIONLETTERS` (the emulation's defaults apply after the parse): set,
/// the `-b` line goes and the sh option letters are listed. The list is
/// zsh's own output, kept verbatim (including its off-by-one `Option
/// aliases` equivalents).
fn zsh_help_text(argzero: &[u8], args: &ShellArgs) -> Vec<u8> {
	let sh_letters = args
		.zsh_options
		.iter()
		.rev()
		.find(|(opt, _)| *opt == ZshOpt::Shoptionletters)
		.is_some_and(|&(_, on)| on);
	let body: &[u8] = if sh_letters {
		include_bytes!("zsh_help_sh.txt")
	} else {
		include_bytes!("zsh_help.txt")
	};
	let mut out = b"Usage: ".to_vec();
	out.extend_from_slice(argzero);
	out.extend_from_slice(b" [<options>] [<argument> ...]\n");
	out.extend_from_slice(body);
	out
}

/// zsh 5.9 `--version`: `zsh 5.9 (MACHTYPE-VENDOR-OSTYPE)` as configure
/// names the build host (`arm64-apple-darwinN.0`, `x86_64-pc-linux-gnu`,
/// MSYS2's `x86_64-pc-msys` on Windows).
fn zsh_version_text() -> Vec<u8> {
	let arch = std::env::consts::ARCH;
	let vendor = if arch == "x86_64" { "pc" } else { "unknown" };
	let host = if cfg!(target_os = "macos") {
		let release = crate::sys::uname::uname().map_or_default(|(_, release, _)| release);
		let major = release.split(|&c| c == b'.').next().unwrap_or_default();
		let cpu = if arch == "aarch64" { "arm64" } else { arch };
		format!("{cpu}-apple-darwin{}.0", String::from_utf8_lossy(major))
	} else if cfg!(windows) {
		format!("{arch}-{vendor}-msys")
	} else {
		format!("{arch}-{vendor}-linux-gnu")
	};
	format!("zsh 5.9 ({host})\n").into_bytes()
}

/// The process shell: the command line `argv` (`argv[0]` names the shell)
/// to the exit status (0–255) the process should exit with. Standard
/// output is flushed before it returns.
pub fn main<A: Into<BString>>(argv: impl IntoIterator<Item = A>, opts: ProcessOptions) -> i32 {
	let argv: Vec<BString> = argv.into_iter().map(Into::into).collect();
	let mut launch = match start(&argv, false) {
		Start::Run(launch) => launch,
		Start::Exit(status) => return status,
	};
	if let Some(status) = pretty_print_mode(&mut launch) {
		return status;
	}
	let Launch { args, env, input } = *launch;
	let status = run(&args, env, input, opts);
	let _ = io::stdout().flush();
	status
}

/// bash's `--pretty-print` instead of running: the status when `launch`
/// asks for it (a script operand or stdin; bash ignores it for a `-c`
/// command and in an interactive shell, and runs those).
pub fn pretty_print_mode(launch: &mut Launch) -> Option<i32> {
	let args = &launch.args;
	if !args.pretty_print || args.interactive || matches!(args.input, invocation::Input::Command(_))
	{
		return None;
	}
	let input = &mut launch.input;
	if matches!(input.origin, Origin::Stdin)
		&& let Err(err) = io::stdin().read_to_end(&mut input.source)
	{
		let err = ScriptError::new(&args.shell_name, b"-", &strerror(&err), 2);
		let _ = io::stderr().write_all(&err.text);
		return Some(i32::from(err.status));
	}
	Some(i32::from(pretty::pretty_print(&input.source, &input.argv0)))
}

/// Run the shell `args` describes on `input`, with the process environment
/// `env`; the exit status (0–255).
fn run(args: &ShellArgs, env: Vec<(BString, BString)>, input: Input, opts: ProcessOptions) -> i32 {
	// Declared first, dropped last: the runtime gets its dispositions back
	// after the host has put its trap handlers back.
	let _runtime = if opts.embedded {
		match RuntimeSignals::reset() {
			Ok(saved) => Some(saved),
			Err(err) => {
				eprintln!("{}: {err}", args.shell_name);
				return 2;
			},
		}
	} else {
		None
	};
	// Before the process opens any fd of its own.
	let inherited = inherited_fds(opts.embedded);
	let mut host = NativeHost::new(None, false, inherited, ignored_on_entry(), 0, opts.embedded);
	// `omp zsh` on Windows: pi's utilities stand in for the Unix tools it
	// lacks. Elsewhere, and in obash, a missing command stays not found.
	if opts.embedded && cfg!(windows) {
		host.offer_extras(&env);
	}
	let cfg = EngineConfig::default();
	let engine = Engine::new(cfg);
	let mut store = MemStore::new();
	let Input { source, origin, argv0, args: params } = input;
	let init = shell_init(args, argv0, params, env, current_dir());
	let mut shell =
		match Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init) {
			Ok(shell) => shell,
			Err(err) => {
				eprintln!("{}: {err}", args.shell_name);
				return 2;
			},
		};
	let root = Vpid(cfg.vpid_base);
	host.bind_signals(shell.control(), root);
	// Nothing observes events: skip building them (each reads the clock).
	shell.set_event_mask(EventMask::NONE);
	let run = shell.submit(Script { origin, ..Script::command(source) });
	let status = drive(&mut host, &mut store, &mut shell, run, root);
	// zsh `zexit`: hang up running jobs, give the terminal back.
	shell.leave_job_control(&mut Cx { host: &mut host, store: &mut store });
	// Standalone, the process exits next: let the OS reclaim the engine's
	// unit cache and the store instead of freeing every cached unit,
	// function and variable one by one (a quarter of a 100k-command
	// script's run). Both are plain data. The shell still drops first: it
	// owns the live externals (abandoning one signals its process group),
	// task handles and the script's descriptors. Its `Arc` of the engine is
	// not the last one, so dropping it frees no cache. Not under
	// `alloc-stats`, whose `live=` count reads what is still allocated at exit.
	drop(shell);
	if !opts.embedded && !cfg!(feature = "alloc-stats") {
		mem::forget(store);
		mem::forget(engine);
	}
	status & 0xff
}

/// The new shell's initial state from the command line `args`.
///
/// `$0` (`argv0`) and the positional parameters (`params`), the options in the
/// shell's order, interactivity (`-i`, or stdin and stderr on a terminal)
/// and the startup files that exist (unreadable ones are reported and
/// skipped, as bash's `maybe_execute_file` does).
pub fn shell_init(
	args: &ShellArgs,
	argv0: BString,
	params: Vec<BString>,
	env: Vec<(BString, BString)>,
	cwd: BString,
) -> ShellInit {
	let interactive = args.is_interactive(io::stdin().is_terminal() && io::stderr().is_terminal());
	let mut options = args.startup_options(&env, interactive);
	let home = env
		.iter()
		.find(|(n, _)| n.as_slice() == b"HOME")
		.map_or_else(BString::default, |(_, v)| v.clone());
	let report = |what: &[u8], msg: &[u8]| {
		let mut line = args.shell_name.to_vec();
		if !what.is_empty() {
			line.extend_from_slice(b": ");
			line.extend_from_slice(what);
		}
		line.extend_from_slice(b": ");
		line.extend_from_slice(msg);
		line.push(b'\n');
		let _ = io::stderr().write_all(&line);
	};
	let mut startup = Vec::new();
	match args.startup_files(&env, &home, interactive) {
		Ok(mut files) => {
			let newuser = newuser_scripts(args, &env, interactive);
			if !newuser.is_empty() {
				// After `/etc/zshenv`, before `$ZDOTDIR/.zshenv`.
				files.insert(files.len().min(1), newuser);
			}
			for candidates in files {
				let Some(path) = candidates
					.into_iter()
					.find(|p| fs::metadata(os_path(p)).is_ok())
				else {
					continue;
				};
				match fs::read(os_path(&path)) {
					Ok(text) => startup.push((path, BString::from(text))),
					Err(err) => report(&path, strerror(&err).as_bytes()),
				}
			}
		},
		Err(err) => report(b"", err.to_string().as_bytes()),
	}
	if args.debugger {
		// bash's `start_debugger`: bashdb's start file with function and
		// error tracing (and `extdebug`); without it, debugging is off.
		let file = invocation::DEBUGGER_START_FILE;
		match fs::read(file) {
			Ok(text) => {
				startup.push((BString::from(file), BString::from(text)));
				options.extend([
					(OptId::Extdebug, true),
					(OptId::Functrace, true),
					(OptId::Errtrace, true),
				]);
			},
			Err(err) => {
				report(file.as_bytes(), strerror(&err).as_bytes());
				report(b"", b"warning: cannot start debugger; debugging mode disabled");
			},
		}
	}
	// A zsh-dialect shell takes zsh option names (the bash ones above stay
	// empty for it).
	let options = options
		.into_iter()
		.map(|(opt, on)| (BString::from(<&'static str>::from(opt)), on))
		.chain(
			args
				.zsh_options
				.iter()
				.map(|&(opt, on)| (BString::from(<&'static str>::from(opt)), on)),
		)
		.collect();
	let zsh_fpath = (args.mode.dialect() == Dialect::Zsh)
		.then(|| system_fpath(&env))
		.flatten();
	ShellInit {
		mode: args.mode,
		argv0,
		args: params,
		env,
		cwd,
		interactive,
		options,
		shell_pid: std::process::id(),
		startup,
		zsh_params: zsh_params(args),
		zsh_fpath,
		profile: Profile::User,
	}
}

/// The system zsh's function directories (`fpath` before any startup file):
/// the site and vendor directories, then each directory of the function
/// library that holds functions. Distributions install the library at
/// different places: flat under `/usr/share/zsh/5.9/functions` (zsh's own
/// layout, macOS, Fedora) or grouped under `/usr/share/zsh/functions`
/// (Debian, Ubuntu, Arch). On Windows the library is an MSYS2, Cygwin or
/// Git for Windows zsh's ([`zsh_roots`]), spelled with `/`. `None` without
/// one: zsh's compiled-in default.
fn system_fpath(env: &[(BString, BString)]) -> Option<Vec<BString>> {
	zsh_roots(env).iter().find_map(|root| fpath_under(root))
}

/// [`system_fpath`] of the zsh installed under `root` (`""`: `/`).
fn fpath_under(root: &str) -> Option<Vec<BString>> {
	use std::path::Path;
	const SITE: [&str; 4] = [
		"/usr/local/share/zsh/site-functions",
		"/usr/share/zsh/site-functions",
		"/usr/share/zsh/vendor-functions",
		"/usr/share/zsh/vendor-completions",
	];
	const LIBRARIES: [&str; 3] = [
		"/usr/share/zsh/5.9/functions",
		"/usr/share/zsh/functions",
		"/usr/local/share/zsh/5.9/functions",
	];
	let libraries: Vec<String> = LIBRARIES
		.iter()
		.map(|lib| format!("{root}{lib}"))
		.filter(|p| Path::new(p).is_dir())
		.collect();
	if libraries.is_empty() {
		return None;
	}
	// zsh always lists the local site directory, existing or not.
	let mut out = vec![BString::from(format!("{root}{}", SITE[0]))];
	out.extend(
		SITE[1..]
			.iter()
			.map(|d| format!("{root}{d}"))
			.filter(|d| Path::new(d).is_dir())
			.map(BString::from),
	);
	for lib in libraries {
		function_dirs(Path::new(&lib), 0, &mut out);
	}
	Some(out)
}

/// Where a system zsh may be installed: `/` on Unix.
#[cfg(unix)]
fn zsh_roots(_env: &[(BString, BString)]) -> Vec<String> {
	vec![String::new()]
}

/// Where a zsh may be installed on Windows, spelled with `/`: the roots of
/// the Unix trees on `PATH` (an MSYS2 or Git for Windows `…\usr\bin`, a
/// Cygwin `…\bin`), then MSYS2's and Cygwin's default install directories.
#[cfg(windows)]
fn zsh_roots(env: &[(BString, BString)]) -> Vec<String> {
	use bstr::ByteSlice;
	let path = env
		.iter()
		.find(|(k, _)| k == "PATH")
		.map_or_else(String::new, |(_, v)| v.to_str_lossy().into_owned());
	let mut roots: Vec<String> = Vec::new();
	for dir in path.split(';') {
		let dir = dir.trim().trim_end_matches(['\\', '/']).replace('\\', "/");
		let lower = dir.to_ascii_lowercase();
		let root = if lower.ends_with("/usr/bin") {
			&dir[..dir.len() - "/usr/bin".len()]
		} else if lower.ends_with("/bin") {
			&dir[..dir.len() - "/bin".len()]
		} else {
			continue;
		};
		if !root.is_empty() {
			roots.push(root.to_owned());
		}
	}
	roots.extend(["C:/msys64", "C:/cygwin64", "C:/cygwin"].map(String::from));
	let mut seen = std::collections::HashSet::new();
	roots.retain(|r| seen.insert(r.to_ascii_lowercase()));
	roots
}

/// Push `dir` when it holds a function (a file other than a compiled
/// `.zwc` digest), then its subdirectories in name order.
fn function_dirs(dir: &std::path::Path, depth: u32, out: &mut Vec<BString>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	let mut subdirs = Vec::new();
	let mut functions = false;
	for e in entries.flatten() {
		let Ok(ft) = e.file_type() else { continue };
		if ft.is_dir() {
			subdirs.push(e.path());
		} else if !e.file_name().as_encoded_bytes().ends_with(b".zwc") {
			functions = true;
		}
	}
	if functions {
		out.push(fpath_spelling(dir));
	}
	if depth < 3 {
		subdirs.sort();
		for d in subdirs {
			function_dirs(&d, depth + 1, out);
		}
	}
}

/// `dir` as an `fpath` entry: its bytes; on Windows with `/` separators.
fn fpath_spelling(dir: &std::path::Path) -> BString {
	let bytes = dir.as_os_str().as_encoded_bytes();
	if cfg!(windows) {
		BString::from(
			bytes
				.iter()
				.map(|&c| if c == b'\\' { b'/' } else { c })
				.collect::<Vec<u8>>(),
		)
	} else {
		BString::from(bytes)
	}
}

/// zsh/newuser in zsh's `run_init_scripts`: for an interactive shell in zsh
/// emulation with `RCS` on and `PRIVILEGED` off (it defaults on in a setuid
/// or setgid process), the `newuser` scripts to try (the first that exists
/// is sourced) when the user has no dotfiles in `$ZDOTDIR` (else `$HOME`).
fn newuser_scripts(
	args: &ShellArgs,
	env: &[(BString, BString)],
	interactive: bool,
) -> Vec<BString> {
	if args.mode != ModeId::Zsh || !interactive {
		return Vec::new();
	}
	let set = |opt: ZshOpt, default: bool| {
		args
			.zsh_options
			.iter()
			.rev()
			.find(|(o, _)| *o == opt)
			.map_or(default, |&(_, on)| on)
	};
	#[cfg(unix)]
	// SAFETY: the id getters have no preconditions.
	let setid = unsafe { libc::getuid() != libc::geteuid() || libc::getgid() != libc::getegid() };
	#[cfg(not(unix))]
	let setid = false;
	if !set(ZshOpt::Rcs, true) || set(ZshOpt::Privileged, setid) {
		return Vec::new();
	}
	let var = |name: &[u8]| {
		env.iter()
			.find(|(n, _)| n.as_slice() == name)
			.map(|(_, v)| v.as_slice())
	};
	crate::bash::newuser_startup_scripts(var(b"ZDOTDIR").or_else(|| var(b"HOME")), |p| {
		fs::metadata(os_path(p)).is_ok()
	})
}

/// zsh's `init.c` parameters from the command line (zsh dialect only):
/// `ZSH_EXECUTION_STRING` (the `-c` string) and `ZSH_SCRIPT` (the script
/// operand as given, before any `PATH` search).
fn zsh_params(args: &ShellArgs) -> Vec<(BString, BString)> {
	if args.mode.dialect() != Dialect::Zsh {
		return Vec::new();
	}
	match &args.input {
		invocation::Input::Command(cmd) => {
			vec![(BString::from("ZSH_EXECUTION_STRING"), BString::from(cmd.to_vec()))]
		},
		invocation::Input::Script(script) => {
			vec![(BString::from("ZSH_SCRIPT"), BString::from(script.to_vec()))]
		},
		invocation::Input::Stdin => Vec::new(),
	}
}

/// Run `shell` until script `run` finishes; its status.
///
/// Between steps the
/// OS signals the host caught go to the root vproc `root`; while the shell
/// waits, the thread parks (and, standalone on Linux, waits for the exits
/// of externals itself).
pub fn drive(
	host: &mut NativeHost,
	store: &mut MemStore,
	shell: &mut Shell,
	run: RunId,
	root: Vpid,
) -> i32 {
	let mut parker = Parker::new();
	loop {
		NativeHost::dispatch_signals(&shell.control(), root);
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Done { run: done, status } if done == run => return status,
			Step::Call { id, .. } => no_callouts(shell, id),
			Step::Blocked | Step::Paused => wait_runnable(&mut parker, shell, root),
			// A busy shell never parks: notice background exits here.
			Step::Yield => parker.poll_exits(),
			Step::Done { .. } | Step::SuspendReady => {},
			Step::Idle => return 0,
		}
	}
}

/// A process shell has no host callouts: answer each with an error.
pub fn no_callouts(shell: &mut Shell, id: crate::bash::CallId) {
	shell.complete(
		id,
		CallOutcome::Error("host callouts are not available in a process shell".into()),
	);
}

/// Park until the shell may make progress, forwarding OS signals (a signal
/// caught on this thread ends the park at once on Linux; otherwise within
/// 50 ms).
pub fn wait_runnable(parker: &mut Parker, shell: &Shell, root: Vpid) {
	let ctl = shell.control();
	let waker = parker.waker().clone();
	let mut cx = Context::from_waker(&waker);
	loop {
		NativeHost::dispatch_signals(&ctl, root);
		if ctl.poll_runnable(&mut cx).is_ready() {
			break;
		}
		parker.park(Duration::from_millis(50));
	}
}

#[cfg(all(test, windows))]
mod tests {
	use super::*;

	/// A zsh on `PATH` (an MSYS2 or Git for Windows `…\usr\bin`) lends its
	/// function library: `fpath` lists its site and library directories,
	/// spelled with `/`, ahead of the default install directories.
	#[test]
	fn fpath_comes_from_the_zsh_on_path() {
		let root = tempfile::tempdir().expect("zsh install fixture");
		let lib = root.path().join("usr/share/zsh/5.9/functions");
		std::fs::create_dir_all(lib.join("Completion/Unix")).expect("library");
		std::fs::write(lib.join("Completion/Unix/_ls"), "").expect("function");
		std::fs::write(lib.join("compinit"), "").expect("function");
		std::fs::write(lib.join("Completion/Unix.zwc"), "").expect("digest");
		std::fs::create_dir_all(root.path().join("usr/share/zsh/site-functions")).expect("site");
		let r = root.path().to_string_lossy().replace('\\', "/");
		let path = format!("C:\\Windows;{}\\usr\\bin\\", root.path().display());
		let env = [(BString::from("PATH"), BString::from(path))];
		let want: Vec<BString> = [
			"/usr/local/share/zsh/site-functions",
			"/usr/share/zsh/site-functions",
			"/usr/share/zsh/5.9/functions",
			"/usr/share/zsh/5.9/functions/Completion/Unix",
		]
		.into_iter()
		.map(|d| BString::from(format!("{r}{d}")))
		.collect();
		assert_eq!(system_fpath(&env), Some(want));
	}

	/// Windows spells the search path `Path`; imported verbatim, zsh saw no
	/// `PATH`, fell back to `/bin:/usr/bin:…` and found no program by name.
	#[test]
	fn windows_path_is_imported_as_path() {
		let env = [("Path", "C:\\Windows;C:\\tools"), ("Other", "x")]
			.map(|(k, v)| (std::ffi::OsString::from(k), std::ffi::OsString::from(v)));
		let out = windows_environment(env.into_iter());
		let path = out
			.iter()
			.find(|(k, _)| k == "PATH")
			.map(|(_, v)| v.to_string())
			.expect("PATH imported");
		assert!(path.starts_with("C:\\Windows;C:\\tools"), "{path}");
		assert!(!out.iter().any(|(k, _)| k == "Path"));
		assert!(out.iter().any(|(k, v)| k == "Other" && v == "x"));
	}
}
