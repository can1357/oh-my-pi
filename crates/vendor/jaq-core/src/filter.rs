//! Filter execution.

use crate::box_iter::{self, box_once, flat_map_then, flat_map_then_with, flat_map_with, map_with};
use crate::compile::{Bind, CallType, Fold, Pattern, Term as Ast, TermId as Id};
use crate::data::{DataT, HasLut};
use crate::fold::fold;
use crate::val::{ValR, ValT, ValX, ValXs};
use crate::{exn, rc_lazy_list, Bind as Arg, Error, Exn, RcList};
use alloc::boxed::Box;
use dyn_clone::DynClone;

/// Combination of context and input value.
pub type Cv<'a, D, T = <D as DataT>::V<'a>> = (Ctx<'a, D>, T);
/// Combination of context and input value with a path.
type Cvp<'a, D> = Cv<'a, D, (<D as DataT>::V<'a>, RcList<<D as DataT>::V<'a>>)>;
type ValPathXs<'a, V> = ValXs<'a, (V, RcList<V>), V>;

type Lut<D> = crate::compile::Lut<Native<D>>;

// we can unfortunately not make a `Box<dyn ... + Clone>`
// that is why we have to go through the pain of making a new trait here
pub trait Update<'a, V>: Fn(V) -> ValXs<'a, V> + DynClone {}

impl<'a, V, T: Fn(V) -> ValXs<'a, V> + Clone> Update<'a, V> for T {}

dyn_clone::clone_trait_object!(<'a, V> Update<'a, V>);

type BoxUpdate<'a, V> = Box<dyn Update<'a, V> + 'a>;

/// List of bindings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vars<V>(RcList<Bind<V, usize, (Id, Self)>>);

impl<V> Vars<V> {
    /// Initialise new variables from values.
    pub fn new(vars: impl IntoIterator<Item = V>) -> Self {
        Self(RcList::new().extend(vars.into_iter().map(Bind::Var)))
    }

    fn get(&self, i: usize) -> Option<&Bind<V, usize, (Id, Self)>> {
        self.0.get(i)
    }
}

impl<V> Default for Vars<V> {
    fn default() -> Self {
        Self(RcList::default())
    }
}

/// Filter execution context.
pub struct Ctx<'a, D: DataT + ?Sized> {
    data: D::Data<'a>,
    vars: Vars<D::V<'a>>,
    /// Number of bound labels at the current path
    ///
    /// This is used to create fresh break IDs.
    labels: usize,
}

impl<'a, D: DataT> Clone for Ctx<'a, D> {
    fn clone(&self) -> Self {
        self.with_vars(Vars(self.vars.0.clone()))
    }
}

impl<'a, D: DataT> Ctx<'a, D> {
    /// Construct a fresh context.
    ///
    /// If you do not use any filters that need custom data (such as `inputs`)
    /// and your value type has a `'static` lifetime, then you may use
    /// [`crate::data::JustLut`] as [`DataT`].
    pub fn new(data: D::Data<'a>, vars: Vars<D::V<'a>>) -> Self {
        Self {
            data,
            vars,
            labels: 0,
        }
    }

    /// Add a new variable binding.
    fn cons_var(mut self, x: D::V<'a>) -> Self {
        self.vars.0 = self.vars.0.cons(Bind::Var(x));
        self
    }

    /// Add a new filter binding.
    fn cons_fun(mut self, (f, ctx): (Id, Self)) -> Self {
        self.vars.0 = self.vars.0.cons(Bind::Fun((f, ctx.vars)));
        self
    }

    fn cons_label(mut self) -> Self {
        self.labels += 1;
        self.vars.0 = self.vars.0.cons(Bind::Label(self.labels));
        self
    }

    /// Remove the `skip` most recent variable bindings.
    fn skip_vars(mut self, skip: usize) -> Self {
        if skip > 0 {
            self.vars.0 = self.vars.0.skip(skip).clone();
        }
        self
    }

    /// Replace variables in context with given ones.
    fn with_vars(&self, vars: Vars<D::V<'a>>) -> Self {
        Self {
            vars,
            data: self.data.clone(),
            labels: self.labels,
        }
    }

    fn lut(&self) -> &'a Lut<D> {
        self.data.lut()
    }

    /// Return global data.
    pub fn data(&self) -> &D::Data<'a> {
        &self.data
    }
}

