//! Filter execution.

use crate::compile::{Bind, CallType, Fold, Pattern, Term as Ast, TermId as Id};
use crate::data::{DataT, HasLut};
use crate::val::{ValR, ValT, ValX, ValXs};
use crate::{exn, Bind as Arg, Error, Exn, RcList};
use alloc::boxed::Box;

/// Combination of context and input value.
pub type Cv<'a, D, T = <D as DataT>::V<'a>> = (Ctx<'a, D>, T);
/// Combination of context and input value with a path.
type Cvp<'a, D> = Cv<'a, D, (<D as DataT>::V<'a>, RcList<<D as DataT>::V<'a>>)>;
type ValPathXs<'a, V> = ValXs<'a, (V, RcList<V>), V>;

type Lut<D> = crate::compile::Lut<Native<D>>;

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

impl<V> Drop for Vars<V> {
    fn drop(&mut self) {
        let mut pending = Vec::new();
        let mut vars = core::mem::take(&mut self.0);
        loop {
            match vars.pop_unique() {
                Some((Bind::Fun((_, mut saved)), tail)) => {
                    if tail.head().is_some() { pending.push(tail); }
                    vars = core::mem::take(&mut saved.0);
                },
                Some((_, tail)) => vars = tail,
                None => match pending.pop() {
                    Some(tail) => vars = tail,
                    None => break,
                },
            }
        }
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
        self.vars.0 = core::mem::take(&mut self.vars.0).cons(Bind::Var(x));
        self
    }

    /// Add a new filter binding.
    fn cons_fun(mut self, (f, ctx): (Id, Self)) -> Self {
        self.vars.0 = core::mem::take(&mut self.vars.0).cons(Bind::Fun((f, ctx.vars)));
        self
    }

    fn cons_label(mut self) -> Self {
        self.labels += 1;
        self.vars.0 = core::mem::take(&mut self.vars.0).cons(Bind::Label(self.labels));
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

// ===== Stack-safe evaluation of `run` =====
//
// The recursive arms below build a tree of `pull::Node`s instead of polling
// nested iterators, so evaluation nesting lives on the driver's heap stack.

use crate::pull::{self, Action, Input, Node as NodeT};
use alloc::vec::Vec;

/// Deepest driver nesting before unbounded recursion is cut off.
const MAX_DEPTH: usize = 1 << 19;

/// Payload of a `run` output.
#[doc(hidden)]
pub enum Payload<'a, D: DataT + ?Sized> {
    Val(D::V<'a>),
    Ctx(Ctx<'a, D>),
    Cv(Ctx<'a, D>, exn::CallInput<D::V<'a>>),
    Part(crate::path::Part<ValX<'a, D::V<'a>>>),
    Parts(Vec<(crate::path::Part<D::V<'a>>, crate::path::Opt)>),
    /// A value together with the path it is at, as produced by `paths`.
    ValPath(D::V<'a>, RcList<D::V<'a>>),
}

pub type Item<'a, D> = Result<Payload<'a, D>, Exn<'a, <D as DataT>::V<'a>>>;
pub type INode<'a, D> = Box<dyn NodeT<'a, Item<'a, D>> + 'a>;
type Values<'a, D> = Vec<Box<dyn Iterator<Item = ValR<<D as DataT>::V<'a>>>>>;

pub(crate) fn n_once<'a, D: DataT>(x: ValX<'a, D::V<'a>>) -> INode<'a, D> {
    Box::new(pull::Once::new(x.map(Payload::Val)))
}

pub(crate) fn n_map<'a, D: DataT>(child: INode<'a, D>, f: impl FnMut(Item<'a, D>) -> Item<'a, D> + 'a) -> INode<'a, D> {
    Box::new(pull::Map::new(child, f))
}

fn n_flat<'a, D: DataT>(child: INode<'a, D>, mut f: impl FnMut(Item<'a, D>) -> INode<'a, D> + 'a) -> INode<'a, D> {
    Box::new(pull::FlatMap::new(child, move |x| Ok(f(x))))
}

fn n_collect<'a,D:DataT>(child: INode<'a,D>) -> INode<'a,D> {
    struct Array<'a,D:DataT> { child: Option<INode<'a,D>>, values: Vec<D::V<'a>>, done: bool }
    impl<'a,D:DataT> NodeT<'a,Item<'a,D>> for Array<'a,D> {
        fn last(&self, _: bool) -> bool { true }
        fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
            if self.done { return Action::Done }
            match input {
                Input::Start => self.child.take().map_or(Action::Continue, Action::Descend),
                Input::Item(Ok(Payload::Val(v))) => { self.values.push(v); Action::Continue },
                Input::Item(Err(e)) => { self.done = true; Action::Yield(Err(e)) },
                Input::Item(Ok(_)) => unreachable!(),
                Input::End => {
                    self.done = true;
                    Action::Yield(Ok(Payload::Val(core::mem::take(&mut self.values).into_iter().collect())))
                },
            }
        }
    }
    Box::new(Array { child: Some(child), values: Vec::new(), done: false })
}

fn n_from<'a, D: DataT>(it: ValXs<'a, D::V<'a>>) -> INode<'a, D> {
    Box::new(pull::FromIter::new(Box::new(it.map(|x| x.map(Payload::Val)))))
}

fn item_truthy<'a, D: DataT>(it: &Item<'a, D>) -> bool {
    match it {
        Ok(Payload::Val(v)) => v.as_bool(),
        _ => true,
    }
}

fn deep<'a, D: DataT>() -> Item<'a, D> {
    Err(Exn::from(Error::too_deep()))
}

/// Build the node for `id`.
///
/// Terms with sub-filters are built lazily, so a deeply nested filter graph is
/// constructed one level at a time on the driver's heap stack instead of
/// recursing through `build_run` on the native stack. Childless terms are built
/// directly, keeping the common case at its previous allocation cost.
pub(crate) fn run_node<'a, D: DataT>(id: Id, cv: Cv<'a, D>) -> INode<'a, D> {
    let leaf = matches!(
        &cv.0.lut().terms[id.0],
        Ast::Id
            | Ast::Recurse
            | Ast::ToString
            | Ast::Int(_)
            | Ast::Num(_)
            | Ast::Str(_)
            | Ast::Bool(_)
            | Ast::Null
            | Ast::Fail(_)
            | Ast::ObjEmpty
    );
    let build = move || checked_build(cv, |cv| build_run(id, cv));
    if leaf {
        build()
    } else {
        pull::lazy(build)
    }
}

fn checked_build<'a, D: DataT, T>(cv: Cv<'a, D, T>, build: impl FnOnce(Cv<'a, D, T>) -> INode<'a, D>) -> INode<'a, D> {
    if D::CHECK_CANCELLATION {
        if D::cancelled(&cv.0.data) {
            return Box::new(pull::Empty);
        }
        let data = cv.0.data.clone();
        Box::new(CancelNode { data, inner: build(cv) })
    } else {
        build(cv)
    }
}

struct CancelNode<'a, D: DataT> {
    data:  D::Data<'a>,
    inner: INode<'a, D>,
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for CancelNode<'a, D> {
    fn last(&self, child_last: bool) -> bool { self.inner.last(child_last) }

    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        self.resume_item(input, false)
    }

    fn resume_item(&mut self, input: Input<Item<'a,D>>, last: bool) -> Action<'a,Item<'a,D>> {
        if D::cancelled(&self.data) { Action::Done } else { self.inner.resume_item(input,last) }
    }
}

