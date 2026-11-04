//! zsh's job builtins (ports of zsh 5.9 `jobs.c` `bin_fg`, `getjob`,
//! `bin_kill`'s job specs, `bin_suspend`) and zsh/parameter's
//! `jobstates`, `jobtexts` and `jobdirs`, in a shell without job control
//! (`zsh -c`). Expected output comes from `/bin/zsh -f -c` 5.9; where zsh
//! learns of a stop asynchronously its run had a short `sleep` after the
//! `kill -STOP`, which the engine does not need.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// A job that runs until it is killed, and zsh's text of it.
const LOOP: &str = "while :; do :; done";
const LOOP_TEXT: &str = "while :; do; :; done";

#[test]
fn jobs_lists_a_running_job_in_zsh_format() {
	let (out, err, _) = zsh(&format!("{LOOP} & jobs; kill -9 %1"));
	assert_eq!(out, format!("[1]  + running    {LOOP_TEXT}\n"));
	assert_eq!(err, "");
}

#[test]
fn job_specs_select_current_previous_numbered_and_named_jobs() {
	let (out, err, _) = zsh(&format!(
		"{LOOP} & until false; do :; done & jobs; jobs %1 %- %+ %% %wh %?until; kill -9 %1 %2"
	));
	let one = format!("[1]  - running    {LOOP_TEXT}\n");
	let two = "[2]  + running    until false; do; :; done\n".to_string();
	assert_eq!(
		out,
		[&one, &two, &one, &one, &two, &two, &one, &two]
			.map(String::as_str)
			.concat()
	);
	assert_eq!(err, "");
}

#[test]
fn three_jobs_mark_only_current_and_previous() {
	let (out, ..) = zsh(&format!("{LOOP} & {LOOP} & {LOOP} & jobs; kill -9 %1 %2 %3"));
	assert_eq!(
		out,
		format!(
			"[1]    running    {LOOP_TEXT}\n[2]  - running    {LOOP_TEXT}\n[3]  + running    \
			 {LOOP_TEXT}\n"
		)
	);
}

#[test]
fn bad_job_specs_are_reported_with_status_127() {
	let (out, err, _) = zsh(
		"jobs %3; echo $?; jobs %; echo $?; jobs %-; echo $?; jobs %foo; echo $?; jobs %?foo; echo \
		 $?; jobs foo; echo $?",
	);
	assert_eq!(out, "127\n127\n127\n127\n127\n127\n");
	assert_eq!(
		err,
		"zsh:jobs:1: %3: no such job\nzsh:jobs:1: no current job\nzsh:jobs:1: no previous \
		 job\nzsh:jobs:1: job not found: foo\nzsh:jobs:1: job not found: ?foo\nzsh:jobs:1: job not \
		 found: foo\n"
	);
}

#[test]
fn a_bad_spec_ends_the_job_arguments() {
	let (out, err, _) =
		zsh(&format!("{LOOP} & jobs 1; echo $?; jobs %1 %4 %1; echo $?; kill -9 %1"));
	assert_eq!(out, format!("127\n[1]  + running    {LOOP_TEXT}\n127\n"));
	assert_eq!(err, "zsh:jobs:1: job not found: 1\nzsh:jobs:1: %4: no such job\n");
}

#[test]
fn posixbuiltins_silences_job_spec_errors() {
	let (out, err, _) =
		zsh("setopt posixbuiltins; jobs %3; echo $?; jobs %; echo $?; jobs %foo; echo $?");
	assert_eq!(out, "127\n127\n127\n");
	assert_eq!(err, "");
}

#[test]
fn fg_and_bg_need_job_control() {
	let (out, err, _) = zsh("fg; echo $?; bg %1; echo $?; fg %1; echo $?");
	assert_eq!(out, "1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:fg:1: no job control in this shell.\nzsh:bg:1: no job control in this \
		 shell.\nzsh:fg:1: no job control in this shell.\n"
	);
}

