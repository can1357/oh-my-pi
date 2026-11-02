//! Assignments made through the declaration builtins (`declare`, `local`,
//! `readonly`, `typeset`, `export`) and through arithmetic on associative
//! array elements, and what an arithmetic command does when an assignment or
//! any other part of its expression fails. Every expected output and exit
//! status is GNU Bash 5.2.21's for the same script.
#![cfg(unix)]

use std::{
	io::{Read, Seek},
	time::Duration,
};

use brush_core::{
	ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
	openfiles::{OpenFile, OpenFiles},
};
use pi_builtins::{BuiltinSet, default_builtins};

/// What `code` printed to standard output in a fresh shell, and the shell's
/// exit status. A run that does not finish in ten seconds fails the test.
async fn run(code: &str) -> (u8, String) {
	let mut shell = Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	let mut stdout = tempfile::tempfile().expect("stdout");
	let mut params = shell.default_exec_params();
	params
		.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(stdout.try_clone().expect("stdout descriptor")));
	let sink = std::fs::OpenOptions::new()
		.write(true)
		.open("/dev/null")
		.expect("/dev/null");
	params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(sink));
	let result = tokio::time::timeout(
		Duration::from_secs(10),
		shell.run_string(code, &SourceInfo::default(), &params),
	)
	.await
	.unwrap_or_else(|_elapsed| panic!("{code}: did not finish"))
	.unwrap_or_else(|error| panic!("{code}: {error}"));
	stdout.rewind().expect("rewind");
	let mut text = String::new();
	stdout.read_to_string(&mut text).expect("read");
	(u8::from(result.exit_code), text)
}

async fn assert_bash(cases: &[(&str, &str)]) {
	for (code, expected) in cases {
		assert_eq!(run(code).await, (0, (*expected).to_owned()), "{code}");
	}
}

/// `export "name=value"` — quoted, or produced by an expansion — assigns and
/// exports, as `export name=value` does. It had exported nothing and
/// returned 0, so a child process never saw the variable.
#[tokio::test]
async fn export_assigns_a_quoted_or_expanded_assignment_word() {
	assert_bash(&[
		("PATH=/usr/bin:/bin; export \"v=1\"; printenv v; echo \"rc=$?\"", "1\nrc=0\n"),
		("PATH=/usr/bin:/bin; kv='v=hello world'; export \"$kv\"; printenv v", "hello world\n"),
		("PATH=/usr/bin:/bin; IFS=,; kvs='a=1,b=2'; export $kvs; printenv a b", "1\n2\n"),
		// The value is the expanded text: it is not expanded a second time.
		("PATH=/usr/bin:/bin; export 'v=$HOME'; printenv v", "$HOME\n"),
		("v=a; export \"v+=b\"; declare -p v", "declare -x v=\"ab\"\n"),
	])
	.await;
}

/// A word that is not an identifier is refused with status 1, and the
/// remaining words are still processed. It had been accepted with status 0
/// (or refused with status 2, for an array element). With `-f` every word
/// names a function, so an assignment-shaped one assigns nothing.
#[tokio::test]
async fn export_refuses_a_word_that_is_not_an_identifier() {
	assert_bash(&[
		("e=; export \"$e=x\"; echo \"rc=$?\"", "rc=1\n"),
		("export \"1v=x\"; echo \"rc=$?\"", "rc=1\n"),
		("export a-b; echo \"rc=$?\"", "rc=1\n"),
		("export \"a[1]=x\"; echo \"rc=$?\"", "rc=1\n"),
		("export a[1]=x; echo \"rc=$?\"", "rc=1\n"),
		("export -f nosuch; echo \"rc=$?\"", "rc=1\n"),
		("v=old; export -f 'v=new'; echo \"rc=$? v=$v\"", "rc=1 v=old\n"),
		("export \"=x\" \"w=2\"; echo \"rc=$?\"; declare -p w", "rc=1\ndeclare -x w=\"2\"\n"),
	])
	.await;
}

/// `export name` with no variable of that name marks the name for export,
/// so the variable a later assignment makes is exported. It had done
/// nothing.
#[tokio::test]
async fn export_marks_a_name_with_no_variable_for_export() {
	assert_bash(&[
		("PATH=/usr/bin:/bin; export v; v=1; printenv v", "1\n"),
		("PATH=/usr/bin:/bin; f() { export v; }; f; v=1; printenv v", "1\n"),
		("export v; declare -p v", "declare -x v\n"),
	])
	.await;
}

