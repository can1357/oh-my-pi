//! vi mode of the line editor (`bindkey -v`) of `obash` invoked as
//! `zsh -f -i`, against the real `/bin/zsh -f -i` on a pty: the cases of
//! zsh 5.9's `Test/X02zlevi.ztst` (their expected `BUFFER`/`CURSOR`
//! checked on our screen) plus display cases (visual mode regions,
//! `vi-quoted-insert`, `vi-caps-lock-panic`). For every case the screen
//! with the edited line and the screen with the result must match zsh's.
//!
//! As upstream, the cases of a group run one after another in one shell
//! (registers, the last change, marks carry over); a finishing widget
//! bound to `^X` prints the buffer (tabs and newlines as `\t`, `\n`) and the
//! cursor.

#![cfg(unix)]

mod pty_support;

use std::{io, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(25);
/// How long output must stay quiet before the screen is read: longer
/// than `KEYTIMEOUT` (0.4 s), which a trailing escape waits for before
/// the display catches up.
const QUIET: Duration = Duration::from_millis(600);

/// The rc file: vi mode and the finishing widget (X02's `comptest`
/// `zle-finish`).
const RC: &str = "bindkey -v\nzle-finish() {\nlocal b=$BUFFER c=$CURSOR\nBUFFER=\nzle -I\nprint \
                  -r -- \"BUFFER: ${${b//$'\\t'/\\\\t}//$'\\n'/\\\\n}\"\nprint -r -- \"CURSOR: \
                  $c\"\nzle accept-line\n}\nzle -N zle-finish\nbindkey '^X' zle-finish\nbindkey \
                  -a '^X' zle-finish\n";

/// One `zletest`.
struct Case {
	/// Its X02 description.
	name:   &'static str,
	/// A command line run first (X02's `zpty_run`), if any.
	setup:  &'static str,
	/// The keys.
	keys:   String,
	/// The expected buffer (`None`: only compared with zsh).
	buffer: Option<&'static str>,
	/// The expected cursor.
	cursor: usize,
	/// Keys typed after the edited screen is taken (ending a wait the
	/// keys left the editor in).
	then:   &'static str,
}

fn case(name: &'static str, keys: impl Into<String>, buffer: &'static str, cursor: usize) -> Case {
	Case { name, setup: "", keys: keys.into(), buffer: Some(buffer), cursor, then: "" }
}

fn setup_case(
	name: &'static str,
	setup: &'static str,
	keys: impl Into<String>,
	buffer: &'static str,
	cursor: usize,
) -> Case {
	Case { name, setup, keys: keys.into(), buffer: Some(buffer), cursor, then: "" }
}

/// A case compared with zsh only.
fn diff_case(name: &'static str, setup: &'static str, keys: impl Into<String>) -> Case {
	Case { name, setup, keys: keys.into(), buffer: None, cursor: 0, then: "" }
}

/// [`diff_case`] whose keys leave the editor waiting; `then` ends it.
fn wait_case(name: &'static str, setup: &'static str, keys: &str, then: &'static str) -> Case {
	Case { name, setup, keys: keys.into(), buffer: None, cursor: 0, then }
}

/// zsh brace expansion of `pre{a,b,…}post` as separate arguments joined.
fn brace(pre: &str, items: &[&str], post: &str) -> String {
	items.iter().map(|i| format!("{pre}{i}{post}")).collect()
}

/// Type `text` key by key, then wait for the output to settle.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

fn spawn(real: bool) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	s.args(["-f", "-i"])
		.env("PS1", "%# ")
		.rc_file(".zshrc", RC)
		.rc_file("textobjects.zsh", TEXTOBJECTS)
		.size(24, 80)
}

