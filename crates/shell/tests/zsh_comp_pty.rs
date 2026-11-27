//! Completion on the line editor of `obash` invoked as `zsh -f -i`, pinned
//! to screen snapshots of `/bin/zsh` 5.9 on the same pty session: same rc
//! file, same fixture files and commands, same keys.
//!
//! Each case sources an rc file (fixture directory `~/fx`, fixture commands
//! in `~/bin`, and for compsys cases `compinit -u -D` from zsh 5.9's
//! installed completion functions), clears the screen, then types its
//! steps; after each step it waits for the output to settle and for the
//! step's own screen ([`wait_drawn`]), and records the screen (rows without
//! trailing blanks) and the cursor, and for colour
//! cases the text and SGR sequences the step wrote
//! (`comp_support::sgr_transcript`). The record must equal the snapshot in
//! `tests/fixtures/zsh_comp_pty/<case>.txt`.
//!
//! `PI_COMP_ORACLE=1` runs `/bin/zsh` against the snapshots;
//! `PI_COMP_ORACLE=1 PI_COMP_BLESS=1` rewrites them from `/bin/zsh`.

#![cfg(unix)]

mod comp_support;
mod pty_support;

use std::{
	fmt::Write as _,
	fs, io,
	path::PathBuf,
	thread,
	time::{Duration, Instant},
};

use comp_support::{bless, compsys_fpath, fpath_words, oracle, quiet, sgr_transcript, shell};
use pty_support::{Pty, Screen, Spawn, TIMEOUT};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(60);
/// Bound of the startup and the rc file (obash's `compinit`).
const STARTUP: Duration = Duration::from_secs(60);
/// Bound of one step's output settling.
const STEP: Duration = Duration::from_secs(30);

/// The fixture every case starts from (after `fpath`).
const FIXTURE: &str = "PS1='%# '
mkdir -p ~/fx/dir1 ~/fx/dir2 ~/bin
: >~/fx/file1 >~/fx/file2 >~/fx/foo.c >~/fx/foo.h
for c in fxcmd-one fxcmd-two fxtool; do print '#!/bin/sh' >~/bin/$c; chmod +x ~/bin/$c; done
path=( ~/bin /bin /usr/bin )
cd ~/fx
";

/// What a case starts with besides the fixture.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Setup {
	/// `compinit -u -D` (the completion system).
	Compsys,
	/// Only the rc text (completion widgets of the case's own).
	Bare,
}

/// What each step records.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Record {
	/// Screen and cursor.
	Screen,
	/// Screen, cursor and the colour transcript of the step's output.
	Colours,
}

fn snapshot_path(name: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/zsh_comp_pty/{name}.txt"))
}

/// Type `keys` and wait for the output to settle.
fn step(pty: &mut Pty, keys: &str) -> io::Result<()> {
	pty.type_keys(keys, KEY)?;
	pty.settle(quiet(), STEP)
}

