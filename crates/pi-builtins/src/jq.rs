//! `jq` builtin: jq 1.8.2's command-line JSON processor.
//!
//! The front end mirrors jq's `main.c`; the interpreter is jaq (`jaq-core`,
//! `jaq-std`, `jaq-json`), patched to jq's semantics.

use core::ops::ControlFlow;
use std::{
	cell::{Cell, RefCell},
	ffi::OsString,
	io::{self, BufRead, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use crate::openfile::OpenFile;
use clap::{ArgMatches, Command, CommandFactory, FromArgMatches, Parser, error::ErrorKind};
use jaq_json::Val;
use pi_vfs::BlockingFs;

use crate::host::{Host, Utility};

use cli::Cli;
use filter::FileReports;

/// Stack a `jq` invocation runs on. Evaluation, parsing, printing, comparing
/// and dropping values all recurse once per nesting level, and an overflow
/// kills the whole host process; the shell's 2 MiB worker stacks overflow on
/// a 2000-deep `tojson`. Only reserved: pages are committed as they are used.
const STACK: usize = 128 << 20;

/// Stack kept free below the deepest filter: [`filter::Kind`] fails a filter
/// rather than enter it with less left, so natives that recurse over a deep
/// value (`tojson` up to [`jaq_json::write::MAX_DEPTH`], `==`, `sort`,
/// dropping it) still fit under it.
const NATIVE_HEADROOM: usize = 32 << 20;

mod cli {
	//! Command-line argument parsing, as jq's `main`.
	use std::{ffi::OsString, path::PathBuf};

	/// Printed after a usage error, as jq's `die`.
	const DIE: &str = "Use jq --help for help with command-line options,\nor see the jq manpage, or online docs at https://jqlang.org\n";

	/// What the arguments ask for.
	pub enum Action {
		Run(Cli),
		/// `--run-tests`: the library paths given before it and the arguments
		/// after it.
		RunTests { library_path: Vec<PathBuf>, args: Vec<OsString> },
		/// Done while parsing (`--help`, `--version`, a usage error): what jq
		/// prints and its exit status.
		Exit { stdout: String, stderr: String, code: i32 },
	}

	/// Output layout, as jq's `JV_PRINT_PRETTY`/`JV_PRINT_TAB`/indent flags.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum Indent {
		Compact,
		Spaces(u8),
		Tab,
	}

	/// A named argument (`--arg` and friends); files are loaded after parsing.
	/// JSON texts are checked here and parsed when they are bound.
	pub enum Named {
		Str(String),
		Json(String),
		RawFile(OsString),
		SlurpFile(OsString),
	}

	/// A positional argument after `--args` or `--jsonargs`.
	pub enum Positional {
		Str(String),
		Json(String),
	}

	pub struct Cli {
		pub null_input:    bool,
		pub raw_input:     bool,
		pub slurp:         bool,
		/// `--seq`: inputs are RFC 7464 text sequences (an RS byte may
		/// separate values) and every output is prefixed with RS.
		pub seq:           bool,
		/// `--stream`: each input arrives as jq's stream of `[path, leaf]`
		/// and closing `[path]` events instead of whole values.
		pub stream:        bool,
		/// `--stream-errors`: `--stream`, and an input parse error becomes a
		/// final `[error message, path]` event instead of failing the run.
		pub stream_errors: bool,

		/// Strings print raw (`-r`, `-j`, `--raw-output0`).
		pub raw_output:        bool,
		/// No newline after an output (`-j`, `--raw-output0`).
		pub raw_no_lf:         bool,
		/// NUL after an output (`--raw-output0`).
		pub raw_output0:       bool,
		pub ascii_output:      bool,
		pub sort_keys:         bool,
		pub color_output:      bool,
		pub monochrome_output: bool,
		pub indent:            Indent,
		pub unbuffered:        bool,
		pub exit_status:       bool,

		pub from_file:    bool,
		pub library_path: Vec<PathBuf>,

		/// Named arguments in command-line order; the first of a name wins.
		pub named:      Vec<(String, Named)>,
		/// The program text, or with `from_file` its path.
		pub filter:     Option<Filter>,
		pub files:      Vec<PathBuf>,
		pub positional: Vec<Positional>,
	}

	pub enum Filter {
		Inline(String),
		FromFile(PathBuf),
	}

	/// The options jq knows, by their short or long spelling.
	#[derive(Clone, Copy)]
	enum Opt {
		Slurp,
		RawOutput,
		RawOutput0,
		JoinOutput,
		CompactOutput,
		ColorOutput,
		MonochromeOutput,
		AsciiOutput,
		Unbuffered,
		SortKeys,
		RawInput,
		NullInput,
		FromFile,
		LibraryPath,
		Binary,
		Tab,
		Indent,
		Seq,
		Stream,
		StreamErrors,
		ExitStatus,
		Args,
		JsonArgs,
		Arg,
		ArgJson,
		RawFile,
		SlurpFile,
		Debug,
		Help,
		Version,
		BuildConfiguration,
		RunTests,
	}

	impl Opt {
		fn short(c: char) -> Option<Self> {
			Some(match c {
				's' => Self::Slurp,
				'r' => Self::RawOutput,
				'j' => Self::JoinOutput,
				'c' => Self::CompactOutput,
				'C' => Self::ColorOutput,
				'M' => Self::MonochromeOutput,
				'a' => Self::AsciiOutput,
				'S' => Self::SortKeys,
				'R' => Self::RawInput,
				'n' => Self::NullInput,
				'f' => Self::FromFile,
				'L' => Self::LibraryPath,
				'b' => Self::Binary,
				'e' => Self::ExitStatus,
				'h' => Self::Help,
				'V' => Self::Version,
				_ => return None,
			})
		}

		fn long(s: &str) -> Option<Self> {
			Some(match s {
				"slurp" => Self::Slurp,
				"raw-output" => Self::RawOutput,
				"raw-output0" => Self::RawOutput0,
				"join-output" => Self::JoinOutput,
				"compact-output" => Self::CompactOutput,
				"color-output" => Self::ColorOutput,
				"monochrome-output" => Self::MonochromeOutput,
				"ascii-output" => Self::AsciiOutput,
				"unbuffered" => Self::Unbuffered,
				"sort-keys" => Self::SortKeys,
				"raw-input" => Self::RawInput,
				"null-input" => Self::NullInput,
				"from-file" => Self::FromFile,
				"library-path" => Self::LibraryPath,
				"binary" => Self::Binary,
				"tab" => Self::Tab,
				"indent" => Self::Indent,
				"seq" => Self::Seq,
				"stream" => Self::Stream,
				"stream-errors" => Self::StreamErrors,
				"exit-status" => Self::ExitStatus,
				"args" => Self::Args,
				"jsonargs" => Self::JsonArgs,
				"arg" => Self::Arg,
				"argjson" => Self::ArgJson,
				"rawfile" => Self::RawFile,
				"slurpfile" => Self::SlurpFile,
				"debug-dump-disasm" | "debug-trace=all" | "debug-trace" => Self::Debug,
				"help" => Self::Help,
				"version" => Self::Version,
				"build-configuration" => Self::BuildConfiguration,
				"run-tests" => Self::RunTests,
				_ => return None,
			})
		}
	}

	/// How positional arguments after the program are taken.
	enum Mode {
		Files,
		Strings,
		Json,
	}

	/// A usage error: `message`, then jq's `die` hint, status 2.
	fn die(message: impl Into<String>) -> Action {
		let mut stderr = message.into();
		stderr.push_str(DIE);
		Action::Exit { stdout: String::new(), stderr, code: 2 }
	}

	/// `text` as one JSON text, if it is one, as jq's `jv_parse`.
	fn json(text: &OsString) -> Option<String> {
		let text = text.to_string_lossy();
		jaq_json::read::parse_single(text.as_bytes()).is_ok().then(|| text.into_owned())
	}

	/// Whether jq takes `arg` for options rather than a positional argument,
	/// as jq's `isoptish`: `-` alone, `-1` or `-.` are positional.
	fn is_optish(arg: &[u8]) -> bool {
		matches!(arg, [b'-', b'-', ..]) || matches!(arg, [b'-', c, ..] if c.is_ascii_alphabetic())
	}

	impl Cli {
		fn has_named(&self, name: &str) -> bool {
			self.named.iter().any(|(n, _)| n == name)
		}

		/// Parses `argv` (`argv[0]` is the command name) as jq's `main` does,
		/// option by option, so the first problem met is the one reported.
		pub fn parse(argv: Vec<OsString>) -> Action {
			let mut cli = Self {
				null_input:        false,
				raw_input:         false,
				slurp:             false,
				seq:               false,
				stream:            false,
				stream_errors:     false,
				raw_output:        false,
				raw_no_lf:         false,
				raw_output0:       false,
				ascii_output:      false,
				sort_keys:         false,
				color_output:      false,
				monochrome_output: false,
				indent:            Indent::Spaces(2),
				unbuffered:        false,
				exit_status:       false,
				from_file:         false,
				library_path:      Vec::new(),
				named:             Vec::new(),
				filter:            None,
				files:             Vec::new(),
				positional:        Vec::new(),
			};
			let mut program: Option<&OsString> = None;
			let mut mode = Mode::Files;
			let mut args_done = false;
			let argc = argv.len();
			let mut i = 1;
			while i < argc {
				let arg = &argv[i];
				let bytes = arg.as_encoded_bytes();
				if args_done || !is_optish(bytes) {
					if program.is_none() {
						program = Some(arg);
					} else {
						match mode {
							Mode::Strings => cli.positional.push(Positional::Str(arg.to_string_lossy().into_owned())),
							Mode::Json => match json(arg) {
								Some(text) => cli.positional.push(Positional::Json(text)),
								None => return die("jq: invalid JSON text passed to --jsonargs\n"),
							},
							Mode::Files => cli.files.push(arg.into()),
						}
					}
					i += 1;
					continue;
				}
				if bytes == b"--" {
					args_done = true;
					i += 1;
					continue;
				}
				let text = arg.to_string_lossy();
				let (mut text, is_short) = match text.strip_prefix("--") {
					Some(long) => (long, false),
					None => (&text[1..], true),
				};
				// a long option in one step, or a cluster of short ones
				while !text.is_empty() {
					let opt = if is_short {
						let c = text.chars().next().expect("not empty");
						let Some(opt) = Opt::short(c) else {
							return die(format!("jq: Unknown option -{c}\n"));
						};
						text = &text[c.len_utf8()..];
						opt
					} else {
						let Some(opt) = Opt::long(text) else {
							return die(format!("jq: Unknown option --{text}\n"));
						};
						text = "";
						opt
					};
					// the two arguments after option `i`, if there are two
					let pair = |name: &str, what: &str| {
						if i + 2 < argc {
							Ok((argv[i + 1].to_string_lossy().into_owned(), &argv[i + 2]))
						} else {
							Err(die(format!("jq: --{name} takes two parameters (e.g. --{name} varname {what})\n")))
						}
					};
					match opt {
						Opt::Slurp => cli.slurp = true,
						Opt::RawOutput => cli.raw_output = true,
						Opt::RawOutput0 => (cli.raw_output, cli.raw_no_lf, cli.raw_output0) = (true, true, true),
						Opt::JoinOutput => (cli.raw_output, cli.raw_no_lf) = (true, true),
						Opt::CompactOutput => cli.indent = Indent::Compact,
						Opt::ColorOutput => cli.color_output = true,
						Opt::MonochromeOutput => cli.monochrome_output = true,
						Opt::AsciiOutput => cli.ascii_output = true,
						Opt::Unbuffered => cli.unbuffered = true,
						Opt::SortKeys => cli.sort_keys = true,
						Opt::RawInput => cli.raw_input = true,
						Opt::NullInput => cli.null_input = true,
						Opt::FromFile => cli.from_file = true,
						Opt::LibraryPath => {
							if !text.is_empty() {
								cli.library_path.push(PathBuf::from(text));
								text = "";
							} else if i + 1 >= argc {
								return die("-L takes a parameter: (e.g. -L /search/path or -L/search/path)\n");
							} else {
								cli.library_path.push(PathBuf::from(&argv[i + 1]));
								i += 1;
							}
						},
						Opt::Binary | Opt::Debug => {},
						Opt::Tab => cli.indent = Indent::Tab,
						Opt::Indent => {
							if i + 1 >= argc {
								return die("jq: --indent takes one parameter\n");
							}
							cli.indent = match parse_indent(argv[i + 1].as_encoded_bytes()) {
								Some(-1) => Indent::Tab,
								Some(n) => Indent::Spaces(n as u8),
								None => return die("jq: --indent takes a number between -1 and 7\n"),
							};
							i += 1;
						},
						Opt::Seq => cli.seq = true,
						Opt::Stream => cli.stream = true,
						Opt::StreamErrors => (cli.stream, cli.stream_errors) = (true, true),
						Opt::ExitStatus => cli.exit_status = true,
						Opt::Args => mode = Mode::Strings,
						Opt::JsonArgs => mode = Mode::Json,
						Opt::Arg => {
							let (name, value) = match pair("arg", "value") {
								Ok(pair) => pair,
								Err(action) => return action,
							};
							if !cli.has_named(&name) {
								let value = Named::Str(value.to_string_lossy().into_owned());
								cli.named.push((name, value));
							}
							i += 2;
						},
						Opt::ArgJson => {
							let (name, text) = match pair("argjson", "text") {
								Ok(pair) => pair,
								Err(action) => return action,
							};
							if !cli.has_named(&name) {
								let Some(text) = json(text) else {
									return die("jq: invalid JSON text passed to --argjson\n");
								};
								cli.named.push((name, Named::Json(text)));
							}
							i += 2;
						},
						Opt::RawFile | Opt::SlurpFile => {
							let raw = matches!(opt, Opt::RawFile);
							let which = if raw { "rawfile" } else { "slurpfile" };
							let (name, path) = match pair(which, "filename") {
								Ok(pair) => pair,
								Err(action) => return action,
							};
							if !cli.has_named(&name) {
								let path = path.clone();
								let file = if raw { Named::RawFile(path) } else { Named::SlurpFile(path) };
								cli.named.push((name, file));
							}
							i += 2;
						},
						Opt::Help => {
							let stdout = include_str!("jq-help.txt").to_owned();
							return Action::Exit { stdout, stderr: String::new(), code: 0 };
						},
						Opt::Version => {
							let stdout = format!("jq-{}\n", super::VERSION);
							return Action::Exit { stdout, stderr: String::new(), code: 0 };
						},
						Opt::BuildConfiguration => {
							let stdout = format!("{}\n", super::BUILD_CONFIGURATION);
							return Action::Exit { stdout, stderr: String::new(), code: 0 };
						},
						Opt::RunTests => {
							let args = argv[i + 1..].to_vec();
							return Action::RunTests { library_path: cli.library_path, args };
						},
					}
				}
				i += 1;
			}
			// `-f` makes the program a file name wherever it is given
			cli.filter = program.map(|program| {
				if cli.from_file {
					Filter::FromFile(program.into())
				} else {
					Filter::Inline(program.to_string_lossy().into_owned())
				}
			});
			Action::Run(cli)
		}

		/// Whether output is colored, as jq's `main`: on a terminal unless
		/// `NO_COLOR` is set and not empty; `-C` forces it and `-M` wins.
		pub fn color(&self, terminal: bool, no_color: Option<&str>) -> bool {
			let tty = terminal && no_color.is_none_or(str::is_empty);
			(tty || self.color_output) && !self.monochrome_output
		}
	}

	/// The `--indent` value, as jq's check of `strtol`: an integer from -1
	/// to 7, without leading space or trailing text.
	fn parse_indent(text: &[u8]) -> Option<i8> {
		let digits = match text {
			[b'+' | b'-', rest @ ..] => rest,
			_ => text,
		};
		if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
			return None;
		}
		let n: i64 = core::str::from_utf8(text).ok()?.parse().ok()?;
		(-1..=7).contains(&n).then_some(n as i8)
	}

	/// The usage text jq prints when it has no program, as its `usage(2, 1)`.
	pub fn short_usage() -> &'static str {
		let help = include_str!("jq-help.txt");
		&help[..help.find("Command options:\n").expect("help lists the options")]
	}

	pub const SHORT_USAGE_HINT: &str = "For listing the command options, use jq --help.\n";
}

mod filter {
	//! Filter parsing, compilation, and execution.
	use core::fmt::{self, Display, Formatter};
	use std::{
		io,
		path::{Path, PathBuf},
	};

