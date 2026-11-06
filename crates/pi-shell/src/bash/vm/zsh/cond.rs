//! zsh conditional expressions: the primaries of `[[ ]]` in zsh-dialect
//! units (the `CondTest` op) and the zsh `test`/`[` builtin with its own
//! argument grammar.
//!
//! A port of zsh 5.9 `cond.c` (`evalcond`, `optison`, `doaccess`,
//! `getstat`), of the test-mode half of `parse.c`'s condition parser
//! (`par_cond`, `par_cond_1`, `par_cond_2`, `par_cond_double`,
//! `par_cond_triple`, `par_cond_multi`, `get_cond_num`), of `builtin.c`
//! `bin_test`/`testlex`. Statuses are zsh's: 0 true, 1 false, 2 error, 3
//! "no such option" from `-o`. Every other `-name` condition, and `=~`
//! (zsh/regex's `-regex-match`, zsh/pcre's `-pcre-match` under
//! `REMATCH_PCRE`), is a module condition: [`zsh_module::cond_module`]
//! finds (and autoloads) its module, `run_module_cond` runs it.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::{BString, ByteSlice};

use crate::bash::{
	diag::Diag,
	fs::{FileKind, Stat, StatKind},
	ir::{CondIr, Op as IrOp, Opcode, Part, Unit, Word},
	pattern::zsh::{Captures, PatFlags},
	syntax::zsh::{
		tok,
		tok::{span, tail},
	},
	vm::{
		Cx, Kernel,
		builtins::{
			Chunk, Ctx, Need, Outcome, R, done, zsh_args::zx as with_ex, zsh_mod_example,
			zsh_mod_pcre, zsh_mod_regex, zsh_module,
		},
		exec::{self, Flow, expanding},
		probe::{self, absolute},
		proc::{PendingWrite, Probe, ProbeResult, Slot, Vproc},
		xtrace,
		zsh::{arith, math::Number, subscript, zglob, zpattern},
	},
	zshopt::ZshOpt,
};

/// A condition operator (zsh's `COND_*` codes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CondOp {
	/// A unary primary `-c word` (`c` one of `abcdefgknoprstuvwxzhLONGS`).
	Unary(u8),
	/// `=` (`COND_STREQ`).
	StrEq,
	/// `==` (`COND_STRDEQ`).
	StrDeq,
	/// `!=` (`COND_STRNEQ`).
	StrNeq,
	/// `<` (`COND_STRLT`).
	StrLt,
	/// `>` (`COND_STRGTR`).
	StrGt,
	/// `-nt`.
	Nt,
	/// `-ot`.
	Ot,
	/// `-ef`.
	Ef,
	/// `-eq`.
	Eq,
	/// `-ne`.
	Ne,
	/// `-lt`.
	Lt,
	/// `-gt`.
	Gt,
	/// `-le`.
	Le,
	/// `-ge`.
	Ge,
	/// `=~` (`COND_REGEX`, zsh/regex's `-regex-match`).
	Regex,
}

/// Unary condition letters (`par_cond_double`).
const UNARY: &[u8] = b"abcdefgknoprstuvwxzhLONGS";

/// The unary operator `op` (`-c`), if it is one.
pub fn unary_op(op: &[u8]) -> Option<CondOp> {
	match op {
		[b'-', c] if UNARY.contains(c) => Some(CondOp::Unary(*c)),
		_ => None,
	}
}

/// zsh `get_cond_num`: `-nt … -ge` without the dash.
const fn cond_num(s: &[u8]) -> Option<CondOp> {
	Some(match s {
		b"nt" => CondOp::Nt,
		b"ot" => CondOp::Ot,
		b"ef" => CondOp::Ef,
		b"eq" => CondOp::Eq,
		b"ne" => CondOp::Ne,
		b"lt" => CondOp::Lt,
		b"gt" => CondOp::Gt,
		b"le" => CondOp::Le,
		b"ge" => CondOp::Ge,
		_ => return None,
	})
}

/// The binary operator `op`, if it is one (`par_cond_triple`; `<`/`>`
/// come from `[[ ]]`'s own tokens).
pub const fn binary_op(op: &[u8]) -> Option<CondOp> {
	Some(match op {
		b"=" => CondOp::StrEq,
		b"==" => CondOp::StrDeq,
		b"!=" => CondOp::StrNeq,
		b"<" => CondOp::StrLt,
		b">" => CondOp::StrGt,
		b"=~" => CondOp::Regex,
		[b'-', rest @ ..] => return cond_num(rest),
		_ => return None,
	})
}

/// text.c `is_cond_binary_op`.
const fn is_cond_binary_op(s: &[u8]) -> bool {
	matches!(s, b"=" | b"==" | b"!=" | b"<" | b">" | b"=~")
		|| matches!(s, [b'-', rest @ ..] if cond_num(rest).is_some())
}

/// What a primary came to.
enum Res {
	/// A zsh condition status (0 true, 1 false, 2 error, 3 bad option).
	St(i32),
	/// A zsh `zerr` (a math or parameter error): the command is abandoned.
	Zerr(Diag),
}

/// zsh `zwarnnam(fromtest, …)`: under the builtin's name for `test`/`[`,
/// bare for `[[ ]]`.
fn warn(ctx: &mut Ctx<'_, '_>, fromtest: bool, d: Diag) {
	if fromtest {
		ctx.err(d);
	} else {
		ctx.diag(d);
	}
}

/// zsh `getstat`/`dolstat`: the file's status, `None` when it cannot be
/// read.
fn getstat(ctx: &Ctx<'_, '_>, s: &[u8], follow: bool) -> Result<Option<Stat>, Need> {
	if s.is_empty() {
		return Ok(None);
	}
	let path = absolute(&ctx.vp.cwd, s);
	match ctx.probe(Probe::Stat { path, follow })? {
		ProbeResult::Stat(st) => Ok(st),
		_ => Ok(None),
	}
}

