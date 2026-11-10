//! Pollable lookups for ops and builtins: file probes (`stat`, `access`),
//! PATH search, whole-file reads and fd input up to a delimiter.
//!
//! A builtin or `[[ ]]` primary asks for a [`Probe`]; the op performs it
//! through the pollable `Fs` (parking the vproc while it is pending) and
//! caches the answer in its scratch, then re-runs the builtin, which is pure
//! until all its probes are answered.

use std::task::{Context, Poll};

use bstr::{BStr, BString};

use super::{
	Cx, Kernel,
	builtins::history::io::{ErrKind, HistErr, HistOp},
	glob::Walk,
	proc::{Live, PathSearch, Probe, ProbeResult, Scratch, Vproc},
};
use crate::bash::{
	diag,
	event::WaitKey,
	fd::FdRef,
	fs::{Access, FileKind, FsOp, FsPoll, OpenFlags, Stat, StatKind},
	host::Deadline,
	ids::Platform,
};

/// The cached answer to `p`.
pub fn cached<'s>(sc: &'s Scratch, p: &Probe) -> Option<&'s ProbeResult> {
	sc.probes().iter().find(|(q, _)| q == p).map(|(_, r)| r)
}

/// `/dev/fd/N`, `/proc/self/fd/N`, `/proc/thread-self/fd/N`, `/dev/stdin`,
/// `/dev/stdout`, `/dev/stderr`: the fd number. The engine runs inside the
/// host process, so opening these through the host would reach the host's
/// descriptors instead of the shell's.
pub fn dev_fd(path: &[u8]) -> Option<i32> {
	let n = match path {
		b"/dev/stdin" => return Some(0),
		b"/dev/stdout" => return Some(1),
		b"/dev/stderr" => return Some(2),
		_ => path
			.strip_prefix(b"/dev/fd/")
			.or_else(|| path.strip_prefix(b"/proc/self/fd/"))
			.or_else(|| path.strip_prefix(b"/proc/thread-self/fd/"))?,
	};
	std::str::from_utf8(n).ok()?.parse().ok()
}

/// A synthesized `stat` of an engine fd.
pub(super) fn fd_stat(vp: &Vproc, fd: i32) -> Option<Stat> {
	let h = vp.fds.get(fd)?;
	let kind = match h.kind()? {
		FileKind::Regular => StatKind::File,
		FileKind::Pipe => StatKind::Fifo,
		FileKind::Socket => StatKind::Socket,
		FileKind::Tty | FileKind::Device => StatKind::CharDev,
	};
	Some(Stat {
		kind,
		mode: 0o600,
		size: 0,
		uid: 0,
		gid: 0,
		dev: 0,
		ino: 0,
		nlink: 1,
		mtime_ns: 0,
		atime_ns: 0,
		ctime_ns: 0,
		blocks: 0,
		rdev: 0,
		blksize: 0,
	})
}

/// `stat` (`follow`: not `lstat`) of `path`, continuing the one in flight
/// in `sc`; `None` when it fails.
fn poll_stat(
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	tcx: &mut Context<'_>,
	path: &[u8],
	follow: bool,
) -> Poll<Option<Stat>> {
	if let Some(fd) = dev_fd(path) {
		return Poll::Ready(fd_stat(vp, fd));
	}
	let polled = match &mut sc.live {
		Live::Stat(fut) => fut.poll(tcx),
		_ => match cx.host.fs().stat(BStr::new(path), follow) {
			FsPoll::Ready(polled) => Poll::Ready(polled),
			FsPoll::Pending(mut fut) => {
				let polled = fut.poll(tcx);
				if polled.is_pending() {
					sc.live = Live::Stat(fut);
				}
				polled
			},
		},
	};
	polled.map(|r| {
		sc.live = Live::None;
		r.ok()
	})
}

