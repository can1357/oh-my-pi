//! zsh 5.9 `Test/Y03arguments.ztst` (`_arguments`) through the port of its
//! `comptest` harness (`comp_support::comptest`): obash runs as `zsh -f +Z` on
//! a pty, with zsh 5.9's installed completion functions, and every `comptest`
//! report must equal zsh's.
//!
//! The steps and reports below were recorded by running the `.ztst` file
//! under `/bin/zsh` 5.9 with `comptest` wrapped to log each `comptesteval`,
//! each `comptest` input and its report, and the file operations of the
//! test script; the reports equal the file's expected output (all of its
//! tests pass under `/bin/zsh`) except where zsh itself is expected to fail
//! (`f` flag), which are pinned to zsh's actual report. `PI_COMP_ORACLE=1`
//! runs them against `/bin/zsh` through this harness.

#![cfg(unix)]

mod comp_support;
mod pty_support;

use comp_support::comptest::{
	Case,
	Step::{self, Eval, Test},
	Suite, run_case,
};

/// The `%prep` steps (after `comptestinit`).
const PREP: &[Step] = &[Eval("compdef _tst tst")];

/// The `%test` chunks in file order.
const CASES: &[Case] = &[
	Case {
		name:  "one non-option argument",
		steps: &[
			Eval("_tst () { _arguments ':desc1:(arg1)' }"),
			Test(
				"tst \t\x17a\t\x17ar\t\x17arg\t\x17arg1\t\x17r\t\x17x\t \ty \t",
				"line: {tst arg1 }{}\nline: {tst arg1 }{}\nline: {tst arg1 }{}\nline: {tst arg1 \
				 }{}\nline: {tst arg1 }{}\nline: {tst r}{}\nline: {tst x}{}\nline: {tst x \
				 }{}\nMESSAGE:{no more arguments}\nline: {tst x y }{}\nMESSAGE:{no more arguments}",
			),
		],
	},
	Case {
		name:  "a and b",
		steps: &[
			Eval("_tst () { _arguments ':desc1:(a b)' }"),
			Test("tst \t", "line: {tst }{}\nDESCRIPTION:{desc1}\nNO:{a}\nNO:{b}"),
		],
	},
	Case {
		name:  "a and b with descriptions",
		steps: &[
			Eval("_tst () { _arguments ':desc2:((a\\:a\\ value b\\:other\\\\\\\\value))' }"),
			Test(
				"tst \t",
				"line: {tst }{}\nDESCRIPTION:{desc2}\nNO:{a  -- a value}\nNO:{b  -- other\\value}",
			),
		],
	},
	Case {
		name:  "three arguments",
		steps: &[
			Eval("_tst () { _arguments ':desc1:(arg1)' ':desc2:(arg2)' ':desc3:(arg3)' }"),
			Test(
				"tst \t\t\t\x17\x17\x17\x04",
				"line: {tst arg1 }{}\nline: {tst arg1 arg2 }{}\nline: {tst arg1 arg2 arg3 \
				 }{}\nDESCRIPTION:{desc1}\nNO:{arg1}",
			),
		],
	},
	Case {
		name:  "first argument",
		steps: &[
			Eval("_tst () { _arguments '1:desc1:(arg1)' }"),
			Test("tst \t\t", "line: {tst arg1 }{}\nline: {tst arg1 }{}\nMESSAGE:{no more arguments}"),
		],
	},
	Case {
		name:  "second argument but no first argument",
		steps: &[
			Eval("_tst () { _arguments '-a' '2:desc2:(arg2)' }"),
			Test(
				"tst a1\t \t",
				"line: {tst a1}{}\nMESSAGE:{no more arguments}\nline: {tst a1 arg2 }{}",
			),
		],
	},
	Case {
		name:  "second and rest arguments but no first argument",
		steps: &[
			Eval("_tst () { _arguments '2:desc2:(arg2)' '*:rest:(rest)' }"),
			Test(
				"tst \t\t\t",
				"line: {tst rest }{}\nline: {tst rest arg2 }{}\nline: {tst rest arg2 rest }{}",
			),
		],
	},
	Case {
		name:  "-+",
		steps: &[
			Eval("_tst () { _arguments '-\\+[opt]' }"),
			Test("tst -\x04", "DESCRIPTION:{option}\nNO:{-+  -- opt}"),
		],
	},
	Case {
		name:  "option beginning with + and -.",
		steps: &[
			Eval("_tst () { _arguments '-+o' }"),
			Test(
				"tst -\t\t\t\x17\x17+\t\t\t",
				"line: {tst -o }{}\nline: {tst -o +o }{}\nline: {tst -o +o }{}\nMESSAGE:{no \
				 arguments}\nline: {tst +o }{}\nline: {tst +o -o }{}\nline: {tst +o -o \
				 }{}\nMESSAGE:{no arguments}",
			),
		],
	},
	Case {
		name:  "option beginning with + and -, specified the other way around",
		steps: &[
			Eval("_tst () { _arguments '+-o' }"),
			Test("tst \t", "line: {tst }{}\nDESCRIPTION:{option}\nNO:{+o}\nNO:{-o}"),
		],
	},
	Case {
		name:  "mix of + and - and exclusion of stacked options",
		steps: &[
			Eval("_tst () { _arguments '-s' '-a' '-b' '-c' '!-d' '!-e' '!-f' '!+d' '!+e' '!+f' }"),
			Test(
				"tst -ad\t\x14\t\x08ef\t",
				"line: {tst -ad}{}\nDESCRIPTION:{option}\nNO:{-b}\nNO:{-c}\nline: {tst \
				 -da}{}\nDESCRIPTION:{option}\nNO:{-b}\nNO:{-c}\nline: {tst \
				 -def}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}\nNO:{-c}",
			),
		],
	},
	Case {
		name:  "mix of + and - and exclusion of stacked options",
		steps: &[
			Eval("_tst () { _arguments '-s' '-a' '-b' '-c' '+a' '+b' '+c' }"),
			Test("tst -a +b +c\t", "line: {tst -a +b +ca}{}"),
		],
	},
	Case {
		name:  "two option arguments",
		steps: &[
			Eval("_tst () { _arguments '-o:1:(a):2:(b)' }"),
			Test("tst \t\t\t", "line: {tst -o }{}\nline: {tst -o a }{}\nline: {tst -o a b }{}"),
		],
	},
	Case {
		name:  "option argument to ignored option",
		steps: &[
			Eval("_tst () { _arguments '!-x:arg:(ok)' }"),
			Test("tst -x \t", "line: {tst -x ok }{}"),
		],
	},
	Case {
		name:  "ignored option not completed",
		steps: &[Eval("_tst () { _arguments '!-a' '-b' }"), Test("tst -\t", "line: {tst -b }{}")],
	},
	Case {
		name:  "ignored option is not taken to be the normal argument",
		steps: &[
			Eval("_tst () { _arguments '+x' '+y' '!+z' ':arg:(x)' }"),
			Test("tst +z \t", "line: {tst +z x }{}"),
		],
	},
	Case {
		name:  "unrecognised option has no effect on proceedings with no normal arguments",
		steps: &[
			Eval("_tst () { _arguments '--known' '--other' }"),
			Test("tst --unknown -\t", "line: {tst --unknown --}{}"),
		],
	},
	Case {
		name:  "unrecognised option is taken to be the normal argument",
		steps: &[
			Eval("_tst () { _arguments '+x' '+y' ':arg:(x)' }"),
			Test("tst +z \t", "line: {tst +z +}{}"),
		],
	},
	Case {
		name:  "option argument follows in next argument",
		steps: &[
			Eval("_tst () { _arguments '*-a:value:(1)' }"),
			Test(
				"tst -a\t\t -a=\t",
				"line: {tst -a }{}\nline: {tst -a 1 }{}\nline: {tst -a 1 -a=}{}\nMESSAGE:{no \
				 arguments}",
			),
		],
	},
	Case {
		name:  "option argument either direct or in following argument",
		steps: &[
			Eval("_tst () { _arguments '*-a+:value:(1)' }"),
			Test(
				"tst -a\t -a \t -a=\t",
				"line: {tst -a1 }{}\nline: {tst -a1 -a 1 }{}\nline: {tst -a1 -a 1 -a=}{}",
			),
		],
	},
	Case {
		name:  "option argument follows directly",
		steps: &[
			Eval("_tst () { _arguments '*-a-:value:(1)' }"),
			Test(
				"tst -a\t -a \t=\t",
				"line: {tst -a1 }{}\nline: {tst -a1 -a -a}{}\nline: {tst -a1 -a -a=}{}",
			),
		],
	},
	Case {
		name:  "option argument follows optional equals",
		steps: &[
			Eval("_tst () { _arguments '*-a=:value:(1)' }"),
			Test(
				"tst -a\t\t -a \t",
				"line: {tst -a=}{}\nline: {tst -a=1 }{}\nline: {tst -a=1 -a 1 }{}",
			),
		],
	},
	Case {
		name:  "option argument follows optional equals, with -s",
		steps: &[
			Eval("_tst () { _arguments '-s' '*-a=:value:(1)' }"),
			Test(
				"tst -a\t-a=\t -a \t",
				"line: {tst -a1 }{}\nline: {tst -a1 -a=1 }{}\nline: {tst -a1 -a=1 -a 1 }{}",
			),
		],
	},
	Case {
		name:  "option argument follows mandatory equals",
		steps: &[
			Eval("_tst () { _arguments '*-a=-:value:(1)' }"),
			Test(
				"tst -a\t\t-a \t",
				"line: {tst -a=}{}\nline: {tst -a=1 }{}\nline: {tst -a=1 -a -a=}{}",
			),
		],
	},
	Case {
		name:  "sticky option argument",
		steps: &[Eval("_tst () { _arguments '-x:arg:' }"), Test("tst -x\t", "line: {tst -x }{}")],
	},
	Case {
		name:  "option argument with prefix that passes option prefix-needed test",
		steps: &[
			Eval("_tst () { _arguments '-x:arg' '-y' '-z' }"),
			Test("tst -x -\t", "line: {tst -x -}{}\nDESCRIPTION:{arg}"),
		],
	},
	Case {
		name:  "end of option sequence",
		steps: &[Eval("_tst () { _arguments '-x[desc]' }"), Test("tst -x\t", "line: {tst -x }{}")],
	},
	Case {
		name:  "argument beginning with minus",
		steps: &[
			Eval("_tst () { _arguments '-x' ':arg:' }"),
			Test("tst -\t", "line: {tst -}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{-x}"),
		],
	},
	Case {
		name:  "argument beginning with minus, guard on rest argument",
		steps: &[
			Eval("_tst () { _arguments '-x' ': :_guard '\\''[0-9]#'\\'' number' }"),
			Test("tst -\t", "line: {tst -x }{}"),
		],
	},
	Case {
		name:  "optional option argument",
		steps: &[
			Eval("_tst () { _arguments '-o::optarg:(oa)' ':arg1:(a1)' }"),
			Test(
				"tst -o\t\t",
				"line: {tst -o }{}\nline: {tst -o \
				 }{}\nDESCRIPTION:{optarg}\nNO:{oa}\nDESCRIPTION:{arg1}\nNO:{a1}",
			),
		],
	},
	Case {
		name:  "variable length option arguments",
		steps: &[
			Eval("_tst () { _arguments '-o:*a:a:(a)' ':A:(A)' ':B:(B)' }"),
			Test(
				"tst A -o a \t\x17\x17-a -b -c a \t",
				"line: {tst A -o a B }{}\nline: {tst A -o -a -b -c a B }{}",
			),
		],
	},
	Case {
		name:  "opt_args",
		steps: &[
			Eval("_tst () { _arguments '-s' '-a' '-b' ':descr:{compadd - $+opt_args[-a]}' }"),
			Test("tst -ab \t", "line: {tst -ab 1 }{}"),
		],
	},
	Case {
		name:  "opt_args with multiple arguments and quoting of colons and backslashes, part #1: \
		        default behaviour",
		steps: &[
			Eval("_tst () { _arguments '-a:one: :two' ':descr:{compadd -Q - $opt_args[-a]}' }"),
			Test("tst -a 1:x \\2 \t", "line: {tst -a 1:x \\2 1\\:x:\\\\2 }{}"),
		],
	},
	Case {
		name:  "opt_args with multiple arguments and quoting of colons and backslashes, part #2: \
		        NUL escaping",
		steps: &[
			Eval(
				"_tst () { _arguments '-0' ':' '-a:one: :two' ':descr:{compadd -Q - \
				 ${(qqqq)opt_args[-a]}}' }",
			),
			Test("tst -a 1:x \\2 \t", "line: {tst -a 1:x \\2 $'1:x\\0\\\\2' }{}"),
		],
	},
	Case {
		name:  "option completion with rest arguments on the line but not in the specs",
		steps: &[
			Eval("_tst () { _arguments '-a' '-b' }"),
			Test(
				"tst  rest -\t\x17\x1bb\x02-\t",
				"line: {tst  rest -}{}\nline: {tst -}{ rest }\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}",
			),
		],
	},
	Case {
		name:  "optarg completion following rest operand on line (workers/42141)",
		steps: &[
			Eval("_tst () { _arguments '*-x+:optarg:(1)' '*--xxx=:optarg:(1)' '*:operand:(a)' }"),
			Test("tst \t", "line: {tst a }{}"),
			Test("tst -x \t", "line: {tst -x 1 }{}"),
			Test("tst -x\t", "line: {tst -x1 }{}"),
			Test("tst --xxx=\t", "line: {tst --xxx=1 }{}"),
			Test("tst --xxx \t", "line: {tst --xxx 1 }{}"),
			Test("tst a -x\t", "line: {tst a -x1 }{}"),
			Test("tst a -x \t", "line: {tst a -x 1 }{}"),
			Test("tst a --xxx=\t", "line: {tst a --xxx=1 }{}"),
			Test("tst a --xxx \t", "line: {tst a --xxx 1 }{}"),
		],
	},
	Case {
		name:  "rest arguments",
		steps: &[
			Eval("_tst () { _arguments '-a' '*::rest:{compadd - -b}' }"),
			Test("tst arg -\t", "line: {tst arg -b }{}"),
		],
	},
	Case {
		name:  "rest arguments with single colon",
		steps: &[
			Eval("_tst () { _arguments '-a' ':more' '*:rest:{ compadd - $words }' }"),
			Test("tst x -a rest \t", "line: {tst x -a rest }{}\nNO:{-a}\nNO:{rest}\nNO:{tst}\nNO:{x}"),
		],
	},
	Case {
		name:  "rest arguments with two colons",
		steps: &[
			Eval("_tst () { _arguments '-a' ':more' '*::rest:{ compadd - $words }' }"),
			Test(
				"tst x -a rest \t\x1bb\x1bb\x1bb\x1bt\x05 \t",
				"line: {tst x -a rest rest }{}\nline: {tst -a x rest rest }{}\nNO:{rest}\nNO:{x}",
			),
		],
	},
	Case {
		name:  "rest arguments with three colons",
		steps: &[
			Eval("_tst () { _arguments '-a' '-b' ':more' '*:::rest:{ compadd - $words }' }"),
			Test("tst -b x -a -x rest \t", "line: {tst -b x -a -x rest }{}\nNO:{-x}\nNO:{rest}"),
		],
	},
	Case {
		name:  "rest arguments with three colons following optional argument",
		steps: &[
			Eval("_tst () { _arguments '-a' '::more' '*:::rest:{ compadd - $words }' }"),
			Test("tst -a opt rest \t", "line: {tst -a opt rest rest }{}"),
		],
	},
	Case {
		name:  "rest arguments with three colons following optional argument to an option",
		steps: &[
			Eval("_tst () { _arguments '-a::arg' '*:::rest:{ compadd - $words }' }"),
			Test("tst -a opt rest \t", "line: {tst -a opt rest rest }{}"),
		],
	},
	Case {
		name:  "words array in rest arguments",
		steps: &[
			Eval("_tst () { _arguments '-e:*last:::b:{compadd \"${(j:,:)words}\"}' ':arg1:(arg1)' }"),
			Test(
				"tst -\t\tla\t\x08st\t\t\x1bb\x1bb\x02\t\t",
				"line: {tst -e }{}\nline: {tst -e  }{}\nline: {tst -e  la }{}\nline: {tst -e  last \
				 }{}\nline: {tst -e  last arg1 }{}\nline: {tst -e ,last }{ last arg1}\nline: {tst -e \
				 ,last ,last,,last }{ last arg1}",
			),
		],
	},
	Case {
		name:  "opt_args",
		steps: &[
			Eval("_tst () { _arguments '-s' '-d+:msg1:' '*::msg2:{compadd $CURRENT}' }"),
			Test(
				"tst add \t\t\t",
				"line: {tst add 2 }{}\nline: {tst add 2 3 }{}\nline: {tst add 2 3 4 }{}",
			),
		],
	},
	Case {
		name:  "options and words (zsh-workers:12257)",
		steps: &[
			Eval("_tst () { _arguments '-s' '-a' '-b' '-c' ':words:compadd - abyyy abzzz' }"),
			Test("tst ab\t", "line: {tst ab}{}\nDESCRIPTION:{words}\nNO:{abyyy}\nNO:{abzzz}"),
		],
	},
	Case {
		name:  "matcher applies to options but not rest arguments",
		steps: &[
			Eval("_tst () { _arguments '-M' 'm:{j}={y}' '-y' '-n' ':yes/no:(y n)' }"),
			Test("tst j\t\x1bb-\x05\t", "line: {tst j}{}\nline: {tst -y }{}"),
		],
	},
	Case {
		name:  "matcher in combination with sets (implies separate cadef structure)",
		steps: &[
			Eval("_tst () { _arguments '-M' 'm:{j}={y}' '-y' '-n' '-' 'set1' '-i' '-' 'set2' '-k' }"),
			Test("tst -k -j\t", "line: {tst -k -y }{}"),
		],
	},
	Case {
		name:  "option after --",
		steps: &[
			Eval("_tst () { _arguments '-x' ':word' }"),
			Test("tst -- -\t", "line: {tst -- -x }{}"),
		],
	},
	Case {
		name:  "disallowed option after --",
		steps: &[
			Eval("_tst () { _arguments '-S' '-x' ':word:()' }"),
			Test("tst -- -\t", "line: {tst -- -}{}"),
		],
	},
	Case {
		name:  "allowed option before --",
		steps: &[
			Eval("_tst () { _arguments '-S' '-x' ':word:()' }"),
			Test("tst - --\x1bB\x02\t", "line: {tst -x }{ --}"),
		],
	},
	Case {
		name:  "only first of duplicate -- is ignored",
		steps: &[
			Eval("_tst () { _arguments '-S' '1:one' '2:two' }"),
			Test("tst -- -- \t", "line: {tst -- -- }{}\nDESCRIPTION:{two}"),
		],
	},
	Case {
		name:  "option after a word",
		steps: &[
			Eval("_tst () { _arguments '-x' ':word' }"),
			Test("tst word -\t", "line: {tst word -x }{}"),
		],
	},
	Case {
		name:  "long option after word that doesn't match -A pattern",
		steps: &[
			Eval("_tst () { _arguments '-A' '-*' '-x' '--extra' '::first' }"),
			Test("tst word -\t", "line: {tst word -}{}\nMESSAGE:{no more arguments}"),
		],
	},
	Case {
		name:  "option after word that doesn't match -A pattern, no space before pattern",
		steps: &[
			Eval("_tst () { _arguments '-A-*' '-x' ':word' }"),
			Test("tst word -\t", "line: {tst word -}{}\nMESSAGE:{no more arguments}"),
		],
	},
	Case {
		name:  "option before a word that doesn't match -A pattern, separate -A from pattern",
		steps: &[
			Eval("_tst () { _arguments '-A' '-*' '-x' ':word:(-word)' }"),
			Test(
				"tst  word\x1bB\x02-\t",
				"line: {tst -}{ word}\nDESCRIPTION:{word}\nNO:{-word}\nDESCRIPTION:{option}\nNO:{-x}",
			),
		],
	},
	Case {
		name:  "continue completion after rest argument that looks like an option",
		steps: &[
			Eval("_tst () { _arguments '-A' '-*' '-h' '-V' '-a' '*: :(-x more)' }"),
			Test("tst -a -x m\t", "line: {tst -a -x more }{}"),
		],
	},
	Case {
		name:  "word matching -A pattern doesn't exclude options",
		steps: &[
			Eval("_tst () { _arguments '-A' '-*' '-a' '-b' '*: :(words)' }"),
			Test("tst -x -\t", "line: {tst -x -}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}"),
		],
	},
	Case {
		name:  "unrecognised word matching -A pattern not treated as a rest argument",
		steps: &[
			Eval("_tst () { _arguments '-A' '-*' '-a' '-b' '1:word:(word)' }"),
			Test("tst -x \t", "line: {tst -x word }{}"),
		],
	},
	Case {
		name:  "exclusion from option following word matching -A pattern should not apply",
		steps: &[
			Eval(
				"_tst () { _arguments '-A' '-*' '(3)-a' '1:one' '2:two' '3:three' '4:four' '*:extra' }",
			),
			Test("tst x -a \t", "line: {tst x -a }{}\nDESCRIPTION:{three}"),
		],
	},
	Case {
		name:  "repeatable options",
		steps: &[Eval("_tst () { _arguments '*-v' }"), Test("tst -v -\t", "line: {tst -v -v }{}")],
	},
	Case {
		name:  "rest arguments from another set not completed after option from first set",
		steps: &[
			Eval(
				"_tst () { _arguments '-' 'set1' '--label=:arg:(a b)' '-' 'set2' ':rest:(rest args \
				 --label=not)' }",
			),
			Test("tst --label=\t", "line: {tst --label=}{}\nDESCRIPTION:{arg}\nNO:{a}\nNO:{b}"),
		],
	},
	Case {
		name:  "continue completion after rest argument that looks like an option (with sets)",
		steps: &[
			Eval(
				"_tst () { _arguments '-A' '-*' '-' 'help' '-h' '-V' '-' 'other' '-a' '*: :(-x more)' \
				 }",
			),
			Test("tst -a -x m\t", "line: {tst -a -x more }{}"),
		],
	},
	Case {
		name:  "foreign option disables whole set (without -A)",
		steps: &[
			Eval("_tst () { _arguments '-' '(help)' '-h' '-V' '-' 'other' '-a' '*:rest:(1 2 3)' }"),
			Test("tst -h \t-a \t", "line: {tst -h }{}\nMESSAGE:{no arguments}\nline: {tst -h -a }{}"),
		],
	},
	Case {
		name:  "foreign option disables whole set (with -A)",
		steps: &[
			Eval(
				"_tst () { _arguments '-A' '-*' '-' '(help)' '-h' '-V' '-' 'other' '-a' '*:rest:(1 2 \
				 3)' }",
			),
			Test("tst -h \t-a \t", "line: {tst -h }{}\nMESSAGE:{no arguments}\nline: {tst -h -a }{}"),
		],
	},
	Case {
		name:  "exclude option common to two sets and from one common option",
		steps: &[
			Eval("_tst () { _arguments '(-C)-a' '-' 'set1' '-C' '-v' '-' 'set2' '(-a)-C' '-w' }"),
			Test(
				"tst -a -\t \x17\x17-C -\t",
				"line: {tst -a -}{}\nDESCRIPTION:{option}\nNO:{-v}\nNO:{-w}\nline: {tst -C \
				 -}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-v}\nNO:{-w}",
			),
		],
	},
	Case {
		name:  "rest argument rule in two sets",
		steps: &[
			Eval(
				"_tst () { _arguments '-e' '-' 'one' '-o' '*:number:(1 2)' '-' 'two' '(-e)*:letter:(a \
				 b)' }",
			),
			Test(
				"tst \t a -\t",
				concat!(
					"line: {tst }{}\n",
					"DESCRIPTION:{letter}\n",
					"NO:{a}\n",
					"NO:{b}\n",
					"DESCRIPTION:{number}\n",
					"NO:{1}\n",
					"NO:{2}\n",
					"line: {tst  a -}{}\n",
					"DESCRIPTION:{option}\n",
					"NO:{-e}\n",
					"NO:{-o}",
				),
			),
		],
	},
	Case {
		name:  "exclude various forms of rest argument in set specific form",
		steps: &[
			Eval(
				"_tst () { _arguments '(set1-: set2-* set3-1)-a' '-' 'set1' '1: :(1)' '2: :(2)' '-' \
				 'set2' '*:rest:(rest)' '-' 'set3' '1:num:(num)' '*: :(allowable)' '-' 'set4' ': \
				 :(allowed)' }",
			),
			Test("tst -a \t", "line: {tst -a allow}{}"),
		],
	},
	Case {
		name:  "exclusion lists",
		steps: &[
			Eval(
				"_tst () { _arguments '(-v)-a' '(set1--m -a)-b' '-' '(set1)' '( -a )-m' '( )-n' '-' \
				 'set2' '(-w)*-v' '-w' }",
			),
			Test(
				"tst -a -\t \x17\x17-b -\t \x17\x17-m -\t \x17\x17-v -\t",
				"line: {tst -a -}{}\nDESCRIPTION:{option}\nNO:{-b}\nNO:{-m}\nNO:{-n}\nNO:{-w}\nline: \
				 {tst -b -}{}\nDESCRIPTION:{option}\nNO:{-n}\nNO:{-v}\nNO:{-w}\nline: {tst -m -b \
				 }{}\nline: {tst -v -}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}\nNO:{-v}",
			),
		],
	},
	Case {
		name:  "exclude option from normal argument to the right of the cursor",
		steps: &[
			Eval("_tst () { _arguments '-a' '-b' '-c' '(-a)1:one' '(-b)2:two' '(-c)*:extra' }"),
			Test(
				"tst  x y z\x1b6\x02-\t",
				"line: {tst -}{ x y \
				 z}\nDESCRIPTION:{one}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}\nNO:{-c}",
			),
		],
	},
	Case {
		name:  "exclude own set from an option",
		steps: &[
			Eval(
				"_tst () { _arguments '-a' '-' 'set1' '-d' '-' 'set2' '(set2)-m' '-n' '-o' ':arg:(x)' \
				 '-' 'set2' '-x' }",
			),
			Test("tst -m \t", "line: {tst -m -a }{}"),
		],
	},
	Case {
		name:  "exclude later set from an option common to both",
		steps: &[
			Eval("_tst () { _arguments '-' 'set1' '(set2)-a' '-m' '-n' '-' 'set2' '-a' '-t' '-u' }"),
			Test(
				"tst -a -\t",
				"line: {tst -a -}{}\nDESCRIPTION:{option}\nNO:{-m}\nNO:{-n}\nNO:{-t}\nNO:{-u}",
			),
		],
	},
	Case {
		name:  "exclude earlier set from an option common to both",
		steps: &[
			Eval("_tst () { _arguments '-' 'set2' '-a' '-t' '-u' '-' 'set1' '(set2)-a' '-m' '-n' }"),
			Test(
				"tst -a -\t",
				"line: {tst -a -}{}\nDESCRIPTION:{option}\nNO:{-m}\nNO:{-n}\nNO:{-t}\nNO:{-u}",
			),
		],
	},
	Case {
		name:  "single option sets are still mutually exclusive",
		steps: &[
			Eval("_tst () { _arguments '-x' '-' '(set1)' '-a' '-b' '-' '(set2)' '-m' '-n' }"),
			Test("tst -m -\t", "line: {tst -m -x }{}"),
		],
	},
	Case {
		name:  "excluding a set doesn't exclude common options as part of the set",
		steps: &[
			Eval(
				"_tst () { _arguments '(set-c set-g)-a' '(set)-b' '-c' '+' 'grp' '-g' '-' 'set' '-s' }",
			),
			Test("tst -a -b -\t", "line: {tst -a -b -}{}\nDESCRIPTION:{option}\nNO:{-c}\nNO:{-g}"),
		],
	},
	Case {
		name:  "exclude all other options",
		steps: &[
			Eval("_tst () { _arguments '(-)-h' '-a' '-b' '-c' '--long' '+p' }"),
			Test("tst -h -\t", "line: {tst -h -}{}\nMESSAGE:{no arguments}"),
		],
	},
	Case {
		name:  "exclude all options from a normal argument",
		steps: &[
			Eval("_tst () { _arguments '--args' '-b' '-c' '+p' '(-)1:normal' }"),
			Test("tst arg -\t", "line: {tst arg -}{}\nMESSAGE:{no more arguments}"),
		],
	},
	Case {
		name:  "exclusion only applies to later words",
		steps: &[
			Eval("_tst () { _arguments '-a' '(-a)-b' }"),
			Test(
				"tst - -b\x02\x02\x02\t",
				"line: {tst -}{ -b}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}",
			),
		],
	},
	Case {
		name:  "exclusion with clumped options, in, after and before",
		steps: &[
			Eval("_tst () { _arguments '-s' ':' '(-d)-a' '-b' '-c' '-d' }"),
			Test(
				"tst -ab\t\x08 -\t\x1bb\x1bb \x02-\t",
				"line: {tst -abc}{}\nline: {tst -ab -c }{}\nline: {tst -}{ -ab \
				 -c}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}\nNO:{-c}\nNO:{-d}",
			),
		],
	},
	Case {
		name:  "don't prematurely exclude option that current word is a prefix of",
		steps: &[
			Eval("_tst () { _arguments '-s' '(-conf)-c' '-conf' '-f' '(-)--long' '--longer' }"),
			Test(
				"tst -c\t\x08-long\t",
				"line: {tst -c}{}\nDESCRIPTION:{option}\nNO:{-conf}\nNO:{-f}\nline: {tst \
				 --long}{}\nDESCRIPTION:{option}\nNO:{--long}\nNO:{--longer}",
			),
		],
	},
	Case {
		name:  "don't prematurely exclude option that current word is a prefix of (with sets)",
		steps: &[
			Eval("_tst () { _arguments '-s' '(set)-c' '-' 'set' '-conf' '-f' }"),
			Test("tst -c\t", "line: {tst -conf }{}"),
		],
	},
	Case {
		name:  "option clumping mixed with real option that looks like clump",
		steps: &[
			Eval("_tst () { _arguments '-s' ':' '-ad' '(-d)-a' '-b' '-ca' '-d' }"),
			Test(
				"tst -ad\t-b\t",
				"line: {tst -ad }{}\nline: {tst -ad -b}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-d}",
			),
		],
	},
	Case {
		name:  "option clumping mixed with direct argument",
		steps: &[
			Eval("_tst () { _arguments '-s' ':' '(-d)-a+:arg:(b)' '(-c)-b' '-c' '-d' }"),
			Test(
				"tst -ab\t-\t",
				"line: {tst -ab }{}\nline: {tst -ab -}{}\nDESCRIPTION:{option}\nNO:{-b}\nNO:{-c}",
			),
		],
	},
	Case {
		name:  "exclusion with option argument that looks like an option",
		steps: &[
			Eval("_tst () { _arguments '-a:arg' '-b' '(-b)-c' }"),
			Test("tst -a -c -\t", "line: {tst -a -c -}{}\nMESSAGE:{no arguments}"),
		],
	},
	Case {
		name:  "exclude group options",
		steps: &[
			Eval(
				"_tst () { _arguments '+' 'grp1' '-a' '-b' '-' 'onlyset' '(-a grp3--y grp2 grp4--)-m' \
				 '-n' '+' 'grp2' '-u' '-v' '+' 'grp3' '-x' '-y' '+' 'grp4' '-0' ':rest' }",
			),
			Test(
				"tst -m -\t",
				"line: {tst -m \
				 -}{}\nDESCRIPTION:{rest}\nDESCRIPTION:{option}\nNO:{-b}\nNO:{-n}\nNO:{-x}",
			),
		],
	},
	Case {
		name:  "single option groups are not mutually exclusive",
		steps: &[
			Eval("_tst () { _arguments '-x' '+' '(grp1)' '-a' '-b' '+' '(grp2)' '-m' '-n' }"),
			Test("tst -m -\t", "line: {tst -m -}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-b}\nNO:{-x}"),
		],
	},
	Case {
		name:  "exclude rest args listed within a group",
		steps: &[
			Eval(
				"_tst () { _arguments '(grp1 grp2-2)-a' '(grp1-*)-b' '+' 'grp1' ':first' '*:rest' '+' \
				 'grp2' ':second' }",
			),
			Test("tst -a \t\x1bb\x17\x05 x y \t", "line: {tst -a -b }{}\nline: {tst -b x y -a }{}"),
		],
	},
	Case {
		name:  "two forms of same option in different groups",
		steps: &[
			Eval(
				"_tst () { _arguments '(grp--m)-a' '+' 'grp' '-m:value:(a b c)' '+' 'agrp' \
				 '-m:other:(1 2 3)' }",
			),
			Test(
				"tst -m \t\x17-a -m \t",
				"line: {tst -m }{}\nDESCRIPTION:{value}\nNO:{a}\nNO:{b}\nNO:{c}\nline: {tst -a -m \
				 }{}\nDESCRIPTION:{other}\nNO:{1}\nNO:{2}\nNO:{3}",
			),
		],
	},
	Case {
		name:  "normal argument excludes options in internally mutually exclusive group",
		steps: &[
			Eval("_tst () { _arguments '(grp--m)-x' '+' '(grp)' '-a' '-b' '-c' ':val:(1 2 3)' }"),
			Test("tst 1 -\t", "line: {tst 1 -x }{}"),
		],
	},
	Case {
		name:  "mix sets, groups and option stacking",
		steps: &[
			Eval(
				"_tst () { _arguments '-s' '-a' '-' 'set1' '-c' '-s' '-' 'set2' '-c' '-t' '+' 'grp' \
				 '-d' }",
			),
			Test(
				"tst -s\t -\t",
				"line: {tst -s}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-c}\nNO:{-d}\nNO:{-t}\nline: \
				 {tst -s -}{}\nDESCRIPTION:{option}\nNO:{-a}\nNO:{-c}\nNO:{-d}",
			),
		],
	},
	Case {
		name:  "sets and groups with - in their name",
		steps: &[
			Eval(
				"_tst () { _arguments '-s' '(set-a set--b grp-a grp--b grp-)-a' '-' 'set-a' '-s' '-' \
				 'set--b' '-t' '+' 'grp-a' '-g' '+' 'grp--b' '-h' '+' 'grp-' '-i' }",
			),
			Test("tst -a\t", "line: {tst -a}{}\nDESCRIPTION:{option}\nNO:{-h}\nNO:{-t}"),
		],
	},
	Case {
		name:  "with message and bashautolist, a third tab will get menu completion",
		steps: &[
			Eval("_tst () { _arguments '--abc' '--aah' ':arg:' }"),
			Eval("setopt bashautolist automenu"),
			Test(
				"tst --a\t\t\t",
				"line: {tst --a}{}\nline: {tst \
				 --a}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{--aah}\nNO:{--abc}\nline: {tst \
				 --aah}{}",
			),
		],
	},
	Case {
		name:  "with message and bashautolist, a third tab is needed to display the list",
		steps: &[
			Eval("_tst () { _arguments '--abc' '--aah' ':arg:' }"),
			Eval("setopt bashautolist noautomenu"),
			Test(
				"tst --a\t\t\t",
				"line: {tst --a}{}\nline: {tst \
				 --a}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{--aah}\nNO:{--abc}\nline: {tst \
				 --a}{}",
			),
		],
	},
	Case {
		name:  "with message and noautomenu second tab redisplays the list",
		steps: &[
			Eval("_tst () { _arguments '--abc' '--aah' ':arg:' }"),
			Eval("setopt nobashautolist noautomenu"),
			Test(
				"tst --\t\t",
				"line: {tst \
				 --}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{--aah}\nNO:{--abc}\nline: {tst \
				 --}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{--aah}\nNO:{--abc}",
			),
		],
	},
	Case {
		name:  "with message two tabs will start menu completion",
		steps: &[
			Eval("_tst () { _arguments '--abc' '--aah' ':arg:' }"),
			Eval("setopt nobashautolist automenu"),
			Test(
				"tst --\t\t",
				"line: {tst \
				 --}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{--aah}\nNO:{--abc}\nline: {tst \
				 --aah}{}",
			),
		],
	},
	Case {
		name:  "with message and _oldlist, two tabs will start menu completion",
		steps: &[
			Eval("_tst () { _arguments '--abc' '--aah' ':arg:' }"),
			Eval("zstyle \":completion:*::::\" completer _oldlist _complete"),
			Test(
				"tst --\t\t",
				"line: {tst \
				 --}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{--aah}\nNO:{--abc}\nline: {tst \
				 --aah}{}",
			),
		],
	},
	Case {
		name:  "partial completion of option with an argument",
		steps: &[
			Eval("_tst () { _arguments '--prefix=: :(one two)' '--prop=: :(three four)' '--pre' }"),
			Test(
				"tst --pre=o\t --=\t",
				"line: {tst --prefix=one }{}\nline: {tst --prefix=one --prop=}{}",
			),
		],
	},
	Case {
		name:  "with -W options mixed with arguments",
		steps: &[
			Eval("_tst () { _arguments '-s' '-W' '-a+:arg' '-b' }"),
			Test("tst -a\t", "line: {tst -a}{}\nDESCRIPTION:{arg}\nDESCRIPTION:{option}\nNO:{-b}"),
		],
	},
];

