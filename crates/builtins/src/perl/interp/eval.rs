//! Expression contexts, operators and interpolation (perlop, perlnumber, perlunicode).

use std::cmp::Ordering;

use super::{vars::Slot, *};

impl Interp<'_> {
	pub(super) fn depth_guard<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		if self.depth >= 8192 { return Err(self.die_msg("Deep recursion limit exceeded")); }
		self.depth += 1;
		let result = f(self);
		self.depth -= 1;
		result
	}

	/// Evaluate an expression in the context supplied by its parent.
	pub fn eval(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		if let Some(value) = self.eval_leaf(e) { return Ok(Ret::One(value)); }
		self.at_location(&e.location, |this| this.nested(|this| {
			if let Some(flow) = this.take_pending() { return Err(flow); }
			let result = this.eval_inner(e, cx);
			if let Some(flow) = this.take_pending() { return Err(flow); }
			result.map(|r| {
				let ret = r.in_context(cx);
				if let Ret::One(Value::Ref(Ref::Regexp(_))) = &ret { this.track_ret(&ret); }
				ret
			})
		}))
	}

	/// `depth_guard` for the hot recursive paths, checking for stack growth only every few levels (the check reads
	/// a thread-local): a few nested optimized frames stay well within the 128 KiB red zone. Unoptimized frames
	/// are far larger, so debug builds check at every level.
	#[inline]
	pub(super) fn nested<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		const EVERY: u32 = if cfg!(debug_assertions) { 1 } else { 4 };
		if self.depth % EVERY == 0 { stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.depth_guard(f)) } else { self.depth_guard(f) }
	}

	/// Leaves that cannot fail, warn, recurse or run Perl code (literals without constant overloading, plain
	/// lexical scalars), evaluated without the per-node bookkeeping of `eval`. Their value is the same in every
	/// context.
	#[inline]
	fn eval_leaf(&mut self, e: &Expr) -> Option<Value> {
		if self.pending.is_some() { return None; }
		match &e.kind {
			ExprKind::Int(n) if self.in_constant || self.active_hints.constant_overloads.is_empty() => Some(Value::Int(*n)),
			ExprKind::Variable(Sigil::Scalar, name) => match self.pad_slot(Sigil::Scalar, name) {
				Some(Slot::Scalar(sv)) if !sv.has_read_magic() => Some(sv.get()),
				// The global topic `$_` has no special-variable magic of its own.
				None if name.as_ref() == "_" => {
					let sv = self.topic();
					(!sv.has_read_magic()).then(|| sv.get())
				}
				_ => None,
			},
			_ => None,
		}
	}

	/// Runs `f` with `loc` as the current location, restoring the previous one afterwards. Nested nodes usually
	/// share their parent's location, which then needs no copying.
	#[inline]
	pub(super) fn at_location<T>(&mut self, loc: &Location, f: impl FnOnce(&mut Self) -> T) -> T {
		let same = |current: &Location| current.line == loc.line && Rc::ptr_eq(&current.file, &loc.file);
		if same(&self.loc) {
			let out = f(self);
			if !same(&self.loc) { self.loc = loc.clone(); }
			out
		} else {
			let old = std::mem::replace(&mut self.loc, loc.clone());
			let out = f(self);
			self.loc = old;
			out
		}
	}

	/// Evaluate an expression, requesting a scalar result.
	pub fn eval_scalar(&mut self, e: &Expr) -> PResult<Value> { self.eval(e, Cx::Scalar).map(Ret::scalar) }
	/// Evaluate an expression in list context and copy its values.
	pub fn eval_list(&mut self, e: &Expr) -> PResult<Vec<Value>> { self.eval(e, Cx::List).map(Ret::list) }

	fn eval_inner(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		let value = match &e.kind {
			ExprKind::Int(n) => self.constant_value("integer", Value::Int(*n))?,
			ExprKind::UInt(n) => self.constant_value("integer", Value::UInt(*n))?,
			ExprKind::Float(n) => self.constant_value("float", Value::Num(*n))?,
			ExprKind::String(s) => self.constant_value("q", Value::Str(s.clone()))?,
			ExprKind::Version(cps) => Value::Str(PStr::from_codepoints(cps.iter().copied())),
			ExprKind::Quote(kind, parts) => {
				let s = if *kind == QuoteKind::Glob && let [QuotePart::Expr(e, false)] = parts.as_slice() {
					let value = self.eval_scalar(e)?;
					if let Some(ret) = self.overload_builtin("<>", &value, None, cx)? { return Ok(ret); }
					self.interpolation_value(e, &value, "string")?
				} else { self.interpolate(parts, InterpMode::String)? };
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
			ExprKind::Variable(sigil, name) => return self.eval_var(*sigil, name, cx),
			ExprKind::Deref(sigil, operand) => return self.eval_deref(*sigil, operand, cx),
			ExprKind::Select(base, select, key) => return self.read_selection(base, *select, key, cx),
			ExprKind::Array(q) => Value::Ref(Ref::Array(new_av(self.eval_list(q)?))),
			ExprKind::Hash(q) => {
				let h = new_hv();
				let values = self.eval_list(q)?;
				self.fill_hash(&h, values)?;
				Value::Ref(Ref::Hash(h))
			}
			ExprKind::List(items) => {
				if cx == Cx::List {
					let mut values = Vec::new();
					for operand in items { values.extend(self.eval_list(operand)?); }
					return Ok(Ret::Many(values));
				}
				let Some((last, earlier)) = items.split_last() else { return Ok(Ret::One(Value::Undef)); };
				for item in earlier { self.eval(item, Cx::Void)?; }
				return self.eval(last, cx);
			}
			ExprKind::Group(inner) | ExprKind::Unary(Unary::Plus, inner) => return self.eval(inner, cx),
			ExprKind::Declare(kind, class, target, attrs) => return self.read_declaration(*kind, class.as_ref(), target, attrs, e as *const Expr as usize, cx),
			ExprKind::Unary(op, operand) => return self.unary(*op, operand, cx),
			ExprKind::Binary(op, a, b) => return self.binary(e as *const Expr as usize, *op, a, b, cx),
			ExprKind::CompareChain(first, rest) => {
				let mut left = self.eval_scalar(first)?;
				for (op, rhs) in rest {
					let right = self.eval_scalar(rhs)?;
					let v = self.binary_values(*op, &left, &right)?;
					if !self.truthy(&v)? { return Ok(Ret::One(perl_bool(false))); }
					left = right;
				}
				perl_bool(true)
			}
			ExprKind::Conditional(cond, yes, no) => {
				let v = self.eval_scalar(cond)?;
				let branch = if self.truthy(&v)? { yes } else { no };
				return self.eval(branch, cx);
			}
			ExprKind::Call(call) => return self.eval_call(call, cx),
			ExprKind::Sub(sub) => {
				let cv = self.make_sub(sub, None, self.capture_pad(sub.body.as_deref()));
				// `sub : const {...}` runs once now and becomes a constant sub of that value (perlsub).
				if sub.attributes.iter().any(|attr| attr.name.as_ref() == "const") {
					let values = self.call_sub(&cv, Vec::new(), Cx::List)?.list();
					cv.body.replace(CodeImpl::Constant(Rc::from(values)));
				}
				Value::Ref(Ref::Code(cv))
			}
			ExprKind::Block(block, true) => return self.eval_block(block, cx),
			ExprKind::Block(block, false) => return self.run_block(block, cx),
			ExprKind::Readline(source) => return func::sys::readline(self, source, cx),
			ExprKind::FileTest(kind, operand) => return func::sys::file_test(self, *kind, operand.as_deref()).map(Ret::One),
			ExprKind::Yada => return Err(self.die_msg("Unimplemented")),
		};
		Ok(Ret::One(value))
	}

	fn constant_value(&mut self, kind: &str, value: Value) -> PResult<Value> {
		if self.in_constant { return Ok(value); }
		let Some(handler) = self.active_hints.constant_overloads.get(kind).cloned() else { return Ok(value); };
		let Some(cv) = self.code_value(&handler, false)? else { return Ok(value); };
		let source = value.to_pstr();
		// Do not feed constants inside the conversion callback back into itself.
		self.in_constant = true;
		let result = self.call_sub(&cv, vec![new_sv(Value::Str(source)), new_sv(value), new_sv(Value::str(kind))], Cx::Scalar);
		self.in_constant = false;
		result.map(Ret::scalar)
	}

	fn unary(&mut self, op: Unary, operand: &Expr, cx: Cx) -> PResult<Ret> {
		use Unary::*;
		if op == Reference { return self.reference(operand, cx); }
		if matches!(op, PreInc | PreDec | PostInc | PostDec) {
			let cell = match &ungroup(operand).kind {
				ExprKind::Variable(Sigil::Scalar, name) if let Some(Slot::Scalar(sv)) = self.pad_slot(Sigil::Scalar, name) => sv.clone(),
				_ => self.eval_lvalue(operand)?,
			};
			// A plain integer that stays in range: update in place (what the general path computes for an IV).
			if !cell.has_read_magic() && !cell.is_magical() && !self.is_readonly_sv(&cell)
				&& let Some(n) = cell.try_value().ok().and_then(|v| if let Value::Int(n) = *v { Some(n) } else { None })
				&& let Some(next) = if matches!(op, PreInc | PostInc) { n.checked_add(1) } else { n.checked_sub(1) } {
				cell.set(Value::Int(next));
				cell.pos.set(None);
				return Ok(Ret::One(Value::Int(if matches!(op, PostInc | PostDec) { n } else { next })));
			}
			let old = self.read_sv(&cell)?;
			let plus = matches!(op, PreInc | PostInc);
			let next = if let Some(value) = self.overload_inc(plus, &old, cx != Cx::Void && matches!(op, PostInc | PostDec))? { value }
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
		else { self.eval_scalar(operand)? };
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

	fn binary(&mut self, site: usize, op: Binary, left: &Expr, right: &Expr, cx: Cx) -> PResult<Ret> {
		use Binary::*;
		match op {
			Bind(neg) => return rx::bind_expr(self, left, right, neg, cx),
			Assign => return self.assign(left, right, cx),
			AssignOp(compound) => return self.compound(compound, left, right, cx).map(Ret::One),
			And | Or | DefinedOr => {
				let value = self.eval_scalar(left)?;
				let pass = self.short_circuit(op, &value)?;
				return if pass { self.eval(right, cx) } else { Ok(Ret::One(value)) };
			}
			SmartMatch => {
				let a = self.smartmatch_operand(left)?;
				let b = self.smartmatch_operand(right)?;
				return Ok(Ret::One(perl_bool(self.smartmatch(&a, &b)?)));
			}
			Range(three) => {
				if cx != Cx::List { return self.flip_flop(site, left, right, three).map(Ret::One); }
				let start = self.eval_scalar(left)?;
				let end = self.eval_scalar(right)?;
				return ops::range(&start, &end).map(Ret::Many).map_err(|m| self.die_msg(m));
			}
			Repeat if cx == Cx::List && matches!(&left.kind, ExprKind::Group(_) | ExprKind::List(_)) => {
				let values = self.eval_list(left)?;
				let count = self.eval_scalar(right)?;
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
				let value = self.eval_scalar(left)?;
				let class = if let ExprKind::Bareword(name) = &ungroup(right).kind { name.clone() }
				else { let v = self.eval_scalar(right)?; Rc::from(self.stringify(&v)?.to_string_lossy().as_ref()) };
				// pp_isa calls the object's `isa` method when it is overridden, else checks the hierarchy directly.
				let yes = if let Value::Ref(r) = &value && let Some(pkg) = r.blessed() {
					let overridden = self.find_method(&pkg, "isa").filter(|cv| !matches!(*cv.body.borrow(), CodeImpl::Native(_)));
					if let Some(cv) = overridden {
						let result = self.call_sub(&cv, vec![new_sv(value.clone()), new_sv(Value::Str(PStr::from_str(&class)))], Cx::Scalar)?.scalar();
						self.truthy(&result)?
					} else { self.isa(&pkg, &class)? }
				} else { false };
				return Ok(Ret::One(perl_bool(yes)));
			}
			_ => {}
		}
		let a = self.eval_scalar(left)?;
		let b = self.eval_scalar(right)?;
		self.binary_values_named(op, &a, &b, [operand_name(left), operand_name(right)]).map(Ret::One)
	}

	fn short_circuit(&mut self, op: Binary, value: &Value) -> PResult<bool> {
		match op {
			Binary::And => self.truthy(value), Binary::Or => Ok(!self.truthy(value)?),
			Binary::DefinedOr => Ok(value.is_undef()), _ => Ok(true),
		}
	}

	fn range_test(&mut self, e: &Expr) -> PResult<bool> {
		if matches!(&ungroup(e).kind, ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_)) {
			let n = self.eval_scalar(e)?.to_i64();
			return Ok(self.magic_scalar(".").unwrap_or(Value::Undef).to_i64() == n);
		}
		let v = self.eval_scalar(e)?;
		self.truthy(&v)
	}

	fn flip_flop(&mut self, site: usize, start: &Expr, end: &Expr, three: bool) -> PResult<Value> {
		let n = self.persistent.borrow().flip_flops.get(&site).copied().unwrap_or(0);
		if n == 0 && !self.range_test(start)? { return Ok(perl_bool(false)); }
		let finished = !(three && n == 0) && self.range_test(end)?;
		let n = n.saturating_add(1);
		if finished {
			self.persistent.borrow_mut().flip_flops.remove(&site);
			Ok(Value::str(&format!("{n}E0")))
		} else {
			self.persistent.borrow_mut().flip_flops.insert(site, n);
			Ok(Value::Int(n as i64))
		}
	}

	fn compound(&mut self, compound: Compound, left: &Expr, right: &Expr, cx: Cx) -> PResult<Value> {
		use Binary as B;
		let op = compound_op(compound);
		let target = ungroup(left);
		if let ExprKind::Call(call @ Call { target: CallTarget::Builtin(b @ (Builtin::Substr | Builtin::Pos | Builtin::Vec | Builtin::Keys), _), .. }) = &target.kind {
			let old = self.eval_scalar(target)?;
			if !self.short_circuit(op, &old)? { return Ok(old); }
			let rhs = self.eval_scalar(right)?;
			let value = if matches!(op, B::And | B::Or | B::DefinedOr) { rhs } else { self.binary_values(op, &old, &rhs)? };
			return func::assign(self, *b, call, value);
		}
		let cell = match &target.kind {
			ExprKind::Variable(Sigil::Scalar, name) if let Some(Slot::Scalar(sv)) = self.pad_slot(Sigil::Scalar, name) => sv.clone(),
			_ => self.eval_lvalue(left)?,
		};
		if op == B::Concat && let Some(value) = self.append_in_place(&cell, right, cx)? { return Ok(value); }
		let old = self.read_sv(&cell)?;
		if !self.short_circuit(op, &old)? { return Ok(old); }
		let rhs = self.eval_scalar(right)?;
		let value = self.combine_compound(op, &cell, old, rhs, cx != Cx::Void)?;
		// The operator's value is its target: a tied target is FETCHed again when that value is used.
		if cx != Cx::Void && self.scalar_tie(&cell).is_some() { return self.read_sv(&cell); }
		Ok(value)
	}

	/// `.=` on a plain string cell appends to its buffer (perl's in-place concatenation) instead of copying the
	/// string; None when the general path must handle it (magic, overloading, undef operands, warnings).
	fn append_in_place(&mut self, cell: &Sv, right: &Expr, cx: Cx) -> PResult<Option<Value>> {
		let plain = |this: &Self| !cell.registered() && !cell.has_read_magic() && !cell.is_magical() && !modules::readonly_sv(this, cell)
			&& matches!(cell.try_value().as_deref(), Ok(Value::Str(_)));
		if !plain(self) { return Ok(None); }
		let rhs = self.eval_scalar(right)?;
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
		cell.pos.set(None);
		Ok(Some(result))
	}

	pub(super) fn compound_cell(&mut self, compound: Compound, cell: &Sv, right: &Expr) -> PResult<Value> {
		let op = compound_op(compound);
		let old = self.read_sv(cell)?;
		if !self.short_circuit(op, &old)? { return Ok(old); }
		let rhs = self.eval_scalar(right)?;
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
		let value = if matches!(op, B::And | B::Or | B::DefinedOr) { rhs }
		else if let Some(value) = self.overload_binary(op_key(op), &old, &rhs, true)? { value }
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
		// Two IVs: no overloading, warnings or conversions apply; results that fit stay IVs (as below).
		if let (Value::Int(x), Value::Int(y)) = (a, b) {
			let (x, y) = (*x, *y);
			let fast = match op {
				Add => x.checked_add(y).map(Value::Int),
				Sub => x.checked_sub(y).map(Value::Int),
				Mul => x.checked_mul(y).map(Value::Int),
				Mod if x >= 0 && y > 0 => Some(Value::Int(x % y)),
				Eq => Some(perl_bool(x == y)), Ne => Some(perl_bool(x != y)),
				Lt => Some(perl_bool(x < y)), Le => Some(perl_bool(x <= y)),
				Gt => Some(perl_bool(x > y)), Ge => Some(perl_bool(x >= y)),
				Cmp => Some(Value::Int(match x.cmp(&y) { Ordering::Less => -1, Ordering::Equal => 0, Ordering::Greater => 1 })),
				_ => None,
			};
			if let Some(v) = fast { return Ok(v); }
		}
		let key = op_key(op);
		if !key.is_empty() && op != SmartMatch {
			if let Some(v) = self.overload_binary(key, a, b, false)? { return Ok(v); }
		}
		let integer = self.active_hints.integer;
		Ok(match op {
			Add | Sub | Mul | Div | Mod | Pow => {
				let name = op_description(op);
				let a = self.numify_with_named(a, name, names[0])?;
				let b = self.numify_with_named(b, name, names[1])?;
				if integer && op != Pow {
					let a = a.wrapping_iv(); let b = b.wrapping_iv();
					let n = match op {
						Add => Ok(ops::int_add(a, b)), Sub => Ok(ops::int_sub(a, b)), Mul => Ok(ops::int_mul(a, b)),
						Div => ops::int_div(a, b), _ => ops::int_mod(a, b),
					};
					Value::Int(n.map_err(|m| self.die_msg(m))?)
				} else {
					let n = match op {
						Add => Ok(ops::add(a, b)), Sub => Ok(ops::sub(a, b)), Mul => Ok(ops::mul(a, b)),
						Div => ops::div(a, b), Mod => ops::modulo(a, b), _ => Ok(ops::pow(a, b)),
					};
					n.map_err(|m| self.die_msg(m))?.into_value()
				}
			}
			Concat => {
				let mut a = self.stringify_with(a, "concatenation (.)")?;
				a.push(&self.stringify_with(b, "concatenation (.)")?);
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
			Eq | Ne | Lt | Le | Gt | Ge | Cmp => {
				let a = self.numify_with(a, key)?;
				let b = self.numify_with(b, key)?;
				let order = if integer { Some(a.wrapping_iv().cmp(&b.wrapping_iv())) } else { ops::num_cmp(a, b) };
				comparison(op, order)
			}
			StrEq | StrNe | StrLt | StrLe | StrGt | StrGe | StrCmp => {
				let a = self.stringify_with(a, key)?;
				let b = self.stringify_with(b, key)?;
				comparison(op, Some(if self.hints().bytes { a.bytes.cmp(&b.bytes) } else { ops::str_cmp(&a, &b) }))
			}
			Xor => perl_bool(self.truthy(a)? != self.truthy(b)?),
			SmartMatch => perl_bool(self.smartmatch(a, b)?),
			_ => return Err(self.die_msg("Invalid binary operator")),
		})
	}

	pub(super) fn smartmatch(&mut self, a: &Value, b: &Value) -> PResult<bool> {
		stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.depth_guard(|this| this.smartmatch_inner(a, b)))
	}

	fn smartmatch_inner(&mut self, a: &Value, b: &Value) -> PResult<bool> {
		// perlop "Smartmatch Operator": the right operand's type picks the rule, in this order.
		if b.is_undef() { return Ok(a.is_undef()); }
		if let Value::Ref(r) = b && r.blessed().is_some() && !matches!(r, Ref::Regexp(_)) {
			if let Some(v) = self.overload_binary("~~", a, b, false)? { return self.truthy(&v); }
			return Err(self.die_msg("Smart matching a non-overloaded object breaks encapsulation"));
		}
		let left = SmartOperand::of(a);
		match SmartOperand::of(b) {
			SmartOperand::Array(right) => {
				let items = self.smart_elements(&right)?;
				match left {
					SmartOperand::Array(left) => {
						if Rc::ptr_eq(&left, &right) { return Ok(true); }
						let left = self.smart_elements(&left)?;
						if left.len() != items.len() { return Ok(false); }
						for (x, y) in left.iter().zip(&items) { if !self.smartmatch(x, y)? { return Ok(false); } }
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
						for item in &items { if self.smartmatch(a, item)? { return Ok(true); } }
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
					for item in self.smart_elements(&left)? { if self.smart_exists(&right, &item)? { return Ok(true); } }
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
					SmartOperand::Array(arr) => self.smart_elements(&arr)?,
					SmartOperand::Hash(h) => self.hash_keys(&h)?.iter().map(|k| Value::Str(k.to_pstr())).collect(),
					_ => {
						let result = self.call_sub(&cv, vec![new_sv(a.clone())], Cx::Scalar)?.scalar();
						return self.truthy(&result);
					}
				};
				for item in items {
					let result = self.call_sub(&cv, vec![new_sv(item)], Cx::Scalar)?.scalar();
					if !self.truthy(&result)? { return Ok(false); }
				}
				Ok(true)
			}
			SmartOperand::Regexp => match left {
				SmartOperand::Array(arr) => {
					for item in self.smart_elements(&arr)? { if self.smart_regex(&item, b)? { return Ok(true); } }
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
	fn smart_elements(&mut self, av: &Av) -> PResult<Vec<Value>> {
		let cells = self.eval_array_aliases(av, false)?;
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
	pub(super) fn smartmatch_operand(&mut self, e: &Expr) -> PResult<Value> {
		Ok(match &ungroup(e).kind {
			ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => Value::Ref(Ref::Array(self.eval_array(e)?)),
			ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => Value::Ref(Ref::Hash(self.eval_hash(e)?)),
			_ => self.eval_scalar(e)?,
		})
	}

	/// Stringification with Perl overload conversion.
	pub fn stringify(&mut self, v: &Value) -> PResult<PStr> {
		Ok(self.convert_overload(v, &["\"\"", "0+", "bool"])?.map_or_else(|| v.to_pstr(), |v| v.to_pstr()))
	}

	/// `stringify` consuming the value: a plain string is returned without copying.
	pub(super) fn stringify_owned(&mut self, v: Value) -> PResult<PStr> {
		match v { Value::Str(s) => Ok(s), v => self.stringify(&v) }
	}

	/// Numeric conversion with Perl overload conversion.
	pub fn numify(&mut self, v: &Value) -> PResult<Num> {
		Ok(self.convert_overload(v, &["0+", "\"\"", "bool"])?.map_or_else(|| v.to_num(), |v| v.to_num()))
	}

	/// Test the value, preferring the `bool` overload when present.
	pub fn truthy(&mut self, v: &Value) -> PResult<bool> {
		Ok(self.convert_overload(v, &["bool", "0+", "\"\""])?.map_or_else(|| v.truthy(), |v| v.truthy()))
	}

	fn stringify_with(&mut self, v: &Value, op: &str) -> PResult<PStr> {
		if v.is_undef() && self.warn_on("uninitialized") {
			self.warn_category("uninitialized", format!("Use of uninitialized value in {op}"));
		}
		self.stringify(v)
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
					let v = self.eval_scalar(e)?;
					let s = if mode == InterpMode::Regex && matches!(v, Value::Ref(Ref::Regexp(_))) { v.to_pstr() }
					else { self.interpolation_value(e, &v, interpolation_op(mode, joined, changes.last().map(|(_, op)| *op), once))? };
					if !s.is_empty() { once = None; }
					span.push(&s);
				}
				QuotePart::Expr(e, true) => {
					let sep = self.list_sep();
					for (i, v) in self.eval_list(e)?.into_iter().enumerate() {
						if i != 0 { span.push(&sep); }
						let s = self.interpolation_value(e, &v, if mode == InterpMode::String { "join or string" } else {
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

	fn interpolation_value(&mut self, e: &Expr, v: &Value, context: &str) -> PResult<PStr> {
		if v.is_undef() && self.warn_on("uninitialized") {
			let name = match &e.kind { ExprKind::Variable(Sigil::Scalar, n) => format!(" ${n}"), _ => String::new() };
			self.warn_category("uninitialized", format!("Use of uninitialized value{name} in {context}"));
		}
		self.stringify(v)
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
		Eq | StrEq => perl_bool(order == Some(Equal)),
		Ne | StrNe => perl_bool(order != Some(Equal)),
		Lt | StrLt => perl_bool(order == Some(Less)),
		Le | StrLe => perl_bool(matches!(order, Some(Less | Equal))),
		Gt | StrGt => perl_bool(order == Some(Greater)),
		Ge | StrGe => perl_bool(matches!(order, Some(Greater | Equal))),
		_ => perl_bool(false),
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
