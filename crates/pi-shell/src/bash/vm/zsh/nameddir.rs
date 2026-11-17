//! zsh named directories: a port of zsh 5.9 `hashnameddir.c` (the
//! `nameddirtab` hash table and its printing), `utils.c` `adduserdir`,
//! `getnameddir`, `finddir`, `dircmp`, `fprintdir`, `substnamedir` and
//! `subst_string_by_hook` for the `zsh_directory_name` hook.
//!
//! Scalar assignments check the stored names without rebuilding the hash
//! table; only assignments that can change an entry materialize it.
//!
//! The table lives in the store ([`MiscKey::ZshNamedDirs`]) in zsh's hash
//! order (201 buckets, see [`ZHash`]), so `${(k)nameddirs}` lists names as
//! zsh does. Like zsh, a non-interactive shell adds no entries from
//! parameters or the password database (`adduserdir` returns early); `hash
//! -d name=dir` and `$nameddirs` always do.
//!
//! The `zsh_directory_name` hook (and `zsh_directory_name_functions`)
//! functions run in the current shell, as zsh's `doshfunc` calls them: the
//! expansion parks while each call runs above it, then reads `reply`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};

use super::{
	assoc_order::ZHash,
	params::{self, PmFlags, opt},
};
use crate::bash::{
	fs::PwQuery,
	store::{Key, KeyBuf, MiscKey, Record},
	syntax::zsh::tok::{metafy, tail},
	vm::{
		expand::{Expander, Stop, X},
		fsprobe::FsReq,
		proc::{Atom, Probe},
		state,
	},
	zshopt::ZshOpt,
};

/// `ND_USERNAME`: the entry comes from the password database.
pub const ND_USERNAME: u8 = 1 << 1;
/// `ND_NOABBREV`: never used to abbreviate a path (`PWD`, `OLDPWD`).
pub const ND_NOABBREV: u8 = 1 << 2;

/// zsh `createnameddirtable`: `newhashtable(201, …)`.
const BUCKETS: usize = 201;

/// zsh's `PATH_MAX` bound in `adduserdir`.
const PATH_MAX: usize = 1024;

/// zsh's named directory table.
#[derive(Clone, Debug)]
pub struct NamedDirs {
	/// Name to flags byte followed by the directory.
	table: ZHash,
}

/// One named directory.
#[derive(Clone, Copy, Debug)]
pub struct Entry<'a> {
	/// Name.
	pub name:  &'a [u8],
	/// `ND_*` flags.
	pub flags: u8,
	/// Directory.
	pub dir:   &'a [u8],
}

impl NamedDirs {
	/// The table a [`MiscKey::ZshNamedDirs`] record holds.
	pub fn from_record(rec: Option<&Record>) -> Self {
		let table = match rec {
			Some(Record::Words(w)) if !w.is_empty() => {
				let grown = w[0].to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(0);
				let items = tail(w, 1)
					.as_chunks::<2>()
					.0
					.iter()
					.map(|p| (p[0].clone(), p[1].clone()));
				ZHash::from_items(items, BUCKETS, grown)
			},
			_ => ZHash::with_buckets(BUCKETS),
		};
		Self { table }
	}

	/// The record that keeps this table (`None`: a new empty table).
	pub fn to_record(&self) -> Option<Record> {
		if self.table.is_empty() && self.table.grown() == 0 {
			return None;
		}
		let mut w = Vec::with_capacity(1 + 2 * self.table.len());
		w.push(BString::from(self.table.grown().to_string()));
		for (k, v) in self.table.iter() {
			w.push(k.clone());
			w.push(v.clone());
		}
		Some(Record::Words(w))
	}

	/// The entry `name`.
	pub fn get<'a>(&'a self, name: &'a [u8]) -> Option<Entry<'a>> {
		self.table.get(name).map(|v| entry(name, v))
	}

	/// zsh `addnameddirnode`: add or replace `name`.
	pub fn add(&mut self, name: &[u8], dir: &[u8], flags: u8) {
		let mut v = Vec::with_capacity(dir.len() + 1);
		v.push(flags);
		v.extend_from_slice(dir);
		self.table.insert(BString::from(name), BString::from(v));
	}

