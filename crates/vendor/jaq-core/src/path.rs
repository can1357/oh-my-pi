//! Paths and their parts.

use crate::box_iter::{box_once, flat_map_with, map_with, then, BoxIter};
use crate::val::{ValRs, ValT, ValX, ValXs};
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

impl<'a, U: Clone + 'a, E: Clone + 'a, T: Clone + IntoIterator<Item = Result<U, E>> + 'a> Path<T> {
    pub(crate) fn explode(self) -> impl Iterator<Item = Result<Path<U>, E>> + 'a {
        Path(Vec::new())
            .combinations(self.0.into_iter())
            .map(Path::transpose)
    }
}

impl<'a, U: Clone + 'a> Path<U> {
    fn combinations<I, F>(self, mut iter: I) -> BoxIter<'a, Self>
    where
        I: Iterator<Item = (Part<F>, Opt)> + Clone + 'a,
        F: IntoIterator<Item = U> + Clone + 'a,
    {
        if let Some((part, opt)) = iter.next() {
            let parts = part.into_iter();
            flat_map_with(parts, (self, iter), move |part, (mut prev, iter)| {
                prev.0.push((part, opt));
                prev.combinations(iter)
            })
        } else {
            box_once(self)
        }
    }
}

impl<'a, V: ValT + 'a> Path<V> {
    pub(crate) fn run(self, v: V) -> ValRs<'a, V> {
        run(self.0.into_iter(), v, |part, v| part.run(v))
    }

    pub(crate) fn paths(self, vp: (V, RcList<V>)) -> ValRs<'a, (V, RcList<V>), V> {
        run(self.0.into_iter(), vp, |part, vp| part.paths(vp))
    }

    pub(crate) fn update<F>(mut self, v: V, f: F) -> ValX<'a, V>
    where
        F: Fn(V) -> ValXs<'a, V>,
    {
        if let Some(last) = self.0.pop() {
            update(self.0.into_iter(), last, v, &f)
        } else {
            // should be unreachable
            Ok(v)
        }
    }
}

fn run<'a, V: 'a, T: 'a>(
    mut iter: impl Iterator<Item = (Part<V>, Opt)> + Clone + 'a,
    val: T,
    f: fn(Part<V>, T) -> ValRs<'a, T, V>,
) -> ValRs<'a, T, V> {
    if let Some((part, opt)) = iter.next() {
        let essential = matches!(opt, Opt::Essential);
        let ys = f(part, val).filter(move |v| essential || v.is_ok());
        flat_map_with(ys, iter, move |v, iter| then(v, |v| run(iter, v, f)))
    } else {
        box_once(Ok(val))
    }
}

fn update<'a, V: ValT + 'a, P, F>(mut iter: P, last: (Part<V>, Opt), v: V, f: &F) -> ValX<'a, V>
where
    P: Iterator<Item = (Part<V>, Opt)> + Clone,
    F: Fn(V) -> ValXs<'a, V>,
{
    if let Some((part, opt)) = iter.next() {
        use core::iter::once;
        part.update(v, opt, |v| once(update(iter.clone(), last.clone(), v, f)))
    } else {
        last.0.update(v, last.1, f)
    }
}

impl<'a, V: ValT + 'a> Part<V> {
    fn run(&self, v: V) -> ValRs<'a, V> {
        match self {
            Self::Index(idx) => box_once(v.index(idx)),
            Self::Range(None, None) => Box::new(v.values()),
            Self::Range(from, upto) => box_once(v.range(from.as_ref()..upto.as_ref())),
        }
    }

    fn paths(&self, (v, p): (V, RcList<V>)) -> ValRs<'a, (V, RcList<V>), V> {
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

    fn update<F, I>(&self, v: V, opt: Opt, f: F) -> ValX<'a, V>
    where
        F: Fn(V) -> I,
        I: Iterator<Item = ValX<'a, V>>,
    {
        match self {
            Self::Index(idx) => v.map_index(idx, opt, f),
            Self::Range(None, None) => v.map_values(opt, f),
            Self::Range(from, upto) => v.map_range(from.as_ref()..upto.as_ref(), opt, f),
        }
    }
}

impl<'a, U: Clone + 'a, F: IntoIterator<Item = U> + Clone + 'a> Part<F> {
    fn into_iter(self) -> BoxIter<'a, Part<U>> {
        use Part::{Index, Range};
        match self {
            Index(i) => Box::new(i.into_iter().map(Index)),
            Range(None, None) => box_once(Range(None, None)),
            Range(Some(from), None) => {
                Box::new(from.into_iter().map(|from| Range(Some(from), None)))
            }
            Range(None, Some(upto)) => {
                Box::new(upto.into_iter().map(|upto| Range(None, Some(upto))))
            }
            Range(Some(from), Some(upto)) => {
                Box::new(flat_map_with(from.into_iter(), upto, move |from, upto| {
                    map_with(upto.into_iter(), from, move |upto, from| {
                        Range(Some(from), Some(upto))
                    })
                }))
            }
        }
    }
}

impl<T> Path<T> {
    pub(crate) fn map_ref<'a, U>(&'a self, mut f: impl FnMut(&'a T) -> U) -> Path<U> {
        let path = self.0.iter();
        let path = path.map(move |(part, opt)| (part.as_ref().map(&mut f), *opt));
        Path(path.collect())
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

impl<T, E> Path<Result<T, E>> {
    fn transpose(self) -> Result<Path<T>, E> {
        self.0
            .into_iter()
            .map(|(part, opt)| Ok((part.transpose()?, opt)))
            .collect::<Result<_, _>>()
            .map(Path)
    }
}

impl<T, E> Part<Result<T, E>> {
    fn transpose(self) -> Result<Part<T>, E> {
        match self {
            Self::Index(i) => Ok(Part::Index(i?)),
            Self::Range(from, upto) => Ok(Part::Range(from.transpose()?, upto.transpose()?)),
        }
    }
}

impl<F> Part<F> {
    fn as_ref(&self) -> Part<&F> {
        match self {
            Self::Index(i) => Part::Index(i),
            Self::Range(from, upto) => Part::Range(from.as_ref(), upto.as_ref()),
        }
    }
}

impl<F> From<Part<F>> for Path<F> {
    fn from(p: Part<F>) -> Self {
        Self(Vec::from([(p, Opt::Essential)]))
    }
}
