//! Number literals as jq reads them: `jv_number_with_literal` (src/jv.c),
//! which parses with decNumber's `decNumberFromString` in jq's decimal context.
use crate::Num;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

/// Largest adjusted exponent of jq's decimal context (`DEC_INIT_BASE`).
const EMAX: i64 = 999_999_999;
/// Smallest exponent of a subnormal in jq's decimal context: `emin - digits + 1`,
/// where jq sets `digits` so that exponent differences fit an `int32`.
const ETINY: i64 = -999_999_999 - 147_483_648 + 1;

/// The number a literal denotes, or `None` where jq rejects it.
///
/// NaN (also signed, `sNaN`, or with an all-zero payload) gives NaN, and
/// `inf`/`infinity` (any case, signed) an infinite float, as jq does;
/// any other number keeps decNumber's canonical text (`decNumberToString`),
/// so that it prints like jq's literals.
pub fn number(lit: &[u8]) -> Option<Num> {
    let int = lit.strip_prefix(b"-").unwrap_or(lit);
    if matches!(int, [b'0'] | [b'1'..=b'9', ..]) && int.iter().all(u8::is_ascii_digit) {
        // a plain integer is its own canonical text
        return core::str::from_utf8(lit).ok().map(Num::from_str);
    }
    let (neg, body) = match lit.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, lit),
    };
    let mut digits: Vec<u8> = Vec::new();
    let mut dot = None;
    let mut i = 0;
    while let Some(&c) = body.get(i) {
        match c {
            b'0'..=b'9' => digits.push(c),
            b'.' if dot.is_none() => dot = Some(digits.len()),
            _ => break,
        }
        i += 1;
    }
    let rest = &body[i..];
    if digits.is_empty() {
        return if dot.is_some() { None } else { special(neg, rest) };
    }

    let mut exponent = if rest.is_empty() { 0 } else { exponent(rest)? };
    if let Some(dot) = dot {
        exponent -= (digits.len() - dot) as i64;
    }
    let zeros = digits.iter().take_while(|&&d| d == b'0').count().min(digits.len() - 1);
    digits.drain(..zeros);

    if digits == b"0" {
        exponent = exponent.clamp(ETINY, EMAX);
    } else if exponent + digits.len() as i64 - 1 > EMAX {
        let inf = if neg { f64::NEG_INFINITY } else { f64::INFINITY };
        return Some(Num::Float(inf));
    } else if exponent < ETINY {
        round_to(&mut digits, (ETINY - exponent) as u64);
        exponent = ETINY;
    }

    if !neg && exponent == 0 {
        // a plain integer's digits are already canonical (and ASCII)
        return core::str::from_utf8(&digits).ok().map(Num::from_str);
    }
    Some(Num::from_str(&to_string(neg, &digits, exponent)))
}

/// The exponent after `e`/`E` in a decimal literal, as decNumber reads it.
fn exponent(rest: &[u8]) -> Option<i64> {
    let (e, rest) = rest.split_first()?;
    if !matches!(e, b'e' | b'E') {
        return None;
    }
    let (neg, rest) = match rest.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, rest),
    };
    if rest.is_empty() || !rest.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let zeros = rest.iter().take_while(|&&d| d == b'0').count().min(rest.len() - 1);
    let sig = &rest[zeros..];
    // decNumber gives up on exponents of more than ten digits by making
    // them twice the largest one, which then overflows or underflows
    let value = if sig.len() > 10 || (sig.len() == 10 && sig[0] > b'1') {
        2 * EMAX
    } else {
        sig.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0'))
    };
    Some(if neg { -value } else { value })
}

/// Drop the `shift` least significant digits, rounding half to even.
fn round_to(digits: &mut Vec<u8>, shift: u64) {
    let len = digits.len() as u64;
    let (first_dropped, rest_nonzero) = if shift > len {
        (b'0', true)
    } else {
        let keep = (len - shift) as usize;
        let rest_nonzero = digits[keep + 1..].iter().any(|&d| d != b'0');
        (digits[keep], rest_nonzero)
    };
    digits.truncate(len.saturating_sub(shift) as usize);
    let odd = digits.last().is_some_and(|d| (d - b'0') % 2 == 1);
    let up = first_dropped > b'5' || (first_dropped == b'5' && (rest_nonzero || odd));
    if digits.is_empty() {
        digits.push(if up { b'1' } else { b'0' });
        return;
    }
    if up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
}

/// `inf`, `infinity` or NaN, as decNumber reads them after an optional sign.
fn special(neg: bool, rest: &[u8]) -> Option<Num> {
    if rest.eq_ignore_ascii_case(b"infinity") || rest.eq_ignore_ascii_case(b"inf") {
        let inf = if neg { f64::NEG_INFINITY } else { f64::INFINITY };
        return Some(Num::Float(inf));
    }
    let rest = match rest.split_first() {
        Some((b's' | b'S', rest)) => rest,
        _ => rest,
    };
    let payload = rest.get(..3).filter(|nan| nan.eq_ignore_ascii_case(b"nan")).map(|_| &rest[3..])?;
    // jq rejects NaN with a payload
    payload.iter().all(|&d| d == b'0').then_some(Num::Float(f64::NAN))
}

/// decNumber's scientific string of a finite number (`decToString`).
fn to_string(neg: bool, digits: &[u8], exponent: i64) -> String {
    let mut s = String::with_capacity(digits.len() + 16);
    if neg {
        s.push('-');
    }
    let digit = |d: &u8| char::from(*d);
    let len = digits.len() as i64;
    let adjusted = exponent + len - 1;
    if exponent <= 0 && adjusted >= -6 {
        if exponent == 0 {
            s.extend(digits.iter().map(digit));
        } else {
            let before = len + exponent;
            if before > 0 {
                let (int, frac) = digits.split_at(before as usize);
                s.extend(int.iter().map(digit));
                s.push('.');
                s.extend(frac.iter().map(digit));
            } else {
                s.push_str("0.");
                s.extend(core::iter::repeat('0').take((-before) as usize));
                s.extend(digits.iter().map(digit));
            }
        }
    } else {
        s.push(char::from(digits[0]));
        if digits.len() > 1 {
            s.push('.');
            s.extend(digits[1..].iter().map(digit));
        }
        s.push('E');
        s.push(if adjusted < 0 { '-' } else { '+' });
        let _ = write!(s, "{}", adjusted.unsigned_abs());
    }
    s
}
