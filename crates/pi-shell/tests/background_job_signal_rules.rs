//! Exec dispositions, untrappable signals, and canonical kill specifications.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

const SETUP: &str = r##"exec 2>/dev/null
d=$(mktemp -d)
cat > "$d/recipient.py" <<'PY'
import pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
if mode == 'wait':
    child = subprocess.Popen([sys.executable, __file__, str(root), 'seven'])
    print('external-wait=' + str(child.wait()), flush=True)
    sys.exit(0)
def record(text):
    with (root / 'events').open('a') as f:
        f.write(text + '\n')
if mode == 'ignore':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if mode == 'catch':
    signal.signal(signal.SIGTERM, lambda s, f: record('TERM'))
(root / 'ready').touch()
time.sleep(0.4)
record('end')
if mode == 'seven':
    sys.exit(7)
PY
"##;

async fn run_script(shell: &Shell, body: &str) -> (Option<i32>, String) {
	let script = format!("{SETUP}\n{body}\nrm -rf \"$d\"\n");
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: script, ..Default::default() },
			Some(tx),
			CancelToken::new(Some(40_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

async fn assert_rows(rows: &[(&str, &str, &str)]) {
	let mut mismatches = Vec::new();
	for &(name, body, expected) in rows {
		let (status, output) = run_script(&Shell::new(None), body).await;
		if (status, output.as_str()) != (Some(0), expected) {
			mismatches.push(format!("{name}: bash Some(0) {expected:?}, omp {status:?} {output:?}"));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_does_not_run_the_replaced_shells_exit_handler() {
	assert_rows(&[
		("F2-signal", r##": > "$d/keep"; f(){ trap 'rm -f "$d/keep"; echo OLD-EXIT' EXIT; trap 'echo OLD-TERM' TERM; exec /usr/bin/python3 "$d/recipient.py" "$d" keep; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM %1; wait %1; echo wait=$?; if [ -f "$d/keep" ]; then echo data=present; else echo data=absent; fi"##, "wait=143\ndata=present\n"),
		("F2-normal", r##": > "$d/keep"; f(){ trap 'rm -f "$d/keep"; echo OLD-EXIT' EXIT; exec /usr/bin/python3 "$d/recipient.py" "$d" keep; }; f & wait %1; echo wait=$?; if [ -f "$d/keep" ]; then echo data=present; else echo data=absent; fi"##, "wait=0\ndata=present\n"),
		("F2-immediate", r##": > "$d/keep"; f(){ trap 'rm -f "$d/keep"; echo OLD-EXIT' EXIT; exec /bin/true; }; f & wait %1; echo wait=$?; if [ -f "$d/keep" ]; then echo data=present; else echo data=absent; fi"##, "wait=0\ndata=present\n"),
		("F2-failed", r##"shopt -s execfail; trap 'echo kept-exit' EXIT; trap 'echo kept-term' TERM; exec "$d/missing"; echo exec=$?; kill -TERM $$; echo after"##, "exec=127\nkept-term\nafter\nkept-exit\n"),
	]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_exec_in_a_function_owns_its_disposition_and_status() {
	assert_rows(&[
		("F3-ignore", r##"f(){ exec /usr/bin/python3 "$d/recipient.py" "$d" ignore; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM %1; wait %1; echo wait=$?; cat "$d/events""##, "wait=0\nend\n"),
		("F3-catch", r##"f(){ exec /usr/bin/python3 "$d/recipient.py" "$d" catch; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM %1; wait %1; echo wait=$?; cat "$d/events""##, "wait=0\nTERM\nend\n"),
		("F3-old-trap", r##"f(){ trap 'echo OLD-TERM' TERM; exec /usr/bin/python3 "$d/recipient.py" "$d" catch; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM %1; wait %1; echo wait=$?; cat "$d/events""##, "wait=0\nTERM\nend\n"),
	]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn untrappable_job_signals_do_not_reach_foreground_children() {
	assert_rows(&[
		("F4-KILL", r##"f(){ /usr/bin/python3 "$d/recipient.py" "$d" keep; echo parent-end; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -KILL %1; wait %1; echo wait=$?; /bin/sleep .6; cat "$d/events""##, "wait=137\nend\n"),
		("F4-STOP", r##"f(){ /usr/bin/python3 "$d/recipient.py" "$d" keep; echo parent-end; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -STOP %1; /bin/sleep .6; if [ -f "$d/events" ]; then cat "$d/events"; else echo child-stopped; fi; kill -CONT %1; wait %1; echo wait=$?"##, "end\nparent-end\nwait=0\n"),
		("F4-external-wait", r##"f(){ /usr/bin/python3 "$d/recipient.py" "$d" wait; echo parent-end; }; f & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -KILL %1; wait %1; echo wait=$?; /bin/sleep .6"##, "wait=137\nexternal-wait=7\n"),
	]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn negative_virtual_group_ids_reach_job_control_jobs() {
	assert_rows(&[
		("F5-TERM", r##"set -m; f(){ trap 'echo trapped' TERM; /usr/bin/python3 "$d/recipient.py" "$d" keep; echo after; }; f & p=$!; until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM -- "-$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\ntrapped\nafter\nwait=0\n"),
		("F5-KILL", r##"set -m; f(){ /usr/bin/python3 "$d/recipient.py" "$d" keep; echo after; }; f & p=$!; until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -KILL -- "-$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=137\n"),
	]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn every_kill_spelling_uses_bash_signal_names() {
	assert_rows(&[
		(
			"F6-n-EXIT",
			r##"/bin/sleep .08 & p=$!; kill -n EXIT "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=0\n",
		),
		(
			"F6-n-TERM",
			r##"/bin/sleep .08 & p=$!; kill -n TERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=143\n",
		),
		(
			"F6-n-SIGTERM",
			r##"/bin/sleep .08 & p=$!; kill -n SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=143\n",
		),
		(
			"F6-n-lower",
			r##"/bin/sleep .08 & p=$!; kill -n term "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=143\n",
		),
		(
			"F6-s-plus-zero",
			r##"/bin/sleep .08 & p=$!; kill -s +0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=0\n",
		),
		(
			"F6-dash-plus-zero",
			r##"/bin/sleep .08 & p=$!; kill -+0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=0\n",
		),
		(
			"F6-s-IOT",
			r##"/bin/sleep .08 & p=$!; kill -s IOT "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=1\nwait=0\n",
		),
		(
			"F6-n-CLD",
			r##"/bin/sleep .08 & p=$!; kill -n CLD "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=1\nwait=0\n",
		),
		(
			"F6-dash-POLL",
			r##"/bin/sleep .08 & p=$!; kill -POLL "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=1\nwait=0\n",
		),
		("F6-list-EXIT", r##"kill -l EXIT; echo status=$?"##, "0\nstatus=0\n"),
		("F6-list-zero", r##"kill -l 0; echo status=$?"##, "EXIT\nstatus=0\n"),
		("F6-list-SIGEXIT", r##"kill -l SIGEXIT; echo status=$?"##, "status=1\n"),
		("F6-list-IOT", r##"kill -l IOT; echo status=$?"##, "status=1\n"),
		("F6-list-CLD", r##"kill -l CLD; echo status=$?"##, "status=1\n"),
		("F6-list-POLL", r##"kill -l POLL; echo status=$?"##, "status=1\n"),
		("F6-list-plus-zero", r##"kill -l +0; echo status=$?"##, "EXIT\nstatus=0\n"),
	])
	.await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn kill_decodes_realtime_names_in_all_forms() {
	assert_rows(&[
		(
			"F6-n-RTMIN",
			r##"/bin/sleep .08 & p=$!; kill -n rtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=162\n",
		),
		(
			"F6-s-RTMIN",
			r##"/bin/sleep .08 & p=$!; kill -s SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=163\n",
		),
		(
			"F6-dash-RTMAX",
			r##"/bin/sleep .08 & p=$!; kill -rtmax "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
			"kill=0\nwait=192\n",
		),
		("F6-list-RTMIN", r##"kill -l sigrtmin+01; echo status=$?"##, "35\nstatus=0\n"),
		("F6-list-RTMAX", r##"kill -l RTMAX-1; echo status=$?"##, "63\nstatus=0\n"),
		("F6-list-noncanonical-RTMAX", r##"kill -l RTMAX-30; echo status=$?"##, "status=1\n"),
	])
	.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lone_dash_fails_before_signalling_any_operand() {
	assert_rows(&[(
		"F7-dash",
		r##"/bin/sleep .08 & p=$!; kill - "$p"; echo kill=$?; wait "$p"; echo wait=$?"##,
		"kill=1\nwait=0\n",
	)])
	.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn job_signals_reach_a_live_pipeline_or_controlled_job() {
	assert_rows(&[
		("F10-live-leader", r##"/bin/sleep .6 | { exec /usr/bin/python3 "$d/recipient.py" "$d" keep; } & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM %1; wait %1; echo wait=$?"##, "wait=143\n"),
		("F10-job-control", r##"set -m; : | { exec /usr/bin/python3 "$d/recipient.py" "$d" keep; } & until [ -f "$d/ready" ]; do /bin/sleep .01; done; kill -TERM %1; wait %1; echo wait=$?"##, "wait=143\n"),
	]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn surviving_external_handles_are_released_after_a_long_run() {
	let row = (
		"F4-release-cycles",
		r##"completed=0; for i in {1..16}; do mkdir "$d/$i"; f(){ /usr/bin/python3 "$d/recipient.py" "$d/$i" keep; echo unexpected; }; f & until [ -f "$d/$i/ready" ]; do /bin/sleep .01; done; kill -KILL %1; wait %1; /bin/sleep .6; if [ -f "$d/$i/events" ]; then completed=$((completed+1)); fi; done; echo completed=$completed"##,
		"completed=16\n",
	);
	let shell = Shell::new(None);
	assert_eq!(run_script(&shell, row.1).await, (Some(0), row.2.to_owned()), "{}", row.0);
	assert_eq!(
		shell.live_background_job_count().await,
		0,
		"exited foreground survivors must release their native handles"
	);
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn all_signal_spellings_honor_posix_prefix_permissions() {
	assert_rows(&[
		("F6-normal-s-SIGRTMIN+1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-s-sigrtmin+01", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s sigrtmin+01 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-s-RTMIN+1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s RTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-s-SIGRTMAX-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-s-sigrtmax-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s sigrtmax-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-s-RTMAX-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s RTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-s-SIGRTMAX-30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-s-RTMAX-30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s RTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-s-35", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s 35 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-s-SIG0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIG0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-s-sig0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s sig0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-s-SIGTERM", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=143\n"),
		("F6-normal-s-sigterm", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s sigterm "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=143\n"),
		("F6-normal-s-SIGRTMIN", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-s-sigrtmin", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s sigrtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-s-RTMIN", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s RTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-s-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F6-normal-n-SIGRTMIN+1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-n-sigrtmin+01", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n sigrtmin+01 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-n-RTMIN+1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n RTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-n-SIGRTMAX-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-n-sigrtmax-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n sigrtmax-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-n-RTMAX-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n RTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-n-SIGRTMAX-30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-n-RTMAX-30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n RTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-n-35", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n 35 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-n-SIG0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIG0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-n-sig0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n sig0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-n-SIGTERM", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=143\n"),
		("F6-normal-n-sigterm", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n sigterm "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=143\n"),
		("F6-normal-n-SIGRTMIN", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-n-sigrtmin", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n sigrtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-n-RTMIN", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n RTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-n-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F6-normal-dash-SIGRTMIN+1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-dash-sigrtmin+01", r##"set +o posix; /bin/sleep .08 & p=$!; kill -sigrtmin+01 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-RTMIN+1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -RTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-dash-SIGRTMAX-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-dash-sigrtmax-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -sigrtmax-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-RTMAX-1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -RTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-normal-dash-SIGRTMAX-30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-RTMAX-30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -RTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-35", r##"set +o posix; /bin/sleep .08 & p=$!; kill -35 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-normal-dash-SIG0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIG0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-sig0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -sig0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-SIGTERM", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=143\n"),
		("F6-normal-dash-sigterm", r##"set +o posix; /bin/sleep .08 & p=$!; kill -sigterm "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-SIGRTMIN", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-dash-sigrtmin", r##"set +o posix; /bin/sleep .08 & p=$!; kill -sigrtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-RTMIN", r##"set +o posix; /bin/sleep .08 & p=$!; kill -RTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-dash-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F6-normal-list-SIGRTMIN+1", r##"set +o posix; kill -l SIGRTMIN+1; echo status=$?"##, "35\nstatus=0\n"),
		("F6-normal-list-sigrtmin+01", r##"set +o posix; kill -l sigrtmin+01; echo status=$?"##, "35\nstatus=0\n"),
		("F6-normal-list-RTMIN+1", r##"set +o posix; kill -l RTMIN+1; echo status=$?"##, "35\nstatus=0\n"),
		("F6-normal-list-SIGRTMAX-1", r##"set +o posix; kill -l SIGRTMAX-1; echo status=$?"##, "63\nstatus=0\n"),
		("F6-normal-list-sigrtmax-1", r##"set +o posix; kill -l sigrtmax-1; echo status=$?"##, "63\nstatus=0\n"),
		("F6-normal-list-RTMAX-1", r##"set +o posix; kill -l RTMAX-1; echo status=$?"##, "63\nstatus=0\n"),
		("F6-normal-list-SIGRTMAX-30", r##"set +o posix; kill -l SIGRTMAX-30; echo status=$?"##, "status=1\n"),
		("F6-normal-list-RTMAX-30", r##"set +o posix; kill -l RTMAX-30; echo status=$?"##, "status=1\n"),
		("F6-normal-list-35", r##"set +o posix; kill -l 35; echo status=$?"##, "RTMIN+1\nstatus=0\n"),
		("F6-normal-list-SIG0", r##"set +o posix; kill -l SIG0; echo status=$?"##, "status=1\n"),
		("F6-normal-list-sig0", r##"set +o posix; kill -l sig0; echo status=$?"##, "status=1\n"),
		("F6-normal-list-SIGTERM", r##"set +o posix; kill -l SIGTERM; echo status=$?"##, "15\nstatus=0\n"),
		("F6-normal-list-sigterm", r##"set +o posix; kill -l sigterm; echo status=$?"##, "15\nstatus=0\n"),
		("F6-normal-list-SIGRTMIN", r##"set +o posix; kill -l SIGRTMIN; echo status=$?"##, "34\nstatus=0\n"),
		("F6-normal-list-sigrtmin", r##"set +o posix; kill -l sigrtmin; echo status=$?"##, "34\nstatus=0\n"),
		("F6-normal-list-RTMIN", r##"set +o posix; kill -l RTMIN; echo status=$?"##, "34\nstatus=0\n"),
		("F6-normal-list-0", r##"set +o posix; kill -l 0; echo status=$?"##, "EXIT\nstatus=0\n"),
		("F6-posix-s-SIGRTMIN+1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-s-sigrtmin+01", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s sigrtmin+01 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-s-RTMIN+1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s RTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-s-SIGRTMAX-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-sigrtmax-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s sigrtmax-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-RTMAX-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s RTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-posix-s-SIGRTMAX-30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-RTMAX-30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s RTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-35", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s 35 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-s-SIG0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIG0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-sig0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s sig0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-SIGTERM", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-sigterm", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s sigterm "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-SIGRTMIN", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-sigrtmin", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s sigrtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-RTMIN", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s RTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-posix-s-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F6-posix-n-SIGRTMIN+1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-n-sigrtmin+01", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n sigrtmin+01 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-n-RTMIN+1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n RTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-n-SIGRTMAX-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-sigrtmax-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n sigrtmax-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-RTMAX-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n RTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-posix-n-SIGRTMAX-30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-RTMAX-30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n RTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-35", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n 35 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-n-SIG0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIG0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-sig0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n sig0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-SIGTERM", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-sigterm", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n sigterm "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-SIGRTMIN", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-sigrtmin", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n sigrtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-RTMIN", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n RTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-posix-n-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F6-posix-dash-SIGRTMIN+1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-dash-sigrtmin+01", r##"set -o posix; /bin/sleep .08 & p=$!; kill -sigrtmin+01 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-RTMIN+1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -RTMIN+1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-dash-SIGRTMAX-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-sigrtmax-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -sigrtmax-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-RTMAX-1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -RTMAX-1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=191\n"),
		("F6-posix-dash-SIGRTMAX-30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-RTMAX-30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -RTMAX-30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-35", r##"set -o posix; /bin/sleep .08 & p=$!; kill -35 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=163\n"),
		("F6-posix-dash-SIG0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIG0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-sig0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -sig0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-SIGTERM", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGTERM "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-sigterm", r##"set -o posix; /bin/sleep .08 & p=$!; kill -sigterm "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-SIGRTMIN", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-sigrtmin", r##"set -o posix; /bin/sleep .08 & p=$!; kill -sigrtmin "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-RTMIN", r##"set -o posix; /bin/sleep .08 & p=$!; kill -RTMIN "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-posix-dash-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F6-posix-list-SIGRTMIN+1", r##"set -o posix; kill -l SIGRTMIN+1; echo status=$?"##, "35\nstatus=0\n"),
		("F6-posix-list-sigrtmin+01", r##"set -o posix; kill -l sigrtmin+01; echo status=$?"##, "35\nstatus=0\n"),
		("F6-posix-list-RTMIN+1", r##"set -o posix; kill -l RTMIN+1; echo status=$?"##, "35\nstatus=0\n"),
		("F6-posix-list-SIGRTMAX-1", r##"set -o posix; kill -l SIGRTMAX-1; echo status=$?"##, "status=1\n"),
		("F6-posix-list-sigrtmax-1", r##"set -o posix; kill -l sigrtmax-1; echo status=$?"##, "status=1\n"),
		("F6-posix-list-RTMAX-1", r##"set -o posix; kill -l RTMAX-1; echo status=$?"##, "63\nstatus=0\n"),
		("F6-posix-list-SIGRTMAX-30", r##"set -o posix; kill -l SIGRTMAX-30; echo status=$?"##, "status=1\n"),
		("F6-posix-list-RTMAX-30", r##"set -o posix; kill -l RTMAX-30; echo status=$?"##, "status=1\n"),
		("F6-posix-list-35", r##"set -o posix; kill -l 35; echo status=$?"##, "RTMIN+1\nstatus=0\n"),
		("F6-posix-list-SIG0", r##"set -o posix; kill -l SIG0; echo status=$?"##, "status=1\n"),
		("F6-posix-list-sig0", r##"set -o posix; kill -l sig0; echo status=$?"##, "status=1\n"),
		("F6-posix-list-SIGTERM", r##"set -o posix; kill -l SIGTERM; echo status=$?"##, "status=1\n"),
		("F6-posix-list-sigterm", r##"set -o posix; kill -l sigterm; echo status=$?"##, "status=1\n"),
		("F6-posix-list-SIGRTMIN", r##"set -o posix; kill -l SIGRTMIN; echo status=$?"##, "status=1\n"),
		("F6-posix-list-sigrtmin", r##"set -o posix; kill -l sigrtmin; echo status=$?"##, "status=1\n"),
		("F6-posix-list-RTMIN", r##"set -o posix; kill -l RTMIN; echo status=$?"##, "34\nstatus=0\n"),
		("F6-posix-list-0", r##"set -o posix; kill -l 0; echo status=$?"##, "EXIT\nstatus=0\n"),
	]).await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn realtime_offsets_use_bash_signed_numbers_and_canonical_names() {
	assert_rows(&[
		("F6-normal-s-SIGRTMIN+-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-s-SIGRTMIN+30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F6-normal-s-SIGRTMIN+31", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+31 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-s-SIGRTMAX-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMAX-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-n-SIGRTMIN+-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-n-SIGRTMIN+30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F6-normal-n-SIGRTMIN+31", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+31 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-n-SIGRTMAX-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMAX-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-SIGRTMIN+-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-normal-dash-SIGRTMIN+30", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F6-normal-dash-SIGRTMIN+31", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+31 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-dash-SIGRTMAX-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -SIGRTMAX-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-normal-list-SIGRTMIN+-0", r##"set +o posix; kill -l SIGRTMIN+-0; echo status=$?"##, "34\nstatus=0\n"),
		("F6-normal-list-SIGRTMIN+30", r##"set +o posix; kill -l SIGRTMIN+30; echo status=$?"##, "64\nstatus=0\n"),
		("F6-normal-list-SIGRTMIN+31", r##"set +o posix; kill -l SIGRTMIN+31; echo status=$?"##, "status=1\n"),
		("F6-normal-list-SIGRTMAX-0", r##"set +o posix; kill -l SIGRTMAX-0; echo status=$?"##, "status=1\n"),
		("F6-posix-s-SIGRTMIN+-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-posix-s-SIGRTMIN+30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F6-posix-s-SIGRTMIN+31", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMIN+31 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-s-SIGRTMAX-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s SIGRTMAX-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-SIGRTMIN+-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-posix-n-SIGRTMIN+30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F6-posix-n-SIGRTMIN+31", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMIN+31 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-n-SIGRTMAX-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n SIGRTMAX-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-SIGRTMIN+-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=162\n"),
		("F6-posix-dash-SIGRTMIN+30", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+30 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F6-posix-dash-SIGRTMIN+31", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMIN+31 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-dash-SIGRTMAX-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -SIGRTMAX-0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F6-posix-list-SIGRTMIN+-0", r##"set -o posix; kill -l SIGRTMIN+-0; echo status=$?"##, "34\nstatus=0\n"),
		("F6-posix-list-SIGRTMIN+30", r##"set -o posix; kill -l SIGRTMIN+30; echo status=$?"##, "64\nstatus=0\n"),
		("F6-posix-list-SIGRTMIN+31", r##"set -o posix; kill -l SIGRTMIN+31; echo status=$?"##, "status=1\n"),
		("F6-posix-list-SIGRTMAX-0", r##"set -o posix; kill -l SIGRTMAX-0; echo status=$?"##, "status=1\n"),
	]).await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn numeric_signal_spellings_use_canonical_signal_numbers() {
	assert_rows(&[
		("F1-r6-normal-s-64", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s 64 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F1-r6-normal-s-65", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s 65 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-normal-s-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F1-r6-normal-s--1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -s -1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-normal-n-64", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n 64 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F1-r6-normal-n-65", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n 65 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-normal-n-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F1-r6-normal-n--1", r##"set +o posix; /bin/sleep .08 & p=$!; kill -n -1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-normal-dash-64", r##"set +o posix; /bin/sleep .08 & p=$!; kill -64 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F1-r6-normal-dash-65", r##"set +o posix; /bin/sleep .08 & p=$!; kill -65 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-normal-dash-0", r##"set +o posix; /bin/sleep .08 & p=$!; kill -0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F1-r6-normal-dash--1", r##"set +o posix; /bin/sleep .08 & p=$!; kill --1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-posix-s-64", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s 64 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F1-r6-posix-s-65", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s 65 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-posix-s-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F1-r6-posix-s--1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -s -1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-posix-n-64", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n 64 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F1-r6-posix-n-65", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n 65 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-posix-n-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n 0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F1-r6-posix-n--1", r##"set -o posix; /bin/sleep .08 & p=$!; kill -n -1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-posix-dash-64", r##"set -o posix; /bin/sleep .08 & p=$!; kill -64 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=192\n"),
		("F1-r6-posix-dash-65", r##"set -o posix; /bin/sleep .08 & p=$!; kill -65 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
		("F1-r6-posix-dash-0", r##"set -o posix; /bin/sleep .08 & p=$!; kill -0 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=0\nwait=0\n"),
		("F1-r6-posix-dash--1", r##"set -o posix; /bin/sleep .08 & p=$!; kill --1 "$p"; echo kill=$?; wait "$p"; echo wait=$?"##, "kill=1\nwait=0\n"),
	]).await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn listing_numeric_signals_uses_the_canonical_table() {
	assert_rows(&[
		(
			"F1-r6-normal-list-64",
			r##"set +o posix; kill -l 64; echo status=$?"##,
			"RTMAX\nstatus=0\n",
		),
		("F1-r6-normal-list-65", r##"set +o posix; kill -l 65; echo status=$?"##, "status=1\n"),
		("F1-r6-normal-list-0", r##"set +o posix; kill -l 0; echo status=$?"##, "EXIT\nstatus=0\n"),
		("F1-r6-normal-list--1", r##"set +o posix; kill -l -- -1; echo status=$?"##, "status=1\n"),
		("F1-r6-posix-list-64", r##"set -o posix; kill -l 64; echo status=$?"##, "RTMAX\nstatus=0\n"),
		("F1-r6-posix-list-65", r##"set -o posix; kill -l 65; echo status=$?"##, "status=1\n"),
		("F1-r6-posix-list-0", r##"set -o posix; kill -l 0; echo status=$?"##, "EXIT\nstatus=0\n"),
		("F1-r6-posix-list--1", r##"set -o posix; kill -l -- -1; echo status=$?"##, "status=1\n"),
	])
	.await;
}
