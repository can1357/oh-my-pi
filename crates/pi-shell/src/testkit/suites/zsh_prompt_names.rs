//! zsh named directories (`hash -d`, `unhash -d`, `~name`, `$nameddirs`,
//! `$userdirs`, `${(D)…}`, `cd`/`dirs` output), prompt expansion
//! (`print -P`, `${(%)…}`, attributes for `TERM=xterm-256color` and
//! `TERM=dumb`), startup parameters and `disable`/`enable` of module
//! builtins. Expected output from `/bin/zsh -f -c` 5.9 run with
//! `env -i HOME=/tmp/pn/h PATH=/usr/bin:/bin TERM=…` over the same
//! directories.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// The user's directory bookmarks file (`~/.dotfiles/zsh/22-bookmarks.zsh`).
const BOOKMARKS: &str = r#"# Usage: cd ~w, cd ~dot, bml, bmj
[[ -n "$_BOOKMARKS_LOADED" ]] && return
_BOOKMARKS_LOADED=1

typeset -A BOOKMARKS=(
   dot     ~/.dotfiles
   dl      ~/Downloads
   cfg     ~/.config
)

# Register as named directories
for name loc in ${(kv)BOOKMARKS}; do
   hash -d $name=${~loc}
done

# List bookmarks
bml() {
   for name loc in ${(kv)BOOKMARKS}; do
      printf "~%-6s -> %s\n" "$name" "${~loc}"
   done | sort
}
"#;

