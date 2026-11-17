//! More editing widgets of zsh 5.9 `Src/Zle/zle_misc.c` and friends:
//! `gosmacs-transpose-chars`, `pound-insert`, `copy-prev-word`,
//! `copy-prev-shell-word`, `quote-region`, `quote-line`,
//! `deactivate-region` (`zle_move.c`), `accept-line-and-down-history`
//! (`zle_hist.c`), and `which-command`/`run-help` (`processcmd` of
//! `zle_tricky.c`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::{stack, word::WordChars, yank::regionlines};
use crate::bash::{
	syntax::zsh::{
		bufferwords_zle,
		tok::{metafy, unmetafy, untokenize},
		zle_curcmd,
	},
	vm::{
		builtins::history::{self, model::HIST_FOREIGN},
		proc::Scratch,
		zle::{
			Editor, Zle,
			exec::{Await, WResult, Zw, then},
			from_line, hist, to_line,
			utils::{self, cutflags},
		},
		zsh::text::{Qt, QuoteOpts, quotestring},
	},
	zshopt::ZshOpt,
};

/// zsh `gosmacstransposechars`: exchange the two characters before the
/// cursor (at the start of a line, moving on over one or two first).
pub fn gosmacs_transpose_chars(ed: &mut Editor) -> i32 {
	let ll = ed.line.len();
	if ed.cs < 2 || ed.line[ed.cs - 1] == '\n' || ed.line[ed.cs - 2] == '\n' {
		let twice = ed.cs == 0 || ed.line[ed.cs - 1] == '\n';
		if ed.cs == ll || ed.line[ed.cs] == '\n' {
			return 1;
		}
		utils::inccs(ed);
		if twice {
			if ed.cs == ll || ed.line[ed.cs] == '\n' {
				return 1;
			}
			utils::inccs(ed);
		}
	}
	let mut middle = ed.cs;
	utils::decpos(ed, &mut middle);
	let mut start = middle;
	utils::decpos(ed, &mut start);
	let end = ed.cs;
	ed.line[start..end].rotate_left(middle - start);
	0
}

/// Widget `gosmacs-transpose-chars`.
pub fn gosmacstransposechars(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(gosmacs_transpose_chars(zw.ed))
}

/// zsh `poundinsert`: comment out every line of the buffer with a `#`
/// before its first non-blank, or, when the first line already has one,
/// take those `#`s out again; then accept the buffer.
pub fn pound_insert(ed: &mut Editor) -> i32 {
	ed.cs = 0;
	utils::vifirstnonblank(ed);
	if ed.line.get(ed.cs) == Some(&'#') {
		utils::foredel(ed, 1, 0);
		ed.cs = utils::findeol(ed);
		while ed.cs != ed.line.len() {
			ed.cs += 1;
			utils::vifirstnonblank(ed);
			if ed.line.get(ed.cs) == Some(&'#') {
				utils::foredel(ed, 1, 0);
			}
			ed.cs = utils::findeol(ed);
		}
	} else {
		utils::insert_at_cs(ed, &['#']);
		ed.cs -= 1;
		ed.cs = utils::findeol(ed);
		while ed.cs != ed.line.len() {
			ed.cs += 1;
			utils::vifirstnonblank(ed);
			utils::insert_at_cs(ed, &['#']);
			ed.cs -= 1;
			ed.cs = utils::findeol(ed);
		}
	}
	ed.done = true;
	0
}

/// Widget `pound-insert`.
pub fn poundinsert(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(pound_insert(zw.ed))
}

