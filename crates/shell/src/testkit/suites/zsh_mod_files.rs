//! zsh/files on the in-memory filesystem: `mkdir`, `rm`, `rmdir`, `mv`,
//! `ln`, `chmod`, `-i` questions and feature gating. Expected output from
//! `/bin/zsh -f -c SCRIPT` 5.9 run in an empty directory (each script's
//! first line here also changes to `/tmp`, keeping the line numbers).

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src` with `stdin`: stdout, stderr, status.
fn zsh_in(src: &str, stdin: &[u8]) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let host = FakeHost::new().with_fs(MemFs::new()).with_stdin(stdin);
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

fn zsh(src: &str) -> (String, String, i32) {
	zsh_in(src, b"")
}

#[test]
fn zsh_mod_files_mkdir() {
	let (out, err, st) = zsh(
		"cd /tmp; zmodload zsh/files zsh/stat
mkdir a; mkdir a; echo $?
mkdir -p a/b/c x/y/; echo $?
[[ -d a/b/c && -d x/y ]] && echo made
mkdir -m 7a8 q; echo $?
mkdir -m 700 m; zstat -o +mode m
mkdir -p f/g; print -n > h; mkdir -p h/i; echo $?
mkdir nope/x; echo $?",
	);
	assert_eq!(out, "1\n0\nmade\n1\n040700\n1\n1\n");
	assert_eq!(
		err,
		"zsh:mkdir:2: cannot make directory `a': file exists
zsh:mkdir:5: invalid mode `7a8'
zsh:mkdir:7: cannot make directory `h': file exists
zsh:mkdir:8: cannot make directory `nope/x': no such file or directory
"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_files_rm_and_rmdir() {
	let (out, err, st) = zsh(
		"cd /tmp; zmodload zsh/files
print -n x > f; rm f nope; echo $?
mkdir d; print -n > d/g; rm d; echo $?
rm -r d; echo $?; [[ -e d ]] || echo gone
rm -f nope; echo $?
mkdir e; rmdir e nope; echo $?
mkdir e; print > e/x; rmdir e; echo $?
mkdir -p t/u/v; print > t/u/v/w; print > t/z; rm -rf t; echo $? ${+t}; [[ -e t ]] || echo tgone",
	);
	assert_eq!(out, "1\n1\n0\ngone\n0\n1\n1\n0 0\ntgone\n");
	assert_eq!(
		err,
		"zsh:rm:2: nope: no such file or directory
zsh:rm:3: d: is a directory
zsh:rmdir:6: cannot remove directory `nope': no such file or directory
zsh:rmdir:7: cannot remove directory `e': directory not empty
"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_files_mv_ln_chmod() {
	let (out, err, st) = zsh(
		"cd /tmp; zmodload zsh/files zsh/stat
print -n a > f; mv f g; print -r -- $(<g)
mkdir d; mv g d; print -l d/*
mv d/g nope/x; echo $?
mv a b c; echo $?
mv nope zz; echo $?
ln d dd; echo $?
ln -s d/g l; zstat +link l; print -r -- $(<l)
ln -s d/g l; echo $?
ln -sf d/g l; echo $?
ln d/g h; print -r -- $(<h)
print -n > k; chmod 600 k; zstat -o +mode k
chmod u+x k; echo $?
chmod 755 nope k; echo $?; zstat -o +mode k
mkdir -p r/s; print > r/s/t; chmod -R 700 r; zstat -o +mode r/s/t
mv k d; print -l d/*
mv -f d/k .; print -l $PWD/*(:t)",
	);
	assert_eq!(
		out,
		concat!(
			"a\n",
			"d/g\n",
			"1\n",
			"1\n",
			"1\n",
			"1\n",
			"d/g\n",
			"a\n",
			"1\n",
			"0\n",
			"a\n",
			"0100600\n",
			"1\n",
			"1\n",
			"0100755\n",
			"0100700\n",
			"d/g\n",
			"d/k\n",
			"d\n",
			"h\n",
			"k\n",
			"l\n",
			"r\n",
		)
	);
	assert_eq!(
		err,
		"zsh:mv:4: `nope/x': no such file or directory
zsh:mv:5: last of many arguments must be a directory
zsh:mv:6: `nope': no such file or directory
zsh:ln:7: d: is a directory
zsh:ln:9: `d/g': file exists
zsh:chmod:13: invalid mode `u+x'
zsh:chmod:14: nope: no such file or directory
"
	);
	assert_eq!(st, 0);
}

/// `-i` asks on stderr and reads a line of stdin (`y`/`Y` agrees; end of
/// input declines), after the messages before the question.
#[test]
fn zsh_mod_files_interactive_questions() {
	let (out, err, _) = zsh_in(
		"cd /tmp; zmodload zsh/files; print > a; print > b; rm -i nope a b; echo $?; print -l \
		 $PWD/*(:t)",
		b"y\nn\n",
	);
	assert_eq!(out, "1\nb\n");
	assert_eq!(err, "zsh:rm:1: nope: no such file or directory\nrm: remove `a'? rm: remove `b'? ");
	let (out, err, _) = zsh_in(
		"cd /tmp; zmodload zsh/files; print > a; print > b; mv -i a b; echo $?; print -l \
		 $PWD/*(:t); ln -i a b; echo $?",
		b"n\n",
	);
	assert_eq!(out, "0\na\nb\n0\n");
	assert_eq!(err, "mv: replace `b'? ln: replace `b'? ");
}

/// Only the enabled features exist: `zmodload -F zsh/files b:zf_rm b:zf_mv`
/// gives `zf_rm` and `zf_mv`, not `rm` or `zf_mkdir` (oracle run with
/// `PATH=/nowhere`, as this host has no `rm` command).
#[test]
fn zsh_mod_files_feature_gating() {
	let (out, err, st) = zsh(
		"cd /tmp; zmodload -F zsh/files b:zf_rm b:zf_mv; print > a; zf_mv a b; zf_rm b; print -l \
		 $PWD/*(N:t); whence -w zf_rm zf_mv zf_mkdir rm",
	);
	assert_eq!(out, "\nzf_rm: builtin\nzf_mv: builtin\nzf_mkdir: none\nrm: none\n");
	assert_eq!(err, "");
	assert_eq!(st, 1);
}
