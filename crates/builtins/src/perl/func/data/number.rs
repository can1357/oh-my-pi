//! Perl numeric conversions, math intrinsics and the interpreter-local drand48 sequence.

use crate::perl::{
	ast::{Builtin, Call},
	interp::{Cx, Interp, PResult, Ret},
	sprintf,
	value::{Num, PStr, Plain, U64_LIMIT, Value},
};

use super::{numify, operand, scalar_args, stringify, warn_undef};

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let count = if b == B::Atan2 { 2 } else { 1 };
	let min = if b == B::Atan2 { 2 } else { 0 };
	let args = scalar_args(interp, b, call, min, count)?;
	let first = args.first();
	let op = b.name();
	let value = if let Some(e) = first { interp.eval_scalar(e)? } else if b.defaults_to_topic() {
		operand(interp, None)?
	} else {
		Value::Int(1)
	};
	if b == B::Srand {
		let seed = if let Some(e) = first {
			if value.is_undef() { warn_undef(interp, Some(e), op, false); }
			let value = if matches!(value, Value::Ref(_)) {
				interp.stringify(&value)?
			} else {
				value.to_pstr()
			};
			seed_value(&value.bytes).unwrap_or_else(|| {
				interp.warn_category("overflow", "Integer overflow in srand");
				u64::MAX
			})
		} else {
			rand::random()
		};
		interp.data.random = Some(initial_state(seed));
		return Ok(Ret::One(if seed == 0 { Value::bytes(b"0 but true") } else { Num::UInt(seed).into_value() }));
	}
	if matches!(b, B::Hex | B::Oct) {
		let text = stringify(interp, value, first, op, true)?;
		return radix(interp, text, b).map(Ret::One);
	}
	let second = args.get(1).map(|e| interp.eval_scalar(e)).transpose()?;
	if matches!(b, B::Abs | B::Int | B::Cos | B::Sin | B::Exp | B::Log | B::Sqrt | B::Atan2)
		&& let Some(ret) = interp.overload_builtin(op, &value, second.as_ref(), cx)?
	{
		return Ok(ret);
	}
	let a = numify(interp, &value, first, op, b.defaults_to_topic())?;
	let f = a.to_f64();
	Ok(Ret::One(match b {
		B::Abs => match a {
			Num::Int(i) => Num::UInt(i.unsigned_abs()).into_value(),
			Num::UInt(_) => a.into_value(),
			Num::Float(f) => Value::Num(f.abs()),
		},
		B::Int => match a {
			Num::Float(f) if f >= i64::MIN as f64 && f < U64_LIMIT => {
				// Truncating a decimal string need not lose precision in an intermediate NV.
				if matches!(value, Value::Str(_)) && let n @ (Num::Int(_) | Num::UInt(_)) = value.integer_coercion() {
					n.into_value()
				} else if f < 0.0 { Value::Int(f as i64) }
				else { Num::UInt(f as u64).into_value() }
			}
			Num::Float(f) => Value::Num(f.trunc()),
			_ => a.into_value(),
		},
		B::Atan2 => {
			let second = second.unwrap_or(Value::Undef);
			Value::Num(f.atan2(numify(interp, &second, args.get(1), op, false)?.to_f64()))
		}
		B::Cos => Value::Num(f.cos()),
		B::Exp => Value::Num(f.exp()),
		B::Sin => Value::Num(f.sin()),
		B::Log if f > 0.0 || f.is_nan() => Value::Num(f.ln()),
		B::Sqrt if f >= 0.0 || f.is_nan() => Value::Num(f.sqrt()),
		B::Log | B::Sqrt => {
			let shown = if f == 0.0 && f.is_sign_negative() { "-0".to_owned() } else {
				sprintf::sprintf(&PStr::from_bytes(b"%g"), &[Value::Num(f)], &mut Plain)
					.map_or_else(|_| f.to_string(), |s| s.to_string_lossy().into_owned())
			};
			return Err(interp.die_msg(format!("Can't take {op} of {shown}")));
		}
		B::Rand => {
			let rand = interp.data.random.get_or_insert_with(|| initial_state(rand::random()));
			*rand = rand.wrapping_mul(0x5deece66d).wrapping_add(0xb) & ((1 << 48) - 1);
			Value::Num((*rand as f64 / (1_u64 << 48) as f64) * if f == 0.0 { 1.0 } else { f })
		}
		_ => unreachable!("not a numeric intrinsic"),
	}))
}

