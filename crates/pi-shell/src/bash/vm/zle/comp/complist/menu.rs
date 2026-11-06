//! complist.c's hooks and widget: `complistmatches` (the coloured,
//! scrolling list), `domenuselect` (menu selection: its key loop, the
//! interactive and incremental-search modes, its undo stack), and the
//! `menu-select` widget (`menuselect`).
//!
//! zsh's `domenuselect` is one loop around `getkeycmd()` with `goto`s;
//! here the loop's parts are functions passing [`Ms`] (the C locals)
//! from one to the next: [`ms_top`] (the head of the loop, ending in a
//! redisplay), [`ms_after`] (after it), [`ms_getk`] (zsh's `getk:`),
//! [`ms_dispatch`] (the key's branch), [`ms_bottom`] (inserting the
//! selected match) and [`ms_exit`] (after the loop).

use std::sync::Arc;

use bstr::BString;

use super::{
	Menusearch, Mg, State,
	colors::{self, Listcols},
	menuselect_bindings,
	print::{Mt, P, Penv, ScrollKey},
};
use crate::bash::{
	store::{Key, KeyBuf, MiscKey, Record, Table},
	syntax::zsh::tok::{metafy, unmetafy},
	vm::{
		builtins::zsh_prompt::{Cap, TermCaps},
		locale, state,
		zle::{
			comp::{
				self, Comp, K, compcore, compresult, tricky,
				types::{Brinfo, Chdata, Cmatch, GId, Menuinfo, cmf},
			},
			display,
			exec::{Await, Got, WResult, Zw, then},
			undo, utils, wflags,
			widgets::{misc, yank::Paste},
		},
		zsh::{arith, zpattern},
	},
	zshopt::ZshOpt,
};

/// zsh `MM_INTER`: interactive mode.
const MM_INTER: i32 = 1;
/// zsh `MM_FSEARCH`: incremental search forwards.
const MM_FSEARCH: i32 = 2;
/// zsh `MM_BSEARCH`: incremental search backwards.
const MM_BSEARCH: i32 = 3;

/// zsh `MS_OK`.
const MS_OK: i32 = 0;
/// zsh `MS_FAILED`.
const MS_FAILED: i32 = 1;
/// zsh `MS_WRAPPED`.
const MS_WRAPPED: i32 = 2;

/// zsh `MAX_STATUS`.
const MAX_STATUS: usize = 128;

/// The default `LISTPROMPT`.
const DEF_LISTPROMPT: &[u8] = b"%SAt %p: Hit TAB for more, or the character to insert%s";
/// The default `MENUPROMPT`.
const DEF_MENUPROMPT: &[u8] = b"%SScrolling active: current selection at %p%s";

/// Chain a widget step's result into `k` (zsh calling a function and
/// going on after it returns).
fn seq(
	zw: &mut Zw<'_, '_>,
	r: WResult,
	k: impl FnOnce(&mut Zw<'_, '_>, i32) -> WResult + Send + 'static,
) -> WResult {
	match r {
		WResult::Done(s) => k(zw, s),
		WResult::Await(a, c) => WResult::Await(
			a,
			Box::new(move |zw: &mut Zw<'_, '_>, got: Got| {
				let r = c.resume(zw, got);
				seq(zw, r, k)
			}),
		),
	}
}

/// zsh `zrefresh()` from completion code: the line unmetafied for the
/// redisplay, metafied again after it.
fn zrefresh(
	zw: &mut Zw<'_, '_>,
	k: impl FnOnce(&mut Zw<'_, '_>) -> WResult + Send + 'static,
) -> WResult {
	let meta = zw.zle.comp.line.s.is_some();
	if meta {
		zw.zle.comp.line.unmetafy(zw.ed);
	}
	then(Await::Refresh, move |zw, _| {
		if meta {
			zw.zle.comp.line.metafy(zw.ed);
		}
		k(zw)
	})
}

/// Run widget function `f` with the line unmetafied (zsh's
/// `unmetafy_line(); f(zlenoargs); metafy_line();`), then `k`.
fn unmeta_call(
	zw: &mut Zw<'_, '_>,
	f: fn(&mut Zw<'_, '_>) -> WResult,
	k: impl FnOnce(&mut Zw<'_, '_>) -> WResult + Send + 'static,
) -> WResult {
	zw.zle.comp.line.unmetafy(zw.ed);
	let args = zw.args;
	zw.args = &[];
	let r = f(zw);
	zw.args = args;
	seq(zw, r, move |zw, _| {
		zw.zle.comp.line.metafy(zw.ed);
		k(zw)
	})
}

/// zsh `ungetkeycmd()`: the keys of the last command are read again.
fn ungetkeycmd(zw: &mut Zw<'_, '_>) {
	let keys = zw.ed.keybuf.clone();
	for &b in keys.iter().rev() {
		zw.ed.unget.push_front(b);
	}
}

/// zsh `zsetterm()`.
fn zsetterm(zw: &mut Zw<'_, '_>) {
	let flow = zw.isset(ZshOpt::Flowcontrol);
	if let Some(t) = zw.zle.tty.as_mut() {
		t.zsetterm(zw.k, zw.cx, flow);
	}
}

/// zsh `settyinfo(&shttyinfo)`.
fn settyinfo(zw: &mut Zw<'_, '_>) {
	if let Some(t) = zw.zle.tty.as_mut() {
		t.settyinfo(zw.k, zw.cx);
	}
}

/// zsh `atoi`.
fn atoi(s: &[u8]) -> i64 {
	let s = s.trim_ascii_start();
	let (neg, s) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let mut v: i64 = 0;
	for &c in s.iter().take_while(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
	}
	if neg { -v } else { v }
}

/// zsh's `zlemetacs = 0; foredel(zlemetall, CUT_RAW); spaceinline(l);
/// strncpy(zlemetaline, line, l); zlemetacs = cs;`.
fn set_metaline(zw: &mut Zw<'_, '_>, line: &[u8], cs: i32) {
	let ml = &mut zw.zle.comp.line;
	ml.cs = 0;
	let ll = ml.ll();
	ml.foredel(ll);
	ml.spaceinline(line.len());
	zw.ed.region_active = 0;
	if let Some(s) = ml.s.as_mut() {
		s[..line.len()].copy_from_slice(line);
	}
	ml.cs = usize::try_from(cs).unwrap_or(0).min(ml.ll());
}

/// The current match's data (zsh `*minfo.cur`), if it is a match.
fn cur_match(c: &Comp) -> Option<Cmatch> {
	c.core.minfo.cur.and_then(|r| c.groups.try_mat(r)).cloned()
}

// ---- complistmatches -------------------------------------------------------

/// The enabled suffix aliases (zsh `sufaliastab` nodes not disabled).
fn suffix_aliases(zw: &mut Zw<'_, '_>) -> Vec<BString> {
	let off = match state::record(zw.cx.store, zw.vp, Key::Misc(MiscKey::ZshDisabledSuffixAliases)) {
		Ok(Some(Record::Words(w))) => w.clone(),
		_ => Vec::new(),
	};
	state::scan(&zw.k.root, zw.cx.store, zw.vp, Table::ZshAlias)
		.unwrap_or_default()
		.into_iter()
		.filter_map(|(k, _)| match k {
			KeyBuf::ZshAlias { suffix: true, name } if !off.contains(&name) => Some(name),
			_ => None,
		})
		.collect()
}

/// zsh `getcols()`: the colours from `ZLS_COLORS`/`ZLS_COLOURS`, patterns
/// compiled with `EXTENDED_GLOB` (which `complistmatches` forces).
fn getcols(zw: &mut Zw<'_, '_>, caps: &TermCaps) -> Listcols {
	let s = zw
		.getsparam(b"ZLS_COLORS")
		.or_else(|| zw.getsparam(b"ZLS_COLOURS"));
	match s {
		None => colors::getcols_unset(
			caps.tcstr[Cap::StandoutBeg as usize].as_deref(),
			caps.tcstr[Cap::StandoutEnd as usize].as_deref(),
		),
		Some(s) => {
			let mut opts = zw.params(zpattern::opts).unwrap_or_default();
			opts.extended_glob = true;
			colors::getcols_from(&s, &opts)
		},
	}
}

/// The state a listing run starts from (restored before running it
/// again with one more scrolling answer).
struct Snap {
	list:        State,
	showinglist: i32,
	listshown:   i32,
	lastlistlen: i32,
	clearflag:   bool,
}

impl Snap {
	fn take(zw: &Zw<'_, '_>) -> Self {
		let d = &zw.zle.display;
		Self {
			list:        zw.zle.comp.list.clone(),
			showinglist: d.showinglist,
			listshown:   d.listshown,
			lastlistlen: d.lastlistlen,
			clearflag:   d.clearflag,
		}
	}

	fn restore(&self, zw: &mut Zw<'_, '_>) {
		zw.zle.comp.list = self.list.clone();
		let d = &mut zw.zle.display;
		d.showinglist = self.showinglist;
		d.listshown = self.listshown;
		d.lastlistlen = self.lastlistlen;
		d.clearflag = self.clearflag;
	}
}

/// Show the bytes of `pe.out` not shown yet.
fn emit(zw: &mut Zw<'_, '_>, pe: &mut Penv) {
	if pe.out.len() > pe.skip {
		if let Some(t) = zw.zle.tty.as_mut() {
			t.put(&pe.out[pe.skip..]);
		}
		pe.skip = pe.out.len();
	}
}