fn build_run<'a, D: DataT>(id: Id, cv: Cv<'a, D>) -> INode<'a, D> {
    match &cv.0.lut().terms[id.0] {
        Ast::Id => n_once(Ok(cv.1)),
        Ast::Recurse => Box::new(RecurseRun::new(cv.1)),
        Ast::ToString => n_once(Ok(cv.1.into_string())),
        Ast::Int(x) => n_once(Ok(D::V::from(*x))),
        Ast::Num(x) => n_once(D::V::from_num(x).map_err(Exn::from)),
        Ast::Str(s) => n_once(Ok(D::V::from(s.clone()))),
        Ast::Bool(b) => n_once(Ok(D::V::from(*b))),
        Ast::Null => n_once(Ok(D::V::null())),
        Ast::Fail(s) => n_once(Err(Exn::from(Error::str(s.clone())))),
        Ast::Arr(f) => n_collect(run_node(*f, (cv.0, cv.1))),
        Ast::ObjEmpty => n_once(D::V::from_map([]).map_err(Exn::from)),
        Ast::ObjSingle(k, v) => {
            let (c0, c1) = (cv.0.clone(), cv.1.clone());
            n_flat(run_node(*k, (cv.0, cv.1)), move |it| match it {
                Ok(Payload::Val(k)) => {
                    let (c0, c1) = (c0.clone(), c1.clone());
                    n_map(run_node(*v, (c0, c1)), move |it| match it {
                        Ok(Payload::Val(v)) => D::V::from_map([(k.clone(), v)]).map(Payload::Val).map_err(Exn::from),
                        other => other,
                    })
                },
                other => Box::new(pull::Once::new(other)),
            })
        },
        Ast::ObjCat(l, r) => {
            let (c0, c1) = (cv.0.clone(), cv.1.clone());
            n_flat(run_node(*l, (cv.0, cv.1)), move |it| match it {
                Ok(Payload::Val(l)) => {
                    let (c0, c1) = (c0.clone(), c1.clone());
                    n_map(run_node(*r, (c0, c1)), move |it| match it {
                        Ok(Payload::Val(r)) => (l.clone() + r).map(Payload::Val).map_err(Exn::from),
                        other => other,
                    })
                },
                other => Box::new(pull::Once::new(other)),
            })
        },
        Ast::Neg(f) => n_map(run_node(*f, (cv.0, cv.1)), |it| match it {
            Ok(Payload::Val(v)) => (-v).map(Payload::Val).map_err(Exn::from),
            other => other,
        }),
        Ast::Pipe(l, None, r) => {
            let c0 = cv.0.clone();
            n_flat(run_node(*l, (cv.0, cv.1)), move |it| match it {
                Ok(Payload::Val(y)) => run_node(*r, (c0.clone(), y)),
                other => Box::new(pull::Once::new(other)),
            })
        },
        Ast::Pipe(l, Some(pat), r) => n_flat(run_node(*l, (cv.0.clone(), cv.1.clone())), move |it| match it {
            Ok(Payload::Val(y)) => nbind_run(pat, r, cv.clone(), y, run_node),
            other => Box::new(pull::Once::new(other)),
        }),
        Ast::PipeAlt(l, alts) => n_flat(run_node(*l, (cv.0.clone(), cv.1.clone())), move |it| match it {
            Ok(Payload::Val(y)) => Box::new(AltChain::new(alts, cv.clone(), y, run_node)),
            other => Box::new(pull::Once::new(other)),
        }),
        Ast::Comma(l, r) => Box::new(pull::Concat::new([
            run_node(*l, (cv.0.clone(), cv.1.clone())),
            run_node(*r, cv),
        ])),
        Ast::Alt(l, r) => Box::new(pull::Alt::new(
            run_node(*l, (cv.0.clone(), cv.1.clone())),
            run_node(*r, cv),
            |it| item_truthy(it),
        )),
        Ast::Ite(if_, then_, else_) => n_flat(run_node(*if_, (cv.0.clone(), cv.1.clone())), move |it| match it {
            Ok(Payload::Val(v)) => run_node(if v.as_bool() { *then_ } else { *else_ }, cv.clone()),
            other => Box::new(pull::Once::new(other)),
        }),
        Ast::Path(..) => path_run_node(id, cv),
        Ast::Update(path, f) => {
            let (ctx, acc) = cv;
            Box::new(ModifyNode {
                paths: Some(paths_node(*path, (ctx.clone(), (acc.clone(), RcList::new())))),
                update: *f,
                ctx,
                acc: Some(acc),
                deleted: Vec::new(),
                cur: None,
                phase: ModPhase::Paths,
            })
        },
        Ast::Assign(..) | Ast::UpdateMath(..) | Ast::UpdateAlt(..) => path_update_node(id, cv),
        Ast::Logic(l, stop, r) => {
            let (c0, c1, stop) = (cv.0.clone(), cv.1.clone(), *stop);
            n_flat(run_node(*l, (cv.0, cv.1)), move |it| match it {
                Ok(Payload::Val(l)) => {
                    if l.as_bool() == stop {
                        n_once(Ok(D::V::from(stop)))
                    } else {
                        let (c0, c1) = (c0.clone(), c1.clone());
                        n_map(run_node(*r, (c0, c1)), move |it| match it {
                            Ok(Payload::Val(v)) => Ok(Payload::Val(D::V::from(v.as_bool()))),
                            other => other,
                        })
                    }
                },
                other => Box::new(pull::Once::new(other)),
            })
        },
        Ast::Math(l, op, r) => {
            let (op, c0, c1) = (*op, cv.0.clone(), cv.1.clone());
            n_flat(run_node(*r, (c0.clone(), c1.clone())), move |it| match it {
                Ok(Payload::Val(y)) => {
                    let (c0, c1, y) = (c0.clone(), c1.clone(), y);
                    n_map(run_node(*l, (c0, c1)), move |it| match it {
                        Ok(Payload::Val(x)) => op.run(x, y.clone()).map(Payload::Val).map_err(Exn::from),
                        other => other,
                    })
                },
                other => Box::new(pull::Once::new(other)),
            })
        },
        Ast::Cmp(l, op, r) => {
            let (op, c0, c1) = (*op, cv.0.clone(), cv.1.clone());
            n_flat(run_node(*r, (c0.clone(), c1.clone())), move |it| match it {
                Ok(Payload::Val(y)) => {
                    let (c0, c1, y) = (c0.clone(), c1.clone(), y);
                    n_map(run_node(*l, (c0, c1)), move |it| match it {
                        Ok(Payload::Val(x)) => x.cmp_op(op, &y).map(|b| Payload::Val(D::V::from(b))).map_err(Exn::from),
                        other => other,
                    })
                },
                other => Box::new(pull::Once::new(other)),
            })
        },
        Ast::TryCatch(f, c) => Box::new(TryCatchNode {
            child:    run_node(*f, (cv.0.clone(), cv.1)),
            ctx:      cv.0.clone(),
            catch:    c,
            started:  false,
            in_catch: false,
            paths: false,
        }),
        Ast::Fold(xs, pat, init, update, fold) => fold_node(
            nrun_and_bind(xs, cv.clone(), pat), run_node(*init,cv), *update, fold, run_node, |v| {
                let Payload::Val(v) = v else { unreachable!() };
                v
            },
        ),
        Ast::Var(v) => {
            let bind = cv.0.vars.get(*v).unwrap().clone();
            match bind {
                Bind::Var(v) => n_once(Ok(v)),
                Bind::Fun((id, vars)) => run_node(id, (cv.0.with_vars(vars), cv.1)),
                Bind::Label(l) => Box::new(pull::Once::new(Err(Exn(exn::Inner::Break(l))))),
            }
        },
        Ast::CallDef(id, args, skip, call_typ) => {
            let data = cv.0.data.clone();
            let labels = cv.0.labels;
            let ctx = cv.0.clone().skip_vars(*skip);
            let cvs = nbind_vars(args, ctx, (cv.0, exn::CallInput::Run(cv.1)));
            let with_vars = move |vars| Ctx { vars, data: data.clone(), labels };
            Box::new(DefNode {
                cvs,
                id,
                all: matches!(call_typ, CallType::CatchAll),
                throw: matches!(call_typ, CallType::Throw),
                with_vars: Box::new(with_vars),
                body: |id, (ctx, v)| run_node(id, (ctx, v.unwrap_run())),
                phase: DefPhase::Init,
                suspended: 0,
                outer_last: false,
            })
        },
        Ast::Native(id, args) => {
            let native = &cv.0.lut().funs[*id].run;
            let cvs = nbind_vars(args, cv.0.with_vars(Vars::new([])), (cv.0, exn::CallInput::Run(cv.1)));
            n_ok(cvs, move |x| {
                let Payload::Cv(ctx, v) = x else { unreachable!() };
                let cv = (ctx, v.unwrap_run());
                match native {
                    NativeRun::Leaf(run) => n_from(run(cv)),
                    NativeRun::Eval(run) => run(cv),
                }
            })
        },
        Ast::Label(f) => {
            let ctx = cv.0.cons_label();
            let label = ctx.labels;
            Box::new(LabelNode { child: run_node(*f, (ctx, cv.1)), label, started: false })
        },
    }
}

use crate::path::{Opt, Part, Path};
use alloc::rc::Rc;

type Value<'a, D> = <D as DataT>::V<'a>;
type Vp<'a, D> = (Value<'a, D>, RcList<Value<'a, D>>);
/// A replacement callback used by a resumable native update.
pub struct Updater<'a,D:DataT + ?Sized>(Option<Rc<UpdateState<'a,D>>>);

struct UpdateState<'a,D:DataT + ?Sized> {
    call: Box<dyn Fn(Value<'a,D>, &Updater<'a,D>) -> INode<'a,D> + 'a>,
    tail: Updater<'a,D>,
}

