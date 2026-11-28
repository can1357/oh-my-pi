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

