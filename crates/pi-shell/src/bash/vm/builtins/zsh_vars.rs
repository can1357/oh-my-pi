//! zsh `set`, `unset`, `shift`, `read`, `getopts` and `let`: ports of zsh
//! 5.9 `builtin.c` `bin_set`, `bin_unset`, `bin_shift`, `bin_read`,
//! `bin_getopts`, `bin_let` and `options.c` `printoptionstates`, over the
//! zsh parameter code.
//!
//! `read -k`/`-q` without `-u` read standard input (zsh opens the
//! terminal); in a widget they take their keys through the editor.
//! `read -z` takes the line off the buffer stack;
//! `-l` and `-c` (compctl) fail loudly.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	Control, Ctx, Need, Outcome, R, done, options,
	zsh_args::{Func, Ops, isset, pattern_arg, zerr, zx},
	zsh_print::charset,
	zsh_typeset::{PM_ARRAY, PRINT_NAMEONLY, pm_type, print_params},
};
use crate::bash::{
	diag::Diag,
	fs::FileKind,
	ids::ModeId,
	store::{Attrs, StateStore, StoreError, VarValue},
	syntax::zsh::tok::{head, span, tail},
	vm::{
		Cx, Kernel,
		expand::{Expander, Stop},
		proc::{GetoptsState, PendingWrite, Probe, ProbeResult, Vproc},
		state,
		zsh::{arith, math::Number, params},
	},
	zshopt::ZshOpt,
};

/// zsh `printoptionstates`: `set -o` (and `set +o` as commands).
fn print_option_states(ctx: &mut Ctx<'_, '_>, hadplus: bool) -> R {
	use strum::IntoEnumIterator;
	let mode = ctx.vp.mode;
	let mut out = Vec::new();
	for opt in ZshOpt::iter() {
		let on = ctx.zsh_option(opt)?;
		let def = opt.default_in(mode);
		let name: &'static str = opt.into();
		let line = if hadplus {
			format!(
				"set {}o {}{name}\n",
				if def == on { '+' } else { '-' },
				if def { "no" } else { "" }
			)
		} else if def {
			format!("no{name:<19} {}\n", if on { "off" } else { "on" })
		} else {
			format!("{name:<21} {}\n", if on { "on" } else { "off" })
		};
		out.extend_from_slice(line.as_bytes());
	}
	ctx.out(&out);
	done(0)
}

/// zsh `bin_set`: options, `-A`/`+A` arrays, `-s` sorting, listings, or
/// the positional parameters.
#[expect(clippy::too_many_lines, reason = "one function, as zsh's bin_set")]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's set")]
pub fn set(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mode = ctx.vp.mode;
	let mut i = 0;
	if mode != ModeId::Zsh && args.first().is_some_and(|a| a.as_slice() == b"-") {
		// `set -` is `set +xv` outside zsh emulation.
		ctx.set_zsh_option(ZshOpt::Verbose, false)?;
		ctx.set_zsh_option(ZshOpt::Xtrace, false)?;
		if args.len() == 1 {
			return done(0);
		}
	}
	let (mut array, mut hadopt, mut hadplus, mut hadend, mut sort) = (0i8, false, false, false, 0i8);
	let mut arrayname: Option<BString> = None;
	let mut failed = false;
	'outer: while let Some(word) = args.get(i) {
		let action = match word.first() {
			Some(b'-') => true,
			Some(b'+') => false,
			_ => break,
		};
		hadplus |= !action;
		let w: &[u8] = if word.len() == 1 { b"--" } else { word };
		let mut j = 1;
		while j < w.len() {
			let c = w[j];
			if c != b'-' || action {
				hadopt = true;
			}
			if c == b'-' {
				hadend = true;
				i += 1;
				break 'outer;
			} else if c == b'o' {
				let name: BString = if j + 1 < w.len() {
					tail(w, j + 1).into()
				} else {
					i += 1;
					match args.get(i) {
						Some(n) => n.clone(),
						None => return print_option_states(ctx, hadplus),
					}
				};
				match ZshOpt::lookup(&name) {
					None => {
						ctx.usage(format!("no such option: {}", name.as_bstr()));
						failed = true;
					},
					Some((opt, inv)) => {
						if !options::dosetopt(ctx, opt, action != inv)? {
							ctx.usage(format!("can't change option: {}", name.as_bstr()));
							failed = true;
						}
					},
				}
				break;
			} else if c == b'A' {
				array = if action { 1 } else { -1 };
				let name = if j + 1 < w.len() {
					Some(BString::from(tail(w, j + 1)))
				} else {
					i += 1;
					args.get(i).cloned()
				};
				arrayname = name;
				if arrayname.is_none() {
					break 'outer;
				}
				if !isset(ctx, ZshOpt::Ksharrays)? {
					i += 1;
					break 'outer;
				}
				break;
			} else if c == b's' {
				sort = if action { 1 } else { -1 };
			} else {
				match ZshOpt::letter(c, mode) {
					None => {
						ctx.usage(format!("bad option: -{}", char::from(c)));
						failed = true;
					},
					Some((opt, inv)) => {
						if !options::dosetopt(ctx, opt, action != inv)? {
							ctx.usage(format!("can't change option: -{}", char::from(c)));
							failed = true;
						}
					},
				}
			}
			j += 1;
		}
		i += 1;
	}
	if failed {
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	}
	let rest = tail(args, i.min(args.len()));
	if arrayname.is_none() {
		let flags = if hadplus { PRINT_NAMEONLY } else { 0 };
		if !hadopt
			&& rest.is_empty()
			&& let Err(d) = print_params(ctx, None, 0, 0, flags)?
		{
			return zerr(ctx, d);
		}
		if array != 0
			&& let Err(d) = print_params(ctx, None, PM_ARRAY, 0, flags)?
		{
			return zerr(ctx, d);
		}
		if rest.is_empty() && !hadend {
			return done(0);
		}
	}
	let mut vals: Vec<BString> = rest.to_vec();
	if sort != 0 {
		vals.sort();
		if sort < 0 {
			vals.reverse();
		}
	}
	if let Some(name) = arrayname {
		if array < 0
			&& let Ok(Some(old)) = zx(ctx, |ex| params::getaparam(ex, &name))?
			&& old.len() > vals.len()
		{
			vals.extend_from_slice(tail(&old, vals.len()));
		}
		return match zx(ctx, |ex| params::assignaparam(ex, &name, vals, 0))? {
			Ok(()) => done(0),
			Err(d) => zerr(ctx, d),
		};
	}
	state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, vals);
	done(0)
}

