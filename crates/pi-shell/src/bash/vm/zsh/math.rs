//! zsh arithmetic: a port of zsh 5.9 `Src/math.c`.
//!
//! Ported: `matheval`, `mathevali`, `mathevalarg`, the `zzlex` lexer, the
//! operator-precedence parser `mathparse` and its `op`/`bop` actions,
//! `getmathparam`, `setmathvar`, `callmathfunc`, with the conversions of
//! `params.c` and `utils.c` it relies on (`convbase`, `convfloat`,
//! `zstrtol_underscore`, `getkeystring` for `##x`).
//!
//! zsh evaluates while it parses: operands go on a value stack, each
//! operator is applied when its right operand is complete, and a `noeval`
//! counter suppresses the reads, writes and calls of untaken branches
//! (`0 && …`, the arms of `?:`). The parse never depends on values, so this
//! port runs `mathparse` once per text and records what it does, in order,
//! as a flat program; evaluation replays the program against the value
//! stack. Variables are read, assigned and reported exactly when zsh does,
//! and the first syntax error is raised at the point where zsh's parser
//! stops, after everything to its left was evaluated. Programs are cached
//! by text ([`Cache`]).
//!
//! zsh's evaluator globals (`mlevel`, `outputradix`, `outputunderscore`,
//! `lastbase`) live in a [`MathState`] the caller owns ([`Env::state`]): a
//! `$(( ))` formats its result with the output base the expression chose
//! ([`format_number`]), and nested evaluations (variable values that are
//! expressions, subscripts, math functions) share it as they do in zsh.
//!
//! Strings are zsh's metafied, possibly tokenized representation
//! (`crate::bash::syntax::zsh::tok`); values the [`Env`] returns are raw bytes.
//! Errors ([`MathError`]) carry zsh's message text; the caller adds zsh's
//! `scriptname:line: ` prefix.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::{borrow::Cow, fmt, fmt::Write as _, sync::Arc};

use bstr::{BString, ByteSlice};
use hashbrown::HashMap;
use parking_lot::Mutex;

use crate::bash::syntax::zsh::{
	tok,
	tok::{at, head, tail},
};

/// A number (zsh `mnumber`): what an expression evaluates to, and what the
/// evaluator reads from and writes to variables.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Number {
	/// An integer (`MN_INTEGER`), 64-bit and wrapping like zsh's `zlong`.
	Int(i64),
	/// A double (`MN_FLOAT`).
	Float(f64),
}

impl Number {
	/// The integer value (zsh `mathevali`'s `(zlong)x.u.d` for a float:
	/// truncated toward zero, saturating), for integer contexts.
	pub const fn to_int(self) -> i64 {
		match self {
			Self::Int(v) => v,
			Self::Float(d) => d as i64,
		}
	}

	/// The value as a double (`(double)x.u.l` for an integer).
	pub const fn to_float(self) -> f64 {
		match self {
			Self::Int(v) => v as f64,
			Self::Float(d) => d,
		}
	}

	/// Whether the value is a float (`type & MN_FLOAT`).
	pub const fn is_float(self) -> bool {
		matches!(self, Self::Float(_))
	}

	/// zsh's truth test of a condition (`?:`): non-zero; NaN is true.
	const fn truth(self) -> bool {
		match self {
			Self::Int(v) => v != 0,
			Self::Float(d) => d != 0.0,
		}
	}

	/// `op`'s coercion of the operands of the integer-only operators
	/// (`OP_A2IO`, `OP_E2IO`).
	const fn integer(self) -> Self {
		Self::Int(self.to_int())
	}

	/// `op`'s promotion of both operands when their types differ.
	const fn float(self) -> Self {
		Self::Float(self.to_float())
	}

	/// `self` plus `d` (`++`/`--`).
	const fn step(self, d: i64) -> Self {
		match self {
			Self::Int(v) => Self::Int(v.wrapping_add(d)),
			Self::Float(f) => Self::Float(f + d as f64),
		}
	}
}

/// The zsh options the evaluator consults, read by every evaluation from
/// [`Env::options`]. `ksharrays` is not among them: `math.c` hands
/// subscripts to the parameter code unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
	/// `octalzeroes`: `010` is octal (8).
	pub octal_zeroes:      bool,
	/// `cbases`: output base 16 prints as `0xFF`, base 8 as `010` when
	/// `octalzeroes` is set too.
	pub c_bases:           bool,
	/// `cprecedences`: C's operator precedence table instead of zsh's.
	pub c_precedences:     bool,
	/// `forcefloat`: constants and integer variables are read as floats.
	pub force_float:       bool,
	/// `unset` (on by default): an unset variable reads as 0; off
	/// (`nounset`) reading one is an error.
	pub unset:             bool,
	/// `multibyte` (on by default): `##x`, `#name` and identifiers decode
	/// UTF-8 characters.
	pub multibyte:         bool,
	/// `posixidentifiers`: identifiers are ASCII only.
	pub posix_identifiers: bool,
	/// The current emulation is `sh` (zsh `EMULATION(EMULATE_SH)`): `NaN`
	/// and `Inf` are plain names.
	pub sh_emulation:      bool,
}

impl Default for Options {
	/// zsh's defaults in zsh emulation: `unset` and `multibyte` on, the
	/// rest off.
	fn default() -> Self {
		Self {
			octal_zeroes:      false,
			c_bases:           false,
			c_precedences:     false,
			force_float:       false,
			unset:             true,
			multibyte:         true,
			posix_identifiers: false,
			sh_emulation:      false,
		}
	}
}

/// Compile flag: `octalzeroes`.
const F_OCTAL: u8 = 1;
/// Compile flag: `forcefloat`.
const F_FORCE: u8 = 1 << 1;
/// Compile flag: `cprecedences`.
const F_CPREC: u8 = 1 << 2;
/// Compile flag: sh emulation (`NaN`/`Inf` are names).
const F_SH: u8 = 1 << 3;
/// Compile flag: `multibyte`.
const F_MULTIBYTE: u8 = 1 << 4;
/// Compile flag: `posixidentifiers`.
const F_POSIXID: u8 = 1 << 5;
/// Compile flag: parsed at argument precedence (`MPREC_ARG`).
const F_ARG: u8 = 1 << 6;

impl Options {
	/// The options that change what `text` compiles to, plus the
	/// precedence it is parsed at: part of the [`Cache`] key.
	fn flags(self, arg: bool) -> u8 {
		let mut f = 0;
		for (on, bit) in [
			(self.octal_zeroes, F_OCTAL),
			(self.force_float, F_FORCE),
			(self.c_precedences, F_CPREC),
			(self.sh_emulation, F_SH),
			(self.multibyte, F_MULTIBYTE),
			(self.posix_identifiers, F_POSIXID),
			(arg, F_ARG),
		] {
			if on {
				f |= bit;
			}
		}
		f
	}
}

/// zsh's evaluator globals, owned by the caller so that every evaluation
/// of a shell (including the nested ones its [`Env`] starts) shares them,
/// as zsh's do.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MathState {
	/// The value of the last evaluation that ended, at any nesting level
	/// (zsh `lastmathval`); `None` before the first.
	pub last:              Option<Number>,
	/// Nesting depth of evaluations in progress (zsh `mlevel`): a top-level
	/// evaluation ([`matheval`] at 0) resets the output format.
	pub mlevel:            u32,
	/// Output base chosen by `[#N]` (zsh `outputradix`): 0 for none,
	/// negative for `[##N]` (no base prefix). [`format_number`] uses it.
	pub output_radix:      i32,
	/// Digit grouping chosen by `[#_N]` (zsh `outputunderscore`): 0 for
	/// none.
	pub output_underscore: i32,
	/// Base of the last based constant of the last top-level expression
	/// (zsh `lastbase`: `16#ff` and `0x` give 16, `0b` 2, octal 8), -1 for
	/// none: `typeset -i x=16#ff` gives `x` that output base.
	pub lastbase:          i32,
}

/// A variable's value as [`Env::get`] finds it (zsh `getvalue` +
/// `getnumvalue`).
#[derive(Clone, Debug, PartialEq)]
pub enum Param {
	/// An integer variable (`PM_INTEGER`), or a number the parameter code
	/// computes (an inverse subscript's index).
	Int(i64),
	/// A float variable (`PM_EFLOAT`/`PM_FFLOAT`).
	Float(f64),
	/// A scalar, an array element, or an array joined with spaces (raw
	/// bytes): evaluated as an expression, so `x='1+2'` reads as 3.
	Text(BString),
}

/// The type of the variable an assignment wrote ([`Env::assign`]): zsh
/// returns the assigned value converted to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Assigned {
	/// `PM_INTEGER`: the value is truncated to an integer.
	Integer,
	/// `PM_EFLOAT`/`PM_FFLOAT`: the value becomes a float.
	Float,
	/// Anything else (scalar, array element): the value is unchanged.
	Other,
}

/// How a math function takes its arguments (zsh `MFF_STR`,
/// `MFF_USERFUNC`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FuncKind {
	/// A built-in numeric function: arguments evaluated as expressions.
	Numeric,
	/// A built-in string function (`MFF_STR`): the argument text as is,
	/// without an argument count check.
	String,
	/// A shell function taking its evaluated arguments as text
	/// (`functions -M`, `MFF_USERFUNC`).
	User,
	/// A shell function taking its argument text (`functions -Ms`).
	UserString,
}

/// A math function as [`Env::math_func`] finds it (zsh `struct mathfunc`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MathFunc {
	/// How it takes arguments.
	pub kind:     FuncKind,
	/// Fewest arguments accepted (`minargs`).
	pub min_args: usize,
	/// Most arguments accepted, `None` for no limit (`maxargs` -1).
	pub max_args: Option<usize>,
}

/// The arguments of a math function call ([`Env::call_math_func`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FuncArgs<'a> {
	/// [`FuncKind::String`]: the text between the parentheses (metafied).
	Text(&'a [u8]),
	/// [`FuncKind::Numeric`]: the evaluated arguments.
	Numbers(&'a [Number]),
	/// [`FuncKind::UserString`] (the argument text): the shell function's
	/// positional parameters.
	Strings(&'a [BString]),
}

/// Text in a message, shown as zsh's `nicezputs` shows it: control
/// characters as `^X`, `\n` and `\t` as escapes, bytes that are not UTF-8
/// as `\M-x`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Nice(pub BString);

impl Nice {
	/// The raw text of metafied, possibly tokenized zsh string `s` (tokens
	/// become the characters they stand for).
	fn of(s: &[u8]) -> Self {
		let mut v = s.to_vec();
		tok::untokenize(&mut v);
		Self(BString::from(tok::unmetafy(&v)))
	}
}

/// zsh `nicechar` for one byte below 0x80.
fn nice_ascii(f: &mut fmt::Formatter<'_>, c: u8) -> fmt::Result {
	match c {
		b'\n' => f.write_str("\\n"),
		b'\t' => f.write_str("\\t"),
		0x7f => f.write_str("^?"),
		0..=0x1f => write!(f, "^{}", char::from(c + 0x40)),
		_ => write!(f, "{}", char::from(c)),
	}
}

impl fmt::Display for Nice {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		for chunk in self.0.utf8_chunks() {
			for ch in chunk.valid().chars() {
				if ch.is_ascii() {
					nice_ascii(f, ch as u8)?;
				} else {
					f.write_char(ch)?;
				}
			}
			for &b in chunk.invalid() {
				f.write_str("\\M-")?;
				nice_ascii(f, b & 0x7f)?;
			}
		}
		Ok(())
	}
}

/// The start of the rest of an expression where a syntax error was found:
/// at most 10 characters, `...` when there were more (zsh `checkunary`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snippet {
	/// The characters shown.
	pub text: Nice,
	/// Whether the expression went on after them.
	pub more: bool,
}

impl Snippet {
	/// The snippet of metafied `rest` (up to its first NUL, as zsh's C
	/// string ends there); a metafied pair counts as one character.
	fn of(rest: &[u8]) -> Self {
		let rest = head(rest, rest.iter().position(|&c| c == 0).unwrap_or(rest.len()));
		let mut i = 0;
		let mut n = 0;
		while i < rest.len() && n < 10 {
			i += if at(rest, i) == tok::META { 2 } else { 1 };
			n += 1;
		}
		let i = i.min(rest.len());
		Self { text: Nice::of(head(rest, i)), more: i < rest.len() }
	}
}

impl fmt::Display for Snippet {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}{}", self.text, if self.more { "..." } else { "" })
	}
}

/// What the parser expected when it found the other kind of token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::Display)]
#[strum(serialize_all = "lowercase")]
pub enum Expected {
	/// A number, variable or unary operator.
	Operand,
	/// A binary or postfix operator.
	Operator,
}

/// A zsh arithmetic error, with zsh's message text (without the
/// `scriptname:line: ` prefix the caller adds). Raised once: zsh stops
/// evaluating at its first error.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MathError {
	/// An operand where an operator belongs or vice versa (`checkunary`).
	#[error("bad math expression: {what} expected at `{at}'")]
	Expected {
		/// What belonged there.
		what: Expected,
		/// The rest of the expression from there.
		at:   Snippet,
	},
	/// The expression ended where an operand or operator was needed.
	#[error("bad math expression: {what} expected at end of string")]
	ExpectedAtEnd {
		/// What was needed.
		what: Expected,
	},
	/// A `)` without its `(`.
	#[error("bad math expression: unexpected ')'")]
	UnexpectedParen,
	/// A `(` without its `)`.
	#[error("bad math expression: ')' expected")]
	ParenExpected,
	/// A `?` without its `:`.
	#[error("bad math expression: ':' expected")]
	ColonExpected,
	/// A `:` without its `?`.
	#[error("bad math expression: ':' without '?'")]
	ColonWithoutQuest,
	/// An assignment or `++`/`--` of something that is not a variable.
	#[error("bad math expression: lvalue required")]
	LvalueRequired,
	/// A negative number raised to a non-integer power.
	#[error("bad math expression: imaginary power")]
	ImaginaryPower,
	/// An operator found no operand on the value stack.
	#[error("bad math expression: stack empty")]
	StackEmpty,
	/// An operator the evaluator has no action for.
	#[error("bad math expression: out of integers")]
	OutOfIntegers,
	/// Text left after a complete expression.
	#[error("bad math expression: illegal character: {c}")]
	IllegalCharacter {
		/// The first character left.
		c: Nice,
	},
	/// [`mathevalarg`] of an empty subscript.
	#[error("bad math expression: empty string")]
	EmptyString,
	/// `##` at the end of the expression.
	#[error("bad math expression: character missing after ##")]
	CharacterMissing,
	/// `##` followed by no decodable character.
	#[error("bad math expression: bad character after ##")]
	BadCharacter,
	/// Integer division or modulus by zero.
	#[error("division by zero")]
	DivisionByZero,
	/// More than 100 operands pending on the value stack.
	#[error("stack overflow")]
	StackOverflow,
	/// Evaluations nested more than 256 deep (variable values that are
	/// expressions naming each other), or parentheses and unary operators
	/// nested beyond the parser's bound.
	#[error("math recursion limit exceeded: {expr}")]
	RecursionLimit {
		/// The expression that would have gone one level deeper.
		expr: Nice,
	},
	/// `[N]` input base syntax not followed by a digit.
	#[error("bad base syntax")]
	BadBaseSyntax,
	/// A malformed `[#…]` output format.
	#[error("bad output format specification")]
	BadOutputFormat,
	/// A base outside 2..=36 (`37#1`, `[#1]`).
	#[error("invalid base (must be 2 to 36 inclusive): {base}")]
	InvalidBase {
		/// The base given.
		base: i32,
	},
	/// A float constant `strtod` rejects (`1..2`, `.`).
	#[error("bad floating point constant")]
	BadFloat,
	/// `nounset` and an unset variable read where it is evaluated.
	#[error("{name}: parameter not set")]
	NotSet {
		/// The variable as written, with its subscript.
		name: Nice,
	},
	/// A call of a function [`Env::math_func`] does not know.
	#[error("unknown function: {name}")]
	UnknownFunction {
		/// The function's name.
		name: Nice,
	},
	/// A math function called with an argument count outside its range.
	#[error("wrong number of arguments: {call}")]
	WrongArguments {
		/// The call as written.
		call: Nice,
	},
}

/// A warning the evaluator reports without stopping (zsh `zwarn`), through
/// [`Env::warn`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Warning {
	/// A constant too large for 64 bits (`zstrtol_underscore`): its value
	/// is the digits before the one that overflowed.
	#[error("number truncated after {digits} digits: {text}")]
	Truncated {
		/// Digits kept.
		digits: usize,
		/// The rest of the expression from the constant's first digit.
		text:   Nice,
	},
}

