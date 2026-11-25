//! Data, string, numeric, calendar and timing builtins from perlfunc.

mod calendar;
mod crypt;
mod list;
mod number;
mod offsets;
mod string;
mod unicode;
mod unicode_data;

use std::rc::{Rc, Weak};

use rustc_hash::FxHashMap;
use smallvec::SmallVec;

use crate::perl::{
	ast::{Builtin, Call, Expr, ExprKind, QuoteKind, QuotePart, Sigil},
	interp::{Cx, Flow, Interp, PResult, Ret},
	modules,
	pack::{self, UnpackCx},
	sprintf,
	value::{ArrayBody, HashBody, Num, PStr, Stringify, Sv, Value},
};

pub(in crate::perl) use list::{reverse_in_place, value_aliases};
pub(in crate::perl) use string::{lvalue, lvalue_get, lvalue_set};
pub(in crate::perl) use unicode::{map_case, quote_meta};

/// Per-interpreter PRNG and active array iterators.
#[derive(Default)]
pub(in crate::perl) struct State {
	random: Option<u64>,
	array_iterators: FxHashMap<usize, (Weak<ArrayBody>, usize)>,
	hash_iterators: FxHashMap<usize, (Weak<HashBody>, HashCursor)>,
	array_sweep_at: usize,
	hash_sweep_at: usize,
	lvalue_depth: usize,
	/// Strings behind pack `p`/`P` addresses.
	pointers: pack::Pointers,
	/// Cached character offsets of the UTF-8 scalars most recently measured or sliced.
	utf8_marks: Vec<offsets::Utf8Mark>,
}

enum HashCursor {
	Plain { end: usize, observed: usize },
	Tied(Value),
}

/// Evaluate a perlfunc data builtin, or fall through if this module does not own it.
pub(in crate::perl) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> Option<PResult<Ret>> {
	use Builtin as B;
	Some(match b {
		B::Abs | B::Atan2 | B::Cos | B::Exp | B::Hex | B::Int | B::Log | B::Oct | B::Rand | B::Sin | B::Sqrt | B::Srand => {
			number::call(interp, b, call, cx)
		}
		B::Chomp | B::Chop => string::trim(interp, call, b == B::Chomp).map(Ret::One),
		B::Chr | B::Fc | B::Lc | B::Lcfirst | B::Length | B::Ord | B::Quotemeta | B::Uc | B::Ucfirst => {
			string::unary(interp, b, call).map(Ret::One)
		}
		B::Index | B::Rindex => string::index(interp, b, call).map(Ret::One),
		B::Substr => string::substr(interp, call, None, cx).map(Ret::One),
		B::Vec => string::vec(interp, call, None).map(Ret::One),
		B::Join | B::Reverse => string::concat(interp, b, call, cx),
		B::Each | B::Keys | B::Values => list::traverse(interp, b, call, cx),
		B::Pop | B::Push | B::Shift | B::Unshift | B::Splice => list::mutate(interp, b, call, cx),
		B::Crypt => crypt::call(interp, call).map(Ret::One),
		B::Ref => reference(interp, call).map(Ret::One),
		B::Time | B::Times | B::Gmtime | B::Localtime | B::Sleep => calendar::call(interp, b, call, cx),
		B::Sprintf | B::Pack | B::Unpack => formats(interp, b, call, cx),
		_ => return None,
	})
}

/// Store through one of the assignable data builtins.
pub(in crate::perl) fn assign(interp: &mut Interp<'_>, b: Builtin, call: &Call, value: Value) -> Option<PResult<Value>> {
	Some(match b {
		Builtin::Substr => string::substr(interp, call, Some(value), Cx::Void),
		Builtin::Vec => string::vec(interp, call, Some(value)),
		Builtin::Keys => list::reserve(interp, call, value),
		_ => return None,
	})
}