const SUITE: Suite = Suite { file: "Y03arguments.ztst", lang: "C", prep: PREP, cases: CASES };

/// one non-option argument
#[test]
fn c001_one_non_option_argument() {
	run_case(&SUITE, 0);
}

/// a and b
#[test]
fn c002_a_and_b() {
	run_case(&SUITE, 1);
}

/// a and b with descriptions
#[test]
fn c003_a_and_b_with_descriptions() {
	run_case(&SUITE, 2);
}

/// three arguments
#[test]
fn c004_three_arguments() {
	run_case(&SUITE, 3);
}

/// first argument
#[test]
fn c005_first_argument() {
	run_case(&SUITE, 4);
}

/// second argument but no first argument
#[test]
fn c006_second_argument_but_no_first_argument() {
	run_case(&SUITE, 5);
}

/// second and rest arguments but no first argument
#[test]
fn c007_second_and_rest_arguments_but_no_first_argument() {
	run_case(&SUITE, 6);
}

/// -+
#[test]
fn c008_case() {
	run_case(&SUITE, 7);
}

/// option beginning with + and -.
#[test]
fn c009_option_beginning_with_and() {
	run_case(&SUITE, 8);
}

/// option beginning with + and -, specified the other way around
#[test]
fn c010_option_beginning_with_and_specified_the_other_way_around() {
	run_case(&SUITE, 9);
}

