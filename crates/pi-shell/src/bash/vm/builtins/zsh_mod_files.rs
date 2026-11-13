//! zsh/files: `mkdir`, `rmdir`, `rm`, `mv`, `ln`, `chmod`, `chown`,
//! `chgrp` and `sync` as builtins (also as `zf_*`), plus the numbered
//! filesystem requests ([`Fsq`]) zsh/stat and zsh/attr share.
//!
//! Every filesystem call is a [`Probe::Fs`]: the builtin runs again from
//! scratch once it is answered, finding its earlier answers in order, so a
//! side effect happens exactly once. A `-i` question goes to stderr with
//! everything printed before it, then waits for a line on fd 0 (zsh's
//! `getchar`, whatever stdin is).
//!
//! Ported from zsh 5.9 `Src/Modules/files.c` (MIT-style licence, Copyright
//! (c) 1996-1997 Andrew Main and the zsh development group).

use std::io;

use bstr::{BString, ByteSlice};

use super::{
	Chunk, Ctx, Need, R, done,
	zsh_args::Ops,
	zsh_mod_util::zsh_errmsg,
	zsh_print::charset,
	zsh_quote::{Charset, niceformat},
};
use crate::bash::{
	fs::{PwEntry, PwQuery, Stat, StatKind},
	ids::{IntrinsicId, Platform},
	vm::{
		fsprobe::{FsAns, FsErr, FsReq, FsResult},
		probe::absolute,
		proc::{PendingWrite, Probe, ProbeResult},
		state,
	},
};

/// A builtin's filesystem requests, numbered in the order it makes them;
/// the answers of an earlier run are found in the same order.
pub(super) struct Fsq<'a> {
	answered: &'a [(Probe, ProbeResult)],
	seq:      u32,
	/// Where the next answer is looked for in `answered`.
	at:       usize,
	/// Questions asked on stdin so far.
	part:     u32,
}

impl<'a> Fsq<'a> {
	pub(super) const fn new(ctx: &Ctx<'a, '_>) -> Self {
		Self { answered: ctx.answered(), seq: 0, at: 0, part: 0 }
	}

	/// The answer to the next request, `req`, or the probe to ask for it.
	pub(super) fn ask(&mut self, req: FsReq) -> Result<&'a FsResult, Need> {
		let seq = self.seq;
		self.seq += 1;
		let answered = self.answered;
		for (i, (p, r)) in answered.iter().enumerate().skip(self.at) {
			if let (Probe::Fs { seq: s, req: q }, ProbeResult::Fs(res)) = (p, r)
				&& *s == seq
				&& **q == req
			{
				self.at = i + 1;
				return Ok(res);
			}
		}
		Err(Need::Probe(Probe::Fs { seq, req: Box::new(req) }))
	}

	/// `stat` (`follow`) or `lstat` of `path`.
	pub(super) fn stat(&mut self, path: &[u8], follow: bool) -> Result<Result<Stat, FsErr>, Need> {
		Ok(match self.ask(FsReq::Stat { path: path.into(), follow })? {
			Ok(FsAns::Stat(st)) => Ok(*st),
			Ok(_) => Err(odd()),
			Err(e) => Err(e.clone()),
		})
	}

	/// `fstat` of the engine fd `fd`.
	pub(super) fn stat_fd(&mut self, fd: i32) -> Result<Result<Stat, FsErr>, Need> {
		Ok(match self.ask(FsReq::FdStat { fd })? {
			Ok(FsAns::Stat(st)) => Ok(*st),
			Ok(_) => Err(odd()),
			Err(e) => Err(e.clone()),
		})
	}

	/// A request answered with success or an error.
	pub(super) fn op(&mut self, req: FsReq) -> Result<Result<(), FsErr>, Need> {
		Ok(match self.ask(req)? {
			Ok(_) => Ok(()),
			Err(e) => Err(e.clone()),
		})
	}

	/// A request answered with bytes.
	pub(super) fn bytes(&mut self, req: FsReq) -> Result<Result<&'a BString, FsErr>, Need> {
		Ok(match self.ask(req)? {
			Ok(FsAns::Bytes(b)) => Ok(b),
			Ok(_) => Err(odd()),
			Err(e) => Err(e.clone()),
		})
	}

	/// A request answered with names.
	pub(super) fn names(&mut self, req: FsReq) -> Result<Result<&'a [BString], FsErr>, Need> {
		Ok(match self.ask(req)? {
			Ok(FsAns::Names(n)) => Ok(n),
			Ok(_) => Err(odd()),
			Err(e) => Err(e.clone()),
		})
	}

	/// The user or group `q` names (`None`: no such entry, or no database).
	pub(super) fn user(&mut self, q: PwQuery) -> Result<Option<&'a PwEntry>, Need> {
		Ok(match self.ask(FsReq::UserDb(q))? {
			Ok(FsAns::Users(u)) => u.first(),
			_ => None,
		})
	}

	/// zsh `ask` after printing `prompt` on stderr: whether the line read
	/// from fd 0 starts with `y` or `Y` (end of input: no).
	fn confirm(&mut self, ctx: &mut Ctx<'_, '_>, prompt: &[u8]) -> Result<bool, Need> {
		let probe = Probe::Input {
			fd:         0,
			delim:      Some(b'\n'),
			lines:      1,
			nchars:     None,
			part:       self.part,
			timeout_ns: None,
		};
		self.part += 1;
		match ctx.probe(probe) {
			Ok(answer) => {
				// The run that asked wrote everything before the question.
				ctx.chunks.clear();
				Ok(
					matches!(answer, ProbeResult::Input { data, .. } if matches!(data.first(), Some(b'y' | b'Y'))),
				)
			},
			Err(need) => {
				for c in std::mem::take(&mut ctx.chunks) {
					let (fd, bytes) = match c {
						Chunk::Out(fd, b) => (fd, b),
						Chunk::Diag(d) => (2, ctx.k.render_diag(ctx.cx, ctx.vp, ctx.line, &d)),
					};
					ctx.vp
						.out
						.push_back(PendingWrite { fd, bytes: bytes.into(), off: 0 });
				}
				ctx.vp
					.out
					.push_back(PendingWrite { fd: 2, bytes: prompt.into(), off: 0 });
				Err(need)
			},
		}
	}
}

