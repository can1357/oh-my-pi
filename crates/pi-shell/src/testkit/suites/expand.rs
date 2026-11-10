//! Word expansion rules: tilde-prefixes, operator words, `$*`/`$@` joining
//! and splitting, declaration-builtin arguments, brace expansion of
//! `$name`, here-document text. Goldens: bash 5.3.20 (and the upstream
//! `tilde*.right` files where macOS bash ignores `HOME`).

use crate::testkit::{FakeHost, Fault, MemFs, run_script};

fn run(src: &str) -> (String, String) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

/// Prints `$#:` and every argument in `<…>`.
const P: &str = "p() { printf '%s' \"$#:\"; for a; do printf '<%s>' \"$a\"; done; echo; }\n";

fn out(src: &str) -> String {
	let (out, err) = run(&format!("{P}{src}"));
	assert_eq!(err, "");
	out
}

// upstream tilde.tests / tilde.right
#[test]
fn tilde_prefix_must_be_unquoted_and_end_in_the_literal() {
	assert_eq!(
		out(
			"HOME=/usr/xyz; echo ~ch\\et ~/\"foo\" ~\\chet/bar ~chet\"\"/bar; USER=root; echo ~$USER"
		),
		"~chet /usr/xyz/foo ~chet/bar ~chet/bar\n~root\n"
	);
}

#[test]
fn tilde_after_colons_in_assignments() {
	assert_eq!(
		out(
			"HOME=/usr/xyz; XPATH=/bin:.\npath=/usr/ucb:~/bin:~/tmp/bin; echo \
			 $path\nPPATH=$XPATH:~/bin; echo \"$PPATH\"\nPPATH=\"$XPATH:~/bin\"; echo \
			 \"$PPATH\"\nADDPATH=PATH=~/bin:$XPATH; echo $ADDPATH\nh=HOME=~; echo $h"
		),
		"/usr/ucb:/usr/xyz/bin:/usr/xyz/tmp/bin\n/bin:.:/usr/xyz/bin\n/bin:.:~/bin\nPATH=~/bin:/bin:\
		 .\nHOME=~\n"
	);
}

// upstream tilde.tests, tilde2.tests, tilde3.sub
#[test]
fn tilde_in_assignment_like_arguments_outside_posix_mode() {
	assert_eq!(
		out(
			"HOME=/home/xyz; echo foo=~:~ make FOO=~/m ./x=~\nexport E=x:~; echo \"$E\"; typeset \
			 T=~/m; echo \"$T\"\nset -o posix\necho foo=~:~\nfoo=~:~; echo $foo; export F=~; echo \
			 \"$F\""
		),
		"foo=/home/xyz:/home/xyz make FOO=/home/xyz/m \
		 ./x=~\nx:/home/xyz\n/home/xyz/m\nfoo=~:~\n/home/xyz:/home/xyz\n/home/xyz\n"
	);
}

#[test]
fn tilde_names_the_current_user_and_heredocs_keep_it() {
	assert_eq!(
		out(
			"HOME=/h; echo ~tester/x ~nosuchuser\nread -r v <<E\n~/bin ${none-a$'x'b}\nE\necho \"$v\""
		),
		"/home/tester/x ~nosuchuser\n~/bin a$'x'b\n"
	);
}

#[test]
fn declaration_builtin_assignments_are_not_split_or_globbed() {
	assert_eq!(
		out(
			"x='a b'; declare y=$x; echo \"$y\"; export z=$x; echo \"$z\"; q='*'; declare g=$q; echo \
			 \"$g\"; export \"k\"=$x; echo \"$k\""
		),
		"a b\na b\n*\na\n"
	);
}

#[test]
fn unquoted_operator_words_are_split() {
	assert_eq!(
		out(
			"x=x e=; p ${x:+ \"\"} ${x:+\"\" } ${x:+\"$e\" \"$e\"\"\"} ${u:-a b}\nIFS=:; p \
			 ${u:-a:b}; IFS=$' \\t\\n'\nset --; p ${x+\"$@\" \"$@\"} ${*-x} ${@-y}\nset -- ''; p \
			 ${x+\"$@\" \"$@\"}\np \"${u+x}\" . \"${v+x}\""
		),
		"6:<><><><><a><b>\n2:<a><b>\n2:<x><y>\n2:<><>\n3:<><.><>\n"
	);
}

#[test]
fn star_joins_with_the_first_ifs_character() {
	assert_eq!(
		out(
			"set -- 1 2\nIFS=\na=$*; b=\"$*\"; c=$@; d=${v-$*}; e=\"${v-$*}\"; : ${f=$*}\np \"$a\" \
			 \"$b\" \"$c\" \"$d\" \"$e\" \"$f\"\np ${v-$@} ${v-$*} ${v-\"$*\"}\nIFS=:\na=$*; \
			 b=${v-$*}; c=$@; p \"$a\" \"$b\" \"$c\""
		),
		"6:<12><12><1 2><1 2><12><12>\n5:<1><2><1><2><12>\n3:<1:2><1:2><1 2>\n"
	);
}