	use jaq_core::{
		Ctx, DataT, Error as CoreError, Exn, RunPtr, Vars, box_iter::box_once, compile, data, load,
		native,
	};
	use jaq_std::{
		ValT as _,
		input::{self, Inputs, RcIter},
	};
	use pi_vfs::BlockingFs;

	use super::{Error, Session, Val, output, read};

	pub type Filter = jaq_core::Filter<Kind>;

	/// Data kind of the builtin's filters: jaq-json values, with natives
	/// reaching the invocation through [`Data`].
	pub struct Kind;

	impl DataT for Kind {
		type Data<'a> = &'a Data<'a>;
		type V<'a> = Val;

		const CHECK_CANCELLATION: bool = true;

		fn cancelled(data: &Self::Data<'_>) -> bool {
			data.session.cancelled()
		}

		fn may_recurse(_data: &Self::Data<'_>) -> bool {
			stacker::remaining_stack().is_none_or(|left| left >= super::NATIVE_HEADROOM)
		}
	}

	/// What natives see while a filter runs.
	pub struct Data<'a> {
		lut:     &'a jaq_core::Lut<Kind>,
		inputs:  Inputs<'a, Val>,
		session: &'a Session,
		linker:  &'a Linker,
	}

	impl<'a> data::HasLut<'a, Kind> for &'a Data<'a> {
		fn lut(&self) -> &'a jaq_core::Lut<Kind> {
			self.lut
		}
	}

	impl<'a> input::HasInputs<'a, Val> for &'a Data<'a> {
		fn inputs(&self) -> Inputs<'a, Val> {
			self.inputs
		}
	}

	/// jq builtins that jaq lacks or defines differently, written in jq.
	/// Appended to the prelude, so they shadow jaq's definitions.
	const DEFS: &str = r#"
def tonumber: tonumber_;
"#;

	/// Natives that reach the invocation's session or its inputs, or format
	/// tables. Listed first: the compiler binds a call to the first native
	/// with a matching name and arity.
	///
	/// - `env`: the shell's exported environment, not the host process's.
	/// - `debug`, `stderr`, `halt_error`: write to the shell's stderr as jq's
	///   `debug_cb`/`stderr_cb` and its `halt_error` handling in `main`.
	/// - `input_filename`, `input_line_number`: the position of the current
	///   input, which jq's front end tracks and jaq's library cannot.
	/// - `tonumber_`, behind `tonumber`: accepts exactly one number literal,
	///   like jq; jaq's parses any JSON text, so `"1 2"` yields two numbers and
	///   `"+1"` prints `+1`.
	/// - `@csv`, `@tsv`: jq's `f_format` for tables.
	fn natives() -> [native::Filter<RunPtr<Kind>>; 9] {
		[
			("env", native::v(0), |cv| box_once(Ok(cv.0.data().session.env.clone()))),
			("debug", native::v(0), |cv| {
				let done = cv.0.data().session.debug(&cv.1);
				box_once(done.map(|()| cv.1).map_err(Exn::from))
			}),
			("stderr", native::v(0), |cv| {
				let session = cv.0.data().session;
				let done = match &cv.1 {
					Val::TStr(s) | Val::BStr(s) => Ok(session.write_stderr(s)),
					v => message(v).map(|json| session.write_stderr(&json)),
				};
				box_once(done.map(|()| cv.1).map_err(Exn::from))
			}),
			("halt_error", native::v(1), |mut cv| {
				let session = cv.0.data().session;
				let code = cv.0.pop_var();
				let Some(code) = code.as_f64() else {
					let e = jaq_json::msg::type_error(&cv.1, "halt_error/1: number required");
					return box_once(Err(Exn::from(e)));
				};
				let done = match &cv.1 {
					Val::Null => Ok(()),
					Val::TStr(s) | Val::BStr(s) => Ok(session.write_stderr(s)),
					v => message(v).map(|mut json| {
						json.push(b'\n');
						session.write_stderr(&json);
					}),
				};
				// C's conversion of the exit code to `int`
				box_once(Err(done.map_or_else(Exn::from, |()| Exn::halt(code as i32))))
			}),
			("input_filename", native::v(0), |cv| {
				box_once(Ok(cv.0.data().session.input.filename.borrow().clone()))
			}),
			("input_line_number", native::v(0), |cv| {
				box_once(Ok(Val::from(cv.0.data().session.input.lines.get())))
			}),
			("tonumber_", native::v(0), |cv| box_once(tonumber(cv.1).map_err(Exn::from))),
			("@csv", native::v(0), |cv| box_once(table_row(&cv.1, true))),
			("@tsv", native::v(0), |cv| box_once(table_row(&cv.1, false))),
		]
	}

	/// `v` as jq writes it in messages: compact JSON.
	fn message(v: &Val) -> Result<Vec<u8>, CoreError<Val>> {
		let mut buf = Vec::new();
		output::Printer::compact().write(&mut buf, v).map_err(|e| match e {
			output::WriteError::Key(key) => jaq_json::msg::object_key(&key),
			output::WriteError::Io(e) => CoreError::str(e),
		})?;
		Ok(buf)
	}

	/// jq's `f_tonumber`: numbers pass through; a string must be exactly one
	/// number literal as decNumber reads it (no whitespace, no NUL).
	fn tonumber(v: Val) -> Result<Val, CoreError<Val>> {
		let num = match &v {
			Val::Num(_) => return Ok(v),
			Val::TStr(s) | Val::BStr(s) if !s.contains(&0) => jaq_json::read::number(s),
			_ => None,
		};
		num.map(Val::Num)
			.ok_or_else(|| jaq_json::msg::type_error(&v, "cannot be parsed as a number"))
	}

	/// jq's `@csv` and `@tsv` (`f_format`): arrays of scalars; null and NaN
	/// are empty fields.
	fn table_row<'a>(v: &Val, csv: bool) -> jaq_core::ValX<'a, Val> {
		use jaq_json::msg::type_error;
		let Val::Arr(row) = v else {
			let msg = if csv { "cannot be csv-formatted, only array" } else { "cannot be tsv-formatted, only array" };
			return Err(type_error(v, msg).into());
		};
		let mut buf = Vec::new();
		for (i, field) in row.iter().enumerate() {
			if i != 0 {
				buf.push(if csv { b',' } else { b'\t' });
			}
			match field {
				Val::Null => {},
				Val::Num(_) if field.as_f64().is_some_and(f64::is_nan) => {},
				Val::TStr(s) | Val::BStr(s) => {
					// jq's `escape_string`, which also writes NUL as `\0`
					if csv {
						buf.push(b'"');
					}
					for byte in s.iter() {
						match byte {
							0 => buf.extend_from_slice(b"\\0"),
							b'"' if csv => buf.extend_from_slice(b"\"\""),
							b'\t' if !csv => buf.extend_from_slice(b"\\t"),
							b'\n' if !csv => buf.extend_from_slice(b"\\n"),
							b'\r' if !csv => buf.extend_from_slice(b"\\r"),
							b'\\' if !csv => buf.extend_from_slice(b"\\\\"),
							byte => buf.push(*byte),
						}
					}
					if csv {
						buf.push(b'"');
					}
				},
				Val::Bool(_) | Val::Num(_) => buf.extend(message(field)?),
				Val::Arr(_) | Val::Obj(_) => return Err(type_error(field, "is not valid in a csv row").into()),
			}
		}
		Ok(Val::utf8_str(buf))
	}

	/// A compiled filter, the values of the data files it imports, and where
	/// its modules were searched.
	pub struct Program {
		pub vals:   Vec<Val>,
		pub filter: Filter,
		linker:     Linker,
	}

	/// Where modules are searched, as jq's linker (`src/linker.c`) needs it,
	/// also at runtime for `modulemeta` and `get_search_list`.
	#[derive(Clone)]
	struct Linker {
		fs:       BlockingFs,
		/// `-L` paths, or jq's default search list, unexpanded
		lib_dirs: Vec<PathBuf>,
		/// directory of the program file, or the working directory (`PROGRAM_ORIGIN`)
		origin:   PathBuf,
	}

	pub fn parse_compile(
		fs: &BlockingFs,
		path: &PathBuf,
		code: &str,
		vars: &[String],
		paths: &[PathBuf],
	) -> Result<Program, Vec<FileReports>> {
		use compile::Compiler;
		use load::{Arena, Const, File, Loader, import};

		let default = ["~/.jq", "$ORIGIN/../lib/jq", "$ORIGIN/../lib"].map(PathBuf::from);
		let lib_dirs = if paths.is_empty() { &default[..] } else { paths };
		let origin = pi_vfs::parent_path(path).filter(|p| !p.as_os_str().is_empty());
		let origin = origin.unwrap_or(Path::new("."));
		let origin = fs.canonicalize(origin).unwrap_or_else(|_| origin.to_path_buf());
		let linker = Linker { fs: fs.clone(), lib_dirs: lib_dirs.to_vec(), origin };

		let vars: Vec<_> = vars.iter().map(|v| format!("${v}")).collect();
		let arena = Arena::default();
		let ours = load::parse(DEFS, |p| p.defs()).expect("builtin definitions parse");
		let mut defs: Vec<_> = jaq_core::defs()
			.chain(jaq_std::defs())
			.chain(jaq_json::defs())
			.chain(ours)
			.collect();
		let read = |import: load::Import<PathBuf>| -> Result<File<String, PathBuf>, String> {
			let path = find_import(&linker, &import, ".jq")?;
			let code = fs.read_to_string(&path).map_err(|e| e.to_string())?;
			Ok(File { code, path })
		};
		let run = native::run::<Kind>;
		let inputs = input::funs::<Kind>().into_vec().into_iter().map(run);
		let funs: Vec<_> = natives()
			.into_iter()
			.chain(linker_natives())
			.map(run)
			.chain(jaq_core::funs())
			.chain(jaq_std::funs())
			.chain(jaq_json::funs())
			.chain(inputs)
			.collect();
		// `builtins` lists every filter a program can call, as `name/arity`,
		// except those that jq hides behind an underscore
		let mut builtins: Vec<String> = Vec::new();
		let sigs = defs.iter().map(|d| (d.name, d.args.len())).chain(funs.iter().map(|f| (f.0, f.1.len())));
		for (name, arity) in sigs {
			let sig = format!("{name}/{arity}");
			if name.starts_with(char::is_alphabetic) && !builtins.contains(&sig) {
				builtins.push(sig);
			}
		}
		builtins.push("builtins/0".into());
		let builtins = format!("def builtins: {};", Const::Arr(builtins.into_iter().map(Const::Str).collect()).dump());
		defs.extend(load::parse(arena.alloc(builtins), |p| p.defs()).expect("builtins parse"));
		let mut loader = Loader::new(defs).with_read(read);
		// jq includes `~/.jq` if it is a file, ignoring it if it cannot be loaded
		if let Some(home) = home() {
			let home = Const::Str(home.to_string_lossy().into_owned());
			let meta = Const::Obj(Vec::from([("optional".into(), Const::Bool(true)), ("search".into(), home)]));
			loader = loader.with_implicit_include("", meta);
		}
		let main = File { path: path.clone(), code };
		let modules = loader.load(&arena, main).map_err(|e| load_errors(e, path))?;

		let mut vals = Vec::new();
		import(&modules, |p| {
			let path = find_import(&linker, &p, ".json")?;
			let data = read::json_array(fs, &path);
			vals.push(data.map_err(|e| format!("jq: error loading data file {}: {e}", path.display()))?);
			Ok(())
		})
		.map_err(|e| load_errors(e, path))?;

		let compiler = Compiler::default()
			.with_funs(funs)
			.with_global_vars(vars.iter().map(|v| &**v));
		let filter = compiler.compile(modules).map_err(|e| compile_errors(e, path))?;
		Ok(Program { vals, filter, linker })
	}

	/// Natives that need the linker: jq's `modulemeta`, `get_search_list`,
	/// `get_prog_origin` and `get_jq_origin` (`src/builtin.c`).
	fn linker_natives() -> [native::Filter<RunPtr<Kind>>; 4] {
		[
			("get_search_list", native::v(0), |cv| {
				box_once(Ok(cv.0.data().linker.lib_dirs.iter().map(|p| path_val(p)).collect()))
			}),
			("get_prog_origin", native::v(0), |cv| box_once(Ok(path_val(&cv.0.data().linker.origin)))),
			("get_jq_origin", native::v(0), |_| {
				box_once(Ok(jq_origin().map_or(Val::Null, |p| path_val(&p))))
			}),
			("modulemeta", native::v(0), |cv| {
				box_once(module_meta(cv.0.data().linker, &cv.1).map_err(Exn::from))
			}),
		]
	}

	fn path_val(p: &Path) -> Val {
		Val::from(p.to_string_lossy().into_owned())
	}

	/// jq's `load_module_meta`: the metadata, imports and definitions of the
	/// module that the input names, searched in the library directories.
	fn module_meta(linker: &Linker, name: &Val) -> Result<Val, CoreError<Val>> {
		use load::Const;
		let (Val::TStr(name) | Val::BStr(name)) = name else {
			return Err(CoreError::str("modulemeta input module name must be a string"));
		};
		let name = String::from_utf8_lossy(name);
		let rel = validate_relpath(&name).map_err(CoreError::str)?;
		let path = find_lib(linker, rel, linker.lib_dirs.iter().map(|p| Some(p.as_path())), None, ".jq")
			.map_err(CoreError::str)?;
		let Ok(code) = linker.fs.read_to_string(&path) else { return Ok(Val::Null) };
		let fname = path.to_string_lossy();
		let Ok(meta) = load::module_meta(&code, &fname) else { return Ok(Val::Null) };

		let set = |kvs: &mut Vec<(String, Const)>, k: &str, v: Const| match kvs.iter_mut().find(|(k_, _)| k_ == k) {
			Some(kv) => kv.1 = v,
			None => kvs.push((k.into(), v)),
		};
		let mut obj = match meta.meta {
			Some(Const::Obj(kvs)) => kvs,
			_ => Vec::new(),
		};
		let deps = meta.deps.into_iter().map(|dep| {
			let mut kvs = match dep.meta {
				Some(Const::Obj(kvs)) => kvs,
				_ => Vec::new(),
			};
			let data = dep.name.is_some_and(|n| n.starts_with('$'));
			if let Some(name) = dep.name {
				set(&mut kvs, "as", Const::Str(name.trim_start_matches('$').into()));
			}
			set(&mut kvs, "is_data", Const::Bool(data));
			set(&mut kvs, "relpath", Const::Str(dep.path));
			Const::Obj(kvs)
		});
		set(&mut obj, "deps", Const::Arr(deps.collect()));
		set(&mut obj, "defs", Const::Arr(meta.defs.into_iter().map(Const::Str).collect()));
		jaq_json::read::parse_single(Const::Obj(obj).dump().as_bytes()).map_err(|e| CoreError::str(e.to_string()))
	}

	fn home() -> Option<PathBuf> {
		#[cfg(target_os = "windows")]
		let home = "USERPROFILE";
		#[cfg(not(target_os = "windows"))]
		let home = "HOME";
		std::env::var_os(home).map(PathBuf::from)
	}

	/// Directory of the jq executable (`JQ_ORIGIN`).
	fn jq_origin() -> Option<PathBuf> {
		std::env::current_exe().ok()?.parent().map(PathBuf::from)
	}

	/// Check a module name as jq's `validate_relpath`.
	fn validate_relpath(name: &str) -> Result<&str, String> {
		if name.contains('\\') {
			return Err(format!("Modules must be named by relative paths using '/', not '\\' ({name})"));
		}
		let components: Vec<_> = name.split('/').collect();
		if components.contains(&"..") {
			return Err(format!("Relative paths to modules may not traverse to parent directories ({name})"));
		}
		if components.windows(2).any(|w| w[0] == w[1]) {
			return Err(format!("module names must not have equal consecutive components: {name}"));
		}
		Ok(name)
	}

	/// Resolve an import or include, as jq's `process_dependencies`: modules are
	/// searched in the directories of the directive's `search` metadata, else in
	/// `.` and the library directories.
	fn find_import(linker: &Linker, import: &load::Import<PathBuf>, ext: &str) -> Result<PathBuf, String> {
		use load::Const;
		let rel = validate_relpath(import.path)?;
		let lib_origin = if import.main {
			linker.origin.clone()
		} else {
			pi_vfs::parent_path(import.parent).map_or_else(|| PathBuf::from("."), Path::to_path_buf)
		};
		let search = import.meta.as_ref().and_then(|m| m.get("search"));
		let dirs: Vec<Option<&Path>> = match search {
			None => core::iter::once(Path::new(".")).chain(linker.lib_dirs.iter().map(|p| p.as_path())).map(Some).collect(),
			Some(Const::Arr(items)) => items.iter().map(|i| expand_dir(i)).collect(),
			Some(item) => Vec::from([expand_dir(item)]),
		};
		find_lib(linker, rel, dirs.into_iter(), Some(&lib_origin), ext)
	}

	/// A search directory of `search` metadata; non-strings are skipped.
	fn expand_dir(c: &load::Const) -> Option<&Path> {
		match c {
			load::Const::Str(s) => Some(Path::new(s.as_str())),
			_ => None,
		}
	}

	/// Find a module file in search directories, as jq's `find_lib`: for each
	/// directory, `<dir>/<rel><ext>`, `<dir>/<rel>/jq/main<ext>`, and
	/// `<dir>/<rel>/<basename of rel><ext>`.
	fn find_lib<'p>(
		linker: &Linker,
		rel: &str,
		dirs: impl Iterator<Item = Option<&'p Path>>,
		lib_origin: Option<&Path>,
		ext: &str,
	) -> Result<PathBuf, String> {
		let base = rel.rfind('/').map_or(rel, |i| &rel[i..]);
		for dir in dirs.flatten() {
			let Some(dir) = expand_prefix(dir, lib_origin) else { continue };
			let candidates = [format!("{rel}{ext}"), format!("{rel}/jq/main{ext}"), format!("{rel}/{base}{ext}")];
			for candidate in candidates {
				let path = PathBuf::from(format!("{}/{candidate}", dir.display()));
				if let Ok(found) = linker.fs.canonicalize(&path) {
					return Ok(found);
				}
			}
		}
		Err(format!("module not found: {rel}"))
	}

	/// Expand a search directory as jq's `build_lib_search_chain`: `~/` is the
	/// home directory, `$ORIGIN/` the directory of jq, `.` stays the working
	/// directory, and other relative paths are relative to `lib_origin`.
	fn expand_prefix(dir: &Path, lib_origin: Option<&Path>) -> Option<PathBuf> {
		let s = dir.to_str()?;
		if s.is_empty() {
			return None;
		}
		if let Some(rest) = s.strip_prefix("~/") {
			return Some(home()?.join(rest));
		}
		if s == "." {
			return Some(dir.to_path_buf());
		}
		if let Some(rest) = s.strip_prefix("$ORIGIN/") {
			return Some(jq_origin()?.join(rest));
		}
		match lib_origin {
			Some(origin) if dir.is_relative() => Some(PathBuf::from(format!("{}/{s}", origin.display()))),
			_ => Some(dir.to_path_buf()),
		}
	}

	/// Runs a filter on every input (or once on `null`) as jq's `main` loop:
	/// `process` gets the outputs of each input and may stop the run, and
	/// `parse_error` each input that failed to parse. `stop` is checked before
	/// each input is read (jq's `jq_util_input_errors`). Returns a read
	/// failure other than a parse error, which ends the run.
	///
	/// This function cannot return an `Iterator` because it creates an `RcIter`.
	pub(crate) fn run(
		null_input: bool,
		program: &Program,
		vars: &[Val],
		session: &Session,
		iter: impl Iterator<Item = io::Result<Val>>,
		stop: impl Fn() -> bool,
		mut process: impl FnMut(&mut dyn Iterator<Item = Result<Val, Error>>) -> core::ops::ControlFlow<()>,
		mut parse_error: impl FnMut(&str) -> core::ops::ControlFlow<()>,
	) -> Option<io::Error> {
		// jaq's input stream carries errors as text; keep a read failure aside
		// so it ends the run, also when it reached the filter through `input`
		let read_error = core::cell::Cell::new(None);
		let iter = RcIter::new(iter.map(|r| {
			r.map_err(|e| {
				let message = e.to_string();
				if e.kind() != io::ErrorKind::InvalidData {
					read_error.set(Some(e));
				}
				message
			})
		}));
		let filter = &program.filter;
		let data = Data { lut: &filter.lut, inputs: &iter, session, linker: &program.linker };
		let ctx = Ctx::<Kind>::new(&data, Vars::new(vars.iter().cloned()));
		let mut run = |input| {
			let outputs = filter.id.run((ctx.clone(), input)).map(|r| r.map_err(Error::from));
			process(&mut outputs.take_while(|_| !session.cancelled()))
		};

		if null_input {
			let _ = run(Val::Null);
			return read_error.take();
		}
		let mut inputs = data.inputs;
		while !stop() && !session.cancelled() {
			let Some(item) = inputs.next() else { break };
			let flow = match item {
				Ok(input) => run(input),
				Err(message) => match read_error.take() {
					Some(e) => return Some(e),
					None => parse_error(&message),
				},
			};
			if flow.is_break() {
				break;
			}
		}
		read_error.take()
	}

	/// The compile errors of one file, displayed as jq reports them, one
	/// `jq: error: ...` message each, without the closing error count.
	#[derive(Debug)]
	pub struct FileReports {
		/// `<top-level>` for the main program, else the module's path
		name:    String,
		code:    String,
		reports: Vec<Report>,
	}

	impl Display for FileReports {
		fn fmt(&self, f: &mut Formatter) -> fmt::Result {
			for report in &self.reports {
				let Some(range) = &report.span else {
					// linker messages such as `jq: error loading data file ...` come complete
					if report.blank && report.message.starts_with("jq: ") {
						writeln!(f, "{}", report.message)?;
					} else {
						writeln!(f, "jq: error: {}", report.message)?;
					}
					if report.blank {
						writeln!(f)?;
					}
					continue;
				};
				// as jq's `locfile_locate`
				let code = self.code.as_bytes();
				let start = range.start.min(code.len());
				let offset = memchr::memrchr(b'\n', &code[..start]).map_or(0, |i| i + 1);
				let line_end = memchr::memchr(b'\n', &code[start..]).map_or(code.len(), |i| start + i);
				let line = memchr::memchr_iter(b'\n', &code[..start]).count() + 1;
				let end = range.end.min(line_end.max(start + 1)).max(start);
				let text = String::from_utf8_lossy(&code[offset..line_end]);
				writeln!(
					f,
					"jq: error: {} at {}, line {line}, column {}:\n    {text}\n    {}{}",
					report.message,
					self.name,
					start - offset + 1,
					" ".repeat(start - offset),
					"^".repeat(end - start),
				)?;
			}
			Ok(())
		}
	}

	#[derive(Debug)]
	struct Report {
		message: String,
		/// location in the file, `None` for errors that jq reports without one
		span:    Option<core::ops::Range<usize>>,
		/// followed by an empty line, as jq's linker errors are
		blank:   bool,
	}

	fn file_reports(file: load::File<&str, PathBuf>, main: &Path, reports: Vec<Report>) -> FileReports {
		let name = if file.path == main { "<top-level>".into() } else { file.path.display().to_string() };
		FileReports { name, code: file.code.into(), reports }
	}

	fn load_errors(errs: load::Errors<&str, PathBuf>, main: &Path) -> Vec<FileReports> {
		use load::Error;

		let errs = errs.into_iter().map(|(file, err)| {
			let reports = match err {
				Error::Io(errs) => {
					let io = |(_, message)| Report { message, span: None, blank: true };
					errs.into_iter().map(io).collect()
				},
				Error::Parse(errs) => {
					let parse = |(message, span): load::parse::Error| Report {
						message,
						span: span.map(|(start, end)| start..end),
						blank: false,
					};
					errs.into_iter().map(parse).collect()
				},
			};
			file_reports(file, main, reports)
		});
		errs.collect()
	}

	fn compile_errors(errs: compile::Errors<&str, PathBuf>, main: &Path) -> Vec<FileReports> {
		let errs = errs.into_iter().map(|(file, errs)| {
			let code = file.code;
			let report = |(at, message)| Report { message, span: Some(load::span(code, at)), blank: false };
			let reports = errs.into_iter().map(report).collect();
			file_reports(file, main, reports)
		});
		errs.collect()
	}
}

