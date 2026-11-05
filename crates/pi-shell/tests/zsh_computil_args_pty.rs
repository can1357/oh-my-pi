//! zsh/computil's `comparguments` and `compvalues`, and `_arguments` end to
//! end, in `obash` invoked as `zsh -f -i` against the real `/bin/zsh -f -i`
//! on the same pty session (same keys, same rc file).
//!
//! The builtin cases bind a completion widget (`zle -C`) that runs a
//! `case_NAME` function chosen by the command word (`NAME`); it calls the
//! builtin and stores its status and the parameters it set, which `p`
//! prints after the line is killed. Each step's screen must match.
//!
//! The `_arguments` cases are `Test/Y03arguments.ztst` of zsh 5.9: its
//! `comptest` setup (minus `zsh/complist` and `list-colors`), the same
//! `_tst` definitions and the same keys, each case in a session of its own
//! group of cases. The screen just before each `clear-screen` (the report
//! widgets clear after each completion, as `comptest` does) and at the end
//! of each case must match. The system completions (`ls`, `tar`, `git`)
//! run the same way.

#![cfg(unix)]

mod pty_support;

use std::{io, ops::Range, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, have_real_zsh, vt::Screen};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(30);
/// How long output must stay quiet before the screen is read.
const QUIET: Duration = Duration::from_millis(300);
/// The bound of waits that run `compinit` or completion functions.
const SLOW: Duration = Duration::from_secs(120);

/// `zsh -f -i` with a short prompt and the rc file `rc`, `rows` × `cols`.
fn spawn(real: bool, rc: &str, rows: u16, cols: u16) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	let s = s
		.args(["-f", "-i"])
		.env("PS1", "%# ")
		.rc_file(".zshrc", rc)
		.size(rows, cols);
	let home = s.home().to_owned();
	s.cwd(home)
}

/// Source the rc file (`-f` skips it) and wait until it ran.
fn start(pty: &mut Pty) -> io::Result<()> {
	pty.settle(QUIET, SLOW)?;
	pty.type_keys(". ~/.zshrc; print -r READY$((6*7))\r", KEY)?;
	pty.read_until("READY42", SLOW)?;
	pty.settle(QUIET, TIMEOUT)
}

/// Run `run` on obash and, when installed, on the real zsh; the outputs
/// (`None` for zsh when it is not installed).
fn both<T>(run: impl Fn(bool) -> io::Result<T>) -> (T, Option<T>) {
	let ours = run(false).unwrap_or_else(|e| panic!("obash pty session failed: {e}"));
	if !have_real_zsh() {
		return (ours, None);
	}
	let real = run(true).unwrap_or_else(|e| panic!("zsh pty session failed: {e}"));
	(ours, Some(real))
}

/// Panic listing the steps whose screens differ.
fn compare(labels: &[String], ours: &[Vec<String>], real: Option<&[Vec<String>]>) {
	let Some(real) = real else { return };
	let mut bad = Vec::new();
	for (i, label) in labels.iter().enumerate() {
		let (o, r) = (&ours[i], &real[i]);
		if o == r {
			continue;
		}
		let k = o
			.iter()
			.zip(r)
			.position(|(a, b)| a != b)
			.unwrap_or(o.len().min(r.len()));
		bad.push(format!(
			"=== {label}: screen {k} of {}/{} differs\n--- obash:\n{}\n--- zsh:\n{}",
			o.len(),
			r.len(),
			o.get(k).map_or("<none>", String::as_str),
			r.get(k).map_or("<none>", String::as_str),
		));
	}
	assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), labels.len(), bad.join("\n"));
}

// ---- the builtins
// ------------------------------------------------------------------

