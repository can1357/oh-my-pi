//! Character and byte operations, record truncation and assignable string slices (perlfunc).

use std::cell::Cell;

use crate::perl::{
	ast::{Builtin, Call, CallTarget, Expr, ExprKind, QuoteKind, QuotePart, Select, Sigil},
	interp::{Cx, Interp, Lvalue, PResult, Ret, new_lvalue},
	io::RecordSep,
	limits::check_len,
	pack::encode_utf8,
	value::{Num, PStr, Sv, Value, format_float, new_sv},
};

use super::{ScalarInput, args, offsets, group_inner, int_arg, iv, list::aggregate_sigil, numify, operand, scalar_args, scalar_input, stringify, unicode, warn_undef};

pub(super) fn unary(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Value> {
	use Builtin as B;
	let e = scalar_args(interp, b, call, 0, 1)?.first();
	let bytes = interp.hints().bytes;
	let value = if b == B::Length && !bytes {
		// A UTF-8 scalar's character count is cached rather than recounted per call.
		let input = match e { Some(e) => scalar_input(interp, e)?, None => ScalarInput::Cell(interp.topic()) };
		if let ScalarInput::Cell(sv) = &input && let Some(len) = offsets::with_utf8(interp, sv, |s| s.len()) {
			return Ok(Num::UInt(len as u64).into_value());
		}
		input.into_value(interp)?
	} else {
		operand(interp, e)?
	};
	if b == B::Chr {
		let n = numify(interp, &value, e, "chr", true)?;
		let f = n.to_f64();
		if !f.is_finite() {
			return Err(interp.die_msg(format!("Cannot chr {}", format_float(f).to_string_lossy())));
		}
		if bytes { return Ok(Value::Str(PStr::new(vec![n.to_u64() as u8], false))); }
		let cp = if f < 0.0 {
			if interp.warn_on("utf8") {
				interp.warn_category("utf8", format!("Invalid negative number ({}) in chr", n.into_value().to_pstr().to_string_lossy()));
			}
			0xfffd
		} else {
			n.to_u64()
		};
		if cp > i64::MAX as u64 {
			return Err(interp.die_msg(format!("Use of code point 0x{cp:X} is not allowed; the permissible max is 0x7FFFFFFFFFFFFFFF")));
		}
		let s = if let Ok(b) = u8::try_from(cp) { PStr::new(vec![b], false) } else {
			PStr::new(encode_utf8(cp, &mut [0; 13]).to_vec(), true)
		};
		return Ok(Value::Str(s));
	}
	if b == B::Length && value.is_undef() { return Ok(Value::Undef); }
	let mut s = stringify(interp, value, e, b.name(), true)?;
	if bytes { s.utf8 = false; }
	let unicode_strings = !bytes && interp.hints().features.unicode_strings;
	Ok(match b {
		B::Length => Num::UInt(s.char_len() as u64).into_value(),
		B::Ord => Value::Int(ord(&s) as i64),
		B::Quotemeta => Value::Str(unicode::quote_meta(s, unicode_strings)),
		B::Lc | B::Lcfirst | B::Uc | B::Ucfirst | B::Fc => Value::Str(unicode::map_case(s, b, unicode_strings)),
		_ => unreachable!("not a string intrinsic"),
	})
}

fn ord(s: &PStr) -> u64 {
	let Some((&lead, remaining)) = s.bytes.split_first() else { return 0; };
	if !s.utf8 || lead.is_ascii() { return u64::from(lead); }
	if lead >= 0xfe {
		let width = if lead == 0xff { 12 } else { 6 };
		let Some(tail) = remaining.get(..width) else { return 0; };
		return tail.iter().try_fold(0_u64, |n, &b| {
			(b & 0xc0 == 0x80 && n < (1 << 57)).then_some((n << 6) | u64::from(b & 0x3f))
		}).unwrap_or(0);
	}
	u64::from(s.chars().next().unwrap_or(0))
}

pub(super) fn index(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Value> {
	let exprs = scalar_args(interp, b, call, 2, 3)?;
	let op = b.name();
	let a = scalar_input(interp, &exprs[0])?;
	let needle = scalar_input(interp, &exprs[1])?;
	let offset = exprs.get(2).map(|e| int_arg(interp, e, op)).transpose()?;
	if !interp.hints().bytes && let ScalarInput::Cell(sv) = &a && offsets::plain_utf8(interp, sv) {
		// A defined UTF-8 string reads without side effects, so the needle may be read first;
		// offsets then resume from the scalar's cached mark instead of rescanning.
		let sv = sv.clone();
		let needle = needle.into_value(interp)?;
		let mut needle = stringify(interp, needle, exprs.get(1), op, false)?;
		needle.upgrade();
		if let Some(r) = offsets::with_utf8(interp, &sv, |s| search(s, &needle.bytes, b, offset)) { return Ok(Value::Int(r)); }
		let a = a.into_value(interp)?;
		let mut s = stringify(interp, a, exprs.first(), op, false)?;
		s.upgrade();
		return Ok(Value::Int(search(&mut s, &needle.bytes, b, offset)));
	}
	let a = a.into_value(interp)?;
	let needle = needle.into_value(interp)?;
	let mut s = stringify(interp, a, exprs.first(), op, false)?;
	let mut needle = stringify(interp, needle, exprs.get(1), op, false)?;
	if interp.hints().bytes {
		s.utf8 = false;
	} else if s.utf8 != needle.utf8 {
		s.upgrade();
		needle.upgrade();
	}
	Ok(Value::Int(search(&mut s, &needle.bytes, b, offset)))
}

/// Character-indexed text searched by index/rindex.
trait Text {
	fn raw(&self) -> &[u8];
	fn byte_of(&mut self, index: usize) -> usize;
	fn char_of(&mut self, byte: usize) -> usize;
}

impl Text for PStr {
	fn raw(&self) -> &[u8] { &self.bytes }
	fn byte_of(&mut self, index: usize) -> usize { self.char_to_byte(index) }
	fn char_of(&mut self, byte: usize) -> usize { self.byte_to_char(byte) }
}

impl Text for offsets::Utf8View<'_> {
	fn raw(&self) -> &[u8] { self.bytes }
	fn byte_of(&mut self, index: usize) -> usize { offsets::Utf8View::byte_of(self, index) }
	fn char_of(&mut self, byte: usize) -> usize { offsets::Utf8View::char_of(self, byte) }
}

/// index/rindex over text whose encoding already matches the needle's.
fn search(s: &mut impl Text, needle: &[u8], b: Builtin, offset: Option<i64>) -> i64 {
	let r = if b == Builtin::Index {
		let start = s.byte_of(offset.unwrap_or(0).max(0) as usize);
		if needle.is_empty() { return s.char_of(start) as i64; }
		memchr::memmem::find(&s.raw()[start..], needle).map(|i| i + start)
	} else if let Some(offset) = offset {
		if needle.is_empty() {
			let at = s.byte_of(offset.max(0) as usize);
			return s.char_of(at) as i64;
		}
		if offset < 0 { return -1; }
		let end = s.byte_of(offset as usize).saturating_add(needle.len()).min(s.raw().len());
		memchr::memmem::rfind(&s.raw()[..end], needle)
	} else {
		memchr::memmem::rfind(s.raw(), needle)
	};
	r.map_or(-1, |i| s.char_of(i) as i64)
}

pub(super) fn concat(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	let exprs = args(call);
	if b == Builtin::Reverse && cx != Cx::Scalar {
		let mut values = Vec::new();
		for e in exprs { values.extend(interp.eval_list(e)?); }
		if cx == Cx::Void { return Ok(Ret::One(Value::Undef)); }
		values.reverse();
		return Ok(Ret::Many(values));
	}
	let (list, sep, op) = if b == Builtin::Join {
		let Some((separator, rest)) = exprs.split_first() else { return Err(interp.die_msg("Not enough arguments for join or string")); };
		(rest, Some((scalar_input(interp, separator)?, separator)), "join or string")
	} else {
		(exprs, None, "reverse")
	};
	let mut args = Vec::new();
	for e in list {
		if matches!(&group_inner(e).kind, ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _)) {
			args.push((scalar_input(interp, e)?, Some(e)));
		} else {
			args.extend(interp.eval_list(e)?.into_iter().map(|v| (ScalarInput::Owned(v), None)));
		}
	}
	let bytes = interp.hints().bytes;
	let join_bytes = bytes && (b == Builtin::Join || args.len() > 1);
	let mut separator = if let Some((sep, expr)) = sep {
		let value = sep.into_value(interp)?;
		stringify(interp, value, Some(expr), op, false)?
	} else {
		PStr::default()
	};
	if join_bytes { separator.utf8 = false; }
	let mut result = if args.is_empty() && b == Builtin::Reverse {
		let v = operand(interp, None)?;
		stringify(interp, v, None, op, true)?
	} else {
		let mut iter = args.into_iter();
		if let Some((first, expr)) = iter.next() {
			let first = first.into_value(interp)?;
			let mut result = stringify(interp, first, expr, op, false)?;
			if join_bytes { result.utf8 = false; }
			for (v, expr) in iter {
				if b == Builtin::Join { result.push(&separator); }
				let v = v.into_value(interp)?;
				let mut s = stringify(interp, v, expr, op, false)?;
				if join_bytes { s.utf8 = false; }
				result.push(&s);
			}
			result
		} else {
			PStr::default()
		}
	};
	if b == Builtin::Reverse {
		if result.utf8 && !bytes {
			// Reverse each code point's bytes, then reverse the whole buffer.
			let mut start = 0;
			while start < result.bytes.len() {
				let lead = result.bytes[start];
				let width = if lead == 0xff { 13 } else { (lead.leading_ones() as usize).max(1) };
				let end = start + result.bytes[start + 1..].iter().take(width - 1).take_while(|&&c| c & 0xc0 == 0x80).count() + 1;
				result.bytes[start..end].reverse();
				start = end;
			}
		}
		result.bytes.reverse();
	}
	Ok(Ret::One(Value::Str(result)))
}

