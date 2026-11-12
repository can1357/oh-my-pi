//! Numbers as jq 1.8.2 (built with decNumber) represents them.
//!
//! jq keeps a number literal (from a program, JSON input or `tonumber`) as a
//! decimal until arithmetic turns it into a double:
//!
//! * [`Num::Int`], [`Num::BigInt`] and [`Num::Dec`] are such literals.
//!   They print in decNumber's canonical form (`1e3` prints as `1E+3`),
//!   negate exactly (`jv_number_negate`) and compare exactly with each other
//!   (`jvp_number_cmp`).
//! * [`Num::Float`] is a double, as produced by arithmetic.
//!   It prints like jq's `jvp_dtoa_fmt`, NaN as `null` and infinities as
//!   the largest finite doubles.
//!
//! Any other operation uses the double value of a number (`jv_number_value`).
use super::Rc;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::cmp::Ordering;
use core::fmt::{self, Write};
use core::hash::{Hash, Hasher};
use num_bigint::BigInt;
use num_traits::{cast::ToPrimitive, Signed};

/// Number: a decimal literal or a double.
#[derive(Clone, Debug)]
pub enum Num {
    /// Machine-size integer literal
    Int(isize),
    /// Arbitrarily large integer literal
    BigInt(Rc<BigInt>),
    /// Floating-point number
    Float(f64),
    /// Decimal literal, in decNumber's canonical notation
    Dec(Rc<String>),
}

/// Largest exponent of jq's decimal context (`DEC_INIT_BASE`);
/// literals beyond it become infinite.
const DEC_EMAX: i64 = 999_999_999;

/// Significant digits a literal is rounded to before converting it to a
/// double (`DEC_NUMBER_DOUBLE_PRECISION`).
const DOUBLE_DIGITS: usize = 17;

/// A finite decimal: `(-1)^neg * digits * 10^exp`.
///
/// `digits` holds ASCII digits without leading zeros, `"0"` for zero.
#[derive(Clone, Debug)]
struct Dec {
    neg: bool,
    digits: Vec<u8>,
    exp: i64,
}

/// A parsed decimal literal.
enum Lit {
    Fin(Dec),
    Inf(bool),
    NaN,
}

impl Dec {
    fn is_zero(&self) -> bool {
        self.digits == b"0"
    }

    /// Exponent of the most significant digit.
    fn adjusted(&self) -> i64 {
        self.exp + self.digits.len() as i64 - 1
    }

    fn from_int(neg: bool, digits: String) -> Self {
        Self { neg, digits: digits.into_bytes(), exp: 0 }
    }

    /// Parse decNumber's numeric string syntax (`decNumberFromString`):
    /// `[sign] (digits [. [digits]] | . digits) [(e|E) [sign] digits]`,
    /// `Inf`, `Infinity` or `NaN`, case-insensitively for the latter.
    fn parse(s: &str) -> Option<Lit> {
        let b = s.as_bytes();
        let (neg, b) = match b.first() {
            Some(b'-') => (true, &b[1..]),
            Some(b'+') => (false, &b[1..]),
            _ => (false, b),
        };
        if b.eq_ignore_ascii_case(b"inf") || b.eq_ignore_ascii_case(b"infinity") {
            return Some(Lit::Inf(neg));
        }
        if b.eq_ignore_ascii_case(b"nan") {
            return Some(Lit::NaN);
        }
        let mut i = 0;
        let mut digits = Vec::new();
        let mut frac = 0i64;
        let mut seen_digit = false;
        let mut seen_dot = false;
        while i < b.len() {
            match b[i] {
                c @ b'0'..=b'9' => {
                    seen_digit = true;
                    if !(digits.is_empty() && c == b'0') {
                        digits.push(c);
                    }
                    if seen_dot {
                        frac += 1;
                    }
                }
                b'.' if !seen_dot => seen_dot = true,
                _ => break,
            }
            i += 1;
        }
        if !seen_digit {
            return None;
        }
        let mut exp = 0i64;
        if i < b.len() {
            if !matches!(b[i], b'e' | b'E') {
                return None;
            }
            i += 1;
            let eneg = match b.get(i) {
                Some(b'-') => {
                    i += 1;
                    true
                }
                Some(b'+') => {
                    i += 1;
                    false
                }
                _ => false,
            };
            if i >= b.len() {
                return None;
            }
            for &c in &b[i..] {
                if !c.is_ascii_digit() {
                    return None;
                }
                exp = exp.saturating_mul(10).saturating_add(i64::from(c - b'0'));
            }
            if eneg {
                exp = -exp;
            }
        }
        if digits.is_empty() {
            digits.push(b'0');
        }
        let dec = Dec { neg, digits, exp: exp.saturating_sub(frac) };
        if !dec.is_zero() && dec.adjusted() > DEC_EMAX {
            return Some(Lit::Inf(neg));
        }
        Some(Lit::Fin(dec))
    }

