//! `jq` builtin: jq-compatible JSON processing via jaq 3.1.1.
//!
//! Ported from the jaq CLI front end. The interpreter is provided by
//! `jaq-core`, `jaq-std`, and `jaq-json`.

use core::fmt::{self, Display, Formatter};
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

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{ArgMatches, Command, CommandFactory, FromArgMatches, Parser, error::ErrorKind};
use jaq_json::Val;
use pi_vfs::{BlockingFs, File, TempOptions};

use crate::host::{Host, Utility, util};

use cli::Cli;
use filter::{FileReports, OnError};

/// Version of the jaq CLI this front end follows; `--version` reports it.
const JAQ_VERSION: &str = "3.1.1";

mod cli {
	//! Command-line argument parsing.
	use core::fmt;
	use std::{ffi::OsString, path::PathBuf};

	/// Remaining arguments; upstream used `std::env::ArgsOs`, but as an in-process
	/// builtin the argv comes from the host, not the process.
	type Args = std::vec::IntoIter<OsString>;

	#[derive(Debug, Default)]
	pub struct Cli {
		// Input options
		pub null_input: bool,
		/// When the option `--slurp` is used additionally,
		/// then the whole input is read into a single string.
		pub raw_input:  bool,
		/// With several file operands, all of them are read into one array,
		/// as in jq.
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
		pub tab:               bool,
		pub indent:            usize,
		/// Flush after each output, as with `jq --unbuffered`.
		pub unbuffered:        bool,

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
				"unbuffered" => self.unbuffered = true,
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
				'L' => self.library_path.push(args.next().ok_or(Error::Path("-L"))?.into()),
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

		pub fn color_if(&self, f: impl Fn() -> bool) -> bool {
			if self.monochrome_output {
				false
			} else if self.color_output {
				true
			} else {
				f()
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

	impl fmt::Display for Error {
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
	use core::fmt::{self, Display, Formatter};
	use std::{
		io,
		path::{Path, PathBuf},
	};

	use jaq_core::{
		Ctx, DataT, Error as CoreError, Exn, RunPtr, ValT as _, Vars, box_iter::box_once, compile,
		data, load, native,
	};
	use jaq_fmts::write::tabular::Row;
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
	}

	/// What natives see while a filter runs.
	pub struct Data<'a> {
		lut:     &'a jaq_core::Lut<Kind>,
		inputs:  Inputs<'a, Val>,
		session: &'a Session,
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
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def halt_error($exit_code): halt_error_empty($exit_code), halt($exit_code);
def halt_error: halt_error(5);
def tonumber: tonumber_;
"#;

	/// Natives that replace or extend jaq's. Listed first: the compiler binds a
	/// call to the first native with a matching name and arity.
	///
	/// - `env`, `debug_empty`, `stderr_empty`, `halt_error_empty`: read the
	///   shell's exported environment and write to its stderr instead of the
	///   host process's, as JSON (`debug`, `stderr` and `halt_error` are defined
	///   on the latter three).
	/// - `input_filename`, `input_line_number`: the position of the current
	///   input, which jq's front end tracks and jaq's library cannot.
	/// - `tonumber_`, behind `tonumber`: accepts exactly one number literal,
	///   like jq; jaq's parses any JSON text, so `"1 2"` yields two numbers and
	///   `"+1"` prints `+1`.
	/// - `@csv`, `@tsv`: jaq 3 moved them out of its standard library.
	fn natives() -> [native::Filter<RunPtr<Kind>>; 9] {
		[
			("env", native::v(0), |cv| box_once(Ok(cv.0.data().session.env.clone()))),
			("debug_empty", native::v(0), |cv| {
				effect(message(&cv.1).map(|json| {
					let mut line = b"[\"DEBUG:\",".to_vec();
					line.extend(json);
					line.extend(b"]\n");
					cv.0.data().session.write_stderr(&line);
				}))
			}),
			("stderr_empty", native::v(0), |cv| {
				let session = cv.0.data().session;
				effect(match &cv.1 {
					Val::TStr(s) | Val::BStr(s) => Ok(session.write_stderr(s)),
					v => message(v).map(|json| session.write_stderr(&json)),
				})
			}),
			// takes the exit code only to reject a bad one before printing
			("halt_error_empty", native::v(1), |mut cv| {
				let session = cv.0.data().session;
				let code = cv.0.pop_var();
				let code = match code.as_isize().map(i32::try_from) {
					Some(Ok(_)) => Ok(()),
					_ => Err(CoreError::typ(code, "integer")),
				};
				effect(code.and_then(|()| match &cv.1 {
					Val::Null => Ok(()),
					Val::TStr(s) | Val::BStr(s) => Ok(session.write_stderr(s)),
					v => message(v).map(|mut json| {
						json.push(b'\n');
						session.write_stderr(&json);
					}),
				}))
			}),
			("input_filename", native::v(0), |cv| {
				box_once(Ok(cv.0.data().session.input.filename.borrow().clone()))
			}),
			("input_line_number", native::v(0), |cv| {
				box_once(Ok(Val::from(cv.0.data().session.input.lines.get())))
			}),
			("tonumber_", native::v(0), |cv| box_once(tonumber(cv.1).map_err(Exn::from))),
			("@csv", native::v(0), |cv| box_once(table_row(&cv.1, "CSV", Row::write_csv))),
			("@tsv", native::v(0), |cv| box_once(table_row(&cv.1, "TSV", Row::write_tsv))),
		]
	}

	/// No output, or the error that stopped a native's side effect.
	fn effect<'a>(done: Result<(), CoreError<Val>>) -> jaq_core::ValXs<'a, Val> {
		match done {
			Ok(()) => Box::new(core::iter::empty()),
			Err(e) => box_once(Err(Exn::from(e))),
		}
	}

	/// `v` as jq writes it in messages: compact JSON.
	fn message(v: &Val) -> Result<Vec<u8>, CoreError<Val>> {
		let mut buf = Vec::new();
		output::Printer::compact().write(&mut buf, v).map_err(|e| match e {
			output::WriteError::Key(key) => CoreError::typ(key, "object key"),
			output::WriteError::Io(e) => CoreError::str(e),
		})?;
		Ok(buf)
	}

	/// jq's `tonumber`: numbers pass through; a string must hold exactly one
	/// number literal, optionally signed with `+`.
	fn tonumber(v: Val) -> Result<Val, CoreError<Val>> {
		let num = match &v {
			Val::Num(_) => return Ok(v),
			Val::TStr(s) | Val::BStr(s) => {
				let s: &[u8] = s;
				let literal = match s.strip_prefix(b"+") {
					Some(rest) if rest.first().is_some_and(u8::is_ascii_digit) => rest,
					_ => s,
				};
				jaq_json::read::parse_single_num(literal)
			},
			_ => None,
		};
		num.map(Val::Num).ok_or_else(|| CoreError::typ(v, "number"))
	}

	/// An array of scalars as one CSV or TSV row.
	fn table_row<'a>(
		v: &Val,
		format: &str,
		write: fn(&Row, &mut dyn io::Write) -> io::Result<()>,
	) -> jaq_core::ValX<'a, Val> {
		let fail = |e| CoreError::str(format_args!("cannot serialise {v} as {format}: {e}"));
		let row = Row::try_from(v).map_err(fail)?;
		let mut buf = Vec::new();
		write(&row, &mut buf).expect("writing to memory cannot fail");
		Ok(Val::utf8_str(buf))
	}