/// `compprintlist(showall)` with `LISTPROMPT` scrolling: run the
/// listing; when it needs a key, show what it printed, read the key in
/// the `listscroll` keymap (zsh `asklistscroll`) and run it again.
fn print_list(
	zw: &mut Zw<'_, '_>,
	mut pe: Box<Penv>,
	snap: Option<Snap>,
	showall: bool,
	k: K<i32>,
) -> WResult {
	let snap = snap.unwrap_or_else(|| Snap::take(zw));
	pe.rewind();
	pe.errflag = zw.ed.aborted;
	let r = {
		let mut p = P { c: &mut zw.zle.comp, d: &mut zw.zle.display, e: &mut pe };
		p.compprintlist(showall)
	};
	emit(zw, &mut pe);
	if let Ok(printed) = r {
		k(zw, printed)
	} else {
		snap.restore(zw);
		zsetterm(zw);
		menuselect_bindings(&mut zw.zle.keymaps);
		zw.ed.localkeymap = Some(BString::from("listscroll"));
		then(Await::Key, move |zw, got| {
			zw.ed.localkeymap = None;
			settyinfo(zw);
			let cmd = match got {
				Got::Key(c) => c,
				_ => None,
			};
			let (key, unget) = ScrollKey::of(cmd.as_deref().map(|c| c.as_slice()));
			if unget {
				ungetkeycmd(zw);
			}
			pe.keys.push(key);
			print_list(zw, pe, Some(snap), showall, k)
		})
	}
}

/// zsh `complistmatches(dummy, dat)` (the `comp_list_matches` hook): list
/// the matches of `dat` with colours and scrolling, or draw the menu
/// selection; `k` gets zsh's return value (1: no selection possible).
pub fn complistmatches(zw: &mut Zw<'_, '_>, dat: Chdata, k: K<i32>) -> WResult {
	let oamatches = zw.zle.comp.core.amatches;
	zw.zle.comp.core.amatches = dat.matches;
	if zw.zle.comp.list.noselect > 0 {
		zw.zle.comp.list.noselect = 0;
	}
	let (columns, lines) = comp::with_ex(zw, |ex, _| comp::zterm_size(ex));
	{
		let c = &zw.zle.comp;
		if (c.core.minfo.asked == 2 && c.list.mselect < 0)
			|| zw.zle.display.nlnct >= lines
			|| zw.ed.aborted
		{
			zw.zle.display.showinglist = 0;
			zw.zle.comp.core.amatches = oamatches;
			zw.zle.comp.list.noselect = 1;
			return k(zw, 1);
		}
	}
	let pr = compresult::Pr::new(zw);
	let caps = Arc::clone(&pr.caps);
	let mcolors = getcols(zw, &caps);
	let mselect = zw.zle.comp.list.mselect;
	let calc = comp::with_ex(zw, |ex, c| compresult::calclist(ex, c, mselect >= 0));
	{
		let c = &mut *zw.zle.comp;
		let nlines = c.core.listdat.nlines;
		c.list.mnew = i32::from(
			(calc || c.list.mlastcols != columns || c.list.mlastlines != nlines)
				&& c.list.mselect >= 0,
		);
	}
	let usezle = zw.isset(ZshOpt::Zle);
	let lastprompt = zw
		.zle
		.comp
		.complete
		.complastprompt
		.as_ref()
		.is_some_and(|p| !p.is_empty());
	if zw.zle.comp.core.listdat.nlines == 0
		|| (zw.zle.comp.list.mselect >= 0 && !(usezle && caps.termflags == 0 && lastprompt))
	{
		zw.zle.display.showinglist = 0;
		zw.zle.display.listshown = 0;
		zw.zle.comp.list.noselect = 1;
		zw.zle.comp.core.amatches = oamatches;
		return k(zw, 1);
	}
	if zw.zle.comp.list.inselect != 0 || zw.zle.comp.list.mlbeg >= 0 {
		zw.zle.display.clearflag = false;
	}
	zw.zle.comp.list.mscroll = 0;
	zw.zle.comp.list.mlistp = None;

	let mut pe = Box::new(Penv::new(caps, columns, lines, mcolors));
	pe.colseqs = pr.colseqs;
	pe.nearcolor = pr.nearcolor;
	pe.env = zw.params(zpattern::char_env).unwrap_or_default();
	pe.utf8 = locale::is_utf8(zw.k, zw.cx.store, zw.vp);
	pe.multibyte = pe.utf8 && zw.isset(ZshOpt::Multibyte);
	pe.print_eight = zw.isset(ZshOpt::Printeightbit);
	pe.sufaliases = suffix_aliases(zw);

	let l = &zw.zle.comp.list;
	let listprompt = if l.mselect >= 0 || l.mlbeg >= 0 {
		None
	} else {
		zw.getsparam(b"LISTPROMPT")
			.map(|s| BString::from(metafy(&s)))
	};
	if zw.zle.comp.list.mselect >= 0 || zw.zle.comp.list.mlbeg >= 0 || listprompt.is_some() {
		let mlistp = listprompt.map(|p| {
			if p.is_empty() {
				BString::from(DEF_LISTPROMPT)
			} else {
				p
			}
		});
		display::trashzle(zw);
		zw.zle.display.showinglist = 0;
		zw.zle.display.listshown = 0;
		zw.zle.display.lastlistlen = 0;
		if mlistp.is_some() {
			let dolastprompt = zw.zle.comp.core.dolastprompt != 0;
			zw.zle.display.clearflag = usezle && pe.caps.termflags == 0 && dolastprompt;
			zw.zle.comp.list.mscroll = 1;
		} else {
			zw.zle.display.clearflag = true;
			let fits = zw.zle.comp.core.listdat.nlines + zw.zle.display.nlnct <= lines;
			zw.zle.comp.core.minfo.asked = i32::from(fits);
		}
		zw.zle.comp.list.mlistp = mlistp;
		cl_rest(zw, pe, oamatches, k)
	} else {
		compresult::asklist(
			zw,
			Box::new(move |zw, r| {
				if r != 0 {
					zw.zle.comp.core.amatches = oamatches;
					zw.zle.comp.list.noselect = 1;
					return k(zw, 1);
				}
				cl_rest(zw, pe, oamatches, k)
			}),
		)
	}
}

/// The rest of [`complistmatches`] once it is decided to list.
fn cl_rest(zw: &mut Zw<'_, '_>, pe: Box<Penv>, oamatches: Option<GId>, k: K<i32>) -> WResult {
	let lines = pe.lines;
	let columns = pe.columns;
	let nlnct = zw.zle.display.nlnct;
	{
		let c = &mut *zw.zle.comp;
		let nlines = c.core.listdat.nlines;
		let l = &mut c.list;
		if l.mlbeg >= 0 {
			l.mlend = l.mlbeg + lines - nlnct - l.mhasstat;
			while l.mline >= l.mlend {
				l.mlbeg += 1;
				l.mlend += 1;
			}
		} else {
			l.mlend = 9_999_999;
		}
		if l.mnew != 0 {
			l.mtab_been_reallocated = 1;
			let n = usize::try_from(columns).unwrap_or(0) * usize::try_from(nlines).unwrap_or(0);
			l.mtab = vec![Mt::default(); n];
			l.mgtab = vec![Mg::default(); n];
			l.mlastcols = columns;
			l.mcols = columns;
			l.mlastlines = nlines;
			l.mlines = nlines;
			l.mmtabp = None;
		}
	}
	let l = &zw.zle.comp.list;
	let single =
		l.mnew == 0 && l.inselect != 0 && l.onlnct == nlnct && l.mlbeg >= 0 && l.mlbeg == l.molbeg;
	let fin = move |zw: &mut Zw<'_, '_>| {
		let nlnct = zw.zle.display.nlnct;
		let c = &mut *zw.zle.comp;
		let l = &mut c.list;
		l.onlnct = nlnct;
		l.molbeg = l.mlbeg;
		l.mocol = l.mcol;
		l.moline = l.mline;
		c.core.amatches = oamatches;
		let ns = l.noselect;
		k(zw, if ns < 0 { 0 } else { ns })
	};
	if single {
		let mut pe = pe;
		pe.rewind();
		if zw.zle.comp.list.noselect == 0 {
			let mut p = P { c: &mut zw.zle.comp, d: &mut zw.zle.display, e: &mut pe };
			// No scrolling prompt in menu selection: this never asks.
			let _ = p.singledraw();
			emit(zw, &mut pe);
		}
		return fin(zw);
	}
	let showall = zw.zle.comp.list.mselect >= 0;
	print_list(
		zw,
		pe,
		None,
		showall,
		Box::new(move |zw, printed| {
			if printed == 0 || !zw.zle.display.clearflag {
				zw.zle.comp.list.noselect = 1;
			}
			fin(zw)
		}),
	)
}

// ---- menu selection ---------------------------------------------------------

/// zsh `adjust_mcol(wish, tabp, grp)`: move `*p` (and `*pg`) on its line
/// to the selectable entry nearest column `wish`; true when there is
/// none.
fn adjust_mcol(l: &mut State, wish: i32, p: &mut isize, pg: Option<&mut isize>) -> bool {
	let base = *p - l.mcol as isize;
	let at = |i: i32| mt(l, base + i as isize);
	let mut pp = wish;
	while pp >= 0 && (!at(pp).is_set() || at(pp).mark) {
		pp -= 1;
	}
	let mut n = wish;
	while n < l.mcols && (!at(n).is_set() || at(n).mark) {
		n += 1;
	}
	if n == l.mcols {
		n = -1;
	}
	let c = if pp < 0 {
		if n < 0 {
			return true;
		}
		n
	} else if n < 0 || (l.mcol - pp) < (n - l.mcol) {
		pp
	} else {
		n
	};
	*p = base + c as isize;
	if let Some(pg) = pg {
		*pg += (c - l.mcol) as isize;
	}
	l.mcol = c;
	false
}

