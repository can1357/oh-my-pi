//! The dynamically scoped capture registers and views described in `perlvar`.

use std::{cell::OnceCell, rc::{Rc, Weak}};

use super::{Interp, PStr, Regex, Value, next_boundary};
use crate::perl::{regex::Captures, value::{HKey, Hv, Ref, new_av, new_hv, new_sv}};

type Span = Option<(usize, usize)>;

/// The last successful match in a Perl dynamic scope.
#[derive(Debug)]
pub(in crate::perl) struct MatchState {
	subject: Rc<PStr>,
	captures: Captures,
	pub(super) regex: Rc<Regex>,
	// A plain scalar snapshot can serve repeated matches until the scalar changes.
	plain_source: Option<(Weak<super::ScalarBody>, u64)>,
	// Most matches never access @+ or @-. Convert UTF-8 offsets only on demand.
	offsets: OnceCell<Vec<Span>>,
}

impl MatchState {
	pub(super) fn new(subject: Rc<PStr>, captures: Captures, regex: Rc<Regex>) -> Self {
		Self { subject, captures, regex, plain_source: None, offsets: OnceCell::new() }
	}

	pub(super) fn install_plain(interp: &mut Interp<'_>, cell: &super::Sv, source: std::borrow::Cow<'_, PStr>, captures: Captures, regex: Rc<Regex>) {
		// A saved dynamic scope (or an observed %+ hash) must retain the
		// old state's identity. Recycle only after dropping the active slot.
		interp.set_last_match(None);
		let spare = &mut interp.rx.spare_match;
		let stamp = cell.revision();
		let borrowed = matches!(&source, std::borrow::Cow::Borrowed(_));
		if let Some(state) = spare.as_mut().and_then(Rc::get_mut) {
			let unchanged = borrowed &&
				state.plain_source.as_ref().is_some_and(|(sv, rev)| *rev == stamp && sv.as_ptr() == Rc::as_ptr(cell));
			if !unchanged {
				if let Some(dst) = Rc::get_mut(&mut state.subject) {
					match source {
						std::borrow::Cow::Owned(s) => *dst = s,
						std::borrow::Cow::Borrowed(s) => { dst.bytes.clone_from(&s.bytes); dst.utf8 = s.utf8; }
					}
				} else { state.subject = Rc::new(source.into_owned()); }
			}
			state.captures = captures;
			state.regex = regex;
			state.offsets.take();
			if !unchanged { state.plain_source = borrowed.then(|| (Rc::downgrade(cell), stamp)); }
		} else {
			let mut state = Self::new(Rc::new(source.into_owned()), captures, regex);
			state.plain_source = borrowed.then(|| (Rc::downgrade(cell), stamp));
			*spare = Some(Rc::new(state));
		}
		let state = spare.clone();
		interp.set_last_match(state);
	}

	pub(super) fn install_shared(interp: &mut Interp<'_>, source: Rc<PStr>, captures: Captures, regex: Rc<Regex>) -> Rc<Self> {
		let next = Self::new(source, captures, regex);
		interp.set_last_match(None);
		// Never extend the lifetime of a regex's user code (captured lexicals).
		let state = if next.regex.actions().is_empty() {
			let spare = &mut interp.rx.spare_match;
			if let Some(slot) = spare && let Some(state) = Rc::get_mut(slot) {
				*state = next;
				slot.clone()
			} else {
				let state = Rc::new(next);
				*spare = Some(state.clone());
				state
			}
		} else { Rc::new(next) };
		interp.set_last_match(Some(state.clone()));
		state
	}

	fn group(&self, n: usize) -> Value {
		capture_value(&self.subject, self.captures.spans.get(n).copied().flatten())
	}

	fn preceding(&self) -> Value {
		capture_value(&self.subject, self.captures.spans.first().copied().flatten().map(|(start, _)| (0, start)))
	}

	fn following(&self) -> Value {
		capture_value(&self.subject, self.captures.spans.first().copied().flatten().map(|(_, end)| (end, self.subject.bytes.len())))
	}

	fn highest(&self) -> usize {
		self.captures.spans.iter().rposition(Option::is_some).unwrap_or(0)
	}

	fn last_closed(&self) -> Value {
		if let Some(group) = self.captures.last_closed { return self.group(group); }
		let group = self.highest();
		if group == 0 { Value::Undef } else { self.group(group) }
	}

	fn offsets(&self) -> &[Span] {
		if !self.subject.utf8 { return &self.captures.spans; }
		self.offsets.get_or_init(|| {
			let mut positions = Vec::with_capacity(self.captures.spans.len() * 2);
			for (group, span) in self.captures.spans.iter().enumerate() {
				if let Some((start, end)) = span {
					positions.push((*start, group, false));
					positions.push((*end, group, true));
				}
			}
			positions.sort_unstable();
			let mut out = vec![None; self.captures.spans.len()];
			let (mut byte, mut character) = (0, 0);
			for (pos, group, end) in positions {
				while byte < pos {
					byte = next_boundary(&self.subject, byte);
					character += 1;
				}
				if let Some(slot) = out.get_mut(group) {
					let pair = slot.get_or_insert((character, character));
					if end { pair.1 = character; } else { pair.0 = character; }
				}
			}
			out
		})
	}
}