/// zsh `doaccess`: `access(2)` with mode bits `m` (1 read, 2 write, 4
/// execute; 0 existence).
fn doaccess(ctx: &Ctx<'_, '_>, s: &[u8], m: u8) -> Result<bool, Need> {
	if s.is_empty() {
		return Ok(false);
	}
	if m == 0 {
		return Ok(getstat(ctx, s, true)?.is_some());
	}
	let path = absolute(&ctx.vp.cwd, s);
	Ok(ctx.probe(Probe::Access { path, mode: m })? == ProbeResult::Ok(true))
}

/// zsh `optison`: the status of `-o NAME` (a single letter is a `set`
/// flag); an unknown option is false under `POSIX_BUILTINS`, else
/// `no such option` and status 3.
fn optison(ctx: &mut Ctx<'_, '_>, fromtest: bool, s: &[u8]) -> Result<i32, Need> {
	let found = if s.len() == 1 {
		ZshOpt::letter(s[0], ctx.vp.mode)
	} else {
		ZshOpt::lookup(s)
	};
	match found {
		None => {
			if ctx.zsh_option(ZshOpt::Posixbuiltins)? {
				Ok(1)
			} else {
				warn(ctx, fromtest, Diag::NoSuchOption { name: s.into() });
				Ok(3)
			}
		},
		Some((o, inverted)) => Ok(i32::from(ctx.zsh_option(o)? == inverted)),
	}
}

