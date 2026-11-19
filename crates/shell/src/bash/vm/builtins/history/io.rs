//! The filesystem steps of history file operations (zsh `readhistfile`,
//! `savehistfile`, `lockhistfile`; bash `history -a -n -r -w`).
//!
//! A history operation is written as a pure function of the answers to the
//! steps it asked for so far ([`Steps`]): it runs from the start each time
//! a step is answered, like a pollable builtin, and commits its result only
//! once every step it needs has an answer. Each step is a
//! [`Probe::Hist`] carrying its position in the sequence, so asking for the
//! same operation twice (a lock retried after a sleep) is two probes.
//! [`perform`] carries a step out through the pollable [`Fs`] and the host
//! clock without blocking.

use std::{
	io,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use crate::bash::{
	diag,
	fs::{FsPoll, OpenFlags, SeekFrom, Stat},
	host::Deadline,
	vm::{
		Cx,
		proc::{Live, Probe, ProbeResult, Scratch},
	},
};

/// One filesystem or clock step of a history operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistOp {
	/// `stat` (`follow`) or `lstat`.
	Stat {
		/// Absolute path.
		path:   BString,
		/// Follow a final symbolic link.
		follow: bool,
	},
	/// The whole contents of a file.
	Read {
		/// Absolute path.
		path: BString,
	},
	/// Write `data` to a file opened as `how` says, with `mode` for a new
	/// file.
	Write {
		/// Absolute path.
		path: BString,
		/// The bytes.
		data: BString,
		/// How the file is opened.
		how:  WriteHow,
		/// Permission bits of a created file.
		mode: u32,
	},
	/// `unlink`.
	Unlink {
		/// Absolute path.
		path: BString,
	},
	/// `rename`.
	Rename {
		/// Absolute path renamed.
		from: BString,
		/// Absolute path replaced.
		to:   BString,
	},
	/// `symlink(target, path)`.
	Symlink {
		/// Link contents.
		target: BString,
		/// Absolute path created.
		path:   BString,
	},
	/// `link(from, to)`.
	Link {
		/// Existing file.
		from: BString,
		/// Absolute path created.
		to:   BString,
	},
	/// Take an `fcntl` record lock on the file (zsh `histfcntllock`), held
	/// until [`HistOp::Unlock`] or the end of the operation.
	Lock {
		/// Absolute path.
		path: BString,
	},
	/// Release the [`HistOp::Lock`] lock.
	Unlock,
	/// The canonical physical path ([`HistOut::Bytes`]).
	RealPath {
		/// Absolute path.
		path: BString,
	},
	/// Wait (the lock backoff of `zsleep_random`).
	Sleep {
		/// Nanoseconds.
		ns: u64,
	},
	/// The wall clock, whole seconds since the epoch.
	Now,
}

impl HistOp {
	/// The path the step works on (empty for clock steps), for the wait key.
	pub fn path(&self) -> BString {
		match self {
			Self::Stat { path, .. }
			| Self::Read { path }
			| Self::Write { path, .. }
			| Self::Unlink { path }
			| Self::Symlink { path, .. }
			| Self::Lock { path }
			| Self::RealPath { path } => path.clone(),
			Self::Rename { to, .. } | Self::Link { to, .. } => to.clone(),
			Self::Unlock | Self::Sleep { .. } | Self::Now => BString::default(),
		}
	}
}

/// How a [`HistOp::Write`] opens its file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WriteHow {
	/// `O_CREAT | O_TRUNC`.
	Trunc,
	/// `O_CREAT | O_APPEND`.
	Append,
	/// `O_CREAT | O_EXCL`.
	Excl,
}

/// What a successful step gives back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistOut {
	/// Done, nothing to report.
	Done,
	/// File metadata.
	Stat(Stat),
	/// File contents.
	Bytes(BString),
	/// Seconds since the epoch.
	Now(i64),
}

/// The class of a failed step's error, as the history code tests it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrKind {
	/// `ENOENT`.
	NotFound,
	/// `EEXIST`.
	Exists,
	/// The lock is held elsewhere.
	WouldBlock,
	/// Anything else.
	Other,
}

/// A failed step: its class and its `strerror` text (`%e`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistErr {
	/// Class.
	pub kind: ErrKind,
	/// `strerror` text.
	pub msg:  BString,
}

impl HistErr {
	fn of(e: &io::Error) -> Self {
		let kind = match e.kind() {
			io::ErrorKind::NotFound => ErrKind::NotFound,
			io::ErrorKind::AlreadyExists => ErrKind::Exists,
			io::ErrorKind::WouldBlock => ErrKind::WouldBlock,
			_ => ErrKind::Other,
		};
		let msg = match kind {
			ErrKind::NotFound => BString::from("no such file or directory"),
			ErrKind::Exists => BString::from("file exists"),
			_ => lower_first(&diag::strerror(e)),
		};
		Self { kind, msg }
	}
}

/// zsh's `%e`: the `strerror` text with its first letter lowered.
fn lower_first(s: &str) -> BString {
	let mut b = BString::from(s);
	if let Some(c) = b.first_mut() {
		c.make_ascii_lowercase();
	}
	b
}

