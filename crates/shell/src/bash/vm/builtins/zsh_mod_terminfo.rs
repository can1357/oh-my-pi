//! zsh/terminfo: `echoti` and the `terminfo` special association, over the
//! terminal description of `$TERM` ([`terminfo_db`]).
//!
//! zsh reads `$TERM` itself (`init_term` when a non-interactive shell first
//! needs it): an empty `TERM` (`TERM_UNKNOWN`) or one without a usable
//! description (`TERM_BAD`) makes `echoti` fail silently and every
//! `terminfo` element unset. ncurses finds the description through the
//! exported `TERMINFO`, `TERMINFO_DIRS` and `HOME`, and takes the screen
//! size from exported `LINES` / `COLUMNS` (else, on a terminal, its size;
//! else the description's).
//!
//! Ported from zsh 5.9 `Src/Modules/terminfo.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).

use std::sync::Arc;

use bstr::{BStr, BString};

use super::{Ctx, R, done, zsh_args::Ops};
use crate::bash::{
	store::{Attrs, Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{
		expand::{Expander, X},
		proc::Vproc,
		state::{self, Root},
		zsh::{
			params::PValue,
			terminfo_db::{self, TParm, TermInfo},
		},
	},
	zshopt::ZshOpt,
};

/// A variable's value if it is exported (what ncurses' `getenv` sees).
fn exported(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<BString>, StoreError> {
	Ok(state::lookup(root, store, vp, name)?
		.filter(|v| v.attrs.contains(Attrs::EXPORT))
		.and_then(|v| v.as_scalar().map(BString::from)))
}

/// A variable's scalar value.
fn scalar(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<BString>, StoreError> {
	Ok(state::lookup(root, store, vp, name)?.and_then(|v| v.as_scalar().map(BString::from)))
}

/// ncurses `_nc_getenv_num`: the whole value as a C `strtol(…, 0)` number
/// (decimal, `0` octal, `0x` hex), -1 when it is not one.
fn env_num(s: &[u8]) -> i32 {
	let mut i = 0;
	while matches!(s.get(i), Some(b' ' | b'\t' | b'\n' | b'\x0b' | b'\x0c' | b'\r')) {
		i += 1;
	}
	let neg = s.get(i) == Some(&b'-');
	if matches!(s.get(i), Some(b'-' | b'+')) {
		i += 1;
	}
	let (radix, start) = match (s.get(i), s.get(i + 1)) {
		(Some(b'0'), Some(b'x' | b'X')) if s.get(i + 2).is_some_and(u8::is_ascii_hexdigit) => {
			(16, i + 2)
		},
		(Some(b'0'), _) => (8, i),
		_ => (10, i),
	};
	let digits = &s[start.min(s.len())..];
	if digits.is_empty() || !digits.iter().all(|&c| char::from(c).is_digit(radix)) {
		return -1;
	}
	let Ok(text) = std::str::from_utf8(digits) else {
		return -1;
	};
	match i64::from_str_radix(text, radix) {
		Ok(v) if !neg && v <= i64::from(i32::MAX) => v as i32,
		_ => -1,
	}
}

/// The terminal zsh set up for `$TERM` (`init_term` / `tgetent`), the
/// screen size applied as ncurses' `_nc_get_screensize` does; `None` when
/// `TERM` is empty or has no usable description (`echoti` then fails
/// silently). A success is the terminal ncurses holds from then on
/// ([`held_term`]).
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn current_term(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) -> Result<Option<Arc<TermInfo>>, StoreError> {
	let term = scalar(root, store, vp, b"TERM")?.unwrap_or_default();
	// An empty `TERM` never reaches `tgetent`.
	if term.is_empty() {
		return Ok(None);
	}
	let ti = setup(root, store, vp, &term, true)?;
	if ti.is_some() {
		hold(root, store, vp, HELD_TGETENT, &term)?;
	} else if let Some((HELD_TGETENT, name)) = held(store, vp)? {
		// A failed `tgetent` keeps `cur_term` but clears `FIX_SGR0`.
		hold(root, store, vp, HELD_STALE, &name)?;
	}
	Ok(ti)
}

/// The held terminal was set up by `setupterm` only (a module's boot).
const HELD_SETUPTERM: u8 = b'S';
/// The held terminal was set up by `tgetent`.
const HELD_TGETENT: u8 = b'T';
/// The held terminal was set up by `tgetent`, and a later `tgetent` failed
/// (clearing `FIX_SGR0`).
const HELD_STALE: u8 = b'F';

/// The terminal ncurses holds: how it was set up (`HELD_*`) and its name.
fn held(store: &mut dyn StateStore, vp: &Vproc) -> Result<Option<(u8, BString)>, StoreError> {
	Ok(match state::record(store, vp, Key::Misc(MiscKey::ZshCurTerm))? {
		Some(Record::Misc(r)) if !r.is_empty() => Some((r[0], BString::from(&r[1..]))),
		_ => None,
	})
}

/// The terminal ncurses holds (`cur_term`), which zsh's scans of
/// `terminfo` and `termcap` read without setting up `$TERM`: the last one
/// set up successfully ([`current_term`], or the exported `TERM` when the
/// module booted). An interactive zsh sets up every new `$TERM` at once.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn held_term(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) -> Result<Option<Arc<TermInfo>>, StoreError> {
	if state::zsh_option(root, store, vp, ZshOpt::Interactive)?
		&& let Some(ti) = current_term(root, store, vp)?
	{
		return Ok(Some(ti));
	}
	let Some((how, name)) = held(store, vp)? else {
		return Ok(None);
	};
	let ti = setup(root, store, vp, &name, how != HELD_SETUPTERM)?;
	Ok(if how == HELD_STALE {
		ti.map(|t| t.without_fix_sgr0())
	} else {
		ti
	})
}

/// zsh/terminfo's and zsh/termcap's `boot_` (`zsetupterm`): the first of
/// them to load has ncurses set up the exported `TERM`.
///
/// # Errors
/// [`StoreError`] when a variable cannot be read.
pub fn boot(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) -> Result<(), StoreError> {
	if held(store, vp)?.is_some() {
		return Ok(());
	}
	let term = exported(root, store, vp, b"TERM")?.unwrap_or_default();
	if setup(root, store, vp, &term, false)?.is_some() {
		hold(root, store, vp, HELD_SETUPTERM, &term)?;
	}
	Ok(())
}

/// Record `name`, set up as `how` (`HELD_*`), as the terminal ncurses
/// holds.
fn hold(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	how: u8,
	name: &[u8],
) -> Result<(), StoreError> {
	if held(store, vp)?.is_some_and(|(h, n)| h == how && n.as_slice() == name) {
		return Ok(());
	}
	let mut rec = BString::from(vec![how]);
	rec.extend_from_slice(name);
	state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::ZshCurTerm), Some(Record::Misc(rec)));
	Ok(())
}