/// mix of + and - and exclusion of stacked options
#[test]
fn c011_mix_of_and_and_exclusion_of_stacked_options() {
	run_case(&SUITE, 10);
}

/// mix of + and - and exclusion of stacked options
#[test]
fn c012_mix_of_and_and_exclusion_of_stacked_options() {
	run_case(&SUITE, 11);
}

/// two option arguments
#[test]
fn c013_two_option_arguments() {
	run_case(&SUITE, 12);
}

/// option argument to ignored option
#[test]
fn c014_option_argument_to_ignored_option() {
	run_case(&SUITE, 13);
}

/// ignored option not completed
#[test]
fn c015_ignored_option_not_completed() {
	run_case(&SUITE, 14);
}

/// ignored option is not taken to be the normal argument
#[test]
fn c016_ignored_option_is_not_taken_to_be_the_normal_argument() {
	run_case(&SUITE, 15);
}

/// unrecognised option has no effect on proceedings with no normal arguments
#[test]
fn c017_unrecognised_option_has_no_effect_on_proceedings_with_no_nor() {
	run_case(&SUITE, 16);
}

/// unrecognised option is taken to be the normal argument
#[test]
fn c018_unrecognised_option_is_taken_to_be_the_normal_argument() {
	run_case(&SUITE, 17);
}

