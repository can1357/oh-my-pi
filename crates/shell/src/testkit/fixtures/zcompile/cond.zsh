[[ -f /etc/passwd && ! -d /x || -z "" ]]
[[ a == b* ]] && [[ a = b ]] && [[ a != c ]] && [[ a =~ ^a ]]
[[ a < b || a > b ]]
[[ 1 -eq 1 && 1 -ne 2 && 1 -lt 2 && 2 -gt 1 && 1 -le 1 && 1 -ge 1 ]]
[[ f -nt g || f -ot g || f -ef g ]]
[[ -o shortloops ]] && [[ -v var ]] && [[ ( -n x ) ]]
[[ abc ]]
[[ -n x
   && -z y ]]
(( a = 1 + 2 ))
(( a++ ))
