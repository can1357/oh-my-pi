//! Native filter construction tools.

use crate::box_iter::box_once;
use crate::{Bind, Cv, DataT, Exn, Native, PathsPtr, RunPtr, ValR, ValXs};
use alloc::boxed::Box;

/// Name, arguments, and implementation of a filter.
pub type Filter<F> = (&'static str, Box<[Bind]>, F);

/// Native filter over a [`crate::DataT`].
pub type Fun<D> = Filter<Native<D>>;

/// Convert a filter with a run pointer to a native filter.
pub fn run<D: DataT>((name, arity, run): Filter<RunPtr<D>>) -> Fun<D> {
    (name, arity, Native::new(run))
}

pub(crate) type RunPathsPtr<D> = (RunPtr<D>, PathsPtr<D>);

/// Convert a filter with a run and a paths pointer to a native filter.
pub(crate) fn paths<D: DataT>((name, arity, (run, paths)): Filter<RunPathsPtr<D>>) -> Fun<D> {
    (name, arity, Native::new(run).with_paths(paths))
}

/// Creates `n` variable arguments.
pub fn v(n: usize) -> Box<[Bind]> {
    core::iter::repeat(Bind::Var(())).take(n).collect()
}

/// Box Once and Map Errors to exceptions.
pub fn bome<'a, V: 'a>(r: ValR<V>) -> ValXs<'a, V> {
    box_once(r.map_err(Exn::from))
}

/// Create a filter that takes a single variable argument and whose output is given by
/// the function `f` that takes the input value and the value of the variable.
pub fn unary<'a, D: DataT>(
    mut cv: Cv<'a, D>,
    f: impl Fn(D::V<'a>, D::V<'a>) -> ValR<D::V<'a>> + 'a,
) -> ValXs<'a, D::V<'a>> {
    bome(f(cv.1, cv.0.pop_var()))
}
