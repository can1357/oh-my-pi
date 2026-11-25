//! The `.env` format as direnv reads it (`direnv dotenv`, the stdlib's
//! `dotenv`): `KEY=VALUE` and `KEY: VALUE` lines, an optional `export`,
//! `#` comments, single quotes that keep a value literal, double quotes that
//! take `\n` and `\r` escapes, values that span lines inside quotes, and
//! `$VAR` / `${VAR}` / `${VAR:-default}` references to earlier keys or the
//! environment. Ported from direnv 2.38.2 (`pkg/dotenv/parse.go`).

use std::collections::BTreeMap;

/// The whitespace permitted around a dotenv assignment.
fn dotenv_space(c: char) -> bool {
	matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' ')
}

/// A byte permitted in a dotenv key.
fn key_byte(b: u8) -> bool {
	b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.')
}

/// Parses `[export] KEY=VALUE`, a comment or an empty line; `None` is invalid syntax.
fn parse_line(line: &str) -> Option<Option<(&str, &str)>> {
	let line = line.trim_start_matches(dotenv_space);
	if line.is_empty() || line.starts_with('#') && !line.contains('\n') {
		return Some(None);
	}
	let line = if let Some(after_export) = line.strip_prefix("export") {
		let key = after_export.trim_start_matches(dotenv_space);
		if key.len() < after_export.len() && key.as_bytes().first().copied().is_some_and(key_byte) {
			key
		} else {
			line
		}
	} else {
		line
	};
	let end = line.bytes().take_while(|&b| key_byte(b)).count();
	if end == 0 {
		return None;
	}
	let (key, rest) = line.split_at(end);
	let value = if let Some(value) = rest.strip_prefix(':') {
		let trimmed = value.trim_start_matches(dotenv_space);
		if trimmed.len() == value.len() {
			return None;
		}
		trimmed
	} else {
		rest.trim_start_matches(dotenv_space).strip_prefix('=')?.trim_start_matches(dotenv_space)
	};
	if let Some(&quote @ (b'\'' | b'"')) = value.as_bytes().first() {
		let mut last_line_len = None;
		for close in memchr::memrchr_iter(quote, &value.as_bytes()[1..]) {
			let end = close + 2;
			let tail = value[end..].trim_start_matches(dotenv_space);
			if tail.is_empty()
				|| tail.starts_with('#')
					&& tail.len() <= *last_line_len.get_or_insert_with(|| {
						value.rsplit_once('\n').map_or(value.len(), |(_, line)| line.len())
					})
			{
				return Some(Some((key, &value[..end])));
			}
		}
	}
	let end = value.bytes().take_while(|b| !matches!(b, b'\t'..=b'\n' | b'\x0c' | b'\r' | b' ' | b'#')).count();
	let tail = value[end..].trim_start_matches(dotenv_space);
	(tail.is_empty() || tail.starts_with('#') && !tail.contains('\n')).then_some(Some((key, &value[..end])))
}

/// The variables `data` defines, each value expanded against the keys before
/// it and then `lookup` (the environment).
///
/// # Errors
///
/// direnv's message for a line that is no assignment, or a quoted value that
/// never closes.
pub(super) fn parse<'a>(
	data: &str,
	lookup: &dyn Fn(&str) -> Option<&'a str>,
) -> Result<BTreeMap<String, String>, String> {
	let mut vars = BTreeMap::new();
	// A quoted value still open: the lines read so far and its quote.
	let mut open: Option<(String, char)> = None;
	// Runs of line breaks separate lines, so a value never holds a blank one.
	for line in data.split(['\r', '\n']).filter(|line| !line.is_empty()) {
		if let Some((value, quote)) = &mut open {
			value.push('\n');
			value.push_str(line);
			if line.trim().ends_with(*quote) {
				if let Some(Some((key, raw))) = parse_line(value) {
					let value = unquote(raw, &vars, lookup);
					vars.insert(key.to_owned(), value);
				}
				open = None;
			}
			continue;
		}
		if !line.trim_start_matches([' ', '\t']).starts_with('#')
			&& let Some(separator) = line.find(['=', ':']).filter(|&at| at > 0)
		{
			let value = line[separator + 1..].trim_start_matches([' ', '\t']);
			if let Some(quote @ ('"' | '\'')) = value.chars().next()
				&& unclosed(value, quote)
			{
				open = Some((line.to_owned(), quote));
				continue;
			}
		}
		let Some(assignment) = parse_line(line) else {
			return Err(format!("invalid line: {line}"));
		};
		if let Some((key, raw)) = assignment {
			let value = unquote(raw, &vars, lookup);
			vars.insert(key.to_owned(), value);
		}
	}
	if open.is_some() {
		return Err("unclosed quoted value in .env file".to_owned());
	}
	Ok(vars)
}

