//! zsh/datetime: `strftime`, and zsh's `ztrftime` over the C library's
//! `strftime` and `strptime` as the BSD libc zsh 5.9 runs on implements
//! them (C locale).
//!
//! Ported from zsh 5.9 `Src/Modules/datetime.c` and `Src/utils.c`
//! (`ztrftime`, `zstrtol`) (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::{Ops, zerr, zx},
};
use crate::bash::{
	diag::Diag,
	vm::zsh::{math::Number, params},
};

const DAYS: [&str; 7] =
	["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/// Days since 1970-01-01 of a proleptic Gregorian date (`m` 1–12).
const fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
	let y = if m <= 2 { y - 1 } else { y };
	let era = y.div_euclid(400);
	let yoe = y - era * 400;
	let mp = (m + 9) % 12;
	let doy = (153 * mp + 2) / 5 + d - 1;
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	era * 146_097 + doe - 719_468
}

/// The date of `days` since 1970-01-01: (year, month 1–12, day 1–31).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	(yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Whether `y` is a leap year.
const fn isleap(y: i64) -> bool {
	y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

/// Broken-down local time (C `struct tm`).
struct Tm {
	/// Seconds since the epoch.
	secs: i64,
	/// `tm_year` (years since 1900).
	year: i64,
	/// 0–11.
	mon:  i64,
	mday: i64,
	hour: i64,
	min:  i64,
	sec:  i64,
	/// 0 = Sunday.
	wday: i64,
	/// 0-based.
	yday: i64,
	/// Seconds east of UTC.
	off:  i32,
	abbr: BString,
}

impl Tm {
	/// C `localtime`: `None` when the year does not fit `tm_year`.
	fn new(secs: i64, off: i32, abbr: BString) -> Option<Self> {
		let local = secs.checked_add(i64::from(off))?;
		let days = local.div_euclid(86_400);
		let sod = local.rem_euclid(86_400);
		let (y, m, d) = civil_from_days(days);
		let year = y - 1900;
		i32::try_from(year).ok()?;
		Some(Self {
			secs,
			year,
			mon: m - 1,
			mday: d,
			hour: sod / 3600,
			min: sod / 60 % 60,
			sec: sod % 60,
			wday: (days + 4).rem_euclid(7),
			yday: days - days_from_civil(y, 1, 1),
			off,
			abbr,
		})
	}
}

/// C `sprintf("%0*ld")`-style decimal (`width` 0: as is).
fn push_num(out: &mut Vec<u8>, v: i64, width: usize, pad: u8) {
	let s = v.unsigned_abs().to_string();
	let len = s.len() + usize::from(v < 0);
	if pad == b'0' && v < 0 {
		out.push(b'-');
	}
	for _ in len..width {
		out.push(pad);
	}
	if pad != b'0' && v < 0 {
		out.push(b'-');
	}
	out.extend_from_slice(s.as_bytes());
}

/// The BSD `strftime` padding a flag selects.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pad {
	Default,
	/// `-`.
	Less,
	/// `_`.
	Space,
	/// `0`.
	Zero,
}

/// BSD `_conv`: `v` in a field of `width` padded per `dflt` (the
/// conversion's own padding character) unless a flag says otherwise.
fn conv(out: &mut Vec<u8>, v: i64, width: usize, dflt: u8, pad: Pad) {
	match pad {
		Pad::Default => push_num(out, v, width, dflt),
		Pad::Less => push_num(out, v, 0, b'0'),
		Pad::Space => push_num(out, v, width, b' '),
		Pad::Zero => push_num(out, v, width, b'0'),
	}
}

/// BSD `_yconv`: the century and/or the year within it of `year`.
fn yconv(out: &mut Vec<u8>, year: i64, top: bool, yy: bool, pad: Pad) {
	let mut lead = year / 100;
	let mut trail = year % 100;
	if trail < 0 && lead > 0 {
		trail += 100;
		lead -= 1;
	} else if lead < 0 && trail > 0 {
		trail -= 100;
		lead += 1;
	}
	if top {
		if lead == 0 && trail < 0 {
			out.extend_from_slice(b"-0");
		} else {
			conv(out, lead, 2, b'0', pad);
		}
	}
	if yy {
		conv(out, trail.abs(), 2, b'0', pad);
	}
}

