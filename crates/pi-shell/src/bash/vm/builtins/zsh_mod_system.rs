//! zsh/system: `syserror`, `sysread`, `syswrite`, `sysopen`, `sysseek`,
//! `zsystem` (`flock`, `supports`), the math function `systell` and the
//! parameters `errnos` and `sysparams`.
//!
//! The descriptor work goes through the fd-level probes
//! ([`crate::bash::vm::fdprobe`]): a builtin computes its probes before
//! any side effect, and assigns its parameters only once every answer is
//! in.
//!
//! Ported from zsh 5.9 `Src/Modules/system.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group;
//! system.c Copyright (c) 1998 Peter Stephenson).

use std::io;

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::{Ops, zerr, zx},
	zsh_mod_util::zsh_errmsg,
};
use crate::bash::{
	diag::Diag,
	fd::FdFlags,
	fs::{OpenFlags, SeekFrom},
	ids::IntrinsicId,
	store::{Key, KeyBuf, MiscKey, Record},
	syntax::zsh::tok::metafy,
	vm::{
		expand::{Expander, Stop, X},
		fdprobe::{FdAnswer, FdProbe, FdSlot, release_lock},
		fsprobe::FsErr,
		probe::absolute,
		proc::{Probe, ProbeResult},
		state,
		zsh::{
			arith,
			math::{FuncArgs, FuncKind, MathFunc, Number},
			params,
		},
	},
};

/// `SYSREAD_BUFSIZE`.
const SYSREAD_BUFSIZE: usize = 8192;

/// Run zsh/system builtin `id`.
pub fn run(ctx: &mut Ctx<'_, '_>, id: IntrinsicId, ops: &Ops, args: &[BString]) -> R {
	use IntrinsicId as I;
	match id {
		I::Syserror => syserror(ctx, ops, args),
		I::Sysread => sysread(ctx, ops, args),
		I::Syswrite => syswrite(ctx, ops, args),
		I::Sysopen => sysopen(ctx, ops, args),
		I::Sysseek => sysseek(ctx, ops, args),
		_ => zsystem(ctx, args),
	}
}

// ---- helpers shared by the zsh/system, zsh/zselect and zsh/net modules --

/// The answer to fd-level probe `p`, or a request for it.
pub(super) fn fd_probe(ctx: &Ctx<'_, '_>, p: FdProbe) -> Result<FdAnswer, super::Need> {
	Ok(match ctx.probe(Probe::Fd(Box::new(p)))? {
		ProbeResult::Fd(a) => *a,
		_ => FdAnswer::Err(FsErr::of(&io::Error::from(io::ErrorKind::Unsupported))),
	})
}

/// zsh `setiparam`: `name` (may carry a subscript) gets integer `v`; a
/// new name becomes an integer parameter. `Err` inside is the zsh error.
pub(super) fn setiparam(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	v: i64,
) -> Result<Result<(), Diag>, super::Need> {
	let text = v.to_string();
	// zsh's `outputradix` is 0 outside arithmetic: a new parameter prints
	// as `typeset -i`, not `-i10`.
	zx(ctx, |ex| params::setnparam(ex, name, Number::Int(v), text.as_bytes(), 0).map(|_| ()))
}

/// zsh `setsparam`: `name` (may carry a subscript) gets scalar `v`.
pub(super) fn setsparam(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	v: &[u8],
) -> Result<Result<(), Diag>, super::Need> {
	zx(ctx, |ex| params::assignsparam(ex, name, v, 0))
}

/// zsh `zwarnnam(nam, "…%e", errno)` text of a probe error.
pub(super) fn errmsg(e: &FsErr) -> String {
	zsh_errmsg(&e.io())
}

/// Remember `e`'s `errno` for `syserror` without arguments.
pub(super) fn set_errno(ctx: &mut Ctx<'_, '_>, e: &FsErr) {
	let rec = Record::Misc(BString::from(e.errno.to_string()));
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshErrno), Some(rec));
}

/// zsh `atoi`: leading blanks, a sign, then digits (0 without any).
pub(super) fn atoi(s: &[u8]) -> i32 {
	let s = s.trim_start_with(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'));
	let (neg, digits) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let mut v: i32 = 0;
	for &c in digits.iter().take_while(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i32::from(c - b'0'));
	}
	if neg { v.wrapping_neg() } else { v }
}