/// zsh `zstrtol(s, &e, 10)` over the whole text (`test`'s integer
/// operands): leading blanks and a sign allowed.
fn test_int(s: &[u8]) -> Option<i64> {
	let t = s.trim_start_with(|c| c == ' ' || c == '\t');
	let (neg, d) = match t.first() {
		Some(b'-') => (true, tail(t, 1)),
		Some(b'+') => (false, tail(t, 1)),
		_ => (false, t),
	};
	if !d.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let v = d
		.iter()
		.fold(0i64, |v, &c| v.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	Some(if neg { v.wrapping_neg() } else { v })
}

/// A condition a module provides (zsh's `COND_REGEX`, `COND_MODI`,
/// `COND_MOD`), by the name written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModCond<'a> {
	/// `l =~ r`: zsh/regex's `-regex-match`, or zsh/pcre's `-pcre-match`
	/// under `REMATCH_PCRE`.
	Regex,
	/// `l -name r` (`-name` with its dash).
	Infix(&'a [u8]),
	/// `-name arg…` (`-name` with its dash).
	Prefix(&'a [u8]),
}

/// The operand counts (`conddef`'s `min`, `max`) of the prefix conditions
/// zsh's modules define.
const fn prefix_arity(name: &[u8]) -> (usize, Option<usize>) {
	match name {
		b"len" | b"prefix" | b"suffix" => (1, Some(2)),
		b"after" => (1, Some(1)),
		b"between" => (2, Some(2)),
		_ => (0, None),
	}
}

/// `unknown condition: NAME`.
fn unknown(name: &[u8]) -> Diag {
	Diag::Usage { msg: format!("unknown condition: {}", name.as_bstr()).into() }
}

/// zsh `getconddef(infix, name, 1)`: the module providing condition
/// `-name`, autoloaded if need be.
fn conddef(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	infix: bool,
) -> Result<Result<Option<&'static str>, Diag>, Need> {
	with_ex(ctx, |ex| zsh_module::cond_module(ex, name, infix))
}

/// zsh `evalcond`'s `COND_REGEX`/`COND_MOD`/`COND_MODI` cases: find the
/// module condition `which` names (`args` its operands) and run it; when
/// no module provides it, retry with the first operand as a prefix
/// condition's name (`[[ -name -cond x ]]`) before `unknown condition`.
fn module_cond(
	ctx: &mut Ctx<'_, '_>,
	fromtest: bool,
	which: ModCond<'_>,
	args: &[BString],
) -> Result<Res, Need> {
	let (name, infix, regex): (Vec<u8>, bool, bool) = match which {
		ModCond::Regex => {
			let (module, feature): (&[u8], &[u8]) = if ctx.zsh_option(ZshOpt::Rematchpcre)? {
				(b"zsh/pcre", b"pcre-match")
			} else {
				(b"zsh/regex", b"regex-match")
			};
			// zsh ignores what `ensurefeature` returns; a failed load has
			// said why.
			if let Err(d) =
				with_ex(ctx, |ex| zsh_module::ensure_feature_ex(ex, module, b'C', feature))?
			{
				ctx.diag(d);
			}
			let mut name = b"-".to_vec();
			name.extend_from_slice(feature);
			(name, true, true)
		},
		ModCond::Infix(n) => (n.to_vec(), true, false),
		ModCond::Prefix(n) => (n.to_vec(), false, false),
	};
	let n = args.len();
	let fits = |cond: &[u8]| {
		let (min, max) = prefix_arity(cond);
		n >= min && max.is_none_or(|max| n <= max)
	};
	let bare = name.get(1..).unwrap_or_default();
	match conddef(ctx, bare, infix)? {
		Err(d) => return Ok(Res::Zerr(d)),
		Ok(Some(module)) => {
			if !infix && !fits(bare) {
				warn(ctx, fromtest, unknown(&name));
				return Ok(Res::St(2));
			}
			return run_module_cond(ctx, fromtest, module, bare, args);
		},
		Ok(None) => {},
	}
	if regex {
		// The standard regex condition is missing: a hard error.
		let d = Diag::Usage { msg: format!("{} not available for regex", name.as_bstr()).into() };
		return Ok(Res::Zerr(if fromtest { d.by(ctx.name) } else { d }));
	}
	if let Some(first) = args.first()
		&& let Some(cond) = first.strip_prefix(b"-")
	{
		match conddef(ctx, cond, false)? {
			Err(d) => return Ok(Res::Zerr(d)),
			Ok(Some(module)) => {
				if !fits(cond) {
					warn(ctx, fromtest, unknown(&name));
					return Ok(Res::St(2));
				}
				let mut strs = args.to_vec();
				strs[0] = BString::from(name);
				return run_module_cond(ctx, fromtest, module, cond, &strs);
			},
			Ok(None) => {},
		}
	}
	warn(ctx, fromtest, unknown(&name));
	Ok(Res::St(2))
}

/// Run condition `-name` of `module` (the conddef handlers) on `args`.
fn run_module_cond(
	ctx: &mut Ctx<'_, '_>,
	fromtest: bool,
	module: &str,
	name: &[u8],
	args: &[BString],
) -> Result<Res, Need> {
	let arg = |i: usize| args.get(i).map_or(&b""[..], |a| a.as_slice());
	let r = match (module, name) {
		("zsh/regex", b"regex-match") => zsh_mod_regex::cond_regex_match(ctx, arg(0), arg(1))?,
		("zsh/pcre", b"pcre-match") => zsh_mod_pcre::cond_pcre_match(ctx, arg(0), arg(1))?,
		("zsh/example", _) => with_ex(ctx, |ex| zsh_mod_example::cond(ex, name, args))?,
		("zsh/complete", _) => {
			with_ex(ctx, |ex| crate::bash::vm::zle::comp::complete::cond(ex, name, args))?
		},
		_ => {
			warn(ctx, fromtest, Diag::Unsupported {
				what: format!("condition `-{}' of module {module}", name.as_bstr()).into(),
			});
			return Ok(Res::St(2));
		},
	};
	Ok(match r {
		Ok(b) => Res::St(i32::from(!b)),
		Err(d) => Res::Zerr(d),
	})
}

/// `[[ l = pat ]]` (`=`, `==`, `!=`): `pat` is the tokenized, metafied
/// pattern (a literal for `test`); `(#b)`/`(#m)` set the match variables.
fn pattern_match(
	ctx: &mut Ctx<'_, '_>,
	fromtest: bool,
	op: CondOp,
	l: &[u8],
	pat: &[u8],
) -> Result<Res, Need> {
	let subject = tok::metafy(l);
	let r = with_ex(ctx, |ex| {
		let p = zpattern::compile(ex, pat, PatFlags::NONE)?;
		let env = zpattern::char_env(ex)?;
		let mut caps = Captures::default();
		let hit = p.try_match(&subject, &env.env(), Some(&mut caps)).is_some();
		if hit && (caps.whole.is_some() || caps.groups.is_some()) {
			zpattern::set_match_vars(ex, &subject, &caps)?;
		}
		Ok(hit)
	})?;
	Ok(match r {
		Ok(hit) => Res::St(i32::from(hit == (op == CondOp::StrNeq))),
		Err(d @ Diag::BadPattern { .. }) => {
			warn(ctx, fromtest, d);
			Res::St(2)
		},
		Err(d) => Res::Zerr(d),
	})
}

/// A numeric comparison of doubles, exact as in C.
fn float_cmp(op: CondOp, a: f64, b: f64) -> bool {
	match op {
		CondOp::Eq => a == b,
		CondOp::Ne => a != b,
		CondOp::Lt => a < b,
		CondOp::Gt => a > b,
		CondOp::Le => a <= b,
		_ => a >= b,
	}
}

/// zsh `evalcond` for one primary `l op r` (`r` empty for unary ones).
#[expect(clippy::too_many_lines, reason = "one switch, as zsh's evalcond")]
fn primary(
	ctx: &mut Ctx<'_, '_>,
	fromtest: bool,
	op: CondOp,
	l: &[u8],
	r: &[u8],
) -> Result<Res, Need> {
	use CondOp as C;
	let st = |b: bool| -> Result<Res, Need> { Ok(Res::St(i32::from(!b))) };
	match op {
		C::Eq | C::Ne | C::Lt | C::Gt | C::Le | C::Ge => {
			let (a, b) = if fromtest {
				let Some(a) = test_int(l) else {
					warn(ctx, true, Diag::Usage {
						msg: format!("integer expression expected: {}", l.as_bstr()).into(),
					});
					return Ok(Res::St(2));
				};
				let Some(b) = test_int(r) else {
					warn(ctx, true, Diag::Usage {
						msg: format!("integer expression expected: {}", r.as_bstr()).into(),
					});
					return Ok(Res::St(2));
				};
				(Number::Int(a), Number::Int(b))
			} else {
				// `[[ ]]` operands are arithmetic expressions.
				let (lt, rt) = (tok::metafy(l), tok::metafy(r));
				let v = with_ex(ctx, |ex| Ok((arith::matheval(ex, &lt)?, arith::matheval(ex, &rt)?)))?;
				match v {
					Ok(v) => v,
					Err(d) => return Ok(Res::Zerr(d)),
				}
			};
			if let (Number::Int(a), Number::Int(b)) = (a, b) {
				return st(match op {
					C::Eq => a == b,
					C::Ne => a != b,
					C::Lt => a < b,
					C::Gt => a > b,
					C::Le => a <= b,
					_ => a >= b,
				});
			}
			// Mixed operands are promoted to floats.
			st(float_cmp(op, a.to_float(), b.to_float()))
		},
		C::StrEq | C::StrDeq | C::StrNeq => {
			let pat = if fromtest { tok::metafy(r) } else { r.to_vec() };
			pattern_match(ctx, fromtest, op, l, &pat)
		},
		C::StrLt => st(l < r),
		C::StrGt => st(l > r),
		C::Regex => module_cond(ctx, fromtest, ModCond::Regex, &[BString::from(l), BString::from(r)]),
		C::Nt | C::Ot => {
			let Some(a) = getstat(ctx, l, true)? else {
				return Ok(Res::St(1));
			};
			let Some(b) = getstat(ctx, r, true)? else {
				return Ok(Res::St(1));
			};
			st(if op == C::Nt {
				a.mtime_ns > b.mtime_ns
			} else {
				a.mtime_ns < b.mtime_ns
			})
		},
		C::Ef => {
			let Some(a) = getstat(ctx, l, true)? else {
				return Ok(Res::St(1));
			};
			let Some(b) = getstat(ctx, r, true)? else {
				return Ok(Res::St(1));
			};
			st(a.dev == b.dev && a.ino == b.ino)
		},
		C::Unary(c) => {
			let kind = |s: Option<Stat>, k: StatKind| s.is_some_and(|s| s.kind == k);
			match c {
				b'a' | b'e' => st(doaccess(ctx, l, 0)?),
				b'b' => st(kind(getstat(ctx, l, true)?, StatKind::BlockDev)),
				b'c' => st(kind(getstat(ctx, l, true)?, StatKind::CharDev)),
				b'd' => st(kind(getstat(ctx, l, true)?, StatKind::Dir)),
				b'f' => st(kind(getstat(ctx, l, true)?, StatKind::File)),
				b'p' => st(kind(getstat(ctx, l, true)?, StatKind::Fifo)),
				b'S' => st(kind(getstat(ctx, l, true)?, StatKind::Socket)),
				b'g' => st(getstat(ctx, l, true)?.is_some_and(|s| s.mode & 0o2000 != 0)),
				b'k' => st(getstat(ctx, l, true)?.is_some_and(|s| s.mode & 0o1000 != 0)),
				b'u' => st(getstat(ctx, l, true)?.is_some_and(|s| s.mode & 0o4000 != 0)),
				b's' => st(getstat(ctx, l, true)?.is_some_and(|s| s.size > 0)),
				b'h' | b'L' => st(getstat(ctx, l, false)?.is_some_and(|s| s.kind == StatKind::Symlink)),
				b'O' => {
					let euid = ctx.cx.host.user().euid;
					st(getstat(ctx, l, true)?.is_some_and(|s| s.uid == euid))
				},
				b'G' => {
					let gid = ctx.cx.host.user().gid;
					st(getstat(ctx, l, true)?.is_some_and(|s| s.gid == gid))
				},
				// True when the file was modified since it was last read.
				b'N' => match getstat(ctx, l, true)? {
					None => Ok(Res::St(1)),
					Some(s) => Ok(Res::St(i32::from(s.atime_ns > s.mtime_ns))),
				},
				b'n' => st(!l.is_empty()),
				b'z' => st(l.is_empty()),
				b'o' => Ok(Res::St(optison(ctx, fromtest, l)?)),
				b'r' => st(doaccess(ctx, l, 1)?),
				b'w' => st(doaccess(ctx, l, 2)?),
				b'x' => {
					if ctx.cx.host.user().euid == 0 {
						// zsh `privasserted`: any execute bit, or a directory.
						return st(getstat(ctx, l, true)?
							.is_some_and(|s| s.mode & 0o111 != 0 || s.kind == StatKind::Dir));
					}
					st(doaccess(ctx, l, 4)?)
				},
				b'v' => {
					let name = l.to_vec();
					match with_ex(ctx, |ex| subscript::issetvar(ex, &name))? {
						Ok(b) => st(b),
						Err(d) => Ok(Res::Zerr(d)),
					}
				},
				b't' => {
					let text = tok::metafy(l);
					let fd = match with_ex(ctx, |ex| arith::mathevali(ex, &text))? {
						Ok(fd) => fd,
						Err(d) => return Ok(Res::Zerr(d)),
					};
					st(i32::try_from(fd)
						.ok()
						.and_then(|fd| ctx.vp.fds.get(fd).and_then(crate::bash::fd::FdRef::kind))
						== Some(FileKind::Tty))
				},
				_ => {
					warn(ctx, fromtest, Diag::Usage { msg: "bad cond code".into() });
					Ok(Res::St(2))
				},
			}
		},
	}
}

/// `CondTest` in a zsh-dialect unit: one `[[ ]]` primary; `$?` is zsh's
/// condition status (0 true, 1 false, 2 error, 3 unknown `-o` option). A
/// math or parameter error abandons the command (zsh's `errflag`). Out of
/// line: the bash `CondTest` dispatch does not carry it.
#[inline(never)]
pub fn cond_test(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: IrOp,
	line: u32,
) -> Flow {
	let Some(c) = unit.conds.get(op.a as usize) else {
		return Flow::Discard(2);
	};
	let pair: [u32; 2];
	let (prim, words): (Result<CondOp, ModCond<'_>>, &[u32]) = match c {
		CondIr::Unary { op, arg } => {
			// A word of other than one part is `par_cond_multi`'s operand
			// list: a module condition even when named like `-f`.
			let single = unit
				.words
				.get(*arg as usize)
				.is_some_and(|w| w.parts.len() == 1);
			let prim = match unary_op(op) {
				Some(cop) if single => Ok(cop),
				_ => Err(ModCond::Prefix(op.as_slice())),
			};
			(prim, std::slice::from_ref(arg))
		},
		CondIr::Binary { op, lhs, rhs } => {
			pair = [*lhs, *rhs];
			(binary_op(op).ok_or(ModCond::Infix(op.as_slice())), &pair)
		},
		CondIr::Word(w) => (Ok(CondOp::Unary(b'n')), std::slice::from_ref(w)),
	};
	let record = words
		.iter()
		.any(|&w| unit.words.get(w as usize).is_some_and(|w| w.parks));
	let cop = match prim {
		Ok(cop) => cop,
		Err(m) => {
			// zsh `cond_str`: each operand is substituted, no more.
			let vals = match expanding(k, vp, cx, Slot::Words, record, line, |ex| {
				let mut vals = Vec::new();
				for &w in words {
					let Some(word) = unit.words.get(w as usize) else {
						continue;
					};
					if let ModCond::Prefix(n) = &m {
						// zsh/complete's conditions take their operands
						// with `cond_str(…, raw)`: patterns keep their tokens.
						let raw = matches!(*n, b"-prefix" | b"-suffix" | b"-after" | b"-between");
						for p in &word.parts {
							let one = Word { parts: vec![p.clone()], kind: word.kind, ..Word::default() };
							vals.push(if raw {
								ex.pattern(unit, &one)?
							} else {
								ex.scalar(unit, &one)?
							});
						}
					} else {
						vals.push(ex.scalar(unit, word)?);
					}
				}
				Ok(vals)
			}) {
				Ok(v) => v,
				Err(flow) => return flow,
			};
			// zsh `tracemodcond`: the operands as written.
			let regex_name = regex_cond_name(k, vp, cx);
			trace(k, vp, cx, unit, op, |_, out| match &m {
				ModCond::Regex => {
					out.push(b' ');
					out.extend_from_slice(exec::word_source(unit, words[0]));
					out.extend_from_slice(regex_name);
					out.extend_from_slice(exec::word_source(unit, words[1]));
				},
				ModCond::Prefix(name) => {
					out.push(b' ');
					out.extend_from_slice(name);
					for &w in words {
						out.push(b' ');
						out.extend_from_slice(exec::word_source(unit, w));
					}
				},
				ModCond::Infix(name) => {
					out.push(b' ');
					out.extend_from_slice(exec::word_source(unit, words[0]));
					out.push(b' ');
					out.extend_from_slice(name);
					out.push(b' ');
					out.extend_from_slice(exec::word_source(unit, words[1]));
				},
			});
			return eval_primary(k, vp, cx, line, |ctx| module_cond(ctx, false, m, &vals));
		},
	};
	let pattern = matches!(cop, CondOp::StrEq | CondOp::StrDeq | CondOp::StrNeq);
	// zsh `cond_subst`: an operand ending in `(#q…)` (the left one, the
	// right one of a non-pattern binary) is filename-generated; `=~` is a
	// module condition, whose operands are only substituted.
	let (mut vals, globbed) = match expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut vals = Vec::with_capacity(2);
		let mut globbed = Vec::new();
		for (i, &w) in words.iter().enumerate() {
			let Some(word) = unit.words.get(w as usize) else {
				vals.push(BString::default());
				continue;
			};
			if cop != CondOp::Regex
				&& (i == 0 || !pattern)
				&& let [Part::Zsh(t)] = word.parts.as_slice()
				&& zglob::cond_globqual(ex, t)?
			{
				let mut fields = Vec::new();
				let mut globs = Vec::new();
				ex.fields_glob(unit, word, &mut fields, &mut globs)?;
				globbed.push((i, fields, globs));
				vals.push(BString::default());
				continue;
			}
			vals.push(if i == 1 && pattern {
				ex.pattern(unit, word)?
			} else {
				ex.scalar(unit, word)?
			});
		}
		Ok((vals, globbed))
	}) {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	for (i, mut fields, globs) in globbed {
		if !globs.is_empty()
			&& let Err(flow) = zglob::expand_globs(k, vp, cx, &mut fields, &globs, line)
		{
			return flow;
		}
		if let Some(v) = vals.get_mut(i) {
			*v = bstr::join(" ", fields).into();
		}
	}
	let lhs: &[u8] = vals.first().map_or(b"", |v| v.as_slice());
	let rhs: &[u8] = vals.get(1).map_or(b"", |v| v.as_slice());
	let regex_name = if cop == CondOp::Regex {
		regex_cond_name(k, vp, cx)
	} else {
		b""
	};
	trace(k, vp, cx, unit, op, |q, out| match (cop, c) {
		// `=~` is zsh/regex's (zsh/pcre's) module condition: traced as
		// one (`tracemodcond`), the operands as written.
		(CondOp::Regex, _) => {
			out.push(b' ');
			out.extend_from_slice(exec::word_source(unit, words[0]));
			out.extend_from_slice(regex_name);
			out.extend_from_slice(exec::word_source(unit, words[1]));
		},
		(CondOp::Unary(ch), _) => {
			out.extend_from_slice(&[b' ', b'-', ch, b' ']);
			q.push(out, lhs);
		},
		(_, CondIr::Binary { op: name, .. }) => {
			out.push(b' ');
			q.push(out, lhs);
			out.push(b' ');
			out.extend_from_slice(name);
			out.push(b' ');
			if pattern {
				out.extend_from_slice(&xtrace::quote_tokenized(rhs));
			} else {
				q.push(out, rhs);
			}
		},
		_ => {},
	});
	eval_primary(k, vp, cx, line, |ctx| primary(ctx, false, cop, lhs, rhs))
}