#[test]
fn unquoted_at_in_operator_words_is_split_and_rejoined() {
	assert_eq!(
		out(
			"set -- 'a b' '' 'c:d'\nIFS=:\np ${v-$@} ${v-x$@y} ${v-$@:x} ${v-$*} $@\nIFS=': '\np \
			 ${v-$@} ${v-$*}\nIFS=$' \\t\\n'\np ${v-$@}"
		),
		"11:<a b  c:d><xa b  c:dy><a b  c:d x><a b><><c><d><a b><><c><d>\n8:<a \
		 b><><c:d><a><b><><c><d>\n3:<a><b><c:d>\n"
	);
}

#[test]
fn brace_expansion_extends_unbraced_names() {
	assert_eq!(out("var=baz varx=vx vary=vy; echo $var{x,y} ${var}{x,y}"), "vx vy bazx bazy\n");
}

// Golden: bash 5.3.20; upstream new-exp9.sub.
#[test]
fn compound_words_of_ordinary_commands_expand_as_text() {
	assert_eq!(out("a=(1 2); eval w=(\\\"\\${!a[@]}\\\"); echo \"${w[@]}\" ${#w[@]}"), "0 1 2\n");
}

// Golden: bash 5.3.20.
#[test]
fn namerefs_read_their_target_and_indirect_to_its_name() {
	assert_eq!(
		out(
			"x=1; declare -n r=x; echo $r ${!r}; r=2; echo $x; a=(p q r); declare -n e=a[1]; echo $e \
			 ${#e} ${!e}; i=3; declare -n ri=i; echo $((ri+1)); ((ri=7)); echo $i"
		),
		"1 x\n2\nq 1 a[1]\n4\n7\n"
	);
}

// Golden: bash 5.3.20; upstream new-exp10.sub / new-exp13.sub.
#[test]
fn assignment_and_attribute_transforms() {
	assert_eq!(
		out(
			"A=(ab \"cd ef\"); echo \"${A@A}\"; declare -A H=([k]=v); echo \"${H@A}\"; echo \
			 \"${H[@]@A}\"; x=1; echo \"${x@A}\"; declare -i n=3; echo \"${n@A}\"; declare -lr V; \
			 echo \"${V@A}|${V@a}|${V[@]@A}\"; set -- a \"b c\"; echo \"${@@A}\"; e=(); echo \
			 \"[${e[@]@A}]\"; echo \"${A[1]@A}\" \"${A[@]@a}\""
		),
		"declare -a A='ab'\ndeclare -A H\ndeclare -A H=([k]=\"v\" )\nx='1'\ndeclare -i \
		 n='3'\ndeclare -rl V|rl|declare -rl V\nset -- 'a' 'b c'\n[declare -a e=()]\ndeclare -a \
		 A='cd ef' a a\n"
	);
}

// Golden: bash 5.3.20; upstream new-exp16.sub.
#[test]
fn pattern_replacement_ampersand_follows_patsub_replacement() {
	assert_eq!(
		out(
			"s=abcdefg; shopt -u patsub_replacement; echo ${s/abc/&x}; shopt -s patsub_replacement; \
			 echo ${s/abc/&x} ${s/abc/\\&x} ${s/abc/\"&\"x} ${s/abc/\\\\&}; var=; echo \
			 \"[${var//*/x}]\""
		),
		"&xdefg\nabcxdefg &xdefg &xdefg \\abcdefg\n[x]\n"
	);
}

// Golden: bash 5.3.20 (`bash -c`, one per run); upstream dollar-at-star:37.
#[test]
fn indirection_errors_name_the_problem() {
	let (_, err) = run("v=bad-var; echo ${!v}");
	assert_eq!(err, "bash: line 1: bad-var: invalid variable name\n");
	let (_, err) = run("unset v; echo ${!v}");
	assert_eq!(err, "bash: line 1: v: invalid indirect expansion\n");
	let (_, err) = run("set -- ''; echo ${!1}");
	assert_eq!(err, "bash: line 1: : invalid variable name\n");
	assert_eq!(out("set --; foo=${!*}; foo=${!@}; echo ok"), "ok\n");
}

// Golden: bash 5.3.20; upstream new-exp15.sub.
#[test]
fn indirect_transforms_use_the_named_variable() {
	let (out, err) = run(
		"declare -ia foo=(); bar=foo; echo ${!bar@a}; echo ${!bar@A}; declare -a f2=([1]=one); set \
		 -u; echo ${f2@a}; b2=f2; echo ${!b2@a}; echo ${!bar@a}",
	);
	assert_eq!(out, "ai\ndeclare -ai foo\na\na\n");
	assert_eq!(err, "bash: line 1: !bar: unbound variable\n");
}

