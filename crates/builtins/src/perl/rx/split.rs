//! Pattern splitting, including `perlfunc`'s whitespace, line-start and zero-width cases.

use std::rc::Rc;

use super::{Cx, ExecOpts, Expr, ExprKind, Flow, Interp, Operation, PResult, PStr, Regex, RegexKind, Ret, Value,
	actions, captures::capture_value, coerce_regexp, compile, effective_flags, next_boundary, regex_expr, subject,
	text, ungroup, warn_undef, whole_span};

enum Separator {
	Whitespace,
	Characters,
	Lines,
	Regex(Rc<Regex>),
}

impl Separator {
	fn regex(regex: Rc<Regex>) -> Self {
		if regex.is_empty_pattern() { Self::Characters }
		else if line_pattern(&regex.source().bytes, regex.flags().x) { Self::Lines }
		else { Self::Regex(regex) }
	}
}

// Perl recognizes a bare ^ separator, including after inline regexp modifiers.
fn line_pattern(mut source: &[u8], mut extended: bool) -> bool {
	let mut grouped = false;
	loop {
		if extended {
			source = skip_extended_space(source).trim_ascii_end();
			if let Some(rest) = source.strip_prefix(b"^") && skip_extended_space(rest).is_empty() { return true; }
		} else if source == b"^" { return true; }
		let Some(rest) = source.strip_prefix(b"(?") else { return false; };
		let Some(colon) = rest.iter().position(|&b| b == b':') else { return false; };
		let options = &rest[..colon];
		if options.is_empty() && !grouped { return false; }
		if !options.iter().all(|b| b"^adilmnpsux-".contains(b)) { return false; }
		let Some(body) = rest[colon + 1..].strip_suffix(b")") else { return false; };
		if options.contains(&b'^') { extended = false; }
		let negative = options.iter().position(|&b| b == b'-');
		if let Some(x) = options.iter().rposition(|&b| b == b'x') { extended = negative.is_none_or(|n| x < n); }
		grouped = true;
		source = body;
	}
}

fn skip_extended_space(mut text: &[u8]) -> &[u8] {
	loop {
		text = text.trim_ascii_start();
		if text.first() != Some(&b'#') { return text; }
		let Some(newline) = text.iter().position(|&b| b == b'\n') else { return &[]; };
		text = &text[newline + 1..];
	}
}

fn separator(interp: &mut Interp<'_>, expr: Option<&Expr>) -> PResult<Separator> {
	let Some(expr) = expr else { return Ok(Separator::Whitespace); };
	if let ExprKind::Regex(re) = &ungroup(expr).kind {
		if matches!(re.kind, RegexKind::Match(_) | RegexKind::Compile) {
			return regex_expr(interp, re).map(Separator::regex);
		}
	}
	// The -a wrapper emits split(' ', $_). A plain string literal has
	// no evaluation effects unless a constant-overloading pragma is active.
	if let ExprKind::String(s) = &expr.kind && interp.hints().constant_overloads.is_empty() {
		if s.bytes == b" " { return Ok(Separator::Whitespace); }
		if s.is_empty() { return Ok(Separator::Characters); }
		let flags = effective_flags(interp, &[])?;
		return compile(interp, expr as *const Expr as usize, s, flags).map(Separator::regex);
	}
	let value = interp.eval_scalar(expr)?;
	if let Some(regex) = coerce_regexp(interp, &value)? { return Ok(Separator::regex(regex)); }
	let pattern = text(interp, value, Some(expr), Operation::Compile)?;
	if pattern.bytes == b" " { return Ok(Separator::Whitespace); }
	if pattern.is_empty() { return Ok(Separator::Characters); }
	let flags = effective_flags(interp, &[])?;
	compile(interp, expr as *const Expr as usize, &pattern, flags).map(Separator::regex)
}

