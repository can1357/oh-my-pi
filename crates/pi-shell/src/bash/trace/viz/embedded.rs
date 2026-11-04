//! Embedded-language inference and portable semantic tokens (never ANSI/HTML).
use super::model::{Layers, NodeKey, Segment};
fn basename(s: &str) -> &str {
	s.rsplit('/').next().unwrap_or(s)
}
pub fn argument_language(command: &str, args: &[String], index: usize) -> Option<&'static str> {
	let command = basename(command);
	let previous = index
		.checked_sub(1)
		.and_then(|i| args.get(i))
		.map(String::as_str);
	if command.starts_with("python") && previous == Some("-c") {
		return Some("py");
	}
	if matches!(command, "node" | "bun" | "deno") && matches!(previous, Some("-e" | "--eval")) {
		return Some("js");
	}
	if command == "gh" && matches!(previous, Some("--jq" | "-q")) {
		return Some("jq");
	}
	if command == "curl"
		&& matches!(previous, Some("-d" | "--data" | "--data-raw" | "--data-binary" | "--json"))
	{
		return Some("json");
	}
	if matches!(command, "docker" | "podman") && previous == Some("--format") {
		return Some("gotmpl");
	}
	if matches!(command, "sh" | "bash" | "zsh" | "dash") && previous == Some("-c") {
		return Some("bash");
	}
	if !matches!(command, "jq" | "awk" | "gawk" | "grep" | "egrep" | "rg") {
		return None;
	}
	let language = match command {
		"jq" => "jq",
		"awk" | "gawk" => "awk",
		_ => "regex",
	};
	let mut i = usize::from(args.first().is_some_and(|a| basename(a) == command));
	while i < args.len() {
		let arg = args[i].as_str();
		if matches!(arg, "--arg" | "--argjson") {
			i += 3;
			continue;
		}
		if matches!(arg, "-e" | "--regexp") && language == "regex" {
			return (index == i + 1).then_some(language);
		}
		if matches!(
			arg,
			"-F"
				| "-f"
				| "-m"
				| "-A"
				| "-B"
				| "-C"
				| "--file"
				| "--argfile"
				| "--slurpfile"
				| "--rawfile"
		) {
			i += if matches!(arg, "--argfile" | "--slurpfile" | "--rawfile") {
				3
			} else {
				2
			};
			continue;
		}
		if arg == "--" {
			i += 1;
			return (index == i).then_some(language);
		}
		if arg.starts_with('-') {
			i += 1;
			continue;
		}
		return (index == i).then_some(language);
	}
	None
}
pub fn heredoc_language(command: &str, args: &[String], delim: &str) -> &'static str {
	let c = basename(command);
	if c.starts_with("python") {
		return "py";
	}
	if matches!(c, "node" | "bun" | "deno") {
		return "js";
	}
	if c == "git" {
		return "commit";
	}
	if matches!(c, "sh" | "bash" | "zsh" | "dash") {
		return "bash";
	}
	if matches!(c, "psql" | "mysql" | "sqlite3") {
		return "sql";
	}
	for value in args {
		if let Some(ext) = value.rsplit('.').next() {
			match ext {
				"py" => return "py",
				"js" | "ts" => return "js",
				"json" => return "json",
				"toml" => return "toml",
				"sh" => return "bash",
				"sql" => return "sql",
				"yml" | "yaml" => return "yaml",
				_ => {},
			}
		}
	}
	match delim.to_ascii_uppercase().as_str() {
		"PY" | "PYTHON" => "py",
		"JS" | "JAVASCRIPT" | "TS" => "js",
		"JSON" => "json",
		"TOML" => "toml",
		"SH" | "BASH" | "SHELL" => "bash",
		"SQL" => "sql",
		"YAML" | "YML" => "yaml",
		"AWK" => "awk",
		"JQ" => "jq",
		"HTML" => "html",
		"CSS" => "css",
		_ => "text",
	}
}
fn keyword(language: &str, s: &str) -> bool {
	let words = match language {
		"py" => {
			"import from as for in if elif else while def return with break continue pass not and or \
			 is None True False lambda class try except finally raise yield async await"
		},
		"js" | "ts" => {
			"import from export const let var function return if else for of in new await async true \
			 false null undefined typeof class throw try catch"
		},
		"jq" => {
			"if then elif else end select map keys length join and or not as def reduce empty test \
			 split tostring tonumber"
		},
		"awk" => "BEGIN END print printf if else for while in int length split substr NR NF",
		"json" | "toml" | "yaml" => "true false null",
		"gotmpl" => "range end if else with json join printf define template block",
		"bash" | "sh" => {
			"if then elif else fi for in do done while until case esac function select local export \
			 return"
		},
		"sql" => {
			"select from where insert into values update set delete create table join on as and or \
			 not null true false group by order having limit union distinct"
		},
		_ => "",
	};
	words.split_ascii_whitespace().any(|w| {
		if language == "sql" {
			w.eq_ignore_ascii_case(s)
		} else {
			w == s
		}
	})
}
pub fn highlight(
	text: &str,
	language: &str,
	node: NodeKey,
	range: Option<[u32; 2]>,
	layers: Layers,
) -> Vec<Segment> {
	let mut result: Vec<Segment> = Vec::new();
	let mut i = 0;
	let b = text.as_bytes();
	while i < b.len() {
		let start = i;
		let mut style = "";
		let hash_comment =
			matches!(language, "py" | "toml" | "yaml" | "bash" | "sh" | "awk" | "commit");
		if (hash_comment && b[i] == b'#')
			|| (matches!(language, "js" | "ts" | "jsonc") && text[i..].starts_with("//"))
			|| (language == "sql" && text[i..].starts_with("--"))
		{
			while i < b.len() && b[i] != b'\n' {
				i += 1;
			}
			style = "comment";
		} else if matches!(language, "js" | "ts" | "css") && text[i..].starts_with("/*") {
			i += 2;
			while i < b.len() && !text[i..].starts_with("*/") {
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			if i < b.len() {
				i += 2;
			}
			style = "comment";
		} else if matches!(b[i], b'\'' | b'"' | b'`') && language != "regex" {
			let q = b[i];
			let triple = language == "py" && b.get(i + 1) == Some(&q) && b.get(i + 2) == Some(&q);
			i += if triple { 3 } else { 1 };
			while i < b.len() {
				if b[i] == b'\\' {
					i += 1;
					if i < b.len() {
						i += text[i..].chars().next().unwrap().len_utf8();
					}
					continue;
				}
				if b[i] == q && (!triple || (b.get(i + 1) == Some(&q) && b.get(i + 2) == Some(&q))) {
					i += if triple { 3 } else { 1 };
					break;
				}
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			style = if language == "json" && text[i..].trim_start().starts_with(':') {
				"key"
			} else {
				"str"
			};
		} else if language == "regex" && b[i] == b'\\' {
			i += 1;
			if i < b.len() {
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			style = "field";
		} else if language == "regex" && b[i] == b'[' {
			i += 1;
			while i < b.len() {
				if b[i] == b'\\' {
					i += 1;
					if i < b.len() {
						i += text[i..].chars().next().unwrap().len_utf8();
					}
					continue;
				}
				if b[i] == b']' {
					i += 1;
					break;
				}
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			style = "section";
		} else if b[i].is_ascii_digit() {
			i += 1;
			while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.' || b[i] == b'_') {
				i += 1;
			}
			style = "num";
		} else if b[i].is_ascii_alphabetic() || matches!(b[i], b'_' | b'$') {
			i += 1;
			while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'$')) {
				i += 1;
			}
			let word = &text[start..i];
			if keyword(language, word) {
				style = "kw";
			} else if text[i..].trim_start().starts_with('(') {
				style = "fn";
			} else if word.starts_with('$') {
				style = "var";
			} else if matches!(language, "toml" | "yaml")
				&& (text[i..].trim_start().starts_with('=') || text[i..].trim_start().starts_with(':'))
			{
				style = "key";
			}
		} else {
			let c = text[i..].chars().next().unwrap();
			i += c.len_utf8();
			if language == "regex" && "^$".contains(c) {
				style = "kw";
			} else if language == "regex" && "*+?{}".contains(c) {
				style = "num";
			} else if "{}[]()|=+*/<>!:,;.".contains(c) {
				style = "op";
			}
			if c == '.' && matches!(language, "jq" | "gotmpl") {
				while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
					i += 1;
				}
				style = "field";
			}
		}
		let style = if layers.color && !style.is_empty() {
			Some(style.to_owned())
		} else {
			None
		};
		if let Some(last) = result.last_mut()
			&& last.style == style
		{
			last.text.push_str(&text[start..i]);
			continue;
		}
		result.push(Segment {
			text: text[start..i].to_owned(),
			style,
			node: Some(node),
			range,
			language: Some(language.to_owned()),
			..Segment::default()
		});
	}
	result
}
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn option_operands_are_not_programs() {
		let a = ["jq", "--arg", "name", "value", ".name"].map(str::to_owned);
		assert_eq!(argument_language("jq", &a, 3), None);
		assert_eq!(argument_language("jq", &a, 4), Some("jq"));
	}
	#[test]
	fn tokenization_preserves_unicode_and_rows() {
		let t = "print('λ')\n# comment\n";
		let s = highlight(
			t,
			"py",
			NodeKey::engine(0, crate::bash::syntax::NodeId::default()),
			None,
			Layers::default(),
		);
		assert_eq!(s.iter().map(|s| s.text.as_str()).collect::<String>(), t);
		assert!(s.iter().any(|s| s.style.as_deref() == Some("comment")));
	}
}
