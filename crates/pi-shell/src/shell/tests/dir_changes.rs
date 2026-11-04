//! `cd`, `pushd`, `popd` and `dirs` change directory, fail and report as
//! Bash does.

use super::held_cwd::assert_as_bash;

/// Every way `cd`, `pushd` and `popd` change directory or fail to, with
/// `CDPATH`, `cdable_vars`, `-L`/`-P`, POSIX mode, readonly `PWD` and
/// `OLDPWD`, and a working directory that was moved or removed. Each row's
/// output is the one GNU Bash 5.3 prints for the same script, run as a
/// script (5.2.21 prints the same but for 13 rows, where 5.3 changed:
/// `cd ""` is `cd: null directory`, `CDPATH` applies to `$HOME` and `$OLDPWD`,
/// two directories are status 2, and `cd`'s usage line). The rows that
/// create `locked` need a directory the user may not search.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn directory_changes_fail_as_bash_reports_them() {
	let rows: &[(&str, &str, &str, bool)] = &[
		(
			r"missing",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd /nonexistent/BOOM; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: /nonexistent/BOOM: No such file or directory
S=1
",
			false,
		),
		(
			r"missing, relative",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd nosuch; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: nosuch: No such file or directory
S=1
",
			false,
		),
		(
			r"a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd file; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: file: Not a directory
S=1
",
			false,
		),
		(
			r"below a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd file/x; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: file/x: Not a directory
S=1
",
			false,
		),
		(
			r"no search permission",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd locked; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"cd: locked: Permission denied
S=1
STAYED
",
			true,
		),
		(
			r"below no search permission",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd locked/inner; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: locked/inner: Permission denied
S=1
",
			true,
		),
		(
			r"two directories",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd d d; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"cd: too many arguments
S=2
STAYED
",
			false,
		),
		(
			r"two after -",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd d; cd - -; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: too many arguments
S=2
",
			false,
		),
		(
			r"OLDPWD unset",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset OLDPWD; cd -; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: OLDPWD not set
S=1
",
			false,
		),
		(
			r"OLDPWD missing",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; OLDPWD=/nonexistent/old; cd -; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: /nonexistent/old: No such file or directory
S=1
",
			false,
		),
		(
			r"HOME unset",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset HOME; cd; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: HOME not set
S=1
",
			false,
		),
		(
			r"HOME missing",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; HOME=/nonexistent/home; cd; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: /nonexistent/home: No such file or directory
S=1
",
			false,
		),
		(
			r"CDPATH misses",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=/tmp; cd nosuch; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: nosuch: No such file or directory
S=1
",
			false,
		),
		(
			r"CDPATH finds and prints",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=$top/d; cd sub >"$top/out"; echo "S=$?"; [ "$(cat "$top/out")" = "$top/d/sub" ] && echo PRINTED; [ "$PWD" = "$top/d/sub" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"S=0
PRINTED
IN
",
			false,
		),
		(
			r"CDPATH relative entry prints the absolute name",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=./d; cd sub >"$top/out"; echo "S=$?"; [ "$(cat "$top/out")" = "$top/d/sub" ] && echo PRINTED; cd "$top"; chmod 755 locked"#,
			r"S=0
PRINTED
",
			false,
		),
		(
			r"CDPATH empty entry is quiet",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=:$top/d; cd d >"$top/out"; echo "S=$? out=<$(cat "$top/out")>"; [ "$PWD" = "$top/d" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"S=0 out=<>
IN
",
			false,
		),
		(
			r"CDPATH skips a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir c2; : >c2/sub; CDPATH=$top/c2:$top/d; cd sub >/dev/null; echo "S=$?"; [ "$PWD" = "$top/d/sub" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"S=0
IN
",
			false,
		),
		(
			r"CDPATH falls back to the directory itself",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=/nonexistent; cd d; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"S=0
IN
",
			false,
		),
		(
			r"CDPATH is not searched for ./",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=$top/d; cd ./sub; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: ./sub: No such file or directory
S=1
",
			false,
		),
		(
			r"an empty directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd ""; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1
STAYED
",
			false,
		),
		(
			r"an unknown option",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd -x; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: -x: invalid option
cd: usage: cd [-L|[-P [-e]]] [-@] [dir]
S=2
",
			false,
		),
		(
			r"an unknown option after a known one",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd -Lx d; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: -x: invalid option
cd: usage: cd [-L|[-P [-e]]] [-@] [dir]
S=2
",
			false,
		),
		(
			r"-- then -",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd d; cd -- - >/dev/null; echo "S=$?"; [ "$PWD" = "$top" ] && echo BACK; cd "$top"; chmod 755 locked"#,
			r"S=0
BACK
",
			false,
		),
		(
			r"- prints",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd d; cd - >"$top/out"; echo "S=$?"; [ "$(cat "$top/out")" = "$top" ] && echo PRINTED; cd "$top"; chmod 755 locked"#,
			r"S=0
PRINTED
",
			false,
		),
		(
			r"a name too long",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: File name too long
S=1
",
			false,
		),
		(
			r"a loop of links",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; ln -s l2 l1; ln -s l1 l2; cd l1; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: l1: Too many levels of symbolic links
S=1
",
			false,
		),
		(
			r"a loop of links, -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; ln -s l2 l1; ln -s l1 l2; cd -P l1; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: l1: Too many levels of symbolic links
S=1
",
			false,
		),
		(
			r"a second failure",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd nosuch; cd nosuch2 && echo no; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: nosuch: No such file or directory
cd: nosuch2: No such file or directory
S=1
",
			false,
		),
		(
			r"pushd, missing",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; pushd /nonexistent/BOOM; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"pushd: /nonexistent/BOOM: No such file or directory
S=1
",
			false,
		),
		(
			r"pushd, a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; pushd file; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"pushd: file: Not a directory
S=1
",
			false,
		),
		(
			r"pushd, no search permission",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; pushd locked; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"pushd: locked: Permission denied
S=1
STAYED
",
			true,
		),
		(
			r"popd, a removed directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; pushd gone >/dev/null; pushd "$top" >/dev/null; rmdir "$top/gone"; popd 2>"$top/err"; echo "S=$?"; case "$(cat "$top/err")" in *"popd: $top/gone: No such file or directory") echo NAMED;; esac; dirs | wc -w | tr -d " "; cd "$top"; chmod 755 locked"#,
			r"S=1
NAMED
3
",
			false,
		),
		(
			r"popd, an empty stack",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; popd; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"popd: directory stack empty
S=1
",
			false,
		),
		(
			r"HOME is looked for in CDPATH",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; HOME=sub; CDPATH=d; cd; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"T/d/sub
S=0
",
			false,
		),
		(
			r"OLDPWD is looked for in CDPATH",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; OLDPWD=sub; CDPATH=d; cd -; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"T/d/sub
S=0
",
			false,
		),
		(
			r"- prints OLDPWD as written",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; OLDPWD=d; cd -; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"d
S=0
IN
",
			false,
		),
		(
			r"an empty directory leaves OLDPWD unset",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset OLDPWD; cd ""; echo "S=$?"; [ "$OLDPWD" = "$top" ] && echo OLDPWD-SET; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1
",
			false,
		),
		(
			r"an empty HOME sets OLDPWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset OLDPWD; HOME=; cd; echo "S=$?"; [ "$OLDPWD" = "$top" ] && echo OLDPWD-SET; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"S=0
OLDPWD-SET
STAYED
",
			false,
		),
		(
			r"an empty directory is refused before CDPATH",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=$top/d; cd "" >"$top/out"; echo "S=$?"; [ "$(cat "$top/out")" = "$top/d" ] && echo PRINTED; [ "$PWD" = "$top/d" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1
",
			false,
		),
		(
			r"CDPATH under -P prints the entry's spelling",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=link; cd -P sub; echo "S=$?"; [ "$PWD" = "$top/d/sub" ] && echo PHYSICAL; cd "$top"; chmod 755 locked"#,
			r"link/sub
S=0
PHYSICAL
",
			false,
		),
		(
			r"CDPATH under -P, an entry ending in /",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=link/; cd -P sub; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"link/sub
S=0
",
			false,
		),
		(
			r"CDPATH under set -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; set -P; CDPATH=link; cd sub; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"link/sub
S=0
",
			false,
		),
		(
			r"CDPATH prints the logical directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=link; cd sub >"$top/out"; echo "S=$?"; [ "$(cat "$top/out")" = "$top/link/sub" ] && echo LOGICAL; cd "$top"; chmod 755 locked"#,
			r"S=0
LOGICAL
",
			false,
		),
		(
			r"-L overrides set -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; set -P; cd -L link; echo "S=$?"; [ "$PWD" = "$top/link" ] && echo LOGICAL; cd "$top"; chmod 755 locked"#,
			r"S=0
LOGICAL
",
			false,
		),
		(
			r"set -P resolves links",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; set -P; cd link; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo PHYSICAL; cd "$top"; chmod 755 locked"#,
			r"S=0
PHYSICAL
",
			false,
		),
		(
			r"the last of -P and -L wins",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd -P -L link; echo "S=$?"; [ "$PWD" = "$top/link" ] && echo LOGICAL; cd "$top"; chmod 755 locked"#,
			r"S=0
LOGICAL
",
			false,
		),
		(
			r"cdable_vars",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; shopt -s cdable_vars; aa=d; cd aa; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"d
S=0
IN
",
			false,
		),
		(
			r"cdable_vars, a value that is no directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; shopt -s cdable_vars; aa=nosuch; cd aa; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: aa: No such file or directory
S=1
",
			false,
		),
		(
			r"cdable_vars, a directory comes first",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; shopt -s cdable_vars; d=sub; cd d; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo DIR; cd "$top"; chmod 755 locked"#,
			r"S=0
DIR
",
			false,
		),
		(
			r"no cdable_vars",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; aa=d; cd aa; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: aa: No such file or directory
S=1
",
			false,
		),
		(
			r"pushd under set -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; set -P; pushd link >/dev/null; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo PHYSICAL; cd "$top"; chmod 755 locked"#,
			r"S=0
PHYSICAL
",
			false,
		),
		(
			r"popd under set -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; set -P; pushd -n link >/dev/null; popd >/dev/null; echo "S=$?"; [ "$PWD" = "$top/d" ] && echo PHYSICAL; cd "$top"; chmod 755 locked"#,
			r"S=0
PHYSICAL
",
			false,
		),
		(
			r"a removed directory, cd .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd .; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/.> OLDPWD=</gone>
",
			false,
		),
		(
			r"a removed directory, cd ./.",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ./.; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/./.> OLDPWD=</gone>
",
			false,
		),
		(
			r"a removed directory, cd -P .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd -P .; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/.> OLDPWD=</gone>
",
			false,
		),
		(
			r"a removed directory, cd -P -e .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd -P -e .; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=</gone/.> OLDPWD=</gone>
",
			false,
		),
		(
			r"a removed directory, cd -e . (logical)",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd -e .; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/.> OLDPWD=</gone>
",
			false,
		),
		(
			r#"a removed directory, cd """#,
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ""; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1 PWD=</gone> OLDPWD=<>
",
			false,
		),
		(
			r"a removed directory, its own name",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd "$PWD" 2>/dev/null; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"S=1
",
			false,
		),
		(
			r"a removed directory, cd ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=<>
",
			false,
		),
		(
			r"a removed directory, pushd .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; pushd . >/dev/null; echo "S=$? PWD=<${PWD#$top}> n=$(dirs -p | wc -l)"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/.> n=2
",
			false,
		),
		(
			r"a removed directory, a name with a component",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd -P missing/../../d; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: missing/../../d: No such file or directory
S=1 PWD=</gone> OLDPWD=<>
",
			false,
		),
		(
			r"a removed directory, a name through a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd "$top/file/../d" 2>"$top/err"; s=$?; case "$(cat "$top/err")" in *"cd: $top/file/../d: Not a directory") echo NAMED;; esac; echo "S=$s PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"NAMED
S=1 PWD=</gone> OLDPWD=<>
",
			false,
		),
		(
			r"a removed directory, a missing name",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd nosuch; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: nosuch: No such file or directory
S=1 PWD=</gone> OLDPWD=<>
",
			false,
		),
		(
			r"a removed directory, . twice",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd .; cd .; echo "PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; pwd | sed "s#$top##"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
PWD=</gone/./.> OLDPWD=</gone/.>
/gone/./.
",
			false,
		),
		(
			r"a removed directory, . then a name",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd .; cd d; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<${OLDPWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
cd: d: No such file or directory
S=1 PWD=</gone/.> OLDPWD=</gone>
",
			false,
		),
		(
			r"a removed directory, . then ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd .; cd ..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=<>
",
			false,
		),
		(
			r"a removed directory, ../.. from below",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd ../..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=<>
",
			false,
		),
		(
			r"an empty CDPATH entry with an empty directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p c; CDPATH=:c; cd "" >"$top/out"; echo "S=$? out=<$(cat "$top/out")>"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1 out=<>
STAYED
",
			false,
		),
		(
			r"a CDPATH of one empty entry",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=:; cd ""; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1
STAYED
",
			false,
		),
		(
			r"a CDPATH entry with an empty directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; CDPATH=$top/d; cd "" >"$top/out"; echo "S=$?"; [ "$(cat "$top/out")" = "$top/d" ] && echo PRINTED; [ "$PWD" = "$top/d" ] && echo IN; cd "$top"; chmod 755 locked"#,
			r"cd: null directory
S=1
",
			false,
		),
		(
			r"cdable_vars with an empty value",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset OLDPWD; shopt -s cdable_vars; aa=; cd aa; echo "S=$?"; [ "$PWD" = "$top" ] && echo STAYED; [ "$OLDPWD" = "$top" ] && echo OLDPWD-SET; cd "$top"; chmod 755 locked"#,
			r"
S=0
STAYED
OLDPWD-SET
",
			false,
		),
		(
			r"cdable_vars printing its value",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; shopt -s cdable_vars; aa=d; cd aa >"$top/out"; echo "S=$?"; cat "$top/out"; cd "$top"; chmod 755 locked"#,
			r"S=0
d
",
			false,
		),
		(
			r"cdable_vars with a missing directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; shopt -s cdable_vars; aa=nosuch; cd aa; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: aa: No such file or directory
S=1
",
			false,
		),
		(
			r"cdable_vars naming a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; shopt -s cdable_vars; aa=file; cd aa; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: aa: Not a directory
S=1
",
			false,
		),
		(
			r"a removed directory through a symbolic link, cd -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p real/parent/gone; ln -s real/parent via; cd via/gone; rmdir "$top/real/parent/gone"; cd -P ../..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</real>
",
			false,
		),
		(
			r"a removed directory through a symbolic link, cd -L",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p real/parent/gone; ln -s real/parent via; cd via/gone; rmdir "$top/real/parent/gone"; cd -L ../..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</real>
",
			false,
		),
		(
			r"a removed directory through a symbolic link, one up",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p real/parent/gone; ln -s real/parent via; cd via/gone; rmdir "$top/real/parent/gone"; cd ..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</real/parent>
",
			false,
		),
		(
			r"a removed directory, a name after ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd -P ../d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</d>
",
			false,
		),
		(
			r"a removed directory, a name after .. logically",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ../d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</d>
",
			false,
		),
		(
			r"a removed directory, a missing name after ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ../nosuch; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: ../nosuch: No such file or directory
S=1 PWD=</gone>
",
			false,
		),
		(
			r"a removed directory, a name after two ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd ../../d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</d>
",
			false,
		),
		(
			r"a removed directory, a name after ./..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ./../d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</d>
",
			false,
		),
		(
			r"a removed tree, cd .. logically",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd -L ..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/in/..>
",
			false,
		),
		(
			r"a removed tree, cd .. physically",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd -P ..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=</gone/in/..>
",
			false,
		),
		(
			r"a removed tree, cd ../.. to a directory that is there",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd ../..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=<>
",
			false,
		),
		(
			r"a removed directory, a name of its own",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: d: No such file or directory
S=1 PWD=</gone>
",
			false,
		),
		(
			r"a removed directory, ./ before a name of its own",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ./d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: ./d: No such file or directory
S=1 PWD=</gone>
",
			false,
		),
		(
			r"OLDPWD is what PWD held",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; PWD=custom; cd d; echo "S=$? OLDPWD=<$OLDPWD>"; cd "$top"; chmod 755 locked"#,
			r"S=0 OLDPWD=<custom>
",
			false,
		),
		(
			r"OLDPWD with PWD unset",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset PWD; cd d; echo "S=$? OLDPWD=<$OLDPWD>"; cd "$top"; chmod 755 locked"#,
			r"S=0 OLDPWD=<>
",
			false,
		),
		(
			r"OLDPWD from a removed directory",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; PWD=custom; cd .; echo "S=$? OLDPWD=<$OLDPWD>"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 OLDPWD=<custom>
",
			false,
		),
		(
			r"OLDPWD after pushd",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; PWD=custom; pushd d >/dev/null; echo "S=$? OLDPWD=<$OLDPWD>"; cd "$top"; chmod 755 locked"#,
			r"S=0 OLDPWD=<custom>
",
			false,
		),
		(
			r"cd - after PWD was written",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; PWD=custom; cd d >/dev/null; cd - >/dev/null 2>&1; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=1 PWD=</d>
",
			false,
		),
		(
			r"a removed directory whose link is gone, cd -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p real/parent/gone; ln -s real/parent via; cd via/gone; rm "$top/via"; rmdir "$top/real/parent/gone"; cd -P ../..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</real>
",
			false,
		),
		(
			r"a removed directory whose link is gone, cd -L",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p real/parent/gone; ln -s real/parent via; cd via/gone; rm "$top/via"; rmdir "$top/real/parent/gone"; cd -L ../..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</real>
",
			false,
		),
		(
			r"a removed tree left by two cd ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd ..; cd ..; : >probe; echo "W=$?"; [ -f "$top/probe" ] && echo HERE; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
W=0
HERE
",
			false,
		),
		(
			r"a removed tree left by cd ../..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p gone/in; cd gone/in; rm -r "$top/gone"; cd ../..; : >probe; echo "W=$?"; [ -f "$top/probe" ] && echo HERE; cd "$top"; chmod 755 locked"#,
			r"W=0
HERE
",
			false,
		),
		(
			r"a removed directory, .. to a file",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd -P ../file; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: ../file: Not a directory
S=1 PWD=</gone>
",
			false,
		),
		(
			r"a removed directory, .. to a file with a slash",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ../file/; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: ../file/: No such file or directory
S=1 PWD=</gone>
",
			false,
		),
		(
			r"a removed directory, a name through a file after ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ../file/../d; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"cd: ../file/../d: No such file or directory
S=1 PWD=</gone>
",
			false,
		),
		(
			r"a moved working directory, cd .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p from/here there; cd from/here; mv "$top/from/here" "$top/there/here"; cd .; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</there/here>
",
			false,
		),
		(
			r"a moved working directory, cd ..",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p from/here there; cd from/here; mv "$top/from/here" "$top/there/here"; cd ..; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</there>
",
			false,
		),
		(
			r"a readonly PWD and a CDPATH",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p a/d b/d; CDPATH="$top/a:$top/b"; readonly PWD; cd d >/dev/null; : >marker; for x in a b; do [ -f "$top/$x/d/marker" ] && echo "MARKER=$x"; done; cd "$top"; chmod 755 locked"#,
			r"PWD: readonly variable
MARKER=a
PWD: readonly variable
",
			false,
		),
		(
			r"a readonly PWD keeps OLDPWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; unset OLDPWD; PWD=custom; readonly PWD; cd d; echo "OLDPWD=<$OLDPWD>"; cd "$top"; chmod 755 locked"#,
			r"PWD: readonly variable
OLDPWD=<custom>
PWD: readonly variable
",
			false,
		),
		(
			r"a readonly OLDPWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; OLDPWD=kept; readonly OLDPWD; cd d; echo "S=$? PWD=<${PWD#$top}> OLDPWD=<$OLDPWD>"; cd "$top"; chmod 755 locked"#,
			r"OLDPWD: readonly variable
S=1 PWD=</d> OLDPWD=<kept>
OLDPWD: readonly variable
",
			false,
		),
		(
			r"cd .. from one level under the root",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd /; cd ..; echo "S=$? PWD=<$PWD>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</>
",
			false,
		),
		(
			r"cd past the root",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; cd /; cd ../../..; echo "S=$? PWD=<$PWD>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</>
",
			false,
		),
		(
			r"a removed directory, .. with a name that is there",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; cd ../d/sub; echo "S=$? PWD=<${PWD#$top}>"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</d/sub>
",
			false,
		),
		(
			r"an unsearchable directory reached through a moved one, cd -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p old/in old/lk; chmod 000 old/lk; cd old/in; mv "$top/old" "$top/new"; cd -P ../lk; echo "S=$? PWD=<${PWD#$top}>"; chmod 755 "$top/new/lk"; cd "$top"; chmod 755 locked"#,
			r"cd: ../lk: Permission denied
S=1 PWD=</old/in>
",
			true,
		),
		(
			r"an unsearchable directory reached through a moved one, cd -L",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p old/in old/lk; chmod 000 old/lk; cd old/in; mv "$top/old" "$top/new"; cd -L ../lk; echo "S=$? PWD=<${PWD#$top}>"; chmod 755 "$top/new/lk"; cd "$top"; chmod 755 locked"#,
			r"cd: ../lk: No such file or directory
S=1 PWD=</old/in>
",
			true,
		),
		(
			r"a directory named with the kernel's removal suffix, cd -P",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p old/in "old/a (deleted)"; cd old/in; mv "$top/old" "$top/new"; cd -P "../a (deleted)"; echo "S=$? PWD=<${PWD#$top}>"; : >marker; echo "W=$?"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</new/a (deleted)>
W=0
",
			false,
		),
		(
			r"a directory named with the kernel's removal suffix, cd -L",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir -p old/in "old/a (deleted)"; cd old/in; mv "$top/old" "$top/new"; cd -L "../a (deleted)"; echo "S=$? PWD=<${PWD#$top}>"; : >marker; echo "W=$?"; cd "$top"; chmod 755 locked"#,
			r"S=0 PWD=</new/a (deleted)>
W=0
",
			false,
		),
		(
			r"pushd with a readonly PWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; readonly PWD; pushd d >/dev/null; echo "S=$?"; dirs -p | sed "s|^$top|T|"; cd "$top"; chmod 755 locked"#,
			r"PWD: readonly variable
S=1
T/d
PWD: readonly variable
",
			false,
		),
		(
			r"pushd with a readonly OLDPWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; readonly OLDPWD; pushd d >/dev/null; echo "S=$?"; dirs -p | sed "s|^$top|T|"; cd "$top"; chmod 755 locked"#,
			r"OLDPWD: readonly variable
S=1
T/d
OLDPWD: readonly variable
",
			false,
		),
		(
			r"popd with a readonly PWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; pushd d >/dev/null; readonly PWD; popd >/dev/null; echo "S=$?"; dirs -p | sed "s|^$top|T|"; cd "$top"; chmod 755 locked"#,
			r"PWD: readonly variable
S=1
T
T
PWD: readonly variable
",
			false,
		),
		(
			r"popd with a readonly OLDPWD",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; pushd d >/dev/null; readonly OLDPWD; popd >/dev/null; echo "S=$?"; dirs -p | sed "s|^$top|T|"; cd "$top"; chmod 755 locked"#,
			r"OLDPWD: readonly variable
S=1
T
T
OLDPWD: readonly variable
",
			false,
		),
		(
			r"a removed directory and a readonly PWD, cd .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; readonly PWD; cd .; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
PWD: readonly variable
S=1
PWD: readonly variable
",
			false,
		),
		(
			r"a removed directory and a readonly OLDPWD, cd -P .",
			r#"unset CDPATH; top=$PWD; : >file; mkdir -p locked/inner d/sub; ln -s d link; chmod 000 locked; mkdir gone; cd gone; rmdir "$top/gone"; readonly OLDPWD; cd -P .; echo "S=$?"; cd "$top"; chmod 755 locked"#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
OLDPWD: readonly variable
S=1
OLDPWD: readonly variable
",
			false,
		),
		(
			r"finding4 +P: removed, pushd .",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=0 PWD=/gone/. OLD=/gone
T/gone/.
T/gone
T/gone/. T/gone
D=0
",
			false,
		),
		(
			r"finding4 +P: removed, readonly PWD; pushd .",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; readonly PWD; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
PWD: readonly variable
S=1 PWD=/gone OLD=/gone
T/gone/.
T/gone/.
D=0
",
			false,
		),
		(
			r"finding4 +P: removed, readonly OLDPWD; pushd .",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; readonly OLDPWD; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
OLDPWD: readonly variable
S=1 PWD=/gone/. OLD=
T/gone/.
T/gone/.
D=0
",
			false,
		),
		(
			r"finding4 +P: removed, readonly PWD OLDPWD; pushd .",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; readonly PWD OLDPWD; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"cd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
OLDPWD: readonly variable
PWD: readonly variable
S=1 PWD=/gone OLD=
T/gone/.
T/gone/.
D=0
",
			false,
		),
		(
			r"finding4 +P: removed, dirs",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; dirs; echo "D=$?"; dirs -p; "#,
			r"T/gone
D=0
T/gone
",
			false,
		),
		(
			r"held -P: pushd .",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/new/in OLD=/old/in
T/new/in/marker
T/new/in
",
			false,
		),
		(
			r"finding4 -P: removed, pushd .",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone OLD=
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
D=0
",
			false,
		),
		(
			r"finding4 -P: removed, readonly PWD; pushd .",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; readonly PWD; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone OLD=
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
D=0
",
			false,
		),
		(
			r"finding4 -P: removed, readonly OLDPWD; pushd .",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; readonly OLDPWD; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone OLD=
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
D=0
",
			false,
		),
		(
			r"finding4 -P: removed, readonly PWD OLDPWD; pushd .",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; readonly PWD OLDPWD; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; dirs -p | sed "s|$top|T|"; dirs -l | sed "s|$top|T|"; echo "D=$?"; "#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone OLD=
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
D=0
",
			false,
		),
		(
			r"finding4 -P: removed, dirs",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; dirs; echo "D=$?"; dirs -p; "#,
			r"dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
D=0
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
",
			false,
		),
		(
			r"CDPATH is searched for a name starting with a dot",
			r#"unset CDPATH; top=$PWD; mkdir -p c/.h; CDPATH=$top/c; cd .h; echo "S=$? PWD=${PWD#$top}""#,
			r"T/c/.h
S=0 PWD=/c/.h
",
			false,
		),
		(
			r"CDPATH entry ~ is the home directory",
			r#"unset CDPATH; top=$PWD; mkdir -p c/x; HOME=$top/c; CDPATH="~"; cd x; echo "S=$? PWD=${PWD#$top}""#,
			r"T/c/x
S=0 PWD=/c/x
",
			false,
		),
		(
			r"CDPATH entry ~/sub",
			r#"unset CDPATH; top=$PWD; mkdir -p c/s/x; HOME=$top/c; CDPATH="~/s"; cd -P x; echo "S=$? PWD=${PWD#$top}""#,
			r"T/c/s/x
S=0 PWD=/c/s/x
",
			false,
		),
		(
			r"CDPATH empty entry first wins",
			r#"unset CDPATH; top=$PWD; mkdir -p x c/x; CDPATH=:$top/c; cd x; echo "S=$? PWD=${PWD#$top}""#,
			r"S=0 PWD=/x
",
			false,
		),
		(
			r"CDPATH entries in order",
			r#"unset CDPATH; top=$PWD; mkdir -p a/x b/x; CDPATH=$top/b:$top/a; cd x; echo "S=$? PWD=${PWD#$top}""#,
			r"T/b/x
S=0 PWD=/b/x
",
			false,
		),
		(
			r"CDPATH a trailing colon is the working directory",
			r#"unset CDPATH; top=$PWD; mkdir -p x c; CDPATH=$top/c:; cd x; echo "S=$? PWD=${PWD#$top}""#,
			r"S=0 PWD=/x
",
			false,
		),
		(
			r"CDPATH relative entry under -P prints its spelling",
			r#"unset CDPATH; top=$PWD; mkdir -p d/sub; CDPATH=./d; cd -P sub; echo "S=$? PWD=${PWD#$top}""#,
			r"./d/sub
S=0 PWD=/d/sub
",
			false,
		),
		(
			r"cdable_vars is not looked for in CDPATH",
			r#"unset CDPATH; top=$PWD; mkdir -p c/d; shopt -s cdable_vars; aa=d; CDPATH=$top/c; cd aa; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: aa: No such file or directory
S=1 PWD=
",
			false,
		),
		(
			r"cdable_vars does not apply to cd -",
			r#"unset CDPATH; top=$PWD; mkdir d; shopt -s cdable_vars; aa=d; OLDPWD=aa; cd -; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: aa: No such file or directory
S=1 PWD=
",
			false,
		),
		(
			r"cdable_vars, a directory of that name wins",
			r#"unset CDPATH; top=$PWD; mkdir aa d; shopt -s cdable_vars; aa=d; cd aa; echo "S=$? PWD=${PWD#$top}""#,
			r"S=0 PWD=/aa
",
			false,
		),
		(
			r"cdable_vars, an unset variable",
			r#"unset CDPATH; top=$PWD; shopt -s cdable_vars; unset aa; cd aa; echo "S=$?""#,
			r"cd: aa: No such file or directory
S=1
",
			false,
		),
		(
			r"cd - under -P prints OLDPWD as written",
			r#"unset CDPATH; top=$PWD; mkdir -p d; ln -s d link; OLDPWD=link; cd -P -; echo "S=$? PWD=${PWD#$top}""#,
			r"link
S=0 PWD=/d
",
			false,
		),
		(
			r"HOME empty stays",
			r#"unset CDPATH; top=$PWD; mkdir d; cd d; HOME=; cd; echo "S=$? PWD=${PWD#$top}""#,
			r"S=0 PWD=/d
",
			false,
		),
		(
			r"a name through a file, logical",
			r#"unset CDPATH; top=$PWD; : >file; mkdir d; cd file/../d; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: file/../d: Not a directory
S=1 PWD=
",
			false,
		),
		(
			r"a name through a missing directory, logical",
			r#"unset CDPATH; top=$PWD; mkdir d; cd nosuch/../d; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: nosuch/../d: No such file or directory
S=1 PWD=
",
			false,
		),
		(
			r"a name through a missing directory, -P",
			r#"unset CDPATH; top=$PWD; mkdir d; cd -P nosuch/../d; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: nosuch/../d: No such file or directory
S=1 PWD=
",
			false,
		),
		(
			r"a name through a link, logical",
			r#"unset CDPATH; top=$PWD; mkdir -p d/sub e; ln -s d/sub link; cd link/../e 2>&1; echo "S=$? PWD=${PWD#$top}""#,
			r"S=0 PWD=/e
",
			false,
		),
		(
			r"a name through a missing directory, posix",
			r#"unset CDPATH; top=$PWD; mkdir d; set -o posix; cd nosuch/../d; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: nosuch/../d: No such file or directory
S=1 PWD=
",
			false,
		),
		(
			r"a name through a file, posix",
			r#"unset CDPATH; top=$PWD; : >file; mkdir d; set -o posix; cd file/../d; echo "S=$? PWD=${PWD#$top}""#,
			r"cd: file/../d: Not a directory
S=1 PWD=
",
			false,
		),
		(
			r"OLDPWD with PWD unset is declared without a value",
			r#"unset CDPATH; top=$PWD; mkdir d; unset PWD; cd d; echo "S=$? ${OLDPWD+set}""#,
			r"S=0 
",
			false,
		),
		(
			r"a moved working directory, cd ../x",
			r#"unset CDPATH; top=$PWD; mkdir -p from/here there/x from/x; cd from/here; mv "$top/from/here" "$top/there/here"; cd ../x; echo "S=$? PWD=${PWD#$top}""#,
			r"S=0 PWD=/there/x
",
			false,
		),
		(
			r"pushd -P from a removed directory, -n",
			r#"top=$PWD; set -P; mkdir gone o; cd gone; rmdir "$top/gone"; pushd -n "$top/o"; echo "S=$? PWD=${PWD#$top}"; dirs -l -p | sed "s|$top|T|""#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
",
			false,
		),
		(
			r"pushd -P from a removed directory, swap",
			r#"top=$PWD; set -P; mkdir gone o; cd gone; pushd -n "$top/o" >/dev/null; rmdir "$top/gone"; pushd; echo "S=$? PWD=${PWD#$top}"; dirs -l -p | sed "s|$top|T|""#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
T/o
",
			false,
		),
		(
			r"pushd -P from a removed directory, +0",
			r#"top=$PWD; set -P; mkdir gone o; cd gone; pushd -n "$top/o" >/dev/null; rmdir "$top/gone"; pushd +0; echo "S=$? PWD=${PWD#$top}"; dirs -l -p | sed "s|$top|T|""#,
			r"pushd: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
S=1 PWD=/gone
dirs: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory
<no current directory>
T/o
",
			false,
		),
		(
			r"popd -P from a removed directory",
			r#"top=$PWD; set -P; mkdir gone o; cd gone; pushd -n "$top/o" >/dev/null; rmdir "$top/gone"; popd >"$top/out"; echo "S=$? PWD=${PWD#$top}"; sed "s|$top|T|" "$top/out"; dirs -l -p | sed "s|$top|T|""#,
			r"S=0 PWD=/o
T/o
T/o
",
			false,
		),
		(
			r"pushd -P prints the physical stack",
			r#"top=$PWD; set -P; mkdir -p a b; ln -s b lb; cd a; pushd ../lb >/dev/null; echo "S=$? PWD=${PWD#$top}"; dirs -l -p | sed "s|$top|T|"; dirs -l +0 | sed "s|$top|T|""#,
			r"S=0 PWD=/b
T/b
T/a
T/b
",
			false,
		),
		(
			r"dirs +1 -P in a removed directory",
			r#"top=$PWD; set -P; mkdir gone o; cd gone; pushd -n "$top/o" >/dev/null; rmdir "$top/gone"; dirs -l +1 | sed "s|$top|T|"; echo "D=$?""#,
			r"T/o
D=0
",
			false,
		),
	];
	assert_as_bash(rows.iter().copied()).await;
}