/// The module condition `=~` is traced as (zsh `evalcond`'s
/// `overridename`), with the blanks around it.
fn regex_cond_name(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>) -> &'static [u8] {
	let pcre = crate::bash::vm::state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Rematchpcre)
		.unwrap_or(false);
	if pcre {
		b" -pcre-match "
	} else {
		b" -regex-match "
	}
}

/// zsh `evalcond`'s trace of a primary of a traced `[[ ]]`
/// (`tracingcond`, the line `execcond` began with `[[`): ` &&`/` ||` when
/// the primary starts the right operand of one (being evaluated), ` !` on a
/// negated primary, then what `body` writes. Once per primary (not again
/// when it runs again after a probe).
fn trace(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	op: IrOp,
	body: impl FnOnce(xtrace::ZshQuote, &mut Vec<u8>),
) {
	if !xtrace::on(k, cx, vp) {
		return;
	}
	let Some(top) = vp.frames.last() else {
		return;
	};
	if top
		.scratch
		.as_ref()
		.is_some_and(|sc| !sc.probes().is_empty() || sc.probing().is_some())
	{
		return;
	}
	let mut out = Vec::new();
	let prev = (top.pc as usize)
		.checked_sub(1)
		.and_then(|p| unit.ops.get(p));
	if let Some(prev) = prev.filter(|p| p.node == op.node) {
		match prev.code {
			Opcode::BrOk => out.extend_from_slice(b" ||"),
			Opcode::BrFail => out.extend_from_slice(b" &&"),
			_ => {},
		}
	}
	if op.flags & IrOp::NEGATED != 0 {
		out.extend_from_slice(b" !");
	}
	let q = xtrace::ZshQuote::of(k, cx, vp);
	body(q, &mut out);
	xtrace::write(k, cx, vp, out);
}