mod read {
	use std::{
		cell::{Cell, RefCell},
		io::{self, BufRead, Read},
		path::Path,
		rc::Rc,
	};

	use jaq_json::read::{Flags, Parser, utf8};
	use pi_vfs::BlockingFs;

	use super::{Cli, Val};

	/// Read a whole file through the injected filesystem into owned bytes.
	///
	/// Never memory-mapped: jq runs inside the host process, where a concurrent
	/// truncation of a mapped file would SIGBUS the whole host.
	pub fn load_file(fs: &BlockingFs, path: &Path) -> io::Result<Vec<u8>> {
		let mut bytes = Vec::new();
		fs.open(path)?.read_to_end(&mut bytes)?;
		Ok(bytes)
	}

	pub fn invalid_data(e: impl std::error::Error + Send + Sync + 'static) -> std::io::Error {
		io::Error::new(io::ErrorKind::InvalidData, e)
	}

	/// The values of a JSON file as one array (`--slurpfile`, data modules),
	/// read like jq's `jv_load_file`; a parse error's text is jq's message.
	pub fn json_array(fs: &BlockingFs, path: &Path) -> io::Result<Val> {
		let bytes = load_file(fs, path)?;
		let vals = jaq_json::read::parse_file(&bytes).map_err(invalid_data)?;
		Ok(Val::Arr(vals.into()))
	}

	/// A file's text (`--rawfile`), invalid UTF-8 replaced like jq's `jv_load_file`.
	pub fn raw_file(fs: &BlockingFs, path: &Path) -> io::Result<Val> {
		Ok(Val::utf8_str(utf8::lossy(load_file(fs, path)?)))
	}

	pub type Vals<'a> = Box<dyn Iterator<Item = io::Result<Val>> + 'a>;

	/// The contents of a file operand, as [`load_file`] returns them.
	pub type Loaded = Vec<u8>;

	/// Where the current input came from, for `input_filename` and
	/// `input_line_number`. Updated by the input stream as it reads.
	#[derive(Default)]
	pub struct Position {
		/// The file operand as given, `"<stdin>"`, or `null` before any input.
		pub filename: RefCell<Val>,
		/// Newline-terminated lines of that input read so far.
		pub lines:    Rc<Cell<usize>>,
	}

	impl Position {
		fn enter(&self, name: Val) {
			self.filename.replace(name);
			self.lines.set(0);
		}
	}

	/// Input values read from stdin, which is only read as values are asked
	/// for.
	pub fn stdin<'a>(cli: &Cli, read: impl BufRead + 'a, pos: &'a Position) -> Vals<'a> {
		let read: Source<'a> = Box::new(read);
		let name = Val::from(String::from("<stdin>"));
		Box::new(Inputs::new(cli, Box::new(core::iter::once((name, read))), pos))
	}

	/// Input values read from the file operands, which jq treats as one stream:
	/// `input` reads across files, a value may even continue from one file into
	/// the next, and `-s` slurps all of them into one value. `files` yields each
	/// operand when the stream reaches it, and its contents are dropped once read.
	pub fn files<'a>(
		cli: &Cli,
		files: impl Iterator<Item = (Val, Loaded)> + 'a,
		pos: &'a Position,
	) -> Vals<'a> {
		let files = files.map(|(name, bytes)| (name, Box::new(io::Cursor::new(bytes)) as Source<'a>));
		Box::new(Inputs::new(cli, Box::new(files), pos))
	}

	type Source<'a> = Box<dyn BufRead + 'a>;

	/// Most bytes one `fgets` call of jq reads (its buffer of 4096 bytes keeps
	/// room for a UTF-8 sequence and the NUL).
	const GETS_MAX: usize = 4096 - 4 - 1;

	/// Read the next chunk of input into `buf` like jq's
	/// `jq_util_input_read_more`: a line, or [`GETS_MAX`] bytes completed to a
	/// whole UTF-8 sequence. Returns whether the chunk ends a line and whether
	/// reading hit the end of input.
	fn gets(read: &mut dyn BufRead, buf: &mut Vec<u8>) -> io::Result<(bool, bool)> {
		fn fill(read: &mut dyn BufRead) -> io::Result<&[u8]> {
			loop {
				match read.fill_buf() {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					// reborrow to return the buffer out of the loop
					Ok(_) => return read.fill_buf(),
					Err(e) => return Err(e),
				}
			}
		}
		loop {
			let available = fill(read)?;
			if available.is_empty() {
				return Ok((false, true));
			}
			let available = &available[..available.len().min(GETS_MAX - buf.len())];
			if let Some(i) = memchr::memchr(b'\n', available) {
				buf.extend_from_slice(&available[..=i]);
				read.consume(i + 1);
				return Ok((true, false));
			}
			let n = available.len();
			buf.extend_from_slice(available);
			read.consume(n);
			if buf.len() == GETS_MAX {
				break;
			}
		}
		let mut missing = utf8::missing_bytes(buf).unwrap_or(0);
		while missing > 0 {
			let available = fill(read)?;
			if available.is_empty() {
				return Ok((false, true));
			}
			let n = available.len().min(missing);
			buf.extend_from_slice(&available[..n]);
			read.consume(n);
			missing -= n;
		}
		Ok((false, false))
	}

	/// The operands, read one after another in chunks.
	struct Reader<'a> {
		files:   Box<dyn Iterator<Item = (Val, Source<'a>)> + 'a>,
		current: Option<Source<'a>>,
		at_eof:  bool,
		buf:     Vec<u8>,
		pos:     &'a Position,
	}

	impl Reader<'_> {
		/// Read the next chunk into `buf`, moving on to the next operand at the
		/// end of one; returns whether all input is read
		/// (`jq_util_input_read_more`).
		fn read_more(&mut self) -> io::Result<bool> {
			if self.current.is_none() || self.at_eof {
				self.current = None;
				if let Some((name, read)) = self.files.next() {
					self.pos.enter(name);
					self.current = Some(read);
					self.at_eof = false;
				}
			}
			self.buf.clear();
			if let Some(read) = &mut self.current {
				let (newline, eof) = gets(read, &mut self.buf)?;
				self.at_eof = eof;
				if newline {
					self.pos.lines.update(|n| n + 1);
				}
			}
			Ok(self.current.is_none())
		}
	}

	/// What `-s` collects.
	enum Slurped {
		Text(Vec<u8>),
		Values(Vec<Val>),
	}

	/// jq's input state (`jq_util_input_state`, src/util.c): one parser for
	/// all operands, or none for `-R`.
	struct Inputs<'a> {
		reader:  Reader<'a>,
		parser:  Option<Parser>,
		slurped: Option<Slurped>,
	}

	impl<'a> Inputs<'a> {
		fn new(
			cli: &Cli,
			files: Box<dyn Iterator<Item = (Val, Source<'a>)> + 'a>,
			pos: &'a Position,
		) -> Self {
			let flags = Flags {
				seq:           cli.seq,
				stream:        cli.stream || cli.stream_errors,
				stream_errors: cli.stream_errors,
			};
			let slurped = cli.slurp.then(|| {
				if cli.raw_input { Slurped::Text(Vec::new()) } else { Slurped::Values(Vec::new()) }
			});
			Self {
				reader: Reader { files, current: None, at_eof: false, buf: Vec::new(), pos },
				parser: (!cli.raw_input).then(|| Parser::new(flags)),
				slurped,
			}
		}
	}

	impl Iterator for Inputs<'_> {
		type Item = io::Result<Val>;

		/// The next input value or parse error (`jq_util_input_next_input`).
		/// A parse error is `InvalidData` displaying jq's message; reading goes
		/// on after it like jq's: with `--seq` after the bad text, else from the
		/// next chunk.
		fn next(&mut self) -> Option<Self::Item> {
			let mut is_last = false;
			let mut line: Option<Vec<u8>> = None;
			loop {
				if let Some(parser) = &mut self.parser {
					if parser.remaining() == 0 {
						is_last = match self.reader.read_more() {
							Ok(is_last) => is_last,
							Err(e) => return Some(Err(e)),
						};
						parser.set_buf(&self.reader.buf, !is_last);
					}
					match parser.next(&self.reader.buf) {
						Some(Ok(v)) => match &mut self.slurped {
							Some(Slurped::Values(vals)) => vals.push(v),
							_ => return Some(Ok(v)),
						},
						Some(Err(e)) => return Some(Err(invalid_data(e))),
						None => {},
					}
				} else {
					is_last = match self.reader.read_more() {
						Ok(is_last) => is_last,
						Err(e) => return Some(Err(e)),
					};
					let buf = &self.reader.buf;
					match &mut self.slurped {
						Some(Slurped::Text(text)) => utf8::push_lossy(text, buf),
						_ if buf.is_empty() => {},
						_ => {
							let line = line.get_or_insert_with(Vec::new);
							if let Some(whole) = buf.strip_suffix(b"\n") {
								utf8::push_lossy(line, whole);
								return Some(Ok(Val::utf8_str(core::mem::take(line))));
							}
							utf8::push_lossy(line, buf);
						},
					}
				}
				if is_last {
					break;
				}
			}
			match self.slurped.take() {
				Some(Slurped::Text(text)) => Some(Ok(Val::utf8_str(text))),
				Some(Slurped::Values(vals)) => Some(Ok(Val::Arr(vals.into()))),
				None => line.map(|line| Ok(Val::utf8_str(line))),
			}
		}
	}
}

