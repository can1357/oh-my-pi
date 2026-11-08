//! Program compilation.

use crate::load::{self, lex, parse};
use crate::{ops, Bind as Arg};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::{boxed::Box, string::String, vec::Vec};

type NativeId = usize;
type ModId = usize;
type VarId = usize;
type VarSkip = usize;
type Arity = usize;

/// Function from a value to a stream of value results.
#[derive(Debug, Clone)]
pub struct Filter<F> {
    /// Program graph, implemented as lookup table
    pub lut: Lut<F>,
    /// Entry point into the program graph
    pub id: TermId,
}

/// Index of a term in the look-up table.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TermId(pub(crate) usize);

/// Look-up table for terms and functions.
#[derive(Clone, Debug)]
pub struct Lut<F> {
    /// `terms[tid]` yields the term corresponding to the term ID `tid`
    pub(crate) terms: Vec<Term>,
    pub(crate) funs: Vec<F>,
}

impl<F> Default for Filter<F> {
    fn default() -> Self {
        Self {
            id: TermId(0),
            lut: Lut::new([Term::Id].into()),
        }
    }
}

impl<F> Lut<F> {
    fn new(terms: Vec<Term>) -> Self {
        let funs = Vec::new();
        Self { terms, funs }
    }

    fn map_funs<F2>(self, f: impl Fn(F) -> F2) -> Lut<F2> {
        Lut {
            funs: self.funs.into_iter().map(f).collect(),
            terms: self.terms,
        }
    }

    fn insert_term(&mut self, t: Term) -> TermId {
        let tid = self.terms.len();
        self.terms.push(t);
        TermId(tid)
    }
}

/// How to call a filter implemented by definition.
///
/// This is important to achieve tail-call optimisation (TCO).
/// In particular, a *tail call* is any call to an ancestor from
/// a position where the output is returned as-is by the ancestor.
///
/// See
/// [`Compiler::term`] for a list of filters that return outputs of sub-filters as-is, and
/// [`Locals::call`] for how the [`CallType`] is determined.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum CallType {
    /// Run filter and return its outputs as-is
    Inline,
    /// Return exception that encodes filter ID, arguments and input (tail call)
    Throw,
    /// Run filter and expand thrown exceptions that match the filter ID
    CatchOne,
    /// Run filter and expand thrown exceptions
    CatchAll,
}

#[derive(Clone, Debug, Default)]
pub(crate) enum Term<T = TermId> {
    #[default]
    /// Identity (`.`)
    Id,
    /// Recursion (`..`)
    Recurse,
    ToString,

    Int(isize),
    Num(String),
    Str(String),
    /// Array construction (`[f]`)
    Arr(T),
    /// Empty object (`{}`)
    ObjEmpty,
    /// Singleton object (`{f: g}`)
    ObjSingle(T, T),

    /// Bound variable (`$x`), label (`label $x`), or filter argument (`a`)
    Var(VarId),

    /// Call to a filter (`filter`, `filter(…)`)
    CallDef(TermId, Box<[Arg<T>]>, VarSkip, CallType),

    Native(NativeId, Box<[Arg<T>]>),

    /// Binding of a break label (`label $x | f`)
    Label(T),
    /// Negation operation (`-f`)
    Neg(T),
    /// Variable binding (`f as $x | g`) if identifier (`x`) is given, otherwise
    /// application (`f | g`)
    Pipe(T, Option<Pattern<T>>, T),
    /// Concatenation (`f, g`)
    Comma(T, T),
    /// Assignment (`f = g`)
    Assign(T, T),
    /// Update-assignment (`f |= g`)
    Update(T, T),
    /// Arithmetical update-assignment (`f += g`, `f -= g`, `f *= g`, `f /= g`, `f %= g`)
    UpdateMath(T, ops::Math, T),
    /// Alternation update-assignment (`f //= g`)
    UpdateAlt(T, T),
    /// Logical operation (`f and g`, `f or g`)
    Logic(T, bool, T),
    /// Arithmetical operation (`f + g`, `f - g`, `f * g`, `f / g`, `f % g`)
    Math(T, ops::Math, T),
    /// Comparison operation (`f < g`, `f <= g`, `f > g`, `f >= g`, `f == g`, `f != g`)
    Cmp(T, ops::Cmp, T),
    /// Alternation (`f // g`)
    Alt(T, T),
    /// Try-catch (`try f catch g`)
    TryCatch(T, T),
    /// If-then-else (`if f then g else h end`)
    Ite(T, T, T),
    /// `reduce` and `foreach`
    ///
    ///  Assuming that `xs` evaluates to `x0`, `x1`, ..., `xn`,
    /// `reduce xs as $x (init; f)` evaluates to
    ///
    /// ~~~ text
    /// init
    /// | x0 as $x | f
    /// | ...
    /// | xn as $x | f
    /// ~~~
    ///
    /// and `foreach xs as $x (init; f; project)` evaluates to
    ///
    /// ~~~ text
    /// init |
    /// x0 as $x | f | project,
    /// ...
    /// xn as $x | f | project,
    /// empty
    /// ~~~
    Fold(T, Pattern<T>, T, T, Fold<T>),
    Path(T, crate::path::Path<T>),
}

