//! Standard library for the jq language.
//!
//! The standard library provides a set of filters.
//! These filters are either implemented as definitions or as functions.
//! For example, the standard library provides the `map(f)` filter,
//! which is defined using the more elementary filter `[.[] | f]`.
//!
//! The definitions and natives follow jq 1.8.2:
//! the definitions are ported from jq's `src/builtin.jq`,
//! the natives mirror the C functions of jq's `src/builtin.c`,
//! including their error messages.
#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

extern crate alloc;
#[cfg(feature = "std")]
extern crate std;

pub mod input;
#[cfg(feature = "math")]
mod math;
#[cfg(feature = "regex")]
mod regex;
#[cfg(feature = "time")]
mod time;

use alloc::string::String;
use alloc::{boxed::Box, vec::Vec};
use jaq_core::box_iter::box_once;
use jaq_core::native::{bome, run, v, Filter, Fun};

use jaq_core::{load, DataT, Error, Exn, RunPtr, ValR, ValX};

/// Definitions of the standard library.
pub fn defs() -> impl Iterator<Item = load::parse::Def<&'static str>> {
    load::parse(include_str!("defs.jq"), |p| p.defs())
        .unwrap()
        .into_iter()
}

/// Named filters available by default
/// which are implemented as native filters, such as `sort`, `implode`, ...,
/// but also `now`, `strftime`, `test`, ...
///
/// This is the combination of [`base_funs`] and [`extra_funs`].
/// It does not include filters implemented by definition, such as `map`.
#[cfg(all(
    feature = "std",
    feature = "format",
    feature = "math",
    feature = "regex",
    feature = "time",
))]
pub fn funs<D: DataT>() -> impl Iterator<Item = Fun<D>>
where
    for<'a> D::V<'a>: ValT,
{
    base_funs().chain(extra_funs())
}

/// Minimal set of filters that are generic over the value type.
///
/// Does not return filters from the standard library, such as `map`.
pub fn base_funs<D: DataT>() -> impl Iterator<Item = Fun<D>>
where
    for<'a> D::V<'a>: ValT,
{
    base_run().into_vec().into_iter().map(run)
}

/// Supplementary set of filters that are generic over the value type.
#[cfg(all(
    feature = "std",
    feature = "format",
    feature = "math",
    feature = "regex",
    feature = "time",
))]
pub fn extra_funs<D: DataT>() -> impl Iterator<Item = Fun<D>>
where
    for<'a> D::V<'a>: ValT,
{
    [std(), format(), math::funs(), regex::funs(), time::funs()]
        .into_iter()
        .flat_map(|fs| fs.into_vec().into_iter().map(run))
}

/// Values that the standard library can operate on.
pub trait ValT: jaq_core::ValT + Ord + Default + From<f64> + From<usize> {
    /// Convert an array into a sequence.
    ///
    /// This returns the original value as `Err` if it is not an array.
    fn into_seq<S: FromIterator<Self>>(self) -> Result<S, Self>;

    /// True if the value is integer.
    fn is_int(&self) -> bool;

    /// Use the value as machine-sized integer.
    ///
    /// If this function returns `Some(_)`, then [`Self::is_int`] must return true.
    /// However, the other direction must not necessarily be the case, because
    /// there may be integer values that are not representable by `isize`.
    fn as_isize(&self) -> Option<isize>;

    /// Use the value as floating-point number.
    ///
    /// This succeeds for all numeric values,
    /// rounding too large/small ones to +/- Infinity.
    fn as_f64(&self) -> Option<f64>;

    /// True if the value is interpreted as UTF-8 string.
    fn is_utf8_str(&self) -> bool;

    /// If the value is a string (whatever its interpretation), return its bytes.
    fn as_bytes(&self) -> Option<&[u8]>;

    /// If the value is interpreted as UTF-8 string, return its bytes.
    fn as_utf8_bytes(&self) -> Option<&[u8]> {
        self.is_utf8_str().then(|| self.as_bytes()).flatten()
    }

    /// If the value is a string (whatever its interpretation), return its bytes, else fail.
    fn try_as_bytes(&self) -> Result<&[u8], Error<Self>> {
        self.as_bytes().ok_or_else(|| Error::typ(self.clone(), "string"))
    }

    /// If the value is interpreted as UTF-8 string, return its bytes, else fail.
    fn try_as_utf8_bytes(&self) -> Result<&[u8], Error<Self>> {
        self.as_utf8_bytes().ok_or_else(|| Error::typ(self.clone(), "string"))
    }