impl<'a,D:DataT> Updater<'a,D> {
    /// Build an update whose body returns a node to be driven by the caller.
    pub fn new(f: impl Fn(Value<'a,D>) -> INode<'a,D> + 'a) -> Self {
        Self(None).wrap(move |v, _| f(v))
    }

    fn wrap(self, call: impl Fn(Value<'a,D>, &Self) -> INode<'a,D> + 'a) -> Self {
        Self(Some(Rc::new(UpdateState { call: Box::new(call), tail: self })))
    }

    /// Build the replacement node for one value on the current driver.
    pub fn apply(&self, v: Value<'a,D>) -> INode<'a,D> {
        let state = self.0.as_ref().unwrap();
        (state.call)(v,&state.tail)
    }
}

impl<D:DataT + ?Sized> Clone for Updater<'_,D> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}

impl<D:DataT + ?Sized> Drop for Updater<'_,D> {
    fn drop(&mut self) {
        let mut next = self.0.take();
        while let Some(state) = next {
            let Ok(mut state) = Rc::try_unwrap(state) else { break };
            next = state.tail.0.take();
        }
    }
}


pub(crate) fn n_item<'a, D: DataT>(x: Item<'a, D>) -> INode<'a, D> {
    Box::new(pull::Once::new(x))
}

pub(crate) fn val<'a, D: DataT>(x: Item<'a, D>) -> ValX<'a, Value<'a, D>> {
    x.map(|x| match x { Payload::Val(v) => v, _ => unreachable!() })
}

fn path_value<'a, D: DataT>(x: Payload<'a, D>) -> Vp<'a, D> {
    match x { Payload::ValPath(v, p) => (v, p), _ => unreachable!() }
}

fn n_ok<'a, D: DataT>(node: INode<'a, D>, mut f: impl FnMut(Payload<'a, D>) -> INode<'a, D> + 'a) -> INode<'a, D> {
    Box::new(pull::FlatMap::new(node, move |x| x.map(&mut f).map_err(Err)))
}

fn part_node<'a, D: DataT>(part: &'a Part<Id>, cv: Cv<'a, D>) -> INode<'a, D> {
    match part {
        Part::Index(i) => n_map(run_node(*i, cv), |x| Ok(Payload::Part(Part::Index(val(x))))),
        Part::Range(None, None) => n_item(Ok(Payload::Part(Part::Range(None, None)))),
        Part::Range(Some(l), None) => n_map(run_node(*l, cv), |x| Ok(Payload::Part(Part::Range(Some(val(x)), None)))),
        Part::Range(None, Some(r)) => n_map(run_node(*r, cv), |x| Ok(Payload::Part(Part::Range(None, Some(val(x)))))),
        Part::Range(Some(l), Some(r)) => n_flat(run_node(*l, cv.clone()), move |x| {
            let lo = val(x);
            n_map(run_node(*r, cv.clone()), move |y| Ok(Payload::Part(Part::Range(Some(lo.clone()), Some(val(y))))))
        }),
    }
}

// Index filters run on the original input, and complete index tuples vary
// outside the value traversal, just as they did in the exploded iterator.
fn path_parts<'a, D: DataT>(path: &'a [(Part<Id>, Opt)], cv: Cv<'a, D>, parts: RcList<(Part<ValX<'a, Value<'a, D>>>, Opt)>) -> INode<'a, D> {
    let Some(((part, opt), rest)) = path.split_first() else {
        let mut parts: Vec<_> = parts.iter().cloned().collect();
        parts.reverse();
        let parts = parts.into_iter().map(|(part, opt)| Ok((part.transpose()?, opt))).collect::<Result<_, _>>();
        return n_item(parts.map(Payload::Parts));
    };
    n_ok(part_node(part, cv.clone()), move |p| {
        let Payload::Part(part) = p else { unreachable!() };
        path_parts(rest, cv.clone(), parts.clone().cons((part, *opt)))
    })
}

fn apply_part<'a, D: DataT>(part: &Part<Value<'a,D>>, opt: Opt, base: Payload<'a,D>) -> INode<'a,D> {
    let optional = matches!(opt, Opt::Optional);
    match base {
        Payload::Val(v) => n_from(Box::new(part.run(v).filter(move |x| !optional || x.is_ok()).map(|x| x.map_err(Exn::from)))),
        Payload::ValPath(v, p) => {
            if p.is_invalid() {
                return n_item(Err(part.not_at_path(&v).into()));
            }
            paths_from(Box::new(part.paths((v, p)).filter(move |x| !optional || x.is_ok()).map(|x| x.map_err(Exn::from))))
        },
        _ => unreachable!(),
    }
}

fn apply_path<'a, D: DataT>(parts: Rc<[(Part<Value<'a, D>>, Opt)]>, i: usize, base: Payload<'a, D>) -> INode<'a, D> {
    let Some((part,opt)) = parts.get(i) else { return n_item(Ok(base)) };
    let node = apply_part(part,*opt,base);
    if i + 1 == parts.len() { node } else {
        n_ok(node, move |x| apply_path(parts.clone(), i + 1, x))
    }
}

fn path_access<'a, D: DataT>(base: INode<'a, D>, path: &'a Path<Id>, cv: Cv<'a, D>) -> INode<'a, D> {
    if let [(Part::Range(None,None), opt)] = path.0.as_slice() {
        return n_ok(base, move |base| apply_part(&Part::Range(None,None), *opt, base));
    }
    n_ok(base, move |base| {
        n_ok(path_parts(&path.0, cv.clone(), RcList::new()), move |parts| {
            let Payload::Parts(parts) = parts else { unreachable!() };
            let base = match &base {
                Payload::Val(v) => Payload::Val(v.clone()),
                Payload::ValPath(v,p) => Payload::ValPath(v.clone(),p.clone()),
                _ => unreachable!(),
            };
            apply_path(parts.into(), 0, base)
        })
    })
}

fn path_run_node<'a, D: DataT>(id: Id, cv: Cv<'a, D>) -> INode<'a, D> {
    let Ast::Path(f, path) = &cv.0.lut().terms[id.0] else { unreachable!() };
    path_access(run_node(*f, cv.clone()), path, cv)
}

fn path_update_node<'a, D: DataT>(id: Id, cv: Cv<'a, D>) -> INode<'a, D> {
    let (path, f, op) = match &cv.0.lut().terms[id.0] {
        Ast::UpdateMath(path, op, f) => (*path, *f, Some(Some(*op))),
        Ast::UpdateAlt(path, f) => (*path, *f, Some(None)),
        Ast::Assign(path, f) => (*path, *f, None),
        _ => unreachable!(),
    };
    n_ok(run_node(f, cv.clone()), move |y| {
        let Payload::Val(y) = y else { unreachable!() };
        update_node(path, cv.clone(), Updater::new(move |x| {
            n_once(match op {
                Some(Some(op)) => op.run(x, y.clone()).map_err(Exn::from),
                Some(None) if x.as_bool() => Ok(x),
                _ => Ok(y.clone()),
            })
        }))
    })
}

// ---- variable and pattern binding ----

fn nbind_vars<'a, D: DataT>(
    args: &'a [Arg<Id>],
    ctx: Ctx<'a, D>,
    cv: Cv<'a, D, exn::CallInput<D::V<'a>>>,
) -> INode<'a, D> {
    let mut args = args;
    let mut ctx = ctx;
    while let Some((Arg::Fun(arg), rest)) = args.split_first() {
        ctx = ctx.cons_fun((*arg, cv.0.clone()));
        args = rest;
    }
    match args.split_first() {
        None => n_item(Ok(Payload::Cv(ctx, cv.1))),
        Some((Arg::Var(arg), rest)) => n_ok(run_node(*arg, (cv.0.clone(), cv.1.value().clone())), move |y| {
            let Payload::Val(y) = y else { unreachable!() };
            nbind_vars(rest, ctx.clone().cons_var(y), cv.clone())
        }),
        Some((Arg::Fun(_), _)) => unreachable!(),
    }
}

fn nbind_pat<'a, D: DataT>(pat: &'a Pattern<Id>, ctx: Ctx<'a, D>, cv: Cv<'a, D>) -> INode<'a, D> {
    let (mut pat, mut ctx) = (pat, ctx);
    loop {
        match pat {
            Pattern::Var => return n_item(Ok(Payload::Ctx(ctx.cons_var(cv.1)))),
            Pattern::Idx(pats) => return nbind_pats(pats, ctx, cv),
            Pattern::Both(next) => {
                ctx = ctx.cons_var(cv.1.clone());
                pat = next;
            },
        }
    }
}

fn nbind_pats<'a, D: DataT>(pats: &'a [(Id, Pattern<Id>)], ctx: Ctx<'a, D>, cv: Cv<'a, D>) -> INode<'a, D> {
    match pats.split_first() {
        None => Box::new(pull::Once::new(Ok(Payload::Ctx(ctx)))),
        Some((pat, [])) => nbind_idx(pat, ctx, cv),
        Some((pat, rest)) => {
            let (c0, v0) = (cv.0.clone(), cv.1.clone());
            n_flat(nbind_idx(pat, ctx, cv), move |it| match it {
                Ok(Payload::Ctx(ctx)) => nbind_pats(rest, ctx, (c0.clone(), v0.clone())),
                other => Box::new(pull::Once::new(other)),
            })
        },
    }
}