	/// A compiled filter and the values of the data files it imports.
	#[derive(Default)]
	pub struct Program {
		pub vals:         Vec<Val>,
		pub filter:       Filter,
		/// Whether `input_line_number` appears in the program's source, the
		/// only way it can be called; inputs count lines only then.
		pub counts_lines: bool,
	}

	pub fn parse_compile(
		fs: &BlockingFs,
		path: &PathBuf,
		code: &str,
		vars: &[String],
		paths: &[PathBuf],
	) -> Result<Program, Vec<FileReports>> {
		use compile::Compiler;
		use load::{Arena, File, Loader, import};

		let default = ["~/.jq", "$ORIGIN/../lib/jq", "$ORIGIN/../lib"].map(|x| x.into());
		let paths = if paths.is_empty() { &default } else { paths };

		let vars: Vec<_> = vars.iter().map(|v| format!("${v}")).collect();
		let arena = Arena::default();
		let ours = load::parse(DEFS, |p| p.defs()).expect("builtin definitions parse");
		let defs = jaq_core::defs()
			.chain(jaq_std::defs())
			.chain(jaq_json::defs())
			.chain(ours);
		let counts_lines = core::cell::Cell::new(code.contains("input_line_number"));
		let read = |import: load::Import<&str, PathBuf>| -> Result<File<String, PathBuf>, String> {
			let path = find_import(fs, &import, paths, "jq")?;
			let code = fs.read_to_string(&path).map_err(|e| e.to_string())?;
			counts_lines.set(counts_lines.get() || code.contains("input_line_number"));
			Ok(File { code, path })
		};
		let loader = Loader::new(defs).with_read(read);
		let path = path.into();
		let modules = loader
			.load(&arena, File { path, code })
			.map_err(load_errors)?;

		let mut vals = Vec::new();
		import(&modules, |p| {
			let path = find_import(fs, &p, paths, "json")?;
			vals.push(read::json_array(fs, &path).map_err(|e| e.to_string())?);
			Ok(())
		})
		.map_err(load_errors)?;

		let run = native::run::<Kind>;
		let inputs = input::funs::<Kind>().into_vec().into_iter().map(run);
		let funs = natives()
			.into_iter()
			.map(run)
			.chain(jaq_core::funs())
			.chain(jaq_std::funs())
			.chain(jaq_json::funs())
			.chain(inputs);
		let compiler = Compiler::default()
			.with_funs(funs)
			.with_global_vars(vars.iter().map(|v| &**v));
		let filter = compiler.compile(modules).map_err(compile_errors)?;
		Ok(Program { vals, filter, counts_lines: counts_lines.get() })
	}

	/// `jaq_core::load::Import::find`, resolving candidates through the
	/// injected filesystem instead of the host process's.
	///
	/// Search paths from the directive's `search` metadata are relative to the
	/// importing module; command-line (`-L`) paths are not. `~` and `$ORIGIN`
	/// prefixes expand as upstream does.
	fn find_import(
		fs: &BlockingFs,
		import: &load::Import<&str, PathBuf>,
		paths: &[PathBuf],
		ext: &str,
	) -> Result<PathBuf, String> {
		let parent = pi_vfs::parent_path(import.parent).unwrap_or(Path::new("."));

		let mut rel = Path::new(*import.path).to_path_buf();
		if !rel.is_relative() {
			return Err("non-relative path".into());
		}
		rel.set_extension(ext);

		#[cfg(target_os = "windows")]
		let home = "USERPROFILE";
		#[cfg(not(target_os = "windows"))]
		let home = "HOME";

		let home = || std::env::var_os(home).map(PathBuf::from);
		let origin = || std::env::current_exe().ok()?.parent().map(PathBuf::from);
		let expand = |path: &Path| {
			let home = expand_prefix(path, "~", home);
			let origin = expand_prefix(path, "$ORIGIN", origin);
			home.or(origin).unwrap_or_else(|| path.to_path_buf())
		};

		let meta = import_search_paths(import.meta)
			.into_iter()
			.map(|path| pi_vfs::join_path(parent, &expand(path.as_path())));
		meta.chain(paths.iter().map(|path| expand(path.as_path())))
			.map(|path| pi_vfs::join_path(&path, &rel))
			.filter_map(|path| fs.canonicalize(&path).ok())
			.find(|path| fs.is_file(path))
			.ok_or_else(|| "file not found".into())
	}

	fn expand_prefix(
		path: &Path,
		prefix: &str,
		replacement: impl FnOnce() -> Option<PathBuf>,
	) -> Option<PathBuf> {
		let rest = path.strip_prefix(prefix).ok()?;
		let mut expanded = replacement()?;
		expanded.push(rest);
		Some(expanded)
	}

	/// The `search` entries of an import directive's metadata object.
	fn import_search_paths(meta: &Option<load::parse::Term<&str>>) -> Vec<PathBuf> {
		use load::parse::Term;

		let Some(Term::Obj(entries)) = meta else {
			return Vec::new();
		};
		let search = entries.iter().find_map(|(key, value)| {
			if *term_str(key)? == "search" { value.as_ref() } else { None }
		});
		let mut found = Vec::new();
		match search {
			Some(Term::Arr(Some(items))) => {
				let mut stack = vec![&**items];
				while let Some(term) = stack.pop() {
					if let Term::BinOp(left, load::parse::BinaryOp::Comma, right) = term {
						stack.push(&**right);
						stack.push(&**left);
					} else if let Some(path) = term_str(term) {
						found.push(PathBuf::from(*path));
					}
				}
			},
			Some(term) => found.extend(term_str(term).map(|path| PathBuf::from(*path))),
			None => {},
		}
		found
	}

	/// A plain string literal without interpolation or format.
	fn term_str<'t, 's>(term: &'t load::parse::Term<&'s str>) -> Option<&'t &'s str> {
		match term {
			load::parse::Term::Str(None, parts) => match &parts[..] {
				[load::lex::StrPart::Str(text)] => Some(text),
				_ => None,
			},
			_ => None,
		}
	}

	/// What an error raised while filtering one input does to the rest.
	#[derive(Clone, Copy)]
	pub enum OnError {
		/// Report it and go on with the next input, as jq does; the run fails
		/// only when its last input did.
		Continue,
		/// Stop the run, so an in-place edit leaves its file untouched.
		Stop,
	}

