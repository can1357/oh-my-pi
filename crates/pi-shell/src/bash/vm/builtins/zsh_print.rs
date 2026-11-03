//! zsh `print`, `echo`, `printf` and `pushln`: a port of zsh 5.9
//! `builtin.c` `bin_print` (escape processing through `getkeystring`, `-m`
//! filtering, `-o`/`-O` sorting, `-c`/`-C` columns, `-x`/`-X` tab
//! expansion, `-u`, `-v`, and the printf engine shared by `printf` and
//! `print -f`, with zsh's argument reuse, `%N$` specifiers, `%b %q %n`,
//! arithmetic numeric arguments and its messages).
//!
//! Not provided: `-P` (prompt expansion), `-z` (the ZLE buffer stack),
//! `-s`/`-S` (the history list) and `-p` (zsh coprocesses): they fail
//! loudly.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::{Func, Ops, isset, pattern_arg, zerr, zx},
	zsh_prompt::{self, PromptEnv},
	zsh_quote::{self, Charset, QuoteOpts},
};
use crate::bash::{
	diag::Diag,
	syntax::zsh::{
		tok,
		tok::{at, head, span, tail},
	},
	vm::{
		expand::{Expander, Stop, X},
		zsh::{
			arith,
			math::Number,
			params,
			text::{self, getkey},
		},
	},
	zshopt::ZshOpt,
};

/// zsh `getkeystring` over a builtin's raw argument `s`: the decoded raw
/// bytes, and whether a `\c` ended them.
fn getkeystring(s: &[u8], how: u32) -> (Vec<u8>, bool) {
	let k = text::getkeystring(&tok::metafy(s), how);
	(k.text, k.cut)
}

/// zsh `zstrtol(s, &end, 10)` with the whole text required: an optional
/// sign after leading blanks, then decimal digits.
fn strtol_all(s: &[u8]) -> Option<i64> {
	let t = s.trim_start_with(|c| c == ' ' || c == '\t');
	let (neg, d) = match t.first() {
		Some(b'-') => (true, tail(t, 1)),
		Some(b'+') => (false, tail(t, 1)),
		_ => (false, t),
	};
	if !d.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let mut v: i64 = 0;
	for &c in d {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
	}
	Some(if neg { v.wrapping_neg() } else { v })
}

/// The leading decimal number of `s` (C `strtoul(s, &end, 10)` for the
/// printf parser): value and digits used.
fn strtoul(s: &[u8]) -> (usize, usize) {
	let n = s.iter().take_while(|c| c.is_ascii_digit()).count();
	let v = head(s, n)
		.iter()
		.fold(0usize, |v, &c| v.saturating_mul(10).saturating_add(usize::from(c - b'0')));
	(v, n)
}

/// The character classification builtins use: `MULTIBYTE` in a UTF-8
/// locale, `PRINT_EIGHT_BIT`.
pub fn charset(ctx: &mut Ctx<'_, '_>) -> Result<Charset, super::Need> {
	let utf8 = isset(ctx, ZshOpt::Multibyte)?
		&& crate::bash::vm::locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
	Ok(Charset { utf8, print_eight: isset(ctx, ZshOpt::Printeightbit)? })
}

/// Number of characters of `s` (bytes outside UTF-8; an invalid byte
/// counts as one).
fn char_count(s: &[u8], utf8: bool) -> usize {
	if utf8 { s.chars().count() } else { s.len() }
}

/// Byte length of the first `n` characters of `s`.
fn char_prefix(s: &[u8], n: usize, utf8: bool) -> usize {
	if !utf8 {
		return n.min(s.len());
	}
	s.char_indices().nth(n).map_or(s.len(), |(i, ..)| i)
}

/// zsh `zexpandtabs`: write `s` with tabs expanded to `width` columns
/// (`all`: every tab, else only indentation), starting at column
/// `startpos`; the column after it.
fn zexpandtabs(
	s: &[u8],
	width: usize,
	mut startpos: usize,
	all: bool,
	utf8: bool,
	out: &mut Vec<u8>,
) -> usize {
	let mut at_start = true;
	let mut i = 0;
	while i < s.len() {
		match s[i] {
			b'\t' => {
				if all || at_start {
					if width == 0 || startpos.is_multiple_of(width) {
						out.push(b' ');
						startpos += 1;
					}
					if width > 0 {
						while !startpos.is_multiple_of(width) {
							out.push(b' ');
							startpos += 1;
						}
					}
				} else {
					startpos += width - startpos % width;
					out.push(b'\t');
				}
				i += 1;
				continue;
			},
			b'\n' | b'\r' => {
				out.push(s[i]);
				i += 1;
				startpos = 0;
				at_start = true;
				continue;
			},
			_ => {},
		}
		at_start = false;
		let n = if utf8 {
			bstr::decode_utf8(tail(s, i)).1.max(1)
		} else {
			1
		};
		out.extend_from_slice(span(s, i, i + n));
		startpos += 1;
		i += n;
	}
	startpos
}

/// The shell state `print -P` prompt escapes read.
fn prompt_env(ctx: &mut Ctx<'_, '_>) -> Result<Result<PromptEnv, Diag>, super::Need> {
	let site = ctx.k.zsh_site(ctx.cx, ctx.vp, ctx.line);
	let percent = isset(ctx, ZshOpt::Promptpercent)?;
	let bang = isset(ctx, ZshOpt::Promptbang)?;
	zx(ctx, |ex| prompt_env_ex(ex, site, percent, bang))
}