fn trim_slots<'a>(interp: &mut Interp<'_>, exprs: &'a [Expr]) -> PResult<Vec<(Sv, Option<&'a Expr>)>> {
	if exprs.is_empty() { return Ok(vec![(interp.topic(), None)]); }
	let mut stack: Vec<_> = exprs.iter().rev().collect();
	let mut slots = Vec::new();
	while let Some(e) = stack.pop() {
		let e = group_inner(e);
		match &e.kind {
			ExprKind::List(list) => stack.extend(list.iter().rev()),
			_ if aggregate_sigil(e) == Some(Sigil::Hash) => {
				let h = interp.eval_hash(e)?;
				slots.extend(super::list::hash_value_aliases(interp, &h)?.into_iter().map(|sv| (sv, None)));
			}
			_ => slots.extend(interp.eval_aliases(e)?.into_iter().map(|sv| (sv, Some(e)))),
		}
	}
	Ok(slots)
}

pub(super) fn trim(interp: &mut Interp<'_>, call: &Call, chomp: bool) -> PResult<Value> {
	let exprs = args(call);
	let implicit_sep = (chomp && exprs.is_empty()).then(|| interp.record_sep_for_read());
	if matches!(implicit_sep.as_deref(), Some(RecordSep::Text(sep)) if !sep.utf8 && sep.bytes == b"\n") {
		let topic = interp.topic();
		if let Some(value) = topic.plain_value() && let Value::Str(text) = &*value && !text.utf8 {
			if !text.bytes.ends_with(b"\n") { return Ok(Value::Int(0)); }
			drop(value);
			if !interp.is_readonly_sv(&topic) && let Ok(mut raw) = topic.try_value_mut()
				&& let Value::Str(text) = &mut *raw
			{
				text.bytes.pop();
				topic.set_pos(None);
				return Ok(Value::Int(1));
			}
		}
	}
	let name = if chomp { "chomp" } else { "chop" };
	let mut pending: Vec<&Expr> = exprs.iter().collect();
	while let Some(e) = pending.pop() {
		let what = match &group_inner(e).kind {
			ExprKind::List(list) => { pending.extend(list); continue; }
			ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) | ExprKind::Version(_) => "constant item",
			ExprKind::Quote(QuoteKind::String, parts) if parts.iter().all(|p| matches!(p, QuotePart::Literal(_))) => "constant item",
			ExprKind::Quote(QuoteKind::String, _) => "string",
			_ => continue,
		};
		return Err(interp.die_msg(format!("Can't modify {what} in {name}")));
	}
	let slots = trim_slots(interp, exprs)?;
	let bytes = interp.hints().bytes;
	let sep = implicit_sep.or_else(|| chomp.then(|| interp.record_sep_for_read()));
	if matches!(sep.as_deref(), Some(RecordSep::Slurp | RecordSep::Fixed(_))) { return Ok(Value::Int(0)); }
	let is_scalar = exprs.is_empty() || (exprs.len() == 1 && aggregate_sigil(&exprs[0]).is_none()
		&& !matches!(group_inner(&exprs[0]).kind, ExprKind::List(_) | ExprKind::Select(_, Select::ArraySlice(_) | Select::HashSlice(_) | Select::ArrayPairs(_) | Select::HashPairs(_), _)));
	let mut removed = 0;
	let mut last = Value::Undef;
	let op = match (chomp, is_scalar) {
		(true, true) => "scalar chomp", (false, true) => "scalar chop", (true, false) => "chomp", (false, false) => "chop",
	};
	for (slot, expr) in slots {
		let v = interp.read_sv(&slot)?;
		if v.is_undef() {
			warn_undef(interp, expr, op, exprs.is_empty());
			last = Value::Str(PStr::default());
			continue;
		}
		let mut s = stringify(interp, v, expr, op, false)?;
		let cut = if let Some(sep) = sep.as_deref() {
			match sep {
				RecordSep::Text(text) => {
					let suffix;
					let comparable = if text.utf8 == s.utf8 || text.bytes.is_ascii() {
						Some(text.bytes.as_slice())
					} else if s.utf8 {
						let mut encoded = text.clone();
						encoded.upgrade();
						suffix = encoded.bytes;
						Some(suffix.as_slice())
					} else {
						suffix = text.downgraded().unwrap_or_default();
						(!suffix.is_empty() || text.is_empty()).then_some(suffix.as_slice())
					};
					comparable.filter(|t| s.bytes.ends_with(t)).map(|t| (s.bytes.len() - t.len(), text.char_len()))
				}
				RecordSep::Paragraph => {
					let n = s.bytes.iter().rev().take_while(|&&b| b == b'\n').count();
					Some((s.bytes.len() - n, n))
				}
				_ => None,
			}
		} else if s.bytes.is_empty() {
			last = Value::Str(PStr::new(Vec::new(), s.utf8 && !bytes));
			None
		} else {
			if bytes { s.utf8 = false; }
			let mut at = s.bytes.len() - 1;
			if s.utf8 { while at > 0 && s.bytes[at] & 0xc0 == 0x80 { at -= 1; } }
			last = Value::Str(PStr::new(s.bytes[at..].to_vec(), s.utf8));
			Some((at, 1))
		};
		if let Some((at, n)) = cut.filter(|(_, n)| *n != 0) {
			removed += n;
			s.bytes.truncate(at);
			interp.write_sv(&slot, Value::Str(s))?;
		}
	}
	Ok(if chomp { Num::UInt(removed as u64).into_value() } else { last })
}

