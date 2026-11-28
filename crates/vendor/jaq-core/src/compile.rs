//! Program compilation.

use crate::load::{self, lex, parse};
use crate::{ops, Bind as Arg};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec;
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
/// See [`Locals::call`] for how the [`CallType`] is determined.
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
    Bool(bool),
    Null,
    /// Error with a message, such as for an unknown format
    Fail(String),
    /// Array construction (`[f]`)
    Arr(T),
    /// Empty object (`{}`)
    ObjEmpty,
    /// Singleton object (`{f: g}`)
    ObjSingle(T, T),
    /// Union of objects (`{f: g, h: i}`), the left one varying slowest
    ObjCat(T, T),

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
    /// Destructuring alternatives (`f as p1 ?// p2 | g`): for every output of `f`,
    /// the number of variables to bind to null, the pattern, and `g` compiled for it
    PipeAlt(T, Box<[(usize, Pattern<T>, T)]>),
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
    /// bind the value to a variable and destructure it
    Both(Box<Self>),
}

impl<F> Drop for Pattern<F> {
    fn drop(&mut self) {
        fn take_children<F>(pat: &mut Pattern<F>, pending: &mut Vec<Pattern<F>>) {
            match pat {
                Pattern::Var => {}
                Pattern::Idx(pats) => pending.extend(pats.drain(..).map(|(_, p)| p)),
                Pattern::Both(p) if !matches!(**p, Pattern::Var) => {
                    pending.push(core::mem::replace(p.as_mut(), Pattern::Var));
                }
                Pattern::Both(_) => {}
            }
        }

        let mut pending = Vec::new();
        take_children(self, &mut pending);
        while let Some(mut pat) = pending.pop() {
            take_children(&mut pat, &mut pending);
        }
    }
}

/// Compilation error: where it occurred and jq's message, such as `$x is not defined`.
pub type Error<S> = (S, String);