/// zsh `bin_unset`: parameters, elements (`unset 'a[2]'`, `unset
/// 'h[key]'`), `-m` patterns; `-f` is `unfunction`.
pub fn unset(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], func: Func) -> R {
	if ops.isset(b'f') {
		return super::zsh_names::unhash(ctx, ops, args, func);
	}
	if ops.isset(b'm') {
		let mut returnval = 0;
		let mut matched = 0;
		for s in args {
			let Some(pat) = pattern_arg(ctx, s)? else {
				returnval = 1;
				continue;
			};
			let r = zx(ctx, |ex| {
				let names: Vec<BString> = params::scan(ex)?
					.into_iter()
					.filter(|p| pat.matches(&p.name))
					.map(|p| p.name)
					.collect();
				for n in &names {
					params::unsetparam(ex, n)?;
				}
				Ok(names.len())
			})?;
			match r {
				Ok(n) => matched += n,
				Err(d) => {
					ctx.diag(d);
					returnval = 1;
				},
			}
		}
		return done(if matched == 0 { 1 } else { returnval });
	}
	let mut returnval = 0;
	// zsh `unsetparam_pm`'s errors are `zerr`s: the other operands are
	// still unset, then the command line is abandoned.
	let mut errflag = false;
	for s in args {
		let (name, sub) = match s.find_byte(b'[') {
			Some(open) => (head(s, open), Some(tail(s, open))),
			None => (s.as_slice(), None),
		};
		if sub.is_some_and(|sub| !sub.ends_with(b"]"))
			|| !params::isident(name, params::wide_idents_ctx(ctx))
		{
			ctx.usage(format!("{}: invalid parameter name", s.as_bstr()));
			returnval = 1;
			continue;
		}
		let full = s.to_vec();
		let base = name.to_vec();
		let r = zx(ctx, |ex| {
			// zsh `bin_unset` (`gethashnode2`) does not load the module
			// of an autoloadable parameter: the stub goes.
			if sub.is_none() && params::unset_stub(ex, &base)? {
				return Ok(None);
			}
			let Some(p) = params::getparam(ex, &base)? else {
				return Ok(None);
			};
			if sub.is_some()
				&& pm_type(p.flags.bits()) & !PM_ARRAY != 0
				&& pm_type(p.flags.bits()) != super::zsh_typeset::PM_HASHED
			{
				return Ok(Some(false));
			}
			params::unsetparam(ex, &full)?;
			Ok(Some(true))
		})?;
		match r {
			Ok(Some(false)) => {
				ctx.usage(format!("{}: invalid element for unset", s.as_bstr()));
				returnval = 1;
			},
			Ok(_) => {},
			Err(d) => {
				ctx.diag(d);
				errflag = true;
			},
		}
	}
	if errflag {
		return Ok(super::Outcome { status: 1, control: super::Control::DiscardAll });
	}
	done(returnval)
}