/// The shell state prompt escapes read (zsh `promptexpand`'s globals),
/// for `print -P` and `PS4`: `site` is zsh's `scriptname` and `lineno`,
/// `percent` and `bang` the `PROMPT_PERCENT` and `PROMPT_BANG` options.
///
/// # Errors
/// A store failure reading the parameters.
pub fn prompt_env_ex(
	ex: &mut Expander<'_, '_>,
	site: (BString, u32),
	percent: bool,
	bang: bool,
) -> X<PromptEnv> {
	let (scriptname, lineno) = site;
	let user = ex.cx.host.user();
	let now_ns = ex.cx.host.now_ns();
	let secs = i64::try_from(now_ns / 1_000_000_000).unwrap_or(i64::MAX);
	let nanos = u32::try_from(now_ns % 1_000_000_000).unwrap_or(0);
	let tz = params::getparam(ex, b"TZ")?
		.filter(|p| p.flags.bits() & super::zsh_typeset::PM_EXPORTED != 0)
		.map(|p| p.strval());
	let (offset, abbr) = ex.cx.host.tz_offset(tz.as_ref().map(|t| t.as_bstr()), secs);
	let shlvl = params::getsparam(ex, b"SHLVL")?
		.and_then(|v| v.to_str().ok().and_then(|s| s.trim().parse().ok()))
		.unwrap_or(0);
	Ok(PromptEnv {
		pwd: ex.vp.cwd.clone(),
		home: params::getsparam(ex, b"HOME")?,
		lastval: ex.vp.status,
		euid: user.euid,
		egid: user.gid,
		user: user.name,
		host: params::getsparam(ex, b"HOST")?,
		shlvl,
		psvar: params::getaparam(ex, b"psvar")?.unwrap_or_default(),
		depth: params::getaparam(ex, b"funcstack")?.map_or(0, |f| f.len()),
		lineno,
		scriptname,
		now: (secs, nanos, offset, abbr),
		percent,
		bang,
	})
}

/// zsh `promptexpand`'s `PROMPT_SUBST` step on raw `s`: its parameter,
/// command and arithmetic substitutions done; an error leaves the text as
/// it was (zsh ignores errors there).
///
/// # Errors
/// A command substitution to run first, a store failure.
pub fn prompt_subst(ex: &mut Expander<'_, '_>, s: &[u8]) -> X<Vec<u8>> {
	let Ok(t) = crate::bash::syntax::zsh::parsestr(&tok::metafy(s)) else {
		return Ok(s.to_vec());
	};
	match crate::bash::vm::zsh::subst::singsub(ex, t) {
		Ok(mut v) => {
			tok::untokenize(&mut v);
			Ok(tok::unmetafy(&v))
		},
		Err(Stop::Fail(_) | Stop::Fatal(_)) => Ok(s.to_vec()),
		Err(e) => Err(e),
	}
}

/// Where the output goes.
enum Sink {
	/// A file descriptor (`1`, or `-u N`).
	Fd(i32),
	/// A parameter (`-v NAME`).
	Var(BString),
}

