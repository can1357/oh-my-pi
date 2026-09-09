//! End-to-end execution tests for the omp shell.
use std::process::Command;
#[cfg(unix)]
use std::{fs, process::Stdio, thread, time::Duration};

struct Case {
	script: &'static str,
	stdout: &'static str,
	stderr: &'static str,
	exit:   i32,
}

fn run(script: &str) -> (String, String, i32) {
	let scratch = tempfile::tempdir().expect("create shell test scratch directory");
	let output = Command::new(env!("CARGO_BIN_EXE_omp-sh"))
		.args(["-c", script])
		.env("T", scratch.path())
		.env("TMPDIR", scratch.path())
		.output()
		.expect("execute omp-sh");
	let stdout = String::from_utf8(output.stdout).expect("omp-sh stdout is UTF-8");
	let stderr = String::from_utf8(output.stderr).expect("omp-sh stderr is UTF-8");
	let exit = output.status.code().expect("omp-sh exited normally");
	(stdout, stderr, exit)
}

fn assert_case(case: &Case) {
	let (stdout, stderr, exit) = run(case.script);
	assert_eq!(stdout, case.stdout, "stdout for {:?}", case.script);
	assert_eq!(stderr, case.stderr, "stderr for {:?}", case.script);
	assert_eq!(exit, case.exit, "exit status for {:?}", case.script);
}