/// zsh `bin_shift`: `shift [n] [array …]`; `-p` drops from the end.
pub fn shift(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let mut args = args;
	let mut num: i64 = 1;
	if let Some(first) = args.first() {
		let is_array = matches!(
			zx(ctx, |ex| {
				if first.is_ascii() && !first.contains(&b'[') && params::isident(first, false) {
					// Only the type is needed here. Reading the value would copy
					// an entire array before the shift reads it again below.
					let Some(pm) = params::getparam_type(ex, first)? else {
						return Ok(false);
					};
					let flags = pm.flags;
					Ok(flags.type_bits() == params::PmFlags::ARRAY
						&& (!flags.contains(params::PmFlags::UNSET)
							|| flags.contains(params::PmFlags::DECLARED))
						&& !state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Ksharrays)?)
				} else {
					Ok(params::getaparam(ex, first)?.is_some())
				}
			})?,
			Ok(true)
		);
		if !is_array {
			let text = crate::bash::syntax::zsh::tok::metafy(first);
			num = match zx(ctx, |ex| arith::mathevali(ex, &text))? {
				Ok(n) => n,
				Err(d) => return zerr(ctx, d),
			};
			args = tail(args, 1);
		}
	}
	if num < 0 {
		ctx.usage("argument to shift must be non-negative");
		return done(1);
	}
	let num = usize::try_from(num).unwrap_or(usize::MAX);
	let from_end = ops.isset(b'p');
	let drop = |mut v: Vec<BString>| {
		if from_end {
			v.truncate(v.len() - num);
		} else {
			v.drain(..num.min(v.len()));
		}
		v
	};
	if args.is_empty() {
		let pos = ctx.positional()?;
		if num > pos.len() {
			ctx.usage("shift count must be <= $#");
			return done(1);
		}
		state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, drop(pos));
		return done(0);
	}
	let mut ret = 0;
	for a in args {
		let name = a.clone();
		let Ok(Some(v)) = zx(ctx, |ex| params::getaparam(ex, &name))? else {
			continue;
		};
		if v.len() < num {
			ctx.usage("shift count must be <= $#");
			ret += 1;
			continue;
		}
		let v = drop(v);
		if let Err(d) = zx(ctx, |ex| params::assignaparam(ex, &name, v, 0))? {
			return zerr(ctx, d);
		}
	}
	done(ret)
}

/// zsh `bin_let`: evaluate each expression; status 0 when the last value
/// is non-zero. Errors are reported but not fatal.
pub fn let_(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut val = Number::Int(0);
	for a in args {
		let text = crate::bash::syntax::zsh::tok::metafy(a);
		match zx(ctx, |ex| arith::matheval(ex, &text))? {
			Ok(v) => val = v,
			Err(d) => {
				ctx.diag(d);
				val = Number::Int(0);
			},
		}
	}
	done(i32::from(match val {
		Number::Int(v) => v == 0,
		Number::Float(d) => d == 0.0,
	}))
}

/// zsh `doshfunc` saving `zoptind`/`optcind` at a function call: the
/// caller's getopts position (`None`: `OPTIND` 1 with no scan under way,
/// no allocation per call). Without `POSIX_BUILTINS` the function starts
/// a scan of its own.
///
/// # Errors
/// [`StoreError`] when the store fails.
pub fn optind_enter(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) -> Result<Option<Box<GetoptsState>>, StoreError> {
	let text = state::lookup(root, store, vp, b"OPTIND")?
		.and_then(state::Var::as_scalar)
		.map(BString::from);
	let fresh = text.as_ref().is_some_and(|t| t.as_slice() == b"1");
	let saved = if fresh && vp.getopts == GetoptsState::default() {
		None
	} else {
		let next = vp.getopts.next.filter(|_| vp.getopts.optind == text);
		Some(Box::new(GetoptsState { optind: text, next, at: None }))
	};
	if !state::zsh_option(root, store, vp, ZshOpt::Posixbuiltins)? {
		vp.getopts = GetoptsState::default();
		set_optind(root, store, vp, b"1")?;
	}
	Ok(saved)
}

/// zsh `doshfunc` at a function's return without `POSIX_BUILTINS` (the
/// caller checks): the caller's getopts position ([`optind_enter`]) comes
/// back.
///
/// # Errors
/// [`StoreError`] when the store fails.
pub fn optind_leave(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	saved: Option<Box<GetoptsState>>,
) -> Result<(), StoreError> {
	let saved = saved.map_or_else(GetoptsState::default, |s| *s);
	let text = saved.optind.clone().unwrap_or_else(|| BString::from("1"));
	set_optind(root, store, vp, &text)?;
	vp.getopts = saved;
	Ok(())
}

