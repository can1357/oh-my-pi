//! `jq` builtin: jq-compatible JSON processing via jaq 2.3.0.
//!
//! Ported from the jaq 2.3.0 CLI front end. The interpreter is provided by
//! `jaq-core`, `jaq-std`, and `jaq-json`.

use core::fmt::{self, Display, Formatter};
use std::{
	cell::RefCell,
	ffi::OsString,
	fs,
	io::{self, BufRead, Write},
	mem,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use clap::{ArgMatches, Command, CommandFactory, FromArgMatches, Parser, error::ErrorKind};
use cli::Cli;
use filter::{FileReports, Filter};
use jaq_core::{
	Ctx, RcIter,
	load::{self, test},
};
use jaq_json::Val;
use omp_shell::{ShellExtensions, builtins::Registration, openfiles::OpenFile};

use crate::host::{Host, StreamWriter, Utility, util};

mod cli {
	//! Command-line argument parsing.
	use core::fmt::{self, Display};
	use std::{ffi::OsString, path::PathBuf, vec};

	/// Remaining arguments; upstream used `std::env::ArgsOs`, but as an
	/// in-process builtin the argv comes from the host, not the process.
	type Args = vec::IntoIter<OsString>;

	#[derive(Debug, Default)]
	pub struct Cli {
		// Input options
		pub null_input: bool,
		/// When the option `--slurp` is used additionally,
		/// then the whole input is read into a single string.
		pub raw_input:  bool,
		/// When input is read from files,
		/// jaq yields an array for each file, whereas
		/// jq produces only a single array.
		pub slurp:      bool,

		// Output options
		pub compact_output:    bool,
		pub raw_output:        bool,
		/// This flag enables `--raw-output`.
		pub join_output:       bool,
		pub in_place:          bool,
		pub sort_keys:         bool,
		pub color_output:      bool,
		pub monochrome_output: bool,
		pub use_color:         bool,
		pub tab:               bool,
		pub indent:            usize,

		// Compilation options
		pub from_file:    bool,
		/// If this option is given multiple times, all given directories are
		/// searched.
		pub library_path: Vec<PathBuf>,

		// Key-value options
		pub arg:       Vec<(String, String)>,
		pub argjson:   Vec<(String, String)>,
		pub slurpfile: Vec<(String, OsString)>,
		pub rawfile:   Vec<(String, OsString)>,

		// Positional arguments
		/// If this argument is not given, it is assumed to be `.`, the identity
		/// filter.
		pub filter:      Option<Filter>,
		pub files:       Vec<PathBuf>,
		pub args:        Vec<String>,
		//pub jsonargs: Vec<String>,
		pub run_tests:   Option<Vec<PathBuf>>,
		/// If there is some last output value `v`,
		/// then the exit status code is
		/// 1 if `v < true` (that is, if `v` is `false` or `null`) and
		/// 0 otherwise.
		/// If there is no output value, then the exit status code is 4.
		///
		/// If any error occurs, then this option has no effect.
		pub exit_status: bool,
		pub version:     bool,
		pub help:        bool,
	}

	#[derive(Debug)]
	pub enum Filter {
		Inline(String),
		FromFile(PathBuf),
	}

	impl Cli {
		fn positional(&mut self, mode: &Mode, arg: OsString) -> Result<(), Error> {
			if self.filter.is_none() {
				self.filter = Some(if self.from_file {
					Filter::FromFile(arg.into())
				} else {
					Filter::Inline(arg.into_string()?)
				})
			} else {
				match mode {
					Mode::Files => self.files.push(arg.into()),
					Mode::Args => self.args.push(arg.into_string()?),
					//Mode::JsonArgs => self.jsonargs.push(arg.into_string()?),
				}
			}
			Ok(())
		}

		fn long(&mut self, mode: &mut Mode, arg: &str, args: &mut Args) -> Result<(), Error> {
			let int = |s: OsString| s.into_string().ok()?.parse().ok();
			match arg {
				// handle all arguments after "--"
				"" => args.try_for_each(|arg| self.positional(mode, arg))?,

				"null-input" => self.short('n', args)?,
				"raw-input" => self.short('R', args)?,
				"slurp" => self.short('s', args)?,

				"compact-output" => self.short('c', args)?,
				"raw-output" => self.short('r', args)?,
				"join-output" => self.short('j', args)?,
				"in-place" => self.short('i', args)?,
				"sort-keys" => self.short('S', args)?,
				"color-output" => self.short('C', args)?,
				"monochrome-output" => self.short('M', args)?,
				"tab" => self.tab = true,
				"indent" => self.indent = args.next().and_then(int).ok_or(Error::Int("--indent"))?,
				"from-file" => self.short('f', args)?,
				"library-path" => self.short('L', args)?,
				"arg" => {
					let (name, value) = parse_key_val("--arg", args)?;
					self.arg.push((name, value.into_string()?));
				},
				"argjson" => {
					let (name, value) = parse_key_val("--argjson", args)?;
					self.argjson.push((name, value.into_string()?));
				},
				"slurpfile" => self.slurpfile.push(parse_key_val("--slurpfile", args)?),
				"rawfile" => self.rawfile.push(parse_key_val("--rawfile", args)?),

				"args" => *mode = Mode::Args,
				//"jsonargs" => *mode = Mode::JsonArgs,
				"run-tests" => self.run_tests = Some(args.map(PathBuf::from).collect()),
				"exit-status" => self.short('e', args)?,
				"version" => self.short('V', args)?,
				"help" => self.short('h', args)?,

				arg => Err(Error::Flag(format!("--{arg}")))?,
			}
			Ok(())
		}

		fn short(&mut self, arg: char, args: &mut Args) -> Result<(), Error> {
			match arg {
				'n' => self.null_input = true,
				'R' => self.raw_input = true,
				's' => self.slurp = true,

				'c' => self.compact_output = true,
				'r' => self.raw_output = true,
				'j' => self.join_output = true,
				'i' => self.in_place = true,
				'S' => self.sort_keys = true,
				'C' => self.color_output = true,
				'M' => self.monochrome_output = true,

				'f' => self.from_file = true,
				'L' => self
					.library_path
					.push(args.next().ok_or(Error::Path("-L"))?.into()),
				'e' => self.exit_status = true,
				'V' => self.version = true,
				'h' => self.help = true,
				arg => Err(Error::Flag(format!("-{arg}")))?,
			}
			Ok(())
		}

		pub fn parse(argv: Vec<OsString>) -> Result<Self, Error> {
			let mut cli = Self { indent: 2, ..Self::default() };
			let mut mode = Mode::Files;
			let mut args = argv.into_iter();
			args.next(); // skip the command name (argv[0])
			while let Some(arg) = args.next() {
				match arg.to_str() {
					// we've got a valid UTF-8 argument here
					Some(s) => match s.strip_prefix("--") {
						Some(rest) => cli.long(&mut mode, rest, &mut args)?,
						None => match s.strip_prefix("-") {
							Some(rest) => rest.chars().try_for_each(|c| cli.short(c, &mut args))?,
							None => cli.positional(&mode, arg)?,
						},
					},
					// we've got invalid UTF-8, so it is no valid flag
					// note that we do not check here whether arg starts with `-`,
					// because this seems to be quite difficult to do in a portable way
					None => cli.positional(&mode, arg)?,
				}
			}
			Ok(cli)
		}

		pub fn color_if(&self, fallback: impl FnOnce() -> bool) -> bool {
			if self.monochrome_output {
				false
			} else if self.color_output {
				true
			} else {
				fallback()
			}
		}
	}

	#[derive(Debug)]
	pub enum Error {
		Flag(String),
		Utf8(OsString),
		KeyValue(&'static str),
		Int(&'static str),
		Path(&'static str),
	}

	impl Display for Error {
		fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
			match self {
				Self::Flag(s) => write!(f, "unknown flag: {s}"),
				Self::Utf8(s) => write!(f, "invalid UTF-8: {s:?}"),
				Self::KeyValue(o) => write!(f, "{o} expects a key and a value"),
				Self::Int(o) => write!(f, "{o} expects an integer"),
				Self::Path(o) => write!(f, "{o} expects a path"),
			}
		}
	}

	/// Conversion of errors from [`OsString::into_string`].
	impl From<OsString> for Error {
		fn from(e: OsString) -> Self {
			Self::Utf8(e)
		}
	}

	fn parse_key_val(arg: &'static str, args: &mut Args) -> Result<(String, OsString), Error> {
		let err = || Error::KeyValue(arg);
		let key = args.next().ok_or_else(err)?.into_string()?;
		let val = args.next().ok_or_else(err)?;
		Ok((key, val))
	}

	/// Interpretation of positional arguments.
	enum Mode {
		Args,
		//JsonArgs,
		Files,
	}
}

mod filter {
	//! Filter parsing, compilation, and execution.
	use core::{
		cell::Cell,
		fmt::{self, Display, Formatter},
	};
	use std::{
		io::{self, Write},
		iter,
		path::PathBuf,
	};

	use jaq_core::{
		Ctx, Error as CoreError, Exn, Native, RcIter, RunPtr, UpdatePtr, ValT, compile, load,
		load::{lex, parse},
	};

	use super::{Cli, Error, Val, read, runtime_cancelled, runtime_env, with_runtime};

	pub type Filter = jaq_core::Filter<Native<Val>>;

	thread_local! {
		/// Exit code requested by `halt`/`halt_error` in the current invocation.
		/// The overridden natives set this instead of `std::process::exit` and
		/// abort the run with a sentinel error; the entry point checks it first.
		static HALT: Cell<Option<i32>> = const { Cell::new(None) };
	}

	/// Takes (and clears) the exit code requested by `halt`/`halt_error`.
	pub fn take_halt() -> Option<i32> {
		HALT.with(Cell::take)
	}

	/// Replacements for jaq-std natives that are unsound inside a long-lived
	/// host process. Prepended before `jaq_std::funs()`: the compiler resolves
	/// native calls by first match, so these shadow the crates.io
	/// implementations.
	///
	/// - `env`: reads the shell's exported environment, not the host process's.
	/// - `halt`/`halt_error`: record the exit code and abort the run with a
	///   sentinel error instead of `std::process::exit`, which would kill the
	///   shell.
	/// - `debug`/`stderr`: write to the ctx stderr stream directly instead of
	///   going through the process-global `log` facade (whose single global
	///   logger may belong to the host).
	fn overrides() -> impl Iterator<Item = jaq_std::Filter<Native<Val>>>
	+ Clone
	+ DoubleEndedIterator
	+ iter::FusedIterator {
		use jaq_core::box_iter::box_once;
		use jaq_std::ValT as _;

		fn halt_with<'a>(code: i32, sentinel: &'static str) -> jaq_core::ValXs<'a, Val> {
			HALT.with(|h| h.set(Some(code)));
			box_once(Err(Exn::from(CoreError::str(sentinel))))
		}

		fn debug_msg(v: &Val) {
			// upstream format: env_logger renders `["DEBUG:", <args>]\n`
			with_runtime(|runtime| {
				let _ = writeln!(runtime.stderr, "[\"DEBUG:\", {v}]");
			});
		}

		fn stderr_msg(v: &Val) {
			// like jq, print strings raw and everything else as JSON, no newline
			if let Some(s) = v.as_str() {
				with_runtime(|runtime| {
					let _ = write!(runtime.stderr, "{s}");
				});
			} else {
				with_runtime(|runtime| {
					let _ = write!(runtime.stderr, "{v}");
				});
			}
		}

		let run_funs: [jaq_std::Filter<RunPtr<Val>>; 3] = [
			("env", jaq_std::v(0), |_, _| {
				let env = runtime_env()
					.into_iter()
					.map(|(k, v)| (k.into(), Val::from(v)));
				box_once(Ok(Val::obj(env.collect())))
			}),
			("halt", jaq_std::v(0), |_, _| halt_with(0, "halt")),
			("halt_error", jaq_std::v(1), |_, mut cv| {
				match cv.0.pop_var().as_isize() {
					Some(code) => {
						// upstream prints the input to stdout: raw for strings
						// (no trailing newline), JSON + newline otherwise
						if let Some(s) = cv.1.as_str() {
							with_runtime(|runtime| {
								let _ = write!(runtime.stdout, "{s}");
							});
						} else {
							with_runtime(|runtime| {
								let _ = writeln!(runtime.stdout, "{}", cv.1);
							});
						}
						halt_with(code as i32, "halt_error")
					},
					None => box_once(Err(Exn::from(CoreError::typ(cv.1, "integer")))),
				}
			}),
		];

		// `debug` and `stderr` are identity filters with an output effect; they
		// need an update pointer so `debug |= f` keeps working.
		let upd_funs: [jaq_std::Filter<(RunPtr<Val>, UpdatePtr<Val>)>; 2] = [
			(
				"debug",
				jaq_std::v(0),
				(
					|_, cv| {
						debug_msg(&cv.1);
						box_once(Ok(cv.1))
					},
					|_, cv, f| {
						debug_msg(&cv.1);
						f(cv.1)
					},
				),
			),
			(
				"stderr",
				jaq_std::v(0),
				(
					|_, cv| {
						stderr_msg(&cv.1);
						box_once(Ok(cv.1))
					},
					|_, cv, f| {
						stderr_msg(&cv.1);
						f(cv.1)
					},
				),
			),
		];

		let upd = |(name, arity, (run, update)): jaq_std::Filter<(RunPtr<Val>, UpdatePtr<Val>)>| {
			(name, arity, Native::new(run).with_update(update))
		};
		let run_funs = run_funs.into_iter().map(jaq_std::run);
		run_funs.chain(upd_funs.into_iter().map(upd))
	}

	pub fn parse_compile(
		path: &PathBuf,
		code: &str,
		vars: &[String],
		paths: &[PathBuf],
	) -> Result<(Vec<Val>, Filter), Vec<FileReports>> {
		use compile::Compiler;
		use load::{Arena, File, Loader, import};

		let default = ["~/.jq", "$ORIGIN/../lib/jq", "$ORIGIN/../lib"].map(|x| x.into());
		let paths = if paths.is_empty() { &default } else { paths };

		let vars: Vec<_> = vars.iter().map(|v| format!("${v}")).collect();
		let arena = Arena::default();
		let defs = jaq_std::defs().chain(jaq_json::defs());
		let loader = Loader::new(defs).with_std_read(paths);
		let path = path.into();
		let modules = loader
			.load(&arena, File { path, code })
			.map_err(load_errors)?;

		let mut vals = Vec::new();
		import(&modules, |p| {
			let path = p.find(paths, "json")?;
			vals.push(read::json_array(path).map_err(|e| e.to_string())?);
			Ok(())
		})
		.map_err(load_errors)?;

		// overrides first: native lookup is first-match-wins
		let funs = overrides().chain(jaq_std::funs()).chain(jaq_json::funs());
		let compiler = Compiler::default()
			.with_funs(funs)
			.with_global_vars(vars.iter().map(|v| &**v));
		let filter = compiler.compile(modules).map_err(compile_errors)?;
		Ok((vals, filter))
	}

	/// Run a filter with given input values and run `f` for every value output.
	///
	/// This function cannot return an `Iterator` because it creates an `RcIter`.
	/// This is most unfortunate. We should think about how to simplify this ...
	pub(crate) fn run(
		cli: &Cli,
		filter: &Filter,
		vars: Vec<Val>,
		iter: impl Iterator<Item = io::Result<Val>>,
		mut f: impl FnMut(Val) -> io::Result<()>,
	) -> Result<Option<bool>, Error> {
		let mut last = None;
		let iter = iter.map(|r| r.map_err(|e| e.to_string()));

		let iter = Box::new(iter) as Box<dyn Iterator<Item = _>>;
		let null = Box::new(core::iter::once(Ok(Val::Null))) as Box<dyn Iterator<Item = _>>;

		let iter = RcIter::new(iter);
		let null = RcIter::new(null);

		let ctx = Ctx::new(vars, &iter);

		for item in if cli.null_input { &null } else { &iter } {
			// host abort/timeout: stdin reads observe the cancel flag themselves,
			// but file/slurped inputs and long-running filters do not
			if runtime_cancelled() {
				break;
			}
			let input = item.map_err(Error::Parse)?;
			for output in filter.run((ctx.clone(), input)) {
				if runtime_cancelled() {
					return Ok(last);
				}
				let output = output.map_err(Error::Jaq)?;
				last = Some(output.as_bool());
				f(output)?;
			}
		}
		Ok(last)
	}

	#[derive(Debug)]
	pub struct FileReports(load::File<String, PathBuf>, Vec<Report>);

	impl Display for FileReports {
		fn fmt(&self, f: &mut Formatter) -> fmt::Result {
			let Self(file, reports) = self;
			let idx = codesnake::LineIndex::new(&file.code);
			reports.iter().try_for_each(|e| {
				writeln!(f, "Error: {}", e.message)?;
				let block = e.to_block(&idx);
				writeln!(f, "{}[{}]", block.prologue(), file.path.display())?;
				writeln!(f, "{}{}", block, block.epilogue())
			})
		}
	}

	fn load_errors(errs: load::Errors<&str, PathBuf>) -> Vec<FileReports> {
		use load::Error;

		let errs = errs.into_iter().map(|(file, err)| {
			let code = file.code;
			let err = match err {
				Error::Io(errs) => errs.into_iter().map(|e| report_io(code, e)).collect(),
				Error::Lex(errs) => errs.into_iter().map(|e| report_lex(code, e)).collect(),
				Error::Parse(errs) => errs.into_iter().map(|e| report_parse(code, e)).collect(),
			};
			FileReports(file.map_code(|s| s.into()), err)
		});
		errs.collect()
	}

	fn compile_errors(errs: compile::Errors<&str, PathBuf>) -> Vec<FileReports> {
		let errs = errs.into_iter().map(|(file, errs)| {
			let code = file.code;
			let errs = errs.into_iter().map(|e| report_compile(code, e)).collect();
			FileReports(file.map_code(|s| s.into()), errs)
		});
		errs.collect()
	}

	#[derive(Debug)]
	struct Report {
		message: String,
		labels:  Vec<(core::ops::Range<usize>, String)>,
	}

	fn report_io(code: &str, (path, error): (&str, String)) -> Report {
		let path_range = load::span(code, path);
		Report {
			message: format!("could not load file {}: {}", path, error),
			labels:  vec![(path_range, error)],
		}
	}

	fn report_lex(code: &str, (expected, found): lex::Error<&str>) -> Report {
		// truncate found string to its first character
		let found = &found[..found.char_indices().nth(1).map_or(found.len(), |(i, _)| i)];

		let found_range = load::span(code, found);
		let found_str = match found {
			"" => "unexpected end of input".to_string(),
			c => format!("unexpected character {c}"),
		};
		let label = (found_range, found_str);

		let labels = match expected {
			lex::Expect::Delim(open) => {
				vec![(load::span(code, open), format!("unclosed delimiter {open}")), label]
			},
			_ => vec![label],
		};

		Report { message: format!("expected {}", expected.as_str()), labels }
	}

	fn report_parse(code: &str, (expected, found): parse::Error<&str>) -> Report {
		let found_range = load::span(code, found);

		let found = if found.is_empty() {
			"unexpected end of input".to_string()
		} else {
			"unexpected token".to_string()
		};

		Report {
			message: format!("expected {}", expected.as_str()),
			labels:  vec![(found_range, found)],
		}
	}

	fn report_compile(code: &str, (found, undefined): compile::Error<&str>) -> Report {
		use compile::Undefined::Filter;
		let found_range = load::span(code, found);
		let wnoa = |exp, got| format!("wrong number of arguments (expected {exp}, found {got})");
		let message = match (found, undefined) {
			("reduce", Filter(arity)) => wnoa("2", arity),
			("foreach", Filter(arity)) => wnoa("2 or 3", arity),
			(_, undefined) => format!("undefined {}", undefined.as_str()),
		};

		Report { message: message.clone(), labels: vec![(found_range, message)] }
	}

	type CodeBlock = codesnake::Block<codesnake::CodeWidth<String>, String>;

	impl Report {
		fn to_block(&self, idx: &codesnake::LineIndex) -> CodeBlock {
			use codesnake::{Block, CodeWidth, Label};
			let labels = self
				.labels
				.iter()
				.cloned()
				.map(|(range, text)| Label::new(range).with_text(text));
			Block::new(idx, labels).unwrap().map_code(|c| {
				let c = c.replace('\t', "    ");
				let w = xutf::width_str(&c);
				CodeWidth::new(c, core::cmp::max(w, 1))
			})
		}
	}
}

mod read {
	use std::{
		error, fs,
		io::{self, BufRead},
		iter,
		path::Path,
	};

	use super::{Cli, Val};

	/// Try to load file by memory mapping and fall back to regular loading if it
	/// fails.
	pub fn load_file(
		path: impl AsRef<Path>,
	) -> io::Result<Box<dyn core::ops::Deref<Target = [u8]>>> {
		let path = path.as_ref();
		let file = fs::File::open(path)?;
		// SAFETY: `file` remains open until map construction completes; the mapping
		// owns its file-backed pages afterward.
		match unsafe { memmap2::Mmap::map(&file) } {
			Ok(mmap) => Ok(Box::new(mmap)),
			Err(_) => Ok(Box::new(fs::read(path)?)),
		}
	}

	pub fn invalid_data(e: impl error::Error + Send + Sync + 'static) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, e)
	}

	fn json_slice(slice: &[u8]) -> impl Iterator<Item = io::Result<Val>> + iter::FusedIterator + '_ {
		let mut lexer = hifijson::SliceLexer::new(slice);
		core::iter::from_fn(move || {
			use hifijson::token::Lex;
			Some(Val::parse(lexer.ws_token()?, &mut lexer).map_err(invalid_data))
		})
		.fuse()
	}

	fn json_read<'a>(
		read: impl BufRead + 'a,
	) -> impl Iterator<Item = io::Result<Val>> + iter::FusedIterator + 'a {
		let mut lexer = hifijson::IterLexer::new(read.bytes());
		core::iter::from_fn(move || {
			use hifijson::token::Lex;
			let v = Val::parse(lexer.ws_token()?, &mut lexer);
			Some(v.map_err(|e| core::mem::take(&mut lexer.error).unwrap_or_else(|| invalid_data(e))))
		})
		.fuse()
	}

	pub fn json_array(path: impl AsRef<Path>) -> io::Result<Val> {
		json_slice(&load_file(path.as_ref())?).collect()
	}

	enum InputValues<R, J> {
		Raw(R),
		Json(J),
	}

	impl<R, J> Iterator for InputValues<R, J>
	where
		R: Iterator<Item = io::Result<String>>,
		J: Iterator<Item = io::Result<Val>>,
	{
		type Item = io::Result<Val>;

		fn next(&mut self) -> Option<Self::Item> {
			match self {
				Self::Raw(iter) => iter.next().map(|result| result.map(Val::from)),
				Self::Json(iter) => iter.next(),
			}
		}
	}

	enum RawInput<R: BufRead> {
		Slurp(iter::Once<io::Result<String>>),
		Lines(io::Lines<R>),
	}

	impl<R: BufRead> Iterator for RawInput<R> {
		type Item = io::Result<String>;

		fn next(&mut self) -> Option<Self::Item> {
			match self {
				Self::Slurp(iter) => iter.next(),
				Self::Lines(iter) => iter.next(),
			}
		}
	}

	enum CollectIf<I, T, E> {
		Slurp(iter::Once<Result<T, E>>),
		Stream(I),
	}

	impl<I, T, E> Iterator for CollectIf<I, T, E>
	where
		I: Iterator<Item = Result<T, E>>,
	{
		type Item = Result<T, E>;

		fn next(&mut self) -> Option<Self::Item> {
			match self {
				Self::Slurp(iter) => iter.next(),
				Self::Stream(iter) => iter.next(),
			}
		}
	}

	pub fn buffered<'a, R>(cli: &Cli, read: R) -> impl Iterator<Item = io::Result<Val>> + 'a
	where
		R: BufRead + 'a,
	{
		if cli.raw_input {
			InputValues::Raw(raw_input(cli.slurp, read))
		} else {
			InputValues::Json(collect_if(cli.slurp, json_read(read)))
		}
	}

	pub fn slice<'a>(cli: &Cli, slice: &'a [u8]) -> impl Iterator<Item = io::Result<Val>> + 'a {
		if cli.raw_input {
			let read = io::BufReader::new(slice);
			InputValues::Raw(raw_input(cli.slurp, read))
		} else {
			InputValues::Json(collect_if(cli.slurp, json_slice(slice)))
		}
	}

	fn raw_input<R: BufRead>(slurp: bool, mut read: R) -> RawInput<R> {
		if slurp {
			let mut buf = String::new();
			let result = read.read_to_string(&mut buf).map(|_| buf);
			RawInput::Slurp(core::iter::once(result))
		} else {
			RawInput::Lines(read.lines())
		}
	}

	fn collect_if<T: FromIterator<T>, E>(
		slurp: bool,
		iter: impl Iterator<Item = Result<T, E>>,
	) -> CollectIf<impl Iterator<Item = Result<T, E>>, T, E> {
		if slurp {
			CollectIf::Slurp(core::iter::once(iter.collect()))
		} else {
			CollectIf::Stream(iter)
		}
	}
}

