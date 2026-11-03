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

// --- the stored copy after each kind of write and lookup (oracle-hook2.sh) ---

/// L1, L2, L3, L6, K1, K2, K8, U1: a list assignment leaves the stored copy
/// holding the list; a list append, `declare`, `export`, an assignment before
/// a command and `unset` of an element look the variable up first, which
/// refreshes the stored copy from the alias table.
#[tokio::test]
async fn stored_copy_after_writes_and_lookups() {
	let cases = [
		("alias 0=old; BASH_ALIASES=([q]=new); BASH_ALIASES+=Z; alias 0", "alias 0='Z'\n"),
		(
			"alias 0=old; { BASH_ALIASES=([a/b]=x); } 2>/dev/null; BASH_ALIASES+=Z; alias 0",
			"alias 0='Z'\n",
		),
		("alias 0=old; BASH_ALIASES+=([q]=new); BASH_ALIASES+=Z; alias 0", "alias 0='oldZ'\n"),
		("alias 0=old; declare BASH_ALIASES=([q]=new); BASH_ALIASES+=Z; alias 0", "alias 0='oldZ'\n"),
		("alias 0=old; export BASH_ALIASES; BASH_ALIASES+=Z; alias 0", "alias 0='oldZ'\n"),
		("alias 0=old; BASH_ALIASES=x true; BASH_ALIASES+=Z; alias 0", "alias 0='oldZ'\n"),
		("alias 0=old; unset 'BASH_ALIASES[zz]'; BASH_ALIASES+=Z; alias 0", "alias 0='oldZ'\n"),
		(
			"alias 0=old q=keep; unset 'BASH_ALIASES[q]'; BASH_ALIASES+=Z; alias",
			"alias 0='oldZ'\nalias q='keep'\n",
		),
	];
	for (command, expected) in cases {
		assert_eq!(run(command).await, expected, "{command}");
	}
}

/// I1, I2, I3: a local copy made with `local -I` or `localvar_inherit` keeps
/// the assignment function, so what is assigned to it defines aliases.
#[tokio::test]
async fn inherited_local_copy_defines_aliases() {
	let cases = [
		(
			"alias q=old\nf() { local -I BASH_ALIASES; BASH_ALIASES[q]=new; alias q; }\nf\nalias q",
			"alias q='new'\nalias q='new'\n",
		),
		(
			"alias 0=old\nf() { local -I BASH_ALIASES; BASH_ALIASES=x; alias 0; }\nf\nalias 0",
			"alias 0='x'\nalias 0='x'\n",
		),
		(
			"shopt -s localvar_inherit\nalias q=old\nf() { local BASH_ALIASES; BASH_ALIASES[q]=new; \
			 alias q; }\nf\nalias q",
			"alias q='new'\nalias q='new'\n",
		),
	];
	for (command, expected) in cases {
		assert_eq!(run(command).await, expected, "{command}");
	}
}

/// C1 to C9, C11, C12: one value assigned to the name keeps its text unless it
/// is appended or `declare` assigns it; elements and lists take the variable's
/// attributes. (C10, `-i` with an element `1+1`, stores `0` for every
/// associative array at main; Bash evaluates it.)
#[tokio::test]
async fn attributes_apply_where_bash_applies_them() {
	let cases = [
		("declare -u BASH_ALIASES; printf -v BASH_ALIASES mixed; alias 0", "alias 0='mixed'\n"),
		("declare -u BASH_ALIASES; BASH_ALIASES=mixed; alias 0", "alias 0='mixed'\n"),
		("declare -u BASH_ALIASES; BASH_ALIASES+=mixed; alias 0", "alias 0='MIXED'\n"),
		("declare -u BASH_ALIASES=mixed; alias 0", "alias 0='MIXED'\n"),
		(
			"declare -u BASH_ALIASES; for BASH_ALIASES in mixed; do :; done; alias 0",
			"alias 0='mixed'\n",
		),
		("declare -u BASH_ALIASES; read BASH_ALIASES <<< mixed; alias 0", "alias 0='mixed'\n"),
		("declare -u BASH_ALIASES; BASH_ALIASES[k]=mixed; alias k", "alias k='MIXED'\n"),
		("declare -u BASH_ALIASES; printf -v 'BASH_ALIASES[k]' mixed; alias k", "alias k='MIXED'\n"),
		("declare -i BASH_ALIASES; BASH_ALIASES=1+1; alias 0", "alias 0='1+1'\n"),
		("declare -u BASH_ALIASES; BASH_ALIASES=([k]=mixed); alias k", "alias k='MIXED'\n"),
		("declare -u BASH_ALIASES; : \"${BASH_ALIASES:=mixed}\"; alias 0", "alias 0='mixed'\n"),
	];
	for (command, expected) in cases {
		assert_eq!(run(command).await, expected, "{command}");
	}
}