/// zsh `zstrtol(s, &end, 10)`: the value and the unparsed rest.
pub(super) fn zstrtol(s: &[u8]) -> (i64, &[u8]) {
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
	let mut v: i64 = 0;
	while let Some(&c) = s.get(i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
		i += 1;
	}
	(if neg { v.wrapping_neg() } else { v }, &s[i..])
}

/// zsh `getposint`: a non-negative integer argument, or `None` after
/// `integer expected: TEXT`.
fn getposint(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> Option<i32> {
	let (v, rest) = zstrtol(s);
	// zsh casts to `int` first.
	let v = v as i32;
	if !rest.is_empty() || v < 0 {
		ctx.usage(format!("integer expected: {}", BStr::new(s)));
		return None;
	}
	Some(v)
}

/// zsh `isident`, or `not an identifier: NAME` under the builtin's name.
fn ident_ok(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> bool {
	if params::isident(name, params::wide_idents_ctx(ctx)) {
		return true;
	}
	ctx.usage(format!("not an identifier: {}", BStr::new(name)));
	false
}

/// `matheval` of builtin argument `text`.
fn matheval(ctx: &mut Ctx<'_, '_>, text: &[u8]) -> Result<Result<Number, Diag>, super::Need> {
	let t = metafy(text);
	zx(ctx, |ex| arith::matheval(ex, &t))
}

/// `mathevali` of builtin argument `text`.
pub(super) fn mathevali(
	ctx: &mut Ctx<'_, '_>,
	text: &[u8],
) -> Result<Result<i64, Diag>, super::Need> {
	let t = metafy(text);
	zx(ctx, |ex| arith::mathevali(ex, &t))
}

// ---- syserror -------------------------------------------------------------

/// zsh's `sys_errnames`: the `errno` names of this platform, by number
/// from 1 (zsh 5.9 `errnames.c` as built here).
#[cfg(target_os = "macos")]
pub const ERRNAMES: &[&str] = &[
	"EPERM",
	"ENOENT",
	"ESRCH",
	"EINTR",
	"EIO",
	"ENXIO",
	"E2BIG",
	"ENOEXEC",
	"EBADF",
	"ECHILD",
	"EDEADLK",
	"ENOMEM",
	"EACCES",
	"EFAULT",
	"ENOTBLK",
	"EBUSY",
	"EEXIST",
	"EXDEV",
	"ENODEV",
	"ENOTDIR",
	"EISDIR",
	"EINVAL",
	"ENFILE",
	"EMFILE",
	"ENOTTY",
	"ETXTBSY",
	"EFBIG",
	"ENOSPC",
	"ESPIPE",
	"EROFS",
	"EMLINK",
	"EPIPE",
	"EDOM",
	"ERANGE",
	"EAGAIN",
	"EINPROGRESS",
	"EALREADY",
	"ENOTSOCK",
	"EDESTADDRREQ",
	"EMSGSIZE",
	"EPROTOTYPE",
	"ENOPROTOOPT",
	"EPROTONOSUPPORT",
	"ESOCKTNOSUPPORT",
	"ENOTSUP",
	"EPFNOSUPPORT",
	"EAFNOSUPPORT",
	"EADDRINUSE",
	"EADDRNOTAVAIL",
	"ENETDOWN",
	"ENETUNREACH",
	"ENETRESET",
	"ECONNABORTED",
	"ECONNRESET",
	"ENOBUFS",
	"EISCONN",
	"ENOTCONN",
	"ESHUTDOWN",
	"ETOOMANYREFS",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ELOOP",
	"ENAMETOOLONG",
	"EHOSTDOWN",
	"EHOSTUNREACH",
	"ENOTEMPTY",
	"EPROCLIM",
	"EUSERS",
	"EDQUOT",
	"ESTALE",
	"EREMOTE",
	"EBADRPC",
	"ERPCMISMATCH",
	"EPROGUNAVAIL",
	"EPROGMISMATCH",
	"EPROCUNAVAIL",
	"ENOLCK",
	"ENOSYS",
	"EFTYPE",
	"EAUTH",
	"ENEEDAUTH",
	"EPWROFF",
	"EDEVERR",
	"EOVERFLOW",
	"EBADEXEC",
	"EBADARCH",
	"ESHLIBVERS",
	"EBADMACHO",
	"ECANCELED",
	"EIDRM",
	"ENOMSG",
	"EILSEQ",
	"ENOATTR",
	"EBADMSG",
	"EMULTIHOP",
	"ENODATA",
	"ENOLINK",
	"ENOSR",
	"ENOSTR",
	"EPROTO",
	"ETIME",
	"EOPNOTSUPP",
	"ENOPOLICY",
	"ENOTRECOVERABLE",
	"EOWNERDEAD",
	"EQFULL",
	"ENOTCAPABLE",
];

/// zsh's `sys_errnames`: the `errno` names of this platform, by number
/// from 1 (zsh 5.9 `errnames.c` over glibc's `errno.h`; unused numbers
/// read `E<n>`).
#[cfg(not(target_os = "macos"))]
pub const ERRNAMES: &[&str] = &[
	"EPERM",
	"ENOENT",
	"ESRCH",
	"EINTR",
	"EIO",
	"ENXIO",
	"E2BIG",
	"ENOEXEC",
	"EBADF",
	"ECHILD",
	"EAGAIN",
	"ENOMEM",
	"EACCES",
	"EFAULT",
	"ENOTBLK",
	"EBUSY",
	"EEXIST",
	"EXDEV",
	"ENODEV",
	"ENOTDIR",
	"EISDIR",
	"EINVAL",
	"ENFILE",
	"EMFILE",
	"ENOTTY",
	"ETXTBSY",
	"EFBIG",
	"ENOSPC",
	"ESPIPE",
	"EROFS",
	"EMLINK",
	"EPIPE",
	"EDOM",
	"ERANGE",
	"EDEADLK",
	"ENAMETOOLONG",
	"ENOLCK",
	"ENOSYS",
	"ENOTEMPTY",
	"ELOOP",
	"E41",
	"ENOMSG",
	"EIDRM",
	"ECHRNG",
	"EL2NSYNC",
	"EL3HLT",
	"EL3RST",
	"ELNRNG",
	"EUNATCH",
	"ENOCSI",
	"EL2HLT",
	"EBADE",
	"EBADR",
	"EXFULL",
	"ENOANO",
	"EBADRQC",
	"EBADSLT",
	"E58",
	"EBFONT",
	"ENOSTR",
	"ENODATA",
	"ETIME",
	"ENOSR",
	"ENONET",
	"ENOPKG",
	"EREMOTE",
	"ENOLINK",
	"EADV",
	"ESRMNT",
	"ECOMM",
	"EPROTO",
	"EMULTIHOP",
	"EDOTDOT",
	"EBADMSG",
	"EOVERFLOW",
	"ENOTUNIQ",
	"EBADFD",
	"EREMCHG",
	"ELIBACC",
	"ELIBBAD",
	"ELIBSCN",
	"ELIBMAX",
	"ELIBEXEC",
	"EILSEQ",
	"ERESTART",
	"ESTRPIPE",
	"EUSERS",
	"ENOTSOCK",
	"EDESTADDRREQ",
	"EMSGSIZE",
	"EPROTOTYPE",
	"ENOPROTOOPT",
	"EPROTONOSUPPORT",
	"ESOCKTNOSUPPORT",
	"EOPNOTSUPP",
	"EPFNOSUPPORT",
	"EAFNOSUPPORT",
	"EADDRINUSE",
	"EADDRNOTAVAIL",
	"ENETDOWN",
	"ENETUNREACH",
	"ENETRESET",
	"ECONNABORTED",
	"ECONNRESET",
	"ENOBUFS",
	"EISCONN",
	"ENOTCONN",
	"ESHUTDOWN",
	"ETOOMANYREFS",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"EHOSTDOWN",
	"EHOSTUNREACH",
	"EALREADY",
	"EINPROGRESS",
	"ESTALE",
	"EUCLEAN",
	"ENOTNAM",
	"ENAVAIL",
	"EISNAM",
	"EREMOTEIO",
	"EDQUOT",
	"ENOMEDIUM",
	"EMEDIUMTYPE",
	"ECANCELED",
	"ENOKEY",
	"EKEYEXPIRED",
	"EKEYREVOKED",
	"EKEYREJECTED",
	"EOWNERDEAD",
	"ENOTRECOVERABLE",
	"ERFKILL",
	"EHWPOISON",
];

/// `$errnos` (zsh `errnosgetfn`).
pub fn errnos() -> Vec<BString> {
	ERRNAMES.iter().map(|n| BString::from(*n)).collect()
}

/// The platform's `strerror(num)` text.
fn strerror_of(num: i32) -> String {
	// Off Unix `from_raw_os_error` reads the Win32 message table, whose
	// numbers are not errnos: the names above are Linux's, so are the texts.
	#[cfg(not(unix))]
	return crate::bash::vm::fsprobe::posix::text(num).into_owned();
	#[cfg(unix)]
	crate::bash::diag::strerror(&io::Error::from_raw_os_error(num)).into_owned()
}

/// zsh `bin_syserror`.
fn syserror(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let errvar = ops.arg(b'e').map(<[u8]>::to_vec);
	if let Some(v) = &errvar
		&& !ident_ok(ctx, v)
	{
		return done(1);
	}
	let pfx = ops.arg(b'p').map_or_default(<[u8]>::to_vec);
	let num = match args.first() {
		None => match ctx.record(Key::Misc(MiscKey::ZshErrno))? {
			Some(Record::Misc(v)) => atoi(&v),
			_ => 0,
		},
		Some(a) if !a.is_empty() && a.iter().all(u8::is_ascii_digit) => atoi(a),
		Some(a) => match ERRNAMES.iter().position(|n| n.as_bytes() == a.as_slice()) {
			Some(i) => i32::try_from(i + 1).unwrap_or(0),
			None => return done(2),
		},
	};
	let mut text = pfx;
	text.extend_from_slice(strerror_of(num).as_bytes());
	if let Some(var) = errvar {
		if let Err(d) = setsparam(ctx, &var, &text)? {
			return zerr(ctx, d);
		}
	} else {
		text.push(b'\n');
		ctx.out_fd(2, &text);
	}
	done(0)
}

// ---- sysread / syswrite -----------------------------------------------------

/// zsh `bin_sysread`: status 0 read (and written), 1 bad arguments, 2 read
/// error, 3 write error, 4 timeout, 5 end of file.
fn sysread(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let mut infd = 0;
	let mut outfd = None;
	let mut bufsize = SYSREAD_BUFSIZE;
	if let Some(a) = ops.arg(b'i').map(<[u8]>::to_vec) {
		let Some(fd) = getposint(ctx, &a) else {
			return done(1);
		};
		infd = fd;
	}
	if let Some(a) = ops.arg(b'o').map(<[u8]>::to_vec) {
		let Some(fd) = getposint(ctx, &a) else {
			return done(1);
		};
		outfd = Some(fd);
	}
	if let Some(a) = ops.arg(b's').map(<[u8]>::to_vec) {
		let Some(n) = getposint(ctx, &a) else {
			return done(1);
		};
		bufsize = n as usize;
	}
	let countvar = ops.arg(b'c').map(<[u8]>::to_vec);
	if let Some(v) = &countvar
		&& !ident_ok(ctx, v)
	{
		return done(1);
	}
	let outvar = args.first().map(|a| a.to_vec());
	if let Some(v) = &outvar
		&& !ident_ok(ctx, v)
	{
		return done(1);
	}
	let timeout_ns = if let Some(t) = ops.arg(b't').map(<[u8]>::to_vec) {
		let ms = match matheval(ctx, &t)? {
			Ok(Number::Float(d)) => (1000.0 * d) as i32,
			Ok(Number::Int(l)) => (l as i32).wrapping_mul(1000),
			Err(d) => return zerr(ctx, d),
		};
		// `poll` waits without end for a negative timeout.
		u64::try_from(ms).ok().map(|ms| ms * 1_000_000)
	} else {
		None
	};
	let read = FdProbe::ReadOnce { fd: infd, max: bufsize, timeout_ns };
	let data = match fd_probe(ctx, read)? {
		FdAnswer::Read { timed_out: true, .. } => return done(4),
		FdAnswer::Read { data, .. } => data,
		FdAnswer::Err(e) => {
			set_errno(ctx, &e);
			if let Some(c) = &countvar
				&& let Err(d) = setiparam(ctx, c, -1)?
			{
				return zerr(ctx, d);
			}
			return done(2);
		},
		_ => return done(2),
	};
	let count = data.len() as i64;
	if let Some(outfd) = outfd {
		if data.is_empty() {
			if let Some(c) = &countvar
				&& let Err(d) = setiparam(ctx, c, 0)?
			{
				return zerr(ctx, d);
			}
			return done(5);
		}
		let wrote = fd_probe(ctx, FdProbe::Write { fd: outfd, data: data.clone() })?;
		let (n, err) = match wrote {
			FdAnswer::Wrote { n, err } => (n, err),
			FdAnswer::Err(e) => (0, Some(e)),
			_ => (0, None),
		};
		let Some(e) = err else {
			if let Some(c) = &countvar
				&& let Err(d) = setiparam(ctx, c, count)?
			{
				return zerr(ctx, d);
			}
			return done(0);
		};
		// zsh: what was not written goes to the variable, its length to
		// the count.
		set_errno(ctx, &e);
		let rest = &data[n.min(data.len())..];
		if let Some(v) = &outvar
			&& let Err(d) = setsparam(ctx, v, rest)?
		{
			return zerr(ctx, d);
		}
		if let Some(c) = &countvar
			&& let Err(d) = setiparam(ctx, c, rest.len() as i64)?
		{
			return zerr(ctx, d);
		}
		return done(3);
	}
	if let Some(c) = &countvar
		&& let Err(d) = setiparam(ctx, c, count)?
	{
		return zerr(ctx, d);
	}
	let outvar = outvar.unwrap_or_else(|| b"REPLY".to_vec());
	// Even when nothing was read.
	if let Err(d) = setsparam(ctx, &outvar, &data)? {
		return zerr(ctx, d);
	}
	done(if count == 0 { 5 } else { 0 })
}

/// zsh `bin_syswrite`: status 0 written, 1 bad arguments, 2 write error.
fn syswrite(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let outfd = if let Some(a) = ops.arg(b'o').map(<[u8]>::to_vec) {
		let Some(fd) = getposint(ctx, &a) else {
			return done(1);
		};
		fd
	} else {
		1
	};
	let countvar = ops.arg(b'c').map(<[u8]>::to_vec);
	if let Some(v) = &countvar
		&& !ident_ok(ctx, v)
	{
		return done(1);
	}
	let data = args.first().cloned().unwrap_or_default();
	let (n, err) = match fd_probe(ctx, FdProbe::Write { fd: outfd, data })? {
		FdAnswer::Wrote { n, err } => (n, err),
		FdAnswer::Err(e) => (0, Some(e)),
		_ => (0, None),
	};
	if let Some(e) = &err {
		set_errno(ctx, e);
	}
	if let Some(c) = &countvar
		&& let Err(d) = setiparam(ctx, c, n as i64)?
	{
		return zerr(ctx, d);
	}
	done(if err.is_some() { 2 } else { 0 })
}

// ---- sysopen / sysseek / systell ------------------------------------------

/// zsh `openopts[]`: the `-o` names and their flags, `None` for
/// `cloexec` (a descriptor flag).
const OPENOPTS: &[(&str, Option<OpenFlags>)] = &[
	("cloexec", None),
	("nofollow", Some(OpenFlags::NOFOLLOW)),
	("sync", Some(OpenFlags::SYNC)),
	// `O_NOATIME` exists on Linux only ([`open_opt`]).
	("noatime", Some(OpenFlags::NOATIME)),
	("nonblock", Some(OpenFlags::NONBLOCK)),
	("excl", Some(OpenFlags::EXCL.with(OpenFlags::CREATE))),
	("creat", Some(OpenFlags::CREATE)),
	("create", Some(OpenFlags::CREATE)),
	("truncate", Some(OpenFlags::TRUNC)),
	("trunc", Some(OpenFlags::TRUNC)),
];

/// zsh `bin_sysopen`.
fn sysopen(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let read = ops.isset(b'r');
	let write = ops.isset(b'w');
	let append = ops.isset(b'a');
	let mut flags = if append || write {
		if read {
			OpenFlags::READ.with(OpenFlags::WRITE)
		} else {
			OpenFlags::WRITE
		}
	} else {
		OpenFlags::READ
	};
	if append {
		flags = flags.with(OpenFlags::APPEND);
	}
	let Some(fdvar) = ops.arg(b'u').map(<[u8]>::to_vec) else {
		ctx.usage("file descriptor not specified");
		return done(1);
	};
	// A single digit is the fd itself, anything else a parameter name.
	let explicit = match fdvar.as_slice() {
		[d] if d.is_ascii_digit() => Some(i32::from(d - b'0')),
		_ => {
			if !ident_ok(ctx, &fdvar) {
				return done(1);
			}
			None
		},
	};
	let mut fd_flags = FdFlags::NONE;
	if let Some(list) = ops.arg(b'o').map(<[u8]>::to_vec) {
		let mut rest: Option<&[u8]> = Some(&list);
		while let Some(mut opt) = rest {
			if opt.len() >= 2 && opt[..2].eq_ignore_ascii_case(b"O_") {
				opt = &opt[2..];
			}
			let (name, next) = match opt.iter().position(|&c| c == b',') {
				Some(i) => (&opt[..i], Some(&opt[i + 1..])),
				None => (opt, None),
			};
			let Some((_, f)) = OPENOPTS.iter().find(|(n, _)| {
				n.as_bytes().eq_ignore_ascii_case(name)
					&& (*n != "noatime" || cfg!(any(target_os = "linux", target_os = "android")))
			}) else {
				ctx.usage(format!("unsupported option: {}\n", BStr::new(name)));
				return done(1);
			};
			match f {
				Some(f) => flags = flags.with(*f),
				None => fd_flags = fd_flags.with(FdFlags::CLOEXEC),
			}
			rest = next;
		}
	}
	let perms = if let Some(m) = ops.arg(b'm').map(<[u8]>::to_vec) {
		let octal = m.iter().take_while(|c| (b'0'..=b'7').contains(c)).count();
		if octal != m.len() || octal < 3 {
			ctx.usage(format!("invalid mode {}", BStr::new(&m)));
			return done(1);
		}
		m.iter()
			.fold(0u32, |acc, &c| acc.wrapping_mul(8).wrapping_add(u32::from(c - b'0')))
	} else {
		0o666
	};
	let name = args.first().cloned().unwrap_or_default();
	let path = absolute(&ctx.vp.cwd, &name);
	let slot = explicit.map_or(FdSlot::Free(10), FdSlot::At);
	let open = FdProbe::Open { path, flags, mode: perms, slot, fd_flags };
	let fd = match fd_probe(ctx, open)? {
		FdAnswer::Opened { fd, .. } => fd,
		FdAnswer::Err(e) => {
			set_errno(ctx, &e);
			ctx.usage(format!("can't open file {}: {}", name.as_bstr(), errmsg(&e)));
			return done(1);
		},
		_ => {
			ctx.usage(format!("can't open file {}", name.as_bstr()));
			return done(1);
		},
	};
	if explicit.is_none()
		&& let Err(d) = setiparam(ctx, &fdvar, i64::from(fd))?
	{
		// zsh closes the fd when the parameter cannot take it.
		ctx.vp.fds.set(fd, None);
		return zerr(ctx, d);
	}
	done(0)
}

/// `sysseek -w`: where the offset counts from.
#[derive(Clone, Copy)]
enum Whence {
	Set,
	Cur,
	End,
}

/// zsh `bin_sysseek`: status 0, 1 bad arguments, 2 seek error.
fn sysseek(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let fd = if let Some(a) = ops.arg(b'u').map(<[u8]>::to_vec) {
		let Some(n) = getposint(ctx, &a) else {
			return done(1);
		};
		n
	} else {
		0
	};
	let whence = if let Some(w) = ops.arg(b'w').map(<[u8]>::to_vec) {
		if w.eq_ignore_ascii_case(b"current") || w == b"1" {
			Whence::Cur
		} else if w.eq_ignore_ascii_case(b"end") || w == b"2" {
			Whence::End
		} else if w.eq_ignore_ascii_case(b"start") || w == b"0" {
			Whence::Set
		} else {
			ctx.usage(format!("unknown argument to -w: {}", BStr::new(&w)));
			return done(1);
		}
	} else {
		Whence::Set
	};
	let text = args.first().cloned().unwrap_or_default();
	let pos = match mathevali(ctx, &text)? {
		Ok(p) => p,
		Err(d) => return zerr(ctx, d),
	};
	let target = match whence {
		Whence::Set => u64::try_from(pos).map(SeekFrom::Start).ok(),
		Whence::Cur => Some(SeekFrom::Current(pos)),
		Whence::End => Some(SeekFrom::End(pos)),
	};
	let res = match (ctx.vp.fds.get(fd).filter(|h| h.is_open()), target) {
		(None, _) => Err(io::Error::other(crate::bash::fd::BadFd)),
		(Some(_), None) => Err(io::Error::from(io::ErrorKind::InvalidInput)),
		(Some(h), Some(t)) => h.seek(t),
	};
	match res {
		Ok(_) => done(0),
		Err(e) => {
			set_errno(ctx, &FsErr::of(&e));
			done(2)
		},
	}
}

/// zsh/system's math functions (`mftab`): `systell(fd)`.
pub fn math_def(name: &[u8]) -> Option<MathFunc> {
	(name == b"systell").then_some(MathFunc {
		kind:     FuncKind::Numeric,
		min_args: 1,
		max_args: Some(1),
	})
}

/// zsh `math_systell`: the offset of fd (`lseek(fd, 0, SEEK_CUR)`), -1
/// when it has none.
///
/// # Errors
/// `file descriptor out of range` for a negative fd.
pub fn math_call(ex: &Expander<'_, '_>, name: &[u8], args: FuncArgs<'_>) -> X<Number> {
	let fd = match args {
		FuncArgs::Numbers([Number::Int(l), ..]) if name == b"systell" => *l as i32,
		FuncArgs::Numbers([Number::Float(d), ..]) if name == b"systell" => *d as i32,
		_ => {
			return Err(Stop::Fail(Diag::Unsupported {
				what: format!("math function `{}'", name.as_bstr()).into(),
			}));
		},
	};
	if fd < 0 {
		return Err(Stop::Fail(Diag::Usage { msg: "file descriptor out of range".into() }));
	}
	let pos = ex
		.vp
		.fds
		.get(fd)
		.filter(|h| h.is_open())
		.map_or(-1, |h| h.seek(SeekFrom::Current(0)).map_or(-1, |p| p as i64));
	Ok(Number::Int(pos))
}

// ---- zsystem ----------------------------------------------------------------

/// zsh `bin_zsystem`.
fn zsystem(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	match args.first().map(|a| a.as_slice()) {
		Some(b"flock") => flock(ctx, &args[1..]),
		Some(b"supports") => supports(ctx, &args[1..]),
		other => {
			ctx.usage(format!("unknown subcommand: {}", BStr::new(other.unwrap_or_default())));
			done(1)
		},
	}
}

/// zsh `bin_zsystem_supports`.
fn supports(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	match args {
		[] => {
			ctx.usage("supports: not enough arguments");
			done(255)
		},
		[a] => done(i32::from(!matches!(a.as_slice(), b"supports" | b"flock"))),
		_ => {
			ctx.usage("supports: too many arguments");
			done(255)
		},
	}
}

/// Retry interval of a `zsystem flock` without a timeout (zsh waits in
/// `F_SETLKW`; the engine may not block, so it retries this often).
const FLOCK_WAIT_RETRY_NS: u64 = 10_000_000;

/// zsh `bin_zsystem_flock`.
fn flock(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut cloexec = true;
	let mut unlock = false;
	let mut readlock = false;
	let mut timeout: f64 = -1.0;
	let mut interval_us: i64 = 1_000_000;
	let mut fdvar: Option<Vec<u8>> = None;
	let mut i = 0;
	while let Some(word) = args.get(i).filter(|a| a.first() == Some(&b'-')) {
		let word = word.clone();
		i += 1;
		let opts: &[u8] = &word.as_slice()[1..];
		if opts.is_empty() || opts == b"-" {
			break;
		}
		let mut j = 0;
		while let Some(&opt) = opts.get(j) {
			match opt {
				b'e' => cloexec = false,
				b'f' => {
					let var = if j + 1 < opts.len() {
						let v = opts[j + 1..].to_vec();
						j = opts.len() - 1;
						Some(v)
					} else if let Some(next) = args.get(i) {
						i += 1;
						Some(next.to_vec())
					} else {
						None
					};
					match var {
						Some(v) if params::isident(&v, params::wide_idents_ctx(ctx)) => fdvar = Some(v),
						_ => {
							ctx.usage("flock: option f requires a variable name");
							return done(1);
						},
					}
				},
				b'r' => readlock = true,
				b't' | b'i' => {
					let arg = if j + 1 < opts.len() {
						let v = opts[j + 1..].to_vec();
						j = opts.len() - 1;
						v
					} else if let Some(next) = args.get(i) {
						i += 1;
						next.to_vec()
					} else {
						ctx.usage(if opt == b't' {
							"flock: option t requires a numeric timeout"
						} else {
							"flock: option i requires a numeric retry interval"
						});
						return done(1);
					};
					let n = match matheval(ctx, &arg)? {
						Ok(n) => n,
						Err(d) => return zerr(ctx, d),
					};
					let v = match n {
						Number::Float(d) => d,
						Number::Int(l) => l as f64,
					};
					if opt == b't' {
						if v > 1_073_741_823.0 {
							ctx.usage(format!("flock: invalid timeout value: '{}'", BStr::new(&arg)));
							return done(1);
						}
						timeout = v;
					} else {
						let us = (v * 1e6).ceil();
						if !(1.0..=0.999 * i64::MAX as f64).contains(&us) {
							ctx.usage(format!("flock: invalid interval value: '{}'", BStr::new(&arg)));
							return done(1);
						}
						interval_us = us as i64;
					}
				},
				b'u' => unlock = true,
				_ => {
					ctx.usage(format!("flock: unknown option: {}", char::from(opt)));
					return done(1);
				},
			}
			j += 1;
		}
	}
	let rest = &args[i.min(args.len())..];
	let file = match rest {
		[] => {
			ctx.usage("flock: not enough arguments");
			return done(1);
		},
		[f] => f.clone(),
		_ => {
			ctx.usage("flock: too many arguments");
			return done(1);
		},
	};
	if unlock {
		let fd = match mathevali(ctx, &file)? {
			Ok(v) => v as i32,
			Err(d) => return zerr(ctx, d),
		};
		// zsh `zcloselockfd`: only a lock's fd. Closing it releases the
		// lock in zsh's process; here other vprocs (a background job) may
		// still hold the descriptor, so the lock is released explicitly.
		let lock = ctx
			.vp
			.fds
			.get(fd)
			.filter(|h| h.is_open() && h.flags().contains(FdFlags::FLOCK))
			.cloned();
		if let Some(r) = lock {
			release_lock(ctx.cx.host.fs(), &r);
			ctx.vp.fds.set(fd, None);
			return done(0);
		}
		ctx.usage(format!("flock: file descriptor {fd} not in use for locking"));
		return done(1);
	}
	let timeout_ns = if timeout > 0.0 {
		let secs = timeout.trunc();
		Some(
			(secs as u64)
				.saturating_mul(1_000_000_000)
				.saturating_add(((timeout - secs) * 1e9).ceil() as u64),
		)
	} else if timeout == 0.0 {
		Some(0)
	} else {
		None
	};
	let interval_ns = if timeout > 0.0 {
		u64::try_from(interval_us).unwrap_or(1).saturating_mul(1000)
	} else {
		FLOCK_WAIT_RETRY_NS
	};
	let mut fd_flags = FdFlags::FLOCK;
	if cloexec {
		fd_flags = fd_flags.with(FdFlags::CLOEXEC);
	}
	let probe = FdProbe::Lock {
		path: absolute(&ctx.vp.cwd, &file),
		write: !readlock,
		timeout_ns,
		interval_ns,
		fd_flags,
	};
	match fd_probe(ctx, probe)? {
		FdAnswer::Locked(Some(fd)) => {
			if let Some(v) = &fdvar
				&& let Err(d) = setiparam(ctx, v, i64::from(fd))?
			{
				return zerr(ctx, d);
			}
			done(0)
		},
		FdAnswer::Locked(None) => done(2),
		FdAnswer::LockOpen(e) => {
			set_errno(ctx, &e);
			ctx.usage(format!("failed to open {} for writing: {}", file.as_bstr(), errmsg(&e)));
			done(1)
		},
		FdAnswer::Err(e) => {
			set_errno(ctx, &e);
			ctx.usage(format!("failed to lock file {}: {}", file.as_bstr(), errmsg(&e)));
			done(1)
		},
		_ => done(1),
	}
}

// ---- parameters -------------------------------------------------------------

/// `$sysparams` (zsh `scanpmsysparams`): `pid`, `ppid` and
/// `procsubstpid` of the (virtual) process running.
///
/// # Errors
/// [`Stop::Store`] when the state cannot be read.
pub fn sysparams(ex: &mut Expander<'_, '_>) -> X<Vec<(BString, BString)>> {
	let shell_pid = match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ShellPid))? {
		Some(Record::Misc(v)) => v
			.to_str()
			.ok()
			.and_then(|s| s.parse().ok())
			.unwrap_or(ex.k.shell_pid),
		_ => ex.k.shell_pid,
	};
	// The root shell is the process; a subshell is a vproc of its own
	// (its id, as `$BASHPID` shows it), its parent the vproc that made it.
	let (pid, ppid) = match ex.vp.parent {
		None => (shell_pid, ex.cx.host.ppid()),
		Some(parent) => (ex.vp.vpid.0, parent.0),
	};
	let procsubst = match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshProcsubstPid))? {
		Some(Record::Misc(v)) => v.clone(),
		_ => BString::from("0"),
	};
	Ok(vec![
		(BString::from("pid"), BString::from(pid.to_string())),
		(BString::from("ppid"), BString::from(ppid.to_string())),
		(BString::from("procsubstpid"), procsubst),
	])
}
