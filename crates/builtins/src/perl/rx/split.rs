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
	let (cell, value) = subject(interp, expr, None)?.read(interp)?;
	let original_pos = cell.as_ref().and_then(|s| s.pos.get()).unwrap_or(0);
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
	let source = Rc::new(source);
	let mut output = Fields::new(&source, cx);
	if !source.is_empty() {
		let max_splits = if limit > 0 { (limit as usize).saturating_sub(1) } else { usize::MAX };
		match separator {
			Separator::Whitespace => {
				let unicode = source.utf8 || (!bytes && interp.hints().features.enabled("unicode_strings"));
				whitespace(interp, &source, unicode, max_splits, &mut output)?;
			}
			Separator::Characters => characters(interp, &source, max_splits, &mut output)?,
			Separator::Lines => lines(interp, &source, max_splits, &mut output)?,
			Separator::Regex(regex) => regex_fields(interp, &regex, &source, cell.as_ref(), original_pos, max_splits, &mut output)?,
		}
	}
	Ok(output.finish(limit == 0))
}

struct Fields<'a> {
	source: &'a PStr,
	list: Option<Vec<Value>>,
	len: usize,
	last_nonempty: usize,
}

impl<'a> Fields<'a> {
	fn new(source: &'a PStr, cx: Cx) -> Self {
		Self { source, list: (cx == Cx::List).then(Vec::new), len: 0, last_nonempty: 0 }
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

fn characters(interp: &Interp<'_>, source: &PStr, max_splits: usize, output: &mut Fields<'_>) -> PResult<()> {
	if output.list.is_none() {
		let length = source.char_len();
		let count = length.min(max_splits);
		output.len = count + 1;
		output.last_nonempty = if count < length { count + 1 } else { count };
		return Ok(());
	}
	let mut start = 0;
	for n in 0..max_splits {
		if start >= source.bytes.len() { break; }
		if n % 1024 == 0 && interp.is_cancelled() { return Err(Flow::Cancelled); }
		let end = next_boundary(source, start);
		output.span(start, end);
		start = end;
	}
	output.span(start, source.bytes.len());
	Ok(())
}

fn lines(interp: &Interp<'_>, source: &PStr, max_splits: usize, output: &mut Fields<'_>) -> PResult<()> {
	let mut start = 0;
	for (at, _) in source.bytes.iter().enumerate().filter(|(at, b)| **b == b'\n' && *at + 1 < source.bytes.len()).take(max_splits) {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		output.span(start, at + 1);
		start = at + 1;
	}
	output.span(start, source.bytes.len());
	Ok(())
}

fn whitespace(interp: &Interp<'_>, source: &PStr, unicode: bool, max_splits: usize, output: &mut Fields<'_>) -> PResult<()> {
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
		output.span(start, end);
		end = skip_space(end);
		start = end;
	}
	output.span(start, len);
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
