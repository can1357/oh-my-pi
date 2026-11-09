{ :; } \
>/dev/null
( : ) \
>/dev/null
if :; then :; fi \
>/dev/null
while :; do :; done \
>/dev/null
for i in a; do :; done \
>/dev/null
case x in x) :;; esac \
>/dev/null
[[ a ]] \
>/dev/null
case x in a) esac
case y in a ) ;; b  )  ;& c ) esac
: $(case x in x ) ;; x) esac)
for i in; do :; done
a=([1]=x [k]=y z)
echo ${x/a/} ${x//} ${x/} ${x/#/a}
cat <<E
a $(echo hi) b
E
cat <<E
E
