//! zsh/stat: `zstat` (and `stat`), `stat(2)` results printed or stored in
//! an array or association.
//!
//! Ported from zsh 5.9 `Src/Modules/stat.c` (MIT-style licence, Copyright
//! (c) 1996-1997 Peter Stephenson) and `ztrftime` from `Src/utils.c`
//! (Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::BString;

use super::{
	Ctx, Need, R, done,
	zsh_args::{zerr, zx},
	zsh_mod_files::{Fsq, errmsg, host_path, nice, type_bits},
	zsh_mod_util::local_zone,
	zsh_print::charset,
};
use crate::bash::{
	fs::{PwQuery, Stat, StatKind},
	vm::{
		fsprobe::FsReq,
		zsh::params::{self, ASSPM_WARN},
	},
};

/// zsh `statelts`, in `enum statnum` order.
const ELEMENTS: [&str; 14] = [
	"device", "inode", "mode", "nlink", "uid", "gid", "rdev", "size", "atime", "mtime", "ctime",
	"blksize", "blocks", "link",
];

/// `ST_READLINK`.
const LINK: usize = 13;

/// zsh `enum statflags`.
const STF_NAME: u32 = 1;
const STF_FILE: u32 = 2;
const STF_STRING: u32 = 4;
const STF_RAW: u32 = 8;
const STF_PICK: u32 = 16;
const STF_ARRAY: u32 = 32;
const STF_GMT: u32 = 64;
const STF_HASH: u32 = 128;
const STF_OCTAL: u32 = 256;

