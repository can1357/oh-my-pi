//! zsh/mapfile: the `mapfile` special association, whose keys are file
//! names (relative to the current directory) and values their contents.
//!
//! Reading an element reads the file, assigning one writes it, unsetting
//! one removes it; listing the keys lists the current directory with every
//! value empty (zsh never reads every file to scan). Each file operation is
//! a [`Probe::Fs`] taken from inside the expansion: the first pass parks
//! the op, the replay reads the logged answer ([`ask`]).
//!
//! Ported from zsh 5.9 `Src/Modules/mapfile.c` (MIT-style licence,
//! Copyright (c) 1998-2001 Peter Stephenson and the zsh development group).

use bstr::BString;

use crate::bash::{
	store::{Key, KeyBuf, MiscKey, Record},
	vm::{
		expand::{Expander, Stop, X},
		fsprobe::FsReq,
		probe::absolute,
		proc::{Atom, Probe},
		state,
		zsh::params::PValue,
	},
};

/// The logged answer to `req`, or a stop that parks the op to ask it.
fn ask(ex: &mut Expander<'_, '_>, req: FsReq) -> X<Atom> {
	if let Some(atom) = ex.log.get(ex.cursor).cloned() {
		ex.cursor += 1;
		return Ok(atom);
	}
	let seq = u32::try_from(ex.cursor).unwrap_or(u32::MAX);
	Err(Stop::Probe(Probe::Fs { seq, req: Box::new(req) }))
}

/// Whether `unset mapfile` left the special unset (zsh's `PM_UNSET` on it).
///
/// # Errors
/// A store failure.
pub fn is_unset(ex: &mut Expander<'_, '_>) -> X<bool> {
	Ok(state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshMapfileUnset))?.is_some())
}

/// Mark the special unset (`true`) or set again.
pub fn mark_unset(ex: &mut Expander<'_, '_>, unset: bool) {
	let rec = unset.then(|| Record::Misc(BString::from("1")));
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshMapfileUnset),
		rec,
	);
}

/// An assignment makes an unset special set again (zsh's `createparam`
/// clears `PM_UNSET` on a special).
///
/// # Errors
/// A store failure.
pub fn revive(ex: &mut Expander<'_, '_>) -> X<()> {
	if is_unset(ex)? {
		mark_unset(ex, false);
	}
	Ok(())
}

/// `name` as the file system sees it (relative to the vproc's directory).
fn path_of(ex: &Expander<'_, '_>, name: &[u8]) -> BString {
	if name.is_empty() {
		return BString::default();
	}
	absolute(&ex.vp.cwd, name)
}

/// zsh `scanpmmapfile`: every entry of the current directory, each with an
/// empty value; nothing when the directory cannot be listed. `None` (unset)
/// after `unset mapfile`.
///
/// # Errors
/// A parked probe, a store failure.
pub fn scan(ex: &mut Expander<'_, '_>) -> X<Option<PValue>> {
	if is_unset(ex)? {
		return Ok(None);
	}
	let dir = ex.vp.cwd.clone();
	let names = match ask(ex, FsReq::ReadDir { path: dir })? {
		Atom::List(names) => names,
		_ => Vec::new(),
	};
	Ok(Some(PValue::Hash(names.into_iter().map(|n| (n, BString::default())).collect())))
}

/// zsh `getpmmapfile`: the contents of file `name`; `None` (unset) when it
/// cannot be read or is empty (zsh maps it, and a zero-length `mmap`
/// fails); nothing of an unset special.
///
/// # Errors
/// A parked probe, a store failure.
pub fn get(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	if is_unset(ex)? {
		return Ok(None);
	}
	let path = path_of(ex, name);
	Ok(match ask(ex, FsReq::ReadFile { path })? {
		Atom::Str(Some(data)) if !data.is_empty() => Some(data),
		_ => None,
	})
}

/// zsh `setpmmapfile`: write `value` to file `name`, creating it with mode
/// `0666` less the umask; an empty value leaves an existing file as it was.
/// Failures are silent, as in zsh.
///
/// # Errors
/// A parked probe, a store failure.
pub fn set(ex: &mut Expander<'_, '_>, name: &[u8], value: &[u8]) -> X<()> {
	revive(ex)?;
	let mode = 0o666 & !state::umask(ex.cx.store, ex.vp)?;
	let path = path_of(ex, name);
	ask(ex, FsReq::MapWrite { path, data: BString::from(value), mode })?;
	Ok(())
}

/// zsh `setpmmapfiles`: an assignment to the whole association writes each
/// of its files (the others stay).
///
/// # Errors
/// A parked probe, a store failure.
pub fn set_all(ex: &mut Expander<'_, '_>, value: PValue) -> X<()> {
	revive(ex)?;
	let pairs: Vec<(BString, BString)> = match value {
		PValue::Hash(h) => h,
		PValue::Array(a) => {
			let mut it = a.into_iter();
			let mut out = Vec::new();
			while let Some(k) = it.next() {
				out.push((k, it.next().unwrap_or_default()));
			}
			out
		},
		PValue::Scalar(_) => Vec::new(),
	};
	for (k, v) in pairs {
		set(ex, &k, &v)?;
	}
	Ok(())
}

/// zsh `unsetpmmapfile`: remove file `name` (silently when that fails).
///
/// # Errors
/// A parked probe.
pub fn unset(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<()> {
	let path = path_of(ex, name);
	ask(ex, FsReq::Unlink { path })?;
	Ok(())
}

/// `unset mapfile` (zsh `stdunsetfn`): the special stays, unset — it reads
/// as empty and unset until an assignment (which still writes files) sets
/// it again, or the module is unloaded. Removing an element still removes
/// its file ([`unset`]).
///
/// # Errors
/// A store failure.
pub fn unset_whole(ex: &mut Expander<'_, '_>) -> X<()> {
	if !is_unset(ex)? {
		mark_unset(ex, true);
	}
	Ok(())
}