/// BSD `iso8601wknum`: the ISO 8601 week-based year and week.
const fn iso_week(tm: &Tm) -> (i64, i64) {
	let mut year = tm.year + 1900;
	let mut yday = tm.yday;
	let wday = tm.wday;
	loop {
		let len = if isleap(year) { 366 } else { 365 };
		let bot = ((yday + 11 - wday) % 7) - 3;
		let mut top = bot - (len % 7);
		if top < -3 {
			top += 7;
		}
		top += len;
		if yday >= top {
			return (year + 1, 1);
		}
		if yday >= bot {
			return (year, 1 + (yday - bot) / 7);
		}
		year -= 1;
		yday += if isleap(year) { 366 } else { 365 };
	}
}

/// The BSD libc `strftime` (C locale) of `fmt`: what zsh's `ztrftime`
/// hands it (one conversion with its flags).
fn bsd_strftime(fmt: &[u8], tm: &Tm, out: &mut Vec<u8>) {
	let mut i = 0;
	while i < fmt.len() {
		if fmt[i] != b'%' {
			out.push(fmt[i]);
			i += 1;
			continue;
		}
		let mut pad = Pad::Default;
		loop {
			i += 1;
			let Some(&c) = fmt.get(i) else {
				// `case '\0': --format; break;`: the character before.
				i -= 1;
				out.push(fmt[i]);
				break;
			};
			match c {
				b'A' => out.extend_from_slice(DAYS[tm.wday as usize].as_bytes()),
				b'a' => out.extend_from_slice(&DAYS[tm.wday as usize].as_bytes()[..3]),
				b'B' => out.extend_from_slice(MONTHS[tm.mon as usize].as_bytes()),
				b'b' | b'h' => out.extend_from_slice(&MONTHS[tm.mon as usize].as_bytes()[..3]),
				b'C' => yconv(out, tm.year + 1900, true, false, pad),
				b'd' => conv(out, tm.mday, 2, b'0', pad),
				b'c' => bsd_strftime(b"%a %b %e %H:%M:%S %Y", tm, out),
				b'D' => bsd_strftime(b"%m/%d/%y", tm, out),
				b'E' | b'O' => continue,
				b'e' => conv(out, tm.mday, 2, b' ', pad),
				b'F' => bsd_strftime(b"%Y-%m-%d", tm, out),
				b'H' => conv(out, tm.hour, 2, b'0', pad),
				b'I' | b'l' => {
					let h = if tm.hour % 12 == 0 { 12 } else { tm.hour % 12 };
					conv(out, h, 2, if c == b'I' { b'0' } else { b' ' }, pad);
				},
				b'j' => conv(out, tm.yday + 1, 3, b'0', pad),
				b'k' => conv(out, tm.hour, 2, b' ', pad),
				b'M' => conv(out, tm.min, 2, b'0', pad),
				b'm' => conv(out, tm.mon + 1, 2, b'0', pad),
				b'n' => out.push(b'\n'),
				b'p' => out.extend_from_slice(if tm.hour >= 12 { b"PM" } else { b"AM" }),
				b'R' => bsd_strftime(b"%H:%M", tm, out),
				b'r' => bsd_strftime(b"%I:%M:%S %p", tm, out),
				b'S' => conv(out, tm.sec, 2, b'0', pad),
				b's' => out.extend_from_slice(tm.secs.to_string().as_bytes()),
				b'T' | b'X' => bsd_strftime(b"%H:%M:%S", tm, out),
				b't' => out.push(b'\t'),
				b'U' => conv(out, (tm.yday + 7 - tm.wday) / 7, 2, b'0', pad),
				b'u' => conv(out, if tm.wday == 0 { 7 } else { tm.wday }, 0, b'0', pad),
				b'G' | b'g' | b'V' => {
					let (year, week) = iso_week(tm);
					match c {
						b'V' => conv(out, week, 2, b'0', pad),
						b'G' => yconv(out, year, true, true, pad),
						_ => yconv(out, year, false, true, pad),
					}
				},
				b'v' => bsd_strftime(b"%e-%b-%Y", tm, out),
				b'W' => {
					let w = if tm.wday == 0 { 6 } else { tm.wday - 1 };
					conv(out, (tm.yday + 7 - w) / 7, 2, b'0', pad);
				},
				b'w' => conv(out, tm.wday, 0, b'0', pad),
				b'x' => bsd_strftime(b"%m/%d/%y", tm, out),
				b'y' => yconv(out, tm.year + 1900, false, true, pad),
				b'Y' => yconv(out, tm.year + 1900, true, true, pad),
				b'Z' => out.extend_from_slice(&tm.abbr),
				b'z' => {
					let off = i64::from(tm.off);
					out.push(if off < 0 { b'-' } else { b'+' });
					let m = off.abs() / 60;
					push_num(out, m / 60 * 100 + m % 60, 4, b'0');
				},
				b'+' => bsd_strftime(b"%a %b %e %H:%M:%S %Z %Y", tm, out),
				b'-' | b'_' | b'0' if pad == Pad::Default => {
					pad = match c {
						b'-' => Pad::Less,
						b'_' => Pad::Space,
						_ => Pad::Zero,
					};
					continue;
				},
				// Undefined: the character itself.
				_ => out.push(c),
			}
			break;
		}
		i += 1;
	}
}