/// zsh `bin_print` for `print`, `echo`, `printf` and `pushln` (`func`
/// selects the variant; `ops` are the parsed options).
#[expect(clippy::too_many_lines, reason = "one function, as zsh's bin_print")]
pub fn print(ctx: &mut Ctx<'_, '_>, ops: &mut Ops, args: &[BString], func: Func) -> R {
	let n = |o: &Ops, c: u8| u8::from(o.isset(c));
	if n(ops, b'z') + n(ops, b's') + n(ops, b'S') + n(ops, b'v') > 1 {
		ctx.usage("only one of -s, -S, -v, or -z allowed");
		return done(1);
	}
	let zss = ops.isset(b'z') || ops.isset(b's') || ops.isset(b'S');
	if u8::from(zss) + u8::from(ops.isset(b'c') || ops.isset(b'C')) > 1 {
		ctx.usage("-c or -C not allowed with -s, -S, or -z");
		return done(1);
	}
	if u8::from(zss || ops.isset(b'v')) + u8::from(ops.isset(b'p') || ops.isset(b'u')) > 1 {
		ctx.usage("-p or -u not allowed with -s, -S, -v, or -z");
		return done(1);
	}
	let mut args: &[BString] = args;
	let mut fmt: Option<Vec<u8>> = None;
	let mut nc: usize = 0;
	if ops.isset(b'C') {
		let a = ops.arg(b'C').unwrap_or_default().to_vec();
		match strtol_all(&a) {
			None => {
				ctx.usage(format!("number expected after -C: {}", a.as_bstr()));
				return done(1);
			},
			Some(v) if v <= 0 => {
				ctx.usage(format!("invalid number of columns: {}", a.as_bstr()));
				return done(1);
			},
			Some(v) => nc = usize::try_from(v).unwrap_or(usize::MAX),
		}
	}
	if func == Func::Printf {
		if args.first().is_some_and(|a| a.as_slice() == b"--") {
			args = tail(args, 1);
			if args.is_empty() {
				ctx.usage("not enough arguments");
				return done(1);
			}
		}
		fmt = args.first().map(|a| a.to_vec());
		args = tail(args, 1);
	} else if func == Func::Echo && isset(ctx, ZshOpt::Bsdecho)? {
		ops.set(b'E');
	} else if ops.hasarg(b'f') {
		fmt = ops.arg(b'f').map(<[u8]>::to_vec);
	}
	let mut fmttrunc = false;
	if let Some(f) = &fmt {
		let how = if ops.isset(b'b') {
			getkey::KEYS_BINDKEY
		} else {
			getkey::KEYS_PRINTF_FMT
		};
		let (f, trunc) = getkeystring(f, how);
		fmttrunc = trunc;
		fmt = Some(f);
	}
	// -m: the first argument is a pattern; keep the arguments it matches.
	let mut words: Vec<Vec<u8>>;
	if ops.isset(b'm') {
		let Some((pat, rest)) = args.split_first() else {
			ctx.usage("no pattern specified");
			return done(1);
		};
		let Some(p) = pattern_arg(ctx, pat)? else {
			return done(1);
		};
		words = rest
			.iter()
			.filter(|a| p.matches(a.as_slice()))
			.map(|a| a.to_vec())
			.collect();
		if fmt.is_some() && words.is_empty() {
			return done(0);
		}
	} else {
		words = args.iter().map(|a| a.to_vec()).collect();
	}
	// Escapes, `-P`, `-D`.
	let mut nnl = false;
	let raw = fmt.is_some()
		|| (!ops.isset(b'e') && (ops.isset(b'R') || ops.isset(b'r') || ops.isset(b'E')));
	if !raw {
		let how = if ops.isset(b'b') {
			getkey::KEYS_BINDKEY
		} else if func != Func::Echo && !ops.isset(b'e') {
			getkey::KEYS_PRINT
		} else {
			getkey::KEYS_ECHO
		};
		let mut k = 0;
		while k < words.len() {
			let (w, stop) = getkeystring(&words[k], how);
			words[k] = w;
			if stop {
				// A `\c` makes this the last argument.
				nnl = true;
				words.truncate(k + 1);
				break;
			}
			k += 1;
		}
	}
	if ops.isset(b'P') {
		let env = match prompt_env(ctx)? {
			Ok(env) => env,
			Err(d) => return zerr(ctx, d),
		};
		if isset(ctx, ZshOpt::Promptsubst)? {
			let r = zx(ctx, |ex| {
				words
					.iter()
					.map(|w| prompt_subst(ex, w))
					.collect::<X<Vec<_>>>()
			})?;
			match r {
				Ok(w) => words = w,
				Err(d) => return zerr(ctx, d),
			}
		}
		for w in &mut words {
			*w = zsh_prompt::promptexpand(w, &env);
		}
	}
	if ops.isset(b'D') {
		let home = zx(ctx, |ex| params::getsparam(ex, b"HOME"))?;
		let home = match home {
			Ok(h) => h,
			Err(d) => return zerr(ctx, d),
		};
		if let Some(home) = home.filter(|h| !h.is_empty() && h.as_slice() != b"/") {
			for w in &mut words {
				if w.starts_with(&home) && matches!(w.get(home.len()), None | Some(b'/')) {
					let mut t = b"~".to_vec();
					t.extend_from_slice(tail(w, home.len()));
					*w = t;
				}
			}
		}
	}
	if ops.isset(b'o') || ops.isset(b'O') {
		if fmt.is_some() && words.is_empty() {
			return done(0);
		}
		if ops.isset(b'i') {
			words.sort_by_key(|a| a.to_ascii_lowercase());
		} else {
			words.sort();
		}
		if ops.isset(b'O') {
			words.reverse();
		}
	}
	// -u / -p: another file descriptor.
	let mut sink = Sink::Fd(1);
	if (ops.hasarg(b'u') || ops.isset(b'p'))
		&& ((fmt.is_none() && (ops.isset(b'c') || ops.isset(b'C'))) || !(zss || ops.isset(b'v')))
	{
		let u = ops.arg(b'u').map(<[u8]>::to_vec);
		let fd = if ops.isset(b'p') || u.as_deref() == Some(b"p") {
			// The coprocess's input.
			let Some(co) = ctx.vp.coprocs.last() else {
				ctx.usage("-p: no coprocess");
				return done(1);
			};
			i64::from(co.write)
		} else {
			let u = u.unwrap_or_default();
			let Some(fd) = strtol_all(&u) else {
				ctx.usage(format!("number expected after -u: {}", u.as_bstr()));
				return done(1);
			};
			fd
		};
		match i32::try_from(fd) {
			Ok(fd) if ctx.vp.fds.get(fd).is_some() => sink = Sink::Fd(fd),
			_ => {
				ctx.usage(format!("bad file number: {fd}"));
				return done(1);
			},
		}
	}
	if let Some(v) = ops.arg(b'v').filter(|_| ops.isset(b'v')) {
		sink = Sink::Var(v.into());
	}
	let cs = charset(ctx)?;
	let mut out: Vec<u8> = Vec::new();
	let Some(fmt) = fmt else {
		// -c / -C: columns.
		if ops.isset(b'c') || ops.isset(b'C') {
			columns(ctx, ops, &words, nc, cs.utf8, &mut out)?;
			return finish(ctx, sink, out);
		}
		if ops.isset(b'z') {
			ctx.diag(Diag::Unsupported { what: "print -z (the ZLE buffer stack)".into() });
			return done(1);
		}
		if ops.isset(b's') || ops.isset(b'S') {
			ctx.diag(Diag::Unsupported { what: "print -s (the zsh history list)".into() });
			return done(1);
		}
		let sep = if ops.isset(b'l') {
			b'\n'
		} else if ops.isset(b'N') {
			0
		} else {
			b' '
		};
		if ops.hasarg(b'x') || ops.hasarg(b'X') {
			let all = ops.hasarg(b'X');
			let xarg = ops
				.arg(if all { b'X' } else { b'x' })
				.unwrap_or_default()
				.to_vec();
			let expand = match strtol_all(&xarg) {
				Some(v) if v > 0 => usize::try_from(v).unwrap_or(usize::MAX),
				_ => {
					ctx.usage(format!("positive integer expected after -x: {}", xarg.as_bstr()));
					return done(1);
				},
			};
			let mut startpos = 0;
			for (k, w) in words.iter().enumerate() {
				startpos = zexpandtabs(w, expand, startpos, all, cs.utf8, &mut out);
				if k + 1 < words.len() {
					out.push(sep);
					startpos = if sep == b'\n' {
						0
					} else {
						startpos + usize::from(sep == b' ')
					};
				}
			}
		} else {
			for (k, w) in words.iter().enumerate() {
				out.extend_from_slice(w);
				if k + 1 < words.len() {
					out.push(sep);
				}
			}
		}
		if !(ops.isset(b'n') || nnl || (ops.isset(b'v') && !ops.isset(b'l'))) {
			out.push(if ops.isset(b'N') { 0 } else { b'\n' });
		}
		return finish(ctx, sink, out);
	};
	if ops.isset(b'z') || ops.isset(b's') {
		ctx.diag(Diag::Unsupported { what: "print -z/-s with a format".into() });
		return done(1);
	}
	let visarr = match &sink {
		Sink::Var(name) => {
			let base: Vec<u8> = name
				.split(|&c| c == b'[')
				.next()
				.unwrap_or_default()
				.to_vec();
			match zx(ctx, |ex| params::getparam(ex, &base))? {
				Ok(p) => p.is_some_and(|p| p.flags.contains(params::PmFlags::ARRAY)),
				Err(d) => return zerr(ctx, d),
			}
		},
		Sink::Fd(_) => false,
	};
	let quote = QuoteOpts {
		extended_glob: isset(ctx, ZshOpt::Extendedglob)?,
		magic_equal_subst: isset(ctx, ZshOpt::Magicequalsubst)?,
		cs,
	};
	let mut pf = Printf {
		ctx,
		fmt: &fmt,
		args: &words,
		out,
		splits: Vec::new(),
		ret: 0,
		fmttrunc,
		bindkey: ops.isset(b'b'),
		quote,
	};
	let failed = pf.run(visarr, ops.isset(b'r'))?.err();
	let Printf { ctx, out, splits, ret, .. } = pf;
	if let Some(status) = failed {
		// What was printed before the bad directive still goes out.
		if let Sink::Fd(fd) = sink {
			ctx.out_fd(fd, &out);
		}
		return done(status);
	}
	match sink {
		Sink::Var(name) if visarr && !splits.is_empty() => {
			let mut vals = Vec::with_capacity(splits.len() + 1);
			let mut start = 0;
			for &s in &splits {
				vals.push(BString::from(span(&out, start, s)));
				start = s;
			}
			vals.push(BString::from(tail(&out, start)));
			if let Err(d) = zx(ctx, |ex| params::assignaparam(ex, &name, vals, 0))? {
				return zerr(ctx, d);
			}
		},
		sink => {
			let r = finish(ctx, sink, out)?;
			if r.status != 0 {
				return Ok(r);
			}
		},
	}
	done(ret)
}

