//! bash's syntax-error reports and `--pretty-print` (parse only, nothing
//! is executed).

use std::io::{self, Write};

use crate::bash::syntax::{Features, NO_ALIASES, ParseError, ParseWarning, Parser, command_string};

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

/// Parser warnings, appended to `out`; bash prints them without the `-c:`
/// marker.
pub fn warning_lines(out: &mut Vec<u8>, argv0: &[u8], warnings: &[ParseWarning]) {
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
pub fn error_text(src: &[u8], argv0: &[u8], origin_is_command: bool, e: &ParseError) -> Vec<u8> {
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

/// `--pretty-print FILE` (bash's `pretty_print_loop`).
///
/// Every command as bash's `make_command_string` prints it; a blank or
/// comment-only line between commands, and the end of the input, print one
/// empty line (never two in a row). A syntax error is reported and ends it
/// (status 1).
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
