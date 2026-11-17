//! Embedded-language inference and portable semantic tokens (never ANSI/HTML).
use std::path::Path;

use super::model::{Layers, NodeKey, Segment};

/// Shells whose `-c` operand, or stdin, is a shell script.
const SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "ksh"];

fn basename(s: &str) -> &str {
	s.rsplit('/').next().unwrap_or(s)
}

/// A short-option cluster that sets `flag` (`-euc` sets `c`).
fn sets(word: &str, flag: char) -> bool {
	word
		.strip_prefix('-')
		.is_some_and(|flags| !flags.starts_with('-') && flags.contains(flag))
}

/// `NAME=VALUE`, as `env` and `sudo` take before the command they run.
fn assignment(word: &str) -> bool {
	word.split_once('=').is_some_and(|(name, _)| {
		name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
			&& name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
	})
}

/// Index of the first operand from `from` on, past the options; `takes_value`
/// names the options whose value is the next word.
fn operand(words: &[String], from: usize, takes_value: impl Fn(&str) -> bool) -> usize {
	let mut i = from;
	while let Some(word) = words.get(i) {
		if word == "--" {
			return i + 1;
		}
		if !word.starts_with('-') || word == "-" {
			break;
		}
		i += if takes_value(word) { 2 } else { 1 };
	}
	i
}

/// Words a launcher at the start of `words` takes before the command it runs
/// (`timeout 5 cmd` → 2), and whether that command runs on an `ssh` host.
fn launcher(words: &[String]) -> Option<(usize, bool)> {
	let skip = match basename(words.first()?) {
		"env" => {
			let at = operand(words, 1, |w| {
				matches!(w, "-u" | "--unset" | "-C" | "--chdir" | "-S" | "--split-string" | "-P")
			});
			at + words.iter().skip(at).take_while(|w| assignment(w)).count()
		},
		"sudo" | "doas" => {
			let at = operand(words, 1, |w| {
				matches!(
					w,
					"-u"
						| "-g"
						| "-C"
						| "-D"
						| "-h"
						| "-p"
						| "-R"
						| "-r"
						| "-T"
						| "-t"
						| "-U"
						| "--user"
						| "--group"
						| "--close-from"
						| "--chdir"
						| "--host"
						| "--prompt"
						| "--chroot"
						| "--role"
						| "--command-timeout"
						| "--type"
						| "--other-user"
				)
			});
			at + words.iter().skip(at).take_while(|w| assignment(w)).count()
		},
		// The first operand is the duration.
		"timeout" | "gtimeout" => {
			operand(words, 1, |w| matches!(w, "-s" | "--signal" | "-k" | "--kill-after")) + 1
		},
		"nice" => operand(words, 1, |w| matches!(w, "-n" | "--adjustment")),
		"nohup" | "time" => operand(words, 1, |w| matches!(w, "-o" | "--output" | "-f" | "--format")),
		"stdbuf" => {
			operand(words, 1, |w| matches!(w, "-i" | "-o" | "-e" | "--input" | "--output" | "--error"))
		},
		"exec" => operand(words, 1, |w| w == "-a"),
		"uv" if words.get(1).is_some_and(|w| w == "run") => operand(words, 2, |w| {
			matches!(
				w,
				"--with"
					| "--with-editable"
					| "--with-requirements"
					| "-p"
					| "--python"
					| "--package"
					| "--project"
					| "--directory"
					| "--env-file"
					| "--extra"
					| "--group"
					| "--only-group"
					| "--no-group"
					| "--index"
					| "--default-index"
					| "-i"
					| "--index-url"
					| "--extra-index-url"
					| "-f"
					| "--find-links"
					| "--config-file"
					| "--cache-dir"
			)
		}),
		"ssh" => {
			let host = operand(words, 1, |w| w.len() == 2 && "pilojFSLRDWbcEemOQw".contains(&w[1..]));
			return (host < words.len()).then_some((host + 1, true));
		},
		_ => return None,
	};
	Some((skip, false))
}

/// A command line past its launchers (`env`, `timeout`, `sudo`, `uv run`,
/// `ssh host`, …).
struct Launch {
	/// Index of the word naming the program; for `ssh`, of its first remote
	/// word, if any (none: the remote login shell runs stdin).
	at:     usize,
	/// The program runs on an `ssh` host.
	remote: bool,
}

fn launch(words: &[String]) -> Launch {
	let mut launch = Launch { at: 0, remote: false };
	while let Some((skip, remote)) = launcher(&words[launch.at..]) {
		launch.at = (launch.at + skip).min(words.len());
		launch.remote |= remote;
	}
	launch
}