/// Compilation errors.
pub type Errors<S, P> = load::Errors<S, P, Vec<Error<S>>>;

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
    tail_scopes: Vec<(TermId, TailScope)>,

    /// file name that `$__loc__` reports in the module being compiled
    loc_file: String,

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
            tail_scopes: Vec::new(),
            loc_file: String::new(),
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

    fn pop_parent(&mut self, name: S, arity: Arity) -> (Box<[Arg<S>]>, TermId) {
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
        (args, id)
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

    /// Call `f(f_1; ...; f_n)` in the current tail-call scope.
    fn call(&self, name: S, args: &[TermId], allows: impl Fn(TermId) -> bool) -> Option<(Term, Tr)> {
        Some(match self.funs.get_last(&(name, args.len()))? {
            (Fun::Arg, vars) => (Term::Var(self.vars.total - *vars), Tr::new()),
            // we   may only return tail-recursive calls to `tr` and call a sibling
            // that may only return tail-recursive calls to `tr_`
            (Fun::Sibling(args_, id, tr_), vars) => {
                let mut tr_ = tr_.clone();
                // does the sibling return tail-recursive calls to itself?
                let rec = tr_.remove(id);
                // are all remaining tail-recursive calls from the sibling permitted?
                let typ = if tr_.iter().copied().all(&allows) {
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
                let (typ, tr_) = if allows(*id) {
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

// The tail calls the compiled term can actually produce.
type Tr = BTreeSet<TermId>;

/// An index into the compiler's ancestry list of permitted tail calls.
/// Each function body may tail-call itself, and some child terms inherit that
/// scope. Terms that inspect rather than forward their children's outputs
/// start from an empty scope.
#[derive(Clone, Copy, Default)]
struct TailScope(Option<usize>);

/// A value passed between the compilation steps of [`Compiler::drive`].
enum CVal<'s> {
    /// Result of a [`Prim::Term`]: the term and the tail-recursive calls it returns.
    Term(Term, Tr),
    /// Result of a [`Prim::ITerm`]: the term ID and the tail-recursive calls it returns.
    Id(TermId, Tr),
    /// Result of a [`Prim::Pattern`].
    Pat(Pattern<TermId>),
    /// Result of a [`Prim::OpenDef`]: the name and arity of the opened definition.
    Opened(&'s str, usize),
    /// Result of a [`Prim::Module`]: the module's top-level definitions.
    Defs(Vec<Def<&'s str>>),
}

/// What a continuation returns to [`Compiler::drive`].
enum Task<'s, F> {
    /// Run this step.
    Prim(Prim<'s, F>),
    /// This value is ready.
    Value(CVal<'s>),
}

/// One step of stack-safe compilation.
///
/// The compiler used to recurse once per nested term, so a deeply nested program
/// (thousands of nested `[`/`(`, as many as the parser's `YYMAXDEPTH` permits)
/// overflowed a normal thread stack. Instead, [`Compiler::drive`] runs these
/// steps against a heap `Vec` of [`Frame`], keeping the native stack flat however
/// deeply the program nests.
enum Prim<'s, F> {
    /// Compile a term, returning its term and tail-recursive calls.
    Term(parse::Term<&'s str>, TailScope),
    /// Compile a term into a freshly inserted term ID.
    ITerm(parse::Term<&'s str>, TailScope),
    /// Compile a pattern.
    Pattern(parse::Pattern<&'s str>),
    /// Compile a definition and bind it as a sibling.
    OpenDef(parse::Def<&'s str>, TailScope),
    /// Compile a module's top-level definitions.
    Module(Vec<parse::Def<&'s str>>),
    /// Run the children in order, then combine their results.
    Sequence(Vec<Prim<'s, F>>, SeqFinish<'s, F>),
    /// Insert a term with local variables in scope for its compilation.
    ScopedTerm(Vec<&'s str>, parse::Term<&'s str>, TailScope),
}

/// How an object entry is compiled (see the `Obj` case of [`Compiler::step`]).
enum ObjEntry<'s> {
    /// `{$x}`: the key is the literal name and the value is the variable.
    VarKey(&'s str),
    /// `{k}`: the key is `k` and the value is `.[k]`.
    Shorthand,
    /// `{k: v}`.
    Pair,
}

type SeqFinish<'s, F> = Box<dyn FnOnce(&mut Compiler<&'s str, F>, Vec<CVal<'s>>) -> Task<'s, F> + 's>;

enum Frame<'s, F> {
    PopVars(Vec<&'s str>),
    Insert(TermId),
    Both,
    Definition { name: &'s str, arity: usize, id: TermId },
    Unary(fn(TermId) -> Term),
    Label(&'s str),
    Sequence {
        children: alloc::vec::IntoIter<Prim<'s, F>>,
        values: Vec<CVal<'s>>,
        finish: SeqFinish<'s, F>,
    },
}

fn seq<'s, F>(
    tasks: Vec<Prim<'s, F>>,
    finish: impl FnOnce(&mut Compiler<&'s str, F>, Vec<CVal<'s>>) -> Task<'s, F> + 's,
) -> Task<'s, F> {
    Task::Prim(Prim::Sequence(tasks, Box::new(finish)))
}

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
    pub fn compile<P: load::FileName>(
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
            self.loc_file = file.path.file_name();
            let defs = self.open_module(module);
            let defs = self.module(defs);
            self.mod_map.push(defs);
            self.close_module(file, &mut errs)
        }
        let (file, module) = mods.main;
        self.loc_file = "<top-level>".into();
        let main = self.open_module(module);
        let id = self.iterm(main);
        self.close_module(file, &mut errs);

        let lut = self.lut.map_funs(|(_sig, f)| f);
        errs.is_empty().then(|| Filter { id, lut }).ok_or(errs)
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
        load::discard_vars(m.vars);
        m.body
    }

    fn close_module<P>(&mut self, file: load::File<&'s str, P>, errs: &mut Errors<&'s str, P>) {
        if !self.errs.is_empty() {
            errs.push((file, core::mem::take(&mut self.errs)));
        }
        assert!(self.locals.is_empty());
    }

    fn close_def(&mut self, (name, arity): (&'s str, usize)) -> Def<&'s str> {
        let (args, id, tr) = self.locals.pop_sibling(name, arity);
        let args = args.into_vec().into_iter().map(|a| a.map(|_| ())).collect();
        (Sig { name, args }, id, tr)
    }

    fn module(&mut self, defs: Vec<parse::Def<&'s str>>) -> Vec<Def<&'s str>> {
        match self.drive(Prim::Module(defs)) {
            CVal::Defs(defs) => defs,
            _ => unreachable!("module yields definitions"),
        }
    }


    /// Run compilation steps against a heap-allocated continuation stack.
    ///
    /// This replaces the recursion that used to walk one native stack frame per
    /// nested term, so a deeply nested program compiles without growing the
    /// native stack (up to the parser's `YYMAXDEPTH`).
    fn drive(&mut self, start: Prim<'s, F>) -> CVal<'s> {
        let mut stack = Vec::new();
        self.tail_scopes.clear();
        let mut task = Task::Prim(start);
        loop {
            task = match task {
                Task::Value(v) => match stack.pop() {
                    Some(Frame::PopVars(vars)) => {
                        for x in vars.into_iter().rev() {
                            self.locals.vars.pop(&Bind::Var(x));
                        }
                        Task::Value(v)
                    }
                    Some(Frame::Insert(id)) => {
                        let CVal::Term(t, calls) = v else { unreachable!("term result") };
                        self.lut.terms[id.0] = t;
                        Task::Value(CVal::Id(id, calls))
                    }
                    Some(Frame::Both) => {
                        let CVal::Pat(p) = v else { unreachable!("pattern result") };
                        Task::Value(CVal::Pat(Pattern::Both(Box::new(p))))
                    }
                    Some(Frame::Definition { name, arity, id }) => {
                        let CVal::Term(body, calls) = v else { unreachable!("definition body") };
                        self.lut.terms[id.0] = body;
                        let (args, parent) = self.locals.pop_parent(name, arity);
                        assert_eq!(parent, id);
                        self.locals.push_sibling(name, args, id, calls);
                        Task::Value(CVal::Opened(name, arity))
                    }
                    Some(Frame::Unary(build)) => {
                        let CVal::Id(id, _) = v else { unreachable!("item") };
                        Task::Value(CVal::Term(build(id), Tr::new()))
                    }
                    Some(Frame::Label(x)) => {
                        self.locals.vars.pop(&Bind::Label(x));
                        let CVal::Id(id, _) = v else { unreachable!("item") };
                        Task::Value(CVal::Term(Term::Label(id), Tr::new()))
                    }
                    Some(Frame::Sequence { mut children, mut values, finish }) => {
                        values.push(v);
                        if let Some(child) = children.next() {
                            stack.push(Frame::Sequence { children, values, finish });
                            Task::Prim(child)
                        } else {
                            finish(self, values)
                        }
                    }
                    None => return v,
                },
                Task::Prim(p) => self.step(p, &mut stack),
            };
        }
    }

    /// Perform one [`Prim`].
    fn step(&mut self, p: Prim<'s, F>, stack: &mut Vec<Frame<'s, F>>) -> Task<'s, F> {
        use parse::Term as T;
        match p {
            Prim::Sequence(tasks, finish) => {
                let mut children = tasks.into_iter();
                let values = Vec::with_capacity(children.len());
                if let Some(child) = children.next() {
                    stack.push(Frame::Sequence { children, values, finish });
                    Task::Prim(child)
                } else {
                    finish(self, values)
                }
            }
            Prim::ScopedTerm(vars, t, tr) => {
                for v in &vars {
                    self.locals.vars.push(Bind::Var(v));
                }
                stack.push(Frame::PopVars(vars));
                Task::Prim(Prim::ITerm(t, tr))
            }
            Prim::ITerm(t, tr) => {
                let id = self.lut.insert_term(Term::default());
                stack.push(Frame::Insert(id));
                Task::Prim(Prim::Term(t, tr))
            }
            Prim::Pattern(p) => match p {
                parse::Pattern::Var(_) => Task::Value(CVal::Pat(Pattern::Var)),
                parse::Pattern::Arr(a) => {
                    let n = a.len();
                    let tasks = a.into_iter().map(Prim::Pattern).collect();
                    seq(tasks, move |c, vals| {
                        let mut vals = vals.into_iter();
                        let mut idx = Vec::with_capacity(n);
                        for i in 0..n {
                            let pat = match vals.next() {
                                Some(CVal::Pat(p)) => p,
                                _ => unreachable!("array pattern"),
                            };
                            idx.push((c.lut.insert_term(Term::Int(i as isize)), pat));
                        }
                        Task::Value(CVal::Pat(Pattern::Idx(idx)))
                    })
                }
                parse::Pattern::Obj(o) => {
                    let n = o.len();
                    let mut tasks = Vec::with_capacity(2 * n);
                    for (k, p) in o {
                        tasks.push(Prim::ITerm(k, TailScope::default()));
                        tasks.push(Prim::Pattern(p));
                    }
                    seq(tasks, move |_c, vals| {
                        let mut vals = vals.into_iter();
                        let mut idx = Vec::with_capacity(n);
                        for _ in 0..n {
                            let k = match vals.next() {
                                Some(CVal::Id(k, _)) => k,
                                _ => unreachable!("object pattern key"),
                            };
                            let pat = match vals.next() {
                                Some(CVal::Pat(p)) => p,
                                _ => unreachable!("object pattern"),
                            };
                            idx.push((k, pat));
                        }
                        Task::Value(CVal::Pat(Pattern::Idx(idx)))
                    })
                }
                parse::Pattern::Both(_, p) => {
                    stack.push(Frame::Both);
                    Task::Prim(Prim::Pattern(*p))
                }
            },
            Prim::OpenDef(d, tr) => {
                let parse::Def { name, args, body } = param_filters(d);
                let id = self.lut.insert_term(Term::default());
                let arity = args.len();
                let args = args.into_iter().map(|a| bind_from(a, a)).collect();
                self.locals.push_parent(name, args, id);
                let scope = TailScope(Some(self.tail_scopes.len()));
                self.tail_scopes.push((id, tr));
                stack.push(Frame::Definition { name, arity, id });
                Task::Prim(Prim::Term(body, scope))
            }
            Prim::Module(defs) => {
                let n = defs.len();
                let tasks = defs.into_iter().map(|def| Prim::OpenDef(def, TailScope::default())).collect();
                seq(tasks, move |c, vals| {
                    let mut vals = vals.into_iter();
                    let mut sigs = Vec::with_capacity(n);
                    for _ in 0..n {
                        match vals.next() {
                            Some(CVal::Opened(name, arity)) => sigs.push((name, arity)),
                            _ => unreachable!("opened definition"),
                        }
                    }
                    let mut defs: Vec<_> = sigs.into_iter().rev().map(|sig| c.close_def(sig)).collect();
                    defs.reverse();
                    Task::Value(CVal::Defs(defs))
                })
            }
            Prim::Term(t, tr) => match t {
                T::Id => Task::Value(CVal::Term(Term::Id, Tr::new())),
                T::Recurse => Task::Value(CVal::Term(Term::Recurse, Tr::new())),
                T::Bool(b) => Task::Value(CVal::Term(Term::Bool(b), Tr::new())),
                T::Null => Task::Value(CVal::Term(Term::Null, Tr::new())),
                T::Num(n) => {
                    let t = n.parse().map_or_else(|_| Term::Num(n.into()), Term::Int);
                    Task::Value(CVal::Term(t, Tr::new()))
                }
                T::Loc(line) => {
                    let file = Term::Str(self.loc_file.clone());
                    let line = Term::Int(line as isize);
                    let pairs = [("file", file), ("line", line)].map(|(k, v)| {
                        Term::ObjSingle(self.lut.insert_term(Term::Str(k.into())), self.lut.insert_term(v))
                    });
                    Task::Value(CVal::Term(self.obj_cat(pairs.into()), Tr::new()))
                }
                T::Arr(t) => {
                    let child = t.map_or_else(|| T::Call("!empty", Vec::new()), |t| *t);
                    stack.push(Frame::Unary(Term::Arr));
                    Task::Prim(Prim::ITerm(child, TailScope::default()))
                }
                T::Neg(t) => {
                    stack.push(Frame::Unary(Term::Neg));
                    Task::Prim(Prim::ITerm(*t, TailScope::default()))
                }
                T::Label(x, t) => {
                    self.locals.vars.push(Bind::Label(x));
                    stack.push(Frame::Label(x));
                    Task::Prim(Prim::ITerm(*t, TailScope::default()))
                }
                T::Break(s) => Task::Value(CVal::Term(self.break_(s), Tr::new())),
                T::Var(x) => Task::Value(CVal::Term(self.var(x), Tr::new())),
                T::IfThenElse(if_thens, else_) => {
                    let n = if_thens.len();
                    let mut tasks: Vec<Prim<'s, F>> = Vec::with_capacity(2 * n + 1);
                    for (if_, then_) in if_thens {
                        tasks.push(Prim::ITerm(if_, TailScope::default()));
                        tasks.push(Prim::ITerm(then_, tr));
                    }
                    if let Some(e) = else_ {
                        tasks.push(Prim::Term(*e, tr));
                    }
                    seq(tasks, move |c, vals| {
                        let mut vals = vals.into_iter();
                        let mut pairs = Vec::with_capacity(n);
                        for _ in 0..n {
                            let if_ = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("if") };
                            let then_ = match vals.next() { Some(CVal::Id(i, t)) => (i, t), _ => unreachable!("then") };
                            pairs.push((if_, then_.0, then_.1));
                        }
                        let mut acc = match vals.next() {
                            Some(CVal::Term(t, tr_)) => (t, tr_),
                            _ => (Term::Id, Tr::new()),
                        };
                        for (if_, then_, then_tr) in pairs.into_iter().rev() {
                            let else_ = c.lut.insert_term(acc.0);
                            acc.1.extend(then_tr);
                            acc.0 = Term::Ite(if_, then_, else_);
                        }
                        Task::Value(CVal::Term(acc.0, acc.1))
                    })
                }
                T::Call(name, args) => {
                    if args.is_empty() {
                        let (t, calls) = self.call(name, &[], tr);
                        return Task::Value(CVal::Term(t, calls));
                    }
                    let tasks: Vec<Prim<'s, F>> =
                        args.into_iter().map(|t| Prim::ITerm(t, TailScope::default())).collect();
                    seq(tasks, move |c, vals| {
                        let ids: Box<[TermId]> = vals
                            .into_iter()
                            .map(|v| match v {
                                CVal::Id(id, _) => id,
                                _ => unreachable!("argument"),
                            })
                            .collect();
                        let (t, calls) = c.call(name, &ids, tr);
                        Task::Value(CVal::Term(t, calls))
                    })
                }
                T::TryCatch(try_, catch) => {
                    let catch = catch.map_or_else(|| T::Call("!empty", Vec::new()), |t| *t);
                    let tasks = vec![Prim::ITerm(*try_, TailScope::default()), Prim::ITerm(catch, TailScope::default())];
                    seq(tasks, |_c, vals| {
                        let mut vals = vals.into_iter();
                        let try_ = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("try") };
                        let catch = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("catch") };
                        Task::Value(CVal::Term(Term::TryCatch(try_, catch), Tr::new()))
                    })
                }
                T::Fold(name, xs, mut pats, args) => {
                    use self::Fold::{Foreach, Reduce};
                    if args.len() < 2 {
                        parse::discard_term(T::Fold(name, xs, pats, args));
                        return Task::Value(CVal::Term(Term::Id, Tr::new()));
                    }
                    let (xs, pat) = if pats.len() > 1 {
                        let vars = alt_vars(&pats);
                        let arr = vars
                            .iter()
                            .map(|v| T::Var(*v))
                            .reduce(|l, r| T::BinOp(Box::new(l), parse::BinaryOp::Comma, Box::new(r)));
                        let arr = T::Arr(arr.map(Box::new));
                        let xs = T::BinOp(xs, parse::BinaryOp::Pipe(Some(pats)), Box::new(arr));
                        (Box::new(xs), parse::Pattern::Arr(vars.into_iter().map(parse::Pattern::Var).collect()))
                    } else {
                        (xs, pats.pop().unwrap_or(parse::Pattern::Arr(Vec::new())))
                    };
                    let mut args = args.into_iter();
                    let (init, update) = (args.next().unwrap(), args.next().unwrap());
                    let reduce = name == "reduce";
                    let proj = if reduce { None } else { args.next() };
                    args.for_each(parse::discard_term);
                    let vars: Vec<&'s str> = pat.vars().copied().collect();
                    let mut tasks: Vec<Prim<'s, F>> = vec![
                        Prim::ITerm(*xs, TailScope::default()),
                        Prim::Pattern(pat),
                        Prim::ITerm(init, TailScope::default()),
                    ];
                    if let Some(p) = proj {
                        tasks.push(Prim::ScopedTerm(vars.clone(), update, TailScope::default()));
                        tasks.push(Prim::ScopedTerm(vars, p, tr));
                    } else {
                        tasks.push(Prim::ScopedTerm(vars, update, TailScope::default()));
                    }
                    seq(tasks, move |_c, vals| {
                        let mut vals = vals.into_iter();
                        let xs = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("xs") };
                        let pat = match vals.next() { Some(CVal::Pat(p)) => p, _ => unreachable!("pattern") };
                        let init = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("init") };
                        let update = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("update") };
                        let (proj, tr_) = if reduce {
                            (None, Tr::new())
                        } else {
                            match vals.next() {
                                Some(CVal::Id(i, t)) => (Some(i), t),
                                None => (None, Tr::new()),
                                _ => unreachable!("project"),
                            }
                        };
                        let fold = if reduce { Reduce } else { Foreach(proj) };
                        Task::Value(CVal::Term(Term::Fold(xs, pat, init, update, fold), tr_))
                    })
                }
                T::Def(defs, body) => {
                    let n = defs.len();
                    let mut tasks: Vec<Prim<'s, F>> = Vec::with_capacity(n + 1);
                    for def in defs {
                        tasks.push(Prim::OpenDef(def, tr));
                    }
                    tasks.push(Prim::Term(*body, tr));
                    seq(tasks, move |c, vals| {
                        let mut vals = vals.into_iter();
                        let mut sigs = Vec::with_capacity(n);
                        for _ in 0..n {
                            match vals.next() {
                                Some(CVal::Opened(name, arity)) => sigs.push((name, arity)),
                                _ => unreachable!("opened definition"),
                            }
                        }
                        let body = match vals.next() {
                            Some(CVal::Term(t, tr_)) => (t, tr_),
                            _ => unreachable!("definition body"),
                        };
                        for (name, arity) in sigs.into_iter().rev() {
                            c.locals.pop_sibling(name, arity);
                        }
                        Task::Value(CVal::Term(body.0, body.1))
                    })
                }
                T::BinOp(l, parse::BinaryOp::Pipe(Some(pats)), r) if pats.len() > 1 => {
                    let all = alt_vars(&pats);
                    let mut r = Some(*r);
                    let mut tasks: Vec<Prim<'s, F>> = vec![Prim::ITerm(*l, TailScope::default())];
                    let mut meta = Vec::with_capacity(pats.len());
                    let mut pats = pats.into_iter();
                    while let Some(pat) = pats.next() {
                        let own: Vec<&'s str> = pat.vars().copied().collect();
                        let mut vars: Vec<&'s str> = all.iter().copied().filter(|v| !own.contains(v)).collect();
                        let nulls = vars.len();
                        vars.extend(own);
                        tasks.push(Prim::Pattern(pat));
                        let body = if pats.len() == 0 {
                            r.take().unwrap()
                        } else {
                            parse::clone_term(r.as_ref().unwrap())
                        };
                        tasks.push(Prim::ScopedTerm(vars, body, tr));
                        meta.push(nulls);
                    }
                    seq(tasks, move |_c, vals| {
                        let mut vals = vals.into_iter();
                        let l = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("lhs") };
                        let mut tr_ = Tr::new();
                        let mut alts = Vec::with_capacity(meta.len());
                        for nulls in meta {
                            let pat = match vals.next() {
                                Some(CVal::Pat(p)) => p,
                                _ => unreachable!("alternative pattern"),
                            };
                            let (rid, trr) = match vals.next() {
                                Some(CVal::Id(i, t)) => (i, t),
                                _ => unreachable!("alternative rhs"),
                            };
                            tr_.extend(trr);
                            alts.push((nulls, pat, rid));
                        }
                        Task::Value(CVal::Term(Term::PipeAlt(l, alts.into_boxed_slice()), tr_))
                    })
                }
                T::BinOp(l, op, r) => {
                    use parse::BinaryOp::*;
                    match op {
                        Pipe(pat) => {
                            let single = pat.and_then(|mut p| p.pop());
                            let vars: Vec<&'s str> = single.iter().flat_map(|p| p.vars()).copied().collect();
                            let has_pat = single.is_some();
                            let rhs = if vars.is_empty() {
                                Prim::ITerm(*r, tr)
                            } else {
                                Prim::ScopedTerm(vars, *r, tr)
                            };
                            let mut tasks: Vec<Prim<'s, F>> = vec![
                                Prim::ITerm(*l, TailScope::default()),
                                rhs,
                            ];
                            if let Some(p) = single {
                                tasks.push(Prim::Pattern(p));
                            }
                            seq(tasks, move |_c, vals| {
                                let mut vals = vals.into_iter();
                                let l = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("lhs") };
                                let r = match vals.next() { Some(CVal::Id(i, t)) => (i, t), _ => unreachable!("rhs") };
                                let pat = if has_pat {
                                    match vals.next() {
                                        Some(CVal::Pat(p)) => Some(p),
                                        _ => unreachable!("pattern"),
                                    }
                                } else {
                                    None
                                };
                                Task::Value(CVal::Term(Term::Pipe(l, pat, r.0), r.1))
                            })
                        }
                        Comma => {
                            let tasks = vec![Prim::ITerm(*l, tr), Prim::ITerm(*r, tr)];
                            seq(tasks, |_c, vals| {
                                let mut vals = vals.into_iter();
                                let l = match vals.next() { Some(CVal::Id(i, t)) => (i, t), _ => unreachable!("lhs") };
                                let r = match vals.next() { Some(CVal::Id(i, t)) => (i, t), _ => unreachable!("rhs") };
                                let (left, mut calls) = l;
                                calls.extend(r.1);
                                Task::Value(CVal::Term(Term::Comma(left, r.0), calls))
                            })
                        }
                        Alt => {
                            let tasks = vec![Prim::ITerm(*l, TailScope::default()), Prim::ITerm(*r, tr)];
                            seq(tasks, |_c, vals| {
                                let mut vals = vals.into_iter();
                                let l = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("lhs") };
                                let r = match vals.next() { Some(CVal::Id(i, t)) => (i, t), _ => unreachable!("rhs") };
                                Task::Value(CVal::Term(Term::Alt(l, r.0), r.1))
                            })
                        }
                        op => {
                            let tasks = vec![Prim::ITerm(*l, TailScope::default()), Prim::ITerm(*r, TailScope::default())];
                            seq(tasks, move |_c, vals| {
                                let mut vals = vals.into_iter();
                                let l = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("lhs") };
                                let r = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("rhs") };
                                let t = match op {
                                    Math(op) => Term::Math(l, op, r),
                                    Assign => Term::Assign(l, r),
                                    Update => Term::Update(l, r),
                                    UpdateMath(op) => Term::UpdateMath(l, op, r),
                                    Cmp(op) => Term::Cmp(l, op, r),
                                    Or => Term::Logic(l, true, r),
                                    And => Term::Logic(l, false, r),
                                    UpdateAlt => Term::UpdateAlt(l, r),
                                    Pipe(_) | Comma | Alt => unreachable!("handled above"),
                                };
                                Task::Value(CVal::Term(t, Tr::new()))
                            })
                        }
                    }
                }
                T::Path(t, path) => {
                    let mut tasks: Vec<Prim<'s, F>> = vec![Prim::ITerm(*t, TailScope::default())];
                    enum PartKind {
                        Index,
                        Range(bool, bool),
                    }
                    let mut kinds: Vec<(PartKind, crate::path::Opt)> = Vec::new();
                    for (part, opt) in path.0 {
                        match part {
                            crate::path::Part::Index(f) => {
                                tasks.push(Prim::ITerm(f, TailScope::default()));
                                kinds.push((PartKind::Index, opt));
                            }
                            crate::path::Part::Range(from, upto) => {
                                let hf = from.is_some();
                                let hu = upto.is_some();
                                if let Some(f) = from {
                                    tasks.push(Prim::ITerm(f, TailScope::default()));
                                }
                                if let Some(u) = upto {
                                    tasks.push(Prim::ITerm(u, TailScope::default()));
                                }
                                kinds.push((PartKind::Range(hf, hu), opt));
                            }
                        }
                    }
                    seq(tasks, move |_c, vals| {
                        let mut vals = vals.into_iter();
                        let t = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("path base") };
                        let mut path = Vec::with_capacity(kinds.len());
                        for (kind, opt) in kinds {
                            let part = match kind {
                                PartKind::Index => {
                                    let f = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("index") };
                                    crate::path::Part::Index(f)
                                }
                                PartKind::Range(hf, hu) => {
                                    let from = if hf {
                                        match vals.next() { Some(CVal::Id(i, _)) => Some(i), _ => unreachable!("from") }
                                    } else {
                                        None
                                    };
                                    let upto = if hu {
                                        match vals.next() { Some(CVal::Id(i, _)) => Some(i), _ => unreachable!("upto") }
                                    } else {
                                        None
                                    };
                                    crate::path::Part::Range(from, upto)
                                }
                            };
                            path.push((part, opt));
                        }
                        Task::Value(CVal::Term(Term::Path(t, crate::path::Path(path)), Tr::new()))
                    })
                }
                T::Str(fmt, parts) => {
                    use lex::StrPart;
                    let mut tasks: Vec<Prim<'s, F>> = Vec::new();
                    if let Some(f) = fmt {
                        tasks.push(Prim::ITerm(T::Call(f, Vec::new()), TailScope::default()));
                    }
                    let parts: Vec<_> = parts.into_iter().map(|part| match part {
                        StrPart::Str(s) => StrPart::Str(s),
                        StrPart::Char(c) => StrPart::Char(c),
                        StrPart::Term(f) => {
                            tasks.push(Prim::ITerm(f, TailScope::default()));
                            StrPart::Term(())
                        }
                    }).collect();
                    let has_fmt = fmt.is_some();
                    seq(tasks, move |c, vals| {
                        let mut vals = vals.into_iter();
                        let fmt = if has_fmt {
                            match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("format") }
                        } else {
                            c.lut.insert_term(Term::ToString)
                        };
                        let mut out: Vec<Term> = Vec::new();
                        for part in parts {
                            let lit = match part {
                                StrPart::Str(s) => s.into(),
                                StrPart::Char(ch) => String::from(ch),
                                StrPart::Term(_) => {
                                    let f = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("interpolation") };
                                    out.push(Term::Pipe(f, None, fmt));
                                    continue;
                                }
                            };
                            match out.last_mut() {
                                Some(Term::Str(s)) => s.push_str(&lit),
                                _ => out.push(Term::Str(lit)),
                            }
                        }
                        let mut out = out.into_iter();
                        let first = out.next().unwrap_or_else(|| Term::Str(String::new()));
                        let t = out.fold(first, |acc, x| {
                            Term::Math(c.lut.insert_term(acc), ops::Math::Add, c.lut.insert_term(x))
                        });
                        Task::Value(CVal::Term(t, Tr::new()))
                    })
                }
                T::Obj(o) => {
                    let n = o.len();
                    let mut tasks: Vec<Prim<'s, F>> = Vec::new();
                    let mut kinds: Vec<ObjEntry<'s>> = Vec::with_capacity(n);
                    for (k, v) in o {
                        match (k, v) {
                            (T::Var(x), None) => {
                                tasks.push(Prim::ITerm(T::Var(x), TailScope::default()));
                                kinds.push(ObjEntry::VarKey(&x[1..]));
                            }
                            (k, None) => {
                                tasks.push(Prim::ITerm(k, TailScope::default()));
                                kinds.push(ObjEntry::Shorthand);
                            }
                            (k, Some(v)) => {
                                tasks.push(Prim::ITerm(k, TailScope::default()));
                                tasks.push(Prim::ITerm(v, TailScope::default()));
                                kinds.push(ObjEntry::Pair);
                            }
                        }
                    }
                    seq(tasks, move |c, vals| {
                        use crate::path::{Part, Path};
                        let mut vals = vals.into_iter();
                        let mut out = Vec::with_capacity(n);
                        for kind in kinds {
                            let entry = match kind {
                                ObjEntry::VarKey(name) => {
                                    let v = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("value") };
                                    let k = c.lut.insert_term(Term::Str(name.into()));
                                    Term::ObjSingle(k, v)
                                }
                                ObjEntry::Shorthand => {
                                    let k = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("key") };
                                    let path = Path::from(Part::Index(k));
                                    let id = c.lut.insert_term(Term::Id);
                                    let v = c.lut.insert_term(Term::Path(id, path));
                                    Term::ObjSingle(k, v)
                                }
                                ObjEntry::Pair => {
                                    let k = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("key") };
                                    let v = match vals.next() { Some(CVal::Id(i, _)) => i, _ => unreachable!("value") };
                                    Term::ObjSingle(k, v)
                                }
                            };
                            out.push(entry);
                        }
                        Task::Value(CVal::Term(c.obj_cat(out), Tr::new()))
                    })
                }
            },
        }
    }

    fn obj_cat(&mut self, terms: Vec<Term>) -> Term {
        let mut iter = terms.into_iter().rev();
        let last = iter.next().unwrap_or(Term::ObjEmpty);
        iter.fold(last, |acc, x| {
            Term::ObjCat(self.lut.insert_term(x), self.lut.insert_term(acc))
        })
    }

    /// Compile a term in a context that does *not* permit tail-recursion.
    ///
    /// One example of such a term is `t` in `1 + t` or `t | .+1`.
    fn iterm(&mut self, t: parse::Term<&'s str>) -> TermId {
        match self.drive(Prim::ITerm(t, TailScope::default())) {
            CVal::Id(id, _) => id,
            _ => unreachable!("iterm yields a term ID"),
        }
    }


    fn fail(&mut self, at: &'s str, msg: String) -> Term {
        self.errs.push((at, msg));
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
    ///
    /// Modules imported under the same name are searched from the last import on.
    fn call_mod(&mut self, full: &'s str, module: &'s str, name: &'s str, args: &[TermId]) -> Term {
        let mids: Vec<_> = self.imported_mods.iter().rev().filter(|(_, m)| *m == module).map(|(mid, _)| *mid).collect();
        for mid in mids {
            if let Some(call) = self.call_mod_id(mid, name, args) {
                return call;
            }
        }
        self.fail(full, alloc::format!("{full}/{} is not defined", args.len()))
    }

    /// Resolve call to `filter(a1, ..., an)` or `mod::filter(a1, ..., an)`.
    fn call(&mut self, name: &'s str, args: &[TermId], tr: TailScope) -> (Term, Tr) {
        if let Some((module, name_)) = name.split_once("::") {
            return (self.call_mod(name, module, name_, args), Tr::new());
        }
        let allows = |target| {
            let mut scope = tr;
            while let Some(i) = scope.0 {
                let (id, parent) = self.tail_scopes[i];
                if id <= target {
                    return id == target;
                }
                scope = parent;
            }
            false
        };
        if let Some(t) = self.locals.call(name, args, allows) {
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
        // jq resolves formats at runtime, failing for unknown ones
        if let (Some(fmt), []) = (name.strip_prefix('@'), args) {
            return (Term::Fail(alloc::format!("{fmt} is not a valid format")), Tr::new());
        }

        let msg = alloc::format!("{name}/{} is not defined", args.len());
        (self.fail(name, msg), Tr::new())
    }

    fn var(&mut self, x: &'s str) -> Term {
        let mut i = self.locals.vars.total;

        if let Some(v) = self.locals.vars.bound.get_last(&Bind::Var(x)) {
            return Term::Var(i - v);
        }
        // data imported as `$d` is also bound as `$d::d`
        let data = match x.split_once("::") {
            Some((m, n)) if m.strip_prefix('$') == Some(n) => m,
            _ => x,
        };
        for (x_, mid) in self.imported_vars.iter().rev() {
            if data == *x_ && *mid == self.mod_map.len() {
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
        self.fail(x, alloc::format!("{x} is not defined"))
    }

    /// `break $x`, where `s` spans the whole expression.
    fn break_(&mut self, s: &'s str) -> Term {
        let x = s.find('$').map_or(s, |i| &s[i..]);
        if let Some(l) = self.locals.vars.bound.get_last(&Bind::Label(x)) {
            return Term::Var(self.locals.vars.total - l);
        }
        // jq binds labels as variables with names that cannot be written
        self.fail(s, alloc::format!("$*label-{} is not defined", &x[1..]))
    }

}

/// Variables bound by any of the alternatives `p1 ?// p2 ?// ...`, without duplicates,
/// in order of first appearance.
fn alt_vars<'s>(pats: &[parse::Pattern<&'s str>]) -> Vec<&'s str> {
    let mut vars = Vec::new();
    for x in pats.iter().flat_map(|p| p.vars()) {
        if !vars.contains(x) {
            vars.push(*x);
        }
    }
    vars
}