/// The answer to one step.
pub type HistAnswer = Result<HistOut, HistErr>;

/// A step still to be answered: the probe to perform.
#[derive(Debug)]
pub struct Pending(pub Probe);

/// The answers a [`Steps`] reads: a builtin's or the reader's probe cache.
pub type Lookup<'a> = &'a dyn Fn(&Probe) -> Option<ProbeResult>;

/// The steps of one history operation, answered from the op's probe cache.
pub struct Steps<'a> {
	answers: Lookup<'a>,
	seq:     u32,
}

impl<'a> Steps<'a> {
	/// Steps answered by `answers`, numbered from `base + 1` (operations
	/// sharing one probe cache use distinct bases).
	pub fn new(answers: Lookup<'a>, base: u32) -> Self {
		Self { answers, seq: base }
	}

	/// The answer to the next step `op`, or the probe that gets it.
	///
	/// # Errors
	/// [`Pending`] while the step has no answer yet.
	pub fn ask(&mut self, op: HistOp) -> Result<HistAnswer, Pending> {
		self.seq += 1;
		let probe = Probe::Hist { seq: self.seq, op: Box::new(op) };
		match (self.answers)(&probe) {
			Some(ProbeResult::Hist(a)) => Ok(*a),
			_ => Err(Pending(probe)),
		}
	}

	/// The wall clock (one step).
	///
	/// # Errors
	/// [`Pending`] while unanswered.
	pub fn now(&mut self) -> Result<i64, Pending> {
		Ok(match self.ask(HistOp::Now)? {
			Ok(HistOut::Now(t)) => t,
			_ => 0,
		})
	}
}

/// Poll a just-started fs operation once, parking it in `live` (wrapped by
/// `wrap`) while pending.
fn ready<T>(
	p: FsPoll<T>,
	live: &mut Live,
	wrap: impl FnOnce(Box<dyn crate::bash::fs::FsPending<T>>) -> Live,
	tcx: &mut Context<'_>,
) -> Poll<io::Result<T>> {
	match p {
		FsPoll::Ready(r) => Poll::Ready(r),
		FsPoll::Pending(mut fut) => {
			let polled = fut.poll(tcx);
			if polled.is_pending() {
				*live = wrap(fut);
			}
			polled
		},
	}
}

/// Poll a unit fs operation started by `start` (kept in `sc.live` while
/// pending).
fn unit_op(
	tcx: &mut Context<'_>,
	sc: &mut Scratch,
	start: impl FnOnce() -> FsPoll<()>,
) -> Poll<HistAnswer> {
	let polled = match &mut sc.live {
		Live::Access(fut) => fut.poll(tcx),
		live => ready(start(), live, Live::Access, tcx),
	};
	polled.map(|r| r.map(|()| HistOut::Done).map_err(|e| HistErr::of(&e)))
}

/// Carry out step `op` of the probe in flight in `sc`; `Pending` parks
/// the caller (the fs or timer wakes the engine).
pub fn perform(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	op: &HistOp,
) -> Poll<HistAnswer> {
	match op {
		HistOp::Now => {
			let secs = cx.host.wall().secs;
			Poll::Ready(Ok(HistOut::Now(secs)))
		},
		HistOp::Stat { path, follow } => {
			let polled = match &mut sc.live {
				Live::Stat(fut) => fut.poll(tcx),
				live => {
					let started = cx.host.fs().stat(BStr::new(path), *follow);
					ready(started, live, Live::Stat, tcx)
				},
			};
			polled.map(|r| r.map(HistOut::Stat).map_err(|e| HistErr::of(&e)))
		},
		HistOp::Unlink { path } => unit_op(tcx, sc, || cx.host.fs().unlink(BStr::new(path))),
		HistOp::Rename { from, to } => {
			unit_op(tcx, sc, || cx.host.fs().rename(BStr::new(from), BStr::new(to)))
		},
		HistOp::Symlink { target, path } => {
			unit_op(tcx, sc, || cx.host.fs().symlink(BStr::new(target), BStr::new(path)))
		},
		HistOp::Link { from, to } => {
			unit_op(tcx, sc, || cx.host.fs().link(BStr::new(from), BStr::new(to)))
		},
		HistOp::Sleep { ns } => {
			if !matches!(sc.live, Live::Timer(_)) {
				let at = Deadline(cx.host.now_ns().saturating_add(*ns));
				sc.live = Live::Timer(cx.host.timer(at));
			}
			if let Live::Timer(timer) = &mut sc.live
				&& timer.poll(tcx).is_pending()
			{
				return Poll::Pending;
			}
			Poll::Ready(Ok(HistOut::Done))
		},
		HistOp::Unlock => {
			sc.io().zsh().hist_lock = None;
			Poll::Ready(Ok(HistOut::Done))
		},
		HistOp::Lock { path } => {
			let polled = match &mut sc.live {
				Live::Open(fut) => fut.poll(tcx),
				live => {
					let started = cx.host.fs().lock(BStr::new(path));
					ready(started, live, Live::Open, tcx)
				},
			};
			match polled {
				Poll::Pending => Poll::Pending,
				Poll::Ready(Ok(file)) => {
					sc.io().zsh().hist_lock = Some(file);
					Poll::Ready(Ok(HistOut::Done))
				},
				Poll::Ready(Err(e)) => Poll::Ready(Err(HistErr::of(&e))),
			}
		},
		HistOp::RealPath { path } => {
			let polled = match &mut sc.live {
				Live::Path(fut) => fut.poll(tcx),
				live => {
					let started = cx.host.fs().realpath(BStr::new(path));
					ready(started, live, Live::Path, tcx)
				},
			};
			polled.map(|r| r.map(HistOut::Bytes).map_err(|e| HistErr::of(&e)))
		},
		HistOp::Read { path } => read(tcx, cx, sc, path),
		HistOp::Write { path, data, how, mode } => write(tcx, cx, sc, path, data, *how, *mode),
	}
}