/// Run the case on the shell under test; the record of its steps, and the
/// first step that missed its screen. With `drawn` (the snapshot's screens,
/// [`drawn`]), each step also waits for its own screen before it is recorded
/// ([`wait_drawn`]).
fn record(
	fpath: &str,
	setup: Setup,
	rc: &str,
	steps: &[&str],
	what: Record,
	drawn: Option<&[Drawn]>,
) -> io::Result<(String, Option<(usize, Miss)>)> {
	let mut rcfile = format!("fpath=( {fpath} )\n{FIXTURE}");
	if setup == Setup::Compsys {
		rcfile.push_str("autoload -U compinit; compinit -u -D\n");
	}
	rcfile.push_str(rc);
	rcfile.push_str("\nprint -r -- RE''ADY\n");
	let mut pty = shell()
		.args(["-f", "-i"])
		.env("PS1", "%# ")
		.env("LC_ALL", "en_US.UTF-8")
		.rc_file(".zshrc", rcfile)
		.size(24, 80)
		.spawn()?;
	pty.read_until("%", STARTUP)?;
	pty.settle(quiet(), STARTUP)?;
	pty.type_keys(". ~/.zshrc\r", Duration::from_millis(20))?;
	pty.read_until("READY", STARTUP)?;
	pty.settle(quiet(), STARTUP)?;
	// A clean screen for the case itself.
	step(&mut pty, "\x0c")?;
	let mut text = String::new();
	let mut missed = None;
	for (i, keys) in steps.iter().enumerate() {
		let start = pty.output().len();
		step(&mut pty, keys)?;
		// Once one step misses, the later ones do not wait: the case fails.
		let miss = match drawn.and_then(|d| d.get(i)) {
			Some(want) if missed.is_none() => wait_drawn(&mut pty, want, DRAWN)?,
			_ => None,
		};
		let screen = recorded(&mut pty, miss);
		let (row, col) = screen.cursor();
		let _ = write!(text, "### {keys:?}\n{}\n@ {row},{col}\n", screen.contents());
		if what == Record::Colours {
			let out = pty.output();
			let _ = write!(text, "--- sgr\n{}\n", sgr_transcript(out.get(start..).unwrap_or(&out)));
		}
		if let Some(miss) = miss {
			missed = Some((i, miss));
		}
	}
	Ok((text, missed))
}

/// Record the case and compare it with (or, blessing, write) its snapshot.
fn check(name: &str, setup: Setup, rc: &str, steps: &[&str], what: Record) {
	let Some(fpath) = compsys_fpath() else {
		eprintln!("skipped: zsh 5.9 completion functions are not installed");
		return;
	};
	let path = snapshot_path(name);
	// Blessing writes the snapshot, so it has none to wait for.
	let want = (!bless()).then(|| {
		fs::read_to_string(&path).unwrap_or_else(|e| {
			panic!("{}: {e} (write it with PI_COMP_ORACLE=1 PI_COMP_BLESS=1)", path.display())
		})
	});
	let screens = want
		.as_deref()
		.and_then(drawn)
		.filter(|d| d.len() == steps.len());
	let (got, missed) =
		match record(&fpath_words(&fpath), setup, rc, steps, what, screens.as_deref()) {
			Ok(record) => record,
			Err(e) => panic!("pty session failed: {e}"),
		};
	let Some(want) = want else {
		assert!(oracle(), "PI_COMP_BLESS needs PI_COMP_ORACLE (snapshots come from /bin/zsh)");
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(&path, &got).unwrap();
		return;
	};
	let why = missed.map_or_else(String::new, |(i, miss)| {
		let how = match miss {
			Miss::Late => format!("did not draw the snapshot's screen within {DRAWN:?}"),
			Miss::Changed => {
				format!(
					"drew the snapshot's screen after its output settled, and it changed within \
					 {HOLD:?}"
				)
			},
		};
		format!("step {} ({:?}) {how}; the later steps did not wait\n", i + 1, steps[i])
	});
	assert!(
		missed.is_none() && got == want,
		"{name}: the screens differ from zsh 5.9's\n{why}--- zsh 5.9:\n{want}\n--- got:\n{got}"
	);
}

/// Bound of a step's wait for its screen ([`wait_drawn`]). The latest drawing
/// measured under a loaded test run came at least 0.97 s after the step's
/// quiet window; a screen that never comes costs each failing case this once.
const DRAWN: Duration = Duration::from_secs(10);

/// How long a step's screen first seen after the step's output settled must
/// then stay as the snapshot has it ([`wait_drawn`]). A change in that time
/// fails the case; this can fail a case, never pass one.
const HOLD: Duration = Duration::from_millis(400);

/// How a step missed its screen ([`wait_drawn`]); a miss fails the case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Miss {
	/// The screen did not come within the bound.
	Late,
	/// The screen came after the step's output settled, and changed within
	/// [`HOLD`].
	Changed,
}