/// Store `text` as the value of `OPTIND`, keeping its attributes.
fn set_optind(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	text: &[u8],
) -> Result<(), StoreError> {
	let attrs = state::lookup_declared(root, store, vp, b"OPTIND")?
		.map_or(Attrs::NONE, |v| v.attrs.without(Attrs::INVISIBLE));
	let var = state::Var { attrs, value: VarValue::Str(BString::from(text)) };
	state::store_var(root, store, vp, b"OPTIND", Some(var), state::Level::Dynamic);
	Ok(())
}

/// zsh `bin_getopts`: `getopts optstring name [args]`, with zsh's
/// `OPTIND` and `OPTARG` and its `bad option`/`argument expected`
/// messages.
pub fn getopts(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let [optstr_full, var, ..] = args else {
		return done(1);
	};
	let (optstr_full, var) = (optstr_full.clone(), var.clone());
	let operands: Vec<BString> = if args.len() > 2 {
		tail(args, 2).to_vec()
	} else {
		ctx.positional()?
	};
	let optind_text = zx(ctx, |ex| params::getsparam(ex, b"OPTIND"))?
		.ok()
		.flatten();
	let mut zoptind: i64 = optind_text
		.as_ref()
		.and_then(|v| v.to_str().ok().and_then(|s| s.trim().parse().ok()))
		.unwrap_or(0);
	// zsh's `optcind`: kept while `OPTIND` is what the last call left.
	let state = &ctx.vp.getopts;
	let mut optcind: usize = if zoptind < 1 {
		zoptind = 1;
		0
	} else {
		match state.next {
			Some((ind, c)) if state.optind == optind_text && i64::from(ind) == zoptind => c as usize,
			_ => 0,
		}
	};
	let posix = isset(ctx, ZshOpt::Posixbuiltins)?;
	let quiet = optstr_full.first() == Some(&b':');
	let optstr = tail(&optstr_full, usize::from(quiet));
	let mut result: Option<(BString, Option<BString>)> = None;
	let status = 'run: {
		let idx = |n: i64| usize::try_from(n - 1).unwrap_or(usize::MAX);
		if operands.len() < usize::try_from(zoptind).unwrap_or(usize::MAX) {
			break 'run 1;
		}
		let Some(mut s) = operands.get(idx(zoptind)).cloned() else {
			break 'run 1;
		};
		if s.is_empty() {
			break 'run 1;
		}
		if optcind >= s.len() {
			optcind = 0;
			zoptind += 1;
			let Some(next) = operands.get(idx(zoptind)).cloned() else {
				break 'run 1;
			};
			s = next;
		}
		if optcind == 0 {
			if s.len() < 2 || !matches!(s[0], b'-' | b'+') {
				break 'run 1;
			}
			if s.as_slice() == b"--" {
				zoptind += 1;
				break 'run 1;
			}
			optcind += 1;
		}
		let opch = s.get(optcind).copied().unwrap_or(0);
		optcind += 1;
		let optbuf: BString = if s[0] == b'+' {
			vec![b'+', opch].into()
		} else {
			vec![opch].into()
		};
		let p = optstr
			.iter()
			.position(|&c| c == opch)
			.filter(|_| opch != b':');
		let Some(p) = p else {
			if posix {
				optcind = 0;
				zoptind += 1;
			}
			if quiet {
				result = Some((b"?".into(), Some(optbuf)));
			} else {
				let sign = if s[0] == b'+' { '+' } else { '-' };
				ctx.diag(Diag::Usage { msg: format!("bad option: {sign}{}", char::from(opch)).into() });
				result = Some((b"?".into(), Some(BString::default())));
			}
			break 'run 0;
		};
		if optstr.get(p + 1) == Some(&b':') {
			let arg = if optcind == s.len() {
				let Some(a) = operands
					.get(usize::try_from(zoptind).unwrap_or(usize::MAX))
					.cloned()
				else {
					if posix {
						optcind = 0;
						zoptind += 1;
					}
					if quiet {
						result = Some((b":".into(), Some(optbuf)));
					} else {
						let sign = if s[0] == b'+' { '+' } else { '-' };
						ctx.diag(Diag::Usage {
							msg: format!("argument expected after {sign}{} option", char::from(opch))
								.into(),
						});
						result = Some((b"?".into(), Some(BString::default())));
					}
					break 'run 0;
				};
				zoptind += 1;
				a
			} else {
				BString::from(tail(&s, optcind))
			};
			optcind = 0;
			zoptind += 1;
			result = Some((optbuf, Some(arg)));
		} else {
			result = Some((optbuf, Some(BString::default())));
		}
		0
	};
	let ind_text = BString::from(zoptind.to_string());
	ctx.vp.getopts.optind = Some(ind_text.clone());
	ctx.vp.getopts.next =
		Some((u32::try_from(zoptind).unwrap_or(u32::MAX), u32::try_from(optcind).unwrap_or(0)));
	let r = zx(ctx, |ex| {
		params::assignsparam(ex, b"OPTIND", &ind_text, 0)?;
		if let Some((val, optarg)) = result {
			params::assignsparam(ex, &var, &val, 0)?;
			if let Some(a) = optarg {
				params::assignsparam(ex, b"OPTARG", &a, 0)?;
			}
		}
		Ok(())
	})?;
	match r {
		Ok(()) => done(status),
		Err(d) => zerr(ctx, d),
	}
}