/// zsh `copyprevword`: insert a copy of the `zmult`-th word before the
/// cursor (words as `backward-word` finds them). 1 for a count below 1
/// or when there are fewer words.
pub fn copy_prev_word(ed: &mut Editor, wc: &WordChars) -> i32 {
	if ed.zmod.mult <= 0 {
		return 1;
	}
	let mut count = ed.zmod.mult;
	let mut t0 = ed.cs;
	let t1 = loop {
		let t1 = t0;
		while t0 != 0 {
			let mut prev = t0;
			utils::decpos(ed, &mut prev);
			if wc.iword(ed.line[prev]) {
				break;
			}
			t0 = prev;
		}
		while t0 != 0 {
			let mut prev = t0;
			utils::decpos(ed, &mut prev);
			if !wc.iword(ed.line[prev]) {
				break;
			}
			t0 = prev;
		}
		count -= 1;
		if count == 0 {
			break t1;
		}
		if t0 == 0 {
			return 1;
		}
	};
	let copy = ed.line[t0..t1].to_vec();
	utils::insert_at_cs(ed, &copy);
	0
}

/// Widget `copy-prev-word`.
pub fn copyprevword(zw: &mut Zw<'_, '_>) -> WResult {
	let wc = WordChars::load(zw);
	WResult::Done(copy_prev_word(zw.ed, &wc))
}

/// The editor line as zsh's `zlemetaline` (metafied) and the cursor as a
/// byte offset into its unmetafied form.
fn line_bytes(ed: &Editor) -> (Vec<u8>, usize) {
	let raw = from_line(&ed.line[..ed.cs.min(ed.line.len())]);
	let cs = raw.len();
	(metafy(&from_line(&ed.line)), cs)
}

/// zsh `copyprevshellword`: insert a copy of the shell word the cursor is
/// in or after (the `zmult`-th one back with a count); 1 for a count
/// below 1 or when there are fewer words.
pub fn copy_prev_shell_word(ed: &mut Editor) -> i32 {
	if ed.zmod.mult <= 0 {
		return 1;
	}
	let (text, cs) = line_bytes(ed);
	let (words, cur) = bufferwords_zle(&text, cs);
	let Some(cur) = cur else {
		return 0;
	};
	let back = usize::try_from(ed.zmod.mult - 1).unwrap_or(usize::MAX);
	let Some(i) = cur.checked_sub(back) else {
		return 1;
	};
	if let Some(w) = words.get(i) {
		let add = to_line(&unmetafy(w));
		utils::insert_at_cs(ed, &add);
	}
	0
}

/// Widget `copy-prev-shell-word`.
pub fn copyprevshellword(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(copy_prev_shell_word(zw.ed))
}

/// zsh `makequote`: `s` in single quotes, each `'` as `'\''`.
pub fn makequote(s: &[char]) -> Vec<char> {
	let qtct = s.iter().filter(|&&c| c == '\'').count();
	let mut out = Vec::with_capacity(s.len() + 2 + qtct * 3);
	out.push('\'');
	for &c in s {
		if c == '\'' {
			out.extend_from_slice(&['\'', '\\', '\'', '\'']);
		} else {
			out.push(c);
		}
	}
	out.push('\'');
	out
}

/// zsh `quoteregion`: put the region (whole lines in line mode; with the
/// character under the cursor in vi command mode) in single quotes; the
/// mark goes before and the cursor after the quoted text.
pub fn quote_region(ed: &mut Editor) -> i32 {
	let mut extra = utils::invicmdmode(ed);
	let ll = ed.line.len();
	if ed.mark > ll {
		ed.mark = ll;
	}
	if ed.region_active == 2 {
		let (a, b) = regionlines(ed);
		ed.cs = a;
		ed.mark = b;
		extra = false;
	} else if ed.mark < ed.cs {
		std::mem::swap(&mut ed.mark, &mut ed.cs);
	}
	if extra {
		let mut m = ed.mark;
		utils::incpos(ed, &mut m);
		ed.mark = m.min(ll);
	}
	let len = ed.mark.saturating_sub(ed.cs);
	let s = ed.line[ed.cs..ed.cs + len].to_vec();
	utils::foredel(ed, len, cutflags::RAW);
	let q = makequote(&s);
	let at = ed.cs;
	utils::insert_at_cs(ed, &q);
	ed.mark = at;
	0
}

