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
mod update;
pub mod msg;
#[macro_use]
pub mod write;
pub mod read;

#[cfg(all(test, feature = "std"))]
mod tests;

use alloc::{borrow::ToOwned, boxed::Box, string::String, vec::Vec};
use bstr::{BStr, ByteSlice};
use bytes::{BufMut, Bytes, BytesMut};
use core::cmp::Ordering;
use core::fmt;
use core::hash::{Hash, Hasher};
use jaq_core::box_iter::box_once;
use jaq_core::{load, ops, path, val};

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
    Arr(ArrData),
    /// Object
    Obj(ObjData),
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

/// Storage of an array value.
///
/// This dereferences to the `Rc<Vec<Val>>` it wraps, so array operations can
/// share and copy-on-write the underlying vector as before. Unlike a plain
/// `Rc`, dropping it frees nested values iteratively, so freeing a deeply
/// nested value never recurses on the native stack.
#[derive(Clone, Debug, Default)]
pub struct ArrData(Rc<Vec<Val>>);

impl core::ops::Deref for ArrData {
    type Target = Rc<Vec<Val>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl core::ops::DerefMut for ArrData {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl From<Vec<Val>> for ArrData {
    fn from(v: Vec<Val>) -> Self {
        Self(Rc::new(v))
    }
}

impl FromIterator<Val> for ArrData {
    fn from_iter<T: IntoIterator<Item = Val>>(iter: T) -> Self {
        Self(Rc::new(iter.into_iter().collect()))
    }
}

impl Hash for ArrData {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state)
    }
}

impl ArrData {
    /// Consume `self` and return the vector, cloning it first if it is shared.
    fn into_vec(mut self) -> Vec<Val> {
        Rc::try_unwrap(core::mem::take(&mut self.0)).unwrap_or_else(|a| (*a).clone())
    }
}

impl Drop for ArrData {
    fn drop(&mut self) {
        if let Some(v) = Rc::get_mut(&mut self.0) {
            if !v.is_empty() {
                drop_values(Work::Arr(core::mem::take(v)));
            }
        }
    }
}

/// Storage of an object value; see [`ArrData`].
#[derive(Clone, Debug, Default)]
pub struct ObjData(Rc<Map<Val, Val>>);

