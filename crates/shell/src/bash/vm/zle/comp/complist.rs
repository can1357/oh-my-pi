//! zsh 5.9 `Src/Zle/complist.c` (zsh/complist): coloured listings
//! (`ZLS_COLORS`), `LISTPROMPT` scrolling, and `menu-select`.
//!
//! The module's hooks are [`complistmatches`] (zsh's
//! `comp_list_matches` hook, run instead of compresult's
//! `ilistmatches` while the module is loaded: see [`active`]) and
//! [`domenuselect`] (the `menu_start` hook, and the `menu-select`
//! widget). Both may wait for keys, widgets and redisplays, so they
//! take the rest of their caller as a [`K`](super::K).
//!
//! complist.c's statics are the fields of [`State`] (`c.list`). Screen
//! output goes to the editor's terminal like zsh's `shout`.

mod colors;
mod menu;
mod print;

use std::sync::Arc;

use bstr::BString;

pub use self::{
	menu::{complistmatches, domenuselect, menuselect},
	print::Mt,
};
use super::types::GId;
use crate::bash::vm::{
	Cx, Kernel,
	builtins::zsh_module,
	proc::Vproc,
	zle::{
		exec::Zw,
		keymap::{Bind, Keymaps},
		thingy::{Kind, Widget},
		wflags,
	},
};

/// A `Cmgroup` slot of zsh's `mgtab`: the group shown at a screen
/// position, `mark` for zsh's `mgmark()` (an explanation line, or a
/// dummy match).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mg {
	/// The group (`NULL`: none).
	pub g:    Option<GId>,
	/// zsh `MMARK`.
	pub mark: bool,
}

/// zsh `struct menusearch`: one step of an incremental search in the
/// menu.
#[derive(Clone, Debug, Default)]
pub struct Menusearch {
	/// The search string then.
	pub str:   BString,
	/// `mline` then.
	pub line:  i32,
	/// `mcol` then.
	pub col:   i32,
	/// Searching backwards.
	pub back:  bool,
	/// `msearchstate` then.
	pub state: i32,
	/// The selected entry (an index into `mtab`).
	pub ptr:   Option<isize>,
}

