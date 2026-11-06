//! The history widgets of the line editor (zsh 5.9 `zle_hist.c`) in
//! `obash` invoked as `zsh -f -i`, against the real `/bin/zsh -f -i` on
//! the same pty session: same history file (read with `fc -R`), same rc
//! file, same keys; the final screens must match.
//!
//! Cases end where the screen shows what the widget did (the line, the
//! cursor, the incremental search status line, `zle -M` messages from
//! hooks), or run a command printing the editor state afterwards.

#![cfg(unix)]

mod pty_support;

use std::{io, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(60);
/// How long output must stay quiet before the screen is read.
const QUIET: Duration = Duration::from_millis(300);

/// The history file every case starts with (oldest first).
const HIST: &str = "echo café crème\necho one\necho two\nls -l /tmp\necho three\nprint -r -- Two \
                    Words\necho two\ngit status\n";

/// `zsh -f -i` with the history file, `PS1`/`RPS1` and the rc file `rc`
/// (sourced with `.` as the first command, since `-f` skips `.zshrc`).
fn spawn(real: bool, rc: &str) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	// `^Xq` replaces the line with `cat ~/log` and runs it (see `same_log`).
	let rc = format!(
		"HISTSIZE=100\nfc -R ~/hist\nq() {{ BUFFER='cat ~/log'; zle .accept-line }}\nzle -N \
		 q\nbindkey -M emacs '^Xq' q\nbindkey -M viins '^Xq' q\nbindkey -M vicmd '^Xq' q\n{rc}"
	);
	s.args(["-f", "-i"])
		.env("PS1", "%~ %# ")
		.env("RPS1", "[%?]")
		.rc_file("hist", HIST)
		.rc_file(".zshrc", rc)
		.cwd("/tmp")
		.size(24, 80)
}

/// Type `text` key by key.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

/// The final screens of `drive` against both shells after sourcing the rc
/// file (`None` for zsh when it is not installed).
fn screens(
	rc: &str,
	drive: impl Fn(&mut Pty) -> io::Result<()>,
) -> io::Result<(String, Option<String>)> {
	let run = |pty: &mut Pty| -> io::Result<()> {
		pty.settle(QUIET, TIMEOUT)?;
		keys(pty, ". ~/.zshrc\r")?;
		// A clean screen for the case itself.
		keys(pty, "\x0c")?;
		drive(pty)
	};
	if !have_real_zsh() {
		let mut ours = spawn(false, rc).spawn()?;
		run(&mut ours)?;
		return Ok((ours.screen().contents(), None));
	}
	let (ours, real) = differential(spawn(false, rc), spawn(true, rc), run)?;
	Ok((ours, Some(real)))
}

/// Assert both screens (with the cursor position) are the same.
fn same(rc: &str, typed: &str) {
	let (ours, real) = match screens(rc, |pty| keys(pty, typed)) {
		Ok(s) => s,
		Err(e) => panic!("pty session failed: {e}"),
	};
	if let Some(real) = real {
		assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
	}
}

/// [`same`], then `~/log` shown in place of the line: what the widgets
/// logged on the way.
fn same_log(rc: &str, typed: &str) {
	same(rc, &format!("{typed}\x18q"));
}

/// A widget logging `BUFFER`, `CURSOR` and `HISTNO` to `~/log`, bound to
/// `^Xp`.
const SHOW: &str = "show() { print -r -- \"<$BUFFER> $CURSOR $HISTNO\" >>~/log }\nzle -N \
                    show\nbindkey '^Xp' show\n";

#[test]
fn up_and_down_history_with_numeric_arguments() {
	// ^P/^N are up/down-line-or-history; ESC-digit a numeric argument.
	same_log(SHOW, "\x10\x10\x18p\x1b3\x10\x18p\x1b2\x0e\x18p\x1b-1\x10\x18p");
}

#[test]
fn up_history_stops_at_the_oldest_line_without_failing() {
	let rc = "w() { zle up-history; print -r -- \"st=$? <$BUFFER> $HISTNO\" >>~/log }\nzle -N \
	          w\nbindkey '^T' w\n";
	same_log(rc, "\x1b9\x1b9\x10\x14\x14");
}