// Golden: bash 5.3.20; upstream assoc9.sub:74.
#[test]
fn assign_default_sets_the_element() {
	assert_eq!(
		out(
			"declare -A a; b=\"80's\"; : ${a[$b]:=X}; declare -p a; c=(1); : ${c[3]:=y}; echo ${c[@]}"
		),
		"declare -A a=([\"80's\"]=\"X\" )\n1 y\n"
	);
}

// Golden: bash 5.3.20 (array.tests).
#[test]
fn negative_subscript_past_the_start_warns() {
	let (out, err) = run("c=(1 2); echo \"[${c[-4]}]\" \"[${c[-2]}]\"; echo after");
	assert_eq!(out, "[] [1]\nafter\n");
	assert_eq!(err, "bash: line 1: c: bad array subscript\n");
}

// Golden: bash 5.3.20; upstream nquote2.sub:28, quote1.sub:30/56.
#[test]
fn quoted_replacement_backslashes_quote() {
	assert_eq!(
		out(
			"v=\"'\"; p \"${v/\\'/\\'}\"; x=\"a'b'c\"; echo \"${x//\\'/\\'}\"; test=\"w'd\"; echo \
			 \"'${test//\"'\"/\\'\\\\'\\'}'\""
		),
		"1:<'>\na'b'c\n'w'\\\\d'\n"
	);
}

// Golden: bash 5.3.20; upstream assoc1.sub.
#[test]
fn bash_cmds_reads_the_command_hash_table() {
	assert_eq!(
		out(
			"hash -r; hash -p /usr/sbin/foo foo; hash -p /usr/local/bin/qux qux; echo \
			 ${!BASH_CMDS[@]}; BASH_CMDS[blat]=/sbin/blat; BASH_CMDS[sh]=/bin/sh; echo \
			 ${!BASH_CMDS[@]}; echo ${BASH_CMDS[qux]} ${#BASH_CMDS[@]}"
		),
		"foo qux\nfoo sh blat qux\n/usr/local/bin/qux 4\n"
	);
}

// Upstream array23.sub; golden: bash 5.3.20 (`bash -c`). The subscript's
// value is not expanded again, so `$( … )` in it is an arithmetic error,
// not a command (this used to loop forever), and the error ends the
// non-interactive shell.
#[test]
fn array_subscript_values_are_not_reexpanded() {
	let (out, err) =
		run("typeset -a array; index='$( echo >&2 foo )'; echo ${array[ $index ]}; echo after");
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 1: $( echo >&2 foo ) : arithmetic syntax error: operand expected (error token \
		 is \"$( echo >&2 foo ) \")\n"
	);
}

// Golden: bash 5.3.20; upstream varenv9.sub.
#[test]
fn declaration_compound_elements_split_unless_keyed() {
	assert_eq!(
		out(
			"f(){ readonly i3=($1); declare -p i3; declare -a j=($1 \"\" [5]=\"x y\"); declare -p j; \
			 }; f \"a b c\""
		),
		"declare -ar i3=([0]=\"a\" [1]=\"b\" [2]=\"c\")\ndeclare -a j=([0]=\"a\" [1]=\"b\" \
		 [2]=\"c\" [3]=\"\" [5]=\"x y\")\n"
	);
}

// Golden: bash 5.3.20 `bash -uc '(echo $9); (echo ${9})'`.
#[test]
fn unbound_positional_names_follow_the_braces() {
	let (out, err) = run("set -u; (echo $9); (echo ${9}); echo end");
	assert_eq!(out, "end\n");
	assert_eq!(err, "bash: line 1: $9: unbound variable\nbash: line 1: 9: unbound variable\n");
}

#[test]
fn here_documents_get_no_brace_expansion() {
	assert_eq!(
		out(
			"while IFS= read -r l; do echo \"[$l]\"; done <<EOF\nint main(int argc) {\n  if (f(a, b) \
			 == 0) {x,y} {1..2}\n}\nEOF"
		),
		"[int main(int argc) {]\n[  if (f(a, b) == 0) {x,y} {1..2}]\n[}]\n"
	);
}

// Golden: bash 5.2.21. A function defined in a substitution in a
// here-document body crashed the compiler.
#[test]
fn here_documents_define_functions_inside_substitutions() {
	assert_eq!(
		out(
			"read -r a <<E\n$(f() { echo \"in doc $1\"; }; f x)\nE\necho \"[$a]\"\ndeclare -F f || \
			 echo outside"
		),
		"[in doc x]\noutside\n"
	);
}

#[test]
fn here_documents_of_commands_in_one_backquote_keep_their_own_bodies() {
	assert_eq!(
		out("x=`read -r a <<E\nfirst\nE\nread -r b <<E\nsecond\nE\necho $a $b`; echo \"$x\""),
		"first second\n"
	);
}

