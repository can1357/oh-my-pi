//! Modes: a vproc's current mode, zsh emulation
//! (`emulate`, zsh `installemulation`), the grammar a mode parses with,
//! and what a function call switches and restores (zsh `doshfunc`'s
//! `funcsave`, sticky emulation).
//!
//! A call into zsh-dialect code, and any call that switches the mode,
//! keeps a [`ZshScope`] with its scope (the root's in the store,
//! `terminal.ts` `scopes[i].zsh`); a bash call within the bash dialect keeps
//! nothing (the bash paths do no extra work).
//!
//! zsh parts are ported from zsh 5.9 `options.c` and `exec.c` (MIT-style
//! licence, Copyright (c) 1992-1997 Paul Falstad and the zsh development
//! group).

use bstr::BString;
use strum::IntoEnumIterator;

use super::{
	Cx, Kernel,
	proc::Vproc,
	state::{self, Root},
};
use crate::bash::{
	diag::Diag,
	ids::{Dialect, ModeId},
	store::{Key, KeyBuf, LossyKind, MiscKey, Record, StateStore, Sticky, StoreError, ZshScope},
	syntax::Features,
	zshopt::{ZshOpt, ZshOpts},
};

/// Report a lossy mode crossing (`Diag::ModeLossy`) once per
/// kind per crossing: the innermost mode-switching call's scope keeps the
/// bits ([`ZshScope::lossy`]); outside any, the run does.
pub fn report_lossy(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	kind: LossyKind,
	what: String,
) {
	let bit = kind.bit();
	let count = state::scope_count(&k.root, vp);
	let mut crossing = None;
	for i in (0..count).rev() {
		match state::scope_zsh(cx.store, vp, i) {
			Ok(Some(z)) => {
				crossing = Some((i, z));
				break;
			},
			Ok(None) => {},
			Err(err) => {
				k.fail(err);
				return;
			},
		}
	}
	match crossing {
		Some((i, mut z)) => {
			if z.lossy & bit != 0 {
				return;
			}
			z.lossy |= bit;
			state::set_scope_zsh(&mut k.root, cx.store, vp, i, Some(z));
		},
		None => match vp.runs.front_mut() {
			Some(run) if run.lossy & bit != 0 => return,
			Some(run) => run.lossy |= bit,
			None => {},
		},
	}
	k.diag(cx, vp, line, Diag::ModeLossy { what: what.into() });
}

/// Make `mode` `vp`'s current mode; the root's is written through as
/// [`MiscKey::Mode`].
pub fn set_mode(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, mode: ModeId) {
	if vp.mode == mode {
		return;
	}
	vp.mode = mode;
	if vp.overlay.is_none() {
		root.set_misc(store, MiscKey::Mode, <&'static str>::from(mode));
	}
}

/// zsh `installemulation(mode, fully)` on `vp`'s zsh options: each
/// emulation-relevant option (every non-special one when `full`, `emulate
/// -R`) takes `mode`'s default.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn install_zsh_emulation(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	mode: ModeId,
	full: bool,
) -> Result<(), StoreError> {
	for opt in ZshOpt::iter() {
		if (full && !opt.special()) || opt.emulation_relevant() {
			state::set_zsh_option(root, store, vp, opt, opt.default_in(mode))?;
		}
	}
	Ok(())
}

/// The options `emulate [-R] MODE` would leave (zsh `emulate` into a copy
/// of `cur`): for `emulate -l` and `emulate … -c`.
pub fn emulated_options(cur: &ZshOpts, mode: ModeId, full: bool) -> ZshOpts {
	let mut new = *cur;
	for opt in ZshOpt::iter() {
		if (full && !opt.special()) || opt.emulation_relevant() {
			new.set(opt, opt.default_in(mode));
		}
	}
	new
}

/// Switch `vp` to emulation `mode` (`emulate MODE`, `emulate -R MODE`):
/// zsh-dialect modes install zsh's emulation defaults, `sh` from bash is
/// posix mode (`emulate -R` first resets every bash option), `bash` turns
/// posix mode off.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn emulate(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	mode: ModeId,
	full: bool,
) -> Result<(), StoreError> {
	match mode.dialect() {
		Dialect::Zsh => install_zsh_emulation(root, store, vp, mode, full)?,
		Dialect::Bash => {
			if full {
				state::reset_options(root, store, vp);
			}
			state::set_posix(root, store, vp, mode == ModeId::Sh)?;
			state::sync_option_vars(root, store, vp)?;
		},
	}
	set_mode(root, store, vp, mode);
	Ok(())
}

