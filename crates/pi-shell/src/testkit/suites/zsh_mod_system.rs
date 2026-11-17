//! zsh/system on the fake host (ports of zsh 5.9 `Src/Modules/system.c`):
//! option and argument errors, `syserror`, `sysread`/`syswrite` on pipes
//! and here-documents, `$errnos` and `$sysparams`, `systell`, `zsystem`'s
//! argument handling. Expected output comes from `/bin/zsh -f -c` 5.9 on
//! macOS (`$errnos` is the platform's list).

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

#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "macOS has no O_NOATIME")]
fn zsh_mod_system_option_and_argument_errors() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; sysread -i x; sysread -c 1a; sysread 1a; sysread -s -1 x; sysread -s \
		 1x; syswrite; syswrite a b; syserror a b; sysopen f1; sysopen -u 1x f1; sysopen -u fd -o \
		 bogus f1; sysopen -u fd -m 64 f1; sysopen -u fd -m 0x9 f1; sysopen -u fd -o O_NOATIME f1; \
		 sysseek -w foo 1; zsystem; zsystem foo; echo end",
	);
	assert_eq!(out, "end\n");
	assert_eq!(
		err,
		"zsh:sysread:1: integer expected: x\nzsh:sysread:1: not an identifier: 1a\nzsh:sysread:1: \
		 not an identifier: 1a\nzsh:sysread:1: integer expected: -1\nzsh:sysread:1: integer \
		 expected: 1x\nzsh:syswrite:1: not enough arguments\nzsh:syswrite:1: too many \
		 arguments\nzsh:syserror:1: too many arguments\nzsh:sysopen:1: file descriptor not \
		 specified\nzsh:sysopen:1: not an identifier: 1x\nzsh:sysopen:1: unsupported option: \
		 bogus\n\nzsh:sysopen:1: invalid mode 64\nzsh:sysopen:1: invalid mode 0x9\nzsh:sysopen:1: \
		 unsupported option: NOATIME\n\nzsh:sysseek:1: unknown argument to -w: foo\nzsh:zsystem:1: \
		 not enough arguments\nzsh:zsystem:1: unknown subcommand: foo\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_zsystem_supports() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; zsystem supports; echo $?; zsystem supports flock; echo $?; zsystem \
		 supports x y; echo $?; zsystem supports nope; echo $?; zsystem supports supports; echo $?",
	);
	assert_eq!(out, "255\n0\n255\n1\n0\n");
	assert_eq!(
		err,
		"zsh:zsystem:1: supports: not enough arguments\nzsh:zsystem:1: supports: too many \
		 arguments\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_flock_argument_errors() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; zsystem flock; zsystem flock a b; zsystem flock -x a; zsystem flock \
		 -f; zsystem flock -f 1x a; zsystem flock -t; zsystem flock -t 2000000000 a; zsystem flock \
		 -i; zsystem flock -i 0 a; zsystem flock -u 3; echo $?",
	);
	assert_eq!(out, "1\n");
	assert_eq!(
		err,
		"zsh:zsystem:1: flock: not enough arguments\nzsh:zsystem:1: flock: too many \
		 arguments\nzsh:zsystem:1: flock: unknown option: x\nzsh:zsystem:1: flock: option f \
		 requires a variable name\nzsh:zsystem:1: flock: option f requires a variable \
		 name\nzsh:zsystem:1: flock: option t requires a numeric timeout\nzsh:zsystem:1: flock: \
		 invalid timeout value: '2000000000'\nzsh:zsystem:1: flock: option i requires a numeric \
		 retry interval\nzsh:zsystem:1: flock: invalid interval value: '0'\nzsh:zsystem:1: flock: \
		 file descriptor 3 not in use for locking\n"
	);
	assert_eq!(st, 0);
}

#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "`strerror` text is macOS libc's")]
fn zsh_mod_system_syserror() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; syserror ENOENT; syserror -p \"x: \" 2; syserror -e v EBADF; print -r \
		 -- $v; syserror FOO; echo $?; syserror 999; syserror -e 1v 2; echo $?",
	);
	assert_eq!(out, "Bad file descriptor\n2\n1\n");
	assert_eq!(
		err,
		"No such file or directory\nx: No such file or directory\nUnknown error: \
		 999\nzsh:syserror:1: not an identifier: 1v\n"
	);
	assert_eq!(st, 0);
}

/// `syserror` (the recorded errno) after a write to a pipe whose reader has
/// gone: `EPIPE`, not 0.
#[test]
fn zsh_mod_system_syswrite_to_a_closed_pipe_is_epipe() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; { syswrite x; echo \"st=$?\" >&2; syserror; syserror -e v; echo \
		 \"[$v]\" >&2; } | :",
	);
	assert_eq!(out, "");
	assert_eq!(err, "st=2\nBroken pipe\n[Broken pipe]\n");
	assert_eq!(st, 0);
}