impl<'a, D: DataT> Ctx<'a, D> {
    /// Remove the latest bound variable from the context.
    ///
    /// This is useful for writing [`Native`] filters.
    pub fn pop_var(&mut self) -> D::V<'a> {
        let (head, tail) = match core::mem::take(&mut self.vars.0).pop() {
            Some((Bind::Var(head), tail)) => (head, tail),
            _ => panic!(),
        };
        self.vars.0 = tail;
        head
    }

    /// Remove the latest bound function from the context.
    ///
    /// This is useful for writing [`Native`] filters.
    pub fn pop_fun(&mut self) -> (Id, Self) {
        let ((id, vars), tail) = match core::mem::take(&mut self.vars.0).pop() {
            Some((Bind::Fun(head), tail)) => (head, tail),
            _ => panic!(),
        };
        self.vars.0 = tail;
        (id, self.with_vars(vars))
    }
}

/// Enhance the context `ctx` with variables bound to the outputs of `args` executed on `cv`,
/// and return the enhanced contexts together with the original value of `cv`.
///
/// This is used when we call filters with variable arguments.
fn bind_vars<'a, D: DataT, T: 'a + Clone>(
    args: &'a [Arg<Id>],
    ctx: Ctx<'a, D>,
    cv: Cv<'a, D, T>,
    proj: fn(&T) -> D::V<'a>,
) -> ValXs<'a, Cv<'a, D, T>, D::V<'a>> {
    match args.split_first() {
        Some((Arg::Var(arg), [])) => map_with(
            arg.run((cv.0.clone(), proj(&cv.1))),
            (ctx, cv.1),
            |y, (ctx, v)| Ok((ctx.cons_var(y?), v)),
        ),
        Some((Arg::Fun(arg), [])) => box_once(Ok((ctx.cons_fun((*arg, cv.0)), cv.1))),
        Some((Arg::Var(arg), rest)) => flat_map_then_with(
            arg.run((cv.0.clone(), proj(&cv.1))),
            (ctx, cv),
            move |y, (ctx, cv)| bind_vars(rest, ctx.cons_var(y), cv, proj),
        ),
        Some((Arg::Fun(arg), rest)) => {
            bind_vars(rest, ctx.cons_fun((*arg, cv.0.clone())), cv, proj)
        }
        None => box_once(Ok((ctx, cv.1))),
    }
}

fn bind_pat<'a, D: DataT>(
    (idxs, pat): &'a (Id, Pattern<Id>),
    ctx: Ctx<'a, D>,
    cv: Cv<'a, D>,
) -> ValXs<'a, Ctx<'a, D>, D::V<'a>> {
    let (ctx0, v0) = cv.clone();
    let v1 = map_with(idxs.run(cv), v0, move |i, v0| Ok(v0.index(&i?)?));
    match pat {
        Pattern::Var => Box::new(v1.map(move |v| Ok(ctx.clone().cons_var(v?)))),
        Pattern::Idx(pats) => flat_map_then_with(v1, (ctx, ctx0), move |v, (ctx, ctx0)| {
            bind_pats(pats, ctx, (ctx0, v))
        }),
    }
}

fn bind_pats<'a, D: DataT>(
    pats: &'a [(Id, Pattern<Id>)],
    ctx: Ctx<'a, D>,
    cv: Cv<'a, D>,
) -> ValXs<'a, Ctx<'a, D>, D::V<'a>> {
    match pats.split_first() {
        None => box_once(Ok(ctx)),
        Some((pat, [])) => bind_pat(pat, ctx, cv),
        Some((pat, rest)) => flat_map_then_with(bind_pat(pat, ctx, cv.clone()), cv, |ctx, cv| {
            bind_pats(rest, ctx, cv)
        }),
    }
}

fn run_and_bind<'a, D: DataT>(
    xs: &'a Id,
    cv: Cv<'a, D>,
    pat: &'a Pattern<Id>,
) -> ValXs<'a, Ctx<'a, D>, D::V<'a>> {
    let xs = xs.run((cv.0.clone(), cv.1));
    match pat {
        Pattern::Var => map_with(xs, cv.0, move |y, ctx| Ok(ctx.cons_var(y?))),
        Pattern::Idx(pats) => {
            flat_map_then_with(xs, cv.0, |y, ctx| bind_pats(pats, ctx.clone(), (ctx, y)))
        }
    }
}