/// Widget `quote-region`.
pub fn quoteregion(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(quote_region(zw.ed))
}

/// zsh `quoteline`: put the whole buffer in single quotes, the cursor at
/// the end.
pub fn quote_line(ed: &mut Editor) -> i32 {
	ed.line = makequote(&ed.line);
	ed.cs = ed.line.len();
	0
}

/// Widget `quote-line`.
pub fn quoteline(zw: &mut Zw<'_, '_>) -> WResult {
	WResult::Done(quote_line(zw.ed))
}

/// Widget `deactivate-region` (zsh `deactivateregion`).
pub const fn deactivateregion(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.region_active = 0;
	WResult::Done(0)
}

/// zsh `acceptlineanddownhistory`: accept the line; the next one starts
/// with the history line after the one shown (other sessions' lines
/// skipped).
pub fn acceptlineanddownhistory(zw: &mut Zw<'_, '_>) -> WResult {
	if let Some(h) = hist::load(zw)
		&& let Some(i) = h.index_of(zw.ed.histline)
		&& let Some(j) = h.movehistent(i, 1, HIST_FOREIGN)
	{
		zw.zle.bufstack.push(BString::from(h.text_at(j)));
		zw.zle.stack_hist = Some(h.num_at(j));
	}
	zw.ed.done = true;
	WResult::Done(0)
}

/// zsh `doexpandhist`: expand the history references on the line, the
/// cursor moved along with the text before it, then run `next` with
/// whether the line changed (failed expansions leave it as it was).
pub fn doexpandhist<F>(zw: &mut Zw<'_, '_>, mut sc: Box<Scratch>, next: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, bool) -> WResult + Send + 'static,
{
	let line = from_line(&zw.ed.line);
	let cs = from_line(&zw.ed.line[..zw.ed.cs.min(zw.ed.line.len())]).len();
	match history::zsh::expand_zle(zw.k, zw.cx, zw.vp, &mut sc, &line, cs) {
		Err(key) => then(Await::Wait(key), move |zw, _| doexpandhist(zw, sc, next)),
		Ok(None) => next(zw, false),
		Ok(Some((text, ncs))) => {
			let ncs = to_line(&text[..ncs.min(text.len())]).len();
			zw.ed.line = to_line(&text);
			zw.ed.cs = ncs.min(zw.ed.line.len());
			let bol = utils::findbol(zw.ed);
			if zw.ed.ls.viinsbegin > bol {
				zw.ed.ls.viinsbegin = bol;
			}
			next(zw, true)
		},
	}
}

/// Widget `expand-history` (zsh `expandhistory`): 1 when nothing was
/// expanded.
pub fn expandhistory(zw: &mut Zw<'_, '_>) -> WResult {
	doexpandhist(zw, Box::default(), |_, changed| WResult::Done(i32::from(!changed)))
}

/// zsh `processcmd` once the command word `s` (tokenized, metafied) is
/// known: push the line, then make it `WIDGET word` and accept it.
pub fn process_cmd(zle: &mut Zle, ed: &mut Editor, widget: &[u8], s: &[u8], o: QuoteOpts) -> i32 {
	let m = ed.zmod.mult;
	ed.zmod.mult = 1;
	stack::push_line(zle, ed);
	ed.zmod.mult = m;
	let mut s = s.to_vec();
	untokenize(&mut s);
	let mut text = BString::from(widget);
	text.push(b' ');
	text.extend_from_slice(&unmetafy(&quotestring(&s, Qt::Backslash, o)));
	utils::insert_at_cs(ed, &to_line(&text));
	ed.done = true;
	0
}

