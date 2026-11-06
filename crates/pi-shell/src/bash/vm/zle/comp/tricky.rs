//! zsh 5.9 `Src/Zle/zle_tricky.c`: the completion and expansion widgets,
//! the word to complete taken from the line (`get_comp_string`), quoting
//! and brace contexts, expansion (`doexpansion`), spelling correction of
//! a word (`spell-word`), `expand-cmd-path` and `end-of-list`.
//!
//! zsh's history expansion part of this file (`doexpandhist`,
//! `magic-space`, `expand-history`, `getcurcmd`, `processcmd`) lives with
//! the other line-editing widgets (`widgets::edit`); `listlist` (the list
//! printer of expansions) in `widgets::named`; `printfmt` in
//! `compresult`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

mod compstring;
mod expand;
mod spell;
#[cfg(test)]
mod tests;

use bstr::BString;

pub use self::{
	compstring::{CompStrOpts, LexEnv, get_comp_string_in},
	expand::{doexpansion, findcmd_path, run as run_expansion},
	spell::spckword,
};
use super::{K, compcore, compresult, qt, types::Brinfo};
use crate::bash::{
	diag::Diag,
	store::{KeyBuf, Record, StoreError, Table},
	syntax::{
		AliasLookup, Features, NO_ALIASES,
		zsh::{
			IN_MATH as LEX_IN_MATH, skipparens,
			tok::{
				BAR, EQUALS, HAT, INANG, INBRACE, INBRACK, INPAR, INPARMATH, OUTANG, OUTBRACE,
				OUTBRACK, OUTPAR, POUND, QSTRING, QTICK, QUEST, STAR, STRING, TICK, TILDE, at, is_null,
				is_tok, metafy, tok_char, unmetafy, untokenize,
			},
		},
	},
	vm::{
		Cx, Kernel,
		builtins::{Aliases, alias_table, zsh_module},
		mode,
		proc::Vproc,
		zle::{
			exec::{WResult, Zw},
			thingy::Kind,
			widgets::{self, edit, misc},
		},
		zsh::{
			params,
			text::{Qt, QuoteOpts, quotestring_comma},
		},
	},
	zshopt::ZshOpt,
};

/// zsh `COMP_COMPLETE` (zle.h).
pub const COMP_COMPLETE: i32 = 0;
/// zsh `COMP_LIST_COMPLETE`.
pub const COMP_LIST_COMPLETE: i32 = 1;
/// zsh `COMP_SPELL`.
pub const COMP_SPELL: i32 = 2;
/// zsh `COMP_EXPAND`.
pub const COMP_EXPAND: i32 = 3;
/// zsh `COMP_EXPAND_COMPLETE`.
pub const COMP_EXPAND_COMPLETE: i32 = 4;
/// zsh `COMP_LIST_EXPAND`.
pub const COMP_LIST_EXPAND: i32 = 5;

/// zsh `COMP_ISEXPAND(X)`.
pub const fn comp_isexpand(x: i32) -> bool {
	x >= COMP_EXPAND
}

/// zsh `IN_NOTHING` (`inwhat`, zsh.h).
pub const IN_NOTHING: i32 = 0;
/// zsh `IN_CMD`: in command position.
pub const IN_CMD: i32 = 1;
/// zsh `IN_MATH`: in arithmetic or a subscript.
pub const IN_MATH: i32 = LEX_IN_MATH;
/// zsh `IN_COND`: in `[[ … ]]`.
pub const IN_COND: i32 = 3;
/// zsh `IN_ENV`: in the value of an assignment.
pub const IN_ENV: i32 = 4;
/// zsh `IN_PAR`: in the name of an assignment.
pub const IN_PAR: i32 = 5;

