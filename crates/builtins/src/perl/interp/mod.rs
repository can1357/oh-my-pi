//! Tree-walking Perl execution (perlsyn, perlsub, perlvar and perlrun).

mod calls;
mod eval;
mod hints;
mod loading;
mod magic;
mod object;
mod overload;
mod refalias;
mod runtime;
mod stmt;
mod transform;
mod validate;
mod vars;

use std::{cell::{Cell, RefCell}, path::PathBuf, rc::Rc, time::{Duration, Instant, SystemTime}};

use rustc_hash::{FxHashMap, FxHashSet};

use crate::host::Host;
use super::{ast::*, code::{CodeBody, CodeImpl, Cv}, func, io::{Handle, InPlace, Io, RecordSep}, modules, ops, parser, rx, value::{self, Av, Dual, Gv, HKey, Hv, Num, PStr, Ref, Sv, Value, new_av, new_gv, new_hv, new_sv}};

pub(in crate::perl) use self::{calls::{FormatArgs, PerlBody}, hints::{Hints, Warnings}};
use self::vars::{Pad, Restore};
pub(in crate::perl) use self::vars::SpecialGlob;

/// Dynamic evaluation context supplied by the enclosing operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::perl) enum Cx { Void, Scalar, List }

/// A scalar or a flattened list returned by an operation.
#[derive(Debug)]
pub(in crate::perl) enum Ret {
	/// A value in scalar context (or an ignored value in void context).
	One(Value),
	/// Values in list context.
	Many(Vec<Value>),
}
impl Ret {
	/// Use the last element of a list as its comma-operator value.
	#[inline]
	pub fn scalar(self) -> Value { match self { Self::One(v) => v, Self::Many(mut v) => v.pop().unwrap_or(Value::Undef) } }
	/// Flatten the result into a list, keeping even an undefined scalar.
	pub fn list(self) -> Vec<Value> { match self { Self::One(v) => vec![v], Self::Many(v) => v } }
	/// Flatten directly into an enclosing list without allocating a singleton vector.
	pub(super) fn append_to(self, out: &mut Vec<Value>) {
		match self {
			Self::One(v) => out.push(v),
			Self::Many(values) if out.is_empty() => *out = values,
			Self::Many(values) => out.extend(values),
		}
	}
	/// The empty list.
	pub fn empty() -> Self { Self::Many(Vec::new()) }
	pub(super) fn values(values: Vec<Value>, cx: Cx) -> Self {
		if cx == Cx::List { Self::Many(values) } else { Self::One(Value::Int(values.len() as i64)) }
	}
	fn no_value(cx: Cx) -> Self { if cx == Cx::List { Self::empty() } else { Self::One(Value::Undef) } }
	#[inline]
	fn apply_context(&mut self, cx: Cx) {
		if cx != Cx::List && let Self::Many(values) = self {
			*self = Self::One(values.pop().unwrap_or(Value::Undef));
		}
	}
	#[inline]
	fn in_context(mut self, cx: Cx) -> Self { self.apply_context(cx); self }
}

/// Non-local control transfers. Die strings have already received their location.
pub(in crate::perl) enum Flow {
	/// Perl exception, including reference exceptions.
	Die(Value),
	/// Return from the current call or eval.
	Return(Ret),
	/// Continue the innermost or named loop.
	Next(Option<Rc<str>>),
	/// Leave the innermost or named loop.
	Last(Option<Rc<str>>),
	/// Repeat the loop body without testing its condition.
	Redo(Option<Rc<str>>),
	/// Jump to a label or replace the current subroutine call.
	Goto(GotoTarget),
	/// Requested process status (does not exit the host).
	Exit(i32),
	/// Host cancellation.
	Cancelled,
}

/// The destination of `goto`.
pub(in crate::perl) enum GotoTarget {
	/// Find the specified label in an enclosing block.
	Label(Rc<str>),
	/// Replace the active call, retaining the current argument aliases.
	Sub(Cv),
}