/// Evaluate one `[[ ]]` primary with `eval` (re-run after each probe it
/// needs) and settle its status.
fn eval_primary(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	mut eval: impl FnMut(&mut Ctx<'_, '_>) -> Result<Res, Need>,
) -> Flow {
	loop {
		let mut sc = vp
			.frames
			.last_mut()
			.and_then(|f| f.scratch.take())
			.unwrap_or_default();
		// A math function an operand called has returned: its value joins
		// the replay log.
		if let Some(flow) = exec::settle_sub(k, vp, cx, &mut sc, Slot::Builtin) {
			if let Some(f) = vp.frames.last_mut() {
				f.scratch = Some(sc);
			}
			return flow;
		}
		let log = std::mem::take(&mut sc.logs[Slot::Builtin as usize]);
		let (res, chunks, log) = {
			let mut ctx = Ctx::new(k, cx, vp, sc.probes(), line, "[[");
			ctx.log = log;
			let res = eval(&mut ctx);
			(res, std::mem::take(&mut ctx.chunks), std::mem::take(&mut ctx.log))
		};
		sc.logs[Slot::Builtin as usize] = log;
		let park = |vp: &mut Vproc, sc| {
			if let Some(f) = vp.frames.last_mut() {
				f.scratch = Some(sc);
			}
		};
		match res {
			Ok(Res::St(s)) => {
				report(k, cx, vp, line, chunks);
				vp.status = s;
				// zsh `execcond`: status 2 (a condition syntax error) is a
				// shell error. `!`, `&&` and `||` all pass a 2 through
				// unchanged, so it is final here.
				return if s == 2 { Flow::Discard(2) } else { Flow::Next };
			},
			Ok(Res::Zerr(d)) => {
				report(k, cx, vp, line, chunks);
				k.diag(cx, vp, line, d);
				return Flow::Discard(1);
			},
			Err(Need::Probe(p)) => match probe::perform(k, cx, vp, &mut sc, &p) {
				Ok(_) => park(vp, sc),
				Err(key) => {
					park(vp, sc);
					return Flow::Block(key);
				},
			},
			Err(Need::Store(e)) => {
				k.fail(e);
				return Flow::Discard(1);
			},
			Err(Need::Park(key)) => {
				park(vp, sc);
				return Flow::Block(key);
			},
			// An arithmetic operand's math function: its call runs above,
			// then the primary replays.
			Err(Need::Sub(crate::bash::vm::expand::Stop::MathCall(call))) => {
				let fi = vp.frames.len() - 1;
				let flow = crate::bash::vm::command::start_math_call(
					k,
					vp,
					cx,
					&mut sc,
					Slot::Builtin,
					&call,
					line,
				);
				vp.frames[fi].scratch = Some(sc);
				return flow;
			},
			// The operands are expanded: nothing left to substitute.
			Err(Need::Sub(_)) => {
				park(vp, sc);
				return Flow::Discard(1);
			},
		}
	}
}

