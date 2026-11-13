//! The AWK syntax tree, after GoAWK's `internal/ast`. Variable references
//! carry their names from the parser and their storage slots once the
//! resolver has run.

use std::rc::Rc;

use super::{
	lexer::{Func, Pos},
	regex::AwkRegex,
	value::Bytes,
};

/// The special (built-in scalar) variables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Special {
	Nf,
	Nr,
	Fnr,
	Fs,
	Ofs,
	Ors,
	Rs,
	Filename,
	Subsep,
	Rstart,
	Rlength,
	Convfmt,
	Ofmt,
	Argc,
}

impl Special {
	pub fn lookup(name: &str) -> Option<Self> {
		Some(match name {
			"NF" => Self::Nf,
			"NR" => Self::Nr,
			"FNR" => Self::Fnr,
			"FS" => Self::Fs,
			"OFS" => Self::Ofs,
			"ORS" => Self::Ors,
			"RS" => Self::Rs,
			"FILENAME" => Self::Filename,
			"SUBSEP" => Self::Subsep,
			"RSTART" => Self::Rstart,
			"RLENGTH" => Self::Rlength,
			"CONVFMT" => Self::Convfmt,
			"OFMT" => Self::Ofmt,
			"ARGC" => Self::Argc,
			_ => return None,
		})
	}
}

/// Where a scalar variable lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Slot {
	Unresolved,
	Global(usize),
	Local(usize),
	Special(Special),
}

/// Where an array lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ArraySlot {
	Unresolved,
	Global(usize),
	Local(usize),
}

/// A named scalar reference.
#[derive(Clone, Debug)]
pub(super) struct ScalarRef {
	pub name: Rc<str>,
	pub pos:  Pos,
	pub slot: Slot,
}

/// A named array reference.
#[derive(Clone, Debug)]
pub(super) struct ArrayRef {
	pub name: Rc<str>,
	pub pos:  Pos,
	pub slot: ArraySlot,
}

impl ArrayRef {
	pub fn new(name: Rc<str>, pos: Pos) -> Self {
		Self { name, pos, slot: ArraySlot::Unresolved }
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BinOp {
	Add,
	Sub,
	Mul,
	Div,
	Mod,
	Pow,
	Concat,
	Eq,
	Ne,
	Lt,
	Le,
	Gt,
	Ge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UnOp {
	Not,
	Neg,
	Plus,
}

/// Where `getline` reads from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GetlineSrc {
	/// The main input (`getline`).
	Main,
	/// A file (`getline < file`).
	File,
	/// A command (`cmd | getline`).
	Command,
}

/// Output redirection of `print`/`printf`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Redirect {
	/// `> file`
	Write,
	/// `>> file`
	Append,
	/// `| command`
	Pipe,
}

pub(super) enum Expr {
	Num(f64),
	Str(Bytes),
	/// A bare `/re/`: matches against `$0`.
	RegexMatch(Rc<AwkRegex>),
	/// A `/re/` in a regex-argument position (`~`, `sub`, `split`, …).
	RegexArg(Rc<AwkRegex>, Bytes),
	Var(ScalarRef),
	/// A whole array passed to a user function (after resolution).
	ArrayArg(ArrayRef),
	Index(ArrayRef, Vec<Expr>),
	Field(Box<Expr>),
	Assign(Box<Expr>, Box<Expr>),
	AugAssign(Box<Expr>, BinOp, Box<Expr>),
	Cond(Box<Expr>, Box<Expr>, Box<Expr>),
	Binary(Box<Expr>, BinOp, Box<Expr>),
	And(Box<Expr>, Box<Expr>),
	Or(Box<Expr>, Box<Expr>),
	Match(Box<Expr>, bool, Box<Expr>),
	Unary(UnOp, Box<Expr>),
	Incr { target: Box<Expr>, decr: bool, pre: bool },
	In(Vec<Expr>, ArrayRef),
	Call(Func, Vec<Expr>),
	/// `split(s, array[, sep])`.
	Split(Box<Expr>, ArrayRef, Option<Box<Expr>>),
	/// `length(array)` (after resolution).
	LengthArray(ArrayRef),
	UserCall { name: Rc<str>, pos: Pos, func: usize, args: Vec<Expr> },
	Getline { src: GetlineSrc, target: Option<Box<Expr>>, from: Option<Box<Expr>> },
	Group(Box<Expr>),
	/// A parenthesized comma list: only valid as `print (a, b)` (parse only).
	Multi(Vec<Expr>, usize),
}

impl Expr {
	/// Whether the expression can be assigned to.
	pub fn is_lvalue(&self) -> bool {
		matches!(self, Self::Var(_) | Self::Index(..) | Self::Field(_))
	}
}

pub(super) type Stmts = Vec<Stmt>;

pub(super) enum Stmt {
	Print { args: Vec<Expr>, redirect: Option<(Redirect, Expr)> },
	Printf { args: Vec<Expr>, redirect: Option<(Redirect, Expr)> },
	Expr(Expr),
	If { cond: Expr, body: Stmts, els: Stmts },
	For { pre: Option<Box<Stmt>>, cond: Option<Expr>, post: Option<Box<Stmt>>, body: Stmts },
	ForIn { var: ScalarRef, array: ArrayRef, body: Stmts },
	While { cond: Expr, body: Stmts },
	DoWhile { body: Stmts, cond: Expr },
	Break,
	Continue,
	Next,
	NextFile,
	Exit(Option<Expr>),
	Return(Option<Expr>),
	Delete { array: ArrayRef, index: Option<Vec<Expr>> },
	Block(Stmts),
}

pub(super) enum Pattern {
	All,
	Expr(Expr),
	Range(Expr, Expr),
}

pub(super) struct Action {
	pub pattern: Pattern,
	/// `None` is the implicit `{ print $0 }`.
	pub body:    Option<Stmts>,
}

/// Whether a function parameter is a scalar or an array, with its slot in
/// the frame's scalars or arrays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Param {
	Scalar(usize),
	Array(usize),
}

pub(super) struct Function {
	pub name:   Rc<str>,
	pub params: Vec<Rc<str>>,
	pub pos:    Pos,
	pub body:   Stmts,
	/// Filled in by the resolver.
	pub kinds:  Vec<Param>,
}

pub(super) struct Program {
	pub begin:     Vec<Stmts>,
	pub actions:   Vec<Action>,
	pub end:       Vec<Stmts>,
	pub functions: Vec<Function>,
	/// Global scalar names by slot (filled in by the resolver).
	pub scalars:   Vec<Rc<str>>,
	/// Global array names by slot (filled in by the resolver).
	pub arrays:    Vec<Rc<str>>,
}

impl Program {
	pub fn scalar_slot(&self, name: &str) -> Option<usize> {
		self.scalars.iter().position(|n| &**n == name)
	}

	pub fn array_slot(&self, name: &str) -> Option<usize> {
		self.arrays.iter().position(|n| &**n == name)
	}
}