/// Write `out` to its sink (`setsparam` for `-v`).
fn finish(ctx: &mut Ctx<'_, '_>, sink: Sink, out: Vec<u8>) -> R {
	match sink {
		Sink::Fd(fd) => {
			ctx.out_fd(fd, &out);
			done(0)
		},
		Sink::Var(name) => match zx(ctx, |ex| params::assignsparam(ex, &name, &out, 0))? {
			Ok(()) => done(0),
			Err(d) => zerr(ctx, d),
		},
	}
}

/// `print -c` / `print -C N` (with `-a` across): the words in columns.
fn columns(
	ctx: &mut Ctx<'_, '_>,
	ops: &Ops,
	words: &[Vec<u8>],
	mut nc: usize,
	utf8: bool,
	out: &mut Vec<u8>,
) -> Result<(), super::Need> {
	let widths: Vec<usize> = words.iter().map(|w| display_width(w, utf8)).collect();
	let argc = words.len();
	let across = ops.isset(b'a');
	let (nr, sc);
	if ops.isset(b'C') {
		nr = argc.div_ceil(nc);
		let mut l = 0;
		for (i, &w) in widths.iter().enumerate() {
			if across {
				if i % nc == nc - 1 {
					continue;
				}
			} else if i >= nr * (nc - 1) {
				break;
			}
			l = l.max(w);
		}
		sc = l + 2;
	} else {
		let l = widths.iter().copied().max().unwrap_or(0);
		sc = l + 2;
		let cols = match zx(ctx, |ex| params::getsparam(ex, b"COLUMNS"))? {
			Ok(Some(v)) => strtol_all(&v)
				.and_then(|v| usize::try_from(v).ok())
				.unwrap_or(0),
			_ => 0,
		};
		nc = ((cols + 1) / sc).max(1);
		nr = argc.div_ceil(nc);
	}
	let term = if ops.isset(b'N') { 0 } else { b'\n' };
	let mut n = 0;
	for i in 0..nr {
		if across {
			let mut ic = 0;
			while ic < nc && n < argc {
				out.extend_from_slice(words.get(n).map_or(&[][..], |w| w.as_slice()));
				if ic < nc - 1 {
					let w = widths.get(n).copied().unwrap_or(0);
					out.resize(out.len() + sc.saturating_sub(w), b' ');
				}
				ic += 1;
				n += 1;
			}
		} else {
			n = i;
			loop {
				out.extend_from_slice(words.get(n).map_or(&[][..], |w| w.as_slice()));
				let l = widths.get(n).copied().unwrap_or(0);
				n += nr;
				if n < argc {
					out.resize(out.len() + sc.saturating_sub(l), b' ');
				} else {
					break;
				}
			}
		}
		out.push(term);
	}
	Ok(())
}