/// The grammar switches of code parsed in `vp`'s mode: bash's `base`
/// (extglob, posix mode, charset) in the bash dialect; zsh's grammar and
/// its parse-affecting options in the zsh dialect (zsh `lex.c`/`parse.c`
/// `isset` tests).
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn features(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	base: Features,
) -> Result<Features, StoreError> {
	if vp.mode.dialect() == Dialect::Bash {
		return Ok(base);
	}
	zsh_features(root, store, vp, base)
}

/// [`features`] in the zsh dialect. Out of line: the bash parse path does
/// not carry it.
#[inline(never)]
fn zsh_features(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	base: Features,
) -> Result<Features, StoreError> {
	// Only the charset flags carry over from the bash switches.
	let charset = Features::from_bits(
		base.bits()
			& (Features::DOUBLE_BYTE.bits() | Features::GB18030.bits() | Features::SHIFT_JIS.bits()),
	);
	let mut f = charset | Features::ZSH;
	for (opt, on, bit) in [
		(ZshOpt::Shglob, true, Features::ZSH_SH_GLOB),
		(ZshOpt::Shortloops, true, Features::ZSH_SHORT_LOOPS),
		(ZshOpt::Shortrepeat, true, Features::ZSH_SHORT_REPEAT),
		(ZshOpt::Ignorebraces, true, Features::ZSH_IGNORE_BRACES),
		(ZshOpt::Ignoreclosebraces, true, Features::ZSH_IGNORE_CLOSE_BRACES),
		(ZshOpt::Cshjunkiequotes, true, Features::ZSH_CSH_JUNKIE_QUOTES),
		(ZshOpt::Cshjunkieloops, true, Features::ZSH_CSH_JUNKIE_LOOPS),
		(ZshOpt::Posixaliases, true, Features::ZSH_POSIX_ALIASES),
		(ZshOpt::Kshglob, true, Features::ZSH_KSH_GLOB),
		(ZshOpt::Rcquotes, true, Features::ZSH_RC_QUOTES),
		(ZshOpt::Posixbuiltins, true, Features::ZSH_POSIX_BUILTINS),
		(ZshOpt::Multifuncdef, true, Features::ZSH_MULTI_FUNC_DEF),
		(ZshOpt::Aliases, false, Features::ZSH_NO_ALIASES),
		(ZshOpt::Aliasfuncdef, true, Features::ZSH_ALIAS_FUNC_DEF),
	] {
		if state::zsh_option(root, store, vp, opt)? == on {
			f = f | bit;
		}
	}
	// zsh reads comments in a non-interactive shell whatever
	// `interactivecomments` says.
	if !state::zsh_option(root, store, vp, ZshOpt::Interactive)?
		|| state::zsh_option(root, store, vp, ZshOpt::Interactivecomments)?
	{
		f = f | Features::ZSH_INTERACTIVE_COMMENTS;
	}
	Ok(f)
}

/// zsh `sticky_emulation_differs`: whether calling a function with
/// `sticky` must switch emulation (its sticky emulation is not the one in
/// effect).
pub fn sticky_differs(vp: &Vproc, sticky: Option<&Sticky>) -> bool {
	sticky.is_some_and(|s| vp.sticky() != Some(s))
}

/// Apply a sticky emulation on entry (zsh `doshfunc`): the emulation's
/// options (`emulate [-R] MODE`), then its `-o`/`+o` options.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn apply_sticky(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	sticky: &Sticky,
) -> Result<(), StoreError> {
	emulate(root, store, vp, sticky.mode, sticky.full)?;
	for &opt in &sticky.on {
		state::set_zsh_option(root, store, vp, opt, true)?;
	}
	for &opt in &sticky.off {
		state::set_zsh_option(root, store, vp, opt, false)?;
	}
	vp.set_sticky(Some(sticky.clone()));
	Ok(())
}

