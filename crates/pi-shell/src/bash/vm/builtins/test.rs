//! `test`, `[` and the `[[ ]]` primaries, sharing one evaluator of unary
//! and binary primaries (file primaries are probes). The `test` grammar is
//! a port of bash's `test.c`, quirks and messages included.

use std::{borrow::Cow, sync::Arc};

use bstr::{BString, ByteSlice};

use super::{Chunk, Ctx, Need, R, done, number};
use crate::bash::{
	diag::Diag,
	fs::{FileKind, Stat, StatKind},
	ir::{CondIr, Op, Unit},
	pattern::{PatOpts, Regex},
	store::{Attrs, OptId, OptKind, VarValue},
	syntax::MAX_NESTING,
	vm::{
		Cx, Kernel,
		exec::{Flow, expanding},
		expand::arith_value,
		probe::{self, absolute},
		proc::{PendingWrite, Probe, ProbeResult, Slot, Vproc},
		state::{Level, Var},
	},
};

/// Why an evaluation stopped.
enum Fail {
	/// A probe is needed.
	Need(Need),
	/// A usage error (status 2), reported as `NAME: <diag>`.
	Syntax(Diag),
	/// `[[ ]]`: an arithmetic operand failed. bash reports it and the
	/// primary is false (status 1).
	Arith(Diag),
	/// An arithmetic error in an array subscript (`-v 'a[1+]'`): bash
	/// prints it without a command name and abandons the rest of the line
	/// (`jump_to_top_level (DISCARD)` in `array_expand_index`).
	Discard(Diag),
}

impl From<Need> for Fail {
	fn from(n: Need) -> Self {
		Self::Need(n)
	}
}

type T<V> = Result<V, Fail>;

/// A usage error with bash's message.
fn syntax(msg: impl Into<Cow<'static, str>>) -> Fail {
	Fail::Syntax(Diag::Usage { msg: msg.into() })
}

/// bash's `integer_expected_error`.
fn integer_expected(arg: &[u8]) -> Fail {
	syntax(format!("{}: integer expected", arg.as_bstr()))
}

const UNARY: &[u8] = b"abcdefghknoprstuvwxzGLNORS";

/// bash's `test_unop`.
fn is_unary(op: &[u8]) -> bool {
	op.len() == 2 && op[0] == b'-' && UNARY.contains(&op[1])
}

/// bash's `test_binop` (the `test` builtin has no `=~`).
const fn is_binop(op: &[u8]) -> bool {
	matches!(
		op,
		b"="
			| b"=="
			| b"!="
			| b"<"
			| b">"
			| b"-eq"
			| b"-ne"
			| b"-lt"
			| b"-le"
			| b"-gt"
			| b"-ge"
			| b"-nt"
			| b"-ot"
			| b"-ef"
	)
}

/// `-a` / `-o` (bash's `ANDOR`).
const fn is_andor(arg: &[u8]) -> bool {
	matches!(arg, b"-a" | b"-o")
}

fn stat(ctx: &Ctx<'_, '_>, arg: &[u8], follow: bool) -> T<Option<Stat>> {
	if arg.is_empty() {
		return Ok(None);
	}
	let path = absolute(&ctx.vp.cwd, arg);
	match ctx.probe(Probe::Stat { path, follow })? {
		ProbeResult::Stat(s) => Ok(s),
		_ => Ok(None),
	}
}