/// option argument follows in next argument
#[test]
fn c019_option_argument_follows_in_next_argument() {
	run_case(&SUITE, 18);
}

/// option argument either direct or in following argument
#[test]
fn c020_option_argument_either_direct_or_in_following_argument() {
	run_case(&SUITE, 19);
}

/// option argument follows directly
#[test]
fn c021_option_argument_follows_directly() {
	run_case(&SUITE, 20);
}

/// option argument follows optional equals
#[test]
fn c022_option_argument_follows_optional_equals() {
	run_case(&SUITE, 21);
}

/// option argument follows optional equals, with -s
#[test]
fn c023_option_argument_follows_optional_equals_with_s() {
	run_case(&SUITE, 22);
}

/// option argument follows mandatory equals
#[test]
fn c024_option_argument_follows_mandatory_equals() {
	run_case(&SUITE, 23);
}

/// sticky option argument
#[test]
fn c025_sticky_option_argument() {
	run_case(&SUITE, 24);
}

/// option argument with prefix that passes option prefix-needed test
#[test]
fn c026_option_argument_with_prefix_that_passes_option_prefix_needed() {
	run_case(&SUITE, 25);
}

/// end of option sequence
#[test]
fn c027_end_of_option_sequence() {
	run_case(&SUITE, 26);
}

