//! Variable resolution, ported from GoAWK's `internal/resolver`: infers
//! whether each global and each function parameter is a scalar or an array
//! (iterating to a fixed point across calls), checks uses against that, and
//! assigns storage slots.

use std::{collections::HashMap, rc::Rc};

use super::{
	ast::{ArraySlot, Expr, Param, Program, Slot, Special, Stmt},
	lexer::{Func, Pos},
	parser::ParseError,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Type {
	Unknown,
	Scalar,
	Array,
}

impl Type {
	const fn name(self) -> &'static str {
		match self {
			Self::Unknown => "unknown",
			Self::Scalar => "scalar",
			Self::Array => "array",
		}
	}
}

type RResult<T> = Result<T, ParseError>;

fn err(pos: Pos, message: impl Into<String>) -> ParseError {
	ParseError { pos, message: message.into() }
}

struct Resolver {
	/// Global variable types by name.
	globals:   HashMap<Rc<str>, Type>,
	/// Parameter types by function index, in parameter order.
	locals:    Vec<Vec<(Rc<str>, Type)>>,
	/// Function indexes by name.
	funcs:     HashMap<Rc<str>, usize>,
	func_pos:  Vec<Pos>,
	updates:   usize,
}

/// Where a name lives during typing.
enum Found {
	Local(usize, usize),
	Special,
	Global,
	Missing,
}

impl Resolver {
	fn lookup(&self, func: Option<usize>, name: &str) -> (Found, Type) {
		if let Some(f) = func
			&& let Some(index) = self.locals[f].iter().position(|(param, _)| &**param == name)
		{
			return (Found::Local(f, index), self.locals[f][index].1);
		}
		if Special::lookup(name).is_some() {
			return (Found::Special, Type::Scalar);
		}
		match self.globals.get(name) {
			Some(&typ) => (Found::Global, typ),
			None => (Found::Missing, Type::Unknown),
		}
	}

	fn record(&mut self, func: Option<usize>, name: &Rc<str>, typ: Type, pos: Pos) -> RResult<()> {
		let (found, current) = self.lookup(func, name);
		if let Found::Missing = found {
			if self.funcs.contains_key(name) {
				return Err(err(pos, format!("global var {name:?} can't also be a function")));
			}
			self.globals.insert(Rc::clone(name), typ);
			self.updates += 1;
			return Ok(());
		}
		if current != typ && current != Type::Unknown && typ != Type::Unknown {
			return Err(err(pos, format!("can't use {} {name:?} as {}", current.name(), typ.name())));
		}
		if current == Type::Unknown && typ != Type::Unknown {
			match found {
				Found::Local(f, index) => self.locals[f][index].1 = typ,
				_ => {
					self.globals.insert(Rc::clone(name), typ);
				},
			}
			self.updates += 1;
		}
		Ok(())
	}

	fn stmts(&mut self, func: Option<usize>, stmts: &[Stmt]) -> RResult<()> {
		stmts.iter().try_for_each(|stmt| self.stmt(func, stmt))
	}

