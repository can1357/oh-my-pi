//! The tree-walking interpreter, after GoAWK's `interp` package: lazy field
//! splitting, record I/O through the host, output redirection, and command
//! pipes run through the shell.

use std::{
	cmp::Ordering,
	ffi::OsString,
	io::{self, BufWriter, Seek as _, SeekFrom, Write as _},
	path::PathBuf,
	rc::Rc,
	time::{SystemTime, UNIX_EPOCH},
};

use rand::{RngExt as _, SeedableRng as _, rngs::StdRng};
use rustc_hash::FxHashMap;

use super::{
	ast::{
		ArraySlot, BinOp, Expr, GetlineSrc, Param, Pattern, Program, Redirect, Slot, Special, Stmt, UnOp,
	},
	format::{char_count, char_prefix, sprintf},
	io::{RecordReader, RecordSep},
	lexer::Func,
	regex::AwkRegex,
	value::{Bytes, Value, push_number},
};
use crate::{
	host::{Host, RunningCommand, ShellCommand, StreamWriter, strip_errno},
	openfile::Fd,
};

/// Why evaluation stopped early.
pub(super) enum Stop {
	/// A runtime error: `awk: <message>`, status 2.
	Error(String),
	Next,
	NextFile,
	Exit,
	Cancelled,
	/// The output reader went away (emulated SIGPIPE).
	Quiet,
}

type R<T> = Result<T, Stop>;

fn error<T>(message: impl Into<String>) -> R<T> {
	Err(Stop::Error(message.into()))
}

/// How a statement finished.
enum Flow {
	Normal,
	Break,
	Continue,
	Return(Value),
}

/// How `FS` (or a `split` separator) splits a string.
#[derive(Clone)]
enum FieldSep {
	/// `" "`: runs of blanks and newlines, ignoring leading/trailing ones.
	Space,
	/// A single character (or `""`, which splits into characters).
	Chars(Bytes),
	Regex(Rc<AwkRegex>),
}

pub(super) type Array = FxHashMap<Bytes, Value>;

/// One user-function activation.
struct Frame {
	/// Start of this frame's scalars in `Interp::locals`.
	scalars: usize,
	/// Indexes into `Interp::arrays` of this frame's array parameters.
	arrays:  Vec<usize>,
}

/// An assignable location, with any subscript or field index evaluated.
enum Place {
	Global(usize),
	Local(usize),
	Special(Special),
	Elem(usize, Bytes),
	Field(usize),
}

enum OutKind {
	Stdout,
	Stderr,
	File(BufWriter<pi_vfs::File>),
	/// `print | cmd`: collected, run when closed.
	Pipe(Vec<u8>),
}

struct Output {
	kind:  OutKind,
	/// Opening order, so pipes left open run in order at exit.
	order: u64,
}

struct Input {
	reader:  RecordReader,
	command: Option<RunningCommand>,
}

/// Largest field index or `NF` value accepted.
const MAX_FIELD: f64 = 10_000_000.0;
/// Deepest user-function call nesting.
const MAX_DEPTH: usize = 50_000;
/// Dynamic regexes cached per run.
const MAX_CACHED_REGEXES: usize = 128;

/// What the command line hands the interpreter.
pub(super) struct Setup {
	/// `ARGV[0]` and the operands.
	pub argv:    Vec<Vec<u8>>,
	/// `-F` value (escape-processed).
	pub fs:      Option<Vec<u8>>,
	/// `-v` assignments (escape-processed).
	pub assigns: Vec<(String, Vec<u8>)>,
}

pub(super) struct Interp<'a> {
	prog:         &'a Program,
	host:         &'a mut Host,
	stdout:       StreamWriter,
	empty:        Bytes,
	globals:      Vec<Value>,
	arrays:       Vec<Array>,
	locals:       Vec<Value>,
	frames:       Vec<Frame>,

	record:       Vec<u8>,
	scratch:      Vec<u8>,
	record_str:   bool,
	split_done:   bool,
	spans:        Vec<(usize, usize)>,
	fields:       Option<Vec<Value>>,
	nf:           usize,
	split_fs:     FieldSep,
	split_para:   bool,

	nr:           Value,
	fnr:          Value,
	filename:     Value,
	rstart:       Value,
	rlength:      Value,
	argc:         Value,
	fs:           Bytes,
	fs_sep:       FieldSep,
	ofs:          Bytes,
	ors:          Bytes,
	rs:           Bytes,
	rs_sep:       RecordSep,
	subsep:       Bytes,
	convfmt:      Bytes,
	ofmt:         Bytes,

	main:         Option<RecordReader>,
	argv_index:   usize,
	had_files:    bool,
	inputs:       FxHashMap<Bytes, Input>,
	outputs:      FxHashMap<Bytes, Output>,
	output_order: u64,
	regexes:      FxHashMap<Bytes, Rc<AwkRegex>>,
	rng:          StdRng,
	seed:         f64,
	range_active: Vec<bool>,
	print_buf:    Vec<u8>,
	exit_status:  i32,
	/// An input file could not be opened (gawk goes on, exiting 2).
	input_failed: bool,
}

const fn is_blank(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// Whether `arg` is a `name=value` operand assignment; returns the split.
pub(super) fn split_assignment(arg: &[u8]) -> Option<(String, Vec<u8>)> {
	let eq = arg.iter().position(|&c| c == b'=')?;
	let name = &arg[..eq];
	let valid = name.first().is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
		&& name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_');
	valid.then(|| (String::from_utf8_lossy(name).into_owned(), super::lexer::unescape(&arg[eq + 1..])))
}

pub(super) fn os_string(bytes: &[u8]) -> OsString {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStringExt as _;
		OsString::from_vec(bytes.to_vec())
	}
	#[cfg(not(unix))]
	{
		OsString::from(String::from_utf8_lossy(bytes).into_owned())
	}
}

fn path_of(bytes: &[u8]) -> PathBuf {
	PathBuf::from(os_string(bytes))
}

fn display(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes).into_owned()
}

/// An AWK command string, run by the invoking shell as a command line (as
/// `sh -c` would), so builtins and `scheme://` paths work in it.
fn shell(script: &[u8]) -> ShellCommand {
	ShellCommand::line(os_string(script))
}

/// Splits `text` per `sep` into byte spans; with `newline_too` (paragraph
/// mode and a one-character `FS`), newlines also separate fields.
fn split_spans(text: &[u8], sep: &FieldSep, newline_too: bool, spans: &mut Vec<(usize, usize)>) {
	spans.clear();
	match sep {
		FieldSep::Space => {
			let mut i = 0;
			loop {
				while i < text.len() && is_blank(text[i]) {
					i += 1;
				}
				if i >= text.len() {
					break;
				}
				let start = i;
				while i < text.len() && !is_blank(text[i]) {
					i += 1;
				}
				spans.push((start, i));
			}
		},
		_ if text.is_empty() => {},
		FieldSep::Chars(chars) if chars.is_empty() => {
			let mut i = 0;
			while i < text.len() {
				let len = char_prefix(&text[i..], 1).max(1);
				spans.push((i, i + len));
				i += len;
			}
		},
		FieldSep::Chars(chars) => {
			let mut start = 0;
			for at in memchr::memmem::find_iter(text, &chars[..]) {
				spans.push((start, at));
				start = at + chars.len();
			}
			spans.push((start, text.len()));
			if newline_too {
				let whole = std::mem::take(spans);
				for (s, e) in whole {
					let mut start = s;
					for at in memchr::memchr_iter(b'\n', &text[s..e]) {
						let end = s + at;
						let end = if end > start && text[end - 1] == b'\r' { end - 1 } else { end };
						spans.push((start, end));
						start = s + at + 1;
					}
					spans.push((start, e));
				}
			}
		},
		FieldSep::Regex(regex) => {
			let mut start = 0;
			let mut pos = 0;
			while pos <= text.len() {
				match regex.find_at(text, pos) {
					Some((s, e)) if e > s => {
						spans.push((start, s));
						start = e;
						pos = e;
					},
					Some((s, _)) => pos = s + 1,
					None => break,
				}
			}
			spans.push((start, text.len()));
		},
	}
}

