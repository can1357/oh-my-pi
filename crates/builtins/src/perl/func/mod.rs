//! Typed dispatch for the Perl builtin families documented in perlfunc.

pub(in crate::perl) mod data;
pub(in crate::perl) mod sys;

use super::{ast::{Builtin, Call}, interp::{Cx, Interp, PResult, Ret}, modules, rx, value::{Sv, Value}};

/// Dispatch a builtin whose implementation lives outside the evaluator.
pub fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	let result = if let Some(result) = rx::call(interp, b, call, cx) { result }
	else if let Some(result) = data::call(interp, b, call, cx) { result }
	else if let Some(result) = sys::call(interp, b, call, cx) { result }
	else { Err(interp.die_msg(format!("Unsupported function {}", b.name()))) };
	modules::autodie_result(interp, b.name(), result)
}

/// Construct a live scalar proxy for an intrinsic lvalue.
pub fn lvalue(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> Option<PResult<Sv>> {
	match b {
		Builtin::Substr | Builtin::Vec => data::lvalue(interp, b, call),
		Builtin::Pos => rx::lvalue(interp, b, call),
		_ => None,
	}
}

/// Assign through an intrinsic lvalue, returning the value of the assignment expression.
pub fn assign(interp: &mut Interp<'_>, b: Builtin, call: &Call, value: Value) -> PResult<Value> {
	match b {
		Builtin::Pos => rx::assign(interp, b, call, value),
		Builtin::Substr | Builtin::Vec | Builtin::Keys => data::assign(interp, b, call, value),
		_ => None,
	}.unwrap_or_else(|| Err(interp.die_msg(format!("Can't modify {} in scalar assignment", b.name()))))
}