/// A scalar alias whose observable value is supplied by a Perl operation.
#[derive(Clone)]
pub(in crate::perl) enum Lvalue {
	/// A substring of a live scalar with the operator's captured bounds.
	Substr { source: Sv, start: Cell<i64>, len: Cell<Option<i64>>, bytes: bool },
	/// One packed vector entry in a live scalar.
	Vec { source: Sv, offset: i64, width: i64 },
	/// The regex cursor of a live scalar.
	Pos { source: Sv },
	/// An assignable last array index.
	LastIndex(Av),
	/// An element of a tied array.
	ArrayElement(Av, i64),
	/// An element of a tied hash.
	HashElement(Hv, HKey),
}

/// Construct an addressable scalar proxy.
pub(in crate::perl) fn new_lvalue(lvalue: Lvalue) -> Sv { value::new_lvalue(lvalue) }

/// Evaluation success or non-local control flow.
pub(in crate::perl) type PResult<T> = Result<T, Flow>;
/// A Rust implementation of a Perl subroutine, given the aliased arguments.
pub(in crate::perl) type NativeFn = fn(&mut Interp<'_>, Vec<Sv>, Cx) -> PResult<Ret>;

/// Controls whether interpolation preserves regex constructs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::perl) enum InterpMode { String, Regex, Replacement }

/// Command-line warning override.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::perl) enum WarnSwitch { #[default] None, W, All, Off }

/// Command-line state provided before compilation.
pub(in crate::perl) struct Setup {
	/// Display name of the script (`$0`).
	pub script: PStr,
	/// Arguments to the script.
	pub argv: Vec<PStr>,
	/// Leading entries in `@INC`.
	pub inc: Vec<PStr>,
	/// Global warning switch.
	pub warn: WarnSwitch,
	/// In-place backup extension, empty for no backup.
	pub inplace: Option<Vec<u8>>,
	/// Initial `$/` override.
	pub input_sep: Option<RecordSep>,
	/// Initial `$\` override.
	pub output_sep: Option<PStr>,
	/// Initial standard-stream and argument encoding flags.
	pub unicode: u32,
	/// Variables parsed by `-s`.
	pub switches: Vec<(PStr, PStr)>,
}

/// Execution metadata exposed by `caller` and native libraries.
#[derive(Clone)]
pub(in crate::perl) struct Frame {
	/// Package of the call site.
	pub package: Rc<str>,
	/// File containing the call site.
	pub file: Rc<str>,
	/// Logical line of the call.
	pub line: u32,
	/// Qualified subroutine name or `(eval)`.
	pub sub: Option<Rc<str>>,
	/// Whether the called sub received an argument list.
	pub has_args: bool,
	/// Call context (None means void).
	pub wantarray: Option<bool>,
	/// Source for string eval or filename for require.
	pub eval_text: Option<PStr>,
	/// This is a require frame.
	pub is_require: bool,
	/// Argument snapshot for `@DB::args`.
	pub args: Option<Vec<Value>>,
}

/// State of the magical ARGV input descriptor.
#[derive(Default)]
pub(in crate::perl) struct ArgvState {
	/// Current input handle.
	pub current: Option<Io>,
	/// Name of the currently open path, or `-` for stdin.
	pub name: PStr,
	/// Active in-place editing transaction.
	pub inplace: Option<InPlace>,
	/// Extension supplied by `-i`, including the empty extension.
	pub ext: Option<Vec<u8>>,
}

struct CallFrame {
	info: Frame,
	hints: Rc<Hints>,
	outer: bool,
	args: Option<Av>,
}

#[derive(Default)]
struct Scope {
	lexical_mark: usize,
	pad: Pad,
	declarations: Pad,
	undo: Vec<Restore>,
}

#[derive(Default)]
struct Persistent {
	vars: FxHashMap<usize, Pad>,
	flip_flops: FxHashMap<usize, u64>,
}

type PhaseBlock = (Rc<Block>, Rc<str>, Hints, Pad);
type ExitHook = Box<dyn FnOnce(&mut Interp<'_>)>;

/// Isolated Perl runtime for one invocation, sharing only the shell's host I/O.
pub(in crate::perl) struct Interp<'h> {
	/// Id of this interpreter's reference-cycle tracker (`value::begin_cycle_tracking`).
	cycle_tracker: u64,
	host: &'h mut Host,
	cwd: PathBuf,
	pub(in crate::perl) rx: rx::Runtime,
	pub(in crate::perl) sys: func::sys::State,
	pub(in crate::perl) data: func::data::State,
	pub(in crate::perl) modules: modules::State,
	/// Host-backed defaults not yet handed out through a glob or its stash.
	startup_host: runtime::HostSpecials,
	/// Most recent successful match in this dynamic block.
	pub(in crate::perl) last_match: Option<Rc<rx::MatchState>>,
	symbols: FxHashMap<Rc<str>, Gv>,
	/// Bumped whenever `symbols`, `stashes` or `exposed_stashes` change, invalidating memoized globs.
	symbol_generation: u64,
	/// Whether the `CORE::GLOBAL` stash existed at the given `symbol_generation` (builtin override check).
	core_global: Cell<Option<(u64, bool)>>,
	/// Memoized `qualify`/`glob` results keyed by the name's address and length (validated by content).
	names: RefCell<FxHashMap<(usize, usize), vars::NameMemo>>,
	/// Memoized globs of frequently used punctuation variables, valid for their `symbol_generation`.
	special_globs: RefCell<[vars::SpecialMemo; vars::SPECIAL_GLOBS]>,
	magic_cells: FxHashMap<usize, (&'static str, std::rc::Weak<value::ScalarBody>)>,
	global_sites: Vec<vars::GlobalSite>,
	/// Tied scalars whose FETCH/STORE is running: their magic is off meanwhile (perl's save_magic).
	tie_suspended: FxHashSet<usize>,
	stashes: FxHashMap<Rc<str>, Hv>,
	package_generations: FxHashMap<Rc<str>, u64>,
	isa_globs: Vec<std::rc::Weak<value::GlobBody>>,
	code_attr: FxHashMap<usize, (std::rc::Weak<CodeBody>, Vec<PStr>)>,
	exposed_stashes: FxHashSet<Rc<str>>,
	handles: Vec<std::rc::Weak<RefCell<Handle>>>,
	tied_handles: FxHashMap<usize, (std::rc::Weak<RefCell<Handle>>, Value)>,
	selected: Io,
	last_read: Option<Io>,
	line_seen: Cell<i64>,
	autoflush_seen: Cell<bool>,
	argv: ArgvState,
	start: SystemTime,
	alarm: Option<Instant>,
	alarm_interval: Option<Duration>,
	warn_switch: WarnSwitch,
	phase: &'static str,
	default_hints: Hints,
	active_hints: Rc<Hints>,
	compile_hints: Hints,
	parse_scopes: Vec<Hints>,
	compile_pads: Vec<Pad>,
	compile_pad_base: usize,
	use_hints: FxHashMap<usize, Rc<Hints>>,
	captures: FxHashMap<usize, Vec<usize>>,
	imported_symbols: FxHashSet<Rc<str>>,
	package: Rc<str>,
	loc: Location,
	scopes: Vec<Scope>,
	lexicals: vars::Lexicals,
	/// Emptied scopes kept for reuse by `push_scope`.
	scope_pool: Vec<Scope>,
	/// Emptied scope stacks kept for reuse by `enter_pad`.
	scope_stacks: Vec<Vec<Scope>>,
	topics: Vec<Sv>,
	persistent: Rc<RefCell<Persistent>>,
	frames: Vec<CallFrame>,
	active_subs: Vec<(Cv, Av, Cx)>,
	eval_contexts: Vec<(Cx, bool)>,
	perl_calls: Vec<usize>,
	arg_arrays: Vec<Av>,
	sub_depth: FxHashMap<usize, u32>,
	tail_args: Option<Av>,
	eval_serial: u64,
	in_given: usize,
	/// Whether `misc` warnings were enabled where the latest exception was raised (gates "(in cleanup)").
	die_misc_warnings: bool,
	/// Value of the `when` block that just completed its enclosing `given` (the `given`'s result as an rvalue).
	given_value: Option<Ret>,
	/// Context of the innermost `given`, in which its `when` blocks produce that value.
	given_cx: Cx,
	in_when: usize,
	hole: Sv,
	programs: Vec<Rc<Program>>,
	pending: Option<Flow>,
	depth: u32,
	compile_depth: usize,
	compile_failure: Option<Flow>,
	compile_interrupted: bool,
	compile_status: i32,
	in_die: bool,
	in_warn: bool,
	/// A `SIGPIPE` handler runs: the signal is blocked, so its own failed
	/// writes are plain errors ([`Interp::broken_pipe`]).
	in_sigpipe: bool,
	/// The program ended as a process vanishes ([`Interp::vanish`]): killed
	/// by a signal's default action, replaced by `exec` or cancelled by the
	/// shell, so no END block, destructor or exit hook runs and buffered
	/// output is lost.
	vanished: bool,
	overloads: FxHashMap<Rc<str>, FxHashMap<Rc<str>, Value>>,
	objects: indexmap::IndexMap<usize, Ref, rustc_hash::FxBuildHasher>,
	destroying: FxHashSet<usize>,
	destroy_draining: bool,
	in_overload: usize,
	in_constant: bool,
	loading: FxHashSet<Rc<str>>,
	unitchecks: Vec<PhaseBlock>,
	checks: Vec<PhaseBlock>,
	inits: Vec<PhaseBlock>,
	ends: Vec<PhaseBlock>,
	exit_hooks: Vec<ExitHook>,
}

// The shell outlives the interpreter: free what reference cycles would keep alive (perl gets this from exit).
impl Drop for Interp<'_> {
	fn drop(&mut self) { value::end_cycle_tracking(self.cycle_tracker); }
}

/// Adapter for formatters whose conversion trait cannot directly return Perl flow values.
pub(in crate::perl) struct Conv<'i, 'h> { interp: &'i mut Interp<'h> }
impl value::Stringify for Conv<'_, '_> {
	fn stringify(&mut self, v: &Value) -> PStr {
		match self.interp.stringify(v) { Ok(v) => v, Err(flow) => { self.interp.defer(flow); PStr::default() } }
	}
	fn numify(&mut self, v: &Value) -> Num {
		match self.interp.numify(v) { Ok(v) => v, Err(flow) => { self.interp.defer(flow); Num::Int(0) } }
	}
	fn warn(&mut self, msg: String) { self.interp.warn(msg); }
}

fn perl_bool(b: bool) -> Value { if b { Value::Int(1) } else { Value::Str(PStr::default()) } }
fn context_flag(cx: Cx) -> Option<bool> { match cx { Cx::Void => None, Cx::Scalar => Some(false), Cx::List => Some(true) } }
fn read_sv(sv: &Sv) -> Value { sv.get() }
fn aliases(values: Vec<Value>) -> Vec<Sv> { values.into_iter().map(new_sv).collect() }
fn hash_key(name: &str) -> HKey { HKey::new(&PStr::from_str(name)) }
/// Strips parentheses and unary plus (a purely syntactic no-op in perl).
fn ungroup(mut e: &Expr) -> &Expr {
	while let ExprKind::Group(inner) | ExprKind::Unary(Unary::Plus, inner) = &e.kind { e = inner; }
	e
}
