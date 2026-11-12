//! Variables: assignment with attributes (also on the in-place fast path),
//! `$RANDOM`, name references, dynamic scoping of `local`/`unset`,
//! `local -`, the temporary environment of `export`/`readonly`, `shopt`
//! and `SHELLOPTS`, array conversions, associative-array order, arrays
//! filled by `mapfile` and its callbacks.
//! Goldens: bash 5.3.20 (`bash -c`).

use crate::testkit::{FakeHost, Fault, MemFs, run_script};

fn run(src: &str) -> (String, String) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

#[test]
fn attributes_apply_on_every_assignment() {
	let (out, err) = run(
		"a=4+1; typeset -i a; a+=37; echo $a\ndeclare -ia iarr=(2 2 3); iarr+=1; declare -p \
		 iarr\ndeclare -u up=abc; up+=def; echo $up\ndeclare -l lo; lo=ABC; lo+=DeF; echo \
		 $lo\ndeclare -c ca; ca=hello; echo $ca\nreadonly ro=1; ro=2; echo \"st=$? ro=$ro\"\ns=ab; \
		 s+=cd; echo $s\nx=(1 2); x+=(3 4); x[1]=b; x[1]+=c; echo \"${x[@]}\"\n",
	);
	assert_eq!(
		out,
		"42\ndeclare -ai iarr=([0]=\"3\" [1]=\"2\" [2]=\"3\")\nABCDEF\nabcdef\nHello\nabcd\n1 bc 3 \
		 4\n"
	);
	assert_eq!(err, "bash: line 6: ro: readonly variable\n");
}

#[test]
fn random_is_seeded_by_assignment() {
	let (out, _) = run("RANDOM=42; echo $RANDOM $RANDOM $RANDOM; RANDOM=1+1; echo $RANDOM");
	assert_eq!(out, "17772 26794 1435\n846\n");
}

#[test]
fn name_references_read_assign_and_unset_their_target() {
	let (out, err) = run(
		"x=1; declare -n r=x; echo $r; r=2; echo $x; declare -p r; unset r; echo ${x-unset}; \
		 declare -n e; e=foo; e=bar; echo $foo; declare -n s=s",
	);
	assert_eq!(out, "1\n2\ndeclare -n r=\"x\"\nunset\nbar\n");
	assert_eq!(err, "bash: line 1: declare: s: nameref variable self references not allowed\n");
	let (out, _) = run(
		"f(){ local -n lr=$1; lr=fv; }; f gv; echo $gv; declare -n lv; A=1 B=2; for lv in A B; do \
		 echo $lv; done; declare -p lv",
	);
	assert_eq!(out, "fv\n1\n2\ndeclare -n lv=\"B\"\n");
}

#[test]
fn unset_of_a_callers_local_reveals_the_global() {
	let (out, _) = run(
		"inner(){ unset res; echo ${res-unset}; }; outer(){ local res=L; inner; echo ${res-unset}; \
		 }; res=G; outer; f(){ local x=4; unset x; echo ${x-unset}; }; x=out; f",
	);
	assert_eq!(out, "G\nG\nunset\n");
}

#[test]
fn local_dash_temporary_environment_and_export_n() {
	let (out, _) = run(
		"f(){ local -; set -u; local; }; f; echo $-; export X=1; export -n X; declare -p X; x=5 \
		 export x; declare -p x; y=1; y=6 readonly y; echo $y",
	);
	assert_eq!(out, "local -\nhBc\ndeclare -- X=\"1\"\ndeclare -x x=\"5\"\n6\n");
}

#[test]
fn shopt_listings_and_shellopts() {
	let (out, _) = run(
		"shopt nullglob extglob; echo $?; shopt -o -p xtrace; shopt -o xtrace; set -o posix; echo \
		 $POSIXLY_CORRECT; shopt -po posix; echo $SHELLOPTS",
	);
	assert_eq!(
		out,
		"nullglob            \toff\nextglob             \toff\n1\nset +o xtrace\nxtrace              \
		 \toff\ny\nset -o posix\nbraceexpand:hashall:interactive-comments:posix\n"
	);
}

#[test]
fn array_conversions_and_local_listing() {
	let (out, err) = run(
		"declare -a x=(1)\ndeclare -A x=([a]=b)\necho $?\ndeclare -A h=([k]=v)\ndeclare -a h\necho \
		 $?\nf(){ local v; local -p v; local -p w; }; f\necho $?",
	);
	assert_eq!(out, "1\n1\ndeclare -- v\n1\n");
	assert_eq!(
		err,
		"bash: line 2: x: cannot convert indexed to associative array\nbash: line 5: declare: h: \
		 cannot convert associative to indexed array\nbash: line 7: local: w: not found\n"
	);
	let (out, err) = run(
		"readonly g=1; f(){ local g=2; echo in $g; }; f; declare -A m=([one]=1 [two]=2 [three]=3); \
		 echo ${!m[@]}",
	);
	assert_eq!(out, "in 1\ntwo three one\n");
	assert_eq!(err, "bash: line 1: local: g: readonly variable\n");
}