pub(super) fn split(interp: &mut Interp<'_>, args: &[Expr], cx: Cx) -> PResult<Ret> {
	let separator = separator(interp, args.first())?;
	let expr = args.get(1);
	let target = subject(interp, expr, None)?;
	// An explicit limit may run Perl and mutate the input, so preserve
	// the normal snapshot/evaluation order in that case.
	if args.get(2).is_none() && let super::Subject::Cell(cell) = &target
		&& let Some(raw) = cell.plain_value() && let Value::Str(source) = &*raw
		&& !(source.utf8 && interp.hints().bytes)
		&& let Some(ret) = simple_fields(interp, &separator, source, cx, 0)?
	{ return Ok(ret); }
	let (cell, value) = target.read(interp)?;
	let original_pos = cell.as_ref().and_then(|s| s.pos()).unwrap_or(0);
	let mut source = text(interp, value, expr, Operation::Split)?;
	let bytes = interp.hints().bytes;
	source.utf8 &= !bytes;
	let limit = if let Some(limit) = args.get(2) {
		let value = interp.eval_scalar(limit)?;
		if value.is_undef() {
			warn_undef(interp, Some(limit), Operation::Split);
			0
		} else {
			if let Value::Str(s) = &value && !value.is_numeric_string() && interp.warn_on("numeric") {
				interp.warn_category("numeric", format!("Argument \"{}\" isn't numeric in split", s.to_string_lossy()));
			}
			interp.numify(&value)?.wrapping_iv()
		}
	} else { 0 };
	if let Some(ret) = simple_fields(interp, &separator, &source, cx, limit)? { return Ok(ret); }
	let source = Rc::new(source);
	let mut output = Fields::new(interp, &source, cx);
	if let Separator::Regex(regex) = separator {
		regex_fields(interp, &regex, &source, cell.as_ref(), original_pos, split_budget(limit), &mut output)?;
	}
	Ok(output.finish(limit == 0))
}

/// Assign a callback-free split directly into a plain array. The caller has
/// checked the array's assignment magic and that this call uses CORE::split.
/// Do not touch the array until scanning succeeds (including cancellation).
pub(in crate::perl) fn split_into_array(interp: &mut Interp<'_>, call: &super::Call, array: &crate::perl::value::Av) -> PResult<Option<usize>> {
	let args = super::arguments(call);
	if args.len() > 2 { return Ok(None); }
	let separator = match args.first() {
		None => Separator::Whitespace,
		Some(expr) => match &expr.kind {
			ExprKind::String(s) if interp.hints().constant_overloads.is_empty() => {
				if s.bytes == b" " { Separator::Whitespace }
				else if s.is_empty() { Separator::Characters }
				else {
					// Compilation can run Perl. Only use the already-compiled,
					// identical literal under its original flags.
					let Some(regex) = interp.rx.compiled(expr as *const Expr as usize).cloned() else { return Ok(None); };
					if regex.source().bytes != s.bytes || regex.source().utf8 != s.utf8
						|| regex.flags() != effective_flags(interp, &[])? { return Ok(None); }
					Separator::regex(regex)
				}
			}
			ExprKind::Regex(re) if matches!(re.kind, RegexKind::Match(_) | RegexKind::Compile) &&
				re.pattern.iter().all(|p| matches!(p, super::QuotePart::Literal(_) | super::QuotePart::Case(_))) => {
				let Some(regex) = interp.rx.compiled(re as *const _ as usize) else { return Ok(None); };
				Separator::regex(regex.clone())
			}
			_ => return Ok(None),
		},
	};
	let cell = if let Some(expr) = args.get(1) {
		let Some(cell) = interp.plain_scalar_cell(ungroup(expr)) else { return Ok(None); };
		cell
	} else { interp.topic() };
	let Some(raw) = cell.plain_value() else { return Ok(None); };
	let Value::Str(source) = &*raw else { return Ok(None); };
	if source.utf8 && interp.hints().bytes || !simple_separator(&separator, source) { return Ok(None); }

	let mut spans = std::mem::take(&mut interp.rx.spare_spans);
	let scan = simple_spans(interp, &separator, source, usize::MAX, |lo, hi| spans.push((lo, hi)));
	let count = spans.iter().rposition(|(lo, hi)| lo != hi).map_or(0, |last| last + 1);
	if scan.is_ok() {
		use crate::perl::value::new_sv;
		let mut elems = array.elems_mut();
		elems.truncate(count);
		for (i, &(lo, hi)) in spans[..count].iter().enumerate() {
			let field = &source.bytes[lo..hi];
			if let Some(slot) = elems.get_mut(i) {
				// An escaped element (including a Weak) must keep its old
				// contents; ordinary array assignment installs a fresh cell.
				if let Some(sv) = Rc::get_mut(slot) && !sv.registered() && !sv.is_magical() && !sv.is_blessed() {
					if let Ok(mut v) = sv.try_value_mut() {
						if let Value::Str(s) = &mut *v {
							s.bytes.clear();
							s.bytes.extend_from_slice(field);
							s.utf8 = source.utf8;
						} else { *v = Value::Str(PStr::new(field.to_vec(), source.utf8)); }
						sv.set_pos(None);
						continue;
					}
				}
				*slot = new_sv(Value::Str(PStr::new(field.to_vec(), source.utf8)));
			} else { elems.push(new_sv(Value::Str(PStr::new(field.to_vec(), source.utf8)))); }
		}
	}
	interp.rx.recycle_spans(spans);
	scan.map(|()| Some(count))
}

