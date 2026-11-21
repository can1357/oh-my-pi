//! JSON superset with binary data and non-string object keys.
//!
//! This crate provides a few macros for formatting / writing;
//! this is done in order to function with both
//! [`core::fmt::Write`] and [`std::io::Write`].
#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

extern crate alloc;
#[cfg(feature = "std")]
extern crate std;

mod funs;
mod num;
pub mod msg;
#[macro_use]
pub mod write;
pub mod read;

use alloc::{borrow::ToOwned, boxed::Box, string::String, vec::Vec};
use bstr::{BStr, ByteSlice};
use bytes::{BufMut, Bytes, BytesMut};
use core::cmp::Ordering;
use core::fmt;
use core::hash::{Hash, Hasher};
use jaq_core::box_iter::box_once;
use jaq_core::{load, ops, path, val, Exn};

pub use funs::{bytes_valrs, funs};
pub use num::Num;

#[cfg(not(feature = "sync"))]
pub use alloc::rc::Rc;
#[cfg(feature = "sync")]
pub use alloc::sync::Arc as Rc;

/// JSON superset with binary data and non-string object keys.
///
/// This is the default value type for jaq.
#[derive(Clone, Debug, Default)]
pub enum Val {
    #[default]
    /// Null
    Null,
    /// Boolean
    Bool(bool),
    /// Number
    Num(Num),
    /// Byte string
    BStr(Box<Bytes>),
    /// Text string (interpreted as UTF-8)
    ///
    /// Note that this does not require the actual bytes to be all valid UTF-8;
    /// this just means that the bytes are interpreted as UTF-8.
    /// An effort is made to preserve invalid UTF-8 as is, else
    /// replace invalid UTF-8 by the Unicode replacement character.
    TStr(Box<Bytes>),
    /// Array
    Arr(Rc<Vec<Val>>),
    /// Object
    Obj(Rc<Map<Val, Val>>),
}

#[cfg(feature = "sync")]
#[test]
fn val_send_sync() {
    fn send_sync<T: Send + Sync>(_: T) {}
    send_sync(Val::default())
}

#[cfg(target_arch = "x86_64")]
const _: () = {
    assert!(core::mem::size_of::<Val>() == 16);
};

/// Order-preserving map
pub type Map<K = Val, V = K> = indexmap::IndexMap<K, V, foldhash::fast::RandomState>;

/// Error that can occur during filter execution.
pub type Error = jaq_core::Error<Val>;
/// A value or an eRror.
pub type ValR = jaq_core::ValR<Val>;
/// A value or an eXception.
pub type ValX<'a> = jaq_core::ValX<'a, Val>;

/// Deepest nesting that comparing values descends into (jq's `MAX_CMP_DEPTH`).
const MAX_CMP_DEPTH: usize = 10_000;
/// Deepest nesting that checking values for equality descends into
/// (jq's `MAX_EQUAL_DEPTH`).
const MAX_EQUAL_DEPTH: usize = 10_000;
/// Deepest nesting that merging objects with `*` descends into
/// (jq's `MAX_OBJECT_MERGE_DEPTH`).
const MAX_MERGE_DEPTH: usize = 10_000;
/// Longest path that `getpath`, `setpath` and `delpaths` accept
/// (jq's `MAX_PATH_DEPTH`).
const MAX_PATH_DEPTH: usize = 10_000;
/// Largest array index that can be set (`INT_MAX >> 2` in `jv_array_set`).
const MAX_ARRAY_INDEX: i64 = (i32::MAX >> 2) as i64;

/// A comparison descended deeper than allowed.
struct TooDeep;

// This is part of the Rust standard library since 1.76:
// <https://doc.rust-lang.org/std/rc/struct.Rc.html#method.unwrap_or_clone>.
// However, to keep MSRV low, we reimplement it here.
fn rc_unwrap_or_clone<T: Clone>(a: Rc<T>) -> T {
    Rc::try_unwrap(a).unwrap_or_else(|a| (*a).clone())
}

fn err(msg: impl fmt::Display) -> Error {
    Error::str(msg)
}

fn too_deep_cmp() -> Error {
    err("Comparison too deep")
}

fn too_deep_eq() -> Error {
    err("Equality check too deep")
}

/// `Cannot iterate over <kind> (<value>)`, as jq's `EACH`.
fn iter_err(v: &Val) -> Error {
    err(format_args!("Cannot iterate over {}", msg::describe(v)))
}

/// `Cannot index <kind> with <kind> (<key>)`, as jq's `jv_get`.
fn index_err(t: &Val, k: &Val) -> Error {
    err(format_args!("Cannot index {} with {}", msg::kind_name(t), msg::describe(k)))
}

/// Truncate a double to an `int` index the way jq does:
/// clamp to the range of `int`, then round towards zero.
fn int_index(f: f64) -> i64 {
    f.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i64
}

/// The object `{"start": .., "end": ..}` that jq indexes with for `.[s:e]`.
fn slice_key(start: Option<&Val>, end: Option<&Val>) -> Val {
    let kv = |k: &str, v: Option<&Val>| (Val::utf8_str(k.to_owned()), v.cloned().unwrap_or_default());
    Val::obj([kv("start", start), kv("end", end)].into_iter().collect())
}

/// Number of codepoints of a string, counting invalid UTF-8 as jq does.
fn str_len(b: &[u8], utf8: bool) -> usize {
    if !utf8 {
        return b.len();
    }
    let mut n = 0;
    let mut i = 0;
    while i < b.len() {
        i += write::utf8_next(&b[i..]).1;
        n += 1;
    }
    n
}