/// The rc file of the builtin cases.
const UNIT_RC: &str = r#"bindkey -e
export LC_COLLATE=C
setopt completeinword
zmodload zsh/computil
typeset -ga out rets
r() { rets+=("$1=$?") }
v() {
  local _n _k
  local -A _h
  for _n; do
    if [[ ${(tP)_n} == association* ]]; then
      _h=("${(@kvP)_n}")
      for _k in ${(ko)_h}; do out+=("${_n}[$_k]=${(qq)${(V)_h[$_k]}}"); done
    else
      out+=("$_n=(${(j:,:)${(@qq)${(@V)${(P@)_n}}}})")
    fi
  done
}
t() { out=() rets=(); { case_$words[1] } 2>>~/err }
zle -C t complete-word t
bindkey '^X^T' t
p() {
  print -r -- "$rets"
  print -rl -- $out
  [[ -s ~/err ]] && { cat ~/err; : >| ~/err }
  print -r -- "@@$1@@"
}
all() {
  comparguments -D A_d A_a A_s; r D; v A_d A_a A_s PREFIX IPREFIX words CURRENT
  comparguments -O O_n O_d O_o O_e; r O; v O_n O_d O_o O_e
  comparguments -s S_s; r s; v S_s
  comparguments -M M_m; r M; v M_m
  comparguments -a; r a
  comparguments -W W_l W_o 1; r W; v W_l W_o
  comparguments -W W_l W_c 0; v W_c
  comparguments -n N_n; r n; v N_n
}
case_e1() {
  comparguments -D a b c; r D
  comparguments -O a b c d; r O
  compvalues -D a b; r vD
  comparguments; r none
  comparguments -x; r x
  comparguments -Dx; r Dx
  comparguments x; r plain
  comparguments -I a b; r I
  comparguments -i; r i0
  comparguments -i a; r i1
  comparguments -i '' -s; r i2
  comparguments -i '' ':'; r i3
  comparguments -i '' '- ()' '-a'; r i4
  comparguments -i '' - '' '-a'; r i5
  comparguments -i '' + '()' '-a'; r i6
  comparguments -i '' '*:a:b' '*:c:d'; r i7
  comparguments -i '' ':a:b' '1:c:d'; r i8
  comparguments -i '' '-a[x'; r i9
  comparguments -i '' '-ax:b' '-c'; r i10
  comparguments -i '' '(-a' ; r i11
  comparguments -i '' '*x'; r i12
  comparguments -i '' 'x'; r i13
  comparguments -i '' '-'; r i14
  comparguments -i '' '--'; r i15
  comparguments -i '' '-a:*x'; r i16
  comparguments -i '' '-a:b:c' '-M'; r i17
  comparguments -i '' -M; r i18
  comparguments -i '' '-a[x]y'; r i19
  comparguments -i '' '-a'; r ok
  comparguments -D a b; r D2
  comparguments -D a b c d; r D3
  comparguments -L a b; r L2
  comparguments -a x; r a1
  comparguments -O a b c d e; r O5
}
case_e2() {
  compvalues -i; r vi0
  compvalues -i a; r vi1
  compvalues -i -s , a; r vi2
  compvalues -i -s '' a 'ab'; r vi3
  compvalues -i -s '' a 'a:b'; r vi4
  compvalues -i a 'b[x'; r vi5
  compvalues -i a 'bx]'; r vi6
  compvalues -i a '(b'; r vi7
  compvalues -i a 'b'; r vi8
  compvalues -i a 'b]c'; r vi9
  compvalues -x; r vx
  compvalues -L a; r vL
  compvalues -L a b c d e; r vL5
  compvalues; r none
  compvalues -Dx; r Dx
}
case_c1() {
  comparguments -i '%d' -s '-a[all]' '-b+:barg:(x y)' '-c:carg:(p q)' '-d=:darg:' '*:file:_files'; r i
  all
}
case_c2() {
  comparguments -i 'auto %d end' '--foo=-:fooarg:(f1 f2)' '--bar=:bararg:(b1)' '--baz+:bazarg' '--qux-:quxarg' \
    '--two:first: :second:' '--opt::optarg:(o1)' '*--many:m:' '-v[verbose]' ':first arg:(a1 a2)' '::second arg:(s1)' '3:third:(t)'; r i
  all
}
case_c3() {
  comparguments -i '' '-c[common]' + grp '-g[g opt]' '(-x)-h[h opt]' - set1 '-a[set a]' ':s1arg:(x)' - '(set2)' '-b[set b]' '*:rest:(r)'; r i
  all
}
case_c4() {
  comparguments -i '' '(-b)-a[a]' '(-a)-b[b]' '(: * -)-h[help]' '(1)-n[no first]' '(*)-r' '!-q' '!(-z)-y' '1:one:(o)' '2:two:(t)' '*:rest:(r)'; r i
  all
}
case_c5() {
  comparguments -i '' '-a' '1:cmd:(x y)' '*::args:_normal'; r i
  all
}
case_c6() {
  comparguments -i '' '-a' '1:cmd:(x y)' '*:::args:_normal'; r i
  all
}
case_c7() {
  comparguments -i '' '-e+:*\;:cmd:_command' '-x:*:all:' '-y' ':arg:'; r i
  all
}
case_c8() {
  comparguments -i '' -S -A '-*' '-a' '-b:barg:' ':first:' '*:rest:'; r i
  all
}
case_c9() {
  comparguments -i '' -M 'm:{a-z}={A-Z}' '-+o[pm]' '+-p[mp]:parg:' '*-m[multi]' '-x+[desc]:xarg:(1 2)' '-y=-[eq]:yarg:' '--prefix=:dir:_files -/'; r i
  all
  comparguments -L --prefix L_d L_a L_s; r L; v L_d L_a L_s
  comparguments -L -x L_d L_a L_s; r L2; v L_d L_a L_s
  comparguments -L --nope L_d L_a L_s; r L3
}
case_c10() {
  comparguments -i '' '(set1-: set2-* set3-1)-a' - set1 '1: :(1)' '2: :(2)' - set2 '*:rest:(rest)' - set3 '1:num:(num)' '*: :(allowable)' - set4 ': :(allowed)'; r i
  all
}
case_c11() {
  comparguments -i '' -s '(-d)-a+:arg:(b)' '(-c)-b' -c -d '-e=-:earg:' '-f-:farg:'; r i
  all
}
case_v1() {
  compvalues -i -s , 'the desc' 'a[aa]' 'b[bb]:barg:(1 2)' '*c[cc]::carg:_files' '(a)d[dd]' 'e'; r i
  vall
}
case_v2() {
  compvalues -i -s '' 'nosep' a b c '(a)d'; r i
  vall
}
case_v3() {
  compvalues -i -S : -w 'words' 'x:xarg:(1)' 'y' 'z::zarg:'; r i
  vall
}
case_v4() {
  compvalues -i 'quoted' 'x\:y[xy]:arg:' 'p' "q'r" 'b:barg:'; r i
  vall
}
case_v5() {
  compvalues -i -s , -S '' 'noargsep' 'ab' 'abc:x:' 'b'; r i
  vall
}
vall() {
  compvalues -D V_d V_a; r D; v V_d V_a PREFIX IPREFIX SUFFIX ISUFFIX
  compvalues -C V_c; r C; v V_c
  compvalues -V V_n V_r V_o; r V; v V_n V_r V_o
  compvalues -s V_s; r s; v V_s
  compvalues -S V_S; r S; v V_S
  compvalues -d V_D; r d; v V_D
  compvalues -L b V_ld V_la V_ln; r L; v V_ld V_la V_ln
  compvalues -v V_v; r v; v V_v
}
"#;

/// Type each command line, run the `case_` widget on it, print what it
/// stored; the screen after each.
fn unit(lines: &[&str]) {
	let run = |real: bool| -> io::Result<Vec<Vec<String>>> {
		let mut pty = spawn(real, UNIT_RC, 60, 120).spawn()?;
		start(&mut pty)?;
		let mut shots = Vec::new();
		for (i, line) in lines.iter().enumerate() {
			pty.type_keys(format!("\x0c{line}\x18\x14\x15p {i}\r"), KEY)?;
			pty.read_until(format!("@@{i}@@"), SLOW)?;
			pty.settle(QUIET, TIMEOUT)?;
			shots.push(vec![pty.screen().contents()]);
		}
		Ok(shots)
	};
	let (ours, real) = both(run);
	let labels: Vec<String> = lines.iter().map(|l| format!("{l:?}")).collect();
	compare(&labels, &ours, real.as_deref());
}