	fn stmt(&mut self, func: Option<usize>, stmt: &Stmt) -> RResult<()> {
		match stmt {
			Stmt::Print { args, redirect } | Stmt::Printf { args, redirect } => {
				self.exprs(func, args)?;
				if let Some((_, dest)) = redirect {
					self.expr(func, dest)?;
				}
			},
			Stmt::Expr(expr) => self.expr(func, expr)?,
			Stmt::If { cond, body, els } => {
				self.expr(func, cond)?;
				self.stmts(func, body)?;
				self.stmts(func, els)?;
			},
			Stmt::For { pre, cond, post, body } => {
				if let Some(pre) = pre {
					self.stmt(func, pre)?;
				}
				if let Some(cond) = cond {
					self.expr(func, cond)?;
				}
				if let Some(post) = post {
					self.stmt(func, post)?;
				}
				self.stmts(func, body)?;
			},
			Stmt::ForIn { var, array, body } => {
				self.record(func, &var.name, Type::Scalar, var.pos)?;
				self.record(func, &array.name, Type::Array, array.pos)?;
				self.stmts(func, body)?;
			},
			Stmt::While { cond, body } | Stmt::DoWhile { body, cond } => {
				self.expr(func, cond)?;
				self.stmts(func, body)?;
			},
			Stmt::Exit(value) | Stmt::Return(value) => {
				if let Some(value) = value {
					self.expr(func, value)?;
				}
			},
			Stmt::Delete { array, index } => {
				self.record(func, &array.name, Type::Array, array.pos)?;
				if let Some(index) = index {
					self.exprs(func, index)?;
				}
			},
			Stmt::Block(body) => self.stmts(func, body)?,
			Stmt::Break | Stmt::Continue | Stmt::Next | Stmt::NextFile => {},
		}
		Ok(())
	}

	fn exprs(&mut self, func: Option<usize>, exprs: &[Expr]) -> RResult<()> {
		exprs.iter().try_for_each(|expr| self.expr(func, expr))
	}

	fn expr(&mut self, func: Option<usize>, expr: &Expr) -> RResult<()> {
		match expr {
			Expr::Num(_) | Expr::Str(_) | Expr::RegexMatch(_) | Expr::RegexArg(..) => {},
			Expr::Var(var) => self.record(func, &var.name, Type::Scalar, var.pos)?,
			Expr::ArrayArg(array) | Expr::LengthArray(array) => {
				self.record(func, &array.name, Type::Array, array.pos)?;
			},
			Expr::Index(array, index) | Expr::In(index, array) => {
				self.exprs(func, index)?;
				self.record(func, &array.name, Type::Array, array.pos)?;
			},
			Expr::Field(e) | Expr::Unary(_, e) | Expr::Group(e) => self.expr(func, e)?,
			Expr::Incr { target, .. } => self.expr(func, target)?,
			Expr::Assign(l, r)
			| Expr::AugAssign(l, _, r)
			| Expr::Binary(l, _, r)
			| Expr::And(l, r)
			| Expr::Or(l, r)
			| Expr::Match(l, _, r) => {
				self.expr(func, l)?;
				self.expr(func, r)?;
			},
			Expr::Cond(c, t, f) => {
				self.expr(func, c)?;
				self.expr(func, t)?;
				self.expr(func, f)?;
			},
			Expr::Call(Func::Length, args) if matches!(args.first(), Some(Expr::Var(_))) => {
				if let Some(Expr::Var(var)) = args.first() {
					// length(x) takes a scalar or an array.
					self.record(func, &var.name, Type::Unknown, var.pos)?;
				}
			},
			Expr::Call(_, args) => self.exprs(func, args)?,
			Expr::Split(s, array, sep) => {
				self.expr(func, s)?;
				self.record(func, &array.name, Type::Array, array.pos)?;
				if let Some(sep) = sep {
					self.expr(func, sep)?;
				}
			},
			Expr::UserCall { name, pos, args, .. } => self.user_call(func, name, *pos, args)?,
			Expr::Getline { target, from, .. } => {
				if let Some(target) = target {
					self.expr(func, target)?;
				}
				if let Some(from) = from {
					self.expr(func, from)?;
				}
			},
			Expr::Multi(exprs, _) => self.exprs(func, exprs)?,
		}
		Ok(())
	}