mod output {
	//! Values written as jq's `jv_dump_term` writes them.
	use std::io::{self, Write};

	use jaq_json::{Num, Val, write::write_str};

	use super::cli::{Cli, Indent};

	/// Why a value could not be written.
	pub enum WriteError {
		Io(io::Error),
		/// An object key that is not a string, which JSON cannot express.
		Key(Val),
	}

	impl From<io::Error> for WriteError {
		fn from(e: io::Error) -> Self {
			Self::Io(e)
		}
	}

	/// jq 1.8.2's `DEFAULT_COLORS` (jv_print.c), indexed like its `colors`:
	/// null, false, true, numbers, strings, arrays, objects, object keys.
	const DEFAULT_COLORS: [&str; 8] = ["0;90", "0;39", "0;39", "0;39", "0;32", "1;39", "1;39", "1;34"];
	const COLRESET: &[u8] = b"\x1b[0m";

	/// The escape sequences that start each color, as jq's `colors` table.
	pub struct Colors([Box<[u8]>; 8]);

	fn escape(code: &[u8]) -> Box<[u8]> {
		[b"\x1b[", code, b"m"].concat().into_boxed_slice()
	}

	impl Default for Colors {
		fn default() -> Self {
			Self(DEFAULT_COLORS.map(|code| escape(code.as_bytes())))
		}
	}

	impl Colors {
		/// `JQ_COLORS` over the defaults, as jq's `jq_set_colors`: up to eight
		/// `:`-separated codes of digits and `;`. `None` when it is invalid.
		pub fn parse(spec: Option<&str>) -> Option<Self> {
			let mut colors = Self::default();
			let Some(spec) = spec else { return Some(colors) };
			let s = spec.as_bytes();
			// where each code starts, then one past the end of the last
			let mut codes = Vec::with_capacity(9);
			let mut pos = 0;
			loop {
				codes.push(pos);
				pos += s[pos..].iter().take_while(|c| c.is_ascii_digit() || **c == b';').count();
				if pos == s.len() || codes.len() >= colors.0.len() {
					break;
				}
				if s[pos] != b':' {
					return None;
				}
				pos += 1;
			}
			// an empty last code is ignored
			if codes.last() != Some(&pos) {
				codes.push(pos + 1);
			} else if codes.len() == 1 {
				return Some(colors);
			}
			for (color, code) in colors.0.iter_mut().zip(codes.windows(2)) {
				*color = escape(&s[code[0]..code[1] - 1]);
			}
			Some(colors)
		}

		fn of(&self, v: &Val) -> &[u8] {
			let kind = match v {
				Val::Null => 0,
				Val::Bool(false) => 1,
				Val::Bool(true) => 2,
				Val::Num(_) => 3,
				Val::TStr(_) | Val::BStr(_) => 4,
				Val::Arr(_) => 5,
				Val::Obj(_) => 6,
			};
			&self.0[kind]
		}

		fn field(&self) -> &[u8] {
			&self.0[7]
		}
	}

	/// jq's dump flags: layout, `-S`, `-a` and colors.
	pub struct Printer {
		indent:    Indent,
		sort_keys: bool,
		ascii:     bool,
		colors:    Option<Colors>,
	}

	impl Printer {
		pub const fn new(indent: Indent, sort_keys: bool, ascii: bool, colors: Option<Colors>) -> Self {
			Self { indent, sort_keys, ascii, colors }
		}

		/// Compact and uncolored, as `jv_dump_string(v, 0)`, for messages.
		pub const fn compact() -> Self {
			Self::new(Indent::Compact, false, false, None)
		}

		/// These flags without `JV_PRINT_PRETTY`, as jq's `debug_cb`.
		pub fn flat(&self) -> Self {
			let colors = self.colors.as_ref().map(|c| Colors(c.0.clone()));
			Self::new(Indent::Compact, self.sort_keys, self.ascii, colors)
		}

		/// Writes `v`, failing on an object key that JSON cannot express.
		pub fn write<W: Write + ?Sized>(&self, w: &mut W, v: &Val) -> Result<(), WriteError> {
			self.dump(w, v, 0)
		}

		fn newline<W: Write + ?Sized>(&self, w: &mut W, level: usize) -> io::Result<()> {
			match self.indent {
				Indent::Compact => Ok(()),
				Indent::Tab => {
					w.write_all(b"\n")?;
					(0..level).try_for_each(|_| w.write_all(b"\t"))
				},
				Indent::Spaces(n) => {
					w.write_all(b"\n")?;
					(0..level * usize::from(n)).try_for_each(|_| w.write_all(b" "))
				},
			}
		}

		/// As jq's `jv_dump_term`, escape sequences included.
		fn dump<W: Write + ?Sized>(&self, w: &mut W, v: &Val, level: usize) -> Result<(), WriteError> {
			let color = self.colors.as_ref().map(|colors| colors.of(v));
			let paint = |w: &mut W, bytes: &[u8]| -> io::Result<()> {
				if let Some(color) = color {
					w.write_all(color)?;
				}
				w.write_all(bytes)
			};
			let reset = |w: &mut W| if color.is_some() { w.write_all(COLRESET) } else { Ok(()) };
			if let Some(color) = color {
				w.write_all(color)?;
			}
			if level > jaq_json::write::MAX_DEPTH {
				w.write_all(jaq_json::write::TOO_DEEP.as_bytes())?;
			} else {
				match v {
					Val::Null => w.write_all(b"null")?,
					Val::Bool(b) => w.write_all(if *b { b"true" } else { b"false" })?,
					Val::Num(Num::Float(x)) if x.is_nan() => self.dump(w, &Val::Null, level)?,
					Val::Num(n) => write!(w, "{n}")?,
					Val::TStr(s) | Val::BStr(s) => write_str(w, s, self.ascii)?,
					Val::Arr(a) if a.is_empty() => w.write_all(b"[]")?,
					Val::Arr(a) => {
						w.write_all(b"[")?;
						for (i, x) in a.iter().enumerate() {
							if i != 0 {
								paint(w, b",")?;
							}
							reset(w)?;
							self.newline(w, level + 1)?;
							self.dump(w, x, level + 1)?;
						}
						self.newline(w, level)?;
						paint(w, b"]")?;
					},
					Val::Obj(o) if o.is_empty() => w.write_all(b"{}")?,
					Val::Obj(o) => {
						w.write_all(b"{")?;
						let entry = |w: &mut W, i: usize, k: &Val, v: &Val| -> Result<(), WriteError> {
							let (Val::TStr(k) | Val::BStr(k)) = k else {
								return Err(WriteError::Key(k.clone()));
							};
							if i != 0 {
								paint(w, b",")?;
							}
							reset(w)?;
							self.newline(w, level + 1)?;
							if let Some(colors) = &self.colors {
								w.write_all(colors.field())?;
							}
							write_str(w, k, self.ascii)?;
							reset(w)?;
							paint(w, b":")?;
							reset(w)?;
							if self.indent != Indent::Compact {
								w.write_all(b" ")?;
							}
							self.dump(w, v, level + 1)
						};
						if self.sort_keys {
							// jq's `jv_keys`: byte order
							fn bytes(k: &Val) -> &[u8] {
								match k {
									Val::TStr(k) | Val::BStr(k) => k,
									_ => &[],
								}
							}
							let mut entries: Vec<_> = o.iter().collect();
							entries.sort_by(|(a, _), (b, _)| bytes(a).cmp(bytes(b)));
							for (i, (k, v)) in entries.into_iter().enumerate() {
								entry(w, i, k, v)?;
							}
						} else {
							for (i, (k, v)) in o.iter().enumerate() {
								entry(w, i, k, v)?;
							}
						}
						self.newline(w, level)?;
						paint(w, b"}")?;
					},
				}
			}
			Ok(reset(w)?)
		}
	}

	/// What printing an output failed with.
	pub enum PrintError {
		Io(io::Error),
		/// An error jq raises for the input: a string with NUL under
		/// `--raw-output0`, or a non-string object key.
		Raised(jaq_core::Error<Val>),
	}

	/// How outputs are printed, as jq's `process`.
	pub struct Output {
		pub printer: Printer,
		raw:         bool,
		no_lf:       bool,
		nul:         bool,
		seq:         bool,
		ascii:       bool,
		unbuffered:  bool,
	}

	impl Output {
		pub const fn new(cli: &Cli, printer: Printer) -> Self {
			Self {
				printer,
				raw: cli.raw_output,
				no_lf: cli.raw_no_lf,
				nul: cli.raw_output0,
				seq: cli.seq,
				ascii: cli.ascii_output,
				unbuffered: cli.unbuffered,
			}
		}

		/// Prints one output with a single write, rendered into `buf` first;
		/// returns jq's status for it: 0, or -1 for `null` and `false`.
		pub fn print(&self, buf: &mut Vec<u8>, w: &mut dyn Write, v: &Val) -> Result<i32, PrintError> {
			buf.clear();
			let status = match v {
				Val::TStr(s) | Val::BStr(s) if self.raw => {
					if self.ascii {
						write_str(buf, s, true).map_err(PrintError::Io)?;
					} else if self.nul && s.contains(&0) {
						let msg = "Cannot dump a string containing NUL with --raw-output0 option";
						return Err(PrintError::Raised(jaq_core::Error::str(msg)));
					} else {
						buf.extend_from_slice(s);
					}
					0
				},
				_ => {
					if self.seq {
						buf.push(0x1e);
					}
					self.printer.write(buf, v).map_err(|e| match e {
						WriteError::Io(e) => PrintError::Io(e),
						WriteError::Key(key) => PrintError::Raised(jaq_json::msg::object_key(&key)),
					})?;
					if matches!(v, Val::Null | Val::Bool(false)) { -1 } else { 0 }
				},
			};
			if !self.no_lf {
				buf.push(b'\n');
			}
			if self.nul {
				buf.push(0);
			}
			w.write_all(buf).map_err(PrintError::Io)?;
			if self.unbuffered {
				w.flush().map_err(PrintError::Io)?;
			}
			Ok(status)
		}
	}
}

/// jq release this front end follows; `--version` reports it.
const VERSION: &str = "1.8.2";

/// What jq 1.8.2 reports for `--build-configuration` and
/// `$JQ_BUILD_CONFIGURATION`: the configuration of the reference build.
const BUILD_CONFIGURATION: &str = "--disable-debug --disable-dependency-tracking --prefix=/opt/homebrew/Cellar/jq/1.8.2 --libdir=/opt/homebrew/Cellar/jq/1.8.2/lib --disable-silent-rules --disable-maintainer-mode CC=clang";

/// jq's process statuses (main.c); negative ones exit 0 without `-e`.
const JQ_OK: i32 = 0;
const JQ_OK_NULL_KIND: i32 = -1;
const JQ_ERROR_SYSTEM: i32 = 2;
const JQ_ERROR_COMPILE: i32 = 3;
const JQ_OK_NO_OUTPUT: i32 = -4;
const JQ_ERROR_UNKNOWN: i32 = 5;

/// Parsed `jq` invocation.
pub(crate) struct Jq {
	action: cli::Action,
}

impl FromArgMatches for Jq {
	fn from_arg_matches(_matches: &ArgMatches) -> Result<Self, clap::Error> {
		Err(clap::Error::raw(
			ErrorKind::InvalidValue,
			"jq uses its order-preserving argument parser",
		))
	}

	fn update_from_arg_matches(
		&mut self,
		_matches: &ArgMatches,
	) -> Result<(), clap::Error> {
		Err(clap::Error::raw(
			ErrorKind::InvalidValue,
			"jq uses its order-preserving argument parser",
		))
	}
}

impl CommandFactory for Jq {
	fn command() -> Command {
		Command::new("jq")
			.version(VERSION)
			.about(include_str!("jq-help.txt"))
			.help_template("{about}\n")
	}

	fn command_for_update() -> Command {
		Self::command()
	}
}

impl Parser for Jq {
	/// Never fails: jq reports its own usage errors, so they are carried
	/// to [`Utility::run`].
	fn try_parse_from<I, T>(itr: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = T>,
		T: Into<OsString> + Clone,
	{
		Ok(Self { action: Cli::parse(itr.into_iter().map(Into::into).collect()) })
	}
}

impl Utility for Jq {
	const NAME: &'static str = "jq";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		// Everything that holds a value stays inside: dropping a deep value
		// recurses too.
		stacker::grow(STACK, || match self.action {
			cli::Action::Exit { stdout, stderr, code } => {
				let _ = host.stdout.write_all(stdout.as_bytes());
				let _ = host.stderr.write_all(stderr.as_bytes());
				code
			},
			cli::Action::RunTests { library_path, args } => {
				let library_path: Vec<_> = library_path.iter().map(|path| host.resolve(path)).collect();
				run_tests(host, &library_path, &args)
			},
			cli::Action::Run(mut cli) => {
				for path in &mut cli.library_path {
					*path = host.resolve(&*path);
				}
				let session = Session::new(host);
				let colors = output::Colors::parse(host.var("JQ_COLORS")).unwrap_or_else(|| {
					session.write_stderr(b"Failed to set $JQ_COLORS\n");
					output::Colors::default()
				});
				let color = cli.color(host.stdout.is_terminal(), host.var("NO_COLOR"));
				let printer = output::Printer::new(
					cli.indent,
					cli.sort_keys,
					cli.ascii_output,
					color.then_some(colors),
				);
				let session = Session { debug: printer.flat(), ..session };

				// as jq: `.` when either end is not a terminal
				if cli.filter.is_none()
					&& !cli.from_file
					&& !(host.stdout.is_terminal() && host.stdin.file().is_terminal())
				{
					cli.filter = Some(cli::Filter::Inline(".".into()));
				}
				if cli.filter.is_none() {
					session.write_stderr(cli::short_usage().as_bytes());
					session.write_stderr(cli::SHORT_USAGE_HINT.as_bytes());
					return JQ_ERROR_SYSTEM;
				}

				let out = output::Output::new(&cli, printer);
				let mut stdout = host.stdout_writer();
				let (ret, exit_status) = real_main(&cli, host, &mut stdout, &out, &session);
				// as jq's `jq_exit_with_status` and `jq_exit`, through `exit(3)`
				let code = if exit_status { ret.abs() } else { ret.max(0) };
				code & 0xff
			},
		})
	}
}

/// Per-invocation state that natives read: the shell's exported environment
/// and stderr, its cancellation flag, and the position of the current input.
struct Session {
	env:            Val,
	stderr:         RefCell<OpenFile>,
	cancel:         Arc<AtomicBool>,
	reported_error: Option<Arc<AtomicBool>>,
	input:          read::Position,
	/// How `debug` dumps its messages.
	debug:          output::Printer,
	/// Whether what the program writes to stderr is dropped, as under
	/// `--run-tests`, which installs no callbacks for it.
	quiet:          bool,
}

impl Session {
	fn new(host: &Host) -> Self {
		let env = host
			.env()
			.map(|(key, value)| (Val::from(key.to_owned()), Val::from(value.to_owned())));
		Self {
			env:            Val::obj(env.collect()),
			stderr:         RefCell::new(host.stderr_clone()),
			cancel:         host.cancel_flag(),
			reported_error: host.reported_error_flag(),
			input:          read::Position::default(),
			debug:          output::Printer::compact(),
			quiet:          false,
		}
	}

	fn cancelled(&self) -> bool {
		self.cancel.load(Ordering::Relaxed)
	}

	/// Writes what the program sends to stderr.
	fn write_stderr(&self, bytes: &[u8]) {
		if !self.quiet {
			self.report(bytes);
		}
	}

	/// Writes a message of jq itself to stderr.
	fn report(&self, bytes: &[u8]) {
		let _ = self.stderr.borrow_mut().write_all(bytes);
	}

	/// Writes `["DEBUG:",v]` and a newline, as jq's `debug_cb`: with the
	/// output's flags except pretty-printing.
	fn debug(&self, v: &Val) -> Result<(), jaq_core::Error<Val>> {
		let mut line = Vec::new();
		let msg = Val::from_iter([Val::from(String::from("DEBUG:")), v.clone()]);
		self.debug.write(&mut line, &msg).map_err(|e| match e {
			output::WriteError::Key(key) => jaq_json::msg::object_key(&key),
			output::WriteError::Io(e) => jaq_core::Error::str(e),
		})?;
		line.push(b'\n');
		self.write_stderr(&line);
		Ok(())
	}

