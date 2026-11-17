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
//! --trace=PATH          write the run trace (the `ShellTrace` JSON the bash
//!                       tool's live view draws) to PATH at exit
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
mod syntax;

use std::{
	ffi::OsString,
	fs,
	io::{self, BufWriter, Write},
	path::PathBuf,
	sync::Arc,
};

use bstr::BString;
use clap::Parser;
use pi_shell::{
	bash::{
		Cx, Engine, EngineConfig, EventMask, EventSink, MemStore, ModeId, Origin, RestoreOpts,
		Script, Shell, ir, syntax::Features, trace::RunTrace,
	},
	process::{self, Input, Launch, NativeHost, ProcessOptions, Start},
};

/// The system allocator with counters for measurement.
#[cfg(feature = "alloc-stats")]
#[global_allocator]
static GLOBAL: alloc_stats::Counting = alloc_stats::Counting(std::alloc::System);

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
	/// Write the run trace (`ShellTrace` JSON) to PATH at exit.
	#[arg(long, value_name = "PATH")]
	trace:        Option<PathBuf>,
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
	"--trace",
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
	#[cfg(unix)]
	// SAFETY: `_exit` has no preconditions.
	unsafe {
		libc::_exit(status)
	}
	#[cfg(not(unix))]
	status
}

/// obash: the command line to an exit status. Without obash's own options
/// or test modes this is [`process::main`]; otherwise the test modes run on
/// the pieces it is made of.
fn obash() -> i32 {
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
		return i32::from(syntax::parse_corpus(path));
	}
	let modes = EnvModes::from_env();
	if !cli.testing() && modes.as_ref().is_ok_and(|m| !m.testing()) {
		return process::main(argv, ProcessOptions::default());
	}
	let whole_stdin = cli.print || cli.ir || cli.json.is_some();
	let mut launch = match process::start(&argv, whole_stdin) {
		Start::Run(launch) => launch,
		Start::Exit(status) => return status,
	};
	if cli.ir {
		return i32::from(print_ir(&launch.input));
	}
	if cli.print {
		let input = &launch.input;
		return i32::from(syntax::print(
			&input.source,
			&input.argv0,
			matches!(input.origin, Origin::Command),
		));
	}
	if let Some(dialect) = cli.json {
		return i32::from(syntax::json(&launch.input.source, dialect));
	}
	if let Some(status) = process::pretty_print_mode(&mut launch) {
		return status;
	}
	let name = launch.args.shell_name.clone();
	match modes
		.map_err(Into::into)
		.and_then(|modes| run(&cli, *launch, modes))
	{
		Ok(status) => status & 0xff,
		Err(err) => {
			eprintln!("{name}: {err}");
			2
		},
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

/// Run the shell under the test modes: events, fault injection, a pending
/// filesystem; `launch.env` is the process environment.
fn run(cli: &Cli, launch: Launch, modes: EnvModes) -> Result<i32, Box<dyn std::error::Error>> {
	let Launch { args, mut env, input } = launch;
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
		process::inherited_fds(false)
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
	let ignored = resume.map_or_else(process::ignored_on_entry, |r| r.ignored());
	let clock_ns = resume.map_or(0, |r| r.clock_ns());
	let mut host = NativeHost::new(sink, modes.pending_fs, inherited, ignored, clock_ns, false);
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
	// Nested obash instances (`${THIS_SH}`) draw their own fault stream.
	env.retain(|(k, _)| k.as_slice() != fault::FAULT_DEPTH.as_bytes());
	env.push((BString::from(fault::FAULT_DEPTH), BString::from((depth + 1).to_string())));
	let Input { source, origin, argv0, args: params } = input;
	let trace = cli
		.trace
		.as_ref()
		.map(|_| Arc::new(RunTrace::new(source.clone())));
	let init = process::shell_init(&args, argv0, params, env, process::current_dir());
	// Without an event sink nothing observes events: skip building them (each
	// one reads the clock).
	let mut mask = if cli.events.is_some() {
		EventMask::DEFAULT
	} else {
		EventMask::NONE
	};
	if let Some(trace) = &trace {
		mask = EventMask::from_bits(mask.bits() | trace.mask().bits());
		host.set_event_sink(Some(Arc::clone(trace) as Arc<dyn EventSink>));
	}
	let mut shell = Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)?;
	host.bind_signals(shell.control(), pi_shell::bash::Vpid(cfg.vpid_base));
	shell.set_event_mask(mask);
	let run = shell.submit(Script { origin, ..Script::command(source) });
	let status = injector.drive(fault::Parts { cfg, host, store, shell, run, mask });
	injector.finish();
	if let (Some(path), Some(trace)) = (&cli.trace, &trace) {
		fs::write(path, trace.snapshot_json())?;
	}
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

	/// Whether a test mode is on: a fault plan or the pending filesystem.
	const fn testing(&self) -> bool {
		self.pending_fs || self.fault.fault.is_some()
	}
}

impl Cli {
	/// Whether an obash option asks for more than the plain shell.
	const fn testing(&self) -> bool {
		self.events.is_some()
			|| self.events_out.is_some()
			|| self.trace.is_some()
			|| self.fault.fault.is_some()
			|| self.fault.fault_mode.is_some()
			|| self.fault.fault_resume.is_some()
			|| self.ir
			|| self.print
			|| self.json.is_some()
	}
}