/// `zle_tricky.c`'s globals (plus lex.c's `wb`, `we`, `addedx`, `inwhat`,
/// which only completion reads, and utils.c's `,` special flag).
#[derive(Clone, Debug, Default)]
pub struct State {
	/// zsh `origline`: the line before completion changed it.
	pub origline:          Option<BString>,
	/// zsh `origcs`.
	pub origcs:            i32,
	/// zsh `origll`.
	pub origll:            i32,
	/// zsh `clwsize` (the words array grows as needed here).
	pub clwsize:           i32,
	/// zsh `clwnum`: number of words on the line.
	pub clwnum:            i32,
	/// zsh `clwpos`: index of the word the cursor is in.
	pub clwpos:            i32,
	/// zsh `clwords`: the words of the line (`clwnum` of them).
	pub clwords:           Vec<BString>,
	/// zsh `offs`: cursor offset in the word.
	pub offs:              i32,
	/// zsh `usemenu`.
	pub usemenu:           i32,
	/// zsh `useglob`.
	pub useglob:           i32,
	/// zsh `wouldinstab`.
	pub wouldinstab:       i32,
	/// zsh `menucmp`: menu completion in progress.
	pub menucmp:           i32,
	/// zsh `brbeg` in list order (zsh `lastbrbeg` is the last).
	pub brbeg:             Vec<Brinfo>,
	/// zsh `brend` in list order, newest first (zsh `lastbrend` is the
	/// last, `prev` the one before).
	pub brend:             Vec<Brinfo>,
	/// zsh `nbrbeg`.
	pub nbrbeg:            i32,
	/// zsh `nbrend`.
	pub nbrend:            i32,
	/// zsh `lastprebr`.
	pub lastprebr:         Option<BString>,
	/// zsh `lastpostbr`.
	pub lastpostbr:        Option<BString>,
	/// zsh `validlist`: the list of matches is valid.
	pub validlist:         i32,
	/// zsh `showagain`.
	pub showagain:         i32,
	/// zsh `qipre`.
	pub qipre:             Option<BString>,
	/// zsh `qisuf`.
	pub qisuf:             Option<BString>,
	/// zsh `autoq`.
	pub autoq:             Option<BString>,
	/// zsh `compfunc`: the completion widget's function.
	pub compfunc:          Option<BString>,
	/// zsh `lastambig`.
	pub lastambig:         i32,
	/// zsh `bashlistfirst`.
	pub bashlistfirst:     i32,
	/// zsh `cfargs`.
	pub cfargs:            Vec<BString>,
	/// zsh `cfret`.
	pub cfret:             i32,
	/// zsh `comprecursive`.
	pub comprecursive:     i32,
	/// zsh `lincmd`.
	pub lincmd:            i32,
	/// zsh `linredir`.
	pub linredir:          i32,
	/// zsh `linarr`.
	pub linarr:            i32,
	/// zsh `rdstr`.
	pub rdstr:             Option<BString>,
	/// zsh `rdstrs`.
	pub rdstrs:            Vec<BString>,
	/// zsh `cmdstr`.
	pub cmdstr:            Option<BString>,
	/// zsh `varname`.
	pub varname:           Option<BString>,
	/// zsh `insubscr`.
	pub insubscr:          i32,
	/// zsh `keypm`: the parameter whose key is completed (its name).
	pub keypm:             Option<BString>,
	/// zsh `instring` (a [`super::qt`] kind).
	pub instring:          i32,
	/// zsh `inbackt`.
	pub inbackt:           i32,
	/// lex.c `wb`: word begin (metafied offset).
	pub wb:                i32,
	/// lex.c `we`: word end.
	pub we:                i32,
	/// lex.c `addedx`.
	pub addedx:            i32,
	/// lex.c `inwhat` (`IN_*`).
	pub inwhat:            i32,
	/// utils.c `makecommaspecial`: `,` is special to quoting (inside
	/// braces being completed).
	pub commaspecial:      bool,
	/// zsh `origword` (static).
	pub origword:          Option<BString>,
	/// zsh `comppref` (static).
	pub comppref:          i32,
	/// zsh `cmdwb` (static).
	pub cmdwb:             i32,
	/// zsh `cmdwe` (static).
	pub cmdwe:             i32,
	/// `docomplete`'s static `active`: a completion is running.
	pub docomplete_active: bool,
}

/// What `quotestring` reads, from the options of the editing vproc.
pub fn quote_opts(zw: &mut Zw<'_, '_>) -> QuoteOpts {
	let (bang, bang_special) =
		crate::bash::vm::zsh::params::bang_quoting(&mut zw.k.root, zw.cx.store, zw.vp);
	QuoteOpts {
		rcquotes: zw.isset(ZshOpt::Rcquotes),
		magic_equal_subst: zw.isset(ZshOpt::Magicequalsubst),
		extended_glob: zw.isset(ZshOpt::Extendedglob),
		bang,
		bang_special,
		mb: crate::bash::vm::zsh::params::mb_quiet(zw.k, zw.cx.store, zw.vp),
	}
}

/// `zle_tricky.c`'s `quotename(s)`: `quotestring(s, instring == QT_NONE ?
/// QT_BACKSLASH : instring)` (with `,` special under
/// `makecommaspecial(1)`).
pub fn quotename(t: &State, s: &[u8], o: QuoteOpts) -> Vec<u8> {
	let how = match u8::try_from(t.instring).unwrap_or(qt::NONE) {
		qt::SINGLE => Qt::Single,
		qt::DOUBLE => Qt::Double,
		qt::DOLLARS => Qt::Dollars,
		_ => Qt::Backslash,
	};
	quotestring_comma(s, how, o, t.commaspecial)
}

/// zsh `dupstrspace`: `s` with a space added.
pub fn dupstrspace(s: &[u8]) -> Vec<u8> {
	let mut v = Vec::with_capacity(s.len() + 1);
	v.extend_from_slice(s);
	v.push(b' ');
	v
}

/// The grammar and aliases the editor line is lexed with (zsh lexes it
/// with the shell's current options and alias tables).
///
/// # Errors
/// A store failure reading options or aliases.
pub fn lexer_setup(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
) -> Result<(Features, Option<Aliases>), StoreError> {
	let feat = mode::features(&mut k.root, cx.store, vp, Features::NONE)?;
	let aliases = alias_table(k, cx, vp)?;
	Ok((feat, aliases))
}

/// zsh `get_comp_string()` for the editor: see [`get_comp_string_in`].
pub fn get_comp_string(zw: &mut Zw<'_, '_>) -> Option<Vec<u8>> {
	let o = CompStrOpts {
		completealiases: zw.isset(ZshOpt::Completealiases),
		rcquotes:        zw.isset(ZshOpt::Rcquotes),
		equals:          zw.isset(ZshOpt::Equals),
		completeinword:  zw.isset(ZshOpt::Completeinword),
		ignorebraces:    zw.isset(ZshOpt::Ignorebraces),
		quote:           quote_opts(zw),
	};
	let (feat, aliases) = match lexer_setup(zw.k, zw.cx, zw.vp) {
		Ok(v) => v,
		Err(e) => {
			zw.fail(e);
			return None;
		},
	};
	let al: &dyn AliasLookup = match &aliases {
		Some(a) => a,
		None => NO_ALIASES,
	};
	let lex = LexEnv { feat, aliases: al };
	let (k, cx, vp) = (&mut *zw.k, &mut *zw.cx, &mut *zw.vp);
	let mut param = |name: &[u8]| -> Option<bool> {
		let mut log = Vec::new();
		let mut ex =
			crate::bash::vm::expand::Expander::new(&mut *k, &mut *cx, &mut *vp, &mut log, false, 0);
		match params::getparam(&mut ex, name) {
			Ok(Some(p)) => Some(p.flags.0 & params::PmFlags::HASHED.0 != 0),
			_ => None,
		}
	};
	let c = &mut *zw.zle.comp;
	let compfunc = c.tricky.compfunc.is_some();
	get_comp_string_in(&mut c.tricky, &mut c.line, compfunc, &o, &lex, &mut param)
}

