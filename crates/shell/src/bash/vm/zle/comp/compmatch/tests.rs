use std::sync::Arc;

use bstr::BString;

use super::{parse::parse_class_for_test, *};
use crate::bash::vm::zle::comp::types::{Cmlist, cmatcher_flags as f};

fn parse(s: &str) -> (Result<Option<Arc<Cmatcher>>, ()>, Vec<String>) {
	let mut w = Vec::new();
	let r = parse_cmatcher(Some(b"compadd"), s.as_bytes(), &mut |m: &[u8]| {
		w.push(String::from_utf8_lossy(m).into_owned());
	});
	(r, w)
}

fn one(s: &str) -> Cmatcher {
	let (r, w) = parse(s);
	assert!(w.is_empty(), "{s}: {w:?}");
	let m = r.expect("parses").expect("non-empty");
	assert!(m.next.is_none(), "{s}: one matcher");
	(*m).clone()
}

fn err(s: &str) -> String {
	let (r, w) = parse(s);
	assert!(r.is_err(), "{s} must fail");
	assert_eq!(w.len(), 1, "{s}: {w:?}");
	w[0].clone()
}

fn ch(c: char) -> Cpattern {
	Cpattern::Char(c)
}

const RANGE: u8 = 0x83 + 21;

#[test]
fn parse_m_and_equivalence_classes() {
	let m = one("m:{a-z}={A-Z}");
	assert_eq!(m.flags, 0);
	assert_eq!((m.llen, m.wlen), (1, 1));
	assert_eq!(m.line, vec![Cpattern::Equiv(BString::from(vec![RANGE, b'a', b'z']))]);
	assert_eq!(m.word, vec![Cpattern::Equiv(BString::from(vec![RANGE, b'A', b'Z']))]);
	let m = one("M:ab=?");
	assert_eq!(m.flags, f::LINE);
	assert_eq!(m.line, vec![ch('a'), ch('b')]);
	assert_eq!((m.llen, m.wlen), (2, 1));
	assert_eq!(m.word, vec![Cpattern::Any]);
}

#[test]
fn parse_classes() {
	let m = one("m:[!a]=[[:upper:]x]");
	assert_eq!(m.line, vec![Cpattern::NClass("a".into())]);
	assert_eq!(m.word, vec![Cpattern::CClass(BString::from(vec![0x83 + 12, b'x']))]);
	let m = one(r"m:\==[]a]");
	assert_eq!(m.line, vec![ch('=')]);
	assert_eq!(m.word, vec![Cpattern::CClass("]a".into())]);
	assert_eq!(parse_class_for_test(b"[^]]").0, Cpattern::CClass("^".into()));
	assert_eq!(one("m:é=e").line, vec![ch('é')]);
}

#[test]
fn parse_anchored_forms() {
	let m = one("l:|=*");
	assert_eq!(m.flags, f::LEFT);
	assert_eq!((m.lalen, m.llen, m.wlen), (0, 0, -1));
	let m = one("L:a|b=**");
	assert_eq!(m.flags, f::LEFT | f::LINE);
	assert_eq!((m.left.clone(), m.line.clone(), m.wlen), (vec![ch('a')], vec![ch('b')], -2));
	let m = one("l:a||b=c");
	assert_eq!(
		(m.left.clone(), m.right.clone(), m.ralen, m.llen),
		(vec![ch('a')], vec![ch('b')], 1, 0)
	);
	assert_eq!(m.word, vec![ch('c')]);
	let m = one("r:a|b=c");
	assert_eq!(m.flags, f::RIGHT);
	assert_eq!(
		(m.line.clone(), m.right.clone(), m.word.clone()),
		(vec![ch('a')], vec![ch('b')], vec![ch('c')])
	);
	let m = one("R:|=*");
	assert_eq!((m.flags, m.ralen, m.wlen), (f::RIGHT | f::LINE, 0, -1));
	let m = one("r:a||b=*");
	assert_eq!((m.left.clone(), m.right.clone(), m.llen), (vec![ch('a')], vec![ch('b')], 0));
	assert_eq!(one("b:a=b").flags, f::LEFT | f::INTER);
	assert_eq!(one("B:a=b").flags, f::LEFT | f::LINE | f::INTER);
	assert_eq!(one("e:a=b").flags, f::RIGHT | f::INTER);
	assert_eq!(one("E:a=b").flags, f::RIGHT | f::LINE | f::INTER);
	assert_eq!(one("b:a=b").line, vec![ch('a')]);
}