fn args(call: &Call) -> &[Expr] {
	match call.args.as_deref() {
		Some(Expr { kind: ExprKind::List(items), .. }) => items,
		Some(e) => std::slice::from_ref(e),
		None => &[],
	}
}

fn group_inner(mut expr: &Expr) -> &Expr {
	while let ExprKind::Group(inner) = &expr.kind {
		expr = inner;
	}
	expr
}

fn scalar_args<'a>(interp: &mut Interp<'_>, b: Builtin, call: &'a Call, min: usize, max: usize) -> PResult<&'a [Expr]> {
	let args = args(call);
	if args.len() < min {
		return Err(interp.die_msg(format!("Not enough arguments for {}", b.name())));
	}
	if args.len() > max {
		return Err(interp.die_msg(format!("Too many arguments for {}", b.name())));
	}
	Ok(args)
}

fn operand(interp: &mut Interp<'_>, expr: Option<&Expr>) -> PResult<Value> {
	if let Some(e) = expr {
		interp.eval_scalar(e)
	} else {
		let topic = interp.topic();
		interp.read_sv(&topic)
	}
}

enum ScalarInput { Cell(Sv), Owned(Value) }

impl ScalarInput {
	fn into_value(self, interp: &mut Interp<'_>) -> PResult<Value> {
		match self { Self::Cell(sv) => interp.read_sv(&sv), Self::Owned(v) => Ok(v) }
	}
}

// When several operands share a cell, later operand evaluation can change
// what an earlier operand sees. Restrict this to scalar cells, without
// flattening arrays or comma expressions in a scalar argument slot.
fn scalar_input(interp: &mut Interp<'_>, expr: &Expr) -> PResult<ScalarInput> {
	match &group_inner(expr).kind {
		ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) => {
			let mut cells = interp.eval_aliases(expr)?;
			Ok(cells.pop().map_or(ScalarInput::Owned(Value::Undef), ScalarInput::Cell))
		}
		_ => interp.eval_scalar(expr).map(ScalarInput::Owned),
	}
}

fn warn_undef(interp: &mut Interp<'_>, expr: Option<&Expr>, op: &str, default_topic: bool) {
	if !interp.warn_on("uninitialized") {
		return;
	}
	let var = match expr.map(|e| &group_inner(e).kind) {
		Some(ExprKind::Variable(Sigil::Scalar, name)) => format!(" ${name}"),
		None if default_topic => " $_".to_owned(),
		_ => String::new(),
	};
	interp.warn_category("uninitialized", format!("Use of uninitialized value{var} in {op}"));
}

fn stringify(interp: &mut Interp<'_>, value: Value, expr: Option<&Expr>, op: &str, topic: bool) -> PResult<PStr> {
	match value {
		Value::Str(s) => Ok(s),
		Value::Undef => {
			warn_undef(interp, expr, op, topic);
			Ok(PStr::default())
		}
		Value::Ref(_) => match interp.convert_overload(&value, &["\"\"", "0+", "bool"])? {
			// A `""` overload that yields undef is an uninitialized string.
			Some(Value::Undef) => {
				warn_undef(interp, expr, op, topic);
				Ok(PStr::default())
			}
			Some(converted) => Ok(converted.to_pstr()),
			None => Ok(value.to_pstr()),
		},
		_ => interp.stringify(&value),
	}
}

fn numify(interp: &mut Interp<'_>, value: &Value, expr: Option<&Expr>, op: &str, topic: bool) -> PResult<Num> {
	match value {
		Value::Undef => {
			warn_undef(interp, expr, op, topic);
			Ok(Num::Int(0))
		}
		Value::Str(s) if !value.is_numeric_string() => {
			if interp.warn_on("numeric") {
				let text = sprintf::escaped(s);
				interp.warn_category("numeric", format!("Argument \"{text}\" isn't numeric in {op}"));
			}
			Ok(value.to_num())
		}
		_ => interp.numify(value),
	}
}

fn iv(n: Num) -> i64 { n.into_value().to_i64() }

