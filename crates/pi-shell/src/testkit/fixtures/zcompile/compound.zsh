# comment
if [[ -n $x ]]; then
  echo yes
elif (( x > 3 )); then
  echo maybe
else
  echo no
fi
if [[ -n x ]] { echo brace; } else { echo other; }
for i in 1 2 3; do echo $i; done
for i j (a b c d) print $i $j
for ((i = 0; i < 3; i++)) { echo $i; }
foreach x (a b)
  echo $x
end
for x; do echo $x; done
for i in a b; echo $i
while read line; do echo $line; done < file
until false; do break; done
repeat 3 echo hi
case $x in
  a|b) echo ab ;;
  (c) echo c ;&
  *.txt) echo txt ;|
  (d|e) echo de ;;
esac
select s in a b; do break; done
( cd /tmp; ls ) > out
{ echo try; } always { echo always; }
{ echo a; echo b; } 2>&1
