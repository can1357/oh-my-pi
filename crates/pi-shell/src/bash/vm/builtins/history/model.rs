//! zsh's history list (`hist.c`, `hashtable.c` `histtab`), held in the
//! state store.
//!
//! zsh keeps its events in a ring (`hist_ring`, newest at the top) and a
//! hash of their texts (`histtab`) that marks duplicates. Here the ring is
//! [`Hist::entries`], oldest first, and [`Hist::tab`] indexes normalized
//! texts while appending (read-only operations can scan). While a line is being
//! read (`histactive`), zsh links the line being edited (`curline`) at the
//! top of the ring: [`Hist::curline`] holds its text and it counts as the
//! newest event, numbered `curhist`.
//!
//! The store holds the events (`MiscKey::ZshHistory`, postcard) and the
//! rest of the state (`MiscKey::ZshHistoryState`). The root cache mirrors
//! the saved events, lending readers shared access and giving editing
//! operations exclusive ownership. Unchanged events are not serialized
//! again. Pending operations replay from the store, not a shared copy of
//! the full event list; snapshots and forked vprocs' images still read the
//! authoritative saved records.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::{borrow::Cow, collections::HashMap, sync::Arc};

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::bang::LineState;
use crate::bash::{
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{
		proc::Vproc,
		state::{self, Root},
	},
};

/// Kill this new entry if not unique.
pub const HIST_MAKEUNIQUE: u32 = 0x1;
/// Already written to the history file.
pub const HIST_OLD: u32 = 0x2;
/// Read back from the history file.
pub const HIST_READ: u32 = 0x4;
/// Duplicates a later entry.
pub const HIST_DUP: u32 = 0x8;
/// Came from another shell (`sharehistory`).
pub const HIST_FOREIGN: u32 = 0x10;
/// Dropped when the next line is entered.
pub const HIST_TMPSTORE: u32 = 0x20;
/// Kept in the list, never written.
pub const HIST_NOWRITE: u32 = 0x40;
/// The word bounds are not stored: the words are the blank-separated runs
/// (`histsplitwords` without lexing), computed when asked for.
pub const HIST_BLANKWORDS: u32 = 0x100;

/// `histactive`: the history mechanism is active.
pub const HA_ACTIVE: u8 = 1;
/// `histactive`: the line is not stored, `curhist` not incremented.
pub const HA_NOINC: u8 = 2;

/// zsh's `DEFAULT_HISTSIZE`.
pub const DEFAULT_HISTSIZE: i64 = 30;

/// One history event.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
	/// The text (raw bytes; newlines between the lines of a multi-line
	/// event).
	pub text:  BString,
	/// Event number.
	pub num:   i64,
	/// Start time (seconds since the epoch).
	pub stim:  i64,
	/// Finish time (`0`: not known yet).
	pub ftim:  i64,
	/// `HIST_*` flags.
	pub flags: u32,
	/// Word bounds: start and end offset of each word, in pairs (empty with
	/// [`HIST_BLANKWORDS`]).
	pub words: Vec<u32>,
}

impl Entry {
	/// The word bounds, in pairs.
	pub fn words(&self) -> Cow<'_, [u32]> {
		if self.flags & HIST_BLANKWORDS != 0 {
			Cow::Owned(super::words::blank_words(&self.text))
		} else {
			Cow::Borrowed(&self.words)
		}
	}
}

/// zsh's `lasthist`: where the history file stood when last read or
/// written (`sharehistory`, `incappendhistory`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastHist {
	/// Text of the last line read or written.
	pub text:          Option<BString>,
	/// Its start time.
	pub stim:          i64,
	/// The file's modification time (seconds).
	pub mtim:          i64,
	/// Offset of the last line read or written.
	pub fpos:          u64,
	/// The file's size.
	pub fsiz:          u64,
	/// A read was interrupted.
	pub interrupted:   bool,
	/// First event not yet written by an incremental save.
	pub next_write_ev: i64,
}