#[test]
fn ignoreeof_follows_its_variable_and_local_dash() {
	let (out, _) = run(
		"IGNOREEOF=0; shopt -o ignoreeof; f(){ local -; set +o ignoreeof; shopt -o ignoreeof; }; f; \
		 shopt -o ignoreeof; echo $IGNOREEOF; unset IGNOREEOF; shopt -o ignoreeof",
	);
	let on = "ignoreeof           \ton\n";
	let off = "ignoreeof           \toff\n";
	assert_eq!(out, format!("{on}{off}{on}10\n{off}"));
}

#[test]
fn readonly_functions_and_declare_f_errors() {
	let (out, err) = run(
		"func(){ :; }; readonly -f func; unset -f func; echo $?; declare -f +r func; echo $?; \
		 declare -f -a func; echo $?; declare -f x=1; echo $?; unset /bin/sh; echo $?; declare -fp \
		 func",
	);
	let body = ["func () ", "{ ", "    :", "}"].join("\n");
	assert_eq!(out, format!("1\n1\n1\n1\n0\n{body}\ndeclare -fr func\n"));
	assert_eq!(
		err,
		"bash: line 1: unset: func: cannot unset: readonly function\nbash: line 1: declare: func: \
		 readonly function\nbash: line 1: declare: -a: invalid option\nbash: line 1: declare: \
		 cannot use `-f' to make functions\n"
	);
}

#[test]
fn let_keeps_subscript_quotes_with_assoc_expand_once() {
	let (out, err) = run("shopt -s assoc_expand_once\nlet 'a[\"\"]=1'; echo same\necho next\n");
	// `bash -c` abandons the whole string (a script file goes on with the
	// next line).
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 2: \"\": arithmetic syntax error: operand expected (error token is \"\"\"\")\n"
	);
}

#[test]
fn posix_special_builtin_name_errors_are_fatal() {
	let (_, err) = run("set -o posix; readonly a=a; readonly x-y z-w; echo after");
	assert_eq!(err, "bash: line 1: readonly: `x-y': not a valid identifier\n");
	let (out, err) = run("set -o posix; readonly a=a; unset -v a; echo after");
	assert_eq!(out, "");
	assert_eq!(err, "bash: line 1: unset: a: cannot unset: readonly variable\n");
}

#[test]
fn name_reference_targets_must_be_names() {
	let (out, err) = run(
		"r=/; declare -n r; echo $?; unset r\ndeclare -n r; r=/; echo $?; unset -n r\ndeclare -n r; \
		 declare r=/; echo $?; unset -n r\ndeclare -n r=\"\"; echo $?\ndeclare -r RO=x; declare -n \
		 RO; echo $?; declare -p RO",
	);
	assert_eq!(out, "1\n1\n1\n1\ndeclare -r RO=\"x\"\n");
	assert_eq!(
		err,
		"bash: line 1: declare: `/': invalid variable name for name reference\nbash: line 2: `/': \
		 not a valid identifier\nbash: line 3: declare: `/': not a valid identifier\nbash: line 4: \
		 declare: `': not a valid identifier\nbash: line 5: declare: RO: readonly variable\n"
	);
}

#[test]
fn element_assignment_to_a_new_variable_has_no_element_zero() {
	let (out, _) = run(
		"unset a; a[5]=x; declare -p a; declare x; x[5]=1; declare -p x; y=; y[2]=1; declare -p y; \
		 f(){ local z; z[3]=1; declare -p z; }; f",
	);
	assert_eq!(
		out,
		"declare -a a=([5]=\"x\")\ndeclare -a x=([5]=\"1\")\ndeclare -a y=([0]=\"\" \
		 [2]=\"1\")\ndeclare -a z=([3]=\"1\")\n"
	);
}

#[test]
fn array_attribute_on_unset_names_and_references() {
	let (out, _) = run(
		"declare x; declare -a x; declare -p x; declare -n foo; declare -a foo; declare -p foo; \
		 foo[0]=7; declare -p foo",
	);
	assert_eq!(out, "declare -a x\ndeclare -a foo\ndeclare -a foo=([0]=\"7\")\n");
}

