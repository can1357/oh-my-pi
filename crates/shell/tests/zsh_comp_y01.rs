//! zsh 5.9 `Test/Y01completion.ztst` (completion system) through the port of
//! its `comptest` harness (`comp_support::comptest`): obash runs as `zsh -f +Z`
//! on a pty, with zsh 5.9's installed completion functions, and every
//! `comptest` report must equal zsh's.
//!
//! The steps and reports below were recorded by running the `.ztst` file
//! under `/bin/zsh` 5.9 with `comptest` wrapped to log each `comptesteval`,
//! each `comptest` input and its report, and the file operations of the
//! test script; the reports equal the file's expected output (all of its
//! tests pass under `/bin/zsh`) except where zsh itself is expected to fail
//! (`f` flag), which are pinned to zsh's actual report. `PI_COMP_ORACLE=1`
//! runs them against `/bin/zsh` through this harness.

#![cfg(unix)]

mod comp_support;
mod pty_support;

use comp_support::comptest::{
	Case,
	Step::{self, Eval, Outer, Test},
	Suite, run_case,
};

/// The `%prep` steps (after `comptestinit`).
const PREP: &[Step] = &[
	Eval("compdef _tst tst"),
	Outer(&["mkdir", "dir1"]),
	Outer(&["mkdir", "dir2"]),
	Outer(&["touch", "file1"]),
	Outer(&["touch", "file2"]),
];

