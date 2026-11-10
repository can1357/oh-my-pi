//! Parsing.

use super::lex::{StrPart, Tok, Token};
use super::path::{self, Path};
use super::{ops, prec_climb};
use alloc::{boxed::Box, vec::Vec};
use core::fmt::{self, Debug};

/// Parse error, storing what we expected and what we got instead.
pub type Error<S, T = S> = (Expect<S>, T);
/// Parse error that stores what token it found.
pub type TError<'t, S> = Error<S, Option<&'t Token<S>>>;

/// Type of token that we expected.
///
/// Each variant is annoted with jq programs that trigger it.
#[derive(Debug)]
#[non_exhaustive]
pub enum Expect<S> {
    /// `if 0` (expected "then"), `reduce .` (expected "as"),
    /// `0 as $x` (expected "|"), `{(.)}` (expected ":")
    Just(S),
    /// `label`, `break`
    Var,
    /// `0 as`
    Pattern,
    /// `if 0 then 0`
    ElseOrEnd,
    /// `0 as [$x;]`
    CommaOrRBrack,
    /// `{a;}`
    CommaOrRBrace,
    /// `f(0:)`
    SemicolonOrRParen,
    /// `` (empty input), `-`, `()`
    Term,
    /// `.[].`
    Key,
    /// `def`, `import "foo" as`
    Ident,
    /// `def f()`
    Arg,
    /// `import`
    Str,
    /// `0;`
    Nothing,
}

impl<'a> Expect<&'a str> {
    /// String representation of an expected token.
    pub fn as_str(&self) -> &'a str {
        match self {
            Self::Just(s) => s,
            Self::Var => "variable",
            Self::Pattern => "pattern",
            Self::ElseOrEnd => "else or end",
            Self::CommaOrRBrack => "comma or right bracket",
            Self::CommaOrRBrace => "comma or right brace",
            Self::SemicolonOrRParen => "semicolon or right parenthesis",
            Self::Term => "term",
            Self::Key => "key",
            Self::Ident => "identifier",
            Self::Arg => "argument",
            Self::Str => "string",
            Self::Nothing => "nothing",
        }
    }
}

/// Output of a fallible parsing operation.
pub type Result<'s, 't, T> = core::result::Result<T, TError<'t, &'s str>>;

/// Parser for jq programs.
pub struct Parser<'s, 't> {
    i: core::slice::Iter<'t, Token<&'s str>>,
    e: Vec<TError<'t, &'s str>>,
}

/// Function from value to stream of values, such as `.[] | add / length`.
#[derive(Clone, Debug, Default)]
pub enum Term<S> {
    /// Identity, i.e. `.`
    #[default]
    Id,
    /// Recursion (`..`)
    Recurse,

    /// Integer or floating-point number
    Num(S),
    /// String
    ///
    /// This consists of an optional format filter starting with `@` (such as `@text`),
    /// followed by quoted string parts (such as `"Hello, \(.name)! \u263A"`).
    Str(Option<S>, Vec<StrPart<S, Self>>),
    /// Array, empty if `None`
    Arr(Option<Box<Self>>),
    /// Object, specifying its key-value pairs
    Obj(Vec<(Self, Option<Self>)>),

    /// Negation
    Neg(Box<Self>),

    /// Sequence of binary operations, e.g. `1 + 2 - 3 * 4`
    BinOp(Box<Self>, BinaryOp<S>, Box<Self>),

    /// Control flow variable declaration, e.g. `label $x | ...`
    Label(S, Box<Self>),
    /// Break out from control flow to location variable, e.g. `break $x`
    Break(S),

    /// `reduce` and `foreach`, e.g. `reduce .[] as $x (0; .+$x)`
    Fold(S, Box<Self>, Pattern<S>, Vec<Self>),
    /// `try` and optional `catch`
    TryCatch(Box<Self>, Option<Box<Self>>),
    /// If-then-else
    IfThenElse(Vec<(Self, Self)>, Option<Box<Self>>),