/// Wait for a step's own screen, `want` (the screen and cursor the snapshot
/// holds for the step), once [`step`] has returned: `None` when the step
/// shows it, else how the step missed it, [`Pty::last_screen`] being the
/// screen that missed.
///
/// `step` returns when its own wait ends, and that wait does not look at the
/// screen: under a loaded test run obash drew a command-name completion after
/// `step` had returned, in one measured attempt at least 0.97 s after the
/// step's output had been quiet for 400 ms. This is not a wait for the shell
/// to be ready for the next key; it waits for what this step draws, for at
/// most `bound`. Only the screen `step` saw counts as drawn at once: a screen
/// first seen after it must stay for [`HOLD`]. An error of a wait other than
/// its timeout (a terminal reply that could not be sent) is the session's.
fn wait_drawn(pty: &mut Pty, want: &Drawn, bound: Duration) -> io::Result<Option<Miss>> {
	let shows = |s: &Screen| s.contents() == want.contents && s.cursor() == want.cursor;
	if shows(pty.last_screen()) {
		return Ok(None);
	}
	if timed_out(pty.wait_screen(bound, shows))? {
		return Ok(Some(Miss::Late));
	}
	if timed_out(pty.wait_screen(HOLD, |s| !shows(s)))? {
		Ok(None)
	} else {
		Ok(Some(Miss::Changed))
	}
}

/// Whether a wait ([`Pty::wait_screen`]) timed out; its other errors.
fn timed_out(wait: io::Result<()>) -> io::Result<bool> {
	match wait {
		Ok(()) => Ok(false),
		Err(e) if e.kind() == io::ErrorKind::TimedOut => Ok(true),
		Err(e) => Err(e),
	}
}

/// The screen a step records: after a miss the screen that missed
/// ([`wait_drawn`]), not output that came later; else the screen with all
/// output so far.
fn recorded(pty: &mut Pty, miss: Option<Miss>) -> &Screen {
	if miss.is_some() {
		pty.last_screen()
	} else {
		pty.screen()
	}
}

/// What a snapshot says one step leaves on the screen.
struct Drawn {
	/// The rows, as [`record`] writes them.
	contents: String,
	/// The cursor's row and column.
	cursor:   (usize, usize),
}

/// The screen of each step of a snapshot ([`record`]'s format: `### <keys>`,
/// the rows, `@ <row>,<col>`, and for colour cases `--- sgr` and its
/// transcript), in order; `None` when the text does not read as one.
fn drawn(snapshot: &str) -> Option<Vec<Drawn>> {
	let mut starts = Vec::new();
	let mut off = 0;
	for line in snapshot.split_inclusive('\n') {
		if line.starts_with("### \"") {
			starts.push(off);
		}
		off += line.len();
	}
	if starts.first() != Some(&0) {
		return None;
	}
	starts.push(snapshot.len());
	starts
		.array_windows()
		.map(|&[start, end]| {
			let (_, body) = snapshot[start..end].split_once('\n')?;
			let body = body
				.split_once("\n--- sgr\n")
				.map_or(body, |(screen, _)| screen);
			let (contents, at) = body
				.strip_suffix('\n')
				.unwrap_or(body)
				.rsplit_once("\n@ ")?;
			let (row, col) = at.split_once(',')?;
			Some(Drawn {
				contents: contents.to_owned(),
				cursor:   (row.parse().ok()?, col.parse().ok()?),
			})
		})
		.collect()
}

#[test]
fn command_unique() {
	check("command_unique", Setup::Compsys, "", &["ech\t"], Record::Screen);
}

#[test]
fn command_ambiguous_lists_then_menu() {
	check(
		"command_ambiguous_lists_then_menu",
		Setup::Compsys,
		"",
		&["fx\t", "\t", "\t"],
		Record::Screen,
	);
}

#[test]
fn files_list_then_menu() {
	check("files_list_then_menu", Setup::Compsys, "", &[": f\t", "\t", "\t"], Record::Screen);
}

#[test]
fn cd_completes_directories() {
	check("cd_completes_directories", Setup::Compsys, "", &["cd \t", "\t"], Record::Screen);
}

#[test]
fn options_of_print_with_descriptions() {
	check("options_of_print_with_descriptions", Setup::Compsys, "", &["print -\t"], Record::Screen);
}