/// Display width of `w` for column layout: ANSI escape sequences (from
/// `\e` or `\x9b` to the next letter) take no room, every other character
/// one column.
fn display_width(w: &[u8], utf8: bool) -> usize {
	let mut width = 0;
	let mut i = 0;
	while i < w.len() {
		if w[i] == 0x1b || w[i] == 0x9b {
			i += 1;
			while i < w.len() && !w[i].is_ascii_alphabetic() {
				i += 1;
			}
			i += 1;
			continue;
		}
		let n = if utf8 {
			bstr::decode_utf8(tail(w, i)).1.max(1)
		} else {
			1
		};
		if w[i] >= 0x20 && w[i] != 0x7f {
			width += 1;
		}
		i += n;
	}
	width
}

/// C printf flags of one directive (`'0+- #`).
#[derive(Clone, Copy, Default)]
struct CFlags {
	zero:  bool,
	plus:  bool,
	left:  bool,
	space: bool,
	alt:   bool,
}

/// Pad `prefix` + `body` to `width` (negative: left-justified) the way
/// printf(3) does; `zero` allows zero padding after the prefix.
fn emit(out: &mut Vec<u8>, prefix: &[u8], body: &[u8], width: i64, f: CFlags, zero: bool) {
	let left = f.left || width < 0;
	let w = usize::try_from(width.unsigned_abs()).unwrap_or(usize::MAX);
	let fill = w.saturating_sub(prefix.len() + body.len());
	if left {
		out.extend_from_slice(prefix);
		out.extend_from_slice(body);
		out.resize(out.len() + fill, b' ');
	} else if zero && f.zero {
		out.extend_from_slice(prefix);
		out.resize(out.len() + fill, b'0');
		out.extend_from_slice(body);
	} else {
		out.resize(out.len() + fill, b' ');
		out.extend_from_slice(prefix);
		out.extend_from_slice(body);
	}
}

/// `%d`/`%i` of `v`.
fn fmt_int(out: &mut Vec<u8>, v: i64, f: CFlags, width: i64, prec: Option<usize>) {
	let mut digits = if prec == Some(0) && v == 0 {
		String::new()
	} else {
		v.unsigned_abs().to_string()
	};
	if let Some(p) = prec
		&& digits.len() < p
	{
		digits.insert_str(0, &"0".repeat(p - digits.len()));
	}
	let sign: &[u8] = if v < 0 {
		b"-"
	} else if f.plus {
		b"+"
	} else if f.space {
		b" "
	} else {
		b""
	};
	emit(out, sign, digits.as_bytes(), width, f, prec.is_none());
}

/// `%o %u %x %X` of `v`.
fn fmt_uint(out: &mut Vec<u8>, v: u64, conv: u8, f: CFlags, width: i64, prec: Option<usize>) {
	let mut digits = if prec == Some(0) && v == 0 {
		String::new()
	} else {
		match conv {
			b'o' => format!("{v:o}"),
			b'x' => format!("{v:x}"),
			b'X' => format!("{v:X}"),
			_ => v.to_string(),
		}
	};
	if let Some(p) = prec
		&& digits.len() < p
	{
		digits.insert_str(0, &"0".repeat(p - digits.len()));
	}
	if conv == b'o' && f.alt && !digits.starts_with('0') {
		digits.insert(0, '0');
	}
	let prefix: &[u8] = match conv {
		b'x' if f.alt && v != 0 => b"0x",
		b'X' if f.alt && v != 0 => b"0X",
		_ => b"",
	};
	emit(out, prefix, digits.as_bytes(), width, f, prec.is_none());
}

/// `d.ddde±XX` of non-negative `a`.
fn exp_text(a: f64, prec: usize, upper: bool, alt: bool) -> String {
	let s = format!("{a:.prec$e}");
	let (mant, e) = s.split_once('e').unwrap_or((&s, "0"));
	let e: i32 = e.parse().unwrap_or(0);
	let mut m = mant.to_owned();
	if alt && prec == 0 {
		m.push('.');
	}
	let sign = if e < 0 { '-' } else { '+' };
	format!("{m}{}{sign}{:02}", if upper { 'E' } else { 'e' }, e.unsigned_abs())
}