/// An answer of the wrong shape (a host bug): `EINVAL`.
fn odd() -> FsErr {
	FsErr::of(&io::ErrorKind::InvalidInput.into())
}

/// zsh's `%e` text of `e`.
pub(super) fn errmsg(e: &FsErr) -> String {
	zsh_errmsg(&e.io())
}

/// `s` as zsh's `nicezputs` shows it in a message.
pub(super) fn nice(cs: Charset, s: &[u8]) -> String {
	String::from_utf8_lossy(&niceformat(s, false, cs)).into_owned()
}

/// A user's argument as the file system sees it (relative to the vproc's
/// directory, `.` components and repeated slashes dropped as the kernel
/// would; `..` kept, it may cross a symbolic link). An empty name stays
/// empty and names nothing.
pub(super) fn host_path(ctx: &Ctx<'_, '_>, name: &[u8]) -> BString {
	if name.is_empty() {
		return BString::default();
	}
	let abs = absolute(&ctx.vp.cwd, name);
	if crate::bash::fs::url_root_len(&abs).is_some() {
		return abs;
	}
	normalize_on(
		&abs,
		if cfg!(windows) {
			Platform::Windows
		} else {
			Platform::Linux
		},
	)
}

/// [`host_path`]'s cleanup of an absolute name for `platform`. The root is
/// `/`, or on Windows a drive (`C:/`) or UNC (`//`) root; either slash
/// separates there.
fn normalize_on(abs: &[u8], platform: Platform) -> BString {
	let windows = platform == Platform::Windows;
	let is_sep = |c: &u8| *c == b'/' || (windows && *c == b'\\');
	let (mut out, rest) = match abs {
		[drive, b':', sep, rest @ ..] if windows && drive.is_ascii_alphabetic() && is_sep(sep) => {
			(BString::from([*drive, b':', b'/'].as_slice()), rest)
		},
		[a, b, rest @ ..] if windows && is_sep(a) && is_sep(b) => (BString::from("//"), rest),
		_ => (BString::from("/"), abs),
	};
	for part in rest.split(is_sep) {
		if part.is_empty() || part == b"." {
			continue;
		}
		if !out.ends_with(b"/") {
			out.push(b'/');
		}
		out.extend_from_slice(part);
	}
	if abs.last().is_some_and(is_sep) && !out.ends_with(b"/") {
		out.push(b'/');
	}
	out
}

/// The `S_IFMT` bits of a file type.
pub(super) const fn type_bits(kind: StatKind) -> u32 {
	match kind {
		StatKind::File => 0o100_000,
		StatKind::Dir => 0o040_000,
		StatKind::Symlink => 0o120_000,
		StatKind::Fifo => 0o010_000,
		StatKind::Socket => 0o140_000,
		StatKind::CharDev => 0o020_000,
		StatKind::BlockDev => 0o060_000,
	}
}