	/// Run a filter on every input (or once on `null`) and run `f` for every
	/// value output; returns whether the last output was truthy.
	///
	/// This function cannot return an `Iterator` because it creates an `RcIter`.
	pub(crate) fn run(
		null_input: bool,
		filter: &Filter,
		vars: &[Val],
		session: &Session,
		on_error: OnError,
		iter: impl Iterator<Item = io::Result<Val>>,
		mut f: impl FnMut(Val) -> Result<(), Error>,
	) -> Result<Option<bool>, Error> {
		let mut last = None;
		// jaq's input stream carries errors as text; keep a read failure aside
		// so it ends the run as an I/O error, as in jq, also when it reached the
		// filter through `input` or a `try` there caught it
		let read_error = core::cell::Cell::new(None);
		let read_failed = || read_error.take().map(|e| Error::Io(None, e));
		let iter = RcIter::new(iter.map(|r| {
			r.map_err(|e| {
				let message = e.to_string();
				if e.kind() != io::ErrorKind::InvalidData {
					read_error.set(Some(e));
				}
				message
			})
		}));
		let null = RcIter::new(core::iter::once(Ok(Val::Null)));

		let data = Data { lut: &filter.lut, inputs: &iter, session };
		let ctx = Ctx::<Kind>::new(&data, Vars::new(vars.iter().cloned()));
		let inputs: Inputs<'_, Val> = if null_input { &null } else { data.inputs };

		// the last input's error is returned; earlier ones are reported as the
		// next input arrives
		let mut failed = None;
		for item in inputs {
			// host abort/timeout: stdin reads observe the cancel flag themselves,
			// but file/slurped inputs and long-running filters do not
			if session.cancelled() {
				break;
			}
			if let Some(error) = failed.take() {
				session.write_stderr(format!("{error}").as_bytes());
				session.report_error();
			}
			let input = item.map_err(|e| read_failed().unwrap_or(Error::Parse(e)))?;
			for output in filter.id.run((ctx.clone(), input)) {
				if session.cancelled() {
					return Ok(last);
				}
				// an error raised while printing, such as a non-string object key,
				// fails the input like one raised by the filter
				let printed = output.map_err(Error::from).and_then(|output| {
					let truthy = output.as_bool();
					f(output).map(|()| truthy)
				});
				match printed {
					Ok(truthy) => last = Some(truthy),
					Err(error) => match (read_failed(), on_error, error) {
						(Some(read), ..) => return Err(read),
						(None, OnError::Continue, error @ Error::Jaq(_)) => {
							failed = Some(error);
							break;
						},
						(None, _, error) => return Err(error),
					},
				}
			}
		}
		read_failed().or(failed).map_or(Ok(last), Err)
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

	type StringColors = Vec<(String, Option<Color>)>;

	#[derive(Debug)]
	struct Report {
		message: String,
		labels:  Vec<(core::ops::Range<usize>, StringColors, Color)>,
	}

	#[derive(Clone, Debug)]
	enum Color {
		Yellow,
		Red,
	}

	impl Color {
		fn apply(&self, d: impl Display) -> String {
			use yansi::{Color, Paint};
			let color = match self {
				Self::Yellow => Color::Yellow,
				Self::Red => Color::Red,
			};
			d.fg(color).to_string()
		}
	}

	fn report_io(code: &str, (path, error): (&str, String)) -> Report {
		let path_range = load::span(code, path);
		Report {
			message: format!("could not load file {}: {}", path, error),
			labels:  [(path_range, [(error, None)].into(), Color::Red)].into(),
		}
	}

	fn report_lex(code: &str, (expected, found): load::lex::Error<&str>) -> Report {
		// truncate found string to its first character
		let found = &found[..found.char_indices().nth(1).map_or(found.len(), |(i, _)| i)];

		let found_range = load::span(code, found);
		let found = match found {
			"" => [("unexpected end of input".to_string(), None)].into(),
			c => [("unexpected character ", None), (c, Some(Color::Red))]
				.map(|(s, c)| (s.into(), c))
				.into(),
		};
		let label = (found_range, found, Color::Red);

		let labels = match expected {
			load::lex::Expect::Delim(open) => {
				let text = [("unclosed delimiter ", None), (open, Some(Color::Yellow))]
					.map(|(s, c)| (s.into(), c));
				Vec::from([(load::span(code, open), text.into(), Color::Yellow), label])
			},
			_ => Vec::from([label]),
		};

		Report { message: format!("expected {}", expected.as_str()), labels }
	}

	fn report_parse(code: &str, (expected, found): load::parse::Error<&str>) -> Report {
		let found_range = load::span(code, found);

		let found = if found.is_empty() {
			"unexpected end of input"
		} else {
			"unexpected token"
		};
		let found = [(found.to_string(), None)].into();

		Report {
			message: format!("expected {}", expected.as_str()),
			labels:  Vec::from([(found_range, found, Color::Red)]),
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
		let found = [(message.clone(), None)].into();

		Report { message, labels: Vec::from([(found_range, found, Color::Red)]) }
	}

	type CodeBlock = codesnake::Block<codesnake::CodeWidth<String>, String, Option<Color>>;

	impl Report {
		fn to_block(&self, idx: &codesnake::LineIndex) -> CodeBlock {
			use codesnake::{Block, CodeWidth, Label};
			let color_maybe = |(text, color): (_, Option<Color>)| match color {
				None => text,
				Some(color) => color.apply(text).to_string(),
			};
			let labels = self.labels.iter().cloned().map(|(range, text, color)| {
				let text = text.into_iter().map(color_maybe).collect::<Vec<_>>();
				Label::new(range)
					.with_text(text.join(""))
					.with_style(Some(color))
			});
			Block::new(idx, labels)
				.unwrap()
				.map_code(|c| {
					let c = c.replace('\t', "    ");
					let w = xutf::width_str(&c);
					CodeWidth::new(c, core::cmp::max(w, 1))
				})
				.with_paint(|f, color, value| match color {
					Some(color) => write!(f, "{}", color.apply(value)),
					None => write!(f, "{value}"),
				})
		}
	}

}

mod read {
	use std::{
		cell::{Cell, RefCell},
		io::{self, BufRead, Read},
		path::Path,
		rc::Rc,
	};

	use jaq_json::read::{parse_many, read_many};
	use pi_vfs::BlockingFs;
	use self_cell::self_cell;

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

	pub fn json_array(fs: &BlockingFs, path: &Path) -> io::Result<Val> {
		parse_many(&load_file(fs, path)?).map(|r| r.map_err(invalid_data)).collect()
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

	/// Input values read from stdin, which is only read once a value is asked
	/// for. `count_lines` makes JSON input exact for `input_line_number`, at the
	/// cost of copying every line first.
	pub fn stdin<'a>(
		cli: &Cli,
		mut read: impl BufRead + 'a,
		pos: &'a Position,
		count_lines: bool,
	) -> Vals<'a> {
		let enter = move || pos.enter(Val::from(String::from("<stdin>")));
		if cli.raw_input && cli.slurp {
			return Box::new(core::iter::once_with(move || {
				enter();
				let mut buf = Vec::new();
				read.read_to_end(&mut buf)?;
				pos.lines.set(bytecount::count(&buf, b'\n'));
				Ok(Val::utf8_str(buf))
			}));
		}
		let (raw, lines) = (cli.raw_input, Rc::clone(&pos.lines));
		let stream = core::iter::once_with(move || {
			enter();
			values(raw, read, lines, count_lines)
		});
		collect_if(cli.slurp, stream.flatten())
	}

	/// Input values read from the file operands, which jq treats as one stream:
	/// `input` reads across files and `-s` slurps all of them into one value.
	/// `files` yields each operand when the stream reaches it, and its contents
	/// are dropped once its values are read.
	pub fn files<'a>(
		cli: &Cli,
		files: impl Iterator<Item = (Val, Loaded)> + 'a,
		pos: &'a Position,
		count_lines: bool,
	) -> Vals<'a> {
		if cli.raw_input && cli.slurp {
			return Box::new(core::iter::once_with(move || {
				let mut all = Vec::new();
				for (name, bytes) in files {
					pos.enter(name);
					all.extend_from_slice(&bytes);
					pos.lines.set(bytecount::count(&bytes, b'\n'));
				}
				Ok(Val::utf8_str(all))
			}));
		}
		let raw = cli.raw_input;
		let stream = files.flat_map(move |(name, bytes)| {
			pos.enter(name);
			let lines = Rc::clone(&pos.lines);
			FileVals::new(bytes, |bytes| {
				if raw || count_lines {
					values(raw, &bytes[..], lines, count_lines)
				} else {
					Box::new(parse_many(bytes).map(|r| r.map_err(invalid_data)))
				}
			})
		});
		collect_if(cli.slurp, stream)
	}

