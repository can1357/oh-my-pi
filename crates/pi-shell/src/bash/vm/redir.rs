//! Redirections: expand each target, open through the pollable `Fs`, and
//! install the fd, saving the previous one in the op's scratch so the
//! caller can restore it.
//!
//! Progress (`done`, the expanded target, a pending `open`) lives in the
//! scratch, so a redirection list that parks resumes where it stopped.
//!
//! zsh units take [`zsh_install`]: zsh's `multios` (an fd redirected more
//! than once in one command writes to all its targets, or reads them in
//! turn; a pipeline stage's pipe counts), `noclobber` with `clobberempty`
//! and `appendcreate`, `>&p`/`<&p` coprocess fds, `{var}` checks and zsh's
//! messages. Ported from zsh 5.9 `exec.c` (`addfd`, `closemn`, `clobber_open`
//! and `execcmd`'s redirection loop; MIT-style licence, Copyright (c)
//! 1992-1997 Paul Falstad and the zsh development group).

use std::{
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Cx, Kernel, TextKind,
	builtins::{self, Lhs},
	exec::{Flow, expanding},
	expand::arith_value,
	probe::{absolute, dev_fd},
	proc::{
		AssignValue, BangStage, DeferPhase, Deferral, FrameKind, Probe, ProbeResult, Saved, Slot,
		Stage, Vproc,
	},
	state::{self, Level},
};
use crate::bash::{
	diag::Diag,
	event::{EventData, RedirInfo, RedirKind, WaitKey},
	fd::{FdOrigin, FdRef},
	fs::{File, FileKind, FsOp, FsPoll, OpenFlags, SeekFrom, StatKind},
	host::{ChildRedir, OsHandle},
	ids::Dialect,
	ir::{RedirFdIr, RedirIr, RedirTargetIr, SpawnKind, Unit},
	mem::MemBuf,
	store::{OptId, VarValue},
	zshopt::ZshOpt,
};

/// Why a redirection list stopped.
pub enum Halt {
	/// The op parks, calls or is abandoned.
	Flow(Flow),
	/// A redirection failed (the diagnostic is printed): the command does
	/// not run and its status is 1.
	Failed,
}

fn scratch(vp: &mut Vproc) -> &mut super::proc::Scratch {
	super::exec::scratch(vp)
}

/// The top frame's I/O progress (created on first use: a redirection is
/// being applied).
fn io(vp: &mut Vproc) -> &mut super::proc::ScratchIo {
	scratch(vp).io()
}

/// Apply redirection list `list` of `unit`.
pub fn apply(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	list: u32,
	line: u32,
) -> Result<(), Halt> {
	let redirs = &unit.redirs[list as usize];
	let zsh = unit.mode.dialect() == Dialect::Zsh;
	let multios =
		zsh && state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Multios).unwrap_or(true);
	loop {
		// Read without creating the progress: an empty list needs none.
		let done = scratch(vp).io.as_ref().map_or(0, |io| io.redir.done);
		// Past the list: the zsh duplicates of a several-word target.
		let (r, copy) = if let Some(r) = redirs.get(done) {
			(r, None)
		} else {
			let more = scratch(vp)
				.io
				.as_ref()
				.and_then(|io| io.zsh.as_ref())
				.and_then(|z| z.more.get(done - redirs.len()));
			match more {
				Some((i, t)) => (&redirs[*i as usize], Some(t.clone())),
				None => return Ok(()),
			}
		};
		if multios && done == 0 && io(vp).zsh.as_ref().is_none_or(|z| z.multio.is_empty()) {
			seed_pipeline(vp, unit);
		}
		let target = if let Some(t) = io(vp).redir.target.clone().or(copy) {
			t
		} else if zsh {
			let mut words = zsh_target(k, vp, cx, unit, r, multios, line)?;
			if words.len() > 1 {
				// Several words: one redirection each, after the list.
				let at = u32::try_from(done).unwrap_or(u32::MAX);
				let progress = io(vp);
				progress
					.zsh()
					.more
					.extend(words.into_iter().map(|w| (at, w)));
				progress.redir.done += 1;
				scratch(vp).logs[Slot::Redirs as usize].clear();
				continue;
			}
			let t = words.pop().unwrap_or_default();
			io(vp).redir.target = Some(t.clone());
			t
		} else {
			let t = target_text(k, vp, cx, unit, r, line)?;
			io(vp).redir.target = Some(t.clone());
			t
		};
		let before = io(vp).saved.len();
		if zsh {
			zsh_install(k, vp, cx, r, &target, line, multios)?;
		} else if k
			.deferrals
			.iter()
			.any(|d| d.vproc == vp.vpid && d.phase == DeferPhase::Collect)
		{
			collect(k, vp, cx, r, &target, line)?;
		} else {
			// A FIFO the job's process will open itself is decided before any
			// open starts: an in-flight open that is dropped wakes its helper by
			// opening the other end, which the FIFO's real peer observes (a
			// writer then sees its reader vanish).
			if !k.bangs.is_empty() && waits_on_fifo(cx, vp, r, &target) {
				let path = absolute(&vp.cwd, &target);
				if deferrable(k, vp, cx, &redirs[done..], &path) {
					start_deferral(vp, k);
					return Ok(());
				}
			}
			match install(k, vp, cx, unit, r, &target, line) {
				Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })))
					if !k.bangs.is_empty() =>
				{
					if defer(k, vp, cx, &redirs[done..], &path) {
						return Ok(());
					}
					return Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })));
				},
				res => res?,
			}
		}
		if let RedirFdIr::Var(name) = &r.fd
			&& !state::option(&mut k.root, cx.store, vp, OptId::VarredirClose).unwrap_or(false)
			&& let Some(fd) = var_fd(k, vp, cx, name)
		{
			// A `{var}` fd outlives its command (unless `varredir_close`).
			let saved = &mut io(vp).saved;
			let mut i = before;
			while i < saved.len() {
				if saved[i].fd == fd {
					saved.remove(i);
				} else {
					i += 1;
				}
			}
		}
		let sc = scratch(vp);
		let progress = &mut sc.io().redir;
		progress.done += 1;
		progress.target = None;
		sc.logs[Slot::Redirs as usize].clear();
		if k.mask.contains(crate::bash::event::EventKind::Redirect) {
			let fd = match r.fd {
				RedirFdIr::Num(n) => n as i32,
				_ => default_fd(r.op),
			};
			let info = RedirInfo { fd, op: r.op, target: target.clone() };
			k.emit_op(cx, vp, unit.words.get(word_of(r)).map_or(0, |w| w.node), EventData::Redirect {
				redir: &info,
			});
		}
	}
}