/// zsh `pfxlen`: the length of the common prefix of the metafied `s` and
/// `t`, whole (UTF-8) characters only.
pub const fn pfxlen(s: &[u8], t: &[u8]) -> usize {
	let (mut i, mut lasti, mut pending) = (0usize, 0usize, 0u8);
	while i < s.len() {
		let inc = if s[i] == crate::bash::syntax::zsh::tok::META {
			if at(t, i) != s[i] || at(t, i + 1) != at(s, i + 1) {
				break;
			}
			i += 2;
			at(s, i - 1) ^ 32
		} else {
			if at(t, i) != s[i] {
				break;
			}
			i += 1;
			s[i - 1]
		};
		if pending == 0 {
			pending = match inc {
				0..=0x7f => 0,
				0xc2..=0xdf => 1,
				0xe0..=0xef => 2,
				0xf0..=0xf4 => 3,
				_ => break,
			};
		} else if inc & 0xc0 == 0x80 {
			pending -= 1;
		} else {
			break;
		}
		if pending == 0 {
			lasti = i;
		}
	}
	lasti
}

/// zsh `cmphaswilds`: whether `s` (tokenized) has wildcards, job
/// references (`%?foo`), parameter expressions and `~[…]` aside.
pub fn cmphaswilds(s: &[u8], extendedglob: bool, ignorebraces: bool) -> bool {
	if s.len() == 1 && (s[0] == INBRACK || s[0] == OUTBRACK) {
		return false;
	}
	let mut i = if at(s, 0) == b'%' && at(s, 1) == QUEST {
		2
	} else {
		0
	};
	if at(s, i) == TILDE
		&& at(s, i + 1) == INBRACK
		&& let Some(p) = s
			.get(i + 2..)
			.and_then(|r| r.iter().position(|&c| c == OUTBRACK))
	{
		i = i + 2 + p + 1;
	}
	while i < s.len() {
		let c = s[i];
		if c == STRING || c == QSTRING {
			i += 1;
			if at(s, i) == INBRACE {
				skipparens(INBRACE, OUTBRACE, s, &mut i);
			} else if at(s, i) == STRING || at(s, i) == QSTRING {
				i += 1;
			} else {
				while i < s.len() && matches!(s[i], b'^' | HAT | b'=' | EQUALS | b'~' | TILDE) {
					i += 1;
				}
				if matches!(at(s, i), b'#' | POUND) {
					i += 1;
				}
				if matches!(at(s, i), STAR | QUEST) {
					i += 1;
				}
			}
		} else {
			if ((c == POUND || c == HAT) && extendedglob) || c == STAR || c == BAR || c == QUEST {
				return true;
			}
			if skipparens(INBRACK, OUTBRACK, s, &mut i) == 0
				|| skipparens(INANG, OUTANG, s, &mut i) == 0
				|| (!ignorebraces && skipparens(INBRACE, OUTBRACE, s, &mut i) == 0)
				|| (at(s, i) == INPAR
					&& at(s, i + 1) == b':'
					&& skipparens(INPAR, OUTPAR, s, &mut i) == 0)
			{
				return true;
			}
			if i < s.len() {
				i += 1;
			}
		}
	}
	false
}

/// zsh `checkparams`: whether `p` (a parameter name prefix) names one
/// parameter worth expanding.
fn checkparams(zw: &mut Zw<'_, '_>, p: &[u8]) -> bool {
	let names = zw.params(params::scan_names).unwrap_or_default();
	let l = p.len();
	let (mut n, mut e) = (0, false);
	for nam in &names {
		if n >= 2 {
			break;
		}
		if pfxlen(p, nam) == l {
			n += 1;
			if nam.len() == l {
				e = true;
			}
		}
	}
	if n == 1 {
		return zw.getsparam(p).is_some();
	}
	let hascompmod = hascompmod(zw);
	zw.zle.comp.tricky.menucmp == 0 && e && (!hascompmod || zw.isset(ZshOpt::Recexact))
}

/// zsh `hascompmod`, refreshed: zsh/complete is loaded.
fn hascompmod(zw: &mut Zw<'_, '_>) -> bool {
	let on = zsh_module::loaded(zw.cx.store, zw.vp, b"zsh/complete").unwrap_or(false);
	zw.zle.comp.hascompmod = on;
	on
}

/// zsh `zwarn` from the editor: the display given up, the message on
/// standard error.
fn zwarn(zw: &mut Zw<'_, '_>, msg: &str) {
	crate::bash::vm::zle::exec::trashzle(zw);
	zw.k
		.diag(zw.cx, zw.vp, 0, Diag::Usage { msg: msg.to_string().into() });
}

/// Run `r` (a widget step that may wait), then `k` with its status.
pub fn chain(zw: &mut Zw<'_, '_>, r: WResult, k: K<i32>) -> WResult {
	match r {
		WResult::Done(s) => k(zw, s),
		WResult::Await(what, cont) => WResult::Await(
			what,
			Box::new(move |zw: &mut Zw<'_, '_>, got| {
				let r = cont.resume(zw, got);
				chain(zw, r, k)
			}),
		),
	}
}

/// The continuation that finishes a widget with the status it gets.
fn done() -> K<i32> {
	Box::new(|_, ret| WResult::Done(ret))
}

// ---- widgets ------------------------------------------------------------

