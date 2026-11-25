//! User-defined character properties (`perlunicode` "User-Defined Character
//! Properties"): `\p{IsFoo}` / `\p{InFoo}` backed by a Perl sub that returns
//! code point ranges and set operations on other properties.

use super::{Interp, PResult, PStr, Value};
use crate::perl::{
	code::CodeImpl,
	interp::{Cx, Flow},
	regex::{PropSet, UserProperty, UserSet},
	value::new_sv,
};

/// Highest code point perl accepts in a property definition (IV_MAX).
const MAX_CODE_POINT: u64 = i64::MAX as u64;

/// Resolve the user-defined properties a pattern mentions. Names that look
/// like user properties but have neither a sub nor a built-in meaning are
/// deferred until the pattern is matched.
pub(super) fn resolve(interp: &mut Interp<'_>, source: &PStr, caseless: bool) -> PResult<Vec<UserProperty>> {
	let mut out: Vec<UserProperty> = Vec::new();
	let bytes = &source.bytes;
	let mut i = 0;
	while i + 1 < bytes.len() {
		if bytes[i] != b'\\' { i += 1; continue; }
		let c = bytes[i + 1];
		i += 2;
		if !matches!(c, b'p' | b'P') || bytes.get(i) != Some(&b'{') { continue; }
		let Some(close) = bytes[i..].iter().position(|&b| b == b'}').map(|n| i + n) else { break };
		let name = key(&bytes[i + 1..close]);
		i = close + 1;
		if out.iter().any(|p| p.name == name) || !user_shaped(name) { continue; }
		let Ok(text) = std::str::from_utf8(name) else { continue };
		let set = match find(interp, text) {
			Some(qualified) => match expand(interp, &qualified, caseless, &mut Vec::new())? {
				Ok(set) => UserSet::Defined(set),
				Err(msg) => UserSet::Invalid(msg),
			},
			None if super::ucd::known(name) => continue,
			None => UserSet::Deferred(if text.contains("::") {
				text.trim_start_matches("::").to_owned()
			} else { format!("{}::{text}", interp.package()) }),
		};
		out.push(UserProperty { name: name.to_vec(), set });
	}
	Ok(out)
}

/// The braces' content as properties are keyed: trimmed, without `^`.
fn key(raw: &[u8]) -> &[u8] {
	let raw = raw.trim_ascii();
	raw.strip_prefix(b"^").map_or(raw, <[u8]>::trim_ascii)
}

/// `In...` or `Is...`, optionally package-qualified, as perl requires of user properties.
fn user_shaped(name: &[u8]) -> bool {
	if !name.iter().all(|&b| b.is_ascii_alphanumeric() || b == b'_' || b == b':') { return false; }
	let base = name.rsplit(|&b| b == b':').next().unwrap_or_default();
	base.len() > 2 && (base.starts_with(b"In") || base.starts_with(b"Is"))
}


/// The defining sub's qualified name: the current package, then `main`.
fn find(interp: &mut Interp<'_>, name: &str) -> Option<String> {
	let candidates = if name.contains("::") {
		vec![name.trim_start_matches("::").to_owned()]
	} else {
		vec![format!("{}::{name}", interp.package()), format!("main::{name}")]
	};
	candidates.into_iter().find(|qualified| defined_sub(interp, qualified).is_some())
}

fn defined_sub(interp: &mut Interp<'_>, qualified: &str) -> Option<crate::perl::code::Cv> {
	let cv = interp.glob(qualified).code.borrow().clone()?;
	let defined = !matches!(*cv.body.borrow(), CodeImpl::Undefined);
	defined.then_some(cv)
}