const fn word_of(r: &RedirIr) -> usize {
	match r.target {
		RedirTargetIr::Word(w) => w as usize,
		RedirTargetIr::HereDoc { .. } => usize::MAX,
	}
}

const fn default_fd(op: RedirKind) -> i32 {
	match op {
		RedirKind::In
		| RedirKind::ReadWrite
		| RedirKind::DupIn
		| RedirKind::HereDoc
		| RedirKind::HereString => 0,
		_ => 1,
	}
}

/// Source text of word `w` (for `ambiguous redirect`).
fn word_text(unit: &Unit, w: u32) -> BString {
	let node = unit.words[w as usize].node;
	unit
		.nodes
		.get(node as usize)
		.map_or_else(BString::default, |n| {
			BString::from(
				unit
					.source
					.get(n.lo as usize..n.hi as usize)
					.unwrap_or_default(),
			)
		})
}

/// The expanded target (a path, an fd number, or document bytes).
fn target_text(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	line: u32,
) -> Result<BString, Halt> {
	match &r.target {
		RedirTargetIr::HereDoc { text, quoted: true } => Ok(text.clone()),
		RedirTargetIr::HereDoc { text, quoted: false } if unit.mode.dialect() == Dialect::Zsh => {
			expanding(k, vp, cx, Slot::Redirs, true, line, |ex| ex.zsh_heredoc(text))
				.map_err(Halt::Flow)
		},
		RedirTargetIr::HereDoc { text, quoted: false } => {
			let mode = super::exec::mode_of(vp);
			let tunit = match k.engine.text_unit(text, TextKind::HereDoc, mode) {
				Ok(u) => u,
				Err(e) => {
					// bash reports the script line after the document.
					#[expect(
						clippy::naive_bytecount,
						reason = "one here-document per redirection; no bytecount dependency"
					)]
					let at = line + text.iter().filter(|&&c| c == b'\n').count() as u32 + 1;
					k.diag(cx, vp, line, Diag::ComsubSyntax { line: at, msg: e.msg });
					return Err(Halt::Failed);
				},
			};
			let w = tunit.words.last().cloned().unwrap_or_default();
			expanding(k, vp, cx, Slot::Redirs, true, line, |ex| ex.scalar(&tunit, &w))
				.map_err(Halt::Flow)
		},
		RedirTargetIr::Word(w) => {
			let word = &unit.words[*w as usize];
			if r.op == RedirKind::HereString {
				let mut s =
					expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| ex.scalar(unit, word))
						.map_err(Halt::Flow)?;
				s.push(b'\n');
				Ok(s)
			} else {
				// Files and dup targets: no field or several is
				// `$word: ambiguous redirect` with the source text. Outside
				// posix mode the word is pathname-expanded too (a park
				// replays the expansion; the walk's answers are cached).
				let glob = !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
				let (mut fields, globs) = expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| {
					let mut out = Vec::new();
					let mut globs = Vec::new();
					if glob {
						ex.fields_glob(unit, word, &mut out, &mut globs)?;
					} else {
						ex.fields(unit, word, &mut out)?;
					}
					Ok((out, globs))
				})
				.map_err(Halt::Flow)?;
				if !globs.is_empty() {
					super::glob::expand_globs(k, vp, cx, &mut fields, &globs, line)
						.map_err(Halt::Flow)?;
				}
				if let Ok([one]) = <[BString; 1]>::try_from(fields) {
					Ok(one)
				} else {
					k.diag(cx, vp, line, Diag::AmbiguousRedirect { word: word_text(unit, *w) });
					Err(Halt::Failed)
				}
			}
		},
	}
}

/// zsh `xpandredir`: the words the target of zsh redirection `r` names.
/// With `multios` the word takes the full expansion and filename
/// generation (several words make one redirection each; none is the empty
/// name; `<&` needs exactly one: `file number expected`); without it the
/// word expands to one string (`PREFORK_SINGLE`), not globbed.
/// Here-documents and here-strings are [`target_text`]'s.
#[inline(never)]
fn zsh_target(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	multios: bool,
	line: u32,
) -> Result<Vec<BString>, Halt> {
	let RedirTargetIr::Word(w) = r.target else {
		return target_text(k, vp, cx, unit, r, line).map(|t| vec![t]);
	};
	if r.op == RedirKind::HereString {
		return target_text(k, vp, cx, unit, r, line).map(|t| vec![t]);
	}
	let word = &unit.words[w as usize];
	if !multios {
		return expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| ex.scalar(unit, word))
			.map(|t| vec![t])
			.map_err(Halt::Flow);
	}
	let (mut fields, globs) = expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| {
		let mut out = Vec::new();
		let mut globs = Vec::new();
		ex.fields_glob(unit, word, &mut out, &mut globs)?;
		Ok((out, globs))
	})
	.map_err(Halt::Flow)?;
	if !globs.is_empty() {
		super::zsh::zglob::expand_globs(k, vp, cx, &mut fields, &globs, line).map_err(Halt::Flow)?;
	}
	if r.op == RedirKind::DupIn && fields.len() != 1 {
		return Err(fail(k, vp, cx, line, zsh_msg("file number expected".into())));
	}
	Ok(fields)
}