mod output {
	use core::fmt::{self, Display, Formatter};
	use std::{
		io::{self, Write},
		rc,
	};

	use super::{Cli, Val};

	struct FormatterFn<F>(F);

	impl<F: Fn(&mut Formatter) -> fmt::Result> Display for FormatterFn<F> {
		fn fmt(&self, f: &mut Formatter) -> fmt::Result {
			self.0(f)
		}
	}

	struct PpOpts {
		compact:   bool,
		indent:    String,
		sort_keys: bool,
		color:     bool,
	}

	impl PpOpts {
		fn indent(&self, f: &mut Formatter, level: usize) -> fmt::Result {
			if !self.compact {
				write!(f, "{}", self.indent.repeat(level))?;
			}
			Ok(())
		}

		fn newline(&self, f: &mut Formatter) -> fmt::Result {
			if !self.compact {
				writeln!(f)?;
			}
			Ok(())
		}
	}

	fn fmt_seq<T, I, F>(fmt: &mut Formatter, opts: &PpOpts, level: usize, xs: I, f: F) -> fmt::Result
	where
		I: IntoIterator<Item = T>,
		F: Fn(&mut Formatter, T) -> fmt::Result,
	{
		opts.newline(fmt)?;
		let mut iter = xs.into_iter().peekable();
		while let Some(x) = iter.next() {
			opts.indent(fmt, level + 1)?;
			f(fmt, x)?;
			if iter.peek().is_some() {
				write!(fmt, ",")?;
			}
			opts.newline(fmt)?;
		}
		opts.indent(fmt, level)
	}