/// Byte offset of the codepoint at index `cp` (or of the end) of a string.
fn str_offset(b: &[u8], utf8: bool, cp: usize) -> usize {
    if !utf8 {
        return cp.min(b.len());
    }
    let mut i = 0;
    for _ in 0..cp {
        if i >= b.len() {
            break;
        }
        i += write::utf8_next(&b[i..]).1;
    }
    i
}

/// Byte range of the codepoints of a string between slice bounds.
fn str_bounds(b: &[u8], utf8: bool, start: Option<&Val>, end: Option<&Val>) -> Result<core::ops::Range<usize>, Error> {
    let (s, e) = parse_slice(str_len(b, utf8), start, end)?;
    let s = str_offset(b, utf8, s);
    Ok(s..str_offset(b, utf8, e).max(s))
}

/// Resolve slice bounds to `start..end` within `len` elements, as jq's
/// `parse_slice`: `null` bounds are the ends, negative bounds count from
/// the end, the start is rounded down and the end up.
///
/// A bound that is `None` was missing from the slice object.
fn parse_slice(len: usize, start: Option<&Val>, end: Option<&Val>) -> Result<(usize, usize), Error> {
    let bound = |v: Option<&Val>, default: f64| match v {
        Some(Val::Null) => Ok(default),
        Some(Val::Num(n)) => Ok(n.as_f64()),
        _ => Err(err("Array/string slice indices must be integers")),
    };
    let flen = len as f64;
    let mut ds = bound(start, 0.0)?;
    let mut de = bound(end, flen)?;
    if ds.is_nan() {
        ds = 0.0;
    }
    if ds < 0.0 {
        ds += flen;
    }
    if ds < 0.0 {
        ds = 0.0;
    }
    if ds > flen {
        ds = flen;
    }
    let start = ds as usize;
    if de.is_nan() {
        de = flen;
    }
    if de < 0.0 {
        de += flen;
    }
    if de < 0.0 {
        de = start as f64;
    }
    let mut end = if de > f64::from(i32::MAX) { i32::MAX as usize } else { de as usize };
    if end > len {
        end = len;
    }
    if end < len && (end as f64) < de {
        end += 1;
    }
    Ok((start, end.max(start)))
}

impl jaq_core::ValT for Val {
    fn getpath(self, path: &Self) -> ValR {
        Val::getpath(self, path)
    }

    fn setpath(self, path: &Self, v: Self) -> ValR {
        Val::setpath(self, path, v)
    }

    fn delpaths(self, paths: &Self) -> ValR {
        Val::delpaths(self, paths)
    }

    fn from_num(n: &str) -> ValR {
        Ok(Self::Num(Num::from_str(n)))
    }

    fn from_map<I: IntoIterator<Item = (Self, Self)>>(iter: I) -> ValR {
        let kvs = iter.into_iter().map(|(k, v)| match k {
            Val::TStr(_) | Val::BStr(_) => Ok((k, v)),
            k => Err(msg::object_key(&k)),
        });
        kvs.collect::<Result<_, _>>().map(Self::obj)
    }

    fn key_values(self) -> Box<dyn Iterator<Item = Result<(Val, Val), Error>>> {
        let arr_idx = |(i, x)| Ok((Self::from(i as isize), x));
        match self {
            Self::Arr(a) => Box::new(rc_unwrap_or_clone(a).into_iter().enumerate().map(arr_idx)),
            Self::Obj(o) => Box::new(rc_unwrap_or_clone(o).into_iter().map(Ok)),
            _ => box_once(Err(iter_err(&self))),
        }
    }

    fn values(self) -> Box<dyn Iterator<Item = ValR>> {
        match self {
            Self::Arr(a) => Box::new(rc_unwrap_or_clone(a).into_iter().map(Ok)),
            Self::Obj(o) => Box::new(rc_unwrap_or_clone(o).into_iter().map(|(_k, v)| Ok(v))),
            _ => box_once(Err(iter_err(&self))),
        }
    }

    fn index(self, index: &Self) -> ValR {
        self.get(index)
    }

    fn range(self, range: val::Range<&Self>) -> ValR {
        let null = Val::Null;
        let (start, end) = (range.start.unwrap_or(&null), range.end.unwrap_or(&null));
        self.get_slice(Some(start), Some(end), None)
    }