/// [`HistOp::Read`]: the file's bytes, read in chunks into the scratch.
fn read(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	path: &BString,
) -> Poll<HistAnswer> {
	// The bytes so far, beside `sc.live` (the file).
	let input = &mut sc.io.get_or_insert_with(Box::default).input;
	loop {
		match &mut sc.live {
			Live::None => match cx.host.fs().open(BStr::new(path), OpenFlags::READ, 0) {
				FsPoll::Ready(Ok(f)) => sc.live = Live::File(f),
				FsPoll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				FsPoll::Pending(f) => sc.live = Live::Open(f),
			},
			Live::Open(f) => match f.poll(tcx) {
				Poll::Ready(Ok(file)) => sc.live = Live::File(file),
				Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				Poll::Pending => return Poll::Pending,
			},
			Live::File(f) => {
				let mut buf = [0u8; 16384];
				match f.poll_read(tcx, &mut buf) {
					Poll::Ready(Ok(0)) => {
						let data = std::mem::take(input);
						return Poll::Ready(Ok(HistOut::Bytes(BString::from(data))));
					},
					Poll::Ready(Ok(n)) => input.extend_from_slice(&buf[..n]),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
					Poll::Pending => return Poll::Pending,
				}
			},
			_ => sc.live = Live::None,
		}
	}
}

/// [`HistOp::Write`]: open, then write `data` from where the file stood
/// once opened (kept, as 8 bytes, in the scratch's input buffer: the
/// file's position tells how much was written).
fn write(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	path: &BString,
	data: &BString,
	how: WriteHow,
	mode: u32,
) -> Poll<HistAnswer> {
	let flags = OpenFlags::WRITE.with(OpenFlags::CREATE).with(match how {
		WriteHow::Trunc => OpenFlags::TRUNC,
		WriteHow::Append => OpenFlags::APPEND,
		WriteHow::Excl => OpenFlags::EXCL,
	});
	// The file's position once opened, beside `sc.live` (the file).
	let input = &mut sc.io.get_or_insert_with(Box::default).input;
	loop {
		match &mut sc.live {
			Live::None => match cx.host.fs().open(BStr::new(path), flags, mode) {
				FsPoll::Ready(Ok(f)) => sc.live = Live::File(f),
				FsPoll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				FsPoll::Pending(f) => sc.live = Live::Open(f),
			},
			Live::Open(f) => match f.poll(tcx) {
				Poll::Ready(Ok(file)) => sc.live = Live::File(file),
				Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
				Poll::Pending => return Poll::Pending,
			},
			Live::File(f) => {
				let known = input
					.get(..8)
					.map(|b| u64::from_le_bytes(b.try_into().unwrap_or([0; 8])));
				let start = if let Some(s) = known {
					s
				} else {
					let at = if how == WriteHow::Append {
						f.seek(SeekFrom::End(0))
					} else {
						f.seek(SeekFrom::Current(0))
					};
					let at = at.unwrap_or(0);
					input.clear();
					input.extend_from_slice(&at.to_le_bytes());
					at
				};
				let done = f
					.seek(SeekFrom::Current(0))
					.map_or(0, |p| usize::try_from(p.saturating_sub(start)).unwrap_or(0));
				let rest = data.get(done..).unwrap_or_default();
				if rest.is_empty() {
					return match f.poll_flush(tcx) {
						Poll::Ready(Ok(())) => Poll::Ready(Ok(HistOut::Done)),
						Poll::Ready(Err(e)) => Poll::Ready(Err(HistErr::of(&e))),
						Poll::Pending => Poll::Pending,
					};
				}
				match f.poll_write(tcx, rest) {
					Poll::Ready(Ok(0)) => {
						let e = io::Error::from(io::ErrorKind::WriteZero);
						return Poll::Ready(Err(HistErr::of(&e)));
					},
					Poll::Ready(Ok(_)) => {},
					Poll::Ready(Err(e)) => return Poll::Ready(Err(HistErr::of(&e))),
					Poll::Pending => return Poll::Pending,
				}
			},
			_ => sc.live = Live::None,
		}
	}
}
