//! zsh 5.9 `Src/Zle/zle_keymap.c`: keymaps and key bindings.
//!
//! There is a table of keymap names ([`Keymaps`], zsh `keymapnamtab`);
//! each name points to a keymap, and several names may point to the same
//! one (`bindkey -A`). A keymap ([`Keymap`]) is a table of bindings for
//! each first byte plus a table of multi-byte sequences. In the first-byte
//! table each byte is bound to a widget, unbound (`undefined-key`), or a
//! prefix, in which case its binding (if any) and the longer sequences live
//! in the multi-byte table. Each multi-byte entry has a widget, a string to
//! send (`bindkey -s`) or nothing, and a count of the entries it is a proper
//! prefix of.
//!
//! Key sequences are raw bytes here (zsh keeps them metafied); where zsh's
//! behaviour depends on the metafied form (the sort order of listings) it
//! is computed from it.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::{cmp::Ordering, collections::HashMap};

use bstr::BString;

use super::bindings;
use crate::bash::syntax::zsh::tok;

/// The widget name zsh's `t_undefinedkey` thingy has: binding it is
/// unbinding.
pub const UNDEFINED_KEY: &[u8] = b"undefined-key";

/// What a key sequence is bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Bind {
	/// A widget (zsh thingy) name.
	Widget(BString),
	/// A string pushed back as input (`bindkey -s`), raw bytes.
	Str(BString),
}

impl Bind {
	/// A widget binding.
	pub fn widget(name: impl Into<BString>) -> Self {
		Self::Widget(name.into())
	}

	/// zsh `t_undefinedkey`: `None` for the widget `undefined-key`, which
	/// stands for no binding.
	fn normal(b: Option<Self>) -> Option<Self> {
		match b {
			Some(Self::Widget(w)) if w.as_slice() == UNDEFINED_KEY => None,
			b => b,
		}
	}
}

/// One entry of a keymap's first-byte table (zsh `km->first[c]`: a thingy,
/// `t_undefinedkey`, or `NULL` for a prefix).
#[derive(Clone, Debug)]
enum First {
	/// The byte starts longer sequences; its own binding is in the multi
	/// table.
	Prefix,
	/// `undefined-key`.
	Undefined,
	/// A widget ([`Bind::Widget`]; strings always live in the multi table).
	Bound(Bind),
}

impl First {
	fn of(b: Option<Bind>) -> Self {
		b.map_or(Self::Undefined, Self::Bound)
	}
}

/// zsh `struct key`: a multi-table entry.
#[derive(Clone, Debug)]
struct Key {
	/// The binding, `None` for `undefined-key` (a pure prefix).
	bind:     Option<Bind>,
	/// zsh `prefixct`: how many entries this sequence is a proper prefix
	/// of.
	prefixct: u32,
}

/// One keymap (zsh `struct keymap`).
#[derive(Clone, Debug)]
pub struct Keymap {
	/// zsh `first`: the binding of each first byte.
	first:     Vec<First>,
	/// zsh `multi`: bindings of sequences longer than a byte, and of the
	/// bytes that are prefixes.
	multi:     HashMap<BString, Key>,
	/// zsh `primary`: the name `bindkey -lL` shows the keymap under (the
	/// first name it got other than `main`).
	primary:   Option<BString>,
	/// zsh `KM_IMMUTABLE` (`.safe`).
	immutable: bool,
	/// zsh `rc`: the names (and saved references) that hold it.
	rc:        u32,
}

/// Why [`Keymap::bind`] refused (zsh `bindkey` returning 1 or 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindError {
	/// The keymap is immutable (`.safe`).
	Immutable,
	/// The key sequence is empty.
	Empty,
}

/// A keymap name is `KMN_IMMORTAL` (`.safe`, complist's maps) and cannot
/// be relinked or deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Protected;

/// Why [`Keymaps::unlink`] failed (zsh `unlinkkeymap` returning 1 or 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlinkError {
	/// The name is immortal.
	Protected,
	/// No keymap has that name.
	NoSuchKeymap,
}

impl Keymap {
	/// zsh `newkeymap`: an empty keymap (every byte `undefined-key`) or a
	/// copy of `of`'s bindings; no names yet.
	fn new(of: Option<&Self>) -> Self {
		match of {
			Some(k) => Self {
				first:     k.first.clone(),
				multi:     k.multi.clone(),
				primary:   None,
				immutable: false,
				rc:        0,
			},
			None => Self {
				first:     vec![First::Undefined; 256],
				multi:     HashMap::new(),
				primary:   None,
				immutable: false,
				rc:        0,
			},
		}
	}

	/// zsh `KM_IMMUTABLE`.
	pub const fn immutable(&self) -> bool {
		self.immutable
	}