/// The `%test` chunks in file order.
const CASES: &[Case] = &[
	Case {
		name:  "directories and files",
		steps: &[Test(
			": \t\t\t\t\t\t\t",
			"line: {: }{}\nDESCRIPTION:{file}\nDI:{dir1}\nDI:{dir2}\nFI:{file1}\nFI:{file2}\nline: \
			 {: dir1/}{}\nline: {: dir2/}{}\nline: {: file1}{}\nline: {: file2}{}\nline: {: \
			 dir1/}{}\nline: {: dir2/}{}",
		)],
	},
	Case {
		name:  "_expand shows file types",
		steps: &[Test(
			": *\t\t\t\t\t\t",
			"line: {: dir1/}{}\nDESCRIPTION:{expansions}\nDI:{dir1}\nDI:{dir2}\nFI:{file1}\nFI:\
			 {file2}\nDESCRIPTION:{all expansions}\nNO:{dir1 dir2 file1 \
			 file2}\nDESCRIPTION:{original}\nNO:{*}\nline: {: dir2/}{}\nline: {: file1 }{}\nline: {: \
			 file2 }{}\nline: {: dir1 dir2 file1 file2 }{}\nline: {: *}{}",
		)],
	},
	Case {
		name:  "_expand preserves array form",
		steps: &[
			Eval("zstyle '*' glob no"),
			Eval("typeset -g tst=(*)"),
			Test(
				": $tst\x04",
				"DESCRIPTION:{expansions}\nNO:{dir1}\nNO:{dir2}\nNO:{file1}\nNO:{file2}",
			),
		],
	},
	Case {
		name:  "tilde",
		steps: &[
			Eval("zstyle -d '*' glob"),
			Eval("_users () { compadd user1 user2 }"),
			Test(
				": ~\t\t\t\t\t",
				"line: {: ~user}{}\nline: {: ~user}{}\nNO:{user1}\nNO:{user2}\nline: {: \
				 ~user1}{}\nline: {: ~user2}{}\nline: {: ~user1}{}",
			),
		],
	},
	Case {
		name:  "directories and files before separator",
		steps: &[Test(
			"echo ;:\x02\x02\t",
			"line: {echo }{;:}\nDESCRIPTION:{file}\nDI:{dir1}\nDI:{dir2}\nFI:{file1}\nFI:{file2}",
		)],
	},
	Case {
		name:  "custom description with formatting sequences",
		steps: &[
			Eval("zstyle -s \":completion:*:descriptions\" format oldfmt"),
			Eval(
				"zstyle \":completion:*:descriptions\" format \\\n    ${oldfmt/>*</>%5F123abc%f \
				 %B123abc%b<}",
			),
			Test(
				": \t",
				"line: {: }{}\nDESCRIPTION:{\x1b[35m123abc\x1b[39m \
				 \x1b[1m123abc\x1b[0m}\nDI:{dir1}\nDI:{dir2}\nFI:{file1}\nFI:{file2}",
			),
			Eval("zstyle \":completion:*:descriptions\" format $oldfmt"),
		],
	},
	Case {
		name:  "command",
		steps: &[Eval("path=( @SRCDIR@ )"), Test("zt\t", "line: {ztst.zsh }{}")],
	},
	Case {
		name:  "command after separator",
		steps: &[Eval("path=( @SRCDIR@ )"), Test(":;zt\t", "line: {:;ztst.zsh }{}")],
	},
	Case {
		name:  "redirection after \"for ...; do\"",
		steps: &[Test(
			"for f in 1; do < x\x02\x02\t",
			"line: {for f in 1; do <}{ \
			 x}\nDESCRIPTION:{file}\nDI:{dir1}\nDI:{dir2}\nFI:{file1}\nFI:{file2}",
		)],
	},
	Case {
		name:  "directory name is not a glob qualifier",
		steps: &[
			Outer(&["mkdir", "A(B)", "A(B)/C"]),
			Test("cd \"A(B)\t\t", "line: {cd \"A(B)/}{}\nline: {cd \"A(B)/C/}{}"),
			Eval("cd \"A(B)/C\""),
			Test("cd ../\t", "line: {cd ../C/}{}"),
			Eval("cd -"),
			Outer(&["rmdir", "A(B)/C", "A(B)"]),
		],
	},
	Case {
		name:  "remove exact number of characters from a prefix",
		steps: &[
			Eval("_tst() { compset -p 1; _message \"${(qq)IPREFIX} ${(qq)PREFIX}\" }"),
			Test("tst .\t", "line: {tst .}{}\nMESSAGE:{'.' ''}"),
		],
	},
	Case {
		name:  "remove exact number of characters from a suffix",
		steps: &[
			Eval("_tst() { compset -s 3; _message \"${(qq)SUFFIX} ${(qq)ISUFFIX}\" }"),
			Test("tst 123\x1bb\t", "line: {tst }{123}\nMESSAGE:{'' '123'}"),
		],
	},
	Case {
		name:  "try to remove excess characters from prefix and suffix",
		steps: &[
			Eval(
				"_tst() { compset -p 2; compset -p 3;compset -s 2;compset -s 3; _message \
				 \"${(qq)PREFIX} ${(qq)SUFFIX}\" }",
			),
			Test("tst 12345678\x1b4\x02\t", "line: {tst 1234}{5678}\nMESSAGE:{'34' '56'}"),
		],
	},
	Case {
		name:  "remove multibyte character from a prefix",
		steps: &[
			Eval("_tst() { compset -p 1; _message \"${(qq)IPREFIX} ${(qq)PREFIX}\" }"),
			Test("tst €100\t", "line: {tst €100}{}\nMESSAGE:{'€' '100'}"),
		],
	},
	Case {
		name:  "allow for suffixes when moving cursor to end of match (with ignored suffix)",
		steps: &[
			Eval("_tst() { compadd -U -s : -S / -I . word; compstate[to_end]= }"),
			Test("tst .\x02\t", "line: {tst word:/}{.}"),
		],
	},
	Case {
		name:  "allow for suffixes when moving cursor to end of match (without ignored suffix)",
		steps: &[
			Eval("_tst() { compadd -s : -S / word; compstate[to_end]= }"),
			Test("tst \t", "line: {tst word:/}{}"),
		],
	},
	Case {
		name:  "ignore backslashes when sorting completion matches",
		steps: &[
			Outer(&["mkdir", "sortnobslash"]),
			Outer(&[
				"touch",
				"sortnobslash/!foo",
				"sortnobslash/#foo",
				"sortnobslash/\\foo",
				"sortnobslash/|foo",
				"sortnobslash/~foo",
				"sortnobslash/Afoo",
				"sortnobslash/bfoo",
			]),
			Eval("old_LC_ALL=$LC_ALL; LC_ALL=C"),
			Test(
				": sortnobslash/\t",
				concat!(
					"line: {: sortnobslash/}{}\n",
					"DESCRIPTION:{file}\n",
					"FI:{\\!foo}\n",
					"FI:{\\#foo}\n",
					"FI:{Afoo}\n",
					"FI:{\\\\foo}\n",
					"FI:{bfoo}\n",
					"FI:{\\|foo}\n",
					"FI:{\\~foo}",
				),
			),
			Eval("LC_ALL=$old_LC_ALL"),
			Outer(&["rm", "-rf", "sortnobslash"]),
		],
	},
	Case {
		name:  "reverse numeric sorting of matches",
		steps: &[
			Eval("_tst() { compadd -onum,rev -J versions r1.10 r1.1 r1.2 r2.3 r2.34 }"),
			Test(
				"tst r\t",
				"line: {tst r}{}\nNO:{r2.34}\nNO:{r2.3}\nNO:{r1.10}\nNO:{r1.2}\nNO:{r1.1}",
			),
		],
	},
	Case {
		name:  "reverse numeric sorting of matches via a style",
		steps: &[
			Eval(
				"_tst() { local expl; _wanted times expl time compadd -o match r1.10 r1.2 r2.3 r2.34 }",
			),
			Eval("zstyle ':completion:*:tst:*' sort reverse numeric"),
			Test(
				"tst r\t",
				"line: {tst r}{}\nDESCRIPTION:{time}\nNO:{r2.34}\nNO:{r2.3}\nNO:{r1.10}\nNO:{r1.2}",
			),
		],
	},
	Case {
		name:  "sort in match rather than display name order",
		steps: &[
			Eval("_tst() { local disp=(a b c); compadd -o -J letters -d disp 3 2 1 }"),
			Test("tst \t", "line: {tst }{}\nNO:{c}\nNO:{b}\nNO:{a}"),
		],
	},
	Case {
		name:  "sorting disabled via the sort style",
		steps: &[
			Eval("_tst() { local expl; _wanted times expl time compadd 3am 12pm 3pm 10pm }"),
			Eval("zstyle ':completion:*:tst:*' sort false"),
			Test(
				"tst \t",
				"line: {tst }{}\nDESCRIPTION:{time}\nNO:{3am}\nNO:{12pm}\nNO:{3pm}\nNO:{10pm}",
			),
		],
	},
	Case {
		name:  "-F does not break _sequence",
		steps: &[
			Eval("_tst() { _arguments ':desc:_sequence compadd - 1 2 3' }"),
			Eval("zstyle ':completion:*:tst:*' ignored-patterns 2"),
			Test("tst 1,\t", "line: {tst 1,}{}\nDESCRIPTION:{desc}\nNO:{2}\nNO:{3}"),
			Eval("zstyle -d ':completion:*:tst:*' ignored-patterns"),
		],
	},
	Case {
		name:  "multiple envarrays",
		steps: &[Test(
			"a=() b=(\t",
			"line: {a=() b=(}{}\nDESCRIPTION:{file}\nDI:{dir1}\nDI:{dir2}\nFI:{file1}\nFI:{file2}",
		)],
	},
	Case {
		name:  "extra-verbose shows parameter values",
		steps: &[
			Eval("typeset -a bar=({$'\\0'..$'\\C-?'})"),
			Eval("typeset -A bat=( \"$bar[@]\" )"),
			Eval("typeset bay=\"$bar\""),
			Eval("zstyle \":completion:*:parameters\" extra-verbose yes"),
			Eval("zstyle \":completion:*\" fake-parameters bar bat bay"),
			Test(
				": $ba\t",
				"line: {: $ba}{}\nDESCRIPTION:{parameter}\nNO:{bar  -- ( '^@' '^A' '^B' '^C' '^D' \
				 '^E' '^F' '^G' '^H' '\\t' '\\n' '^K' '^L' '}\nNO:{bat  -- ( [' ']='!' ['\"']='#' \
				 ['$']=% ['&']=\\' ['(']=')' ['*']=+ [,]=- [.]=/}\nNO:{bay  -- '^@ ^A ^B ^C ^D ^E ^F \
				 ^G ^H \\t \\n ^K ^L ^M ^N ^O ^P ^Q ^R ^S ^T ^U ^}",
			),
		],
	},
	Case {
		name:  "extra-verbose doesn't show special or hidden parameter values",
		steps: &[
			Eval("path=( @SRCDIR@ )"),
			Eval("typeset -H paths=HIDDEN"),
			Test(": $path\t", "line: {: $path}{}\nDESCRIPTION:{parameter}\nNO:{path}\nNO:{paths}"),
		],
	},
	Case {
		name:  "parameter values not shown without extra-verbose",
		steps: &[
			Eval("zstyle -d \":completion:*:parameters\" extra-verbose"),
			Test(": $ba\t", "line: {: $ba}{}\nDESCRIPTION:{parameter}\nNO:{bar}\nNO:{bat}\nNO:{bay}"),
		],
	},
	Case {
		name:  " menu select=long-list starts menu selection for list widgets",
		steps: &[
			Eval(
				"_tst() { local disp=( {a..z} ); compadd -ld disp $disp[@]; comppostfuncs=( _pst ) }",
			),
			Eval(
				"_pst() { local disp=( \"<INSERT>$compstate[insert]</INSERT>\" ); compadd -Qld disp \
				 $disp }",
			),
			Eval("zstyle ':completion:*' menu select=long-list"),
			Eval("export LC_ALL=C"),
			Test(
				"tst \x04",
				concat!(
					"NO:{<INSERT>menu</INSERT>}\n",
					"NO:{a}\n",
					"NO:{b}\n",
					"NO:{c}\n",
					"NO:{d}\n",
					"NO:{e}\n",
					"NO:{f}\n",
					"NO:{g}\n",
					"NO:{h}\n",
					"NO:{i}\n",
					"NO:{j}\n",
					"NO:{k}\n",
					"NO:{l}\n",
					"NO:{m}\n",
					"NO:{n}\n",
					"NO:{o}\n",
					"NO:{p}\n",
					"NO:{q}\n",
					"NO:{r}\n",
					"NO:{s}\n",
					"NO:{t}\n",
					"NO:{u}\n",
					"NO:{v}\n",
					"NO:{w}\n",
					"NO:{x}\n",
					"NO:{y}\n",
					"NO:{z}",
				),
			),
			Eval("export LC_ALL=en_US.UTF-8"),
		],
	},
];