fn substr_bounds(size: usize, offset: i64, length: Option<i64>) -> Option<(usize, usize)> {
	let size = size as i128;
	let offset = i128::from(offset);
	let start = if offset < 0 { size + offset } else { offset };
	let end = match length {
		Some(n) if n < 0 => (size + i128::from(n)).max(start),
		Some(n) => start + i128::from(n),
		None => size,
	};
	if end < 0 || start > size { return None; }
	Some((start.max(0) as usize, end.min(size) as usize))
}

pub(super) fn substr(interp: &mut Interp<'_>, call: &Call, assign: Option<Value>, cx: Cx) -> PResult<Value> {
	let exprs = scalar_args(interp, Builtin::Substr, call, 2, 4)?;
	if assign.is_some() && exprs.len() == 4 {
		return Err(interp.die_msg("Can't modify substr in scalar assignment"));
	}
	let target = &exprs[0];
	let original = if exprs.len() == 4 && matches!(&group_inner(target).kind,
		ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Delete | Builtin::Shift | Builtin::Pop, _), .. }))
	{
		// 4-arg substr's first operand is a loose lvalue: `delete $h{k}` edits the removed element itself.
		let mut cells = interp.eval_aliases(target)?;
		ScalarInput::Cell(cells.pop().unwrap_or_else(|| new_sv(Value::Undef)))
	} else if assign.is_some() || exprs.len() == 4 {
		ScalarInput::Cell(interp.eval_lvalue(target)?)
	} else {
		scalar_input(interp, target)?
	};
	let (offset, len) = substr_args(interp, exprs)?;
	let bytes = interp.hints().bytes;
	if let Some(assigned) = assign {
		let ScalarInput::Cell(source) = original else { unreachable!("assignment has a slot"); };
		return write_substr(interp, &source, Some(target), offset, len, bytes, assigned, None, SubstrResult::Assigned).map(|r| r.value);
	}
	if let Some(replacement) = exprs.get(3) {
		let v = interp.eval_scalar(replacement)?;
		let ScalarInput::Cell(source) = original else { unreachable!("replacement has a slot"); };
		let result = if cx == Cx::Void { SubstrResult::Void } else { SubstrResult::Removed };
		write_substr(interp, &source, Some(target), offset, len, bytes, v, Some(replacement), result).map(|r| r.value)
	} else {
		if !bytes && let ScalarInput::Cell(sv) = &original
			&& let Some(part) = offsets::with_utf8(interp, sv, |s| {
				substr_bounds(s.len(), offset, len).map(|(start, end)| {
					let at = s.byte_of(start);
					let stop = s.byte_of(end);
					PStr::new(s.bytes[at..stop].to_vec(), true)
				})
			}) {
			// Sliced from the borrowed string at cached offsets, without copying it whole.
			return Ok(match part {
				Some(part) => Value::Str(part),
				None => {
					interp.warn_category("substr", "substr outside of string");
					Value::Undef
				}
			});
		}
		let value = original.into_value(interp)?;
		read_substr(interp, value, Some(target), offset, len, bytes)
	}
}