#[test]
fn comparguments_and_compvalues_errors() {
	// `e1` first: the "no parsed state" cases need a fresh shell.
	unit(&["e1 ", "e2 "]);
}

#[test]
fn comparguments_single_letter_options() {
	unit(&[
		"c1 -a -c p fo",
		"c1 -ab",
		"c1 -ac",
		"c1 -ca ",
		"c1 -b",
		"c1 -",
		"c1 x -",
		"c1 -d=",
		"c1 -dx",
		"c1 -a -a",
		"c11 -ab",
		"c11 -a",
		"c11 -e=",
		"c11 -fz",
		"c11 -db",
		"c11 -c -",
	]);
}

#[test]
fn comparguments_long_option_forms() {
	unit(&[
		"c2 --foo=x",
		"c2 --foo",
		"c2 --bar ",
		"c2 --bar=",
		"c2 --baz",
		"c2 --bazq",
		"c2 --quxv",
		"c2 --two a ",
		"c2 --two a b ",
		"c2 --opt ",
		"c2 a1 ",
		"c2 a1 s1 ",
		"c2 -v --many m --many ",
		"c2 --",
		"c9 -o",
		"c9 +o -p ",
		"c9 -m -m -",
		"c9 -x1 ",
		"c9 -y=",
		"c9 --pre=/u",
		"c9 --prefix=/u",
		"c9 -px",
	]);
}

#[test]
fn comparguments_sets_groups_exclusions() {
	unit(&[
		"c3 -a ",
		"c3 -b ",
		"c3 -h -",
		"c3 x ",
		"c3 -",
		"c3 -g -",
		"c3 -a -b ",
		"c4 -a -",
		"c4 -h ",
		"c4 -n ",
		"c4 -r o t ",
		"c4 o ",
		"c4 -y -",
		"c10 -a ",
		"c10 -a x ",
	]);
}

#[test]
fn comparguments_rest_arguments_and_patterns() {
	unit(&[
		"c5 x foo -a b",
		"c5 -a x foo ",
		"c5 ",
		"c6 x foo bar",
		"c6 -a x ",
		"c7 -e ls -l \\; ",
		"c7 -e ls ",
		"c7 -x a b c",
		"c7 -els ",
		"c8 -z foo -",
		"c8 -- -a ",
		"c8 -a -- ",
		"c8 -b x y ",
		"c8 x -",
	]);
}

#[test]
fn compvalues_sub_options() {
	unit(&[
		"v1 a,b=1,c",
		"v1 a,b=",
		"v1 b=1,",
		"v1 c=foo",
		"v1 a,d",
		"v1 a,b=1,c,e\x02\x02\x02",
		"v1 d,b=2,c=x\x02\x02",
		"v2 ab",
		"v2 abd",
		"v2 x",
		"v2 a\x02",
		"v3 x:1 y z:",
		"v3 y z:a",
		"v3 x:2\x02",
		"v4 x\\:y:a",
		"v4 q\\'r",
		"v4 b=c",
		"v5 abc",
		"v5 abcb,ab",
		"v5 ab,b\x02\x02",
	]);
}

// ---- _arguments
// ------------------------------------------------------------------

/// `comptest`'s setup (`Test/comptest`), without `zsh/complist` and
/// `list-colors`.
const Y03_RC: &str = r#"emulate -R zsh
bindkey -e
LISTMAX=10000000
KEYTIMEOUT=1
autoload -U compinit
compinit -u
zstyle ":completion:*" completer _expand _complete _ignored
zstyle ":completion:*" group-name ""
zstyle ":completion:*:messages" format "<MESSAGE>%d</MESSAGE>
"
zstyle ":completion:*:descriptions" format "<DESCRIPTION>%d</DESCRIPTION>
"
zstyle ":completion:*:options" verbose yes
zstyle ":completion:*:values" verbose yes
setopt noalwayslastprompt listrowsfirst completeinword
comptest-ready () {
  print -rn -- $'\e]0;comptest-ready\a'
}
complete-word-with-report () {
  print -lr "<WIDGET><complete-word>"
  zle complete-word
  print -lr - "<LBUFFER>$LBUFFER</LBUFFER>" "<RBUFFER>$RBUFFER</RBUFFER>"
  zle clear-screen
  zle -R
  comptest-ready
}
list-choices-with-report () {
  print -lr "<WIDGET><list-choices>"
  zle list-choices
  zle clear-screen
  zle -R
  comptest-ready
}
comp-finish () {
  print "<WIDGET><finish>"
  zle kill-whole-line
  zle clear-screen
  zle -R
  comptest-ready
}
zle -N zle-line-init comptest-ready
zle -N complete-word-with-report
zle -N list-choices-with-report
zle -N comp-finish
bindkey "^I" complete-word-with-report
bindkey "^D" list-choices-with-report
bindkey "^Z" comp-finish
compdef _tst tst
"#;

/// One `Y03arguments.ztst` case.
struct Case {
	/// Its description.
	name:   &'static str,
	/// The `_tst` definition and the other `comptesteval` code.
	setup:  &'static [&'static str],
	/// The `comptest` inputs.
	inputs: &'static [&'static str],
}

/// The bound of each completion sequence.
const FINISH: Duration = Duration::from_secs(60);

/// An OSC title update acknowledges a completed redraw without changing
/// the screen. Emitted by `comptest-ready` above, including at line init.
const WIDGET_READY: &str = "\x1b]0;comptest-ready\x07";