/// argument beginning with minus
#[test]
fn c028_argument_beginning_with_minus() {
	run_case(&SUITE, 27);
}

/// argument beginning with minus, guard on rest argument
#[test]
fn c029_argument_beginning_with_minus_guard_on_rest_argument() {
	run_case(&SUITE, 28);
}

/// optional option argument
#[test]
fn c030_optional_option_argument() {
	run_case(&SUITE, 29);
}

/// variable length option arguments
#[test]
fn c031_variable_length_option_arguments() {
	run_case(&SUITE, 30);
}

/// opt_args
#[test]
fn c032_opt_args() {
	run_case(&SUITE, 31);
}

/// opt_args with multiple arguments and quoting of colons and backslashes, part
/// #1: default behaviour
#[test]
fn c033_opt_args_with_multiple_arguments_and_quoting_of_colons_and_b() {
	run_case(&SUITE, 32);
}

/// opt_args with multiple arguments and quoting of colons and backslashes, part
/// #2: NUL escaping
#[test]
fn c034_opt_args_with_multiple_arguments_and_quoting_of_colons_and_b() {
	run_case(&SUITE, 33);
}

/// option completion with rest arguments on the line but not in the specs
#[test]
fn c035_option_completion_with_rest_arguments_on_the_line_but_not_in() {
	run_case(&SUITE, 34);
}