fn int_arg(interp: &mut Interp<'_>, e: &Expr, op: &str) -> PResult<i64> {
	let v = interp.eval_scalar(e)?;
	Ok(numify(interp, &v, Some(e), op, false)?.wrapping_iv())
}

/// A pack/unpack error: host cancellation unwinds as such, anything else dies with location.
fn format_error(interp: &mut Interp<'_>, message: String) -> Flow {
	if message == pack::CANCELLED { Flow::Cancelled } else { interp.die_msg(message) }
}

fn reference(interp: &mut Interp<'_>, call: &Call) -> PResult<Value> {
	let arg = scalar_args(interp, Builtin::Ref, call, 0, 1)?.first();
	Ok(match operand(interp, arg)? {
		Value::Ref(r) => Value::str(r.blessed().as_deref().unwrap_or_else(|| r.kind_name())),
		_ => Value::str(""),
	})
}

fn formats(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	if b == Builtin::Unpack {
		let exprs = scalar_args(interp, b, call, 1, 2)?;
		let template = interp.eval_scalar(&exprs[0])?;
		let data = operand(interp, exprs.get(1))?;
		let template = stringify(interp, template, exprs.first(), "unpack", false)?;
		let mut data = stringify(interp, data, exprs.get(1), "unpack", true)?;
		if interp.hints().bytes { data.utf8 = false; }
		// Only scalar context stops at the first value; void context still unpacks (and warns about) everything.
		let context = if cx == Cx::Scalar { UnpackCx::Scalar } else { UnpackCx::List };
		let pointers = std::mem::take(&mut interp.data.pointers);
		let cancel = interp.host().cancel_flag();
		let mut conv = FormatContext { interp, op: b, aliases: &[], flow: None };
		let items = pack::unpack(&template, &data, context, &mut conv, &pointers, &cancel);
		conv.interp.data.pointers = pointers;
		let items = items.map_err(|e| format_error(conv.interp, e))?;
		return Ok(if cx == Cx::List { Ret::Many(items) } else { Ret::One(items.into_iter().next().unwrap_or(Value::Undef)) });
	}
	let Some((first, rest)) = args(call).split_first() else {
		return Err(interp.die_msg(format!("Not enough arguments for {}", b.name())));
	};
	let v = scalar_input(interp, first)?;
	let result = if b == Builtin::Pack {
		let mut items = Vec::new();
		let mut temporaries = Vec::new();
		for item in rest {
			let values = interp.eval_list(item)?;
			temporaries.resize(temporaries.len() + values.len(), is_temporary(item));
			items.extend(values);
		}
		let template = v.into_value(interp)?;
		let template = stringify(interp, template, Some(first), b.name(), false)?;
		let mut pointers = std::mem::take(&mut interp.data.pointers);
		let cancel = interp.host().cancel_flag();
		let mut ctx = FormatContext { interp, op: b, aliases: &[], flow: None };
		let packed = pack::pack(&template, &items, &temporaries, &mut ctx, &mut pointers, &cancel);
		ctx.interp.data.pointers = pointers;
		packed.map_err(|e| format_error(ctx.interp, e))?
	} else {
		let mut aliases = Vec::new();
		for item in rest { aliases.extend(interp.eval_aliases(item)?); }
		let template = v.into_value(interp)?;
		let template = stringify(interp, template, Some(first), b.name(), false)?;
		format(interp, b, &template, &aliases)?
	};
	Ok(Ret::One(Value::Str(result)))
}

/// Whether an argument's values are fresh expression results (perl's TEMP/PADTMP
/// scalars) rather than variables, elements or literal constants.
fn is_temporary(e: &Expr) -> bool {
	match &group_inner(e).kind {
		ExprKind::Variable(..) | ExprKind::Deref(..) | ExprKind::Select(..)
		| ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) | ExprKind::Version(_)
		| ExprKind::Bareword(_) => false,
		ExprKind::Quote(QuoteKind::String, parts) => !parts.iter().all(|p| matches!(p, QuotePart::Literal(_))),
		_ => true,
	}
}

