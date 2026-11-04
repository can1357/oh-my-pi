//! `cd`, `pwd`, `umask`.

use bstr::{BString, ByteSlice};

use super::{Ctx, Need, Opts, R, done, opts};
use crate::bash::{
	diag::{self, Diag},
	fs::{Entered, StatKind},
	store::{Attrs, Key, KeyBuf, MiscKey, OptId, Record},
	vm::{
		expand::tilde_dir,
		locale,
		probe::{absolute, url_root_len},
		proc::{Probe, ProbeResult},
		quote,
		state::{self, Level, Var},
	},
};

/// Whether `cd`/`pwd` work on the physical directory structure: the last
/// of `-L`/`-P`, else `set -P`.
fn physical(ctx: &mut Ctx<'_, '_>, o: &Opts<'_>) -> Result<bool, Need> {
	match o
		.flags
		.iter()
		.rev()
		.find(|(c, ..)| matches!(c, b'L' | b'P'))
	{
		Some(&(c, ..)) => Ok(c == b'P'),
		None => ctx.option(OptId::Physical),
	}
}

/// `dir` made absolute against `cwd` with `.` and `..` resolved textually
/// (`cd -L`). A URL path ([`url_root_len`]) keeps its `scheme://` root, which
/// `..` never climbs above.
pub fn logical(cwd: &[u8], dir: &[u8]) -> BString {
	let mut parts: Vec<&[u8]> = Vec::new();
	let full: Vec<u8>;
	let path = if dir.starts_with(b"/") || url_root_len(dir).is_some() {
		dir
	} else {
		full = [cwd, &b"/"[..], dir].concat();
		&full
	};
	let (root, path) = match url_root_len(path) {
		Some(len) => path.split_at(len),
		None => (&b"/"[..], path),
	};
	for part in path.split(|&c| c == b'/') {
		match part {
			b"" | b"." => {},
			b".." => {
				parts.pop();
			},
			p => parts.push(p),
		}
	}
	let mut out = BString::from(root);
	out.extend_from_slice(&bstr::join(b"/", parts));
	out
}

/// bash `absolute_pathname`: a name `cd` takes as it is, without looking
/// it up in `CDPATH` (`/…`, `.`, `..`, `./…`, `../…`, or a URL path).
fn absolute_pathname(name: &[u8]) -> bool {
	name.starts_with(b"/")
		|| matches!(name, b"." | b"..")
		|| name.starts_with(b"./")
		|| name.starts_with(b"../")
		|| url_root_len(name).is_some()
}

/// `CDPATH`'s entries as bash's `extract_colon_unit` returns them (an
/// empty entry is the working directory; a trailing `:` adds one), except
/// that an entry spelled as a provider URL (`scheme://…`) keeps the colon
/// of its root: bash has no providers, so no entry of its can be one.
fn cdpath_entries(cdpath: &[u8]) -> Vec<&[u8]> {
	let mut entries = Vec::new();
	let mut i = 0;
	while i < cdpath.len() {
		if i > 0 && cdpath[i] == b':' {
			i += 1;
		}
		let start = i;
		let root = url_root_len(&cdpath[start..]).unwrap_or(0);
		i = cdpath[start + root..]
			.iter()
			.position(|&c| c == b':')
			.map_or(cdpath.len(), |colon| start + root + colon);
		if i == start && i < cdpath.len() {
			// bash steps over the colon of an empty entry here.
			entries.push(&cdpath[start..start]);
			i += 1;
			continue;
		}
		entries.push(&cdpath[start..i]);
	}
	entries
}

/// bash `sh_makepath(dir, name, MP_DOTILDE)`: `dir/name`, `./name` for an
/// empty `dir`, without a second `/` after a `dir` ending in one.
fn makepath(dir: &[u8], name: &[u8]) -> BString {
	let mut path = BString::from(if dir.is_empty() { &b"."[..] } else { dir });
	if !path.ends_with(b"/") {
		path.push(b'/');
	}
	path.extend_from_slice(name);
	path
}

/// A directory `change_to` entered: the name the shell now gives it, the
/// directory itself, and whether that name could not be read back
/// (`getcwd` failed: the directory was removed).
struct Changed {
	name:    BString,
	entered: Entered,
	lost:    bool,
}