	fn user_call(&mut self, func: Option<usize>, name: &Rc<str>, pos: Pos, args: &[Expr]) -> RResult<()> {
		if let (Found::Local(..), _) = self.lookup(func, name) {
			return Err(err(pos, format!("can't call local variable {name:?} as function")));
		}
		let Some(&callee) = self.funcs.get(name) else {
			return Err(err(pos, format!("undefined function {name:?}")));
		};
		if args.len() > self.locals[callee].len() {
			return Err(err(pos, format!("{name:?} called with more arguments than declared")));
		}
		for (i, arg) in args.iter().enumerate() {
			let (param, param_type) = self.locals[callee][i].clone();
			let Expr::Var(var) = arg else {
				if param_type == Type::Array {
					return Err(err(pos, format!("can't pass scalar as array param {param:?} of {name:?}")));
				}
				self.expr(func, arg)?;
				continue;
			};
			let (_, var_type) = self.lookup(func, &var.name);
			match (var_type, param_type) {
				(Type::Unknown, known) if known != Type::Unknown => self.record(func, &var.name, known, var.pos)?,
				(known, Type::Unknown) if known != Type::Unknown => {
					let func_pos = self.func_pos[callee];
					self.record(Some(callee), &param, known, func_pos)?;
				},
				(a, b) if a != b && a != Type::Unknown && b != Type::Unknown => {
					return Err(err(
						var.pos,
						format!("can't pass {} {:?} as {} param", a.name(), var.name, b.name()),
					));
				},
				_ => self.record(func, &var.name, Type::Unknown, var.pos)?,
			}
		}
		Ok(())
	}

	fn walk(&mut self, prog: &Program) -> RResult<()> {
		for (index, function) in prog.functions.iter().enumerate() {
			self.stmts(Some(index), &function.body)?;
		}
		for stmts in &prog.begin {
			self.stmts(None, stmts)?;
		}
		for action in &prog.actions {
			match &action.pattern {
				super::ast::Pattern::All => {},
				super::ast::Pattern::Expr(e) => self.expr(None, e)?,
				super::ast::Pattern::Range(a, b) => {
					self.expr(None, a)?;
					self.expr(None, b)?;
				},
			}
			if let Some(body) = &action.body {
				self.stmts(None, body)?;
			}
		}
		for stmts in &prog.end {
			self.stmts(None, stmts)?;
		}
		Ok(())
	}
}

/// Slot assignment, applied to the tree once types are final.
struct Assigner<'r> {
	global_scalars: HashMap<Rc<str>, usize>,
	global_arrays:  HashMap<Rc<str>, usize>,
	/// Per function: each parameter's kind and slot.
	params:         Vec<Vec<(Rc<str>, Param)>>,
	funcs:          &'r HashMap<Rc<str>, usize>,
}