    /// Local definition
    Def(Vec<Def<S, Self>>, Box<Self>),
    /// Call to another filter, e.g. `map(.+1)`
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
}

/// Binary operators, such as `|`, `,`, `//`, ...
#[derive(Clone, Debug)]
pub enum BinaryOp<S> {
    /// Application, i.e. `l | r` if no string is given, else `l as $x | r`
    Pipe(Option<Pattern<S>>),
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
    /// (this is identical to `r as $x | l |= . + $x`, ...)
    UpdateMath(ops::Math),
    /// `l //= r`
    UpdateAlt,
}

impl<S> Term<S> {
    #[cfg(feature = "std")]
    pub(crate) fn as_str(&self) -> Option<&S> {
        if let Term::Str(None, s) = self {
            if let [StrPart::Str(s)] = &s[..] {
                return Some(s);
            }
        }
        None
    }

    pub(crate) fn from_str(s: S) -> Self {
        Self::Str(None, [StrPart::Str(s)].into())
    }

    /// `{}[]` returns zero values.
    pub(crate) fn empty() -> Self {
        // `[]`
        let path = (path::Part::Range(None, None), path::Opt::Essential);
        // `{}`
        let obj = Term::Obj(Vec::new());
        // `{}[]`
        Term::Path(obj.into(), Path(Vec::from([path])))
    }

    /// Perform precedence climbing of a term followed by operator-term pairs.
    ///
    /// Ensures that `... as $x | ...` is handled like `... as $x | (...)`.
    fn climb(self, tail: &mut impl Iterator<Item = (BinaryOp<S>, Self)>) -> Self {
        let tail = core::iter::from_fn(|| {
            tail.next().map(|(op, tm)| match op {
                BinaryOp::Pipe(Some(_)) => (op, tm.climb(tail)),
                _ => (op, tm),
            })
        });
        prec_climb::climb(self, tail)
    }
}

impl<S> Pattern<S> {
    pub(crate) fn vars(&self) -> Box<dyn Iterator<Item = &S> + '_> {
        match self {
            Pattern::Var(x) => Box::new(core::iter::once(x)),
            Pattern::Arr(a) => Box::new(a.iter().flat_map(|p| p.vars())),
            Pattern::Obj(o) => Box::new(o.iter().flat_map(|(_k, p)| p.vars())),
        }
    }
}