/// The C library's `strftime` of `spec` in `LC_TIME` locale `locale`: the
/// BSD port for `C`/`POSIX`, the system's own for any other locale.
fn libc_strftime(locale: &[u8], spec: &[u8], tm: &Tm, out: &mut Vec<u8>) {
	// `%z`, `%Z`, `%s` and `%+` (zone and epoch) are no locale's business,
	// and the C library would take them from the process's own zone.
	let zoned = matches!(spec.last(), Some(b'z' | b'Z' | b's' | b'+'));
	if !zoned && !matches!(locale, b"" | b"C" | b"POSIX") {
		let t = crate::sys::langinfo::Tm {
			sec:    tm.sec as i32,
			min:    tm.min as i32,
			hour:   tm.hour as i32,
			mday:   tm.mday as i32,
			mon:    tm.mon as i32,
			year:   tm.year as i32,
			wday:   tm.wday as i32,
			yday:   tm.yday as i32,
			gmtoff: i64::from(tm.off),
			zone:   tm.abbr.to_vec(),
		};
		if let Some(s) = crate::sys::langinfo::strftime(locale, spec, &t) {
			out.extend_from_slice(&s);
			return;
		}
	}
	bsd_strftime(spec, tm, out);
}

/// zsh `ztrftime`: `fmt` with zsh's own conversions (`%f`, `%K`, `%L`,
/// `%N`, `%.`, and the unpadded `%-x` forms) and the C library's (in the
/// `LC_TIME` locale `locale`) for the rest.
fn ztrftime(fmt: &[u8], tm: &Tm, nsec: i64, locale: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(fmt.len() * 2);
	let mut i = 0;
	let at = |j: usize| fmt.get(j).copied().unwrap_or(0);
	'outer: while i < fmt.len() {
		if fmt[i] != b'%' {
			out.push(fmt[i]);
			i += 1;
			continue;
		}
		let start = i;
		i += 1;
		let mut strip = false;
		if at(i) == b'-' {
			strip = true;
			i += 1;
		}
		let mut digs: u64 = 3;
		if at(i).is_ascii_digit() {
			let mut end = i + 1;
			while at(end).is_ascii_digit() {
				end += 1;
			}
			if at(end) == b'.' {
				digs = fmt[i..end]
					.iter()
					.fold(0u64, |v, &c| v.saturating_mul(10).saturating_add(u64::from(c - b'0')));
				i = end;
			}
		}
		loop {
			if !(i - start == 1 || (i - start == 2 && strip) || at(i) == b'.') {
				while i < fmt.len() && b"OE^#_-0123456789".contains(&fmt[i]) {
					i += 1;
				}
				if i < fmt.len() {
					i += 1;
					libc_strftime(locale, &fmt[start..i], tm, &mut out);
					continue 'outer;
				}
			}
			let c = at(i);
			i += 1;
			let hi = |out: &mut Vec<u8>, v: i64| out.push(b'0'.wrapping_add(v as u8));
			match c {
				b'.' => {
					let digs = if digs > 9 { 9 } else { digs as u32 };
					let mut fnsec = nsec;
					if digs < 9 {
						let mut max: i64 = 100_000_000;
						for _ in 0..(8 - digs) {
							max /= 10;
							fnsec /= 10;
						}
						max -= 1;
						fnsec = ((fnsec + 5) / 10).min(max);
					}
					if digs > 0 {
						push_num(&mut out, fnsec, digs as usize, b'0');
					}
				},
				0 => {
					out.push(b'%');
					i -= 1;
				},
				b'f' | b'e' => {
					if tm.mday > 9 {
						hi(&mut out, tm.mday / 10);
					} else if !strip && c == b'e' {
						out.push(b' ');
					}
					hi(&mut out, tm.mday % 10);
				},
				b'K' | b'H' | b'k' => {
					if tm.hour > 9 {
						hi(&mut out, tm.hour / 10);
					} else if !strip && c != b'K' {
						out.push(if c == b'H' { b'0' } else { b' ' });
					}
					hi(&mut out, tm.hour % 10);
				},
				b'L' | b'l' => {
					let h = if tm.hour % 12 == 0 { 12 } else { tm.hour % 12 };
					if h > 9 {
						out.push(b'1');
					} else if !strip && c == b'l' {
						out.push(b' ');
					}
					hi(&mut out, h % 10);
				},
				b'd' => {
					if tm.mday > 9 || !strip {
						hi(&mut out, tm.mday / 10);
					}
					hi(&mut out, tm.mday % 10);
				},
				b'm' => {
					if tm.mon > 8 || !strip {
						hi(&mut out, (tm.mon + 1) / 10);
					}
					hi(&mut out, (tm.mon + 1) % 10);
				},
				b'M' => {
					if tm.min > 9 || !strip {
						hi(&mut out, tm.min / 10);
					}
					hi(&mut out, tm.min % 10);
				},
				b'N' => push_num(&mut out, nsec, 9, b'0'),
				b'S' => {
					if tm.sec > 9 || !strip {
						hi(&mut out, tm.sec / 10);
					}
					hi(&mut out, tm.sec % 10);
				},
				b'y' => {
					if tm.year > 9 || !strip {
						hi(&mut out, (tm.year / 10) % 10);
					}
					hi(&mut out, tm.year % 10);
				},
				b'E' | b'O' | b'^' | b'#' | b'_' | b'-' | b'0'..=b'9' => continue,
				_ => libc_strftime(locale, &fmt[start..i], tm, &mut out),
			}
			break;
		}
	}
	out
}