#[test]
fn converted_assoc_arrays_list_in_small_table_order() {
	let (out, _) = run(
		"foo=help; declare -A foo=([zero]=zero [one]=one); declare -p foo; unset foo; declare -A \
		 foo=([zero]=zero [one]=one); declare -p foo; declare -A x=([a=b]=1 [@]=2 ['~x']=3 [x~]=4 \
		 [-]=5 [\"a b\"]=6); declare -p x",
	);
	assert_eq!(
		out,
		"declare -A foo=([zero]=\"zero\" [one]=\"one\" )\ndeclare -A foo=([one]=\"one\" \
		 [zero]=\"zero\" )\ndeclare -A x=([-]=\"5\" [a=b]=\"1\" [x~]=\"4\" [\"@\"]=\"2\" [\"a \
		 b\"]=\"6\" [\"~x\"]=\"3\" )\n"
	);
}

#[test]
fn array_subscript_errors_and_subscripted_compound_declare() {
	let (out, err) = run(
		"d=(x y); d=([0]=q []=abcde [1]=t)\ndeclare -p d; declare -ar c; c[-2]=4\ndeclare +a \
		 c\ndeclare -a e[10]=test; declare -a e[10]=\"(test)\"; declare -p e",
	);
	assert_eq!(out, "declare -a d=([0]=\"q\")\ndeclare -a e=([0]=\"test\")\n");
	assert_eq!(
		err,
		"bash: line 1: []=abcde: bad array subscript\nbash: line 2: c[-2]: bad array \
		 subscript\nbash: line 3: declare: c: readonly variable\n"
	);
}

// assoc9: a word written as an array reference (`d["$k"]`, `d[\"]`) names
// its key verbatim; a quoted or expanded one is parsed again and `d["]`
// is no reference. `unset -n` takes no subscript; `unset 'r[0]'` reaches
// the reference's target.
#[test]
fn unset_takes_written_array_references_verbatim() {
	let (out, err) = run(
		"declare -A d; k='\"'; d[$k]=1; unset -v d[\"$k\"]; d[$k]=2; unset -v d[\\\"]; declare -p \
		 d; d[$k]=3; unset -v \"d[$k]\"; x=\"d[$k]\"; unset -v $x; declare -p d; d[\"\\$k\"]=4; \
		 unset -v d[\\$k]; declare -p d; a=(1 2 3); unset -n \"a[1]\"; declare -n r=a; unset \
		 \"r[0]\"; declare -p a; unset -v \"a[1]x\"; echo $?",
	);
	assert_eq!(
		out,
		"declare -A d=()\ndeclare -A d=([\"\\\"\"]=\"3\" )\ndeclare -A d=([\"\\\"\"]=\"3\" \
		 )\ndeclare -a a=([1]=\"2\" [2]=\"3\")\n1\n"
	);
	assert_eq!(
		err,
		"bash: line 1: unset: `d[\"]': not a valid identifier\nbash: line 1: unset: `d[\"]': not a \
		 valid identifier\nbash: line 1: unset: `a[1]x': not a valid identifier\n"
	);
}

// assoc11: `declare -A` key-value pairs with an empty key report it as
// `declare` got it and skip the pair; an odd word out gets "".
#[test]
fn declare_kvpair_skips_empty_keys() {
	let (out, err) = run(
		"declare -A i=( \"\" 1 a 2 ); echo $?; declare -p i; k=; declare -A j=( $k 1 c 2 \"$k\" 3 \
		 ); declare -p j; declare -A w=(k1 v1 k2); declare -p w",
	);
	assert_eq!(
		out,
		"0\ndeclare -A i=([a]=\"2\" )\ndeclare -A j=([c]=\"2\" )\ndeclare -A w=([k1]=\"v1\" \
		 [k2]=\"\" )\n"
	);
	assert_eq!(
		err,
		"bash: line 1: '': bad array subscript\nbash: line 1: '': bad array subscript\nbash: line \
		 1: '': bad array subscript\n"
	);
}

// bash's `posix_initialize`: POSIX mode turns `expand_aliases` on; leaving
// it restores the non-interactive default (off).
#[test]
fn posix_mode_toggles_expand_aliases() {
	let (out, _) = run(
		"shopt -s expand_aliases; set -o posix; shopt -p expand_aliases; set +o posix; shopt -p \
		 expand_aliases; POSIXLY_CORRECT=1; shopt -p expand_aliases; unset POSIXLY_CORRECT; shopt \
		 -p expand_aliases",
	);
	assert_eq!(
		out,
		"shopt -s expand_aliases\nshopt -u expand_aliases\nshopt -s expand_aliases\nshopt -u \
		 expand_aliases\n"
	);
}

// varenv12: the persisted prefix variable keeps the temporary
// environment's export attribute, on a function's local too.
#[test]
fn posix_special_builtin_prefix_stays_exported() {
	let (out, _) = run(
		"set -o posix; foo=abc :; declare -p foo; f(){ local q=in; q=val :; declare -p q; }; q=out; \
		 f; declare -p q; g(){ x=abc : ; typeset +x x; declare -p x; }; g; declare -p x",
	);
	assert_eq!(
		out,
		"declare -x foo=\"abc\"\ndeclare -x q=\"val\"\ndeclare -- q=\"out\"\ndeclare -- x\ndeclare \
		 -x x=\"abc\"\n"
	);
}