/// optarg completion following rest operand on line (workers/42141)
#[test]
fn c036_optarg_completion_following_rest_operand_on_line_workers_421() {
	run_case(&SUITE, 35);
}

/// rest arguments
#[test]
fn c037_rest_arguments() {
	run_case(&SUITE, 36);
}

/// rest arguments with single colon
#[test]
fn c038_rest_arguments_with_single_colon() {
	run_case(&SUITE, 37);
}

/// rest arguments with two colons
#[test]
fn c039_rest_arguments_with_two_colons() {
	run_case(&SUITE, 38);
}

/// rest arguments with three colons
#[test]
fn c040_rest_arguments_with_three_colons() {
	run_case(&SUITE, 39);
}

/// rest arguments with three colons following optional argument
#[test]
fn c041_rest_arguments_with_three_colons_following_optional_argument() {
	run_case(&SUITE, 40);
}

/// rest arguments with three colons following optional argument to an option
#[test]
fn c042_rest_arguments_with_three_colons_following_optional_argument() {
	run_case(&SUITE, 41);
}

/// words array in rest arguments
#[test]
fn c043_words_array_in_rest_arguments() {
	run_case(&SUITE, 42);
}

/// opt_args
#[test]
fn c044_opt_args() {
	run_case(&SUITE, 43);
}