/// Print what a primary queued.
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

/// A parsed `test` expression (zsh's condition wordcode).
#[derive(Debug, PartialEq, Eq)]
enum Node {
	Not(Box<Self>),
	And(Box<Self>, Box<Self>),
	Or(Box<Self>, Box<Self>),
	Prim {
		op: CondOp,
		l:  BString,
		r:  BString,
	},
	/// A module condition: `l -name r` (`COND_MODI`, `infix`) or `-name
	/// args…` (`COND_MOD`).
	Mod {
		name:  BString,
		infix: bool,
		args:  Vec<BString>,
	},
}

/// Tokens of `testlex`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tok {
	Null,
	LexErr,
	Dbar,
	Damper,
	Bang,
	Inpar,
	Outpar,
	Str,
}

/// Why the test grammar failed.
enum Perr {
	/// `YYERROR`: `parse error` or `argument expected`.
	Yy,
	/// `COND_ERROR`: zsh's message, printed without the command name.
	Cond(String),
}

/// zsh's test-mode condition parser over the `test` arguments.
struct TestParser<'a> {
	args:   &'a [BString],
	/// `testargs`: the next argument to read.
	pos:    usize,
	/// `curtestarg`: the argument the current token came from.
	cur:    usize,
	tok:    Tok,
	tokstr: Option<&'a [u8]>,
	posix:  bool,
}

