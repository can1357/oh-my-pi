#!/bin/zsh -i
#
# Zsh calculator.  Understands most ordinary arithmetic expressions.
# Line editing and history are available. A blank line or `q' quits.
#
# Runs as a script or a function.  If used as a function, the history
# is remembered for reuse in a later call (and also currently in the
# shell's own history).  There are various problems using this as a
# script, so a function is recommended.
#
# The prompt shows a number for the current line.  The corresponding
# result can be referred to with $<line-no>, e.g.
#   1> 32 + 10
#   42
#   2> $1 ** 2
#   1764
# The set of remembered numbers is primed with anything given on the
# command line.  For example,
#   zcalc '2 * 16'
#   1> 32                     # printed by function
#   2> $1 + 2                 # typed by user
#   34
#   3> 
# Here, 32 is stored as $1.  This works in the obvious way for any
# number of arguments.
#
# If the mathfunc library is available, probably understands most system
# mathematical functions.  The left parenthesis must be adjacent to the
# end of the function name, to distinguish from shell parameters
# (translation: to prevent the maintainers from having to write proper
# lookahead parsing).  For example,
#   1> sqrt(2)
#   1.4142135623730951
# is right, but `sqrt (2)' will give you an error.
#
# You can do things with parameters like
#   1> pi = 4.0 * atan(1)
# too.  These go into global parameters, so be careful.  You can declare
# local variables, however:
#   1> local pi
# but note this can't appear on the same line as a calculation.  Don't
# use the variables listed in the `local' and `integer' lines below
# (translation: I can't be bothered to provide a sandbox).
#
# You can declare or delete math functions (implemented via zmathfuncdef):
#   1> function cube $1 * $1 * $1
# This has a single compulsory argument.  Note the function takes care of
# the punctuation.  To delete the function, put nothing (at all) after
# the function name:
#   1> function cube
#
# Some constants are already available: (case sensitive as always):
#   PI     pi, i.e. 3.1415926545897931
#   E      e, i.e. 2.7182818284590455
#
# You can also change the output base.
#   1> [#16]
#   1>
# Changes the default output to hexadecimal with numbers preceded by `16#'.
# Note the line isn't remembered.
#   2> [##16]
#   2>
# Change the default output base to hexadecimal with no prefix.
#   3> [#]
# Reset the default output base.
#
# This is based on the builtin feature that you can change the output base
# of a given expression.  For example,
#   1> [##16]  32 + 20 / 2
#   2A
#   2> 
# prints the result of the calculation in hexadecimal.
#
# You can't change the default input base, but the shell allows any small
# integer as a base:
#   1> 2#1111
#   15
#   2> [##13] 13#6 * 13#9
#   42
# and the standard C-like notation with a leading 0x for hexadecimal is
# also understood.  However, leading 0 for octal is not understood --- it's
# too confusing in a calculator.  Use 8#777 etc.
#
# Options: -#<base> is the same as a line containing just `[#<base>],
# similarly -##<base>; they set the default output base, with and without
# a base discriminator in front, respectively.
#
# With the option -e, the arguments are evaluated as if entered
# interactively.  So, for example:
#   zcalc -e -\#16 -e 1055
# prints
#   0x41f
# Any number of expressions may be given and they are evaluated
# sequentially just as if read automatically.

emulate -L zsh
setopt extendedglob typesetsilent

zcalc_show_value() {
  if [[ -n $_base ]]; then
    print -- $(( $_base $1 ))
  elif [[ $1 = *.* ]] || (( _outdigits )); then
    # With normal output, ensure trailing "." doesn't get lost.
    if [[ -z $_forms[_outform] || ($_outform -eq 1 && $1 = *.) ]]; then
      print -- $(( $1 ))
    else
      printf "$_forms[_outform]\n" $_outdigits $1
    fi
  else
    printf "%d\n" $1
  fi
}

# For testing in ZLE functions.
local ZCALC_ACTIVE=1

# TODO: make local variables that shouldn't be visible in expressions
# begin with _.
local _line ans _base _defbase _forms match mbegin mend
local psvar _optlist _opt _arg _tmp
local compcontext="-zcalc-line-"
integer _num _outdigits _outform=1 _expression_mode
integer _rpn_mode _matched _show_stack _i _n
integer _max_stack _push
local -a _expressions stack

# We use our own history file with an automatic pop on exit.
history -ap "${ZDOTDIR:-$HOME}/.zcalc_history"

_forms=( '%2$g' '%.*g' '%.*f' '%.*E' '')