	/// Where the current input came from, as jq's
	/// `jq_util_input_get_position`: `<file>:<lines read>`, or `<unknown>`
	/// before any input.
	fn position(&self) -> String {
		match &*self.input.filename.borrow() {
			Val::TStr(name) | Val::BStr(name) => {
				format!("{}:{}", String::from_utf8_lossy(name), self.input.lines.get())
			},
			_ => String::from("<unknown>"),
		}
	}

	/// Reports an uncaught error as jq's `process` does.
	fn report_uncaught(&self, error: jaq_core::Error<Val>) {
		let at = self.position();
		let line = match error.into_val() {
			Val::TStr(msg) | Val::BStr(msg) => {
				// printed with `%s`: up to a NUL
				let msg = msg.split(|b| *b == 0).next().unwrap_or_default();
				[format!("jq: error (at {at}): ").as_bytes(), msg, b"\n"].concat()
			},
			v => format!("jq: error (at {at}) (not a string): {}\n", dump(&v)).into_bytes(),
		};
		self.write_stderr(&line);
	}

	/// Tells the shell an error was reported that the exit status hides.
	fn report_error(&self) {
		if let Some(flag) = &self.reported_error {
			flag.store(true, Ordering::Relaxed);
		}
	}
}

/// `v` as `jv_dump_string(v, 0)`.
fn dump(v: &Val) -> String {
	let mut buf = Vec::new();
	match output::Printer::compact().write(&mut buf, v) {
		Ok(()) => String::from_utf8_lossy(&buf).into_owned(),
		Err(_) => v.to_string(),
	}
}

/// `strerror` text of `e`.
fn strerror(e: &io::Error) -> String {
	match e.kind() {
		_ if e.raw_os_error().is_some() => crate::host::strip_errno(e),
		io::ErrorKind::NotFound => "No such file or directory".into(),
		io::ErrorKind::PermissionDenied => "Permission denied".into(),
		io::ErrorKind::IsADirectory => "Is a directory".into(),
		io::ErrorKind::NotADirectory => "Not a directory".into(),
		_ => crate::host::strip_errno(e),
	}
}

/// Why jq's `jv_load_file` could not load `name`.
fn load_error(name: &str, e: &io::Error) -> String {
	match e.kind() {
		io::ErrorKind::InvalidData => e.to_string(),
		io::ErrorKind::IsADirectory => format!("Could not open {name}: It's a directory"),
		_ => format!("Could not open {name}: {}", strerror(e)),
	}
}

/// The run of a program after its arguments are parsed, as jq's `main`;
/// returns jq's status and whether `-e` maps it.
fn real_main(
	cli: &Cli,
	host: &mut Host,
	stdout: &mut dyn Write,
	out: &output::Output,
	session: &Session,
) -> (i32, bool) {
	let fs = host.fs().clone();
	let (vars, mut ctx): (Vec<String>, Vec<Val>) = match binds(cli, &fs, host, &session.env) {
		Ok(binds) => binds.into_iter().unzip(),
		Err(msg) => {
			session.write_stderr(msg.as_bytes());
			return (JQ_ERROR_SYSTEM, cli.exit_status);
		},
	};

	let (path, code) = match cli.filter.as_ref().expect("a program") {
		cli::Filter::FromFile(name) => {
			let shown = name.display().to_string();
			let code = match read::load_file(&fs, &host.resolve(name)) {
				Ok(code) => code,
				Err(e) => {
					session.write_stderr(format!("jq: {}\n", load_error(&shown, &e)).as_bytes());
					return (JQ_ERROR_SYSTEM, cli.exit_status);
				},
			};
			if code.contains(&0) {
				session.write_stderr(b"jq: program file contains NUL bytes\n");
				return (JQ_ERROR_SYSTEM, cli.exit_status);
			}
			(host.resolve(name), String::from_utf8_lossy(&code).into_owned())
		},
		cli::Filter::Inline(filter) => (PathBuf::from("<inline>"), filter.clone()),
	};
	let mut program = match filter::parse_compile(&fs, &path, &code, &vars, &cli.library_path) {
		Ok(program) => program,
		Err(reports) => {
			session.write_stderr(compile_errors(&reports).as_bytes());
			return (JQ_ERROR_COMPILE, cli.exit_status);
		},
	};
	ctx.append(&mut program.vals);

	let ret = Cell::new(JQ_OK_NO_OUTPUT);
	// -1: no output yet, 0: the last was `null` or `false`, 1: another
	let mut last_result = -1;
	let mut write_error = None;
	let mut reported = false;
	let mut buf = Vec::new();
	let mut process = |outputs: &mut dyn Iterator<Item = Result<Val, Error>>| {
		match process(outputs, out, &mut buf, stdout, session) {
			Ok(Processed { status, halted, raised }) => {
				reported |= raised;
				ret.set(status);
				if status <= 0 && status != JQ_OK_NO_OUTPUT {
					last_result = i32::from(status != JQ_OK_NULL_KIND);
				}
				if halted { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
			},
			Err(e) => {
				write_error = Some(e);
				ControlFlow::Break(())
			},
		}
	};
	// `--seq` makes parse errors not fatal
	let mut parse_error = |msg: &str| {
		if cli.seq {
			session.write_stderr(format!("jq: ignoring parse error: {msg}\n").as_bytes());
			ControlFlow::Continue(())
		} else {
			ret.set(JQ_ERROR_UNKNOWN);
			session.write_stderr(format!("jq: parse error: {msg}\n").as_bytes());
			ControlFlow::Break(())
		}
	};

	// file operands that could not be read, as jq's `jq_util_input_errors`
	let failures = Cell::new(false);
	let read_error = if cli.files.is_empty() {
		let stdin = io::BufReader::new(&mut host.stdin);
		let inputs = read::stdin(cli, stdin, &session.input);
		filter::run(cli.null_input, &program, &ctx, session, inputs, || false, &mut process, &mut parse_error)
	} else {
		// Like jq, open each operand when the input stream reaches it; one that
		// cannot be read is reported, and the run stops before the next input.
		let operands: Vec<_> = cli.files.iter().map(|name| (name, host.resolve(name))).collect();
		let stdin = &mut host.stdin;
		let files = operands.into_iter().filter_map(|(name, path)| {
			let (name, loaded) = if name.as_os_str() == "-" {
				let mut bytes = Vec::new();
				(String::from("<stdin>"), io::Read::read_to_end(stdin, &mut bytes).map(|_| bytes))
			} else {
				(name.display().to_string(), read::load_file(&fs, &path))
			};
			match loaded {
				Ok(bytes) => Some((Val::from(name), bytes)),
				Err(e) => {
					let msg = if e.kind() == io::ErrorKind::IsADirectory {
						format!("jq: error: {}\n", strerror(&e))
					} else {
						format!("jq: error: Could not open file {name}: {}\n", strerror(&e))
					};
					session.write_stderr(msg.as_bytes());
					failures.set(true);
					None
				},
			}
		});
		let inputs = read::files(cli, files, &session.input);
		filter::run(cli.null_input, &program, &ctx, session, inputs, || failures.get(), &mut process, &mut parse_error)
	};
	let mut ret = ret.get();
	if let Some(e) = read_error {
		session.write_stderr(format!("jq: error: {}\n", strerror(&e)).as_bytes());
		failures.set(true);
	}
	if failures.get() {
		ret = JQ_ERROR_SYSTEM;
	}
	let flushed = stdout.flush();
	if let Some(e) = write_error.or(flushed.err()) {
		session.write_stderr(format!("jq: error: writing output failed: {}\n", strerror(&e)).as_bytes());
		ret = JQ_ERROR_SYSTEM;
	}

	let ret = if cli.exit_status && ret == JQ_OK_NO_OUTPUT {
		match last_result {
			-1 => JQ_OK_NO_OUTPUT,
			0 => JQ_OK_NULL_KIND,
			_ => JQ_OK,
		}
	} else {
		ret
	};
	if reported && (if cli.exit_status { ret == 0 } else { ret <= 0 }) {
		session.report_error();
	}
	(ret, cli.exit_status)
}

/// What became of one input, as jq's `process`.
struct Processed {
	/// jq's status: 0 or -1 by the kind of the last output, -4 without
	/// output, 5 after an error, or the exit code of `halt`/`halt_error`.
	status: i32,
	halted: bool,
	/// Whether an error was reported.
	raised: bool,
}

/// Prints the outputs of one input until it raises an error or halts, as
/// jq's `process`; fails only when writing fails.
fn process(
	outputs: &mut dyn Iterator<Item = Result<Val, Error>>,
	out: &output::Output,
	buf: &mut Vec<u8>,
	stdout: &mut dyn Write,
	session: &Session,
) -> io::Result<Processed> {
	let mut status = JQ_OK_NO_OUTPUT;
	for output in outputs {
		let error = match output {
			Ok(v) => match out.print(buf, stdout, &v) {
				Ok(printed) => {
					status = printed;
					continue;
				},
				Err(output::PrintError::Io(e)) => return Err(e),
				Err(output::PrintError::Raised(e)) => e,
			},
			// `halt_error` printed its message already
			Err(Error::Halt(code)) => return Ok(Processed { status: code, halted: true, raised: false }),
			Err(Error::Jq(e)) => e,
		};
		session.report_uncaught(error);
		return Ok(Processed { status: JQ_ERROR_UNKNOWN, halted: false, raised: true });
	}
	Ok(Processed { status, halted: false, raised: false })
}

/// Compile errors as jq reports them: each, then their count.
fn compile_errors(reports: &[FileReports]) -> String {
	let mut text: String = reports.iter().map(ToString::to_string).collect();
	let n = text.lines().filter(|line| line.starts_with("jq: error")).count();
	let s = if n == 1 { "" } else { "s" };
	text.push_str(&format!("jq: {n} compile error{s}\n"));
	text
}

/// The global variables of a program, as jq's `main` binds them: named
/// arguments, `$ARGS`, `$ENV` and `$JQ_BUILD_CONFIGURATION`. `Err` holds
/// jq's message for a file that could not be loaded.
fn binds(cli: &Cli, fs: &BlockingFs, host: &Host, env: &Val) -> Result<Vec<(String, Val)>, String> {
	let mut named = Vec::with_capacity(cli.named.len() + 3);
	for (name, value) in &cli.named {
		let value = match value {
			cli::Named::Str(s) => Val::from(s.clone()),
			cli::Named::Json(text) => jaq_json::read::parse_single(text.as_bytes())
				.map_err(|_| "jq: invalid JSON text passed to --argjson\n".to_string())?,
			cli::Named::RawFile(path) | cli::Named::SlurpFile(path) => {
				let raw = matches!(value, cli::Named::RawFile(_));
				let resolved = host.resolve(Path::new(path));
				let loaded = if raw {
					read::raw_file(fs, &resolved)
				} else {
					read::json_array(fs, &resolved)
				};
				loaded.map_err(|e| {
					let which = if raw { "rawfile" } else { "slurpfile" };
					let path = path.to_string_lossy();
					format!("jq: Bad JSON in --{which} {name} {path}: {}\n", load_error(&path, &e))
				})?
			},
		};
		named.push((name.clone(), value));
	}
	let mut positional = Vec::with_capacity(cli.positional.len());
	for arg in &cli.positional {
		positional.push(match arg {
			cli::Positional::Str(s) => Val::from(s.clone()),
			cli::Positional::Json(text) => jaq_json::read::parse_single(text.as_bytes())
				.map_err(|_| "jq: invalid JSON text passed to --jsonargs\n".to_string())?,
		});
	}

	let key = |k: &str| Val::from(k.to_string());
	let named_obj = named.iter().map(|(var, val)| (key(var), val.clone()));
	let args = [
		(key("positional"), positional.into_iter().collect()),
		(key("named"), Val::obj(named_obj.collect())),
	];
	// `$ARGS` and `$ENV` cannot be overridden
	named.retain(|(name, _)| name != "ARGS" && name != "ENV");
	if !named.iter().any(|(name, _)| name == "JQ_BUILD_CONFIGURATION") {
		named.push(("JQ_BUILD_CONFIGURATION".into(), Val::from(BUILD_CONFIGURATION.to_string())));
	}
	named.push(("ARGS".into(), Val::obj(args.into_iter().collect())));
	// the shell's exported environment, not the host process environment
	named.push(("ENV".into(), env.clone()));
	Ok(named)
}

/// What escaped a filter.
enum Error {
	Jq(jaq_core::Error<Val>),
	Halt(i32),
}

impl From<jaq_core::Exn<'_, Val>> for Error {
	fn from(exn: jaq_core::Exn<'_, Val>) -> Self {
		match exn.get_err() {
			Ok(e) => Self::Jq(e),
			Err(exn) => Self::Halt(exn.get_halt().expect("only errors and halts escape a filter")),
		}
	}
}

/// The epilogue of jq's `jq_testsuite`: its checks of the C API, which have
/// no counterpart here, print these lines when they pass.
const TESTSUITE_EPILOGUE: &str = "Test jq_state: .[]
Test jq_state: .[] | if .%2 == 0 then halt_error else . end
Test jq_compile_args with array args
  subtest: 42
  subtest: $val
  subtest: $x + $y
  subtest: $a + $b + $c
  subtest: $x * $y
Test jq recompile on same state
Test jq exhaust and reuse
";

/// `--run-tests`, as jq's `jq_testsuite`: `--skip n` and `--take n` apply
/// to the test files after them; without files, stdin is read.
fn run_tests(host: &mut Host, library_path: &[PathBuf], args: &[OsString]) -> i32 {
	let fs = host.fs().clone();
	let session = Session { quiet: true, ..Session::new(host) };
	let mut stdout = host.stdout_writer();
	let code = (|| {
		let (mut skip, mut take, mut nfiles) = (-1, -1, 0);
		let mut args = args.iter();
		while let Some(arg) = args.next() {
			let count = match arg.as_encoded_bytes() {
				b"--skip" => Some((&mut skip, "--skip")),
				b"--take" => Some((&mut take, "--take")),
				_ => None,
			};
			if let Some((count, option)) = count {
				let Some(n) = args.next() else {
					session.report(format!("{option} requires an argument\n").as_bytes());
					return 1;
				};
				*count = atoi(n.as_encoded_bytes());
				continue;
			}
			let file = match read::load_file(&fs, &host.resolve(Path::new(arg))) {
				Ok(file) => file,
				Err(e) => {
					session.report(format!("fopen: {}\n", strerror(&e)).as_bytes());
					return 1;
				},
			};
			let tests = Tests { fs: &fs, session: &session, library_path, out: &mut stdout };
			if let Some(code) = tests.run_file(&file[..], skip, take) {
				return code;
			}
			nfiles += 1;
		}
		if nfiles == 0 {
			let stdin = io::BufReader::new(&mut host.stdin);
			let tests = Tests { fs: &fs, session: &session, library_path, out: &mut stdout };
			if let Some(code) = tests.run_file(stdin, skip, take) {
				return code;
			}
		}
		let _ = stdout.write_all(TESTSUITE_EPILOGUE.as_bytes());
		0
	})();
	let _ = stdout.flush();
	code
}

/// C's `atoi`: an optionally signed decimal prefix, else 0.
fn atoi(s: &[u8]) -> i32 {
	let s = s.trim_ascii_start();
	let (sign, digits) = match s {
		[b'-', rest @ ..] => (-1, rest),
		[b'+', rest @ ..] => (1, rest),
		_ => (1, s),
	};
	let n = digits
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0i32, |n, c| n.wrapping_mul(10).wrapping_add(i32::from(c - b'0')));
	sign * n
}

/// Whether jq's test reader skips `line`: blank or a comment.
fn skipline(line: &str) -> bool {
	matches!(line.trim_start_matches([' ', '\t']).bytes().next(), None | Some(b'#' | b'\n'))
}

/// One run of jq's `run_jq_tests`.
struct Tests<'a> {
	fs:           &'a BlockingFs,
	session:      &'a Session,
	library_path: &'a [PathBuf],
	out:          &'a mut dyn Write,
}

