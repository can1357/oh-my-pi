//! vi text objects (zsh 5.9 `Src/Zle/textobjects.c`): `select-a-word`,
//! `select-in-word`, `select-a-blank-word`, `select-in-blank-word`
//! (zsh `selectword`) and `select-a-shell-word`, `select-in-shell-word`
//! (zsh `selectargument`). Used as an operator's motion (the `viopp`
//! keymap) they set the mark and cursor around the range; in visual mode
//! they extend the selection; elsewhere they make the region.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{
	vi::{NOMARK, at},
	vi_move::wordclass,
};
use crate::bash::{
	syntax::zsh::{ctxtlex_ends, tok::is_meta},
	vm::zle::{
		Editor, byte_len,
		exec::{WResult, Zw},
		from_line,
		utils::{self, iblank, invicmdmode},
	},
	zshopt::ZshOpt,
};

/// zsh `blankwordclass`: 0 for blanks, 1 for anything else.
fn blankwordclass(c: char) -> u8 {
	u8::from(!iblank(c))
}

/// Whether `bindk` is the widget `name` or its immortal `.name` (zsh
/// `IS_THINGY`).
fn is_thingy(ed: &Editor, name: &str) -> bool {
	ed.bindk.as_ref().is_some_and(|b| {
		let b = b.as_slice();
		b == name.as_bytes() || (b.first() == Some(&b'.') && &b[1..] == name.as_bytes())
	})
}

/// zsh `selectword`: the word (`in`) or word and blanks (`a`) at the
/// cursor, `zmult` of them; `blank` words are separated by blanks only.
pub fn select_word(ed: &mut Editor, all: bool, blank: bool) -> i32 {
	let viclass: fn(char) -> u8 = if blank { blankwordclass } else { wordclass };
	let mut n = ed.zmod.mult;
	let mut all = all;
	let len = ed.line.len();
	let mut sclass = viclass(at(&ed.line, ed.cs));
	let mut doblanks = all && sclass != 0;

	if ed.region_active == 0 || ed.cs == ed.mark || ed.mark == NOMARK {
		// Back to the first character of the class at the cursor (within
		// the line), then forward over it.
		ed.mark = ed.cs;
		while ed.mark > 0 {
			let mut pos = ed.mark;
			utils::decpos(ed, &mut pos);
			if ed.line[pos] == '\n' || viclass(ed.line[pos]) != sclass {
				break;
			}
			ed.mark = pos;
		}
		while ed.cs < len {
			utils::inccs(ed);
			let mut pos = ed.cs;
			// A single newline within blanks belongs to them.
			if all && sclass == 0 && pos < len && ed.line[pos] == '\n' {
				utils::incpos(ed, &mut pos);
			}
			let c = at(&ed.line, pos);
			if c == '\n' || viclass(c) != sclass {
				break;
			}
		}
		if all {
			let nclass = viclass(at(&ed.line, ed.cs));
			// Blanks at either end: the next run of one class too.
			if nclass == 0 || sclass == 0 {
				while ed.cs < len {
					utils::inccs(ed);
					let c = at(&ed.line, ed.cs);
					if c == '\n' || viclass(c) != nclass {
						break;
					}
				}
				if n < 2 {
					doblanks = false;
				}
			}
		}
	} else {
		// Visual mode: one character on, so that repeating selects the
		// words after.
		if ed.cs > ed.mark {
			if ed.cs < len {
				utils::inccs(ed);
			}
		} else if ed.cs > 0 {
			utils::deccs(ed);
		}
		if ed.cs < ed.mark {
			// The cursor before the mark: extend backwards.
			while n > 0 {
				n -= 1;
				let mut pos = ed.cs;
				if all && (viclass(at(&ed.line, pos)) == 0 || at(&ed.line, pos) == '\n') {
					all = false;
					while pos > 0 {
						utils::decpos(ed, &mut pos);
						if ed.line[pos] == '\n' {
							break;
						}
						ed.cs = pos;
						if viclass(ed.line[pos]) != 0 {
							break;
						}
					}
				} else if ed.cs > 0 && at(&ed.line, ed.cs) == '\n' {
					// `in` widgets pass over one newline.
					utils::decpos(ed, &mut pos);
					if ed.line[pos] != '\n' {
						ed.cs = pos;
					}
				}
				pos = ed.cs;
				sclass = viclass(at(&ed.line, ed.cs));
				// Back over the run of one class.
				while at(&ed.line, pos) != '\n' && viclass(at(&ed.line, pos)) == sclass {
					ed.cs = pos;
					if pos == 0 {
						ed.cs = 0;
						break;
					}
					utils::decpos(ed, &mut pos);
				}
				// Blanks again, only when there were none first.
				if all && ed.cs > 0 {
					pos = ed.cs;
					utils::decpos(ed, &mut pos);
					if viclass(ed.line[pos]) == 0 {
						while pos > 0 {
							utils::decpos(ed, &mut pos);
							if ed.line[pos] == '\n' || viclass(ed.line[pos]) != 0 {
								break;
							}
							ed.cs = pos;
						}
					}
				}
			}
			return 0;
		}
		n += 1;
		doblanks = false;
	}
	// A line-wise selection becomes character-wise.
	ed.region_active = u8::from(ed.region_active != 0);

	// Each further count takes another run of one class.
	loop {
		n -= 1;
		if n <= 0 {
			break;
		}
		if ed.cs < len && ed.line[ed.cs] == '\n' {
			utils::inccs(ed);
		}
		sclass = viclass(at(&ed.line, ed.cs));
		while ed.cs < len {
			utils::inccs(ed);
			let c = at(&ed.line, ed.cs);
			if c == '\n' || viclass(c) != sclass {
				break;
			}
		}
		// `a` widgets take the blanks on either side too.
		if all {
			if ed.cs < len && ed.line[ed.cs] == '\n' {
				utils::inccs(ed);
			}
			if sclass == 0 || viclass(at(&ed.line, ed.cs)) == 0 {
				sclass = viclass(at(&ed.line, ed.cs));
				if n == 1 && sclass == 0 {
					doblanks = false;
				}
				while ed.cs < len {
					utils::inccs(ed);
					let c = at(&ed.line, ed.cs);
					if c == '\n' || viclass(c) != sclass {
						break;
					}
				}
			}
		}
	}

	// Without blanks at either end, take those before the word (not a
	// line's indentation).
	if doblanks {
		let mut pos = ed.mark;
		while pos > 0 {
			utils::decpos(ed, &mut pos);
			if ed.line[pos] == '\n' {
				break;
			}
			if !iblank(ed.line[pos]) {
				utils::incpos(ed, &mut pos);
				ed.mark = pos;
				break;
			}
		}
	}
	// An operator's range ends before the cursor; vi visual mode includes
	// it; in insert or emacs mode the region is made.
	if !ed.ls.virangeflag {
		if !invicmdmode(ed) {
			ed.region_active = 1;
		} else if ed.cs > 0 && ed.cs > ed.mark {
			utils::deccs(ed);
		}
	}
	0
}

