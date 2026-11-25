//! Perl container intrinsics and their scalar/list/void conventions (perlfunc).

use std::rc::Rc;

use crate::perl::{
	ast::{Builtin, Call, Expr, ExprKind, Sigil},
	interp::{Cx, Interp, PResult, Ret},
	modules::readonly_array,
	value::{Av, HKey, Hv, Num, Sv, Value, new_sv},
};

use super::{HashCursor, State, args, group_inner, int_arg, numify, scalar_args};

impl State {
	fn array_next(&mut self, av: &Av, len: usize) -> Option<usize> {
		let key = Rc::as_ptr(av) as usize;
		let next = self.array_iterators.get(&key).map_or(0, |(_, i)| *i);
		if next >= len {
			self.array_iterators.remove(&key);
			return None;
		}
		if let Some((_, i)) = self.array_iterators.get_mut(&key) {
			*i += 1;
		} else {
			if self.array_iterators.len() >= self.array_sweep_at {
				self.array_iterators.retain(|_, (av, _)| av.strong_count() != 0);
				self.array_sweep_at = self.array_iterators.len().saturating_mul(2).max(32);
			}
			self.array_iterators.insert(key, (Rc::downgrade(av), 1));
		}
		Some(next)
	}

	/// Reset `each` when an entire array is replaced.
	pub(in crate::perl) fn reset_array(&mut self, av: &Av) {
		self.array_iterators.remove(&(Rc::as_ptr(av) as usize));
	}
}

pub(super) fn aggregate_sigil(mut expr: &Expr) -> Option<Sigil> {
	loop {
		match &group_inner(expr).kind {
			ExprKind::Variable(s, _) | ExprKind::Deref(s, _) if matches!(s, Sigil::Array | Sigil::Hash) => return Some(*s),
			ExprKind::Declare(_, _, inner, _) => expr = inner,
			_ => return None,
		}
	}
}

enum Aggregate { Array(Av), Hash(Hv) }

