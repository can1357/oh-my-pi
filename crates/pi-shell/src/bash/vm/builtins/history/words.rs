//! The words of a history event (zsh `chwords`, `histsplitwords`): the
//! bounds `!!:n`, `$historywords` and `:x`-style word designators use.
//!
//! zsh records a word for every token its lexer reads from an interactive
//! line (`hwbegin`/`hwend` in `gettok`): words, operators, redirections and
//! the newlines between the lines of a multi-line event, but not comments.
//! [`lex_words`] finds the same bounds in a finished text; [`blank_words`]
//! is the split of lines read from the history file (blank-separated runs,
//! a backslash-newline counting as a blank).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::model::inblank;

/// zsh `histsplitwords` without lexing: blank-separated runs, with
/// `\`-newline skipped as a blank. Bounds in pairs.
pub fn blank_words(s: &[u8]) -> Vec<u32> {
	let mut words = Vec::new();
	let mut i = 0;
	loop {
		loop {
			if i < s.len() && inblank(s[i]) {
				i += 1;
			} else if s.get(i) == Some(&b'\\') && s.get(i + 1) == Some(&b'\n') {
				i += 2;
			} else {
				break;
			}
		}
		if i >= s.len() {
			break;
		}
		let start = i;
		while i < s.len() && !inblank(s[i]) {
			i += 1;
		}
		words.push(start as u32);
		words.push(i as u32);
	}
	words
}

/// zsh `iblank`: blanks between tokens (not newline).
const fn iblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t')
}

/// Characters that end a word.
const fn ends_word(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>' | b')')
}

/// The token bounds zsh's lexer records for `s` (an event's text, or the
/// line read so far), in pairs; a comment (`#` starting a word, when
/// `comments` is on) records none. A trailing newline is not a word.
pub fn lex_words(s: &[u8], comments: bool) -> Vec<u32> {
	let mut words = Vec::new();
	let mut i = 0;
	let n = s.len();
	while i < n {
		// Blanks, and backslash-newlines between tokens.
		if iblank(s[i]) {
			i += 1;
			continue;
		}
		if s[i] == b'\\' && s.get(i + 1) == Some(&b'\n') {
			i += 2;
			continue;
		}
		let start = i;
		let c = s[i];
		if c == b'#' && comments {
			while i < n && s[i] != b'\n' {
				i += 1;
			}
			continue;
		}
		let end = match c {
			b'\n' => i + 1,
			b';' => i + 1 + usize::from(matches!(s.get(i + 1), Some(b';' | b'&' | b'|'))),
			b'&' => match s.get(i + 1) {
				Some(b'&' | b'|' | b'!') => i + 2,
				Some(b'>') => redir_tail(s, i + 2),
				_ => i + 1,
			},
			b'|' => i + 1 + usize::from(matches!(s.get(i + 1), Some(b'|' | b'&'))),
			b'(' if s.get(i + 1) == Some(&b'(') => balanced(s, i + 2, b'(', b')').min(n),
			b'(' | b')' => i + 1,
			b'<' | b'>' if s.get(i + 1) == Some(&b'(') => word_end(s, i),
			b'<' | b'>' => redir(s, i),
			b'0'..=b'9'
				if matches!(s.get(i + 1), Some(b'<' | b'>')) && s.get(i + 2) != Some(&b'(') =>
			{
				redir(s, i + 1)
			},
			_ => word_end(s, i),
		};
		let end = end.max(start + 1).min(n);
		// The newline ending the event is no word.
		if !(c == b'\n' && end == n) {
			words.push(start as u32);
			words.push(end as u32);
		}
		i = end;
	}
	words
}

/// The end of a redirection operator starting at `i` (`<`, `>`, `>>`,
/// `<<`, `<<-`, `<<<`, `<>`, `<&`, `>&`, `>|`, `>!`, `>>|`, `>>&`, …).
fn redir(s: &[u8], i: usize) -> usize {
	let c = s[i];
	let mut j = i + 1;
	if c == b'<' {
		match s.get(j) {
			Some(b'<') => {
				j += 1;
				if matches!(s.get(j), Some(b'<' | b'-')) {
					j += 1;
				}
			},
			Some(b'>' | b'&') => j += 1,
			_ => {},
		}
		return j;
	}
	if s.get(j) == Some(&b'>') {
		j += 1;
	}
	redir_tail(s, j)
}

/// After `>`, `>>` or `&>`: an optional `|`, `!` or `&` (`>&|`? no: one).
fn redir_tail(s: &[u8], j: usize) -> usize {
	match s.get(j) {
		Some(b'|' | b'!' | b'&') => j + 1,
		_ => j,
	}
}