/// `mtab[i]` (a `NULL` slot outside the table).
fn mt(l: &State, i: isize) -> Mt {
	usize::try_from(i)
		.ok()
		.and_then(|i| l.mtab.get(i))
		.copied()
		.unwrap_or_default()
}

/// `mgtab[i]` (a `NULL` slot outside the table).
fn mg(l: &State, i: isize) -> Mg {
	usize::try_from(i)
		.ok()
		.and_then(|i| l.mgtab.get(i))
		.copied()
		.unwrap_or_default()
}

/// zsh `struct menustack`: what undo in menu selection goes back to.
struct Menustack {
	line:         Vec<u8>,
	brbeg:        Vec<Brinfo>,
	brend:        Vec<Brinfo>,
	nbrbeg:       i32,
	nbrend:       i32,
	cs:           usize,
	acc:          i32,
	nmatches:     i32,
	mline:        i32,
	mlbeg:        i32,
	nolist:       bool,
	info:         Menuinfo,
	amatches:     Option<GId>,
	pmatches:     Option<GId>,
	lastmatches:  Option<GId>,
	lastlmatches: Option<GId>,
	origline:     Option<BString>,
	origcs:       i32,
	origll:       i32,
	status:       Vec<u8>,
	mode:         i32,
}

impl Menustack {
	/// The entry for the current state (match lists as given).
	fn new(c: &Comp, nolist: bool, status: &[u8], mode: i32, lists: [Option<GId>; 4]) -> Self {
		let [amatches, pmatches, lastmatches, lastlmatches] = lists;
		Self {
			line: c.line.bytes().to_vec(),
			brbeg: c.tricky.brbeg.clone(),
			brend: c.tricky.brend.clone(),
			nbrbeg: c.tricky.nbrbeg,
			nbrend: c.tricky.nbrend,
			cs: c.line.cs,
			acc: c.core.menuacc,
			nmatches: c.core.nmatches,
			mline: c.list.mline,
			mlbeg: c.list.mlbeg,
			nolist,
			info: c.core.minfo.clone(),
			amatches,
			pmatches,
			lastmatches,
			lastlmatches,
			origline: c.tricky.origline.clone(),
			origcs: c.tricky.origcs,
			origll: c.tricky.origll,
			status: status.to_vec(),
			mode,
		}
	}
}

/// `domenuselect`'s locals.
struct Ms {
	dat:         Option<Chdata>,
	/// zsh `p`: the selected entry of `mtab`.
	p:           Option<isize>,
	/// `p` points at `minfo.cur` (zsh's `p = &(minfo.cur)` after undo).
	pcur:        bool,
	/// zsh `pg`.
	pg:          Option<isize>,
	cmd:         Option<BString>,
	do_last_key: bool,
	/// zsh `u` (top last).
	u:           Vec<Menustack>,
	i:           i32,
	acc:         i32,
	wishcol:     i32,
	setwish:     bool,
	oe:          i32,
	wasnext:     bool,
	lbeg:        i32,
	step:        i32,
	pl:          i32,
	broken:      i32,
	first:       bool,
	nolist:      bool,
	mode:        i32,
	modecs:      i32,
	modell:      i32,
	modelen:     i32,
	wasmeta:     bool,
	status:      Vec<u8>,
	modeline:    Option<Vec<u8>>,
	k:           K<i32>,
}

/// zsh `setmstatus(status, sline, sll, scs, csp, llp, lenp)`: the
/// interactive-mode status line. With `restore` (the line to put back
/// and its cursor) the word around the cursor is taken from the line
/// before it is restored, and the old line, cursor, length and
/// `lastend - wb` are returned; else the prefix and suffix are
/// `complastprefix`/`complastsuffix`.
fn setmstatus(
	zw: &mut Zw<'_, '_>,
	status: &mut Vec<u8>,
	restore: Option<(Vec<u8>, i32)>,
) -> Option<(Vec<u8>, i32, i32, i32)> {
	let columns = comp::with_ex(zw, |ex, _| comp::zterm_size(ex)).0;
	let c = &mut *zw.zle.comp;
	let mut ret = None;
	let (p, s): (Vec<u8>, Vec<u8>) = match restore {
		Some((sline, scs)) => {
			let line = c.line.bytes().to_vec();
			let cs = c.line.cs;
			let wb = usize::try_from(c.tricky.wb).unwrap_or(0).min(line.len());
			let lastend = usize::try_from(c.core.lastend).unwrap_or(0);
			ret = Some((
				line.clone(),
				i32::try_from(cs).unwrap_or(0),
				i32::try_from(line.len()).unwrap_or(0),
				c.core.lastend - c.tricky.wb,
			));
			let p = line.get(wb..cs.max(wb)).unwrap_or_default().to_vec();
			let s = if lastend < cs {
				Vec::new()
			} else {
				line
					.get(cs..lastend.min(line.len()))
					.unwrap_or_default()
					.to_vec()
			};
			set_metaline(zw, &sline, scs);
			(p, s)
		},
		None => (
			c.complete.complastprefix.clone().map_or_default(Vec::from),
			c.complete.complastsuffix.clone().map_or_default(Vec::from),
		),
	};
	let (pl, sl) = (p.len() as i32, s.len() as i32);
	let max = (if (columns as usize) < MAX_STATUS {
		columns
	} else {
		MAX_STATUS as i32
	}) - 14;
	if max > 12 {
		let h = (max - 2) >> 1;
		status.clear();
		status.extend_from_slice(b"interactive: ");
		if pl > h - 3 {
			status.extend_from_slice(b"...");
			let from = usize::try_from(pl - h - 3).unwrap_or(0);
			status.extend_from_slice(&p[from.min(p.len())..]);
		} else {
			status.extend_from_slice(&p);
		}
		status.extend_from_slice(b"[]");
		if sl > h - 3 {
			let n = usize::try_from(h - 3).unwrap_or(0).min(s.len());
			status.extend_from_slice(&s[..n]);
			status.extend_from_slice(b"...");
		} else {
			status.extend_from_slice(&s);
		}
	}
	ret
}

/// zsh `msearchpush(p, back)`.
fn msearchpush(l: &mut State, p: Option<isize>, back: bool) {
	l.msearchstack.push(Menusearch {
		str: l.msearchstr.clone(),
		line: l.mline,
		col: l.mcol,
		back,
		state: l.msearchstate,
		ptr: p,
	});
}

/// zsh `msearchpop(backp)`: the last search step undone (the first one
/// stays on the stack).
fn msearchpop(l: &mut State, back: &mut bool) -> Option<isize> {
	let s = l.msearchstack.last()?.clone();
	if l.msearchstack.len() > 1 {
		l.msearchstack.pop();
	}
	l.msearchstr = s.str;
	l.mline = s.line;
	l.mcol = s.col;
	l.msearchstate = s.state;
	*back = s.back;
	s.ptr
}

/// zsh `msearch(ptr, ins, back, rep, wrapp)`: search the list for the
/// search string (`ins` appended) from `ptr`.
fn msearch(
	c: &mut Comp,
	ptr: Option<isize>,
	ins: Option<&[u8]>,
	back: bool,
	rep: bool,
	wrapp: &mut bool,
) -> Option<isize> {
	let nlines = c.core.listdat.nlines;
	let l = &mut c.list;
	let (mut x, mut y) = (l.mcol, l.mline);
	let mut wrap = false;
	let owrap = l.msearchstate & MS_WRAPPED;
	msearchpush(l, ptr, back);
	if let Some(ins) = ins {
		l.msearchstr.extend_from_slice(ins);
	}
	let (mut ex, mut ey) = if back { (l.mcols - 1, -1) } else { (0, nlines) };
	let mcols = l.mcols as isize;
	let mut p = l.mline as isize * mcols + l.mcol as isize;
	let mut last = if rep { mt(l, p) } else { Mt::default() };
	let mut rep = rep;
	loop {
		let e = mt(l, p);
		if !rep && e.m.is_some() && e != last {
			last = e;
			if let Some(m) = e.m.and_then(|r| c.groups.try_mat(r)) {
				let hay: &[u8] = m.disp.as_ref().map_or(m.str.as_slice(), |d| d.as_slice());
				let needle = l.msearchstr.as_slice();
				if needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle) {
					l.mcol = x;
					l.mline = y;
					return Some(p);
				}
			}
		}
		rep = false;
		if back {
			p -= 1;
			x -= 1;
			if x < 0 {
				x = l.mcols - 1;
				y -= 1;
			}
		} else {
			p += 1;
			x += 1;
			if x == l.mcols {
				x = 0;
				y += 1;
			}
		}
		if x == ex && y == ey {
			if back {
				x = l.mcols - 1;
				y = nlines - 1;
				p = y as isize * mcols + x as isize;
			} else {
				x = 0;
				y = 0;
				p = 0;
			}
			ex = l.mcol;
			ey = l.mline;
			if wrap || (x == ex && y == ey) {
				l.msearchstate = MS_FAILED | owrap;
				break;
			}
			l.msearchstate |= MS_WRAPPED;
			wrap = true;
			*wrapp = true;
		}
	}
	None
}

