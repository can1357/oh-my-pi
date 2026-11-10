//! zsh/example (port of zsh 5.9 `Src/Modules/example.c`): the builtin,
//! its parameters, conditions and math functions, the load and unload
//! messages and the `GLOB_DOTS` wrapper. Expected output comes from
//! `/bin/zsh -f -c` 5.9.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src` on `host`: stdout, stderr, status.
fn zsh_on(host: FakeHost, src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

fn zsh(src: &str) -> (String, String, i32) {
	zsh_on(FakeHost::new(), src)
}

const SETUP: &str = "The example module has now been set up.\n";

#[test]
fn zsh_mod_example_builtin_shows_and_sets_its_parameters() {
	let (out, err, st) = zsh(
		"zmodload zsh/example; zmodload -lF zsh/example; example -flags a b; example -x; echo \
		 $exint $exstr $exarr; example q r; echo $exint $exstr $exarr",
	);
	assert_eq!(err, "zsh:example:1: bad option: -x\n");
	assert_eq!(
		out,
		format!(
			"{SETUP}{}",
			concat!(
				"+b:example\n",
				"+C:ex\n",
				"+c:len\n",
				"+f:length\n",
				"+f:sum\n",
				"+p:exarr\n",
				"+p:exint\n",
				"+p:exstr\n",
				"Options: afgls\n",
				"Arguments: a b\n",
				"Name: example\n",
				"\nInteger Parameter: 42\n",
				"String Parameter: example\n",
				"Array Parameter: example array\n",
				"2 a a b\n",
				"Options: \n",
				"Arguments: q r\n",
				"Name: example\n",
				"\nInteger Parameter: 2\n",
				"String Parameter: a\n",
				"Array Parameter: a b\n",
				"2 q q r\n",
			)
		)
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_example_parameters_assign_and_unset() {
	let (out, err, st) = zsh(
		"zmodload zsh/example; echo ${(t)exint} ${(t)exstr} ${(t)exarr}; exint=3+4; echo $exint; \
		 exarr=(x y); echo ${(t)exarr} $exarr; unset exstr; echo ${exstr-u}; example",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		format!(
			"{SETUP}integer scalar array\n7\narray x y\nu\nOptions: \nArguments:\nName: \
			 example\n\nInteger Parameter: 7\nString Parameter: \nArray Parameter: x y\n"
		)
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_example_messages_on_load_and_unload() {
	let (out, err, st) = zsh(
		"zmodload zsh/example; zmodload zsh/example; zmodload -u zsh/example; echo ${exint-gone}; \
		 example",
	);
	assert_eq!(err, "zsh:1: command not found: example\n");
	assert_eq!(
		out,
		format!("{SETUP}Thank you for using the example module.  Have a nice day.\ngone\n")
	);
	assert_eq!(st, 127);
	// Loading only the builtin still sets the module up.
	let (out, _, st) = zsh("zmodload -F zsh/example b:example; echo $?; echo ${exint-no}");
	assert_eq!((out, st), (format!("{SETUP}0\nno\n"), 0));
}

#[test]
fn zsh_mod_example_conditions() {
	let (out, err, st) = zsh(
		"zmodload zsh/example; [[ -len \"\" ]] && echo e0; [[ -len abc 3 ]] && echo l3; [[ -len abc \
		 1+1 ]] || echo n2; [[ ex -ex ample ]] && echo ex; [[ e -ex xample ]] || echo no",
	);
	assert_eq!(err, "");
	assert_eq!(out, format!("{SETUP}e0\nl3\nn2\nex\n"));
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_example_math_functions() {
	let (out, err, st) = zsh(
		"zmodload zsh/example; echo $(( length(abcd) )) $(( sum(1,2,3) )) $(( sum(1,2.5) )) $(( \
		 sum(1.5,2) ))",
	);
	assert_eq!(err, "");
	assert_eq!(out, format!("{SETUP}4 6 3.5 3.5\n"));
	assert_eq!(st, 0);
	let (out, err, st) = zsh("zmodload zsh/example; echo $(( sum() ))");
	assert_eq!(
		(out, err.as_str(), st),
		(SETUP.to_owned(), "zsh:1: wrong number of arguments: sum()\n", 1)
	);
	let (_, err, st) = zsh("echo $(( sum(2,3) ))");
	assert_eq!((err.as_str(), st), ("zsh:1: unknown function: sum\n", 1));
}

#[test]
fn zsh_mod_example_wrapper_sets_globdots_for_example_functions() {
	let host = FakeHost::new();
	host.fs.add_dir("/work");
	host.fs.add_file("/work/.a", b"", 0o644);
	host.fs.add_file("/work/b", b"", 0o644);
	let (out, err, st) = zsh_on(
		host,
		"zmodload zsh/example; f(){ echo /work/*; }; examplef(){ echo /work/*; }; f; examplef; f; \
		 [[ -o globdots ]] || echo off",
	);
	assert_eq!(err, "");
	assert_eq!(out, format!("{SETUP}/work/b\n/work/.a /work/b\n/work/b\noff\n"));
	assert_eq!(st, 0);
}