/// zsh `zstrtol(s, &end, 8)`: blanks, a sign, octal digits; the value and
/// whether the whole text was used (and was not empty).
fn octal(s: &[u8]) -> Option<u32> {
	if s.is_empty() {
		return None;
	}
	let mut i = s.iter().take_while(|&&c| c == b' ' || c == b'\t').count();
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		},
		Some(b'+') => {
			i += 1;
			false
		},
		_ => false,
	};
	let mut v: u32 = 0;
	while let Some(&c) = s.get(i)
		&& (b'0'..=b'7').contains(&c)
	{
		v = v.wrapping_mul(8).wrapping_add(u32::from(c - b'0'));
		i += 1;
	}
	(i == s.len()).then_some(if neg { v.wrapping_neg() } else { v })
}

/// Run zsh/files builtin `id`.
pub fn run(ctx: &mut Ctx<'_, '_>, id: IntrinsicId, ops: &Ops, args: &[BString]) -> R {
	use IntrinsicId as I;
	let cs = charset(ctx)?;
	let mut q = Fsq::new(ctx);
	let status = match id {
		I::Sync | I::ZfSync => {
			// zsh ignores what `sync` reports.
			let _ = q.op(FsReq::Sync)?;
			0
		},
		I::Mkdir | I::ZfMkdir => mkdir(ctx, &mut q, cs, ops, args)?,
		I::Rmdir | I::ZfRmdir => rmdir(ctx, &mut q, cs, args)?,
		I::Rm | I::ZfRm => rm(ctx, &mut q, cs, ops, args)?,
		I::Mv | I::ZfMv => ln(ctx, &mut q, cs, ops, args, true)?,
		I::Ln | I::ZfLn => ln(ctx, &mut q, cs, ops, args, false)?,
		I::Chmod | I::ZfChmod => chmod(ctx, &mut q, cs, ops, args)?,
		I::Chown | I::ZfChown => chown(ctx, &mut q, cs, ops, args, false)?,
		I::Chgrp | I::ZfChgrp => chown(ctx, &mut q, cs, ops, args, true)?,
		_ => return done(1),
	};
	done(status)
}

/// zsh `bin_mkdir`.
fn mkdir(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	ops: &Ops,
	args: &[BString],
) -> Result<i32, Need> {
	let umask = state::umask(ctx.cx.store, ctx.vp)?;
	let mut mode = 0o777 & !umask;
	if ops.isset(b'm') {
		let s = ops.arg(b'm').unwrap_or_default();
		if let Some(m) = octal(s) {
			mode = m;
		} else {
			ctx.usage(format!("invalid mode `{}'", nice(cs, s)));
			return Ok(1);
		}
	}
	let mut err = 0;
	for arg in args {
		// Trailing slashes go (a lone leading one stays).
		let floor = usize::from(arg.first() == Some(&b'/'));
		let mut end = arg.len();
		while end > floor && arg[end - 1] == b'/' {
			end -= 1;
		}
		let path: &[u8] = &arg[..end];
		if ops.isset(b'p') {
			let mut i = 0;
			loop {
				while path.get(i) == Some(&b'/') {
					i += 1;
				}
				while i < path.len() && path[i] != b'/' {
					i += 1;
				}
				if i >= path.len() {
					err |= domkdir(ctx, q, cs, path, mode, true)?;
					break;
				}
				if domkdir(ctx, q, cs, &path[..i], mode | 0o300, true)? != 0 {
					err = 1;
					break;
				}
			}
		} else {
			err |= domkdir(ctx, q, cs, path, mode, false)?;
		}
	}
	Ok(err)
}

/// zsh `domkdir`: make `path` with exactly `mode`; with `p` an existing
/// directory is fine.
fn domkdir(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	path: &[u8],
	mode: u32,
	p: bool,
) -> Result<i32, Need> {
	let rpath = host_path(ctx, path);
	let mut err = None;
	for _ in 0..8 {
		let e = match q.op(FsReq::Mkdir { path: rpath.clone(), mode })? {
			Ok(()) => return Ok(0),
			Err(e) => e,
		};
		if !p || !e.is(eexist()) {
			err = Some(e);
			break;
		}
		match q.stat(&rpath, true)? {
			Err(se) if se.is(enoent()) => err = Some(e),
			Err(se) => {
				err = Some(se);
				break;
			},
			Ok(st) if st.kind == StatKind::Dir => return Ok(0),
			Ok(_) => {
				err = Some(e);
				break;
			},
		}
	}
	let msg = err.map_or_else(String::new, |e| errmsg(&e));
	ctx.usage(format!("cannot make directory `{}': {msg}", nice(cs, path)));
	Ok(1)
}

