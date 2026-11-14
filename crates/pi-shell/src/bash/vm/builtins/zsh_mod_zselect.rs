//! zsh/zselect: `zselect`, waiting for fds to become ready for reading,
//! writing or exceptional conditions, with a timeout in hundredths of a
//! second.
//!
//! Ported from zsh 5.9 `Src/Modules/zselect.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group;
//! zselect.c Copyright (c) 2001 Peter Stephenson).

use bstr::{BStr, BString};

use super::{
	Ctx, R, done,
	zsh_args::{zerr, zx},
	zsh_mod_system::{errmsg, fd_probe, set_errno, zstrtol},
};
use crate::bash::vm::{
	fdprobe::{FdAnswer, FdProbe},
	zsh::params,
};

/// zselect's three fd sets, in `select(2)` order.
const FDCHAR: [u8; 3] = *b"rwe";

/// zsh `handle_digits`: add the fd `arg` starts with to `set`; `false`
/// after the message.
fn handle_digits(ctx: &mut Ctx<'_, '_>, arg: &[u8], set: &mut Vec<i32>) -> bool {
	if !arg.first().is_some_and(u8::is_ascii_digit) {
		ctx.usage(format!("expecting file descriptor: {}", BStr::new(arg)));
		return false;
	}
	let (fd, rest) = zstrtol(arg);
	if !rest.is_empty() {
		ctx.usage(format!("garbage after file descriptor: {}", BStr::new(rest)));
		return false;
	}
	let fd = fd as i32;
	if !set.contains(&fd) {
		set.push(fd);
	}
	true
}

/// The argument of `-a`/`-A`/`-t` at `arg[p]`: the rest of the word, or
/// the next word (`i` moves past it). `None`: there is none.
fn opt_arg(args: &[BString], i: &mut usize, arg: &[u8], p: usize) -> Option<BString> {
	if p + 1 < arg.len() {
		return Some(BString::from(&arg[p + 1..]));
	}
	let next = args.get(*i + 1)?;
	*i += 1;
	Some(next.clone())
}

/// zsh `bin_zselect`.
pub fn zselect(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut sets: [Vec<i32>; 3] = Default::default();
	let mut which = 0;
	let mut timeout_ns = None;
	let mut outarray = BString::from("reply");
	let mut outhash: Option<BString> = None;
	let mut i = 0;
	while let Some(word) = args.get(i) {
		let arg = word.clone();
		if arg.first() == Some(&b'-') {
			let mut p = 1;
			while let Some(&c) = arg.get(p) {
				match c {
					b'a' | b'A' => {
						let Some(name) = opt_arg(args, &mut i, &arg, p) else {
							ctx.usage(format!("argument expected after -{}", char::from(c)));
							return done(1);
						};
						if name.first().is_some_and(u8::is_ascii_digit)
							|| !params::isident(&name, params::wide_idents_ctx(ctx))
						{
							ctx.usage(format!("invalid array name: {}", BStr::new(&name)));
							return done(1);
						}
						if c == b'a' {
							outarray = name;
						} else {
							outhash = Some(name);
						}
						break;
					},
					b'r' => which = 0,
					b'w' => which = 1,
					b'e' => which = 2,
					b't' => {
						let Some(t) = opt_arg(args, &mut i, &arg, p) else {
							ctx.usage(format!("argument expected after -{}", char::from(c)));
							return done(1);
						};
						if !t.first().is_some_and(u8::is_ascii_digit) {
							ctx.usage("number expected after -t");
							return done(1);
						}
						let (n, rest) = zstrtol(&t);
						if !rest.is_empty() {
							ctx.usage(format!("garbage after -t argument: {}", BStr::new(rest)));
							return done(1);
						}
						// Hundredths of a second.
						let n = u64::try_from(n).unwrap_or(0);
						timeout_ns = Some(n / 100 * 1_000_000_000 + n % 100 * 10_000_000);
						break;
					},
					// zsh goes on with the next character after the digits
					// it took, so `-r12` names fds 12 and 2.
					_ => {
						if !handle_digits(ctx, &arg[p..], &mut sets[which]) {
							return done(1);
						}
					},
				}
				p += 1;
			}
		} else if !handle_digits(ctx, &arg, &mut sets[which]) {
			return done(1);
		}
		i += 1;
	}
	for s in &mut sets {
		s.sort_unstable();
	}
	let ready = match fd_probe(ctx, FdProbe::Select { sets, timeout_ns })? {
		FdAnswer::Ready(ready) => ready,
		FdAnswer::Err(e) => {
			set_errno(ctx, &e);
			ctx.usage(format!("error on select: {}", errmsg(&e)));
			return done(1);
		},
		_ => return done(1),
	};
	// No fd is ready: the timeout passed.
	if ready.iter().all(Vec::is_empty) {
		return done(1);
	}
	let mut out: Vec<BString> = Vec::new();
	match &outhash {
		// fd → the subset of `rwe` it is ready for, in first-seen order.
		Some(_) => {
			for (set, &ch) in ready.iter().zip(&FDCHAR) {
				for fd in set {
					let key = BString::from(fd.to_string());
					match out.iter().position(|k| *k == key) {
						Some(at) if at % 2 == 0 => {
							if !out[at + 1].contains(&ch) {
								out[at + 1].push(ch);
							}
						},
						_ => {
							out.push(key);
							out.push(BString::from(vec![ch]));
						},
					}
				}
			}
		},
		// `-r fd… -w fd… -e fd…`.
		None => {
			for (set, &ch) in ready.iter().zip(&FDCHAR) {
				if !set.is_empty() {
					out.push(BString::from(vec![b'-', ch]));
					out.extend(set.iter().map(|fd| BString::from(fd.to_string())));
				}
			}
		},
	}
	let r = match outhash {
		Some(h) => zx(ctx, |ex| params::sethparam(ex, &h, &out))?,
		None => zx(ctx, |ex| params::assignaparam(ex, &outarray, out, 0))?,
	};
	if let Err(d) = r {
		return zerr(ctx, d);
	}
	done(0)
}