/// A unary primary (bash's `unary_test`).
fn unary(ctx: &mut Ctx<'_, '_>, op: u8, arg: &[u8], cond: bool) -> T<bool> {
	Ok(match op {
		b'z' => arg.is_empty(),
		b'n' => !arg.is_empty(),
		b'o' => {
			match crate::bash::store::OptId::from_name(arg).filter(|o| o.kind() == OptKind::Set) {
				Some(opt) => ctx.option(opt)?,
				None => false,
			}
		},
		b'v' => {
			let expand_once = ctx.option(OptId::AssocExpandOnce)?;
			// In `[[ ]]` under `assoc_expand_once` the operand is one array
			// reference: an associative subscript runs to its final `]`
			// (`aa[x]]`); `test -v` ends it at the first `]`, as bash does.
			if let Some((open, close)) =
				super::vars::array_reference(ctx, arg, expand_once, cond && expand_once)?
			{
				let (name, i) = (&arg[..open], &arg[open + 1..close]);
				let v = ctx.var(name)?;
				// A key is expanded once more (bash's
				// `expand_subscript_string`) unless `assoc_expand_once`;
				// `@` and `*` are keys too.
				if let Some(v) = v.as_ref().filter(|v| matches!(v.value, VarValue::Assoc(_))) {
					let key = if expand_once {
						BString::from(i)
					} else {
						match ctx.expand_subscript(i)? {
							Ok(key) => key,
							Err(d) => {
								ctx.err(d);
								return Ok(false);
							},
						}
					};
					return Ok(!key.is_empty() && v.key(&key).is_some());
				}
				if matches!(i, b"@" | b"*") {
					return Ok(v.is_some_and(|v| !v.values().is_empty()));
				}
				// bash evaluates an index even when the variable is unset
				// (`array_value_internal`).
				return match super::vars::subscript_value(ctx.k, ctx.cx, ctx.vp, i) {
					Ok(n) => Ok(v.is_some_and(|v| v.index(n).is_some())),
					Err(d @ Diag::ArithSubscript { .. }) => Err(Fail::Discard(d)),
					Err(_) => Ok(false),
				};
			}
			// `-v N`: whether positional parameter N is set.
			if let Some(n) = number(arg) {
				let count = ctx.positional()?.len();
				return Ok(usize::try_from(n).is_ok_and(|n| n <= count));
			}
			match ctx.var(arg)? {
				None => false,
				// `-v array` tests element 0 (key "0").
				Some(v) => match &v.value {
					VarValue::Str(_) => true,
					VarValue::Indexed(_) => v.index(0).is_some(),
					VarValue::Assoc(_) => v.key(b"0").is_some(),
				},
			}
		},
		b'R' => ctx
			.var(arg)?
			.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF)),
		b't' => {
			let Some(fd) = number(arg) else {
				return Err(integer_expected(arg));
			};
			i32::try_from(fd)
				.ok()
				.and_then(|fd| ctx.vp.fds.get(fd).and_then(crate::bash::fd::FdRef::kind))
				== Some(FileKind::Tty)
		},
		b'r' | b'w' | b'x' => {
			if arg.is_empty() {
				return Ok(false);
			}
			let mode = match op {
				b'r' => 1,
				b'w' => 2,
				_ => 4,
			};
			let path = absolute(&ctx.vp.cwd, arg);
			ctx.probe(Probe::Access { path, mode })? == ProbeResult::Ok(true)
		},
		b'h' | b'L' => stat(ctx, arg, false)?.is_some_and(|s| s.kind == StatKind::Symlink),
		_ => {
			let Some(s) = stat(ctx, arg, true)? else {
				return Ok(false);
			};
			let user = ctx.cx.host.user();
			match op {
				b'a' | b'e' => true,
				b'f' => s.kind == StatKind::File,
				b'd' => s.kind == StatKind::Dir,
				b'b' => s.kind == StatKind::BlockDev,
				b'c' => s.kind == StatKind::CharDev,
				b'p' => s.kind == StatKind::Fifo,
				b'S' => s.kind == StatKind::Socket,
				b's' => s.size > 0,
				b'g' => s.mode & 0o2000 != 0,
				b'u' => s.mode & 0o4000 != 0,
				b'k' => s.mode & 0o1000 != 0,
				b'O' => s.uid == user.euid,
				b'G' => s.gid == user.gid,
				b'N' => s.mtime_ns > s.atime_ns,
				_ => false,
			}
		},
	})
}

/// An integer operand of `test` (bash's `legal_number`: blanks allowed).
fn test_int(arg: &[u8]) -> T<i64> {
	number(arg).ok_or_else(|| integer_expected(arg))
}