    fn map_values<'a, I: Iterator<Item = ValX<'a>>>(
        self,
        opt: path::Opt,
        f: impl Fn(Self) -> I,
    ) -> ValX<'a> {
        // like jq's `_modify`, use the first output of `f` and
        // delete the child if there is none
        match self {
            Self::Arr(a) => {
                let mut out = Vec::with_capacity(a.len());
                for x in rc_unwrap_or_clone(a) {
                    out.extend(f(x).next().transpose()?);
                }
                Ok(Self::Arr(out.into()))
            }
            Self::Obj(o) => {
                let mut out = Map::with_capacity_and_hasher(o.len(), Default::default());
                for (k, v) in rc_unwrap_or_clone(o) {
                    if let Some(y) = f(v).next().transpose()? {
                        out.insert(k, y);
                    }
                }
                Ok(Self::obj(out))
            }
            v => opt.fail(v, |v| Exn::from(iter_err(&v))),
        }
    }

    fn map_index<'a, I: Iterator<Item = ValX<'a>>>(
        mut self,
        index: &Self,
        opt: path::Opt,
        f: impl Fn(Self) -> I,
    ) -> ValX<'a> {
        match (&mut self, index) {
            (Val::Arr(_) | Val::TStr(_) | Val::BStr(_) | Val::Null, Val::Obj(o)) => {
                let start = o.get(&Val::utf8_str("start"));
                let end = o.get(&Val::utf8_str("end"));
                self.map_slice(start, end, Some(index), opt, f)
            }
            (Val::Obj(o), Val::TStr(_) | Val::BStr(_)) => {
                use indexmap::map::Entry::{Occupied, Vacant};
                match Rc::make_mut(o).entry(index.clone()) {
                    Occupied(mut e) => {
                        let v = core::mem::take(e.get_mut());
                        match f(v).next().transpose()? {
                            Some(y) => {
                                e.insert(y);
                            }
                            None => {
                                e.shift_remove();
                            }
                        };
                    }
                    Vacant(e) => {
                        if let Some(y) = f(Val::Null).next().transpose()? {
                            e.insert(y);
                        }
                    }
                }
                Ok(self)
            }
            (Val::Arr(a), Val::Num(n)) if !n.is_nan() => {
                let d = n.as_f64();
                let i = int_index(d);
                let len = a.len() as i64;
                let read = if i < 0 { i + len } else { i };
                // jq deletes a negative index counted from the end,
                // so `-0.5` reads index 0, but deletes nothing
                let del = if d < 0.0 { len + i } else { i };
                let x = match usize::try_from(read).ok().filter(|r| *r < a.len()) {
                    Some(r) if r as i64 == del => core::mem::take(&mut Rc::make_mut(a)[r]),
                    Some(r) => a[r].clone(),
                    None => Val::Null,
                };
                match f(x).next().transpose()? {
                    Some(y) => array_set(Rc::make_mut(a), i, y)?,
                    None => {
                        if (0..len).contains(&del) {
                            Rc::make_mut(a).remove(del as usize);
                        }
                    }
                }
                Ok(self)
            }
            _ => {
                let v = match self.clone().get(index) {
                    Ok(v) => v,
                    Err(e) => return opt.fail(self, |_| Exn::from(e)),
                };
                match f(v).next().transpose()? {
                    Some(y) => Ok(self.set(index, y)?),
                    None => Ok(self.dels(core::slice::from_ref(index))?),
                }
            }
        }
    }

    fn map_range<'a, I: Iterator<Item = ValX<'a>>>(
        self,
        range: val::Range<&Self>,
        opt: path::Opt,
        f: impl Fn(Self) -> I,
    ) -> ValX<'a> {
        let null = Val::Null;
        let (start, end) = (range.start.unwrap_or(&null), range.end.unwrap_or(&null));
        self.map_slice(Some(start), Some(end), None, opt, f)
    }

    /// True if the value is neither null nor false.
    fn as_bool(&self) -> bool {
        !matches!(self, Self::Null | Self::Bool(false))
    }

    /// jq's `tostring`: strings as they are, other values dumped as JSON.
    fn into_string(self) -> Self {
        match self {
            Self::BStr(b) | Self::TStr(b) => Self::TStr(b),
            _ => Self::utf8_str(self.to_json()),
        }
    }

    fn cmp_op(&self, op: ops::Cmp, other: &Self) -> Result<bool, Error> {
        use ops::Cmp;
        match op {
            Cmp::Eq | Cmp::Ne => {
                let eq = self.eq_at(other, 0, MAX_EQUAL_DEPTH).map_err(|_| too_deep_eq())?;
                Ok(eq == (op == Cmp::Eq))
            }
            _ => {
                let ord = self.cmp_at(other, 0, MAX_CMP_DEPTH, true).map_err(|_| too_deep_cmp())?;
                Ok(match op {
                    Cmp::Lt => ord.is_lt(),
                    Cmp::Le => ord.is_le(),
                    Cmp::Gt => ord.is_gt(),
                    _ => ord.is_ge(),
                })
            }
        }
    }
}

impl jaq_std::ValT for Val {
    fn into_seq<S: FromIterator<Self>>(self) -> Result<S, Self> {
        match self {
            Self::Arr(a) => match Rc::try_unwrap(a) {
                Ok(a) => Ok(a.into_iter().collect()),
                Err(a) => Ok(a.iter().cloned().collect()),
            },
            _ => Err(self),
        }
    }

    fn is_int(&self) -> bool {
        self.as_num().is_some_and(Num::is_int)
    }

    fn as_isize(&self) -> Option<isize> {
        self.as_num().and_then(Num::as_isize)
    }

    fn as_f64(&self) -> Option<f64> {
        self.as_num().map(Num::as_f64)
    }

    fn is_utf8_str(&self) -> bool {
        matches!(self, Self::TStr(_))
    }

    fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::BStr(b) | Self::TStr(b) => Some(b),
            _ => None,
        }
    }

    fn type_error(&self, msg: &str) -> Error {
        msg::type_error(self, msg)
    }

    fn type_error2(&self, other: &Self, msg: &str) -> Error {
        msg::type_error2(self, other, msg)
    }

    /// Order as jq's `jv_cmp`, failing with `Comparison too deep`.
    ///
    /// Unlike the `<` operator, NaN equals NaN here, which keeps this
    /// a total order for sorting; all NaNs print the same anyway.
    fn try_cmp(&self, other: &Self) -> Result<Ordering, Error> {
        self.cmp_at(other, 0, MAX_CMP_DEPTH, false).map_err(|_| too_deep_cmp())
    }

    /// Equality as jq's `jv_equal`, failing with `Equality check too deep`.
    fn try_eq(&self, other: &Self) -> Result<bool, Error> {
        self.eq_at(other, 0, MAX_EQUAL_DEPTH).map_err(|_| too_deep_eq())
    }

    fn as_sub_str(&self, sub: &[u8]) -> Self {
        match self {
            Self::BStr(b) => Self::byte_str(b.slice_ref(sub)),
            Self::TStr(b) => Self::utf8_str(b.slice_ref(sub)),
            _ => panic!(),
        }
    }

    fn from_utf8_bytes(b: impl AsRef<[u8]> + Send + 'static) -> Self {
        Self::utf8_str(Bytes::from_owner(b))
    }
}