#[test]
fn substring_arithmetic_errors_name_the_parameter() {
	let (out, err) = run("x=abc; echo ${x:%}\necho ${unset_v:1:%}.");
	assert_eq!(out, ".\n");
	assert_eq!(
		err,
		"bash: line 1: x: %: arithmetic syntax error: operand expected (error token is \"%\")\n"
	);
}

/// Each script's (stdout, stderr), run in a fresh shell (a `set -u` error
/// ends the shell).
fn each(srcs: &[&str]) -> Vec<(String, String)> {
	srcs.iter().map(|s| run(s)).collect()
}

// Goldens: bash 5.3.20 `bash -c …`; upstream errors5.sub, array.tests:271.
#[test]
fn unbound_elements_are_named_with_the_subscript_as_written() {
	let got = each(&[
		"set -u; a=([1]=x); echo ${#a[7]}; echo ${a[7]}",
		"set -u; a=([1]=x); i=3; echo ${a[i+4]}",
		"set -u; x=1; echo ${#x[0]}",
		"set -u; x=1; echo ${#x[@]}",
		"set -u; echo ${#nosuch[1]}",
		"set -u; a=([1]=x); echo ${a[7]@Q}",
		"set -u; a=([1]=x); echo ${a@a} ${a[7]@a}",
		"set -u; a=([1]=x); echo ${a@Q}",
		"set -u; a=([1]=x); echo ${a[7]#y}",
		"set -u; declare -A h=([a]=1); echo ${h[b]}",
	]);
	let line = |name: &str| format!("bash: line 1: {name}: unbound variable\n");
	let want = [
		("0\n", line("a[7]")),
		("", line("a[i+4]")),
		("", line("x[0]")),
		("", line("x")),
		("", line("nosuch[1]")),
		("", line("a[7]")),
		("", line("a[7]")),
		("", line("a")),
		("", line("a[7]")),
		("", line("h[b]")),
	];
	for ((out, err), (want_out, want_err)) in got.iter().zip(&want) {
		assert_eq!((out.as_str(), err.as_str()), (*want_out, want_err.as_str()));
	}
}

// Goldens: bash 5.3.20.
#[test]
fn indirection_through_unset_elements() {
	let got = each(&[
		"set -u; a=([1]=x); echo ${!a[7]}",
		"a=([1]=x); echo \"<${!a[7]}>\"; echo ${!nosuch[7]}",
		"set -u; x=foo; echo ${!x}",
	]);
	assert_eq!(got[0], (String::new(), "bash: line 1: !a[7]: unbound variable\n".to_owned()));
	assert_eq!(
		got[1],
		("<>\n".to_owned(), "bash: line 1: nosuch[7]: invalid indirect expansion\n".to_owned())
	);
	assert_eq!(got[2], (String::new(), "bash: line 1: !x: unbound variable\n".to_owned()));
}

// Goldens: upstream array.tests (sparse array slicing) and bash 5.3.20.
#[test]
fn sparse_array_slices_offset_by_index() {
	assert_eq!(
		out(
			"av=([1]=one [2]= [3]=three [5]=five [7]=seven); echo ${av[@]:5:2}; echo ${av[@]: -2:2}; \
			 echo ${av[@]: 6:2}; echo ${av[@]: -1:2}; echo \"<${av[*]:8}>\" \"<${av[@]:12}>\"; echo \
			 ${av[@]:0:2}"
		),
		"five seven\nseven\nseven\nseven\n<> <>\none\n"
	);
}

// Goldens: upstream array.tests:418 and bash 5.3.20 (bash scans for braces
// with a naive quote tracker, so the text between the quotes of a
// subscript or operator word inside "…" is unquoted).
#[test]
fn braces_between_inner_quotes_of_a_quoted_expansion_expand() {
	assert_eq!(
		out(
			"l=( {0..9} ); echo \"${l[\"{2..6}\"]}\"; p \"x${l[\"{2..3}\"]}y${l[\"{4,5}\"]}\"\np \
			 \"${x:-\"{1,2}\"}\" a{1,2}\"${y:-\"{3,4}\"}\"\ni=1 i2=5; p \"${l[\"$i{2,3}\"]}\" \
			 \"${l[\"{1,2}\"]}\"{a,b}"
		),
		"2 3 4 5 6\n4:<x2y4><x2y5><x3y4><x3y5>\n6:<1><2><a13><a14><a23><a24>\n6:\
		 <5><0><1a><1b><2a><2b>\n"
	);
	// Unquoted, the subscript's quotes stay quotes.
	let (_, err) = run("l=(0 1 2 3); echo ${l[\"{2..3}\"]}");
	assert_eq!(
		err,
		"bash: line 1: {2..3}: arithmetic syntax error: operand expected (error token is \
		 \"{2..3}\")\n"
	);
}

