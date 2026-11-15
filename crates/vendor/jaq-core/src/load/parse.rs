//! Parsing, as jq's bison grammar (`src/parser.y`) does it.
//!
//! The parser runs the LALR(1) tables that bison generated for jq
//! ([`super::tables`]) with a port of bison's `yyparse` skeleton,
//! including its error recovery, so that programs are accepted and
//! rejected exactly like jq does, with the same messages.

use super::konst::{konst, Const};
use super::lex::{sym, Lexer, StrPart, TokVal, Token};
use super::tables as t;
use crate::ops;
use crate::path::{self, Path};
use alloc::{boxed::Box, string::String, vec::Vec};
use core::fmt::{self, Debug};
use core::marker::PhantomData;

/// Byte range of a source location.
pub type Span = (usize, usize);

/// Parse error: jq's message and the location it reports.
pub type Error = (String, Option<Span>);

/// Function from value to stream of values, such as `.[] | add / length`.
#[derive(Clone, Debug, Default)]
pub enum Term<S> {
    /// Identity, i.e. `.`
    #[default]
    Id,
    /// Recursion (`..`)
    Recurse,

    /// Number literal
    Num(S),
    /// String
    ///
    /// This consists of an optional format filter starting with `@` (such as `@text`),
    /// followed by quoted string parts (such as `"Hello, \(.name)! \u263A"`).
    Str(Option<S>, Vec<StrPart<S, Self>>),
    /// `true` or `false`
    Bool(bool),
    /// `null`
    Null,
    /// `$__loc__`, with its line number
    Loc(usize),
    /// Array, empty if `None`
    Arr(Option<Box<Self>>),
    /// Object, specifying its key-value pairs
    ///
    /// A pair without value is `{k}`, short for `{k: .[k]}`;
    /// a variable key without value is `{$x}`, short for `{x: $x}`.
    Obj(Vec<(Self, Option<Self>)>),

    /// Negation
    Neg(Box<Self>),

    /// Binary operation, e.g. `1 + 2`
    BinOp(Box<Self>, BinaryOp<S>, Box<Self>),

    /// Control flow variable declaration, e.g. `label $x | ...`
    Label(S, Box<Self>),
    /// Break out from control flow to location variable, e.g. `break $x`
    ///
    /// The string spans the whole `break $x`.
    Break(S),

    /// `reduce` and `foreach`, e.g. `reduce .[] as $x (0; .+$x)`
    Fold(S, Box<Self>, Vec<Pattern<S>>, Vec<Self>),
    /// `try` and optional `catch`
    TryCatch(Box<Self>, Option<Box<Self>>),
    /// If-then-else
    IfThenElse(Vec<(Self, Self)>, Option<Box<Self>>),

    /// Local definition
    Def(Vec<Def<S, Self>>, Box<Self>),
    /// Call to another filter, e.g. `map(.+1)`, or a format, e.g. `@csv`
    Call(S, Vec<Self>),
    /// Variable, such as `$x` (including leading '$')
    Var(S),

    /// Path such as `.a`, `.[][]."b"`, `f[0]`
    Path(Box<Self>, Path<Self>),
}

/// Variable-binding pattern, such as in `.[] as [$x, {$y, (f): $z}]`
#[derive(Clone, Debug)]
pub enum Pattern<S> {
    /// Variable
    Var(S),
    /// Array
    Arr(Vec<Self>),
    /// Object
    Obj(Vec<(Term<S>, Self)>),
    /// Variable bound to the value that is also destructured, as `$x` in `{$x: [$y]}`
    Both(S, Box<Self>),
}

/// Binary operators, such as `|`, `,`, `//`, ...
#[derive(Clone, Debug)]
pub enum BinaryOp<S> {
    /// Application, i.e. `l | r` if no pattern is given, else
    /// `l as p1 ?// p2 ?// ... | r`
    Pipe(Option<Vec<Pattern<S>>>),
    /// Concatenation, i.e. `l, r`
    Comma,
    /// Alternation, i.e. `l // r`
    Alt,
    /// Logical disjunction, i.e. `l or r`
    Or,
    /// Logical conjunction, i.e. `l and r`
    And,
    /// Mathematical operation, e.g. `l + r`, `l - r`, ...
    Math(ops::Math),
    /// Comparison operation, e.g. `l == r`, `l <= r`, ...
    Cmp(ops::Cmp),
    /// Assignment, i.e. `l = r`,
    Assign,
    /// Update, i.e. `l |= r`
    Update,
    /// Mathematical assignment, i.e. `l += r`, `l -= r`, ...
    UpdateMath(ops::Math),
    /// `l //= r`
    UpdateAlt,
}

impl<S> Term<S> {
    pub(crate) fn from_str(s: S) -> Self {
        Self::Str(None, [StrPart::Str(s)].into())
    }

    /// `{}[]` returns zero values.
    pub(crate) fn empty() -> Self {
        let path = (path::Part::Range(None, None), path::Opt::Essential);
        Term::Path(Term::Obj(Vec::new()).into(), Path(Vec::from([path])))
    }