impl TestParser<'_> {
	/// zsh `testlex`.
	fn lex(&mut self) {
		if self.tok == Tok::LexErr {
			return;
		}
		self.cur = self.pos;
		self.tokstr = self.args.get(self.pos).map(|a| a.as_slice());
		let Some(a) = self.tokstr else {
			// Reading past the end is an error.
			self.tok = if self.tok == Tok::Null {
				Tok::LexErr
			} else {
				Tok::Null
			};
			return;
		};
		self.tok = match a {
			b"-o" => Tok::Dbar,
			b"-a" => Tok::Damper,
			b"!" => Tok::Bang,
			b"(" => Tok::Inpar,
			b")" => Tok::Outpar,
			_ => Tok::Str,
		};
		self.pos += 1;
	}

	/// The string of the current token (`tokstr`), empty at the end.
	fn s(&self) -> BString {
		self.tokstr.unwrap_or_default().into()
	}

	/// `par_cond`: `cond_1 [ -o cond ]`.
	fn cond(&mut self) -> Result<Node, Perr> {
		let r = self.cond_1()?;
		if self.tok == Tok::Dbar {
			self.lex();
			let rhs = self.cond()?;
			return Ok(Node::Or(Box::new(r), Box::new(rhs)));
		}
		Ok(r)
	}

	/// `par_cond_1`: `cond_2 [ -a cond_1 ]`.
	fn cond_1(&mut self) -> Result<Node, Perr> {
		let r = self.cond_2()?;
		if self.tok == Tok::Damper {
			self.lex();
			let rhs = self.cond_1()?;
			return Ok(Node::And(Box::new(r), Box::new(rhs)));
		}
		Ok(r)
	}

	/// `par_cond_2` in test mode (POSIX's rules by argument count first).
	fn cond_2(&mut self) -> Result<Node, Perr> {
		let n_testargs = self.args.len() - self.pos + 1;
		if self.tok == Tok::Null {
			return double(b"-n", b"");
		}
		if n_testargs == 1 {
			let s1 = self.s();
			self.lex();
			if !self.posix && s1.as_slice() == b"-t" {
				return double(&s1, b"1");
			}
			return double(b"-n", &s1);
		}
		if n_testargs > 2 {
			let next = self.args.get(self.pos).map_or(&[][..], |a| a.as_slice());
			if matches!(next, b"=" | b"==" | b"!=")
				|| matches!(next, [b'-', rest @ ..] if cond_num(rest).is_some())
			{
				let s1 = self.s();
				self.lex();
				let s2 = self.s();
				self.lex();
				let s3 = self.s();
				self.lex();
				return triple(&s1, &s2, &s3);
			}
		}
		if self.tok == Tok::Bang
			&& !(n_testargs > 2
				&& matches!(self.args.get(self.pos).map(|a| a.as_slice()), Some(b"-a" | b"-o")))
		{
			self.lex();
			return Ok(Node::Not(Box::new(self.cond_2()?)));
		}
		if self.tok == Tok::Inpar {
			self.lex();
			let r = self.cond()?;
			if self.tok != Tok::Outpar {
				self.tok = Tok::LexErr;
				return Err(Perr::Yy);
			}
			self.lex();
			return Ok(r);
		}
		let s1 = self.tokstr;
		let dble = s1.is_some_and(|s| s.len() == 2 && s[0] == b'-' && UNARY.contains(&s[1]));
		if self.tok != Tok::Str {
			if let Some(s1) = s1
				&& self.tok != Tok::LexErr
			{
				self.lex();
				return double(b"-n", s1);
			}
			self.tok = Tok::LexErr;
			return Err(Perr::Yy);
		}
		let s1 = s1.unwrap_or_default();
		self.lex();
		if n_testargs == 2
			&& self.tok != Tok::Str
			&& self.tokstr.is_some()
			&& s1.first() == Some(&b'-')
		{
			// `test -z` followed by a token: the token is a string.
			self.tok = Tok::Str;
		}
		if self.tok != Tok::Str {
			if self.tok != Tok::LexErr {
				return double(b"-n", s1);
			}
			return Err(Perr::Yy);
		}
		let s2 = self.s();
		self.lex();
		if self.tok == Tok::Str && !dble {
			let s3 = self.s();
			self.lex();
			if self.tok == Tok::Str {
				let mut l = vec![s2, s3];
				while self.tok == Tok::Str {
					l.push(self.s());
					self.lex();
				}
				return multi(s1, l);
			}
			return triple(s1, &s2, &s3);
		}
		double(s1, &s2)
	}
}

/// `par_cond_double`: `-c b`, or an unknown `-name b`.
fn double(a: &[u8], b: &[u8]) -> Result<Node, Perr> {
	if a.first() != Some(&b'-') || a.len() < 2 {
		return Err(Perr::Cond(format!("parse error: condition expected: {}", a.as_bstr())));
	}
	if a.len() == 2 && UNARY.contains(&a[1]) {
		return Ok(Node::Prim { op: CondOp::Unary(a[1]), l: b.into(), r: BString::default() });
	}
	Ok(Node::Mod { name: a.into(), infix: false, args: vec![b.into()] })
}

/// `par_cond_triple`: `a b c`.
fn triple(a: &[u8], b: &[u8], c: &[u8]) -> Result<Node, Perr> {
	if let Some(op) = binary_op(b).filter(|op| !matches!(op, CondOp::StrLt | CondOp::StrGt)) {
		return Ok(Node::Prim { op, l: a.into(), r: c.into() });
	}
	if b.first() == Some(&b'-') {
		return Ok(Node::Mod { name: b.into(), infix: true, args: vec![a.into(), c.into()] });
	}
	if a.first() == Some(&b'-') && a.len() > 1 {
		return Ok(Node::Mod { name: a.into(), infix: false, args: vec![b.into(), c.into()] });
	}
	Err(Perr::Cond(format!("condition expected: {}", b.as_bstr())))
}

/// `par_cond_multi`: `-name args…`.
fn multi(a: &[u8], args: Vec<BString>) -> Result<Node, Perr> {
	if a.first() != Some(&b'-') || a.len() < 2 {
		return Err(Perr::Cond(format!("condition expected: {}", a.as_bstr())));
	}
	Ok(Node::Mod { name: a.into(), infix: false, args })
}

