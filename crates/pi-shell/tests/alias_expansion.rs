//! The bash tool's shell substitutes aliases exactly when Bash 5.2.21 does:
//! only while `expand_aliases` is on, and with the alias table and option in
//! force when each complete command (an input line, or a compound command
//! spanning lines) is read, after the commands before it have run.
//!
//! Each test names the Bash 5.2.21 row it reproduces; the expected output is
//! what `bash -c` printed for the same text.
#![cfg(unix)]

use std::path::Path;

use pi_shell::{
	cancel::CancelToken,
	minimizer::MinimizerOptions,
	shell::{ShellExecuteOptions, execute_shell},
};

#[derive(Default)]
struct Setup {
	snapshot:  Option<&'static str>,
	minimizer: bool,
}

async fn run_with(command: &str, setup: Setup) -> String {
	let dir = tempfile::tempdir().expect("tempdir");
	run_in(dir.path(), command, setup).await
}

async fn run_in(cwd: &Path, command: &str, setup: Setup) -> String {
	let snapshot_path = setup.snapshot.map(|text| {
		let path = cwd.join("snapshot.sh");
		std::fs::write(&path, text).expect("snapshot fixture");
		path.to_string_lossy().into_owned()
	});
	let (tx, rx) = flume::unbounded::<String>();
	execute_shell(
		ShellExecuteOptions {
			command: command.to_owned(),
			cwd: Some(cwd.to_string_lossy().into_owned()),
			snapshot_path,
			minimizer: setup
				.minimizer
				.then(|| MinimizerOptions { enabled: Some(true), ..Default::default() }),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	rx.drain().collect()
}

async fn run(command: &str) -> String {
	run_with(command, Setup::default()).await
}

const ON: &str = "shopt -s expand_aliases; alias q='echo aliased'\n";

// --- the option and the line a command is read on ---

/// T1: a non-interactive shell starts with `expand_aliases` off.
#[tokio::test]
async fn alias_is_not_expanded_while_the_option_is_off() {
	let out = run("alias q='echo aliased'\nq 2>/dev/null; echo \"st=$?\"").await;
	assert_eq!(out, "st=127\n");
}

/// T2: the option and the alias are in force when the next line is read.
#[tokio::test]
async fn alias_expands_on_a_line_read_after_the_option_is_on() {
	let out = run("shopt -s expand_aliases\nalias q='echo aliased'\nq").await;
	assert_eq!(out, "aliased\n");
}

/// T3: the whole line is read before `shopt` and `alias` run.
#[tokio::test]
async fn enabling_and_defining_on_the_line_of_use_does_not_expand() {
	let out =
		run("shopt -s expand_aliases; alias q='echo aliased'; q 2>/dev/null; echo \"st=$?\"").await;
	assert_eq!(out, "st=127\n");
}

/// T4: with the option already on, an alias defined on the line of use does
/// not expand on that line.
#[tokio::test]
async fn alias_defined_on_the_line_of_use_does_not_expand() {
	let out =
		run("shopt -s expand_aliases\nalias q='echo aliased'; q 2>/dev/null; echo \"st=$?\"").await;
	assert_eq!(out, "st=127\n");
}

/// T6: turning the option off on the line of use comes too late for that line.
#[tokio::test]
async fn disabling_on_the_line_of_use_still_expands() {
	let out = run(&format!("{ON}shopt -u expand_aliases; q")).await;
	assert_eq!(out, "aliased\n");
}

/// T7: the option off when the line is read means no alias.
#[tokio::test]
async fn disabling_on_an_earlier_line_stops_expansion() {
	let out = run(&format!("{ON}shopt -u expand_aliases\nq 2>/dev/null; echo \"st=$?\"")).await;
	assert_eq!(out, "st=127\n");
}

/// T9: a compound command spanning lines is read once, after the line before
/// it ran.
#[tokio::test]
async fn compound_command_spanning_lines_expands_aliases_defined_before_it() {
	let out = run(&format!("{ON}if true; then\n q\nfi")).await;
	assert_eq!(out, "aliased\n");
}

// --- eval, source, command and process substitution: read when they run ---

/// E2: `eval` reads its text when it runs.
#[tokio::test]
async fn eval_reads_aliases_when_it_runs() {
	let out = run("shopt -s expand_aliases; alias q='echo aliased'; eval q").await;
	assert_eq!(out, "aliased\n");
}

/// Y16: `eval` reads with the option as it is when `eval` runs.
#[tokio::test]
async fn eval_honors_the_option_turned_off_before_it_runs() {
	let out = run(&format!("{ON}shopt -u expand_aliases; eval q 2>/dev/null; echo \"st=$?\"")).await;
	assert_eq!(out, "st=127\n");
}

/// E5: inside `eval`, an alias defined on the line of use does not expand.
#[tokio::test]
async fn eval_text_follows_the_line_rule() {
	let out = run(
		"shopt -s expand_aliases; eval \"alias q='echo aliased'; q\" 2>/dev/null; echo \"st=$?\"",
	)
	.await;
	assert_eq!(out, "st=127\n");
}

/// S4: a sourced file is read line by line.
#[tokio::test]
async fn sourced_file_expands_an_alias_on_a_later_line() {
	let dir = tempfile::tempdir().expect("tempdir");
	std::fs::write(dir.path().join("f.sh"), "alias q='echo sourced'\nq\n").expect("fixture");
	let out = run_in(dir.path(), "shopt -s expand_aliases; . ./f.sh", Setup::default()).await;
	assert_eq!(out, "sourced\n");
}

/// S3: a sourced line that defines and uses an alias does not expand it.
#[tokio::test]
async fn sourced_file_follows_the_line_rule() {
	let dir = tempfile::tempdir().expect("tempdir");
	std::fs::write(
		dir.path().join("f.sh"),
		"alias q='echo sourced'; q 2>/dev/null; echo \"st=$?\"\n",
	)
	.expect("fixture");
	let out = run_in(dir.path(), "shopt -s expand_aliases; . ./f.sh", Setup::default()).await;
	assert_eq!(out, "st=127\n");
}

/// S5: the line holding `source` was read before the file defined the alias.
#[tokio::test]
async fn alias_from_a_sourced_file_waits_for_the_next_line() {
	let dir = tempfile::tempdir().expect("tempdir");
	std::fs::write(dir.path().join("f.sh"), "shopt -s expand_aliases\nalias q='echo sourced'\n")
		.expect("fixture");
	let out =
		run_in(dir.path(), ". ./f.sh; q 2>/dev/null; echo \"st=$?\"\nq", Setup::default()).await;
	assert_eq!(out, "st=127\nsourced\n");
}

/// C2: a command substitution is read when it runs.
#[tokio::test]
async fn command_substitution_reads_aliases_when_it_runs() {
	let out = run("shopt -s expand_aliases; alias q='echo aliased'; echo \"<$(q)>\"").await;
	assert_eq!(out, "<aliased>\n");
}

/// C3: a command substitution honors the option as it is when it runs.
#[tokio::test]
async fn command_substitution_honors_the_option_turned_off_before_it_runs() {
	let out = run(&format!("{ON}shopt -u expand_aliases; echo \"<$(q 2>/dev/null)>\"")).await;
	assert_eq!(out, "<>\n");
}

/// C9: inside a command substitution, the line rule applies again.
#[tokio::test]
async fn command_substitution_text_follows_the_line_rule() {
	let out =
		run("shopt -s expand_aliases\necho \"<$(alias q='echo aliased'; q 2>/dev/null)>\"").await;
	assert_eq!(out, "<>\n");
}

/// X1: a process substitution is read when it runs.
#[tokio::test]
async fn process_substitution_reads_aliases_when_it_runs() {
	let out = run("shopt -s expand_aliases; alias q='echo aliased'; cat <(q)").await;
	assert_eq!(out, "aliased\n");
}

/// Y1: a process substitution honors the option as it is when it runs.
#[tokio::test]
async fn process_substitution_honors_the_option_turned_off_before_it_runs() {
	let out =
		run(&format!("{ON}shopt -u expand_aliases; cat <(q 2>/dev/null); echo \"st=$?\"")).await;
	assert_eq!(out, "st=0\n");
}

/// A process substitution reads its lines one at a time: an alias defined on
/// one line expands on the next (Bash 5.2.21 prints `new`).
#[tokio::test]
async fn process_substitution_expands_an_alias_defined_on_its_earlier_line() {
	let out = run("shopt -s expand_aliases\ncat <(alias q='echo new'\nq 2>/dev/null)").await;
	assert_eq!(out, "new\n");
}

/// A process substitution's later line gets an alias it redefined
/// (Bash 5.2.21 prints `old`, then `new`).
#[tokio::test]
async fn process_substitution_reads_a_redefined_alias_on_its_next_line() {
	let out =
		run("shopt -s expand_aliases; alias q='echo old'\ncat <(q; alias q='echo new'\nq)").await;
	assert_eq!(out, "old\nnew\n");
}

/// A multiline `if` stays one read unit in a process substitution. The alias
/// changed in its body cannot affect `q` after the `if` (Bash prints old
/// twice).
#[tokio::test]
async fn process_substitution_does_not_split_a_multiline_if_at_its_opening_line() {
	let out = run(
		"shopt -s expand_aliases\nalias q='echo old'\ncat <(if true; then alias q='echo new'\nq; \
		 fi; q)",
	)
	.await;
	assert_eq!(out, "old\nold\n");
}

/// A redirection target can span lines. It keeps its command in the current
/// read unit, so its alias change cannot affect the later same-line `q`.
#[tokio::test]
async fn process_substitution_does_not_split_at_a_multiline_redirect_target() {
	let out = run(
		"shopt -s expand_aliases\nalias q='echo old'\ncat <(alias q='echo new' >'two\nlines'; q)",
	)
	.await;
	assert_eq!(out, "old\n");
}

/// A here-document ends its line: the next line is read after the alias
/// changed (Bash 5.2.21 prints `new`).
#[tokio::test]
async fn process_substitution_reads_the_line_after_a_here_document_separately() {
	let out = run(
		"shopt -s expand_aliases\nalias q='echo old'\ncat <(alias q='echo new' <<EOF\nbody\nEOF\nq)",
	)
	.await;
	assert_eq!(out, "new\n");
}

/// A line break inside a quoted redirect target of `[[ ]]` does not end the
/// line (Bash 5.2.21 prints `old`).
#[tokio::test]
async fn process_substitution_does_not_split_at_a_test_commands_redirect_target() {
	let out = run(
		"shopt -s expand_aliases\nalias q='echo old'\ncat <(alias q='echo new'; [[ 1 ]] \
		 >'two\nlines'; q)",
	)
	.await;
	assert_eq!(out, "old\n");
}

/// A backslash-newline joins two input lines into one (Bash 5.2.21 prints
/// `old`).
#[tokio::test]
async fn process_substitution_does_not_split_at_a_continued_line() {
	let out =
		run("shopt -s expand_aliases\nalias q='echo old'\ncat <(alias q='echo new' \\\n; q)").await;
	assert_eq!(out, "old\n");
}

/// The command after a here-document's command begins a line of its own:
/// Bash prints the body right after the command that carries it (Bash 5.2.21
/// prints `new` twice).
#[tokio::test]
async fn process_substitution_reads_the_command_after_a_here_document_separately() {
	for redirections in ["<<EOF", "2>&1 <<EOF", "<<EOF <<TWO"] {
		let bodies = if redirections.ends_with("TWO") {
			"body\nEOF\ntwo\nTWO"
		} else {
			"body\nEOF"
		};
		let out = run(&format!(
			"shopt -s expand_aliases\nalias q='echo old'\ncat <(alias q='echo new' {redirections}; \
			 q\n{bodies}\nq)"
		))
		.await;
		assert_eq!(out, "new\nnew\n", "redirections: {redirections}");
	}
}

/// A line ending with `;` runs on into the next (Bash 5.2.21 prints `old`).
#[tokio::test]
async fn process_substitution_line_ending_with_a_semicolon_runs_on() {
	for end in [";", "; # comment"] {
		let out = run(&format!(
			"shopt -s expand_aliases\nalias q='echo old'\ncat <(alias q='echo new'{end}\nq)"
		))
		.await;
		assert_eq!(out, "old\n", "line end: {end:?}");
	}
}

/// A process substitution can be empty, or hold only newlines or a comment.
#[tokio::test]
async fn empty_process_substitution_runs_nothing() {
	let out = run("cat <(); cat <(\n); cat <(# only a comment\n); echo \"st=$?\"").await;
	assert_eq!(out, "st=0\n");
}

/// `declare -f` prints a process substitution with the lines it is read in,
/// so the printed function reads them the same way (Bash 5.2.21 prints `new`
/// twice).
#[tokio::test]
async fn declared_function_keeps_its_process_substitution_lines() {
	let out = run(
		"shopt -s expand_aliases\nalias q='echo old'\nf() {\n  cat <(alias q='echo \
		 new'\nq)\n}\nf\ndeclare -f f > saved\nsource saved\nf",
	)
	.await;
	assert_eq!(out, "new\nnew\n");
}

// --- functions keep the aliases of the moment they were read ---

/// F2: a function read before the alias was defined calls the plain name.
#[tokio::test]
async fn function_read_before_the_alias_does_not_expand_it() {
	let out = run(
		"shopt -s expand_aliases\nf() { q; }\nalias q='echo aliased'\nf 2>/dev/null; echo \"st=$?\"",
	)
	.await;
	assert_eq!(out, "st=127\n");
}

/// F3: a function read while the option was off keeps the plain name.
#[tokio::test]
async fn function_read_with_the_option_off_does_not_expand_it() {
	let out = run(
		"alias q='echo aliased'\nf() { q; }\nshopt -s expand_aliases\nf 2>/dev/null; echo \"st=$?\"",
	)
	.await;
	assert_eq!(out, "st=127\n");
}

/// F4: a function keeps its expansion after the option is turned off.
#[tokio::test]
async fn function_keeps_its_expansion_after_the_option_is_off() {
	let out = run(&format!("{ON}f() {{ q; }}\nshopt -u expand_aliases\nf")).await;
	assert_eq!(out, "aliased\n");
}

/// F6: removing the alias does not change a function already read.
#[tokio::test]
async fn function_keeps_its_expansion_after_unalias() {
	let out = run(&format!("{ON}f() {{ q; }}\nunalias q\nf")).await;
	assert_eq!(out, "aliased\n");
}

/// F7: `declare -f` shows the body as it was read.
#[tokio::test]
async fn declared_function_body_shows_the_substituted_words() {
	let out = run(&format!("{ON}f() {{ q; }}\ndeclare -f f")).await;
	assert!(out.contains("echo aliased"), "output: {out:?}");
	assert!(!out.contains(" q"), "output: {out:?}");
}

// --- POSIX mode ---

/// P1: POSIX mode turns alias expansion on.
#[tokio::test]
async fn posix_mode_enables_alias_expansion_for_the_next_line() {
	let out = run("set -o posix\nalias q='echo posix'\nq").await;
	assert_eq!(out, "posix\n");
}

/// D4: `shopt` reports the option on in POSIX mode.
#[tokio::test]
async fn posix_mode_reports_expand_aliases_on() {
	let out = run("set -o posix; shopt -q expand_aliases; echo \"st=$?\"").await;
	assert_eq!(out, "st=0\n");
}

/// D6: leaving POSIX mode resets the option to the non-interactive default,
/// even when it was on before.
#[tokio::test]
async fn leaving_posix_mode_turns_alias_expansion_off() {
	let out = run(
		"shopt -s expand_aliases\nset -o posix\nset +o posix\nshopt -q expand_aliases; echo \
		 \"st=$?\"",
	)
	.await;
	assert_eq!(out, "st=1\n");
}

// --- which words are looked up ---

/// W1, W2: a quoted command name is never an alias, however it is quoted.
#[tokio::test]
async fn quoted_command_name_is_not_an_alias() {
	let out = run(&format!(
		"{ON}\\q 2>/dev/null; echo \"st=$?\"; 'q' 2>/dev/null; echo \"st=$?\"; \"q\" 2>/dev/null; \
		 echo \"st=$?\""
	))
	.await;
	assert_eq!(out, "st=127\nst=127\nst=127\n");
}

/// W3: a command name produced by expansion is not an alias.
#[tokio::test]
async fn expanded_command_name_is_not_an_alias() {
	let out = run(&format!("{ON}v=q; $v 2>/dev/null; echo \"st=$?\"")).await;
	assert_eq!(out, "st=127\n");
}

/// W12: an alias's first word is itself looked up.
#[tokio::test]
async fn alias_value_starting_with_an_alias_expands_again() {
	let out = run("shopt -s expand_aliases; alias q=q2 q2='echo chained'\nq").await;
	assert_eq!(out, "chained\n");
}

/// W13: an alias is not substituted again inside its own value.
#[tokio::test]
async fn alias_naming_itself_runs_the_command_of_that_name() {
	let out = run("shopt -s expand_aliases; alias q='q -n'; q() { echo fn \"$@\"; }\nq x").await;
	assert_eq!(out, "fn -n x\n");
}

/// W8: the word after an alias whose value ends in a blank is looked up.
#[tokio::test]
async fn word_after_an_alias_ending_in_a_blank_expands() {
	let out = run("shopt -s expand_aliases; alias s='echo ' w=word\ns w").await;
	assert_eq!(out, "word\n");
}

/// Y8: each such alias makes the word after it eligible again.
#[tokio::test]
async fn alias_ending_in_a_blank_can_follow_itself() {
	let out = run("shopt -s expand_aliases; alias s='echo ' w=word\ns s w").await;
	assert_eq!(out, "echo word\n");
}

/// Y2: a quoted word in between leaves the next word eligible.
#[tokio::test]
async fn quoted_word_after_a_blank_ending_alias_keeps_the_check() {
	let out = run("shopt -s expand_aliases; alias s='echo ' w=word\ns \"x\" w").await;
	assert_eq!(out, "x word\n");
}

/// Only quoting outside a substitution makes a word quoted: a word whose
/// quotes are inside `$( )`, backquotes or `${ }` ends the check (Bash 5.2.21
/// prints `plain w`), while outer quotes, `$'...'` and a backslash keep it.
#[tokio::test]
async fn only_outer_quoting_keeps_the_check() {
	for (words, expected) in [
		("$(printf 'plain')", "plain w\n"),
		("`printf 'plain'`", "plain w\n"),
		("${v:-'plain'}", "plain w\n"),
		("\"$(printf plain)\"", "plain EXPANDED\n"),
		("$'x'", "x EXPANDED\n"),
		("\\p", "p EXPANDED\n"),
	] {
		let out =
			run(&format!("shopt -s expand_aliases; alias s='echo ' w=EXPANDED\ns {words} w")).await;
		assert_eq!(out, expected, "words: {words}");
	}
}

/// Bash's reader takes a substitution, an expansion and an extended pattern
/// each as one piece with its own quoting: quotes nested in them, an escaped
/// quote in `$'...'`, a `case` pattern in `$( )` and a here-document in
/// `$( )` leave the word unquoted, while `(` or `{` inside `${ }` is plain
/// text, so quotes after it count (Bash 5.2.21).
#[tokio::test]
async fn quoting_inside_nested_constructs_does_not_count() {
	for (words, expected) in [
		(r#"$(printf "%s" "$(printf ")")")"#, ") w\n"),
		(r"$(printf %s $'a\')b')", "a')b w\n"),
		(r#"@(plain|"other")"#, "@(plain|other) w\n"),
		(r#"${v:-(}"""#, "( EXPANDED\n"),
		(r#"${v:-{}"""#, "{ EXPANDED\n"),
		(r"$(case x in (x) echo 'p';; esac)", "p w\n"),
		(r#"$(case a in (@(a|b)) echo "ok";; esac)"#, "ok w\n"),
		(r#"$(echo case in)"""#, "case in EXPANDED\n"),
		("$(cat <<'EOF'\n) \"\nEOF\n)", ") \" w\n"),
	] {
		let out =
			run(&format!("shopt -s expand_aliases extglob; alias s='echo ' w=EXPANDED\ns {words} w"))
				.await;
		assert_eq!(out, expected, "words: {words}");
	}
}

/// An assignment-shaped argument after the command name is a word like any
/// other: a quoted one keeps the check, an unquoted one ends it (Bash 5.2.21).
#[tokio::test]
async fn assignment_shaped_argument_keeps_the_check_when_quoted() {
	for (words, expected) in [
		("x='one'", "x=one EXPANDED\n"),
		("x+='one'", "x+=one EXPANDED\n"),
		("x[1]='a'", "x[1]=a EXPANDED\n"),
		("x=''", "x= EXPANDED\n"),
		("x='a' y='b'", "x=a y=b EXPANDED\n"),
		("x=one", "x=one w\n"),
		("x=$(printf 'one')", "x=one w\n"),
	] {
		let out =
			run(&format!("shopt -s expand_aliases; alias s='echo ' w=EXPANDED\ns {words} w")).await;
		assert_eq!(out, expected, "words: {words}");
	}
}

/// Y19: a redirection in between ends the check.
#[tokio::test]
async fn redirection_after_a_blank_ending_alias_ends_the_check() {
	let out = run("shopt -s expand_aliases; alias s='echo ' w=word\ns 2>/dev/null w").await;
	assert_eq!(out, "w\n");
}

/// Y12: when aliases end together, the outermost decides about the next word.
#[tokio::test]
async fn outermost_alias_decides_whether_the_next_word_is_looked_up() {
	let out = run("shopt -s expand_aliases; alias a=b b='echo ' w=word\na w").await;
	assert_eq!(out, "w\n");
}

/// Y9: after an alias that expands to nothing, the next word is the command
/// name and is looked up.
#[tokio::test]
async fn empty_alias_leaves_the_next_word_as_the_command_name() {
	let out = run("shopt -s expand_aliases; alias e='' q='echo aliased'\ne q").await;
	assert_eq!(out, "aliased\n");
}

/// Y4: after an alias that expands to nothing, an assignment still assigns.
#[tokio::test]
async fn empty_alias_keeps_a_following_assignment() {
	let out = run("shopt -s expand_aliases; alias e=''\ne X=1 printenv X").await;
	assert_eq!(out, "1\n");
}

/// Y20: an alias's value can start with an assignment.
#[tokio::test]
async fn alias_value_can_start_with_an_assignment() {
	let out = run("shopt -s expand_aliases; alias e='X=1 printenv'\ne X").await;
	assert_eq!(out, "1\n");
}

/// Y11: quoting in an alias's value is kept.
#[tokio::test]
async fn alias_value_keeps_its_quoting() {
	let out = run("shopt -s expand_aliases; alias q='echo \"a  b\"'\nq").await;
	assert_eq!(out, "a  b\n");
}

/// A3, A5: Bash looks for an alias after redirections that begin the command,
/// and after an assignment.
#[tokio::test]
async fn word_after_leading_redirections_is_looked_up() {
	let out = run(&format!("{ON}2>/dev/null q; >/dev/stdout x=1 q")).await;
	assert_eq!(out, "aliased\naliased\n");
}

/// A4: a redirection after an assignment ends the command position, and a
/// later assignment does not restore it (Bash 5.2.21: `q: command not found`).
#[tokio::test]
async fn word_after_a_redirection_that_follows_an_assignment_is_not_looked_up() {
	for command in ["x=1 >/dev/null q", ">/dev/null x=1 >/dev/null q", "x=1 >/dev/null y=2 q"] {
		let out = run(&format!("{ON}{command} 2>/dev/null; echo \"st=$?\"")).await;
		assert_eq!(out, "st=127\n", "command: {command}");
	}
}

/// The same holds for assignments an alias's value exposes: an empty or blank
/// value leaves the next word as the start of the command, and a value can
/// start with an assignment (Bash 5.2.21: `q: command not found`).
#[tokio::test]
async fn redirection_after_an_assignment_from_an_alias_ends_the_command_position() {
	for (alias, command) in [
		("e=''", "e x=1 >/dev/null q"),
		("e=' '", "e x=1 >/dev/null q"),
		("e='x=1'", "e >/dev/null q"),
		("e='x=1 '", "e >/dev/null y=1 q"),
	] {
		let out = run(&format!("{ON}alias {alias}\n{command} 2>/dev/null; echo \"st=$?\"")).await;
		assert_eq!(out, "st=127\n", "alias {alias}; {command}");
	}
	let out = run(&format!("{ON}alias e=''\ne >/dev/stdout x=1 q")).await;
	assert_eq!(out, "aliased\n");
}

// --- commands that report or run another command ---

/// R7: `type` does not report an alias while the option is off.
#[tokio::test]
async fn type_does_not_report_an_alias_while_the_option_is_off() {
	let out = run("alias q='echo aliased'; type -t q; echo \"st=$?\"").await;
	assert_eq!(out, "st=1\n");
}

/// R8: `type` reports an alias while the option is on.
#[tokio::test]
async fn type_reports_an_alias_while_the_option_is_on() {
	let out = run("shopt -s expand_aliases; alias q='echo aliased'; type -t q").await;
	assert_eq!(out, "alias\n");
}

/// X8: `timeout` runs its operand as a program, never as an alias.
#[tokio::test]
async fn timeout_operand_is_not_an_alias() {
	let out = run(&format!("{ON}timeout 5 q 2>/dev/null; echo \"st=$?\"")).await;
	assert_eq!(out, "st=127\n");
}

/// X9: `nohup` runs its operand as a program, never as an alias.
#[tokio::test]
async fn nohup_operand_is_not_an_alias() {
	let out = run(&format!("{ON}nohup q >/dev/null 2>&1; echo \"st=$?\"")).await;
	assert_eq!(out, "st=127\n");
}

/// Y14: an alias in a background command expands.
#[tokio::test]
async fn background_command_expands_an_alias() {
	let out = run(&format!("{ON}q &\nwait")).await;
	assert_eq!(out, "aliased\n");
}

/// Y15: with the option off, a background command named like an alias runs
/// the program of that name.
#[tokio::test]
async fn background_command_named_like_an_alias_runs_the_program_while_the_option_is_off() {
	let out = run("alias ls='echo aliased-ls'\nls -d / &\nwait").await;
	assert_eq!(out, "/\n");
}

// --- the bash tool's sessions ---

const SNAPSHOT: &str = "shopt -s expand_aliases\nalias -- q='echo snapshotted'\n";

/// A shell snapshot turns the option on, so its aliases expand in the tool.
#[tokio::test]
async fn snapshot_aliases_expand_in_the_tool_shell() {
	let out = run_with("q", Setup { snapshot: Some(SNAPSHOT), ..Setup::default() }).await;
	assert_eq!(out, "snapshotted\n");
}

/// The minimizer runs a `;` chain's commands one at a time; a chain holding
/// `shopt` must still be read as one line (T6 through the tool).
#[tokio::test]
async fn minimized_chain_is_read_as_one_line() {
	let out = run_with("shopt -u expand_aliases; q; echo \"st=$?\"", Setup {
		snapshot:  Some(SNAPSHOT),
		minimizer: true,
	})
	.await;
	assert_eq!(out, "snapshotted\nst=0\n");
}

/// A chain whose command runs `shopt` through `builtin` and a quoted word is
/// still read as one line by the minimizer path.
#[tokio::test]
async fn minimized_chain_with_a_wrapped_option_change_is_read_as_one_line() {
	let out = run_with("builtin 'shopt' -u expand_aliases; q; echo \"st=$?\"", Setup {
		snapshot:  Some(SNAPSHOT),
		minimizer: true,
	})
	.await;
	assert_eq!(out, "snapshotted\nst=0\n");
}

/// A chain whose first command is a function that changes the option is still
/// read as one line by the minimizer path.
#[tokio::test]
async fn minimized_chain_with_a_function_that_changes_the_option_is_read_as_one_line() {
	let snapshot =
		"shopt -s expand_aliases\nalias -- q='echo snapshotted'\nf () { shopt -u expand_aliases; }\n";
	let out =
		run_with("f; q; echo \"st=$?\"", Setup { snapshot: Some(snapshot), minimizer: true }).await;
	assert_eq!(out, "snapshotted\nst=0\n");
}

/// A wrapper chosen through expansion can turn alias expansion on. The line
/// was read with expansion off, so no later command on it is an alias.
#[tokio::test]
async fn minimized_chain_with_an_expanded_wrapper_is_read_as_one_line() {
	let snapshot = "alias -- q='echo new'\nx=shopt\n";
	let out = run_with("builtin \"$x\" -s expand_aliases; q 2>/dev/null; echo \"st=$?\"", Setup {
		snapshot:  Some(snapshot),
		minimizer: true,
	})
	.await;
	assert_eq!(out, "st=127\n");
}

/// With no alias defined when the line is read, Bash substitutes no alias in
/// it, even after an earlier command on the line defines one indirectly.
#[tokio::test]
async fn minimized_chain_reads_no_alias_an_earlier_segment_defines() {
	let snapshot = "shopt -s expand_aliases\nx=eval\nv=\"alias q='echo new'\"\n";
	let out = run_with("builtin \"$x\" \"$v\"; q 2>/dev/null; echo \"st=$?\"", Setup {
		snapshot:  Some(snapshot),
		minimizer: true,
	})
	.await;
	assert_eq!(out, "st=127\n");
}

/// The minimizer runs each line of a multi-line input with the aliases that
/// line began with, not the first line's.
#[tokio::test]
async fn minimized_input_reads_each_line_with_its_own_aliases() {
	let out = run_with("shopt -s expand_aliases\nq 2>/dev/null; echo \"st=$?\"", Setup {
		snapshot:  Some("alias -- q='echo old'\n"),
		minimizer: true,
	})
	.await;
	assert_eq!(out, "old\nst=0\n");

	let snapshot = "shopt -s expand_aliases\nx=eval\nv=\"alias q='echo new'\"\n";
	let out = run_with("builtin \"$x\" \"$v\"\nq 2>/dev/null; echo \"st=$?\"", Setup {
		snapshot:  Some(snapshot),
		minimizer: true,
	})
	.await;
	assert_eq!(out, "new\nst=0\n");
}

/// A newline inside an alias's value ends a command within the line: what is
/// read after it, in that command and in the rest of the line, is read with
/// the aliases as they are then, and a comment it begins takes the rest of
/// the line, as Bash does, with or without the minimizer.
#[tokio::test]
async fn line_reads_after_a_newline_in_an_alias_with_the_aliases_then() {
	let snapshot =
		"shopt -s expand_aliases\nalias -- r='echo OLD'\nalias -- q=$'alias r=\"echo NEW\"\\nr'\n";
	for minimizer in [false, true] {
		let out = run_with("git status --short 2>/dev/null; q; echo END", Setup {
			snapshot: Some(snapshot),
			minimizer,
		})
		.await;
		assert_eq!(out, "NEW\nEND\n", "minimizer {minimizer}");
	}
	let snapshot = "shopt -s expand_aliases\nalias -- q=$'alias r2=\"echo LATE\"\\n:'\n";
	for minimizer in [false, true] {
		let out = run_with("git status --short 2>/dev/null; q; r2", Setup {
			snapshot: Some(snapshot),
			minimizer,
		})
		.await;
		assert_eq!(out, "LATE\n", "minimizer {minimizer}");
	}
	let snapshot = "shopt -s expand_aliases\nalias -- r='echo OLD'\nalias -- q=$'alias r=\"echo \
	                NEW\"\\n#COMMENT'\n";
	for minimizer in [false, true] {
		let out = run_with("git status --short 2>/dev/null; q; r", Setup {
			snapshot: Some(snapshot),
			minimizer,
		})
		.await;
		assert_eq!(out, "", "minimizer {minimizer}");
	}
}

/// From a line in which a command begins with an alias, the input runs as
/// written: a comment, a trailing backslash or a blank in the alias's value
/// acts on the input after it as in Bash, with or without the minimizer. A
/// redirection or a `!` before the alias's name stays with it (G57 to G60).
#[tokio::test]
async fn input_after_an_alias_runs_as_written() {
	let cases = [
		("shopt -s expand_aliases\nalias -- q='echo Q #'\n", "q &&\necho END", "Q\nEND\n"),
		("shopt -s expand_aliases\nalias -- q='false #'\n", "q &&\necho END", "END\n"),
		("shopt -s expand_aliases\nalias -- q='echo Q \\'\n", "q\necho LAST", "Q echo LAST\n"),
		(
			"shopt -s expand_aliases\nalias -- q='echo Q\\'\n",
			"git status --short 2>/dev/null; q word",
			"Q word\n",
		),
		("shopt -s expand_aliases\nalias -- q='echo Q'\n", ">out q; cat out", "Q\n"),
		(
			"shopt -s expand_aliases\nalias -- q='echo Q'\n",
			"git status --short 2>/dev/null\n>out q; cat out",
			"Q\n",
		),
		(
			"shopt -s expand_aliases\nalias -- q='false'\n",
			"git status --short 2>/dev/null\n! q; echo \"st=$?\"",
			"st=0\n",
		),
		(
			"shopt -s expand_aliases\nalias -- q='cat'\n",
			"printf 'DATA\\n' > in\n<in q; echo AFTER",
			"DATA\nAFTER\n",
		),
	];
	for (snapshot, command, expected) in cases {
		for minimizer in [false, true] {
			let out = run_with(command, Setup { snapshot: Some(snapshot), minimizer }).await;
			assert_eq!(out, expected, "{snapshot:?} {command:?} minimizer {minimizer}");
		}
	}
}