/// `syserror` prints glibc's texts on Linux and, from its own table, off
/// Unix: a number the table has always had, one it once lacked (`EIO`,
/// `EPIPE`), and one outside it.
#[test]
#[cfg_attr(target_os = "macos", ignore = "`strerror` text is macOS libc's")]
fn zsh_mod_system_syserror_texts_match_glibc() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; syserror ENOENT; syserror EIO; syserror 32; syserror ELOOP; syserror \
		 41; syserror ENOTRECOVERABLE; syserror 134; syserror 0",
	);
	assert_eq!(out, "");
	assert_eq!(
		err,
		"No such file or directory\nInput/output error\nBroken pipe\nToo many levels of symbolic \
		 links\nUnknown error 41\nState not recoverable\nUnknown error 134\nSuccess\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_sysread_from_pipes() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; echo hello | sysread; print -r -- \"[$REPLY]\"; echo hello | sysread \
		 -c n x; print -r -- \"[$x] $n\"; : | sysread y; echo $? \"[$y]\"",
	);
	assert_eq!(out, "[hello\n]\n[hello\n] 6\n5 []\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_sysread_buffer_size_reads_in_parts() {
	let (out, _, st) = zsh(
		"zmodload zsh/system; echo hello | sysread -s 2 x; print -r -- $x; printf abcdef | { \
		 sysread -s 3 a; sysread -s 3 b; sysread c; echo $? }; print -r $a $b",
	);
	assert_eq!(out, "he\n5\nabc def\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_sysread_here_string_into_an_element() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; sysread x <<< 'here doc'; print -r -- \"[$x]\"; sysread -c n 'arr[2]' \
		 <<< ab; typeset -p arr n",
	);
	assert_eq!(out, "[here doc\n]\ntypeset -a arr=( '' $'ab\\n' )\ntypeset -i n=3\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_bad_fds_set_errno() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; sysread -i 7 x; echo $?; syswrite -o 7 x; echo $?; syserror; syswrite \
		 -c n hello; echo \" $n\"",
	);
	assert_eq!(out, "2\n2\nhello 5\n");
	assert_eq!(err, "Bad file descriptor\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_sysread_copies_to_an_fd() {
	let (out, _, st) = zsh(
		"zmodload zsh/system; echo abc | sysread -o 1 -c n; echo \" $n $?\"; : | sysread -o 1 -c m; \
		 echo $? $m",
	);
	assert_eq!(out, "abc\n 4 0\n5 0\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_sysread_times_out() {
	let (out, _, st) = zsh(
		"zmodload zsh/system zsh/zselect; sysread -t 0 x < <(zselect -t 100); echo $?; sysread -t \
		 0.1 x < <(zselect -t 100); echo $?",
	);
	assert_eq!(out, "4\n4\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_bad_timeout_is_a_math_error() {
	let (out, err, st) = zsh("zmodload zsh/system; sysread -t \"1+\" x; echo no");
	assert_eq!(out, "");
	assert_eq!(err, "zsh:1: bad math expression: operand expected at end of string\n");
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_system_parameters() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; print -r -- ${#errnos} $errnos[1] $errnos[9] $errnos[-1]; print -r -- \
		 ${(t)errnos} ${(t)sysparams}; print -r -- ${(k)sysparams}; [[ $sysparams[pid] == $$ ]] && \
		 echo same; print $sysparams[procsubstpid]; errnos=(a); echo $?",
	);
	#[cfg(target_os = "macos")]
	assert_eq!(
		out,
		"107 EPERM EBADF ENOTCAPABLE\narray-readonly-hide-hideval-special \
		 association-readonly-hide-hideval-special\npid ppid procsubstpid\nsame\n0\n"
	);
	#[cfg(not(target_os = "macos"))]
	let _ = out;
	assert_eq!(err, "zsh:1: read-only variable: errnos\n");
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_system_parameters_are_read_only() {
	let (_, err, st) = zsh("zmodload zsh/system; sysparams[pid]=3; echo $?");
	assert_eq!(err, "zsh:1: read-only variable: sysparams\n");
	assert_eq!(st, 1);
	let (_, err, st) = zsh("zmodload zsh/system; unset errnos; echo $?");
	assert_eq!(err, "zsh:1: read-only variable: errnos\n");
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_system_parameters_need_the_module() {
	let (out, _, st) = zsh("print -r -- \"[${#errnos}]\"; zmodload zsh/system; print ${+sysparams}");
	assert_eq!(out, "[0]\n1\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_seek_and_tell_on_bad_fds() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; sysseek -u 9 0; echo $?; echo $(( systell(9) )); echo $(( systell(-1) \
		 )); echo after",
	);
	assert_eq!(out, "2\n-1\n");
	assert_eq!(err, "zsh:1: file descriptor out of range\n");
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_system_pipes_do_not_seek() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; exec 3< <(print abc); sysread -i 3 x; print -r -- $x; sysseek -u 3 0; \
		 echo $?; syserror",
	);
	assert_eq!(out, "abc\n\n2\n");
	assert_eq!(err, "Illegal seek\n");
	assert_eq!(st, 0);
}