    fn path(self, part: path::Part<Self>, opt: path::Opt) -> Self {
        match self {
            Term::Path(t, mut p) => {
                p.0.push((part, opt));
                Term::Path(t, p)
            }
            t => Term::Path(Box::new(t), Path(Vec::from([(part, opt)]))),
        }
    }

    fn bin(self, op: BinaryOp<S>, r: Self) -> Self {
        Term::BinOp(Box::new(self), op, Box::new(r))
    }
}

impl<S> Pattern<S> {
    /// Variables bound by the pattern, in the order in which they are bound.
    pub(crate) fn vars(&self) -> Box<dyn Iterator<Item = &S> + '_> {
        match self {
            Pattern::Var(x) => Box::new(core::iter::once(x)),
            Pattern::Arr(a) => Box::new(a.iter().flat_map(|p| p.vars())),
            Pattern::Obj(o) => Box::new(o.iter().flat_map(|(_k, p)| p.vars())),
            Pattern::Both(x, p) => Box::new(core::iter::once(x).chain(p.vars())),
        }
    }
}

/// jq definition, consisting of a name, optional arguments, and a body.
///
/// Examples:
///
/// ~~~ jq
/// def pi: 3.1415;
/// def double($x): $x + $x;
/// def map(f): [.[] | f];
/// def recurse(f; cond): recurse(f | select(cond));
/// ~~~
#[derive(Clone)]
pub struct Def<S = &'static str, F = Term<S>> {
    /// name, e.g. `"double"` or `"map"`
    pub name: S,
    /// arguments, e.g. `["$x"]`, `["f"]`, or `["f", "cond"]`
    pub args: Vec<S>,
    /// right-hand side, e.g. a term corresponding to `[.[] | f]`
    pub body: F,
}

/// Print definition like a tuple.
impl<S: Debug, F: Debug> Debug for Def<S, F> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "({:?}, {:?}, {:?})", self.name, self.args, self.body)
    }
}

impl<S, F> Def<S, F> {
    pub(crate) fn new(name: S, args: Vec<S>, body: F) -> Self {
        Self { name, args, body }
    }
}

/// Import or include directive.
#[derive(Clone, Debug)]
pub struct Dep<S> {
    /// relative path of the imported module, as given in the source
    pub path: String,
    /// location of the path, for error messages
    pub path_span: S,
    /// name, starting with `$` for data imports; `None` for includes
    pub name: Option<S>,
    /// metadata object
    pub meta: Option<Const>,
}

/// jq module, consisting of metadata, imports/includes, and a body.
#[derive(Debug, Default)]
pub struct Module<S, B> {
    /// metadata object of the `module` directive
    pub meta: Option<Const>,
    /// imports and includes, in source order
    pub deps: Vec<Dep<S>>,
    /// main term or definitions
    pub body: B,
}

/// Body of a jq program: a main term, or only definitions.
#[derive(Debug)]
pub enum Body<S> {
    /// program with a main term
    Main(Term<S>),
    /// library
    Defs(Vec<Def<S>>),
}

impl<S> Default for Body<S> {
    fn default() -> Self {
        Self::Defs(Vec::new())
    }
}