	/// zsh `removenameddirnode`: whether `name` was there.
	pub fn remove(&mut self, name: &[u8]) -> bool {
		self.table.remove(name).is_some()
	}

	/// zsh `emptynameddirtable`.
	pub fn clear(&mut self) {
		self.table.clear();
	}

	/// The entries in zsh's hash order.
	pub fn entries(&self) -> impl Iterator<Item = Entry<'_>> {
		self.table.iter().map(|(k, v)| entry(k, v))
	}

	/// The entries sorted by name (zsh's sorted `scanhashtable`).
	pub fn sorted(&self) -> Vec<Entry<'_>> {
		let mut v: Vec<Entry<'_>> = self.entries().collect();
		v.sort_by(|a, b| a.name.cmp(b.name));
		v
	}
}

/// An entry from its stored value.
fn entry<'a>(name: &'a [u8], v: &'a [u8]) -> Entry<'a> {
	Entry { name, flags: v.first().copied().unwrap_or(0), dir: tail(v, 1) }
}

/// The named directory table `ex`'s shell sees.
///
/// # Errors
/// A store failure.
pub fn load(ex: &mut Expander<'_, '_>) -> X<NamedDirs> {
	Ok(NamedDirs::from_record(state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshNamedDirs))?))
}

/// Store `t` as `ex`'s shell's table.
pub fn save(ex: &mut Expander<'_, '_>, t: &NamedDirs) {
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshNamedDirs),
		t.to_record(),
	);
}

/// zsh `adduserdir(s, t, flags, always)`: name `s` for directory `t` in
/// an interactive shell (a parameter assignment, `always` false, only
/// updates an existing entry unless `AUTO_NAME_DIRS` is set); a value
/// that is no absolute path removes the entry.
///
/// # Errors
/// A store failure.
pub fn adduserdir(ex: &mut Expander<'_, '_>, s: &[u8], t: &[u8], flags: u8, always: bool) -> X<()> {
	if !opt(ex, ZshOpt::Interactive)? {
		return Ok(());
	}
	let present = match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshNamedDirs))? {
		Some(Record::Words(w)) => tail(w, 1)
			.as_chunks::<2>()
			.0
			.iter()
			.any(|p| p[0].as_slice() == s),
		_ => false,
	};
	if flags & ND_USERNAME != 0 && present {
		return Ok(());
	}
	if !always && !opt(ex, ZshOpt::Autonamedirs)? && !present {
		return Ok(());
	}
	let absolute = t.first() == Some(&b'/') && t.len() < PATH_MAX;
	if !absolute && !present {
		return Ok(());
	}
	let mut tab = load(ex)?;
	if !absolute {
		if tab.remove(s) {
			save(ex, &tab);
		}
		return Ok(());
	}
	let mut end = t.len();
	while end > 0 && t[end - 1] == b'/' {
		end -= 1;
	}
	// Leading slashes alone stay as they are (`//` may mean something).
	let dir = if end == 0 { t } else { &t[..end] };
	let flags = if s == b"PWD" || s == b"OLDPWD" {
		flags | ND_NOABBREV
	} else {
		flags
	};
	tab.add(s, dir, flags);
	save(ex, &tab);
	Ok(())
}

/// zsh `strsetfn`'s named-directory step: a scalar `name` was set to
/// `value` (zsh `PM_NAMEDDIR`, or any scalar under `AUTO_NAME_DIRS`).
///
/// # Errors
/// A store failure.
pub fn scalar_assigned(ex: &mut Expander<'_, '_>, name: &[u8], value: &[u8]) -> X<()> {
	adduserdir(ex, name, value, 0, false)
}

/// zsh `getnameddir`: the directory `~name` stands for: a named
/// directory, a scalar parameter holding an absolute path, or a user's
/// home directory.
///
/// # Errors
/// A store failure.
pub fn getnameddir(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	if let Some(e) = load(ex)?.get(name) {
		return Ok(Some(BString::from(e.dir)));
	}
	if let Some(p) = params::getparam(ex, name)?
		&& p.flags.type_bits() == PmFlags::SCALAR
		&& !p.flags.contains(PmFlags::UNSET)
	{
		let v = p.strval(params::mb(ex)?);
		if v.first() == Some(&b'/') {
			adduserdir(ex, name, &v, 0, true)?;
			return Ok(Some(v));
		}
	}
	if let Some(home) = user_home(ex, name)? {
		adduserdir(ex, name, &home, ND_USERNAME, true)?;
		return Ok(Some(home));
	}
	Ok(None)
}