/// The screens just before each clear-screen after the `@@MARK@@` line
/// in `out`, and the screen at the end.
fn case_screens(out: &str, rows: u16, cols: u16, mark: &str) -> Vec<String> {
	let b = out.as_bytes();
	let find = |pat: &[u8], from: usize| {
		b[from.min(b.len())..]
			.windows(pat.len())
			.position(|w| w == pat)
			.map(|k| from + k)
	};
	let start = find(mark.as_bytes(), 0).unwrap_or(b.len());
	let mut screen = Screen::new(rows, cols);
	let mut fed = 0;
	let mut shots = Vec::new();
	let mut at = start;
	while let Some(c) = find(b"\x1b[2J", at) {
		screen.feed(&b[fed..c]);
		fed = c;
		shots.push(screen.contents());
		at = c + 1;
	}
	screen.feed(&b[fed..]);
	shots.push(screen.contents());
	shots
}

/// Run `cases` of `table`, each in a session of its own: the option and
/// style changes of the cases before it (they persist in `comptest`'s
/// session), its setup, then each input followed by `comp-finish`.
fn completion_cases(table: &[Case], cases: Range<usize>) {
	let mut labels = Vec::new();
	let mut ours = Vec::new();
	let mut real = Vec::new();
	for i in cases {
		let mut rc = String::from(Y03_RC);
		for s in table[..i]
			.iter()
			.flat_map(|c| c.setup)
			.filter(|s| !s.starts_with("_tst "))
		{
			rc.push_str(s);
			rc.push('\n');
		}
		rc.push_str(&format!("y{i}() {{\n{}\nprint -r -- @@{i}@@\n}}\n", table[i].setup.join("\n")));
		let mark = format!("@@{i}@@");
		let run = |real: bool| -> io::Result<Vec<String>> {
			let mut pty = spawn(real, &rc, 24, 80).spawn()?;
			start(&mut pty)?;
			pty.type_keys(format!("y{i}\r"), KEY)?;
			pty.read_until(&mark, SLOW)?;
			pty.read_until(WIDGET_READY, SLOW)?;
			for input in table[i].inputs {
				for key in input.bytes() {
					pty.type_keys([key], KEY)?;
					if matches!(key, b'\t' | b'\x04') {
						// Listing temporarily restores cooked/echoing tty modes.
						// Do not inject the next key until the widget's final
						// redraw has restored editing modes; a delay can race.
						pty.read_until(WIDGET_READY, FINISH)?;
					}
				}
				pty.type_keys([b'\x1a'], KEY)?;
				pty.read_until("<WIDGET><finish>", FINISH)?;
				pty.read_until(WIDGET_READY, FINISH)?;
			}
			pty.settle(QUIET, TIMEOUT)?;
			Ok(case_screens(&pty.output(), 24, 80, &mark))
		};
		labels.push(format!("{} {:?}", table[i].name, table[i].inputs));
		// A session that fails on our side is a difference of its own.
		ours.push(run(false).unwrap_or_else(|e| vec![format!("<obash pty session failed: {e}>")]));
		if have_real_zsh() {
			real.push(run(true).unwrap_or_else(|e| panic!("zsh pty session failed: {e}")));
		}
	}
	compare(&labels, &ours, have_real_zsh().then_some(real.as_slice()));
}

