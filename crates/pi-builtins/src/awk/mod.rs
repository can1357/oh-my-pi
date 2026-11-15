//! `awk` builtin: the POSIX AWK pattern scanning and processing language.
//!
//! Ported from GoAWK 1.32.0 (MIT) by Ben Hoyt: its lexer, recursive-descent
//! parser, resolver (scalar/array type inference across function calls) and
//! interpreter design, as a tree-walking interpreter over this crate's
//! [`Host`]. Semantics follow POSIX awk and onetrue-awk as GoAWK does,
//! including POSIX leftmost-longest regex matching.
//!
//! Usage: `awk [-F fs] [-v var=value]... [-f progfile]... ['prog'] [file | var=value]...`
//!
//! - `-F fs`: field separator (`t` is a tab; escapes are processed).
//! - `-v var=value`: assignment before `BEGIN` (escapes are processed).
//! - `-f progfile`: program text from a file (`-` is stdin); repeatable.
//! - `--` ends the options; operand `-` is stdin; `var=value` operands are
//!   assigned when reached in `ARGV`.
//!
//! The language is POSIX AWK plus gawk's `strftime([fmt[, ts[, utc]]])` and
//! `systime()`, `fflush`, `nextfile`, `delete array`, `**`, and a regex `RS`.
//! Commands (`system`, `print | cmd`, `cmd | getline`, `close`) are command
//! lines of the invoking shell, run in a subshell as `sh -c cmd` would, so
//! pi's builtins and `scheme://` paths work in them; output for `print | cmd`
//! is collected and fed to the command when it is closed (or at exit).

mod ast;
mod format;
mod interp;
mod io;
mod lexer;
mod parser;
mod regex;
mod resolve;
mod value;

#[cfg(test)]
mod tests;

use std::{
	ffi::OsString,
	io::{Read as _, Write as _},
};

use clap::Parser;

use self::{
	interp::{Interp, Setup, Stop},
	parser::ParseError,
};
use crate::host::{Host, INTERRUPTED_EXIT_CODE, SIGPIPE_EXIT_CODE, Utility, os_bytes_lossy, strip_errno};

const USAGE: &str = "usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]";

#[derive(Parser, Debug)]
#[command(
	name = "awk",
	version = "1.32.0",
	about = "Pattern scanning and processing language (POSIX AWK, ported from GoAWK).",
	override_usage = "awk [-F fs] [-v var=value]... [-f progfile]... ['prog'] [file | var=value]...",
	after_help = "Options:\n  -F fs           field separator (\"t\" means tab)\n  -v var=value    assign a variable before BEGIN\n  -f progfile     read the program from a file (repeatable)\n  --              end of options"
)]
pub(crate) struct Awk {
	/// Options, program and operands, parsed as awk does.
	#[arg(value_name = "ARGS", trailing_var_arg = true, allow_hyphen_values = true, num_args = 0..)]
	args: Vec<OsString>,
}

/// The command line, split as awk does.
#[derive(Debug, Default)]
struct Cli {
	fs:        Option<Vec<u8>>,
	assigns:   Vec<(String, Vec<u8>)>,
	progfiles: Vec<Vec<u8>>,
	program:   Option<Vec<u8>>,
	operands:  Vec<Vec<u8>>,
}

/// Splits awk's arguments: options until the program text, `--`, or `-`.
fn parse_cli(args: &[Vec<u8>]) -> Result<Cli, String> {
	let mut cli = Cli::default();
	let mut i = 0;
	while i < args.len() {
		let arg = &args[i];
		if arg == b"--" {
			i += 1;
			break;
		}
		if arg.len() < 2 || arg[0] != b'-' {
			break;
		}
		let flag = arg[1];
		if !matches!(flag, b'F' | b'v' | b'f') || arg.starts_with(b"--") {
			return Err(format!("unknown option {}", String::from_utf8_lossy(arg)));
		}
		let value = if arg.len() > 2 {
			arg[2..].to_vec()
		} else {
			i += 1;
			match args.get(i) {
				Some(value) => value.clone(),
				None => return Err(format!("option requires an argument -- {}", char::from(flag))),
			}
		};
		match flag {
			b'F' => cli.fs = Some(if value == b"t" { b"\t".to_vec() } else { lexer::unescape(&value) }),
			b'v' => match interp::split_assignment(&value) {
				Some(assign) => cli.assigns.push(assign),
				None => {
					return Err(format!(
						"invalid -v argument {:?}: expected var=value",
						String::from_utf8_lossy(&value)
					));
				},
			},
			_ => cli.progfiles.push(value),
		}
		i += 1;
	}
	if cli.progfiles.is_empty() {
		let Some(program) = args.get(i) else {
			return Err("no program given".to_owned());
		};
		cli.program = Some(program.clone());
		i += 1;
	}
	cli.operands = args[i..].to_vec();
	Ok(cli)
}

