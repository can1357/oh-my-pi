//! Expression contexts, operators and interpolation (perlop, perlnumber, perlunicode).

use std::{borrow::Cow, cmp::Ordering};

use super::{vars::Slot, *};

const DEPTH_LIMIT: u32 = 8192;
const PURE_LEVELS: u8 = 4;
const STACK_CHECK_EVERY: u32 = if cfg!(debug_assertions) { 1 } else { 4 };
// Allow for a compound assignment above the bounded arithmetic subtree.
const PURE_LIMIT: u32 = DEPTH_LIMIT - PURE_LEVELS as u32 - 1;

pub(super) enum Operation<'a> {
	Ready(PResult<Ret>),
	Deferred(std::pin::Pin<Box<dyn Future<Output = PResult<Ret>> + 'a>>),
}

impl<'a> Operation<'a> {
	#[inline(always)]
	pub(super) fn start<F: Future<Output = PResult<Ret>> + 'a>(on_stack: bool, future: F) -> Self {
		if !cfg!(debug_assertions) && on_stack {
			// SAFETY: same linear interpreter futures as the root driver. A nested
			// driver restores the enclosing driver's slot and finishes before returning.
			// Pass a pin, not the potentially kilobyte-sized coroutine by value.
			let root: std::pin::Pin<&mut dyn Future<Output = PResult<Ret>>> = std::pin::pin!(future);
			Self::Ready(unsafe { crate::deep::run(root) })
		} else {
			Self::Deferred(Box::pin(future))
		}
	}
}

