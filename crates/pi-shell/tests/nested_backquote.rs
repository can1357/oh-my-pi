//! Backslashes in a backquoted command substitution, against Bash 5.2.21.
//!
//! Before a backquoted body runs, Bash removes the backslash before `$`, a
//! backquote and `\`, removes a backslash-newline, and, when the backquotes are
//! in double quotes, removes the backslash before `"`. Any other backslash
//! stays. Each nesting level therefore halves the backslashes the level below
//! needs. Every expected output below is what Bash 5.2.21 prints for the same
//! script.
//!
//! The word of a `${...}` inside double quotes is not a double-quoted string
//! for this rule. brush parses it on its own, so the tests for it also check
//! that parse's other effects.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str) -> (Option<i32>, String) {
	let dir = tempfile::tempdir().expect("tempdir");
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let output: String = rx.drain().collect();
	(result.exit_code, output)
}

/// `echo bottom` nested `depth` levels deep in backquotes. Level `k` (0 is the
/// outermost) puts `2^k - 1` backslashes before its backquotes, so three levels
/// read ``echo `echo \`echo \\\`echo bottom\\\`\`` `` and every level unwraps
/// to `echo bottom`.
fn nested(depth: u32) -> String {
	let mut script = String::from("echo bottom");
	for level in (0..depth).rev() {
		let quote = format!("{}`", "\\".repeat((1 << level) - 1));
		script = format!("echo {quote}{script}{quote}");
	}
	script
}

#[tokio::test]
async fn backquotes_nested_two_deep_print_bottom() {
	let (code, output) = run(&nested(2)).await;
	assert_eq!((code, output.as_str()), (Some(0), "bottom\n"));
}

#[tokio::test]
async fn backquotes_nested_three_deep_print_bottom() {
	let (code, output) = run(&nested(3)).await;
	assert_eq!((code, output.as_str()), (Some(0), "bottom\n"));
}

#[tokio::test]
async fn backquotes_nested_four_deep_print_bottom() {
	let (code, output) = run(&nested(4)).await;
	assert_eq!((code, output.as_str()), (Some(0), "bottom\n"));
}

#[tokio::test]
async fn backquotes_nested_five_deep_print_bottom() {
	let (code, output) = run(&nested(5)).await;
	assert_eq!((code, output.as_str()), (Some(0), "bottom\n"));
}

/// Two levels deep, `\\\$` reaches the inner level as `\$` and the innermost
/// command as `$`.
#[tokio::test]
async fn backquotes_nested_two_deep_unescape_dollar_at_each_level() {
	let (code, output) = run(r"x=VAL; echo `echo \`echo \\\$x\``").await;
	assert_eq!((code, output.as_str()), (Some(0), "VAL\n"));
}

#[tokio::test]
async fn backquote_removes_backslash_before_dollar() {
	let (code, output) = run(r"x=VAL; echo `echo \$x`").await;
	assert_eq!((code, output.as_str()), (Some(0), "VAL\n"));
}

/// The body is unescaped before it is parsed, so `\\` is halved even inside
/// the body's single quotes.
#[tokio::test]
async fn backquote_halves_escaped_backslash() {
	let (code, output) = run(r"echo `printf '%s\n' 'a\\b'`").await;
	assert_eq!((code, output.as_str()), (Some(0), "a\\b\n"));
}

/// `\\\\\\` before the closing backquote leaves the body ending in a lone
/// backslash, which Bash keeps as a literal character.
#[tokio::test]
async fn backquote_keeps_trailing_backslash_literal() {
	let (code, output) = run(r"printf '%s\n' `printf '%s' \\\\\\`").await;
	assert_eq!((code, output.as_str()), (Some(0), "\\\\\n"));
}