/// The word holding a shell script the command line runs, and whether it runs
/// on an `ssh` host: `ssh host SCRIPT`, or a shell's `-c` operand anywhere in
/// the line (`docker run img sh -c SCRIPT`, `xargs sh -c SCRIPT`).
pub fn shell_script(words: &[String]) -> Option<(usize, bool)> {
	let launch = launch(words);
	if launch.remote && launch.at + 1 == words.len() {
		return Some((launch.at, true));
	}
	let at = words.iter().enumerate().find_map(|(i, word)| {
		if !SHELLS.contains(&basename(word)) {
			return None;
		}
		let flag = words[i + 1..]
			.iter()
			.take_while(|w| w.starts_with('-'))
			.position(|w| sets(w, 'c'))?;
		Some(i + flag + 2)
	})?;
	(at < words.len()).then_some((at, launch.remote))
}

/// Language of the program `words[index]` holds (`python -c CODE`,
/// `jq FILTER`, `sh -c SCRIPT`, `ssh host SCRIPT`), behind any launchers.
pub fn argument_language(words: &[String], index: usize) -> Option<&'static str> {
	if shell_script(words).is_some_and(|(at, _)| at == index) {
		return Some("bash");
	}
	let at = launch(words).at;
	let (args, index) = (&words[at..], index.checked_sub(at)?);
	let command = basename(args.first()?);
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
	if !matches!(command, "jq" | "awk" | "gawk" | "grep" | "egrep" | "rg") {
		return None;
	}
	let language = match command {
		"jq" => "jq",
		"awk" | "gawk" => "awk",
		_ => "regex",
	};
	let mut i = 1;
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

/// Language of a heredoc's body: what the program reading it runs it as
/// (`python3 - <<EOF`; `ssh host <<EOF` → the remote shell), else its `#!`
/// line, else a file the command names (`cat > lib.rs <<EOF`), else its
/// delimiter (`<<SQL`). `targets` are the command's output redirections.
pub fn heredoc_language(
	words: &[String],
	targets: &[String],
	delim: &str,
	body: &str,
) -> &'static str {
	stdin_language(words)
		.or_else(|| shebang(body))
		.or_else(|| words.iter().chain(targets).find_map(|w| extension(w)))
		.unwrap_or_else(|| delimiter(delim))
}

/// Language the command line's program reads its stdin as.
fn stdin_language(words: &[String]) -> Option<&'static str> {
	let launch = launch(words);
	match &words[launch.at..] {
		[] => launch.remote.then_some("bash"),
		// `ssh` joins its remote words into one command line (`'bash -s'`).
		[line] if launch.remote => stdin_language(
			&line
				.split_ascii_whitespace()
				.map(str::to_owned)
				.collect::<Vec<_>>(),
		),
		[program, ..] => interpreter(program),
	}
}

/// Language `program` runs a script or message in (`python3` → `py`, `git` →
/// `commit`).
fn interpreter(program: &str) -> Option<&'static str> {
	let name = basename(program);
	Some(match name {
		_ if name.starts_with("python") => "py",
		"node" | "bun" | "deno" => "js",
		"git" => "commit",
		"psql" | "mysql" | "sqlite3" | "duckdb" => "sql",
		_ if SHELLS.contains(&name) => "bash",
		_ => return None,
	})
}

/// Language a `#!` line names (`#!/usr/bin/env python3` → `py`).
fn shebang(body: &str) -> Option<&'static str> {
	let line = body.strip_prefix("#!")?.lines().next()?;
	let mut words = line.split_ascii_whitespace();
	let program = words.next()?;
	if basename(program) == "env" {
		return interpreter(words.find(|w| !w.starts_with('-') && !assignment(w))?);
	}
	interpreter(program)
}

/// Language of a file by its extension (`src/lib.rs` → `rust`).
fn extension(path: &str) -> Option<&'static str> {
	Some(match Path::new(path).extension()?.to_str()? {
		"py" | "pyi" => "py",
		"js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => "js",
		"json" => "json",
		"toml" => "toml",
		"sh" | "bash" | "zsh" => "bash",
		"sql" => "sql",
		"yml" | "yaml" => "yaml",
		"rs" => "rust",
		"go" => "go",
		"c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "cu" | "cuh" | "m" | "mm" => "c",
		"swift" => "swift",
		"css" => "css",
		"html" | "htm" => "html",
		_ => return None,
	})
}