impl Interp<'_> {
	#[inline]
	pub(super) async fn depth_guard<T>(&mut self, f: impl AsyncFnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		self.enter_depth()?;
		let result = f(self).await;
		self.depth -= 1;
		result
	}

	#[inline]
	pub(super) fn enter_depth(&mut self) -> PResult<()> {
		if self.depth >= DEPTH_LIMIT { return Err(self.die_msg("Deep recursion limit exceeded")); }
		self.depth += 1;
		Ok(())
	}

	/// Evaluate an expression in the context supplied by its parent.
	pub async fn eval_async(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		if let Some(value) = self.eval_immediate(e, cx) { return Ok(Ret::One(value)); }
		self.eval_deferred(e, cx, 1).await
	}

	/// Sync entry for native callbacks and coercion paths: drives the async
	/// evaluator on the blocking worker, spilling recursion to the heap queue.
	pub fn eval(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		// SAFETY: interpreter recursion awaits one child directly to completion; it never selects, cancels, or polls those futures independently.
		unsafe { crate::deep::run(self.eval_async(e, cx)) }
	}

	/// A statement and its expression share a poll: there is no Perl code between
	/// their entries, but both levels count towards the language recursion limit.
	pub(super) async fn eval_deferred(&mut self, e: &Expr, cx: Cx, levels: u32) -> PResult<Ret> {
		let outer_depth = self.depth;
		if levels == 2 && outer_depth >= DEPTH_LIMIT { return Err(self.die_msg("Deep recursion limit exceeded")); }
		let saved = self.enter_location(&e.location);
		let mut node = e;
		let mut levels = levels;
		let mut checkpoint = false;
		let mut cx = cx;
		let mut pair = None;
		let mut immediate_right = false;
		let result = loop {
			let at = self.depth;
			if at > DEPTH_LIMIT - levels { break Err(self.die_msg("Deep recursion limit exceeded")); }
			if let Some(flow) = self.take_pending() { break Err(flow); }
			self.depth += levels;
			checkpoint |= at.is_multiple_of(DESCEND_EVERY) || levels == 2 && (at + 1).is_multiple_of(DESCEND_EVERY);
			// Groups and plain conditions have no work to do after the chosen operand.
			// Walk these tails without returning through suspended poll frames.
			let tail = match &node.kind {
				ExprKind::Group(inner) | ExprKind::Unary(Unary::Plus, inner) => Some(&**inner),
				ExprKind::Conditional(cond, yes, no) => self.plain_truth(cond).map(|v| if v { &**yes } else { &**no }),
				_ => None,
			};
			// A ready left operand needs only one saved value, not a second
			// coroutine/driver for the right operand. Limit fusion to one pair;
			// deeper subtrees use the same general binary operator implementation.
			if pair.is_none() && let ExprKind::Binary(Binary::Add | Binary::Sub | Binary::Mul | Binary::Div | Binary::Mod | Binary::Pow, lhs, rhs) = &node.kind
				&& let Some(left) = self.eval_immediate(lhs, Cx::Scalar) {
				pair = Some((node, left, self.depth, cx));
				cx = Cx::Scalar;
				if let Some(right) = self.eval_immediate(rhs, cx) {
					immediate_right = true;
					break Ok(Ret::One(right));
				}
				node = rhs;
				self.statement_location(&node.location);
				levels = 1;
				continue;
			}
			if let Some(next) = tail {
				if let Some(v) = self.eval_immediate(next, cx) { break Ok(Ret::One(v)); }
				self.statement_location(&next.location);
				node = next;
				levels = 1;
				continue;
			}
			let check = if checkpoint { 0 } else { at };
			let result = match self.eval_operation(node, cx) {
				Operation::Ready(result) => result,
				Operation::Deferred(child) => descend(check, child).await,
			};
			break if let Some(flow) = self.take_pending() { Err(flow) } else { result };
		};
		let mut result = if immediate_right { result } else { self.finish_expression(result, cx) };
		if let Some((parent, left, depth, parent_cx)) = pair {
			let ExprKind::Binary(op, lhs, rhs) = &parent.kind else { unreachable!("saved arithmetic operand") };
			self.depth = depth;
			self.statement_location(&parent.location);
			if let Ok(right) = result {
				let right = right.scalar();
				result = if let (Some(a), Some(b)) = (plain_num(&left), plain_num(&right)) {
					match numeric_binary(*op, a, b, self.active_hints.integer) {
						Ok(value) => Ok(Ret::One(value)),
						Err(message) => descend(0, async { Err(self.die_msg(message)) }).await,
					}
				} else {
					// After resuming an operand we are back on the parent's poll
					// stack. Coercion, overload and DIE hooks need a fresh checkpoint.
					descend(0, async { self.binary_pair_values(*op, lhs, left, rhs, right) }).await
				};
			}
			result = if let Some(flow) = self.take_pending() { Err(flow) } else { self.finish_expression(result, parent_cx) };
		}
		self.depth = outer_depth;
		self.leave_location(&e.location, saved);
		result
	}

	#[inline]
	fn finish_expression(&mut self, mut result: PResult<Ret>, cx: Cx) -> PResult<Ret> {
		if let Ok(ret) = &mut result {
			ret.apply_context(cx);
			if matches!(ret, Ret::One(Value::Ref(Ref::Regexp(_)))) { self.track_ret(ret); }
		}
		result
	}

	/// Execute bounded, callback-free operations without entering a recursive evaluator frame.
	/// A miss must have no side effects: coercions that can warn or die use the deferred evaluator.
	#[inline]
	pub(super) fn eval_immediate(&mut self, e: &Expr, cx: Cx) -> Option<Value> {
		if let ExprKind::Conditional(cond, yes, no) = &e.kind {
			if self.pending.is_some() || self.depth >= PURE_LIMIT - 2 { return None; }
			let branch = if self.plain_truth(cond)? { yes } else { no };
			// One branch only; nested conditions use the iterative deferred path.
			return self.immediate_node(branch, cx).filter(|v| !matches!(v, Value::Ref(Ref::Regexp(_))));
		}
		self.immediate_node(e, cx)
	}

	#[inline]
	fn immediate_node(&mut self, e: &Expr, cx: Cx) -> Option<Value> {
		match &e.kind {
			// These operations need an lvalue, a regex, or short-circuit evaluation:
			// no bounded arithmetic/string probe can handle them.
			ExprKind::Binary(Binary::Assign | Binary::Bind(_) | Binary::And | Binary::Or | Binary::DefinedOr
				| Binary::AssignOp(Compound::Concat), _, _) => None,
			ExprKind::Binary(..) => self.try_plain_binary(e, cx),
			ExprKind::Select(base, Select::ArrayElement(false), key) if self.pending.is_none() && self.depth < PURE_LIMIT =>
				self.plain_array_operand(base, key, Self::plain_element_value, |n| Some(n.into_value())),
			ExprKind::Call(Call { target: CallTarget::Builtin(b @ (Builtin::Shift | Builtin::Pop), origin), args: None, .. }) =>
				self.plain_remove_arg(*b, *origin),
			ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) | ExprKind::Variable(Sigil::Scalar, _) => self.eval_leaf(e),
			_ => None,
		}
	}

	/// None leaves the interpreter untouched; a successful compound assignment has updated its cell.
	#[inline]
	pub(super) fn try_plain_binary(&self, e: &Expr, cx: Cx) -> Option<Value> {
		let ExprKind::Binary(op, a, b) = &e.kind else { return None; };
		if self.pending.is_some() || self.depth >= PURE_LIMIT { return None; }
		match *op {
			Binary::AssignOp(c) => self.plain_compound(c, a, b, cx),
			op => self.plain_binary_expr(op, a, b),
		}
	}

	#[inline(always)]
	fn leaf_cell(&self, e: &Expr) -> Option<&Sv> {
		let ExprKind::Variable(Sigil::Scalar, name) = &e.kind else { return None; };
		self.numeric_cell(e, name)
	}

	#[inline(always)]
	fn numeric_cell(&self, e: &Expr, name: &str) -> Option<&Sv> {
		match self.pad_slot_at(e, Sigil::Scalar, name) {
			Some(Slot::Scalar(sv)) => Some(sv),
			None if name == "_" => self.topics.last(),
			_ => None,
		}
	}

	#[inline]
	fn with_scalar_leaf<T>(&mut self, e: &Expr, name: &str, read: impl FnOnce(&Sv) -> T) -> Option<T> {
		match self.pad_slot_at(e, Sigil::Scalar, name) {
			Some(Slot::Scalar(sv)) if !sv.has_read_magic() => Some(read(sv)),
			None if name == "_" => {
				let sv = self.topic();
				(!sv.has_read_magic()).then(|| read(&sv))
			}
			_ => None,
		}
	}

	/// Borrow an existing, untied named array's element for a callback-free read.
	/// Misses (including holes, `our` aliases and overloaded indices) use normal selection.
	#[inline]
	fn plain_array_operand<T>(&self, base: &Expr, key: &Expr, read: impl FnOnce(&Sv) -> Option<T>, number: impl FnOnce(Num) -> Option<T>) -> Option<T> {
		let ExprKind::Int(index) = &key.kind else { return None; };
		if !self.in_constant && !self.active_hints.constant_overloads.is_empty() { return None; }
		let ExprKind::Variable(_, name) = &base.kind else { return None; };
		let av = match self.pad_slot_at(base, Sigil::Array, name) {
			Some(Slot::Array(av)) => av,
			None if matches!(name.as_ref(), "_" | "main::_") => {
				if let Some(arg) = &self.prefix_arg {
					if !matches!(*index, 0 | -1) { return None; }
					return match arg {
						calls::PrefixArg::Cell(sv) => read(sv),
						calls::PrefixArg::Number(n) => number(*n),
						calls::PrefixArg::Empty => None,
					};
				}
				&self.active_subs.last()?.1
			}
			_ => return None,
		};
		if av.tie().is_some() { return None; }
		let elems = av.elems();
		let index = if *index < 0 { (elems.len() as i64).checked_add(*index)? } else { *index };
		let sv = elems.get(usize::try_from(index).ok()?)?;
		if Rc::ptr_eq(sv, &self.hole) { return None; }
		read(sv)
	}

	fn plain_element_value(sv: &Sv) -> Option<Value> {
		if sv.has_read_magic() { return None; }
		let value = sv.get();
		// The deferred evaluator enrolls regexp results in destructor tracking.
		(!matches!(value, Value::Ref(Ref::Regexp(_)))).then_some(value)
	}

	fn plain_remove_arg(&mut self, b: Builtin, origin: BuiltinOrigin) -> Option<Value> {
		if self.pending.is_some() || self.depth >= PURE_LIMIT || !self.builtin_uses_core(b, origin)
			|| !self.active_hints.autodie.is_empty() { return None; }
		if let Some(arg) = &mut self.prefix_arg {
			let value = arg.value()?;
			if matches!(value, Value::Ref(Ref::Regexp(_))) { return None; }
			*arg = calls::PrefixArg::Empty;
			return Some(value);
		}
		if !self.isa_globs.is_empty() { return None; }
		let av = &self.active_subs.last()?.1;
		if av.tie().is_some() || modules::readonly_array(self, av) { return None; }
		let mut elems = av.elems_mut();
		let Some(sv) = (if b == Builtin::Shift { elems.first() } else { elems.last() }) else { return Some(Value::Undef); };
		let value = Self::plain_element_value(sv)?;
		if b == Builtin::Shift { elems.remove(0); } else { elems.pop(); }
		Some(value)
	}

	/// An explicit, callback-free scalar operand of print/split. Do not fetch a magical
	/// operand while another operand or the output layer still has work to do.
	pub(in crate::perl) fn plain_scalar_cell(&mut self, e: &Expr) -> Option<Sv> {
		if self.pending.is_some() || self.depth >= DEPTH_LIMIT { return None; }
		let ExprKind::Variable(Sigil::Scalar, name) = &e.kind else { return None; };
		self.with_scalar_leaf(e, name, Rc::clone)
	}

	/// Evaluate a pure arithmetic tree under the current pad, topic and hints. Only arithmetic roots
	/// qualify: returning a bare scalar as a number would lose its string facet or its identity.
	pub(super) fn plain_numeric_expr(&self, e: &Expr) -> Option<Num> {
		if self.pending.is_some() || self.depth >= PURE_LIMIT || !matches!(&e.kind, ExprKind::Binary(..)) { return None; }
		self.plain_number_at(e, PURE_LEVELS)
	}

	#[inline(always)]
	fn plain_number_at(&self, e: &Expr, remaining: u8) -> Option<Num> {
		match &e.kind {
			ExprKind::Variable(Sigil::Scalar, name) => plain_num(&*self.numeric_cell(e, name)?.plain_value()?),
			ExprKind::Select(base, Select::ArrayElement(false), key) =>
				self.plain_array_operand(base, key, |sv| plain_num(&*sv.plain_value()?), Some),
			ExprKind::Group(inner) | ExprKind::Unary(Unary::Plus, inner) if remaining != 0 =>
				self.plain_number_at(inner, remaining - 1),
			ExprKind::Binary(op @ (Binary::Add | Binary::Sub | Binary::Mul | Binary::Div | Binary::Mod | Binary::Pow), a, b) if remaining != 0 =>
				self.plain_arithmetic(*op, a, b, remaining - 1),
			_ if !self.in_constant && !self.active_hints.constant_overloads.is_empty() => None,
			ExprKind::Int(n) => Some(Num::Int(*n)),
			ExprKind::UInt(n) => Some(Num::UInt(*n)),
			ExprKind::Float(n) => Some(Num::Float(*n)),
			_ => None,
		}
	}

	// Recurse only for arithmetic subtrees; both leaves of `$i * 2` are inlined.
	fn plain_arithmetic(&self, op: Binary, a: &Expr, b: &Expr, remaining: u8) -> Option<Num> {
		arithmetic(op, self.plain_number_at(a, remaining)?, self.plain_number_at(b, remaining)?, self.active_hints.integer).ok()
	}

	/// Only lends storage to a non-reentrant, interpreter-independent operation.
	fn with_leaf_text<T>(&self, e: &Expr, f: impl FnOnce(&PStr) -> T) -> Option<T> {
		match &e.kind {
			ExprKind::String(s) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(f(s)),
			ExprKind::Variable(..) => Some(f(self.leaf_cell(e)?.plain_value()?.as_pstr()?)),
			_ => None,
		}
	}

	fn plain_binary_expr(&self, op: Binary, a: &Expr, b: &Expr) -> Option<Value> {
		use Binary::*;
		match op {
			Add | Sub | Mul | Div | Mod | Pow | Eq | Ne | Lt | Le | Gt | Ge | Cmp => {
				numeric_binary(op, self.plain_number_at(a, PURE_LEVELS - 1)?, self.plain_number_at(b, PURE_LEVELS - 1)?, self.active_hints.integer).ok()
			}
			Concat | StrEq | StrNe | StrLt | StrLe | StrGt | StrGe | StrCmp => self.with_leaf_text(a, |left| {
				self.with_leaf_text(b, |right| {
					if op == Concat {
						let mut result = PStr::new(Vec::with_capacity(left.bytes.len().saturating_add(right.bytes.len())), false);
						result.push(left);
						result.push(right);
						Value::Str(result)
					} else {
						comparison(op, Some(if self.active_hints.bytes { left.bytes.cmp(&right.bytes) } else { left.cmp(right) }))
					}
				})
			})?,
			_ => None,
		}
	}

	fn plain_compound(&self, compound: Compound, left: &Expr, right: &Expr, cx: Cx) -> Option<Value> {
		let op = match compound {
			Compound::Add | Compound::Sub | Compound::Mul | Compound::Div | Compound::Mod | Compound::Pow => compound_op(compound),
			_ => return None,
		};
		// A compound assignment's shortcut for direct lexical lvalues does not apply to the global topic.
		let rhs = self.plain_number_at(right, PURE_LEVELS)?;
		let owned;
		let cell: &Sv = match &left.kind {
			ExprKind::Variable(Sigil::Scalar, name) => match self.pad_slot_at(left, Sigil::Scalar, name) {
				Some(Slot::Scalar(cell)) => cell,
				_ => match self.cached_package_slot(left, Sigil::Scalar, name) {
					Some(Slot::Scalar(cell)) => { owned = cell; &owned }
					_ => return None,
				},
			},
			ExprKind::Select(base, Select::ArrayElement(false), key) => {
				owned = self.plain_array_operand(base, key, |sv| Some(sv.clone()), |_| None)?;
				&owned
			}
			_ => return None,
		};
		let old = plain_num(&*cell.plain_value()?)?;
		if self.is_readonly_sv(cell) { return None; }
		let n = arithmetic(op, old, rhs, self.active_hints.integer).ok()?;
		cell.set_number(n);
		cell.set_pos(None);
		Some(if cx == Cx::Void { Value::Undef } else { n.into_value() })
	}

	/// A native callback may enter another interpreter driver before the async
	/// evaluator gets a chance to spill. Keep its headroom check at call boundaries.
	#[inline]
	pub(super) fn check_headroom(&self) {
		if self.depth % STACK_CHECK_EVERY == 0 { crate::stack::guard(128 * 1024, || ()); }
	}
	#[inline]
	pub(super) async fn nested<T>(&mut self, f: impl AsyncFnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		self.check_headroom();
		self.depth_guard(f).await
	}

	/// Sync [`nested`] for callers that cannot await (transform's non-recursive helpers).
	pub(super) fn nested_sync<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		if self.depth % STACK_CHECK_EVERY == 0 { crate::stack::guard(128 * 1024, || self.depth_guard_sync(f)) } else { self.depth_guard_sync(f) }
	}

	fn depth_guard_sync<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		if self.depth >= DEPTH_LIMIT { return Err(self.die_msg("Deep recursion limit exceeded")); }
		self.depth += 1;
		let result = f(self);
		self.depth -= 1;
		result
	}

	/// Leaves that cannot fail, warn, recurse or run Perl code (literals without constant overloading, plain
	/// lexical scalars), evaluated without the per-node bookkeeping of `eval`. Their value is the same in every
	/// context.
	#[inline]
	fn eval_leaf(&mut self, e: &Expr) -> Option<Value> {
		if self.pending.is_some() { return None; }
		match &e.kind {
			ExprKind::Int(n) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(Value::Int(*n)),
			ExprKind::UInt(n) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(Value::UInt(*n)),
			ExprKind::Float(n) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(Value::Num(*n)),
			ExprKind::String(s) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(Value::Str(s.clone())),
			ExprKind::Variable(Sigil::Scalar, name) => self.with_scalar_leaf(e, name, |sv| sv.get()),
			_ => None,
		}
	}

	/// Runs `f` with `loc` as the current location, restoring the previous one afterwards. Nested nodes usually
	/// share their parent's location, which then needs no copying.
	#[inline]
	pub(super) async fn at_location<T>(&mut self, loc: &Location, f: impl AsyncFnOnce(&mut Self) -> T) -> T {
		let saved = self.enter_location(loc);
		let result = f(self).await;
		self.leave_location(loc, saved);
		result
	}

	/// Sync [`at_location`] for callers that cannot await.
	pub(super) fn at_location_sync<T>(&mut self, loc: &Location, f: impl FnOnce(&mut Self) -> T) -> T {
		let saved = self.enter_location(loc);
		let result = f(self);
		self.leave_location(loc, saved);
		result
	}

	#[inline]
	fn enter_location(&mut self, loc: &Location) -> Option<Location> {
		(self.loc.line != loc.line || !Rc::ptr_eq(&self.loc.file, &loc.file)).then(|| std::mem::replace(&mut self.loc, loc.clone()))
	}

	#[inline]
	fn leave_location(&mut self, loc: &Location, saved: Option<Location>) {
		if let Some(old) = saved { self.loc = old; }
		else if self.loc.line != loc.line || !Rc::ptr_eq(&self.loc.file, &loc.file) { self.loc = loc.clone(); }
	}

	/// Evaluate an expression, requesting a scalar result.
	pub async fn eval_scalar_async(&mut self, e: &Expr) -> PResult<Value> {
		if let Some(value) = self.eval_immediate(e, Cx::Scalar) { return Ok(value); }
		self.eval_deferred(e, Cx::Scalar, 1).await.map(Ret::scalar)
	}

	/// Sync entry for native callbacks and coercion paths: drives the async
	/// evaluator on the blocking worker, spilling recursion to the heap queue.
	pub fn eval_scalar(&mut self, e: &Expr) -> PResult<Value> {
		// SAFETY: interpreter recursion awaits one child directly to completion; it never selects, cancels, or polls those futures independently.
		unsafe { crate::deep::run(self.eval_scalar_async(e)) }
	}
	/// Evaluate an expression in list context and copy its values.
	pub async fn eval_list_async(&mut self, e: &Expr) -> PResult<Vec<Value>> { self.eval_async(e, Cx::List).await.map(Ret::list) }

	/// Sync entry for native callbacks and coercion paths.
	pub fn eval_list(&mut self, e: &Expr) -> PResult<Vec<Value>> {
		// SAFETY: interpreter recursion awaits one child directly to completion; it never selects, cancels, or polls those futures independently.
		unsafe { crate::deep::run(self.eval_list_async(e)) }
	}

	/// Select the operation before allocating its recursion frame. In particular
	/// a conditional or named call must not carry the string-eval compiler in its frame.
	fn eval_operation<'a>(&'a mut self, e: &'a Expr, cx: Cx) -> Operation<'a> {
		// Keep plentiful native headroom for the nested driver and synchronous
		// callbacks. With less headroom (or unknown stack bounds) only the heap
		// driver polls this expression. Debug frames always take the latter path.
		let on_stack = !cfg!(debug_assertions) && crate::stack::remaining().is_some_and(|left| left > 768 * 1024);
		match &e.kind {
			ExprKind::Call(call @ Call { target: CallTarget::Named(name, amp), .. }) => self.named_operation(e, call, name, *amp, cx, on_stack),
			ExprKind::Call(call @ Call { target: CallTarget::Code(code, amp), .. }) => Operation::start(on_stack, self.eval_code_call(call, code, *amp, cx)),
			ExprKind::Call(call) => Operation::start(on_stack, self.eval_call(call, cx)),
			ExprKind::Conditional(cond, yes, no) => Operation::start(on_stack, async move {
				let branch = if self.eval_truth(cond).await? { yes } else { no };
				self.eval_async(branch, cx).await
			}),
			ExprKind::Binary(Binary::Assign, a, b) => Operation::start(on_stack, self.assign(a, b, cx)),
			ExprKind::Binary(Binary::AssignOp(op), a, b) => Operation::start(on_stack, async move { self.compound(*op, a, b, cx).await.map(Ret::One) }),
			ExprKind::Binary(Binary::Bind(_) | Binary::And | Binary::Or | Binary::DefinedOr, ..) => Operation::start(on_stack, self.eval_inner(e, cx)),
			ExprKind::Binary(op @ (Binary::SmartMatch | Binary::Range(_) | Binary::Repeat | Binary::Isa), a, b) =>
				Operation::start(on_stack, self.binary_special(e as *const Expr as usize, *op, a, b, cx)),
			ExprKind::Binary(op, a, b) => Operation::start(on_stack, self.binary_pair(*op, a, b)),
			_ => Operation::start(on_stack, self.eval_inner(e, cx)),
		}
	}

	async fn eval_inner(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		let value = match &e.kind {
			ExprKind::Int(n) => self.constant_value("integer", Value::Int(*n))?,
			ExprKind::UInt(n) => self.constant_value("integer", Value::UInt(*n))?,
			ExprKind::Float(n) => self.constant_value("float", Value::Num(*n))?,
			ExprKind::String(s) => self.constant_value("q", Value::Str(s.clone()))?,
			ExprKind::Version(cps) => Value::Str(PStr::from_codepoints(cps.iter().copied())),
			ExprKind::Quote(kind, parts) => {
				let s = if *kind == QuoteKind::Glob && let [QuotePart::Expr(e, false)] = parts.as_slice() {
					let value = self.eval_scalar_async(e).await?;
					if let Some(ret) = self.overload_builtin("<>", &value, None, cx)? { return Ok(ret); }
					self.interpolation_value(e, value, "string")?
				} else { self.interpolate_async(parts, InterpMode::String).await? };
				match kind {
					QuoteKind::String => Value::Str(s),
					QuoteKind::Command => return func::sys::backticks(self, s, cx),
					QuoteKind::Glob => return func::sys::glob_at(self, e as *const Expr as usize, s, cx),
				}
			}
			ExprKind::Regex(re) => return rx::eval_regex(self, re, None, false, cx),
			ExprKind::Bareword(name) => {
				if self.active_hints.strict_subs && !name.ends_with("::") {
					return Err(self.die_msg(format!("Bareword \"{name}\" not allowed while \"strict subs\" in use")));
				}
				Value::str(name.strip_suffix("::").unwrap_or(name))
			}
			ExprKind::Special(Special::File) => Value::str(&e.location.file),
			ExprKind::Special(Special::Line) => Value::Int(i64::from(e.location.line)),
			ExprKind::Special(Special::Package(pkg)) => Value::str(pkg),
			ExprKind::Special(Special::Sub) => self.active_subs.last().map_or(Value::Undef, |(cv, _, _)| Value::Ref(Ref::Code(cv.clone()))),
			ExprKind::Variable(sigil, name) => return self.eval_var(e, *sigil, name, cx).await,
			ExprKind::Deref(sigil, operand) => return self.eval_deref(*sigil, operand, cx).await,
			ExprKind::Select(base, select, key) => return self.read_selection(base, *select, key, cx).await,
			ExprKind::Array(q) => Value::Ref(Ref::Array(new_av(self.eval_list_async(q).await?))),
			ExprKind::Hash(q) => {
				let h = new_hv();
				let values = self.eval_list_async(q).await?;
				self.fill_hash_async(&h, values).await?;
				Value::Ref(Ref::Hash(h))
			}
			ExprKind::List(items) => {
				if cx == Cx::List {
					let mut values = Vec::new();
					for operand in items { self.eval_async(operand, Cx::List).await?.append_to(&mut values); }
					return Ok(Ret::Many(values));
				}
				let Some((last, earlier)) = items.split_last() else { return Ok(Ret::One(Value::Undef)); };
				for item in earlier { self.eval_async(item, Cx::Void).await?; }
				return self.eval_async(last, cx).await;
			}
			ExprKind::Group(_) | ExprKind::Unary(Unary::Plus, _) => unreachable!("tail operand traversed by eval_deferred"),
			ExprKind::Declare(kind, class, target, attrs) => return self.read_declaration(*kind, class.as_ref(), target, attrs, e as *const Expr as usize, cx).await,
			ExprKind::Unary(op, operand) => return self.unary(*op, operand, cx).await,
			ExprKind::Binary(Binary::Bind(neg), a, b) => return rx::bind_expr(self, a, b, *neg, cx),
			ExprKind::Binary(op @ (Binary::And | Binary::Or | Binary::DefinedOr), a, b) => {
				let value = self.eval_scalar_async(a).await?;
				return if self.short_circuit(*op, &value)? { self.eval_async(b, cx).await } else { Ok(Ret::One(value)) };
			}
			ExprKind::Binary(..) | ExprKind::Call(..) | ExprKind::Conditional(..) => unreachable!("dispatched by eval_operation"),
			ExprKind::CompareChain(first, rest) => {
				let mut left = self.eval_scalar_async(first).await?;
				for (op, rhs) in rest {
					let right = self.eval_scalar_async(rhs).await?;
					let v = self.binary_values(*op, &left, &right)?;
					if !self.truthy(&v)? { return Ok(Ret::One(perl_bool(false))); }
					left = right;
				}
				perl_bool(true)
			}
			ExprKind::Sub(sub) => {
				let cv = self.make_sub(sub, None, self.capture_pad(sub.body.as_deref()));
				// `sub : const {...}` runs once now and becomes a constant sub of that value (perlsub).
				if sub.attributes.iter().any(|attr| attr.name.as_ref() == "const") {
					let values = self.call_sub_async(&cv, Vec::new(), Cx::List).await?.list();
					cv.body.replace(CodeImpl::Constant(Rc::from(values)));
				}
				Value::Ref(Ref::Code(cv))
			}
			ExprKind::Block(block, true) => return self.eval_block_async(block, cx).await,
			ExprKind::Block(block, false) => return self.run_block_async(block, cx).await,
			ExprKind::Readline(source) => return func::sys::readline(self, source, cx),
			ExprKind::FileTest(kind, operand) => return func::sys::file_test(self, *kind, operand.as_deref()).map(Ret::One),
			ExprKind::Yada => return Err(self.die_msg("Unimplemented")),
		};
		Ok(Ret::One(value))
	}

	/// `defined($scalar = <FH>)` needs the assignment's definedness, not another copy
	/// of the input record. Keep every node frame and evaluate the lvalue *after* reading:
	/// magic on the handle can change which scalar the name denotes.
	pub(super) async fn defined_read_assignment(&mut self, e: &Expr, lhs: &Expr, rhs: &Expr) -> PResult<bool> {
		self.at_location(&e.location, async move |this| this.nested(async move |this| {
			if let Some(flow) = this.take_pending() { return Err(flow); }
			let result = if let ExprKind::Group(inner) | ExprKind::Unary(Unary::Plus, inner) = &e.kind {
				Box::pin(this.defined_read_assignment(inner, lhs, rhs)).await
			} else {
				(async {
					let value = this.eval_scalar_async(rhs).await?;
					let cell = match &lhs.kind {
						ExprKind::Variable(Sigil::Scalar, name) if let Some(Slot::Scalar(cell)) = this.pad_slot_at(lhs, Sigil::Scalar, name) => cell.clone(),
						_ => this.eval_lvalue_async(lhs).await?,
					};
					if matches!(value, Value::Str(_) | Value::Undef) && !cell.registered() && !cell.is_magical()
						&& !this.is_readonly_sv(&cell) {
						let defined = !value.is_undef();
						if let Value::Str(old) = cell.replace(value) { this.sys.recycle_record(old.bytes); }
						cell.set_pos(None);
						Ok(defined)
					} else {
						let tied = this.scalar_tie(&cell).is_some();
						let stored = this.store_sv(&cell, value.clone())?;
						let assigned = if tied { this.read_sv(&cell)? } else { stored.unwrap_or(value) };
						let defined = !assigned.is_undef();
						if this.pending.is_none() && matches!(assigned, Value::Ref(Ref::Regexp(_))) { this.track_ret(&Ret::One(assigned)); }
						Ok(defined)
					}
				}).await
			};
			if let Some(flow) = this.take_pending() { return Err(flow); }
			result
		}).await).await
	}

	fn constant_value(&mut self, kind: &str, value: Value) -> PResult<Value> {
		if self.in_constant || self.active_hints.constant_overloads.is_empty() { return Ok(value); }
		let Some(handler) = self.active_hints.constant_overloads.get(kind).cloned() else { return Ok(value); };
		let Some(cv) = self.code_value(&handler, false)? else { return Ok(value); };
		let source = value.to_pstr();
		// Do not feed constants inside the conversion callback back into itself.
		self.in_constant = true;
		let result = self.call_sub(&cv, vec![new_sv(Value::Str(source)), new_sv(value), new_sv(Value::str(kind))], Cx::Scalar);
		self.in_constant = false;
		result.map(Ret::scalar)
	}

	async fn unary(&mut self, op: Unary, operand: &Expr, cx: Cx) -> PResult<Ret> {
		use Unary::*;
		if op == Reference { return self.reference(operand, cx).await; }
		if matches!(op, PreInc | PreDec | PostInc | PostDec) {
			let target = ungroup(operand);
			let cell = match &target.kind {
				ExprKind::Variable(Sigil::Scalar, name) if let Some(Slot::Scalar(sv)) = self.pad_slot_at(target, Sigil::Scalar, name) => sv.clone(),
				_ => self.eval_lvalue_async(operand).await?,
			};
			// Repeated counters (including a newly vivified undef hash element) need neither a
			// copied old scalar nor a magic STORE. Post-decrement preserves an undef old value.
			let count = cell.plain_value().and_then(|v| match *v {
				Value::Int(n) => Some((n, false)), Value::Undef => Some((0, true)), _ => None,
			});
			if let Some((n, undef)) = count && !self.is_readonly_sv(&cell)
				&& let Some(next) = if matches!(op, PreInc | PostInc) { n.checked_add(1) } else { n.checked_sub(1) } {
				cell.set_number(Num::Int(next));
				cell.set_pos(None);
				return Ok(Ret::One(match op {
					PostDec if undef => Value::Undef, PostInc | PostDec => Value::Int(n), _ => Value::Int(next),
				}));
			}
			let old = self.read_sv(&cell)?;
			let plus = matches!(op, PreInc | PostInc);
			let next = if matches!(&old, Value::Ref(_))
				&& let Some(value) = self.overload_inc(plus, &old, cx != Cx::Void && matches!(op, PostInc | PostDec))? { value }
			else if plus { ops::incr(&old) } else { ops::decr(&old) };
			// sv_inc/sv_dec: an NV beyond 2**53 can no longer change by 1.
			if let Value::Num(was) = old {
				const LIMIT: f64 = 9_007_199_254_740_992.0;
				if plus && was >= LIMIT { self.warn_category("imprecision", format!("Lost precision when incrementing {was:.6} by 1")); }
				if !plus && was <= -LIMIT { self.warn_category("imprecision", format!("Lost precision when decrementing {was:.6} by 1")); }
			}
			let result = if matches!(op, PostInc | PostDec) {
				if op == PostInc && old.is_undef() { Value::Int(0) } else { old }
			} else { next.clone() };
			self.write_sv(&cell, next)?;
			return Ok(Ret::One(result));
		}
		let v = if op == Minus && let ExprKind::Bareword(word) = &ungroup(operand).kind { Value::str(word) }
		else { self.eval_scalar_async(operand).await? };
		let result = match op {
			Plus => v,
			Minus => {
				if let Some(value) = self.overload_unary("neg", &v)? { value }
				else if self.active_hints.integer && !matches!(v, Value::Str(_)) { Value::Int(ops::int_neg(self.numify(&v)?.wrapping_iv())) }
				else { ops::neg(&v) }
			}
			Not => if let Some(value) = self.overload_unary("!", &v)? { value } else { perl_bool(!self.truthy(&v)?) },
			Complement => {
				if let Some(value) = self.overload_unary("~", &v)? { value }
				else if self.active_hints.integer { Value::Int(ops::int_bit_not(self.numify(&v)?.wrapping_iv())) }
				else if self.active_hints.features.bitwise { ops::num_bit_not(&self.numify(&v)?.into_value()) }
				else { ops::bit_not(&v).map_err(|m| self.die_msg(m))? }
			}
			StringComplement => {
				if let Some(value) = self.overload_unary("~.", &v)? { value }
				else { ops::str_bit_not(&v).map_err(|m| self.die_msg(m))? }
			}
			_ => return Err(self.die_msg("Invalid unary operator")),
		};
		Ok(Ret::One(result))
	}

	async fn binary_special(&mut self, site: usize, op: Binary, left: &Expr, right: &Expr, cx: Cx) -> PResult<Ret> {
		use Binary::*;
		match op {
			SmartMatch => {
				let a = self.smartmatch_operand(left).await?;
				let b = self.smartmatch_operand(right).await?;
				return Ok(Ret::One(perl_bool(self.smartmatch(&a, &b).await?)));
			}
			Range(three) => {
				if cx != Cx::List { return self.flip_flop(site, left, right, three).await.map(Ret::One); }
				let start = self.eval_scalar_async(left).await?;
				let end = self.eval_scalar_async(right).await?;
				return ops::range(&start, &end).map(Ret::Many).map_err(|m| self.die_msg(m));
			}
			Repeat if cx == Cx::List && matches!(&left.kind, ExprKind::Group(_) | ExprKind::List(_)) => {
				let values = self.eval_list_async(left).await?;
				let count = self.eval_scalar_async(right).await?;
				let count = self.numify_with(&count, "repeat (x)")?.into_value().to_i64();
				if count < 0 { self.warn_category("numeric", "Negative repeat count does nothing"); }
				if count <= 0 || values.is_empty() { return Ok(Ret::empty()); }
				if count == 1 { return Ok(Ret::Many(values)); }
				let n = values.len().checked_mul(count as usize).filter(|&n| n <= ops::MAX_LIST);
				let mut result = Vec::new();
				let Some(n) = n else { return Err(self.die_msg("Out of memory during list extend")); };
				if result.try_reserve(n).is_err() { return Err(self.die_msg("Out of memory during list extend")); }
				for _ in 1..count { result.extend(values.iter().cloned()); }
				result.extend(values);
				return Ok(Ret::Many(result));
			}
			Isa => {
				let value = self.eval_scalar_async(left).await?;
				let class = if let ExprKind::Bareword(name) = &ungroup(right).kind { name.clone() }
				else { let v = self.eval_scalar_async(right).await?; Rc::from(self.stringify(&v)?.to_string_lossy().as_ref()) };
				// pp_isa calls the object's `isa` method when it is overridden, else checks the hierarchy directly.
				let yes = if let Value::Ref(r) = &value && let Some(pkg) = r.blessed() {
					let overridden = self.find_method(&pkg, "isa").filter(|cv| !matches!(*cv.body.borrow(), CodeImpl::Native(_)));
					if let Some(cv) = overridden {
						let result = self.call_sub_async(&cv, vec![new_sv(value.clone()), new_sv(Value::Str(PStr::from_str(&class)))], Cx::Scalar).await?.scalar();
						self.truthy(&result)?
					} else { self.isa(&pkg, &class)? }
				} else { false };
				return Ok(Ret::One(perl_bool(yes)));
			}
			_ => {}
		}
		self.binary_pair(op, left, right).await
	}

	async fn binary_pair(&mut self, op: Binary, left: &Expr, right: &Expr) -> PResult<Ret> {
		let a = self.eval_scalar_async(left).await?;
		let b = self.eval_scalar_async(right).await?;
		self.binary_pair_values(op, left, a, right, b)
	}

	fn binary_pair_values(&mut self, op: Binary, left: &Expr, mut a: Value, right: &Expr, b: Value) -> PResult<Ret> {
		if op == Binary::Concat && let (Value::Str(x), Some(y)) = (&mut a, b.as_pstr()) {
			x.push(y);
			return Ok(Ret::One(a));
		}
		let names = [if a.is_undef() { operand_name(left) } else { None }, if b.is_undef() { operand_name(right) } else { None }];
		self.binary_values_named(op, &a, &b, names).map(Ret::One)
	}

	#[inline]
	fn short_circuit(&mut self, op: Binary, value: &Value) -> PResult<bool> {
		match op {
			Binary::And => self.truthy(value), Binary::Or => Ok(!self.truthy(value)?),
			Binary::DefinedOr => Ok(value.is_undef()), _ => Ok(true),
		}
	}

	async fn range_test(&mut self, e: &Expr) -> PResult<bool> {
		if matches!(&ungroup(e).kind, ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_)) {
			let n = self.eval_scalar_async(e).await?.to_i64();
			return Ok(self.magic_scalar(".").unwrap_or(Value::Undef).to_i64() == n);
		}
		self.eval_truth(e).await
	}

	fn plain_truth(&self, e: &Expr) -> Option<bool> {
		use Binary::*;
		match &e.kind {
			ExprKind::Variable(Sigil::Scalar, _) => {
				let v = self.leaf_cell(e)?.plain_value()?;
				(!matches!(&*v, Value::Ref(_))).then(|| v.truthy())
			}
			ExprKind::Binary(Add | Sub | Mul | Div | Mod | Pow, ..) if self.depth < PURE_LIMIT =>
				Some(self.plain_number_at(e, PURE_LEVELS)?.into_value().truthy()),
			ExprKind::Binary(op @ (Eq | Ne | Lt | Le | Gt | Ge), lhs, rhs) if self.depth < PURE_LIMIT => {
				let a = self.plain_number_at(lhs, PURE_LEVELS - 1)?;
				let b = self.plain_number_at(rhs, PURE_LEVELS - 1)?;
				let order = if self.active_hints.integer { Some(a.wrapping_iv().cmp(&b.wrapping_iv())) } else { ops::num_cmp(a, b) };
				Some(comparison_truth(*op, order))
			}
			_ => None,
		}
	}

	pub(super) async fn eval_truth(&mut self, e: &Expr) -> PResult<bool> {
		use Binary::*;
		if self.pending.is_none() {
			match &e.kind {
				// A scalar match returns only Perl's true/false value, even when matching
				// runs callbacks. Keep its location, depth and deferred exceptions, but don't
				// materialize an evaluator result or test it for list/regexp/overload magic.
				ExprKind::Regex(re) if matches!(re.kind, RegexKind::Match(_)) => {
					return self.at_location(&e.location, async move |this| this.nested(async move |this| {
						let result = rx::eval_regex(this, re, None, false, Cx::Scalar);
						if let Some(flow) = this.take_pending() { return Err(flow); }
						result.map(|ret| ret.scalar().truthy())
					}).await).await;
				}
				ExprKind::Variable(Sigil::Scalar, _) => if let Some(v) = self.plain_truth(e) { return Ok(v); },
				ExprKind::Binary(Eq | Ne | Lt | Le | Gt | Ge, ..) if self.depth < PURE_LIMIT => {
					if let Some(v) = self.plain_truth(e) { return Ok(v); }
					let v = self.eval_deferred(e, Cx::Scalar, 1).await?.scalar();
					return self.truthy(&v);
				}
				_ => {}
			}
		}
		let v = self.eval_scalar_async(e).await?;
		self.truthy(&v)
	}

	async fn flip_flop(&mut self, site: usize, start: &Expr, end: &Expr, three: bool) -> PResult<Value> {
		let n = self.persistent.borrow().flip_flops.get(&site).copied().unwrap_or(0);
		if n == 0 && !self.range_test(start).await? { return Ok(perl_bool(false)); }
		let finished = !(three && n == 0) && self.range_test(end).await?;
		let n = n.saturating_add(1);
		if finished {
			self.persistent.borrow_mut().flip_flops.remove(&site);
			Ok(Value::str(&format!("{n}E0")))
		} else {
			self.persistent.borrow_mut().flip_flops.insert(site, n);
			Ok(Value::Int(n as i64))
		}
	}

	async fn compound(&mut self, compound: Compound, left: &Expr, right: &Expr, cx: Cx) -> PResult<Value> {
		use Binary as B;
		let op = compound_op(compound);
		let target = ungroup(left);
		if let ExprKind::Call(call @ Call { target: CallTarget::Builtin(b @ (Builtin::Substr | Builtin::Pos | Builtin::Vec | Builtin::Keys), _), .. }) = &target.kind {
			let old = self.eval_scalar_async(target).await?;
			if !self.short_circuit(op, &old)? { return Ok(old); }
			let rhs = self.eval_scalar_async(right).await?;
			let value = if matches!(op, B::And | B::Or | B::DefinedOr) { rhs } else { self.binary_values(op, &old, &rhs)? };
			return func::assign(self, *b, call, value);
		}
		let cell = match &target.kind {
			ExprKind::Variable(Sigil::Scalar, name) if let Some(Slot::Scalar(sv)) = self.pad_slot_at(target, Sigil::Scalar, name) => sv.clone(),
			_ => self.eval_lvalue_async(left).await?,
		};
		if op == B::Concat && let Some(value) = self.append_in_place(&cell, right, cx).await? { return Ok(value); }
		let old = self.read_sv(&cell)?;
		if !self.short_circuit(op, &old)? { return Ok(old); }
		let rhs = self.eval_scalar_async(right).await?;
		let value = self.combine_compound(op, &cell, old, rhs, cx != Cx::Void)?;
		// The operator's value is its target: a tied target is FETCHed again when that value is used.
		if cx != Cx::Void && self.scalar_tie(&cell).is_some() { return self.read_sv(&cell); }
		Ok(value)
	}

	/// `.=` on a plain string cell appends to its buffer (perl's in-place concatenation) instead of copying the
	/// string; None when the general path must handle it (magic, overloading, undef operands, warnings).
	async fn append_in_place(&mut self, cell: &Sv, right: &Expr, cx: Cx) -> PResult<Option<Value>> {
		let plain = |this: &Self| matches!(cell.plain_value().as_deref(), Some(Value::Str(_))) && !this.is_readonly_sv(cell);
		if !plain(self) { return Ok(None); }
		// Literal and lexical string RHSs cannot change the target. Do not allocate a temporary RHS
		// buffer or recheck the target. If the cells alias, the failed mutable borrow takes the copying path.
		if self.pending.is_none() && self.depth < DEPTH_LIMIT && let Some(Some(result)) = self.with_leaf_text(right, |piece| {
			let mut raw = cell.try_value_mut().ok()?;
			let Value::Str(s) = &mut *raw else { return None; };
			s.push(piece);
			Some(if cx == Cx::Void { Value::Undef } else { Value::Str(s.clone()) })
		}) {
			cell.set_pos(None);
			return Ok(Some(result));
		}
		let rhs = self.eval_scalar_async(right).await?;
		let piece = match &rhs {
			Value::Str(_) | Value::Int(_) | Value::UInt(_) | Value::Num(_) => rhs,
			_ => return self.compound_rhs(Compound::Concat, cell, rhs, cx).map(Some),
		};
		// Evaluating the right side may have changed the cell (`$x .= ($x = ...)`): recheck.
		if !plain(self) { return self.compound_rhs(Compound::Concat, cell, piece, cx).map(Some); }
		let Ok(mut value) = cell.try_value_mut() else { return self.compound_rhs(Compound::Concat, cell, piece, cx).map(Some) };
		let Value::Str(s) = &mut *value else { drop(value); return self.compound_rhs(Compound::Concat, cell, piece, cx).map(Some) };
		match &piece { Value::Str(p) => s.push(p), other => s.push(&other.to_pstr()) }
		let result = if cx == Cx::Void { Value::Undef } else { Value::Str(s.clone()) };
		drop(value);
		cell.set_pos(None);
		Ok(Some(result))
	}

	pub(super) async fn compound_cell(&mut self, compound: Compound, cell: &Sv, right: &Expr) -> PResult<Value> {
		let op = compound_op(compound);
		let old = self.read_sv(cell)?;
		if !self.short_circuit(op, &old)? { return Ok(old); }
		let rhs = self.eval_scalar_async(right).await?;
		self.combine_compound(op, cell, old, rhs, true)
	}

	/// `compound` with its right operand already evaluated (no short-circuit operators).
	fn compound_rhs(&mut self, compound: Compound, cell: &Sv, rhs: Value, cx: Cx) -> PResult<Value> {
		let old = self.read_sv(cell)?;
		let value = self.combine_compound(compound_op(compound), cell, old, rhs, cx != Cx::Void)?;
		if cx != Cx::Void && self.scalar_tie(cell).is_some() { return self.read_sv(cell); }
		Ok(value)
	}

	/// Stores `old OP rhs` into `cell`; the result is returned when `keep` (else undef, saving a copy).
	fn combine_compound(&mut self, op: Binary, cell: &Sv, old: Value, rhs: Value, keep: bool) -> PResult<Value> {
		use Binary as B;
		// The RHS may have called Perl or rebound/tied the target. Use the saved
		// LHS value, but only a currently ordinary writable cell can take a raw store.
		if matches!(op, B::Add | B::Sub | B::Mul | B::Div | B::Mod | B::Pow)
			&& let (Some(a), Some(b)) = (plain_num(&old), plain_num(&rhs))
			&& !cell.has_read_magic() && !cell.registered() && !self.is_readonly_sv(cell) {
			let n = arithmetic(op, a, b, self.active_hints.integer).map_err(|m| self.die_msg(m))?;
			cell.set_number(n);
			cell.set_pos(None);
			return Ok(if keep { n.into_value() } else { Value::Undef });
		}
		let value = if matches!(op, B::And | B::Or | B::DefinedOr) { rhs }
		else if (matches!(old, Value::Ref(_)) || matches!(rhs, Value::Ref(_)))
			&& let Some(value) = self.overload_binary(op_key(op), &old, &rhs, true)? { value }
		else if matches!(op, B::Add | B::Sub | B::Concat) && old.is_undef() {
			self.binary_values(op, &if op == B::Concat { Value::Str(PStr::default()) } else { Value::Int(0) }, &rhs)?
		} else { self.binary_values(op, &old, &rhs)? };
		if !keep { self.write_sv(cell, value)?; return Ok(Value::Undef); }
		self.write_sv(cell, value.clone())?;
		Ok(value)
	}

	fn binary_values(&mut self, op: Binary, a: &Value, b: &Value) -> PResult<Value> {
		self.binary_values_named(op, a, b, [None, None])
	}

	fn binary_values_named(&mut self, op: Binary, a: &Value, b: &Value, names: [Option<&str>; 2]) -> PResult<Value> {
		use Binary::*;
		let key = op_key(op);
		if (matches!(a, Value::Ref(_)) || matches!(b, Value::Ref(_))) && op != SmartMatch
			&& let Some(v) = self.overload_binary(key, a, b, false)? { return Ok(v); }
		let integer = self.active_hints.integer;
		Ok(match op {
			Add | Sub | Mul | Div | Mod | Pow | Eq | Ne | Lt | Le | Gt | Ge | Cmp => {
				let (a, b) = if let (Some(a), Some(b)) = (plain_num(a), plain_num(b)) { (a, b) } else {
					let name = op_description(op);
					let a = self.numify_with_named(a, name, if matches!(op, Add | Sub | Mul | Div | Mod | Pow) { names[0] } else { None })?;
					let b = self.numify_with_named(b, name, if matches!(op, Add | Sub | Mul | Div | Mod | Pow) { names[1] } else { None })?;
					(a, b)
				};
				numeric_binary(op, a, b, integer).map_err(|m| self.die_msg(m))?
			}
			Concat => {
				let mut a = self.stringify_with(a, "concatenation (.)")?.into_owned();
				a.push(self.stringify_with(b, "concatenation (.)")?.as_ref());
				Value::Str(a)
			}
			Repeat => {
				let a = self.stringify_with(a, "repeat (x)")?;
				let count = self.numify_with(b, "repeat (x)")?.into_value();
				let b = if let Value::Num(f) = count && !f.is_finite() {
					self.warn_category("numeric", "Non-finite repeat count does nothing");
					0
				} else { count.to_i64() };
				if b < 0 { self.warn_category("numeric", "Negative repeat count does nothing"); }
				Value::Str(ops::repeat(&a, b).map_err(|m| self.die_msg(m))?)
			}
			Shl | Shr => {
				let a = self.numify_with(a, op_description(op))?.into_value();
				let b = self.numify_with(b, op_description(op))?.into_value();
				match (op, integer) { (Shl, false) => ops::shl(&a, &b), (Shl, true) => ops::int_shl(&a, &b), (Shr, false) => ops::shr(&a, &b), _ => ops::int_shr(&a, &b) }
			}
			BitAnd | BitOr | BitXor if integer || self.active_hints.features.bitwise => {
				let a = self.numify_with(a, op_description(op))?;
				let b = self.numify_with(b, op_description(op))?;
				if integer {
					let a = a.wrapping_iv(); let b = b.wrapping_iv();
					Value::Int(match op { BitAnd => ops::int_bit_and(a, b), BitOr => ops::int_bit_or(a, b), _ => ops::int_bit_xor(a, b) })
				} else {
					let a = a.into_value(); let b = b.into_value();
					match op { BitAnd => ops::num_bit_and(&a, &b), BitOr => ops::num_bit_or(&a, &b), _ => ops::num_bit_xor(&a, &b) }
				}
			}
			BitAnd | BitOr | BitXor | StrAnd | StrOr | StrXor => {
				// A reference is not numeric (no IOK/NOK): against a string it takes part as its (possibly
				// overloaded) string form, making this a string operation.
				let textual = |v: &Value| matches!(v, Value::Str(_) | Value::Ref(_));
				let string_op = matches!(op, StrAnd | StrOr | StrXor) || textual(a) && textual(b);
				let (a_text, b_text);
				let a = if string_op && let Value::Ref(_) = a { a_text = Value::Str(self.stringify(a)?); &a_text } else { a };
				let b = if string_op && let Value::Ref(_) = b { b_text = Value::Str(self.stringify(b)?); &b_text } else { b };
				let result = match op {
					BitAnd => ops::bit_and(a, b), BitOr => ops::bit_or(a, b), BitXor => ops::bit_xor(a, b),
					StrAnd => ops::str_bit_and(a, b), StrOr => ops::str_bit_or(a, b), _ => ops::str_bit_xor(a, b),
				};
				result.map_err(|m| self.die_msg(m))?
			}
			StrEq | StrNe | StrLt | StrLe | StrGt | StrGe | StrCmp => {
				let a = self.stringify_with(a, key)?;
				let b = self.stringify_with(b, key)?;
				comparison(op, Some(if self.hints().bytes { a.bytes.cmp(&b.bytes) } else { ops::str_cmp(&a, &b) }))
			}
			Xor => perl_bool(self.truthy(a)? != self.truthy(b)?),
			// The operands are already evaluated; drive the async matcher on the blocking worker
			// exactly as the sync entry points do (the arm is otherwise unreachable).
			SmartMatch => perl_bool(unsafe { crate::deep::run(self.smartmatch(a, b)) }?),
			_ => return Err(self.die_msg("Invalid binary operator")),
		})
	}

	pub(super) async fn smartmatch(&mut self, a: &Value, b: &Value) -> PResult<bool> {
		crate::stack::guard(128 * 1024, || self.depth_guard(async move |this| Box::pin(this.smartmatch_inner(a, b)).await)).await
	}

	async fn smartmatch_inner(&mut self, a: &Value, b: &Value) -> PResult<bool> {
		// perlop "Smartmatch Operator": the right operand's type picks the rule, in this order.
		if b.is_undef() { return Ok(a.is_undef()); }
		if let Value::Ref(r) = b && r.blessed().is_some() && !matches!(r, Ref::Regexp(_)) {
			if let Some(v) = self.overload_binary("~~", a, b, false)? { return self.truthy(&v); }
			return Err(self.die_msg("Smart matching a non-overloaded object breaks encapsulation"));
		}
		let left = SmartOperand::of(a);
		match SmartOperand::of(b) {
			SmartOperand::Array(right) => {
				let items = self.smart_elements(&right).await?;
				match left {
					SmartOperand::Array(left) => {
						if Rc::ptr_eq(&left, &right) { return Ok(true); }
						let left = self.smart_elements(&left).await?;
						if left.len() != items.len() { return Ok(false); }
						for (x, y) in left.iter().zip(&items) { if !self.smartmatch(x, y).await? { return Ok(false); } }
						Ok(true)
					}
					SmartOperand::Hash(h) => {
						for item in &items { if self.smart_exists(&h, item)? { return Ok(true); } }
						Ok(false)
					}
					SmartOperand::Regexp => {
						for item in &items { if self.smart_regex(item, a)? { return Ok(true); } }
						Ok(false)
					}
					_ if a.is_undef() => Ok(items.iter().any(Value::is_undef)),
					_ => {
						for item in &items { if self.smartmatch(a, item).await? { return Ok(true); } }
						Ok(false)
					}
				}
			}
			SmartOperand::Hash(right) => match left {
				SmartOperand::Hash(left) => {
					let (x, y) = (self.hash_keys(&left)?, self.hash_keys(&right)?);
					Ok(x.len() == y.len() && x.iter().all(|k| y.contains(k)))
				}
				SmartOperand::Array(left) => {
					for item in self.smart_elements(&left).await? { if self.smart_exists(&right, &item)? { return Ok(true); } }
					Ok(false)
				}
				SmartOperand::Regexp => {
					for key in self.hash_keys(&right)? { if self.smart_regex(&Value::Str(key.to_pstr()), a)? { return Ok(true); } }
					Ok(false)
				}
				_ if a.is_undef() => Ok(false),
				_ => self.smart_exists(&right, a),
			},
			SmartOperand::Code(cv) => {
				let items: Vec<Value> = match left {
					SmartOperand::Array(arr) => self.smart_elements(&arr).await?,
					SmartOperand::Hash(h) => self.hash_keys(&h)?.iter().map(|k| Value::Str(k.to_pstr())).collect(),
					_ => {
						let result = self.call_sub_async(&cv, vec![new_sv(a.clone())], Cx::Scalar).await?.scalar();
						return self.truthy(&result);
					}
				};
				for item in items {
					let result = self.call_sub_async(&cv, vec![new_sv(item)], Cx::Scalar).await?.scalar();
					if !self.truthy(&result)? { return Ok(false); }
				}
				Ok(true)
			}
			SmartOperand::Regexp => match left {
				SmartOperand::Array(arr) => {
					for item in self.smart_elements(&arr).await? { if self.smart_regex(&item, b)? { return Ok(true); } }
					Ok(false)
				}
				SmartOperand::Hash(h) => {
					for key in self.hash_keys(&h)? { if self.smart_regex(&Value::Str(key.to_pstr()), b)? { return Ok(true); } }
					Ok(false)
				}
				_ => self.smart_regex(a, b),
			},
			SmartOperand::Other => {
				if let Value::Ref(r) = a && r.blessed().is_some() && let Some(v) = self.overload_binary("~~", a, b, false)? { return self.truthy(&v); }
				let number = |v: &Value| matches!(v, Value::Int(_) | Value::UInt(_) | Value::Num(_) | Value::Dual(_));
				if number(b) || (number(a) && b.looks_like_number()) {
					let (x, y) = (self.numify(a)?, self.numify(b)?);
					// `==` honours `use integer`.
					if self.active_hints.integer { return Ok(x.wrapping_iv() == y.wrapping_iv()); }
					return Ok(ops::num_cmp(x, y) == Some(Ordering::Equal));
				}
				if a.is_undef() { return Ok(false); }
				Ok(self.stringify(a)? == self.stringify(b)?)
			}
		}
	}

	/// The values of an array operand (tied arrays FETCH each element).
	async fn smart_elements(&mut self, av: &Av) -> PResult<Vec<Value>> {
		let cells = self.eval_array_aliases(av, false).await?;
		cells.iter().map(|sv| self.read_sv(sv)).collect()
	}

	/// `exists $h{VALUE}` for smartmatch (undef is the empty key).
	fn smart_exists(&mut self, h: &Hv, key: &Value) -> PResult<bool> {
		let key = if key.is_undef() { PStr::default() } else { self.stringify(key)? };
		if let Some(object) = self.tied_hash(h) {
			let found = self.call_method(object, "EXISTS", vec![Value::Str(key)], Cx::Scalar)?.scalar();
			return self.truthy(&found);
		}
		Ok(h.entries().contains_key(&HKey::new(&key)))
	}

	/// `VALUE =~ REGEXP` for smartmatch.
	fn smart_regex(&mut self, subject: &Value, regexp: &Value) -> PResult<bool> {
		let Value::Ref(Ref::Regexp(r)) = regexp else { return Ok(false); };
		let text = self.stringify(subject)?;
		Ok(r.regex.exec(&text, 0, crate::perl::regex::ExecOpts::default()).map_err(|m| self.die_msg(m))?.is_some())
	}

	/// Evaluates a smartmatch operand: arrays and hashes are taken by reference.
	pub(super) async fn smartmatch_operand(&mut self, e: &Expr) -> PResult<Value> {
		Ok(match &ungroup(e).kind {
			ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => Value::Ref(Ref::Array(self.eval_array_async(e).await?)),
			ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => Value::Ref(Ref::Hash(self.eval_hash_async(e).await?)),
			_ => self.eval_scalar_async(e).await?,
		})
	}

	/// Stringification with Perl overload conversion.
	pub fn stringify(&mut self, v: &Value) -> PResult<PStr> {
		if !matches!(v, Value::Ref(_)) { return Ok(v.to_pstr()); }
		Ok(self.convert_overload(v, &["\"\"", "0+", "bool"])?.map_or_else(|| v.to_pstr(), |v| v.to_pstr()))
	}

	/// `stringify` consuming the value: a plain string is returned without copying.
	pub(super) fn stringify_owned(&mut self, v: Value) -> PResult<PStr> {
		match v { Value::Str(s) => Ok(s), v => self.stringify(&v) }
	}

	/// Numeric conversion with Perl overload conversion.
	pub fn numify(&mut self, v: &Value) -> PResult<Num> {
		if !matches!(v, Value::Ref(_)) { return Ok(v.to_num()); }
		Ok(self.convert_overload(v, &["0+", "\"\"", "bool"])?.map_or_else(|| v.to_num(), |v| v.to_num()))
	}

	/// Test the value, preferring the `bool` overload when present.
	#[inline]
	pub fn truthy(&mut self, v: &Value) -> PResult<bool> {
		if !matches!(v, Value::Ref(_)) || self.overloads.is_empty() { return Ok(v.truthy()); }
		Ok(self.convert_overload(v, &["bool", "0+", "\"\""])?.map_or_else(|| v.truthy(), |v| v.truthy()))
	}

	fn stringify_with<'v>(&mut self, v: &'v Value, op: &str) -> PResult<Cow<'v, PStr>> {
		if let Some(s) = v.as_pstr() { return Ok(Cow::Borrowed(s)); }
		if v.is_undef() && self.warn_on("uninitialized") {
			self.warn_category("uninitialized", format!("Use of uninitialized value in {op}"));
		}
		self.stringify(v).map(Cow::Owned)
	}

	fn numify_with(&mut self, v: &Value, op: &str) -> PResult<Num> {
		self.numify_with_named(v, op, None)
	}

	fn numify_with_named(&mut self, v: &Value, op: &str, name: Option<&str>) -> PResult<Num> {
		if v.is_undef() && self.warn_on("uninitialized") {
			let message = name.map_or_else(|| format!("Use of uninitialized value in {op}"), |name| format!("Use of uninitialized value ${name} in {op}"));
			self.warn_category("uninitialized", message);
		} else if let Value::Str(s) = v && self.warn_on("numeric") && !v.is_numeric_string() {
			self.warn_category("numeric", format!("Argument \"{}\" isn't numeric in {op}", s.to_string_lossy()));
		}
		if let Some(flow) = self.take_pending() { return Err(flow); }
		self.numify(v)
	}

	/// Interpolate quote fragments, preserving bytes and applying case/quotemeta directives.
	pub fn interpolate(&mut self, parts: &[QuotePart], mode: InterpMode) -> PResult<PStr> {
		// SAFETY: interpreter recursion awaits one child directly to completion; it never selects, cancels, or polls those futures independently.
		unsafe { crate::deep::run(self.interpolate_async(parts, mode)) }
	}

	/// Interpolate quote fragments, preserving bytes and applying case/quotemeta directives.
	pub async fn interpolate_async(&mut self, parts: &[QuotePart], mode: InterpMode) -> PResult<PStr> {
		match parts {
			[] => return Ok(PStr::default()),
			[QuotePart::Literal(s)] => return Ok(s.clone()),
			[QuotePart::Expr(e, false)] => {
				let v = self.eval_scalar_async(e).await?;
				if mode == InterpMode::Regex && matches!(&v, Value::Ref(Ref::Regexp(_))) { return Ok(v.to_pstr()); }
				return self.interpolation_value(e, v, interpolation_op(mode, false, None, None));
			}
			_ => {}
		}
		let joined = parts.iter().filter(|part| match part {
			QuotePart::Literal(s) => !s.is_empty(),
			QuotePart::Expr(..) => true,
			_ => false,
		}).take(2).count() > 1;
		let mut output = PStr::default();
		let mut changes = Vec::new();
		let mut once = None;
		let mut pieces = Vec::new();
		let mut span = PStr::default();
		for part in parts {
			match part {
				QuotePart::Literal(s) => span.push(s),
				QuotePart::Case(operation) => {
					if !span.is_empty() || span.utf8 { pieces.push(std::mem::take(&mut span)); }
					changes.push((pieces.len(), *operation));
					once = match operation {
						CaseChange::UpperNext | CaseChange::LowerNext => Some(*operation),
						_ => None,
					};
				}
				QuotePart::Expr(e, false) => {
					if self.pending.is_none() && self.depth < DEPTH_LIMIT && let Some(nonempty) = self.with_leaf_text(e, |s| {
						span.push(s);
						!s.is_empty()
					}) {
						if nonempty { once = None; }
						continue;
					}
					let v = self.eval_scalar_async(e).await?;
					let s = if mode == InterpMode::Regex && matches!(v, Value::Ref(Ref::Regexp(_))) { v.to_pstr() }
					else { self.interpolation_value(e, v, interpolation_op(mode, joined, changes.last().map(|(_, op)| *op), once))? };
					if !s.is_empty() { once = None; }
					span.push(&s);
				}
				QuotePart::Expr(e, true) => {
					let sep = self.list_sep();
					for (i, v) in self.eval_list_async(e).await?.into_iter().enumerate() {
						if i != 0 { span.push(&sep); }
						let s = self.interpolation_value(e, v, if mode == InterpMode::String { "join or string" } else {
							interpolation_op(mode, joined, changes.last().map(|(_, op)| *op), once)
						})?;
						if !s.is_empty() { once = None; }
						span.push(&s);
					}
				}
				QuotePart::RegexCode(..) => return Err(self.die_msg("Eval-group not allowed at runtime, use re 'eval' in regex")),
			}
		}
		if changes.is_empty() { return Ok(span); }
		pieces.push(span);
		let utf8 = pieces.iter().any(|s| s.utf8);
		let unicode = self.hints().features.unicode_strings && !self.hints().bytes;
		let mut pending = changes.into_iter().peekable();
		let mut active = Vec::new();
		let mut once = None;
		for (ix, mut piece) in pieces.into_iter().enumerate() {
			while pending.peek().is_some_and(|(i, _)| *i == ix) {
				let Some((_, op)) = pending.next() else { break; };
				match op {
					CaseChange::End => { active.pop(); }
					CaseChange::UpperNext | CaseChange::LowerNext => once = Some(op),
					CaseChange::Upper | CaseChange::Lower | CaseChange::Fold => {
						if let Some(ix) = active.iter().rposition(|op| matches!(op, CaseChange::Upper | CaseChange::Lower | CaseChange::Fold)) {
							active.remove(ix);
						}
						active.push(op);
					}
					CaseChange::Quote => active.push(op),
				}
			}
			if utf8 { piece.upgrade(); }
			if let Some(op) = active.iter().rev().find(|op| matches!(op, CaseChange::Upper | CaseChange::Lower | CaseChange::Fold)) {
				let builtin = match op { CaseChange::Upper => Builtin::Uc, CaseChange::Lower => Builtin::Lc, _ => Builtin::Fc };
				piece = func::data::map_case(piece, builtin, unicode);
			}
			if !piece.is_empty() && let Some(op) = once.take() {
				let builtin = if op == CaseChange::UpperNext { Builtin::Ucfirst } else { Builtin::Lcfirst };
				piece = func::data::map_case(piece, builtin, unicode);
			}
			if active.contains(&CaseChange::Quote) { piece = func::data::quote_meta(piece, unicode); }
			output.push(&piece);
		}
		Ok(output)
	}

	fn interpolation_value(&mut self, e: &Expr, v: Value, context: &str) -> PResult<PStr> {
		if v.is_undef() && self.warn_on("uninitialized") {
			let name = match &e.kind { ExprKind::Variable(Sigil::Scalar, n) => format!(" ${n}"), _ => String::new() };
			self.warn_category("uninitialized", format!("Use of uninitialized value{name} in {context}"));
		}
		self.stringify_owned(v)
	}
}