fn substr_args(interp: &mut Interp<'_>, exprs: &[Expr]) -> PResult<(i64, Option<i64>)> {
	let position = |interp: &mut Interp<'_>, e| -> PResult<i64> {
		let v = interp.eval_scalar(e)?;
		Ok(iv(numify(interp, &v, Some(e), "substr", false)?))
	};
	Ok((position(interp, &exprs[1])?, exprs.get(2).map(|e| position(interp, e)).transpose()?))
}

#[derive(Clone, Copy)]
enum SubstrResult { Removed, Assigned, Void }

struct SubstrWrite {
	value: Value,
	removed: i64,
	inserted: i64,
}

fn write_substr(
	interp: &mut Interp<'_>, source: &Sv, target: Option<&Expr>, offset: i64, len: Option<i64>,
	bytes: bool, value: Value, expr: Option<&Expr>, result: SubstrResult,
) -> PResult<SubstrWrite> {
	if !bytes && let Some(done) = write_substr_in_place(interp, source, offset, len, &value, result) { return done; }
	let input = interp.read_sv(source)?;
	if matches!(input, Value::Ref(_)) {
		interp.warn_category("substr", "Attempt to use reference as lvalue in substr");
	}
	let assigned = matches!(result, SubstrResult::Assigned);
	let op = if assigned { "scalar assignment" } else { "substr" };
	let mut s = stringify(interp, input, target, op, false)?;
	let len_before = if bytes { s.bytes.len() } else { s.char_len() };
	let Some((start, end)) = substr_bounds(len_before, offset, len) else {
		return Err(interp.die_msg("substr outside of string"));
	};
	let mut replacement = stringify(interp, value, expr, op, false)?;
	let inserted = (if bytes { replacement.bytes.len() } else { replacement.char_len() }) as i64;
	let old_flag = s.utf8;
	let (at, stop) = if bytes { (start, end) } else {
		if s.utf8 != replacement.utf8 { s.upgrade(); replacement.upgrade(); }
		(s.char_to_byte(start), s.char_to_byte(end))
	};
	let value = match result {
		SubstrResult::Assigned => Value::Str(PStr::new(replacement.bytes.clone(), replacement.utf8 && !bytes)),
		SubstrResult::Void => Value::Undef,
		SubstrResult::Removed => {
			let mut part = PStr::new(s.bytes[at..stop].to_vec(), s.utf8 && !bytes);
			if part.utf8 && !old_flag && let Some(latin1) = part.downgraded() { part = PStr::new(latin1, false); }
			Value::Str(part)
		}
	};
	s.bytes.splice(at..stop, replacement.bytes);
	interp.write_sv(source, Value::Str(s))?;
	Ok(SubstrWrite { value, removed: (end - start) as i64, inserted })
}