/// A binary primary; `cond` selects `[[ ]]` semantics (patterns,
/// arithmetic operands).
fn binary(ctx: &mut Ctx<'_, '_>, op: &[u8], l: &[u8], r: &[u8], cond: bool) -> T<bool> {
	let int = |ctx: &mut Ctx<'_, '_>, s: &[u8]| -> T<i64> {
		if cond {
			arith_value(ctx.k, ctx.cx, ctx.vp, s).map_err(Fail::Arith)
		} else {
			test_int(s)
		}
	};
	Ok(match op {
		b"=" | b"==" | b"!=" => {
			let eq = if cond {
				let nocase = ctx.option(OptId::Nocasematch)?;
				// `[[ == ]]` always matches with extglob (bash sets
				// `extended_glob` around the comparison).
				let utf8 = crate::bash::vm::locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
				ctx.k
					.engine
					.patterns()
					.get(r, PatOpts::shell(true, nocase, utf8))
					.matches(l)
			} else {
				l == r
			};
			eq == (op != b"!=")
		},
		b"<" => l < r,
		b">" => l > r,
		b"-eq" | b"-ne" | b"-lt" | b"-le" | b"-gt" | b"-ge" => {
			let (a, b) = (int(ctx, l)?, int(ctx, r)?);
			match op {
				b"-eq" => a == b,
				b"-ne" => a != b,
				b"-lt" => a < b,
				b"-le" => a <= b,
				b"-gt" => a > b,
				_ => a >= b,
			}
		},
		b"-nt" | b"-ot" => {
			let (a, b) = (stat(ctx, l, true)?, stat(ctx, r, true)?);
			let (a, b) = if op == b"-nt" { (a, b) } else { (b, a) };
			match (a, b) {
				(Some(a), Some(b)) => a.mtime_ns > b.mtime_ns,
				(Some(_), None) => true,
				_ => false,
			}
		},
		b"-ef" => match (stat(ctx, l, true)?, stat(ctx, r, true)?) {
			(Some(a), Some(b)) => a.dev == b.dev && a.ino == b.ino,
			_ => false,
		},
		_ => return Err(syntax(format!("{}: binary operator expected", op.as_bstr()))),
	})
}

/// `[[ s =~ re ]]`: an ERE match (`nocasematch` ignores case) that sets
/// `BASH_REMATCH` as bash's `sh_regmatch` does: whole match then groups,
/// unset groups empty, emptied when nothing matches.
fn regex_match(ctx: &mut Ctx<'_, '_>, s: &[u8], re: &[u8]) -> T<bool> {
	const NAME: &[u8] = b"BASH_REMATCH";
	let icase = ctx.option(OptId::Nocasematch)?;
	let regex = Regex::new(re, icase)
		.map_err(|err| Fail::Syntax(Diag::InvalidRegex { pattern: re.into(), err }))?;
	let caps = regex.captures(s);
	let cur = ctx.var(NAME)?;
	match &cur {
		Some(v) if v.attrs.contains(Attrs::READONLY) => {
			ctx.diag(Diag::Readonly { name: NAME.into() });
		},
		Some(Var { value: VarValue::Assoc(_), .. }) => {
			ctx.usage("BASH_REMATCH: not an indexed array");
		},
		_ => {
			let items: Vec<(i64, BString)> = caps
				.iter()
				.flatten()
				.zip(0..)
				.map(|(g, i)| (i, BString::from(g.clone().map_or_default(|g| &s[g]))))
				.collect();
			let attrs = cur.as_ref().map_or(Attrs::NONE, |v| v.attrs);
			ctx.set_var(NAME, Some(Var { attrs, value: VarValue::Indexed(items) }), Level::Dynamic);
		},
	}
	Ok(caps.is_some())
}

/// What the `test` grammar evaluates its primaries with.
trait Primaries {
	/// A unary primary `-op arg`.
	fn unary(&mut self, op: u8, arg: &[u8]) -> T<bool>;
	/// A binary primary `l op r`.
	fn binary(&mut self, op: &[u8], l: &[u8], r: &[u8]) -> T<bool>;
	/// Whether POSIX mode is on (`-t` then always takes an operand).
	fn posix(&mut self) -> T<bool>;
}

impl Primaries for Ctx<'_, '_> {
	fn unary(&mut self, op: u8, arg: &[u8]) -> T<bool> {
		unary(self, op, arg, false)
	}