fn bind_run<'a, D: DataT, T: Clone + 'a>(
    pat: &'a Pattern<Id>,
    r: &'a Id,
    cv: Cv<'a, D, T>,
    y: D::V<'a>,
    run: IdRunFn<'a, D, T>,
) -> ValXs<'a, T, D::V<'a>> {
    match pat {
        Pattern::Var => run(r, (cv.0.cons_var(y), cv.1)),
        Pattern::Idx(pats) => {
            let r = move |ctx, vp| run(r, (ctx, vp));
            flat_map_then_with(bind_pats(pats, cv.0.clone(), (cv.0, y)), cv.1, r)
        }
    }
}

fn label_run<'a, D: DataT, T: 'a>(
    cv: Cv<'a, D, T>,
    run: impl Fn(Cv<'a, D, T>) -> ValXs<'a, T, D::V<'a>>,
) -> ValXs<'a, T, D::V<'a>> {
    let ctx = cv.0.cons_label();
    let labels = ctx.labels;
    Box::new(run((ctx, cv.1)).map_while(move |y| match y {
        Err(Exn(exn::Inner::Break(b))) if b == labels => None,
        y => Some(y),
    }))
}

fn try_catch_run<'a, T: 'a, V: 'a, I: Iterator<Item = ValX<'a, T, V>> + 'a>(
    mut ys: ValXs<'a, T, V>,
    f: impl Fn(Error<V>) -> I + 'a,
) -> ValXs<'a, T, V> {
    let mut end: Option<I> = None;
    Box::new(core::iter::from_fn(move || match &mut end {
        Some(end) => end.next(),
        None => match ys.next()? {
            Err(Exn(exn::Inner::Err(e))) => {
                end = Some(f(*e));
                end.as_mut().and_then(|end| end.next())
            }
            y => Some(y),
        },
    }))
}

fn fold_run<'a, D: DataT, T: Clone + 'a>(
    xs: impl Iterator<Item = ValX<'a, Ctx<'a, D>, D::V<'a>>> + Clone + 'a,
    cv: Cv<'a, D, T>,
    init: &'a Id,
    update: &'a Id,
    fold_type: &'a Fold<Id>,
    run: IdRunFn<'a, D, T>,
) -> ValXs<'a, T, D::V<'a>> {
    let init = run(init, cv.clone());
    let update = move |ctx, v| run(update, (ctx, v));
    let inner = |_, y: &T| Some(y.clone());
    let inner_proj = |ctx, y: &T| Some((ctx, y.clone()));
    flat_map_then_with(init, xs, move |i, xs| match fold_type {
        Fold::Reduce => Box::new(fold(xs, i, update, |_| (), |_, _| None, Some)),
        Fold::Foreach(None) => Box::new(fold(xs, i, update, |_| (), inner, |_| None)),
        Fold::Foreach(Some(proj)) => flat_map_then(
            fold(xs, i, update, |ctx| ctx.clone(), inner_proj, |_| None),
            move |(ctx, y)| run(proj, (ctx, y)),
        ),
    })
}

/// For every value `v` returned by `self.run(cv)`, call `f(cv, v)` and return all results.
///
/// This has a special optimisation for the case where only a single `v` is returned.
/// In that case, we can consume `cv` instead of cloning it.
fn pipe<'a, D: DataT, T: 'a, F>(l: &'a Id, cv: Cv<'a, D>, r: F) -> ValXs<'a, T, D::V<'a>>
where
    F: Fn(Cv<'a, D>, D::V<'a>) -> ValXs<'a, T, D::V<'a>> + 'a,
{
    flat_map_then_with(l.run(cv.clone()), cv, move |y, cv| r(cv, y))
}

type Pairs<'a, T> = box_iter::BoxIter<'a, (T, T)>;

/// Run `self` and `r` and return the cartesian product of their outputs.
fn cartesian<'a, D: DataT>(l: &'a Id, r: &'a Id, cv: Cv<'a, D>) -> Pairs<'a, ValX<'a, D::V<'a>>> {
    flat_map_with(l.run(cv.clone()), cv, move |l, cv| {
        map_with(r.run(cv), l, |r, l| (l, r))
    })
}

