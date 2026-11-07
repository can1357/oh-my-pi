//! `zcompile` on the in-memory host: its messages and statuses, the dumps
//! it writes (byte for byte zsh's, padding aside: see
//! `vm::zsh::zwc`), `-t` listings, `-a` from `$fpath`, and the loud
//! failure of `-c` on a loaded function. Expected output from
//! `/bin/zsh -f -c` 5.9 with the same files under `/tmp/zt` and
//! `/tmp/zcfix` (the fixtures of `testkit/fixtures/zcompile`).

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src` with the files `/tmp/zt/one.zsh` (`echo
/// one`), `/tmp/zt/bad.zsh` (an unclosed `if`), `/tmp/zt/bad.zwc` (`x`),
/// `/tmp/zt/fn/g` (`echo g`) and `/tmp/zcfix/simple.zsh` (the fixture):
/// stdout, stderr, status and the host.
fn zsh_on(src: &str) -> (String, String, i32, Rig) {
	let host = FakeHost::new();
	host.fs.add_dir("/tmp/zt/fn");
	host.fs.add_dir("/tmp/zcfix");
	host.fs.add_file("/tmp/zt/one.zsh", b"echo one\n", 0o644);
	host
		.fs
		.add_file("/tmp/zt/bad.zsh", b"echo hi\nif foo; then\n", 0o644);
	host.fs.add_file("/tmp/zt/bad.zwc", b"x", 0o644);
	host.fs.add_file("/tmp/zt/fn/g", b"echo g\n", 0o644);
	host.fs.add_file("/tmp/zcfix/simple.zsh", SIMPLE_ZSH, 0o644);
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
	let err = String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned();
	(out, err, status, rig)
}

/// [`zsh_on`] without the host.
fn zsh(src: &str) -> (String, String, i32) {
	let (out, err, st, _) = zsh_on(src);
	(out, err, st)
}

const SIMPLE_ZSH: &[u8] = include_bytes!("../fixtures/zcompile/simple.zsh");
const SIMPLE_ZWC: &[u8] = include_bytes!("../fixtures/zcompile/simple.zwc");

#[test]
fn zcompile_usage_errors() {
	for (src, msg) in [
		("zcompile", "too few arguments"),
		("zcompile -t", "too few arguments"),
		("zcompile -kz x", "illegal combination of options"),
		("zcompile -m x", "illegal combination of options"),
		("zcompile -RM x", "illegal combination of options"),
		("zcompile -cU x", "illegal combination of options"),
		("zcompile /tmp/zt/nope", "can't open file: /tmp/zt/nope"),
		("zcompile /tmp/zt/out /tmp/zt", "can't open file: /tmp/zt"),
		("zcompile -t /tmp/zt/nope", "can't open zwc file: /tmp/zt/nope.zwc"),
		("zcompile -t /tmp/zt/bad", "invalid zwc file: /tmp/zt/bad.zwc"),
		("zcompile -c /tmp/zt/out", "no functions"),
		("f() { :; }; zcompile -a /tmp/zt/out f", "function is already loaded: f"),
		("autoload -U g; zcompile -c /tmp/zt/out g", "function is not loaded: g"),
		("zcompile -c /tmp/zt/out nofunc", "unknown function: nofunc"),
	] {
		let (out, err, st) = zsh(src);
		assert_eq!(out, "", "{src}");
		assert_eq!(err, format!("zsh:zcompile:1: {msg}\n"), "{src}");
		assert_eq!(st, 1, "{src}");
	}
}

#[test]
fn zcompile_syntax_error_is_reported_at_the_files_line_and_writes_nothing() {
	let (out, err, st) = zsh(
		"zcompile /tmp/zt/bad.zsh; print $?; [[ -e /tmp/zt/bad.zsh.zwc ]] && print exists || print \
		 gone",
	);
	assert_eq!(out, "1\ngone\n");
	assert_eq!(
		err,
		"zsh:3: parse error near `\\n'\nzsh:zcompile:1: can't read file: /tmp/zt/bad.zsh\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zcompile_missing_input_removes_the_dump() {
	let (out, err, _) = zsh(
		"zcompile /tmp/zt/out /tmp/zt/one.zsh; print $?
zcompile /tmp/zt/out /tmp/zt/one.zsh /tmp/zt/nope; print $?
[[ -e /tmp/zt/out.zwc ]] && print exists || print gone",
	);
	assert_eq!(out, "0\n1\ngone\n");
	assert_eq!(err, "zsh:zcompile:2: can't open file: /tmp/zt/nope\n");
}

#[test]
fn zcompile_lists_and_finds_names() {
	let (out, err, st) = zsh(
		"zcompile /tmp/zt/one.zsh && zcompile -t /tmp/zt/one.zsh.zwc && zcompile -t /tmp/zt/one.zsh \
		 one.zsh; print $?; zcompile -t /tmp/zt/one.zsh nope; print $?",
	);
	assert_eq!(out, "zwc file (read) for zsh-5.9\n/tmp/zt/one.zsh\n0\n1\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zcompile_digest_with_load_style_switches() {
	let (out, err, st) = zsh(
		"zcompile /tmp/zt/out.zwc /tmp/zt/one.zsh -k /tmp/zt/one.zsh -z /tmp/zt/fn/g && zcompile -t \
		 /tmp/zt/out",
	);
	assert_eq!(out, "zwc file (read) for zsh-5.9\n/tmp/zt/one.zsh\n/tmp/zt/one.zsh\n/tmp/zt/fn/g\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zcompile_a_compiles_an_autoload_function_from_fpath() {
	let (out, err, st) = zsh(
		"fpath=(/tmp/zt/fn); autoload g; zcompile -a /tmp/zt/out.zwc g && zcompile -t /tmp/zt/out",
	);
	assert_eq!(out, "zwc file (read) for zsh-5.9\ng\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zcompile_writes_zshs_dump() {
	let (out, err, st, rig) =
		zsh_on("zcompile -R /tmp/zcfix/simple.zsh.zwc /tmp/zcfix/simple.zsh; print $?");
	assert_eq!((out.as_str(), err.as_str(), st), ("0\n", "", 0));
	let got = rig
		.host
		.fs
		.read("/tmp/zcfix/simple.zsh.zwc")
		.expect("the dump");
	assert!(got == SIMPLE_ZWC, "the dump differs from zsh's");
}

/// zsh writes the word code it keeps for a loaded function; the engine
/// keeps none, so `-c` fails loudly and writes nothing.
#[test]
fn zcompile_c_of_a_loaded_function_is_unsupported() {
	let (out, err, st) = zsh(
		"f() { :; }; zcompile -c /tmp/zt/out f; print $?; [[ -e /tmp/zt/out.zwc ]] || print none",
	);
	assert_eq!(out, "1\nnone\n");
	assert!(err.contains("not supported by this engine yet"), "{err}");
	assert_eq!(st, 0);
}