/// How C `strtoul(s, &end, 10)` read `s`.
enum Strtoul {
	/// The value and whether text followed it.
	Ok(u64, bool),
	/// `EINVAL`: no digits.
	Invalid,
	/// `ERANGE`.
	Range,
}

/// C (BSD) `strtoul(s, &end, 10)`.
fn strtoul(s: &[u8]) -> Strtoul {
	let s = s.trim_start_with(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '\x0c' | '\r'));
	let (neg, s) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = s.iter().take_while(|c| c.is_ascii_digit()).count();
	if n == 0 {
		return Strtoul::Invalid;
	}
	let mut v: u64 = 0;
	for &c in &s[..n] {
		match v
			.checked_mul(10)
			.and_then(|v| v.checked_add(u64::from(c - b'0')))
		{
			Some(x) => v = x,
			None => return Strtoul::Range,
		}
	}
	Strtoul::Ok(if neg { v.wrapping_neg() } else { v }, n < s.len())
}

/// zsh `zstrtol(s, &t, 10)`: the value, whether text followed it, and the
/// digit count it was truncated after (zsh warns).
fn zstrtol(s: &[u8]) -> (i64, bool, Option<usize>) {
	let s = s.trim_start_with(|c| c == ' ' || c == '\t');
	let (neg, s) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = s.iter().take_while(|c| c.is_ascii_digit()).count();
	let mut calc: u64 = 0;
	let mut trunc = None;
	for (i, &c) in s[..n].iter().enumerate() {
		if trunc.is_some() {
			continue;
		}
		let new = calc.wrapping_mul(10).wrapping_add(u64::from(c - b'0'));
		if new < calc {
			trunc = Some(i);
			continue;
		}
		calc = new;
	}
	if trunc.is_none() && (calc as i64) < 0 && (!neg || calc & !(1u64 << 63) != 0) {
		trunc = Some(n - 1);
		calc /= 10;
	}
	let v = calc as i64;
	(if neg { v.wrapping_neg() } else { v }, n < s.len(), trunc)
}

/// The value of `TZ` while `strftime` runs (zsh exports a non-empty one
/// to it), as the host's zone lookup takes it.
fn local_zone(ctx: &Ctx<'_, '_>, tz: Option<&BStr>, secs: i64) -> (i32, BString) {
	ctx.cx.host.tz_offset(tz, secs)
}