/// Enter a function defined in `func_mode` with sticky emulation `sticky`
/// (zsh `doshfunc`'s entry, and the cross-dialect switch). `None`
/// for a bash function called from bash code: nothing to save, nothing
/// switched. Otherwise what the call's return restores ([`leave_call`]),
/// kept with the call's scope.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn enter_call(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	func_mode: ModeId,
	sticky: Option<&Sticky>,
) -> Result<Option<Box<ZshScope>>, StoreError> {
	let switch_sticky = sticky_differs(vp, sticky);
	let cross = func_mode.dialect() != vp.mode.dialect();
	if func_mode.dialect() == Dialect::Bash && !cross && !switch_sticky {
		return Ok(None);
	}
	// zsh saves every option at every call (`LOCAL_OPTIONS` decides at the
	// return whether they come back).
	let opts = state::zsh_options(root, store, vp)?;
	let saved = Box::new(ZshScope {
		mode: vp.mode,
		opts,
		sticky: vp.sticky().cloned(),
		restore_sticky: switch_sticky,
		traps: Vec::new(),
		lossy: 0,
		pat_disables: pat_disables(store, vp)?,
	});
	match sticky {
		Some(s) if switch_sticky => apply_sticky(root, store, vp, s)?,
		_ if cross => set_mode(root, store, vp, func_mode),
		_ => {},
	}
	if func_mode.dialect() == Dialect::Zsh {
		// zsh `doshfunc`: a function never inherits `printexitvalue`.
		state::set_zsh_option(root, store, vp, ZshOpt::Printexitvalue, false)?;
	}
	Ok(Some(saved))
}

/// A call [`enter_call`] saved `saved` for returns (zsh `doshfunc`'s
/// exit): after a sticky switch the options, mode and sticky emulation come
/// back; otherwise under `localoptions` (a zsh body's) the options and the
/// mode do, `privileged` and `restricted` excepted; a call that crossed
/// dialects always gets its caller's mode back.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn leave_call(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	saved: ZshScope,
	zsh_body: bool,
) -> Result<(), StoreError> {
	// zsh `endpatternscope`, before the options come back: the body's own
	// `localpatterns` decides.
	if zsh_body
		&& state::zsh_option(root, store, vp, ZshOpt::Localpatterns)?
		&& pat_disables(store, vp)? != saved.pat_disables
	{
		let words = saved.pat_disables.clone();
		let rec = (!words.is_empty()).then_some(Record::Words(words));
		state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::ZshPatDisables), rec);
	}
	if saved.restore_sticky {
		state::set_zsh_options(root, store, vp, &saved.opts)?;
		// A bash-dialect caller gets the posix mode its emulation implies
		// back (`emulate sh -c` from bash turned it on).
		if saved.mode.dialect() == Dialect::Bash
			&& state::option(root, store, vp, crate::bash::store::OptId::Posix)?
				!= (saved.mode == ModeId::Sh)
		{
			state::set_posix(root, store, vp, saved.mode == ModeId::Sh)?;
			state::sync_option_vars(root, store, vp)?;
		}
		set_mode(root, store, vp, saved.mode);
		vp.set_sticky(saved.sticky);
		return Ok(());
	}
	if zsh_body {
		// zsh `doshfunc`: the caller's `printexitvalue` and `warnnestedvar`
		// (`functions -W`) always come back.
		for opt in [ZshOpt::Printexitvalue, ZshOpt::Warnnestedvar] {
			state::set_zsh_option(root, store, vp, opt, saved.opts.get(opt))?;
		}
	}
	if zsh_body && state::zsh_option(root, store, vp, ZshOpt::Localoptions)? {
		let mut want = saved.opts;
		for opt in [ZshOpt::Privileged, ZshOpt::Restricted] {
			want.set(opt, state::zsh_option(root, store, vp, opt)?);
		}
		state::set_zsh_options(root, store, vp, &want)?;
		set_mode(root, store, vp, saved.mode);
		return Ok(());
	}
	if vp.mode.dialect() != saved.mode.dialect() {
		set_mode(root, store, vp, saved.mode);
	}
	Ok(())
}

/// What `emulate MODE … -c CMD` restores after `CMD` (zsh `bin_emulate`):
/// options, mode and sticky emulation, unconditionally.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn save_for_emulate(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Box<ZshScope>, StoreError> {
	Ok(Box::new(ZshScope {
		mode:           vp.mode,
		opts:           state::zsh_options(root, store, vp)?,
		sticky:         vp.sticky().cloned(),
		restore_sticky: true,
		traps:          Vec::new(),
		lossy:          0,
		pat_disables:   pat_disables(store, vp)?,
	}))
}

/// The pattern features `disable -p` has turned off for `vp`.
fn pat_disables(store: &mut dyn StateStore, vp: &Vproc) -> Result<Vec<BString>, StoreError> {
	Ok(match state::record(store, vp, Key::Misc(MiscKey::ZshPatDisables))? {
		Some(Record::Words(w)) => w.clone(),
		_ => Vec::new(),
	})
}