/// zsh `domenuselect(dummy, dat)` (the `menu_start` hook with `dat`, the
/// `menu-select` widget without): run menu selection; `k` gets zsh's
/// return value (0 nothing done; for the hook 1 accepted, 2 left, 3
/// left for a completion widget; for the widget whether to go on
/// completing).
pub fn domenuselect(zw: &mut Zw<'_, '_>, dat: Option<Chdata>, k: K<i32>) -> WResult {
	{
		let l = &mut zw.zle.comp.list;
		l.msearchstack.clear();
		l.msearchstr.clear();
		l.msearchstate = MS_OK;
	}
	let mut status = Vec::new();
	if zw.zle.comp.list.fdat {
		return k(zw, 0);
	}
	if let Some(d) = dat {
		match zw.getsparam(b"MENUSELECT") {
			None => return k(zw, 0),
			Some(s) if i64::from(d.num) < atoi(&s) => return k(zw, 0),
			Some(_) => {},
		}
	}
	let wasmeta = zw.zle.comp.line.s.is_some();
	if !wasmeta {
		zw.zle.comp.line.metafy(zw.ed);
	}
	let (_, lines) = comp::with_ex(zw, |ex, _| comp::zterm_size(ex));
	let nlnct = zw.zle.display.nlnct;
	let mut step = 1;
	if let Some(s) = zw.getsparam(b"MENUSCROLL") {
		let v = zw.params(|ex| arith::mathevali(ex, &s)).unwrap_or(0);
		step = i32::try_from(v).unwrap_or(0);
		if step == 0 {
			step = (lines - nlnct) >> 1;
		} else if step < 0 {
			step += lines - nlnct;
			if step < 0 {
				step = 1;
			}
		}
	}
	let mut mode = 0;
	if let Some(s) = zw.getsparam(b"MENUMODE") {
		if s.as_slice() == b"interactive" {
			mode = MM_INTER;
			let orig = zw
				.zle
				.comp
				.tricky
				.origline
				.clone()
				.map_or_default(Vec::from);
			let ocs = zw.zle.comp.tricky.origcs;
			set_metaline(zw, &orig, ocs);
			setmstatus(zw, &mut status, None);
		} else if s.starts_with(b"search") {
			mode = if s.windows(4).any(|w| w == b"back") {
				MM_BSEARCH
			} else {
				MM_FSEARCH
			};
		}
	}
	let mstatus = zw.getsparam(b"MENUPROMPT").map(|s| {
		if s.is_empty() {
			BString::from(DEF_MENUPROMPT)
		} else {
			BString::from(metafy(&s))
		}
	});
	{
		let l = &mut zw.zle.comp.list;
		l.mhasstat = i32::from(mstatus.as_ref().is_some_and(|s| !s.is_empty()));
		l.mstatus = mstatus;
		l.fdat = true;
	}
	menuselect_bindings(&mut zw.zle.keymaps);
	zw.ed.localkeymap = Some(BString::from("menuselect"));
	zw.zle.comp.list.noselect = 1;
	let ms = Box::new(Ms {
		dat,
		p: None,
		pcur: false,
		pg: None,
		cmd: None,
		do_last_key: false,
		u: Vec::new(),
		i: 0,
		acc: 0,
		wishcol: 0,
		setwish: false,
		oe: zw.zle.comp.core.onlyexpl,
		wasnext: false,
		lbeg: 0,
		step,
		pl: nlnct,
		broken: 0,
		first: true,
		nolist: false,
		mode,
		modecs: 0,
		modell: 0,
		modelen: 0,
		wasmeta,
		status,
		modeline: None,
		k,
	});
	ms_skip(zw, ms)
}

/// `domenuselect`'s `do_menucmp(0)` loop past matches that cannot be
/// selected, then the start of the selection loop.
fn ms_skip(zw: &mut Zw<'_, '_>, ms: Box<Ms>) -> WResult {
	let skip = {
		let c = &mut *zw.zle.comp;
		match cur_match(c) {
			None => false,
			Some(m) => {
				let (pre, post) = (c.core.minfo.prebr.clone(), c.core.minfo.postbr.clone());
				(c.core.menuacc != 0
					&& !compresult::hasbrpsfx(
						c,
						&m,
						pre.as_ref().map(|s| s.as_slice()),
						post.as_ref().map(|s| s.as_slice()),
					))
					|| m.flags & cmf::DUMMY != 0
					|| (m.flags & (cmf::NOLIST | cmf::MULT) != 0 && m.str.is_empty())
			},
		}
	};
	if skip {
		return compresult::do_menucmp(zw, 0, Box::new(move |zw, ()| ms_skip(zw, ms)));
	}
	{
		let gnum = cur_match(&zw.zle.comp).map_or(-1, |m| m.gnum);
		let l = &mut zw.zle.comp.list;
		l.mselect = gnum;
		l.mline = 0;
		l.mlines = 999_999;
		l.mlbeg = 0;
		l.molbeg = -42;
		l.mtab_been_reallocated = 0;
	}
	ms_top(zw, ms)
}

/// The head of `domenuselect`'s loop: find the selection, scroll, set
/// the status line, redisplay.
fn ms_top(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>) -> WResult {
	let (columns, lines) = comp::with_ex(zw, |ex, _| comp::zterm_size(ex));
	{
		let c = &mut *zw.zle.comp;
		let l = &mut c.list;
		if l.mline < 0 || l.mtab_been_reallocated != 0 {
			let mcols = l.mcols.max(0) as usize;
			let rows = l.mtab.len().checked_div(mcols).unwrap_or(0);
			let mut found = None;
			'scan: for y in 0..(l.mlines.max(0) as usize).min(rows) {
				for x in 0..mcols {
					let e = l.mtab[y * mcols + x];
					if e.is_set()
						&& !e.mark
						&& let Some(m) = e.m.and_then(|r| c.groups.try_mat(r))
						&& m.gnum == l.mselect
					{
						found = Some((y, x));
						break 'scan;
					}
				}
			}
			if let Some((y, x)) = found {
				l.mcol = x as i32;
				l.mline = y as i32;
			}
		}
		l.mtab_been_reallocated = 0;
		while l.mline < l.mlbeg {
			l.mlbeg -= ms.step;
			if l.mlbeg < 0 {
				l.mlbeg = 0;
				if l.mline < 0 {
					break;
				}
			}
		}
		let cols = columns as isize;
		if l.mlbeg != 0 && ms.lbeg != l.mlbeg {
			let mut p = (l.mlbeg as isize - 1) * cols;
			while l.mlbeg != 0 {
				if (0..cols).any(|q| {
					let e = mt(l, p + q);
					e.is_set() && !e.mark
				}) {
					break;
				}
				p -= cols;
				l.mlbeg -= 1;
			}
		}
		let space = lines - ms.pl - l.mhasstat;
		if space > 0 {
			while l.mline >= l.mlbeg + space {
				let before = l.mlbeg;
				l.mlbeg += ms.step;
				if l.mlbeg + space > l.mlines {
					l.mlbeg = l.mlines - space;
				}
				if l.mlbeg <= before {
					break;
				}
			}
		}
		if ms.lbeg != l.mlbeg {
			let mut p = l.mlbeg as isize * cols;
			// Past the end of the table every slot is empty.
			while l.mlbeg < l.mlines && p < l.mtab.len() as isize {
				if (0..cols).any(|q| mt(l, p + q).is_set()) {
					break;
				}
				p += cols;
				l.mlbeg += 1;
			}
		}
		ms.lbeg = l.mlbeg;
		c.core.onlyexpl = 0;
	}
	zw.zle.display.showinglist = -2;
	if ms.first && zw.zle.display.listshown == 0 && zw.isset(ZshOpt::Listbeep) {
		utils::handlefeep(zw.ed);
	}
	if ms.first {
		let c = &zw.zle.comp;
		ms.modeline = Some(c.line.bytes().to_vec());
		ms.modecs = i32::try_from(c.line.cs).unwrap_or(0);
		ms.modell = i32::try_from(c.line.ll()).unwrap_or(0);
		ms.modelen = c.core.minfo.len;
	}
	ms.first = false;
	if ms.mode == MM_INTER {
		zw.ed.statusline = Some(BString::from(unmetafy(&ms.status)));
	} else if ms.mode != 0 {
		let st = zw.zle.comp.list.msearchstate;
		let mut s = format!(
			"{}{}isearch{}: ",
			if st & MS_FAILED != 0 { "failed " } else { "" },
			if st & MS_WRAPPED != 0 { "wrapped " } else { "" },
			if ms.mode == MM_FSEARCH {
				""
			} else {
				" backward"
			}
		)
		.into_bytes();
		let room = MAX_STATUS.saturating_sub(s.len() + 1);
		let ss = &zw.zle.comp.list.msearchstr;
		s.extend_from_slice(&ss[..ss.len().min(room)]);
		ms.status = s;
		zw.ed.statusline = Some(BString::from(unmetafy(&ms.status)));
	} else {
		zw.ed.statusline = None;
	}
	if zw.zle.comp.list.noselect < 0 {
		zw.zle.display.showinglist = 0;
		zw.zle.display.clearlist = false;
		zw.ed.clearlist = false;
		zw.zle.display.clearflag = true;
	}
	zrefresh(zw, move |zw| ms_after(zw, ms))
}

