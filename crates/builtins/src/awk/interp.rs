//! The tree-walking interpreter, after GoAWK's `interp` package: lazy field
//! splitting, record I/O through the host, output redirection, and command
//! pipes run through the shell.

use std::{
	cmp::Ordering,
	ffi::OsString,
	future::Future,
	io::{self, BufWriter, Seek as _, SeekFrom, Write as _},
	path::PathBuf,
	pin::Pin,
	rc::Rc,
	time::{SystemTime, UNIX_EPOCH},
};

mod calls;

use calls::{Calls, Mark};
use rand::{RngExt as _, SeedableRng as _, rngs::StdRng};
use rustc_hash::FxHashMap;

use super::{
	ast::{
		ArrayRef, ArraySlot, BinOp, Expr, GetlineSrc, Param, Pattern, Program, Redirect, ScalarRef, Slot, Special,
		Stmt, UnOp,
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

/// Evaluate `expr` at a statement position: immediately when it is
/// non-suspending ([`Interp::eval_fast`]), else through the asynchronous
/// evaluator. A macro, not a helper, so the immediate case builds no future.
macro_rules! eval_maybe {
	($s:ident, $e:expr) => {
		if let Some(value) = $s.eval_fast($e) { value } else { $s.eval($e).await }
	};
}

/// Keep the immediate loop body out of the future altogether. The proof is
/// made once, before the loop, not once per statement per iteration.
macro_rules! loop_body {
	($s:ident, $body:ident, $immediate:ident) => {{
		$s.check_cancel()?;
		if $immediate {
			for stmt in $body {
				let Stmt::Expr(expr) = stmt else { unreachable!("checked loop body") };
				$s.eval_fast_ok(expr)?;
			}
		} else if let Some(flow) = $s.loop_body($body).await? {
			return Ok(flow);
		}
	}};
}

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
	mark: Mark,
	resume: usize,
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
	File(BufWriter<omp_vfs::File>),
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
/// How many interpreter reentries through delegated AST operations run as
/// native polls before one hands its body to [`crate::deep::run`]'s heap queue.
/// Debug builds descend at every call: their unoptimized frames are large
/// enough to matter well before the release interval does.
#[cfg(debug_assertions)]
const DESCEND_EVERY: usize = 1;
#[cfg(not(debug_assertions))]
const DESCEND_EVERY: usize = 4;
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
	/// Current scalar parameters and pending operands, in evaluation order.
	locals:       Vec<Value>,
	frames:       Vec<Frame>,
	/// Array parameter slots are aliases into `arrays`, not copied maps.
	bindings:     Vec<usize>,
	calls:        Calls<'a>,
	poll_depth:   usize,

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

/// One boxed future around a statement's cycle edge: a recursive `async fn`
/// reaches its caller only through it, so its own future stays finite-sized.
fn boxed_flow<'s>(future: impl Future<Output = R<Flow>> + 's) -> Pin<Box<dyn Future<Output = R<Flow>> + 's>> {
	Box::pin(future)
}

/// Depth budget for the immediate evaluator: a non-suspending subtree deeper
/// than this falls back to the asynchronous path, so native recursion in the
/// fast path stays small.
const FAST_DEPTH: u8 = 8;

/// Prove that evaluation will finish without suspending, before performing
/// any effects. A function plan may inline only a bounded leaf; the plan's
/// own immediate expressions are checked with `calls = None` (no user calls).
fn fast_ok(expr: &Expr, depth: u8, calls: Option<&Calls<'_>>) -> bool {
	if depth == 0 {
		return false;
	}
	let d = depth - 1;
	match expr {
		Expr::Num(_)
		| Expr::Str(_)
		| Expr::RegexMatch(_)
		| Expr::RegexArg(..)
		| Expr::Var(_)
		| Expr::LengthArray(_)
		| Expr::ArrayArg(_) => true,
		Expr::Group(inner) => fast_ok(inner, d, calls),
		Expr::Field(index) => fast_ok(index, d, calls),
		Expr::Unary(_, operand) => fast_ok(operand, d, calls),
		Expr::Incr { target, .. } => fast_lvalue_ok(target, d, calls),
		Expr::In(index, _) => index.iter().all(|expr| fast_ok(expr, d, calls)),
		Expr::Index(_, index) => index.iter().all(|expr| fast_ok(expr, d, calls)),
		Expr::Binary(a, _, b) | Expr::And(a, b) | Expr::Or(a, b) => fast_ok(a, d, calls) && fast_ok(b, d, calls),
		Expr::Cond(a, b, c) => fast_ok(a, d, calls) && fast_ok(b, d, calls) && fast_ok(c, d, calls),
		Expr::Assign(target, value) | Expr::AugAssign(target, _, value) => {
			fast_lvalue_ok(target, d, calls) && fast_ok(value, d, calls)
		},
		// A literal regex has already been compiled; a dynamic one needs
		// `Interp::compile`, which stays on the asynchronous path.
		Expr::Match(left, _, right) => fast_ok(left, d, calls) && matches!(&**right, Expr::RegexArg(..)),
		Expr::UserCall { func, args, .. } => calls.is_some_and(|c| c.can_inline(*func)) && args.iter().all(|e| fast_ok(e, d, calls)),
		_ => false,
	}
}