/// bash `sh_canonpath(path, PATH_CHECKDOTDOT | PATH_CHECKEXISTS)` of an
/// absolute `path`: `.` and `..` resolved textually, every directory the
/// name passes through checked to be one (by `stat` of its name). `None`
/// when one is not, as bash's canonicalization fails.
fn canonical(ctx: &Ctx<'_, '_>, path: &[u8]) -> Result<Option<BString>, Need> {
	// POSIX keeps a leading `//`, not `///`.
	let root: &[u8] = if path.starts_with(b"//") && !path.starts_with(b"///") {
		b"//"
	} else {
		b"/"
	};
	let mut out = BString::from(root);
	for part in path.split(|&c| c == b'/') {
		match part {
			b"" | b"." => continue,
			b".." => {
				if out.len() > root.len() {
					let cut = out.rfind_byte(b'/').unwrap_or(0).max(root.len());
					out.truncate(cut);
				}
				continue;
			},
			name => {
				if out.len() > root.len() {
					out.push(b'/');
				}
				out.extend_from_slice(name);
			},
		}
		let is_dir = matches!(
			ctx.probe(Probe::Stat { path: out.clone(), follow: true })?,
			ProbeResult::Stat(Some(st)) if st.kind == StatKind::Dir
		);
		if !is_dir {
			return Ok(None);
		}
	}
	Ok(Some(out))
}

/// `chdir(path)` as a probe: the directory entered, or the `strerror` text
/// of the failure.
fn enter(ctx: &Ctx<'_, '_>, path: &[u8]) -> Result<Result<Entered, BString>, Need> {
	Ok(match ctx.probe(Probe::Chdir { path: path.into() })? {
		ProbeResult::Entered(entered) => entered,
		_ => Err(BString::default()),
	})
}

/// `getcwd` of the directory `enter(path)` entered; `None` once removed.
fn getcwd(ctx: &Ctx<'_, '_>, entered: &[u8]) -> Result<Option<BString>, Need> {
	Ok(match ctx.probe(Probe::Getcwd { entered: Some(entered.into()) })? {
		ProbeResult::Path(name) => name,
		_ => None,
	})
}

/// `strerror(errno)`.
fn strerror(errno: i32) -> BString {
	BString::from(diag::strerror(&std::io::Error::from_raw_os_error(errno)).as_bytes())
}

/// bash `change_to_directory`: enters `newdir` as `chdir` would, and names
/// the directory entered. `Err` holds the `strerror` text of the failure.
///
/// `-P` enters `newdir` as written, a relative one read from the directory
/// the shell holds, and names it physically. `-L` enters the name made
/// absolute and canonical (each directory it passes through checked); when
/// that check fails, the name made absolute as it is, named by `getcwd`;
/// and outside POSIX mode, when that `chdir` fails, `newdir` as written,
/// read from the directory the shell holds, named by `getcwd`, the first
/// failure reported. A URL path keeps `-L`'s textual view: a provider has
/// no symlinks to follow and holds no directory.
fn change_to(
	ctx: &Ctx<'_, '_>,
	cwd: &[u8],
	newdir: &[u8],
	physical: bool,
	posix: bool,
) -> Result<Result<Changed, BString>, Need> {
	if url_root_len(cwd).is_some() || url_root_len(newdir).is_some() {
		let tdir = logical(cwd, newdir);
		return Ok(enter(ctx, &tdir)?.map(|entered| Changed { name: tdir, entered, lost: false }));
	}
	let t = absolute(cwd, newdir);
	if physical {
		let entered = match enter(ctx, newdir)? {
			Ok(entered) => entered,
			Err(e) => return Ok(Err(e)),
		};
		let real = match ctx.probe(Probe::RealPath { path: t.clone() })? {
			ProbeResult::Path(real) => real,
			_ => None,
		};
		let (name, lost) = match real {
			Some(real) => (real, false),
			None => match getcwd(ctx, newdir)? {
				Some(name) => (name, false),
				None => (t, true),
			},
		};
		return Ok(Ok(Changed { name, entered, lost }));
	}
	let canon = canonical(ctx, &t)?;
	let tdir = canon.clone().unwrap_or_else(|| t.clone());
	if posix && canon.is_none() {
		// POSIX mode fails at once, with `stat`'s reason where that is
		// `ENOENT` or `ENAMETOOLONG`, else `ENOTDIR`.
		return Ok(Err(match enter(ctx, &tdir)? {
			Err(e) if e == strerror(libc::ENOENT) || e == strerror(libc::ENAMETOOLONG) => e,
			_ => strerror(libc::ENOTDIR),
		}));
	}
	let first = match enter(ctx, &tdir)? {
		Ok(entered) => {
			if canon.is_some() {
				return Ok(Ok(Changed { name: tdir, entered, lost: false }));
			}
			let (name, lost) = match getcwd(ctx, &tdir)? {
				Some(name) => (name, false),
				None => (tdir, true),
			};
			return Ok(Ok(Changed { name, entered, lost }));
		},
		Err(e) => e,
	};
	if posix {
		return Ok(Err(first));
	}
	Ok(match enter(ctx, newdir)? {
		Ok(entered) => {
			let (name, lost) = match getcwd(ctx, newdir)? {
				Some(name) => (name, false),
				None => (tdir, true),
			};
			Ok(Changed { name, entered, lost })
		},
		// The reason is the first `chdir`'s, as bash keeps it.
		Err(_) => Err(first),
	})
}

