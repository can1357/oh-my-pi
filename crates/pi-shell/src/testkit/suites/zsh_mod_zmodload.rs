//! zsh's module system (`module.c`): `zmodload` in all its forms,
//! autoloading on first use, feature enables and `$modules`. Expected
//! output comes from `/bin/zsh -f -c` 5.9.

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
fn zmodload_lists_loaded_modules() {
	assert_eq!(
		zsh("zmodload; zmodload -L"),
		("zsh/main\nzmodload zsh/main\n".into(), String::new(), 0)
	);
	let (out, err, st) = zsh(
		"zmodload zsh/datetime zsh/regex; zmodload; zmodload -e zsh/datetime; echo $?; zmodload -e \
		 zsh/datetime zsh/pcre; echo $?",
	);
	assert_eq!(out, "zsh/datetime\nzsh/main\nzsh/regex\n0\n1\n");
	assert_eq!((err.as_str(), st), ("", 0));
}

#[test]
fn zmodload_unload_errors() {
	assert_eq!(
		zsh("zmodload -u zsh/datetime"),
		(String::new(), "zsh:zmodload:1: no such module zsh/datetime\n".into(), 1)
	);
	assert_eq!(zsh("zmodload -iu zsh/datetime; echo $?"), ("0\n".into(), String::new(), 0));
	assert_eq!(
		zsh("zmodload -u"),
		(String::new(), "zsh:zmodload:1: what do you want to unload?\n".into(), 1)
	);
	assert_eq!(
		zsh("zmodload zsh/zutil; zmodload; zmodload -u zsh/zle"),
		(
			"zsh/complete\nzsh/main\nzsh/zle\nzsh/zutil\n".into(),
			"zsh:zmodload:1: module zsh/zle is in use by another module and cannot be unloaded\n"
				.into(),
			1
		)
	);
	assert_eq!(
		zsh("zmodload -u zsh/zutil; echo $?; zmodload"),
		("0\nzsh/main\n".into(), String::new(), 0)
	);
}

#[test]
fn zmodload_option_errors() {
	let cases = [
		("zmodload -b", "zsh:zmodload:1: -b, -c, -f, and -p must be combined with -a or -u\n"),
		("zmodload -e -L", "zsh:zmodload:1: -e cannot be combined with other options\n"),
		("zmodload -l", "zsh:zmodload:1: -l is only allowed with -F\n"),
		("zmodload -A zsh/a=zsh/a", "zsh:zmodload:1: module alias would refer to itself: zsh/a\n"),
		("zmodload -R zsh/nope", "zsh:zmodload:1: no such module alias: zsh/nope\n"),
		("zmodload zsh/x-y", "zsh:1: invalid module name `zsh/x-y'\n"),
		(
			"zmodload -F zsh/datetime b:nope",
			"zsh:1: module `zsh/datetime' has no such feature: `b:nope'\n",
		),
		("zmodload -F zsh/datetime -u", "zsh:1: module `zsh/datetime' has no such feature: `u'\n"),
		("zmodload -lF zsh/datetime", "zsh:zmodload:1: module `zsh/datetime' is not yet loaded\n"),
	];
	for (src, err) in cases {
		assert_eq!(zsh(src), (String::new(), err.into(), 1), "{src}");
	}
}

