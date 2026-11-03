//! The bash tool's shell reads an alias's value in place of its name, as Bash
//! 5.2.21 does: the value can hold operators, reserved words, redirections or
//! the start of a quoted string, and the shell keeps the alias table and the
//! `BASH_ALIASES` array in step.
//!
//! Each test names the Bash 5.2.21 row it reproduces; the expected output is
//! what `bash -c` printed for the same text.
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

/// Runs `body` after turning alias expansion on and defining `aliases`.
async fn with_aliases(aliases: &str, body: &str) -> String {
	run(&format!("shopt -s expand_aliases\nalias {aliases}\n{body}")).await
}

/// `out` without the lines the host adds to report a command that failed with
/// an error; it reports them whatever standard error is redirected to.
fn without_error_reports(out: &str) -> String {
	out.lines()
		.filter(|line| !line.starts_with("error: "))
		.map(|line| format!("{line}\n"))
		.collect()
}

// --- alias values that are shell syntax ---

/// B01, B02, B07, B18, B31: lists and pipelines in a value.
#[tokio::test]
async fn alias_value_can_hold_lists_and_pipelines() {
	assert_eq!(with_aliases("q='echo a; echo b'", "q").await, "a\nb\n");
	assert_eq!(with_aliases("q='echo a | tr a b'", "q").await, "b\n");
	assert_eq!(with_aliases("q='echo a;'", "q echo b").await, "a\nb\n");
	assert_eq!(with_aliases("q='echo a &&'", "q echo b").await, "a\nb\n");
	assert_eq!(with_aliases("q='echo a |'", "q tr a z").await, "z\n");
}

/// B03, B08, B09, B19, B20, B21, B32: compound commands in a value, whole or
/// begun in the value and ended in the input.
#[tokio::test]
async fn alias_value_can_hold_or_begin_compound_commands() {
	assert_eq!(with_aliases("begin='{'", "begin echo braced; }").await, "braced\n");
	assert_eq!(with_aliases("q='if true; then echo yes; fi'", "q").await, "yes\n");
	assert_eq!(with_aliases("q='('", "q echo sub )").await, "sub\n");
	assert_eq!(with_aliases("q='while false; do'", "q :; done; echo end").await, "end\n");
	assert_eq!(with_aliases("q='for i in 1 2; do echo $i; done'", "q").await, "1\n2\n");
	assert_eq!(with_aliases("q='case x in x) echo cx;; esac'", "q").await, "cx\n");
	assert_eq!(with_aliases("q='{ echo in;'", "q }").await, "in\n");
}

/// B05, B28: redirections in a value, before and after the command.
#[tokio::test]
async fn alias_value_can_hold_redirections() {
	assert_eq!(with_aliases("q='echo 2>/dev/null'", "q; echo \"st=$?\"").await, "\nst=0\n");
	assert_eq!(with_aliases("q='>/dev/null echo hidden'", "q; echo \"st=$?\"").await, "st=0\n");
}

/// B10: a here-document begun in a value takes its body from the input.
#[tokio::test]
async fn alias_value_can_begin_a_here_document() {
	assert_eq!(with_aliases("q='cat <<EOF'", "q\nbody\nEOF").await, "body\n");
}

/// B04, B14, B15: a value can open a quote the input closes, end with a
/// backslash that joins the next input line, or span lines.
#[tokio::test]
async fn alias_value_is_read_as_input_text() {
	assert_eq!(with_aliases("q='echo \"unterminated'", "q\nrest\"").await, "unterminated\nrest\n");
	assert_eq!(with_aliases("q='echo x \\'", "q\necho y").await, "x echo y\n");
	assert_eq!(with_aliases("q=$'echo l1\\necho l2'", "q").await, "l1\nl2\n");
}

/// B22, B23: a value can define a function.
#[tokio::test]
async fn alias_value_can_define_a_function() {
	assert_eq!(with_aliases("q='function g { echo fg; }'", "q; g").await, "fg\n");
	assert_eq!(with_aliases("q='g() { echo pg; }'", "q; g").await, "pg\n");
}

