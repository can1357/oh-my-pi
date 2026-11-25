//! List transforms and stable sort (perlfunc: map, grep and sort).

use std::cmp::Ordering;

use super::*;

impl Interp<'_> {
	pub(super) fn transform(&mut self, grep: bool, call: &Call, cx: Cx) -> PResult<Ret> {
		if !grep && let Some((count, values)) = self.map_numeric_range(call, cx, std::convert::identity)? {
			return Ok(if cx == Cx::List { Ret::Many(values) } else { Ret::One(Value::Int(count as i64)) });
		}
		let mut values = Vec::new();
		let count = if grep {
			self.grep_each(call, |interp, sv| {
				if cx == Cx::List { values.push(interp.read_sv(&sv)?); }
				Ok(())
			})?
		} else {
			self.map_each(call, |i| i.map_values(call), |ret| {
				match ret {
					Ret::One(v) => { if cx == Cx::List { values.push(v); } 1 }
					Ret::Many(out) => { let n = out.len(); if cx == Cx::List { values.extend(out); } n }
				}
			})?
		};
		if cx == Cx::List { Ok(Ret::Many(values)) } else { Ok(Ret::One(Value::Int(count as i64))) }
	}

	/// `grep` in aliasing context yields the matching input containers (`map` results are copies).
	pub(super) fn grep_aliases(&mut self, call: &Call) -> PResult<Vec<Sv>> {
		let mut aliases = Vec::new();
		self.grep_each(call, |_, sv| { aliases.push(sv); Ok(()) })?;
		Ok(aliases)
	}

	fn transform_input(&mut self, call: &Call) -> PResult<Vec<Sv>> {
		call.args.as_deref().map(|e| self.eval_aliases(e)).transpose().map(Option::unwrap_or_default)
	}

	fn grep_each(&mut self, call: &Call, mut emit: impl FnMut(&mut Self, Sv) -> PResult<()>) -> PResult<usize> {
		let mut count = 0;
		for alias in self.transform_input(call)? {
			self.poll()?;
			let yes = self.with_topic(alias.clone(), |i| {
				let test = match &call.slot {
					Some(CallSlot::Block(b)) => match i.numeric_block(b) {
						Some(v) => v, None => i.run_block(b, Cx::Scalar)?.scalar(),
					},
					Some(CallSlot::Expression(e)) => i.eval_scalar(e)?,
					_ => Value::Undef,
				};
				i.truthy(&test)
			})?;
			if yes { count += 1; emit(self, alias)?; }
		}
		Ok(count)
	}

	fn map_each<T>(&mut self, call: &Call, mut apply: impl FnMut(&mut Self) -> PResult<T>, mut emit: impl FnMut(T) -> usize) -> PResult<usize> {
		let mut count: usize = 0;
		for alias in self.transform_input(call)? {
			self.poll()?;
			let out = self.with_topic(alias, &mut apply)?;
			count = count.saturating_add(emit(out));
		}
		Ok(count)
	}

	fn map_values(&mut self, call: &Call) -> PResult<Ret> {
		match &call.slot {
			Some(CallSlot::Block(b)) => match self.numeric_block(b) {
				Some(v) => Ok(Ret::One(v)), None => self.run_block(b, Cx::List),
			},
			Some(CallSlot::Expression(e)) => self.eval(e, Cx::List),
			_ => Ok(Ret::empty()),
		}
	}

	/// No block entry is observable when a statement only reads plain numbers and
	/// there are no alarms or destructors to deliver at its poll. The enclosing
	/// map/grep has still polled for cancellation before consuming this element.
	fn numeric_block(&mut self, b: &Block) -> Option<Value> {
		let [Stmt { kind: StmtKind::Expr(e), location, .. }] = b.stmts.as_slice() else { return None; };
		if !self.quiet_statement() { return None; }
		let n = self.plain_numeric_expr(e)?;
		self.statement_location(location);
		Some(n.into_value())
	}

	/// A literal numeric range supplies fresh writable IVs. Until the first
	/// expression which can execute Perl, neither the temporary topic cell nor any
	/// other input cell's identity can be observed. Materialize the remaining cells
	/// *before* such an expression (references, tied FETCH, warning handlers, etc).
	fn map_numeric_range<T>(&mut self, call: &Call, cx: Cx, wrap: impl Fn(Value) -> T) -> PResult<Option<(usize, Vec<T>)>> {
		if !self.quiet_statement() || !self.active_hints.constant_overloads.is_empty() { return Ok(None); }
		let (expr, loc) = match &call.slot {
			Some(CallSlot::Block(b)) => match b.stmts.as_slice() {
				[Stmt { kind: StmtKind::Expr(e), location, .. }] => (e, Some(location)),
				_ => return Ok(None),
			},
			Some(CallSlot::Expression(e)) => (e.as_ref(), None),
			_ => return Ok(None),
		};
		if !matches!(ungroup(expr).kind, ExprKind::Binary(Binary::Add | Binary::Sub | Binary::Mul | Binary::Div | Binary::Mod, ..)) { return Ok(None); }
		let Some(mut range) = call.args.as_deref().map(ungroup) else { return Ok(None); };
		if let ExprKind::List(args) = &range.kind && let [arg] = args.as_slice() { range = ungroup(arg); }
		let ExprKind::Binary(Binary::Range(_), lo, hi) = &range.kind else { return Ok(None); };
		let number = |e: &Expr| match ungroup(e).kind {
			ExprKind::Int(n) => Some(Value::Int(n)), ExprKind::UInt(n) => Some(Value::UInt(n)),
			ExprKind::Float(n) => Some(Value::Num(n)), _ => None,
		};
		let (Some(lo), Some(hi)) = (number(lo), number(hi)) else { return Ok(None); };
		let Some(Ok((lo, hi))) = ops::numeric_range_bounds(&lo, &hi) else { return Ok(None); };
		let len = (i128::from(hi) - i128::from(lo) + 1).max(0);
		if len > ops::MAX_LIST as i128 { return Ok(None); } // preserve the list-range size diagnostic
		let mut values = Vec::new();
		if cx == Cx::List && values.try_reserve_exact(len as usize).is_err() { return Ok(None); }
		let mut count = 0usize;
		let mut emit = |interp: &mut Self, value: Num| {
			if count == 0 && let Some(loc) = loc { interp.statement_location(loc); }
			if cx == Cx::List { values.push(wrap(value.into_value())); }
			count += 1;
		};
		let mut steps = [(Binary::Add, Num::Int(0)); 4];
		let remainder = if let Some(steps) = self.topic_arithmetic(expr, &mut steps) {
			// `$_` is an IV supplied by the range, not a shadowing lexical. No cell or
			// dynamic topic binding is observable until an operation needs the general path.
			let integer = self.active_hints.integer;
			let mut remainder = None;
			for n in lo..=hi {
				if self.is_cancelled() { return Err(Flow::Cancelled); }
				let result = steps.iter().rev().try_fold(Num::Int(n), |lhs, &(op, rhs)| eval::arithmetic(op, lhs, rhs, integer));
				let Ok(value) = result else { remainder = Some(n); break; };
				emit(self, value);
			}
			remainder
		} else {
			let counter = new_sv(Value::Undef);
			self.with_topic(counter.clone(), |i| {
				for n in lo..=hi {
					if i.is_cancelled() { return Err(Flow::Cancelled); }
					counter.set(Value::Int(n));
					let Some(value) = i.plain_numeric_expr(expr) else { return Ok(Some(n)); };
					emit(i, value);
				}
				Ok(None)
			})?
		};
		if let Some(n) = remainder {
			let tail: Vec<_> = (n..=hi).map(|n| new_sv(Value::Int(n))).collect();
			for alias in tail {
				self.poll()?;
				let ret = self.with_topic(alias, |i| i.map_values(call))?;
				match ret {
					Ret::One(v) => { count = count.saturating_add(1); if cx == Cx::List { values.push(wrap(v)); } }
					Ret::Many(v) => { count = count.saturating_add(v.len()); if cx == Cx::List { values.extend(v.into_iter().map(&wrap)); } }
				}
			}
		}
		Ok(Some((count, values)))
	}

	/// Decode a bounded, left-associative arithmetic tree once for the whole range.
	/// Literals have already been checked for constant overloading by the caller.
	fn topic_arithmetic<'a>(&self, mut expr: &Expr, steps: &'a mut [(Binary, Num)]) -> Option<&'a [(Binary, Num)]> {
		let mut len = 0;
		while let ExprKind::Binary(op @ (Binary::Add | Binary::Sub | Binary::Mul | Binary::Div | Binary::Mod | Binary::Pow), lhs, rhs) = &expr.kind {
			let step = steps.get_mut(len)?;
			let operand = match rhs.kind {
				ExprKind::Int(n) => Num::Int(n), ExprKind::UInt(n) => Num::UInt(n), ExprKind::Float(n) => Num::Float(n), _ => return None,
			};
			*step = (*op, operand);
			len += 1;
			expr = lhs;
		}
		let ExprKind::Variable(Sigil::Scalar, name) = &expr.kind else { return None; };
		(name.as_ref() == "_" && self.pad_slot(Sigil::Scalar, name).is_none() && len != 0).then_some(&steps[..len])
	}

	/// A plain array assignment consumes independent writable cells, not source aliases.
	/// Keep the usual RHS location, depth guard and pending-flow boundaries.
	pub(super) fn transform_array_rhs(&mut self, rhs: &Expr) -> PResult<Option<Vec<Sv>>> {
		let ExprKind::Call(call @ Call { target: CallTarget::Builtin(b @ (Builtin::Map | Builtin::Sort), origin), .. }) = &rhs.kind else { return Ok(None); };
		if !self.builtin_uses_core(*b, *origin) || self.pending.is_some() { return Ok(None); }
		self.at_location(&rhs.location, |i| i.nested(|i| {
			let result = match b {
				Builtin::Map => i.map_numeric_range(call, Cx::List, new_sv).map(|v| v.map(|(_, cells)| cells)),
				_ => i.sort_array_cells(call).map(Some),
			};
			if let Some(flow) = i.take_pending() { return Err(flow); }
			result
		}))
	}

	pub(super) fn sort_values(&mut self, call: &Call, cx: Cx) -> PResult<Ret> {
		if cx != Cx::List {
			if let Some(args) = &call.args { self.eval(args, Cx::List)?; }
			return Ok(Ret::One(Value::Undef));
		}
		if let Some(values) = self.dense_integer_values(call, std::convert::identity)? { return Ok(Ret::Many(values)); }
		let (values, order) = self.sort_plan(call)?;
		let mut out = Vec::with_capacity(values.len());
		for ix in order {
			let sv = &values[ix];
			out.push(if self.transferable(sv) { sv.replace(Value::Undef) } else { self.read_sv(sv)? });
		}
		Ok(Ret::Many(out))
	}

	pub(super) fn sort_aliases(&mut self, call: &Call) -> PResult<Vec<Sv>> {
		let (values, order) = self.sort_plan(call)?;
		Ok(reorder(values, order))
	}

	/// Only these cells can be used as if freshly allocated by array assignment.
	fn transferable(&self, sv: &Sv) -> bool {
		Rc::strong_count(sv) == 1 && Rc::weak_count(sv) == 0 && !sv.registered()
			&& !sv.is_magical() && !sv.is_blessed() && !self.is_readonly_sv(sv)
	}

	fn sort_array_cells(&mut self, call: &Call) -> PResult<Vec<Sv>> {
		if let Some(cells) = self.dense_integer_values(call, new_sv)? { return Ok(cells); }
		let (mut values, order) = self.sort_plan(call)?;
		if values.iter().any(|sv| sv.is_magical()) {
			// FETCH or a weak reference can observe any source, even one we have
			// already visited. Keep the inputs alive and read in sorted order.
			let mut out = Vec::with_capacity(values.len());
			for ix in order { out.push(new_sv(self.read_sv(&values[ix])?)); }
			return Ok(out);
		}
		for sv in &mut values {
			if self.transferable(sv) { sv.set_pos(None); }
			else { *sv = new_sv(sv.get()); }
		}
		Ok(reorder(values, order))
	}

	/// A dense array of *pure IVs* loses nothing by sorting the counts instead of
	/// the elements. Equal IVs are indistinguishable only in copying (not aliasing)
	/// context. Do not resolve/evaluate any general list operand speculatively.
	fn dense_integer_values<T>(&self, call: &Call, wrap: impl Fn(Value) -> T) -> PResult<Option<Vec<T>>> {
		if !self.quiet_statement() { return Ok(None); }
		let Some(descending) = self.numeric_sort_direction(call.slot.as_ref()) else { return Ok(None); };
		let Some(mut arg) = call.args.as_deref().map(ungroup) else { return Ok(None); };
		if let ExprKind::List(args) = &arg.kind && let [item] = args.as_slice() { arg = ungroup(item); }
		let ExprKind::Variable(Sigil::Array, name) = &arg.kind else { return Ok(None); };
		if !name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) { return Ok(None); }
		let Some(vars::Slot::Array(av)) = self.pad_slot(Sigil::Array, name) else { return Ok(None); };
		if self.tied_array(av).is_some() { return Ok(None); }
		let elems = av.elems();
		if elems.len() < 256 { return Ok(None); }
		let limit = (elems.len() / 2).min(65536) as u64;
		let (mut lo, mut hi) = (i64::MAX, i64::MIN);
		for chunk in elems.chunks(4096) {
			if self.is_cancelled() { return Err(Flow::Cancelled); }
			for sv in chunk {
				let Some(v) = sv.plain_value() else { return Ok(None); };
				let Value::Int(n) = *v else { return Ok(None); };
				lo = lo.min(n);
				hi = hi.max(n);
				if hi.abs_diff(lo) >= limit { return Ok(None); }
			}
		}
		let mut counts = vec![0usize; (hi - lo) as usize + 1];
		for chunk in elems.chunks(4096) {
			if self.is_cancelled() { return Err(Flow::Cancelled); }
			for sv in chunk {
				// No Perl can run between the validation and histogram passes.
				let v = sv.try_value().expect("validated ordinary scalar");
				let Value::Int(n) = *v else { unreachable!() };
				counts[(n - lo) as usize] += 1;
			}
		}
		let mut out = Vec::with_capacity(elems.len());
		let mut emit = |bin: usize| -> PResult<()> {
			let n = lo + bin as i64;
			for _ in 0..counts[bin] {
				if out.len() % 4096 == 0 && self.is_cancelled() { return Err(Flow::Cancelled); }
				out.push(wrap(Value::Int(n)));
			}
			Ok(())
		};
		if descending { (0..counts.len()).rev().try_for_each(&mut emit)?; }
		else { (0..counts.len()).try_for_each(&mut emit)?; }
		Ok(Some(out))
	}

	fn sort_plan(&mut self, call: &Call) -> PResult<(Vec<Sv>, Vec<usize>)> {
		let cv = if let Some(CallSlot::Comparator(e)) = &call.slot {
			let (cv, name) = if let ExprKind::Bareword(name) = &ungroup(e).kind { (self.named_code(name), self.qualify(name)) }
			else {
				let value = self.eval_scalar(e)?;
				let name = if let Value::Ref(_) = value { Rc::from("__ANON__") } else { self.qualify(&value.to_pstr().to_string_lossy()) };
				(self.code_value(&value, false)?, name)
			};
			// pp_sort: `Undefined sort subroutine "main::name" called`, also for a declared stub.
			match cv.filter(|cv| !matches!(*cv.body.borrow(), CodeImpl::Undefined)) {
				Some(cv) => Some(cv),
				None => return Err(self.die_msg(format!("Undefined sort subroutine \"{name}\" called"))),
			}
		} else { None };
		let values = self.transform_input(call)?;
		let fast = self.sort_fast_path(call.slot.as_ref(), &values);
		if let Some(SortKeys::Number(keys, descending)) = &fast && self.quiet_statement()
			&& let Some(order) = self.bounded_integer_order(keys, *descending)? {
			return Ok((values, order));
		}
		let mut order: Vec<_> = (0..values.len()).collect();
		let mut scratch = Vec::with_capacity(order.len());
		let mut width = 1;
		while width < order.len() {
			self.poll()?;
			for pair in order.chunks(width.saturating_mul(2)) {
				let (left, right) = pair.split_at(width.min(pair.len()));
				let mut l = 0;
				let mut r = 0;
				while let (Some(&a), Some(&b)) = (left.get(l), right.get(r)) {
					let ordering = if let Some(fast) = &fast { fast.cmp(a, b) }
					else { self.sort_compare(&values[a], &values[b], call.slot.as_ref(), cv.as_ref())? };
					if ordering == Ordering::Greater { scratch.push(b); r += 1; }
					else { scratch.push(a); l += 1; }
				}
				scratch.extend_from_slice(&left[l..]);
				scratch.extend_from_slice(&right[r..]);
			}
			std::mem::swap(&mut order, &mut scratch);
			scratch.clear();
			width = width.saturating_mul(2);
		}
		Ok((values, order))
	}

	/// Stable counting sort for dense integer keys; the comparator cannot run
	/// user code. Work and scratch are linear, and equal keys retain input order.
	fn bounded_integer_order(&mut self, keys: &[Num], descending: bool) -> PResult<Option<Vec<usize>>> {
		if keys.len() < 256 { return Ok(None); }
		let limit = (keys.len() / 2).min(65536) as u64;
		let mut lo = i64::MAX;
		let mut hi = i64::MIN;
		for chunk in keys.chunks(4096) {
			self.poll()?;
			for key in chunk {
				let Num::Int(n) = *key else { return Ok(None); };
				lo = lo.min(n);
				hi = hi.max(n);
				if hi.abs_diff(lo) >= limit { return Ok(None); }
			}
		}
		let bucket = |key: Num| {
			let n = key.wrapping_iv(); // all keys were checked to be IVs above
			if descending { (hi - n) as usize } else { (n - lo) as usize }
		};
		let mut offsets = vec![0usize; (hi - lo) as usize + 1];
		for chunk in keys.chunks(4096) {
			self.poll()?;
			for &key in chunk { offsets[bucket(key)] += 1; }
		}
		let mut start = 0;
		for offset in &mut offsets { let size = *offset; *offset = start; start += size; }
		let mut out = vec![0; keys.len()];
		for (chunk, part) in keys.chunks(4096).enumerate() {
			self.poll()?;
			for (i, &key) in part.iter().enumerate() {
				let offset = &mut offsets[bucket(key)];
				out[*offset] = chunk * 4096 + i;
				*offset += 1;
			}
		}
		Ok(Some(out))
	}

	fn sort_fast_path(&self, slot: Option<&CallSlot>, values: &[Sv]) -> Option<SortKeys> {
		if values.len() <= 1 || values.iter().any(|v| self.is_magical_sv(v)) { return None; }
		if slot.is_none() {
			return values.iter().map(|s| {
				let value = s.try_value().ok()?;
				if matches!(&*value, Value::Ref(r) if r.blessed().is_some()) { None } else { Some(value.to_pstr()) }
			}).collect::<Option<Vec<_>>>().map(SortKeys::String);
		}
		let descending = self.numeric_sort_direction(slot)?;
		let integer = self.hints().integer;
		let keys = values.iter().map(|s| match &*s.try_value().ok()? {
			value @ (Value::Int(_) | Value::UInt(_) | Value::Num(_) | Value::Dual(_)) => {
				let n = value.to_num(); Some(if integer { Num::Int(n.wrapping_iv()) } else { n })
			}
			_ => None,
		}).collect::<Option<Vec<_>>>()?;
		Some(SortKeys::Number(keys, descending))
	}

	fn numeric_sort_direction(&self, slot: Option<&CallSlot>) -> Option<bool> {
		let Some(CallSlot::Block(b)) = slot else { return None; };
		let [Stmt { kind: StmtKind::Expr(e), .. }] = b.stmts.as_slice() else { return None; };
		let ExprKind::Binary(Binary::Cmp, left, right) = &ungroup(e).kind else { return None; };
		let (ExprKind::Variable(Sigil::Scalar, l), ExprKind::Variable(Sigil::Scalar, r)) = (&ungroup(left).kind, &ungroup(right).kind) else { return None; };
		let descending = match (l.as_ref(), r.as_ref()) { ("a", "b") => false, ("b", "a") => true, _ => return None };
		if self.pad_slot(Sigil::Scalar, l).is_some() || self.pad_slot(Sigil::Scalar, r).is_some() { return None; }
		Some(descending)
	}

	fn sort_compare(&mut self, a: &Sv, b: &Sv, slot: Option<&CallSlot>, cv: Option<&Cv>) -> PResult<Ordering> {
		self.poll()?;
		if slot.is_none() {
			let a = self.read_sv(a)?;
			let b = self.read_sv(b)?;
			return Ok(self.stringify(&a)?.cmp(&self.stringify(&b)?));
		}
		let package = self.package();
		let ga = self.glob(&format!("{package}::a"));
		let gb = self.glob(&format!("{package}::b"));
		let old_a = ga.scalar.replace(a.clone());
		let old_b = gb.scalar.replace(b.clone());
		let result = if let Some(cv) = cv {
			let args = if cv.prototype.borrow().as_ref().is_some_and(|p| p.bytes == b"$$") { vec![a.clone(), b.clone()] } else { Vec::new() };
			self.call_sub(cv, args, Cx::Scalar)
		} else if let Some(CallSlot::Block(block)) = slot {
			// A sort block is a sub body: `return` leaves the comparison with its value.
			self.eval_contexts.push((Cx::Scalar, false));
			let result = self.run_block(block, Cx::Scalar);
			self.eval_contexts.pop();
			match result { Err(Flow::Return(v)) => Ok(v), other => other }
		}
		else { Err(self.die_msg("Undefined sort subroutine")) };
		ga.scalar.replace(old_a);
		gb.scalar.replace(old_b);
		Ok(self.numify(&result?.scalar())?.to_f64().partial_cmp(&0.0).unwrap_or(Ordering::Equal))
	}
}

/// `order[dst]` names a source element. Consume its permutation cycles without
/// cloning any cells or allocating another result vector.
fn reorder(mut values: Vec<Sv>, mut order: Vec<usize>) -> Vec<Sv> {
	for start in 0..order.len() {
		let mut dst = start;
		loop {
			let src = std::mem::replace(&mut order[dst], dst);
			if src == start { break; }
			values.swap(dst, src);
			dst = src;
		}
	}
	values
}

enum SortKeys { Number(Vec<Num>, bool), String(Vec<PStr>) }
impl SortKeys {
	fn cmp(&self, a: usize, b: usize) -> Ordering {
		match self {
			Self::Number(keys, descending) => {
				let order = ops::num_cmp(keys[a], keys[b]).unwrap_or(Ordering::Equal);
				if *descending { order.reverse() } else { order }
			}
			Self::String(keys) => keys[a].cmp(&keys[b]),
		}
	}
}