	/// zsh `bindkey`: bind `seq` (raw bytes) to `bind` in this keymap;
	/// `None` (or the widget `undefined-key`) unbinds it. Prefix entries are
	/// created and removed as the multi-byte sequences need them.
	pub fn bind(&mut self, seq: &[u8], bind: Option<Bind>) -> Result<(), BindError> {
		if self.immutable {
			return Err(BindError::Immutable);
		}
		let Some(&c) = seq.first() else {
			return Err(BindError::Empty);
		};
		let bind = Bind::normal(bind);
		let f = usize::from(c);
		if matches!(bind, Some(Bind::Str(_))) || seq.len() > 1 {
			// The key needs to become a prefix if it isn't one already.
			match std::mem::replace(&mut self.first[f], First::Prefix) {
				First::Prefix => {},
				First::Undefined => {
					self
						.multi
						.insert(BString::from(vec![c]), Key { bind: None, prefixct: 0 });
				},
				First::Bound(b) => {
					self
						.multi
						.insert(BString::from(vec![c]), Key { bind: Some(b), prefixct: 0 });
				},
			}
		} else {
			if matches!(self.first[f], First::Prefix) {
				// A prefix only because of a send-string binding of the key
				// itself: that entry goes.
				let prefixct = self.multi.get(seq).map_or(0, |k| k.prefixct);
				if prefixct != 0 {
					self.bind_multi(seq, bind);
					return Ok(());
				}
				self.multi.remove(seq);
			}
			// Just replace the single-character binding.
			self.first[f] = First::of(bind);
			return Ok(());
		}
		self.bind_multi(seq, bind);
		Ok(())
	}

	/// zsh `bindkey`'s `domulti` part: bind `seq` in the multi table, whose
	/// first byte is a prefix.
	fn bind_multi(&mut self, seq: &[u8], bind: Option<Bind>) {
		let mut buf = seq.to_vec();
		let Some(bind) = bind else {
			let Some(k) = self.multi.get_mut(seq) else {
				return;
			};
			k.bind = None;
			loop {
				match self.multi.get(buf.as_slice()) {
					Some(k) if k.prefixct == 0 && k.bind.is_none() => {},
					_ => break,
				}
				self.multi.remove(buf.as_slice());
				buf.pop();
				if buf.is_empty() {
					break;
				}
				let Some(k) = self.multi.get_mut(buf.as_slice()) else {
					break;
				};
				k.prefixct = k.prefixct.saturating_sub(1);
				if k.prefixct == 0 && buf.len() == 1 && !matches!(k.bind, Some(Bind::Str(_))) {
					// The byte is no longer a prefix: its binding moves
					// back to the first-byte table.
					let b = k.bind.take();
					self.first[usize::from(buf[0])] = First::of(b);
					self.multi.remove(buf.as_slice());
					break;
				}
			}
			return;
		};
		if let Some(k) = self.multi.get_mut(seq) {
			k.bind = Some(bind);
			return;
		}
		self
			.multi
			.insert(BString::from(seq), Key { bind: Some(bind), prefixct: 0 });
		loop {
			buf.pop();
			if buf.is_empty() {
				break;
			}
			if let Some(k) = self.multi.get_mut(buf.as_slice()) {
				k.prefixct += 1;
				break;
			}
			self
				.multi
				.insert(BString::from(buf.as_slice()), Key { bind: None, prefixct: 1 });
		}
	}

	/// zsh `keybind`: the binding of `seq`, `None` for `undefined-key`.
	pub fn lookup(&self, seq: &[u8]) -> Option<&Bind> {
		if let [c] = seq {
			match &self.first[usize::from(*c)] {
				First::Bound(b) => return Some(b),
				First::Undefined => return None,
				First::Prefix => {},
			}
		}
		self.multi.get(seq).and_then(|k| k.bind.as_ref())
	}

	/// zsh `keyisprefix`: whether `seq` is a proper prefix of a bound
	/// sequence (true for the empty sequence).
	pub fn is_prefix(&self, seq: &[u8]) -> bool {
		match seq {
			[] => return true,
			[c] if !matches!(self.first[usize::from(*c)], First::Prefix) => return false,
			_ => {},
		}
		self.multi.get(seq).is_some_and(|k| k.prefixct != 0)
	}

	/// zsh `scankeymap(km, 1, …)`: every entry in listing order, with
	/// `None` for the multi-table entries that are only prefixes (they end
	/// runs of keys in `bindkey` listings). The multi
	/// table is sorted as zsh's `hnamcmp` sorts metafied names; first-byte
	/// bindings are interleaved by their byte before the multi entries
	/// whose first byte is higher.
	pub fn scan_entries(&self, f: &mut dyn FnMut(&[u8], Option<&Bind>)) {
		let mut keys: Vec<(Vec<u8>, &BString, &Key)> = self
			.multi
			.iter()
			.map(|(s, k)| (tok::metafy(s), s, k))
			.collect();
		keys.sort_by(|a, b| ztrcmp(&a.0, &b.0).then_with(|| a.0.len().cmp(&b.0.len())));
		let mut last: i32 = -1;
		for (_, seq, k) in keys {
			let c = i32::from(seq.first().copied().unwrap_or(0));
			self.scan_first(&mut last, c, f);
			f(seq, k.bind.as_ref());
		}
		self.scan_first(&mut last, 255, f);
	}

