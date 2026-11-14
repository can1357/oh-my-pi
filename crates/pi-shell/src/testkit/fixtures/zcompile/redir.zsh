cat < in > out >> app 2> err 2>> errapp >| clob >>| clob2
cat <> rw <&3 >&4 &> both &>| both2 >>& both3 >>&| both4 3<&- 4>&-
exec {fd}> /dev/null {in}< /dev/null
cat <<<"here string" <<<word
diff <(ls) >(cat) =(ls)
cat < <(ls) > >(cat)
cat <<EOF
body $var
line two $(cmd)
EOF
cat <<-'EOT' >out
	tabbed
	EOT
cat <<"E1" <<E2
quoted $x
E1
unquoted ${y}
E2
echo after
exec {v}<<VAR
var heredoc
VAR