fn aggregate(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Aggregate> {
	let expr = &scalar_args(interp, b, call, 1, 1)?[0];
	match aggregate_sigil(expr) {
		Some(Sigil::Array) => interp.eval_array(expr).map(Aggregate::Array),
		Some(Sigil::Hash) => interp.eval_hash(expr).map(Aggregate::Hash),
		_ => Err(interp.die_msg(format!("Type of arg 1 to {} must be hash or array", b.name()))),
	}
}

fn size(n: usize) -> Value { Num::UInt(n as u64).into_value() }

fn key_value(interp: &mut Interp<'_>, cx: Cx, key: Value, sv: Option<Sv>) -> PResult<Ret> {
	if cx == Cx::List {
		let value = sv.map(|s| interp.read_sv(&s)).transpose()?.unwrap_or(Value::Undef);
		Ok(Ret::Many(vec![key, value]))
	} else {
		Ok(Ret::One(key))
	}
}

fn empty(cx: Cx) -> Ret {
	if cx == Cx::List { Ret::empty() } else { Ret::One(Value::Undef) }
}

/// Return aliases instead of copies for lvalue evaluation of `values`.
pub(in crate::perl) fn value_aliases(interp: &mut Interp<'_>, call: &Call) -> PResult<Vec<Sv>> {
	match aggregate(interp, Builtin::Values, call)? {
		Aggregate::Hash(hv) => hash_value_aliases(interp, &hv),
		Aggregate::Array(av) => {
			interp.data.reset_array(&av);
			array_value_aliases(interp, &av)
		}
	}
}

pub(super) fn hash_value_aliases(interp: &mut Interp<'_>, h: &Hv) -> PResult<Vec<Sv>> {
	reset_hash(interp, h);
	if interp.tied_hash(h).is_none() {
		return Ok(h.entries().values().cloned().collect());
	}
	let keys = interp.hash_keys(h)?;
	hash_slots(interp, h, keys)
}

fn reset_hash(interp: &mut Interp<'_>, h: &Hv) {
	h.iter.set(0);
	interp.data.hash_iterators.remove(&(Rc::as_ptr(h) as usize));
}

fn hash_slots(interp: &mut Interp<'_>, h: &Hv, keys: Vec<HKey>) -> PResult<Vec<Sv>> {
	keys.into_iter().map(|k| Ok(interp.hash_cell(h, k, false)?.unwrap_or_else(|| new_sv(Value::Undef)))).collect()
}

fn array_value_aliases(interp: &mut Interp<'_>, a: &Av) -> PResult<Vec<Sv>> {
	if interp.tied_array(a).is_none() {
		return Ok(interp.array_aliases(a));
	}
	let len = interp.array_len(a)?;
	(0..len).map(|i| Ok(interp.array_cell(a, i as i64, false)?.unwrap_or_else(|| new_sv(Value::Undef)))).collect()
}

fn tied_hash_next(interp: &mut Interp<'_>, h: &Hv, object: Value) -> PResult<Option<Value>> {
	let addr = Rc::as_ptr(h) as usize;
	let previous = match interp.data.hash_iterators.get(&addr) {
		Some((_, HashCursor::Tied(key))) if h.iter.get() != 0 => Some(key.clone()),
		_ => None,
	};
	let (method, args) = previous.map_or_else(|| ("FIRSTKEY", Vec::new()), |k| ("NEXTKEY", vec![k]));
	let key = interp.call_method(object, method, args, Cx::Scalar)?.scalar();
	if key.is_undef() {
		reset_hash(interp, h);
		return Ok(None);
	}
	remember_hash(&mut interp.data, h, HashCursor::Tied(key.clone()));
	h.iter.set(1);
	Ok(Some(key))
}

fn remember_hash(data: &mut State, h: &Hv, cursor: HashCursor) {
	let key = Rc::as_ptr(h) as usize;
	if let Some((_, old)) = data.hash_iterators.get_mut(&key) {
		*old = cursor;
	} else {
		if data.hash_iterators.len() >= data.hash_sweep_at {
			data.hash_iterators.retain(|_, (h, _)| h.strong_count() != 0);
			data.hash_sweep_at = data.hash_iterators.len().saturating_mul(2).max(32);
		}
		data.hash_iterators.insert(key, (Rc::downgrade(h), cursor));
	}
}

fn plain_hash_next(interp: &mut Interp<'_>, h: &Hv, want_value: bool) -> Option<(Value, Option<Sv>)> {
	let i = h.iter.get();
	let size = h.entries().len();
	let (end, previous) = match interp.data.hash_iterators.get(&(Rc::as_ptr(h) as usize)) {
		Some((_, HashCursor::Plain { end, observed })) if i != 0 => (*end, *observed),
		_ => (size, size),
	};
	if size > previous {
		interp.warn_category_default("internal", "Use of each() on hash after insertion without resetting hash iterator results in undefined behavior");
	}
	let mut out = None;
	if i < end {
		out = h.entries().get_index(i).map(|(key, sv)| {
			(Value::Str(key.to_pstr()), want_value.then(|| sv.clone()))
		});
	}
	if out.is_some() {
		// Do not include arbitrary new keys appended during traversal. If each
		// body inserts a key, advancing beyond this bound would never finish.
		remember_hash(&mut interp.data, h, HashCursor::Plain { end, observed: size });
		h.iter.set(i + 1);
	} else {
		reset_hash(interp, h);
	}
	out
}

pub(super) fn traverse(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	let each = b == Builtin::Each;
	let keys = b == Builtin::Keys;
	match aggregate(interp, b, call)? {
		Aggregate::Hash(h) => {
			if each {
				if let Some(object) = interp.tied_hash(&h) {
					let Some(key) = tied_hash_next(interp, &h, object)? else { return Ok(empty(cx)); };
					let sv = if cx == Cx::List {
						let text = interp.stringify(&key)?;
						interp.hash_cell(&h, HKey::new(&text), false)?
					} else { None };
					return key_value(interp, cx, key, sv);
				}
				if let Some((key, sv)) = plain_hash_next(interp, &h, cx == Cx::List) {
					key_value(interp, cx, key, sv)
				} else {
					Ok(empty(cx))
				}
			} else {
				reset_hash(interp, &h);
				if cx == Cx::Void { return Ok(Ret::One(Value::Undef)); }
				if interp.tied_hash(&h).is_some() {
					let all = interp.hash_keys(&h)?;
					if cx != Cx::List { return Ok(Ret::One(size(all.len()))); }
					if keys { return Ok(Ret::Many(all.into_iter().map(|k| Value::Str(k.to_pstr())).collect())); }
					let slots = hash_slots(interp, &h, all)?;
					return read_all(interp, slots);
				}
				if cx != Cx::List { return Ok(Ret::One(size(h.entries().len()))); }
				if keys { return Ok(Ret::Many(h.entries().keys().map(|key| Value::Str(key.to_pstr())).collect())); }
				let slots: Vec<_> = h.entries().values().cloned().collect();
				read_all(interp, slots)
			}
		}
		Aggregate::Array(a) => {
			if each {
				let count = interp.array_len(&a)?;
				if let Some(i) = interp.data.array_next(&a, count) {
					let slot = if cx == Cx::List { interp.array_cell(&a, i as i64, false)? } else { None };
					key_value(interp, cx, size(i), slot)
				} else {
					Ok(empty(cx))
				}
			} else {
				interp.data.reset_array(&a);
				match cx {
					Cx::Void => Ok(Ret::One(Value::Undef)),
					Cx::List if keys => Ok(Ret::Many((0..interp.array_len(&a)?).map(size).collect())),
					Cx::List => {
						if interp.tied_array(&a).is_some() {
							let slots = array_value_aliases(interp, &a)?;
							read_all(interp, slots)
						} else {
							let slots = a.elems().clone();
							read_all(interp, slots)
						}
					}
					Cx::Scalar => Ok(Ret::One(size(interp.array_len(&a)?))),
				}
			}
		}
	}
}

fn read_all(interp: &mut Interp<'_>, slots: Vec<Sv>) -> PResult<Ret> {
	Ok(Ret::Many(slots.into_iter().map(|s| interp.read_sv(&s)).collect::<PResult<_>>()?))
}

pub(super) fn reserve(interp: &mut Interp<'_>, call: &Call, value: Value) -> PResult<Value> {
	let Aggregate::Hash(hv) = aggregate(interp, Builtin::Keys, call)? else {
		return Err(interp.die_msg("Can't modify keys on array in scalar assignment"));
	};
	let n = super::iv(numify(interp, &value, None, "scalar assignment", false)?);
	reset_hash(interp, &hv);
	if interp.tied_hash(&hv).is_some() { return Ok(size(interp.hash_keys(&hv)?.len())); }
	let mut map = hv.entries_mut();
	let len = map.len();
	let additional = (n.max(0) as usize).saturating_sub(len);
	if additional > 16_777_216 || additional > 0 && map.try_reserve(additional).is_err() {
		drop(map);
		return Err(interp.die_msg("Out of memory during hash extend"));
	}
	Ok(size(len))
}

fn removed(interp: &mut Interp<'_>, sv: Option<Sv>) -> PResult<Ret> {
	Ok(Ret::One(sv.map(|s| interp.read_sv(&s)).transpose()?.unwrap_or(Value::Undef)))
}

pub(super) fn mutate(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	let args = args(call);
	if matches!(b, Builtin::Shift | Builtin::Pop) && args.len() > 1 {
		return Err(interp.die_msg(format!("Too many arguments for {}", b.name())));
	}
	let array = match args.first() {
		Some(e) => interp.eval_array(e)?,
		None if matches!(b, Builtin::Shift | Builtin::Pop) => interp.default_array(),
		None => return Err(interp.die_msg(format!("Not enough arguments for {}", b.name()))),
	};
	if let Some(tied) = interp.tied_array(&array) {
		let mut operands = Vec::new();
		for (i, e) in args.iter().skip(1).enumerate() {
			if b == Builtin::Splice && i < 2 { operands.push(interp.eval_scalar(e)?); }
			else { operands.extend(interp.eval_list(e)?); }
		}
		let method = match b {
			Builtin::Push => "PUSH", Builtin::Pop => "POP", Builtin::Shift => "SHIFT",
			Builtin::Unshift => "UNSHIFT", Builtin::Splice => "SPLICE",
			_ => unreachable!("not an array mutation"),
		};
		let context = if b == Builtin::Splice { cx } else { Cx::Scalar };
		let value = interp.call_method(tied, method, operands, context)?;
		return if matches!(b, Builtin::Push | Builtin::Unshift) {
			Ok(Ret::One(if cx == Cx::Void { Value::Undef } else { size(interp.array_len(&array)?) }))
		} else if b == Builtin::Splice && cx == Cx::List {
			Ok(value)
		} else {
			Ok(Ret::One(value.scalar()))
		};
	}
	let (offset, length, replacement) = if b == Builtin::Splice {
		let offset = args.get(1).map(|e| int_arg(interp, e, "splice")).transpose()?.unwrap_or(0);
		let length = args.get(2).map(|e| int_arg(interp, e, "splice")).transpose()?;
		(offset, length, args.get(3..).unwrap_or_default())
	} else {
		(0, None, args.get(1..).unwrap_or_default())
	};
	let mut replace = Vec::new();
	for e in replacement {
		replace.extend(interp.eval_list(e)?.into_iter().map(new_sv));
	}
	if readonly_array(interp, &array) && (b != Builtin::Push || !replace.is_empty()) {
		return Err(interp.die_msg("Modification of a read-only value attempted"));
	}
	let result = edit(interp, b, &array, offset, length, replace, cx);
	// An edited @ISA invalidates method caches and is checked for recursive inheritance.
	interp.array_changed(&array)?;
	result
}

/// Apply push/pop/shift/unshift/splice to an untied array.
fn edit(interp: &mut Interp<'_>, b: Builtin, array: &Av, offset: i64, length: Option<i64>, replace: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut elems = array.elems_mut();
	let count = elems.len();
	Ok(match b {
		Builtin::Pop | Builtin::Shift => {
			let popped = if b == Builtin::Pop { elems.pop() } else { (count != 0).then(|| elems.remove(0)) };
			drop(elems);
			return removed(interp, popped);
		}
		Builtin::Push => {
			elems.extend(replace);
			Ret::One(size(elems.len()))
		}
		Builtin::Unshift => {
			elems.splice(..0, replace);
			Ret::One(size(elems.len()))
		}
		Builtin::Splice => {
			let start = if offset < 0 {
				let Some(start) = count.checked_sub(offset.unsigned_abs() as usize) else {
					drop(elems);
					return Err(interp.die_msg(format!("Modification of non-creatable array value attempted, subscript {offset}")));
				};
				start
			} else {
				offset as usize
			};
			if start > count && length.is_some() && interp.warn_on("misc") {
				// Do not keep the container borrowed while a user warning handler runs.
				drop(elems);
				interp.warn_category("misc", "splice() offset past end of array");
				elems = array.elems_mut();
			}
			let count = elems.len();
			let start = start.min(count);
			let end = match length {
				Some(n) if n < 0 => count.saturating_sub(n.unsigned_abs() as usize).max(start),
				Some(n) => start.saturating_add(n as usize).min(count),
				None => count,
			};
			let mut slice = elems.splice(start..end, replace);
			return match cx {
				Cx::List => {
					let removed = slice.collect::<Vec<_>>();
					drop(elems);
					read_all(interp, removed)
				}
				Cx::Scalar => {
					let popped = slice.next_back();
					drop(slice);
					drop(elems);
					removed(interp, popped)
				}
				Cx::Void => Ok(Ret::One(Value::Undef)),
			};
		}
		_ => unreachable!("not an array mutation"),
	})
}

/// Reverse an array into itself, retaining holes and swapping its existing cells.
pub(in crate::perl) fn reverse_in_place(interp: &mut Interp<'_>, a: &Av, cx: Cx) -> PResult<Ret> {
	if readonly_array(interp, a) { return Err(interp.die_msg("Modification of a read-only value attempted")); }
	let len = interp.array_len(a)?;
	if let Some(tied) = interp.tied_array(a) {
		for left in 0..len / 2 {
			let right = len - 1 - left;
			let mut slots = [None, None];
			for (i, index) in [left, right].into_iter().enumerate() {
				let exists = interp.call_method(tied.clone(), "EXISTS", vec![size(index)], Cx::Scalar)?.scalar();
				if interp.truthy(&exists)? {
					slots[i] = interp.array_cell(a, index as i64, false)?;
				}
			}
			let [left_sv, right_sv] = slots;
			let lv = left_sv.map(|sv| interp.read_sv(&sv)).transpose()?;
			let rv = right_sv.map(|sv| interp.read_sv(&sv)).transpose()?;
			let mut found = [lv.is_some(), rv.is_some()].into_iter();
			for (index, value) in [(left, rv), (right, lv)] {
				let existed = found.next().unwrap_or(false);
				if let Some(v) = value {
					interp.call_method(tied.clone(), "STORE", vec![size(index), v], Cx::Void)?;
				} else if existed {
					interp.call_method(tied.clone(), "DELETE", vec![size(index)], Cx::Void)?;
				}
			}
		}
	} else {
		a.elems_mut().reverse();
	}
	interp.data.reset_array(a);
	match cx {
		Cx::List => {
			let cells = if interp.tied_array(a).is_some() { array_value_aliases(interp, a)? } else { a.elems().clone() };
			read_all(interp, cells)
		}
		_ => Ok(Ret::One(size(len))),
	}
}