/// Set fd `fd` to `h` (or close it), saving the previous object.
fn set_fd(vp: &mut Vproc, fd: i32, h: Option<FdRef>) {
	let prev = vp.fds.get(fd).cloned();
	io(vp).saved.push(Saved { fd, prev });
	vp.fds.set(fd, h);
}

/// The fd a redirection targets; `{var}` allocates one ≥ 10 and stores it
/// (`closing`: reads the fd it holds).
fn target_fd(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	closing: bool,
	line: u32,
) -> Result<i32, Diag> {
	match &r.fd {
		RedirFdIr::Default => Ok(default_fd(r.op)),
		RedirFdIr::Num(n) => Ok(*n as i32),
		RedirFdIr::Var(name) => {
			if closing {
				return var_fd(k, vp, cx, name)
					.ok_or_else(|| Diag::AmbiguousRedirect { word: name.clone() });
			}
			let fd = vp.fds.lowest_free(10);
			assign_fd_var(k, vp, cx, name, fd, line)?;
			Ok(fd)
		},
	}
}

/// Store `fd` in the `{var}` named `name`.
fn assign_fd_var(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	fd: i32,
	line: u32,
) -> Result<(), Diag> {
	let (base, index) = builtins::split_subscript(name);
	let lhs = Lhs { name: base, index, append: false };
	let value = AssignValue::Scalar(BString::from(fd.to_string()));
	if let Err(d) = builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic) {
		// bash: the assignment's error, then this one. `sh_invalidid` is a
		// builtin error, named by the simple command's word if it has one
		// (`exec: `10': not a valid identifier`).
		let cmd = super::exec::scratch(vp)
			.exec
			.as_ref()
			.and_then(|e| e.argv.first())
			.map(|w| w.to_str_lossy().into_owned());
		let d = match (d, cmd) {
			(d @ Diag::InvalidIdent { .. }, Some(cmd)) => d.by(cmd),
			(d, _) => d,
		};
		k.diag(cx, vp, line, d);
		let msg = format!("{}: cannot assign fd to variable", name.as_bstr()).into();
		return Err(Diag::Usage { msg });
	}
	Ok(())
}

/// The fd number a `{var}` holds, if it holds one (through namerefs).
fn var_fd(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, name: &[u8]) -> Option<i32> {
	let (base, index) = builtins::split_subscript(name);
	let (base, index): (BString, Option<BString>) =
		match state::deref(&k.root, cx.store, vp, base).ok()? {
			state::Deref::Plain => (base.into(), index.map(BString::from)),
			state::Deref::To { name, index: to } => (name, to.or_else(|| index.map(BString::from))),
			state::Deref::Circular => return None,
		};
	let index = index.as_deref().map(|i| i.as_slice());
	let var = state::lookup(&k.root, cx.store, vp, &base)
		.ok()
		.flatten()?
		.clone();
	let text = match index {
		None => BString::from(var.as_scalar()?),
		Some(key) if matches!(var.value, VarValue::Assoc(_)) => BString::from(var.key(key)?),
		Some(sub) => {
			let i = arith_value(k, cx, vp, sub).ok()?;
			BString::from(var.index(i)?)
		},
	};
	std::str::from_utf8(&text).ok()?.trim().parse().ok()
}

fn install(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<(), Halt> {
	match r.op {
		RedirKind::HereDoc | RedirKind::HereString => {
			let fd = target_fd(k, vp, cx, r, false, line).map_err(|d| fail(k, vp, cx, line, d))?;
			let h = FdRef::mem(MemBuf::new(target.to_vec()));
			set_fd(vp, fd, Some(h));
			Ok(())
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let closing = target.as_slice() == b"-";
			if closing {
				let fd = target_fd(k, vp, cx, r, true, line).map_err(|d| fail(k, vp, cx, line, d))?;
				set_fd(vp, fd, None);
				super::exec::coproc_fd_closed(k, vp, cx, fd);
				return Ok(());
			}
			let (digits, moving) = match target.strip_suffix(b"-") {
				Some(d) => (d, true),
				None => (target.as_slice(), false),
			};
			if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
				let src: i32 = std::str::from_utf8(digits)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(-1);
				let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
					// bash names the word as written (`$fd: Bad file descriptor`).
					let path = match r.target {
						RedirTargetIr::Word(w) => word_text(unit, w),
						RedirTargetIr::HereDoc { .. } => target.clone(),
					};
					let err = std::io::Error::other(crate::bash::fd::BadFd);
					return Err(fail(k, vp, cx, line, Diag::Io { path, err }));
				};
				let fd = target_fd(k, vp, cx, r, false, line).map_err(|d| fail(k, vp, cx, line, d))?;
				set_fd(vp, fd, Some(h));
				if moving && src != fd {
					set_fd(vp, src, None);
					super::exec::coproc_fd_closed(k, vp, cx, src);
				}
				return Ok(());
			}
			if r.op == RedirKind::DupOut && matches!(r.fd, RedirFdIr::Default) {
				// `>&file` is `&>file`.
				return open_into(
					k,
					vp,
					cx,
					&[1, 2],
					target,
					OpenFlags::WRITE
						.with(OpenFlags::CREATE)
						.with(OpenFlags::TRUNC),
					line,
				);
			}
			Err(fail(k, vp, cx, line, Diag::AmbiguousRedirect { word: target.clone() }))
		},
		RedirKind::Close => {
			let fd = target_fd(k, vp, cx, r, true, line).map_err(|d| fail(k, vp, cx, line, d))?;
			set_fd(vp, fd, None);
			super::exec::coproc_fd_closed(k, vp, cx, fd);
			Ok(())
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			let flags = open_flags(k, vp, cx, r.op, target);
			open_into(k, vp, cx, &[1, 2], target, flags, line)
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			let flags = open_flags(k, vp, cx, r.op, target);
			// bash opens the file first and assigns `{var}` after (a
			// readonly one leaves the file created); a parked open keeps
			// its slot free, so the fd is the same on resume.
			let fd = match &r.fd {
				RedirFdIr::Var(_) => vp.fds.lowest_free(10),
				_ => target_fd(k, vp, cx, r, false, line).map_err(|d| fail(k, vp, cx, line, d))?,
			};
			// bash moves a `{var}` fd to 10 or above with `F_DUPFD`, which
			// fails past `ulimit -n`.
			let limit = vp
				.rlimits
				.iter()
				.find(|(res, ..)| *res == crate::bash::host::Rlimit::Nofile)
				.and_then(|&(_, soft, _)| soft);
			if matches!(r.fd, RedirFdIr::Var(_))
				&& limit.is_some_and(|lim| u64::try_from(fd).is_ok_and(|fd| fd >= lim))
			{
				let mut msg = k.argv0.to_vec();
				msg.extend_from_slice(b": redirection error: cannot duplicate fd: Invalid argument\n");
				vp.out
					.push_back(super::proc::PendingWrite { fd: 2, bytes: msg.into(), off: 0 });
				let err = std::io::Error::from(std::io::ErrorKind::InvalidInput);
				return Err(fail(k, vp, cx, line, Diag::Io { path: target.clone(), err }));
			}
			open_into(k, vp, cx, &[fd], target, flags, line)?;
			if let RedirFdIr::Var(name) = &r.fd
				&& let Err(d) = assign_fd_var(k, vp, cx, name, fd, line)
			{
				set_fd(vp, fd, None);
				return Err(fail(k, vp, cx, line, d));
			}
			Ok(())
		},
	}
}

