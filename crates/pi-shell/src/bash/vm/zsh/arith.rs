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

use std::sync::LazyLock;

use bstr::BString;

use super::{
	math::{
		self, Assigned, Cache, Env, FuncArgs, MathError, MathFunc, MathState, Nice, Number, Options,
		Param, Warning,
	},
	params,
};
use crate::bash::{
	diag::Diag,
	ids::ModeId,
	vm::{
		expand::{Expander, Stop, X},
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
///
/// # Errors
/// [`Stop::Store`] when an option cannot be read.
pub fn math_options(ex: &mut Expander<'_, '_>) -> X<Options> {
	Ok(Options {
		octal_zeroes:      opt(ex, ZshOpt::Octalzeroes)?,
		c_bases:           opt(ex, ZshOpt::Cbases)?,
		c_precedences:     opt(ex, ZshOpt::Cprecedences)?,
		force_float:       opt(ex, ZshOpt::Forcefloat)?,
		unset:             opt(ex, ZshOpt::Unset)?,
		multibyte:         opt(ex, ZshOpt::Multibyte)?,
		posix_identifiers: opt(ex, ZshOpt::Posixidentifiers)?,
		sh_emulation:      ex.vp.mode == ModeId::ZshSh,
	})
}

/// The evaluator's view of the shell during one top-level evaluation.
struct ShellEnv<'x, 'e, 'c> {
	ex:    &'x mut Expander<'e, 'c>,
	opts:  Options,
	state: MathState,
	/// An error a method without a `Result` met (a store failure while
	/// reading `$#`, `$$` or `#name`): reported once the evaluation ends.
	held:  Option<Stop>,
}

impl<'x, 'e, 'c> ShellEnv<'x, 'e, 'c> {
	fn new(ex: &'x mut Expander<'e, 'c>) -> X<Self> {
		let opts = math_options(ex)?;
		Ok(Self { ex, opts, state: MathState::default(), held: None })
	}

	/// `r`, unless a method held back an error meanwhile.
	fn finish<T>(&mut self, r: X<T>) -> X<T> {
		match self.held.take() {
			Some(e) if r.is_ok() => Err(e),
			_ => r,
		}
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
	/// name again: the same parameter).
	type Slot = Option<params::Value>;

	fn options(&self) -> Options {
		self.opts
	}

	fn cache(&self) -> &Cache {
		&CACHE
	}

	fn state(&mut self) -> &mut MathState {
		&mut self.state
	}

	fn get(&mut self, lval: &[u8]) -> Result<Option<(Param, Self::Slot)>, Stop> {
		let subscripted = lval.contains(&b'[');
		Ok(params::getmathparam(self.ex, lval)?.map(|(p, v)| (p, subscripted.then_some(v))))
	}

	fn set_slot(&mut self, slot: &Self::Slot, value: Number) -> Result<bool, Stop> {
		let Some(v) = slot else {
			return Ok(false);
		};
		let text = math::format_number(value, &self.state, self.opts);
		params::setmathvalue(self.ex, v, value, text.as_bytes())
	}

	fn assign(&mut self, lval: &[u8], value: Number) -> Result<Option<Assigned>, Stop> {
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

	/// No math function exists: `zsh/mathfunc` is not a module this engine
	/// provides, and `functions -M` is not supported.
	fn math_func(&mut self, _name: &[u8]) -> Option<MathFunc> {
		None
	}

	fn call_math_func(
		&mut self,
		name: &[u8],
		_func: &MathFunc,
		_args: FuncArgs<'_>,
	) -> Result<Number, Stop> {
		Err(MathError::UnknownFunction { name: Nice(name.into()) }.into())
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