/// Byte offset of character `index` (0-based) in `s`.
fn char_offset(s: &[u8], index: usize) -> usize {
	char_prefix(s, index)
}

impl<'a> Interp<'a> {
	pub fn new(prog: &'a Program, host: &'a mut Host, setup: Setup) -> R<Self> {
		let empty: Bytes = Rc::from(&b""[..]);
		let stdout = host.stdout_writer();
		let mut interp = Self {
			prog,
			stdout,
			globals: vec![Value::Null; prog.scalars.len()],
			arrays: (0..prog.arrays.len()).map(|_| Array::default()).collect(),
			locals: Vec::new(),
			frames: Vec::new(),
			record: Vec::new(),
			scratch: Vec::new(),
			record_str: false,
			split_done: false,
			spans: Vec::new(),
			fields: None,
			nf: 0,
			split_fs: FieldSep::Space,
			split_para: false,
			nr: Value::Num(0.0),
			fnr: Value::Num(0.0),
			filename: Value::Null,
			rstart: Value::Num(0.0),
			rlength: Value::Num(-1.0),
			argc: Value::Num(setup.argv.len() as f64),
			fs: Rc::from(&b" "[..]),
			fs_sep: FieldSep::Space,
			ofs: Rc::from(&b" "[..]),
			ors: Rc::from(&b"\n"[..]),
			rs: Rc::from(&b"\n"[..]),
			rs_sep: RecordSep::Newline,
			subsep: Rc::from(&b"\x1c"[..]),
			convfmt: Rc::from(&b"%.6g"[..]),
			ofmt: Rc::from(&b"%.6g"[..]),
			main: None,
			argv_index: 1,
			had_files: false,
			inputs: FxHashMap::default(),
			outputs: FxHashMap::default(),
			output_order: 0,
			regexes: FxHashMap::default(),
			rng: StdRng::seed_from_u64(0),
			seed: 0.0,
			range_active: vec![false; prog.actions.len()],
			print_buf: Vec::new(),
			exit_status: 0,
			input_failed: false,
			empty,
			host,
		};
		if let Some(argv) = prog.array_slot("ARGV") {
			for (index, arg) in setup.argv.iter().enumerate() {
				interp.arrays[argv].insert(Rc::from(index.to_string().into_bytes()), Value::strnum(arg));
			}
		}
		if let Some(environ) = prog.array_slot("ENVIRON") {
			let vars: Vec<(Bytes, Value)> = interp
				.host
				.env()
				.map(|(key, value)| (Rc::from(key.as_bytes()), Value::strnum(value.as_bytes())))
				.collect();
			interp.arrays[environ].extend(vars);
		}
		if let Some(fs) = setup.fs {
			interp.set_special(Special::Fs, Value::strnum(&fs))?;
		}
		for (name, value) in setup.assigns {
			interp.assign_named(&name, &value)?;
		}
		Ok(interp)
	}

	/// The exit status `exit` set, or 2 after an unreadable input file.
	pub fn status(&self) -> i32 {
		if self.exit_status == 0 && self.input_failed { 2 } else { self.exit_status.rem_euclid(256) }
	}

	fn check_cancel(&self) -> R<()> {
		if self.host.is_cancelled() { Err(Stop::Cancelled) } else { Ok(()) }
	}

	fn write_error(&self, err: &io::Error) -> Stop {
		if self.host.sigpipe_hit() || err.kind() == io::ErrorKind::BrokenPipe {
			Stop::Quiet
		} else {
			Stop::Error(format!("write error: {}", strip_errno(err)))
		}
	}

	fn assign_named(&mut self, name: &str, value: &[u8]) -> R<()> {
		let value = Value::strnum(value);
		if let Some(special) = Special::lookup(name) {
			return self.set_special(special, value);
		}
		if let Some(slot) = self.prog.scalar_slot(name) {
			self.globals[slot] = value;
		} else if self.prog.array_slot(name).is_some() {
			return error(format!("can't assign to {name}; it's an array name."));
		}
		Ok(())
	}

	// ── Running the program ─────────────────────────────────────────────

	/// Runs `BEGIN`, the main loop and `END`.
	pub fn execute(&mut self) -> R<()> {
		let prog = self.prog;
		let mut exited = false;
		for block in &prog.begin {
			match self.exec_block(block) {
				Ok(_) => {},
				Err(Stop::Exit) => {
					exited = true;
					break;
				},
				Err(Stop::Next | Stop::NextFile) => return error("next used in BEGIN or END action"),
				Err(stop) => return Err(stop),
			}
		}
		if prog.actions.is_empty() && prog.end.is_empty() {
			return Ok(());
		}
		if !exited {
			match self.main_loop() {
				Ok(()) | Err(Stop::Exit) => {},
				Err(stop) => return Err(stop),
			}
		}
		for block in &prog.end {
			match self.exec_block(block) {
				Ok(_) => {},
				Err(Stop::Exit) => break,
				Err(Stop::Next | Stop::NextFile) => return error("next used in BEGIN or END action"),
				Err(stop) => return Err(stop),
			}
		}
		Ok(())
	}