/// How a file redirection `op` to `target` opens it (`set -o noclobber`
/// makes `>` exclusive, but for `/dev/…`).
fn open_flags(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	op: RedirKind,
	target: &BString,
) -> OpenFlags {
	let noclobber = op == RedirKind::Out
		&& !target.starts_with(b"/dev/")
		&& state::option(&mut k.root, cx.store, vp, OptId::Noclobber).unwrap_or(false);
	let write = OpenFlags::WRITE.with(OpenFlags::CREATE);
	match op {
		_ if noclobber => write.with(OpenFlags::EXCL),
		RedirKind::In => OpenFlags::READ,
		RedirKind::Out | RedirKind::Clobber => write.with(OpenFlags::TRUNC),
		RedirKind::Append | RedirKind::AppendErr => write.with(OpenFlags::APPEND),
		RedirKind::OutErr => write.with(OpenFlags::TRUNC),
		_ => write.with(OpenFlags::READ),
	}
}

/// Whether the process a command spawns can apply redirection `r` itself
/// ([`collect`]): a file open, a numeric duplication or a close of a
/// numbered fd (not a here-document, not a `{var}` fd).
const fn childable(r: &RedirIr) -> bool {
	!matches!(r.fd, RedirFdIr::Var(_))
		&& matches!(r.target, RedirTargetIr::Word(_))
		&& matches!(
			r.op,
			RedirKind::In
				| RedirKind::Out
				| RedirKind::Append
				| RedirKind::Clobber
				| RedirKind::ReadWrite
				| RedirKind::OutErr
				| RedirKind::AppendErr
				| RedirKind::DupIn
				| RedirKind::DupOut
				| RedirKind::Close
		)
}

/// The open of `path` for the first of the redirections `rest` would wait
/// (a FIFO without its other end) in a vproc deciding a background job's
/// pid ([`super::proc::Bang`]): `$!` readers must not wait on that
/// rendezvous, which may need them. A job's lone command may leave the
/// open and the redirections after it to the process it spawns, once its
/// name resolves to an external ([`super::proc::Deferral`]): the stage
/// stops here (`true`; the pending open is dropped, the process repeats
/// it). Otherwise the job keeps its virtual pid and the open waits here
/// (`false`).
fn defer(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	rest: &[RedirIr],
	path: &BString,
) -> bool {
	if !deferrable(k, vp, cx, rest, path) {
		k.settle_bang(vp.vpid, None);
		return false;
	}
	// The pending open is dropped here; the process repeats it.
	io(vp).redir.opening = None;
	start_deferral(vp, k);
	true
}

/// Whether redirection `r` to `target` opens a FIFO for one direction only,
/// the open that waits for the other end (`O_RDWR` never does). A stat the
/// filesystem cannot answer at once counts as no.
fn waits_on_fifo(cx: &mut Cx<'_>, vp: &Vproc, r: &RedirIr, target: &BString) -> bool {
	let one_way = matches!(
		r.op,
		RedirKind::In
			| RedirKind::Out
			| RedirKind::Append
			| RedirKind::Clobber
			| RedirKind::OutErr
			| RedirKind::AppendErr
	);
	if !one_way || !childable(r) || dev_fd(target).is_some() {
		return false;
	}
	let path = absolute(&vp.cwd, target);
	matches!(cx.host.fs().stat(BStr::new(&path), true), FsPoll::Ready(Ok(st)) if st.kind == StatKind::Fifo)
}

/// Whether the job's lone external may leave the open of `path` and the
/// redirections after it (`rest`) to the process it spawns.
fn deferrable(k: &Kernel, vp: &Vproc, cx: &mut Cx<'_>, rest: &[RedirIr], path: &BString) -> bool {
	let Some(bang) = k.bangs.iter().find(|b| b.vproc == vp.vpid) else {
		return false;
	};
	let command = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.exec.as_ref())
		.is_some_and(|e| e.stage == Stage::Redirect && !e.argv.is_empty());
	bang.stage == BangStage::Lone
		&& command
		&& !k.deferrals.iter().any(|d| d.vproc == vp.vpid)
		&& rest.iter().all(childable)
		&& cx.host.child_opens(BStr::new(path))
}

