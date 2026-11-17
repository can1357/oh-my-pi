//! `zcompile` through the obash binary run as `zsh`, against `/bin/zsh`
//! 5.9 itself: every file of a corpus compiled by both gives the same dump
//! (padding aside: zsh writes heap garbage after each program's strings)
//! or the same failure, messages included. The corpus is zsh's own
//! `Functions` and `Completion` trees (`$PI_ZSH_SRC`, default
//! `/work/.ref/zsh-5.9`) and the `*.zsh`/`*.zsh-theme` files of
//! `~/powerlevel10k` and `~/.oh-my-zsh`, whichever exist. Every test is
//! skipped (passes without checking) when `/bin/zsh` is not zsh 5.9.

#![cfg(unix)]

mod obash_support;

use std::{
	fs,
	os::unix::process::CommandExt,
	path::{Path, PathBuf},
	process::Command,
	time::Duration,
};

use crate::obash_support::{command, finish, obash};

/// Whether `/bin/zsh` is the oracle.
fn have_zsh() -> bool {
	let Ok(out) = Command::new("/bin/zsh").arg("--version").output() else {
		return false;
	};
	String::from_utf8_lossy(&out.stdout).starts_with("zsh 5.9 ")
}

/// A scratch directory of its own.
fn scratch(tag: &str) -> PathBuf {
	let dir = std::env::temp_dir().join(format!("pi-zcompile-{tag}-{}", std::process::id()));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(&dir).unwrap();
	dir
}