#[test]
fn up_history_with_histignoredups_skips_the_same_line() {
	let rc = format!(
		"{SHOW}setopt histignoredups histbeep\nw() {{ zle up-history; print -r -- \"st=$? \
		 <$BUFFER>\" >>~/log }}\nzle -N w\nbindkey '^T' w\n"
	);
	// Up from a buffer equal to the line above skips it; skipping off the
	// oldest line fails.
	same_log(&rc, "git status\x14\x14\x1b<\x0e\x15. ~/.zshrc\x14");
}

#[test]
fn beginning_and_end_of_buffer_or_history() {
	// ESC-< and ESC-> on a one-line buffer go through the history.
	same_log(SHOW, "echo x\x1b<\x18p\x1b>\x18p");
}

#[test]
fn history_search_backward_and_forward_by_first_word() {
	let rc =
		format!("{SHOW}bindkey '^T' history-search-backward\nbindkey '^Y' history-search-forward\n");
	same_log(&rc, "echo zz\x14\x18p\x14\x18p\x14\x18p\x19\x18p\x19\x19\x18p");
}

#[test]
fn history_search_with_an_argument_and_numeric_count() {
	let rc = format!(
		"{SHOW}w() {{ zle history-search-backward ls; print -r -- \"st=$? <$BUFFER>\" >>~/log \
		 }}\nzle -N w\nbindkey '^T' w\nbindkey '^Y' history-search-backward\n"
	);
	same_log(&rc, "\x14\x05\x15echo\x1b2\x19\x18p");
}

#[test]
fn history_beginning_search_keeps_the_cursor() {
	let rc = format!(
		"{SHOW}bindkey '^T' history-beginning-search-backward\nbindkey '^Y' \
		 history-beginning-search-forward\n"
	);
	same_log(&rc, "echo t\x14\x18p\x14\x18p\x14\x18p\x19\x18p\x19\x18p");
}

#[test]
fn history_beginning_search_with_histfindnodups() {
	let rc =
		format!("{SHOW}setopt histfindnodups\nbindkey '^T' history-beginning-search-backward\n");
	same_log(&rc, "echo t\x14\x18p\x14\x18p\x14\x18p");
}

#[test]
fn history_beginning_search_end_functions() {
	let rc = format!(
		"{SHOW}fpath=(/usr/share/zsh/5.9/functions)\nautoload -Uz history-search-end\nzle -N \
		 history-beginning-search-backward-end history-search-end\nzle -N \
		 history-beginning-search-forward-end history-search-end\nbindkey '^T' \
		 history-beginning-search-backward-end\nbindkey '^Y' history-beginning-search-forward-end\n"
	);
	same_log(&rc, "echo t\x14\x18p\x14\x18p\x19\x18p");
}

#[test]
fn up_and_down_line_or_search() {
	let rc = format!("{SHOW}bindkey '^T' up-line-or-search\nbindkey '^Y' down-line-or-search\n");
	same_log(&rc, "ls\x14\x18p\x19\x18p\x15echo\x14\x14\x18p");
}

#[test]
fn incremental_search_backward_status_line() {
	same("", "\x12two");
}

#[test]
fn incremental_search_repeats_and_fails() {
	same("", "\x12echo\x12\x12\x12\x12\x12\x12");
}

#[test]
fn incremental_search_failing_then_backspace() {
	same("", "\x12two\x12zq\x08");
}

#[test]
fn incremental_search_backspace_back_to_the_start() {
	same("", "\x12two\x12zq\x08\x08\x08\x08\x08\x08");
}

#[test]
fn incremental_search_case_insensitive_then_accept() {
	same("", "\x12words\r");
}

#[test]
fn incremental_search_numeric_argument_is_case_sensitive() {
	same("", "\x1b1\x12words");
}

#[test]
fn incremental_search_accept_line_runs_the_match() {
	same("", "\x12thr\r");
}