/// Run `src` as `zsh -c src` with `TERM=term`, `HOME=/tmp/pn/h` and the
/// oracle's directories: stdout, stderr, status.
fn zsh_term(src: &str, term: &str) -> (String, String, i32) {
	let host = FakeHost::new();
	for d in [
		"/tmp/pn/h/proj/sub",
		"/tmp/pn/h/.dotfiles/zsh",
		"/tmp/pn/h/Downloads",
		"/tmp/pn/h/.config",
		"/tmp/pn/w",
	] {
		host.fs.add_dir(d);
	}
	host
		.fs
		.add_file("/tmp/pn/h/.dotfiles/zsh/22-bookmarks.zsh", BOOKMARKS.as_bytes(), 0o644);
	let mut init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	init.env.push(("HOME".into(), "/tmp/pn/h".into()));
	init.env.push(("TERM".into(), term.into()));
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// [`zsh_term`] with `TERM=dumb`.
fn zsh(src: &str) -> (String, String, i32) {
	zsh_term(src, "dumb")
}

#[test]
fn hash_d_lists_adds_and_removes() {
	let (out, err, st) = zsh(
		r#"hash -d foo=/tmp/pn/w bar=/tmp/pn/h/proj; hash -d; hash -dL; hash -dm "f*"; unhash -d foo; hash -d; echo $?"#,
	);
	assert_eq!(
		out,
		"bar=/tmp/pn/h/proj\nfoo=/tmp/pn/w\nhash -d bar=/tmp/pn/h/proj\nhash -d \
		 foo=/tmp/pn/w\nfoo=/tmp/pn/w\nbar=/tmp/pn/h/proj\n0\n"
	);
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn hash_d_errors() {
	let (out, err, st) = zsh(
		r#"hash -d "a b=/x"; echo $?; unhash -d nope; echo $?; hash -d nope; echo $?; hash -dv k=/l"#,
	);
	assert_eq!(out, "1\n1\n1\nk=/l\n");
	assert_eq!(
		err,
		"zsh:hash:1: invalid character in directory name: a b\nzsh:unhash:1: no such hash table \
		 element: nope\nzsh:hash:1: no such directory name: nope\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn tilde_names_expand_and_unknown_ones_fail() {
	let (out, err, st) = zsh("hash -d w=/tmp/pn/w; echo ~w ~w/x; echo ~nosuch; echo after");
	assert_eq!(out, "/tmp/pn/w /tmp/pn/w/x\n");
	assert_eq!(err, "zsh:1: no such user or named directory: nosuch\n");
	assert_eq!(st, 1);
}

#[test]
fn prompt_paths_use_the_longest_named_directory() {
	let (out, _, st) = zsh(
		r#"hash -d p=/tmp/pn/h/proj; cd /tmp/pn/h/proj/sub; print -P "%~ %/ %c %2~ %(2~.deep.shallow)"; cd /tmp/pn/h; print -P %~; x=/tmp/pn/h/proj/a\ b; echo ${(D)x} ${(D)HOME}; print -D /tmp/pn/h/proj/sub /tmp/pn/w"#,
	);
	assert_eq!(out, "~p/sub /tmp/pn/h/proj/sub sub ~p/sub deep\n~\n~p/a\\ b ~\n~p/sub /tmp/pn/w\n");
	assert_eq!(st, 0);
}

#[test]
fn dirs_abbreviates_named_directories() {
	let (out, _, st) = zsh(
		"cd /tmp/pn/h/proj; hash -d p=/tmp/pn/h/proj; dirs; pushd /tmp/pn/w; dirs; dirs -l; dirs -v",
	);
	assert_eq!(out, "~p\n/tmp/pn/w ~p\n/tmp/pn/w /tmp/pn/h/proj\n0\t/tmp/pn/w\n1\t~p\n");
	assert_eq!(st, 0);
}

#[test]
fn nameddirs_parameter_is_the_table() {
	let (out, err, st) = zsh(
		r#"nameddirs[b]=/var; nameddirs[a]=/usr; nameddirs[zz]=/opt; hash -d; echo ${(k)nameddirs}; unset "nameddirs[a]"; echo ${(kv)nameddirs}; userdirs[x]=1; echo no"#,
	);
	assert_eq!(out, "a=/usr\nb=/var\nzz=/opt\na b zz\nb /var zz /opt\n");
	assert_eq!(err, "zsh:1: read-only variable: userdirs\n");
	assert_eq!(st, 1);
}

#[test]
fn parameters_name_directories_only_interactively() {
	let (out, _, st) = zsh(
		"hash -d x=/tmp/pn/h/proj; foo=/tmp/pn/w; echo ~foo; hash -d; setopt autonamedirs; \
		 bar=/tmp/pn/w; hash -d",
	);
	assert_eq!(out, "/tmp/pn/w\nx=/tmp/pn/h/proj\nx=/tmp/pn/h/proj\n");
	assert_eq!(st, 0);
}

#[test]
fn percent_flag_expands_prompt_escapes() {
	let (out, _, st) = zsh(
		r#"cd /tmp/pn/h/proj; echo ${(%):-%~} "${(%):-%%x}" ${(%%):-a%#}; x="%F{red}r%f"; print -rn -- ${(%)x}"#,
	);
	assert_eq!(out, "~/proj %x a%\n\x1b[31mr\x1b[39m");
	assert_eq!(st, 0);
}

#[test]
fn attributes_for_xterm_256color() {
	let (out, _, st) = zsh_term(
		r#"print -P "%Bb%bx%Uu%us%Ss%sk%F{red}r%f%K{blue}b%k%F{123}n%f%F{#ff0000}t%f%F{#f00}t%E%{\e[1m%}%G"; print -P "%B%F{green}x%b%f"; print -P "%U"; print -P "%by""#,
		"xterm-256color",
	);
	assert_eq!(
		out,
		concat!(
			"\x1b[1mb\x1b[0mx\x1b[4mu\x1b[24ms\x1b[7ms\x1b[27mk\x1b[31mr\x1b[39m\x1b[44mb\x1b[49m",
			"\x1b[38;5;123mn\x1b[39m\x1b[38;2;255;0;0mt\x1b[39m\x1b[38;2;255;0;0mt\x1b[K\x1b[1m\n",
			"\x1b[1m\x1b[38;2;255;0;0m\x1b[32mx\x1b[0m\x1b[38;2;0;0;2m\x1b[39m\n",
			"\x1b[4m\n",
			"\x1b[0m\x1b[4my\n",
		)
	);
	assert_eq!(st, 0);
}

#[test]
fn attributes_for_dumb() {
	let (out, _, st) = zsh(
		r#"print -P "%Bb%bx%Uu%us%Ss%sk%F{red}r%f%K{blue}b%k%F{123}n%f%F{#ff0000}t%f%F{#f00}t%E%{\e[1m%}%G"; print -P "%B%F{green}x%b%f"; print -P "%U"; print -P "%by""#,
	);
	assert_eq!(
		out,
		concat!(
			"bxussk\x1b[31mr\x1b[39m\x1b[44mb\x1b[49m\x1b[3123mn\x1b[39m\x1b[38;2;255;0;",
			"0mt\x1b[39m\x1b[38;2;255;0;0mt\x1b[1m\n",
			"\x1b[32mx\x1b[39m\n",
			"\ny\n",
		)
	);
	assert_eq!(st, 0);
}

#[test]
fn bookmarks_file_registers_named_directories() {
	let (out, err, st) = zsh(
		"source ~/.dotfiles/zsh/22-bookmarks.zsh; echo st=$?; hash -d; cd ~/.dotfiles/zsh; print -P \
		 %~; cd ~dl; print -P '%~ %d'",
	);
	assert_eq!(
		out,
		concat!(
			"st=0\n",
			"cfg=/tmp/pn/h/.config\n",
			"dl=/tmp/pn/h/Downloads\n",
			"dot=/tmp/pn/h/.dotfiles\n",
			"~dot/zsh\n",
			"~dl /tmp/pn/h/Downloads\n",
		)
	);
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zsh_directory_name_hook_names_and_finds_directories() {
	let (out, err, st) = zsh(
		"zsh_directory_name() { if [[ $1 = n && $2 = foo ]]; then reply=(/tmp/pn/w); return 0; fi; \
		 if [[ $1 = d && $2 = /tmp/pn/w* ]]; then reply=(ww 9); return 0; fi; return 1; }; echo \
		 ~[foo]/x; cd /tmp/pn/w; print -P %~; echo ${(D)PWD}; echo ~[bar]; echo after",
	);
	assert_eq!(out, "/tmp/pn/w/x\n~[ww]\n~[ww]\n");
	assert_eq!(err, "zsh:1: no directory expansion: ~[bar]\n");
	assert_eq!(st, 1);
}

#[test]
fn bash_prompt_escapes() {
	// bash 5.3: `x='\u \h \l \# \D{%%} \08 \101 \q'; echo "${x@P}"` with
	// this host's user and name and no terminal on standard input.
	let init = ShellInit { mode: ModeId::Bash, ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let src = r"x='\u \h \l \# \D{%%} \08 \101 \q'; echo ${x@P}";
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
	assert_eq!(out, "tester testhost tty 1 % \\08 A \\q\n");
	assert_eq!(status, 0);
}

#[test]
fn startup_parameters() {
	let (out, _, st) = zsh(
		"typeset -p TIMEFMT MAILCHECK; echo ${signals[1]} ${signals[-2]} ${signals[-1]} $+HOST \
		 $+MACHTYPE $+VENDOR $+OSTYPE $+CPUTYPE $+TTY",
	);
	assert_eq!(
		out,
		"typeset TIMEFMT='%J  %U user %S system %P cpu %*E total'\ntypeset -i MAILCHECK=60\nEXIT \
		 ZERR DEBUG 1 1 1 1 1 1\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn module_builtins_can_be_disabled() {
	let (out, err, st) =
		zsh("disable log; echo $?; enable log; whence -w log; disable nosuch; echo $?");
	assert_eq!(out, "0\nlog: builtin\n1\n");
	assert_eq!(err, "zsh:disable:1: no such hash table element: nosuch\n");
	assert_eq!(st, 0);
}