/// The description of terminal `name` as ncurses sets it up (`tgetent`,
/// else `setupterm` only): found through the exported `TERMINFO`,
/// `TERMINFO_DIRS`, `HOME`, sized by the exported `LINES`/`COLUMNS` (an
/// interactive zsh keeps them at the terminal's size).
fn setup(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	term: &[u8],
	tgetent: bool,
) -> Result<Option<Arc<TermInfo>>, StoreError> {
	if term.is_empty() {
		return Ok(None);
	}
	let terminfo = exported(root, store, vp, b"TERMINFO")?;
	let dirs = exported(root, store, vp, b"TERMINFO_DIRS")?;
	let home = exported(root, store, vp, b"HOME")?;
	let env = terminfo_db::TermEnv {
		terminfo:      terminfo.as_deref().map(|v| v.as_slice()),
		terminfo_dirs: dirs.as_deref().map(|v| v.as_slice()),
		home:          home.as_deref().map(|v| v.as_slice()),
	};
	let found = if tgetent {
		terminfo_db::load(term, &env)
	} else {
		terminfo_db::load_raw(term, &env)
	};
	let Some(ti) = found else {
		return Ok(None);
	};
	// A terminal's size: zsh keeps `LINES`/`COLUMNS` at it in an
	// interactive shell; the exported values override it.
	let interactive = state::zsh_option(root, store, vp, ZshOpt::Interactive)?;
	let mut size = [0i32; 2];
	for (slot, name) in size.iter_mut().zip([&b"LINES"[..], b"COLUMNS"]) {
		let env = exported(root, store, vp, name)?.map_or(-1, |v| env_num(&v));
		*slot = if env > 0 {
			env
		} else if interactive {
			scalar(root, store, vp, name)?.map_or(-1, |v| env_num(&v))
		} else {
			-1
		};
	}
	Ok(Some(ti.with_size(size[0], size[1])))
}

