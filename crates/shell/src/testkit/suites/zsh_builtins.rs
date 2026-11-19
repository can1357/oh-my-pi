//! zsh builtins (ports of zsh 5.9 `builtin.c`): option
//! parsing and messages, `print`/`echo`/`printf`, the `typeset` family and
//! its listings, `set -A`, `shift`, `whence`, `functions`, `alias`,
//! `zmodload`, `disable -p`, `let`, `getopts` and `print -P`. Expected
//! output comes from `/bin/zsh -f -c` 5.9.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	zsh_in(src, b"")
}

/// [`zsh`] with `stdin`.
fn zsh_in(src: &str, stdin: &[u8]) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new().with_stdin(stdin), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// `read -k`/`-q` read keys from the terminal, not stdin: with none they
/// fail (zsh 5.9's message, status 1) and stdin is still there for
/// `read -u0 -k`.
#[test]
fn read_keys_come_from_the_terminal() {
	let (out, err, _) = zsh_in(
		"read -k c; print st=$? c=$c; read -q c; print st=$?; read -u0 -k 2 c; print st=$? c=$c",
		b"xy",
	);
	assert_eq!(
		err,
		"not interactive and can't open terminal\nnot interactive and can't open terminal\n"
	);
	assert_eq!(out, "st=1 c=\nst=1\nst=0 c=xy\n");
}

/// A float keeps every digit (zsh keeps the `double`): arithmetic sees
/// them all, a string read shows the parameter's style and precision.
/// Stored as shown, `s=$EPOCHREALTIME` lost the fraction of a second.
#[test]
fn floats_keep_full_precision() {
	let (out, err, _) = zsh(
		"typeset -F 2 f=3.14159; print $f $((f*100)); float s=1794154341.1655; print $s $(( s - \
		 1794154341 )); typeset -E 3 e=12345.678; print $e $((e+0.001)); g=$f; print $g; f+=1; \
		 print $f",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"3.14 314.15899999999999\n1.794154341e+09 0.16549992561340332\n1.23e+04 \
		 12345.679\n3.14\n4.14\n"
	);
}

/// `typeset -U` on a special array (`fpath`, `path`) drops repeated
/// entries now and in later assignments, `local -U` only in its function;
/// the tied scalar assigned directly keeps its words, as in zsh.
#[test]
fn unique_special_arrays_drop_repeats() {
	let (out, err, _) = zsh(
		"fpath=(/a /b /a); typeset -U fpath; print $#fpath $fpath; fpath+=(/b /c); print $fpath; \
		 sep=${FPATH[3]}; FPATH=/x$sep/y$sep/x; print $fpath; f() { local -U path; path=(/a /a); \
		 print $path }; f; path=(/p /p); print $path; typeset -U path; print $path; path+=(/p /q); \
		 print $path",
	);
	assert_eq!(err, "");
	assert_eq!(out, "2 /a /b\n/a /b /c\n/x /y /x\n/a\n/p /p\n/p\n/p /q\n");
}