/// Whether `value`, which starts with `quote`, has no unescaped closing one.
fn unclosed(value: &str, quote: char) -> bool {
	let mut chars = value.chars().skip(1).peekable();
	while let Some(c) = chars.next() {
		if c == '\\' {
			chars.next_if_eq(&quote);
		} else if c == quote {
			return false;
		}
	}
	true
}

/// The value `raw` spells: quotes dropped, escapes and references resolved.
fn unquote<'a>(
	raw: &str,
	vars: &BTreeMap<String, String>,
	lookup: &dyn Fn(&str) -> Option<&'a str>,
) -> String {
	let inside = |quote: char| {
		raw.strip_prefix(quote)
			.and_then(|rest| rest.strip_suffix(quote))
			.filter(|_| raw.len() > 1)
	};
	if let Some(literal) = inside('\'') {
		return literal.to_owned();
	}
	let Some(quoted) = inside('"') else {
		return expand(raw, vars, lookup);
	};
	let quoted = quoted.replace("\\n", "\n").replace("\\r", "\r");
	// A backslash escapes the character after it; `\$` waits for `expand`.
	let mut value = String::with_capacity(quoted.len());
	let mut chars = quoted.chars().peekable();
	while let Some(c) = chars.next() {
		match chars.peek() {
			Some(&next) if c == '\\' && next != '$' => {
				value.push(next);
				chars.next();
			},
			_ => value.push(c),
		}
	}
	expand(&value, vars, lookup)
}

/// `value` with every `$NAME` and `${NAME}` replaced, `\$` a literal dollar.
fn expand<'a>(
	value: &str,
	vars: &BTreeMap<String, String>,
	lookup: &dyn Fn(&str) -> Option<&'a str>,
) -> String {
	let mut out = String::with_capacity(value.len());
	let mut pieces = value.split("\\$");
	if let Some(first) = pieces.next() {
		expand_references(&mut out, first, vars, lookup);
	}
	for piece in pieces {
		out.push('$');
		expand_references(&mut out, piece, vars, lookup);
	}
	out
}

/// Go's `os.Expand` over `text`, appended to `out`: a `$` before a name, a
/// shell special parameter or `{…}` is a reference; malformed braces are
/// dropped; any other `$` stays.
fn expand_references<'a>(
	out: &mut String,
	text: &str,
	vars: &BTreeMap<String, String>,
	lookup: &dyn Fn(&str) -> Option<&'a str>,
) {
	let bytes = text.as_bytes();
	let mut copied = 0;
	let mut at = 0;
	while at < bytes.len() {
		if bytes[at] != b'$' || at + 1 == bytes.len() {
			at += 1;
			continue;
		}
		out.push_str(&text[copied..at]);
		let rest = &text[at + 1..];
		let (name, width) = reference(rest);
		if !name.is_empty() {
			let (key, default) = match name.split_once(":-") {
				Some((key, default)) => (key, Some(default)),
				None => (name, None),
			};
			match vars.get(key) {
				Some(value) => out.push_str(value),
				None => match (lookup(key).filter(|value| !value.is_empty()), default) {
					(Some(value), _) => out.push_str(value),
					(None, Some(default)) => out.push_str(default),
					(None, None) => {},
				},
			}
		} else if width == 0 {
			out.push('$');
		}
		at += 1 + width;
		copied = at;
	}
	out.push_str(&text[copied..]);
}

