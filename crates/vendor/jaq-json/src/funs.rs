use crate::{read, Error, Val, ValR};
use alloc::{boxed::Box, vec::Vec};
use bstr::ByteSlice;
use bytes::Bytes;
use jaq_core::box_iter::BoxIter;
use jaq_core::native::{bome, run, unary, v, Filter, Fun};
use jaq_core::{DataT, RunPtr};
use jaq_std::ValT as _;

impl Val {
    /// Return 0 for null, the absolute value for numbers, and
    /// the length for strings, arrays, and objects.
    ///
    /// Fail on booleans.
    fn length(&self) -> ValR {
        match self {
            Val::Null => Ok(Val::from(0usize)),
            Val::Num(n) => Ok(Val::Num(n.length())),
            Val::TStr(s) => Ok(Val::from(s.chars().count())),
            Val::BStr(b) => Ok(Val::from(b.len())),
            Val::Arr(a) => Ok(Val::from(a.len())),
            Val::Obj(o) => Ok(Val::from(o.len())),
            Val::Bool(_) => Err(crate::msg::type_error(self, "has no length")),
        }
    }

    /// jq's `jvp_contains`: `None` if the values nest deeper than jq allows.
    fn contains(&self, other: &Self, depth: usize) -> Option<bool> {
        const MAX_CONTAINS_DEPTH: usize = 10000;
        if depth > MAX_CONTAINS_DEPTH {
            return None;
        }
        Some(match (self, other) {
            (Self::BStr(l) | Self::TStr(l), Self::BStr(r) | Self::TStr(r)) => l.contains_str(&**r),
            (Self::Obj(l), Self::Obj(r)) => {
                for (k, r) in r.iter() {
                    match l.get(k) {
                        Some(l) => {
                            if !l.contains(r, depth + 1)? {
                                return Some(false);
                            }
                        }
                        None => return Some(false),
                    }
                }
                true
            }
            (Self::Arr(l), Self::Arr(r)) => {
                for r in r.iter() {
                    let mut found = false;
                    for l in l.iter() {
                        if l.contains(r, depth + 1)? {
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        return Some(false);
                    }
                }
                true
            }
            _ => self == other,
        })
    }

    /// jq's `jv_has`.
    fn has(&self, k: &Self) -> ValR {
        match (self, k) {
            (Val::Null, _) => Ok(Val::Bool(false)),
            (Val::Obj(o), Val::TStr(_) | Val::BStr(_)) => Ok(o.contains_key(k).into()),
            (Val::Arr(a), Val::Num(n)) => {
                let i = n.as_f64();
                // C's conversion truncates; NaN is no index
                Ok((!i.is_nan() && i >= 0.0 && (i as i64 as usize) < a.len()).into())
            }
            _ => Err(Error::str(format_args!(
                "Cannot check whether {} has a {} key",
                crate::msg::kind_name(self),
                crate::msg::kind_name(k)
            ))),
        }
    }

    /// jq's `keys` and `keys_unsorted`.
    fn keys(&self, sorted: bool) -> ValR {
        match self {
            Val::Obj(o) => {
                let mut ks: Vec<_> = o.keys().cloned().collect();
                if sorted {
                    ks.sort_by(|a, b| a.as_bytes().cmp(&b.as_bytes()));
                }
                Ok(ks.into_iter().collect())
            }
            Val::Arr(a) => Ok((0..a.len()).map(|i| Val::from(i as isize)).collect()),
            _ => Err(crate::msg::type_error(self, "has no keys")),
        }
    }

    fn as_bytes_owned(&self) -> Option<Bytes> {
        match self {
            Self::BStr(b) | Self::TStr(b) => Some(*b.clone()),
            _ => None,
        }
    }

    fn as_utf8_bytes_owned(&self) -> Option<Bytes> {
        self.is_utf8_str().then(|| self.as_bytes_owned()).flatten()
    }

    /// Return bytes if the value is a (byte or text) string.
    pub fn try_as_bytes_owned(&self) -> Result<Bytes, Error> {
        self.as_bytes_owned()
            .ok_or_else(|| Error::typ(self.clone(), "string"))
    }

    /// Return bytes if the value is a text string.
    pub fn try_as_utf8_bytes_owned(&self) -> Result<Bytes, Error> {
        self.as_utf8_bytes_owned()
            .ok_or_else(|| Error::typ(self.clone(), "string"))
    }
}

self_cell::self_cell!(
    struct BytesValRs {
        owner: Bytes,

        #[not_covariant]
        dependent: ValRs,
    }
);

impl Iterator for BytesValRs {
    type Item = ValR;
    fn next(&mut self) -> Option<Self::Item> {
        self.with_dependent_mut(|_owner, iter| iter.next())
    }
}

type ValRs<'a> = BoxIter<'a, ValR>;

/// Apply a function to bytes and yield the resulting value results.
pub fn bytes_valrs(b: Bytes, f: impl FnOnce(&[u8]) -> ValRs) -> ValRs<'static> {
    Box::new(BytesValRs::new(b, |b| f(b)))
}