impl Tests<'_> {
	/// Runs the tests of one file; `Some` is the status jq exits with.
	fn run_file(self, read: impl BufRead, mut skip: i32, mut take: i32) -> Option<i32> {
		let mut lines = TestLines { read, n: 0 };
		let (mut tests, mut passed, mut invalid) = (0, 0, 0);
		let (mut must_fail, mut check_msg) = (false, false);
		let tests_to_skip = skip.max(0);
		let tests_to_take = take;
		// the last compile error, kept across tests like jq's `err_msg`
		let mut err_msg = String::new();
		let w = &mut *self.out;

		'tests: while let Some(line) = lines.next_line() {
			if skipline(&line) {
				continue;
			}
			if line == "%%FAIL\n" || line == "%%FAIL IGNORE MSG\n" {
				must_fail = true;
				check_msg = line == "%%FAIL\n";
				continue;
			}
			let prog = line.strip_suffix('\n').unwrap_or(&line);

			let mut fail = false;
			if skip > 0 {
				skip -= 1;
			} else {
				if skip == 0 {
					let _ = writeln!(w, "Skipped {tests_to_skip} tests");
					skip = -1;
				}
				if take > 0 {
					take -= 1;
				} else if take == 0 {
					let _ = writeln!(w, "Hit the number of tests limit ({tests_to_take}), breaking");
					break;
				}
				let mut pass = true;
				tests += 1;
				let _ = writeln!(w, "Test #{}: '{prog}' at line number {}", tests + tests_to_skip, lines.n);
				let vars = [String::from("ENV")];
				let compiled = filter::parse_compile(self.fs, &PathBuf::new(), prog, &vars, self.library_path);

				if must_fail {
					match compiled {
						Ok(_) => {
							let _ = writeln!(w, "*** Test program compiled successfully, but should fail at line number {}: {prog}", lines.n);
							fail = true;
						},
						Err(reports) => {
							if let Some(last) = last_error(&compile_errors(&reports)) {
								err_msg = last;
							}
							let mut err_buf = &err_msg[..];
							while let Some(buf) = lines.next_line() {
								if skipline(&buf) {
									break;
								}
								if check_msg {
									let buf = buf.strip_suffix('\n').unwrap_or(&buf);
									if !err_buf.as_bytes().starts_with(buf.as_bytes()) {
										let shown = err_buf.split('\n').next().unwrap_or_default();
										let _ = writeln!(w, "*** Erroneous program failed with '{shown}', but expected '{buf}' at line number {}: {prog}", lines.n);
										fail = true;
										break;
									}
									err_buf = &err_buf[buf.len()..];
									err_buf = err_buf.strip_prefix('\n').unwrap_or(err_buf);
								}
							}
							if !fail {
								if check_msg && !err_buf.is_empty() {
									let shown = err_buf.split('\n').next().unwrap_or_default();
									let _ = writeln!(w, "*** Erroneous program failed with extra message '{shown}' at line {}: {prog}", lines.n);
									invalid += 1;
									pass = false;
								}
								must_fail = false;
								check_msg = false;
								passed += i32::from(pass);
								continue 'tests;
							}
						},
					}
				} else {
					match compiled {
						Err(reports) => {
							// jq's default error callback
							self.session.report(compile_errors(&reports).as_bytes());
							let _ = writeln!(w, "*** Test program failed to compile at line {}: {prog}", lines.n);
							fail = true;
						},
						Ok(mut program) => {
							let Some(buf) = lines.next_line() else {
								invalid += 1;
								break;
							};
							match jaq_json::read::parse_single(buf.as_bytes()) {
								Err(_) => {
									let _ = write!(w, "*** Input is invalid on line {}: {buf}\n", lines.n);
									fail = true;
								},
								Ok(input) => {
									let mut vals = vec![self.session.env.clone()];
									vals.append(&mut program.vals);
									let inputs = core::iter::once(Ok(input));
									filter::run(false, &program, &vals, self.session, inputs, || false, |outputs| {
										while let Some(buf) = lines.next_line() {
											if skipline(&buf) {
												break;
											}
											let Ok(expected) = jaq_json::read::parse_single(buf.as_bytes()) else {
												let _ = write!(w, "*** Expected result is invalid on line {}: {buf}\n", lines.n);
												fail = true;
												return ControlFlow::Break(());
											};
											match outputs.next() {
												Some(Ok(actual)) => {
													if expected != actual {
														let (e, a) = (dump(&expected), dump(&actual));
														let _ = writeln!(w, "*** Expected {e}, but got {a} for test at line number {}: {prog}", lines.n);
														pass = false;
													}
												},
												_ => {
													let _ = writeln!(w, "*** Insufficient results for test at line number {}: {prog}", lines.n);
													pass = false;
													break;
												},
											}
										}
										if pass && let Some(Ok(extra)) = outputs.next() {
											let _ = writeln!(w, "*** Superfluous result: {} for test at line number {}, {prog}", dump(&extra), lines.n);
											invalid += 1;
											pass = false;
										}
										ControlFlow::Break(())
									}, |_| ControlFlow::Break(()));
									if !fail {
										passed += i32::from(pass);
										continue 'tests;
									}
								},
							}
						},
					}
				}
			}
			if fail {
				invalid += 1;
			}
			// skip the rest of the test
			while let Some(buf) = lines.next_line() {
				if skipline(&buf) {
					break;
				}
			}
			must_fail = false;
			check_msg = false;
		}

		let total_skipped = if skip > 0 { tests_to_skip - skip } else { tests_to_skip };
		let _ = writeln!(w, "{passed} of {tests} tests passed ({invalid} malformed, {total_skipped} skipped)");
		if skip > 0 {
			let _ = writeln!(w, "WARN: skipped past the end of file, exiting with status 2");
			return Some(2);
		}
		(passed != tests).then_some(1)
	}
}

/// A test file's lines as jq's `fgets` reads them, newline included, and
/// how many were read.
struct TestLines<R> {
	read: R,
	n:    u32,
}

impl<R: BufRead> TestLines<R> {
	fn next_line(&mut self) -> Option<String> {
		let mut line = Vec::new();
		match self.read.read_until(b'\n', &mut line) {
			Ok(0) | Err(_) => None,
			Ok(_) => {
				self.n += 1;
				Some(String::from_utf8_lossy(&line).into_owned())
			},
		}
	}
}