/// Whether `expr` resolves to an assignable place without recursing.
fn fast_lvalue_ok(expr: &Expr, depth: u8, calls: Option<&Calls<'_>>) -> bool {
	if depth == 0 {
		return false;
	}
	let d = depth - 1;
	match expr {
		Expr::Var(_) => true,
		Expr::Field(index) => fast_ok(index, d, calls),
		Expr::Index(_, index) => index.iter().all(|expr| fast_ok(expr, d, calls)),
		Expr::Group(inner) => fast_lvalue_ok(inner, d, calls),
		_ => false,
	}
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
			bindings: Vec::new(),
			calls: Calls::new(prog),
			poll_depth: 0,
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
		// SAFETY: interpreter recursion awaits one child directly to completion; it never selects, cancels, or polls those futures independently.
		unsafe { crate::deep::run(self.run_program()) }
	}

	/// The body of [`execute`] on [`crate::deep::run`]'s heap queue: user
	/// function recursion descends there instead of growing the native stack.
	async fn run_program(&mut self) -> R<()> {
		let prog = self.prog;
		let mut exited = false;
		for block in &prog.begin {
			match self.exec_block(block).await {
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
			match self.main_loop().await {
				Ok(()) | Err(Stop::Exit) => {},
				Err(stop) => return Err(stop),
			}
		}
		for block in &prog.end {
			match self.exec_block(block).await {
				Ok(_) => {},
				Err(Stop::Exit) => break,
				Err(Stop::Next | Stop::NextFile) => return error("next used in BEGIN or END action"),
				Err(stop) => return Err(stop),
			}
		}
		Ok(())
	}

	async fn main_loop(&mut self) -> R<()> {
		let prog = self.prog;
		'records: while self.next_record()? {
			for (index, action) in prog.actions.iter().enumerate() {
				match self.run_action(index, &action.pattern, action.body.as_deref()).await {
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

	async fn run_action(&mut self, index: usize, pattern: &Pattern, body: Option<&[Stmt]>) -> R<()> {
		let matched = match pattern {
			Pattern::All => true,
			Pattern::Expr(expr) => eval_maybe!(self, expr)?.truthy(),
			Pattern::Range(start, stop) => {
				if !self.range_active[index] {
					self.range_active[index] = eval_maybe!(self, start)?.truthy();
				}
				let matched = self.range_active[index];
				if matched {
					self.range_active[index] = !eval_maybe!(self, stop)?.truthy();
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
			Some(body) => self.exec_block(body).await.map(|_| ()),
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

	async fn exec_block(&mut self, stmts: &[Stmt]) -> R<Flow> {
		for stmt in stmts {
			match self.exec(stmt).await? {
				Flow::Normal => {},
				flow => return Ok(flow),
			}
		}
		Ok(Flow::Normal)
	}

	/// [`exec_block`] behind one boxed future, the cycle edge a recursive
	/// `async fn` needs: `exec`'s nested branches use this so their futures
	/// stay finite-sized. The box is one allocation at the branch, not one per
	/// statement.
	fn exec_block_boxed<'s>(&'s mut self, stmts: &'s [Stmt]) -> Pin<Box<dyn Future<Output = R<Flow>> + 's>> {
		Box::pin(self.exec_block(stmts))
	}

	/// `for (pre; cond; post) body`: the boxed edge is the whole loop, so its
	/// iterations run without allocating again.
	async fn exec_for(
		&mut self,
		pre: Option<&Stmt>,
		cond: Option<&Expr>,
		post: Option<&Stmt>,
		body: &[Stmt],
	) -> R<Flow> {
		if let Some(pre) = pre {
			self.exec_simple(pre).await?;
		}
		let immediate_body = self.immediate_block(body);
		let immediate_cond = cond.is_some_and(|e| self.immediate(e));
		let immediate_post = post.and_then(|s| self.immediate_stmt(s));
		loop {
			if let Some(cond) = cond
				&& !(if immediate_cond { self.eval_fast_ok(cond) } else { self.eval(cond).await })?.truthy()
			{
				break;
			}
			loop_body!(self, body, immediate_body);
			if let Some(e) = immediate_post {
				self.eval_fast_ok(e)?;
			} else if let Some(post) = post {
				self.exec_simple(post).await?;
			}
		}
		Ok(Flow::Normal)
	}

	/// `for (var in array) body`.
	async fn exec_for_in(&mut self, var: &ScalarRef, array: &ArrayRef, body: &[Stmt]) -> R<Flow> {
		let index = self.array_index(array.slot)?;
		let keys: Vec<Bytes> = self.arrays[index].keys().cloned().collect();
		let immediate_body = self.immediate_block(body);
		for key in keys {
			self.set_scalar(var.slot, Value::Str(key))?;
			loop_body!(self, body, immediate_body);
		}
		Ok(Flow::Normal)
	}

	/// `while (cond) body`.
	async fn exec_while(&mut self, cond: &Expr, body: &[Stmt]) -> R<Flow> {
		let immediate_body = self.immediate_block(body);
		let immediate_cond = self.immediate(cond);
		while (if immediate_cond { self.eval_fast_ok(cond) } else { self.eval(cond).await })?.truthy() {
			loop_body!(self, body, immediate_body);
		}
		Ok(Flow::Normal)
	}

	/// `do body while (cond)`.
	async fn exec_do_while(&mut self, body: &[Stmt], cond: &Expr) -> R<Flow> {
		let immediate_body = self.immediate_block(body);
		let immediate_cond = self.immediate(cond);
		loop {
			loop_body!(self, body, immediate_body);
			if !(if immediate_cond { self.eval_fast_ok(cond) } else { self.eval(cond).await })?.truthy() {
				break;
			}
		}
		Ok(Flow::Normal)
	}

	fn immediate_stmt<'s>(&self, stmt: &'s Stmt) -> Option<&'s Expr> {
		if let Stmt::Expr(expr) = stmt && self.immediate(expr) { Some(expr) } else { None }
	}

	fn immediate_block(&self, body: &[Stmt]) -> bool {
		body.iter().all(|s| self.immediate_stmt(s).is_some())
	}

	/// Runs a loop body; `Some` is a flow that ends the loop.
	async fn loop_body(&mut self, body: &[Stmt]) -> R<Option<Flow>> {
		Ok(match self.exec_block(body).await? {
			Flow::Normal | Flow::Continue => None,
			Flow::Break => Some(Flow::Normal),
			flow @ Flow::Return(_) => Some(flow),
		})
	}

	async fn exec(&mut self, stmt: &Stmt) -> R<Flow> {
		match stmt {
			Stmt::Print { args, redirect } => self.print(args, redirect.as_ref()).await?,
			Stmt::Printf { args, redirect } => self.printf(args, redirect.as_ref()).await?,
			Stmt::Expr(expr) => {
				eval_maybe!(self, expr)?;
			},
			Stmt::If { cond, body, els } => {
				let branch = if eval_maybe!(self, cond)?.truthy() { body } else { els };
				return self.exec_block_boxed(branch).await;
			},
			Stmt::For { pre, cond, post, body } => {
				let loop_future = self.exec_for(pre.as_deref(), cond.as_ref(), post.as_deref(), body);
				return boxed_flow(loop_future).await;
			},
			Stmt::ForIn { var, array, body } => {
				let loop_future = self.exec_for_in(var, array, body);
				return boxed_flow(loop_future).await;
			},
			Stmt::While { cond, body } => {
				let loop_future = self.exec_while(cond, body);
				return boxed_flow(loop_future).await;
			},
			Stmt::DoWhile { body, cond } => {
				let loop_future = self.exec_do_while(body, cond);
				return boxed_flow(loop_future).await;
			},
			Stmt::Break => return Ok(Flow::Break),
			Stmt::Continue => return Ok(Flow::Continue),
			Stmt::Next => return Err(Stop::Next),
			Stmt::NextFile => return Err(Stop::NextFile),
			Stmt::Exit(status) => {
				if let Some(status) = status {
					let n = eval_maybe!(self, status)?.num();
					self.exit_status = if n.is_finite() { n as i64 as i32 } else { 0 };
				}
				return Err(Stop::Exit);
			},
			Stmt::Return(value) => {
				let value = match value {
					Some(value) => eval_maybe!(self, value)?,
					None => Value::Null,
				};
				return Ok(Flow::Return(value));
			},
			Stmt::Delete { array, index } => {
				let slot = self.array_index(array.slot)?;
				match index {
					Some(index) => {
						let key = self.subscript(index).await?;
						self.arrays[slot].remove(&key[..]);
					},
					None => self.arrays[slot].clear(),
				}
			},
			Stmt::Block(body) => return self.exec_block_boxed(body).await,
		}
		Ok(Flow::Normal)
	}

	/// A `for` initializer or update: `simple_stmt`, which cannot be a nested
	/// block, so it evaluates without `exec`'s boxing edge.
	async fn exec_simple(&mut self, stmt: &Stmt) -> R<()> {
		match stmt {
			Stmt::Print { args, redirect } => self.print(args, redirect.as_ref()).await,
			Stmt::Printf { args, redirect } => self.printf(args, redirect.as_ref()).await,
			Stmt::Expr(expr) => eval_maybe!(self, expr).map(|_| ()),
			Stmt::Delete { array, index } => {
				let slot = self.array_index(array.slot)?;
				match index {
					Some(index) => {
						let key = self.subscript(index).await?;
						self.arrays[slot].remove(&key[..]);
					},
					None => self.arrays[slot].clear(),
				}
				Ok(())
			},
			_ => Ok(()),
		}
	}

	async fn print(&mut self, args: &[Expr], redirect: Option<&(Redirect, Expr)>) -> R<()> {
		let mut line = std::mem::take(&mut self.print_buf);
		line.clear();
		if args.is_empty() {
			line.extend_from_slice(&self.record);
		}
		for (index, arg) in args.iter().enumerate() {
			if index > 0 {
				line.extend_from_slice(&self.ofs);
			}
			let value = eval_maybe!(self, arg)?;
			match &value {
				Value::Null => {},
				Value::Num(n) => push_number(&mut line, *n, &self.ofmt),
				Value::Str(s) | Value::StrNum(s) => line.extend_from_slice(s),
			}
		}
		line.extend_from_slice(&self.ors);
		let result = self.emit(redirect, &line).await;
		self.print_buf = line;
		result
	}

	async fn printf(&mut self, args: &[Expr], redirect: Option<&(Redirect, Expr)>) -> R<()> {
		let text = self.sprintf_args(args).await?;
		self.emit(redirect, &text).await
	}

	async fn sprintf_args(&mut self, args: &[Expr]) -> R<Vec<u8>> {
		let Some((format, rest)) = args.split_first() else {
			return Ok(Vec::new());
		};
		let format = self.eval_child(format).await?;
		let format = self.to_str(&format);
		let mut values = Vec::with_capacity(rest.len());
		for arg in rest {
			values.push(self.eval_child(arg).await?);
		}
		let mut out = Vec::new();
		sprintf(&mut out, &format, &values, &self.convfmt).map_err(Stop::Error)?;
		Ok(out)
	}

	/// Writes `data` to stdout or to a redirection target.
	async fn emit(&mut self, redirect: Option<&(Redirect, Expr)>, data: &[u8]) -> R<()> {
		let Some((kind, dest)) = redirect else {
			return self.stdout.write_all(data).map_err(|err| self.write_error(&err));
		};
		let dest = eval_maybe!(self, dest)?;
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
				let mut options = omp_vfs::OpenOptions::new();
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

	async fn eval(&mut self, expr: &Expr) -> R<Value> {
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
				let key = self.subscript(index).await?;
				let slot = self.array_index(array.slot)?;
				self.arrays[slot].entry(key).or_insert(Value::Null).clone()
			},
			Expr::Field(index) => {
				let index = self.field_index(index).await?;
				self.get_field(index)
			},
			Expr::Assign(target, value) => {
				let place = self.place(target).await?;
				let value = self.eval_child(value).await?;
				self.set_place(place, value.clone())?;
				value
			},
			Expr::AugAssign(target, op, value) => {
				let place = self.place(target).await?;
				let current = self.place_num(&place)?;
				let right = self.eval_child(value).await?.num();
				let result = Value::Num(arith(*op, current, right)?);
				self.set_place(place, result.clone())?;
				result
			},
			Expr::Cond(cond, yes, no) => {
				if self.eval_child(cond).await?.truthy() {
					self.eval_child(yes).await?
				} else {
					self.eval_child(no).await?
				}
			},
			Expr::Binary(left, op, right) => {
				let left = self.eval_child(left).await?;
				let right = self.eval_child(right).await?;
				self.binary(*op, &left, &right)?
			},
			Expr::And(left, right) => {
				Value::boolean(self.eval_child(left).await?.truthy() && self.eval_child(right).await?.truthy())
			},
			Expr::Or(left, right) => {
				Value::boolean(self.eval_child(left).await?.truthy() || self.eval_child(right).await?.truthy())
			},
			Expr::Match(left, negate, right) => {
				let left = self.eval_child(left).await?;
				let text = self.to_str(&left);
				let regex = self.regex_of(right).await?;
				Value::boolean(regex.is_match(&text) != *negate)
			},
			Expr::Unary(op, operand) => {
				let value = self.eval_child(operand).await?;
				match op {
					UnOp::Not => Value::boolean(!value.truthy()),
					UnOp::Neg => Value::Num(-value.num()),
					UnOp::Plus => Value::Num(value.num()),
				}
			},
			Expr::Incr { target, decr, pre } => {
				let place = self.place(target).await?;
				let old = self.place_num(&place)?;
				let new = if *decr { old - 1.0 } else { old + 1.0 };
				self.set_place(place, Value::Num(new))?;
				Value::Num(if *pre { new } else { old })
			},
			Expr::In(index, array) => {
				let key = self.subscript(index).await?;
				let slot = self.array_index(array.slot)?;
				Value::boolean(self.arrays[slot].contains_key(&key[..]))
			},
			Expr::Call(func, args) => self.call_builtin(*func, args).await?,
			Expr::Split(s, array, sep) => self.split(s, array.slot, sep.as_deref()).await?,
			Expr::UserCall { func, args, .. } => self.call_user(*func, args).await?,
			Expr::Getline { src, target, from } => self.getline(*src, target.as_deref(), from.as_deref()).await?,
			Expr::Group(inner) => self.eval_child(inner).await?,
			Expr::Multi(..) => return error("unexpected comma-separated expression"),
		})
	}

	fn immediate(&self, expr: &Expr) -> bool {
		fast_ok(expr, FAST_DEPTH, Some(&self.calls))
	}

	/// `None` delegates the entire expression without replaying any effects.
	fn eval_fast(&mut self, expr: &Expr) -> Option<R<Value>> {
		if self.immediate(expr) { Some(self.eval_fast_ok(expr)) } else { None }
	}

	/// The immediate evaluator body; only reached through [`fast_ok`], which
	/// has already established that every node here is supported.
	fn eval_fast_ok(&mut self, expr: &Expr) -> R<Value> {
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
			Expr::Group(inner) => self.eval_fast_ok(inner)?,
			Expr::Unary(op, operand) => {
				let value = self.eval_fast_ok(operand)?;
				match op {
					UnOp::Not => Value::boolean(!value.truthy()),
					UnOp::Neg => Value::Num(-value.num()),
					UnOp::Plus => Value::Num(value.num()),
				}
			},
			Expr::Field(index) => {
				let n = self.fast_num(index)?;
				if n < 0.0 || n.is_nan() {
					return error(format!("trying to access out of range field {}", n as i64));
				}
				if n > MAX_FIELD {
					return error(format!("field index too large: {n}"));
				}
				self.get_field(n as usize)
			},
			Expr::Index(array, index) => {
				let key = self.fast_subscript(index)?;
				let slot = self.array_index(array.slot)?;
				self.arrays[slot].entry(key).or_insert(Value::Null).clone()
			},
			Expr::In(index, array) => {
				let key = self.fast_subscript(index)?;
				let slot = self.array_index(array.slot)?;
				Value::boolean(self.arrays[slot].contains_key(&key[..]))
			},
			Expr::Binary(left, op @ (BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow), right) => {
				Value::Num(arith(*op, self.fast_num(left)?, self.fast_num(right)?)?)
			},
			Expr::Binary(left, op, right) => {
				let left = self.eval_fast_ok(left)?;
				let right = self.eval_fast_ok(right)?;
				self.binary(*op, &left, &right)?
			},
			Expr::And(left, right) => {
				Value::boolean(self.eval_fast_ok(left)?.truthy() && self.eval_fast_ok(right)?.truthy())
			},
			Expr::Or(left, right) => {
				Value::boolean(self.eval_fast_ok(left)?.truthy() || self.eval_fast_ok(right)?.truthy())
			},
			Expr::Cond(cond, yes, no) => {
				if self.eval_fast_ok(cond)?.truthy() {
					self.eval_fast_ok(yes)?
				} else {
					self.eval_fast_ok(no)?
				}
			},
			Expr::Match(left, negate, right) => {
				let Expr::RegexArg(regex, _) = &**right else { unreachable!("fast_ok gates the regex") };
				let value = self.eval_fast_ok(left)?;
				let text = self.to_str(&value);
				Value::boolean(regex.is_match(&text) != *negate)
			},
			Expr::Incr { target, decr, pre } => {
				let place = self.place_fast(target)?;
				let old = self.place_num(&place)?;
				let new = if *decr { old - 1.0 } else { old + 1.0 };
				self.set_place(place, Value::Num(new))?;
				Value::Num(if *pre { new } else { old })
			},
			Expr::Assign(target, value) => {
				let place = self.place_fast(target)?;
				let value = self.eval_fast_ok(value)?;
				self.set_place(place, value.clone())?;
				value
			},
			Expr::AugAssign(target, op, value) => {
				let place = self.place_fast(target)?;
				let current = self.place_num(&place)?;
				let right = self.fast_num(value)?;
				let result = Value::Num(arith(*op, current, right)?);
				self.set_place(place, result.clone())?;
				result
			},
			Expr::UserCall { func, args, .. } => self.call_inline(*func, args)?,
			_ => unreachable!("fast_ok gates the rest"),
		})
	}

	/// Numeric operands need neither an owned scalar nor an Rc increment.
	fn fast_num(&mut self, expr: &Expr) -> R<f64> {
		Ok(match expr {
			Expr::Num(n) => *n,
			Expr::Var(var) => match var.slot {
				Slot::Global(i) => self.globals[i].num(),
				Slot::Local(i) => self.locals[self.frame_base() + i].num(),
				_ => self.get_scalar(var.slot)?.num(),
			},
			_ => self.eval_fast_ok(expr)?.num(),
		})
	}

	/// An assignable location in a prechecked immediate expression.
	fn place_fast(&mut self, expr: &Expr) -> R<Place> {
		Ok(match expr {
			Expr::Var(var) => match var.slot {
				Slot::Global(index) => Place::Global(index),
				Slot::Local(index) => Place::Local(self.frame_base() + index),
				Slot::Special(special) => Place::Special(special),
				Slot::Unresolved => return error(format!("internal error: unresolved {:?}", var.name)),
			},
			Expr::Field(index) => {
				let n = self.eval_fast_ok(index)?.num();
				if n < 0.0 || n.is_nan() {
					return error(format!("trying to access out of range field {}", n as i64));
				}
				if n > MAX_FIELD {
					return error(format!("field index too large: {n}"));
				}
				Place::Field(n as usize)
			},
			Expr::Index(array, index) => Place::Elem(self.array_index(array.slot)?, self.fast_subscript(index)?),
			Expr::Group(inner) => return self.place_fast(inner),
			_ => return error("assignment to non-lvalue"),
		})
	}

	/// An array subscript built from immediate operands.
	fn fast_subscript(&mut self, index: &[Expr]) -> R<Bytes> {
		if let [single] = index {
			let value = self.eval_fast_ok(single)?;
			return Ok(self.to_str(&value));
		}
		let mut key = Vec::new();
		for (i, expr) in index.iter().enumerate() {
			if i > 0 {
				key.extend_from_slice(&self.subsep);
			}
			let value = self.eval_fast_ok(expr)?;
			self.push_str(&value, &mut key);
		}
		Ok(Rc::from(key))
	}

	/// Direct calls already have their own bounded continuation. Other
	/// suspending operands need a box to break the recursive future type.
	async fn eval_child(&mut self, expr: &Expr) -> R<Value> {
		match self.eval_fast(expr) {
			Some(value) => value,
			None => match expr {
				Expr::UserCall { func, args, .. } => self.call_user(*func, args).await,
				_ => self.eval_boxed(expr).await,
			},
		}
	}


	fn eval_boxed<'s>(&'s mut self, expr: &'s Expr) -> Pin<Box<dyn Future<Output = R<Value>> + 's>> {
		Box::pin(self.eval(expr))
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
	async fn subscript(&mut self, index: &[Expr]) -> R<Bytes> {
		if let [single] = index {
			let value = self.eval_child(single).await?;
			return Ok(self.to_str(&value));
		}
		let mut key = Vec::new();
		for (i, expr) in index.iter().enumerate() {
			if i > 0 {
				key.extend_from_slice(&self.subsep);
			}
			let value = self.eval_child(expr).await?;
			self.push_str(&value, &mut key);
		}
		Ok(Rc::from(key))
	}

	/// The regex for a regex-argument position: a literal, or a dynamic
	/// regex from the value's string (cached).
	async fn regex_of(&mut self, expr: &Expr) -> R<Rc<AwkRegex>> {
		if let Expr::RegexArg(regex, _) = expr {
			return Ok(Rc::clone(regex));
		}
		let value = self.eval_child(expr).await?;
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
		self.frames.last().map_or(0, |frame| frame.mark.scalars)
	}

	fn array_index(&self, slot: ArraySlot) -> R<usize> {
		match slot {
			ArraySlot::Global(index) => Ok(index),
			ArraySlot::Local(index) => match self.frames.last().and_then(|frame| self.bindings.get(frame.mark.bindings + index)) {
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

	async fn place(&mut self, expr: &Expr) -> R<Place> {
		// Parentheses add no place of their own; unwrap them here so the
		// method never recurses into itself.
		let mut expr = expr;
		while let Expr::Group(inner) = expr {
			expr = inner;
		}
		Ok(match expr {
			Expr::Var(var) => match var.slot {
				Slot::Global(index) => Place::Global(index),
				Slot::Local(index) => Place::Local(self.frame_base() + index),
				Slot::Special(special) => Place::Special(special),
				Slot::Unresolved => return error(format!("internal error: unresolved {:?}", var.name)),
			},
			Expr::Index(array, index) => {
				let key = self.subscript(index).await?;
				Place::Elem(self.array_index(array.slot)?, key)
			},
			Expr::Field(index) => Place::Field(self.field_index(index).await?),
			_ => return error("assignment to non-lvalue"),
		})
	}

	fn place_num(&mut self, place: &Place) -> R<f64> {
		Ok(match place {
			Place::Global(i) => self.globals[*i].num(),
			Place::Local(i) => self.locals[*i].num(),
			_ => self.get_place(place)?.num(),
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

	async fn field_index(&mut self, expr: &Expr) -> R<usize> {
		let n = self.eval_child(expr).await?.num();
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
		let file = stdin.file().try_clone().map_err(|err| Stop::Error(format!("stdin: {}", strip_errno(&err))))?;
		Ok(RecordReader::rewinding(Box::new(stdin), file))
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

	async fn getline(&mut self, src: GetlineSrc, target: Option<&Expr>, from: Option<&Expr>) -> R<Value> {
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
				let name = self.eval_child(from).await?;
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
				let place = self.place(target).await?;
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

	/// A builtin's numeric argument, defaulting to 0 when absent.
	async fn arg_num(&mut self, args: &[Expr], i: usize) -> R<f64> {
		match args.get(i) {
			Some(arg) => Ok(self.eval_child(arg).await?.num()),
			None => Ok(0.0),
		}
	}

	/// A builtin's string argument, defaulting to `""` when absent.
	async fn arg_string(&mut self, args: &[Expr], i: usize) -> R<Bytes> {
		match args.get(i) {
			Some(arg) => {
				let value = self.eval_child(arg).await?;
				Ok(self.to_str(&value))
			},
			None => Ok(Rc::clone(&self.empty)),
		}
	}

	async fn call_builtin(&mut self, func: Func, args: &[Expr]) -> R<Value> {
		Ok(match func {
			Func::Length => {
				if args.is_empty() {
					Value::Num(char_count(&self.record) as f64)
				} else {
					Value::Num(char_count(&self.arg_string(args, 0).await?) as f64)
				}
			},
			Func::Substr => {
				let s = self.arg_string(args, 0).await?;
				let m = self.arg_num(args, 1).await?;
				let n = if args.len() > 2 { Some(self.arg_num(args, 2).await?) } else { None };
				Value::string(substr(&s, m, n))
			},
			Func::Index => {
				let s = self.arg_string(args, 0).await?;
				let t = self.arg_string(args, 1).await?;
				Value::Num(memchr::memmem::find(&s, &t).map_or(0.0, |at| (char_count(&s[..at]) + 1) as f64))
			},
			Func::Match => {
				let s = self.arg_string(args, 0).await?;
				let regex = self.regex_of(&args[1]).await?;
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
				let regex = self.regex_of(&args[0]).await?;
				let repl = self.arg_string(args, 1).await?;
				let place = match args.get(2) {
					Some(target) => self.place(target).await?,
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
			Func::Sprintf => Value::string(self.sprintf_args(args).await?),
			Func::Tolower | Func::Toupper => {
				let s = self.arg_string(args, 0).await?;
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
			Func::Int => Value::Num(self.arg_num(args, 0).await?.trunc()),
			Func::Sqrt => Value::Num(self.arg_num(args, 0).await?.sqrt()),
			Func::Exp => Value::Num(self.arg_num(args, 0).await?.exp()),
			Func::Log => Value::Num(self.arg_num(args, 0).await?.ln()),
			Func::Sin => Value::Num(self.arg_num(args, 0).await?.sin()),
			Func::Cos => Value::Num(self.arg_num(args, 0).await?.cos()),
			Func::Atan2 => {
				let y = self.arg_num(args, 0).await?;
				let x = self.arg_num(args, 1).await?;
				Value::Num(y.atan2(x))
			},
			Func::Rand => Value::Num(self.rng.random::<f64>()),
			Func::Srand => {
				let previous = self.seed;
				self.seed = if args.is_empty() { now_seconds() } else { self.arg_num(args, 0).await? };
				self.rng = StdRng::seed_from_u64(self.seed.to_bits());
				Value::Num(previous)
			},
			Func::System => {
				let command = self.arg_string(args, 0).await?;
				self.flush_all()?;
				let mut shell_command = shell(&command);
				if let Ok(stdin) = self.host.stdin.file().to_fd() {
					shell_command = shell_command.stdin(stdin);
				}
				Value::Num(f64::from(self.run_shell(shell_command)?))
			},
			Func::Close => {
				let name = self.arg_string(args, 0).await?;
				Value::Num(f64::from(self.close(&name)?))
			},
			Func::Fflush => {
				let name = if args.is_empty() { None } else { Some(self.arg_string(args, 0).await?) };
				Value::Num(f64::from(self.fflush(name.as_deref())?))
			},
			Func::Systime => Value::Num(now_seconds().trunc()),
			Func::Strftime => {
				let format = if args.is_empty() {
					Rc::from(&b"%a %b %e %H:%M:%S %Z %Y"[..])
				} else {
					self.arg_string(args, 0).await?
				};
				let seconds = if args.len() > 1 { self.arg_num(args, 1).await? } else { now_seconds() };
				let utc = if args.len() > 2 { self.eval_child(&args[2]).await?.truthy() } else { false };
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

	async fn split(&mut self, s: &Expr, array: ArraySlot, sep: Option<&Expr>) -> R<Value> {
		let text = self.eval_child(s).await?;
		let text = self.to_str(&text);
		let sep = match sep {
			None => self.fs_sep.clone(),
			Some(Expr::RegexArg(regex, _)) => FieldSep::Regex(Rc::clone(regex)),
			Some(expr) => {
				let value = self.eval_child(expr).await?;
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