fn split_budget(limit: i64) -> usize {
	if limit > 0 { (limit as usize).saturating_sub(1) } else { usize::MAX }
}

fn simple_separator(separator: &Separator, source: &PStr) -> bool {
	source.is_empty() || !matches!(separator, Separator::Regex(re)
		if !re.is_byte_literal() || source.utf8 && std::str::from_utf8(&source.bytes).is_err())
}

fn simple_fields(interp: &Interp<'_>, separator: &Separator, source: &PStr, cx: Cx, limit: i64) -> PResult<Option<Ret>> {
	if !simple_separator(separator, source) { return Ok(None); }
	let mut output = Fields::new(interp, source, cx);
	let max = split_budget(limit);
	if output.list.is_none() && matches!(separator, Separator::Characters) && !source.is_empty() {
		let length = source.char_len();
		let count = length.min(max);
		output.len = count + 1;
		output.last_nonempty = if count < length { count + 1 } else { count };
	} else {
		simple_spans(interp, separator, source, max, |lo, hi| output.span(lo, hi))?;
	}
	Ok(Some(output.finish(limit == 0)))
}

fn simple_spans(interp: &Interp<'_>, separator: &Separator, source: &PStr, max: usize, mut emit: impl FnMut(usize, usize)) -> PResult<()> {
	if source.is_empty() { return Ok(()); }
	match separator {
		Separator::Whitespace => {
			let unicode = source.utf8 || (!interp.hints().bytes && interp.hints().features.enabled("unicode_strings"));
			if !source.utf8 { whitespace_bytes(interp, &source.bytes, unicode, max, emit) }
			else { whitespace(interp, source, unicode, max, emit) }
		}
		Separator::Characters => characters(interp, source, max, emit),
		Separator::Lines => lines(interp, source, max, emit),
		Separator::Regex(regex) => {
			let mut start = 0;
			for _ in 0..max {
				if interp.is_cancelled() { return Err(Flow::Cancelled); }
				let Some((begin, end)) = regex.literal_span(&source.bytes, start) else { break; };
				emit(start, begin);
				start = end;
			}
			emit(start, source.bytes.len());
			Ok(())
		}
	}
}

struct Fields<'a> {
	source: &'a PStr,
	list: Option<Vec<Value>>,
	len: usize,
	last_nonempty: usize,
}

impl<'a> Fields<'a> {
	fn new(interp: &Interp<'_>, source: &'a PStr, cx: Cx) -> Self {
		Self { source, list: (cx == Cx::List).then(|| interp.rx.split_values.take()), len: 0, last_nonempty: 0 }
	}

	fn span(&mut self, start: usize, end: usize) { self.push(Some((start, end))); }

	fn push(&mut self, span: Option<(usize, usize)>) {
		self.len += 1;
		if span.is_some_and(|(start, end)| start < end) { self.last_nonempty = self.len; }
		if let Some(list) = self.list.as_mut() { list.push(capture_value(self.source, span)); }
	}

	fn finish(self, trim: bool) -> Ret {
		let len = if trim { self.last_nonempty } else { self.len };
		if let Some(mut list) = self.list {
			list.truncate(len);
			Ret::Many(list)
		} else { Ret::One(Value::Int(len as i64)) }
	}
}