// Goldens: upstream array17.sub:43 (array.right), array31.sub / assoc19.sub
// (array.right, assoc.right: a keyed compound value expands tilde-prefixes
// after `:` like an assignment; an unkeyed one only a leading one).
#[test]
fn tilde_in_subscripts_and_compound_values() {
	let (_, err) = run("b=(0 1 2 3); HOME=2; echo ${b[~]}");
	assert_eq!(
		err,
		"bash: line 1: ~: arithmetic syntax error: operand expected (error token is \"~\")\n"
	);
	assert_eq!(
		out("HOME=/h; aa=([0]=~/D:~/L ~/c:~/d [3]=a=~/q); declare -p aa"),
		"declare -a aa=([0]=\"/h/D:/h/L\" [1]=\"/h/c:~/d\" [3]=\"a=~/q\")\n"
	);
}

// Goldens: bash 5.3.20 (keys quoted only for shell metacharacters, `@`
// and `*`).
#[test]
fn assoc_keys_quoted_like_bash_in_k_transform() {
	assert_eq!(
		out(
			"declare -A x=([a=b]=1); echo \"${x[@]@K}|\"; declare -A y=([@]=2); echo \"${y[@]@K}|\"; \
			 declare -A z=([-x]=3); echo \"${z[@]@K}|\""
		),
		"a=b \"1\" |\n\"@\" \"2\" |\n-x \"3\" |\n"
	);
}

// Goldens: bash 5.3.20, upstream quotearray.tests (bash
// `expand_array_subscript`: arithmetic text quotes each expanded subscript,
// so it is used as written and never expanded twice).
#[test]
fn arithmetic_subscripts_are_expanded_once() {
	let (stdout, err) = run(
		"declare -A a b; key='x],b[$(echo uname >&2)'; (( a[$key]++ )); (( a[\"$key\"]++ )); \
		 declare -p a; (( b['$key']++ )); declare -p b",
	);
	assert_eq!(
		stdout,
		"declare -A a=([\"x],b[\\$(echo uname >&2)\"]=\"2\" )\ndeclare -A b=([\"\\$key\"]=\"1\" )\n"
	);
	assert_eq!(err, "");
	let (_, err) = run("declare -A a; key='x],b[$(echo uname >&2)'; (( 'a[$key]++' ))");
	assert_eq!(
		err,
		"bash: line 1: ((: 'a[x\\],b\\[\\$(echo uname >&2)]++' : arithmetic syntax error: operand \
		 expected (error token is \"'a[x\\],b\\[\\$(echo uname >&2)]++' \")\n"
	);
	assert_eq!(
		out("a=(5 6 7); b=(0 1); k='1'; echo $(( a[b[1]] )) $(( a[$k] )) $(( a[\"$k\"] ))"),
		"6 6 6\n"
	);
	assert_eq!(out("declare -A h; k='a b'; h[$k]=1; echo $(( h[$k] + h['$k'] ))"), "1\n");
}

// Goldens: upstream nameref10.sub / nameref18.sub (nameref.right) and bash
// 5.3.20: a reference to an element expands its subscript when it is used.
#[test]
fn element_references_expand_their_subscript_at_use() {
	assert_eq!(
		out(
			"x[0]=42; zero=0; f() { typeset -n foo=\"$1\"; echo \"$foo\"; }; f 'x[$zero]'; x[$(echo \
			 0)]=4; f 'x[$(echo 0)]'\narr=(1 2 3); indir='arr[@]'; declare -n ref='arr[@]'; p \
			 \"$ref\"; p \"${!indir}$ref\"\nv='x[1+1]'; x=(a b c); echo ${!v}"
		),
		"42\n4\n3:<1><2><3>\n5:<1><2><31><2><3>\nc\n"
	);
}

// Golden: bash 5.3.20 (an empty associative key).
#[test]
fn empty_assoc_subscript_is_a_bad_subscript() {
	let (stdout, err) = run(
		"declare -A w=([a]=1); echo ${w[$unset]}; echo after\necho ${#w[$unset]}; echo \
		 notreached\necho end",
	);
	assert_eq!(stdout, "\nafter\nend\n");
	assert_eq!(
		err,
		"bash: line 1: w: bad array subscript\nbash: line 2: [$unset]: bad array subscript\n"
	);
}

// Golden: bash 5.3.20 `bash -c` (the call-stack arrays read from the frame
// stack, innermost call first).
#[test]
fn call_stack_arrays_follow_the_calls() {
	assert_eq!(
		out(
			"f() { echo ${#BASH_LINENO[@]} ${BASH_LINENO[0]} ${#BASH_SOURCE[@]}; }; f; g() { f; }; g"
		),
		// `out` puts the `p` helper on line 1, so `f` runs on line 2
		// (bash 5.3.20 with the same prefix).
		"1 2 1\n2 2 2\n"
	);
}

