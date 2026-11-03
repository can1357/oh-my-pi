//! `obash`: the pi-shell bash engine as a standalone shell, for differential
//! testing against bash 5.3 and for benchmarks.
//!
//! ```text
//! obash [OBASH OPTIONS] [BASH OPTIONS] -c COMMAND [NAME [ARGS]]
//! obash [OBASH OPTIONS] [BASH OPTIONS] SCRIPT [ARGS]
//! obash [OBASH OPTIONS] [BASH OPTIONS]  # script on stdin
//!
//! obash's own options (before bash's):
//! --events=jsonl        write every event as a JSON line
//! --events-out=PATH     write the events to PATH instead of stderr
//! --fault=SEED:K        inject faults (see --fault-mode); a snapshot that
//!                       would lose externals in flight or open OS handles is
//!                       not restored unless PI_SHELL_FAULT_LOST=restore
//! --fault-mode=MODE     step: every K ops a coin seeded with SEED picks
//!                       pause/resume or an in-process snapshot (default);
//!                       pause: pause/resume after each op with p = 1/K;
//!                       exec: every K ops a snapshot restored in a new
//!                       process (Unix)
//! --ir                  print the IR of every command instead of running
//! --print               print every command (`declare -f` layout) instead of running
//! --json=DIALECT        print the parse as JSON (`native`, or `shfmt` for bash-viz)
//! --parse-corpus=PATH   parse every command of a corpus file, print timing JSON
//! --supported           print the implemented optional features as JSON
//! ```
//!
//! Everything else is bash's own command line (`bash [GNU long option]
//! [option] ...`), parsed by [`pi_shell::bash::invocation::ShellArgs`] with
//! bash's messages: `--login`, `--posix`, `--norc`, `--rcfile`,
//! `--pretty-print`, `--help`, `--version`, `-c`, `-s`, `-i`, `-l`, set flags,
//! `-o`/`-O`. Invoked as `sh`, the shell starts in posix mode.
//!
//! The entry point is C's `main` (`#![no_main]`): std's runtime setup sets
//! `SIGPIPE` to ignored before a Rust `main`, while bash keeps the
//! disposition it was started with (a pipeline stage killed by `SIGPIPE`
//! must die of it, and `trap '' PIPE` before `exec` must stay).

// The unit-test build keeps libtest's `main`, so nothing reaches what only
// obash's entry point uses.
#![cfg_attr(not(test), no_main)]
#![cfg_attr(test, allow(dead_code, reason = "the unit-test build has no entry point"))]

#[cfg(feature = "alloc-stats")]
mod alloc_stats;
mod fault;
mod host;
mod pending_fs;
mod signals;
mod syntax;
mod timer;

use std::{
	ffi::OsString,
	fs,
	io::{self, BufWriter, IsTerminal, Read, Write},
	path::PathBuf,
};

use bstr::BString;
use clap::Parser;
use pi_shell::bash::{
	Cx, Engine, EngineConfig, EventMask, MemStore, ModeId, Origin, RestoreOpts, Script, Shell,
	ShellInit,
	invocation::{self, ShellArgs},
	ir,
	syntax::Features,
};

use crate::host::NativeHost;

/// The engine allocates small, short-lived buffers per command (argv, fields,
/// scratch); with the platform malloc, allocation was about a third of the
/// dispatch loop's time on macOS.
#[cfg(not(feature = "alloc-stats"))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// The same allocator with counters (`--features alloc-stats`, measurement
/// only): see [`alloc_stats`].
#[cfg(feature = "alloc-stats")]
#[global_allocator]
static GLOBAL: alloc_stats::Counting = alloc_stats::Counting(mimalloc::MiMalloc);

