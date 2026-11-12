//! zsh arithmetic over the shell's state: the [`math::Env`] that connects
//! the evaluator of [`super::math`] (a port of zsh's `math.c`) to the zsh
//! parameter code ([`super::params`]), and the entry points every zsh
//! arithmetic context uses: `$(( ))` ([`matheval_text`]), `(( ))`, `let`,
//! the arithmetic `for`, `integer`/`float` assignments and subscripts
//! ([`matheval`], [`mathevali`], [`mathevalarg`], [`matheval_lastbase`]).
//!
//! zsh keeps its evaluator globals (`mlevel`, `outputradix`, `lastbase`)
//! in C globals that a top-level evaluation resets; here each top-level
//! evaluation owns a [`MathState`] that the evaluations nested inside it
//! (variable values that are expressions) share. Compiled expressions are
//! cached process-wide: compiling is a pure function of the text and the
//! compile options.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::{Arc, LazyLock};

use bstr::{BStr, BString, ByteSlice};

use super::{
	math::{
		self, Assigned, Cache, Env, FuncArgs, FuncKind, MathError, MathFunc, MathState, Nice, Number,
		Options, Param, Warning,
	},
	params,
};
use crate::bash::{
	diag::Diag,
	ids::ModeId,
	store::{Attrs, Key, MiscKey, Record, StateStore, StoreError},
	syntax::zsh::tok,
	vm::{
		builtins::zsh_module,
		expand::{Expander, MathCall, Stop, X},
		proc::{Atom, LastMath, Vproc},
		state,
	},
	zshopt::ZshOpt,
};

/// Compiled expressions, shared by every shell of the process.
static CACHE: LazyLock<Cache> = LazyLock::new(Cache::default);

impl From<MathError> for Stop {
	/// A math error aborts the command, printed with zsh's text (zsh
	/// `zerr` in `math.c`).
	fn from(e: MathError) -> Self {
		Self::Fail(Diag::BadMathExpr { msg: e.to_string().into() })
	}
}

/// One zsh option for the vproc the expander runs in.
fn opt(ex: &mut Expander<'_, '_>, o: ZshOpt) -> X<bool> {
	Ok(state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, o)?)
}

/// The options the evaluator reads (zsh `isset(OCTALZEROES)`, …), read
/// once per top-level evaluation; also the options `convbase` takes.
/// Remembered while no root option changes ([`state::Root::opts_gen`]):
/// every `(( ))` asks. A subshell's own options (its overlay) are read
/// each time.
///
/// # Errors
/// [`Stop::Store`] when an option cannot be read.
pub fn math_options(ex: &mut Expander<'_, '_>) -> X<Options> {
	let cacheable = ex.vp.overlay.is_none();
	let now = ex.k.root.opts_gen();
	if cacheable
		&& let Some((g, mode, o)) = ex.k.math_opts
		&& g == now
		&& mode == ex.vp.mode
	{
		return Ok(o);
	}
	let o = Options {
		octal_zeroes:      opt(ex, ZshOpt::Octalzeroes)?,
		c_bases:           opt(ex, ZshOpt::Cbases)?,
		c_precedences:     opt(ex, ZshOpt::Cprecedences)?,
		force_float:       opt(ex, ZshOpt::Forcefloat)?,
		unset:             opt(ex, ZshOpt::Unset)?,
		multibyte:         opt(ex, ZshOpt::Multibyte)?,
		posix_identifiers: opt(ex, ZshOpt::Posixidentifiers)?,
		sh_emulation:      ex.vp.mode == ModeId::ZshSh,
	};
	// Reading an option may have filled the root's facts: key by the
	// generation they were read at.
	if cacheable && ex.k.root.opts_gen() == now {
		ex.k.math_opts = Some((now, ex.vp.mode, o));
	}
	Ok(o)
}

/// The evaluator's view of the shell during one top-level evaluation.
struct ShellEnv<'x, 'e, 'c> {
	ex:       &'x mut Expander<'e, 'c>,
	opts:     Options,
	state:    MathState,
	/// An error a method without a `Result` met (a store failure while
	/// reading `$#`, `$$` or `#name`): reported once the evaluation ends.
	held:     Option<Stop>,
	/// The evaluation assigned a variable: a math function call after it
	/// cannot park (the replay would assign again).
	assigned: bool,
}

impl<'x, 'e, 'c> ShellEnv<'x, 'e, 'c> {
	fn new(ex: &'x mut Expander<'e, 'c>) -> X<Self> {
		let opts = math_options(ex)?;
		Ok(Self { ex, opts, state: MathState::default(), held: None, assigned: false })
	}