fn nbind_idx<'a, D: DataT>((idxs, pat): &'a (Id, Pattern<Id>), ctx: Ctx<'a, D>, cv: Cv<'a, D>) -> INode<'a, D> {
    let (ctx0, v0) = (cv.0.clone(), cv.1.clone());
    n_flat(run_node(*idxs, cv), move |it| match it {
        Ok(Payload::Val(i)) => match v0.clone().index(&i) {
            Ok(v) => nbind_pat(pat, ctx.clone(), (ctx0.clone(), v)),
            Err(e) => Box::new(pull::Once::new(Err(Exn::from(e)))),
        },
        other => Box::new(pull::Once::new(other)),
    })
}

fn nrun_and_bind<'a, D: DataT>(xs: &'a Id, cv: Cv<'a, D>, pat: &'a Pattern<Id>) -> INode<'a, D> {
    match pat {
        Pattern::Var => {
            let ctx = cv.0.clone();
            n_map(run_node(*xs, cv), move |it| match it {
                Ok(Payload::Val(y)) => Ok(Payload::Ctx(ctx.clone().cons_var(y))),
                other => other,
            })
        },
        pat => {
            let ctx0 = cv.0.clone();
            n_flat(run_node(*xs, cv), move |it| match it {
                Ok(Payload::Val(y)) => nbind_pat(pat, ctx0.clone(), (ctx0.clone(), y)),
                other => Box::new(pull::Once::new(other)),
            })
        },
    }
}

fn nbind_run<'a, D: DataT, T: Clone + 'a>(pat: &'a Pattern<Id>, r: &'a Id, cv: Cv<'a, D, T>, y: D::V<'a>, run: Eval<'a, D, T>) -> INode<'a, D> {
    match pat {
        Pattern::Var => run(*r, (cv.0.cons_var(y), cv.1)),
        pat => {
            let (ctx, v1) = (cv.0, cv.1);
            n_flat(nbind_pat(pat, ctx.clone(), (ctx, y)), move |it| match it {
                Ok(Payload::Ctx(ctx)) => run(*r, (ctx, v1.clone())),
                other => Box::new(pull::Once::new(other)),
            })
        },
    }
}

/// `y as p1 ?// p2 | r`, trying the next alternative after an error.
struct AltChain<'a, D: DataT, T> {
    alts:    &'a [(usize, Pattern<Id>, Id)],
    idx:     usize,
    cv:      Cv<'a, D, T>,
    run:     Eval<'a, D, T>,
    y:       D::V<'a>,
    child:   INode<'a, D>,
    started: bool,
}

impl<'a, D: DataT, T: Clone + 'a> AltChain<'a, D, T> {
    fn alt_node(alts: &'a [(usize, Pattern<Id>, Id)], idx: usize, cv: Cv<'a, D, T>, y: D::V<'a>, run: Eval<'a, D, T>) -> INode<'a, D> {
        let (nulls, pat, r) = &alts[idx];
        let ctx = (0..*nulls).fold(cv.0.clone(), |ctx, _| ctx.cons_var(D::V::null()));
        nbind_run(pat, r, (ctx, cv.1), y, run)
    }

    fn new(alts: &'a [(usize, Pattern<Id>, Id)], cv: Cv<'a, D, T>, y: D::V<'a>, run: Eval<'a, D, T>) -> Self {
        let child = Self::alt_node(alts, 0, cv.clone(), y.clone(), run);
        Self { alts, idx: 0, cv, run, y, child, started: false }
    }
}

impl<'a, D: DataT, T: Clone + 'a> NodeT<'a, Item<'a, D>> for AltChain<'a, D, T> {
    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        match input {
            Input::Start if !self.started => {
                self.started = true;
                Action::Descend(core::mem::replace(&mut self.child, Box::new(pull::Empty)))
            },
            Input::Start => Action::Continue,
            Input::Item(Err(Exn(exn::Inner::Err(_)))) if self.idx + 1 < self.alts.len() => {
                self.idx += 1;
                Action::Replace(Self::alt_node(self.alts, self.idx, self.cv.clone(), self.y.clone(), self.run))
            },
            Input::Item(x) => Action::Yield(x),
            Input::End => Action::Done,
        }
    }
}

/// `def recurse: (.[]? | recurse), .` applied to `v`, depth-first.
struct RecurseRun<'a, D: DataT> {
    stack:   Values<'a, D>,
    pending: Option<Item<'a, D>>,
}

impl<'a, D: DataT> RecurseRun<'a, D> {
    fn new(v: D::V<'a>) -> Self {
        Self { stack: Vec::new(), pending: Some(Ok(Payload::Val(v))) }
    }
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for RecurseRun<'a, D> {
    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        match input {
            Input::Start => {},
            _ => return Action::Done,
        }
        if let Some(it) = self.pending.take() {
            if let Ok(Payload::Val(v)) = &it {
                self.stack.push(v.clone().values());
            }
            return Action::Yield(it);
        }
        loop {
            let Some(top) = self.stack.last_mut() else { return Action::Done };
            match top.next() {
                None => {
                    self.stack.pop();
                },
                Some(Ok(v)) => {
                    self.stack.push(v.clone().values());
                    return Action::Yield(Ok(Payload::Val(v)));
                },
                Some(Err(_)) => {},
            }
        }
    }
}

enum DefPhase {
    Init,
    Outer,
    Inner,
}

/// A call to a filter definition, trampolining tail calls on the heap.
struct DefNode<'a, D: DataT> {
    cvs:       INode<'a, D>,
    id:        &'a Id,
    all:       bool,
    throw:     bool,
    with_vars: Box<dyn Fn(Vars<D::V<'a>>) -> Ctx<'a, D> + 'a>,
    body:      fn(Id, Cv<'a, D, exn::CallInput<D::V<'a>>>) -> INode<'a, D>,
    phase:     DefPhase,
    suspended: usize,
    outer_last: bool,
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for DefNode<'a, D> {
    fn last(&self, child_last: bool) -> bool {
        child_last && (matches!(self.phase,DefPhase::Outer) || self.outer_last && self.suspended == 0)
    }

    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        self.resume_item(input,false)
    }

    fn resume_item(&mut self, input: Input<Item<'a,D>>, last: bool) -> Action<'a, Item<'a,D>> {
        match self.phase {
            DefPhase::Init => {
                self.phase = DefPhase::Outer;
                Action::Descend(core::mem::replace(&mut self.cvs, Box::new(pull::Empty)))
            },
            DefPhase::Outer => match input {
                Input::Start => Action::Continue,
                Input::Item(Err(e)) => Action::Yield(Err(e)),
                Input::Item(Ok(Payload::Cv(ctx, v))) => {
                    self.outer_last = last;
                    if self.throw {
                        let tc = exn::Inner::TailCall(Box::new((self.id, ctx.vars, v)));
                        Action::Yield(Err(Exn(tc)))
                    } else {
                        self.phase = DefPhase::Inner;
                        Action::Descend((self.body)(*self.id, (ctx, v)))
                    }
                },
                Input::Item(Ok(_)) => unreachable!(),
                Input::End => Action::Done,
            },
            DefPhase::Inner => match input {
                Input::Start => Action::Continue,
                Input::Item(Err(Exn(exn::Inner::TailCall(tc)))) if self.all || tc.0 == self.id => {
                    let ctx = (self.with_vars)(tc.1);
                    let body = (self.body)(*tc.0, (ctx, tc.2));
                    if last { Action::Replace(body) } else {
                        self.suspended += 1;
                        Action::TailBranch(body)
                    }
                },
                Input::Item(x) => Action::Yield(x),
                Input::End if self.suspended != 0 => {
                    self.suspended -= 1;
                    Action::Continue
                },
                Input::End => {
                    self.phase = DefPhase::Outer;
                    Action::Continue
                },
            },
        }
    }
}

/// `try f catch c`: replace `f`'s first error with `c` applied to it.
struct TryCatchNode<'a, D: DataT> {
    child:    INode<'a, D>,
    ctx:      Ctx<'a, D>,
    catch:    &'a Id,
    started:  bool,
    in_catch: bool,
    paths: bool,
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for TryCatchNode<'a, D> {
    fn last(&self, child_last: bool) -> bool { child_last }
    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        match input {
            Input::Start if !self.started => {
                self.started = true;
                Action::Descend(core::mem::replace(&mut self.child, Box::new(pull::Empty)))
            },
            Input::Start => Action::Continue,
            Input::Item(Err(Exn(exn::Inner::Err(e)))) if !self.in_catch => {
                self.in_catch = true;
                let node = run_node(*self.catch, (self.ctx.clone(), e.into_val()));
                Action::Replace(if self.paths { invalidate_paths(node) } else { node })
            },
            Input::Item(x) => Action::Yield(x),
            Input::End => Action::Done,
        }
    }
}