/// The last message of jq's compile error report that starts with
/// `jq: error`, without its final newline, as jq's `test_err_cb` keeps it.
fn last_error(report: &str) -> Option<String> {
	let mut starts: Vec<usize> = Vec::new();
	let mut offset = 0;
	for line in report.split_inclusive('\n') {
		if line.starts_with("jq: ") {
			starts.push(offset);
		}
		offset += line.len();
	}
	starts.push(report.len());
	starts
		.windows(2)
		.map(|w| &report[w[0]..w[1]])
		.filter(|msg| msg.starts_with("jq: error"))
		.last()
		.map(|msg| msg.strip_suffix('\n').unwrap_or(msg).to_owned())
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		io,
		io::Write,
		path::PathBuf,
		sync::{atomic::Ordering, mpsc},
		thread,
		time::{Duration, Instant},
	};

	use clap::Parser as _;

	use super::{Jq, cli};
	use crate::host::{Host, Utility, run_util};

	fn run_jq_in(
		cwd: PathBuf,
		env: HashMap<String, String>,
		args: &[&str],
		stdin: &str,
	) -> (i32, String, String) {
		let (mut host, capture) = Host::for_test("jq", stdin, cwd);
		for (key, value) in env {
			host.set_test_var(&key, &value);
		}
		let argv = std::iter::once("jq").chain(args.iter().copied());
		let code = Jq::try_parse_from(argv).expect("jq parses any argv").run(&mut host);
		(code, capture.out(), capture.err())
	}

	fn run_jq(args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_util::<Jq>(args, stdin, ".");
		(code, capture.out(), capture.err())
	}

	fn run_jq_env(env: &[(&str, &str)], args: &[&str], stdin: &str) -> (i32, String, String) {
		let env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
		run_jq_in(PathBuf::from("."), env, args, stdin)
	}

	/// Records every write it receives, and fails each one when `fail` is set.
	#[derive(Default)]
	struct Writes {
		calls: Vec<Vec<u8>>,
		fail:  bool,
	}

	impl Write for Writes {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.calls.push(buf.to_vec());
			if self.fail { Err(io::Error::other("disk full")) } else { Ok(buf.len()) }
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	/// Runs jq with `out` as its standard output; returns jq's status and
	/// stderr.
	fn run_jq_into(out: &mut Writes, args: &[&str], stdin: &str) -> (i32, String) {
		let (mut host, capture) = Host::for_test("jq", stdin, ".");
		let argv = std::iter::once("jq").chain(args.iter().copied());
		let cli::Action::Run(cli) = Jq::try_parse_from(argv).expect("parses").action else {
			panic!("not a run");
		};
		let (ret, _) = stacker::grow(super::STACK, || {
			let session = super::Session::new(&host);
			let printer = super::output::Printer::new(cli.indent, cli.sort_keys, cli.ascii_output, None);
			let output = super::output::Output::new(&cli, printer);
			super::real_main(&cli, &mut host, out, &output, &session)
		});
		(ret, capture.err())
	}

	#[test]
	fn identity_pretty_prints() {
		let (code, out, err) = run_jq(&["."], "{\"a\":1}");
		assert_eq!(code, 0);
		assert_eq!(out, "{\n  \"a\": 1\n}\n");
		assert_eq!(err, "");
	}

	#[test]
	fn compact_output() {
		let (code, out, _) = run_jq(&["-c", ".a"], "{\"a\":[1,2]}");
		assert_eq!(code, 0);
		assert_eq!(out, "[1,2]\n");
	}

	#[test]
	fn raw_output_strips_quotes() {
		let (code, out, _) = run_jq(&["-r", ".s"], "{\"s\":\"x y\"}");
		assert_eq!(code, 0);
		assert_eq!(out, "x y\n");

		let (code, out, _) = run_jq(&[".s"], "{\"s\":\"x y\"}");
		assert_eq!(code, 0);
		assert_eq!(out, "\"x y\"\n");
	}

	#[test]
	fn null_input_evaluates_filter() {
		let (code, out, _) = run_jq(&["-n", "1+2"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "3\n");
	}

	#[test]
	fn cancellation_stops_a_filter_before_its_first_output() {
		let (mut host, capture) = Host::for_test("jq", "", ".");
		let cancel = host.cancel_flag_for_test();
		let stdout = capture.stdout_buffer();
		let (tx, rx) = mpsc::channel();
		let worker = thread::spawn(move || {
			let jq = Jq::try_parse_from([
				"jq", "-n", "--unbuffered", "0, ([range(0; 1000000000)] | length)",
			])
			.expect("valid filter");
			let code = jq.run(&mut host);
			tx.send((code, capture.out())).expect("test receiver");
		});
		let deadline = Instant::now() + Duration::from_secs(2);
		while stdout.lock().is_empty() && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(5));
		}
		assert_eq!(&*stdout.lock(), b"0\n", "filter did not begin evaluation");
		cancel.store(true, Ordering::Relaxed);
		let (code, output) = rx.recv_timeout(Duration::from_secs(2)).expect("cancelled filter still running");
		worker.join().expect("jq worker");
		assert_eq!(code, 0);
		assert_eq!(output, "0\n", "cancelled filter must not publish a partial array length");
	}

	#[test]
	fn slurp_collects_documents() {
		let (code, out, _) = run_jq(&["-s", "length"], "{\"a\":1}\n{\"b\":2}\n");
		assert_eq!(code, 0);
		assert_eq!(out, "2\n");
	}

	#[test]
	fn named_args_bind_variables_first_one_winning() {
		let (code, out, _) = run_jq(&["-n", "--arg", "k", "v", "$k"], "");
		assert_eq!((code, out.as_str()), (0, "\"v\"\n"));

		let (code, out, _) = run_jq(&["-nc", "--argjson", "k", "[1,2]", "$k"], "");
		assert_eq!((code, out.as_str()), (0, "[1,2]\n"));

		let args = ["-nc", "--arg", "x", "1", "--arg", "x", "2", "--argjson", "y", "3", "--args", "[$x,$y,$ARGS]", "a"];
		let (code, out, _) = run_jq(&args, "");
		let expected = "[\"1\",3,{\"positional\":[\"a\"],\"named\":{\"x\":\"1\",\"y\":3}}]\n";
		assert_eq!((code, out.as_str()), (0, expected));

		let args = ["-nc", "--jsonargs", "$ARGS.positional", "1", "{\"a\":2}", "--args", "3", "--", "-4"];
		let (code, out, _) = run_jq(&args, "");
		assert_eq!((code, out.as_str()), (0, "[1,{\"a\":2},\"3\",\"-4\"]\n"));

		// `$ENV` and `$ARGS` keep their meaning; the names still appear in `$ARGS.named`
		let (code, out, _) = run_jq(&["-nc", "--arg", "ENV", "x", "--arg", "ARGS", "y", "[$ENV|type, $ARGS.named]"], "");
		assert_eq!((code, out.as_str()), (0, "[\"object\",{\"ENV\":\"x\",\"ARGS\":\"y\"}]\n"));
	}

	#[test]
	fn options_parse_like_jq() {
		// short options cluster; text that is not option-like is the program
		let (code, out, _) = run_jq(&["-nr", "\"a\""], "");
		assert_eq!((code, out.as_str()), (0, "a\n"));
		let (code, out, _) = run_jq(&["-1"], "[1]");
		assert_eq!((code, out.as_str()), (0, "-1\n"));
		let (code, out, _) = run_jq(&["-nr", "--", "-1"], "");
		assert_eq!((code, out.as_str()), (0, "-1\n"));
		// options after the program
		let (code, out, _) = run_jq(&[".a", "-c"], "{\"a\":[1]}");
		assert_eq!((code, out.as_str()), (0, "[1]\n"));
		// a later layout option wins
		let (code, out, _) = run_jq(&["-c", "--indent", "1", "."], "[1]");
		assert_eq!((code, out.as_str()), (0, "[\n 1\n]\n"));
		let (code, out, _) = run_jq(&["--tab", "-c", "."], "[1]");
		assert_eq!((code, out.as_str()), (0, "[1]\n"));
		let (code, out, _) = run_jq(&["--indent", "0", "."], "{\"a\":[1]}");
		assert_eq!((code, out.as_str()), (0, "{\n\"a\": [\n1\n]\n}\n"));
		let (code, out, _) = run_jq(&["--indent", "-1", "."], "[1]");
		assert_eq!((code, out.as_str()), (0, "[\n\t1\n]\n"));
		// accepted without effect
		let (code, out, _) = run_jq(&["-b", "-L", "/nowhere", "-L/nowhere", "-n", "1"], "");
		assert_eq!((code, out.as_str()), (0, "1\n"));
	}

	#[test]
	fn usage_errors_exit_2_with_jqs_messages() {
		const DIE: &str = "Use jq --help for help with command-line options,\nor see the jq manpage, or online docs at https://jqlang.org\n";
		for (args, message) in [
			(&["--bogus", "."][..], "jq: Unknown option --bogus\n"),
			(&["-nZ", "."], "jq: Unknown option -Z\n"),
			(&["-i", "."], "jq: Unknown option -i\n"),
			(&["--indent=2", "."], "jq: Unknown option --indent=2\n"),
			(&["--indent", "8", "."], "jq: --indent takes a number between -1 and 7\n"),
			(&["--indent", "3x", "."], "jq: --indent takes a number between -1 and 7\n"),
			(&["--indent"], "jq: --indent takes one parameter\n"),
			(&["-n", "--arg", "x"], "jq: --arg takes two parameters (e.g. --arg varname value)\n"),
			(&["-n", "--argjson", "x"], "jq: --argjson takes two parameters (e.g. --argjson varname text)\n"),
			(&["-n", "--slurpfile", "x"], "jq: --slurpfile takes two parameters (e.g. --slurpfile varname filename)\n"),
			(&["-n", "--rawfile", "x"], "jq: --rawfile takes two parameters (e.g. --rawfile varname filename)\n"),
			(&["-n", "--argjson", "x", "{", "$x"], "jq: invalid JSON text passed to --argjson\n"),
			(&["-n", "--jsonargs", ".", "{"], "jq: invalid JSON text passed to --jsonargs\n"),
			(&["-n", "-L"], "-L takes a parameter: (e.g. -L /search/path or -L/search/path)\n"),
		] {
			let (code, out, err) = run_jq(args, "");
			assert_eq!((code, out.as_str()), (2, ""), "{args:?}");
			assert_eq!(err, format!("{message}{DIE}"), "{args:?}");
		}
	}

	#[test]
	fn help_and_version_print_on_stdout() {
		let (code, out, err) = run_jq(&["--version"], "");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "jq-1.8.2\n", ""));
		let (code, out, _) = run_jq(&["-V", "--bogus"], "");
		assert_eq!((code, out.as_str()), (0, "jq-1.8.2\n"), "options take effect in order");

		let (code, out, err) = run_jq(&["-h"], "");
		assert_eq!((code, err.as_str()), (0, ""));
		assert!(out.starts_with("jq - commandline JSON processor [version 1.8.2]\n"), "{out}");
		assert!(out.ends_with("positional arguments are available as $ARGS.positional[].\n"), "{out}");

		let (code, out, _) = run_jq(&["--build-configuration"], "");
		assert_eq!((code, out), (0, format!("{}\n", super::BUILD_CONFIGURATION)));

		// without a program and with `-f`, nothing defaults to `.`
		let (code, out, err) = run_jq(&["-f"], "");
		assert_eq!((code, out.as_str()), (2, ""));
		assert!(err.ends_with("\nFor listing the command options, use jq --help.\n"), "{err}");
		// stdin is not a terminal here, so the program defaults to `.`
		let (code, out, _) = run_jq(&[], "1");
		assert_eq!((code, out.as_str()), (0, "1\n"));
	}

	#[test]
	fn exit_status_follows_jq() {
		for (args, input, status) in [
			(&["-e", "."][..], "true", 0),
			(&["-e", "."], "false", 1),
			(&["-e", "."], "null", 1),
			(&["-e", "."], "", 4),
			(&["-e", "."], "1 null", 1),
			(&["-e", "."], "null 1", 0),
			(&["-e", "select(.==1)"], "1 2", 0),
			(&["-e", ".+1"], "\"a\" 1", 0),
			(&["-e", ".+1"], "1 \"a\"", 5),
			(&["-ne", "false"], "", 1),
			(&["-ne", "empty"], "", 4),
			(&["-ner", "\"x\""], "", 0),
			(&["-e", "halt_error(-1)"], "1", 1),
			(&["halt_error(-1)"], "1", 0),
			(&["-n", "\"\" | halt_error(256)"], "", 0),
			(&["-n", "\"\" | halt_error(300)"], "", 44),
			(&[".+1"], "\"a\" 1", 0),
			(&[".+1"], "1 \"a\"", 5),
		] {
			let (code, ..) = run_jq(args, input);
			assert_eq!(code, status, "{args:?} on {input:?}");
		}
	}

	#[test]
	fn errors_name_the_input_position() {
		let (code, out, err) = run_jq(&[".a"], "1\n2\n");
		assert_eq!((code, out.as_str()), (5, ""));
		let lines: Vec<_> = err.lines().collect();
		assert_eq!(lines.len(), 2, "{err}");
		assert!(lines[0].starts_with("jq: error (at <stdin>:1): "), "{err}");
		assert!(lines[1].starts_with("jq: error (at <stdin>:2): "), "{err}");

		let (code, _, err) = run_jq(&[".a"], "1 2");
		assert_eq!(code, 5);
		assert!(err.lines().all(|l| l.starts_with("jq: error (at <stdin>:0): ")), "{err}");

		let (code, _, err) = run_jq(&["-n", "error(\"x\")"], "");
		assert_eq!((code, err.as_str()), (5, "jq: error (at <unknown>): x\n"));
		let (code, _, err) = run_jq(&["-n", "{a:1} | error"], "");
		assert_eq!((code, err.as_str()), (5, "jq: error (at <unknown>) (not a string): {\"a\":1}\n"));
		let (code, _, err) = run_jq(&["-n", "error(null)"], "");
		assert_eq!((code, err.as_str()), (5, "jq: error (at <unknown>) (not a string): null\n"));
		let (code, _, err) = run_jq(&["-n", "error(\"a\\u0000b\")"], "");
		assert_eq!((code, err.as_str()), (5, "jq: error (at <unknown>): a\n"), "printed up to NUL");
		let (_, _, err) = run_jq(&["-n", "input | error(\"x\")"], "1\n2\n");
		assert_eq!(err, "jq: error (at <stdin>:1): x\n");
	}

	#[test]
	fn compile_error_exits_3_with_diagnostic() {
		let (code, out, err) = run_jq(&["("], "null");
		assert_eq!(code, 3);
		assert_eq!(out, "", "compile error must not produce output");
		assert!(err.contains(" compile error"), "diagnostic on stderr: {err:?}");
	}

	#[test]
	fn indexing_null_yields_null_like_jq() {
		for (filter, input, expected) in [
			(".a.b", "{}", "null\n"),
			(".[0]", "null", "null\n"),
			(".a[0].b", "{}", "null\n"),
			("getpath([\"a\",\"b\"])", "{}", "null\n"),
			(".a.b // \"x\"", "{}", "\"x\"\n"),
			("has(\"a\")", "null", "false\n"),
		] {
			let (code, out, err) = run_jq(&["-c", filter], input);
			assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""), "{filter} on {input}");
		}
	}

	#[test]
	fn tabular_formats_render_scalar_fields() {
		let input = r#"[null,true,false,0,-12,1.5,9007199254740993,"","text"]"#;
		for (format, expected) in [
			("@csv", ",true,false,0,-12,1.5,9007199254740993,\"\",\"text\"\n"),
			("@tsv", "\ttrue\tfalse\t0\t-12\t1.5\t9007199254740993\t\ttext\n"),
		] {
			let (code, out, err) = run_jq(&["-r", format], input);
			assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""), "{format}");
		}
	}

	#[test]
	fn csv_quotes_strings_and_doubles_inner_quotes() {
		let input = r#"["a,\"b\"\r\n\\z","é"]"#;
		let (code, out, err) = run_jq(&["-r", "@csv"], input);
		assert_eq!((code, out.as_str(), err.as_str()), (0, "\"a,\"\"b\"\"\r\n\\z\",\"é\"\n", ""));
	}

	#[test]
	fn tsv_escapes_only_tab_newline_carriage_return_and_backslash() {
		let input = r#"["\t\n\r\\","literal\\t","a,\"b\"","é"]"#;
		let (code, out, err) = run_jq(&["-r", "@tsv"], input);
		let expected = "\\t\\n\\r\\\\\tliteral\\\\t\ta,\"b\"\té\n";
		assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""));
	}

	#[test]
	fn tabular_formats_accept_empty_rows() {
		for format in ["@csv", "@tsv"] {
			let (code, out, err) = run_jq(&["-r", format], "[]");
			assert_eq!((code, out.as_str(), err.as_str()), (0, "\n", ""), "{format}");
		}
	}

	#[test]
	fn tabular_formats_reject_nonarrays_and_nested_containers() {
		for format in ["@csv", "@tsv"] {
			for input in ["null", "true", "1", "\"text\"", "{}", "[[]]", "[{}]", "[1,[]]", "[1,{}]"] {
				let (code, out, err) = run_jq(&["-r", format], input);
				assert_eq!((code, out.as_str()), (5, ""), "{format} on {input}: {err}");
				assert!(err.starts_with("jq: error (at <stdin>:0): "), "{format} on {input}: {err}");
			}
		}
	}

	#[test]
	fn defines_jq_builtins_jaq_lacks() {
		let (code, out, err) = run_jq(&["-c", "[.[] | IN(2, 3)], IN(.[]; 5)"], "[1,2]");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "[false,true]\nfalse\n", ""));

		let (code, out, err) = run_jq(&["-r", "@csv, @tsv"], "[1,\"a\\\"b\\tc\",null,true]");
		assert_eq!((code, err.as_str()), (0, ""));
		assert_eq!(out, "1,\"a\"\"b\tc\",,true\n1\ta\"b\\tc\t\ttrue\n");

		// jq counts the line a value ends on, its newline included
		let input = "{\"a\":\n1}\n\n\n{\"b\":2}\n3";
		let (code, out, err) = run_jq(&["-c", "[input_line_number, input_filename]"], input);
		let expected = "[2,\"<stdin>\"]\n[5,\"<stdin>\"]\n[5,\"<stdin>\"]\n";
		assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""));

		let (code, out, _) = run_jq(&["-Rc", "[., input_line_number]"], "a\nb");
		assert_eq!((code, out.as_str()), (0, "[\"a\",1]\n[\"b\",1]\n"));

		// with `-n`, nothing is read until `input` asks
		let (code, out, _) = run_jq(&["-nc", "[input_filename], [input, input_filename]"], "1 2");
		assert_eq!((code, out.as_str()), (0, "[null]\n[1,\"<stdin>\"]\n"));
	}

	#[test]
	fn file_operands_form_one_input_stream() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("a.json"), "{\"a\":1}\n{\"a\":2}\n").expect("write a");
		std::fs::write(dir.path().join("b.json"), "{\"b\":3}\n").expect("write b");
		let jq = |args: &[&str]| {
			let args = [args, &["a.json", "b.json"]].concat();
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &args, "")
		};

		// `-s` slurps every file into one array
		let (code, out, err) = jq(&["-c", "-s", "map(keys[0])"]);
		assert_eq!((code, out.as_str(), err.as_str()), (0, "[\"a\",\"a\",\"b\"]\n", ""));

		// `input` reads on into the next file
		let (code, out, _) = jq(&["-nc", "[inputs | input_filename]"]);
		assert_eq!((code, out.as_str()), (0, "[\"a.json\",\"a.json\",\"b.json\"]\n"));

		let (code, out, _) = jq(&["-c", "[input_filename, input_line_number]"]);
		assert_eq!((code, out.as_str()), (0, "[\"a.json\",1]\n[\"a.json\",2]\n[\"b.json\",1]\n"));

		let (code, out, _) = jq(&["-nsc", "[input_filename, input_line_number]"]);
		assert_eq!((code, out.as_str()), (0, "[null,0]\n"), "slurping waits for `input`");

		let (code, out, _) = jq(&["-Rs", "."]);
		let concatenated = "\"{\\\"a\\\":1}\\n{\\\"a\\\":2}\\n{\\\"b\\\":3}\\n\"\n";
		assert_eq!((code, out.as_str()), (0, concatenated));

		// `-` is stdin, named `<stdin>`
		let args = ["-c", "[., input_filename]", "-", "b.json"];
		let (code, out, _) = run_jq_in(dir.path().to_path_buf(), HashMap::new(), &args, "7\n");
		assert_eq!((code, out.as_str()), (0, "[7,\"<stdin>\"]\n[{\"b\":3},\"b.json\"]\n"));
	}

	#[test]
	fn unreadable_operand_is_reported_and_ends_the_run() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("in.json"), "1 2").expect("write input");
		std::fs::create_dir(dir.path().join("dir")).expect("mkdir");
		let jq = |args: &[&str]| run_jq_in(dir.path().to_path_buf(), HashMap::new(), args, "");

		// like jq, the value read past the failure is still processed, then
		// the run stops
		let (code, out, err) = jq(&[".", "nope.json", "in.json", "in.json"]);
		assert_eq!((code, out.as_str()), (2, "1\n"));
		assert_eq!(err, "jq: error: Could not open file nope.json: No such file or directory\n");

		// one parser spans the operands, so `2` and the next file's `1` join
		let (code, out, err) = jq(&[".", "in.json", "dir", "in.json"]);
		assert_eq!((code, out.as_str(), err.as_str()), (2, "1\n21\n", "jq: error: Is a directory\n"));

		// operands are opened as the input stream reaches them
		let (code, out, err) = jq(&["halt", "in.json", "nope.json"]);
		assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));

		let (code, _, err) = jq(&["-n", "--rawfile", "n", "nope.json", "$n"]);
		let expected = "jq: Bad JSON in --rawfile n nope.json: Could not open nope.json: No such file or directory\n";
		assert_eq!((code, err.as_str()), (2, expected));
		let (code, _, err) = jq(&["-n", "--slurpfile", "n", "dir", "$n"]);
		let expected = "jq: Bad JSON in --slurpfile n dir: Could not open dir: It's a directory\n";
		assert_eq!((code, err.as_str()), (2, expected));

		std::fs::write(dir.path().join("bad.json"), "1 xyz").expect("write bad input");
		let (code, _, err) = jq(&["-n", "--slurpfile", "n", "bad.json", "$n"]);
		assert_eq!(code, 2);
		assert!(err.starts_with("jq: Bad JSON in --slurpfile n bad.json: "), "stderr: {err:?}");

		let (code, _, err) = jq(&["-f", "nope.jq"]);
		assert_eq!((code, err.as_str()), (2, "jq: Could not open nope.jq: No such file or directory\n"));
		// the program given before `-f` is still its file
		let (code, _, err) = jq(&["dir", "-f"]);
		assert_eq!((code, err.as_str()), (2, "jq: Could not open dir: It's a directory\n"));
	}

	#[test]
	fn colors_follow_jq_escapes() {
		let (code, out, _) = run_jq(&["-C", "."], "{\"a\":[1,\"x\",null,true,{}]}");
		let expected = "\x1b[1;39m{\x1b[0m\n  \x1b[1;34m\"a\"\x1b[0m\x1b[1;39m:\x1b[0m \x1b[1;39m[\x1b[0m\n    \x1b[0;39m1\x1b[0m\x1b[1;39m,\x1b[0m\n    \x1b[0;32m\"x\"\x1b[0m\x1b[1;39m,\x1b[0m\n    \x1b[0;90mnull\x1b[0m\x1b[1;39m,\x1b[0m\n    \x1b[0;39mtrue\x1b[0m\x1b[1;39m,\x1b[0m\n    \x1b[1;39m{}\x1b[0m\n  \x1b[1;39m]\x1b[0m\n\x1b[1;39m}\x1b[0m\n";
		assert_eq!((code, out.as_str()), (0, expected));

		let (code, out, _) = run_jq(&["-Cc", "."], "{\"a\":[1,\"x\",null,false,[]]}");
		let expected = "\x1b[1;39m{\x1b[0m\x1b[1;34m\"a\"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[1;39m[\x1b[0m\x1b[0;39m1\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;32m\"x\"\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;90mnull\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39mfalse\x1b[0m\x1b[1;39m,\x1b[0m\x1b[1;39m[]\x1b[0m\x1b[1;39m]\x1b[0m\x1b[1;39m}\x1b[0m\n";
		assert_eq!((code, out.as_str()), (0, expected));

		// `JQ_COLORS` overrides the first colors, `-S` and `-a` apply too
		let env = [("JQ_COLORS", "4;31:1:2:3:4:5:6:7;1")];
		let (code, out, err) = run_jq_env(&env, &["-CSac", "."], "{\"b\":null,\"a\":\"é\"}");
		let expected = "\x1b[6m{\x1b[0m\x1b[7;1m\"a\"\x1b[0m\x1b[6m:\x1b[0m\x1b[4m\"\\u00e9\"\x1b[0m\x1b[6m,\x1b[0m\x1b[7;1m\"b\"\x1b[0m\x1b[6m:\x1b[0m\x1b[4;31mnull\x1b[0m\x1b[6m}\x1b[0m\n";
		assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""));

		let (code, out, err) = run_jq_env(&[("JQ_COLORS", "1;31:x")], &["-Cc", "null"], "1");
		assert_eq!((code, out.as_str()), (0, "\x1b[0;90mnull\x1b[0m\n"), "defaults kept");
		assert_eq!(err, "Failed to set $JQ_COLORS\n");

		// `NO_COLOR` only disables the terminal default; `-M` wins over `-C`
		let (_, out, _) = run_jq_env(&[("NO_COLOR", "1")], &["-C", "null"], "1");
		assert_eq!(out, "\x1b[0;90mnull\x1b[0m\n");
		let (_, out, _) = run_jq(&["-C", "-M", "null"], "1");
		assert_eq!(out, "null\n");
	}

	#[test]
	fn jq_colors_parse_like_jq_set_colors() {
		for (spec, expected) in [
			("0:1:2:3:4:5:6:7:8:9", "\x1b[5m[\x1b[0m\x1b[0mnull\x1b[0m\x1b[5m,\x1b[0m\x1b[1mfalse\x1b[0m\x1b[5m,\x1b[0m\x1b[2mtrue\x1b[0m\x1b[5m,\x1b[0m\x1b[3m1\x1b[0m\x1b[5m,\x1b[0m\x1b[4m\"s\"\x1b[0m\x1b[5m,\x1b[0m\x1b[6m{\x1b[0m\x1b[7m\"k\"\x1b[0m\x1b[6m:\x1b[0m\x1b[6m{}\x1b[0m\x1b[6m}\x1b[0m\x1b[5m]\x1b[0m\n"),
			("1;31:", "\x1b[1;39m[\x1b[0m\x1b[1;31mnull\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39mfalse\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39mtrue\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39m1\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;32m\"s\"\x1b[0m\x1b[1;39m,\x1b[0m\x1b[1;39m{\x1b[0m\x1b[1;34m\"k\"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[1;39m{}\x1b[0m\x1b[1;39m}\x1b[0m\x1b[1;39m]\x1b[0m\n"),
			(":", "\x1b[1;39m[\x1b[0m\x1b[mnull\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39mfalse\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39mtrue\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39m1\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;32m\"s\"\x1b[0m\x1b[1;39m,\x1b[0m\x1b[1;39m{\x1b[0m\x1b[1;34m\"k\"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[1;39m{}\x1b[0m\x1b[1;39m}\x1b[0m\x1b[1;39m]\x1b[0m\n"),
			("1::2", "\x1b[1;39m[\x1b[0m\x1b[1mnull\x1b[0m\x1b[1;39m,\x1b[0m\x1b[mfalse\x1b[0m\x1b[1;39m,\x1b[0m\x1b[2mtrue\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;39m1\x1b[0m\x1b[1;39m,\x1b[0m\x1b[0;32m\"s\"\x1b[0m\x1b[1;39m,\x1b[0m\x1b[1;39m{\x1b[0m\x1b[1;34m\"k\"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[1;39m{}\x1b[0m\x1b[1;39m}\x1b[0m\x1b[1;39m]\x1b[0m\n"),
			("4;35:::::::1;32", "\x1b[m[\x1b[0m\x1b[4;35mnull\x1b[0m\x1b[m,\x1b[0m\x1b[mfalse\x1b[0m\x1b[m,\x1b[0m\x1b[mtrue\x1b[0m\x1b[m,\x1b[0m\x1b[m1\x1b[0m\x1b[m,\x1b[0m\x1b[m\"s\"\x1b[0m\x1b[m,\x1b[0m\x1b[m{\x1b[0m\x1b[1;32m\"k\"\x1b[0m\x1b[m:\x1b[0m\x1b[m{}\x1b[0m\x1b[m}\x1b[0m\x1b[m]\x1b[0m\n"),
			("1:2:3:4:5:6:7:8x", "\x1b[6m[\x1b[0m\x1b[1mnull\x1b[0m\x1b[6m,\x1b[0m\x1b[2mfalse\x1b[0m\x1b[6m,\x1b[0m\x1b[3mtrue\x1b[0m\x1b[6m,\x1b[0m\x1b[4m1\x1b[0m\x1b[6m,\x1b[0m\x1b[5m\"s\"\x1b[0m\x1b[6m,\x1b[0m\x1b[7m{\x1b[0m\x1b[8m\"k\"\x1b[0m\x1b[7m:\x1b[0m\x1b[7m{}\x1b[0m\x1b[7m}\x1b[0m\x1b[6m]\x1b[0m\n"),
		] {
			let (code, out, err) = run_jq_env(&[("JQ_COLORS", spec)], &["-Cc", "."], "[null,false,true,1,\"s\",{\"k\":{}}]");
			assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""), "{spec}");
		}
	}

	#[test]
	fn sort_keys_and_ascii_output() {
		let (code, out, _) = run_jq(&["-Sa", "."], "{\"b\":2,\"a\":\"é\\u0001\",\"B\":{\"y\":1,\"x\":0}}");
		let expected = "{\n  \"B\": {\n    \"x\": 0,\n    \"y\": 1\n  },\n  \"a\": \"\\u00e9\\u0001\",\n  \"b\": 2\n}\n";
		assert_eq!((code, out.as_str()), (0, expected));
		let (_, out, _) = run_jq(&["-a", "."], "\"\\ud83d\\ude00\\u007f\"");
		assert_eq!(out, "\"\\ud83d\\ude00\\u007f\"\n");
		let (_, out, _) = run_jq(&["-ra", "."], "\"é\"");
		assert_eq!(out, "\"\\u00e9\"\n", "`-a` dumps raw strings as JSON");
	}

	#[test]
	fn raw_output_variants() {
		let (code, out, _) = run_jq(&["--raw-output0", ".[]"], "[\"a\",1]");
		assert_eq!((code, out.as_str()), (0, "a\x001\x00"));
		let (code, out, err) = run_jq(&["--raw-output0", ".[]"], "[\"a\",\"b\\u0000c\",\"d\"]");
		assert_eq!((code, out.as_str()), (5, "a\x00"));
		assert_eq!(err, "jq: error (at <stdin>:0): Cannot dump a string containing NUL with --raw-output0 option\n");
		let (code, out, _) = run_jq(&["-n", "--seq", "1, \"x\""], "");
		assert_eq!((code, out.as_str()), (0, "\x1e1\n\x1e\"x\"\n"));
		let (code, out, _) = run_jq(&["-nr", "--seq", "1, \"x\""], "");
		assert_eq!((code, out.as_str()), (0, "\x1e1\nx\n"));
	}

	#[test]
	fn relative_file_operand_resolves_against_scope_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("in.json"), "{\"a\":[1,2]}").expect("write input");
		// relative operand: must resolve against ScopeIo.cwd, not the process cwd
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-c", ".a", "in.json"], "");
		assert_eq!(code, 0, "stderr: {err:?}");
		assert_eq!(out, "[1,2]\n");
	}

	/// Truncating an input file after jq loaded it must not fault the host
	/// process; the loaded bytes stay readable.
	#[test]
	fn input_file_truncated_after_load_stays_readable() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		let path = dir.path().join("in.json");
		let json = format!("[{}]", vec!["1"; 8192].join(","));
		std::fs::write(&path, &json).expect("write input");
		let loaded = super::read::load_file(&pi_vfs::BlockingFs::native(), &path).expect("load");
		std::fs::File::options()
			.write(true)
			.open(&path)
			.and_then(|file| file.set_len(0))
			.expect("truncate input");
		assert_eq!(&loaded[..], json.as_bytes());
	}

	#[test]
	fn error_in_one_input_does_not_stop_the_rest() {
		// like jq, report it and go on; the exit status follows the last input
		let (code, out, err) = run_jq(&[". + 1"], "1 \"a\" 2");
		assert_eq!((code, out.as_str()), (0, "2\n3\n"));
		assert!(err.starts_with("jq: error (at <stdin>:0): ") && err.lines().count() == 1, "{err}");

		let (code, out, _) = run_jq(&[". + 1"], "1 2 \"a\"");
		assert_eq!((code, out.as_str()), (5, "2\n3\n"));

		// also when the error is raised while printing
		let (code, out, err) = run_jq(&["-c", "{(.): 1}"], "\"a\" 1 \"b\"");
		assert_eq!((code, out.as_str()), (0, "{\"a\":1}\n{\"b\":1}\n"));
		assert!(err.starts_with("jq: error (at <stdin>:0): ") && err.lines().count() == 1, "{err}");

		// a failed write ends the run
		let mut out = Writes { fail: true, ..Writes::default() };
		let (code, err) = run_jq_into(&mut out, &["."], "1 2 3");
		assert_eq!(code, 2);
		assert_eq!(out.calls, [b"1\n"]);
		assert_eq!(err, "jq: error: writing output failed: disk full\n");
	}

	#[test]
	fn printer_writes_each_value_at_once() {
		let mut out = Writes::default();
		assert_eq!(run_jq_into(&mut out, &["."], "{\"a\":[1,\"x\"]} 2"), (0, String::new()));
		let pretty: &[u8] = b"{\n  \"a\": [\n    1,\n    \"x\"\n  ]\n}\n";
		assert_eq!(out.calls, [pretty, b"2\n"]);
	}

	#[test]
	fn invalid_trailing_json_on_stdin_fails() {
		let (code, out, err) = run_jq(&["-c", "."], "{\"a\":1} xyz");
		assert_eq!(code, 5);
		assert_eq!(out, "{\"a\":1}\n", "valid leading document is still emitted");
		assert!(err.starts_with("jq: parse error: "), "stderr diagnostic: {err:?}");
	}

	#[test]
	fn env_var_and_dollar_env_read_scope_environment() {
		let env = HashMap::from([("FOO".to_string(), "bar".to_string())]);
		let (code, out, _) = run_jq_in(PathBuf::from("."), env, &["-n", "$ENV.FOO, env.FOO"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "\"bar\"\n\"bar\"\n", "$ENV and env read the shell env");
	}

	/// Each of these recursed past the shell's 2 MiB stack and killed the host
	/// process (jq's own test suite runs the first). Bounds follow jq's
	/// `MAX_PARSING_DEPTH` and `MAX_PRINT_DEPTH` (jq#3413).
	#[test]
	fn deep_nesting_round_trips_up_to_jq_limits() {
		// `nest(n)` is n + 1 arrays deep
		let nest = |n: usize| format!("reduce range({n}) as $_ ([]; [.])");

		let filter = format!("{} | tojson | fromjson | flatten", nest(9999));
		let (code, out, err) = run_jq(&["-nc", &filter], "");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "[]\n", ""), "10000 deep round-trips");

		let filter = format!("{} | tojson | try fromjson catch \"rejected\"", nest(10000));
		let (_, out, _) = run_jq(&["-n", &filter], "");
		assert_eq!(out, "\"rejected\"\n", "10001 deep does not parse");

		let deeper = format!("{}{}", "[".repeat(10_001), "]".repeat(10_001));
		let (code, out, err) = run_jq(&["length"], &deeper);
		assert_ne!(code, 0);
		assert_eq!(out, "");
		assert!(err.contains("Exceeds depth limit for parsing"), "input too deep: {err:?}");

		let filter = format!("{} | tojson | contains(\"[<skipped: too deep>]\")", nest(10001));
		let (_, out, _) = run_jq(&["-n", &filter], "");
		assert_eq!(out, "true\n", "tojson cuts below 10001 levels");

		let (code, out, _) = run_jq(&["-nc", &nest(10001)], "");
		assert_eq!(code, 0);
		let printed = format!("{}<skipped: too deep>{}\n", "[".repeat(10_001), "]".repeat(10_001));
		assert!(out == printed, "printer cuts likewise");
	}

	#[test]
	fn unbounded_recursion_fails_instead_of_overflowing() {
		let (code, out, err) = run_jq(&["-n", "def f: 1 + f; f"], "");
		assert_eq!((code, out.as_str()), (5, ""));
		assert_eq!(err, "jq: error (at <unknown>): filter recursion too deep\n");

		let (code, out, _) = run_jq(&["-n", "def f: 1 + f; try f catch \"caught\", 2"], "");
		assert_eq!((code, out.as_str()), (0, "\"caught\"\n2\n"), "catchable, and the run goes on");
	}

	#[test]
	fn halt_returns_instead_of_killing_process() {
		let (code, out, err) = run_jq(&["-n", "1, halt, 2"], "");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "1\n", ""), "nothing after halt");
		let (code, out, _) = run_jq(&["halt"], "1 2");
		assert_eq!((code, out.as_str()), (0, ""), "no more inputs either");
	}

	#[test]
	fn halt_error_prints_message_and_exit_code() {
		let (code, out, err) = run_jq(&["-n", "\"bye\\n\" | halt_error(3)"], "");
		assert_eq!((code, out.as_str(), err.as_str()), (3, "", "bye\n"), "string printed raw");

		let (code, _, err) = run_jq(&["-n", "{\"a\":1} | halt_error"], "");
		assert_eq!((code, err.as_str()), (5, "{\"a\":1}\n"), "anything else as JSON");

		let (code, _, err) = run_jq(&["-n", "null | halt_error(1)"], "");
		assert_eq!((code, err.as_str()), (1, ""), "null prints nothing");

		let (code, _, err) = run_jq(&["-n", "\"msg\" | halt_error(\"x\")"], "");
		assert_eq!(code, 5);
		assert!(err.starts_with("jq: error (at <unknown>): "), "nothing printed: {err:?}");
	}

	#[test]
	fn stderr_filter_writes_to_scope_stderr() {
		let (code, out, err) = run_jq(&["-n", "\"msg\" | stderr | length"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "3\n", "stderr is an identity filter");
		assert_eq!(err, "msg", "raw string on stderr, no newline");
	}

	#[test]
	fn debug_filter_writes_to_scope_stderr() {
		let (code, out, err) = run_jq(&["-nc", "[1,2] | debug"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "[1,2]\n");
		assert_eq!(err, "[\"DEBUG:\",[1,2]]\n");

		let (code, out, err) = run_jq(&["-nc", "0 | debug(1, 2)"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "0\n", "the input passes through once");
		assert_eq!(err, "[\"DEBUG:\",1]\n[\"DEBUG:\",2]\n");
	}

	#[test]
	fn rawfile_and_slurpfile_resolve_against_scope_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("raw.txt"), "hi").expect("write raw");
		std::fs::write(dir.path().join("vals.json"), "1 2").expect("write vals");
		let (code, out, err) = run_jq_in(
			dir.path().to_path_buf(),
			HashMap::new(),
			&["-nc", "--rawfile", "r", "raw.txt", "--slurpfile", "v", "vals.json", "$r, $v"],
			"",
		);
		assert_eq!(code, 0, "stderr: {err:?}");
		assert_eq!(out, "\"hi\"\n[1,2]\n");
	}

	#[test]
	fn from_file_reads_filter_relative_to_scope_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("f.jq"), ".a + 1").expect("write filter");
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-f", "f.jq"], "{\"a\":1}");
		assert_eq!(code, 0, "stderr: {err:?}");
		assert_eq!(out, "2\n");
	}

	#[test]
	fn join_output_omits_newlines() {
		let (code, out, _) = run_jq(&["-j", ".[]"], "[\"a\",\"b\",1]");
		assert_eq!(code, 0);
		assert_eq!(out, "ab1");
	}

	#[test]
	fn unbuffered_flag_is_accepted() {
		let (code, out, err) = run_jq(&["--unbuffered", "-c", ".[]"], "[1,{\"a\":2}]");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "1\n{\"a\":2}\n", ""));
	}

	#[test]
	fn run_tests_reports_like_jq() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		let tests = "# comment\n.a\n{\"a\":1}\n1\n\n.[]\n[1,2]\n1\n3\n\n%%FAIL IGNORE MSG\n1 +\nwhatever\n\n%%FAIL IGNORE MSG\n1\nx\n\n.[0]\n1\n2\n\n1,2\nnull\n1\n\n.\n{\n1\n";
		std::fs::write(dir.path().join("t.test"), tests).expect("write tests");
		std::fs::write(dir.path().join("ok.test"), ".\n1\n1\n").expect("write tests");
		let jq = |args: &[&str]| run_jq_in(dir.path().to_path_buf(), HashMap::new(), args, "");

		let (code, out, err) = jq(&["--run-tests", "t.test"]);
		let expected = "Test #1: '.a' at line number 2
