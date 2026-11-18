//! The module checks powerlevel10k (and gitstatus) run at startup, as one
//! acceptance suite over ModulesA's registry and ModulesB's modules.
//! Expected output comes from `/bin/zsh -f -c` 5.9.

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
fn zsh_mod_p10k_module_checks_load() {
	let (out, err, st) = zsh(
		"zmodload zsh/langinfo zsh/terminfo zsh/system || return; zmodload -F zsh/files b:zf_mv \
		 b:zf_rm && zmodload zsh/mathfunc zsh/zselect && zmodload zsh/sched && zmodload -F \
		 zsh/net/socket b:zsocket && echo ok; zmodload -LF zsh/files; whence -w zf_rm zf_ln sysread \
		 zselect sched zsocket; print -l ${(o)${(f)\"$(zmodload)\"}}",
	);
	assert_eq!(err, "");
	// `zmodload -LF` ends its line with a space and no newline.
	assert_eq!(
		out,
		"ok\nzmodload -F zsh/files b:zf_mv b:zf_rm zf_rm: builtin\nzf_ln: none\nsysread: \
		 builtin\nzselect: builtin\nsched: builtin\nzsocket: \
		 builtin\nzsh/files\nzsh/langinfo\nzsh/main\nzsh/mathfunc\nzsh/net/socket\nzsh/sched\nzsh/\
		 system\nzsh/terminfo\nzsh/zselect\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_p10k_system_parameters() {
	let (out, err, st) = zsh(
		"zmodload zsh/system; zsystem supports flock; echo $?; zsystem supports nope; echo $?; [[ \
		 $sysparams[pid] == $$ ]] && echo pid-ok; (( ${#errnos} > 30 )) && echo errnos-ok; print -r \
		 -- ${(t)errnos} ${(t)sysparams}; zmodload -e zsh/system && echo loaded; zmodload -e \
		 zsh/zpty || echo notloaded",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"0\n1\npid-ok\nerrnos-ok\narray-readonly-hide-hideval-special \
		 association-readonly-hide-hideval-special\nloaded\nnotloaded\n"
	);
	assert_eq!(st, 0);
}
