//! zsh/computil's builtins (`comptags`, `comptry`, `compdescribe`,
//! `compquote`, `compfiles`, `compgroups`) run inside a completion widget
//! of `obash` invoked as `zsh -f -i`, against the real `/bin/zsh -f -i`
//! on the same pty session: the final screens must match.
//!
//! Each case defines a completion function in the rc file that runs the
//! builtin and keeps what it set in globals, binds it as a `zle -C`
//! widget to `^T`, types a command line and `^T`, kills the line and
//! prints the globals. The end-to-end cases drive compsys (`compinit`).

#![cfg(unix)]

mod pty_support;

use std::{fs, io, path::Path, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(60);
/// How long output must stay quiet before the screen is read (completion
/// functions print nothing while they work).
const QUIET: Duration = Duration::from_millis(1500);
/// How long sourcing the rc file (`compinit`) may take.
const RC_TIMEOUT: Duration = Duration::from_secs(120);

/// `zsh -f -i` with a plain prompt and the rc file `rc`, in `cwd`.
fn spawn(real: bool, rc: &str, cwd: &Path) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	s.args(["-f", "-i"])
		.env("PS1", "%# ")
		.rc_file(".zshrc", rc)
		.size(24, 80)
		.cwd(cwd)
}

/// Type `text` key by key.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

/// Run `drive` against both shells in `cwd` after sourcing the rc file;
/// panic when the final screens differ.
fn same_in(cwd: &Path, rc: &str, drive: impl Fn(&mut Pty) -> io::Result<()>) {
	let run = |pty: &mut Pty| -> io::Result<()> {
		pty.settle(QUIET, TIMEOUT)?;
		// `compinit` prints nothing while it works: wait for the marker
		// (the echoed command line has it quoted apart).
		pty.write(". ~/.zshrc; print -r -- RC''DONE\r")?;
		pty.read_until("RCDONE", RC_TIMEOUT)?;
		pty.settle(QUIET, TIMEOUT)?;
		keys(pty, "\x0c")?;
		drive(pty)
	};
	if !have_real_zsh() {
		let mut ours = spawn(false, rc, cwd).spawn().expect("spawn obash");
		run(&mut ours).expect("pty session");
		return;
	}
	match differential(spawn(false, rc, cwd), spawn(true, rc, cwd), run) {
		Ok((ours, real)) => {
			assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
		},
		Err(e) => panic!("pty session failed: {e}"),
	}
}

/// [`same_in`] in a fresh empty directory.
fn same(rc: &str, drive: impl Fn(&mut Pty) -> io::Result<()>) {
	let dir = tempdir();
	same_in(&dir, rc, drive);
}

/// A fresh directory under the system temp dir.
fn tempdir() -> std::path::PathBuf {
	use std::sync::atomic::{AtomicU32, Ordering};
	static N: AtomicU32 = AtomicU32::new(0);
	let d = std::env::temp_dir().join(format!(
		"computil-pty-{}-{}",
		std::process::id(),
		N.fetch_add(1, Ordering::Relaxed)
	));
	let _ = fs::remove_dir_all(&d);
	fs::create_dir_all(&d).expect("temp dir");
	d
}

/// An rc file binding `^T` to the completion function `_t` with `body`.
fn widget(body: &str) -> String {
	format!("_t() {{\n{body}\n}}\nzle -C t complete-word _t\nbindkey '^T' t\n")
}

/// Type `line`, run the widget, kill the line and print `out`.
fn complete_then_print(line: &str) -> impl Fn(&mut Pty) -> io::Result<()> + '_ {
	move |pty| {
		keys(pty, line)?;
		keys(pty, "\x14")?;
		keys(pty, "\x15print -rl -- \"${out[@]}\"\r")
	}
}

#[test]
fn builtins_refuse_outside_completion() {
	same("", |pty| {
		keys(
			pty,
			"comptags -i x a; comptry a; compdescribe -i a b; compquote x; compfiles -p a; \
			 compgroups g; comparguments -i x; compvalues -i x; echo $?\r",
		)
	});
}

