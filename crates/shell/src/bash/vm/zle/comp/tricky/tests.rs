//! `get_comp_string` against zsh 5.9's C semantics. Expected values come
//! from the C code and, where zsh shows them, from `/bin/zsh -f -i` with
//! a `zle -C` widget printing `$words`, `$CURRENT`, `$PREFIX` and
//! `compstate` (e.g. `FOO=ba|r` really is a subscript context with
//! `PREFIX=OO=bar`: zsh's `zlemetacs_qsub` is 0 without the added `x`).

use bstr::BString;

use super::{compstring::parambeg, *};
use crate::bash::{
	syntax::{Features, NO_ALIASES, zsh::tok},
	vm::zle::comp::MetaLine,
};

/// What `get_comp_string` left.
struct Got {
	s:    Option<Vec<u8>>,
	t:    State,
	line: MetaLine,
}

fn opts() -> CompStrOpts {
	CompStrOpts { equals: true, ..CompStrOpts::default() }
}

fn gcs_with(line: &str, cs: usize, compfunc: bool, o: &CompStrOpts) -> Got {
	let mut t = State {
		qipre: Some(BString::default()),
		qisuf: Some(BString::default()),
		..State::default()
	};
	let mut ml = MetaLine { s: Some(line.as_bytes().to_vec()), cs, mark: 0, rh: Vec::new() };
	let lex = LexEnv { feat: Features::ZSH | Features::ZSH_SHORT_LOOPS, aliases: NO_ALIASES };
	let mut param = |n: &[u8]| -> Option<bool> {
		match n {
			b"assoc" => Some(true),
			b"arr" | b"foo" | b"fob" => Some(false),
			_ => None,
		}
	};
	let s = get_comp_string_in(&mut t, &mut ml, compfunc, o, &lex, &mut param);
	Got { s, t, line: ml }
}

fn gcs(line: &str, compfunc: bool) -> Got {
	gcs_with(line, line.len(), compfunc, &opts())
}

fn words(t: &State) -> Vec<String> {
	t.clwords
		.iter()
		.map(|w| {
			let mut v = w.to_vec();
			tok::untokenize(&mut v);
			String::from_utf8_lossy(&v).into_owned()
		})
		.collect()
}

fn plain(s: &Option<Vec<u8>>) -> String {
	let mut v = s.clone().unwrap_or_default();
	tok::untokenize(&mut v);
	String::from_utf8_lossy(&v).into_owned()
}

#[test]
fn command_arguments() {
	let g = gcs("ls fo", false);
	assert_eq!(g.s.as_deref(), Some(&b"fo"[..]));
	assert_eq!(words(&g.t), ["ls", "fo"]);
	assert_eq!((g.t.clwpos, g.t.clwnum), (1, 2));
	assert_eq!((g.t.wb, g.t.we, g.t.offs), (3, 5, 2));
	assert_eq!((g.t.lincmd, g.t.linredir, g.t.inwhat), (0, 0, IN_NOTHING));
	assert_eq!(g.t.cmdstr.as_deref().map(Vec::as_slice), Some(&b"ls"[..]));
}

#[test]
fn command_position_and_later_commands() {
	let g = gcs("l", false);
	assert_eq!((g.s.as_deref(), g.t.lincmd, g.t.clwpos), (Some(&b"l"[..]), 1, 0));
	let g = gcs("ls; cat x", false);
	assert_eq!(words(&g.t), ["cat", "x"]);
	assert_eq!(g.t.clwpos, 1);
	let g = gcs("for i in a b; do ec", false);
	assert_eq!(g.s.as_deref(), Some(&b"ec"[..]));
	assert_eq!(g.t.lincmd, 1);
	let g = gcs("ls fo bar", false);
	assert_eq!((g.t.clwpos, g.s.as_deref()), (2, Some(&b"bar"[..])));
}