/// Only representations that can be used numerically without a conversion, warning or Perl callback.
#[inline]
fn plain_num(value: &Value) -> Option<Num> {
	match value {
		Value::Int(n) => Some(Num::Int(*n)), Value::UInt(n) => Some(Num::UInt(*n)),
		Value::Num(n) => Some(Num::Float(*n)), Value::Dual(d) => Some(d.num), _ => None,
	}
}

fn numeric_binary(op: Binary, a: Num, b: Num, integer: bool) -> Result<Value, &'static str> {
	use Binary::*;
	match op {
		Eq | Ne | Lt | Le | Gt | Ge | Cmp => {
			Ok(comparison(op, if integer { Some(a.wrapping_iv().cmp(&b.wrapping_iv())) } else { ops::num_cmp(a, b) }))
		}
		_ => arithmetic(op, a, b, integer).map(Num::into_value),
	}
}

pub(super) fn arithmetic(op: Binary, a: Num, b: Num, integer: bool) -> Result<Num, &'static str> {
	use Binary::*;
	if integer && op != Pow {
		let (a, b) = (a.wrapping_iv(), b.wrapping_iv());
		return Ok(Num::Int(match op {
			Add => ops::int_add(a, b), Sub => ops::int_sub(a, b), Mul => ops::int_mul(a, b),
			Div => ops::int_div(a, b)?, Mod => ops::int_mod(a, b)?, _ => return Err("Invalid binary operator"),
		}));
	}
	match op {
		Add => Ok(ops::add(a, b)), Sub => Ok(ops::sub(a, b)), Mul => Ok(ops::mul(a, b)),
		Div => ops::div(a, b), Mod => ops::modulo(a, b), Pow => Ok(ops::pow(a, b)), _ => Err("Invalid binary operator"),
	}
}