/// macOS `ls`: too many options for the screen, so zsh asks first.
#[cfg(target_os = "macos")]
#[test]
fn options_of_ls_ask_then_list() {
	check("options_of_ls_ask_then_list", Setup::Compsys, "", &["ls -\t", "y"], Record::Screen);
}

#[test]
fn options_and_values_of_arguments() {
	let rc = "_fx() { _arguments '-a[show all]' '-l[long listing]' \
	          '--color=[colourize]:when:(always never auto)' '*:file:_files' }\ncompdef _fx fxtool";
	check(
		"options_and_values_of_arguments",
		Setup::Compsys,
		rc,
		&["fxtool -\t", "-\t", "\x15fxtool --color=\t", "\t"],
		Record::Screen,
	);
}

#[test]
fn parameter_after_dollar() {
	check("parameter_after_dollar", Setup::Compsys, "", &["echo $HO\t", "\t"], Record::Screen);
}

#[test]
fn parameter_in_braces() {
	check("parameter_in_braces", Setup::Compsys, "", &["echo ${PA\t", "\t"], Record::Screen);
}

#[test]
fn ambiguous_prefix_with_listambiguous() {
	check(
		"ambiguous_prefix_with_listambiguous",
		Setup::Compsys,
		"",
		&["echo fi\t", "\t", "\t"],
		Record::Screen,
	);
}

#[test]
fn ambiguous_prefix_without_listambiguous() {
	check(
		"ambiguous_prefix_without_listambiguous",
		Setup::Compsys,
		"unsetopt listambiguous",
		&["echo fi\t", "\t"],
		Record::Screen,
	);
}

#[test]
fn ambiguous_prefix_without_autolist() {
	check(
		"ambiguous_prefix_without_autolist",
		Setup::Compsys,
		"unsetopt autolist",
		&["echo fi\t", "\t", "\t"],
		Record::Screen,
	);
}

#[test]
fn menucomplete_cycles_and_reverse_menu_complete() {
	check(
		"menucomplete_cycles_and_reverse_menu_complete",
		Setup::Compsys,
		"setopt menucomplete\nbindkey '^[[Z' reverse-menu-complete",
		&["echo f\t", "\t", "\t", "\x1b[Z", "\x1b[Z", "\x1b[Z"],
		Record::Screen,
	);
}