/// How a new zsh-dialect shell starts ([`init_zsh_options`]).
pub struct ZshStart<'a> {
	/// Its emulation.
	pub mode:        ModeId,
	/// The command line's options, in order.
	pub options:     &'a [(ZshOpt, bool)],
	/// Interactive.
	pub interactive: bool,
	/// A login shell.
	pub login:       bool,
	/// Commands come from standard input.
	pub stdin:       bool,
}

/// A new zsh-dialect shell's options (zsh `parseargs`'s
/// `parseopts_setemulate`, then the command line's): the emulation's full
/// defaults, `interactive`, `login` and `shinstdin` from the invocation,
/// the command line's options in order, then `monitor` and `hashdirs`
/// following `interactive` unless set explicitly.
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn init_zsh_options(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	start: &ZshStart<'_>,
) -> Result<(), StoreError> {
	install_zsh_emulation(root, store, vp, start.mode, true)?;
	for (opt, on) in [
		(ZshOpt::Login, start.login),
		(ZshOpt::Interactive, start.interactive),
		(ZshOpt::Shinstdin, start.stdin),
		(ZshOpt::Singlecommand, false),
		(ZshOpt::Zle, false),
	] {
		state::set_zsh_option(root, store, vp, opt, on)?;
	}
	for &(opt, on) in start.options {
		state::set_zsh_option(root, store, vp, opt, on)?;
	}
	for opt in [ZshOpt::Monitor, ZshOpt::Hashdirs] {
		if !start.options.iter().any(|(o, _)| *o == opt) {
			let on = state::zsh_option(root, store, vp, ZshOpt::Interactive)?;
			state::set_zsh_option(root, store, vp, opt, on)?;
		}
	}
	set_mode(root, store, vp, start.mode);
	Ok(())
}

#[cfg(test)]
mod tests {
	use bstr::BString;

	use super::*;
	use crate::bash::{
		fd::FdTable,
		ids::Vpid,
		store::{Key, OptId, Record, Table},
	};

	fn shell(mode: ModeId) -> (crate::bash::MemStore, Root, Vproc) {
		let mut store = crate::bash::MemStore::new();
		let root = Root::load(&mut store).unwrap();
		let mut vp = Vproc::new(Vpid(1), None, FdTable::default(), BString::from("/"), None, false);
		vp.mode = mode;
		(store, root, vp)
	}

	fn zopt(r: &mut Root, s: &mut crate::bash::MemStore, vp: &Vproc, o: ZshOpt) -> bool {
		state::zsh_option(r, s, vp, o).unwrap()
	}

	fn zset(r: &mut Root, s: &mut crate::bash::MemStore, vp: &mut Vproc, o: ZshOpt, on: bool) {
		state::set_zsh_option(r, s, vp, o, on).unwrap();
	}

	fn zsh_records(s: &mut crate::bash::MemStore) -> usize {
		let mut n = 0;
		s.scan(Table::ZshOpt, &mut |_, _| n += 1).unwrap();
		n
	}