/// Definitions of the standard library.
pub fn defs() -> impl Iterator<Item = load::parse::Def<&'static str>> {
    load::parse(include_str!("defs.jq"), |p| p.defs())
        .unwrap()
        .into_iter()
}

/// Set `a[i]` to `v` as jq's `jv_array_set`: a negative index counts from
/// the end, and the array is padded with nulls up to the index.
fn array_set(a: &mut Vec<Val>, i: i64, v: Val) -> Result<(), Error> {
    let i = if i < 0 { i + a.len() as i64 } else { i };
    if i < 0 {
        return Err(err("Out of bounds negative array index"));
    }
    if i > MAX_ARRAY_INDEX {
        return Err(err("Array index too large"));
    }
    let i = i as usize;
    if i >= a.len() {
        a.resize(i + 1, Val::Null);
    }
    a[i] = v;
    Ok(())
}

/// Deep-merge `r` into `l`, as jq's `jv_object_merge_recursive`.
fn obj_merge(l: &mut Rc<Map>, r: Rc<Map>, depth: usize) -> Result<(), Error> {
    if depth > MAX_MERGE_DEPTH {
        return Err(err("Object merge too deep"));
    }
    let l = Rc::make_mut(l);
    for (k, v) in rc_unwrap_or_clone(r) {
        match (l.get_mut(&k), v) {
            (Some(Val::Obj(l)), Val::Obj(r)) => obj_merge(l, r, depth + 1)?,
            (Some(l), r) => *l = r,
            (None, r) => {
                l.insert(k, r);
            }
        }
    }
    Ok(())
}

/// jq's `jv_kind` ranks, by which values of different kinds are ordered.
fn kind_rank(v: &Val) -> u8 {
    match v {
        Val::Null => 1,
        Val::Bool(false) => 2,
        Val::Bool(true) => 3,
        Val::Num(_) => 4,
        Val::BStr(_) | Val::TStr(_) => 5,
        Val::Arr(_) => 6,
        Val::Obj(_) => 7,
    }
}

impl Val {
    /// Construct an object value.
    pub fn obj(m: Map) -> Self {
        Self::Obj(m.into())
    }

    /// Construct a string that is interpreted as UTF-8.
    pub fn utf8_str(s: impl Into<Bytes>) -> Self {
        Self::TStr(s.into().into())
    }

    /// Construct a string that is interpreted as bytes.
    pub fn byte_str(s: impl Into<Bytes>) -> Self {
        Self::BStr(s.into().into())
    }

    fn as_num(&self) -> Option<&Num> {
        match self {
            Self::Num(n) => Some(n),
            _ => None,
        }
    }

    fn type_error_str(&self, typ: &str) -> Error {
        err(format_args!("{} is not {typ}", msg::describe(self)))
    }

    fn as_arr(&self) -> Result<&Rc<Vec<Self>>, Error> {
        match self {
            Self::Arr(a) => Ok(a),
            _ => Err(self.type_error_str("an array")),
        }
    }

    fn to_json(&self) -> Vec<u8> {
        let mut buf = write::Buf(Vec::new());
        write::write_buf(&mut buf, &write::Pp::default(), 0, self).unwrap();
        buf.0
    }

    /// Order as jq's `jvp_cmp`, failing below nesting depth `max`.
    ///
    /// With `nan_less`, NaN is smaller than any number, even NaN,
    /// as for jq's `<`; otherwise NaN equals NaN.
    fn cmp_at(&self, other: &Self, depth: usize, max: usize, nan_less: bool) -> Result<Ordering, TooDeep> {
        if depth > max {
            return Err(TooDeep);
        }
        let (ka, kb) = (kind_rank(self), kind_rank(other));
        if ka != kb {
            return Ok(ka.cmp(&kb));
        }
        let seq = |x: &mut dyn Iterator<Item = &Val>, y: &mut dyn Iterator<Item = &Val>, depth| loop {
            match (x.next(), y.next()) {
                (None, None) => return Ok(Ordering::Equal),
                (None, Some(_)) => return Ok(Ordering::Less),
                (Some(_), None) => return Ok(Ordering::Greater),
                (Some(a), Some(b)) => match a.cmp_at(b, depth, max, nan_less)? {
                    Ordering::Equal => (),
                    o => return Ok(o),
                },
            }
        };
        Ok(match (self, other) {
            (Self::Num(x), Self::Num(y)) if nan_less => x.jq_cmp(y),
            (Self::Num(x), Self::Num(y)) => x.total_cmp(y),
            (Self::BStr(x) | Self::TStr(x), Self::BStr(y) | Self::TStr(y)) => x[..].cmp(&y[..]),
            (Self::Arr(x), Self::Arr(y)) => seq(&mut x.iter(), &mut y.iter(), depth + 1)?,
            (Self::Obj(x), Self::Obj(y)) => {
                // compare the sorted keys as arrays, then the values by key
                if depth + 1 > max {
                    return Err(TooDeep);
                }
                let mut kx: Vec<&Val> = x.keys().collect();
                let mut ky: Vec<&Val> = y.keys().collect();
                kx.sort();
                ky.sort();
                match seq(&mut kx.iter().copied(), &mut ky.iter().copied(), depth + 2)? {
                    Ordering::Equal => {
                        for k in kx {
                            match x[k].cmp_at(&y[k], depth + 1, max, nan_less)? {
                                Ordering::Equal => (),
                                o => return Ok(o),
                            }
                        }
                        Ordering::Equal
                    }
                    o => o,
                }
            }
            _ => Ordering::Equal,
        })
    }

