//! Text layout, abbreviations, quote-aware word parsing, and ANSI SGR styling.

use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	limits::check_len,
	regex::{ExecOpts, Regex, RxFlags},
	value::{HKey, Hv, PStr, Ref, Sv, Value, new_av, new_hv, new_sv},
};

use super::{arg, boolean, define, export, export_tag, list, text, version};

/// Install the requested text or styling module.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"Text::Wrap" => {
			interp.require_module("Text::Tabs")?;
			version(interp, module, "2013.0523");
			define(interp, module, &[("wrap", wrap), ("fill", fill)]);
			export(interp, module, &["wrap", "fill"], &["$columns", "$break", "$huge"]);
			for (name, value) in [
				("columns", Value::Int(76)), ("break", Value::str(r"(?=\s)\X")),
				("huge", Value::str("wrap")), ("separator", Value::str("\n")),
				("separator2", Value::Undef), ("tabstop", Value::Int(8)), ("unexpand", Value::Int(1)),
			] {
				interp.sv(&format!("Text::Wrap::{name}")).set(value);
			}
		},
		"Text::Tabs" => {
			version(interp, module, "2013.0523");
			define(interp, module, &[("expand", expand), ("unexpand", unexpand)]);
			export(interp, module, &["expand", "unexpand", "$tabstop"], &[]);
			interp.sv("Text::Tabs::tabstop").set(Value::Int(8));
		},
		"Text::Abbrev" => {
			version(interp, module, "1.02");
			define(interp, module, &[("abbrev", abbrev)]);
			export(interp, module, &["abbrev"], &[]);
		},
		"Text::ParseWords" => {
			version(interp, module, "3.30");
			define(interp, module, &[("shellwords", shellwords), ("parse_line", parse_line),
				("quotewords", quotewords), ("nested_quotewords", nested_quotewords), ("old_shellwords", old_shellwords)]);
			export(interp, module, &["shellwords", "quotewords", "nested_quotewords", "parse_line"], &["old_shellwords"]);
		},
		"Term::ANSIColor" => load_ansi(interp, module),
		_ => unreachable!("text module registry: {module}"),
	}
	Ok(())
}

fn variable(interp: &mut Interp<'_>, name: &str) -> PResult<Value> {
	let sv = interp.sv(name);
	interp.read_sv(&sv)
}

fn tabstop(value: Value) -> usize {
	let width = value.to_i64();
	if width > 1 { width as usize } else { 8 }
}

// Perl counts extended grapheme clusters, rather than terminal cells. The
// ASCII fast path keeps ordinary text out of the regex engine entirely.
thread_local! {
	static GRAPHEME: Option<Regex> = Regex::new(&PStr::from_bytes(br"\G\X"), RxFlags::default()).ok();
}

fn unit_end(source: &PStr, at: usize) -> usize {
	let rest = &source.bytes[at..];
	if rest.starts_with(b"\r\n") { return at + 2; }
	if rest.len() <= 1 || !source.utf8 || matches!(rest[0], b'\t' | b'\n' | b'\r') {
		return (at + 1).min(source.bytes.len());
	}
	if rest[0].is_ascii() && rest[1].is_ascii() { return at + 1; }
	GRAPHEME.with(|re| {
		re.as_ref().and_then(|re| re.exec(source, at, ExecOpts::default()).ok().flatten())
			.and_then(|m| m.spans.first().copied().flatten()).map_or_else(|| char_end(source, at), |(_, end)| end)
	})
}

fn char_end(source: &PStr, at: usize) -> usize {
	let mut end = at + 1;
	if source.utf8 && source.bytes[at] >= 0xc0 {
		while source.bytes.get(end).is_some_and(|b| b & 0xc0 == 0x80) { end += 1; }
	}
	end
}

fn space_at(source: &PStr, at: usize) -> bool {
	let c = source.bytes[at];
	if c.is_ascii() { matches!(c, b' ' | b'\t'..=b'\r') }
	else if !source.utf8 { matches!(c, 0x85 | 0xa0) }
	else {
		std::str::from_utf8(&source.bytes[at..char_end(source, at)]).ok()
			.and_then(|s| s.chars().next()).is_some_and(char::is_whitespace)
	}
}

/// Appends `n` spaces; the `$tabstop`-driven count is checked against the shared buffer limit first.
fn spaces(out: &mut Vec<u8>, n: usize) -> Result<(), String> {
	check_len(out.len().saturating_add(n), "string")?;
	out.extend(std::iter::repeat_n(b' ', n));
	Ok(())
}