/// Language a heredoc delimiter names (`<<SQL`).
fn delimiter(delim: &str) -> &'static str {
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
		"rust" => {
			"as async await break const continue crate dyn else enum extern false fn for if impl in \
			 let loop match mod move mut pub ref return self Self static struct super trait true type \
			 unsafe use where while"
		},
		"go" => {
			"break case chan const continue default defer else fallthrough for func go goto if import \
			 interface map package range return select struct switch type var nil true false"
		},
		"c" => {
			"auto break case char const continue default do double else enum extern float for goto if \
			 inline int long register return short signed sizeof static struct switch typedef union \
			 unsigned void volatile while bool true false NULL nullptr class namespace template \
			 typename public private protected virtual new delete this using"
		},
		"swift" => {
			"import func let var if else guard return struct class enum protocol extension for in \
			 while repeat switch case default break continue true false nil self Self init throws \
			 throw try catch async await public private internal fileprivate static override final \
			 mutating weak defer where is as"
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
/// Whether a Rust `'` followed by `rest` opens a lifetime (`'a`), not a char
/// literal (`'a'`, `'\n'`).
fn lifetime(rest: &str) -> bool {
	let mut chars = rest.chars();
	!matches!((chars.next(), chars.next()), (Some('\\'), _) | (Some(_), Some('\'')))
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
		let c_comments = matches!(language, "js" | "ts" | "rust" | "go" | "c" | "swift");
		if (hash_comment && b[i] == b'#')
			|| ((c_comments || language == "jsonc") && text[i..].starts_with("//"))
			|| (language == "sql" && text[i..].starts_with("--"))
		{
			while i < b.len() && b[i] != b'\n' {
				i += 1;
			}
			style = "comment";
		} else if (c_comments || language == "css") && text[i..].starts_with("/*") {
			i += 2;
			while i < b.len() && !text[i..].starts_with("*/") {
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			if i < b.len() {
				i += 2;
			}
			style = "comment";
		} else if matches!(b[i], b'\'' | b'"' | b'`')
			&& language != "regex"
			&& !(language == "rust" && lifetime(&text[i + 1..]))
		{
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
	fn owned(words: &[&str]) -> Vec<String> {
		words.iter().map(|w| (*w).to_owned()).collect()
	}
	fn heredoc(words: &[&str], target: &str, body: &str) -> &'static str {
		heredoc_language(&owned(words), &owned(&[target]), "EOF", body)
	}
	fn argument(words: &[&str], index: usize) -> Option<&'static str> {
		argument_language(&owned(words), index)
	}
	#[test]
	fn option_operands_are_not_programs() {
		let a = ["jq", "--arg", "name", "value", ".name"];
		assert_eq!(argument(&a, 3), None);
		assert_eq!(argument(&a, 4), Some("jq"));
	}
	#[test]
	fn heredocs_are_read_by_the_program_behind_launchers() {
		assert_eq!(heredoc(&["uv", "run", "--with", "numpy", "python", "-"], "", ""), "py");
		assert_eq!(heredoc(&["timeout", "-k", "5", "60", "python3", "-"], "", ""), "py");
		assert_eq!(heredoc(&["sudo", "-u", "root", "env", "A=1", "bash"], "", ""), "bash");
		// No remote command: the remote login shell reads the script.
		assert_eq!(heredoc(&["ssh", "-o", "BatchMode=yes", "host"], "", ""), "bash");
		assert_eq!(heredoc(&["ssh", "host", "sudo bash -s"], "", ""), "bash");
		assert_eq!(heredoc(&["ssh", "host", "python3", "-"], "", ""), "py");
		assert_eq!(heredoc(&["ssh", "host", "uptime"], "", ""), "text");
	}
	#[test]
	fn heredoc_without_a_reader_is_named_by_shebang_then_target() {
		assert_eq!(heredoc(&["cat"], "/tmp/run", "#!/usr/bin/env -S python3 -u\nimport os"), "py");
		assert_eq!(heredoc(&["cat"], "x.json", "#!/bin/sh\necho"), "bash");
		assert_eq!(heredoc(&["cat"], "/src/lib.rs", ""), "rust");
		// A bare word is no file extension.
		assert_eq!(heredoc(&["cat"], "py", ""), "text");
	}
	#[test]
	fn inline_programs_are_found_behind_launchers() {
		assert_eq!(argument(&["uv", "run", "python", "-c", "code"], 4), Some("py"));
		assert_eq!(argument(&["env", "-i", "A=1", "bun", "-e", "code"], 5), Some("js"));
		assert_eq!(argument(&["docker", "run", "--rm", "img", "bash", "-euc", "s"], 6), Some("bash"));
		assert_eq!(argument(&["ssh", "-p", "22", "host", "script"], 4), Some("bash"));
		assert_eq!(argument(&["ssh", "host", "ls", "-la"], 2), None);
		assert_eq!(shell_script(&owned(&["ssh", "host", "bash", "-c", "s"])), Some((4, true)));
		assert_eq!(shell_script(&owned(&["bash", "--rcfile", "x", "-c", "s"])), None);
	}
	#[test]
	fn rust_lifetimes_do_not_open_strings() {
		let s = highlight(
			"fn f<'a>(s: &'a str) -> char { 'x' }",
			"rust",
			NodeKey::engine(0, crate::bash::syntax::NodeId::default()),
			None,
			Layers::default(),
		);
		let strings: Vec<&str> = s
			.iter()
			.filter(|s| s.style.as_deref() == Some("str"))
			.map(|s| s.text.as_str())
			.collect();
		assert_eq!(strings, ["'x'"]);
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