	fn fmt_val(f: &mut Formatter, opts: &PpOpts, level: usize, v: &Val) -> fmt::Result {
		match v {
			Val::Null | Val::Bool(_) | Val::Int(_) | Val::Float(_) | Val::Num(_) => v.fmt(f),
			Val::Str(_) if opts.color => write!(f, "\x1b[32m{v}\x1b[0m"),
			Val::Str(_) => v.fmt(f),
			Val::Arr(a) => {
				if opts.color {
					write!(f, "\x1b[1m[\x1b[0m")?;
				} else {
					write!(f, "[")?;
				}
				if !a.is_empty() {
					fmt_seq(f, opts, level, &**a, |f, x| fmt_val(f, opts, level + 1, x))?;
				}
				if opts.color {
					write!(f, "\x1b[1m]\x1b[0m")
				} else {
					write!(f, "]")
				}
			},
			Val::Obj(o) => {
				if opts.color {
					write!(f, "\x1b[1m{{\x1b[0m")?;
				} else {
					write!(f, "{{")?;
				}
				let kv = |f: &mut Formatter, (k, val): (&rc::Rc<String>, &Val)| {
					if opts.color {
						write!(f, "\x1b[1m{}\x1b[0m:", Val::Str(k.clone()))?;
					} else {
						write!(f, "{}:", Val::Str(k.clone()))?;
					}
					if !opts.compact {
						write!(f, " ")?;
					}
					fmt_val(f, opts, level + 1, val)
				};
				if !o.is_empty() {
					if opts.sort_keys {
						let mut o: Vec<_> = o.iter().collect();
						o.sort_by_key(|(k, _v)| *k);
						fmt_seq(f, opts, level, o, kv)
					} else {
						fmt_seq(f, opts, level, &**o, kv)
					}?
				}
				if opts.color {
					write!(f, "\x1b[1m}}\x1b[0m")
				} else {
					write!(f, "}}")
				}
			},
		}
	}