	self_cell!(
		/// A file operand's contents and the values being read from them.
		struct FileVals {
			owner: Loaded,

			#[covariant]
			dependent: Vals,
		}
	);

	impl Iterator for FileVals {
		type Item = io::Result<Val>;

		fn next(&mut self) -> Option<Self::Item> {
			self.with_dependent_mut(|_, values| values.next())
		}
	}

	/// Values of one input: JSON, or its lines when `raw` (`-R`).
	fn values<'a>(
		raw: bool,
		read: impl BufRead + 'a,
		lines: Rc<Cell<usize>>,
		count_lines: bool,
	) -> Vals<'a> {
		if raw {
			Box::new(RawLines { read, lines })
		} else if count_lines {
			Box::new(read_many(LineFeed { read, line: Vec::new(), pos: 0, lines }))
		} else {
			Box::new(read_many(read))
		}
	}

	/// Lines of raw input, without their line terminator.
	struct RawLines<R> {
		read:  R,
		lines: Rc<Cell<usize>>,
	}

	impl<R: BufRead> Iterator for RawLines<R> {
		type Item = io::Result<Val>;

		fn next(&mut self) -> Option<Self::Item> {
			let mut line = Vec::new();
			match self.read.read_until(b'\n', &mut line) {
				Ok(0) => None,
				Ok(_) => {
					if line.last() == Some(&b'\n') {
						line.pop();
						if line.last() == Some(&b'\r') {
							line.pop();
						}
						self.lines.set(self.lines.get() + 1);
					}
					Some(Ok(Val::utf8_str(line)))
				},
				Err(e) => Some(Err(e)),
			}
		}
	}

	/// Feeds the JSON parser one whole line at a time, counting each line as it
	/// is read. jq reads its input by lines, so `input_line_number` includes the
	/// newline ending the line a value ends on, before the parser reaches it.
	struct LineFeed<R> {
		read:  R,
		line:  Vec<u8>,
		pos:   usize,
		lines: Rc<Cell<usize>>,
	}

	impl<R: BufRead> Read for LineFeed<R> {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			let available = self.fill_buf()?;
			let n = available.len().min(buf.len());
			buf[..n].copy_from_slice(&available[..n]);
			self.consume(n);
			Ok(n)
		}
	}

	impl<R: BufRead> BufRead for LineFeed<R> {
		fn fill_buf(&mut self) -> io::Result<&[u8]> {
			if self.pos == self.line.len() {
				self.line.clear();
				self.pos = 0;
				self.read.read_until(b'\n', &mut self.line)?;
				if self.line.last() == Some(&b'\n') {
					self.lines.set(self.lines.get() + 1);
				}
			}
			Ok(&self.line[self.pos..])
		}

		fn consume(&mut self, n: usize) {
			self.pos += n;
		}
	}

	/// `iter`, or with `slurp` one array of all its values, collected when it
	/// is first asked for.
	fn collect_if<'a, T: FromIterator<T> + 'a, E: 'a>(
		slurp: bool,
		iter: impl Iterator<Item = Result<T, E>> + 'a,
	) -> Box<dyn Iterator<Item = Result<T, E>> + 'a> {
		if slurp {
			Box::new(core::iter::once_with(move || iter.collect()))
		} else {
			Box::new(iter)
		}
	}
}

mod output {
	use std::io::{self, Write};

	use jaq_json::{Num, Val};

	use super::Cli;

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

	const BOLD: &str = "1";
	const GREEN: &str = "32";

	/// Writes values as JSON the way jq does, so output stays parseable where
	/// jaq's own printer extends JSON: invalid UTF-8 in strings is replaced,
	/// NaN prints as `null`, infinities as the largest finite doubles, number
	/// literals JSON cannot spell are rewritten, and a non-string object key is
	/// an error.
	pub struct Printer {
		raw:       bool,
		join:      bool,
		flush:     bool,
		indent:    Option<String>,
		sort_keys: bool,
		color:     bool,
	}

	impl Printer {
		pub fn new(cli: &Cli, color: bool) -> Self {
			let indent = (!cli.compact_output).then(|| {
				if cli.tab { String::from("\t") } else { " ".repeat(cli.indent) }
			});
			Self {
				raw: cli.raw_output || cli.join_output,
				join: cli.join_output,
				// when running `jaq -jn '"prompt> " | (., input)'`, flushing is
				// necessary to make "prompt> " appear first
				flush: cli.join_output || cli.unbuffered,
				indent,
				sort_keys: cli.sort_keys,
				color,
			}
		}

		/// Compact and uncolored, for messages.
		pub const fn compact() -> Self {
			Self { raw: false, join: false, flush: false, indent: None, sort_keys: false, color: false }
		}