#[test]
fn empty_word_after_a_space() {
	let g = gcs("ls ", false);
	assert_eq!(g.s.as_deref(), Some(&b""[..]));
	assert_eq!(words(&g.t), ["ls", ""]);
	assert_eq!((g.t.clwpos, g.t.wb, g.t.we), (1, 3, 3));
}

#[test]
fn parameters() {
	let g = gcs("echo $fo", false);
	assert_eq!(g.s.as_deref(), Some(&[tok::STRING, b'f', b'o'][..]));
	assert_eq!((g.t.wb, g.t.we, g.t.offs), (5, 8, 3));
	assert_eq!(parambeg(g.s.as_deref().unwrap_or_default(), g.t.offs), Some(1));
	let g = gcs("echo ${fo", false);
	assert_eq!(g.s.as_deref(), Some(&[tok::STRING, tok::INBRACE, b'f', b'o'][..]));
	assert_eq!(parambeg(g.s.as_deref().unwrap_or_default(), g.t.offs), Some(2));
}

#[test]
fn subscripts() {
	let g = gcs("echo $arr[1", true);
	assert_eq!((g.t.inwhat, g.t.insubscr), (IN_MATH, 1));
	assert_eq!(g.t.varname.as_deref().map(Vec::as_slice), Some(&b"arr"[..]));
	assert_eq!(plain(&g.s), "1");
	let g = gcs("echo ${assoc[k", true);
	assert_eq!((g.t.inwhat, g.t.insubscr), (IN_MATH, 2));
	assert_eq!(g.t.keypm.as_deref().map(Vec::as_slice), Some(&b"assoc"[..]));
	assert_eq!(plain(&g.s), "k");
	let g = gcs("assoc[k", true);
	assert_eq!((g.t.inwhat, g.t.insubscr), (IN_MATH, 2));
	assert_eq!(g.t.varname.as_deref().map(Vec::as_slice), Some(&b"assoc"[..]));
	assert_eq!(plain(&g.s), "k");
}

#[test]
fn redirections() {
	let g = gcs("ls > fi", false);
	assert_eq!((g.t.linredir, g.t.rdstr.as_deref().map(Vec::as_slice)), (1, Some(&b">"[..])));
	assert_eq!((g.s.as_deref(), g.t.wb), (Some(&b"fi"[..]), 5));
	let g = gcs("ls 2>fi", false);
	assert_eq!((g.t.linredir, g.t.rdstr.as_deref().map(Vec::as_slice)), (1, Some(&b"2>"[..])));
	assert_eq!(g.s.as_deref(), Some(&b"fi"[..]));
}

#[test]
fn math() {
	let g = gcs("(( fo", true);
	assert_eq!(g.t.inwhat, IN_MATH);
	assert_eq!(plain(&g.s), " fo");
	assert_eq!(g.t.wb, 2);
	let g = gcs("echo $((fo", true);
	assert_eq!(g.t.inwhat, IN_MATH);
	assert_eq!(plain(&g.s), "fo");
	// Without a completion function: the parameter name at the cursor.
	let g = gcs("(( 1 + fo", false);
	assert_eq!((g.t.inwhat, plain(&g.s).as_str(), g.t.wb), (IN_MATH, "fo", 7));
}

#[test]
fn assignments() {
	let g = gcs("FOO=ba", false);
	assert_eq!((g.t.inwhat, g.s.as_deref()), (IN_ENV, Some(&b"ba"[..])));
	assert_eq!((g.t.wb, g.t.varname.as_deref().map(Vec::as_slice)), (4, Some(&b"FOO"[..])));
	// zsh's quirk: in the middle of the value it is a subscript.
	let g = gcs_with("FOO=bar", 6, true, &opts());
	assert_eq!((g.t.inwhat, g.t.insubscr), (IN_MATH, 1));
	assert_eq!(plain(&g.s), "OO=bar");
	let g = gcs("x=(a b", false);
	assert_eq!((g.t.inwhat, g.t.varname.as_deref().map(Vec::as_slice)), (IN_ENV, Some(&b"x"[..])));
	assert_eq!(g.s.as_deref(), Some(&b"b"[..]));
}