/// `EEXIST`.
const fn eexist() -> i32 {
	#[cfg(unix)]
	return libc::EEXIST;
	#[cfg(not(unix))]
	return crate::bash::vm::fsprobe::posix::EEXIST;
}

/// `ENOENT` (as [`eexist`]).
const fn enoent() -> i32 {
	#[cfg(unix)]
	return libc::ENOENT;
	#[cfg(not(unix))]
	return crate::bash::vm::fsprobe::posix::ENOENT;
}

/// zsh `bin_rmdir`.
fn rmdir(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	args: &[BString],
) -> Result<i32, Need> {
	let mut err = 0;
	for arg in args {
		let path = host_path(ctx, arg);
		if let Err(e) = q.op(FsReq::Rmdir { path })? {
			ctx.usage(format!("cannot remove directory `{}': {}", nice(cs, arg), errmsg(&e)));
			err = 1;
		}
	}
	Ok(err)
}

/// What a recursive command does to each file.
enum Rec {
	/// `rm`.
	Rm { force: bool, interact: bool, unlinkdir: bool },
	/// `chmod` to the mode.
	Chmod(u32),
	/// `chown`/`lchown`.
	Chown { uid: Option<u32>, gid: Option<u32>, follow: bool },
}

/// zsh `recursivecmd` and its helpers, with zsh's chdir-relative paths
/// replaced by absolute ones (the messages name what the user wrote).
struct Recursive<'r, 'q> {
	q:       &'r mut Fsq<'q>,
	cs:      Charset,
	noerr:   bool,
	recurse: bool,
	rec:     Rec,
}

impl Recursive<'_, '_> {
	/// zsh `recursivecmd`.
	fn run(&mut self, ctx: &mut Ctx<'_, '_>, safe: bool, args: &[BString]) -> Result<i32, Need> {
		let mut err = 0;
		for arg in args {
			if err & 2 != 0 {
				break;
			}
			if !safe {
				let rp = host_path(ctx, arg);
				err |= self.doone(ctx, arg, &rp)?;
				continue;
			}
			// `-s`: change to the directory holding the last component (no
			// symbolic link followed there), then act on the component.
			if let Some((dir, leaf)) = safe_split(arg) {
				let d = host_path(ctx, &dir);
				let failed = match self.q.stat(&d, true)? {
					Ok(st) if st.kind == StatKind::Dir => None,
					Ok(_) => Some(FsErr::of(&io::ErrorKind::NotADirectory.into())),
					Err(e) => Some(e),
				};
				match failed {
					None => {
						let mut rp = d;
						if !rp.ends_with(b"/") {
							rp.push(b'/');
						}
						rp.extend_from_slice(&leaf);
						err |= self.doone(ctx, arg, &rp)?;
					},
					Some(e) => {
						err |= 1;
						if !self.noerr {
							ctx.usage(format!("{}: {}", nice(self.cs, arg), errmsg(&e)));
						}
					},
				}
			} else {
				let rp = host_path(ctx, arg);
				err |= self.doone(ctx, arg, &rp)?;
			}
		}
		Ok(i32::from(err != 0))
	}

	/// zsh `recursivecmd_doone`.
	fn doone(&mut self, ctx: &mut Ctx<'_, '_>, arg: &[u8], rp: &[u8]) -> Result<i32, Need> {
		let sp = if self.recurse
			&& let Ok(st) = self.q.stat(rp, false)?
		{
			if st.kind == StatKind::Dir {
				return self.dorec(ctx, arg, rp, st);
			}
			Some(st)
		} else {
			None
		};
		self.leaf(ctx, arg, rp, sp)
	}

