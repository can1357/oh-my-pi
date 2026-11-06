x=${(j:,:)${(s: :)var}}
y="${var#pre}${var%%suf}${#var}${var/a/b}"
z=$((1+2)) w=$[3*4]
print ${~pat} ${^arr} ${=str}
echo **/*(.N) <1-10> ^x *(#i)a
echo {a,b,c} {1..3}
echo \$escaped \\back 'it''s'
echo "a long double quoted string with $var and ${other} expansions inside"
echo "a long double quoted string with $var and ${other} expansions inside"
alias ll='ls -l'
ll
emulate -L zsh
setopt localoptions extendedglob