/// What the evaluator needs from the shell.
///
/// Variables, the options, the shared state and cache, and math functions.
/// One implementation per shell; evaluations started from inside its
/// methods (subscripts, math function bodies) share its [`MathState`].
pub trait Env {
	/// What [`Env::get`] resolved a variable reference to (zsh's cached
	/// `Value`): an assignment to the same operand writes through it, so a
	/// subscript is evaluated once for `a[i++] += 1`.
	type Slot;
	/// The caller's error type; every [`MathError`] converts into it.
	type Error: From<MathError>;

	/// The options in effect, read at the start of each evaluation.
	fn options(&self) -> Options;
	/// The compiled-expression cache.
	fn cache(&self) -> &Cache;
	/// zsh's evaluator globals.
	fn state(&mut self) -> &mut MathState;
	/// The variable `lval` names (zsh `getvalue`, then `getnumvalue`):
	/// `name` or `name[subscript]`, metafied as the expression wrote it,
	/// possibly holding tokens; the subscript is the parameter code's to
	/// evaluate (zsh's `getindex`, through [`mathevalarg`] for arrays).
	/// `None` when it is not set.
	fn get(&mut self, lval: &[u8]) -> Result<Option<(Param, Self::Slot)>, Self::Error>;
	/// Assign `value` through `slot` (zsh `setnumvalue`: scalars receive
	/// [`format_number`]'s text with the current [`MathState`] format,
	/// integers and floats the number; read-only variables fail). `false`
	/// when the slot no longer names the variable it was resolved to: the
	/// evaluator then assigns by name ([`Env::assign`]).
	fn set_slot(&mut self, slot: &Self::Slot, value: Number) -> Result<bool, Self::Error>;
	/// Assign `value` to `lval` (untokenized), creating the variable (zsh
	/// `setnparam`: an integer or float variable for a plain name, with the
	/// current output base as its base, an array element for a
	/// subscript; a non-special array assigned without subscript is
	/// replaced; `not an identifier` for anything else). `None` when
	/// nothing was assigned without an error (`noexec`).
	fn assign(&mut self, lval: &[u8], value: Number) -> Result<Option<Assigned>, Self::Error>;
	/// The text of variable `name` (raw bytes; arrays joined), `None` when
	/// unset (zsh `getsparam`): `#name` is its first character's code.
	fn scalar(&mut self, name: &[u8]) -> Option<BString>;
	/// The number of positional parameters (zsh `$#`): a `#` not followed
	/// by a name.
	fn argc(&mut self) -> i64;
	/// The shell's process id (zsh `$$`): a `$` left in the expression.
	fn pid(&mut self) -> i64;
	/// The last command's status (zsh `$?`): a `?` where an operand
	/// belongs.
	fn last_status(&mut self) -> i64;
	/// Report a warning (zsh `zwarn`, with the caller's prefix).
	fn warn(&mut self, warning: Warning);
	/// The math function `name` (zsh `getmathfunc`, autoloading), `None`
	/// for an unknown one.
	fn math_func(&mut self, name: &[u8]) -> Option<MathFunc>;
	/// Call math function `name` (as [`Env::math_func`] returned it) with
	/// `args`. A [`FuncKind::UserString`] function runs the shell function
	/// and returns
	/// the value of the last arithmetic evaluation it ran (zsh
	/// `lastmathval`).
	fn call_math_func(
		&mut self,
		name: &[u8],
		func: &MathFunc,
		args: FuncArgs<'_>,
	) -> Result<Number, Self::Error>;
}

/// Evaluation nesting limit (zsh `MAX_MLEVEL`).
const MAX_MLEVEL: u32 = 256;

/// Value stack size (zsh `STACKSZ`): pushing a 101st pending operand is a
/// `stack overflow`.
const STACKSZ: usize = 100;

/// Bound on the parser's recursion (parentheses, unary operators and
/// right-associative chains nested in one expression). zsh recurses on the
/// C stack without a bound; this keeps the Rust stack safe and reports
/// [`MathError::RecursionLimit`] instead.
const MAX_PARSE_DEPTH: u32 = 1024;

/// Entries the [`Cache`] holds at most, so a script that generates unique
/// expressions cannot grow it without bound.
const CACHE_ENTRIES: usize = 4096;

/// Compiled expressions by text, shared by every shell of an engine:
/// compiling is a pure function of the text and the compile options.
#[derive(Default)]
pub struct Cache {
	gens: Mutex<Gens>,
}

/// The two generations of a [`Cache`]: a full young generation becomes the
/// old one (the previous old one is dropped), and an old entry that is hit
/// moves back to the young one, so expressions in use survive a stream of
/// one-off texts.
#[derive(Default)]
struct Gens {
	young: HashMap<BString, Arc<Expr>>,
	old:   HashMap<BString, Arc<Expr>>,
}

impl Gens {
	fn insert(&mut self, text: BString, expr: Arc<Expr>) {
		if self.young.len() >= CACHE_ENTRIES / 2 {
			self.old = std::mem::take(&mut self.young);
		}
		self.young.insert(text, expr);
	}
}

impl Cache {
	/// The program of `text` under compile flags `flags`, compiling it on a
	/// miss or when the cached one was compiled under other options.
	fn get(&self, text: &[u8], flags: u8) -> Arc<Expr> {
		{
			let mut gens = self.gens.lock();
			if let Some(e) = gens.young.get(text)
				&& e.flags == flags
			{
				return Arc::clone(e);
			}
			if let Some((key, e)) = gens.old.remove_entry(text)
				&& e.flags == flags
			{
				gens.insert(key, Arc::clone(&e));
				return e;
			}
		}
		let expr = Arc::new(compile(text, flags));
		self
			.gens
			.lock()
			.insert(BString::from(text), Arc::clone(&expr));
		expr
	}
}

/// A token of zsh's math lexer, numbered as `math.c` numbers them (the
/// tables below are indexed by it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Tok {
	InPar,
	OutPar,
	Not,
	Comp,
	PostPlus,
	PostMinus,
	UPlus,
	UMinus,
	And,
	Xor,
	Or,
	Mul,
	Div,
	Mod,
	Plus,
	Minus,
	ShLeft,
	ShRight,
	Les,
	Leq,
	Gre,
	Geq,
	Deq,
	Neq,
	DAnd,
	DOr,
	DXor,
	Quest,
	Colon,
	Eq,
	PlusEq,
	MinusEq,
	MulEq,
	DivEq,
	ModEq,
	AndEq,
	XorEq,
	OrEq,
	ShLeftEq,
	ShRightEq,
	DAndEq,
	DOrEq,
	DXorEq,
	Comma,
	Eoi,
	PrePlus,
	PreMinus,
	Num,
	Id,
	Power,
	Cid,
	PowerEq,
	Func,
}

/// Number of tokens (zsh `TOKCOUNT`).
const TOKCOUNT: usize = 53;

/// C's precedences (zsh `c_prec`, `cprecedences`): lower binds tighter.
#[rustfmt::skip]
const C_PREC: [u8; TOKCOUNT] = [
	//  InPar OutPar Not Comp PostPlus
	1, 137, 2, 2, 2,
	//  PostMinus UPlus UMinus And Xor
	2, 2, 2, 9, 10,
	//  Or Mul Div Mod Plus
	11, 4, 4, 4, 5,
	//  Minus ShLeft ShRight Les Leq
	5, 6, 6, 7, 7,
	//  Gre Geq Deq Neq DAnd
	7, 7, 8, 8, 12,
	//  DOr DXor Quest Colon Eq
	14, 13, 15, 16, 17,
	//  PlusEq MinusEq MulEq DivEq ModEq
	17, 17, 17, 17, 17,
	//  AndEq XorEq OrEq ShLeftEq ShRightEq
	17, 17, 17, 17, 17,
	//  DAndEq DOrEq DXorEq Comma Eoi
	17, 17, 17, 18, 200,
	//  PrePlus PreMinus Num Id Power
	2, 2, 0, 0, 3,
	//  Cid PowerEq Func
	0, 17, 0,
];

/// zsh's default precedences (zsh `z_prec`): shifts and bitwise operators
/// bind tighter than `**`, `*` and `+`.
#[rustfmt::skip]
const Z_PREC: [u8; TOKCOUNT] = [
	//  InPar OutPar Not Comp PostPlus
	1, 137, 2, 2, 2,
	//  PostMinus UPlus UMinus And Xor
	2, 2, 2, 4, 5,
	//  Or Mul Div Mod Plus
	6, 8, 8, 8, 9,
	//  Minus ShLeft ShRight Les Leq
	9, 3, 3, 10, 10,
	//  Gre Geq Deq Neq DAnd
	10, 10, 11, 11, 12,
	//  DOr DXor Quest Colon Eq
	13, 13, 14, 15, 16,
	//  PlusEq MinusEq MulEq DivEq ModEq
	16, 16, 16, 16, 16,
	//  AndEq XorEq OrEq ShLeftEq ShRightEq
	16, 16, 16, 16, 16,
	//  DAndEq DOrEq DXorEq Comma Eoi
	16, 16, 16, 17, 200,
	//  PrePlus PreMinus Num Id Power
	2, 2, 0, 0, 7,
	//  Cid PowerEq Func
	0, 16, 0,
];

/// Left-to-right associative (zsh `LR`).
const LR: u16 = 0x0000;
/// Right-to-left associative (zsh `RL`).
const RL: u16 = 0x0001;
/// Short-circuiting boolean (zsh `BOOL`).
const BOOL: u16 = 0x0002;
/// Two operands (zsh `OP_A2`).
const OP_A2: u16 = 0x0004;
/// Two operands, integer result (zsh `OP_A2IR`).
const OP_A2IR: u16 = 0x0008;
/// Two integer operands, integer result (zsh `OP_A2IO`).
const OP_A2IO: u16 = 0x0010;
/// Two operands, assigns (zsh `OP_E2`).
const OP_E2: u16 = 0x0020;
/// Two integer operands, assigns (zsh `OP_E2IO`).
const OP_E2IO: u16 = 0x0040;
/// Found where an operator belongs (zsh `OP_OP`).
const OP_OP: u16 = 0x0080;
/// Followed by an operator (zsh `OP_OPF`).
const OP_OPF: u16 = 0x0100;
/// Every binary kind.
const OP_BINARY: u16 = OP_A2 | OP_A2IR | OP_A2IO | OP_E2 | OP_E2IO;

/// Associativity and operand kinds per token (zsh `type`). `^^=` is
/// `OP_A2IO` in zsh: it computes without assigning.
#[rustfmt::skip]
const TYPE: [u16; TOKCOUNT] = [
	//  InPar OutPar Not Comp PostPlus
	LR, OP_OP | OP_OPF, RL, RL, RL | OP_OP | OP_OPF,
	//  PostMinus UPlus UMinus And Xor
	RL | OP_OP | OP_OPF, RL, RL, OP_A2IO, OP_A2IO,
	//  Or Mul Div Mod Plus
	OP_A2IO, OP_A2, OP_A2, OP_A2, OP_A2,
	//  Minus ShLeft ShRight Les Leq
	OP_A2, OP_A2IO, OP_A2IO, OP_A2IR, OP_A2IR,
	//  Gre Geq Deq Neq DAnd
	OP_A2IR, OP_A2IR, OP_A2IR, OP_A2IR, BOOL | OP_A2IO,
	//  DOr DXor Quest Colon Eq
	BOOL | OP_A2IO, OP_A2IO, RL | OP_OP, RL | OP_OP, RL | OP_E2,
	//  PlusEq MinusEq MulEq DivEq ModEq
	RL | OP_E2, RL | OP_E2, RL | OP_E2, RL | OP_E2, RL | OP_E2,
	//  AndEq XorEq OrEq ShLeftEq ShRightEq
	RL | OP_E2IO, RL | OP_E2IO, RL | OP_E2IO, RL | OP_E2IO, RL | OP_E2IO,
	//  DAndEq DOrEq DXorEq Comma Eoi
	BOOL | OP_E2IO, BOOL | OP_E2IO, RL | OP_A2IO, RL | OP_A2, RL | OP_OP,
	//  PrePlus PreMinus Num Id Power
	RL, RL, OP_OPF, OP_OPF, RL | OP_A2,
	//  Cid PowerEq Func
	OP_OPF, RL | OP_E2, OP_OPF,
];

impl Tok {
	/// The token's `type` entry.
	const fn kind(self) -> u16 {
		let i = self as usize;
		if i < TYPE.len() { TYPE[i] } else { 0 }
	}

	/// zsh `MTYPE`: the associativity bits.
	const fn assoc(self) -> u16 {
		self.kind() & 3
	}
}

/// A slice of an [`Expr`]'s text: a variable reference or function call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
	start: usize,
	end:   usize,
}

/// One step of a compiled expression: what zsh's `mathparse` does at that
/// point of the parse.
#[derive(Debug)]
enum Ins {
	/// `NUM`: push a constant.
	Num(Number),
	/// `NUM` for `$`: push the shell's pid.
	Pid,
	/// `NUM` for `?` in operand position: push `$?`.
	Status,
	/// `NUM` for a `#` not followed by a name: push `$#`.
	Argc,
	/// `ID`: push a variable, read when an operator needs its value (not
	/// at all under `noeval`).
	Id(Span),
	/// `CID` (`#name`): push the code of the variable's first character.
	Cid(Span),
	/// `FUNC`: push the result of calling the function.
	Func(Span),
	/// `[#N_M]`: the lexer setting the output base and grouping.
	Format { radix: Option<i32>, underscore: Option<i32> },
	/// A lexer warning (`number truncated`).
	Warn(Box<Warning>),
	/// Apply an operator (`op`).
	Op(Tok),
	/// Before the right operand of `&&`, `||`, `&&=`, `||=`: save `noeval`
	/// and skip the operand when the left one decides (`bop`).
	Bop(Tok),
	/// After that operand: restore `noeval` and apply the operator.
	BopEnd(Tok),
	/// `?`: test the condition; the true branch is skipped when it fails.
	Quest,
	/// `:`: the false branch is skipped when the condition held.
	Colon,
	/// After the false branch: `op(QUEST)`.
	QuestEnd,
	/// The syntax error where the parse stopped.
	Fail(Box<MathError>),
}

/// A compiled expression.
#[derive(Debug)]
struct Expr {
	/// The text as lexed: zsh removes the `_` of a float constant from its
	/// copy of the text, spans index this copy.
	src:      BString,
	prog:     Box<[Ins]>,
	/// Where the parse stopped, in the original text (zsh's `*ep`).
	end:      usize,
	/// The token the parse stopped at (zsh `mtok`).
	last:     Tok,
	/// zsh `lastbase` after lexing the expression.
	lastbase: i32,
	/// The compile flags it was compiled under.
	flags:    u8,
}

/// What the lexer found for a `NUM`.
#[derive(Clone, Copy, Debug)]
enum Lexed {
	Const(Number),
	Pid,
	Status,
	Argc,
}

/// zsh `IS_DASH`.
const fn is_dash(c: u8) -> bool {
	c == b'-' || c == tok::DASH
}

/// zsh `inblank`: space, tab, newline.
const fn is_inblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n')
}

/// zsh `iident` for a byte (ASCII letters, digits, `_`).
const fn is_ident_byte(c: u8) -> bool {
	c.is_ascii_alphanumeric() || c == b'_'
}

/// What [`zstrtol_underscore`] read.
struct Strtol {
	value:   i64,
	/// Where reading stopped.
	end:     usize,
	/// The truncation warning, when the number overflowed.
	warning: Option<Warning>,
}