fn interpolation_op(mode: InterpMode, joined: bool, change: Option<CaseChange>, once: Option<CaseChange>) -> &'static str {
	match mode {
		InterpMode::Regex => "regexp compilation",
		InterpMode::Replacement => "substitution (s///)",
		InterpMode::String => match once.or(change) {
			Some(CaseChange::UpperNext) => "ucfirst",
			Some(CaseChange::LowerNext) => "lcfirst",
			Some(CaseChange::Upper) => "uc",
			Some(CaseChange::Lower) => "lc",
			Some(CaseChange::Quote) => "quotemeta",
			Some(CaseChange::Fold) => "fc",
			_ if joined => "concatenation (.) or string",
			_ => "string",
		},
	}
}

fn operand_name(e: &Expr) -> Option<&str> {
	if let ExprKind::Variable(Sigil::Scalar, name) = &ungroup(e).kind { Some(name) } else { None }
}

fn compound_op(compound: Compound) -> Binary {
	use Compound as C;
	use Binary as B;
	match compound {
		C::Add => B::Add, C::Sub => B::Sub, C::Mul => B::Mul, C::Div => B::Div, C::Mod => B::Mod,
		C::Pow => B::Pow, C::Concat => B::Concat, C::Repeat => B::Repeat, C::Shl => B::Shl, C::Shr => B::Shr,
		C::BitAnd => B::BitAnd, C::BitOr => B::BitOr, C::BitXor => B::BitXor, C::StrAnd => B::StrAnd,
		C::StrOr => B::StrOr, C::StrXor => B::StrXor, C::And => B::And, C::Or => B::Or, C::DefinedOr => B::DefinedOr,
	}
}