/// B24, B12, B25: substitutions and arithmetic in a value.
#[tokio::test]
async fn alias_value_can_hold_substitutions_and_arithmetic() {
	assert_eq!(with_aliases("q='echo $(echo inner)'", "q").await, "inner\n");
	assert_eq!(with_aliases("q='echo $((1+2))'", "q").await, "3\n");
	assert_eq!(with_aliases("q='((x=3)); echo $x'", "q").await, "3\n");
}

/// B30, C33: an alias in a value's later command is substituted too; aliases
/// that name each other stop.
#[tokio::test]
async fn aliases_inside_values_and_cycles() {
	assert_eq!(with_aliases("q='echo a' p='q; echo b'", "p").await, "a\nb\n");
	assert_eq!(with_aliases("a=b b=a", "a 2>/dev/null; echo \"st=$?\"").await, "st=127\n");
}

/// A declaration builtin in a value gets its assignment as an assignment.
#[tokio::test]
async fn alias_value_can_hold_a_declaration_builtin() {
	assert_eq!(with_aliases("q='export X=\"a  b\"'", "q; printenv X").await, "a  b\n");
}

// --- reserved words ---

/// B06: an alias named like a reserved word is substituted where the word is
/// not reserved.
#[tokio::test]
async fn alias_named_like_a_reserved_word_where_it_is_not_reserved() {
	assert_eq!(with_aliases("if='echo not-a-keyword'", "if").await, "not-a-keyword\n");
}

/// B16: an alias substituted for a function's name defines the function under
/// the value's name.
#[tokio::test]
async fn alias_substituted_for_a_function_name() {
	assert_eq!(with_aliases("f=g", "f() { echo in-g; }\ng").await, "in-g\n");
}

// --- POSIX mode: when a substitution's aliases are read ---

/// D01, D02, D04, D06, D09: in POSIX mode a `$( )` or `<( )` substitution gets
/// its aliases when the command around it is read.
#[tokio::test]
async fn posix_mode_substitutions_read_aliases_with_their_command() {
	let early = "set -o posix\nalias q='echo early'\n";
	assert_eq!(
		run(&format!("{early}f() {{ echo \"<$(q)>\"; }}\nalias q='echo late'\nf")).await,
		"<early>\n"
	);
	assert_eq!(run(&format!("{early}f() {{ cat <(q); }}\nalias q='echo late'\nf")).await, "early\n");
	assert_eq!(run(&format!("{early}f() {{ echo \"<$(q)>\"; }}\nunalias q\nf")).await, "<early>\n");
	assert_eq!(run(&format!("{early}x=$(q); echo \"x=$x\"")).await, "x=early\n");
	assert_eq!(
		run(&format!("{early}f() {{ echo \"<$(echo \"$(q)\")>\"; }}\nalias q='echo late'\nf")).await,
		"<early>\n"
	);
}

/// D03, D08, D10: backquoted text is read when it runs, and a substitution
/// read before the alias existed does not get it.
#[tokio::test]
async fn posix_mode_backquotes_read_aliases_when_they_run() {
	let early = "set -o posix\nalias q='echo early'\n";
	assert_eq!(
		run(&format!("{early}f() {{ echo \"<`q`>\"; }}\nalias q='echo late'\nf")).await,
		"<late>\n"
	);
	assert_eq!(
		run("set -o posix\nf() { echo \"<$(q)>\"; }\nalias q='echo late'\nf 2>/dev/null").await,
		"<>\n"
	);
	assert_eq!(
		run(&format!("{early}echo \"<$(q)>\"; alias q='echo late'; echo \"<$(q)>\"")).await,
		"<early>\n<early>\n"
	);
}

// --- alias names and the alias table ---