/// Run `script` with `args` as `zsh -f -c script zsh args…` under the real
/// zsh (`real`) or obash: stdout, stderr, status.
fn run(real: bool, script: &str, args: &[String]) -> (String, String, i32) {
	let mut cmd = if real {
		command("/bin/zsh")
	} else {
		let mut c = obash();
		c.arg0("zsh");
		c
	};
	cmd.args(["-f", "-c", script, "zsh"]).args(args);
	let out = finish(cmd.spawn().unwrap(), Duration::from_secs(600));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// A dump with the padding after each program's strings zeroed, in both
/// halves (the first in the host's byte order, the other swapped).
fn masked(mut b: Vec<u8>) -> Vec<u8> {
	if b.len() < 52 {
		return b;
	}
	let other = usize::from(b[5]) | (usize::from(b[6]) << 8) | (usize::from(b[7]) << 16);
	for (off, swap) in [(0, false), (other, true)] {
		let word = |b: &[u8], i: usize| -> usize {
			let at = off + 4 * i;
			let Some(c) = b.get(at..at + 4) else { return 0 };
			let w = u32::from_ne_bytes([c[0], c[1], c[2], c[3]]);
			(if swap { w.swap_bytes() } else { w }) as usize
		};
		let hlen = word(&b, 12);
		let mut at = 12;
		while at < hlen {
			let (start, len, head) = (word(&b, at), word(&b, at + 1), word(&b, at + 4));
			let base = off + start * 4;
			for i in base + len..base + len.div_ceil(4) * 4 {
				if let Some(x) = b.get_mut(i) {
					*x = 0;
				}
			}
			if head == 0 {
				break;
			}
			at += head;
		}
	}
	b
}

/// The corpus files that exist here.
fn corpus() -> Vec<String> {
	fn walk(dir: &Path, keep: &dyn Fn(&Path) -> bool, out: &mut Vec<String>) {
		let Ok(entries) = fs::read_dir(dir) else {
			return;
		};
		let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
		entries.sort();
		for p in entries {
			if p.is_dir() {
				walk(&p, keep, out);
			} else if p.is_file() && keep(&p) {
				out.push(p.to_string_lossy().into_owned());
			}
		}
	}
	let src = std::env::var("PI_ZSH_SRC").unwrap_or_else(|_| "/work/.ref/zsh-5.9".into());
	let mut files = Vec::new();
	for sub in ["Functions", "Completion"] {
		walk(&Path::new(&src).join(sub), &|_| true, &mut files);
	}
	if let Some(home) = std::env::var_os("HOME") {
		let shell_file = |p: &Path| {
			p.extension()
				.is_some_and(|e| e == "zsh" || e == "zsh-theme")
		};
		for sub in ["powerlevel10k", ".oh-my-zsh"] {
			walk(&Path::new(&home).join(sub), &shell_file, &mut files);
		}
	}
	files
}

/// Compiles each of `$@` into `$OUT/N.zwc` (`N` counting from 1) with
/// `zcompile $FLAGS`, its stderr in `$OUT/N.err`, printing `N status`.
/// zsh's two built-in aliases (`run-help`, `which-command`) are removed
/// first: aliases are expanded at compile time, and these compare the
/// compiler, not the alias table.
const COMPILE_ALL: &str = r#"unalias run-help which-command 2>/dev/null
out=$OUT; i=0
for f in "$@"; do
  i=$((i+1))
  zcompile ${=FLAGS} $out/$i.zwc $f 2>$out/$i.err
  print -r -- "$i $?"
done"#;

/// Compile `files` with both shells under `flags`; the differences.
fn differences(tag: &str, flags: &str, files: &[String]) -> Vec<String> {
	let mut diffs = Vec::new();
	let dirs = [scratch(&format!("{tag}-real")), scratch(&format!("{tag}-ours"))];
	for chunk in files.chunks(200) {
		let mut outs = Vec::new();
		for (real, dir) in [(true, &dirs[0]), (false, &dirs[1])] {
			let script = format!("OUT={} FLAGS='{flags}'\n{COMPILE_ALL}", dir.display());
			let (out, err, st) = run(real, &script, chunk);
			assert_eq!((err.as_str(), st), ("", 0), "{} driver", if real { "zsh" } else { "obash" });
			outs.push(out);
		}
		for (i, file) in chunk.iter().enumerate() {
			let n = i + 1;
			let read = |d: &Path, ext: &str| fs::read(d.join(format!("{n}.{ext}"))).ok();
			let status = |out: &str| {
				out.lines()
					.find_map(|l| l.strip_prefix(&format!("{n} ")).map(str::to_owned))
			};
			let (st_real, st_ours) = (status(&outs[0]), status(&outs[1]));
			let (err_real, err_ours) = (read(&dirs[0], "err"), read(&dirs[1], "err"));
			let (zwc_real, zwc_ours) = (read(&dirs[0], "zwc"), read(&dirs[1], "zwc"));
			if st_real != st_ours || err_real != err_ours {
				diffs.push(format!(
					"{file}: zsh status {st_real:?} stderr {:?}; obash status {st_ours:?} stderr {:?}",
					err_real.map(|e| String::from_utf8_lossy(&e).into_owned()),
					err_ours.map(|e| String::from_utf8_lossy(&e).into_owned()),
				));
			} else if zwc_real.map(masked) != zwc_ours.map(masked) {
				diffs.push(format!("{file}: the dumps differ"));
			}
			for d in &dirs {
				let _ = fs::remove_file(d.join(format!("{n}.zwc")));
				let _ = fs::remove_file(d.join(format!("{n}.err")));
			}
		}
	}
	for d in &dirs {
		let _ = fs::remove_dir_all(d);
	}
	diffs
}

fn assert_none(diffs: &[String]) {
	assert!(
		diffs.is_empty(),
		"{} files differ:\n{}",
		diffs.len(),
		diffs
			.iter()
			.take(40)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
}

/// Every corpus file, with `-R` (the user's `.zshrc` and powerlevel10k
/// compile so).
#[test]
fn zcompile_corpus_matches_zsh() {
	if !have_zsh() {
		return;
	}
	let files = corpus();
	assert_none(&differences("corpus", "-R", &files));
}

/// The load and map switches on a few corpus files: the flag bits of the
/// header and the entries.
#[test]
fn zcompile_switches_match_zsh() {
	if !have_zsh() {
		return;
	}
	let files: Vec<String> = corpus().into_iter().step_by(97).collect();
	for flags in ["", "-U", "-M", "-k", "-z", "-Uz -M"] {
		assert_none(&differences(&format!("flags{}", flags.len()), flags, &files));
	}
}

/// One digest of several files with the in-list `-k`/`-z` switches, and
/// its `-t` listing.
#[test]
fn zcompile_digest_and_listing_match_zsh() {
	if !have_zsh() {
		return;
	}
	let files: Vec<String> = corpus().into_iter().step_by(131).take(12).collect();
	let mut outs = Vec::new();
	for real in [true, false] {
		let dir = scratch(if real { "digest-real" } else { "digest-ours" });
		let script = format!(
			r#"unalias run-help which-command 2>/dev/null; d={}/all.zwc
zcompile $d $1 -k $2 $3 -z ${{@[4,-1]}}; print $?
zcompile -t $d; print $?
zcompile -t $d ${{1:t}} ${{2:t}}; print $?
zcompile -t $d ${{1:t}} nope; print $?"#,
			dir.display()
		);
		let (out, err, st) = run(real, &script, &files);
		let dump = fs::read(dir.join("all.zwc")).ok().map(masked);
		let _ = fs::remove_dir_all(&dir);
		outs.push((out, err, st, dump));
	}
	let ours = &outs[1];
	let real = &outs[0];
	assert_eq!((&ours.0, &ours.1, ours.2), (&real.0, &real.1, real.2));
	assert!(ours.3 == real.3, "the digests differ");
}

/// `zcompile -t` lists a dump zsh wrote, and finds its names.
#[test]
fn zcompile_lists_dumps_zsh_wrote() {
	if !have_zsh() {
		return;
	}
	let files: Vec<String> = corpus().into_iter().step_by(211).take(5).collect();
	let dir = scratch("list");
	let d = dir.join("x.zwc").display().to_string();
	let (_, err, st) = run(true, &format!("zcompile -M {d} \"$@\""), &files);
	assert_eq!((err.as_str(), st), ("", 0));
	let script = format!(
		"zcompile -t {d}; print $?; zcompile -t {d} ${{1:t}}; print $?; zcompile -t {d} nope; print \
		 $?"
	);
	let real = run(true, &script, &files);
	let ours = run(false, &script, &files);
	let _ = fs::remove_dir_all(&dir);
	assert_eq!(ours, real);
}

/// A function found only in a digest (`DIR.zwc` beside `$fpath`'s `DIR`,
/// or a digest named in `$fpath`): zsh autoloads its word code, the engine
/// fails loudly.
#[test]
fn zcompile_digest_only_autoload_fails_loudly() {
	if !have_zsh() {
		return;
	}
	let dir = scratch("autoload");
	fs::create_dir_all(dir.join("fn")).unwrap();
	let script = "cd $1; zcompile $1/fn.zwc $1/fn/g; rm fn/g
fpath=($1/fn); autoload g; g; print st=$?
unfunction g; fpath=($1/fn.zwc); autoload g; g; print st=$?";
	let mut outs = Vec::new();
	for real in [true, false] {
		fs::write(dir.join("fn/g"), "echo from-g\n").unwrap();
		let _ = fs::remove_file(dir.join("fn.zwc"));
		outs.push(run(real, script, &[dir.display().to_string()]));
	}
	let _ = fs::remove_dir_all(&dir);
	assert_eq!(outs[0].0, "from-g\nst=0\nfrom-g\nst=0\n");
	assert_eq!(outs[1].0, "st=1\nst=1\n");
	assert_eq!(
		outs[1]
			.1
			.matches("not supported by this engine yet")
			.count(),
		2,
		"{}",
		outs[1].1
	);
}

/// `source ./x` when only `x.zwc` exists: zsh runs the word code, the
/// engine (which runs source text) fails loudly; with the source file
/// present both run it.
#[test]
fn zcompile_source_prefers_text_and_refuses_word_code_alone() {
	if !have_zsh() {
		return;
	}
	let dir = scratch("source");
	fs::write(dir.join("x"), "print sourced\n").unwrap();
	let script = "cd $1; zcompile x && source ./x; rm -f x; source ./x; print st=$?";
	let real = run(true, script, &[dir.display().to_string()]);
	fs::write(dir.join("x"), "print sourced\n").unwrap();
	let _ = fs::remove_file(dir.join("x.zwc"));
	let (out, err, _) = run(false, script, &[dir.display().to_string()]);
	let _ = fs::remove_dir_all(&dir);
	assert_eq!(real.0, "sourced\nsourced\nst=0\n");
	assert_eq!(out, "sourced\nst=1\n");
	assert!(err.contains("x.zwc") && err.contains("not supported by this engine yet"), "{err}");
}