	/// `r`, unless a method held back an error meanwhile (that error
	/// came first: a failed module autoload precedes the `unknown
	/// function` it causes, which zsh then does not print). The value of
	/// the last evaluation becomes the shell's `lastmathval`.
	fn finish<T>(&mut self, r: X<T>) -> X<T> {
		if r.is_ok() {
			self.keep_last();
		}
		match self.held.take() {
			Some(e) => Err(e),
			None => r,
		}
	}

	/// Keep the value of the last evaluation as the shell's `lastmathval`
	/// ([`crate::bash::vm::proc::VprocZsh::last_math`]).
	fn keep_last(&mut self) {
		if let Some(n) = self.state.last {
			self.ex.vp.zsh.get_or_insert_with(Box::default).last_math = Some(last_of(n));
		}
	}

	/// zsh `callmathfunc` for a user math function `f` called as `name`:
	/// the shell function (`f.func`, else `name`) runs with `$0` `name` and
	/// `args`; its value is the shell's `lastmathval` when it returns.
	fn call_user(&mut self, name: &[u8], f: &UserMathFunc, args: &[BString]) -> X<Number> {
		let func = if f.func.is_empty() {
			BString::from(name)
		} else {
			f.func.clone()
		};
		let call =
			MathCall { func: func.clone(), argzero: BString::from(name), args: args.to_vec() };
		// What the replay log holds next: the definition's loading (a hook
		// status, empty text) or the call (its value's text); the
		// replay follows the log whatever the function's state is now.
		let next = |ex: &Expander<'_, '_>| match ex.log.get(ex.cursor) {
			Some(Atom::Sub { out, .. }) => Some(out.is_empty()),
			_ => None,
		};
		let rec = state::record(self.ex.cx.store, self.ex.vp, Key::Func(BStr::new(&func)))?.cloned();
		let undefined =
			matches!(&rec, Some(Record::Func { attrs, .. }) if attrs.contains(Attrs::ZSH_UNDEFINED));
		if next(self.ex) == Some(true) || (next(self.ex).is_none() && undefined) {
			// zsh runs the autoload stub inside the call; the engine loads
			// the definition first (`autoload +X`).
			let mut text = b"builtin autoload +X -- ".to_vec();
			text.extend_from_slice(&crate::bash::vm::quote::sh_single_quote(&func));
			text.push(b'\n');
			if super::subst::call_here(self.ex, &tok::metafy(&text))? != 0 {
				return Ok(self.state.last.unwrap_or(Number::Int(0)));
			}
		}
		if next(self.ex).is_none() {
			if !matches!(rec, Some(Record::Func { .. })) {
				let msg = format!("no such function: {}", func.as_bstr());
				return Err(Stop::Fail(Diag::BadMathExpr { msg: msg.into() }));
			}
			if self.assigned {
				let what = format!(
					"math function {} called after an assignment in the same expression",
					BStr::new(name)
				);
				return Err(Stop::Fail(Diag::Unsupported { what: what.into() }));
			}
			// The value before the call: what the function returns when it
			// evaluates nothing.
			self.keep_last();
		}
		let (out, _) = super::subst::call_math(self.ex, call)?;
		Ok(decode_last(&out))
	}

	fn hold(&mut self, e: Stop) {
		if self.held.is_none() {
			self.held = Some(e);
		}
	}
}