	/// zsh `scankeys`' catch-up: the first-byte bindings after `*last` up
	/// to `upto`.
	fn scan_first(&self, last: &mut i32, upto: i32, f: &mut dyn FnMut(&[u8], Option<&Bind>)) {
		while *last < upto {
			*last += 1;
			let Ok(b) = u8::try_from(*last) else {
				return;
			};
			if let First::Bound(bind) = &self.first[usize::from(b)] {
				f(&[b], Some(bind));
			}
		}
	}

	/// zsh `scankeymap(km, 1, …)` over the bound sequences, in `bindkey`
	/// listing order (for `where-is`, `describe-key-briefly`).
	pub fn scan(&self, f: &mut dyn FnMut(&[u8], &Bind)) {
		self.scan_entries(&mut |s, b| {
			if let Some(b) = b {
				f(s, b);
			}
		});
	}
}

/// zsh `ztrcmp` of metafied strings as zsh compiles where `char` is
/// signed (darwin, x86-64): bytes compare as signed values, the end of a
/// string as -1, and the `Meta` test never matches.
fn ztrcmp(a: &[u8], b: &[u8]) -> Ordering {
	let i = a.iter().zip(b).take_while(|(x, y)| x == y).count();
	let at = |s: &[u8]| s.get(i).map_or(-1, |&c| i32::from(i8::from_ne_bytes([c])));
	at(a).cmp(&at(b))
}

/// zsh's name order (`hnamcmp` over metafied names).
fn name_cmp(a: &[u8], b: &[u8]) -> Ordering {
	ztrcmp(&tok::metafy(a), &tok::metafy(b)).then_with(|| a.len().cmp(&b.len()))
}

/// zsh `hasher`.
fn hasher(s: &[u8]) -> u32 {
	s.iter()
		.fold(0u32, |h, &c| h.wrapping_add(h.wrapping_shl(5)).wrapping_add(u32::from(c)))
}

/// A keymap's handle in [`Keymaps`] (zsh `Keymap` pointer), valid while a
/// name or a [`Keymaps::ref_keymap`] holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct KmId(usize);

/// zsh `struct keymapname`.
#[derive(Clone, Debug)]
struct KmName {
	name:     BString,
	/// zsh `KMN_IMMORTAL`.
	immortal: bool,
	km:       usize,
}

/// zsh's `keymapnamtab` hash table, kept with zsh's bucket layout so that
/// `$keymaps` lists names in zsh's order: 7 buckets, new names at the
/// head of their chain, four times the buckets once there are twice as
/// many names.
#[derive(Clone, Debug)]
struct NameTab {
	nodes: Vec<Vec<KmName>>,
	ct:    usize,
}

impl NameTab {
	fn new() -> Self {
		Self { nodes: vec![Vec::new(); 7], ct: 0 }
	}

	fn bucket(&self, name: &[u8]) -> usize {
		// u32 → usize never fails on supported targets.
		usize::try_from(hasher(name)).map_or(0, |h| h % self.nodes.len())
	}

	fn get(&self, name: &[u8]) -> Option<&KmName> {
		self.nodes[self.bucket(name)]
			.iter()
			.find(|n| n.name.as_slice() == name)
	}

	fn get_mut(&mut self, name: &[u8]) -> Option<&mut KmName> {
		let b = self.bucket(name);
		self.nodes[b].iter_mut().find(|n| n.name.as_slice() == name)
	}

	/// zsh `addhashnode` of a name not in the table.
	fn add(&mut self, node: KmName) {
		let b = self.bucket(&node.name);
		self.nodes[b].insert(0, node);
		self.ct += 1;
		if self.ct >= self.nodes.len() * 2 {
			self.expand();
		}
	}

	/// zsh `expandhashtable`.
	fn expand(&mut self) {
		let old = std::mem::take(&mut self.nodes);
		self.nodes = vec![Vec::new(); old.len() * 4];
		self.ct = 0;
		for node in old.into_iter().flatten() {
			self.add(node);
		}
	}

	/// zsh `removehashnode`.
	fn remove(&mut self, name: &[u8]) -> Option<KmName> {
		let b = self.bucket(name);
		let i = self.nodes[b]
			.iter()
			.position(|n| n.name.as_slice() == name)?;
		self.ct -= 1;
		Some(self.nodes[b].remove(i))
	}

	/// The nodes in table order.
	fn iter(&self) -> impl Iterator<Item = &KmName> {
		self.nodes.iter().flatten()
	}

