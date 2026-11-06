//! zsh/files, zsh/stat, zsh/attr and zsh/mapfile on the real filesystem,
//! through the obash binary run as `zsh -f -c SCRIPT` in a fresh temporary
//! directory. Expected output from `/bin/zsh -f -c SCRIPT` 5.9 in the same
//! setup (macOS); the user- and group-name checks compare with `/bin/zsh`
//! live, as names depend on the account running the tests.

#![cfg(unix)]

mod obash_support;

use std::{os::unix::process::CommandExt, path::Path, process::Command};

use crate::obash_support::{command, obash, output};

/// Run `script` as `zsh -f -c script` with `shell` in a new empty
/// directory: stdout, stderr, status.
fn run_in_tempdir(mut shell: Command, script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	let out = output(shell.current_dir(dir.path()).args(["-f", "-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

fn zsh(script: &str) -> (String, String, i32) {
	let mut cmd = obash();
	cmd.arg0("zsh");
	run_in_tempdir(cmd, script)
}

#[test]
fn zsh_mod_files_moves_links_modes_and_removes() {
	let (out, err, st) = zsh(
		"zmodload zsh/files zsh/stat
mkdir -p src/sub dst; print -n data > src/sub/f; print -n x > src/g
mv src/sub dst; print -l dst/*/*
mv src/g dst/sub/; print -l dst/sub/*
ln -s sub/f dst/link; zstat +link dst/link; zstat +mode dst/link; zstat +size dst/link
ln dst/sub/f hard; zstat +nlink hard
chmod 640 hard; zstat -s +mode dst/sub/f
chmod -R 700 dst; zstat -o +mode dst/sub dst/sub/g
rm -r dst; echo $?; print -l *
zstat +size hard nonexist; echo $?
zstat -rs +mode hard
rmdir src; echo $?; rmdir src; echo $?",
	);
	assert_eq!(
		out,
		"dst/sub/f\ndst/sub/f\ndst/sub/g\nsub/f\n33188\n4\n2\n-rw-r-----\ndst/sub 040700\ndst/sub/g \
		 0100700\n0\nhard\nsrc\nhard 4\n1\n33216 (-rwx------)\n0\n1\n"
	);
	assert_eq!(
		err,
		"zsh:zstat:10: nonexist: no such file or directory
zsh:rmdir:12: cannot remove directory `src': no such file or directory
"
	);
	assert_eq!(st, 0);
}

/// `zstat -s` names and `chown`/`chgrp` lookups go through the host's user
/// database: the same as `/bin/zsh` for whoever runs the tests.
#[test]
fn zsh_mod_files_owners_match_zsh() {
	let script = "zmodload zsh/files zsh/stat
print > f; zstat -s +uid f; zstat -s +gid f; zstat -sr +uid f
chown $UID f; echo $?; chown :$GID f; echo $?; chgrp $GID f; echo $?
chown $USERNAME: f; echo $?; chown -h $UID:$GID f; echo $?
chown nosuchuserxyz f; chgrp nosuchgroupxyz f; chown 4294967: f
chown -R $UID d; echo $?";
	let ours = zsh(script);
	assert_eq!(
		ours.1,
		"zsh:chown:5: nosuchuserxyz: no such user
zsh:chgrp:5: nosuchgroupxyz: no such group
zsh:chown:5: 4294967: no such user
zsh:chown:6: d: no such file or directory
"
	);
	if Path::new("/bin/zsh").exists() {
		assert_eq!(ours, run_in_tempdir(command("/bin/zsh"), script));
	}
}

#[test]
fn zsh_mod_files_mapfile_on_disk() {
	let (out, err, st) = zsh(
		"zmodload zsh/mapfile zsh/stat
umask 027; mapfile[f]=hello; zstat -o +mode f; print -r -- $mapfile[f]
mapfile[f]=; print -r -- $mapfile[f]; unset 'mapfile[f]'; print -l *(N)",
	);
	assert_eq!(out, "0100640\nhello\nhello\n\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

/// Extended attributes, macOS semantics (`-h`: `XATTR_NOFOLLOW`); the
/// system's own `com.apple.*` attributes are filtered out.
#[cfg(target_os = "macos")]
#[test]
fn zsh_mod_attr_extended_attributes() {
	let (out, err, st) = zsh(
		"zmodload zsh/attr zsh/stat
print > f; zsetattr f user.k val; echo $?; zgetattr f user.k; zgetattr f user.k v; print -r -- $v
zlistattr f l; print -l ${l:#com.apple.*}; zdelattr f user.k; echo $?; zgetattr f user.k; echo $?
ln -s f l2; zsetattr -h l2 user.s 1; echo $?; zlistattr -h l2 a; print -l ${a:#com.apple.*}; \
		 zlistattr l2 b; print -l x ${b:#com.apple.*}
zsetattr f user.e \"\"; zgetattr f user.e; echo $?; v=x; zgetattr f user.e v; echo ${+v}
zdelattr f user.e user.nope user.k; echo $?
zstat -L +mode l2; zstat -L -s +mode l2",
	);
	assert_eq!(out, "0\nval\nval\nuser.k\n0\n1\n0\nuser.s\nx\n0\n0\n1\n41453\nlrwxr-xr-x\n");
	assert_eq!(
		err,
		"zsh:zgetattr:3: f: attribute not found
zsh:zdelattr:6: f: attribute not found
"
	);
	assert_eq!(st, 0);
}