impl Env for ShellEnv<'_, '_, '_> {
	type Error = Stop;
	/// What a subscripted operand resolved to (a plain name is found by
	/// name again: the same parameter). Boxed: every value-stack entry
	/// holds one, and most are `None`.
	type Slot = Option<Box<params::Value>>;

	fn options(&self) -> Options {
		self.opts
	}

	fn cache(&self) -> &Cache {
		&CACHE
	}

	fn compiled(&mut self, text: &[u8], flags: u8) -> Arc<math::Expr> {
		self.ex.k.zsh_arith_recent.get(text, flags, &CACHE)
	}

	fn state(&mut self) -> &mut MathState {
		&mut self.state
	}

	fn get(&mut self, lval: &[u8]) -> Result<Option<(Param, Self::Slot)>, Stop> {
		let subscripted = lval.contains(&b'[');
		if !subscripted && let Some(p) = params::direct_math_value(self.ex, lval)? {
			return Ok(Some((p, None)));
		}
		Ok(params::getmathparam(self.ex, lval)?.map(|(p, v)| (p, subscripted.then(|| Box::new(v)))))
	}

	fn set_slot(&mut self, slot: &Self::Slot, value: Number) -> Result<bool, Stop> {
		let Some(v) = slot else {
			return Ok(false);
		};
		let text = math::format_number(value, &self.state, self.opts);
		self.assigned = true;
		params::setmathvalue(self.ex, v, value, text.as_bytes())
	}

	fn assign(&mut self, lval: &[u8], value: Number) -> Result<Option<Assigned>, Stop> {
		self.assigned = true;
		if let Some(assigned) = params::setnparam_number(self.ex, lval, value)? {
			return Ok(Some(assigned));
		}
		let text = math::format_number(value, &self.state, self.opts);
		let radix = self.state.output_radix;
		params::setnparam(self.ex, lval, value, text.as_bytes(), radix).map(Some)
	}

	fn scalar(&mut self, name: &[u8]) -> Option<BString> {
		match params::getsparam(self.ex, name) {
			Ok(v) => v,
			Err(e) => {
				self.hold(e);
				None
			},
		}
	}

	fn argc(&mut self) -> i64 {
		match state::positional_ref(&self.ex.k.root, self.ex.cx.store, self.ex.vp) {
			Ok(p) => i64::try_from(p.len()).unwrap_or(i64::MAX),
			Err(e) => {
				self.hold(e.into());
				0
			},
		}
	}

	fn pid(&mut self) -> i64 {
		// A nested shell keeps its own `$$` in its overlay (as `$$` reads
		// it).
		match state::record(
			self.ex.cx.store,
			self.ex.vp,
			crate::bash::store::Key::Misc(crate::bash::store::MiscKey::ShellPid),
		) {
			Ok(Some(crate::bash::store::Record::Misc(v))) => std::str::from_utf8(v)
				.ok()
				.and_then(|s| s.parse().ok())
				.unwrap_or(0),
			Ok(_) => i64::from(self.ex.k.shell_pid),
			Err(e) => {
				self.hold(e.into());
				0
			},
		}
	}

	fn last_status(&mut self) -> i64 {
		i64::from(self.ex.vp.status)
	}

	fn warn(&mut self, warning: Warning) {
		let d = Diag::Warning { msg: warning.to_string().into() };
		self.ex.k.diag(self.ex.cx, self.ex.vp, self.ex.line, d);
	}

	/// The user math functions (`functions -M`), then those of loaded (or
	/// autoloadable) modules (zsh `getmathfunc(name, 1)`). A failed
	/// autoload's error is held: it ends the evaluation instead of the
	/// `unknown function` that follows.
	fn math_func(&mut self, name: &[u8]) -> Option<MathFunc> {
		match user_math_funcs(self.ex.cx.store, self.ex.vp) {
			Ok(fs) => {
				if let Some(f) = fs.iter().find(|f| f.name == name) {
					return Some(MathFunc {
						kind:     if f.string {
							FuncKind::UserString
						} else {
							FuncKind::User
						},
						min_args: usize::try_from(f.min).unwrap_or(0),
						max_args: usize::try_from(f.max).ok(),
					});
				}
			},
			Err(e) => {
				self.hold(e.into());
				return None;
			},
		}
		match zsh_module::math_module(self.ex, name) {
			Ok(Some(module)) => zsh_module::math_def(module, name),
			Ok(None) => None,
			Err(e) => {
				self.hold(e);
				None
			},
		}
	}

	fn call_math_func(
		&mut self,
		name: &[u8],
		func: &MathFunc,
		args: FuncArgs<'_>,
	) -> Result<Number, Stop> {
		if let (FuncKind::User | FuncKind::UserString, FuncArgs::Strings(strs)) = (func.kind, args) {
			let fs = user_math_funcs(self.ex.cx.store, self.ex.vp)?;
			if let Some(f) = fs.iter().find(|f| f.name == name) {
				return self.call_user(name, f, strs);
			}
			return Err(MathError::UnknownFunction { name: Nice(name.into()) }.into());
		}
		let Some(module) = zsh_module::math_module(self.ex, name)? else {
			return Err(MathError::UnknownFunction { name: Nice(name.into()) }.into());
		};
		zsh_module::call_math(self.ex, module, name, args)
	}
}

/// A user math function (zsh `struct mathfunc` with `MFF_USERFUNC`;
/// `functions -M`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserMathFunc {
	/// Its name in expressions.
	pub name:   BString,
	/// `-Ms`: the argument text is passed as is (`MFF_STR`).
	pub string: bool,
	/// Fewest arguments.
	pub min:    i32,
	/// Most arguments, -1 for no limit.
	pub max:    i32,
	/// The shell function it calls; empty: the one named `name`.
	pub func:   BString,
}