#[test]
fn posix_special_builtin_prefix_reaches_the_global_through_a_call_prefix() {
	let (out, _) = run(
		"set -o posix; g(){ b=3 :; }; b=7 g; echo g=$b; f(){ a=3; }; a=7 f; echo a=$a; h(){ \
		 readonly c; }; c=7 h; echo c=$c",
	);
	assert_eq!(out, "g=3\na=\nc=\n");
}

#[test]
fn unset_expands_an_assoc_key_unless_expand_once() {
	let (out, _) = run(
		"declare -A assoc; var=x123; assoc['$var']=value; unset 'assoc[$var]'; declare -p assoc; \
		 assoc[x123]=1; unset 'assoc[$var]'; declare -p assoc; shopt -s assoc_expand_once; \
		 assoc['$var']=v; unset 'assoc[$var]'; declare -p assoc",
	);
	assert_eq!(
		out,
		"declare -A assoc=([\"\\$var\"]=\"value\" )\ndeclare -A assoc=([\"\\$var\"]=\"value\" \
		 )\ndeclare -A assoc=()\n"
	);
}

// Goldens below: bash 5.3.20 `bash -c` (array, quotearray and
// nameref groups).

#[test]
fn element_assignment_errors_carry_no_builtin_name() {
	let (out, err) = run(
		"a=(1); printf -v \"a[@]\" x; declare -a \"a[-9]=1\"; read \"a[-9]\" <<< x; echo $?; unset \
		 \"a[-9]\"; declare -p a",
	);
	assert_eq!(out, "1\ndeclare -a a=([0]=\"1\")\n");
	assert_eq!(
		err,
		"bash: line 1: a[@]: bad array subscript\nbash: line 1: a[-9]: bad array subscript\nbash: \
		 line 1: a[-9]: bad array subscript\nbash: line 1: unset: [-9]: bad array subscript\n"
	);
	// An arithmetic error in `test -v`'s subscript abandons the line.
	let (out, err) = run("test -v \"u[1+]\"; echo not reached");
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 1: 1+: arithmetic syntax error: operand expected (error token is \"+\")\n"
	);
}

#[test]
fn empty_subscripts_are_bad_where_written() {
	let (out, err) = run(
		"b=(1); declare \"b[]=x\"; echo $?; (( y[] + 1 )); echo $?; declare -p b; b[]=z; echo not \
		 reached",
	);
	assert_eq!(out, "1\n0\ndeclare -a b=([0]=\"1\")\n");
	assert_eq!(
		err,
		"bash: line 1: b[]: bad array subscript\nbash: line 1: y[]: bad array subscript\nbash: line \
		 1: y[]: bad array subscript\nbash: line 1: b[]: bad array subscript\n"
	);
}

#[test]
fn compound_values_given_as_strings_are_expanded() {
	let (out, err) = run(
		"x=\"a b\"; y='($(echo Darwin))'; declare -a a=$x c=\"(1 2)\" d='($a)' e=$y; declare -p a c \
		 d e; unset a c d e; declare -A a=$x c=\"(1 2)\" d='($a)' e=$y; declare -p a c d e",
	);
	assert_eq!(
		out,
		"declare -a a=([0]=\"a b\")\ndeclare -a c=([0]=\"1\" [1]=\"2\")\ndeclare -a d=([0]=\"a\" \
		 [1]=\"b\")\ndeclare -a e=([0]=\"Darwin\")\ndeclare -A a=([0]=\"a b\" )\ndeclare -A \
		 c=([1]=\"2\" )\ndeclare -A d=([\"a b\"]=\"\" )\ndeclare -A e=([Darwin]=\"\" )\n"
	);
	assert_eq!(err, "");
	let (out, err) = run(
		"declare a[1]=\"(var)\"; declare -p a; d=(x \"y z\"); declare -a f='(\"${d[@]}\")'; declare \
		 -p f; declare -a v=\"([\\$(echo total 0)]=1 [2]=2)\"; echo not reached",
	);
	assert_eq!(out, "declare -a a=([1]=\"(var)\")\ndeclare -a f=([0]=\"x\" [1]=\"y z\")\n");
	assert_eq!(
		err,
		"bash: line 1: warning: a[1]=(var): quoted compound array assignment deprecated\nbash: line \
		 1: total 0: arithmetic syntax error in expression (error token is \"0\")\n"
	);
}