    /// jq's error about `self` used where it does not fit:
    /// `<kind> (<abbreviated value>) <msg>`, as jq's `type_error`.
    fn type_error(&self, msg: &str) -> Error<Self>;

    /// jq's error about `self` and `other` used together:
    /// `<kind> (<value>) and <kind> (<value>) <msg>`, as jq's `type_error2`.
    fn type_error2(&self, other: &Self, msg: &str) -> Error<Self>;

    /// Order the value against another one, failing if that is impossible
    /// (jq fails on values nested too deeply).
    fn try_cmp(&self, other: &Self) -> Result<core::cmp::Ordering, Error<Self>> {
        Ok(self.cmp(other))
    }

    /// Check the value for equality with another one, failing if that is
    /// impossible (jq fails on values nested too deeply).
    fn try_eq(&self, other: &Self) -> Result<bool, Error<Self>> {
        Ok(self == other)
    }

    /// If the value is a string and `sub` points to a slice of the string,
    /// shorten the string to `sub`, else panic.
    fn as_sub_str(&self, sub: &[u8]) -> Self;

    /// Interpret bytes as UTF-8 string value.
    fn from_utf8_bytes(b: impl AsRef<[u8]> + Send + 'static) -> Self;
}

/// Convenience trait for implementing the core functions.
trait ValTx: ValT + Sized {
    /// The number, else jq's `<value> number required`.
    fn num(&self) -> Result<f64, Error<Self>> {
        self.as_f64().ok_or_else(|| self.type_error("number required"))
    }

    /// The string, if it is one, with invalid UTF-8 replaced as jq never holds it.
    fn str(&self) -> Option<alloc::borrow::Cow<'_, str>> {
        self.as_bytes().map(|b| match core::str::from_utf8(b) {
            Ok(s) => alloc::borrow::Cow::Borrowed(s),
            Err(_) => alloc::borrow::Cow::Owned(utf8_lossy(b)),
        })
    }

    /// The value as `tostring` makes it.
    fn to_str(&self) -> Self {
        self.clone().into_string()
    }

    /// The elements of an array, or the value itself if it is none.
    fn elements(self) -> Result<Vec<Self>, Self> {
        self.into_seq()
    }
}
impl<T: ValT> ValTx for T {}

/// Sort `(key, value)` pairs stably by key, as jq's `sort_items`.
fn sort_pairs<V: ValT>(pairs: &mut [(V, V)]) -> Result<(), Error<V>> {
    let mut err = None;
    pairs.sort_by(|(k1, _), (k2, _)| {
        if err.is_some() {
            return core::cmp::Ordering::Equal;
        }
        k1.try_cmp(k2).unwrap_or_else(|e| {
            err = Some(e);
            core::cmp::Ordering::Equal
        })
    });
    err.map_or(Ok(()), Err)
}

/// The elements of `objects` paired with those of `keys`, sorted by key,
/// for jq's `_sort_by_impl`, `_group_by_impl` and `_unique_by_impl`.
fn keyed<V: ValT>(objects: V, keys: V) -> Result<Vec<(V, V)>, Error<V>> {
    let fail = |o: &V, k: &V| o.type_error2(k, "cannot be sorted, as they are not both arrays");
    let (os, ks) = match (objects.clone().elements(), keys.clone().elements()) {
        (Ok(os), Ok(ks)) if os.len() == ks.len() => (os, ks),
        _ => return Err(fail(&objects, &keys)),
    };
    let mut pairs: Vec<_> = ks.into_iter().zip(os).collect();
    sort_pairs(&mut pairs)?;
    Ok(pairs)
}

/// The elements of a sortable array, else jq's error for `sort`/`unique`.
fn sortable<V: ValT>(v: V) -> Result<Vec<(V, V)>, Error<V>> {
    let xs = v
        .elements()
        .map_err(|v| v.type_error("cannot be sorted, as it is not an array"))?;
    let mut pairs: Vec<_> = xs.into_iter().map(|x| (x.clone(), x)).collect();
    sort_pairs(&mut pairs)?;
    Ok(pairs)
}