/// The `select-*-word` widgets (zsh `selectword`, which looks at the
/// widget's name).
pub fn selectword(zw: &mut Zw<'_, '_>) -> WResult {
	let all = is_thingy(zw.ed, "select-a-word") || is_thingy(zw.ed, "select-a-blank-word");
	let blank = !(is_thingy(zw.ed, "select-a-word") || is_thingy(zw.ed, "select-in-word"));
	WResult::Done(select_word(zw.ed, all, blank))
}

/// Byte offsets of `s` once metafied: for each raw offset, the metafied
/// one (`m[i]`, `i` in `0..=s.len()`).
fn meta_offsets(s: &[u8]) -> Vec<usize> {
	let mut out = Vec::with_capacity(s.len() + 1);
	let mut m = 0;
	for &b in s {
		out.push(m);
		m += 1 + usize::from(is_meta(b));
	}
	out.push(m);
	out
}

/// The line character at metafied byte offset `off` of the line (zsh
/// `stringaszleline`'s conversion of an offset).
fn meta_to_char(line: &[char], off: i64) -> usize {
	let mut m = 0i64;
	for (i, &c) in line.iter().enumerate() {
		if m >= off {
			return i;
		}
		let bytes = utils::zlecharasstring(c);
		m += i64::try_from(meta_offsets(&bytes)[bytes.len()]).unwrap_or(i64::MAX);
	}
	line.len()
}