	/// Env options are one value seen from both dialects; mode options
	/// are zsh's own records.
	#[test]
	fn env_options_are_shared_and_mode_options_are_not() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Nomatch), "zsh default");
		zset(&mut r, &mut s, &mut vp, ZshOpt::Errexit, true);
		zset(&mut r, &mut s, &mut vp, ZshOpt::Clobber, false);
		assert!(state::option(&mut r, &mut s, &vp, OptId::Errexit).unwrap());
		assert!(state::option(&mut r, &mut s, &vp, OptId::Noclobber).unwrap());
		assert_eq!(zsh_records(&mut s), 0, "twins live under Key::Opt only");
		zset(&mut r, &mut s, &mut vp, ZshOpt::Ksharrays, true);
		assert_eq!(s.get(Key::ZshOpt(ZshOpt::Ksharrays)).unwrap(), Some(&Record::Opt(true)));
		// A bash option of a similar name is untouched by zsh's.
		zset(&mut r, &mut s, &mut vp, ZshOpt::Nullglob, true);
		assert!(!state::option(&mut r, &mut s, &vp, OptId::Nullglob).unwrap());
	}

	/// `emulate sh` resolves in the current dialect: zsh's sh emulation
	/// from zsh code, posix mode from bash code.
	#[test]
	fn emulate_sh_stays_in_the_dialect() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		emulate(&mut r, &mut s, &mut vp, ModeId::Zsh.for_emulate(b"sh").unwrap(), false).unwrap();
		assert_eq!(vp.mode, ModeId::ZshSh);
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Shwordsplit));
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Nomatch));
		assert_eq!(s.get(Key::Misc(MiscKey::Mode)).unwrap(), Some(&Record::Misc("zsh-sh".into())));
		let (mut s, mut r, mut vp) = shell(ModeId::Bash);
		emulate(&mut r, &mut s, &mut vp, ModeId::Bash.for_emulate(b"sh").unwrap(), false).unwrap();
		assert_eq!(vp.mode, ModeId::Sh);
		assert!(state::option(&mut r, &mut s, &vp, OptId::Posix).unwrap());
		assert_eq!(zsh_records(&mut s), 0, "bash emulation leaves zsh options alone");
	}

	/// `emulate -R` resets every non-special option; plain `emulate` only
	/// the emulation-relevant ones.
	#[test]
	fn emulate_r_resets_more_than_emulate() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		assert!(!ZshOpt::Alwaystoend.emulation_relevant());
		zset(&mut r, &mut s, &mut vp, ZshOpt::Alwaystoend, true);
		zset(&mut r, &mut s, &mut vp, ZshOpt::Shwordsplit, true);
		emulate(&mut r, &mut s, &mut vp, ModeId::Zsh, false).unwrap();
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Alwaystoend));
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Shwordsplit));
		emulate(&mut r, &mut s, &mut vp, ModeId::Zsh, true).unwrap();
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Alwaystoend));
	}

	/// A bash function called from bash code saves and switches nothing.
	#[test]
	fn bash_calls_within_bash_keep_no_zsh_state() {
		let (mut s, mut r, mut vp) = shell(ModeId::Bash);
		assert!(
			enter_call(&mut r, &mut s, &mut vp, ModeId::Bash, None)
				.unwrap()
				.is_none()
		);
		assert!(
			enter_call(&mut r, &mut s, &mut vp, ModeId::Sh, None)
				.unwrap()
				.is_none()
		);
		assert_eq!(vp.mode, ModeId::Bash);
	}

	/// A zsh body's option changes come back at its return only under
	/// `localoptions` (zsh `doshfunc`); same-dialect calls do not switch.
	#[test]
	fn zsh_calls_restore_options_under_localoptions() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		zset(&mut r, &mut s, &mut vp, ZshOpt::Ksharrays, true);
		let saved = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, None)
			.unwrap()
			.unwrap();
		assert_eq!(vp.mode, ModeId::Zsh);
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Ksharrays), "the caller's options apply");
		zset(&mut r, &mut s, &mut vp, ZshOpt::Ksharrays, false);
		zset(&mut r, &mut s, &mut vp, ZshOpt::Localoptions, true);
		leave_call(&mut r, &mut s, &mut vp, *saved, true).unwrap();
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Ksharrays));
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Localoptions));
		let saved = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, None)
			.unwrap()
			.unwrap();
		zset(&mut r, &mut s, &mut vp, ZshOpt::Ksharrays, false);
		leave_call(&mut r, &mut s, &mut vp, *saved, true).unwrap();
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Ksharrays), "no localoptions: it stays");
	}

	/// `emulate -L` precedence: an inner call's local changes end with it,
	/// the outer call's plain changes outlive it.
	#[test]
	fn local_options_scope_to_the_call_that_set_them() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		let outer = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, None)
			.unwrap()
			.unwrap();
		zset(&mut r, &mut s, &mut vp, ZshOpt::Extendedglob, true);
		let inner = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, None)
			.unwrap()
			.unwrap();
		emulate(&mut r, &mut s, &mut vp, ModeId::ZshSh, false).unwrap();
		zset(&mut r, &mut s, &mut vp, ZshOpt::Localoptions, true);
		assert_eq!(vp.mode, ModeId::ZshSh);
		leave_call(&mut r, &mut s, &mut vp, *inner, true).unwrap();
		assert_eq!(vp.mode, ModeId::Zsh, "the emulation is local too");
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Extendedglob), "the outer change is back");
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Shwordsplit));
		leave_call(&mut r, &mut s, &mut vp, *outer, true).unwrap();
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Extendedglob), "outer had no localoptions");
	}

	/// Crossing dialects switches to the callee's mode and back; env
	/// options changed inside cross back, mode options never leak.
	#[test]
	fn cross_dialect_calls_switch_and_restore_the_mode() {
		let (mut s, mut r, mut vp) = shell(ModeId::Bash);
		let saved = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, None)
			.unwrap()
			.unwrap();
		assert_eq!(vp.mode, ModeId::Zsh);
		assert_eq!(s.get(Key::Misc(MiscKey::Mode)).unwrap(), Some(&Record::Misc("zsh".into())));
		zset(&mut r, &mut s, &mut vp, ZshOpt::Errexit, true);
		zset(&mut r, &mut s, &mut vp, ZshOpt::Shwordsplit, true);
		leave_call(&mut r, &mut s, &mut vp, *saved, true).unwrap();
		assert_eq!(vp.mode, ModeId::Bash);
		assert!(state::option(&mut r, &mut s, &vp, OptId::Errexit).unwrap(), "env option crosses");
		// And the other way: a bash function from zsh code.
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		let saved = enter_call(&mut r, &mut s, &mut vp, ModeId::Bash, None)
			.unwrap()
			.unwrap();
		assert_eq!(vp.mode, ModeId::Bash);
		leave_call(&mut r, &mut s, &mut vp, *saved, false).unwrap();
		assert_eq!(vp.mode, ModeId::Zsh);
	}

	/// A sticky function switches emulation and restores everything on
	/// return; called while that same sticky emulation is in effect it
	/// switches nothing (zsh `sticky_emulation_differs`).
	#[test]
	fn sticky_functions_switch_unless_the_same_sticky_is_in_effect() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		let sticky = Sticky {
			mode: ModeId::ZshSh,
			full: false,
			on:   vec![ZshOpt::Extendedglob],
			off:  vec![],
		};
		let saved = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, Some(&sticky))
			.unwrap()
			.unwrap();
		assert!(saved.restore_sticky);
		assert_eq!(vp.mode, ModeId::ZshSh);
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Shwordsplit));
		assert!(zopt(&mut r, &mut s, &vp, ZshOpt::Extendedglob));
		assert_eq!(vp.sticky(), Some(&sticky));
		let inner = enter_call(&mut r, &mut s, &mut vp, ModeId::Zsh, Some(&sticky))
			.unwrap()
			.unwrap();
		assert!(!inner.restore_sticky, "same sticky emulation: no switch");
		leave_call(&mut r, &mut s, &mut vp, *inner, true).unwrap();
		leave_call(&mut r, &mut s, &mut vp, *saved, true).unwrap();
		assert_eq!(vp.mode, ModeId::Zsh);
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Shwordsplit));
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Extendedglob));
		assert!(vp.sticky().is_none());
	}

	/// zsh grammar and its parse-affecting options become feature bits;
	/// bash code keeps its own switches.
	#[test]
	fn features_follow_the_dialect() {
		let (mut s, mut r, mut vp) = shell(ModeId::Zsh);
		let f = features(&mut r, &mut s, &vp, Features::EXTGLOB).unwrap();
		assert!(f.contains(Features::ZSH | Features::ZSH_SHORT_LOOPS));
		assert!(f.contains(Features::ZSH_INTERACTIVE_COMMENTS), "non-interactive");
		assert!(!f.contains(Features::EXTGLOB));
		zset(&mut r, &mut s, &mut vp, ZshOpt::Shglob, true);
		zset(&mut r, &mut s, &mut vp, ZshOpt::Aliases, false);
		let f = features(&mut r, &mut s, &vp, Features::NONE).unwrap();
		assert!(f.contains(Features::ZSH_SH_GLOB | Features::ZSH_NO_ALIASES));
		let (mut s, mut r, vp) = shell(ModeId::Bash);
		assert_eq!(features(&mut r, &mut s, &vp, Features::EXTGLOB).unwrap(), Features::EXTGLOB);
	}

	/// A subshell's zsh options are its own (overlay records).
	#[test]
	fn subshell_options_stay_in_the_subshell() {
		let (mut s, mut r, vp) = shell(ModeId::Zsh);
		let mut sub = Vproc::new(
			Vpid(2),
			Some(vp.vpid),
			FdTable::default(),
			BString::from("/"),
			Some(state::Overlay::default()),
			true,
		);
		sub.mode = ModeId::Zsh;
		zset(&mut r, &mut s, &mut sub, ZshOpt::Ksharrays, true);
		assert!(zopt(&mut r, &mut s, &sub, ZshOpt::Ksharrays));
		assert!(!zopt(&mut r, &mut s, &vp, ZshOpt::Ksharrays));
	}
}