		/// Writes one output value and its separator with a single write,
		/// rendering them into `buf` first; a value that cannot be rendered
		/// writes nothing.
		pub fn print(&self, buf: &mut Vec<u8>, w: &mut dyn Write, v: &Val) -> Result<(), WriteError> {
			buf.clear();
			match v {
				Val::TStr(s) | Val::BStr(s) if self.raw => buf.extend_from_slice(s),
				_ => self.write(buf, v)?,
			}
			if !self.join {
				buf.push(b'\n');
			}
			w.write_all(buf)?;
			if self.flush {
				w.flush()?;
			}
			Ok(())
		}

		/// Writes `v` as JSON, failing on an object key that JSON cannot
		/// express.
		pub fn write<W: Write + ?Sized>(&self, w: &mut W, v: &Val) -> Result<(), WriteError> {
			self.write_at(w, 0, v)
		}

		fn write_at<W: Write + ?Sized>(
			&self,
			w: &mut W,
			level: usize,
			v: &Val,
		) -> Result<(), WriteError> {
			match v {
				Val::Null => w.write_all(b"null")?,
				Val::Bool(b) => write!(w, "{b}")?,
				Val::Num(Num::Float(x)) if x.is_nan() => w.write_all(b"null")?,
				Val::Num(Num::Float(x)) if x.is_infinite() => {
					let max = if x.is_sign_positive() { "" } else { "-" };
					write!(w, "{max}1.7976931348623157e+308")?;
				},
				// jaq keeps a parsed literal as written, and its parser accepts
				// spellings JSON does not (`+1.5`, `01.5`); drop the extra sign
				// and zeros, keeping every digit of the value
				Val::Num(Num::Dec(d)) if !is_json_number(d) => match respell(d) {
					(sign, digits) if is_json_number(digits) => write!(w, "{sign}{digits}")?,
					_ => self.write_at(w, level, &Val::Num(Num::from_dec_str(d)))?,
				},
				Val::Num(n) => write!(w, "{n}")?,
				Val::TStr(s) | Val::BStr(s) => self.styled(w, GREEN, |w| write_str(w, s))?,
				Val::Arr(a) => {
					self.styled(w, BOLD, |w| Ok(w.write_all(b"[")?))?;
					if !a.is_empty() {
						self.seq(w, level, a.iter(), |w, x| self.write_at(w, level + 1, x))?;
					}
					self.styled(w, BOLD, |w| Ok(w.write_all(b"]")?))?;
				},
				Val::Obj(o) => {
					self.styled(w, BOLD, |w| Ok(w.write_all(b"{")?))?;
					let entry = |w: &mut W, (k, v): (&Val, &Val)| {
						match k {
							Val::TStr(k) | Val::BStr(k) => self.styled(w, BOLD, |w| write_str(w, k))?,
							k => return Err(WriteError::Key(k.clone())),
						}
						w.write_all(if self.indent.is_some() { b": " } else { b":" })?;
						self.write_at(w, level + 1, v)
					};
					if !o.is_empty() {
						if self.sort_keys {
							let mut o: Vec<_> = o.iter().collect();
							o.sort_by_key(|(k, _v)| *k);
							self.seq(w, level, o, entry)?;
						} else {
							self.seq(w, level, o.iter(), entry)?;
						}
					}
					self.styled(w, BOLD, |w| Ok(w.write_all(b"}")?))?;
				},
			}
			Ok(())
		}

		fn seq<W: Write + ?Sized, T>(
			&self,
			w: &mut W,
			level: usize,
			xs: impl IntoIterator<Item = T>,
			mut f: impl FnMut(&mut W, T) -> Result<(), WriteError>,
		) -> Result<(), WriteError> {
			let newline = |w: &mut W, level: usize| -> io::Result<()> {
				if let Some(indent) = &self.indent {
					w.write_all(b"\n")?;
					(0..level).try_for_each(|_| w.write_all(indent.as_bytes()))?;
				}
				Ok(())
			};
			for (i, x) in xs.into_iter().enumerate() {
				if i > 0 {
					w.write_all(b",")?;
				}
				newline(w, level + 1)?;
				f(w, x)?;
			}
			Ok(newline(w, level)?)
		}

		fn styled<W: Write + ?Sized>(
			&self,
			w: &mut W,
			style: &str,
			f: impl FnOnce(&mut W) -> Result<(), WriteError>,
		) -> Result<(), WriteError> {
			if !self.color {
				return f(w);
			}
			write!(w, "\x1b[{style}m")?;
			f(w)?;
			Ok(w.write_all(b"\x1b[0m")?)
		}
	}

	/// Whether `s` spells a number the way JSON's grammar does.
	fn is_json_number(s: &str) -> bool {
		let digits = |s: &[u8]| s.iter().take_while(|c| c.is_ascii_digit()).count();
		let s = s.strip_prefix('-').unwrap_or(s).as_bytes();
		let int = digits(s);
		if int == 0 || (int > 1 && s[0] == b'0') {
			return false;
		}
		let mut rest = &s[int..];
		if let Some(frac) = rest.strip_prefix(b".") {
			let n = digits(frac);
			if n == 0 {
				return false;
			}
			rest = &frac[n..];
		}
		match rest {
			[] => true,
			[b'e' | b'E', exp @ ..] => {
				let exp = exp.strip_prefix(b"+").or_else(|| exp.strip_prefix(b"-")).unwrap_or(exp);
				!exp.is_empty() && digits(exp) == exp.len()
			},
			_ => false,
		}
	}

	/// The sign and digits of the number literal `s`, without a leading `+` or
	/// leading zeros.
	fn respell(s: &str) -> (&str, &str) {
		let (sign, s) = match s.strip_prefix('-') {
			Some(rest) => ("-", rest),
			None => ("", s.strip_prefix('+').unwrap_or(s)),
		};
		let digits = s.trim_start_matches('0');
		// keep one zero before a fraction, an exponent, or the end
		if digits.starts_with(|c: char| c.is_ascii_digit()) {
			(sign, digits)
		} else {
			(sign, &s[s.len().saturating_sub(digits.len() + 1)..])
		}
	}

	/// A JSON string with the bytes of `s`, invalid UTF-8 replaced like jq.
	fn write_str<W: Write + ?Sized>(w: &mut W, s: &[u8]) -> Result<(), WriteError> {
		jaq_json::write_utf8!(w, s, |part| write!(w, "{}", jaq_json::bstr(part)))?;
		Ok(())
	}

	/// Runs `f` with standard output.
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

fn command(name: &'static str) -> Command {
	Command::new(name)
		.version(JAQ_VERSION)
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
		let cli = Cli::parse(itr.into_iter().map(Into::into).collect()).map_err(|error| {
			clap::Error::raw(ErrorKind::InvalidValue, format!("Error: {error}\n"))
		})?;
		if cli.version {
			return Err(command("jaq")
				.try_get_matches_from(["jaq", "--version"])
				.expect_err("--version always short-circuits"));
		}
		if cli.help {
			return Err(command("jaq")
				.try_get_matches_from(["jaq", "--help"])
				.expect_err("--help always short-circuits"));
		}
		Ok(Self { cli })
	}
}

