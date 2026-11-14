//! zsh `cd`/`chdir`, `pushd`, `popd`, `dirs` and `pwd`: a port of zsh 5.9
//! `builtin.c` `bin_cd`, `cd_get_dest`, `cd_do_chdir`, `cd_able_vars`,
//! `cd_try_chdir`, `cd_new_pwd`, `set_pwd_env`, `printdirstack`,
//! `bin_dirs`, `bin_pwd` and `utils.c` `fprintdir`, over the engine's
//! directory-stack record (the stack without the current directory, top
//! first, as zsh's `dirstack`).
//!
//! Paths are normalised textually (zsh `fixdir`, which stats `foo` before
//! dropping `foo/..`); `CHASE_LINKS`/`-P` resolve the new directory with
//! the file system's `realpath` (zsh `findpwd`), `-s` refuses symbolic
//! links on the way (zsh `lchdir` with `hard`). The engine owns the
//! working directory as a path, so a directory renamed under the shell is
//! not followed by inode. The `chpwd` hook functions run in an
//! `eval`-like frame after the change (zsh `callhookfunc`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	Control, Ctx, Need, Outcome, R, dirstack, done,
	zsh_args::{Func, Ops, isset, zerr, zx},
	zsh_typeset::PM_EXPORTED,
};
use crate::bash::{
	fs::{Stat, StatKind, plain_windows_path},
	ids::Platform,
	store::{Key, MiscKey, Record},
	syntax::zsh::tok::{head, tail},
	vm::{
		exec::push_script,
		proc::{Probe, ProbeResult, ScriptKind},
		zsh::{
			nameddir,
			params::{self, PmFlags},
		},
	},
	zshopt::ZshOpt,
};

/// zsh `fprintdir` over `paths`: each with its longest named directory
/// prefix (`$HOME` included) as `~name`.
fn fprintdirs(ctx: &mut Ctx<'_, '_>, paths: &[&[u8]]) -> Result<Vec<BString>, Need> {
	let r = zx(ctx, |ex| {
		paths
			.iter()
			.map(|p| nameddir::abbreviate(ex, p))
			.collect::<crate::bash::vm::expand::X<Vec<_>>>()
	})?;
	Ok(r.unwrap_or_else(|_| paths.iter().map(|p| BString::from(*p)).collect()))
}

/// `$HOME` (zsh's `home`).
fn home(ctx: &mut Ctx<'_, '_>) -> Result<Option<BString>, Need> {
	Ok(zx(ctx, |ex| params::getsparam(ex, b"HOME"))?.ok().flatten())
}

/// zsh's `%e`: the error text with a lower-case first letter.
fn errtext(msg: &[u8]) -> BString {
	let mut m = BString::from(msg);
	if let Some(c) = m.first_mut() {
		*c = c.to_ascii_lowercase();
	}
	m
}

/// Whether a failed `chdir` was `ENOENT`.
const fn is_enoent(msg: &[u8]) -> bool {
	msg.eq_ignore_ascii_case(b"no such file or directory")
}

/// The state of one `cd`/`pushd`/`popd`.
struct Cd {
	func:       Func,
	/// `-s`: no symbolic links on the way (zsh's `hard`).
	hard:       bool,
	/// zsh `chasinglinks`: `-P`, or `CHASE_LINKS` without `-L`; set too
	/// when `fixdir` met a `..` it could not resolve textually.
	chasing:    bool,
	/// The directory the last successful `try_chdir` really reached (its
	/// own path, or `dest` relative to the working directory when that
	/// path failed); the engine's working directory becomes this one's.
	actual:     BString,
	/// `doprintdir`: print the new directory (`POSIX_CD`).
	doprintdir: i32,
	/// The current directory (zsh `pwd`).
	pwd:        BString,
	/// zsh's `dirstack` with the current directory pushed on top.
	stack:      Vec<BString>,
	/// Windows paths ([`on_windows`]).
	windows:    bool,
}