const SUITE: Suite =
	Suite { file: "Y01completion.ztst", lang: "en_US.UTF-8", prep: PREP, cases: CASES };

/// directories and files
#[test]
fn c001_directories_and_files() {
	run_case(&SUITE, 0);
}

/// _expand shows file types
#[test]
fn c002_expand_shows_file_types() {
	run_case(&SUITE, 1);
}

/// _expand preserves array form
#[test]
fn c003_expand_preserves_array_form() {
	run_case(&SUITE, 2);
}

/// tilde
#[test]
fn c004_tilde() {
	run_case(&SUITE, 3);
}

/// directories and files before separator
#[test]
fn c005_directories_and_files_before_separator() {
	run_case(&SUITE, 4);
}

/// custom description with formatting sequences
#[test]
fn c006_custom_description_with_formatting_sequences() {
	run_case(&SUITE, 5);
}

/// command
#[test]
fn c007_command() {
	run_case(&SUITE, 6);
}

/// command after separator
#[test]
fn c008_command_after_separator() {
	run_case(&SUITE, 7);
}

/// redirection after "for ...; do"
#[test]
fn c009_redirection_after_for_do() {
	run_case(&SUITE, 8);
}

/// directory name is not a glob qualifier
#[test]
fn c010_directory_name_is_not_a_glob_qualifier() {
	run_case(&SUITE, 9);
}