#[test]
fn executes_bash_behavior_corpus() {
	let cases = [
		Case { script: "echo hello", stdout: "hello\n", stderr: "", exit: 0 },
		Case { script: "printf '%s-%03d\\n' a 7", stdout: "a-007\n", stderr: "", exit: 0 },
		Case { script: "x=5; echo $((x*2+1))", stdout: "11\n", stderr: "", exit: 0 },
		Case { script: "if [ 1 -lt 2 ]; then echo y; fi", stdout: "y\n", stderr: "", exit: 0 },
		Case {
			script: "for i in 1 2 3; do echo $i; done",
			stdout: "1\n2\n3\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "for ((i=0;i<3;i++)); do printf %d $i; done",
			stdout: "012",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "for ((i=0;i<3;i++))\ndo printf %d $i; done",
			stdout: "012",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "f() { local v=in; echo $v; }; v=out; f; echo $v",
			stdout: "in\nout\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "case abc in a*) echo m;; *) echo n;; esac",
			stdout: "m\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "echo $(echo nested)", stdout: "nested\n", stderr: "", exit: 0 },
		Case {
			script: "a=(x y z); echo \"${a[1]}\" \"${#a[@]}\"",
			stdout: "y 3\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "IFS=,; a=(1 2 3); echo \"${a[*]}\"",
			stdout: "1,2,3\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "set -- p q r; IFS=-; echo \"$*\"", stdout: "p-q-r\n", stderr: "", exit: 0 },
		Case { script: "set -- p q r; IFS=; echo \"$*\"", stdout: "pqr\n", stderr: "", exit: 0 },
		Case {
			script: "s=hello; echo ${s^^} ${s:1:3}",
			stdout: "HELLO ell\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: concat!("echo $", "{", "undef:-fallback", "}"),
			stdout: "fallback\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "x=abc; echo ${x/b/_}", stdout: "a_c\n", stderr: "", exit: 0 },
		Case { script: "echo {1..3}{a,b}", stdout: "1a 1b 2a 2b 3a 3b\n", stderr: "", exit: 0 },
		Case {
			script: "shopt -s nocasematch; [[ FOO == foo ]] && echo y",
			stdout: "y\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "shopt -s nocasematch; [[ FOO =~ \"foo\" ]] && echo y",
			stdout: "y\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "r='('; [[ a =~ $r ]]; echo $?", stdout: "2\n", stderr: "", exit: 0 },
		Case {
			script: "[[ abc =~ ^a(b)c$ ]] && echo ${BASH_REMATCH[1]}",
			stdout: "b\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "echo hi > \"$T/f\"; read x < \"$T/f\"; echo \"got:$x\"",
			stdout: "got:hi\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "while read l; do echo \"L:$l\"; done <<EOF\na\nb\nEOF",
			stdout: "L:a\nL:b\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "echo one; echo two 1>&2", stdout: "one\n", stderr: "two\n", exit: 0 },
		Case {
			script: "false | true; echo $?; set -o pipefail; false | true; echo $?",
			stdout: "0\n1\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "set -e; false; echo unreachable", stdout: "", stderr: "", exit: 1 },
		Case { script: "trap 'echo bye' EXIT; echo hi", stdout: "hi\nbye\n", stderr: "", exit: 0 },
		Case { script: "eval 'echo e\"v\"al'", stdout: "eval\n", stderr: "", exit: 0 },
		Case { script: "(( 3 > 2 )) && echo y", stdout: "y\n", stderr: "", exit: 0 },
		Case {
			script: concat!("(x=5); echo $", "{", "x:-unset", "}"),
			stdout: "unset\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "type -t echo", stdout: "builtin\n", stderr: "", exit: 0 },
		Case { script: "echo $ x; echo \"$\"", stdout: "$ x\n$\n", stderr: "", exit: 0 },
		Case { script: "printf 'b\\na\\n' | sort", stdout: "a\nb\n", stderr: "", exit: 0 },
		Case { script: "printf 'x\\ny\\n' | grep y", stdout: "y\n", stderr: "", exit: 0 },
		Case { script: "echo '{\"k\":[1,2]}' | jq -c .k", stdout: "[1,2]\n", stderr: "", exit: 0 },
		Case { script: "seq 3", stdout: "1\n2\n3\n", stderr: "", exit: 0 },
		Case { script: "printf 'a b\\n' | cut -d' ' -f2", stdout: "b\n", stderr: "", exit: 0 },
		Case { script: "echo abc | tr a-c A-C", stdout: "ABC\n", stderr: "", exit: 0 },
		Case { script: "printf 'l1\\nl2\\n' | head -n1", stdout: "l1\n", stderr: "", exit: 0 },
		Case { script: "printf 'l1\\nl2\\n' | tail -n1", stdout: "l2\n", stderr: "", exit: 0 },
		Case { script: "printf 'a\\na\\nb\\n' | uniq", stdout: "a\nb\n", stderr: "", exit: 0 },
		Case { script: "printf hello | wc -c", stdout: "5\n", stderr: "", exit: 0 },
		Case { script: "echo hi | cat", stdout: "hi\n", stderr: "", exit: 0 },
		Case { script: "mkdir -p \"$T/d/e\" && ls \"$T/d\"", stdout: "e\n", stderr: "", exit: 0 },
		Case {
			script: "echo test | md5sum",
			stdout: "d8e8fca2dc0f896fd7cb4cb0031ba249  -\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "printf x | sponge \"$T/s\" && cat \"$T/s\"",
			stdout: "x",
			stderr: "",
			exit:   0,
		},
		Case { script: "yes | head -n2", stdout: "y\ny\n", stderr: "", exit: 0 },
		Case {
			script: "cd \"$T\" && mkdir -p sub && echo needle > sub/hay.txt && rg -l needle",
			stdout: "sub/hay.txt\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "cd \"$T\" && mkdir -p sub && echo needle > sub/hay.txt && fd hay",
			stdout: "sub/hay.txt\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "cd \"$T\" && mkdir -p sub && echo x > sub/f.txt && find . -name f.txt",
			stdout: "./sub/f.txt\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "basename /a/b.txt && dirname /a/b.txt",
			stdout: "b.txt\n/a\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "touch \"$T/t\" && test -f \"$T/t\" && echo ok",
			stdout: "ok\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "printf 'aaa' | sed s/a/b/", stdout: "baa", stderr: "", exit: 0 },
		Case { script: "test \"$(nproc)\" -ge 1 && echo ok", stdout: "ok\n", stderr: "", exit: 0 },
		Case { script: "date -u -d @0 +%Y", stdout: "1970\n", stderr: "", exit: 0 },
		Case {
			script: "LC_ALL=fr_FR.UTF-8 printf 'b\\na\\nB\\n' | sort",
			stdout: "B\na\nb\n",
			stderr: "",
			exit:   0,
		},
	];

	for case in &cases {
		assert_case(case);
	}
}

#[test]
fn registers_all_utility_and_process_builtins() {
	let mut names: Vec<_> =
		omp_shell_builtins::utility_builtins::<omp_shell::extensions::DefaultShellExtensions>()
			.into_iter()
			.chain(omp_shell_builtins::process_builtins())
			.map(|(name, _)| name)
			.collect();
	names.sort_unstable();

	let expected = [
		"b2sum",
		"base32",
		"base64",
		"basename",
		"cat",
		"cksum",
		"cmp",
		"combine",
		"comm",
		"cut",
		"date",
		"diff",
		"dirname",
		#[cfg(unix)]
		"errno",
		"fd",
		"find",
		"grep",
		"head",
		"hostname",
		"ifne",
		"isutf8",
		"jq",
		"ln",
		"ls",
		"md5sum",
		"mkdir",
		"mktemp",
		"mv",
		"nohup",
		"nproc",
		"paste",
		"pgrep",
		"pidwait",
		"pkill",
		"printenv",
		"ps",
		"readlink",
		"realpath",
		"rg",
		"rm",
		"sed",
		"seq",
		"sha1sum",
		"sha224sum",
		"sha256sum",
		"sha384sum",
		"sha512sum",
		"sleep",
		"sort",
		"sponge",
		"stat",
		"tac",
		"tail",
		"tee",
		"timeout",
		"top",
		"touch",
		"tr",
		"truncate",
		"ts",
		"uname",
		"uniq",
		"wc",
		"which",
		"whoami",
		"xargs",
		"yes",
	];
	assert_eq!(names, expected);

	let script =
		format!("for n in {}; do type -t \"$n\" || echo \"MISSING:$n\"; done", names.join(" "));
	let (stdout, stderr, exit) = run(&script);
	assert!(!stdout.contains("MISSING:"), "{stdout}");
	assert_eq!(stdout, "builtin\n".repeat(names.len()));
	assert_eq!(stderr, "");
	assert_eq!(exit, 0);
}

#[cfg(unix)]
#[test]
fn executes_unix_behavior_corpus() {
	let cases = [
		Case { script: "sleep 0.1 & wait %sle; echo $?", stdout: "0\n", stderr: "", exit: 0 },
		Case { script: "sleep 0.1 & wait %?eep; echo $?", stdout: "0\n", stderr: "", exit: 0 },
		Case {
			script: "sleep 0.1 & disown; jobs; echo done",
			stdout: "done\n",
			stderr: "",
			exit:   0,
		},
		Case {
			script: "sleep 0.1 & sleep 0.1 & disown -a; jobs; echo done",
			stdout: "done\n",
			stderr: "",
			exit:   0,
		},
		Case { script: "echo hello | tr a-z A-Z", stdout: "HELLO\n", stderr: "", exit: 0 },
		Case { script: "diff <(echo a) <(echo a); echo $?", stdout: "0\n", stderr: "", exit: 0 },
		Case { script: "timeout 0.2 sleep 5; echo $?", stdout: "124\n", stderr: "", exit: 0 },
		Case { script: "ps >/dev/null && echo ok", stdout: "ok\n", stderr: "", exit: 0 },
	];

	for case in &cases {
		assert_case(case);
	}
}

#[cfg(unix)]
#[test]
fn disown_modes_allow_external_process_to_outlive_shell() {
	for (disown, marker_name) in [("disown", "disowned"), ("disown -h", "kept")] {
		let scratch = tempfile::tempdir().expect("create disown test scratch directory");
		let marker = scratch.path().join(marker_name);
		let script =
			format!("/bin/sh -c 'sleep 0.15; printf done > \"$T/{marker_name}\"' & {disown}");
		let status = Command::new(env!("CARGO_BIN_EXE_omp-sh"))
			.args(["-c", &script])
			.env("T", scratch.path())
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.status()
			.expect("execute omp-sh");
		assert!(status.success(), "omp-sh exited with {status}");

		thread::sleep(Duration::from_millis(400));
		assert_eq!(fs::read_to_string(marker).expect("disowned process wrote marker"), "done");
	}
}