/// Perform `probe` (or continue it); `Err` is the wait key while it is pending.
pub fn perform(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	probe: &Probe,
) -> Result<ProbeResult, WaitKey> {
	begin(sc, probe);
	let mut tcx = Context::from_waker(&k.waker);
	let res = match probe {
		Probe::Stat { path, follow } => match poll_stat(cx, vp, sc, &mut tcx, path, *follow) {
			Poll::Ready(st) => ProbeResult::Stat(st),
			Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Stat, path: path.clone() }),
		},
		Probe::StatAll { paths, ends } => loop {
			let done = sc.io().zsh().stats.len();
			let Some(path) = paths.get(done) else {
				break ProbeResult::Stats(std::mem::take(&mut sc.io().zsh().stats));
			};
			match poll_stat(cx, vp, sc, &mut tcx, path, true) {
				Poll::Ready(st) => {
					let file = st.as_ref().is_some_and(|s| s.kind != StatKind::Dir)
						&& u32::try_from(done).is_ok_and(|d| ends.binary_search(&d).is_ok());
					sc.io().zsh().stats.push(st);
					// Later paths are asked only if the search goes on.
					if file {
						break ProbeResult::Stats(std::mem::take(&mut sc.io().zsh().stats));
					}
				},
				Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Stat, path: path.clone() }),
			}
		},
		Probe::Access { path, mode } => {
			if let Some(fd) = dev_fd(path) {
				return Ok(finish(
					sc,
					ProbeResult::Ok(vp.fds.get(fd).is_some_and(|handle| handle.is_open())),
				));
			}
			let mut want = Access::EXISTS;
			for (bit, a) in [(1, Access::READ), (2, Access::WRITE), (4, Access::EXEC)] {
				if mode & bit != 0 {
					want = want.with(a);
				}
			}
			let polled = match &mut sc.live {
				Live::Access(fut) => fut.poll(&mut tcx),
				_ => match cx.host.fs().access(BStr::new(path), want) {
					FsPoll::Ready(polled) => Poll::Ready(polled),
					FsPoll::Pending(mut fut) => {
						let polled = fut.poll(&mut tcx);
						if polled.is_pending() {
							sc.live = Live::Access(fut);
						}
						polled
					},
				},
			};
			match polled {
				Poll::Ready(polled) => ProbeResult::Ok(polled.is_ok()),
				Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Access, path: path.clone() }),
			}
		},
		Probe::Chdir { path } => {
			let polled = match &mut sc.live {
				Live::Access(fut) => fut.poll(&mut tcx),
				_ => match cx.host.fs().chdir_check(BStr::new(path)) {
					FsPoll::Ready(polled) => Poll::Ready(polled),
					FsPoll::Pending(mut fut) => {
						let polled = fut.poll(&mut tcx);
						if polled.is_pending() {
							sc.live = Live::Access(fut);
						}
						polled
					},
				},
			};
			match polled {
				Poll::Ready(Ok(())) => ProbeResult::Bytes(Ok(BString::default())),
				Poll::Ready(Err(e)) => {
					ProbeResult::Bytes(Err(BString::from(diag::strerror(&e).as_bytes())))
				},
				Poll::Pending => {
					return Err(WaitKey::Fs { op: FsOp::ChdirCheck, path: path.clone() });
				},
			}
		},
		Probe::Path { name, path } => {
			let io = sc.io();
			if io.search.is_none() {
				let extensions = executable_extensions(k, cx, vp);
				io.search = Some(PathSearch {
					cands:         candidates(
						path,
						name,
						&vp.cwd,
						k.engine.config().platform,
						&extensions,
					),
					idx:           0,
					checking_exec: false,
					nonexec:       None,
				});
			}
			match path_search(&mut tcx, cx, sc) {
				// Windows reports the probed path: `shown_candidate` splits PATH
				// on `:` and its `idx` stops addressing one entry once every
				// entry expands to a name plus its PATHEXT candidates.
				Search::Found(found) if k.engine.config().platform == Platform::Windows => {
					ProbeResult::Path(Some(found))
				},
				// bash shows `dir/name` as built (`./e` for an empty entry).
				Search::Found(_) => {
					let idx = sc
						.io
						.as_ref()
						.and_then(|io| io.search.as_ref())
						.map_or(0, |s| s.idx);
					ProbeResult::Path(shown_candidate(path, name, idx))
				},
				Search::NotFound => ProbeResult::Path(None),
				Search::Pending(key) => return Err(key),
			}
		},
		Probe::Read { path } => {
			if let Some(fd) = dev_fd(path) {
				// `. /dev/stdin`: the engine's fd, not the host process's.
				let handle = vp.fds.handle(fd);
				let input = &mut sc.io().input;
				loop {
					let mut buf = [0u8; 8192];
					match handle.poll_read(&mut tcx, &mut buf) {
						Poll::Ready(Ok(0)) => {
							break ProbeResult::Bytes(Ok(BString::from(std::mem::take(input))));
						},
						Poll::Ready(Ok(n)) => input.extend_from_slice(&buf[..n]),
						Poll::Ready(Err(e)) => {
							break ProbeResult::Bytes(Err(BString::from(diag::strerror(&e).as_bytes())));
						},
						Poll::Pending => return Err(WaitKey::Read { fd }),
					}
				}
			} else {
				match read_file(&mut tcx, cx, sc, path) {
					Poll::Ready(polled) => ProbeResult::Bytes(polled),
					Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Open, path: path.clone() }),
				}
			}
		},
		Probe::DumpHas(q) => {
			let (path, name) = (&q.path, &q.name);
			let stamp = (q.mtime_ns, q.size);
			let funcs = match k.dump_funcs(path, stamp) {
				Some(funcs) => funcs,
				None => match read_file(&mut tcx, cx, sc, path) {
					Poll::Ready(Ok(data)) => {
						let funcs = super::zsh::zwc::DumpHeader::parse(&data).map_or_else(
							|_| std::collections::HashSet::new(),
							|head| head.loadable(&data),
						);
						let funcs = std::sync::Arc::new(funcs);
						k.cache_dump_funcs(path, stamp, std::sync::Arc::clone(&funcs));
						funcs
					},
					Poll::Ready(Err(_)) => std::sync::Arc::default(),
					Poll::Pending => return Err(WaitKey::Fs { op: FsOp::Open, path: path.clone() }),
				},
			};
			ProbeResult::Ok(funcs.contains(name.as_slice()))
		},
		Probe::RealPath { path } => {
			let polled = match &mut sc.live {
				Live::Path(fut) => fut.poll(&mut tcx),
				_ => match cx.host.fs().realpath(BStr::new(path)) {
					FsPoll::Ready(polled) => Poll::Ready(polled),
					FsPoll::Pending(mut fut) => {
						let polled = fut.poll(&mut tcx);
						if polled.is_pending() {
							sc.live = Live::Path(fut);
						}
						polled
					},
				},
			};
			match polled {
				Poll::Ready(polled) => ProbeResult::Path(polled.ok()),
				Poll::Pending => return Err(WaitKey::Fs { op: FsOp::RealPath, path: path.clone() }),
			}
		},
		Probe::Glob { pattern, opts } => {
			let mut walk = sc
				.io()
				.walk
				.take()
				.unwrap_or_else(|| Box::new(Walk::new(pattern)));
			match walk.poll(&mut tcx, cx, sc, &vp.cwd, *opts) {
				Ok(paths) => ProbeResult::Paths(paths),
				Err(key) => {
					sc.io().walk = Some(walk);
					return Err(key);
				},
			}
		},
		// fd-level probes change the fd table: only a builtin asks for them,
		// and its probes go through `perform_mut`.
		Probe::Fd(_) => ProbeResult::Fd(Box::new(super::fdprobe::FdAnswer::Err(
			super::fsprobe::FsErr::of(&std::io::Error::from(std::io::ErrorKind::Unsupported)),
		))),
		Probe::Fs { req, .. } => ProbeResult::Fs(super::fsprobe::perform(&mut tcx, cx, vp, sc, req)?),
		// Only the `zftp` builtin asks, through `perform_mut`.
		Probe::Zftp { .. } => {
			ProbeResult::Zftp(Box::new(super::builtins::zsh_mod_zftp::ZftpAns::Done))
		},
		// A program's shell has no history files
		// ([`crate::bash::Profile::Tool`]): reads find none, writes fail; only
		// the clock steps run.
		Probe::Hist { op, .. }
			if !matches!(**op, HistOp::Now | HistOp::Sleep { .. })
				&& super::is_tool(cx.store, vp).unwrap_or(true) =>
		{
			ProbeResult::Hist(Box::new(Err(HistErr {
				kind: ErrKind::Other,
				msg:  BString::from("history files are not available in this shell"),
			})))
		},
		Probe::Hist { op, .. } => match super::builtins::history::io::perform(&mut tcx, cx, sc, op) {
			Poll::Ready(answer) => ProbeResult::Hist(Box::new(answer)),
			Poll::Pending => return Err(WaitKey::Fs { op: FsOp::HistFile, path: op.path() }),
		},
		Probe::Ready { fd } => {
			// `read -t 0`: is input available, without consuming it.
			let handle = input_handle(k, vp, *fd);
			ProbeResult::Ok(handle.is_open() && handle.poll_read(&mut tcx, &mut []).is_ready())
		},
		Probe::Input { fd, delim, lines, nchars, timeout_ns, .. } => {
			let handle = input_handle(k, vp, *fd);
			let seekable = handle.kind() == Some(FileKind::Regular);
			// A Windows console in line mode ends a line with `\r\n`; a Unix
			// terminal maps the `\r` to `\n` itself (ICRNL). Pipes and files
			// keep their `\r`, as zsh does.
			let console_lines = delim == &Some(b'\n')
				&& handle.kind() == Some(FileKind::Tty)
				&& k.engine.config().platform == Platform::Windows;
			// The bytes so far, beside `sc.live` (the timer).
			let input = &mut sc.io.get_or_insert_with(Box::default).input;
			let lines = (*lines).max(1) as usize;
			// Delimiters read so far.
			#[expect(clippy::naive_bytecount, reason = "bytecount is not a pi-shell dependency")]
			let mut seen = delim.map_or(0, |d| input.iter().filter(|&&c| c == d).count());
			loop {
				let done_len = nchars.is_some_and(|n| input.len() >= n);
				let done_delim = delim.is_some() && seen >= lines;
				if done_len || done_delim {
					break ProbeResult::Input {
						data:      line_input(std::mem::take(input), console_lines),
						eof:       false,
						timed_out: false,
					};
				}
				// On seekable fds read ahead, then give back what follows
				// the last delimiter wanted. A line mostly fits the first,
				// short read: what is read past it is only given back.
				let want = match (seekable, input.is_empty()) {
					(false, _) => 1,
					(true, true) => 256,
					(true, false) => 4096,
				};
				let want = nchars.map_or(want, |n| want.min(n - input.len()));
				let start = input.len();
				input.resize(start + want, 0);
				let polled = handle.poll_read(&mut tcx, &mut input[start..]);
				let got = match &polled {
					Poll::Ready(Ok(n)) => *n,
					_ => 0,
				};
				input.truncate(start + got);
				match polled {
					Poll::Ready(Ok(0) | Err(_)) => {
						break ProbeResult::Input {
							data:      line_input(std::mem::take(input), console_lines),
							eof:       true,
							timed_out: false,
						};
					},
					Poll::Ready(Ok(n)) => {
						let mut cut = None;
						if let Some(d) = *delim {
							for (i, _) in input[start..].iter().enumerate().filter(|&(_, &c)| c == d) {
								seen += 1;
								if seen == lines {
									cut = Some(i + 1);
									break;
								}
							}
						}
						if let Some(c) = cut
							&& c < n
						{
							input.truncate(start + c);
							let _ = handle.seek(crate::bash::fs::SeekFrom::Current(c as i64 - n as i64));
						}
					},
					Poll::Pending => {
						if let Some(t) = timeout_ns {
							if !matches!(sc.live, Live::Timer(_)) {
								let at = Deadline(cx.host.now_ns().saturating_add(*t));
								sc.live = Live::Timer(cx.host.timer(at));
							}
							if let Live::Timer(timer) = &mut sc.live
								&& timer.poll(&mut tcx).is_ready()
							{
								// Partial input is kept, as bash's `read -t` does.
								break ProbeResult::Input {
									data:      BString::from(std::mem::take(input)),
									eof:       false,
									timed_out: true,
								};
							}
						}
						return Err(WaitKey::Read { fd: *fd });
					},
				}
			}
		},
	};
	Ok(finish(sc, res))
}