/// `domenuselect`'s loop after the redisplay: take the selection from
/// the display.
fn ms_after(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>) -> WResult {
	zw.ed.statusline = None;
	let l = &mut zw.zle.comp.list;
	l.inselect = 1;
	l.selected = 1;
	if l.noselect != 0 {
		if l.noselect < 0 {
			// No selection until after processing the keystroke.
			l.noselect = 0;
			return ms_getk(zw, ms);
		}
		ms.broken = 1;
		return ms_exit(zw, ms);
	}
	if ms.i == 0 {
		let n = usize::try_from(l.mcols.max(0)).unwrap_or(0)
			* usize::try_from(l.mlines.max(0)).unwrap_or(0);
		let n = n.min(l.mtab.len());
		let i = (0..n)
			.rev()
			.find(|&i| l.mtab[i].is_set())
			.map_or(-1, |i| i as i32);
		if i == 0 {
			return ms_exit(zw, ms);
		}
		ms.i = 1;
	}
	let (Some(p), Some(pg)) = (l.mmtabp, l.mgtabp) else {
		// The selected match is not on the display: find its line.
		return ms_top(zw, ms);
	};
	let (mut p, mut pg) = (p as isize, pg as isize);
	let cur = mt(l, p).m;
	let c = &mut *zw.zle.comp;
	c.core.minfo.cur = cur;
	c.core.minfo.group = mg(&c.list, pg).g;
	let l = &mut c.list;
	let cm = Mt { m: cur, mark: false };
	if ms.setwish {
		ms.wishcol = l.mcol;
	} else if l.mcol > ms.wishcol {
		while l.mcol > 0 && mt(l, p - 1) == cm {
			l.mcol -= 1;
			p -= 1;
			pg -= 1;
		}
	} else if l.mcol < ms.wishcol {
		while l.mcol < l.mcols - 1 && mt(l, p + 1) == cm {
			l.mcol += 1;
			p += 1;
			pg += 1;
		}
	}
	ms.p = Some(p);
	ms.pg = Some(pg);
	ms.pcur = false;
	ms.setwish = false;
	ms.wasnext = false;
	ms_getk(zw, ms)
}

/// zsh's `getk:`: read the next key command (unless the last one is to
/// be handled again).
fn ms_getk(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>) -> WResult {
	if ms.do_last_key {
		ms.do_last_key = false;
		return ms_dispatch(zw, ms);
	}
	zw.ed.zmod.mult = 1;
	then(Await::Key, move |zw, got| {
		ms.cmd = match got {
			Got::Key(c) => c,
			_ => None,
		};
		// An interrupt ends the selection without going further.
		if zw.ed.interrupted {
			zw.ed.interrupted = false;
			zw.ed.aborted = false;
		}
		if zw.zle.comp.list.mtab_been_reallocated != 0 {
			ms.do_last_key = true;
			return ms_top(zw, ms);
		}
		ms_dispatch(zw, ms)
	})
}

/// Where a motion starts (zsh's labels in `domenuselect`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lab {
	Down,
	Up,
	Right,
	Left,
	Top,
	Bottom,
}

/// The motions of `domenuselect` from label `lab`, moving `*p` and
/// `mline`/`mcol`.
fn nav(l: &mut State, p: &mut isize, wishcol: &mut i32, wrap: &mut i32, mut lab: Lab) {
	let sel = |l: &State, p: isize| {
		let e = mt(l, p);
		e.is_set() && !e.mark
	};
	loop {
		match lab {
			Lab::Down => {
				let (omline, op) = (l.mline, *p);
				loop {
					if l.mline == l.mlines - 1 {
						if *wrap & 2 != 0 {
							l.mline = omline;
							*p = op;
							break;
						}
						*p -= (l.mline * l.mcols) as isize;
						l.mline = 0;
						*wrap |= 1;
					} else {
						l.mline += 1;
						*p += l.mcols as isize;
					}
					let _ = adjust_mcol(l, *wishcol, p, None);
					if sel(l, *p) {
						break;
					}
				}
				if *wrap == 1 {
					lab = Lab::Right;
					continue;
				}
				return;
			},
			Lab::Up => {
				let (omline, op) = (l.mline, *p);
				loop {
					if l.mline == 0 {
						if *wrap & 2 != 0 {
							l.mline = omline;
							*p = op;
							break;
						}
						l.mline = l.mlines - 1;
						*p += (l.mline * l.mcols) as isize;
						*wrap |= 1;
					} else {
						l.mline -= 1;
						*p -= l.mcols as isize;
					}
					let _ = adjust_mcol(l, *wishcol, p, None);
					if sel(l, *p) {
						break;
					}
				}
				if *wrap == 1 {
					if l.mcol == *wishcol {
						lab = Lab::Left;
						continue;
					}
					*wishcol = l.mcol;
				}
				return;
			},
			Lab::Right => {
				let (omcol, op) = (l.mcol, *p);
				loop {
					if l.mcol == l.mcols - 1 {
						if *wrap & 1 != 0 {
							*p = op;
							l.mcol = omcol;
							break;
						}
						*p -= l.mcol as isize;
						l.mcol = 0;
						*wrap |= 2;
					} else {
						l.mcol += 1;
						*p += 1;
					}
					if sel(l, *p) && !(l.mcol != omcol && mt(l, *p) == mt(l, op)) {
						break;
					}
				}
				*wishcol = l.mcol;
				if *wrap == 2 {
					lab = Lab::Down;
					continue;
				}
				return;
			},
			Lab::Left => {
				let (omcol, op) = (l.mcol, *p);
				loop {
					if l.mcol == 0 {
						if *wrap & 1 != 0 {
							*p = op;
							l.mcol = omcol;
							break;
						}
						l.mcol = l.mcols - 1;
						*p += l.mcol as isize;
						*wrap |= 2;
					} else {
						l.mcol -= 1;
						*p -= 1;
					}
					if sel(l, *p) && !(l.mcol != omcol && mt(l, *p) == mt(l, op)) {
						break;
					}
				}
				*wishcol = l.mcol;
				if *wrap == 2 {
					*p += (l.mcols - 1 - l.mcol) as isize;
					l.mcol = l.mcols - 1;
					*wishcol = l.mcol;
					let _ = adjust_mcol(l, *wishcol, p, None);
					lab = Lab::Up;
					continue;
				}
				return;
			},
			Lab::Top => {
				let (mut ll, mut lp) = (l.mline, *p);
				while l.mline != 0 {
					l.mline -= 1;
					*p -= l.mcols as isize;
					if adjust_mcol(l, *wishcol, p, None) {
						continue;
					}
					if sel(l, *p) {
						lp = *p;
						ll = l.mline;
					}
				}
				l.mline = ll;
				*p = lp;
				return;
			},
			Lab::Bottom => {
				let (mut ll, mut lp) = (l.mline, *p);
				while l.mline < l.mlines - 1 {
					l.mline += 1;
					*p += l.mcols as isize;
					if adjust_mcol(l, *wishcol, p, None) {
						continue;
					}
					if sel(l, *p) {
						lp = *p;
						ll = l.mline;
					}
				}
				l.mline = ll;
				*p = lp;
				return;
			},
		}
	}
}

/// Whether `cmd` is one of `names`.
fn is(cmd: &[u8], names: &[&str]) -> bool {
	names.iter().any(|n| n.as_bytes() == cmd)
}

