use crate::box_iter::BoxIter;
use crate::native::{bome, v, Filter, RunPathsPtr};
use crate::{Bind, DataT, Error, Exn, RunPtr, ValT, ValX};
use alloc::{boxed::Box, vec::Vec};

pub fn run<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    let f = || [Bind::Fun(())].into();
    Box::new([
        ("error_empty", v(0), (|cv| bome(Err(Error::new(cv.1))))),
        ("path", f(), |mut cv| {
            let (f, fc) = cv.0.pop_fun();
            let cvp = (fc, (cv.1, Default::default()));
            Box::new(f.paths(cvp).map(|vp| {
                let (_v, path) = vp?;
                let path: Vec<_> = path.iter().cloned().collect();
                Ok(path.into_iter().rev().collect())
            }))
        }),
        ("path_value", f(), |mut cv| {
            let (f, fc) = cv.0.pop_fun();
            let cvp = (fc, (cv.1, Default::default()));
            Box::new(f.paths(cvp).map(|vp| {
                let (v, path) = vp?;
                let path: Vec<_> = path.iter().cloned().collect();
                Ok([path.into_iter().rev().collect(), v].into_iter().collect())
            }))
        }),
        ("range", v(3), |mut cv| {
            let by = cv.0.pop_var();
            let to = cv.0.pop_var();
            let from = cv.0.pop_var();
            Box::new(range(Ok(from), to, by))
        }),
        ("keys_unsorted", v(0), |cv| {
            bome(cv.1.key_values().map(|kv| kv.map(|(k, _v)| k)).collect())
        }),
        ("key_values", v(0), |cv| {
            let f = |(k, v)| [k, v].into_iter().collect();
            bome(cv.1.key_values().map(|kv| kv.map(f)).collect())
        }),
    ])
}

/// This implements a ~10x faster version of:
/// ~~~ text
/// def range($from; $to; $by): $from |
///    if $by > 0 then while(.  < $to; . + $by)
///  elif $by < 0 then while(.  > $to; . + $by)
///    else            while(. != $to; . + $by)
///    end;
/// ~~~
fn range<V: ValT>(mut from: ValX<V>, to: V, by: V) -> impl Iterator<Item = ValX<V>> {
    use core::cmp::Ordering::{Equal, Greater, Less};
    let cmp = by.partial_cmp(&0.into()).unwrap_or(Equal);
    core::iter::from_fn(move || match from.clone() {
        Ok(x) => match cmp {
            Greater => x < to,
            Less => x > to,
            Equal => x != to,
        }
        .then(|| core::mem::replace(&mut from, (x + by.clone()).map_err(Exn::from))),
        e @ Err(_) => {
            // return None after the error
            from = Ok(to.clone());
            Some(e)
        }
    })
}

fn once_or_empty<'a, T: 'a, E: 'a>(r: Result<Option<T>, E>) -> BoxIter<'a, Result<T, E>> {
    Box::new(r.transpose().into_iter())
}

macro_rules! first {
    ( $run:ident ) => {
        |mut cv| {
            let (f, fc) = cv.0.pop_fun();
            Box::new(f.$run((fc, cv.1)).next().into_iter())
        }
    };
}
macro_rules! last {
    ( $run:ident ) => {
        |mut cv| {
            let (f, fc) = cv.0.pop_fun();
            once_or_empty(f.$run((fc, cv.1)).try_fold(None, |_, x| x.map(Some)))
        }
    };
}

macro_rules! while_gtz {
    ( $n:expr, $gtz:expr, $lez:expr ) => {{
        let mut n = Some($n);
        Box::new(core::iter::from_fn(move || {
            while let Some(i) = n.take().filter(|i| *i > 0.into()) {
                match i - 1.into() {
                    Ok(i) => n = Some(i),
                    Err(e) => return Some(Err(e.into())),
                }
                $gtz
            }
            $lez
        }))
    }};
}

/// In principle, we could implement the following filters as follows:
///
/// ~~~ text
/// def limit($n; f): if $n <= 0 then empty else label $out |
///   foreach f as $x ($n; . - 1; if . <= 0 then $x, break $out else $x end) end;
/// def skip($n; f): if $n <= 0 then f else
///   foreach f as $x ($n; . - 1; if . >= 0 then empty else $x end) end;
/// ~~~
///
/// However, this does not allow `path(limit(...))`, because
/// `limit` binds the outputs of `f` to a variable (`$x`).
/// Variables never have a path in jaq, whereas they may in jq.
macro_rules! limit {
    ( $run:ident ) => {
        |mut cv| {
            let ((f, fc), n) = (cv.0.pop_fun(), cv.0.pop_var());
            if n <= 0.into() {
                return Box::new(core::iter::empty());
            }
            let mut iter = f.$run((fc, cv.1));
            while_gtz!(n, return iter.next(), None)
        }
    };
}
macro_rules! skip {
    ( $run:ident ) => {
        |mut cv| {
            let ((f, fc), n) = (cv.0.pop_fun(), cv.0.pop_var());
            let mut iter = f.$run((fc, cv.1));
            if n <= 0.into() {
                return iter;
            }
            while_gtz!(
                n,
                if let Some(e) = iter.next()?.err() {
                    return Some(Err(e));
                },
                iter.next()
            )
        }
    };
}

pub fn paths<D: DataT>() -> Box<[Filter<RunPathsPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    let f = || [Bind::Fun(())].into();
    let vf = || [Bind::Var(()), Bind::Fun(())].into();
    Box::new([
        ("first", f(), (first!(run), first!(paths))),
        ("last", f(), (last!(run), last!(paths))),
        ("limit", vf(), (limit!(run), limit!(paths))),
        ("skip", vf(), (skip!(run), skip!(paths))),
    ])
}