/// Format the arguments as live scalar cells so `%n` can store the count.
pub(in crate::perl) fn format(interp: &mut Interp<'_>, op: Builtin, fmt: &PStr, args: &[Sv]) -> PResult<PStr> {
	let mut ctx = FormatContext { interp, op, aliases: args, flow: None };
	// `arg` supplies live values on demand; this slice supplies the arity.
	let mut arity = SmallVec::<[Value; 8]>::new();
	arity.resize(args.len(), Value::Undef);
	let result = sprintf::sprintf(fmt, &arity, &mut ctx);
	if let Some(flow) = ctx.flow { return Err(flow); }
	result.map_err(|e| ctx.interp.die_msg(format_diagnostic(op, e)))
}

fn format_diagnostic(op: Builtin, mut msg: String) -> String {
	if op == Builtin::Printf {
		const CONVERSION: &str = "Invalid conversion in sprintf:";
		if msg.starts_with(CONVERSION) {
			msg.remove(CONVERSION.len() - "sprintf:".len());
		} else if msg.ends_with(" sprintf") {
			msg.remove(msg.len() - "sprintf".len());
		}
	}
	msg
}

struct FormatContext<'i, 'h, 'a> {
	interp: &'i mut Interp<'h>,
	op: Builtin,
	aliases: &'a [Sv],
	flow: Option<Flow>,
}

impl Stringify for FormatContext<'_, '_, '_> {
	fn bytes(&self) -> bool { self.interp.hints().bytes }

	fn stringify(&mut self, v: &Value) -> PStr {
		if self.flow.is_some() { return PStr::default(); }
		let mut s = self.interp.conv().stringify(v);
		if self.bytes() { s.utf8 = false; }
		s
	}

	fn numify(&mut self, v: &Value) -> Num {
		if self.flow.is_some() { Num::Int(0) } else { self.interp.conv().numify(v) }
	}

	fn warn(&mut self, msg: String) {
		if self.flow.is_some() { return; }
		if msg.starts_with("Malformed UTF-8 character:") {
			self.interp.warn_category_default("utf8", msg);
			return;
		}
		let category = if msg.starts_with("Use of uninitialized") { "uninitialized" }
		else if msg.starts_with("Argument ") { "numeric" }
		else if msg.starts_with("Missing argument") { "missing" }
		else if msg.starts_with("Redundant argument") { "redundant" }
		else if msg.contains("sprintf") { "printf" }
		else if msg.ends_with(" in unpack") { "unpack" }
		else { "pack" };
		self.interp.warn_category(category, format_diagnostic(self.op, msg));
	}

	fn vector(&mut self, v: &Value) -> Option<PStr> {
		if self.flow.is_some() { return Some(PStr::default()); }
		match modules::version_vector(self.interp, v) {
			Ok(vector) => vector,
			Err(flow) => { self.flow = Some(flow); Some(PStr::default()) }
		}
	}

	fn arg(&mut self, index: usize) -> Option<Value> {
		if self.flow.is_some() { return Some(Value::Undef); }
		let sv = self.aliases.get(index)?;
		Some(match self.interp.read_sv(sv) {
			Ok(value) => value,
			Err(flow) => { self.flow = Some(flow); Value::Undef }
		})
	}

	fn store_count(&mut self, index: usize, count: usize) {
		if self.flow.is_some() { return; }
		let Some(sv) = self.aliases.get(index).filter(|sv| Rc::strong_count(sv) > 1 || self.interp.is_lvalue(sv)) else {
			self.flow = Some(self.interp.die_msg("Modification of a read-only value attempted"));
			return;
		};
		self.flow = self.interp.write_sv(sv, Num::UInt(count as u64).into_value()).err();
	}
}
