//! C-locale `strftime` for `printf %(…)T`: glibc's conversions, its `_ - 0
//! ^ #` flags and field widths, `E`/`O` modifiers accepted and ignored, an
//! unknown conversion copied as written.

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

/// Broken-down local time.
struct Tm<'a> {
	secs:   i64,
	year:   i64,
	/// 1–12.
	month:  u32,
	/// 1–31.
	day:    u32,
	hour:   u32,
	min:    u32,
	sec:    u32,
	/// 0 = Sunday.
	wday:   u32,
	/// 0-based day of the year.
	yday:   u32,
	offset: i32,
	abbr:   &'a [u8],
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
const fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
	let y = if m <= 2 { y - 1 } else { y };
	let era = y.div_euclid(400);
	let yoe = y - era * 400;
	let mp = (m as i64 + 9) % 12;
	let doy = (153 * mp + 2) / 5 + d as i64 - 1;
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	era * 146_097 + doe - 719_468
}

/// The date of `days` since 1970-01-01: (year, month, day).
const fn civil_from_days(days: i64) -> (i64, u32, u32) {
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
	let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
	let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
	(y, m, d)
}

impl<'a> Tm<'a> {
	fn new(secs: i64, offset: i32, abbr: &'a [u8]) -> Self {
		let local = secs.saturating_add(i64::from(offset));
		let days = local.div_euclid(86_400);
		let sod = local.rem_euclid(86_400) as u32;
		let (year, month, day) = civil_from_days(days);
		Self {
			secs,
			year,
			month,
			day,
			hour: sod / 3600,
			min: sod / 60 % 60,
			sec: sod % 60,
			wday: (days + 4).rem_euclid(7) as u32,
			yday: (days - days_from_civil(year, 1, 1)) as u32,
			offset,
			abbr,
		}
	}

	/// ISO 8601 week-based year and week number.
	fn iso_week(&self) -> (i64, u32) {
		let wday_mon = (self.wday + 6) % 7;
		let week = (i64::from(self.yday) - i64::from(wday_mon) + 10) / 7;
		if week < 1 {
			return (self.year - 1, weeks_in_year(self.year - 1));
		}
		if week > i64::from(weeks_in_year(self.year)) {
			return (self.year + 1, 1);
		}
		(self.year, week as u32)
	}
}

const fn is_leap(y: i64) -> bool {
	y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

/// ISO weeks in year `y`: 53 when it starts on a Thursday, or on a
/// Wednesday in a leap year.
const fn weeks_in_year(y: i64) -> u32 {
	let jan1 = (days_from_civil(y, 1, 1) + 4).rem_euclid(7);
	if jan1 == 4 || (jan1 == 3 && is_leap(y)) {
		53
	} else {
		52
	}
}

/// `strftime(fmt)` at `secs` since the epoch in a zone `offset` seconds
/// east of UTC named `abbr`.
pub fn format(fmt: &[u8], secs: i64, offset: i32, abbr: &[u8]) -> Vec<u8> {
	let tm = Tm::new(secs, offset, abbr);
	let mut out = Vec::with_capacity(fmt.len() * 2);
	render(fmt, &tm, &mut out);
	out
}

/// How a conversion pads by default.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pad {
	Zero,
	Space,
	None,
}

fn render(fmt: &[u8], tm: &Tm<'_>, out: &mut Vec<u8>) {
	let mut i = 0;
	while i < fmt.len() {
		if fmt[i] != b'%' {
			out.push(fmt[i]);
			i += 1;
			continue;
		}
		let start = i;
		i += 1;
		let mut pad = None;
		let mut upper = false;
		let mut swap = false;
		while let Some(&f) = fmt.get(i) {
			match f {
				b'_' => pad = Some(Pad::Space),
				b'-' => pad = Some(Pad::None),
				b'0' => pad = Some(Pad::Zero),
				b'^' => upper = true,
				b'#' => swap = true,
				_ => break,
			}
			i += 1;
		}
		let wstart = i;
		while fmt.get(i).is_some_and(u8::is_ascii_digit) {
			i += 1;
		}
		let width = std::str::from_utf8(&fmt[wstart..i])
			.ok()
			.and_then(|w| w.parse::<usize>().ok());
		if matches!(fmt.get(i), Some(b'E' | b'O')) {
			i += 1;
		}
		let Some(&conv) = fmt.get(i) else {
			out.extend_from_slice(&fmt[start..]);
			return;
		};
		i += 1;
		let f = Field { pad, width, upper, swap };
		if !conversion(conv, tm, f, out) {
			out.extend_from_slice(&fmt[start..i]);
		}
	}
}