/// Turns mimalloc's `arena_eager_commit` off before the first allocation:
/// an ELF constructor, since Rust's runtime allocates before `main`.
/// Committed eagerly, the first touches of the arena fault in whole 2 MiB
/// transparent huge pages under THP `always`, and zeroing them was about
/// 7 % of `obash -c :` on Linux; committed on demand, only the pages used
/// are touched (xeon, `perf stat -r 200 obash -c :`: 2.38 → 2.16 ms with
/// `MIMALLOC_ARENA_EAGER_COMMIT=0`). Unlike mimalloc's `allow_thp=0` (a
/// `PR_SET_THP_DISABLE` that externals would inherit) it changes nothing
/// for child processes.
#[cfg(target_os = "linux")]
#[used]
#[unsafe(link_section = ".init_array")]
static MIMALLOC_LAZY_COMMIT: extern "C" fn() = mimalloc_lazy_commit;

#[cfg(target_os = "linux")]
extern "C" fn mimalloc_lazy_commit() {
	/// `mi_option_arena_eager_commit` in mimalloc's `mi_option_e` (v2 and
	/// v3).
	const ARENA_EAGER_COMMIT: std::ffi::c_int = 4;
	// The mimalloc crate does not re-export its C library; the symbol is
	// in the static library it links.
	unsafe extern "C" {
		fn mi_option_set(option: std::ffi::c_int, value: std::ffi::c_long);
	}
	// An explicit `MIMALLOC_ARENA_EAGER_COMMIT` wins (startup measurements).
	// SAFETY: getenv on a NUL-terminated name, before any thread exists.
	if !unsafe { libc::getenv(c"MIMALLOC_ARENA_EAGER_COMMIT".as_ptr()) }.is_null() {
		return;
	}
	// SAFETY: setting an option only writes mimalloc's option table; it has
	// no preconditions and runs before any allocation or thread exists.
	unsafe { mi_option_set(ARENA_EAGER_COMMIT, 0) };
}

#[derive(clap::Parser, Debug, Default)]
#[command(
	name = "obash",
	about = "The pi-shell bash engine as a standalone shell (tests and benchmarks)"
)]
struct Cli {
	/// Event output format.
	#[arg(long, value_enum)]
	events:       Option<EventsFormat>,
	/// Event destination (default: stderr).
	#[arg(long, value_name = "PATH")]
	events_out:   Option<PathBuf>,
	/// Fault injection: `--fault=SEED:K`, `--fault-mode=step|pause|exec`.
	#[command(flatten)]
	fault:        fault::FaultArgs,
	/// Print the IR instead of running.
	#[arg(long, conflicts_with_all = ["print", "json", "parse_corpus"])]
	ir:           bool,
	/// Print the commands instead of running.
	#[arg(long, conflicts_with_all = ["json", "parse_corpus"])]
	print:        bool,
	/// Print the parse as JSON instead of running.
	#[arg(long, value_enum, value_name = "DIALECT", conflicts_with = "parse_corpus")]
	json:         Option<syntax::Dialect>,
	/// Parse every command of a corpus file and report the parse time.
	#[arg(long, value_name = "PATH")]
	parse_corpus: Option<PathBuf>,
	/// Print the optional features this build implements (a JSON array
	/// in conformance-harness vocabulary) and exit.
	#[arg(long)]
	supported:    bool,
}

/// obash's own long options without a value.
const OBASH_FLAGS: &[&str] = &["--ir", "--print", "--supported"];

/// obash's own long options that take a value (`--fault S:K` or
/// `--fault=S:K`; `--fault-resume=STATE` is always passed with `=`).
const OBASH_WITH_VALUE: &[&str] = &[
	"--events",
	"--events-out",
	"--fault",
	"--fault-mode",
	"--fault-resume",
	"--json",
	"--parse-corpus",
];