	pub fn print(w: &mut (impl Write + ?Sized), cli: &Cli, val: &Val) -> io::Result<()> {
		let f = |f: &mut Formatter| {
			let opts = PpOpts {
				compact:   cli.compact_output,
				indent:    if cli.tab {
					String::from("\t")
				} else {
					" ".repeat(cli.indent)
				},
				sort_keys: cli.sort_keys,
				color:     cli.use_color,
			};
			fmt_val(f, &opts, 0, val)
		};

		match val {
			Val::Str(s) if cli.raw_output || cli.join_output => write!(w, "{s}")?,
			_ => write!(w, "{}", FormatterFn(f))?,
		};

		if cli.join_output {
			// when running `jaq -jn '"prompt> " | (., input)'`,
			// this flush is necessary to make "prompt> " appear first
			w.flush()
		} else {
			writeln!(w)
		}
	}

	/// Runs `f` with standard output and flushes at the operation boundary.
	pub fn with_stdout<T>(stdout: &mut dyn Write, f: impl FnOnce(&mut dyn Write) -> T) -> T {
		let res = f(stdout);
		let _ = stdout.flush();
		res
	}
}

/// Parsed `jq` invocation.
pub(crate) struct Jq {
	cli: Cli,
}

impl FromArgMatches for Jq {
	fn from_arg_matches(_matches: &ArgMatches) -> Result<Self, clap::Error> {
		Err(clap::Error::raw(ErrorKind::InvalidValue, "jq uses its order-preserving argument parser"))
	}