/// zsh `bin_stat`, for `stat` and `zstat`: it parses its own options.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn stat(ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> R {
	let mut timefmt: Vec<u8> = b"%a %b %e %k:%M:%S %Z %Y".to_vec();
	let mut on = [false; 128];
	let mut arrnam: Option<BString> = None;
	let mut hashnam: Option<BString> = None;
	let mut fd: i32 = 0;
	let mut iwhich: Option<usize> = None;
	let mut flags = 0u32;
	let mut found = 0;
	let mut i = 0;
	while i < argv.len() && matches!(argv[i].first(), Some(b'+' | b'-')) {
		let word = &argv[i];
		let arg = &word[1..];
		if arg.is_empty() || matches!(arg[0], b'-' | b'+') {
			i += 1;
			break;
		}
		if word[0] == b'+' {
			if found > 0 {
				break;
			}
			for (n, e) in ELEMENTS.iter().enumerate() {
				if e.as_bytes().starts_with(arg) {
					found += 1;
					iwhich = Some(n);
				}
			}
			if found > 1 {
				ctx.usage(format!("{}: ambiguous stat element", BString::from(arg)));
				return done(1);
			}
			if found == 0 {
				ctx.usage(format!("{}: no such stat element", BString::from(arg)));
				return done(1);
			}
			// The name of a link is wanted: lstat it.
			if iwhich == Some(LINK) {
				on[usize::from(b'L')] = true;
			}
			flags |= STF_PICK;
		} else {
			let mut j = 0;
			while j < arg.len() {
				let c = arg[j];
				let rest = &arg[j + 1..];
				// The value of an option taking one: the rest of this word,
				// else the next word.
				let value = |i: &mut usize| -> Option<BString> {
					if rest.is_empty() {
						*i += 1;
						argv.get(*i).cloned()
					} else {
						Some(BString::from(rest))
					}
				};
				match c {
					b'g' | b'l' | b'L' | b'n' | b'N' | b'o' | b'r' | b's' | b't' | b'T' => {
						on[usize::from(c)] = true;
					},
					b'A' => {
						let Some(v) = value(&mut i) else {
							ctx.usage("missing parameter name");
							return done(1);
						};
						arrnam = Some(v);
						flags |= STF_ARRAY;
						break;
					},
					b'H' => {
						let Some(v) = value(&mut i) else {
							ctx.usage("missing parameter name");
							return done(1);
						};
						hashnam = Some(v);
						flags |= STF_HASH;
						break;
					},
					b'f' => {
						on[usize::from(b'f')] = true;
						let Some(v) = value(&mut i) else {
							ctx.usage("missing file descriptor");
							return done(1);
						};
						let (n, tail) = super::zsh_mod_util::zstrtol(&v);
						if !tail.is_empty() {
							ctx.usage("bad file descriptor");
							return done(1);
						}
						fd = n as i32;
						break;
					},
					b'F' => {
						let Some(v) = value(&mut i) else {
							ctx.usage("missing time format");
							return done(1);
						};
						timefmt = v.into();
						on[usize::from(b's')] = true;
						break;
					},
					_ => {
						ctx.usage(format!("bad option: -{}", char::from(c)));
						return done(1);
					},
				}
				j += 1;
			}
		}
		i += 1;
	}
	let args = &argv[i.min(argv.len())..];
	let opt = |c: u8| on[usize::from(c)];

	if flags & STF_ARRAY != 0 && flags & STF_HASH != 0 {
		ctx.usage("both array and hash requested");
		return done(1);
	}
	if opt(b'l') {
		if let Some(name) = &arrnam {
			let names: Vec<BString> = ELEMENTS.iter().map(|e| BString::from(*e)).collect();
			return set_array(ctx, name, names);
		}
		ctx.out(ELEMENTS.join(" ").as_bytes());
		ctx.out(b"\n");
		return done(0);
	}
	if args.is_empty() && !opt(b'f') {
		ctx.usage("no files given");
		return done(1);
	}
	if !args.is_empty() && opt(b'f') {
		ctx.usage("no files allowed with -f");
		return done(1);
	}
	let nargs = if opt(b'f') { 1 } else { args.len() };
	if opt(b'g') {
		flags |= STF_GMT;
		on[usize::from(b's')] = true;
	}
	let opt = |c: u8| on[usize::from(c)];
	if opt(b's') || opt(b'r') {
		flags |= STF_STRING;
	}
	if opt(b'r') || !opt(b's') {
		flags |= STF_RAW;
	}
	if opt(b'n') {
		flags |= STF_FILE;
	}
	if opt(b'o') {
		flags |= STF_OCTAL;
	}
	if opt(b't') {
		flags |= STF_NAME;
	}
	if arrnam.is_none() && hashnam.is_none() {
		if nargs > 1 {
			flags |= STF_FILE;
		}
		if flags & STF_PICK == 0 {
			flags |= STF_NAME;
		}
	}
	if opt(b'N') || opt(b'f') {
		flags &= !STF_FILE;
	}
	if opt(b'T') || hashnam.is_some() {
		flags &= !STF_NAME;
	}
	if hashnam.is_some() && nargs > 1 {
		ctx.usage("only one file allowed with -H");
		return done(1);
	}

	let cs = charset(ctx)?;
	let mut q = Fsq::new(ctx);
	let mut array: Vec<BString> = Vec::new();
	let mut hash: Vec<BString> = Vec::new();
	let mut ret = 0;
	let mut k = 0;
	loop {
		if !opt(b'f') && k >= args.len() {
			break;
		}
		let fname: Option<&BString> = if opt(b'f') { None } else { Some(&args[k]) };
		let st = match fname {
			None => q.stat_fd(fd)?,
			Some(f) => {
				let path = host_path(ctx, f);
				q.stat(&path, !opt(b'L'))?
			},
		};
		let st = match st {
			Ok(st) => st,
			Err(e) => {
				let what = fname.map_or_else(|| fd.to_string(), |f| nice(cs, f));
				ctx.usage(format!("{what}: {}", errmsg(&e)));
				ret = 1;
				if opt(b'f') || arrnam.is_some() {
					break;
				}
				k += 1;
				continue;
			},
		};
		if flags & STF_FILE != 0
			&& let Some(f) = fname
		{
			if arrnam.is_some() {
				array.push(f.clone());
			} else if hashnam.is_some() {
				hash.push(BString::from("name"));
				hash.push(f.clone());
			} else {
				let sep: &[u8] = if flags & STF_PICK != 0 { b" " } else { b":\n" };
				ctx.out(f);
				ctx.out(sep);
			}
		}
		let which: Vec<usize> = match iwhich {
			Some(w) => vec![w],
			None => (0..ELEMENTS.len()).collect(),
		};
		for w in which {
			let text = statprint(ctx, &mut q, &st, fname, w, flags, &timefmt)?;
			if arrnam.is_some() {
				array.push(text);
			} else if hashnam.is_some() {
				hash.push(BString::from(ELEMENTS[w]));
				hash.push(text);
			} else {
				ctx.out(&text);
				ctx.out(b"\n");
			}
		}
		if opt(b'f') {
			break;
		}
		if arrnam.is_none() && hashnam.is_none() && k + 1 < args.len() && flags & STF_PICK == 0 {
			ctx.out(b"\n");
		}
		k += 1;
	}
	if ret == 0 {
		if let Some(name) = &arrnam {
			return set_array(ctx, name, array);
		}
		if let Some(name) = &hashnam {
			match zx(ctx, |ex| params::sethparam(ex, name, &hash))? {
				Ok(()) => {},
				Err(d) => return zerr(ctx, d),
			}
		}
	}
	done(ret)
}

