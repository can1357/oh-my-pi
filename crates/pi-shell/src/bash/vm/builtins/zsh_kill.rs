//! zsh `kill`: a port of zsh 5.9 `jobs.c` `bin_kill` (signal operand
//! forms, `kill -l`, the per-operand status count and messages) over the
//! engine's signalling of jobs, virtual processes and OS pids
//! ([`super::kill::target`]).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	Ctx, R, done,
	kill::{Send, TargetError, target},
	zsh_args::isset,
};
use crate::bash::{
	ControlHandle, Platform, SigTarget, Signal, diag, vm::proc::JobState, zshopt::ZshOpt,
};

/// zsh `SIGCOUNT`: the signals `kill -l` lists (`$signals[2,32]`).
const SIGCOUNT: i64 = 31;

/// zsh `sigs[n]` for `1 <= n <= SIGCOUNT` (as `$signals`).
fn sig_name(n: i64, platform: Platform) -> String {
	u8::try_from(n)
		.ok()
		.and_then(|n| Signal::from_number(n, platform))
		.map_or_else(|| format!("SIG{n}"), |s| s.to_string())
}

/// The signal number `name` (without `SIG`) names in `sigs`, then zsh's
/// `alt_sigs` (`CLD` and `IO` where they alias `CHLD` and `POLL`; `ERR`
/// names zsh's `SIGZERR`, past `SIGCOUNT`, so never a signal here).
fn sig_number(name: &[u8], platform: Platform, nocase: bool) -> Option<i64> {
	let eq = |a: &[u8], b: &[u8]| {
		if nocase {
			a.eq_ignore_ascii_case(b)
		} else {
			a == b
		}
	};
	if let Some(n) = (1..=SIGCOUNT).find(|&n| eq(sig_name(n, platform).as_bytes(), name)) {
		return Some(n);
	}
	if platform == Platform::Linux {
		for (alt, sig) in [(&b"CLD"[..], Signal::Chld), (b"IO", Signal::Io)] {
			if eq(alt, name) {
				return Some(i64::from(sig.number(platform)));
			}
		}
	}
	None
}

/// zsh `zstrtol(s, &end, 10)`: blanks, a sign, decimal digits; the value
/// and the length consumed (0 when no digit followed the sign).
fn zstrtol(s: &[u8]) -> (i64, usize) {
	let mut i = s.iter().take_while(|&&c| c == b' ' || c == b'\t').count();
	let neg = s.get(i) == Some(&b'-');
	if neg || s.get(i) == Some(&b'+') {
		i += 1;
	}
	let mut v: u64 = 0;
	while let Some(&c) = s.get(i).filter(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(u64::from(c - b'0'));
		i += 1;
	}
	let v = v.cast_signed();
	(if neg { v.wrapping_neg() } else { v }, i)
}

/// zsh `isanum`: nonempty, only `-` and digits.
fn isanum(s: &[u8]) -> bool {
	!s.is_empty() && s.iter().all(|&c| c == b'-' || c.is_ascii_digit())
}

/// C `atoi` (`strtol` saturating to `long`, then truncated to `int`).
fn atoi(s: &[u8]) -> i32 {
	let neg = s.first() == Some(&b'-');
	let digits = s
		.get(usize::from(neg || s.first() == Some(&b'+'))..)
		.unwrap_or_default();
	let mut v: i64 = 0;
	for &c in digits.iter().take_while(|c| c.is_ascii_digit()) {
		v = v.saturating_mul(10).saturating_add(i64::from(c - b'0'));
	}
	let v = if neg { v.saturating_neg() } else { v };
	v as i32
}

/// zsh's `%e`: the error text with a lower-case first letter.
fn errtext(e: &std::io::Error) -> String {
	let mut m = diag::strerror(e).to_string();
	if let Some(c) = m.get_mut(..1) {
		c.make_ascii_lowercase();
	}
	m
}

/// `kill -l sig…`: names for numbers (wait statuses map to their signal),
/// numbers for names.
fn list(ctx: &mut Ctx<'_, '_>, args: &[BString], platform: Platform) -> R {
	let mut status = 0;
	for arg in args {
		let (v, end) = zstrtol(arg);
		let rest = &arg[end..];
		if end == 0 || !arg[..end].iter().any(u8::is_ascii_digit) {
			let name = rest.strip_prefix(b"SIG").unwrap_or(rest);
			if let Some(n) = sig_number(name, platform, true) {
				ctx.out(format!("{n}\n").as_bytes());
			} else {
				ctx.usage(format!("unknown signal: SIG{}", name.as_bstr()));
				status += 1;
			}
		} else if !rest.is_empty() {
			ctx.usage(format!("unknown signal: SIG{}", rest.as_bstr()));
			status += 1;
		} else {
			let mut sig = i64::from(v as i32);
			let low = sig & 0x7f;
			if low != 0 && low != 0x7f {
				sig = low;
			} else if sig & 0xff == 0x7f {
				sig = (sig >> 8) & 0xff;
			}
			if (1..=SIGCOUNT).contains(&sig) {
				ctx.out(format!("{}\n", sig_name(sig, platform)).as_bytes());
			} else {
				ctx.out(format!("{sig}\n").as_bytes());
			}
		}
	}
	done(status)
}

