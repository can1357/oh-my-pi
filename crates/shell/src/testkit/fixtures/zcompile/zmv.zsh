# function zmv {
# zmv, zcp, zln:
#
# This is a multiple move based on zsh pattern matching.  To get the full
# power of it, you need a postgraduate degree in zsh.  However, simple
# tasks work OK, so if that's all you need, here are some basic examples:
#   zmv '(*).txt' '$1.lis'
# Rename foo.txt to foo.lis, etc.  The parenthesis is the thing that
# gets replaced by the $1 (not the `*', as happens in mmv, and note the
# `$', not `=', so that you need to quote both words).
#   zmv '(**/)(*).txt '$1$2.lis'
# The same, but scanning through subdirectories.  The $1 becomes the full
# path.  Note that you need to write it like this; you can't get away with
# '(**/*).txt'.
#   zmv -w '**/*.txt' '$1$2.lis'
#   noglob zmv -W **/*.txt **/*.lis
# These are the lazy version of the one above; with -w, zsh inserts the
# parentheses for you in the search pattern, and with -W it also inserts
# the numbered variables for you in the replacement pattern.  The catch
# in the first version is that you don't need the / in the replacement
# pattern.  (It's not really a catch, since $1 can be empty.)  Note that
# -W actually inserts ${1}, ${2}, etc., so it works even if you put a
# number after a wildcard (such as zmv -W '*1.txt' '*2.txt').
#   zmv -C '**/(*).txt' ~/save/'$1'.lis
# Copy, instead of move, all .txt files in subdirectories to .lis files
# in the single directory `~/save'.  Note that the ~ was not quoted.
# You can test things safely by using the `-n' (no, not now) option.
# Clashes, where multiple files are renamed or copied to the same one, are
# picked up.
#
# Here's a more detailed description.
#
# Use zsh pattern matching to move, copy or link files, depending on
# the last two characters of the function name.  The general syntax is
#   zmv '<inpat>' '<outstring>'
# <inpat> is a globbing pattern, so it should be quoted to prevent it from
# immediate expansion, while <outstring> is a string that will be
# re-evaluated and hence may contain parameter substitutions, which should
# also be quoted.  Each set of parentheses in <inpat> (apart from those
# around glob qualifiers, if you use the -Q option, and globbing flags) may
# be referred to by a positional parameter in <outstring>, i.e. the first
# (...) matched is given by $1, and so on.  For example,
#   zmv '([a-z])(*).txt' '${(C)1}$2.txt'
# renames algernon.txt to Algernon.txt, boris.txt to Boris.txt and so on.
# The original file matched can be referred to as $f in the second
# argument; accidental or deliberate use of other parameters is at owner's
# risk and is not covered by the (non-existent) guarantee.
#
# As usual in zsh, /'s don't work inside parentheses.  There is a special
# case for (**/) and (***/):  these have the expected effect that the
# entire relevant path will be substituted by the appropriate positional
# parameter.
#
# There is a shortcut avoiding the use of parenthesis with the option -w
# (with wildcards), which picks out any expressions `*', `?', `<range>'
# (<->, <1-10>, etc.), `[...]', possibly followed by `#'s, `**/', `***/', and
# automatically parenthesises them. (You should quote any ['s or ]'s which
# appear inside [...] and which do not come from ranges of the form
# `[:alpha:]'.)  So for example, in
#    zmv -w '[[:upper:]]*' '${(L)1}$2'
# the $1 refers to the expression `[[:upper:]]' and the $2 refers to
# `*'. Thus this finds any file with an upper case first character and
# renames it to one with a lowercase first character.  Note that any
# existing parentheses are active, too, so you must count accordingly.
# Furthermore, an expression like '(?)' will be rewritten as '((?))' --- in
# other words, parenthesising of wildcards is independent of any existing
# parentheses.
#
# Any file whose name is not changed by the substitution is simply ignored.
# Any error --- a substitution resulted in an empty string, two
# substitutions gave the same result, the destination was an existing
# regular file and -f was not given --- causes the entire function to abort
# without doing anything.
#
# Options:
#  -f  force overwriting of destination files.  Not currently passed
#      down to the mv/cp/ln command due to vagaries of implementations
#      (but you can use -o-f to do that).
#  -i  interactive: show each line to be executed and ask the user whether
#      to execute it.  Y or y will execute it, anything else will skip it.
#      Note that you just need to type one character.
#  -n  no execution: print what would happen, but don't do it.
#  -q  Turn bare glob qualifiers off:  now assumed by default, so this
#      has no effect.
#  -Q  Force bare glob qualifiers on.  Don't turn this on unless you are
#      actually using glob qualifiers in a pattern (see below).
#  -s  symbolic, passed down to ln; only works with zln or z?? -L.
#  -v  verbose: print line as it's being executed.
#  -o <optstring>
#      <optstring> will be split into words and passed down verbatim
#      to the cp, ln or mv called to perform the work.  It will probably
#      begin with a `-'.
#  -p <program>
#      Call <program> instead of cp, ln or mv.  Whatever it does, it should
#      at least understand the form '<program> -- <oldname> <newname>',
#      where <oldname> and <newname> are filenames generated. <program>
#      will be split into words.
#  -P <program>
#      As -p, but the program doesn't understand the "--" convention.
#      In this case the file names must already be sane.
#  -w  Pick out wildcard parts of the pattern, as described above, and
#      implicitly add parentheses for referring to them.
#  -W  Just like -w, with the addition of turning wildcards in the
#      replacement pattern into sequential ${1} .. ${N} references.
#  -C
#  -L
#  -M  Force cp, ln or mv, respectively, regardless of the name of the
#      function.
#
# Bugs:
#   Parenthesised expressions can be confused with glob qualifiers, for
#   example a trailing '(*)' would be treated as a glob qualifier in
#   ordinary globbing.  This has proved so annoying that glob qualifiers
#   are now turned off by default.  To force the use of glob qualifiers,
#   give the flag -Q.
#
#   The pattern is always treated as an extendedglob pattern.  This
#   can also be interpreted as a feature.
#
# Unbugs:
#   You don't need braces around the 1 in expressions like '$1t' as
#   non-positional parameters may not start with a number, although
#   paranoiacs like the author will probably put them there anyway.

