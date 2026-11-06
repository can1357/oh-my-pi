//! `cd`, `pwd`, `umask`.

use bstr::{BString, ByteSlice};

use super::{Ctx, Need, Opts, R, done, opts};
use crate::bash::{
	diag::Diag,
	store::{Attrs, Key, KeyBuf, MiscKey, OptId, Record},
	vm::{
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

/// `cd [-L|-P] [dir]`.
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
	let mut print = false;
	let target = match o.rest.first() {
		None => {
			let Some(home) = ctx.scalar(b"HOME")? else {
				ctx.usage("HOME not set");
				return done(1);
			};
			home
		},
		Some(d) if d.as_slice() == b"-" => {
			let Some(old) = ctx.scalar(b"OLDPWD")? else {
				ctx.usage("OLDPWD not set");
				return done(1);
			};
			print = true;
			old
		},
		Some(d) => d.clone(),
	};
	let cwd = ctx.vp.cwd.clone();
	let physical = physical(ctx, &o)?;
	// Physically, `..` is the parent of the directory a name resolves to,
	// so the name stays as written until `realpath` reads it (a URL path
	// keeps `cd -L`'s textual view: a provider has no symlinks to follow).
	let resolve = |p: &[u8]| {
		if physical && url_root_len(&cwd).is_none() && url_root_len(p).is_none() {
			absolute(&cwd, p)
		} else {
			logical(&cwd, p)
		}
	};
	let mut candidates = Vec::new();
	let relative =
		!target.starts_with(b"/") && !target.starts_with(b".") && url_root_len(&target).is_none();
	if relative && let Some(cdpath) = ctx.scalar(b"CDPATH")? {
		for dir in cdpath.split(|&c| c == b':') {
			if dir.is_empty() {
				continue;
			}
			let mut p = BString::from(dir);
			p.push(b'/');
			p.extend_from_slice(&target);
			candidates.push((resolve(&p), true));
		}
	}
	candidates.push((resolve(&target), print));
	let mut last_err = None;
	for (dir, show) in candidates {
		match ctx.probe(Probe::Chdir { path: dir.clone() })? {
			ProbeResult::Bytes(Ok(_)) => {
				// `cd -P` takes the directory's real name; `-e` fails when
				// it cannot be read (the change stands). A name printed for
				// `cd -` or a `CDPATH` match stays as it was found.
				let shown = dir.clone();
				let mut status = 0;
				let dir = if !physical {
					dir
				} else if let ProbeResult::Path(Some(real)) =
					ctx.probe(Probe::RealPath { path: dir.clone() })?
				{
					real
				} else {
					status = i32::from(o.has(b'e'));
					logical(&cwd, &dir)
				};
				// bash's `bindpwd`: OLDPWD, then PWD; a readonly one is
				// reported and fails the command, the directory changes.
				let old = ctx.scalar(b"PWD")?.unwrap_or_else(|| cwd.clone());
				for (name, value, default) in
					[(&b"OLDPWD"[..], old, Attrs::NONE), (&b"PWD"[..], dir.clone(), Attrs::EXPORT)]
				{
					// A declared-but-unset `readonly OLDPWD` counts too.
					let attrs = state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, name)?
						.map_or(default, |v| v.attrs.without(Attrs::INVISIBLE));
					if attrs.contains(Attrs::READONLY) {
						ctx.diag(Diag::Readonly { name: name.into() });
						status = 1;
					} else {
						ctx.set_var(name, Some(Var::scalar(value, attrs)), Level::Dynamic);
					}
				}
				if ctx.vp.overlay.is_none() {
					ctx.k.root.set_misc(ctx.cx.store, MiscKey::Cwd, dir.clone());
				}
				ctx.vp.cwd = dir;
				if show {
					let mut line = shown.to_vec();
					line.push(b'\n');
					ctx.out(&line);
				}
				return done(status);
			},
			ProbeResult::Bytes(Err(msg)) => last_err = Some(msg),
			_ => {},
		}
	}
	let msg = last_err.unwrap_or_default();
	// bash prints the directory through `printable_filename`.
	let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
	let name = quote::printable_filename(&target, utf8, false);
	ctx.usage(format!("{}: {}", name.as_bstr(), msg.as_bstr()));
	done(1)
}

/// `pwd [-LP]`: the working directory, physical (symlinks resolved) with
/// `-P` or `set -P`.
pub fn pwd(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"LP", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let mut line = if !physical(ctx, &o)? {
		ctx.vp.cwd.to_vec()
	} else if let ProbeResult::Path(Some(real)) =
		ctx.probe(Probe::RealPath { path: ctx.vp.cwd.clone() })?
	{
		real.to_vec()
	} else {
		// bash's `getcwd` failure, printed without the shell's prefix.
		ctx.out_fd(
			2,
			b"pwd: error retrieving current directory: getcwd: cannot access parent directories: \
			  No such file or directory\n",
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