/// zsh `usetab`: the key was a lone TAB with only blanks before the
/// cursor on its line: insert it (with a completion function: only note
/// `wouldinstab`).
fn usetab(zw: &mut Zw<'_, '_>) -> bool {
	if zw.ed.keybuf.as_slice() != b"\t" {
		return false;
	}
	let cs = zw.ed.cs.min(zw.ed.line.len());
	for &ch in zw.ed.line[..cs].iter().rev() {
		if ch == '\n' {
			break;
		}
		if ch != '\t' && ch != ' ' {
			return false;
		}
	}
	if zw.zle.comp.tricky.compfunc.is_some() {
		zw.zle.comp.tricky.wouldinstab = 1;
		return false;
	}
	true
}

/// The options most completion widgets start from: `usemenu` from
/// `MENU_COMPLETE`, `useglob` from `GLOB_COMPLETE`.
fn menu_glob(zw: &mut Zw<'_, '_>) {
	let menu = zw.isset(ZshOpt::Menucomplete);
	let glob = zw.isset(ZshOpt::Globcomplete);
	let t = &mut zw.zle.comp.tricky;
	t.usemenu = i32::from(menu);
	t.useglob = i32::from(glob);
	t.wouldinstab = 0;
}

/// zsh `lastchar == '\t' && usetab()`.
fn tab_inserts(zw: &mut Zw<'_, '_>) -> bool {
	zw.ed.lastchar == i32::from(b'\t') && usetab(zw)
}

/// zsh `completecall`: run the completion widget whose base widget is
/// `base` (an `ISCOMP` builtin widget, with or without its `.`) with
/// `func` as `compfunc` (`zle -C name base func`); `c.compwidget` is set
/// by the caller.
pub fn completecall(zw: &mut Zw<'_, '_>, base: &[u8], func: &[u8]) -> WResult {
	hascompmod(zw);
	let base = base.strip_prefix(b".").unwrap_or(base);
	// zsh calls the base thingy's widget function: a builtin widget, or
	// a module's (`menu-select`).
	let f = widgets::BUILTINS
		.iter()
		.find(|b| b.name.as_bytes() == base)
		.and_then(|b| b.func)
		.or_else(|| match zw.zle.widgets.get(base) {
			Some(w) if w.flags & crate::bash::vm::zle::wflags::ISCOMP != 0 => match w.kind {
				Kind::Native(f) => Some(f),
				_ => None,
			},
			_ => None,
		});
	let Some(f) = f else {
		let mut msg = BString::from("zle: no completion widget function for `");
		msg.extend_from_slice(base);
		msg.push(b'\'');
		crate::bash::vm::zle::exec::showmsg(zw.ed, &msg);
		return WResult::Done(1);
	};
	let t = &mut zw.zle.comp.tricky;
	t.cfargs = zw.args.to_vec();
	t.cfret = 0;
	t.compfunc = Some(BString::from(func));
	let r = f(zw);
	chain(
		zw,
		r,
		Box::new(|zw, ret| {
			let t = &mut zw.zle.comp.tricky;
			if ret != 0 && t.cfret == 0 {
				t.cfret = 1;
			}
			t.compfunc = None;
			WResult::Done(t.cfret)
		}),
	)
}

/// Widget `complete-word` (zsh `completeword`).
pub fn completeword(zw: &mut Zw<'_, '_>) -> WResult {
	menu_glob(zw);
	if tab_inserts(zw) {
		return misc::selfinsert(zw);
	}
	bash_or(zw, COMP_COMPLETE)
}

/// The `BASH_AUTO_LIST` turn of `complete-word` and
/// `expand-or-complete`: list on the second TAB, else `lst`.
fn bash_or(zw: &mut Zw<'_, '_>, lst: i32) -> WResult {
	let bashautolist = zw.isset(ZshOpt::Bashautolist);
	let t = &zw.zle.comp.tricky;
	if t.lastambig == 1 && bashautolist && t.usemenu == 0 && t.menucmp == 0 {
		zw.zle.comp.tricky.bashlistfirst = 1;
		return docomplete(
			zw,
			COMP_LIST_COMPLETE,
			Box::new(|zw, ret| {
				let t = &mut zw.zle.comp.tricky;
				t.bashlistfirst = 0;
				t.lastambig = 2;
				WResult::Done(ret)
			}),
		);
	}
	docomplete(zw, lst, done())
}

/// Widget `menu-complete` (zsh `menucomplete`).
pub fn menucomplete(zw: &mut Zw<'_, '_>) -> WResult {
	let glob = zw.isset(ZshOpt::Globcomplete);
	let t = &mut zw.zle.comp.tricky;
	t.usemenu = 1;
	t.useglob = i32::from(glob);
	t.wouldinstab = 0;
	if tab_inserts(zw) {
		return misc::selfinsert(zw);
	}
	docomplete(zw, COMP_COMPLETE, done())
}

/// Widget `list-choices` (zsh `listchoices`).
pub fn listchoices(zw: &mut Zw<'_, '_>) -> WResult {
	menu_glob(zw);
	docomplete(zw, COMP_LIST_COMPLETE, done())
}

/// Widget `spell-word` (zsh `spellword`).
pub fn spellword(zw: &mut Zw<'_, '_>) -> WResult {
	let t = &mut zw.zle.comp.tricky;
	t.usemenu = 0;
	t.useglob = 0;
	t.wouldinstab = 0;
	docomplete(zw, COMP_SPELL, done())
}

/// Widget `delete-char-or-list` (zsh `deletecharorlist`): `delete-char`
/// unless the cursor is at the end, where the choices are listed.
pub fn deletecharorlist(zw: &mut Zw<'_, '_>) -> WResult {
	menu_glob(zw);
	if zw.ed.cs != zw.ed.line.len() {
		compresult::suffix::fixsuffix(&mut zw.zle.comp, zw.ed);
		compresult::invalidate_list(zw);
		return misc::deletechar(zw);
	}
	docomplete(zw, COMP_LIST_COMPLETE, done())
}