/// Whether the shell runs on Windows, where `cd` takes drive (`C:\x`,
/// `C:/x`) and UNC (`\\srv\share`) paths and keeps directories spelled
/// with `/` ([`windows_spelling`]).
fn on_windows(ctx: &Ctx<'_, '_>) -> bool {
	ctx.k.engine.config().platform == Platform::Windows
}

/// `path` as zsh keeps directories on Windows (`$PWD`, `$HOME`, the
/// directory stack): `/` separators (zsh's path code, `:h`/`:t` and `%~`
/// split on `/`, and Windows takes either), the `\\?\` prefix of a
/// resolved path dropped ([`plain_windows_path`]; a path that keeps it is
/// left as is, `\` being its only separator), and a root-relative `/x` on
/// the drive of `cwd`.
pub(crate) fn windows_spelling(path: &[u8], cwd: &[u8]) -> BString {
	let path = plain_windows_path(path);
	if path.starts_with(br"\\?\") {
		return BString::from(path.into_owned());
	}
	let mut out: Vec<u8> = path
		.iter()
		.map(|&c| if c == b'\\' { b'/' } else { c })
		.collect();
	if out.first() == Some(&b'/') && out.get(1) != Some(&b'/') && root_len(cwd, true) == 3 {
		out.splice(0..0, cwd[..2].iter().copied());
	}
	out.into()
}

/// The length of the root of `path` (`/`; on Windows also `C:/` and
/// `//server/share/`), 0 when it is relative.
pub(super) fn root_len(path: &[u8], windows: bool) -> usize {
	if windows {
		if let [drive, b':', b'/' | b'\\', ..] = path
			&& drive.is_ascii_alphabetic()
		{
			return 3;
		}
		if let [b'/' | b'\\', b'/' | b'\\', rest @ ..] = path
			&& !rest.is_empty()
		{
			// `//server/share/`: the root ends after the share.
			let sep = |c: &u8| matches!(c, b'/' | b'\\');
			let server = rest.iter().position(sep).map_or(rest.len(), |i| i + 1);
			let share = rest[server..]
				.iter()
				.position(sep)
				.map_or(rest.len(), |i| server + i + 1);
			return 2 + share;
		}
	}
	usize::from(path.first() == Some(&b'/'))
}

/// `stat`/`lstat` of the absolute `path`.
fn stat(ctx: &Ctx<'_, '_>, path: &[u8], follow: bool) -> Result<Option<Stat>, Need> {
	Ok(match ctx.probe(Probe::Stat { path: path.into(), follow })? {
		ProbeResult::Stat(s) => s,
		_ => None,
	})
}

/// The canonical physical path of the absolute `path` (zsh `xsymlink`,
/// `zgetcwd`), spelled as `cd` keeps directories.
fn realpath(ctx: &Ctx<'_, '_>, path: &[u8]) -> Result<Option<BString>, Need> {
	Ok(match ctx.probe(Probe::RealPath { path: path.into() })? {
		ProbeResult::Path(Some(p)) if on_windows(ctx) => Some(windows_spelling(&p, path)),
		ProbeResult::Path(p) => p,
		_ => None,
	})
}

/// Whether the absolute `path` can be made the working directory; the
/// error text if not.
fn chdir_check(ctx: &Ctx<'_, '_>, path: &[u8]) -> Result<Result<(), BString>, Need> {
	Ok(match ctx.probe(Probe::Chdir { path: path.into() })? {
		ProbeResult::Bytes(Ok(_)) => Ok(()),
		ProbeResult::Bytes(Err(msg)) => Err(msg),
		_ => Err(BString::from("No such file or directory")),
	})
}