/// `declare`, `local`, `readonly` and `typeset` assign a quoted assignment
/// word, as they assign an unquoted one. They had refused it as an invalid
/// name.
#[tokio::test]
async fn declaration_builtins_assign_a_quoted_assignment_word() {
	assert_bash(&[
		("declare \"v=1\"; echo \"v=$v\"", "v=1\n"),
		("typeset \"v=1\"; echo \"v=$v\"", "v=1\n"),
		("f() { local \"v=1\"; echo \"in=$v\"; }; f; echo \"out=${v-unset}\"", "in=1\nout=unset\n"),
		("readonly \"v=1\"; declare -p v", "declare -r v=\"1\"\n"),
		("declare -x \"v=1\"; declare -p v", "declare -x v=\"1\"\n"),
		("declare \"a[1]=x\"; declare -p a", "declare -a a=([1]=\"x\")\n"),
	])
	.await;
}

/// `+=` through a declaration builtin appends, as the same assignment
/// outside one does: to a string, to an integer's value, to an array, and
/// to one element. It had replaced the value.
#[tokio::test]
async fn declaration_builtins_append_with_plus_equals() {
	assert_bash(&[
		("v=a; declare v+=b; echo \"v=$v\"", "v=ab\n"),
		("v=a; export v+=b; declare -p v", "declare -x v=\"ab\"\n"),
		("v=a; readonly v+=b; echo \"v=$v\"", "v=ab\n"),
		("f() { local v=a; local v+=b; echo \"v=$v\"; }; f", "v=ab\n"),
		("declare -i x=5; declare x+=3; echo \"x=$x\"", "x=8\n"),
		("declare -i x=5; export x+=3; echo \"x=$x\"", "x=8\n"),
		("declare -a a=(1); declare a+=(2); declare -p a", "declare -a a=([0]=\"1\" [1]=\"2\")\n"),
		("declare a=(x); declare a[0]+=y; declare -p a", "declare -a a=([0]=\"xy\")\n"),
		("declare -A m=([k]=a); declare m[k]+=b; declare -p m", "declare -A m=([k]=\"ab\" )\n"),
	])
	.await;
}

/// A readonly variable keeps its value through every declaration builtin and
/// every element write, the builtin returns 1, and the words after the
/// refused one are still processed. A local cannot hide a readonly
/// variable. Element writes and `local` had changed it, and a refused word
/// had stopped the rest.
#[tokio::test]
async fn declarations_and_element_writes_leave_a_readonly_variable_alone() {
	assert_bash(&[
		("readonly v=a; declare v=b w=2; echo \"rc=$? v=$v w=${w-unset}\"", "rc=1 v=a w=2\n"),
		("readonly v=a; declare 'v=b' w=2; echo \"rc=$? v=$v w=${w-unset}\"", "rc=1 v=a w=2\n"),
		("readonly v=a; export v=b w=2; echo \"rc=$? v=$v w=${w-unset}\"", "rc=1 v=a w=2\n"),
		("readonly v=a; f() { local v; echo \"rc=$? v=$v\"; }; f", "rc=1 v=a\n"),
		(
			"readonly v=a; f() { local 'v=b'; echo \"rc=$? v=$v\"; }; f; echo \"out=$v\"",
			"rc=1 v=a\nout=a\n",
		),
		("readonly -a a=(1); (a[0]=2); echo \"rc=$? a=${a[0]}\"", "rc=1 a=1\n"),
		("declare -Ar m=([k]=5); (( m[k] += 3 )); echo \"rc=$? m=${m[k]}\"", "rc=1 m=5\n"),
	])
	.await;
}