/// Splice a string replacement into a magic-free string scalar without copying the
/// whole string; `None` when the general path must handle it (magic, read-only,
/// non-string operands, an encoding change, or malformed UTF-8).
fn write_substr_in_place(
	interp: &mut Interp<'_>, source: &Sv, offset: i64, len: Option<i64>, value: &Value, result: SubstrResult,
) -> Option<PResult<SubstrWrite>> {
	if interp.is_magical_sv(source) || interp.is_readonly_sv(source) { return None; }
	let Value::Str(replacement) = value else { return None };
	let utf8 = {
		let current = source.try_value().ok()?;
		let Value::Str(s) = &*current else { return None };
		// Equal encodings, or ASCII into UTF-8: the target's flag does not change.
		if s.utf8 != replacement.utf8 && !(s.utf8 && replacement.bytes.is_ascii()) { return None; }
		s.utf8
	};
	let bounds = if utf8 {
		offsets::with_utf8(interp, source, |s| {
			substr_bounds(s.len(), offset, len).map(|(start, end)| (start, end, s.byte_of(start), s.byte_of(end)))
		})?
	} else {
		let size = source.try_value().ok().map_or(0, |v| if let Value::Str(s) = &*v { s.bytes.len() } else { 0 });
		substr_bounds(size, offset, len).map(|(start, end)| (start, end, start, end))
	};
	let Some((start, end, at, stop)) = bounds else { return Some(Err(interp.die_msg("substr outside of string"))) };
	let inserted = (if utf8 { replacement.char_len() } else { replacement.bytes.len() }) as i64;
	let mut raw = source.try_value_mut().ok()?;
	let Value::Str(s) = &mut *raw else { return None };
	let value = match result {
		SubstrResult::Assigned => Value::Str(PStr::new(replacement.bytes.clone(), utf8)),
		SubstrResult::Void => Value::Undef,
		SubstrResult::Removed => Value::Str(PStr::new(s.bytes[at..stop].to_vec(), utf8)),
	};
	s.bytes.splice(at..stop, replacement.bytes.iter().copied());
	drop(raw);
	source.pos.set(None);
	if utf8 { offsets::spliced(interp, source, at, start, end - start, &replacement.bytes); }
	Some(Ok(SubstrWrite { value, removed: (end - start) as i64, inserted }))
}