emulate -RL zsh
setopt extendedglob

local f g args match mbegin mend files action myname tmpf opt exec
local opt_f opt_i opt_n opt_q opt_Q opt_s opt_M opt_C opt_L 
local opt_o opt_p opt_P opt_v opt_w opt_W MATCH MBEGIN MEND
local pat repl errstr fpat hasglobqual opat
typeset -A from to
integer stat

local dashes=--

myname=${(%):-%N}

while getopts ":o:p:P:MCLfinqQsvwW" opt; do
  if [[ $opt = "?" ]]; then
    print -r -- "$myname: unrecognized option: -$OPTARG" >&2
    return 1
  fi
  eval "opt_$opt=\${OPTARG:--\$opt}"
done
(( OPTIND > 1 )) && shift $(( OPTIND - 1 ))

[[ -z $opt_Q ]] && setopt nobareglobqual
[[ -n $opt_M ]] && action=mv
[[ -n $opt_C ]] && action=cp
[[ -n $opt_L ]] && action=ln
[[ -n $opt_p ]] && action=$opt_p
[[ -n $opt_P ]] && action=$opt_P dashes=

if [[ -z $action ]]; then
  action=$myname[-2,-1]

  if [[ $action != (cp|mv|ln) ]]; then
    print -r "$myname: action $action not recognised: must be cp, mv or ln." >&2
    return 1
  fi
fi

