//! Lexical pads, typeglobs, references and assignable objects (perldata, perlvar, perlref).

use super::{refalias::{RefPlace, RefTarget}, *};

#[derive(Clone)]
pub(super) enum Slot { Scalar(Sv), Array(Av), Hash(Hv), Code(Cv), Glob(Gv), Our(Rc<str>) }
pub(super) type Pad = Vec<(Sigil, Rc<str>, Slot)>;

/// Compiled name operands address a dense register of visible pad locations. The register
/// contains indices, never strong cell references: rebinding and scope-exit destruction
/// therefore have exactly the same lifetimes as the actual Perl pad. Captured pads, eval
/// overlays, signatures and loop aliases install locations using the same register IDs.
#[derive(Clone, Copy, Default)]
struct PadLocation { frame: usize, scope: usize, offset: usize }

#[derive(Default)]
pub(super) struct Lexicals {
	ids: FxHashMap<(u8, Rc<str>), usize>,
	// Holding the AST name keeps the address key valid even for parser callbacks before validation.
	sites: FxHashMap<(usize, u8), (Rc<str>, usize)>,
	visible: Vec<PadLocation>,
	undo: Vec<(usize, PadLocation)>,
	frame: usize,
}

impl Lexicals {
	#[inline]
	fn operand(&self, sigil: Sigil, name: &str) -> Option<usize> {
		let (original, id) = self.sites.get(&(name.as_ptr() as usize, slot_sigil(sigil) as u8))?;
		// Symbolic callers can pass a prefix of a compiled name, with the same pointer.
		(original.len() == name.len()).then_some(*id)
	}

	pub(super) fn resolve(&mut self, sigil: Sigil, name: &Rc<str>) -> usize {
		self.resolve_name(slot_sigil(sigil) as u8, name)
	}

	pub(super) fn resolve_name(&mut self, sigil: u8, name: &Rc<str>) -> usize {
		if let Some((_, id)) = self.sites.get(&(name.as_ptr() as usize, sigil)) { return *id; }
		let id = *self.ids.entry((sigil, name.clone())).or_insert_with(|| {
			let id = self.visible.len();
			self.visible.push(PadLocation { frame: usize::MAX, ..PadLocation::default() });
			id
		});
		self.sites.insert((name.as_ptr() as usize, sigil), (name.clone(), id));
		id
	}

	#[inline]
	fn install(&mut self, id: usize, scope: usize, offset: usize) {
		let previous = std::mem::replace(&mut self.visible[id], PadLocation { frame: self.frame, scope, offset });
		self.undo.push((id, previous));
	}

	#[inline]
	fn unwind(&mut self, mark: usize) {
		while self.undo.len() > mark {
			if let Some((id, old)) = self.undo.pop() { self.visible[id] = old; }
		}
	}
}

/// A memoized `qualify` (and `glob`) result for one name string (see `Interp::names`).
pub(super) struct NameMemo {
	/// Long names use an address key and need content validation; short keys contain the entire name.
	name: Option<Rc<str>>,
	/// Package the name was qualified in; None when the result does not depend on it.
	package: Option<Rc<str>>,
	qualified: Rc<str>,
	/// The glob, valid while `Interp::symbol_generation` is unchanged.
	glob: Option<(u64, Gv)>,
}

/// Bound on `Interp::names` (dynamically built names would otherwise accumulate).
const NAME_MEMO_LIMIT: usize = 8192;

pub(super) enum Restore {
	Scalar(Gv, Sv), Array(Gv, Av), Hash(Gv, Hv), Code(Gv, Option<Cv>),
	Glob(Rc<str>, Gv), ArrayElem(Av, usize, Option<Sv>, usize), HashElem(Hv, HKey, Option<Sv>),
	Magic(Sv, Value), Args(usize, Av), Topic(usize, Sv), LastRead(Option<Io>, Option<i64>, Value),
	TiedElement(Value, Value, Option<Value>),
}

/// Whether a dereferenced expression yields a container that autovivification can fill: a scalar variable,
/// element or declaration, possibly as the result of a comma list, `?:` or a `do`-style block (`${ (), $$s }[0] = 1`).
fn vivifiable(e: &Expr) -> bool {
	match &ungroup(e).kind {
		ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) | ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _)
		| ExprKind::Declare(..) => true,
		ExprKind::List(items) => items.last().is_some_and(vivifiable),
		ExprKind::Conditional(_, yes, no) => vivifiable(yes) && vivifiable(no),
		ExprKind::Block(block, false) => matches!(block.stmts.last(), Some(Stmt { kind: StmtKind::Expr(e), .. }) if vivifiable(e)),
		_ => false,
	}
}

pub(super) enum Target<'e> { Scalar(Sv), Array(Av), Hash(Hv), Glob(Gv), LastIndex(Av), Builtin(Builtin, &'e Call), Alias(RefTarget), Skip }

#[derive(Clone)]
enum Element { Array(Av, i64), Hash(Hv, HKey) }

#[derive(Clone, Copy, PartialEq, Eq)]
enum CellAccess { Read, Write, Match }

/// Format an IV/UV exactly as Perl's decimal scalar string, without allocating a temporary key.
fn decimal_key(mut n: u64, negative: bool, buf: &mut [u8; 20]) -> &[u8] {
	let mut i = buf.len();
	loop {
		i -= 1;
		buf[i] = b'0' + (n % 10) as u8;
		n /= 10;
		if n == 0 { break; }
	}
	if negative { i -= 1; buf[i] = b'-'; }
	&buf[i..]
}

/// Lookup in a plain, unrestricted hash. The map takes ownership of the key bytes only on insertion.
fn byte_hash_cell(h: &Hv, bytes: &[u8], utf8: bool, create: bool) -> Option<Option<Sv>> {
	use indexmap::map::raw_entry_v1::{RawEntryApiV1, RawEntryMut};
	use std::hash::BuildHasher;

	let key = value::HKeyRef::new(bytes, utf8)?;
	if !create { return Some(h.entries().get(&key).cloned()); }
	let mut entries = h.entries_mut();
	let hash = entries.hasher().hash_one(&key);
	Some(Some(match entries.raw_entry_mut_v1().from_key_hashed_nocheck(hash, &key) {
		RawEntryMut::Occupied(entry) => entry.get().clone(),
		RawEntryMut::Vacant(entry) => {
			let owned = HKey::from_pstr(PStr::new(bytes.to_vec(), utf8));
			entry.insert_hashed_nocheck(hash, owned, new_sv(Value::Undef)).1.clone()
		}
	}))
}


fn slot_sigil(sigil: Sigil) -> Sigil { if sigil == Sigil::LastIndex { Sigil::Array } else { sigil } }
fn split_glob(name: &str) -> (&str, &str) {
	last_separator(name.strip_suffix("::").unwrap_or(name)).map_or(("main", name), |at| (&name[..at], &name[at + 2..]))
}

/// Byte offset of the last `::` (names are short: a plain scan beats building a substring searcher).
fn last_separator(name: &str) -> Option<usize> {
	let bytes = name.as_bytes();
	(1..bytes.len()).rev().find(|&i| bytes[i] == b':' && bytes[i - 1] == b':').map(|i| i - 1)
}

/// Frequently accessed reserved main-package symbols. Both the bare and qualified spellings are invariant.
const SPECIAL_NAMES: &[&str] = &["main::_", "main::/", "main::.", "main::|", "main::,", "main::\\", "main::\"", "main::;",
	"main::ARGV", "main::0", "main::@", "main::!", "main::^W", "main::?", "main::^T"];
pub(super) const SPECIAL_GLOBS: usize = SPECIAL_NAMES.len();

#[derive(Default)]
pub(super) struct SpecialMemo {
	name: Option<Rc<str>>,
	// A missing symbol is cached too (notably the usually-unset $,).
	glob: Option<(u64, Option<Gv>)>,
}

#[inline]
fn special_index(name: &str) -> Option<usize> {
	special_tail(name.as_bytes().strip_prefix(b"main::")?)
}

#[inline]
fn special_tail(name: &[u8]) -> Option<usize> {
	Some(match name {
		b"_" => 0, b"/" => 1, b"." => 2, b"|" => 3, b"," => 4, b"\\" => 5, b"\"" => 6, b";" => 7, b"ARGV" => 8, b"0" => 9,
		b"@" => 10, b"!" => 11, b"^W" => 12, b"?" => 13, b"^T" => 14, _ => return None,
	})
}

#[inline]
fn symbol_special(name: &str) -> Option<usize> {
	if name.len() <= 4 { special_tail(name.as_bytes()) } else { special_index(name) }
}

#[inline]
fn name_key(name: &str) -> (usize, usize) {
	let key = match name.as_bytes() {
		[] => 0,
		&[a] => a.into(),
		&[a, b] => u16::from_ne_bytes([a, b]).into(),
		&[a, b, c] => u32::from_ne_bytes([a, b, c, 0]) as usize,
		_ => name.as_ptr() as usize,
	};
	(key, name.len())
}

/// Whether a symbol name contains a package separator.
pub(super) fn has_separator(name: &str) -> bool { name.as_bytes().windows(2).any(|w| w == b"::") }

pub(super) fn forced_main(name: &str) -> bool {
	matches!(name, "STDIN" | "STDOUT" | "STDERR" | "ARGV" | "ARGVOUT" | "ENV" | "INC" | "SIG" | "_")
		|| name.as_bytes().first().is_some_and(|&b| b.is_ascii_digit() || !(b.is_ascii_alphabetic() || b == b'_' || b >= 128))
}

#[inline]
fn plain_lower_name(name: &str) -> bool {
	name.as_bytes().first().is_some_and(u8::is_ascii_lowercase) && !has_separator(name)
}

fn formatted(name: &str) -> bool { matches!(name, "~" | "^" | "=" | "-" | "%") }