/// Bytes still to read for `data` to hold `n` characters (UTF-8 sequences
/// when `utf8`): one per missing character, plus the rest of an incomplete
/// last sequence. Never more than the characters need, so nothing past
/// them is consumed.
fn bytes_wanted(data: &[u8], n: usize, utf8: bool) -> usize {
	if !utf8 {
		return n.saturating_sub(data.len());
	}
	let mut count = 0;
	let mut short = 0;
	let mut i = 0;
	while i < data.len() {
		let need = match data[i] {
			0xc2..=0xdf => 2,
			0xe0..=0xef => 3,
			0xf0..=0xf4 => 4,
			_ => 1,
		};
		count += 1;
		if i + need > data.len() && tail(data, i + 1).iter().all(|b| b & 0xc0 == 0x80) {
			short = i + need - data.len();
			break;
		}
		i += bstr::decode_utf8(tail(data, i)).1.max(1);
	}
	short + n.saturating_sub(count)
}

/// The bytes `read` takes in: everything up to the delimiter `delim` (a
/// character's bytes; more lines while a backslash continues them, unless
/// `raw`), or `nchars` characters (UTF-8 sequences when `utf8`); whether
/// input ended first.
#[expect(clippy::too_many_arguments, reason = "zsh bin_read's input loop")]
fn read_input(
	ctx: &mut Ctx<'_, '_>,
	fd: i32,
	delim: Option<&[u8]>,
	nchars: Option<usize>,
	utf8: bool,
	raw: bool,
	timeout_ns: Option<u64>,
	prompt: Option<&[u8]>,
) -> Result<(Vec<u8>, bool, bool), Need> {
	let mut data = Vec::new();
	let mut part = 0;
	// The probe stops at the delimiter's last byte; the whole sequence
	// must end the data.
	let stop = delim.and_then(|d| d.last().copied());
	loop {
		let want = nchars.map(|n| bytes_wanted(&data, n, utf8));
		let probe = Probe::Input { fd, delim: stop, lines: 1, nchars: want, part, timeout_ns };
		let answer = match ctx.probe(probe) {
			Ok(a) => a,
			Err(need) => {
				if part == 0
					&& let Some(p) = prompt
				{
					ctx.vp
						.out
						.push_back(PendingWrite { fd: 2, bytes: p.into(), off: 0 });
				}
				return Err(need);
			},
		};
		let ProbeResult::Input { data: d, eof, timed_out } = answer else {
			return Ok((data, true, false));
		};
		data.extend_from_slice(&d);
		if timed_out {
			return Ok((data, true, true));
		}
		if nchars.is_some_and(|n| bytes_wanted(&data, n, utf8) == 0) {
			return Ok((data, false, false));
		}
		let ended = delim.filter(|dl| !dl.is_empty() && data.ends_with(dl));
		if let Some(dl) = ended {
			let before = head(&data, data.len() - dl.len());
			let run = before.iter().rev().take_while(|&&c| c == b'\\').count();
			if raw || run % 2 == 0 {
				return Ok((data, false, false));
			}
		} else if eof {
			return Ok((data, true, false));
		}
		part += 1;
	}
}

/// The characters of `s` (UTF-8 sequences when `utf8`).
fn chars(s: &[u8], utf8: bool) -> Vec<&[u8]> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		let n = if utf8 {
			bstr::decode_utf8(tail(s, i)).1.max(1)
		} else {
			1
		};
		out.push(span(s, i, i + n));
		i += n;
	}
	out
}

/// zsh's `ISEP`/`IWSEP` classes over `$IFS`.
struct Ifs {
	ifs: BString,
}

impl Ifs {
	/// zsh `isep`: a character of `$IFS`.
	fn sep(&self, c: &[u8]) -> bool {
		(c.len() == 1 && self.ifs.contains(&c[0])) || (c.len() > 1 && self.ifs.find(c).is_some())
	}