	fn binary(&mut self, op: &[u8], l: &[u8], r: &[u8]) -> T<bool> {
		binary(self, op, l, r, false)
	}

	fn posix(&mut self) -> T<bool> {
		Ok(self.option(OptId::Posix)?)
	}
}

/// bash's `test` parser over the arguments after the command name. For
/// `[`, `argv` keeps the closing `]` just past `argc`, which bash's
/// ``"`)' expected, found ]"`` names.
struct Test<'x, P: ?Sized> {
	prim:  &'x mut P,
	argv:  &'x [BString],
	argc:  usize,
	pos:   usize,
	/// Parenthesis nesting, bounded by [`MAX_NESTING`]. A chain of one
	/// operator does not count: it costs no stack.
	depth: u32,
}

/// Run the `test` grammar over `argv[..argc]` (bash's `test_command`):
/// `Ok(None)` when arguments are left over ("too many arguments").
fn test_command<P: Primaries + ?Sized>(
	prim: &mut P,
	argv: &[BString],
	argc: usize,
) -> T<Option<bool>> {
	if argc == 0 {
		return Ok(Some(false));
	}
	let mut t = Test { prim, argv, argc, pos: 0, depth: 0 };
	let v = t.posixtest(argc)?;
	if t.pos == argc {
		return Ok(Some(v));
	}
	match t.at(t.pos) {
		Some(a) if t.pos < argc && a.starts_with(b"-") => {
			Err(syntax(format!("syntax error: `{}' unexpected", a.as_bstr())))
		},
		_ => Ok(None),
	}
}