#[test]
fn parse_lists_and_x() {
	let (r, _) = parse("r:|[._-]=* r:|=*");
	let m = r.unwrap().unwrap();
	assert_eq!(m.right, vec![Cpattern::CClass("._-".into())]);
	assert_eq!((m.flags, m.ralen, m.wlen), (f::RIGHT, 1, -1));
	let n = m.next.clone().unwrap();
	assert_eq!((n.ralen, n.wlen, n.next.is_none()), (0, -1, true));
	assert_eq!(parse("").0, Ok(None));
	assert_eq!(parse("x:").0, Ok(None));
	let (r, _) = parse("m:a=b x: m:c=d");
	assert!(r.unwrap().unwrap().next.is_none());
}

#[test]
fn parse_errors() {
	assert_eq!(err("q:a=b"), "unknown match specification character `q'");
	assert_eq!(err("m"), "missing `:'");
	assert_eq!(err("m:"), "missing patterns");
	assert_eq!(err("m:a"), "missing word pattern");
	assert_eq!(err("l:a"), "missing line pattern");
	assert_eq!(err("l:a||"), "missing right anchor");
	assert_eq!(err("r:a"), "missing right anchor");
	assert_eq!(err("r:a|b"), "missing word pattern");
	assert_eq!(err("m:a=*"), "need anchor for `*'");
	assert_eq!(err("m:="), "need non-empty word or line pattern");
	assert_eq!(err("m:[a=b"), "unterminated character class");
	assert_eq!(err("m:a(=b"), "invalid pattern character `('");
	assert_eq!(err("x:y"), "unexpected pattern following x: specification");
	// Without a name only pattern errors are printed.
	let mut n = 0;
	assert!(parse_cmatcher(None, b"m:", &mut |_| n += 1).is_err());
	assert!(parse_cmatcher(None, b"m:(=a", &mut |_| n += 1).is_err());
	assert_eq!(n, 1);
}

#[test]
fn ranges() {
	let r = [RANGE, b'a', b'z', b'_'];
	let (mut ind, mut mt) = (0, 0);
	assert!(patmatchrange(&r, 'c', &mut ind, &mut mt));
	assert_eq!((ind, mt), (2, 21));
	assert!(patmatchrange(&r, '_', &mut ind, &mut mt));
	assert_eq!((ind, mt), (26, 0));
	let mut chr = 0;
	assert!(mb_patmatchindex(&r, 2, &mut chr, &mut mt));
	assert_eq!(chr, 'c' as u32);
	assert_eq!(pattern_range_to_string(&[0x83 + 1, b'x']), b"[:alpha:]x");
	assert_eq!(pattern_range_to_string(&r), [RANGE, b'-', b'a', b'z', b'_']);
	let p = Cpattern::Equiv(BString::from(vec![RANGE, b'a', b'z']));
	assert!(pattern_match1(&p, 'a', &mut mt));
	assert_eq!(pattern_match1_ind(&p, 'b' as u32, &mut mt), 2);
	let up = Cpattern::Equiv(BString::from(vec![RANGE, b'A', b'Z']));
	// Index 0-based as in computil's call; compmatch.c's own callers pass
	// pattern_match1's 1 + index unchanged, as zsh 5.9 does.
	assert_eq!(pattern_match_equivalence(&up, 0, 21, 'a'), Some('A'));
	assert_eq!(pattern_match_equivalence(&up, 1, 21, 'a'), Some('B'));
	assert!(pattern_match_full(&[p.clone()], b"b", &[up.clone()], b"B"));
	assert!(!pattern_match_full(&[p], b"b", &[up], b"C"));
}

fn comp(spec: &str) -> Comp {
	let mut c = Comp::default();
	let m = parse(spec).0.unwrap();
	c.core.mstack =
		Some(Arc::new(Cmlist { next: None, matcher: m.clone(), str: spec.into() }));
	add_bmatchers(&mut c, m.as_ref());
	c
}