/// zsh `bin_strftime`.
pub fn strftime(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let tz = match zx(ctx, |ex| params::getsparam(ex, b"TZ"))? {
		Ok(tz) => tz.filter(|t| !t.is_empty()),
		Err(d) => return zerr(ctx, d),
	};
	let tz = tz.as_ref().map(|t| t.as_bstr());
	let scalar = ops.arg(b's').map(BString::from);
	if let Some(s) = &scalar
		&& !params::isident(s, params::wide_idents_ctx(ctx))
	{
		ctx.usage(format!("not an identifier: {}", s.as_bstr()));
		return done(1);
	}
	let Some(fmt) = args.first() else {
		ctx.usage("not enough arguments");
		return done(1);
	};
	if ops.isset(b'r') {
		let Some(input) = args.get(1) else {
			ctx.usage("timestring expected");
			return done(1);
		};
		return reverse(ctx, fmt, input, scalar.as_ref().map(|s| s.as_slice()), ops.isset(b'q'), tz);
	}
	let (secs, nsec) = match args.get(1) {
		None => {
			let now = ctx.cx.host.wall();
			(now.secs, i64::from(now.nanos))
		},
		Some(a) => {
			let secs = match strtoul(a) {
				Strtoul::Invalid => {
					ctx.usage(format!("{}: invalid argument", a.as_bstr()));
					return done(1);
				},
				Strtoul::Range => {
					ctx.usage(format!("{}: result too large", a.as_bstr()));
					return done(1);
				},
				Strtoul::Ok(_, true) => {
					ctx.usage(format!("{}: invalid decimal number", a.as_bstr()));
					return done(1);
				},
				Strtoul::Ok(v, false) => v as i64,
			};
			let nsec = if let Some(n) = args.get(2) {
				let (v, rest, trunc) = zstrtol(n);
				if let Some(d) = trunc {
					let digits = n.trim_start_with(|c| c == ' ' || c == '\t');
					let digits = digits
						.strip_prefix(b"-")
						.or_else(|| digits.strip_prefix(b"+"))
						.unwrap_or(digits);
					ctx.diag(Diag::Warning {
						msg: format!("number truncated after {d} digits: {}", digits.as_bstr()).into(),
					});
					// zsh then reports the `errno` the warning's output left.
					ctx.usage(format!("{}: inappropriate ioctl for device", n.as_bstr()));
					return done(1);
				}
				if n.is_empty() || rest {
					ctx.usage(format!("{}: invalid decimal number", n.as_bstr()));
					return done(1);
				}
				if !(0..=999_999_999).contains(&v) {
					ctx.usage(format!("{}: invalid nanosecond value", n.as_bstr()));
					return done(1);
				}
				v
			} else {
				0
			};
			(secs, nsec)
		},
	};
	let (off, abbr) = local_zone(ctx, tz, secs);
	let Some(tm) = Tm::new(secs, off, abbr) else {
		let a = args.get(1).map_or_else(BString::default, Clone::clone);
		ctx.usage(format!("{}: unable to convert to time", a.as_bstr()));
		return done(1);
	};
	let locale = match zx(ctx, |ex| {
		super::zsh_mod_langinfo::locale_name(ex, crate::sys::langinfo::Category::Time)
	})? {
		Ok(l) => l,
		Err(d) => return zerr(ctx, d),
	};
	let mut out = ztrftime(fmt, &tm, nsec, &locale);
	if let Some(name) = scalar {
		if let Err(d) = zx(ctx, |ex| params::assignsparam(ex, &name, &out, 0))? {
			return zerr(ctx, d);
		}
		return done(0);
	}
	if !ops.isset(b'n') {
		out.push(b'\n');
	}
	ctx.out(&out);
	done(0)
}