#[test]
fn whole_array_defaults_and_negative_subscripts_of_unset_arrays() {
	let (out, err) = run(
		"declare -A A; echo ${A[@]:=foo}; declare -p A; declare -ar c; echo ${c[-4]}x; echo \
		 ${u[@]:=x}; echo not reached",
	);
	assert_eq!(out, "foo\ndeclare -A A=([\"@\"]=\"foo\" )\nx\n");
	assert_eq!(
		err,
		"bash: line 1: c: bad array subscript\nbash: line 1: u[@]: bad array subscript\n"
	);
}

#[test]
fn read_a_and_mapfile_need_an_indexed_array() {
	let (out, err) = run(
		"declare -A A; read -a A <<< x; echo $?; declare -n r; mapfile r <<< x; declare -p r; \
		 declare -n ref=XXX[0]; read -a ref <<< \"A B\"; ref+=(y); echo not reached",
	);
	assert_eq!(out, "1\ndeclare -a r=([0]=$'x\\n')\n");
	assert_eq!(
		err,
		"bash: line 1: read: A: not an indexed array\nbash: line 1: warning: r: removing nameref \
		 attribute\nbash: line 1: read: `XXX[0]': not a valid identifier\nbash: line 1: `XXX[0]': \
		 not a valid identifier\n"
	);
}

/// `eval`, `.` and `$( )` text sees the caller's `$?` until its first
/// command runs; text without a command (empty, blanks, a comment) ends
/// with status 0.
#[test]
fn dollar_question_carries_into_eval_source_and_substitutions() {
	let fs = MemFs::new();
	fs.add_file("/work/s", b"echo \"src-in=$?\"\n", 0o644);
	fs.add_file("/work/c", b"# only a comment\n", 0o644);
	let src = "false; eval 'echo in=$?'; false; eval '#c'; echo comment=$?; false; eval ' '; echo \
	           blank=$?; false; eval 'x=$?'; echo x=$x; (exit 3); eval 'eval \"echo \
	           nested=\\$?\"'; f() { return 4; }; f; eval 'echo fn=$?'; false; . /work/s; false; . \
	           /work/c; echo comment-src=$?; false; x=$(); echo empty-cs=$?; false; x=$( ); echo \
	           blank-cs=$?; (exit 3); x=$(echo $?); echo inner=$x";
	let out = run_script(FakeHost::new().with_fs(fs), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stderr), "");
	assert_eq!(
		String::from_utf8_lossy(&out.stdout)
			.lines()
			.collect::<Vec<_>>(),
		[
			"in=1",
			"comment=0",
			"blank=0",
			"x=1",
			"nested=3",
			"fn=4",
			"src-in=1",
			"comment-src=0",
			"empty-cs=0",
			"blank-cs=0",
			"inner=3",
		]
	);
}

/// bash runs a `mapfile -C` callback before its line is stored, and the
/// callback reads what follows that line: from a pipe (read a byte at a
/// time) and from a file (read ahead, then given back).
#[test]
fn mapfile_callbacks_read_the_input_after_their_line() {
	let fs = MemFs::new();
	fs.add_file("/work/lines", b"1\n2\n3\n4\n", 0o644);
	let src = "cb() { read -r x; echo \"cb:$1:$2:$x\"; }; printf '1\\n2\\n3\\n4\\n' | { mapfile -t \
	           -C cb -c 1 arr; echo \"arr=${arr[*]}\"; }; { mapfile -t -C cb -c 1 arr; echo \
	           \"arr=${arr[*]}\"; } < /work/lines; { mapfile -t -C cb -c 2 -n 3 arr; read -r rest; \
	           echo \"arr=${arr[*]} rest=$rest\"; } < /work/lines";
	let out = run_script(FakeHost::new().with_fs(fs), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stderr), "");
	assert_eq!(
		String::from_utf8_lossy(&out.stdout),
		"cb:0:1:2\ncb:1:3:4\narr=1 3\ncb:0:1:2\ncb:1:3:4\narr=1 3\ncb:1:2:3\narr=1 2 4 rest=\n"
	);
}

/// A callback sees the lines before its own stored, and what it does to
/// the array stays; `mapfile`'s status is its own, not the callback's.
#[test]
fn mapfile_callbacks_see_and_change_the_array_as_it_fills() {
	let (out, err) = run(
		"printf 'a\\nb\\nc\\nd\\ne\\n' | { mapfile -t -C 'echo ${#arr[@]}' -c 2 -s 1 -O 3 -n 3 arr; \
		 echo \"st=$? ${!arr[*]} ${arr[*]}\"; }; printf 'a\\nb\\n' | { mapfile -C false -c 1 a2; \
		 echo st=$?; }; printf 'x\\ny\\nz' | { cb() { unset arr; }; mapfile -t -C cb -c 1 arr; \
		 declare -p arr; }; printf 'x\\ny\\n' | { cb() { readonly arr; }; mapfile -C cb -c 1 arr; \
		 echo st=$?; declare -p arr; }",
	);
	assert_eq!(
		out,
		"1 4 c\nst=0 3 4 5 b c d\nst=0\ndeclare -a arr=([2]=\"z\")\nst=1\ndeclare -ar arr=()\n"
	);
	assert_eq!(err, "bash: line 1: arr: readonly variable\n");
}