fn fold_update<'a, D: DataT>(
    fold_type: &'a Fold<Id>,
    path: &'a Id,
    v: D::V<'a>,
    mut xs: impl Iterator<Item = ValX<'a, Ctx<'a, D>, D::V<'a>>> + Clone + 'a,
    f: BoxUpdate<'a, D::V<'a>>,
) -> ValXs<'a, D::V<'a>> {
    let ctx = match xs.next() {
        Some(Ok(ctx)) => ctx,
        Some(Err(e)) => return box_once(Err(e)),
        None => match fold_type {
            Fold::Reduce => return f(v),
            Fold::Foreach(_) => return box_once(Ok(v)),
        },
    };

    let rec = |v, (xs, f)| fold_update(fold_type, path, v, xs, f);
    let update: BoxUpdate<_> = match fold_type {
        Fold::Reduce => Box::new(move |v| rec(v, (xs.clone(), f.clone()))),
        Fold::Foreach(None) => {
            Box::new(move |v| flat_map_then_with(f(v), (xs.clone(), f.clone()), rec))
        }
        Fold::Foreach(Some(proj)) => {
            let ctx_ = ctx.clone();
            Box::new(move |v| {
                let proj = proj.update((ctx_.clone(), v), f.clone());
                flat_map_then_with(proj, (xs.clone(), f.clone()), rec)
            })
        }
    };
    path.update((ctx, v), update)
}

fn def_run<'a, D: DataT, T: 'a>(
    id: &'a Id,
    call_typ: &CallType,
    cvs: ValXs<'a, Cv<'a, D, T>, D::V<'a>>,
    run: IdRunFn<'a, D, T>,
    with_vars: impl Fn(Vars<D::V<'a>>) -> Ctx<'a, D> + 'a,
    into: fn(T) -> exn::CallInput<D::V<'a>>,
    from: fn(exn::CallInput<D::V<'a>>) -> T,
) -> ValXs<'a, T, D::V<'a>> {
    use core::ops::ControlFlow;
    let outs = |cvs| flat_map_then(cvs, move |cv| run(id, cv));
    let catch = |all: bool| {
        move |r| match r {
            Err(Exn(exn::Inner::TailCall(tc))) if all || tc.0 == id => {
                ControlFlow::Continue(run(tc.0, (with_vars(tc.1), from(tc.2))))
            }
            Ok(_) | Err(_) => ControlFlow::Break(r),
        }
    };

    match call_typ {
        CallType::Inline => outs(cvs),
        CallType::CatchOne => Box::new(crate::Stack::new([outs(cvs)].into(), catch(false))),
        CallType::CatchAll => Box::new(crate::Stack::new([outs(cvs)].into(), catch(true))),
        CallType::Throw => Box::new(cvs.map(move |cv| {
            cv.and_then(|cv| {
                let tc = (id, cv.0.vars, into(cv.1));
                Err(Exn(exn::Inner::TailCall(Box::new(tc))))
            })
        })),
    }
}

fn reduce<'a, T: Clone + 'a, V: Clone + 'a, F>(xs: ValXs<'a, T, V>, init: V, f: F) -> ValXs<'a, V>
where
    F: Fn(T, V) -> ValXs<'a, V> + 'a,
{
    let xs = rc_lazy_list::List::from_iter(xs);
    Box::new(fold(xs, init, f, |_| (), |_, _| None, Some))
}

fn lazy<I: Iterator, F: FnOnce() -> I>(f: F) -> impl Iterator<Item = I::Item> {
    core::iter::once_with(f).flatten()
}

#[test]
fn lazy_is_lazy() {
    let f = || panic!();
    let mut iter = core::iter::once(0).chain(lazy(|| box_once(f())));
    assert_eq!(iter.size_hint(), (1, None));
    assert_eq!(iter.next(), Some(0));
}

/// Runs `def recurse(f): ., (f? | recurse(f)); v | recurse(f)`.
fn recurse_run<'a, T: Clone + 'a, V: 'a, I: Iterator<Item = ValR<T, V>> + 'a>(
    x: T,
    f: &'a impl Fn(T) -> I,
) -> ValXs<'a, T, V> {
    let id = core::iter::once(Ok(x.clone()));
    Box::new(id.chain(f(x).flatten().flat_map(|y| recurse_run(y, f))))
}

/// Runs `def recurse: (.[]? | recurse), .; v | recurse |= f`.
///
/// This uses a `recurse` different from that of `recurse_run`; in particular,
/// `recurse_run` yields values from root to leafs, whereas
/// this function performs updates from leafs to root.
/// Performing updates from root to leafs can easily lead to
/// nontermination or other weird effects, such as
/// trying to update values that have been deleted.
fn recurse_update<'a, V: ValT + 'a>(v: V, f: &dyn Update<'a, V>) -> ValXs<'a, V> {
    use crate::path::Opt::Optional;
    box_iter::then(v.map_values(Optional, |v| recurse_update(v, f)), f)
}

/// A filter which is implemented using function pointers.
pub struct Native<D: DataT + ?Sized> {
    run: RunPtr<D>,
    paths: PathsPtr<D>,
    update: UpdatePtr<D>,
}

type IdRunFn<'a, D, T> = fn(&Id, Cv<'a, D, T>) -> ValXs<'a, T, <D as DataT>::V<'a>>;

