//! Data-driven goldens produced by /opt/homebrew/bin/bash 5.3.20:
//! `declare -f` layout, syntax-error reports, and alias expansion.
//!
//! The data files hold records separated by `\x1e`, fields by `\x1f`
//! (`tests/data/*.txt`).

use std::collections::HashMap;

use crate::bash::syntax::*;

fn records(data: &str) -> impl Iterator<Item = Vec<&str>> {
	data
		.split('\x1e')
		.filter(|r| !r.is_empty())
		.map(|r| r.split('\x1f').collect())
}

fn wrap(snippet: &str) -> String {
	format!("f(){{ {snippet}\n}}")
}

fn declare_f(src: &[u8], aliases: &dyn AliasLookup) -> Result<String, String> {
	let mut p = Parser::new(src, Features::NONE, aliases);
	let mut out = Vec::new();
	while let Some(res) = p.next_command() {
		let cc = res.map_err(|e| String::from_utf8_lossy(&e.bash_msg()).into_owned())?;
		out.extend(print_list(cc.list(), PrintStyle::DeclareF));
	}
	Ok(String::from_utf8_lossy(&out).into_owned())
}

#[test]
fn declare_f_matches_bash_byte_for_byte() {
	let mut failures = Vec::new();
	let mut n = 0;
	for rec in records(include_str!("data/declare_f.txt")) {
		n += 1;
		let (snippet, want) = (rec[0], rec[1]);
		match declare_f(wrap(snippet).as_bytes(), &NoAliases) {
			Ok(got) if got == want => {},
			Ok(got) => failures.push(format!("{snippet:?}\n--- bash\n{want}\n--- ours\n{got}")),
			Err(e) => failures.push(format!("{snippet:?}: parse error {e}")),
		}
	}
	assert!(n > 100, "the golden file is loaded");
	assert!(failures.is_empty(), "{} of {n} differ:\n\n{}", failures.len(), failures.join("\n\n"));
}

#[test]
fn printed_functions_reparse_to_the_same_text() {
	let mut failures = Vec::new();
	for rec in records(include_str!("data/declare_f.txt")) {
		let Ok(once) = declare_f(wrap(rec[0]).as_bytes(), &NoAliases) else {
			continue;
		};
		match declare_f(once.as_bytes(), &NoAliases) {
			Ok(twice) if twice == once => {},
			Ok(twice) => failures.push(format!("{once}\n--- reprinted\n{twice}")),
			Err(e) => failures.push(format!("{once}\n--- does not reparse: {e}")),
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// The source line holding byte `at`, as bash echoes it.
fn line_at(src: &[u8], at: usize) -> String {
	let at = at.min(src.len());
	let at = if at > 0 && at == src.len() {
		at - 1
	} else {
		at
	};
	let start = src[..at]
		.iter()
		.rposition(|&c| c == b'\n')
		.map_or(0, |i| i + 1);
	let end = src[at..]
		.iter()
		.position(|&c| c == b'\n')
		.map_or(src.len(), |i| at + i);
	String::from_utf8_lossy(&src[start..end]).into_owned()
}

fn report(src: &[u8], e: &ParseError) -> String {
	let mut lines = Vec::new();
	if let Some(d) = e.detail() {
		lines.push(format!("-c: line {}: {}", d.line, String::from_utf8_lossy(&d.bash_msg)));
	}
	lines.push(format!("-c: line {}: {}", e.line, String::from_utf8_lossy(&e.bash_msg())));
	if e.echoes_line() {
		lines.push(format!("-c: line {}: `{}'", e.line, line_at(src, e.span.lo as usize)));
	}
	lines.join("\n")
}

#[test]
fn syntax_error_reports_match_bash() {
	let mut failures = Vec::new();
	let mut n = 0;
	for rec in records(include_str!("data/errors.txt")) {
		n += 1;
		let (src, want) = (rec[0], rec[1]);
		match parse_all(src.as_bytes(), Features::NONE) {
			Ok(_) => failures.push(format!("{src:?}: accepted, bash says\n{want}")),
			Err(e) => {
				let got = report(src.as_bytes(), &e);
				if got != want {
					failures.push(format!("{src:?}\n--- bash\n{want}\n--- ours\n{got}"));
				}
			},
		}
	}
	assert!(n > 50, "the golden file is loaded");
	assert!(failures.is_empty(), "{} of {n} differ:\n\n{}", failures.len(), failures.join("\n\n"));
}

/// An alias table for tests.
struct Table(HashMap<Vec<u8>, Vec<u8>>);

impl AliasLookup for Table {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		self.0.get(name).map(Vec::as_slice)
	}
}

impl Table {
	fn from_defs(defs: &str) -> Self {
		Self(
			defs
				.split('|')
				.map(|d| {
					let (n, v) = d.split_once('=').expect("name=value");
					(n.as_bytes().to_vec(), v.as_bytes().to_vec())
				})
				.collect(),
		)
	}
}

#[test]
fn alias_expansion_matches_bash() {
	let mut failures = Vec::new();
	for rec in records(include_str!("data/aliases.txt")) {
		let (defs, body, want) = (rec[0], rec[1], rec[2]);
		let table = Table::from_defs(defs);
		match declare_f(wrap(body).as_bytes(), &table) {
			Ok(got) if got == want => {},
			Ok(got) => failures.push(format!("{defs:?} {body:?}\n--- bash\n{want}\n--- ours\n{got}")),
			Err(e) => failures.push(format!("{defs:?} {body:?}: parse error {e}")),
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn recorded_alias_uses_reproduce_the_tree_and_ids() {
	for rec in records(include_str!("data/aliases.txt")) {
		let (defs, body) = (rec[0], rec[1]);
		let table = Table::from_defs(defs);
		let src = wrap(body);
		let mut p = Parser::new(src.as_bytes(), Features::NONE, &table);
		let Some(Ok(first)) = p.next_command() else {
			continue;
		};
		// Replay only the recorded substitutions.
		let replay = Table(
			first
				.aliases
				.iter()
				.map(|a| (a.name.clone(), a.value.clone()))
				.collect(),
		);
		let mut q = Parser::new(src.as_bytes(), Features::NONE, &replay);
		let again = q.next_command().expect("a command").expect("parses");
		assert_eq!(again.node_count, first.node_count, "{body:?}");
		assert_eq!(
			print_list(again.list(), PrintStyle::Compact),
			print_list(first.list(), PrintStyle::Compact),
			"{body:?}"
		);
	}
}

#[test]
fn unit_bytes_reparse_to_the_same_node_count() {
	for rec in records(include_str!("data/declare_f.txt")) {
		let src = wrap(rec[0]);
		let prog = parse_all(src.as_bytes(), Features::NONE).expect("parses");
		for cc in &prog.commands {
			let again =
				parse_all(cc.span.slice(src.as_bytes()), Features::NONE).expect("unit reparses");
			assert_eq!(again.commands.len(), 1, "{:?}", rec[0]);
			assert_eq!(again.commands[0].node_count, cc.node_count, "{:?}", rec[0]);
		}
	}
}