	fn main_loop(&mut self) -> R<()> {
		let prog = self.prog;
		'records: while self.next_record()? {
			for (index, action) in prog.actions.iter().enumerate() {
				match self.run_action(index, &action.pattern, action.body.as_deref()) {
					Ok(()) => {},
					Err(Stop::Next) => continue 'records,
					Err(Stop::NextFile) => {
						self.main = None;
						continue 'records;
					},
					Err(stop) => return Err(stop),
				}
			}
		}
		Ok(())
	}

	fn run_action(&mut self, index: usize, pattern: &Pattern, body: Option<&[Stmt]>) -> R<()> {
		let matched = match pattern {
			Pattern::All => true,
			Pattern::Expr(expr) => self.eval(expr)?.truthy(),
			Pattern::Range(start, stop) => {
				if !self.range_active[index] {
					self.range_active[index] = self.eval(start)?.truthy();
				}
				let matched = self.range_active[index];
				if matched {
					self.range_active[index] = !self.eval(stop)?.truthy();
				}
				matched
			},
		};
		if !matched {
			return Ok(());
		}
		match body {
			None => {
				let mut line = std::mem::take(&mut self.print_buf);
				line.clear();
				line.extend_from_slice(&self.record);
				line.extend_from_slice(&self.ors);
				let result = self.stdout.write_all(&line).map_err(|err| self.write_error(&err));
				self.print_buf = line;
				result
			},
			Some(body) => self.exec_block(body).map(|_| ()),
		}
	}

	/// Closes every stream: input commands are reaped, files flushed, and
	/// pipes still open run in the order they were opened.
	pub fn close_all(&mut self) -> R<()> {
		let inputs = std::mem::take(&mut self.inputs);
		for (_, input) in inputs {
			let Input { reader, command } = input;
			drop(reader);
			if let Some(command) = command {
				let _ = command.wait();
			}
		}
		let mut outputs: Vec<(Bytes, Output)> = std::mem::take(&mut self.outputs).into_iter().collect();
		outputs.sort_by_key(|(_, output)| output.order);
		let mut result = Ok(());
		for (name, output) in outputs {
			if let Err(stop) = self.close_output(&name, output.kind) {
				result = Err(stop);
				break;
			}
		}
		let flushed = self.stdout.flush().map_err(|err| self.write_error(&err));
		let _ = self.host.stderr.flush();
		result.and(flushed)
	}

	// ── Statements ──────────────────────────────────────────────────────

	fn exec_block(&mut self, stmts: &[Stmt]) -> R<Flow> {
		for stmt in stmts {
			match self.exec(stmt)? {
				Flow::Normal => {},
				flow => return Ok(flow),
			}
		}
		Ok(Flow::Normal)
	}

	/// Runs a loop body; `Some` is a flow that ends the loop.
	fn loop_body(&mut self, body: &[Stmt]) -> R<Option<Flow>> {
		self.check_cancel()?;
		Ok(match self.exec_block(body)? {
			Flow::Normal | Flow::Continue => None,
			Flow::Break => Some(Flow::Normal),
			flow @ Flow::Return(_) => Some(flow),
		})
	}

	fn exec(&mut self, stmt: &Stmt) -> R<Flow> {
		match stmt {
			Stmt::Print { args, redirect } => self.print(args, redirect.as_ref())?,
			Stmt::Printf { args, redirect } => self.printf(args, redirect.as_ref())?,
			Stmt::Expr(expr) => {
				self.eval(expr)?;
			},
			Stmt::If { cond, body, els } => {
				let branch = if self.eval(cond)?.truthy() { body } else { els };
				return self.exec_block(branch);
			},
			Stmt::For { pre, cond, post, body } => {
				if let Some(pre) = pre {
					self.exec(pre)?;
				}
				loop {
					if let Some(cond) = cond
						&& !self.eval(cond)?.truthy()
					{
						break;
					}
					if let Some(flow) = self.loop_body(body)? {
						return Ok(flow);
					}
					if let Some(post) = post {
						self.exec(post)?;
					}
				}
			},
			Stmt::ForIn { var, array, body } => {
				let index = self.array_index(array.slot)?;
				let keys: Vec<Bytes> = self.arrays[index].keys().cloned().collect();
				for key in keys {
					self.set_scalar(var.slot, Value::Str(key))?;
					if let Some(flow) = self.loop_body(body)? {
						return Ok(flow);
					}
				}
			},
			Stmt::While { cond, body } => {
				while self.eval(cond)?.truthy() {
					if let Some(flow) = self.loop_body(body)? {
						return Ok(flow);
					}
				}
			},
			Stmt::DoWhile { body, cond } => loop {
				if let Some(flow) = self.loop_body(body)? {
					return Ok(flow);
				}
				if !self.eval(cond)?.truthy() {
					break;
				}
			},
			Stmt::Break => return Ok(Flow::Break),
			Stmt::Continue => return Ok(Flow::Continue),
			Stmt::Next => return Err(Stop::Next),
			Stmt::NextFile => return Err(Stop::NextFile),
			Stmt::Exit(status) => {
				if let Some(status) = status {
					let n = self.eval(status)?.num();
					self.exit_status = if n.is_finite() { n as i64 as i32 } else { 0 };
				}
				return Err(Stop::Exit);
			},
			Stmt::Return(value) => {
				let value = match value {
					Some(value) => self.eval(value)?,
					None => Value::Null,
				};
				return Ok(Flow::Return(value));
			},
			Stmt::Delete { array, index } => {
				let slot = self.array_index(array.slot)?;
				match index {
					Some(index) => {
						let key = self.subscript(index)?;
						self.arrays[slot].remove(&key[..]);
					},
					None => self.arrays[slot].clear(),
				}
			},
			Stmt::Block(body) => return self.exec_block(body),
		}
		Ok(Flow::Normal)
	}

	fn print(&mut self, args: &[Expr], redirect: Option<&(Redirect, Expr)>) -> R<()> {
		let mut line = std::mem::take(&mut self.print_buf);
		line.clear();
		if args.is_empty() {
			line.extend_from_slice(&self.record);
		}
		for (index, arg) in args.iter().enumerate() {
			if index > 0 {
				line.extend_from_slice(&self.ofs);
			}
			let value = self.eval(arg)?;
			match &value {
				Value::Null => {},
				Value::Num(n) => push_number(&mut line, *n, &self.ofmt),
				Value::Str(s) | Value::StrNum(s) => line.extend_from_slice(s),
			}
		}
		line.extend_from_slice(&self.ors);
		let result = self.emit(redirect, &line);
		self.print_buf = line;
		result
	}

	fn printf(&mut self, args: &[Expr], redirect: Option<&(Redirect, Expr)>) -> R<()> {
		let text = self.sprintf_args(args)?;
		self.emit(redirect, &text)
	}

	fn sprintf_args(&mut self, args: &[Expr]) -> R<Vec<u8>> {
		let Some((format, rest)) = args.split_first() else {
			return Ok(Vec::new());
		};
		let format = self.eval(format)?;
		let format = self.to_str(&format);
		let mut values = Vec::with_capacity(rest.len());
		for arg in rest {
			values.push(self.eval(arg)?);
		}
		let mut out = Vec::new();
		sprintf(&mut out, &format, &values, &self.convfmt).map_err(Stop::Error)?;
		Ok(out)
	}

	/// Writes `data` to stdout or to a redirection target.
	fn emit(&mut self, redirect: Option<&(Redirect, Expr)>, data: &[u8]) -> R<()> {
		let Some((kind, dest)) = redirect else {
			return self.stdout.write_all(data).map_err(|err| self.write_error(&err));
		};
		let dest = self.eval(dest)?;
		let name = self.to_str(&dest);
		if !self.outputs.contains_key(&name[..]) {
			self.open_output(*kind, &name)?;
		}
		let Some(output) = self.outputs.get_mut(&name[..]) else {
			return error(format!("can't redirect to {}", display(&name)));
		};
		let result = match &mut output.kind {
			OutKind::Stdout => self.stdout.write_all(data),
			OutKind::Stderr => self.host.stderr.write_all(data),
			OutKind::File(file) => file.write_all(data),
			OutKind::Pipe(buffer) => {
				buffer.extend_from_slice(data);
				Ok(())
			},
		};
		result.map_err(|err| self.write_error(&err))
	}

	fn open_output(&mut self, kind: Redirect, name: &Bytes) -> R<()> {
		if self.inputs.contains_key(&name[..]) {
			return error(format!("can't write to reader stream {}", display(name)));
		}
		let out = match (kind, &name[..]) {
			(Redirect::Pipe, _) => OutKind::Pipe(Vec::new()),
			(_, b"-" | b"/dev/stdout") => OutKind::Stdout,
			(_, b"/dev/stderr") => OutKind::Stderr,
			(_, path) => {
				let mut options = pi_vfs::OpenOptions::new();
				if kind == Redirect::Append {
					options.append(true);
				} else {
					options.truncate(true);
				}
				options.write(true).create(true);
				let resolved = self.host.resolve(path_of(path));
				let file = self.host.fs().open_with(&resolved, &options).map_err(|err| {
					Stop::Error(format!("output redirection error: {}: {}", display(path), strip_errno(&err)))
				})?;
				OutKind::File(BufWriter::new(file))
			},
		};
		self.output_order += 1;
		self.outputs.insert(Rc::clone(name), Output { kind: out, order: self.output_order });
		Ok(())
	}

	/// Flushes a closed output stream (running a collected pipe); its
	/// `close()` status.
	fn close_output(&mut self, name: &[u8], kind: OutKind) -> R<i32> {
		Ok(match kind {
			OutKind::Stdout => self.stdout.flush().map_err(|err| self.write_error(&err)).map(|()| 0)?,
			OutKind::Stderr => i32::from(self.host.stderr.flush().is_err()).wrapping_neg(),
			OutKind::File(mut file) => match file.flush() {
				Ok(()) => 0,
				Err(err) => {
					self.warn(format!("error closing {}: {}", display(name), strip_errno(&err)));
					-1
				},
			},
			OutKind::Pipe(data) => self.run_pipe(name, &data)?,
		})
	}

	fn warn(&mut self, message: impl std::fmt::Display) {
		let _ = self.stdout.flush();
		let _ = writeln!(self.host.stderr, "awk: {message}");
	}

	/// Flushes stdout and every output file, so commands see output in order.
	fn flush_all(&mut self) -> R<()> {
		for output in self.outputs.values_mut() {
			if let OutKind::File(file) = &mut output.kind {
				let _ = file.flush();
			}
		}
		let _ = self.host.stderr.flush();
		self.stdout.flush().map_err(|err| self.write_error(&err))
	}

	/// Runs a command through the shell; its exit status.
	fn run_shell(&mut self, command: ShellCommand) -> R<i32> {
		match self.host.run_command(command) {
			Ok(status) => Ok(status.code()),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => Err(Stop::Cancelled),
			Err(err) => {
				self.warn(format!("can't run command: {}", strip_errno(&err)));
				Ok(if err.kind() == io::ErrorKind::NotFound { 127 } else { -1 })
			},
		}
	}

	/// Runs `print | cmd` output: `cmd` with the collected data on stdin.
	fn run_pipe(&mut self, command: &[u8], data: &[u8]) -> R<i32> {
		self.flush_all()?;
		let file = tempfile::tempfile().and_then(|mut file| {
			file.write_all(data)?;
			file.seek(SeekFrom::Start(0))?;
			Ok(file)
		});
		match file {
			Ok(file) => self.run_shell(shell(command).stdin(Fd::File(file))),
			Err(err) => {
				self.warn(format!("can't run {}: {}", display(command), strip_errno(&err)));
				Ok(-1)
			},
		}
	}

	// ── Expressions ─────────────────────────────────────────────────────

	fn eval(&mut self, expr: &Expr) -> R<Value> {
		Ok(match expr {
			Expr::Num(n) => Value::Num(*n),
			Expr::Str(s) => Value::Str(Rc::clone(s)),
			Expr::RegexMatch(regex) => Value::boolean(regex.is_match(&self.record)),
			Expr::RegexArg(_, src) => Value::Str(Rc::clone(src)),
			Expr::Var(var) => self.get_scalar(var.slot)?,
			Expr::LengthArray(array) => {
				let index = self.array_index(array.slot)?;
				Value::Num(self.arrays[index].len() as f64)
			},
			Expr::ArrayArg(array) => return error(format!("can't use array {:?} in scalar context", array.name)),
			Expr::Index(array, index) => {
				let key = self.subscript(index)?;
				let slot = self.array_index(array.slot)?;
				self.arrays[slot].entry(key).or_insert(Value::Null).clone()
			},
			Expr::Field(index) => {
				let index = self.field_index(index)?;
				self.get_field(index)
			},
			Expr::Assign(target, value) => {
				let place = self.place(target)?;
				let value = self.eval(value)?;
				self.set_place(place, value.clone())?;
				value
			},
			Expr::AugAssign(target, op, value) => {
				let place = self.place(target)?;
				let current = self.get_place(&place)?.num();
				let right = self.eval(value)?.num();
				let result = Value::Num(arith(*op, current, right)?);
				self.set_place(place, result.clone())?;
				result
			},
			Expr::Cond(cond, yes, no) => {
				if self.eval(cond)?.truthy() {
					self.eval(yes)?
				} else {
					self.eval(no)?
				}
			},
			Expr::Binary(left, op, right) => {
				let left = self.eval(left)?;
				let right = self.eval(right)?;
				self.binary(*op, &left, &right)?
			},
			Expr::And(left, right) => Value::boolean(self.eval(left)?.truthy() && self.eval(right)?.truthy()),
			Expr::Or(left, right) => Value::boolean(self.eval(left)?.truthy() || self.eval(right)?.truthy()),
			Expr::Match(left, negate, right) => {
				let left = self.eval(left)?;
				let text = self.to_str(&left);
				let regex = self.regex_of(right)?;
				Value::boolean(regex.is_match(&text) != *negate)
			},
			Expr::Unary(op, operand) => {
				let value = self.eval(operand)?;
				match op {
					UnOp::Not => Value::boolean(!value.truthy()),
					UnOp::Neg => Value::Num(-value.num()),
					UnOp::Plus => Value::Num(value.num()),
				}
			},
			Expr::Incr { target, decr, pre } => {
				let place = self.place(target)?;
				let old = self.get_place(&place)?.num();
				let new = if *decr { old - 1.0 } else { old + 1.0 };
				self.set_place(place, Value::Num(new))?;
				Value::Num(if *pre { new } else { old })
			},
			Expr::In(index, array) => {
				let key = self.subscript(index)?;
				let slot = self.array_index(array.slot)?;
				Value::boolean(self.arrays[slot].contains_key(&key[..]))
			},
			Expr::Call(func, args) => self.call_builtin(*func, args)?,
			Expr::Split(s, array, sep) => self.split(s, array.slot, sep.as_deref())?,
			Expr::UserCall { func, args, .. } => self.call_user(*func, args)?,
			Expr::Getline { src, target, from } => self.getline(*src, target.as_deref(), from.as_deref())?,
			Expr::Group(inner) => self.eval(inner)?,
			Expr::Multi(..) => return error("unexpected comma-separated expression"),
		})
	}

	fn binary(&self, op: BinOp, left: &Value, right: &Value) -> R<Value> {
		let ordering = |this: &Self| this.compare(left, right);
		Ok(match op {
			BinOp::Concat => {
				let mut out = Vec::new();
				self.push_str(left, &mut out);
				self.push_str(right, &mut out);
				Value::string(out)
			},
			BinOp::Eq => Value::boolean(ordering(self) == Some(Ordering::Equal)),
			BinOp::Ne => Value::boolean(ordering(self) != Some(Ordering::Equal)),
			BinOp::Lt => Value::boolean(ordering(self) == Some(Ordering::Less)),
			BinOp::Le => Value::boolean(matches!(ordering(self), Some(Ordering::Less | Ordering::Equal))),
			BinOp::Gt => Value::boolean(ordering(self) == Some(Ordering::Greater)),
			BinOp::Ge => Value::boolean(matches!(ordering(self), Some(Ordering::Greater | Ordering::Equal))),
			_ => Value::Num(arith(op, left.num(), right.num())?),
		})
	}

	/// POSIX comparison: numeric when both sides are numbers or numeric
	/// strings, else string comparison; `None` when a NaN is involved.
	fn compare(&self, left: &Value, right: &Value) -> Option<Ordering> {
		match (left.numeric(), right.numeric()) {
			(Some(a), Some(b)) => a.partial_cmp(&b),
			_ => Some(self.to_str(left).cmp(&self.to_str(right))),
		}
	}

	/// A value as a string, numbers converted with `CONVFMT`.
	fn to_str(&self, value: &Value) -> Bytes {
		match value {
			Value::Null => Rc::clone(&self.empty),
			Value::Num(n) => {
				let mut out = Vec::new();
				push_number(&mut out, *n, &self.convfmt);
				Rc::from(out)
			},
			Value::Str(s) | Value::StrNum(s) => Rc::clone(s),
		}
	}

	fn push_str(&self, value: &Value, out: &mut Vec<u8>) {
		match value {
			Value::Null => {},
			Value::Num(n) => push_number(out, *n, &self.convfmt),
			Value::Str(s) | Value::StrNum(s) => out.extend_from_slice(s),
		}
	}

	/// An array subscript: one value, or several joined with `SUBSEP`.
	fn subscript(&mut self, index: &[Expr]) -> R<Bytes> {
		if let [single] = index {
			let value = self.eval(single)?;
			return Ok(self.to_str(&value));
		}
		let mut key = Vec::new();
		for (i, expr) in index.iter().enumerate() {
			if i > 0 {
				key.extend_from_slice(&self.subsep);
			}
			let value = self.eval(expr)?;
			self.push_str(&value, &mut key);
		}
		Ok(Rc::from(key))
	}

	/// The regex for a regex-argument position: a literal, or a dynamic
	/// regex from the value's string (cached).
	fn regex_of(&mut self, expr: &Expr) -> R<Rc<AwkRegex>> {
		if let Expr::RegexArg(regex, _) = expr {
			return Ok(Rc::clone(regex));
		}
		let value = self.eval(expr)?;
		let src = self.to_str(&value);
		self.compile(&src)
	}

	fn compile(&mut self, src: &Bytes) -> R<Rc<AwkRegex>> {
		if let Some(regex) = self.regexes.get(&src[..]) {
			return Ok(Rc::clone(regex));
		}
		let regex = Rc::new(AwkRegex::new(src).map_err(Stop::Error)?);
		if self.regexes.len() < MAX_CACHED_REGEXES {
			self.regexes.insert(Rc::clone(src), Rc::clone(&regex));
		}
		Ok(regex)
	}

	fn field_sep(&mut self, sep: &Bytes) -> R<FieldSep> {
		Ok(if &sep[..] == b" " {
			FieldSep::Space
		} else if char_count(sep) <= 1 {
			FieldSep::Chars(Rc::clone(sep))
		} else {
			FieldSep::Regex(self.compile(sep)?)
		})
	}

	// ── Variables and places ────────────────────────────────────────────

	fn frame_base(&self) -> usize {
		self.frames.last().map_or(0, |frame| frame.scalars)
	}

	fn array_index(&self, slot: ArraySlot) -> R<usize> {
		match slot {
			ArraySlot::Global(index) => Ok(index),
			ArraySlot::Local(index) => match self.frames.last().and_then(|frame| frame.arrays.get(index)) {
				Some(&index) => Ok(index),
				None => error("internal error: bad local array"),
			},
			ArraySlot::Unresolved => error("internal error: unresolved array"),
		}
	}

	fn get_scalar(&mut self, slot: Slot) -> R<Value> {
		Ok(match slot {
			Slot::Global(index) => self.globals[index].clone(),
			Slot::Local(index) => self.locals[self.frame_base() + index].clone(),
			Slot::Special(special) => self.get_special(special),
			Slot::Unresolved => Value::Null,
		})
	}

	fn set_scalar(&mut self, slot: Slot, value: Value) -> R<()> {
		match slot {
			Slot::Global(index) => self.globals[index] = value,
			Slot::Local(index) => {
				let base = self.frame_base();
				self.locals[base + index] = value;
			},
			Slot::Special(special) => self.set_special(special, value)?,
			Slot::Unresolved => {},
		}
		Ok(())
	}

	fn place(&mut self, expr: &Expr) -> R<Place> {
		Ok(match expr {
			Expr::Var(var) => match var.slot {
				Slot::Global(index) => Place::Global(index),
				Slot::Local(index) => Place::Local(self.frame_base() + index),
				Slot::Special(special) => Place::Special(special),
				Slot::Unresolved => return error(format!("internal error: unresolved {:?}", var.name)),
			},
			Expr::Index(array, index) => {
				let key = self.subscript(index)?;
				Place::Elem(self.array_index(array.slot)?, key)
			},
			Expr::Field(index) => Place::Field(self.field_index(index)?),
			Expr::Group(inner) => self.place(inner)?,
			_ => return error("assignment to non-lvalue"),
		})
	}

	fn get_place(&mut self, place: &Place) -> R<Value> {
		Ok(match place {
			Place::Global(index) => self.globals[*index].clone(),
			Place::Local(index) => self.locals[*index].clone(),
			Place::Special(special) => self.get_special(*special),
			Place::Elem(array, key) => self.arrays[*array].entry(Rc::clone(key)).or_insert(Value::Null).clone(),
			Place::Field(index) => self.get_field(*index),
		})
	}

	fn set_place(&mut self, place: Place, value: Value) -> R<()> {
		match place {
			Place::Global(index) => self.globals[index] = value,
			Place::Local(index) => self.locals[index] = value,
			Place::Special(special) => self.set_special(special, value)?,
			Place::Elem(array, key) => {
				self.arrays[array].insert(key, value);
			},
			Place::Field(index) => self.set_field(index, value),
		}
		Ok(())
	}

	fn get_special(&mut self, special: Special) -> Value {
		match special {
			Special::Nf => {
				self.ensure_fields();
				Value::Num(self.nf as f64)
			},
			Special::Nr => self.nr.clone(),
			Special::Fnr => self.fnr.clone(),
			Special::Filename => self.filename.clone(),
			Special::Rstart => self.rstart.clone(),
			Special::Rlength => self.rlength.clone(),
			Special::Argc => self.argc.clone(),
			Special::Fs => Value::Str(Rc::clone(&self.fs)),
			Special::Ofs => Value::Str(Rc::clone(&self.ofs)),
			Special::Ors => Value::Str(Rc::clone(&self.ors)),
			Special::Rs => Value::Str(Rc::clone(&self.rs)),
			Special::Subsep => Value::Str(Rc::clone(&self.subsep)),
			Special::Convfmt => Value::Str(Rc::clone(&self.convfmt)),
			Special::Ofmt => Value::Str(Rc::clone(&self.ofmt)),
		}
	}

	fn set_special(&mut self, special: Special, value: Value) -> R<()> {
		match special {
			Special::Nf => {
				let n = value.num();
				if n < 0.0 || n.is_nan() {
					return error(format!("NF set to negative value: {n}"));
				}
				if n > MAX_FIELD {
					return error(format!("NF set too large: {n}"));
				}
				self.set_nf(n as usize);
			},
			Special::Nr => self.nr = value,
			Special::Fnr => self.fnr = value,
			Special::Filename => self.filename = value,
			Special::Rstart => self.rstart = value,
			Special::Rlength => self.rlength = value,
			Special::Argc => self.argc = value,
			Special::Fs => {
				let fs = self.to_str(&value);
				self.fs_sep = self.field_sep(&fs)?;
				self.fs = fs;
			},
			Special::Rs => {
				let rs = self.to_str(&value);
				self.rs_sep = RecordSep::new(&rs).map_err(Stop::Error)?;
				self.rs = rs;
			},
			Special::Ofs => self.ofs = self.to_str(&value),
			Special::Ors => self.ors = self.to_str(&value),
			Special::Subsep => self.subsep = self.to_str(&value),
			Special::Convfmt => self.convfmt = self.to_str(&value),
			Special::Ofmt => self.ofmt = self.to_str(&value),
		}
		Ok(())
	}

	// ── Records and fields ──────────────────────────────────────────────

	/// Resets field state after `self.record` changed.
	fn record_changed(&mut self, is_str: bool) {
		self.record_str = is_str;
		self.split_done = false;
		self.fields = None;
		self.split_fs = self.fs_sep.clone();
		self.split_para = matches!(self.rs_sep, RecordSep::Paragraph);
	}

	fn set_record(&mut self, text: &[u8], is_str: bool) {
		self.record.clear();
		self.record.extend_from_slice(text);
		self.record_changed(is_str);
	}

	fn ensure_fields(&mut self) {
		if self.split_done {
			return;
		}
		self.split_done = true;
		let newline_too = self.split_para && matches!(&self.split_fs, FieldSep::Chars(c) if !c.is_empty());
		split_spans(&self.record, &self.split_fs, newline_too, &mut self.spans);
		self.nf = self.spans.len();
	}

	/// Switches from spans into the record to owned field values.
	fn own_fields(&mut self) -> &mut Vec<Value> {
		self.ensure_fields();
		let (record, spans) = (&self.record, &self.spans);
		self.fields.get_or_insert_with(|| spans.iter().map(|&(s, e)| Value::strnum(&record[s..e])).collect())
	}

	fn field_index(&mut self, expr: &Expr) -> R<usize> {
		let n = self.eval(expr)?.num();
		if n < 0.0 || n.is_nan() {
			return error(format!("trying to access out of range field {}", n as i64));
		}
		if n > MAX_FIELD {
			return error(format!("field index too large: {n}"));
		}
		Ok(n as usize)
	}

	fn get_field(&mut self, index: usize) -> Value {
		if index == 0 {
			return if self.record_str { Value::str(&self.record) } else { Value::strnum(&self.record) };
		}
		self.ensure_fields();
		if index > self.nf {
			return Value::Null;
		}
		match &self.fields {
			Some(fields) => fields[index - 1].clone(),
			None => {
				let (s, e) = self.spans[index - 1];
				Value::strnum(&self.record[s..e])
			},
		}
	}

	fn set_field(&mut self, index: usize, value: Value) {
		if index == 0 {
			let text = self.to_str(&value);
			self.set_record(&text, true);
			return;
		}
		let fields = self.own_fields();
		if index > fields.len() {
			fields.resize(index, Value::Null);
		}
		fields[index - 1] = value;
		let nf = fields.len();
		self.nf = nf;
		self.rebuild_record();
	}

	fn set_nf(&mut self, nf: usize) {
		let fields = self.own_fields();
		fields.resize(nf, Value::Null);
		self.nf = nf;
		self.rebuild_record();
	}

	/// Rebuilds `$0` from the owned fields joined with `OFS`.
	fn rebuild_record(&mut self) {
		let mut record = std::mem::take(&mut self.record);
		record.clear();
		if let Some(fields) = &self.fields {
			for (index, field) in fields.iter().enumerate() {
				if index > 0 {
					record.extend_from_slice(&self.ofs);
				}
				self.push_str(field, &mut record);
			}
		}
		self.record = record;
		self.record_str = true;
	}

	// ── Input ───────────────────────────────────────────────────────────

	/// Reads the next main-input record into `$0`; `false` at the end.
	fn next_record(&mut self) -> R<bool> {
		self.check_cancel()?;
		let mut scratch = std::mem::take(&mut self.scratch);
		let got = self.read_main(&mut scratch);
		if let Ok(true) = got {
			std::mem::swap(&mut self.record, &mut scratch);
			self.record_changed(false);
		}
		self.scratch = scratch;
		got
	}

	/// Reads the next record of the main input (the `ARGV` files, else
	/// stdin), counting `NR` and `FNR`.
	fn read_main(&mut self, out: &mut Vec<u8>) -> R<bool> {
		loop {
			if self.main.is_none() && !self.open_next_main()? {
				return Ok(false);
			}
			let Some(main) = self.main.as_mut() else {
				return Ok(false);
			};
			match main.read_record(&self.rs_sep, out) {
				Ok(true) => {
					self.nr = Value::Num(self.nr.num() + 1.0);
					self.fnr = Value::Num(self.fnr.num() + 1.0);
					return Ok(true);
				},
				Ok(false) => self.main = None,
				Err(err) => {
					self.check_cancel()?;
					let name = self.to_str(&self.filename.clone());
					self.main = None;
					return error(format!("error reading {}: {}", display(&name), strip_errno(&err)));
				},
			}
		}
	}

	fn stdin_reader(&self) -> R<RecordReader> {
		let stdin = self.host.stdin.try_clone().map_err(|err| Stop::Error(format!("stdin: {}", strip_errno(&err))))?;
		Ok(RecordReader::new(Box::new(stdin)))
	}

	/// Opens the next input from `ARGV`, applying `var=value` operands on
	/// the way; `false` once all are consumed.
	fn open_next_main(&mut self) -> R<bool> {
		let argv = self.prog.array_slot("ARGV");
		loop {
			let argc = self.argc.num();
			let argc = if argc.is_finite() && argc > 0.0 { argc.min(MAX_FIELD) as usize } else { 0 };
			if self.argv_index >= argc {
				if self.had_files {
					return Ok(false);
				}
				self.had_files = true;
				self.main = Some(self.stdin_reader()?);
				self.fnr = Value::Num(0.0);
				return Ok(true);
			}
			let key = self.argv_index.to_string();
			self.argv_index += 1;
			let Some(arg) = argv.and_then(|argv| self.arrays[argv].get(key.as_bytes()).cloned()) else {
				continue;
			};
			let arg = self.to_str(&arg);
			if arg.is_empty() {
				continue;
			}
			if let Some((name, value)) = split_assignment(&arg) {
				self.assign_named(&name, &value)?;
				continue;
			}
			self.had_files = true;
			let reader = if &arg[..] == b"-" || &arg[..] == b"/dev/stdin" {
				self.stdin_reader()?
			} else {
				let resolved = self.host.resolve(path_of(&arg));
				match self.host.fs().open(&resolved) {
					Ok(file) => RecordReader::new(Box::new(file)),
					Err(err) => {
						self.warn(format!("can't open file {}: {}", display(&arg), strip_errno(&err)));
						self.input_failed = true;
						continue;
					},
				}
			};
			self.main = Some(reader);
			self.filename = Value::StrNum(arg);
			self.fnr = Value::Num(0.0);
			return Ok(true);
		}
	}

	fn getline(&mut self, src: GetlineSrc, target: Option<&Expr>, from: Option<&Expr>) -> R<Value> {
		let mut line = Vec::new();
		let status = match src {
			GetlineSrc::Main => match self.read_main(&mut line) {
				Ok(got) => got,
				Err(Stop::Error(message)) => {
					self.warn(message);
					return Ok(Value::Num(-1.0));
				},
				Err(stop) => return Err(stop),
			},
			GetlineSrc::File | GetlineSrc::Command => {
				let Some(from) = from else {
					return Ok(Value::Num(-1.0));
				};
				let name = self.eval(from)?;
				let name = self.to_str(&name);
				if !self.inputs.contains_key(&name[..]) {
					let opened = if src == GetlineSrc::File {
						self.open_input_file(&name)?
					} else {
						self.open_input_command(&name)?
					};
					match opened {
						Some(input) => {
							self.inputs.insert(Rc::clone(&name), input);
						},
						None => return Ok(Value::Num(-1.0)),
					}
				}
				let Some(input) = self.inputs.get_mut(&name[..]) else {
					return Ok(Value::Num(-1.0));
				};
				match input.reader.read_record(&self.rs_sep, &mut line) {
					Ok(got) => {
						if got && src == GetlineSrc::Command {
							self.nr = Value::Num(self.nr.num() + 1.0);
						}
						got
					},
					Err(_) => {
						self.check_cancel()?;
						return Ok(Value::Num(-1.0));
					},
				}
			},
		};
		if !status {
			return Ok(Value::Num(0.0));
		}
		match target {
			Some(target) => {
				let place = self.place(target)?;
				self.set_place(place, Value::strnum(&line))?;
			},
			None => self.set_record(&line, false),
		}
		Ok(Value::Num(1.0))
	}

	fn open_input_file(&mut self, name: &Bytes) -> R<Option<Input>> {
		if self.outputs.contains_key(&name[..]) {
			return error(format!("can't read from writer stream {}", display(name)));
		}
		if &name[..] == b"-" || &name[..] == b"/dev/stdin" {
			return Ok(Some(Input { reader: self.stdin_reader()?, command: None }));
		}
		let resolved = self.host.resolve(path_of(name));
		Ok(self
			.host
			.fs()
			.open(&resolved)
			.ok()
			.map(|file| Input { reader: RecordReader::new(Box::new(file)), command: None }))
	}

	/// Starts `cmd | getline`'s command with its stdout on a pipe we read.
	#[cfg(any(unix, windows))]
	fn open_input_command(&mut self, command: &Bytes) -> R<Option<Input>> {
		if self.outputs.contains_key(&command[..]) {
			return error(format!("can't read from writer stream {}", display(command)));
		}
		self.flush_all()?;
		let (reader, writer) = match io::pipe() {
			Ok(pipe) => pipe,
			Err(err) => {
				self.warn(format!("can't run {}: {}", display(command), strip_errno(&err)));
				return Ok(None);
			},
		};
		// The command gets the pipe as fd 0 and moves it to fd 1, since a
		// command line only carries its own stdin.
		let mut script = b"exec 1>&0 0</dev/null\n".to_vec();
		script.extend_from_slice(command);
		match self.host.spawn_command(shell(&script).stdin(Fd::from(writer))) {
			Ok(running) => Ok(Some(Input { reader: RecordReader::new(Box::new(reader)), command: Some(running) })),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => Err(Stop::Cancelled),
			Err(err) => {
				self.warn(format!("can't run {}: {}", display(command), strip_errno(&err)));
				Ok(None)
			},
		}
	}

	#[cfg(not(any(unix, windows)))]
	fn open_input_command(&mut self, command: &Bytes) -> R<Option<Input>> {
		self.warn(format!("can't run {}: commands are not supported on this platform", display(command)));
		Ok(None)
	}

	// ── Functions ───────────────────────────────────────────────────────

	fn call_user(&mut self, index: usize, args: &[Expr]) -> R<Value> {
		let prog = self.prog;
		let Some(function) = prog.functions.get(index) else {
			return error("call to undefined function");
		};
		if self.frames.len() >= MAX_DEPTH {
			return error(format!("function call nesting too deep in {:?}", function.name));
		}
		let mut scalars = Vec::with_capacity(function.kinds.len());
		let mut arrays = Vec::new();
		for (i, kind) in function.kinds.iter().enumerate() {
			match kind {
				Param::Scalar(_) => scalars.push(match args.get(i) {
					Some(arg) => self.eval(arg)?,
					None => Value::Null,
				}),
				Param::Array(_) => arrays.push(match args.get(i) {
					Some(Expr::ArrayArg(array)) => Some(self.array_index(array.slot)?),
					Some(_) => return error(format!("can't pass scalar as array param of {:?}", function.name)),
					None => None,
				}),
			}
		}
		let mark = self.arrays.len();
		let arrays: Vec<usize> = arrays
			.into_iter()
			.map(|array| {
				array.unwrap_or_else(|| {
					self.arrays.push(Array::default());
					self.arrays.len() - 1
				})
			})
			.collect();
		let base = self.locals.len();
		self.locals.extend(scalars);
		self.frames.push(Frame { scalars: base, arrays });
		let result = stacker::maybe_grow(256 * 1024, 4 * 1024 * 1024, || self.exec_block(&function.body));
		self.frames.pop();
		self.locals.truncate(base);
		self.arrays.truncate(mark);
		Ok(match result? {
			Flow::Return(value) => value,
			_ => Value::Null,
		})
	}

	fn call_builtin(&mut self, func: Func, args: &[Expr]) -> R<Value> {
		let num = |this: &mut Self, i: usize| -> R<f64> {
			match args.get(i) {
				Some(arg) => Ok(this.eval(arg)?.num()),
				None => Ok(0.0),
			}
		};
		let string = |this: &mut Self, i: usize| -> R<Bytes> {
			match args.get(i) {
				Some(arg) => {
					let value = this.eval(arg)?;
					Ok(this.to_str(&value))
				},
				None => Ok(Rc::clone(&this.empty)),
			}
		};
		Ok(match func {
			Func::Length => {
				if args.is_empty() {
					Value::Num(char_count(&self.record) as f64)
				} else {
					Value::Num(char_count(&string(self, 0)?) as f64)
				}
			},
			Func::Substr => {
				let s = string(self, 0)?;
				let m = num(self, 1)?;
				let n = if args.len() > 2 { Some(num(self, 2)?) } else { None };
				Value::string(substr(&s, m, n))
			},
			Func::Index => {
				let s = string(self, 0)?;
				let t = string(self, 1)?;
				Value::Num(memchr::memmem::find(&s, &t).map_or(0.0, |at| (char_count(&s[..at]) + 1) as f64))
			},
			Func::Match => {
				let s = string(self, 0)?;
				let regex = self.regex_of(&args[1])?;
				match regex.find_at(&s, 0) {
					Some((start, end)) => {
						self.rstart = Value::Num((char_count(&s[..start]) + 1) as f64);
						self.rlength = Value::Num(char_count(&s[start..end]) as f64);
					},
					None => {
						self.rstart = Value::Num(0.0);
						self.rlength = Value::Num(-1.0);
					},
				}
				self.rstart.clone()
			},
			Func::Sub | Func::Gsub => {
				let regex = self.regex_of(&args[0])?;
				let repl = string(self, 1)?;
				let place = match args.get(2) {
					Some(target) => self.place(target)?,
					None => Place::Field(0),
				};
				let current = self.get_place(&place)?;
				let current = self.to_str(&current);
				let (out, count) = substitute(&regex, &repl, &current, func == Func::Gsub);
				if count > 0 {
					self.set_place(place, Value::string(out))?;
				}
				Value::Num(count as f64)
			},
			Func::Sprintf => Value::string(self.sprintf_args(args)?),
			Func::Tolower | Func::Toupper => {
				let s = string(self, 0)?;
				let lower = func == Func::Tolower;
				Value::string(match std::str::from_utf8(&s) {
					Ok(text) => (if lower { text.to_lowercase() } else { text.to_uppercase() }).into_bytes(),
					Err(_) => {
						if lower {
							s.to_ascii_lowercase()
						} else {
							s.to_ascii_uppercase()
						}
					},
				})
			},
			Func::Int => Value::Num(num(self, 0)?.trunc()),
			Func::Sqrt => Value::Num(num(self, 0)?.sqrt()),
			Func::Exp => Value::Num(num(self, 0)?.exp()),
			Func::Log => Value::Num(num(self, 0)?.ln()),
			Func::Sin => Value::Num(num(self, 0)?.sin()),
			Func::Cos => Value::Num(num(self, 0)?.cos()),
			Func::Atan2 => {
				let y = num(self, 0)?;
				let x = num(self, 1)?;
				Value::Num(y.atan2(x))
			},
			Func::Rand => Value::Num(self.rng.random::<f64>()),
			Func::Srand => {
				let previous = self.seed;
				self.seed = if args.is_empty() { now_seconds() } else { num(self, 0)? };
				self.rng = StdRng::seed_from_u64(self.seed.to_bits());
				Value::Num(previous)
			},
			Func::System => {
				let command = string(self, 0)?;
				self.flush_all()?;
				let mut shell_command = shell(&command);
				if let Ok(stdin) = self.host.stdin.file().to_fd() {
					shell_command = shell_command.stdin(stdin);
				}
				Value::Num(f64::from(self.run_shell(shell_command)?))
			},
			Func::Close => {
				let name = string(self, 0)?;
				Value::Num(f64::from(self.close(&name)?))
			},
			Func::Fflush => {
				let name = if args.is_empty() { None } else { Some(string(self, 0)?) };
				Value::Num(f64::from(self.fflush(name.as_deref())?))
			},
			Func::Systime => Value::Num(now_seconds().trunc()),
			Func::Strftime => {
				let format = if args.is_empty() {
					Rc::from(&b"%a %b %e %H:%M:%S %Z %Y"[..])
				} else {
					string(self, 0)?
				};
				let seconds = if args.len() > 1 { num(self, 1)? } else { now_seconds() };
				let utc = if args.len() > 2 { self.eval(&args[2])?.truthy() } else { false };
				Value::string(self.strftime(&format, seconds, utc))
			},
			Func::Split => return error("internal error: split"),
		})
	}

	fn strftime(&self, format: &[u8], seconds: f64, utc: bool) -> Vec<u8> {
		let tz = if utc { jiff::tz::TimeZone::UTC } else { crate::time_zone::shell_time_zone(&*self.host) };
		let seconds = if seconds.is_finite() { seconds.trunc() as i64 } else { 0 };
		let Ok(timestamp) = jiff::Timestamp::from_second(seconds) else {
			return Vec::new();
		};
		let zoned = timestamp.to_zoned(tz);
		jiff::fmt::strtime::format(format, &zoned).map(String::into_bytes).unwrap_or_default()
	}

	fn split(&mut self, s: &Expr, array: ArraySlot, sep: Option<&Expr>) -> R<Value> {
		let text = self.eval(s)?;
		let text = self.to_str(&text);
		let sep = match sep {
			None => self.fs_sep.clone(),
			Some(Expr::RegexArg(regex, _)) => FieldSep::Regex(Rc::clone(regex)),
			Some(expr) => {
				let value = self.eval(expr)?;
				let sep = self.to_str(&value);
				self.field_sep(&sep)?
			},
		};
		let mut spans = Vec::new();
		split_spans(&text, &sep, false, &mut spans);
		let slot = self.array_index(array)?;
		let target = &mut self.arrays[slot];
		target.clear();
		for (index, &(start, end)) in spans.iter().enumerate() {
			target.insert(Rc::from((index + 1).to_string().into_bytes()), Value::strnum(&text[start..end]));
		}
		Ok(Value::Num(spans.len() as f64))
	}

	/// `close(name)`: the command's exit status, 0 for a file, -1 when
	/// nothing by that name is open.
	fn close(&mut self, name: &[u8]) -> R<i32> {
		if let Some(input) = self.inputs.remove(name) {
			let Input { reader, command } = input;
			drop(reader);
			return Ok(match command {
				Some(command) => match command.wait() {
					Ok(status) => status.code(),
					Err(err) if err.kind() == io::ErrorKind::Interrupted => return Err(Stop::Cancelled),
					Err(_) => -1,
				},
				None => 0,
			});
		}
		match self.outputs.remove(name) {
			Some(output) => self.close_output(name, output.kind),
			None => Ok(-1),
		}
	}

	/// `fflush([name])`: every output stream, or the named one.
	fn fflush(&mut self, name: Option<&[u8]>) -> R<i32> {
		match name {
			None | Some(b"") => {
				self.flush_all()?;
				Ok(0)
			},
			Some(name) => {
				let Some(output) = self.outputs.get_mut(name) else {
					self.warn(format!("fflush: {} is not an open output file or pipe", display(name)));
					return Ok(-1);
				};
				let result = match &mut output.kind {
					OutKind::Stdout => self.stdout.flush(),
					OutKind::Stderr => self.host.stderr.flush(),
					OutKind::File(file) => file.flush(),
					OutKind::Pipe(_) => Ok(()),
				};
				Ok(if result.is_ok() { 0 } else { -1 })
			},
		}
	}
}

