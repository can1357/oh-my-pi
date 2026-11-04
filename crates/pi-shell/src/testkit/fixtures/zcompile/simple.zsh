echo hi there
print -r -- "$HOME" 'single' $'\t' ${foo:-bar} $(date) `uname` *.c ~/x
a=1 b+=2 c[3]=4 env x
arr=(one two
  three) arr+=(four)
true && false || echo no; sleep 1 & sleep 2 &| sleep 3 &!
! grep x file | wc -l |& cat
coproc cat
nocorrect ls
time ls; time