    /// Equality as jq's `jvp_equal`, failing below nesting depth `max`.
    fn eq_at(&self, other: &Self, depth: usize, max: usize) -> Result<bool, TooDeep> {
        if depth > max {
            return Err(TooDeep);
        }
        Ok(match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Bool(x), Self::Bool(y)) => x == y,
            (Self::Num(x), Self::Num(y)) => x == y,
            (Self::BStr(x) | Self::TStr(x), Self::BStr(y) | Self::TStr(y)) => x == y,
            (Self::Arr(x), Self::Arr(y)) => {
                if x.len() != y.len() {
                    return Ok(false);
                }
                if Rc::ptr_eq(x, y) {
                    return Ok(true);
                }
                for (a, b) in x.iter().zip(y.iter()) {
                    if !a.eq_at(b, depth + 1, max)? {
                        return Ok(false);
                    }
                }
                true
            }
            (Self::Obj(x), Self::Obj(y)) => {
                if Rc::ptr_eq(x, y) {
                    return Ok(true);
                }
                for (k, a) in x.iter() {
                    match y.get(k) {
                        Some(b) if a.eq_at(b, depth + 1, max)? => (),
                        _ => return Ok(false),
                    }
                }
                x.len() == y.len()
            }
            _ => false,
        })
    }

    /// `self | .[k]`, as jq's `jv_get`.
    pub fn get(self, k: &Self) -> ValR {
        match (self, k) {
            (Val::Obj(o), Val::TStr(_) | Val::BStr(_)) => Ok(o.get(k).cloned().unwrap_or_default()),
            (Val::Arr(_), Val::Num(n)) if n.is_nan() => Ok(Val::Null),
            (Val::Arr(a), Val::Num(n)) => {
                let i = int_index(n.as_f64());
                let i = if i < 0 { i + a.len() as i64 } else { i };
                let x = usize::try_from(i).ok().and_then(|i| a.get(i));
                Ok(x.cloned().unwrap_or_default())
            }
            (t @ (Val::Arr(_) | Val::TStr(_) | Val::BStr(_)), Val::Obj(o)) => {
                let start = o.get(&Val::utf8_str("start"));
                let end = o.get(&Val::utf8_str("end"));
                t.get_slice(start, end, Some(k))
            }
            (Val::Arr(a), Val::Arr(b)) => Self::indexes(&a, &b),
            (Val::Null, Val::TStr(_) | Val::BStr(_) | Val::Num(_) | Val::Obj(_)) => Ok(Val::Null),
            (t, k) => Err(index_err(&t, k)),
        }
    }

    /// Positions in `a` where `b` occurs, as jq's `jv_array_indexes`.
    fn indexes(a: &[Val], b: &[Val]) -> ValR {
        let mut res = Vec::new();
        for ai in 0..a.len() {
            let mut found = !b.is_empty();
            for (bi, y) in b.iter().enumerate() {
                let eq = match a.get(ai + bi) {
                    Some(x) => x.eq_at(y, 0, MAX_EQUAL_DEPTH).map_err(|_| too_deep_eq())?,
                    None => false,
                };
                if !eq {
                    found = false;
                }
            }
            if found {
                res.push(Val::from(ai));
            }
        }
        Ok(Val::Arr(res.into()))
    }

    /// `self | .[start:end]`, as jq's `jv_get` with a slice object `key`.
    fn get_slice(self, start: Option<&Val>, end: Option<&Val>, key: Option<&Val>) -> ValR {
        match self {
            Val::Null => Ok(Val::Null),
            Val::Arr(a) => {
                let (s, e) = parse_slice(a.len(), start, end)?;
                Ok(Val::Arr(a[s..e].to_vec().into()))
            }
            Val::TStr(b) => Ok(Val::utf8_str(b.slice(str_bounds(&b, true, start, end)?))),
            Val::BStr(b) => Ok(Val::byte_str(b.slice(str_bounds(&b, false, start, end)?))),
            t => {
                let key = key.cloned().unwrap_or_else(|| slice_key(start, end));
                Err(index_err(&t, &key))
            }
        }
    }

    /// Update `self | .[start:end]` with the first output of `f`.
    fn map_slice<'a, I: Iterator<Item = ValX<'a>>>(
        self,
        start: Option<&Val>,
        end: Option<&Val>,
        key: Option<&Val>,
        opt: path::Opt,
        f: impl Fn(Self) -> I,
    ) -> ValX<'a> {
        let key = || key.cloned().unwrap_or_else(|| slice_key(start, end));
        match self {
            Val::Null => match f(Val::Null).next().transpose()? {
                Some(y) => Ok(Val::Null.set(&key(), y)?),
                None => Ok(Val::Null),
            },
            Val::Arr(mut a) => {
                let (s, e) = match parse_slice(a.len(), start, end) {
                    Ok(se) => se,
                    Err(e) => return opt.fail(Val::Arr(a), |_| Exn::from(e)),
                };
                let sub = Val::Arr(a[s..e].to_vec().into());
                match f(sub).next().transpose()? {
                    Some(Val::Arr(y)) => {
                        Rc::make_mut(&mut a).splice(s..e, y.iter().cloned());
                    }
                    Some(_) => return Err(err("A slice of an array can only be assigned another array"))?,
                    None => {
                        Rc::make_mut(&mut a).drain(s..e);
                    }
                }
                Ok(Val::Arr(a))
            }
            t @ (Val::TStr(_) | Val::BStr(_)) => {
                let sub = match t.clone().get_slice(start, end, Some(&key())) {
                    Ok(sub) => sub,
                    Err(e) => return opt.fail(t, |_| Exn::from(e)),
                };
                match f(sub).next().transpose()? {
                    Some(_) => Err(err("Cannot update string slices"))?,
                    None => Err(err("Cannot delete fields from string"))?,
                }
            }
            t => {
                let e = index_err(&t, &key());
                opt.fail(t, |_| Exn::from(e))
            }
        }
    }

    /// `self | .[k] = v`, as jq's `jv_set`.
    pub fn set(self, k: &Self, v: Self) -> ValR {
        match (self, k) {
            (t @ (Val::Obj(_) | Val::Null), Val::TStr(_) | Val::BStr(_)) => {
                let mut o = match t {
                    Val::Obj(o) => o,
                    _ => Rc::default(),
                };
                Rc::make_mut(&mut o).insert(k.clone(), v);
                Ok(Val::Obj(o))
            }
            (Val::Arr(_) | Val::Null, Val::Num(n)) if n.is_nan() => {
                Err(err("Cannot set array element at NaN index"))
            }
            (t @ (Val::Arr(_) | Val::Null), Val::Num(n)) => {
                let mut a = match t {
                    Val::Arr(a) => a,
                    _ => Rc::default(),
                };
                array_set(Rc::make_mut(&mut a), int_index(n.as_f64()), v)?;
                Ok(Val::Arr(a))
            }
            (t @ (Val::Arr(_) | Val::Null), Val::Obj(o)) => {
                let mut a = match t {
                    Val::Arr(a) => a,
                    _ => Rc::default(),
                };
                let start = o.get(&Val::utf8_str("start"));
                let end = o.get(&Val::utf8_str("end"));
                let (s, e) = parse_slice(a.len(), start, end)?;
                match v {
                    Val::Arr(y) => {
                        Rc::make_mut(&mut a).splice(s..e, y.iter().cloned());
                        Ok(Val::Arr(a))
                    }
                    _ => Err(err("A slice of an array can only be assigned another array")),
                }
            }
            (Val::TStr(_) | Val::BStr(_), Val::Obj(_)) => Err(err("Cannot update string slices")),
            (t, k) => Err(err(format_args!(
                "Cannot update field at {} index of {}",
                msg::kind_name(k),
                msg::kind_name(&t)
            ))),
        }
    }

    /// Delete the children at the sorted `keys`, as jq's `jv_dels`.
    fn dels(self, keys: &[Val]) -> ValR {
        if keys.is_empty() {
            return Ok(self);
        }
        match self {
            Val::Null => Ok(Val::Null),
            Val::Arr(a) => {
                let len = a.len() as i64;
                let mut del = alloc::vec![false; a.len()];
                let mut mark = |i: i64| {
                    if (0..len).contains(&i) {
                        del[i as usize] = true;
                    }
                };
                for k in keys {
                    match k {
                        Val::Num(n) if n.is_nan() => (),
                        Val::Num(n) => {
                            let d = n.as_f64();
                            mark(if d < 0.0 { len + int_index(d) } else { int_index(d) })
                        }
                        Val::Obj(o) => {
                            let start = o.get(&Val::utf8_str("start"));
                            let end = o.get(&Val::utf8_str("end"));
                            let (s, e) = parse_slice(a.len(), start, end)?;
                            (s..e).for_each(|i| mark(i as i64));
                        }
                        k => {
                            return Err(err(format_args!(
                                "Cannot delete {} element of array",
                                msg::kind_name(k)
                            )))
                        }
                    }
                }
                let mut i = 0;
                let mut a = a;
                Rc::make_mut(&mut a).retain(|_| {
                    i += 1;
                    !del[i - 1]
                });
                Ok(Val::Arr(a))
            }
            Val::Obj(mut o) => {
                for k in keys {
                    if !matches!(k, Val::TStr(_) | Val::BStr(_)) {
                        return Err(err(format_args!(
                            "Cannot delete {} field of object",
                            msg::kind_name(k)
                        )));
                    }
                    Rc::make_mut(&mut o).shift_remove(k);
                }
                Ok(Val::Obj(o))
            }
            t => Err(err(format_args!("Cannot delete fields from {}", msg::kind_name(&t)))),
        }
    }

    fn path_array(path: &Self) -> Result<&[Val], Error> {
        match path {
            Val::Arr(p) if p.len() > MAX_PATH_DEPTH => Err(err("Path too deep")),
            Val::Arr(p) => Ok(p),
            _ => Err(err("Path must be specified as an array")),
        }
    }

    /// `self | getpath(path)`, as jq's `jv_getpath`.
    pub fn getpath(self, path: &Self) -> ValR {
        Self::path_array(path)?.iter().try_fold(self, |v, k| v.get(k))
    }

    /// `self | setpath(path; v)`, as jq's `jv_setpath`.
    pub fn setpath(self, path: &Self, v: Self) -> ValR {
        let path = Self::path_array(path)?;
        let mut parents = Vec::with_capacity(path.len());
        let mut cur = self;
        for k in path {
            let sub = cur.clone().get(k)?;
            // drop the parent's reference to the child, so that the child
            // can be updated in place (as jq does)
            if !matches!(k, Val::Obj(_)) {
                cur = cur.set(k, Val::Null)?;
            }
            parents.push(cur);
            cur = sub;
        }
        let mut cur = v;
        for (parent, k) in parents.into_iter().zip(path).rev() {
            cur = parent.set(k, cur)?;
        }
        Ok(cur)
    }

    /// `self | delpaths(paths)`, as jq's `jv_delpaths`.
    pub fn delpaths(self, paths: &Self) -> ValR {
        let paths = match paths {
            Val::Arr(p) => p,
            _ => return Err(err("Paths must be specified as an array")),
        };
        let mut paths: Vec<&Val> = paths.iter().collect();
        let mut too_deep = false;
        paths.sort_by(|x, y| {
            x.cmp_at(y, 0, MAX_CMP_DEPTH, false).unwrap_or_else(|_| {
                too_deep = true;
                Ordering::Equal
            })
        });
        if too_deep {
            return Err(too_deep_cmp());
        }
        let mut ps = Vec::with_capacity(paths.len());
        for p in paths {
            match p {
                Val::Arr(p) if p.len() > MAX_PATH_DEPTH => return Err(err("Path too deep")),
                Val::Arr(p) => ps.push(&p[..]),
                p => {
                    return Err(err(format_args!(
                        "Path must be specified as array, not {}",
                        msg::kind_name(p)
                    )))
                }
            }
        }
        match ps.first() {
            None => Ok(self),
            Some(p) if p.is_empty() => Ok(Val::Null),
            Some(_) => self.delpaths_sorted(&ps, 0),
        }
    }

    /// Delete sorted `paths` that all are longer than `start`,
    /// as jq's `delpaths_sorted`.
    fn delpaths_sorted(mut self, paths: &[&[Val]], start: usize) -> ValR {
        let mut delkeys = Vec::new();
        let mut i = 0;
        while i < paths.len() {
            let key = &paths[i][start];
            let mut j = i + 1;
            while j < paths.len() && paths[j][start].eq_at(key, 0, MAX_EQUAL_DEPTH).unwrap_or(false) {
                j += 1;
            }
            if paths[i].len() == start + 1 {
                delkeys.push(key.clone());
            } else {
                let sub = self.clone().get(key)?;
                if !matches!(sub, Val::Null) {
                    let sub = sub.delpaths_sorted(&paths[i..j], start + 1)?;
                    self = self.set(key, sub)?;
                }
            }
            i = j;
        }
        self.dels(&delkeys)
    }
}