impl Utility for Jq {
	const NAME: &'static str = "jq";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		color::init();
		color::set(false);

		let mut cli = self.cli;
		resolve_cli_paths(&mut cli, host);
		let stdout_is_terminal = host.stdout.is_terminal();
		let color = !cli.in_place && cli.color_if(|| stdout_is_terminal);

		let mut stdout = host.stdout_writer();
		match real_main(&cli, host, &mut stdout, color) {
			Ok(exit) => exit,
			Err(error) => {
				color::set(cli.color_if(|| stdout_is_terminal));
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
	for path in cli.rawfile.iter_mut().chain(&mut cli.slurpfile).map(|(_, path)| path) {
		*path = host.resolve(&*path).into_os_string();
	}
	if let Some(paths) = &mut cli.run_tests {
		for path in paths {
			*path = host.resolve(&*path);
		}
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
		}
	}

	fn cancelled(&self) -> bool {
		self.cancel.load(Ordering::Relaxed)
	}

	fn write_stderr(&self, bytes: &[u8]) {
		let _ = self.stderr.borrow_mut().write_all(bytes);
	}

	/// Tells the shell an input's error was reported and the run went on, so
	/// its exit status will not show it.
	fn report_error(&self) {
		if let Some(flag) = &self.reported_error {
			flag.store(true, Ordering::Relaxed);
		}
	}
}

mod color {
	use std::{cell::Cell, sync::Once};

	thread_local! {
		static COLOR: Cell<bool> = const { Cell::new(false) };
	}

	pub fn init() {
		static ONCE: Once = Once::new();
		ONCE.call_once(|| yansi::whenever(yansi::Condition(|| COLOR.with(Cell::get))));
	}

	pub fn set(on: bool) {
		COLOR.with(|color| color.set(on));
	}
}

fn real_main(
	cli: &Cli,
	host: &mut Host,
	stdout: &mut dyn Write,
	color: bool,
) -> Result<i32, Error> {
	let fs = host.fs().clone();
	let session = Session::new(host);
	if let Some(test_files) = &cli.run_tests {
		return Ok(match test_files.last() {
			Some(file) => {
				run_tests(
					&fs,
					&session,
					io::BufReader::new(fs.open(file)?),
					&mut host.stdout,
					&mut host.stderr,
				)
			},
			None => run_tests(
				&fs,
				&session,
				io::BufReader::new(&mut host.stdin),
				&mut host.stdout,
				&mut host.stderr,
			),
		});
	}

	let (vars, mut ctx): (Vec<String>, Vec<Val>) =
		binds(cli, &fs, &session.env)?.into_iter().unzip();

	let program = match &cli.filter {
		None => filter::Program::default(),
		Some(filter) => {
			let (path, code) = match filter {
				cli::Filter::FromFile(path) => (path.into(), fs.read_to_string(path)?),
				cli::Filter::Inline(filter) => ("<inline>".into(), filter.clone()),
			};
			filter::parse_compile(&fs, &path, &code, &vars, &cli.library_path)
				.map_err(Error::Report)?
		},
	};
	ctx.extend(program.vals);
	let counts_lines = program.counts_lines;

	let printer = output::Printer::new(cli, color);
	let run = |inputs: read::Vals<'_>, on_error, out: &mut dyn Write| {
		let filter = &program.filter;
		let mut buf = Vec::new();
		let print = |v: Val| printer.print(&mut buf, out, &v).map_err(Error::from);
		filter::run(cli.null_input, filter, &ctx, &session, on_error, inputs, print)
	};

	let last = if cli.files.is_empty() {
		let stdin = io::BufReader::new(&mut host.stdin);
		let inputs = read::stdin(cli, stdin, &session.input, counts_lines);
		output::with_stdout(stdout, |out| run(inputs, OnError::Continue, out))?
	} else if cli.in_place {
		let mut last = None;
		for operand in &cli.files {
			// Resolve the operand against the shell's cwd; all later path
			// operations (open, metadata, in-place temp+rename) use the
			// resolved path so nothing touches the host process cwd.
			let path = host.resolve(operand);
			let file = read::load_file(&fs, &path)
				.map_err(|e| Error::Io(Some(operand.display().to_string()), e))?;
			let file = (Val::from(operand.display().to_string()), file);
			let inputs = read::files(cli, core::iter::once(file), &session.input, counts_lines);

			// create a temporary file where output is written to,
			// in the resolved target's directory so the final rename
			// stays on the same filesystem
			let location = pi_vfs::parent_path(&path).unwrap_or(Path::new("."));
			let (tmp_path, tmp) = fs.create_temp(location, &TempOptions::new().prefix("jaq"))?;
			let mut out = io::BufWriter::new(tmp);
			let ran = run(inputs, OnError::Stop, &mut out);

			// replace the input file with the temporary file; `run` consumed
			// `inputs`, so the file's contents are already released
			let replaced = match ran {
				Ok(ran) => replace_with_temp(&fs, out, &tmp_path, &path)
					.map(|()| ran)
					.map_err(Error::from),
				Err(error) => {
					// Release the handle before the file is removed.
					let _ = out.into_parts().0.close();
					Err(error)
				},
			};
			if replaced.is_err() {
				// The operation filesystem may be cancelled; cleanup must
				// still run.
				let _ = fs.for_cleanup().remove_file(&tmp_path);
			}
			last = replaced?;
		}
		last
	} else {
		// Like jq, open each operand when the input stream reaches it, and
		// report one that cannot be read and go on with the others.
		let unreadable = Cell::new(false);
		let files = cli.files.iter().filter_map(|operand| {
			let name = operand.display().to_string();
			match read::load_file(&fs, &host.resolve(operand)) {
				Ok(file) => Some((Val::from(name), file)),
				Err(e) => {
					session.write_stderr(Error::Io(Some(name), e).to_string().as_bytes());
					unreadable.set(true);
					None
				},
			}
		});
		let inputs = read::files(cli, files, &session.input, counts_lines);
		let last = output::with_stdout(stdout, |out| run(inputs, OnError::Continue, out))?;
		if unreadable.get() {
			return Err(Error::Unreadable);
		}
		last
	};

	if cli.exit_status {
		last.map_or_else(|| Err(Error::NoOutput), |b| if b { Ok(0) } else { Err(Error::FalseOrNull) })
	} else {
		Ok(0)
	}
}