/// The key's branch of `domenuselect`'s loop.
fn ms_dispatch(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>) -> WResult {
	let Some(cmd) = ms.cmd.clone().filter(|c| c.as_slice() != b"send-break") else {
		utils::handlefeep(zw.ed);
		zw.zle.comp.list.molbeg = -1;
		return ms_exit(zw, ms);
	};
	let cmd = cmd.as_slice();
	let search = ms.mode == MM_FSEARCH || ms.mode == MM_BSEARCH;
	let lines = comp::with_ex(zw, |ex, _| comp::zterm_size(ex)).1;
	if ms.nolist
		&& cmd != b"undo"
		&& (ms.mode == 0 || !is(cmd, &["backward-delete-char", "self-insert", "self-insert-unmeta"]))
	{
		ungetkeycmd(zw);
		return ms_exit(zw, ms);
	}
	if is(cmd, &["accept-line", "accept-search"]) {
		if search {
			ms.mode = 0;
			return ms_top(zw, ms);
		}
		ms.acc = 1;
		return ms_exit(zw, ms);
	}
	if cmd == b"vi-insert" {
		if ms.mode == MM_INTER {
			ms.mode = 0;
			return ms_bottom(zw, ms);
		}
		// Entering interactive mode, as at the start.
		ms.mode = MM_INTER;
		let orig = zw
			.zle
			.comp
			.tricky
			.origline
			.clone()
			.map_or_default(Vec::from);
		let ocs = zw.zle.comp.tricky.origcs;
		set_metaline(zw, &orig, ocs);
		let mut st = std::mem::take(&mut ms.status);
		setmstatus(zw, &mut st, None);
		ms.status = st;
		return ms_top(zw, ms);
	}
	if cmd == b"accept-and-infer-next-history"
		|| (ms.mode == MM_INTER && is(cmd, &["self-insert", "self-insert-unmeta"]))
	{
		return ms_infer(zw, ms, cmd == b"accept-and-infer-next-history", cmd == b"self-insert");
	}
	if is(cmd, &["accept-and-hold", "accept-and-menu-complete"]) {
		return ms_hold(zw, ms);
	}
	if cmd == b"undo" || (ms.mode == MM_INTER && cmd == b"backward-delete-char") {
		return ms_undo(zw, ms);
	}
	if cmd == b"redisplay" {
		return unmeta_call(zw, display::redisplay, move |zw| {
			zw.zle.comp.list.molbeg = -42;
			ms_top(zw, ms)
		});
	}
	if cmd == b"clear-screen" {
		return unmeta_call(zw, display::clear_screen, move |zw| {
			zw.zle.comp.list.molbeg = -42;
			ms_top(zw, ms)
		});
	}
	let Some(mut p) = ms.p else {
		return ms_top(zw, ms);
	};
	let mut wrap = 0;
	let mut wishcol = ms.wishcol;
	let motion = if is(cmd, &[
		"down-history",
		"down-line-or-history",
		"down-line-or-search",
		"vi-down-line-or-history",
	]) {
		Some(Lab::Down)
	} else if is(cmd, &[
		"up-history",
		"up-line-or-history",
		"up-line-or-search",
		"vi-up-line-or-history",
	]) {
		Some(Lab::Up)
	} else if cmd == b"beginning-of-history" {
		Some(Lab::Top)
	} else if cmd == b"end-of-history" {
		Some(Lab::Bottom)
	} else if is(cmd, &["forward-char", "vi-forward-char"]) {
		Some(Lab::Right)
	} else if is(cmd, &["backward-char", "vi-backward-char"]) {
		Some(Lab::Left)
	} else {
		None
	};
	if let Some(lab) = motion {
		ms.mode = 0;
		nav(&mut zw.zle.comp.list, &mut p, &mut wishcol, &mut wrap, lab);
		ms.p = Some(p);
		ms.wishcol = wishcol;
		return ms_bottom(zw, ms);
	}
	if is(cmd, &["emacs-forward-word", "vi-forward-word", "vi-forward-word-end", "forward-word"]) {
		ms.mode = 0;
		let l = &mut zw.zle.comp.list;
		let mut i = lines - ms.pl - 1;
		let oi = i;
		let mut ll = 0;
		let mut lp = None;
		let mut top = l.mline == l.mlines - 1;
		while !top && i > 0 {
			if l.mline == l.mlines - 1 {
				if i != oi && lp.is_some() {
					break;
				}
				top = true;
				break;
			}
			l.mline += 1;
			p += l.mcols as isize;
			if adjust_mcol(l, wishcol, &mut p, None) {
				continue;
			}
			let e = mt(l, p);
			if e.is_set() && !e.mark {
				i -= 1;
				lp = Some(p);
				ll = l.mline;
			}
		}
		if top {
			nav(l, &mut p, &mut wishcol, &mut wrap, Lab::Top);
		} else {
			if let Some(lp) = lp {
				p = lp;
			}
			l.mline = ll;
		}
		ms.p = Some(p);
		return ms_bottom(zw, ms);
	}
	if is(cmd, &["emacs-backward-word", "vi-backward-word", "backward-word"]) {
		ms.mode = 0;
		let l = &mut zw.zle.comp.list;
		let mut i = lines - ms.pl - 1;
		let oi = i;
		let mut ll = 0;
		let mut lp = None;
		let mut bottom = l.mline == 0;
		while !bottom && i > 0 {
			if l.mline == 0 {
				if i != oi && lp.is_some() {
					break;
				}
				bottom = true;
				break;
			}
			l.mline -= 1;
			p -= l.mcols as isize;
			if adjust_mcol(l, wishcol, &mut p, None) {
				continue;
			}
			// zsh tests `*p || !mmarked(*p)`, true for every slot.
			i -= 1;
			lp = Some(p);
			ll = l.mline;
		}
		if bottom {
			nav(l, &mut p, &mut wishcol, &mut wrap, Lab::Bottom);
		} else {
			if let Some(lp) = lp {
				p = lp;
			}
			l.mline = ll;
		}
		ms.p = Some(p);
		return ms_bottom(zw, ms);
	}
	if is(cmd, &[
		"beginning-of-buffer-or-history",
		"beginning-of-line",
		"beginning-of-line-hist",
		"vi-beginning-of-line",
	]) {
		ms.mode = 0;
		let l = &mut zw.zle.comp.list;
		p -= l.mcol as isize;
		l.mcol = 0;
		while (!mt(l, p).is_set() || mt(l, p).mark) && l.mcol < l.mcols {
			l.mcol += 1;
			p += 1;
		}
		ms.wishcol = 0;
		ms.p = Some(p);
		return ms_bottom(zw, ms);
	}
	if is(cmd, &["end-of-buffer-or-history", "end-of-line", "end-of-line-hist", "vi-end-of-line"]) {
		ms.mode = 0;
		let l = &mut zw.zle.comp.list;
		p += (l.mcols - l.mcol - 1) as isize;
		l.mcol = l.mcols - 1;
		while (!mt(l, p).is_set() || mt(l, p).mark) && l.mcol > 0 {
			l.mcol -= 1;
			p -= 1;
		}
		ms.wishcol = l.mcols - 1;
		ms.p = Some(p);
		return ms_bottom(zw, ms);
	}
	if is(cmd, &["vi-forward-blank-word", "vi-forward-blank-word-end", "vi-backward-blank-word"]) {
		ms.mode = 0;
		let fwd = cmd != b"vi-backward-blank-word";
		let l = &mut zw.zle.comp.list;
		let mut pg = ms.pg.unwrap_or(p);
		let g = mg(l, pg);
		let ol = l.mline;
		loop {
			let span = (l.mline * l.mcols) as isize;
			if fwd {
				if l.mline == l.mlines - 1 {
					p -= span;
					pg -= span;
					l.mline = 0;
				} else {
					l.mline += 1;
					p += l.mcols as isize;
					pg += l.mcols as isize;
				}
			} else if l.mline == 0 {
				l.mline = l.mlines - 1;
				let span = (l.mline * l.mcols) as isize;
				p += span;
				pg += span;
			} else {
				l.mline -= 1;
				p -= l.mcols as isize;
				pg -= l.mcols as isize;
			}
			let _ = adjust_mcol(l, wishcol, &mut p, Some(&mut pg));
			let e = mg(l, pg);
			if ol == l.mline || (e != g && e.g.is_some() && !e.mark) {
				break;
			}
		}
		ms.p = Some(p);
		ms.pg = Some(pg);
		return ms_bottom(zw, ms);
	}
	if is(cmd, &[
		"complete-word",
		"expand-or-complete",
		"expand-or-complete-prefix",
		"menu-complete",
		"menu-expand-or-complete",
		"menu-select",
	]) {
		if ms.mode == MM_INTER {
			// do_menucmp() put the match on the line; interactive mode
			// shows only what was typed.
			let modeline = ms.modeline.clone().unwrap_or_default();
			let c = &mut *zw.zle.comp;
			c.tricky.origline = Some(BString::from(modeline.clone()));
			c.tricky.origcs = ms.modecs;
			c.tricky.origll = ms.modell;
			let ll = usize::try_from(ms.modell).unwrap_or(0).min(modeline.len());
			set_metaline(zw, &modeline[..ll], ms.modecs);
			zw.zle.comp.core.minfo.len = ms.modelen;
			return ms_top(zw, ms);
		}
		ms.mode = 0;
		zw.zle.comp.tricky.comprecursive = 1;
		return compresult::do_menucmp(
			zw,
			0,
			Box::new(move |zw, ()| {
				let gnum = cur_match(&zw.zle.comp).map_or(-1, |m| m.gnum);
				let l = &mut zw.zle.comp.list;
				l.mselect = gnum;
				ms.setwish = true;
				l.mline = -1;
				ms_top(zw, ms)
			}),
		);
	}
	if cmd == b"reverse-menu-complete" {
		ms.mode = 0;
		zw.zle.comp.tricky.comprecursive = 1;
		zw.ed.zmod.mult = -zw.ed.zmod.mult;
		return compresult::do_menucmp(
			zw,
			0,
			Box::new(move |zw, ()| {
				let gnum = cur_match(&zw.zle.comp).map_or(-1, |m| m.gnum);
				let l = &mut zw.zle.comp.list;
				l.mselect = gnum;
				ms.setwish = true;
				l.mline = -1;
				ms_top(zw, ms)
			}),
		);
	}
	let fsearch = cmd == b"history-incremental-search-forward";
	let bsearch = cmd == b"history-incremental-search-backward";
	if fsearch
		|| bsearch
		|| (search && is(cmd, &["self-insert", "self-insert-unmeta", "bracketed-paste"]))
	{
		if cmd == b"bracketed-paste" {
			return read_paste(
				Paste::default(),
				Box::new(move |zw, text| ms_isearch(zw, ms, p, Some(text))),
			);
		}
		let ins = if is(cmd, &["self-insert", "self-insert-unmeta"]) {
			if cmd == b"self-insert-unmeta" {
				misc::fixunmeta(zw.ed);
			}
			Some(match zw.ed.lastchar_wide {
				Some(c) => utils::zlecharasstring(c),
				None => vec![zw.ed.lastchar.to_le_bytes()[0]],
			})
		} else {
			None
		};
		return ms_isearch(zw, ms, p, ins);
	}
	if search && cmd == b"backward-delete-char" {
		let mut back = true;
		let np = msearchpop(&mut zw.zle.comp.list, &mut back);
		ms.mode = if back { MM_BSEARCH } else { MM_FSEARCH };
		ms.wishcol = zw.zle.comp.list.mcol;
		if let Some(np) = np {
			p = np;
			let wc = ms.wishcol;
			let _ = adjust_mcol(&mut zw.zle.comp.list, wc, &mut p, None);
		}
		ms.p = Some(p);
		return ms_bottom(zw, ms);
	}
	if cmd == b"undefined-key" {
		ms.mode = 0;
		return ms_top(zw, ms);
	}
	ungetkeycmd(zw);
	if zw
		.zle
		.widgets
		.get(cmd)
		.is_some_and(|w| w.flags & wflags::NCOMP != 0)
	{
		ms.acc = 0;
		ms.broken = 2;
	} else {
		ms.acc = 1;
	}
	ms_exit(zw, ms)
}

/// zsh `bracketedstring()`: the text of a bracketed paste.
fn read_paste(p: Paste, done: comp::K<Vec<u8>>) -> WResult {
	then(Await::Char, move |zw, got| {
		let mut p = p;
		let Got::Char(Some(c)) = got else {
			return done(zw, p.finish());
		};
		for b in utils::zlecharasstring(c) {
			if p.push(b) {
				return done(zw, p.finish());
			}
		}
		read_paste(p, done)
	})
}