/// zsh `reverse_strftime`: `strptime` then `mktime`.
fn reverse(
	ctx: &mut Ctx<'_, '_>,
	fmt: &[u8],
	input: &[u8],
	scalar: Option<&[u8]>,
	quiet: bool,
	tz: Option<&BStr>,
) -> R {
	let locale = match zx(ctx, |ex| {
		super::zsh_mod_langinfo::locale_name(ex, crate::sys::langinfo::Category::Time)
	})? {
		Ok(l) => l,
		Err(d) => return zerr(ctx, d),
	};
	let parsed = if matches!(locale.as_slice(), b"" | b"C" | b"POSIX") {
		// zsh's `tzname` pair: the zone's names in January and July.
		let names = [local_zone(ctx, tz, 946_684_800).1, local_zone(ctx, tz, 962_409_600).1];
		let mut p = Strptime { tm: Fields::default(), gmt: false, names: &names };
		match p.parse(input, fmt, 0) {
			Some(used) if p.tm.fixup() => Some((p.tm, p.gmt, used)),
			_ => None,
		}
	} else {
		// Another locale's names and formats: the C library's own
		// `strptime` (its date fixups included).
		match crate::sys::langinfo::strptime(&locale, fmt, input) {
			None => {
				ctx.diag(Diag::Unsupported {
					what: format!("strftime -r in locale `{}' on this platform", locale.as_bstr())
						.into(),
				});
				return done(1);
			},
			Some(crate::sys::langinfo::Parse::NoMatch) => None,
			Some(crate::sys::langinfo::Parse::Matched(t, used)) => {
				let tm = Fields {
					year:     i64::from(t.year),
					mon:      i64::from(t.mon),
					mday:     Some(i64::from(t.mday)),
					hour:     i64::from(t.hour),
					min:      i64::from(t.min),
					sec:      i64::from(t.sec),
					wday:     Some(i64::from(t.wday)),
					yday:     Some(i64::from(t.yday)),
					has_year: true,
					has_mon:  true,
					week:     None,
				};
				Some((tm, false, used))
			},
		}
	};
	let Some((tm, gmt, used)) = parsed else {
		if !quiet {
			ctx.usage("format not matched");
		}
		return done(1);
	};
	let t = match tm.mktime() {
		None => -1,
		Some(l) if gmt => l,
		Some(l) => {
			let (o1, _) = local_zone(ctx, tz, l);
			let (o2, _) = local_zone(ctx, tz, l - i64::from(o1));
			l - i64::from(o2)
		},
	};
	let text = t.to_string();
	if let Some(name) = scalar {
		// zsh `setiparam`: a new parameter gets no explicit base.
		let r =
			zx(ctx, |ex| params::setnparam(ex, name, Number::Int(t), text.as_bytes(), 0).map(|_| ()))?;
		if let Err(d) = r {
			return zerr(ctx, d);
		}
	} else {
		ctx.out(format!("{text}\n").as_bytes());
	}
	if used < input.len() && !quiet {
		ctx.usage("warning: input string not completely matched");
	}
	done(0)
}

/// The fields `strptime` fills (C `struct tm` plus its flags).
#[derive(Default)]
struct Fields {
	/// `tm_year`.
	year:     i64,
	/// 0–11.
	mon:      i64,
	mday:     Option<i64>,
	hour:     i64,
	min:      i64,
	sec:      i64,
	wday:     Option<i64>,
	yday:     Option<i64>,
	has_year: bool,
	has_mon:  bool,
	/// `%U`/`%W`: the first day of the week and the week number.
	week:     Option<(i64, i64)>,
}

impl Fields {
	/// The final date fixups of `strptime` (the date of a week number, of
	/// a day of the year); `false`: no such date (`strptime` fails).
	fn fixup(&mut self) -> bool {
		let start =
			|y: i64, m: i64| days_from_civil(y + 1900, m + 1, 1) - days_from_civil(y + 1900, 1, 1);
		if self.yday.is_none()
			&& self.has_year
			&& !(self.has_mon && self.mday.is_some())
			&& let Some((day_offset, week)) = self.week
		{
			let y = self.year + 1900;
			let fwo = (days_from_civil(y, 1, 1) + 4).rem_euclid(7);
			let tmpwday = self.wday.unwrap_or(day_offset);
			let tmpyday = (7 - fwo + day_offset) % 7 + (week - 1) * 7 + (tmpwday - day_offset + 7) % 7;
			if tmpyday < 0 {
				return false;
			}
			self.yday = Some(tmpyday);
		}
		if self.has_year
			&& let Some(yday) = self.yday
		{
			if !self.has_mon {
				let mut m = 0;
				while m < 11 && yday >= start(self.year, m + 1) {
					m += 1;
				}
				self.mon = m;
				self.has_mon = true;
			}
			if self.mday.is_none() {
				self.mday = Some(yday - start(self.year, self.mon) + 1);
			}
		}
		true
	}

	/// C `mktime`'s normalisation: seconds since the epoch of the fields
	/// read as UTC, `None` when the year comes out before 1900 (the BSD
	/// `mktime` fails).
	fn mktime(&self) -> Option<i64> {
		let months = (self.year + 1900) * 12 + self.mon;
		let days = days_from_civil(months.div_euclid(12), months.rem_euclid(12) + 1, 1)
			+ self.mday.unwrap_or(1)
			- 1;
		let secs = days * 86_400 + self.hour * 3600 + self.min * 60 + self.sec;
		(civil_from_days(secs.div_euclid(86_400)).0 >= 1900).then_some(secs)
	}
}