/// One declaration word follows Bash's order: resolve the variable it names
/// and its attributes; refuse what must be refused (an element through
/// `readonly`, a name reference to something that is not a variable name, a
/// readonly target, a local hiding a readonly variable, an array of the other
/// kind, an element the array cannot take); create the new variable; and only
/// then evaluate the subscript, once, against that variable. So a refused word
/// runs nothing in its subscript and the words after it still run, and a new
/// local's subscript reads the new local. `unset` of an element of a readonly
/// array is refused before its subscript too. Each of these had run the
/// subscript first, ended the shell, written the element, or used the outer
/// variable.
#[tokio::test]
async fn a_declaration_word_is_checked_before_its_subscript_is_evaluated() {
	assert_bash(&[
		(
			"readonly -a a=(1 2); i=0; declare a[i++]=x; echo \"rc=$? i=$i a=${a[*]}\"",
			"rc=1 i=0 a=1 2\n",
		),
		(
			"readonly -a a=(1 2); i=0; declare \"a[i++]=x\"; echo \"rc=$? i=$i a=${a[*]}\"",
			"rc=1 i=0 a=1 2\n",
		),
		(
			"readonly -a a=(1 2); i=0; readonly a[i++]=x b=2; echo \"rc=$? i=$i b=$b\"",
			"rc=1 i=0 b=2\n",
		),
		(
			"readonly -a a=(1 2); i=0; f() { local a[i++]=x; echo \"in rc=$?\"; }; f; echo \"i=$i\"",
			"in rc=1\ni=0\n",
		),
		("readonly -a a=(1 2); declare a[1/0]=x; echo \"rc=$?\"", "rc=1\n"),
		(
			"readonly -a a=(1 2); i=0; unset 'a[i++]'; echo \"rc=$? i=$i a=${a[*]}\"",
			"rc=1 i=0 a=1 2\n",
		),
		("readonly -A m=([k]=1); unset 'm[k]'; echo \"rc=$? m=${m[k]-unset}\"", "rc=1 m=1\n"),
		(
			"a=(4 5); readonly 'a[1]=9'; echo \"rc=$?\"; declare -p a",
			"rc=1\ndeclare -a a=([0]=\"4\" [1]=\"5\")\n",
		),
		(
			"a=(4 5); readonly a[1]=9; echo \"rc=$?\"; declare -p a",
			"rc=1\ndeclare -a a=([0]=\"4\" [1]=\"5\")\n",
		),
		("v=old; declare -n 'v=7'; echo \"rc=$?\"; declare -p v", "rc=1\ndeclare -- v=\"old\"\n"),
		("i=0; declare -n 'a[i++]=v'; echo \"rc=$? i=$i\"", "rc=1 i=0\n"),
		(
			"declare -A m=([k]=5); declare -a 'm[src/a.ts]=9'; echo \"rc=$?\"; declare -p m",
			"rc=1\ndeclare -A m=([k]=\"5\" )\n",
		),
		("a=(1); declare -A a; echo \"rc=$?\"", "rc=1\n"),
		("a=(4); declare 'a[-2]=9' w=8; echo \"rc=$? w=${w-unset}\"", "rc=1 w=8\n"),
		("a=(2 3); f() { local a[a[0]]=9; declare -p a; }; f", "declare -a a=([0]=\"9\")\n"),
		("a=(2 3); f() { declare a[a[0]]=9; declare -p a; }; f", "declare -a a=([0]=\"9\")\n"),
		(
			"a=(2 3); f() { local -I a[a[0]]=9; declare -p a; }; f",
			"declare -a a=([0]=\"2\" [1]=\"3\" [2]=\"9\")\n",
		),
		(
			"a=(1 2); i=0; declare 'a[a[i++]++]=9'; echo \"i=$i\"; declare -p a",
			"i=1\ndeclare -a a=([0]=\"2\" [1]=\"9\")\n",
		),
		(
			"a=(3 5); f() { local -g 'a[]=9'; echo \"rc=$?\"; declare -p a; }; f",
			"rc=1\ndeclare -a a=([0]=\"3\" [1]=\"5\")\n",
		),
		("f() { local 'a[]=9'; echo \"rc=$?\"; declare -p a; }; f", "rc=1\ndeclare -a a\n"),
		("f() { local -g v=1; }; f; echo \"v=${v-unset}\"", "v=1\n"),
		(
			"declare -ar a=(4 5 6); i=0; readonly -n 'a[i++]=9' w=8; echo \"rc=$? i=$i w=${w-unset}\"",
			"rc=1 i=0 w=8\n",
		),
	])
	.await;
}

/// An arithmetic assignment that reads its target before writing it
/// (`a[i++] += 1`, `a[i++]++`, `++a[i++]`) evaluates the target's subscript
/// once, so it reads and writes one element. A plain `=` evaluates the value
/// before the subscript. The subscript had been evaluated twice, so the
/// value read from one element was written to the next.
#[tokio::test]
async fn an_arithmetic_assignment_evaluates_its_subscript_once() {
	assert_bash(&[
		("a=(1 2); i=0; (( a[i++] += 1 )); echo \"i=$i a=${a[*]}\"", "i=1 a=2 2\n"),
		("a=(1 2); i=0; (( a[i++]++ )); echo \"i=$i a=${a[*]}\"", "i=1 a=2 2\n"),
		("a=(1 2); i=0; (( ++a[i++] )); echo \"i=$i a=${a[*]}\"", "i=1 a=2 2\n"),
		("a=(1 2); i=0; echo $(( a[i++] *= 3 )); echo \"i=$i a=${a[*]}\"", "3\ni=1 a=3 2\n"),
		("a=(1 2); i=0; (( a[i++] = i )); echo \"i=$i a=${a[*]}\"", "i=1 a=0 2\n"),
		(
			"readonly -a a=(1 2); i=0; (( a[i++]++ )); echo \"rc=$? i=$i a=${a[*]}\"",
			"rc=1 i=1 a=1 2\n",
		),
	])
	.await;
}