impl<'s, 't> Parser<'s, 't> {
    /// Initialise a new parser on a sequence of [`Token`]s.
    #[must_use]
    pub fn new(i: &'t [Token<&'s str>]) -> Self {
        Self {
            i: i.iter(),
            e: Vec::new(),
        }
    }

    /// Parse tokens with the given function.
    ///
    /// Returns [`Ok`] if the function consumes the whole output without producing any error.
    pub fn parse<T: Default, F>(mut self, f: F) -> core::result::Result<T, Vec<TError<'t, &'s str>>>
    where
        F: FnOnce(&mut Self) -> Result<'s, 't, T>,
    {
        let y = self.finish("", f);
        if self.e.is_empty() {
            Ok(y)
        } else {
            Err(self.e)
        }
    }

    /// Verifies that the remaining input tokens correspond to the given string.
    fn verify_last(&mut self, last: &'static str) -> Result<'s, 't, ()> {
        match (self.i.as_slice(), last) {
            ([], "") => Ok(()),
            ([Token(c, _)], last) if *c == last => Ok(()),
            ([], _) => Err((Expect::Just(last), None)),
            ([next, ..], "") => Err((Expect::Nothing, Some(next))),
            ([next, ..], _) => Err((Expect::Just(last), Some(next))),
        }
    }

    /// Run given parse function with given tokens, then reset tokens to previous tokens.
    fn with_tok<T>(&mut self, tokens: &'t [Token<&'s str>], f: impl FnOnce(&mut Self) -> T) -> T {
        let i = core::mem::replace(&mut self.i, tokens.iter());
        let y = f(self);
        self.i = i;
        y
    }

    /// Parse with given function, then
    /// ensure that remaining input tokens correspond to `last`, and
    /// return default if any error occurred.
    fn finish<T: Default, F>(&mut self, last: &'static str, f: F) -> T
    where
        F: FnOnce(&mut Self) -> Result<'s, 't, T>,
    {
        f(self)
            .and_then(|y| {
                self.verify_last(last)?;
                Ok(y)
            })
            .unwrap_or_else(|e| {
                self.e.push(e);
                T::default()
            })
    }

    fn with<T: Default, F>(&mut self, tokens: &'t [Token<&'s str>], last: &'static str, f: F) -> T
    where
        F: FnOnce(&mut Self) -> Result<'s, 't, T>,
    {
        self.with_tok(tokens, |p| p.finish(last, f))
    }

    /// Parse with the given function, and rewind input if it returns `None`.
    fn maybe<T>(&mut self, f: impl Fn(&mut Self) -> Option<T>) -> Option<T> {
        let i = self.i.clone();
        let y = f(self);
        // rewind to previous state in case of non-match
        if y.is_none() {
            self.i = i;
        }
        y
    }

    /// Parse with the given function, and rewind input if it returns `Ok(None)`.
    fn try_maybe<T, F>(&mut self, f: F) -> Result<'s, 't, Option<T>>
    where
        F: Fn(&mut Self) -> Result<'s, 't, Option<T>>,
    {
        let i = self.i.clone();
        let y = f(self)?;
        // rewind to previous state in case of non-match
        if y.is_none() {
            self.i = i;
        }
        Ok(y)
    }

    fn many1<T>(
        &mut self,
        f: impl Fn(&mut Self) -> Result<'s, 't, T>,
        sep: &'s str,
        allow_trailing_sep: bool,
        last: &'s str,
        expect: Expect<&'s str>,
    ) -> Result<'s, 't, Vec<T>> {
        let mut y = Vec::from([f(self)?]);
        let get_last = |p: &mut Self| p.i.next().filter(|Token(s, _)| *s == last);
        let next_last = |p: &mut Self| allow_trailing_sep && p.maybe(get_last).is_some();
        loop {
            match self.i.next() {
                Some(Token(s, _)) if *s == last => break,
                Some(Token(s, _)) if *s == sep && next_last(self) => break,
                Some(Token(s, _)) if *s == sep => y.push(f(self)?),
                next => return Err((expect, next)),
            }
        }
        Ok(y)
    }

    /// Parse sequence of shape `f ("," f)* ","? "}"`.
    fn obj_items<T, F>(&mut self, f: F) -> Result<'s, 't, Vec<T>>
    where
        F: Fn(&mut Self) -> Result<'s, 't, T>,
    {
        self.many1(f, ",", true, "}", Expect::CommaOrRBrace)
    }

    /// Parse `("(" arg (";" arg)* ")")?`.
    fn args<T>(&mut self, f: fn(&mut Self) -> Result<'s, 't, T>) -> Vec<T> {
        self.maybe(|p| match p.i.next() {
            Some(Token(full, Tok::Block(tokens))) if full.starts_with('(') => {
                Some(p.with(tokens, "", |p| {
                    p.many1(f, ";", false, ")", Expect::SemicolonOrRParen)
                }))
            }
            _ => None,
        })
        .unwrap_or_default()
    }

    /// Parse a binary operator, including `,` if `with_comma` is true.
    fn op(&mut self, with_comma: bool) -> Result<'s, 't, Option<BinaryOp<&'s str>>> {
        use ops::{Cmp, Math};
        self.try_maybe(|p| match p.i.next() {
            Some(Token(s, _)) => Ok(Some(match *s {
                "|" => BinaryOp::Pipe(None),
                "as" => {
                    let x = p.pattern()?;
                    p.just("|")?;
                    BinaryOp::Pipe(Some(x))
                }
                "," if with_comma => BinaryOp::Comma,
                "+" => BinaryOp::Math(Math::Add),
                "-" => BinaryOp::Math(Math::Sub),
                "*" => BinaryOp::Math(Math::Mul),
                "/" => BinaryOp::Math(Math::Div),
                "%" => BinaryOp::Math(Math::Rem),
                "=" => BinaryOp::Assign,
                "|=" => BinaryOp::Update,
                "+=" => BinaryOp::UpdateMath(Math::Add),
                "-=" => BinaryOp::UpdateMath(Math::Sub),
                "*=" => BinaryOp::UpdateMath(Math::Mul),
                "/=" => BinaryOp::UpdateMath(Math::Div),
                "%=" => BinaryOp::UpdateMath(Math::Rem),
                "<" => BinaryOp::Cmp(Cmp::Lt),
                ">" => BinaryOp::Cmp(Cmp::Gt),
                "<=" => BinaryOp::Cmp(Cmp::Le),
                ">=" => BinaryOp::Cmp(Cmp::Ge),
                "==" => BinaryOp::Cmp(Cmp::Eq),
                "!=" => BinaryOp::Cmp(Cmp::Ne),
                "//" => BinaryOp::Alt,
                "//=" => BinaryOp::UpdateAlt,
                "or" => BinaryOp::Or,
                "and" => BinaryOp::And,
                _ => return Ok(None),
            })),
            None => Ok(None),
        })
    }

    /// If the next token corresponds to `c`, return its string and advance input.
    fn char0(&mut self, c: char) -> Option<&'s str> {
        self.maybe(|p| match p.i.next() {
            Some(Token(s, _)) if s.chars().eq([c]) => Some(*s),
            _ => None,
        })
    }

    /// If the next token starts with `.`, but is not `..`,
    /// return the string after the initial `.` and advance input.
    ///
    /// This matches `.` and `.key`, where `key` is any valid identifier that matches
    /// `[a-zA-Z_][a-zA-Z0-9_]*`.
    fn dot(&mut self) -> Option<&'s str> {
        self.maybe(|p| match p.i.next() {
            Some(Token(c, _)) if *c != ".." => c.strip_prefix('.'),
            _ => None,
        })
    }

    fn terminated<T, F>(&mut self, f: F) -> Result<'s, 't, T>
    where
        F: FnOnce(&mut Self) -> Result<'s, 't, T>,
    {
        let y = f(self)?;
        self.just(";")?;
        Ok(y)
    }

    fn just(&mut self, c: &'static str) -> Result<'s, 't, &'s str> {
        match self.i.next() {
            Some(Token(s, _)) if *s == c => Ok(*s),
            next => Err((Expect::Just(c), next)),
        }
    }

    fn var(&mut self) -> Result<'s, 't, &'s str> {
        match self.i.next() {
            Some(Token(x, Tok::Var)) => Ok(*x),
            next => Err((Expect::Var, next)),
        }
    }

    fn pattern(&mut self) -> Result<'s, 't, Pattern<&'s str>> {
        match self.i.next() {
            Some(Token(x, Tok::Var)) => Ok(Pattern::Var(*x)),
            next @ Some(Token(full, Tok::Block(tokens))) => match &full[..1] {
                "[" => Ok(Pattern::Arr(self.with(tokens, "", |p| {
                    p.many1(Self::pattern, ",", false, "]", Expect::CommaOrRBrack)
                }))),
                "{" => Ok(Pattern::Obj(
                    self.with(tokens, "", |p| p.obj_items(Self::pat_obj_entry)),
                )),
                _ => Err((Expect::Pattern, next)),
            },
            next => Err((Expect::Pattern, next)),
        }
    }

    /// Parse a term.
    ///
    /// Only if `with_comma` is true, the parsed term may be of the shape `t, u`.
    /// This matters for the parsing of object values, such as `{k1: v1, k2: v2}`:
    /// if we would permit terms of the shape `t, u` inside objects,
    /// then this would be parsed like `{k1: (v1, k2): v2}`, which is invalid.
    fn term_with_comma(&mut self, with_comma: bool) -> Result<'s, 't, Term<&'s str>> {
        let head = self.atom()?;
        let mut tail = Vec::new();
        while let Some(op) = self.op(with_comma)? {
            tail.push((op, self.atom()?))
        }
        Ok(head.climb(&mut tail.into_iter()))
    }

    /// Parse an atomic term.
    ///
    /// A term `t` is atomic if and only if `try t catch 0` is syntactically correct.
    /// For example, the term `1 + 2` is not atomic, because `try 1 + 2 catch 0` is invalid.
    /// However, the term `.[]` is atomic, because `try .[] catch 0` is valid.
    fn atom(&mut self) -> Result<'s, 't, Term<&'s str>> {
        let tm = match self.i.next() {
            Some(Token("-", _)) => Term::Neg(Box::new(self.atom()?)),
            Some(Token("def", _)) => {
                let head = self.def_tail()?;
                let tail = self.defs()?;
                let tm = self.term()?;
                Term::Def(core::iter::once(head).chain(tail).collect(), Box::new(tm))
            }
            Some(Token("if", _)) => {
                let if_then = |p: &mut Self| -> Result<_> {
                    let if_ = p.term()?;
                    p.just("then")?;
                    Ok((if_, p.term()?))
                };
                let mut if_thens = Vec::from([if_then(self)?]);
                let else_ = loop {
                    match self.i.next() {
                        Some(Token("elif", _)) => if_thens.push(if_then(self)?),
                        Some(Token("else", _)) => {
                            let else_ = self.term()?;
                            self.just("end")?;
                            break Some(else_);
                        }
                        Some(Token("end", _)) => break None,
                        next => return Err((Expect::ElseOrEnd, next)),
                    }
                };
                Term::IfThenElse(if_thens, else_.map(Box::new))
            }
            Some(Token("try", _)) => {
                let try_ = self.atom()?;
                let catch = self.try_maybe(|p| match p.i.next() {
                    Some(Token("catch", _)) => Ok(Some(p.atom()?)),
                    _ => Ok(None),
                })?;
                Term::TryCatch(Box::new(try_), catch.map(Box::new))
            }
            Some(Token("label", _)) => {
                let x = self.var()?;
                self.just("|")?;
                let tm = self.term()?;
                Term::Label(x, Box::new(tm))
            }
            Some(Token("break", _)) => Term::Break(self.var()?),
            Some(Token(fold @ ("reduce" | "foreach"), _)) => {
                let xs = self.atom()?;
                self.just("as")?;
                let x = self.pattern()?;
                let args = self.args(Self::term);
                Term::Fold(*fold, Box::new(xs), x, args)
            }
            Some(Token(id, Tok::Var)) => Term::Var(*id),
            Some(Token(id, Tok::Fmt)) => {
                let s = self.maybe(|p| match p.i.next() {
                    Some(Token(_, Tok::Str(parts))) => Some(p.str_parts(parts)),
                    _ => None,
                });
                match s {
                    None => Term::Call(*id, self.args(Self::term)),
                    Some(parts) => Term::Str(Some(*id), parts),
                }
            }
            Some(Token(id, Tok::Word)) => Term::Call(*id, self.args(Self::term)),
            Some(Token("..", _)) => Term::Recurse,
            Some(Token(c, Tok::Sym)) if c.starts_with('.') => {
                let key = if c.len() > 1 {
                    Some(Term::from_str(&c[1..]))
                } else {
                    // TODO: this returns None on things like "@json .",
                    // whereas it should return an error instead
                    self.maybe(|p| p.str_key().ok())
                };

                if let Some(key) = key {
                    let head = (path::Part::Index(key), self.opt());
                    let path = core::iter::once(head).chain(self.path()?.0).collect();
                    Term::Path(Box::new(Term::Id), Path(path))
                } else {
                    Term::Id
                }
            }
            Some(Token(n, Tok::Num)) => Term::Num(*n),
            Some(Token(full, Tok::Block(tokens))) => match &full[..1] {
                "[" if matches!(tokens[..], [Token("]", _)]) => Term::Arr(None),
                "{" if matches!(tokens[..], [Token("}", _)]) => Term::Obj(Vec::new()),
                "[" => Term::Arr(Some(Box::new(self.with(tokens, "]", Self::term)))),
                "{" => self.with(tokens, "", |p| p.obj_items(Self::obj_entry).map(Term::Obj)),
                "(" => self.with(tokens, ")", Self::term),
                _ => panic!(),
            },
            Some(Token(_, Tok::Str(parts))) => Term::Str(None, self.str_parts(parts)),
            next => return Err((Expect::Term, next)),
        };

        let tm = match self.opt() {
            path::Opt::Optional => Term::TryCatch(Box::new(tm), None),
            path::Opt::Essential => tm,
        };

        let path = self.path()?;
        Ok(if path.0.is_empty() {
            tm
        } else {
            Term::Path(Box::new(tm), path)
        })
    }

    /// Parse a term such as `.[] | .+1`.
    pub fn term(&mut self) -> Result<'s, 't, Term<&'s str>> {
        self.term_with_comma(true)
    }

    /// Parse a pattern object entry.
    ///
    /// Examples:
    ///
    /// * `$x`
    /// * `(f): pat`
    /// * ` a : pat`
    /// * `"a": pat`
    fn pat_obj_entry(&mut self) -> Result<'s, 't, (Term<&'s str>, Pattern<&'s str>)> {
        let i = self.i.clone();
        let key = match self.i.next() {
            Some(Token(x, Tok::Var)) => return Ok((Term::from_str(&x[1..]), Pattern::Var(x))),
            Some(Token(full, Tok::Block(tokens))) if full.starts_with('(') => {
                self.with(tokens, ")", Self::term)
            }
            Some(Token(id, Tok::Word)) if !id.contains("::") => Term::from_str(*id),
            _ => {
                self.i = i;
                self.str_key()?
            }
        };
        self.just(":")?;
        Ok((key, self.pattern()?))
    }

    /// Parse an object entry.
    ///
    /// An object is written as `{e1, ..., en}`, where `ei` is an object entry.
    /// An example of an object entry is `"key": value` or `(key): value`.
    /// When the key is a term surrounded by parentheses, a value is required,
    /// otherwise the value may be omitted (e.g. `"key"` or `$x`).
    fn obj_entry(&mut self) -> Result<'s, 't, (Term<&'s str>, Option<Term<&'s str>>)> {
        let i = self.i.clone();
        let key = match self.i.next() {
            Some(Token(full, Tok::Block(tokens))) if full.starts_with('(') => {
                let k = self.with(tokens, ")", Self::term);
                self.just(":")?;
                return Ok((k, Some(self.term_with_comma(false)?)));
            }
            Some(Token(id, Tok::Var)) => Term::Var(*id),
            Some(Token(id, Tok::Word)) if !id.contains("::") => Term::from_str(*id),
            _ => {
                self.i = i;
                self.str_key()?
            }
        };
        let v = self.char0(':').map(|_| self.term_with_comma(false));
        Ok((key, v.transpose()?))
    }

    fn str_parts(
        &mut self,
        parts: &'t [StrPart<&'s str, Token<&'s str>>],
    ) -> Vec<StrPart<&'s str, Term<&'s str>>> {
        let parts = parts.iter().map(|part| match part {
            StrPart::Str(s) => StrPart::Str(*s),
            StrPart::Term(Token(full, Tok::Block(tokens))) if full.starts_with('(') => {
                StrPart::Term(self.with(tokens, ")", Self::term))
            }
            StrPart::Term(_) => unreachable!(),
            StrPart::Char(c) => StrPart::Char(*c),
        });
        parts.collect()
    }

    fn path(&mut self) -> Result<'s, 't, Path<Term<&'s str>>> {
        let mut path: Vec<_> = core::iter::from_fn(|| self.path_part_opt()).collect();
        while let Some(key) = self.dot() {
            path.push(if key.is_empty() {
                match self.path_part_opt() {
                    Some(part_opt) => part_opt,
                    None => (path::Part::Index(self.str_key()?), self.opt()),
                }
            } else {
                (path::Part::Index(Term::from_str(key)), self.opt())
            });

            path.extend(core::iter::from_fn(|| self.path_part_opt()));
        }
        Ok(Path(path))
    }

    /// Parse `[]`, `[t]`, `[t:]`, `[t:t]`, `[:t]` (all without brackets).
    fn path_part(&mut self) -> Result<'s, 't, path::Part<Term<&'s str>>> {
        use path::Part::{Index, Range};
        let done = |p: &Self| matches!(p.i.as_slice(), [Token("]", _)]);
        Ok(if done(self) {
            Range(None, None)
        } else if self.char0(':').is_some() {
            Range(None, Some(self.term()?))
        } else {
            let tm = self.term()?;
            if self.char0(':').is_some() {
                if done(self) {
                    Range(Some(tm), None)
                } else {
                    Range(Some(tm), Some(self.term()?))
                }
            } else {
                Index(tm)
            }
        })
    }

    fn path_part_opt(&mut self) -> Option<(path::Part<Term<&'s str>>, path::Opt)> {
        let part = self.maybe(|p| match p.i.next() {
            Some(Token(full, Tok::Block(tokens))) if full.starts_with('[') => {
                Some(p.with(tokens, "]", Self::path_part))
            }
            _ => None,
        })?;
        Some((part, self.opt()))
    }

    fn str_key(&mut self) -> Result<'s, 't, Term<&'s str>> {
        match self.i.next() {
            Some(Token(id, Tok::Fmt)) => match self.i.next() {
                Some(Token(_, Tok::Str(parts))) => Ok(Term::Str(Some(*id), self.str_parts(parts))),
                next => Err((Expect::Str, next)),
            },
            Some(Token(_, Tok::Str(parts))) => Ok(Term::Str(None, self.str_parts(parts))),
            next => Err((Expect::Key, next)),
        }
    }

    fn opt(&mut self) -> path::Opt {
        let mut opt = path::Opt::Essential;
        while self.char0('?').is_some() {
            opt = path::Opt::Optional;
        }
        opt
    }

    /// Parse a sequence of definitions, such as `def x: 1; def y: 2;`.
    pub fn defs(&mut self) -> Result<'s, 't, Vec<Def<&'s str>>> {
        let head = |p: &mut Self| p.just("def").ok();
        core::iter::from_fn(|| self.maybe(head).map(|_| self.def_tail())).collect()
    }

    /// Parse `name args ":" term ";"`.
    fn def_tail(&mut self) -> Result<'s, 't, Def<&'s str, Term<&'s str>>> {
        let name = match self.i.next() {
            Some(Token(w, Tok::Word | Tok::Fmt)) if !w.contains("::") => w,
            next => return Err((Expect::Ident, next)),
        };
        let args = self.args(|p| match p.i.next() {
            Some(Token(w, Tok::Word | Tok::Var)) if !w.contains("::") => Ok(*w),
            next => Err((Expect::Arg, next)),
        });
        self.just(":")?;

        let body = self.term()?;
        self.just(";")?;

        Ok(Def { name, args, body })
    }

    fn bare_str(&mut self) -> Result<'s, 't, &'s str> {
        match self.i.next() {
            next @ Some(Token(_, Tok::Str(parts))) => match parts[..] {
                [StrPart::Str(s)] => Ok(s),
                _ => Err((Expect::Str, next)),
            },
            next => Err((Expect::Str, next)),
        }
    }

    /// Parse what comes after an include / import.
    fn dep(&mut self, import: bool) -> Result<'s, 't, Dep<&'s str>> {
        let path = self.bare_str()?;
        let name = import.then(|| {
            self.just("as")?;
            match self.i.next() {
                Some(Token(v, Tok::Word | Tok::Var)) => Ok(*v),
                next => Err((Expect::Ident, next)),
            }
        });
        let name = name.transpose()?;
        let meta = !matches!(self.i.as_slice(), [Token(";", _), ..]);
        let meta = meta.then(|| self.term()).transpose()?;
        Ok((path, name, meta))
    }

    /// Parse a module with a body returned by the given function.
    pub(crate) fn module<B, F>(&mut self, f: F) -> Result<'s, 't, Module<&'s str, B>>
    where
        F: FnOnce(&mut Self) -> Result<'s, 't, B>,
    {
        let meta = self
            .maybe(|p| match p.i.next() {
                Some(Token("module", _)) => Some(p.terminated(Self::term)),
                _ => None,
            })
            .transpose()?;

        let deps = core::iter::from_fn(|| {
            self.maybe(|p| match p.i.next() {
                Some(Token("include", _)) => Some(p.terminated(|p| p.dep(false))),
                Some(Token("import", _)) => Some(p.terminated(|p| p.dep(true))),
                _ => None,
            })
        })
        .collect::<Result<_>>()?;

        let body = f(self)?;

        Ok(Module { meta, deps, body })
    }
}

