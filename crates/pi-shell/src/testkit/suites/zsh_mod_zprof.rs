//! zsh/zprof (port of zsh 5.9 `Src/Modules/zprof.c`): the call hooks and
//! the `zprof` listing. Times depend on the clock, so listings are
//! compared with every time and percentage masked (`#`), runs of spaces
//! squeezed, and, where the order depends on the times, the entry
//! numbers masked and the lines compared as a multiset. Expected output
//! comes from `/bin/zsh -f -c` 5.9 piped through the same masking.

use regex::Regex;

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

/// The listing with times masked and spaces squeezed.
fn mask(s: &str) -> String {
	let times = Regex::new(r"[0-9]+\.[0-9]+|nan|-?inf").unwrap();
	let spaces = Regex::new(r" +").unwrap();
	spaces
		.replace_all(&times.replace_all(s, "#"), " ")
		.into_owned()
}

const RULE: &str =
	"-----------------------------------------------------------------------------------";

#[test]
fn zsh_mod_zprof_header_and_errors() {
	let (out, err, st) = zsh("zmodload zsh/zprof; zmodload -lF zsh/zprof; zprof; echo $?");
	assert_eq!(err, "");
	assert_eq!(
		out,
		format!(
			"+b:zprof\nnum  calls                time                       self            \
			 name\n{RULE}\n0\n"
		)
	);
	assert_eq!(st, 0);
	let (_, err, st) = zsh("zmodload zsh/zprof; zprof x");
	assert_eq!((err.as_str(), st), ("zsh:zprof:1: too many arguments\n", 1));
	// Not loaded: no builtin, no profiling.
	let (_, err, st) = zsh("f() { :; }; f; zprof");
	assert_eq!((err.as_str(), st), ("zsh:1: command not found: zprof\n", 127));
}

#[test]
fn zsh_mod_zprof_counts_calls_of_one_function() {
	let (out, err, st) = zsh("zmodload zsh/zprof; f() { :; }; f; f; zprof");
	assert_eq!(err, "");
	assert_eq!(
		mask(&out),
		format!(
			"num calls time self name\n{RULE}\n 1) 2 # # #% # # #% f\n\n{RULE}\n\n 1) 2 # # #% # # \
			 #% f\n"
		)
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_zprof_lists_callers_and_callees() {
	let (out, err, st) = zsh("zmodload zsh/zprof; f() { g; g }; g() { :; }; f; f; zprof");
	assert_eq!(err, "");
	assert_eq!(st, 0);
	let num = Regex::new(r"^ ?[0-9]+\)").unwrap();
	let idx = Regex::new(r"\[[0-9]+\]").unwrap();
	let mut lines: Vec<String> = mask(&out)
		.lines()
		.map(|l| {
			idx.replace_all(&num.replace_all(l, "N)"), "[N]")
				.into_owned()
		})
		.collect();
	lines.sort();
	let mut want: Vec<String> = [
		"",
		"",
		"",
		"",
		RULE,
		RULE,
		RULE,
		" 4/4 # # #% # # f [N]",
		" 4/4 # # #% # # g [N]",
		"N) 2 # # #% # # #% f",
		"N) 2 # # #% # # #% f",
		"N) 4 # # #% # # #% g",
		"N) 4 # # #% # # #% g",
		"num calls time self name",
	]
	.iter()
	.map(|s| (*s).to_owned())
	.collect();
	want.sort();
	assert_eq!(lines, want);
}

/// The listing masked with entry numbers masked too, as a sorted multiset
/// of lines.
fn masked_lines(out: &str) -> Vec<String> {
	let num = Regex::new(r"^ ?[0-9]+\)").unwrap();
	let idx = Regex::new(r"\[[0-9]+\]$").unwrap();
	let mut lines: Vec<String> = mask(out)
		.lines()
		.map(|l| {
			idx.replace_all(&num.replace_all(l, "N)"), "[N]")
				.into_owned()
		})
		.collect();
	lines.sort();
	lines
}

fn sorted(lines: &[&str]) -> Vec<String> {
	let mut v: Vec<String> = lines.iter().map(|s| (*s).to_owned()).collect();
	v.sort();
	v
}

#[test]
fn zsh_mod_zprof_names_anonymous_functions_by_file_and_line() {
	let (out, err, st) = zsh("zmodload zsh/zprof; () { :; }; () { :; }\n() { :; }; zprof");
	assert_eq!(err, "");
	assert_eq!(st, 0);
	assert_eq!(
		masked_lines(&out),
		sorted(&[
			"",
			"",
			"",
			"",
			RULE,
			RULE,
			RULE,
			"N) 2 # # #% # # #% (anon) [zsh:1]",
			"N) 2 # # #% # # #% (anon) [zsh:1]",
			"N) 1 # # #% # # #% (anon) [zsh:2]",
			"N) 1 # # #% # # #% (anon) [zsh:2]",
			"num calls time self name",
		])
	);
	// A `-c` string is `zsh`'s whatever `$0` is, functions defined in it
	// too (`exec -a /x/myzsh zsh -f -c …`).
	let init = ShellInit { mode: ModeId::Zsh, argv0: "/x/myzsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let st = rig.run(
		Script::command(b"zmodload zsh/zprof; f() { () { :; } }; f; zprof".to_vec()),
		Fault::None,
	);
	assert_eq!(st, 0);
	let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
	assert!(out.contains("  (anon) [zsh:1]\n"), "{out}");
	// In a sourced file: the file as given, the definition's line.
	let host = FakeHost::new();
	host.fs.add_dir("/src");
	host
		.fs
		.add_file("/src/anon.zsh", b"f() { () { :; } }\n\n() { :; }\nf\n", 0o644);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let st = rig.run(
		Script::command(b"zmodload zsh/zprof; source /src/anon.zsh; zprof".to_vec()),
		Fault::None,
	);
	assert_eq!(String::from_utf8_lossy(&rig.host.stderr.bytes()), "");
	assert_eq!(st, 0);
	let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
	assert_eq!(
		masked_lines(&out),
		sorted(&[
			"",
			"",
			"",
			"",
			"",
			"",
			RULE,
			RULE,
			RULE,
			RULE,
			" 1/1 # # #% # # (anon) [/src/anon.zsh:1] [N]",
			" 1/1 # # #% # # f [N]",
			"N) 1 # # #% # # #% f",
			"N) 1 # # #% # # #% f",
			"N) 1 # # #% # # #% (anon) [/src/anon.zsh:3]",
			"N) 1 # # #% # # #% (anon) [/src/anon.zsh:3]",
			"N) 1 # # #% # # #% (anon) [/src/anon.zsh:1]",
			"N) 1 # # #% # # #% (anon) [/src/anon.zsh:1]",
			"num calls time self name",
		])
	);
}

#[test]
fn zsh_mod_zprof_clear_and_unload() {
	let (out, err, st) = zsh(
		"zmodload zsh/zprof; f() { :; }; f; zprof -c; zprof; zmodload -u zsh/zprof; f; zmodload \
		 zsh/zprof; zprof",
	);
	assert_eq!(err, "");
	let header = format!(
		"num  calls                time                       self            name\n{RULE}\n"
	);
	assert_eq!(out, format!("{header}{header}"));
	assert_eq!(st, 0);
}