	/// The nodes in zsh's sorted scan order.
	fn sorted(&self) -> Vec<&KmName> {
		let mut v: Vec<&KmName> = self.iter().collect();
		v.sort_by(|a, b| name_cmp(&a.name, &b.name));
		v
	}
}

/// The terminal's cursor-key sequences (termcap `ku`, `kd`, `kl`, `kr`)
/// zsh `add_cursor_key` binds; `None` (the terminal lacks the capability,
/// or is `TERM_BAD`/`TERM_UNKNOWN`/`TERM_NOUP`) binds the VT100 sequences
/// `\e[A`… instead.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CursorKeys {
	/// Up arrow.
	pub up:    Option<BString>,
	/// Down arrow.
	pub down:  Option<BString>,
	/// Left arrow.
	pub left:  Option<BString>,
	/// Right arrow.
	pub right: Option<BString>,
}

/// How a keymap name came to be, as `bindkey -lL` shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MapOrigin {
	/// `bindkey -A primary name`.
	Linked(BString),
	/// `bindkey -N name`.
	New,
}

/// zsh's keymaps: the name table (`keymapnamtab`) and the keymaps it names.
#[derive(Clone, Debug)]
pub struct Keymaps {
	/// Keymaps by [`KmId`]; `None` for freed slots.
	maps:   Vec<Option<Keymap>>,
	names:  NameTab,
	/// The cursor keys the defaults were built with (`bindkey -d` builds
	/// them again).
	cursor: CursorKeys,
}

/// zsh `default_bindings`' choice of `main`: `viins` when `$VISUAL`, else
/// `$EDITOR`, contains `vi` (either is checked when set), `emacs`
/// otherwise.
pub fn default_main_vi(visual: Option<&[u8]>, editor: Option<&[u8]>) -> bool {
	let has_vi = |s: Option<&[u8]>| s.is_some_and(|s| s.windows(2).any(|w| w == b"vi"));
	has_vi(visual) || has_vi(editor)
}

impl Keymaps {
	/// zsh `init_keymaps`: the default keymaps with the VT100 cursor keys;
	/// `main` is linked to `viins` when `main_vi` (see
	/// [`default_main_vi`]), else to `emacs`.
	pub fn new(main_vi: bool) -> Self {
		Self::with_cursor_keys(main_vi, CursorKeys::default())
	}

	/// [`Self::new`] with the terminal's cursor keys.
	pub fn with_cursor_keys(main_vi: bool, cursor: CursorKeys) -> Self {
		let mut k = Self { maps: Vec::new(), names: NameTab::new(), cursor };
		k.default_bindings(main_vi);
		k
	}

	/// `bindkey -d`: zsh `emptykeymapnamtab` + `default_bindings`. Every
	/// name goes; keymaps still held by [`Self::ref_keymap`] survive
	/// unnamed.
	pub fn reset(&mut self, main_vi: bool) {
		let nodes = std::mem::take(&mut self.names.nodes);
		self.names.nodes = vec![Vec::new(); nodes.len()];
		self.names.ct = 0;
		for n in nodes.into_iter().flatten() {
			if self.unref_keymap(KmId(n.km)) != 0
				&& let Some(km) = self.km_mut(n.km)
			{
				km.primary = None;
			}
		}
		self.default_bindings(main_vi);
	}

	fn km(&self, id: usize) -> Option<&Keymap> {
		self.maps.get(id).and_then(Option::as_ref)
	}

	fn km_mut(&mut self, id: usize) -> Option<&mut Keymap> {
		self.maps.get_mut(id).and_then(Option::as_mut)
	}

	/// Store a new keymap (rc 0).
	fn alloc(&mut self, km: Keymap) -> usize {
		if let Some(i) = self.maps.iter().position(Option::is_none) {
			self.maps[i] = Some(km);
			i
		} else {
			self.maps.push(Some(km));
			self.maps.len() - 1
		}
	}

	/// zsh `openkeymap`: the keymap named `name`.
	pub fn open(&self, name: &[u8]) -> Option<KmId> {
		self.names.get(name).map(|n| KmId(n.km))
	}

	/// The keymap `id` stands for.
	pub fn keymap(&self, id: KmId) -> Option<&Keymap> {
		self.km(id.0)
	}

	/// The keymap named `name`.
	pub fn get(&self, name: &[u8]) -> Option<&Keymap> {
		self.open(name).and_then(|id| self.keymap(id))
	}

	/// Whether a keymap is named `name`.
	pub fn exists(&self, name: &[u8]) -> bool {
		self.names.get(name).is_some()
	}

	/// Whether names `a` and `b` name the same keymap (zsh
	/// `openkeymap(a) == openkeymap(b)`, e.g. `main` and `viins`; two
	/// missing names are the same too).
	pub fn same(&self, a: &[u8], b: &[u8]) -> bool {
		match (self.open(a), self.open(b)) {
			(Some(x), Some(y)) => x == y,
			(None, None) => true,
			_ => false,
		}
	}