	/// zsh `recursivecmd_dorec`.
	fn dorec(
		&mut self,
		ctx: &mut Ctx<'_, '_>,
		arg: &[u8],
		rp: &[u8],
		st: Stat,
	) -> Result<i32, Need> {
		let err1 = self.dirpre(ctx, arg, rp, st)?;
		if err1 & 2 != 0 {
			return Ok(2);
		}
		// zsh changes into the directory first.
		if let Err(e) = self.q.op(FsReq::Access { path: rp.into(), mode: 4 })? {
			if !self.noerr {
				ctx.usage(format!("{}: {}", nice(self.cs, arg), errmsg(&e)));
			}
			return Ok(1);
		}
		let mut err = err1;
		match self.q.names(FsReq::ReadDir { path: rp.into() })? {
			Err(e) => {
				if !self.noerr {
					ctx.usage(format!("{}: {}", nice(self.cs, arg), errmsg(&e)));
				}
				err = 1;
			},
			Ok(names) => {
				for name in names {
					if err & 2 != 0 {
						break;
					}
					let mut narg = BString::from(arg);
					narg.push(b'/');
					narg.extend_from_slice(name);
					let mut nrp = BString::from(rp);
					if !nrp.ends_with(b"/") {
						nrp.push(b'/');
					}
					nrp.extend_from_slice(name);
					err |= self.doone(ctx, &narg, &nrp)?;
				}
			},
		}
		if err & 2 != 0 {
			return Ok(2);
		}
		Ok(err | self.dirpost(ctx, arg, rp)?)
	}

	/// The `dirpre_func`: `chmod`/`chown` act on the directory before
	/// its contents.
	fn dirpre(
		&mut self,
		ctx: &mut Ctx<'_, '_>,
		arg: &[u8],
		rp: &[u8],
		st: Stat,
	) -> Result<i32, Need> {
		match self.rec {
			Rec::Rm { .. } => Ok(0),
			Rec::Chmod(_) | Rec::Chown { .. } => self.leaf(ctx, arg, rp, Some(st)),
		}
	}

	/// The `dirpost_func`: zsh `rm_dirpost`.
	fn dirpost(&mut self, ctx: &mut Ctx<'_, '_>, arg: &[u8], rp: &[u8]) -> Result<i32, Need> {
		let Rec::Rm { force, interact, .. } = self.rec else {
			return Ok(0);
		};
		if interact {
			let prompt = remove_prompt(ctx, self.cs, arg, None);
			if !self.q.confirm(ctx, &prompt)? {
				return Ok(0);
			}
		}
		if let Err(e) = self.q.op(FsReq::Rmdir { path: rp.into() })?
			&& !force
		{
			ctx.usage(format!("{}: {}", nice(self.cs, arg), errmsg(&e)));
			return Ok(1);
		}
		Ok(0)
	}

	/// The `leaf_func`: zsh `rm_leaf`, `chmod_dochmod`, `chown_dochown` /
	/// `chown_dolchown`.
	fn leaf(
		&mut self,
		ctx: &mut Ctx<'_, '_>,
		arg: &[u8],
		rp: &[u8],
		sp: Option<Stat>,
	) -> Result<i32, Need> {
		let cs = self.cs;
		let res = match self.rec {
			Rec::Chmod(mode) => self.q.op(FsReq::Chmod { path: rp.into(), mode })?,
			Rec::Chown { uid, gid, follow } => {
				self
					.q
					.op(FsReq::Chown { path: rp.into(), uid, gid, follow })?
			},
			Rec::Rm { force, interact, unlinkdir } => {
				if !unlinkdir || !force {
					let sp = match sp {
						Some(st) => Some(st),
						None => self.q.stat(rp, false)?.ok(),
					};
					if let Some(st) = sp {
						if !unlinkdir && st.kind == StatKind::Dir {
							if force {
								return Ok(0);
							}
							let e = FsErr::of(&io::ErrorKind::IsADirectory.into());
							ctx.usage(format!("{}: {}", nice(cs, arg), errmsg(&e)));
							return Ok(1);
						}
						if interact {
							let prompt = remove_prompt(ctx, cs, arg, None);
							if !self.q.confirm(ctx, &prompt)? {
								return Ok(0);
							}
						} else if !force
							&& st.kind != StatKind::Symlink
							&& self
								.q
								.op(FsReq::Access { path: rp.into(), mode: 2 })?
								.is_err()
						{
							let prompt = remove_prompt(ctx, cs, arg, Some(st.mode));
							if !self.q.confirm(ctx, &prompt)? {
								return Ok(0);
							}
						}
					}
				}
				match self.q.op(FsReq::Unlink { path: rp.into() })? {
					Err(_) if force => Ok(()),
					res => res,
				}
			},
		};
		match res {
			Ok(()) => Ok(0),
			Err(e) => {
				ctx.usage(format!("{}: {}", nice(cs, arg), errmsg(&e)));
				Ok(1)
			},
		}
	}
}