/// A conversion's flags and width.
#[derive(Clone, Copy)]
struct Field {
	pad:   Option<Pad>,
	width: Option<usize>,
	upper: bool,
	swap:  bool,
}

impl Field {
	fn num(self, out: &mut Vec<u8>, v: i64, digits: usize, default: Pad) {
		let pad = self.pad.unwrap_or(default);
		let text = v.unsigned_abs().to_string();
		let sign = if v < 0 { "-" } else { "" };
		let width = self.width.unwrap_or(digits);
		let fill = width.saturating_sub(text.len() + sign.len());
		match pad {
			Pad::Zero => {
				out.extend_from_slice(sign.as_bytes());
				out.resize(out.len() + fill, b'0');
			},
			Pad::Space => {
				out.resize(out.len() + fill, b' ');
				out.extend_from_slice(sign.as_bytes());
			},
			Pad::None => out.extend_from_slice(sign.as_bytes()),
		}
		out.extend_from_slice(text.as_bytes());
	}

	/// A text conversion; `swap_lower` is glibc's `#` direction for it.
	fn text(self, out: &mut Vec<u8>, s: &[u8], swap_lower: bool) {
		let s: Vec<u8> = if self.upper || (self.swap && !swap_lower) {
			s.to_ascii_uppercase()
		} else if self.swap {
			s.to_ascii_lowercase()
		} else {
			s.to_vec()
		};
		let fill = self.width.unwrap_or(0).saturating_sub(s.len());
		let c = if self.pad == Some(Pad::Zero) {
			b'0'
		} else {
			b' '
		};
		if self.pad != Some(Pad::None) {
			out.resize(out.len() + fill, c);
		}
		out.extend_from_slice(&s);
	}

	/// A composite conversion rendered from `fmt`.
	fn sub(self, out: &mut Vec<u8>, fmt: &[u8], tm: &Tm<'_>) {
		let mut s = Vec::new();
		render(fmt, tm, &mut s);
		self.text(out, &s, false);
	}
}