	/// zsh `keybind` in the keymap named `km`: the binding of `seq` (raw
	/// bytes), `None` for `undefined-key` or no such keymap.
	pub fn lookup(&self, km: &[u8], seq: &[u8]) -> Option<&Bind> {
		self.get(km).and_then(|k| k.lookup(seq))
	}

	/// zsh `keyisprefix` in the keymap named `km` (false for no such
	/// keymap).
	pub fn is_prefix(&self, km: &[u8], seq: &[u8]) -> bool {
		self.get(km).is_some_and(|k| k.is_prefix(seq))
	}

	/// `$keymaps`: every name in zsh's hash-table order.
	pub fn names(&self) -> Vec<BString> {
		self.names.iter().map(|n| n.name.clone()).collect()
	}

	/// The names sorted as `bindkey -l` lists them.
	pub fn sorted_names(&self) -> Vec<BString> {
		self
			.names
			.sorted()
			.into_iter()
			.map(|n| n.name.clone())
			.collect()
	}

	/// zsh `scankeymap(km, 1, …)` over the bound sequences of the keymap
	/// named `km`, in listing order; nothing for no such keymap.
	pub fn scan(&self, km: &[u8], f: &mut dyn FnMut(&[u8], &Bind)) {
		if let Some(k) = self.get(km) {
			k.scan(f);
		}
	}

	/// Whether name `name` is immortal (zsh `KMN_IMMORTAL`).
	pub fn immortal(&self, name: &[u8]) -> bool {
		self.names.get(name).is_some_and(|n| n.immortal)
	}

	/// What `bindkey -lL` shows for name `name`: `None` for `.safe` (or no
	/// such name), else how the name came to be.
	pub fn primary_of(&self, name: &[u8]) -> Option<MapOrigin> {
		let n = self.names.get(name)?;
		if n.name.as_slice() == b".safe" {
			return None;
		}
		let primary = self.km(n.km).and_then(|k| k.primary.clone());
		Some(match primary.filter(|p| p.as_slice() != name) {
			Some(p) => MapOrigin::Linked(p),
			None => MapOrigin::New,
		})
	}

	/// zsh `refkeymap`: hold keymap `id` so it survives losing its names
	/// (zsh `savekeymap`); balance with [`Self::unref_keymap`].
	pub fn ref_keymap(&mut self, id: KmId) {
		if let Some(k) = self.km_mut(id.0) {
			k.rc += 1;
		}
	}

	/// zsh `unrefkeymap`: drop a hold; the keymap is freed when nothing
	/// holds it. Returns the remaining count.
	pub fn unref_keymap(&mut self, id: KmId) -> u32 {
		let Some(k) = self.km_mut(id.0) else {
			return 0;
		};
		k.rc = k.rc.saturating_sub(1);
		let rc = k.rc;
		if rc == 0 {
			self.maps[id.0] = None;
		}
		rc
	}

	/// zsh `refkeymap_by_name` of node `name` now pointing at `id`.
	fn ref_by_name(&mut self, id: usize, name: &[u8]) {
		if let Some(k) = self.km_mut(id) {
			k.rc += 1;
			if k.primary.is_none() && name != b"main" {
				k.primary = Some(BString::from(name));
			}
		}
	}

	/// zsh `unrefkeymap_by_name`: node `name` no longer holds `id`; a
	/// surviving keymap that was known by that name gets the first other
	/// name (in sorted order, never `main`) that points at it. The node
	/// may still be in the table (zsh relinks it after this), and is then
	/// a candidate itself.
	fn unref_by_name(&mut self, id: usize, name: &[u8]) {
		if self.unref_keymap(KmId(id)) == 0 {
			return;
		}
		if self
			.km(id)
			.is_none_or(|k| k.primary.as_ref().is_none_or(|p| p.as_slice() != name))
		{
			return;
		}
		let primary = self
			.names
			.sorted()
			.into_iter()
			.find(|n| n.name.as_slice() != b"main" && n.km == id)
			.map(|n| n.name.clone());
		if let Some(k) = self.km_mut(id) {
			k.primary = primary;
		}
	}

	/// zsh `linkkeymap`: point `name` at keymap `id`, creating the name
	/// (immortal when `immortal`) if needed. Fails when the name is
	/// immortal.
	pub fn link(&mut self, id: KmId, name: &[u8], immortal: bool) -> Result<(), Protected> {
		if let Some(n) = self.names.get(name) {
			if n.immortal {
				return Err(Protected);
			}
			let old = n.km;
			if old == id.0 {
				return Ok(());
			}
			self.unref_by_name(old, name);
			if let Some(n) = self.names.get_mut(name) {
				n.km = id.0;
			}
		} else {
			self
				.names
				.add(KmName { name: BString::from(name), immortal, km: id.0 });
		}
		self.ref_by_name(id.0, name);
		Ok(())
	}