#[test]
fn zmodload_features() {
	let (out, ..) = zsh(
		"zmodload -F zsh/datetime b:strftime; zmodload -lF zsh/datetime; zmodload -LF zsh/datetime; \
		 zmodload -LlF zsh/datetime",
	);
	assert_eq!(
		out,
		"+b:strftime\n-p:EPOCHSECONDS\n-p:EPOCHREALTIME\n-p:epochtime\nzmodload -F zsh/datetime \
		 b:strftime zmodload -F zsh/datetime +b:strftime -p:EPOCHSECONDS -p:EPOCHREALTIME \
		 -p:epochtime\n"
	);
	let (out, ..) = zsh(
		"zmodload zsh/datetime; zmodload -F zsh/datetime -p:epochtime; zmodload -LF; zmodload -lF \
		 zsh/datetime +b:strftime; zmodload -lF zsh/datetime b:strftime",
	);
	assert_eq!(
		out,
		"zmodload -F zsh/datetime b:strftime p:EPOCHSECONDS p:EPOCHREALTIME\n+b:strftime\n"
	);
	let (out, ..) = zsh(r#"zmodload -mF zsh/datetime "p:EPOCH*"; zmodload -lF zsh/datetime"#);
	assert_eq!(out, "-b:strftime\n+p:EPOCHSECONDS\n+p:EPOCHREALTIME\n-p:epochtime\n");
	let (out, err, _) = zsh(
		"zmodload -FlP arr zsh/datetime; print -l $arr; zmodload zsh/datetime; zmodload -FLP arr \
		 zsh/datetime; print -l $arr",
	);
	assert_eq!(out, "\nb:strftime\np:EPOCHSECONDS\np:EPOCHREALTIME\np:epochtime\n");
	assert_eq!(err, "zsh:zmodload:1: module `zsh/datetime' is not yet loaded\n");
}

#[test]
fn builtins_autoload_their_module() {
	let (out, ..) = zsh("zmodload -e zsh/zutil; echo $?; zstyle; zmodload; zmodload -lF zsh/zutil");
	assert_eq!(
		out,
		concat!(
			"1\n",
			"zsh/complete\n",
			"zsh/main\n",
			"zsh/zle\n",
			"zsh/zutil\n",
			"-b:zformat\n",
			"-b:zparseopts\n",
			"-b:zregexparse\n",
			"+b:zstyle\n",
		)
	);
	assert_eq!(
		zsh("zmodload -ub zstyle; zstyle :a b c"),
		(String::new(), "zsh:1: command not found: zstyle\n".into(), 127)
	);
	let (out, ..) = zsh(
		"zmodload -Fa zsh/datetime b:strftime; zmodload -FaL zsh/datetime; zmodload -lF \
		 zsh/datetime 2>/dev/null; echo $?; type strftime",
	);
	assert_eq!(out, "zmodload -aF zsh/datetime b:strftime\n1\nstrftime is a shell builtin\n");
}

#[test]
fn autoload_listings() {
	let (out, ..) = zsh("zmodload -a");
	assert_eq!(
		out,
		"bindkey (zsh/zle)\ncompadd (zsh/complete)\ncomparguments (zsh/computil)\ncompcall \
		 (zsh/compctl)\ncompctl (zsh/compctl)\ncompdescribe (zsh/computil)\ncompfiles \
		 (zsh/computil)\ncompgroups (zsh/computil)\ncompquote (zsh/computil)\ncompset \
		 (zsh/complete)\ncomptags (zsh/computil)\ncomptry (zsh/computil)\ncompvalues \
		 (zsh/computil)\nechotc (zsh/termcap)\nechoti (zsh/terminfo)\nlimit (zsh/rlimits)\nlog \
		 (zsh/watch)\nprivate (zsh/param/private)\nsched (zsh/sched)\nulimit (zsh/rlimits)\nunlimit \
		 (zsh/rlimits)\nvared (zsh/zle)\nzformat (zsh/zutil)\nzle (zsh/zle)\nzparseopts \
		 (zsh/zutil)\nzregexparse (zsh/zutil)\nzstyle (zsh/zutil)\n"
	);
	let (out, ..) = zsh("zmodload -ac; zmodload -Lac");
	assert_eq!(
		out,
		"post after (zsh/complete)\npost between (zsh/complete)\npost suffix (zsh/complete)\npost \
		 prefix (zsh/complete)\nzmodload -ac zsh/complete after\nzmodload -ac zsh/complete \
		 between\nzmodload -ac zsh/complete suffix\nzmodload -ac zsh/complete prefix\n"
	);
	let (out, ..) = zsh("zmodload -Ld; zmodload -d zsh/foo zsh/bar; zmodload -d zsh/foo");
	assert_eq!(
		out,
		"zmodload -d zsh/compctl zsh/complete zsh/zle\nzmodload -d zsh/complete zsh/zle\nzmodload \
		 -d zsh/complist zsh/complete zsh/zle\nzmodload -d zsh/computil zsh/complete \
		 zsh/zle\nzmodload -d zsh/zleparameter zsh/zle\nzmodload -d zsh/zutil \
		 zsh/complete\nzsh/foo: zsh/bar\n"
	);
}

#[test]
fn module_aliases() {
	let (out, ..) = zsh(
		"zmodload -A zsh/myalias=zsh/datetime; zmodload -A; zmodload -LA; zmodload zsh/myalias; \
		 zmodload; echo ${modules[zsh/myalias]}; zmodload -R zsh/myalias; zmodload -A",
	);
	assert_eq!(
		out,
		"zsh/myalias -> zsh/datetime\nzmodload -A \
		 zsh/myalias=zsh/datetime\nzsh/datetime\nzsh/main\nalias:zsh/datetime\n"
	);
}

#[test]
fn builtins_parameter_in_builtintab_order() {
	let (out, ..) = zsh(
		r#"p="(strftime|comp*|zstyle|zle|bindkey|vared)"; print -r -- ${(k)builtins[(I)$~p]}; zmodload zsh/datetime; zstyle; print -r -- ${(k)builtins[(I)$~p]}; print $builtins[zstyle] $builtins[zformat]"#,
	);
	assert_eq!(
		out,
		"compfiles zle comptags compdescribe compctl compadd comparguments zstyle comptry bindkey \
		 compset compvalues compgroups compquote vared compcall\ncompfiles zle comptags \
		 compdescribe compctl compadd comparguments zstyle comptry bindkey compset strftime \
		 compvalues compgroups compquote vared compcall\ndefined undefined\n"
	);
}

#[test]
fn modules_parameter_in_zsh_order() {
	let (out, ..) = zsh("print -r -- ${(kv)modules}");
	assert_eq!(
		out,
		"zsh/parameter loaded zsh/main loaded zsh/rlimits autoloaded zsh/computil autoloaded \
		 zsh/zle autoloaded zsh/sched autoloaded zsh/zutil autoloaded zsh/compctl autoloaded \
		 zsh/complete autoloaded zsh/termcap autoloaded zsh/terminfo autoloaded zsh/watch \
		 autoloaded zsh/param/private autoloaded zsh/zleparameter autoloaded\n"
	);
	let (out, ..) = zsh("zmodload zsh/datetime; print -r -- ${(k)modules}");
	assert_eq!(
		out,
		"zsh/parameter zsh/main zsh/datetime zsh/rlimits zsh/computil zsh/zle zsh/sched zsh/zutil \
		 zsh/compctl zsh/complete zsh/termcap zsh/terminfo zsh/watch zsh/param/private \
		 zsh/zleparameter\n"
	);
	let (out, ..) =
		zsh("print ${modules[zsh/main]} ${modules[zsh/zutil]} ${+modules[zsh/datetime]}");
	assert_eq!(out, "loaded autoloaded 0\n");
}

#[test]
fn local_hides_hidden_module_special() {
	assert_eq!(
		zsh(
			"zmodload zsh/datetime; fn() { local EPOCHSECONDS=scruts; print $EPOCHSECONDS \
			 ${(t)EPOCHSECONDS}; g; }; g() { print in g $EPOCHSECONDS; }; fn; [[ $EPOCHSECONDS = <-> \
			 ]] && print number; print ${(t)EPOCHSECONDS}"
		),
		(
			"scruts scalar-local\nin g scruts\nnumber\ninteger-readonly-hide-hideval-special\n".into(),
			String::new(),
			0
		)
	);
	assert_eq!(
		zsh("f(){ local options=x; print $options ${(t)options} }; f; print ${(t)options}"),
		("x scalar-local\nassociation-hide-hideval-special\n".into(), String::new(), 0)
	);
}

#[test]
fn typeset_h_on_module_special() {
	assert_eq!(
		zsh(
			"zmodload zsh/datetime; typeset +h EPOCHSECONDS; print ${(t)EPOCHSECONDS}; typeset -h \
			 EPOCHSECONDS; print ${(t)EPOCHSECONDS}; typeset +h EPOCHSECONDS; zmodload -u \
			 zsh/datetime; zmodload zsh/datetime; print ${(t)EPOCHSECONDS}"
		),
		(
			concat!(
				"integer-readonly-hideval-special\n",
				"integer-readonly-hide-hideval-special\n",
				"integer-readonly-hide-hideval-special\n",
			)
			.into(),
			String::new(),
			0
		)
	);
	// An un-hidden read-only special made local stays read-only (zsh's
	// exit status after the abandoned command line differs: not compared).
	let (out, err, _) = zsh(
		"zmodload zsh/datetime; () { typeset +h EPOCHSECONDS; fn() { local EPOCHSECONDS=scruts; \
		 print not here; }; fn; print after }",
	);
	assert_eq!((out.as_str(), err.as_str()), ("", "fn: read-only variable: EPOCHSECONDS\n"));
	let (out, err, _) = zsh("f(){ local PPID=3; print no; }; f; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("", "f: read-only variable: PPID\n"));
}

#[test]
fn module_param_blocked_by_existing_param() {
	assert_eq!(
		zsh(
			"fn() { local EPOCHSECONDS=scrimf; zmodload zsh/datetime; echo st=$?; }; fn; zmodload \
			 -lF zsh/datetime; zmodload -F zsh/datetime p:EPOCHSECONDS; zmodload -Fe zsh/datetime \
			 +p:EPOCHSECONDS; echo $?"
		),
		(
			"st=2\n+b:strftime\n-p:EPOCHSECONDS\n+p:EPOCHREALTIME\n+p:epochtime\n0\n".into(),
			"fn: Can't add module parameter `EPOCHSECONDS': local parameter exists\nfn:zsh/datetime: \
			 error when adding parameter `EPOCHSECONDS'\n"
				.into(),
			0
		)
	);
	assert_eq!(
		zsh(
			"zmodload zsh/datetime; fn() { local EPOCHSECONDS=scrooble; zmodload -u zsh/datetime; \
			 print $EPOCHSECONDS; }; fn; print ${+EPOCHSECONDS}; EPOCHSECONDS=(a b); print -l \
			 $EPOCHSECONDS; zmodload zsh/datetime; echo st=$?; zmodload -lF zsh/datetime; unset \
			 EPOCHSECONDS; zmodload -F zsh/datetime p:EPOCHSECONDS; echo st=$?; print \
			 ${(t)EPOCHSECONDS}"
		),
		(
			concat!(
				"scrooble\n",
				"0\n",
				"a\n",
				"b\n",
				"st=2\n",
				"+b:strftime\n",
				"-p:EPOCHSECONDS\n",
				"+p:EPOCHREALTIME\n",
				"+p:epochtime\n",
				"st=0\n",
				"integer-readonly-hide-hideval-special\n",
			)
			.into(),
			"zsh:1: Can't add module parameter `EPOCHSECONDS': parameter already \
			 exists\nzsh:zsh/datetime:1: error when adding parameter `EPOCHSECONDS'\n"
				.into(),
			0
		)
	);
	assert_eq!(
		zsh(
			"print ${builtins[strftime]:-undefined}; zmodload -F zsh/datetime b:strftime; print \
			 ${builtins[strftime]:-undefined}; zmodload -F zsh/datetime -b:strftime; print \
			 ${builtins[strftime]:-undefined}"
		),
		("undefined\ndefined\nundefined\n".into(), String::new(), 0)
	);
}

#[test]
fn failed_autoload_of_unknown_features() {
	assert_eq!(
		zsh(
			"zmodload -aF zsh/parameter b:fail; whence -v fail; whence -w fail; fail; print not here"
		),
		(
			"fail is a shell builtin\nfail: builtin\n".into(),
			"zsh:1: module `zsh/parameter' has no such feature: `b:fail': autoload cancelled\nzsh:1: \
			 autoloading module zsh/parameter failed to define builtin: fail\n"
				.into(),
			1
		)
	);
	assert_eq!(
		zsh("zmodload -aF zsh/parameter p:fail; print $fail; print not here"),
		(
			String::new(),
			"zsh:1: module `zsh/parameter' has no such feature: `p:fail': autoload cancelled\nzsh:1: \
			 autoloading module zsh/parameter failed to define parameter: fail\n"
				.into(),
			1
		)
	);
}

#[test]
fn unset_module_parameters() {
	// zsh/parameter's specials stay `PM_UNSET` until assigned or re-added.
	assert_eq!(
		zsh(
			"zmodload zsh/parameter; unset options; echo $+options \"[${(t)options}]\"; \
			 options[xtrace]=off; echo $+options; zmodload -u zsh/parameter; zmodload zsh/parameter; \
			 echo $+options"
		),
		("0 []\n1\n1\n".into(), String::new(), 0)
	);
	// An unset of an autoloadable parameter removes the stub unloaded;
	// once loaded, a read-only one refuses.
	assert_eq!(
		zsh("unset builtins; echo st=$? $+builtins; zmodload zsh/parameter; unset builtins"),
		("st=0 0\n".into(), "zsh:1: read-only variable: builtins\n".into(), 1)
	);
	assert_eq!(
		zsh(
			"zmodload zsh/parameter; zmodload -u zsh/parameter; echo ${+options}; zmodload -e \
			 zsh/parameter; echo $?"
		),
		("1\n0\n".into(), String::new(), 0)
	);
}