/// remove exact number of characters from a prefix
#[test]
fn c011_remove_exact_number_of_characters_from_a_prefix() {
	run_case(&SUITE, 10);
}

/// remove exact number of characters from a suffix
#[test]
fn c012_remove_exact_number_of_characters_from_a_suffix() {
	run_case(&SUITE, 11);
}

/// try to remove excess characters from prefix and suffix
#[test]
fn c013_try_to_remove_excess_characters_from_prefix_and_suffix() {
	run_case(&SUITE, 12);
}

/// remove multibyte character from a prefix
#[test]
fn c014_remove_multibyte_character_from_a_prefix() {
	run_case(&SUITE, 13);
}

/// allow for suffixes when moving cursor to end of match (with ignored suffix)
#[test]
fn c015_allow_for_suffixes_when_moving_cursor_to_end_of_match_with_i() {
	run_case(&SUITE, 14);
}

/// allow for suffixes when moving cursor to end of match (without ignored
/// suffix)
#[test]
fn c016_allow_for_suffixes_when_moving_cursor_to_end_of_match_withou() {
	run_case(&SUITE, 15);
}

/// ignore backslashes when sorting completion matches
#[test]
fn c017_ignore_backslashes_when_sorting_completion_matches() {
	run_case(&SUITE, 16);
}