/// zsh `selectargument`: the `zmult` shell words (as the lexer splits
/// the line) ending with the one at the cursor; `in` leaves out leading
/// blanks and a pair of quotes (`'…'`, `"…"`, `` `…` ``, `$'…'`, `$(…)`,
/// `${…}`) around the word.
pub fn select_argument(ed: &mut Editor, inner: bool, interactive_comments: bool) -> i32 {
	let n = ed.zmod.mult;
	let len = i64::try_from(ed.line.len()).unwrap_or(i64::MAX);
	if n < 1 || n.saturating_mul(2) > len + 1 {
		return 1;
	}
	let n = usize::try_from(n).unwrap_or(usize::MAX);
	if !invicmdmode(ed) {
		ed.region_active = 1;
		ed.mark = ed.cs;
	}
	// The text lexed: earlier lines of the command, then this one, all
	// offsets in zsh's metafied bytes.
	let line = from_line(&ed.line);
	let prefix: &[u8] = if ed.isfirstln {
		b""
	} else {
		ed.hline.as_ref().map_or(&b""[..], |h| h.as_slice())
	};
	let mut text = Vec::with_capacity(prefix.len() + line.len());
	text.extend_from_slice(prefix);
	text.extend_from_slice(&line);
	let moff = meta_offsets(&text);
	let plen = i64::try_from(moff[prefix.len()]).unwrap_or(i64::MAX);
	let total = i64::try_from(moff[text.len()]).unwrap_or(i64::MAX);
	let cs_bytes = byte_len(&ed.line[..ed.cs.min(ed.line.len())]);
	let mut metacs = plen + i64::try_from(meta_offsets(&line)[cs_bytes]).unwrap_or(i64::MAX);
	if metacs > 0 {
		metacs -= 1;
	}
	// zsh's `wend = zlemetall - inbufct`: relative to this line's end.
	let linelen = total - plen;
	let ends = ctxtlex_ends(&text, interactive_comments);
	let mut wstarts = vec![0i64; n];
	let mut wcur = 0;
	let mut wend = 0i64;
	let mut ends = ends.into_iter();
	loop {
		wstarts[wcur] = wend;
		wcur = (wcur + 1) % n;
		let Some(e) = ends.next() else {
			break;
		};
		wend = linelen - (total - i64::try_from(moff[e.min(text.len())]).unwrap_or(i64::MAX));
		if wend > metacs {
			break;
		}
	}
	ed.cs = meta_to_char(&ed.line, wend);
	ed.mark = meta_to_char(&ed.line, wstarts[wcur]);

	if inner {
		let end = ed.cs;
		while ed.mark < ed.cs && iblank(at(&ed.line, ed.mark)) {
			let mut m = ed.mark;
			utils::incpos(ed, &mut m);
			ed.mark = m;
		}
		let mut start = ed.mark;
		let (opens, closes): (&[char], &[char]) = if at(&ed.line, start) == '$' {
			utils::incpos(ed, &mut start);
			(&['\'', '(', '{'], &['\'', ')', '}'])
		} else {
			(&['`', '\'', '"'], &['`', '\'', '"'])
		};
		if let Some(i) = opens.iter().position(|&c| c == at(&ed.line, start)) {
			let mut e = end;
			utils::decpos(ed, &mut e);
			if at(&ed.line, e) == closes[i] {
				ed.cs = e;
				utils::incpos(ed, &mut start);
				ed.mark = start;
			}
		}
	}
	// An operator's range ends before the cursor.
	if !ed.ls.virangeflag && invicmdmode(ed) {
		utils::deccs(ed);
	}
	0
}

/// The `select-*-shell-word` widgets (zsh `selectargument`).
pub fn selectargument(zw: &mut Zw<'_, '_>) -> WResult {
	let inner = is_thingy(zw.ed, "select-in-shell-word");
	let comments = zw.isset(ZshOpt::Interactivecomments);
	WResult::Done(select_argument(zw.ed, inner, comments))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	fn ed(s: &str, cs: usize) -> Editor {
		let mut e = Editor::new(Context::LineStart, 0);
		e.line = s.chars().collect();
		e.cs = cs;
		e.keymap = bstr::BString::from("vicmd");
		e.ls.virangeflag = true;
		e
	}

	#[test]
	fn words_for_operators() {
		// `daw` on "two": the word and the blank after it.
		let mut e = ed("one two three", 5);
		assert_eq!(select_word(&mut e, true, false), 0);
		assert_eq!((e.mark, e.cs), (4, 8));
		let mut e = ed("one two three", 5);
		assert_eq!(select_word(&mut e, false, false), 0);
		assert_eq!((e.mark, e.cs), (4, 7));
		// The last word: the blank before it instead.
		let mut e = ed("one two", 5);
		assert_eq!(select_word(&mut e, true, false), 0);
		assert_eq!((e.mark, e.cs), (3, 7));
	}

	#[test]
	fn shell_words() {
		let mut e = ed("ls \"a b\" c", 5);
		assert_eq!(select_argument(&mut e, false, false), 0);
		assert_eq!((e.mark, e.cs), (2, 8));
		let mut e = ed("ls \"a b\" c", 5);
		assert_eq!(select_argument(&mut e, true, false), 0);
		assert_eq!((e.mark, e.cs), (4, 7));
		let mut e = ed("echo ${x:-y}", 7);
		assert_eq!(select_argument(&mut e, true, false), 0);
		assert_eq!((e.mark, e.cs), (7, 11));
	}

	#[test]
	fn meta_conversion() {
		let line: Vec<char> = "aé".chars().collect();
		// "é" is c3 a9; a9 is no meta byte, c3 neither.
		assert_eq!(meta_to_char(&line, 1), 1);
		assert_eq!(meta_to_char(&line, 3), 2);
	}
}
