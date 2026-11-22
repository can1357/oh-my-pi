//! zsh/termcap: `echotc` and the `termcap` special association, the
//! termcap view (ncurses `tgetflag`/`tgetnum`/`tgetstr`/`tgoto`) of the
//! terminal zsh set up for `$TERM` (see [`super::zsh_mod_terminfo`]).
//!
//! Ported from zsh 5.9 `Src/Modules/termcap.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BStr, BString};

use super::{
	Ctx, R, done,
	zsh_args::Ops,
	zsh_mod_terminfo::{atoi, current_term, held_term},
};
use crate::bash::vm::{
	expand::{Expander, X},
	zsh::{
		params::PValue,
		terminfo_db::{self, TermInfo},
	},
};

/// zsh `ztgetflag`: `Some(true)` for a set flag; `Some(false)` for an
/// unset one whose code is a standard boolean code (ncurses cannot tell
/// an unset flag from no flag); `None` otherwise.
fn ztgetflag(ti: Option<&TermInfo>, code: &[u8]) -> Option<bool> {
	if ti.is_some_and(|ti| ti.tc_flag(code)) {
		return Some(true);
	}
	terminfo_db::is_bool_code(code).then_some(false)
}

/// zsh `bin_echotc`: print termcap capability `CAP` (a number, `yes` /
/// `no` for a boolean, a string; `cm`-like strings take their `%d %2 %3
/// %. %+` arguments, row then column).
pub fn echotc(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let Some(ti) = current_term(&mut ctx.k.root, ctx.cx.store, ctx.vp)? else {
		return done(1);
	};
	let Some((cap, rest)) = args.split_first() else {
		return done(1);
	};
	let s: &[u8] = cap;
	if let Some(n) = ti.tc_num(s) {
		ctx.out(format!("{n}\n").as_bytes());
		return done(0);
	}
	match ztgetflag(Some(&*ti), s) {
		Some(true) => {
			ctx.out(b"yes\n");
			return done(0);
		},
		Some(false) => {
			ctx.out(b"no\n");
			return done(0);
		},
		None => {},
	}
	let Some(t) = ti.tc_str(s).filter(|t| !t.is_empty() && t[0] != 0) else {
		ctx.usage(format!("no such capability: {}", BStr::new(s)));
		return done(1);
	};
	// The arguments the string takes: a `%` before `d 2 3 . +` (the byte
	// after any `%` is skipped).
	let mut argct = 0;
	let mut u = 0;
	while u < t.len() && t[u] != 0 {
		if t[u] == b'%' {
			u += 1;
			if matches!(t.get(u), Some(b'd' | b'2' | b'3' | b'.' | b'+')) {
				argct += 1;
			}
			if u >= t.len() {
				break;
			}
		}
		u += 1;
	}
	if rest.len() != argct {
		ctx.usage(if rest.len() < argct {
			"not enough arguments"
		} else {
			"too many arguments"
		});
		return done(1);
	}
	let out = if argct == 0 {
		terminfo_db::tputs(&t)
	} else {
		// Arguments `<lines> <columns>` as for `cm`.
		let row = atoi(&rest[0]);
		let col = rest.get(1).map_or(row, |a| atoi(a));
		terminfo_db::tputs(&terminfo_db::tgoto_bc(&t, col, row, ti.bc()))
	};
	ctx.out(&out);
	done(0)
}

/// zsh `gettermcap`: element `name` of `termcap` (a number, `yes`/`no`, a
/// string); `None` (unset) for no capability or no terminal.
///
/// # Errors
/// [`Stop::Store`](crate::bash::vm::expand::Stop) when a variable cannot be
/// read.
pub fn get(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	let Some(ti) = current_term(&mut ex.k.root, ex.cx.store, ex.vp)? else {
		return Ok(None);
	};
	if let Some(n) = ti.tc_num(name) {
		return Ok(Some(BString::from(n.to_string())));
	}
	if let Some(on) = ztgetflag(Some(&*ti), name) {
		return Ok(Some(BString::from(if on { "yes" } else { "no" })));
	}
	Ok(ti.tc_str(name).map(BString::from))
}

/// zsh `scantermcap`: every standard boolean code (`yes`/`no`), then the
/// numbers and strings of the terminal ncurses holds ([`held_term`]), in
/// ncurses' order. Without one ncurses still answers "unset" for every
/// boolean code.
///
/// # Errors
/// [`Stop::Store`](crate::bash::vm::expand::Stop) when a variable cannot be
/// read.
pub fn scan(ex: &mut Expander<'_, '_>) -> X<Option<PValue>> {
	let ti = held_term(&mut ex.k.root, ex.cx.store, ex.vp)?;
	let ti = ti.as_deref();
	let mut out: Vec<(BString, BString)> = Vec::new();
	for c in terminfo_db::bool_codes() {
		if let Some(on) = ztgetflag(ti, c.as_bytes()) {
			out.push((BString::from(c), BString::from(if on { "yes" } else { "no" })));
		}
	}
	if let Some(ti) = ti {
		for c in terminfo_db::num_codes() {
			if let Some(v) = ti.tc_num(c) {
				out.push((BString::from(c), BString::from(v.to_string())));
			}
		}
		for c in terminfo_db::str_codes() {
			if let Some(v) = ti.tc_str(c) {
				out.push((BString::from(c), BString::from(v)));
			}
		}
	}
	Ok(Some(PValue::Hash(out)))
}