impl Assigner<'_> {
	fn local(&self, func: Option<usize>, name: &str) -> Option<Param> {
		let f = func?;
		self.params[f].iter().find(|(param, _)| &**param == name).map(|(_, kind)| *kind)
	}

	fn scalar(&self, func: Option<usize>, name: &str) -> Slot {
		match self.local(func, name) {
			Some(Param::Scalar(slot)) => Slot::Local(slot),
			_ => match Special::lookup(name) {
				Some(special) => Slot::Special(special),
				None => self.global_scalars.get(name).map_or(Slot::Unresolved, |&slot| Slot::Global(slot)),
			},
		}
	}

	fn array(&self, func: Option<usize>, name: &str) -> ArraySlot {
		match self.local(func, name) {
			Some(Param::Array(slot)) => ArraySlot::Local(slot),
			_ => self.global_arrays.get(name).map_or(ArraySlot::Unresolved, |&slot| ArraySlot::Global(slot)),
		}
	}

	fn is_array(&self, func: Option<usize>, name: &str) -> bool {
		matches!(self.array(func, name), ArraySlot::Local(_) | ArraySlot::Global(_))
	}

	fn stmts(&self, func: Option<usize>, stmts: &mut [Stmt]) {
		for stmt in stmts {
			self.stmt(func, stmt);
		}
	}

	fn stmt(&self, func: Option<usize>, stmt: &mut Stmt) {
		match stmt {
			Stmt::Print { args, redirect } | Stmt::Printf { args, redirect } => {
				self.exprs(func, args);
				if let Some((_, dest)) = redirect {
					self.expr(func, dest);
				}
			},
			Stmt::Expr(expr) => self.expr(func, expr),
			Stmt::If { cond, body, els } => {
				self.expr(func, cond);
				self.stmts(func, body);
				self.stmts(func, els);
			},
			Stmt::For { pre, cond, post, body } => {
				if let Some(pre) = pre {
					self.stmt(func, pre);
				}
				if let Some(cond) = cond {
					self.expr(func, cond);
				}
				if let Some(post) = post {
					self.stmt(func, post);
				}
				self.stmts(func, body);
			},
			Stmt::ForIn { var, array, body } => {
				var.slot = self.scalar(func, &var.name);
				array.slot = self.array(func, &array.name);
				self.stmts(func, body);
			},
			Stmt::While { cond, body } | Stmt::DoWhile { body, cond } => {
				self.expr(func, cond);
				self.stmts(func, body);
			},
			Stmt::Exit(value) | Stmt::Return(value) => {
				if let Some(value) = value {
					self.expr(func, value);
				}
			},
			Stmt::Delete { array, index } => {
				array.slot = self.array(func, &array.name);
				if let Some(index) = index {
					self.exprs(func, index);
				}
			},
			Stmt::Block(body) => self.stmts(func, body),
			Stmt::Break | Stmt::Continue | Stmt::Next | Stmt::NextFile => {},
		}
	}

	fn exprs(&self, func: Option<usize>, exprs: &mut [Expr]) {
		for expr in exprs {
			self.expr(func, expr);
		}
	}

	fn expr(&self, func: Option<usize>, expr: &mut Expr) {
		match expr {
			Expr::Num(_) | Expr::Str(_) | Expr::RegexMatch(_) | Expr::RegexArg(..) => {},
			Expr::Var(var) => var.slot = self.scalar(func, &var.name),
			Expr::ArrayArg(array) | Expr::LengthArray(array) => array.slot = self.array(func, &array.name),
			Expr::Index(array, index) | Expr::In(index, array) => {
				self.exprs(func, index);
				array.slot = self.array(func, &array.name);
			},
			Expr::Field(e) | Expr::Unary(_, e) | Expr::Group(e) => self.expr(func, e),
			Expr::Incr { target, .. } => self.expr(func, target),
			Expr::Assign(l, r)
			| Expr::AugAssign(l, _, r)
			| Expr::Binary(l, _, r)
			| Expr::And(l, r)
			| Expr::Or(l, r)
			| Expr::Match(l, _, r) => {
				self.expr(func, l);
				self.expr(func, r);
			},
			Expr::Cond(c, t, f) => {
				self.expr(func, c);
				self.expr(func, t);
				self.expr(func, f);
			},
			Expr::Call(Func::Length, args)
				if matches!(args.first(), Some(Expr::Var(var)) if self.is_array(func, &var.name)) =>
			{
				if let Some(Expr::Var(var)) = args.first() {
					let array = super::ast::ArrayRef {
						name: Rc::clone(&var.name),
						pos:  var.pos,
						slot: self.array(func, &var.name),
					};
					*expr = Expr::LengthArray(array);
				}
			},
			Expr::Call(_, args) => self.exprs(func, args),
			Expr::Split(s, array, sep) => {
				self.expr(func, s);
				array.slot = self.array(func, &array.name);
				if let Some(sep) = sep {
					self.expr(func, sep);
				}
			},
			Expr::UserCall { name, func: callee, args, .. } => {
				*callee = self.funcs.get(name).copied().unwrap_or(usize::MAX);
				for (i, arg) in args.iter_mut().enumerate() {
					let is_array_param =
						matches!(self.params.get(*callee).and_then(|p| p.get(i)), Some((_, Param::Array(_))));
					match arg {
						Expr::Var(var) if is_array_param => {
							let array = super::ast::ArrayRef {
								name: Rc::clone(&var.name),
								pos:  var.pos,
								slot: self.array(func, &var.name),
							};
							*arg = Expr::ArrayArg(array);
						},
						_ => self.expr(func, arg),
					}
				}
			},
			Expr::Getline { target, from, .. } => {
				if let Some(target) = target {
					self.expr(func, target);
				}
				if let Some(from) = from {
					self.expr(func, from);
				}
			},
			Expr::Multi(exprs, _) => self.exprs(func, exprs),
		}
	}
}