/// `%e %f %g` (and capitals) of finite `v`.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's fmt_float")]
fn fmt_float(out: &mut Vec<u8>, v: f64, conv: u8, f: CFlags, width: i64, prec: Option<usize>) {
	let a = v.abs();
	let upper = conv.is_ascii_uppercase();
	let body = match conv.to_ascii_lowercase() {
		b'f' => {
			let p = prec.unwrap_or(6);
			let mut s = format!("{a:.p$}");
			if f.alt && p == 0 {
				s.push('.');
			}
			s
		},
		b'e' => exp_text(a, prec.unwrap_or(6), upper, f.alt),
		_ => {
			let p = prec.unwrap_or(6).max(1);
			let x: i32 = if a == 0.0 {
				0
			} else {
				let s = format!("{a:.prec$e}", prec = p - 1);
				s.split_once('e')
					.and_then(|(_, e)| e.parse().ok())
					.unwrap_or(0)
			};
			let p_i = i32::try_from(p).unwrap_or(i32::MAX);
			let mut s = if p_i > x && x >= -4 {
				let fp = usize::try_from(p_i - 1 - x).unwrap_or(0);
				format!("{a:.fp$}")
			} else {
				exp_text(a, p - 1, upper, f.alt)
			};
			if !f.alt {
				let (mant, exp) = s
					.find(['e', 'E'])
					.map_or((s.as_str(), ""), |i| s.split_at(i));
				let mant = if mant.contains('.') {
					mant.trim_end_matches('0').trim_end_matches('.')
				} else {
					mant
				};
				s = format!("{mant}{exp}");
			}
			s
		},
	};
	let sign: &[u8] = if v.is_sign_negative() {
		b"-"
	} else if f.plus {
		b"+"
	} else if f.space {
		b" "
	} else {
		b""
	};
	emit(out, sign, body.as_bytes(), width, f, true);
}

/// The printf engine of `bin_print`.
struct Printf<'p, 'a, 'c> {
	ctx:      &'p mut Ctx<'a, 'c>,
	fmt:      &'p [u8],
	args:     &'p [Vec<u8>],
	out:      Vec<u8>,
	/// Output offsets where each reuse of the format started (`-v` of an
	/// array: one element per pass).
	splits:   Vec<usize>,
	ret:      i32,
	fmttrunc: bool,
	bindkey:  bool,
	quote:    QuoteOpts,
}