/// `label $l | f`: drop `break $l`, stopping afterwards.
struct LabelNode<'a, D: DataT> {
    child:   INode<'a, D>,
    label:   usize,
    started: bool,
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for LabelNode<'a, D> {
    fn last(&self, child_last: bool) -> bool { child_last }
    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        match input {
            Input::Start if !self.started => {
                self.started = true;
                Action::Descend(core::mem::replace(&mut self.child, Box::new(pull::Empty)))
            },
            Input::Start => Action::Continue,
            Input::Item(Err(Exn(exn::Inner::Break(b)))) if b == self.label => Action::Done,
            Input::Item(x) => Action::Yield(x),
            Input::End => Action::Done,
        }
    }
}

// ---- folds ----

type Eval<'a, D, T> = fn(Id, Cv<'a, D, T>) -> INode<'a, D>;

fn paths_from<'a, D: DataT>(it: ValPathXs<'a, D::V<'a>>) -> INode<'a, D> {
    Box::new(pull::FromIter::new(Box::new(it.map(|x| x.map(|(v, p)| Payload::ValPath(v, p))))))
}

fn invalidate_paths<'a, D: DataT>(child: INode<'a, D>) -> INode<'a, D> {
    n_map(child, |x| val::<D>(x).map(|v| Payload::ValPath(v, RcList::invalid())))
}

fn plain_cv<'a, D: DataT>(cv: &Cvp<'a, D>) -> Cv<'a, D> {
    (cv.0.clone(), cv.1.0.clone())
}

pub(crate) fn paths_node<'a, D: DataT>(id: Id, cv: Cvp<'a, D>) -> INode<'a, D> {
    pull::lazy(move || checked_build(cv, |cv| build_paths(id, cv)))
}

fn build_paths<'a, D: DataT>(id: Id, cv: Cvp<'a, D>) -> INode<'a, D> {
    match &cv.0.lut().terms[id.0] {
        Ast::Id => n_item(Ok(Payload::ValPath(cv.1.0, cv.1.1))),
        Ast::ToString if cv.1.0.clone().into_string() == cv.1.0 => n_item(Ok(Payload::ValPath(cv.1.0, cv.1.1))),
        Ast::Recurse if cv.1.1.is_invalid() => {
            let err = Error::path_iter(&cv.1.0);
            Box::new(pull::Concat::new([n_item(Ok(Payload::ValPath(cv.1.0, cv.1.1))), n_item(Err(err.into()))]))
        },
        Ast::Recurse => Box::new(RecursePaths { stack: Vec::new(), root: Some(cv.1) }),
        Ast::Pipe(l, None, r) => {
            let ctx = cv.0.clone();
            n_ok(paths_node(*l, cv), move |y| paths_node(*r, (ctx.clone(), path_value(y))))
        },
        Ast::Pipe(l, Some(pat), r) => n_ok(run_node(*l, plain_cv(&cv)), move |y| {
            let Payload::Val(y) = y else { unreachable!() };
            nbind_run(pat, r, cv.clone(), y, paths_node)
        }),
        Ast::PipeAlt(l, alts) => n_ok(run_node(*l, plain_cv(&cv)), move |y| {
            let Payload::Val(y) = y else { unreachable!() };
            Box::new(AltChain::new(alts, cv.clone(), y, paths_node))
        }),
        Ast::Comma(l, r) => Box::new(pull::Concat::new([paths_node(*l, cv.clone()), paths_node(*r, cv)])),
        Ast::Alt(l, r) => choose_alt(run_node(*l, plain_cv(&cv)), move |left| paths_node(if left { *l } else { *r }, cv)),
        Ast::Ite(pred, t, f) => n_ok(run_node(*pred, plain_cv(&cv)), move |x| {
            let Payload::Val(x) = x else { unreachable!() };
            paths_node(if x.as_bool() { *t } else { *f }, cv.clone())
        }),
        Ast::TryCatch(f, c) => Box::new(TryCatchNode {
            child: paths_node(*f, cv.clone()), ctx: cv.0, catch: c, started: false, in_catch: false, paths: true,
        }),
        Ast::Path(f, path) => {
            let input = plain_cv(&cv);
            path_access(paths_node(*f, cv), path, input)
        },
        Ast::Var(v) => match cv.0.vars.get(*v).unwrap().clone() {
            Bind::Fun((f, vars)) => paths_node(f, (cv.0.with_vars(vars), cv.1)),
            Bind::Label(l) => n_item(Err(Exn(exn::Inner::Break(l)))),
            Bind::Var(v) => n_item(Ok(Payload::ValPath(v, RcList::invalid()))),
        },
        Ast::Fold(xs, pat, init, update, fold) => fold_node(
            nrun_and_bind(xs, plain_cv(&cv), pat), paths_node(*init,cv), *update, fold, paths_node, path_value,
        ),
        Ast::CallDef(f, args, skip, call) => {
            let data = cv.0.data.clone();
            let labels = cv.0.labels;
            let ctx = cv.0.clone().skip_vars(*skip);
            let cvs = nbind_vars(args, ctx, (cv.0, exn::CallInput::Paths(cv.1)));
            Box::new(DefNode {
                cvs, id: f, all: matches!(call, CallType::CatchAll), throw: matches!(call, CallType::Throw),
                with_vars: Box::new(move |vars| Ctx { vars, data: data.clone(), labels }),
                body: |id, (ctx, v)| paths_node(id, (ctx, v.unwrap_paths())), phase: DefPhase::Init, suspended: 0, outer_last: false,
            })
        },
        Ast::Label(f) => {
            let ctx = cv.0.cons_label();
            let label = ctx.labels;
            Box::new(LabelNode { child: paths_node(*f, (ctx, cv.1)), label, started: false })
        },
        Ast::Native(id, args) if cv.0.lut().funs[*id].paths.is_some() => {
            let native = cv.0.lut().funs[*id].paths.unwrap();
            let cvs = nbind_vars(args, cv.0.with_vars(Vars::new([])), (cv.0, exn::CallInput::Paths(cv.1)));
            n_ok(cvs, move |x| {
                let Payload::Cv(ctx, v) = x else { unreachable!() };
                native((ctx, v.unwrap_paths()))
            })
        },
        _ => invalidate_paths(run_node(id, (cv.0, cv.1.0))),
    }
}

type KeyValues<V> = crate::box_iter::BoxIter<'static, ValR<(V, V), V>>;
struct RecursePaths<'a, D: DataT> {
    stack: Vec<(KeyValues<Value<'a, D>>, RcList<Value<'a, D>>)>,
    root: Option<Vp<'a, D>>,
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for RecursePaths<'a, D> {
    fn resume(&mut self, _: Input<Item<'a,D>>) -> Action<'a, Item<'a,D>> {
        let (v, p) = if let Some(root) = self.root.take() { root } else {
            loop {
                let Some((iter, p)) = self.stack.last_mut() else { return Action::Done };
                match iter.next() {
                    Some(Ok((k, v))) => break (v, p.clone().cons(k)),
                    Some(Err(_)) => {}, // `..` ignores non-iterable leaves.
                    None => { self.stack.pop(); },
                }
            }
        };
        self.stack.push((v.clone().key_values(), p.clone()));
        Action::Yield(Ok(Payload::ValPath(v, p)))
    }
}

// Test the left expression in value mode, then run the selected branch in
// path/update mode. An error counts as true, as in the old `.any` test.
fn choose_alt<'a,D: DataT>(probe: INode<'a,D>, choose: impl FnOnce(bool) -> INode<'a,D> + 'a) -> INode<'a,D> {
    struct Choose<'a, D: DataT, F> { probe: Option<INode<'a,D>>, choose: Option<F> }
    impl<'a, D: DataT, F: FnOnce(bool) -> INode<'a,D>> NodeT<'a,Item<'a,D>> for Choose<'a,D,F> {
        fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
            match input {
                Input::Start => self.probe.take().map_or(Action::Continue, Action::Descend),
                Input::Item(x) if self.choose.is_some() => {
                    if item_truthy(&x) { Action::Replace(self.choose.take().unwrap()(true)) } else { Action::Continue }
                },
                Input::Item(x) => Action::Yield(x),
                Input::End => self.choose.take().map_or(Action::Done, |f| Action::Descend(f(false))),
            }
        }
    }
    Box::new(Choose { probe: Some(probe), choose: Some(choose) })
}

fn copy_fold_item<'a,D: DataT>(x: &Item<'a,D>) -> Item<'a,D> {
    match x {
        Ok(Payload::Ctx(c)) => Ok(Payload::Ctx(c.clone())),
        Ok(Payload::Cv(c,v)) => Ok(Payload::Cv(c.clone(),v.clone())),
        Ok(Payload::Val(v)) => Ok(Payload::Val(v.clone())),
        Ok(Payload::Parts(p)) => Ok(Payload::Parts(p.clone())),
        Err(e) => Err(e.clone()),
        _ => unreachable!(),
    }
}

type Replay<'a,D> = pull::Replay<Item<'a,D>>;