    /// Parse a literal known to be finite.
    fn parse_fin(s: &str) -> Self {
        match Self::parse(s) {
            Some(Lit::Fin(d)) => d,
            _ => Dec { neg: false, digits: b"0".to_vec(), exp: 0 },
        }
    }

    /// Write in decNumber's scientific notation (`decNumberToString`).
    fn write(&self, w: &mut impl Write) -> fmt::Result {
        let digits = core::str::from_utf8(&self.digits).unwrap_or("0");
        let n = digits.len() as i64;
        let adj = self.adjusted();
        if self.neg {
            w.write_char('-')?;
        }
        if self.exp <= 0 && adj >= -6 {
            if self.exp == 0 {
                return w.write_str(digits);
            }
            let point = n + self.exp;
            if point > 0 {
                let (int, frac) = digits.split_at(point as usize);
                write!(w, "{int}.{frac}")
            } else {
                w.write_str("0.")?;
                (0..-point).try_for_each(|_| w.write_char('0'))?;
                w.write_str(digits)
            }
        } else {
            let (first, rest) = digits.split_at(1);
            w.write_str(first)?;
            if !rest.is_empty() {
                write!(w, ".{rest}")?;
            }
            write!(w, "E{}{}", if adj >= 0 { "+" } else { "-" }, adj.unsigned_abs())
        }
    }

    fn to_canonical(&self) -> String {
        let mut s = String::new();
        self.write(&mut s).unwrap();
        s
    }

    /// The double nearest to the decimal rounded to 17 significant digits,
    /// as jq's `jvp_literal_number_to_double`.
    fn to_f64(&self) -> f64 {
        let sign = if self.neg { -1.0 } else { 1.0 };
        if self.is_zero() || self.adjusted() < -400 {
            return sign * 0.0;
        }
        if self.adjusted() > 400 {
            return sign * f64::INFINITY;
        }
        let mut digits = self.digits.clone();
        let mut exp = self.exp;
        if digits.len() > DOUBLE_DIGITS {
            let dropped = digits.split_off(DOUBLE_DIGITS);
            exp += dropped.len() as i64;
            let up = match dropped[0] {
                b'6'..=b'9' => true,
                b'5' => dropped[1..].iter().any(|&c| c != b'0') || digits[DOUBLE_DIGITS - 1] % 2 == 1,
                _ => false,
            };
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
        let mut s = String::with_capacity(digits.len() + 8);
        if self.neg {
            s.push('-');
        }
        s.push_str(core::str::from_utf8(&digits).unwrap_or("0"));
        write!(s, "e{exp}").unwrap();
        s.parse().unwrap_or(f64::NAN)
    }

    /// Compare two decimals exactly (`decNumberCompare`).
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.is_zero(), other.is_zero()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return if other.neg { Ordering::Greater } else { Ordering::Less },
            (false, true) => return if self.neg { Ordering::Less } else { Ordering::Greater },
            (false, false) => (),
        }
        if self.neg != other.neg {
            return if self.neg { Ordering::Less } else { Ordering::Greater };
        }
        let mag = self.adjusted().cmp(&other.adjusted()).then_with(|| {
            let len = self.digits.len().max(other.digits.len());
            let digit = |d: &[u8], i| d.get(i).copied().unwrap_or(b'0');
            (0..len)
                .map(|i| digit(&self.digits, i).cmp(&digit(&other.digits, i)))
                .find(|o| o.is_ne())
                .unwrap_or(Ordering::Equal)
        });
        if self.neg {
            mag.reverse()
        } else {
            mag
        }
    }
}

impl Num {
    /// Create a big integer.
    pub fn big_int(i: BigInt) -> Self {
        Self::BigInt(i.into())
    }

