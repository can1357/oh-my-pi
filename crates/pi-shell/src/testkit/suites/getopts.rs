//! `getopts`: option scanning, `OPTIND`/`OPTARG`, silent mode and bash's
//! messages (goldens from bash 5.3.20).

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

#[test]
fn scans_clustered_flags_and_arguments() {
	let (out, err, _) = run(
		"set -- -ab -c foo bar; while getopts abc: o; do echo \"$o ${OPTARG-u} $OPTIND\"; done; \
		 echo \"end $o $OPTIND\"",
	);
	assert_eq!(out, "a u 1\nb u 2\nc foo 4\nend ? 4\n");
	assert_eq!(err, "");
}

#[test]
fn silent_mode_reports_through_optarg() {
	let (out, err, _) = run(
		"getopts :ab: x -z; echo \"$? $x $OPTARG\"; OPTIND=1; getopts :ab: x -b; echo \"$? $x \
		 $OPTARG $OPTIND\"",
	);
	assert_eq!(out, "0 ? z\n0 : b 2\n");
	assert_eq!(err, "");
}

#[test]
fn errors_print_bash_messages_unless_opterr_is_zero() {
	let (out, err, _) = run(
		"getopts ab: x -z; echo \"$? $x ${OPTARG-u}\"; OPTIND=1; getopts ab: x -b; echo \"$? $x \
		 ${OPTARG-u}\"; OPTERR=0; OPTIND=1; getopts ab: x -z; echo \"$? $x\"",
	);
	assert_eq!(out, "0 ? u\n0 ? u\n0 ?\n");
	assert_eq!(err, "bash: illegal option -- z\nbash: option requires an argument -- b\n");
}

#[test]
fn a_local_optind_restarts_and_the_caller_resumes() {
	let (out, ..) = run(
		"f() { typeset OPTIND=1; typeset opt; while getopts \":abcxyz\" opt; do echo opt: \"$opt\"; \
		 if [[ $opt = y ]]; then f -abc; fi; done; }; f -xyz; g() { local OPTIND; getopts a v -a; \
		 echo \"g $v $OPTIND\"; }; set -- -a -b; getopts ab o; g; getopts ab o; echo \"$o $OPTIND\"",
	);
	assert_eq!(out, "opt: x\nopt: y\nopt: a\nopt: b\nopt: c\nopt: z\ng a 2\nb 3\n");
}

#[test]
fn bad_name_and_usage() {
	let (out, err, _) = run("getopts a 1x -a; echo $?; getopts; echo $?");
	assert_eq!(out, "1\n2\n");
	assert_eq!(
		err,
		"bash: line 1: getopts: `1x': not a valid identifier\ngetopts: usage: getopts optstring \
		 name [arg ...]\n"
	);
}
