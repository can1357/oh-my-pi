//! User-function continuations. Branches and calls carry a program counter
//! rather than a chain of suspended Rust evaluators. Ordinary subtrees still
//! use the tree walker; a node not lowered here is delegated to it intact.

use super::*;

#[derive(Clone, Copy)]
enum Op<'a> {
	Immediate(&'a Expr),
	Expr(&'a Expr),
	Stmt(&'a Stmt),
	Discard,
	Binary(BinOp),
	Branch(usize),
	Jump(usize),
	CheckCall(usize),
	Call { index: usize, args: &'a [Expr], scalars: usize },
	Return(bool),
}

#[derive(Clone, Copy)]
struct Entry {
	pc:      usize,
	scalars: usize,
	arrays:  usize,
	inline:  bool,
}

pub(super) struct Calls<'a> {
	ops:     Vec<Op<'a>>,
	entries: Vec<Entry>,
}

impl<'a> Calls<'a> {
	pub(super) fn new(prog: &'a Program) -> Self {
		let mut calls =
			Self { ops: Vec::new(), entries: Vec::with_capacity(prog.functions.len()) };
		for function in &prog.functions {
			let scalars = function
				.kinds
				.iter()
				.filter(|k| matches!(k, Param::Scalar(_)))
				.count();
			let pc = calls.ops.len();
			calls.block(&function.body, FAST_DEPTH);
			calls.ops.push(Op::Return(false));
			// Only fully immediate leaves can run as operands in the native
			// evaluator. All other call chains stay on compact frames.
			let inline = !calls.ops[pc..]
				.iter()
				.any(|op| matches!(op, Op::Stmt(_) | Op::Expr(_) | Op::Call { .. }));
			calls
				.entries
				.push(Entry { pc, scalars, arrays: function.kinds.len() - scalars, inline });
		}
		calls
	}

	pub(super) fn can_inline(&self, index: usize) -> bool {
		self.entries[index].inline
	}

	fn block(&mut self, stmts: &'a [Stmt], depth: u8) {
		for stmt in stmts {
			match stmt {
				Stmt::Return(value) => {
					if let Some(expr) = value {
						self.expr(expr, depth);
					}
					self.ops.push(Op::Return(value.is_some()));
				},
				Stmt::Expr(expr) => {
					self.expr(expr, depth);
					self.ops.push(Op::Discard);
				},
				Stmt::Block(body) if depth > 0 => self.block(body, depth - 1),
				Stmt::If { cond, body, els } if depth > 0 => {
					self.expr(cond, depth - 1);
					self.branch(|s| s.block(body, depth - 1), |s| s.block(els, depth - 1));
				},
				_ => self.ops.push(Op::Stmt(stmt)),
			}
		}
	}

	fn expr(&mut self, expr: &'a Expr, depth: u8) {
		if fast_ok(expr, FAST_DEPTH, None) {
			self.ops.push(Op::Immediate(expr));
			return;
		}
		if depth == 0 {
			self.ops.push(Op::Expr(expr));
			return;
		}
		let d = depth - 1;
		match expr {
			Expr::UserCall { func, args, .. } => {
				self.ops.push(Op::CheckCall(*func));
				let mut scalars = 0;
				for arg in args {
					if !matches!(arg, Expr::ArrayArg(_)) {
						self.expr(arg, d);
						scalars += 1;
					}
				}
				self.ops.push(Op::Call { index: *func, args, scalars });
			},
			Expr::Cond(cond, yes, no) => {
				self.expr(cond, d);
				self.branch(|s| s.expr(yes, d), |s| s.expr(no, d));
			},
			Expr::Binary(left, op, right) => {
				self.expr(left, d);
				self.expr(right, d);
				self.ops.push(Op::Binary(*op));
			},
			Expr::Group(inner) => self.expr(inner, d),
			_ => self.ops.push(Op::Expr(expr)),
		}
	}

	fn branch(&mut self, yes: impl FnOnce(&mut Self), no: impl FnOnce(&mut Self)) {
		let cond = self.ops.len();
		self.ops.push(Op::Branch(0));
		yes(self);
		let jump = self.ops.len();
		self.ops.push(Op::Jump(0));
		self.ops[cond] = Op::Branch(self.ops.len());
		no(self);
		self.ops[jump] = Op::Jump(self.ops.len());
	}
}

/// Sizes before binding an activation. Scalar arguments already lie at the
/// end of `locals` in evaluation order; committing them to a frame is free.
#[derive(Clone, Copy)]
pub(super) struct Mark {
	pub(super) scalars:  usize,
	pub(super) bindings: usize,
	arrays:              usize,
}

const ROOT: usize = usize::MAX;

enum Pause<'a> {
	Value(Value),
	Expr(&'a Expr, usize),
	Stmt(&'a Stmt, usize),
}

impl<'a> Interp<'a> {
	fn mark(&self, scalars: usize) -> Mark {
		Mark { scalars, bindings: self.bindings.len(), arrays: self.arrays.len() }
	}

	fn restore(&mut self, mark: Mark) {
		self.locals.truncate(mark.scalars);
		self.bindings.truncate(mark.bindings);
		self.arrays.truncate(mark.arrays);
	}

	fn check_call(&self, index: usize) -> R<()> {
		if self.frames.len() >= MAX_DEPTH {
			return error(format!(
				"function call nesting too deep in {:?}",
				self.prog.functions[index].name
			));
		}
		self.check_cancel()
	}

	fn enter(&mut self, index: usize, args: &[Expr], base: usize, resume: usize) -> R<usize> {
		let entry = self.calls.entries[index];
		let mark = self.mark(base);
		if entry.arrays != 0 {
			let function = &self.prog.functions[index];
			for (i, kind) in function.kinds.iter().enumerate() {
				if let Param::Array(_) = kind {
					let binding = match args.get(i) {
						Some(Expr::ArrayArg(array)) => self.array_index(array.slot)?,
						None => {
							self.arrays.push(Array::default());
							self.arrays.len() - 1
						},
						Some(_) => {
							return error(format!(
								"can't pass scalar as array param of {:?}",
								function.name
							));
						},
					};
					self.bindings.push(binding);
				}
			}
		}
		self.locals.resize(base + entry.scalars, Value::Null);
		self.frames.push(Frame { mark, resume });
		Ok(entry.pc)
	}

	/// Only reentries through delegated AST nodes nest native polls. Count
	/// these separately: an arbitrary number of compact calls can intervene.
	pub(super) async fn call_user(&mut self, index: usize, args: &[Expr]) -> R<Value> {
		self.check_call(index)?;
		let mark = self.mark(self.locals.len());
		let depth = self.frames.len();
		self.poll_depth += 1;
		let descend = self.poll_depth.is_multiple_of(DESCEND_EVERY);
		let body = self.run_calls(index, args, mark.scalars);
		let result = if descend {
			crate::deep::descend(body).await
		} else {
			body.await
		};
		self.poll_depth -= 1;
		if result.is_err() {
			self.restore(mark);
			self.frames.truncate(depth);
		}
		result
	}

	/// The caller checked the entire argument expression and the leaf's
	/// plan before executing either. No operation here can suspend.
	pub(super) fn call_inline(&mut self, index: usize, args: &[Expr]) -> R<Value> {
		self.check_call(index)?;
		let mark = self.mark(self.locals.len());
		let depth = self.frames.len();
		let result = (|| {
			for arg in args {
				if !matches!(arg, Expr::ArrayArg(_)) {
					let value = self.eval_fast_ok(arg)?;
					self.locals.push(value);
				}
			}
			let pc = self.enter(index, args, mark.scalars, ROOT)?;
			match self.drive(pc)? {
				Pause::Value(result) => Ok(result),
				_ => unreachable!("only immediate leaves are inlined"),
			}
		})();
		if result.is_err() {
			self.restore(mark);
			self.frames.truncate(depth);
		}
		result
	}

	async fn run_calls(&mut self, index: usize, args: &[Expr], base: usize) -> R<Value> {
		for arg in args {
			if !matches!(arg, Expr::ArrayArg(_)) {
				let value = match self.eval_fast(arg) {
					Some(value) => value?,
					None => self.eval_boxed(arg).await?,
				};
				self.locals.push(value);
			}
		}
		let mut pc = self.enter(index, args, base, ROOT)?;
		loop {
			match self.drive(pc)? {
				Pause::Value(value) => return Ok(value),
				Pause::Expr(expr, resume) => {
					let value = self.eval_boxed(expr).await?;
					self.locals.push(value);
					pc = resume;
				},
				Pause::Stmt(stmt, resume) => {
					let value = match boxed_flow(self.exec(stmt)).await? {
						Flow::Normal => {
							pc = resume;
							continue;
						},
						Flow::Return(v) => v,
						Flow::Break | Flow::Continue => Value::Null,
					};
					pc = self.leave();
					if pc == ROOT {
						return Ok(value);
					}
					self.locals.push(value);
				},
			}
		}
	}

	fn leave(&mut self) -> usize {
		let frame = self.frames.pop().unwrap();
		self.restore(frame.mark);
		frame.resume
	}

	fn drive(&mut self, mut pc: usize) -> R<Pause<'a>> {
		loop {
			let op = self.calls.ops[pc];
			pc += 1;
			let result = match op {
				Op::Immediate(expr) => {
					let v = self.eval_fast_ok(expr)?;
					self.locals.push(v);
					continue;
				},
				Op::Expr(expr) => return Ok(Pause::Expr(expr, pc)),
				Op::Stmt(stmt) => return Ok(Pause::Stmt(stmt, pc)),
				Op::Binary(op) => {
					let right = self.locals.pop().unwrap();
					let left = self.locals.last().unwrap();
					let value = self.binary(op, left, &right)?;
					*self.locals.last_mut().unwrap() = value;
					continue;
				},
				Op::Branch(target) => {
					if !self.locals.pop().unwrap().truthy() {
						pc = target;
					}
					continue;
				},
				Op::Jump(target) => {
					pc = target;
					continue;
				},
				Op::Discard => {
					self.locals.pop();
					continue;
				},
				Op::CheckCall(index) => {
					self.check_call(index)?;
					continue;
				},
				Op::Call { index, args, scalars } => {
					pc = self.enter(index, args, self.locals.len() - scalars, pc)?;
					continue;
				},
				Op::Return(value) => {
					if value {
						self.locals.pop().unwrap()
					} else {
						Value::Null
					}
				},
			};
			pc = self.leave();
			if pc == ROOT {
				return Ok(Pause::Value(result));
			}
			self.locals.push(result);
		}
	}
}