/// R1, R2: a `read -t 0 -a` poll reads nothing, so it does not refuse an
/// associative array.
#[tokio::test]
async fn read_poll_accepts_an_associative_array() {
	for array in ["a", "BASH_ALIASES"] {
		let command = format!(
			"declare -A a\nprintf 'ready\\n' > input\n{{ read -t 0 -a {array}; echo poll:$?; read -r \
			 v; echo value:$v; }} < input"
		);
		assert_eq!(run(&command).await, "poll:0\nvalue:ready\n", "{array}");
	}
}

/// D1, D2, D3, D4, D5, D8: a rejected name from a list assignment, or from an
/// assignment-only command, is reported before the command's own
/// redirections; one from a builtin's element operand, from `printf -v`, or
/// inside a redirected group, on the redirected standard error.
#[tokio::test]
async fn rejected_names_are_reported_where_bash_reports_them() {
	let tail = "; echo marker; echo file:; cat err";
	let cases = [
		("declare BASH_ALIASES=([a/b]=x) 2>err", true),
		("declare BASH_ALIASES[a/b]=x 2>err", false),
		("BASH_ALIASES=([a/b]=x) 2>err", true),
		("BASH_ALIASES['a/b']=x 2>err", true),
		("printf -v 'BASH_ALIASES[a/b]' x 2>err", false),
		("{ declare BASH_ALIASES=([a/b]=x); } 2>err", false),
	];
	for (command, before_redirection) in cases {
		let out = run(&format!("{command}{tail}")).await;
		let message = out
			.find("`a/b': invalid alias name")
			.unwrap_or_else(|| panic!("{command}: {out}"));
		let marker = out
			.find("marker")
			.unwrap_or_else(|| panic!("{command}: {out}"));
		let file = out
			.find("file:")
			.unwrap_or_else(|| panic!("{command}: {out}"));
		if before_redirection {
			assert!(message < marker, "{command}: {out}");
		} else {
			assert!(message > file, "{command}: {out}");
		}
	}
}

/// D6, D11: `declare` reports a rejected name right after its operand, before
/// what later operands report.
#[tokio::test]
async fn declare_reports_each_operand_in_order() {
	let out = run("readonly z; declare BASH_ALIASES=([a/b]=x) z=y 2>&1; echo done").await;
	let message = out
		.find("`a/b': invalid alias name")
		.unwrap_or_else(|| panic!("{out}"));
	let readonly = out.find("readonly").unwrap_or_else(|| panic!("{out}"));
	let done = out.find("done").unwrap_or_else(|| panic!("{out}"));
	assert!(message < readonly && readonly < done, "{out}");
	let out = run("declare BASH_ALIASES=([a/b]=x) BASH_ALIASES[e/f]=y 2>&1; echo done").await;
	let first = out.find("`a/b'").unwrap_or_else(|| panic!("{out}"));
	let second = out.find("`e/f'").unwrap_or_else(|| panic!("{out}"));
	assert!(first < second, "{out}");
}

/// A utility the host runs with a changed environment (`env Z=1 alias`) keeps
/// the shell's aliases.
#[tokio::test]
async fn utility_environment_keeps_the_aliases() {
	assert_eq!(
		run("alias q=x; env Z=1 alias; echo status:$?; alias").await,
		"alias q='x'\nstatus:0\nalias q='x'\n"
	);
}

// --- declaration builtins and polls (oracle-hook3.sh) ---