/// The fd an input probe reads: `fd` of the table, or the shell's
/// terminal for [`Probe::TERMINAL_FD`] (a closed fd when there is none).
fn input_handle(k: &Kernel, vp: &Vproc, fd: i32) -> FdRef {
	if fd == Probe::TERMINAL_FD {
		return super::jobctl::open_key_terminal(k, vp).unwrap_or_else(|| vp.fds.handle(fd));
	}
	vp.fds.handle(fd)
}

/// Input read, with each `\r\n` turned into `\n` for a `console`'s lines.
fn line_input(mut data: Vec<u8>, console: bool) -> BString {
	if !console {
		return data.into();
	}
	let mut w = 0;
	for r in 0..data.len() {
		if data[r] == b'\r' && data.get(r + 1) == Some(&b'\n') {
			continue;
		}
		data[w] = data[r];
		w += 1;
	}
	data.truncate(w);
	BString::from(data)
}

/// [`perform`] for a builtin's probe ([`Need::Probe`](super::builtins::Need)):
/// the fd-level probes ([`Probe::Fd`]) may install descriptors in `vp`'s
/// fd table ([`super::fdprobe`]); everything else is [`perform`].
pub fn perform_mut(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	probe: &Probe,
) -> Result<ProbeResult, WaitKey> {
	if let Probe::Zftp { op, .. } = probe {
		begin(sc, probe);
		let answer = super::builtins::zsh_mod_zftp::io::perform(k, cx, vp, sc, op)?;
		return Ok(finish(sc, ProbeResult::Zftp(Box::new(answer))));
	}
	let Probe::Fd(fp) = probe else {
		return perform(k, cx, vp, sc, probe);
	};
	begin(sc, probe);
	let answer = super::fdprobe::perform(k, cx, vp, sc, fp)?;
	Ok(finish(sc, ProbeResult::Fd(Box::new(answer))))
}

