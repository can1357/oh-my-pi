//! Operator overloading, autogeneration, conversions and copy-on-mutation (overload).

use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fallback { Disabled, Generate, Builtin }

type Table = FxHashMap<Rc<str>, Value>;

enum Methods<'a> {
	Direct(&'a Table),
	Inherited { lineage: Vec<Rc<str>>, table: &'a FxHashMap<Rc<str>, Table> },
}
impl Methods<'_> {
	fn get(&self, key: &str) -> Option<Value> {
		match self {
			Self::Direct(table) => table.get(key).cloned(),
			Self::Inherited { lineage, table } => lineage.iter().find_map(|pkg| table.get(pkg)?.get(key).cloned()),
		}
	}
	fn fallback(&self) -> Fallback {
		self.get("fallback").map_or(Fallback::Generate, |v| {
			if v.is_undef() { Fallback::Generate } else if v.truthy() { Fallback::Builtin } else { Fallback::Disabled }
		})
	}
}

fn class(v: &Value) -> Option<Rc<str>> { if let Value::Ref(r) = v { r.blessed() } else { None } }

fn numeric_bitwise(op: &str) -> bool { matches!(op, "&" | "|" | "^" | "~" | "&=" | "|=" | "^=") }

fn comparison_method(key: &str) -> Option<&'static str> {
	match key {
		"==" | "!=" | "<" | "<=" | ">" | ">=" => Some("<=>"),
		"eq" | "ne" | "lt" | "le" | "gt" | "ge" => Some("cmp"),
		_ => None,
	}
}

