//! Paths and their parts.

use crate::box_iter::box_once;
use crate::val::{ValRs, ValT};
use crate::RcList;
use alloc::{boxed::Box, vec::Vec};

/// Path such as `.[].a?[1:]`.
#[derive(Clone, Debug)]
pub struct Path<F>(pub Vec<(Part<F>, Opt)>);

/// Part of a path, such as `[]`, `a`, and `[1:]` in `.[].a?[1:]`.
#[derive(Clone, Debug)]
pub enum Part<I> {
    /// Access arrays with integer and objects with string indices
    Index(I),
    /// Iterate over arrays with optional range bounds and over objects without bounds
    /// If both are `None`, return iterator over whole array/object
    Range(Option<I>, Option<I>),
}

/// Optionality of a path part, i.e. whether `?` is present.
///
/// For example, `[] | .a` fails with an error, while `[] | .a?` returns nothing.
/// By default, path parts are *essential*, meaning that they fail.
/// Annotating them with `?` makes them *optional*.
#[derive(Copy, Clone, Debug)]
pub enum Opt {
    /// Return nothing if the input cannot be accessed with the path
    Optional,
    /// Fail if the input cannot be accessed with the path
    Essential,
}

impl<I> Default for Part<I> {
    fn default() -> Self {
        Self::Range(None, None)
    }
}

impl Opt {
    /// If `self` is optional, return `x`, else fail with `f(x)`.
    pub fn fail<T, E>(self, x: T, f: impl FnOnce(T) -> E) -> Result<T, E> {
        match self {
            Self::Optional => Ok(x),
            Self::Essential => Err(f(x)),
        }
    }
}

impl<'a, V: ValT + 'a> Part<V> {
    /// Error of applying the part to `v` in a path expression where `v` is not at a path.
    pub(crate) fn not_at_path(&self, v: &V) -> crate::Error<V> {
        match self {
            Self::Index(idx) => crate::Error::path_access(idx, v),
            Self::Range(None, None) => crate::Error::path_iter(v),
            Self::Range(from, upto) => crate::Error::path_access(&V::from(from.clone()..upto.clone()), v),
        }
    }

    pub(crate) fn run(&self, v: V) -> ValRs<'a, V> {
        match self {
            Self::Index(idx) => box_once(v.index(idx)),
            Self::Range(None, None) => Box::new(v.values()),
            Self::Range(from, upto) => box_once(v.range(from.as_ref()..upto.as_ref())),
        }
    }

    pub(crate) fn paths(&self, (v, p): (V, RcList<V>)) -> ValRs<'a, (V, RcList<V>), V> {
        match self {
            Self::Index(idx) => box_once(v.index(idx).map(|v| (v, p.cons(idx.clone())))),
            Self::Range(None, None) => Box::new(
                v.key_values()
                    .map(move |kv| kv.map(|(k, v)| (v, p.clone().cons(k)))),
            ),
            Self::Range(from, upto) => box_once(
                v.range(from.as_ref()..upto.as_ref())
                    .map(|v| (v, p.cons(V::from(from.clone()..upto.clone())))),
            ),
        }
    }

}

impl<T> Path<T> {
    pub(crate) fn map_ref<'a, U>(&'a self, mut f: impl FnMut(&'a T) -> U) -> Path<U> {
        Path(self.0.iter().map(|(part, opt)| {
            let part = match part {
                Part::Index(i) => Part::Index(f(i)),
                Part::Range(lo, hi) => Part::Range(lo.as_ref().map(&mut f), hi.as_ref().map(&mut f)),
            };
            (part, *opt)
        }).collect())
    }
}

impl<T> Part<T> {
    /// Apply a function to the contained indices.
    pub(crate) fn map<U, F: FnMut(T) -> U>(self, mut f: F) -> Part<U> {
        use Part::{Index, Range};
        match self {
            Index(i) => Index(f(i)),
            Range(from, upto) => Range(from.map(&mut f), upto.map(&mut f)),
        }
    }
}

impl<T, E> Part<Result<T, E>> {
    pub(crate) fn transpose(self) -> Result<Part<T>, E> {
        match self {
            Self::Index(i) => Ok(Part::Index(i?)),
            Self::Range(from, upto) => Ok(Part::Range(from.transpose()?, upto.transpose()?)),
        }
    }
}

impl<F> From<Part<F>> for Path<F> {
    fn from(p: Part<F>) -> Self {
        Self(Vec::from([(p, Opt::Essential)]))
    }
}
