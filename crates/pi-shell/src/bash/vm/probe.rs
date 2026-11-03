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
	glob::Walk,
	proc::{Live, PathSearch, Probe, ProbeResult, Scratch, Vproc},
};
use crate::bash::{
	diag,
	event::WaitKey,
	fs::{Access, FileKind, FsOp, FsPoll, OpenFlags, Stat, StatKind},
	host::Deadline,
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
fn fd_stat(vp: &Vproc, fd: i32) -> Option<Stat> {
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
	let io = sc.io();
	if io.probing.as_ref() != Some(probe) {
		io.probing = Some(probe.clone());
		io.search = None;
		io.walk = None;
		io.input.clear();
		sc.live = Live::None;
	}
	let mut tcx = Context::from_waker(&k.waker);
	let res = match probe {
		Probe::Stat { path, follow } => {
			if let Some(fd) = dev_fd(path) {
				return Ok(finish(sc, ProbeResult::Stat(fd_stat(vp, fd))));
			}
			let polled = match &mut sc.live {
				Live::Stat(fut) => fut.poll(&mut tcx),
				_ => match cx.host.fs().stat(BStr::new(path), *follow) {
					FsPoll::Ready(polled) => Poll::Ready(polled),
					FsPoll::Pending(mut fut) => {
						let polled = fut.poll(&mut tcx);
						if polled.is_pending() {
							sc.live = Live::Stat(fut);
						}
						polled
					},
				},
			};
			match polled {
				Poll::Ready(polled) => ProbeResult::Stat(polled.ok()),
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
				io.search = Some(PathSearch {
					cands:         candidates(path, name, &vp.cwd),
					idx:           0,
					checking_exec: false,
					nonexec:       None,
				});
			}
			match path_search(&mut tcx, cx, sc) {
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
		Probe::Ready { fd } => {
			// `read -t 0`: is input available, without consuming it.
			let handle = vp.fds.handle(*fd);
			ProbeResult::Ok(handle.is_open() && handle.poll_read(&mut tcx, &mut []).is_ready())
		},
		Probe::Input { fd, delim, lines, nchars, timeout_ns, .. } => {
			let handle = vp.fds.handle(*fd);
			let seekable = handle.kind() == Some(FileKind::Regular);
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
						data:      BString::from(std::mem::take(input)),
						eof:       false,
						timed_out: false,
					};
				}
				let mut buf = [0u8; 4096];
				let want = if seekable { buf.len() } else { 1 };
				let want = nchars.map_or(want, |n| want.min(n - input.len()));
				match handle.poll_read(&mut tcx, &mut buf[..want]) {
					Poll::Ready(Ok(0) | Err(_)) => {
						break ProbeResult::Input {
							data:      BString::from(std::mem::take(input)),
							eof:       true,
							timed_out: false,
						};
					},
					Poll::Ready(Ok(n)) => {
						let got = &buf[..n];
						// On seekable fds read ahead, then give back what
						// follows the last delimiter wanted.
						let mut cut = None;
						if let Some(d) = *delim {
							for (i, _) in got.iter().enumerate().filter(|&(_, &c)| c == d) {
								seen += 1;
								if seen == lines {
									cut = Some(i + 1);
									break;
								}
							}
						}
						match cut {
							Some(c) if c < n => {
								input.extend_from_slice(&got[..c]);
								let _ =
									handle.seek(crate::bash::fs::SeekFrom::Current(c as i64 - n as i64));
							},
							_ => input.extend_from_slice(got),
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

fn finish(sc: &mut Scratch, r: ProbeResult) -> ProbeResult {
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
		crate::bash::ids::Platform::Linux | crate::bash::ids::Platform::Windows => "/bin:/usr/bin",
	}
}

/// `dir/name` for every `$PATH` entry (empty entries mean the cwd).
pub fn candidates(path: &[u8], name: &[u8], cwd: &[u8]) -> Vec<BString> {
	path
		.split(|&c| c == b':')
		.map(|dir| {
			let mut p = if dir.is_empty() {
				BString::from(cwd)
			} else {
				absolute(cwd, dir)
			};
			if !p.ends_with(b"/") {
				p.push(b'/');
			}
			p.extend_from_slice(name);
			p
		})
		.collect()
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
	if name.first() == Some(&b'/') || url_root_len(name).is_some() {
		return name.into();
	}
	let mut p = BString::from(cwd);
	if !p.ends_with(b"/") {
		p.push(b'/');
	}
	p.extend_from_slice(name);
	p
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
		let c = candidates(b"/bin::rel", b"ls", b"/home/u");
		assert_eq!(c, vec![
			BString::from("/bin/ls"),
			BString::from("/home/u/ls"),
			BString::from("/home/u/rel/ls")
		]);
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
