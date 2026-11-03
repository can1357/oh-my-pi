//! Assigning to `BASH_ALIASES` defines aliases, as Bash 5.2.21 does: the
//! variable keeps a stored copy of its value, which a lookup refreshes and an
//! append reads, and each element assigned to it defines the alias its key
//! names, through every way of assigning a variable.
//!
//! Each test names the Bash 5.2.21 rows it reproduces (`oracle-hook.sh`); the
//! expected output is what `bash -c` printed for the same text.
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

/// `out` without the lines the host adds to report a command that failed with
/// an error; it reports them whatever standard error is redirected to.
fn without_error_reports(out: &str) -> String {
	out.lines()
		.filter(|line| !line.starts_with("error: "))
		.map(|line| format!("{line}\n"))
		.collect()
}

// --- the forms of assignment ---

/// H01, H02, H03, H04: an element, a keyed list, a list of names and values
/// and a single value each define aliases; a list keeps the other aliases.
#[tokio::test]
async fn assignments_define_aliases() {
	assert_eq!(
		run("shopt -s expand_aliases\nBASH_ALIASES[q]='echo via-array'\nq; alias").await,
		"via-array\nalias q='echo via-array'\n"
	);
	assert_eq!(
		run("alias a=1; BASH_ALIASES=([b]=2 [c]=3); alias").await,
		"alias a='1'\nalias b='2'\nalias c='3'\n"
	);
	assert_eq!(
		run("BASH_ALIASES=(q 'echo one' r); alias").await,
		"alias q='echo one'\nalias r=''\n"
	);
	assert_eq!(run("BASH_ALIASES=x; alias").await, "alias 0='x'\n");
}

/// H53, H54: an alias assigned through `BASH_ALIASES` is read on the lines
/// after, as one the `alias` builtin defines: not on its own line.
#[tokio::test]
async fn alias_applies_from_the_next_line() {
	assert_eq!(run("shopt -s expand_aliases\nBASH_ALIASES[q]='echo hooked'\nq").await, "hooked\n");
	assert_eq!(
		without_error_reports(
			&run(
				"shopt -s expand_aliases\nBASH_ALIASES[q]='echo same-line'; q 2>/dev/null\necho \
				 \"st=$?\""
			)
			.await
		),
		"st=127\n"
	);
}

// --- appending, and the stored copy it reads ---

/// H05, H09: `[q]+=` appends to the alias's value; a list with `+=` replaces
/// the values it gives.
#[tokio::test]
async fn element_append_appends_and_list_append_replaces() {
	assert_eq!(run("alias q=old; BASH_ALIASES[q]+=new; alias q").await, "alias q='oldnew'\n");
	assert_eq!(run("alias q=old; BASH_ALIASES+=([q]=new); alias q").await, "alias q='new'\n");
}

/// H06, H07, H08, H39, H40, H41, H42, H58: `BASH_ALIASES+=v` appends to the
/// variable's stored copy, which an assignment or a lookup of the variable
/// refreshes and the `alias` builtin does not.
#[tokio::test]
async fn scalar_append_reads_the_stored_copy() {
	assert_eq!(run("alias 0=old; BASH_ALIASES+=new; alias 0").await, "alias 0='new'\n");
	assert_eq!(run("BASH_ALIASES=old; BASH_ALIASES+=new; alias 0").await, "alias 0='oldnew'\n");
	assert_eq!(
		run("alias 0=old; : \"${BASH_ALIASES[0]}\"; BASH_ALIASES+=new; alias 0").await,
		"alias 0='oldnew'\n"
	);
	assert_eq!(
		run("BASH_ALIASES=old; alias 0=other; BASH_ALIASES+=new; alias 0").await,
		"alias 0='oldnew'\n"
	);
	assert_eq!(
		run("BASH_ALIASES[0]=old; alias 0=other; BASH_ALIASES+=new; alias 0").await,
		"alias 0='oldnew'\n"
	);
	assert_eq!(
		run("BASH_ALIASES=([0]=old); alias 0=other; BASH_ALIASES+=new; alias 0").await,
		"alias 0='oldnew'\n"
	);
	assert_eq!(
		run("declare BASH_ALIASES=old; alias 0=other; BASH_ALIASES+=new; alias 0").await,
		"alias 0='oldnew'\n"
	);
	assert_eq!(
		run("alias 0=start; for BASH_ALIASES in a b; do :; done; BASH_ALIASES+=X; alias 0").await,
		"alias 0='bX'\n"
	);
}