impl<'x, P: Primaries + ?Sized> Test<'x, P> {
	/// Argument `i`; `None` past the end (bash's NULL).
	fn at(&self, i: usize) -> Option<&'x [u8]> {
		let argv: &'x [BString] = self.argv;
		argv.get(i).map(|a| a.as_slice())
	}

	/// Argument `i`, empty past the end.
	fn arg(&self, i: usize) -> &'x [u8] {
		self.at(i).unwrap_or_default()
	}

	/// bash's `advance(f)`: past the end is "argument expected" when `check`.
	fn advance(&mut self, check: bool) -> T<()> {
		self.pos += 1;
		if check && self.pos >= self.argc {
			return Err(syntax("argument expected"));
		}
		Ok(())
	}

	fn expr(&mut self) -> T<bool> {
		if self.pos >= self.argc {
			return Err(syntax("argument expected"));
		}
		self.or()
	}

	/// bash's `or_`. bash recurses once per `-o`, which costs one stack
	/// frame per operator; the chain is folded here instead, so its length
	/// is bounded only by the argument list. Every term is still evaluated,
	/// left to right, as bash's `or_` does: the operator does not
	/// short-circuit, so an error in a later term is still reported.
	fn or(&mut self) -> T<bool> {
		let mut v = self.and()?;
		while self.pos < self.argc && self.arg(self.pos) == b"-o" {
			self.advance(false)?;
			let r = self.and()?;
			v = v || r;
		}
		Ok(v)
	}

	/// bash's `and_`, folded like [`Test::or`] and evaluating every term.
	fn and(&mut self) -> T<bool> {
		let mut v = self.term()?;
		while self.pos < self.argc && self.arg(self.pos) == b"-a" {
			self.advance(false)?;
			let r = self.term()?;
			v = v && r;
		}
		Ok(v)
	}

	/// Run `f` one parenthesis level deeper. Parentheses are real nesting,
	/// not a chain, so they keep the parser's [`MAX_NESTING`] policy: past
	/// the limit the expression is a usage error rather than a stack
	/// overflow that takes the host process down.
	fn nested<V>(&mut self, f: impl FnOnce(&mut Self) -> T<V>) -> T<V> {
		if self.depth >= MAX_NESTING {
			return Err(syntax("maximum nesting level exceeded"));
		}
		self.depth += 1;
		let r = f(self);
		self.depth -= 1;
		r
	}

	fn term(&mut self) -> T<bool> {
		if self.pos >= self.argc {
			return Err(syntax("argument expected"));
		}
		if self.arg(self.pos) == b"!" {
			let mut negate = false;
			while self.pos < self.argc && self.arg(self.pos) == b"!" {
				self.advance(true)?;
				negate = !negate;
			}
			return Ok(self.term()? != negate);
		}
		if self.arg(self.pos) == b"(" {
			self.advance(true)?;
			// Find the matching `)`: a parenthesized expression of 1–4
			// arguments uses the POSIX rules.
			let (mut nargs, mut count) = (1, 1);
			while self.pos + nargs < self.argc {
				match self.arg(self.pos + nargs) {
					b")" => count -= 1,
					b"(" => count += 1,
					_ => {},
				}
				if count == 0 {
					break;
				}
				nargs += 1;
			}
			let v = self.nested(|t| {
				if t.pos + nargs < t.argc && nargs <= 4 {
					t.posixtest(nargs)
				} else {
					t.expr()
				}
			})?;
			match self.at(self.pos) {
				None => return Err(syntax("`)' expected")),
				Some(a) if a != b")" => {
					return Err(syntax(format!("`)' expected, found {}", a.as_bstr())));
				},
				Some(_) => {},
			}
			self.advance(false)?;
			return Ok(v);
		}
		if self.pos + 3 <= self.argc && is_binop(self.arg(self.pos + 1)) {
			return self.binary_operator();
		}
		if self.pos + 2 <= self.argc && is_unary(self.arg(self.pos)) {
			return self.unary_operator();
		}
		let v = !self.arg(self.pos).is_empty();
		self.advance(false)?;
		Ok(v)
	}

	fn binary_operator(&mut self) -> T<bool> {
		let (l, op, r) = (self.arg(self.pos), self.arg(self.pos + 1), self.arg(self.pos + 2));
		if !is_binop(op) {
			return Err(syntax(format!("{}: binary operator expected", op.as_bstr())));
		}
		let v = self.prim.binary(op, l, r)?;
		self.pos += 3;
		Ok(v)
	}

	fn unary_operator(&mut self) -> T<bool> {
		let op = self.arg(self.pos);
		// `-t` may stand alone (fd 1) outside POSIX mode.
		if op == b"-t" && !self.prim.posix()? {
			self.advance(false)?;
			let Some(a) = self.at(self.pos).filter(|_| self.pos < self.argc) else {
				return self.prim.unary(b't', b"1");
			};
			if number(a).is_some() {
				self.advance(false)?;
				return self.prim.unary(b't', a);
			}
			if self.argc >= 5 && is_andor(a) {
				return self.prim.unary(b't', b"1");
			}
			return Err(integer_expected(a));
		}
		self.advance(true)?;
		self.pos += 1;
		self.prim.unary(op[1], self.arg(self.pos - 1))
	}

	fn two_arguments(&mut self) -> T<bool> {
		let a = self.arg(self.pos);
		if a == b"!" {
			self.advance(false)?;
			let v = self.arg(self.pos).is_empty();
			self.pos += 1;
			return Ok(v);
		}
		if is_unary(a) {
			return self.unary_operator();
		}
		Err(syntax(format!("{}: unary operator expected", a.as_bstr())))
	}

	fn three_arguments(&mut self) -> T<bool> {
		let (a, op, b) = (self.arg(self.pos), self.arg(self.pos + 1), self.arg(self.pos + 2));
		if is_binop(op) {
			return self.binary_operator();
		}
		if is_andor(op) {
			self.pos += 3;
			return Ok(if op == b"-a" {
				!a.is_empty() && !b.is_empty()
			} else {
				!a.is_empty() || !b.is_empty()
			});
		}
		if a == b"!" {
			self.advance(true)?;
			return Ok(!self.two_arguments()?);
		}
		if a == b"(" && b == b")" {
			self.advance(false)?;
			let v = !self.arg(self.pos).is_empty();
			self.pos += 2;
			return Ok(v);
		}
		Err(syntax(format!("{}: binary operator expected", op.as_bstr())))
	}

	/// bash's `posixtest`: the POSIX rules for 0–4 arguments, else the
	/// full grammar.
	fn posixtest(&mut self, nargs: usize) -> T<bool> {
		match nargs {
			0 => Ok(false),
			1 => {
				// bash tests `argv[1]` here, even inside parentheses.
				let v = !self.arg(0).is_empty();
				self.advance(false)?;
				Ok(v)
			},
			2 => self.two_arguments(),
			3 => self.three_arguments(),
			4 if self.arg(self.pos) == b"!" => {
				self.advance(true)?;
				Ok(!self.three_arguments()?)
			},
			4 if self.arg(self.pos) == b"(" && self.arg(self.pos + 3) == b")" => {
				self.advance(true)?;
				let v = self.two_arguments()?;
				self.advance(false)?;
				Ok(v)
			},
			_ => self.expr(),
		}
	}
}

