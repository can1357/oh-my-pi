//! zsh/stat on the in-memory filesystem (device 1, inode 0, times 0, owner
//! 0, block size 4096). The formats, option handling and messages are
//! zsh 5.9's (`/bin/zsh -f -c`, an epoch-dated file for the times); the
//! numbers are the in-memory file's.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init},
};

fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new().with_fs(MemFs::new()), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn zsh_mod_stat_lists_every_element() {
	let (out, err, st) = zsh("cd /tmp; zmodload zsh/stat; print -n hello > f; zstat f");
	assert_eq!(
		out,
		"device  1\ninode   0\nmode    33188\nnlink   1\nuid     0\ngid     0\nrdev    0\nsize    \
		 5\natime   0\nmtime   0\nctime   0\nblksize 4096\nblocks  1\nlink    \n"
	);
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_stat_strings_names_and_targets() {
	let (out, err, _) = zsh(
		"cd /tmp; zmodload zsh/stat zsh/files; print -n hello > f; print -n > g
zstat -g +mtime f; zstat -gr +mtime f
zstat -s +mode f; zstat -rso +mode f; zstat -s +uid f
zstat -A a -n +size f; print -l $a
zstat -H h +size f; print ${(kv)h}
zstat -t +size f; zstat -N +size f f; zstat +size f g
zstat -l; zstat -l -A c; print $c[3]
ln -s f l; zstat +link l; zstat -L +mode l; zstat +mode l",
	);
	assert_eq!(
		out,
		"Thu Jan  1  0:00:00 UTC 1970\n0 (Thu Jan  1  0:00:00 UTC 1970)\n-rw-r--r--\n0100644 \
		 (-rw-r--r--)\n0\nf\n5\nsize 5\nsize 5\n5\n5\nf 5\ng 0\ndevice inode mode nlink uid gid \
		 rdev size atime mtime ctime blksize blocks link\nmode\nf\n41453\n33188\n"
	);
	assert_eq!(err, "");
}

#[test]
fn zsh_mod_stat_reports_errors() {
	let (out, err, _) = zsh(
		"cd /tmp; zmodload zsh/stat; print > f
zstat +m f; echo $?; zstat +bogus f; zstat -x f; zstat nofile; zstat
zstat -f 0 -f; zstat -A; zstat -H h -A a f
zstat -A b f nofile; echo $? ${#b}",
	);
	assert_eq!(out, "1\n1 0\n");
	assert_eq!(
		err,
		"zsh:zstat:2: m: ambiguous stat element
zsh:zstat:2: bogus: no such stat element
zsh:zstat:2: bad option: -x
zsh:zstat:2: nofile: no such file or directory
zsh:zstat:2: no files given
zsh:zstat:3: missing file descriptor
zsh:zstat:3: missing parameter name
zsh:zstat:3: both array and hash requested
zsh:zstat:4: nofile: no such file or directory
"
	);
}