fn read_substr(interp: &mut Interp<'_>, v: Value, target: Option<&Expr>, offset: i64, length: Option<i64>, bytes: bool) -> PResult<Value> {
	let mut s = stringify(interp, v, target, "substr", false)?;
	if bytes { s.utf8 = false; }
	let Some((start, end)) = substr_bounds(s.char_len(), offset, length) else {
		interp.warn_category("substr", "substr outside of string");
		return Ok(Value::Undef);
	};
	let (at, end) = (s.char_to_byte(start), s.char_to_byte(end));
	if at == 0 && end == s.bytes.len() { Ok(Value::Str(s)) }
	else { Ok(Value::Str(PStr::new(s.bytes[at..end].to_vec(), s.utf8))) }
}

pub(super) fn vec(interp: &mut Interp<'_>, call: &Call, assign: Option<Value>) -> PResult<Value> {
	let exprs = scalar_args(interp, Builtin::Vec, call, 3, 3)?;
	let write = assign.is_some();
	let input = if write { ScalarInput::Cell(interp.eval_lvalue(&exprs[0])?) } else { scalar_input(interp, &exprs[0])? };
	let (offset, bits) = vec_args(interp, exprs)?;
	vec_at(interp, input, exprs.first(), offset, bits, assign)
}

fn vec_args(interp: &mut Interp<'_>, exprs: &[Expr]) -> PResult<(i64, i64)> {
	let e = &exprs[1];
	let value = interp.eval_scalar(e)?;
	let offset = iv(numify(interp, &value, Some(e), "vec", false)?);
	Ok((offset, int_arg(interp, &exprs[2], "vec")?))
}

fn vec_at(interp: &mut Interp<'_>, input: ScalarInput, expr: Option<&Expr>, offset: i64, bits: i64, assign: Option<Value>) -> PResult<Value> {
	let write = assign.is_some();
	if offset < 0 {
		return if write { Err(interp.die_msg("Negative offset to vec in lvalue context")) } else { Ok(Value::Int(0)) };
	}
	if bits < 1 || !(bits as u64).is_power_of_two() { return Err(interp.die_msg("Illegal number of bits in vec")); }
	let (offset, bits) = (offset as usize, bits as usize);
	// A plain byte-string scalar is read in place and edited in place, so bit-vector
	// loops do not copy the whole string per access.
	if let ScalarInput::Cell(sv) = &input && !interp.is_magical_sv(sv) && (!write || !interp.is_readonly_sv(sv))
		&& sv.try_value().is_ok_and(|v| match &*v { Value::Str(s) => !s.utf8, Value::Undef => write, _ => false })
	{
		return vec_plain(interp, sv, offset, bits, assign);
	}
	let (slot, v) = match input {
		ScalarInput::Cell(sv) => {
			let v = interp.read_sv(&sv)?;
			(Some(sv), v)
		}
		ScalarInput::Owned(v) => (None, v),
	};
	let downgrade_slot = !write && matches!(&v, Value::Str(s) if s.utf8)
		&& slot.as_ref().is_some_and(|sv| !interp.is_lvalue(sv));
	let s = if write && v.is_undef() { PStr::default() } else { stringify(interp, v, expr, "vec", false)? };
	let new_pos = if downgrade_slot {
		slot.as_ref().and_then(|sv| sv.pos.get()).map(|pos| s.byte_to_char(pos))
	} else { None };
	let mut bytes = if !s.utf8 { s.bytes } else {
		s.downgraded().ok_or_else(|| interp.die_msg("Use of strings with code points over 0xFF as arguments to vec is forbidden"))?
	};
	let Some(address) = vec_address(offset, bits) else {
		return if write { Err(interp.die_msg("Out of memory!")) } else { Ok(Value::Int(0)) };
	};
	vec_portable_warning(interp, bits, write || address.0 < bytes.len());
	let result = if let (Some(sv), Some(v)) = (&slot, assign) {
		let word = numify(interp, &v, None, "scalar assignment", false)?.to_u64() & vec_mask(bits);
		if interp.is_magical_sv(sv) {
			// perl's vec lvalue fetches its target again when the assignment lands (tied FETCH twice).
			let again = interp.read_sv(sv)?;
			let s = if again.is_undef() { PStr::default() } else { stringify(interp, again, expr, "vec", false)? };
			bytes = if !s.utf8 { s.bytes } else {
				s.downgraded().ok_or_else(|| interp.die_msg("Use of strings with code points over 0xFF as arguments to vec is forbidden"))?
			};
		}
		vec_set(&mut bytes, address, bits, word).map_err(|()| interp.die_msg("Out of memory!"))?;
		interp.write_sv(sv, Value::Str(PStr::new(std::mem::take(&mut bytes), false)))?;
		if bits > 64 { 0 } else { word }
	} else {
		vec_get(&bytes, address, bits)
	};
	if downgrade_slot && let Some(sv) = slot {
		// This is an encoding-only update, not a Perl assignment: do not emit
		// tied STORE or reject a read-only scalar, and retain its match position.
		sv.set(Value::Str(PStr::new(bytes, false)));
		sv.pos.set(new_pos);
	}
	Ok(Num::UInt(result).into_value())
}