/// The incremental search branch (`history-incremental-search-*`, and
/// characters typed in search mode): `ins` is what was typed.
fn ms_isearch(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>, mut p: isize, ins: Option<Vec<u8>>) -> WResult {
	let cmd = ms.cmd.clone().unwrap_or_default();
	let op = p;
	let was = ms.mode == MM_FSEARCH || ms.mode == MM_BSEARCH;
	let is_ins = ins.is_some();
	let back = cmd.as_slice() == b"history-incremental-search-backward";
	let fsearch = cmd.as_slice() == b"history-incremental-search-forward";
	loop {
		let c = &mut *zw.zle.comp;
		if was {
			p += (ms.wishcol - c.list.mcol) as isize;
			c.list.mcol = ms.wishcol;
		}
		if !is_ins {
			if was {
				if c.list.msearchstr.is_empty()
					&& back == (ms.mode == MM_BSEARCH)
					&& let Some(last) = c.list.lastsearch.clone()
				{
					c.list.msearchstr = last;
					ms.mode = 0;
				}
			} else {
				c.list.msearchstr.clear();
				c.list.msearchstack.clear();
				c.list.msearchstate = MS_OK;
			}
		}
		let mut wrap = false;
		let sback = if is_ins { ms.mode == MM_BSEARCH } else { back };
		let np = msearch(c, Some(p), ins.as_deref(), sback, was && !is_ins, &mut wrap);
		if !is_ins {
			ms.mode = if back { MM_BSEARCH } else { MM_FSEARCH };
		}
		if !c.list.msearchstr.is_empty() {
			c.list.lastsearch = Some(c.list.msearchstr.clone());
		}
		if let Some(np) = np {
			ms.wishcol = c.list.mcol;
			p = np;
		}
		let wc = ms.wishcol;
		let _ = adjust_mcol(&mut c.list, wc, &mut p, None);
		let same = mt(&c.list, p).m == mt(&c.list, op).m;
		if !((back || fsearch) && np.is_some() && !wrap && was && same) {
			break;
		}
	}
	ms.p = Some(p);
	ms_bottom(zw, ms)
}

/// `accept-and-infer-next-history`, and a character typed in
/// interactive mode: push the undo state and complete again.
fn ms_infer(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>, infer: bool, selfins: bool) -> WResult {
	{
		let c = &mut *zw.zle.comp;
		let lists = [c.core.amatches, c.core.pmatches, c.core.lastmatches, c.core.lastlmatches];
		let s = Menustack::new(c, ms.nolist, &ms.status, ms.mode, lists);
		ms.u.push(s);
		c.tricky.menucmp = 0;
		c.core.menuacc = 0;
		c.core.hasoldlist = 0;
		c.core.minfo.cur = None;
	}
	compresult::suffix::fixsuffix(&mut zw.zle.comp, zw.ed);
	undo::handleundo(zw.ed);
	{
		let c = &mut *zw.zle.comp;
		c.tricky.validlist = 0;
		c.core.amatches = None;
		c.core.pmatches = None;
		c.core.lastmatches = None;
	}
	compresult::invalidate_list(zw);
	zw.zle.comp.core.iforcemenu = 1;
	zw.zle.comp.tricky.comprecursive = 1;
	if infer {
		ms.mode = 0;
		return ms_infer_complete(zw, ms, None);
	}
	// Interactive mode: the line as typed, the character added, that line
	// remembered.
	let orig = zw
		.zle
		.comp
		.tricky
		.origline
		.clone()
		.map_or_default(Vec::from);
	let ocs = zw.zle.comp.tricky.origcs;
	set_metaline(zw, &orig, ocs);
	let f: fn(&mut Zw<'_, '_>) -> WResult = if selfins {
		misc::selfinsert
	} else {
		misc::selfinsertunmeta
	};
	unmeta_call(zw, f, move |zw| {
		let c = &mut *zw.zle.comp;
		c.core.minfo.len += 1;
		c.core.minfo.end += 1;
		let save = (c.line.bytes().to_vec(), i32::try_from(c.line.cs).unwrap_or(0));
		c.core.iforcemenu = -1;
		ms_infer_complete(zw, ms, Some(save))
	})
}

/// [`ms_infer`]'s nested completion and what follows it.
fn ms_infer_complete(zw: &mut Zw<'_, '_>, ms: Box<Ms>, save: Option<(Vec<u8>, i32)>) -> WResult {
	unmeta_call(zw, tricky::menucomplete, move |zw| {
		let mut ms = ms;
		zw.zle.comp.core.iforcemenu = 0;
		if let Some(save) = save {
			let mut st = std::mem::take(&mut ms.status);
			if let Some((line, cs, ll, len)) = setmstatus(zw, &mut st, Some(save)) {
				ms.modeline = Some(line);
				ms.modecs = cs;
				ms.modell = ll;
				ms.modelen = len;
			}
			ms.status = st;
		}
		let c = &zw.zle.comp;
		if c.core.nmatches < 1 || cur_match(c).is_none() {
			ms.nolist = true;
			zw.ed.statusline = (ms.mode == MM_INTER).then(|| BString::from(unmetafy(&ms.status)));
			if zw.zle.comp.core.nmessages != 0 {
				zw.zle.display.showinglist = -2;
				return zrefresh(zw, move |zw| {
					zw.zle.comp.list.noselect = -1;
					zw.ed.statusline = None;
					ms_getk(zw, ms)
				});
			}
			display::trashzle(zw);
			zsetterm(zw);
			let caps = display::term_caps(zw);
			let mut out = Vec::new();
			if caps.tccan(Cap::ClearEod) {
				out.extend_from_slice(&caps.tputs(Cap::ClearEod));
			}
			out.extend_from_slice(b"no matches\r");
			display::tcmultout(&caps, &mut out, Cap::Up, Cap::MultUp, i64::from(zw.zle.display.nlnct));
			if let Some(t) = zw.zle.tty.as_mut() {
				t.put(&out);
			}
			zw.zle.display.showinglist = 0;
			zw.zle.display.clearlist = false;
			zw.ed.clearlist = false;
			zw.zle.display.clearflag = true;
			return zrefresh(zw, move |zw| {
				zw.zle.display.showinglist = 0;
				zw.zle.display.clearlist = false;
				zw.ed.clearlist = false;
				zw.ed.statusline = None;
				ms_getk(zw, ms)
			});
		}
		zw.zle.display.clearlist = true;
		zw.zle.display.listshown = 1;
		let gnum = cur_match(&zw.zle.comp).map_or(-1, |m| m.gnum);
		let l = &mut zw.zle.comp.list;
		l.mselect = gnum;
		ms.setwish = true;
		ms.wasnext = true;
		l.mline = 0;
		l.molbeg = -42;
		ms_top(zw, ms)
	})
}

/// `accept-and-hold`, `accept-and-menu-complete`: insert the match,
/// keep it, go on with the next.
fn ms_hold(zw: &mut Zw<'_, '_>, ms: Box<Ms>) -> WResult {
	if ms.mode == MM_INTER
		&& let Some(m) = cur_match(&zw.zle.comp)
	{
		return compresult::do_single(zw, m, Box::new(move |zw, ()| ms_hold2(zw, ms)));
	}
	ms_hold2(zw, ms)
}

/// [`ms_hold`] after the interactive insertion.
fn ms_hold2(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>) -> WResult {
	ms.mode = 0;
	let s = Menustack::new(&zw.zle.comp, ms.nolist, &ms.status, ms.mode, [None; 4]);
	ms.u.push(s);
	compresult::accept_last(
		zw,
		Box::new(move |zw, _| {
			undo::handleundo(zw.ed);
			zw.zle.comp.tricky.comprecursive = 1;
			compresult::do_menucmp(
				zw,
				0,
				Box::new(move |zw, ()| {
					let mut ms = ms;
					let cur = zw.zle.comp.core.minfo.cur;
					let gnum = cur_match(&zw.zle.comp).map_or(-1, |m| m.gnum);
					let l = &mut zw.zle.comp.list;
					l.mselect = gnum;
					let Some(mut p) = ms.p else {
						return ms_top(zw, ms);
					};
					let cm = Mt { m: cur, mark: false };
					p -= l.mcol as isize;
					l.mcol = 0;
					let ol = l.mline;
					loop {
						l.mcol = 0;
						while l.mcol < l.mcols {
							if mt(l, p) == cm {
								break;
							}
							l.mcol += 1;
							p += 1;
						}
						if l.mcol != l.mcols {
							break;
						}
						l.mline += 1;
						if l.mline == l.mlines {
							l.mline = 0;
							p -= (l.mlines * l.mcols) as isize;
						}
						if l.mline == ol {
							break;
						}
					}
					ms.p = Some(p);
					if mt(l, p) != cm {
						l.noselect = 1;
						zw.zle.display.clearlist = true;
						zw.zle.display.listshown = 1;
						zw.zle.comp.core.onlyexpl = 0;
						return zrefresh(zw, move |zw| ms_exit(zw, ms));
					}
					ms.setwish = true;
					ms_top(zw, ms)
				}),
			)
		}),
	)
}

