//! List transforms and stable sort (perlfunc: map, grep and sort).

use std::cmp::Ordering;

use super::*;

impl Interp<'_> {
	pub(super) fn transform(&mut self, grep: bool, call: &Call, cx: Cx) -> PResult<Ret> {
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
					Some(CallSlot::Block(b)) => i.run_block(b, Cx::Scalar)?.scalar(),
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
			Some(CallSlot::Block(b)) => self.run_block(b, Cx::List),
			Some(CallSlot::Expression(e)) => self.eval(e, Cx::List),
			_ => Ok(Ret::empty()),
		}
	}

	pub(super) fn sort_values(&mut self, call: &Call, cx: Cx) -> PResult<Ret> {
		if cx != Cx::List {
			if let Some(args) = &call.args { self.eval(args, Cx::List)?; }
			return Ok(Ret::One(Value::Undef));
		}
		let (values, order) = self.sort_plan(call)?;
		order.into_iter().map(|ix| self.read_sv(&values[ix])).collect::<PResult<Vec<_>>>().map(Ret::Many)
	}

	pub(super) fn sort_aliases(&mut self, call: &Call) -> PResult<Vec<Sv>> {
		let (values, order) = self.sort_plan(call)?;
		Ok(order.into_iter().map(|ix| values[ix].clone()).collect())
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

	fn sort_fast_path(&self, slot: Option<&CallSlot>, values: &[Sv]) -> Option<SortKeys> {
		if values.len() <= 1 || values.iter().any(|v| self.is_magical_sv(v)) { return None; }
		if slot.is_none() {
			return values.iter().map(|s| {
				let value = s.get();
				if matches!(&value, Value::Ref(r) if r.blessed().is_some()) { None } else { Some(value.to_pstr()) }
			}).collect::<Option<Vec<_>>>().map(SortKeys::String);
		}
		let Some(CallSlot::Block(b)) = slot else { return None; };
		let [Stmt { kind: StmtKind::Expr(e), .. }] = b.stmts.as_slice() else { return None; };
		let ExprKind::Binary(Binary::Cmp, left, right) = &ungroup(e).kind else { return None; };
		let (ExprKind::Variable(Sigil::Scalar, l), ExprKind::Variable(Sigil::Scalar, r)) = (&ungroup(left).kind, &ungroup(right).kind) else { return None; };
		let descending = match (l.as_ref(), r.as_ref()) { ("a", "b") => false, ("b", "a") => true, _ => return None };
		if self.lookup_pad(Sigil::Scalar, l).is_some() || self.lookup_pad(Sigil::Scalar, r).is_some() { return None; }
		let integer = self.hints().integer;
		let keys = values.iter().map(|s| match &s.get() {
			value @ (Value::Int(_) | Value::UInt(_) | Value::Num(_) | Value::Dual(_)) => {
				let n = value.to_num(); Some(if integer { Num::Int(n.wrapping_iv()) } else { n })
			}
			_ => None,
		}).collect::<Option<Vec<_>>>()?;
		Some(SortKeys::Number(keys, descending))
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