/// zsh `zstrtol_underscore`: the integer at `s[i..]` in `base` (0: decimal,
/// `0x` hex, `0b` binary, `0` octal), after blanks and a sign, with `_`
/// skipped when `underscore`. Overflow keeps the digits before the one
/// that overflowed and warns.
fn zstrtol_underscore(
	s: &[u8],
	mut i: usize,
	mut base: i32,
	underscore: bool,
) -> Result<Strtol, MathError> {
	while is_inblank(at(s, i)) {
		i += 1;
	}
	let neg = is_dash(at(s, i));
	if neg || at(s, i) == b'+' {
		i += 1;
	}
	if base == 0 {
		if at(s, i) == b'0' {
			i += 1;
			match at(s, i) {
				b'x' | b'X' => {
					base = 16;
					i += 1;
				},
				b'b' | b'B' => {
					base = 2;
					i += 1;
				},
				_ => base = 8,
			}
		} else {
			base = 10;
		}
	}
	let inp = i;
	if !(2..=36).contains(&base) {
		return Err(MathError::InvalidBase { base });
	}
	let radix = base as u64;
	let mut calc: u64 = 0;
	let mut trunc: Option<usize> = None;
	loop {
		let c = at(s, i);
		let digit = if base <= 10 {
			(c >= b'0' && c < b'0' + base as u8).then(|| c - b'0')
		} else if c.is_ascii_digit() {
			Some(c - b'0')
		} else if (c >= b'a' && c < b'a' + (base - 10) as u8)
			|| (c >= b'A' && c < b'A' + (base - 10) as u8)
		{
			Some((c & 0x1f) + 9)
		} else {
			None
		};
		match digit {
			Some(dig) if trunc.is_none() => {
				let newcalc = calc.wrapping_mul(radix).wrapping_add(u64::from(dig));
				if newcalc < calc {
					trunc = Some(i);
				} else {
					calc = newcalc;
				}
			},
			Some(_) => {},
			None if underscore && c == b'_' => {},
			None => break,
		}
		i += 1;
	}
	// A number just too long for signed notation; the lowest negative
	// number is representable.
	if trunc.is_none() && (calc as i64) < 0 && (!neg || calc & !(1u64 << 63) != 0) {
		trunc = Some(i - 1);
		calc /= radix;
	}
	let warning = trunc.map(|stop| {
		let rest = tail(s, inp);
		let rest = head(rest, rest.iter().position(|&ch| ch == 0).unwrap_or(rest.len()));
		Warning::Truncated { digits: stop - inp, text: Nice::of(rest) }
	});
	let value = if neg {
		(calc as i64).wrapping_neg()
	} else {
		calc as i64
	};
	Ok(Strtol { value, end: i, warning })
}

/// C `strtod` over the decimal float syntax `lexconstant` hands it (it
/// starts at a digit or `.`): the value and the bytes consumed, 0 when
/// there is no number.
fn strtod(s: &[u8]) -> (f64, usize) {
	let mut i = 0;
	let mut digits = false;
	while at(s, i).is_ascii_digit() {
		i += 1;
		digits = true;
	}
	if at(s, i) == b'.' {
		let mut j = i + 1;
		let mut frac = false;
		while at(s, j).is_ascii_digit() {
			j += 1;
			frac = true;
		}
		if digits || frac {
			i = j;
			digits = true;
		}
	}
	if !digits {
		return (0.0, 0);
	}
	if matches!(at(s, i), b'e' | b'E') {
		let mut j = i + 1;
		if matches!(at(s, j), b'+' | b'-') {
			j += 1;
		}
		if at(s, j).is_ascii_digit() {
			while at(s, j).is_ascii_digit() {
				j += 1;
			}
			i = j;
		}
	}
	let value = head(s, i)
		.to_str()
		.ok()
		.and_then(|t| t.parse::<f64>().ok())
		.unwrap_or(0.0);
	(value, i)
}

/// zsh `mb_metacharlenconv`: the length in metafied bytes and the code of
/// the character at `s[i..]`; `None` for a token or an invalid UTF-8
/// sequence (then one character long), length 0 at the end.
fn mb_metacharlenconv(s: &[u8], i: usize, multibyte: bool) -> (usize, Option<u32>) {
	let c = at(s, i);
	if !multibyte || c <= 0x7f {
		return if c == tok::META {
			(2, Some(u32::from(at(s, i + 1) ^ 32)))
		} else {
			(1, Some(u32::from(c)))
		};
	}
	if tok::is_tok(c) {
		return (1, None);
	}
	let mut buf = [0u8; 4];
	let mut len = 0;
	let mut pos = i;
	while at(s, pos) != 0 && len < 4 {
		let inchar = if at(s, pos) == tok::META {
			pos += 1;
			at(s, pos) ^ 32
		} else if tok::is_meta(at(s, pos)) {
			break;
		} else {
			at(s, pos)
		};
		pos += 1;
		buf[len] = inchar;
		len += 1;
		match std::str::from_utf8(head(&buf, len)) {
			Ok(decoded) => return (pos - i, decoded.chars().next().map(u32::from)),
			Err(err) if err.error_len().is_none() => {},
			Err(_) => break,
		}
	}
	if pos > i {
		(1 + usize::from(c == tok::META), None)
	} else {
		(0, None)
	}
}

/// zsh `itype_end(ptr, IIDENT, 0)`: the end of the identifier at `s[i..]`.
/// `wide` (`multibyte` without `posixidentifiers`) admits alphanumeric
/// non-ASCII characters.
fn ident_end(s: &[u8], mut i: usize, wide: bool) -> usize {
	if wide {
		loop {
			let c = at(s, i);
			if c == 0 || tok::is_tok(c) {
				break;
			}
			let (len, wc) = mb_metacharlenconv(s, i, true);
			if len == 0 {
				break;
			}
			let ok = match wc {
				None => {
					let chr = if c == tok::META { at(s, i + 1) ^ 32 } else { c };
					chr <= 127 && is_ident_byte(chr)
				},
				Some(_) if len == 1 && c.is_ascii() => is_ident_byte(c),
				Some(w) => char::from_u32(w).is_some_and(char::is_alphanumeric),
			};
			if !ok {
				break;
			}
			i += len;
		}
	} else {
		loop {
			let c = at(s, i);
			let chr = if c == tok::META { at(s, i + 1) ^ 32 } else { c };
			if !is_ident_byte(chr) {
				break;
			}
			i += if c == tok::META { 2 } else { 1 };
		}
	}
	i
}

/// zsh `getkeystring(s, NULL, GETKEYS_MATH, &v)`: the code of the one
/// character at `s[i..]` after `##` (escapes `\n`, `\e`, `\M-x`, `\C-x`,
/// `^x`, octal `\NNN`, hex `\xNN`, `\uNNNN`, `\UNNNNNNNN`, UTF-8
/// characters) and where lexing continues; `None` when there is none.
fn getkeystring_math(s: &[u8], mut i: usize, multibyte: bool) -> Option<(i64, usize)> {
	let mut meta = 0u8;
	let mut control = false;
	while at(s, i) != 0 {
		let out = if at(s, i) == b'\\' && at(s, i + 1) != 0 {
			i += 1;
			let c = at(s, i);
			match c {
				b'a' => Some(0x07),
				b'n' => Some(b'\n'),
				b'b' => Some(0x08),
				b't' => Some(b'\t'),
				b'v' => Some(0x0b),
				b'f' => Some(0x0c),
				b'r' => Some(b'\r'),
				b'E' | b'e' => Some(0x1b),
				b'M' => {
					if at(s, i + 1) == b'-' {
						i += 1;
					}
					meta = 1 + u8::from(control);
					i += 1;
					continue;
				},
				b'C' => {
					if at(s, i + 1) == b'-' {
						i += 1;
					}
					control = true;
					i += 1;
					continue;
				},
				tok::META => {
					i -= 1;
					Some(b'\\')
				},
				b'u' | b'U' => {
					let mut wval: u32 = 0;
					for _ in 0..if c == b'u' { 4 } else { 8 } {
						i += 1;
						let dig = at(s, i);
						if dig.is_ascii_digit() {
							wval = wval.wrapping_mul(16).wrapping_add(u32::from(dig - b'0'));
						} else if matches!(dig, b'a'..=b'f' | b'A'..=b'F') {
							wval = wval
								.wrapping_mul(16)
								.wrapping_add(u32::from(dig & 0x1f) + 9);
						} else {
							i -= 1;
							break;
						}
					}
					return Some((i64::from(wval as i32), i + 1));
				},
				_ if (c.is_ascii_digit() && c < b'8') || c == b'x' => {
					// At most three characters, the `x` included.
					let nul = tail(s, i)
						.iter()
						.position(|&ch| ch == 0)
						.map_or(s.len(), |off| i + off);
					let limit = (i + 3).min(nul);
					let hex = c == b'x';
					let num = zstrtol_underscore(
						head(s, limit),
						i + usize::from(hex),
						if hex { 16 } else { 8 },
						false,
					)
					.ok()?;
					i = num.end - 1;
					Some(num.value as u8)
				},
				_ => Some(c),
			}
		} else if at(s, i) == b'^' && !control && at(s, i + 1) != 0 {
			control = true;
			i += 1;
			continue;
		} else if multibyte && at(s, i) > 127 {
			let (len, wc) = mb_metacharlenconv(s, i, true);
			if let Some(code) = wc {
				return Some((i64::from(code as i32), i + len));
			}
			None
		} else if at(s, i) == tok::META {
			i += 1;
			Some(at(s, i) ^ 32)
		} else {
			let c = at(s, i);
			Some(if tok::is_tok(c) && (meta != 0 || control) {
				tok::tok_char(c).unwrap_or(0)
			} else {
				c
			})
		};
		let Some(mut byte) = out else {
			// An undecodable byte: dropped, with the modifiers.
			meta = 0;
			control = false;
			i += 1;
			continue;
		};
		if meta == 2 {
			byte |= 0x80;
			meta = 0;
		}
		if control {
			byte = if byte == b'?' { 0x7f } else { byte & 0x9f };
		}
		if meta != 0 {
			byte |= 0x80;
		}
		return Some((i64::from(byte), i + 1));
	}
	None
}

/// Compile `text` under `flags`: zsh's `mathevall` parse half.
fn compile(text: &[u8], flags: u8) -> Expr {
	let mut c = Compiler {
		src: text.to_vec(),
		before_chuck: None,
		removed: 0,
		ptr: 0,
		unary: true,
		prec: if flags & F_CPREC != 0 {
			&C_PREC
		} else {
			&Z_PREC
		},
		mtok: Tok::Eoi,
		yyval: Lexed::Const(Number::Int(0)),
		yylval: Span { start: 0, end: 0 },
		lastbase: -1,
		prog: Vec::new(),
		failed: false,
		flags,
		depth: 0,
	};
	let pc = if flags & F_ARG != 0 {
		c.arg_prec()
	} else {
		c.top_prec()
	};
	c.mathparse(pc);
	// Parentheses are parsed at top precedence, so a surplus `)` ends up
	// here.
	if c.mtok == Tok::OutPar {
		c.fail(MathError::UnexpectedParen);
	}
	Expr {
		end:      c.ptr + c.removed,
		last:     c.mtok,
		lastbase: c.lastbase,
		flags:    c.flags,
		prog:     c.prog.into_boxed_slice(),
		src:      BString::from(c.src),
	}
}

/// zsh's lexer and parser state (`ptr`, `unary`, `prec`, `mtok`, `yyval`,
/// `yylval`, `lastbase`, `errflag`), recording the parse as a program.
struct Compiler {
	src:          Vec<u8>,
	/// The text before a float constant's `_` were removed, while the
	/// token after the removal is checked: zsh's `checkunary` shows the
	/// text from its pointer into the original string.
	before_chuck: Option<Vec<u8>>,
	/// `_` removed from `src` so far.
	removed:      usize,
	ptr:          usize,
	unary:        bool,
	prec:         &'static [u8; TOKCOUNT],
	mtok:         Tok,
	yyval:        Lexed,
	yylval:       Span,
	lastbase:     i32,
	prog:         Vec<Ins>,
	/// zsh `errflag`: a syntax error was recorded, the parse unwinds.
	failed:       bool,
	flags:        u8,
	depth:        u32,
}

impl Compiler {
	fn at(&self, i: usize) -> u8 {
		at(&self.src, i)
	}

	const fn prec_of(&self, t: Tok) -> u8 {
		let i = t as usize;
		if i < self.prec.len() { self.prec[i] } else { 0 }
	}

	/// zsh `TOPPREC`.
	const fn top_prec(&self) -> u8 {
		self.prec_of(Tok::Comma) + 1
	}

	/// zsh `ARGPREC`.
	const fn arg_prec(&self) -> u8 {
		self.prec_of(Tok::Comma) - 1
	}

	const fn flag(&self, f: u8) -> bool {
		self.flags & f != 0
	}

	/// Record `ins` (nothing after an error: zsh stops evaluating there).
	fn emit(&mut self, ins: Ins) {
		if !self.failed {
			self.prog.push(ins);
		}
	}

	/// zsh `zerr` during the parse: the first one is the error.
	fn fail(&mut self, e: MathError) {
		if !self.failed {
			self.prog.push(Ins::Fail(Box::new(e)));
			self.failed = true;
		}
	}

	/// `zstrtol_underscore` at `start`, its warning recorded; `None` after
	/// recording an invalid base.
	fn strtol(&mut self, start: usize, base: i32, underscore: bool) -> Option<Strtol> {
		match zstrtol_underscore(&self.src, start, base, underscore) {
			Ok(mut r) => {
				if let Some(w) = r.warning.take() {
					self.emit(Ins::Warn(Box::new(w)));
				}
				Some(r)
			},
			Err(e) => {
				self.fail(e);
				None
			},
		}
	}

	/// An integer constant, a float under `forcefloat`.
	const fn int_const(&mut self, v: i64) {
		self.yyval = Lexed::Const(if self.flag(F_FORCE) {
			Number::Float(v as f64)
		} else {
			Number::Int(v)
		});
	}

	/// zsh `mathparse`: parse operators of precedence `pc` and tighter,
	/// recording their evaluation.
	fn mathparse(&mut self, pc: u8) {
		if self.failed {
			return;
		}
		if self.depth >= MAX_PARSE_DEPTH {
			let expr = Nice::of(&self.src);
			self.fail(MathError::RecursionLimit { expr });
			return;
		}
		self.depth += 1;
		self.parse_level(pc);
		self.depth -= 1;
	}

	/// The body of zsh's `mathparse`.
	fn parse_level(&mut self, pc: u8) {
		let mut optr = self.ptr;
		self.mtok = self.zzlex();
		// Empty input.
		if pc == self.top_prec() && self.mtok == Tok::Eoi {
			return;
		}
		self.checkunary(self.mtok, optr);
		while self.prec_of(self.mtok) <= pc {
			if self.failed {
				return;
			}
			match self.mtok {
				Tok::Num => {
					let ins = match self.yyval {
						Lexed::Const(n) => Ins::Num(n),
						Lexed::Pid => Ins::Pid,
						Lexed::Status => Ins::Status,
						Lexed::Argc => Ins::Argc,
					};
					self.emit(ins);
				},
				Tok::Id => self.emit(Ins::Id(self.yylval)),
				Tok::Cid => self.emit(Ins::Cid(self.yylval)),
				Tok::Func => self.emit(Ins::Func(self.yylval)),
				Tok::InPar => {
					self.mathparse(self.top_prec());
					if self.mtok != Tok::OutPar {
						self.fail(MathError::ParenExpected);
						return;
					}
				},
				Tok::Quest => {
					self.emit(Ins::Quest);
					self.mathparse(self.prec_of(Tok::Colon) - 1);
					if self.mtok != Tok::Colon {
						self.fail(MathError::ColonExpected);
						return;
					}
					self.emit(Ins::Colon);
					self.mathparse(self.prec_of(Tok::Quest));
					self.emit(Ins::QuestEnd);
					continue;
				},
				otok => {
					// noeval is balanced inside the right operand: only the
					// short-circuiting operators need it saved.
					let boolean = otok.assoc() == BOOL;
					if boolean {
						self.emit(Ins::Bop(otok));
					}
					self.mathparse(self.prec_of(otok) - u8::from(otok.assoc() != RL));
					self.emit(if boolean {
						Ins::BopEnd(otok)
					} else {
						Ins::Op(otok)
					});
					continue;
				},
			}
			optr = self.ptr;
			self.mtok = self.zzlex();
			self.checkunary(self.mtok, optr);
		}
	}

	/// zsh `checkunary`: an operand where an operator belongs or vice
	/// versa is an error; unary operators are part of an operand.
	fn checkunary(&mut self, t: Tok, mptr: usize) {
		let tp = t.kind();
		let what = if tp & (OP_BINARY | OP_OP) != 0 {
			self.unary.then_some(Expected::Operand)
		} else {
			(!self.unary).then_some(Expected::Operator)
		};
		let shown = self.before_chuck.take();
		if let Some(what) = what {
			let src = shown.as_deref().unwrap_or(&self.src);
			let mut p = mptr;
			while is_inblank(at(src, p)) {
				p += 1;
			}
			if at(src, p) == 0 {
				self.fail(MathError::ExpectedAtEnd { what });
			} else {
				let at = Snippet::of(tail(src, p));
				self.fail(MathError::Expected { what, at });
			}
		}
		self.unary = tp & OP_OPF == 0;
	}