#[test]
fn incremental_search_other_widget_ends_it() {
	// ^E (end-of-line) ends the search and runs in the editor.
	same_log(SHOW, "\x12ls\x05 -a\x18p");
}

#[test]
fn incremental_search_forward_after_backward() {
	let rc = format!("{SHOW}bindkey '^T' history-incremental-search-forward\n");
	same(&rc, "\x12echo\x12\x12\x12\x14\x14");
}

#[test]
fn incremental_search_anchored() {
	same("", "\x12^ech");
}

#[test]
fn incremental_search_abort_and_last_searches() {
	same("", "\x12thr\x07\x12tw\rprint -r -- \"<$LASTSEARCH> <$LASTABORTEDSEARCH>\"\r");
}

#[test]
fn incremental_search_repeat_previous_search() {
	same("", "\x12two\r\x12\x12");
}

#[test]
fn incremental_search_quoted_insert_and_paste() {
	same("", "\x12\x16t\x1b[200~wo\x1b[201~");
}

#[test]
fn incremental_search_with_histfindnodups() {
	same("setopt histfindnodups\n", "\x12two\x12\x12");
}

#[test]
fn incremental_pattern_search() {
	let rc = "bindkey '^T' history-incremental-pattern-search-backward\n";
	same(rc, "\x14e*o t");
}

#[test]
fn incremental_pattern_search_repeat_and_anchor() {
	let rc = "bindkey '^T' history-incremental-pattern-search-backward\n";
	same(rc, "\x14t?o\x14\x14");
}

#[test]
fn incremental_pattern_search_anchored() {
	let rc = "bindkey '^T' history-incremental-pattern-search-backward\n";
	same(rc, "\x14^ech?");
}

#[test]
fn incremental_pattern_search_both_ways() {
	let rc = "bindkey '^T' history-incremental-pattern-search-backward\nbindkey '^Y' \
	          history-incremental-pattern-search-forward\n";
	same(rc, "\x14o\x14\x14\x14\x19\x19");
}

#[test]
fn incremental_search_multibyte() {
	same("", "\x12fé");
}

#[test]
fn incremental_pattern_search_multibyte() {
	let rc = "bindkey '^T' history-incremental-pattern-search-backward\n";
	same(rc, "\x14é c?");
}

#[test]
fn history_beginning_search_multibyte_cursor() {
	same("bindkey '^T' history-beginning-search-backward\n", "echo ca\x14");
}

#[test]
fn incremental_search_accept_and_hold() {
	// ESC-a is accept-and-hold: the match runs and comes back.
	same_log(SHOW, "\x12thr\x1ba\x18p");
}

#[test]
fn incremental_pattern_search_invalid_pattern() {
	let rc = "bindkey '^T' history-incremental-pattern-search-backward\n";
	same(rc, "\x14[a");
}

#[test]
fn incremental_search_hooks_and_match_parameters() {
	let rc = "zle-isearch-update() { print -r -- \"upd $WIDGET $ISEARCHMATCH_ACTIVE \
	          $ISEARCHMATCH_START $ISEARCHMATCH_END <$BUFFER> $CURSOR\" >>~/log }\nzle -N \
	          zle-isearch-update\nzle-isearch-exit() { print -r -- \"exit $WIDGET <$BUFFER> \
	          $ISEARCHMATCH_ACTIVE\" >>~/log }\nzle -N zle-isearch-exit\nzle-history-line-set() { \
	          print -r -- \"set <$BUFFER> $CURSOR\" >>~/log }\nzle -N zle-history-line-set\n";
	same_log(rc, "\x12ls\x12x\x08\x05");
}

#[test]
fn incremental_search_with_argument_keys() {
	let rc = "w() { zle history-incremental-search-backward thr; print -r -- \"st=$? <$BUFFER>\" \
	          >>~/log }\nzle -N w\nbindkey '^T' w\nbindkey -M isearch '^M' accept-search\n";
	same_log(rc, "\x14\r");
}

#[test]
fn incremental_search_failing_status() {
	let rc = "w() { zle history-incremental-search-backward; print -r -- \"st=$?\" >>~/log }\nzle \
	          -N w\nbindkey '^T' w\nbindkey -M isearch '^M' accept-search\n";
	same_log(rc, "\x14zzz\r\x14two\r\x14x\x07");
}