/// A `strptime` run (BSD libc, C locale).
struct Strptime<'n> {
	tm:    Fields,
	/// The input named a UTC instant (`%s`, `%z`, `%Z` of `GMT`/`UTC`).
	gmt:   bool,
	names: &'n [BString; 2],
}

/// Up to `len` digits of `b` at `*i` (at least one).
fn digits(b: &[u8], i: &mut usize, len: usize) -> Option<i64> {
	if !b.get(*i).is_some_and(u8::is_ascii_digit) {
		return None;
	}
	let mut v = 0i64;
	let mut n = 0;
	while n < len && b.get(*i).is_some_and(u8::is_ascii_digit) {
		v = v * 10 + i64::from(b[*i] - b'0');
		*i += 1;
		n += 1;
	}
	Some(v)
}

/// Whether `b` at `i` starts with `name`, ignoring case.
fn has_name(b: &[u8], i: usize, name: &[u8]) -> bool {
	b.get(i..i + name.len())
		.is_some_and(|s| s.eq_ignore_ascii_case(name))
}

impl Strptime<'_> {
	/// Match `fmt` against `b` from `i`; the position after the match.
	fn parse(&mut self, b: &[u8], fmt: &[u8], mut i: usize) -> Option<usize> {
		let mut century: Option<i64> = None;
		let mut yy: Option<i64> = None;
		let mut f = 0;
		let space = |c: u8| c.is_ascii_whitespace() || c == b'\x0b';
		while f < fmt.len() {
			let c = fmt[f];
			f += 1;
			if c != b'%' {
				if space(c) {
					while b.get(i).is_some_and(|&x| space(x)) {
						i += 1;
					}
				} else if b.get(i) == Some(&c) {
					i += 1;
				} else {
					return None;
				}
				continue;
			}
			let mut c = *fmt.get(f)?;
			f += 1;
			while c == b'E' || c == b'O' {
				c = *fmt.get(f)?;
				f += 1;
			}
			match c {
				b'%' => {
					if b.get(i) != Some(&b'%') {
						return None;
					}
					i += 1;
				},
				b'c' => {
					i = self.parse(b, b"%a %b %e %H:%M:%S %Y", i)?;
				},
				b'D' => i = self.parse(b, b"%m/%d/%y", i)?,
				b'F' => i = self.parse(b, b"%Y-%m-%d", i)?,
				b'R' => i = self.parse(b, b"%H:%M", i)?,
				b'r' => i = self.parse(b, b"%I:%M:%S %p", i)?,
				b'T' | b'X' => i = self.parse(b, b"%H:%M:%S", i)?,
				b'x' => i = self.parse(b, b"%m/%d/%y", i)?,
				b'C' => {
					century = Some(digits(b, &mut i, 2)?);
					self.tm.has_year = true;
				},
				b'j' => {
					let v = digits(b, &mut i, 3)?;
					if !(1..=366).contains(&v) {
						return None;
					}
					self.tm.yday = Some(v - 1);
				},
				b'M' | b'S' => {
					if b.get(i).is_none_or(|&x| space(x)) {
						continue;
					}
					let v = digits(b, &mut i, 2)?;
					if c == b'M' {
						if v > 59 {
							return None;
						}
						self.tm.min = v;
					} else {
						if v > 60 {
							return None;
						}
						self.tm.sec = v;
					}
				},
				b'H' | b'I' | b'k' | b'l' => {
					let v = digits(b, &mut i, 2)?;
					if c == b'H' || c == b'k' {
						if v > 23 {
							return None;
						}
					} else if v == 0 || v > 12 {
						return None;
					}
					self.tm.hour = v;
				},
				b'p' => {
					if self.tm.hour > 12 {
						return None;
					}
					if has_name(b, i, b"AM") {
						if self.tm.hour == 12 {
							self.tm.hour = 0;
						}
					} else if has_name(b, i, b"PM") {
						if self.tm.hour != 12 {
							self.tm.hour += 12;
						}
					} else {
						return None;
					}
					i += 2;
				},
				b'A' | b'a' => {
					let (d, len) = DAYS.iter().enumerate().find_map(|(d, n)| {
						let n = n.as_bytes();
						if has_name(b, i, n) {
							Some((d, n.len()))
						} else if has_name(b, i, &n[..3]) {
							Some((d, 3))
						} else {
							None
						}
					})?;
					i += len;
					self.tm.wday = Some(d as i64);
				},
				b'U' | b'W' => {
					let v = digits(b, &mut i, 2)?;
					if v > 53 {
						return None;
					}
					self.tm.week = Some((i64::from(c == b'W'), v));
				},
				b'u' | b'w' => {
					let v = digits(b, &mut i, 1)?;
					if (c == b'u' && !(1..=7).contains(&v)) || (c == b'w' && v > 6) {
						return None;
					}
					self.tm.wday = Some(v % 7);
				},
				b'e' | b'd' => {
					if c == b'e' && b.get(i).is_some_and(|&x| space(x)) {
						i += 1;
					}
					let v = digits(b, &mut i, 2)?;
					if v > 31 {
						return None;
					}
					self.tm.mday = Some(v);
				},
				b'B' | b'b' | b'h' => {
					let full = MONTHS.iter().position(|n| has_name(b, i, n.as_bytes()));
					let (m, len) = match full {
						Some(m) => (m, MONTHS[m].len()),
						None => (
							MONTHS
								.iter()
								.position(|n| has_name(b, i, &n.as_bytes()[..3]))?,
							3,
						),
					};
					i += len;
					self.tm.mon = m as i64;
					self.tm.has_mon = true;
				},
				b'm' => {
					let v = digits(b, &mut i, 2)?;
					if !(1..=12).contains(&v) {
						return None;
					}
					self.tm.mon = v - 1;
					self.tm.has_mon = true;
				},
				b's' => {
					let rest = &b[i..];
					let lead = rest.iter().take_while(|&&x| space(x)).count();
					let body = &rest[lead..];
					let sign = usize::from(matches!(body.first(), Some(b'-' | b'+')));
					let n = body[sign..]
						.iter()
						.take_while(|x| x.is_ascii_digit())
						.count();
					let t: i64 = if n == 0 {
						0
					} else {
						i += lead + sign + n;
						body[..sign + n].to_str().ok()?.parse().ok()?
					};
					let tm = Tm::new(t, 0, BString::default())?;
					self.tm = Fields {
						year:     tm.year,
						mon:      tm.mon,
						mday:     Some(tm.mday),
						hour:     tm.hour,
						min:      tm.min,
						sec:      tm.sec,
						wday:     Some(tm.wday),
						yday:     Some(tm.yday),
						has_year: true,
						has_mon:  true,
						week:     None,
					};
					self.gmt = true;
				},
				b'Y' | b'y' => {
					if b.get(i).is_none_or(|&x| space(x)) {
						continue;
					}
					let v = digits(b, &mut i, if c == b'Y' { 4 } else { 2 })?;
					if c == b'Y' {
						self.tm.year = v - 1900;
						century = None;
						yy = None;
					} else {
						yy = Some(v);
					}
					self.tm.has_year = true;
				},
				b'Z' => {
					let n = b[i..].iter().take_while(|x| x.is_ascii_uppercase()).count();
					if n == 0 {
						return None;
					}
					{
						let z = &b[i..i + n];
						if z == b"GMT" || z == b"UTC" {
							self.gmt = true;
						} else if !self.names.iter().any(|t| t.as_slice() == z) {
							return None;
						}
						i += n;
					}
				},
				b'z' => {
					let sign = match b.get(i) {
						Some(b'+') => 1,
						Some(b'-') => -1,
						_ => return None,
					};
					i += 1;
					let mut v = 0i64;
					for _ in 0..4 {
						if !b.get(i).is_some_and(u8::is_ascii_digit) {
							return None;
						}
						v = v * 10 + i64::from(b[i] - b'0');
						i += 1;
					}
					self.tm.hour -= sign * (v / 100);
					self.tm.min -= sign * (v % 100);
					self.gmt = true;
				},
				b'n' | b't' => {
					while b.get(i).is_some_and(|&x| space(x)) {
						i += 1;
					}
				},
				_ => return None,
			}
		}
		match (century, yy) {
			(Some(c), Some(y)) => self.tm.year = c * 100 + y - 1900,
			(Some(c), None) => self.tm.year = c * 100 - 1900,
			(None, Some(y)) => self.tm.year = if y < 69 { y + 100 } else { y },
			(None, None) => {},
		}
		Some(i)
	}
}