/// Expands (or with `compress`, unexpands) tabs at `width`-column stops; Err when the result would exceed the buffer limit.
fn tabs(input: PStr, width: usize, compress: bool) -> Result<PStr, String> {
	if !input.bytes.contains(&b'\t') && (!compress || !input.bytes.contains(&b' ')) { return Ok(input); }
	let overflow = || "Out of memory during string extend".to_owned();
	let mut out = Vec::with_capacity(input.bytes.len());
	let mut at = 0;
	let mut col: usize = 0;
	while at < input.bytes.len() {
		let start = at;
		match input.bytes[at] {
			b'\n' => { col = 0; at += 1; out.push(b'\n'); },
			b' ' | b'\t' => {
				let orig = col;
				while matches!(input.bytes.get(at), Some(b' ' | b'\t')) {
					col = col.checked_add(if input.bytes[at] == b' ' { 1 } else { width - col % width }).ok_or_else(overflow)?;
					at += 1;
				}
				let mut written = orig;
				if compress {
					let next = width - written % width;
					if next <= col - written {
						if next == 1 { out.push(b' '); } else { out.push(b'\t'); }
						written += next;
						let count = (col - written) / width;
						check_len(out.len().saturating_add(count), "string")?;
						out.extend(std::iter::repeat_n(b'\t', count));
						written += count * width;
					}
				}
				spaces(&mut out, col - written)?;
			},
			_ => {
				at = unit_end(&input, at);
				out.extend_from_slice(&input.bytes[start..at]);
				if input.bytes[at - 1] == b'\n' { col = 0; } else { col = col.checked_add(1).ok_or_else(overflow)?; }
			},
		}
	}
	Ok(PStr::new(out, input.utf8))
}

fn tabs_call(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx, compress: bool) -> PResult<Ret> {
	let width = tabstop(variable(interp, "Text::Tabs::tabstop")?);
	let mut values = args.into_iter().map(|s| {
		let v = interp.read_sv(&s)?;
		let s = interp.stringify(&v)?;
		tabs(s, width, compress).map(Value::Str).map_err(|e| interp.die_msg(e))
	});
	if cx == Cx::List { Ok(Ret::Many(values.collect::<PResult<_>>()?)) }
	else { Ok(Ret::One(values.next().transpose()?.unwrap_or(Value::Undef))) }
}