/// Program text and, per source, its display name and first line.
struct Source {
	text:  Vec<u8>,
	files: Vec<(String, usize)>,
}

impl Source {
	/// The source name and line within it for a line of the joined text.
	fn locate(&self, line: usize) -> (Option<&str>, usize) {
		match self.files.iter().rev().find(|(_, start)| *start <= line) {
			Some((name, start)) => (Some(name), line - start + 1),
			None => (None, line),
		}
	}

	fn line(&self, line: usize) -> &[u8] {
		self.text.split(|&b| b == b'\n').nth(line.saturating_sub(1)).unwrap_or_default()
	}
}

fn load_program(cli: &Cli, host: &mut Host) -> Result<Source, String> {
	if let Some(program) = &cli.program {
		return Ok(Source { text: program.clone(), files: Vec::new() });
	}
	let mut source = Source { text: Vec::new(), files: Vec::new() };
	for file in &cli.progfiles {
		let name = String::from_utf8_lossy(file).into_owned();
		let mut text = Vec::new();
		let read = if file == b"-" {
			host.stdin.read_to_end(&mut text).map(|_| ())
		} else {
			let path = std::path::PathBuf::from(interp::os_string(file));
			host.fs().open(host.resolve(&path)).and_then(|mut f| f.read_to_end(&mut text).map(|_| ()))
		};
		read.map_err(|err| format!("can't open file {name}: {}", strip_errno(&err)))?;
		let start = source.text.iter().filter(|&&b| b == b'\n').count() + 1;
		source.files.push((if file == b"-" { "<stdin>".to_owned() } else { name }, start));
		source.text.extend_from_slice(&text);
		source.text.push(b'\n');
	}
	Ok(source)
}

/// Reports a parse error with the offending source line and a caret.
fn report_parse_error(host: &mut Host, source: &Source, err: &ParseError) {
	let (file, line) = source.locate(err.pos.line);
	let place = match file {
		Some(file) => format!("{file}:{line}:{}", err.pos.col),
		None => format!("{line}:{}", err.pos.col),
	};
	let _ = writeln!(host.stderr, "awk: {place}: {}", err.message);
	let text = source.line(err.pos.line);
	if !text.is_empty() {
		let caret: String = text
			.iter()
			.take(err.pos.col.saturating_sub(1))
			.map(|&b| if b == b'\t' { '\t' } else { ' ' })
			.collect();
		let _ = writeln!(host.stderr, "    {}\n    {caret}^", String::from_utf8_lossy(text));
	}
}

impl Utility for Awk {
	const NAME: &'static str = "awk";
	const RUNS_COMMANDS: bool = true;
	const USAGE_ERROR: u8 = 2;

	/// Everything after `argv[0]` is awk's own syntax, except a leading
	/// `--help`/`-h`/`--version`/`-V`.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		let first = argv.get(1).and_then(|arg| arg.to_str());
		if !matches!(first, Some("--help" | "-h" | "--version" | "-V")) && argv.len() > 1 {
			argv.insert(1, OsString::from("--"));
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let args: Vec<Vec<u8>> = self.args.iter().map(|arg| os_bytes_lossy(arg).into_owned()).collect();
		let cli = match parse_cli(&args) {
			Ok(cli) => cli,
			Err(message) => {
				let _ = writeln!(host.stderr, "awk: {message}\n{USAGE}");
				return 2;
			},
		};
		let source = match load_program(&cli, host) {
			Ok(source) => source,
			Err(message) => {
				let _ = writeln!(host.stderr, "awk: {message}");
				return 2;
			},
		};
		let mut program = match parser::parse(&source.text) {
			Ok(program) => program,
			Err(err) => {
				report_parse_error(host, &source, &err);
				return 2;
			},
		};
		if let Err(err) = resolve::resolve(&mut program) {
			report_parse_error(host, &source, &err);
			return 2;
		}

		let mut argv = vec![b"awk".to_vec()];
		argv.extend(cli.operands);
		let setup = Setup { argv, fs: cli.fs, assigns: cli.assigns };
		let (stop, status) = match Interp::new(&program, host, setup) {
			Ok(mut interp) => {
				let result = interp.execute();
				let closed = interp.close_all();
				(result.err().or(closed.err()), interp.status())
			},
			Err(stop) => (Some(stop), 2),
		};
		match stop {
			None | Some(Stop::Exit | Stop::Next | Stop::NextFile) => status,
			Some(Stop::Error(message)) => {
				let _ = writeln!(host.stderr, "awk: {message}");
				2
			},
			Some(Stop::Cancelled) => INTERRUPTED_EXIT_CODE,
			Some(Stop::Quiet) => SIGPIPE_EXIT_CODE,
		}
	}
}