/// Publishes an in-place result: closes the temporary file (surfacing any
/// deferred write error), gives it the target's permissions, and renames it
/// over the target.
fn replace_with_temp(
	fs: &BlockingFs,
	out: io::BufWriter<File>,
	tmp_path: &Path,
	path: &Path,
) -> io::Result<()> {
	out.into_inner()
		.map_err(|error| {
			let (error, out) = error.into_parts();
			// Release the handle before the caller removes the file.
			let _ = out.into_parts().0.close();
			error
		})?
		.close()?;
	let perms = fs.metadata(path)?.permissions();
	fs.set_permissions(tmp_path, perms)?;
	fs.rename(tmp_path, path)
}

fn binds(cli: &Cli, fs: &BlockingFs, env: &Val) -> Result<Vec<(String, Val)>, Error> {
	let arg = cli.arg.iter().map(|(k, s)| Ok((k.to_owned(), Val::from(s.to_owned()))));
	let argjson = cli.argjson.iter().map(|(k, s)| {
		let err = |e| Error::Parse(format!("{e} (for value passed to `--argjson {k}`)"));
		Ok((k.to_owned(), jaq_json::read::parse_single(s.as_bytes()).map_err(err)?))
	});
	let rawfile = cli.rawfile.iter().map(|(k, path)| {
		let s = fs.read_to_string(Path::new(path))
			.map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), Val::from(s?)))
	});
	let slurpfile = cli.slurpfile.iter().map(|(k, path)| {
		let a = read::json_array(fs, Path::new(path))
			.map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), a?))
	});

	let positional = cli.args.iter().cloned().map(|s| Ok(Val::from(s)));
	let positional = positional.collect::<Result<Vec<_>, Error>>()?;

	let var_val = arg.chain(rawfile).chain(slurpfile).chain(argjson);
	let mut var_val = var_val.collect::<Result<Vec<_>, Error>>()?;

	var_val.push(("ARGS".to_string(), args(&positional, &var_val)));
	// the shell's exported environment, not the host process environment
	var_val.push(("ENV".to_string(), env.clone()));

	Ok(var_val)
}

fn args(positional: &[Val], named: &[(String, Val)]) -> Val {
	let key = |k: &str| Val::from(k.to_string());
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
	/// Some file operand could not be read; each was reported when loading.
	Unreadable,
	Halt(i32),
	FalseOrNull,
	NoOutput,
}

impl Display for Error {
	fn fmt(&self, f: &mut Formatter) -> fmt::Result {
		match self {
			Self::FalseOrNull | Self::NoOutput | Self::Halt(_) | Self::Unreadable => Ok(()),
			Self::Io(prefix, e) => {
				write!(f, "Error: ")?;
				if let Some(p) = prefix {
					write!(f, "{p}: ")?;
				}
				writeln!(f, "{e}")
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
			Self::Io(..) | Self::Unreadable => 2,
			Self::Report(_) => 3,
			Self::NoOutput => 4,
			Self::Parse(_) | Self::Jaq(_) => 5,
			Self::Halt(code) => *code,
		}
	}
}

impl From<io::Error> for Error {
	fn from(e: io::Error) -> Self {
		Self::Io(None, e)
	}
}

impl From<jaq_core::Exn<'_, Val>> for Error {
	fn from(exn: jaq_core::Exn<'_, Val>) -> Self {
		match exn.get_err() {
			Ok(e) => Self::Jaq(e),
			Err(exn) => Self::Halt(exn.get_halt().expect("only errors and halts escape a filter")),
		}
	}
}

impl From<output::WriteError> for Error {
	fn from(e: output::WriteError) -> Self {
		match e {
			output::WriteError::Io(e) => Self::Io(None, e),
			output::WriteError::Key(key) => Self::Jaq(jaq_core::Error::typ(key, "object key")),
		}
	}
}

/// One jq unit test (`--run-tests`): a filter, an input, and the expected
/// outputs, one per line, ended by a blank line.
struct Test {
	filter: String,
	input:  String,
	output: Vec<String>,
}

fn parse_tests(mut lines: impl Iterator<Item = String>) -> impl Iterator<Item = Test> {
	core::iter::from_fn(move || {
		Some(Test {
			filter: lines.find(|l| !(l.is_empty() || l.starts_with('#')))?,
			input:  lines.next()?,
			output: lines.by_ref().take_while(|l| !l.is_empty()).collect(),
		})
	})
}

fn run_test(fs: &BlockingFs, session: &Session, test: Test) -> Result<(Val, Val), Error> {
	let program = filter::parse_compile(fs, &PathBuf::new(), &test.filter, &[], &[])
		.map_err(Error::Report)?;

	let json = |s: &str| jaq_json::read::parse_many(s.as_bytes()).collect::<Result<Val, _>>();
	let input = jaq_json::read::parse_single(test.input.as_bytes())
		.map_err(|e| Error::Parse(e.to_string()))?;
	let expect = json(&test.output.join("\n")).map_err(|e| Error::Parse(e.to_string()))?;
	let mut obtain = Vec::new();
	let inputs = core::iter::once(Ok(input));
	filter::run(false, &program.filter, &program.vals, session, OnError::Stop, inputs, |v| {
		obtain.push(v);
		Ok(())
	})?;
	Ok((expect, obtain.into_iter().collect()))
}