/// Hand the current redirection and those after it to the spawned process.
fn start_deferral(vp: &mut Vproc, k: &mut Kernel) {
	let from = io(vp).redir.done;
	k.deferrals
		.push(Deferral { vproc: vp.vpid, from, phase: DeferPhase::Lookup, list: Vec::new() });
}

/// What a spawned process prints before an error's description for `what`
/// (`bash: line 1: f: `), as [`Diag::Io`] renders it here.
pub fn diag_prefix(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, line: u32, what: &[u8]) -> BString {
	let err = std::io::Error::other("");
	let mut text = k.render_quiet(cx, vp, line, &Diag::Io { path: BString::from(what), err });
	if text.last() == Some(&b'\n') {
		text.pop();
	}
	BString::from(text)
}

/// Redirection `r` to `target` of a command whose process applies its
/// redirections itself ([`DeferPhase::Collect`]): added to what the process
/// gets; nothing changes here. Errors found here (a bad fd, an ambiguous
/// target) fail the redirection as [`install`] does.
fn collect(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<(), Halt> {
	let mut add = Vec::with_capacity(2);
	match r.op {
		RedirKind::Close => add.push(ChildRedir::Close { fd: fd_number(k, vp, cx, r, true, line)? }),
		RedirKind::DupIn | RedirKind::DupOut if target.as_slice() == b"-" => {
			add.push(ChildRedir::Close { fd: fd_number(k, vp, cx, r, true, line)? });
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let (digits, moving) = match target.strip_suffix(b"-") {
				Some(d) => (d, true),
				None => (target.as_slice(), false),
			};
			if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
				let src: i32 = std::str::from_utf8(digits)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(-1);
				if !child_fd_open(k, vp, src) {
					let err = std::io::Error::other(crate::bash::fd::BadFd);
					return Err(fail(k, vp, cx, line, Diag::Io { path: target.clone(), err }));
				}
				let fd = fd_number(k, vp, cx, r, false, line)?;
				let diag = diag_prefix(k, cx, vp, line, digits);
				add.push(ChildRedir::Dup { fd, src, diag });
				if moving && src != fd {
					add.push(ChildRedir::Close { fd: src });
				}
			} else if r.op == RedirKind::DupOut && matches!(r.fd, RedirFdIr::Default) {
				// `>&file` is `&>file`.
				let flags = open_flags(k, vp, cx, RedirKind::OutErr, target);
				add.push(child_open(k, vp, cx, vec![1, 2], target, flags, line));
			} else {
				let d = Diag::AmbiguousRedirect { word: target.clone() };
				return Err(fail(k, vp, cx, line, d));
			}
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			let flags = open_flags(k, vp, cx, r.op, target);
			add.push(child_open(k, vp, cx, vec![1, 2], target, flags, line));
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			let fd = fd_number(k, vp, cx, r, false, line)?;
			let flags = open_flags(k, vp, cx, r.op, target);
			add.push(child_open(k, vp, cx, vec![fd], target, flags, line));
		},
		RedirKind::HereDoc | RedirKind::HereString => {
			unreachable!("a here-document is never left to the process (`childable`)")
		},
	}
	if let Some(d) = k.deferral(vp.vpid) {
		d.list.extend(add);
	}
	Ok(())
}

/// The fd redirection `r` sets ([`target_fd`]); a bad one fails it.
fn fd_number(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	closing: bool,
	line: u32,
) -> Result<i32, Halt> {
	target_fd(k, vp, cx, r, closing, line).map_err(|d| fail(k, vp, cx, line, d))
}

/// Whether `fd` is open in the process a command spawns at this point of
/// its collected redirections: inherited from the vproc, or set by one
/// collected before, and not closed since.
fn child_fd_open(k: &Kernel, vp: &Vproc, fd: i32) -> bool {
	let inherited = vp.fds.get(fd).is_some_and(FdRef::is_open);
	let list = k
		.deferrals
		.iter()
		.find(|d| d.vproc == vp.vpid)
		.map_or(&[][..], |d| d.list.as_slice());
	list.iter().fold(inherited, |open, redir| match redir {
		ChildRedir::Open { fds, .. } if fds.contains(&fd) => true,
		ChildRedir::Dup { fd: set, .. } if *set == fd => true,
		ChildRedir::Close { fd: closed } if *closed == fd => false,
		_ => open,
	})
}

/// The open of `target` onto `fds` by the process ([`ChildRedir::Open`]),
/// or the duplication `/dev/fd/N` (`/dev/stdin`, …) stands for.
fn child_open(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	fds: Vec<i32>,
	target: &BString,
	flags: OpenFlags,
	line: u32,
) -> ChildRedir {
	let diag = diag_prefix(k, cx, vp, line, target);
	if let Some(src) = dev_fd(target)
		&& let [fd] = fds.as_slice()
	{
		return ChildRedir::Dup { fd: *fd, src, diag };
	}
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	ChildRedir::Open { fds, path: absolute(&vp.cwd, target), flags, mode: 0o666 & !umask, diag }
}

/// Print `d` and fail the redirection.
fn fail(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32, d: Diag) -> Halt {
	k.diag(cx, vp, line, d);
	Halt::Failed
}

/// zsh's message for a redirection failure.
fn zsh_msg(msg: String) -> Diag {
	Diag::Usage { msg: msg.into() }
}

/// zsh's `%e`: `strerror` with its first letter in lower case. Also the
/// command layer's message for an external that did not start.
pub(super) fn zsh_errno(err: &std::io::Error) -> String {
	let text = crate::bash::diag::strerror(err);
	let mut chars = text.chars();
	chars.next().map_or_else(String::new, |c| {
		let mut s: String = c.to_lowercase().collect();
		s.push_str(chars.as_str());
		s
	})
}

