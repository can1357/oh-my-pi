//! zsh/param/private (`private`, `local -P`): the cases of zsh 5.9
//! `Test/V10private.ztst` (run at the top level of `zsh -c` rather than
//! inside the test harness's function; external `zsh -fc` checks of the
//! environment replaced by `$+`/`${(t)…}` checks) and more. Expected output
//! comes from `/bin/zsh -f -c` 5.9.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// Assert `src` prints `out` and `err` and ends with `status`.
#[track_caller]
fn check(src: &str, out: &str, err: &str, status: i32) {
	let (o, e, s) = zsh(src);
	assert_eq!((o.as_str(), e.as_str(), s), (out, err, status), "{src}");
}

#[test]
fn unload_and_reload() {
	check(r#"(zmodload -u zsh/param/private && zmodload zsh/param/private)"#, r#""#, r#""#, 0);
}

#[test]
fn basic_scope_hiding() {
	check(
		r#"zmodload zsh/param/private
typeset scalar_test=toplevel
() {
 print $scalar_test
 private scalar_test
 typeset +m scalar_test
 unset scalar_test
 print $+scalar_test
}
print $scalar_test"#,
		r#"toplevel
local scalar_test
0
toplevel
"#,
		r#""#,
		0,
	);
}

#[test]
fn enter_and_exit_a_scope() {
	check(
		r#"zmodload zsh/param/private
typeset scalar_test=toplevel
print $scalar_test
() {
 private scalar_test=function
 print $scalar_test
}
print $scalar_test"#,
		r#"toplevel
function
toplevel
"#,
		r#""#,
		0,
	);
}

#[test]
fn variable_defined_only_in_scope() {
	check(
		r#"zmodload zsh/param/private
print $+unset_test
() {
 private unset_test
 typeset +m unset_test
 unset_test=setme
 print $unset_test
}
print $+unset_test"#,
		r#"0
local unset_test
setme
0
"#,
		r#""#,
		0,
	);
}

#[test]
fn nested_scope_with_different_type() {
	check(
		r#"zmodload zsh/param/private
typeset -a array_test=(top level)
() {
 local -Pa array_test=(in function)
 () {
  private array_test
  typeset +m array_test
 }
 print $array_test
}
print $array_test"#,
		r#"local array_test
in function
top level
"#,
		r#""#,
		0,
	);
}

#[test]
fn type_of_private_may_not_be_changed_by_assignment() {
	check(
		r#"zmodload zsh/param/private
typeset -a array_test=(top level)
() {
 private array_test
 array_test=(in function)
}"#,
		r#""#,
		r#"(anon):2: array_test: attempt to assign array value to non-array
"#,
		1,
	);
}

#[test]
fn associative_array_fields_may_not_be_private() {
	check(
		r#"zmodload zsh/param/private
typeset -A hash_test=(top level)
() {
 setopt localoptions noglob
 private hash_test[top]
}"#,
		r#""#,
		r#"(anon):private:2: hash_test[top]: can't create local array elements
"#,
		1,
	);
}

#[test]
fn tied_params_may_not_be_private() {
	check(
		r#"zmodload zsh/param/private
() {
 private path
}
() {
 private PATH
}"#,
		r#""#,
		r#"(anon):private:1: can't change scope of existing param: path
(anon):private:1: can't change scope of existing param: PATH
"#,
		1,
	);
}

#[test]
fn privates_may_hide_tied_parameters() {
	check(
		r#"zmodload zsh/param/private
() {
 private -h path
 print X$path
}"#,
		r#"X
"#,
		r#""#,
		0,
	);
}

#[test]
fn private_hides_value_from_surrounding_scope() {
	check(
		r#"zmodload zsh/param/private
typeset -a hash_test=(top level)
typeset -p hash_test
inner () {
 private -p hash_test
 print ${(t)hash_test} ${(kv)hash_test}
}
outer () {
 local -PA hash_test=(in function)
 private + hash_test
 inner
}
outer
print ${(kv)hash_test}"#,
		r#"typeset -a hash_test=( top level )
hash_test=( [in]=function )
typeset -g -a hash_test=( top level )
array top level
top level
"#,
		r#""#,
		0,
	);
}

#[test]
fn private_cannot_be_redeclared_as_local() {
	check(
		r#"zmodload zsh/param/private
() {
 private -a array_test
 local array_test=scalar
}"#,
		r#""#,
		r#"(anon):local:2: array_test: inconsistent type for assignment
"#,
		1,
	);
}

#[test]
fn local_cannot_be_redeclared_as_private() {
	check(
		r#"zmodload zsh/param/private
() {
 local hash_test=scalar
 private -A hash_test
}"#,
		r#""#,
		r#"(anon):private:2: can't change scope of existing param: hash_test
"#,
		1,
	);
}

#[test]
fn exported_private_behaves_like_a_local() {
	check(
		r#"zmodload zsh/param/private
inner () {
 print $+scalar_test ${(t)scalar_test}
}
() {
 private -x scalar_test=whaat
 inner
 print Y $scalar_test ${(t)scalar_test}
}"#,
		r#"0
Y whaat scalar-local-export-hide-special
"#,
		r#""#,
		0,
	);
}

#[test]
fn exported_private_arrays_do_not_export() {
	check(
		r#"zmodload zsh/param/private
inner () {
 typeset -p array_test
}
() {
 local -Pax array_test=(whaat)
 print Y $array_test
 inner
}"#,
		r#"Y whaat
"#,
		r#"inner:typeset:1: no such variable: array_test
"#,
		1,
	);
}

#[test]
fn export_does_not_change_scope() {
	check(
		r#"zmodload zsh/param/private
inner () {
 print $+scalar_test
}
() {
 private scalar_test=whaat
 export scalar_test
 inner
 () {
  print $+scalar_test
 }
 print Y $scalar_test ${(t)scalar_test}
}"#,
		r#"0
0
Y whaat scalar-local-export-hide-special
"#,
		r#""#,
		0,
	);
}

#[test]
fn not_visible_in_anonymous_functions_1() {
	check(
		r#"zmodload zsh/param/private
typeset -A hash_test=(top level)
() {
 local -PA hash_test=(in function)
 () {
  print X ${(kv)hash_test}
 }
 print Y ${(kv)hash_test}
}
print ${(kv)hash_test}"#,
		r#"X top level
Y in function
top level
"#,
		r#""#,
		0,
	);
}

#[test]
fn not_visible_in_anonymous_functions_2() {
	check(
		r#"zmodload zsh/param/private
typeset -A hash_test=(top level)
() {
 local -PA hash_test=(in function)
 () {
  print X ${(kv)hash_test}
  hash_test[in]=deeper
 }
 print Y ${(kv)hash_test}
}
print ${(okv)hash_test}"#,
		r#"X top level
Y in function
deeper in level top
"#,
		r#""#,
		0,
	);
}

#[test]
fn not_visible_in_anonymous_functions_3() {
	check(
		r#"zmodload zsh/param/private
typeset -A hash_test=(top level)
() {
 local -Pa array_test=(in function)
 local -PA hash_test=($array_test)
 () {
  print X ${(kv)hash_test}
  hash_test=(even deeper)
  {
    array_test+=(${(kv)hash_test})
  } always {
    print ${array_test-array_test not set} ${(t)array_test}
  }
 }
 print Y ${(kv)hash_test} Z $array_test
}
print ${(kv)hash_test} ${(t)array_test}"#,
		r#"X top level
array_test not set
"#,
		r#"(anon):4: array_test: can't change parameter attribute
"#,
		1,
	);
}

#[test]
fn not_visible_in_anonymous_functions_4() {
	check(
		r#"zmodload zsh/param/private
typeset -a array_test
typeset -A hash_test=(top level)
() {
 local -Pa array_test=(in function)
 local -PA hash_test=($array_test)
 () {
  print X ${(kv)hash_test}
  hash_test=(even deeper)
  array_test+=(${(kv)hash_test})
 }
 print Y ${(kv)hash_test} Z $array_test
}
print ${(kv)hash_test} $array_test"#,
		r#"X top level
Y in function Z in function
even deeper even deeper
"#,
		r#""#,
		0,
	);
}

#[test]
fn not_visible_in_anonymous_functions_5() {
	check(
		r#"zmodload zsh/param/private
typeset -A hash_test=(top level)
() {
 local -PA hash_test=(in function)
 () {
  print X ${(kv)hash_test}
  unset hash_test
 }
 print Y ${(kv)hash_test}
}
print ${(t)hash_test} ${(kv)hash_test}"#,
		r#"X top level
Y

"#,
		r#""#,
		0,
	);
}

#[test]
fn special_parameters_cannot_be_made_private() {
	check(
		r#"zmodload zsh/param/private
( () { private SECONDS } )"#,
		r#""#,
		r#"(anon):private: can't change scope of existing param: SECONDS
"#,
		1,
	);
}

#[test]
fn private_may_hide_a_special() {
	check(
		r#"zmodload zsh/param/private
() { private -h SECONDS; SECONDS=5; print $SECONDS ${(t)SECONDS} }"#,
		r#"5 scalar-local-hide-special
"#,
		r#""#,
		0,
	);
}

#[test]
fn nested_assignment_creating_a_global_fails() {
	check(
		r#"zmodload zsh/param/private
f() {
 x=1
}
g() {
 private x=2
 f
 echo $x
}
g; echo ${x-unset}"#,
		r#""#,
		r#"f:1: x: can't change parameter attribute
"#,
		1,
	);
}

#[test]
fn nested_typeset_g_fails() {
	check(
		r#"zmodload zsh/param/private
f() {
 typeset -g x=5
}
g() {
 private x=2
 f
}
g"#,
		r#""#,
		r#"f:1: x: can't change parameter attribute
"#,
		1,
	);
}

#[test]
fn redeclaring_a_private_fails() {
	check(
		r#"zmodload zsh/param/private
g() {
 private x=2
 private x
 private y z=3 x
 print $? $x ${(t)y} ${(t)z}
}
g"#,
		r#"1 2 scalar-local-hide-special scalar-local-hide-special
"#,
		r#"g:private:2: can't change scope of existing param: x
g:private:3: can't change scope of existing param: x
"#,
		0,
	);
}

#[test]
fn assignment_to_unset_private_fails() {
	check(
		r#"zmodload zsh/param/private
() {
 private x=1
 unset x
 print ${+x}
 x=2
}"#,
		r#"0
"#,
		r#"(anon):4: x: can't change parameter attribute
"#,
		1,
	);
}

#[test]
fn listings_of_a_private() {
	check(
		r#"zmodload zsh/param/private
() {
 private x=1
 print ${(t)x}
 typeset -p x
 typeset x
 typeset +m x
 local x=3
 print $x
 typeset -i x
}"#,
		r#"scalar-local-hide-special
x=1
local x
3
"#,
		r#"(anon):typeset:8: x: can't change type of a special parameter
"#,
		1,
	);
}

#[test]
fn bad_option_t() {
	check(
		r#"zmodload zsh/param/private
() {
 private -T A a
}"#,
		r#""#,
		r#"(anon):1: bad option: -T
"#,
		1,
	);
}

#[test]
fn top_level_private_is_global() {
	check(
		r#"zmodload zsh/param/private
private x=1; print $x; typeset -p x
setopt warncreateglobal
private y=2; print $y"#,
		r#"1
typeset x=1
2
"#,
		r#"zsh:private:4: invalid local scope, using globals
"#,
		0,
	);
}

#[test]
fn local_p_needs_the_module() {
	check(
		r#"() { local -P x=1 }"#,
		r#""#,
		r#"(anon):local: bad option: -P
"#,
		1,
	);
}

#[test]
fn local_p_after_loading() {
	check(
		r#"zmodload zsh/param/private
() {
 local -P x=1
 local y=2
 print ${(t)x} ${(t)y}
}"#,
		r#"scalar-local-hide-special scalar-local
"#,
		r#""#,
		0,
	);
}

#[test]
fn plus_declares_plain_locals() {
	check(
		r#"zmodload zsh/param/private
x=1
() {
 private + x
 print ${(t)x}
}"#,
		r#"scalar-local
"#,
		r#""#,
		0,
	);
}

#[test]
fn outer_global_seen_and_set_from_nested() {
	check(
		r#"zmodload zsh/param/private
a=top
f() {
 print $a
 a=changed
}
g() {
 private a=mine
 f
 print $a
}
g; print $a"#,
		r#"top
mine
changed
"#,
		r#""#,
		0,
	);
}

#[test]
fn not_an_identifier() {
	check(
		r#"zmodload zsh/param/private
() {
 private 1x
}"#,
		r#""#,
		r#"(anon):private:1: not an identifier: 1x
"#,
		1,
	);
}

#[test]
fn reserved_word_once_loaded() {
	check(
		r#"zmodload zsh/param/private
eval "() {
 private a=(1 2) b=x
 private -A h=(k v)
 print \$a \${(t)a} \$b \${(kv)h} \${(t)h}
}"
eval "private c=(3 4)"; print $c ${(t)c}"#,
		r#"1 2 array-local-hide-special x k v association-local-hide-special
3 4 array
"#,
		r#""#,
		0,
	);
}

#[test]
fn no_reserved_word_before_loading() {
	check(
		r#"private a=(1 2)"#,
		r#""#,
		r#"zsh:1: unknown file attribute: 1
"#,
		1,
	);
}

#[test]
fn a_type_change_of_the_global_drops_the_privates_hiding_it() {
	check(
		r#"zmodload zsh/param/private
a=(1 2); g() { private a=x; f; print "g:$a" }; f() { a=scalar }; g; print "top:$a"
b=(1 2); h() { private b=x; k; print "h:$b ${(t)b}" }; k() { (( b = 3 )) }; h; print "top:$b""#,
		"g:scalar\ntop:scalar\nh:3 integer\ntop:3\n",
		"",
		0,
	);
}