/// Runs of equal keys, as jq's `jv_group`; `first` keeps only their first value.
fn group<V: ValT>(pairs: Vec<(V, V)>, first: bool) -> ValR<V> {
    let mut out = Vec::new();
    let mut run: Vec<V> = Vec::new();
    let mut prev: Option<V> = None;
    for (k, x) in pairs {
        let same = match &prev {
            Some(p) => p.try_eq(&k)?,
            None => false,
        };
        if !same {
            if let Some(_) = prev.replace(k) {
                out.push(core::mem::take(&mut run));
            }
        }
        if !(first && same) {
            run.push(x);
        }
    }
    if prev.is_some() {
        out.push(run);
    }
    Ok(if first {
        out.into_iter().flatten().collect()
    } else {
        out.into_iter().map(V::from_iter).collect()
    })
}

/// The minimal or maximal value by key, as jq's `minmax_by`.
fn minmax_by<V: ValT>(values: V, keys: V, is_min: bool) -> ValR<V> {
    let (vs, ks) = match (values.clone().elements(), keys.clone().elements()) {
        (Ok(vs), Ok(ks)) => (vs, ks),
        _ => return Err(values.type_error2(&keys, "cannot be iterated over")),
    };
    if vs.len() != ks.len() {
        return Err(values.type_error2(&keys, "have wrong length"));
    }
    let mut pairs = ks.into_iter().zip(vs);
    let Some((mut retkey, mut ret)) = pairs.next() else {
        return Ok(V::default());
    };
    for (k, x) in pairs {
        let cmp = k.try_cmp(&retkey)?;
        if cmp.is_lt() == is_min {
            (retkey, ret) = (k, x);
        }
    }
    Ok(ret)
}

/// The byte length of the UTF-8 sequence led by `b`, as jq's `jvp_utf8_decode_length`.
fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// `b` as a string with every invalid UTF-8 sequence replaced by U+FFFD
/// the way jq does it (`jvp_utf8_next`, `jvp_string_copy_replace_bad`),
/// which differs from [`String::from_utf8_lossy`] on overlong, surrogate,
/// and truncated sequences.
pub fn utf8_lossy(b: &[u8]) -> String {
    if let Ok(s) = core::str::from_utf8(b) {
        return s.into();
    }
    let mut out = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let first = b[i];
        let len = match first {
            0x00..=0x7F => 1,
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => 0,
        };
        let (c, n) = if len == 1 {
            (Some(char::from(first)), 1)
        } else if len == 0 {
            (None, 1)
        } else if len > b.len() - i {
            // the string ends before the sequence does
            (None, b.len() - i)
        } else {
            const BITS: [u8; 5] = [0, 0, 0x1F, 0x0F, 0x07];
            const FIRST: [u32; 5] = [0, 0, 0x80, 0x800, 0x10000];
            let mut cp = u32::from(first & BITS[len]);
            let mut n = len;
            let mut ok = true;
            for j in 1..len {
                let ch = b[i + j];
                if ch & 0xC0 != 0x80 {
                    (ok, n) = (false, j);
                    break;
                }
                cp = cp << 6 | u32::from(ch & 0x3F);
            }
            let c = char::from_u32(cp).filter(|_| ok && cp >= FIRST[len]);
            (c, n)
        };
        out.push(c.unwrap_or(char::REPLACEMENT_CHARACTER));
        i += n;
    }
    out
}

/// Whitespace that jq's `trim` removes (`jvp_codepoint_is_whitespace`).
fn is_jq_whitespace(c: char) -> bool {
    matches!(c as u32,
        0x0009..=0x000D | 0x0020 | 0x0085 | 0x00A0 | 0x1680 | 0x2000..=0x200A
        | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000)
}

fn trim<V: ValT>(v: V, left: bool, right: bool) -> ValR<V> {
    let Some(s) = v.as_bytes() else {
        return Err(Error::str("trim input must be a string"));
    };
    let s = match core::str::from_utf8(s) {
        Ok(s) => s,
        Err(_) => return Ok(v),
    };
    let t = match (left, right) {
        (true, true) => s.trim_matches(is_jq_whitespace),
        (true, false) => s.trim_start_matches(is_jq_whitespace),
        _ => s.trim_end_matches(is_jq_whitespace),
    };
    Ok(if t.len() == s.len() { v.clone() } else { v.as_sub_str(t.as_bytes()) })
}