/// `name+=(…)` keeps a set scalar as element 0, but a new or
/// declared-but-unset variable has none.
#[test]
fn appending_a_list_to_an_unset_variable_adds_no_element_zero() {
	let (out, err) = run(
		"unset a; a+=([3]=x); declare -p a; f() { local l; l+=([4]=y); declare -p l; }; f; declare \
		 b; b+=([2]=z); declare -p b; c=; c+=([1]=z); declare -p c; d=s; d+=(t); declare -p d",
	);
	assert_eq!(
		out,
		"declare -a a=([3]=\"x\")\ndeclare -a l=([4]=\"y\")\ndeclare -a b=([2]=\"z\")\ndeclare -a \
		 c=([0]=\"\" [1]=\"z\")\ndeclare -a d=([0]=\"s\" [1]=\"t\")\n"
	);
	assert_eq!(err, "");
}

#[test]
fn name_reference_values_are_checked_where_bash_checks_them() {
	let (out, err) = run(
		"s=/; unset -n s; declare -p s; var=foo; declare -n ref=var[0]; readonly ref; declare -r \
		 ref; declare -p ref var",
	);
	assert_eq!(
		out,
		"declare -- s=\"/\"\ndeclare -n ref=\"var[0]\"\ndeclare -ar var=([0]=\"foo\")\n"
	);
	assert_eq!(err, "bash: line 1: readonly: `var[0]': not a valid identifier\n");
	let (out, err) = run(
		"declare -n x; declare x=42; declare -p x; declare -n r; ((r=0)); for r in /; do :; done; \
		 declare -p r",
	);
	assert_eq!(out, "declare -n r\n");
	assert_eq!(
		err,
		"bash: line 1: declare: `42': not a valid identifier\nbash: line 1: declare: x: not \
		 found\nbash: line 1: ((: `0': not a valid identifier\nbash: line 1: `/': not a valid \
		 identifier\n"
	);
	let (out, err) = run(
		"declare -n ref=re ref+=f; declare -p ref; declare -n r2=var r2+=[@]; declare -p r2; \
		 declare -rn ro=bar; declare +n ro; declare -n array=\"(one)\"; declare -n arr2=(one two); \
		 declare -p arr2",
	);
	assert_eq!(
		out,
		"declare -n ref=\"re\"\ndeclare -n r2=\"var[@]\"\ndeclare -a arr2=([0]=\"one\" \
		 [1]=\"two\")\n"
	);
	assert_eq!(
		err,
		"bash: line 1: ref: nameref variable self references not allowed\nbash: line 1: declare: \
		 ro: readonly variable\nbash: line 1: declare: `(one)': invalid variable name for name \
		 reference\nbash: line 1: declare: arr2: reference variable cannot be an array\n"
	);
}