/// Start `probe` unless it is the one in flight: forget the progress of
/// another.
pub(super) fn begin(sc: &mut Scratch, probe: &Probe) {
	let io = sc.io();
	if io.probing.as_ref() != Some(probe) {
		io.probing = Some(probe.clone());
		io.search = None;
		io.walk = None;
		io.input.clear();
		if let Some(z) = io.zsh.as_mut() {
			z.stats.clear();
		}
		sc.live = Live::None;
	}
}

/// Cache `r` as the answer of the probe in flight.
pub(super) fn finish(sc: &mut Scratch, r: ProbeResult) -> ProbeResult {
	sc.live = Live::None;
	let io = sc.io();
	io.search = None;
	io.walk = None;
	if let Some(p) = io.probing.take() {
		io.probes.push((p, r.clone()));
	}
	r
}

fn read_file(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	path: &BString,
) -> Poll<Result<BString, BString>> {
	let err = |e: &std::io::Error| BString::from(diag::strerror(e).as_bytes());
	// The bytes so far, beside `sc.live` (the file).
	let input = &mut sc.io.get_or_insert_with(Box::default).input;
	loop {
		match &mut sc.live {
			Live::None => {
				input.clear();
				let opened = cx.host.fs().open(BStr::new(path), OpenFlags::READ, 0);
				match opened {
					FsPoll::Ready(Ok(f)) => sc.live = Live::File(f),
					FsPoll::Ready(Err(e)) => return Poll::Ready(Err(err(&e))),
					FsPoll::Pending(f) => sc.live = Live::Open(f),
				}
			},
			Live::Open(f) => match f.poll(tcx) {
				Poll::Ready(Ok(file)) => sc.live = Live::File(file),
				Poll::Ready(Err(e)) => return Poll::Ready(Err(err(&e))),
				Poll::Pending => return Poll::Pending,
			},
			Live::File(f) => {
				let mut buf = [0u8; 8192];
				match f.poll_read(tcx, &mut buf) {
					Poll::Ready(Ok(0)) => {
						return Poll::Ready(Ok(BString::from(std::mem::take(input))));
					},
					Poll::Ready(Ok(n)) => input.extend_from_slice(&buf[..n]),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(err(&e))),
					Poll::Pending => return Poll::Pending,
				}
			},
			_ => sc.live = Live::None,
		}
	}
}