	/// zsh `unlinkkeymap`: remove name `name`; an immortal name only with
	/// `ignore_immortal`.
	pub fn unlink(&mut self, name: &[u8], ignore_immortal: bool) -> Result<(), UnlinkError> {
		let Some(n) = self.names.get(name) else {
			return Err(UnlinkError::NoSuchKeymap);
		};
		if n.immortal && !ignore_immortal {
			return Err(UnlinkError::Protected);
		}
		if let Some(n) = self.names.remove(name) {
			self.unref_by_name(n.km, &n.name);
		}
		Ok(())
	}

	/// zsh `newkeymap` + `linkkeymap`: a new keymap named `name`, empty or
	/// a copy of `copy_of`'s bindings. Fails when `name` is immortal.
	pub fn create(
		&mut self,
		name: &[u8],
		copy_of: Option<KmId>,
		immortal: bool,
	) -> Result<KmId, Protected> {
		if self.names.get(name).is_some_and(|n| n.immortal) {
			return Err(Protected);
		}
		let km = Keymap::new(copy_of.and_then(|id| self.keymap(id)));
		let id = KmId(self.alloc(km));
		self.link(id, name, immortal)?;
		Ok(id)
	}

	/// zsh `bindkey` in keymap `id` ([`Keymap::bind`]); a freed `id` is
	/// treated as immutable.
	pub fn bind(&mut self, id: KmId, seq: &[u8], bind: Option<Bind>) -> Result<(), BindError> {
		match self.km_mut(id.0) {
			Some(k) => k.bind(seq, bind),
			None => Err(BindError::Immutable),
		}
	}