/// E01, E03, E05, E09: a name holding shell syntax is rejected.
#[tokio::test]
async fn alias_name_with_shell_syntax_is_rejected() {
	for name in ["a/b", "a$b", "a;b", "a(b"] {
		let out = run(&format!("alias '{name}=echo x' 2>/dev/null; echo \"st=$?\"")).await;
		assert_eq!(out, "st=1\n", "name {name}");
	}
}

/// E02, E10: other punctuation is valid; `alias` lists names in order.
#[tokio::test]
async fn alias_name_with_other_punctuation_is_valid() {
	assert_eq!(
		run("alias 'a-b=echo x' '.x=echo y' 'a.b=echo z'; alias").await,
		"alias .x='echo y'\nalias a-b='echo x'\nalias a.b='echo z'\n"
	);
}

/// E23: `alias` and `command -v` quote a value so it reads back.
#[tokio::test]
async fn alias_listing_quotes_values() {
	assert_eq!(
		with_aliases("q=\"it's\"", "command -v q; alias q").await,
		"alias q='it'\\''s'\nalias q='it'\\''s'\n"
	);
}

/// E11, E12, E16: `BASH_ALIASES` reads and defines aliases.
#[tokio::test]
async fn bash_aliases_reads_and_defines_aliases() {
	assert_eq!(run("alias q='echo x'; echo \"${BASH_ALIASES[q]}\"").await, "echo x\n");
	assert_eq!(
		run("shopt -s expand_aliases\nBASH_ALIASES[q]='echo via-array'\nq; alias").await,
		"via-array\nalias q='echo via-array'\n"
	);
	assert_eq!(run("BASH_ALIASES=(); alias q=x; echo \"${#BASH_ALIASES[@]}\"").await, "1\n");
}

/// E13, E15: unsetting an element or the array leaves the aliases.
#[tokio::test]
async fn unsetting_bash_aliases_leaves_the_aliases() {
	assert_eq!(
		run("alias q='echo x' r='echo y'; unset 'BASH_ALIASES[q]'; alias").await,
		"alias q='echo x'\nalias r='echo y'\n"
	);
	assert_eq!(
		run("alias q='echo x'; unset BASH_ALIASES; alias; echo \"st=$?\"").await,
		"alias q='echo x'\nst=0\n"
	);
}

// --- command -v and -V ---

/// E18, E19, E20, E22: `command -v` and `-V` report aliases (while they are
/// expanded), functions and reserved words.
#[tokio::test]
async fn command_v_reports_aliases_functions_and_reserved_words() {
	assert_eq!(
		with_aliases("q='echo aliased'", "command -v q; command -V q").await,
		"alias q='echo aliased'\nq is aliased to `echo aliased'\n"
	);
	assert_eq!(
		run("f() { echo hi; }; command -v f; command -V f").await,
		"f\nf is a function\nf () \n{ \n    echo hi\n}\n"
	);
	assert_eq!(
		run("command -v if; command -V if; command -v '[['").await,
		"if\nif is a shell keyword\n[[\n"
	);
	assert_eq!(run("alias q='echo x'; command -v q; echo \"st=$?\"").await, "st=1\n");
}

/// G01: a reserved word comes before a function of the same name, as in Bash.
#[tokio::test]
async fn command_v_reports_a_reserved_word_before_a_function() {
	assert_eq!(
		run("function if { echo hi; }; command -V if; command -v if").await,
		"if is a shell keyword\nif\n"
	);
}

// --- a newline inside an alias's value ---

/// G02, G03, G04, G05, G06: a newline in a value ends a complete command,
/// which runs before the rest of the value is read, so the rest is read with
/// the aliases and the option that command left.
#[tokio::test]
async fn newline_in_a_value_runs_the_command_before_it() {
	assert_eq!(with_aliases("q=$'alias r=\"echo NEW\"\\nr'", "q").await, "NEW\n");
	assert_eq!(
		run("shopt -s expand_aliases\nalias r='echo OLD'\nalias q=$'alias r=\"echo NEW\"\\nr'\nq")
			.await,
		"NEW\n"
	);
	assert_eq!(
		run(
			"shopt -s expand_aliases\nalias r='echo R'\nalias q=$'shopt -u expand_aliases\\nr'\nq \
			 2>/dev/null; echo \"st=$?\""
		)
		.await,
		"st=127\n"
	);
	assert_eq!(
		run("shopt -s expand_aliases\nalias q=$'alias r=\"echo NEW\"\\nif true; then'\nq r; fi")
			.await,
		"NEW\n"
	);
	assert_eq!(
		with_aliases("q=$'echo one\\nq'", "q 2>/dev/null; echo \"st=$?\"").await,
		"one\nst=127\n"
	);
}