/// Resolves every variable in `prog` and fills in its slot tables.
pub(super) fn resolve(prog: &mut Program) -> RResult<()> {
	let mut funcs = HashMap::new();
	for (index, function) in prog.functions.iter().enumerate() {
		if funcs.insert(Rc::clone(&function.name), index).is_some() {
			return Err(err(function.pos, format!("function {:?} already defined", function.name)));
		}
		if Special::lookup(&function.name).is_some() {
			return Err(err(function.pos, format!("can't use special variable {:?} as a function", function.name)));
		}
	}
	let mut resolver = Resolver {
		globals:  HashMap::new(),
		locals:   prog
			.functions
			.iter()
			.map(|f| f.params.iter().map(|p| (Rc::clone(p), Type::Unknown)).collect())
			.collect(),
		funcs,
		func_pos: prog.functions.iter().map(|f| f.pos).collect(),
		updates:  0,
	};
	let start = Pos { line: 1, col: 1 };
	resolver.record(None, &Rc::from("ARGV"), Type::Array, start)?;
	resolver.record(None, &Rc::from("ENVIRON"), Type::Array, start)?;

	let mut iterations = 0;
	loop {
		let before = resolver.updates;
		resolver.walk(prog)?;
		if resolver.updates == before {
			break;
		}
		iterations += 1;
		if iterations > 100 {
			return Err(err(start, "too many iterations trying to resolve variable types"));
		}
	}

	let mut names: Vec<(Rc<str>, Type)> = resolver.globals.iter().map(|(n, t)| (Rc::clone(n), *t)).collect();
	names.sort_by(|a, b| a.0.cmp(&b.0));
	let mut global_scalars = HashMap::new();
	let mut global_arrays = HashMap::new();
	for (name, typ) in names {
		if typ == Type::Array {
			global_arrays.insert(Rc::clone(&name), prog.arrays.len());
			prog.arrays.push(name);
		} else {
			global_scalars.insert(Rc::clone(&name), prog.scalars.len());
			prog.scalars.push(name);
		}
	}
	let params: Vec<Vec<(Rc<str>, Param)>> = resolver
		.locals
		.iter()
		.map(|params| {
			let (mut scalars, mut arrays) = (0, 0);
			params
				.iter()
				.map(|(name, typ)| {
					let kind = if *typ == Type::Array {
						arrays += 1;
						Param::Array(arrays - 1)
					} else {
						scalars += 1;
						Param::Scalar(scalars - 1)
					};
					(Rc::clone(name), kind)
				})
				.collect()
		})
		.collect();
	for (function, params) in prog.functions.iter_mut().zip(&params) {
		function.kinds = params.iter().map(|(_, kind)| *kind).collect();
	}

	let assigner = Assigner { global_scalars, global_arrays, params, funcs: &resolver.funcs };
	for (index, function) in prog.functions.iter_mut().enumerate() {
		assigner.stmts(Some(index), &mut function.body);
	}
	for stmts in &mut prog.begin {
		assigner.stmts(None, stmts);
	}
	for action in &mut prog.actions {
		match &mut action.pattern {
			super::ast::Pattern::All => {},
			super::ast::Pattern::Expr(e) => assigner.expr(None, e),
			super::ast::Pattern::Range(a, b) => {
				assigner.expr(None, a);
				assigner.expr(None, b);
			},
		}
		if let Some(body) = &mut action.body {
			assigner.stmts(None, body);
		}
	}
	for stmts in &mut prog.end {
		assigner.stmts(None, stmts);
	}
	Ok(())
}