fn replay_item<'a,D: DataT>(replay: Replay<'a,D>, index: usize, f: impl FnOnce(Option<Item<'a,D>>) -> INode<'a,D> + 'a) -> INode<'a,D> {
    struct Read<'a,D:DataT,F> { pending: Option<F>, replay: Replay<'a,D>, index: usize, started: bool }
    impl<'a,D:DataT,F: FnOnce(Option<Item<'a,D>>) -> INode<'a,D>> NodeT<'a,Item<'a,D>> for Read<'a,D,F> {
        fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
            let Some(_) = self.pending else {
                return match input { Input::Start => Action::Continue, Input::Item(x) => Action::Yield(x), Input::End => Action::Done };
            };
            match input {
                Input::Start if !self.started => { self.started = true; Action::Read(self.replay.clone(), self.index) },
                Input::Item(x) => Action::Descend(self.pending.take().unwrap()(Some(x))),
                Input::End => Action::Descend(self.pending.take().unwrap()(None)),
                Input::Start => unreachable!(),
            }
        }
    }
    Box::new(Read { pending: Some(f), replay, index, started: false })
}

type Step<'a,D> = Rc<dyn Fn(Payload<'a,D>, Payload<'a,D>) -> INode<'a,D> + 'a>;
type Project<'a,D> = Rc<dyn Fn(&Payload<'a,D>, Payload<'a,D>) -> INode<'a,D> + 'a>;

fn clone_acc<'a,D:DataT>(acc: &Payload<'a,D>) -> Payload<'a,D> {
    match acc {
        Payload::Val(v) => Payload::Val(v.clone()),
        Payload::ValPath(v,p) => Payload::ValPath(v.clone(),p.clone()),
        _ => unreachable!(),
    }
}

enum FoldMode {
    Start,
    Read,
    Step,
    DropStep,
    Project,
    AfterFinal,
}

// The input producer is shared across branches. Each update can suspend its
// remaining results while we walk just the current branch, without eagerly
// polling a second result or putting sequential iterations in logical depth.
struct FoldNode<'a,D:DataT> {
    xs: Replay<'a,D>,
    step: Step<'a,D>,
    project: Option<Project<'a,D>>,
    branches: Vec<(usize, Option<Payload<'a,D>>)>,
    pos: usize,
    acc: Option<Payload<'a,D>>,
    mode: FoldMode,
}

impl<'a,D:DataT> FoldNode<'a,D> {
    fn read(&mut self) -> Action<'a,Item<'a,D>> {
        self.mode = FoldMode::Read;
        Action::Read(self.xs.clone(),self.pos)
    }

    fn backtrack(&mut self) -> Action<'a,Item<'a,D>> {
        self.mode = FoldMode::Step;
        if self.branches.is_empty() { Action::Done } else { Action::Continue }
    }

    fn step_value(&mut self, pos: usize, ctx: Option<&Payload<'a,D>>, y: Payload<'a,D>) -> Action<'a,Item<'a,D>> {
        self.pos = pos + 1;
        if let Some(project) = &self.project {
            self.acc = Some(clone_acc(&y));
            self.mode = FoldMode::Project;
            Action::Descend(project(ctx.unwrap(),y))
        } else {
            self.acc = Some(y);
            self.read()
        }
    }
}

impl<'a,D:DataT> NodeT<'a,Item<'a,D>> for FoldNode<'a,D> {
    fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
        self.resume_item(input,false)
    }

    fn resume_item(&mut self, input: Input<Item<'a,D>>, last: bool) -> Action<'a,Item<'a,D>> {
        match self.mode {
            FoldMode::Start => self.read(),
            FoldMode::AfterFinal => self.backtrack(),
            FoldMode::Read => match input {
                Input::Item(Ok(x)) => {
                    let ctx = if self.project.is_some() {
                        Some(match &x { Payload::Ctx(c) => Payload::Ctx(c.clone()), _ => unreachable!() })
                    } else { None };
                    self.branches.push((self.pos,ctx));
                    self.mode = FoldMode::Step;
                    Action::Descend((self.step)(x,self.acc.take().unwrap()))
                },
                Input::Item(Err(e)) => {
                    self.acc = None;
                    self.mode = FoldMode::AfterFinal;
                    Action::Yield(Err(e))
                },
                Input::End => match self.acc.take() {
                    Some(acc) if self.project.is_none() => {
                        self.mode = FoldMode::AfterFinal;
                        Action::Yield(Ok(acc))
                    },
                    _ => self.backtrack(),
                },
                Input::Start => unreachable!(),
            },
            FoldMode::Step => match input {
                Input::Start => Action::Continue,
                Input::Item(Err(e)) => Action::Yield(Err(e)),
                Input::Item(Ok(y)) if last => {
                    self.acc = Some(y);
                    self.mode = FoldMode::DropStep;
                    Action::Discard
                },
                Input::Item(Ok(y)) => {
                    let (pos, ctx) = self.branches.last().unwrap();
                    let ctx = ctx.as_ref().map(|v| match v { Payload::Ctx(c) => Payload::Ctx(c.clone()), _ => unreachable!() });
                    let pos = *pos;
                    self.step_value(pos, ctx.as_ref(), y)
                },
                Input::End => {
                    self.branches.pop();
                    self.backtrack()
                },
            },
            FoldMode::DropStep => {
                let (pos,ctx) = self.branches.pop().unwrap();
                let acc = self.acc.take().unwrap();
                self.step_value(pos,ctx.as_ref(),acc)
            },
            FoldMode::Project => match input {
                Input::Start => Action::Continue,
                Input::Item(x) => Action::Yield(x),
                Input::End => self.read(),
            },
        }
    }
}

fn fold_step<'a,D:DataT>(xs: Replay<'a,D>, acc: Payload<'a,D>, step: Step<'a,D>, project: Option<Project<'a,D>>) -> INode<'a,D> {
    Box::new(FoldNode { xs, step, project, branches: Vec::new(), pos: 0, acc: Some(acc), mode: FoldMode::Start })
}

fn fold_node<'a,D:DataT,T:'a>(xs: INode<'a,D>, init: INode<'a,D>, update: Id, fold: &'a Fold<Id>, eval: Eval<'a,D,T>, take: fn(Payload<'a,D>) -> T) -> INode<'a,D> {
    let step: Step<'a,D> = Rc::new(move |x, acc| {
        let Payload::Ctx(ctx) = x else { unreachable!() };
        eval(update, (ctx, take(acc)))
    });
    let project: Option<Project<'a,D>> = match fold {
        Fold::Reduce => None,
        Fold::Foreach(None) => Some(Rc::new(|_, y| n_item(Ok(y)))),
        Fold::Foreach(Some(id)) => Some(Rc::new(move |x, y| {
            let Payload::Ctx(ctx) = x else { unreachable!() };
            eval(*id, (ctx.clone(), take(y)))
        })),
    };
    let cache = Replay::new(copy_fold_item::<D>);
    pull::with_replay(cache.clone(), xs, n_ok(init, move |init| fold_step(cache.clone(), init, step.clone(), project.clone())))
}

fn n_reduce<'a,D:DataT>(xs: INode<'a,D>, init: Value<'a,D>, f: impl Fn(Payload<'a,D>, Value<'a,D>) -> INode<'a,D> + 'a) -> INode<'a,D> {
    let cache = Replay::new(copy_fold_item::<D>);
    let step: Step<'a,D> = Rc::new(move |x, acc| {
        let Payload::Val(acc) = acc else { unreachable!() };
        f(x, acc)
    });
    pull::with_replay(cache.clone(), xs, fold_step(cache, Payload::Val(init), step, None))
}

// Take exactly one child output (including errors). Do not poll its tail.
pub(crate) fn first_then<'a,D:DataT>(child: INode<'a,D>, f: impl FnOnce(Option<Item<'a,D>>) -> INode<'a,D> + 'a) -> INode<'a,D> {
    struct First<'a,D:DataT,F> { child: Option<INode<'a,D>>, f: Option<F> }
    impl<'a,D:DataT,F:FnOnce(Option<Item<'a,D>>) -> INode<'a,D>> NodeT<'a,Item<'a,D>> for First<'a,D,F> {
        fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
            match input {
                Input::Start => self.child.take().map_or(Action::Continue, Action::Descend),
                Input::Item(x) => match self.f.take() { Some(f) => Action::Replace(f(Some(x))), None => Action::Yield(x) },
                Input::End => self.f.take().map_or(Action::Done, |f| Action::Descend(f(None))),
            }
        }
    }
    Box::new(First { child: Some(child), f: Some(f) })
}

pub(crate) fn valid_path<'a,D:DataT>(x: Payload<'a,D>) -> ValX<'a,Vp<'a,D>,Value<'a,D>> {
    let (v,p) = path_value(x);
    if p.is_invalid() { Err(Error::path_expr(v).into()) } else { Ok((v,p)) }
}

struct MapUpdate<'a,D:DataT> {
    cursor: Option<Box<dyn crate::val::ValueUpdate<Value<'a,D>>>>,
    update: Updater<'a,D>,
    got_item: bool,
}

