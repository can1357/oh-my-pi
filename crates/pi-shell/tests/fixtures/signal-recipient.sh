# Arguments: observer, directory, topology, signal specification, target, mode.
observer=$1
d=$2
topology=$3
signal_spec=$4
target=$5
mode=$6
exec 2>/dev/null
set +m
if [ "$mode" = posix ]; then set -o posix; else set +o posix; fi
if [ "$topology" = tree ]; then
    "$observer" "$d" tree &
elif [ "$topology" = completed ]; then
    : | "$observer" "$d" right &
else
    "$observer" "$d" left | "$observer" "$d" right &
fi
p=$!
if [ "$topology" = tree ]; then
    until [ -s "$d/parent-ready" ] && [ -s "$d/child-ready" ]; do /bin/sleep .01; done
elif [ "$topology" = completed ]; then
    until [ -s "$d/right-ready" ]; do /bin/sleep .01; done
else
    until [ -s "$d/left-ready" ] && [ -s "$d/right-ready" ]; do /bin/sleep .01; done
fi
# Deliberate splitting: a specification is one flag or a flag plus its value.
if [ "$target" = job ]; then
    kill $signal_spec %1
elif [ "$target" = fresh ]; then
    kill $signal_spec "$!"
else
    kill $signal_spec "$p"
fi
printf 'kill=%s\n' "$?"
: > "$d/release"
wait "$p"
printf 'wait=%s\n' "$?"
# A broken virtual wrapper can report completion before the real program.
# Wait for the real observations too, so zero deliveries cannot mean late data.
if [ "$topology" = tree ]; then
    until [ -s "$d/parent-events" ] && [ -s "$d/child-events" ]; do /bin/sleep .01; done
elif [ "$topology" = completed ]; then
    until [ -s "$d/right-events" ]; do /bin/sleep .01; done
else
    until [ -s "$d/left-events" ] && [ -s "$d/right-events" ]; do /bin/sleep .01; done
fi