/// jq's `implode`: codepoints outside Unicode scalar values become U+FFFD.
fn implode<V: ValT>(v: V) -> ValR<V> {
    let xs = v
        .elements()
        .map_err(|_| Error::str("implode input must be an array"))?;
    let mut s = String::with_capacity(xs.len());
    for x in &xs {
        let n = match x.as_f64() {
            Some(n) if !n.is_nan() => n,
            _ => return Err(x.type_error("can't be imploded, unicode codepoint needs to be numeric")),
        };
        // C's double-to-int conversion truncates
        let c = u32::try_from(n as i32).ok().and_then(char::from_u32);
        s.push(c.unwrap_or(char::REPLACEMENT_CHARACTER));
    }
    Ok(V::from(s))
}

/// jq's `_strindices`: codepoint offsets of (possibly overlapping) occurrences.
fn strindices<V: ValT>(v: &V, k: &V) -> ValR<V> {
    let s = v
        .as_bytes()
        .ok_or_else(|| v.type_error("cannot be searched, as it is not a string"))?;
    let k = k.as_bytes().ok_or_else(|| k.type_error("is not a string"))?;
    let mut out = Vec::new();
    if !k.is_empty() {
        use bstr::ByteSlice;
        let (mut lp, mut n, mut p) = (0, 0isize, 0);
        while let Some(i) = s[p..].find(k) {
            p += i;
            while lp < p {
                lp += utf8_len(s[lp]);
                n += 1;
            }
            out.push(V::from(n));
            p += 1;
        }
    }
    Ok(out.into_iter().collect())
}

/// jq's `split/1` on strings (`jv_string_split`).
fn split<V: ValT>(v: &V, sep: &V) -> ValR<V> {
    let (Some(s), Some(sep)) = (v.as_bytes(), sep.as_bytes()) else {
        return Err(Error::str("split input and separator must be strings"));
    };
    let sub = |b: &[u8]| v.as_sub_str(b);
    if sep.is_empty() {
        let s = utf8_lossy(s);
        return Ok(s.chars().map(|c| V::from(String::from(c))).collect());
    }
    use bstr::ByteSlice;
    let mut out = Vec::new();
    let mut p = 0;
    while p < s.len() {
        let e = s[p..].find(sep).map_or(s.len(), |i| p + i);
        out.push(sub(&s[p..e]));
        if e + sep.len() == s.len() {
            out.push(sub(&s[s.len()..]));
        }
        p = e + sep.len();
    }
    Ok(out.into_iter().collect())
}

/// jq's `toboolean`.
fn toboolean<V: ValT>(v: V) -> ValR<V> {
    let fail = |v: &V| Err(v.type_error("cannot be parsed as a boolean"));
    if v == V::from(true) || v == V::from(false) {
        return Ok(v);
    }
    match v.as_bytes() {
        Some(b"true") => Ok(V::from(true)),
        Some(b"false") => Ok(V::from(false)),
        _ => fail(&v),
    }
}

/// jq's RANGE opcode behind `range/2`: numbers from `from` below `upto`, by 1.
fn range<'a, V: ValT + 'a>(from: V, upto: V) -> Box<dyn Iterator<Item = ValX<'a, V>> + 'a> {
    let (Some(mut x), Some(upto)) = (from.as_f64(), upto.as_f64()) else {
        return box_once(Err(Exn::from(Error::str("Range bounds must be numeric"))));
    };
    let mut first = Some(from);
    Box::new(core::iter::from_fn(move || {
        if !(x < upto) {
            return None;
        }
        let out = first.take().unwrap_or_else(|| V::from(x));
        x += 1.0;
        Some(Ok(out))
    }))
}

