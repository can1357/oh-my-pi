//! The emacs-style, word, region, argument, undo, minibuffer and other
//! non-vi builtin widgets (zsh 5.9 `zle_misc.c`, `zle_word.c`,
//! `zle_move.c`, `zle_main.c`, `zle_utils.c`, `deltochar.c`) in `obash`
//! invoked as `zsh -f -i`, against the real `/bin/zsh -f -i` on the same
//! pty session: same rc file, same keys; the final screens must match.
//!
//! Cases type a marker (`,`) after a motion to show where the cursor went,
//! and accept lines (`echo …`) so the buffer is printed.

#![cfg(unix)]

mod pty_support;

use std::{io, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(60);
/// How long output must stay quiet before the screen is read.
const QUIET: Duration = Duration::from_millis(300);

/// Bindings for the widgets emacs mode leaves unbound.
const BINDS: &str =
	"bindkey -e\nbindkey '^Xf' emacs-forward-word\nbindkey '^Xb' emacs-backward-word\nbindkey \
	 '^Xd' delete-word\nbindkey '^Xh' backward-delete-word\nbindkey '^Xt' \
	 gosmacs-transpose-chars\nbindkey '^Xk' kill-region\nbindkey '^Xa' deactivate-region\nbindkey \
	 '^Xl' backward-kill-line\nbindkey '^Xc' copy-prev-shell-word\nbindkey '^Xp' \
	 push-line-or-edit\nbindkey '^Xi' push-input\nbindkey '^Xn' universal-argument\nbindkey '^XB' \
	 argument-base\nbindkey '^Xy' redo\nbindkey '^Xs' split-undo\nbindkey '^X#' \
	 pound-insert\nbindkey '^[^M' self-insert-unmeta\n";

/// `zsh -f -i` with `PS1`/`RPS1` and the rc file (the bindings, then
/// `rc`), sourced with `.` as the first command since `-f` skips
/// `.zshrc`.
fn spawn(real: bool, rc: &str) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	s.args(["-f", "-i"])
		.env("PS1", "%~ %# ")
		.env("RPS1", "[%?]")
		.env_remove("EDITOR")
		.env_remove("VISUAL")
		.rc_file(".zshrc", format!("{BINDS}{rc}"))
		.size(24, 80)
}

/// Type `text` key by key.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

/// Run `drive` against both shells after sourcing the rc file; the final
/// screens (`None` for zsh when it is not installed).
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

/// Assert both screens are the same after typing each of `lines`.
fn same(rc: &str, lines: &[&str]) {
	let drive = |pty: &mut Pty| -> io::Result<()> {
		for l in lines {
			keys(pty, l)?;
		}
		Ok(())
	};
	let (ours, real) = match screens(rc, drive) {
		Ok(s) => s,
		Err(e) => panic!("pty session failed: {e}"),
	};
	if let Some(real) = real {
		assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
	}
}

#[test]
fn word_motions_and_wordchars() {
	same("", &[
		// M-f, M-f, M-2 M-b, M-- M-f (backwards), M-b M-b from the end.
		"echo foo/bar baz.qux-1 x\x01\x1bf,\x1bf,\x1b2\x1bb,\x1b-\x1bf,\x05\x1bb\x1bb!\r",
		// emacs-forward-word / emacs-backward-word with counts.
		"echo aa bb cc dd\x01\x18f,\x1b2\x18f,\x05\x18b,\x1b-\x1b2\x18b,\r",
		"WORDCHARS=''\r",
		"echo foo/bar baz.qux\x1bb,\x1bb,\x05\x1b\x08\x1b\x08\r",
	]);
}

#[test]
fn select_word_style_widgets() {
	// The shell-function word widgets (`forward-word-match` & co. through
	// `match-words-by-style`), styles set by `select-word-style` (zstyle).
	let rc = "autoload -Uz select-word-style\nselect-word-style bash\n";
	same(rc, &[
		"echo foo/bar-baz qux\x1bb,\x1bb,\x05\x17\r",
		"select-word-style shell\r",
		"echo 'a b' c\x1bb,\x1bb,\x05\x1b\x08\r",
		"zstyle ':zle:*' word-style space\r",
		"echo foo/bar baz\x1bb,\x01\x1bf,\r",
	]);
}

#[test]
fn word_kills_and_deletes() {
	same("", &[
		// Two backward-kill-words append to one kill; M-d; yank twice.
		"echo one two three four\x1b\x08\x17\x01\x1bf\x1bd\x19\x19\r",
		// A count, then yank and yank-pop through the ring.
		"echo aa bb cc\x01\x1bf\x1b2\x1bd\x19\x1by,\r",
		// delete-word and backward-delete-word do not touch the kill ring.
		"echo aa bb cc\x18h\x01\x1bf\x18d\x19\r",
		"echo x y z\x1b-\x1bd,\x1b-\x17,\r",
	]);
}