/// The user math functions, newest first (zsh's `mathfuncs` order;
/// [`MiscKey::ZshMathFuncs`]).
///
/// # Errors
/// A store failure.
pub fn user_math_funcs(
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<UserMathFunc>, StoreError> {
	let Some(Record::Words(w)) = state::record(store, vp, Key::Misc(MiscKey::ZshMathFuncs))? else {
		return Ok(Vec::new());
	};
	let num = |s: &BString| {
		std::str::from_utf8(s)
			.ok()
			.and_then(|s| s.parse().ok())
			.unwrap_or(-1)
	};
	Ok(w
		.as_chunks::<5>()
		.0
		.iter()
		.map(|c| UserMathFunc {
			name:   c[0].clone(),
			string: c[1].as_slice() == b"s",
			min:    num(&c[2]).max(0),
			max:    num(&c[3]),
			func:   c[4].clone(),
		})
		.collect())
}

/// The record of user math functions `fs` ([`user_math_funcs`]); `None`
/// when there are none.
pub fn user_math_record(fs: &[UserMathFunc]) -> Option<Record> {
	if fs.is_empty() {
		return None;
	}
	let mut w = Vec::with_capacity(fs.len() * 5);
	for f in fs {
		w.push(f.name.clone());
		w.push(BString::from(if f.string { "s" } else { "" }));
		w.push(BString::from(f.min.to_string()));
		w.push(BString::from(f.max.to_string()));
		w.push(f.func.clone());
	}
	Some(Record::Words(w))
}

/// zsh's `lastmathval` as a vproc keeps it.
const fn last_of(n: Number) -> LastMath {
	match n {
		Number::Int(i) => LastMath::Int(i),
		Number::Float(f) => LastMath::Float(f.to_bits()),
	}
}

/// The text a math function call logs for its value
/// ([`crate::bash::vm::proc::PendingSub::Math`]): `i` and the decimal
/// integer, `f` and the float's bits in hex; `i0` when no evaluation ran.
pub fn encode_last(v: Option<LastMath>) -> Vec<u8> {
	match v.unwrap_or(LastMath::Int(0)) {
		LastMath::Int(i) => format!("i{i}").into_bytes(),
		LastMath::Float(b) => format!("f{b:x}").into_bytes(),
	}
}

/// The value [`encode_last`] logged (0 for anything else).
fn decode_last(s: &[u8]) -> Number {
	let text = std::str::from_utf8(s.get(1..).unwrap_or_default()).unwrap_or_default();
	match s.first() {
		Some(b'f') => Number::Float(f64::from_bits(u64::from_str_radix(text, 16).unwrap_or(0))),
		_ => Number::Int(text.parse().unwrap_or(0)),
	}
}

/// zsh `matheval`: evaluate `text` (metafied, possibly tokenized, after
/// expansion) for `(( ))`, `let`, the arithmetic `for`, `[[ -eq ]]` and
/// float assignments.
///
/// # Errors
/// The math error (zsh's text), a parameter error, or a parked
/// substitution in a subscript.
pub fn matheval(ex: &mut Expander<'_, '_>, text: &[u8]) -> X<Number> {
	let mut env = ShellEnv::new(ex)?;
	let r = math::matheval(&mut env, text);
	env.finish(r)
}

/// zsh `mathevali`: [`matheval`] as an integer (floats truncated), for
/// integer contexts (`shift N`, `return N`, `print -C N`, …).
///
/// # Errors
/// As [`matheval`].
pub fn mathevali(ex: &mut Expander<'_, '_>, text: &[u8]) -> X<i64> {
	let mut env = ShellEnv::new(ex)?;
	let r = math::mathevali(&mut env, text);
	env.finish(r)
}

/// zsh `mathevalarg`: a subscript expression at the start of `text`, up to
/// a `,` or a character that cannot continue it; its value and the offset
/// where it ended.
///
/// # Errors
/// As [`matheval`]; an empty text is `bad math expression: empty string`.
pub fn mathevalarg(ex: &mut Expander<'_, '_>, text: &[u8]) -> X<(i64, usize)> {
	let mut env = ShellEnv::new(ex)?;
	let r = math::mathevalarg(&mut env, text);
	env.finish(r)
}

/// [`matheval`] and zsh's `lastbase` after it: the base of the last based
/// constant of the expression (`16#ff` → 16), -1 for none. An integer
/// parameter assigned from such an expression takes that output base
/// (`params.c` `assignstrvalue`).
///
/// # Errors
/// As [`matheval`].
pub fn matheval_lastbase(ex: &mut Expander<'_, '_>, text: &[u8]) -> X<(Number, i32)> {
	let mut env = ShellEnv::new(ex)?;
	let r = math::matheval(&mut env, text);
	let r = env.finish(r)?;
	Ok((r, env.state.lastbase))
}

/// `$(( text ))`: the value as zsh's `arithsubst` prints it, in the output
/// base and grouping the expression chose with `[#N]` / `[#_N]`.
///
/// # Errors
/// As [`matheval`].
pub fn matheval_text(ex: &mut Expander<'_, '_>, text: &[u8]) -> X<BString> {
	let mut env = ShellEnv::new(ex)?;
	let r = math::matheval(&mut env, text);
	let n = env.finish(r)?;
	Ok(math::format_number(n, &env.state, env.opts).into())
}