	/// zsh `iwsep`: a blank or newline of `$IFS` that is not doubled.
	fn wsep(&self, c: &[u8]) -> bool {
		if c.len() != 1 || !matches!(c[0], b' ' | b'\t' | b'\n') {
			return false;
		}
		let doubled = [c[0], c[0]];
		self.ifs.contains(&c[0]) && self.ifs.find(doubled).is_none()
	}
}

/// A zsh `for` loop's control variable takes `value` (zsh `execfor`'s
/// `setsparam`): through zsh's parameter code, so an integer, float or
/// padded variable converts it. Called by the loop ops of zsh units.
///
/// # Errors
/// The assignment's diagnostic (read-only, a math error, a store failure).
#[inline(never)]
pub fn assign_zsh_loop_var(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	value: &[u8],
	line: u32,
) -> Result<(), Diag> {
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	match params::assignsparam(&mut ex, name, value, 0) {
		Ok(()) => Ok(()),
		Err(Stop::Fail(d) | Stop::Fatal(d)) => Err(d),
		Err(Stop::Store(e)) => {
			k.fail(e);
			Err(Diag::StoreFailed)
		},
		// A plain name's value is never expanded: nothing can park.
		Err(
			Stop::Sub { .. }
			| Stop::ZshSub { .. }
			| Stop::MathCall(_)
			| Stop::Probe(_)
			| Stop::Wait(_),
		) => Err(Diag::Unsupported { what: "a substitution in a `for' variable's assignment".into() }),
	}
}

/// `read_zle`'s answer: the bytes, then two status flags; `Err` is the
/// outcome to return while the editor runs a frame.
type ZleRead = Result<(Vec<u8>, bool, bool), Outcome>;

/// `read -k`/`-q` through the active editor (zsh `bin_read`'s `izle`:
/// `ZLE_CMD_GET_KEY` per byte): `nchars` characters (UTF-8 ones when
/// `utf8`). The prompt goes out first. `Err` is the outcome to return
/// while the editor runs a frame.
fn read_zle(
	ctx: &mut Ctx<'_, '_>,
	nchars: usize,
	utf8: bool,
	timeout_ns: Option<u64>,
	prompt: Option<&[u8]>,
) -> Result<ZleRead, Need> {
	use crate::bash::vm::zle::builtin::{ReadBytes, read_bytes, reading_bytes};
	if !reading_bytes(ctx.vp)
		&& let Some(p) = prompt
	{
		ctx.vp
			.out
			.push_back(PendingWrite { fd: 2, bytes: p.into(), off: 0 });
	}
	// zsh: the timeout in hundredths of a second, rounded up.
	let timeout_cs = timeout_ns.map(|ns| {
		i64::try_from(ns / 10_000_000)
			.unwrap_or(i64::MAX)
			.saturating_add(1)
	});
	let enough = |acc: &[u8]| -> bool {
		let mut count = 0;
		let mut i = 0;
		while i < acc.len() {
			let len = if utf8 {
				match acc[i] {
					0xc2..=0xdf => 2,
					0xe0..=0xef => 3,
					0xf0..=0xf4 => 4,
					_ => 1,
				}
			} else {
				1
			};
			if i + len > acc.len() {
				break;
			}
			count += 1;
			i += len;
		}
		count >= nchars
	};
	match read_bytes(ctx, timeout_cs, enough)? {
		ReadBytes::Got(data, ended) => Ok(Ok((data, ended, false))),
		ReadBytes::Outcome(o) => Ok(Err(o)),
	}
}