/// `declare name[subscript]=value` writes the element the subscript names,
/// as `name[subscript]=value` does: an indexed array's subscript is
/// arithmetic, evaluated once, and may count from the end; an empty
/// subscript names nothing; a local that inherits an associative array
/// (`local -I`, `shopt -s localvar_inherit`) takes the subscript as its key.
/// The case attributes apply to an appended element's whole value.
#[tokio::test]
async fn declare_writes_the_element_a_subscript_names() {
	assert_bash(&[
		("declare -a a=(x y); i=1; declare a[i++]=z; echo \"i=$i ${a[*]}\"", "i=2 x z\n"),
		("declare -a a=(x y); declare a[-1]=z; echo \"${a[*]}\"", "x z\n"),
		("declare -A m; declare m[]=x; echo \"rc=$? ${#m[@]}\"", "rc=1 0\n"),
		(
			concat!(
				"declare -A m=([k]=old); ",
				"f() { local -I m[k]=new; echo \"${m[k]}/${m[0]-unset}\"; }; f",
			),
			"new/unset\n",
		),
		(
			concat!(
				"shopt -s localvar_inherit; declare -A m=([k]=old); ",
				"f() { local m[k]=new; echo \"${m[k]}/${m[0]-unset}\"; }; f",
			),
			"new/unset\n",
		),
		("a=(x); declare -u a[0]+=y; echo \"${a[0]}\"", "XY\n"),
		("declare -A m=([k]=x); declare -u m[k]+=y; echo \"${m[k]}\"", "XY\n"),
	])
	.await;
}

/// In POSIX mode a readonly variable that `export` or `readonly` refuses
/// ends the shell with status 1, since both are special builtins; `declare`,
/// which is not one, fails only that command. The shell already did this;
/// the readonly refusals the builtins now make themselves must keep it.
#[tokio::test]
async fn posix_mode_ends_the_shell_when_a_special_builtin_meets_a_readonly_variable() {
	for (code, expected) in [
		("set -o posix; readonly v=1; export v=2; echo reached", (1, "")),
		("set -o posix; readonly v=1; readonly v=2; echo reached", (1, "")),
		("set -o posix; readonly v=1; declare v=2; echo \"reached rc=$?\"", (0, "reached rc=1\n")),
	] {
		assert_eq!(run(code).await, (expected.0, expected.1.to_owned()), "{code}");
	}
}

/// An indexed subscript that does not evaluate (division by zero, a syntax
/// error, a variable that names itself) ends the shell with status 1, or only
/// the subshell it runs in: in `declare` or `local`, and in an arithmetic
/// command or `for (( ))`, where any other arithmetic error fails only that
/// command. `readonly` takes no element, so it refuses the word with status 1,
/// except in POSIX mode. The builtins had returned 0, the arithmetic command
/// had gone on, and a self-naming subscript had crashed the process.
#[tokio::test]
async fn a_declaration_subscript_that_does_not_evaluate_ends_the_shell() {
	for (code, expected) in [
		("declare -a a; declare a[1/0]=x; echo \"rc=$?\"", (1, "")),
		("declare -a a; declare a[1+]=x; echo \"rc=$?\"", (1, "")),
		("f() { local -a a; local a[1/0]=x; echo \"in rc=$?\"; }; f; echo \"out rc=$?\"", (1, "")),
		("declare -a a; ( declare a[1/0]=x; echo \"sub rc=$?\" ); echo \"rc=$?\"", (0, "rc=1\n")),
		("a=(1); (( a[1/0]++ )); echo reached", (1, "")),
		("a=(1); (( a[src/a.ts] = 1 )); echo reached", (1, "")),
		("a=(1); for (( a[1/0]=0; 0; )); do :; done; echo reached", (1, "")),
		("a=(1); k=k; (( a[ k ]++ )); echo reached", (1, "")),
		("a=(1); k=k; (( a[k]++ )); echo reached", (1, "")),
		("k=k; (( k++ )); echo \"rc=$?\"", (0, "rc=1\n")),
		("declare -a a; readonly a[1/0]=x; echo \"rc=$?\"", (0, "rc=1\n")),
		("set -o posix; declare -a a; readonly a[1/0]=x; echo \"rc=$?\"", (1, "")),
	] {
		assert_eq!(run(code).await, (expected.0, expected.1.to_owned()), "{code}");
	}
}