	fn update_from_arg_matches(&mut self, _matches: &ArgMatches) -> Result<(), clap::Error> {
		Err(clap::Error::raw(ErrorKind::InvalidValue, "jq uses its order-preserving argument parser"))
	}
}

fn command(name: &'static str) -> Command {
	Command::new(name)
		.version("2.3.0")
		.about(include_str!("jq-help.txt"))
		.help_template("{about}\n")
}

impl CommandFactory for Jq {
	fn command() -> Command {
		command("jq")
	}

	fn command_for_update() -> Command {
		Self::command()
	}
}

impl Parser for Jq {
	fn try_parse_from<I, T>(itr: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = T>,
		T: Into<OsString> + Clone,
	{
		let cli = Cli::parse(itr.into_iter().map(Into::into).collect())
			.map_err(|error| clap::Error::raw(ErrorKind::InvalidValue, format!("Error: {error}\n")))?;
		if cli.version {
			return Err(
				command("jaq")
					.try_get_matches_from(["jaq", "--version"])
					.expect_err("--version always short-circuits"),
			);
		}
		if cli.help {
			return Err(
				command("jaq")
					.try_get_matches_from(["jaq", "--help"])
					.expect_err("--help always short-circuits"),
			);
		}
		Ok(Self { cli })
	}
}

impl Utility for Jq {
	const NAME: &'static str = "jq";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		filter::take_halt();

