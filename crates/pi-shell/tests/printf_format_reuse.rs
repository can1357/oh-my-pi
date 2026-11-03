//! `printf` reuses its format as Bash 5.2.21 does: while arguments remain, and
//! only when the format uses arguments, so a format with no conversion is
//! written once. `\c` in a `%b` argument ends all output; in the format itself
//! it is two literal characters. `%q` quotes with backslashes in any format.
//!
//! Each test names the Bash 5.2.21 rows it reproduces; the expected output is
//! what `bash -c` printed for the same text. A format that loops forever would
//! fill the output without end, so those rows read it through `head`, which
//! ends the loop once it has read enough.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str) -> String {
	let dir = tempfile::tempdir().expect("tempdir");
	let (tx, rx) = flume::unbounded::<String>();
	execute_shell(
		ShellExecuteOptions {
			command: command.to_owned(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
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

/// P01, P02, P03, P04: a format with no conversion (text, `%%`, escapes) is
/// written once, whatever arguments follow it.
#[tokio::test]
async fn format_without_conversion_is_written_once() {
	assert_eq!(run("printf 'late\\n' early | head -c 64").await, "late\n");
	assert_eq!(run("printf 'a\\n' x y z | head -c 64").await, "a\n");
	assert_eq!(run("printf '%%\\n' x | head -c 64").await, "%\n");
	assert_eq!(run("printf '\\t-\\n' x | head -c 64").await, "\t-\n");
}

/// P05: an empty format with an argument writes nothing and ends.
#[tokio::test]
async fn empty_format_with_an_argument_ends() {
	assert_eq!(run("printf '' x; echo \"st=$?\"").await, "st=0\n");
}

/// P10: `-v` stores a format with no conversion once.
#[tokio::test]
async fn format_without_conversion_is_stored_once() {
	assert_eq!(run("printf -v v 'late' early; echo \"[$v]\"").await, "[late]\n");
}

/// P06, P07, P11, P13, P15, P16, P19: a format that uses arguments is reused
/// until they are used up, and written once when there are none.
#[tokio::test]
async fn format_with_conversions_is_reused_while_arguments_remain() {
	assert_eq!(run("printf '%s|' a b c; echo").await, "a|b|c|\n");
	assert_eq!(run("printf '%s %s|' a b c; echo").await, "a b|c |\n");
	assert_eq!(run("printf -v v '%s,' a b; echo \"[$v]\"").await, "[a,b,]\n");
	assert_eq!(run("printf '%*d|' 3 1 4 2; echo").await, "  1|   2|\n");
	assert_eq!(run("printf '%s|'; echo").await, "|\n");
	assert_eq!(run("printf '%d\\n'").await, "0\n");
	assert_eq!(run("printf '%%%s|' a b; echo").await, "%a|%b|\n");
}

/// P12, P20: `%q` quotes with backslashes in any format, as Bash does,
/// including a `#` that begins a word and a `~` that begins one or follows
/// `=` or `:`.
#[tokio::test]
async fn percent_q_quotes_with_backslashes() {
	assert_eq!(run("printf '%q|' 'a b' c; echo").await, "a\\ b|c|\n");
	assert_eq!(
		run("printf '%q|' '~x' '#x' 'a=~x' 'a:~x' 'a~b' 'x#' ''; echo").await,
		"\\~x|\\#x|a=\\~x|a:\\~x|a~b|x#|''|\n"
	);
}

/// P08, P17, P18: `\c` in a `%b` argument ends all output, including the
/// passes the remaining arguments would make.
#[tokio::test]
async fn backslash_c_in_a_b_argument_ends_all_output() {
	assert_eq!(run("printf '%b|' 'a\\cb' x; echo").await, "a\n");
	assert_eq!(run("printf '%b' 'x\\c' y; echo").await, "x\n");
	assert_eq!(run("printf -v v '%b|' 'a\\cb' x; echo \"[$v]\"").await, "[a]\n");
}

/// P09: `\c` in the format is written as it is.
#[tokio::test]
async fn backslash_c_in_the_format_is_literal() {
	assert_eq!(run("printf 'x\\cy|%s' a b; echo").await, "x\\cy|ax\\cy|b\n");
}