#[test]
fn comptags_and_comptry_sets() {
	let rc = widget(
		"out=()\n\
		 comptags -i ctx a b c d e:lbl\n\
		 comptry a b x\n\
		 comptry -s c d\n\
		 comptry a\n\
		 comptags -T; out+=(T$?)\n\
		 comptags -C cc; out+=($cc)\n\
		 while comptags -N; do comptags -S s; out+=(\"${(j:,:)s}\"); comptags -R a; out+=(R$?); done\n\
		 out+=(N$?)\n\
		 comptags -T; out+=(T$?)",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn comptags_a_walks_labels() {
	let rc = widget(
		"out=()\n\
		 comptags -i ctx files opts\n\
		 comptry files files:-local:local\\ files files:globbed:desc opts\n\
		 comptags -N\n\
		 while comptags -A files t d; do out+=(\"$t|$d\"); done\n\
		 out+=(A$?)\n\
		 comptags -A opts t; out+=(\"$t\" $?)",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn comptry_m_patterns_and_braces() {
	let rc = widget(
		"out=()\n\
		 comptags -i ctx alpha beta gamma delta alpine\n\
		 comptry -m 'al* {g,d}*:lab' 'beta'\n\
		 comptags -N; comptags -S s; out+=(\"${(j:,:)s}\")\n\
		 comptags -N; comptags -S s; out+=(\"${(j:,:)s}\" $?)",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn comptags_errors() {
	let rc = widget(
		"out=()\n\
		 comptags -x; out+=($?)\n\
		 comptags -Q a; out+=($?)\n\
		 comptags -N; out+=($?)\n\
		 comptry a; out+=($?)\n\
		 comptags -i ctx a\n\
		 comptags -C; out+=($?)\n\
		 comptags -C a b; out+=($?)\n\
		 comptags -i-; out+=($?)",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn compdescribe_descriptions() {
	let rc = widget(
		"out=()\n\
		 local -a a m o\n\
		 a=('foo:first thing' 'bar:second thing' baz 'qu\\:x:has colon')\n\
		 o=(-J grp -X expl)\n\
		 compdescribe -I '' 30 ' -- ' o a\n\
		 while compdescribe -g csl opts mats dpys; do\n\
		   out+=(\"$csl|${(j:,:)opts}|${(j:,:)mats}|${(j:,:)dpys}\")\n\
		 done\n\
		 out+=(G$?)",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn compdescribe_groups_same_descriptions() {
	let rc = widget(
		"out=()\n\
		 local -a a b o\n\
		 a=('-a:all things' '--all:all things' '-b:brief' '-c:all things' -d)\n\
		 b=(x1 x2 x3 x4 x5)\n\
		 o=(-V opts)\n\
		 compdescribe -I '' 40 ' -- ' o -g a b -q\n\
		 while compdescribe -g csl opts mats dpys; do\n\
		   out+=(\"$csl|${(j:,:)opts}|${(j:,:)mats}|${(j:,:)dpys}\")\n\
		 done",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn compdescribe_plain_and_errors() {
	let rc = widget(
		"out=()\n\
		 compdescribe -i '' 20 '(a b:c x\\,y)' -- -X foo\n\
		 compdescribe -g csl opts mats dpys; out+=(\"$?|$csl|${(j:,:)opts}|${(j:,:)mats}|${(j:,:)dpys}\")\n\
		 compdescribe -g csl opts mats dpys; out+=($?)\n\
		 compdescribe -g a b; out+=($?)\n\
		 compdescribe -i x; out+=($?)\n\
		 compdescribe -i '' 20 nosuch; out+=($?)\n\
		 compdescribe -z a b c; out+=($?)",
	);
	same(&rc, complete_then_print("foo "));
}

#[test]
fn compquote_follows_the_quoting() {
	let rc = widget(
		"a='x y$z'; b=('a b' \"c'd\" '=e f'); c=$a; d=(\"${b[@]}\")\n\
		 compquote a b; compquote -p c d; compquote nosuch\n\
		 integer i=3; compquote i\n\
		 out=(\"$a\" \"${b[@]}\" \"$c\" \"${d[@]}\")",
	);
	same(&rc, |pty| {
		for line in ["foo ", "foo 'x", "foo \"x", "foo $'x"] {
			keys(pty, line)?;
			keys(pty, "\x14")?;
			keys(pty, "\x15print -rl -- \"${out[@]}\"\r")?;
		}
		Ok(())
	});
}

#[test]
fn compfiles_patterns_and_others() {
	let dir = tempdir();
	for d in ["sub", "sub/deep", "other"] {
		fs::create_dir_all(dir.join(d)).expect("mkdir");
	}
	for f in ["ab.c", "ab.h", ".hidden", "sub/x.c"] {
		fs::write(dir.join(f), "").expect("write");
	}
	let rc = widget(
		"out=()\n\
		 local -a n acc fake\n\
		 n=(''); compfiles -p n acc '' '' '' fake '*.c' '*'; out+=(\"${(j:,:)n}\")\n\
		 n=(''); compfiles -P n acc '' '' '' fake; out+=(\"${(j:,:)n}\")\n\
		 n=(''); compfiles -p- n acc '' '' yes fake '*'; out+=(\"${(j:,:)n}\")\n\
		 acc=(true); n=(''); compfiles -p n acc '' '' '' fake '*'; out+=(\"${(j:,:)n}\")\n\
		 acc=(); fake=('.:fake1 fake\\ 2'); n=(.); compfiles -p n acc / '' .. fake '*'; out+=(\"${(j:,:)n}\")\n\
		 n=(sub/a sub/b other/c); compfiles -r n sub/x; out+=($? \"${(j:,:)n}\")\n\
		 n=(sub/a other/c); compfiles -r n x; out+=($? \"${(j:,:)n}\")\n\
		 n=(a a); compfiles -r n x; out+=($?)\n\
		 local -a ign; n=($PWD/sub/deep/.. $PWD $PWD/other); compfiles -i n ign 'parent pwd' $PWD/; out+=(\"${(j:,:)ign}\")\n\
		 compfiles -q n; out+=($?); compfiles -p n; out+=($?); compfiles x; out+=($?)",
	);
	same_in(&dir, &rc, |pty| {
		for line in ["ls ab", "ls .h", "ls a\\*"] {
			keys(pty, line)?;
			keys(pty, "\x14")?;
			keys(pty, "\x15print -rl -- \"${out[@]}\"\r")?;
		}
		Ok(())
	});
}

#[test]
fn compgroups_orders_groups() {
	let rc = widget(
		"compgroups one two\n\
		 compadd -J two zz yy\n\
		 compadd -V one bb aa\n\
		 compadd -J one cc",
	);
	same(&rc, |pty| keys(pty, "foo \x14\x14"));
}

// ---- compsys end to end ----------------------------------------------------

/// The rc file of the compsys cases.
const COMPINIT: &str = "autoload -U compinit\ncompinit -u -D\n";

#[test]
fn compsys_describe_lists_git_subcommands() {
	same(COMPINIT, |pty| keys(pty, "git \t"));
}

#[test]
fn compsys_ls_long_options() {
	same(COMPINIT, |pty| keys(pty, "ls --\t"));
}

#[test]
fn compsys_tar_options() {
	same(COMPINIT, |pty| keys(pty, "tar -\t"));
}

#[test]
fn compsys_ssh_hosts_and_options() {
	same(COMPINIT, |pty| {
		keys(pty, "ssh \t")?;
		keys(pty, "\x15ssh -\t")
	});
}

#[test]
fn compsys_kill_signals() {
	same(COMPINIT, |pty| keys(pty, "kill -\t"));
}

#[test]
fn compsys_kill_processes() {
	// A fixed process list: the real one differs between the two shells.
	let rc = format!(
		"{COMPINIT}zstyle ':completion:*:*:kill:*:processes' command \
		 'print -l \"  PID TTY TIME CMD\" \"  101 ttys001 0:00.01 alpha -x\" \"  202 ttys002 0:01.00 beta\"'\n"
	);
	same(&rc, |pty| {
		keys(pty, "kill \t")?;
		keys(pty, "\t")
	});
}

/// Complete `line` with compsys in a directory with files and
/// directories, groups and descriptions shown.
fn files_case(line: &'static str) {
	let dir = tempdir();
	for d in ["dir1", "dir2", ".hid"] {
		fs::create_dir_all(dir.join(d)).expect("mkdir");
	}
	for f in ["file1", "file2", "dir1/inner", "dir1/other", "x.c", "y.h"] {
		fs::write(dir.join(f), "").expect("write");
	}
	let rc = format!(
		"{COMPINIT}zstyle ':completion:*' group-name ''\n\
		 zstyle ':completion:*:descriptions' format '-- %d --'\n"
	);
	same_in(&dir, &rc, move |pty| keys(pty, line));
}

#[test]
fn compsys_files_list() {
	files_case("ls \t");
}

#[test]
fn compsys_directories_for_cd() {
	files_case("cd \t");
}

#[test]
fn compsys_files_in_a_subdirectory() {
	files_case("ls dir1/\t");
}

#[test]
fn compsys_files_with_a_glob_pattern() {
	files_case("cc \t");
}

#[test]
fn compsys_hidden_files() {
	files_case("ls .\t");
}
