//! jq's date builtins (`src/builtin.c`: `f_strptime`, `f_mktime`,
//! `f_gmtime`, `f_localtime`, `f_strftime`, `f_strflocaltime`), with the
//! C library behaviour of jq's reference build (macOS, C locale) for
//! `timegm`, `strftime` and `strptime`.
use crate::{ValT, ValTx};
use alloc::boxed::Box;
use alloc::string::String;
use core::fmt::Write;
use jaq_core::native::{bome, v, Filter};
use jaq_core::{DataT, Error, RunPtr, ValR};

/// C's `struct tm`, with `year` holding `tm_year + 1900`.
#[derive(Clone, Default)]
struct Tm {
    year: i64,
    mon: i64,
    mday: i64,
    hour: i64,
    min: i64,
    sec: i64,
    wday: i64,
    yday: i64,
    gmtoff: i64,
    zone: String,
}

const DAY: i64 = 86400;
const WDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];

fn is_leap(y: i64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

/// Days since 1970-01-01 of the given proleptic Gregorian date (month 1-12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The date (year, month 1-12, day) of days since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `gmtime_r` shifted by `gmtoff`; `None` where the year does not fit `tm_year`.
fn gmtime(t: i64, gmtoff: i64, zone: &str) -> Option<Tm> {
    let t = t.checked_add(gmtoff)?;
    let days = t.div_euclid(DAY);
    let rem = t.rem_euclid(DAY);
    let (year, m, d) = civil_from_days(days);
    i32::try_from(year - 1900).ok()?;
    Some(Tm {
        year,
        mon: m - 1,
        mday: d,
        hour: rem / 3600,
        min: rem % 3600 / 60,
        sec: rem % 60,
        wday: (days + 4).rem_euclid(7),
        yday: days - days_from_civil(year, 1, 1),
        gmtoff,
        zone: zone.into(),
    })
}

/// Seconds since the epoch of `tm` read as UTC, normalising out-of-range fields.
fn naive_seconds(tm: &Tm) -> i64 {
    let y = tm.year + tm.mon.div_euclid(12);
    let m = tm.mon.rem_euclid(12);
    let days = days_from_civil(y, m + 1, 1) + tm.mday - 1;
    days * DAY + tm.hour * 3600 + tm.min * 60 + tm.sec
}

/// macOS `timegm`: normalises `tm` and returns its time, or -1 before 1900.
fn timegm(tm: &mut Tm) -> i64 {
    let t = naive_seconds(tm);
    match gmtime(t, 0, "UTC") {
        Some(norm) if norm.year >= 1900 => {
            *tm = norm;
            t
        }
        _ => -1,
    }
}

/// The UTC offset and zone abbreviation of the system time zone at `t`.
fn local_offset(t: i64) -> (i64, String) {
    use jiff::{tz::TimeZone, Timestamp};
    let tz = TimeZone::system();
    let ts = Timestamp::from_second(t).unwrap_or(if t < 0 { Timestamp::MIN } else { Timestamp::MAX });
    let info = tz.to_offset_info(ts);
    (info.offset().seconds().into(), info.abbreviation().into())
}

/// `localtime_r` in the system time zone.
fn localtime(t: i64) -> Option<Tm> {
    let (off, zone) = local_offset(t);
    gmtime(t, off, &zone)
}

/// macOS `mktime`: `tm` read as local time; normalises it and returns its
/// time, or fails with -1 before 1900, leaving the fields as they are
/// but the zone, which is then mostly the one of 1901-12-13.
fn mktime(tm: &mut Tm) -> i64 {
    let naive = naive_seconds(tm);
    let guess = naive - local_offset(naive).0;
    let t = naive - local_offset(guess).0;
    match localtime(t) {
        Some(norm) if norm.year >= 1900 => {
            *tm = norm;
            t
        }
        _ => {
            (tm.gmtoff, tm.zone) = local_offset(i32::MIN.into());
            -1
        }
    }
}

/// jq's `tm2jv`.
fn tm2jv<V: ValT>(tm: &Tm, fsecs: f64) -> V {
    let int = |n: i64| V::from(n as f64);
    let sec = tm.sec as f64 + (fsecs - libm::floor(fsecs));
    let sec = if fsecs.fract() == 0.0 { int(tm.sec) } else { V::from(sec) };
    [int(tm.year), int(tm.mon), int(tm.mday), int(tm.hour), int(tm.min), sec, int(tm.wday), int(tm.yday)]
        .into_iter()
        .collect()
}

/// jq's `jv2tm`; `None` if a field is not a number.
fn jv2tm<V: ValT>(a: &V, local: bool) -> Option<Tm> {
    let xs = a.clone().elements().ok()?;
    let mut f = [0i64; 8];
    for (i, x) in xs.iter().take(8).enumerate() {
        let d = x.as_f64().filter(|d| !d.is_nan())?;
        let d = if i == 0 { d - 1900.0 } else { d };
        f[i] = (d as i32).into();
    }
    let [year, mon, mday, hour, min, sec, wday, yday] = f;
    let mut tm = Tm { year: year + 1900, mon, mday, hour, min, sec, wday, yday, ..Tm::default() };
    if local {
        mktime(&mut tm);
    } else {
        timegm(&mut tm);
        tm.zone = "UTC".into();
    }
    Some(tm)
}

fn fsecs_to_time(fsecs: f64) -> i64 {
    // C converts the double to `time_t` by truncation
    fsecs as i64
}

fn f_gmtime<V: ValT>(v: &V, local: bool) -> ValR<V> {
    let msg = if local { "localtime() requires numeric inputs" } else { "gmtime() requires numeric inputs" };
    let fsecs = v.as_f64().ok_or_else(|| Error::str(msg))?;
    let t = fsecs_to_time(fsecs);
    let tm = if local { localtime(t) } else { gmtime(t, 0, "UTC") };
    let tm = tm.ok_or_else(|| Error::str("error converting number of seconds since epoch to datetime"))?;
    Ok(tm2jv(&tm, fsecs))
}

fn f_mktime<V: ValT>(v: &V) -> ValR<V> {
    if v.clone().elements().is_err() {
        return Err(Error::str("mktime requires array inputs"));
    }
    let mut tm = jv2tm(v, false).ok_or_else(|| Error::str("mktime requires parsed datetime inputs"))?;
    match timegm(&mut tm) {
        -1 => Err(Error::str("invalid gmtime representation")),
        t => Ok(V::from(t as f64)),
    }
}

fn f_strftime<V: ValT>(a: &V, b: &V, local: bool) -> ValR<V> {
    let name = if local { "strflocaltime/1" } else { "strftime/1" };
    let a = if a.as_f64().is_some() {
        f_gmtime(a, local)?
    } else if a.clone().elements().is_err() {
        return Err(Error::str(alloc::format!("{name} requires parsed datetime inputs")));
    } else {
        a.clone()
    };
    let fmt = b.str().ok_or_else(|| Error::str(alloc::format!("{name} requires a string format")))?;
    let tm = jv2tm(&a, local).ok_or_else(|| Error::str(alloc::format!("{name} requires parsed datetime inputs")))?;
    let mut out = String::new();
    strftime(&mut out, &fmt, &tm, local);
    // jq's buffer holds `strlen(fmt) + 100` bytes including the NUL;
    // C's `strftime` fails on a result that does not fit
    if (out.is_empty() || out.len() >= fmt.len() + 100) && !fmt.is_empty() {
        return Err(Error::str(alloc::format!("{name}: unknown system failure")));
    }
    Ok(V::from(out))
}

/// Padding of a numeric conversion: `None` for none, else the pad character.
fn pad(n: i64, width: usize, default: Option<char>, flag: Option<char>, out: &mut String) {
    let p = match flag {
        Some('-') => None,
        Some('_') => Some(' '),
        Some('0') => Some('0'),
        _ => default,
    };
    let digits = alloc::format!("{}", n.unsigned_abs());
    let len = digits.len() + usize::from(n < 0);
    if n < 0 && p == Some('0') {
        out.push('-');
    }
    if let Some(p) = p {
        for _ in len..width {
            out.push(p);
        }
    }
    if n < 0 && p != Some('0') {
        out.push('-');
    }
    out.push_str(&digits);
}

/// tzcode's `_yconv`: the century and/or the year in the century.
fn yconv(year: i64, top: bool, yy: bool, flag: Option<char>, out: &mut String) {
    let (a, b) = (year - 1900, 1900);
    let mut lead = a / 100 + b / 100;
    let mut trail = a % 100 + b % 100;
    lead += trail / 100;
    trail %= 100;
    if trail < 0 && lead > 0 {
        trail += 100;
        lead -= 1;
    } else if lead < 0 && trail > 0 {
        trail -= 100;
        lead += 1;
    }
    if top {
        if lead == 0 && trail < 0 {
            out.push_str("-0");
        } else {
            pad(lead, 2, Some('0'), flag, out);
        }
    }
    if yy {
        pad(trail.abs(), 2, Some('0'), flag, out);
    }
}

/// ISO 8601 week-based year and week number, as tzcode's `strftime`.
fn iso_week(tm: &Tm) -> (i64, i64) {
    let mut year = tm.year;
    let mut yday = tm.yday;
    let wday = tm.wday;
    loop {
        let len = if is_leap(year) { 366 } else { 365 };
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
        yday += if is_leap(year) { 366 } else { 365 };
    }
}

fn name(names: &[&'static str], i: i64, abbrev: bool) -> &'static str {
    match usize::try_from(i).ok().and_then(|i| names.get(i)) {
        Some(n) if abbrev => &n[..3],
        Some(n) => n,
        None => "?",
    }
}

/// macOS (tzcode) `strftime` in the C locale.
fn strftime(out: &mut String, fmt: &str, tm: &Tm, local: bool) {
    let mut chars = fmt.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut flag = None;
        let mut c = chars.next();
        loop {
            match c {
                Some(f @ ('-' | '_' | '0')) => flag = Some(f),
                Some('E' | 'O') => {}
                _ => break,
            }
            c = chars.next();
        }
        let n = |n: i64, w: usize, out: &mut String| pad(n, w, Some('0'), flag, out);
        let sp = |n: i64, w: usize, out: &mut String| pad(n, w, Some(' '), flag, out);
        let hour12 = if tm.hour % 12 == 0 { 12 } else { tm.hour % 12 };
        let sub = |f: &str, out: &mut String| strftime(out, f, tm, local);
        match c {
            None => out.push('%'),
            Some('A') => out.push_str(name(&WDAYS, tm.wday, false)),
            Some('a') => out.push_str(name(&WDAYS, tm.wday, true)),
            Some('B') => out.push_str(name(&MONTHS, tm.mon, false)),
            Some('b' | 'h') => out.push_str(name(&MONTHS, tm.mon, true)),
            Some('C') => yconv(tm.year, true, false, flag, out),
            Some('c') => sub("%a %b %e %H:%M:%S %Y", out),
            Some('D') => sub("%m/%d/%y", out),
            Some('d') => n(tm.mday, 2, out),
            Some('e') => sp(tm.mday, 2, out),
            Some('F') => sub("%Y-%m-%d", out),
            Some('G') => yconv(iso_week(tm).0, true, true, flag, out),
            Some('g') => yconv(iso_week(tm).0, false, true, flag, out),
            Some('H') => n(tm.hour, 2, out),
            Some('I') => n(hour12, 2, out),
            Some('j') => n(tm.yday + 1, 3, out),
            Some('k') => sp(tm.hour, 2, out),
            Some('l') => sp(hour12, 2, out),
            Some('M') => n(tm.min, 2, out),
            Some('m') => n(tm.mon + 1, 2, out),
            Some('n') => out.push('\n'),
            Some('p') => out.push_str(if tm.hour >= 12 { "PM" } else { "AM" }),
            Some('R') => sub("%H:%M", out),
            Some('r') => sub("%I:%M:%S %p", out),
            Some('S') => n(tm.sec, 2, out),
            Some('s') => {
                let mut tm = tm.clone();
                let t = if local { mktime(&mut tm) } else { timegm(&mut tm) };
                let _ = write!(out, "{t}");
            }
            Some('T') => sub("%H:%M:%S", out),
            Some('t') => out.push('\t'),
            Some('U') => n((tm.yday + 7 - tm.wday) / 7, 2, out),
            Some('u') => out.push_str(&alloc::format!("{}", if tm.wday == 0 { 7 } else { tm.wday })),
            Some('V') => n(iso_week(tm).1, 2, out),
            Some('v') => sub("%e-%b-%Y", out),
            Some('W') => {
                let wday = if tm.wday != 0 { tm.wday - 1 } else { 6 };
                n((tm.yday + 7 - wday) / 7, 2, out)
            }
            Some('w') => {
                let _ = write!(out, "{}", tm.wday);
            }
            Some('X') => sub("%H:%M:%S", out),
            Some('x') => sub("%m/%d/%y", out),
            Some('Y') => yconv(tm.year, true, true, flag, out),
            Some('y') => yconv(tm.year, false, true, flag, out),
            Some('Z') => out.push_str(&tm.zone),
            Some('z') => {
                let off = tm.gmtoff;
                out.push(if off < 0 { '-' } else { '+' });
                let off = off.abs() / 60;
                let _ = write!(out, "{:02}{:02}", off / 60, off % 60);
            }
            Some('+') => sub("%a %b %e %H:%M:%S %Z %Y", out),
            Some(c) => out.push(c),
        }
    }
}

/// Parse up to `len` digits; at least one is required.
fn digits(s: &mut &[u8], len: usize) -> Option<i64> {
    let n = s.iter().take(len).take_while(|c| c.is_ascii_digit()).count();
    if n == 0 {
        return None;
    }
    let v = s[..n].iter().fold(0i64, |acc, c| acc * 10 + i64::from(c - b'0'));
    *s = &s[n..];
    Some(v)
}

fn ranged(s: &mut &[u8], len: usize, lo: i64, hi: i64) -> Option<i64> {
    digits(s, len).filter(|v| (lo..=hi).contains(v))
}

/// An optional sign and digits, `len` characters at most; no digits required.
fn signed(s: &mut &[u8], len: usize) -> Option<i64> {
    let sign = match s.first() {
        Some(b'-') => -1,
        Some(b'+') => 1,
        Some(c) if c.is_ascii_digit() => {
            return digits(s, len);
        }
        _ => return None,
    };
    *s = &s[1..];
    Some(sign * digits(s, len - 1).unwrap_or(0))
}

/// C's `strtol` in base 10: whitespace, sign, digits; nothing parsed is 0.
fn strtol(s: &mut &[u8]) -> Option<i64> {
    let mut t = *s;
    while t.first().is_some_and(u8::is_ascii_whitespace) {
        t = &t[1..];
    }
    let neg = t.first() == Some(&b'-');
    if matches!(t.first(), Some(b'-' | b'+')) {
        t = &t[1..];
    }
    let n = t.iter().take_while(|c| c.is_ascii_digit()).count();
    if n == 0 {
        return Some(0);
    }
    let mut v: i64 = 0;
    for c in &t[..n] {
        v = v.checked_mul(10)?.checked_add(i64::from(c - b'0'))?;
    }
    *s = &t[n..];
    Some(if neg { -v } else { v })
}

/// Match one of `names` (full or 3-letter abbreviation), case-insensitively.
fn names(s: &mut &[u8], names: &[&str]) -> Option<i64> {
    for (i, n) in names.iter().enumerate() {
        for cand in [n.as_bytes(), &n.as_bytes()[..3]] {
            if s.len() >= cand.len() && s[..cand.len()].eq_ignore_ascii_case(cand) {
                *s = &s[cand.len()..];
                return Some(i as i64);
            }
        }
    }
    None
}

/// The standard and daylight-saving abbreviations of the system time zone (C's `tzname`).
fn tznames() -> (String, String) {
    use jiff::{tz::TimeZone, Timestamp};
    let tz = TimeZone::system();
    let now = Timestamp::now().as_second();
    let year = 365 * DAY;
    let (mut std, mut dst) = (None, None);
    for t in [now - year / 2, now, now + year / 4, now + year / 2] {
        let info = tz.to_offset_info(Timestamp::from_second(t).unwrap_or(Timestamp::UNIX_EPOCH));
        let slot = if info.dst().is_dst() { &mut dst } else { &mut std };
        slot.get_or_insert_with(|| String::from(info.abbreviation()));
    }
    let std = std.unwrap_or_else(|| "UTC".into());
    let dst = dst.unwrap_or_else(|| std.clone());
    (std, dst)
}

/// What `%U`/`%W`, `%C`, `%y` and `%Y` parsed, and which fields were set.
#[derive(Default)]
struct Parsed {
    gmt: bool,
    century: Option<i64>,
    yy: Option<i64>,
    year: bool,
    month: bool,
    mday: bool,
    yday: bool,
    wday: bool,
    week: Option<(i64, i64)>,
}

fn skip_space(s: &mut &[u8]) {
    while s.first().is_some_and(u8::is_ascii_whitespace) {
        *s = &s[1..];
    }
}

/// macOS's (FreeBSD's) `_strptime` in the C locale.
fn strptime_inner(s: &mut &[u8], fmt: &[u8], tm: &mut Tm, p: &mut Parsed) -> Option<()> {
    let mut f = fmt;
    while let Some((&c, rest)) = f.split_first() {
        f = rest;
        if c != b'%' {
            if c.is_ascii_whitespace() {
                skip_space(s);
            } else {
                let (&b, rest) = s.split_first()?;
                if b != c {
                    return None;
                }
                *s = rest;
            }
            continue;
        }
        let mut c = *f.first()?;
        f = &f[1..];
        while c == b'E' || c == b'O' {
            c = *f.first()?;
            f = &f[1..];
        }
        let blank = |s: &[u8]| s.first().is_none_or(u8::is_ascii_whitespace);
        match c {
            b'%' => {
                let (&b, rest) = s.split_first()?;
                if b != b'%' {
                    return None;
                }
                *s = rest;
            }
            b'+' => strptime_inner(s, b"%a %b %e %H:%M:%S %Z %Y", tm, p)?,
            b'c' => strptime_inner(s, b"%a %b %e %H:%M:%S %Y", tm, p)?,
            b'D' | b'x' => strptime_inner(s, b"%m/%d/%y", tm, p)?,
            b'F' => strptime_inner(s, b"%Y-%m-%d", tm, p)?,
            b'R' => strptime_inner(s, b"%H:%M", tm, p)?,
            b'r' => strptime_inner(s, b"%I:%M:%S %p", tm, p)?,
            b'T' | b'X' => strptime_inner(s, b"%H:%M:%S", tm, p)?,
            b'n' | b't' => {
                if blank(s) && !s.is_empty() {
                    skip_space(s);
                } else {
                    return None;
                }
            }
            b'C' => {
                p.century = Some(signed(s, 2)?);
                p.year = true;
            }
            b'Y' => {
                if !blank(s) {
                    tm.year = signed(s, 4)?;
                    (p.century, p.yy, p.year) = (None, None, true);
                }
            }
            b'y' => {
                if !blank(s) {
                    p.yy = Some(signed(s, 2)?);
                    p.year = true;
                }
            }
            b'm' => {
                tm.mon = ranged(s, 2, 1, 12)? - 1;
                p.month = true;
            }
            b'd' | b'e' => {
                // as macOS: `%e` may be preceded by two blanks, `%d` by one
                for _ in 0..if c == b'e' { 2 } else { 1 } {
                    if s.first().is_some_and(u8::is_ascii_whitespace) {
                        *s = &s[1..];
                    }
                }
                tm.mday = ranged(s, 2, 0, 31)?;
                p.mday = true;
            }
            b'j' => {
                tm.yday = ranged(s, 3, 1, 366)? - 1;
                p.yday = true;
            }
            b'H' | b'k' => tm.hour = ranged(s, 2, 0, 23)?,
            b'I' | b'l' => tm.hour = ranged(s, 2, 0, 12)?,
            b'M' => {
                if !blank(s) {
                    tm.min = ranged(s, 2, 0, 59)?;
                }
            }
            b'S' => {
                if !blank(s) {
                    tm.sec = ranged(s, 2, 0, 60)?;
                }
            }
            b'p' => {
                if tm.hour > 12 {
                    return None;
                }
                let pm = if s.len() >= 2 && s[..2].eq_ignore_ascii_case(b"AM") {
                    false
                } else if s.len() >= 2 && s[..2].eq_ignore_ascii_case(b"PM") {
                    true
                } else {
                    return None;
                };
                *s = &s[2..];
                if pm && tm.hour != 12 {
                    tm.hour += 12;
                } else if !pm && tm.hour == 12 {
                    tm.hour = 0;
                }
            }
            b'A' | b'a' => {
                tm.wday = names(s, &WDAYS)?;
                p.wday = true;
            }
            b'B' | b'b' | b'h' => {
                tm.mon = names(s, &MONTHS)?;
                p.month = true;
            }
            b'U' | b'W' => p.week = Some((ranged(s, 2, 0, 53)?, i64::from(c == b'W'))),
            b'V' => {
                ranged(s, 2, 1, 53)?;
            }
            b'w' => {
                tm.wday = ranged(s, 1, 0, 6)?;
                p.wday = true;
            }
            b'u' => {
                tm.wday = ranged(s, 1, 1, 7)? % 7;
                p.wday = true;
            }
            b's' => {
                *tm = gmtime(strtol(s)?, 0, "UTC")?;
                p.gmt = true;
                (p.year, p.month, p.mday, p.yday, p.wday) = (true, true, true, true, true);
                (p.century, p.yy) = (None, None);
            }
            b'Z' => {
                let n = s.iter().take_while(|c| c.is_ascii_uppercase()).count();
                let zone = &s[..n];
                if zone == b"GMT" {
                    p.gmt = true;
                } else {
                    let (std, dst) = tznames();
                    if n == 0 || (zone != std.as_bytes() && zone != dst.as_bytes()) {
                        return None;
                    }
                }
                *s = &s[n..];
            }
            b'z' => {
                let sign = match s.first() {
                    Some(b'+') => 1,
                    Some(b'-') => -1,
                    _ => return None,
                };
                *s = &s[1..];
                if s.len() < 4 || !s[..4].iter().all(u8::is_ascii_digit) {
                    return None;
                }
                let i = digits(s, 4)?;
                tm.hour -= sign * (i / 100);
                tm.min -= sign * (i % 100);
                p.gmt = true;
            }
            _ => return None,
        }
    }
    Some(())
}

/// FreeBSD's `first_wday_of`: the weekday of January 1 of `year`.
fn first_wday_of(year: i64) -> i64 {
    ((2 * (3 - (year / 100) % 4)) + (year % 100) + ((year % 100) / 4) + if is_leap(year) { 6 } else { 0 } + 1) % 7
}

/// The end of FreeBSD's `_strptime`: the year from `%C`/`%y`, and the date
/// from the day of the year or from the week.
fn strptime_finish(tm: &mut Tm, p: &Parsed) -> Option<()> {
    const START: [[i64; 13]; 2] = [
        [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
        [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366],
    ];
    if let Some(c) = p.century {
        tm.year = c * 100 + p.yy.unwrap_or(0);
    } else if let Some(yy) = p.yy {
        tm.year = yy + if yy < 69 { 2000 } else { 1900 };
    }
    let start = |year| &START[usize::from(is_leap(year))];
    let mut yday = p.yday;
    if !yday && p.year {
        if p.month && p.mday {
            tm.yday = start(tm.year)[tm.mon.clamp(0, 11) as usize] + tm.mday - 1;
            yday = true;
        } else if let Some((week, day_offset)) = p.week {
            let fwo = first_wday_of(tm.year);
            if week == 0 && fwo == day_offset {
                return None;
            }
            let wday = if p.wday { tm.wday } else { day_offset };
            let mut d = (7 - fwo + day_offset) % 7 + (week - 1) * 7 + (wday - day_offset + 7) % 7;
            if d < 0 {
                if p.wday {
                    return None;
                }
                d = 0;
            }
            tm.yday = d;
            yday = true;
        }
    }
    if p.year && yday {
        if !p.month {
            let mut i = start(tm.year).iter().take_while(|s| tm.yday >= **s).count() as i64;
            if i > 12 {
                i = 1;
                tm.yday -= start(tm.year)[12];
                tm.year += 1;
            }
            tm.mon = i - 1;
        }
        if !p.mday {
            tm.mday = tm.yday - start(tm.year)[tm.mon.clamp(0, 12) as usize] + 1;
        }
    }
    Some(())
}

/// jq's `set_tm_wday` (Gauss's algorithm, wrong for some dates as jq's is).
fn set_tm_wday(tm: &mut Tm) {
    let century = tm.year / 100;
    let mut year = tm.year % 100;
    if tm.mon < 2 {
        year -= 1;
    }
    let mut mon = tm.mon - 1;
    if mon < 1 {
        mon += 12;
    }
    let mut wday = (tm.mday + libm::floor(2.6 * mon as f64 - 0.2) as i64 + year
        + libm::floor(year as f64 / 4.0) as i64
        + libm::floor(century as f64 / 4.0) as i64
        - 2 * century)
        % 7;
    if wday < 0 {
        wday += 7;
    }
    tm.wday = wday;
}

/// jq's `set_tm_yday`.
fn set_tm_yday(tm: &mut Tm) {
    const D: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let mut mon = tm.mon;
    let leap_day = i64::from(tm.mon > 1 && is_leap(tm.year));
    if mon < 0 {
        mon = -mon;
    }
    if mon > 11 {
        mon %= 12;
    }
    tm.yday = D[mon as usize] + leap_day + tm.mday - 1;
}

fn f_strptime<V: ValT>(a: &V, b: &V) -> ValR<V> {
    let (Some(input), Some(fmt)) = (a.str(), b.str()) else {
        return Err(Error::str("strptime/1 requires string inputs and arguments"));
    };
    let fail = || Error::str(alloc::format!("date \"{input}\" does not match format \"{fmt}\""));
    let mut tm = Tm { year: 1900, ..Tm::default() };
    let mut p = Parsed::default();
    let mut s = input.as_bytes();
    strptime_inner(&mut s, fmt.as_bytes(), &mut tm, &mut p).ok_or_else(fail)?;
    strptime_finish(&mut tm, &p).ok_or_else(fail)?;
    if s.first().is_some_and(|c| !c.is_ascii_whitespace()) {
        return Err(fail());
    }
    if p.gmt {
        // as FreeBSD's `strptime_l`: a time in UTC becomes local time
        let t = timegm(&mut tm.clone());
        tm = localtime(t).ok_or_else(fail)?;
    }
    // as jq on macOS, where `strptime` leaves these fields unreliable
    set_tm_wday(&mut tm);
    set_tm_yday(&mut tm);
    let r: V = tm2jv(&tm, 0.0);
    Ok(if s.is_empty() {
        r
    } else {
        let mut xs = r.elements().unwrap_or_default();
        xs.push(V::from(crate::utf8_lossy(s)));
        xs.into_iter().collect()
    })
}

pub fn funs<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([
        ("mktime", v(0), |cv| bome(f_mktime(&cv.1))),
        ("gmtime", v(0), |cv| bome(f_gmtime(&cv.1, false))),
        ("localtime", v(0), |cv| bome(f_gmtime(&cv.1, true))),
        ("strftime", v(1), |mut cv| {
            let fmt = cv.0.pop_var();
            bome(f_strftime(&cv.1, &fmt, false))
        }),
        ("strflocaltime", v(1), |mut cv| {
            let fmt = cv.0.pop_var();
            bome(f_strftime(&cv.1, &fmt, true))
        }),
        ("strptime", v(1), |mut cv| {
            let fmt = cv.0.pop_var();
            bome(f_strptime(&cv.1, &fmt))
        }),
    ])
}
