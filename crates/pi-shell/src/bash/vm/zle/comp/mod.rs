//! The completion engine of zsh 5.9 (`Src/Zle/zle_tricky.c`,
//! `complete.c`, `compcore.c`, `compmatch.c`, `compresult.c`,
//! `complist.c`, `computil.c`, `compctl.c`).
//!
//! zsh keeps completion state in C globals, one set per source file; here
//! they are the fields of [`Comp`], one sub-struct per file with the C
//! names, held by the editor ([`Zle::comp`](super::Zle)) so it survives
//! between widgets the way zsh's globals do (the list shown, the menu in
//! progress, `validlist`, …) and is copied into subshells with the rest
//! of the editor.
//!
//! Strings are zsh's internal form (metafied, tokenized where zsh keeps
//! them tokenized). While a completion widget runs, the line is
//! [`Comp::line`] (zsh `zlemetaline`/`zlemetacs`/`zlemetall` after
//! `metafy_line()`); [`MetaLine`] has the metafied-mode line edits of
//! `zle_utils.c`.
//!
//! Code that waits (for a shell function, a key, a refresh) is written in
//! continuation-passing style over the widget protocol of
//! [`exec`](super::exec): it returns a [`WResult`] and takes the rest of
//! its caller as a [`K`].

pub mod compcore;
pub mod compctl;
pub mod complete;
pub mod complist;
pub mod compmatch;
pub mod compresult;
pub mod computil;
pub mod tricky;
pub mod types;

use bstr::BString;

use super::{
	Editor,
	exec::{WResult, Zw},
	from_line, to_line,
};
use crate::bash::{
	syntax::zsh::tok,
	vm::{expand::Expander, proc::Vproc, state},
	zshopt::ZshOpt,
};

/// The rest of a computation that may wait: called with the value once it
/// is there (zsh's C call returning to its caller).
pub type K<T> = Box<dyn FnOnce(&mut Zw<'_, '_>, T) -> WResult + Send>;

/// zsh `QT_*` quoting kinds, as the bytes of `compqstack` (and the
/// `instring` values of the word being completed).
pub mod qt {
	/// `QT_NONE`.
	pub const NONE: u8 = 0;
	/// `QT_BACKSLASH`.
	pub const BACKSLASH: u8 = 1;
	/// `QT_SINGLE`.
	pub const SINGLE: u8 = 2;
	/// `QT_DOUBLE`.
	pub const DOUBLE: u8 = 3;
	/// `QT_DOLLARS`.
	pub const DOLLARS: u8 = 4;
	/// `QT_BACKTICK`.
	pub const BACKTICK: u8 = 5;
	/// `QT_SINGLE_OPTIONAL`.
	pub const SINGLE_OPTIONAL: u8 = 6;
	/// `QT_BACKSLASH_PATTERN`.
	pub const BACKSLASH_PATTERN: u8 = 7;
	/// `QT_BACKSLASH_SHOWNULL`.
	pub const BACKSLASH_SHOWNULL: u8 = 8;
}

/// All completion state of one editor (zsh's completion globals).
#[derive(Clone, Debug, Default)]
pub struct Comp {
	/// The metafied line while completion code runs (zsh `zlemetaline`).
	pub line:          MetaLine,
	/// zsh `incompfunc`: 0, 1 in a completion function, 2 in a compctl
	/// function.
	pub incompfunc:    u8,
	/// zsh `incompctlfunc`.
	pub incompctlfunc: bool,
	/// zsh `hascompmod`: zsh/complete is loaded.
	pub hascompmod:    bool,
	/// zsh `compwidget`: the completion widget running (its name).
	pub compwidget:    Option<BString>,
	/// The group arena (`amatches`, `pmatches`, … are heads in it).
	pub groups:        types::Groups,
	/// The cline arena.
	pub clines:        types::Clines,
	/// `zle_tricky.c`'s globals.
	pub tricky:        tricky::State,
	/// complete.c's globals (the special parameters' values).
	pub complete:      complete::State,
	/// compcore.c's globals.
	pub core:          compcore::State,
	/// compmatch.c's globals.
	pub matcher:       compmatch::State,
	/// compresult.c's globals.
	pub result:        compresult::State,
	/// complist.c's globals.
	pub list:          complist::State,
	/// zsh/compctl's runs (compctl.c statics).
	pub cc:            compctl::CcRun,
}