fn now_seconds() -> f64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

fn arith(op: BinOp, x: f64, y: f64) -> R<f64> {
	Ok(match op {
		BinOp::Add => x + y,
		BinOp::Sub => x - y,
		BinOp::Mul => x * y,
		BinOp::Div => {
			if y == 0.0 {
				return error("division by zero");
			}
			x / y
		},
		BinOp::Mod => {
			if y == 0.0 {
				return error("division by zero in mod");
			}
			x % y
		},
		BinOp::Pow => x.powf(y),
		_ => 0.0,
	})
}

/// POSIX `substr(s, m[, n])`: characters at positions `round(m)` up to
/// `round(m) + round(n)`, clipped to the string.
fn substr(s: &[u8], m: f64, n: Option<f64>) -> Vec<u8> {
	if m.is_nan() || n.is_some_and(f64::is_nan) {
		return Vec::new();
	}
	let len = char_count(s) as f64;
	let start = m.round();
	let end = n.map_or(f64::INFINITY, |n| start + n.round());
	let start = start.max(1.0);
	let end = end.min(len + 1.0);
	if end <= start {
		return Vec::new();
	}
	let from = char_offset(s, start as usize - 1);
	let to = from + char_offset(&s[from..], (end - start) as usize);
	s[from..to].to_vec()
}