#[derive(Clone, Debug)]
pub(crate) enum Fold<T> {
    Reduce,
    Foreach(Option<T>),
}

#[derive(Clone, Debug)]
pub(crate) enum Pattern<F> {
    Var,
    Idx(Vec<(F, Self)>),
}

/// Compilation error.
pub type Error<S> = (S, Undefined);

/// Compilation errors.
pub type Errors<S, P> = load::Errors<S, P, Vec<Error<S>>>;

/// Type of an undefined symbol.
#[derive(Debug)]
#[non_exhaustive]
pub enum Undefined {
    /// module
    Mod,
    /// variable
    Var,
    /// label variable
    Label,
    /// filter with arity
    Filter(Arity),
}

impl Undefined {
    /// String representation of an unexpected symbol type.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Var => "variable",
            Self::Mod => "module",
            Self::Label => "label",
            Self::Filter(_arity) => "filter",
        }
    }
}

/// jq program compiler.
///
/// This contains strings of type `S` and native functions of type `F`.
pub struct Compiler<S, F> {
    lut: Lut<(Sig<S>, F)>,

    /// `mod_map[mid]` yields all top-level definitions contained inside a module with ID `mid`
    mod_map: Vec<Vec<Def<S>>>,

    imported_mods: Vec<(ModId, S)>,
    included_mods: Vec<ModId>,

    global_vars: Vec<S>,
    imported_vars: Vec<(S, ModId)>,

    locals: Locals<S>,

    errs: Vec<Error<S>>,
}

type Def<S> = (Sig<S>, TermId, Tr);