/// zsh `setaparam` from the builtin.
fn set_array(ctx: &mut Ctx<'_, '_>, name: &[u8], vals: Vec<BString>) -> R {
	match zx(ctx, |ex| params::assignaparam(ex, name, vals, ASSPM_WARN))? {
		Ok(()) => done(0),
		Err(d) => zerr(ctx, d),
	}
}

/// zsh `statprint`: element `w` of `st` as text.
fn statprint(
	ctx: &mut Ctx<'_, '_>,
	q: &mut Fsq<'_>,
	st: &Stat,
	fname: Option<&BString>,
	w: usize,
	flags: u32,
	timefmt: &[u8],
) -> Result<BString, Need> {
	let mut out = Vec::new();
	if flags & STF_NAME != 0 {
		if flags & (STF_PICK | STF_ARRAY) != 0 {
			out.extend_from_slice(format!("{} ", ELEMENTS[w]).as_bytes());
		} else {
			out.extend_from_slice(format!("{:<8}", ELEMENTS[w]).as_bytes());
		}
	}
	let num = |out: &mut Vec<u8>, n: u64| out.extend_from_slice(n.to_string().as_bytes());
	match w {
		0 => num(&mut out, st.dev),
		1 => num(&mut out, st.ino),
		2 => modeprint(&mut out, type_bits(st.kind) | (st.mode & 0o7777), flags),
		3 => num(&mut out, st.nlink),
		4 | 5 => {
			let id = if w == 4 { st.uid } else { st.gid };
			if flags & STF_RAW != 0 {
				num(&mut out, u64::from(id));
				if flags & STF_STRING != 0 {
					out.extend_from_slice(b" (");
				}
			}
			if flags & STF_STRING != 0 {
				let query = if w == 4 {
					PwQuery::Uid(id)
				} else {
					PwQuery::Gid(id)
				};
				match q.user(query)? {
					Some(e) => out.extend_from_slice(&e.name),
					None => num(&mut out, u64::from(id)),
				}
				if flags & STF_RAW != 0 {
					out.push(b')');
				}
			}
		},
		6 => num(&mut out, st.rdev),
		7 => num(&mut out, st.size),
		8..=10 => {
			let ns = match w {
				8 => st.atime_ns,
				9 => st.mtime_ns,
				_ => st.ctime_ns,
			};
			let secs = ns.div_euclid(1_000_000_000);
			let nsec = ns.rem_euclid(1_000_000_000);
			if flags & STF_RAW != 0 {
				out.extend_from_slice(secs.to_string().as_bytes());
				if flags & STF_STRING != 0 {
					out.extend_from_slice(b" (");
				}
			}
			if flags & STF_STRING != 0 {
				let (offset, abbr) = if flags & STF_GMT != 0 {
					(0, BString::from("UTC"))
				} else {
					zx(ctx, |ex| local_zone(ex, secs))?.unwrap_or_else(|_| (0, BString::from("UTC")))
				};
				out.extend_from_slice(&ztrftime(timefmt, secs, nsec, offset, &abbr, 40));
				if flags & STF_RAW != 0 {
					out.push(b')');
				}
			}
		},
		11 => num(&mut out, st.blksize),
		12 => num(&mut out, st.blocks),
		_ => {
			// zsh `statlinkprint`: the target of a symbolic link stat'd by
			// name (never of an fd).
			if let Some(f) = fname
				&& st.kind == StatKind::Symlink
			{
				let path = host_path(ctx, f);
				if let Ok(target) = q.bytes(FsReq::ReadLink { path })? {
					out.extend_from_slice(target);
				}
			}
		},
	}
	Ok(BString::from(out))
}