pub(super) fn capture_value(subject: &PStr, span: Span) -> Value {
	let Some((start, end)) = span else { return Value::Undef; };
	let bytes = subject.bytes.get(start..end).unwrap_or_default();
	Value::Str(PStr::new(bytes.to_vec(), subject.utf8))
}

fn unbrace(name: &str) -> &str {
	name.strip_prefix('{').and_then(|s| s.strip_suffix('}')).unwrap_or(name)
}

fn numbered(name: &str) -> bool {
	matches!(name.as_bytes().first(), Some(b'1'..=b'9')) && name.as_bytes().iter().all(u8::is_ascii_digit)
}

pub(in crate::perl) fn is_match_var(name: &str) -> bool {
	let name = unbrace(name);
	matches!(name, "&" | "`" | "'" | "+" | "^N" | "^MATCH" | "^PREMATCH" | "^POSTMATCH") || numbered(name)
}

/// Read a scalar match variable, or return `None` for an ordinary symbol.
pub(in crate::perl) fn match_var(interp: &mut Interp<'_>, name: &str) -> Option<Value> {
	let name = unbrace(name);
	if name == "^R" {
		let sv = interp.sv("main::^R");
		return Some(sv.get());
	}
	if !is_match_var(name) { return None; }
	let Some(state) = interp.last_match() else { return Some(Value::Undef); };
	Some(match name {
		"&" => state.group(0),
		"`" => state.preceding(),
		"'" => state.following(),
		"+" => {
			let highest = state.highest();
			if highest == 0 { Value::Undef } else { state.group(highest) }
		}
		"^N" => state.last_closed(),
		"^MATCH" if state.regex.preserves_match() => state.group(0),
		"^PREMATCH" if state.regex.preserves_match() => state.preceding(),
		"^POSTMATCH" if state.regex.preserves_match() => state.following(),
		_ => name.parse::<usize>().map_or(Value::Undef, |n| state.group(n)),
	})
}

/// Snapshot an offset array or `@{^CAPTURE}` from the current dynamic match.
pub(in crate::perl) fn match_array(interp: &mut Interp<'_>, name: &str) -> Option<Vec<Value>> {
	let name = unbrace(name);
	if !matches!(name, "-" | "+" | "^CAPTURE") { return None; }
	let Some(state) = interp.last_match() else { return Some(Vec::new()); };
	Some(match name {
		"-" => state.offsets().iter().take(state.highest() + 1).map(|span| {
			span.map_or(Value::Undef, |(start, _)| Value::Int(start as i64))
		}).collect(),
		"+" => state.offsets().iter().map(|span| {
			span.map_or(Value::Undef, |(_, end)| Value::Int(end as i64))
		}).collect(),
		_ => (1..=state.highest()).map(|n| state.group(n)).collect(),
	})
}

/// Count unique names (or only their participating captures) without materializing capture strings.
pub(in crate::perl) fn named_count(interp: &Interp<'_>, all: bool) -> Option<usize> {
	let state = interp.last_match()?;
	let names = state.regex.names();
	if names.is_empty() { return None; }
	Some(if all { names.len() } else {
		names.iter().filter(|(_, groups)| groups.iter().any(|&n| state.captures.spans.get(n).is_some_and(Option::is_some))).count()
	})
}

/// Snapshot the first/all-captures view of the current dynamic match.
/// `%+`, `%-`, `%{^CAPTURE}`, `%{^CAPTURE_ALL}` as a hash container that stays
/// the same while the last match does, so `each(%+)` iterates instead of
/// restarting on a fresh hash every call. `None` when `name` is not one of them.
pub(in crate::perl) fn match_hv(interp: &mut Interp<'_>, name: &str) -> Option<Hv> {
	let key = unbrace(name);
	if !matches!(key, "-" | "+" | "^CAPTURE" | "^CAPTURE_ALL") { return None; }
	let state = interp.last_match();
	let current = state.as_ref().map_or(std::ptr::null(), Rc::as_ptr);
	if let Some((_, seen, hv)) = interp.rx.match_hashes.iter().find(|(k, _, _)| *k == key)
		&& state.is_some() && seen.as_ptr() == current
	{
		return Some(hv.clone());
	}
	let values = match_hash(interp, key)?;
	let hv = new_hv();
	hv.entries_mut().extend(values.into_iter().map(|(k, v)| (HKey::new(&k), new_sv(v))));
	let seen = state.as_ref().map_or_else(Weak::new, Rc::downgrade);
	let hashes = &mut interp.rx.match_hashes;
	hashes.retain(|(k, _, _)| *k != key);
	hashes.push((key.to_owned(), seen, hv.clone()));
	Some(hv)
}

pub(in crate::perl) fn match_hash(interp: &mut Interp<'_>, name: &str) -> Option<Vec<(PStr, Value)>> {
	let name = unbrace(name);
	if !matches!(name, "-" | "+" | "^CAPTURE" | "^CAPTURE_ALL") { return None; }
	let Some(state) = interp.last_match() else { return Some(Vec::new()); };
	let all = matches!(name, "-" | "^CAPTURE_ALL");
	Some(state.regex.names().iter().filter_map(|(name, groups)| {
		let value = if all {
			Value::Ref(Ref::Array(new_av(groups.iter().map(|&n| state.group(n)).collect())))
		} else {
			let n = *groups.iter().find(|&&n| state.captures.spans.get(n).is_some_and(Option::is_some))?;
			state.group(n)
		};
		Some((PStr::from_str(name), value))
	}).collect())
}