/// The home directory of user `name` from the password database (zsh
/// `getpwnam`); a host without one knows only the current user.
fn user_home(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	if let Some(users) = user_db(ex, PwQuery::UserName(BString::from(name)))? {
		return Ok(users.into_iter().next().map(|(_, dir)| dir));
	}
	let me = ex.cx.host.user();
	Ok((me.name.as_slice() == name).then_some(me.home))
}

/// A user database lookup through the pollable file system: `(name,
/// home)` of each entry; `None` when the host has no database. The first
/// pass parks the op ([`Stop::Probe`]); the replay reads the logged answer.
fn user_db(ex: &mut Expander<'_, '_>, q: PwQuery) -> X<Option<Vec<(BString, BString)>>> {
	let atom = ex.log.get(ex.cursor).cloned();
	ex.cursor += usize::from(atom.is_some());
	match atom {
		Some(Atom::List(v)) => Ok(Some(
			v.as_chunks::<2>()
				.0
				.iter()
				.map(|p| (p[0].clone(), p[1].clone()))
				.collect(),
		)),
		Some(_) => Ok(None),
		None => Err(Stop::Probe(Probe::Fs { seq: 0, req: Box::new(FsReq::UserDb(q)) })),
	}
}

/// zsh `fillnameddirtable`: every user of the password database as a
/// named directory (`ND_USERNAME`; only an interactive shell keeps them).
///
/// # Errors
/// The database lookup to make first; a store failure.
pub fn fill(ex: &mut Expander<'_, '_>) -> X<()> {
	if !opt(ex, ZshOpt::Interactive)? {
		return Ok(());
	}
	let users = if let Some(u) = user_db(ex, PwQuery::AllUsers)? {
		u
	} else {
		let me = ex.cx.host.user();
		vec![(me.name, me.home)]
	};
	for (name, dir) in users {
		adduserdir(ex, &name, &dir, ND_USERNAME, true)?;
	}
	Ok(())
}

/// A named directory prefix of a path (zsh `finddir`'s result).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
	/// The name: empty for `$HOME`, `[…]` for a `zsh_directory_name`
	/// answer.
	pub name:    BString,
	/// Bytes of the path the name stands for.
	pub dir_len: usize,
}

/// zsh `dircmp`: whether `dir` is `s` or a directory above it.
fn dircmp(dir: &[u8], s: &[u8]) -> bool {
	s.starts_with(dir) && matches!(s.get(dir.len()), None | Some(b'/'))
}

/// zsh `finddir`: the named directory (or `$HOME`, or a
/// `zsh_directory_name` answer) that abbreviates the most of `s`.
///
/// # Errors
/// The hook's command substitution to run first; a store failure.
pub fn finddir(ex: &mut Expander<'_, '_>, s: &[u8]) -> X<Option<Found>> {
	let home = params::getsparam(ex, b"HOME")?.unwrap_or_default();
	// `homenode.diff` is 0 for `/`: never an abbreviation.
	let (mut best, mut found) = if home.len() > 1 && dircmp(&home, s) {
		(home.len(), Some(Found { name: BString::default(), dir_len: home.len() }))
	} else {
		(0, None)
	};
	let tab = load(ex)?;
	for e in tab.entries() {
		let diff = e.dir.len().saturating_sub(e.name.len());
		if diff > best && e.flags & ND_NOABBREV == 0 && dircmp(e.dir, s) {
			best = diff;
			found = Some(Found { name: BString::from(e.name), dir_len: e.dir.len() });
		}
	}
	if let Some(ares) = dirname_hook(ex, b"d", s)?
		&& ares.len() >= 2
	{
		let len = usize::try_from(params::parse_int(&ares[1])).unwrap_or(0);
		if len > best {
			let mut name = BString::from("[");
			name.extend_from_slice(&ares[0]);
			name.push(b']');
			found = Some(Found { name, dir_len: len.min(s.len()) });
		}
	}
	Ok(found)
}