/// The rest of zsh's history state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZState {
	/// `curhist`.
	pub curhist:         i64,
	/// `curline.histnum`: the number of the line being run (`fc`).
	pub curline_num:     i64,
	/// `histactive` bits.
	pub histactive:      u8,
	/// The line being read is linked at the top of the ring (zsh
	/// `linkcurline`), numbered `curhist`.
	pub linked:          bool,
	/// The word the last `!?str?` matched in (`marg`, `-1`: none).
	pub marg:            i64,
	/// The event the last `!?str?` found (`mev`).
	pub mev:             i64,
	/// `histsiz` (`HISTSIZE`, at least 1).
	pub histsiz:         i64,
	/// `savehistsiz` (`SAVEHIST`, at least 0).
	pub savehistsiz:     i64,
	/// `HISTSIZE` was unset.
	pub histsiz_unset:   bool,
	/// `SAVEHIST` was unset.
	pub savehist_unset:  bool,
	/// `hist_ignore_all_dups`: the option's setting as last applied.
	pub ignore_all_dups: bool,
	/// `bangchar`, `hatchar`, `hashchar` (`histchars`); 0 is none.
	pub chars:           [u8; 3],
	/// `hsubl`/`hsubr`: the last `:s/l/r/`.
	pub hsubl:           Option<BString>,
	/// See [`ZState::hsubl`].
	pub hsubr:           Option<BString>,
	/// `lasthist`.
	pub last:            LastHist,
	/// `histfile_linect`.
	pub linect:          i64,
	/// The state was initialised (`HISTSIZE`/`SAVEHIST` imported).
	pub init:            bool,
	/// The interactive shell read its history file at startup.
	pub started:         bool,
	/// Bumped each time the events are written: [`EventsCache`] holds the
	/// events of one version.
	pub version:         u64,
}

impl Default for ZState {
	fn default() -> Self {
		Self {
			curhist:         0,
			curline_num:     0,
			histactive:      0,
			linked:          false,
			marg:            -1,
			mev:             -1,
			histsiz:         DEFAULT_HISTSIZE,
			savehistsiz:     0,
			histsiz_unset:   false,
			savehist_unset:  false,
			ignore_all_dups: false,
			chars:           *b"!^#",
			hsubl:           None,
			hsubr:           None,
			last:            LastHist::default(),
			linect:          0,
			init:            false,
			started:         false,
			version:         0,
		}
	}
}

/// zsh's history: the events, the line being read and the state.
#[derive(Clone, Debug, Default)]
pub struct Hist {
	/// Events, oldest first.
	pub entries: Arc<Vec<Entry>>,
	/// Whether the events still equal the authoritative record read.
	saved:       bool,
	/// The event being read (`chline` and its state, from `hbegin` to
	/// `hend`); linked at the top of the ring while [`ZState::linked`].
	pub curline: Option<LineState>,
	/// The rest.
	pub st:      ZState,
	/// `histtab` for appends: normalized text → event number of the
	/// entry it names (built by [`Hist::build_tab`]).
	pub tab:     Option<HashMap<BString, i64>>,
}

/// zsh `inblank`: space, tab, newline.
pub const fn inblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n')
}

/// `histtab`'s key as `histstrcmp` compares: the text with leading blanks
/// dropped and every other blank run as one space (trailing ones too).
pub fn normalize(s: &[u8]) -> BString {
	BString::from(normalized(s).collect::<Vec<u8>>())
}

/// The bytes of `normalize(s)`, without allocating.
fn normalized(s: &[u8]) -> impl Iterator<Item = u8> + '_ {
	let s = &s[s.iter().take_while(|&&c| inblank(c)).count()..];
	let mut i = 0;
	std::iter::from_fn(move || {
		let c = *s.get(i)?;
		if inblank(c) {
			while s.get(i).is_some_and(|&c| inblank(c)) {
				i += 1;
			}
			return Some(b' ');
		}
		i += 1;
		Some(c)
	})
}

/// zsh `histstrcmp(a, b) == 0`.
pub fn same_text(a: &[u8], b: &[u8]) -> bool {
	normalized(a).eq(normalized(b))
}

/// The events of the root shell's history as last written (decoding them
/// from the store on every command costs more than the command): held by
/// [`Root`], dropped with its other derived state when another writer
/// changes the store ([`Root::invalidate`]).
#[derive(Debug, Default)]
pub struct EventsCache(Option<CachedEvents>);

#[derive(Debug)]
struct CachedEvents {
	version: u64,
	entries: Arc<Vec<Entry>>,
	tab:     Option<HashMap<BString, i64>>,
}

impl EventsCache {
	/// Forget the cached events.
	pub fn clear(&mut self) {
		self.0 = None;
	}
}

/// Whether `vp` reads and writes the history records in the root store
/// (the root vproc; a forked one has its own), so [`EventsCache`] speaks
/// for it.
const fn uses_root_history(vp: &Vproc) -> bool {
	vp.image.is_none()
}