impl core::ops::Deref for ObjData {
    type Target = Rc<Map<Val, Val>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl core::ops::DerefMut for ObjData {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl From<Map<Val, Val>> for ObjData {
    fn from(m: Map<Val, Val>) -> Self {
        Self(Rc::new(m))
    }
}

impl ObjData {
    /// Consume `self` and return the map, cloning it first if it is shared.
    fn into_map(mut self) -> Map<Val, Val> {
        Rc::try_unwrap(core::mem::take(&mut self.0)).unwrap_or_else(|a| (*a).clone())
    }
}

impl Drop for ObjData {
    fn drop(&mut self) {
        if let Some(m) = Rc::get_mut(&mut self.0) {
            if !m.is_empty() {
                drop_values(Work::Obj(core::mem::take(m)));
            }
        }
    }
}

/// A container whose children still need to be dropped (see [`Val`]'s drop).
enum Work {
    Arr(Vec<Val>),
    Obj(Map<Val, Val>),
}

/// Free `w` and every container nested in it without recursing on the stack.
fn drop_values(w: Work) {
    let mut stack = Vec::new();
    stack.push(w);
    while let Some(w) = stack.pop() {
        match w {
            Work::Arr(vs) => {
                for v in vs {
                    take_container(v, &mut stack);
                }
            }
            Work::Obj(m) => {
                for (k, v) in m {
                    take_container(k, &mut stack);
                    take_container(v, &mut stack);
                }
            }
        }
    }
}

/// If `v` uniquely owns a container, move its children onto `stack` so that
/// [`drop_values`] frees them iteratively; otherwise `v` merely drops.
fn take_container(v: Val, stack: &mut Vec<Work>) {
    match v {
        Val::Arr(mut a) => {
            if let Some(vs) = Rc::get_mut(&mut a.0) {
                if !vs.is_empty() {
                    stack.push(Work::Arr(core::mem::take(vs)));
                }
            }
        }
        Val::Obj(mut o) => {
            if let Some(m) = Rc::get_mut(&mut o.0) {
                if !m.is_empty() {
                    stack.push(Work::Obj(core::mem::take(m)));
                }
            }
        }
        _ => {}
    }
}

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
            Self::Arr(a) => Box::new(a.into_vec().into_iter().enumerate().map(arr_idx)),
            Self::Obj(o) => Box::new(o.into_map().into_iter().map(Ok)),
            _ => box_once(Err(iter_err(&self))),
        }
    }

    fn values(self) -> Box<dyn Iterator<Item = ValR>> {
        match self {
            Self::Arr(a) => Box::new(a.into_vec().into_iter().map(Ok)),
            Self::Obj(o) => Box::new(o.into_map().into_iter().map(|(_k, v)| Ok(v))),
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

    fn update_values(self, opt: path::Opt) -> jaq_core::ValR<update::Cursor, Self> {
        update::values(self, opt)
    }

    fn update_index(self, index: &Self, opt: path::Opt) -> jaq_core::ValR<update::Cursor, Self> {
        update::index(self, index, opt)
    }

    fn update_range(self, range: val::Range<&Self>, opt: path::Opt) -> jaq_core::ValR<update::Cursor, Self> {
        let null = Val::Null;
        let start = range.start.unwrap_or(&null);
        let end = range.end.unwrap_or(&null);
        update::slice(self, Some(start), Some(end), None, opt)
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
            Self::Arr(a) => Ok(a.into_vec().into_iter().collect()),
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
///
/// Nested objects are merged through an explicit stack, so deeply nested
/// objects never recurse on the native stack. It fails with
/// `Object merge too deep` below nesting depth `MAX_MERGE_DEPTH`.
fn obj_merge(l: ObjData, r: ObjData, depth0: usize) -> Result<ObjData, Error> {
    /// One object being merged and its remaining right-hand entries.
    struct Frame {
        map: Map<Val, Val>,
        rhs: indexmap::map::IntoIter<Val, Val>,
        depth: usize,
        /// For a nested merge, the key to store the result under in the
        /// frame below.
        ret_key: Option<Val>,
    }
    let mut stack = Vec::new();
    stack.push(Frame {
        map: l.into_map(),
        rhs: r.into_map().into_iter(),
        depth: depth0,
        ret_key: None,
    });
    loop {
        // Merge right-hand entries into the top frame until either it
        // descends into a nested object or it is done.
        let nested = {
            let top = stack.last_mut().expect("obj_merge stack is never empty");
            let mut nested = None;
            while let Some((k, v)) = top.rhs.next() {
                match (top.map.get_mut(&k), v) {
                    (Some(slot @ Val::Obj(_)), Val::Obj(r)) => {
                        let Val::Obj(l) = core::mem::replace(slot, Val::Null) else {
                            unreachable!()
                        };
                        nested = Some((k, l, r, top.depth + 1));
                        break;
                    }
                    (Some(slot), v) => *slot = v,
                    (None, v) => {
                        top.map.insert(k, v);
                    }
                }
            }
            nested
        };
        match nested {
            Some((k, child_l, child_r, depth)) => {
                if depth > MAX_MERGE_DEPTH {
                    return Err(err("Object merge too deep"));
                }
                stack.push(Frame {
                    map: child_l.into_map(),
                    rhs: child_r.into_map().into_iter(),
                    depth,
                    ret_key: Some(k),
                });
            }
            None => {
                let done = stack.pop().expect("obj_merge stack is never empty");
                match done.ret_key {
                    None => return Ok(done.map.into()),
                    Some(k) => {
                        let parent = stack.last_mut().expect("obj_merge stack is never empty");
                        parent.map.insert(k, Val::Obj(done.map.into()));
                    }
                }
            }
        }
    }
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

    fn as_arr(&self) -> Result<&ArrData, Error> {
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
        /// One comparison in progress: two containers and how far they are
        /// compared.
        enum Frame<'a> {
            Arr {
                x: &'a [Val],
                y: &'a [Val],
                i: usize,
                depth: usize,
            },
            /// Two objects: first their sorted keys as sequences, then their
            /// values by those keys.
            Obj {
                x: &'a Map<Val, Val>,
                y: &'a Map<Val, Val>,
                kx: Vec<&'a Val>,
                ky: Vec<&'a Val>,
                i: usize,
                /// `false` while comparing keys, `true` while comparing values.
                vals: bool,
                depth: usize,
            },
        }
        let mut stack: Vec<Frame> = Vec::new();
        let mut cur: Option<(&Self, &Self, usize)> = Some((self, other, depth));
        loop {
            if let Some((a, b, d)) = cur.take() {
                if d > max {
                    return Err(TooDeep);
                }
                let (ka, kb) = (kind_rank(a), kind_rank(b));
                if ka != kb {
                    return Ok(ka.cmp(&kb));
                }
                match (a, b) {
                    (Self::Num(x), Self::Num(y)) => {
                        let ord = if nan_less { x.jq_cmp(y) } else { x.total_cmp(y) };
                        if ord != Ordering::Equal {
                            return Ok(ord);
                        }
                    }
                    (Self::BStr(x) | Self::TStr(x), Self::BStr(y) | Self::TStr(y)) => {
                        let ord = x[..].cmp(&y[..]);
                        if ord != Ordering::Equal {
                            return Ok(ord);
                        }
                    }
                    (Self::Arr(x), Self::Arr(y)) => {
                        let (x, y): (&[Val], &[Val]) = (x, y);
                        match (x.is_empty(), y.is_empty()) {
                            (true, true) => {}
                            (true, false) => return Ok(Ordering::Less),
                            (false, true) => return Ok(Ordering::Greater),
                            (false, false) => {
                                stack.push(Frame::Arr { x, y, i: 0, depth: d });
                                cur = Some((&x[0], &y[0], d + 1));
                                continue;
                            }
                        }
                    }
                    (Self::Obj(x), Self::Obj(y)) => {
                        if d + 1 > max {
                            return Err(TooDeep);
                        }
                        let mut kx: Vec<&Val> = x.keys().collect();
                        let mut ky: Vec<&Val> = y.keys().collect();
                        kx.sort();
                        ky.sort();
                        match (kx.is_empty(), ky.is_empty()) {
                            (true, true) => {}
                            (true, false) => return Ok(Ordering::Less),
                            (false, true) => return Ok(Ordering::Greater),
                            (false, false) => {
                                let (first_x, first_y) = (kx[0], ky[0]);
                                stack.push(Frame::Obj { x, y, kx, ky, i: 0, vals: false, depth: d });
                                cur = Some((first_x, first_y, d + 2));
                                continue;
                            }
                        }
                    }
                    _ => {}
                }
            }
            // The current comparison came out equal; resume the parent.
            loop {
                {
                    let Some(frame) = stack.last_mut() else { return Ok(Ordering::Equal) };
                    match frame {
                        Frame::Arr { x, y, i, depth } => {
                            let j = *i + 1;
                            match (j < x.len(), j < y.len()) {
                                (true, true) => {
                                    *i = j;
                                    cur = Some((&x[j], &y[j], *depth + 1));
                                    break;
                                }
                                (true, false) => return Ok(Ordering::Greater),
                                (false, true) => return Ok(Ordering::Less),
                                (false, false) => {}
                            }
                        }
                        Frame::Obj { x, y, kx, ky, i, vals, depth } => {
                            let j = *i + 1;
                            if !*vals {
                                match (j < kx.len(), j < ky.len()) {
                                    (true, true) => {
                                        *i = j;
                                        let (p, q) = (kx[j], ky[j]);
                                        cur = Some((p, q, *depth + 2));
                                        break;
                                    }
                                    (true, false) => return Ok(Ordering::Greater),
                                    (false, true) => return Ok(Ordering::Less),
                                    (false, false) => {
                                        // Keys are equal: compare values by key.
                                        *vals = true;
                                        *i = 0;
                                        let first = kx[0];
                                        cur = Some((&x[first], &y[first], *depth + 1));
                                        break;
                                    }
                                }
                            } else if j < kx.len() {
                                *i = j;
                                let k = kx[j];
                                cur = Some((&x[k], &y[k], *depth + 1));
                                break;
                            }
                        }
                    }
                }
                stack.pop();
            }
        }
    }

    /// Equality as jq's `jvp_equal`, failing below nesting depth `max`.
    fn eq_at(&self, other: &Self, depth: usize, max: usize) -> Result<bool, TooDeep> {
        /// One equality check in progress.
        enum Frame<'a> {
            Arr {
                x: &'a [Val],
                y: &'a [Val],
                i: usize,
            },
            /// Comparing the values of `x` with those of `y`, by key.
            Obj {
                y: &'a Map<Val, Val>,
                it: indexmap::map::Iter<'a, Val, Val>,
            },
        }
        let mut stack: Vec<Frame> = Vec::new();
        let mut cur: Option<(&Self, &Self, usize)> = Some((self, other, depth));
        loop {
            if let Some((a, b, d)) = cur.take() {
                if d > max {
                    return Err(TooDeep);
                }
                match (a, b) {
                    (Self::Null, Self::Null) => {}
                    (Self::Bool(x), Self::Bool(y)) => {
                        if x != y {
                            return Ok(false);
                        }
                    }
                    (Self::Num(x), Self::Num(y)) => {
                        if x != y {
                            return Ok(false);
                        }
                    }
                    (Self::BStr(x) | Self::TStr(x), Self::BStr(y) | Self::TStr(y)) => {
                        if x != y {
                            return Ok(false);
                        }
                    }
                    (Self::Arr(x), Self::Arr(y)) => {
                        if x.len() != y.len() {
                            return Ok(false);
                        }
                        if !Rc::ptr_eq(&x.0, &y.0) && !x.is_empty() {
                            let (x, y): (&[Val], &[Val]) = (x, y);
                            stack.push(Frame::Arr { x, y, i: 0 });
                            cur = Some((&x[0], &y[0], d + 1));
                            continue;
                        }
                    }
                    (Self::Obj(x), Self::Obj(y)) => {
                        if !Rc::ptr_eq(&x.0, &y.0) {
                            if x.len() != y.len() {
                                return Ok(false);
                            }
                            if !x.is_empty() {
                                let mut it = x.iter();
                                let (k, a0) = it.next().expect("object is not empty");
                                match y.get(k) {
                                    Some(b0) => {
                                        stack.push(Frame::Obj { y, it });
                                        cur = Some((a0, b0, d + 1));
                                        continue;
                                    }
                                    None => return Ok(false),
                                }
                            }
                        }
                    }
                    _ => return Ok(false),
                }
            }
            // The current values are equal; resume the parent.
            loop {
                let frames = stack.len();
                {
                    let Some(frame) = stack.last_mut() else { return Ok(true) };
                    match frame {
                        Frame::Arr { x, y, i } => {
                            let j = *i + 1;
                            if j < x.len() {
                                *i = j;
                                cur = Some((&x[j], &y[j], depth + frames));
                                break;
                            }
                        }
                        Frame::Obj { y, it } => match it.next() {
                            Some((k, a)) => match y.get(k) {
                                Some(b) => {
                                    cur = Some((a, b, depth + frames));
                                    break;
                                }
                                None => return Ok(false),
                            },
                            None => {}
                        },
                    }
                }
                stack.pop();
            }
        }
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

    /// `self | .[k] = v`, as jq's `jv_set`.
    pub fn set(self, k: &Self, v: Self) -> ValR {
        match (self, k) {
            (t @ (Val::Obj(_) | Val::Null), Val::TStr(_) | Val::BStr(_)) => {
                let mut o = match t {
                    Val::Obj(o) => o,
                    _ => ObjData::default(),
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
                    _ => ArrData::default(),
                };
                array_set(Rc::make_mut(&mut a), int_index(n.as_f64()), v)?;
                Ok(Val::Arr(a))
            }
            (t @ (Val::Arr(_) | Val::Null), Val::Obj(o)) => {
                let mut a = match t {
                    Val::Arr(a) => a,
                    _ => ArrData::default(),
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
    ///
    /// The deletion descends through an explicit stack, so deeply nested
    /// paths never recurse on the native stack.
    fn delpaths_sorted(self, paths: &[&[Val]], start: usize) -> ValR {
        /// One node of the deletion tree.
        struct Frame<'a> {
            node: Val,
            /// paths to delete in `node`, all longer than `start`
            paths: &'a [&'a [Val]],
            start: usize,
            /// index of the next group of `paths` to process
            next: usize,
            /// keys of `node` to delete once its children are done
            delkeys: Vec<Val>,
            /// the key to store the result under in the frame below
            ret_key: Option<Val>,
        }
        let mut stack = Vec::new();
        stack.push(Frame {
            node: self,
            paths,
            start,
            next: 0,
            delkeys: Vec::new(),
            ret_key: None,
        });
        loop {
            // Process the top frame until it must descend into a child.
            let mut descend = None;
            {
                let f = stack.last_mut().expect("delpaths stack is never empty");
                while f.next < f.paths.len() {
                    let i = f.next;
                    let key = &f.paths[i][f.start];
                    let mut j = i + 1;
                    while j < f.paths.len()
                        && f.paths[j][f.start].eq_at(key, 0, MAX_EQUAL_DEPTH).unwrap_or(false)
                    {
                        j += 1;
                    }
                    if f.paths[i].len() == f.start + 1 {
                        f.delkeys.push(key.clone());
                        f.next = j;
                    } else {
                        let paths = f.paths;
                        let start = f.start;
                        let key = key.clone();
                        f.next = j;
                        descend = Some((paths, i, j, start, key));
                        break;
                    }
                }
            }
            match descend {
                Some((paths, i, j, start, key)) => {
                    let node = stack.last().expect("delpaths stack is never empty").node.clone();
                    let sub = node.get(&key)?;
                    if !matches!(sub, Val::Null) {
                        stack.push(Frame {
                            node: sub,
                            paths: &paths[i..j],
                            start: start + 1,
                            next: 0,
                            delkeys: Vec::new(),
                            ret_key: Some(key),
                        });
                    }
                }
                None => {
                    let f = stack.pop().expect("delpaths stack is never empty");
                    let res = f.node.dels(&f.delkeys)?;
                    match f.ret_key {
                        None => return Ok(res),
                        Some(key) => {
                            let parent = stack.last_mut().expect("delpaths stack is never empty");
                            parent.node = parent.node.clone().set(&key, res)?;
                        }
                    }
                }
            }
        }
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
        Self::Arr(iter.into_iter().collect())
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
            (Obj(l), Obj(r)) => Ok(Obj(obj_merge(l, r, 0)?)),
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