	/// `c`, `c=`, `cc` or `cc=` after a `c` (`&`, `|`, `^`, `*`, `<`, `>`).
	fn lex_double(&mut self, c: u8, double: Tok, double_eq: Tok, eq: Tok, single: Tok) -> Tok {
		if self.at(self.ptr) == c {
			self.ptr += 1;
			if self.at(self.ptr) == b'=' {
				self.ptr += 1;
				return double_eq;
			}
			return double;
		}
		if self.at(self.ptr) == b'=' {
			self.ptr += 1;
			return eq;
		}
		single
	}

	/// `t_eq` when `=` follows, else `t`.
	fn lex_eq(&mut self, t_eq: Tok, t: Tok) -> Tok {
		if self.at(self.ptr) == b'=' {
			self.ptr += 1;
			return t_eq;
		}
		t
	}

	/// zsh `zzlex`: the next token.
	fn zzlex(&mut self) -> Tok {
		self.yyval = Lexed::Const(Number::Int(0));
		loop {
			let c = self.at(self.ptr);
			self.ptr += 1;
			match c {
				b'+' => {
					if self.at(self.ptr) == b'+' {
						self.ptr += 1;
						return if self.unary {
							Tok::PrePlus
						} else {
							Tok::PostPlus
						};
					}
					if self.at(self.ptr) == b'=' {
						self.ptr += 1;
						return Tok::PlusEq;
					}
					return if self.unary { Tok::UPlus } else { Tok::Plus };
				},
				b'-' | tok::DASH => {
					if is_dash(self.at(self.ptr)) {
						self.ptr += 1;
						return if self.unary {
							Tok::PreMinus
						} else {
							Tok::PostMinus
						};
					}
					if self.at(self.ptr) == b'=' {
						self.ptr += 1;
						return Tok::MinusEq;
					}
					if !self.unary {
						return Tok::Minus;
					}
					let next = self.at(self.ptr);
					if !next.is_ascii_digit() && next != b'.' {
						return Tok::UMinus;
					}
					let t = self.lexconstant();
					if t == Tok::Num
						&& let Lexed::Const(n) = self.yyval
					{
						self.yyval = Lexed::Const(match n {
							Number::Int(v) => Number::Int(v.wrapping_neg()),
							Number::Float(d) => Number::Float(-d),
						});
					}
					return t;
				},
				b'(' => return Tok::InPar,
				b')' => return Tok::OutPar,
				b'!' => return self.lex_eq(Tok::Neq, Tok::Not),
				b'~' => return Tok::Comp,
				b'&' => return self.lex_double(b'&', Tok::DAnd, Tok::DAndEq, Tok::AndEq, Tok::And),
				b'|' => return self.lex_double(b'|', Tok::DOr, Tok::DOrEq, Tok::OrEq, Tok::Or),
				b'^' => return self.lex_double(b'^', Tok::DXor, Tok::DXorEq, Tok::XorEq, Tok::Xor),
				b'*' => {
					return self.lex_double(b'*', Tok::Power, Tok::PowerEq, Tok::MulEq, Tok::Mul);
				},
				b'/' => return self.lex_eq(Tok::DivEq, Tok::Div),
				b'%' => return self.lex_eq(Tok::ModEq, Tok::Mod),
				b'<' => {
					return self.lex_double(b'<', Tok::ShLeft, Tok::ShLeftEq, Tok::Leq, Tok::Les);
				},
				b'>' => {
					return self.lex_double(b'>', Tok::ShRight, Tok::ShRightEq, Tok::Geq, Tok::Gre);
				},
				b'=' => return self.lex_eq(Tok::Deq, Tok::Eq),
				b'$' => {
					self.yyval = Lexed::Pid;
					return Tok::Num;
				},
				b'?' => {
					if self.unary {
						self.yyval = Lexed::Status;
						return Tok::Num;
					}
					return Tok::Quest;
				},
				b':' => return Tok::Colon,
				b',' => return Tok::Comma,
				0 => {
					self.ptr -= 1;
					return Tok::Eoi;
				},
				b'[' => {
					if let Some(t) = self.lex_bracket() {
						return t;
					}
				},
				// POSIX says ignore double quotes.
				b' ' | b'\t' | b'\n' | b'"' | tok::DNULL => {},
				_ => return self.lex_word(),
			}
		}
	}

	/// zsh `zzlex`'s `[`: an input base `[16]ff` (a `NUM`), or an output
	/// format `[#16]`, `[##16]`, `[#16_4]`, `[#_]` (`None`: lexing goes on).
	fn lex_bracket(&mut self) -> Option<Tok> {
		if self.at(self.ptr).is_ascii_digit() {
			let n = self.strtol(self.ptr, 10, false)?;
			self.ptr = n.end;
			if self.at(self.ptr) != b']' {
				self.fail(MathError::BadBaseSyntax);
				return Some(Tok::Eoi);
			}
			self.ptr += 1;
			if !self.at(self.ptr).is_ascii_digit() {
				self.fail(MathError::BadBaseSyntax);
				return Some(Tok::Eoi);
			}
			let base = n.value as i32;
			self.lastbase = base;
			let Some(v) = self.strtol(self.ptr, base, false) else {
				return Some(Tok::Eoi);
			};
			self.ptr = v.end;
			self.yyval = Lexed::Const(Number::Int(v.value));
			return Some(Tok::Num);
		}
		let mut radix = None;
		let mut underscore = None;
		let ok = 'spec: {
			if self.at(self.ptr) != b'#' {
				break 'spec false;
			}
			let mut n: i64 = 1;
			self.ptr += 1;
			if self.at(self.ptr) == b'#' {
				n = -1;
				self.ptr += 1;
			}
			let c = self.at(self.ptr);
			if !c.is_ascii_digit() && c != b'_' {
				break 'spec false;
			}
			if c.is_ascii_digit() {
				let Some(r) = self.strtol(self.ptr, 10, false) else {
					return Some(Tok::Eoi);
				};
				self.ptr = r.end;
				radix = Some(n.wrapping_mul(r.value) as i32);
			}
			if self.at(self.ptr) == b'_' {
				self.ptr += 1;
				if self.at(self.ptr).is_ascii_digit() {
					let Some(r) = self.strtol(self.ptr, 10, false) else {
						return Some(Tok::Eoi);
					};
					self.ptr = r.end;
					underscore = Some(r.value as i32);
				} else {
					underscore = Some(3);
				}
			}
			self.at(self.ptr) == b']'
		};
		if !ok {
			self.fail(MathError::BadOutputFormat);
			return Some(Tok::Eoi);
		}
		if let Some(r) = radix
			&& !(2..=36).contains(&r.unsigned_abs())
		{
			self.fail(MathError::InvalidBase { base: r });
			return Some(Tok::Eoi);
		}
		self.ptr += 1;
		self.emit(Ins::Format { radix, underscore });
		None
	}

	/// zsh `zzlex`'s default case: a constant, `##x` / `#\x`, `#name`, a
	/// lone `#`, `NaN`/`Inf`, a variable with its subscript, or a function
	/// call; `EOI` (lexing stopped) for anything else.
	fn lex_word(&mut self) -> Tok {
		self.ptr -= 1;
		let c = self.at(self.ptr);
		if c.is_ascii_digit() || c == b'.' {
			return self.lexconstant();
		}
		let cct = c == b'#';
		if cct {
			self.ptr += 1;
			let d = self.at(self.ptr);
			if d == b'\\' || d == b'#' {
				let optr = self.ptr;
				self.ptr += 1;
				if self.at(self.ptr) == 0 {
					self.fail(MathError::CharacterMissing);
					return Tok::Eoi;
				}
				let Some((v, next)) = getkeystring_math(&self.src, self.ptr, self.flag(F_MULTIBYTE))
				else {
					self.fail(MathError::BadCharacter);
					self.ptr = optr;
					return Tok::Eoi;
				};
				self.ptr = next;
				self.yyval = Lexed::Const(Number::Int(v));
				return Tok::Num;
			}
		}
		let wide = self.flag(F_MULTIBYTE) && !self.flag(F_POSIXID);
		let ie = ident_end(&self.src, self.ptr, wide);
		if ie == self.ptr {
			if cct {
				self.yyval = Lexed::Argc;
				return Tok::Num;
			}
			return Tok::Eoi;
		}
		let p = self.ptr;
		self.ptr = ie;
		if ie - p == 3 && !self.flag(F_SH) {
			let word = tok::span(&self.src, p, ie);
			if word.eq_ignore_ascii_case(b"nan") {
				self.yyval = Lexed::Const(Number::Float(f64::NAN));
				return Tok::Num;
			}
			if word.eq_ignore_ascii_case(b"inf") {
				self.yyval = Lexed::Const(Number::Float(f64::INFINITY));
				return Tok::Num;
			}
		}
		let open = self.at(self.ptr);
		let mut func = false;
		if open == b'[' || (!cct && open == b'(') {
			let close = if open == b'[' { b']' } else { b')' };
			func = open == b'(';
			self.ptr += 1;
			let mut l = 1;
			while self.at(self.ptr) != 0 && l > 0 {
				let ch = self.at(self.ptr);
				if ch == open {
					l += 1;
				}
				if ch == close {
					l -= 1;
				}
				if ch == b'\\' && self.at(self.ptr + 1) != 0 {
					self.ptr += 1;
				}
				self.ptr += 1;
			}
		}
		self.yylval = Span { start: p, end: self.ptr };
		if func {
			Tok::Func
		} else if cct {
			Tok::Cid
		} else {
			Tok::Id
		}
	}

	/// zsh `lexconstant`: an integer (`12`, `0x1f`, `0b101`, `16#ff`,
	/// octal `017` under `octalzeroes`, `_` anywhere among the digits) or a
	/// float (`1.5`, `.5`, `1.`, `1e3`).
	fn lexconstant(&mut self) -> Tok {
		let mut nptr = self.ptr;
		if is_dash(self.at(nptr)) {
			nptr += 1;
		}
		if self.at(nptr) == b'0' {
			nptr += 1;
			let low = self.at(nptr).to_ascii_lowercase();
			if low == b'x' || low == b'b' {
				let Some(r) = self.strtol(self.ptr, 0, true) else {
					return Tok::Eoi;
				};
				self.ptr = r.end;
				self.lastbase = if low == b'b' { 2 } else { 16 };
				self.int_const(r.value);
				return Tok::Num;
			}
			if self.flag(F_OCTAL) {
				// A real octal constant: not a base (`08#77`, always
				// decimal) nor a float.
				let mut p2 = nptr;
				while self.at(p2).is_ascii_digit() || self.at(p2) == b'_' {
					p2 += 1;
				}
				if p2 > nptr && !matches!(self.at(p2), b'.' | b'e' | b'E' | b'#') {
					let Some(r) = self.strtol(self.ptr, 0, true) else {
						return Tok::Eoi;
					};
					self.ptr = r.end;
					self.lastbase = 8;
					self.int_const(r.value);
					return Tok::Num;
				}
				nptr = p2;
			}
		}
		while self.at(nptr).is_ascii_digit() || self.at(nptr) == b'_' {
			nptr += 1;
		}
		if matches!(self.at(nptr), b'.' | b'e' | b'E') {
			if self.at(nptr) == b'.' {
				nptr += 1;
				while self.at(nptr).is_ascii_digit() || self.at(nptr) == b'_' {
					nptr += 1;
				}
			}
			if matches!(self.at(nptr), b'e' | b'E') {
				nptr += 1;
				if self.at(nptr) == b'+' || is_dash(self.at(nptr)) {
					nptr += 1;
				}
				while self.at(nptr).is_ascii_digit() || self.at(nptr) == b'_' {
					nptr += 1;
				}
			}
			if tok::span(&self.src, self.ptr, nptr).contains(&b'_') {
				self.chuck_underscores(nptr);
			}
			let (value, len) = strtod(tail(&self.src, self.ptr));
			let np = self.ptr + len;
			if len == 0 || self.at(np) == b'.' {
				self.fail(MathError::BadFloat);
				return Tok::Eoi;
			}
			self.ptr = np;
			self.yyval = Lexed::Const(Number::Float(value));
			return Tok::Num;
		}
		let Some(r) = self.strtol(self.ptr, 10, true) else {
			return Tok::Eoi;
		};
		self.ptr = r.end;
		let mut v = r.value;
		if self.at(self.ptr) == b'#' {
			self.ptr += 1;
			let base = v as i32;
			self.lastbase = base;
			let Some(r) = self.strtol(self.ptr, base, true) else {
				return Tok::Eoi;
			};
			self.ptr = r.end;
			v = r.value;
		}
		self.int_const(v);
		Tok::Num
	}

	/// `lexconstant`'s `chuck` loop: remove the `_` of the float constant
	/// at `ptr..end` from the text, which lexing continues in.
	fn chuck_underscores(&mut self, end: usize) {
		self.before_chuck = Some(self.src.clone());
		let end = end.min(self.src.len());
		let start = self.ptr.min(end);
		let mut w = start;
		for r in start..end {
			let c = at(&self.src, r);
			if c != b'_' {
				if let Some(d) = self.src.get_mut(w) {
					*d = c;
				}
				w += 1;
			}
		}
		self.src.drain(w..end);
		self.removed += end - w;
	}
}

/// One value-stack slot (zsh `struct mathvalue`).
struct Entry<S> {
	/// `None` is `MN_UNSET`: a variable not read yet.
	val:  Option<Number>,
	/// The variable it came from (`lval`): assignable.
	lval: Option<Span>,
	/// The resolved variable (`pval`), once read.
	pval: Option<S>,
}

/// zsh `notzero`: an integer zero divisor is an error.
const fn notzero(n: Number) -> Result<(), MathError> {
	if matches!(n, Number::Int(0)) {
		Err(MathError::DivisionByZero)
	} else {
		Ok(())
	}
}

/// Integer `**` (zsh's repeated multiplication, by squaring: the same
/// wrapped result for any exponent).
const fn ipow(mut base: i64, mut exp: i64) -> i64 {
	let mut acc: i64 = 1;
	while exp > 0 {
		if exp & 1 == 1 {
			acc = acc.wrapping_mul(base);
		}
		exp >>= 1;
		if exp > 0 {
			base = base.wrapping_mul(base);
		}
	}
	acc
}

/// The arithmetic of zsh `op` for binary operator `what` (operands already
/// coerced; `lhs` is `None` only for `=` to a variable not read).
fn binary(what: Tok, lhs: Option<Number>, rhs: Number) -> Result<Number, MathError> {
	use Number::{Float as F, Int as I};
	let Some(lhs) = lhs else { return Ok(rhs) };
	let fl = lhs.is_float();
	let (x, y) = (lhs.to_int(), rhs.to_int());
	let (p, q) = (lhs.to_float(), rhs.to_float());
	let cmp = |by_float: bool, by_int: bool| I(i64::from(if fl { by_float } else { by_int }));
	Ok(match what {
		Tok::And | Tok::AndEq => I(x & y),
		Tok::Xor | Tok::XorEq => I(x ^ y),
		Tok::Or | Tok::OrEq => I(x | y),
		Tok::Mul | Tok::MulEq => {
			if fl {
				F(p * q)
			} else {
				I(x.wrapping_mul(y))
			}
		},
		Tok::Div | Tok::DivEq => {
			notzero(rhs)?;
			if fl {
				F(p / q)
			} else if y == -1 {
				// MIN / -1 does not trap: it is treated as a negation.
				I(x.wrapping_neg())
			} else {
				I(x / y)
			}
		},
		Tok::Mod | Tok::ModEq => {
			notzero(rhs)?;
			if fl {
				// Pure-Rust `fmod` (exact, like C's): `%` on floats would
				// link libm.so into every shell.
				F(libm::fmod(p, q))
			} else if y == -1 {
				I(0)
			} else {
				I(x % y)
			}
		},
		Tok::Plus | Tok::PlusEq => {
			if fl {
				F(p + q)
			} else {
				I(x.wrapping_add(y))
			}
		},
		Tok::Minus | Tok::MinusEq => {
			if fl {
				F(p - q)
			} else {
				I(x.wrapping_sub(y))
			}
		},
		Tok::ShLeft | Tok::ShLeftEq => I(x.wrapping_shl(y as u32)),
		Tok::ShRight | Tok::ShRightEq => I(x.wrapping_shr(y as u32)),
		Tok::Les => cmp(p < q, x < y),
		Tok::Leq => cmp(p <= q, x <= y),
		Tok::Gre => cmp(p > q, x > y),
		Tok::Geq => cmp(p >= q, x >= y),
		Tok::Deq => cmp(p == q, x == y),
		Tok::Neq => cmp(p != q, x != y),
		Tok::DAnd | Tok::DAndEq => I(i64::from(x != 0 && y != 0)),
		Tok::DOr | Tok::DOrEq => I(i64::from(x != 0 || y != 0)),
		Tok::DXor | Tok::DXorEq => I(i64::from((x != 0) != (y != 0))),
		Tok::Comma | Tok::Eq => rhs,
		Tok::Power | Tok::PowerEq => {
			if !fl && y >= 0 {
				I(ipow(x, y))
			} else {
				// A negative integer exponent gives a real result.
				if q <= 0.0 {
					notzero(lhs.float())?;
				}
				if p < 0.0 && (q as i64) as f64 != q {
					return Err(MathError::ImaginaryPower);
				}
				F(libm::pow(p, q))
			}
		},
		_ => return Err(MathError::OutOfIntegers),
	})
}