/// Run function pointer (see [`Id::run`]).
pub type RunPtr<D> = for<'a> fn(Cv<'a, D>) -> ValXs<'a, <D as DataT>::V<'a>>;
/// Paths function pointer (see [`Id::paths`]).
pub type PathsPtr<D> = for<'a> fn(Cvp<'a, D>) -> ValPathXs<'a, <D as DataT>::V<'a>>;
/// Update function pointer (see [`Id::update`]).
pub type UpdatePtr<D> =
    for<'a> fn(Cv<'a, D>, BoxUpdate<'a, <D as DataT>::V<'a>>) -> ValXs<'a, <D as DataT>::V<'a>>;

impl<D: DataT> Native<D> {
    /// Create a native filter from a run function.
    ///
    /// A filter created this way initially supports neither paths nor updates.
    /// For that, use [`Self::with_paths`] and [`Self::with_update`].
    pub const fn new(run: RunPtr<D>) -> Self {
        Self {
            run,
            paths: |cv| box_once(Err(Exn::from(Error::path_expr(cv.1 .0)))),
            update: |cv, _| box_once(Err(Exn::from(Error::path_expr(cv.1)))),
        }
    }

    /// Specify a paths function (used for `path(...)`).
    pub const fn with_paths(self, paths: PathsPtr<D>) -> Self {
        Self { paths, ..self }
    }

    /// Specify an update function (used for `filter |= ...`).
    ///
    /// If an update function is given, then a paths function should be implemented too.
    pub const fn with_update(self, update: UpdatePtr<D>) -> Self {
        Self { update, ..self }
    }
}

/// Check between values even when an enclosing filter (such as `[...]` or
/// `reduce`) produces no output until its input iterator is exhausted.
fn stop_on_cancel<'a, D: DataT, T: 'a>(
    data: D::Data<'a>,
    mut values: ValXs<'a, T, D::V<'a>>,
) -> ValXs<'a, T, D::V<'a>> {
    Box::new(core::iter::from_fn(move || {
        if D::cancelled(&data) { None } else { values.next() }
    }))
}

