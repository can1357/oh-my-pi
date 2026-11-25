//! Interpreter-level lvalue and tie hooks (perltie, perlfunc, perlref).

use super::*;

#[derive(Clone)]
pub(super) enum TieSlot { Scalar(Sv), Array(Av), Hash(Hv), Handle(Io) }

impl TieSlot {
	fn constructor(&self) -> &'static str {
		match self { Self::Scalar(_) => "TIESCALAR", Self::Array(_) => "TIEARRAY", Self::Hash(_) => "TIEHASH", Self::Handle(_) => "TIEHANDLE" }
	}
	fn object(&self, i: &Interp<'_>) -> Option<Value> {
		match self {
			Self::Scalar(s) => s.tie(), Self::Array(a) => i.tied_array(a), Self::Hash(h) => i.tied_hash(h), Self::Handle(io) => i.tied_handle(io),
		}
	}
	fn bind(&self, i: &mut Interp<'_>, value: Option<Value>) -> Option<Value> {
		match self {
			Self::Scalar(s) => s.replace_tie(value), Self::Array(a) => a.replace_tie(value), Self::Hash(h) => h.replace_tie(value),
			Self::Handle(io) => {
				let key = Rc::as_ptr(io) as usize;
				if let Some(value) = value { i.tied_handles.insert(key, (Rc::downgrade(io), value)).map(|(_, v)| v) }
				else { i.tied_handles.remove(&key).map(|(_, v)| v) }
			}
		}
	}
}