local _mathfuncs
if zmodload -i zsh/mathfunc 2>/dev/null; then
  zmodload -P _mathfuncs -FL zsh/mathfunc
  _mathfuncs="("${(j.|.)${_mathfuncs##f:}}")"
fi
local -A _userfuncs
for _line in ${(f)"$(functions -M)"}; do
  match=(${=_line})
  # get minimum number of arguments
  _userfuncs[${match[3]}]=${match[4]}
done
_line=
autoload -Uz zmathfuncdef

if (( ! ${+ZCALCPROMPT} )); then
  typeset -g ZCALCPROMPT="%1v> "
fi

# Supply some constants.
float PI E
(( PI = 4 * atan(1), E = exp(1) ))

if [[ -f "${ZDOTDIR:-$HOME}/.zcalcrc" ]]; then
  . "${ZDOTDIR:-$HOME}/.zcalcrc" || return 1
fi

# Process command line
while [[ -n $1 && $1 = -(|[#-]*|f|e|r(<->|)) ]]; do
  _optlist=${1[2,-1]}
  shift
  [[ $_optlist = (|-) ]] && break
  while [[ -n $_optlist ]]; do
    _opt=${_optlist[1]}
    _optlist=${_optlist[2,-1]}
    case $_opt in
      ('#') # Default base
            if [[ -n $_optlist ]]; then
	       _arg=$_optlist
	       _optlist=
	    elif [[ -n $1 ]]; then
	       _arg=$1
	       shift
	    else
	       print -- "-# requires an argument" >&2
	       return 1
	    fi
	    if [[ $_arg != (|\#)[[:digit:]]## ]]; then
	      print -- "-# requires a decimal number as an argument" >&2
	      return 1
	    fi
            _defbase="[#${_arg}]"
	    ;;
	(f) # Force floating point operation
	    setopt forcefloat
	    ;;
        (e) # Arguments are expressions
	    (( _expression_mode = 1 ));
	    ;;
        (r) # RPN mode.
	    (( _rpn_mode = 1 ))
	    ZCALC_ACTIVE=rpn
	    if [[ $_optlist = (#b)(<->)* ]]; then
	       (( _show_stack = ${match[1]} ))
               _optlist=${_optlist[${#match[1]}+1,-2]}
	    fi
	    ;;
    esac
  done
done

if (( _expression_mode )); then
  _expressions=("$@")
  argv=()
fi

for (( _num = 1; _num <= $#; _num++ )); do
  # Make sure all arguments have been evaluated.
  # The `$' before the second argv forces string rather than numeric
  # substitution.
  (( argv[$_num] = $argv[$_num] ))
  print "$_num> $argv[$_num]"
done

psvar[1]=$_num
local _prev_line _cont_prompt
while (( _expression_mode )) ||
  vared -cehp "${_cont_prompt}${ZCALCPROMPT}" _line; do
  if (( _expression_mode )); then
    (( ${#_expressions} )) || break
    _line=$_expressions[1]
    shift _expressions
  fi
  if [[ $_line = (|*[^\\])('\\')#'\' ]]; then
    _prev_line+=$_line[1,-2]
    _cont_prompt="..."
    _line=
    continue
  fi
  _line="$_prev_line$_line"
  _prev_line=
  _cont_prompt=
  # Test whether there are as many open as close
  # parentheses in the _line so far.
  if [[ ${#_line//[^\(]} -gt ${#_line//[^\)]} ]]; then
      _prev_line+=$_line
      _cont_prompt="..."
      _line=
      continue
  fi
  [[ -z $_line ]] && break
  # special cases
  # Set default base if `[#16]' or `[##16]' etc. on its own.
  # Unset it if `[#]' or `[##]'.
  if [[ $_line = (#b)[[:blank:]]#('[#'(\#|)((<->|)(|_|_<->))']')[[:blank:]]#(*) ]]; then
    if [[ -z $match[6] ]]; then
      if [[ -z $match[3] ]]; then
	_defbase=
      else
	_defbase=$match[1]
      fi
      print -s -- $_line
      print -- $(( ${_defbase} ans ))
      _line=
      continue
    else
      _base=$match[1]
    fi
  else
    _base=$_defbase
  fi

  print -s -- $_line

  _line="${${_line##[[:blank:]]#}%%[[:blank:]]#}"
  case "$_line" in
    # Escapes begin with a colon
    (:(\\|)\!*)
    # shell escape: handle completion's habit of quoting the !
    eval ${_line##:(\\|)\![[:blank:]]#}
    _line=
    continue
    ;;

    ((:|)q)
    # Exit
    return 0
    ;;

    ((:|)norm) # restore output format to default
      _outform=1
    ;;

    ((:|)sci[[:blank:]]#(#b)(<->)(#B))
      _outdigits=$match[1]
      _outform=2
    ;;

    ((:|)fix[[:blank:]]#(#b)(<->)(#B))
      _outdigits=$match[1]
      _outform=3
    ;;

    ((:|)eng[[:blank:]]#(#b)(<->)(#B))
      _outdigits=$match[1]
      _outform=4
    ;;

    (:raw)
    _outform=5
    ;;

    ((:|)local([[:blank:]]##*|))
      eval ${_line##:}
      _line=
      continue
    ;;

    ((function|:f(unc(tion|)|))[[:blank:]]##(#b)([^[:blank:]]##)(|[[:blank:]]##([^[:blank:]]*)))
      zmathfuncdef $match[1] $match[3]
      _userfuncs[$match[1]]=${$(functions -Mm $match[1])[4]}
      _line=
      continue
    ;;

    (:*)
    print "Unrecognised escape"
    _line=
    continue
    ;;

    (\$[[:IDENT:]]##)
    # Display only, no calculation
    _line=${_line##\$}
    print -r -- ${(P)_line}
    _line=
    continue
    ;;

    (*)
      _line=${${_line##[[:blank:]]##}%%[[:blank:]]##}
      if [[ _rpn_mode -ne 0 && $_line != '' ]]; then
	_push=1
	_matched=1
	case $_line in
	  (\<[[:IDENT:]]##)
	  ans=${(P)${_line##\<}}
	  ;;

	  (\=|pop|\>[[:IDENT:]]#)
	  if (( ${#stack} < 1 )); then
	    print -r -- "${_line}: not enough values on stack" >&2
	    _line=
	    continue
	  fi
	  case $_line in
	    (=)
	    ans=${stack[1]}
	    ;;
	    (pop|\>)
	    _push=0
	    shift stack
	    ;;
	    (\>[[:IDENT:]]##)
	    if [[ ${_line##\>} = (_*|stack|ans|PI|E) ]]; then
	      print "${_line##\>}: reserved variable" >&2
	      _line=
	      continue
	    fi
	    local ${_line##\>}
	    (( ${_line##\>} = ${stack[1]} ))
	    _push=0
	    shift stack
	    ;;
	    (*)
	    print "BUG in special RPN functions" >&2
	    _line=
	    continue
	    ;;
	  esac
	  ;;

	  (+|-|\^|\||\&|\*|/|\*\*|\>\>|\<\</)
	  # Operators with two arguments
	  if (( ${#stack} < 2 )); then
	    print -r -- "${_line}: not enough values on stack" >&2
	    _line=
	    continue
	  fi
	  eval "(( ans = \${stack[2]} $_line \${stack[1]} ))"
	  shift 2 stack
	  ;;

	  (ldexp|jn|yn|scalb|xy|\<\>)
	  # Functions with two arguments
	  if (( ${#stack} < 2 )); then
	    print -r -- "${_line}: not enough values on stack" >&2
	    _line=
	    continue
	  fi
	  if [[ $_line = (xy|\<\>) ]]; then
	    _tmp=${stack[1]}
	    stack[1]=${stack[2]}
	    stack[2]=$_tmp
	    _push=0
	  else
	    eval "(( ans = ${_line}(\${stack[2]},\${stack[1]}) ))"
	    shift 2 stack
	  fi
	  ;;

	  (${~_mathfuncs})
	  # Functions with a single argument.
	  # This is actually a superset, but we should have matched
	  # any that shouldn't be in it in previous cases.
	  if (( ${#stack} < 1 )); then
	    print -r -- "${_line}: not enough values on stack" >&2
	    _line=
	    continue
	  fi
	  eval "(( ans = ${_line}(\${stack[1]}) ))"
	  shift stack
	  ;;

	  (${(kj.|.)~_userfuncs})
	  # Get minimum number of arguments to user function
	  _n=${_userfuncs[$_line]}
	  if (( ${#stack} < n_ )); then
	    print -r -- "${_line}: not enough values ($_n) on stack" >&2
	    _line=
	    continue
	  fi
	  _line+="("
	  # least recent elements on stack are earlier arguments
	  for (( _i = _n; _i > 0; _i-- )); do
	    _line+=${stack[_i]}
	    (( _i > 1 )) && _line+=","
	  done
	  _line+=")"
	  shift $_n stack
	  eval "(( ans = $_line ))"
	  ;;

	  (*)
	  # Treat as expression evaluating to new value to go on stack.
	  _matched=0
	  ;;
	esac
      else
	_matched=0
      fi
      if (( ! _matched )); then
	# Latest value is stored` as a string, because it might be floating
	# point or integer --- we don't know till after the evaluation, and
	# arrays always store scalars anyway.
	#
	# Since it's a string, we'd better make sure we know which
	# base it's in, so don't change that until we actually print it.
	if ! eval "ans=\$(( $_line ))"; then
	  _line=
	  continue
	fi
	# on error $ans is not set; let user re-edit _line
	[[ -n $ans ]] || continue
      fi
      argv[_num++]=$ans
      psvar[1]=$_num
      (( _push )) && stack=($ans $stack)
    ;;
  esac
  if (( _show_stack )); then
    (( _max_stack = (_show_stack > ${#stack}) ? ${#stack} : _show_stack ))
    for (( _i = _max_stack; _i > 0; _i-- )); do
      printf "%3d: " $_i
      zcalc_show_value ${stack[_i]}
    done
  else
    zcalc_show_value $ans
  fi
  _line=
done

return 0