/// A variable whose value refers back to it through an expression
/// (`k='k+1'`, `a='b+1' b='a+1'`, an associative element `m[x]='m[x]+1'`) is
/// refused as too deep: an arithmetic command fails with status 1 and the
/// line goes on, while an arithmetic expansion or a subscript ends it. Such a
/// chain had overflowed the native stack and aborted the process.
#[tokio::test]
async fn an_arithmetic_expression_cycle_is_refused_not_a_crash() {
	for (code, expected) in [
		("k='k+1'; (( k )); echo \"rc=$?\"", (0, "rc=1\n")),
		("k='k+1'; echo $(( k )); echo reached", (1, "")),
		("a=(1); k='k+1'; (( a[k]++ )); echo reached", (1, "")),
		("k='(k)'; (( k )); echo \"rc=$?\"", (0, "rc=1\n")),
		("a='b+1'; b='a+1'; (( a )); echo \"rc=$?\"", (0, "rc=1\n")),
		("k='-k'; (( k )); echo \"rc=$?\"", (0, "rc=1\n")),
		("declare -A m=([x]='m[x]+1'); (( m[x] )); echo \"rc=$?\"", (0, "rc=1\n")),
	] {
		assert_eq!(run(code).await, (expected.0, expected.1.to_owned()), "{code}");
	}
}

/// In arithmetic, an associative array's subscript is a key, taken as
/// written, whether or not it reads as arithmetic (`c[src/a.ts]`); only an
/// indexed array's subscript is evaluated. Evaluating every subscript had made
/// `m[k]` read and write `m[0]`, and refused `c[src/a.ts]` as a parse error.
#[tokio::test]
async fn arithmetic_takes_an_associative_subscript_as_a_key() {
	assert_bash(&[
		("declare -A m=([k]=5); echo $(( m[k] ))", "5\n"),
		("declare -A m=([0]=7 [k]=5); echo $(( m[k] ))", "5\n"),
		("declare -A m=([k]=5); (( m[k]++ )); declare -p m", "declare -A m=([k]=\"6\" )\n"),
		("declare -A m=([k]=5); echo $(( m[k]++ + m[k] ))", "11\n"),
		("declare -A m; (( m[k] = 4 )); declare -p m", "declare -A m=([k]=\"4\" )\n"),
		("declare -A m=([k+1]=5); echo $(( m[k+1] ))", "5\n"),
		("declare -A m=([' k ']=5); echo $(( m[ k ] ))", "5\n"),
		(
			"declare -A c; f=src/a.ts; (( c[$f]++ )); (( c[$f]++ )); declare -p c",
			"declare -A c=([src/a.ts]=\"2\" )\n",
		),
		("declare -A c; (( c[a b] = 1 )); declare -p c", "declare -A c=([\"a b\"]=\"1\" )\n"),
		("declare -A m; m['08']=5; echo $(( m[08] ))", "5\n"),
		("declare -a a=(0 0 0 0); i=1; (( a[i+2] = 9 )); echo \"${a[3]} $(( a[ 3 ] ))\"", "9 9\n"),
	])
	.await;
}

/// An arithmetic command whose expression fails to evaluate (division by
/// zero, a syntax error, an assignment to a readonly variable or element)
/// reports the error and fails with status 1, and the commands after it
/// still run, in `(( ))` and in each clause of `for (( ))`. Such a failure had
/// ended the whole command line.
#[tokio::test]
async fn a_failed_arithmetic_command_fails_with_status_1() {
	assert_bash(&[
		("(( 1/0 )); echo \"rc=$?\"", "rc=1\n"),
		("(( 1 + )); echo \"rc=$?\"", "rc=1\n"),
		("readonly v=5; (( v += 3 )); echo \"rc=$? v=$v\"", "rc=1 v=5\n"),
		("declare -Ar m=([k]=5); (( m[k]++ )); echo \"rc=$? m=${m[k]}\"", "rc=1 m=5\n"),
		("f() { (( 1/0 )); echo \"in rc=$?\"; }; f; echo \"out rc=$?\"", "in rc=1\nout rc=0\n"),
		("for (( i=0; i<1/0; i++ )); do :; done; echo \"rc=$?\"", "rc=1\n"),
		("readonly r=1; for (( r=0; r<1; r++ )); do :; done; echo \"rc=$?\"", "rc=1\n"),
		("for (( i=0; i<2; i+=1/0 )); do echo \"i=$i\"; done; echo \"rc=$?\"", "i=0\nrc=1\n"),
	])
	.await;
}
