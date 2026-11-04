//! zsh/mapfile on the in-memory filesystem. Expected output from
//! `/bin/zsh -f -c SCRIPT` 5.9 run in an empty directory (the first line
//! here also changes to `/tmp`, which starts empty).

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src` on `fs`: stdout, stderr, status.
fn zsh(fs: MemFs, src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new().with_fs(fs), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn zsh_mod_mapfile_reads_writes_and_removes_files() {
	let fs = MemFs::new();
	let (out, err, st) = zsh(
		fs.clone(),
		"cd /tmp; zmodload zsh/mapfile
mapfile[f]=$'a\\nb'; print -r -- \"${mapfile[f]}\"
print ${+mapfile[nope]} ${+mapfile[f]}
mapfile[f]+=c; print -r -- \"$mapfile[f]\"
unset \"mapfile[f]\"; print ${+mapfile[f]}
mapfile=(x 1 y 2); print -l ${(ko)mapfile}; print -r -- $mapfile[x]$mapfile[y]
print ${(t)mapfile}
mapfile[x]=; print -r -- $mapfile[x]
zmodload -u zsh/mapfile; print -r -- ${(t)mapfile}.",
	);
	assert_eq!(out, "a\nb\n0 1\na\nbc\n0\nx\ny\n12\nassociation-hide-hideval-special\n1\n.\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
	assert_eq!(fs.read("/tmp/x").as_deref(), Some(&b"1"[..]));
	assert_eq!(fs.read("/tmp/f"), None);
}

/// `unset mapfile` leaves the special unset (empty, no type) until an
/// assignment, which still writes the file, sets it again; removing an
/// element of the unset special still removes the file; unloading the
/// module forgets it.
#[test]
fn zsh_mod_mapfile_unset_special() {
	let fs = MemFs::new();
	fs.add_file("/tmp/f1", b"abc", 0o644);
	let (out, err, st) = zsh(
		fs.clone(),
		"cd /tmp; zmodload zsh/mapfile
unset mapfile; echo $?; print -r -- \"[${(t)mapfile}]\" ${#mapfile} ${+mapfile} ${+mapfile[f1]} \
		 \"[${mapfile[f1]}]\"
mapfile[mfx]=hello; print -r -- $mapfile[mfx]; print -r -- \"[${(t)mapfile}]\" ${#mapfile} \
		 ${mapfile[f1]}
unset mapfile; unset \"mapfile[f1]\"; echo $?; print -l $PWD/*(:t); print -r -- \"[${(t)mapfile}]\"
mapfile=(a 1); print -r -- \"[${(t)mapfile}]\" $mapfile[a]
unset mapfile; zmodload -u zsh/mapfile; zmodload zsh/mapfile; print -r -- \"[${(t)mapfile}]\" \
		 ${#mapfile}",
	);
	assert_eq!(
		out,
		"0\n[] 0 0 0 []\nhello\n[association-hide-hideval-special] 2 \
		 abc\n0\nmfx\n[]\n[association-hide-hideval-special] 1\n[association-hide-hideval-special] \
		 2\n"
	);
	assert_eq!(err, "");
	assert_eq!(st, 0);
	assert_eq!(fs.read("/tmp/f1"), None);
}

/// An empty file reads as unset (zsh maps it, and a zero-length map
/// fails); without the module `mapfile` is an ordinary name.
#[test]
fn zsh_mod_mapfile_empty_files_and_absent_module() {
	let fs = MemFs::new();
	fs.add_file("/tmp/e", b"", 0o644);
	fs.add_file("/tmp/t", b"text", 0o644);
	let (out, err, _) = zsh(
		fs.clone(),
		"cd /tmp; print ${+mapfile[t]}; zmodload zsh/mapfile; print ${+mapfile[e]} ${mapfile[t]}",
	);
	assert_eq!(out, "0\n0 text\n");
	assert_eq!(err, "");
}