impl Hist {
	/// The events, to change (copied first when the cache shares them).
	pub fn events_mut(&mut self) -> &mut Vec<Entry> {
		self.saved = false;
		Arc::make_mut(&mut self.entries)
	}

	/// Replace the event list, discarding its derived duplicate index.
	pub fn replace_events(&mut self, entries: Vec<Entry>) {
		self.entries = Arc::new(entries);
		self.tab = None;
		self.saved = false;
	}

	/// Read the history from the store.
	///
	/// # Errors
	/// [`StoreError`] when a record cannot be read.
	pub fn load(root: &Root, store: &mut dyn StateStore, vp: &Vproc) -> Result<Self, StoreError> {
		Self::load_events(root, store, vp, false)
	}

	/// Read history for an operation that may edit its events, taking the
	/// root cache so the writer need not copy the list. Until saved, the
	/// store remains authoritative, including when the operation is retried.
	///
	/// # Errors
	/// [`StoreError`] when a record cannot be read.
	pub fn take(root: &Root, store: &mut dyn StateStore, vp: &Vproc) -> Result<Self, StoreError> {
		Self::load_events(root, store, vp, vp.image.is_none())
	}

	fn load_events(
		root: &Root,
		store: &mut dyn StateStore,
		vp: &Vproc,
		take: bool,
	) -> Result<Self, StoreError> {
		let st: ZState = match state::record(store, vp, Key::Misc(MiscKey::ZshHistoryState))? {
			Some(Record::Misc(b)) => postcard::from_bytes(b).unwrap_or_default(),
			_ => ZState::default(),
		};
		let cached = if uses_root_history(vp) {
			let mut cache = root.hist_events.lock();
			if cache
				.0
				.as_ref()
				.is_some_and(|cached| cached.version == st.version)
			{
				if take {
					cache.0.take().map(|cached| (cached.entries, cached.tab))
				} else {
					cache
						.0
						.as_ref()
						.map(|cached| (Arc::clone(&cached.entries), None))
				}
			} else {
				None
			}
		} else {
			None
		};
		let (entries, tab) = match cached {
			Some(cached) => cached,
			None => (
				Arc::new(match state::record(store, vp, Key::Misc(MiscKey::ZshHistory))? {
					Some(Record::Misc(b)) => postcard::from_bytes(b).unwrap_or_default(),
					_ => Vec::new(),
				}),
				None,
			),
		};
		let curline = match state::record(store, vp, Key::Misc(MiscKey::ZshHistoryLine))? {
			Some(Record::Misc(b)) => postcard::from_bytes(b).ok(),
			_ => None,
		};
		Ok(Self { entries, saved: true, curline, st, tab })
	}

	/// The state record only (cheap: no events).
	///
	/// # Errors
	/// [`StoreError`] when the record cannot be read.
	pub fn load_state(store: &mut dyn StateStore, vp: &Vproc) -> Result<ZState, StoreError> {
		Ok(match state::record(store, vp, Key::Misc(MiscKey::ZshHistoryState))? {
			Some(Record::Misc(b)) => postcard::from_bytes(b).unwrap_or_default(),
			_ => ZState::default(),
		})
	}

	/// The event being read, if any (cheap: no events).
	///
	/// # Errors
	/// [`StoreError`] when the record cannot be read.
	pub fn load_line(
		store: &mut dyn StateStore,
		vp: &Vproc,
	) -> Result<Option<LineState>, StoreError> {
		Ok(match state::record(store, vp, Key::Misc(MiscKey::ZshHistoryLine))? {
			Some(Record::Misc(b)) => postcard::from_bytes(b).ok(),
			_ => None,
		})
	}

	/// Write the state record only.
	pub fn save_state(st: &ZState, root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
		let bytes = postcard::to_allocvec(st).unwrap_or_default();
		state::store_record(
			root,
			store,
			vp,
			KeyBuf::Misc(MiscKey::ZshHistoryState),
			Some(Record::Misc(BString::from(bytes))),
		);
	}