/// zsh `execcmd`'s pipe ends: when the op running is a pipeline stage, its
/// pipes are the first redirections of fd 1 (not the last stage) and fd 0
/// (not the first stage), so a redirection of them makes a multio (`print
/// x >file | cat` writes both).
#[inline(never)]
fn seed_pipeline(vp: &mut Vproc, unit: &Unit) {
	let Some(f) = vp.frames.last() else {
		return;
	};
	let base =
		matches!(f.kind, FrameKind::Stage) || (vp.frames.len() == 1 && f.kind == FrameKind::Subshell);
	if !base {
		return;
	}
	let pc = f.pc;
	let Some((i, n)) = unit
		.spawns
		.iter()
		.filter(|s| s.kind == SpawnKind::Pipeline)
		.find_map(|s| {
			s.stages
				.iter()
				.position(|st| st.entry == pc)
				.map(|i| (i, s.stages.len()))
		})
	else {
		return;
	};
	let pipe = |h: &FdRef| h.origin() == FdOrigin::Mem && h.kind() == Some(FileKind::Pipe);
	let out = vp.fds.get(1).filter(|h| i + 1 < n && pipe(h)).cloned();
	let inp = vp.fds.get(0).filter(|h| i > 0 && pipe(h)).cloned();
	let multio = &mut io(vp).zsh().multio;
	if let Some(h) = out {
		multio.push((1, true, vec![h]));
	}
	if let Some(h) = inp {
		multio.push((0, false, vec![h]));
	}
}

/// zsh `addfd`: put `h` on `fd`. With `multios`, a second redirection of
/// the same fd in this list joins the first: outputs go to all of them (a
/// tee), inputs are read one after the other (a cat); mixing directions is
/// `file mode mismatch on fd N`.
fn place(vp: &mut Vproc, fd: i32, h: FdRef, output: bool, multios: bool) -> Result<(), Diag> {
	if !multios {
		set_fd(vp, fd, Some(h));
		return Ok(());
	}
	let multio = &mut io(vp).zsh().multio;
	let Some(at) = multio.iter().position(|(f, ..)| *f == fd) else {
		multio.push((fd, output, vec![h.clone()]));
		set_fd(vp, fd, Some(h));
		return Ok(());
	};
	let (_, out, fds) = &mut multio[at];
	if *out != output {
		return Err(zsh_msg(format!("file mode mismatch on fd {fd}")));
	}
	fds.push(h);
	let all = fds.clone();
	let merged: Box<dyn File> = if output {
		Box::new(Tee { done: vec![0; all.len()], targets: all })
	} else {
		Box::new(Cat { sources: all, at: 0 })
	};
	set_fd(vp, fd, Some(FdRef::open(merged, FdOrigin::Host)));
	Ok(())
}

/// The fd a zsh redirection targets: `{var}` allocates one ≥ 10 (zsh
/// `movefd`), refused when `var` is read-only, or under `noclobber` when it
/// holds an fd still open (zsh `execcmd`).
fn zsh_target_fd(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
) -> Result<i32, Diag> {
	match &r.fd {
		RedirFdIr::Default => Ok(default_fd(r.op)),
		RedirFdIr::Num(n) => Ok(*n as i32),
		RedirFdIr::Var(name) => {
			let readonly = state::lookup_declared(&k.root, cx.store, vp, name)
				.ok()
				.flatten()
				.is_some_and(|v| v.attrs.contains(crate::bash::store::Attrs::READONLY));
			if readonly {
				return Err(zsh_msg(format!(
					"can't allocate file descriptor to readonly parameter {}",
					name.as_bstr()
				)));
			}
			let clobber =
				state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Clobber).unwrap_or(true);
			if !clobber
				&& let Some(old) = var_fd(k, vp, cx, name)
				&& vp.fds.get(old).is_some_and(FdRef::is_open)
			{
				return Err(zsh_msg(format!(
					"can't clobber parameter {} containing file descriptor {old}",
					name.as_bstr()
				)));
			}
			Ok(vp.fds.lowest_free(10))
		},
	}
}

/// The flags zsh opens a file target with: `>` under `noclobber` refuses an
/// existing regular file (unless empty with `clobberempty`; zsh
/// `clobber_open`), `>>` under `noclobber` needs the file to exist unless
/// `appendcreate`; `|`/`!` forms ignore both. `Err` is the refusal or a
/// pending probe.
fn zsh_flags(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<OpenFlags, Halt> {
	let write = OpenFlags::WRITE.with(OpenFlags::CREATE);
	let append = matches!(r.op, RedirKind::Append | RedirKind::AppendErr);
	let output =
		matches!(r.op, RedirKind::Out | RedirKind::Clobber | RedirKind::OutErr | RedirKind::DupOut);
	if r.op == RedirKind::In {
		return Ok(OpenFlags::READ);
	}
	if r.op == RedirKind::ReadWrite {
		return Ok(OpenFlags::READ.with(write));
	}
	let clobber =
		r.clobber || state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Clobber).unwrap_or(true);
	if append {
		let create = clobber
			|| state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Appendcreate).unwrap_or(false);
		return Ok(if create {
			write.with(OpenFlags::APPEND)
		} else {
			OpenFlags::WRITE.with(OpenFlags::APPEND)
		});
	}
	if output && !clobber {
		let path = absolute(&vp.cwd, target);
		let st = match super::command::command_probe(k, cx, vp, &Probe::Stat { path, follow: true }) {
			Err(key) => return Err(Halt::Flow(Flow::Block(key))),
			Ok(ProbeResult::Stat(st)) => st,
			Ok(_) => None,
		};
		let empty_ok =
			state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Clobberempty).unwrap_or(false);
		if let Some(st) = st
			&& st.kind == StatKind::File
			&& !(empty_ok && st.size == 0)
		{
			let d = zsh_msg(format!("file exists: {}", target.as_bstr()));
			return Err(fail(k, vp, cx, line, d));
		}
	}
	Ok(write.with(OpenFlags::TRUNC))
}