impl Printf<'_, '_, '_> {
	/// zsh `mathevali` of a numeric argument; an error is reported and
	/// counts as 0 with status 1.
	fn mathevali(&mut self, s: &[u8]) -> Result<i64, super::Need> {
		let text = tok::metafy(s);
		match zx(self.ctx, |ex| arith::mathevali(ex, &text))? {
			Ok(v) => Ok(v),
			Err(d) => {
				self.ctx.diag(d);
				self.ret = 1;
				Ok(0)
			},
		}
	}

	/// zsh `matheval` of a float argument.
	fn matheval(&mut self, s: &[u8]) -> Result<f64, super::Need> {
		let text = tok::metafy(s);
		match zx(self.ctx, |ex| arith::matheval(ex, &text))? {
			Ok(v) => Ok(v.to_float()),
			Err(d) => {
				self.ctx.diag(d);
				self.ret = 1;
				Ok(0.0)
			},
		}
	}

	/// `%N$: argument specifier out of range`.
	fn out_of_range(&mut self, narg: usize) -> i32 {
		self
			.ctx
			.usage(format!("{narg}: argument specifier out of range"));
		1
	}

	/// Run the format over the arguments, reusing it while arguments are
	/// left (unless `-r`). `Ok(Err(status))` when a directive failed.
	#[expect(clippy::too_many_lines, reason = "one loop, as zsh's bin_print")]
	fn run(&mut self, visarr: bool, no_reuse: bool) -> Result<Result<(), i32>, super::Need> {
		let fmt = self.fmt;
		let args = self.args;
		let mut flen = fmt.len();
		let (mut first, mut argp, mut maxarg) = (0usize, 0usize, 0usize);
		let mut argc = args.len();
		loop {
			let rcount = self.out.len();
			if argp > 0 && visarr {
				self.splits.push(self.out.len());
			}
			if maxarg > 0 {
				first += maxarg;
				argc = argc.saturating_sub(maxarg);
				maxarg = 0;
			}
			let mut c = 0;
			while c < flen {
				if at(fmt, c) != b'%' {
					self.out.push(at(fmt, c));
					c += 1;
					continue;
				}
				let start = c;
				c += 1;
				if fmt.get(c) == Some(&b'%') {
					self.out.push(b'%');
					c += 1;
					continue;
				}
				let mut width: i64 = 0;
				let mut prec: Option<usize> = None;
				let mut curarg: Option<&[u8]> = None;
				if fmt.get(c).is_some_and(|d| (b'1'..=b'9').contains(d)) {
					let (narg, nd) = strtoul(tail(fmt, c));
					if fmt.get(c + nd) == Some(&b'$') {
						c += nd + 1;
						if narg == 0 || narg > argc {
							return Ok(Err(self.out_of_range(narg)));
						}
						maxarg = maxarg.max(narg);
						curarg = args.get(first + narg - 1).map(Vec::as_slice);
					}
				}
				let mut f = CFlags::default();
				while let Some(&d) = fmt.get(c) {
					match d {
						b'\'' => {},
						b'0' => f.zero = true,
						b'+' => f.plus = true,
						b'-' => f.left = true,
						b' ' => f.space = true,
						b'#' => f.alt = true,
						_ => break,
					}
					c += 1;
				}
				if fmt.get(c).is_some_and(u8::is_ascii_digit) {
					let (w, nd) = strtoul(tail(fmt, c));
					width = i64::try_from(w).unwrap_or(i64::MAX);
					c += nd;
				} else if fmt.get(c) == Some(&b'*') {
					c += 1;
					if fmt.get(c).is_some_and(u8::is_ascii_digit) {
						let (narg, nd) = strtoul(tail(fmt, c));
						if fmt.get(c + nd) == Some(&b'$') {
							c += nd + 1;
							if narg == 0 || narg > argc {
								return Ok(Err(self.out_of_range(narg)));
							}
							maxarg = maxarg.max(narg);
							argp = first + narg - 1;
						}
					}
					if let Some(a) = args.get(argp) {
						argp += 1;
						width = self.mathevali(a)?;
					}
				}
				if fmt.get(c) == Some(&b'.') {
					c += 1;
					if fmt.get(c) == Some(&b'*') {
						c += 1;
						if fmt.get(c).is_some_and(u8::is_ascii_digit) {
							let (narg, nd) = strtoul(tail(fmt, c));
							if fmt.get(c + nd) == Some(&b'$') {
								c += nd + 1;
								if narg == 0 || narg > argc {
									return Ok(Err(self.out_of_range(narg)));
								}
								maxarg = maxarg.max(narg);
								argp = first + narg - 1;
							}
						}
						if let Some(a) = args.get(argp) {
							argp += 1;
							prec = usize::try_from(self.mathevali(a)?).ok();
						}
					} else if fmt.get(c).is_some_and(u8::is_ascii_digit) {
						let (p, nd) = strtoul(tail(fmt, c));
						prec = Some(p);
						c += nd;
					} else {
						prec = Some(0);
					}
				}
				// Size modifiers are ignored.
				if matches!(fmt.get(c), Some(b'l' | b'L' | b'h')) {
					c += 1;
				}
				if curarg.is_none()
					&& let Some(a) = args.get(argp)
				{
					curarg = Some(a);
					argp += 1;
				}
				let conv = fmt.get(c).copied().unwrap_or(0);
				let mut kind = 0;
				match conv {
					b'c' => {
						let ch = curarg.and_then(|a| a.first().copied()).unwrap_or(0);
						emit(&mut self.out, b"", &[ch], width, f, false);
					},
					b's' | b'b' => {
						if let Some(a) = curarg {
							let mut nnl = false;
							let b: Vec<u8> = if conv == b'b' {
								let how = if self.bindkey {
									getkey::KEYS_BINDKEY
								} else {
									getkey::KEYS_PRINTF_ARG
								};
								let (b, stop) = getkeystring(a, how);
								nnl = stop;
								b
							} else {
								a.to_vec()
							};
							let utf8 = self.quote.cs.utf8;
							let mut lbytes = b.len();
							let mut lchars = char_count(&b, utf8);
							if let Some(p) = prec
								&& lchars > p
							{
								lbytes = char_prefix(&b, p, utf8);
								lchars = p;
							}
							let w = if width > 0 && f.left { -width } else { width };
							let wl = usize::try_from(w.unsigned_abs()).unwrap_or(0);
							if w > 0 && lchars < wl {
								self.out.resize(self.out.len() + wl - lchars, b' ');
							}
							self.out.extend_from_slice(head(&b, lbytes));
							if w < 0 && lchars < wl {
								self.out.resize(self.out.len() + wl - lchars, b' ');
							}
							if nnl {
								// A `\c` in a `%b` argument ends the format.
								flen = c + 1;
								self.fmttrunc = true;
							}
						} else if width != 0 {
							let wl = usize::try_from(width.unsigned_abs()).unwrap_or(0);
							self.out.resize(self.out.len() + wl, b' ');
						}
					},
					b'q' => {
						let q =
							zsh_quote::quotestring_backslash(curarg.unwrap_or_default(), true, self.quote);
						let lb = prec.map_or(q.len(), |p| p.min(q.len()));
						emit(&mut self.out, b"", head(&q, lb), width, f, false);
					},
					b'd' | b'i' => kind = 1,
					b'e' | b'E' | b'f' | b'g' | b'G' => kind = 2,
					b'o' | b'u' | b'x' | b'X' => kind = 3,
					b'n' => {
						if let Some(a) = curarg {
							let count = i64::try_from(self.out.len() - rcount).unwrap_or(i64::MAX);
							let name = a.to_vec();
							if let Err(d) = zx(self.ctx, |ex| {
								let text = count.to_string();
								params::setnparam(ex, &name, Number::Int(count), text.as_bytes(), 10)
									.map(drop)
							})? {
								self.ctx.diag(d);
								self.ret = 1;
							}
						}
					},
					_ => {
						let end = (c + 1).min(fmt.len());
						self
							.ctx
							.usage(format!("{}: invalid directive", BStr::new(span(fmt, start, end))));
						return Ok(Err(1));
					},
				}
				if kind > 0 {
					if let Some(a) = curarg.filter(|a| matches!(a.first(), Some(b'\'' | b'"'))) {
						// A quoted character's code.
						let cc: u32 = if self.quote.cs.utf8 {
							bstr::decode_utf8(tail(a, 1))
								.0
								.map_or_else(|| a.get(1).copied().map_or(0, u32::from), u32::from)
						} else {
							a.get(1).copied().map_or(0, u32::from)
						};
						if kind == 2 {
							fmt_float(&mut self.out, f64::from(cc), conv, f, width, prec);
						} else if kind == 1 {
							fmt_int(&mut self.out, i64::from(cc), f, width, prec);
						} else {
							fmt_uint(&mut self.out, u64::from(cc), conv, f, width, prec);
						}
					} else {
						match kind {
							1 => {
								let v = match curarg {
									Some(a) => self.mathevali(a)?,
									None => 0,
								};
								fmt_int(&mut self.out, v, f, width, prec);
							},
							2 => {
								let v = match curarg {
									Some(a) => match std::str::from_utf8(a)
										.ok()
										.and_then(|s| s.trim_start().parse::<f64>().ok())
									{
										Some(v) => v,
										None => self.matheval(a)?,
									},
									None => 0.0,
								};
								if v.is_nan() {
									self.out.extend_from_slice(b"nan");
								} else if v.is_infinite() {
									self
										.out
										.extend_from_slice(if v < 0.0 { b"-inf" } else { b"inf" });
								} else {
									fmt_float(&mut self.out, v, conv, f, width, prec);
								}
							},
							_ => {
								let v = match curarg {
									None => 0,
									Some(a) => {
										match strtoul_underscore(a, isset(self.ctx, ZshOpt::Octalzeroes)?) {
											Some(v) => v,
											None => self.mathevali(a)?.cast_unsigned(),
										}
									},
								};
								fmt_uint(&mut self.out, v, conv, f, width, prec);
							},
						}
					}
				}
				if maxarg > 0 && argp - first > maxarg {
					maxarg = argp - first;
				}
				c += 1;
			}
			if maxarg > 0 {
				argp = first + maxarg;
			}
			if argp >= args.len() || argp == first || self.fmttrunc || no_reuse {
				break;
			}
		}
		Ok(Ok(()))
	}
}