    /// Parse a number literal as jq does (`jv_number_with_literal`),
    /// keeping it exact.
    ///
    /// NaN yields a NaN double and infinite literals (also those with too
    /// large exponents) yield infinite doubles.
    /// Return `None` if `s` is not in decNumber's numeric syntax.
    pub fn try_from_str(s: &str) -> Option<Self> {
        Some(match Dec::parse(s)? {
            Lit::NaN => Self::Float(f64::NAN),
            Lit::Inf(neg) => Self::Float(if neg { f64::NEG_INFINITY } else { f64::INFINITY }),
            Lit::Fin(d) if d.exp == 0 && !(d.neg && d.is_zero()) => {
                let digits = core::str::from_utf8(&d.digits).unwrap_or("0");
                match digits.parse::<isize>() {
                    Ok(i) => Self::Int(if d.neg { -i } else { i }),
                    Err(_) => {
                        let i = digits.parse::<BigInt>().unwrap_or_default();
                        Self::big_int(if d.neg { -i } else { i })
                    }
                }
            }
            Lit::Fin(d) => Self::Dec(d.to_canonical().into()),
        })
    }

    /// Parse a number literal like [`Self::try_from_str`],
    /// yielding NaN if `s` is not a number.
    pub fn from_str(s: &str) -> Self {
        Self::try_from_str(s).unwrap_or(Self::Float(f64::NAN))
    }

    /// Convert from an integral type to a machine-sized or big integer.
    pub fn from_integral<T: Copy + TryInto<isize> + Into<BigInt>>(x: T) -> Self {
        x.try_into()
            .map_or_else(|_| Num::big_int(x.into()), Num::Int)
    }

    /// Try to parse an integer from a string with given radix.
    pub fn from_str_radix(i: &str, radix: u32) -> Option<Self> {
        let int = || isize::from_str_radix(i, radix).ok().map(Num::Int);
        let big = || bigint_from_str_radix(i, radix).map(Self::big_int);
        int().or_else(big)
    }

    /// Parse a decimal string to a [`Self::Float`], else return NaN.
    pub fn from_dec_str(n: &str) -> Self {
        Self::Float(Self::from_str(n).as_f64())
    }

    /// True if the number is a literal (kept as decimal by jq).
    fn is_literal(&self) -> bool {
        !matches!(self, Self::Float(_))
    }

    fn lit(&self) -> Option<Dec> {
        match self {
            Self::Int(i) => Some(Dec::from_int(*i < 0, i.unsigned_abs().to_string())),
            Self::BigInt(i) => Some(Dec::from_int(i.is_negative(), i.magnitude().to_string())),
            Self::Dec(s) => Some(Dec::parse_fin(s)),
            Self::Float(_) => None,
        }
    }

    /// True if the number is NaN.
    pub fn is_nan(&self) -> bool {
        matches!(self, Self::Float(f) if f.is_nan())
    }

    /// True if the value of the number is integral (`jv_is_integer`).
    pub(crate) fn is_int(&self) -> bool {
        match self {
            Self::Int(_) | Self::BigInt(_) => true,
            _ => {
                // `modf` yields a zero fraction for infinities
                let f = self.as_f64();
                f.is_infinite() || (f - trunc(f)).abs() < f64::EPSILON
            }
        }
    }

    /// If the value is an integer that fits into `isize`, return it.
    pub fn as_isize(&self) -> Option<isize> {
        match self {
            Self::Int(i) => Some(*i),
            Self::BigInt(i) => i.to_isize(),
            _ if self.is_int() => {
                let f = trunc(self.as_f64());
                (isize::MIN as f64 <= f && f < isize::MAX as f64).then_some(f as isize)
            }
            _ => None,
        }
    }

    /// The double value of the number (`jv_number_value`).
    pub fn as_f64(&self) -> f64 {
        match self {
            Self::Int(n) if n.unsigned_abs() < 100_000_000_000_000_000 => *n as f64,
            Self::Float(n) => *n,
            _ => self.lit().map_or(f64::NAN, |d| d.to_f64()),
        }
    }

    /// Absolute value, keeping literals exact (`jv_number_abs`).
    pub(crate) fn length(&self) -> Self {
        match self {
            Self::Int(i) => Self::from_integral(i.unsigned_abs()),
            Self::BigInt(i) => Self::big_int(i.abs()),
            Self::Dec(n) => match n.strip_prefix('-') {
                Some(pos) => Self::Dec(pos.to_string().into()),
                None => self.clone(),
            },
            Self::Float(f) => Self::Float(f.abs()),
        }
    }

