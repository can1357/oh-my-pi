IFS=:
v=a:b::c
for f in $v; do echo "<$f>"; done