#[test]
fn references_to_elements_of_themselves_and_dangling_references() {
	let (out, err) = run(
		"declare -n a=b b; b=a[1]; a=foo; declare -p a b; declare -n xref; declare -a xref[1]=one; \
		 declare -p xref",
	);
	assert_eq!(
		out,
		"declare -a a=([1]=\"foo\")\ndeclare -n b=\"a[1]\"\ndeclare -a xref=([1]=\"one\")\n"
	);
	assert_eq!(
		err,
		"bash: line 1: warning: a: removing nameref attribute\nbash: line 1: warning: xref: \
		 removing nameref attribute\n"
	);
	let (out, err) = run("f() { local -n a=a[0]; a=X; }; a=(0); f; declare -p a");
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 1: local: warning: a: circular name reference\nbash: line 1: warning: a: \
		 circular name reference\nbash: line 1: `a[0]': not a valid identifier\n"
	);
}

#[test]
fn attributes_given_with_and_without_the_reference() {
	let (out, err) = run(
		"unset bar; declare -n foo=bar; declare +n -i foo=7+4; declare -p foo bar; declare -i iv; \
		 declare -n iv=q; declare -p iv; declare -ai a=(1); declare -in b=\"a[0]\"; declare -p b",
	);
	assert_eq!(out, "declare -- foo=\"bar\"\ndeclare -i bar=\"11\"\ndeclare -n iv=\"q\"\n");
	assert_eq!(err, "bash: line 1: declare: b: not found\n");
	let (out, err) = run(
		"declare -n ref=foo; f() { declare -n ref=var; declare -g ref=(X); declare -p var; }; f; \
		 declare -p foo",
	);
	assert_eq!(out, "declare -a foo=([0]=\"X\")\n");
	assert_eq!(err, "bash: line 1: declare: var: not found\n");
}

// Golden: bash 5.3.20 (upstream exp8.sub, array32.sub): an arithmetic
// error in a compound element's subscript keeps the elements before it in
// the emptied array, then abandons the line.
#[test]
fn compound_subscript_arith_error_keeps_the_elements_before_it() {
	let (out, err) = run("trap 'declare -p a' EXIT; a=(1 2); a=( [2]=b [1+]=hi )");
	assert_eq!(out, "declare -a a=([2]=\"b\")\n");
	assert_eq!(
		err,
		"bash: line 1: 1+: arithmetic syntax error: operand expected (error token is \"+\")\n"
	);
	let (out, err) = run("trap 'declare -p b' EXIT; b=(1 2); declare -a b=( [x y]=1 )");
	assert_eq!(out, "declare -a b=()\n");
	assert_eq!(
		err,
		"bash: line 1: x y: arithmetic syntax error in expression (error token is \"y\")\n"
	);
}

// Golden: bash 5.3.20 (upstream nameref14.sub, nameref12.sub:104): `+=`
// in a prefix assignment through a reference appends to the target; an
// element of an unset reference is no name; a compound value makes it an
// array.
#[test]
fn unset_references_and_appending_prefix_assignments() {
	let (out, err) = run(
		"declare -n ref=var; var=foo; f() { echo $var; }\nref+=X f; echo $var\ndeclare -n \
		 r\nr[0]=x; echo no\ndeclare -p r\nr+=(a)\ndeclare -p r\ndeclare -n s; declare s=(y); \
		 declare -p s",
	);
	assert_eq!(out, "fooX\nfoo\ndeclare -n r\ndeclare -a r=([0]=\"a\")\ndeclare -a s=([0]=\"y\")\n");
	assert_eq!(
		err,
		"bash: line 4: `': not a valid identifier\nbash: line 6: warning: r: removing nameref \
		 attribute\nbash: line 8: warning: s: removing nameref attribute\n"
	);
}

// Golden: bash 5.3.20 (upstream nameref11.sub:26): `{var}` naming no
// variable reports it under the command's name.
#[test]
fn fd_variable_errors_name_the_command() {
	let (_, err) = run("declare -n r; exec {r}>&2; echo hi {r}>&2");
	assert_eq!(
		err,
		"bash: line 1: exec: `10': not a valid identifier\nbash: line 1: r: cannot assign fd to \
		 variable\nbash: line 1: echo: `10': not a valid identifier\nbash: line 1: r: cannot assign \
		 fd to variable\n"
	);
}

// Golden: bash 5.3.20 (upstream set-x1.sub:18, set-x2.sub): a
// `BASH_XTRACEFD` naming no open fd is reported; a compound assignment is
// traced as written, `$'…'` single-quoted.
#[test]
fn xtrace_fd_values_and_compound_assignment_traces() {
	let (out, err) =
		run("BASH_XTRACEFD=7\nBASH_XTRACEFD=x\nBASH_XTRACEFD=\ndeclare -p BASH_XTRACEFD");
	assert_eq!(out, "declare -- BASH_XTRACEFD=\"\"\n");
	assert_eq!(
		err,
		"bash: line 1: BASH_XTRACEFD: 7: invalid value for trace file descriptor\nbash: line 2: \
		 BASH_XTRACEFD: x: invalid value for trace file descriptor\n"
	);
	let (_, err) = run("set -x\nm=( \\|  [k]=$'\\t' \"a b\" $@ 'q' )\nset +x");
	assert_eq!(err, "+ m=(\\| [k]='\t' \"a b\" $@ 'q')\n+ set +x\n");
}

// Golden: bash 5.3.20 (upstream array.tests): `declare -p` lists
// `BASH_ARGC`/`BASH_ARGV` as stored: the top-level base is there only
// after a read pushed it.
#[test]
fn listing_shows_the_argument_base_after_a_read() {
	let (out, _) = run("set -- a b; declare -p");
	assert!(out.contains("\ndeclare -a BASH_ARGC=()\ndeclare -a BASH_ARGV=()\n"), "{out}");
	let (out, _) = run("set -- a b; : $BASH_ARGC; declare -p");
	assert!(
		out.contains(
			"\ndeclare -a BASH_ARGC=([0]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"b\" [1]=\"a\")\n"
		),
		"{out}"
	);
}