/// `test expr` / `[ expr ]`.
pub fn test(ctx: &mut Ctx<'_, '_>, args: &[BString], bracket: bool) -> R {
	let argc = if bracket {
		match args.last() {
			Some(last) if last.as_slice() == b"]" => args.len() - 1,
			_ => {
				ctx.usage("missing `]'");
				return done(2);
			},
		}
	} else {
		args.len()
	};
	match test_command(&mut *ctx, args, argc) {
		Ok(Some(v)) => done(i32::from(!v)),
		Ok(None) => {
			ctx.diag(Diag::TooManyArgs { cmd: ctx.name.into() });
			done(2)
		},
		Err(Fail::Need(n)) => Err(n),
		Err(Fail::Syntax(d) | Fail::Arith(d)) => {
			ctx.err(d);
			done(2)
		},
		Err(Fail::Discard(d)) => {
			ctx.diag(d);
			Ok(super::Outcome { status: 1, control: super::Control::DiscardAll })
		},
	}
}

/// `CondTest`: one `[[ ]]` primary; `$?` = 0 when true, 1 when false or
/// an arithmetic operand failed, 2 on a usage error.
pub fn cond_test(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let c = &unit.conds[op.a as usize];
	let pair: [u32; 2];
	let words: &[u32] = match c {
		CondIr::Unary { arg, .. } => std::slice::from_ref(arg),
		CondIr::Binary { lhs, rhs, .. } => {
			pair = [*lhs, *rhs];
			&pair
		},
		CondIr::Word(w) => std::slice::from_ref(w),
	};
	let record = words.iter().any(|&w| unit.words[w as usize].parks);
	let rhs_op: &[u8] = match c {
		CondIr::Binary { op, .. } => op.as_slice(),
		_ => &[],
	};
	// bash's `cond_expand_word (w, 3)` (`Q_ARITH`): arithmetic operands and
	// `-v`'s operand keep their subscripts' expansions backslash-quoted.
	let arith_operands = match c {
		CondIr::Binary { op, .. } => {
			matches!(op.as_slice(), b"-eq" | b"-ne" | b"-lt" | b"-le" | b"-gt" | b"-ge")
		},
		CondIr::Unary { op, .. } => op.as_slice() == b"-v",
		CondIr::Word(_) => false,
	};
	let vals = match expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		// `[[ -v a[$k] ]]` under `assoc_expand_once` uses the key as
		// expanded here (bash 5.3.20 finds `a[$k]` with `k='$(cmd)'`).
		let quote = !(matches!(c, CondIr::Unary { .. })
			&& crate::bash::vm::state::option(
				&mut ex.k.root,
				ex.cx.store,
				ex.vp,
				OptId::AssocExpandOnce,
			)?);
		let mut vals = Vec::with_capacity(2);
		for (i, &w) in words.iter().enumerate() {
			let word = &unit.words[w as usize];
			vals.push(match rhs_op {
				b"=" | b"==" | b"!=" if i == 1 => ex.pattern(unit, word)?,
				b"=~" if i == 1 => ex.regex(unit, word)?,
				_ if arith_operands => ex.arith_operand(unit, word, quote)?,
				_ => ex.scalar(unit, word)?,
			});
		}
		Ok(vals)
	}) {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	// `set -x`: bash shows a pattern operand with its quoting as
	// backslashes (`[[ b == c\* ]]`), which is how it is expanded here.
	if crate::bash::vm::xtrace::on(k, cx, vp) {
		let mut terms: Vec<&[u8]> = match c {
			CondIr::Unary { op, .. } => vec![op.as_slice(), vals[0].as_slice()],
			CondIr::Binary { op, .. } => {
				vec![vals[0].as_slice(), op.as_slice(), vals[1].as_slice()]
			},
			CondIr::Word(_) => vec![b"-n".as_slice(), vals[0].as_slice()],
		};
		// An odd run of `!` directly on the primary (`[[ ! x ]]` →
		// `[[ ! -n x ]]`).
		if op.flags & crate::bash::ir::Op::NEGATED != 0 {
			terms.insert(0, b"!");
		}
		crate::bash::vm::xtrace::cond(k, cx, vp, line, &terms);
	}
	loop {
		let mut sc = vp
			.frames
			.last_mut()
			.and_then(|f| f.scratch.take())
			.unwrap_or_default();
		let (res, chunks) = {
			let mut ctx = Ctx::new(k, cx, vp, sc.probes(), line, "[[");
			let res = match c {
				CondIr::Unary { op, .. } if is_unary(op) => unary(&mut ctx, op[1], &vals[0], true),
				CondIr::Unary { op, .. } => {
					Err(syntax(format!("{}: unary operator expected", op.as_bstr())))
				},
				CondIr::Binary { op, .. } if op.as_slice() == b"=~" => {
					regex_match(&mut ctx, &vals[0], &vals[1])
				},
				CondIr::Binary { op, .. } => binary(&mut ctx, op, &vals[0], &vals[1], true),
				CondIr::Word(_) => Ok(!vals[0].is_empty()),
			};
			(res, std::mem::take(&mut ctx.chunks))
		};
		match res {
			Ok(v) => {
				report(k, cx, vp, line, chunks);
				vp.status = i32::from(!v);
				break;
			},
			Err(Fail::Syntax(d)) => {
				report(k, cx, vp, line, chunks);
				k.diag(cx, vp, line, d.by("[["));
				vp.status = 2;
				break;
			},
			Err(Fail::Discard(d)) => {
				report(k, cx, vp, line, chunks);
				k.diag(cx, vp, line, d);
				return Flow::Discard(1);
			},
			Err(Fail::Arith(d)) => {
				report(k, cx, vp, line, chunks);
				let d = if matches!(d, Diag::Readonly { .. }) {
					d
				} else {
					d.by("[[")
				};
				k.diag(cx, vp, line, d);
				vp.status = 1;
				break;
			},
			Err(Fail::Need(Need::Probe(p))) => match probe::perform(k, cx, vp, &mut sc, &p) {
				Ok(_) => {
					if let Some(f) = vp.frames.last_mut() {
						f.scratch = Some(sc);
					}
				},
				Err(key) => {
					if let Some(f) = vp.frames.last_mut() {
						f.scratch = Some(sc);
					}
					return Flow::Block(key);
				},
			},
			Err(Fail::Need(Need::Store(e))) => {
				k.fail(e);
				return Flow::Discard(1);
			},
			Err(Fail::Need(Need::Park(key))) => {
				if let Some(f) = vp.frames.last_mut() {
					f.scratch = Some(sc);
				}
				return Flow::Block(key);
			},
			// Only builtins expand subscripts through `Ctx`; a `[[ ]]`
			// primary never parks.
			Err(Fail::Need(Need::Sub(_))) => {
				if let Some(f) = vp.frames.last_mut() {
					f.scratch = Some(sc);
				}
				return Flow::Discard(1);
			},
		}
	}
	Flow::Next
}