/// G07: a newline in a value does not move the line an error reports.
#[tokio::test]
async fn newline_in_a_value_keeps_error_lines() {
	let out = run("shopt -s expand_aliases\nalias q=$'echo one\\necho two'\nq\n)\necho BAD").await;
	assert!(out.starts_with("one\ntwo\n"), "{out}");
	assert!(out.contains("line 4"), "{out}");
	assert!(!out.contains("BAD"), "{out}");
}

// --- reading long input ---

/// G08: a command continued over many lines (`&&`, `||`, `|` at a line's end)
/// is read in time that grows with its length, not with its square.
#[tokio::test]
async fn long_continued_command_reads_in_linear_time() {
	let mut script = ": &&\n".repeat(6000);
	script.push_str("echo and\n");
	script.push_str(&"false ||\n".repeat(6000));
	script.push_str("echo or\n");
	script.push_str(&"echo piped |\n".repeat(3));
	script.push_str("cat\n");
	let started = std::time::Instant::now();
	let out = run(&script).await;
	let elapsed = started.elapsed();
	assert_eq!(out, "and\nor\npiped\n");
	assert!(elapsed < std::time::Duration::from_secs(20), "took {elapsed:?}");
}

// --- process substitutions read again with aliases ---

/// G09, G10, G11, G12, G13: a here-document inside a compound command or a
/// function in a process substitution still ends at its delimiter when the
/// substitution is read again with aliases.
#[tokio::test]
async fn process_substitution_here_documents_survive_reading_again() {
	let unused = "shopt -s expand_aliases\nalias unused=:\n";
	assert_eq!(
		run(&format!("{unused}cat <(if true; then cat <<EOF\nbody\nEOF\nfi)")).await,
		"body\n"
	);
	assert_eq!(
		run(&format!("{unused}cat <(f() {{\ncat <<EOF\nfbody\nEOF\n}}\nf)")).await,
		"fbody\n"
	);
	assert_eq!(
		run(&format!("{unused}cat <(while true; do cat <<-EOF\n\twbody\n\tEOF\nbreak; done)")).await,
		"wbody\n"
	);
	// `)` on its own line: brush ends a substitution at the `)` of a `case`
	// pattern line that also holds `esac)`, with or without aliases.
	assert_eq!(
		run(&format!("{unused}cat <(case x in x) cat <<EOF\ncbody\nEOF\n;; esac\n)")).await,
		"cbody\n"
	);
	assert_eq!(
		run(
			"shopt -s expand_aliases\nalias say='echo said'\ncat <(if true; then cat <<EOF\nbody \
			 $((1+1))\nEOF\nfi\nsay)"
		)
		.await,
		"body 2\nsaid\n"
	);
}

/// G14: `declare -f` writes a here-document so that reading it back works.
#[tokio::test]
async fn declare_f_here_document_reads_back() {
	assert_eq!(
		run("f() {\nif true; then\ncat <<EOF\nbody\nEOF\nfi\n}\neval \"$(declare -f f)\"\nf").await,
		"body\n"
	);
}

// --- BASH_ALIASES assignment ---