impl From<bool> for Val {
    fn from(b: bool) -> Self {
        Self::Bool(b)
    }
}

impl From<isize> for Val {
    fn from(i: isize) -> Self {
        Self::Num(Num::Int(i))
    }
}

impl From<usize> for Val {
    fn from(i: usize) -> Self {
        Self::Num(Num::from_integral(i))
    }
}

impl From<f64> for Val {
    fn from(f: f64) -> Self {
        Self::Num(Num::Float(f))
    }
}

impl From<String> for Val {
    fn from(s: String) -> Self {
        Self::utf8_str(Bytes::from_owner(s))
    }
}

impl From<val::Range<Val>> for Val {
    /// The object `{"start": .., "end": ..}` that jq uses as path of a slice.
    fn from(r: val::Range<Val>) -> Self {
        slice_key(r.start.as_ref(), r.end.as_ref())
    }
}

impl FromIterator<Self> for Val {
    fn from_iter<T: IntoIterator<Item = Self>>(iter: T) -> Self {
        Self::Arr(Rc::new(iter.into_iter().collect()))
    }
}

impl core::ops::Add for Val {
    type Output = ValR;
    /// jq's `binop_plus`.
    fn add(self, rhs: Self) -> Self::Output {
        let concat_bytes = |l, r| {
            let mut buf = BytesMut::from(l);
            buf.put(r);
            buf
        };
        use Val::*;
        match (self, rhs) {
            // `null` is a neutral element for addition
            (Null, x) | (x, Null) => Ok(x),
            (Num(x), Num(y)) => Ok(Val::from(x.as_f64() + y.as_f64())),
            (BStr(l), BStr(r)) => Ok(Val::byte_str(concat_bytes(*l, r))),
            (TStr(l), TStr(r)) => Ok(Val::utf8_str(concat_bytes(*l, r))),
            (Arr(mut l), Arr(r)) => {
                Rc::make_mut(&mut l).extend(r.iter().cloned());
                Ok(Arr(l))
            }
            (Obj(mut l), Obj(r)) => {
                Rc::make_mut(&mut l).extend(r.iter().map(|(k, v)| (k.clone(), v.clone())));
                Ok(Obj(l))
            }
            (l, r) => Err(msg::type_error2(&l, &r, "cannot be added")),
        }
    }
}