	/// zsh `default_bindings`: create the default keymaps and link their
	/// names.
	fn default_bindings(&mut self, main_vi: bool) {
		let w = |s: &str| Some(Bind::widget(s));
		let th = |s: Option<&str>| First::of(s.and_then(w));
		let mut vmap = Keymap::new(None);
		let mut emap = Keymap::new(None);
		let mut amap = Keymap::new(None);
		let mut oppmap = Keymap::new(None);
		let mut vismap = Keymap::new(None);
		let mut smap = Keymap::new(None);

		// vi insert mode and emacs mode: 0-31 from the tables, 32-126
		// self-insert, 127 as 8, 128-255 self-insert.
		for i in 0..32 {
			vmap.first[i] = th(bindings::VIINS[i]);
			emap.first[i] = th(bindings::EMACS[i]);
		}
		for i in 32..256 {
			vmap.first[i] = th(Some("self-insert"));
			emap.first[i] = th(Some("self-insert"));
		}
		vmap.first[127] = vmap.first[8].clone();
		emap.first[127] = emap.first[8].clone();

		// vi command mode: 0-127 from the table, 128-255 undefined-key.
		for (slot, &b) in amap.first.iter_mut().zip(&bindings::VICMD) {
			*slot = th(b);
		}

		// Safe fallback keymap: .self-insert, except .accept-line for
		// newline and return.
		for slot in smap.first.iter_mut().take(256) {
			*slot = th(Some(".self-insert"));
		}
		smap.first[usize::from(b'\n')] = th(Some(".accept-line"));
		smap.first[usize::from(b'\r')] = th(Some(".accept-line"));

		let cursor = self.cursor.clone();
		// vt100 arrow keys are bound by default, for historical reasons;
		// both standard and keypad modes.
		for km in [&mut vmap, &mut amap] {
			add_cursor_key(km, cursor.up.as_ref(), "up-line-or-history", b'A');
			add_cursor_key(km, cursor.down.as_ref(), "down-line-or-history", b'B');
			add_cursor_key(km, cursor.left.as_ref(), "vi-backward-char", b'D');
			add_cursor_key(km, cursor.right.as_ref(), "vi-forward-char", b'C');
		}
		// vi visual selection and operator pending local maps.
		for km in [&mut oppmap, &mut vismap] {
			add_cursor_key(km, cursor.up.as_ref(), "up-line", b'A');
			add_cursor_key(km, cursor.down.as_ref(), "down-line", b'B');
			for (seq, wid) in [
				(&b"k"[..], "up-line"),
				(b"j", "down-line"),
				(b"aa", "select-a-shell-word"),
				(b"ia", "select-in-shell-word"),
				(b"aw", "select-a-word"),
				(b"iw", "select-in-word"),
				(b"aW", "select-a-blank-word"),
				(b"iW", "select-in-blank-word"),
			] {
				defbind(km, seq, w(wid));
			}
		}
		// Escape in operator pending cancels the operation.
		defbind(&mut oppmap, b"\x1b", w("vi-cmd-mode"));
		for (seq, wid) in [
			(&b"\x1b"[..], "deactivate-region"),
			(b"o", "exchange-point-and-mark"),
			(b"p", "put-replace-selection"),
			(b"u", "vi-down-case"),
			(b"U", "vi-up-case"),
			(b"x", "vi-delete"),
			(b"~", "vi-oper-swap-case"),
		] {
			defbind(&mut vismap, seq, w(wid));
		}

		// vi mode: some common vim bindings.
		for (seq, wid) in [
			(&b"ga"[..], "what-cursor-position"),
			(b"ge", "vi-backward-word-end"),
			(b"gE", "vi-backward-blank-word-end"),
			(b"gg", "beginning-of-buffer-or-history"),
			(b"gu", "vi-down-case"),
			(b"gU", "vi-up-case"),
			(b"g~", "vi-oper-swap-case"),
		] {
			defbind(&mut amap, seq, w(wid));
		}
		for (seq, s) in [(&b"g~~"[..], &b"g~g~"[..]), (b"guu", b"gugu"), (b"gUU", b"gUgU")] {
			defbind(&mut amap, seq, Some(Bind::Str(BString::from(s))));
		}

		// emacs mode: arrow keys.
		add_cursor_key(&mut emap, cursor.up.as_ref(), "up-line-or-history", b'A');
		add_cursor_key(&mut emap, cursor.down.as_ref(), "down-line-or-history", b'B');
		add_cursor_key(&mut emap, cursor.left.as_ref(), "backward-char", b'D');
		add_cursor_key(&mut emap, cursor.right.as_ref(), "forward-char", b'C');

		// emacs mode: ^X sequences.
		for (seq, wid) in [
			(&b"\x18*"[..], "expand-word"),
			(b"\x18g", "list-expand"),
			(b"\x18G", "list-expand"),
			(b"\x18\x0e", "infer-next-history"),
			(b"\x18\x0b", "kill-buffer"),
			(b"\x18\x06", "vi-find-next-char"),
			(b"\x18\x0f", "overwrite-mode"),
			(b"\x18\x15", "undo"),
			(b"\x18\x16", "vi-cmd-mode"),
			(b"\x18\x0a", "vi-join"),
			(b"\x18\x02", "vi-match-bracket"),
			(b"\x18s", "history-incremental-search-forward"),
			(b"\x18r", "history-incremental-search-backward"),
			(b"\x18u", "undo"),
			(b"\x18\x18", "exchange-point-and-mark"),
			(b"\x18=", "what-cursor-position"),
		] {
			defbind(&mut emap, seq, w(wid));
		}

		// Bracketed paste applicable to all keymaps.
		for km in [&mut emap, &mut vmap, &mut amap] {
			defbind(km, b"\x1b[200~", w("bracketed-paste"));
		}

		// emacs mode: ESC sequences, all taken from the meta binding table.
		for (i, wid) in bindings::META.iter().enumerate() {
			if let (Some(wid), Ok(c)) = (*wid, u8::try_from(i)) {
				defbind(&mut emap, &[0x1b, c], w(wid));
			}
		}

		// Put the keymaps in the right namespace.
		let vmap = KmId(self.alloc(vmap));
		let emap = KmId(self.alloc(emap));
		let amap = KmId(self.alloc(amap));
		let oppmap = KmId(self.alloc(oppmap));
		let vismap = KmId(self.alloc(vismap));
		let smap = KmId(self.alloc(smap));
		self.deflink(vmap, b"viins", false);
		self.deflink(emap, b"emacs", false);
		self.deflink(amap, b"vicmd", false);
		self.deflink(oppmap, b"viopp", false);
		self.deflink(vismap, b"visual", false);
		self.deflink(smap, b".safe", true);
		self.deflink(if main_vi { vmap } else { emap }, b"main", false);

		// The .safe map cannot be modified or deleted.
		if let Some(k) = self.km_mut(smap.0) {
			k.immutable = true;
		}

		// isearch keymap: initially empty.
		let isearch = KmId(self.alloc(Keymap::new(None)));
		self.deflink(isearch, b"isearch", false);

		// command keymap: make sure accept-line and send-break are bound.
		let mut command = Keymap::new(None);
		command.first[usize::from(b'\n')] = th(Some("accept-line"));
		command.first[usize::from(b'\r')] = th(Some("accept-line"));
		command.first[usize::from(b'G' & 0x1f)] = th(Some("send-break"));
		let command = KmId(self.alloc(command));
		self.deflink(command, b"command", false);
	}

	/// [`Self::link`] of a default name: `default_bindings` runs on an
	/// empty name table ([`Self::with_cursor_keys`], [`Self::reset`]), where
	/// no name is immortal, so linking cannot fail.
	fn deflink(&mut self, id: KmId, name: &[u8], immortal: bool) {
		let linked = self.link(id, name, immortal);
		debug_assert!(linked.is_ok(), "default keymap names are linked into an empty table");
	}
}