/// Widget `expand-word` (zsh `expandword`).
pub fn expandword(zw: &mut Zw<'_, '_>) -> WResult {
	let t = &mut zw.zle.comp.tricky;
	t.usemenu = 0;
	t.useglob = 0;
	t.wouldinstab = 0;
	if tab_inserts(zw) {
		return misc::selfinsert(zw);
	}
	docomplete(zw, COMP_EXPAND, done())
}

/// Widget `expand-or-complete` (zsh `expandorcomplete`).
pub fn expandorcomplete(zw: &mut Zw<'_, '_>) -> WResult {
	menu_glob(zw);
	if tab_inserts(zw) {
		return misc::selfinsert(zw);
	}
	bash_or(zw, COMP_EXPAND_COMPLETE)
}

/// Widget `menu-expand-or-complete` (zsh `menuexpandorcomplete`).
pub fn menuexpandorcomplete(zw: &mut Zw<'_, '_>) -> WResult {
	let glob = zw.isset(ZshOpt::Globcomplete);
	let t = &mut zw.zle.comp.tricky;
	t.usemenu = 1;
	t.useglob = i32::from(glob);
	t.wouldinstab = 0;
	if tab_inserts(zw) {
		return misc::selfinsert(zw);
	}
	docomplete(zw, COMP_EXPAND_COMPLETE, done())
}

/// Widget `list-expand` (zsh `listexpand`).
pub fn listexpand(zw: &mut Zw<'_, '_>) -> WResult {
	menu_glob(zw);
	docomplete(zw, COMP_LIST_EXPAND, done())
}

/// Widget `reverse-menu-complete` (zsh `reversemenucomplete`).
pub fn reversemenucomplete(zw: &mut Zw<'_, '_>) -> WResult {
	zw.zle.comp.tricky.wouldinstab = 0;
	zw.ed.zmod.mult = -zw.ed.zmod.mult;
	menucomplete(zw)
}

/// Widget `accept-and-menu-complete` (zsh `acceptandmenucomplete`).
pub fn acceptandmenucomplete(zw: &mut Zw<'_, '_>) -> WResult {
	zw.zle.comp.tricky.wouldinstab = 0;
	if zw.zle.comp.tricky.menucmp == 0 {
		return WResult::Done(1);
	}
	compresult::accept_last(zw, Box::new(|zw, _| menucomplete(zw)))
}

/// Widget `expand-or-complete-prefix` (zsh `expandorcompleteprefix`):
/// `expand-or-complete` on the part of the word before the cursor.
pub fn expandorcompleteprefix(zw: &mut Zw<'_, '_>) -> WResult {
	zw.zle.comp.tricky.comppref = 1;
	let r = expandorcomplete(zw);
	chain(
		zw,
		r,
		Box::new(|zw, ret| {
			if zw.ed.cs > 0 && zw.ed.line.get(zw.ed.cs - 1) == Some(&' ') {
				compresult::suffix::makesuffixstr(zw, None, Some(&b"\\-"[..]), 0);
			}
			zw.zle.comp.tricky.comppref = 0;
			WResult::Done(ret)
		}),
	)
}

/// Widget `end-of-list` (zsh `endoflist`): move below the list shown
/// with `ALWAYS_LAST_PROMPT`, so the next prompt goes after it.
pub fn endoflist(zw: &mut Zw<'_, '_>) -> WResult {
	let d = &mut zw.zle.display;
	if d.lastlistlen <= 0 {
		return WResult::Done(1);
	}
	d.clearflag = false;
	crate::bash::vm::zle::exec::trashzle(zw);
	let n = usize::try_from(zw.zle.display.lastlistlen).unwrap_or(0);
	if let Some(tty) = zw.zle.tty.as_mut() {
		tty.put(&vec![b'\n'; n]);
	}
	zw.zle.display.showinglist = 0;
	zw.zle.display.lastlistlen = 0;
	if zw.ed.in_widget > 0 {
		return crate::bash::vm::zle::exec::then(
			crate::bash::vm::zle::exec::Await::Refresh,
			|_, _| WResult::Done(0),
		);
	}
	WResult::Done(0)
}

/// Widget `expand-cmd-path` (zsh `expandcmdpath`): the command word of
/// the command the cursor is in replaced by its full path.
pub fn expandcmdpath(zw: &mut Zw<'_, '_>) -> WResult {
	let oldcs = zw.ed.cs;
	let Some(s) = getcurcmd_pos(zw) else {
		return WResult::Done(1);
	};
	let (cmdwb, cmdwe) = (zw.zle.comp.tricky.cmdwb, zw.zle.comp.tricky.cmdwe);
	if cmdwb < 0 || cmdwe < cmdwb {
		return WResult::Done(1);
	}
	let mut name = s;
	untokenize(&mut name);
	let name = unmetafy(&name);
	run_expansion::<Option<Vec<u8>>, _>(
		zw,
		Box::default(),
		move |ex| findcmd_path(ex, &name),
		Box::new(move |zw, _sc, r| {
			let str_ = match r {
				Ok(Some(p)) => p,
				Ok(None) => return WResult::Done(1),
				Err(stop) => {
					expand::quiet_error(zw, stop);
					return WResult::Done(1);
				},
			};
			// cmdwb/cmdwe are metafied offsets into the line.
			let mline = metafy(&crate::bash::vm::zle::from_line(&zw.ed.line));
			let to_chars = |m: i32| -> usize {
				let m = usize::try_from(m).unwrap_or(0).min(mline.len());
				crate::bash::vm::zle::to_line(&unmetafy(&mline[..m])).len()
			};
			let (wbc, wec) = (to_chars(cmdwb), to_chars(cmdwe));
			let ins = crate::bash::vm::zle::to_line(&str_);
			zw.ed.cs = wbc;
			crate::bash::vm::zle::utils::foredel(
				zw.ed,
				wec - wbc,
				crate::bash::vm::zle::utils::cutflags::RAW,
			);
			crate::bash::vm::zle::utils::spaceinline(zw.ed, ins.len());
			zw.ed.line[wbc..wbc + ins.len()].copy_from_slice(&ins);
			zw.ed.cs = oldcs;
			if zw.ed.cs + 1 >= wec {
				zw.ed.cs += wec - wbc + str_.len();
			}
			if zw.ed.cs > zw.ed.line.len() {
				zw.ed.cs = zw.ed.line.len();
			}
			WResult::Done(0)
		}),
	)
}