#[test]
fn case_changes() {
	same("", &[
		"echo hello wORLD 3rd\x01\x1bf\x1bu\x1bl\x1bc,\x05\x1b-\x1b2\x1bu,\r",
		"echo élan ÉTÉ\x01\x1bf\x1bc\x1bc,\r",
	]);
}

#[test]
fn transposes() {
	same("", &[
		"echo aa bb cc\x1bt,\x02\x02\x02\x02\x02\x02\x1b2\x1bt,\r",
		"echo aa bb\x01\x1b-\x1bt,\r",
		"echo abc\x14\x02\x02\x14,\x1b3\x14\r",
		"echo abc\x18t\x01\x18t,\r",
	]);
}

#[test]
fn region_widgets() {
	same("", &[
		// set-mark, copy-region-as-kill, yank.
		"echo one two three\x01\x1bf\x00\x1bf\x1bw\x05 \x19\r",
		// exchange-point-and-mark.
		"echo one two\x01\x1bf\x00\x05\x18\x18,\r",
		// quote-region, kill-region.
		"echo a 'b' c\x02\x02\x02\x02\x02\x00\x05\x1b\",\r",
		"echo one two three\x01\x1bf\x00\x1bf\x18k\x05 \x19\r",
		// A deactivated region is still the region for kill-region.
		"echo one two\x01\x1bf\x00\x1bf\x18a\x18k,\r",
		// quote-line.
		"echo it's\x1b'\r",
	]);
}

#[test]
fn whole_line_kills() {
	same("", &[
		"echo abc def\x02\x02\x18l\x19\x19\r",
		"junk\x15echo ok\r",
		"junk\x0bx\x18\x0becho kb\x01\x19\r",
		"echo a\x1b\rb\x1b\rc\x02\x02\x02\x18l\x18l,\r",
		"echo a\x1b\rb\x1b\rc\x1b\x30\x0b,\r",
	]);
}

#[test]
fn copy_prev_words() {
	same("", &[
		"echo foo-bar baz \x1b\x1f\x1b3\x1b\x1f\r",
		"echo 'a b' c \x18c\r",
		"echo 'a b' \"c d\"\x1b2\x18c\x02\x02\x02\x02\x18c\r",
	]);
}

#[test]
fn accept_and_hold() {
	same("", &["echo held\x1ba", "\x05!\r"]);
}

#[test]
fn push_line_and_get_line() {
	same("", &["echo second\x11echo first\r", "\r", "abc\x11xyz\x1bg\x01echo \r"]);
}

#[test]
fn push_line_or_edit_on_a_continuation_line() {
	same("", &["if true\rthen echo hi\x18p", "\rfi\r", "echo $?\r"]);
}

#[test]
fn push_input_on_a_continuation_line() {
	same("", &["if true\rthen echo in\x18i", "\r", " ; fi\r"]);
}

#[test]
fn accept_line_and_down_history() {
	same("", &["echo h1\r", "echo h2\r", "\x10\x10\x0f", "\r"]);
}

#[test]
fn overwrite_mode() {
	same("", &["echo abcdef\x01\x1bf\x14\x18\x0fXY\x18\x0fZ\r"]);
}

#[test]
fn numeric_arguments() {
	same("", &[
		"echo \x1b1\x1b2x\r",
		"echo \x18na\x18n\x18nb\x18n3c\r",
		"echo \x1b-\x1b-x,\x1b-2\x08,\r",
		"echo \x1b1\x1b6\x18B\x1b1\x1b0y\r",
		"echo 12345\x1b3\x1b-\x08\r",
	]);
}

#[test]
fn undo_redo_and_split_undo() {
	same("", &[
		"echo abc\x17xyz\x1f,\x1f\x18y\x18y\r",
		"echo one two\x1b\x08\x1b\x08\x18u\x18u\x1f\r",
		"echo a\x18sb\x1f\r",
	]);
}

#[test]
fn execute_named_cmd() {
	same("", &[
		// A unique prefix completes on accept.
		"echo aa bb\x01\x1bxforward-wo\r,\x1bz,\r",
		// Space completes as far as it is unique; ^D lists the matches.
		"\x1bxkill-\x04",
		"\x07",
		"\x1bxup \x07",
		"\x1bxkill-w\x17\x08\x08",
		"\x07echo end\r",
		// Every name: too many for the screen, so zsh asks first.
		"\x1bx\x04",
		"n",
		"\x04",
		"y",
		"\x07echo after\r",
	]);
}

#[test]
fn execute_named_cmd_listing_options() {
	// The name list laid out packed, rows first, and without
	// ALWAYS_LAST_PROMPT; AUTO_LIST off lists only on request.
	same("setopt listpacked\n", &[
		"\x1bxvi-\x04",
		"\x07setopt listrowsfirst\r",
		"\x1bxhistory-\x04",
		"\x07setopt noalwayslastprompt noautolist\r",
		"\x1bxkill-\t",
		"\x04",
		"\x07echo end\r",
	]);
}