/// `sub`/`gsub`: replaces the first (or every) leftmost-longest match of
/// `regex` in `text`; `&` in `repl` is the match, `\&` a literal `&`.
fn substitute(regex: &AwkRegex, repl: &[u8], text: &[u8], global: bool) -> (Vec<u8>, usize) {
	let mut out = Vec::with_capacity(text.len());
	let mut count = 0;
	let mut pos = 0;
	let mut last_end = None;
	while pos <= text.len() {
		let Some((start, end)) = regex.find_at(text, pos) else {
			break;
		};
		if start == end && last_end == Some(start) {
			// No empty match right after the previous match.
			if start >= text.len() {
				break;
			}
			let len = char_prefix(&text[start..], 1).max(1);
			out.extend_from_slice(&text[pos..start + len]);
			pos = start + len;
			continue;
		}
		out.extend_from_slice(&text[pos..start]);
		let matched = &text[start..end];
		let mut i = 0;
		while i < repl.len() {
			match repl[i] {
				b'&' => out.extend_from_slice(matched),
				b'\\' if i + 1 < repl.len() && matches!(repl[i + 1], b'&' | b'\\') => {
					i += 1;
					out.push(repl[i]);
				},
				c => out.push(c),
			}
			i += 1;
		}
		count += 1;
		if start == end {
			if start < text.len() {
				let len = char_prefix(&text[start..], 1).max(1);
				out.extend_from_slice(&text[start..start + len]);
				pos = start + len;
			} else {
				pos = text.len() + 1;
			}
		} else {
			pos = end;
			last_end = Some(end);
		}
		if !global {
			break;
		}
	}
	if pos <= text.len() {
		out.extend_from_slice(&text[pos..]);
	}
	(out, count)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn substr_follows_posix_rounding_and_clipping() {
		assert_eq!(substr(b"hello", 2.0, Some(3.0)), b"ell");
		assert_eq!(substr(b"hello", 0.0, Some(3.0)), b"he");
		assert_eq!(substr(b"hello", -1.0, None), b"hello");
		assert_eq!(substr(b"hello", 4.0, Some(10.0)), b"lo");
		assert_eq!(substr("héllo".as_bytes(), 2.0, Some(2.0)), "él".as_bytes());
		assert_eq!(substr(b"hello", 1.5, Some(2.0)), b"el");
	}

	#[test]
	fn gsub_handles_empty_matches_and_ampersands() {
		let re = AwkRegex::new(b"x*").unwrap();
		assert_eq!(substitute(&re, b"-", b"abc", true), (b"-a-b-c-".to_vec(), 4));
		let re = AwkRegex::new(b"b*").unwrap();
		assert_eq!(substitute(&re, b"-", b"abc", true).0, b"-a-c-");
		let re = AwkRegex::new(b"o").unwrap();
		assert_eq!(substitute(&re, b"[&]\\&", b"foo", true).0, b"f[o]&[o]&");
		assert_eq!(substitute(&re, b"0", b"foo", false), (b"f0o".to_vec(), 1));
	}

	#[test]
	fn field_splitting_modes() {
		let spans = |text: &str, sep: FieldSep| {
			let mut spans = Vec::new();
			split_spans(text.as_bytes(), &sep, false, &mut spans);
			spans.iter().map(|&(s, e)| text[s..e].to_owned()).collect::<Vec<_>>()
		};
		assert_eq!(spans("  a \t b\n", FieldSep::Space), ["a", "b"]);
		assert_eq!(spans("a::b", FieldSep::Chars(Rc::from(&b":"[..]))), ["a", "", "b"]);
		assert_eq!(spans("", FieldSep::Chars(Rc::from(&b":"[..]))), Vec::<String>::new());
		assert_eq!(spans("abc", FieldSep::Chars(Rc::from(&b""[..]))), ["a", "b", "c"]);
		assert_eq!(spans(" a  b", FieldSep::Regex(Rc::new(AwkRegex::new(b" +").unwrap()))), ["", "a", "b"]);
	}
}