/// ``NAME: remove `ARG'? `` (with `, overriding mode NNNN` for a file the
/// user cannot write).
fn remove_prompt(ctx: &Ctx<'_, '_>, cs: Charset, arg: &[u8], mode: Option<u32>) -> Vec<u8> {
	let mut p = niceformat(ctx.name.as_bytes(), false, cs);
	p.extend_from_slice(b": remove `");
	p.extend_from_slice(&niceformat(arg, false, cs));
	match mode {
		Some(m) => p.extend_from_slice(format!("', overriding mode {:04o}? ", m & 0o7777).as_bytes()),
		None => p.extend_from_slice(b"'? "),
	}
	p
}

/// zsh `recursivecmd`'s `-s` split of `arg`: the directory to change to
/// and the component to act on there (trailing slashes dropped first, as
/// zsh does, which for `dir/` names `/` and `ir`); `None`: no slash.
fn safe_split(arg: &[u8]) -> Option<(BString, BString)> {
	let mut rp = arg.to_vec();
	let mut s = rp.iter().rposition(|&c| c == b'/')?;
	if s + 1 == rp.len() {
		while s > 0 && rp[s] == b'/' {
			rp[s] = 0;
			s -= 1;
		}
		while s > 0 && rp[s] != b'/' {
			s -= 1;
		}
	}
	let leaf_start = s + 1;
	let leaf_end = rp[leaf_start..]
		.iter()
		.position(|&c| c == 0)
		.map_or(rp.len(), |n| leaf_start + n);
	if leaf_start >= leaf_end {
		return None;
	}
	let leaf = BString::from(&rp[leaf_start..leaf_end]);
	let dir = if s > 0 {
		BString::from(&rp[..s])
	} else {
		BString::from("/")
	};
	Some((dir, leaf))
}

/// zsh `bin_rm`.
fn rm(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	ops: &Ops,
	args: &[BString],
) -> Result<i32, Need> {
	let force = ops.isset(b'f');
	let unlinkdir = ops.isset(b'd');
	let mut r = Recursive {
		q,
		cs,
		noerr: force,
		recurse: !unlinkdir && (ops.isset(b'R') || ops.isset(b'r')),
		rec: Rec::Rm { force, interact: ops.isset(b'i') && !force, unlinkdir },
	};
	let err = r.run(ctx, ops.isset(b's'), args)?;
	Ok(if force { 0 } else { err })
}

/// zsh `bin_chmod` (octal modes only, as zsh's).
fn chmod(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	ops: &Ops,
	args: &[BString],
) -> Result<i32, Need> {
	let Some(mode) = octal(&args[0]) else {
		ctx.usage(format!("invalid mode `{}'", nice(cs, &args[0])));
		return Ok(1);
	};
	let mut r = Recursive { q, cs, noerr: false, recurse: ops.isset(b'R'), rec: Rec::Chmod(mode) };
	r.run(ctx, ops.isset(b's'), &args[1..])
}

/// zsh `getnumeric`: a decimal number filling all of `p`.
fn getnumeric(p: &[u8]) -> Option<u32> {
	if !p.first().is_some_and(u8::is_ascii_digit) {
		return None;
	}
	let n = p.iter().take_while(|c| c.is_ascii_digit()).count();
	if n != p.len() {
		return None;
	}
	// `strtoul` into a `uid_t`: saturate, then truncate as C does.
	let v = p
		.iter()
		.fold(0u64, |v, &c| v.saturating_mul(10).saturating_add(u64::from(c - b'0')));
	Some(v as u32)
}