/// options and words (zsh-workers:12257)
#[test]
fn c045_options_and_words_zsh_workers_12257() {
	run_case(&SUITE, 44);
}

/// matcher applies to options but not rest arguments
#[test]
fn c046_matcher_applies_to_options_but_not_rest_arguments() {
	run_case(&SUITE, 45);
}

/// matcher in combination with sets (implies separate cadef structure)
#[test]
fn c047_matcher_in_combination_with_sets_implies_separate_cadef_stru() {
	run_case(&SUITE, 46);
}

/// option after --
#[test]
fn c048_option_after() {
	run_case(&SUITE, 47);
}

/// disallowed option after --
#[test]
fn c049_disallowed_option_after() {
	run_case(&SUITE, 48);
}

/// allowed option before --
#[test]
fn c050_allowed_option_before() {
	run_case(&SUITE, 49);
}

/// only first of duplicate -- is ignored
#[test]
fn c051_only_first_of_duplicate_is_ignored() {
	run_case(&SUITE, 50);
}

/// option after a word
#[test]
fn c052_option_after_a_word() {
	run_case(&SUITE, 51);
}

/// long option after word that doesn't match -A pattern
#[test]
fn c053_long_option_after_word_that_doesn_t_match_a_pattern() {
	run_case(&SUITE, 52);
}

/// option after word that doesn't match -A pattern, no space before pattern
#[test]
fn c054_option_after_word_that_doesn_t_match_a_pattern_no_space_befo() {
	run_case(&SUITE, 53);
}

/// option before a word that doesn't match -A pattern, separate -A from pattern
#[test]
fn c055_option_before_a_word_that_doesn_t_match_a_pattern_separate_a() {
	run_case(&SUITE, 54);
}

/// continue completion after rest argument that looks like an option
#[test]
fn c056_continue_completion_after_rest_argument_that_looks_like_an_o() {
	run_case(&SUITE, 55);
}

/// word matching -A pattern doesn't exclude options
#[test]
fn c057_word_matching_a_pattern_doesn_t_exclude_options() {
	run_case(&SUITE, 56);
}