/// A default binding into a fresh (mutable) keymap: zsh ignores
/// `bindkey`'s result there, and neither failure can happen.
fn defbind(km: &mut Keymap, seq: &[u8], bind: Option<Bind>) {
	let _ = km.bind(seq, bind);
}

/// zsh `add_cursor_key`: bind the terminal's cursor key `cap` (raw tputs
/// output, which zsh then treats as metafied) to `widget`, or `\e[` +
/// `defchar` when the terminal gives none usable (shorter than two
/// characters); a `\e[X`/`\eOX` sequence also binds the other form.
fn add_cursor_key(km: &mut Keymap, cap: Option<&BString>, widget: &str, defchar: u8) {
	let mut buf = match cap {
		Some(c) if c.len() >= 2 && (c[0] != tok::META || c.len() >= 3) => tok::unmetafy(c),
		_ => vec![0x1b, b'[', defchar],
	};
	defbind(km, &buf, Some(Bind::widget(widget)));
	if buf.len() == 3 && buf[0] == 0x1b && (buf[1] == b'[' || buf[1] == b'O') {
		buf[1] = if buf[1] == b'[' { b'O' } else { b'[' };
		defbind(km, &buf, Some(Bind::widget(widget)));
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn names(k: &Keymaps) -> String {
		k.names()
			.iter()
			.map(ToString::to_string)
			.collect::<Vec<_>>()
			.join(" ")
	}

	#[test]
	fn keymaps_order_follows_zshs_hash_table() {
		// zsh: for n in a b c d e f; bindkey -N $n; print -l $keymaps
		let mut k = Keymaps::new(false);
		for n in [&b"a"[..], b"b", b"c", b"d", b"e", b"f"] {
			assert!(k.create(n, None, false).is_ok());
		}
		assert_eq!(
			names(&k),
			"vicmd command viins visual emacs a b c d .safe e f isearch viopp main"
		);
		// zsh: bindkey -D a b; bindkey -d; print -l $keymaps
		assert_eq!(k.unlink(b"a", false), Ok(()));
		assert_eq!(k.unlink(b"b", false), Ok(()));
		k.reset(false);
		assert_eq!(names(&k), "command vicmd viins visual emacs .safe isearch viopp main");
	}

	#[test]
	fn lookup_and_prefixes() {
		let k = Keymaps::new(false);
		assert_eq!(k.lookup(b"emacs", b"\x01"), Some(&Bind::widget("beginning-of-line")));
		assert_eq!(k.lookup(b"emacs", b"\x03"), None);
		assert_eq!(k.lookup(b"emacs", b"\x1bOA"), Some(&Bind::widget("up-line-or-history")));
		assert_eq!(k.lookup(b"emacs", b"\x1b"), None);
		assert!(k.is_prefix(b"emacs", b"\x1b"));
		assert!(k.is_prefix(b"emacs", b"\x1bO"));
		assert!(!k.is_prefix(b"emacs", b"\x1bOA"));
		assert!(!k.is_prefix(b"emacs", b"a"));
		assert_eq!(k.lookup(b"viins", b"\x1b"), Some(&Bind::widget("vi-cmd-mode")));
		assert!(k.is_prefix(b"viins", b"\x1b"));
		assert_eq!(k.lookup(b"vicmd", b"g~~"), Some(&Bind::Str("g~g~".into())));
		assert_eq!(k.lookup(b".safe", b"\r"), Some(&Bind::widget(".accept-line")));
		assert!(!k.exists(b"nope"));
		assert!(!k.is_prefix(b"nope", b""));
		assert!(k.immortal(b".safe"));
		assert!(!k.immortal(b"emacs"));
		let mut seen = Vec::new();
		k.scan(b"command", &mut |s, b| seen.push((s.to_vec(), b.clone())));
		assert_eq!(seen, [
			(b"\x07".to_vec(), Bind::widget("send-break")),
			(b"\n".to_vec(), Bind::widget("accept-line")),
			(b"\r".to_vec(), Bind::widget("accept-line")),
		]);
	}

	#[test]
	fn safe_is_immutable_and_immortal() {
		let mut k = Keymaps::new(false);
		let safe = k.open(b".safe").expect(".safe");
		assert_eq!(k.bind(safe, b"a", None), Err(BindError::Immutable));
		assert_eq!(k.unlink(b".safe", false), Err(UnlinkError::Protected));
		assert_eq!(k.unlink(b"nope", false), Err(UnlinkError::NoSuchKeymap));
		let emacs = k.open(b"emacs").expect("emacs");
		assert_eq!(k.link(emacs, b".safe", false), Err(Protected));
		assert_eq!(k.bind(emacs, b"", None), Err(BindError::Empty));
		// The immortal name only goes when asked to ignore it (complist's
		// cleanup).
		assert_eq!(k.unlink(b".safe", true), Ok(()));
		assert!(!k.exists(b".safe"));
	}
}