fn characters(interp: &Interp<'_>, source: &PStr, max_splits: usize, mut emit: impl FnMut(usize, usize)) -> PResult<()> {
	let mut start = 0;
	for n in 0..max_splits {
		if start >= source.bytes.len() { break; }
		if n % 1024 == 0 && interp.is_cancelled() { return Err(Flow::Cancelled); }
		let end = next_boundary(source, start);
		emit(start, end);
		start = end;
	}
	emit(start, source.bytes.len());
	Ok(())
}

fn lines(interp: &Interp<'_>, source: &PStr, max_splits: usize, mut emit: impl FnMut(usize, usize)) -> PResult<()> {
	let mut start = 0;
	for (at, _) in source.bytes.iter().enumerate().filter(|(at, b)| **b == b'\n' && *at + 1 < source.bytes.len()).take(max_splits) {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		emit(start, at + 1);
		start = at + 1;
	}
	emit(start, source.bytes.len());
	Ok(())
}

fn whitespace_bytes(interp: &Interp<'_>, bytes: &[u8], unicode: bool, max: usize, mut emit: impl FnMut(usize, usize)) -> PResult<()> {
	let space = |b: u8| matches!(b, 9..=13 | 32) || unicode && matches!(b, 0x85 | 0xa0);
	let mut start = bytes.iter().position(|&b| !space(b)).unwrap_or(bytes.len());
	if start == bytes.len() { return Ok(()); }
	for _ in 0..max {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let Some(n) = bytes[start..].iter().position(|&b| space(b)) else { break; };
		let end = start + n;
		emit(start, end);
		start = bytes[end..].iter().position(|&b| !space(b)).map_or(bytes.len(), |n| end + n);
	}
	emit(start, bytes.len());
	Ok(())
}

fn whitespace(interp: &Interp<'_>, source: &PStr, unicode: bool, max_splits: usize, mut emit: impl FnMut(usize, usize)) -> PResult<()> {
	let bytes = &source.bytes;
	let len = bytes.len();
	// Byte-level scan: in a byte string every byte is a character, and in
	// UTF-8 only multi-byte characters need decoding (for Unicode spaces).
	let wide_spaces = unicode && source.utf8;
	let space_at = |at: usize| -> Option<usize> {
		let b = bytes[at];
		if b < 0x80 || !source.utf8 {
			let space = if unicode { matches!(b, 9..=13 | 32 | 0x85 | 0xA0) } else { matches!(b, 9..=13 | 32) };
			return space.then_some(at + 1);
		}
		if !wide_spaces { return None; }
		let end = next_boundary(source, at);
		std::str::from_utf8(&bytes[at..end]).ok().and_then(|s| s.chars().next()).filter(|c| c.is_whitespace()).map(|_| end)
	};
	let skip_word = |mut at: usize| {
		while at < len && space_at(at).is_none() {
			at = if bytes[at] < 0x80 || !source.utf8 { at + 1 } else { next_boundary(source, at) };
		}
		at
	};
	let skip_space = |mut at: usize| {
		while at < len && let Some(next) = space_at(at) { at = next; }
		at
	};
	let mut end = skip_space(0);
	if end == len { return Ok(()); }
	let mut start = end;
	for _ in 0..max_splits {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		end = skip_word(end);
		if end == len { break; }
		emit(start, end);
		end = skip_space(end);
		start = end;
	}
	emit(start, len);
	Ok(())
}

fn regex_fields(interp: &mut Interp<'_>, regex: &Rc<Regex>, source: &Rc<PStr>, cell: Option<&super::Sv>, pos: usize, max_splits: usize, output: &mut Fields<'_>) -> PResult<()> {
	let opts = ExecOpts { not_empty_at_start: true, g_anchor: Some(pos), ..ExecOpts::default() };
	let mut start = 0;
	for _ in 0..max_splits {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let Some(caps) = actions::exec(interp, regex, source, cell, start, opts)? else { break; };
		let (begin, end) = whole_span(&caps);
		if end <= start { break; }
		output.span(start, begin);
		for &span in caps.spans.iter().skip(1) { output.push(span); }
		start = end;
	}
	output.span(start, source.bytes.len());
	Ok(())
}