/// Open `path` with `flags` (pollable) for a zsh redirection; a failure is
/// zsh's `ERRNO: path`.
fn zsh_open(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	path: &BString,
	flags: OpenFlags,
	line: u32,
) -> Result<FdRef, Halt> {
	if let Some(src) = dev_fd(path) {
		return vp
			.fds
			.get(src)
			.cloned()
			.filter(FdRef::is_open)
			.ok_or_else(|| {
				let d = zsh_msg(format!("{}: bad file descriptor", path.as_bstr()));
				fail(k, vp, cx, line, d)
			});
	}
	let abs = absolute(&vp.cwd, path);
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	let mut tcx = Context::from_waker(&k.waker);
	let res = match io(vp).redir.opening.as_mut() {
		Some(p) => p.poll(&mut tcx),
		None => match cx.host.fs().open(BStr::new(&abs), flags, 0o666 & !umask) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut p) => {
				let r = p.poll(&mut tcx);
				if r.is_pending() {
					io(vp).redir.opening = Some(p);
				}
				r
			},
		},
	};
	match res {
		Poll::Pending => Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path: abs }))),
		Poll::Ready(Ok(file)) => {
			io(vp).redir.opening = None;
			Ok(FdRef::open(file, FdOrigin::Host))
		},
		Poll::Ready(Err(err)) => {
			io(vp).redir.opening = None;
			let d = zsh_msg(format!("{}: {}", zsh_errno(&err), path.as_bstr()));
			Err(fail(k, vp, cx, line, d))
		},
	}
}

/// Apply one redirection of a zsh unit (zsh `execcmd`'s redirection loop
/// with `addfd`).
#[inline(never)]
fn zsh_install(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	target: &BString,
	line: u32,
	multios: bool,
) -> Result<(), Halt> {
	let place_on =
		|k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, fd: i32, h: FdRef, out: bool| {
			place(vp, fd, h, out, multios).map_err(|d| fail(k, vp, cx, line, d))
		};
	match r.op {
		RedirKind::HereDoc | RedirKind::HereString => {
			let fd = zsh_target_fd(k, vp, cx, r).map_err(|d| fail(k, vp, cx, line, d))?;
			let h = FdRef::mem(MemBuf::new(target.to_vec()));
			if let RedirFdIr::Var(name) = &r.fd {
				set_fd(vp, fd, Some(h));
				return assign_fd_var(k, vp, cx, name, fd, line).map_err(|d| fail(k, vp, cx, line, d));
			}
			place_on(k, vp, cx, fd, h, false)
		},
		RedirKind::Close => zsh_close(k, vp, cx, r, line),
		RedirKind::DupIn | RedirKind::DupOut if target.as_slice() == b"-" => {
			zsh_close(k, vp, cx, r, line)
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let output = r.op == RedirKind::DupOut;
			let src = if target.as_slice() == b"p" {
				// The coprocess: `>&p` writes its input, `<&p` reads its output.
				let Some(co) = vp.coprocs.last() else {
					return Err(fail(k, vp, cx, line, zsh_msg("no coprocess".into())));
				};
				Some(if output { co.write } else { co.read })
			} else if !target.is_empty() && target.iter().all(u8::is_ascii_digit) {
				std::str::from_utf8(target)
					.ok()
					.and_then(|s| s.parse().ok())
			} else {
				None
			};
			let Some(src) = src else {
				if output && matches!(r.fd, RedirFdIr::Default) {
					// `>& file`: `&> file`.
					restricted_write(k, vp, cx, line)?;
					let flags = zsh_flags(k, vp, cx, r, target, line)?;
					let h = zsh_open(k, vp, cx, target, flags, line)?;
					place_on(k, vp, cx, 1, h.clone(), true)?;
					return place_on(k, vp, cx, 2, h, true);
				}
				let d = zsh_msg(format!("file number expected: {}", target.as_bstr()));
				return Err(fail(k, vp, cx, line, d));
			};
			let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
				return Err(fail(k, vp, cx, line, zsh_msg(format!("{src}: bad file descriptor"))));
			};
			let fd = zsh_target_fd(k, vp, cx, r).map_err(|d| fail(k, vp, cx, line, d))?;
			if let RedirFdIr::Var(name) = &r.fd {
				set_fd(vp, fd, Some(h));
				return assign_fd_var(k, vp, cx, name, fd, line).map_err(|d| fail(k, vp, cx, line, d));
			}
			place_on(k, vp, cx, fd, h, output)
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			restricted_write(k, vp, cx, line)?;
			let flags = zsh_flags(k, vp, cx, r, target, line)?;
			let h = zsh_open(k, vp, cx, target, flags, line)?;
			place_on(k, vp, cx, 1, h.clone(), true)?;
			place_on(k, vp, cx, 2, h, true)
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			if r.op != RedirKind::In {
				restricted_write(k, vp, cx, line)?;
			}
			let fd = zsh_target_fd(k, vp, cx, r).map_err(|d| fail(k, vp, cx, line, d))?;
			let flags = zsh_flags(k, vp, cx, r, target, line)?;
			let h = zsh_open(k, vp, cx, target, flags, line)?;
			if let RedirFdIr::Var(name) = &r.fd {
				set_fd(vp, fd, Some(h));
				return assign_fd_var(k, vp, cx, name, fd, line).map_err(|d| fail(k, vp, cx, line, d));
			}
			// `<>` is both: never part of a multio.
			if r.op == RedirKind::ReadWrite {
				set_fd(vp, fd, Some(h));
				return Ok(());
			}
			place_on(k, vp, cx, fd, h, r.op != RedirKind::In)
		},
	}
}