/// G15, G16, G17: a list without subscripts alternates names and values; a
/// last name without a value gets the empty value.
#[tokio::test]
async fn bash_aliases_list_of_names_and_values() {
	assert_eq!(
		run("shopt -s expand_aliases\nBASH_ALIASES=(q 'echo one' r 'echo two')\nq; r; alias").await,
		"one\ntwo\nalias q='echo one'\nalias r='echo two'\n"
	);
	assert_eq!(
		run("alias q='echo old'; BASH_ALIASES+=(r 'echo two' s 'echo three'); alias").await,
		"alias q='echo old'\nalias r='echo two'\nalias s='echo three'\n"
	);
	assert_eq!(
		run("BASH_ALIASES=(q 'echo one' r); alias").await,
		"alias q='echo one'\nalias r=''\n"
	);
}

/// G18, G19, G20, G21, G22: `BASH_ALIASES` rejects the names `alias` rejects
/// and empty names, and still defines the other elements of a list.
#[tokio::test]
async fn bash_aliases_rejects_invalid_names() {
	assert_eq!(
		run(
			"shopt -s expand_aliases\n{ BASH_ALIASES['/bin/echo']='echo BAD'; } 2>/dev/null; echo \
			 \"st=$?\"\n/bin/echo expected; alias"
		)
		.await,
		"st=0\nexpected\n"
	);
	assert!(
		run("{ BASH_ALIASES['a/b']=x; } 2>&1")
			.await
			.contains("`a/b': invalid alias name"),
		"diagnostic"
	);
	assert_eq!(
		run("{ BASH_ALIASES=([a/b]=x [ok]=y [c\\;d]=z); } 2>/dev/null; echo \"st=$?\"; alias").await,
		"st=0\nalias ok='y'\n"
	);
	assert_eq!(
		run("{ BASH_ALIASES=(a/b x ok y); } 2>/dev/null; echo \"st=$?\"; alias").await,
		"st=0\nalias ok='y'\n"
	);
	// Bash drops the rest of a line after an assignment error, so the status
	// is read on the next line.
	assert_eq!(
		without_error_reports(
			&run("exec 2>/dev/null\nBASH_ALIASES[\"\"]=x\necho \"st=$?\"; alias").await
		),
		"st=1\n"
	);
	assert_eq!(
		run("{ BASH_ALIASES=([\"\"]=x [ok]=y); } 2>/dev/null; echo \"st=$?\"; alias").await,
		"st=0\nalias ok='y'\n"
	);
}

/// G23: a readonly `BASH_ALIASES` cannot be assigned; `alias` still works.
#[tokio::test]
async fn readonly_bash_aliases_is_not_assigned() {
	assert_eq!(
		without_error_reports(
			&run(
				"exec 2>/dev/null\nreadonly BASH_ALIASES\nBASH_ALIASES[q]='echo BAD'\necho \
				 \"st=$?\"\nBASH_ALIASES=([q]=x)\necho \"st=$?\"\nBASH_ALIASES=x\necho \
				 \"st=$?\"\nalias; alias q=x; alias"
			)
			.await
		),
		"st=1\nst=1\nst=1\nalias q='x'\n"
	);
}

/// G24, G25: `declare` assigns to `BASH_ALIASES` as an assignment does;
/// `local` makes a new variable.
#[tokio::test]
async fn declare_assigns_bash_aliases() {
	assert_eq!(
		run(
			"shopt -s expand_aliases\ndeclare -A BASH_ALIASES=([q]='echo one')\ndeclare \
			 BASH_ALIASES=([r]='echo two')\ndeclare -A BASH_ALIASES=(s 'echo three')\nq; r; s; alias"
		)
		.await,
		"one\ntwo\nthree\nalias q='echo one'\nalias r='echo two'\nalias s='echo three'\n"
	);
	assert_eq!(
		run("f() { local BASH_ALIASES=([q]=x); alias; }; f; alias; echo \"st=$?\"").await,
		"st=0\n"
	);
}

/// G26: `alias -p` lists the aliases, then handles its operands.
#[tokio::test]
async fn alias_p_lists_then_defines() {
	assert_eq!(
		run("alias a=1; alias -p x=new; echo \"st=$?\"; alias").await,
		"alias a='1'\nst=0\nalias a='1'\nalias x='new'\n"
	);
}