/// zsh `fixdir` over the absolute `src`: `.` segments, repeated `/`es and
/// `foo/..` pairs removed, never climbing above the root (`/`, or on
/// Windows `C:/` and `//server/share/`). A `foo` that is not a directory
/// stops the normalisation (the rest stays as written); `CHASE_DOTS` keeps
/// every `..`. Also whether links must be chased (`..` kept).
fn fixdir(ctx: &mut Ctx<'_, '_>, src: &[u8]) -> Result<(BString, bool), Need> {
	let chasedots = isset(ctx, ZshOpt::Chasedots)?;
	let root = root_len(src, on_windows(ctx));
	let mut chase = false;
	let mut out: Vec<u8> = Vec::with_capacity(src.len());
	let at = |i: usize| src.get(i).copied().unwrap_or(0);
	let mut i = 0;
	if root > 1 {
		out.extend_from_slice(&src[..root]);
		i = root;
		while at(i) == b'/' {
			i += 1;
		}
	}
	loop {
		if at(i) == b'/' {
			out.push(b'/');
			i += 1;
			while at(i) == b'/' {
				i += 1;
			}
		}
		if i >= src.len() {
			while out.len() > root.max(1) && out.last() == Some(&b'/') {
				out.pop();
			}
			return Ok((out.into(), chase));
		}
		if at(i) == b'.' && at(i + 1) == b'.' && matches!(at(i + 2), 0 | b'/') && !chasedots {
			if out.len() > root.max(1) {
				// `dir/..` goes only when `dir` is a directory.
				let parent = out.strip_suffix(b"/").unwrap_or(&out);
				if !stat(ctx, parent, true)?.is_some_and(|s| s.kind == StatKind::Dir) {
					out.extend_from_slice(tail(src, i));
					return Ok((out.into(), true));
				}
				let mut d = out.len() - 1;
				while d > root.max(1) && out[d - 1] != b'/' {
					d -= 1;
				}
				if d > 0 && out[d - 1] != b'/' {
					d -= 1;
				}
				out.truncate(d);
			}
			i += 2;
			while at(i) == b'/' {
				i += 1;
			}
			continue;
		}
		if at(i) == b'.' && at(i + 1) == b'.' && matches!(at(i + 2), 0 | b'/') {
			// `CHASE_DOTS`: a normal segment, resolved physically.
			chase = true;
		}
		if at(i) == b'.' && matches!(at(i + 1), 0 | b'/') {
			i += 1;
			while at(i) == b'/' {
				i += 1;
			}
		} else {
			while i < src.len() && src[i] != b'/' {
				out.push(src[i]);
				i += 1;
			}
		}
	}
}

/// zsh `lchdir`: whether `path` (relative ones from the working
/// directory) can be changed to; the path the engine changes to, or the
/// error text. `hard` refuses symbolic links in any component.
fn lchdir(ctx: &Ctx<'_, '_>, path: &[u8], hard: bool) -> Result<Result<BString, BString>, Need> {
	let windows = on_windows(ctx);
	let root = root_len(path, windows);
	let full: BString = if root > 0 {
		path.into()
	} else {
		let cwd = if windows {
			windows_spelling(&ctx.vp.cwd, &ctx.vp.cwd)
		} else {
			ctx.vp.cwd.clone()
		};
		[cwd.strip_suffix(b"/").unwrap_or(&cwd), b"/", path]
			.concat()
			.into()
	};
	if hard {
		let base_len = if root > 0 {
			root
		} else {
			full.len() - path.len()
		};
		let mut walked: Vec<u8> = full[..base_len].to_vec();
		for comp in path[root..].split(|&c| c == b'/').filter(|c| !c.is_empty()) {
			if walked.last() != Some(&b'/') {
				walked.push(b'/');
			}
			walked.extend_from_slice(comp);
			match stat(ctx, &walked, false)? {
				Some(s) if s.kind == StatKind::Dir => {},
				Some(_) => return Ok(Err(BString::from("Not a directory"))),
				None => {
					return Ok(Err(
						chdir_check(ctx, &walked)?
							.err()
							.unwrap_or_else(|| BString::from("No such file or directory")),
					));
				},
			}
		}
	}
	// A path with `..` left in it (links chased) is resolved physically.
	let target = if full.split(|&c| c == b'/').any(|c| c == b"." || c == b"..") {
		match realpath(ctx, &full)? {
			Some(real) => real,
			None => full,
		}
	} else {
		full
	};
	Ok(chdir_check(ctx, &target)?.map(|()| target))
}