/// bash `bindpwd` after a change: the `getcwd` failure of a directory whose
/// name could not be read back (which `cd -P -e` makes a failure), the line
/// `cd` prints, then `OLDPWD` from `PWD` (unset when `PWD` is) and `PWD`,
/// a readonly one reported and failing the command; the directory changes.
fn bind(
	ctx: &mut Ctx<'_, '_>,
	changed: Changed,
	line: Option<BString>,
	physical: bool,
	eflag: bool,
) -> R {
	let mut status = if changed.lost {
		ctx.out_fd(
			2,
			b"cd: error retrieving current directory: getcwd: cannot access parent \
			  directories: No such file or directory\n",
		);
		i32::from(physical && eflag)
	} else {
		0
	};
	if let Some(mut line) = line {
		line.push(b'\n');
		ctx.out(&line);
	}
	let old = ctx.scalar(b"PWD")?;
	for (name, value, default) in
		[(&b"OLDPWD"[..], old, Attrs::NONE), (&b"PWD"[..], Some(changed.name.clone()), Attrs::EXPORT)]
	{
		// A declared-but-unset `readonly OLDPWD` counts too.
		let attrs = state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, name)?
			.map_or(default, |v| v.attrs.without(Attrs::INVISIBLE));
		if attrs.contains(Attrs::READONLY) {
			ctx.diag(Diag::Readonly { name: name.into() });
			status = 1;
		} else {
			// bash binds `OLDPWD` to an unset `PWD`'s null value: declared,
			// without a value.
			let var = match value {
				Some(value) => Var::scalar(value, attrs),
				None => Var::scalar(BString::default(), attrs.with(Attrs::INVISIBLE)),
			};
			ctx.set_var(name, Some(var), Level::Dynamic);
		}
	}
	if ctx.vp.overlay.is_none() {
		ctx.k
			.root
			.set_misc(ctx.cx.store, MiscKey::Cwd, changed.name.clone());
	}
	ctx.vp.cwd = changed.name;
	// The directory entered is the one the shell now works in.
	ctx.vp.dir = changed.entered.0;
	done(status)
}

/// `cd [-L|-P] [-e] [dir]` (bash `cd_builtin`).
pub fn cd(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"LPe@", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if o.rest.len() > 1 {
		// bash's `EX_USAGE`.
		ctx.diag(Diag::TooManyArgs { cmd: "cd".into() });
		return done(2);
	}
	// `print`: `cd -` prints the directory as written; `vars`: a name no
	// directory has may be a variable holding one (`cdable_vars`).
	let (target, print, vars) = match o.rest.first() {
		None => {
			let Some(home) = ctx.scalar(b"HOME")? else {
				ctx.usage("HOME not set");
				return done(1);
			};
			(home, false, false)
		},
		Some(d) if d.is_empty() => {
			ctx.usage("null directory");
			return done(1);
		},
		Some(d) if d.as_slice() == b"-" => {
			let Some(old) = ctx.scalar(b"OLDPWD")? else {
				ctx.usage("OLDPWD not set");
				return done(1);
			};
			(old, true, false)
		},
		Some(d) => (d.clone(), false, ctx.option(OptId::CdableVars)?),
	};
	let cwd = ctx.vp.cwd.clone();
	let physical = physical(ctx, &o)?;
	let posix = ctx.option(OptId::Posix)?;
	let eflag = o.has(b'e');
	if !absolute_pathname(&target)
		&& let Some(cdpath) = ctx.scalar(b"CDPATH")?
	{
		for entry in cdpath_entries(&cdpath) {
			let dir = match entry.strip_prefix(b"~") {
				Some(rest) => {
					let user_len = rest.find_byte(b'/').unwrap_or(rest.len());
					match tilde_dir(ctx.k, ctx.cx, ctx.vp, &rest[..user_len])? {
						Some(mut home) => {
							home.extend_from_slice(&rest[user_len..]);
							home
						},
						None => BString::from(entry),
					}
				},
				None => BString::from(entry),
			};
			let temp = makepath(&dir, &target);
			// A failure here is not reported: the reason given is the last
			// attempt's, as bash's `errno`.
			if let Ok(changed) = change_to(ctx, &cwd, &temp, physical, posix)? {
				// A directory found through a non-empty entry is printed: as
				// found under `-P`, else by its new name.
				let line =
					(!entry.is_empty()).then(|| if physical { temp } else { changed.name.clone() });
				return bind(ctx, changed, line, physical, eflag);
			}
		}
	}
	let mut msg = match change_to(ctx, &cwd, &target, physical, posix)? {
		Ok(changed) => return bind(ctx, changed, print.then(|| target.clone()), physical, eflag),
		Err(e) => e,
	};
	if vars && let Some(value) = ctx.scalar(&target)? {
		match change_to(ctx, &cwd, &value, physical, posix)? {
			Ok(changed) => return bind(ctx, changed, Some(value), physical, eflag),
			Err(e) => msg = e,
		}
	}
	// bash prints the directory through `printable_filename`.
	let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
	let name = quote::printable_filename(&target, utf8, false);
	ctx.usage(format!("{}: {}", name.as_bstr(), msg.as_bstr()));
	done(1)
}