/// M1, M2, M3, E1, E2: `local` and `export` look the variable up before they
/// assign and again after, as `declare` does, so the stored copy holds the
/// aliases then.
#[tokio::test]
async fn local_and_export_refresh_the_stored_copy() {
	let cases = [
		"alias 0=old\nf() { local -I BASH_ALIASES=(); alias 0=other; BASH_ALIASES+=Z; alias 0; }\nf",
		"alias 0=old\nf() { local BASH_ALIASES; }\nf\nBASH_ALIASES+=Z; alias 0",
		"alias 0=old\nf() { local -I BASH_ALIASES; BASH_ALIASES+=Z; alias 0; }\nf",
		"alias 0=old; export BASH_ALIASES=([q]=new); alias 0=other; BASH_ALIASES+=Z; alias 0",
		"alias 0=old; export BASH_ALIASES=(); alias 0=other; BASH_ALIASES+=Z; alias 0",
	];
	for command in cases {
		assert_eq!(run(command).await, "alias 0='oldZ'\n", "{command}");
	}
}

/// E3, E4: `export` reports a rejected name from a list operand before its
/// redirections and before later operands' messages.
#[tokio::test]
async fn export_reports_like_declare() {
	let out = run("export BASH_ALIASES=([a/b]=x) 2>err; echo marker; echo file:; cat err").await;
	let message = out
		.find("`a/b': invalid alias name")
		.unwrap_or_else(|| panic!("{out}"));
	let marker = out.find("marker").unwrap_or_else(|| panic!("{out}"));
	assert!(message < marker, "{out}");
	let out = run("readonly z; export BASH_ALIASES=([a/b]=x) z=y 2>&1; echo done").await;
	let message = out
		.find("`a/b': invalid alias name")
		.unwrap_or_else(|| panic!("{out}"));
	let readonly = out.find("readonly").unwrap_or_else(|| panic!("{out}"));
	assert!(message < readonly, "{out}");
}

/// A1 to A5: `readonly` and `export` keep one value assigned to the name as it
/// is; `local -I` and `typeset` apply the variable's attributes, as `declare`
/// does.
#[tokio::test]
async fn declaration_builtins_apply_attributes_as_bash() {
	let cases = [
		("declare -u BASH_ALIASES; readonly BASH_ALIASES=mixed; alias 0", "alias 0='mixed'\n"),
		("declare -i BASH_ALIASES; readonly BASH_ALIASES=mixed; alias 0", "alias 0='mixed'\n"),
		("declare -u BASH_ALIASES; export BASH_ALIASES=mixed; alias 0", "alias 0='mixed'\n"),
		(
			"declare -u BASH_ALIASES\nf() { local -I BASH_ALIASES=mixed; alias 0; }\nf",
			"alias 0='MIXED'\n",
		),
		("declare -u BASH_ALIASES; typeset BASH_ALIASES=mixed; alias 0", "alias 0='MIXED'\n"),
		("declare -u BASH_ALIASES; export BASH_ALIASES=([k]=mixed); alias k", "alias k='MIXED'\n"),
	];
	for (command, expected) in cases {
		assert_eq!(run(command).await, expected, "{command}");
	}
}

/// R1 to R5: a `read -t 0` poll assigns nothing, ready or not, to
/// `BASH_ALIASES` or to any other variable.
#[tokio::test]
async fn read_poll_assigns_nothing() {
	let cases = [
		(
			"alias 0=old; printf ready > input; read -t 0 BASH_ALIASES < input; echo \"st=$?\"; \
			 alias 0",
			"st=0\nalias 0='old'\n",
		),
		(
			"BASH_ALIASES=old; alias 0=other; printf ready > input; read -t 0 -a BASH_ALIASES < \
			 input; BASH_ALIASES+=Z; alias 0",
			"alias 0='oldZ'\n",
		),
		(
			"v=keep; printf ready > input; read -t 0 v < input; echo \"st=$? v=[$v]\"",
			"st=0 v=[keep]\n",
		),
		(
			"declare -A a=([k]=keep); printf ready > input; read -t 0 -a a < input; echo \"st=$?\"; \
			 declare -p a",
			"st=0\ndeclare -A a=([k]=\"keep\" )\n",
		),
		(
			"alias 0=old; sleep 1 | { read -t 0 BASH_ALIASES; echo \"st=$?\"; alias 0; }",
			"st=1\nalias 0='old'\n",
		),
	];
	for (command, expected) in cases {
		assert_eq!(run(command).await, expected, "{command}");
	}
}
