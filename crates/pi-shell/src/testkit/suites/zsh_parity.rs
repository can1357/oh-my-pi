//! zsh core parity: the built-in aliases (`createaliastable`), `.`/`source`
//! arguments and `$0`, `ZSH_EVAL_CONTEXT` of a `-c` string, `zexit`'s
//! `zshexit` hooks and `zsh_directory_name` run in the current shell.
//! Expected output comes from `/bin/zsh -f -c` 5.9 with the same files.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -f -c src` with `/tmp/pz/sf.zsh` (prints its
/// arguments and `$0`, then shifts) and `/tmp/pz/ec.zsh` (prints
/// `ZSH_EVAL_CONTEXT`): stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/pz");
	host
		.fs
		.add_file("/tmp/pz/sf.zsh", b"echo $# $* / $0\nshift\n", 0o644);
	host
		.fs
		.add_file("/tmp/pz/ec.zsh", b"echo $ZSH_EVAL_CONTEXT\n", 0o644);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn builtin_aliases_exist_under_f() {
	let (out, err, st) = zsh("alias; alias -L; which-command echo; unalias run-help; alias");
	assert_eq!(
		out,
		"run-help=man\nwhich-command=whence\nalias run-help=man\nalias \
		 which-command=whence\necho\nwhich-command=whence\n"
	);
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn fpath_and_module_path_start_with_the_compiled_in_directories() {
	let (out, err, st) = zsh("typeset -p FPATH MODULE_PATH; echo ${+FPATH}");
	assert_eq!(
		out,
		"typeset -T FPATH fpath=( /usr/local/share/zsh/site-functions /usr/share/zsh/site-functions \
		 /usr/share/zsh/5.9/functions )\ntypeset -T MODULE_PATH module_path=( /usr/lib/zsh/5.9 \
		 )\n1\n"
	);
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn source_arguments_are_the_positional_parameters_while_it_runs() {
	let (out, err, st) = zsh(
		"set -- p1 p2; source /tmp/pz/sf.zsh a b; echo after $# $*; f(){ source /tmp/pz/sf.zsh c; \
		 echo in $# $*; . /tmp/pz/sf.zsh; echo in2 $# $*; }; f x y; setopt nofunctionargzero; . \
		 /tmp/pz/sf.zsh q",
	);
	assert_eq!(
		out,
		"2 a b / /tmp/pz/sf.zsh\nafter 2 p1 p2\n1 c / /tmp/pz/sf.zsh\nin 2 x y\n2 x y / \
		 /tmp/pz/sf.zsh\nin2 1 y\n1 q / zsh\n"
	);
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn eval_context_of_a_command_string_is_cmdarg() {
	let (out, err, st) = zsh(
		r#"echo $ZSH_EVAL_CONTEXT; echo $(echo $ZSH_EVAL_CONTEXT); f(){echo $ZSH_EVAL_CONTEXT}; f; eval "echo \$ZSH_EVAL_CONTEXT"; (echo $ZSH_EVAL_CONTEXT); source /tmp/pz/ec.zsh; echo $zsh_eval_context[1]"#,
	);
	assert_eq!(
		out,
		"cmdarg\ncmdarg:cmdsubst\ncmdarg:shfunc\ncmdarg:eval\ncmdarg\ncmdarg:file\ncmdarg\n"
	);
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn zshexit_hooks_run_after_the_exit_trap_and_on_subshell_exit() {
	let (out, err, st) = zsh(
		r#"zshexit(){echo bye $?}; zshexit_functions=(g); g(){echo g $?}; trap "echo trap" EXIT; (echo sub; exit 3); echo "[$(exit 4)]"; (echo nohook); f(){ exit 5 }; f; echo notreached"#,
	);
	// The `exit` inside `f` is pending when the hooks start: only the
	// first one's body runs (zsh `doshfunc` sets `retflag` again).
	assert_eq!(out, "sub\nbye 3\ng 3\n[bye 4\ng 4]\nnohook\ntrap\nbye 5\n");
	assert_eq!((err.as_str(), st), ("", 5));
	let (out, err, st) =
		zsh("zshexit_functions=(g h); g(){echo g $?}; h(){echo h}; f(){ exit 5 }; f");
	assert_eq!((out.as_str(), err.as_str(), st), ("g 5\n", "", 5));
	let (out, err, st) = zsh("zshexit_functions=(g h); g(){echo g $?}; h(){echo h}; false");
	assert_eq!((out.as_str(), err.as_str(), st), ("g 1\nh\n", "", 1));
}

#[test]
fn exit_in_a_zshexit_hook_ends_only_that_hook() {
	let (out, err, st) =
		zsh("zshexit(){echo bye $?; exit 7; echo no}; zshexit_functions=(g); g(){echo g $?}; true");
	assert_eq!((out.as_str(), err.as_str(), st), ("bye 0\ng 0\n", "", 7));
	let (out, err, st) = zsh("zshexit(){echo bye $?}; false");
	assert_eq!((out.as_str(), err.as_str(), st), ("bye 1\n", "", 1));
}

#[test]
fn zsh_directory_name_runs_in_the_current_shell() {
	let (out, err, st) = zsh(
		"zsh_directory_name(){ [[ $1 = n ]] || return 1; count=$((count+1)); echo hook $count $2; \
		 reply=(/tmp) }; false; echo ~[x]/y $?; echo count=$count; \
		 zsh_directory_name_functions=(h); h(){ [[ $2 = z ]] || return 1; echo h; reply=(/var) }; \
		 echo ~[z]; echo count=$count",
	);
	assert_eq!(out, "hook 1 x\n/tmp/y 1\ncount=1\nhook 2 z\n/tmp\ncount=2\n");
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn continue_in_the_last_iteration_leaves_the_loop_status_zero() {
	let (out, err, st) = zsh(
		"i=0; while (( i++ < 2 )); do (( i == 2 )) && continue; false; done; echo $?; for x in 1 2; \
		 do [[ $x = 2 ]] && continue; false; done; echo $?; i=0; until (( i++ >= 2 )); do (( i == 2 \
		 )) && continue; false; done; echo $?",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("0\n0\n0\n", "", 0));
}

#[test]
fn misc_glob_assign_makes_a_scalar_or_an_array() {
	let (out, err, st) = zsh(
		"setopt globassign; foo=/tmp/pz/*.zsh; print -l $foo; typeset -p foo; integer i n x; float \
		 f; i=ec; n=/tmp/pz/*.zsh; x=/tmp/pz/s*; f=2+2; typeset -p i n x f; unsetopt globassign; \
		 foo=/tmp/pz/*.zsh; print $foo",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		(
			"/tmp/pz/ec.zsh\n/tmp/pz/sf.zsh\ntypeset -a foo=( /tmp/pz/ec.zsh /tmp/pz/sf.zsh \
			 )\ntypeset -i i=0\ntypeset -a n=( /tmp/pz/ec.zsh /tmp/pz/sf.zsh )\ntypeset \
			 x=/tmp/pz/sf.zsh\ntypeset -E f=4.000000000e+00\n/tmp/pz/*.zsh\n",
			"",
			0
		)
	);
}

#[test]
fn misc_prompt_names_share_one_value() {
	let (out, err, st) = zsh(
		"PROMPT=x; echo $PS1 $prompt; PS2=y; echo $PROMPT2; unset PS1; echo ${+PS1} ${+PROMPT} \
		 \"[$PROMPT]\"; PS1=z; echo $PROMPT $prompt",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("x x\ny\n0 1 []\nz z\n", "", 0));
}

#[test]
fn misc_printf_directive_ends_at_a_nul() {
	let (out, err, st) = zsh("printf $'%\\0'; echo no");
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("no\n", "zsh:printf:1: %: invalid directive\n", 0)
	);
}

#[test]
fn misc_functions_get_their_own_optind_without_posix_builtins() {
	let (out, err, st) = zsh(
		"t() { local o i=0 n=$1; shift; while [ $i -lt $n ]; do i=$(( i + 1 )); getopts a: o \"$@\" \
		 2>/dev/null; done; printf '<%d>' \"$OPTIND\"; }; OPTIND=3; t 1; t 1 -- foo; t 2 -a -b; \
		 echo \" $OPTIND\"; setopt posixbuiltins; t 1 -a; t 1 -a; echo \" $OPTIND\"",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("<1><2><3> 3\n<3><3> 3\n", "", 0));
}

#[test]
fn misc_reserved_typeset_runs_its_builtin_over_functions_and_disable() {
	let (out, err, st) = zsh(
		"function typeset { echo fn; }; typeset x=1; echo $x; disable typeset; typeset y=2; echo \
		 $y; local z=3; echo $z",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("1\n2\n3\n", "", 0));
}

#[test]
fn misc_assigning_another_uid_fails() {
	let (out, err, st) = zsh("UID=$UID; echo ok; UID=$((UID+1)); echo no");
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("ok\n", "zsh:1: failed to change user ID: operation not permitted\n", 1)
	);
}

#[test]
fn misc_prefix_uid_assignment_that_fails_stops_the_command() {
	let (out, err, st) = zsh("eval 'UID=$((UID+1)) echo run'; echo \"st $?\"");
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("st 1\n", "(eval):1: failed to change user ID: operation not permitted\n", 0)
	);
}

#[test]
fn misc_no_exec_expands_words_but_sets_and_globs_nothing() {
	let (out, err, st) = zsh(
		"(setopt noexec; : ${(el.20..X.)$bar}); echo $?; (setopt noexec; echo ${unset_var?x}; x=1; \
		 echo *nomatch*; typeset -p x); echo $?; x=2; (setopt noexec; x=3; : ${x::=4}; echo $x); \
		 echo $x",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("1\n0\n2\n", "zsh:1: bad substitution\n", 0));
}

#[test]
fn misc_local_of_a_computed_special_is_the_special_restored_at_return() {
	let (out, err, st) = zsh(
		"f(){ local SECONDS=5; echo $SECONDS; local HISTSIZE=7; echo $HISTSIZE; local -F SECONDS; \
		 echo ${(t)SECONDS}; }; f; echo $SECONDS $HISTSIZE ${(t)SECONDS}; g(){ local RANDOM=3; echo \
		 $RANDOM; }; a=$(g); RANDOM=3; b=$RANDOM; [[ $a == $b ]] && echo same; h(){ local SECONDS; \
		 echo ${(t)SECONDS}; SECONDS=100; }; h; echo $SECONDS; k(){ local -h SECONDS=x; echo \
		 $SECONDS ${(t)SECONDS}; }; k; i(){ local IFS; print -r -- \"[${(q)IFS}]\"; IFS=:; }; i; \
		 print -r -- \"[${(q)IFS}]\"",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		(
			"5\n7\nfloat-local-special\n0 30 integer-special\nsame\ninteger-local-special\n0\nx \
			 scalar-local-hide\n['']\n[\\ $'\\t'$'\\n'$'\\0']\n",
			"",
			0
		)
	);
}

#[test]
fn misc_started_as_sh_has_no_zsh_only_specials_and_no_ties() {
	let host = FakeHost::new();
	let init = ShellInit { mode: ModeId::ZshSh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let src = "PATH=/bin; export PATH; readonly PATH; typeset -p PATH; echo ${(t)PATH} ${+path} \
	           ${+PROMPT} ${+MANPATH} ${(t)ARGC}.; path=(a b); echo ${(t)path}";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(
		(
			String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
			String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
			st
		),
		(
			"export -r PATH=/bin\nscalar-readonly-export-special 0 0 0 .\narray\n".to_owned(),
			String::new(),
			0
		)
	);
}

#[test]
fn misc_seconds_switches_between_integer_and_float() {
	let (out, err, st) = zsh(
		"typeset -F SECONDS; echo ${(t)SECONDS}; typeset -F2 SECONDS; SECONDS=2.25; echo $SECONDS; \
		 typeset -p SECONDS; typeset -i SECONDS; echo ${(t)SECONDS}; SECONDS=5; echo $SECONDS; \
		 typeset -E SECONDS; echo ${(t)SECONDS}",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		(
			"float-special\n2.25\ntypeset -F SECONDS=2.25\ninteger-special\n2#101\nfloat-special\n",
			"",
			0
		)
	);
}

#[test]
fn redirkill_kill_reports_like_bin_kill() {
	let (out, err, st) = zsh(
		"kill; echo $?; kill -INT; echo $?; kill ''; echo $?; kill a b 1x; echo $?; kill -l 9 HUP x \
		 137 0 200; echo $?; kill -s; echo $?; kill -n; echo $?; kill -; echo $?; kill -9x 1; echo \
		 $?; kill -FOO 1; echo $?; kill -sint 1; echo $?; kill -- ; echo $?",
	);
	assert_eq!(out, "1\n1\n1\n3\nKILL\n1\nKILL\n0\n72\n1\n1\n1\n1\n1\n1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:kill:1: not enough arguments\nzsh:kill:1: not enough arguments\nzsh:kill:1: illegal \
		 pid: \nzsh:kill:1: illegal pid: a\nzsh:kill:1: illegal pid: b\nzsh:kill:1: illegal pid: \
		 1x\nzsh:kill:1: unknown signal: SIGx\nzsh:kill:1: -s: argument expected\nzsh:kill:1: -n: \
		 argument expected\nzsh:kill:1: -: signal name expected\nzsh:kill:1: invalid signal number: \
		 -9x\nzsh:kill:1: unknown signal: SIGFOO\nzsh:kill:1: type kill -l for a list of \
		 signals\nzsh:kill:1: unknown signal: SIGSINT\nzsh:kill:1: type kill -l for a list of \
		 signals\nzsh:kill:1: not enough arguments\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn redirkill_cd_hard_refuses_links_and_fixdir_stops_at_a_missing_dir() {
	let (out, err, st) = zsh(
		"zmodload zsh/files; mkdir /tmp/pz/real; ln -s /tmp/pz/real /tmp/pz/lnk; cd -s /tmp/pz/lnk; \
		 echo $?; cd /tmp/pz/lnk/../real; echo $? $PWD; cd /tmp/pz/nofile/..; echo $?",
	);
	assert_eq!(out, "1\n0 /tmp/pz/real\n1\n");
	assert_eq!(
		err,
		"zsh:cd:1: not a directory: /tmp/pz/lnk\nzsh:cd:1: no such file or directory: \
		 /tmp/pz/nofile/..\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn redirkill_write_to_closed_stdout() {
	let (out, err, st) = zsh("print foo >&-; echo $?; (exec >&-; print foo); echo $?");
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("0\n0\n", "zsh:1: write error: bad file descriptor\n", 0)
	);
}

#[test]
fn redirkill_readnullcmd_needs_nullcmd() {
	let (out, err, st) =
		zsh("unset NULLCMD; READNULLCMD=cat; print x >/tmp/pz/o; </tmp/pz/o; echo notreached");
	assert_eq!((out.as_str(), err.as_str(), st), ("", "zsh:1: redirection with no command\n", 1));
}

#[test]
fn redirkill_failed_dot_is_fatal_under_posix_builtins() {
	let (out, err, st) =
		zsh("setopt posixbuiltins; command . /nonexist; echo out $?; . /nonexist; echo notreached");
	assert_eq!(out, "out 127\n");
	assert_eq!(
		err,
		"zsh:.:1: no such file or directory: /nonexist\nzsh:.:1: no such file or directory: \
		 /nonexist\n"
	);
	assert_eq!(st, 1);
}

#[test]
fn redirkill_exec_redirection_keeps_assignments_under_posix_builtins() {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/pz");
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let src = "setopt posixbuiltins; x=45; x=$(print hi) exec >/tmp/pz/log; print x=$x";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(st, 0);
	assert_eq!(rig.host.fs.read("/tmp/pz/log").as_deref(), Some(&b"x=hi\n"[..]));
}

#[test]
fn redirkill_functions_value_shows_redirections_and_heredocs() {
	let (out, err, st) = zsh(
		"f() { echo a; } >/dev/null; print -r -- \"$functions[f]\"; fn() { cat <<-x \
		 <<-y\n\tfoo\n\tx\n\tbar\n\ty\n}; print -r -- \"$functions[fn]\"",
	);
	assert_eq!(out, "{\n\techo a\n} > /dev/null\n\tcat <<x <<y\nfoo\nx\nbar\ny\n");
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn redirkill_equals_substitution_is_a_temporary_file() {
	let (out, err, st) = zsh(
		"f() { read -r l <$1; echo $l $+1; g=$1 }; f =(print hello); [[ -e $g ]] || echo removed; \
		 echo ${g%??????}; f =(<<<\"a b\"); TMPSUFFIX=.txt; f =(print x); echo ${g##*.}; [[ -e $g \
		 ]] || echo gone",
	);
	assert_eq!(out, "hello 1\nremoved\n/tmp/zsh\na b 1\nx 1\ntxt\ngone\n");
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn trace_functions_t_and_t_local_and_function_dash_t() {
	let (out, err, st) = zsh(
		"f() g; g() :; functions -t f; f; functions +t f; functions -T f; f; function -T h { echo x \
		 }; h; functions h; () { :; } a",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("x\nh () {\n\t# traced\n\techo x\n}\n", "+f:1> g\n+g:1> :\n+f:1> g\n+h:0> echo x\n", 0)
	);
}

#[test]
fn trace_assignments_typeset_arguments_and_conditions() {
	let (out, err, st) = zsh(
		"set -x; x=1 y=\"a b\" z=; a=(1 \"b c\"); local -a l=(x y); local d=\"p q\" e; x=2 echo hi; \
		 [[ \"f o\" == \"f x\"* || -n \"\" ]]; [[ ! -z a && b < c ]]; set +x",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		(
			"hi\n",
			"+zsh:1> x=1 y='a b' z='' \n+zsh:1> a=( 1 'b c' ) \n+zsh:1> local -a l=( x y )\n+zsh:1> \
			 local d='p q' e\n+zsh:1> x=2 +zsh:1> echo hi\n+zsh:1> [[ 'f o' == f\\ x* || -n '' \
			 ]]\n+zsh:1> [[ ! -z a && b < c ]]\n+zsh:1> set +x\n",
			0
		)
	);
}

#[test]
fn trace_of_sourced_and_eval_code_keeps_the_stderr_before_redirection() {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/pz");
	host.fs.add_file("/tmp/pz/xt.in", b"print \"$*\"\n", 0o644);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let src = "set -x; . /tmp/pz/xt.in a 2>/dev/null; eval \"print b\" 2>/dev/null; set +x";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(String::from_utf8_lossy(&rig.host.stdout.bytes()), "a\nb\n");
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stderr.bytes()),
		"+zsh:1> . /tmp/pz/xt.in a\n+/tmp/pz/xt.in:1> print a\n+zsh:1> eval 'print b'\n+(eval):1> \
		 print b\n+zsh:1> set +x\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn trace_xtrace_comes_back_after_a_call_and_self_redefinition_keeps_tracing() {
	let (out, err, st) =
		zsh("f() { set -x; :; }; f; echo after; g() { g() { :; }; }; functions -T g; g; functions g");
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("after\ng () {\n\t# traced\n\t:\n}\n", "+f:0> :\n", 0)
	);
}

/// [`zsh`] with autoloadable function files: `/tmp/pz/fn/af` (in
/// `$fpath`) and `/tmp/pz/ex/spec` (loaded by its absolute path).
fn zsh_fn(src: &str) -> (String, String, i32) {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/pz");
	host.fs.add_dir("/tmp/pz/fn");
	host.fs.add_dir("/tmp/pz/ex");
	host
		.fs
		.add_file("/tmp/pz/fn/af", b"print -r -- \"auto $0 $#\"\n", 0o644);
	host
		.fs
		.add_file("/tmp/pz/ex/spec", b"print -r -- \"spec $0\"\n", 0o644);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn funcs_user_math_functions_return_the_last_arithmetic_value() {
	let (out, err, st) = zsh(
		"functions -M m1; m1() { (( $# )) }; print $(( m1() )) $(( m1(1,2) )); functions -M m2 1 2 \
		 mx; mx() { (( $1 * 10 )) }; print $(( m2(3) )); functions -Ms sl 1 1 slf; slf() { (( ${#1} \
		 )) }; print $(( sl(a b c) )); functions -M; functions +M m1; functions -M; print $(( m1() \
		 ))",
	);
	assert_eq!(
		out,
		"0 2\n30\n5\nfunctions -Ms sl 1 1 slf\nfunctions -M m2 1 2 mx\nfunctions -M m1\nfunctions \
		 -Ms sl 1 1 slf\nfunctions -M m2 1 2 mx\n"
	);
	assert_eq!((err.as_str(), st), ("zsh:1: unknown function: m1\n", 1));
}

#[test]
fn funcs_autoload_by_path_copy_and_resolve() {
	let (out, err, st) = zsh_fn(
		"fpath=(/tmp/pz/fn); autoload -Uz af /tmp/pz/ex/spec; whence -v af spec; af 1 2; spec; \
		 whence -v af spec; functions -c af ag; ag x; autoload -R nope; echo st=$?",
	);
	assert_eq!(
		out,
		"af is an autoload shell function\nspec is an autoload shell function from \
		 /tmp/pz/ex/spec\nauto af 2\nspec spec\naf is a shell function from /tmp/pz/fn/af\nspec is \
		 a shell function from /tmp/pz/ex/spec\nauto ag 1\nst=1\n"
	);
	assert_eq!((err.as_str(), st), ("zsh:1: nope: function definition file not found\n", 0));
}

#[test]
fn funcs_expanded_names_handler_csh_and_funcnest() {
	let (out, err, st) = zsh(
		"function f$((1+1)) g { print $0; }; f2; g; functions f2; command_not_found_handler() { \
		 print nf $1; return 3 }; nosuch; echo $?; emulate csh -c \"emulate\"; ( FUNCNEST=0; h() { \
		 :; }; h; echo no ); echo $?",
	);
	assert_eq!(out, "f2\ng\nf2 () {\n\tprint $0\n}\nnf nosuch\n3\ncsh\n1\n");
	assert_eq!(
		(err.as_str(), st),
		("h:1: maximum nested function level reached; increase FUNCNEST?\n", 0)
	);
}

#[test]
fn funcs_autoload_runs_in_the_call_with_loadautofunc_context() {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/af");
	host
		.fs
		.add_file("/tmp/af/f2", b"print -r -- \"ctx=$zsh_eval_context\"\n", 0o644);
	host.fs.add_file(
		"/tmp/af/f1",
		b"f1() { print inner \"$@\" }\nprint loading\nf1 \"$@\"\n",
		0o644,
	);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let src = "fpath=(/tmp/af); autoload -Uz f2; f2; f2; autoload -Uk f1; f1 z";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stdout.bytes()),
		"ctx=cmdarg shfunc loadautofunc\nctx=cmdarg shfunc\nloading\ninner z\ninner z\n"
	);
	assert_eq!((String::from_utf8_lossy(&rig.host.stderr.bytes()).as_ref(), st), ("", 0));
}

#[test]
fn redirkill_substitution_files_and_fds_keep_their_content() {
	let (out, err, st) = zsh(
		"IFS= read -rd '' x < =(print a); print -r -- \"[$x]\"; procfunc() { read -r l < <(read -r \
		 m < $1; print got $m); echo $l }; procfunc <(echo argument); print something=${:-=(echo \
		 'C,D),(F,G)'}; echo notreached",
	);
	assert_eq!(out, "[a\n]\ngot argument\n");
	assert_eq!((err.as_str(), st), ("zsh:1: unterminated `=(...)'\n", 1));
}

#[test]
fn funcs_math_functions_in_conditions_loops_and_nested_calls() {
	let (out, err, st) = zsh(
		"functions -M m1; m1() { (( 7 )) }; [[ \"m1()\" -eq 7 ]] && echo cond; for ((i=0; i<m1()-5; \
		 i++)) echo i$i; functions -M m3 1 1; m3() { (( $1 + 1 )) }; print $(( m3(m3(1)) )); x=1; \
		 (( m1() + x++ )); echo $x",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("cond\ni0\ni1\n3\n2\n", "", 0));
}

#[test]
fn subst_default_assignment_before_a_substitution_runs_it_once() {
	// The assignment sets the parameter before the substitution parks the
	// word: the replay must still take the assigning branch (the loop
	// p10k's prompt hit with `${_p9k__n:=63}…$((my_git_formatter(1)))`).
	let (out, err, st) = zsh(
		"f() { print -u2 call; fo=x$1 }; functions -M f 0 1; typeset n; unset m; echo \
		 ${n:=63}${$((f(1)))+$fo} ${m=a}$(echo hi) $n $m",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("63x1 ahi 63 a\n", "call\n", 0));
}

#[test]
fn subst_assignments_replay_their_state_for_later_words() {
	// Each substitution re-runs the word: a replay that kept the end state
	// of the previous pass (`n` = B) would skip `$(echo A)` and hand its
	// output to `$(echo C)` (p10k's per-segment `${_p9k__n::=}` resets).
	let (out, err, st) = zsh("typeset n; echo ${n::=}${n:-$(echo A)}${n::=B}$(echo C) $n");
	assert_eq!((out.as_str(), err.as_str(), st), ("ABC B\n", "", 0));
}

#[test]
fn trace_debug_trap_runs_once_per_list_with_zsh_debug_cmd() {
	let (out, err, st) = zsh(
		"fn() { setopt localtraps localoptions debugbeforecmd; trap 'print \"$LINENO: \
		 $ZSH_DEBUG_CMD\"' DEBUG; print a && print b || print c; x=y; (( LINENO == 0 )); }; fn",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("0: print a && print b || print c\na\nb\n0: x=y \n0: (( LINENO == 0 ))\n", "", 0)
	);
}

#[test]
fn trace_debug_trap_setting_errexit_skips_the_list() {
	let (out, err, st) = zsh(
		"fn() { setopt localtraps localoptions debugbeforecmd; trap '[[ $ZSH_DEBUG_CMD == *two* ]] \
		 && setopt errexit' DEBUG; print one; print two; print three; [[ -o errexit ]] && print \
		 set; }; fn; echo $?",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("one\nthree\n1\n", "", 0));
}

#[test]
fn trace_debug_trap_without_debug_before_cmd_runs_after_each_list() {
	let (out, err, st) = zsh(
		"unsetopt debugbeforecmd; fn() { trap 'print after $LINENO' DEBUG; :; trap - DEBUG; }; fn",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("after 0\nafter 0\n", "", 0));
}

#[test]
fn trace_functions_assignment_functions_source_and_functrace() {
	let (out, err, st) = zsh(
		"functions+=(a \"echo foo\"); a; functions+=(a \"echo bar\"); a; functions[b]=\"print -r \
		 b\"; b; f(){:}; print -r -- $functions_source[f]; h() { print -r -- $functrace; }; g() {\n  \
		 h\n}; g",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("foo\nbar\nb\nzsh\ng:1 zsh:3\n", "", 0));
}

#[test]
fn trace_ps4_command_stack_and_braceless_bodies_keep_the_callers_line() {
	let (out, err, st) = zsh(
		"PS4=\"%_> \"; set -x; if true; then true; else false; fi; while false; do :; done; { : } \
		 always { : }; set +x\nPS4=\"+%N:%i> \"\nf() g\ng() :\nset -x\nf\n() :",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		(
			"",
			"if> true\nthen> true\nwhile> false\ncursh> :\nalways> :\n> set +x\n+zsh:6> f\n+f:6> \
			 g\n+g:6> :\n+zsh:7> '(anon)'\n+(anon):7> :\n",
			0
		)
	);
}

#[test]
fn expandmb_multibyte_subscripts_case_padding_and_delimiters() {
	let (out, err, st) = zsh(
		"LANG=en_US.UTF-8; a=ténébreux; print ${a[2]} ${a[2,4]} ${a[-3,-1]} ${#a} ${a:1:3}; print \
		 ${(U)a} ${(L)${(U)a}}; b=\"l'état c'est moi\"; print ${(C)b}; a[-1]=; print $a; print \
		 ${a[(i)b]} ${a[(r)é*]}; print ${(l:4::¥:)a[1]}; x=été; print ${x:s/é/E/} ${x/é/E} \
		 ${(r£5££X£)x}",
	);
	assert_eq!(
		out,
		"é éné eux 9 éné\nTÉNÉBREUX ténébreux\nL'État C'Est Moi\nténébreu\n5 é\n¥¥¥t\nEté Eté \
		 étéXX\n"
	);
	assert_eq!((err.as_str(), st), ("", 0));
}

// Failure mode: an element read that loads only that element of the
// array (not the whole array) loses zsh's answers at the edges: negative
// and out-of-range indices, an empty element, `${+…}`, `(t)`, defaults,
// a subscript of the element, a range. Outputs from zsh 5.9.
#[test]
fn element_reads_answer_as_zsh_at_every_index() {
	let (out, err, st) = zsh(
		"a=(one two three '' five); print -r -- \"1:$a[1] -1:$a[-1] -2:${a[-2]} 4:[${a[4]}] \
		 0:[$a[0]] 9:[${a[9]}] -9:[${a[-9]}]\"; print -r -- \"def:${a[9]:-dflt} set:${+a[2]} \
		 set9:${+a[9]} set-1:${+a[-1]} type:${(t)a[1]}\"; print -r -- \"nested:${a[2][1,2]} \
		 len:${#a[3]} upper:${(U)a[1]} range:${a[2,3]}\"; i=3; print -r -- \"var:$a[i] \
		 expr:$a[i+1]\"",
	);
	assert_eq!(
		out,
		"1:one -1:five -2: 4:[] 0:[] 9:[] -9:[]\ndef:dflt set:1 set9:0 set-1:1 type:a\nnested:tw \
		 len:5 upper:ONE range:two three\nvar:three expr:\n"
	);
	assert_eq!((err.as_str(), st), ("", 0));
}

// Failure mode: a plain assignment or arithmetic on an ordinary variable,
// written to the store directly, loses what zsh's parameter code does
// for the variable: an integer's output base, a float's display, case
// and padding flags, modifiers and subscripts in the value, `GLOB_SUBST`,
// a new variable's type, a read-only refusal. Outputs from zsh 5.9.
#[test]
fn plain_assignments_keep_what_parameters_do() {
	let (out, err, _) = zsh(
		"a=one; integer n=7; typeset -i 16 h=255; float f=1.5; typeset -u U=low; typeset -L 6 L=ab; \
		 x=pre$a-$n/$h; print -r -- \"$x\"; x=$f; print -r -- \"$x\"; x=$a:u$a[2]; print -r -- \
		 \"$x\"; x=$U[$L]; print -r -- \"$x\"; setopt globsubst; s=\"*\"; x=$s; print -r -- \"$x\"; \
		 unsetopt globsubst; (( n = n * 3 )); (( h = h + 1 )); (( f = f * 2 )); print -r -- $n $h \
		 $f ${(t)n} ${(t)h}; (( u = 4 )); print -r -- $u ${(t)u}; typeset -r ro=1; (( ro = 2 )); \
		 print -r -- after",
	);
	assert_eq!(
		out,
		"preone-7/16#FF\n1.500000000e+00\nONEn\n\n*\n21 16#100 3.000000000e+00 integer integer\n4 \
		 integer\nafter\n"
	);
	assert!(err.contains("read-only variable: ro"), "{err}");
}

#[test]
fn expandmb_identifiers_admit_multibyte_letters_unless_posix_identifiers() {
	let (out, err, st) = zsh(
		"LANG=en_US.UTF-8; eval 'hähä=3; print $hähä'; eval 'for ß in x; do print $ß; done'; setopt \
		 posixidentifiers; (eval 'hä=1')",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("3\nx\n", "(eval):1: command not found: hä=1\n", 127)
	);
}

#[test]
fn expandmb_read_multibyte_delimiters_and_visible_characters() {
	let (out, err, st) = zsh(
		"LANG=en_US.UTF-8; read -d £ x <<< 'a£b'; print $x; IFS=«; read -d » -A arr <<< 'p«q«r»s'; \
		 print -l $arr; b=あ; c=$'\\x01'; print -r -- ${(V)b} ${(V)c}",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("a\np\nq\nr\nあ ^A\n", "", 0));
}

#[test]
fn expandmb_printf_q_tabs_and_unprintable_command_names() {
	let (out, err, st) = zsh(
		"LANG=en_US.UTF-8; printf '%q%q\\n' 你你; printf '%q|\\n'; print -X8 -r -- \
		 $'one\\t１２\\tthree'; $'\\xe9x'",
	);
	assert_eq!(out, "你你\n|\none     １２    three\n");
	assert_eq!((err.as_str(), st), ("zsh:1: command not found: \\M-ix\n", 127));
}

#[test]
fn expandmb_underscore_around_functions_and_definitions() {
	let (out, err, st) = zsh(
		"a=1 b=2; : One; function { : Two; echo $_; }; print -l \"[$_]\"; f(){ :; }; : a b; f; echo \
		 \"[$_]\"; g() {}; echo \"[$_]\"",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("Two\n[]\n[f]\n[]\n", "", 0));
}

#[test]
fn expandmb_z_flag_follows_csh_junkie_quotes() {
	let (out, err, st) =
		zsh("b=$'# \\' single\\nword'; setopt CSH_JUNKIE_QUOTES; printf '<%s>\\n' \"${(@Z+n+)b}\"");
	assert_eq!((out.as_str(), err.as_str(), st), ("<#>\n<' single>\n<word>\n", "", 0));
}

#[test]
fn expandmb_unset_special_stays_exported_and_p_rejects_arrays() {
	let (out, err, st) = zsh(
		"export HOME=/h; unset HOME; HOME=/x; typeset -p HOME; s1=foo s2=bar; val=(s1 s2); print \
		 ${${(P)val}[1,3]}",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("export HOME=/x\n", "zsh:1: parameter name reference used with array\n", 1)
	);
}

#[test]
fn expandmb_unicode_escape_in_c_locale_is_an_error() {
	let (out, err, st) = zsh("(LC_ALL=C; print $'\\u00e9'; echo notreached); echo st=$?");
	assert_eq!((out.as_str(), err.as_str(), st), ("st=1\n", "zsh:1: character not in range\n", 0));
}

#[test]
fn expandmb_glob_qualifiers_run_shell_code() {
	let host = FakeHost::new().with_fs(crate::testkit::MemFs::new());
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	// zsh: `$n` expands before the glob runs the code.
	let src = "zmodload zsh/files; cd /tmp; mkdir pg; cd pg; mkdir d; : > a > b > c > d/x; print \
	           *(e:'[[ $REPLY != b ]]':); print *(.e:'reply=(${REPLY}X ${REPLY}Y)':); n=0; f() { \
	           (( ++n )); [[ $REPLY = [ac] ]] }; print *(+f) $n; print $n; print */*(e^'reply=( \
	           /tmp/pg/*/${REPLY:t} )'^)";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(
		(
			String::from_utf8_lossy(&rig.host.stdout.bytes()).as_ref(),
			String::from_utf8_lossy(&rig.host.stderr.bytes()).as_ref(),
			st
		),
		("a c d\naX aY bX bY cX cY\na c 0\n4\n/tmp/pg/d/x\n", "", 0)
	);
}

#[test]
fn funcs_commands_lists_every_entry_of_path() {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/ctst");
	host.fs.add_dir("/tmp/ctst/sub");
	host
		.fs
		.add_file("/tmp/ctst/ztst.zsh", b"#!/bin/sh\n", 0o755);
	host.fs.add_file("/tmp/ctst/plain", b"", 0o644);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let src = "path=( /tmp/ctst ); print -r -- ${(k)commands[(I)zt*]} ${+commands[ztst.zsh]} \
	           $commands[plain]; hash; hash -r; hash; hash -f; hash; unsetopt hashlistall; \
	           path=(/tmp/ctst); echo ${+commands[plain]}; setopt hashexecutablesonly hashlistall; \
	           echo ${(k)commands}";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stdout.bytes()),
		concat!(
			"ztst.zsh 1 /tmp/ctst/plain\n",
			"plain=/tmp/ctst/plain\n",
			"sub=/tmp/ctst/sub\n",
			"ztst.zsh=/tmp/ctst/ztst.zsh\n",
			"plain=/tmp/ctst/plain\n",
			"sub=/tmp/ctst/sub\n",
			"ztst.zsh=/tmp/ctst/ztst.zsh\n",
			"0\n",
			"ztst.zsh\n",
		)
	);
	assert_eq!((String::from_utf8_lossy(&rig.host.stderr.bytes()).as_ref(), st), ("", 0));
}

#[test]
fn expandmb_quoting_backslashes_the_history_character() {
	// Non-interactive: only `$'…'` quoting knows the history character.
	let (out, err, st) = zsh(
		"setopt banghist; x=$'\\x21foo'; print -r -- ${(q)x} ${(qq)x} ${(qqqq)x} ${(qqq)x}; \
		 histchars=@; y=$'@a!b'; print -r -- ${(qqqq)y}; unsetopt banghist; print -r -- ${(qqqq)x}",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("!foo '!foo' $'\\!foo' \"!foo\"\n$'\\@a!b'\n$'!foo'\n", "", 0)
	);
}

#[test]
fn expandmb_sorting_follows_lc_collate() {
	// The expected order is en_US.UTF-8's; hosts without that locale sort
	// bytewise.
	if crate::sys::langinfo::Collator::new(b"en_US.UTF-8").is_none() {
		return;
	}
	let (out, err, st) = zsh(
		"LANG=en_US.UTF-8; a=(oracle.py oracle_ob.py drive.py B a b10 b9); print ${(o)a}; print \
		 ${(On)a}; LC_COLLATE=C; print ${(o)a}",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		(
			"a B b10 b9 drive.py oracle_ob.py oracle.py\noracle.py oracle_ob.py drive.py b10 b9 B \
			 a\nB a b10 b9 drive.py oracle.py oracle_ob.py\n",
			"",
			0
		)
	);
}

#[test]
fn trace_funcsourcetrace_and_funcfiletrace_for_autoloaded_and_sourced_functions() {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/fst");
	host.fs.add_file(
		"/tmp/fst/myf",
		b"print -r -- \"A: $funcsourcetrace / $funcfiletrace / $functrace\"\nh\n",
		0o644,
	);
	host.fs.add_file(
		"/tmp/fst/src.zsh",
		b"\n\nsf() {\n  print -r -- \"S: $funcsourcetrace / $funcfiletrace / $functrace\"\n}\nsf\n",
		0o644,
	);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let src = "h() {\n  print -r -- \"H: $funcsourcetrace / $funcfiletrace / \
	           $functrace\"\n}\nfpath=(/tmp/fst); autoload -U myf; myf\ng() {\n\n  myf\n}\ng\n. \
	           /tmp/fst/src.zsh";
	let st = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stdout.bytes()),
		"A: /tmp/fst/myf:0 / zsh:4 / zsh:4\nH: zsh:1 /tmp/fst/myf:0 / /tmp/fst/myf:2 zsh:4 / myf:2 \
		 zsh:4\nA: /tmp/fst/myf:0 zsh:5 / zsh:7 zsh:9 / g:2 zsh:9\nH: zsh:1 /tmp/fst/myf:0 zsh:5 / \
		 /tmp/fst/myf:2 zsh:7 zsh:9 / myf:2 g:2 zsh:9\nS: /tmp/fst/src.zsh:3 /tmp/fst/src.zsh:0 / \
		 /tmp/fst/src.zsh:6 zsh:10 / /tmp/fst/src.zsh:6 zsh:10\n"
	);
	assert_eq!(
		(String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(), st),
		(String::new(), 0)
	);
}

#[test]
fn expandmb_quoting_keeps_printable_multibyte_characters() {
	let (out, err, st) = zsh(
		"LC_ALL=en_US.UTF-8; x=€1; y=$'\\x01é'; print -r -- \"[${(q)x}] [${(q+)x}] [${(qqqq)x}] \
		 [${(q)y}] [${(qqqq)y}] [${(qqq)x}]\"",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("[€1] [€1] [$'€1'] [$'\\001'é] [$'\\001é'] [\"€1\"]\n", "", 0)
	);
}