/// zsh `getcurcmd` with its word positions (`cmdwb`, `cmdwe`): the
/// command word (tokenized) of the command the cursor is in, lexing the
/// line in ZLE mode with aliases off.
fn getcurcmd_pos(zw: &mut Zw<'_, '_>) -> Option<Vec<u8>> {
	use crate::bash::syntax::zsh::{LexTok, ZleLex, ZleWords};
	let (feat, _) = match lexer_setup(zw.k, zw.cx, zw.vp) {
		Ok(v) => v,
		Err(e) => {
			zw.fail(e);
			return None;
		},
	};
	let mline = metafy(&crate::bash::vm::zle::from_line(&zw.ed.line));
	let mcs =
		metafy(&crate::bash::vm::zle::from_line(&zw.ed.line[..zw.ed.cs.min(zw.ed.line.len())])).len();
	let ll = i32::try_from(mline.len()).unwrap_or(i32::MAX);
	let src = unmetafy(&dupstrspace(&mline));
	let mut lx = ZleLex::new(&src, feat, NO_ALIASES, true, ZleWords {
		zlemetacs: i32::try_from(mcs).unwrap_or(i32::MAX),
		zlemetall: ll,
		addedx:    0,
		wb:        0,
		we:        0,
		wordbeg:   0,
		parbegin:  -1,
		parend:    -1,
		inwhat:    IN_NOTHING,
	});
	let mut s = None;
	loop {
		let curlincmd = lx.incmdpos();
		lx.ctxtlex();
		let tok = lx.tok();
		if tok == LexTok::Endinput || tok == LexTok::Lexerr {
			break;
		}
		if tok == LexTok::String && curlincmd {
			s = lx.tokstr().map(<[u8]>::to_vec);
			let t = &mut zw.zle.comp.tricky;
			t.cmdwb = ll - lx.z().wordbeg;
			t.cmdwe = ll + 1 - lx.inbufct();
		}
		if lx.lexflags() == 0 {
			break;
		}
	}
	s
}

// ---- docomplete ---------------------------------------------------------

/// zsh `hascompwidgets`: a completion widget (`zle -C`) is defined.
fn hascompwidgets(zw: &Zw<'_, '_>) -> bool {
	zw.zle
		.widgets
		.iter()
		.any(|(_, w)| matches!(w.kind, Kind::Comp { .. }))
}

/// The end of `docomplete`'s run, whatever happened: the line back from
/// metafied form, the flags reset.
fn docomplete_out(zw: &mut Zw<'_, '_>, ret: i32, k: K<i32>) -> WResult {
	let c = &mut *zw.zle.comp;
	c.line.unmetafy(zw.ed);
	c.tricky.docomplete_active = false;
	c.tricky.commaspecial = false;
	// zsh resets user interrupts here: the line stays.
	if zw.ed.interrupted {
		zw.ed.interrupted = false;
		zw.ed.aborted = false;
	}
	k(zw, ret)
}

/// zsh `docomplete(lst)`: the main entry of completion and expansion
/// (`lst` a `COMP_*`); `k` gets its status.
pub fn docomplete(zw: &mut Zw<'_, '_>, lst: i32, k: K<i32>) -> WResult {
	let t = &zw.zle.comp.tricky;
	if t.docomplete_active && t.comprecursive == 0 {
		zwarn(zw, "completion cannot be used recursively (yet)");
		return k(zw, 1);
	}
	let t = &mut zw.zle.comp.tricky;
	t.docomplete_active = true;
	t.comprecursive = 0;
	t.commaspecial = false;
	hascompmod(zw);
	if !zsh_module::loaded(zw.cx.store, zw.vp, b"zsh/compctl").unwrap_or(false)
		&& !hascompwidgets(zw)
		&& let Err(e) = zsh_module::ensure_loaded(zw.k, zw.cx, zw.vp, b"zsh/compctl")
	{
		zw.fail(e);
	}
	compcore::before_complete(
		zw,
		lst,
		Box::new(move |zw, r| {
			if r != 0 {
				zw.zle.comp.tricky.docomplete_active = false;
				return k(zw, 0);
			}
			edit::doexpandhist(zw, Box::default(), move |zw, changed| {
				if changed {
					zw.zle.comp.tricky.docomplete_active = false;
					return k(zw, 0);
				}
				docomplete_line(zw, lst, k)
			})
		}),
	)
}