/// zsh's `IS_WRITE_FILE` check under `restricted`: a redirection writing a
/// file fails before the file is opened.
fn restricted_write(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
) -> Result<(), Halt> {
	if state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Restricted).unwrap_or(false) {
		let d = zsh_msg("writing redirection not allowed in restricted mode".into());
		return Err(fail(k, vp, cx, line, d));
	}
	Ok(())
}

/// zsh `<&-` / `>&-`: close the fd; `{var}<&-` closes the fd `var` holds
/// (`parameter var does not contain a file descriptor` when it holds none,
/// refused for a read-only `var`, `failed to close file descriptor N` when
/// it is not open).
fn zsh_close(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	line: u32,
) -> Result<(), Halt> {
	let fd = match &r.fd {
		RedirFdIr::Var(name) => {
			let readonly = state::lookup_declared(&k.root, cx.store, vp, name)
				.ok()
				.flatten()
				.is_some_and(|v| v.attrs.contains(crate::bash::store::Attrs::READONLY));
			if readonly {
				let d = zsh_msg(format!(
					"can't close file descriptor from readonly parameter {}",
					name.as_bstr()
				));
				return Err(fail(k, vp, cx, line, d));
			}
			let Some(fd) = var_fd(k, vp, cx, name) else {
				let d =
					zsh_msg(format!("parameter {} does not contain a file descriptor", name.as_bstr()));
				return Err(fail(k, vp, cx, line, d));
			};
			if !vp.fds.get(fd).is_some_and(FdRef::is_open) {
				let d = zsh_msg(format!("failed to close file descriptor {fd}: bad file descriptor"));
				return Err(fail(k, vp, cx, line, d));
			}
			fd
		},
		RedirFdIr::Num(n) => *n as i32,
		RedirFdIr::Default => default_fd(r.op),
	};
	set_fd(vp, fd, None);
	super::exec::coproc_fd_closed(k, vp, cx, fd);
	Ok(())
}

/// zsh's multio tee (`closemn` for output): every write goes to each
/// target in turn; a target that is gone (closed, failed) is skipped. A
/// write that cannot finish keeps how far each target got, for the
/// caller's retry of the same bytes.
struct Tee {
	targets: Vec<FdRef>,
	done:    Vec<usize>,
}

impl File for Tee {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<std::io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
		self.done.resize(self.targets.len(), 0);
		let mut pending = false;
		for (t, done) in self.targets.iter().zip(&mut self.done) {
			while *done < buf.len() {
				match t.poll_write(cx, &buf[*done..]) {
					Poll::Ready(Ok(n)) if n > 0 => *done += n,
					Poll::Ready(_) => *done = buf.len(),
					Poll::Pending => {
						pending = true;
						break;
					},
				}
			}
		}
		if pending {
			return Poll::Pending;
		}
		self.done.fill(0);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
		for t in &self.targets {
			if t.poll_flush(cx).is_pending() {
				return Poll::Pending;
			}
		}
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> std::io::Result<Box<dyn File>> {
		Ok(Box::new(Self { targets: self.targets.clone(), done: Vec::new() }))
	}
}

/// zsh's multio cat (`closemn` for input): reads each source to its end in
/// turn.
struct Cat {
	sources: Vec<FdRef>,
	at:      usize,
}

impl File for Cat {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<std::io::Result<usize>> {
		while let Some(src) = self.sources.get(self.at) {
			match src.poll_read(cx, buf) {
				Poll::Ready(Ok(0)) => self.at += 1,
				other => return other,
			}
		}
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<std::io::Result<usize>> {
		Poll::Ready(Err(std::io::Error::other(crate::bash::fd::BadFd)))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> std::io::Result<Box<dyn File>> {
		Ok(Box::new(Self { sources: self.sources.clone(), at: self.at }))
	}
}

/// Open `path` (pollable) and install it on every fd of `fds`.
fn open_into(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	fds: &[i32],
	path: &BString,
	flags: OpenFlags,
	line: u32,
) -> Result<(), Halt> {
	if let Some(src) = dev_fd(path) {
		let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
			k.diag(cx, vp, line, Diag::Io {
				path: path.clone(),
				err:  std::io::Error::other(crate::bash::fd::BadFd),
			});
			return Err(Halt::Failed);
		};
		for &fd in fds {
			set_fd(vp, fd, Some(h.clone()));
		}
		return Ok(());
	}
	let abs = absolute(&vp.cwd, path);
	// The vproc's own `umask` (a subshell's applies to its redirections).
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	let mut tcx = Context::from_waker(&k.waker);
	let res = match io(vp).redir.opening.as_mut() {
		Some(p) => p.poll(&mut tcx),
		None => match cx.host.fs().open(BStr::new(&abs), flags, 0o666 & !umask) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut p) => {
				let r = p.poll(&mut tcx);
				if r.is_pending() {
					io(vp).redir.opening = Some(p);
				}
				r
			},
		},
	};
	match res {
		Poll::Pending => Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path: abs }))),
		Poll::Ready(Ok(file)) => {
			io(vp).redir.opening = None;
			let h = FdRef::open(file, FdOrigin::Host);
			for &fd in fds {
				set_fd(vp, fd, Some(h.clone()));
			}
			Ok(())
		},
		Poll::Ready(Err(err)) => {
			io(vp).redir.opening = None;
			let d =
				if err.kind() == std::io::ErrorKind::AlreadyExists && flags.contains(OpenFlags::EXCL) {
					Diag::NoClobber { path: path.clone() }
				} else {
					Diag::Io { path: path.clone(), err }
				};
			k.diag(cx, vp, line, d);
			Err(Halt::Failed)
		},
	}
}