/// zsh `mathevall`: evaluate `text` (metafied) at top or argument
/// precedence, one nesting level deeper; the value, where the parse
/// stopped and the token it stopped at. `noeval` is inherited, as zsh's
/// global is.
fn mathevall<E: Env + ?Sized>(
	env: &mut E,
	text: &[u8],
	arg: bool,
	noeval: u32,
) -> Result<(Number, usize, Tok), E::Error> {
	let st = env.state();
	if st.mlevel >= MAX_MLEVEL {
		return Err(MathError::RecursionLimit { expr: Nice::of(text) }.into());
	}
	st.mlevel += 1;
	let saved_lastbase = st.lastbase;
	let opts = env.options();
	let expr = env.cache().get(text, opts.flags(arg));
	let r = Walk {
		env: &mut *env,
		expr: &expr,
		opts,
		noeval,
		stack: Vec::new(),
		saved: Vec::new(),
		quest: Vec::new(),
	}
	.run();
	let st = env.state();
	st.mlevel -= 1;
	st.lastbase = if st.mlevel > 0 {
		saved_lastbase
	} else {
		expr.lastbase
	};
	if let Ok(n) = &r {
		st.last = Some(*n);
	}
	r.map(|n| (n, expr.end, expr.last))
}

/// zsh `matheval` at the inherited `noeval`.
fn matheval_noeval<E: Env + ?Sized>(
	env: &mut E,
	text: &[u8],
	noeval: u32,
) -> Result<Number, E::Error> {
	let st = env.state();
	if st.mlevel == 0 {
		// The output format is kept across nested evaluations only.
		st.output_radix = 0;
		st.output_underscore = 0;
	}
	let s = text.strip_prefix(&[tok::NULARG]).unwrap_or(text);
	if at(s, 0) == 0 {
		return Ok(Number::Int(0));
	}
	let (x, end, _) = mathevall(env, s, false, noeval)?;
	if at(s, end) != 0 {
		return Err(MathError::IllegalCharacter { c: Nice::of(tok::span(s, end, end + 1)) }.into());
	}
	Ok(x)
}

/// zsh `matheval`: evaluate expression `text`.
///
/// `text` is metafied, possibly tokenized, after the caller's expansion;
/// for `$(( ))`, `(( ))`, `let`, numeric assignments and every other
/// arithmetic context. An empty text is 0; a top-level evaluation resets
/// the output format in [`MathState`], which [`format_number`] then
/// applies to the result.
pub fn matheval<E: Env + ?Sized>(env: &mut E, text: &[u8]) -> Result<Number, E::Error> {
	matheval_noeval(env, text, 0)
}

/// zsh `mathevali`: [`matheval`] as an integer (floats truncated), for
/// integer contexts (`typeset -i` assignments, `shift N`, `repeat N`).
pub fn mathevali<E: Env + ?Sized>(env: &mut E, text: &[u8]) -> Result<i64, E::Error> {
	matheval(env, text).map(Number::to_int)
}

/// zsh `mathevalarg`: evaluate the subscript expression at the start of
/// `text`.
///
/// The expression ends at a `,` or a character that cannot continue it
/// (`]`); for the parameter code's subscripts (`a[i]`, `a[i,j]`). Returns
/// the integer value and the offset where the expression ended (at the
/// `,` when one ended it). An empty text is an error.
pub fn mathevalarg<E: Env + ?Sized>(env: &mut E, text: &[u8]) -> Result<(i64, usize), E::Error> {
	let skip = usize::from(text.first() == Some(&tok::NULARG));
	let s = tail(text, skip);
	if at(s, 0) == 0 {
		return Err(MathError::EmptyString.into());
	}
	let (x, end, last) = mathevall(env, s, true, 0)?;
	let end = if last == Tok::Comma { end - 1 } else { end };
	Ok((x.to_int(), skip + end))
}

/// The evaluation half of zsh's `mathevall`: replays a compiled program
/// against the value stack (`push`, `pop`, `op`, `bop`, `noeval`).
struct Walk<'w, E: Env + ?Sized> {
	env:    &'w mut E,
	expr:   &'w Expr,
	opts:   Options,
	noeval: u32,
	stack:  Vec<Entry<E::Slot>>,
	/// `noeval` saved by each pending [`Ins::Bop`].
	saved:  Vec<u32>,
	/// The condition of each pending `?:`.
	quest:  Vec<bool>,
}

impl<E: Env + ?Sized> Walk<'_, E> {
	/// Run the program; the value left at the bottom of the stack (zsh
	/// `stack[0]`), read if it is a variable.
	fn run(&mut self) -> Result<Number, E::Error> {
		let expr = self.expr;
		for ins in &expr.prog {
			self.step(ins)?;
		}
		if self.stack.is_empty() {
			return Ok(Number::Int(0));
		}
		let mut bottom = self.stack.swap_remove(0);
		self.value(&mut bottom)
	}

	fn step(&mut self, ins: &Ins) -> Result<(), E::Error> {
		match ins {
			&Ins::Num(n) => self.push(n, None),
			Ins::Pid => {
				let v = self.env.pid();
				self.push(Number::Int(v), None)
			},
			Ins::Status => {
				let v = self.env.last_status();
				self.push(Number::Int(v), None)
			},
			Ins::Argc => {
				let v = self.env.argc();
				self.push(Number::Int(v), None)
			},
			&Ins::Id(span) => {
				if self.noeval == 0 {
					self.push_entry(Entry { val: None, lval: Some(span), pval: None })
				} else {
					self.push(Number::Int(0), Some(span))
				}
			},
			&Ins::Cid(span) => {
				let v = if self.noeval == 0 {
					self.getcvar(span)
				} else {
					Number::Int(0)
				};
				self.push(v, Some(span))
			},
			&Ins::Func(span) => {
				let v = if self.noeval == 0 {
					self.callmathfunc(span)?
				} else {
					Number::Int(0)
				};
				self.push(v, Some(span))
			},
			&Ins::Format { radix, underscore } => {
				let st = self.env.state();
				if let Some(r) = radix {
					st.output_radix = r;
				}
				if let Some(u) = underscore {
					st.output_underscore = u;
				}
				Ok(())
			},
			Ins::Warn(w) => {
				self.env.warn((**w).clone());
				Ok(())
			},
			&Ins::Op(t) => self.op(t),
			&Ins::Bop(t) => {
				self.saved.push(self.noeval);
				self.bop(t)
			},
			&Ins::BopEnd(t) => {
				if let Some(n) = self.saved.pop() {
					self.noeval = n;
				}
				self.op(t)
			},
			Ins::Quest => {
				let q = self.top_value()?.truth();
				if !q {
					self.noeval += 1;
				}
				self.quest.push(q);
				Ok(())
			},
			Ins::Colon => {
				if self.quest.last().copied().unwrap_or(true) {
					self.noeval += 1;
				} else {
					self.noeval = self.noeval.saturating_sub(1);
				}
				Ok(())
			},
			Ins::QuestEnd => {
				if self.quest.pop().unwrap_or(false) {
					self.noeval = self.noeval.saturating_sub(1);
				}
				self.op(Tok::Quest)
			},
			Ins::Fail(e) => Err((**e).clone().into()),
		}
	}

	/// zsh `push` of a value.
	fn push(&mut self, val: Number, lval: Option<Span>) -> Result<(), E::Error> {
		self.push_entry(Entry { val: Some(val), lval, pval: None })
	}

	/// zsh `push`: at most [`STACKSZ`] pending operands.
	fn push_entry(&mut self, e: Entry<E::Slot>) -> Result<(), E::Error> {
		if self.stack.len() >= STACKSZ {
			return Err(MathError::StackOverflow.into());
		}
		self.stack.push(e);
		Ok(())
	}

	/// zsh `pop`: the top entry, its variable read unless `noget`.
	fn pop(&mut self, noget: bool) -> Result<Entry<E::Slot>, E::Error> {
		let mut e = self.stack.pop().ok_or(MathError::StackEmpty)?;
		if !noget {
			self.value(&mut e)?;
		}
		Ok(e)
	}

	/// The value of the top entry, its variable read if needed.
	fn top_value(&mut self) -> Result<Number, E::Error> {
		let mut e = self.stack.pop().ok_or(MathError::StackEmpty)?;
		let v = self.value(&mut e);
		self.stack.push(e);
		v
	}

	/// The value of `e`, read from its variable (and kept) when unset.
	fn value(&mut self, e: &mut Entry<E::Slot>) -> Result<Number, E::Error> {
		if let Some(v) = e.val {
			return Ok(v);
		}
		let v = self.getmathparam(e)?;
		e.val = Some(v);
		Ok(v)
	}

	/// zsh `getmathparam`: read the variable of `e`, keeping what it
	/// resolved to; a text value is evaluated as an expression.
	fn getmathparam(&mut self, e: &mut Entry<E::Slot>) -> Result<Number, E::Error> {
		let expr = self.expr;
		let span = e.lval.unwrap_or(Span { start: 0, end: 0 });
		let lval = tok::span(&expr.src, span.start, span.end);
		let n = match self.env.get(lval)? {
			None => {
				if !self.opts.unset {
					return Err(MathError::NotSet { name: Nice::of(lval) }.into());
				}
				return Ok(if self.opts.force_float {
					Number::Float(0.0)
				} else {
					Number::Int(0)
				});
			},
			Some((param, slot)) => {
				e.pval = Some(slot);
				match param {
					Param::Int(v) => Number::Int(v),
					Param::Float(d) => Number::Float(d),
					Param::Text(t) => {
						let text: Cow<'_, [u8]> = if t.iter().any(|&c| tok::is_meta(c)) {
							Cow::Owned(tok::metafy(&t))
						} else {
							Cow::Borrowed(t.as_slice())
						};
						matheval_noeval(&mut *self.env, &text, self.noeval)?
					},
				}
			},
		};
		Ok(match n {
			Number::Int(v) if self.opts.force_float => Number::Float(v as f64),
			n => n,
		})
	}

	/// zsh `setmathvar`: assign `v` to the variable of `e` and return the
	/// value the assignment gives (converted to the variable's type when
	/// assigned by name).
	fn setmathvar(&mut self, e: &mut Entry<E::Slot>, v: Number) -> Result<Number, E::Error> {
		if let Some(slot) = &e.pval {
			if self.noeval > 0 {
				return Ok(v);
			}
			if self.env.set_slot(slot, v)? {
				return Ok(v);
			}
			// A different variable now: start again by name.
			e.pval = None;
		}
		let Some(span) = e.lval else {
			return Err(MathError::LvalueRequired.into());
		};
		if self.noeval > 0 {
			return Ok(v);
		}
		let expr = self.expr;
		let raw = tok::span(&expr.src, span.start, span.end);
		let name: Cow<'_, [u8]> = if tok::has_token(raw) {
			let mut s = raw.to_vec();
			tok::untokenize(&mut s);
			Cow::Owned(s)
		} else {
			Cow::Borrowed(raw)
		};
		Ok(match self.env.assign(&name, v)? {
			Some(Assigned::Integer) => v.integer(),
			Some(Assigned::Float) => v.float(),
			Some(Assigned::Other) | None => v,
		})
	}

	/// zsh `getcvar`: the code of the first character of the variable
	/// `#name` names, 0 when unset.
	fn getcvar(&mut self, span: Span) -> Number {
		let expr = self.expr;
		let Some(t) = self.env.scalar(tok::span(&expr.src, span.start, span.end)) else {
			return Number::Int(0);
		};
		if self.opts.multibyte
			&& let (Some(ch), _) = bstr::decode_utf8(&t)
		{
			return Number::Int(i64::from(u32::from(ch)));
		}
		Number::Int(i64::from(t.first().copied().unwrap_or(0)))
	}

	/// zsh `callmathfunc`: call the function `name(args)` of `span`.
	fn callmathfunc(&mut self, span: Span) -> Result<Number, E::Error> {
		let expr = self.expr;
		let o: &[u8] = tok::span(&expr.src, span.start, span.end);
		let open = o.iter().position(|&c| c == b'(').unwrap_or(o.len());
		let name = head(o, open);
		let inner = o.get(open + 1..).unwrap_or_default();
		// The closing parenthesis (or whatever ended the text).
		let mut a = head(inner, inner.len().saturating_sub(1));
		let Some(f) = self.env.math_func(name) else {
			return Err(MathError::UnknownFunction { name: Nice::of(name) }.into());
		};
		if f.kind == FuncKind::String {
			return self.env.call_math_func(name, &f, FuncArgs::Text(a));
		}
		let user = f.kind != FuncKind::Numeric;
		let mut nums: Vec<Number> = Vec::new();
		let mut strs: Vec<BString> = Vec::new();
		let mut argc = 0usize;
		if f.kind == FuncKind::UserString {
			argc = 1;
			strs.push(BString::from(a));
			a = &[];
		} else {
			while let [b' ' | b'\t', rest @ ..] = a {
				a = rest;
			}
			while at(a, 0) != 0 {
				argc += 1;
				let (marg, used, last) = mathevall(&mut *self.env, a, true, self.noeval)?;
				a = tail(a, used);
				if user {
					strs.push(BString::from(match marg {
						Number::Float(d) => format_float(d),
						Number::Int(l) => convbase(l, 10, self.opts),
					}));
				} else {
					nums.push(marg);
				}
				if last != Tok::Comma {
					break;
				}
			}
		}
		if at(a, 0) != 0 {
			return Err(MathError::IllegalCharacter { c: Nice::of(head(a, 1)) }.into());
		}
		if argc < f.min_args || f.max_args.is_some_and(|m| argc > m) {
			return Err(MathError::WrongArguments { call: Nice::of(o) }.into());
		}
		let args = if user {
			FuncArgs::Strings(&strs)
		} else {
			FuncArgs::Numbers(&nums)
		};
		self.env.call_math_func(name, &f, args)
	}

	/// zsh `bop`: before the right operand of `&&`/`||` (and `&&=`/`||=`),
	/// skip it when the left one decides.
	fn bop(&mut self, tk: Tok) -> Result<(), E::Error> {
		let tst = self.top_value()?.to_int();
		match tk {
			Tok::DAnd | Tok::DAndEq if tst == 0 => self.noeval += 1,
			Tok::DOr | Tok::DOrEq if tst != 0 => self.noeval += 1,
			_ => {},
		}
		Ok(())
	}

	/// zsh `op`: apply operator `what` to the operands on the stack.
	fn op(&mut self, what: Tok) -> Result<(), E::Error> {
		let tp = what.kind();
		if self.stack.is_empty() {
			return Err(MathError::StackEmpty.into());
		}
		if tp & OP_BINARY != 0 {
			let eb = self.pop(false)?;
			let mut ea = self.pop(what == Tok::Eq)?;
			let mut b = eb.val.unwrap_or(Number::Int(0));
			let mut a = ea.val;
			if tp & (OP_A2IO | OP_E2IO) != 0 {
				a = a.map(Number::integer);
				b = b.integer();
			} else if let Some(av) = a
				&& av.is_float() != b.is_float()
				&& what != Tok::Comma
			{
				// Mixed types: both become floats (an assignment converts
				// back to an integer variable's type).
				a = Some(av.float());
				b = b.float();
			}
			let c = if self.noeval > 0 {
				Number::Int(0)
			} else {
				binary(what, a, b)?
			};
			if tp & (OP_E2 | OP_E2IO) != 0 {
				let c = self.setmathvar(&mut ea, c)?;
				return self.push(c, ea.lval);
			}
			return self.push(c, None);
		}
		let mut e = self.pop(false)?;
		let v = e.val.unwrap_or(Number::Int(0));
		match what {
			Tok::Not => {
				e.val = Some(Number::Int(i64::from(match v {
					Number::Int(l) => l == 0,
					Number::Float(d) => d == 0.0,
				})));
			},
			Tok::Comp => e.val = Some(Number::Int(!v.to_int())),
			Tok::PostPlus | Tok::PostMinus => {
				let n = v.step(if what == Tok::PostPlus { 1 } else { -1 });
				self.setmathvar(&mut e, n)?;
			},
			Tok::UPlus => {},
			Tok::UMinus => {
				e.val = Some(match v {
					Number::Int(l) => Number::Int(l.wrapping_neg()),
					Number::Float(d) => Number::Float(-d),
				});
			},
			Tok::Quest => {
				// `c` is `e`; then the true value and the condition.
				let b = self.pop(false)?.val.unwrap_or(Number::Int(0));
				let a = self.pop(false)?.val.unwrap_or(Number::Int(0));
				return self.push(if a.truth() { b } else { v }, None);
			},
			Tok::Colon => return Err(MathError::ColonWithoutQuest.into()),
			Tok::PrePlus | Tok::PreMinus => {
				let n = v.step(if what == Tok::PrePlus { 1 } else { -1 });
				e.val = Some(n);
				self.setmathvar(&mut e, n)?;
			},
			_ => return Err(MathError::OutOfIntegers.into()),
		}
		e.lval = None;
		e.pval = None;
		self.stack.push(e);
		Ok(())
	}
}