/// `pwd [-LP]`: the working directory, physical (symlinks resolved) with
/// `-P` or `set -P`. As bash's: the name, made physical with `-P`; what
/// `getcwd` answers when that does not resolve, or in POSIX mode when the
/// name does not reach the directory the shell works in.
pub fn pwd(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"LP", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let cwd = ctx.vp.cwd.clone();
	let mut named = if !physical(ctx, &o)? {
		Some(cwd.clone())
	} else if let ProbeResult::Path(Some(real)) = ctx.probe(Probe::RealPath { path: cwd.clone() })? {
		Some(real)
	} else {
		None
	};
	if named.is_some() && ctx.vp.dir.is_some() && ctx.option(OptId::Posix)? {
		let here = ctx.probe(Probe::Stat { path: BString::from("."), follow: true })?;
		let there = ctx.probe(Probe::Stat { path: cwd, follow: true })?;
		let same = match (here, there) {
			(ProbeResult::Stat(Some(a)), ProbeResult::Stat(Some(b))) => {
				(a.dev, a.ino) == (b.dev, b.ino)
			},
			_ => false,
		};
		if !same {
			named = None;
		}
	}
	let mut line = if let Some(name) = named {
		name.to_vec()
	} else if let ProbeResult::Path(Some(real)) = ctx.probe(Probe::Getcwd { entered: None })? {
		real.to_vec()
	} else {
		// bash's `getcwd` failure, printed without the shell's prefix.
		ctx.out_fd(
			2,
			b"pwd: error retrieving current directory: getcwd: cannot access parent \
			  directories: No such file or directory\n",
		);
		return done(1);
	};
	line.push(b'\n');
	ctx.out(&line);
	done(0)
}

/// `umask [-p] [-S] [mode]` (octal modes).
pub fn umask(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"pS", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let cur = match ctx.record(Key::Misc(MiscKey::Umask))? {
		Some(Record::Misc(v)) => u32::from_str_radix(v.to_str().unwrap_or("22"), 8).unwrap_or(0o022),
		_ => 0o022,
	};
	let symbolic = |mask: u32| {
		let perm = |shift: u32| {
			let bits = ((!mask) >> shift) & 7;
			let mut s = String::new();
			for (b, c) in [(4, 'r'), (2, 'w'), (1, 'x')] {
				if bits & b != 0 {
					s.push(c);
				}
			}
			s
		};
		format!("u={},g={},o={}\n", perm(6), perm(3), perm(0))
	};
	let Some(m) = o.rest.first() else {
		let mut text = String::new();
		if o.has(b'p') {
			text.push_str(if o.has(b'S') { "umask -S " } else { "umask " });
		}
		let body = if o.has(b'S') {
			symbolic(cur)
		} else {
			format!("{cur:04o}\n")
		};
		text.push_str(&body);
		ctx.out(text.as_bytes());
		return done(0);
	};
	let mask = if m.first().is_some_and(u8::is_ascii_digit) {
		// bash `read_octal`: octal digits only, at most 07777.
		let v = std::str::from_utf8(m)
			.ok()
			.and_then(|s| u32::from_str_radix(s, 8).ok())
			.filter(|&v| v <= 0o7777 && m.iter().all(|c| (b'0'..=b'7').contains(c)));
		let Some(v) = v else {
			ctx.usage(format!("{}: octal number out of range", m.as_bstr()));
			return done(1);
		};
		v
	} else {
		match symbolic_mode(m, !cur & 0o777) {
			Ok(bits) => !bits & 0o777,
			Err(msg) => {
				ctx.usage(msg);
				return done(1);
			},
		}
	};
	ctx.store_record(KeyBuf::Misc(MiscKey::Umask), Some(Record::Misc(format!("{mask:04o}").into())));
	if o.has(b'S') {
		ctx.out(symbolic(mask).as_bytes());
	}
	done(0)
}