/// The standard utilities' path `command -p` searches (bash's
/// `conf_standard_path`: `confstr(_CS_PATH)` of the platform's C library).
pub const fn standard_path(platform: crate::bash::ids::Platform) -> &'static str {
	match platform {
		crate::bash::ids::Platform::MacOs => "/usr/bin:/bin:/usr/sbin:/sbin",
		crate::bash::ids::Platform::Linux => "/bin:/usr/bin",
		crate::bash::ids::Platform::Windows => "/bin;/usr/bin",
	}
}

/// The `$PATH` list separator on `platform`.
pub const fn path_separator(platform: Platform) -> u8 {
	if matches!(platform, Platform::Windows) {
		b';'
	} else {
		b':'
	}
}

/// `dir/name` for every `$PATH` entry; on Windows each is followed by the
/// `extensions` (`PATHEXT`) spellings unless `name` already ends in one.
pub fn candidates(
	path: &[u8],
	name: &[u8],
	cwd: &[u8],
	platform: Platform,
	extensions: &[String],
) -> Vec<BString> {
	let has_extension = extensions.iter().any(|ext| {
		name.len() >= ext.len() && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext.as_bytes())
	});
	let suffixes = if has_extension { &[] } else { extensions };
	let windows = platform == Platform::Windows;
	let mut out = Vec::new();
	for dir in path.split(|&c| c == path_separator(platform)) {
		let mut base = if dir.is_empty() {
			BString::from(cwd)
		} else {
			absolute_on(cwd, dir, platform)
		};
		if !(base.ends_with(b"/") || windows && base.ends_with(b"\\")) {
			base.push(b'/');
		}
		base.extend_from_slice(name);
		// The bare name first, then its PATHEXT spellings.
		let at = out.len();
		out.push(base);
		for ext in suffixes {
			let base = &out[at];
			let mut p = BString::from(Vec::with_capacity(base.len() + ext.len()));
			p.extend_from_slice(base);
			p.extend_from_slice(ext.as_bytes());
			out.push(p);
		}
	}
	out
}