/// Split `args` (program name first) into obash's own options (for clap)
/// and bash's command line (for [`ShellArgs::parse`]). obash's options are
/// taken from the leading options only, where bash's parser would stop at
/// them; the values of `-o`/`-O`/`--rcfile`/`--init-file` are skipped.
fn split_args(args: Vec<OsString>) -> (Vec<OsString>, Vec<BString>) {
	let mut it = args.into_iter();
	let argv0 = it.next().unwrap_or_else(|| OsString::from("obash"));
	let mut clap_args = vec![argv0.clone()];
	let mut argv = vec![bytes(&argv0)];
	while let Some(arg) = it.next() {
		let b = arg.as_encoded_bytes();
		let name = b.split(|&c| c == b'=').next().unwrap_or(b);
		if OBASH_FLAGS.iter().any(|f| f.as_bytes() == b) {
			clap_args.push(arg);
			continue;
		}
		if OBASH_WITH_VALUE.iter().any(|f| f.as_bytes() == name) {
			let inline = name.len() < b.len();
			clap_args.push(arg);
			if !inline && let Some(v) = it.next() {
				clap_args.push(v);
			}
			continue;
		}
		let option = matches!(b.first(), Some(b'-' | b'+')) && !matches!(b, b"-" | b"--");
		// The next argument is this option's value, not an option.
		let takes_value = option
			&& (matches!(b, b"--rcfile" | b"--init-file" | b"-rcfile" | b"-init-file")
				|| (!b.starts_with(b"--") && b[1..].iter().any(|&c| matches!(c, b'o' | b'O'))));
		argv.push(bytes(&arg));
		if !option {
			break;
		}
		if takes_value && let Some(v) = it.next() {
			argv.push(bytes(&v));
		}
	}
	argv.extend(it.map(|a| bytes(&a)));
	(clap_args, argv)
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum EventsFormat {
	/// One JSON object per line.
	Jsonl,
}

/// Optional features implemented, in conformance-harness vocabulary
/// (`trap`, `kill`, `wait`, `jobs`, `job-control`, `fifo`, `read-timeout`,
/// `coproc`, `procsub`): the runner skips groups that need the others.
const SUPPORTED: &[&str] = &[
	"trap",
	"kill",
	"wait",
	"wait-n",
	"jobs",
	"fg-bg",
	"job-control",
	"jobs-x",
	"fifo",
	"read-timeout",
	"procsub",
	"coproc",
	"read-e",
];

fn bytes(s: &OsString) -> BString {
	BString::from(s.as_encoded_bytes())
}

/// What to run, and as whom.
struct Input {
	source: Vec<u8>,
	origin: Origin,
	argv0:  BString,
	args:   Vec<BString>,
}

/// A script operand bash refuses to run: the message (complete stderr
/// text) and the exit status.
struct ScriptError {
	text:   Vec<u8>,
	status: u8,
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

/// Read the script operand as bash's `open_shell_script` does: a name
/// without `/` that is not in the current directory is looked up in
/// `PATH` (bash's default when unset); a directory or a binary file (a NUL
/// on the first line of the first 80 bytes) is refused (126); a missing
/// file is 127. Errors before the file opens are prefixed with the shell's
/// name, later ones with the script's (`$0`).
fn read_script(
	args: &ShellArgs,
	script: &[u8],
	env: &[(BString, BString)],
) -> Result<(BString, Vec<u8>), ScriptError> {
	if args.mode.dialect() == pi_shell::bash::Dialect::Zsh {
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
		let search = env
			.iter()
			.find(|(n, _)| n.as_slice() == b"PATH")
			.map_or_else(|| BString::from(invocation::DEFAULT_PATH), |(_, v)| v.clone());
		let found = search.split(|&c| c == b':').find_map(|dir| {
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
		ScriptError::new(&args.shell_name, &path, &pi_shell::bash::diag::strerror(&err), status)
	})?;
	let dollar0 = &args.dollar0;
	if file.metadata().is_ok_and(|m| m.is_dir()) {
		return Err(ScriptError::new(dollar0, &path, "Is a directory", 126));
	}
	let mut text = Vec::new();
	file.read_to_end(&mut text).map_err(|err| {
		ScriptError::new(dollar0, &path, &pi_shell::bash::diag::strerror(&err), 126)
	})?;
	let head = &text[..text.len().min(80)];
	let first_line = head.split(|&c| c == b'\n').next().unwrap_or(head);
	if first_line.contains(&0) {
		return Err(ScriptError::new(dollar0, &path, "cannot execute binary file", 126));
	}
	Ok((path, text))
}

/// zsh 5.9 `setupshin`: the script operand as given (not a directory);
/// failing that, under `pathscript` (on in the sh and ksh emulations) a
/// name without `/` is looked up in `PATH` (`pathprog`). Anything else is
/// zsh's `NAME: can't open input file: SCRIPT`, status 127.
fn read_zsh_script(
	args: &ShellArgs,
	script: &[u8],
	env: &[(BString, BString)],
) -> Result<(BString, Vec<u8>), ScriptError> {
	let usable = |p: &[u8]| fs::metadata(os_path(p)).is_ok_and(|m| !m.is_dir());
	let pathscript = args
		.zsh_options
		.iter()
		.rev()
		.find(|(opt, _)| *opt == pi_shell::bash::zshopt::ZshOpt::Pathscript)
		.map_or(args.mode != ModeId::Zsh, |&(_, on)| on);
	let path = if usable(script) {
		Some(BString::from(script))
	} else if pathscript && !script.contains(&b'/') {
		let search = env
			.iter()
			.find(|(n, _)| n.as_slice() == b"PATH")
			.map_or_else(|| BString::from(invocation::DEFAULT_PATH), |(_, v)| v.clone());
		search.split(|&c| c == b':').find_map(|dir| {
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

fn input(cli: &Cli, args: &ShellArgs, env: &[(BString, BString)]) -> Result<Input, ScriptError> {
	let argv0 = args.dollar0_in(env);
	match &args.input {
		invocation::Input::Command(cmd) => {
			Ok(Input { source: cmd.to_vec(), origin: Origin::Command, argv0, args: args.args.clone() })
		},
		invocation::Input::Script(script) => {
			let (path, source) = read_script(args, script, env)?;
			Ok(Input { source, origin: Origin::File(path), argv0, args: args.args.clone() })
		},
		invocation::Input::Stdin => {
			if cli.print || cli.ir || cli.json.is_some() || args.pretty_print {
				// The tool modes take the whole text.
				let mut source = Vec::new();
				io::stdin().read_to_end(&mut source).map_err(|err| {
					ScriptError::new(&args.shell_name, b"-", &pi_shell::bash::diag::strerror(&err), 2)
				})?;
				return Ok(Input { source, origin: Origin::Command, argv0, args: args.args.clone() });
			}
			// The engine reads the script from fd 0 a line at a time, as bash
			// does, so commands that read stdin get the lines that follow.
			Ok(Input { source: Vec::new(), origin: Origin::Stdin, argv0, args: args.args.clone() })
		},
	}
}

/// Write `bytes` to stdout (help, version and option listings).
fn print_out(bytes: &[u8]) -> u8 {
	let mut out = io::stdout().lock();
	u8::from(out.write_all(bytes).and_then(|()| out.flush()).is_err())
}

/// The process entry point: [`obash`]'s status, after flushing stdout (no
/// std runtime runs at exit). A panic reports as std's runtime would:
/// status 101.
#[cfg(not(test))]
#[unsafe(no_mangle)]
extern "C" fn main(
	_argc: std::ffi::c_int,
	_argv: *const *const std::ffi::c_char,
) -> std::ffi::c_int {
	let status = std::panic::catch_unwind(obash).unwrap_or(101);
	let _ = io::stdout().flush();
	std::ffi::c_int::from(status)
}

/// obash: the command line to an exit status.
fn obash() -> u8 {
	#[cfg(feature = "alloc-stats")]
	let _alloc_stats = alloc_stats::Report::from_env();
	let (clap_args, argv) = split_args(std::env::args_os().collect());
	// Without obash options (every benchmark and test run) the parse would
	// only rebuild clap's command to arrive at the defaults.
	let cli = if clap_args.len() == 1 {
		Cli::default()
	} else {
		Cli::parse_from(clap_args)
	};
	if cli.supported {
		println!("{}", serde_json::json!(SUPPORTED));
		return 0;
	}
	if let Some(path) = &cli.parse_corpus {
		return syntax::parse_corpus(path);
	}
	let args = match ShellArgs::parse(&argv) {
		Ok(args) => args,
		Err(err) => {
			let _ = io::stderr().write_all(&err.render(&argv[0]));
			return err.status() as u8;
		},
	};
	if args.help {
		return print_out(&invocation::help_text(&args.shell_name));
	}
	if args.version {
		return print_out(&invocation::version_text());
	}
	// bash lists the options and goes on: a failed write does not stop it.
	if let Some(text) = args.listing_text() {
		let _ = print_out(&text);
	}
	let env: Vec<(BString, BString)> = std::env::vars_os()
		.map(|(k, v)| (bytes(&k), bytes(&v)))
		.collect();
	let input = match input(&cli, &args, &env) {
		Ok(i) => i,
		Err(err) => {
			let _ = io::stderr().write_all(&err.text);
			return err.status;
		},
	};
	if cli.ir {
		return print_ir(&input);
	}
	if cli.print {
		return syntax::print(&input.source, &input.argv0, matches!(input.origin, Origin::Command));
	}
	if let Some(dialect) = cli.json {
		return syntax::json(&input.source, dialect);
	}
	// bash ignores `--pretty-print` for a `-c` command (it runs it).
	if args.pretty_print && !args.interactive && !matches!(args.input, invocation::Input::Command(_))
	{
		return syntax::pretty_print(&input.source, &input.argv0);
	}
	match run(&cli, &args, input, env) {
		Ok(status) => status as u8,
		Err(err) => {
			eprintln!("{}: {err}", args.shell_name);
			2
		},
	}
}

/// The new shell's initial state from bash's command line: `$0` and the
/// positional parameters, the options in bash's order, interactivity (`-i`,
/// or stdin and stderr on a terminal) and the startup files that exist
/// (unreadable ones are reported and skipped, as bash's
/// `maybe_execute_file` does).
fn shell_init(
	args: &ShellArgs,
	input: Input,
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
		Ok(files) => {
			for candidates in files {
				let Some(path) = candidates
					.into_iter()
					.find(|p| fs::metadata(os_path(p)).is_ok())
				else {
					continue;
				};
				match fs::read(os_path(&path)) {
					Ok(text) => startup.push((path, BString::from(text))),
					Err(err) => report(&path, pi_shell::bash::diag::strerror(&err).as_bytes()),
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
					(pi_shell::bash::store::OptId::Extdebug, true),
					(pi_shell::bash::store::OptId::Functrace, true),
					(pi_shell::bash::store::OptId::Errtrace, true),
				]);
			},
			Err(err) => {
				report(file.as_bytes(), pi_shell::bash::diag::strerror(&err).as_bytes());
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
	ShellInit {
		mode: args.mode,
		argv0: input.argv0,
		args: input.args,
		env,
		cwd,
		interactive,
		options,
		shell_pid: std::process::id(),
		startup,
	}
}

fn print_ir(input: &Input) -> u8 {
	let mut out = io::stdout().lock();
	for unit in ir::compile_all(&input.source, ModeId::Bash, Features::NONE) {
		if out.write_all(ir::asm::disasm(&unit).as_bytes()).is_err() {
			return 1;
		}
	}
	0
}

/// Run the shell; `env` is the process environment (taken once in `main`).
fn run(
	cli: &Cli,
	args: &ShellArgs,
	mut input: Input,
	mut env: Vec<(BString, BString)>,
) -> Result<i32, Box<dyn std::error::Error>> {
	let modes = EnvModes::from_env()?;
	// An `exec`-mode fault run re-executes obash with the continuation of
	// the shell it externalized.
	let resume = cli
		.fault
		.fault_resume
		.as_deref()
		.map(fault::Resume::decode)
		.transpose()?;
	let depth = resume.map_or(modes.fault.depth, |r| r.depth());
	let mut injector = fault::Injector::new(&cli.fault, modes.fault, depth, own_args(cli))?;
	// Before the process opens any fd of its own. A resumed process takes
	// none over: those of its first process are lost in the image.
	let inherited = if resume.is_some() {
		Vec::new()
	} else {
		host::inherited_fds()
	};
	let sink: Option<Box<dyn Write>> = match (cli.events, &cli.events_out) {
		(None, _) => None,
		(Some(EventsFormat::Jsonl), Some(path)) => {
			// A resumed process continues its predecessor's file.
			let file = if resume.is_some() {
				fs::OpenOptions::new()
					.create(true)
					.append(true)
					.open(path)?
			} else {
				fs::File::create(path)?
			};
			Some(Box::new(BufWriter::new(file)))
		},
		(Some(EventsFormat::Jsonl), None) => Some(Box::new(BufWriter::new(io::stderr()))),
	};
	let ignored = resume.map_or_else(host::ignored_on_entry, |r| r.ignored());
	let clock_ns = resume.map_or(0, |r| r.clock_ns());
	let mut host = NativeHost::new(sink, modes.pending_fs, inherited, ignored, clock_ns);
	let cfg = EngineConfig::default();
	let engine = Engine::new(cfg);
	if let Some(resume) = &resume {
		let mut store = injector.take_image(resume)?;
		let (mut shell, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)?;
		host.bind_signals(shell.control(), pi_shell::bash::Vpid(cfg.vpid_base));
		let mask = resume.mask();
		shell.set_event_mask(mask);
		injector.resumed(resume, &report.lost)?;
		let parts = fault::Parts { cfg, host, store, shell, run: resume.run(), mask };
		let status = injector.drive(parts);
		injector.finish();
		return Ok(status?);
	}
	let mut store = MemStore::new();
	let cwd = std::env::current_dir()
		.map_or_else(|_| BString::from("/"), |p| BString::from(p.as_os_str().as_encoded_bytes()));
	// Nested obash instances (`${THIS_SH}`) draw their own fault stream.
	env.retain(|(k, _)| k.as_slice() != fault::FAULT_DEPTH.as_bytes());
	env.push((BString::from(fault::FAULT_DEPTH), BString::from((depth + 1).to_string())));
	let source = std::mem::take(&mut input.source);
	let origin = std::mem::replace(&mut input.origin, Origin::Command);
	let init = shell_init(args, input, env, cwd);
	// Without an event sink nothing observes events: skip building them (each
	// one reads the clock).
	let mask = if cli.events.is_some() {
		EventMask::DEFAULT
	} else {
		EventMask::NONE
	};
	let mut shell = Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)?;
	host.bind_signals(shell.control(), pi_shell::bash::Vpid(cfg.vpid_base));
	shell.set_event_mask(mask);
	let run = shell.submit(Script { origin, ..Script::command(source) });
	let status = injector.drive(fault::Parts { cfg, host, store, shell, run, mask });
	injector.finish();
	Ok(status?)
}

/// obash's own options an `exec`-mode fault run passes to the process it
/// re-executes (the rest of the shell travels in the image).
fn own_args(cli: &Cli) -> Vec<OsString> {
	let mut args = Vec::new();
	if matches!(cli.events, Some(EventsFormat::Jsonl)) {
		args.push(OsString::from("--events=jsonl"));
	}
	if let Some(path) = &cli.events_out {
		let mut arg = OsString::from("--events-out=");
		arg.push(path);
		args.push(arg);
	}
	args
}

/// Test modes a conformance harness sets through the environment, so nested
/// `${THIS_SH}` invocations inherit them.
struct EnvModes {
	/// `PI_SHELL_FS=pending`: every fs op answers `Pending` first.
	pending_fs: bool,
	/// The fault injector's variables ([`fault::Env`]).
	fault:      fault::Env,
}

impl EnvModes {
	fn from_env() -> Result<Self, fault::FaultError> {
		Ok(Self {
			pending_fs: std::env::var_os("PI_SHELL_FS").is_some_and(|v| v == "pending"),
			fault:      fault::Env::from_env()?,
		})
	}
}