/// Render one conversion; `false` for an unknown one.
fn conversion(conv: u8, tm: &Tm<'_>, f: Field, out: &mut Vec<u8>) -> bool {
	let wday = tm.wday as usize;
	let month = tm.month as usize - 1;
	let hour12 = if tm.hour.is_multiple_of(12) {
		12
	} else {
		tm.hour % 12
	};
	match conv {
		b'a' => f.text(out, &DAYS[wday].as_bytes()[..3], false),
		b'A' => f.text(out, DAYS[wday].as_bytes(), false),
		b'b' | b'h' => f.text(out, &MONTHS[month].as_bytes()[..3], false),
		b'B' => f.text(out, MONTHS[month].as_bytes(), false),
		b'c' => f.sub(out, b"%a %b %e %H:%M:%S %Y", tm),
		b'C' => f.num(out, tm.year.div_euclid(100), 2, Pad::Zero),
		b'd' => f.num(out, i64::from(tm.day), 2, Pad::Zero),
		b'D' | b'x' => f.sub(out, b"%m/%d/%y", tm),
		b'e' => f.num(out, i64::from(tm.day), 2, Pad::Space),
		b'F' => f.sub(out, b"%Y-%m-%d", tm),
		b'g' => f.num(out, tm.iso_week().0.rem_euclid(100), 2, Pad::Zero),
		b'G' => f.num(out, tm.iso_week().0, 1, Pad::Zero),
		b'H' => f.num(out, i64::from(tm.hour), 2, Pad::Zero),
		b'I' => f.num(out, i64::from(hour12), 2, Pad::Zero),
		b'j' => f.num(out, i64::from(tm.yday) + 1, 3, Pad::Zero),
		b'k' => f.num(out, i64::from(tm.hour), 2, Pad::Space),
		b'l' => f.num(out, i64::from(hour12), 2, Pad::Space),
		b'm' => f.num(out, i64::from(tm.month), 2, Pad::Zero),
		b'M' => f.num(out, i64::from(tm.min), 2, Pad::Zero),
		b'n' => out.push(b'\n'),
		b'p' => f.text(out, if tm.hour < 12 { b"AM" } else { b"PM" }, true),
		b'P' => f.text(out, if tm.hour < 12 { b"am" } else { b"pm" }, false),
		b'r' => f.sub(out, b"%I:%M:%S %p", tm),
		b'R' => f.sub(out, b"%H:%M", tm),
		b's' => f.num(out, tm.secs, 1, Pad::Zero),
		b'S' => f.num(out, i64::from(tm.sec), 2, Pad::Zero),
		b't' => out.push(b'\t'),
		b'T' | b'X' => f.sub(out, b"%H:%M:%S", tm),
		b'u' => f.num(out, i64::from((tm.wday + 6) % 7 + 1), 1, Pad::Zero),
		b'U' => f.num(out, i64::from((tm.yday + 7 - tm.wday) / 7), 2, Pad::Zero),
		b'V' => f.num(out, i64::from(tm.iso_week().1), 2, Pad::Zero),
		b'w' => f.num(out, i64::from(tm.wday), 1, Pad::Zero),
		b'W' => f.num(out, i64::from((tm.yday + 7 - (tm.wday + 6) % 7) / 7), 2, Pad::Zero),
		b'y' => f.num(out, tm.year.rem_euclid(100), 2, Pad::Zero),
		b'Y' => f.num(out, tm.year, 1, Pad::Zero),
		b'z' => {
			let a = tm.offset.unsigned_abs();
			let s =
				format!("{}{:02}{:02}", if tm.offset < 0 { '-' } else { '+' }, a / 3600, a / 60 % 60);
			f.text(out, s.as_bytes(), false);
		},
		b'Z' => f.text(out, tm.abbr, true),
		b'%' => out.push(b'%'),
		_ => return false,
	}
	true
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fmt(f: &str, secs: i64, offset: i32, abbr: &str) -> String {
		String::from_utf8(format(f.as_bytes(), secs, offset, abbr.as_bytes())).unwrap()
	}

	// Goldens: bash 5.3.20 printf3.sub (TZ=EST5EDT,M3.2.0/2,M11.1.0/2,
	// 1275250155 is EDT, UTC-4) and glibc `printf "%(%Q|%P|%10Y|%#Z|%^a|%-d)T"`.
	#[test]
	fn conversions_match_the_c_locale() {
		let edt = |f: &str| fmt(f, 1_275_250_155, -4 * 3600, "EDT");
		assert_eq!(edt("%X"), "16:09:15");
		assert_eq!(edt("%e-%b-%Y %T"), "30-May-2010 16:09:15");
		assert_eq!(fmt("%x %X", 1_275_250_155 - 3600, -4 * 3600, "EDT"), "05/30/10 15:09:15");
		assert_eq!(edt("%F %r"), "2010-05-30 04:09:15 PM");
		assert_eq!(edt("%F %r %z"), "2010-05-30 04:09:15 PM -0400");
		assert_eq!(fmt("%F %r %z", 0, -5 * 3600, "EST"), "1969-12-31 07:00:00 PM -0500");
		assert_eq!(edt("%a %b %e %H:%M:%S %Z %Y"), "Sun May 30 16:09:15 EDT 2010");
		assert_eq!(edt("%x (foo) %X"), "05/30/10 (foo) 16:09:15");
		assert_eq!(edt("%s"), "1275250155");
		let cest = |f: &str| fmt(f, 1_275_250_155, 2 * 3600, "CEST");
		assert_eq!(cest("%Q|%P|%10Y|%#Z|%^a|%-d"), "%Q|pm|0000002010|cest|SUN|30");
		assert_eq!(
			cest("%k|%l|%C|%G|%V|%g|%j|%u|%w|%U|%W|%_m"),
			"22|10|20|2010|21|10|150|7|0|22|21| 5"
		);
	}

	#[test]
	fn iso_weeks_cross_year_boundaries() {
		// 2021-01-01 (Friday) is in ISO week 53 of 2020.
		assert_eq!(fmt("%G-%V", 1_609_459_200, 0, "UTC"), "2020-53");
		// 2018-12-31 (Monday) is in week 1 of 2019.
		assert_eq!(fmt("%G-%V", 1_546_214_400, 0, "UTC"), "2019-01");
	}
}