/// zsh `statmodeprint`: the mode number and/or `ls`-style string.
fn modeprint(out: &mut Vec<u8>, mode: u32, flags: u32) {
	if flags & STF_RAW != 0 {
		if flags & STF_OCTAL != 0 {
			out.extend_from_slice(format!("0{mode:o}").as_bytes());
		} else {
			out.extend_from_slice(mode.to_string().as_bytes());
		}
		if flags & STF_STRING != 0 {
			out.extend_from_slice(b" (");
		}
	}
	if flags & STF_STRING != 0 {
		let mut pm = *b"?rwxrwxrwx";
		pm[0] = match mode & 0o170_000 {
			0o060_000 => b'b',
			0o020_000 => b'c',
			0o040_000 => b'd',
			0o010_000 => b'p',
			0o120_000 => b'l',
			0o100_000 => b'-',
			0o140_000 => b's',
			_ => b'?',
		};
		for (i, bit) in (0..9).rev().enumerate() {
			if mode & (1 << bit) == 0 {
				pm[i + 1] = b'-';
			}
		}
		if mode & 0o4000 != 0 {
			pm[3] = if mode & 0o100 != 0 { b's' } else { b'S' };
		}
		if mode & 0o2000 != 0 {
			pm[6] = if mode & 0o010 != 0 { b's' } else { b'S' };
		}
		if mode & 0o1000 != 0 {
			pm[9] = if mode & 0o001 != 0 { b't' } else { b'T' };
		}
		out.extend_from_slice(&pm);
		if flags & STF_RAW != 0 {
			out.push(b')');
		}
	}
}

/// Broken-down time fields `ztrftime` formats itself.
struct Tm {
	/// Years since 1900.
	year: i64,
	/// 0–11.
	mon:  u32,
	mday: u32,
	hour: u32,
	min:  u32,
	sec:  u32,
}

impl Tm {
	fn of(secs: i64, offset: i32, abbr: &[u8]) -> Self {
		let text = super::strftime::format(b"%Y %m %d %H %M %S", secs, offset, abbr);
		let mut f = text.split(|&c| c == b' ').map(|w| {
			std::str::from_utf8(w)
				.ok()
				.and_then(|s| s.parse::<i64>().ok())
				.unwrap_or(0)
		});
		let mut next = || f.next().unwrap_or(0);
		let year = next() - 1900;
		let mon = u32::try_from(next() - 1).unwrap_or(0);
		let mday = u32::try_from(next()).unwrap_or(0);
		let hour = u32::try_from(next()).unwrap_or(0);
		let min = u32::try_from(next()).unwrap_or(0);
		let sec = u32::try_from(next()).unwrap_or(0);
		Self { year, mon, mday, hour, min, sec }
	}
}