impl Interp<'_> {
	/// The currently executing package (the call site while executing a native sub).
	pub fn package(&self) -> Rc<str> { self.package.clone() }

	/// Qualify a symbol relative to the current package and Perl's reserved names.
	pub fn qualify(&self, name: &str) -> Rc<str> {
		if let Some(i) = symbol_special(name) {
			return self.special_globs.borrow_mut()[i].name.get_or_insert_with(|| Rc::from(SPECIAL_NAMES[i])).clone();
		}
		let key = name_key(name);
		if let Some(memo) = self.names.borrow().get(&key) && self.memo_matches(memo, name) { return memo.qualified.clone(); }
		let qualified = self.qualify_uncached(name);
		let mut names = self.names.borrow_mut();
		if names.len() >= NAME_MEMO_LIMIT { names.clear(); }
		let copy = (name.len() > 3).then(|| if *qualified == *name { qualified.clone() } else { Rc::from(name) });
		let package = (!has_separator(name) && !forced_main(name)).then(|| self.package.clone());
		names.insert(key, NameMemo { name: copy, package, qualified: qualified.clone(), glob: None });
		qualified
	}

	/// The memoized glob of `name`, while still valid (see `glob`).
	#[inline]
	fn memo_glob(&self, name: &str) -> Option<Gv> {
		if let Some(i) = symbol_special(name) {
			let specials = self.special_globs.borrow();
			let (generation, gv) = specials[i].glob.as_ref()?;
			return if *generation == self.symbol_generation { gv.clone() } else { None };
		}
		let names = self.names.borrow();
		let memo = names.get(&name_key(name))?;
		let (generation, gv) = memo.glob.as_ref()?;
		(*generation == self.symbol_generation && self.memo_matches(memo, name)).then(|| gv.clone())
	}

	#[inline]
	fn with_existing_special<T>(&self, i: usize, f: impl FnOnce(Option<&Gv>) -> T) -> T {
		let specials = self.special_globs.borrow();
		if let Some((generation, gv)) = &specials[i].glob && *generation == self.symbol_generation {
			return f(gv.as_ref());
		}
		drop(specials);
		let gv = self.symbols.get(SPECIAL_NAMES[i]);
		if !self.exposed_stashes.contains("main") {
			self.special_globs.borrow_mut()[i].glob = Some((self.symbol_generation, gv.cloned()));
		}
		f(gv)
	}

	/// Read an interpreter-maintained special without cloning its glob or scalar handle. The callback
	/// must not re-enter symbol lookup while the cache or scalar slot is borrowed.
	#[inline]
	pub(in crate::perl) fn with_special_scalar<T>(&self, qualified: &str, f: impl FnOnce(Option<&Sv>) -> T) -> T {
		if let Some(i) = special_index(qualified) {
			self.with_existing_special(i, |gv| match gv {
				Some(gv) => f(Some(&gv.scalar.borrow())),
				None => f(None),
			})
		} else {
			match self.existing_glob(qualified) {
				Some(gv) => f(Some(&gv.scalar.borrow())),
				None => f(None),
			}
		}
	}

	/// An existing glob (no creation), through the memo when possible.
	pub(super) fn existing_glob(&self, qualified: &str) -> Option<Gv> {
		if let Some(i) = special_index(qualified) { return self.with_existing_special(i, |gv| gv.cloned()); }
		if let Some(gv) = self.memo_glob(qualified) { return Some(gv); }
		let gv = self.symbols.get(qualified)?.clone();
		let full = self.qualify(qualified);
		if *full == *qualified { self.remember_glob(qualified, &full, &gv); }
		Some(gv)
	}

	/// Memoize `gv` as the glob `name` (qualified as `full`) currently resolves to; globs of stashes Perl code can
	/// edit directly (`%Pkg::`) are not memoized.
	fn remember_glob(&self, name: &str, full: &str, gv: &Gv) {
		if self.exposed_stashes.contains(split_glob(full).0) { return; }
		let generation = self.symbol_generation;
		if let Some(i) = symbol_special(name) {
			self.special_globs.borrow_mut()[i].glob = Some((generation, Some(gv.clone())));
			return;
		}
		if let Some(memo) = self.names.borrow_mut().get_mut(&name_key(name)) && self.memo_matches(memo, name) {
			memo.glob = Some((generation, gv.clone()));
		}
	}

	fn memo_matches(&self, memo: &NameMemo, name: &str) -> bool {
		memo.name.as_ref().is_none_or(|n| n.as_ptr() == name.as_ptr() || **n == *name)
			&& memo.package.as_ref().is_none_or(|p| Rc::ptr_eq(p, &self.package) || **p == *self.package)
	}

	/// Invalidate memoized globs after a symbol-table change.
	fn symbols_changed(&mut self) { self.symbol_generation = self.symbol_generation.wrapping_add(1); }

	fn qualify_uncached(&self, name: &str) -> Rc<str> {
		if let Some(tail) = name.strip_prefix("::") {
			return if has_separator(tail) { Rc::from(tail) } else { Rc::from(format!("main::{tail}")) };
		}
		if let Some(tail) = name.strip_prefix("main::") && has_separator(tail) { return Rc::from(tail); }
		if has_separator(name) { return Rc::from(name); }
		let pkg = if forced_main(name) { "main" } else { self.package.as_ref() };
		Rc::from(format!("{pkg}::{name}"))
	}

	pub(super) fn stash(&mut self, pkg: &str) -> Hv {
		if let Some(h) = self.stashes.get(pkg) { return h.clone(); }
		// Register parents before linking the child stash into its parent glob.
		let mut missing = vec![pkg];
		let mut parent = pkg;
		while parent != "main" {
			parent = last_separator(parent).map_or("main", |at| &parent[..at]);
			if self.stashes.contains_key(parent) { break; }
			missing.push(parent);
		}
		let mut stash = None;
		for pkg in missing.into_iter().rev() {
			let h = new_hv();
			self.stashes.insert(Rc::from(pkg), h.clone());
			self.symbols_changed();
			if pkg != "main" {
				let name = if has_separator(pkg) { format!("{pkg}::") } else { format!("main::{pkg}::") };
				self.glob(&name).hash.replace(h.clone());
			}
			stash = Some(h);
		}
		stash.unwrap_or_else(new_hv)
	}

	/// Find an existing symbol without creating a slot or a package.
	pub fn find_glob(&self, qualified: &str) -> Option<Gv> {
		if let Some(gv) = self.memo_glob(qualified) { return Some(gv); }
		let full = self.qualify(qualified);
		let gv = self.lookup_glob(&full)?;
		self.remember_glob(qualified, &full, &gv);
		Some(gv)
	}

	/// Check if a package currently has a live stash.
	pub fn has_package(&self, name: &str) -> bool { self.stashes.contains_key(name) }

	/// Snapshot the names of the current package stashes.
	pub fn package_names(&self) -> Vec<Rc<str>> { self.stashes.keys().cloned().collect() }

	/// Current method/ISA mutation generation for a package (0 when absent).
	pub fn package_generation(&self, name: &str) -> u64 {
		if self.has_package(name) { self.package_generations.get(name).copied().unwrap_or(1) } else { 0 }
	}

	/// Mark existing package method/ISA metadata as invalidated.
	pub fn mark_package_changed(&mut self, name: &str) -> bool {
		if !self.has_package(name) { return false; }
		let generation = self.package_generations.entry(Rc::from(name)).or_insert(1);
		*generation = generation.saturating_add(1);
		true
	}

	/// Call after modifying an array: when it is some package's @ISA, invalidates method resolution and dies
	/// "Recursive inheritance detected in package '...'" if the new hierarchy loops (as perl's ISA magic does).
	pub(in crate::perl) fn array_changed(&mut self, av: &Av) -> PResult<()> {
		if self.isa_globs.is_empty() { return Ok(()); }
		let packages: Vec<_> = self.isa_globs.iter().filter_map(std::rc::Weak::upgrade)
			.filter(|g| Rc::ptr_eq(av, &g.array.borrow()))
			.map(|g| g.pkg.clone()).collect();
		for package in &packages { self.mark_package_changed(package); }
		for package in packages {
			if let Err(message) = self.linear_isa(&package, "dfs") { return Err(self.die_msg(message)); }
		}
		Ok(())
	}

	pub(super) fn lookup_glob(&self, qualified: &str) -> Option<Gv> {
		let (pkg, name) = split_glob(qualified);
		if !self.exposed_stashes.contains(pkg) { return self.symbols.get(qualified).cloned(); }
		self.stashes.get(pkg)?.entries().get(&hash_key(name)).and_then(|sv| {
			match &sv.get() { Value::Glob(g) | Value::Ref(Ref::Glob(g)) => Some(g.clone()), _ => None }
		})
	}

	/// The code slot for a qualified name, promoting a non-glob stash element first (`upgrade_stash_entry`).
	pub(super) fn lookup_code(&self, qualified: &str) -> Option<Cv> {
		if let Some(g) = self.lookup_glob(qualified) { return g.code.borrow().clone(); }
		self.upgrade_stash_entry(qualified).and_then(|g| g.code.borrow().clone())
	}

	/// gv_init: a stash element that is not a glob yet becomes one holding a sub: a code ref is that sub
	/// (`${Pkg::}{name} = sub {...}`), a scalar ref a constant sub (`$::{z} = \undef`), a string the
	/// prototype of a declared stub (`$::{f} = "pie"`; "-1" means no prototype).
	fn upgrade_stash_entry(&self, qualified: &str) -> Option<Gv> {
		let (pkg, name) = split_glob(qualified);
		let stash = self.stashes.get(pkg)?;
		let value = stash.entries().get(&hash_key(name))?.get();
		let sub = |prototype: Option<PStr>, body: CodeImpl| Rc::new(CodeBody { name: RefCell::new(Some(Rc::from(qualified))), pkg: Rc::from(pkg),
			prototype: RefCell::new(prototype), body: RefCell::new(body), blessed: RefCell::new(None) });
		let cv = match value {
			Value::Ref(Ref::Code(c)) => c,
			Value::Ref(Ref::Scalar(sv)) => sub(Some(PStr::default()), CodeImpl::Constant(Rc::from([sv.get()]))),
			Value::Str(s) => sub((s.bytes != b"-1").then_some(s), CodeImpl::Undefined),
			_ => return None,
		};
		let gv = new_gv(Rc::from(pkg), Rc::from(name));
		gv.code.replace(Some(cv));
		stash.entries_mut().insert(hash_key(name), new_sv(Value::Glob(gv.clone())));
		Some(gv)
	}

	/// Fetch or create a glob and its package's visible stash entry.
	pub fn glob(&mut self, qualified: &str) -> Gv {
		if let Some(gv) = self.memo_glob(qualified) { return gv; }
		let full = self.qualify(qualified);
		let gv = self.glob_uncached(full.clone());
		self.remember_glob(qualified, &full, &gv);
		gv
	}

	fn glob_uncached(&mut self, qualified: Rc<str>) -> Gv {
		if let Some(g) = self.lookup_glob(&qualified) { return g; }
		let (pkg, name) = split_glob(&qualified);
		let stash = self.stash(pkg);
		let key = hash_key(name);
		if let Some(Value::Glob(g)) = stash.entries().get(&key).map(read_sv) {
			self.symbols.insert(qualified.clone(), g.clone());
			self.symbols_changed();
			return g;
		}
		if let Some(g) = self.upgrade_stash_entry(&qualified) {
			self.symbols.insert(qualified.clone(), g.clone());
			self.symbols_changed();
			return g;
		}
		let g = new_gv(Rc::from(pkg), Rc::from(name));
		if name == "ISA" { self.isa_globs.push(Rc::downgrade(&g)); }
		self.symbols.insert(qualified.clone(), g.clone());
		self.symbols_changed();
		stash.entries_mut().insert(key, new_sv(Value::Glob(g.clone())));
		g
	}

	/// Drop the entries of a package, preserving references to its previous values.
	pub fn remove_package(&mut self, pkg: &str) {
		let prefix = format!("{pkg}::");
		self.symbols.retain(|name, _| !name.starts_with(&prefix));
		self.stashes.retain(|name, _| name.as_ref() != pkg && !name.starts_with(&prefix));
		self.symbols_changed();
		self.package_generations.retain(|name, _| name.as_ref() != pkg && !name.starts_with(&prefix));
		if let Some(at) = last_separator(pkg) {
			let (parent, name) = (&pkg[..at], &pkg[at + 2..]);
			if let Some(h) = self.stashes.get(parent) { h.entries_mut().shift_remove(&hash_key(&format!("{name}::"))); }
		} else if let Some(h) = self.stashes.get("main") {
			h.entries_mut().shift_remove(&hash_key(&prefix));
		}
	}

	/// Package glob snapshot for operations such as `reset`.
	pub fn package_globs(&self, pkg: &str) -> Vec<Gv> {
		self.stashes.get(pkg).map_or_else(Vec::new, |stash| stash.entries().values().filter_map(|sv| {
			match &sv.get() { Value::Glob(g) | Value::Ref(Ref::Glob(g)) => Some(g.clone()), _ => None }
		}).collect())
	}

	/// Fetch the scalar slot of the given package symbol.
	pub fn sv(&mut self, qualified: &str) -> Sv {
		// Reserved punctuation names are never `English` aliases. Borrow the cached glob
		// directly, but always resolve its current scalar slot (it may have been localized).
		if let Some(i) = symbol_special(qualified) {
			if let Some((generation, Some(gv))) = &self.special_globs.borrow()[i].glob
				&& *generation == self.symbol_generation { return gv.scalar.borrow().clone(); }
			return self.glob(qualified).scalar.borrow().clone();
		}
		if plain_lower_name(qualified) && !self.package.starts_with("main::") && !self.package.starts_with("::") {
			return self.glob(qualified).scalar.borrow().clone();
		}
		let full = self.qualify(qualified);
		if let Some(alias) = modules::english_alias(self, &full) { return self.glob(alias).scalar.borrow().clone(); }
		if let Some(gv) = self.memo_glob(qualified) { return gv.scalar.borrow().clone(); }
		let gv = self.glob(&full);
		self.remember_glob(qualified, &full, &gv);
		let sv = gv.scalar.borrow().clone();
		sv
	}
	/// Fetch the array slot of the given package symbol.
	pub fn av(&mut self, qualified: &str) -> Av { self.glob(qualified).array.borrow().clone() }
	/// Fetch the hash slot of the given package symbol, including package stashes.
	pub fn hv(&mut self, qualified: &str) -> Hv {
		// Unqualified identifiers (the usual hash subscript) cannot name a package stash.
		if !qualified.is_empty() && !has_separator(qualified) && !self.package.starts_with("main::") && !self.package.starts_with("::") {
			return self.glob(qualified).hash.borrow().clone();
		}
		let name = self.qualify(qualified);
		if let Some(pkg) = name.strip_suffix("::") {
			let pkg = if pkg.is_empty() { "main" } else { pkg };
			if self.exposed_stashes.insert(Rc::from(pkg)) { self.symbols_changed(); }
			return self.stash(pkg);
		}
		self.glob(&name).hash.borrow().clone()
	}

	pub(super) fn pad_snapshot(&self) -> Pad {
		self.scopes.iter().flat_map(|s| s.pad.iter().cloned()).collect()
	}

	pub(super) fn compile_overlay(&self) -> Pad {
		self.compile_pads[self.compile_pad_base..].iter().flat_map(|pad| pad.iter().cloned()).collect()
	}

	pub(super) fn compile_pad_snapshot(&self) -> Pad {
		let mut pad = self.pad_snapshot();
		pad.extend(self.compile_overlay());
		pad
	}

	pub(super) fn lexical_decl(&mut self, decl: &Expr, package: &str) {
		let ExprKind::Declare(kind, _, target, _) = &decl.kind else { return; };
		if *kind == DeclKind::Local { return; }
		self.predeclare(*kind, target, package);
	}

	fn predeclare(&mut self, kind: DeclKind, e: &Expr, package: &str) {
		match &ungroup(e).kind {
			ExprKind::List(items) => for e in items { self.predeclare(kind, e, package); },
			ExprKind::Unary(Unary::Reference, e) => self.predeclare(kind, e, package),
			ExprKind::Variable(sigil, name) => {
				let slot = self.fresh_binding(kind, *sigil, name, package);
				self.declared_slots.insert(Rc::as_ptr(name) as *const () as usize, (name.clone(), slot.clone()));
				if let Some(pad) = self.compile_pads.last_mut() { pad.push((slot_sigil(*sigil), name.clone(), slot)); }
			}
			_ => {}
		}
	}

	fn fresh_binding(&self, kind: DeclKind, sigil: Sigil, name: &Rc<str>, package: &str) -> Slot {
		let qualified = || if has_separator(name) { name.clone() } else {
			let package = if forced_main(name) { "main" } else { package };
			Rc::from(format!("{package}::{name}"))
		};
		if kind == DeclKind::Our { return Slot::Our(qualified()); }
		match sigil {
			Sigil::Scalar => Slot::Scalar(new_sv(Value::Undef)),
			Sigil::Array | Sigil::LastIndex => Slot::Array(new_av(Vec::new())),
			Sigil::Hash => Slot::Hash(new_hv()),
			Sigil::Code => Slot::Code(Rc::new(CodeBody { name: RefCell::new(Some(qualified())), pkg: Rc::from(package),
				prototype: RefCell::new(None), body: RefCell::new(CodeImpl::Undefined), blessed: RefCell::new(None) })),
			Sigil::Glob => Slot::Glob(new_gv(Rc::from(package), name.clone())),
		}
	}

	pub(super) fn capture_pad(&self, block: Option<&Block>) -> Pad {
		let Some(block) = block else { return Pad::new(); };
		let Some(ids) = self.captures.get(&(block as *const Block as usize)) else { return self.pad_snapshot(); };
		// Capture only actual free variables, not every binding in every scope.
		// Preserve the old newest-first order (including eventual cell release order).
		let mut locations: Vec<_> = ids.iter().filter_map(|&id| {
			let loc = self.lexicals.visible[id];
			(loc.frame == self.lexicals.frame).then_some((loc.scope, loc.offset))
		}).collect();
		locations.sort_unstable_by(|a, b| b.cmp(a));
		locations.into_iter().map(|(scope, offset)| {
			let (sigil, name, slot) = &self.scopes[scope].pad[offset];
			let slot = match slot {
				Slot::Scalar(sv) if sv.registered() && self.readonly_literals.contains_key(&(Rc::as_ptr(sv) as usize)) => Slot::Scalar(new_sv(sv.get())),
				other => other.clone(),
			};
			(*sigil, name.clone(), slot)
		}).collect()
	}

	/// Switch to a sub's own scope stack, starting from its captured pad; returns the caller's stack for
	/// `leave_pad`. Stacks and scopes are recycled across calls.
	pub(super) fn enter_pad(&mut self, pad: &Pad) -> Vec<Scope> {
		let stack = self.scope_stacks.pop().unwrap_or_default();
		let outer = std::mem::replace(&mut self.scopes, stack);
		self.lexicals.frame += 1;
		self.push_scope();
		for (sigil, name, slot) in pad { self.put_pad(*sigil, name.clone(), slot.clone()); }
		outer
	}

	/// Restore the caller's scope stack after `enter_pad`, discarding the sub's remaining scopes.
	pub(super) fn leave_pad(&mut self, outer: Vec<Scope>) {
		let mut inner = std::mem::replace(&mut self.scopes, outer);
		if let Some(base) = inner.first() { self.lexicals.unwind(base.lexical_mark); }
		self.lexicals.frame -= 1;
		for mut scope in inner.drain(..) {
			scope.pad.clear();
			scope.declarations.clear();
			scope.undo.clear();
			if self.scope_pool.len() < 64 { self.scope_pool.push(scope); }
		}
		if self.scope_stacks.len() < 64 { self.scope_stacks.push(inner); }
	}

	pub(super) fn push_scope(&mut self) {
		let mut scope = self.scope_pool.pop().unwrap_or_default();
		scope.lexical_mark = self.lexicals.undo.len();
		self.scopes.push(scope);
	}

	pub(super) fn pop_scope(&mut self) {
		let Some(mut scope) = self.scopes.pop() else { return };
		self.lexicals.unwind(scope.lexical_mark);
		while let Some(restore) = scope.undo.pop() { self.apply_restore(restore); }
		scope.pad.clear();
		scope.declarations.clear();
		// Keep the emptied vectors for the next block (loop bodies enter a scope per iteration).
		if self.scope_pool.len() < 64 { self.scope_pool.push(scope); }
	}

	/// Number of `local` restores pending in the innermost scope (a mark for `unwind_locals`).
	pub(super) fn locals_mark(&self) -> usize { self.scopes.last().map_or(0, |scope| scope.undo.len()) }

	/// Undo the innermost scope's `local`s made since `mark`, keeping its lexicals (a loop body's locals end
	/// before its `continue` block, which still sees the body's `my` variables).
	pub(super) fn unwind_locals(&mut self, mark: usize) {
		let Some(scope) = self.scopes.last_mut() else { return };
		if scope.undo.len() <= mark { return; }
		let restores = scope.undo.split_off(mark);
		for restore in restores.into_iter().rev() { self.apply_restore(restore); }
	}

	fn apply_restore(&mut self, restore: Restore) {
			match restore {
				Restore::Scalar(g, old) => { g.scalar.replace(old); }
				Restore::Array(g, old) => { g.array.replace(old); }
				Restore::Hash(g, old) => { g.hash.replace(old); }
				Restore::Code(g, old) => { g.code.replace(old); }
				Restore::Glob(name, old) => {
					let current = self.symbols.get(&name).and_then(|g| g.io.borrow().clone());
					if let (Some(current), Some(original)) = (current, old.io.borrow().clone())
						&& Rc::ptr_eq(&current, &self.selected()) {
						self.set_selected(original);
					}
					let key = hash_key(&old.name);
					self.stash(&old.pkg).entries_mut().insert(key, new_sv(Value::Glob(old.clone())));
					self.symbols.insert(name, old);
					self.symbols_changed();
				}
				Restore::ArrayElem(a, i, old, old_len) => {
					let mut elems = a.elems_mut();
					if let Some(old) = old {
						if i >= elems.len() { elems.resize(i + 1, self.hole.clone()); }
						elems[i] = old;
					} else if i < elems.len() {
						elems[i] = self.hole.clone();
						while elems.len() > old_len && elems.last().is_some_and(|s| Rc::ptr_eq(s, &self.hole)) { elems.pop(); }
					}
				}
				Restore::HashElem(h, key, old) => match old {
					Some(sv) => { h.entries_mut().insert(key, sv); }
					None => { h.entries_mut().shift_remove(&key); }
				},
				Restore::Magic(sv, old) => if let Err(flow) = self.write_sv(&sv, old) { self.defer(flow); },
				Restore::Args(index, original) => {
					if let Some((_, av, _)) = self.active_subs.get_mut(index) { *av = original; }
				}
				Restore::Topic(index, original) => {
					if let Some(topic) = self.topics.get_mut(index) { *topic = original; }
				}
				Restore::LastRead(io, line, value) => {
					if let (Some(io), Some(line)) = (&io, line) { io.borrow_mut().set_line_no(line as u64); }
					self.last_read = io;
					self.line_seen.set(line.unwrap_or(0));
					self.sv("main::.").set(value);
				}
				Restore::TiedElement(object, key, old) => {
					let result = if let Some(old) = old { self.call_method(object, "STORE", vec![key, old], Cx::Void) }
					else { self.call_method(object, "DELETE", vec![key], Cx::Void) };
					if let Err(flow) = result { self.defer(flow); }
				}
			}
	}

	fn add_restore(&mut self, restore: Restore) {
		if let Some(scope) = self.scopes.last_mut() { scope.undo.push(restore); }
	}

	#[inline]
	pub(super) fn commit_declarations(&mut self) {
		let depth = self.scopes.len();
		let Some(scope) = self.scopes.last_mut() else { return };
		if scope.declarations.is_empty() { return; }
		let offset = scope.pad.len();
		for (i, (sigil, name, _)) in scope.declarations.iter().enumerate() {
			let id = self.lexicals.resolve(*sigil, name);
			self.lexicals.install(id, depth - 1, offset + i);
		}
		scope.pad.append(&mut scope.declarations);
	}

	fn introduce_declarations(&mut self, kind: DeclKind, bindings: Pad) {
		if kind == DeclKind::Our { self.extend_pad(bindings); }
		else if let Some(scope) = self.scopes.last_mut() { scope.declarations.extend(bindings); }
	}

	pub(super) fn extend_pad(&mut self, bindings: Pad) {
		for (sigil, name, slot) in bindings { self.put_pad(sigil, name, slot); }
	}

	pub(super) fn put_pad(&mut self, sigil: Sigil, name: Rc<str>, slot: Slot) {
		let id = self.lexicals.resolve(sigil, &name);
		self.put_resolved_pad(id, sigil, name, slot);
	}

	#[inline]
	pub(super) fn put_resolved_pad(&mut self, id: usize, sigil: Sigil, name: Rc<str>, slot: Slot) {
		let depth = self.scopes.len();
		if let Some(scope) = self.scopes.last_mut() {
			self.lexicals.install(id, depth - 1, scope.pad.len());
			scope.pad.push((slot_sigil(sigil), name, slot));
		}
	}

	/// Temporarily publish a foreach lexical in the loop scope for a no-callback numeric
	/// statement. A failed probe performs no write and the normal iteration starts afresh.
	pub(super) fn try_numeric_iteration(&mut self, id: usize, name: &Rc<str>, alias: &Sv, e: &Expr) -> bool {
		let depth = self.scopes.len();
		let Some(scope) = self.scopes.last_mut() else { return false; };
		let offset = scope.pad.len();
		scope.pad.push((Sigil::Scalar, name.clone(), Slot::Scalar(alias.clone())));
		let old = std::mem::replace(&mut self.lexicals.visible[id], PadLocation { frame: self.lexicals.frame, scope: depth - 1, offset });
		let ran = self.try_plain_binary(e, Cx::Void).is_some();
		self.lexicals.visible[id] = old;
		self.scopes[depth - 1].pad.pop();
		ran
	}

	pub(super) fn lookup_pad(&self, sigil: Sigil, name: &str) -> Option<Slot> { self.pad_slot(sigil, name).cloned() }

	/// The innermost visible lexical binding of `name`, borrowed.
	#[inline]
	pub(super) fn pad_slot(&self, sigil: Sigil, name: &str) -> Option<&Slot> {
		let (scope, offset) = self.pad_position(sigil, name)?;
		Some(&self.scopes[scope].pad[offset].2)
	}

	/// Physical location of a visible binding, for replacing a pad cell by refalias.
	#[inline]
	pub(super) fn pad_position(&self, sigil: Sigil, name: &str) -> Option<(usize, usize)> {
		if let Some(id) = self.lexicals.operand(sigil, name) {
			let loc = self.lexicals.visible[id];
			return (loc.frame == self.lexicals.frame).then_some((loc.scope, loc.offset));
		}
		let sigil = slot_sigil(sigil);
		self.scopes.iter().enumerate().rev().find_map(|(scope, s)| {
			s.pad.iter().rposition(|(s, n, _)| *s == sigil && n.as_ref() == name).map(|offset| (scope, offset))
		})
	}

	pub(super) fn variable_slot(&mut self, sigil: Sigil, name: &str) -> PResult<Slot> {
		match self.lookup_pad(sigil, name) {
			Some(Slot::Our(qualified)) => Ok(self.package_slot(sigil, &qualified)),
			Some(slot) => Ok(slot),
			// `goto` can skip the declaration: the still-unbound operand names a global.
			None if name.starts_with("::") || name.starts_with("main::") => {
				let qualified = self.qualify(name);
				Ok(self.package_slot(sigil, &qualified))
			}
			None => Ok(self.package_slot(sigil, name)),
		}
	}

	/// `&$name` in the strict-refs-exempt positions (`\&$name`, `defined &$name`, `exists &$name`, `goto &$name`):
	/// the code slot named by a string, a glob's code slot, or a code reference. `vivify` creates a stub (`\&$name`).
	pub(super) fn exempt_code(&mut self, source: &Expr, vivify: bool) -> PResult<Option<Cv>> {
		let v = self.eval_scalar(source)?;
		self.exempt_code_value(v, vivify)
	}

	/// `exempt_code` on an already evaluated operand.
	pub(super) fn exempt_code_value(&mut self, v: Value, vivify: bool) -> PResult<Option<Cv>> {
		let v = self.overload_deref(Sigil::Code, v)?;
		Ok(match &v {
			Value::Ref(Ref::Code(c)) => Some(c.clone()),
			Value::Ref(Ref::Glob(g)) | Value::Glob(g) => if vivify { Some(self.code_slot(g)) } else { g.code.borrow().clone() },
			Value::Ref(_) => return Err(self.die_msg("Not a CODE reference")),
			Value::Undef => return Err(self.die_msg("Can't use an undefined value as a subroutine reference")),
			_ => {
				let name = self.qualify(&v.to_pstr().to_string_lossy());
				if vivify { if let Slot::Code(c) = self.package_slot(Sigil::Code, &name) { Some(c) } else { None } }
				else { self.named_code(&name) }
			}
		})
	}

	fn package_slot(&mut self, sigil: Sigil, name: &str) -> Slot {
		match slot_sigil(sigil) {
			Sigil::Scalar if matches!(name, "_" | "main::_") => Slot::Scalar(self.topic()),
			Sigil::Array if matches!(name, "_" | "main::_") && let Some((_, av, _)) = self.active_subs.last() => Slot::Array(av.clone()),
			Sigil::Scalar => Slot::Scalar(self.sv(name)),
			Sigil::Array | Sigil::LastIndex => Slot::Array(self.av(name)),
			Sigil::Hash => Slot::Hash(self.hv(name)),
			Sigil::Glob => Slot::Glob(self.glob(name)),
			Sigil::Code => {
				let gv = self.glob(name);
				Slot::Code(self.code_slot(&gv))
			}
		}
	}

	/// Current topic; a foreach, map, grep or given can temporarily alias it.
	pub fn topic(&mut self) -> Sv { self.topics.last().cloned().unwrap_or_else(|| self.sv("main::_")) }

	/// Run with a dynamically scoped topic alias.
	pub fn with_topic<T>(&mut self, sv: Sv, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		self.topics.push(sv);
		let result = f(self);
		self.topics.pop();
		result
	}

	/// The implicit argument array for shift/pop.
	pub fn default_array(&mut self) -> Av {
		self.active_subs.last().map(|(_, av, _)| av.clone()).unwrap_or_else(|| self.av("main::ARGV"))
	}

	pub(super) fn foreach_alias<T>(&mut self, variable: Option<&Expr>, alias: Sv, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		let Some(variable) = variable else { return self.with_topic(alias, f); };
		// `for my \$x (...)` (declared_refs): a fresh lexical bound to each referent.
		if let ExprKind::Declare(DeclKind::My | DeclKind::State, _, inner, _) = &ungroup(variable).kind
			&& let ExprKind::Unary(Unary::Reference, dst) = &ungroup(inner).kind
			&& let ExprKind::Variable(sigil, name) = &ungroup(dst).kind {
			let value = self.read_sv(&alias)?;
			let slot = self.ref_value(*sigil, value)?;
			self.put_pad(*sigil, name.clone(), slot);
			return f(self);
		}
		if let ExprKind::Unary(Unary::Reference, target) = &ungroup(variable).kind {
			let value = self.read_sv(&alias)?;
			let target = ungroup(target);
			if let ExprKind::Declare(kind @ (DeclKind::My | DeclKind::State), _, dst, _) = &target.kind
				&& let ExprKind::Variable(sigil, name) = &ungroup(dst).kind {
				let slot = self.ref_value(*sigil, value)?;
				self.put_pad(*sigil, name.clone(), slot);
				let _ = kind;
				return f(self);
			}
			if let ExprKind::Variable(sigil, name) = &target.kind {
				let bound = self.ref_value(*sigil, value)?;
				if self.lookup_pad(*sigil, name).is_some_and(|slot| !matches!(slot, Slot::Our(_))) {
					self.put_pad(*sigil, name.clone(), bound);
				} else {
					let qualified = if let Some(Slot::Our(q)) = self.lookup_pad(*sigil, name) { q } else { self.qualify(name) };
					let gv = self.glob(&qualified);
					match bound {
						Slot::Scalar(sv) if name.as_ref() == "_" => return self.with_topic(sv, f),
						Slot::Scalar(sv) => { let old = gv.scalar.replace(sv); self.add_restore(Restore::Scalar(gv, old)); }
						Slot::Array(av) => { let old = gv.array.replace(av); self.add_restore(Restore::Array(gv, old)); }
						Slot::Hash(hv) => { let old = gv.hash.replace(hv); self.add_restore(Restore::Hash(gv, old)); }
						Slot::Code(cv) => { let old = gv.code.replace(Some(cv)); self.add_restore(Restore::Code(gv, old)); }
						_ => return Err(self.die_msg("Can't modify reference constructor in foreach loop")),
					}
				}
				return f(self);
			}
			return Err(self.die_msg("Can't modify reference constructor in foreach loop"));
		}
		let target = if let ExprKind::Declare(kind, _, target, _) = &variable.kind {
			if matches!(kind, DeclKind::My | DeclKind::State) {
				if let ExprKind::Variable(Sigil::Scalar, name) = &ungroup(target).kind {
					self.put_pad(Sigil::Scalar, name.clone(), Slot::Scalar(alias));
					return f(self);
				}
			} else if *kind == DeclKind::Our {
				if let ExprKind::Variable(Sigil::Scalar, name) = &ungroup(target).kind { self.put_pad(Sigil::Scalar, name.clone(), Slot::Our(self.qualify(name))); }
			}
			target
		} else { variable };
		if let ExprKind::Variable(Sigil::Scalar, name) = &ungroup(target).kind {
			if name.as_ref() == "_" || name.as_ref() == "main::_" { return self.with_topic(alias, f); }
			match self.lookup_pad(Sigil::Scalar, name) {
				Some(Slot::Scalar(_)) => self.put_pad(Sigil::Scalar, name.clone(), Slot::Scalar(alias)),
				slot => {
					// Validate the declaration before temporarily replacing the package slot.
					self.variable_slot(Sigil::Scalar, name)?;
					let qualified = if let Some(Slot::Our(name)) = slot { name } else { self.qualify(name) };
					let gv = self.glob(&qualified);
					let old = gv.scalar.replace(alias);
					self.add_restore(Restore::Scalar(gv, old));
				}
			}
			return f(self);
		}
		let sv = self.eval_lvalue(target)?;
		let value = self.read_sv(&alias)?;
		self.write_sv(&sv, value)?;
		let out = f(self);
		if out.is_ok() {
			let value = self.read_sv(&sv)?;
			self.write_sv(&alias, value)?;
		}
		out
	}

	pub(super) fn magic_scalar(&mut self, name: &str) -> Option<Value> {
		// Dynamic Perl scalars begin with punctuation or a digit. English synonyms are uppercase.
		if plain_lower_name(name) { return None; }
		let qual = self.qualify(name);
		let qual = modules::english_alias(self, &qual).map_or(qual.as_ref(), |alias| alias);
		let name = qual.strip_prefix("main::")?;
		if let Some(v) = rx::match_var(self, name) { return Some(v); }
		if formatted(name) { return Some(func::sys::format_var(self, name)); }
		match name {
			"^GLOBAL_PHASE" => Some(Value::str(self.phase)),
			"^S" if self.compile_depth != 0 => Some(Value::Undef),
			"^S" => Some(Value::Int(i64::from(self.frames.iter().any(|f| f.info.sub.as_deref() == Some("(eval)"))))),
			"^LAST_FH" => Some(self.last_read().map_or(Value::Undef, |io| Value::Ref(Ref::Io(io)))),
			"^OPEN" => self.active_hints.open_layers.as_ref().map(|(read, write)| {
				let mut s = read.clone(); s.push_bytes(b"\0"); s.push(write); Value::Str(s)
			}),
			"^H" => Some(Value::Int(self.active_hints.bitmask(self.active_subs.is_empty()))),
			"^WARNING_BITS" => Some(self.active_hints.warnings.packed().map_or(Value::Undef, Value::Str)),
			"." if self.last_read.is_none() => Some(self.special_value("main::.")),
			"." => {
				self.sync_line();
				let io = self.last_read.as_ref()?;
				Some(Value::Int(io.borrow().line_no() as i64))
			}
			"|" => {
				self.sync_selected();
				Some(Value::Int(i64::from(self.selected.borrow().autoflush())))
			}
			_ => None,
		}
	}

	/// Write a scalar cell and synchronize Perl's writable special variables.
	pub fn write_sv(&mut self, sv: &Sv, value: Value) -> PResult<()> {
		self.store_sv(sv, value).map(|_| ())
	}

	/// Whether a scalar slot is protected against ordinary Perl assignment.
	pub fn is_readonly_sv(&self, sv: &Sv) -> bool {
		// Both read-only registries hold a weak reference for the lifetime of their mark.
		Rc::weak_count(sv) != 0 && (sv.registered() && self.readonly_literals.contains_key(&(Rc::as_ptr(sv) as usize)) || modules::readonly_sv(self, sv))
	}

	fn store_sv(&mut self, sv: &Sv, value: Value) -> PResult<Option<Value>> {
		// Read-only marks and writable special registrations both retain a Weak. All other
		// scalar writes need only track a potential cycle, replace the value and clear pos.
		if Rc::weak_count(sv) == 0 && !sv.has_read_magic() {
			value::track_cell(sv, &value);
			sv.set(value);
			sv.set_pos(None);
			return Ok(None);
		}
		let address = Rc::as_ptr(sv) as usize;
		if self.is_readonly_sv(sv) {
			return Err(self.die_msg("Modification of a read-only value attempted"));
		}
		if let Some(lvalue) = sv.lvalue() { return self.write_lvalue(lvalue, value).map(Some); }
		if let Some(object) = self.scalar_tie(sv) {
			// mg_set: STORE receives the tied scalar itself, holding the new value, with its magic suspended.
			sv.set(value);
			sv.set_pos(None);
			self.with_tie_suspended(sv, |this| this.call_method_aliases(object, "STORE", vec![sv.clone()], Cx::Scalar))?;
			return Ok(None);
		}
		let magic = if !sv.registered() { None } else { self.magic_cells.get(&address).and_then(|(name, slot)| {
			(slot.strong_count() != 0).then_some(*name)
		}) };
		value::track_cell(sv, &value);
		match magic {
			Some("!" | "^E") => self.set_errno_code(value.to_i64() as i32),
			Some("[") if value.to_i64() != 0 => return Err(self.die_msg("Assigning non-zero to $[ is no longer possible")),
			Some(name) if formatted(name) => {
				func::sys::set_format_var(self, name, value.clone())?;
				sv.replace(value);
			}
			_ => { sv.replace(value); }
		}
		sv.set_pos(None);
		match magic {
			Some("|") => self.sync_selected(),
			Some(".") => self.sync_line(),
			Some("^I") => {
				let value = read_sv(sv);
				let ext = if value.is_undef() { None } else { Some(value.to_pstr().bytes) };
				if self.argv.ext != ext && self.argv.current.is_none() { self.argv.inplace = ext.as_deref().map(InPlace::new); }
				self.argv.ext = ext;
			}
			_ => {}
		}
		Ok(None)
	}

	fn readonly_scalar(&mut self, name: &str) -> bool {
		if plain_lower_name(name) { return false; }
		let qualified = self.qualify(name);
		let qualified = modules::english_alias(self, &qualified).map_or(qualified.as_ref(), |alias| alias);
		let Some(name) = qualified.strip_prefix("main::") else { return false };
		matches!(name, "^GLOBAL_PHASE" | "^LAST_FH" | "^V" | "]" | "^S" | "^TAINT" | "^UNICODE" | "^UTF8LOCALE") || rx::is_match_var(name) || (name.starts_with('{') && rx::match_var(self, name).is_some())
	}

	fn check_scalar_write(&mut self, name: &str) -> PResult<()> {
		if self.readonly_scalar(name) { return Err(self.die_msg("Modification of a read-only value attempted")); }
		Ok(())
	}

	fn symbolic(&mut self, sigil: Sigil, v: &Value) -> PResult<Slot> {
		let kind = match sigil { Sigil::Array | Sigil::LastIndex => "an ARRAY", Sigil::Hash => "a HASH", Sigil::Code => "a subroutine", Sigil::Glob => "a symbol", _ => "a SCALAR" };
		if v.is_undef() { return Err(self.die_msg(format!("Can't use an undefined value as {kind} reference"))); }
		if self.active_hints.strict_refs {
			let s = v.to_pstr();
			let s = s.to_string_lossy();
			return Err(self.die_msg(format!("Can't use string (\"{s}\") as {kind} ref while \"strict refs\" in use")));
		}
		let name = v.to_pstr();
		let mut name = name.to_string_lossy().into_owned();
		// `${"\cX"}` is `${^X}`: a leading control character names the caret variable.
		if let Some(first) = name.bytes().next().filter(|b| (1..0x20).contains(b)) {
			name.replace_range(..1, &format!("^{}", char::from(first ^ 64)));
		}
		Ok(self.package_slot(sigil, &self.qualify(&name)))
	}

	fn deref(&mut self, sigil: Sigil, source: &Expr, vivify: bool) -> PResult<Slot> {
		let sigil = slot_sigil(sigil);
		let source = ungroup(source);
		let mut target = None;
		let v = if vivify && vivifiable(source) {
			let sv = self.eval_lvalue(source)?;
			let v = self.read_sv(&sv)?;
			target = Some(sv);
			v
		} else { self.eval_scalar(source)? };
		let v = self.overload_deref(sigil, v)?;
		let slot = match (sigil, &v) {
			(Sigil::Scalar, Value::Ref(Ref::Scalar(s))) => Slot::Scalar(s.clone()),
			(Sigil::Array, Value::Ref(Ref::Array(a))) => Slot::Array(a.clone()),
			(Sigil::Hash, Value::Ref(Ref::Hash(h))) => Slot::Hash(h.clone()),
			(Sigil::Code, Value::Ref(Ref::Code(c))) => Slot::Code(c.clone()),
			(Sigil::Glob, Value::Ref(Ref::Glob(g)) | Value::Glob(g)) => Slot::Glob(g.clone()),
			(Sigil::Scalar, Value::Ref(Ref::Glob(g)) | Value::Glob(g)) => Slot::Scalar(g.scalar.borrow().clone()),
			// A reference to a scalar holding a glob is a GLOB reference (that scalar is the GV).
			(Sigil::Glob, Value::Ref(Ref::Scalar(s))) if matches!(s.get(), Value::Glob(_)) => {
				let Value::Glob(g) = s.get() else { return Err(self.die_msg("Not a GLOB reference")); };
				Slot::Glob(g)
			}
			// `*$io_ref`: a temporary glob whose IO slot is that handle.
			(Sigil::Glob, Value::Ref(Ref::Io(io))) => {
				let gv = new_gv(Rc::from("main"), Rc::from("__ANONIO__"));
				gv.io.replace(Some(io.clone()));
				Slot::Glob(gv)
			}
			// A REGEXP body is a scalar holding the pattern string.
			(Sigil::Scalar, Value::Ref(Ref::Regexp(_))) => Slot::Scalar(new_sv(Value::Str(v.to_pstr()))),
			(Sigil::Array, Value::Ref(Ref::Glob(g)) | Value::Glob(g)) => Slot::Array(g.array.borrow().clone()),
			(Sigil::Hash, Value::Ref(Ref::Glob(g)) | Value::Glob(g)) => Slot::Hash(g.hash.borrow().clone()),
			(Sigil::Code, Value::Ref(Ref::Glob(g)) | Value::Glob(g)) => Slot::Code(self.code_slot(g)),
			(_, Value::Ref(_)) => {
				let kind = match sigil { Sigil::Array => "an ARRAY", Sigil::Hash => "a HASH", Sigil::Glob => "a GLOB", Sigil::Code => "a CODE", _ => "a SCALAR" };
				return Err(self.die_msg(format!("Not {kind} reference")));
			}
			(_, Value::Undef) if target.is_some() && matches!(sigil, Sigil::Scalar | Sigil::Array | Sigil::Hash) => {
				let (reference, slot) = match sigil {
					Sigil::Array => { let a = new_av(Vec::new()); (Ref::Array(a.clone()), Slot::Array(a)) }
					Sigil::Hash => { let h = new_hv(); (Ref::Hash(h.clone()), Slot::Hash(h)) }
					_ => { let s = new_sv(Value::Undef); (Ref::Scalar(s.clone()), Slot::Scalar(s)) }
				};
				if let Some(sv) = target { self.write_sv(&sv, Value::Ref(reference))?; }
				slot
			}
			// An rvalue dereference of undef without strict refs reads as an empty value (no autovivification).
			(Sigil::Scalar, Value::Undef) if !vivify && !self.active_hints.strict_refs => Slot::Scalar(new_sv(Value::Undef)),
			(Sigil::Array, Value::Undef) if !vivify && !self.active_hints.strict_refs => Slot::Array(new_av(Vec::new())),
			(Sigil::Hash, Value::Undef) if !vivify && !self.active_hints.strict_refs => Slot::Hash(new_hv()),
			_ => self.symbolic(sigil, &v)?,
		};
		Ok(slot)
	}

	fn array_index(&mut self, av: &Av, index: i64, create: bool) -> PResult<Option<usize>> {
		let len = av.elems().len();
		let offset = if index < 0 { (len as i64).saturating_add(index) } else { index };
		let Ok(i) = usize::try_from(offset) else {
			if create { return Err(self.die_msg(format!("Modification of non-creatable array value attempted, subscript {index}"))); }
			return Ok(None);
		};
		if create && i >= len {
			if modules::readonly_array(self, av) { return Err(self.die_msg("Modification of a read-only value attempted")); }
			let mut elems = av.elems_mut();
			if i >= ops::MAX_LIST || elems.try_reserve(i + 1 - len).is_err() { return Err(self.die_msg("Out of memory during array extend")); }
			elems.resize(i + 1, self.hole.clone());
		}
		Ok(Some(i))
	}

	fn hash_index(&mut self, key: &Expr) -> PResult<HKey> {
		let mut s = PStr::default();
		if let ExprKind::List(_) = &ungroup(key).kind {
			let sep = self.subscript_sep();
			for (i, value) in self.eval_list(key)?.into_iter().enumerate() {
				if i != 0 { s.push(&sep); }
				s.push(&self.stringify(&value)?);
			}
		} else {
			let value = self.eval_scalar(key)?;
			s = self.stringify_owned(value)?;
		}
		Ok(HKey::from_pstr(s))
	}

	fn select_aggregate(&mut self, base: &Expr, sigil: Sigil, arrow: bool, vivify: bool) -> PResult<Option<Slot>> {
		if !arrow {
			if let ExprKind::Variable(_, name) = &ungroup(base).kind {
				// No identifier is a capture aggregate. Resolve its AST name directly, once.
				if name.as_bytes().first().is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_') && !has_separator(name) {
					return self.variable_slot(sigil, name).map(Some);
				}
				// A lexical aggregate is never one of the match-variable arrays/hashes.
				if let Some(slot @ (Slot::Array(_) | Slot::Hash(_))) = self.pad_slot(sigil, name) { return Ok(Some(slot.clone())); }
				let qual = self.qualify(name);
				if let Some(name) = qual.strip_prefix("main::") {
					if sigil == Sigil::Array && let Some(v) = rx::match_array(self, name) { return Ok(Some(Slot::Array(new_av(v)))); }
					if sigil == Sigil::Hash && let Some(h) = rx::match_hv(self, name) { return Ok(Some(Slot::Hash(h))); }
				}
				return self.variable_slot(sigil, name).map(Some);
			}
			if let ExprKind::Deref(_, source) = &ungroup(base).kind { return self.deref(sigil, source, vivify).map(Some); }
		}
		if !vivify {
			let value = self.eval_scalar(base)?;
			if value.is_undef() { return Ok(None); }
			let value = self.overload_deref(sigil, value)?;
			return match (sigil, value) {
				(Sigil::Array, Value::Ref(Ref::Array(a))) => Ok(Some(Slot::Array(a))),
				(Sigil::Hash, Value::Ref(Ref::Hash(h))) => Ok(Some(Slot::Hash(h))),
				(_, Value::Ref(_)) => Err(self.die_msg(if sigil == Sigil::Array { "Not an ARRAY reference" } else { "Not a HASH reference" })),
				(_, value) => self.symbolic(sigil, &value).map(Some),
			};
		}
		self.deref(sigil, base, vivify).map(Some)
	}

	/// Plain storage for a scalar or a named array's constant element used as a key (`$h{$F[0]}`).
	/// Only peek at expressions that cannot run code or warn; all magic goes through ordinary evaluation.
	fn subscript_source(&mut self, key: &Expr) -> PResult<Option<Sv>> {
		match &key.kind {
			ExprKind::Variable(Sigil::Scalar, name) => Ok(match self.pad_slot(Sigil::Scalar, name) {
				Some(Slot::Scalar(s)) => Some(s.clone()),
				None if name.as_ref() == "_" => Some(self.topic()),
				_ => None,
			}),
			ExprKind::Select(base, Select::ArrayElement(false), index)
				if let ExprKind::Int(i) = &index.kind && (self.in_constant || self.active_hints.constant_overloads.is_empty())
					&& let ExprKind::Variable(_, name) = &base.kind
					&& name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && !has_separator(name) => {
				let Slot::Array(a) = self.variable_slot(Sigil::Array, name)? else { return Ok(None); };
				if self.tied_array(&a).is_some() { return Ok(None); }
				let elems = a.elems();
				let i = if *i < 0 { (elems.len() as i64).saturating_add(*i) } else { *i };
				Ok(usize::try_from(i).ok().and_then(|i| elems.get(i)).filter(|sv| !Rc::ptr_eq(sv, &self.hole)).cloned())
			}
			_ => Ok(None),
		}
	}

	fn hash_subscript_cell(&mut self, h: &Hv, key: &Expr, create: bool) -> PResult<Option<Sv>> {
		// Hash::Util retains a Weak for every hash with access restrictions. Neither it nor a tie may be bypassed.
		if Rc::weak_count(h) == 0 && self.tied_hash(h).is_none() && self.pending.is_none() && self.depth < 8190 {
			if let ExprKind::String(s) = &key.kind && (self.in_constant || self.active_hints.constant_overloads.is_empty())
				&& let Some(cell) = byte_hash_cell(h, &s.bytes, s.utf8, create) { return Ok(cell); }
			if let Some(sv) = self.subscript_source(key)? && let Some(v) = sv.plain_value()
				&& let Some(s) = v.as_pstr() && let Some(cell) = byte_hash_cell(h, &s.bytes, s.utf8, create) { return Ok(cell); }
		}
		if matches!(&ungroup(key).kind, ExprKind::List(_)) {
			let key = self.hash_index(key)?;
			return self.hash_cell(h, key, create);
		}
		let v = self.eval_scalar(key)?;
		// Evaluating the key can change the hash (including tying or restricting it).
		if let Value::Int(_) | Value::UInt(_) = v && Rc::weak_count(h) == 0 && self.tied_hash(h).is_none() {
			let mut buf = [0; 20];
			let bytes = match &v {
				Value::Int(i) => decimal_key(i.unsigned_abs(), *i < 0, &mut buf),
				Value::UInt(u) => decimal_key(*u, false, &mut buf),
				_ => &[],
			};
			if let Some(cell) = byte_hash_cell(h, bytes, false, create) { return Ok(cell); }
		}
		let s = self.stringify_owned(v)?;
		self.hash_cell(h, HKey::from_pstr(s), create)
	}

	/// Resolve both halves of a subscript together when the caller needs a cell, not a persistent element address.
	fn selection_cell(&mut self, base: &Expr, select: Select, key: &Expr, access: CellAccess) -> PResult<Option<Sv>> {
		let vivify = access != CellAccess::Match;
		let create = access == CellAccess::Write;
		if let Select::HashElement(arrow) = select {
			if let Some(Slot::Hash(h)) = self.select_aggregate(base, Sigil::Hash, arrow, vivify)? {
				return self.hash_subscript_cell(&h, key, create);
			}
			self.hash_index(key)?;
			return Ok(None);
		}
		match self.element(base, select, key, vivify)? {
			Some(el) => self.element_cell(el, create),
			None => Ok(None),
		}
	}

	fn element(&mut self, base: &Expr, select: Select, key: &Expr, vivify: bool) -> PResult<Option<Element>> {
		match select {
			Select::ArrayElement(arrow) => {
				let a = self.select_aggregate(base, Sigil::Array, arrow, vivify)?;
				let index = self.eval_scalar(key)?.to_i64();
				Ok(if let Some(Slot::Array(a)) = a { Some(Element::Array(a, index)) } else { None })
			}
			Select::HashElement(arrow) => {
				let h = self.select_aggregate(base, Sigil::Hash, arrow, vivify)?;
				let key = self.hash_index(key)?;
				Ok(if let Some(Slot::Hash(h)) = h { Some(Element::Hash(h, key)) } else { None })
			}
			_ => Ok(None),
		}
	}

	pub(super) fn ref_element_target(&mut self, e: &Expr) -> PResult<RefTarget> {
		if let ExprKind::Select(base, select, key) = &e.kind
			&& let Some(element) = self.element(base, *select, key, true)? {
			return self.element_ref_place(element);
		}
		Err(self.die_msg("Can't modify reference constructor in assignment"))
	}

	fn element_ref_place(&mut self, e: Element) -> PResult<RefTarget> {
		let place = match e {
			Element::Array(av, index) => {
				if self.tied_array(&av).is_some() { return Err(self.die_msg("Can't alias a tied array element")); }
				let Some(index) = self.array_index(&av, index, true)? else {
					return Err(self.die_msg("Can't alias a nonexistent array element"));
				};
				RefPlace::Array(av, index)
			}
			Element::Hash(hv, key) => {
				if self.tied_hash(&hv).is_some() { return Err(self.die_msg("Can't alias a tied hash element")); }
				modules::check_hash_access(self, &hv, &key, modules::HashAccess::Write)?;
				RefPlace::Hash(hv, key)
			}
		};
		Ok(Self::element_ref_target(place))
	}

	fn element_cell(&mut self, e: Element, create: bool) -> PResult<Option<Sv>> {
		match e {
			Element::Array(a, index) => self.array_cell(&a, index, create),
			Element::Hash(h, key) => self.hash_cell(&h, key, create),
		}
	}

	/// Resolve an array element as an aliased scalar, creating plain storage only on request.
	pub fn array_cell(&mut self, a: &Av, index: i64, create: bool) -> PResult<Option<Sv>> {
		if self.tied_array(a).is_some() { return Ok(Some(new_lvalue(Lvalue::ArrayElement(a.clone(), index)))); }
		let Some(i) = self.array_index(a, index, create)? else { return Ok(None); };
		let mut elems = a.elems_mut();
		let Some(sv) = elems.get_mut(i) else { return Ok(None); };
		if Rc::ptr_eq(sv, &self.hole) {
			if !create { return Ok(None); }
			*sv = new_sv(Value::Undef);
		}
		Ok(Some(sv.clone()))
	}

	/// Resolve a hash element as an aliased scalar, creating plain storage only on request.
	pub fn hash_cell(&mut self, h: &Hv, key: HKey, create: bool) -> PResult<Option<Sv>> {
		if self.tied_hash(h).is_some() { return Ok(Some(new_lvalue(Lvalue::HashElement(h.clone(), key)))); }
		if Rc::weak_count(h) != 0 {
			modules::check_hash_access(self, h, &key, if create { modules::HashAccess::Write } else { modules::HashAccess::Read })?;
		}
		if create { Ok(Some(h.entries_mut().entry(key).or_insert_with(|| new_sv(Value::Undef)).clone())) }
		else { Ok(h.entries().get(&key).cloned()) }
	}

	fn read_element(&mut self, element: Option<Element>) -> PResult<Value> {
		if let Some(element) = element && let Some(cell) = self.element_cell(element, false)? {
			self.read_sv(&cell)
		} else { Ok(Value::Undef) }
	}

	fn slice(&mut self, base: &Expr, select: Select, key: &Expr, vivify: bool) -> PResult<Vec<(Value, Option<Element>)>> {
		let (sigil, arrow) = match select {
			Select::ArraySlice(arrow) | Select::ArrayPairs(arrow) => (Sigil::Array, arrow),
			Select::HashSlice(arrow) | Select::HashPairs(arrow) => (Sigil::Hash, arrow),
			_ => return Ok(Vec::new()),
		};
		let aggregate = self.select_aggregate(base, sigil, arrow, vivify)?;
		let values = self.eval_list(key)?;
		let mut selected = Vec::with_capacity(values.len());
		for value in values {
			let element = match &aggregate {
				Some(Slot::Array(a)) => Some(Element::Array(a.clone(), value.to_i64())),
				Some(Slot::Hash(h)) => Some(Element::Hash(h.clone(), HKey::from_pstr(self.stringify(&value)?))),
				_ => None,
			};
			selected.push((value, element));
		}
		Ok(selected)
	}

	pub(super) fn read_selection(&mut self, base: &Expr, select: Select, key: &Expr, cx: Cx) -> PResult<Ret> {
		// op.c: a key/value slice of a named variable in scalar context suggests the element form.
		if cx == Cx::Scalar && matches!(select, Select::ArrayPairs(false) | Select::HashPairs(false))
			&& let ExprKind::Variable(_, name) = &ungroup(base).kind {
			let hash = matches!(select, Select::HashPairs(_));
			let inner = match &ungroup(key).kind {
				ExprKind::String(s) if hash => format!("\"{}\"", s.to_string_lossy()),
				ExprKind::String(s) => s.to_string_lossy().into_owned(),
				ExprKind::Int(n) if !hash => n.to_string(),
				_ => "...".to_owned(),
			};
			let (open, close) = if hash { ('{', '}') } else { ('[', ']') };
			self.warn_category("syntax", format!("%{name}{open}{inner}{close} in scalar context better written as ${name}{open}{inner}{close}"));
		}
		match select {
			Select::ArrayElement(_) | Select::HashElement(_) => {
				match self.selection_cell(base, select, key, CellAccess::Read)? {
					Some(cell) => self.read_sv(&cell).map(Ret::One),
					None => Ok(Ret::One(Value::Undef)),
				}
			}
			Select::ListSlice => {
				let list = self.eval_list(base)?;
				let keys = self.eval_list(key)?;
				let get = |key: Value| {
					let n = key.to_i64();
					let i = if n < 0 { n.saturating_add(list.len() as i64) } else { n };
					usize::try_from(i).ok().and_then(|n| list.get(n)).cloned().unwrap_or(Value::Undef)
				};
				if cx == Cx::List {
					if list.is_empty() { Ok(Ret::empty()) } else { Ok(Ret::Many(keys.into_iter().map(get).collect())) }
				} else { Ok(Ret::One(keys.into_iter().last().map_or(Value::Undef, get))) }
			}
			Select::GlobSlot => {
				let g = match &ungroup(base).kind {
					ExprKind::Variable(Sigil::Glob, name) => self.glob(name),
					_ => match self.eval_scalar(base)? {
						Value::Glob(g) | Value::Ref(Ref::Glob(g)) => g,
						_ => return Ok(Ret::One(Value::Undef)),
					},
				};
				let key = self.eval_scalar(key)?;
				let key = self.stringify(&key)?;
				let value = match key.bytes.as_slice() {
					b"SCALAR" => Value::Ref(Ref::Scalar(g.scalar.borrow().clone())),
					b"ARRAY" => Value::Ref(Ref::Array(g.array.borrow().clone())),
					b"HASH" => Value::Ref(Ref::Hash(g.hash.borrow().clone())),
					b"CODE" => g.code.borrow().clone().map_or(Value::Undef, |c| Value::Ref(Ref::Code(c))),
					b"IO" | b"FILEHANDLE" => g.io.borrow().clone().map_or(Value::Undef, |io| Value::Ref(Ref::Io(io))),
					b"GLOB" => Value::Ref(Ref::Glob(g)),
					b"NAME" => Value::str(&g.name),
					b"PACKAGE" => Value::str(&g.pkg),
					_ => Value::Undef,
				};
				Ok(Ret::One(value))
			}
			_ => {
				let pairs = matches!(select, Select::ArrayPairs(_) | Select::HashPairs(_));
				let selected = self.slice(base, select, key, true)?;
				if cx != Cx::List {
					let last = selected.into_iter().last().and_then(|(_, e)| e);
					return self.read_element(last).map(Ret::One);
				}
				let mut values = Vec::with_capacity(selected.len() * if pairs { 2 } else { 1 });
				for (key, e) in selected {
					if pairs { values.push(key); }
					values.push(self.read_element(e)?);
				}
				Ok(Ret::Many(values))
			}
		}
	}

	/// Obtain the existing cell of a match target without creating a missing element.
	pub fn eval_match_cell(&mut self, e: &Expr) -> PResult<Option<Sv>> {
		let e = ungroup(e);
		match &e.kind {
			ExprKind::Select(base, select @ (Select::ArrayElement(_) | Select::HashElement(_)), key) => {
				self.selection_cell(base, *select, key, CellAccess::Match)
			}
			ExprKind::Variable(Sigil::Scalar, name) if self.readonly_scalar(name) => self.eval_scalar(e).map(|v| Some(new_sv(v))),
			_ => self.eval_lvalue(e).map(Some),
		}
	}

	/// Evaluate an addressable scalar, autovivifying intermediate references as needed.
	pub fn eval_lvalue(&mut self, e: &Expr) -> PResult<Sv> {
		let e = ungroup(e);
		// The location and recursion guard only affect observable results on the slow path.
		if self.depth < 8192 && let ExprKind::Variable(Sigil::Scalar, name) = &e.kind
			&& let Some(Slot::Scalar(cell)) = self.pad_slot(Sigil::Scalar, name) {
			return Ok(cell.clone());
		}
		self.at_location(&e.location, |this| this.nested(|this| this.lvalue_inner(e)))
	}

	fn lvalue_inner(&mut self, e: &Expr) -> PResult<Sv> {
		match &e.kind {
			// A block's value as an lvalue (`${ ...; $x }`): its last statement's container.
			ExprKind::Block(block, false) if matches!(block.stmts.last(), Some(Stmt { kind: StmtKind::Expr(_), .. })) => {
				return self.scoped(|this| {
					let Some((last, before)) = block.stmts.split_last() else { return Err(this.die_msg("Can't modify do block")); };
					for stmt in before { this.run_statement(stmt, Cx::Void)?; }
					let StmtKind::Expr(e) = &last.kind else { return Err(this.die_msg("Can't modify do block")); };
					this.eval_lvalue(e)
				});
			}
			// The comma operator propagates lvalue context only to its last operand.
			ExprKind::List(items) if !items.is_empty() => {
				let (last, earlier) = items.split_last().ok_or_else(|| self.die_msg("Can't modify empty list"))?;
				for item in earlier { self.eval(item, Cx::Void)?; }
				return self.eval_lvalue(last);
			}
			ExprKind::Variable(Sigil::Scalar, name) if plain_lower_name(name) => {
				if let Slot::Scalar(cell) = self.variable_slot(Sigil::Scalar, name)? { return Ok(cell); }
			}
			ExprKind::Variable(Sigil::Scalar, name) => {
				// Lexicals never carry special-variable magic: skip the global checks.
				match self.pad_slot(Sigil::Scalar, name) {
					Some(Slot::Scalar(s)) => return Ok(s.clone()),
					// The global topic `$_` is never read-only or magical by name.
					None if name.as_ref() == "_" => return Ok(self.topic()),
					_ => {}
				}
				self.check_scalar_write(name)?;
				if let Some(v) = self.magic_scalar(name) { self.sv(&self.qualify(name)).replace(v); }
				if let Slot::Scalar(s) = self.variable_slot(Sigil::Scalar, name)? { return Ok(s); }
			}
			ExprKind::Deref(Sigil::Scalar, from) => if let Slot::Scalar(s) = self.deref(Sigil::Scalar, from, true)? { return Ok(s); },
			ExprKind::Select(base, select @ (Select::ArrayElement(_) | Select::HashElement(_)), key) => {
				if let Some(s) = self.selection_cell(base, *select, key, CellAccess::Write)? { return Ok(s); }
			}
			ExprKind::Declare(kind, _, target, _) => {
				let targets = self.declare_targets(*kind, target, e as *const Expr as usize)?;
				if let Some(Target::Scalar(s)) = targets.into_iter().next() { return Ok(s); }
			}
			ExprKind::Conditional(cond, yes, no) => {
				let v = self.eval_scalar(cond)?;
				let branch = if self.truthy(&v)? { yes } else { no };
				return self.eval_lvalue(branch);
			}
			ExprKind::Binary(Binary::Assign, target, value) => {
				let v = self.eval_scalar(value)?;
				let sv = self.eval_lvalue(target)?;
				self.write_sv(&sv, v)?;
				return Ok(sv);
			}
			ExprKind::Binary(Binary::AssignOp(op), target, value) => {
				let sv = self.eval_lvalue(target)?;
				self.compound_cell(*op, &sv, value)?;
				return Ok(sv);
			}
			ExprKind::Variable(Sigil::LastIndex, name) => {
				if let Slot::Array(av) = self.variable_slot(Sigil::Array, name)? { return Ok(new_lvalue(Lvalue::LastIndex(av))); }
			}
			ExprKind::Deref(Sigil::LastIndex, source) => {
				if let Slot::Array(av) = self.deref(Sigil::Array, source, true)? { return Ok(new_lvalue(Lvalue::LastIndex(av))); }
			}
			ExprKind::Call(call) => {
				if let CallTarget::Builtin(b, origin) = call.target && self.builtin_uses_core(b, origin)
					&& let Some(result) = func::lvalue(self, b, call) { return result; }
				if let Some(sv) = self.call_lvalue(call)? { return Ok(sv); }
			}
			_ => {}
		}
		Err(self.die_msg("Modification of a read-only value attempted"))
	}

	/// Evaluate an array slot, without converting its elements to scalar values.
	pub fn eval_array(&mut self, e: &Expr) -> PResult<Av> {
		let e = ungroup(e);
		let slot = match &e.kind {
			ExprKind::Variable(Sigil::Array, name) => {
				let name_qualified = self.qualify(name);
				if let Some(name) = name_qualified.strip_prefix("main::") && let Some(v) = rx::match_array(self, name) { return Ok(new_av(v)); }
				self.variable_slot(Sigil::Array, name)?
			}
			ExprKind::Deref(Sigil::Array, source) => self.deref(Sigil::Array, source, true)?,
			ExprKind::Declare(kind, _, target, _) => {
				let targets = self.declare_targets(*kind, target, e as *const Expr as usize)?;
				return match targets.into_iter().next() { Some(Target::Array(a)) => Ok(a), _ => Err(self.die_msg("Not an ARRAY reference")) };
			}
			_ => return match self.eval_scalar(e)? { Value::Ref(Ref::Array(a)) => Ok(a), _ => Err(self.die_msg("Not an ARRAY reference")) },
		};
		if let Slot::Array(a) = slot { Ok(a) } else { Err(self.die_msg("Not an ARRAY reference")) }
	}

	/// Evaluate a hash slot, without flattening its keys and values.
	pub fn eval_hash(&mut self, e: &Expr) -> PResult<Hv> {
		let e = ungroup(e);
		let slot = match &e.kind {
			ExprKind::Variable(Sigil::Hash, name) => {
				let qual = self.qualify(name);
				// %+ / %- are one container per match, so `each` iterates them (rx::match_hv).
				if let Some(name) = qual.strip_prefix("main::") && let Some(h) = rx::match_hv(self, name) { return Ok(h); }
				self.variable_slot(Sigil::Hash, name)?
			}
			ExprKind::Deref(Sigil::Hash, source) => self.deref(Sigil::Hash, source, true)?,
			ExprKind::Declare(kind, _, target, _) => {
				let targets = self.declare_targets(*kind, target, e as *const Expr as usize)?;
				return match targets.into_iter().next() { Some(Target::Hash(h)) => Ok(h), _ => Err(self.die_msg("Not a HASH reference")) };
			}
			_ => return match self.eval_scalar(e)? { Value::Ref(Ref::Hash(h)) => Ok(h), _ => Err(self.die_msg("Not a HASH reference")) },
		};
		if let Slot::Hash(h) = slot { Ok(h) } else { Err(self.die_msg("Not a HASH reference")) }
	}

	/// Resolve a bare, glob-valued or reference-valued filehandle expression.
	pub fn eval_handle(&mut self, e: &Expr) -> PResult<Option<Io>> {
		if let ExprKind::Bareword(name) = &ungroup(e).kind { return Ok(self.handle(name, false)); }
		let value = self.eval_scalar(e)?;
		Ok(match value {
			Value::Ref(Ref::Io(io)) => Some(io),
			Value::Glob(g) | Value::Ref(Ref::Glob(g)) => g.io.borrow().clone(),
			Value::Undef => None,
			_ => self.handle(&value.to_pstr().to_string_lossy(), false),
		})
	}

	pub(super) fn defined_glob_deref(&mut self, source: &Expr) -> PResult<bool> {
		let value = self.eval_scalar(source)?;
		let value = self.overload_deref(Sigil::Glob, value)?;
		match value {
			Value::Undef => Ok(false),
			Value::Ref(Ref::Glob(_)) | Value::Glob(_) => Ok(true),
			Value::Ref(_) => Err(self.die_msg("Not a GLOB reference")),
			_ => Ok(self.find_glob(&value.to_pstr().to_string_lossy()).is_some()),
		}
	}

	pub(super) fn eval_var(&mut self, sigil: Sigil, name: &str, cx: Cx) -> PResult<Ret> {
		let our = match self.lookup_pad(sigil, name) {
			Some(Slot::Our(qualified)) => Some(qualified),
			Some(slot) => return self.slot_value(slot, sigil, cx),
			None if matches!(sigil, Sigil::Array | Sigil::LastIndex) && name == "_" => {
				let slot = self.package_slot(sigil, name);
				return self.slot_value(slot, sigil, cx);
			}
			None => {
				if sigil == Sigil::Scalar && let Some(value) = self.magic_scalar(name) { return Ok(Ret::One(value)); }
				None
			}
		};
		let qual = self.qualify(name);
		if let Some(name) = qual.strip_prefix("main::") {
			if matches!(sigil, Sigil::Array | Sigil::LastIndex) && let Some(v) = rx::match_array(self, name) {
				return Ok(if sigil == Sigil::LastIndex { Ret::One(Value::Int(v.len() as i64 - 1)) } else { Ret::values(v, cx) });
			}
			if sigil == Sigil::Hash && let Some(v) = rx::match_hash(self, name) {
				return if cx == Cx::List { Ok(Ret::Many(v.into_iter().flat_map(|(name, value)| [Value::Str(name), value]).collect())) }
				else { Ok(Ret::One(Value::Int(v.len() as i64))) };
			}
		}
		let slot = self.package_slot(sigil, our.as_deref().unwrap_or(&qual));
		self.slot_value(slot, sigil, cx)
	}

	pub(super) fn eval_deref(&mut self, sigil: Sigil, source: &Expr, cx: Cx) -> PResult<Ret> {
		// Rvalue `$$r`, `@$r`, `%$r` do not autovivify `$r` (perlref); `$#$r`, globs and code still do.
		let vivify = !matches!(sigil, Sigil::Scalar | Sigil::Array | Sigil::Hash);
		let slot = self.deref(sigil, source, vivify)?;
		self.slot_value(slot, sigil, cx)
	}

	fn slot_value(&mut self, slot: Slot, sigil: Sigil, cx: Cx) -> PResult<Ret> {
		Ok(match slot {
			Slot::Scalar(s) => Ret::One(self.read_sv(&s)?),
			Slot::Array(a) if sigil == Sigil::LastIndex => Ret::One(Value::Int(self.array_len(&a)? as i64 - 1)),
			Slot::Array(a) => {
				if cx == Cx::List {
					if self.tied_array(&a).is_none() {
						let elems = a.elems();
						if elems.iter().all(|sv| !sv.has_read_magic()) { return Ok(Ret::Many(elems.iter().map(|sv| sv.get()).collect())); }
					}
					let cells = self.eval_array_aliases(&a, false)?;
					Ret::Many(self.read_alias_values(cells)?)
				} else { Ret::One(Value::Int(self.array_len(&a)? as i64)) }
			}
			Slot::Hash(h) => {
				if cx == Cx::List {
					let cells = self.eval_hash_aliases(&h)?;
					Ret::Many(self.read_alias_values(cells)?)
				} else if let Some(obj) = self.tied_hash(&h) {
					if let Value::Ref(r) = &obj && let Some(class) = r.blessed() && let Some(cv) = self.find_method(&class, "SCALAR") {
						self.call_sub(&cv, vec![new_sv(obj)], Cx::Scalar)?
					} else { Ret::One(perl_bool(!self.hash_keys(&h)?.is_empty())) }
				} else { Ret::One(Value::Int(h.entries().len() as i64)) }
			}
			Slot::Glob(g) => Ret::One(Value::Glob(g)),
			Slot::Code(c) => Ret::One(Value::Ref(Ref::Code(c))),
			Slot::Our(_) => Ret::no_value(cx),
		})
	}

	fn read_alias_values(&mut self, cells: Vec<Sv>) -> PResult<Vec<Value>> {
		cells.into_iter().map(|sv| self.read_sv(&sv)).collect()
	}

	pub(super) fn eval_array_aliases(&mut self, a: &Av, materialize: bool) -> PResult<Vec<Sv>> {
		if self.tied_array(a).is_none() {
			return Ok(if materialize { self.array_aliases(a) } else { a.elems().clone() });
		}
		let n = self.array_len(a)?;
		if n > ops::MAX_LIST { return Err(self.die_msg("Out of memory during array extend")); }
		Ok((0..n).map(|index| new_lvalue(Lvalue::ArrayElement(a.clone(), index as i64))).collect())
	}

	fn eval_hash_aliases(&mut self, h: &Hv) -> PResult<Vec<Sv>> {
		h.iter.set(0);
		if self.tied_hash(h).is_none() {
			return Ok(h.entries().iter().flat_map(|(k, v)| [new_sv(Value::Str(k.to_pstr())), v.clone()]).collect());
		}
		Ok(self.hash_keys(h)?.into_iter().flat_map(|key| {
			[new_sv(Value::Str(key.to_pstr())), new_lvalue(Lvalue::HashElement(h.clone(), key))]
		}).collect())
	}

	pub(super) fn reference(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		let grouped = matches!(&e.kind, ExprKind::Group(_) | ExprKind::List(_));
		let base = ungroup(e);
		if !grouped {
			match &base.kind {
				ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => return Ok(Ret::One(Value::Ref(Ref::Array(self.eval_array(base)?)))),
				ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => return Ok(Ret::One(Value::Ref(Ref::Hash(self.eval_hash(base)?)))),
				ExprKind::Declare(_, _, target, _) => match &target.kind {
					ExprKind::Variable(Sigil::Array, _) => return Ok(Ret::One(Value::Ref(Ref::Array(self.eval_array(base)?)))),
					ExprKind::Variable(Sigil::Hash, _) => return Ok(Ret::One(Value::Ref(Ref::Hash(self.eval_hash(base)?)))),
					_ => {}
				},
				ExprKind::Variable(Sigil::Code, name) => if let Slot::Code(c) = self.variable_slot(Sigil::Code, name)? { return Ok(Ret::One(Value::Ref(Ref::Code(c)))); },
				ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, .. }) => if let Slot::Code(c) = self.variable_slot(Sigil::Code, name)? { return Ok(Ret::One(Value::Ref(Ref::Code(c)))); },
				ExprKind::Variable(Sigil::Glob, name) => return Ok(Ret::One(Value::Ref(Ref::Glob(self.glob(name))))),
				ExprKind::Deref(Sigil::Code, source) | ExprKind::Call(Call { target: CallTarget::Code(source, true), args: None, .. }) => {
					if let Some(c) = self.exempt_code(source, true)? { return Ok(Ret::One(Value::Ref(Ref::Code(c)))); }
				}
				ExprKind::Deref(Sigil::Glob, _) => {
					let v = self.eval_scalar(base)?;
					return Ok(Ret::One(if let Value::Glob(g) = v { Value::Ref(Ref::Glob(g)) } else { v }));
				}
				ExprKind::Variable(Sigil::Scalar, name) if self.readonly_scalar(name) => {
					let v = self.eval_scalar(base)?;
					return Ok(Ret::One(Value::Ref(Ref::Scalar(new_sv(v)))));
				}
				// `\$h{k}` / `\$a[i]` create the element (unlike a deferred sub argument).
				ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _) =>
					return Ok(Ret::One(Value::Ref(Ref::Scalar(self.eval_lvalue(base)?)))),
				_ => {}
			}
		}
		// `\(LIST)` references each item; a `&name` item is that sub (`\(&a, &b)`), not a call.
		let parts: Vec<&Expr> = match &base.kind { ExprKind::List(items) if grouped => items.iter().collect(), _ => vec![e] };
		let mut references = Vec::new();
		for part in parts {
			if let ExprKind::Variable(Sigil::Code, name) = &ungroup(part).kind {
				if let Slot::Code(c) = self.variable_slot(Sigil::Code, name)? { references.push(Value::Ref(Ref::Code(c))); }
				continue;
			}
			references.extend(self.eval_aliases(part)?.into_iter().map(|s| Value::Ref(Ref::Scalar(s))));
		}
		if cx == Cx::List { Ok(Ret::Many(references)) }
		else { Ok(Ret::One(references.pop().unwrap_or(Value::Undef))) }
	}

	fn declare_one(&mut self, kind: DeclKind, target: &Expr) -> PResult<(Target<'static>, Option<(Sigil, Rc<str>, Slot)>)> {
		if matches!(&target.kind, ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Undef, _), args: None, .. })) {
			return Ok((Target::Skip, None));
		}
		if kind == DeclKind::Local { return self.local_target(target).map(|t| (t, None)); }
		let ExprKind::Variable(sigil, name) = &target.kind else { return Err(self.die_msg("Can't declare this expression")); };
		let id = Rc::as_ptr(name) as *const () as usize;
		let slot = self.declared_slots.remove(&id).map_or_else(
			|| self.fresh_binding(kind, *sigil, name, &self.package), |(_, slot)| slot);
		let place = match &slot { Slot::Our(q) => self.package_slot(*sigil, q), _ => slot.clone() };
		Ok((Self::slot_target(place, *sigil), Some((*sigil, name.clone(), slot))))
	}

	fn slot_target(slot: Slot, sigil: Sigil) -> Target<'static> {
		match slot {
			Slot::Scalar(s) => Target::Scalar(s),
			Slot::Array(a) if sigil == Sigil::LastIndex => Target::LastIndex(a),
			Slot::Array(a) => Target::Array(a),
			Slot::Hash(h) => Target::Hash(h),
			Slot::Glob(g) => Target::Glob(g),
			Slot::Code(_) | Slot::Our(_) => Target::Skip,
		}
	}

	fn declare_targets_into(&mut self, kind: DeclKind, target: &Expr, targets: &mut Vec<Target<'static>>, pad: &mut Pad) -> PResult<()> {
		match &ungroup(target).kind {
			ExprKind::List(items) => for item in items { self.declare_targets_into(kind, item, targets, pad)?; },
			ExprKind::Declare(DeclKind::Our, _, inner, _) if kind == DeclKind::Local => {
				self.declare_targets(DeclKind::Our, inner, target as *const Expr as usize)?;
				self.declare_targets_into(DeclKind::Local, inner, targets, pad)?;
			}
			ExprKind::Select(base, sel @ (Select::ArraySlice(_) | Select::HashSlice(_) | Select::ArrayPairs(_) | Select::HashPairs(_)), key) if kind == DeclKind::Local => {
				for (_, el) in self.slice(base, *sel, key, true)? {
					if let Some(el) = el { targets.push(Target::Scalar(self.local_elem(el, false)?)); }
				}
			}
			_ => {
				let (target, binding) = self.declare_one(kind, ungroup(target))?;
				targets.push(target);
				if let Some(binding) = binding { pad.push(binding); }
			}
		}
		Ok(())
	}

	pub(super) fn declare_targets(&mut self, kind: DeclKind, target: &Expr, site: usize) -> PResult<Vec<Target<'static>>> {
		if kind == DeclKind::State {
			let pad = self.persistent.borrow().vars.get(&site).cloned();
			if let Some(pad) = pad {
				let targets = pad.iter().map(|(sigil, _, slot)| Self::slot_target(slot.clone(), *sigil)).collect();
				self.introduce_declarations(kind, pad);
				return Ok(targets);
			}
		}
		let mut targets = Vec::new();
		let mut pad = Pad::new();
		self.declare_targets_into(kind, target, &mut targets, &mut pad)?;
		if kind == DeclKind::State { self.persistent.borrow_mut().vars.insert(site, pad.clone()); }
		self.introduce_declarations(kind, pad);
		Ok(targets)
	}

	fn local_target(&mut self, e: &Expr) -> PResult<Target<'static>> {
		match &e.kind {
			ExprKind::Select(_, Select::HashPairs(_), _) => return Err(self.die_msg("Can't modify key/value hash slice in local")),
			ExprKind::Select(_, Select::ArrayPairs(_), _) => return Err(self.die_msg("Can't modify index/value array slice in local")),
			_ => {}
		}
		if let ExprKind::Declare(DeclKind::Our, _, target, _) = &e.kind {
			self.declare_targets(DeclKind::Our, target, e as *const Expr as usize)?;
			return self.local_target(ungroup(target));
		}
		if let ExprKind::Variable(sigil, name) = &e.kind {
			let qualified = match self.lookup_pad(*sigil, name) {
				Some(Slot::Our(q)) => q,
				Some(_) => return Err(self.die_msg(format!("Can't localize lexical variable ${name}"))),
				None => self.qualify(name),
			};
			let g = self.glob(&qualified);
			match sigil {
				Sigil::Scalar if qualified.as_ref() == "main::_" && !self.topics.is_empty() => {
					let index = self.topics.len() - 1;
					let new = new_sv(Value::Undef);
					if let Some(topic) = self.topics.get_mut(index) {
						let old = std::mem::replace(topic, new.clone());
						self.add_restore(Restore::Topic(index, old));
					}
					return Ok(Target::Scalar(new));
				}
				Sigil::Scalar if qualified.as_ref() == "main::." => {
					let sv = g.scalar.borrow().clone();
					let value = self.magic_scalar(".").unwrap_or(Value::Undef);
					let line = self.last_read.is_some().then(|| value.to_i64());
					self.add_restore(Restore::LastRead(self.last_read.clone(), line, value));
					return Ok(Target::Scalar(sv));
				}
				Sigil::Scalar if qualified.strip_prefix("main::").is_some_and(|name| formatted(name) || matches!(name, "!" | "^E" | "|" | "." | "^I")) => {
					let old = self.magic_scalar(name).unwrap_or_else(|| self.special_value(&qualified));
					let sv = g.scalar.borrow().clone();
					self.add_restore(Restore::Magic(sv.clone(), old));
					self.write_sv(&sv, Value::Undef)?;
					return Ok(Target::Scalar(sv));
				}
				// `local $1` is allowed: match variables are already scoped to the enclosing block.
				Sigil::Scalar if name.as_ref() != "0" && !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) || matches!(name.as_ref(), "&" | "`" | "'" | "+" | "^N") => return Ok(Target::Skip),
				Sigil::Scalar => {
					self.check_scalar_write(name)?;
					let new = new_sv(Value::Undef);
					let old = g.scalar.replace(new.clone());
					self.add_restore(Restore::Scalar(g, old));
					return Ok(Target::Scalar(new));
				}
				Sigil::Array if qualified.as_ref() == "main::_" && !self.active_subs.is_empty() => {
					let new = new_av(Vec::new());
					let index = self.active_subs.len() - 1;
					if let Some((_, av, _)) = self.active_subs.get_mut(index) {
						let original = std::mem::replace(av, new.clone());
						self.add_restore(Restore::Args(index, original));
					}
					return Ok(Target::Array(new));
				}
				Sigil::Array => {
					let new = new_av(Vec::new());
					let old = g.array.replace(new.clone());
					self.add_restore(Restore::Array(g, old));
					return Ok(Target::Array(new));
				}
				Sigil::Hash => {
					let new = new_hv();
					let old = g.hash.replace(new.clone());
					self.add_restore(Restore::Hash(g, old));
					return Ok(Target::Hash(new));
				}
				Sigil::Code => {
					let old = g.code.replace(None);
					self.add_restore(Restore::Code(g, old));
					return Ok(Target::Skip);
				}
				Sigil::Glob => {
					let new = new_gv(g.pkg.clone(), g.name.clone());
					// The default output handle is this glob's (perl keeps the GV and swaps its GP): output goes to
					// the fresh, unopened slot until the glob is restored.
					let selected = self.selected();
					if g.io.borrow().as_ref().is_some_and(|io| Rc::ptr_eq(io, &selected)) {
						let io: Io = Rc::new(RefCell::new(Handle::closed()));
						self.set_handle(&new, io.clone());
						self.set_selected(io);
					}
					self.stash(&g.pkg).entries_mut().insert(hash_key(&g.name), new_sv(Value::Glob(new.clone())));
					self.symbols.insert(qualified.clone(), new.clone());
					self.symbols_changed();
					self.add_restore(Restore::Glob(qualified, g));
					return Ok(Target::Glob(new));
				}
				_ => {}
			}
		}
		if let ExprKind::Select(base, select, key) = &e.kind && let Some(el) = self.element(base, *select, key, true)? {
			return self.local_elem(el, false).map(Target::Scalar);
		}
		if let ExprKind::Deref(sigil, source) = &e.kind {
			let value = self.eval_scalar(source)?;
			if !matches!(value, Value::Ref(_) | Value::Undef) {
				let name = value.to_pstr();
				let qualified = self.qualify(&name.to_string_lossy());
				self.symbolic(*sigil, &value)?;
				let target = Expr { location: e.location.clone(), kind: ExprKind::Variable(*sigil, qualified) };
				return self.local_target(&target);
			}
		}
		Err(self.die_msg("Can't localize through a reference"))
	}

	fn local_elem(&mut self, el: Element, delete: bool) -> PResult<Sv> {
		if let Some((object, key)) = self.tied_element(&el)? {
			let exists = if let Value::Ref(r) = &object && let Some(class) = r.blessed() && self.find_method(&class, "EXISTS").is_some() {
				let value = self.call_method(object.clone(), "EXISTS", vec![key.clone()], Cx::Scalar)?.scalar();
				self.truthy(&value)?
			} else { true };
			let old = if exists { Some(self.call_method(object.clone(), "FETCH", vec![key.clone()], Cx::Scalar)?.scalar()) } else { None };
			self.add_restore(Restore::TiedElement(object.clone(), key.clone(), old));
			if delete {
				let value = self.call_method(object, "DELETE", vec![key], Cx::Scalar)?.scalar();
				return Ok(new_sv(value));
			}
			self.call_method(object, "STORE", vec![key, Value::Undef], Cx::Void)?;
			return Ok(match el {
				Element::Array(a, index) => new_lvalue(Lvalue::ArrayElement(a, index)),
				Element::Hash(h, key) => new_lvalue(Lvalue::HashElement(h, key)),
			});
		}
		let fresh = new_sv(Value::Undef);
		match el {
			Element::Array(a, index) => {
				let len = a.elems().len();
				if let Some(i) = self.array_index(&a, index, !delete)? {
					let old = a.elems_mut().get_mut(i).map(|s| std::mem::replace(s, if delete { self.hole.clone() } else { fresh.clone() }));
					let old = old.filter(|s| !Rc::ptr_eq(s, &self.hole));
					if delete && let Some(s) = &old { fresh.replace(read_sv(s)); }
					self.add_restore(Restore::ArrayElem(a, i, old, len));
				}
			}
			Element::Hash(h, key) => {
				modules::check_hash_access(self, &h, &key, if delete { modules::HashAccess::Delete } else { modules::HashAccess::Write })?;
				let old = if delete { h.entries_mut().shift_remove(&key) } else { h.entries_mut().insert(key.clone(), fresh.clone()) };
				if delete && let Some(s) = &old { fresh.replace(read_sv(s)); }
				self.add_restore(Restore::HashElem(h, key, old));
			}
		}
		Ok(fresh)
	}

	pub(super) fn list_target(e: &Expr) -> bool {
		match &e.kind {
			// A ternary target is a list only when both branches are (parentheses do not change that).
			ExprKind::Conditional(_, yes, no) => Self::list_target(yes) && Self::list_target(no),
			ExprKind::Group(inner) if matches!(inner.kind, ExprKind::Conditional(..)) => Self::list_target(inner),
			ExprKind::Unary(Unary::Plus, inner) => Self::list_target(inner),
			ExprKind::List(_) | ExprKind::Group(_) | ExprKind::Variable(Sigil::Array | Sigil::Hash, _) | ExprKind::Deref(Sigil::Array | Sigil::Hash, _) => true,
			ExprKind::Select(_, Select::ArraySlice(_) | Select::ArrayPairs(_) | Select::HashSlice(_) | Select::HashPairs(_), _) => true,
			ExprKind::Declare(_, _, target, _) => Self::list_target(target),
			ExprKind::Unary(Unary::Reference, e) => matches!(&e.kind, ExprKind::Group(_) | ExprKind::List(_)
				| ExprKind::Select(_, Select::ArraySlice(_) | Select::HashSlice(_), _))
				|| matches!(&e.kind, ExprKind::Declare(_, _, e, _) if matches!(&e.kind, ExprKind::List(_) | ExprKind::Group(_))),
			_ => false,
		}
	}

	fn collect_ref_targets(&mut self, e: &Expr, targets: &mut Vec<Target<'_>>) -> PResult<()> {
		match &ungroup(e).kind {
			ExprKind::List(es) => for e in es { self.collect_ref_targets(e, targets)?; },
			ExprKind::Select(base, select @ (Select::ArraySlice(_) | Select::HashSlice(_)), key) => {
				for (_, element) in self.slice(base, *select, key, true)? {
					if let Some(el) = element { targets.push(Target::Alias(self.element_ref_place(el)?)); }
				}
			}
			// `\local @a[...] = ...`: localize each element, then alias it.
			ExprKind::Declare(DeclKind::Local, _, inner, _)
				if let ExprKind::Select(base, select @ (Select::ArraySlice(_) | Select::HashSlice(_)), key) = &ungroup(inner).kind => {
				for (_, element) in self.slice(base, *select, key, true)? {
					if let Some(el) = element {
						self.local_elem(el.clone(), false)?;
						targets.push(Target::Alias(self.element_ref_place(el)?));
					}
				}
			}
			_ => targets.push(Target::Alias(self.ref_target(e)?)),
		}
		Ok(())
	}

	fn collect_targets<'e>(&mut self, e: &'e Expr, targets: &mut Vec<Target<'e>>) -> PResult<()> {
		let e = ungroup(e);
		match &e.kind {
			ExprKind::List(items) => for item in items { self.collect_targets(item, targets)?; },
			ExprKind::Unary(Unary::Reference, inner) => {
				self.aliasing_enabled()?;
				self.collect_ref_targets(inner, targets)?;
			}
			ExprKind::Declare(kind, class, target, attrs) => {
				if let ExprKind::Unary(Unary::Reference, inner) = &ungroup(target).kind {
					let declarations = self.declare_targets(*kind, inner, e as *const Expr as usize)?;
					drop(declarations);
					targets.push(Target::Alias(self.pending_ref_target(inner)?));
				} else {
					let declared = self.declare_targets(*kind, target, e as *const Expr as usize)?;
					// `my $x : Attr = ...` applies the attributes before the assignment.
					if *kind != DeclKind::Local { self.apply_declared_attributes(class.as_ref(), attrs, &declared)?; }
					targets.extend(declared);
				}
			}
			ExprKind::Variable(Sigil::Array | Sigil::Hash | Sigil::Glob | Sigil::LastIndex, _) | ExprKind::Deref(Sigil::Array | Sigil::Hash | Sigil::Glob | Sigil::LastIndex, _) => {
				let (sigil, slot) = match &e.kind {
					ExprKind::Variable(sigil, name) => (*sigil, self.variable_slot(*sigil, name)?),
					ExprKind::Deref(sigil, source) => (*sigil, self.deref(*sigil, source, true)?),
					_ => return Err(self.die_msg("Can't modify this expression")),
				};
				targets.push(Self::slot_target(slot, sigil));
			}
			ExprKind::Select(_, Select::ArrayPairs(_), _) => return Err(self.die_msg("Can't modify index/value array slice in list assignment")),
			ExprKind::Select(_, Select::HashPairs(_), _) => return Err(self.die_msg("Can't modify key/value hash slice in list assignment")),
			ExprKind::Select(base, select @ (Select::ArraySlice(_) | Select::HashSlice(_)), key) => {
				for (_, el) in self.slice(base, *select, key, true)? {
					if let Some(el) = el && let Some(sv) = self.element_cell(el, true)? { targets.push(Target::Scalar(sv)); }
				}
			}
			ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Undef, _), args: None, .. }) => targets.push(Target::Skip),
			ExprKind::Call(call @ Call { target: CallTarget::Builtin(b @ (Builtin::Substr | Builtin::Vec | Builtin::Pos | Builtin::Keys), _), .. }) => targets.push(Target::Builtin(*b, call)),
			ExprKind::Conditional(cond, yes, no) => {
				let v = self.eval_scalar(cond)?;
				let branch = if self.truthy(&v)? { yes } else { no };
				self.collect_targets(branch, targets)?;
			}
			// `(@a = LIST) = ...`: a list assignment as an lvalue is the containers it assigned to.
			ExprKind::Binary(Binary::Assign, target, rhs) if Self::list_target(target) => {
				let (_, cells) = self.assign_list(target, rhs, true)?;
				targets.extend(cells.into_iter().map(Target::Scalar));
			}
			// `((undef) x N) = LIST` skips N values.
			ExprKind::Binary(Binary::Repeat, list, count) if matches!(&list.kind, ExprKind::Group(_)) => {
				let mut inner = Vec::new();
				self.collect_targets(list, &mut inner)?;
				if !inner.iter().all(|t| matches!(t, Target::Skip)) { return Err(self.die_msg("Can't modify repeat (x) in list assignment")); }
				let count = self.eval_scalar(count)?;
				let n = usize::try_from(self.numify(&count)?.wrapping_iv()).unwrap_or(0).saturating_mul(inner.len());
				targets.extend((0..n).map(|_| Target::Skip));
			}
			ExprKind::Call(call @ Call { target: CallTarget::Named(name, _), .. }) if self.named_lvalue(name) => {
				for item in self.call_lvalue_list(call)? {
					targets.push(match item {
						Value::Ref(Ref::Scalar(sv)) => Target::Scalar(sv),
						Value::Ref(Ref::Array(av)) => Target::Array(av),
						Value::Ref(Ref::Hash(hv)) => Target::Hash(hv),
						_ => Target::Skip,
					});
				}
			}
			_ => targets.push(Target::Scalar(self.eval_lvalue(e)?)),
		}
		Ok(())
	}

	fn write_target(&mut self, target: Target<'_>, value: Value) -> PResult<Option<Value>> {
		match target {
			Target::Scalar(s) => return self.store_sv(&s, value),
			Target::Glob(g) => self.assign_glob(&g, value)?,
			Target::LastIndex(a) => self.resize_array(&a, value.to_i64().saturating_add(1).max(0))?,
			Target::Builtin(b, call) => return func::assign(self, b, call, value).map(Some),
			Target::Alias(alias) => self.store_ref_target(alias, value)?,
			_ => {}
		}
		Ok(None)
	}

	fn assign_glob(&mut self, g: &Gv, value: Value) -> PResult<()> {
		match value {
			Value::Ref(Ref::Scalar(s)) => { g.scalar.replace(s); }
			Value::Ref(Ref::Array(a)) => { g.array.replace(a); if g.name.as_ref() == "ISA" { self.mark_package_changed(&g.pkg); } }
			Value::Ref(Ref::Hash(h)) => { g.hash.replace(h); }
			Value::Ref(Ref::Code(c)) => {
				let old = g.code.borrow().clone();
				if let Some(old) = &old && !Rc::ptr_eq(old, &c) {
					let (was, now) = (old.prototype.borrow().clone(), c.prototype.borrow().clone());
					// cv_ckproto runs only for a defined sub or a stub declared with a prototype.
					let checked = was.is_some() || !matches!(*old.body.borrow(), CodeImpl::Undefined);
					if checked && was != now {
						let show = |p: &Option<PStr>| p.as_ref().map_or_else(|| "none".to_owned(), |p| format!("({})", p.to_string_lossy()));
						let name = format!("{}::{}", g.pkg, g.name);
						let msg = if was.is_none() { format!("Prototype mismatch: sub {name}: none vs {}", show(&now)) }
							else { format!("Prototype mismatch: sub {name} {} vs {}", show(&was), show(&now)) };
						self.warn_category_default("prototype", msg);
					}
				}
				if let Some(old) = old && !Rc::ptr_eq(&old, &c) && !matches!(*old.body.borrow(), CodeImpl::Undefined) {
					let name = format!("{}::{}", g.pkg, g.name);
					if super::calls::is_constant_sub(&old) { self.warn_category_default("redefine", format!("Constant subroutine {name} redefined")); }
					else { self.warn_category("redefine", format!("Subroutine {name} redefined")); }
				}
				g.code.replace(Some(c));
				// GvIMPORTED_CV: a sub assigned from another package counts as imported (it may override a builtin).
				if g.pkg != self.package { self.imported_symbols.insert(Rc::from(format!("{}::{}", g.pkg, g.name))); }
				self.mark_package_changed(&g.pkg);
			}
			Value::Ref(Ref::Io(io)) => self.set_handle(g, io),
			Value::Ref(Ref::Glob(from)) | Value::Glob(from) => {
				if !Rc::ptr_eq(g, &from) {
					g.scalar.replace(from.scalar.borrow().clone());
					g.array.replace(from.array.borrow().clone());
					g.hash.replace(from.hash.borrow().clone());
					g.code.replace(from.code.borrow().clone());
					// Globs share one GP in perl: give the source an IO object now so a later open through
					// either name (`local *F = shift; open F, ...`) is seen by both.
					let io = from.io.borrow().clone();
					let io = if io.is_none() && !from.name.ends_with("::") {
						let io: Io = Rc::new(RefCell::new(Handle::closed()));
						self.set_handle(&from, io.clone());
						Some(io)
					} else { io };
					g.io.replace(io);
				}
			}
			// A plain scalar names the glob to alias (`*x = "y"`, `*x = 1` is `*main::1`).
			v @ (Value::Str(_) | Value::Int(_) | Value::UInt(_) | Value::Num(_) | Value::Dual(_)) => {
				let from = self.glob(&v.to_pstr().to_string_lossy());
				return self.assign_glob(g, Value::Glob(from));
			}
			Value::Undef => self.warn_category("misc", "Undefined value assigned to typeglob"),
			_ => return Err(self.die_msg("Not a GLOB reference")),
		}
		Ok(())
	}

	pub(super) fn fill_hash(&mut self, h: &Hv, values: impl IntoIterator<Item = Value>) -> PResult<()> {
		let mut values = values.into_iter();
		if let Some(obj) = self.tied_hash(h) {
			self.call_method(obj.clone(), "CLEAR", Vec::new(), Cx::Void)?;
			while let Some(key) = values.next() {
				let key = self.stringify(&key)?;
				let value = self.next_hash_value(&mut values, false, false);
				self.call_method(obj.clone(), "STORE", vec![Value::Str(key), value], Cx::Void)?;
			}
			return Ok(());
		}
		modules::check_hash_clear(self, h)?;
		let mut map = std::mem::take(&mut *h.entries_mut());
		map.clear();
		while let Some(k) = values.next() {
			let aggregate_ref = matches!(k, Value::Ref(Ref::Array(_) | Ref::Hash(_)));
			let key = HKey::from_pstr(self.stringify_owned(k)?);
			let value = self.next_hash_value(&mut values, map.is_empty(), aggregate_ref);
			modules::check_hash_access(self, h, &key, modules::HashAccess::Write)?;
			map.insert(key, new_sv(value));
		}
		h.replace_entries(map);
		h.iter.set(0);
		Ok(())
	}

	fn next_hash_value(&mut self, values: &mut impl Iterator<Item = Value>, first: bool, aggregate_ref: bool) -> Value {
		values.next().unwrap_or_else(|| {
			let message = if first && aggregate_ref { "Reference found where even-sized list expected" }
			else { "Odd number of elements in hash assignment" };
			self.warn_category("misc", message);
			Value::Undef
		})
	}

	fn assign_array(&mut self, array: &Av, values: impl IntoIterator<Item = Value>) -> PResult<()> {
		if Rc::weak_count(array) != 0 {
			// Both readonly marks and `each` cursors hold a Weak.
			if modules::readonly_array(self, array) { return Err(self.die_msg("Modification of a read-only value attempted")); }
			self.data.reset_array(array);
		}
		if let Some(object) = self.tied_array(array) {
			self.call_method(object.clone(), "CLEAR", Vec::new(), Cx::Void)?;
			let values: Vec<_> = values.into_iter().collect();
			if !values.is_empty() {
				self.call_method(object.clone(), "EXTEND", vec![Value::Int(values.len() as i64)], Cx::Void)?;
				for (index, value) in values.into_iter().enumerate() {
					self.call_method(object.clone(), "STORE", vec![Value::Int(index as i64), value], Cx::Void)?;
				}
			}
		} else {
			// Keep the allocation and every unobservable cell at its index (`@F = split ...`).
			// Aliased cells must be replaced, not overwritten. Readonly marks hold a Weak.
			let mut elems = array.replace_elems(Vec::new());
			let mut values = values.into_iter();
			let mut used = 0;
			for sv in &mut elems {
				let Some(v) = values.next() else { break; };
				if Rc::strong_count(sv) == 1 && Rc::weak_count(sv) == 0 && !sv.is_magical() && !sv.is_blessed() {
					value::track_cell(sv, &v);
					sv.set(v);
					sv.set_pos(None);
				} else { *sv = new_sv(v); }
				used += 1;
			}
			elems.truncate(used);
			elems.extend(values.map(new_sv));
			array.replace_elems(elems);
		}
		self.array_changed(array)
	}

	fn inplace_reverse(&mut self, lhs: &Expr, rhs: &Expr, cx: Cx) -> PResult<Option<Ret>> {
		let ExprKind::Variable(Sigil::Array, left) = &ungroup(lhs).kind else { return Ok(None); };
		let ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Reverse, origin), args: Some(arg), .. }) = &ungroup(rhs).kind else { return Ok(None); };
		let ExprKind::Variable(Sigil::Array, right) = &ungroup(arg).kind else { return Ok(None); };
		if left.as_ref() != right.as_ref() || !self.builtin_uses_core(Builtin::Reverse, *origin) { return Ok(None); }
		let array = self.eval_array(lhs)?;
		self.data.reset_array(&array);
		func::data::reverse_in_place(self, &array, cx).map(Some)
	}

	fn assign_my_scalar(&mut self, item: &Expr, value: Value) -> PResult<()> {
		let (target, binding) = self.declare_one(DeclKind::My, item)?;
		if let Some(binding) = binding && let Some(scope) = self.scopes.last_mut() { scope.declarations.push(binding); }
		if let Target::Scalar(sv) = target { self.write_sv(&sv, value)?; }
		Ok(())
	}

	fn assign_list(&mut self, lhs: &Expr, rhs: &Expr, capture: bool) -> PResult<(usize, Vec<Sv>)> {
		// Common sub prologue: snapshot the single argument before declaring the scalar,
		// exactly as list evaluation would, without either a value or a target vector.
		if !capture && self.pending.is_none() && self.depth < 8192
			&& let ExprKind::Variable(Sigil::Array, args) = &rhs.kind && args.as_ref() == "_"
			&& let ExprKind::Declare(DeclKind::My, _, inner, attrs) = &ungroup(lhs).kind && attrs.is_empty()
			&& self.pad_slot(Sigil::Array, args).is_none() && let Some((_, av, _)) = self.active_subs.last()
			&& self.tied_array(av).is_none() {
			let item = match &ungroup(inner).kind {
				ExprKind::List(items) if items.len() == 1 => ungroup(&items[0]),
				_ => ungroup(inner),
			};
			if matches!(&item.kind, ExprKind::Variable(Sigil::Scalar, _)) {
				let arg = {
					let elems = av.elems();
					match elems.as_slice() {
						[] => Some((0, Value::Undef)),
						[sv] if !sv.has_read_magic() => Some((1, sv.get())),
						_ => None,
					}
				};
				if let Some((count, value)) = arg {
					self.assign_my_scalar(item, value)?;
					return Ok((count, Vec::new()));
				}
			}
		}
		let mut values = self.eval_list(rhs)?;
		let count = values.len();
		if let ExprKind::Variable(Sigil::Array, name) = &ungroup(lhs).kind
			&& let Slot::Array(a) = self.variable_slot(Sigil::Array, name)? {
			self.assign_array(&a, values.drain(..))?;
			if matches!(&ungroup(rhs).kind, ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Split, _), .. })) {
				rx::recycle_list(self, values);
			}
			let cells = if capture { self.eval_array_aliases(&a, false)? } else { Vec::new() };
			return Ok((count, cells));
		}
		let mut values = values.into_iter();
		// `my ($a, $b, ...) = LIST`: fresh scalars, assigned as they are declared.
		if !capture && let ExprKind::Declare(DeclKind::My, _, inner, attrs) = &ungroup(lhs).kind && attrs.is_empty() {
			let items = match &ungroup(inner).kind { ExprKind::List(items) => items.as_slice(), _ => std::slice::from_ref(&**inner) };
			if items.iter().all(|e| matches!(&ungroup(e).kind, ExprKind::Variable(Sigil::Scalar, _))) {
				for item in items {
					self.assign_my_scalar(ungroup(item), values.next().unwrap_or(Value::Undef))?;
				}
				return Ok((count, Vec::new()));
			}
		}
		let mut targets = Vec::new();
		self.collect_targets(lhs, &mut targets)?;
		let mut result = Vec::new();
		for target in targets {
			match target {
				Target::Array(a) => {
					self.assign_array(&a, values.by_ref())?;
					if capture { result.extend(self.eval_array_aliases(&a, false)?); }
				}
				Target::Hash(h) => {
					self.fill_hash(&h, values.by_ref())?;
					if capture { result.extend(self.eval_hash_aliases(&h)?); }
				}
				Target::Scalar(sv) => {
					self.write_sv(&sv, values.next().unwrap_or(Value::Undef))?;
					if capture { result.push(sv); }
				}
				target => {
					let value = values.next().unwrap_or(Value::Undef);
					let saved = capture.then(|| value.clone());
					let assigned = self.write_target(target, value)?;
					if capture { result.push(new_sv(assigned.or(saved).unwrap_or(Value::Undef))); }
				}
			}
		}
		Ok((count, result))
	}

	pub(super) fn assign(&mut self, lhs: &Expr, rhs: &Expr, cx: Cx) -> PResult<Ret> {
		let site = ungroup(lhs) as *const Expr as usize;
		if let ExprKind::Declare(DeclKind::State, _, target, _) = &ungroup(lhs).kind && self.persistent.borrow().vars.contains_key(&site) {
			return self.read_declaration(DeclKind::State, None, target, &[], site, cx);
		}
		if Self::list_target(lhs) {
			if let Some(result) = self.inplace_reverse(lhs, rhs, cx)? { return Ok(result); }
			let (count, result) = self.assign_list(lhs, rhs, cx == Cx::List)?;
			if cx == Cx::List { self.read_alias_values(result).map(Ret::Many) }
			else { Ok(Ret::One(Value::Int(count as i64))) }
		} else {
			let value = self.eval_scalar(rhs)?;
			// A single scalar container (what `collect_targets` reduces these to), without the target list.
			let target = ungroup(lhs);
			if matches!(&target.kind, ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _)
				| ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _)) {
				let sv = match &target.kind {
					ExprKind::Variable(Sigil::Scalar, name) if let Some(Slot::Scalar(sv)) = self.pad_slot(Sigil::Scalar, name) => sv.clone(),
					_ => self.eval_lvalue(target)?,
				};
				if cx == Cx::Void { self.store_sv(&sv, value)?; return Ok(Ret::One(Value::Undef)); }
				let tied = self.scalar_tie(&sv).is_some();
				let stored = self.store_sv(&sv, value.clone())?;
				let assigned = if tied { Some(self.read_sv(&sv)?) } else { stored };
				return Ok(Ret::One(assigned.unwrap_or(value)));
			}
			// `my $x = EXPR`: the declaration's fresh scalar, without the target and pad lists.
			if let ExprKind::Declare(DeclKind::My, _, inner, attrs) = &target.kind && attrs.is_empty()
				&& let ExprKind::Variable(Sigil::Scalar, _) = &ungroup(inner).kind {
				let (decl, binding) = self.declare_one(DeclKind::My, ungroup(inner))?;
				if let Some(binding) = binding && let Some(scope) = self.scopes.last_mut() { scope.declarations.push(binding); }
				if let Target::Scalar(sv) = decl {
					if cx == Cx::Void { self.store_sv(&sv, value)?; return Ok(Ret::One(Value::Undef)); }
					let stored = self.store_sv(&sv, value.clone())?;
					return Ok(Ret::One(stored.unwrap_or(value)));
				}
				return Ok(Ret::One(value));
			}
			let mut targets = Vec::new();
			if matches!(&ungroup(lhs).kind, ExprKind::Call(Call { target: CallTarget::Named(..) | CallTarget::Code(..), .. })) {
				targets.push(Target::Scalar(self.eval_lvalue(lhs)?));
			} else { self.collect_targets(lhs, &mut targets)?; }
			let assigned = if let Some(target) = targets.into_iter().next() {
				// The assignment's value is its target: a tied target is FETCHed again when that value is used.
				let tied = match &target { Target::Scalar(sv) if cx != Cx::Void && self.scalar_tie(sv).is_some() => Some(sv.clone()), _ => None };
				// In void context the value is not needed afterwards: store it without copying.
				if cx == Cx::Void { self.write_target(target, value)?; return Ok(Ret::One(Value::Undef)); }
				let stored = self.write_target(target, value.clone())?;
				if let Some(sv) = tied { Some(self.read_sv(&sv)?) } else { stored }
			} else { None };
			Ok(Ret::One(assigned.unwrap_or(value)))
		}
	}

	/// Variable attributes go through `use attributes PKG, \$var, ATTRS` (MODIFY_SCALAR_ATTRIBUTES etc.); PKG is the
	/// declared class (`my Class $x : Attr`) or the current package.
	pub(super) fn apply_declared_attributes(&mut self, class: Option<&Rc<str>>, attrs: &[Attribute], targets: &[Target<'_>]) -> PResult<()> {
		if attrs.is_empty() { return Ok(()); }
		let names: Vec<Value> = attrs.iter().map(|attr| {
			let mut text = PStr::from_str(&attr.name);
			if let Some(args) = &attr.args { text.push_bytes(b"("); text.push(args); text.push_bytes(b")"); }
			Value::Str(text)
		}).collect();
		self.require_module("attributes")?;
		let package = class.cloned().unwrap_or_else(|| self.package());
		for target in targets {
			let reference = match target {
				Target::Scalar(sv) => Ref::Scalar(sv.clone()),
				Target::Array(av) => Ref::Array(av.clone()),
				Target::Hash(hv) => Ref::Hash(hv.clone()),
				_ => continue,
			};
			let mut args = vec![Value::str(&package), Value::Ref(reference)];
			args.extend(names.iter().cloned());
			self.call_method(Value::str("attributes"), "import", args, Cx::Void)?;
		}
		Ok(())
	}

	pub(super) fn read_declaration(&mut self, kind: DeclKind, class: Option<&Rc<str>>, target: &Expr, attrs: &[Attribute], site: usize, cx: Cx) -> PResult<Ret> {
		let ts = self.declare_targets(kind, target, site)?;
		if kind != DeclKind::Local { self.apply_declared_attributes(class, attrs, &ts)?; }
		let mut values = Vec::new();
		for t in ts {
			match t {
				Target::Scalar(s) => values.push(self.read_sv(&s)?),
				Target::Array(a) => values.extend(self.slot_value(Slot::Array(a), Sigil::Array, cx)?.list()),
				Target::Hash(h) => values.extend(self.slot_value(Slot::Hash(h), Sigil::Hash, cx)?.list()),
				Target::Glob(g) => values.push(Value::Glob(g)),
				Target::LastIndex(a) => values.push(Value::Int(self.array_len(&a)? as i64 - 1)),
				_ => {}
			}
		}
		Ok(Ret::Many(values).in_context(cx))
	}

	pub(super) fn undef_target(&mut self, e: &Expr) -> PResult<()> {
		match &ungroup(e).kind {
			ExprKind::Variable(Sigil::Code, name) | ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, .. }) => {
				if let Some(cv) = self.named_code(name) { cv.body.replace(CodeImpl::Undefined); }
				return Ok(());
			}
			_ => {}
		}
		let mut targets = Vec::new();
		self.collect_targets(e, &mut targets)?;
		for target in targets {
			match target {
				Target::Array(a) => self.assign_array(&a, std::iter::empty())?,
				Target::Hash(h) => {
					// hv_undef frees entries one at a time, so a DESTROY triggered by one sees the rest (and may add more).
					let holds_objects = || h.entries().values().any(|sv| matches!(sv.get(), Value::Ref(r) if r.blessed().is_some()));
					if self.tied_hash(&h).is_none() && holds_objects() {
						modules::check_hash_clear(self, &h)?;
						loop {
							let popped = h.entries_mut().pop();
							let Some((_, cell)) = popped else { break };
							h.iter.set(0);
							drop(cell);
							self.drain_destructors(false)?;
						}
					}
					self.fill_hash(&h, std::iter::empty())?;
					// `undef %h` frees the bucket array as well (unlike `%h = ()`).
					h.entries_mut().shrink_to_fit();
					if let Some((name, _)) = self.stashes.iter().find(|(_, stash)| Rc::ptr_eq(stash, &h)) {
						self.package_generations.remove(name);
					}
				}
				Target::Glob(g) => {
					g.scalar.replace(new_sv(Value::Undef)); g.array.replace(new_av(Vec::new())); g.hash.replace(new_hv()); g.code.replace(None); g.io.replace(None);
				}
				t => { self.write_target(t, Value::Undef)?; }
			}
		}
		Ok(())
	}

	pub(super) fn exists(&mut self, e: &Expr) -> PResult<bool> {
		match &ungroup(e).kind {
			ExprKind::Select(base, select, key) => match self.element(base, *select, key, true)? {
				Some(Element::Hash(h, key)) => {
					if let Some(obj) = self.tied_hash(&h) {
						let exists = self.call_method(obj, "EXISTS", vec![Value::Str(key.to_pstr())], Cx::Scalar)?.scalar();
						self.truthy(&exists)
					} else { Ok(h.entries().contains_key(&key)) }
				}
				Some(Element::Array(a, index)) => {
					if let Some(obj) = self.tied_array(&a) {
						let index = self.tied_array_index(&a, &obj, index)?;
						let exists = self.call_method(obj, "EXISTS", vec![Value::Int(index)], Cx::Scalar)?.scalar();
						self.truthy(&exists)
					} else { Ok(self.array_cell(&a, index, false)?.is_some()) }
				}
				None => Ok(false),
			},
			ExprKind::Variable(Sigil::Code, name) | ExprKind::Call(Call { target: CallTarget::Named(name, _), .. }) => Ok(self.named_code(name).is_some()),
			ExprKind::Deref(Sigil::Code, source) | ExprKind::Call(Call { target: CallTarget::Code(source, true), args: None, .. }) =>
				Ok(self.exempt_code(source, false)?.is_some()),
			_ => Err(self.die_msg("exists argument is not a HASH or ARRAY element or a subroutine")),
		}
	}

	pub(super) fn delete(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		let (cells, single) = self.delete_cells(e)?;
		let mut values = Vec::with_capacity(cells.len());
		for sv in &cells { values.push(self.read_sv(sv)?); }
		if single { Ok(Ret::One(values.pop().unwrap_or(Value::Undef))) } else { Ok(Ret::Many(values).in_context(cx)) }
	}

	/// Remove the elements named by `delete`'s operand, returning the removed containers (`\delete $h{k}` is the old
	/// `\$h{k}`) and whether the operand was a single element.
	pub(super) fn delete_cells(&mut self, e: &Expr) -> PResult<(Vec<Sv>, bool)> {
		let (e, local) = if let ExprKind::Declare(DeclKind::Local, _, e, _) = &ungroup(e).kind { (ungroup(e), true) } else { (ungroup(e), false) };
		let ExprKind::Select(base, select, key) = &e.kind else { return Err(self.die_msg("delete argument is not a HASH or ARRAY element or slice")); };
		match select {
			Select::ArrayElement(_) | Select::HashElement(_) => {
				let sv = match self.element(base, *select, key, true)? { Some(el) => self.delete_elem(el, local)?, None => new_sv(Value::Undef) };
				Ok((vec![sv], true))
			}
			Select::ArraySlice(_) | Select::ArrayPairs(_) | Select::HashSlice(_) | Select::HashPairs(_) => {
				let pairs = matches!(select, Select::ArrayPairs(_) | Select::HashPairs(_));
				let mut result = Vec::new();
				for (value, el) in self.slice(base, *select, key, true)? {
					if pairs { result.push(new_sv(value)); }
					result.push(match el { Some(el) => self.delete_elem(el, local)?, None => new_sv(Value::Undef) });
				}
				Ok((result, false))
			}
			_ => Err(self.die_msg("delete argument is not a HASH or ARRAY element or slice")),
		}
	}

	fn tied_element(&mut self, el: &Element) -> PResult<Option<(Value, Value)>> {
		Ok(match el {
			Element::Array(a, index) => if let Some(object) = self.tied_array(a) {
				let index = self.tied_array_index(a, &object, *index)?;
				Some((object, Value::Int(index)))
			} else { None },
			Element::Hash(h, key) => self.tied_hash(h).map(|object| (object, Value::Str(key.to_pstr()))),
		})
	}

	fn delete_elem(&mut self, el: Element, local: bool) -> PResult<Sv> {
		if local { return self.local_elem(el, true); }
		if let Some((object, key)) = self.tied_element(&el)? { return self.call_method(object, "DELETE", vec![key], Cx::Scalar).map(|r| new_sv(r.scalar())); }
		Ok(match el {
			Element::Hash(h, k) => {
				modules::check_hash_access(self, &h, &k, modules::HashAccess::Delete)?;
				let removed = h.entries_mut().shift_remove_full(&k);
				if let Some((i, key, sv)) = removed {
					let cursor = h.iter.get();
					if i < cursor { h.iter.set(cursor - 1); }
					let name = key.to_pstr();
					if let Some(suffix) = name.bytes.strip_suffix(b"::")
						&& let Some((parent, _)) = self.stashes.iter().find(|(_, stash)| Rc::ptr_eq(stash, &h)) {
						let name = PStr::new(suffix.to_vec(), name.utf8);
						let name = name.to_string_lossy();
						let package = if parent.as_ref() == "main" { name.into_owned() } else { format!("{parent}::{name}") };
						self.remove_package(&package);
					}
					sv
				} else { new_sv(Value::Undef) }
			}
			Element::Array(a, n) => {
				let Some(i) = self.array_index(&a, n, false)? else { return Ok(new_sv(Value::Undef)); };
				if modules::readonly_array(self, &a) { return Err(self.die_msg("Modification of a read-only value attempted")); }
				let mut elems = a.elems_mut();
				let old = elems.get_mut(i).map(|s| std::mem::replace(s, self.hole.clone()));
				if i + 1 == elems.len() {
					while elems.last().is_some_and(|s| Rc::ptr_eq(s, &self.hole)) { elems.pop(); }
				}
				old.map_or_else(|| new_sv(Value::Undef), |s| if Rc::ptr_eq(&s, &self.hole) { new_sv(Value::Undef) } else { s })
			}
		})
	}

	/// Alias leaves for which neither evaluation nor lvalue resolution can call Perl.
	fn plain_alias(&mut self, e: &Expr) -> Option<Sv> {
		if self.pending.is_some() || self.depth >= 8190 { return None; }
		match &e.kind {
			ExprKind::Variable(Sigil::Scalar, name) if plain_lower_name(name) => {
				match self.pad_slot(Sigil::Scalar, name) { Some(Slot::Scalar(sv)) => Some(sv.clone()), _ => None }
			}
			ExprKind::Int(n) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(self.readonly_alias(Value::Int(*n))),
			_ => None,
		}
	}

	/// Evaluate a list in aliasing context (foreach, map, grep and `@_`).
	pub fn eval_aliases(&mut self, e: &Expr) -> PResult<Vec<Sv>> {
		let e = ungroup(e);
		if let Some(sv) = self.plain_alias(e) { return Ok(vec![sv]); }
		self.at_location(&e.location, |this| this.nested(|this| this.aliases_inner(e)))
	}

	pub(super) fn readonly_alias(&mut self, value: Value) -> Sv {
		if self.readonly_literals.len() >= self.readonly_sweep {
			self.readonly_literals.retain(|_, sv| sv.strong_count() != 0);
			self.readonly_sweep = self.readonly_literals.len().saturating_mul(2).max(256);
		}
		let sv = new_sv(value);
		sv.register();
		self.readonly_literals.insert(Rc::as_ptr(&sv) as usize, Rc::downgrade(&sv));
		sv
	}

	fn aliases_inner(&mut self, e: &Expr) -> PResult<Vec<Sv>> {
		match &e.kind {
			ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) | ExprKind::Version(_)
			| ExprKind::Special(Special::File | Special::Line | Special::Package(_)) => {
				let value = self.eval_scalar(e)?;
				Ok(vec![self.readonly_alias(value)])
			}
			ExprKind::List(items) => {
				let mut list = Vec::with_capacity(items.len());
				for item in items {
					let e = ungroup(item);
					if let Some(sv) = self.plain_alias(e) { list.push(sv); }
					else { list.extend(self.at_location(&e.location, |this| this.nested(|this| this.aliases_inner(e)))?); }
				}
				Ok(list)
			}
			ExprKind::Declare(kind, _, target, _) => {
				let mut out = Vec::new();
				for target in self.declare_targets(*kind, target, e as *const Expr as usize)? {
					match target {
						Target::Scalar(s) => out.push(s),
						Target::Array(a) => out.extend(self.eval_array_aliases(&a, true)?),
						Target::Hash(h) => out.extend(self.eval_hash_aliases(&h)?),
						_ => {}
					}
				}
				Ok(out)
			}
			ExprKind::Variable(Sigil::Scalar, name) if self.readonly_scalar(name) => {
				let value = self.eval_scalar(e)?;
				Ok(vec![self.readonly_alias(value)])
			}
			ExprKind::Variable(Sigil::Scalar, name) if self.magic_scalar(name).is_some() => self.eval_lvalue(e).map(|s| vec![s]),
			// Aliasing an existing hash element is a read, and a negative index before the array's start only fails
			// when the alias is assigned (defelem: perl only stores when the alias is written).
			ExprKind::Select(base, select @ (Select::HashElement(_) | Select::ArrayElement(_)), key) => {
				let cell = match self.element(base, *select, key, true)? {
					Some(Element::Hash(h, k)) if self.tied_hash(&h).is_none() => {
						let existing = h.entries().get(&k).cloned();
						if existing.is_some() {
							if Rc::weak_count(&h) != 0 { modules::check_hash_access(self, &h, &k, modules::HashAccess::Read)?; }
							existing
						} else {
							// A missing key is deferred: only a write through the alias creates it.
							Some(new_lvalue(Lvalue::HashElement(h, k)))
						}
					}
					// So is an index outside the array (`f($a[10])` must not extend @a; a negative one dies only on write).
					Some(Element::Array(a, i)) if self.tied_array(&a).is_none() && {
						let len = self.array_len(&a)? as i64;
						if i < 0 { i.saturating_add(len) < 0 } else { i >= len }
					} => Some(new_lvalue(Lvalue::ArrayElement(a, i))),
					Some(el) => self.element_cell(el, true)?,
					None => None,
				};
				cell.map(|s| vec![s]).ok_or_else(|| self.die_msg("Modification of a read-only value attempted"))
			}
			ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) => self.eval_lvalue(e).map(|s| vec![s]),
			ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => {
				let a = self.eval_array(e)?;
				self.eval_array_aliases(&a, true)
			}
			ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => {
				let h = self.eval_hash(e)?;
				self.eval_hash_aliases(&h)
			}
			ExprKind::Select(base, sel @ (Select::ArraySlice(_) | Select::HashSlice(_) | Select::ArrayPairs(_) | Select::HashPairs(_)), key) => {
				let selected = self.slice(base, *sel, key, true)?;
				let mut result = Vec::with_capacity(selected.len());
				for (key, el) in selected {
					if matches!(sel, Select::ArrayPairs(_) | Select::HashPairs(_)) { result.push(new_sv(key)); }
					result.push(match el { Some(el) => self.element_cell(el, true)?.unwrap_or_else(|| new_sv(Value::Undef)), None => new_sv(Value::Undef) });
				}
				Ok(result)
			}
			ExprKind::Conditional(cond, yes, no) => {
				let v = self.eval_scalar(cond)?;
				let branch = if self.truthy(&v)? { yes } else { no };
				self.eval_aliases(branch)
			}
			// `for (A || B)`: the chosen operand is aliased (lvalue-ish context reaches both sides), but a subscript
			// on the left is only read, never autovivified.
			ExprKind::Binary(op @ (Binary::Or | Binary::DefinedOr | Binary::And), first, second) => {
				let lhs = if matches!(&ungroup(first).kind, ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _)
					| ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Pos | Builtin::Substr | Builtin::Vec, _), .. })) {
					self.eval_aliases(first)?.pop().unwrap_or_else(|| new_sv(Value::Undef))
				} else { new_sv(self.eval_scalar(first)?) };
				let value = self.read_sv(&lhs)?;
				let keep = match op {
					Binary::Or => self.truthy(&value)?,
					Binary::DefinedOr => !value.is_undef(),
					_ => !self.truthy(&value)?,
				};
				if keep { Ok(vec![lhs]) } else { self.eval_aliases(second) }
			}
			// `shift`/`pop` hand back the removed element itself (`${\shift}` in an lvalue sub aliases the argument).
			ExprKind::Call(Call { target: CallTarget::Builtin(b @ (Builtin::Shift | Builtin::Pop), origin), args, .. })
				if self.builtin_uses_core(*b, *origin) => {
				let operand = args.as_deref().filter(|e| !matches!(&ungroup(e).kind, ExprKind::List(items) if items.is_empty()));
				let av = match operand {
					Some(operand) if matches!(&ungroup(operand).kind, ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _)) => self.eval_array(operand)?,
					Some(_) => return Ok(aliases(self.eval_list(e)?)),
					None => self.default_array(),
				};
				if self.tied_array(&av).is_some() || modules::readonly_array(self, &av) { return Ok(aliases(self.eval_list(e)?)); }
				self.data.reset_array(&av);
				let removed = if *b == Builtin::Shift {
					let mut elems = av.elems_mut();
					if elems.is_empty() { None } else { Some(elems.remove(0)) }
				} else { av.elems_mut().pop() };
				self.array_changed(&av)?;
				Ok(vec![match removed { Some(sv) if !Rc::ptr_eq(&sv, &self.hole) => sv, _ => new_sv(Value::Undef) }])
			}
			// A constant sub's values are read-only, like the literals perl inlines for them.
			ExprKind::Call(Call { target: CallTarget::Named(name, false), .. })
				if self.named_code(name).is_some_and(|cv| matches!(*cv.body.borrow(), CodeImpl::Constant(_))) => {
				let values = self.eval_list(e)?;
				Ok(values.into_iter().map(|v| self.readonly_alias(v)).collect())
			}
			// `lock $x` returns `$x` itself.
			ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Lock, origin), args: Some(operand), .. })
				if self.builtin_uses_core(Builtin::Lock, *origin) && matches!(&ungroup(operand).kind,
					ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) | ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _)) =>
				self.eval_aliases(operand),
			// `scalar(EXPR)` passes on the scalar EXPR yields, so `f(scalar substr(...))` aliases the substring.
			ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Scalar, origin), args: Some(operand), .. })
				if self.builtin_uses_core(Builtin::Scalar, *origin) && matches!(&ungroup(operand).kind,
					ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _)
					| ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _)
					| ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Substr | Builtin::Vec | Builtin::Pos, _), .. })) => self.eval_aliases(operand),
			ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Delete, origin), args: Some(operand), .. })
				if self.builtin_uses_core(Builtin::Delete, *origin) => self.delete_cells(operand).map(|(cells, _)| cells),
			ExprKind::Call(call @ Call { target: CallTarget::Builtin(b @ (Builtin::Substr | Builtin::Vec | Builtin::Pos), origin), .. })
				if self.builtin_uses_core(*b, *origin) => {
					if let Some(result) = func::lvalue(self, *b, call) { Ok(vec![result?]) }
					else { Ok(aliases(self.eval_list(e)?)) }
				}
			ExprKind::Call(call @ Call { target: CallTarget::Builtin(b, origin), .. })
				if matches!(b, Builtin::Values | Builtin::Grep | Builtin::Sort)
					&& (*origin == BuiltinOrigin::Core || *origin == BuiltinOrigin::Implicit
						&& self.global_override(*b).is_none()) => {
					match b {
						Builtin::Values => func::data::value_aliases(self, call),
						Builtin::Sort => self.sort_aliases(call),
						_ => self.grep_aliases(call),
					}
				}
			ExprKind::Call(call @ Call { target: CallTarget::Named(name, _), .. }) if self.named_lvalue(name) => {
				let mut out = Vec::new();
				for item in self.call_lvalue_list(call)? {
					match item {
						Value::Ref(Ref::Scalar(sv)) => out.push(sv),
						Value::Ref(Ref::Array(av)) => out.extend(self.eval_array_aliases(&av, true)?),
						Value::Ref(Ref::Hash(hv)) => out.extend(self.eval_hash_aliases(&hv)?),
						other => out.push(new_sv(other)),
					}
				}
				Ok(out)
			}
			ExprKind::Binary(Binary::Assign, target, rhs) => {
				if Self::list_target(target) {
					self.assign_list(target, rhs, true).map(|(_, cells)| cells)
				} else { self.eval_lvalue(e).map(|s| vec![s]) }
			}
			_ => Ok(match self.eval(e, Cx::List)? {
				Ret::One(v) => vec![new_sv(v)],
				Ret::Many(values) => aliases(values),
			}),
		}
	}

	/// Return array element aliases, materializing holes so writes affect only their own slot.
	pub fn array_aliases(&self, a: &Av) -> Vec<Sv> {
		a.elems_mut().iter_mut().map(|sv| {
			if Rc::ptr_eq(sv, &self.hole) { *sv = new_sv(Value::Undef); }
			sv.clone()
		}).collect()
	}
}