impl Interp<'_> {
	pub(super) fn tie_builtin(&mut self, builtin: Builtin, expr: Option<&Expr>) -> PResult<Value> {
		let Some(expr) = expr else { return Err(self.die_msg("Not enough arguments")); };
		let args = if let ExprKind::List(items) = &ungroup(expr).kind { items.as_slice() } else { std::slice::from_ref(expr) };
		let Some((target, args)) = args.split_first() else { return Err(self.die_msg("Not enough arguments")); };
		if builtin == Builtin::Tied && let ExprKind::Variable(Sigil::Hash, name) = &ungroup(target).kind {
			if name.as_ref() == "+" { return Ok(modules::named_capture_tie(false)); }
			if name.as_ref() == "-" { return Ok(modules::named_capture_tie(true)); }
		}
		let Some(slot) = self.tie_slot(target, builtin == Builtin::Tie)? else { return Ok(Value::Undef); };
		match builtin {
			Builtin::Tie => {
				let Some((class, args)) = args.split_first() else { return Err(self.die_msg("Not enough arguments for tie")); };
				let class = self.eval_scalar(class)?;
				// pp_tie looks the class up as a stash name, and the empty name is main.
				let class = if matches!(&class, Value::Str(s) if s.is_empty()) { Value::str("main") } else { class };
				let mut arguments = Vec::new();
				for expr in args { arguments.extend(self.eval_list(expr)?); }
				let constructor = slot.constructor();
				let value = self.call_method(class, constructor, arguments, Cx::Scalar)?.scalar();
				if matches!(value, Value::Ref(_)) { slot.bind(self, Some(value.clone())); }
				Ok(value)
			}
			Builtin::Tied => Ok(slot.object(self).unwrap_or(Value::Undef)),
			Builtin::Untie => {
				let Some(object) = slot.object(self) else { return Ok(Value::Int(1)); };
				let count = match &object {
					Value::Ref(r) => self.object_owners(r).saturating_sub(2),
					_ => 0,
				};
				if let Value::Ref(r) = &object && let Some(class) = r.blessed()
					&& let Some(cv) = self.find_method(&class, "UNTIE") {
					self.call_sub(&cv, vec![new_sv(object), new_sv(Value::Int(count as i64))], Cx::Void)?;
				} else if count != 0 {
					self.warn_category("untie", format!("untie attempted while {count} inner references still exist"));
				}
				slot.bind(self, None);
				Ok(Value::Int(1))
			}
			_ => Ok(Value::Undef),
		}
	}

	fn tie_slot(&mut self, target: &Expr, create_handle: bool) -> PResult<Option<TieSlot>> {
		fn sigil(e: &Expr) -> Sigil {
			match &ungroup(e).kind {
				ExprKind::Variable(s, _) | ExprKind::Deref(s, _) => *s,
				ExprKind::Declare(_, _, e, _) => sigil(e),
				_ => Sigil::Scalar,
			}
		}
		match sigil(target) {
			Sigil::Array => self.eval_array(target).map(TieSlot::Array).map(Some),
			Sigil::Hash => self.eval_hash(target).map(TieSlot::Hash).map(Some),
			Sigil::Glob => {
				let value = self.eval_scalar(target)?;
				let io = match value {
					Value::Ref(Ref::Io(io)) => Some(io),
					Value::Glob(g) | Value::Ref(Ref::Glob(g)) => {
						let io = g.io.borrow().clone();
						io.or_else(|| create_handle.then(|| {
							let io = Rc::new(RefCell::new(Handle::closed()));
							self.set_handle(&g, io.clone());
							io
						}))
					}
					_ => None,
				};
				Ok(io.map(TieSlot::Handle))
			}
			_ => self.eval_lvalue(target).map(TieSlot::Scalar).map(Some),
		}
	}

	/// Read a Perl scalar, invoking FETCH or an lvalue operation when required.
	pub fn read_sv(&mut self, sv: &Sv) -> PResult<Value> {
		if let Some(lvalue) = sv.lvalue() {
			return match lvalue {
				Lvalue::Substr { .. } | Lvalue::Vec { .. } => func::data::lvalue_get(self, lvalue),
				Lvalue::Pos { source } => rx::lvalue_get(self, source),
				Lvalue::LastIndex(a) => Ok(Value::Int(self.array_len(a)? as i64 - 1)),
				Lvalue::ArrayElement(a, index) => if let Some(obj) = self.tied_array(a) {
					let index = self.tied_array_index(a, &obj, *index)?;
					self.call_method(obj, "FETCH", vec![Value::Int(index)], Cx::Scalar).map(Ret::scalar)
				} else if let Some(cell) = self.array_cell(a, *index, false)? { self.read_sv(&cell) } else { Ok(Value::Undef) },
				Lvalue::HashElement(h, key) => if let Some(obj) = self.tied_hash(h) {
					self.call_method(obj, "FETCH", vec![Value::Str(key.to_pstr())], Cx::Scalar).map(Ret::scalar)
				} else if let Some(cell) = self.hash_cell(h, key.clone(), false)? { self.read_sv(&cell) } else { Ok(Value::Undef) },
			};
		}
		if let Some(object) = self.scalar_tie(sv) {
			let v = self.with_tie_suspended(sv, |this| this.call_method(object, "FETCH", Vec::new(), Cx::Scalar))?.scalar();
			sv.set(v.clone());
			return Ok(v);
		}
		Ok(sv.get())
	}

	/// The tie object of a scalar whose magic is currently active.
	pub(super) fn scalar_tie(&self, sv: &Sv) -> Option<Value> {
		sv.tie().filter(|_| !self.tie_suspended.contains(&(Rc::as_ptr(sv) as usize)))
	}

	/// Runs a tie method with the scalar's magic switched off (perl's save_magic), so the method can use the
	/// variable itself without recursing.
	pub(super) fn with_tie_suspended<T>(&mut self, sv: &Sv, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		let address = Rc::as_ptr(sv) as usize;
		let fresh = self.tie_suspended.insert(address);
		let result = f(self);
		if fresh { self.tie_suspended.remove(&address); }
		result
	}

	pub(super) fn write_lvalue(&mut self, lvalue: &Lvalue, value: Value) -> PResult<Value> {
		match lvalue {
			Lvalue::Substr { .. } | Lvalue::Vec { .. } => func::data::lvalue_set(self, lvalue, value),
			Lvalue::Pos { source } => rx::lvalue_set(self, source, value),
			Lvalue::LastIndex(a) => {
				self.resize_array(a, value.to_i64().saturating_add(1).max(0))?;
				Ok(value)
			}
			Lvalue::ArrayElement(a, index) => {
				if let Some(obj) = self.tied_array(a) {
					let index = self.tied_array_index(a, &obj, *index)?;
					self.call_method(obj, "STORE", vec![Value::Int(index), value.clone()], Cx::Scalar)?;
				}
				else if let Some(cell) = self.array_cell(a, *index, true)? { self.write_sv(&cell, value.clone())?; }
				Ok(value)
			}
			Lvalue::HashElement(h, key) => {
				if let Some(obj) = self.tied_hash(h) { self.call_method(obj, "STORE", vec![Value::Str(key.to_pstr()), value.clone()], Cx::Scalar)?; }
				else if let Some(cell) = self.hash_cell(h, key.clone(), true)? { self.write_sv(&cell, value.clone())?; }
				Ok(value)
			}
		}
	}

	/// Whether this cell is a proxy rather than a temporary scalar value.
	pub fn is_lvalue(&self, sv: &Sv) -> bool { sv.lvalue().is_some() }

	/// Whether a scalar's access invokes magic or observes a weak reference.
	pub fn is_magical_sv(&self, sv: &Sv) -> bool {
		sv.is_magical() || sv.registered() && self.magic_cells.contains_key(&(Rc::as_ptr(sv) as usize))
	}

	/// Evaluate the size of an array, including `FETCHSIZE` for tied arrays.
	pub fn array_len(&mut self, av: &Av) -> PResult<usize> {
		if let Some(obj) = self.tied_array(av) {
			let size = self.call_method(obj, "FETCHSIZE", Vec::new(), Cx::Scalar)?.scalar().to_i64();
			return usize::try_from(size).map_err(|_| self.die_msg("FETCHSIZE returned a negative value"));
		}
		Ok(av.elems().len())
	}

	pub(super) fn resize_array(&mut self, a: &Av, len: i64) -> PResult<()> {
		if let Some(object) = self.tied_array(a) {
			self.call_method(object, "STORESIZE", vec![Value::Int(len)], Cx::Void)?;
			return Ok(());
		}
		let Ok(len) = usize::try_from(len) else { return Err(self.die_msg("Out of memory during array extend")); };
		if len > ops::MAX_LIST { return Err(self.die_msg("Out of memory during array extend")); }
		if a.elems().len() != len && modules::readonly_array(self, a) {
			return Err(self.die_msg("Modification of a read-only value attempted"));
		}
		let mut elems = a.elems_mut();
		let extra = len.saturating_sub(elems.len());
		if elems.try_reserve(extra).is_err() { return Err(self.die_msg("Out of memory during array extend")); }
		elems.resize(len, self.hole.clone());
		Ok(())
	}

	/// Return the object attached to an array by tie.
	pub fn tied_array(&self, av: &Av) -> Option<Value> { av.tie() }
	/// Return the object attached to a hash by tie.
	pub fn tied_hash(&self, hv: &Hv) -> Option<Value> { hv.tie() }
	/// Return the object attached to an I/O handle by tie.
	pub fn tied_handle(&self, io: &Io) -> Option<Value> {
		self.tied_handles.get(&(Rc::as_ptr(io) as usize)).and_then(|(owner, object)| {
			(owner.strong_count() > 0).then(|| object.clone())
		})
	}

	/// Invoke one tied-handle operation; `None` directs the caller to genuine I/O.
	pub fn call_tied_handle(&mut self, io: &Io, method: &str, args: Vec<Sv>, cx: Cx) -> Option<PResult<Ret>> {
		let object = self.tied_handle(io)?;
		let result = if let Value::Ref(r) = &object && let Some(class) = r.blessed()
			&& let Some(cv) = self.find_method(&class, method) {
			let mut args = args;
			args.insert(0, new_sv(object));
			self.call_sub(&cv, args, cx)
		} else { self.call_method(object, method, args.iter().map(read_sv).collect(), cx) };
		Some(result)
	}

	/// Resolve a tied array index, honoring a class's `$NEGATIVE_INDICES` flag.
	pub(super) fn tied_array_index(&mut self, av: &Av, object: &Value, index: i64) -> PResult<i64> {
		if index < 0 {
			let raw = if let Value::Ref(r) = object && let Some(class) = r.blessed() {
				self.special_value(&format!("{class}::NEGATIVE_INDICES")).truthy()
			} else { false };
			if !raw { return Ok(index.saturating_add(self.array_len(av)? as i64)); }
		}
		Ok(index)
	}

	/// Snapshot keys using the hash's own FIRSTKEY/NEXTKEY protocol if tied.
	pub fn hash_keys(&mut self, hv: &Hv) -> PResult<Vec<HKey>> {
		hv.iter.set(0);
		let Some(object) = self.tied_hash(hv) else { return Ok(hv.entries().keys().cloned().collect()); };
		let mut keys = Vec::new();
		let mut key = self.call_method(object.clone(), "FIRSTKEY", Vec::new(), Cx::Scalar)?.scalar();
		while !key.is_undef() {
			self.poll()?;
			keys.push(HKey::new(&self.stringify(&key)?));
			key = self.call_method(object.clone(), "NEXTKEY", vec![key], Cx::Scalar)?.scalar();
		}
		Ok(keys)
	}
}