/// zsh `cd_try_chdir`: change to `pfix/dest` if possible; the full path
/// (recording the directory really reached in `cd.actual`), or the error
/// text.
fn try_chdir(
	ctx: &mut Ctx<'_, '_>,
	cd: &mut Cd,
	pfix: Option<&[u8]>,
	dest: &[u8],
) -> Result<Result<BString, BString>, Need> {
	let pwd = cd.pwd.clone();
	let pwd = pwd.as_slice();
	let buf: Vec<u8> = match pfix.filter(|p| !p.is_empty()) {
		Some(p) if root_len(p, cd.windows) > 0 => [p, b"/", dest].concat(),
		Some(p) => {
			let d: &[u8] = if pwd == b"/" { b"" } else { pwd };
			[d, b"/", p, b"/", dest].concat()
		},
		None if root_len(dest, cd.windows) > 0 => dest.to_vec(),
		None => {
			let d = pwd.strip_suffix(b"/").unwrap_or(pwd);
			[d, b"/", dest].concat()
		},
	};
	let (path, dochase) = if cd.chasing {
		(BString::from(buf), false)
	} else {
		fixdir(ctx, &buf)?
	};
	// The full path first, then `dest` relative to the working directory
	// (useful when the current directory was renamed).
	let reached = match lchdir(ctx, &path, cd.hard)? {
		Ok(r) => r,
		Err(msg) if pfix.is_some() || root_len(dest, cd.windows) > 0 => return Ok(Err(msg)),
		Err(_) => match lchdir(ctx, dest, cd.hard)? {
			Ok(r) => r,
			Err(msg) => return Ok(Err(msg)),
		},
	};
	if dochase {
		cd.chasing = true;
	}
	cd.actual = reached;
	Ok(Ok(path))
}