/// bash `parse_symbolic_mode` over the permission bits `initial` (the
/// complement of the umask): `[ugoa]*[+-=][rwxXstugo]*`, comma separated;
/// the bash diagnostic on error.
fn symbolic_mode(mode: &[u8], initial: u32) -> Result<u32, String> {
	const ALL: u32 = 0o777;
	let copy = |shift: u32| {
		let b = (initial >> shift) & 7;
		b * 0o111
	};
	let mut bits = initial;
	let mut at = 0;
	loop {
		let mut who = 0;
		while let Some(&c) = mode.get(at) {
			who |= match c {
				b'u' => 0o700,
				b'g' => 0o070,
				b'o' => 0o007,
				b'a' => ALL,
				_ => break,
			};
			at += 1;
		}
		if who == 0 {
			who = ALL;
		}
		loop {
			let op = mode.get(at).copied().unwrap_or(0);
			at += 1;
			if !matches!(op, b'+' | b'-' | b'=') {
				return Err(format!("`{}': invalid symbolic mode operator", char::from(op)));
			}
			let mut perm = 0;
			while let Some(&c) = mode.get(at) {
				match c {
					b'u' => perm = copy(6),
					b'g' => perm = copy(3),
					b'o' => perm = copy(0),
					b'r' => perm |= 0o444,
					b'w' => perm |= 0o222,
					b'X' if initial & 0o111 == 0 => {},
					b'x' | b'X' => perm |= 0o111,
					// Set-id and sticky bits have no place in a umask.
					b's' | b't' => {},
					_ => break,
				}
				at += 1;
			}
			perm &= who;
			match op {
				b'+' => bits |= perm,
				b'-' => bits &= !perm,
				_ => bits = (bits & !who) | perm,
			}
			match mode.get(at) {
				None => return Ok(bits),
				Some(b',') => {
					at += 1;
					break;
				},
				Some(b'+' | b'-' | b'=') => {},
				Some(&c) => {
					return Err(format!("`{}': invalid symbolic mode character", char::from(c)));
				},
			}
		}
	}
}

#[cfg(test)]
mod umask_tests {
	use super::symbolic_mode;

	// Goldens: bash 5.3.20 builtins8.sub, starting from umask 022 (bits
	// 0755): `umask u=r+w; umask -S` → u=rw,g=rx,o=rx, and so on.
	#[test]
	fn symbolic_modes_follow_bash() {
		let mask = |m: &str| !symbolic_mode(m.as_bytes(), 0o755).unwrap() & 0o777;
		assert_eq!(mask("u=r+w"), 0o122);
		assert_eq!(mask("u=r-w"), 0o322);
		// u=rwx,g=rwx,o=
		assert_eq!(mask("g+u,o+rwx-u"), 0o007);
		assert_eq!(mask("u=rwx,g=rwx,o=rx"), 0o002);
		// u=rwx,g=rx,o=rwx
		assert_eq!(mask("o=u"), 0o020);
		assert_eq!(mask("g+X"), 0o022);
		assert!(symbolic_mode(b"u=rwz", 0o755).is_err());
		assert!(symbolic_mode(b"q", 0o755).is_err());
	}
}

#[cfg(test)]
mod tests {
	use super::logical;

	#[test]
	fn logical_paths_resolve_dot_and_dotdot_textually() {
		assert_eq!(logical(b"/a/b", b"../c/./d"), "/a/c/d");
		assert_eq!(logical(b"/a", b"/x/../y"), "/y");
		assert_eq!(logical(b"/", b".."), "/");
	}

	#[test]
	fn logical_url_paths_keep_their_root() {
		assert_eq!(logical(b"/home", b"virtual://dir"), "virtual://dir");
		assert_eq!(logical(b"virtual://dir", b"sub/./x"), "virtual://dir/sub/x");
		assert_eq!(logical(b"virtual://dir", b"../../up"), "virtual://up");
		assert_eq!(logical(b"virtual://", b".."), "virtual://");
		assert_eq!(logical(b"virtual://dir", b"/tmp"), "/tmp");
	}
}