/// complist.c's statics.
#[derive(Clone, Debug)]
pub struct State {
	/// zsh `noselect`: 1 when `complistmatches` said not to select, -1
	/// when interactive mode must reset the selection list.
	pub noselect:              i32,
	/// zsh `mselect`: the `gnum` of the selected match (-1: no menu
	/// selection).
	pub mselect:               i32,
	/// zsh `inselect`: selection is running.
	pub inselect:              i32,
	/// zsh `mcol`: column of the selected match.
	pub mcol:                  i32,
	/// zsh `mline`: line of the selected match in the whole list.
	pub mline:                 i32,
	/// zsh `mcols`: columns of `mtab`.
	pub mcols:                 i32,
	/// zsh `mlines`: lines of `mtab`.
	pub mlines:                i32,
	/// zsh `selected`.
	pub selected:              i32,
	/// zsh `mlbeg`: the first list line on screen (-1: redraw).
	pub mlbeg:                 i32,
	/// zsh `mlend`: the line after the last one on screen.
	pub mlend:                 i32,
	/// zsh `mscroll`: the `LISTPROMPT` scrolling prompt is in use.
	pub mscroll:               i32,
	/// zsh `mrestlines`: lines left before the next scrolling prompt.
	pub mrestlines:            i32,
	/// zsh `mnew`: a new selection list is shown.
	pub mnew:                  i32,
	/// zsh `mlastcols`.
	pub mlastcols:             i32,
	/// zsh `mlastlines`.
	pub mlastlines:            i32,
	/// zsh `mhasstat`: the `MENUPROMPT` status line is shown.
	pub mhasstat:              i32,
	/// zsh `mfirstl`: first list line shown (-1: not known).
	pub mfirstl:               i32,
	/// zsh `mlastm`: number of the last match printed.
	pub mlastm:                i32,
	/// zsh `mlprinted`: extra lines the last item took.
	pub mlprinted:             i32,
	/// zsh `molbeg`: `mlbeg` of the last display (-1 invalid, -42 very).
	pub molbeg:                i32,
	/// zsh `mocol`: `mcol` of the last display.
	pub mocol:                 i32,
	/// zsh `moline`: `mline` of the last display.
	pub moline:                i32,
	/// zsh `mstatprinted`: the status line is on screen.
	pub mstatprinted:          i32,
	/// zsh `mstatus`: the `MENUPROMPT` text (metafied).
	pub mstatus:               Option<BString>,
	/// zsh `mlistp`: the `LISTPROMPT` text (metafied).
	pub mlistp:                Option<BString>,
	/// zsh `mtab`: the match at each screen position of the whole list
	/// (`mcols` × `mlines`).
	pub mtab:                  Vec<Mt>,
	/// zsh `mmtabp`: the selected entry of `mtab`.
	pub mmtabp:                Option<usize>,
	/// zsh `mtab_been_reallocated`.
	pub mtab_been_reallocated: i32,
	/// zsh `mgtab`: the group at each position of `mtab`.
	pub mgtab:                 Vec<Mg>,
	/// zsh `mgtabp`.
	pub mgtabp:                Option<usize>,
	/// zsh `last_group`: the group `clprintm` printed last.
	pub last_group:            Option<GId>,
	/// `compprintlist`'s static `lasttype`: what was printed at the
	/// first line shown (1 explanation, 2 display line, 3 matches).
	pub lasttype:              i32,
	/// `compprintlist`'s static `lastbeg`.
	pub lastbeg:               i32,
	/// `compprintlist`'s static `lastml`.
	pub lastml:                i32,
	/// `compprintlist`'s static `lastinvcount`.
	pub lastinvcount:          i32,
	/// `compprintlist`'s static `lastn`.
	pub lastn:                 i32,
	/// `compprintlist`'s static `lastnl`.
	pub lastnl:                i32,
	/// `compprintlist`'s static `lastnlnct`.
	pub lastnlnct:             i32,
	/// `compprintlist`'s static `lastg`.
	pub lastg:                 Option<GId>,
	/// `compprintlist`'s static `lastp` (an index into `lastg`'s
	/// matches).
	pub lastp:                 usize,
	/// `compprintlist`'s static `lastexpl` (an index into `lastg`'s
	/// explanations).
	pub lastexpl:              usize,
	/// `complistmatches`' static `onlnct`.
	pub onlnct:                i32,
	/// `domenuselect`'s static `fdat`: selection is running (a nested
	/// `menu_start` hook returns at once).
	pub fdat:                  bool,
	/// `domenuselect`'s static `lastsearch`.
	pub lastsearch:            Option<BString>,
	/// zsh `msearchstack` (top last).
	pub msearchstack:          Vec<Menusearch>,
	/// zsh `msearchstr`.
	pub msearchstr:            BString,
	/// zsh `msearchstate` (`MS_*`).
	pub msearchstate:          i32,
}

impl Default for State {
	/// complist.c's initial values (after `boot_`).
	fn default() -> Self {
		Self {
			noselect:              0,
			mselect:               -1,
			inselect:              0,
			mcol:                  0,
			mline:                 0,
			mcols:                 0,
			mlines:                0,
			selected:              0,
			mlbeg:                 -1,
			mlend:                 9_999_999,
			mscroll:               0,
			mrestlines:            0,
			mnew:                  0,
			mlastcols:             0,
			mlastlines:            0,
			mhasstat:              0,
			mfirstl:               0,
			mlastm:                0,
			mlprinted:             0,
			molbeg:                -2,
			mocol:                 0,
			moline:                0,
			mstatprinted:          0,
			mstatus:               None,
			mlistp:                None,
			mtab:                  Vec::new(),
			mmtabp:                None,
			mtab_been_reallocated: 0,
			mgtab:                 Vec::new(),
			mgtabp:                None,
			last_group:            None,
			lasttype:              0,
			lastbeg:               0,
			lastml:                0,
			lastinvcount:          -1,
			lastn:                 0,
			lastnl:                0,
			lastnlnct:             -1,
			lastg:                 None,
			lastp:                 0,
			lastexpl:              0,
			onlnct:                -1,
			fdat:                  false,
			lastsearch:            None,
			msearchstack:          Vec::new(),
			msearchstr:            BString::default(),
			msearchstate:          0,
		}
	}
}