/// `docomplete` with the line metafied: the word to complete, then what
/// to do with it.
#[allow(clippy::too_many_lines, reason = "a direct port of zsh's docomplete")]
fn docomplete_line(zw: &mut Zw<'_, '_>, lst: i32, k: K<i32>) -> WResult {
	let hline = if zw.ed.isfirstln {
		None
	} else {
		zw.ed.hline.clone()
	};
	let c = &mut *zw.zle.comp;
	c.line.metafy(zw.ed);
	let mut ocs = c.line.cs;
	c.tricky.origline = Some(BString::from(c.line.bytes()));
	c.tricky.origcs = i32::try_from(c.line.cs).unwrap_or(0);
	c.tricky.origll = i32::try_from(c.line.ll()).unwrap_or(0);
	let (ol, chl) = match hline {
		Some(h) => {
			let ol = c.line.bytes().to_vec();
			c.line.cs = 0;
			let chl = c.line.inststrlen(&metafy(&h), true);
			c.line.cs += ocs;
			(Some(ol), chl)
		},
		None => (None, 0),
	};
	c.tricky.inwhat = IN_NOTHING;
	c.tricky.qipre = Some(BString::default());
	c.tricky.qisuf = Some(BString::default());
	c.tricky.autoq = None;
	let s = get_comp_string(zw);
	let c = &mut *zw.zle.comp;
	// Vi: the start of the insertion is no later than the word.
	let wbu = usize::try_from(c.tricky.wb).unwrap_or(0).min(c.line.ll());
	let wbraw = unmetafy(&c.line.bytes()[..wbu]).len();
	if zw.ed.ls.viinsbegin > wbraw {
		zw.ed.ls.viinsbegin = wbraw;
	}
	if let Some(ol) = ol {
		let chl32 = i32::try_from(chl).unwrap_or(0);
		c.line.cs = c.line.cs.saturating_sub(chl);
		c.tricky.wb -= chl32;
		c.tricky.we -= chl32;
		if c.tricky.wb < 0 {
			c.line.s = Some(ol);
			c.line.cs = ocs;
			c.line.unmetafy(zw.ed);
			c.tricky.docomplete_active = false;
			c.tricky.commaspecial = false;
			return k(zw, 1);
		}
		ocs = c.line.cs;
		c.line.cs = 0;
		c.line.foredel(chl);
		c.line.cs = ocs;
	}
	if c.tricky.inwhat == IN_ENV {
		c.tricky.lincmd = 0;
	}
	let Some(s) = s else {
		return finish(zw, lst, 1, k);
	};
	if lst == COMP_EXPAND_COMPLETE && s.first() == Some(&EQUALS) {
		// `=cmd`: expansion when it names exactly one command.
		let q = s[1..].to_vec();
		let recexact = zw.isset(ZshOpt::Recexact);
		let hcm = hascompmod(zw);
		let mut qname = q.clone();
		untokenize(&mut qname);
		let qname = unmetafy(&qname);
		return run_expansion::<Option<Vec<u8>>, _>(
			zw,
			Box::default(),
			move |ex| findcmd_path(ex, &qname),
			Box::new(move |zw, _sc, r| {
				let mut lst = lst;
				match r {
					Ok(Some(_)) => {
						if !hcm || recexact {
							lst = COMP_EXPAND;
						} else {
							let n = hashed_with_prefix(zw, &q);
							if n == 1 {
								lst = COMP_EXPAND;
							}
						}
					},
					Ok(None) => {},
					Err(stop) => expand::quiet_error(zw, stop),
				}
				decide(zw, s, lst, COMP_EXPAND_COMPLETE, k)
			}),
		);
	}
	decide(zw, s, lst, lst, k)
}

/// The commands named `q…` zsh's `=cmd` test counts: the hashed ones
/// (and `q` itself, which `hashcmd` has just found).
fn hashed_with_prefix(zw: &mut Zw<'_, '_>, q: &[u8]) -> usize {
	let mut names: Vec<Vec<u8>> =
		match crate::bash::vm::state::scan(&zw.k.root, zw.cx.store, zw.vp, Table::CmdHash) {
			Ok(v) => v
				.into_iter()
				.filter_map(|(k, r)| match (k, r) {
					(KeyBuf::CmdHash(n), Record::CmdHash { .. }) => Some(metafy(&n)),
					_ => None,
				})
				.collect(),
			Err(e) => {
				zw.fail(e);
				Vec::new()
			},
		};
	if !names.iter().any(|n| n == q) {
		names.push(q.to_vec());
	}
	names.iter().filter(|n| n.starts_with(q)).count()
}