/// Semantic value of a grammar symbol.
enum Sem<'s> {
    None,
    Text(&'s str),
    Chars(Vec<char>),
    Term(Term<&'s str>),
    Terms(Vec<Term<&'s str>>),
    Fmt(Option<&'s str>),
    Parts(Vec<StrPart<&'s str, Term<&'s str>>>),
    Else(Vec<(Term<&'s str>, Term<&'s str>)>, Option<Term<&'s str>>),
    Pat(Pattern<&'s str>),
    Pats(Vec<Pattern<&'s str>>),
    ObjPats(Vec<(Term<&'s str>, Pattern<&'s str>)>),
    Pairs(Vec<(Term<&'s str>, Option<Term<&'s str>>)>),
    Def(Def<&'s str>),
    Defs(Vec<Def<&'s str>>),
    Params(Vec<&'s str>),
    Meta(Option<Const>),
    Dep(Option<Dep<&'s str>>),
    Deps(Vec<Dep<&'s str>>),
    From(String, &'s str),
    Top(Module<&'s str, Body<&'s str>>),
}

macro_rules! sem {
    ($v:expr, $p:pat => $e:expr) => {
        match $v {
            $p => $e,
            _ => Default::default(),
        }
    };
}

impl<'s> Sem<'s> {
    fn term(self) -> Term<&'s str> {
        sem!(self, Sem::Term(t) => t)
    }
    fn text(self) -> &'s str {
        sem!(self, Sem::Text(s) => s)
    }
    fn pat(self) -> Pattern<&'s str> {
        match self {
            Sem::Pat(p) => p,
            _ => Pattern::Arr(Vec::new()),
        }
    }
}

/// Parser state, as bison's `yyparse` keeps it.
struct Yacc<'s> {
    lexer: Lexer<'s>,
    code: &'s str,
    /// file name reported by `$__loc__` in constants
    loc_file: &'s str,
    errs: Vec<Error>,
}

/// Number of tokens that can be listed after "expecting" in a syntax error.
const YYARGS: usize = 4;
/// Size of the parser stack at which bison gives up.
const YYMAXDEPTH: usize = 10000;

impl<'s> Yacc<'s> {
    fn fail(&mut self, span: Span, msg: impl Into<String>) {
        self.errs.push((msg.into(), Some(span)));
    }

    fn slice(&self, span: Span) -> &'s str {
        &self.code[span.0..span.1]
    }

    /// `yysyntax_error` with `%define parse.error verbose`.
    fn syntax_error(state: usize, token: Option<u8>) -> String {
        let Some(token) = token else {
            return "syntax error".into();
        };
        let mut expected = Vec::new();
        let mut too_many = false;
        let n = t::YYPACT[state] as i32;
        if n != t::YYPACT_NINF {
            let begin = if n < 0 { -n } else { 0 };
            let end = (t::YYLAST - n + 1).min(t::YYNTOKENS);
            for x in begin..end {
                let i = (x + n) as usize;
                if t::YYCHECK[i] as i32 == x && x != sym::ERROR as i32 && t::YYTABLE[i] as i32 != t::YYTABLE_NINF {
                    if expected.len() == YYARGS {
                        too_many = true;
                        break;
                    }
                    expected.push(x as usize);
                }
            }
        }
        let mut msg = alloc::format!("syntax error, unexpected {}", t::YYTNAME[token as usize]);
        if !too_many {
            for (i, x) in expected.iter().enumerate() {
                msg.push_str(if i == 0 { ", expecting " } else { " or " });
                msg.push_str(t::YYTNAME[*x]);
            }
        }
        msg
    }

    /// Run the parser, returning the value of `TopLevel` if parsing finished.
    fn run(&mut self) -> Option<Module<&'s str, Body<&'s str>>> {
        let mut states: Vec<usize> = Vec::from([0]);
        let mut vals: Vec<Sem<'s>> = Vec::from([Sem::None]);
        let mut locs: Vec<Span> = Vec::from([(0, 0)]);
        let mut yychar: Option<Token<'s>> = None;
        let mut yylloc: Span = (0, 0);
        let mut errstatus: u8 = 0;
        let mut error_start;

        enum Step {
            Shift(usize),
            Reduce(usize),
            Error,
        }

        loop {
            let state = *states.last().unwrap();
            if states.len() >= YYMAXDEPTH {
                self.fail(yylloc, "memory exhausted");
                return None;
            }
            // the termination state is reached by shifting the end of file after `TopLevel`
            if state == t::YYFINAL as usize {
                vals.pop();
                return match vals.pop() {
                    Some(Sem::Top(m)) => Some(m),
                    _ => None,
                };
            }

            let step = 'step: {
                let n = t::YYPACT[state] as i32;
                if n != t::YYPACT_NINF {
                    let tok = match &yychar {
                        Some(tok) => tok,
                        None => {
                            let tok = self.lexer.next_token();
                            yylloc = (tok.start, tok.end);
                            if let TokVal::Invalid(msg) = &tok.val {
                                let msg = msg.clone();
                                self.fail(yylloc, msg);
                            }
                            yychar.insert(tok)
                        }
                    };
                    let i = n + tok.sym as i32;
                    if (0..=t::YYLAST).contains(&i) && t::YYCHECK[i as usize] as u8 == tok.sym {
                        let n = t::YYTABLE[i as usize] as i32;
                        break 'step if n > 0 {
                            Step::Shift(n as usize)
                        } else if n == t::YYTABLE_NINF {
                            Step::Error
                        } else {
                            Step::Reduce((-n) as usize)
                        };
                    }
                }
                match t::YYDEFACT[state] {
                    0 => Step::Error,
                    rule => Step::Reduce(rule as usize),
                }
            };

            match step {
                Step::Shift(next) => {
                    errstatus = errstatus.saturating_sub(1);
                    let tok = yychar.take().unwrap();
                    vals.push(match tok.val {
                        TokVal::Text(s) => Sem::Text(s),
                        TokVal::Chars(c) => Sem::Chars(c),
                        TokVal::None | TokVal::Invalid(_) => Sem::None,
                    });
                    locs.push((tok.start, tok.end));
                    states.push(next);
                }
                Step::Reduce(rule) => {
                    let len = t::YYR2[rule] as usize;
                    let top = locs.len() - 1;
                    let loc = if len > 0 {
                        (locs[top + 1 - len].0, locs[top].1)
                    } else {
                        (locs[top].1, locs[top].1)
                    };
                    let rhs_locs = locs.split_off(locs.len() - len);
                    let rhs = vals.split_off(vals.len() - len);
                    states.truncate(states.len() - len);
                    let val = self.action(rule, rhs, &rhs_locs, loc);
                    vals.push(val);
                    locs.push(loc);
                    let lhs = t::YYR1[rule] as i32 - t::YYNTOKENS;
                    let top = *states.last().unwrap() as i32;
                    let i = t::YYPGOTO[lhs as usize] as i32 + top;
                    let next = if (0..=t::YYLAST).contains(&i) && t::YYCHECK[i as usize] as i32 == top {
                        t::YYTABLE[i as usize] as i32
                    } else {
                        t::YYDEFGOTO[lhs as usize] as i32
                    };
                    states.push(next as usize);
                }
                Step::Error => {
                    if errstatus == 0 {
                        let msg = Self::syntax_error(state, yychar.as_ref().map(|t| t.sym));
                        self.fail(yylloc, msg);
                    }
                    error_start = yylloc.0;
                    if errstatus == 3 {
                        match &yychar {
                            Some(tok) if tok.sym == sym::EOF => return None,
                            Some(_) => yychar = None,
                            None => {}
                        }
                    }
                    errstatus = 3;
                    let next = loop {
                        let state = *states.last().unwrap();
                        let n = t::YYPACT[state] as i32;
                        if n != t::YYPACT_NINF {
                            let i = n + sym::ERROR as i32;
                            if (0..=t::YYLAST).contains(&i) && t::YYCHECK[i as usize] as u8 == sym::ERROR {
                                let n = t::YYTABLE[i as usize] as i32;
                                if n > 0 {
                                    break n as usize;
                                }
                            }
                        }
                        if states.len() == 1 {
                            return None;
                        }
                        error_start = locs.last().unwrap().0;
                        states.pop();
                        vals.pop();
                        locs.pop();
                    };
                    vals.push(Sem::None);
                    locs.push((error_start, yylloc.1));
                    states.push(next);
                }
            }
        }
    }

    /// Check the key of `{(k): v}` and `{(k): $pattern}`, as jq's `check_object_key`.
    fn check_object_key(&mut self, k: &Term<&'s str>, span: Span) {
        match konst(k, self.loc_file) {
            Some(Const::Str(_)) | None => {}
            Some(c) => self.fail(span, alloc::format!("Cannot use {} as object key", c.describe())),
        }
    }

    /// Check module or import metadata, as jq does in `Module` and `Import`.
    fn meta(&mut self, t: &Term<&'s str>, span: Span) -> Option<Const> {
        match konst(t, self.loc_file) {
            None => self.fail(span, "Module metadata must be constant"),
            Some(c @ Const::Obj(_)) => return Some(c),
            Some(_) => self.fail(span, "Module metadata must be an object"),
        }
        None
    }

    fn line(&self, pos: usize) -> usize {
        self.code.as_bytes()[..pos].iter().filter(|c| **c == b'\n').count() + 1
    }

    /// The semantic action of a grammar rule, numbered as in jq's `parser.c`.
    fn action(&mut self, rule: usize, rhs: Vec<Sem<'s>>, l: &[Span], loc: Span) -> Sem<'s> {
        use path::{Opt, Part};
        use BinaryOp::*;
        use ops::{Cmp, Math};
        let mut v = rhs.into_iter();
        let mut next = move || v.next().unwrap_or(Sem::None);
        macro_rules! skip {
            ($n:expr) => {
                for _ in 0..$n {
                    next();
                }
            };
        }
        let bin = |next: &mut dyn FnMut() -> Sem<'s>, op| {
            let a = next().term();
            next();
            Sem::Term(a.bin(op, next().term()))
        };
        let idx = |next: &mut dyn FnMut() -> Sem<'s>, opt, dot: bool| {
            let t = next().term();
            skip_n(next, 1 + usize::from(dot));
            let k = next().term();
            Sem::Term(t.path(Part::Index(k), opt))
        };
        fn skip_n<'s>(next: &mut dyn FnMut() -> Sem<'s>, n: usize) {
            (0..n).for_each(|_| {
                next();
            })
        }
        let iter = |next: &mut dyn FnMut() -> Sem<'s>, opt| {
            Sem::Term(next().term().path(Part::Range(None, None), opt))
        };
        let slice = |next: &mut dyn FnMut() -> Sem<'s>, from: bool, upto: bool, opt| {
            let t = next().term();
            next();
            let from = from.then(|| next().term());
            next();
            let upto = upto.then(|| next().term());
            Sem::Term(t.path(Part::Range(from, upto), opt))
        };
        let (essential, optional) = (Opt::Essential, Opt::Optional);
        match rule {
            // TopLevel: Module Imports Query | Module Imports FuncDefs
            2 | 3 => {
                let meta = sem!(next(), Sem::Meta(m) => m);
                let deps = sem!(next(), Sem::Deps(d) => d);
                let body = match next() {
                    Sem::Term(t) => Body::Main(t),
                    Sem::Defs(d) => Body::Defs(d),
                    _ => Body::Defs(Vec::new()),
                };
                Sem::Top(Module { meta, deps, body })
            }
            // Module: %empty
            4 => Sem::Meta(None),
            // Module: "module" Query ';'
            5 => {
                next();
                let t = next().term();
                Sem::Meta(self.meta(&t, l[1]))
            }
            // Imports: %empty
            6 => Sem::Deps(Vec::new()),
            // Imports: Import Imports
            7 => {
                let dep = sem!(next(), Sem::Dep(d) => d);
                let mut deps = sem!(next(), Sem::Deps(d) => d);
                deps.splice(0..0, dep);
                Sem::Deps(deps)
            }
            // FuncDefs: %empty
            8 => Sem::Defs(Vec::new()),
            // FuncDefs: FuncDef FuncDefs
            9 => {
                let def = sem!(next(), Sem::Def(d) => Some(d));
                let mut defs = sem!(next(), Sem::Defs(d) => d);
                defs.splice(0..0, def);
                Sem::Defs(defs)
            }
            // Query: FuncDef Query
            10 => {
                let def = sem!(next(), Sem::Def(d) => Some(d));
                let t = next().term();
                Sem::Term(Term::Def(def.into_iter().collect(), Box::new(t)))
            }
            // Query: Expr "as" Patterns '|' Query
            11 => {
                let x = next().term();
                next();
                let pats = sem!(next(), Sem::Pats(p) => p);
                next();
                Sem::Term(x.bin(Pipe(Some(pats)), next().term()))
            }
            // Query: "label" BINDING '|' Query
            12 => {
                next();
                let x = next().text();
                next();
                Sem::Term(Term::Label(x, Box::new(next().term())))
            }
            13 => bin(&mut next, Pipe(None)),
            14 => bin(&mut next, Comma),
            // Query: Expr | Expr: Term
            15 | 38 => next(),
            16 => bin(&mut next, Alt),
            17 => bin(&mut next, Assign),
            18 => bin(&mut next, Or),
            19 => bin(&mut next, And),
            20 => bin(&mut next, UpdateAlt),
            21 => bin(&mut next, Update),
            22 => bin(&mut next, Math(Math::Add)),
            23 => bin(&mut next, UpdateMath(Math::Add)),
            24 => bin(&mut next, Math(Math::Sub)),
            25 => bin(&mut next, UpdateMath(Math::Sub)),
            26 => bin(&mut next, Math(Math::Mul)),
            27 => bin(&mut next, UpdateMath(Math::Mul)),
            28 => bin(&mut next, Math(Math::Div)),
            29 => bin(&mut next, Math(Math::Rem)),
            30 => bin(&mut next, UpdateMath(Math::Div)),
            31 => bin(&mut next, UpdateMath(Math::Rem)),
            32 => bin(&mut next, Cmp(Cmp::Eq)),
            33 => bin(&mut next, Cmp(Cmp::Ne)),
            34 => bin(&mut next, Cmp(Cmp::Lt)),
            35 => bin(&mut next, Cmp(Cmp::Gt)),
            36 => bin(&mut next, Cmp(Cmp::Le)),
            37 => bin(&mut next, Cmp(Cmp::Ge)),
            // Import: ImportWhat ';'
            39 => next(),
            // Import: ImportWhat Query ';'
            40 => {
                let dep = sem!(next(), Sem::Dep(d) => d);
                let t = next().term();
                match (self.meta(&t, l[1]), dep) {
                    (Some(meta), Some(dep)) => Sem::Dep(Some(Dep { meta: Some(meta), ..dep })),
                    _ => Sem::Dep(None),
                }
            }
            // ImportWhat: "import" ImportFrom "as" BINDING | "import" ImportFrom "as" IDENT
            41 | 42 => {
                next();
                let (path, path_span) = sem!(next(), Sem::From(p, s) => (p, s));
                next();
                let name = next().text();
                Sem::Dep(Some(Dep { path, path_span, name: Some(name), meta: None }))
            }
            // ImportWhat: "include" ImportFrom
            43 => {
                next();
                let (path, path_span) = sem!(next(), Sem::From(p, s) => (p, s));
                Sem::Dep(Some(Dep { path, path_span, name: None, meta: None }))
            }
            // ImportFrom: String
            44 => {
                let s = next().term();
                let span = self.slice(l[0]);
                match konst(&s, self.loc_file) {
                    Some(Const::Str(path)) => Sem::From(path, span),
                    _ => {
                        self.fail(l[0], "Import path must be constant");
                        Sem::From(String::new(), span)
                    }
                }
            }
            // FuncDef: "def" IDENT ':' Query ';'
            45 => {
                next();
                let name = next().text();
                next();
                Sem::Def(Def::new(name, Vec::new(), next().term()))
            }
            // FuncDef: "def" IDENT '(' Params ')' ':' Query ';'
            46 => {
                next();
                let name = next().text();
                next();
                let args = sem!(next(), Sem::Params(p) => p);
                skip!(2);
                Sem::Def(Def::new(name, args, next().term()))
            }
            // Params: Param
            47 => Sem::Params(Vec::from([next().text()])),
            // Params: Params ';' Param
            48 => {
                let mut ps = sem!(next(), Sem::Params(p) => p);
                next();
                ps.push(next().text());
                Sem::Params(ps)
            }
            // Param: BINDING | IDENT
            49 | 50 => next(),
            // StringStart: FORMAT QQSTRING_START
            51 => Sem::Fmt(Some(next().text())),
            // StringStart: QQSTRING_START
            52 => Sem::Fmt(None),
            // String: StringStart QQString QQSTRING_END
            53 => {
                let fmt = sem!(next(), Sem::Fmt(f) => f);
                let parts = sem!(next(), Sem::Parts(p) => p);
                Sem::Term(Term::Str(fmt, parts))
            }
            // QQString: %empty
            54 => Sem::Parts(Vec::new()),
            // QQString: QQString QQSTRING_TEXT
            55 => {
                let mut parts = sem!(next(), Sem::Parts(p) => p);
                match next() {
                    Sem::Text(s) => parts.push(StrPart::Str(s)),
                    Sem::Chars(cs) => parts.extend(cs.into_iter().map(StrPart::Char)),
                    _ => {}
                }
                Sem::Parts(parts)
            }
            // QQString: QQString QQSTRING_INTERP_START Query QQSTRING_INTERP_END
            56 => {
                let mut parts = sem!(next(), Sem::Parts(p) => p);
                next();
                parts.push(StrPart::Term(next().term()));
                Sem::Parts(parts)
            }
            // ElseBody: "elif" Query "then" Query ElseBody
            57 => {
                next();
                let if_ = next().term();
                next();
                let then = next().term();
                let (mut its, else_) = sem!(next(), Sem::Else(its, e) => (its, e));
                its.insert(0, (if_, then));
                Sem::Else(its, else_)
            }
            // ElseBody: "else" Query "end"
            58 => {
                next();
                Sem::Else(Vec::new(), Some(next().term()))
            }
            // ElseBody: "end"
            59 => Sem::Else(Vec::new(), None),
            // Term: '.'
            60 => Sem::Term(Term::Id),
            // Term: ".."
            61 => Sem::Term(Term::Recurse),
            // Term: "break" BINDING
            62 => Sem::Term(Term::Break(self.slice(loc))),
            // Term: "break" error
            63 => {
                self.fail(loc, "break requires a label to break to");
                Sem::Term(Term::Id)
            }
            // Term: Term FIELD '?' | Term FIELD
            64 | 68 => {
                let t = next().term();
                let k = Term::from_str(next().text());
                Sem::Term(t.path(Part::Index(k), if rule == 64 { optional } else { essential }))
            }
            // Term: FIELD '?' | FIELD
            65 | 69 => {
                let k = Term::from_str(next().text());
                Sem::Term(Term::Id.path(Part::Index(k), if rule == 65 { optional } else { essential }))
            }
            // Term: Term '.' String '?' | Term '.' String
            66 | 70 => idx(&mut next, if rule == 66 { optional } else { essential }, false),
            // Term: '.' String '?' | '.' String
            67 | 71 => {
                next();
                let k = next().term();
                Sem::Term(Term::Id.path(Part::Index(k), if rule == 67 { optional } else { essential }))
            }
            // Term: '.' error | '.' IDENT error
            72 | 73 => {
                self.fail(loc, "try .[\"field\"] instead of .field for unusually named fields");
                Sem::Term(Term::Id)
            }
            // Term: Term '[' Query ']' '?' | Term '[' Query ']'
            74 | 75 => idx(&mut next, if rule == 74 { optional } else { essential }, false),
            // Term: Term '.' '[' Query ']' '?' | Term '.' '[' Query ']'
            76 | 77 => idx(&mut next, if rule == 76 { optional } else { essential }, true),
            // Term: Term '[' ']' '?' | Term '[' ']'
            78 => iter(&mut next, optional),
            79 => iter(&mut next, essential),
            // Term: Term '.' '[' ']' '?' | Term '.' '[' ']'
            80 => iter(&mut next, optional),
            81 => iter(&mut next, essential),
            // Term: Term '[' Query ':' Query ']' ['?']
            82 => slice(&mut next, true, true, optional),
            85 => slice(&mut next, true, true, essential),
            // Term: Term '[' Query ':' ']' ['?']
            83 => slice(&mut next, true, false, optional),
            86 => slice(&mut next, true, false, essential),
            // Term: Term '[' ':' Query ']' ['?']
            84 | 87 => {
                let t = next().term();
                skip!(2);
                let upto = next().term();
                let opt = if rule == 84 { optional } else { essential };
                Sem::Term(t.path(Part::Range(None, Some(upto)), opt))
            }
            // Term: Term '?'
            88 => Sem::Term(Term::TryCatch(Box::new(next().term()), None)),
            // Term: LITERAL
            89 => Sem::Term(Term::Num(next().text())),
            // Term: String
            90 => next(),
            // Term: FORMAT
            91 => Sem::Term(Term::Call(next().text(), Vec::new())),
            // Term: '-' Term
            92 => {
                next();
                Sem::Term(Term::Neg(Box::new(next().term())))
            }
            // Term: '(' Query ')'
            93 => {
                next();
                next()
            }
            // Term: '[' Query ']'
            94 => {
                next();
                Sem::Term(Term::Arr(Some(Box::new(next().term()))))
            }
            // Term: '[' ']'
            95 => Sem::Term(Term::Arr(None)),
            // Term: '{' DictPairs '}'
            96 => {
                next();
                Sem::Term(Term::Obj(sem!(next(), Sem::Pairs(p) => p)))
            }
            // Term: "reduce" Expr "as" Patterns '(' Query ';' Query ')'
            // Term: "foreach" Expr "as" Patterns '(' Query ';' Query [';' Query] ')'
            97 | 98 | 99 => {
                let name = self.slice(l[0]);
                next();
                let xs = next().term();
                next();
                let pats = sem!(next(), Sem::Pats(p) => p);
                next();
                let mut args = Vec::from([next().term()]);
                next();
                args.push(next().term());
                if rule == 98 {
                    next();
                    args.push(next().term());
                }
                Sem::Term(Term::Fold(name, Box::new(xs), pats, args))
            }
            // Term: "if" Query "then" Query ElseBody
            100 => {
                next();
                let if_ = next().term();
                next();
                let then = next().term();
                let (mut its, else_) = sem!(next(), Sem::Else(its, e) => (its, e));
                its.insert(0, (if_, then));
                Sem::Term(Term::IfThenElse(its, else_.map(Box::new)))
            }
            // Term: "if" Query "then" error
            101 => {
                self.fail(loc, "Possibly unterminated 'if' statement");
                Sem::Term(Term::Id)
            }
            // Term: "try" Expr "catch" Expr
            102 => {
                next();
                let t = next().term();
                next();
                Sem::Term(Term::TryCatch(Box::new(t), Some(Box::new(next().term()))))
            }
            // Term: "try" Expr "catch" error
            103 => {
                self.fail(loc, "Possibly unterminated 'try' statement");
                Sem::Term(Term::Id)
            }
            // Term: "try" Expr
            104 => {
                next();
                Sem::Term(Term::TryCatch(Box::new(next().term()), None))
            }
            // Term: '$' '$' '$' BINDING
            105 => {
                skip!(3);
                Sem::Term(Term::Var(next().text()))
            }
            // Term: BINDING
            106 => Sem::Term(Term::Var(next().text())),
            // Term: "$__loc__"
            107 => Sem::Term(Term::Loc(self.line(loc.0))),
            // Term: IDENT
            108 => Sem::Term(match next().text() {
                "true" => Term::Bool(true),
                "false" => Term::Bool(false),
                "null" => Term::Null,
                s => Term::Call(s, Vec::new()),
            }),
            // Term: IDENT '(' Args ')'
            109 => {
                let name = next().text();
                next();
                Sem::Term(Term::Call(name, sem!(next(), Sem::Terms(a) => a)))
            }
            // Term: '(' error ')' | '[' error ']' | '{' error '}'
            110 | 111 | 113 => Sem::Term(Term::Id),
            // Term: Term '[' error ']'
            112 => next(),
            // Args: Arg
            114 => Sem::Terms(Vec::from([next().term()])),
            // Args: Args ';' Arg
            115 => {
                let mut args = sem!(next(), Sem::Terms(a) => a);
                next();
                args.push(next().term());
                Sem::Terms(args)
            }
            // Arg: Query
            116 => next(),
            // RepPatterns: RepPatterns "?//" Pattern | Patterns: RepPatterns "?//" Pattern
            117 | 119 => {
                let mut ps = sem!(next(), Sem::Pats(p) => p);
                next();
                ps.push(next().pat());
                Sem::Pats(ps)
            }
            // RepPatterns: Pattern | Patterns: Pattern
            118 | 120 => Sem::Pats(Vec::from([next().pat()])),
            // Pattern: BINDING
            121 => Sem::Pat(Pattern::Var(next().text())),
            // Pattern: '[' ArrayPats ']'
            122 => {
                next();
                Sem::Pat(Pattern::Arr(sem!(next(), Sem::Pats(p) => p)))
            }
            // Pattern: '{' ObjPats '}'
            123 => {
                next();
                Sem::Pat(Pattern::Obj(sem!(next(), Sem::ObjPats(p) => p)))
            }
            // ArrayPats: Pattern
            124 => Sem::Pats(Vec::from([next().pat()])),
            // ArrayPats: ArrayPats ',' Pattern
            125 => {
                let mut ps = sem!(next(), Sem::Pats(p) => p);
                next();
                ps.push(next().pat());
                Sem::Pats(ps)
            }
            // ObjPats: ObjPat
            126 => next(),
            // ObjPats: ObjPats ',' ObjPat
            127 => {
                let mut ps = sem!(next(), Sem::ObjPats(p) => p);
                next();
                ps.extend(sem!(next(), Sem::ObjPats(p) => p));
                Sem::ObjPats(ps)
            }
            // ObjPat: BINDING
            128 => {
                let x = next().text();
                Sem::ObjPats(Vec::from([(Term::from_str(&x[1..]), Pattern::Var(x))]))
            }
            // ObjPat: BINDING ':' Pattern
            129 => {
                let x = next().text();
                next();
                let p = Pattern::Both(x, Box::new(next().pat()));
                Sem::ObjPats(Vec::from([(Term::from_str(&x[1..]), p)]))
            }
            // ObjPat: IDENT ':' Pattern | Keyword ':' Pattern
            130 | 131 => {
                let k = Term::from_str(next().text());
                next();
                Sem::ObjPats(Vec::from([(k, next().pat())]))
            }
            // ObjPat: String ':' Pattern
            132 => {
                let k = next().term();
                next();
                Sem::ObjPats(Vec::from([(k, next().pat())]))
            }
            // ObjPat: '(' Query ')' ':' Pattern
            133 => {
                next();
                let k = next().term();
                self.check_object_key(&k, l[1]);
                skip!(2);
                Sem::ObjPats(Vec::from([(k, next().pat())]))
            }
            // ObjPat: error ':' Pattern
            134 => {
                self.fail(loc, "May need parentheses around object key expression");
                Sem::ObjPats(Vec::new())
            }
            // Keyword: "as" | "def" | ... | "break"
            135..=152 => Sem::Text(self.slice(loc)),
            // DictPairs: %empty
            153 => Sem::Pairs(Vec::new()),
            // DictPairs: DictPair
            154 => next(),
            // DictPairs: DictPair ',' DictPairs
            155 => {
                let mut ps = sem!(next(), Sem::Pairs(p) => p);
                next();
                ps.extend(sem!(next(), Sem::Pairs(p) => p));
                Sem::Pairs(ps)
            }
            // DictPair: IDENT ':' DictExpr | Keyword ':' DictExpr
            156 | 157 => {
                let k = Term::from_str(next().text());
                next();
                Sem::Pairs(Vec::from([(k, Some(next().term()))]))
            }
            // DictPair: String ':' DictExpr
            158 => {
                let k = next().term();
                next();
                Sem::Pairs(Vec::from([(k, Some(next().term()))]))
            }
            // DictPair: String
            159 => Sem::Pairs(Vec::from([(next().term(), None)])),
            // DictPair: BINDING ':' DictExpr
            160 => {
                let x = next().text();
                next();
                Sem::Pairs(Vec::from([(Term::Var(x), Some(next().term()))]))
            }
            // DictPair: BINDING
            161 => Sem::Pairs(Vec::from([(Term::Var(next().text()), None)])),
            // DictPair: IDENT | Keyword
            162 | 164 => Sem::Pairs(Vec::from([(Term::from_str(next().text()), None)])),
            // DictPair: "$__loc__"
            163 => {
                let loc = Term::Loc(self.line(loc.0));
                Sem::Pairs(Vec::from([(Term::from_str("__loc__"), Some(loc))]))
            }
            // DictPair: '(' Query ')' ':' DictExpr
            165 => {
                next();
                let k = next().term();
                self.check_object_key(&k, l[1]);
                skip!(2);
                Sem::Pairs(Vec::from([(k, Some(next().term()))]))
            }
            // DictPair: error ':' DictExpr
            166 => {
                self.fail(l[0], "May need parentheses around object key expression");
                Sem::Pairs(Vec::new())
            }
            // DictExpr: DictExpr '|' DictExpr
            167 => bin(&mut next, Pipe(None)),
            // DictExpr: Expr
            168 => next(),
            _ => Sem::None,
        }
    }
}

impl<'s> Default for Sem<'s> {
    fn default() -> Self {
        Sem::None
    }
}

/// Parse a jq program or module, as `jq_parse`.
///
/// `loc_file` is the file name that `$__loc__` reports in constants.
/// If `fmt_defs` is true, then formats can be defined like filters (`def @x: ...`),
/// as jaq's prelude does.
pub fn parse_module<'s>(
    code: &'s str,
    loc_file: &'s str,
    fmt_defs: bool,
) -> core::result::Result<Module<&'s str, Body<&'s str>>, Vec<Error>> {
    let lexer = Lexer::new(code);
    let lexer = if fmt_defs { lexer.with_fmt_defs() } else { lexer };
    let mut yacc = Yacc { lexer, code, loc_file, errs: Vec::new() };
    let m = yacc.run();
    match m {
        Some(m) if yacc.errs.is_empty() => Ok(m),
        _ => Err(yacc.errs),
    }
}