impl core::ops::Sub for Val {
    type Output = ValR;
    /// jq's `binop_minus`.
    fn sub(self, rhs: Self) -> Self::Output {
        match (self, rhs) {
            (Self::Num(x), Self::Num(y)) => Ok(Val::from(x.as_f64() - y.as_f64())),
            (Self::Arr(l), Self::Arr(r)) => {
                let mut out = Vec::with_capacity(l.len());
                for x in l.iter() {
                    let mut keep = true;
                    for y in r.iter() {
                        if x.eq_at(y, 0, MAX_EQUAL_DEPTH).map_err(|_| too_deep_eq())? {
                            keep = false;
                            break;
                        }
                    }
                    if keep {
                        out.push(x.clone());
                    }
                }
                Ok(Self::Arr(out.into()))
            }
            (l, r) => Err(msg::type_error2(&l, &r, "cannot be subtracted")),
        }
    }
}

/// Repeat a string `n` times, as jq's `jv_string_repeat`.
fn repeat(s: &[u8], n: f64) -> ValR {
    if n < 0.0 || n.is_nan() {
        return Ok(Val::Null);
    }
    let n = if n > f64::from(i32::MAX) { i32::MAX as u64 } else { n as u64 };
    let len = s.len() as u64 * n;
    // `INT_MAX - sizeof(jvp_string) / 2`
    if len >= i32::MAX as u64 - 8 {
        return Err(err("Repeat string result too long"));
    }
    Ok(Val::utf8_str(s.repeat(n as usize)))
}