#[test]
fn match_str_case_insensitive() {
	let mut c = comp("m:{a-z}={A-Z}");
	assert_eq!(match_str(&mut c, b"ab", b"ABc", None, 0, None, false, 0, false), 2);
	assert_eq!(c.matcher.matchbuf, "AB");
	assert!(c.matcher.matchparts.is_none());
	// Upper case on the line does not match lower case.
	assert_eq!(match_str(&mut c, b"aB", b"ab", None, 0, None, false, 0, false), -1);
	let mut c = Comp::default();
	assert_eq!(match_str(&mut c, b"ab", b"ABc", None, 0, None, false, 0, false), -1);
	assert_eq!(match_str(&mut c, b"ab", b"abc", None, 0, None, false, 0, false), 2);
}

#[test]
fn match_str_partial_words() {
	let mut c = comp("r:|[._-]=* r:|=*");
	let mut rwl = 0;
	assert_eq!(match_str(&mut c, b"f.b", b"foo.bar", None, 0, Some(&mut rwl), false, 0, false), 5);
	assert_eq!(c.matcher.matchbuf, "foo.");
	assert_eq!(rwl, 4);
	assert!(c.matcher.matchparts.is_some());
	assert_eq!(match_str(&mut c, b"f.x", b"foo.bar", None, 0, None, false, 0, false), -1);
}

#[test]
fn match_str_left_anchor_star() {
	let mut c = comp("l:|=*");
	assert_eq!(match_str(&mut c, b"b", b"ab", None, 0, None, false, 0, false), 2);
	assert_eq!(c.matcher.matchbuf, "a");
	let mut c = Comp::default();
	assert_eq!(match_str(&mut c, b"b", b"ab", None, 0, None, false, 0, false), -1);
}

#[test]
fn comp_match_words() {
	let (mut b, mut s, mut ex) = (0, 0, 0);
	let mut clp = None;
	let mut c = comp("r:|[._-]=* r:|=*");
	let r =
		comp_match_word(&mut c, b"f.b", None, b"foo.bar", &mut clp, 1, &mut b, 0, &mut s, 0, &mut ex);
	assert_eq!(r.as_ref().map(|s| s.as_slice()), Some(&b"foo.bar"[..]));
	assert_eq!(ex, 0);
	assert!(clp.is_some());
	let mut c = comp("m:{a-z}={A-Z}");
	let r = comp_match_word(&mut c, b"ab", None, b"ABc", &mut clp, 1, &mut b, 0, &mut s, 0, &mut ex);
	assert_eq!(r.as_ref().map(|s| s.as_slice()), Some(&b"ABc"[..]));
	let r = comp_match_word(
		&mut c,
		b"ab",
		Some(b"c"),
		b"abxc",
		&mut clp,
		1,
		&mut b,
		0,
		&mut s,
		0,
		&mut ex,
	);
	assert_eq!(r.as_ref().map(|s| s.as_slice()), Some(&b"abxc"[..]));
	assert_eq!(ex, 0);
	let r = comp_match_word(&mut c, b"ab", None, b"ab", &mut clp, 1, &mut b, 0, &mut s, 0, &mut ex);
	assert_eq!((r.as_ref().map(|s| s.as_slice()), ex), (Some(&b"ab"[..]), 1));
	assert!(
		comp_match_word(&mut c, b"x", None, b"ab", &mut clp, 1, &mut b, 0, &mut s, 0, &mut ex)
			.is_none()
	);
}

#[test]
fn join_clines_keeps_common_prefix() {
	let mut c = comp("r:|[._-]=* r:|=*");
	let (mut b, mut s, mut ex) = (0, 0, 0);
	let (mut l1, mut l2) = (None, None);
	comp_match_word(&mut c, b"f", None, b"foo.bar", &mut l1, 1, &mut b, 0, &mut s, 0, &mut ex)
		.unwrap();
	comp_match_word(&mut c, b"f", None, b"foo.baz", &mut l2, 1, &mut b, 0, &mut s, 0, &mut ex)
		.unwrap();
	let j = join_clines(&mut c, None, l1);
	assert_eq!(j, l1);
	let j = join_clines(&mut c, j, l2).unwrap();
	let _ = cline_sublen(&c.clines, j);
	let mut cp = cp_cline(&mut c, Some(j), true);
	cline_setlens(&mut c.clines, cp, true);
	cp = revert_cline(&mut c, cp);
	free_cline(&mut c, cp);
	assert!(c.matcher.freecl.is_some());
}