/// zsh `zstrtoul_underscore`: an unsigned constant (`0x…`, `0b…`, octal
/// under `OCTAL_ZEROES`, `_` separators) making up all of `s`.
fn strtoul_underscore(s: &[u8], octal_zeroes: bool) -> Option<u64> {
	let mut s = s.strip_prefix(b"+").unwrap_or(s);
	let base: u64 = if s.first() == Some(&b'0') {
		s = tail(s, 1);
		match s.first() {
			Some(b'x' | b'X') => {
				s = tail(s, 1);
				16
			},
			Some(b'b' | b'B') => {
				s = tail(s, 1);
				2
			},
			_ if octal_zeroes => 8,
			_ => 10,
		}
	} else {
		10
	};
	let mut calc: u64 = 0;
	for &c in s {
		if c == b'_' {
			continue;
		}
		let d = u64::from(char::from(c).to_digit(36)?);
		if d >= base {
			return None;
		}
		calc = calc.checked_mul(base)?.checked_add(d)?;
	}
	Some(calc)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn int(value: i64, flags: CFlags, width: i64, prec: Option<usize>) -> String {
		let mut out = Vec::new();
		fmt_int(&mut out, value, flags, width, prec);
		String::from_utf8(out).unwrap()
	}

	fn flt(value: f64, conv: u8, flags: CFlags, width: i64, prec: Option<usize>) -> String {
		let mut out = Vec::new();
		fmt_float(&mut out, value, conv, flags, width, prec);
		String::from_utf8(out).unwrap()
	}

	#[test]
	fn c_integer_conversions_match_printf3() {
		assert_eq!(int(5, CFlags::default(), 0, Some(3)), "005");
		assert_eq!(int(5, CFlags { plus: true, ..CFlags::default() }, 0, None), "+5");
		assert_eq!(int(5, CFlags { space: true, ..CFlags::default() }, 0, None), " 5");
		assert_eq!(int(42, CFlags { left: true, ..CFlags::default() }, 5, None), "42   ");
		assert_eq!(int(-42, CFlags { zero: true, ..CFlags::default() }, 6, None), "-00042");
		let mut o = Vec::new();
		fmt_uint(&mut o, 255, b'x', CFlags { zero: true, ..CFlags::default() }, 5, None);
		fmt_uint(&mut o, 255, b'x', CFlags { alt: true, ..CFlags::default() }, 0, None);
		fmt_uint(&mut o, 8, b'o', CFlags { alt: true, ..CFlags::default() }, 0, None);
		assert_eq!(o, b"000ff0xff010");
	}

	#[test]
	fn c_float_conversions_match_printf3() {
		assert_eq!(flt(1.23456, b'f', CFlags::default(), 5, Some(2)), " 1.23");
		assert_eq!(flt(1234.5, b'e', CFlags::default(), 0, None), "1.234500e+03");
		assert_eq!(flt(0.0001, b'g', CFlags::default(), 0, None), "0.0001");
		assert_eq!(flt(12345.678, b'e', CFlags::default(), 5, Some(1)), "1.2e+04");
		assert_eq!(flt(0.000_012_34, b'G', CFlags::default(), 0, None), "1.234E-05");
		assert_eq!(flt(100_000.0, b'g', CFlags::default(), 0, None), "100000");
		assert_eq!(flt(1_000_000.0, b'g', CFlags::default(), 0, None), "1e+06");
	}

	#[test]
	fn tab_expansion_indentation_only_or_all() {
		let mut o = Vec::new();
		zexpandtabs(b"\ta\tb", 4, 0, false, false, &mut o);
		assert_eq!(o, b"    a\tb");
		o.clear();
		zexpandtabs(b"a\tb", 4, 0, true, false, &mut o);
		assert_eq!(o, b"a   b");
	}

	#[test]
	fn unsigned_constants() {
		assert_eq!(strtoul_underscore(b"0x1F", false), Some(31));
		assert_eq!(strtoul_underscore(b"1_000", false), Some(1000));
		assert_eq!(strtoul_underscore(b"010", true), Some(8));
		assert_eq!(strtoul_underscore(b"010", false), Some(10));
		assert_eq!(strtoul_underscore(b"1+2", false), None);
	}
}