fn expand(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { tabs_call(interp, args, cx, false) }
fn unexpand(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { tabs_call(interp, args, cx, true) }

fn anchored(interp: &mut Interp<'_>, delimiter: Value) -> PResult<Regex> {
	let (pattern, flags) = match delimiter {
		Value::Ref(Ref::Regexp(r)) => (r.regex.source().clone(), r.regex.flags()),
		other => (interp.stringify(&other)?, RxFlags::default()),
	};
	let mut source = PStr::from_bytes(br"\G(?:");
	source.push(&pattern);
	source.push_bytes(b")");
	Regex::new(&source, flags).map_err(|e| interp.die_msg(e))
}

fn match_at(interp: &mut Interp<'_>, pattern: &Regex, s: &PStr, at: usize) -> PResult<Option<usize>> {
	Ok(pattern.exec(s, at, ExecOpts::default()).map_err(|e| interp.die_msg(e))?
		.and_then(|m| m.spans.first().copied().flatten()).filter(|&(start, _)| start == at).map(|(_, end)| end))
}

struct Layout {
	first: PStr,
	next: PStr,
	columns: usize,
	tabstop: usize,
	compress: bool,
	break_re: Option<Regex>,
	separator: PStr,
	separator2: Option<PStr>,
	huge: String,
}

impl Layout {
	fn new(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<Self> {
		let tabstop = tabstop(variable(interp, "Text::Wrap::tabstop")?);
		let first = interp.stringify(&arg(args, 0))?;
		let first = tabs(first, tabstop, false).map_err(|e| interp.die_msg(e))?;
		let next = interp.stringify(&arg(args, 1))?;
		let next = tabs(next, tabstop, false).map_err(|e| interp.die_msg(e))?;
		let columns = variable(interp, "Text::Wrap::columns")?.to_i64().max(0) as usize;
		let compress = variable(interp, "Text::Wrap::unexpand")?.truthy();
		let separator = variable(interp, "Text::Wrap::separator")?.to_pstr();
		let separator2 = match variable(interp, "Text::Wrap::separator2")? { Value::Undef => None, v => Some(v.to_pstr()) };
		let huge = variable(interp, "Text::Wrap::huge")?.to_pstr().to_string_lossy().into_owned();
		let delim = variable(interp, "Text::Wrap::break")?;
		let break_re = if delim.to_pstr().bytes == br"(?=\s)\X" { None } else { Some(anchored(interp, delim)?) };
		Ok(Self { first, next, columns, tabstop, compress, break_re, separator, separator2, huge })
	}

	fn break_at(&self, interp: &mut Interp<'_>, s: &PStr, at: usize) -> PResult<Option<usize>> {
		if let Some(re) = &self.break_re { match_at(interp, re, s, at) }
		else { Ok(space_at(s, at).then(|| unit_end(s, at))) }
	}

	fn separator(&self, explicit: bool) -> (&[u8], bool) {
		match (&self.separator2, explicit) {
			(Some(_), true) => (b"\n", false),
			(Some(sep), false) => (&sep.bytes, sep.utf8),
			(None, _) => (&self.separator.bytes, self.separator.utf8),
		}
	}

	fn append(&self, interp: &mut Interp<'_>, out: &mut PStr, input: PStr) -> PResult<()> {
		let input = tabs(input, self.tabstop, false).map_err(|e| interp.die_msg(e))?;
		let len = input.bytes.len();
		let mut content_end = len;
		while content_end > 0 {
			let mut start = content_end - 1;
			if input.utf8 {
				while start > 0 && input.bytes[start] & 0xc0 == 0x80 { start -= 1; }
			}
			if !space_at(&input, start) { break; }
			content_end = start;
		}
		if content_end == 0 { return Ok(()); }
		let width = |prefix: &PStr| {
			let mut at = 0;
			let mut count = 0;
			while at < prefix.bytes.len() { at = unit_end(prefix, at); count += 1; }
			count
		};
		let first_width = self.columns.saturating_sub(width(&self.first) + 1);
		let next_width = self.columns.saturating_sub(width(&self.next) + 1).max(1);
		let mut at = 0;
		let mut first = true;
		let mut explicit = false;
		while at < content_end {
			if !first {
				let (sep, utf8) = self.separator(explicit);
				append_segment(out, sep, utf8);
			}
			let (prefix, width) = if first { (&self.first, first_width) } else { (&self.next, next_width) };
			first = false;
			let mut edge = at;
			let mut boundary = None;
			for column in 0..=width {
				if edge == len { boundary = Some((edge, edge)); break; }
				if let Some(end) = self.break_at(interp, &input, edge)? {
					if end > edge || edge > at { boundary = Some((edge, end)); }
				}
				if column == width || input.bytes[edge] == b'\n' { break; }
				edge = unit_end(&input, edge);
			}
			let (end, after) = if let Some(boundary) = boundary { boundary }
			else if width == 0 { (at, at) }
			else {
				match self.huge.as_str() {
					"wrap" => (edge, if edge == at { unit_end(&input, edge) } else if input.bytes.get(edge) == Some(&b'\n') { edge + 1 } else { edge }),
					"overflow" => loop {
						if edge == len { break (edge, edge); }
						if let Some(end) = self.break_at(interp, &input, edge)? {
							if end > at { break (edge, end); }
						}
						edge = unit_end(&input, edge);
					},
					"die" => return Err(interp.die_msg(format!("couldn't wrap '{}'", input.to_string_lossy()))),
					_ => return Err(interp.die_msg("This shouldn't happen")),
				}
			};
			let chunk = &input.bytes[at..end];
			if self.compress && (prefix.bytes.windows(2).any(|p| p == b"  ")
				|| chunk.windows(2).any(|p| p == b"  ")
				|| (prefix.bytes.ends_with(b" ") && chunk.starts_with(b" ")))
			{
				let mut line = prefix.clone();
				append_segment(&mut line, chunk, input.utf8);
				out.push(&tabs(line, self.tabstop, true).map_err(|e| interp.die_msg(e))?);
			} else {
				out.push(prefix);
				append_segment(out, chunk, input.utf8);
			}
			explicit = input.bytes[end..after].contains(&b'\n');
			at = after;
		}
		if explicit { out.push_bytes(b"\n"); }
		Ok(())
	}
}

fn append_segment(out: &mut PStr, bytes: &[u8], utf8: bool) {
	if utf8 { out.upgrade(); out.bytes.extend_from_slice(bytes); }
	else { out.push_bytes(bytes); }
}

fn join_args(interp: &mut Interp<'_>, args: &[Sv], separator: &[u8]) -> PResult<PStr> {
	let mut out = PStr::default();
	for (i, arg) in args.iter().enumerate() {
		if i != 0 { out.push_bytes(separator); }
		let val = interp.read_sv(arg)?;
		out.push(&interp.stringify(&val)?);
	}
	Ok(out)
}

fn wrap(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let layout = Layout::new(interp, &args)?;
	let mut input = PStr::default();
	let mut space = false;
	for sv in args.iter().skip(2) {
		let value = interp.read_sv(sv)?;
		let part = interp.stringify(&value)?;
		if space { input.push_bytes(b" "); }
		space = !matches!(part.bytes.last(), Some(b' ' | b'\n'..=b'\r'));
		input.push(&part);
	}
	let mut out = PStr::default();
	layout.append(interp, &mut out, input)?;
	Ok(Ret::One(Value::Str(out)))
}

fn fill(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let layout = Layout::new(interp, &args)?;
	let input = join_args(interp, args.get(2..).unwrap_or_default(), b"\n")?;
	let mut out = PStr::default();
	let mut normalized = PStr::new(Vec::new(), input.utf8);
	let mut at = 0;
	while at < input.bytes.len() {
		if space_at(&input, at) {
			let start = at;
			while at < input.bytes.len() && space_at(&input, at) { at = char_end(&input, at); }
			if input.bytes[start..at].windows(2).any(|p| p[0] == b'\n') {
				if at < input.bytes.len() {
					if input.bytes[start] != b'\n' { normalized.bytes.push(b' '); }
					layout.append(interp, &mut out, std::mem::take(&mut normalized))?;
					out.push_bytes(b"\n");
					normalized.utf8 = input.utf8;
				}
			} else { normalized.bytes.push(b' '); }
		} else {
			let end = char_end(&input, at);
			normalized.bytes.extend_from_slice(&input.bytes[at..end]);
			at = end;
		}
	}
	layout.append(interp, &mut out, normalized)?;
	Ok(Ret::One(Value::Str(out)))
}

fn common_prefix(a: &PStr, b: &PStr) -> usize {
	a.bytes.iter().zip(&b.bytes).take_while(|(a, b)| a == b).count()
}

fn abbrev(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut words = Vec::with_capacity(args.len());
	for sv in args { let v = interp.read_sv(&sv)?; words.push(interp.stringify(&v)?); }
	if words.iter().any(|s| s.utf8) { for word in &mut words { word.upgrade(); } }
	words.sort_unstable_by(|a, b| a.bytes.cmp(&b.bytes));
	words.dedup_by(|a, b| a.bytes == b.bytes);
	let hash = (cx == Cx::Scalar).then(new_hv);
	let mut pairs = Vec::new();
	for (i, word) in words.iter().enumerate() {
		let shared_before = i.checked_sub(1).map_or(0, |p| common_prefix(word, &words[p]));
		let shared_after = words.get(i + 1).map_or(0, |next| common_prefix(word, next));
		let shared = shared_before.max(shared_after);
		let mut at = 0;
		loop {
			if at == word.bytes.len() || at > shared {
				let key = PStr::new(word.bytes[..at].to_vec(), word.utf8);
				if let Some(hash) = &hash {
					hash.entries_mut().insert(HKey::new(&key), new_sv(Value::Str(word.clone())));
				} else if cx == Cx::List { pairs.extend([Value::Str(key), Value::Str(word.clone())]); }
			}
			if at == word.bytes.len() { break; }
			at = char_end(word, at);
		}
	}
	Ok(hash.map_or(Ret::Many(pairs), |hv| Ret::One(Value::Ref(Ref::Hash(hv)))))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Keep { Content, Quotes, Delimiters, Old }

impl Keep {
	fn new(v: Value) -> Self {
		if v.to_pstr().bytes == b"delimiters" { Self::Delimiters }
		else if v.truthy() { Self::Quotes }
		else { Self::Content }
	}
}

enum Delimiter {
	Whitespace,
	Pattern(Regex),
}

impl Delimiter {
	fn new(interp: &mut Interp<'_>, value: Value) -> PResult<Self> {
		match &value {
			Value::Str(s) if s.bytes == br"\s+" => Ok(Self::Whitespace),
			_ => Ok(Self::Pattern(anchored(interp, value)?)),
		}
	}

	fn at(&self, interp: &mut Interp<'_>, source: &PStr, at: usize) -> PResult<Option<usize>> {
		match self {
			Self::Pattern(re) => match_at(interp, re, source, at),
			Self::Whitespace => {
				let mut end = at;
				while end < source.bytes.len() && space_at(source, end) { end = char_end(source, end); }
				Ok((end > at).then_some(end))
			},
		}
	}
}

fn parse_words(interp: &mut Interp<'_>, source: &PStr, mut at: usize, delimiter: &Delimiter, keep: Keep) -> PResult<Option<Vec<Value>>> {
	let mut words = Vec::new();
	while at < source.bytes.len() {
		let mut word = Vec::new();
		let mut delim = None;
		while at < source.bytes.len() {
			let b = source.bytes[at];
			if matches!(b, b'\'' | b'"') {
				let start = at;
				let preserve = matches!(keep, Keep::Quotes | Keep::Delimiters);
				if preserve { word.push(b); }
				at += 1;
				loop {
					let Some(&c) = source.bytes.get(at) else {
						if keep == Keep::Old {
							let quote = if b == b'\'' { "single" } else { "double" };
							interp.warn(format!("Unmatched {quote} quote: {}", String::from_utf8_lossy(&source.bytes[start..])));
						}
						return Ok(None);
					};
					if c == b {
						if preserve { word.push(c); }
						at += 1;
						break;
					}
					if c == b'\\' {
						if preserve || (b == b'\'' && keep != Keep::Old) { word.push(c); }
						at += 1;
						if at == source.bytes.len() { continue; }
					}
					let end = char_end(source, at);
					word.extend_from_slice(&source.bytes[at..end]);
					at = end;
				}
			} else if b == b'\\' {
				if matches!(keep, Keep::Quotes | Keep::Delimiters) { word.push(b); }
				at += 1;
				if at == source.bytes.len() {
					if keep == Keep::Old { break; }
					return Ok(None);
				}
				let end = char_end(source, at);
				word.extend_from_slice(&source.bytes[at..end]);
				at = end;
			} else if let Some(end) = delimiter.at(interp, source, at)? {
				if end == at { return Ok(None); }
				delim = Some((at, end));
				at = end;
				break;
			} else {
				let end = char_end(source, at);
				word.extend_from_slice(&source.bytes[at..end]);
				at = end;
			}
		}
		words.push(Value::Str(PStr::new(word, source.utf8)));
		if let Some((start, end)) = delim {
			if keep == Keep::Delimiters { words.push(Value::Str(PStr::new(source.bytes[start..end].to_vec(), source.utf8))); }
			if end == source.bytes.len() { words.push(Value::Undef); }
		}
	}
	Ok(Some(words))
}

fn parse_line(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let delimiter = Delimiter::new(interp, arg(&args, 0))?;
	let s = interp.stringify(&arg(&args, 2))?;
	Ok(parse_words(interp, &s, 0, &delimiter, Keep::new(arg(&args, 1)))?.map_or_else(Ret::empty, |v| list(v, cx)))
}

fn quote_lines(interp: &mut Interp<'_>, args: &[Sv], cx: Cx, nested: bool) -> PResult<Ret> {
	let delimiter = Delimiter::new(interp, arg(args, 0))?;
	let keep = Keep::new(arg(args, 1));
	let mut out = Vec::new();
	for sv in args.iter().skip(2) {
		let v = interp.read_sv(sv)?;
		let s = interp.stringify(&v)?;
		let Some(words) = parse_words(interp, &s, 0, &delimiter, keep)? else { return Ok(Ret::empty()); };
		if nested { out.push(Value::Ref(Ref::Array(new_av(words)))); }
		else { out.extend(words); }
	}
	Ok(list(out, cx))
}

fn quotewords(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { quote_lines(interp, &args, cx, false) }
fn nested_quotewords(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { quote_lines(interp, &args, cx, true) }

fn shell(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx, keep: Keep) -> PResult<Ret> {
	let re = Delimiter::Whitespace;
	let mut out = Vec::new();
	for sv in args {
		let v = interp.read_sv(&sv)?;
		let s = interp.stringify(&v)?;
		let mut start = 0;
		while start < s.bytes.len() && space_at(&s, start) { start = char_end(&s, start); }
		let Some(mut words) = parse_words(interp, &s, start, &re, keep)? else { return Ok(Ret::empty()); };
		if words.last().is_some_and(Value::is_undef) { words.pop(); }
		out.extend(words);
	}
	Ok(list(out, cx))
}

fn shellwords(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { shell(interp, args, cx, Keep::Content) }
fn old_shellwords(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { shell(interp, args, cx, Keep::Old) }

const ANSI_BASIC: &[(&str, u8)] = &[
	("CLEAR", 0), ("RESET", 0), ("BOLD", 1), ("DARK", 2), ("FAINT", 2), ("ITALIC", 3),
	("UNDERLINE", 4), ("UNDERSCORE", 4), ("BLINK", 5), ("REVERSE", 7), ("CONCEALED", 8),
];
const ANSI_HUES: [&str; 8] = ["BLACK", "RED", "GREEN", "YELLOW", "BLUE", "MAGENTA", "CYAN", "WHITE"];
const ANSI_RESET: &[u8] = b"\x1b[0m";
const ANSI_STACK: &str = "Term::ANSIColor::_color_stack";
const ANSI_ALIASES: &str = "Term::ANSIColor::_color_aliases";

fn load_ansi(interp: &mut Interp<'_>, module: &str) {
	version(interp, module, "5.01");
	let funcs = ["uncolor", "colorstrip", "colorvalid", "coloralias"];
	define(interp, module, &[("color", color), ("colored", colored), ("uncolor", uncolor),
		("colorstrip", colorstrip), ("colorvalid", colorvalid), ("coloralias", coloralias),
		("PUSHCOLOR", pushcolor), ("POPCOLOR", popcolor), ("LOCALCOLOR", localcolor)]);
	let mut basic: Vec<String> = ANSI_BASIC.iter().map(|(name, _)| (*name).to_owned()).collect();
	for prefix in ["", "ON_", "BRIGHT_", "ON_BRIGHT_"] {
		basic.extend(ANSI_HUES.iter().map(|name| format!("{prefix}{name}")));
	}
	let mut extended = Vec::with_capacity(992);
	for (prefix, len) in [("ANSI", 256), ("GREY", 24), ("RGB", 216)] {
		for i in 0..len {
			let n = if prefix == "RGB" { (i / 36) * 100 + ((i / 6) % 6) * 10 + i % 6 } else { i };
			let suffix = if prefix == "RGB" { format!("{prefix}{n:03}") } else { format!("{prefix}{n}") };
			let on = format!("ON_{suffix}");
			extended.push(suffix);
			extended.push(on);
		}
	}
	for name in basic.iter().chain(&extended) { interp.define_native(&format!("{module}::{name}"), ansi_constant); }
	let constants: Vec<&str> = basic.iter().map(String::as_str).collect();
	let constants256: Vec<&str> = extended.iter().map(String::as_str).collect();
	let mut pushpop = constants.clone();
	pushpop.extend(["PUSHCOLOR", "POPCOLOR", "LOCALCOLOR"]);
	let optional: Vec<_> = funcs.into_iter().chain(pushpop.iter().copied()).chain(constants256.iter().copied()).collect();
	export(interp, module, &["color", "colored"], &optional);
	export_tag(interp, module, "constants", &constants);
	export_tag(interp, module, "constants256", &constants256);
	export_tag(interp, module, "pushpop", &pushpop);
	let env = interp.hv("main::ENV");
	let specs = env.entries().get(&HKey::new(&PStr::from_bytes(b"ANSI_COLORS_ALIASES"))).map(|s| s.get().to_pstr());
	if let Some(specs) = specs {
		let aliases = interp.hv(ANSI_ALIASES);
		for spec in specs.to_string_lossy().split(',') {
			let Some((name, target)) = spec.split_once('=') else { continue; };
			if let Err(e) = set_alias(&aliases, name, target) { interp.warn(format!("{e} in \"{spec}\"")); }
		}
	}
}

#[derive(Clone, Copy)]
enum Attr { Basic(u8), Indexed(bool, u8) }

fn ansi_attr(name: &str) -> Option<Attr> {
	if let Some((_, n)) = ANSI_BASIC.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)) { return Some(Attr::Basic(*n)); }
	let name = name.as_bytes();
	let strip = |s: &[u8], p: &[u8]| s.get(..p.len()).is_some_and(|h| h.eq_ignore_ascii_case(p));
	let (on, name) = if strip(name, b"on_") { (true, &name[3..]) } else { (false, name) };
	let parse = |s: &[u8]| {
		if !s.iter().all(u8::is_ascii_digit) || (s.len() > 1 && s[0] == b'0') { return None; }
		std::str::from_utf8(s).ok()?.parse::<u8>().ok()
	};
	if strip(name, b"ansi") { return parse(&name[4..]).map(|n| Attr::Indexed(on, n)); }
	if strip(name, b"grey") { return parse(&name[4..]).filter(|&n| n < 24).map(|n| Attr::Indexed(on, 232 + n)); }
	if strip(name, b"rgb") {
		if let [r @ b'0'..=b'5', g @ b'0'..=b'5', b @ b'0'..=b'5'] = name[3..] {
			return Some(Attr::Indexed(on, 16 + 36 * (r - b'0') + 6 * (g - b'0') + (b - b'0')));
		}
		return None;
	}
	let (bright, name) = if strip(name, b"bright_") { (true, &name[7..]) } else { (false, name) };
	let hue = ANSI_HUES.iter().position(|h| h.as_bytes().eq_ignore_ascii_case(name))? as u8;
	Some(Attr::Basic(30 + u8::from(on) * 10 + u8::from(bright) * 60 + hue))
}

fn sgr_component(out: &mut String, attr: Attr) {
	use std::fmt::Write;
	if out.is_empty() { out.push_str("\x1b["); } else { out.push(';'); }
	match attr {
		Attr::Basic(n) => { let _ = write!(out, "{n}"); },
		Attr::Indexed(on, n) => { let _ = write!(out, "{};5;{n}", if on { 48 } else { 38 }); },
	}
}

fn disabled(interp: &mut Interp<'_>) -> bool {
	let env = interp.hv("main::ENV");
	let env = env.entries();
	env.contains_key(&HKey::new(&PStr::from_bytes(b"NO_COLOR")))
		|| env.get(&HKey::new(&PStr::from_bytes(b"ANSI_COLORS_DISABLED"))).is_some_and(|s| s.get().truthy())
}

fn sgr(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<Option<PStr>> {
	let aliases = interp.hv(ANSI_ALIASES);
	let mut out = String::new();
	for sv in args {
		let value = interp.read_sv(sv)?;
		let pstr = interp.stringify(&value)?;
		for name in pstr.to_string_lossy().split_whitespace() {
			if let Some(attr) = ansi_attr(name) { sgr_component(&mut out, attr); continue; }
			let name = name.to_ascii_lowercase();
			if let Some(alias) = aliases.entries().get(&HKey::new(&PStr::from_str(&name))) {
				for attr in alias.get().to_pstr().to_string_lossy().split_whitespace().filter_map(ansi_attr) { sgr_component(&mut out, attr); }
			} else { return Err(interp.die_msg(format!("Invalid attribute name {name}"))); }
		}
	}
	Ok(if out.is_empty() { None } else { out.push('m'); Some(PStr::new(out.into_bytes(), false)) })
}

fn color(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(if disabled(interp) { Value::str("") } else { sgr(interp, &args)?.map_or(Value::Undef, Value::Str) }))
}

fn colored(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let owned_attrs;
	let (content, colors): (PStr, &[Sv]) = if let Value::Ref(Ref::Array(colors)) = arg(&args, 0) {
		let content = join_args(interp, &args[1..], b"")?;
		owned_attrs = colors.elems().clone();
		(content, &owned_attrs)
	} else { (interp.stringify(&arg(&args, 0))?, args.get(1..).unwrap_or_default()) };
	if disabled(interp) { return Ok(Ret::One(Value::Str(content))); }
	let start = sgr(interp, colors)?.unwrap_or_default();
	let each = variable(interp, "Term::ANSIColor::EACHLINE")?;
	let mut out = PStr::default();
	if each.is_undef() {
		out = start;
		out.push(&content);
		out.push_bytes(ANSI_RESET);
	} else {
		let mut each = each.to_pstr();
		let mut content = content;
		if each.utf8 || content.utf8 { each.upgrade(); content.upgrade(); }
		let mut pos = 0;
		if each.is_empty() {
			while pos < content.bytes.len() {
				let end = char_end(&content, pos);
				colored_line(&mut out, &start, &content.bytes[pos..end], content.utf8);
				pos = end;
			}
		} else {
			while let Some(found) = content.bytes[pos..].windows(each.bytes.len()).position(|s| s == each.bytes) {
				let end = pos + found;
				colored_line(&mut out, &start, &content.bytes[pos..end], content.utf8);
				out.push(&each);
				pos = end + each.bytes.len();
			}
			colored_line(&mut out, &start, &content.bytes[pos..], content.utf8);
		}
	}
	Ok(Ret::One(Value::Str(out)))
}

fn colored_line(out: &mut PStr, start: &PStr, line: &[u8], utf8: bool) {
	if !line.is_empty() {
		out.push(start);
		append_segment(out, line, utf8);
		out.push_bytes(ANSI_RESET);
	}
}

fn uncolor(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut names = Vec::new();
	for sv in args {
		let value = interp.read_sv(&sv)?;
		let s = interp.stringify(&value)?;
		let rendered = s.to_string_lossy();
		let seq = rendered.strip_prefix("\x1b[").unwrap_or(&rendered);
		let seq = seq.strip_suffix('m').unwrap_or(seq);
		if seq.is_empty() { continue; }
		if seq.starts_with(';') || seq.contains(";;") {
			return Err(interp.die_msg(format!("Bad escape sequence {seq}")));
		}
		let mut codes = seq.split_terminator(';');
		while let Some(component) = codes.next() {
			let n = component.parse::<u16>().map_err(|_| interp.die_msg(format!("Bad escape sequence {seq}")))?;
			let name = match n {
				38 | 48 => {
					let idx = codes.next().filter(|&s| s == "5").and_then(|_| codes.next()).and_then(|s| s.parse::<u8>().ok());
					let idx = idx.ok_or_else(|| interp.die_msg(format!("No name for escape sequence {n}")))?;
					let prefix = if n == 48 { "on_" } else { "" };
					match idx {
						0..=15 => format!("{prefix}ansi{idx}"),
						16..=231 => { let d = idx - 16; format!("{prefix}rgb{}{}{}", d / 36, d / 6 % 6, d % 6) },
						232..=255 => format!("{prefix}grey{}", idx - 232),
					}
				},
				30..=37 | 40..=47 | 90..=97 | 100..=107 => {
					let (prefix, off) = match n { 30..=37 => ("", 30), 40..=47 => ("on_", 40), 90..=97 => ("bright_", 90), _ => ("on_bright_", 100) };
					format!("{prefix}{}", ANSI_HUES[(n - off) as usize].to_ascii_lowercase())
				},
				_ => ANSI_BASIC.iter().find(|(_, code)| u16::from(*code) == n).map(|(name, _)| name.to_ascii_lowercase())
					.ok_or_else(|| interp.die_msg(format!("No name for escape sequence {n}")))?,
			};
			names.push(Value::Str(PStr::new(name.into_bytes(), false)));
		}
	}
	Ok(list(names, cx))
}

fn strip_sgr(mut input: PStr) -> PStr {
	let mut pos = 0;
	let mut written = 0;
	while pos < input.bytes.len() {
		if input.bytes[pos..].starts_with(b"\x1b[") {
			let mut end = pos + 2;
			while input.bytes.get(end).is_some_and(|b| b.is_ascii_digit() || *b == b';') { end += 1; }
			if input.bytes.get(end) == Some(&b'm') { pos = end + 1; continue; }
		}
		input.bytes[written] = input.bytes[pos];
		written += 1;
		pos += 1;
	}
	input.bytes.truncate(written);
	input
}

fn colorstrip(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut joined = PStr::default();
	let mut strings = Vec::new();
	for sv in args {
		let value = interp.read_sv(&sv)?;
		let s = strip_sgr(interp.stringify(&value)?);
		if cx == Cx::List { strings.push(Value::Str(s)); } else { joined.push(&s); }
	}
	Ok(if cx == Cx::List { Ret::Many(strings) } else { Ret::One(Value::Str(joined)) })
}

fn colorvalid(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let aliases = interp.hv(ANSI_ALIASES);
	for sv in args {
		let value = interp.read_sv(&sv)?;
		let pstr = interp.stringify(&value)?;
		for name in pstr.to_string_lossy().split_whitespace() {
			if (name.bytes().any(|b| b.is_ascii_uppercase()) || ansi_attr(name).is_none())
				&& !aliases.entries().contains_key(&HKey::new(&PStr::from_str(name))) { return Ok(Ret::One(Value::Undef)); }
		}
	}
	Ok(boolean(true))
}

fn coloralias(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = text(&args, 0);
	let aliases = interp.hv(ANSI_ALIASES);
	if args.len() < 2 {
		let key = HKey::new(&PStr::from_str(&name.to_ascii_lowercase()));
		return Ok(Ret::One(aliases.entries().get(&key).map_or(Value::Undef, |v| v.get())));
	}
	set_alias(&aliases, &name, &text(&args, 1)).map(Ret::One).map_err(|e| interp.die_msg(e))
}

fn set_alias(aliases: &Hv, name: &str, spec: &str) -> Result<Value, String> {
	if name.is_empty() || name.chars().any(char::is_whitespace) { return Err(format!("Invalid alias name \"{name}\"")); }
	if ansi_attr(name).is_some() { return Err(format!("Cannot alias standard color \"{name}\"")); }
	let mut expansion = PStr::default();
	for target in spec.split_whitespace() {
		if !target.bytes().any(|b| b.is_ascii_uppercase()) && ansi_attr(target).is_some() {
			if !expansion.is_empty() { expansion.push_bytes(b" "); }
			expansion.push_bytes(target.as_bytes());
		} else {
			let target_key = HKey::new(&PStr::from_str(target));
			let map = aliases.entries();
			let existing = map.get(&target_key).ok_or_else(|| format!("Invalid attribute name \"{target}\""))?;
			if let Value::Str(value) = existing.get() && !value.is_empty() {
				if !expansion.is_empty() { expansion.push_bytes(b" "); }
				expansion.push(&value);
			}
		}
	}
	let result = Value::Str(expansion);
	let key = HKey::new(&PStr::from_str(&name.to_ascii_lowercase()));
	aliases.entries_mut().insert(key, new_sv(result.clone()));
	Ok(result)
}

fn ansi_constant(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if disabled(interp) { return Ok(Ret::One(Value::Str(join_args(interp, &args, b"")?))); }
	let qualified = interp.current_sub_name();
	let name = qualified.as_deref().and_then(|s| s.rsplit("::").next()).unwrap_or_default();
	let attr = ansi_attr(name).ok_or_else(|| interp.die_msg(format!("Invalid attribute name {name}")))?;
	let mut start = String::new();
	sgr_component(&mut start, attr);
	start.push('m');
	let mut out = PStr::new(start.into_bytes(), false);
	out.push(&join_args(interp, &args, b"")?);
	if !args.is_empty() && variable(interp, "Term::ANSIColor::AUTORESET")?.truthy() { out.push_bytes(ANSI_RESET); }
	Ok(Ret::One(Value::Str(out)))
}

fn pushcolor(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let out = join_args(interp, &args, b"")?;
	if !disabled(interp) {
		let mut end = 0;
		while out.bytes[end..].starts_with(b"\x1b[") {
			let st = end + 2;
			let n = out.bytes[st..].iter().take_while(|b| b.is_ascii_digit() || **b == b';').count();
			if out.bytes.get(st + n) != Some(&b'm') { break; }
			end = st + n + 1;
		}
		if end != 0 { interp.av(ANSI_STACK).elems_mut().push(new_sv(Value::bytes(&out.bytes[..end]))); }
	}
	Ok(Ret::One(Value::Str(out)))
}

fn previous_color(stack: &[Sv]) -> PStr {
	stack.last().map_or_else(|| PStr::from_bytes(ANSI_RESET), |s| s.get().to_pstr())
}

fn popcolor(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut out = if disabled(interp) { PStr::default() } else {
		let stack = interp.av(ANSI_STACK);
		let mut entries = stack.elems_mut();
		entries.pop();
		previous_color(&entries)
	};
	out.push(&join_args(interp, &args, b"")?);
	Ok(Ret::One(Value::Str(out)))
}

fn localcolor(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut out = join_args(interp, &args, b"")?;
	if !disabled(interp) { out.push(&previous_color(&interp.av(ANSI_STACK).elems())); }
	Ok(Ret::One(Value::Str(out)))
}