		let mut cli = self.cli;
		resolve_cli_paths(&mut cli, host);
		cli.use_color = !cli.in_place && cli.color_if(|| host.stdout.is_terminal());
		let _runtime = RuntimeGuard::install(host);

		let result = real_main(&cli, host);
		if let Some(code) = filter::take_halt() {
			return code;
		}
		match result {
			Ok(exit) => exit,
			Err(error) => {
				let _ = write!(host.stderr, "{error}");
				error.report()
			},
		}
	}
}

fn resolve_cli_paths(cli: &mut Cli, host: &Host) {
	for path in &mut cli.library_path {
		*path = host.resolve(&*path);
	}
	if let Some(cli::Filter::FromFile(path)) = &mut cli.filter {
		*path = host.resolve(&*path);
	}
	for path in &mut cli.files {
		*path = host.resolve(&*path);
	}
	for path in cli
		.rawfile
		.iter_mut()
		.chain(&mut cli.slurpfile)
		.map(|(_, path)| path)
	{
		*path = host.resolve(&*path).into_os_string();
	}
	if let Some(paths) = &mut cli.run_tests {
		for path in paths {
			*path = host.resolve(&*path);
		}
	}
}

struct Runtime {
	stdout: StreamWriter,
	stderr: OpenFile,
	env:    Vec<(String, String)>,
	cancel: Arc<AtomicBool>,
}

thread_local! {
	static RUNTIME: RefCell<Option<Runtime>> = const { RefCell::new(None) };
}

#[must_use]
struct RuntimeGuard;

impl RuntimeGuard {
	fn install(host: &Host) -> Self {
		let runtime = Runtime {
			stdout: host.stdout_writer(),
			stderr: host.stderr_clone(),
			env:    host
				.env()
				.map(|(key, value)| (key.to_owned(), value.to_owned()))
				.collect(),
			cancel: host.cancel_flag(),
		};
		RUNTIME.with(|slot| {
			debug_assert!(slot.borrow().is_none());
			*slot.borrow_mut() = Some(runtime);
		});
		Self
	}
}

impl Drop for RuntimeGuard {
	fn drop(&mut self) {
		RUNTIME.with(|slot| *slot.borrow_mut() = None);
	}
}

fn with_runtime<T>(f: impl FnOnce(&mut Runtime) -> T) -> T {
	RUNTIME.with(|slot| {
		let mut runtime = slot.borrow_mut();
		f(runtime.as_mut().expect("jq runtime is installed"))
	})
}

fn runtime_env() -> Vec<(String, String)> {
	RUNTIME.with(|slot| {
		slot
			.borrow()
			.as_ref()
			.expect("jq runtime is installed")
			.env
			.clone()
	})
}

fn runtime_cancelled() -> bool {
	RUNTIME.with(|slot| {
		slot
			.borrow()
			.as_ref()
			.expect("jq runtime is installed")
			.cancel
			.load(Ordering::Relaxed)
	})
}

fn real_main(cli: &Cli, host: &mut Host) -> Result<i32, Error> {
	let mut stdout = host.stdout_writer();
	if let Some(test_files) = &cli.run_tests {
		return Ok(match test_files.last() {
			Some(file) => {
				run_tests(io::BufReader::new(fs::File::open(file)?), &mut stdout, &mut host.stderr)
			},
			None => run_tests(io::BufReader::new(&mut host.stdin), &mut stdout, &mut host.stderr),
		});
	}

	let (vars, mut ctx): (Vec<String>, Vec<Val>) = binds(cli, host)?.into_iter().unzip();

	let (vals, filter) = match &cli.filter {
		None => (Vec::new(), Filter::default()),
		Some(filter) => {
			let (path, code) = match filter {
				cli::Filter::FromFile(path) => (path.into(), fs::read_to_string(path)?),
				cli::Filter::Inline(filter) => ("<inline>".into(), filter.clone()),
			};
			filter::parse_compile(&path, &code, &vars, &cli.library_path).map_err(Error::Report)?
		},
	};
	ctx.extend(vals);

	let last = if cli.files.is_empty() {
		let inputs = read::buffered(cli, io::BufReader::new(&mut host.stdin));
		output::with_stdout(&mut stdout, |out| {
			filter::run(cli, &filter, ctx, inputs, |v| output::print(out, cli, &v))
		})?
	} else {
		let mut last = None;
		for file in &cli.files {
			// Resolve the operand against the shell's cwd; all later path
			// operations (open, metadata, in-place temp+rename) use the
			// resolved path so nothing touches the host process cwd.
			let path = file.as_path();
			let file =
				read::load_file(path).map_err(|e| Error::Io(Some(path.display().to_string()), e))?;
			let inputs = read::slice(cli, &file);
			if cli.in_place {
				host.ensure_writable(path)?;
				// create a temporary file where output is written to,
				// in the resolved target's directory so the final rename
				// stays on the same filesystem
				let location = path.parent().unwrap();
				let mut tmp = tempfile::Builder::new()
					.prefix("jaq")
					.tempfile_in(location)?;

				last = filter::run(cli, &filter, ctx.clone(), inputs, |output| {
					output::print(tmp.as_file_mut(), cli, &output)
				})?;

				// replace the input file with the temporary file
				mem::drop(file);
				let perms = fs::metadata(path)?.permissions();
				tmp.persist(path).map_err(Error::Persist)?;
				fs::set_permissions(path, perms)?;
			} else {
				last = output::with_stdout(&mut stdout, |out| {
					filter::run(cli, &filter, ctx.clone(), inputs, |v| output::print(out, cli, &v))
				})?;
			}
		}
		last
	};

	if cli.exit_status {
		last.map_or_else(|| Err(Error::NoOutput), |b| if b { Ok(0) } else { Err(Error::FalseOrNull) })
	} else {
		Ok(0)
	}
}