type Dep<S> = (S, Option<S>, Option<Term<S>>);

/// jq module, consisting of metadata, imports/includes, and a body.
///
/// Example (where the body is a sequence of definitions):
///
/// ~~~ jq
/// module {};
///
/// import "foo" as foo;
/// include "bar";
///
/// def iter: .[];
/// ~~~
#[derive(Debug, Default)]
pub(crate) struct Module<S, B> {
    pub meta: Option<Term<S>>,
    pub deps: Vec<Dep<S>>,
    pub body: B,
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
///
/// This is required for Haskell's
/// [`Read`](<https://hackage.haskell.org/package/base/docs/Text-Read.html>)
/// class to deserialise definitions.
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

impl<S> prec_climb::Op for BinaryOp<S> {
    fn precedence(&self) -> usize {
        use ops::{Cmp, Math};
        match self {
            Self::Pipe(None) => 0,
            Self::Comma => 1,
            Self::Pipe(Some(_)) => 2,
            Self::Assign | Self::Update | Self::UpdateMath(_) | Self::UpdateAlt => 3,
            Self::Alt => 4,
            Self::Or => Self::Alt.precedence() + 1,
            Self::And => Self::Or.precedence() + 1,
            Self::Cmp(Cmp::Eq | Cmp::Ne) => Self::And.precedence() + 1,
            Self::Cmp(Cmp::Lt | Cmp::Gt | Cmp::Le | Cmp::Ge) => Self::And.precedence() + 2,
            Self::Math(Math::Add | Math::Sub) => Self::And.precedence() + 3,
            Self::Math(Math::Mul | Math::Div) => Self::Math(Math::Add).precedence() + 1,
            Self::Math(Math::Rem) => Self::Math(Math::Mul).precedence() + 1,
        }
    }

    fn associativity(&self) -> prec_climb::Associativity {
        use prec_climb::Associativity;
        match self {
            Self::Pipe(_) | Self::Assign | Self::Update | Self::UpdateMath(_) | Self::UpdateAlt => {
                Associativity::Right
            }
            _ => Associativity::Left,
        }
    }
}

impl<S> prec_climb::Expr<BinaryOp<S>> for Term<S> {
    fn from_op(lhs: Self, op: BinaryOp<S>, rhs: Self) -> Self {
        Self::BinOp(Box::new(lhs), op, Box::new(rhs))
    }
}