/// zsh `bin_chown` (`chgrp`: only a group).
fn chown(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	ops: &Ops,
	args: &[BString],
	chgrp: bool,
) -> Result<i32, Need> {
	let spec: &[u8] = &args[0];
	let mut uid = None;

	// The group part to look up, if any.
	let group: Option<&[u8]>;
	if chgrp {
		group = Some(spec);
	} else {
		let end = spec.find_byte(b':').or_else(|| spec.find_byte(b'.'));
		if end == Some(0) {
			group = Some(&spec[1..]);
		} else {
			let user = &spec[..end.unwrap_or(spec.len())];
			let mut pw = q.user(PwQuery::UserName(user.into()))?.cloned();
			let id = match &pw {
				Some(p) => p.id,
				None => {
					if let Some(n) = getnumeric(user) {
						n
					} else {
						ctx.usage(format!("{}: no such user", nice(cs, user)));
						return Ok(1);
					}
				},
			};
			uid = Some(id);
			match end {
				None => group = None,
				Some(e) => {
					let p = &spec[e + 1..];
					if p.is_empty() {
						if pw.is_none() {
							pw = q.user(PwQuery::Uid(id))?.cloned();
						}
						let Some(pw) = pw else {
							ctx.usage(format!("{}: no such user", nice(cs, user)));
							return Ok(1);
						};
						let mut r = Recursive {
							q,
							cs,
							noerr: false,
							recurse: ops.isset(b'R'),
							rec: Rec::Chown { uid, gid: Some(pw.gid), follow: !ops.isset(b'h') },
						};
						return r.run(ctx, ops.isset(b's'), &args[1..]);
					}
					group = (p != b":").then_some(p);
				},
			}
		}
	}
	let gid = match group {
		None => None,
		Some(g) => match q.user(PwQuery::GroupName(g.into()))? {
			Some(gr) => Some(gr.id),
			None => {
				if let Some(n) = getnumeric(g) {
					Some(n)
				} else {
					ctx.usage(format!("{}: no such group", nice(cs, g)));
					return Ok(1);
				}
			},
		},
	};
	let mut r = Recursive {
		q,
		cs,
		noerr: false,
		recurse: ops.isset(b'R'),
		rec: Rec::Chown { uid, gid, follow: !ops.isset(b'h') },
	};
	r.run(ctx, ops.isset(b's'), &args[1..])
}

/// `mv`/`ln` flags (zsh's `MV_*`).
#[derive(Clone, Copy)]
struct Mv {
	nodirs:      bool,
	force:       bool,
	interactive: bool,
	asknw:       bool,
	atomic:      bool,
	nochase:     bool,
	/// The move: `rename`, `symlink` or `link`.
	how:         How,
}

#[derive(Clone, Copy)]
enum How {
	Rename,
	Symlink,
	Link,
}

/// zsh `bin_ln` (`mv` when `mv`).
fn ln(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	ops: &Ops,
	args: &[BString],
	mv: bool,
) -> Result<i32, Need> {
	let mut f = if mv {
		Mv {
			nodirs:      false,
			force:       false,
			interactive: false,
			asknw:       !ops.isset(b'f'),
			atomic:      true,
			nochase:     false,
			how:         How::Rename,
		}
	} else {
		let symlink = ops.isset(b's');
		Mv {
			nodirs:      !symlink && !ops.isset(b'd'),
			force:       ops.isset(b'f'),
			interactive: false,
			asknw:       false,
			atomic:      false,
			nochase:     ops.isset(b'h') || ops.isset(b'n'),
			how:         if symlink { How::Symlink } else { How::Link },
		}
	};
	if ops.isset(b'i') && !ops.isset(b'f') {
		f.interactive = true;
	}
	let last = &args[args.len() - 1];
	if args.len() > 1 {
		let rp = host_path(ctx, last);
		if let Ok(st) = q.stat(&rp, true)?
			&& st.kind == StatKind::Dir
		{
			let mut have_dir = true;
			if f.nochase
				&& let Ok(lst) = q.stat(&rp, false)?
				&& lst.kind == StatKind::Symlink
			{
				// `ln -h` onto a symbolic link to a directory: never into it.
				if args.len() > 2 {
					let e = FsErr::of(&io::ErrorKind::NotADirectory.into());
					ctx.usage(format!("{}: {}", nice(cs, last), errmsg(&e)));
					return Ok(1);
				}
				if f.force {
					let _ = q.op(FsReq::Unlink { path: rp.clone() })?;
					have_dir = false;
				} else {
					let e = FsErr::of(&io::ErrorKind::AlreadyExists.into());
					ctx.usage(format!("{}: {}", nice(cs, last), errmsg(&e)));
					return Ok(1);
				}
			}
			if have_dir {
				let mut err = 0;
				for a in &args[..args.len() - 1] {
					let base = a.rfind_byte(b'/').map_or(&a[..], |i| &a[i + 1..]);
					let mut target = last.clone();
					target.push(b'/');
					target.extend_from_slice(base);
					err |= domove(ctx, q, cs, f, a, &target)?;
				}
				return Ok(err);
			}
		}
	}
	if args.len() > 2 {
		ctx.usage("last of many arguments must be a directory");
		return Ok(1);
	}
	let from = &args[0];
	let to: &[u8] = match args.get(1) {
		Some(t) => t,
		None => from.rfind_byte(b'/').map_or(&from[..], |i| &from[i + 1..]),
	};
	domove(ctx, q, cs, f, from, to)
}