impl Interp<'_> {
	fn methods(&self, class: &str) -> Option<Methods<'_>> {
		if self.overloads.is_empty() { return None; }
		if self.lookup_glob(&format!("{class}::ISA")).is_none_or(|gv| gv.array.borrow().elems().is_empty()) {
			return self.overloads.get(class).filter(|table| !table.is_empty()).map(Methods::Direct);
		}
		let lineage = self.linear_isa(class, self.mro_order(class)).ok()?;
		lineage.iter().any(|pkg| self.overloads.get(pkg).is_some_and(|table| !table.is_empty()))
			.then_some(Methods::Inherited { lineage, table: &self.overloads })
	}

	/// Add, replace or remove a handler registered through `use overload`.
	pub fn set_overload(&mut self, pkg: &str, key: &str, handler: Value) {
		if handler.is_undef() && key != "fallback" { self.remove_overload(pkg, key); }
		else { self.overloads.entry(Rc::from(pkg)).or_default().insert(Rc::from(key), handler); }
	}

	/// Remove an overload entry without shadowing inherited entries.
	pub fn remove_overload(&mut self, pkg: &str, key: &str) {
		if let Some(table) = self.overloads.get_mut(pkg) {
			table.remove(key);
			if table.is_empty() { self.overloads.remove(pkg); }
		}
	}

	/// Fetch the raw overload handler (method name or CV), including inheritance.
	pub fn overload_handler(&self, class: &str, key: &str) -> Option<Value> { self.methods(class)?.get(key) }

	/// Whether a package or one of its ancestors declares operator overloads.
	pub fn has_overload(&self, class: &str) -> bool { self.methods(class).is_some() }

	fn invoke_overload(&mut self, handler: Value, inv: Sv, other: Value, swapped: Option<bool>, op: &str, nomethod: bool, cx: Cx) -> PResult<Ret> {
		if self.in_overload >= 96 { return Err(self.die_msg("Recursive overload")); }
		self.in_overload += 1;
		let mut args = vec![new_sv(other), new_sv(swapped.map_or(Value::Undef, perl_bool))];
		let numeric = self.hints().features.bitwise && numeric_bitwise(op);
		if nomethod || numeric { args.push(new_sv(if nomethod { Value::str(op) } else { Value::Undef })); }
		if numeric { args.push(new_sv(Value::Int(1))); }
		let result = if let Value::Ref(Ref::Code(cv)) = handler {
			args.insert(0, inv);
			self.call_sub(&cv, args, cx)
		} else {
			self.invoke_method(inv, &handler.to_pstr().to_string_lossy(), args, cx)
		};
		self.in_overload -= 1;
		result
	}

	fn invoke_scalar(&mut self, handler: Value, inv: &Value, other: Value, swapped: Option<bool>, op: &str, nomethod: bool) -> PResult<Value> {
		self.invoke_overload(handler, new_sv(inv.clone()), other, swapped, op, nomethod, Cx::Scalar).map(Ret::scalar)
	}

	fn missing_overload(&mut self, op: &str, a: Option<&str>, b: Option<Option<&str>>) -> Flow {
		let kind = |pkg: Option<&str>| pkg.map_or_else(|| " has no overloaded magic".to_owned(), |pkg| format!(" in overloaded package {pkg}"));
		let message = if let Some(b) = b {
			format!("Operation \"{op}\": no method found,\n\tleft argument{},\n\tright argument{}", kind(a), kind(b))
		} else { format!("Operation \"{op}\": no method found, argument{}", kind(a)) };
		self.die_msg(message)
	}

	fn compare_overload(&mut self, handler: Value, op: &str, compare: &str, left: &Value, right: &Value, swapped: bool) -> PResult<Value> {
		let v = self.invoke_scalar(handler, left, right.clone(), Some(swapped), compare, false)?;
		let n = self.numify(&v)?.to_f64();
		Ok(perl_bool(match op {
			"==" | "eq" => n == 0.0,
			"!=" | "ne" => n != 0.0,
			"<" | "lt" => n < 0.0,
			"<=" | "le" => n <= 0.0,
			">" | "gt" => n > 0.0,
			">=" | "ge" => n >= 0.0,
			_ => false,
		}))
	}

	#[inline]
	pub(super) fn overload_binary(&mut self, op: &str, a: &Value, b: &Value, assign: bool) -> PResult<Option<Value>> {
		if (!matches!(a, Value::Ref(_)) && !matches!(b, Value::Ref(_))) || self.overloads.is_empty() || op.is_empty() {
			return Ok(None);
		}
		self.resolve_binary_overload(op, a, b, assign)
	}

	fn resolve_binary_overload(&mut self, op: &str, a: &Value, b: &Value, assign: bool) -> PResult<Option<Value>> {
		let classes = [class(a), class(b)];
		let left = classes[0].as_deref().and_then(|p| self.methods(p));
		let right = classes[1].as_deref().and_then(|p| self.methods(p));
		if left.is_none() && right.is_none() { return Ok(None); }
		let fallback = [left.as_ref().map_or(Fallback::Builtin, Methods::fallback), right.as_ref().map_or(Fallback::Builtin, Methods::fallback)];
		if assign {
			let Some(left) = left else { return Ok(None); };
			let key = format!("{op}=");
			let selected = left.get(&key).map(|handler| (handler, false, false))
				.or_else(|| (fallback[0] != Fallback::Disabled).then(|| left.get(op)).flatten()
					.map(|handler| (handler, true, false)))
				.or_else(|| left.get("nomethod").map(|handler| (handler, false, true)));
			let unsupported = fallback[0] == Fallback::Disabled && right.as_ref().and_then(|m| m.get(op)).is_none();
			if let Some((handler, derived, nomethod)) = selected {
				if derived { return self.invoke_scalar(handler, a, b.clone(), None, op, false).map(Some); }
				let inv = self.mutator_copy(a, fallback[0])?;
				return self.invoke_scalar(handler, &inv, b.clone(), Some(false), &key, nomethod).map(Some);
			}
			if unsupported { return Err(self.missing_overload(&key, classes[0].as_deref(), Some(classes[1].as_deref()))); }
			return Ok(None);
		}
		let conversions = |m: &Methods<'_>| ["\"\"", "0+", "bool"].iter().any(|key| m.get(key).is_some());
		let sides = [left.as_ref(), right.as_ref()];
		let selected = sides.into_iter().enumerate().find_map(|(index, methods)| {
			let methods = methods?;
			if let Some(handler) = methods.get(op) { return Some((index, handler, None, false)); }
			if fallback[index] != Fallback::Disabled && let Some(compare) = comparison_method(op) && let Some(handler) = methods.get(compare) {
				return Some((index, handler, Some(compare), false));
			}
			None
		}).or_else(|| sides.into_iter().enumerate().find_map(|(index, methods)| {
			let methods = methods?;
			if matches!(op, "." | "x") && fallback[index] != Fallback::Disabled && conversions(methods) { return None; }
			methods.get("nomethod").map(|handler| (index, handler, None, true))
		}));
		let stringify = matches!(op, "." | "x") && sides.into_iter().enumerate().all(|(index, m)| {
			fallback[index] == Fallback::Builtin || fallback[index] == Fallback::Generate && m.is_some_and(conversions)
		});
		if let Some((index, handler, comparison, nomethod)) = selected {
			let (inv, other, swapped) = if index == 0 { (a, b, false) } else { (b, a, true) };
			if let Some(compare) = comparison {
				return self.compare_overload(handler, op, compare, inv, other, swapped).map(Some);
			}
			return self.invoke_scalar(handler, inv, other.clone(), Some(swapped), op, nomethod).map(Some);
		}
		if stringify || fallback == [Fallback::Builtin; 2] || op == "~~" { return Ok(None); }
		Err(self.missing_overload(op, classes[0].as_deref(), Some(classes[1].as_deref())))
	}

	fn mutator_copy(&mut self, v: &Value, fallback: Fallback) -> PResult<Value> {
		let Value::Ref(r) = v else { return Ok(v.clone()); };
		if !self.object_shared(r) { return Ok(v.clone()); }
		let Some(pkg) = r.blessed() else { return Ok(v.clone()); };
		if let Some(handler) = self.overload_handler(&pkg, "=") {
			let copied = self.invoke_scalar(handler, v, Value::Undef, Some(false), "=", false)?;
			if !matches!(copied, Value::Ref(_)) { return Err(self.die_msg("Copy method did not return a reference")); }
			return Ok(copied);
		}
		if fallback != Fallback::Disabled && let Ref::Scalar(original) = r {
			let copy = Ref::Scalar(new_sv(read_sv(original)));
			self.bless_ref(&copy, pkg);
			return Ok(Value::Ref(copy));
		}
		if fallback == Fallback::Builtin { return Ok(v.clone()); }
		Err(self.missing_overload("=", Some(&pkg), None))
	}

	pub(super) fn overload_inc(&mut self, plus: bool, v: &Value, postfix: bool) -> PResult<Option<Value>> {
		let Some(pkg) = class(v) else { return Ok(None); };
		let Some(methods) = self.methods(&pkg) else { return Ok(None); };
		let op = if plus { "++" } else { "--" };
		let fallback = methods.fallback();
		if let Some(handler) = methods.get(op) {
			let value = if postfix && let Value::Ref(r) = v && !self.object_shared(r) {
				self.copy_for_postfix(v, fallback)?
			} else { self.mutator_copy(v, fallback)? };
			let inv = new_sv(value);
			self.invoke_overload(handler, inv.clone(), Value::Undef, Some(false), op, false, Cx::Scalar)?;
			return Ok(Some(read_sv(&inv)));
		}
		if fallback != Fallback::Disabled {
			let assignment = if plus { "+=" } else { "-=" };
			if let Some(handler) = methods.get(assignment) {
				let copy = if postfix && let Value::Ref(r) = v && !self.object_shared(r) {
					self.copy_for_postfix(v, fallback)?
				} else { self.mutator_copy(v, fallback)? };
				return self.invoke_scalar(handler, &copy, Value::Int(1), Some(false), assignment, false).map(Some);
			}
			let binary = if plus { "+" } else { "-" };
			if let Some(handler) = methods.get(binary) { return self.invoke_scalar(handler, v, Value::Int(1), None, binary, false).map(Some); }
		}
		if let Some(handler) = methods.get("nomethod") {
			let value = if postfix && let Value::Ref(r) = v && !self.object_shared(r) { self.copy_for_postfix(v, fallback)? }
			else { self.mutator_copy(v, fallback)? };
			let inv = new_sv(value);
			self.invoke_overload(handler, inv.clone(), Value::Undef, Some(false), op, true, Cx::Scalar)?;
			return Ok(Some(read_sv(&inv)));
		}
		if fallback == Fallback::Builtin { Ok(None) } else { Err(self.missing_overload(op, Some(&pkg), None)) }
	}

	fn copy_for_postfix(&mut self, value: &Value, fallback: Fallback) -> PResult<Value> {
		// Postfix must retain the unmodified reference even when there is no other Perl alias.
		let saved = value.clone();
		let result = self.mutator_copy(value, fallback);
		drop(saved);
		result
	}

	#[inline]
	pub(super) fn overload_unary(&mut self, op: &str, v: &Value) -> PResult<Option<Value>> {
		if !matches!(v, Value::Ref(_)) || self.overloads.is_empty() { return Ok(None); }
		self.overload_builtin(op, v, None, Cx::Scalar).map(|r| r.map(Ret::scalar))
	}

	/// Apply a builtin overload to its already-evaluated arguments without repeating evaluation.
	pub fn overload_builtin(&mut self, op: &str, left: &Value, right: Option<&Value>, cx: Cx) -> PResult<Option<Ret>> {
		if self.overloads.is_empty() { return Ok(None); }
		if op == "atan2" && let Some(right) = right { return self.overload_binary(op, left, right, false).map(|out| out.map(Ret::One)); }
		let Some(pkg) = class(left) else { return Ok(None); };
		let Some(methods) = self.methods(&pkg) else { return Ok(None); };
		let fallback = methods.fallback();
		if let Some(handler) = methods.get(op) {
			return self.invoke_overload(handler, new_sv(left.clone()), right.cloned().unwrap_or(Value::Undef), Some(false), op, false, cx).map(Some);
		}
		if fallback != Fallback::Disabled {
			match op {
				"neg" if let Some(handler) = methods.get("-") => return self.invoke_scalar(handler, left, Value::Int(0), Some(true), "-", false).map(|v| Some(Ret::One(v))),
				"!" if ["bool", "0+", "\"\""].iter().any(|key| methods.get(key).is_some()) => {
					return self.truthy(left).map(|yes| Some(Ret::One(perl_bool(!yes))));
				}
				"abs" => {
					let less = methods.get("<").map(|v| (v, "<")).or_else(|| methods.get("<=>").map(|v| (v, "<=>")));
					let neg = methods.get("neg").map(|v| (v, "neg")).or_else(|| methods.get("-").map(|v| (v, "-")));
					if let (Some((less, compare)), Some((neg, key))) = (less, neg) {
						let sign = self.invoke_scalar(less, left, Value::Int(0), Some(false), compare, false)?;
						let negative = if compare == "<" { self.truthy(&sign)? } else { self.numify(&sign)?.to_f64() < 0.0 };
						let result = if !negative { left.clone() }
						else if key == "neg" { self.invoke_scalar(neg, left, Value::Undef, Some(false), key, false)? }
						else { self.invoke_scalar(neg, left, Value::Int(0), Some(true), key, false)? };
						return Ok(Some(Ret::One(result)));
					}
				}
				"int" | "<>" | "-X" | "qr" if ["0+", "\"\"", "bool"].iter().any(|k| methods.get(k).is_some()) => return Ok(None),
				_ => {}
			}
		}
		if let Some(handler) = methods.get("nomethod") {
			return self.invoke_overload(handler, new_sv(left.clone()), right.cloned().unwrap_or(Value::Undef), Some(false), op, true, cx).map(Some);
		}
		if fallback == Fallback::Builtin || matches!(op, "<>" | "-X" | "qr") { Ok(None) }
		else { Err(self.missing_overload(op, Some(&pkg), None)) }
	}

	/// Applies a conversion overload (`""`, `0+`, `bool`, with fallbacks in `keys` order); None when the value has none.
	pub(in crate::perl) fn convert_overload(&mut self, v: &Value, keys: &[&str]) -> PResult<Option<Value>> {
		if !matches!(v, Value::Ref(_)) || self.overloads.is_empty() { return Ok(None); }
		let Some(&op) = keys.first() else { return Ok(None); };
		let mut converted: Option<Value> = None;
		let mut seen = FxHashSet::default();
		loop {
			let source = converted.as_ref().unwrap_or(v);
			let Some(pkg) = class(source) else { return Ok(converted); };
			let Some(methods) = self.methods(&pkg) else { return Ok(converted); };
			let fallback = methods.fallback();
			let handler = methods.get(op).map(|v| (v, false)).or_else(|| {
				(fallback != Fallback::Disabled).then(|| keys.iter().skip(1).find_map(|key| methods.get(key).map(|v| (v, false)))).flatten()
			}).or_else(|| methods.get("nomethod").map(|v| (v, true)));
			let Some((handler, nomethod)) = handler else {
				if fallback == Fallback::Builtin { return Ok(converted); }
				return Err(self.missing_overload(op, Some(&pkg), None));
			};
			let Value::Ref(current) = source else { return Ok(converted); };
			let old = current.addr();
			let value = self.invoke_scalar(handler, source, Value::Undef, Some(false), op, nomethod)?;
			if !matches!(&value, Value::Ref(r) if r.addr() != old) { return Ok(Some(value)); }
			if seen.len() >= 96 || !seen.insert(old) { return Err(self.die_msg("Recursive overload")); }
			converted = Some(value);
		}
	}

	pub(super) fn overload_deref(&mut self, sigil: Sigil, mut value: Value) -> PResult<Value> {
		let key = match sigil { Sigil::Scalar => "${}", Sigil::Array | Sigil::LastIndex => "@{}", Sigil::Hash => "%{}", Sigil::Code => "&{}", Sigil::Glob => "*{}" };
		for _ in 0..96 {
			let Value::Ref(r) = &value else { return Ok(value); };
			let Some(pkg) = r.blessed() else { return Ok(value); };
			let Some(handler) = self.overload_handler(&pkg, key) else { return Ok(value); };
			let old = r.addr();
			let next = self.invoke_scalar(handler, &value, Value::Undef, Some(false), key, false)?;
			let Value::Ref(r) = &next else { return Err(self.die_msg("Overloaded dereference did not return a reference")); };
			if r.addr() == old { return Ok(next); }
			value = next;
		}
		Err(self.die_msg("Recursive overload"))
	}
}
