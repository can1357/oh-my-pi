//! zsh `cd`/`chdir`, `pushd`, `popd`, `dirs` and `pwd`: a port of zsh 5.9
//! `builtin.c` `bin_cd`, `cd_get_dest`, `cd_do_chdir`, `cd_able_vars`,
//! `cd_try_chdir`, `cd_new_pwd`, `set_pwd_env`, `printdirstack`,
//! `bin_dirs`, `bin_pwd` and `utils.c` `fprintdir`, over the engine's
//! directory-stack record (the stack without the current directory, top
//! first, as zsh's `dirstack`).
//!
//! Paths are normalised textually (zsh `fixdir`); the engine's file
//! system seam offers no `realpath`, so `CHASE_LINKS`/`-P` keep the
//! logical path. The `chpwd` hook functions run in an `eval`-like frame
//! after the change (zsh `callhookfunc`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	Control, Ctx, Need, Outcome, R, dir, dirstack, done,
	zsh_args::{Func, Ops, isset, zerr, zx},
	zsh_typeset::{PM_EXPORTED, pm_type},
};
use crate::bash::{
	store::{Key, MiscKey, Record},
	syntax::zsh::tok::{head, tail},
	vm::{
		exec::push_script,
		proc::{Probe, ProbeResult, ScriptKind},
		zsh::params::{self, PmFlags},
	},
	zshopt::ZshOpt,
};

/// zsh `fprintdir` with `$HOME` as the named directory: `~` replaces the
/// home prefix.
fn fprintdir(home: Option<&[u8]>, s: &[u8], out: &mut Vec<u8>) {
	if let Some(h) = home.filter(|h| h.len() > 1)
		&& s.starts_with(h)
		&& matches!(s.get(h.len()), None | Some(b'/'))
	{
		out.push(b'~');
		out.extend_from_slice(tail(s, h.len()));
	} else {
		out.extend_from_slice(s);
	}
}

/// The bytes of an optional value.
fn opt(h: Option<&BString>) -> Option<&[u8]> {
	h.map(|h| h.as_slice())
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
	/// `doprintdir`: print the new directory (`POSIX_CD`).
	doprintdir: i32,
	/// The current directory (zsh `pwd`).
	pwd:        BString,
	/// zsh's `dirstack` with the current directory pushed on top.
	stack:      Vec<BString>,
}

/// zsh `cd_try_chdir`: change to `pfix/dest` if possible; the full path,
/// or the error text.
fn try_chdir(
	ctx: &Ctx<'_, '_>,
	pwd: &[u8],
	pfix: Option<&[u8]>,
	dest: &[u8],
) -> Result<Result<BString, BString>, Need> {
	let buf: Vec<u8> = match pfix.filter(|p| !p.is_empty()) {
		Some(p) if p.starts_with(b"/") => [p, b"/", dest].concat(),
		Some(p) => {
			let d: &[u8] = if pwd == b"/" { b"" } else { pwd };
			[d, b"/", p, b"/", dest].concat()
		},
		None if dest.starts_with(b"/") => dest.to_vec(),
		None => {
			let d = pwd.strip_suffix(b"/").unwrap_or(pwd);
			[d, b"/", dest].concat()
		},
	};
	let path = dir::logical(b"/", &buf);
	Ok(match ctx.probe(Probe::Chdir { path: path.clone() })? {
		ProbeResult::Bytes(Ok(_)) => Ok(path),
		ProbeResult::Bytes(Err(msg)) => Err(msg),
		_ => Err(BString::from("No such file or directory")),
	})
}