/// reverse numeric sorting of matches
#[test]
fn c018_reverse_numeric_sorting_of_matches() {
	run_case(&SUITE, 17);
}

/// reverse numeric sorting of matches via a style
#[test]
fn c019_reverse_numeric_sorting_of_matches_via_a_style() {
	run_case(&SUITE, 18);
}

/// sort in match rather than display name order
#[test]
fn c020_sort_in_match_rather_than_display_name_order() {
	run_case(&SUITE, 19);
}

/// sorting disabled via the sort style
#[test]
fn c021_sorting_disabled_via_the_sort_style() {
	run_case(&SUITE, 20);
}

/// -F does not break _sequence
#[test]
fn c022_f_does_not_break_sequence() {
	run_case(&SUITE, 21);
}

/// multiple envarrays
#[test]
fn c023_multiple_envarrays() {
	run_case(&SUITE, 22);
}

/// extra-verbose shows parameter values
#[test]
fn c024_extra_verbose_shows_parameter_values() {
	run_case(&SUITE, 23);
}

/// extra-verbose doesn't show special or hidden parameter values
#[test]
fn c025_extra_verbose_doesn_t_show_special_or_hidden_parameter_value() {
	run_case(&SUITE, 24);
}

/// parameter values not shown without extra-verbose
#[test]
fn c026_parameter_values_not_shown_without_extra_verbose() {
	run_case(&SUITE, 25);
}

/// menu select=long-list starts menu selection for list widgets
#[test]
fn c027_menu_select_long_list_starts_menu_selection_for_list_widgets() {
	run_case(&SUITE, 26);
}

/// The report parser follows `comptest`'s patterns: pieces split at
/// `<WIDGET>` (the first dropped), the buffer line first, colour codes
/// without a trailing clear-to-end-of-line, `TC` and blank texts skipped.
#[test]
fn comptest_report_parser() {
	let log = concat!(
		"junk<WIDGET><complete-word>\r\n",
		"<DESCRIPTION>file</DESCRIPTION>\r\n",
		"<LC><DI><RC>dir1<EC>\n",
		"  <LC><FI><RC>a\x1b[K<EC>\n",
		"<LC><TC><RC>x<EC>\n",
		"<LC><NO><RC>  <EC>\n",
		"<LBUFFER>: </LBUFFER>\r\n",
		"<RBUFFER></RBUFFER>\r\n",
		"<WIDGET><finish>\r\n",
	);
	assert_eq!(comp_support::comptest::report(log), [
		"line: {: }{}",
		"DESCRIPTION:{file}",
		"DI:{dir1}",
		"FI:{a}"
	]);
}