#[test]
fn disown_drops_jobs_from_the_table() {
	let (out, err, _) = zsh("disown; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("1\n", "zsh:disown:1: no current job\n"));
	let (out, err, _) = zsh(&format!("{LOOP} & p=$!; disown; jobs; echo $?; kill -9 $p"));
	assert_eq!((out.as_str(), err.as_str()), ("0\n", ""));
	let (out, err, _) = zsh(&format!("{LOOP} & disown %1 %1; echo $?; kill -9 $!"));
	assert_eq!((out.as_str(), err.as_str()), ("127\n", "zsh:disown:1: %1: no such job\n"));
}

#[test]
fn disown_of_a_stopped_job_warns_unless_autocontinue() {
	let (out, err, _) = zsh(&format!("{LOOP} & kill -STOP %1; disown; echo $?; jobs; kill -9 $!"));
	assert_eq!(out, "0\n");
	assert!(
		err.starts_with("zsh:disown:1: warning: job is suspended, use `kill -CONT -")
			&& err.ends_with("' to resume\n"),
		"{err}"
	);
	let (out, err, _) = zsh(&format!(
		"setopt autocontinue; {LOOP} & kill -STOP %1; disown; echo $?; jobs; kill -9 $!"
	));
	assert_eq!((out.as_str(), err.as_str()), ("0\n", ""));
}

#[test]
fn stopped_jobs_and_the_running_and_stopped_filters() {
	let (out, err, _) = zsh(&format!(
		"{LOOP} & kill -STOP %1; jobs; print -r -- ${{jobstates[1]/:<->=/:PID=}}; jobs -s; jobs -r; \
		 echo x; kill -9 %1"
	));
	let stopped = format!("[1]  + suspended (signal)  {LOOP_TEXT}\n");
	assert_eq!(out, format!("{stopped}suspended:+:PID=suspended (signal)\n{stopped}x\n"));
	assert_eq!(err, "");
	let (out, ..) =
		zsh(&format!("{LOOP} & {LOOP} & kill -STOP %1; jobs; jobs -r; jobs -s; kill -9 %1 %2"));
	let one = format!("[1]  + suspended (signal)  {LOOP_TEXT}\n");
	let two = format!("[2]  - running    {LOOP_TEXT}\n");
	assert_eq!(out, format!("{one}{two}{two}{one}"));
}

#[test]
fn jobs_d_shows_the_job_directory() {
	let (out, ..) = zsh(&format!("cd /; {LOOP} & jobs -d; kill -9 %1"));
	assert_eq!(out, format!("[1]  + running    {LOOP_TEXT}\n(pwd : /)\n"));
}

#[test]
fn jobs_options_and_suspend_arguments() {
	let (out, err, _) = zsh("jobs -Z foo; echo $?; jobs -Z; echo $?; jobs -q; echo $?");
	assert_eq!(out, "0\n1\n1\n");
	assert_eq!(err, "zsh:jobs:1: -Z requires one argument\nzsh:jobs:1: bad option: -q\n");
	let (out, err, _) = zsh("suspend x; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("1\n", "zsh:suspend:1: too many arguments\n"));
}

#[test]
fn job_parameters_are_readonly_hashes() {
	let (out, err, _) =
		zsh("echo ${(t)jobstates} ${(t)jobtexts} ${(t)jobdirs}; jobstates[1]=x; echo $?");
	let t = "association-readonly-hide-hideval-special";
	assert_eq!(out, format!("{t} {t} {t}\n"));
	assert_eq!(err, "zsh:1: read-only variable: jobstates\n");
	let (out, ..) =
		zsh(&format!("cd /; {LOOP} & print -r -- ${{(kv)jobtexts}} ${{(kv)jobdirs}}; kill -9 %1"));
	assert_eq!(out, format!("1 {LOOP_TEXT} 1 /\n"));
}

#[test]
fn job_texts_are_zsh_getjobtext() {
	for (src, text) in [
		(format!("{{ {LOOP}; echo }}"), format!("{{ {LOOP_TEXT}; echo; }}")),
		(format!("( {LOOP} )"), format!("( {LOOP_TEXT}; )")),
		(format!("{LOOP} > /dev/null"), format!("{LOOP_TEXT} > /dev/null")),
	] {
		let (out, ..) = zsh(&format!("{src} & jobs; kill -9 %1"));
		assert_eq!(out, format!("[1]  + running    {text}\n"), "{src}");
	}
	let (out, ..) = zsh(&format!("f() {{ {LOOP} }}; f & jobs; kill -9 %1"));
	assert_eq!(out, "[1]  + running    f\n");
}

#[test]
fn kill_resolves_job_specs_with_getjob() {
	let (out, err, _) =
		zsh("kill %3; echo $?; kill %; echo $?; kill %3 %4; echo $?; kill %foo; echo $?");
	assert_eq!(out, "1\n1\n2\n1\n");
	assert_eq!(
		err,
		"zsh:kill:1: %3: no such job\nzsh:kill:1: no current job\nzsh:kill:1: %3: no such \
		 job\nzsh:kill:1: %4: no such job\nzsh:kill:1: job not found: foo\n"
	);
}

#[test]
fn wait_for_a_missing_job() {
	let (out, err, _) = zsh("wait %2; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("127\n", "zsh:wait:1: %2: no such job\n"));
}
