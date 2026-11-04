//! The shell works in the directory it holds, as a process works in the
//! directory it `chdir`ed to: every relative name, from every consumer, is
//! read from that directory, whatever its name reaches by then.

use super::*;

/// Each row runs as one command in a fresh directory, and its output is the
/// one GNU Bash 5.2.21 and 5.3 print for the same script (Bash's
/// `script: line N: ` prefix and this shell's `bash: line N: ` one taken
/// off the diagnostics, the directory spelled `T`). The working directory
/// is moved and another directory made at its old name (`held`), or it is
/// removed (`removed`), before every consumer runs: redirections, here
/// documents, in-process and external commands, command substitution,
/// subshells, background jobs, globbing, `test`, `source`, `cd`, `pushd`
/// and `pwd` read the directory held, as Bash's do. Before, each read the
/// name: writes landed in the new directory, and `cd .` in a removed one
/// failed. The `leak` and `life` rows pass at the base too: they guard that
/// no path the shell reads its directory through reaches what it prints,
/// and that a background job or pipeline stage keeps reading the directory
/// it started in while its parent changes directory hundreds of times (a
/// closed and reused descriptor number would list the other directory).
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn relative_names_are_read_from_the_directory_held_as_bash_reads_them() {
	let rows: &[(&str, &str, &str)] = &[
		(
			r"held +P: redirection writes",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held +P: in-process touch",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; touch marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held +P: external touch",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; /usr/bin/touch marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held +P: external pwd",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; /bin/pwd | sed "s|$top|T|"; "#,
			r"T/new/in
",
		),
		(
			r"held +P: pwd builtin",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; pwd | sed "s|$top|T|"; pwd -P | sed "s|$top|T|"; "#,
			r"T/old/in
T/old/in
",
		),
		(
			r"held +P: read redirection",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; read x <f; echo "$x"; "#,
			r"held
",
		),
		(
			r"held +P: in-process cat",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cat f; "#,
			r"held
",
		),
		(
			r"held +P: external cat",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; /bin/cat f; "#,
			r"held
",
		),
		(
			r"held +P: cmdsub",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo "$(cat f) $(</f)"; "#,
			r"/f: No such file or directory
held 
",
		),
		(
			r"held +P: subshell",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; (cat f; : >marker); find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"held
T/new/in/marker
",
		),
		(
			r"held +P: glob",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; echo *; "#,
			r"child f only
",
		),
		(
			r"held +P: test -e",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; [ -e only ]; echo "e=$?"; test -f only; echo "f=$?"; [[ -e only ]]; echo "x=$?"; "#,
			r"e=0
f=0
x=0
",
		),
		(
			r"held +P: source",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo "echo sourced-held" >"$top/new/in/s"; echo "echo sourced-name" >"$top/old/in/s"; . ./s; source s; "#,
			r"sourced-held
sourced-held
",
		),
		(
			r"held +P: ls",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; ls; "#,
			r"child
f
only
",
		),
		(
			r"held +P: find .",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; find . | sort; "#,
			r".
./child
./f
./only
",
		),
		(
			r"held +P: cd .",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cd .; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old/in OLD=/old/in
T/old/in/marker
T/old/in
",
		),
		(
			r"held +P: cd child",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cd child; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old/in/child OLD=/old/in
T/old/in/child/marker
T/old/in/child
",
		),
		(
			r"held +P: cd ..",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cd ..; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old OLD=/old/in
T/old/marker
T/old
",
		),
		(
			r"held +P: pushd .",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; pushd . >/dev/null; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old/in OLD=/old/in
T/old/in/marker
T/old/in
",
		),
		(
			r"held +P: heredoc",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cat <<EOF >marker
x
EOF
find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held +P: background job",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; { : >marker; } & wait; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held +P: rm",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; rm f; ls "$top/new/in" "$top/old/in" | sed "s|$top|T|"; "#,
			r"T/new/in:
child

T/old/in:
child
f
",
		),
		(
			r"held +P: mkdir",
			r#"top=$PWD; set +P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; mkdir sub; ls -d "$top"/*/in/sub | sed "s|$top|T|"; "#,
			r"T/new/in/sub
",
		),
		(
			r"removed +P: redirection",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; : >x; echo "S=$?"; "#,
			r"x: No such file or directory
S=1
",
		),
		(
			r"removed +P: external pwd",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; /bin/pwd; echo "S=$?"; "#,
			r"/bin/pwd: couldn't find directory entry in ‘..’ with matching i-node
S=1
",
		),
		(
			r"removed +P: glob",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; echo *; "#,
			r"*
",
		),
		(
			r"removed +P: cat missing",
			r#"top=$PWD; set +P; mkdir gone; cd gone; rmdir "$top/gone"; cat nofile; echo "S=$?"; "#,
			r"cat: nofile: No such file or directory
S=1
",
		),
		(
			r"finding3 +P: unsearchable ancestor, cd .",
			r#"top=$PWD; set +P; mkdir -p old/in; cd old/in; mv "$top/old" "$top/new"; chmod 000 "$top/new"; cd .; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/new"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"S=0 PWD=/new/in OLD=/old/in
T/new/in/marker
",
		),
		(
			r"finding5 +P: chmod 000 cwd, cd ..",
			r#"top=$PWD; set +P; mkdir -p old/in; cd old/in; chmod 000 "$top/old/in"; cd ..; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/old/in"; "#,
			r"S=0 PWD=/old OLD=/old/in
",
		),
		(
			r"finding5 +P: chmod 000 cwd, cd ../in",
			r#"top=$PWD; set +P; mkdir -p old/in; cd old/in; chmod 000 "$top/old/in"; cd ../in; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/old/in"; "#,
			r"cd: ../in: Permission denied
S=1 PWD=/old/in OLD=
",
		),
		(
			r"finding5 +P: chmod 000 cwd, cd .",
			r#"top=$PWD; set +P; mkdir -p old/in; cd old/in; chmod 000 "$top/old/in"; cd .; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/old/in"; "#,
			r"cd: .: Permission denied
S=1 PWD=/old/in OLD=
",
		),
		(
			r"held -P: redirection writes",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held -P: in-process touch",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; touch marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held -P: external touch",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; /usr/bin/touch marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held -P: external pwd",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; /bin/pwd | sed "s|$top|T|"; "#,
			r"T/new/in
",
		),
		(
			r"held -P: pwd builtin",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; pwd | sed "s|$top|T|"; pwd -P | sed "s|$top|T|"; "#,
			r"T/old/in
T/old/in
",
		),
		(
			r"held -P: read redirection",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; read x <f; echo "$x"; "#,
			r"held
",
		),
		(
			r"held -P: in-process cat",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cat f; "#,
			r"held
",
		),
		(
			r"held -P: external cat",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; /bin/cat f; "#,
			r"held
",
		),
		(
			r"held -P: cmdsub",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo "$(cat f) $(</f)"; "#,
			r"/f: No such file or directory
held 
",
		),
		(
			r"held -P: subshell",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; (cat f; : >marker); find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"held
T/new/in/marker
",
		),
		(
			r"held -P: glob",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; echo *; "#,
			r"child f only
",
		),
		(
			r"held -P: test -e",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; [ -e only ]; echo "e=$?"; test -f only; echo "f=$?"; [[ -e only ]]; echo "x=$?"; "#,
			r"e=0
f=0
x=0
",
		),
		(
			r"held -P: source",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo "echo sourced-held" >"$top/new/in/s"; echo "echo sourced-name" >"$top/old/in/s"; . ./s; source s; "#,
			r"sourced-held
sourced-held
",
		),
		(
			r"held -P: ls",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; ls; "#,
			r"child
f
only
",
		),
		(
			r"held -P: find .",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; echo held-only >"$top/new/in/only"; find . | sort; "#,
			r".
./child
./f
./only
",
		),
		(
			r"held -P: cd .",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cd .; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old/in OLD=/old/in
T/new/in/marker
T/new/in
",
		),
		(
			r"held -P: cd child",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cd child; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old/in/child OLD=/old/in
T/new/in/child/marker
T/new/in/child
",
		),
		(
			r"held -P: cd ..",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cd ..; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; /bin/pwd | sed "s|$top|T|"; "#,
			r"S=0 PWD=/old OLD=/old/in
T/new/marker
T/new
",
		),
		(
			r"held -P: heredoc",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; cat <<EOF >marker
x
EOF
find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held -P: background job",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; { : >marker; } & wait; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"T/new/in/marker
",
		),
		(
			r"held -P: rm",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; rm f; ls "$top/new/in" "$top/old/in" | sed "s|$top|T|"; "#,
			r"T/new/in:
child

T/old/in:
child
f
",
		),
		(
			r"held -P: mkdir",
			r#"top=$PWD; set -P; mkdir -p old/in/child; echo held >old/in/f; cd old/in; mv "$top/old" "$top/new"; mkdir -p "$top/old/in/child"; echo name >"$top/old/in/f"; mkdir sub; ls -d "$top"/*/in/sub | sed "s|$top|T|"; "#,
			r"T/new/in/sub
",
		),
		(
			r"removed -P: redirection",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; : >x; echo "S=$?"; "#,
			r"x: No such file or directory
S=1
",
		),
		(
			r"removed -P: external pwd",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; /bin/pwd; echo "S=$?"; "#,
			r"/bin/pwd: couldn't find directory entry in ‘..’ with matching i-node
S=1
",
		),
		(
			r"removed -P: glob",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; echo *; "#,
			r"*
",
		),
		(
			r"removed -P: cat missing",
			r#"top=$PWD; set -P; mkdir gone; cd gone; rmdir "$top/gone"; cat nofile; echo "S=$?"; "#,
			r"cat: nofile: No such file or directory
S=1
",
		),
		(
			r"finding3 -P: unsearchable ancestor, cd .",
			r#"top=$PWD; set -P; mkdir -p old/in; cd old/in; mv "$top/old" "$top/new"; chmod 000 "$top/new"; cd .; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/new"; : >marker; find "$top" -name marker | sed "s|$top|T|" | sort; "#,
			r"S=0 PWD=/new/in OLD=/old/in
T/new/in/marker
",
		),
		(
			r"finding5 -P: chmod 000 cwd, cd ..",
			r#"top=$PWD; set -P; mkdir -p old/in; cd old/in; chmod 000 "$top/old/in"; cd ..; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/old/in"; "#,
			r"cd: ..: Permission denied
S=1 PWD=/old/in OLD=
",
		),
		(
			r"finding5 -P: chmod 000 cwd, cd ../in",
			r#"top=$PWD; set -P; mkdir -p old/in; cd old/in; chmod 000 "$top/old/in"; cd ../in; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/old/in"; "#,
			r"cd: ../in: Permission denied
S=1 PWD=/old/in OLD=
",
		),
		(
			r"finding5 -P: chmod 000 cwd, cd .",
			r#"top=$PWD; set -P; mkdir -p old/in; cd old/in; chmod 000 "$top/old/in"; cd .; echo "S=$? PWD=${PWD#$top} OLD=${OLDPWD#$top}"; chmod 755 "$top/old/in"; "#,
			r"cd: .: Permission denied
S=1 PWD=/old/in OLD=
",
		),
		(
			r"leak +P: relative glob",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo * sub/*; echo ./*; ",
			r"f sub sub/g
./f ./sub
",
		),
		(
			r"leak +P: find .",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; find . | sort; find . -name g; ",
			r".
./f
./sub
./sub/g
./sub/g
",
		),
		(
			r"leak +P: find -execdir",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; find . -name g -execdir pwd \; | sed "s|$top|T|"; "#,
			r"T/w/sub
",
		),
		(
			r"leak +P: ls",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; ls; ls -d .; ls sub; ls -R | sed "s|$top|T|"; "#,
			r"f
sub
.
g
.:
f
sub

./sub:
g
",
		),
		(
			r"leak +P: cat nofile",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; cat nofile; echo "S=$?"; cat sub/nofile; echo "S=$?"; "#,
			r"cat: nofile: No such file or directory
S=1
cat: sub/nofile: No such file or directory
S=1
",
		),
		(
			r"leak +P: rm diagnostics",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; rm nofile; echo "S=$?"; rm sub; echo "S=$?"; rm -v f; "#,
			r"rm: cannot remove 'nofile': No such file or directory
S=1
rm: cannot remove 'sub': Is a directory
S=1
removed 'f'
",
		),
		(
			r"leak +P: realpath",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; realpath f sub/g . | sed "s|$top|T|"; readlink -f sub | sed "s|$top|T|"; "#,
			r"T/w/f
T/w/sub/g
T/w
T/w/sub
",
		),
		(
			r"leak +P: pwd in children",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo "$(pwd)" | sed "s|$top|T|"; /bin/pwd | sed "s|$top|T|"; (cd sub && pwd) | sed "s|$top|T|"; env | grep "^PWD=" | sed "s|$top|T|"; "#,
			r"T/w
T/w
T/w/sub
PWD=T/w
",
		),
		(
			r"leak +P: cp mv -v",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; cp -v f f2; mv -v f2 sub/; ls sub; ",
			r"'f' -> 'f2'
renamed 'f2' -> 'sub/f2'
f2
g
",
		),
		(
			r"leak +P: du stat",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; du -a . | cut -f2 | sort; stat -c %n f sub; ",
			r".
./f
./sub
./sub/g
f
sub
",
		),
		(
			r"leak +P: grep -r",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; grep -r deep . ; grep -rl hi .; ",
			r"./sub/g:deep
./f
",
		),
		(
			r"leak +P: xargs",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo f | xargs cat; echo sub | xargs ls; ",
			r"hi
g
",
		),
		(
			r"leak +P: source and dot",
			r#"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo "echo sourced" >s; . ./s; source s; "#,
			r"sourced
sourced
",
		),
		(
			r"leak +P: here-doc and cmdsub",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; cat <<EOF
$(cat f)
EOF
",
			r"hi
",
		),
		(
			r"leak +P: test and [[",
			r"top=$PWD; set +P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; [ -f f ] && [[ -d sub ]] && test -e sub/g && echo ok; ",
			r"ok
",
		),
		(
			r"life +P: background walker races cd",
			r#"top=$PWD; set +P; mkdir -p a/x b/y; cd a; { sleep 0.3; find . | sort; ls; } >"$top/out" & for i in $(seq 200); do cd ../b; cd ../a; done; cd ../b; wait; cat "$top/out"; pwd | sed "s|$top|T|"; "#,
			r".
./x
x
T/b
",
		),
		(
			r"life +P: subshell cd races walker",
			r#"top=$PWD; set +P; mkdir -p a/x b/y; cd a; find . | sort >"$top/out" & (for i in $(seq 100); do cd ../b; cd ../a; done; ls); wait; cat "$top/out"; "#,
			r"x
.
./x
",
		),
		(
			r"life +P: pipeline stage cd",
			r"top=$PWD; set +P; mkdir -p a/x b/y; cd a; ls | (cd ../b; cat; ls); find . | sort; ",
			r"x
y
.
./x
",
		),
		(
			r"leak -P: relative glob",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo * sub/*; echo ./*; ",
			r"f sub sub/g
./f ./sub
",
		),
		(
			r"leak -P: find .",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; find . | sort; find . -name g; ",
			r".
./f
./sub
./sub/g
./sub/g
",
		),
		(
			r"leak -P: find -execdir",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; find . -name g -execdir pwd \; | sed "s|$top|T|"; "#,
			r"T/w/sub
",
		),
		(
			r"leak -P: ls",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; ls; ls -d .; ls sub; ls -R | sed "s|$top|T|"; "#,
			r"f
sub
.
g
.:
f
sub

./sub:
g
",
		),
		(
			r"leak -P: cat nofile",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; cat nofile; echo "S=$?"; cat sub/nofile; echo "S=$?"; "#,
			r"cat: nofile: No such file or directory
S=1
cat: sub/nofile: No such file or directory
S=1
",
		),
		(
			r"leak -P: rm diagnostics",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; rm nofile; echo "S=$?"; rm sub; echo "S=$?"; rm -v f; "#,
			r"rm: cannot remove 'nofile': No such file or directory
S=1
rm: cannot remove 'sub': Is a directory
S=1
removed 'f'
",
		),
		(
			r"leak -P: realpath",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; realpath f sub/g . | sed "s|$top|T|"; readlink -f sub | sed "s|$top|T|"; "#,
			r"T/w/f
T/w/sub/g
T/w
T/w/sub
",
		),
		(
			r"leak -P: pwd in children",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo "$(pwd)" | sed "s|$top|T|"; /bin/pwd | sed "s|$top|T|"; (cd sub && pwd) | sed "s|$top|T|"; env | grep "^PWD=" | sed "s|$top|T|"; "#,
			r"T/w
T/w
T/w/sub
PWD=T/w
",
		),
		(
			r"leak -P: cp mv -v",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; cp -v f f2; mv -v f2 sub/; ls sub; ",
			r"'f' -> 'f2'
renamed 'f2' -> 'sub/f2'
f2
g
",
		),
		(
			r"leak -P: du stat",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; du -a . | cut -f2 | sort; stat -c %n f sub; ",
			r".
./f
./sub
./sub/g
f
sub
",
		),
		(
			r"leak -P: grep -r",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; grep -r deep . ; grep -rl hi .; ",
			r"./sub/g:deep
./f
",
		),
		(
			r"leak -P: xargs",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo f | xargs cat; echo sub | xargs ls; ",
			r"hi
g
",
		),
		(
			r"leak -P: source and dot",
			r#"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; echo "echo sourced" >s; . ./s; source s; "#,
			r"sourced
sourced
",
		),
		(
			r"leak -P: here-doc and cmdsub",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; cat <<EOF
$(cat f)
EOF
",
			r"hi
",
		),
		(
			r"leak -P: test and [[",
			r"top=$PWD; set -P; mkdir -p w/sub; echo hi >w/f; echo deep >w/sub/g; cd w; [ -f f ] && [[ -d sub ]] && test -e sub/g && echo ok; ",
			r"ok
",
		),
		(
			r"life -P: background walker races cd",
			r#"top=$PWD; set -P; mkdir -p a/x b/y; cd a; { sleep 0.3; find . | sort; ls; } >"$top/out" & for i in $(seq 200); do cd ../b; cd ../a; done; cd ../b; wait; cat "$top/out"; pwd | sed "s|$top|T|"; "#,
			r".
./x
x
T/b
",
		),
		(
			r"life -P: subshell cd races walker",
			r#"top=$PWD; set -P; mkdir -p a/x b/y; cd a; find . | sort >"$top/out" & (for i in $(seq 100); do cd ../b; cd ../a; done; ls); wait; cat "$top/out"; "#,
			r"x
.
./x
",
		),
		(
			r"life -P: pipeline stage cd",
			r"top=$PWD; set -P; mkdir -p a/x b/y; cd a; ls | (cd ../b; cat; ls); find . | sort; ",
			r"x
y
.
./x
",
		),
	];
	// SAFETY: `geteuid` has no preconditions.
	let root = unsafe { libc::geteuid() } == 0;
	let mut failures = Vec::new();
	for (name, script, bash) in rows {
		// Root searches a directory without search permission.
		if root && script.contains("chmod") {
			continue;
		}
		let dir = tempfile::tempdir().expect("scratch directory");
		let outcome = run_command_capture_within(
			Duration::from_secs(30),
			script,
			Some(dir.path()),
			None,
			CancelToken::default(),
		)
		.await;
		let top = dir.path().to_string_lossy().into_owned();
		reopen(dir.path());
		match outcome {
			Ok((result, output)) => {
				let output = unprefixed(&output.replace(&top, "T"));
				if result.exit_code != Some(0) || output != *bash {
					failures.push(format!(
						"{name}: Bash prints {bash:?}; got status {:?}, output {output:?}",
						result.exit_code
					));
				}
			},
			Err(_) => failures.push(format!("{name}: did not finish within 30 s")),
		}
	}
	assert!(failures.is_empty(), "{failures:#?}");
}

/// `output` without this shell's `bash: line N: ` diagnostic prefixes.
fn unprefixed(output: &str) -> String {
	let prefix = regex::Regex::new(r"(?m)^bash: line [0-9]+: ").expect("pattern");
	prefix.replace_all(output, "").into_owned()
}

/// Gives every directory under `dir` its permissions back, so a row that
/// took them away does not leave its scratch directory behind.
fn reopen(dir: &std::path::Path) {
	use std::os::unix::fs::PermissionsExt as _;
	let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
	if let Ok(entries) = std::fs::read_dir(dir) {
		for entry in entries.flatten() {
			if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
				reopen(&entry.path());
			}
		}
	}
}