#[tokio::test]
async fn backquote_in_double_quotes_removes_backslash_before_quote() {
	let (code, output) = run(r#"echo "`echo \"q\"`""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "q\n"));
}

#[tokio::test]
async fn unquoted_backquote_keeps_backslash_before_quote() {
	let (code, output) = run(r#"echo `echo \"q\"`"#).await;
	assert_eq!((code, output.as_str()), (Some(0), "\"q\"\n"));
}

/// Elsewhere a backquoted command keeps the backslash before any other
/// character, in double quotes or not.
#[tokio::test]
async fn backquote_keeps_backslash_before_other_characters() {
	let (code, output) = run(r#"echo `printf %s '\a'` "`printf %s '\a'`""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "\\a \\a\n"));
}

/// A here-document body is not a double-quoted string: `\"` stays.
#[tokio::test]
async fn backquote_in_heredoc_keeps_backslash_before_quote() {
	let (code, output) = run("cat <<E\n`echo \\\"q\\\"`\nE").await;
	assert_eq!((code, output.as_str()), (Some(0), "\"q\"\n"));
}

/// Neither is the word of a `${...}` inside double quotes: `\"` stays.
#[tokio::test]
async fn backquote_in_double_quoted_parameter_word_keeps_backslash_before_quote() {
	let (code, output) = run(r#"echo "${u:-`echo \"q\"`}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "\"q\"\n"));
}

/// Nor between two double-quoted strings in that word.
#[tokio::test]
async fn backquote_between_quoted_parts_of_parameter_word_keeps_backslash_before_quote() {
	let (code, output) = run(r#"echo "${u:-"x"`echo \"q\"`"y"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "x\"q\"y\n"));
}

/// Inside that word's own double quotes, Bash first drops the backslash before
/// any character but `$`, `` ` ``, `"`, `\` and newline, so the single-quoted
/// `\a` reaches `printf` as `a` and `\\\b` as `\b`; `\"` stays.
#[tokio::test]
async fn backquote_in_quoted_part_of_parameter_word_drops_other_backslashes() {
	let (code, output) = run(r#"echo "${u:-"`printf '%s|' '\a' \\\b \"q\"`"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "a|b|\"q\"|\n"));
}

/// The same with text around those double quotes, a word that brush-core
/// parses by another path.
#[tokio::test]
async fn backquote_in_quoted_part_of_split_parameter_word_drops_other_backslashes() {
	let (code, output) = run(r#"echo "${u:-x"`printf %s '\a'`"y}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "xay\n"));
}

/// Between the quoted parts of that word, the backslash stays.
#[tokio::test]
async fn backquote_between_quoted_parts_of_parameter_word_keeps_other_backslashes() {
	let (code, output) = run(r#"echo "${u:-"x"`printf %s '\a'`"y"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "x\\ay\n"));
}

/// The word of a `${...}` nested in such a word is inside double quotes as
/// well: `\"` stays in its backquotes. Removing it would also leave `p"z` with
/// an unterminated double quote.
#[tokio::test]
async fn backquote_in_nested_parameter_word_keeps_backslash_before_quote() {
	let (code, output) = run(r#"echo "${u:-"${v:-"`printf %s '\"' p\"z`"}"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "\\\"p\"z\n"));
}

/// Inside the nested word's own double quotes, the backslash before other
/// characters goes, as at the first level.
#[tokio::test]
async fn backquote_in_quoted_part_of_nested_parameter_word_drops_other_backslashes() {
	let (code, output) = run(r#"echo "${u:-"${v:-"`printf %s '\a'`"}"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "a\n"));
}

/// A replacement is not part of such a word: Bash expands it outside double
/// quotes, so a `${...}` word inside it is not inside them either, and its own
/// double-quoted backquotes lose the backslash before `"`.
#[tokio::test]
async fn parameter_word_in_replacement_in_parameter_word_is_not_quoted_by_it() {
	let (code, output) = run(r#"y=Q; echo "${u:-"${y/Q/${w:-"`printf %s '\"'`"}}"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "\"\n"));
}

/// The same holds for a pattern or replacement directly inside double quotes:
/// the backquotes of a `${...}` word in the replacement keep the backslash
/// before `a`, and the pattern's `"\a"` is a backslash and an `a`.
#[tokio::test]
async fn parameter_word_in_pattern_or_replacement_is_not_quoted() {
	let (code, output) =
		run(r#"y=Q p='\az'; echo "${y/Q/${w:-"`printf %s '\a'`"}}" "${p#${w:-"\a"}}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "\\a z\n"));
}

/// The double-quote context of such a word ends with it: a later `${...}`
/// word outside double quotes gets the ordinary rule, so its double-quoted
/// backquotes lose the backslash before `"`.
#[tokio::test]
async fn parameter_word_after_nested_word_is_not_quoted_by_it() {
	let (code, output) = run(r#"echo ${u:-"${v:-"x"}"}${w:-"`printf %s '\"'`"}"#).await;
	assert_eq!((code, output.as_str()), (Some(0), "x\"\n"));
}

/// A pattern is not such a word: its backquotes in double quotes lose the
/// backslash before `"`, after a `${...}` word earlier in the string too. The
/// pattern is then `q`, which does not match the start of `"q"z`.
#[tokio::test]
async fn backquote_in_pattern_after_parameter_word_removes_backslash_before_quote() {
	let (code, output) = run(r#"x='"q"z'; echo "${u:-a}${x#"`echo \"q\"`"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "a\"q\"z\n"));
}

/// The word of a `${...}` inside double quotes takes no leading `~` as a tilde
/// expansion, also when the whole word is one double-quoted string.
#[tokio::test]
async fn tilde_in_double_quoted_parameter_word_stays_literal() {
	let (code, output) = run(r#"HOME=/h; echo "${u:-"~/x"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "~/x\n"));
}

/// Inside that word's own double quotes `'` is a literal character, so neither
/// `'...'` nor `$'...'` quotes anything there, at the first level or nested.
#[tokio::test]
async fn single_quote_in_quoted_part_of_parameter_word_is_literal() {
	let (code, output) = run(r#"echo "${u:-"'s q'"}" "${u:-"${v:-"$'t'"}"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "'s q' $'t'\n"));
}

/// Outside those quotes `$'...'` is ANSI-C quoting, as with Bash's default
/// `extquote` option, at the first level or nested.
#[tokio::test]
async fn ansi_c_quote_outside_quoted_part_of_parameter_word_expands() {
	let (code, output) = run(r#"echo "${u:-$'a\x41'}" "${u:-"${v:-$'t'}"}""#).await;
	assert_eq!((code, output.as_str()), (Some(0), "aA t\n"));
}

/// A backslash-newline is removed from the body before it is parsed, so the
/// body's single quotes never see it.
#[tokio::test]
async fn backquote_removes_line_continuation() {
	let (code, output) = run("echo `echo 'a\\\nb'`").await;
	assert_eq!((code, output.as_str()), (Some(0), "ab\n"));
}