/// zsh `ztrftime` into a buffer of `bufsize` bytes (as zsh's
/// `stattimeprint` gives it 40): zsh's own `%.`, `%N`, `%f`, `%e`, `%K`,
/// `%k`, `%H`, `%L`, `%l`, `%d`, `%m`, `%M`, `%S`, `%y` (with `-` to strip
/// padding), the rest through `strftime`; output stops where zsh's buffer
/// accounting runs out.
pub fn ztrftime(
	fmt: &[u8],
	secs: i64,
	nsec: i64,
	offset: i32,
	abbr: &[u8],
	bufsize: i64,
) -> Vec<u8> {
	let tm = Tm::of(secs, offset, abbr);
	let mut left = bufsize;
	let mut out = Vec::with_capacity(fmt.len() * 2);
	// zsh `ztrftimebuf`: room for `decr` more bytes?
	let room = |left: &mut i64, decr: i64| {
		if *left <= decr {
			return false;
		}
		*left -= decr;
		true
	};
	let digit = |n: u32| b'0' + u8::try_from(n % 10).unwrap_or(0);
	let mut i = 0;
	while i < fmt.len() {
		if fmt[i] != b'%' {
			if !room(&mut left, 1) {
				return out;
			}
			out.push(fmt[i]);
			i += 1;
			continue;
		}
		let start = i;
		i += 1;
		let mut strip = false;
		let mut digs: i64 = 3;
		if fmt.get(i) == Some(&b'-') {
			strip = true;
			i += 1;
		}
		if fmt.get(i).is_some_and(u8::is_ascii_digit) {
			let mut d = i + 1;
			while fmt.get(d).is_some_and(u8::is_ascii_digit) {
				d += 1;
			}
			if fmt.get(d) == Some(&b'.') {
				digs = std::str::from_utf8(&fmt[i..d])
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(i64::MAX);
				i = d;
			}
		}
		if !room(&mut left, 2) {
			return out;
		}
		// zsh's `morefmt`: flags and widths go to `strftime` whole.
		let mut via_strftime = false;
		loop {
			let n = i - start;
			if !(n == 1 || (n == 2 && strip) || fmt.get(i) == Some(&b'.')) {
				while fmt.get(i).is_some_and(|c| b"OE^#_-0123456789".contains(c)) {
					i += 1;
				}
				if i < fmt.len() {
					i += 1;
					via_strftime = true;
					break;
				}
			}
			let Some(&c) = fmt.get(i) else {
				// A `%` at the end.
				out.push(b'%');
				break;
			};
			i += 1;
			match c {
				b'.' => {
					let digs = if (0..=9).contains(&digs) { digs } else { 9 };
					if !room(&mut left, digs) {
						return out;
					}
					let mut fnsec = nsec;
					if digs < 9 {
						let mut max: i64 = 100_000_000;
						for _ in 0..(8 - digs) {
							max /= 10;
							fnsec /= 10;
						}
						max -= 1;
						fnsec = (fnsec + 5) / 10;
						if fnsec > max {
							fnsec = max;
						}
					}
					let width = usize::try_from(digs).unwrap_or(9);
					out.extend_from_slice(format!("{fnsec:0width$}").as_bytes());
				},
				b'f' | b'e' => {
					let strip = strip || c == b'f';
					if tm.mday > 9 {
						out.push(digit(tm.mday / 10));
					} else if !strip {
						out.push(b' ');
					}
					out.push(digit(tm.mday));
				},
				b'K' | b'H' | b'k' => {
					let strip = strip || c == b'K';
					if tm.hour > 9 {
						out.push(digit(tm.hour / 10));
					} else if !strip {
						out.push(if c == b'H' { b'0' } else { b' ' });
					}
					out.push(digit(tm.hour));
				},
				b'L' | b'l' => {
					let strip = strip || c == b'L';
					let hr12 = match tm.hour % 12 {
						0 => 12,
						h => h,
					};
					if hr12 > 9 {
						out.push(b'1');
					} else if !strip {
						out.push(b' ');
					}
					out.push(digit(hr12));
				},
				b'd' => {
					if tm.mday > 9 || !strip {
						out.push(digit(tm.mday / 10));
					}
					out.push(digit(tm.mday));
				},
				b'm' => {
					if tm.mon > 8 || !strip {
						out.push(digit((tm.mon + 1) / 10));
					}
					out.push(digit(tm.mon + 1));
				},
				b'M' => {
					if tm.min > 9 || !strip {
						out.push(digit(tm.min / 10));
					}
					out.push(digit(tm.min));
				},
				b'S' => {
					if tm.sec > 9 || !strip {
						out.push(digit(tm.sec / 10));
					}
					out.push(digit(tm.sec));
				},
				b'N' => {
					if !room(&mut left, 9) {
						return out;
					}
					out.extend_from_slice(format!("{nsec:09}").as_bytes());
				},
				b'y' => {
					let y = u32::try_from(tm.year.rem_euclid(100)).unwrap_or(0);
					if tm.year > 9 || !strip {
						out.push(digit(y / 10));
					}
					out.push(digit(y));
				},
				b'E' | b'O' | b'^' | b'#' | b'_' | b'-' | b'0'..=b'9' => continue,
				_ => via_strftime = true,
			}
			break;
		}
		if via_strftime {
			let spec = &fmt[start..i];
			let text = super::strftime::format(spec, secs, offset, abbr);
			let origchar = spec.last().copied().unwrap_or(0);
			// `strftime(buf, left + 2, …)` fails when the text does not fit,
			// and an empty text reads as failure but for `%p`/`%P`.
			let fits = i64::try_from(text.len()).unwrap_or(i64::MAX) < left + 2;
			if !fits || (text.is_empty() && origchar != b'p' && origchar != b'P') {
				return out;
			}
			left -= i64::try_from(text.len()).unwrap_or(0) - 2;
			out.extend_from_slice(&text);
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn mode_strings_match_ls() {
		let mut out = Vec::new();
		modeprint(&mut out, 0o100_644, STF_STRING);
		assert_eq!(out, b"-rw-r--r--");
		out.clear();
		modeprint(&mut out, 0o041_777, STF_STRING | STF_RAW | STF_OCTAL);
		assert_eq!(out, b"041777 (drwxrwxrwt)");
		out.clear();
		modeprint(&mut out, 0o106_644, STF_STRING);
		assert_eq!(out, b"-rwSr-Sr--");
	}

	#[test]
	fn ztrftime_runs_out_like_zsh() {
		// 2026-01-02 03:04:05 UTC, from `zstat -F` against /bin/zsh: the
		// 40-byte buffer ends before `%L`.
		let t = 1_767_323_045;
		let got = ztrftime(b"%Y-%m-%d %N %3. %-d %f %K %L|%Z|%s", t, 0, 0, b"UTC", 40);
		assert_eq!(got, b"2026-01-02 000000000 000 2 2 3 ");
		assert_eq!(
			ztrftime(b"%a %b %e %k:%M:%S %Z %Y", t, 0, 0, b"UTC", 40),
			b"Fri Jan  2  3:04:05 UTC 2026"
		);
	}
}