#[test]
fn execute_named_cmd_from_vi_command_mode() {
	// `:` in vicmd reads the name in `main` (viins), where `vi-cmd-mode`
	// accepts it; the keymap goes back to vicmd afterwards.
	same("bindkey -v\n", &["echo abc\x1b:backward-ch\x1bx", "i,\r", "\x1b:nosuch\x1b\x07", "i,\r"]);
}

#[test]
fn where_is_and_describe_key() {
	same("", &[
		"\x1bxwhere-is\rforward-word\r",
		"\x1bxwhere-is\rredo\r",
		"\x1bxdescribe-key-briefly\r\x1bf",
		"echo é\x02\x18=",
		"\x15\x05\x18=",
		"\x15echo done\r",
	]);
}

#[test]
fn which_command_and_run_help() {
	same("alias run-help=print\n", &["ls -l\x1b?", "\x15echo a; print -r x\x1bh", "\r"]);
}

#[test]
fn bracketed_paste() {
	same("", &[
		"echo \x1b[200~pasted 'text'\x1b[201~\r",
		"echo \x1b2\x1b[200~a b\x1b[201~\r",
		"echo one two\x01\x1bf\x00\x1bf\x1b[200~X\x1b[201~,\x19\r",
		"\x1bx\x1b[200~beep\x1b[201~\r",
		"\x15echo done\r",
	]);
}

#[test]
fn zle_bracketed_paste_parameter() {
	// The strings written around each line edit (shown as text here).
	same("", &[
		"zle_bracketed_paste=(X Y)\r",
		"echo b\r",
		"unset zle_bracketed_paste\r",
		"echo c\x1b[200~d\x1b[201~\r",
	]);
}

#[test]
fn bracketed_paste_magic() {
	// `bracketed-paste-magic` replays the paste through `zle -U`,
	// `.read-command` and `.self-insert`, with `split-undo` and `.undo`.
	// Sourced: the file only defines the functions.
	let rc = "source /usr/share/zsh/5.9/functions/bracketed-paste-magic\nzle -N bracketed-paste \
	          bracketed-paste-magic\nzstyle ':bracketed-paste-magic' active-widgets '.self-*' \
	          'backward-kill-word'\n";
	same(rc, BPM_KEYS);
}

/// Pastes with an active widget inside, then one undone.
const BPM_KEYS: &[&str] =
	&["echo \x1b[200~pasted 'text' \x17ok\x1b[201~,\r", "echo x\x1b[200~ab\x1b[201~\x1f,\r"];

#[test]
fn bracketed_paste_magic_autoloaded() {
	// As users set it up: the autoloaded file calls the function on its
	// first load (`$zsh_eval_context` ends in `loadautofunc`).
	let rc = "autoload -Uz bracketed-paste-magic\nzle -N bracketed-paste \
	          bracketed-paste-magic\nzstyle ':bracketed-paste-magic' active-widgets '.self-*' \
	          'backward-kill-word'\n";
	same(rc, BPM_KEYS);
}

#[test]
fn delete_to_char_and_zap_to_char() {
	let rc = "zmodload zsh/deltochar\nbindkey '^Xz' zap-to-char\nbindkey '^Xx' delete-to-char\n";
	same(rc, &[
		"echo abcabc\x01\x1bf\x18zb,\x18xc,\x19\r",
		"echo abcabc\x1b-\x1b2\x18xa,\r",
		"echo abc\x01\x18zq,\r",
	]);
}

#[test]
fn magic_space_and_expand_history() {
	// X03zlebindkey: magic-space on lines whose history expansion fails.
	let rc = "bindkey ' ' magic-space\n";
	same(rc, &[
		"echo hist1\r",
		"!! foo\r",
		"echo !!:1\x1b!,\r",
		"setopt interactivecomments\r",
		"echo $(( x ) x ) y\x15",
		"echo $(( ##x ) ##x ) y\x15",
		"unsetopt interactivecomments\r",
		"echo $(( x ) x ) y\x15",
		"echo $(( ##x ) ##x ) y\x15",
		"echo !nosuchevent\x1b!,\r",
	]);
}

#[test]
fn pound_insert_and_unmeta() {
	same("", &["echo commented\x18#", "\x10\x18#", "echo a\x1b\rb\r"]);
}

#[test]
fn read_command_from_a_widget() {
	let rc = "rcw() { zle read-command; BUFFER+=\"<$REPLY>\" }\nzle -N rcw\nbindkey '^Xq' rcw\n";
	same(rc, &["echo \x18q\x01\x18q\x1bx\r"]);
}