/// `Test/Y03arguments.ztst` (zsh 5.9), in order.
static Y03: &[Case] = &[
	Case {
		name:   "one non-option argument",
		setup:  &["_tst () { _arguments ':desc1:(arg1)' }"],
		inputs: &["tst \t\x17a\t\x17ar\t\x17arg\t\x17arg1\t\x17r\t\x17x\t \ty \t"],
	},
	Case {
		name:   "a and b",
		setup:  &["_tst () { _arguments ':desc1:(a b)' }"],
		inputs: &["tst \t"],
	},
	Case {
		name:   "a and b with descriptions",
		setup:  &["_tst () { _arguments ':desc2:((a\\:a\\ value b\\:other\\\\\\\\value))' }"],
		inputs: &["tst \t"],
	},
	Case {
		name:   "three arguments",
		setup:  &["_tst () { _arguments ':desc1:(arg1)' ':desc2:(arg2)' ':desc3:(arg3)' }"],
		inputs: &["tst \t\t\t\x17\x17\x17\x04"],
	},
	Case {
		name:   "first argument",
		setup:  &["_tst () { _arguments '1:desc1:(arg1)' }"],
		inputs: &["tst \t\t"],
	},
	Case {
		name:   "second argument but no first argument",
		setup:  &["_tst () { _arguments '-a' '2:desc2:(arg2)' }"],
		inputs: &["tst a1\t \t"],
	},
	Case {
		name:   "second and rest arguments but no first argument",
		setup:  &["_tst () { _arguments '2:desc2:(arg2)' '*:rest:(rest)' }"],
		inputs: &["tst \t\t\t"],
	},
	Case { name: "-+", setup: &["_tst () { _arguments '-\\+[opt]' }"], inputs: &["tst -\x04"] },
	Case {
		name:   "option beginning with + and -.",
		setup:  &["_tst () { _arguments '-+o' }"],
		inputs: &["tst -\t\t\t\x17\x17+\t\t\t"],
	},
	Case {
		name:   "option beginning with + and -, specified the other way around",
		setup:  &["_tst () { _arguments '+-o' }"],
		inputs: &["tst \t"],
	},
	Case {
		name:   "mix of + and - and exclusion of stacked options",
		setup:  &["_tst () { _arguments '-s' '-a' '-b' '-c' '!-d' '!-e' '!-f' '!+d' '!+e' '!+f' }"],
		inputs: &["tst -ad\t\x14\t\x08ef\t"],
	},
	Case {
		name:   "mix of + and - and exclusion of stacked options",
		setup:  &["_tst () { _arguments '-s' '-a' '-b' '-c' '+a' '+b' '+c' }"],
		inputs: &["tst -a +b +c\t"],
	},
	Case {
		name:   "two option arguments",
		setup:  &["_tst () { _arguments '-o:1:(a):2:(b)' }"],
		inputs: &["tst \t\t\t"],
	},
	Case {
		name:   "option argument to ignored option",
		setup:  &["_tst () { _arguments '!-x:arg:(ok)' }"],
		inputs: &["tst -x \t"],
	},
	Case {
		name:   "ignored option not completed",
		setup:  &["_tst () { _arguments '!-a' '-b' }"],
		inputs: &["tst -\t"],
	},
	Case {
		name:   "ignored option is not taken to be the normal argument",
		setup:  &["_tst () { _arguments '+x' '+y' '!+z' ':arg:(x)' }"],
		inputs: &["tst +z \t"],
	},
	Case {
		name:   "unrecognised option has no effect on proceedings with no normal arguments",
		setup:  &["_tst () { _arguments '--known' '--other' }"],
		inputs: &["tst --unknown -\t"],
	},
	Case {
		name:   "unrecognised option is taken to be the normal argument",
		setup:  &["_tst () { _arguments '+x' '+y' ':arg:(x)' }"],
		inputs: &["tst +z \t"],
	},
	Case {
		name:   "option argument follows in next argument",
		setup:  &["_tst () { _arguments '*-a:value:(1)' }"],
		inputs: &["tst -a\t\t -a=\t"],
	},
	Case {
		name:   "option argument either direct or in following argument",
		setup:  &["_tst () { _arguments '*-a+:value:(1)' }"],
		inputs: &["tst -a\t -a \t -a=\t"],
	},
	Case {
		name:   "option argument follows directly",
		setup:  &["_tst () { _arguments '*-a-:value:(1)' }"],
		inputs: &["tst -a\t -a \t=\t"],
	},
	Case {
		name:   "option argument follows optional equals",
		setup:  &["_tst () { _arguments '*-a=:value:(1)' }"],
		inputs: &["tst -a\t\t -a \t"],
	},
	Case {
		name:   "option argument follows optional equals, with -s",
		setup:  &["_tst () { _arguments '-s' '*-a=:value:(1)' }"],
		inputs: &["tst -a\t-a=\t -a \t"],
	},
	Case {
		name:   "option argument follows mandatory equals",
		setup:  &["_tst () { _arguments '*-a=-:value:(1)' }"],
		inputs: &["tst -a\t\t-a \t"],
	},
	Case {
		name:   "sticky option argument",
		setup:  &["_tst () { _arguments '-x:arg:' }"],
		inputs: &["tst -x\t"],
	},
	Case {
		name:   "option argument with prefix that passes option prefix-needed test",
		setup:  &["_tst () { _arguments '-x:arg' '-y' '-z' }"],
		inputs: &["tst -x -\t"],
	},
	Case {
		name:   "end of option sequence",
		setup:  &["_tst () { _arguments '-x[desc]' }"],
		inputs: &["tst -x\t"],
	},
	Case {
		name:   "argument beginning with minus",
		setup:  &["_tst () { _arguments '-x' ':arg:' }"],
		inputs: &["tst -\t"],
	},
	Case {
		name:   "argument beginning with minus, guard on rest argument",
		setup:  &["_tst () { _arguments '-x' ': :_guard '\\''[0-9]#'\\'' number' }"],
		inputs: &["tst -\t"],
	},
	Case {
		name:   "optional option argument",
		setup:  &["_tst () { _arguments '-o::optarg:(oa)' ':arg1:(a1)' }"],
		inputs: &["tst -o\t\t"],
	},
	Case {
		name:   "variable length option arguments",
		setup:  &["_tst () { _arguments '-o:*a:a:(a)' ':A:(A)' ':B:(B)' }"],
		inputs: &["tst A -o a \t\x17\x17-a -b -c a \t"],
	},
	Case {
		name:   "opt_args",
		setup:  &["_tst () { _arguments '-s' '-a' '-b' ':descr:{compadd - $+opt_args[-a]}' }"],
		inputs: &["tst -ab \t"],
	},
	Case {
		name:   "opt_args with multiple arguments and quoting of colons and backslashes, part #1: \
		         default behaviour",
		setup:  &["_tst () { _arguments '-a:one: :two' ':descr:{compadd -Q - $opt_args[-a]}' }"],
		inputs: &["tst -a 1:x \\2 \t"],
	},
	Case {
		name:   "opt_args with multiple arguments and quoting of colons and backslashes, part #2: \
		         NUL escaping",
		setup:  &["_tst () { _arguments '-0' ':' '-a:one: :two' ':descr:{compadd -Q - \
		           ${(qqqq)opt_args[-a]}}' }"],
		inputs: &["tst -a 1:x \\2 \t"],
	},
	Case {
		name:   "option completion with rest arguments on the line but not in the specs",
		setup:  &["_tst () { _arguments '-a' '-b' }"],
		inputs: &["tst  rest -\t\x17\x1bb\x02-\t"],
	},
	Case {
		name:   "optarg completion following rest operand on line (workers/42141)",
		setup:  &["_tst () { _arguments '*-x+:optarg:(1)' '*--xxx=:optarg:(1)' '*:operand:(a)' }"],
		inputs: &[
			"tst \t",
			"tst -x \t",
			"tst -x\t",
			"tst --xxx=\t",
			"tst --xxx \t",
			"tst a -x\t",
			"tst a -x \t",
			"tst a --xxx=\t",
			"tst a --xxx \t",
		],
	},
	Case {
		name:   "rest arguments",
		setup:  &["_tst () { _arguments '-a' '*::rest:{compadd - -b}' }"],
		inputs: &["tst arg -\t"],
	},
	Case {
		name:   "rest arguments with single colon",
		setup:  &["_tst () { _arguments '-a' ':more' '*:rest:{ compadd - $words }' }"],
		inputs: &["tst x -a rest \t"],
	},
	Case {
		name:   "rest arguments with two colons",
		setup:  &["_tst () { _arguments '-a' ':more' '*::rest:{ compadd - $words }' }"],
		inputs: &["tst x -a rest \t\x1bb\x1bb\x1bb\x1bt\x05 \t"],
	},
	Case {
		name:   "rest arguments with three colons",
		setup:  &["_tst () { _arguments '-a' '-b' ':more' '*:::rest:{ compadd - $words }' }"],
		inputs: &["tst -b x -a -x rest \t"],
	},
	Case {
		name:   "rest arguments with three colons following optional argument",
		setup:  &["_tst () { _arguments '-a' '::more' '*:::rest:{ compadd - $words }' }"],
		inputs: &["tst -a opt rest \t"],
	},
	Case {
		name:   "rest arguments with three colons following optional argument to an option",
		setup:  &["_tst () { _arguments '-a::arg' '*:::rest:{ compadd - $words }' }"],
		inputs: &["tst -a opt rest \t"],
	},
	Case {
		name:   "words array in rest arguments",
		setup:  &["_tst () { _arguments '-e:*last:::b:{compadd \"${(j:,:)words}\"}' ':arg1:(arg1)' }"],
		inputs: &["tst -\t\tla\t\x08st\t\t\x1bb\x1bb\x02\t\t"],
	},
	Case {
		name:   "opt_args",
		setup:  &["_tst () { _arguments '-s' '-d+:msg1:' '*::msg2:{compadd $CURRENT}' }"],
		inputs: &["tst add \t\t\t"],
	},
	Case {
		name:   "options and words (zsh-workers:12257)",
		setup:  &["_tst () { _arguments '-s' '-a' '-b' '-c' ':words:compadd - abyyy abzzz' }"],
		inputs: &["tst ab\t"],
	},
	Case {
		name:   "matcher applies to options but not rest arguments",
		setup:  &["_tst () { _arguments '-M' 'm:{j}={y}' '-y' '-n' ':yes/no:(y n)' }"],
		inputs: &["tst j\t\x1bb-\x05\t"],
	},
	Case {
		name:   "matcher in combination with sets (implies separate cadef structure)",
		setup:  &["_tst () { _arguments '-M' 'm:{j}={y}' '-y' '-n' '-' 'set1' '-i' '-' 'set2' '-k' }"],
		inputs: &["tst -k -j\t"],
	},
	Case {
		name:   "option after --",
		setup:  &["_tst () { _arguments '-x' ':word' }"],
		inputs: &["tst -- -\t"],
	},
	Case {
		name:   "disallowed option after --",
		setup:  &["_tst () { _arguments '-S' '-x' ':word:()' }"],
		inputs: &["tst -- -\t"],
	},
	Case {
		name:   "allowed option before --",
		setup:  &["_tst () { _arguments '-S' '-x' ':word:()' }"],
		inputs: &["tst - --\x1bB\x02\t"],
	},
	Case {
		name:   "only first of duplicate -- is ignored",
		setup:  &["_tst () { _arguments '-S' '1:one' '2:two' }"],
		inputs: &["tst -- -- \t"],
	},
	Case {
		name:   "option after a word",
		setup:  &["_tst () { _arguments '-x' ':word' }"],
		inputs: &["tst word -\t"],
	},
	Case {
		name:   "long option after word that doesn't match -A pattern",
		setup:  &["_tst () { _arguments '-A' '-*' '-x' '--extra' '::first' }"],
		inputs: &["tst word -\t"],
	},
	Case {
		name:   "option after word that doesn't match -A pattern, no space before pattern",
		setup:  &["_tst () { _arguments '-A-*' '-x' ':word' }"],
		inputs: &["tst word -\t"],
	},
	Case {
		name:   "option before a word that doesn't match -A pattern, separate -A from pattern",
		setup:  &["_tst () { _arguments '-A' '-*' '-x' ':word:(-word)' }"],
		inputs: &["tst  word\x1bB\x02-\t"],
	},
	Case {
		name:   "continue completion after rest argument that looks like an option",
		setup:  &["_tst () { _arguments '-A' '-*' '-h' '-V' '-a' '*: :(-x more)' }"],
		inputs: &["tst -a -x m\t"],
	},
	Case {
		name:   "word matching -A pattern doesn't exclude options",
		setup:  &["_tst () { _arguments '-A' '-*' '-a' '-b' '*: :(words)' }"],
		inputs: &["tst -x -\t"],
	},
	Case {
		name:   "unrecognised word matching -A pattern not treated as a rest argument",
		setup:  &["_tst () { _arguments '-A' '-*' '-a' '-b' '1:word:(word)' }"],
		inputs: &["tst -x \t"],
	},
	Case {
		name:   "exclusion from option following word matching -A pattern should not apply",
		setup:  &[
			"_tst () { _arguments '-A' '-*' '(3)-a' '1:one' '2:two' '3:three' '4:four' '*:extra' }"
		],
		inputs: &["tst x -a \t"],
	},
	Case {
		name:   "repeatable options",
		setup:  &["_tst () { _arguments '*-v' }"],
		inputs: &["tst -v -\t"],
	},
	Case {
		name:   "rest arguments from another set not completed after option from first set",
		setup:  &["_tst () { _arguments '-' 'set1' '--label=:arg:(a b)' '-' 'set2' ':rest:(rest \
		           args --label=not)' }"],
		inputs: &["tst --label=\t"],
	},
	Case {
		name:   "continue completion after rest argument that looks like an option (with sets)",
		setup:  &[
			"_tst () { _arguments '-A' '-*' '-' 'help' '-h' '-V' '-' 'other' '-a' '*: :(-x more)' }"
		],
		inputs: &["tst -a -x m\t"],
	},
	Case {
		name:   "foreign option disables whole set (without -A)",
		setup:  &["_tst () { _arguments '-' '(help)' '-h' '-V' '-' 'other' '-a' '*:rest:(1 2 3)' }"],
		inputs: &["tst -h \t-a \t"],
	},
	Case {
		name:   "foreign option disables whole set (with -A)",
		setup:  &["_tst () { _arguments '-A' '-*' '-' '(help)' '-h' '-V' '-' 'other' '-a' \
		           '*:rest:(1 2 3)' }"],
		inputs: &["tst -h \t-a \t"],
	},
	Case {
		name:   "exclude option common to two sets and from one common option",
		setup:  &["_tst () { _arguments '(-C)-a' '-' 'set1' '-C' '-v' '-' 'set2' '(-a)-C' '-w' }"],
		inputs: &["tst -a -\t \x17\x17-C -\t"],
	},
	Case {
		name:   "rest argument rule in two sets",
		setup:  &["_tst () { _arguments '-e' '-' 'one' '-o' '*:number:(1 2)' '-' 'two' \
		           '(-e)*:letter:(a b)' }"],
		inputs: &["tst \t a -\t"],
	},
	Case {
		name:   "exclude various forms of rest argument in set specific form",
		setup:  &["_tst () { _arguments '(set1-: set2-* set3-1)-a' '-' 'set1' '1: :(1)' '2: :(2)' \
		           '-' 'set2' '*:rest:(rest)' '-' 'set3' '1:num:(num)' '*: :(allowable)' '-' \
		           'set4' ': :(allowed)' }"],
		inputs: &["tst -a \t"],
	},
	Case {
		name:   "exclusion lists",
		setup:  &["_tst () { _arguments '(-v)-a' '(set1--m -a)-b' '-' '(set1)' '( -a )-m' '( )-n' \
		           '-' 'set2' '(-w)*-v' '-w' }"],
		inputs: &["tst -a -\t \x17\x17-b -\t \x17\x17-m -\t \x17\x17-v -\t"],
	},
	Case {
		name:   "exclude option from normal argument to the right of the cursor",
		setup:  &["_tst () { _arguments '-a' '-b' '-c' '(-a)1:one' '(-b)2:two' '(-c)*:extra' }"],
		inputs: &["tst  x y z\x1b6\x02-\t"],
	},
	Case {
		name:   "exclude own set from an option",
		setup:  &["_tst () { _arguments '-a' '-' 'set1' '-d' '-' 'set2' '(set2)-m' '-n' '-o' \
		           ':arg:(x)' '-' 'set2' '-x' }"],
		inputs: &["tst -m \t"],
	},
	Case {
		name:   "exclude later set from an option common to both",
		setup:  &["_tst () { _arguments '-' 'set1' '(set2)-a' '-m' '-n' '-' 'set2' '-a' '-t' '-u' }"],
		inputs: &["tst -a -\t"],
	},
	Case {
		name:   "exclude earlier set from an option common to both",
		setup:  &["_tst () { _arguments '-' 'set2' '-a' '-t' '-u' '-' 'set1' '(set2)-a' '-m' '-n' }"],
		inputs: &["tst -a -\t"],
	},
	Case {
		name:   "single option sets are still mutually exclusive",
		setup:  &["_tst () { _arguments '-x' '-' '(set1)' '-a' '-b' '-' '(set2)' '-m' '-n' }"],
		inputs: &["tst -m -\t"],
	},
	Case {
		name:   "excluding a set doesn't exclude common options as part of the set",
		setup:  &[
			"_tst () { _arguments '(set-c set-g)-a' '(set)-b' '-c' '+' 'grp' '-g' '-' 'set' '-s' }"
		],
		inputs: &["tst -a -b -\t"],
	},
	Case {
		name:   "exclude all other options",
		setup:  &["_tst () { _arguments '(-)-h' '-a' '-b' '-c' '--long' '+p' }"],
		inputs: &["tst -h -\t"],
	},
	Case {
		name:   "exclude all options from a normal argument",
		setup:  &["_tst () { _arguments '--args' '-b' '-c' '+p' '(-)1:normal' }"],
		inputs: &["tst arg -\t"],
	},
	Case {
		name:   "exclusion only applies to later words",
		setup:  &["_tst () { _arguments '-a' '(-a)-b' }"],
		inputs: &["tst - -b\x02\x02\x02\t"],
	},
	Case {
		name:   "exclusion with clumped options, in, after and before",
		setup:  &["_tst () { _arguments '-s' ':' '(-d)-a' '-b' '-c' '-d' }"],
		inputs: &["tst -ab\t\x08 -\t\x1bb\x1bb \x02-\t"],
	},
	Case {
		name:   "don't prematurely exclude option that current word is a prefix of",
		setup:  &["_tst () { _arguments '-s' '(-conf)-c' '-conf' '-f' '(-)--long' '--longer' }"],
		inputs: &["tst -c\t\x08-long\t"],
	},
	Case {
		name:   "don't prematurely exclude option that current word is a prefix of (with sets)",
		setup:  &["_tst () { _arguments '-s' '(set)-c' '-' 'set' '-conf' '-f' }"],
		inputs: &["tst -c\t"],
	},
	Case {
		name:   "option clumping mixed with real option that looks like clump",
		setup:  &["_tst () { _arguments '-s' ':' '-ad' '(-d)-a' '-b' '-ca' '-d' }"],
		inputs: &["tst -ad\t-b\t"],
	},
	Case {
		name:   "option clumping mixed with direct argument",
		setup:  &["_tst () { _arguments '-s' ':' '(-d)-a+:arg:(b)' '(-c)-b' '-c' '-d' }"],
		inputs: &["tst -ab\t-\t"],
	},
	Case {
		name:   "exclusion with option argument that looks like an option",
		setup:  &["_tst () { _arguments '-a:arg' '-b' '(-b)-c' }"],
		inputs: &["tst -a -c -\t"],
	},
	Case {
		name:   "exclude group options",
		setup:  &["_tst () { _arguments '+' 'grp1' '-a' '-b' '-' 'onlyset' '(-a grp3--y grp2 \
		           grp4--)-m' '-n' '+' 'grp2' '-u' '-v' '+' 'grp3' '-x' '-y' '+' 'grp4' '-0' \
		           ':rest' }"],
		inputs: &["tst -m -\t"],
	},
	Case {
		name:   "single option groups are not mutually exclusive",
		setup:  &["_tst () { _arguments '-x' '+' '(grp1)' '-a' '-b' '+' '(grp2)' '-m' '-n' }"],
		inputs: &["tst -m -\t"],
	},
	Case {
		name:   "exclude rest args listed within a group",
		setup:  &["_tst () { _arguments '(grp1 grp2-2)-a' '(grp1-*)-b' '+' 'grp1' ':first' \
		           '*:rest' '+' 'grp2' ':second' }"],
		inputs: &["tst -a \t\x1bb\x17\x05 x y \t"],
	},
	Case {
		name:   "two forms of same option in different groups",
		setup:  &["_tst () { _arguments '(grp--m)-a' '+' 'grp' '-m:value:(a b c)' '+' 'agrp' \
		           '-m:other:(1 2 3)' }"],
		inputs: &["tst -m \t\x17-a -m \t"],
	},
	Case {
		name:   "normal argument excludes options in internally mutually exclusive group",
		setup:  &["_tst () { _arguments '(grp--m)-x' '+' '(grp)' '-a' '-b' '-c' ':val:(1 2 3)' }"],
		inputs: &["tst 1 -\t"],
	},
	Case {
		name:   "mix sets, groups and option stacking",
		setup:  &["_tst () { _arguments '-s' '-a' '-' 'set1' '-c' '-s' '-' 'set2' '-c' '-t' '+' \
		           'grp' '-d' }"],
		inputs: &["tst -s\t -\t"],
	},
	Case {
		name:   "sets and groups with - in their name",
		setup:  &["_tst () { _arguments '-s' '(set-a set--b grp-a grp--b grp-)-a' '-' 'set-a' '-s' \
		           '-' 'set--b' '-t' '+' 'grp-a' '-g' '+' 'grp--b' '-h' '+' 'grp-' '-i' }"],
		inputs: &["tst -a\t"],
	},
	Case {
		name:   "with message and bashautolist, a third tab will get menu completion",
		setup:  &["_tst () { _arguments '--abc' '--aah' ':arg:' }", "setopt bashautolist automenu"],
		inputs: &["tst --a\t\t\t"],
	},
	Case {
		name:   "with message and bashautolist, a third tab is needed to display the list",
		setup:  &["_tst () { _arguments '--abc' '--aah' ':arg:' }", "setopt bashautolist noautomenu"],
		inputs: &["tst --a\t\t\t"],
	},
	Case {
		name:   "with message and noautomenu second tab redisplays the list",
		setup:  &[
			"_tst () { _arguments '--abc' '--aah' ':arg:' }",
			"setopt nobashautolist noautomenu",
		],
		inputs: &["tst --\t\t"],
	},
	Case {
		name:   "with message two tabs will start menu completion",
		setup:  &["_tst () { _arguments '--abc' '--aah' ':arg:' }", "setopt nobashautolist automenu"],
		inputs: &["tst --\t\t"],
	},
	Case {
		name:   "with message and _oldlist, two tabs will start menu completion",
		setup:  &[
			"_tst () { _arguments '--abc' '--aah' ':arg:' }",
			"zstyle \":completion:*::::\" completer _oldlist _complete",
		],
		inputs: &["tst --\t\t"],
	},
	Case {
		name:   "partial completion of option with an argument",
		setup:  &["_tst () { _arguments '--prefix=: :(one two)' '--prop=: :(three four)' '--pre' }"],
		inputs: &["tst --pre=o\t --=\t"],
	},
	Case {
		name:   "with -W options mixed with arguments",
		setup:  &["_tst () { _arguments '-s' '-W' '-a+:arg' '-b' }"],
		inputs: &["tst -a\t"],
	},
];