fn run_tests(
	fs: &BlockingFs,
	session: &Session,
	read: impl BufRead,
	stdout: &mut dyn Write,
	stderr: &mut dyn Write,
) -> i32 {
	let tests = parse_tests(read.lines().map_while(Result::ok));

	let (mut passed, mut total) = (0, 0);
	for test in tests {
		if session.cancelled() {
			break;
		}
		let _ = writeln!(stdout, "Testing {}", test.filter);
		match run_test(fs, session, test) {
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
	use std::{collections::HashMap, io, io::Write, path::PathBuf};

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
		let argv = std::iter::once("jq").chain(args.iter().copied());
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

	/// Runs jq with `out` as its standard output; returns the exit status.
	fn run_jq_into(out: &mut Writes, args: &[&str], stdin: &str) -> i32 {
		let (mut host, _) = Host::for_test("jq", stdin, ".");
		let argv = std::iter::once("jq").chain(args.iter().copied());
		let cli = Jq::try_parse_from(argv).expect("valid arguments").cli;
		super::real_main(&cli, &mut host, out, false).unwrap_or_else(|error| error.report())
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
	}

	#[test]
	fn unreadable_operand_is_reported_and_skipped() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("in.json"), "1").expect("write input");
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &[".", "nope.json", "in.json"], "");
		assert_eq!(code, 2);
		assert_eq!(out, "1\n", "readable operands are still processed");
		assert!(err.starts_with("Error: nope.json: "), "stderr names the operand: {err:?}");

		// operands are opened as the input stream reaches them
		let (code, out, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["halt", "in.json", "nope.json"], "");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));

		// a data file jaq cannot parse
		std::fs::write(dir.path().join("bad.json"), "1 xyz").expect("write bad input");
		let args = ["-n", "--slurpfile", "n", "bad.json", "$n"];
		let (code, _, err) = run_jq_in(dir.path().to_path_buf(), HashMap::new(), &args, "");
		assert_eq!(code, 2);
		assert!(err.starts_with("Error: "), "stderr: {err:?}");
	}

	#[test]
	fn output_stays_json_where_jaq_extends_it() {
		let (code, out, _) = run_jq(&["-nc", "[nan, infinite, -infinite]"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "[null,1.7976931348623157e+308,-1.7976931348623157e+308]\n");

		for filter in ["{(1): 2}", "[{(1): 2}]", "{a: 1, b: {(2): 3}}"] {
			let (code, out, err) = run_jq(&["-nc", filter], "");
			assert_eq!((code, out.as_str()), (5, ""), "nothing of {filter} is written");
			assert!(err.contains("as object key\n"), "stderr: {err:?}");
		}
		let (code, _, err) = run_jq(&["-nc", "{(1): 2} | debug | empty"], "");
		assert_eq!(code, 5);
		assert!(err.starts_with("Error: cannot use 1 as object key\n"), "stderr: {err:?}");

		// jaq keeps number literals as written, and reads some JSON cannot spell;
		// those print respelled with every digit kept
		let input = "[0.50,+1.5,1e2,+9007199254740993.0,+01e-999]";
		let (code, out, _) = run_jq(&["-c", ". + [\"01.5\" | tonumber]"], input);
		assert_eq!((code, out.as_str()), (0, "[0.50,1.5,1e2,9007199254740993.0,1e-999,1.5]\n"));

		// byte strings print as JSON strings, and raw with `-r`
		let (code, out, _) = run_jq(&["-n", "\"hi\" | tobytes"], "");
		assert_eq!((code, out.as_str()), (0, "\"hi\"\n"));
		let (code, out, _) = run_jq(&["-nr", "\"hi\" | tobytes"], "");
		assert_eq!((code, out.as_str()), (0, "hi\n"));
	}

	#[test]
	fn tonumber_parses_one_number_literal_like_jq() {
		let input = "[\"021\",\"+17.1\",\"-3\",\"1.50\",5]";
		let (code, out, _) = run_jq(&["-c", "map(tonumber)"], input);
		assert_eq!((code, out.as_str()), (0, "[21,17.1,-3,1.50,5]\n"));

		let input = "[\"1 2\",\" 1\",\"0x10\",\"\",null]";
		let (code, out, _) = run_jq(&["-c", "map(try tonumber catch \"no\")"], input);
		assert_eq!((code, out.as_str()), (0, "[\"no\",\"no\",\"no\",\"no\",\"no\"]\n"));
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
		std::fs::write(dir.path().join("in.json"), "{\"a\":1}").expect("write input");
		let (code, _, err) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-c", "-i", ".a", "in.json"], "");
		assert_eq!(code, 0, "stderr: {err:?}");
		let rewritten = std::fs::read_to_string(dir.path().join("in.json")).expect("read back");
		assert_eq!(rewritten, "1\n");
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
	fn in_place_edit_leaves_file_on_error() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("in.json"), "1 \"a\" 2").expect("write input");
		let (code, _, _) =
			run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-i", ". + 1", "in.json"], "");
		assert_eq!(code, 5);
		let kept = std::fs::read_to_string(dir.path().join("in.json")).expect("read back");
		assert_eq!(kept, "1 \"a\" 2");
	}

	#[test]
	fn error_in_one_input_does_not_stop_the_rest() {
		// like jq, report it and go on; the exit status follows the last input
		let (code, out, err) = run_jq(&[". + 1"], "1 \"a\" 2");
		assert_eq!((code, out.as_str()), (0, "2\n3\n"));
		assert_eq!(err, "Error: cannot calculate \"a\" + 1\n");

		let (code, out, err) = run_jq(&[". + 1"], "1 2 \"a\"");
		assert_eq!((code, out.as_str()), (5, "2\n3\n"));
		assert_eq!(err, "Error: cannot calculate \"a\" + 1\n");

		// also when the error is raised while printing
		let (code, out, err) = run_jq(&["-c", "{(.): 1}"], "\"a\" 1 \"b\"");
		assert_eq!((code, out.as_str()), (0, "{\"a\":1}\n{\"b\":1}\n"));
		assert_eq!(err, "Error: cannot use 1 as object key\n");

		// a failed write still ends the run
		let mut out = Writes { fail: true, ..Writes::default() };
		assert_eq!(run_jq_into(&mut out, &["."], "1 2 3"), 2);
		assert_eq!(out.calls, [b"1\n"]);
	}

	#[test]
	fn printer_writes_each_value_at_once() {
		let mut out = Writes::default();
		assert_eq!(run_jq_into(&mut out, &["."], "{\"a\":[1,\"x\"]} 2"), 0);
		let pretty: &[u8] = b"{\n  \"a\": [\n    1,\n    \"x\"\n  ]\n}\n";
		assert_eq!(out.calls, [pretty, b"2\n"]);
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
		let (code, out, err) = run_jq(&["-n", "\"bye\\n\" | halt_error(3)"], "");
		assert_eq!((code, out.as_str(), err.as_str()), (3, "", "bye\n"), "string printed raw");

		let (code, _, err) = run_jq(&["-n", "{\"a\":1} | halt_error"], "");
		assert_eq!((code, err.as_str()), (5, "{\"a\":1}\n"), "anything else as JSON");

		let (code, _, err) = run_jq(&["-n", "null | halt_error(1)"], "");
		assert_eq!((code, err.as_str()), (1, ""), "null prints nothing");

		let (code, _, err) = run_jq(&["-n", "[nan, infinite] | halt_error(7)"], "");
		assert_eq!((code, err.as_str()), (7, "[null,1.7976931348623157e+308]\n"), "still JSON");

		let (code, _, err) = run_jq(&["-n", "\"msg\" | halt_error(\"x\")"], "");
		assert_eq!(code, 5);
		assert!(err.starts_with("Error: cannot use \"x\" as integer\n"), "nothing printed: {err:?}");
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
	fn version_flag_prints_and_exits_0() {
		let (code, out, _) = run_jq(&["--version"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "jaq 3.1.1\n");
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
		std::fs::write(dir.path().join("f.jq"), ".a + 1").expect("write filter");
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
	fn unbuffered_flag_is_accepted() {
		let (code, out, err) = run_jq(&["--unbuffered", "-c", ".[]"], "[1,{\"a\":2}]");
		assert_eq!((code, out.as_str(), err.as_str()), (0, "1\n{\"a\":2}\n", ""));
	}

	#[test]
	fn positional_args_after_double_dash_args() {
		let (code, out, _) = run_jq(&["-nc", "$ARGS.positional", "--args", "x", "y"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "[\"x\",\"y\"]\n");
	}
}
