//! Native filter construction tools.

use crate::box_iter::box_once;
use crate::{Bind, Cv, DataT, Exn, Native, RunPtr, ValR, ValXs};
use alloc::boxed::Box;

/// Name, arguments, and implementation of a filter.
pub type Filter<F> = (&'static str, Box<[Bind]>, F);

/// Native filter over a [`crate::DataT`].
pub type Fun<D> = Filter<Native<D>>;

/// Convert a filter with a run pointer to a native filter.
pub fn run<D: DataT>((name, arity, run): Filter<RunPtr<D>>) -> Fun<D> {
    (name, arity, Native::new(run))
}

/// Node returned by a resumable native filter.
pub type EvalNode<'a,D> = crate::filter::INode<'a,D>;

/// An update callback for a resumable native filter.
pub use crate::filter::Updater as Update;

/// Evaluate a filter argument on the current driver.
pub fn eval<'a,D:DataT>(id: crate::compile::TermId, cv: Cv<'a,D>) -> EvalNode<'a,D> {
    crate::filter::run_node(id, cv)
}

/// Evaluate a filter argument while tracking its paths on the current driver.
pub fn eval_paths<'a,D:DataT>(id: crate::compile::TermId, cv: (crate::Ctx<'a,D>, (<D as DataT>::V<'a>, crate::RcList<<D as DataT>::V<'a>>))) -> EvalNode<'a,D> {
    crate::filter::paths_node(id, cv)
}

/// Pull item carried by a resumable native filter.
pub type EvalItem<'a,D> = crate::filter::Item<'a,D>;

/// Apply a resumable update to a filter argument on the current driver.
pub fn eval_update<'a,D:DataT>(id: crate::compile::TermId, cv: Cv<'a,D>, update: Update<'a,D>) -> EvalNode<'a,D> {
    crate::filter::update_node(id, cv, update)
}

/// Wrap a native value or exception as a pull item.
pub fn item<'a,D:DataT>(value: crate::ValX<'a,D::V<'a>>) -> EvalItem<'a,D> {
    value.map(crate::filter::Payload::Val)
}

/// Unwrap a pull item from a child evaluated with [`eval`].
pub fn value<'a,D:DataT>(item: EvalItem<'a,D>) -> crate::ValX<'a,D::V<'a>> {
    crate::filter::val::<D>(item)
}

/// Wrap a value and its relative path as a pull item.
pub fn path_item<'a,D:DataT>(value: D::V<'a>, path: crate::RcList<D::V<'a>>) -> EvalItem<'a,D> {
    Ok(crate::filter::Payload::ValPath(value, path))
}

/// Unwrap and validate an output from a child evaluated with [`eval_paths`].
pub fn path_value<'a,D:DataT>(item: EvalItem<'a,D>) -> crate::ValX<'a,(D::V<'a>, crate::RcList<D::V<'a>>),D::V<'a>> {
    item.and_then(crate::filter::valid_path::<D>)
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