/// The shell's `PATHEXT` suffixes, normalized as the exec check reads them
/// ([`Pathext`](crate::sys::pathext::Pathext)); empty off Windows.
pub fn executable_extensions(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Vec<String> {
	if k.engine.config().platform != Platform::Windows {
		return Vec::new();
	}
	let var = super::state::lookup(&k.root, cx.store, vp, b"PATHEXT")
		.ok()
		.flatten();
	let raw = var
		.as_ref()
		.and_then(|v| v.as_scalar())
		.map(String::from_utf8_lossy);
	crate::sys::pathext::Pathext::parse(raw.as_deref().map(std::ffi::OsStr::new)).into_extensions()
}

/// The `idx`th `$PATH` candidate as bash prints it (`type -p`,
/// `command -v`, `hash -t`): `dir/name`, an empty entry read as `.`.
pub fn shown_candidate(path: &[u8], name: &[u8], idx: usize) -> Option<BString> {
	let dir = path.split(|&c| c == b':').nth(idx)?;
	let mut p = BString::from(if dir.is_empty() { b".".as_slice() } else { dir });
	if !p.ends_with(b"/") {
		p.push(b'/');
	}
	p.extend_from_slice(name);
	Some(p)
}

pub use crate::bash::fs::url_root_len;

/// `name` made absolute against `cwd`: a name starting with `/` or a URL
/// path ([`url_root_len`]) is already absolute.
pub fn absolute(cwd: &[u8], name: &[u8]) -> BString {
	absolute_on(
		cwd,
		name,
		if cfg!(windows) {
			Platform::Windows
		} else {
			Platform::Linux
		},
	)
}

/// [`absolute`] for the configured shell platform: the Windows drive and UNC
/// rule stays testable on any host instead of compiling only on Windows.
pub fn absolute_on(cwd: &[u8], name: &[u8], platform: Platform) -> BString {
	if name.first() == Some(&b'/') || url_root_len(name).is_some() {
		return name.into();
	}
	if platform == Platform::Windows && is_windows_absolute(name) {
		return name.into();
	}
	let mut p = BString::from(cwd);
	if !p.ends_with(b"/") {
		p.push(b'/');
	}
	p.extend_from_slice(name);
	p
}

/// A Windows drive (`C:\x`, `C:/x`) or UNC (`\\srv\share`) path.
pub const fn is_windows_absolute(name: &[u8]) -> bool {
	matches!(name, [b'\\' | b'/', b'\\' | b'/', ..])
		|| matches!(name, [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic())
}

pub enum Search {
	Found(BString),
	NotFound,
	Pending(WaitKey),
}

/// Probe PATH candidates through the pollable `Fs`: `stat` (regular file),
/// then `access(X)`. Without an executable candidate, the first regular
/// file is found (bash's `FS_EXEC_PREFERRED`; running it fails with
/// `Permission denied`).
pub fn path_search(tcx: &mut Context<'_>, cx: &mut Cx<'_>, sc: &mut Scratch) -> Search {
	// The search, beside `sc.live` (its fs operation).
	let Some(search) = sc.io.as_mut().and_then(|io| io.search.as_mut()) else {
		return Search::NotFound;
	};
	loop {
		let Some(path) = search.cands.get(search.idx) else {
			if let Some(i) = search.nonexec.take() {
				search.idx = i;
				return Search::Found(search.cands[i].clone());
			}
			return Search::NotFound;
		};
		if search.checking_exec {
			let res = match &mut sc.live {
				Live::Access(p) => p.poll(tcx),
				_ => match cx.host.fs().access(BStr::new(path), Access::EXEC) {
					FsPoll::Ready(r) => Poll::Ready(r),
					FsPoll::Pending(mut p) => {
						let r = p.poll(tcx);
						if r.is_pending() {
							sc.live = Live::Access(p);
						}
						r
					},
				},
			};
			match res {
				Poll::Pending => {
					return Search::Pending(WaitKey::Fs { op: FsOp::Access, path: path.clone() });
				},
				Poll::Ready(Ok(())) => {
					sc.live = Live::None;
					return Search::Found(path.clone());
				},
				Poll::Ready(Err(_)) => {
					sc.live = Live::None;
					search.checking_exec = false;
					search.nonexec.get_or_insert(search.idx);
					search.idx += 1;
				},
			}
		} else {
			let res = match &mut sc.live {
				Live::Stat(p) => p.poll(tcx),
				_ => match cx.host.fs().stat(BStr::new(path), true) {
					FsPoll::Ready(r) => Poll::Ready(r),
					FsPoll::Pending(mut p) => {
						let r = p.poll(tcx);
						if r.is_pending() {
							sc.live = Live::Stat(p);
						}
						r
					},
				},
			};
			match res {
				Poll::Pending => {
					return Search::Pending(WaitKey::Fs { op: FsOp::Stat, path: path.clone() });
				},
				Poll::Ready(r) => {
					sc.live = Live::None;
					if r.is_ok_and(|st| st.kind == StatKind::File) {
						search.checking_exec = true;
					} else {
						search.idx += 1;
					}
				},
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn path_candidates_resolve_empty_and_relative_entries_against_cwd() {
		let c = candidates(b"/bin::rel", b"ls", b"/home/u", Platform::Linux, &[]);
		assert_eq!(c, vec![
			BString::from("/bin/ls"),
			BString::from("/home/u/ls"),
			BString::from("/home/u/rel/ls")
		]);
	}

	#[test]
	fn windows_path_search_tries_the_bare_name_then_pathext_spellings() {
		let exts = [".exe".to_owned(), ".cmd".to_owned()];
		let win = |path: &[u8], name: &[u8]| -> Vec<String> {
			candidates(path, name, br"C:\project", Platform::Windows, &exts)
				.into_iter()
				.map(|p| String::from_utf8_lossy(&p).into_owned())
				.collect()
		};
		assert_eq!(win(br"C:\Tools;;rel", b"tool"), [
			r"C:\Tools/tool",
			r"C:\Tools/tool.exe",
			r"C:\Tools/tool.cmd",
			r"C:\project/tool",
			r"C:\project/tool.exe",
			r"C:\project/tool.cmd",
			r"C:\project/rel/tool",
			r"C:\project/rel/tool.exe",
			r"C:\project/rel/tool.cmd",
		]);
		// A name already carrying a PATHEXT suffix is not re-suffixed; any other
		// dot is.
		assert_eq!(win(b"", b"tool.EXE"), [r"C:\project/tool.EXE"]);
		assert_eq!(win(b"", b"my.tool"), [
			r"C:\project/my.tool",
			r"C:\project/my.tool.exe",
			r"C:\project/my.tool.cmd"
		]);
	}

	#[test]
	fn windows_absolute_paths_are_not_prefixed_with_the_shell_cwd() {
		assert_eq!(
			absolute_on(br"C:\project", br"D:\Tools\app.exe", Platform::Windows),
			br"D:\Tools\app.exe".as_slice()
		);
		assert_eq!(
			absolute_on(br"C:\project", br"\\server\share\app.exe", Platform::Windows),
			br"\\server\share\app.exe".as_slice()
		);
	}

	#[test]
	fn shown_candidate_keeps_relative_entries_like_bash() {
		// bash 5.3: `PATH=:bin; type -p e f` prints `./e` and `bin/f`.
		assert_eq!(shown_candidate(b":bin", b"e", 0).unwrap(), "./e");
		assert_eq!(shown_candidate(b":bin", b"f", 1).unwrap(), "bin/f");
		assert_eq!(shown_candidate(b"/usr/bin/", b"ls", 0).unwrap(), "/usr/bin/ls");
		assert!(shown_candidate(b"/bin", b"ls", 1).is_none());
	}

	#[test]
	fn absolute_keeps_absolute_names() {
		assert_eq!(absolute(b"/x", b"/bin/sh"), "/bin/sh");
		assert_eq!(absolute(b"/x/", b"./a"), "/x/./a");
	}

	#[test]
	fn url_paths_are_absolute_and_join_under_a_url_cwd() {
		assert_eq!(url_root_len(b"skill://x/y"), Some(8));
		assert_eq!(url_root_len(b"git+ssh://h"), Some(10));
		// One-letter schemes are drive letters; `:/` alone is not a URL.
		assert_eq!(url_root_len(b"C://x"), None);
		assert_eq!(url_root_len(b"a:b"), None);
		assert_eq!(url_root_len(b"1x://y"), None);
		assert_eq!(url_root_len(b"/a/x://y"), None);
		assert_eq!(absolute(b"/home/u", b"virtual://x"), "virtual://x");
		assert_eq!(absolute(b"virtual://d", b"a.txt"), "virtual://d/a.txt");
		assert_eq!(absolute(b"virtual://", b"a"), "virtual://a");
		assert_eq!(absolute(b"virtual://d", b"/etc"), "/etc");
	}

	/// A cooked Windows console ends a typed line with `\r\n`; kept, the
	/// `\r` ended up in the command name (`ls^M: command not found`). A lone
	/// `\r` is the user's own byte and stays.
	#[test]
	fn console_line_ends_drop_the_cr_of_crlf_only() {
		assert_eq!(line_input(b"ls\r\n".to_vec(), true), "ls\n");
		assert_eq!(line_input(b"a\rb\r\n\r\n".to_vec(), true), "a\rb\n\n");
		assert_eq!(line_input(b"partial\r".to_vec(), true), "partial\r");
	}

	#[test]
	fn dev_fd_names() {
		assert_eq!(dev_fd(b"/dev/fd/3"), Some(3));
		assert_eq!(dev_fd(b"/dev/stderr"), Some(2));
		assert_eq!(dev_fd(b"/proc/self/fd/4"), Some(4));
		assert_eq!(dev_fd(b"/proc/thread-self/fd/5"), Some(5));
		assert_eq!(dev_fd(b"/dev/fdx"), None);
		assert_eq!(dev_fd(b"/proc/1/fd/3"), None);
	}
}