/// zsh `evalcond` over a parsed `test` expression.
fn evalcond(ctx: &mut Ctx<'_, '_>, n: &Node) -> Result<Res, Need> {
	Ok(match n {
		Node::Not(c) => match evalcond(ctx, c)? {
			Res::St(s @ (0 | 1)) => Res::St(1 - s),
			r => r,
		},
		Node::And(a, b) => match evalcond(ctx, a)? {
			Res::St(0) => evalcond(ctx, b)?,
			r => r,
		},
		Node::Or(a, b) => match evalcond(ctx, a)? {
			Res::St(1 | 3) => evalcond(ctx, b)?,
			r => r,
		},
		Node::Prim { op, l, r } => primary(ctx, true, *op, l, r)?,
		Node::Mod { name, infix, args } => {
			let which = if *infix {
				ModCond::Infix(name.as_slice())
			} else {
				ModCond::Prefix(name.as_slice())
			};
			module_cond(ctx, true, which, args)?
		},
	})
}

/// zsh `bin_test`: `test expr` / `[ expr ]` (`bracket`) with zsh's test
/// grammar and messages.
pub fn test(ctx: &mut Ctx<'_, '_>, args: &[BString], bracket: bool) -> R {
	let mut argv = args;
	if bracket {
		match argv.split_last() {
			Some((last, rest)) if last.as_slice() == b"]" => argv = rest,
			_ => {
				ctx.usage("']' expected");
				return done(2);
			},
		}
	}
	if argv.is_empty() {
		return done(1);
	}
	let nargs = argv.len();
	let mut sense = false;
	if nargs == 3 || nargs == 4 {
		// Prefer a binary operator to parentheses.
		if argv[0].as_slice() == b"("
			&& argv[nargs - 1].as_slice() == b")"
			&& (nargs != 3 || !is_cond_binary_op(&argv[1]))
		{
			argv = span(argv, 1, nargs - 1);
		}
		if nargs == 4 && argv.first().is_some_and(|a| a.as_slice() == b"!") {
			sense = true;
			argv = tail(argv, 1);
		}
	}
	let posix = ctx.zsh_option(ZshOpt::Posixbuiltins)?;
	let mut p = TestParser { args: argv, pos: 0, cur: 0, tok: Tok::Null, tokstr: None, posix };
	p.lex();
	let node = match p.cond() {
		Ok(n) if p.tok != Tok::LexErr => n,
		Err(Perr::Cond(msg)) => {
			ctx.diag(Diag::Usage { msg: msg.into() });
			return done(2);
		},
		_ => {
			let msg = if p.tokstr.is_some() {
				"parse error"
			} else {
				"argument expected"
			};
			ctx.usage(msg);
			return done(2);
		},
	};
	if p.cur < argv.len() && p.tok != Tok::Null {
		ctx.usage("too many arguments");
		return done(2);
	}
	match evalcond(ctx, &node)? {
		Res::St(s) => done(if s < 2 && sense { 1 - s } else { s }),
		Res::Zerr(d) => {
			ctx.diag(d);
			Ok(Outcome { status: 1, control: crate::bash::vm::builtins::Control::DiscardAll })
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse(args: &[&str]) -> Result<(Node, bool), String> {
		let argv: Vec<BString> = args.iter().map(|a| BString::from(*a)).collect();
		let mut p = TestParser {
			args:   &argv,
			pos:    0,
			cur:    0,
			tok:    Tok::Null,
			tokstr: None,
			posix:  false,
		};
		p.lex();
		match p.cond() {
			Ok(n) if p.tok != Tok::LexErr => Ok((n, p.cur < argv.len() && p.tok != Tok::Null)),
			Err(Perr::Cond(m)) => Err(m),
			_ => Err(
				if p.tokstr.is_some() {
					"parse error"
				} else {
					"argument expected"
				}
				.into(),
			),
		}
	}

	fn prim(op: CondOp, l: &str, r: &str) -> Node {
		Node::Prim { op, l: l.into(), r: r.into() }
	}

	#[test]
	fn test_grammar_follows_posix_argument_counts() {
		assert_eq!(parse(&["foo"]).unwrap().0, prim(CondOp::Unary(b'n'), "foo", ""));
		assert_eq!(parse(&["-t"]).unwrap().0, prim(CondOp::Unary(b't'), "1", ""));
		assert_eq!(parse(&["!", "=", "!"]).unwrap().0, prim(CondOp::StrEq, "!", "!"));
		assert_eq!(parse(&["-z", "("]).unwrap().0, prim(CondOp::Unary(b'z'), "(", ""));
		assert_eq!(
			parse(&["!", "-a", "!"]).unwrap().0,
			Node::And(
				Box::new(prim(CondOp::Unary(b'n'), "!", "")),
				Box::new(prim(CondOp::Unary(b'n'), "!", ""))
			)
		);
	}

	#[test]
	fn test_grammar_reports_leftovers_and_errors() {
		assert!(parse(&["-n", "foo", "scrimble"]).unwrap().1);
		assert!(
			parse(&["-n", "foo", "-a", "-n", "bar", "scrimble"])
				.unwrap()
				.1
		);
		assert_eq!(parse(&["a", "b"]).unwrap_err(), "parse error: condition expected: a");
		assert_eq!(parse(&["x", "-q", "y"]).unwrap().0, Node::Mod {
			name:  "-q".into(),
			infix: true,
			args:  vec!["x".into(), "y".into()],
		});
		assert_eq!(parse(&["(", "a"]).unwrap_err(), "argument expected");
	}

	#[test]
	fn operators() {
		assert_eq!(binary_op(b"-nt"), Some(CondOp::Nt));
		assert_eq!(binary_op(b"-fail"), None);
		assert_eq!(unary_op(b"-v"), Some(CondOp::Unary(b'v')));
		assert_eq!(unary_op(b"-fail"), None);
		assert!(is_cond_binary_op(b"-eq"));
		assert!(!is_cond_binary_op(b"-a"));
	}
}