    /// Order numbers as jq's `jvp_number_cmp` does, with NaN below any number:
    /// literals compare exactly with each other, all other pairs as doubles.
    pub(crate) fn total_cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Int(x), Self::Int(y)) => x.cmp(y),
            (Self::BigInt(x), Self::BigInt(y)) => x.cmp(y),
            (Self::Int(x), Self::BigInt(y)) => BigInt::from(*x).cmp(y),
            (Self::BigInt(x), Self::Int(y)) => (**x).cmp(&BigInt::from(*y)),
            (Self::Dec(x), Self::Dec(y)) if Rc::ptr_eq(x, y) => Ordering::Equal,
            (x, y) if x.is_literal() && y.is_literal() => {
                x.lit().unwrap().cmp(&y.lit().unwrap())
            }
            (x, y) => {
                let (x, y) = (x.as_f64(), y.as_f64());
                match (x.is_nan(), y.is_nan()) {
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => x.partial_cmp(&y).unwrap(),
                }
            }
        }
    }

    /// Order numbers as jq's `jv_cmp` does, where NaN is smaller than any
    /// number, even NaN.
    pub(crate) fn jq_cmp(&self, other: &Self) -> Ordering {
        if self.is_nan() {
            Ordering::Less
        } else {
            self.total_cmp(other)
        }
    }
}

/// Round towards zero (`f64::trunc` needs `std`).
fn trunc(f: f64) -> f64 {
    // doubles at least 2^52 in magnitude are integral
    if f.abs() < 4_503_599_627_370_496.0 {
        (f as i64) as f64
    } else {
        f
    }
}

// Do not use `BigInt::parse_bytes`, because it accepts arbitrary underscores between digits.
// https://github.com/rust-num/num-bigint/issues/340
fn bigint_from_str_radix(s: &str, radix: u32) -> Option<BigInt> {
    use num_bigint::Sign::{Minus, Plus};
    let f = |c, sign| s.strip_prefix(c).map(|s| (sign, s));
    let (sign, num) = f('-', Minus).or_else(|| f('+', Plus)).unwrap_or((Plus, s));
    biguint_from_str_radix(num, radix).map(|bu| BigInt::from_biguint(sign, bu))
}

fn biguint_from_str_radix(s: &str, radix: u32) -> Option<num_bigint::BigUint> {
    assert!((2..=36).contains(&radix));
    if s.is_empty() {
        return None;
    }

    // normalize all characters to plain digit values
    let digits = s.bytes().map(|b| {
        Some(match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'z' => b - b'a' + 10,
            b'A'..=b'Z' => b - b'A' + 10,
            _ => return None,
        })
        .filter(|d| *d < radix as u8)
    });
    num_bigint::BigUint::from_radix_be(&digits.collect::<Option<Vec<_>>>()?, radix)
}

impl core::ops::Neg for Num {
    type Output = Self;
    /// Negate, keeping literals exact (`jv_number_negate`):
    /// like decNumber's `0 - x`, a negated zero literal is a positive zero.
    fn neg(self) -> Self::Output {
        match self {
            Self::Int(x) => x.checked_neg().map_or_else(|| Self::big_int(-BigInt::from(x)), Self::Int),
            Self::BigInt(x) => Self::big_int(-&*x),
            Self::Float(x) => Self::Float(-x),
            Self::Dec(n) => match n.strip_prefix('-') {
                Some(pos) => Self::Dec(pos.to_string().into()),
                None if Dec::parse_fin(&n).is_zero() => Self::Dec(n),
                None => Self::Dec(alloc::format!("-{n}").into()),
            },
        }
    }
}

impl Hash for Num {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // numbers that are equal have equal doubles
        let f = self.as_f64();
        state.write_u8(0);
        if f == 0.0 {
            0.0f64.to_bits().hash(state)
        } else if !f.is_nan() {
            f.to_bits().hash(state)
        }
    }
}

#[test]
fn hash_nums() {
    use core::hash::BuildHasher;
    let h = |n| foldhash::fast::FixedState::with_seed(42).hash_one(n);

    assert_eq!(h(Num::Int(4096)), h(Num::big_int(4096.into())));
    assert_eq!(h(Num::Float(0.0)), h(Num::Int(0)));
    assert_eq!(h(Num::Float(3.0)), h(Num::from_str("3.0")));
    assert_ne!(h(Num::Float(0.2)), h(Num::Float(0.4)));
}