/// The completion state of `vp`'s editor, when it has one (shell code and
/// builtins: [`Vproc::zle`] is in place while they run).
pub fn comp(vp: &Vproc) -> Option<&Comp> {
	vp.zle.as_deref().map(|z| &*z.comp)
}

/// [`comp`], mutably.
pub fn comp_mut(vp: &mut Vproc) -> Option<&mut Comp> {
	vp.zle.as_deref_mut().map(|z| &mut *z.comp)
}

/// zsh `incompfunc` of `vp`'s editor (0 outside completion).
pub fn incompfunc(vp: &Vproc) -> u8 {
	comp(vp).map_or(0, |c| c.incompfunc)
}

/// zsh `compqstack` (the `QT_*` bytes, innermost first; empty outside
/// completion).
pub fn compqstack(vp: &Vproc) -> &[u8] {
	comp(vp)
		.and_then(|c| c.complete.compqstack.as_deref())
		.map_or(&[][..], |s| s.as_slice())
}

/// zsh `quotestring(s, instring)` for a `QT_*` kind (`qt::NONE` and
/// `qt::BACKTICK` return `s` unchanged, as zsh does).
pub fn quotestring(s: &[u8], qt: u8, o: crate::bash::vm::zsh::text::QuoteOpts) -> Vec<u8> {
	use crate::bash::vm::zsh::text::{Qt, quotestring as q};
	let how = match qt {
		qt::BACKSLASH => Qt::Backslash,
		qt::SINGLE => Qt::Single,
		qt::DOUBLE => Qt::Double,
		qt::DOLLARS => Qt::Dollars,
		qt::SINGLE_OPTIONAL => Qt::SingleOptional,
		qt::BACKSLASH_PATTERN => Qt::BackslashPattern,
		qt::BACKSLASH_SHOWNULL => Qt::BackslashShownull,
		_ => return s.to_vec(),
	};
	q(s, how, o)
}

// ---- display
// -------------------------------------------------------------------

/// zsh `listmatches()` as `zrefresh` calls it when a list is to be shown
/// (the `list_matches` hook of zsh/complete): may wait for a key (the
/// "do you wish to see all" question, `LISTPROMPT` scrolling), in which
/// case the display runs it as a task.
pub fn listmatches(zw: &mut Zw<'_, '_>) -> WResult {
	// zsh `list_matches`: the `comp_list_matches` hook with the matches
	// listed now, zsh/complist's when it is loaded.
	if complist::active(zw) {
		let c = &zw.zle.comp;
		let dat = types::Chdata {
			matches: c.core.amatches,
			num:     c.core.nmatches,
			nmesg:   c.core.nmessages,
			cur:     None,
		};
		complist::complistmatches(zw, dat, Box::new(|_, r| WResult::Done(r)))
	} else {
		compresult::ilistmatches(zw)
	}
}

// ---- shell access
// -------------------------------------------------------------

/// Run `f` with the shell (options, parameters: an [`Expander`] over the
/// editing vproc) and the completion state, from a native widget. Inside
/// `f`, `ex.vp.zle` is not the editor: reach completion state only
/// through `c`.
pub fn with_ex<T>(zw: &mut Zw<'_, '_>, f: impl FnOnce(&mut Expander<'_, '_>, &mut Comp) -> T) -> T {
	let mut log = Vec::new();
	let mut ex = Expander::new(zw.k, zw.cx, zw.vp, &mut log, false, 0);
	f(&mut ex, &mut zw.zle.comp)
}