#[test]
fn print_options_and_escapes() {
	let (out, _, st) = zsh(r#"print -l a b; print -n x; print -r -- "a\tb"; print "a\tb""#);
	assert_eq!(out, "a\nb\nxa\\tb\na\tb\n");
	assert_eq!(st, 0);
}

#[test]
fn echo_interprets_escapes_by_default() {
	let (out, ..) = zsh(r#"echo -n x\\ny; echo; echo -E "a\\tb""#);
	assert_eq!(out, "x\ny\na\\tb\n");
}

#[test]
fn printf_reuses_format_and_formats_numbers() {
	let (out, ..) =
		zsh(r#"printf "%5.2f|%-3d|%x|%s\n" 3.14159 7 255 str; printf "%s-" a b c; echo"#);
	assert_eq!(out, " 3.14|7  |ff|str\na-b-c-\n");
}

#[test]
fn print_f_evaluates_integer_arguments_as_math() {
	let (out, ..) = zsh(r#"print -f "%s=%d\n" a 1+1 b 3"#);
	assert_eq!(out, "a=2\nb=3\n");
}

#[test]
fn print_columns_and_pattern_filter() {
	let (out, ..) = zsh(r#"print -C2 a b c d; print -m "a*" abc bcd ade"#);
	assert_eq!(out, "a  c\nb  d\nabc ade\n");
}

/// `print -c` with no `$COLUMNS` (no terminal) fits 80 columns, as zsh's
/// `zterm_columns` does; it printed one word per line.
#[test]
fn print_c_without_columns_uses_eighty() {
	let (out, ..) = zsh("print -c a b c d; COLUMNS=6 print -c a b c d");
	assert_eq!(out, "a  b  c  d\na  c\nb  d\n");
}

/// `h[k]=v` one key at a time (an in-place edit of the stored table) lists
/// keys and values as the same keys added through `+=( … )` do (zsh's
/// hash-table order, growth included), replaces a present key where it
/// is, and works on a `local` association too.
#[test]
fn association_element_assignments_keep_zsh_order() {
	let (out, err, _) = zsh(
		"typeset -A h g; for i in {1..300}; do h[k$i]=$i; g+=(k$i $i); done; h[k7]=x; g[k7]=x; [[ \
		 ${(kv)h} == ${(kv)g} ]] && print same ${#h}; f() { local -A l; l[a]=1; l[b]=2; l[a]=3; \
		 print -r -- ${(kv)l} }; f; print ${+l}",
	);
	assert_eq!(err, "");
	assert_eq!(out, "same 300\na 3 b 2\n0\n");
}

/// `a[i]=v` element by element (written in place) behaves as zsh 5.9:
/// appends, negative and arithmetic indices, a gap past the end filled
/// with empty elements, a slice, a `(r)` subscript and a local array.
#[test]
fn array_element_assignments_match_zsh() {
	let (out, err, _) = zsh(
		"a=(); for i in {1..50}; do a[i]=$i; done; a[-1]=last; a[2]=two; a[$#a+1]=end; print -r -- \
		 ${#a} $a[1,3] $a[-2,-1]; b=(x y z); b[6]=g; print -r -- ${#b} \"${(j:,:)b}\"; b[2,3]=Q; \
		 print -r -- \"${(j:,:)b}\"; c=(p q); c[(r)q]=R; print -r -- $c; f() { local -a l; l[1]=a; \
		 l[2]=b; l[1]=c; print -r -- $l }; f",
	);
	assert_eq!(err, "");
	assert_eq!(out, "51 1 two 3 last end\n6 x,y,z,,,g\nx,Q,,,g\np R\nc b\n");
}

/// zsh's `${x?msg}` on an unset `x` ends a `-c` shell with status 1 (not
/// bash's 127 for a `-c` string, nor the last command's status).
#[test]
fn unset_question_exits_one() {
	let (out, err, st) =
		zsh("nosuchcmd 2>/dev/null; print ${undefined?is unset}; print not-reached");
	assert_eq!(st, 1, "{err}");
	assert_eq!(out, "");
	assert!(err.contains("undefined: is unset"), "{err}");
}

#[test]
fn bad_option_is_reported_under_the_builtin_name() {
	let (out, err, st) = zsh("print -bad");
	assert_eq!(out, "");
	assert_eq!(err, "zsh:print:1: bad option: -d\n");
	assert_eq!(st, 1);
}

#[test]
fn integer_and_float_listings() {
	let (out, ..) = zsh("integer i=3+4; typeset -p i; float f=1.5; typeset -p f");
	assert_eq!(out, "typeset -i i=7\ntypeset -E f=1.500000000e+00\n");
}

#[test]
fn association_listing_in_zsh_order() {
	let (out, ..) = zsh("typeset -A h=(b 2 a 1); typeset -p h");
	assert_eq!(out, "typeset -A h=( [a]=1 [b]=2 )\n");
}

#[test]
fn local_array_type_listing() {
	let (out, ..) = zsh("f(){ local -a arr=(1 2); typeset +m arr; typeset -p arr }; f");
	assert_eq!(out, "array local arr\ntypeset -a arr=( 1 2 )\n");
}

#[test]
fn tied_parameters_list_the_array_value() {
	let (out, ..) = zsh("typeset -T PTH=a:b pth; print -l $pth; typeset -p PTH pth");
	assert_eq!(out, "a\nb\ntypeset -T PTH pth=( a b )\ntypeset -aT PTH pth=( a b )\n");
}

#[test]
fn readonly_assignment_fails() {
	let (_, err, st) = zsh("readonly r=1; r=2");
	assert_eq!(err, "zsh:1: read-only variable: r\n");
	assert_eq!(st, 1);
}

#[test]
fn set_a_and_shift() {
	let (out, ..) = zsh("set -A arr x y z; print $arr[2]; set -- p q; shift; print $1");
	assert_eq!(out, "y\nq\n");
	let (_, err, st) = zsh("shift 5");
	assert_eq!(err, "zsh:shift:1: shift count must be <= $#\n");
	assert_eq!(st, 1);
}

#[test]
fn shift_named_array_type_and_arithmetic_operands() {
	let (out, err, status) = zsh(
		r#"a=(x y z)
shift a
print -r -- ${(j:,:)a}
shift -p a
print -r -- ${(j:,:)a}
count=1
set -- p q r
shift count
print -r -- "$1/$2"
a=(1 2 3)
set -- p q r
shift 'a[1]'
print -r -- "$1/$2"
typeset -a empty
shift 0 empty
print $?"#,
	);
	assert_eq!(out, "y,z\ny\nq/r\nq/r\n0\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

#[test]
fn whence_word_forms() {
	let (out, ..) = zsh("whence -w print typeset nonexist; echo $?");
	assert_eq!(out, "print: builtin\ntypeset: reserved\nnonexist: none\n1\n");
}

#[test]
fn functions_prints_zsh_text() {
	// Split so the braces do not read as format strings.
	let (out, ..) = zsh(&["f(){", " :; }; functions f"].concat());
	assert_eq!(out, ["f () {", "\n\t:\n}\n"].concat());
}

#[test]
fn zmodload_of_a_module_no_zsh_has_fails() {
	let (out, err, _) = zsh("zmodload zsh/parameter && echo ok; zmodload zsh/nonesuch; echo $?");
	assert_eq!(out, "ok\n1\n");
	#[cfg(target_os = "macos")]
	assert_eq!(
		err,
		"zsh:1: failed to load module `zsh/nonesuch': dlopen(/usr/lib/zsh/5.9/zsh/nonesuch.so, \
		 0x0009): tried: '/usr/lib/zsh/5.9/zsh/nonesuch.so' (no such file), \
		 '/System/Volumes/Preboot/Cryptexes/OS/usr/lib/zsh/5.9/zsh/nonesuch.so' (no such file), \
		 '/usr/lib/zsh/5.9/zsh/nonesuch.so' (no such file, not in dyld cache)\n"
	);
	assert!(err.starts_with("zsh:1: failed to load module `zsh/nonesuch': "));
}

#[test]
fn disable_p_lists_disabled_pattern_characters() {
	let (out, ..) = zsh(r#"disable -p "*("; disable -p; enable -p "*("; disable -p"#);
	assert_eq!(out, "'*('\n");
}

#[test]
fn let_status_follows_the_last_value() {
	let (out, ..) = zsh(r#"let "x = 2 + 3" "x * 0"; echo $? $x"#);
	assert_eq!(out, "1 5\n");
}

#[test]
fn unset_m_without_match_fails() {
	let (out, ..) = zsh(r#"unset -m "zz*"; echo $?"#);
	assert_eq!(out, "1\n");
}

#[test]
fn getopts_keeps_position_in_optind() {
	let (out, ..) = zsh("getopts ab: o -a; echo $o $OPTIND; getopts ab: o -b; echo $o");
	assert_eq!(out, "a 1\na\n");
}

#[test]
fn print_p_expands_prompt_escapes() {
	let (out, ..) = zsh(r#"print -P "%% %?""#);
	assert_eq!(out, "% 0\n");
}