/// Print what a `[[ ]]` primary queued.
fn report(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, chunks: Vec<Chunk>) {
	for chunk in chunks {
		match chunk {
			Chunk::Diag(d) => k.diag(cx, vp, line, d),
			Chunk::Out(fd, bytes) => {
				vp.out
					.push_back(PendingWrite { fd, bytes: bytes.into(), off: 0 });
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn operator_tables() {
		assert!(is_unary(b"-f") && is_unary(b"-v") && !is_unary(b"-q") && !is_unary(b"-ff"));
		assert!(is_binop(b"-nt") && is_binop(b"==") && !is_binop(b"-a") && !is_binop(b"=~"));
		assert!(is_andor(b"-o") && !is_andor(b"-n"));
	}

	/// String-only primaries (no files, no tty).
	struct Strings;

	impl Primaries for Strings {
		fn unary(&mut self, op: u8, arg: &[u8]) -> T<bool> {
			match op {
				b'z' => Ok(arg.is_empty()),
				b'n' => Ok(!arg.is_empty()),
				b't' => test_int(arg).map(|_| false),
				_ => Ok(false),
			}
		}

		fn binary(&mut self, op: &[u8], l: &[u8], r: &[u8]) -> T<bool> {
			Ok(match op {
				b"=" | b"==" => l == r,
				b"!=" => l != r,
				b"-eq" => test_int(l)? == test_int(r)?,
				b"-ne" => test_int(l)? != test_int(r)?,
				_ => false,
			})
		}

		fn posix(&mut self) -> T<bool> {
			Ok(false)
		}
	}

	/// `test ARGS` (or `[ ARGS ]`): the status and the message after
	/// `test: `.
	fn run(args: &[&str], bracket: bool) -> (i32, String) {
		let mut argv: Vec<BString> = args.iter().map(|a| BString::from(*a)).collect();
		let argc = argv.len();
		if bracket {
			argv.push(BString::from("]"));
		}
		match test_command(&mut Strings, &argv, argc) {
			Ok(Some(v)) => (i32::from(!v), String::new()),
			Ok(None) => (2, "too many arguments".to_owned()),
			Err(Fail::Syntax(d) | Fail::Arith(d) | Fail::Discard(d)) => (2, d.to_string()),
			Err(Fail::Need(_)) => unreachable!("string primaries need no probes"),
		}
	}

	// Goldens: bash 5.3.20 `test …; echo $?` (messages after `test: `).
	#[test]
	fn test_grammar_matches_bash() {
		let ok = |args: &[&str], status: i32| {
			assert_eq!(run(args, false), (status, String::new()), "{args:?}");
		};
		let err =
			|args: &[&str], msg: &str| assert_eq!(run(args, false), (2, msg.to_owned()), "{args:?}");
		err(&["1", "-eq", "1", "-ne", "2"], "syntax error: `-ne' unexpected");
		err(&["-t", "a"], "a: integer expected");
		err(&["-t", " "], " : integer expected");
		err(&["x", "-eq", "1"], "x: integer expected");
		ok(&["1", "-eq", " 1 "], 0);
		err(&["(", "1", "=", "2"], "`)' expected");
		assert_eq!(run(&["(", "1", "=", "2"], true), (2, "`)' expected, found ]".to_owned()));
		err(&["a", "-a"], "a: unary operator expected");
		err(&["a", "b"], "a: unary operator expected");
		err(&["(", ")"], "(: unary operator expected");
		err(&["-z", "a", "b"], "a: binary operator expected");
		err(&["a", "b", "c", "d", "e"], "too many arguments");
		err(&["-n", "xx", "-a", "-z", "", "-a", "-t", "0", "-t"], "syntax error: `-t' unexpected");
		err(&["-n", "xx", "-a", "-z", "", "-a", "-t", "0", "-a"], "argument expected");
		ok(&["-n"], 0);
		ok(&["!", "-n"], 1);
		ok(&["!", "a", "=", "b"], 0);
		ok(&["a", "=", "b", "-o", "c"], 0);
		ok(&["!", "!", "!", "a"], 1);
		// bash's parenthesized one-argument test reads `argv[1]`.
		ok(&["", "-o", "(", "x", ")"], 1);
		ok(&["(", "a", ")", "-a", "(", "", ")"], 0);
	}

	// Goldens: bash 5.3.20 `test 4+3 -eq 7`, `test ' ' -eq 1`.
	#[test]
	fn test_integers_allow_blanks_and_reject_words() {
		assert_eq!(test_int(b" 42 ").ok(), Some(42));
		let msg = |arg: &[u8]| match test_int(arg) {
			Err(Fail::Syntax(d)) => d.to_string(),
			_ => String::new(),
		};
		assert_eq!(msg(b"4+3"), "4+3: integer expected");
		assert_eq!(msg(b" "), " : integer expected");
	}
}