#[test]
fn quotes_come_off_the_word_and_the_line() {
	let g = gcs("echo \"ab c", false);
	assert_eq!(g.s.as_deref(), Some(&b"ab c"[..]));
	assert_eq!(g.t.instring, i32::from(qt::DOUBLE));
	assert_eq!(g.t.qipre.as_deref().map(Vec::as_slice), Some(&b"\""[..]));
	assert_eq!(g.line.bytes(), b"echo ab c");
	assert_eq!((g.line.cs, g.t.we), (9, 9));
	let g = gcs("echo 'x y", false);
	assert_eq!((g.s.as_deref(), g.t.instring), (Some(&b"x y"[..]), i32::from(qt::SINGLE)));
	assert_eq!(g.t.autoq.as_deref().map(Vec::as_slice), Some(&b"'"[..]));
	let g = gcs("echo \\$x\\ y", false);
	assert_eq!(g.s.as_deref(), Some(&b"$x y"[..]));
	assert_eq!(g.t.instring, i32::from(qt::NONE));
}

#[test]
fn braces() {
	let g = gcs("echo a{b,c", false);
	assert_eq!(plain(&g.s), "ac");
	assert_eq!(g.t.nbrbeg, 1);
	assert_eq!(g.t.brbeg[0].str.as_slice(), b"{b,");
	assert_eq!((g.t.brbeg[0].pos, g.t.brbeg[0].qpos), (1, 1));
	assert_eq!(g.t.offs, 2);
	assert!(g.t.commaspecial);
	// Closed braces before the cursor are left alone.
	let g = gcs_with("echo a{b,c}d", 12, false, &opts());
	assert_eq!(plain(&g.s), "a{b,c}d");
	assert_eq!(g.t.nbrbeg, 0);
}

#[test]
fn command_substitutions() {
	let g = gcs("echo $(ls fo", false);
	assert_eq!(words(&g.t), ["ls", "fo"]);
	assert_eq!((g.t.clwpos, g.s.as_deref(), g.t.wb), (1, Some(&b"fo"[..]), 10));
	let g = gcs("echo `ls fo", false);
	assert_eq!(words(&g.t), ["ls", "fo"]);
	assert_eq!(g.t.inbackt, 1);
}

#[test]
fn conditions() {
	let g = gcs("[[ -f fo", false);
	assert_eq!(g.t.inwhat, IN_COND);
	assert_eq!(words(&g.t), ["[[", "-f", "fo"]);
	assert_eq!(g.t.clwpos, 2);
}

#[test]
fn wildcards_and_prefixes() {
	let star = [b'*'];
	assert!(!cmphaswilds(&[tok::INBRACK], false, false));
	assert!(cmphaswilds(&[b'a', tok::STAR], false, false));
	assert!(!cmphaswilds(&[b'%', tok::QUEST, b'x'], false, false));
	assert!(!cmphaswilds(&[tok::STRING, tok::STAR], false, false));
	assert!(!cmphaswilds(&star, false, false));
	assert!(cmphaswilds(&[tok::INBRACE, b'a', tok::OUTBRACE], false, false));
	assert!(!cmphaswilds(&[tok::INBRACE, b'a', tok::OUTBRACE], false, true));
	assert_eq!(pfxlen(b"foobar", b"foobaz"), 5);
	assert_eq!(pfxlen("é".as_bytes(), "è".as_bytes()), 0);
	assert_eq!(spell::spdist_for_tests("sl", "ls"), 1);
	assert_eq!(spell::spdist_for_tests("lss", "ls"), 2);
	assert_eq!(spell::spdist_for_tests("ls", "ls"), 0);
	assert_eq!(spell::spdist_for_tests("LS", "ls"), 1);
}