/// Whether zsh/complist is loaded: its hooks replace compresult's
/// listing and start menu selection.
pub fn active(zw: &mut Zw<'_, '_>) -> bool {
	zsh_module::loaded(zw.cx.store, zw.vp, b"zsh/complist").unwrap_or(false)
}

/// zsh `menuselect_bindings`: create the `menuselect` and `listscroll`
/// keymaps with their default bindings unless they exist.
pub fn menuselect_bindings(keymaps: &mut Arc<Keymaps>) {
	let w = |s: &str| Some(Bind::widget(s));
	if !keymaps.exists(b"menuselect") {
		let km = Arc::make_mut(keymaps);
		if let Ok(id) = km.create(b"menuselect", None, true) {
			for (seq, wid) in [
				(&b"\t"[..], "complete-word"),
				(b"\n", "accept-line"),
				(b"\r", "accept-line"),
				(b"\x1b[A", "up-line-or-history"),
				(b"\x1b[B", "down-line-or-history"),
				(b"\x1b[C", "forward-char"),
				(b"\x1b[D", "backward-char"),
				(b"\x1bOA", "up-line-or-history"),
				(b"\x1bOB", "down-line-or-history"),
				(b"\x1bOC", "forward-char"),
				(b"\x1bOD", "backward-char"),
			] {
				let _ = km.bind(id, seq, w(wid));
			}
		}
	}
	if !keymaps.exists(b"listscroll") {
		let km = Arc::make_mut(keymaps);
		if let Ok(id) = km.create(b"listscroll", None, true) {
			for (seq, wid) in [
				(&b"\t"[..], "complete-word"),
				(b" ", "complete-word"),
				(b"\n", "accept-line"),
				(b"\r", "accept-line"),
				(b"\x1b[B", "down-line-or-history"),
				(b"\x1bOB", "down-line-or-history"),
			] {
				let _ = km.bind(id, seq, w(wid));
			}
		}
	}
}

/// zsh/complist's `boot_`: the selection state reset, the `menu-select`
/// widget, the keymaps. zsh warns `name clash when adding ZLE function
/// 'menu-select'` when the name is taken by an immortal widget; the
/// registry never holds one under that name before the module adds it.
pub fn boot(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	let zle = crate::bash::vm::zle::zle_mut(k, cx, vp);
	zle.comp.list.mtab.clear();
	zle.comp.list.mgtab.clear();
	zle.comp.list.mselect = -1;
	zle.comp.list.inselect = 0;
	let widgets = Arc::make_mut(&mut zle.widgets);
	let w = Widget {
		flags: wflags::INT | wflags::MENUCMP | wflags::KEEPSUFFIX | wflags::ISCOMP,
		kind:  Kind::Native(menuselect),
	};
	widgets.add_internal(b"menu-select", w);
	menuselect_bindings(&mut zle.keymaps);
}

/// zsh/complist's `cleanup_`: the widget and the keymaps go.
pub fn cleanup(vp: &mut Vproc) {
	let Some(zle) = vp.zle.as_deref_mut() else {
		return;
	};
	zle.comp.list.mtab = Vec::new();
	zle.comp.list.mgtab = Vec::new();
	let widgets = Arc::make_mut(&mut zle.widgets);
	widgets.remove_internal(b"menu-select");
	widgets.remove_internal(b".menu-select");
	let km = Arc::make_mut(&mut zle.keymaps);
	let _ = km.unlink(b"menuselect", true);
	let _ = km.unlink(b"listscroll", true);
}