/// The end of the construct opened before `i` with `open`, closed by
/// `close`: past the matching close, quotes skipped.
fn balanced(s: &[u8], mut i: usize, open: u8, close: u8) -> usize {
	let mut depth = 1;
	while i < s.len() {
		let c = s[i];
		match c {
			b'\\' => i += 1,
			b'\'' => i = quote_end(s, i + 1, b'\''),
			b'"' => i = dquote_end(s, i + 1),
			b'`' => i = quote_end(s, i + 1, b'`'),
			_ if c == open => depth += 1,
			_ if c == close => {
				depth -= 1;
				if depth == 0 {
					return i + 1;
				}
			},
			_ => {},
		}
		i += 1;
	}
	s.len()
}

/// The position of the closing `q` at or after `i` (the end of input when
/// there is none); a backquoted string honours backslashes.
fn quote_end(s: &[u8], mut i: usize, q: u8) -> usize {
	while i < s.len() && s[i] != q {
		if q == b'`' && s[i] == b'\\' {
			i += 1;
		}
		i += 1;
	}
	i.min(s.len())
}

/// The position of the closing `"` at or after `i`.
fn dquote_end(s: &[u8], mut i: usize) -> usize {
	while i < s.len() && s[i] != b'"' {
		match s[i] {
			b'\\' => i += 1,
			b'$' if s.get(i + 1) == Some(&b'(') => i = balanced(s, i + 2, b'(', b')') - 1,
			b'$' if s.get(i + 1) == Some(&b'{') => i = balanced(s, i + 2, b'{', b'}') - 1,
			b'`' => i = quote_end(s, i + 1, b'`'),
			_ => {},
		}
		i += 1;
	}
	i.min(s.len())
}

/// The end of the word starting at `i`.
fn word_end(s: &[u8], mut i: usize) -> usize {
	let n = s.len();
	let start = i;
	while i < n {
		let c = s[i];
		match c {
			b'\\' => {
				i += 2;
				continue;
			},
			b'\'' => {
				let dollar = i > 0 && s[i - 1] == b'$';
				i += 1;
				while i < n && s[i] != b'\'' {
					if dollar && s[i] == b'\\' {
						i += 1;
					}
					i += 1;
				}
			},
			b'"' => i = dquote_end(s, i + 1),
			b'`' => i = quote_end(s, i + 1, b'`'),
			b'$' if matches!(s.get(i + 1), Some(b'(' | b'{' | b'[')) => {
				let (open, close) = match s[i + 1] {
					b'(' => (b'(', b')'),
					b'{' => (b'{', b'}'),
					_ => (b'[', b']'),
				};
				i = balanced(s, i + 2, open, close);
				continue;
			},
			b'<' | b'>' | b'=' if s.get(i + 1) == Some(&b'(') && (i == start || c == b'=') => {
				i = balanced(s, i + 2, b'(', b')');
				continue;
			},
			b'(' => {
				i = balanced(s, i + 1, b'(', b')');
				continue;
			},
			_ if ends_word(c) => break,
			_ => {},
		}
		i += 1;
	}
	i.min(n)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn words(s: &str) -> Vec<&str> {
		let w = lex_words(s.as_bytes(), false);
		w.chunks(2)
			.map(|p| &s[p[0] as usize..p[1] as usize])
			.collect()
	}

	/// Goldens: zsh 5.9 `$historywords` of the same lines read with `-i`.
	#[test]
	fn lexer_words_match_zsh() {
		assert_eq!(words(": a;b|c>d 2>&1 &&e \"x y\" 'q' $(ls -l) ${x:-y} `pwd` x=1 a\\[1]=2"), [
			":", "a", ";", "b", "|", "c", ">", "d", "2>&", "1", "&&", "e", "\"x y\"", "'q'",
			"$(ls -l)", "${x:-y}", "`pwd`", "x=1", "a\\[1]=2"
		]);
		assert_eq!(words("if true\nthen : x; fi"), ["if", "true", "\n", "then", ":", "x", ";", "fi"]);
		assert_eq!(words(": a # comment"), [":", "a", "#", "comment"]);
		assert_eq!(words(": {a,b} <<<str >>/dev/null <(true) &>/dev/null >| /dev/null 3<&0"), [
			":",
			"{a,b}",
			"<<<",
			"str",
			">>",
			"/dev/null",
			"<(true)",
			"&>",
			"/dev/null",
			">|",
			"/dev/null",
			"3<&",
			"0"
		]);
	}

	#[test]
	fn comments_record_no_word() {
		let s = b"echo a # c";
		assert_eq!(lex_words(s, true), [0, 4, 5, 6]);
	}

	#[test]
	fn blank_words_skip_continuations() {
		assert_eq!(blank_words(b" a\\\n b  c"), [1, 3, 5, 6, 8, 9]);
	}
}