impl Id {
    /// `f.run((c, v))` returns the output of `v | f` in the context `c`.
    pub fn run<'a, D: DataT>(&self, cv: Cv<'a, D>) -> ValXs<'a, D::V<'a>> {
        use core::iter::once;
        let cancel = D::CHECK_CANCELLATION.then(|| cv.0.data.clone());
        let values = match &cv.0.lut().terms[self.0] {
            Ast::Id => box_once(Ok(cv.1)),
            Ast::Recurse => recurse_run(cv.1, &|v| v.values()),
            Ast::ToString => box_once(Ok(cv.1.into_string())),
            Ast::Int(n) => box_once(Ok(D::V::from(*n))),
            Ast::Num(x) => box_once(D::V::from_num(x).map_err(Exn::from)),
            Ast::Str(s) => box_once(Ok(D::V::from(s.clone()))),
            Ast::Arr(f) => box_once(f.run(cv).collect()),
            Ast::ObjEmpty => box_once(D::V::from_map([]).map_err(Exn::from)),
            Ast::ObjSingle(k, v) => {
                Box::new(cartesian(k, v, cv).map(|(k, v)| Ok(D::V::from_map([(k?, v?)])?)))
            }
            Ast::TryCatch(f, c) => try_catch_run(f.run((cv.0.clone(), cv.1)), move |e| {
                c.run((cv.0.clone(), e.into_val()))
            }),
            Ast::Neg(f) => Box::new(f.run(cv).map(|v| Ok((-v?)?))),

            // `l | r`
            Ast::Pipe(l, None, r) => {
                flat_map_then_with(l.run((cv.0.clone(), cv.1)), cv.0, move |y, ctx| {
                    r.run((ctx, y))
                })
            }
            // `l as $x | r`, `l as [...] | r`, or `l as {...} | r`
            Ast::Pipe(l, Some(pat), r) => pipe(l, cv, move |cv, y| {
                bind_run(pat, r, cv, y, |f, cv| f.run(cv))
            }),
            Ast::Comma(l, r) => Box::new(l.run(cv.clone()).chain(lazy(|| r.run(cv)))),
            Ast::Alt(l, r) => {
                let mut l = l
                    .run(cv.clone())
                    .filter(|v| v.as_ref().map_or(true, ValT::as_bool));
                match l.next() {
                    Some(head) => Box::new(once(head).chain(l)),
                    None => r.run(cv),
                }
            }
            Ast::Ite(if_, then_, else_) => pipe(if_, cv, move |cv, v| {
                if v.as_bool() { then_ } else { else_ }.run(cv)
            }),
            Ast::Path(f, path) => {
                let path = path.map_ref(|i| {
                    let cv = cv.clone();
                    crate::into_iter::collect_if_once(move || i.run(cv))
                });
                flat_map_then_with(f.run(cv), path, |y, path| {
                    flat_map_then_with(path.explode(), y, |path, y| {
                        Box::new(path.run(y).map(|r| r.map_err(Exn::from)))
                    })
                })
            }

            Ast::Update(path, f) => path.update(
                (cv.0.clone(), cv.1),
                Box::new(move |v| f.run((cv.0.clone(), v))),
            ),
            Ast::UpdateMath(path, op, f) => pipe(f, cv, move |cv, y| {
                let u = move |x: D::V<'a>| box_once(op.run(x, y.clone()).map_err(Exn::from));
                path.update(cv, Box::new(u))
            }),
            Ast::UpdateAlt(path, f) => pipe(f, cv, move |cv, y| {
                let u = move |x: D::V<'a>| box_once(Ok(if x.as_bool() { x } else { y.clone() }));
                path.update(cv, Box::new(u))
            }),
            Ast::Assign(path, f) => pipe(f, cv, move |cv, y| {
                path.update(cv, Box::new(move |_| box_once(Ok(y.clone()))))
            }),
            Ast::Logic(l, stop, r) => pipe(l, cv, move |cv, l| {
                if l.as_bool() == *stop {
                    box_once(Ok(D::V::from(*stop)))
                } else {
                    Box::new(r.run(cv).map(|r| Ok(D::V::from(r?.as_bool()))))
                }
            }),
            Ast::Math(l, op, r) => Box::new(cartesian(l, r, cv).map(|(x, y)| Ok(op.run(x?, y?)?))),
            Ast::Cmp(l, op, r) => {
                Box::new(cartesian(l, r, cv).map(|(x, y)| Ok(D::V::from(op.run(&x?, &y?)))))
            }

            Ast::Fold(xs, pat, init, update, fold_type) => {
                let xs = rc_lazy_list::List::from_iter(run_and_bind(xs, cv.clone(), pat));
                fold_run(xs, cv, init, update, fold_type, |f, cv| f.run(cv))
            }
            Ast::Var(v) => match cv.0.vars.get(*v).unwrap() {
                Bind::Var(v) => box_once(Ok(v.clone())),
                Bind::Fun((id, vars)) => id.run((cv.0.with_vars(vars.clone()), cv.1)),
                Bind::Label(l) => box_once(Err(Exn(exn::Inner::Break(*l)))),
            },
            Ast::CallDef(id, args, skip, call_typ) => {
                let data = cv.0.data.clone();
                let with_vars = move |vars| Ctx {
                    vars,
                    data: data.clone(),
                    labels: cv.0.labels,
                };
                let cvs = bind_vars(args, cv.0.clone().skip_vars(*skip), cv, Clone::clone);
                let (into, from) = (exn::CallInput::Run, exn::CallInput::unwrap_run);
                def_run(id, call_typ, cvs, Id::run, with_vars, into, from)
            }
            Ast::Native(id, args) => {
                let cvs = bind_vars(args, cv.0.with_vars(Vars::new([])), cv, Clone::clone);
                flat_map_then(cvs, |cv| (cv.0.lut().funs[*id].run)(cv))
            }
            Ast::Label(id) => label_run(cv, |cv| id.run(cv)),
        };
        if let Some(data) = cancel { stop_on_cancel::<D, _>(data, values) } else { values }
    }

    /// `f.paths((c, (v, p)))` returns the outputs and paths of `v | f` in the context `c`,
    /// where `v` is assumed to be at path `p`.
    ///
    /// In particular, `v | path(f)` in context `c` yields the same paths as
    /// `f.paths((c, (v, Default::default())))`.
    pub fn paths<'a, D: DataT>(&self, cv: Cvp<'a, D>) -> ValPathXs<'a, D::V<'a>> {
        let err = |v| box_once(Err(Exn::from(Error::path_expr(v))));
        let proj_cv = |cv: &Cvp<'a, D>| (cv.0.clone(), cv.1 .0.clone());
        let proj_val = |(val, _path): &(D::V<'a>, _)| val.clone();
        let cancel = D::CHECK_CANCELLATION.then(|| cv.0.data.clone());
        let values = match &cv.0.lut().terms[self.0] {
            Ast::ToString => err(cv.1 .0),
            Ast::Int(_) | Ast::Num(_) | Ast::Str(_) => err(cv.1 .0),
            Ast::Arr(_) | Ast::ObjEmpty | Ast::ObjSingle(..) => err(cv.1 .0),
            Ast::Neg(_) | Ast::Logic(..) | Ast::Math(..) | Ast::Cmp(..) => err(cv.1 .0),
            Ast::Update(..) | Ast::Assign(..) => err(cv.1 .0),
            Ast::UpdateMath(..) | Ast::UpdateAlt(..) => err(cv.1 .0),
            Ast::Id => box_once(Ok(cv.1)),
            Ast::Recurse => recurse_run(cv.1, &|(v, p)| {
                v.key_values()
                    .map(move |r| r.map(|(k, v_)| (v_, p.clone().cons(k))))
            }),
            Ast::Pipe(l, None, r) => {
                flat_map_then_with(l.paths((cv.0.clone(), cv.1)), cv.0, move |y, ctx| {
                    r.paths((ctx, y))
                })
            }
            Ast::Pipe(l, Some(pat), r) => {
                flat_map_then_with(l.run(proj_cv(&cv)), cv, move |y, cv| {
                    bind_run(pat, r, cv, y, |f, cv| f.paths(cv))
                })
            }
            Ast::Comma(l, r) => Box::new(l.paths(cv.clone()).chain(lazy(|| r.paths(cv)))),
            Ast::Alt(l, r) => {
                let any_true = l
                    .run(proj_cv(&cv))
                    .any(|v| v.as_ref().map_or(true, ValT::as_bool));
                if any_true { l } else { r }.paths(cv)
            }
            Ast::Ite(if_, then_, else_) => {
                flat_map_then_with(if_.run(proj_cv(&cv)), cv, move |v, cv| {
                    if v.as_bool() { then_ } else { else_ }.paths(cv)
                })
            }
            Ast::TryCatch(f, c) => try_catch_run(f.paths((cv.0.clone(), cv.1)), move |e| {
                c.run((cv.0.clone(), e.into_val()))
                    .map(|e| Err(Exn::from(Error::path_expr(e?))))
            }),
            Ast::Path(f, path) => {
                let path = path.map_ref(|i| {
                    let cv = (cv.0.clone(), cv.1 .0.clone());
                    crate::into_iter::collect_if_once(move || i.run(cv))
                });
                flat_map_then_with(f.paths(cv), path, |y, path| {
                    flat_map_then_with(path.explode(), y, |path, y| {
                        Box::new(path.paths(y).map(|r| r.map_err(Exn::from)))
                    })
                })
            }
            Ast::Var(v) => match cv.0.vars.get(*v).unwrap() {
                Bind::Var(_) => err(cv.1 .0),
                Bind::Fun(l) => l.0.paths((cv.0.with_vars(l.1.clone()), cv.1)),
                Bind::Label(l) => box_once(Err(Exn(exn::Inner::Break(*l)))),
            },
            Ast::Fold(xs, pat, init, update, fold_type) => {
                let xs = rc_lazy_list::List::from_iter(run_and_bind(xs, proj_cv(&cv), pat));
                fold_run(xs, cv, init, update, fold_type, |f, cv| f.paths(cv))
            }
            Ast::CallDef(id, args, skip, call_typ) => {
                let data = cv.0.data.clone();
                let with_vars = move |vars| Ctx {
                    vars,
                    data: data.clone(),
                    labels: cv.0.labels,
                };
                let cvs = bind_vars(args, cv.0.clone().skip_vars(*skip), cv, proj_val);
                let (into, from) = (exn::CallInput::Paths, exn::CallInput::unwrap_paths);
                def_run(id, call_typ, cvs, Id::paths, with_vars, into, from)
            }
            Ast::Label(id) => label_run(cv, |cv| id.paths(cv)),
            Ast::Native(id, args) => {
                let cvs = bind_vars(args, cv.0.with_vars(Vars::new([])), cv, proj_val);
                flat_map_then(cvs, |cv| (cv.0.lut().funs[*id].paths)(cv))
            }
        };
        if let Some(data) = cancel { stop_on_cancel::<D, _>(data, values) } else { values }
    }

    /// `p.update((c, v), f)` returns the output of `v | p |= f` in the context `c`.
    pub fn update<'a, D: DataT>(
        &self,
        cv: Cv<'a, D>,
        f: BoxUpdate<'a, D::V<'a>>,
    ) -> ValXs<'a, D::V<'a>> {
        let err = |v| box_once(Err(Exn::from(Error::path_expr(v))));
        let cancel = D::CHECK_CANCELLATION.then(|| cv.0.data.clone());
        let values = match &cv.0.lut().terms[self.0] {
            Ast::ToString => err(cv.1),
            Ast::Int(_) | Ast::Num(_) | Ast::Str(_) => err(cv.1),
            Ast::Arr(_) | Ast::ObjEmpty | Ast::ObjSingle(..) => err(cv.1),
            Ast::Neg(_) | Ast::Logic(..) | Ast::Math(..) | Ast::Cmp(..) => err(cv.1),
            Ast::Update(..) | Ast::Assign(..) => err(cv.1),
            Ast::UpdateMath(..) | Ast::UpdateAlt(..) => err(cv.1),
            // jq implements updates on `try ... catch` and `label`, but
            // I do not see how to implement this in jaq
            Ast::TryCatch(..) | Ast::Label(..) => err(cv.1),

            Ast::Id => f(cv.1),
            Ast::Recurse => recurse_update(cv.1, &f),
            Ast::Path(l, path) => {
                let path = path.map_ref(|i| {
                    let cv = cv.clone();
                    crate::into_iter::collect_if_once(move || i.run(cv))
                });
                let f = move |v| {
                    let mut paths = path.clone().explode();
                    box_once(paths.try_fold(v, |acc, path| path?.update(acc, &f)))
                };
                l.update(cv, Box::new(f))
            }
            Ast::Pipe(l, None, r) => l.update(
                (cv.0.clone(), cv.1),
                Box::new(move |v| r.update((cv.0.clone(), v), f.clone())),
            ),
            Ast::Pipe(l, Some(pat), r) => reduce(
                run_and_bind(l, (cv.0, cv.1.clone()), pat),
                cv.1,
                move |ctx, v| r.update((ctx, v), f.clone()),
            ),
            Ast::Comma(l, r) => flat_map_then_with(
                l.update((cv.0.clone(), cv.1), f.clone()),
                (cv.0, f),
                move |v, (ctx, f)| r.update((ctx, v), f),
            ),
            Ast::Ite(if_, then_, else_) => reduce(if_.run(cv.clone()), cv.1, move |x, v| {
                if x.as_bool() { then_ } else { else_ }.update((cv.0.clone(), v), f.clone())
            }),
            Ast::Alt(l, r) => {
                let some_true = l.run(cv.clone()).any(|y| y.map_or(true, |y| y.as_bool()));
                if some_true { l } else { r }.update(cv, f)
            }
            Ast::Fold(xs, pat, init, update, fold_type) => {
                let xs = rc_lazy_list::List::from_iter(run_and_bind(xs, cv.clone(), pat));
                let rec = move |v| fold_update(fold_type, update, v, xs.clone(), f.clone());
                init.update(cv, Box::new(rec))
            }
            Ast::Var(v) => match cv.0.vars.get(*v).unwrap() {
                Bind::Var(_) => err(cv.1),
                Bind::Fun(l) => l.0.update((cv.0.with_vars(l.1.clone()), cv.1), f),
                Bind::Label(l) => box_once(Err(Exn(exn::Inner::Break(*l)))),
            },
            Ast::CallDef(id, args, skip, _call_typ) => {
                let init = cv.1.clone();
                let cvs = bind_vars(args, cv.0.clone().skip_vars(*skip), cv, Clone::clone);
                reduce(cvs, init, move |cv, v| id.update((cv.0, v), f.clone()))
            }
            Ast::Native(id, args) => {
                let init = cv.1.clone();
                let cvs = bind_vars(args, cv.0.with_vars(Vars::new([])), cv, Clone::clone);
                reduce(cvs, init, move |cv, v| {
                    (cv.0.lut().funs[*id].update)((cv.0, v), f.clone())
                })
            }
        };
        if let Some(data) = cancel { stop_on_cancel::<D, _>(data, values) } else { values }
    }
}