impl PartialEq for Num {
    /// Equality as jq's `jvp_number_equal`: NaN equals nothing.
    fn eq(&self, other: &Self) -> bool {
        !self.is_nan() && self.total_cmp(other) == Ordering::Equal
    }
}

impl Eq for Num {}

impl PartialOrd for Num {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Num {
    fn cmp(&self, other: &Self) -> Ordering {
        self.total_cmp(other)
    }
}

/// Write a double as jq's `jvp_dtoa_fmt`: the shortest digits that round-trip,
/// in exponential notation (`1e+17`, `1e-05`) if the decimal point is
/// more than 15 places after the digits or 4 or more places before them.
fn fmt_f64(x: f64, w: &mut impl Write) -> fmt::Result {
    if x.is_nan() {
        return w.write_str("null");
    }
    let x = x.clamp(-f64::MAX, f64::MAX);
    if x.is_sign_negative() {
        w.write_char('-')?;
    }
    if x == 0.0 {
        return w.write_char('0');
    }
    let mut buf = ryu::Buffer::new();
    let s = buf.format_finite(x.abs());
    let (mant, exp) = match s.split_once('e') {
        Some((m, e)) => (m, e.parse::<i32>().unwrap_or(0)),
        None => (s, 0),
    };
    let (int, frac) = mant.split_once('.').unwrap_or((mant, ""));
    let mut decpt = int.len() as i32 + exp;
    let all = int.bytes().chain(frac.bytes());
    let mut digits: Vec<u8> = Vec::with_capacity(20);
    for c in all {
        if digits.is_empty() && c == b'0' {
            decpt -= 1;
        } else {
            digits.push(c);
        }
    }
    while digits.last() == Some(&b'0') {
        digits.pop();
    }
    let digits = core::str::from_utf8(&digits).unwrap();
    let n = digits.len() as i32;
    if decpt <= -4 || decpt > n + 15 {
        let (first, rest) = digits.split_at(1);
        w.write_str(first)?;
        if !rest.is_empty() {
            write!(w, ".{rest}")?;
        }
        let e = decpt - 1;
        write!(w, "e{}{:02}", if e < 0 { '-' } else { '+' }, e.unsigned_abs())
    } else if decpt <= 0 {
        w.write_str("0.")?;
        (0..-decpt).try_for_each(|_| w.write_char('0'))?;
        w.write_str(digits)
    } else if decpt < n {
        let (int, frac) = digits.split_at(decpt as usize);
        write!(w, "{int}.{frac}")
    } else {
        w.write_str(digits)?;
        (0..decpt - n).try_for_each(|_| w.write_char('0'))
    }
}

impl fmt::Display for Num {
    /// Write the number as jq dumps it (`jv_dump_term`).
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Int(i) => write!(f, "{i}"),
            Self::BigInt(i) => write!(f, "{i}"),
            Self::Float(x) => fmt_f64(*x, f),
            Self::Dec(n) => match Dec::parse(n) {
                Some(Lit::Fin(d)) => d.write(f),
                Some(Lit::Inf(neg)) => fmt_f64(if neg { f64::MIN } else { f64::MAX }, f),
                _ => f.write_str("null"),
            },
        }
    }
}

#[test]
fn display_nums() {
    use alloc::format;
    let lit = |s| format!("{}", Num::from_str(s));
    assert_eq!(lit("1e3"), "1E+3");
    assert_eq!(lit("1.0"), "1.0");
    assert_eq!(lit("-0"), "-0");
    assert_eq!(lit("9E999999999"), "9E+999999999");
    assert_eq!(lit("0.000000001E-999999990"), "1E-999999999");
    assert_eq!(lit("1.5e-7"), "1.5E-7");
    assert_eq!(lit("0.000001"), "0.000001");
    assert_eq!(lit("123.456e5"), "1.23456E+7");
    assert_eq!(lit("1E+1000000000"), "1.7976931348623157e+308");
    let float = |x| format!("{}", Num::Float(x));
    assert_eq!(float(1e17), "1e+17");
    assert_eq!(float(1e16), "1e+16");
    assert_eq!(float(1e-5), "1e-05");
    assert_eq!(float(0.0001), "0.0001");
    assert_eq!(float(5.0), "5");
    assert_eq!(float(123456789012345680.0), "123456789012345680");
    assert_eq!(float(f64::NAN), "null");
    assert_eq!(float(f64::NEG_INFINITY), "-1.7976931348623157e+308");
}
