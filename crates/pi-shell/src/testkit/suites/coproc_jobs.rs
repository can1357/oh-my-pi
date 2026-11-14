//! Coprocesses, `wait -n` and `jobs` (goldens from bash 5.3.20).

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
fn a_named_coproc_talks_through_its_fds_and_is_unset_when_reaped() {
	let (out, err, _) = run(
		"coproc FOO { read x; echo \"got $x\"; }; echo ${FOO[@]}; echo hi >&${FOO[1]}; read -u \
		 ${FOO[0]} y; echo \"$y\"; wait $FOO_PID; echo \"st=$? [${FOO-unset}] [${FOO_PID-unset}]\"",
	);
	assert_eq!(out, "63 60\ngot hi\nst=0 [unset] [unset]\n");
	assert_eq!(err, "");
}

#[test]
fn the_default_coproc_is_named_coproc() {
	let (out, _, status) = run(
		"coproc { echo out; }; read -u ${COPROC[0]} l; echo \"$l ${COPROC[@]}\"; wait $COPROC_PID",
	);
	assert_eq!(out, "out 63 60\n");
	assert_eq!(status, 0);
}

#[test]
fn wait_n_takes_the_next_finished_job_and_its_pid() {
	let (out, ..) =
		run("{ exit 3; } & { exit 5; } & wait -n; echo $?; wait -n; echo $?; wait -n; echo $?");
	assert_eq!(out, "3\n5\n127\n");
	let (out, ..) = run(
		"{ exit 4; } & p=$!; wait -n -p who $p; echo \"$? $([ \"$who\" = \"$p\" ] && echo same)\"",
	);
	assert_eq!(out, "4 same\n");
}

#[test]
fn fg_bg_need_job_control_and_disown_drops_jobs() {
	let (out, err, _) = run("fg; echo $?; bg; echo $?; %1; echo $?; disown; echo $?");
	assert_eq!(out, "1\n1\n1\n1\n");
	assert_eq!(
		err,
		"bash: line 1: fg: no job control\nbash: line 1: bg: no job control\nbash: line 1: fg: no \
		 job control\nbash: line 1: disown: current: no such job\n"
	);
	let (out, err, _) =
		run("{ :; } & disown -h %1; disown %1; jobs; echo \"[$?]\"; disown %1; echo $?");
	assert_eq!(out, "[0]\n1\n");
	assert_eq!(err, "bash: line 1: disown: %1: no such job\n");
}

#[test]
fn jobs_lists_running_jobs_and_rejects_unknown_specs() {
	let (out, err, _) = run("{ exit 3; } & { :; } & jobs; jobs %3; echo $?");
	assert_eq!(
		out,
		"[1]-  Running                    { exit 3; } &\n[2]+  Running                    { :; } \
		 &\n1\n"
	);
	assert_eq!(err, "bash: line 1: jobs: %3: no such job\n");
}