/// `vec` on a magic-free scalar holding a byte string (or undef, when assigning).
fn vec_plain(interp: &mut Interp<'_>, sv: &Sv, offset: usize, bits: usize, assign: Option<Value>) -> PResult<Value> {
	let write = assign.is_some();
	let Some(address) = vec_address(offset, bits) else {
		return if write { Err(interp.die_msg("Out of memory!")) } else { Ok(Value::Int(0)) };
	};
	let len = sv.try_value().map_or(0, |v| if let Value::Str(s) = &*v { s.bytes.len() } else { 0 });
	vec_portable_warning(interp, bits, write || address.0 < len);
	let Some(v) = assign else {
		let word = sv.try_value().map_or(0, |v| if let Value::Str(s) = &*v { vec_get(&s.bytes, address, bits) } else { 0 });
		return Ok(Num::UInt(word).into_value());
	};
	let word = numify(interp, &v, None, "scalar assignment", false)?.to_u64() & vec_mask(bits);
	let stored = match sv.try_value_mut() {
		Ok(mut raw) => {
			if raw.is_undef() { *raw = Value::Str(PStr::default()); }
			match &mut *raw {
				// Converting the assigned value could not run code that re-encoded the
				// target, unless it did; then this falls back to an ordinary store below.
				Value::Str(s) if !s.utf8 => Some(vec_set(&mut s.bytes, address, bits, word)),
				_ => None,
			}
		}
		Err(_) => None,
	};
	match stored {
		Some(result) => {
			result.map_err(|()| interp.die_msg("Out of memory!"))?;
			sv.pos.set(None);
		}
		None => {
			let current = interp.read_sv(sv)?;
			let s = if current.is_undef() { PStr::default() } else { stringify(interp, current, None, "vec", false)? };
			let mut bytes = if !s.utf8 { s.bytes } else {
				s.downgraded().ok_or_else(|| interp.die_msg("Use of strings with code points over 0xFF as arguments to vec is forbidden"))?
			};
			vec_set(&mut bytes, address, bits, word).map_err(|()| interp.die_msg("Out of memory!"))?;
			interp.write_sv(sv, Value::Str(PStr::new(bytes, false)))?;
		}
	}
	Ok(Num::UInt(if bits > 64 { 0 } else { word }).into_value())
}

/// Byte index and bit shift of element `offset` of `bits`-wide fields.
fn vec_address(offset: usize, bits: usize) -> Option<(usize, usize)> {
	if bits < 8 { Some((offset / (8 / bits), (offset % (8 / bits)) * bits)) } else { offset.checked_mul(bits / 8).map(|byte| (byte, 0)) }
}

fn vec_mask(bits: usize) -> u64 { u64::MAX >> (64 - bits.min(64)) }

fn vec_portable_warning(interp: &mut Interp<'_>, bits: usize, touched: bool) {
	if bits == 64 && touched && interp.warn_on("portable") {
		interp.warn_category("portable", "Bit vector size > 32 non-portable");
	}
}

fn vec_get(bytes: &[u8], (at, shift): (usize, usize), bits: usize) -> u64 {
	if at >= bytes.len() || bits > 64 {
		0
	} else if bits < 8 {
		(u64::from(bytes[at]) >> shift) & vec_mask(bits)
	} else {
		let width = bits / 8;
		let mut word = [0_u8; 8];
		let available = (bytes.len() - at).min(width);
		word[8 - width..8 - width + available].copy_from_slice(&bytes[at..at + available]);
		u64::from_be_bytes(word)
	}
}

/// Store `word` into the field, growing the string with NULs; `Err` when the growth is unreasonable.
fn vec_set(bytes: &mut Vec<u8>, (at, shift): (usize, usize), bits: usize, word: u64) -> Result<(), ()> {
	let width = (bits / 8).max(1);
	let end = at.checked_add(width).ok_or(())?;
	if end > bytes.len() {
		check_len(end, "string").map_err(|_| ())?;
		bytes.try_reserve(end - bytes.len()).map_err(|_| ())?;
		bytes.resize(end, 0);
	}
	if bits < 8 {
		bytes[at] = (bytes[at] & !((vec_mask(bits) as u8) << shift)) | ((word as u8) << shift);
	} else if bits <= 64 {
		bytes[at..end].copy_from_slice(&word.to_be_bytes()[8 - width..]);
	}
	Ok(())
}