// Goldens: bash 5.3.20 `bash -c …` (upstream assoc11.sub / assoc12.sub): an
// associative compound assignment without `[key]=` is key-value pairs, each
// word expanded once, neither split, brace-expanded nor globbed; `declare
// -A` marks its argument the same way, a plain `declare` does not.
#[test]
fn assoc_key_value_pairs_are_expanded_once() {
	let (stdout, err) = run(
		r#"declare -A d; d=( "*" star "?" q ); x="a b"; d+=( $x 1 "$x" 2 a{1,2} 3 [k]=v 4 ); declare -p d; arr=(p q); d=( "${arr[@]}" 5 ); declare -p d; declare -A e=( $x 1 ); declare -p e; f() { local -A g=( $x 2 ); declare -p g; }; f; declare -A h; declare h=( $x 3 ); declare -p h; declare -n r=d; r=( k v ); declare -p d"#,
	);
	assert_eq!(err, "");
	assert_eq!(
		stdout,
		concat!(
			"declare -A d=([\"?\"]=\"q\" [\"*\"]=\"star\" [\"a{1,2}\"]=\"3\" [\"[k]=v\"]=\"4\" [\"a \
			 b\"]=\"2\" )\n",
			"declare -A d=([\"p q\"]=\"5\" )\n",
			"declare -A e=([\"a b\"]=\"1\" )\n",
			"declare -A g=([\"a b\"]=\"2\" )\n",
			"declare -A h=([3]=\"\" [a]=\"b\" )\n",
			"declare -A d=([k]=\"v\" )\n",
		)
	);
}

// Golden: bash 5.3.20; an empty key is reported as written and its pair
// skipped.
#[test]
fn empty_assoc_pair_key_is_a_bad_subscript() {
	let (stdout, err) = run(
		r#"declare -A d; d=( "" null k v ); declare -p d; e=(); d=( "${e[@]}" x k2 ); echo $?; declare -p d"#,
	);
	assert_eq!(stdout, "declare -A d=([k]=\"v\" )\n0\ndeclare -A d=([k2]=\"\" )\n");
	assert_eq!(
		err,
		"bash: line 1: \"\": bad array subscript\nbash: line 1: \"${e[@]}\": bad array subscript\n"
	);
}

// Goldens: bash 5.3.20 (upstream array25.sub): an indexed subscript is
// arithmetic text under double-quote rules, so single quotes stay.
#[test]
fn indexed_subscripts_keep_single_quotes() {
	let got = each(&[
		r#"a=(0 1); echo ${a[" "]} "${a["1"]}"; echo ${a[\1]}"#,
		"a=(0 1); echo ${a['1']}",
		"a=(0 1); k=1; echo ${a['$k']}",
		"a=(0 1); echo ${#a[' ']}",
		"a=(0 1); echo \"${a['1']}\"",
	]);
	let syntax = |t: &str| {
		format!(
			"bash: line 1: {t}: arithmetic syntax error: operand expected (error token is \"{t}\")\n"
		)
	};
	assert_eq!(got[0], ("0 1\n".into(), syntax("\\1")));
	assert_eq!(got[1], (String::new(), syntax("'1'")));
	assert_eq!(got[2], (String::new(), syntax("'1'")));
	assert_eq!(got[3], (String::new(), syntax("' '")));
	assert_eq!(got[4], (String::new(), syntax("'1'")));
}

// Golden: bash 5.3.20 (upstream array.tests:238): `${#a[-n]}` before the
// start fails, naming the subscript; `${a[-n]}` only warns.
#[test]
fn length_of_an_element_before_the_start_fails() {
	let (stdout, err) = run(
		"x=(a b c); echo ${#x[-3]}; echo ${#x[-10]}; echo no\ni=-4; echo ${#x[i]}; echo no\ns=abc; \
		 echo ${#s[-1]}; echo no\ndeclare -a e; echo \"<${#e[-1]}>\" \"<${#nosuch[-1]}>\"; echo \
		 ${x[-10]}after",
	);
	assert_eq!(stdout, "1\n<0> <0>\nafter\n");
	assert_eq!(
		err,
		"bash: line 1: [-10]: bad array subscript\nbash: line 2: [i]: bad array subscript\nbash: \
		 line 3: [-1]: bad array subscript\nbash: line 4: x: bad array subscript\n"
	);
}

// Golden: bash 5.3.20 (upstream nameref15.sub:34/48): a function's reference
// to its own name warns and reads the global variable.
#[test]
fn self_reference_reads_the_global() {
	let (stdout, err) = run(
		"f() { typeset -n v=v; v=foo; echo \"in: $v ${#v}\"; }; v=7; f; echo \"out: $v\"\nh() { \
		 typeset -n w=w; echo \"[$w]\"; }; g() { local w=loc; h; }; w=glob; g",
	);
	assert_eq!(stdout, "in: foo 3\nout: foo\n[glob]\n");
	assert_eq!(
		err,
		concat!(
			"bash: line 1: typeset: warning: v: circular name reference\n",
			"bash: line 1: warning: v: circular name reference\n",
			"bash: line 1: warning: v: maximum nameref depth (8) exceeded\n",
			"bash: line 1: warning: v: circular name reference\n",
			"bash: line 1: warning: v: circular name reference\n",
			"bash: line 2: typeset: warning: w: circular name reference\n",
			"bash: line 2: warning: w: circular name reference\n",
			"bash: line 2: warning: w: circular name reference\n",
		)
	);
}