/// zsh `cd_able_vars`: under `CDABLE_VARS`, `name/rest` where `$name` is
/// an absolute path (zsh `getnameddir`).
fn cd_able_vars(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> Result<Option<BString>, Need> {
	if !isset(ctx, ZshOpt::Cdablevars)? {
		return Ok(None);
	}
	let end = s.find_byte(b'/').unwrap_or(s.len());
	let name = head(s, end).to_vec();
	let dir = match zx(ctx, |ex| nameddir::getnameddir(ex, &name))? {
		Ok(d) => d,
		Err(d) => {
			ctx.diag(d);
			None
		},
	};
	Ok(dir.map(|mut d| {
		d.extend_from_slice(tail(s, end));
		d
	}))
}

/// zsh `cd_do_chdir`: change to `dest` through `$cdpath` and
/// `CDABLE_VARS`; the new directory, or `None` after `ERROR: dest`.
fn do_chdir(ctx: &mut Ctx<'_, '_>, cd: &mut Cd, dest: &[u8]) -> Result<Option<BString>, Need> {
	// Errors name the directory as given.
	let shown = BString::from(dest);
	let spelled;
	let dest = if cd.windows {
		spelled = windows_spelling(dest, &cd.pwd);
		spelled.as_slice()
	} else {
		dest
	};
	let nocdpath = dest.first() == Some(&b'.')
		&& (matches!(dest.get(1), None | Some(b'/'))
			|| (dest.get(1) == Some(&b'.') && matches!(dest.get(2), None | Some(b'/'))));
	if root_len(dest, cd.windows) > 0 {
		return Ok(match try_chdir(ctx, cd, None, dest)? {
			Ok(p) => Some(p),
			Err(msg) => {
				ctx.usage(format!("{}: {}", errtext(&msg), shown));
				None
			},
		});
	}
	let posixcd = isset(ctx, ZshOpt::Posixcd)?;
	let mut cdpath: Vec<BString> = zx(ctx, |ex| params::getaparam(ex, b"cdpath"))?
		.ok()
		.flatten()
		.unwrap_or_default();
	if cd.windows {
		for p in &mut cdpath {
			*p = windows_spelling(p, &cd.pwd);
		}
	}
	let hasdot =
		!nocdpath && !posixcd && cdpath.iter().any(|p| p.is_empty() || p.as_slice() == b".");
	let mut eno: Option<BString> = None;
	let note = |msg: BString, eno: &mut Option<BString>| {
		if !is_enoent(&msg) {
			*eno = Some(msg);
		}
	};
	if !hasdot && !posixcd {
		match try_chdir(ctx, cd, None, dest)? {
			Ok(p) => return Ok(Some(p)),
			Err(m) => note(m, &mut eno),
		}
	}
	if !nocdpath {
		for p in &cdpath {
			match try_chdir(ctx, cd, Some(p), dest)? {
				Ok(r) => {
					if if posixcd {
						!p.is_empty()
					} else {
						p.as_slice() != b"."
					} {
						cd.doprintdir += 1;
					}
					return Ok(Some(r));
				},
				Err(m) => note(m, &mut eno),
			}
		}
	}
	if posixcd {
		match try_chdir(ctx, cd, None, dest)? {
			Ok(p) => return Ok(Some(p)),
			Err(m) => note(m, &mut eno),
		}
	}
	if let Some(v) = cd_able_vars(ctx, dest)? {
		match try_chdir(ctx, cd, None, &v)? {
			Ok(p) => {
				cd.doprintdir += 1;
				return Ok(Some(p));
			},
			Err(m) => note(m, &mut eno),
		}
	}
	let msg = eno.unwrap_or_else(|| BString::from("No such file or directory"));
	ctx.usage(format!("{}: {}", errtext(&msg), shown));
	Ok(None)
}

/// zsh `cd_get_dest`: work out the target (pushing it on the stack); the
/// index of the stack entry `cd_new_pwd` makes current, `None` on error.
fn get_dest(ctx: &mut Ctx<'_, '_>, cd: &mut Cd, argv: &[BString]) -> Result<Option<usize>, Need> {
	let mut dir: Option<usize> = None;
	let func = cd.func;
	match argv {
		[] => {
			if func == Func::Popd && cd.stack.len() < 2 {
				ctx.usage("directory stack empty");
				return Ok(None);
			}
			if func == Func::Pushd && !isset(ctx, ZshOpt::Pushdtohome)? && cd.stack.len() > 1 {
				dir = Some(1);
			}
			if dir.is_some() {
				// The current directory goes after the entry.
				if let [first, second, ..] = cd.stack.as_mut_slice() {
					std::mem::swap(first, second);
				}
				dir = Some(0);
			} else if func != Func::Popd {
				let Some(h) = home(ctx)? else {
					ctx.usage("HOME not set");
					return Ok(None);
				};
				cd.stack.insert(0, h);
			}
		},
		[arg] => {
			cd.doprintdir += 1;
			let a = arg.as_slice();
			if !isset(ctx, ZshOpt::Posixcd)?
				&& a.len() > 1
				&& matches!(a[0], b'+' | b'-')
				&& tail(a, 1).iter().all(u8::is_ascii_digit)
			{
				let dd = tail(a, 1)
					.to_str()
					.ok()
					.and_then(|s| s.parse::<usize>().ok())
					.unwrap_or(usize::MAX);
				let from_top = (a[0] == b'+') != isset(ctx, ZshOpt::Pushdminus)?;
				let n = cd.stack.len();
				dir = if from_top {
					(dd < n).then_some(dd)
				} else {
					(dd < n).then(|| n - 1 - dd)
				};
				if dir.is_none() {
					ctx.usage("no such entry in dir stack");
					return Ok(None);
				}
			}
			if dir.is_none() {
				let d = if a == b"-" {
					zx(ctx, |ex| params::getsparam(ex, b"OLDPWD"))?
						.ok()
						.flatten()
						.unwrap_or_else(|| cd.pwd.clone())
				} else {
					cd.doprintdir -= 1;
					arg.clone()
				};
				cd.stack.insert(0, d);
			}
		},
		[old, new, ..] => {
			let Some(u) = cd.pwd.find(old.as_slice()) else {
				ctx.usage(format!("string not in pwd: {}", old.as_bstr()));
				return Ok(None);
			};
			let mut d = BString::from(head(&cd.pwd, u));
			d.extend_from_slice(new);
			d.extend_from_slice(tail(&cd.pwd, u + old.len()));
			cd.stack.insert(0, d);
			cd.doprintdir += 1;
		},
	}
	let mut target = dir;
	if func == Func::Popd {
		match dir {
			None => {
				target = Some(0);
				dir = Some(0);
			},
			Some(d) if d != 0 => return Ok(Some(d)),
			Some(_) => {},
		}
		dir = dir.map(|d| d + 1);
	}
	let idx = match dir {
		Some(d) if d < cd.stack.len() => d,
		_ => 0,
	};
	let Some(entry) = cd.stack.get(idx).cloned() else {
		return Ok(None);
	};
	let Some(dest) = do_chdir(ctx, cd, &entry)? else {
		if target.is_none() && !cd.stack.is_empty() {
			cd.stack.remove(0);
		}
		if func == Func::Popd && idx < cd.stack.len() {
			cd.stack.remove(idx);
		}
		return Ok(None);
	};
	if let Some(e) = cd.stack.get_mut(idx) {
		*e = dest;
	}
	Ok(Some(target.unwrap_or(idx)))
}

/// zsh `cd_new_pwd`: make stack entry `dir` the current directory.
fn new_pwd(ctx: &mut Ctx<'_, '_>, cd: &mut Cd, dir: usize, quiet: bool) -> R {
	let func = cd.func;
	let mut dir = dir;
	if func == Func::Pushd {
		// zsh `rolllist`: the entry and everything after it go first.
		let n = cd.stack.len();
		cd.stack.rotate_left(dir.min(n));
		dir = 0;
	}
	let mut new = if dir < cd.stack.len() {
		cd.stack.remove(dir)
	} else {
		cd.pwd.clone()
	};
	if func == Func::Popd && !cd.stack.is_empty() {
		new = cd.stack.remove(0);
	} else if func == Func::Cd && !isset(ctx, ZshOpt::Autopushd)? && !cd.stack.is_empty() {
		cd.stack.remove(0);
	}
	let logical = new.clone();
	if cd.chasing
		&& root_len(&new, cd.windows) > 0
		&& let Some(real) = realpath(ctx, &new)?
	{
		// zsh `findpwd`.
		new = real;
	}
	// The path is the directory really reached unless that one is
	// elsewhere: `zgetcwd` when the path is gone or links are chased.
	if !cd.actual.is_empty() && cd.actual != logical {
		let actual = std::mem::take(&mut cd.actual);
		match stat(ctx, &new, true)? {
			None => new = realpath(ctx, &actual)?.unwrap_or(actual),
			Some(s1) => {
				if cd.chasing
					&& stat(ctx, &actual, true)?.is_some_and(|s2| (s1.dev, s1.ino) != (s2.dev, s2.ino))
				{
					new = realpath(ctx, &actual)?.unwrap_or(actual);
				}
			},
		}
	}
	if isset(ctx, ZshOpt::Pushdignoredups)?
		&& let Some(i) = cd.stack.iter().position(|d| *d == new)
	{
		cd.stack.remove(i);
	}
	let oldpwd = std::mem::replace(&mut cd.pwd, new.clone());
	// zsh `set_pwd_env`.
	let (pwd, old) = (new.clone(), oldpwd);
	let r = zx(ctx, |ex| {
		for (name, value) in [(&b"PWD"[..], pwd), (&b"OLDPWD"[..], old)] {
			params::assignsparam(ex, name, &value, 0)?;
			if let Some(p) = params::getparam(ex, name)?
				&& p.flags.bits() & PM_EXPORTED == 0
			{
				params::set_flags(
					ex,
					name,
					PmFlags::from_bits(p.flags.bits() | PM_EXPORTED),
					p.width,
					p.base,
				)?;
			}
		}
		Ok(())
	})?;
	if ctx.vp.image.is_none() {
		ctx.k.root.set_misc(ctx.cx.store, MiscKey::Cwd, new.clone());
	}
	ctx.vp.cwd = new.clone();
	let interactive = isset(ctx, ZshOpt::Interactive)?;
	if interactive || isset(ctx, ZshOpt::Posixcd)? {
		if func != Func::Cd && interactive {
			if !isset(ctx, ZshOpt::Pushdsilent)? && !quiet {
				let mut paths: Vec<&[u8]> = vec![new.as_slice()];
				paths.extend(cd.stack.iter().map(|d| d.as_slice()));
				let mut out = fprintdirs(ctx, &paths)?.join(&b" "[..]);
				out.push(b'\n');
				ctx.out(&out);
			}
		} else if !isset(ctx, ZshOpt::Cdsilent)? && cd.doprintdir > 0 {
			let mut out: Vec<u8> = fprintdirs(ctx, &[new.as_slice()])?
				.into_iter()
				.next()
				.map_or_default(Vec::from);
			out.push(b'\n');
			ctx.out(&out);
		}
	}
	// DIRSTACKSIZE bounds the stack.
	let size = zx(ctx, |ex| params::getsparam(ex, b"DIRSTACKSIZE"))?
		.ok()
		.flatten()
		.and_then(|v| v.to_str().ok().and_then(|s| s.trim().parse::<i64>().ok()))
		.unwrap_or(0);
	if size > 0 {
		let keep = usize::try_from(size.max(2) - 1).unwrap_or(0);
		cd.stack.truncate(keep);
	}
	dirstack::store_entries(ctx.k, ctx.cx.store, ctx.vp, std::mem::take(&mut cd.stack));
	match r {
		Ok(()) if !quiet => chpwd_hooks(ctx),
		Ok(()) => done(0),
		Err(d) => zerr(ctx, d),
	}
}

/// zsh `callhookfunc("chpwd", NULL, 1, NULL)` after a directory change:
/// the function `chpwd`, then each function `chpwd_functions` names
/// (entries naming none are skipped), run in this shell; `cd`'s status
/// stays 0.
fn chpwd_hooks(ctx: &mut Ctx<'_, '_>) -> R {
	let listed = zx(ctx, |ex| params::getaparam(ex, b"chpwd_functions"))?
		.ok()
		.flatten()
		.unwrap_or_default();
	let mut src = Vec::new();
	for name in std::iter::once(BString::from("chpwd")).chain(listed) {
		if name.is_empty()
			|| !matches!(ctx.record(Key::Func(bstr::BStr::new(&name)))?, Some(Record::Func { .. }))
		{
			continue;
		}
		// The name as one single-quoted word.
		src.push(b'\'');
		for &c in name.iter() {
			if c == b'\'' {
				src.extend_from_slice(b"'\\''");
			} else {
				src.push(c);
			}
		}
		src.extend_from_slice(b"'\n");
	}
	if src.is_empty() {
		return done(0);
	}
	src.extend_from_slice(b":\n");
	push_script(ctx.vp, &src, ctx.line, ScriptKind::Eval);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// zsh `bin_cd` for `cd`, `chdir`, `pushd` and `popd`.
pub fn cd(ctx: &mut Ctx<'_, '_>, ops: &Ops, argv: &[BString], func: Func) -> R {
	if isset(ctx, ZshOpt::Restricted)? {
		ctx.usage("restricted");
		return done(1);
	}
	let mut stack = dirstack::entries(ctx.cx.store, ctx.vp)?;
	let windows = on_windows(ctx);
	// The working directory as `cd` spells it (the process's own at
	// startup has `\` on Windows).
	let pwd = if windows {
		windows_spelling(&ctx.vp.cwd, &ctx.vp.cwd)
	} else {
		ctx.vp.cwd.clone()
	};
	stack.insert(0, pwd.clone());
	let chasing = ops.isset(b'P') || (isset(ctx, ZshOpt::Chaselinks)? && !ops.isset(b'L'));
	let mut cd = Cd {
		func,
		hard: ops.isset(b's'),
		chasing,
		actual: BString::default(),
		doprintdir: 0,
		pwd,
		stack,
		windows,
	};
	if let Some(dir) = get_dest(ctx, &mut cd, argv)? {
		new_pwd(ctx, &mut cd, dir, ops.isset(b'q'))
	} else {
		// The current directory pushed on top goes again; whatever
		// else changed stays.
		if !cd.stack.is_empty() {
			cd.stack.remove(0);
		}
		dirstack::store_entries(ctx.k, ctx.cx.store, ctx.vp, cd.stack);
		done(1)
	}
}

/// zsh `bin_dirs`: list the stack (`-v` numbered, `-p` one per line, `-l`
/// without `~`), clear it (`-c`) or replace it with the arguments.
pub fn dirs(ctx: &mut Ctx<'_, '_>, ops: &Ops, argv: &[BString]) -> R {
	if (argv.is_empty() && !ops.isset(b'c')) || ops.isset(b'v') || ops.isset(b'p') {
		let stack = dirstack::entries(ctx.cx.store, ctx.vp)?;
		let cwd = ctx.vp.cwd.clone();
		let mut paths: Vec<&[u8]> = vec![cwd.as_slice()];
		paths.extend(stack.iter().map(|d| d.as_slice()));
		// `-l`: full paths, no `~`.
		let shown: Vec<BString> = if ops.isset(b'l') {
			paths.iter().map(|p| BString::from(*p)).collect()
		} else {
			fprintdirs(ctx, &paths)?
		};
		let mut out = Vec::new();
		if ops.isset(b'v') {
			out.extend_from_slice(b"0\t");
		}
		for (pos, d) in shown.iter().enumerate() {
			if pos > 0 {
				if ops.isset(b'v') {
					out.extend_from_slice(format!("\n{pos}\t").as_bytes());
				} else if ops.isset(b'p') {
					out.push(b'\n');
				} else {
					out.push(b' ');
				}
			}
			out.extend_from_slice(d);
		}
		out.push(b'\n');
		ctx.out(&out);
		return done(0);
	}
	dirstack::store_entries(ctx.k, ctx.cx.store, ctx.vp, argv.to_vec());
	done(0)
}

/// zsh `bin_pwd`: `$PWD`, or the physical directory (`zgetcwd`, `$PWD`
/// when that fails) with `-r`/`-P` or `CHASE_LINKS` without `-L`.
pub fn pwd(ctx: &mut Ctx<'_, '_>, ops: &Ops) -> R {
	let cwd = ctx.vp.cwd.clone();
	let physical =
		ops.isset(b'r') || ops.isset(b'P') || (isset(ctx, ZshOpt::Chaselinks)? && !ops.isset(b'L'));
	let mut line = if physical {
		realpath(ctx, &cwd)?.unwrap_or(cwd).to_vec()
	} else {
		cwd.to_vec()
	};
	line.push(b'\n');
	ctx.out(&line);
	done(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn error_text_lowercases_first_letter() {
		assert_eq!(errtext(b"No such file or directory"), "no such file or directory");
		assert!(is_enoent(b"No such file or directory"));
	}

	/// `cd` on Windows keeps `/`-separated directories: a resolved path's
	/// `\\?\` prefix (once left in `$PWD`) goes, and `\x` lands on the
	/// working directory's drive.
	#[test]
	fn windows_spelling_uses_slashes_and_drops_verbatim_prefixes() {
		assert_eq!(windows_spelling(br"F:\Repos\x", b"F:/r"), "F:/Repos/x");
		assert_eq!(windows_spelling(br"\\?\F:\Repos", b"F:/r"), "F:/Repos");
		assert_eq!(windows_spelling(br"\\?\UNC\srv\share\d", b"F:/r"), "//srv/share/d");
		assert_eq!(windows_spelling(br"\tools", b"F:/r"), "F:/tools");
		assert_eq!(windows_spelling(b"sub\\dir", b"F:/r"), "sub/dir");
	}

	/// `..` never climbs above a drive or share root, and a Windows path
	/// is absolute (it was joined onto the working directory).
	#[test]
	fn roots_cover_drives_and_shares_on_windows_only() {
		assert_eq!(root_len(b"C:/x", true), 3);
		assert_eq!(root_len(br"C:\x", true), 3);
		assert_eq!(root_len(b"//srv/share/x", true), 12);
		assert_eq!(root_len(b"//srv/share", true), 11);
		assert_eq!(root_len(b"/x", true), 1);
		assert_eq!(root_len(b"x", true), 0);
		assert_eq!(root_len(b"C:/x", false), 0);
		assert_eq!(root_len(b"/x", false), 1);
	}
}
