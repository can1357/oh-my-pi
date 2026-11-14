//! Boxed iterators.

use alloc::boxed::Box;

/// A boxed iterator.
pub type BoxIter<'a, T> = Box<dyn Iterator<Item = T> + 'a>;

/// A boxed iterator over `Result`s.
pub type Results<'a, T, E> = BoxIter<'a, Result<T, E>>;

/// Return a boxed iterator that yields a single element.
pub fn box_once<'a, T: 'a>(x: T) -> BoxIter<'a, T> {
    Box::new(core::iter::once(x))
}

/// If `x` is an `Err`, return it as iterator, else apply `f` to `x` and return its output.
pub fn then<'a, T, U: 'a, E: 'a>(
    x: Result<T, E>,
    f: impl FnOnce(T) -> Results<'a, U, E>,
) -> Results<'a, U, E> {
    x.map_or_else(|e| box_once(Err(e)), f)
}

/// Return next element if iterator returns at most one element, else `None`.
///
/// This is one of the most important functions for performance in jaq.
/// It enables optimisations for the case when a filter yields exactly one output,
/// which is very common in typical jq programs.
///
/// For example, for the filter `f | g`, this function is called on the outputs of `f`.
/// If `f` yields a single output `y`, then the output of `f | g` is `y` applied to `g`.
/// This has two beneficial consequences:
///
/// 1. We can estimate the number of outputs of `f | g` by estimating the outputs of `g`.
///    (In general, we cannot do this even when we know the number of outputs of `f`,
///    because `g` might yield a different number of elements for each output of `f`.)
/// 2. We do not need to clone the context when passing it to `g`,
///    because we know that `g` is only called once.
///
/// This optimisation applies to many other filters as well.
///
/// To see the impact of this function, you can replace its implementation with just `None`.
/// This preserves correctness, but can result in severely degraded performance.
fn next_if_one<T>(iter: &mut impl Iterator<Item = T>) -> Option<T> {
    if iter.size_hint().1 == Some(1) {
        let ly = iter.next()?;
        // the Rust documentation states that
        // "a buggy iterator may yield [..] more than the upper bound of elements",
        // but so far, it seems that all iterators here are not buggy :)
        debug_assert!(iter.next().is_none());
        return Some(ly);
    }
    None
}

/// For every element `y` returned by `l`, return the output of `r(y, x)`.
///
/// In case that `l` returns only a single element, this does not clone `x`.
pub fn map_with<'a, T: Clone + 'a, U: 'a, V: 'a>(
    mut l: impl Iterator<Item = U> + 'a,
    x: T,
    r: impl Fn(U, T) -> V + 'a,
) -> BoxIter<'a, V> {
    match next_if_one(&mut l) {
        Some(ly) => box_once(r(ly, x)),
        None => Box::new(l.map(move |ly| r(ly, x.clone()))),
    }
}

/// For every element `y` returned by `l`, return the outputs of `r(y, x)`.
///
/// In case that `l` returns only a single element, this does not clone `x`.
pub fn flat_map_with<'a, T: Clone + 'a, U: 'a, V: 'a>(
    mut l: impl Iterator<Item = U> + 'a,
    x: T,
    r: impl Fn(U, T) -> BoxIter<'a, V> + 'a,
) -> BoxIter<'a, V> {
    match next_if_one(&mut l) {
        Some(ly) => Box::new(r(ly, x)),
        None => Box::new(l.flat_map(move |ly| r(ly, x.clone()))),
    }
}

/// Combination of [`Iterator::flat_map`] and [`then`].
pub fn flat_map_then<'a, T: 'a, U: 'a, E: 'a>(
    mut l: impl Iterator<Item = Result<T, E>> + 'a,
    r: impl Fn(T) -> Results<'a, U, E> + 'a,
) -> Results<'a, U, E> {
    match next_if_one(&mut l) {
        Some(ly) => then(ly, r),
        None => Box::new(l.flat_map(move |y| then(y, |y| r(y)))),
    }
}

/// Combination of [`flat_map_with`] and [`then`].
pub fn flat_map_then_with<'a, T: Clone + 'a, U: 'a, V: 'a, E: 'a>(
    l: impl Iterator<Item = Result<U, E>> + 'a,
    x: T,
    r: impl Fn(U, T) -> Results<'a, V, E> + 'a,
) -> Results<'a, V, E> {
    flat_map_with(l, x, move |y, x| then(y, |y| r(y, x)))
}