/// zsh `domove`: move (rename, symlink or link) `p` to `qn`.
fn domove(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	cs: Charset,
	f: Mv,
	p: &[u8],
	qn: &[u8],
) -> Result<i32, Need> {
	let pbuf = host_path(ctx, p);
	let qbuf = host_path(ctx, qn);
	if f.nodirs {
		let failed = match q.stat(&pbuf, false)? {
			Err(e) => Some(e),
			Ok(st) if st.kind == StatKind::Dir => Some(FsErr::of(&io::ErrorKind::IsADirectory.into())),
			Ok(_) => None,
		};
		if let Some(e) = failed {
			ctx.usage(format!("{}: {}", nice(cs, p), errmsg(&e)));
			return Ok(1);
		}
	}
	if let Ok(st) = q.stat(&qbuf, false)? {
		let mut doit = f.force;
		if st.kind == StatKind::Dir {
			ctx.usage(format!("{}: cannot overwrite directory", nice(cs, qn)));
			return Ok(1);
		}
		if f.interactive {
			let prompt = replace_prompt(ctx, cs, qn, None);
			if !q.confirm(ctx, &prompt)? {
				return Ok(0);
			}
			doit = true;
		} else if f.asknw
			&& st.kind != StatKind::Symlink
			&& q
				.op(FsReq::Access { path: qbuf.clone(), mode: 2 })?
				.is_err()
		{
			let prompt = replace_prompt(ctx, cs, qn, Some(st.mode));
			if !q.confirm(ctx, &prompt)? {
				return Ok(0);
			}
			doit = true;
		}
		if doit && !f.atomic {
			let _ = q.op(FsReq::Unlink { path: qbuf.clone() })?;
		}
	}
	let req = match f.how {
		How::Rename => FsReq::Rename { from: pbuf.clone(), to: qbuf },
		// The link holds the text as written.
		How::Symlink => FsReq::Symlink { target: p.into(), path: qbuf },
		How::Link => FsReq::Link { from: pbuf.clone(), to: qbuf },
	};
	if let Err(e) = q.op(req)? {
		// A missing file when `p` exists is `q`'s fault.
		let errfile = if e.is(enoent()) && q.stat(&pbuf, false)?.is_ok() {
			qn
		} else {
			p
		};
		ctx.usage(format!("`{}': {}", nice(cs, errfile), errmsg(&e)));
		return Ok(1);
	}
	Ok(0)
}

/// ``NAME: replace `Q'? `` (with `, overriding mode NNNN`).
fn replace_prompt(ctx: &Ctx<'_, '_>, cs: Charset, qn: &[u8], mode: Option<u32>) -> Vec<u8> {
	let mut p = niceformat(ctx.name.as_bytes(), false, cs);
	p.extend_from_slice(b": replace `");
	p.extend_from_slice(&niceformat(qn, false, cs));
	match mode {
		Some(m) => p.extend_from_slice(format!("', overriding mode {:04o}? ", m & 0o7777).as_bytes()),
		None => p.extend_from_slice(b"'? "),
	}
	p
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn octal_modes_parse_like_zstrtol() {
		assert_eq!(octal(b"755"), Some(0o755));
		assert_eq!(octal(b" 0644"), Some(0o644));
		assert_eq!(octal(b"7a8"), None);
		assert_eq!(octal(b""), None);
		assert_eq!(octal(b"u+x"), None);
	}

	#[test]
	fn safe_split_follows_zsh() {
		assert_eq!(safe_split(b"x"), None);
		assert_eq!(safe_split(b"d/x"), Some(("d".into(), "x".into())));
		assert_eq!(safe_split(b"/x"), Some(("/".into(), "x".into())));
		assert_eq!(safe_split(b"dir/"), Some(("/".into(), "ir".into())));
	}

	#[test]
	fn host_paths_keep_windows_roots() {
		let win = |p: &str| normalize_on(p.as_bytes(), Platform::Windows);
		assert_eq!(win("C:/Users/me/./a//b/"), "C:/Users/me/a/b/");
		assert_eq!(win("C:\\Users\\me\\a"), "C:/Users/me/a");
		assert_eq!(win("//srv/share/./x"), "//srv/share/x");
		assert_eq!(win("/tmp//x"), "/tmp/x");
		assert_eq!(normalize_on(b"/tmp/./a//b/", Platform::Linux), "/tmp/a/b/");
	}
}