/// The reference at the start of `rest` (the text after a `$`) and the bytes
/// it spans; an empty name with a width is malformed syntax to drop.
fn reference(rest: &str) -> (&str, usize) {
	let bytes = rest.as_bytes();
	let special = |c: u8| matches!(c, b'*' | b'#' | b'$' | b'@' | b'!' | b'?' | b'-' | b'0'..=b'9');
	if bytes[0] == b'{' {
		if bytes.len() > 2 && special(bytes[1]) && bytes[2] == b'}' {
			return (&rest[1..2], 3);
		}
		return match rest.find('}') {
			Some(1) => ("", 2),
			Some(close) => (&rest[1..close], close + 1),
			None => ("", 1),
		};
	}
	if special(bytes[0]) {
		return (&rest[..1], 1);
	}
	let end = bytes
		.iter()
		.position(|&c| !(c.is_ascii_alphanumeric() || c == b'_'))
		.unwrap_or(bytes.len());
	(&rest[..end], end)
}

#[cfg(test)]
mod tests {
	use super::parse;

	fn vars(data: &str) -> Vec<(String, String)> {
		let lookup = |name: &str| (name == "HOME").then_some("/home/me");
		parse(data, &lookup).expect("parse").into_iter().collect()
	}

	fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
		expected.iter().map(|&(key, value)| (key.to_owned(), value.to_owned())).collect()
	}

	/// Contract: the line forms a `.env` file may use all define variables.
	#[test]
	fn line_forms() {
		let data = "# comment\n\nA=1\nexport B = two # trailing\nC: three\nD=\nE.F='x # y'\r\nG=\"a b\"\n";
		assert_eq!(
			vars(data),
			pairs(&[("A", "1"), ("B", "two"), ("C", "three"), ("D", ""), ("E.F", "x # y"), ("G", "a b")])
		);
	}

	/// Contract: single quotes keep text literal; double quotes and bare
	/// values expand references, earlier keys winning over the environment,
	/// with `:-` defaults and `\$` for a literal dollar.
	#[test]
	fn quoting_and_references() {
		let data = concat!(
			"BASE=/srv\n",
			"A=$BASE/bin\n",
			"B=\"${BASE}/lib:$HOME\"\n",
			"C='$BASE'\n",
			"D=\"${MISSING:-fallback}|${MISSING}|\\$BASE\"\n",
			"E=\"tab\\there\\nnext\\\"q\\\"\"\n",
			"HOME=shadow\n",
			"F=$HOME\n",
		);
		assert_eq!(
			vars(data),
			pairs(&[
				("A", "/srv/bin"),
				("B", "/srv/lib:/home/me"),
				("BASE", "/srv"),
				("C", "$BASE"),
				("D", "fallback||$BASE"),
				("E", "tabthere\nnext\"q\""),
				("F", "shadow"),
				("HOME", "shadow"),
			])
		);
	}

	/// Contract: a quoted value runs across lines until its quote closes; one
	/// that never closes, and a line that is no assignment, are errors.
	#[test]
	fn multiline_values_and_malformed_input() {
		assert_eq!(
			vars("KEY=\"-----BEGIN\nabc\n-----END\"\nNEXT=1\n"),
			pairs(&[("KEY", "-----BEGIN\nabc\n-----END"), ("NEXT", "1")])
		);
		let none = |_: &str| None;
		assert_eq!(parse("A='open\nB=1\n", &none), Err("unclosed quoted value in .env file".to_owned()));
		assert_eq!(parse("not an assignment\n", &none), Err("invalid line: not an assignment".to_owned()));
	}
}
