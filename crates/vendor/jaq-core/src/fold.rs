//! Functions on iterators over results.

use crate::box_iter::Results;
use alloc::vec::Vec;

enum Fold<'a, X, Y, E> {
    /// things to be processed
    Input(Y),
    /// things to be output, then to be input
    Output(X, Results<'a, Y, E>),
}

pub(crate) fn fold<'a, T: 'a, TC: Clone + 'a, U: 'a, UC: 'a, E: 'a>(
    xs: impl Iterator<Item = Result<T, E>> + Clone + 'a,
    init: U,
    f: impl Fn(T, U) -> Results<'a, U, E> + 'a,
    tc: impl Fn(&T) -> TC + 'a,
    inner: impl Fn(TC, &U) -> Option<UC> + 'a,
    outer: impl Fn(U) -> Option<UC> + 'a,
) -> impl Iterator<Item = Result<UC, E>> + 'a {
    let mut stack = Vec::from([(xs, Fold::<TC, U, E>::Input(init))]);
    core::iter::from_fn(move || loop {
        let (mut xs, fold) = stack.pop()?;
        match fold {
            Fold::Output(x, mut ys) => match ys.next() {
                None => continue,
                Some(y) => {
                    // do not grow the stack if the output is empty
                    if ys.size_hint() != (0, Some(0)) {
                        stack.push((xs.clone(), Fold::Output(x.clone(), ys)));
                    }
                    match y {
                        Ok(y) => {
                            let inner = inner(x, &y);
                            stack.push((xs, Fold::Input(y)));
                            if let Some(inner) = inner {
                                return Some(Ok(inner));
                            }
                        }
                        Err(e) => return Some(Err(e)),
                    }
                }
            },
            Fold::Input(y) => match xs.next() {
                None => {
                    if let Some(outer) = outer(y) {
                        return Some(Ok(outer));
                    }
                }
                Some(Ok(x)) => stack.push((xs, Fold::Output(tc(&x), f(x, y)))),
                Some(Err(e)) => return Some(Err(e)),
            },
        }
    })
}