/// How [`convfloat`] formats (zsh's `PM_FFLOAT`/`PM_EFLOAT` flags of
/// `typeset -F`/`-E`; neither for `$(( ))`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FloatKind {
	/// `%.Ng`, 17 significant digits by default (arithmetic results).
	General,
	/// `%.Nf`, N decimals, 10 by default (`typeset -F N`).
	Fixed,
	/// `%.Ne` with N significant digits, 10 by default (`typeset -E N`,
	/// `float`).
	Exponent,
}

/// C `%.{prec}e`: `d.ddde+XX`.
fn printf_e(d: f64, prec: usize) -> String {
	let s = format!("{d:.prec$e}");
	let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
	let exp: i32 = exp.parse().unwrap_or(0);
	format!("{mant}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.unsigned_abs())
}

/// C `%g`'s removal of trailing fractional zeros (and a bare `.`) from
/// the mantissa.
fn strip_fraction_zeros(s: &mut String) {
	let mant_end = s.find('e').unwrap_or(s.len());
	let mant = s.get(..mant_end).unwrap_or_default();
	if !mant.contains('.') {
		return;
	}
	let trimmed = mant.trim_end_matches('0').trim_end_matches('.').len();
	s.replace_range(trimmed..mant_end, "");
}

/// C `%.{prec}g`.
fn printf_g(d: f64, prec: usize) -> String {
	let p = prec.max(1);
	let efmt = format!("{d:.*e}", p - 1);
	let exp: i64 = efmt
		.split_once('e')
		.and_then(|(_, digits)| digits.parse().ok())
		.unwrap_or(0);
	let mut out = if exp < -4 || exp >= p as i64 {
		printf_e(d, p - 1)
	} else {
		format!("{d:.*}", (p as i64 - 1 - exp) as usize)
	};
	strip_fraction_zeros(&mut out);
	out
}

/// zsh `convfloat(dval, digits, flags, NULL)`: `dval` as zsh prints a
/// float.
///
/// `Inf`, `-Inf`, `NaN`; [`FloatKind::General`] with `digits`
/// significant digits (0: 17, so `1./3` is `0.33333333333333331`);
/// [`FloatKind::Fixed`] with `digits` decimals and
/// [`FloatKind::Exponent`] with `digits` significant digits (≤ 0: 10).
/// A result without `.` or exponent gets a trailing `.` (`2.`). Used by
/// `$(( ))`, `typeset -F/-E` and float variables.
pub fn convfloat(dval: f64, digits: i32, kind: FloatKind) -> String {
	if dval.is_infinite() {
		return if dval < 0.0 { "-Inf" } else { "Inf" }.to_owned();
	}
	if dval.is_nan() {
		return "NaN".to_owned();
	}
	// A negative precision is C's "omitted": 6.
	let prec = |p: i32| usize::try_from(p).unwrap_or(6);
	let mut s = match kind {
		FloatKind::General => printf_g(dval, prec(if digits == 0 { 17 } else { digits })),
		FloatKind::Fixed => format!("{dval:.*}", prec(if digits <= 0 { 10 } else { digits })),
		FloatKind::Exponent => printf_e(dval, prec(if digits <= 0 { 10 } else { digits } - 1)),
	};
	if !s.contains('e') && !s.contains('.') {
		s.push('.');
	}
	s
}

/// zsh's float output of an arithmetic result (`convfloat(dval, 0, 0)`):
/// `$(( 1./3 ))` is `0.33333333333333331`, `$(( 2.0 ))` is `2.`.
pub fn format_float(dval: f64) -> String {
	convfloat(dval, 0, FloatKind::General)
}

/// zsh `convfloat_underscore`: [`format_float`] with the digits before and
/// after the point grouped by `underscore` from the point outwards (`[#_]`:
/// `610_351.562_5`); `underscore` ≤ 0 groups nothing.
pub fn convfloat_underscore(dval: f64, underscore: i32) -> String {
	let s = format_float(dval);
	if underscore <= 0 {
		return s;
	}
	let u = underscore as usize;
	let b = s.as_bytes();
	let mut i = usize::from(b.first() == Some(&b'-'));
	let int_start = i;
	while i < b.len() && b[i].is_ascii_digit() {
		i += 1;
	}
	let ndigits_int = i - int_start;
	let mut ndigits_frac = 0;
	if i < b.len() && b[i] == b'.' {
		i += 1;
		while i < b.len() && b[i].is_ascii_digit() {
			ndigits_frac += 1;
			i += 1;
		}
	}
	let groups = |n: usize| n.saturating_sub(1) / u;
	if groups(ndigits_int) + groups(ndigits_frac) == 0 {
		return s;
	}
	let mut out = String::with_capacity(s.len() + ndigits_int / u + ndigits_frac / u);
	out.push_str(s.get(..int_start).unwrap_or_default());
	let int_digits = s
		.get(int_start..int_start + ndigits_int)
		.unwrap_or_default();
	for (k, ch) in int_digits.chars().enumerate() {
		if k > 0 && (ndigits_int - k) % u == 0 {
			out.push('_');
		}
		out.push(ch);
	}
	let mut rest = int_start + ndigits_int;
	if ndigits_frac > 0 {
		out.push('.');
		rest += 1;
		for (k, ch) in s
			.get(rest..rest + ndigits_frac)
			.unwrap_or_default()
			.chars()
			.enumerate()
		{
			if k > 0 && k % u == 0 {
				out.push('_');
			}
			out.push(ch);
		}
		rest += ndigits_frac;
	}
	out.push_str(s.get(rest..).unwrap_or_default());
	out
}

/// zsh `convbase_ptr`: `v` in `base` (2..=36; -1..=1 means 10 without
/// prefix; negative: no prefix), with its prefix (`16#`, or `0x` / `0`
/// under `cbases`); the text, where its digits start, and their count.
fn convbase_parts(v: i64, base: i32, opts: Options) -> (String, usize, usize) {
	let mut out = String::new();
	if v < 0 {
		out.push('-');
	}
	let base = if (-1..=1).contains(&base) { -10 } else { base };
	if base > 0 {
		if opts.c_bases && base == 16 {
			out.push_str("0x");
		} else if opts.c_bases && base == 8 && opts.octal_zeroes {
			out.push('0');
		} else if base != 10 {
			let _ = write!(out, "{base}#");
		}
	}
	let radix = u64::from(base.unsigned_abs());
	let mut buf = [0u8; 64];
	let mut pos = buf.len();
	let mut rest = v.unsigned_abs();
	loop {
		let dig = (rest % radix) as u8;
		pos -= 1;
		if let Some(b) = buf.get_mut(pos) {
			*b = if dig < 10 {
				b'0' + dig
			} else {
				(dig - 10).wrapping_add(b'A')
			};
		}
		rest /= radix;
		if rest == 0 {
			break;
		}
	}
	let start = out.len();
	out.extend(tail(&buf, pos).iter().map(|&c| char::from(c)));
	(out, start, buf.len() - pos)
}

/// zsh `convbase`: integer `v` in output base `base` (`[#16]` gives
/// `16#FF`; negative `base` omits the prefix; 0 is decimal), for `$(( ))`,
/// `typeset -i N` and math function arguments.
pub fn convbase(v: i64, base: i32, opts: Options) -> String {
	convbase_parts(v, base, opts).0
}

/// zsh `convbase_underscore`: [`convbase`] with the digits grouped by
/// `underscore` from the right (`[#16_4]`: `16#8000_0000`); `underscore`
/// ≤ 0 groups nothing.
pub fn convbase_underscore(v: i64, base: i32, underscore: i32, opts: Options) -> String {
	let (s, start, ndigits) = convbase_parts(v, base, opts);
	if underscore <= 0 || (ndigits - 1) / underscore as usize == 0 {
		return s;
	}
	let u = underscore as usize;
	let mut out = String::with_capacity(s.len() + (ndigits - 1) / u);
	out.push_str(s.get(..start).unwrap_or_default());
	for (k, ch) in s.get(start..).unwrap_or_default().chars().enumerate() {
		if k > 0 && (ndigits - k) % u == 0 {
			out.push('_');
		}
		out.push(ch);
	}
	out
}

/// The text of arithmetic result `n` with the output format in `state`.
///
/// zsh `arithsubst` for `$(( ))`, and `setnumvalue` for a number assigned
/// to a scalar: a float without an output base by
/// [`convfloat_underscore`], anything else as an integer in the output
/// base.
pub fn format_number(n: Number, state: &MathState, opts: Options) -> String {
	match n {
		Number::Float(d) if state.output_radix == 0 => {
			convfloat_underscore(d, state.output_underscore)
		},
		_ => convbase_underscore(n.to_int(), state.output_radix, state.output_underscore, opts),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A variable of the test shell.
	#[derive(Clone, Debug)]
	enum Var {
		Int(i64),
		Float(f64),
		Text(BString),
		Array(Vec<BString>),
	}

	/// What [`TestEnv::get`] resolved.
	#[derive(Clone, Debug)]
	enum Slot {
		Name(BString),
		Elem(BString, usize),
	}

	/// An in-memory shell: zsh's parameter semantics for scalars, integers,
	/// floats and 1-indexed arrays.
	struct TestEnv {
		vars:     HashMap<BString, Var>,
		opts:     Options,
		cache:    Cache,
		state:    MathState,
		warnings: Vec<Warning>,
		argv:     Vec<BString>,
		status:   i64,
		funcs:    HashMap<BString, MathFunc>,
		calls:    Vec<(BString, Vec<BString>)>,
	}

	impl TestEnv {
		fn new() -> Self {
			Self {
				vars:     HashMap::new(),
				opts:     Options::default(),
				cache:    Cache::default(),
				state:    MathState::default(),
				warnings: Vec::new(),
				argv:     Vec::new(),
				status:   0,
				funcs:    HashMap::new(),
				calls:    Vec::new(),
			}
		}

		fn set(&mut self, name: &str, v: Var) -> &mut Self {
			self.vars.insert(BString::from(name), v);
			self
		}

		fn text(&mut self, name: &str, v: &str) -> &mut Self {
			self.set(name, Var::Text(BString::from(v)))
		}

		fn shown(&self, name: &str) -> String {
			match self.vars.get(name.as_bytes()) {
				None => "unset".to_owned(),
				Some(Var::Int(v)) => v.to_string(),
				Some(Var::Float(d)) => convfloat(*d, 0, FloatKind::Fixed),
				Some(Var::Text(t)) => t.to_string(),
				Some(Var::Array(a)) => a
					.iter()
					.map(ToString::to_string)
					.collect::<Vec<_>>()
					.join(" "),
			}
		}

		/// `name` and the subscript text of `lval`.
		fn split(lval: &[u8]) -> (BString, Option<BString>) {
			match lval.iter().position(|&c| c == b'[') {
				Some(i) => (
					BString::from(&lval[..i]),
					Some(BString::from(&lval[i + 1..lval.len().saturating_sub(1)])),
				),
				None => (BString::from(lval), None),
			}
		}

		fn write(&mut self, slot: &Slot, value: Number) {
			let text = BString::from(format_number(value, &self.state, self.opts));
			match slot {
				Slot::Name(n) => {
					let new = match self.vars.get(n) {
						Some(Var::Int(_)) => Var::Int(value.to_int()),
						Some(Var::Float(_)) => Var::Float(value.to_float()),
						_ => Var::Text(text),
					};
					self.vars.insert(n.clone(), new);
				},
				Slot::Elem(n, i) => {
					let entry = self
						.vars
						.entry(n.clone())
						.or_insert_with(|| Var::Array(Vec::new()));
					if let Var::Array(a) = entry {
						if a.len() < *i {
							a.resize(*i, BString::default());
						}
						a[*i - 1] = text;
					}
				},
			}
		}
	}

	impl Env for TestEnv {
		type Error = MathError;
		type Slot = Slot;

		fn options(&self) -> Options {
			self.opts
		}

		fn cache(&self) -> &Cache {
			&self.cache
		}

		fn state(&mut self) -> &mut MathState {
			&mut self.state
		}

		fn get(&mut self, lval: &[u8]) -> Result<Option<(Param, Slot)>, MathError> {
			let (name, sub) = Self::split(lval);
			let Some(sub) = sub else {
				let p = match self.vars.get(&name) {
					None => return Ok(None),
					Some(Var::Int(v)) => Param::Int(*v),
					Some(Var::Float(d)) => Param::Float(*d),
					Some(Var::Text(t)) => Param::Text(t.clone()),
					Some(Var::Array(a)) => Param::Text(BString::from(a.join(&b" "[..]))),
				};
				return Ok(Some((p, Slot::Name(name))));
			};
			let (idx, _) = mathevalarg(self, &sub)?;
			let Ok(i) = usize::try_from(idx) else {
				return Ok(None);
			};
			match self.vars.get(&name) {
				Some(Var::Array(a)) if i >= 1 && i <= a.len() => {
					Ok(Some((Param::Text(a[i - 1].clone()), Slot::Elem(name, i))))
				},
				_ => Ok(None),
			}
		}

		fn set_slot(&mut self, slot: &Slot, value: Number) -> Result<bool, MathError> {
			self.write(slot, value);
			Ok(true)
		}

		fn assign(&mut self, lval: &[u8], value: Number) -> Result<Option<Assigned>, MathError> {
			let (name, sub) = Self::split(lval);
			if let Some(sub) = sub {
				let (idx, _) = mathevalarg(self, &sub)?;
				let i = usize::try_from(idx).unwrap_or(0).max(1);
				self.write(&Slot::Elem(name, i), value);
				return Ok(Some(Assigned::Other));
			}
			let kind = match self.vars.get(&name) {
				Some(Var::Int(_)) => Assigned::Integer,
				Some(Var::Float(_)) => Assigned::Float,
				Some(Var::Text(_)) => Assigned::Other,
				None | Some(Var::Array(_)) => {
					let v = match value {
						Number::Int(v) => Var::Int(v),
						Number::Float(d) => Var::Float(d),
					};
					self.vars.insert(name, v);
					return Ok(Some(if value.is_float() {
						Assigned::Float
					} else {
						Assigned::Integer
					}));
				},
			};
			self.write(&Slot::Name(name), value);
			Ok(Some(kind))
		}

		fn scalar(&mut self, name: &[u8]) -> Option<BString> {
			if let Ok(i) = name.to_str().unwrap_or("").parse::<usize>() {
				return self.argv.get(i.wrapping_sub(1)).cloned();
			}
			match self.vars.get(name)? {
				Var::Text(t) => Some(t.clone()),
				Var::Int(v) => Some(BString::from(v.to_string())),
				Var::Float(d) => Some(BString::from(format_float(*d))),
				Var::Array(a) => Some(BString::from(a.join(&b" "[..]))),
			}
		}

		fn argc(&mut self) -> i64 {
			self.argv.len() as i64
		}

		fn pid(&mut self) -> i64 {
			4242
		}

		fn last_status(&mut self) -> i64 {
			self.status
		}

		fn warn(&mut self, warning: Warning) {
			self.warnings.push(warning);
		}

		fn math_func(&mut self, name: &[u8]) -> Option<MathFunc> {
			self.funcs.get(name).copied()
		}

		fn call_math_func(
			&mut self,
			name: &[u8],
			_func: &MathFunc,
			args: FuncArgs<'_>,
		) -> Result<Number, MathError> {
			let shown: Vec<BString> = match args {
				FuncArgs::Text(t) => vec![BString::from(t)],
				FuncArgs::Numbers(n) => n
					.iter()
					.map(|&x| BString::from(format_number(x, &MathState::default(), self.opts)))
					.collect(),
				FuncArgs::Strings(s) => s.to_vec(),
			};
			let n = shown.len() as i64;
			self.calls.push((BString::from(name), shown));
			Ok(Number::Int(n))
		}
	}

	/// `print $(( text ))`.
	fn ev(env: &mut TestEnv, text: &str) -> Result<String, MathError> {
		let n = matheval(env, text.as_bytes())?;
		Ok(format_number(n, &env.state, env.opts))
	}

	fn ok(text: &str) -> String {
		ev(&mut TestEnv::new(), text).unwrap_or_else(|e| panic!("{text}: {e}"))
	}

	fn err(text: &str) -> String {
		match ev(&mut TestEnv::new(), text) {
			Ok(v) => panic!("{text}: expected an error, got {v}"),
			Err(e) => e.to_string(),
		}
	}

	fn with(opts: impl FnOnce(&mut Options)) -> TestEnv {
		let mut env = TestEnv::new();
		opts(&mut env.opts);
		env
	}

	#[test]
	fn binary_operators() {
		for (e, want) in [
			("1 + 2", "3"),
			("7 - 10", "-3"),
			("6 * 7", "42"),
			("7 / 2", "3"),
			("-7 / 2", "-3"),
			("-5 % 3", "-2"),
			("1 << 4", "16"),
			("-16 >> 2", "-4"),
			("6 & 3", "2"),
			("6 | 1", "7"),
			("6 ^ 3", "5"),
			("2 ** 10", "1024"),
			("3 ** 2 ** 2", "81"),
			("1 < 2", "1"),
			("2 <= 1", "0"),
			("3 > 2", "1"),
			("2 >= 2", "1"),
			("1 == 1", "1"),
			("1 != 2", "1"),
			("1 && 2", "1"),
			("1 && 0", "0"),
			("0 || 3", "1"),
			("0 || 0", "0"),
			("1 ^^ 1", "0"),
			("0 ^^ 1", "1"),
			("0, 4 ? 3 : 1, 5", "5"),
			("1 ? 2 : 3 ? 4 : 5", "2"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
	}

	#[test]
	fn unary_operators() {
		for (e, want) in [
			("!3", "0"),
			("!0", "1"),
			("~0", "-1"),
			("~1.5", "-2"),
			("!0.5", "0"),
			("+-3", "-3"),
			("- -3", "3"),
			("-(2)", "-2"),
			("-3 ** 2", "9"),
			("2 * 3 ** 2", "18"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
	}

	#[test]
	fn assignment_operators() {
		for (init, e, want, after) in [
			("7", "x -= 2", "5", "5"),
			("7", "x *= 3", "21", "21"),
			("7", "x /= 2", "3", "3"),
			("7", "x %= 4", "3", "3"),
			("6", "x &= 3", "2", "2"),
			("6", "x |= 1", "7", "7"),
			("6", "x ^= 3", "5", "5"),
			("3", "x <<= 2", "12", "12"),
			("-16", "x >>= 2", "-4", "-4"),
			("3", "x **= 3", "27", "27"),
			("1", "x &&= 0", "0", "0"),
			("0", "x ||= 5", "1", "1"),
			// zsh's `^^=` computes without assigning.
			("1", "x ^^= 1", "0", "1"),
			("2.5", "x **= 2", "6.25", "6.25"),
			("1.5", "x += 1", "2.5", "2.5"),
			("3", "x++ + ++x", "8", "5"),
			("2", "x--, x", "1", "1"),
			("2", "--x", "1", "1"),
		] {
			let mut env = TestEnv::new();
			env.text("x", init);
			assert_eq!(ev(&mut env, e).unwrap(), want, "{e}");
			assert_eq!(env.shown("x"), after, "{e}");
		}
	}

	#[test]
	fn assignment_result_takes_the_variable_type() {
		let mut env = TestEnv::new();
		env.set("i", Var::Int(0)).set("f", Var::Float(0.0));
		assert_eq!(ev(&mut env, "i = 5.5 / 2.0").unwrap(), "2");
		assert_eq!(env.shown("i"), "2");
		assert_eq!(ev(&mut env, "f = 1").unwrap(), "1.");
		// A new variable gets the value's type.
		assert_eq!(ev(&mut env, "n = 1.5").unwrap(), "1.5");
		assert!(matches!(env.vars.get(&b"n"[..]), Some(Var::Float(_))));
		assert_eq!(ev(&mut env, "m = 3").unwrap(), "3");
		assert!(matches!(env.vars.get(&b"m"[..]), Some(Var::Int(3))));
	}

	#[test]
	fn parenthesised_and_assigned_results_stay_assignable() {
		let mut env = TestEnv::new();
		assert_eq!(ev(&mut env, "(a) = 3").unwrap(), "3");
		assert_eq!(env.shown("a"), "3");
		assert_eq!(ev(&mut env, "(a = 3) += 1").unwrap(), "4");
		assert_eq!(env.shown("a"), "4");
		// `x &&= y = 3` is `(x &&= y) = 3`: `=` is looser than the
		// operand of `&&=`.
		env.text("x", "0");
		assert_eq!(ev(&mut env, "x &&= y = 3").unwrap(), "3");
		assert_eq!(env.shown("y"), "unset");
	}

	#[test]
	fn zsh_precedence() {
		assert_eq!(ok("4 - - 3 * 7 << 1 & 7 ^ 1 | 16 ** 2"), "1591");
		assert_eq!(ok("1 + 2 << 3"), "17");
		assert_eq!(ok("5 & 3 + 1"), "2");
		assert_eq!(ok("1 < 2 || 2 < 2 && 3 > 4"), "1");
		assert_eq!(ok("1 + 4 ? 3 + 2 ? 4 + 3 ? 5 + 6 ? 4 * 8 : 0 : 0 : 0 : 0"), "32");
	}

	#[test]
	fn c_precedence() {
		let mut env = with(|o| o.c_precedences = true);
		assert_eq!(ev(&mut env, "4 - - 3 * 7 << 1 & 7 ^ 1 | 16 ** 2").unwrap(), "259");
		assert_eq!(ev(&mut env, "1 + 2 << 3").unwrap(), "24");
		assert_eq!(ev(&mut env, "5 & 3 + 1").unwrap(), "4");
		// The cache recompiles the same text when the table changes.
		env.opts.c_precedences = false;
		assert_eq!(ev(&mut env, "1 + 2 << 3").unwrap(), "17");
	}

	#[test]
	fn float_promotion() {
		for (e, want) in [
			("3 + 5 * 1.75", "11.75"),
			("1 / 2", "0"),
			("1 / 2.", "0.5"),
			("29.1 % 13.0 * 10 + 0.5", "31.500000000000014"),
			("5.5 % 2", "1.5"),
			("0x30 + 0.5", "48.5"),
			("077 + 0.5", "77.5"),
			("1 && 0.5", "0"),
			("0.5 ? 1 : 2", "1"),
			("2 ** -1", "0.5"),
			("3 ** -2", "0.1111111111111111"),
			("1 ** 0.5", "1."),
			("0 ** 0", "1"),
			("0. ** 0", "1."),
			("0 ** -1", "Inf"),
			("1.5 > 1", "1"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
	}

	#[test]
	fn force_float() {
		for (e, plain, forced) in
			[("3/4", "0", "0.75"), ("0x100/0x200", "0", "0.5"), ("0x30/0x10", "3", "3.")]
		{
			assert_eq!(ok(e), plain, "{e}");
			assert_eq!(ev(&mut with(|o| o.force_float = true), e).unwrap(), forced, "{e}");
		}
		let mut env = with(|o| o.force_float = true);
		env.set("a", Var::Int(3)).set("b", Var::Int(4));
		assert_eq!(ev(&mut env, "a/b").unwrap(), "0.75");
	}

	#[test]
	fn special_values() {
		for (e, want) in [
			("1e500", "Inf"),
			("-1e500", "-Inf"),
			("1e500/1e500", "NaN"),
			("24. % 0", "NaN"),
			("3.0 / 0", "Inf"),
			("5 / 0.", "Inf"),
			("nan + 1", "NaN"),
			("Inf == Inf", "1"),
			("-Inf", "-Inf"),
			("INF", "Inf"),
			("iNF", "Inf"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
	}

	#[test]
	fn nan_and_inf_are_names_only_at_their_length_or_under_sh() {
		let mut env = TestEnv::new();
		env.text("in", "1").text("info", "2").text("Infinity", "3");
		assert_eq!(ev(&mut env, "in").unwrap(), "1");
		assert_eq!(ev(&mut env, "info").unwrap(), "2");
		assert_eq!(ev(&mut env, "Infinity").unwrap(), "3");
		env.text("Inf", "3");
		assert_eq!(ev(&mut env, "Inf").unwrap(), "Inf");
		assert_eq!(err("NaN = 1"), "bad math expression: lvalue required");
		assert_eq!(err("Inf[0]"), "bad base syntax");
		let mut sh = with(|o| o.sh_emulation = true);
		assert_eq!(ev(&mut sh, "NaN").unwrap(), "0");
	}

	#[test]
	fn constants_and_bases() {
		for (e, want) in [
			("0x10 + 0X01 + 2#1010", "27"),
			("36#z", "35"),
			("1_6_#f_f_", "255"),
			("0b0 + 0b1 + 0b11 + 0b110", "10"),
			("0x_ff_ff_", "65535"),
			("3_000_+4_000_/2", "5000"),
			("1_0.000_000e0_1", "100."),
			("-2#101-16#f", "-20"),
			("[16]1f", "31"),
			("010", "10"),
			("08", "8"),
			("07.5", "7.5"),
			("0x", "0"),
			("1.", "1."),
			(".5", "0.5"),
			("1e3", "1000."),
			("1.e3", "1000."),
			("0x7fffffffffffffff + 1", "-9223372036854775808"),
			("-9223372036854775807 - 1", "-9223372036854775808"),
			("(-9223372036854775807 - 1) / -1", "-9223372036854775808"),
			("(-9223372036854775807 - 1) % -1", "0"),
			("2**63", "-9223372036854775808"),
			("1 << 64", "1"),
			("1 << -1", "-9223372036854775808"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
	}

	#[test]
	fn octal_zeroes() {
		let mut env = with(|o| o.octal_zeroes = true);
		assert_eq!(ev(&mut env, "077 + 0.5").unwrap(), "63.5");
		assert_eq!(ev(&mut env, "09.5").unwrap(), "9.5");
		assert_eq!(ev(&mut env, "08#77").unwrap(), "63");
		assert_eq!(ev(&mut env, "010").unwrap(), "8");
		assert_eq!(
			ev(&mut env, " 09 ").unwrap_err().to_string(),
			"bad math expression: operator expected at `9 '"
		);
		// A variable's value is read with the same rule.
		env.text("x", "010");
		assert_eq!(ev(&mut env, "x").unwrap(), "8");
	}

	#[test]
	fn truncated_constant_warns() {
		let mut env = TestEnv::new();
		assert_eq!(ev(&mut env, " 9223372036854775808 ").unwrap(), "922337203685477580");
		assert_eq!(
			env.warnings
				.iter()
				.map(ToString::to_string)
				.collect::<Vec<_>>(),
			["number truncated after 18 digits: 9223372036854775808 "]
		);
		let mut env = TestEnv::new();
		assert_eq!(ev(&mut env, "99999999999999999999").unwrap(), "-8446744073709551617");
		assert_eq!(
			env.warnings[0].to_string(),
			"number truncated after 19 digits: 99999999999999999999"
		);
	}

	#[test]
	fn output_bases() {
		for (e, want) in [
			("[#16] 255", "16#FF"),
			("[##16] 255", "FF"),
			("[#16] -255", "-16#FF"),
			("[##2] 5", "101"),
			("[#16] 1.5", "16#1"),
			("[#16] 1e500", "16#7FFFFFFFFFFFFFFF"),
			("[#16] [#8] 9", "8#11"),
			("[#16]", "16#0"),
			("[#_] 1000000", "1_000_000"),
			("[#16_4] 65536 * 32768", "16#8000_0000"),
			("[#_] (5. ** 10) / 16.", "610_351.562_5"),
			("[#_2] 1234567.1234567", "1_23_45_67.12_34_56_7"),
			("[#_] -1234.5", "-1_234.5"),
			("[#_] 0.5", "0.5"),
			("[#_3] 1e21", "1e+21"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
		let mut env = with(|o| o.c_bases = true);
		assert_eq!(ev(&mut env, "[#16] 255").unwrap(), "0xFF");
		assert_eq!(ev(&mut env, "[##16] 255").unwrap(), "FF");
		assert_eq!(ev(&mut env, "[#16] -255").unwrap(), "-0xFF");
		assert_eq!(ev(&mut env, "[#8] 8").unwrap(), "8#10");
		assert_eq!(ev(&mut env, "[#16_] 65536").unwrap(), "0x10_000");
		assert_eq!(ev(&mut env, "[#16_4] 65536 * 32768").unwrap(), "0x8000_0000");
		env.opts.octal_zeroes = true;
		assert_eq!(ev(&mut env, "[#8] 8").unwrap(), "010");
		assert_eq!(ev(&mut env, "[#2] 5").unwrap(), "2#101");
	}

	#[test]
	fn output_format_follows_nested_evaluation_order() {
		let mut env = TestEnv::new();
		env.text("x", "[#16] 255");
		assert_eq!(ev(&mut env, "x").unwrap(), "16#FF");
		// x is read after `[#8]` was lexed: its own format wins.
		assert_eq!(ev(&mut env, "[#8] x").unwrap(), "16#FF");
		assert_eq!(ev(&mut env, "x + [#8] 1").unwrap(), "16#100");
		// A new top-level evaluation starts without a format.
		assert_eq!(ev(&mut env, "255").unwrap(), "255");
	}

	#[test]
	fn assignment_to_scalar_uses_output_format() {
		let mut env = TestEnv::new();
		env.text("x", "abc");
		ev(&mut env, "[#16] x = 255").unwrap();
		assert_eq!(env.shown("x"), "16#FF");
		env.text("y", "/bar");
		ev(&mut env, "y = 32").unwrap();
		assert_eq!(env.shown("y"), "32");
		env.text("z", "1");
		ev(&mut env, "z = 3.5").unwrap();
		assert_eq!(env.shown("z"), "3.5");
	}

	#[test]
	fn lastbase_reports_the_last_based_constant() {
		let mut env = TestEnv::new();
		for (e, base) in [("16#ff", 16), ("0x10", 16), ("0b1", 2), ("12", -1), ("2#1 + 8#7", 8)] {
			ev(&mut env, e).unwrap();
			assert_eq!(env.state.lastbase, base, "{e}");
		}
		let mut env = with(|o| o.octal_zeroes = true);
		ev(&mut env, "017").unwrap();
		assert_eq!(env.state.lastbase, 8);
		// A nested evaluation does not change the caller's.
		let mut env = TestEnv::new();
		env.text("x", "16#ff");
		ev(&mut env, "x + 1").unwrap();
		assert_eq!(env.state.lastbase, -1);
		assert_eq!(env.state.mlevel, 0);
	}

	#[test]
	fn character_codes() {
		let mut env = TestEnv::new();
		env.text("foo", "000");
		assert_eq!(ev(&mut env, "##A + ##\\C-a + #foo + 3").unwrap(), "117");
		for (e, want) in [
			("## ", "32"),
			("##\\M-a", "225"),
			("##^A", "1"),
			("##\\e", "27"),
			("##\\x41", "65"),
			("##\\101", "65"),
			("##\\C-?", "127"),
			("##^?", "127"),
			("##\\u00e9", "233"),
			("##é", "233"),
			("#\\a", "97"),
		] {
			assert_eq!(ok(e), want, "{e}");
		}
		assert_eq!(err("##"), "bad math expression: character missing after ##");
	}

	#[test]
	fn pound_forms() {
		let mut env = TestEnv::new();
		env.argv = vec![BString::from("a"), BString::from("b"), BString::from("c")];
		env.text("x", "é");
		assert_eq!(ev(&mut env, "#").unwrap(), "3");
		assert_eq!(ev(&mut env, "#1").unwrap(), "97");
		assert_eq!(ev(&mut env, "#x").unwrap(), "233");
		assert_eq!(ev(&mut env, "#nosuch").unwrap(), "0");
		env.opts.multibyte = false;
		assert_eq!(ev(&mut env, "#x").unwrap(), "195");
		// `#name` is an lvalue: zsh assigns the name.
		env.text("y", "a");
		assert_eq!(ev(&mut env, "#y = 5").unwrap(), "5");
		assert_eq!(env.shown("y"), "5");
	}

	#[test]
	fn pid_and_status() {
		let mut env = TestEnv::new();
		env.status = 3;
		assert_eq!(ev(&mut env, "$").unwrap(), "4242");
		assert_eq!(ev(&mut env, "?").unwrap(), "3");
		assert_eq!(ev(&mut env, "1 ? 2 : 3").unwrap(), "2");
	}

	#[test]
	fn variable_values_are_expressions() {
		let mut env = TestEnv::new();
		env.text("x", "1+2");
		assert_eq!(ev(&mut env, "x * 3").unwrap(), "9");
		env.text("x", "y").text("y", "4");
		assert_eq!(ev(&mut env, "x").unwrap(), "4");
		env.text("fail", "39");
		assert_eq!(ev(&mut env, "3 + \"fail\"").unwrap(), "42");
		assert_eq!(ev(&mut env, "\"6+2\" / \"1+3\"").unwrap(), "11");
		env.text("foo", "(1)");
		assert_eq!(ev(&mut env, "foo").unwrap(), "1");
		env.text("foo", "3)");
		assert_eq!(
			ev(&mut env, "foo").unwrap_err().to_string(),
			"bad math expression: unexpected ')'"
		);
		env.text("foo", "(");
		assert_eq!(ev(&mut env, "foo").unwrap_err().to_string(), "bad math expression: ')' expected");
		env.text("foo", "1 2");
		assert_eq!(
			ev(&mut env, "foo").unwrap_err().to_string(),
			"bad math expression: operator expected at `2'"
		);
		env.set("arr", Var::Array(vec![BString::from("1"), BString::from("2")]));
		assert_eq!(
			ev(&mut env, "arr").unwrap_err().to_string(),
			"bad math expression: operator expected at `2'"
		);
		env.text("empty", "");
		assert_eq!(ev(&mut env, "empty + 1").unwrap(), "1");
		env.text("inf", "Inf");
		assert_eq!(ev(&mut env, "inf").unwrap(), "Inf");
	}

	#[test]
	fn self_referencing_values_hit_the_recursion_limit() {
		let mut env = TestEnv::new();
		env.text("x", "x + 1");
		assert_eq!(
			ev(&mut env, "x").unwrap_err().to_string(),
			"math recursion limit exceeded: x + 1"
		);
		assert_eq!(env.state.mlevel, 0);
	}

	#[test]
	fn noeval_branches_read_and_write_nothing() {
		let mut env = with(|o| o.unset = false);
		assert_eq!(ev(&mut env, "0 && x").unwrap(), "0");
		assert_eq!(ev(&mut env, "1 || x++").unwrap(), "1");
		assert_eq!(ev(&mut env, "0 && (x = 5)").unwrap(), "0");
		assert_eq!(ev(&mut env, "1 ? 2 : (x = 3)").unwrap(), "2");
		assert_eq!(ev(&mut env, "0 ? (x = 3) : 4").unwrap(), "4");
		assert_eq!(env.shown("x"), "unset");
		// Syntax is still checked in a skipped branch.
		assert_eq!(
			ev(&mut env, "0 && 3 = 4").unwrap_err().to_string(),
			"bad math expression: lvalue required"
		);
	}

	#[test]
	fn nounset() {
		let mut env = with(|o| o.unset = false);
		assert_eq!(
			ev(&mut env, "noexist + 1").unwrap_err().to_string(),
			"noexist: parameter not set"
		);
		// The right operand is read first.
		assert_eq!(ev(&mut env, "x + y").unwrap_err().to_string(), "y: parameter not set");
		assert_eq!(ev(&mut env, "noexist++").unwrap_err().to_string(), "noexist: parameter not set");
		// Plain assignment does not read.
		assert_eq!(ev(&mut env, "z = 2").unwrap(), "2");
		let mut env = TestEnv::new();
		assert_eq!(ev(&mut env, "-x").unwrap(), "0");
		assert_eq!(ev(&mut env, "1, x").unwrap(), "0");
	}

	#[test]
	fn subscripts_are_evaluated_once_per_operand() {
		let mut env = TestEnv::new();
		env.set("array", Var::Array(vec![BString::from("1")]))
			.text("x", "0");
		ev(&mut env, "array[++x]++").unwrap();
		assert_eq!(env.shown("x"), "1");
		assert_eq!(env.shown("array"), "2");
		// An assignment that does not read its target resolves it again.
		env.set("array", Var::Array(vec![BString::from("1"), BString::from("2")]))
			.text("x", "0");
		ev(&mut env, "array[++x] = array[++x] + 1").unwrap();
		assert_eq!(env.shown("x"), "2");
		env.set("a", Var::Array(vec![BString::from("1"), BString::from("2"), BString::from("3")]))
			.text("i", "1");
		ev(&mut env, "a[i++] += 10").unwrap();
		assert_eq!(env.shown("i"), "2");
		assert_eq!(env.shown("a"), "11 2 3");
		env.set("s", Var::Int(1));
		ev(&mut env, "n[s]++").unwrap();
		ev(&mut env, "n[s]++").unwrap();
		assert_eq!(env.shown("n"), "2");
	}

	#[test]
	fn converting_array_to_number() {
		let mut env = TestEnv::new();
		env.set("xarr", Var::Array(Vec::new()));
		ev(&mut env, "xarr = 3").unwrap();
		assert!(matches!(env.vars.get(&b"xarr"[..]), Some(Var::Int(3))));
	}

	#[test]
	fn lvalues() {
		for e in ["13 = 42", "++1", "1++", "++a++ * 2", "(1) = 2"] {
			assert_eq!(err(e), "bad math expression: lvalue required", "{e}");
		}
		let mut env = TestEnv::new();
		env.set("a", Var::Int(1));
		assert_eq!(ev(&mut env, "++a * 2").unwrap(), "4");
		assert_eq!(ev(&mut env, "++a").unwrap(), "3");
		assert_eq!(ev(&mut env, "a++ * 2").unwrap(), "6");
		assert_eq!(ev(&mut env, "a").unwrap(), "4");
	}

	#[test]
	fn syntax_errors() {
		for (e, msg) in [
			("3 ? 2", "bad math expression: ':' expected"),
			("0 ? x = 1 : 2", "bad math expression: ':' expected"),
			("3 ? 2 : 1 : 4", "bad math expression: ':' without '?'"),
			(" a = ", "bad math expression: operand expected at end of string"),
			(" 3, ", "bad math expression: operand expected at end of string"),
			(" 3,,4 ", "bad math expression: operand expected at `,4 '"),
			(" ,1 ", "bad math expression: operand expected at `,1 '"),
			(" 3 4 ", "bad math expression: operator expected at `4 '"),
			(" 0b2 ", "bad math expression: operator expected at `2 '"),
			(" 1e ", "bad math expression: operator expected at `e '"),
			(" 0x1p3 ", "bad math expression: operator expected at `p3 '"),
			(" 16#1G ", "bad math expression: operator expected at `G '"),
			(" 2 --1 ", "bad math expression: operator expected at `1 '"),
			(" 1 2345678901234 ", "bad math expression: operator expected at `2345678901...'"),
			(" 1 + * 2345678901234 ", "bad math expression: operand expected at `* 23456789...'"),
			(" 1 +\t* 2 ", "bad math expression: operand expected at `* 2 '"),
			(" 1 1_0.5", "bad math expression: operator expected at `1_0.5'"),
			("(1", "bad math expression: ')' expected"),
			("1)", "bad math expression: unexpected ')'"),
			("()", "bad math expression: operand expected at `)'"),
			(" @ ", "bad math expression: illegal character: @"),
			(" 1 @ 2 ", "bad math expression: illegal character: @"),
			(" 'a' ", "bad math expression: illegal character: '"),
			("1..2", "bad floating point constant"),
			(".", "bad floating point constant"),
			("37#z", "invalid base (must be 2 to 36 inclusive): 37"),
			("1#1", "invalid base (must be 2 to 36 inclusive): 1"),
			("[#1] 3", "invalid base (must be 2 to 36 inclusive): 1"),
			("[#37] 3", "invalid base (must be 2 to 36 inclusive): 37"),
			("[#] 3", "bad output format specification"),
			("[#16 3", "bad output format specification"),
			("[16]ff", "bad base syntax"),
			("[16]", "bad base syntax"),
			("3 / 0", "division by zero"),
			("5 % 0", "division by zero"),
			("-2 ** 0.5", "bad math expression: imaginary power"),
			("(-2) ** 0.5", "bad math expression: imaginary power"),
			("f(1)", "unknown function: f"),
		] {
			assert_eq!(err(e), msg, "{e}");
		}
	}

	#[test]
	fn errors_come_in_evaluation_order() {
		// The division is evaluated before the parser reaches the missing
		// operand.
		assert_eq!(err("1/0 + "), "division by zero");
		// A syntax error stops the parse before later operations run.
		let mut env = TestEnv::new();
		assert!(ev(&mut env, "x = 1, 3 4, y = 2").is_err());
		assert_eq!(env.shown("x"), "1");
		assert_eq!(env.shown("y"), "unset");
	}

	#[test]
	fn stack_limit() {
		let deep = format!("{}1", "a=".repeat(99));
		assert_eq!(ok(&deep), "1");
		let deeper = format!("{}1", "a=".repeat(100));
		assert_eq!(err(&deeper), "stack overflow");
		let parens = format!("{}1{}", "(".repeat(2000), ")".repeat(2000));
		assert!(err(&parens).starts_with("math recursion limit exceeded: "));
	}

	#[test]
	fn empty_input() {
		assert_eq!(ok(""), "0");
		assert_eq!(ok("  "), "0");
		let mut env = TestEnv::new();
		assert_eq!(
			format_number(matheval(&mut env, &[tok::NULARG]).unwrap(), &env.state, env.opts),
			"0"
		);
	}

	#[test]
	fn mathevalarg_stops_at_comma_and_bracket() {
		let mut env = TestEnv::new();
		assert_eq!(mathevalarg(&mut env, b"1,3]").unwrap(), (1, 1));
		assert_eq!(mathevalarg(&mut env, b"2+3]").unwrap(), (5, 3));
		assert_eq!(mathevalarg(&mut env, b"1_0.5,2").unwrap(), (10, 5));
		assert_eq!(mathevalarg(&mut env, b"").unwrap_err(), MathError::EmptyString);
		assert_eq!(mathevali(&mut env, b"7.9").unwrap(), 7);
	}

	#[test]
	fn math_functions() {
		let mut env = TestEnv::new();
		env.funcs.insert(BString::from("s"), MathFunc {
			kind:     FuncKind::UserString,
			min_args: 0,
			max_args: None,
		});
		env.funcs.insert(BString::from("two"), MathFunc {
			kind:     FuncKind::Numeric,
			min_args: 2,
			max_args: Some(2),
		});
		env.funcs.insert(BString::from("raw"), MathFunc {
			kind:     FuncKind::String,
			min_args: 1,
			max_args: Some(1),
		});
		assert_eq!(ev(&mut env, "s( 1.5 , 2 )").unwrap(), "1");
		assert_eq!(env.calls.last().unwrap().1, [BString::from(" 1.5 , 2 ")]);
		assert_eq!(ev(&mut env, "s()").unwrap(), "1");
		assert_eq!(ev(&mut env, "two(1, 2*3)").unwrap(), "2");
		assert_eq!(env.calls.last().unwrap().1, [BString::from("1"), BString::from("6")]);
		assert_eq!(ev(&mut env, "raw()").unwrap(), "1");
		assert_eq!(env.calls.last().unwrap().1, [BString::default()]);
		assert_eq!(
			ev(&mut env, "two(1)").unwrap_err().to_string(),
			"wrong number of arguments: two(1)"
		);
		assert_eq!(
			ev(&mut env, "two(1 2)").unwrap_err().to_string(),
			"bad math expression: operator expected at `2'"
		);
		assert_eq!(
			ev(&mut env, "two(1 @)").unwrap_err().to_string(),
			"bad math expression: illegal character: @"
		);
		// Not called in a skipped branch.
		let calls = env.calls.len();
		assert_eq!(ev(&mut env, "0 && two(1, 2)").unwrap(), "0");
		assert_eq!(env.calls.len(), calls);
	}

	#[test]
	fn float_formatting() {
		assert_eq!(format_float(1.0 / 3.0), "0.33333333333333331");
		assert_eq!(format_float(2.0), "2.");
		assert_eq!(format_float(2.5), "2.5");
		assert_eq!(format_float(-0.0), "-0.");
		assert_eq!(format_float(0.0), "0.");
		assert_eq!(format_float(1e21), "1e+21");
		assert_eq!(format_float(1e17), "1e+17");
		assert_eq!(format_float(1e16), "10000000000000000.");
		assert_eq!(format_float(1e-5), "1.0000000000000001e-05");
		assert_eq!(format_float(1e-4), "0.0001");
		assert_eq!(format_float(1.5e-4), "0.00014999999999999999");
		assert_eq!(format_float(0.1 + 0.2), "0.30000000000000004");
		assert_eq!(format_float(123456789012345678.0), "1.2345678901234568e+17");
		assert_eq!(format_float(f64::INFINITY), "Inf");
		assert_eq!(format_float(f64::NEG_INFINITY), "-Inf");
		assert_eq!(format_float(f64::NAN), "NaN");
	}

	#[test]
	fn typeset_float_formats() {
		assert_eq!(convfloat(4.0, 0, FloatKind::Exponent), "4.000000000e+00");
		assert_eq!(convfloat(4.0, 0, FloatKind::Fixed), "4.0000000000");
		assert_eq!(convfloat(0.25, 1, FloatKind::Fixed), "0.2");
		assert_eq!(convfloat(0.125, 2, FloatKind::Fixed), "0.12");
		assert_eq!(convfloat(2.5, 1, FloatKind::Exponent), "2e+00");
		assert_eq!(convfloat(1234.5, 3, FloatKind::Exponent), "1.23e+03");
		assert_eq!(convfloat(1234.5678, 3, FloatKind::Fixed), "1234.568");
		assert_eq!(convfloat(0.000123, 0, FloatKind::Exponent), "1.230000000e-04");
		assert_eq!(convfloat(-0.5, 0, FloatKind::Fixed), "-0.5000000000");
		assert_eq!(convfloat(1.5, 0, FloatKind::Fixed), "1.5000000000");
		assert_eq!(convfloat(f64::NAN, 3, FloatKind::Fixed), "NaN");
	}

	#[test]
	fn integer_formatting() {
		let o = Options::default();
		let c = Options { c_bases: true, ..o };
		let co = Options { c_bases: true, octal_zeroes: true, ..o };
		assert_eq!(convbase(255, 16, o), "16#FF");
		assert_eq!(convbase(255, -16, o), "FF");
		assert_eq!(convbase(255, 0, o), "255");
		assert_eq!(convbase(255, 10, o), "255");
		assert_eq!(convbase(-255, 16, c), "-0xFF");
		assert_eq!(convbase(8, 8, c), "8#10");
		assert_eq!(convbase(8, 8, co), "010");
		assert_eq!(convbase(0, 2, o), "2#0");
		assert_eq!(convbase(i64::MIN, 10, o), "-9223372036854775808");
		assert_eq!(convbase(35, 36, o), "36#Z");
		assert_eq!(convbase_underscore(1000000, 0, 3, o), "1_000_000");
		assert_eq!(convbase_underscore(100000, 0, 3, o), "100_000");
		assert_eq!(convbase_underscore(-1000, 0, 3, o), "-1_000");
		assert_eq!(convbase_underscore(999, 0, 3, o), "999");
		assert_eq!(convbase_underscore(65536, 16, 3, c), "0x10_000");
	}

	#[test]
	fn messages_show_control_characters_nicely() {
		let s = Snippet::of(b"\x01\n\tab\x7f");
		assert_eq!(s.to_string(), "^A\\n\\tab^?");
		let long = Snippet::of(b"0123456789abc");
		assert_eq!(long.to_string(), "0123456789...");
		assert_eq!(Nice(BString::from(&b"a\xffb"[..])).to_string(), "a\\M-^?b");
	}
}