/// Widget `which-command` and `run-help` (zsh `processcmd`): run the
/// widget's name (an alias of `whence`/`man` by default) on the command
/// word of the command the cursor is in, the line pushed meanwhile.
pub fn processcmd(zw: &mut Zw<'_, '_>) -> WResult {
	let comments = zw.isset(ZshOpt::Interactivecomments);
	let raw = from_line(&zw.ed.line);
	let cs = from_line(&zw.ed.line[..zw.ed.cs.min(zw.ed.line.len())]).len();
	let Some(s) = zle_curcmd(&raw, cs, comments) else {
		return WResult::Done(1);
	};
	let (bang, bang_special) =
		crate::bash::vm::zsh::params::bang_quoting(&mut zw.k.root, zw.cx.store, zw.vp);
	let o = QuoteOpts {
		rcquotes: zw.isset(ZshOpt::Rcquotes),
		magic_equal_subst: zw.isset(ZshOpt::Magicequalsubst),
		extended_glob: zw.isset(ZshOpt::Extendedglob),
		bang,
		bang_special,
		mb: crate::bash::vm::zsh::params::mb_quiet(zw.k, zw.cx.store, zw.vp),
	};
	let widget = zw.ed.bindk.clone().unwrap_or_default();
	WResult::Done(process_cmd(zw.zle, zw.ed, &widget, &s, o))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::zle::Context;

	fn ed(s: &str, cs: usize) -> Editor {
		let mut e = Editor::new(Context::LineStart, 0);
		e.line = s.chars().collect();
		e.cs = cs;
		e
	}

	fn line(e: &Editor) -> String {
		e.line.iter().collect()
	}

	#[test]
	fn gosmacs() {
		let mut e = ed("abc", 3);
		assert_eq!(gosmacs_transpose_chars(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("acb", 3));
		e.cs = 0;
		assert_eq!(gosmacs_transpose_chars(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("cab", 2));
		let mut e = ed("a", 0);
		assert_eq!(gosmacs_transpose_chars(&mut e), 1);
	}

	#[test]
	fn pound() {
		let mut e = ed("  ls\necho", 3);
		assert_eq!(pound_insert(&mut e), 0);
		assert_eq!(line(&e), "  #ls\n#echo");
		assert!(e.done);
		assert_eq!(pound_insert(&mut e), 0);
		assert_eq!(line(&e), "  ls\necho");
	}

	#[test]
	fn copy_words() {
		let wc = WordChars::new(None);
		let mut e = ed("aa bb ", 6);
		assert_eq!(copy_prev_word(&mut e, &wc), 0);
		// The word back to the cursor, blanks after it included.
		assert_eq!((line(&e).as_str(), e.cs), ("aa bb bb ", 9));
		e.zmod.mult = 3;
		assert_eq!(copy_prev_word(&mut e, &wc), 0);
		assert_eq!(line(&e), "aa bb bb aa ");
		e.zmod.mult = 9;
		assert_eq!(copy_prev_word(&mut e, &wc), 1);
		// zsh's `gotword` stops at a word ending one before the cursor:
		// right after `c`, the word before it is copied (as /bin/zsh does).
		let mut e = ed("echo 'a b' c", 12);
		assert_eq!(copy_prev_shell_word(&mut e), 0);
		assert_eq!(line(&e), "echo 'a b' c'a b'");
		e.zmod.mult = 2;
		assert_eq!(copy_prev_shell_word(&mut e), 0);
		assert_eq!(line(&e), "echo 'a b' c'a b''a b'");
		let mut e = ed("echo 'a b' c ", 13);
		assert_eq!(copy_prev_shell_word(&mut e), 0);
		assert_eq!(line(&e), "echo 'a b' c c");
	}

	#[test]
	fn quoting() {
		let mut e = ed("it's", 0);
		assert_eq!(quote_line(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs), ("'it'\\''s'", 9));
		let mut e = ed("echo a b", 8);
		e.mark = 5;
		assert_eq!(quote_region(&mut e), 0);
		assert_eq!((line(&e).as_str(), e.cs, e.mark), ("echo 'a b'", 10, 5));
	}
}