/// zsh `bin_kill`: `kill [-sig | -s name | -n num] pid|%job…`, `kill -l
/// [sig…]`. The status counts the operands that failed.
pub fn kill(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
	let mut sig = i64::from(Signal::Term.number(platform));
	let mut rest = args;
	if let Some(a) = rest.first()
		&& a.first() == Some(&b'-')
	{
		let a1 = a.get(1).copied();
		if a1.is_some_and(|c| c.is_ascii_digit()) {
			let (v, end) = zstrtol(&a[1..]);
			if 1 + end != a.len() {
				ctx.usage(format!("invalid signal number: {}", a.as_bstr()));
				return done(1);
			}
			sig = v;
		} else if a1 != Some(b'-') || a.len() > 2 {
			if a.as_slice() == b"-l" {
				if rest.len() > 1 {
					return list(ctx, &rest[1..], platform);
				}
				let names: Vec<String> = (1..=SIGCOUNT).map(|n| sig_name(n, platform)).collect();
				ctx.out(format!("{}\n", names.join(" ")).as_bytes());
				return done(0);
			}
			if a.as_slice() == b"-n" {
				let Some(n) = rest.get(1) else {
					ctx.usage("-n: argument expected");
					return done(1);
				};
				rest = &rest[1..];
				let (v, end) = zstrtol(n);
				if end != n.len() {
					ctx.usage(format!("invalid signal number: {}", n.as_bstr()));
					return done(1);
				}
				sig = v;
			} else {
				let signame: &[u8] = if a.as_slice() == b"-s" {
					let Some(n) = rest.get(1) else {
						ctx.usage("-s: argument expected");
						return done(1);
					};
					rest = &rest[1..];
					n
				} else {
					&a[1..]
				};
				if signame.is_empty() {
					ctx.usage("-: signal name expected");
					return done(1);
				}
				let upper = signame.to_ascii_uppercase();
				let name = upper.strip_prefix(b"SIG").unwrap_or(&upper);
				sig = if name == b"0" {
					0
				} else if let Some(n) = sig_number(name, platform, false) {
					n
				} else {
					ctx.usage(format!("unknown signal: SIG{}", name.as_bstr()));
					ctx.usage("type kill -l for a list of signals");
					return done(1);
				};
			}
		}
		rest = &rest[1..];
	}
	// The standard `-` and `--` option breaks.
	if let Some(a) = rest.first()
		&& a.first() == Some(&b'-')
		&& matches!(a.get(1), None | Some(b'-'))
	{
		rest = &rest[1..];
	}
	if rest.is_empty() {
		ctx.usage("not enough arguments");
		return done(1);
	}
	let posix = isset(ctx, ZshOpt::Posixbuiltins)?;
	let send = match u8::try_from(sig) {
		Ok(0) => Some(Send::Probe),
		Ok(n) => Signal::from_number(n, platform).map(Send::Signal),
		Err(_) => None,
	};
	let mut status: i32 = 0;
	for arg in rest {
		let is_job = arg.first() == Some(&b'%');
		if !is_job && !isanum(arg) {
			ctx.usage(format!("illegal pid: {}", arg.as_bstr()));
			status += 1;
			continue;
		}
		let Some(send) = send else {
			// `kill(2)` refuses the number before looking at the target.
			if is_job && super::zsh_jobs::getjob(ctx, arg, posix).is_none() {
				status += 1;
				continue;
			}
			// `EINVAL`.
			ctx.usage(format!("kill {} failed: invalid argument", arg.as_bstr()));
			status += 1;
			continue;
		};
		let operand = if is_job {
			arg.clone()
		} else {
			BString::from(atoi(arg).to_string())
		};
		let failed = match target(ctx, &operand, send, Some(posix)) {
			Ok(Some(t)) => {
				if let Some(s) = send.signal() {
					let ctl = ControlHandle(ctx.k.ctl.clone());
					ctl.signal(t, s);
					// A stopped job is continued after a signal that does
					// not stop it.
					if let SigTarget::Job(id) = t
						&& ctx
							.vp
							.jobs
							.iter()
							.any(|j| j.id == id && matches!(j.state, JobState::Stopped(_)))
						&& !matches!(
							s,
							Signal::Kill
								| Signal::Cont
								| Signal::Tstp
								| Signal::Ttou
								| Signal::Ttin
								| Signal::Stop
						) {
						ctl.signal(t, Signal::Cont);
					}
				}
				None
			},
			Ok(None) => None,
			Err(TargetError::Reported) => {
				status += 1;
				continue;
			},
			Err(TargetError::Host(e)) => Some(errtext(&e)),
			// `ESRCH`.
			Err(TargetError::NoSuchJob | TargetError::NoSuchProcess | TargetError::NotAnId) => {
				Some("no such process".to_owned())
			},
		};
		if let Some(msg) = failed {
			ctx.usage(format!("kill {} failed: {msg}", arg.as_bstr()));
			status += 1;
		}
	}
	done(if status < 126 { status } else { 1 })
}