if (( $# != 2 )); then
  print -P "Usage:
  %N [OPTIONS] oldpattern newpattern
where oldpattern contains parenthesis surrounding patterns which will
be replaced in turn by \$1, \$2, ... in newpattern.  For example,
  %N '(*).lis' '\$1.txt'
renames 'foo.lis' to 'foo.txt', 'my.old.stuff.lis' to 'my.old.stuff.txt',
and so on.  Something simpler (for basic commands) is the -W option:
  %N -W '*.lis' '*.txt'
This does the same thing as the first command, but with automatic conversion
of the wildcards into the appropriate syntax.  If you combine this with
noglob, you don't even need to quote the arguments.  For example,
  alias mmv='noglob zmv -W'
  mmv *.c.orig orig/*.c" >&2
  return 1
fi

pat=$1
repl=$2
shift 2

if [[ -n $opt_s && $action != ln ]]; then
  print -r -- "$myname: invalid option: -s" >&2
  return 1
fi

if [[ -n $opt_w || -n $opt_W ]]; then
  # Parenthesise all wildcards.
  local tmp find
  integer cnt=0
  # Well, this seems to work.
  # The tricky bit is getting all forms of [...] correct, but as long
  # as we require inactive bits to be backslashed its not so bad.
  find='(#m)((\*\*##/|[*?]|<[0-9]#-[0-9]#>|\[(^|)(\]|)(\[:[a-z]##:\]|\\?|[^\]])##\])\##|?\###)'
  tmp="${pat//${~find}/$[++cnt]}"
  if [[ $cnt = 0 ]]; then
    print -r -- "$myname: warning: no wildcards were found in search pattern" >&2
  else
    pat="${pat//${~find}/($MATCH)}"
  fi
  if [[ -n $opt_W ]]; then
    # Turn wildcards into ${1} .. ${N} references.
    local open='${' close='}'
    integer N=0
    repl="${repl//${~find}/$open$[++N]$close}"
    if [[ $N != $cnt ]]; then
      print -P "%N: error: number of wildcards in each pattern must match" >&2
      return 1
    fi
    if [[ $N = 0 ]]; then
      print -P "%N: warning: no wildcards were found in replacement pattern" >&2
    fi
  fi
fi

if [[ -n $opt_Q && $pat = (#b)(*)\([^\)\|\~]##\) ]]; then
  hasglobqual=q
  # strip off qualifiers for use as ordinary pattern
  opat=$match[1]
fi

if [[ $pat = (#b)(*)\((\*\*##/)\)(*) ]]; then
  fpat="$match[1]$match[2]$match[3]"
  # Now make sure we do depth-first searching.
  # This is so that the names of any files are altered before the
  # names of the directories they are in.
  if [[ -n $opt_Q && -n $hasglobqual ]]; then
    fpat[-1]="odon)"
  else
    setopt bareglobqual
    fpat="${fpat}(odon)"
  fi
else
  fpat=$pat
fi
files=(${~fpat})

[[ -n $hasglobqual ]] && pat=$opat

errs=()

for f in $files; do
  if [[ $pat = (#b)(*)\(\*\*##/\)(*) ]]; then
    # This looks like a recursive glob.  This isn't good enough,
    # because we should really enforce that $match[1] and $match[2]
    # don't match slashes unless they were explicitly given.  But
    # it's a start.  It's fine for the classic case where (**/) is
    # at the start of the pattern.
    pat="$match[1](*/|)$match[2]"
  fi
  [[ -e $f && $f = (#b)${~pat} ]] || continue
  set -- "$match[@]"
  { {
    g=${(Xe)repl}
  } 2> /dev/null } always {
    if (( TRY_BLOCK_ERROR )); then
      print -r -- "$myname: syntax error in replacement" >&2
      return 1
    fi
  }
  if [[ -z $g ]]; then
    errs+=("\`$f' expanded to an empty string")
  elif [[ $f = $g ]]; then
    # don't cause error: more useful just to skip
    #   errs=($errs "$f not altered by substitution")
    [[ -n $opt_v ]] && print -r -- "$f not altered, ignored"
    continue
  elif [[ -n $from[$g] && ! -d $g ]]; then
    errs+=("$f and $from[$g] both map to $g")
  elif [[ -f $g && -z $opt_f && ! ($f -ef $g && $action = mv) ]]; then
    errs+=("file exists: $g")
  fi
  from[$g]=$f
  to[$f]=$g
done

if (( $#errs )); then
  print -r -- "$myname: error(s) in substitution:" >&2
  print -lr -- $errs >&2
  return 1
fi

for f in $files; do
  [[ -z $to[$f] ]] && continue
  exec=(${=action} ${=opt_o} $opt_s $dashes $f $to[$f])
  [[ -n $opt_i$opt_n$opt_v ]] && print -r -- ${(q-)exec}
  if [[ -n $opt_i ]]; then
    read -q 'opt?Execute? ' || continue
  fi
  if [[ -z $opt_n ]]; then
    $exec || stat=1
  fi
done

return $stat
# }