/// zsh `fprintdir`/`promptpath`'s abbreviation: `s` with its named
/// directory prefix as `~name`.
///
/// # Errors
/// As [`finddir`].
pub fn abbreviate(ex: &mut Expander<'_, '_>, s: &[u8]) -> X<BString> {
	Ok(match finddir(ex, s)? {
		Some(f) => tilde_form(&f, s),
		None => BString::from(s),
	})
}

/// `s` with the prefix `f` names replaced by `~name`.
pub fn tilde_form(f: &Found, s: &[u8]) -> BString {
	let mut out = BString::from("~");
	out.extend_from_slice(&f.name);
	out.extend_from_slice(tail(s, f.dir_len));
	out
}

/// Whether shell function `f` is defined and enabled (zsh `getshfunc`).
fn defined(ex: &mut Expander<'_, '_>, f: &[u8]) -> X<bool> {
	if let Some(Record::Words(w)) =
		state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshDisabledFuncs))?
		&& w.iter().any(|d| d.as_slice() == f)
	{
		return Ok(false);
	}
	Ok(state::record(ex.cx.store, ex.vp, Key::Func(BStr::new(f)))?.is_some())
}

/// `s` single-quoted for zsh source.
fn squote(s: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len() + 2);
	out.push(b'\'');
	for &c in s {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
	out
}

/// zsh `subst_string_by_hook("zsh_directory_name", arg1, orig)`: the
/// `reply` array of the first hook function that succeeds with one set
/// (`zsh_directory_name`, then each function `zsh_directory_name_functions`
/// names, read after the first ran); `None` when there is no hook or none
/// answered. The functions run in the current shell (zsh `doshfunc`):
/// what they print goes to the shell's output, what they change stays;
/// `$?` is the caller's afterwards.
///
/// # Errors
/// The call to run first; a store failure.
pub fn dirname_hook(
	ex: &mut Expander<'_, '_>,
	arg1: &[u8],
	orig: &[u8],
) -> X<Option<Vec<BString>>> {
	if defined(ex, b"zsh_directory_name")?
		&& let Some(reply) = dirname_call(ex, b"zsh_directory_name", arg1, orig)?
	{
		return Ok(Some(reply));
	}
	for f in params::getaparam(ex, b"zsh_directory_name_functions")?.unwrap_or_default() {
		if defined(ex, &f)?
			&& let Some(reply) = dirname_call(ex, &f, arg1, orig)?
		{
			return Ok(Some(reply));
		}
	}
	Ok(None)
}

/// zsh `subst_string_by_func`: call `f arg1 orig`; `reply` (an array) if
/// it returned 0.
fn dirname_call(
	ex: &mut Expander<'_, '_>,
	f: &[u8],
	arg1: &[u8],
	orig: &[u8],
) -> X<Option<Vec<BString>>> {
	let mut call = squote(f);
	for a in [arg1, orig] {
		call.push(b' ');
		call.extend_from_slice(&squote(a));
	}
	call.push(b'\n');
	if super::subst::call_here(ex, &metafy(&call))? != 0 {
		return Ok(None);
	}
	params::getaparam(ex, b"reply")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn table_round_trips_through_its_record() {
		let mut t = NamedDirs::from_record(None);
		t.add(b"dot", b"/home/u/.dotfiles", 0);
		t.add(b"root", b"/var/root", ND_USERNAME);
		let back = NamedDirs::from_record(t.to_record().as_ref());
		let e = back.get(b"root").expect("root entry");
		assert_eq!((e.flags, e.dir), (ND_USERNAME, &b"/var/root"[..]));
		assert_eq!(back.sorted().iter().map(|e| e.name).collect::<Vec<_>>(), [&b"dot"[..], b"root"]);
	}

	#[test]
	fn dircmp_matches_at_a_path_boundary() {
		assert!(dircmp(b"/usr", b"/usr"));
		assert!(dircmp(b"/usr", b"/usr/bin"));
		assert!(!dircmp(b"/usr", b"/usrx"));
		assert!(!dircmp(b"/", b"/usr"));
	}
}
