list='p q  r'
for w in $list; do echo "<$w>"; done
for w in "$list"; do echo "<$w>"; done