/// zsh `cd_able_vars`: under `CDABLE_VARS`, `name/rest` where `$name` is
/// an absolute path (zsh `getnameddir`).
fn cd_able_vars(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> Result<Option<BString>, Need> {
	if !isset(ctx, ZshOpt::Cdablevars)? {
		return Ok(None);
	}
	let end = s.find_byte(b'/').unwrap_or(s.len());
	let name = head(s, end).to_vec();
	let dir = zx(ctx, |ex| {
		Ok(match params::getparam(ex, &name)? {
			Some(p) if pm_type(p.flags.bits()) == 0 => Some(p.strval()),
			_ => None,
		})
	})?
	.ok()
	.flatten()
	.filter(|v| v.starts_with(b"/"));
	Ok(dir.map(|mut d| {
		d.extend_from_slice(tail(s, end));
		d
	}))
}

/// zsh `cd_do_chdir`: change to `dest` through `$cdpath` and
/// `CDABLE_VARS`; the new directory, or `None` after `ERROR: dest`.
fn do_chdir(ctx: &mut Ctx<'_, '_>, cd: &mut Cd, dest: &[u8]) -> Result<Option<BString>, Need> {
	let nocdpath = dest.first() == Some(&b'.')
		&& (matches!(dest.get(1), None | Some(b'/'))
			|| (dest.get(1) == Some(&b'.') && matches!(dest.get(2), None | Some(b'/'))));
	let pwd = cd.pwd.clone();
	if dest.starts_with(b"/") {
		return Ok(match try_chdir(ctx, &pwd, None, dest)? {
			Ok(p) => Some(p),
			Err(msg) => {
				ctx.usage(format!("{}: {}", errtext(&msg), dest.as_bstr()));
				None
			},
		});
	}
	let posixcd = isset(ctx, ZshOpt::Posixcd)?;
	let cdpath: Vec<BString> = zx(ctx, |ex| params::getaparam(ex, b"cdpath"))?
		.ok()
		.flatten()
		.unwrap_or_default();
	let hasdot =
		!nocdpath && !posixcd && cdpath.iter().any(|p| p.is_empty() || p.as_slice() == b".");
	let mut eno: Option<BString> = None;
	let note = |msg: BString, eno: &mut Option<BString>| {
		if !is_enoent(&msg) {
			*eno = Some(msg);
		}
	};
	if !hasdot && !posixcd {
		match try_chdir(ctx, &pwd, None, dest)? {
			Ok(p) => return Ok(Some(p)),
			Err(m) => note(m, &mut eno),
		}
	}
	if !nocdpath {
		for p in &cdpath {
			match try_chdir(ctx, &pwd, Some(p), dest)? {
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
		match try_chdir(ctx, &pwd, None, dest)? {
			Ok(p) => return Ok(Some(p)),
			Err(m) => note(m, &mut eno),
		}
	}
	if let Some(v) = cd_able_vars(ctx, dest)? {
		match try_chdir(ctx, &pwd, None, &v)? {
			Ok(p) => {
				cd.doprintdir += 1;
				return Ok(Some(p));
			},
			Err(m) => note(m, &mut eno),
		}
	}
	let msg = eno.unwrap_or_else(|| BString::from("No such file or directory"));
	ctx.usage(format!("{}: {}", errtext(&msg), dest.as_bstr()));
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
	if ctx.vp.overlay.is_none() {
		ctx.k.root.set_misc(ctx.cx.store, MiscKey::Cwd, new.clone());
	}
	ctx.vp.cwd = new.clone();
	let interactive = isset(ctx, ZshOpt::Interactive)?;
	if interactive || isset(ctx, ZshOpt::Posixcd)? {
		if func != Func::Cd && interactive {
			if !isset(ctx, ZshOpt::Pushdsilent)? && !quiet {
				let h = home(ctx)?;
				let mut out = Vec::new();
				fprintdir(opt(h.as_ref()), &new, &mut out);
				for d in &cd.stack {
					out.push(b' ');
					fprintdir(opt(h.as_ref()), d, &mut out);
				}
				out.push(b'\n');
				ctx.out(&out);
			}
		} else if !isset(ctx, ZshOpt::Cdsilent)? && cd.doprintdir > 0 {
			let h = home(ctx)?;
			let mut out = Vec::new();
			fprintdir(opt(h.as_ref()), &new, &mut out);
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
	let pwd = ctx.vp.cwd.clone();
	stack.insert(0, pwd.clone());
	let mut cd = Cd { func, doprintdir: 0, pwd, stack };
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
		let h = if ops.isset(b'l') { None } else { home(ctx)? };
		let mut out = Vec::new();
		if ops.isset(b'v') {
			out.extend_from_slice(b"0\t");
		}
		fprintdir(opt(h.as_ref()), &ctx.vp.cwd, &mut out);
		for (pos, d) in stack.iter().enumerate() {
			if ops.isset(b'v') {
				out.extend_from_slice(format!("\n{}\t", pos + 1).as_bytes());
			} else if ops.isset(b'p') {
				out.push(b'\n');
			} else {
				out.push(b' ');
			}
			fprintdir(opt(h.as_ref()), d, &mut out);
		}
		out.push(b'\n');
		ctx.out(&out);
		return done(0);
	}
	dirstack::store_entries(ctx.k, ctx.cx.store, ctx.vp, argv.to_vec());
	done(0)
}

/// zsh `bin_pwd`: the current directory (physical with `-r`/`-P` or
/// `CHASE_LINKS`, which this engine shows as its logical path).
pub fn pwd(ctx: &mut Ctx<'_, '_>) -> R {
	let mut line = ctx.vp.cwd.to_vec();
	line.push(b'\n');
	ctx.out(&line);
	done(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn fprintdir_abbreviates_home_at_a_boundary() {
		let mut o = Vec::new();
		fprintdir(Some(b"/home/u"), b"/home/u/x", &mut o);
		o.push(b' ');
		fprintdir(Some(b"/home/u"), b"/home/user", &mut o);
		o.push(b' ');
		fprintdir(Some(b"/"), b"/x", &mut o);
		assert_eq!(o, b"~/x /home/user /x");
	}

	#[test]
	fn error_text_lowercases_first_letter() {
		assert_eq!(errtext(b"No such file or directory"), "no such file or directory");
		assert!(is_enoent(b"No such file or directory"));
	}
}