// Arithmetic assigns in place where the variable is bound (a local, an
// element, a nameref's target, a subshell's copy) and reads plain decimal
// values without compiling them.
#[test]
fn arithmetic_assigns_in_place_at_every_level() {
	let (out, err) = run(
		"f() { local n=5; ((n++)); ((g+=n)); echo \"f:$n:$g\"; }\ng=1; f; echo \
		 \"g:$g:${n-unset}\"\na=(1 2 3); ((a[1]=7)); ((a[5]++)); echo \"${a[@]} ${!a[@]}\"\ndeclare \
		 -A m=([k]=1); ((m[k]+=4)); echo \"${m[k]}\"\ndeclare -n r=a[2]; ((r=9)); echo \
		 \"${a[2]}\"\ndeclare -n q=g; ((q*=2)); echo \"$g\"\ns=abc; ((s=12)); echo \"$s\"; declare \
		 -i t=3; ((t+=1)); declare -p t\n( ((g=100)); echo \"sub:$g\" ); echo \"parent:$g\"\nx=$( \
		 ((g=50)); echo \"$g\" ); echo \"$x:$g\"\nreadonly ro=1; ((ro=2)); echo \"st=$? \
		 ro=$ro\"\nv=\"  -42 \"; w=010; echo $((v*2)) $((v)) $((w)) $((v+w))\nu=7; h() { local u; \
		 ((u++)); echo \"h:$u\"; }; h; echo \"u:$u\"\nset -u; echo $((g+1)); ( echo $((nope+1)) ); \
		 echo \"after=$?\"\n",
	);
	assert_eq!(
		out,
		"f:6:7\ng:7:unset\n1 7 3 1 0 1 2 5\n5\n9\n14\n12\ndeclare -i \
		 t=\"4\"\nsub:100\nparent:14\n50:14\nst=1 ro=1\n-84 -42 8 -34\nh:1\nu:7\n15\nafter=1\n"
	);
	assert_eq!(err, "bash: line 10: ro: readonly variable\nbash: line 13: nope: unbound variable\n");
}

// Option reads follow `set`/`shopt`/`local -`, subshells and `$( )` (which
// turns `errexit` off unless `inherit_errexit`), with `SHELLOPTS`/`BASHOPTS`
// in step; `enable -n` in a subshell stays there.
#[test]
fn options_follow_scopes_subshells_and_comsubs() {
	let (out, err) = run(
		"echo \"$SHELLOPTS\"\nf() { local -; set -f; set -o pipefail; echo \"in:$SHELLOPTS\"; }; f; \
		 echo \"out:$SHELLOPTS\"\n( set -e; echo \"sub:$SHELLOPTS\" ); echo \
		 \"parent:$SHELLOPTS\"\nset -e; echo \"cs:$(echo $SHELLOPTS)\"; shopt -s inherit_errexit; \
		 echo \"ie:$(echo $SHELLOPTS)\"; set +e; shopt -u inherit_errexit\nshopt -s extglob; ( \
		 shopt -u extglob; shopt extglob ); shopt extglob\n[[ :$BASHOPTS: == *:extglob:* ]] && echo \
		 has\nset -f; echo /*; ( set +f; echo \"$-\" ); echo \"$-\"; set +f\nenable -n echo; ( \
		 enable echo; echo sub ); enable -n; enable echo; echo back\n",
	);
	assert_eq!(
		out,
		"braceexpand:hashall:interactive-comments\nin:braceexpand:hashall:interactive-comments:\
		 noglob:pipefail\nout:braceexpand:hashall:interactive-comments\nsub:braceexpand:errexit:\
		 hashall:interactive-comments\nparent:braceexpand:hashall:interactive-comments\ncs:\
		 braceexpand:hashall:interactive-comments\nie:braceexpand:errexit:hashall:\
		 interactive-comments\nextglob             \toff\nextglob             \
		 \ton\nhas\n/*\nhBc\nfhBc\nsub\nenable -n echo\nback\n"
	);
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 `bash -c`: a fatal expansion error exits a subshell
// (`( )`, `$( )`, nested) with 1 (`execute_in_subshell` keeps the failure
// status) and the `-c` shell itself with 127 (`run_one_command`).
#[test]
fn unbound_variable_exits_subshells_with_one_and_the_c_shell_with_127() {
	let src = "set -u; ( echo $nope ); echo \"s:$?\"; x=$(echo $nope); echo \"c:$?\"; ( \
	           v=${nope}x; echo no ); echo \"a:$?\"; ( ( echo $((nope)) ); echo \"in:$?\"; exit 4 \
	           ); echo \"o:$?\"; echo $nope; echo never";
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "s:1\nc:1\na:1\nin:1\no:4\n");
	assert_eq!(
		out.stderr
			.split(|&c| c == b'\n')
			.filter(|l| !l.is_empty())
			.count(),
		5
	);
	assert_eq!(out.status, 127);
}

// Golden: bash 5.3.20 (`shopt_set_debug_mode`): `extdebug` turns
// `errtrace` and `functrace` on and off with it.
#[test]
fn extdebug_sets_errtrace_and_functrace() {
	let (out, _) = run("shopt -s extdebug; echo $-; shopt -u extdebug; echo $-");
	assert_eq!(out, "hBETc\nhBc\n");
}