/// H51: an integer `BASH_ALIASES` adds on `+=`.
#[tokio::test]
async fn integer_append_adds() {
	assert_eq!(
		run("declare -i BASH_ALIASES; BASH_ALIASES[q]=7; BASH_ALIASES[q]+=3; alias q").await,
		"alias q='10'\n"
	);
}

// --- names Bash rejects ---

/// H12, H13, H48, H49: a name `alias` rejects defines no alias and is reported
/// on the assignment's standard error, without failing it; the other elements
/// of a list are still defined.
#[tokio::test]
async fn invalid_names_are_reported_and_skipped() {
	let out = run("{ BASH_ALIASES['a/b']=x; } 2>&1; echo \"st=$?\"; alias").await;
	assert!(out.contains("`a/b': invalid alias name\n"), "{out}");
	assert!(out.ends_with("st=0\n"), "{out}");
	let out = run("{ BASH_ALIASES=([a/b]=x [ok]=y); } 2>&1; echo \"st=$?\"; alias").await;
	assert!(out.contains("`a/b': invalid alias name\n"), "{out}");
	assert!(out.ends_with("st=0\nalias ok='y'\n"), "{out}");
	assert_eq!(run("{ BASH_ALIASES['a/b']=x; } 2>/dev/null; echo \"st=$?\"").await, "st=0\n");
	let out = run("{ printf -v 'BASH_ALIASES[a/b]' x; } 2>&1; echo \"st=$?\"; alias").await;
	assert!(out.contains("`a/b': invalid alias name\n"), "{out}");
	assert!(out.ends_with("st=0\n"), "{out}");
}

// --- variable attributes ---

/// H15, H21: a readonly `BASH_ALIASES` is not assigned; `declare -r` with a
/// value defines the aliases first.
#[tokio::test]
async fn readonly_is_not_assigned() {
	assert_eq!(
		without_error_reports(
			&run(
				"exec 2>/dev/null\nreadonly BASH_ALIASES\nBASH_ALIASES[q]=x\necho \"st=$?\"\nalias q \
				 2>/dev/null; echo \"st=$?\""
			)
			.await
		),
		"st=1\nst=1\n"
	);
	assert_eq!(
		without_error_reports(
			&run(
				"exec 2>/dev/null\ndeclare -r BASH_ALIASES=([q]=x); alias; BASH_ALIASES[r]=y\necho \
				 \"st=$?\"; alias"
			)
			.await
		),
		"alias q='x'\nst=1\nalias q='x'\n"
	);
}

/// H16, H17: `-u` and `-l` change the values assigned through the variable.
#[tokio::test]
async fn case_attributes_apply() {
	assert_eq!(
		run("declare -u BASH_ALIASES; BASH_ALIASES[q]=mixed; alias q").await,
		"alias q='MIXED'\n"
	);
	assert_eq!(run("declare -l BASH_ALIASES=([q]=MiXed); alias q").await, "alias q='mixed'\n");
}

// --- the ways of assigning a variable ---

/// H18: `declare`, with and without `-A`, and with an element.
#[tokio::test]
async fn declare_assigns() {
	assert_eq!(
		run(
			"declare -A BASH_ALIASES=([q]=one); declare BASH_ALIASES=([r]=two); declare \
			 BASH_ALIASES[s]=three; alias"
		)
		.await,
		"alias q='one'\nalias r='two'\nalias s='three'\n"
	);
}

/// H27, H57, H29, H30, H55: `printf -v`, `${...:=}`, a `for` loop and an
/// assignment in a function.
#[tokio::test]
async fn other_assignments_define_aliases() {
	assert_eq!(
		run("printf -v 'BASH_ALIASES[q]' '%s' 'from printf'; alias q").await,
		"alias q='from printf'\n"
	);
	assert_eq!(
		run("alias q=old; printf -v 'BASH_ALIASES[q]' '%s' new; alias q").await,
		"alias q='new'\n"
	);
	assert_eq!(run(": \"${BASH_ALIASES[q]:=defaulted}\"; alias q").await, "alias q='defaulted'\n");
	assert_eq!(run("for BASH_ALIASES in a b; do :; done; alias").await, "alias 0='b'\n");
	assert_eq!(run("f() { BASH_ALIASES[q]=fn; }; f; alias q").await, "alias q='fn'\n");
}