#[test]
fn menu_select_navigation() {
	check(
		"menu_select_navigation",
		Setup::Compsys,
		"zmodload zsh/complist\nzstyle ':completion:*' menu select",
		&[": \t", "\t", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[A", "\r", "\r"],
		Record::Colours,
	);
}

#[test]
fn menu_select_widget_over_rows() {
	let rc = "zmodload zsh/complist\n_m() { compadd -J n -X '%Bnumbers%b' w{01..30} }\nzle -C ms \
	          menu-select _m\nbindkey '^T' ms";
	check(
		"menu_select_widget_over_rows",
		Setup::Bare,
		rc,
		&[": w\x14", "\x1b[B", "\x1b[C", "\x1b[C", "\x1b[A", "\x0e", "\r", "\r"],
		Record::Colours,
	);
}

/// `menu select` through compsys, for the menu-selection keymap cases.
const MENU_SELECT: &str = "zmodload zsh/complist\nzstyle ':completion:*' menu select\n";

#[test]
fn menu_select_send_break_restores_the_line() {
	check(
		"menu_select_send_break_restores_the_line",
		Setup::Compsys,
		MENU_SELECT,
		&[": \t", "\t", "\x1b[B", "\x07"],
		Record::Screen,
	);
}

#[test]
fn menu_select_undo() {
	check(
		"menu_select_undo",
		Setup::Compsys,
		MENU_SELECT,
		&[": \t", "\t", "\x1b[C", "\x1f", "\x1f"],
		Record::Screen,
	);
}

#[test]
fn menu_select_accept_and_hold() {
	check(
		"menu_select_accept_and_hold",
		Setup::Compsys,
		MENU_SELECT,
		&[": \t", "\t", "\x1ba", "\x1ba", "\r"],
		Record::Screen,
	);
}

#[test]
fn menu_select_interactive_via_vi_insert() {
	let rc = format!("{MENU_SELECT}bindkey -M menuselect '^V' vi-insert");
	check(
		"menu_select_interactive_via_vi_insert",
		Setup::Compsys,
		&rc,
		&[": \t", "\t", "\x16", "fi", "\t", "\r"],
		Record::Screen,
	);
}

#[test]
fn menu_select_incremental_search() {
	let rc = format!("{MENU_SELECT}bindkey -M menuselect '^R' history-incremental-search-backward");
	check(
		"menu_select_incremental_search",
		Setup::Compsys,
		&rc,
		&[": \t", "\t", "\x12", "fo", "\x12", "\r", "\r"],
		Record::Screen,
	);
}

/// A list longer than the screen: `MENUSCROLL` and `MENUPROMPT`, wrapping
/// from the top to the last column and back.
#[test]
fn menu_select_scrolls_with_menuprompt() {
	let rc = "zmodload zsh/complist\nMENUSCROLL=3\nMENUPROMPT='%Sat %p of %m%s'\n_m() { compadd -V \
	          v -- item-{001..400} }\nzle -C ms menu-select _m\nbindkey '^T' ms";
	check(
		"menu_select_scrolls_with_menuprompt",
		Setup::Bare,
		rc,
		&[": \x14", "\x1b[D", "\x1b[B\x1b[B", "\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A", "\r"],
		Record::Screen,
	);
}

/// A list longer than the screen with `LISTPROMPT`: space for a page,
/// return for a line, `q` to stop.
#[test]
fn listprompt_scrolls_a_long_list() {
	let rc = "zmodload zsh/complist\nLISTPROMPT='%Smore? %l %p%s'\n_m() { compadd -V v -- \
	          item-{001..400} }\nzle -C lc list-choices _m\nbindkey '^T' lc";
	check(
		"listprompt_scrolls_a_long_list",
		Setup::Bare,
		rc,
		&[": \x14", " ", "\r", "q"],
		Record::Screen,
	);
}

/// `ZLS_COLORS` by file type (`di`, `ex`, `ln`), a `=(#b)` pattern colouring
/// its groups, and `ma` for the selected match.
#[test]
fn zls_colors_types_patterns_and_selection() {
	let rc = "ln -s file1 ~/fx/link\nprint '#!/bin/sh' >~/fx/run.sh\nchmod +x \
	          ~/fx/run.sh\nzmodload \
	          zsh/complist\nZLS_COLORS='ex=32:ln=36:di=01;34:ma=7;33:=(#b)(fo)(*)=0=1;31=35'\n_f() \
	          { compadd -f -- * }\nzle -C fs menu-select _f\nbindkey '^T' fs";
	check(
		"zls_colors_types_patterns_and_selection",
		Setup::Bare,
		rc,
		&[": \x14", "\x1b[C", "\x1b[C", "\r"],
		Record::Colours,
	);
}

#[test]
fn list_colors_style() {
	check(
		"list_colors_style",
		Setup::Compsys,
		"zmodload zsh/complist\nzstyle ':completion:*' list-colors 'di=1;34' 'fi=0' '*.c=32' \
		 '*.h=33'",
		&[": \t"],
		Record::Colours,
	);
}

#[test]
fn zls_colors_parameter() {
	let rc = "zmodload zsh/complist\nZLS_COLORS='di=01;34:*.c=32:*.h=4'\n_f() { compadd -f -- * \
	          }\nzle -C fc complete-word _f\nbindkey '^T' fc";
	check("zls_colors_parameter", Setup::Bare, rc, &[": \x14"], Record::Colours);
}

#[test]
fn compadd_groups_explanations_and_displays() {
	let rc = "_g() {\n\x20 compadd -J one -X 'first group' alpha alpine\n\x20 compadd -V two -X \
	          'second %d group' zeta alto\n\x20 local -a disp=('ant -- an insect' 'aardvark -- an \
	          animal')\n\x20 compadd -J three -d disp ant aardvark\n}\nzle -C g complete-word \
	          _g\nbindkey '^T' g";
	check(
		"compadd_groups_explanations_and_displays",
		Setup::Bare,
		rc,
		&[": a\x14", "\x15: z\x14", "\x15: \x14"],
		Record::Colours,
	);
}

#[test]
fn compadd_autoremovable_suffix() {
	let rc = "_s() { compadd -S / -q dirx }\nzle -C s complete-word _s\nbindkey '^T' s";
	check(
		"compadd_autoremovable_suffix",
		Setup::Bare,
		rc,
		&[": di\x14", " ", "di\x14", "\r"],
		Record::Screen,
	);
}

#[test]
fn compadd_prefixes_and_suffixes() {
	let rc = "_p() { compadd -P pre- -p hid -s .x -i ign- alpha alps }\nzle -C p complete-word \
	          _p\nbindkey '^T' p\nzle -C pl list-choices _p\nbindkey '^Xl' pl";
	check(
		"compadd_prefixes_and_suffixes",
		Setup::Bare,
		rc,
		&[": hidal\x14", "\x14", "\x15: hid\x18l"],
		Record::Screen,
	);
}

#[test]
fn compadd_matchers() {
	let rc = "_m() {\n\x20 compadd -M 'm:{a-z}={A-Z}' Foobar FooBaz Quux\n\x20 compadd -M 'r:|.=* \
	          r:|=*' comp.sources.unix comp.graphics.misc\n}\nzle -C m complete-word _m\nbindkey \
	          '^T' m";
	check(
		"compadd_matchers",
		Setup::Bare,
		rc,
		&[": foob\x14", "\x14", "\x15: c.s.u\x14", "\x15: .g\x14"],
		Record::Screen,
	);
}

#[test]
fn compstate_keys_in_a_widget() {
	let rc = "_cs() {\n\x20 local k\n\x20 for k in ${(ok)compstate}; do print -r -- \
	          \"$k=${compstate[$k]}\"; done >~/cs.out\n\x20 compadd foo foobar\n\x20 print -r -- \
	          \"after: $compstate[nmatches] <$compstate[unambiguous]> \
	          $compstate[unambiguous_cursor] $compstate[list] $compstate[insert]\" \
	          >>~/cs.out\n}\nzle -C cs complete-word _cs\nbindkey '^T' cs";
	check(
		"compstate_keys_in_a_widget",
		Setup::Bare,
		rc,
		&["echo x fo\x14", "\x15cat ~/cs.out\r"],
		Record::Screen,
	);
}

#[test]
fn compstate_insert_and_list_set_by_a_widget() {
	let rc = "_w() { compadd aa ab ac; compstate[insert]=2; compstate[list]= }\nzle -C w \
	          complete-word _w\nbindkey '^T' w\n_w2() { compadd aa ab ac; compstate[list]='list \
	          force'; compstate[insert]=menu }\nzle -C w2 complete-word _w2\nbindkey '^Xw' w2";
	check(
		"compstate_insert_and_list_set_by_a_widget",
		Setup::Bare,
		rc,
		&[": a\x14", "\x14", "\x15: a\x18w", "\x18w"],
		Record::Screen,
	);
}

#[test]
fn compset_prefix_suffix_words_and_quotes() {
	let rc = "setopt completeinword\n_st() {\n\x20 {\n\x20   print -r -- \"0 \
	          [$IPREFIX|$PREFIX|$SUFFIX|$ISUFFIX] $CURRENT ${(j:,:)words}\"\n\x20   compset -P \
	          '*=' && print -r -- \"P [$IPREFIX|$PREFIX|$SUFFIX|$ISUFFIX]\"\n\x20   compset -S \
	          ',*' && print -r -- \"S [$IPREFIX|$PREFIX|$SUFFIX|$ISUFFIX]\"\n\x20   compset -p 1 \
	          && print -r -- \"p [$IPREFIX|$PREFIX|$SUFFIX|$ISUFFIX]\"\n\x20   compset -s 1 && \
	          print -r -- \"s [$IPREFIX|$PREFIX|$SUFFIX|$ISUFFIX]\"\n\x20   compset -n 2 && print \
	          -r -- \"n $CURRENT ${(j:,:)words}\"\n\x20   compset -N 'b*' && print -r -- \"N \
	          $CURRENT ${(j:,:)words}\"\n\x20   compset -p 9 || print -r -- \"p9 fails\"\n\x20 } \
	          >~/cs.out\n\x20 compadd xyz\n}\nzle -C st complete-word _st\nbindkey '^T' st\n_q() \
	          {\n\x20 compset -q && print -r -- \"q $CURRENT ${(j:,:)words} \
	          [$IPREFIX|$PREFIX|$SUFFIX|$ISUFFIX] $compstate[quote]\" >~/q.out\n\x20 compadd \
	          baz\n}\nzle -C q complete-word _q\nbindkey '^Xq' q";
	check(
		"compset_prefix_suffix_words_and_quotes",
		Setup::Bare,
		rc,
		&[
			"a bb c key=valu,rest\x02\x02\x02\x02\x02\x02\x02\x14",
			"\x15cat ~/cs.out\r",
			": \"foo bar ba\x18q",
			"\x15cat ~/q.out\r",
		],
		Record::Screen,
	);
}

/// Without compsys or compctl, Tab is `expand-or-complete`: parameters,
/// globs, command substitutions expand; named directories complete.
#[test]
fn expand_or_complete_expands() {
	let rc = "x=fixed\n: >~/fx/a.txt >~/fx/b.txt\nhash -d nd=/usr/bin";
	check(
		"expand_or_complete_expands",
		Setup::Bare,
		rc,
		&["echo $x\t", "\x15echo *.txt\t", "\x15echo $(echo hi)\t", "\x15echo ~nd\t"],
		Record::Screen,
	);
}

/// Without compsys or compctl, words that expand to themselves complete as
/// files.
#[test]
fn expand_or_complete_falls_back_to_files() {
	check(
		"expand_or_complete_falls_back_to_files",
		Setup::Bare,
		"",
		&["ls fi\t", "\t"],
		Record::Screen,
	);
}

/// `^Xg` (list-expand) then `^X*` (expand-word).
#[test]
fn list_expand_and_expand_word() {
	check(
		"list_expand_and_expand_word",
		Setup::Bare,
		"",
		&["echo f*\x18g", "\x18*"],
		Record::Screen,
	);
}

#[test]
fn complete_in_double_quotes() {
	check("complete_in_double_quotes", Setup::Bare, "", &["echo \"fo\t", "\t"], Record::Screen);
}

#[test]
fn complete_in_open_brace_expansion() {
	check("complete_in_open_brace_expansion", Setup::Bare, "", &["echo a{b,c\t"], Record::Screen);
}

/// `^D` at the end of the line lists (delete-char-or-list).
#[test]
fn delete_char_or_list_lists() {
	check("delete_char_or_list_lists", Setup::Bare, "", &["echo f\x04"], Record::Screen);
}

/// `ESC $` (spell-word) corrects a command name against the path.
#[test]
fn spell_word_corrects_a_command() {
	check(
		"spell_word_corrects_a_command",
		Setup::Bare,
		"path=( ~/bin )",
		&["fxtoll\x1b$"],
		Record::Screen,
	);
}

#[test]
fn expand_cmd_path() {
	check(
		"expand_cmd_path",
		Setup::Bare,
		"bindkey '^Xp' expand-cmd-path",
		&["ls\x18p"],
		Record::Screen,
	);
}

#[test]
fn listmax_asks_before_listing() {
	let rc = "LISTMAX=5\n_lm() { compadd word{01..60} }\nzle -C lm complete-word _lm\nbindkey '^T' \
	          lm\nzle -C lml list-choices _lm\nbindkey '^Xd' lml";
	check(
		"listmax_asks_before_listing",
		Setup::Bare,
		rc,
		&[": word\x14", "n", "\x18d", "y"],
		Record::Screen,
	);
}

/// `/bin/sh` on a pty for the tests of [`wait_drawn`]: it shows `one`, and a
/// key typed once its output has settled runs `script` (no echo, no line
/// editing, so `dd` reads a terminal answer).
fn scripted(script: &str) -> io::Result<Pty> {
	let script = format!(
		"stty -echo -icanon min 1 time 0; printf one; dd bs=1 count=1 of=/dev/null 2>/dev/null; \
		 {script}; sleep 30"
	);
	let mut pty = Spawn::new("/bin/sh").args(["-c", &script]).spawn()?;
	pty.wait_screen_contains("one", TIMEOUT)?;
	pty.settle(quiet(), TIMEOUT)?;
	pty.write("k")?;
	Ok(pty)
}

/// In a [`scripted`] script after `ESC [ 6 n`: read the terminal's answer
/// (`ESC [ 1 ; 4 R` with the cursor after three letters of the first row), so
/// that what follows comes after the screen had what came before.
const READ_ANSWER: &str = "dd bs=1 count=6 of=/dev/null 2>/dev/null";

/// The screen the [`scripted`] tests wait for.
fn two() -> Drawn {
	Drawn { contents: "two".to_owned(), cursor: (0, 3) }
}

/// Wait until the output holds `text`, without feeding it to the screen.
fn until_output(pty: &Pty, text: &str) {
	let deadline = Instant::now() + TIMEOUT;
	while !pty.output().contains(text) {
		assert!(Instant::now() < deadline, "{text:?} is not in the output {:?}", pty.output());
		thread::sleep(Duration::from_millis(5));
	}
}

/// A screen that comes after the step's output settled, and stays, is the
/// step's.
#[test]
fn wait_drawn_takes_a_late_screen_that_stays() -> io::Result<()> {
	let mut pty = scripted("sleep 0.2; printf '\\rtwo'")?;
	let miss = wait_drawn(&mut pty, &two(), DRAWN)?;
	assert_eq!((miss, recorded(&mut pty, miss).contents()), (None, "two".to_owned()));
	Ok(())
}

/// A screen first seen after `step` returned must stay for [`HOLD`], also when
/// it came before the step's first look at the screen: here a change follows.
#[test]
fn wait_drawn_holds_a_screen_that_came_after_the_settle() -> io::Result<()> {
	let mut pty =
		scripted(&format!("printf '\\rtwo\\033[6n'; {READ_ANSWER}; sleep 0.02; printf '\\rbad'"))?;
	until_output(&pty, "two");
	let miss = wait_drawn(&mut pty, &two(), DRAWN)?;
	assert_eq!(recorded(&mut pty, miss).contents(), "bad");
	Ok(())
}

/// A change within [`HOLD`] fails the step, also when the screen comes back
/// before the step is recorded.
#[test]
fn wait_drawn_fails_a_screen_that_changes_during_the_hold() -> io::Result<()> {
	let mut pty = scripted(&format!(
		"sleep 0.2; printf '\\rtwo\\033[6n'; {READ_ANSWER}; sleep 0.02; printf '\\rbad\\033[6n'; \
		 {READ_ANSWER}; sleep 0.02; printf '\\r\\033[Ktwo'"
	))?;
	let miss = wait_drawn(&mut pty, &two(), DRAWN)?;
	until_output(&pty, "\x1b[Ktwo");
	let screen = recorded(&mut pty, miss).contents();
	assert_eq!(miss, Some(Miss::Changed), "the step records {screen:?}");
	Ok(())
}

/// A step that misses the bound records the screen it had then, also when its
/// screen comes before the step is recorded.
#[test]
fn wait_drawn_records_the_screen_at_the_bound() -> io::Result<()> {
	let mut pty = scripted("sleep 1; printf '\\rtwo'")?;
	let miss = wait_drawn(&mut pty, &two(), Duration::from_millis(200))?;
	until_output(&pty, "two");
	assert_eq!((miss, recorded(&mut pty, miss).contents()), (Some(Miss::Late), "one".to_owned()));
	Ok(())
}
