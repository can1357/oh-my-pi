//! Bash argument-array base capture and push/pop lifetimes.
//!
//! Expected outputs were measured independently on Bash 5.3.0 and checked
//! against Bash 5.2.21. The missing-file row deliberately follows 5.3.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs a script in a fresh shell and directory containing the fixture files,
/// collecting the complete output delivered to the caller's fds.
async fn output(files: &[(&str, &str)], script: &str) -> String {
	let dir = tempfile::tempdir().expect("tempdir");
	for (name, body) in files {
		std::fs::write(dir.path().join(name), body).expect("write fixture");
	}
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded::<String>();
	shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(20_000),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution");
	rx.drain().collect()
}

/// Reports every complete-output mismatch rather than stopping at the first
/// row.
async fn assert_rows(rows: &[(&[(&str, &str)], &str, &str)]) {
	let mut mismatches = Vec::new();
	for &(files, script, want) in rows {
		let got = output(files, script).await;
		if got != want {
			mismatches.push(format!("`{script}`: want {want:?}, got {got:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// Top-level reads freeze the base across later set and shift commands.
/// Probe rows: a-top-read-only, a1, a2-read-twice-after-set, a3-no-params,
/// e1-set-after-read, e2-shift-after-read.
#[tokio::test]
async fn a_top_level_read_freezes_the_original_parameters() {
	assert_rows(&[
		// a-top-read-only
		(
			&[],
			"set -- A B\necho \"$1: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}] @=[$*]\"",
			"A: c=[2] v=[B A] @=[A B]\n",
		),
		// a1
		(
			&[],
			"set -- A B\necho \"top: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"top: c=[2] v=[B A]\n",
		),
		// a2-read-twice-after-set
		(
			&[],
			"set -- A B\necho \"1: c=[${BASH_ARGC[*]}]\"\nset -- C D E\necho \"2: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"1: c=[2]\n2: c=[2] v=[B A]\n",
		),
		// a3-no-params
		(&[], "echo \"top: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"", "top: c=[0] v=[]\n"),
		// e1-set-after-read
		(
			&[],
			"set -- A B\necho \"1: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\nset -- X\necho \"2: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"1: c=[2] v=[B A]\n2: c=[2] v=[B A]\n",
		),
		// e2-shift-after-read
		(
			&[],
			"set -- A B\necho \"1: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\nshift\necho \"2: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"1: c=[2] v=[B A]\n2: c=[2] v=[B A]\n",
		),
	])
	.await;
}

/// An opened source captures its initial arguments, even without an array read
/// or after an early return. Probe rows: b1-read-in-source, b2-read-after-only,
/// b3-read-in-and-after, n5-source-noargs-top, n8-eval-source,
/// n9-set-in-file-then-read, p2-source-noargs-captures,
/// p3-source-args-captures-its-own, p5-frozen, p16-return-from-source.
#[tokio::test]
async fn opening_a_source_captures_its_arguments_before_any_script_runs() {
	assert_rows(&[
		// b1-read-in-source
		(
			&[("lib", "echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: c=[2] v=[S2 S1]\nafter: c=[2] v=[S2 S1]\n",
		),
		// b2-read-after-only
		(
			&[("lib", ":\n")],
			"set -- A B\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[S2 S1]\n",
		),
		// b3-read-in-and-after
		(
			&[("lib", "echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\necho \"before: c=[${BASH_ARGC[*]}]\"\n. ./lib S1 S2\necho \"after: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"before: c=[2]\nin: c=[2] v=[B A]\nafter: c=[2] v=[B A]\n",
		),
		// n5-source-noargs-top
		(
			&[("lib", "echo \"in: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\n. ./lib\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: @=[A B] c=[1 2] v=[./lib B A]\nafter: c=[2] v=[B A]\n",
		),
		// n8-eval-source
		(
			&[("lib", "echo \"in: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\neval '. ./lib S1 S2'\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: @=[S1 S2] c=[2] v=[S2 S1]\nafter: c=[2] v=[S2 S1]\n",
		),
		// n9-set-in-file-then-read
		(
			&[(
				"lib",
				"set -- Q1 Q2 Q3\necho \"in: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n",
			)],
			"set -- A B\n. ./lib S1 S2\necho \"after: @=[$*] c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: @=[Q1 Q2 Q3] c=[2] v=[S2 S1]\nafter: @=[Q1 Q2 Q3] c=[2] v=[S2 S1]\n",
		),
		// p2-source-noargs-captures
		(
			&[("lib", ":\n")],
			"set -- A B\n. ./lib\nset -- Z\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[B A]\n",
		),
		// p3-source-args-captures-its-own
		(
			&[("lib", ":\n")],
			"set -- A B\n. ./lib S1 S2\nset -- Z\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[S2 S1]\n",
		),
		// p5-frozen
		(
			&[("lib", ":\n")],
			"set -- A B\n. ./lib S1\nset -- Z1 Z2 Z3\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[1] v=[S1]\n",
		),
		// p16-return-from-source
		(
			&[("lib", "return 0\n")],
			"set -- A B\n. ./lib S1 S2\nset -- Z\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[S2 S1]\n",
		),
	])
	.await;
}

/// Nested sources use the first captured base, not the innermost parameters.
/// Probe rows: b4-nested, b5-nested-no-inner-read, n1-inner-params-and-base,
/// n2-inner-reads-params-first, n3-three-levels, n4-inner-noargs,
/// n10-read-before-source-then-nested.
#[tokio::test]
async fn nested_sources_keep_the_outermost_files_base_after_the_files_end() {
	assert_rows(&[
		// b4-nested
		(
			&[
				(
					"outer",
					". ./inner I1 I2 I3\necho \"outer: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n",
				),
				("inner", "echo \"inner: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
			],
			"set -- A B\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"inner: c=[2] v=[O2 O1]\nouter: c=[2] v=[O2 O1]\nafter: c=[2] v=[O2 O1]\n",
		),
		// b5-nested-no-inner-read
		(
			&[
				(
					"outer",
					". ./inner I1 I2 I3\necho \"outer: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n",
				),
				("inner", ":\n"),
			],
			"set -- A B\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"outer: c=[2] v=[O2 O1]\nafter: c=[2] v=[O2 O1]\n",
		),
		// n1-inner-params-and-base
		(
			&[
				(
					"outer",
					"echo \"outer-pre: @=[$*]\"\n. ./inner I1 I2 I3\necho \"outer: @=[$*] \
					 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n",
				),
				("inner", "echo \"inner: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
			],
			"set -- A B\n. ./outer O1 O2\necho \"after: @=[$*] c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"outer-pre: @=[O1 O2]\ninner: @=[I1 I2 I3] c=[2] v=[O2 O1]\nouter: @=[O1 O2] c=[2] v=[O2 \
			 O1]\nafter: @=[A B] c=[2] v=[O2 O1]\n",
		),
		// n2-inner-reads-params-first
		(
			&[
				("outer", ". ./inner I1 I2 I3\n"),
				(
					"inner",
					"echo \"inner: @=[$*]\"\necho \"inner-base: c=[${BASH_ARGC[*]}] \
					 v=[${BASH_ARGV[*]}]\"\n",
				),
			],
			"set -- A B\n. ./outer O1 O2\necho \"after: @=[$*] c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"inner: @=[I1 I2 I3]\ninner-base: c=[2] v=[O2 O1]\nafter: @=[A B] c=[2] v=[O2 O1]\n",
		),
		// n3-three-levels
		(
			&[
				("l1", ". ./l2 Y1 Y2\n"),
				("l2", ". ./l3 Z1 Z2 Z3\n"),
				("l3", "echo \"l3: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
			],
			"set -- A B\n. ./l1 X1 X2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"l3: @=[Z1 Z2 Z3] c=[2] v=[X2 X1]\nafter: c=[2] v=[X2 X1]\n",
		),
		// n4-inner-noargs
		(
			&[
				("outer", ". ./inner\n"),
				("inner", "echo \"inner: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
			],
			"set -- A B\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"inner: @=[O1 O2] c=[1 2] v=[./inner O2 O1]\nafter: c=[2] v=[O2 O1]\n",
		),
		// n10-read-before-source-then-nested
		(
			&[
				("outer", ". ./inner I1 I2 I3\n"),
				("inner", "echo \"inner: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
			],
			"set -- A B\n: \"${BASH_ARGC[*]}\"\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"inner: c=[2] v=[B A]\nafter: c=[2] v=[B A]\n",
		),
	])
	.await;
}

/// Without extdebug, function entry and reads inside a function leave the base
/// uncaptured. Probe rows: c1-read-in-function, c2-read-after-function,
/// n6-function-then-read-in-source, n7-read-in-source-in-function-then-top,
/// p1-function-call-no-capture, p4-source-in-function-no-capture,
/// p14-read-in-function-then-top.
#[tokio::test]
async fn functions_and_sources_inside_functions_do_not_capture_on_entry_or_read() {
	assert_rows(&[
		// c1-read-in-function
		(
			&[],
			"set -- A B\nf(){ echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"; }\nf F1 F2\necho \
			 \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: c=[] v=[]\nafter: c=[2] v=[B A]\n",
		),
		// c2-read-after-function
		(
			&[],
			"set -- A B\nf(){ :; }\nf F1 F2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[B A]\n",
		),
		// n6-function-then-read-in-source
		(
			&[("lib", "echo \"in: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\nf(){ . ./lib S1 S2; }\nf F1 F2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: @=[S1 S2] c=[] v=[]\nafter: c=[2] v=[B A]\n",
		),
		// n7-read-in-source-in-function-then-top
		(
			&[("lib", "echo \"in: @=[$*] c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\nf(){ . ./lib S1 S2; echo \"f: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"; \
			 }\nf F1 F2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: @=[S1 S2] c=[] v=[]\nf: c=[] v=[]\nafter: c=[2] v=[B A]\n",
		),
		// p1-function-call-no-capture
		(
			&[],
			"set -- A B\nf(){ :; }\nf F1 F2\nset -- Z\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[1] v=[Z]\n",
		),
		// p4-source-in-function-no-capture
		(
			&[("lib", ":\n")],
			"set -- A B\nf(){ . ./lib S1 S2; }\nf F1\nset -- Z\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[1] v=[Z]\n",
		),
		// p14-read-in-function-then-top
		(
			&[],
			"set -- A B\nf(){ echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"; }\nf F1\nset -- \
			 Z\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: c=[] v=[]\nafter: c=[1] v=[Z]\n",
		),
	])
	.await;
}

/// Enabling extdebug captures the current parameters, including inside a
/// function; later calls push above them. Probe rows: d1-extdebug-source,
/// d3-extdebug-function, p6-shopt-captures, p9-extdebug-source-push-and-pop,
/// q2-function-enables-extdebug, q5-function-pop-after-late-enable.
#[tokio::test]
async fn extdebug_captures_even_inside_a_function_and_pushes_new_calls_above_it() {
	assert_rows(&[
		// d1-extdebug-source
		(
			&[("lib", "echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\nshopt -s extdebug\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: c=[2 2] v=[S2 S1 B A]\nafter: c=[2] v=[B A]\n",
		),
		// d3-extdebug-function
		(
			&[],
			"set -- A B\nshopt -s extdebug\nf(){ echo \"in: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"; }\nf F1 F2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: c=[2 2] v=[F2 F1 B A]\nafter: c=[2] v=[B A]\n",
		),
		// p6-shopt-captures
		(
			&[],
			"set -- A B\nshopt -s extdebug\nset -- Z\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[B A]\n",
		),
		// p9-extdebug-source-push-and-pop
		(
			&[("lib", "echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\nshopt -s extdebug\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: c=[2 2] v=[S2 S1 B A]\nafter: c=[2] v=[B A]\n",
		),
		// q2-function-enables-extdebug
		(
			&[],
			"set -- A B\nf(){ shopt -s extdebug; echo \"in: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"; }\nf F1 F2 F3\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"in: c=[3] v=[F3 F2 F1]\nafter: c=[3] v=[F3 F2 F1]\n",
		),
		// q5-function-pop-after-late-enable
		(
			&[],
			"set -- A B\nf(){ shopt -s extdebug; }\nf F1 F2 F3\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[3] v=[F3 F2 F1]\n",
		),
	])
	.await;
}

/// A source enabling extdebug can consume the base or an enclosing filename,
/// one entry at a time. Probe rows: d2-extdebug-in-file-only,
/// p7-extdebug-in-file-pops, p8-extdebug-in-nested-file-pops-one,
/// q4-nested-pop-keeps-outer-filename.
#[tokio::test]
async fn a_source_enabling_extdebug_pops_exactly_one_existing_push() {
	assert_rows(&[
		// d2-extdebug-in-file-only
		(
			&[("lib", "shopt -s extdebug; echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n")],
			"set -- A B\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: c=[2] v=[S2 S1]\nafter: c=[] v=[]\n",
		),
		// p7-extdebug-in-file-pops
		(
			&[("lib", "shopt -s extdebug\n")],
			"set -- A B\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[] v=[]\n",
		),
		// p8-extdebug-in-nested-file-pops-one
		(
			&[
				("outer", ". ./inner I1\necho \"outer: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
				("inner", "shopt -s extdebug\n"),
			],
			"set -- A B\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"outer: c=[] v=[]\nafter: c=[] v=[]\n",
		),
		// q4-nested-pop-keeps-outer-filename
		(
			&[
				("outer", ". ./inner I1\necho \"outer: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
				("inner", "shopt -s extdebug\n"),
			],
			"set -- A B\n. ./outer\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"outer: c=[2] v=[B A]\nafter: c=[] v=[]\n",
		),
	])
	.await;
}

/// A subshell, command substitution or function sees the source base already
/// captured by its caller. Probe rows: g1-subshell-in-source, g2-subshell-top,
/// g3-function-in-source, p10-subshell-in-source, p15-cmdsub-in-source.
#[tokio::test]
async fn children_and_functions_of_a_source_inherit_its_captured_base() {
	assert_rows(&[
		// g1-subshell-in-source
		(
			&[("lib", "( echo \"sub: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\" )\n")],
			"set -- A B\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"sub: c=[2] v=[S2 S1]\nafter: c=[2] v=[S2 S1]\n",
		),
		// g2-subshell-top
		(
			&[],
			"set -- A B\n( echo \"sub: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\" )\necho \"after: \
			 c=[${BASH_ARGC[*]}]\"",
			"sub: c=[2] v=[B A]\nafter: c=[2]\n",
		),
		// g3-function-in-source
		(
			&[("lib", "report OWN\n")],
			"set -- A B\nreport(){ echo \"fn: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}] \
			 f=[${FUNCNAME[*]}]\"; }\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"fn: c=[2] v=[S2 S1] f=[report source]\nafter: c=[2] v=[S2 S1]\n",
		),
		// p10-subshell-in-source
		(
			&[("lib", "( report OWN )\n")],
			"set -- A B\nreport(){ echo \"fn: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}] \
			 f=[${FUNCNAME[*]}]\"; }\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"fn: c=[2] v=[S2 S1] f=[report source]\nafter: c=[2] v=[S2 S1]\n",
		),
		// p15-cmdsub-in-source
		(
			&[("lib", "x=$(echo \"sub: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"); echo \"$x\"\n")],
			"set -- A B\n. ./lib S1 S2\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"sub: c=[2] v=[S2 S1]\nafter: c=[2] v=[S2 S1]\n",
		),
	])
	.await;
}

/// Named declare -p resolves both arrays, captures only outside functions, and
/// returns status zero. Probe rows: f1-declare-p, f2-declare-p-after-read,
/// f3-declare-p-in-function, p11-declare-p-top, p12-declare-p-in-source,
/// p13-declare-p-in-function.
#[tokio::test]
async fn named_declarations_read_the_arrays_in_the_callers_context() {
	assert_rows(&[
		// f1-declare-p
		(
			&[],
			"set -- A B\ndeclare -p BASH_ARGC BASH_ARGV; echo \"rc=$?\"",
			"declare -a BASH_ARGC=([0]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"B\" [1]=\"A\")\nrc=0\n",
		),
		// f2-declare-p-after-read
		(
			&[],
			"set -- A B\n: \"${BASH_ARGC[*]}\"\ndeclare -p BASH_ARGC BASH_ARGV; echo \"rc=$?\"",
			"declare -a BASH_ARGC=([0]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"B\" [1]=\"A\")\nrc=0\n",
		),
		// f3-declare-p-in-function
		(
			&[],
			"set -- A B\nshopt -s extdebug\nf(){ declare -p BASH_ARGC BASH_ARGV; echo \"rc=$?\"; \
			 }\nf F1",
			"declare -a BASH_ARGC=([0]=\"1\" [1]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"F1\" [1]=\"B\" \
			 [2]=\"A\")\nrc=0\n",
		),
		// p11-declare-p-top
		(
			&[],
			"set -- A B\ndeclare -p BASH_ARGC BASH_ARGV; echo \"rc=$?\"",
			"declare -a BASH_ARGC=([0]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"B\" [1]=\"A\")\nrc=0\n",
		),
		// p12-declare-p-in-source
		(
			&[("lib", "declare -p BASH_ARGC BASH_ARGV; echo \"rc=$?\"\n")],
			"set -- A B\n. ./lib S1 S2",
			"declare -a BASH_ARGC=([0]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"S2\" [1]=\"S1\")\nrc=0\n",
		),
		// p13-declare-p-in-function
		(
			&[],
			"set -- A B\nf(){ declare -p BASH_ARGC BASH_ARGV; echo \"rc=$?\"; }\nf F1",
			"declare -a BASH_ARGC=()\ndeclare -a BASH_ARGV=()\nrc=0\n",
		),
		// A named `declare -p` reports the call stack's VALUE with the
		// declared variable's ATTRIBUTES. These two names carry
		// `readonly`, `export` and `integer` like any other, and bash
		// prints them. Measured on Bash 5.2.21 and 5.3.0.
		(
			&[],
			"set -- A B\nreadonly BASH_ARGV\ndeclare -p BASH_ARGV; echo \"rc=$?\"",
			"declare -ar BASH_ARGV=([0]=\"B\" [1]=\"A\")\nrc=0\n",
		),
		(
			&[],
			"set -- A B\nexport BASH_ARGC\ndeclare -p BASH_ARGC; echo \"rc=$?\"",
			"declare -ax BASH_ARGC=([0]=\"2\")\nrc=0\n",
		),
	])
	.await;
}

/// Bash 5.2 captures S1 on the failed source; Bash 5.3 captures nothing.
/// Bash 5.3 wins here. Probe row: p17-missing-file.
#[tokio::test]
async fn a_missing_source_does_not_capture_the_base() {
	assert_rows(&[
		// p17-missing-file
		(
			&[],
			"set -- A B\n. ./nope S1 2>/dev/null; set -- Z\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[1] v=[Z]\n",
		),
	])
	.await;
}

/// Disabling extdebug, a later function call and a subshell cannot recreate a
/// popped base. Probe rows: q1-popped-base-stays-initialized,
/// q3-after-pop-function-push, q6-subshell-after-pop.
#[tokio::test]
async fn a_popped_base_stays_initialized_in_the_shell_and_its_children() {
	assert_rows(&[
		// q1-popped-base-stays-initialized
		(
			&[("lib", "shopt -s extdebug\n")],
			"set -- A B\n. ./lib S1 S2\nshopt -u extdebug\nset -- Z\necho \"after: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[] v=[]\n",
		),
		// q3-after-pop-function-push
		(
			&[("lib", "shopt -s extdebug\n")],
			"set -- A B\n. ./lib S1 S2\nf(){ echo \"in: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"; \
			 }\nf F1\necho \"after: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"in: c=[1] v=[F1]\nafter: c=[] v=[]\n",
		),
		// q6-subshell-after-pop
		(
			&[("lib", "shopt -s extdebug\n")],
			"set -- A B\n. ./lib S1 S2\nshopt -u extdebug\n( set -- CHILD; echo \"sub: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\" )\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"sub: c=[] v=[]\nafter: c=[] v=[]\n",
		),
	])
	.await;
}

/// Source-with-arguments pops test extdebug at exit; registered function pops
/// do not. Probe rows: q7-extdebug-disabled-in-source,
/// q8-extdebug-disabled-nested-source, q9-extdebug-disabled-in-function.
#[tokio::test]
async fn source_arguments_remain_when_extdebug_is_disabled_before_source_exit() {
	assert_rows(&[
		// q7-extdebug-disabled-in-source
		(
			&[("lib", "shopt -u extdebug\n")],
			"set -- A B\nshopt -s extdebug\n. ./lib S1 S2\nset -- Z\necho \"after: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[2 2] v=[S2 S1 B A]\n",
		),
		// q8-extdebug-disabled-nested-source
		(
			&[
				("outer", ". ./inner I1\necho \"outer: c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"\n"),
				("inner", "shopt -u extdebug\n"),
			],
			"set -- A B\nshopt -s extdebug\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"outer: c=[1 2 2] v=[I1 O2 O1 B A]\nafter: c=[1 2 2] v=[I1 O2 O1 B A]\n",
		),
		// q9-extdebug-disabled-in-function
		(
			&[],
			"set -- A B\nshopt -s extdebug\nf(){ shopt -u extdebug; }\nf F1\necho \"after: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"after: c=[2] v=[B A]\n",
		),
	])
	.await;
}

/// Each pop consumes the innermost remaining push even when another level owns
/// it or has already ended. Probe rows: q10-source-pops-function-push,
/// q11-source-pops-detached-inner-push, q12-function-pops-detached-source-push.
#[tokio::test]
async fn registered_pops_consume_the_innermost_remaining_arguments_not_the_owners() {
	assert_rows(&[
		// q10-source-pops-function-push
		(
			&[("lib", "shopt -s extdebug\n")],
			"set -- A B\nshopt -s extdebug\nf(){ shopt -u extdebug; . ./lib S1; echo \"fn: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"; }\nf F1 F2 F3\necho \"after: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}]\"",
			"fn: c=[2] v=[B A]\nafter: c=[] v=[]\n",
		),
		// q11-source-pops-detached-inner-push
		(
			&[("outer", ". ./inner I1\nshopt -s extdebug\n"), ("inner", "shopt -u extdebug\n")],
			"set -- A B\nshopt -s extdebug\n. ./outer O1 O2\necho \"after: c=[${BASH_ARGC[*]}] \
			 v=[${BASH_ARGV[*]}]\"",
			"after: c=[2 2] v=[O2 O1 B A]\n",
		),
		// q12-function-pops-detached-source-push
		(
			&[("lib", "shopt -u extdebug\n")],
			"set -- A B\nshopt -s extdebug\nf(){ . ./lib S1; }\nf F1 F2 F3\necho \"after: \
			 c=[${BASH_ARGC[*]}] v=[${BASH_ARGV[*]}] f=[${FUNCNAME[*]}]\"",
			"after: c=[3 2] v=[F3 F2 F1 B A] f=[]\n",
		),
	])
	.await;
}

/// `${!BASH_ARGC[@]}` and `${!BASH_ARGV[@]}` are reads of the call stack's
/// arrays: they list the keys and they initialize the argument base, as
/// bash's `get_bashargcv` does for a value read. Reading the stored
/// variable instead returned no keys and left the base uncaptured, so a
/// later read froze a different set of positional parameters. Measured on
/// Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn a_key_read_lists_the_indices_and_freezes_the_base() {
	assert_rows(&[
		(
			&[],
			"set -- ROOT1 ROOT2\nprintf 'key=<%s>\\n' \"${!BASH_ARGV[@]}\"\nset -- 			 LATER\nprintf \
			 'C=[%s] V=[%s]\\n' \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"",
			"key=<0>\nkey=<1>\nC=[2] V=[ROOT2 ROOT1]\n",
		),
		(
			&[],
			"set -- ROOT1 ROOT2\nprintf 'key=<%s>\\n' \"${!BASH_ARGC[@]}\"\nset -- 			 LATER\nprintf \
			 'C=[%s] V=[%s]\\n' \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"",
			"key=<0>\nC=[2] V=[ROOT2 ROOT1]\n",
		),
	])
	.await;
}

/// bash's `_evalfile` pops a no-argument `.` file's FILE-NAME push before
/// the file's RETURN trap runs, so the trap reads its caller's levels and
/// a pop made INSIDE the trap takes the next push down — the base — not
/// the ended file's. A `.` file WITH arguments keeps its push until
/// `source_builtin`, after the trap. Measured on Bash 5.2.21 and 5.3.0.
#[tokio::test]
async fn an_ended_file_name_push_is_gone_before_its_return_trap_runs() {
	assert_rows(&[
		// A pop inside the trap consumes the base, as bash's does.
		(
			&[("lib", ":\n"), ("inner", "shopt -s extdebug\n")],
			"set -- ROOT1 ROOT2\ntrap 'trap - RETURN; . ./inner INNER; printf \"trap C=[%s] V=[%s] \
			 K=[%s]\\n\" \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\" \"${!BASH_ARGV[*]}\"' RETURN\n. \
			 ./lib\nprintf 'after C=[%s] V=[%s]\\n' \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"",
			"trap C=[] V=[] K=[]\nafter C=[] V=[]\n",
		),
		// No pop in the trap: the caller's levels, before and after.
		(
			&[("lib", ":\n")],
			"set -- ROOT1 ROOT2\ntrap 'trap - RETURN; printf \"trap C=[%s] V=[%s]\\n\" \
			 \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"' RETURN\n. ./lib\nprintf 'after C=[%s] \
			 V=[%s]\\n' \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"",
			"trap C=[2] V=[ROOT2 ROOT1]\nafter C=[2] V=[ROOT2 ROOT1]\n",
		),
		// A nested no-argument `.` in the trap pops its own name push.
		(
			&[("lib", ":\n"), ("inner", ":\n")],
			"set -- ROOT1 ROOT2\ntrap 'trap - RETURN; . ./inner; printf \"trap C=[%s] V=[%s]\\n\" \
			 \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"' RETURN\n. ./lib\nprintf 'after C=[%s] \
			 V=[%s]\\n' \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"",
			"trap C=[2] V=[ROOT2 ROOT1]\nafter C=[2] V=[ROOT2 ROOT1]\n",
		),
		// An ARGUMENTS push is still there in the trap, and popped after.
		(
			&[("lib", ":\n")],
			"set -- ROOT1 ROOT2\nshopt -s extdebug\ntrap 'trap - RETURN; printf \"trap C=[%s] \
			 V=[%s]\\n\" \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"' RETURN\n. ./lib S1 S2\nprintf \
			 'after C=[%s] V=[%s]\\n' \"${BASH_ARGC[*]}\" \"${BASH_ARGV[*]}\"",
			"trap C=[2 2] V=[S2 S1 ROOT2 ROOT1]\nafter C=[2] V=[ROOT2 ROOT1]\n",
		),
	])
	.await;
}
