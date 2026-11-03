//! `obash --print`, `--json` and `--parse-corpus`: the syntax crate on its
//! own (parse only, nothing is executed).

use std::{
	fs,
	io::{self, BufRead, Write},
	path::Path,
	time::Instant,
};

use pi_shell::bash::syntax::{
	Features, JsonDialect, NO_ALIASES, Offsets, ParseError, ParseWarning, Parser, PrintStyle,
	Program, command_string, print_list, to_json,
};

/// JSON schema selected by `--json`.
#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Dialect {
	/// The syntax crate's own schema, with node ids.
	Native,
	/// The `shfmt --ln=bash --to-json` schema read by bash-viz.
	Shfmt,
}

/// The diagnostic prefix bash uses: `NAME: line N: ` (`NAME: -c: line N: `
/// for a command string).
fn prefix(out: &mut Vec<u8>, argv0: &[u8], origin_is_command: bool, line: u32) {
	out.extend_from_slice(argv0);
	out.extend_from_slice(if origin_is_command {
		b": -c: line "
	} else {
		b": line "
	});
	out.extend_from_slice(line.to_string().as_bytes());
	out.extend_from_slice(b": ");
}

/// Parser warnings; bash prints them without the `-c:` marker.
fn warning_lines(out: &mut Vec<u8>, argv0: &[u8], warnings: &[ParseWarning]) {
	for w in warnings {
		prefix(out, argv0, false, w.line);
		out.extend_from_slice(&w.bash_msg);
		out.push(b'\n');
	}
}

/// The source line holding byte `at`, without its newline.
fn line_at(src: &[u8], at: usize) -> &[u8] {
	let at = at.min(src.len());
	let start = src[..at]
		.iter()
		.rposition(|&c| c == b'\n')
		.map_or(0, |i| i + 1);
	let end = src[at..]
		.iter()
		.position(|&c| c == b'\n')
		.map_or(src.len(), |i| at + i);
	&src[start..end]
}

/// bash's report of a syntax error: warnings, the detail line, the message,
/// and for token errors the offending line.
fn error_text(src: &[u8], argv0: &[u8], origin_is_command: bool, e: &ParseError) -> Vec<u8> {
	let mut msg = Vec::new();
	warning_lines(&mut msg, argv0, &e.warnings);
	if let Some(d) = e.detail() {
		prefix(&mut msg, argv0, origin_is_command, d.line);
		msg.extend_from_slice(&d.bash_msg);
		msg.push(b'\n');
	}
	prefix(&mut msg, argv0, origin_is_command, e.line);
	msg.extend_from_slice(&e.bash_msg());
	msg.push(b'\n');
	if e.echoes_line() {
		let at = (e.span.lo as usize).min(src.len());
		// A token error at a newline reports the line the newline ends.
		let at = if at > 0 && at == src.len() {
			at - 1
		} else {
			at
		};
		prefix(&mut msg, argv0, origin_is_command, e.line);
		msg.push(b'`');
		msg.extend_from_slice(line_at(src, at));
		msg.extend_from_slice(b"'\n");
	}
	msg
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
				let mut text = print_list(&cc.list, PrintStyle::DeclareF);
				text.push(b'\n');
				if out.write_all(&text).is_err() {
					return 1;
				}
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

/// `obash --pretty-print FILE` (bash's `pretty_print_loop`): every command
/// as bash's `make_command_string` prints it; a blank or comment-only line
/// between commands, and the end of the input, print one empty line (never
/// two in a row). A syntax error is reported and ends it (status 1).
pub fn pretty_print(src: &[u8], argv0: &[u8]) -> u8 {
	let mut out = io::stdout().lock();
	let mut parser = Parser::new(src, Features::NONE, NO_ALIASES);
	// Where the previous command's input ended, and whether its line was
	// read to the end (the newline is part of the command).
	let mut from = 0usize;
	let mut line_done = true;
	loop {
		let res = parser.next_command();
		let lo = match &res {
			Some(Ok(cc)) => (cc.span.lo as usize).clamp(from, src.len()),
			_ => src.len(),
		};
		let newlines = bstr::ByteSlice::find_iter(&src[from.min(lo)..lo], b"\n").count();
		let empty_lines = if line_done {
			newlines
		} else {
			newlines.saturating_sub(1)
		};
		// Every round ends with a command (or the end), so the empty line
		// is never the second in a row.
		let mut text = Vec::new();
		if empty_lines > 0 || res.is_none() {
			text.push(b'\n');
		}
		match res {
			None => {
				if out.write_all(&text).and_then(|()| out.flush()).is_err() {
					return 1;
				}
				return 0;
			},
			Some(Ok(cc)) => {
				text.extend_from_slice(&command_string(&cc.list));
				text.push(b'\n');
			},
			Some(Err(e)) => {
				let _ = out.write_all(&text);
				let _ = out.flush();
				let _ = io::stderr().write_all(&error_text(src, argv0, false, &e));
				return 1;
			},
		}
		if out.write_all(&text).is_err() {
			return 1;
		}
		from = (parser.pos().offset as usize).min(src.len());
		line_done = from == 0 || src[from - 1] == b'\n';
	}
}

/// `obash --json=DIALECT`: the parse as JSON with byte offsets.
pub fn json(src: &[u8], dialect: Dialect) -> u8 {
	let mut parser = Parser::new(src, Features::NONE, NO_ALIASES);
	let mut commands = Vec::new();
	while let Some(res) = parser.next_command() {
		match res {
			Ok(cc) => commands.push(cc),
			Err(e) => {
				let _ = io::stderr().write_all(&error_text(src, b"obash", false, &e));
				return 2;
			},
		}
	}
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
			if res.is_err() {
				ok = false;
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