/// `undo` (and `backward-delete-char` in interactive mode): back to the
/// state before the last accept or interactive character.
fn ms_undo(zw: &mut Zw<'_, '_>, mut ms: Box<Ms>) -> WResult {
	let Some(u) = ms.u.pop() else {
		return ms_exit(zw, ms);
	};
	undo::handleundo(zw.ed);
	set_metaline(zw, &u.line, i32::try_from(u.cs).unwrap_or(0));
	{
		let c = &mut *zw.zle.comp;
		c.core.menuacc = u.acc;
		c.core.minfo = u.info.clone();
		c.list.mline = u.mline;
		c.list.mlbeg = u.mlbeg;
		if u.lastmatches.is_some() && c.core.lastmatches != u.lastmatches {
			if c.core.lastmatches.is_some() {
				let lm = c.core.lastmatches;
				compcore::freematches(c, lm, false);
			}
			c.core.amatches = u.amatches;
			c.core.pmatches = u.pmatches;
			c.core.lastmatches = u.lastmatches;
			c.core.lastlmatches = u.lastlmatches;
			c.core.nmatches = u.nmatches;
			c.core.hasoldlist = 1;
			c.tricky.validlist = 1;
		}
		c.tricky.brbeg = u.brbeg;
		c.tricky.brend = u.brend;
		c.tricky.nbrbeg = u.nbrbeg;
		c.tricky.nbrend = u.nbrend;
		c.tricky.origline = u.origline;
		c.tricky.origcs = u.origcs;
		c.tricky.origll = u.origll;
		ms.status = u.status;
		ms.mode = u.mode;
		ms.nolist = u.nolist;
		ms.pcur = true;
		c.core.listdat.valid = false;
		c.list.molbeg = -42;
	}
	zw.zle.display.clearlist = true;
	ms.setwish = true;
	if ms.nolist {
		zw.ed.statusline = (ms.mode == MM_INTER).then(|| BString::from(unmetafy(&ms.status)));
		return zrefresh(zw, move |zw| {
			zw.ed.statusline = None;
			ms_getk(zw, ms)
		});
	}
	if ms.mode != 0 {
		return ms_top(zw, ms);
	}
	ms_bottom(zw, ms)
}

/// The end of a pass through the loop: insert the selected match (zsh
/// `do_single(**p); mselect = (**p)->gnum;`).
fn ms_bottom(zw: &mut Zw<'_, '_>, ms: Box<Ms>) -> WResult {
	let r = if ms.pcur {
		zw.zle.comp.core.minfo.cur
	} else {
		ms.p.and_then(|p| mt(&zw.zle.comp.list, p).m)
	};
	let Some(m) = r.and_then(|r| zw.zle.comp.groups.try_mat(r)).cloned() else {
		return ms_top(zw, ms);
	};
	let gnum = m.gnum;
	compresult::do_single(
		zw,
		m,
		Box::new(move |zw, ()| {
			zw.zle.comp.list.mselect = gnum;
			ms_top(zw, ms)
		}),
	)
}

/// After `domenuselect`'s loop: clean up, insert the match when
/// accepted, redisplay.
fn ms_exit(zw: &mut Zw<'_, '_>, ms: Box<Ms>) -> WResult {
	{
		let c = &mut *zw.zle.comp;
		for s in ms.u.iter().rev() {
			if s.lastmatches != c.core.lastmatches {
				compcore::freematches(c, s.lastmatches, false);
			}
		}
		let l = &mut c.list;
		l.mselect = -1;
		l.mlastcols = -1;
		l.mlastlines = -1;
		l.mstatus = None;
		l.inselect = 0;
		l.mhasstat = 0;
	}
	zw.ed.localkeymap = None;
	if ms.nolist {
		zw.zle.display.clearlist = true;
		zw.zle.display.listshown = 1;
	}
	let c = &zw.zle.comp;
	if ms.acc != 0 && c.tricky.validlist != 0 && c.core.minfo.cur.is_some() {
		let c = &mut *zw.zle.comp;
		c.tricky.menucmp = 0;
		c.tricky.lastambig = 0;
		c.core.hasoldlist = 0;
		if let Some(m) = cur_match(c) {
			return compresult::do_single(zw, m, Box::new(move |zw, ()| ms_exit2(zw, ms)));
		}
	}
	ms_exit2(zw, ms)
}

/// [`ms_exit`] after the insertion.
fn ms_exit2(zw: &mut Zw<'_, '_>, ms: Box<Ms>) -> WResult {
	if ms.wasnext || ms.broken != 0 {
		zw.zle.comp.tricky.menucmp = 1;
		zw.zle.display.showinglist = if zw.zle.comp.tricky.validlist != 0 && !ms.nolist {
			-2
		} else {
			0
		};
		zw.zle.comp.core.minfo.asked = 0;
		if zw.zle.comp.list.noselect == 0 {
			let nos = zw.zle.comp.list.noselect;
			return zrefresh(zw, move |zw| {
				zw.zle.comp.list.noselect = nos;
				ms_exit3(zw, ms)
			});
		}
	}
	ms_exit3(zw, ms)
}

/// [`ms_exit`]'s final redisplay and return value.
fn ms_exit3(zw: &mut Zw<'_, '_>, ms: Box<Ms>) -> WResult {
	let fin = move |zw: &mut Zw<'_, '_>, ms: Box<Ms>| {
		zw.zle.comp.list.mlbeg = -1;
		zw.zle.comp.list.fdat = false;
		if !ms.wasmeta {
			zw.zle.comp.line.unmetafy(zw.ed);
		}
		let noselect = zw.zle.comp.list.noselect;
		let ret = if ms.broken == 2 {
			3
		} else if ms.dat.is_some() && ms.broken == 0 {
			if ms.acc != 0 { 1 } else { 2 }
		} else {
			i32::from(noselect == 0) ^ ms.acc
		};
		(ms.k)(zw, ret)
	};
	if zw.zle.comp.list.noselect == 0 && (ms.dat.is_none() || ms.acc != 0) {
		zw.zle.comp.list.mlbeg = -1;
		let validlist = zw.zle.comp.tricky.validlist != 0;
		zw.zle.display.showinglist = if validlist && !ms.nolist { -2 } else { 0 };
		zw.zle.comp.core.onlyexpl = ms.oe;
		if ms.acc != 0 && zw.zle.display.listshown != 0 {
			zw.zle.display.clearlist = true;
			zw.zle.display.listshown = 1;
			zw.zle.display.showinglist = 1;
		} else if zw.zle.comp.core.smatches == 0 {
			zw.zle.display.clearlist = true;
			zw.zle.display.listshown = 1;
		}
		return zrefresh(zw, move |zw| fin(zw, ms));
	}
	fin(zw, ms)
}

/// zsh `menuselect` (the `menu-select` widget): complete as
/// `menu-complete` does, then select from the menu.
pub fn menuselect(zw: &mut Zw<'_, '_>) -> WResult {
	if zw.zle.comp.core.minfo.cur.is_none() {
		zw.zle.comp.list.selected = 0;
		let r = tricky::menucomplete(zw);
		return seq(zw, r, |zw, _| {
			let c = &zw.zle.comp;
			if (c.core.minfo.cur.is_some() && c.core.minfo.asked == 2) || c.list.selected != 0 {
				return WResult::Done(0);
			}
			menuselect2(zw, true)
		});
	}
	menuselect2(zw, false)
}

/// The rest of [`menuselect`] (`d`: a completion was just started).
fn menuselect2(zw: &mut Zw<'_, '_>, d: bool) -> WResult {
	let c = &zw.zle.comp;
	if c.core.minfo.cur.is_none() {
		return WResult::Done(0);
	}
	let more = move |zw: &mut Zw<'_, '_>, go: bool| {
		if go && !d {
			let r = tricky::menucomplete(zw);
			return seq(zw, r, |_, _| WResult::Done(0));
		}
		WResult::Done(0)
	};
	if c.core.minfo.asked == 2 {
		return more(zw, true);
	}
	domenuselect(zw, None, Box::new(move |zw, r| more(zw, r != 0)))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::comp::types::MRef;

	#[test]
	fn atoi_like_c() {
		assert_eq!(atoi(b"  12abc"), 12);
		assert_eq!(atoi(b"-3"), -3);
		assert_eq!(atoi(b"x"), 0);
	}

	fn table(rows: &[&[u8]]) -> State {
		let mut l = State::default();
		l.mcols = rows[0].len() as i32;
		l.mlines = rows.len() as i32;
		for row in rows {
			for (i, &c) in row.iter().enumerate() {
				l.mtab.push(match c {
					b'.' => Mt::default(),
					b'#' => Mt { m: None, mark: true },
					c => Mt { m: Some(MRef { g: GId(0), i: usize::from(c - b'a') }), mark: false },
				});
				let _ = i;
			}
		}
		l
	}

	#[test]
	fn motions_wrap_like_zsh() {
		// Two lines of two-column entries.
		let mut l = table(&[b"aabb", b"ccdd"]);
		let mut p = 0isize;
		let (mut wish, mut wrap) = (0, 0);
		nav(&mut l, &mut p, &mut wish, &mut wrap, Lab::Right);
		assert_eq!((l.mline, l.mcol, p), (0, 2, 2));
		wrap = 0;
		nav(&mut l, &mut p, &mut wish, &mut wrap, Lab::Right);
		// Off the end of the line: the next line's first entry.
		assert_eq!((l.mline, l.mcol), (1, 0));
		wrap = 0;
		nav(&mut l, &mut p, &mut wish, &mut wrap, Lab::Up);
		assert_eq!((l.mline, l.mcol), (0, 0));
		wrap = 0;
		nav(&mut l, &mut p, &mut wish, &mut wrap, Lab::Bottom);
		assert_eq!(l.mline, 1);
	}

	#[test]
	fn adjust_skips_marks() {
		let mut l = table(&[b"##ab"]);
		let mut p = 0isize;
		assert!(!adjust_mcol(&mut l, 0, &mut p, None));
		assert_eq!((l.mcol, p), (2, 2));
		let mut l = table(&[b"####"]);
		let mut p = 0isize;
		assert!(adjust_mcol(&mut l, 0, &mut p, None));
	}
}