impl<'a,D:DataT> NodeT<'a,Item<'a,D>> for MapUpdate<'a,D> {
    fn last(&self, _: bool) -> bool { true }
    fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
        let Some(cursor) = self.cursor.as_mut() else { return Action::Done };
        let result = match input {
            Input::Item(x) => {
                let result = val::<D>(x).and_then(|v| cursor.put(Some(v)).map_err(Exn::from));
                if result.is_ok() {
                    self.got_item = true;
                    return Action::Discard;
                }
                result
            },
            Input::End if !self.got_item => cursor.put(None).map_err(Exn::from),
            _ => Ok(()),
        };
        if let Err(e) = result {
            self.cursor = None;
            return Action::Yield(Err(e));
        }
        self.got_item = false;
        if let Some(v) = cursor.next() {
            Action::Descend(self.update.apply(v))
        } else {
            Action::Yield(Ok(Payload::Val(self.cursor.take().unwrap().finish())))
        }
    }
}

fn map_update<'a,D:DataT>(cursor: ValR<Box<dyn crate::val::ValueUpdate<Value<'a,D>>>, Value<'a,D>>, f: Updater<'a,D>) -> INode<'a,D> {
    match cursor {
        Ok(cursor) => Box::new(MapUpdate { cursor: Some(cursor), update: f, got_item: false }),
        Err(e) => n_item(Err(e.into())),
    }
}

fn concrete_update<'a,D:DataT>(parts: Rc<[(Part<Value<'a,D>>, Opt)]>, pos: usize, v: Value<'a,D>, f: Updater<'a,D>) -> INode<'a,D> {
    let Some((part,opt)) = parts.get(pos) else { return n_once(Ok(v)) };
    let c = match part {
        Part::Index(k) => v.update_index(k, *opt),
        Part::Range(None,None) => v.update_values(*opt),
        Part::Range(l,r) => v.update_range(l.as_ref()..r.as_ref(), *opt),
    };
    if pos + 1 == parts.len() { map_update(c, f) } else {
        map_update(c, f.wrap(move |child, f| concrete_update(parts.clone(), pos + 1, child, f.clone())))
    }
}

fn recurse_update_node<'a,D:DataT>(v: Value<'a,D>, f: Updater<'a,D>) -> INode<'a,D> {
    let recurse = f.clone().wrap(|v, f| recurse_update_node(v, f.clone()));
    n_ok(map_update(v.update_values(Opt::Optional), recurse), move |x| {
        let Payload::Val(v) = x else { unreachable!() };
        f.apply(v)
    })
}

fn update_by_paths_node<'a,D:DataT>(id: Id, cv: Cv<'a,D>, f: Updater<'a,D>) -> INode<'a,D> {
    struct CollectPaths<'a,D:DataT> { child: Option<INode<'a,D>>, paths: Vec<RcList<Value<'a,D>>>, root: Option<Value<'a,D>>, f: Updater<'a,D>, applying: bool }
    impl<'a,D:DataT> NodeT<'a,Item<'a,D>> for CollectPaths<'a,D> {
        fn resume(&mut self, input: Input<Item<'a,D>>) -> Action<'a,Item<'a,D>> {
            match input {
                Input::Start if self.root.is_none() && !self.applying => Action::Done,
                Input::Start => self.child.take().map_or(Action::Continue, Action::Descend),
                Input::Item(x) if self.applying => Action::Yield(x),
                Input::Item(x) => match x.and_then(valid_path::<D>) {
                    Ok((_,p)) => { self.paths.push(p); Action::Continue },
                    Err(e) => { self.root = None; Action::Yield(Err(e)) },
                },
                Input::End if self.applying => Action::Done,
                Input::End => {
                    let paths = core::mem::take(&mut self.paths);
                    let iter = paths.into_iter().map(|p| {
                        let mut parts: Vec<_> = p.iter().map(|k| (Part::Index(k.clone()), Opt::Essential)).collect();
                        parts.reverse();
                        Ok(Payload::Parts(parts))
                    });
                    let f = self.f.clone();
                    self.applying = true;
                    Action::Descend(n_reduce(Box::new(pull::FromIter::new(Box::new(iter))), self.root.take().unwrap(), move |p, v| {
                        let Payload::Parts(parts) = p else { unreachable!() };
                        if parts.is_empty() { first_then(f.apply(v), |x| n_item(x.unwrap_or_else(|| Ok(Payload::Val(D::V::null()))))) }
                        else { concrete_update(parts.into(), 0, v, f.clone()) }
                    }))
                },
            }
        }
    }
    Box::new(CollectPaths { child: Some(paths_node(id, (cv.0, (cv.1.clone(), RcList::new())))), paths: Vec::new(), root: Some(cv.1), f, applying: false })
}

fn update_fold_step<'a,D:DataT>(xs: Replay<'a,D>, pos: usize, value: Value<'a,D>, path: Id, fold: &'a Fold<Id>, f: Updater<'a,D>) -> INode<'a,D> {
    replay_item(xs.clone(), pos, move |x| match x {
        None if matches!(fold,Fold::Reduce) => f.apply(value),
        None => n_once(Ok(value)),
        Some(Err(e)) => n_item(Err(e)),
        Some(Ok(Payload::Ctx(ctx))) => {
            let project_ctx = ctx.clone();
            let update = f.wrap(move |value, f| {
                let (xs, f) = (xs.clone(),f.clone());
                match fold {
                    Fold::Reduce => update_fold_step(xs,pos+1,value,path,fold,f),
                    Fold::Foreach(None) => n_ok(f.apply(value), move |v| {
                        let Payload::Val(v) = v else { unreachable!() };
                        update_fold_step(xs.clone(),pos+1,v,path,fold,f.clone())
                    }),
                    Fold::Foreach(Some(proj)) => n_ok(update_node(*proj,(project_ctx.clone(),value),f.clone()), move |v| {
                        let Payload::Val(v) = v else { unreachable!() };
                        update_fold_step(xs.clone(),pos+1,v,path,fold,f.clone())
                    }),
                }
            });
            update_node(path, (ctx,value), update)
        },
        Some(Ok(_)) => unreachable!(),
    })
}

pub(crate) fn update_node<'a,D:DataT>(id: Id, cv: Cv<'a,D>, f: Updater<'a,D>) -> INode<'a,D> {
    pull::lazy(move || checked_build(cv, |cv| build_update(id, cv, f)))
}

fn build_update<'a,D:DataT>(id: Id, cv: Cv<'a,D>, f: Updater<'a,D>) -> INode<'a,D> {
    match &cv.0.lut().terms[id.0] {
        Ast::Id => f.apply(cv.1),
        Ast::Recurse => recurse_update_node(cv.1, f),
        Ast::Path(base,path) => {
            let input = cv.clone();
            let diagnostic = cv.clone();
            let callback = f.wrap(move |v, f| {
                let f = f.clone();
                let parts = path_parts(&path.0,input.clone(),RcList::new());
                // Values in each concrete path are updated in product order.
                n_map(n_reduce(parts,v,move |x,v| {
                    let Payload::Parts(parts) = x else { unreachable!() };
                    concrete_update(parts.into(),0,v,f.clone())
                }), |x| x.map_err(seal))
            });
            n_flat(update_node(*base,cv,callback), move |x| {
                let Err(Exn(exn::Inner::Err(e))) = x else { return n_item(x) };
                if e.not_path().is_none() { return n_item(Err(Exn(exn::Inner::Err(e)))) }
                first_then(path_parts(&path.0, diagnostic.clone(),RcList::new()), move |part| {
                    let err = match part {
                        Some(Ok(Payload::Parts(p))) if !p.is_empty() => p[0].0.not_at_path(e.not_path().unwrap()).into(),
                        Some(Err(e)) => e,
                        _ => Exn(exn::Inner::Err(e)),
                    };
                    n_item(Err(err))
                })
            })
        },
        Ast::Pipe(l,None,r) => {
            let ctx = cv.0.clone();
            update_node(*l,cv,f.wrap(move |v, f| update_node(*r,(ctx.clone(),v),f.clone())))
        },
        Ast::Pipe(l,Some(pat),r) => n_reduce(nrun_and_bind(l, (cv.0,cv.1.clone()),pat),cv.1,move |x,v| {
            let Payload::Ctx(ctx) = x else { unreachable!() };
            update_node(*r,(ctx,v),f.clone())
        }),
        Ast::Comma(l,r) => {
            let ctx = cv.0.clone();
            n_ok(update_node(*l,cv,f.clone()), move |x| {
                let Payload::Val(v) = x else { unreachable!() };
                update_node(*r,(ctx.clone(),v),f.clone())
            })
        },
        Ast::Ite(pred,t,e) => n_reduce(run_node(*pred,cv.clone()),cv.1, move |x,v| {
            let Payload::Val(x) = x else { unreachable!() };
            update_node(if x.as_bool() { *t } else { *e },(cv.0.clone(),v),f.clone())
        }),
        Ast::Alt(l,r) => choose_alt(run_node(*l,cv.clone()),move |left| update_node(if left { *l } else { *r },cv,f)),
        Ast::Fold(xs,pat,init,path,fold) => {
            let cache = Replay::new(copy_fold_item::<D>);
            let body = update_node(*init,cv.clone(),f.wrap({
                let cache = cache.clone();
                move |v, f| update_fold_step(cache.clone(),0,v,*path,fold,f.clone())
            }));
            pull::with_replay(cache,nrun_and_bind(xs,cv,pat),body)
        },
        Ast::Var(v) => match cv.0.vars.get(*v).unwrap().clone() {
            Bind::Fun((i,vars)) => update_node(i,(cv.0.with_vars(vars),cv.1),f),
            Bind::Label(l) => n_item(Err(Exn(exn::Inner::Break(l)))),
            Bind::Var(v) => n_item(Err(Error::path_expr(v).into())),
        },
        Ast::CallDef(id,args,skip,_) => {
            let acc = cv.1.clone();
            let xs = nbind_vars(args,cv.0.clone().skip_vars(*skip),(cv.0,exn::CallInput::Run(cv.1)));
            n_reduce(xs,acc,move |x,v| {
                let Payload::Cv(ctx,_) = x else { unreachable!() };
                update_node(*id,(ctx,v),f.clone())
            })
        },
        Ast::Native(id,args) if cv.0.lut().funs[*id].update.is_some() => {
            let native = cv.0.lut().funs[*id].update.unwrap();
            let acc = cv.1.clone();
            let xs = nbind_vars(args,cv.0.with_vars(Vars::new([])),(cv.0,exn::CallInput::Run(cv.1)));
            n_reduce(xs,acc,move |x,v| {
                let Payload::Cv(ctx,_) = x else { unreachable!() };
                native((ctx,v),f.clone())
            })
        },
        Ast::Native(..) | Ast::Label(..) | Ast::TryCatch(..) | Ast::PipeAlt(..) => update_by_paths_node(id,cv,f),
        _ => {
            let original = cv.1.clone();
            first_then(run_node(id,cv),move |x| n_once(match x {
                None => Ok(original),
                Some(x) => val::<D>(x).and_then(|v| Err(Error::path_expr(v).into())),
            }))
        },
    }
}