/// A parameter `$x` of a definition binds both `$x` and the filter `x`:
/// `def f($x): g;` is `def f(x): x as $x | g;`, as in jq's `gen_function`.
fn param_filters(mut def: parse::Def<&str>) -> parse::Def<&str> {
    use parse::{BinaryOp, Pattern, Term};
    for arg in def.args.iter_mut().rev() {
        if let Some(name) = arg.strip_prefix('$') {
            let call = Term::Call(name, Vec::new());
            let pat = BinaryOp::Pipe(Some(Vec::from([Pattern::Var(*arg)])));
            def.body = Term::BinOp(Box::new(call), pat, Box::new(def.body));
            *arg = name;
        }
    }
    def
}

#[test]
fn left_nested_pipes_preserve_nested_definition_scope() {
    let defs = 512;
    let pipes = 1200;
    let source = alloc::format!(
        "{}1{}; {}f{}",
        "def f: ".repeat(defs),
        "; f".repeat(defs - 1),
        "(".repeat(pipes),
        " | .)".repeat(pipes),
    );
    let tm = parse::Parser::new(&source).term().unwrap();
    let mut c = Compiler::<_, ()>::default();
    let mut id = c.iterm(tm);
    assert!(c.errs.is_empty());
    for _ in 0..pipes {
        let Term::Pipe(left, None, right) = c.lut.terms[id.0] else { panic!("expected a pipe") };
        assert!(matches!(c.lut.terms[right.0], Term::Id));
        id = left;
    }
    for _ in 0..defs {
        let Term::CallDef(body, _, _, CallType::Inline) = c.lut.terms[id.0] else {
            panic!("expected a resolved definition")
        };
        id = body;
    }
    assert!(matches!(c.lut.terms[id.0], Term::Int(1)));
}