#[allow(clippy::unit_arg)]
fn base_run<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([
        ("range", v(2), |mut cv| {
            let upto = cv.0.pop_var();
            let from = cv.0.pop_var();
            range(from, upto)
        }),
        ("utf8bytelength", v(0), |cv| {
            let len = |s: &[u8]| (s.len() as isize).into();
            let fail = || cv.1.type_error("only strings have UTF-8 byte length");
            bome(cv.1.as_bytes().map(len).ok_or_else(fail))
        }),
        ("explode", v(0), |cv| {
            bome(match cv.1.str() {
                Some(s) => Ok(s.chars().map(|c| D::V::from(c as isize)).collect()),
                None => Err(Error::str("explode input must be a string")),
            })
        }),
        ("implode", v(0), |cv| bome(implode(cv.1))),
        ("_strindices", v(1), |mut cv| {
            let k = cv.0.pop_var();
            bome(strindices(&cv.1, &k))
        }),
        ("split", v(1), |mut cv| {
            let sep = cv.0.pop_var();
            bome(split(&cv.1, &sep))
        }),
        ("trim", v(0), |cv| bome(trim(cv.1, true, true))),
        ("ltrim", v(0), |cv| bome(trim(cv.1, true, false))),
        ("rtrim", v(0), |cv| bome(trim(cv.1, false, true))),
        ("startswith", v(1), |mut cv| {
            let b = cv.0.pop_var();
            bome(match (cv.1.as_bytes(), b.as_bytes()) {
                (Some(a), Some(b)) => Ok(a.starts_with(b).into()),
                _ => Err(Error::str("startswith() requires string inputs")),
            })
        }),
        ("endswith", v(1), |mut cv| {
            let b = cv.0.pop_var();
            bome(match (cv.1.as_bytes(), b.as_bytes()) {
                (Some(a), Some(b)) => Ok(a.ends_with(b).into()),
                _ => Err(Error::str("endswith() requires string inputs")),
            })
        }),
        ("toboolean", v(0), |cv| bome(toboolean(cv.1))),
        ("sort", v(0), |cv| {
            bome(sortable(cv.1).map(|ps| ps.into_iter().map(|(_, x)| x).collect()))
        }),
        ("_sort_by_impl", v(1), |mut cv| {
            let keys = cv.0.pop_var();
            bome(keyed(cv.1, keys).map(|ps| ps.into_iter().map(|(_, x)| x).collect()))
        }),
        ("_group_by_impl", v(1), |mut cv| {
            let keys = cv.0.pop_var();
            bome(keyed(cv.1, keys).and_then(|ps| group(ps, false)))
        }),
        ("unique", v(0), |cv| bome(sortable(cv.1).and_then(|ps| group(ps, true)))),
        ("_unique_by_impl", v(1), |mut cv| {
            let keys = cv.0.pop_var();
            bome(keyed(cv.1, keys).and_then(|ps| group(ps, true)))
        }),
        ("min", v(0), |cv| bome(minmax_by(cv.1.clone(), cv.1, true))),
        ("max", v(0), |cv| bome(minmax_by(cv.1.clone(), cv.1, false))),
        ("_min_by_impl", v(1), |mut cv| {
            let keys = cv.0.pop_var();
            bome(minmax_by(cv.1, keys, true))
        }),
        ("_max_by_impl", v(1), |mut cv| {
            let keys = cv.0.pop_var();
            bome(minmax_by(cv.1, keys, false))
        }),
        ("infinite", v(0), |_| bome(Ok(D::V::from(f64::INFINITY)))),
        ("nan", v(0), |_| bome(Ok(D::V::from(f64::NAN)))),
        ("isinfinite", v(0), |cv| bome(Ok(cv.1.as_f64().is_some_and(f64::is_infinite).into()))),
        ("isnan", v(0), |cv| bome(Ok(cv.1.as_f64().is_some_and(f64::is_nan).into()))),
        ("isnormal", v(0), |cv| bome(Ok(cv.1.as_f64().is_some_and(f64::is_normal).into()))),
        ("_type_error", v(1), |mut cv| {
            let msg = cv.0.pop_var();
            let msg = msg.str().map(|s| s.into_owned()).unwrap_or_default();
            bome(Err(cv.1.type_error(&msg)))
        }),
        ("halt", v(0), |_| box_once(Err(Exn::halt(0)))),
    ])
}

#[cfg(feature = "std")]
fn now<V: From<String>>() -> Result<f64, Error<V>> {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_secs_f64())
        .map_err(Error::str)
}

#[cfg(feature = "std")]
fn std<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([("now", v(0), |_| bome(now().map(D::V::from)))])
}

const BASE64_ENCODE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Bytes that jq's `@uri` keeps (`URI_UNRESERVED`).
fn uri_unreserved(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~')
}

/// Append `s` to `out`, escaping the ASCII characters `esc` maps, as jq's
/// `escape_string`, which also always writes NUL as `\0`.
fn escape(out: &mut Vec<u8>, s: &[u8], esc: impl Fn(u8) -> Option<&'static [u8]>) {
    for &c in s {
        match esc(c) {
            Some(e) => out.extend_from_slice(e),
            None if c == 0 => out.extend_from_slice(b"\\0"),
            None => out.push(c),
        }
    }
}