fn comparison(op: Binary, order: Option<Ordering>) -> Value {
	use Binary::*;
	use Ordering::*;
	match op {
		Cmp | StrCmp => match order { Some(Less) => Value::Int(-1), Some(Equal) => Value::Int(0), Some(Greater) => Value::Int(1), None => Value::Undef },
		_ => perl_bool(comparison_truth(op, order)),
	}
}

#[inline]
fn comparison_truth(op: Binary, order: Option<Ordering>) -> bool {
	use Binary::*;
	use Ordering::*;
	match op {
		Eq | StrEq => order == Some(Equal), Ne | StrNe => order != Some(Equal),
		Lt | StrLt => order == Some(Less), Le | StrLe => matches!(order, Some(Less | Equal)),
		Gt | StrGt => order == Some(Greater), Ge | StrGe => matches!(order, Some(Greater | Equal)),
		_ => false,
	}
}

pub(super) fn op_key(op: Binary) -> &'static str {
	use Binary::*;
	match op {
		Add => "+", Sub => "-", Mul => "*", Div => "/", Mod => "%", Pow => "**", Concat => ".", Repeat => "x",
		Shl => "<<", Shr => ">>", BitAnd => "&", BitOr => "|", BitXor => "^", StrAnd => "&.", StrOr => "|.", StrXor => "^.",
		Eq => "==", Ne => "!=", Lt => "<", Le => "<=", Gt => ">", Ge => ">=", Cmp => "<=>", StrEq => "eq", StrNe => "ne",
		StrLt => "lt", StrLe => "le", StrGt => "gt", StrGe => "ge", StrCmp => "cmp", SmartMatch => "~~", _ => "",
	}
}

fn op_description(op: Binary) -> &'static str {
	use Binary::*;
	match op {
		Add => "addition (+)", Sub => "subtraction (-)", Mul => "multiplication (*)", Div => "division (/)", Mod => "modulus (%)", Pow => "exponentiation (**)",
		Shl => "left bitshift (<<)", Shr => "right bitshift (>>)", BitAnd => "bitwise and (&)", BitOr => "bitwise or (|)", BitXor => "bitwise xor (^)", _ => op_key(op),
	}
}

/// How a smartmatch operand participates: unblessed containers, code, patterns, or anything else.
enum SmartOperand { Array(Av), Hash(Hv), Code(Cv), Regexp, Other }

impl SmartOperand {
	fn of(v: &Value) -> Self {
		match v {
			Value::Ref(r @ Ref::Array(a)) if r.blessed().is_none() => Self::Array(a.clone()),
			Value::Ref(r @ Ref::Hash(h)) if r.blessed().is_none() => Self::Hash(h.clone()),
			Value::Ref(r @ Ref::Code(c)) if r.blessed().is_none() => Self::Code(c.clone()),
			Value::Ref(Ref::Regexp(_)) => Self::Regexp,
			_ => Self::Other,
		}
	}
}