fn binds(cli: &Cli, host: &Host) -> Result<Vec<(String, Val)>, Error> {
	let arg = cli.arg.iter().map(|(k, s)| {
		let s = s.to_owned();
		Ok((k.to_owned(), Val::Str(s.into())))
	});
	let argjson = cli.argjson.iter().map(|(k, s)| {
		use hifijson::token::Lex;
		let mut lexer = hifijson::SliceLexer::new(s.as_bytes());
		let err = |e| Error::Parse(format!("{e} (for value passed to `--argjson {k}`)"));
		Ok((k.to_owned(), lexer.exactly_one(Val::parse).map_err(err)?))
	});
	let rawfile = cli.rawfile.iter().map(|(k, path)| {
		let s = fs::read_to_string(path).map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), Val::Str(s?.into())))
	});
	let slurpfile = cli.slurpfile.iter().map(|(k, path)| {
		let a = read::json_array(path).map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), a?))
	});

	let positional = cli.args.iter().cloned().map(|s| Ok(Val::from(s)));
	let positional = positional.collect::<Result<Vec<_>, Error>>()?;

	let var_val = arg.chain(rawfile).chain(slurpfile).chain(argjson);
	let mut var_val = var_val.collect::<Result<Vec<_>, Error>>()?;

	var_val.push(("ARGS".to_string(), args(&positional, &var_val)));
	// the shell's exported environment, not the host process environment
	let env = host
		.env()
		.map(|(key, value)| (key.to_owned().into(), Val::from(value.to_owned())));
	var_val.push(("ENV".to_string(), Val::obj(env.collect())));

	Ok(var_val)
}

fn args(positional: &[Val], named: &[(String, Val)]) -> Val {
	let key = |k: &str| k.to_string().into();
	let positional = positional.iter().cloned();
	let named = named.iter().map(|(var, val)| (key(var), val.clone()));
	let obj = [(key("positional"), positional.collect()), (key("named"), Val::obj(named.collect()))];
	Val::obj(obj.into_iter().collect())
}

#[derive(Debug)]
enum Error {
	Io(Option<String>, io::Error),
	Report(Vec<FileReports>),
	Parse(String),
	Jaq(jaq_core::Error<Val>),
	Persist(tempfile::PersistError),
	FalseOrNull,
	NoOutput,
}

impl Display for Error {
	fn fmt(&self, f: &mut Formatter) -> fmt::Result {
		match self {
			Self::FalseOrNull | Self::NoOutput => Ok(()),
			Self::Io(prefix, e) => {
				write!(f, "Error: ")?;
				if let Some(p) = prefix {
					write!(f, "{p}: ")?;
				}
				writeln!(f, "{e}")
			},
			Self::Persist(e) => {
				writeln!(f, "Error: {e}")
			},
			Self::Report(reports) => reports.iter().try_for_each(|fr| write!(f, "{fr}")),
			Self::Parse(e) => writeln!(f, "Error: failed to parse: {e}"),
			Self::Jaq(e) => writeln!(f, "Error: {e}"),
		}
	}
}

impl Error {
	/// Upstream's `Termination` exit-code mapping, kept verbatim.
	fn report(&self) -> i32 {
		match self {
			Self::FalseOrNull => 1,
			Self::Io(..) | Self::Persist(_) => 2,
			Self::Report(_) => 3,
			Self::NoOutput => 4,
			Self::Parse(_) | Self::Jaq(_) => 5,
		}
	}
}

impl From<io::Error> for Error {
	fn from(e: io::Error) -> Self {
		Self::Io(None, e)
	}
}

fn run_test(test: load::test::Test<String>) -> Result<(Val, Val), Error> {
	let (ctx, filter) =
		filter::parse_compile(&PathBuf::new(), &test.filter, &[], &[]).map_err(Error::Report)?;

	let inputs = RcIter::new(Box::new(core::iter::empty()));
	let ctx = Ctx::new(ctx, &inputs);

	let json = |s: String| {
		use hifijson::token::Lex;
		hifijson::SliceLexer::new(s.as_bytes())
			.exactly_one(Val::parse)
			.map_err(read::invalid_data)
	};
	let input = json(test.input)?;
	let expect: Result<Val, _> = test.output.into_iter().map(json).collect();
	let obtain: Result<Val, _> = filter.run((ctx, input)).collect();
	Ok((expect?, obtain.map_err(Error::Jaq)?))
}

fn run_tests(read: impl BufRead, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
	let lines = read.lines().map(Result::unwrap);
	let tests = test::Parser::new(lines);

	let (mut passed, mut total) = (0, 0);
	for test in tests {
		if runtime_cancelled() {
			break;
		}
		let _ = writeln!(stdout, "Testing {}", test.filter);
		match run_test(test) {
			Err(e) => {
				let _ = writeln!(stderr, "{e:?}");
			},
			Ok((expect, obtain)) if expect != obtain => {
				let _ = writeln!(stderr, "expected {expect}, obtained {obtain}",);
			},
			Ok(_) => passed += 1,
		}
		total += 1;
	}

	let _ = writeln!(stdout, "{passed} out of {total} tests passed");

	i32::from(total > passed)
}