/// unrecognised word matching -A pattern not treated as a rest argument
#[test]
fn c058_unrecognised_word_matching_a_pattern_not_treated_as_a_rest_a() {
	run_case(&SUITE, 57);
}

/// exclusion from option following word matching -A pattern should not apply
#[test]
fn c059_exclusion_from_option_following_word_matching_a_pattern_shou() {
	run_case(&SUITE, 58);
}

/// repeatable options
#[test]
fn c060_repeatable_options() {
	run_case(&SUITE, 59);
}

/// rest arguments from another set not completed after option from first set
#[test]
fn c061_rest_arguments_from_another_set_not_completed_after_option_f() {
	run_case(&SUITE, 60);
}

/// continue completion after rest argument that looks like an option (with
/// sets)
#[test]
fn c062_continue_completion_after_rest_argument_that_looks_like_an_o() {
	run_case(&SUITE, 61);
}

/// foreign option disables whole set (without -A)
#[test]
fn c063_foreign_option_disables_whole_set_without_a() {
	run_case(&SUITE, 62);
}

/// foreign option disables whole set (with -A)
#[test]
fn c064_foreign_option_disables_whole_set_with_a() {
	run_case(&SUITE, 63);
}

/// exclude option common to two sets and from one common option
#[test]
fn c065_exclude_option_common_to_two_sets_and_from_one_common_option() {
	run_case(&SUITE, 64);
}

/// rest argument rule in two sets
#[test]
fn c066_rest_argument_rule_in_two_sets() {
	run_case(&SUITE, 65);
}

/// exclude various forms of rest argument in set specific form
#[test]
fn c067_exclude_various_forms_of_rest_argument_in_set_specific_form() {
	run_case(&SUITE, 66);
}

/// exclusion lists
#[test]
fn c068_exclusion_lists() {
	run_case(&SUITE, 67);
}

/// exclude option from normal argument to the right of the cursor
#[test]
fn c069_exclude_option_from_normal_argument_to_the_right_of_the_curs() {
	run_case(&SUITE, 68);
}

/// exclude own set from an option
#[test]
fn c070_exclude_own_set_from_an_option() {
	run_case(&SUITE, 69);
}

/// exclude later set from an option common to both
#[test]
fn c071_exclude_later_set_from_an_option_common_to_both() {
	run_case(&SUITE, 70);
}

/// exclude earlier set from an option common to both
#[test]
fn c072_exclude_earlier_set_from_an_option_common_to_both() {
	run_case(&SUITE, 71);
}

/// single option sets are still mutually exclusive
#[test]
fn c073_single_option_sets_are_still_mutually_exclusive() {
	run_case(&SUITE, 72);
}

/// excluding a set doesn't exclude common options as part of the set
#[test]
fn c074_excluding_a_set_doesn_t_exclude_common_options_as_part_of_th() {
	run_case(&SUITE, 73);
}

/// exclude all other options
#[test]
fn c075_exclude_all_other_options() {
	run_case(&SUITE, 74);
}

/// exclude all options from a normal argument
#[test]
fn c076_exclude_all_options_from_a_normal_argument() {
	run_case(&SUITE, 75);
}

/// exclusion only applies to later words
#[test]
fn c077_exclusion_only_applies_to_later_words() {
	run_case(&SUITE, 76);
}

/// exclusion with clumped options, in, after and before
#[test]
fn c078_exclusion_with_clumped_options_in_after_and_before() {
	run_case(&SUITE, 77);
}

/// don't prematurely exclude option that current word is a prefix of
#[test]
fn c079_don_t_prematurely_exclude_option_that_current_word_is_a_pref() {
	run_case(&SUITE, 78);
}

/// don't prematurely exclude option that current word is a prefix of (with
/// sets)
#[test]
fn c080_don_t_prematurely_exclude_option_that_current_word_is_a_pref() {
	run_case(&SUITE, 79);
}

/// option clumping mixed with real option that looks like clump
#[test]
fn c081_option_clumping_mixed_with_real_option_that_looks_like_clump() {
	run_case(&SUITE, 80);
}

/// option clumping mixed with direct argument
#[test]
fn c082_option_clumping_mixed_with_direct_argument() {
	run_case(&SUITE, 81);
}

/// exclusion with option argument that looks like an option
#[test]
fn c083_exclusion_with_option_argument_that_looks_like_an_option() {
	run_case(&SUITE, 82);
}

/// exclude group options
#[test]
fn c084_exclude_group_options() {
	run_case(&SUITE, 83);
}

/// single option groups are not mutually exclusive
#[test]
fn c085_single_option_groups_are_not_mutually_exclusive() {
	run_case(&SUITE, 84);
}

/// exclude rest args listed within a group
#[test]
fn c086_exclude_rest_args_listed_within_a_group() {
	run_case(&SUITE, 85);
}

/// two forms of same option in different groups
#[test]
fn c087_two_forms_of_same_option_in_different_groups() {
	run_case(&SUITE, 86);
}

/// normal argument excludes options in internally mutually exclusive group
#[test]
fn c088_normal_argument_excludes_options_in_internally_mutually_excl() {
	run_case(&SUITE, 87);
}

/// mix sets, groups and option stacking
#[test]
fn c089_mix_sets_groups_and_option_stacking() {
	run_case(&SUITE, 88);
}

/// sets and groups with - in their name
#[test]
fn c090_sets_and_groups_with_in_their_name() {
	run_case(&SUITE, 89);
}

/// with message and bashautolist, a third tab will get menu completion
#[test]
fn c091_with_message_and_bashautolist_a_third_tab_will_get_menu_comp() {
	run_case(&SUITE, 90);
}

/// with message and bashautolist, a third tab is needed to display the list
#[test]
fn c092_with_message_and_bashautolist_a_third_tab_is_needed_to_displ() {
	run_case(&SUITE, 91);
}

/// with message and noautomenu second tab redisplays the list
#[test]
fn c093_with_message_and_noautomenu_second_tab_redisplays_the_list() {
	run_case(&SUITE, 92);
}

/// with message two tabs will start menu completion
#[test]
fn c094_with_message_two_tabs_will_start_menu_completion() {
	run_case(&SUITE, 93);
}

/// with message and _oldlist, two tabs will start menu completion
#[test]
fn c095_with_message_and_oldlist_two_tabs_will_start_menu_completion() {
	run_case(&SUITE, 94);
}

/// partial completion of option with an argument
#[test]
fn c096_partial_completion_of_option_with_an_argument() {
	run_case(&SUITE, 95);
}

/// with -W options mixed with arguments
#[test]
fn c097_with_w_options_mixed_with_arguments() {
	run_case(&SUITE, 96);
}