/// The shell-function text objects of zsh's `Functions/Zle`
/// (`select-quoted`, `select-bracketed`, `surround`), bound as their
/// documentation says; sourced by the cases that use them.
const TEXTOBJECTS: &str =
	"fpath=(/usr/share/zsh/5.9/functions /usr/share/zsh/functions/Zle $fpath)\nautoload -U \
	 select-bracketed select-quoted surround\nzle -N select-bracketed; zle -N select-quoted\nzle \
	 -N delete-surround surround; zle -N add-surround surround; zle -N change-surround \
	 surround\nfor m in visual viopp; do\nfor c in {a,i}{\\',\\\",\\`}; do bindkey -M $m $c \
	 select-quoted; done\nfor c in {a,i}${(s..)^:-'()[]{}<>bB'}; do bindkey -M $m $c \
	 select-bracketed; done\ndone\nbindkey -a cs change-surround; bindkey -a ds delete-surround; \
	 bindkey -a ys add-surround\nbindkey -M visual S add-surround\n";

/// The screens of one case: with the line edited, with the result.
type Shots = Vec<(String, String)>;

fn drive(pty: &mut Pty, cases: &[Case]) -> io::Result<Shots> {
	let mut shots = Vec::with_capacity(cases.len());
	pty.settle(QUIET, TIMEOUT)?;
	keys(pty, ". ~/.zshrc\r")?;
	keys(pty, "\x0c")?;
	for c in cases {
		if !c.setup.is_empty() {
			keys(pty, c.setup)?;
			keys(pty, "\r")?;
			keys(pty, "\x0c")?;
		}
		keys(pty, &c.keys)?;
		let mid = pty.screen().contents();
		if !c.then.is_empty() {
			keys(pty, c.then)?;
		}
		keys(pty, "\x18")?;
		let after = pty.screen().contents();
		keys(pty, "\x0c")?;
		shots.push((mid, after));
	}
	Ok(shots)
}

/// `buffer` as the finishing widget prints it.
fn visible(buffer: &str) -> String {
	buffer.replace('\t', "\\t").replace('\n', "\\n")
}

/// Whether `screen` shows the finishing widget's report: a row ending in
/// `BUFFER: …` (it prints where the emptied line's cursor is), the next
/// `CURSOR: n`.
fn reports(screen: &str, buffer: &str, cursor: usize) -> bool {
	let want_b = format!("BUFFER: {}", visible(buffer));
	let want_c = format!("CURSOR: {cursor}");
	let rows: Vec<&str> = screen.lines().map(str::trim_end).collect();
	rows
		.windows(2)
		.any(|w| w[0].ends_with(&want_b) && w[1] == want_c)
}