/// Run a property sub (once per name and case sensitivity, as perl caches it)
/// and parse its definition. `Ok(Err(..))` is a definition error message.
fn expand(interp: &mut Interp<'_>, qualified: &str, caseless: bool, stack: &mut Vec<String>) -> PResult<Result<PropSet, String>> {
	let cache_key = (qualified.to_owned(), caseless);
	if let Some(found) = interp.rx.user_properties.get(&cache_key) { return Ok(found.clone()); }
	if stack.iter().any(|seen| seen == qualified) {
		return Ok(Err(format!("Infinite recursion in user-defined property \"{qualified}\"")));
	}
	let Some(cv) = defined_sub(interp, qualified) else {
		return Ok(Err(format!("Can't find Unicode property definition \"{qualified}\"")));
	};
	stack.push(qualified.to_owned());
	let called = interp.call_sub(&cv, vec![new_sv(Value::Int(i64::from(caseless)))], Cx::Scalar);
	let parsed = match called {
		Ok(ret) => {
			let value = ret.scalar();
			match interp.stringify(&value) {
				Ok(text) => parse(interp, &text, caseless, stack),
				Err(flow) => Err(flow),
			}
		}
		Err(Flow::Die(value)) => interp.stringify(&value).map(|msg| Err(msg.to_string_lossy().into_owned())),
		Err(flow) => Err(flow),
	};
	stack.pop();
	let parsed = parsed?.map_err(|msg| format!("{msg} in expansion of {qualified}"));
	interp.rx.user_properties.insert(cache_key, parsed.clone());
	Ok(parsed)
}

/// Parse a property definition: lines of `HEX` or `HEX HEX` ranges, or
/// `+`/`!`/`-`/`&` followed by a range or a property (`utf8::Name` built-in,
/// `Pkg::Name` user-defined); `#` starts a comment.
fn parse(interp: &mut Interp<'_>, text: &PStr, caseless: bool, stack: &mut Vec<String>) -> PResult<Result<PropSet, String>> {
	let text = text.to_string_lossy().into_owned();
	let mut include = Vec::new();
	let mut exclude = Vec::new();
	let mut intersect = Vec::new();
	for raw in text.split('\n') {
		let line = raw.split('#').next().unwrap_or_default().trim();
		if line.is_empty() { continue; }
		let (op, rest) = match line.as_bytes()[0] {
			op @ (b'+' | b'-' | b'!' | b'&') => (Some(op), line[1..].trim()),
			_ => (None, line),
		};
		let set = match ranges(rest, raw) {
			Some(Ok(set)) => set,
			Some(Err(msg)) => return Ok(Err(msg)),
			None if op.is_none() => return Ok(Err(format!("Can't find Unicode property definition \"{line}\""))),
			None => {
				if let Some(name) = rest.strip_prefix("utf8::") {
					if !super::ucd::known(name.as_bytes()) {
						return Ok(Err(format!("Can't find Unicode property definition \"{rest}\"")));
					}
					PropSet::Builtin(name.as_bytes().to_vec())
				} else if rest.contains("::") {
					match expand(interp, rest.trim_start_matches("::"), caseless, stack)? {
						Ok(set) => set,
						Err(msg) => return Ok(Err(msg)),
					}
				} else if super::ucd::known(rest.as_bytes()) {
					PropSet::Builtin(rest.as_bytes().to_vec())
				} else {
					return Ok(Err(format!("Can't find Unicode property definition \"{rest}\"")));
				}
			}
		};
		match op {
			Some(b'!') => include.push(PropSet::Not(Box::new(set))),
			Some(b'-') => exclude.push(set),
			Some(b'&') => intersect.push(set),
			_ => include.push(set),
		}
	}
	let mut result = PropSet::Union(include);
	if !exclude.is_empty() { result = PropSet::Minus(Box::new(result), Box::new(PropSet::Union(exclude))); }
	for set in intersect { result = PropSet::And(Box::new(result), Box::new(set)); }
	Ok(Ok(result))
}

/// One `HEX` or `HEX HEX` line; `None` when the text is not hexadecimal.
fn ranges(text: &str, raw: &str) -> Option<Result<PropSet, String>> {
	let mut fields = text.split([' ', '\t']).filter(|f| !f.is_empty());
	let first = fields.next()?;
	let second = fields.next();
	if fields.next().is_some() || !first.bytes().chain(second.unwrap_or_default().bytes()).all(|b| b.is_ascii_hexdigit()) {
		return None;
	}
	let number = |digits: &str| u64::from_str_radix(digits, 16).ok().filter(|&n| n <= MAX_CODE_POINT);
	let (Some(low), Some(high)) = (number(first), second.map_or_else(|| number(first), number)) else {
		return Some(Err(format!("Code point too large in \"{raw}\"")));
	};
	if low > high { return Some(Err(format!("Illegal range in \"{raw}\""))); }
	// Code points beyond Unicode cannot occur in a subject the engine accepts.
	const TOP: u64 = 0x10FFFF;
	let ranges = if low > TOP { Vec::new() } else { vec![(low as u32, high.min(TOP) as u32)] };
	Some(Ok(PropSet::Ranges(ranges)))
}