/// zsh `bin_read`.
#[expect(clippy::too_many_lines, reason = "one function, as zsh's bin_read")]
pub fn read(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let mut nchars: usize = 1;
	if let Some(a) = ops.arg(b'k').filter(|_| ops.hasarg(b'k')) {
		if let Some(n) = a.to_str().ok().and_then(|s| s.parse::<usize>().ok()) {
			nchars = n;
		} else {
			ctx.usage(format!("number expected after -k: {}", a.as_bstr()));
			return done(1);
		}
	}
	let mut args = args;
	let prompt_word = args.first().is_some_and(|a| a.first() == Some(&b'?'));
	let firstarg = args.first().cloned();
	if prompt_word {
		args = tail(args, 1);
	}
	let array = ops.isset(b'A');
	let mut reply: BString = match args.first() {
		Some(a) => {
			args = tail(args, 1);
			a.clone()
		},
		None => BString::from(if array { "reply" } else { "REPLY" }),
	};
	if array && !args.is_empty() {
		ctx.usage("only one array argument allowed");
		return done(1);
	}
	if ops.isset(b'l') || ops.isset(b'c') {
		return crate::bash::vm::zle::comp::compctl::compctlread(ctx, ops, args, &reply);
	}
	// `-z` (and `getln`): the line comes off the editor's buffer stack
	// (zsh `zbuf`: delimiters do not end it).
	let zbuf: Option<BString> = ops
		.isset(b'z')
		.then(|| crate::bash::vm::zle::vared::pop_line(ctx).unwrap_or_default());
	let keys = ops.isset(b'k') || ops.isset(b'q');
	let fd = if ops.isset(b'p') || ops.arg(b'u') == Some(b"p") {
		// The coprocess's output.
		let Some(co) = ctx.vp.coprocs.last() else {
			ctx.usage("-p: no coprocess");
			return done(1);
		};
		co.read
	} else if let Some(u) = ops.arg(b'u').filter(|_| ops.hasarg(b'u')) {
		if let Some(fd) = u.to_str().ok().and_then(|s| s.parse::<i32>().ok()) {
			fd
		} else {
			ctx.usage(format!("number expected after -u: {}", u.as_bstr()));
			return done(1);
		}
	} else {
		0
	};
	let is_tty = ctx.vp.fds.get(0).and_then(crate::bash::fd::FdRef::kind) == Some(FileKind::Tty);
	// The prompt after `?` in the first argument (shown on a terminal).
	let mut prompt: Option<Vec<u8>> = None;
	if let Some(first) = &firstarg
		&& let Some(q) = first.find_byte(b'?')
	{
		if keys || is_tty {
			prompt = Some(tail(first, q + 1).to_vec());
		}
		// `name?prompt`: the name ends at the `?`.
		if !prompt_word {
			reply = BString::from(head(&reply, q));
		}
	}
	let cs = charset(ctx)?;
	// zsh: the first character of `-d`'s argument (a byte without
	// multibyte), NUL for an empty one.
	let delim: Vec<u8> = match ops.arg(b'd').filter(|_| ops.isset(b'd')) {
		Some(d) => chars(d, cs.utf8)
			.first()
			.map_or_else(|| vec![0], |c| c.to_vec()),
		None => vec![b'\n'],
	};
	let timeout_ns = if ops.isset(b't') {
		let mut ns = 0u64;
		if let Some(t) = ops.arg(b't').filter(|_| ops.hasarg(b't')) {
			let text = crate::bash::syntax::zsh::tok::metafy(t);
			match zx(ctx, |ex| arith::matheval(ex, &text))? {
				Ok(Number::Float(d)) => ns = (d * 1e9).max(0.0) as u64,
				Ok(Number::Int(v)) => ns = u64::try_from(v).unwrap_or(0).saturating_mul(1_000_000_000),
				Err(d) => return zerr(ctx, d),
			}
		}
		Some(ns)
	} else {
		None
	};
	let raw = ops.isset(b'r');
	let (echo_only, echo) = (ops.isset(b'e'), ops.isset(b'E'));
	// zsh `izle`: with the editor active (a widget), `-k`/`-q` keys come
	// through it unless `-u`/`-p` name another source.
	let izle = keys && crate::bash::vm::zle::active(ctx.vp) && !ops.isset(b'u') && !ops.isset(b'p');
	if keys {
		let (data, eof, timed_out) = if izle {
			match read_zle(ctx, nchars, cs.utf8, timeout_ns, prompt.as_deref())? {
				Ok(r) => r,
				Err(o) => return Ok(o),
			}
		} else {
			read_input(ctx, fd, None, Some(nchars), cs.utf8, true, timeout_ns, prompt.as_deref())?
		};
		if timed_out && data.is_empty() {
			return done(if ops.isset(b'q') { 2 } else { 1 });
		}
		let mut buf = data;
		let mut status = i32::from(eof && buf.is_empty());
		if ops.isset(b'q') {
			status = if eof && buf.is_empty() {
				2
			} else {
				i32::from(buf.len() != 1 || !matches!(buf[0], b'y' | b'Y'))
			};
			buf = vec![if status != 0 { b'n' } else { b'y' }];
		}
		if echo_only || echo {
			ctx.out(&buf);
		}
		if !echo_only && let Err(d) = zx(ctx, |ex| params::assignsparam(ex, &reply, &buf, 0))? {
			return zerr(ctx, d);
		}
		return done(status);
	}
	let (data, _, timed_out) = match &zbuf {
		Some(z) => (z.to_vec(), true, false),
		None => read_input(ctx, fd, Some(&delim), None, cs.utf8, raw, timeout_ns, prompt.as_deref())?,
	};
	if timed_out && data.is_empty() {
		return done(1);
	}
	let ifs = zx(ctx, |ex| params::getsparam(ex, b"IFS"))?
		.ok()
		.flatten()
		.unwrap_or_else(|| BString::from(" \t\n\0"));
	let ifs = Ifs { ifs };
	let cv = chars(&data, cs.utf8);
	let mut pos = 0;
	let dl: &[u8] = if zbuf.is_some() { &[] } else { &delim };
	let mut first = true;
	let mut gotnl = false;
	let mut last: Option<&[u8]> = Some(b"");
	let mut assigns: Vec<(BString, BString)> = Vec::new();
	let mut list: Vec<BString> = Vec::new();
	let mut echoed: Vec<u8> = Vec::new();
	let mut names = args.iter();
	while !names.as_slice().is_empty() || (array && !gotnl) {
		let mut buf: Vec<u8> = Vec::new();
		let mut bslash = false;
		if !gotnl {
			loop {
				// `c`: the last character read; `None` is EOF.
				let c = cv.get(pos).copied();
				pos += 1;
				last = c;
				let Some(c) = c else {
					break;
				};
				if bslash && c == dl {
					bslash = false;
					continue;
				}
				if c == dl {
					break;
				}
				if !bslash && ifs.sep(c) {
					let ws = ifs.wsep(c);
					if !buf.is_empty() || (!ws && first) {
						first |= !ws;
						break;
					}
					first |= !ws;
					continue;
				}
				bslash = c == b"\\" && !bslash && !raw;
				if bslash {
					continue;
				}
				first = false;
				buf.extend_from_slice(c);
			}
		}
		if last.is_none_or(|c| c == dl) {
			gotnl = true;
		}
		if echo_only || (echo && !array) {
			echoed.extend_from_slice(&buf);
			echoed.push(b'\n');
		}
		if !echo_only && (!buf.is_empty() || first || gotnl) {
			if array {
				list.push(buf.into());
			} else {
				assigns.push((reply.clone(), buf.into()));
			}
		}
		if !array {
			match names.next() {
				Some(n) => reply = n.clone(),
				None => break,
			}
		}
	}
	let at_eof = last.is_none();
	if array {
		if echo {
			for l in &list {
				echoed.extend_from_slice(l);
				echoed.push(b'\n');
			}
		}
		ctx.out(&echoed);
		if !echo_only && let Err(d) = zx(ctx, |ex| params::assignaparam(ex, &reply, list, 0))? {
			return zerr(ctx, d);
		}
		if let Some(z) = &zbuf {
			return done(i32::from(z.is_empty()));
		}
		return done(i32::from(at_eof));
	}
	let mut buf: Vec<u8> = Vec::new();
	let mut bslash = false;
	if !gotnl {
		loop {
			let c = cv.get(pos).copied();
			pos += 1;
			last = c;
			let Some(c) = c else {
				break;
			};
			if bslash && c == dl {
				bslash = false;
				continue;
			}
			if c == dl {
				break;
			}
			if !bslash && ifs.sep(c) && buf.is_empty() {
				if ifs.wsep(c) {
					continue;
				} else if !first {
					first = true;
					continue;
				}
			}
			bslash = c == b"\\" && !bslash && !raw;
			if bslash {
				continue;
			}
			buf.extend_from_slice(c);
		}
	}
	// Trailing IFS whitespace goes.
	while let Some(&b) = buf.last() {
		if ifs.wsep(&[b]) {
			buf.pop();
		} else {
			break;
		}
	}
	if echo_only || echo {
		echoed.extend_from_slice(&buf);
		echoed.push(b'\n');
	}
	ctx.out(&echoed);
	if !echo_only {
		assigns.push((reply, buf.into()));
	}
	let r = zx(ctx, |ex| {
		for (n, v) in assigns {
			params::assignsparam(ex, &n, &v, 0)?;
		}
		Ok(())
	})?;
	if let Err(d) = r {
		ctx.diag(d);
		return done(1);
	}
	if let Some(z) = &zbuf {
		return done(i32::from(z.is_empty()));
	}
	done(i32::from(last.is_none()))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ifs_classes_follow_zsh_typtab() {
		let ifs = Ifs { ifs: BString::from(" \t\n:") };
		assert!(ifs.sep(b":") && !ifs.wsep(b":"));
		assert!(ifs.sep(b" ") && ifs.wsep(b" "));
		let doubled = Ifs { ifs: BString::from("  :") };
		assert!(doubled.sep(b" ") && !doubled.wsep(b" "));
	}

	#[test]
	fn characters_split_utf8_only_when_multibyte() {
		assert_eq!(chars("é".as_bytes(), true).len(), 1);
		assert_eq!(chars("é".as_bytes(), false).len(), 2);
	}
}