fn html<V: ValT>(v: V) -> V {
    let s = v.to_str();
    let mut out = Vec::new();
    escape(&mut out, s.as_bytes().unwrap_or_default(), |c| match c {
        b'&' => Some(b"&amp;"),
        b'<' => Some(b"&lt;"),
        b'>' => Some(b"&gt;"),
        b'\'' => Some(b"&apos;"),
        b'"' => Some(b"&quot;"),
        _ => None,
    });
    V::from_utf8_bytes(out)
}

fn uri<V: ValT>(v: V) -> V {
    let s = v.to_str();
    let mut out = Vec::new();
    for &c in s.as_bytes().unwrap_or_default() {
        if uri_unreserved(c) {
            out.push(c);
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            out.extend([b'%', HEX[(c >> 4) as usize], HEX[(c & 15) as usize]]);
        }
    }
    V::from_utf8_bytes(out)
}

fn urid<V: ValT>(v: V) -> ValR<V> {
    let input = v.to_str();
    let s = input.as_bytes().unwrap_or_default();
    let fail = || input.type_error("is not a valid uri encoding");
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] != b'%' {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let hi = s.get(i + 1).copied().and_then(hex).ok_or_else(fail)?;
        let lo = s.get(i + 2).copied().and_then(hex).ok_or_else(fail)?;
        out.push(hi << 4 | lo);
        i += 3;
    }
    match String::from_utf8(out) {
        Ok(s) => Ok(V::from(s)),
        Err(_) => Err(fail()),
    }
}

fn sh<V: ValT>(v: V) -> ValR<V> {
    let xs = v.elements().unwrap_or_else(|v| Vec::from([v]));
    let mut out = Vec::new();
    for (i, x) in xs.iter().enumerate() {
        if i > 0 {
            out.push(b' ');
        }
        if let Some(s) = x.as_bytes() {
            out.push(b'\'');
            escape(&mut out, s, |c| (c == b'\'').then_some(&b"'\\''"[..]));
            out.push(b'\'');
        } else if *x < core::iter::empty().collect() {
            out.extend_from_slice(x.to_str().as_bytes().unwrap_or_default());
        } else {
            return Err(x.type_error("can not be escaped for shell"));
        }
    }
    Ok(V::from_utf8_bytes(out))
}

fn base64<V: ValT>(v: V) -> V {
    let s = v.to_str();
    let data = s.as_bytes().unwrap_or_default();
    let mut out = Vec::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk.len();
        let code = chunk.iter().enumerate().fold(0u32, |acc, (j, b)| acc | (*b as u32) << (16 - 8 * j));
        for j in 0..4 {
            out.push(if j > n { b'=' } else { BASE64_ENCODE[(code >> (18 - j * 6)) as usize & 0x3f] });
        }
    }
    V::from_utf8_bytes(out)
}

/// jq's lenient `@base64d`: decoding stops at the first `=`, and
/// incomplete trailing groups keep their complete bytes.
fn base64d<V: ValT>(v: V) -> ValR<V> {
    let input = v.to_str();
    let data = input.as_bytes().unwrap_or_default();
    let decode = |c: u8| BASE64_ENCODE.iter().position(|e| *e == c).map(|i| i as u32);
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 3);
    let (mut code, mut read) = (0u32, 0);
    for &c in data.iter().take_while(|c| **c != b'=') {
        let d = decode(c).ok_or_else(|| input.type_error("is not valid base64 data"))?;
        code = code << 6 | d;
        read += 1;
        if read == 4 {
            out.extend([(code >> 16) as u8, (code >> 8) as u8, code as u8]);
            (code, read) = (0, 0);
        }
    }
    match read {
        3 => out.extend([(code >> 10) as u8, (code >> 2) as u8]),
        2 => out.push((code >> 4) as u8),
        1 => return Err(input.type_error("trailing base64 byte found")),
        _ => {}
    }
    Ok(V::from(utf8_lossy(&out)))
}

fn format<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([
        ("@html", v(0), |cv| bome(Ok(html(cv.1)))),
        ("@uri", v(0), |cv| bome(Ok(uri(cv.1)))),
        ("@urid", v(0), |cv| bome(urid(cv.1))),
        ("@sh", v(0), |cv| bome(sh(cv.1))),
        ("@base64", v(0), |cv| bome(Ok(base64(cv.1)))),
        ("@base64d", v(0), |cv| bome(base64d(cv.1))),
    ])
}
