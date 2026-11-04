foo() { echo foo; local x=1; bar; }
function bar { echo the very same long string; }
function -T baz qux () { echo traced; }
f g () echo multi
() { echo anon $1; } arg1 arg2
function { echo anon2; }
echo the very same long string
h() {
  print -l the very same long string
  typeset -a list=(x y) other
  local -i n=3 m
  integer z
  readonly r=1
  export E=1 F
}