Test #2: '.[]' at line number 6
*** Expected 3, but got 2 for test at line number 9: .[]
Test #3: '1 +' at line number 12
Test #4: '1' at line number 16
*** Test program compiled successfully, but should fail at line number 16: 1
Test #5: '.[0]' at line number 19
*** Insufficient results for test at line number 21: .[0]
Test #6: '1,2' at line number 23
*** Superfluous result: 2 for test at line number 26, 1,2
Test #7: '.' at line number 27
*** Input is invalid on line 28: {

2 of 7 tests passed (3 malformed, 0 skipped)
";
		assert_eq!((code, out.as_str(), err.as_str()), (1, expected, ""));

		let (code, out, _) = jq(&["--run-tests", "ok.test"]);
		let expected = format!("Test #1: '.' at line number 1\n1 of 1 tests passed (0 malformed, 0 skipped)\n{}", super::TESTSUITE_EPILOGUE);
		assert_eq!((code, out), (0, expected));

		let (code, out, _) = jq(&["--run-tests", "--skip", "1", "--take", "1", "t.test"]);
		let expected = "Skipped 1 tests\nTest #2: '.[]' at line number 6\n*** Expected 3, but got 2 for test at line number 9: .[]\nHit the number of tests limit (1), breaking\n0 of 1 tests passed (0 malformed, 1 skipped)\n";
		assert_eq!((code, out.as_str()), (1, expected));

		let (code, out, _) = jq(&["--run-tests", "--skip", "5", "ok.test"]);
		let expected = "0 of 0 tests passed (0 malformed, 1 skipped)\nWARN: skipped past the end of file, exiting with status 2\n";
		assert_eq!((code, out.as_str()), (2, expected));

		let (code, out, err) = jq(&["--run-tests", "nope.test"]);
		assert_eq!((code, out.as_str(), err.as_str()), (1, "", "fopen: No such file or directory\n"));
	}

	#[test]
	fn positional_args_after_double_dash_args() {
		let (code, out, _) = run_jq(&["-nc", "$ARGS.positional", "--args", "x", "y"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "[\"x\",\"y\"]\n");
	}
}