/// Functions of the standard library.
pub fn funs<D: for<'a> DataT<V<'a> = Val>>() -> impl Iterator<Item = Fun<D>> {
    base().into_vec().into_iter().map(run)
}

fn base<D: for<'a> DataT<V<'a> = Val>>() -> Box<[Filter<RunPtr<D>>]> {
    Box::new([
        ("fromjson", v(0), |cv| {
            // jq's `f_json_parse`
            bome(match &cv.1 {
                Val::TStr(s) | Val::BStr(s) => read::parse_single(s).map_err(Error::str),
                v => Err(crate::msg::type_error(v, "only strings can be parsed")),
            })
        }),
        ("tojson", v(0), |cv| bome(Ok(Val::utf8_str(cv.1.to_json())))),
        ("tostring", v(0), |cv| bome(Ok(jaq_core::ValT::into_string(cv.1)))),
        ("length", v(0), |cv| bome(cv.1.length())),
        ("type", v(0), |cv| bome(Ok(Val::utf8_str(crate::msg::kind_name(&cv.1).as_bytes())))),
        ("keys", v(0), |cv| bome(cv.1.keys(true))),
        ("keys_unsorted", v(0), |cv| bome(cv.1.keys(false))),
        ("contains", v(1), |cv| {
            unary(cv, |a, b| {
                // jq's kinds: `true` and `false` differ
                let kind = |v: &Val| match v {
                    Val::Null => 0,
                    Val::Bool(false) => 1,
                    Val::Bool(true) => 2,
                    Val::Num(_) => 3,
                    Val::BStr(_) | Val::TStr(_) => 4,
                    Val::Arr(_) => 5,
                    Val::Obj(_) => 6,
                };
                if kind(&a) != kind(&b) {
                    return Err(crate::msg::type_error2(&a, &b, "cannot have their containment checked"));
                }
                a.contains(&b, 0)
                    .map(Val::from)
                    .ok_or_else(|| Error::str("Containment check too deep"))
            })
        }),
        ("has", v(1), |cv| unary(cv, |v, k| v.has(&k))),
        ("setpath", v(2), |mut cv| {
            let x = cv.0.pop_var();
            let path = cv.0.pop_var();
            bome(cv.1.setpath(&path, x))
        }),
        ("delpaths", v(1), |cv| unary(cv, |v, paths| v.delpaths(&paths))),
        ("bsearch", v(1), |cv| {
            unary(cv, move |a, x| {
                let xs = a
                    .as_arr()
                    .map_err(|_| crate::msg::type_error(&a, "cannot be searched from"))?;
                let (mut start, mut end) = (0, xs.len());
                while start < end {
                    let mid = start + (end - start) / 2;
                    match x.try_cmp(&xs[mid])? {
                        core::cmp::Ordering::Equal => return Ok(Val::from(mid as isize)),
                        core::cmp::Ordering::Less => end = mid,
                        core::cmp::Ordering::Greater => start = mid + 1,
                    }
                }
                Ok(Val::from(-1 - start as isize))
            })
        }),
    ])
}