// Golden: bash 5.3.20 (upstream quotearray3.sub): `unset` expands a quoted
// subscript itself, command substitutions included.
#[test]
fn unset_runs_command_substitutions_in_subscripts() {
	assert_eq!(
		out(
			"declare -A a; a['$(echo foo)']=1; a[foo]=2; unset 'a[$(echo foo)]'; declare -p a; b=(0 \
			 1 2); unset 'b[$(echo 1)]'; declare -p b"
		),
		"declare -A a=([\"\\$(echo foo)\"]=\"1\" )\ndeclare -a b=([0]=\"0\" [2]=\"2\")\n"
	);
}

// Golden: bash 5.3.20 (upstream quotearray1.sub): `[[ ]]` arithmetic and
// `-v` operands expand each subscript once; its value is never evaluated
// again (no `uname`, no `foo` on stderr, no process substitution).
#[test]
fn cond_arith_operands_expand_subscripts_once() {
	assert_eq!(
		out(
			"declare -A assoc; key='x],b[$(echo uname >&2)'; key1=\"]\"; key2='` echo >&2 foo`'; \
			 assoc[$key]=42; assoc[$key1]=12; assoc[$key2]=128; assoc[0]=0; [[ assoc[$key] -eq \
			 assoc[$key] ]]; echo $?; [[ assoc[$key] -gt assoc[$key1] ]]; echo $?; [[ assoc[$key2] \
			 -lt assoc[$key] ]]; echo $?; [[ index[7<(4+2)] -le assoc[0] ]]; echo $?; [[ -v \
			 assoc['$key'] ]]; echo $?; [[ -v assoc[$key] ]]; echo $?"
		),
		"0\n0\n1\n0\n1\n0\n"
	);
}

// Golden: bash 5.3.20 (upstream assoc9.sub:125-130): under
// `assoc_expand_once`, `[[ -v a[$k] ]]` uses the key as expanded once.
#[test]
fn cond_v_under_expand_once_uses_the_expanded_key() {
	assert_eq!(
		out(
			"shopt -s assoc_expand_once; key='$(date >&2)'; declare -A aa; aa[$key]=foo; echo \
			 \"${aa[$key]}\"; [[ -v aa[$key] ]] && echo found; k2=\"x]\"; aa[$k2]=1; [[ -v aa[$k2] \
			 ]] && echo found2; test -v \"aa[x]]\" || echo not-test"
		),
		// `test -v` ends the subscript at the first `]`.
		"foo\nfound\nfound2\nnot-test\n"
	);
}

// Goldens: bash 5.3.20 (upstream quotearray2.sub:20): an associative key the
// evaluator meets is expanded once, quotes removed.
#[test]
fn arith_assoc_keys_are_expanded_once() {
	assert_eq!(
		out(
			"declare -A A; A[x]=3; A[\"'x'\"]=4; A[' ']=5; echo $(( A['x'] )) $(( A[\"x\"] )); let \
			 'z=A[\" \"]'; echo $z; k=x; let 'z=A[$k]'; echo $z; (( z = A[ $k ] )); echo $z\ntypeset \
			 -A a; a[0]=0 a[1]=1; let \"a[\\\" \\\"]=11\" ; typeset -p a"
		),
		"3 3\n5\n3\n0\ndeclare -A a=([1]=\"1\" [0]=\"0\" [\" \"]=\"11\" )\n"
	);
}

// Golden: bash 5.3.20 (upstream quotearray2.sub:89): a subscript without its
// `]` is a bad array subscript.
#[test]
fn unterminated_arith_subscript_is_a_bad_subscript() {
	let (stdout, err) = run("let \"x,b[1\"; echo $?; (( b[1 )); echo $?");
	assert_eq!(stdout, "1\n1\n");
	assert_eq!(
		err,
		"bash: line 1: let: x,b[1: bad array subscript (error token is \"b[1\")\nbash: line 1: ((: \
		 b[1 : bad array subscript (error token is \"b[1 \")\n"
	);
}

// Golden: bash 5.3.20 (upstream quotearray3.sub:90-98): `unset a[@]`
// empties an indexed array; with `BASH_COMPAT=51` it unsets it.
#[test]
fn unset_at_empties_an_indexed_array() {
	let (stdout, err) = run(
		"array=(1 2 3); unset array[@]; declare -p array; c=(1); BASH_COMPAT=51; unset c[@]; \
		 declare -p c",
	);
	assert_eq!(stdout, "declare -a array=()\n");
	assert_eq!(err, "bash: line 1: declare: c: not found\n");
}