/// Parse error that stores what token it found.
pub type TError<'t, S> = (Error, PhantomData<&'t S>);

/// Output of a fallible parsing operation.
pub type Result<'s, 't, T> = core::result::Result<T, TError<'t, &'s str>>;

/// Parser for jq programs.
pub struct Parser<'s, 't> {
    code: &'s str,
    t: PhantomData<&'t ()>,
}

impl<'s, 't> Parser<'s, 't> {
    /// Initialise a new parser on the given code.
    #[must_use]
    pub fn new(code: &'s str) -> Self {
        Self { code, t: PhantomData }
    }

    /// Parse a sequence of definitions, such as `def x: 1; def y: 2;`,
    /// where formats can be defined like filters (`def @x: ...`).
    pub fn defs(&mut self) -> Result<'s, 't, Vec<Def<&'s str>>> {
        let first = |errs: Vec<Error>| (errs.into_iter().next().unwrap_or_default(), PhantomData);
        let m = parse_module(self.code, "<builtin>", true).map_err(first)?;
        match m.body {
            Body::Defs(defs) if m.deps.is_empty() => Ok(defs),
            _ => Err((("expected definitions".into(), None), PhantomData)),
        }
    }

    /// Parse a term such as `.[] | .+1`.
    pub fn term(&mut self) -> Result<'s, 't, Term<&'s str>> {
        let first = |errs: Vec<Error>| (errs.into_iter().next().unwrap_or_default(), PhantomData);
        let m = parse_module(self.code, "<top-level>", false).map_err(first)?;
        match m.body {
            Body::Main(t) if m.deps.is_empty() => Ok(t),
            _ => Err((("expected a term".into(), None), PhantomData)),
        }
    }

    /// Parse with the given function, returning the errors if it fails.
    pub fn parse<T, F>(mut self, f: F) -> core::result::Result<T, Vec<TError<'t, &'s str>>>
    where
        F: FnOnce(&mut Self) -> Result<'s, 't, T>,
    {
        f(&mut self).map_err(|e| Vec::from([e]))
    }
}