/// Run `cases` in one obash session (and one zsh session when zsh is
/// installed); check the expected results and the screens.
fn run(cases: &[Case]) {
	let mut runs: Vec<Shots> = Vec::with_capacity(2);
	let res = if have_real_zsh() {
		differential(spawn(false), spawn(true), |pty| {
			runs.push(drive(pty, cases)?);
			Ok(())
		})
		.map(drop)
	} else {
		spawn(false)
			.spawn()
			.and_then(|mut pty| drive(&mut pty, cases))
			.map(|s| runs.push(s))
	};
	if let Err(e) = res {
		panic!("pty session failed: {e}");
	}
	let ours = &runs[0];
	let mut failures = Vec::new();
	for (i, c) in cases.iter().enumerate() {
		if let Some(b) = c.buffer
			&& !reports(&ours[i].1, b, c.cursor)
		{
			failures.push(format!(
				"{}: want BUFFER: {} CURSOR: {}\n--- obash screen:\n{}",
				c.name,
				visible(b),
				c.cursor,
				ours[i].1
			));
		}
		if let Some(real) = runs.get(1) {
			if ours[i].0 != real[i].0 {
				failures.push(format!(
					"{}: edited screen differs\n--- obash:\n{}\n--- zsh:\n{}",
					c.name, ours[i].0, real[i].0
				));
			}
			if ours[i].1 != real[i].1 {
				failures.push(format!(
					"{}: result screen differs\n--- obash:\n{}\n--- zsh:\n{}",
					c.name, ours[i].1, real[i].1
				));
			}
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn x02_changes_and_joins() {
	run(&[
		case("change last character in buffer", "goox\x1bcld", "good", 4),
		case("change forward to matching bracket", "{ ({[}]) }\x1b0c%chg", "chg", 3),
		case("delete backwards to matching bracket", "s( match )\x1bd%", "s", 0),
		case("delete empty line", "one\x1bo\x1bdd", "one", 0),
		case("yank and paste blank line", "1\x1bo\x1byya2\x1bpa3", "1\n2\n3", 5),
		setup_case(
			"swap case on a blank line",
			"bindkey -r \"\\e~\"",
			"\x1b~aI\x1b~o\x1b~",
			"i\n",
			2,
		),
		case(
			"replace character when at end of buffer or newline",
			"\x1bOword\x1bO\x1braok\x1bjrxj.rae",
			"ok\nwxrd\ne",
			9,
		),
		case("replace acts like insert at newline", "two\x1bOone\x1bhRreplace", "oreplace\ntwo", 8),
		case(
			"join lines with line count",
			" four\x1bO\x16\tthree\x1bO  two\x1bOone\x1b3J",
			"one two three\n four",
			7,
		),
		case("join more lines than possible", "two\x1bOone\x1b3J", "one two", 3),
	]);
}

#[test]
fn x02_indent_and_yank() {
	run(&[
		case("don't indent blank lines", "fi\x1bO\x1bOif\x1b2>j", "\tif\n\n\tfi", 1),
		case("additional indentation", "\x16\ti\x1b>>", "\t\ti", 2),
		case("indent with one character on final line", "one\x1box\x1b>k", "\tone\n\tx", 1),
		case("yank left moves the cursor", "one two\x1byb", "one two", 4),
		case("yank right leaves the cursor", "one two\x1b0ye", "one two", 0),
		case(
			"yank up line moves cursor up but not to buffer start",
			"short\x1boand longer\x1byk",
			"short\nand longer",
			4,
		),
		case("yank down line leaves the cursor", "one\x1botwo\x1bkyj", "one\ntwo", 2),
		case("yank up clears lastcol", "long\x1bo  s\x1bolong\x1bkjy-k", "long\n  s\nlong", 2),
		case("yank up honours lastcol", "long\x1bos\x1bklljyk", "long\ns", 2),
		case("delete up clears lastcol", "long\x1bolong\x1bo  s\x1bolong\x1bkjd-k", "long\nlong", 0),
	]);
}

#[test]
fn x02_repeat_and_registers() {
	run(&[
		case(
			"repeat replace chars at the end of the line consumes the replace char",
			"one two\x1b03rX$.",
			"XXX two",
			6,
		),
		case(
			"numeric argument to repeat replaces change count",
			"one two three\x1b02rxw3.w.",
			"xxe xxx xxxee",
			10,
		),
		case(
			"numeric args to both action and movement are multiplied (and saved for any repeat)",
			"one two three four five six seven eight\x1b.03d2wk.1.",
			"eight\nseven eight",
			0,
		),
		case(
			"paste register 1 to get last deletion",
			"yankee doodle\x1bbhDyy0\"1P",
			" doodleyankee",
			6,
		),
		case(
			"paste register 0 to get last yank",
			"yankee\x1byyodoodle\x1bdd\"0p",
			"yankee\nyankee",
			7,
		),
		case(
			"setting named register also sets unnamed register",
			"err\x1bddahello\x1b\"hddP",
			"hello\n",
			0,
		),
		case(
			"appending to named register",
			"first\x1b\"ay0ddasecond\x1b\"Add\"aP",
			"firs\nsecond\n",
			0,
		),
		case("set one and then a different register", "word\x1b\"a\"byy\"bp", "word\nword", 5),
		case("set register then set black hole register", "i\x1bxaar\x1b0\"a\"_cewn\x1bP", "win", 1),
		case("reset register after selecting black hole", "double\x1byy\"_\"0P", "double\ndouble", 0),
		case(
			"retrieve unnamed register after appending",
			"first\x1b\"addasecond\x1bddP",
			"second\n",
			0,
		),
		case(
			"repeat advances to next killring register",
			"123456789\x1bxxxxxxxxx\"1P.........",
			"9987654321",
			0,
		),
		case(
			"yank and delete to black hole register",
			"Z\x1bxayankee doodle\x1b\"_db0\"_yeP",
			"Zyankee e",
			0,
		),
		case("paste from black hole register and repeat", "foo\x1bddabar\x1b\"_p..", "bar", 2),
		case("repeat paste from named register", "start\x1bFa\"ac2lnew\x1bX\"ap..", "stnwararart", 9),
	]);
}

#[test]
fn x02_yank_pop() {
	run(&[
		setup_case(
			"line based put before followed by character based yank-pop",
			"bindkey -a \"^P\" yank-pop",
			"word\x17line\x1bddiSE\x1bP\x10",
			"SwordE",
			4,
		),
		case(
			"character based put before followed by line based yank-pop",
			"line\x1bddiword\x17\x1biSE\x1bP\x10",
			"line\nSE",
			0,
		),
		case(
			"put after cycled twice with yank-pop",
			"one two three\x17\x17\x17SE\x1b0p\x10\x10",
			"SthreeE",
			5,
		),
		case(
			"line based put after followed by character based yank-pop",
			"word\x17line\x1bddiSE\x1bhp\x10",
			"SwordE",
			4,
		),
		case(
			"character based after before followed by line based yank-pop",
			"line\x1bddiword\x17\x1biSE\x1bhp\x10",
			"SE\nline",
			3,
		),
	]);
}

#[test]
fn x02_undo_and_initial_edit() {
	run(&[
		case("undo initial change", "word\x1buaend", "end", 3),
		case("repeat initial edit", "text\x1b.", "text\ntext", 8),
		setup_case(
			"repeat initial edit with non-blank starting line",
			"print -z before",
			"after\x1b.",
			"beforeafterafter",
			15,
		),
		setup_case(
			"repeat initial edit with overstrike set",
			"setopt overstrike;print -z bung",
			"ing\x1b2|.",
			"binging",
			3,
		),
		// As upstream, `overstrike` stays set from here on.
		case(
			"use of vi-repeat as the motion and repeat after a failed change",
			"worm\x1brdhd..",
			"wodd",
			2,
		),
		setup_case("use of undo in vi insert mode", "bindkey \"^_\" undo", "undoc\x1fe", "undoe", 5),
		case(
			"vi mode undo of initial and subsequent change",
			"one\x1buatwo\x1b0clthree",
			"threewo",
			5,
		),
		case("undo invoked twice", "xxx\x1buiyyy\x1buAz", "z", 1),
		setup_case(
			"undo in insert mode, redo in command",
			"bindkey -a \"^K\" redo",
			"123\x1f\x1b\x0b",
			"123",
			2,
		),
		setup_case(
			"undo and redo in insert mode, undo in command",
			"bindkey \"^Y\" redo",
			"pre\x1bA123\x1f\x19\x1bu",
			"pre",
			2,
		),
		case(
			"undo starting with a next change in the change list",
			"two\x1bOone\x1bo\x1buo\x1bu",
			"one\ntwo",
			2,
		),
		setup_case(
			"split the undo sequence",
			"bindkey \"^Gu\" split-undo",
			"one\x07utwo\x1bu",
			"one",
			2,
		),
	]);
}

#[test]
fn x02_marks_and_forced_motions() {
	run(&[
		case("setting mark and returning to original position", "one two\x1bbmt3|`tx``", "one wo", 2),
		case(
			"force character-wise change to join lines",
			"keepnot\x1bo  unwanted\x1bkhhcvj ",
			"keep wanted",
			5,
		),
		case(
			"character-wise delete to beginning of line leaves the newline",
			"}\x1bOkeep{del\x1bF{dvj",
			"keep\n}",
			3,
		),
		case("force line-wise delete of line", "keep\x1bOdel\x1bdVh", "keep", 0),
		case("line-wise force of a text object", "one two three\x1bFwdVawaX", "X", 1),
	]);
}

#[test]
fn x02_visual_mode() {
	run(&[
		case("change selection", "one two\x1bvbcx", "one x", 5),
		case(
			"change character wise selection with C acts linewise",
			"four\x1bOthree\x1bOtwo\x1bOone\x1bvjjhCnew",
			"new\nfour",
			3,
		),
		case("x kills selections", "x testing\x1bhvbx", "x g", 2),
		case(
			"replace characters in selections",
			"line end\x1bOstart 1 back new\x1b0verawvrbwevbrcwvj0erdwv$re",
			"aaaaa b cccc dddddddd eee",
			24,
		),
		case("put over selection at start of buffer", "one two\x1byb0vep", "tw two", 1),
		case("put over selection at end of buffer", "hello\x17bye\x1bvhp", "bhello", 5),
		case("yank empty selection", "old\x17\x1bvyvP", "old", 2),
		case("delete empty selection", "old\x17\x1bvdvP", "old", 2),
		case(
			"yank linewise and put over linewise selection at start of buffer",
			"one\x1botwo\x1byykVp",
			"two\ntwo",
			0,
		),
		case(
			"yank linewise and put over linewise selection in middle of buffer",
			"one\x1botwo\x1bothree\x1byykVp",
			"one\nthree\nthree",
			4,
		),
		case(
			"yank linewise and put over linewise selection at end of buffer",
			"two\x1bOone\x1byyjVp",
			"one\none",
			4,
		),
		case("yank character-wise and put over linewise selection", "one\x1byhVp", "n", 0),
		case(
			"yank linewise and put over character-wise selection at start of buffer",
			"one\x1botwo\x1byy0kvlp",
			"two\ne\ntwo",
			0,
		),
		case(
			"yank linewise and put over character-wise selection in middle of buffer",
			"one\x1byyhvp",
			"o\none\ne",
			2,
		),
		case(
			"yank linewise and put over character-wise selection at end of buffer",
			"two\x1bOone\x1byyjvhp",
			"one\nt\none",
			6,
		),
		case(
			"paste last (9th) register over a selection",
			"abc123456789\x1bxxxxxxxxxhv\"9p0P",
			"ba9c",
			0,
		),
		case("delete blank line using selection", "one\x1bo\x1bo\x1botwo\x1bkkVdvd", "one\ntwo", 4),
		case("toggle case of selection", "One Two Three\x1b2bvw~", "One tWO three", 4),
	]);
}

/// The buffer the word-motion cases start from (X02).
const WORDS_BACK: &str = " --ww  ww--\x1bo\x1boww\x1bo\x1bo--\x1bo\x1bo  ww\x1b";
const WORDS_FWD: &str = "  ww\x1bO\x1bO--\x1bO\x1bOww\x1bO\x1bO --ww  ww--\x1b0";

#[test]
fn x02_word_motions() {
	run(&[
		case(
			"backward word",
			format!(
				"{WORDS_BACK}{}",
				brace("bi", &["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"], "\x1b")
			),
			"k j--iww  hwwg--\nf\neww\nd\nc--\nb\n  aww",
			0,
		),
		case(
			"backword blank word",
			format!(
				"{WORDS_BACK}{}",
				brace("Bi", &["a", "b", "c", "d", "e", "f", "g", "h", "i"], "\x1b")
			),
			"i h--ww  gww--\nf\neww\nd\nc--\nb\n  aww",
			0,
		),
		case(
			"backward word end",
			format!(
				"{WORDS_BACK}{}",
				brace("gei", &["a", "=", "b", "c", "d", "=", "e", "f", "=", "g"], "\x1b")
			),
			"g -=-wfw  wew-=-\nd\nwcw\nb\n-=-\na\n  ww",
			0,
		),
		case(
			"backward blank word end",
			format!("{WORDS_BACK}{}", brace("gEi", &["=", "b", "=", "d", "e"], "\x1b")),
			"e --wdw  ww-=-\n\nwbw\n\n-=-\n\n  ww",
			0,
		),
		case(
			"forward word",
			format!(
				"{WORDS_FWD}{}",
				brace("wi", &["=", "a", "b", "=", "c", "d", "e", "=", "f", "g"], "\x1b")
			),
			" =--aww  bww=--\nc\ndww\ne\n=--\nf\n  gww",
			32,
		),
		case(
			"forward blank word",
			format!("{WORDS_FWD}{}", brace("Wi", &["=", "a", "b", "c", "d", "=", "e", "f"], "\x1b")),
			" =--ww  aww--\nb\ncww\nd\n=--\ne\n  fww",
			30,
		),
		case(
			"forward word end",
			format!("{WORDS_FWD}{}", brace("ea", &["a", "b", "c", "d", "e", "f", "g"], "\x1b")),
			" --awwb  wwc--d\n\nwwe\n\n--f\n\n  wwg",
			31,
		),
		case(
			"forward blank word end",
			format!("{WORDS_FWD}{}", brace("Ea", &["a", "b", "c", "d", "e"], "\x1b")),
			" --wwa  ww--b\n\nwwc\n\n--d\n\n  wwe",
			29,
		),
		case(
			"word motion with multibyte characters",
			"/あいう/えお/かき\x1bbxgegex0wxex",
			"/い/え/き",
			2,
		),
	]);
}

#[test]
fn x02_text_objects() {
	run(&[
		case(
			"delete all word on blanks",
			"    ----word    ----    word    word----    ----\x1b42|daw30|daw22|daw14|daw2|daw",
			"word",
			0,
		),
		case(
			"delete all word on alphanumerics",
			"    word----word    word----word    word    \x1b38|daw30|daw22|daw14|daw6|daw",
			"    --------",
			4,
		),
		case(
			"delete all word on other characters",
			"    ----word----    ----word----    ----    \x1b38|daw30|daw22|daw14|daw6|daw",
			"    wordword",
			4,
		),
		case("delete all word with numeric argument", "- word word\x1b4|2daw", "-", 0),
		case(
			"all word with existing selection and cursor before mark",
			"----    word    ----word\x1bo    \
			 \x1bo----\x1bodone\x1bhvhawmaawmbawmcawmdawmeawmfawmgv`ara`brb`crc$r$`drd`ere`frf`grg",
			"g---f   worde   ----dord\nc  $\nb---\naone",
			0,
		),
		case(
			"all word with existing selection and mark before cursor",
			"----    word    word----\x1b0lvlawmaawmbawmcawvrd`ara`brb`crc",
			"----   aword   bworc---d",
			19,
		),
		case(
			"in word with existing selection and cursor before mark",
			format!(
				" --ww  ww---\x1bo\x1boww\x1bvhiwiw{}vrE{}",
				brace("m", &["a", "b", "c", "d", "e"], "iw"),
				brace("`", &["a", "b", "c", "d", "e"], "r.")
			),
			"E.-.w. .w.--\n\nww",
			1,
		),
		case(
			"in word with existing selection and mark before cursor",
			format!(
				"  --ww  ww--\x1bO  \x1bv0o{}vrE{}",
				brace("m", &["a", "b", "c", "d", "e"], "iw"),
				brace("`", &["a", "b", "c", "d", "e"], "r.")
			),
			" .\n .-.w. .wE--",
			10,
		),
		case(
			"all argument for different arguments",
			format!(
				"  `one`  $(echo two) \" three \" $'four'\x16\tfive ${{six:-6}}\x1b{}{}",
				brace("vaaom", &["a", "b", "c", "d", "e", "f"], "v"),
				brace("`", &["a", "b", "c", "d", "e", "f"], "rX")
			),
			"X `one`X $(echo two)X\" three \"X$'four'XfiveX${six:-6}",
			0,
		),
		case(
			"in argument for different arguments",
			format!(
				"{{ls `echo x`  $((3+4)) \"a b\" $'\\t\\n' ${{d%/}}\x1b{}",
				brace("cia", &["6", "5", "4", "3", "2", "1"], "\x1bBB")
			),
			"1ls `2`  $(3) \"4\" $'5' ${6}",
			0,
		),
	]);
}

#[test]
fn display_of_vi_editing() {
	// Screens mid-edit: regions (character- and line-wise), the `^` of
	// `vi-quoted-insert`, the operator-pending wait, the caps-lock panic
	// message, `zle-keymap-select` running on mode changes.
	run(&[
		// The region is deactivated before the report: zsh 5.9 dies of
		// SIGBUS when `BUFFER=` empties a line under an active line-wise
		// region.
		wait_case("character-wise region", "", "one two three\x1b0vee", "\x1b"),
		wait_case("line-wise region", "", "one\x1botwo\x1bothree\x1bkV", "\x1b"),
		wait_case(
			"vi-quoted-insert shows a caret",
			"bindkey '^B' vi-quoted-insert",
			"ab\x1bi\x02",
			"\t",
		),
		wait_case(
			"vi-caps-lock-panic message",
			"bindkey -a '^E' vi-caps-lock-panic",
			"abc\x1b\x05",
			"Xa",
		),
		wait_case("operator waiting for its motion", "", "one two\x1b0d", "w"),
		diff_case(
			"zle-keymap-select on mode changes",
			"zle-keymap-select() { RPS1=\"<$KEYMAP:$1>\"; zle reset-prompt }; zle -N \
			 zle-keymap-select",
			"abc\x1bhi",
		),
		diff_case(
			"vi-pound-insert and vi-join",
			"bindkey -a '#' vi-pound-insert",
			"echo a\x1boecho b\x1b#kJ",
		),
		diff_case("finds with repeats", "", "a-b-c-d-e\x1b0f-;;,dt-x"),
		diff_case("marks across lines", "", "one\x1bmaotwo\x1b`ax'aD"),
		diff_case(
			"vi-set-buffer from zle",
			"w() { zle vi-set-buffer q; zle vi-yank-whole-line; }; zle -N w; bindkey -a '^T' w",
			"line\x1b\x14\"qp",
		),
		diff_case(
			"zle -f vichange repeats a user widget",
			"z() { zle -f vichange; LBUFFER+=Z }; zle -N z; bindkey -a 'Z' z",
			"ab\x1bZ..",
		),
	]);
}

#[test]
fn functions_zle_text_objects() {
	run(&[
		diff_case("select-quoted in", ". ~/textobjects.zsh", "echo \"hello world\"\x1b0fwdi\""),
		diff_case("select-quoted all", "", "echo \"hello world\" x\x1b0fwda\""),
		diff_case("select-bracketed change in", "", "f(a, (b c)) z\x1b0fbci(Q\x1b"),
		diff_case("select-bracketed count", "", "f(a, (b c)) z\x1b0fbd2a("),
		diff_case("select-bracketed in visual mode", "", "x [a b] y\x1b0fav2i]d"),
		diff_case("delete-surround", "", "say \"hi there\"\x1b0fhds\""),
		diff_case("change-surround", "", "say \"hi there\"\x1b0fhcs\"'"),
		diff_case("add-surround", "", "say hi\x1b0wysiw)"),
		diff_case("add-surround from visual mode", "", "say hi\x1b0wveS]"),
		diff_case("repeat add-surround", "", "a b\x1b0ysiw]w."),
	]);
}