// Golden: bash 5.3.20 `bash -c`: `caller` names the calling line and
// function (and file, with a frame argument); a `-c` string has no `main`
// level, so past the outermost function it fails.
#[test]
fn caller_reports_the_calling_frames() {
	let (stdout, err) =
		run("f() { caller; caller 0; caller 1; echo st=$?; }\ng() { f; }\ng\ncaller; echo top=$?");
	assert_eq!(stdout, "2 bash\n2 g bash\nst=1\ntop=1\n");
	assert_eq!(err, "");
}

/// [`out`] with the files `/d/x1` and `/d/x2`, for pathname expansion.
fn out_with_files(src: &str) -> String {
	let fs = MemFs::new();
	fs.add_file("/dir/x1", b"", 0o644);
	fs.add_file("/dir/x2", b"", 0o644);
	let res =
		run_script(FakeHost::new().with_fs(fs), format!("{P}{src}").as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&res.stderr), "");
	String::from_utf8_lossy(&res.stdout).into_owned()
}

// Goldens: bash 5.3.20. Literal words are expanded when the IR is built
// (`Word::fixed`/`Word::noglob`); `set -f`, `set +B`, `IFS`, tilde-prefixes
// and quoting still decide at run time.
#[test]
fn literal_words_honour_run_time_options() {
	assert_eq!(
		out(
			"p a'b'\"c\" '' \"\" x\\ y -lt 300000 ']' '['; IFS=b; p abc a\"b\"c; unset IFS\necho \
			 {a,b}; set +B; echo {a,b}; set -B; echo {a,b}\nHOME=/h; p ~ ~/a a~ \"~\" x=~"
		),
		"8:<abc><><><x y><-lt><300000><]><[>\n2:<abc><abc>\na b\n{a,b}\na \
		 b\n5:</h></h/a><a~><~><x=/h>\n"
	);
}

#[test]
fn literal_and_quoted_words_glob_only_through_unquoted_characters() {
	assert_eq!(
		out_with_files(
			"p /dir/x*; set -f; p /dir/x*; set +f; p \"/dir/x*\" /dir/x\\* '/dir/x'*; v='*'; p \
			 \"$v\" \"/dir/$v\" \"$v\"/dir /dir/$v; p \"$e\"/dir/x? /dir/[x]1 '/dir/[x]1' /dir/y*; \
			 shopt -s nullglob; p /dir/y* \"/dir/y*\"; shopt -u nullglob\nshopt -s extglob\np \
			 /dir/+(x1) '/dir/+(x1)'"
		),
		"2:</dir/x1></dir/x2>\n1:</dir/x*>\n4:</dir/x*></dir/x*></dir/x1></dir/x2>\n5:<*></dir/*><*/\
		 dir></dir/x1></dir/x2>\n5:</dir/x1></dir/x2></dir/x1></dir/[x]1></dir/y*>\n1:</dir/y*>\n2:\
		 </dir/x1></dir/+(x1)>\n"
	);
}

#[test]
fn literal_patterns_trim_replace_and_match() {
	assert_eq!(
		out(
			"s=/usr/local/lib/foo.tar.gz; echo ${s##*/} ${s%.*} ${s#\"/usr\"} ${s%'.gz'} ${#s} \
			 ${s/lib/LIB} ${s//[o]/0} ${s%%.*}\n[[ abc == a* ]] && echo m1; [[ 'a*' == a'*' ]] && \
			 echo m2; [[ ab == a'*' ]] || echo m3; case x* in x'*') echo m4;; esac; case ab in a\\*) \
			 echo bad;; a*) echo m5;; esac"
		),
		"foo.tar.gz /usr/local/lib/foo.tar /local/lib/foo.tar.gz /usr/local/lib/foo.tar 25 \
		 /usr/local/LIB/foo.tar.gz /usr/l0cal/lib/f00.tar.gz \
		 /usr/local/lib/foo\nm1\nm2\nm3\nm4\nm5\n"
	);
}

// The character set is cached under the root's locale token: root writes,
// `local`, temporary assignments and subshell values must all be seen.
#[test]
fn pattern_charset_follows_locale_changes() {
	assert_eq!(
		out(
			"unset LC_ALL LC_CTYPE; s=\u{e9}; t() { [[ $s == ? ]] && echo \"$1\" || echo \"no-$1\"; \
			 }\nLANG=en_US.UTF-8; t u1; LANG=C; t c1; f() { local LC_ALL=C.UTF-8; t u2; }; f; t \
			 c2\nLC_ALL=en_US.UTF-8 eval 't u3'; t c3; ( LANG=en_US.UTF-8; t u4 ); t \
			 c4\nLC_CTYPE=en_US.UTF-8; t u5; unset LC_CTYPE; t c5; for l in C en_US.UTF-8 C; do \
			 LANG=$l; t \"$l\"; done"
		),
		"u1\nno-c1\nu2\nno-c2\nu3\nno-c3\nu4\nno-c4\nu5\nno-c5\nno-C\nen_US.UTF-8\nno-C\n"
	);
}