enum ModPhase {
    Paths,
    InUpdate,
    Done,
}

/// `v | p |= f`, evaluating both `paths` and `f` on the shared driver so
/// recursive updates do not stack. Mirrors the old `Id::modify`.
struct ModifyNode<'a, D: DataT> {
    paths:   Option<INode<'a, D>>,
    update:  Id,
    ctx:     Ctx<'a, D>,
    acc:     Option<D::V<'a>>,
    deleted: Vec<D::V<'a>>,
    cur:     Option<D::V<'a>>,
    phase:   ModPhase,
}

impl<'a, D: DataT> ModifyNode<'a, D> {
    fn finish(&mut self) -> Action<'a, Item<'a, D>> {
        self.phase = ModPhase::Done;
        let acc = self.acc.take().unwrap();
        if self.deleted.is_empty() {
            return Action::Yield(Ok(Payload::Val(acc)));
        }
        let deleted = core::mem::take(&mut self.deleted);
        let deleted: D::V<'a> = deleted.into_iter().collect();
        Action::Yield(acc.delpaths(&deleted).map(Payload::Val).map_err(Exn::from))
    }
}

impl<'a, D: DataT> NodeT<'a, Item<'a, D>> for ModifyNode<'a, D> {
    fn last(&self, _: bool) -> bool { true }
    fn resume(&mut self, input: Input<Item<'a, D>>) -> Action<'a, Item<'a, D>> {
        match self.phase {
            ModPhase::Done => Action::Done,
            ModPhase::Paths => match input {
                Input::Start => self.paths.take().map_or(Action::Continue, Action::Descend),
                Input::Item(Ok(Payload::ValPath(y, p))) => {
                    if p.is_invalid() {
                        self.phase = ModPhase::Done;
                        return Action::Yield(Err(Exn::from(Error::path_expr(y))));
                    }
                    let mut keys: Vec<_> = p.iter().cloned().collect();
                    keys.reverse();
                    let p: D::V<'a> = keys.into_iter().collect();
                    let val = match self.acc.as_ref().unwrap().clone().getpath(&p) {
                        Ok(v) => v,
                        Err(e) => {
                            self.phase = ModPhase::Done;
                            return Action::Yield(Err(Exn::from(e)));
                        },
                    };
                    self.cur = Some(p);
                    self.phase = ModPhase::InUpdate;
                    Action::Descend(run_node(self.update, (self.ctx.clone(), val)))
                },
                Input::Item(Err(e)) => {
                    self.phase = ModPhase::Done;
                    Action::Yield(Err(e))
                },
                Input::Item(Ok(_)) => unreachable!(),
                Input::End => self.finish(),
            },
            ModPhase::InUpdate => match input {
                Input::Start => Action::Continue,
                Input::Item(Ok(Payload::Val(y))) => {
                    let p = self.cur.take().unwrap();
                    match self.acc.take().unwrap().setpath(&p, y) {
                        Ok(acc) => self.acc = Some(acc),
                        Err(e) => {
                            self.phase = ModPhase::Done;
                            return Action::Yield(Err(Exn::from(e)));
                        },
                    }
                    Action::Discard
                },
                Input::Item(Err(e)) => {
                    self.phase = ModPhase::Done;
                    Action::Yield(Err(e))
                },
                Input::Item(Ok(_)) => unreachable!(),
                Input::End => {
                    if let Some(path) = self.cur.take() {
                        self.deleted.push(path);
                    }
                    self.phase = ModPhase::Paths;
                    Action::Continue
                },
            },
        }
    }
}

/// A filter which is implemented using function pointers.
pub struct Native<D: DataT + ?Sized> {
    run: NativeRun<D>,
    paths: Option<PathsPtr<D>>,
    update: Option<UpdatePtr<D>>,
}

enum NativeRun<D: DataT + ?Sized> {
    Leaf(RunPtr<D>),
    Eval(RunNodePtr<D>),
}

/// Native leaf function pointer. A leaf does not evaluate filter arguments.
pub type RunPtr<D> = for<'a> fn(Cv<'a, D>) -> ValXs<'a, <D as DataT>::V<'a>>;
/// Native function pointer returning a resumable filter.
pub type RunNodePtr<D> = for<'a> fn(Cv<'a, D>) -> INode<'a,D>;
/// Native function pointer for paths (`path(...)`).
pub type PathsPtr<D> = for<'a> fn(Cvp<'a, D>) -> INode<'a,D>;
/// Native function pointer for an update expression.
pub type UpdatePtr<D> = for<'a> fn(Cv<'a, D>, Updater<'a,D>) -> INode<'a,D>;

impl<D: DataT> Native<D> {
    /// Create a native leaf that does not call user filters.
    pub const fn new(run: RunPtr<D>) -> Self {
        Self { run: NativeRun::Leaf(run), paths: None, update: None }
    }

    /// Create a native filter that can evaluate user filters on the shared driver.
    pub const fn resumable(run: RunNodePtr<D>) -> Self {
        Self { run: NativeRun::Eval(run), paths: None, update: None }
    }

    /// Specify a paths function (used for `path(...)`).
    pub const fn with_paths(self, paths: PathsPtr<D>) -> Self {
        Self { paths: Some(paths), ..self }
    }

    /// Specify an update function for direct assignments to this filter.
    pub const fn with_update(self, update: UpdatePtr<D>) -> Self {
        Self { update: Some(update), ..self }
    }
}

impl Id {
    /// Start a new evaluation of `v | f` in the context `c`.
    /// Resumable native filters should use [`crate::native::eval`] instead.
    pub fn run<'a, D: DataT>(&self, cv: Cv<'a, D>) -> ValXs<'a, D::V<'a>> {
        Box::new(pull::pull(run_node(*self, cv), deep::<D>, MAX_DEPTH).map(val::<D>))
    }

    /// Return each output and its path relative to the supplied input path.
    pub fn paths<'a, D: DataT>(&self, cv: Cvp<'a, D>) -> ValPathXs<'a, D::V<'a>> {
        Box::new(pull::pull(paths_node(*self, cv), deep::<D>, MAX_DEPTH).map(|x| x.and_then(valid_path)))
    }

    /// Start an update evaluation with a resumable replacement filter.
    pub fn update<'a, D: DataT>(&self, cv: Cv<'a, D>, f: Updater<'a,D>) -> ValXs<'a, D::V<'a>> {
        Box::new(pull::pull(update_node(*self, cv, f), deep::<D>, MAX_DEPTH).map(val::<D>))
    }
}

/// Fix the message of an error that a path expression nested in another one raised.
fn seal<V: From<alloc::string::String> + core::fmt::Display>(e: Exn<'_, V>) -> Exn<'_, V> {
    match e.0 {
        exn::Inner::Err(err) => Exn::from((*err).seal()),
        e => Exn(e),
    }
}