/// H34, H44, H45, H46: `mapfile` and `read -a` refuse `BASH_ALIASES`, which is
/// associative; `declare -a` cannot convert it and `declare -A` keeps it.
#[tokio::test]
async fn associative_checks_hold() {
	let out = run("{ mapfile -t BASH_ALIASES <<< x; } 2>&1; echo \"st=$?\"; alias").await;
	assert!(out.contains("BASH_ALIASES: not an indexed array\n"), "{out}");
	assert!(out.ends_with("st=1\n"), "{out}");
	let out = run("{ read -a BASH_ALIASES <<< 'x y'; } 2>&1; echo \"st=$?\"; alias").await;
	assert!(out.contains("BASH_ALIASES: not an indexed array\n"), "{out}");
	assert!(out.ends_with("st=1\n"), "{out}");
	assert_eq!(
		without_error_reports(
			&run(
				"declare -a BASH_ALIASES 2>/dev/null; echo \"st=$?\"; alias q=1; echo \
				 \"[${BASH_ALIASES[q]}]\""
			)
			.await
		),
		"st=1\n[1]\n"
	);
	assert_eq!(
		run("declare -A BASH_ALIASES; alias q=1; echo \"[${BASH_ALIASES[q]}]\"").await,
		"[1]\n"
	);
}

// --- what defines no alias ---

/// H22, H23, H31, H47: a local `BASH_ALIASES`, an assignment before a command,
/// an assignment after the variable is unset, and an assignment in a subshell
/// define no alias in the shell.
#[tokio::test]
async fn other_variables_define_no_alias() {
	assert_eq!(
		run(
			"f() { local BASH_ALIASES=([q]=x); alias; BASH_ALIASES[r]=y; alias; }; f; echo after:; \
			 alias"
		)
		.await,
		"after:\n"
	);
	assert_eq!(
		run("alias 0=old; BASH_ALIASES=new true; BASH_ALIASES=([q]=x) true; alias").await,
		"alias 0='old'\n"
	);
	assert_eq!(
		run("unset BASH_ALIASES; BASH_ALIASES[q]=x; alias; echo \"[${BASH_ALIASES[q]}]\"").await,
		"[x]\n"
	);
	assert_eq!(
		without_error_reports(
			&run("( BASH_ALIASES[q]=sub; alias q ); alias q 2>/dev/null; echo \"st=$?\"").await
		),
		"alias q='sub'\nst=1\n"
	);
}

/// H32, H43: unsetting an element leaves the alias, and reading the variable
/// shows it again.
#[tokio::test]
async fn unsetting_an_element_keeps_the_alias() {
	assert_eq!(
		run("alias q=x r=y; unset 'BASH_ALIASES[q]'; alias").await,
		"alias q='x'\nalias r='y'\n"
	);
	assert_eq!(
		run("alias q=x; unset 'BASH_ALIASES[q]'; alias q; echo \"[${BASH_ALIASES[q]}]\"").await,
		"alias q='x'\n[x]\n"
	);
}

/// H10, H11, H33: an assignment after `unalias` defines only what it gives;
/// the variable reads the alias table.
#[tokio::test]
async fn reads_follow_the_alias_table() {
	assert_eq!(
		run("alias q=x; : \"${BASH_ALIASES[q]}\"; unalias q; BASH_ALIASES[r]=y; alias").await,
		"alias r='y'\n"
	);
	assert_eq!(
		run("alias q=x; : \"${BASH_ALIASES[q]}\"; unalias q; BASH_ALIASES=([r]=y); alias").await,
		"alias r='y'\n"
	);
	assert_eq!(
		run(
			"alias b=2 a=1; echo \"${#BASH_ALIASES[@]}\"; echo \"${!BASH_ALIASES[@]}\" | tr ' ' \
			 '\\n' | sort | tr '\\n' ' '; echo"
		)
		.await,
		"2\na b \n"
	);
}