#[test]
fn insert_last_word_cycles() {
	// ESC-. is insert-last-word.
	same("", "echo \x1b.\x1b.\x1b.");
}

#[test]
fn insert_last_word_numeric_argument_and_arguments() {
	let rc = "w() { zle insert-last-word -- -1 1 }\nzle -N w\nbindkey '^T' w\n";
	same(rc, "x \x1b2\x1b. \x14 \x1b-1\x1b.");
}

#[test]
fn insert_last_word_from_the_line_itself() {
	let rc = "w() { zle insert-last-word 0 2 }\nzle -N w\nbindkey '^T' w\n";
	same(rc, "echo a b \x14");
}

#[test]
fn infer_next_history_and_accept_and_infer() {
	let rc = format!("{SHOW}bindkey '^T' accept-and-infer-next-history\n");
	same(&rc, "ls -l /tmp\x18\x0e\x18p\x15ls -l /tmp\x14");
}

#[test]
fn set_local_history_toggles() {
	let rc = "w() { zle set-local-history; print -r -- \"$ZLE_STATE\" >>~/log }\nzle -N w\nbindkey \
	          '^T' w\n";
	same_log(rc, "\x14\x14\x1b0\x14\x1b3\x14");
}

/// The vi history widgets bound in the emacs keymap.
const VI_IN_EMACS: &str = "bindkey '^T' vi-history-search-backward\nbindkey '^Y' \
                           vi-history-search-forward\nbindkey '^Xn' vi-repeat-search\nbindkey \
                           '^XN' vi-rev-repeat-search\nbindkey '^Xf' vi-fetch-history\n";

#[test]
fn vi_search_widgets_from_emacs() {
	let rc = format!("{SHOW}{VI_IN_EMACS}");
	same_log(&rc, "\x14two\r\x18p\x18n\x18p\x18N\x18p\x19\r\x18p\x14o\x17\r\x18p\x14^ls\r\x18p");
}

#[test]
fn vi_search_minibuffer_editing() {
	let rc = format!("{SHOW}{VI_IN_EMACS}");
	same(&rc, "\x14ech\x08o x\x17\x17ab");
}

#[test]
fn vi_search_aborted_forgets_the_string() {
	let rc = format!(
		"{SHOW}{VI_IN_EMACS}w() {{ zle vi-repeat-search; print -r -- \"st=$? <$BUFFER>\" >>~/log \
		 }}\nzle -N w\nbindkey '^Xw' w\n"
	);
	same_log(&rc, "\x14two\r\x18w\x14x\x07\x18w");
}

#[test]
fn vi_fetch_history_from_emacs() {
	let rc = format!("{SHOW}{VI_IN_EMACS}");
	same_log(&rc, "abc\x1b3\x18f\x18p\x18f\x18p\x10\x18f\x18p\x1b-1\x18f\x18p");
}

#[test]
fn vi_history_search_and_repeat() {
	let rc = format!("{SHOW}bindkey -v\nbindkey -M vicmd '^Xp' show\n");
	same_log(&rc, "\x1b/two\r\x18pn\x18pN\x18p?one\r\x18p");
}

#[test]
fn vi_history_search_status_line() {
	let rc = "bindkey -v\n";
	same(rc, "\x1b/ech\x08o x");
}

#[test]
fn vi_fetch_history() {
	let rc = format!("{SHOW}bindkey -v\nbindkey -M vicmd '^Xp' show\n");
	same_log(&rc, "abc\x1b3G\x18pG\x18p");
}

#[test]
fn edited_history_lines_are_kept_until_accept() {
	same_log(SHOW, "\x10\x10XX\x10\x0e\x18p\x0e\x0e\x18p\x10\x10\x18p");
}

#[test]
fn edited_history_lines_are_forgotten_after_accept() {
	same_log(SHOW, "\x10\x10XX\x0e\x0eecho hi\r\x10\x10\x10\x18p");
}