/// Run `f` with the completion state taken out of `ex.vp`'s editor (a
/// builtin or special parameter running while a completion function
/// runs): the same shape as [`with_ex`]. Without an editor `f` gets a
/// fresh state that is dropped.
pub fn with_taken<T>(
	ex: &mut Expander<'_, '_>,
	f: impl FnOnce(&mut Expander<'_, '_>, &mut Comp) -> T,
) -> T {
	let mut c = ex
		.vp
		.zle
		.as_deref_mut()
		.map_or_default(|z| std::mem::take(&mut z.comp));
	let r = f(ex, &mut c);
	if let Some(z) = ex.vp.zle.as_deref_mut() {
		z.comp = c;
	}
	r
}

/// zsh `isset(opt)` for completion code holding an [`Expander`] (`false`
/// when the store fails).
pub fn isset(ex: &mut Expander<'_, '_>, opt: ZshOpt) -> bool {
	state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, opt).unwrap_or(false)
}

/// zsh `zterm_columns` / `zterm_lines` (`$COLUMNS`, `$LINES`; 80×24 when
/// unset or not positive).
pub fn zterm_size(ex: &mut Expander<'_, '_>) -> (i32, i32) {
	let get = |ex: &mut Expander<'_, '_>, name: &[u8], dflt: i32| {
		crate::bash::vm::zsh::params::getsparam(ex, name)
			.ok()
			.flatten()
			.map(|s| crate::bash::vm::zsh::params::parse_int(&s))
			.filter(|&n| n > 0)
			.map_or(dflt, |n| i32::try_from(n).unwrap_or(i32::MAX))
	};
	(get(ex, b"COLUMNS", 80), get(ex, b"LINES", 24))
}

// ---- the metafied line ------------------------------------------------------

/// zsh `zlemetaline` with `zlemetacs` and the mark, while completion code
/// edits the line (`zlemetall` is `s.len()`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MetaLine {
	/// The line, metafied; `None` when the line is not metafied (zsh
	/// `zlemetaline == NULL`).
	pub s:    Option<Vec<u8>>,
	/// zsh `zlemetacs`.
	pub cs:   usize,
	/// zsh `mark` in metafied offsets.
	pub mark: usize,
	/// The user's region highlights' `start_meta`/`end_meta` (-1 unset)
	/// and the `$PREDISPLAY` offset they count (zsh's `sub`), index by
	/// index with [`Editor::region_highlights`].
	pub rh:   Vec<(i64, i64, i64)>,
}

/// Metafied byte length of `line[..n]`.
fn meta_len(line: &[char], n: usize) -> usize {
	tok::metafy(&from_line(&line[..n.min(line.len())])).len()
}

/// Character count of the metafied prefix `s[..n]`.
fn char_len(s: &[u8], n: usize) -> usize {
	to_line(&tok::unmetafy(&s[..n.min(s.len())])).len()
}

impl MetaLine {
	/// zsh `zlemetall`.
	pub fn ll(&self) -> usize {
		self.s.as_ref().map_or(0, Vec::len)
	}

	/// The line bytes (empty when not metafied).
	pub fn bytes(&self) -> &[u8] {
		self.s.as_deref().unwrap_or_default()
	}

	/// zsh `metafy_line()`: the editor's line, cursor and mark as
	/// metafied bytes; region highlights move to metafied offsets.
	pub fn metafy(&mut self, ed: &Editor) {
		self.cs = meta_len(&ed.line, ed.cs);
		self.mark = meta_len(&ed.line, ed.mark);
		let pre = i64::try_from(ed.predisplay.len()).unwrap_or(0);
		self.rh = ed
			.region_highlights
			.iter()
			.map(|rh| {
				let sub = if rh.flags & super::refresh::ZRH_PREDISPLAY != 0 {
					pre
				} else {
					0
				};
				let conv = |x: i32| {
					let at = i64::from(x) - sub;
					if x < 0 || at < 0 {
						i64::from(x)
					} else {
						i64::try_from(meta_len(&ed.line, at as usize)).unwrap_or(i64::MAX) + sub
					}
				};
				(conv(rh.start), conv(rh.end), sub)
			})
			.collect();
		self.s = Some(tok::metafy(&from_line(&ed.line)));
	}