/// `docomplete`'s choice between expansion and completion for
/// `COMP_EXPAND_COMPLETE` (`olst`; `lst` as the `=cmd` test left it),
/// then the work.
#[allow(clippy::too_many_lines, reason = "a direct port of zsh's docomplete")]
fn decide(zw: &mut Zw<'_, '_>, mut s: Vec<u8>, mut lst: i32, olst: i32, k: K<i32>) -> WResult {
	if olst == COMP_EXPAND_COMPLETE {
		let cs = i32::try_from(zw.zle.comp.line.cs).unwrap_or(0);
		let wb = zw.zle.comp.tricky.wb;
		let at_cs = i64::from(cs) - i64::from(wb);
		let mut q = usize::from(s.first() == Some(&EQUALS));
		// Parameter expressions: expansion when the cursor ends one.
		if lst == COMP_EXPAND_COMPLETE {
			// zsh's do-while over the word.
			loop {
				while q < s.len() && s[q] != STRING {
					q += 1;
				}
				if at(&s, q) == STRING && !matches!(at(&s, q + 1), INPAR | INPARMATH | INBRACK) {
					q += 1;
					if at(&s, q) == INBRACE {
						if skipparens(INBRACE, OUTBRACE, &s, &mut q) == 0 && q as i64 == at_cs {
							lst = COMP_EXPAND;
						}
					} else {
						while q < s.len() && matches!(s[q], b'^' | HAT | b'=' | EQUALS | b'~' | TILDE) {
							q += 1;
						}
						if matches!(at(&s, q), b'#' | POUND | b'+') && at(&s, q + 1) != STRING {
							q += 1;
						}
						let t = q;
						let sav2 = at(&s, t);
						if matches!(sav2, QUEST | STAR | STRING | QSTRING) {
							s[q] = tok_char(sav2).unwrap_or(sav2);
							q += 1;
						} else if matches!(sav2, b'?' | b'*' | b'$' | b'-' | b'!' | b'@') {
							q += 1;
						} else if sav2.is_ascii_digit() {
							while at(&s, q).is_ascii_digit() {
								q += 1;
							}
						} else {
							q = crate::bash::syntax::zsh::ident_end(&s, q, false);
						}
						let name = s[t.min(s.len())..q.min(s.len())].to_vec();
						if q as i64 == at_cs && (sav2.is_ascii_digit() || checkparams(zw, &name)) {
							lst = COMP_EXPAND;
						}
						if t < s.len() {
							s[t] = sav2;
						}
					}
					if lst != COMP_EXPAND {
						lst = COMP_COMPLETE;
					}
				} else {
					break;
				}
				if q as i64 >= at_cs {
					break;
				}
			}
		}
		if lst == COMP_EXPAND_COMPLETE {
			// A `$` or a backtick left: expansion.
			let any = s
				.iter()
				.any(|&c| c == TICK || c == QTICK || c == STRING || c == QSTRING);
			lst = if any { COMP_EXPAND } else { COMP_COMPLETE };
		}
		let globcomplete = zw.isset(ZshOpt::Globcomplete);
		let eg = zw.isset(ZshOpt::Extendedglob);
		let ib = zw.isset(ZshOpt::Ignorebraces);
		if !globcomplete && cmphaswilds(&s, eg, ib) {
			lst = COMP_EXPAND;
		}
	}
	let t = &mut zw.zle.comp.tricky;
	if t.lincmd != 0 && t.inwhat == IN_NOTHING {
		t.inwhat = IN_CMD;
	}
	let lincmd = t.lincmd;
	if lst == COMP_SPELL {
		let mut w = t.origword.clone().map_or_default(Vec::from);
		for b in &mut w {
			if is_null(*b) {
				*b = crate::bash::syntax::zsh::tok::NULARG;
			}
		}
		let c = &mut *zw.zle.comp;
		let (wb, we) = (c.tricky.wb, c.tricky.we);
		c.line.cs = usize::try_from(wb).unwrap_or(0);
		c.line.foredel(usize::try_from(we - wb).unwrap_or(0));
		let mut x = w.clone();
		untokenize(&mut x);
		if matches!(w.first(), Some(&(TILDE | EQUALS | STRING))) && !x.is_empty() {
			x[0] = w[0];
		}
		let ox = x.clone();
		return spckword(
			zw,
			x,
			lincmd != 0,
			Box::new(move |zw, mut x| {
				let ret = i32::from(x == ox);
				untokenize(&mut x);
				zw.zle.comp.line.inststrlen(&x, true);
				zw.ed.region_active = 0;
				finish(zw, lst, ret, k)
			}),
		);
	}
	if comp_isexpand(lst) {
		let c = &mut *zw.zle.comp;
		let ol = c.line.bytes().to_vec();
		let ocs = c.line.cs;
		let origword = c.tricky.origword.clone().map_or_default(Vec::from);
		return doexpansion(
			zw,
			origword,
			lst,
			olst,
			lincmd,
			Box::new(move |zw, ret| {
				zw.zle.comp.tricky.lastambig = 0;
				let c = &mut *zw.zle.comp;
				if olst == COMP_EXPAND_COMPLETE && ol.as_slice() == c.line.bytes() {
					// The expansion did not change the line: complete.
					c.line.cs = ocs;
					let compfunc = c.tricky.compfunc.is_some();
					let mut s = s;
					if !compfunc {
						let mut p = usize::from(matches!(s.first(), Some(&(TILDE | EQUALS))));
						while p < s.len() {
							if is_tok(s[p]) {
								if s[p] != STRING && s[p] != QSTRING {
									s[p] = tok_char(s[p]).unwrap_or(s[p]);
								} else if at(&s, p + 1) == INBRACE {
									p += 1;
									skipparens(INBRACE, OUTBRACE, &s, &mut p);
									continue;
								}
							}
							p += 1;
						}
					}
					return docompletion(
						zw,
						s,
						lst,
						lincmd,
						Box::new(move |zw, ret| finish(zw, lst, ret, k)),
					);
				}
				if ret != 0 {
					zw.ed.clearlist = true;
				}
				let c = &mut *zw.zle.comp;
				if ol.as_slice() == c.line.bytes() {
					// Quotes taken off the line go back on.
					let origline = c.tricky.origline.clone().unwrap_or_default();
					c.line.cs = 0;
					let ll = c.line.ll();
					c.line.foredel(ll);
					c.line.spaceinline(origline.len());
					if let Some(l) = c.line.s.as_mut() {
						l[..origline.len()].copy_from_slice(&origline);
					}
					c.line.cs = usize::try_from(c.tricky.origcs).unwrap_or(0);
				}
				finish(zw, lst, ret, k)
			}),
		);
	}
	docompletion(zw, s, lst, lincmd, Box::new(move |zw, ret| finish(zw, lst, ret, k)))
}

/// zsh `docompletion`: run the completion hook (`do_completion`).
pub fn docompletion(zw: &mut Zw<'_, '_>, s: Vec<u8>, lst: i32, incmd: i32, k: K<i32>) -> WResult {
	compcore::do_completion(zw, BString::from(s), incmd, lst, k)
}

/// The end of `docomplete`: the after-completion hook, then the line
/// unmetafied.
fn finish(zw: &mut Zw<'_, '_>, _lst: i32, ret: i32, k: K<i32>) -> WResult {
	compcore::after_complete(zw, ret, Box::new(move |zw, ret| docomplete_out(zw, ret, k)))
}
