//! Behaviour of integer variables, `let`, `unset` and `printf` that the
//! round-26 Bash differential found wrong, pinned against Bash 5.2's output.
#![cfg(unix)]

use std::{
	io::{Read, Seek},
	time::Duration,
};

use brush_core::{
	ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
	openfiles::{OpenFile, OpenFiles},
};
use pi_builtins::{BuiltinSet, default_builtins};

async fn shell() -> Shell {
	Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell")
}

/// What `code` printed to standard output, run in a fresh shell, and
/// whether the run succeeded. A run that does not finish in ten seconds
/// fails the test.
async fn run(code: &str) -> (bool, String) {
	let mut shell = shell().await;
	let mut stdout = tempfile::tempfile().expect("stdout");
	let mut params = shell.default_exec_params();
	params
		.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(stdout.try_clone().expect("stdout descriptor")));
	let sink = std::fs::OpenOptions::new()
		.write(true)
		.open("/dev/null")
		.expect("/dev/null");
	params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(sink));
	let ran = tokio::time::timeout(
		Duration::from_secs(10),
		shell.run_string(code, &SourceInfo::default(), &params),
	)
	.await
	.unwrap_or_else(|_elapsed| panic!("{code}: did not finish"));
	let succeeded = ran.as_ref().is_ok_and(|result| result.is_success());
	stdout.rewind().expect("rewind");
	let mut text = String::new();
	stdout.read_to_string(&mut text).expect("read");
	(succeeded, text)
}

/// Bash makes the variable an assignment names visible before it evaluates
/// the value, so under `set -u` the value may read it while it is unset, as
/// zero. Any other unset name still ends the script, and so does the name
/// itself inside `(( ))` or as an element.
#[tokio::test]
async fn set_u_lets_an_integer_assignment_read_its_own_name() {
	for (code, expected) in [
		("set -u; declare -i x; x=x; echo \"x=$x\"", "x=0\n"),
		("set -u; declare -i x; x=x+1; echo \"x=$x\"", "x=1\n"),
		("set -u; declare -i count; count=count+1; echo \"count=$count\"", "count=1\n"),
		("set -u; declare -i x; x=x++; echo \"x=$x\"", "x=0\n"),
		("set -u; declare -i x; x='x++'; echo \"x=$x\"", "x=0\n"),
		("set -u; declare -i x; read x <<< \"x+1\"; echo \"x=$x\"", "x=1\n"),
		("set -u; declare -i x; declare x=x+2; echo \"x=$x\"", "x=2\n"),
	] {
		assert_eq!(run(code).await, (true, String::from(expected)), "{code}");
	}
	for code in
		["set -u; declare -i x; x=u; echo after", "set -u; declare -i x; (( x = x + 1 )); echo after"]
	{
		let (_, stdout) = run(code).await;
		assert_eq!(stdout, "", "{code}: the script ends before `echo after`");
	}
}

/// `name+=value` on an integer variable evaluates the current value first,
/// then the value appended, as Bash does: the appended value's side effects
/// do not change what it is added to.
#[tokio::test]
async fn an_integer_append_reads_its_base_before_the_value() {
	for (code, expected) in [
		("declare -i x=5; x+=x++; echo \"x=$x\"", "x=10\n"),
		("declare -i x; x+=x++; echo \"x=$x\"", "x=0\n"),
		(
			"declare -i x; declare -i a; x+='x++'; echo \"x=[${x-unset}] a=[${a[0]-unset}]\"",
			"x=[0] a=[unset]\n",
		),
		("declare -i x=5; x+=x; echo \"x=$x\"", "x=10\n"),
		("declare -i x=5; x+=2*3; echo \"x=$x\"", "x=11\n"),
		("declare -ia a=(5); a[0]+=a[0]++; echo \"a=${a[0]}\"", "a=10\n"),
		("declare -ia a=(5 7); a+=1; echo \"a=${a[*]}\"", "a=6 7\n"),
		("x=5; echo \"$(( x += x++ ))\"; echo \"x=$x\"", "10\nx=10\n"),
	] {
		assert_eq!(run(code).await, (true, String::from(expected)), "{code}");
	}
}

/// `let` and an `unset` subscript parse a long expression too, off the
/// worker and without the parser's cache, and get its value right.
#[tokio::test]
async fn let_and_unset_parse_long_expressions() {
	let sum = "1+".repeat(5000);
	let code = format!("let \"x = {sum}1\"; echo \"x=$x\"");
	assert_eq!(run(&code).await, (true, String::from("x=5001\n")));

	let zeros = "0+".repeat(5000);
	let code = format!("a=(p q r); unset \"a[{zeros}1]\"; echo \"${{!a[*]}} ${{a[*]}}\"");
	assert_eq!(run(&code).await, (true, String::from("0 2 p r\n")));

	assert_eq!(
		run("let \"x = 2*3\" \"y = x+1\"; echo \"$x $y\"").await,
		(true, String::from("6 7\n"))
	);
}

/// A format that takes no argument runs once, as in Bash, however many
/// arguments are left; it ran without end.
#[tokio::test]
async fn printf_runs_an_argumentless_format_once() {
	for (code, expected) in [
		("printf '%%\\n' a", "%\n"),
		("printf 'x\\n' a b c", "x\n"),
		("printf '%s-' a b c; echo", "a-b-c-\n"),
		("printf '%s %s|' a b c; echo", "a b|c |\n"),
		("printf -v v '%%' a b; echo \"$v\"", "%\n"),
	] {
		assert_eq!(run(code).await, (true, String::from(expected)), "{code}");
	}
}
