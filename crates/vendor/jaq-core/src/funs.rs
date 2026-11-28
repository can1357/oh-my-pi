use crate::native::{bome, v, Filter, Fun};
use crate::filter::{first_then,n_item,n_map,n_once,paths_node,run_node,valid_path,INode,Item,Payload};
use crate::pull::{Action, Input, Node};
use crate::{Bind, Cv, DataT, Error, Exn, Native, RcList, RunPtr, ValT, ValX};
use alloc::{boxed::Box, vec::Vec};

pub fn run<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([
        ("error", v(0), (|cv| bome(Err(Error::new(cv.1))))),
        ("range", v(3), |mut cv| {
            let by = cv.0.pop_var();
            let to = cv.0.pop_var();
            let from = cv.0.pop_var();
            Box::new(range(Ok(from), to, by))
        }),
    ])
}

/// This implements a ~10x faster version of jq's
/// ~~~ text
/// def range($init; $upto; $by):
///     if $by > 0 then $init|while(. < $upto; . + $by)
///   elif $by < 0 then $init|while(. > $upto; . + $by)
///   else empty end;
/// ~~~
fn range<V: ValT>(mut from: ValX<V>, to: V, by: V) -> impl Iterator<Item = ValX<V>> {
    use core::cmp::Ordering::{Equal, Greater, Less};
    let cmp = by.partial_cmp(&0.into()).unwrap_or(Equal);
    core::iter::from_fn(move || match from.clone() {
        Ok(x) => match cmp {
            Greater => x < to,
            Less => x > to,
            Equal => false,
        }
        .then(|| core::mem::replace(&mut from, (x + by.clone()).map_err(Exn::from))),
        e @ Err(_) => {
            // return None after the error
            from = Ok(to.clone());
            Some(e)
        }
    })
}

type PathCv<'a,D> = Cv<'a,D,(<D as DataT>::V<'a>,RcList<<D as DataT>::V<'a>>)>;

fn path<'a,D:DataT>(mut cv: Cv<'a,D>) -> INode<'a,D> {
    let (f, ctx) = cv.0.pop_fun();
    n_map(paths_node(f, (ctx, (cv.1, RcList::new()))), |x| x.and_then(valid_path::<D>).map(|(_,path)| {
        let keys: Vec<_> = path.iter().cloned().collect();
        Payload::Val(keys.into_iter().rev().collect())
    }))
}

#[derive(Copy,Clone)]
enum Kind { First, Last, Limit, Skip }

fn apply<'a,D:DataT,T:'a>(mut cv: Cv<'a,D,T>, eval: fn(crate::compile::TermId,Cv<'a,D,T>)->INode<'a,D>, kind: Kind, paths: bool) -> INode<'a,D> {
    let (f, ctx) = cv.0.pop_fun();
    let count = match kind {
        Kind::Limit | Kind::Skip => {
            let n = cv.0.pop_var();
            if n == 0.into() {
                return if matches!(kind,Kind::Limit) { Box::new(crate::pull::Empty) } else { validated(eval(f,(ctx,cv.1)),paths) };
            }
            if !(n > 0.into()) {
                let msg = if matches!(kind,Kind::Limit) { "limit doesn't support negative count" } else { "skip doesn't support negative count" };
                return n_once(Err(Error::str(msg).into()));
            }
            Some(n)
        },
        _ => None,
    };
    let child = validated(eval(f,(ctx,cv.1)),paths);
    if matches!(kind,Kind::First) {
        return first_then(child, |x| x.map_or_else(|| Box::new(crate::pull::Empty) as INode<'a,D>, n_item));
    }
    Box::new(Take { child: Some(child), kind, count, last: None, done: false })
}

fn validated<'a,D:DataT>(node: INode<'a,D>, paths: bool) -> INode<'a,D> {
    if !paths { return node }
    n_map(node, |x| x.and_then(valid_path::<D>).map(|(v,p)| Payload::ValPath(v,p)))
}

struct Take<'a,D:DataT> {
    child: Option<INode<'a,D>>,
    kind: Kind,
    count: Option<D::V<'a>>,
    last: Option<Item<'a,D>>,
    done: bool,
}

impl<'a,D:DataT> Node<'a,Item<'a,D>> for Take<'a,D> {
    fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
        if self.done { return Action::Done }
        match input {
            Input::Start => {
                if let Some(n) = self.count.take() {
                    if matches!(self.kind,Kind::Limit) && !(n > 0.into()) { self.done = true; return Action::Done }
                    match n - 1.into() {
                        Ok(n) if matches!(self.kind,Kind::Skip) && n < 0.into() => {},
                        Ok(n) => self.count = Some(n),
                        Err(e) => { self.done = true; return Action::Yield(Err(e.into())) },
                    }
                }
                self.child.take().map_or(Action::Continue,Action::Descend)
            },
            Input::End => { self.done = true; self.last.take().map_or(Action::Done, Action::Yield) },
            Input::Item(x) => match self.kind {
                Kind::Last if x.is_ok() => { self.last = Some(x); Action::Continue },
                Kind::Last => { self.done = true; Action::Yield(x) },
                Kind::Skip if self.count.is_some() && x.is_ok() => self.resume(Input::Start),
                _ => Action::Yield(x),
            },
        }
    }
}

pub(crate) fn resumable<D:DataT>() -> impl Iterator<Item=Fun<D>> {
    macro_rules! both {
        ($kind:ident) => { Native::resumable(|cv: Cv<'_,D>| apply(cv,run_node,Kind::$kind,false))
            .with_paths(|cv: PathCv<'_,D>| apply(cv,paths_node,Kind::$kind,true)) };
    }
    let f = || [Bind::Fun(())].into();
    let vf = || [Bind::Var(()),Bind::Fun(())].into();
    [
        ("path",f(),Native::resumable(path::<D>)),
        ("first",f(),both!(First)),
        ("last",f(),both!(Last)),
        ("limit",vf(),both!(Limit)),
        ("skip",vf(),both!(Skip)),
    ].into_iter()
}