#[test]
fn y03_arguments_01() {
	completion_cases(Y03, 0..10);
}

#[test]
fn y03_arguments_02() {
	completion_cases(Y03, 10..20);
}

#[test]
fn y03_arguments_03() {
	completion_cases(Y03, 20..30);
}

#[test]
fn y03_arguments_04() {
	completion_cases(Y03, 30..40);
}

#[test]
fn y03_arguments_05() {
	completion_cases(Y03, 40..50);
}

#[test]
fn y03_arguments_06() {
	completion_cases(Y03, 50..60);
}

#[test]
fn y03_arguments_07() {
	completion_cases(Y03, 60..70);
}

#[test]
fn y03_arguments_08() {
	completion_cases(Y03, 70..80);
}

#[test]
fn y03_arguments_09() {
	completion_cases(Y03, 80..90);
}

#[test]
fn y03_arguments_10() {
	// The last cases change options and styles for the ones after them,
	// as in the original session.
	completion_cases(Y03, 90..Y03.len());
}

/// System completion functions built on `_arguments` and `_values`.
static SYSTEM: &[Case] = &[
	Case { name: "ls long options", setup: &[], inputs: &["ls --\t"] },
	Case { name: "ls options", setup: &[], inputs: &["ls -\t"] },
	Case { name: "tar options", setup: &[], inputs: &["tar -\t"] },
	Case { name: "tar bundled options", setup: &[], inputs: &["tar xf\t"] },
	Case { name: "git subcommands", setup: &[], inputs: &["git \t"] },
	Case { name: "git commit options", setup: &[], inputs: &["git commit --\t"] },
	Case { name: "git config values", setup: &[], inputs: &["git -c core.\t"] },
];

#[test]
fn system_completions_ls() {
	completion_cases(SYSTEM, 0..2);
}

#[test]
fn system_completions_tar() {
	completion_cases(SYSTEM, 2..4);
}

#[test]
fn system_completions_git() {
	completion_cases(SYSTEM, 4..SYSTEM.len());
}