impl<S, F> Default for Compiler<S, F> {
    fn default() -> Self {
        Self {
            lut: Lut {
                terms: Vec::new(),
                funs: Vec::new(),
            },
            mod_map: Vec::new(),
            imported_mods: Vec::new(),
            included_mods: Vec::new(),
            global_vars: Vec::new(),
            imported_vars: Vec::new(),
            locals: Locals::default(),
            errs: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct Sig<S, A = Arg> {
    name: S,
    // TODO: we could analyse for each argument whether it is TR, and
    // use this when converting args at callsite
    args: Box<[A]>,
}

fn bind_from<T>(s: &str, x: T) -> Arg<T> {
    if s.starts_with('$') {
        Arg::Var(x)
    } else {
        Arg::Fun(x)
    }
}

fn binds<T, U: Copy>(binds: &[Arg<T>], args: &[U]) -> Box<[Arg<U>]> {
    assert!(binds.len() == args.len());
    let args = binds.iter().zip(args);
    args.map(|(bind, id)| bind.as_ref().map(|_| *id)).collect()
}

impl<S: Eq, A> Sig<S, A> {
    fn matches(&self, name: S, args: &[TermId]) -> bool {
        name == self.name && args.len() == self.args.len()
    }
}

/// Store a map of vectors plus the sum of the lengths of all vectors.
struct MapVecLen<S> {
    bound: MapVec<S, usize>,
    total: usize,
}

impl<S> Default for MapVecLen<S> {
    fn default() -> Self {
        Self {
            bound: MapVec::default(),
            total: 0,
        }
    }
}

impl<S: Ord> MapVecLen<S> {
    fn push(&mut self, name: S) {
        self.total += 1;
        self.bound.push(name, self.total)
    }

    fn pop(&mut self, name: &S) {
        assert_eq!(self.bound.pop(name), Some(self.total));
        self.total -= 1;
    }

    fn is_empty(&self) -> bool {
        self.bound.is_empty() && self.total == 0
    }
}

enum Fun<S> {
    Arg,
    Parent(Box<[Arg<S>]>, TermId),
    /// Tr stores which tail-recursive calls the sibling can return
    Sibling(Box<[Arg<S>]>, TermId, Tr),
}

/// Single binding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Bind<V, L = V, F = V> {
    /// binding to a variable
    Var(V),
    /// binding to a break label
    Label(L),
    /// binding to a filter
    Fun(F),
}

struct Locals<S> {
    // usize = number of vars
    funs: MapVec<(S, Arity), (Fun<S>, usize)>,
    vars: MapVecLen<Bind<S>>,
}

impl<S> Default for Locals<S> {
    fn default() -> Self {
        Self {
            funs: MapVec::default(),
            vars: MapVecLen::default(),
        }
    }
}

/// Mapping from `K` to sequence of `V`.
struct MapVec<K, V>(BTreeMap<K, Vec<V>>);

impl<K, V> Default for MapVec<K, V> {
    fn default() -> Self {
        Self(BTreeMap::new())
    }
}

impl<K: Ord, V> MapVec<K, V> {
    fn push(&mut self, k: K, v: V) {
        self.0.entry(k).or_default().push(v)
    }

    fn pop(&mut self, k: &K) -> Option<V> {
        let vs = self.0.get_mut(k)?;
        let v = vs.pop()?;
        if vs.is_empty() {
            self.0.remove(k);
        }
        Some(v)
    }

    fn get_last(&self, k: &K) -> Option<&V> {
        self.0.get(k)?.last()
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<S: Copy + Ord> Locals<S> {
    fn push_sibling(&mut self, name: S, args: Box<[Arg<S>]>, id: TermId, tr: Tr) {
        self.funs.push(
            (name, args.len()),
            (Fun::Sibling(args, id, tr), self.vars.total),
        );
    }

    fn pop_sibling(&mut self, name: S, arity: Arity) -> (Box<[Arg<S>]>, TermId, Tr) {
        let (y, vars) = match self.funs.pop(&(name, arity)) {
            Some((Fun::Sibling(args, id, tr), vars)) => ((args, id, tr), vars),
            _ => panic!(),
        };
        assert_eq!(self.vars.total, vars);
        y
    }

    fn push_parent(&mut self, name: S, args: Box<[Arg<S>]>, id: TermId) {
        let vars = self.vars.total;

        for arg in args.iter() {
            match arg {
                Arg::Var(v) => self.vars.push(Bind::Var(*v)),
                Arg::Fun(f) => self.push_arg(*f),
            }
        }

        self.funs
            .push((name, args.len()), (Fun::Parent(args, id), vars));
    }

    fn pop_parent(&mut self, name: S, arity: Arity) -> TermId {
        let (args, id, vars) = match self.funs.pop(&(name, arity)) {
            Some((Fun::Parent(args, def), vars)) => (args, def, vars),
            _ => panic!(),
        };
        for arg in args.iter().rev() {
            match arg {
                Arg::Var(v) => self.vars.pop(&Bind::Var(*v)),
                Arg::Fun(f) => self.pop_arg(*f),
            }
        }
        assert_eq!(self.vars.total, vars);
        id
    }

    fn push_arg(&mut self, name: S) {
        self.vars.push(Bind::Fun(name));
        self.funs.push((name, 0), (Fun::Arg, self.vars.total));
    }

    fn pop_arg(&mut self, name: S) {
        let vars = match self.funs.pop(&(name, 0)) {
            Some((Fun::Arg, vars)) => vars,
            _ => panic!(),
        };
        assert_eq!(self.vars.total, vars);
        self.vars.pop(&Bind::Fun(name));
    }

    /// Call `f(f_1; ...; f_n)`, allowing tail-recursive calls to `tr`.
    fn call(&self, name: S, args: &[TermId], tr: &Tr) -> Option<(Term, Tr)> {
        Some(match self.funs.get_last(&(name, args.len()))? {
            (Fun::Arg, vars) => (Term::Var(self.vars.total - *vars), Tr::new()),
            // we   may only return tail-recursive calls to `tr` and call a sibling
            // that may only return tail-recursive calls to `tr_`
            (Fun::Sibling(args_, id, tr_), vars) => {
                let mut tr_ = tr_.clone();
                // does the sibling return tail-recursive calls to itself?
                let rec = tr_.remove(id);
                // are all remaining tail-recursive calls from the sibling permitted?
                let typ = if tr_.is_subset(tr) {
                    if rec {
                        CallType::CatchOne
                    } else {
                        CallType::Inline
                    }
                } else {
                    tr_ = Tr::new();
                    CallType::CatchAll
                };
                let vars = self.vars.total - *vars;
                (Term::CallDef(*id, binds(args_, args), vars, typ), tr_)
            }
            (Fun::Parent(args_, id), vars) => {
                // if we can return a tail-recursive call to the parent
                let (typ, tr_) = if tr.contains(id) {
                    (CallType::Throw, Tr::from([*id]))
                } else {
                    (CallType::CatchAll, Tr::new())
                };
                let vars = self.vars.total - *vars;
                (Term::CallDef(*id, binds(args_, args), vars, typ), tr_)
            }
        })
    }

    fn is_empty(&self) -> bool {
        self.funs.is_empty() && self.vars.is_empty()
    }
}

// any ID in Tr is an ID of a function f, and
// any call to some `f` in Tr from the current position is *not* tail-recursive
type Tr = BTreeSet<TermId>;

impl<'s, F> Compiler<&'s str, F> {
    /// Supply functions with given signatures.
    pub fn with_funs(mut self, funs: impl IntoIterator<Item = (&'s str, Box<[Arg]>, F)>) -> Self {
        self.lut.funs = funs
            .into_iter()
            .map(|(name, args, f)| (Sig { name, args }, f))
            .collect();
        self
    }

    /// Assume the existence of global variables with given names.
    ///
    /// The names all have to start with `$`.
    /// For execution, the corresponding values have to be provided via [`crate::Ctx::new`].
    pub fn with_global_vars(self, global_vars: impl IntoIterator<Item = &'s str>) -> Self {
        Self {
            global_vars: global_vars.into_iter().collect(),
            ..self
        }
    }

    /// Compile the given modules.
    pub fn compile<P>(
        mut self,
        mods: load::Modules<&'s str, P>,
    ) -> Result<Filter<F>, Errors<&'s str, P>> {
        self.imported_vars = mods
            .file_vars()
            .enumerate()
            .flat_map(|(mid, (_file, vars))| vars.iter().map(move |(_path, x, _meta)| (*x, mid)))
            .collect();

        let mut errs = Vec::new();
        for (file, module) in mods.deps {
            let defs = self.open_module(module);
            let defs = self.module(defs);
            self.mod_map.push(defs);
            self.close_module(file, &mut errs)
        }
        let (file, module) = mods.main;
        let main = self.open_module(module);
        let id = self.iterm(main);
        self.close_module(file, &mut errs);

        /*
        for (i, t) in self.lut.terms.iter().enumerate() {
            std::println!("{i} -> {t:?}");
        }
        */

        let lut = self.lut.map_funs(|(_sig, f)| f);
        errs.is_empty().then(|| Filter { id, lut }).ok_or(errs)
    }

    fn with_label<T>(&mut self, label: &'s str, f: impl FnOnce(&mut Self) -> T) -> T {
        self.locals.vars.push(Bind::Label(label));
        let y = f(self);
        self.locals.vars.pop(&Bind::Label(label));
        y
    }

    fn with_vars<T>(&mut self, vars: &[&'s str], f: impl FnOnce(&mut Self) -> T) -> T {
        vars.iter()
            .for_each(|v| self.locals.vars.push(Bind::Var(v)));
        let y = f(self);
        vars.iter()
            .rev()
            .for_each(|v| self.locals.vars.pop(&Bind::Var(v)));
        y
    }

    fn open_module<B>(&mut self, m: load::Module<&'s str, B>) -> B {
        self.imported_mods.clear();
        self.included_mods.clear();
        for (mid, as_) in m.mods {
            match as_ {
                None => self.included_mods.push(mid),
                Some(as_) => self.imported_mods.push((mid, as_)),
            }
        }
        m.body
    }

    fn close_module<P>(&mut self, file: load::File<&'s str, P>, errs: &mut Errors<&'s str, P>) {
        if !self.errs.is_empty() {
            errs.push((file, core::mem::take(&mut self.errs)));
        }
        assert!(self.locals.is_empty());
    }

    fn open_def(&mut self, def: parse::Def<&'s str>, tr: &Tr) -> (&'s str, usize) {
        let args: Box<[_]> = def.args.iter().map(|a| bind_from(a, *a)).collect();
        let arity = args.len();
        let (sig, def, tr_) = self.def(def, tr);
        self.locals.push_sibling(sig.name, args, def, tr_);
        (sig.name, arity)
    }

    fn close_def(&mut self, (name, arity): (&'s str, usize)) -> Def<&'s str> {
        let (args, id, tr) = self.locals.pop_sibling(name, arity);
        let args = args.into_vec().into_iter().map(|a| a.map(|_| ())).collect();
        (Sig { name, args }, id, tr)
    }

    fn module(&mut self, defs: Vec<parse::Def<&'s str>>) -> Vec<Def<&'s str>> {
        let siblings = defs.into_iter().map(|def| self.open_def(def, &Tr::new()));
        let siblings: Vec<_> = siblings.collect();

        let defs = siblings.into_iter().rev().map(|sig| self.close_def(sig));
        let mut defs: Vec<_> = defs.collect();

        defs.reverse();
        defs
    }

    /// Compile a definition LHS.
    fn def(&mut self, d: parse::Def<&'s str>, tr: &Tr) -> (Sig<&'s str>, TermId, Tr) {
        // insert placeholder
        let id = self.lut.insert_term(Term::default());
        let args = d.args.iter().map(|a| bind_from(a, *a)).collect();

        self.locals.push_parent(d.name, args, id);
        let mut tr = tr.clone();
        // any function can call itself tail-recursively
        assert!(tr.insert(id));
        let (body, tr_) = self.term(d.body, &tr);
        self.lut.terms[id.0] = body;
        assert_eq!(self.locals.pop_parent(d.name, d.args.len()), id);
        let sig = Sig {
            name: d.name,
            args: d.args.iter().map(|a| bind_from(a, ())).collect(),
        };
        (sig, id, tr_)
    }

    /// Compile a term that may call any function in `tr` tail-recursively.
    ///
    /// Returns which of the functions in `tr` it actually calls tail-recursively.
    /// The output `Tr` must be a subset of the input `Tr`.
    ///
    /// The following filters return the outputs of the filters `F` or `G` as-is:
    ///
    /// - `F, G`
    /// - `f // G`
    /// - `f as ... | G`
    /// - `f        | G`
    /// - `if p then F else G end`
    /// - `foreach fx as ... (init; f; G)`
    /// - `def x: f; G`
    ///
    /// All other filters do not return outputs of sub-filters as-is.
    fn term(&mut self, t: parse::Term<&'s str>, tr: &Tr) -> (Term, Tr) {
        use parse::Term::*;
        let t = match t {
            Id => Term::Id,
            Recurse => Term::Recurse,
            Arr(t) => Term::Arr(self.iterm(t.map_or_else(|| Call("!empty", Vec::new()), |t| *t))),
            Neg(t) => Term::Neg(self.iterm(*t)),
            Label(x, t) => Term::Label(self.with_label(x, |c| c.iterm(*t))),
            Break(x) => self.break_(x),
            IfThenElse(if_thens, else_) => {
                let f = |(if_, then_)| (self.iterm(if_), self.iterm_tr(then_, tr));
                let if_thens: Vec<_> = if_thens.into_iter().map(f).collect();
                let else_ = else_.map_or((Term::Id, Tr::new()), |else_| self.term(*else_, tr));
                return if_thens.into_iter().rev().fold(else_, |acc, (if_, then_)| {
                    let else_ = self.lut.insert_term(acc.0);
                    let tr_ = then_.1.union(&acc.1).copied().collect();
                    (Term::Ite(if_, then_.0, else_), tr_)
                });
            }
            Var(x) => self.var(x),
            Call(name, args) => {
                let args: Box<[_]> = args.into_iter().map(|t| self.iterm(t)).collect();
                if let Some((module, name)) = name.split_once("::") {
                    self.call_mod(module, name, &args)
                } else {
                    return self.call(name, &args, tr);
                }
            }
            Def(defs, t) => {
                let siblings: Vec<_> = defs.into_iter().map(|def| self.open_def(def, tr)).collect();
                let (t, tr_) = self.term(*t, tr);
                siblings.into_iter().rev().for_each(|sig| {
                    self.close_def(sig);
                });

                return (t, tr_);
            }
            Num(n) => n.parse().map_or_else(|_| Term::Num(n.into()), Term::Int),
            TryCatch(try_, catch) => {
                let catch = catch.map_or_else(|| Call("!empty", Vec::new()), |t| *t);
                Term::TryCatch(self.iterm(*try_), self.iterm(catch))
            }
            Fold(name, xs, pat, args) => {
                use self::Fold::{Foreach, Reduce};
                let arity = args.len();
                let mut args = args.into_iter();
                let (init, update) = match (args.next(), args.next()) {
                    (Some(init), Some(update)) => (init, update),
                    _ => return (self.fail(name, Undefined::Filter(arity)), Tr::new()),
                };
                let vars: Vec<_> = pat.vars().copied().collect();
                let xs = self.iterm(*xs);
                let pat = self.pattern(pat);
                let init = self.iterm(init);
                let update = self.with_vars(&vars, |c| c.iterm(update));

                match (name, args.next(), args.next()) {
                    ("reduce", None, None) => Term::Fold(xs, pat, init, update, Reduce),
                    ("foreach", proj, None) => {
                        let (proj, tr_) = proj
                            .map(|p| self.with_vars(&vars, |c| c.iterm_tr(p, tr)))
                            .unzip();
                        let tr_ = tr_.unwrap_or_default();
                        return (Term::Fold(xs, pat, init, update, Foreach(proj)), tr_);
                    }
                    _ => self.fail(name, Undefined::Filter(arity)),
                }
            }
            BinOp(l, op, r) => {
                use parse::BinaryOp::*;
                let (l, (r, tr_)) = match op {
                    Comma => {
                        let (l, trl) = self.iterm_tr(*l, tr);
                        let (r, trr) = self.iterm_tr(*r, tr);
                        (l, (r, trl.union(&trr).copied().collect()))
                    }
                    Alt => (self.iterm(*l), self.iterm_tr(*r, tr)),
                    Pipe(ref pat) => {
                        let l = self.iterm(*l);
                        let vars: Vec<_> = pat.iter().flat_map(|p| p.vars()).copied().collect();
                        (l, self.with_vars(&vars, |c| c.iterm_tr(*r, tr)))
                    }
                    _ => (self.iterm(*l), (self.iterm(*r), Tr::new())),
                };
                let t = match op {
                    Pipe(pat) => Term::Pipe(l, pat.map(|pat| self.pattern(pat)), r),
                    Comma => Term::Comma(l, r),
                    Math(op) => Term::Math(l, op, r),
                    Assign => Term::Assign(l, r),
                    Update => Term::Update(l, r),
                    UpdateMath(op) => Term::UpdateMath(l, op, r),
                    Cmp(op) => Term::Cmp(l, op, r),
                    Or => Term::Logic(l, true, r),
                    And => Term::Logic(l, false, r),
                    Alt => Term::Alt(l, r),
                    UpdateAlt => Term::UpdateAlt(l, r),
                };
                return (t, tr_);
            }
            Path(t, path) => {
                let t = self.iterm(*t);
                let path = path.0.into_iter();
                let path = path.map(|(p, opt)| (p.map(|f| self.iterm(f)), opt));
                Term::Path(t, crate::path::Path(path.collect()))
            }
            Str(fmt, parts) => {
                use lex::StrPart;
                let fmt = match fmt {
                    Some(fmt) => self.iterm(Call(fmt, Vec::new())),
                    None => self.lut.insert_term(Term::ToString),
                };
                let parts = parts.into_iter().map(|part| match part {
                    StrPart::Str(s) => Term::Str(s.into()),
                    StrPart::Char(c) => Term::Str(c.into()),
                    StrPart::Term(f) => Term::Pipe(self.iterm(f), None, fmt),
                });
                let parts = parts.collect();
                self.sum_or(|| Term::Str(String::new()), parts)
            }
            Obj(o) => {
                let kvs = o.into_iter().map(|(k, v)| self.obj_entry(k, v)).collect();
                self.sum_or(|| Term::ObjEmpty, kvs)
            }
        };
        (t, Tr::new())
    }

    /// Compile a term in a context that does *not* permit tail-recursion.
    ///
    /// One example of such a term is `t` in `1 + t` or `t | .+1`.
    fn iterm(&mut self, t: parse::Term<&'s str>) -> TermId {
        self.iterm_tr(t, &Tr::new()).0
    }

    fn iterm_tr(&mut self, t: parse::Term<&'s str>, tr: &Tr) -> (TermId, Tr) {
        let id = self.lut.insert_term(Term::default());
        let (t, tr_) = self.term(t, tr);
        debug_assert!(tr_.is_subset(tr));
        self.lut.terms[id.0] = t;
        (id, tr_)
    }

    fn pattern(&mut self, p: parse::Pattern<&'s str>) -> Pattern<TermId> {
        match p {
            parse::Pattern::Var(_) => Pattern::Var,
            parse::Pattern::Arr(a) => {
                let iter = a
                    .into_iter()
                    .enumerate()
                    .map(|(i, p)| (self.lut.insert_term(Term::Int(i as isize)), self.pattern(p)));
                Pattern::Idx(iter.collect())
            }
            parse::Pattern::Obj(o) => {
                let iter = o.into_iter().map(|(k, p)| (self.iterm(k), self.pattern(p)));
                Pattern::Idx(iter.collect())
            }
        }
    }

    fn fail(&mut self, name: &'s str, undef: Undefined) -> Term {
        self.errs.push((name, undef));
        Term::default()
    }

    fn call_mod_id(&self, mid: ModId, name: &'s str, args: &[TermId]) -> Option<Term> {
        let mut sig_defs = self.mod_map[mid].iter().rev();
        let (sig, id, tr) = sig_defs.find(|(sig, ..)| sig.matches(name, args))?;
        debug_assert!(tr.len() <= 1);
        let typ = if tr.contains(id) {
            CallType::CatchOne
        } else {
            CallType::Inline
        };
        let vars = self.locals.vars.total;
        Some(Term::CallDef(*id, binds(&sig.args, args), vars, typ))
    }

    /// Resolve call to `mod::filter(a1, ..., an)`.
    fn call_mod(&mut self, module: &'s str, name: &'s str, args: &[TermId]) -> Term {
        let mut imported_mods = self.imported_mods.iter().rev();
        let mid = match imported_mods.find(|(_mid, module_)| module == *module_) {
            Some((mid, _module)) => mid,
            None => return self.fail(module, Undefined::Mod),
        };
        if let Some(call) = self.call_mod_id(*mid, name, args) {
            return call;
        }
        self.fail(name, Undefined::Filter(args.len()))
    }

    /// Resolve call to `filter(a1, ..., an)`.
    fn call(&mut self, name: &'s str, args: &[TermId], tr: &Tr) -> (Term, Tr) {
        if let Some(t) = self.locals.call(name, args, tr) {
            return t;
        }
        for mid in self.included_mods.iter().rev() {
            if let Some(call) = self.call_mod_id(*mid, name, args) {
                return (call, Tr::new());
            }
        }
        for (nid, (sig, _f)) in self.lut.funs.iter().enumerate() {
            if sig.matches(name, args) {
                return (Term::Native(nid, binds(&sig.args, args)), Tr::new());
            }
        }

        (self.fail(name, Undefined::Filter(args.len())), Tr::new())
    }

    fn var(&mut self, x: &'s str) -> Term {
        let mut i = self.locals.vars.total;

        if let Some(v) = self.locals.vars.bound.get_last(&Bind::Var(x)) {
            return Term::Var(i - v);
        }
        for (x_, mid) in self.imported_vars.iter().rev() {
            if x == *x_ && *mid == self.mod_map.len() {
                return Term::Var(i);
            } else {
                i += 1;
            }
        }
        for x_ in self.global_vars.iter().rev() {
            if x == *x_ {
                return Term::Var(i);
            } else {
                i += 1;
            }
        }
        self.fail(x, Undefined::Var)
    }

    fn break_(&mut self, x: &'s str) -> Term {
        if let Some(l) = self.locals.vars.bound.get_last(&Bind::Label(x)) {
            return Term::Var(self.locals.vars.total - l);
        }
        self.fail(x, Undefined::Label)
    }

    fn obj_entry(&mut self, k: parse::Term<&'s str>, v: Option<parse::Term<&'s str>>) -> Term {
        let (k, v) = match (k, v) {
            (parse::Term::Var(x), None) => (
                self.lut.insert_term(Term::Str(x[1..].into())),
                self.iterm(parse::Term::Var(x)),
            ),
            (k, None) => {
                use crate::path::{Part, Path};
                let k = self.iterm(k);
                let path = Path::from(Part::Index(k));
                let path = Term::Path(self.lut.insert_term(Term::Id), path);
                (k, self.lut.insert_term(path))
            }
            (k, Some(v)) => (self.iterm(k), self.iterm(v)),
        };
        Term::ObjSingle(k, v)
    }

    fn sum_or(&mut self, f: impl FnOnce() -> Term, terms: Vec<Term>) -> Term {
        use ops::Math::Add;
        let mut iter = terms.into_iter().rev();
        let last = iter.next().unwrap_or_else(f);
        iter.fold(last, |acc, x| {
            Term::Math(self.lut.insert_term(x), Add, self.lut.insert_term(acc))
        })
    }
}

/// Tail Call Optimisation.
#[test]
fn tco() {
    let calls_in = |filter| -> Vec<CallType> {
        let tk = lex::Lexer::new(filter).lex().unwrap();
        let tm = parse::Parser::new(&tk).term().unwrap();
        let mut c = Compiler::<_, ()>::default();
        let _id = c.iterm(tm);
        let calls = c.lut.terms.iter().filter_map(|tm| match tm {
            Term::CallDef(.., typ) => Some(*typ),
            _ => None,
        });
        calls.collect()
    };

    use CallType::*;

    // no calls to definitions here
    assert_eq!(*calls_in("1+1"), []);

    // The call to `f` in `.+1 | f` is a tail call ([`CallType::Throw`]), because:
    //
    // - `|` returns all outputs of the right-hand side as-is, and
    // - `f` is an ancestor of the filter `.+1 | f`.
    //
    // We can analyse tail call behaviour of filters by annotating each
    // definition by what tail calls it might return.
    let f = r#"
      def f:
        .+1 | f;  # f    -> {f} (f is called with Throw)
      f           # main -> { } (f is called with CatchOne)
    "#;
    assert_eq!(*calls_in(f), [CatchOne, Throw]);

    // In contexts where actual filter outputs are required,
    // filters that may return tail calls need to be called with [`CallType::CatchAll`].
    let f = r#"
      def f:
        f+1;  # f    -> {} (f is called with CatchAll)
      f       # main -> {} (f is called with Inline)
    "#;
    // This leads to a stack overflow in jaq and an OOM error in jq.
    assert_eq!(*calls_in(f), [Inline, CatchAll]);

    // Here, it is very important that
    // CatchOne is used instead of CatchAll ---
    // using the latter in the call to `g` would prevent
    // tail-recursive calls to `f` being handled by the outer call to `f`,
    // and would thus lead to a stack overflow.
    let f = r#"
      def f:
        def g:
          f, g;  # g    -> {f, g} (f and g are called with Throw)
        g;       # f    -> {f   } (g is called with CatchOne)
      f          # main -> {    } (f is called with CatchOne)
    "#;
    assert_eq!(*calls_in(f), [CatchOne, CatchOne, Throw, Throw]);

    // Here, we do not need to catch outputs from `g` when we call it in `f`, because:
    //
    // - `g` does not return tail-calls to itself and
    // - at the call site of `g`, we may return tail calls to `f`,
    //   which is what `g` returns
    let f = r#"
      def f:
        def g:
          f;     # g    -> {f} (f is called with Throw)
        g;       # f    -> {f} (g is called with *Inline*)
      f          # main -> { } (f is called with CatchOne)
    "#;
    assert_eq!(*calls_in(f), [CatchOne, Inline, Throw]);

    // If a definition is at a place that prohibits tail calls to a parent,
    // then calls to the parent are wrapped with [`CallType::CatchAll`]:
    let f = r#"
      def f:
        1 + (
          def g:
            g;   # g    -> {g} (g is called with Throw)
          g      #             (g is called with CatchOne)
        );       # f    -> { }
      f          # main -> { } (f is called with Inline)
    "#;
    assert_eq!(*calls_in(f), [Inline, CatchOne, Throw]);

    let f = r#"
      def f:
        f | f;   # f    -> {f} (f is called with CatchAll and Throw)
      f          # main -> { } (f is called with CatchOne)
    "#;
    assert_eq!(*calls_in(f), [CatchOne, CatchAll, Throw]);
}
