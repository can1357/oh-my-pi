//! zsh/net/socket: `zsocket`, Unix-domain stream sockets (connect,
//! listen, accept) on shell fds, over the host's socket seam
//! ([`crate::bash::Sockets`]); hosts without one report every operation as
//! not supported.
//!
//! Ported from zsh 5.9 `Src/Modules/socket.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group;
//! socket.c Copyright (c) 2002 Peter Stephenson).

use std::io;

use bstr::{BStr, BString};

use super::{
	Ctx, R, done,
	zsh_args::{Ops, zerr},
	zsh_mod_system::{atoi, errmsg, fd_probe, set_errno, setiparam},
};
use crate::bash::{
	fd::{FdOrigin, FdRef},
	socket::{ListenStage, SockAddr},
	vm::{
		fdprobe::{FdAnswer, FdProbe, FdSlot},
		fsprobe::FsErr,
		probe::absolute,
	},
};

/// `sizeof(sun_path) - 1`: the bytes of a path zsh's `strncpy` keeps.
#[cfg(target_os = "macos")]
const SUN_PATH_MAX: usize = 103;
/// `sizeof(sun_path) - 1`: the bytes of a path zsh's `strncpy` keeps.
#[cfg(not(target_os = "macos"))]
const SUN_PATH_MAX: usize = 107;

/// `soun.sun_path` as zsh fills it from `path`.
fn sun_path(path: &[u8]) -> &[u8] {
	let n = path
		.iter()
		.position(|&c| c == 0)
		.unwrap_or(path.len())
		.min(SUN_PATH_MAX);
	&path[..n]
}

/// zsh `bin_zsocket`.
pub fn zsocket(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let verbose = ops.isset(b'v');
	let test = ops.isset(b't');
	let mut targetfd = 0;
	if let Some(d) = ops.arg(b'd').map(<[u8]>::to_vec) {
		targetfd = atoi(&d);
		if targetfd == 0 {
			ctx.usage(format!("{} is an invalid argument to -d", BStr::new(&d)));
			return done(1);
		}
		if ctx.vp.fds.get(targetfd).is_some_and(FdRef::is_open) {
			ctx.usage(format!("file descriptor {targetfd} is in use by the shell"));
			return done(1);
		}
	}
	if ops.isset(b'l') {
		let Some(local) = args.first() else {
			ctx.usage("-l requires an argument");
			return done(1);
		};
		let shown = BString::from(sun_path(local));
		let addr = SockAddr::Unix(absolute(&ctx.vp.cwd, &shown));
		let listened = match ctx.cx.host.sockets() {
			Some(s) => s.listen(&addr, 1),
			None => Err(crate::bash::socket::ListenError {
				stage: ListenStage::Socket,
				error: io::ErrorKind::Unsupported.into(),
			}),
		};
		let file = match listened {
			Ok(f) => f,
			Err(e) => {
				let fe = FsErr::of(&e.error);
				set_errno(ctx, &fe);
				let msg = match e.stage {
					ListenStage::Socket => format!("socket error: {} ", errmsg(&fe)),
					ListenStage::Bind => format!("could not bind to {}: {}", shown, errmsg(&fe)),
					ListenStage::Listen => format!("could not listen on socket: {}", errmsg(&fe)),
				};
				ctx.usage(msg);
				return done(1);
			},
		};
		let slot = if targetfd != 0 {
			FdSlot::At(targetfd)
		} else {
			// zsh `movefd`: nobody reads a listener.
			FdSlot::Free(10)
		};
		let fd = install(ctx, slot, file);
		if let Err(d) = setiparam(ctx, b"REPLY", i64::from(fd))? {
			return zerr(ctx, d);
		}
		if verbose {
			ctx.out(format!("{shown} listener is on fd {fd}\n").as_bytes());
		}
		return done(0);
	}
	if ops.isset(b'a') {
		let Some(arg) = args.first() else {
			ctx.usage("-a requires an argument");
			return done(1);
		};
		let lfd = atoi(arg);
		if lfd == 0 {
			ctx.usage("invalid numerical argument");
			return done(1);
		}
		if test && !pending_connection(ctx, lfd)? {
			return done(1);
		}
		let slot = if targetfd != 0 {
			FdSlot::At(targetfd)
		} else {
			FdSlot::Free(0)
		};
		let (fd, peer) = match fd_probe(ctx, FdProbe::Accept { fd: lfd, slot })? {
			FdAnswer::Opened { fd, peer } => (fd, peer),
			FdAnswer::Err(e) => {
				set_errno(ctx, &e);
				ctx.usage(format!("could not accept connection: {}", errmsg(&e)));
				return done(1);
			},
			_ => return done(1),
		};
		if let Err(d) = setiparam(ctx, b"REPLY", i64::from(fd))? {
			return zerr(ctx, d);
		}
		if verbose {
			let from = match peer {
				Some(SockAddr::Unix(p)) => p,
				_ => BString::default(),
			};
			ctx.out(format!("new connection from {from} is on fd {fd}\n").as_bytes());
		}
		return done(0);
	}
	let Some(path) = args.first() else {
		ctx.usage("zsocket requires an argument");
		return done(1);
	};
	let shown = BString::from(sun_path(path));
	let slot = if targetfd != 0 {
		FdSlot::At(targetfd)
	} else {
		FdSlot::Free(0)
	};
	let addr = SockAddr::Unix(absolute(&ctx.vp.cwd, &shown));
	let fd = match fd_probe(ctx, FdProbe::Connect { addr, slot })? {
		FdAnswer::Opened { fd, .. } => fd,
		FdAnswer::Err(e) => {
			set_errno(ctx, &e);
			ctx.usage(format!("connection failed: {}", errmsg(&e)));
			return done(1);
		},
		_ => return done(1),
	};
	if let Err(d) = setiparam(ctx, b"REPLY", i64::from(fd))? {
		return zerr(ctx, d);
	}
	if verbose {
		ctx.out(format!("{shown} is now on fd {fd}\n").as_bytes());
	}
	done(0)
}

/// zsh `-t`'s `poll(lfd, POLLIN, 0)`: whether a connection waits on the
/// listener at `lfd` (a bad fd counts as ready: the accept then reports
/// it, as zsh's `POLLNVAL` does).
pub(super) fn pending_connection(ctx: &Ctx<'_, '_>, lfd: i32) -> Result<bool, super::Need> {
	let sets = [vec![lfd], Vec::new(), Vec::new()];
	Ok(match fd_probe(ctx, FdProbe::Select { sets, timeout_ns: Some(0) })? {
		FdAnswer::Ready(ready) => !ready[0].is_empty(),
		_ => true,
	})
}

/// Put the socket `file` into `slot` of the builtin's vproc: its fd.
pub(super) fn install(
	ctx: &mut Ctx<'_, '_>,
	slot: FdSlot,
	file: Box<dyn crate::bash::fs::File>,
) -> i32 {
	let fd = match slot {
		FdSlot::At(fd) => fd,
		FdSlot::Free(from) => (from.max(0)..i32::MAX)
			.find(|&fd| ctx.vp.fds.get(fd).is_none_or(|h| !h.is_open()))
			.unwrap_or(from),
	};
	ctx.vp.fds.set(fd, Some(FdRef::open(file, FdOrigin::Host)));
	fd
}
