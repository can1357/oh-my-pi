//! zsh/compctl's completion (`zsh -f` Tab without compsys) in `obash`
//! invoked as `zsh -f -i`, against the real `/bin/zsh -f -i` on the same
//! pty session: same rc file, same keys, the final screens must match.
//!
//! Each case works in a fixture directory with a few files, directories
//! and commands (`$PATH` is only its `bin`), so the listings are the same
//! for both shells.

#![cfg(unix)]

mod pty_support;

use std::{
	fs, io,
	os::unix::fs::PermissionsExt,
	path::{Path, PathBuf},
	time::Duration,
};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(80);
/// How long output must stay quiet before the screen is read.
const QUIET: Duration = Duration::from_millis(400);

/// The fixture directory of test `name`: files `file1`, `file2`,
/// `other.c`, `.hidden`, directories `dir1`, `dir2/sub`, commands
/// `bin/zzfoo`, `bin/zzbar`, `bin/zzbaz`.
fn fixture(name: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!("pi-compctl-{}-{name}", std::process::id()));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(dir.join("dir2/sub")).expect("fixture");
	fs::create_dir_all(dir.join("dir1")).expect("fixture");
	fs::create_dir_all(dir.join("bin")).expect("fixture");
	for f in ["file1", "file2", "other.c", ".hidden"] {
		fs::write(dir.join(f), b"x\n").expect("fixture");
	}
	for c in ["zzfoo", "zzbar", "zzbaz"] {
		let p = dir.join("bin").join(c);
		fs::write(&p, b"#!/bin/sh\n").expect("fixture");
		fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).expect("fixture");
	}
	dir
}

/// `zsh -f -i` with a fixed prompt, started in `dir`, `$PATH` its `bin`.
fn spawn(real: bool, dir: &Path, rc: &str) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	let rc = format!("PATH={}/bin\n{rc}", dir.display());
	s.args(["-f", "-i"])
		.env("PS1", "%# ")
		.env("RPS1", "[%?]")
		.cwd(dir)
		.rc_file(".zshrc", rc)
		.size(24, 80)
}

/// Type `text` key by key.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

/// Both shells, rc sourced and screen cleared, then `drive`: the screens
/// must be the same.
fn same(name: &str, rc: &str, drive: &str) {
	let dir = fixture(name);
	let run = |pty: &mut Pty| -> io::Result<()> {
		pty.settle(QUIET, TIMEOUT)?;
		keys(pty, ". ~/.zshrc\r")?;
		keys(pty, "\x0c")?;
		keys(pty, drive)
	};
	let result = if have_real_zsh() {
		differential(spawn(false, &dir, rc), spawn(true, &dir, rc), run).map(|(o, r)| (o, Some(r)))
	} else {
		spawn(false, &dir, rc).spawn().and_then(|mut p| {
			run(&mut p)?;
			Ok((p.screen().contents(), None))
		})
	};
	let _ = fs::remove_dir_all(&dir);
	let (ours, real) = match result {
		Ok(s) => s,
		Err(e) => panic!("pty session failed: {e}"),
	};
	if let Some(real) = real {
		assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
	}
}

#[test]
fn command_name_unique_and_listed() {
	same("cmd", "", "zzf\t\x15zzb\t\x15zz\t");
}

#[test]
fn file_names_and_directories() {
	same("files", "", "cat fi\tx \x15cat d\t\x15cat dir2/\t\x15cat .\t");
}

#[test]
fn parameter_names() {
	same("param", "ZZONE=1 ZZTWO=2 ZZTHREE=3", "echo $ZZO\t \x15echo $ZZT\t\x15echo ${ZZT\t");
}

#[test]
fn tilde_named_directories() {
	same("tilde", "hash -d zzdir=/tmp zzother=/", "echo ~zzd\t\x15echo ~zz\t");
}

#[test]
fn cd_completes_directories() {
	same("cd", "compctl -/ cd", "cd \t\x15cd di\t");
}

#[test]
fn keyword_list_and_function() {
	same(
		"keys",
		"compctl -k '(alpha beta gamma)' zzk\nzzfn() { reply=(red green \"$1|$2\") }\ncompctl -K \
		 zzfn zzc",
		"zzk \t\x15zzk g\t\x15zzc gr\t\x15zzc \t",
	);
}

#[test]
fn extended_conditions() {
	same(
		"ext",
		"compctl -x 'p[1]' -k '(one two)' - 'p[2]' -k '(three four)' - 's[-]' -k '(-a -b)' -- zzx",
		"zzx \t\x15zzx one \t\x15zzx -\t",
	);
}

#[test]
fn compcall_from_a_completion_widget() {
	same(
		"compcall",
		"compctl -k '(aa ab ac)' zzw\nzzwf() { compcall }\nzle -C zzcomp complete-word \
		 zzwf\nbindkey '^X^T' zzcomp",
		"zzw a\x18\x14",
	);
}

#[test]
fn menu_completion_cycles() {
	same(
		"menu",
		"compctl -k '(alpha alpine also)' zzm\nbindkey '^I' menu-complete",
		"zzm al\t\t\t\t",
	);
}

#[test]
fn default_and_first_compctls() {
	same(
		"special",
		"compctl -D -k '(dflt1 dflt2)'\ncompctl -T -x 'p[1]' -k '(first1)' --",
		"unknowncmd \t\x15unknowncmd x \t",
	);
}