impl core::ops::Mul for Val {
    type Output = ValR;
    /// jq's `binop_multiply`.
    fn mul(self, rhs: Self) -> Self::Output {
        use Val::*;
        match (self, rhs) {
            (Num(x), Num(y)) => Ok(Val::from(x.as_f64() * y.as_f64())),
            (TStr(s) | BStr(s), Num(n)) | (Num(n), TStr(s) | BStr(s)) => repeat(&s, n.as_f64()),
            (Obj(mut l), Obj(r)) => {
                obj_merge(&mut l, r, 0)?;
                Ok(Obj(l))
            }
            (l, r) => Err(msg::type_error2(&l, &r, "cannot be multiplied")),
        }
    }
}

/// Split a string by a given separator string, as jq's `jv_string_split`.
fn split<'a>(s: &'a [u8], sep: &'a [u8]) -> Box<dyn Iterator<Item = &'a [u8]> + 'a> {
    if s.is_empty() {
        Box::new(core::iter::empty())
    } else if sep.is_empty() {
        // Rust's `split` function with an empty separator ("")
        // yields an empty string as first and last result
        // to prevent this, we are using `chars` instead
        Box::new(s.char_indices().map(|(start, end, _)| &s[start..end]))
    } else {
        Box::new(s.split_str(sep))
    }
}

impl core::ops::Div for Val {
    type Output = ValR;
    /// jq's `binop_divide`.
    fn div(self, rhs: Self) -> Self::Output {
        let fs = |x: Bytes, y: Bytes, into: fn(Bytes) -> Val| {
            split(&x, &y).map(|s| into(x.slice_ref(s))).collect()
        };
        match (self, rhs) {
            (Self::Num(x), Self::Num(y)) if y.as_f64() == 0.0 => Err(msg::type_error2(
                &Self::Num(x),
                &Self::Num(y),
                "cannot be divided because the divisor is zero",
            )),
            (Self::Num(x), Self::Num(y)) => Ok(Val::from(x.as_f64() / y.as_f64())),
            (Self::TStr(x), Self::TStr(y)) => Ok(fs(*x, *y, Val::utf8_str)),
            (Self::BStr(x), Self::BStr(y)) => Ok(fs(*x, *y, Val::byte_str)),
            (l, r) => Err(msg::type_error2(&l, &r, "cannot be divided")),
        }
    }
}

/// Convert a double to `intmax_t` as jq's `dtoi`, saturating.
fn dtoi(n: f64) -> i64 {
    n as i64
}

impl core::ops::Rem for Val {
    type Output = ValR;
    /// jq's `binop_mod`: the remainder of the operands truncated to integers.
    fn rem(self, rhs: Self) -> Self::Output {
        match (self, rhs) {
            (Self::Num(x), Self::Num(y)) => {
                let (a, b) = (x.as_f64(), y.as_f64());
                if a.is_nan() || b.is_nan() {
                    return Ok(Val::from(f64::NAN));
                }
                let bi = dtoi(b);
                if bi == 0 {
                    return Err(msg::type_error2(
                        &Self::Num(x),
                        &Self::Num(y),
                        "cannot be divided (remainder) because the divisor is zero",
                    ));
                }
                let r = if bi == -1 { 0 } else { dtoi(a) % bi };
                Ok(Val::from(r as f64))
            }
            (l, r) => Err(msg::type_error2(&l, &r, "cannot be divided (remainder)")),
        }
    }
}

impl core::ops::Neg for Val {
    type Output = ValR;
    /// jq's `f_negate`.
    fn neg(self) -> Self::Output {
        match self {
            Self::Num(n) => Ok(Self::Num(-n)),
            x => Err(msg::type_error(&x, "cannot be negated")),
        }
    }
}

impl PartialOrd for Val {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Val {
    /// Order as jq's `jv_cmp`, except that NaN equals NaN.
    fn cmp(&self, other: &Self) -> Ordering {
        self.cmp_at(other, 0, usize::MAX - 2, false).unwrap_or(Ordering::Equal)
    }
}

impl PartialEq for Val {
    /// Equality as jq's `jv_equal`.
    fn eq(&self, other: &Self) -> bool {
        self.eq_at(other, 0, usize::MAX - 2).unwrap_or(false)
    }
}

impl Eq for Val {}

impl Hash for Val {
    fn hash<H: Hasher>(&self, state: &mut H) {
        fn hash_with(u: u8, x: impl Hash, state: &mut impl Hasher) {
            state.write_u8(u);
            x.hash(state)
        }
        match self {
            Self::Num(n) => n.hash(state),
            // Num::hash() starts its hash with a 0, so we start with 2 here
            Self::Null => state.write_u8(2),
            Self::Bool(b) => state.write_u8(if *b { 3 } else { 4 }),
            Self::BStr(b) | Self::TStr(b) => hash_with(5, b, state),
            Self::Arr(a) => hash_with(6, a, state),
            Self::Obj(o) => {
                state.write_u8(7);
                // this is similar to what happens in `Val::cmp`
                let mut kvs: Vec<_> = o.iter().collect();
                kvs.sort_by_key(|(k, _v)| *k);
                kvs.iter().for_each(|(k, v)| (k, v).hash(state));
            }
        }
    }
}

/// Display bytes as valid UTF-8 string.
///
/// This maps invalid UTF-8 to the Unicode replacement character.
pub fn bstr(s: &(impl core::convert::AsRef<[u8]> + ?Sized)) -> impl fmt::Display + '_ {
    BStr::new(s)
}

impl fmt::Display for Val {
    /// Write the value as jq's compact dump (`jv_dump_string`).
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write::format(f, &write::Pp::default(), 0, self)
    }
}