	/// zsh `unmetafy_line()`: the metafied line back into the editor.
	pub fn unmetafy(&mut self, ed: &mut Editor) {
		let Some(s) = self.s.take() else {
			return;
		};
		ed.cs = char_len(&s, self.cs);
		ed.mark = char_len(&s, self.mark);
		let rhs = std::mem::take(&mut self.rh);
		for (rh, &(start, end, sub)) in ed.region_highlights.iter_mut().zip(&rhs) {
			let conv = |x: i64| {
				let at = x - sub;
				if x < 0 || at < 0 {
					x
				} else {
					i64::try_from(char_len(&s, at as usize)).unwrap_or(i64::MAX) + sub
				}
			};
			rh.start = i32::try_from(conv(start)).unwrap_or(i32::MAX);
			rh.end = i32::try_from(conv(end)).unwrap_or(i32::MAX);
		}
		ed.line = to_line(&tok::unmetafy(&s));
		ed.cs = ed.cs.min(ed.line.len());
		ed.mark = ed.mark.min(ed.line.len());
	}

	/// zsh `spaceinline(ct)` (metafied): `ct` blank bytes at the cursor.
	/// The caller clears `region_active` (zsh does it here).
	pub fn spaceinline(&mut self, ct: usize) {
		let cs = self.cs;
		let s = self.s.get_or_insert_with(Vec::new);
		s.splice(cs..cs, std::iter::repeat_n(b' ', ct));
		if self.mark > cs {
			self.mark += ct;
		}
		let (cs, ct) = (cs as i64, ct as i64);
		for (start, end, sub) in &mut self.rh {
			if *start - *sub >= cs {
				*start += ct;
			}
			if *end - *sub >= cs {
				*end += ct;
			}
		}
	}

	/// zsh `shiftchars(to, cnt)` (metafied): cut `cnt` bytes at `to`.
	pub fn shiftchars(&mut self, to: usize, cnt: usize) {
		if self.mark >= to + cnt {
			self.mark -= cnt;
		} else if self.mark > to {
			self.mark = to;
		}
		let (t, c) = (to as i64, cnt as i64);
		for (start, end, sub) in &mut self.rh {
			for x in [start, end] {
				if *x - *sub > t {
					*x = if *x - *sub > t + c { *x - c } else { t };
				}
			}
		}
		let s = self.s.get_or_insert_with(Vec::new);
		let end = (to + cnt).min(s.len());
		s.drain(to.min(end)..end);
	}

	/// zsh `foredel(ct, CUT_RAW)` (metafied).
	pub fn foredel(&mut self, ct: usize) {
		self.shiftchars(self.cs, ct);
	}

	/// zsh `backdel(ct, CUT_RAW)` (metafied).
	pub fn backdel(&mut self, ct: usize) {
		self.cs = self.cs.saturating_sub(ct);
		self.shiftchars(self.cs, ct);
	}

	/// zsh `inststrlen(str, move, len)` (metafied): insert `s` at the
	/// cursor, moving past it with `mv`; the length inserted.
	pub fn inststrlen(&mut self, s: &[u8], mv: bool) -> usize {
		if s.is_empty() {
			return 0;
		}
		let cs = self.cs;
		self.spaceinline(s.len());
		if let Some(line) = self.s.as_mut() {
			line[cs..cs + s.len()].copy_from_slice(s);
		}
		if mv {
			self.cs += s.len();
		}
		s.len()
	}
}