#[test]
fn deep_destructuring_preserves_scope_in_each_alternative() {
    let depth = 1000;
    let source = alloc::format!(
        "null as {}$v{} ?// $fallback | {}$v{}",
        "[".repeat(depth), "]".repeat(depth), "[".repeat(depth), "]".repeat(depth),
    );
    let tm = parse::Parser::new(&source).term().unwrap();
    let mut c = Compiler::<_, ()>::default();
    let id = c.iterm(tm);
    assert!(c.errs.is_empty());
    let Term::PipeAlt(_, alts) = &c.lut.terms[id.0] else { panic!("expected alternatives") };
    assert_eq!(alts.len(), 2);
    for (i, (nulls, pat, body)) in alts.iter().enumerate() {
        assert_eq!(*nulls, 1);
        let mut pat = pat;
        let mut pat_depth = 0;
        while let Pattern::Idx(items) = pat {
            let [(idx, child)] = items.as_slice() else { panic!("expected one item") };
            assert!(matches!(c.lut.terms[idx.0], Term::Int(0)));
            pat = child;
            pat_depth += 1;
        }
        assert!(matches!(pat, Pattern::Var));
        assert_eq!(pat_depth, if i == 0 { depth } else { 0 });

        let mut body = *body;
        for _ in 0..depth {
            let Term::Arr(inner) = c.lut.terms[body.0] else { panic!("expected an array") };
            body = inner;
        }
        let Term::Var(slot) = c.lut.terms[body.0] else { panic!("expected a scoped variable") };
        assert_eq!(slot, i);
    }
}

/// Tail Call Optimisation.
#[test]
fn tco() {
    let calls_in = |filter| -> Vec<CallType> {
        let tm = parse::Parser::new(filter).term().unwrap();
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