fn initial_state(seed: u64) -> u64 { ((seed & 0xffff_ffff) << 16) | 0x330e }

// Perl's unsigned decimal conversion for srand permits a sign and discards the fractional part.
fn seed_value(bytes: &[u8]) -> Option<u64> {
	let bytes = bytes.trim_ascii();
	if bytes == b"0 but true" { return Some(0); }
	let bytes = match bytes.first() { Some(b'-' | b'+') => &bytes[1..], _ => bytes };
	let mut parts = bytes.splitn(2, |&b| b == b'.');
	let whole = parts.next()?;
	let fraction = parts.next().unwrap_or_default();
	if (whole.is_empty() && fraction.is_empty()) || !fraction.iter().all(u8::is_ascii_digit) { return None; }
	whole.iter().try_fold(0_u64, |n, &b| {
		if !b.is_ascii_digit() { return None; }
		n.checked_mul(10)?.checked_add(u64::from(b - b'0'))
	})
}

fn digit(b: u8, base: u32) -> Option<u32> { (b as char).to_digit(base) }

fn radix(interp: &mut Interp<'_>, s: PStr, b: Builtin) -> PResult<Value> {
	let bytes = if s.utf8 && !interp.hints().bytes {
		s.downgraded().ok_or_else(|| interp.die_msg(format!("Wide character in {}", b.name())))?
	} else {
		s.bytes
	};
	let mut rest = if b == Builtin::Oct { bytes.trim_ascii_start() } else { &bytes };
	let mut base = if b == Builtin::Oct { 8 } else { 16 };
	let prefix = rest.strip_prefix(b"0").unwrap_or(rest);
	match prefix.first() {
		Some(b'x' | b'X') => { base = 16; rest = &prefix[1..]; }
		Some(b'b' | b'B') if base == 8 => { base = 2; rest = &prefix[1..]; }
		Some(b'o' | b'O') if base == 8 => { rest = &prefix[1..]; }
		_ => (),
	}
	let (name, title) = match base {
		2 => ("binary", "Binary"),
		8 => ("octal", "Octal"),
		_ => ("hexadecimal", "Hexadecimal"),
	};
	let mut int = 0_u64;
	let mut float = None;
	while let Some((&head, tail)) = rest.split_first() {
		let mut c = head;
		rest = tail;
		if c == b'_' && rest.first().is_some_and(|&b| digit(b, base).is_some()) {
			c = rest[0];
			rest = &rest[1..];
		}
		let Some(d) = digit(c, base) else {
			if (base != 8 || matches!(c, b'8' | b'9')) && interp.warn_on("digit") {
				interp.warn_category("digit", format!("Illegal {name} digit '{}' ignored", char::from(c)));
			}
			break;
		};
		if let Some(f) = &mut float {
			*f = *f * f64::from(base) + f64::from(d);
		} else if let Some(n) = int.checked_mul(u64::from(base)).and_then(|n| n.checked_add(u64::from(d))) {
			int = n;
		} else {
			if interp.warn_on("overflow") { interp.warn_category("overflow", format!("Integer overflow in {name} number")); }
			float = Some(int as f64 * f64::from(base) + f64::from(d));
		}
	}
	if (int > u32::MAX as u64 || float.is_some()) && interp.warn_on("portable") {
		interp.warn_category("portable", format!("{title} number > 0xffffffff non-portable"));
	}
	Ok(float.map_or_else(|| Num::UInt(int).into_value(), Value::Num))
}