/// C `atoi` of a builtin argument.
pub(super) fn atoi(s: &[u8]) -> i32 {
	let mut i = 0;
	while matches!(s.get(i), Some(b' ' | b'\t' | b'\n' | b'\x0b' | b'\x0c' | b'\r')) {
		i += 1;
	}
	let neg = s.get(i) == Some(&b'-');
	if matches!(s.get(i), Some(b'-' | b'+')) {
		i += 1;
	}
	let mut n: i32 = 0;
	while let Some(&c) = s.get(i).filter(|c| c.is_ascii_digit()) {
		n = n.wrapping_mul(10).wrapping_add(i32::from(c - b'0'));
		i += 1;
	}
	if neg { n.wrapping_neg() } else { n }
}

/// The capabilities whose parameters after the first are strings (zsh's
/// `strcap`).
const STRCAP: [&[u8]; 5] = [b"pfkey", b"pfloc", b"pfx", b"pln", b"pfxl"];

/// zsh `bin_echoti`: print terminfo capability `CAP` (a number, `yes` /
/// `no` for a boolean, a string instantiated with up to nine parameters).
pub fn echoti(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let Some(ti) = current_term(&mut ctx.k.root, ctx.cx.store, ctx.vp)? else {
		return done(1);
	};
	let Some((cap, rest)) = args.split_first() else {
		return done(1);
	};
	let s: &[u8] = cap;
	if let Some(n) = ti.num(s) {
		ctx.out(format!("{n}\n").as_bytes());
		return done(0);
	}
	match ti.flag_known(s) {
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
	let Some(t) = ti.str(s).filter(|t| !t.is_empty()) else {
		ctx.usage(format!("no such terminfo capability: {}", BStr::new(s)));
		return done(1);
	};
	if rest.len() > 9 {
		ctx.usage("too many arguments");
		return done(1);
	}
	if rest.is_empty() {
		let out = terminfo_db::tputs(t);
		ctx.out(&out);
		return done(0);
	}
	let strarg = STRCAP.contains(&s);
	let pars: Vec<TParm<'_>> = rest
		.iter()
		.enumerate()
		.map(|(i, a)| {
			if strarg && i > 0 {
				TParm::Str(a)
			} else {
				TParm::Num(atoi(a))
			}
		})
		.collect();
	let out = terminfo_db::tputs(&terminfo_db::tparm(t, &pars));
	ctx.out(&out);
	done(0)
}

/// zsh `getterminfo`: element `name` of `terminfo` (a number, `yes`/`no`,
/// a string); `None` (unset) for no capability or no terminal.
///
/// # Errors
/// [`Stop::Store`](crate::bash::vm::expand::Stop) when a variable cannot be
/// read.
pub fn get(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	let Some(ti) = current_term(&mut ex.k.root, ex.cx.store, ex.vp)? else {
		return Ok(None);
	};
	if let Some(n) = ti.num(name) {
		return Ok(Some(BString::from(n.to_string())));
	}
	if let Some(on) = ti.flag_known(name) {
		return Ok(Some(BString::from(if on { "yes" } else { "no" })));
	}
	Ok(ti.str(name).map(BString::from))
}

/// zsh `scanterminfo`: every standard capability of the terminal ncurses
/// holds ([`held_term`]), in ncurses' order (booleans, set or not;
/// numbers; strings); nothing without one.
///
/// # Errors
/// [`Stop::Store`](crate::bash::vm::expand::Stop) when a variable cannot be
/// read.
pub fn scan(ex: &mut Expander<'_, '_>) -> X<Option<PValue>> {
	let Some(ti) = held_term(&mut ex.k.root, ex.cx.store, ex.vp)? else {
		return Ok(Some(PValue::Hash(Vec::new())));
	};
	let mut out: Vec<(BString, BString)> = Vec::new();
	for n in terminfo_db::bool_names() {
		if let Some(on) = ti.flag_known(n) {
			out.push((BString::from(n), BString::from(if on { "yes" } else { "no" })));
		}
	}
	for n in terminfo_db::num_names() {
		if let Some(v) = ti.num(n) {
			out.push((BString::from(n), BString::from(v.to_string())));
		}
	}
	for n in terminfo_db::str_names() {
		if let Some(v) = ti.str(n) {
			out.push((BString::from(n), BString::from(v)));
		}
	}
	Ok(Some(PValue::Hash(out)))
}