/// Create a deferred lvalue for reusable `substr` and `vec` aliases.
pub(in crate::perl) fn lvalue(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> Option<PResult<Sv>> {
	fn make(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Sv> {
		let exprs = scalar_args(interp, b, call, if b == Builtin::Substr { 2 } else { 3 }, 3)?;
		let source = lvalue_source(interp, &exprs[0])?;
		if b == Builtin::Substr {
			let (start, len) = substr_args(interp, exprs)?;
			let bytes = interp.hints().bytes;
			Ok(new_lvalue(Lvalue::Substr { source, start: Cell::new(start), len: Cell::new(len), bytes }))
		} else {
			let (offset, width) = vec_args(interp, exprs)?;
			if offset >= 0 && (width < 1 || !(width as u64).is_power_of_two()) {
				return Err(interp.die_msg("Illegal number of bits in vec"));
			}
			Ok(new_lvalue(Lvalue::Vec { source, offset, width }))
		}
	}
	match b {
		Builtin::Substr if args(call).len() == 4 => None,
		Builtin::Substr | Builtin::Vec => Some(make(interp, b, call)),
		_ => None,
	}
}

fn lvalue_source(interp: &mut Interp<'_>, expr: &Expr) -> PResult<Sv> {
	// Alias a scalar term if possible. An aggregate in this scalar argument
	// position contributes its scalar value, not its last list element.
	let e = group_inner(expr);
	if matches!(&e.kind, ExprKind::Variable(Sigil::LastIndex, _) | ExprKind::Deref(Sigil::LastIndex, _)) {
		return interp.eval_lvalue(expr);
	}
	let single = matches!(&e.kind,
		ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) | ExprKind::Version(_)
		| ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _)
		| ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _)
		| ExprKind::Call(_) | ExprKind::Conditional(..) | ExprKind::Binary(crate::perl::ast::Binary::Assign, ..))
		|| matches!(&e.kind, ExprKind::Declare(_, _, inner, _) if matches!(&group_inner(inner).kind, ExprKind::Variable(Sigil::Scalar, _)));
	if !single { return Ok(new_sv(interp.eval_scalar(expr)?)); }
	let mut cells = interp.eval_aliases(expr)?;
	Ok(cells.pop().unwrap_or_else(|| new_sv(Value::Undef)))
}

fn lvalue_guard<T>(interp: &mut Interp<'_>, f: impl FnOnce(&mut Interp<'_>) -> PResult<T>) -> PResult<T> {
	// A graph of aliases can be arbitrarily deep even when evaluating a tiny AST.
	if interp.data.lvalue_depth >= 1024 { return Err(interp.die_msg("Deep recursion in string lvalue")); }
	interp.data.lvalue_depth += 1;
	let result = crate::stack::guard(128 * 1024, || f(interp));
	interp.data.lvalue_depth -= 1;
	result
}

/// Read a string lvalue against its current backing value.
pub(in crate::perl) fn lvalue_get(interp: &mut Interp<'_>, lv: &Lvalue) -> PResult<Value> {
	lvalue_guard(interp, |interp| match lv {
		Lvalue::Substr { source, start, len, bytes } => {
			let v = interp.read_sv(source)?;
			read_substr(interp, v, None, start.get(), len.get(), *bytes)
		}
		Lvalue::Vec { source, offset, width } => vec_at(interp, ScalarInput::Cell(source.clone()), None, *offset, *width, None),
		_ => unreachable!("not a Data lvalue"),
	})
}

/// Assign through a string lvalue, updating the substring's anchors after a resize.
pub(in crate::perl) fn lvalue_set(interp: &mut Interp<'_>, lv: &Lvalue, value: Value) -> PResult<Value> {
	lvalue_guard(interp, |interp| match lv {
		Lvalue::Substr { source, start, len, bytes } => {
			let written = write_substr(interp, source, None, start.get(), len.get(), *bytes, value, None, SubstrResult::Assigned)?;
			if start.get() < 0 {
				start.set(start.get().saturating_sub(written.inserted - written.removed));
			}
			if len.get().is_some_and(|n| n >= 0) { len.set(Some(written.inserted)); }
			Ok(written.value)
		}
		Lvalue::Vec { source, offset, width } => vec_at(interp, ScalarInput::Cell(source.clone()), None, *offset, *width, Some(value)),
		_ => unreachable!("not a Data lvalue"),
	})
}