/// Creates the `jq` builtin registration.
pub(crate) fn jq_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Jq, SE>()
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, fs, io::Write, iter, path::PathBuf};

	use clap::Parser as _;

	use super::Jq;
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
		let argv = iter::once("jq").chain(args.iter().copied());
		let code = match Jq::try_parse_from(argv) {
			Ok(parsed) => parsed.run(&mut host),
			Err(error) => {
				let rendered = error.to_string();
				if error.use_stderr() {
					let _ = write!(host.stderr, "{rendered}");
					i32::from(Jq::USAGE_ERROR)
				} else {
					let _ = write!(host.stdout, "{rendered}");
					0
				}
			},
		};
		(code, capture.out(), capture.err())
	}

	fn run_jq(args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_util::<Jq>(args, stdin, ".");
		(code, capture.out(), capture.err())
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
	fn forced_color_and_monochrome_flags_override_stream_detection() {
		let (code, out, err) = run_jq(&["-C", "."], "{\"a\": \"value\"}");
		assert_eq!(code, 0);
		assert!(out.contains('\x1b'));
		assert_eq!(err, "");

		let (code, out, err) = run_jq(&["-C", "-M", "."], "{\"a\": \"value\"}");
		assert_eq!(code, 0);
		assert!(!out.contains('\x1b'));
		assert_eq!(out, "{\n  \"a\": \"value\"\n}\n");
		assert_eq!(err, "");
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
	fn slurp_collects_documents() {
		let (code, out, _) = run_jq(&["-s", "length"], "{\"a\":1}\n{\"b\":2}\n");
		assert_eq!(code, 0);
		assert_eq!(out, "2\n");
	}

	#[test]
	fn named_arg_binds_variable() {
		let (code, out, _) = run_jq(&["-n", "--arg", "k", "v", "$k"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "\"v\"\n");
	}

	#[test]
	fn argjson_binds_json_value() {
		let (code, out, _) = run_jq(&["-nc", "--argjson", "k", "[1,2]", "$k"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "[1,2]\n");
	}

	#[test]
	fn exit_status_flag() {
		// false -> 1
		let (code, out, _) = run_jq(&["-n", "-e", "false"], "");
		assert_eq!(code, 1);
		assert_eq!(out, "false\n");

		// null (missing key) -> 1
		let (code, out, _) = run_jq(&["-e", ".missing"], "{}");
		assert_eq!(code, 1);
		assert_eq!(out, "null\n");

		// truthy -> 0
		let (code, ..) = run_jq(&["-e", "."], "true");
		assert_eq!(code, 0);

		// no output at all -> 4 (jaq-specific; jq also uses 4 here)
		let (code, ..) = run_jq(&["-n", "-e", "empty"], "");
		assert_eq!(code, 4);
	}

	#[test]
	fn compile_error_exits_3_with_diagnostic() {
		let (code, out, err) = run_jq(&["("], "null");
		assert_eq!(code, 3);
		assert_eq!(out, "", "compile error must not produce output");
		assert!(err.contains("Error:"), "diagnostic on stderr: {err:?}");
		assert!(err.contains("<inline>"), "names the filter source: {err:?}");
	}

	#[test]
	fn runtime_error_exits_5_with_diagnostic() {
		// indexing a number is a runtime (Jaq) error
		let (code, out, err) = run_jq(&[".[0]"], "1");
		assert_eq!(code, 5);
		assert_eq!(out, "");
		assert!(err.starts_with("Error:"), "diagnostic on stderr: {err:?}");
	}

	#[test]
	fn usage_error_exits_2() {
		let (code, _, err) = run_jq(&["--bogus", "."], "");
		assert_eq!(code, 2);
		assert!(err.contains("unknown flag: --bogus"), "stderr: {err:?}");
	}

	#[test]
	fn relative_file_operand_resolves_against_scope_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		fs::write(dir.path().join("in.json"), "{\"a\":[1,2]}").expect("write input");
		// relative operand: must resolve against ScopeIo.cwd, not the process cwd
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-c", ".a", "in.json"], "");
		assert_eq!(code, 0, "stderr: {err:?}");
		assert_eq!(out, "[1,2]\n");
	}

	#[test]
	fn missing_file_operand_exits_2() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &[".", "nope.json"], "");
		assert_eq!(code, 2);
		assert_eq!(out, "");
		assert!(err.contains("nope.json"), "stderr names the operand: {err:?}");
	}

	#[test]
	fn in_place_edit_rewrites_relative_file() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		fs::write(dir.path().join("in.json"), "{\"a\":1}").expect("write input");
		let (code, _, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-c", "-i", ".a", "in.json"], "");
		assert_eq!(code, 0, "stderr: {err:?}");
		let rewritten = fs::read_to_string(dir.path().join("in.json")).expect("read back");
		assert_eq!(rewritten, "1\n");
	}

	#[test]
	fn invalid_trailing_json_on_stdin_fails() {
		let (code, out, err) = run_jq(&["-c", "."], "{\"a\":1} xyz");
		assert_eq!(code, 5);
		assert_eq!(out, "{\"a\":1}\n", "valid leading document is still emitted");
		assert!(err.contains("Error:"), "stderr diagnostic: {err:?}");
	}

	#[test]
	fn env_var_and_dollar_env_read_scope_environment() {
		let env = HashMap::from([("FOO".to_string(), "bar".to_string())]);
		let (code, out, _) = run_jq_in(PathBuf::from("."), env, &["-n", "$ENV.FOO, env.FOO"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "\"bar\"\n\"bar\"\n", "$ENV and env read the shell env");
	}

	#[test]
	fn halt_returns_instead_of_killing_process() {
		let (code, out, err) = run_jq(&["-n", "1, halt, 2"], "");
		assert_eq!(code, 0, "halt exits 0");
		assert_eq!(out, "1\n", "outputs before halt are emitted, none after");
		assert_eq!(err, "");
	}

	#[test]
	fn halt_error_prints_message_and_exit_code() {
		let (code, out, _) = run_jq(&["-n", "\"bye\\n\" | halt_error(3)"], "");
		assert_eq!(code, 3);
		assert_eq!(out, "bye\n", "string message printed raw");
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
		assert_eq!(err, "[\"DEBUG:\", [1,2]]\n");
	}

	#[test]
	fn rawfile_and_slurpfile_resolve_against_scope_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		fs::write(dir.path().join("raw.txt"), "hi").expect("write raw");
		fs::write(dir.path().join("vals.json"), "1 2").expect("write vals");
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
	fn version_flag_prints_and_exits_0() {
		let (code, out, _) = run_jq(&["--version"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "jaq 2.3.0\n");
	}

	#[test]
	fn tab_and_indent_control_pretty_printing() {
		let (code, out, _) = run_jq(&["--tab", "."], "{\"a\":1}");
		assert_eq!(code, 0);
		assert_eq!(out, "{\n\t\"a\": 1\n}\n");

		let (code, out, _) = run_jq(&["--indent", "4", "."], "{\"a\":1}");
		assert_eq!(code, 0);
		assert_eq!(out, "{\n    \"a\": 1\n}\n");
	}

	#[test]
	fn from_file_reads_filter_relative_to_scope_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		fs::write(dir.path().join("f.jq"), ".a + 1").expect("write filter");
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-f", "f.jq"], "{\"a\":1}");
		assert_eq!(code, 0, "stderr: {err:?}");
		assert_eq!(out, "2\n");
	}

	#[test]
	fn join_output_omits_newlines() {
		let (code, out, _) = run_jq(&["-j", ".[]"], "[\"a\",\"b\"]");
		assert_eq!(code, 0);
		assert_eq!(out, "ab");
	}

	#[test]
	fn positional_args_after_double_dash_args() {
		let (code, out, _) = run_jq(&["-nc", "$ARGS.positional", "--args", "x", "y"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "[\"x\",\"y\"]\n");
	}
}
