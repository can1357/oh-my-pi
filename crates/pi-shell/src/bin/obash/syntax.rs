//! `obash --print`, `--json` and `--parse-corpus`: the syntax crate on its
//! own (parse only, nothing is executed).

use std::{
	fs,
	io::{self, BufRead, Write},
	path::Path,
	time::Instant,
};

use pi_shell::{
	bash::syntax::{
		Features, JsonDialect, NO_ALIASES, Offsets, Parser, PrintStyle, Program, print_list, to_json,
	},
	process::pretty::{error_text, warning_lines},
};

/// JSON schema selected by `--json`.
#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Dialect {
	/// The syntax crate's own schema, with node ids.
	Native,
	/// The `shfmt --ln=bash --to-json` schema read by bash-viz.
	Shfmt,
}

/// `obash --print`: print every complete command in `declare -f` layout
/// (a function definition prints exactly as `declare -f NAME`); on a syntax
/// error, print bash's diagnostic on stderr and exit 2.
pub fn print(src: &[u8], argv0: &[u8], origin_is_command: bool) -> u8 {
	let mut out = io::stdout().lock();
	let mut parser = Parser::new(src, Features::NONE, NO_ALIASES);
	while let Some(res) = parser.next_command() {
		match res {
			Ok(cc) => {
				if !cc.warnings.is_empty() {
					let mut w = Vec::new();
					warning_lines(&mut w, argv0, &cc.warnings);
					let _ = out.flush();
					let _ = io::stderr().write_all(&w);
				}
				let mut text = print_list(cc.list(), PrintStyle::DeclareF);
				text.push(b'\n');
				if out.write_all(&text).is_err() {
					return 1;
				}
				parser.recycle(cc.tree);
			},
			Err(e) => {
				let _ = out.flush();
				let _ = io::stderr().write_all(&error_text(src, argv0, origin_is_command, &e));
				return 2;
			},
		}
	}
	if out.flush().is_err() {
		return 1;
	}
	0
}

/// `obash --json=DIALECT`: the parse as JSON with byte offsets.
pub fn json(src: &[u8], dialect: Dialect) -> u8 {
	let mut parser = Parser::new(src, Features::NONE, NO_ALIASES);
	let mut commands = Vec::new();
	while let Some(res) = parser.next_command() {
		match res {
			Ok(mut cc) => {
				cc.tree.shrink_to_fit();
				commands.push(cc);
			},
			Err(e) => {
				let _ = io::stderr().write_all(&error_text(src, b"obash", false, &e));
				return 2;
			},
		}
	}
	// The parser's token buffers grew with the largest command; free them
	// before the export builds its own.
	drop(parser);
	let d = match dialect {
		Dialect::Native => JsonDialect::Native,
		Dialect::Shfmt => JsonDialect::Shfmt,
	};
	let text = to_json(src, &Program { commands }, d, Offsets::Bytes);
	let mut out = io::stdout().lock();
	if out
		.write_all(text.as_bytes())
		.and_then(|()| out.flush())
		.is_err()
	{
		return 1;
	}
	0
}

/// `obash --parse-corpus FILE.jsonl`: parse every line (a JSON string) as an
/// independent unit, single-threaded, and print
/// `{"units":N,"bytes":B,"rejected":R,"parse_ns":T}`, where `T` is the summed
/// parse time (file reading and JSON decoding excluded).
pub fn parse_corpus(path: &Path) -> u8 {
	let file = match fs::File::open(path) {
		Ok(f) => f,
		Err(e) => {
			eprintln!("obash: {}: {e}", path.display());
			return 2;
		},
	};
	let mut units: u64 = 0;
	let mut bytes: u64 = 0;
	let mut rejected: u64 = 0;
	let mut parse_ns: u128 = 0;
	for (n, line) in io::BufReader::new(file).lines().enumerate() {
		let line = match line {
			Ok(l) => l,
			Err(e) => {
				eprintln!("obash: {}: {e}", path.display());
				return 2;
			},
		};
		if line.trim().is_empty() {
			continue;
		}
		let unit: String = match serde_json::from_str(&line) {
			Ok(s) => s,
			Err(e) => {
				eprintln!("obash: {}:{}: {e}", path.display(), n + 1);
				return 2;
			},
		};
		let src = unit.as_bytes();
		let start = Instant::now();
		let mut parser = Parser::new(src, Features::NONE, NO_ALIASES);
		let mut ok = true;
		while let Some(res) = parser.next_command() {
			match res {
				Ok(cc) => parser.recycle(cc.tree),
				Err(_) => ok = false,
			}
		}
		parse_ns += start.elapsed().as_nanos();
		units += 1;
		bytes += src.len() as u64;
		if !ok {
			rejected += 1;
		}
	}
	println!(
		"{{\"units\":{units},\"bytes\":{bytes},\"rejected\":{rejected},\"parse_ns\":{parse_ns}}}"
	);
	0
}