	/// Write the history back. Events unchanged since loading are not
	/// written again, including after taking exclusive cache ownership.
	pub fn save(mut self, root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
		let cacheable = vp.image.is_none();
		if !self.saved {
			self.st.version = self.st.version.wrapping_add(1);
			let events = (!self.entries.is_empty()).then(|| {
				Record::Misc(BString::from(postcard::to_allocvec(&*self.entries).unwrap_or_default()))
			});
			state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::ZshHistory), events);
		}
		if cacheable {
			let mut cache = root.hist_events.lock();
			// A read-only load need not clone the index, nor discard it on save.
			if self.saved
				&& self.tab.is_none()
				&& let Some(cached) = &mut cache.0
				&& cached.version == self.st.version
				&& Arc::ptr_eq(&cached.entries, &self.entries)
			{
				self.tab = cached.tab.take();
			}
			cache.0 = Some(CachedEvents {
				version: self.st.version,
				entries: self.entries,
				tab:     self.tab,
			});
		}
		Self::save_state(&self.st, root, store, vp);
		let line = self
			.curline
			.map(|ls| Record::Misc(BString::from(postcard::to_allocvec(&ls).unwrap_or_default())));
		state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::ZshHistoryLine), line);
	}

	/// Whether the line being read is linked at the top of the ring.
	pub const fn curline_linked(&self) -> bool {
		self.st.linked
	}

	/// The number of positions in the ring: the events, and the line being
	/// read when linked.
	pub fn ring_len(&self) -> usize {
		self.entries.len() + usize::from(self.curline_linked())
	}

	/// The event number at ring position `i`.
	pub fn num_at(&self, i: usize) -> i64 {
		self.entries.get(i).map_or(self.st.curhist, |e| e.num)
	}

	/// The flags at ring position `i` (the line being read has none).
	pub fn flags_at(&self, i: usize) -> u32 {
		self.entries.get(i).map_or(0, |e| e.flags)
	}

	/// The text at ring position `i` (the line being read: its history
	/// text so far, without the newline ending it).
	pub fn text_at(&self, i: usize) -> &[u8] {
		match self.entries.get(i) {
			Some(e) => &e.text,
			None => self
				.curline
				.as_ref()
				.map_or(&b""[..], |c| c.chline.strip_suffix(b"\n").unwrap_or(&c.chline)),
		}
	}

	/// The word bounds at ring position `i`.
	pub fn words_at(&self, i: usize) -> Cow<'_, [u32]> {
		match self.entries.get(i) {
			Some(e) => e.words(),
			None => Cow::Owned(
				self
					.curline
					.as_ref()
					.map_or_else(Vec::new, LineState::words),
			),
		}
	}

	/// `firsthist()`.
	pub fn firsthist(&self) -> i64 {
		if self.ring_len() == 0 {
			self.st.curhist
		} else {
			self.num_at(0)
		}
	}

	/// The index of the event numbered `num`, if any.
	pub fn index_of(&self, num: i64) -> Option<usize> {
		let n = self.ring_len();
		let i = self.lower_bound(num);
		(i < n && self.num_at(i) == num).then_some(i)
	}

	/// The first ring position whose number is not below `num`.
	fn lower_bound(&self, num: i64) -> usize {
		let (mut lo, mut hi) = (0, self.ring_len());
		while lo < hi {
			let mid = usize::midpoint(lo, hi);
			if self.num_at(mid) < num {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		lo
	}

	/// zsh `gethistent`: the position of event `ev`; when there is none,
	/// with `near` < 0 the next older one, with `near` > 0 the next newer
	/// one.
	pub fn gethistent(&self, ev: i64, near: i32) -> Option<usize> {
		let n = self.ring_len();
		if n == 0 {
			return None;
		}
		let i = self.lower_bound(ev);
		if i < n && self.num_at(i) == ev {
			return Some(i);
		}
		match near.cmp(&0) {
			std::cmp::Ordering::Equal => None,
			std::cmp::Ordering::Less => i.checked_sub(1),
			std::cmp::Ordering::Greater => (i < n).then_some(i),
		}
	}

	/// zsh `movehistent`: `n` positions away from `i`, skipping those
	/// whose flags meet `xflags`.
	pub fn movehistent(&self, mut i: usize, mut n: i64, xflags: u32) -> Option<usize> {
		while n < 0 {
			i = i.checked_sub(1)?;
			if self.flags_at(i) & xflags == 0 {
				n += 1;
			}
		}
		while n > 0 {
			i += 1;
			if i >= self.ring_len() {
				return None;
			}
			if self.flags_at(i) & xflags == 0 {
				n -= 1;
			}
		}
		Some(i)
	}

	/// zsh `addhistnum`: the event `n` events from `hl`.
	pub fn addhistnum(&self, hl: i64, n: i64, xflags: u32) -> i64 {
		let dir = n.signum();
		let Some(i) = self.gethistent(hl, i32::try_from(dir).unwrap_or(0)) else {
			return 0;
		};
		let mut n = n;
		if self.num_at(i) != hl {
			n -= dir;
		}
		let moved = if n == 0 {
			Some(i)
		} else {
			self.movehistent(i, n, xflags)
		};
		match moved {
			Some(j) => self.num_at(j),
			None if dir < 0 => self.firsthist() - 1,
			None => self.st.curhist + 1,
		}
	}

	/// zsh `hconsearch`/`hcomsearch` helper: the newest event older than
	/// the top of the ring, not from another shell, matching `test`.
	pub fn search_up(&self, test: impl Fn(&[u8]) -> bool) -> Option<usize> {
		let n = self.ring_len();
		(0..n.saturating_sub(1))
			.rev()
			.find(|&i| self.flags_at(i) & HIST_FOREIGN == 0 && test(self.text_at(i)))
	}

	/// The index of the `histtab` entry for `text` other than `except`: the
	/// one event with that normalized text that is neither a duplicate nor
	/// temporary.
	fn tab_lookup(&self, key: &BString, except: usize) -> Option<usize> {
		if let Some(tab) = &self.tab {
			return tab
				.get(key)
				.and_then(|&n| self.entries.binary_search_by_key(&n, |e| e.num).ok())
				.filter(|&o| o != except);
		}
		self.entries.iter().enumerate().rev().find_map(|(o, e)| {
			(o != except
				&& e.flags & (HIST_DUP | HIST_TMPSTORE) == 0
				&& normalized(&e.text).eq(key.iter().copied()))
			.then_some(o)
		})
	}

	/// Build [`Hist::tab`] for appends or a bulk update.
	pub fn build_tab(&mut self) {
		let mut tab = HashMap::with_capacity(self.entries.len());
		for e in self.entries.iter() {
			if e.flags & (HIST_DUP | HIST_TMPSTORE) == 0 {
				tab.insert(normalize(&e.text), e.num);
			}
		}
		self.tab = Some(tab);
	}

	/// Remove the entry at `i` (`freehistnode`).
	pub fn remove(&mut self, i: usize) -> Entry {
		let e = self.events_mut().remove(i);
		if e.flags & (HIST_DUP | HIST_TMPSTORE) == 0
			&& let Some(tab) = &mut self.tab
		{
			let key = normalize(&e.text);
			if tab.get(&key) == Some(&e.num) {
				tab.remove(&key);
			}
		}
		e
	}

	/// zsh `addhistnode` for the entry at `i` (just added): marks the
	/// duplicate. With `hist_ignore_all_dups` the older copy goes. Returns
	/// the index of the entry afterwards (it moves down when an older copy
	/// is removed).
	pub fn addhistnode(&mut self, i: usize) -> usize {
		let key = normalize(&self.entries[i].text);
		let old = self.tab_lookup(&key, i);
		let mut i = i;
		if let Some(o) = old {
			let he = &self.entries[i];
			let foreign_adjacent = he.flags & HIST_FOREIGN != 0 && o + 1 == i;
			if he.flags & HIST_MAKEUNIQUE != 0 || foreign_adjacent {
				let he = &mut self.events_mut()[i];
				he.flags |= HIST_DUP;
				he.flags &= !HIST_MAKEUNIQUE;
			} else {
				self.events_mut()[o].flags |= HIST_DUP;
				if let Some(tab) = &mut self.tab {
					tab.insert(key, self.entries[i].num);
				}
				if self.st.ignore_all_dups {
					self.events_mut().remove(o);
					if o < i {
						i -= 1;
					}
				}
			}
		} else {
			self.events_mut()[i].flags &= !HIST_MAKEUNIQUE;
			if let Some(tab) = &mut self.tab {
				tab.insert(key, self.entries[i].num);
			}
		}
		i
	}

	/// zsh `histremovedups`: drop every duplicate.
	pub fn remove_dups(&mut self) {
		self.events_mut().retain(|e| e.flags & HIST_DUP == 0);
	}

	/// zsh `putoldhistentryontop` + `freehistnode`: drop the entry the
	/// list expires next (the oldest; with `histexpiredupsfirst` the oldest
	/// duplicate within the next `SAVEHIST` events). `cursor` carries
	/// zsh's static `next`/`max_unique_ct` through a run of calls.
	fn expire_one(&mut self, cursor: &mut Expire, dups_first: bool) {
		let n = self.entries.len();
		if n == 0 {
			return;
		}
		let start = if cursor.going { cursor.next } else { Some(0) };
		let Some(mut he) = start.filter(|&h| h < n) else {
			return;
		};
		// zsh's ring: below the newest comes the oldest again.
		let down = |h: usize| if h + 1 < n { h + 1 } else { 0 };
		cursor.next = Some(down(he));
		if dups_first && self.entries[he].flags & HIST_DUP == 0 {
			if !cursor.going {
				cursor.max_unique = self.st.savehistsiz;
			}
			loop {
				let at_top = he == n - 1;
				cursor.max_unique -= 1;
				if cursor.max_unique < 0 || at_top {
					cursor.max_unique = 0;
					he = 0;
					cursor.next = Some(n - 1);
					break;
				}
				he = cursor.next.unwrap_or(0);
				cursor.next = Some(down(he));
				if self.entries[he].flags & HIST_DUP != 0 {
					break;
				}
			}
		}
		cursor.going = true;
		self.remove(he);
		if let Some(next) = &mut cursor.next
			&& *next > he
		{
			*next -= 1;
		}
	}

	/// zsh `resizehistents`: drop entries past `histsiz`.
	pub fn resize(&mut self, dups_first: bool) {
		let max = usize::try_from(self.st.histsiz.max(1)).unwrap_or(usize::MAX);
		let mut cursor = Expire::default();
		while self.entries.len() > max {
			let before = self.entries.len();
			self.expire_one(&mut cursor, dups_first);
			if self.entries.len() == before {
				break;
			}
		}
	}

	/// zsh `prepnexthistent`: make room for a new event and push it,
	/// numbered `++curhist`; its index.
	pub fn prepnext(&mut self, dups_first: bool) -> usize {
		if self.tab.is_none() {
			self.build_tab();
		}
		// The line being read moves up above the new event.
		let linked = self.st.linked;
		if linked {
			self.st.curhist -= 1;
		}
		if self
			.entries
			.last()
			.is_some_and(|e| e.flags & HIST_TMPSTORE != 0)
		{
			// The line being read keeps its number one above the top.
			self.st.curhist -= 1;
			let last = self.entries.len() - 1;
			self.remove(last);
		}
		let max = usize::try_from(self.st.histsiz.max(1)).unwrap_or(usize::MAX);
		if self.entries.len() >= max && !self.entries.is_empty() {
			let mut cursor = Expire::default();
			self.expire_one(&mut cursor, dups_first);
		}
		self.st.curhist += 1;
		let num = self.st.curhist;
		self.events_mut().push(Entry { num, ..Entry::default() });
		if linked {
			self.st.curhist += 1;
		}
		self.entries.len() - 1
	}
}

/// zsh's statics of `putoldhistentryontop`.
#[derive(Default)]
struct Expire {
	going:      bool,
	next:       Option<usize>,
	max_unique: i64,
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::{MemStore, StateStore, fd::FdTable, ids::Vpid};

	fn shell() -> (MemStore, Root, Vproc) {
		let mut store = MemStore::new();
		let root = Root::load(&mut store).unwrap();
		let vp = Vproc::new(Vpid(1), None, FdTable::default(), BString::from("/"), None, false);
		(store, root, vp)
	}

	#[test]
	fn history_pending_edits_do_not_change_store_or_snapshots() {
		let (mut store, mut root, mut vp) = shell();
		hist(&["first"]).save(&mut root, &mut store, &mut vp);
		{
			let mut pending = Hist::take(&root, &mut store, &vp).unwrap();
			pending.events_mut()[0].text = "abandoned".into();
			let saved = Hist::load(&root, &mut store, &vp).unwrap();
			assert_eq!(saved.entries[0].text, "first");
		}
		let mut h = Hist::take(&root, &mut store, &vp).unwrap();
		assert_eq!(h.entries[0].text, "first");
		let i = h.prepnext(false);
		h.events_mut()[i].text = "second".into();
		h.save(&mut root, &mut store, &mut vp);
		let mut restored = MemStore::from_bytes(&store.to_bytes()).unwrap();
		let fresh = Root::load(&mut restored).unwrap();
		let h = Hist::load(&fresh, &mut restored, &vp).unwrap();
		assert_eq!(
			h.entries
				.iter()
				.map(|e| e.text.as_slice())
				.collect::<Vec<_>>(),
			[b"first".as_slice(), b"second"]
		);
	}

	#[test]
	fn subshell_history_edits_stay_out_of_root_cache() {
		let (mut store, mut root, mut vp) = shell();
		hist(&["parent"]).save(&mut root, &mut store, &mut vp);
		let mut sub = Vproc::new(
			Vpid(2),
			Some(vp.vpid),
			FdTable::default(),
			BString::from("/"),
			Some(store.snapshot().unwrap()),
			true,
		);
		// A state-only save writes the subshell's image without changing the
		// events.
		let h = Hist::load(&root, &mut store, &sub).unwrap();
		h.save(&mut root, &mut store, &mut sub);
		let mut h = Hist::take(&root, &mut store, &sub).unwrap();
		h.events_mut()[0].text = "child".into();
		h.save(&mut root, &mut store, &mut sub);
		assert_eq!(Hist::load(&root, &mut store, &sub).unwrap().entries[0].text, "child");
		assert_eq!(Hist::take(&root, &mut store, &vp).unwrap().entries[0].text, "parent");
	}

	fn hist(texts: &[&str]) -> Hist {
		let mut h = Hist::default();
		for t in texts {
			let i = h.prepnext(false);
			h.events_mut()[i].text = BString::from(*t);
			h.addhistnode(i);
		}
		h
	}

	#[test]
	fn history_duplicates_are_removed_after_readonly_save_and_stack_restore() {
		let (mut store, mut root, mut vp) = shell();
		hist(&["one", "two"]).save(&mut root, &mut store, &mut vp);
		Hist::load(&root, &mut store, &vp)
			.unwrap()
			.save(&mut root, &mut store, &mut vp);
		let mut h = Hist::take(&root, &mut store, &vp).unwrap();
		h.st.ignore_all_dups = true;
		let i = h.prepnext(false);
		h.events_mut()[i].text = " one".into();
		h.addhistnode(i);
		assert_eq!(
			h.entries
				.iter()
				.map(|e| e.text.as_slice())
				.collect::<Vec<_>>(),
			[b"two".as_slice(), b" one"]
		);
		let restored = hist(&["restored"]).entries;
		h.replace_events(Arc::unwrap_or_clone(restored));
		let i = h.prepnext(false);
		h.events_mut()[i].text = " restored".into();
		h.addhistnode(i);
		assert_eq!(h.entries.len(), 1);
		assert_eq!(h.entries[0].text, " restored");
	}

	#[test]
	fn numbering_and_navigation() {
		let h = hist(&["a", "b", "c"]);
		assert_eq!(h.st.curhist, 3);
		assert_eq!(h.gethistent(2, 0), Some(1));
		assert_eq!(h.gethistent(9, -1), Some(2));
		assert_eq!(h.gethistent(9, 1), None);
		assert_eq!(h.addhistnum(3, -1, 0), 2);
		assert_eq!(h.addhistnum(1, -5, 0), 0);
		assert_eq!(h.addhistnum(3, 5, 0), 4);
	}

	#[test]
	fn duplicates_are_marked_and_dropped_with_ignore_all_dups() {
		let mut h = hist(&["ls", "pwd", "  ls"]);
		assert_eq!(h.entries[0].flags & HIST_DUP, HIST_DUP);
		h.st.ignore_all_dups = true;
		let i = h.prepnext(false);
		h.events_mut()[i].text = BString::from("pwd");
		h.addhistnode(i);
		assert_eq!(
			h.entries
				.iter()
				.map(|e| e.text.to_string())
				.collect::<Vec<_>>(),
			["ls", "  ls", "pwd"]
		);
	}

	#[test]
	fn histsize_expires_the_oldest_or_dups_first() {
		let mut h = hist(&["a", "b", "a", "c"]);
		h.st.histsiz = 3;
		h.st.savehistsiz = 10;
		h.resize(true);
		assert_eq!(
			h.entries
				.iter()
				.map(|e| e.text.to_string())
				.collect::<Vec<_>>(),
			["b", "a", "c"]
		);
		h.st.histsiz = 2;
		h.resize(false);
		assert_eq!(h.entries.iter().map(|e| e.num).collect::<Vec<_>>(), [3, 4]);
	}
}
