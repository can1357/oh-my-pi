//! Behaviour of the zsh pattern port against zsh 5.9. Expected values are
//! zsh's own: the `Misc/globtests` tables (as `D02glob.ztst` runs them),
//! the expected output of `D02glob.ztst` and `D04parameter.ztst`, and
//! results captured from `/bin/zsh -f` (5.9) for the rest.

#![allow(
	clippy::many_single_char_names,
	reason = "the helpers mirror zsh's ${(f)x OP p/r} shape: value, pattern, replacement, captures"
)]

use super::*;
use crate::bash::syntax::zsh::tok::{
	BNULL, BNULLKEEP, DNULL, INANG, INBRACK, NULARG, OUTANG, OUTBRACK, SNULL, STAR, metafy, unmetafy,
};

/// Options with `EXTENDED_GLOB` and the words of `spec`: `ksh`, `sh`,
/// `noext`, `mb`.
fn opts(spec: &str) -> Opts {
	let mut o = Opts { extended_glob: true, ..Opts::default() };
	for w in spec.split_whitespace() {
		match w {
			"ksh" => o.ksh_glob = true,
			"sh" => o.sh_glob = true,
			"noext" => o.extended_glob = false,
			"mb" => o.multibyte = true,
			_ => panic!("unknown option word {w}"),
		}
	}
	o
}

/// `p` as `${~p}` makes it: metafied and `shtokenize`d.
fn tok(p: &str, o: &Opts) -> Vec<u8> {
	let mut v = metafy(p.as_bytes());
	shtokenize(&mut v, o.sh_glob);
	v
}

/// `[[ s = ${~p} ]]` under `o`: `None` for a bad pattern.
fn m(o: &Opts, s: &str, p: &str) -> Option<bool> {
	let pat = Pattern::compile(&tok(p, o), PatFlags::NONE, o).ok()?;
	Some(pat.matches(&metafy(s.as_bytes()), &CharEnv::DEFAULT))
}

/// zsh's exit status for `[[ s = ${~p} ]]`: 0 match, 1 no match, 2 bad
/// pattern.
fn status(o: &Opts, s: &str, p: &str) -> u8 {
	match m(o, s, p) {
		Some(true) => 0,
		Some(false) => 1,
		None => 2,
	}
}

/// Run a `Misc/globtests` table.
fn run_table(data: &str, o: &Opts) {
	let mut n = 0;
	for line in data.lines() {
		let parts: Vec<&str> = line.split_whitespace().collect();
		if parts.first().is_none_or(|r| r.starts_with('#')) {
			continue;
		}
		let (res, s, p) = (parts[0], parts[1], parts[2..].join(" "));
		let want = res == "t";
		assert_eq!(m(o, s, &p), Some(want), "[[ {s} = {p} ]]");
		n += 1;
	}
	assert!(n > 80, "table read {n} cases");
}

#[test]
fn globtests_table() {
	run_table(include_str!("testdata/globtests.txt"), &opts(""));
}

#[test]
fn globtests_ksh_table() {
	run_table(include_str!("testdata/globtests_ksh.txt"), &opts("ksh"));
}

/// `[[ s = ${~p} ]]` statuses captured from zsh 5.9 with `extendedglob`
/// (plus the listed options).
const STATUS: &[(&str, &str, &str, u8)] = &[
	// Numeric ranges: bounds, open ends, leading zeros, huge numbers.
	("", "5", "<1-10>", 0),
	("", "10", "<1-10>", 0),
	("", "11", "<1-10>", 1),
	("", "0", "<1-10>", 1),
	("", "007", "<1-10>", 0),
	("", "4", "<5->", 1),
	("", "5", "<5->", 0),
	("", "6", "<-5>", 1),
	("", "", "<->", 1),
	("", "abc", "<->", 1),
	("", "123", "<->", 0),
	("", "x2y", "x<1-3>y", 0),
	("", "x02y", "x<1-3>y", 0),
	("", "x4y", "x<1-3>y", 1),
	("", "00", "<0-0>", 0),
	("", "12a", "<1-12>a", 0),
	("", "99999999999999999999", "<1->", 0),
	("", "99999999999999999999", "<-5>", 1),
	// ~ binds tighter than |; ^ covers the rest of its branch.
	("", "c", "a*~*b|c", 0),
	("", "ab", "a*~*b|c", 1),
	("", "ax", "a*~*b|c", 0),
	("", "bar.c", "^foo.c", 0),
	("", "foo.c", "^foo.c", 1),
	("", "xfoo", "x^foo", 1),
	("", "xbar", "x^foo", 0),
	("", "xfoo", "x(^foo)", 1),
	("", "ab", "(a|b)#", 0),
	("", "abc", "a|b|c", 1),
	("", "a|b", "a|b", 1),
	// Case flags; sets are case-sensitive even under (#i).
	("", "A", "(#i)[a]", 1),
	("", "A", "(#i)a", 0),
	("", "a", "(#l)A", 1),
	("", "A", "(#l)a", 0),
	("", "aB", "(#i)a(#I)b", 1),
	// zsh's pure-string shortcut keeps only the first string.
	("", "foobar", "foo(#b)bar", 1),
	("", "foo", "foo(#b)bar", 0),
	// Assertions.
	("", "abc", "(#s)abc(#e)", 0),
	("", "x", "(#e)x", 1),
	("", "x", "x(#s)", 1),
	// Counts.
	("", "aaa", "a(#c3)", 0),
	("", "aa", "a(#c3)", 1),
	("", "aaaa", "a(#c2,3)", 1),
	("", "", "a(#c0,)", 0),
	// Malformed patterns.
	("", "foo", "(#c0)foo", 2),
	("", "foo", "(#a2-)foo", 2),
	("", "foo", "(#x)foo", 2),
	("", "foo", "f[o", 2),
	("", "f*", "f*#", 2),
	// Sets.
	("", "]", "[]]", 0),
	("", "a", "[]a]", 0),
	("", "-", "[a-]", 0),
	("", "b", "[!a]", 0),
	("", "b", "[^a]", 0),
	("", "x", "[[:alpha:][:digit:]]", 0),
	("", "5", "[[:alpha:][:digit:]]", 0),
	("", "_", "[[:alpha:][:digit:]]", 1),
	("", "_", "[[:IDENT:]]", 0),
	("", " ", "[[:blank:]]", 0),
	("", "\t", "[[:space:]]", 0),
	("", "a", "[[:foo:]a]", 0),
	("", "b", "[[:foo:]a]", 1),
	// KSH_GLOB.
	("ksh", "abab", "+(ab)", 0),
	("ksh", "", "*(ab)", 0),
	("ksh", "x", "?(x)", 0),
	("ksh", "xx", "?(x)", 1),
	("ksh", "foo", "!(foo)", 1),
	("ksh", "bar", "@(foo|bar)", 0),
	// SH_GLOB: ( | ) and <..> stay characters.
	("sh", "(a)", "(a)", 0),
	("sh", "a", "(a)", 1),
	("sh", "<1-2>", "<1-2>", 0),
	("sh", "a", "a|b", 1),
	// Without EXTENDED_GLOB ~ ^ # are characters.
	("noext", "a~b", "a~b", 0),
	("noext", "a", "a~b", 1),
	("noext", "^a", "^a", 0),
	("noext", "a#", "a#", 0),
	// Glob qualifiers are skipped.
	("", "abc", "*(#q.)", 0),
	("", "abc", "(#qN)abc", 0),
	// Approximation, off in exclusions.
	("", "README", "(#a1)READ_ME", 0),
	("", "READ_ME", "(#a1)README~READ_ME", 1),
	("", "abcd", "(#a1)abdc", 0),
	("", "ab", "(#a1)abcd", 1),
	// No file rules outside globbing.
	("", ".x", "*x", 0),
	("", "a/b", "*", 0),
	("", "a/b", "a?b", 0),
];

#[test]
fn statuses_match_zsh() {
	for &(spec, s, p, want) in STATUS {
		assert_eq!(status(&opts(spec), s, p), want, "[{spec}] [[ {s:?} = {p} ]]");
	}
}

#[test]
fn ksh_characters_without_parentheses_are_literal() {
	let o = opts("ksh");
	for (s, p) in [
		("+fours", "+*"),
		("@titude", "@*"),
		("!bang", "!*"),
		("+bus+bus", "+(+bus|-car)"),
		("@sinhats", "@(@sinhats|wrensinfens)"),
		("!kerror", "!(!somethingelse)"),
	] {
		assert_eq!(m(&o, s, p), Some(true), "{s} = {p}");
	}
	for (s, p) in [("+more", "+(+less)"), ("@all@all", "@(@all)"), ("!goesitall", "!(!goesitall)")] {
		assert_eq!(m(&o, s, p), Some(false), "{s} != {p}");
	}
}

#[test]
fn ranges_and_quoted_dashes() {
	let o = opts("");
	let quoted = |set: &[u8]| {
		let mut v = vec![INBRACK];
		v.extend_from_slice(set);
		v.push(OUTBRACK);
		Pattern::compile(&v, PatFlags::NONE, &o).unwrap()
	};
	let env = &CharEnv::DEFAULT;
	assert_eq!(m(&o, "-", "[a-z]"), Some(false));
	assert!(quoted(b"a-z").matches(b"-", env));
	assert_eq!(m(&o, "b-1", "[a-z]-[0-9]"), Some(true));
	assert_eq!(m(&o, "b-1", "[]a-z]-[0-9]"), Some(true));
	assert_eq!(m(&o, "a", "[^a]"), Some(false));
	assert!(quoted(b"^a").matches(b"a", env));
	assert!(quoted(b"!a").matches(b"a", env));
	// cset="^a-z": ["$cset"] is a plain set, [$~cset] a negated range.
	let plain = quoted(b"^a-z");
	for (s, want) in [("^", true), ("a", true), ("-", true), ("z", true), ("1", false), ("b", false)]
	{
		assert_eq!(plain.matches(s.as_bytes(), env), want, "{s} in [\"^a-z\"]");
	}
	for (s, want) in
		[("^", true), ("a", false), ("-", true), ("z", false), ("1", true), ("b", false)]
	{
		assert_eq!(m(&o, s, "[^a-z]"), Some(want), "{s} in [^a-z]");
	}
	// A top-bit byte set without multibyte.
	let latin1 = [STAR, INBRACK, 0xe5, 0xe4, 0xf6, 0xf8, OUTBRACK, STAR];
	assert!(
		Pattern::compile(&latin1, PatFlags::NONE, &o)
			.unwrap()
			.matches(b"bj\xf8rn", env)
	);
}

#[test]
fn named_classes_read_ifs_and_wordchars() {
	let pat = |p: &str| Pattern::compile(&tok(p, &opts("")), PatFlags::NONE, &opts("")).unwrap();
	let with = |ifs: &'static [u8], wordchars: &'static [u8]| CharEnv {
		ifs,
		wordchars,
		posix_identifiers: false,
	};
	let d = CharEnv::DEFAULT;
	assert!(pat("[[:IDENT:]]##").matches(b"MY_IDENTIFIER", &d));
	assert!(!pat("[[:IDENT:]]##").matches(b"YOUR:IDENTIFIER", &d));
	assert!(pat("[[:IFS:]]").matches(b"\n", &with(b"\n", d.wordchars)));
	assert!(!pat("[[:IFS:]]").matches(b"\n", &with(b" ", d.wordchars)));
	assert!(!pat("[[:IFSSPACE:]]").matches(b":", &with(b":", d.wordchars)));
	assert!(pat("[[:IFSSPACE:]]").matches(b" ", &with(b" ", d.wordchars)));
	assert!(!pat("[[:WORD:]]").matches(b"/", &with(d.ifs, b"")));
	assert!(pat("[[:WORD:]]").matches(b"/", &with(d.ifs, b"/")));
}

#[test]
fn disable_p_turns_characters_off() {
	// D02glob "disable -p", in its order: disables accumulate.
	let mut o = Opts::default();
	let tpd = |o: &Opts, s: &str, p: &str| m(o, s, p).unwrap();
	let off = |o: &mut Opts, name: &str| {
		o.disables = o.disables | Disables::from_name(name.as_bytes()).unwrap();
	};
	assert!(tpd(&o, "forthcoming", "f*g"));
	off(&mut o, "*");
	assert!(!tpd(&o, "forthcoming", "f*g"));
	assert!(tpd(&o, "f*g", "f*g"));
	assert!(!tpd(&o, "[frog]", "[frog]"));
	assert!(tpd(&o, "[frog]", "\\[[f]rog\\]"));
	off(&mut o, "[");
	assert!(tpd(&o, "[frog]", "[frog]"));
	assert!(!tpd(&o, "[frog]", "\\[[f]rog\\]"));
	o.extended_glob = true;
	assert!(tpd(&o, "foo", "^bar"));
	off(&mut o, "^");
	assert!(!tpd(&o, "foo", "^bar"));
	assert!(tpd(&o, "^bar", "^bar"));
	assert!(tpd(&o, "rumble", "(rumble|bluster)"));
	assert!(!tpd(&o, "(thunder)", "(thunder)"));
	off(&mut o, "(");
	assert!(!tpd(&o, "rumble", "(rumble|bluster)"));
	assert!(tpd(&o, "(thunder)", "(thunder)"));
	o.ksh_glob = true;
	assert!(tpd(&o, "scramble", "@(panic|frenzy|scramble)"));
	assert!(!tpd(&o, "@(scrimf)", "@(scrimf)"));
	off(&mut o, "@(");
	assert!(!tpd(&o, "scramble", "@(panic|frenzy|scramble)"));
	assert!(tpd(&o, "@(scrimf)", "@(scrimf)"));
	assert_eq!(o.disables.names(true).collect::<Vec<_>>(), ["(", "*", "[", "^", "@("]);
	assert_eq!(Disables::from_name(b"&"), None);
}

/// Match `p` against `s` with captures under `o`.
fn caps(o: &Opts, s: &str, p: &str) -> Option<Captures> {
	let pat = Pattern::compile(&tok(p, o), PatFlags::NONE, o).unwrap();
	let mut c = Captures::default();
	pat.try_match(&metafy(s.as_bytes()), &CharEnv::DEFAULT, Some(&mut c))?;
	Some(c)
}

/// `$match`, `$mbegin`, `$mend` of `c` as zsh prints them.
fn groups(s: &str, c: &Captures) -> Vec<(String, i64, i64)> {
	let meta = metafy(s.as_bytes());
	c.groups
		.unwrap()
		.iter()
		.map(|g| match g {
			Some(g) => (
				String::from_utf8(unmetafy(&meta[g.byte_begin..g.byte_end])).unwrap(),
				g.begin as i64 + 1,
				g.end as i64,
			),
			None => (String::new(), -1, -1),
		})
		.collect()
}

/// Expected `groups` output.
fn exp(v: &[(&str, i64, i64)]) -> Vec<(String, i64, i64)> {
	v.iter().map(|&(s, b, e)| (s.to_owned(), b, e)).collect()
}

#[test]
fn backreferences_report_zsh_offsets() {
	let o = opts("");
	let c = caps(&o, "abc", "(#b)a(?)c").unwrap();
	assert_eq!(groups("abc", &c), exp(&[("b", 2, 2)]));
	let c = caps(&o, "ab", "(#b)(x|(a))b").unwrap();
	assert_eq!(groups("ab", &c), exp(&[("a", 1, 1), ("a", 1, 1)]));
	// The last repetition of a group wins.
	let c = caps(&o, "aab", "(#b)((a)|b)#").unwrap();
	assert_eq!(groups("aab", &c), exp(&[("b", 3, 3), ("a", 2, 2)]));
	// A group that took no part is "" -1 -1.
	let c = caps(&o, "xyz", "(#b)(x)(q)#(y)z").unwrap();
	assert_eq!(groups("xyz", &c), exp(&[("x", 1, 1), ("", -1, -1), ("y", 2, 2)]));
	// (#B) stops numbering.
	let c = caps(&o, "foo", "(#b)(f)(#B)(o)(o)").unwrap();
	assert_eq!(groups("foo", &c), exp(&[("f", 1, 1)]));
	// A failed match writes nothing.
	assert!(caps(&o, "abc", "(#b)x(?)").is_none());
	let pat = Pattern::compile(&tok("(#b)x(?)", &o), PatFlags::NONE, &o).unwrap();
	let mut c = Captures::default();
	assert!(
		pat.try_match(b"abc", &CharEnv::DEFAULT, Some(&mut c))
			.is_none()
	);
	assert_eq!(c, Captures::default());
}

#[test]
fn match_flag_scope() {
	let o = opts("");
	let sets = |p: &str| {
		Pattern::compile(&tok(p, &o), PatFlags::NONE, &o)
			.unwrap()
			.sets_match()
	};
	assert!(sets("(#m)abc"));
	assert!(!sets("(#m)a(#M)bc"));
	assert!(!sets("((#m)a)bc"));
	assert!(!sets("a((#m)bc)"));
	let c = caps(&o, "abc", "(#m)a*").unwrap();
	let w = c.whole.unwrap();
	assert_eq!((w.begin + 1, w.end, w.byte_begin, w.byte_end), (1, 3, 0, 3));
	assert!(c.groups.is_none());
}

#[test]
fn multibyte_captures_count_characters_and_metafied_bytes() {
	let o = opts("mb");
	let c = caps(&o, "aéb€c", "(#b)a(?)b(?)c").unwrap();
	assert_eq!(groups("aéb€c", &c), exp(&[("é", 2, 2), ("€", 4, 4)]));
	let c = caps(&o, "aé€b€c", "(#b)(*)€*").unwrap();
	assert_eq!(groups("aé€b€c", &c), exp(&[("aé€b", 1, 4)]));
	// ƃ is c6 83, and 0x83 is metafied: three bytes in the subject.
	let c = caps(&o, "aƃb", "(#b)a(?)b").unwrap();
	let g = c.groups.unwrap().get(0).unwrap();
	assert_eq!((g.begin, g.end, g.byte_begin, g.byte_end), (1, 2, 1, 4));
	let c = caps(&o, "aƃb", "(#m)*b").unwrap();
	let w = c.whole.unwrap();
	assert_eq!((w.begin + 1, w.end, w.byte_end), (1, 3, 5));
}

#[test]
fn multibyte_characters_and_classes() {
	let mb = opts("mb");
	for (s, p, want) in [
		("É", "(#i)é", true),
		("é", "(#l)É", false),
		("É", "(#l)é", true),
		("é", "[[:alpha:]]", true),
		("é", "[[:lower:]]", true),
		("é", "[[:upper:]]", false),
		("é", "[a-z]", false),
		("é", "[à-ê]", true),
		("é", "?", true),
		// zsh resets the flags of a second top-level branch to zero, so it
		// matches bytes there.
		("é", "a|[é]", false),
		("é", "(#U)??", true),
		("é", "(#U)?", false),
		("é", "[[:IDENT:]]", true),
		("é", "[[:WORD:]]", true),
		("ÀB", "(#ia1)àb", true),
		("éa", "(#a1)aé", true),
	] {
		assert_eq!(m(&mb, s, p), Some(want), "[[ {s} = {p} ]]");
	}
	let bad = Pattern::compile(&tok("??", &mb), PatFlags::NONE, &mb).unwrap();
	assert!(bad.matches(b"\xff\xfe", &CharEnv::DEFAULT));
	let inv = Pattern::compile(&tok("[[:INVALID:]]#", &mb), PatFlags::NONE, &mb).unwrap();
	assert!(inv.matches(b"\xff\xfe", &CharEnv::DEFAULT));
	assert!(!inv.matches(b"a", &CharEnv::DEFAULT));
}

/// `${(zf)x OP p[/r]}` with zsh's `subst.c` choice of `SUB_*` flags; a
/// `/` operator without `r` replaces with nothing. `Err` is a bad pattern.
fn gm(
	o: &Opts,
	zf: &str,
	v: &str,
	op: &str,
	p: &str,
	r: Option<&str>,
) -> Result<String, BadPattern> {
	let mut fl = SubFlags::NONE;
	let mut n = 0;
	let mut chars = zf.chars();
	while let Some(c) = chars.next() {
		match c {
			'S' => fl |= SubFlags::SUBSTR,
			'M' => fl |= SubFlags::MATCH,
			'R' => fl |= SubFlags::REST,
			'B' => fl |= SubFlags::BIND,
			'E' => fl |= SubFlags::EIND,
			'N' => fl |= SubFlags::LEN,
			'*' => fl |= SubFlags::EGLOB,
			'I' => {
				let spec: String = chars.by_ref().skip(1).take_while(|&c| c != ':').collect();
				n = spec.parse().unwrap();
			},
			_ => panic!("flag {c}"),
		}
	}
	if n == 0 {
		n = 1;
	}
	let mut repl = None;
	match op {
		"#" => {},
		"##" => fl |= SubFlags::LONG,
		"%" => fl |= SubFlags::END,
		"%%" => fl |= SubFlags::END | SubFlags::LONG,
		":#" => fl |= SubFlags::ALL,
		_ => {
			let mut rest = op.strip_prefix('/').unwrap();
			let keep = if fl.contains(SubFlags::SUBSTR) {
				SubFlags::NONE
			} else {
				SubFlags::LONG
			};
			fl = keep
				| if fl.contains(SubFlags::EGLOB) {
					SubFlags::EGLOB
				} else {
					SubFlags::NONE
				};
			if let Some(r) = rest.strip_prefix('/') {
				fl |= SubFlags::GLOBAL;
				rest = r;
			}
			if let Some(r) = rest.strip_prefix('#') {
				fl |= SubFlags::START;
				rest = r;
			}
			if rest == "%" {
				fl |= SubFlags::END;
			}
			if !fl.contains(SubFlags::START) && !fl.contains(SubFlags::END) {
				fl |= SubFlags::SUBSTR;
			}
			repl = Some(r.unwrap_or(""));
		},
	}
	if !(fl.contains(SubFlags::MATCH)
		|| fl.contains(SubFlags::REST)
		|| fl.contains(SubFlags::BIND)
		|| fl.contains(SubFlags::EIND)
		|| fl.contains(SubFlags::LEN))
	{
		fl |= SubFlags::REST;
	}
	let mut fixed =
		|_: &Captures, out: &mut Vec<u8>| out.extend_from_slice(repl.unwrap_or("").as_bytes());
	let mut c = Captures::default();
	let r = getmatch(
		&metafy(v.as_bytes()),
		&tok(p, o),
		fl,
		n,
		repl.is_some().then_some(&mut fixed as &mut Replace<'_>),
		o,
		&CharEnv::DEFAULT,
		&mut c,
	)?;
	Ok(String::from_utf8(unmetafy(&r.value)).unwrap())
}

/// One `${(flags)x OP p[/r]}` case: flags, value, operator, pattern,
/// replacement, result.
type GetmatchCase =
	(&'static str, &'static str, &'static str, &'static str, Option<&'static str>, &'static str);

/// `${(flags)x OP p[/r]}` results captured from zsh 5.9 (extendedglob).
const GETMATCH: &[GetmatchCase] = &[
	("", "abcbcd", "#", "b*", None, "abcbcd"),
	("", "abcbcd", "#", "a*", None, "bcbcd"),
	("", "abcbcd", "##", "a*c", None, "d"),
	("", "abcbcd", "%", "c*", None, "abcb"),
	("", "abcbcd", "%%", "c*", None, "ab"),
	("", "abcbcd", "%", "b*d", None, "abc"),
	("", "abcbcd", "%%", "b*d", None, "a"),
	("S", "abcbcd", "#", "b*c", None, "abcd"),
	("S", "abcbcd", "##", "b*c", None, "ad"),
	("S", "abcbcd", "%", "b*c", None, "abcd"),
	("S", "abcbcd", "%%", "b*c", None, "abcd"),
	("SI:2:", "abcbcd", "#", "b*c", None, "abcd"),
	("SI:2:", "abcbcd", "##", "b?", None, "abcd"),
	("SI:2:", "abcbcd", "%", "b?", None, "abcd"),
	("SI:3:", "abcbcd", "%", "b?", None, "abcd"),
	("SI:2:", "abcbcd", "%%", "b*", None, "a"),
	("M", "abcbcd", "#", "a*b", None, "ab"),
	("MBEN", "abcbcd", "##", "a*b", None, "abcb 1 5 4"),
	("R", "abcbcd", "%", "c*", None, "abcb"),
	("MR", "abcbcd", "%", "c*", None, "cd abcb"),
	("BE", "abcbcd", "#", "x*", None, "1 1"),
	("N", "abcbcd", "%%", "c*", None, "4"),
	("MS", "abcbcd", "%", "b?", None, "bc"),
	("BES", "abcbcd", "##", "cb", None, "3 5"),
	("", "abcbcd", "/", "b", Some("X"), "aXcbcd"),
	("", "abcbcd", "//", "b", Some("X"), "aXcXcd"),
	("", "abcbcd", "/#", "a", Some("X"), "Xbcbcd"),
	("", "abcbcd", "/#", "b", Some("X"), "abcbcd"),
	("", "abcbcd", "/%", "d", Some("X"), "abcbcX"),
	("", "abcbcd", "/%", "c", Some("X"), "abcbcd"),
	("", "abcbcd", "//#", "a", Some("X"), "Xbcbcd"),
	("", "abcbcd", "/#%", "abcbcd", Some("X"), "X"),
	("", "abcbcd", "/", "b*c", Some("X"), "aXd"),
	("S", "abcbcd", "/", "b*c", Some("X"), "aXbcd"),
	("S", "abcbcd", "//", "b*c", Some("X"), "aXXd"),
	("", "abcbcd", "//", "?(#e)", Some("X"), "abcbcX"),
	("", "abcbcd", "//", "(#s)?", Some("X"), "Xbcbcd"),
	("", "abcbcd", "//", "", Some("X"), "XaXbXcXbXcXd"),
	("", "abcbcd", "//", "x#", Some("-"), "-a-b-c-b-c-d"),
	("", "abc", "//", "*", Some("<>"), "<>"),
	("", "abcbcd", "/", "x", Some("X"), "abcbcd"),
	("", "abcbcd", "/", "b", None, "acbcd"),
	("I:2:", "abcbcd", "//", "b", Some("X"), "abcXcd"),
	("I:2:", "abcbcd", "/", "b", Some("X"), "abcXcd"),
	("", "abcbcd", ":#", "a*", None, ""),
	("", "abcbcd", ":#", "b*", None, "abcbcd"),
	("M", "abcbcd", ":#", "a*", None, "abcbcd"),
	("M", "abcbcd", ":#", "b*", None, ""),
	("", "pws", "#", "*", None, "pws"),
	("S", "pws", "#", "*", None, "pws"),
	("S", "pws", "##", "*", None, ""),
	("S", "pws", "#", "?", None, "ws"),
	("S", "pws", "%", "*", None, "pws"),
	("S", "pws", "%%", "*", None, "pws"),
	("S", "pws", "%", "?", None, "pw"),
	("", "pws", "%%", "*", None, ""),
	("", "aaa", "//", "a(#e)", Some("X"), "aaX"),
	("", "a.b.c", "%", ".*", None, "a.b"),
	("", "a.b.c", "%%", ".*", None, "a"),
	("", "a.b.c", "#", "*.", None, "b.c"),
	("", "a.b.c", "##", "*.", None, "c"),
	("", "foobar", "/", "(#i)O", Some("0"), "f0obar"),
	("", "foo bar", "//", "[[:space:]]", Some("_"), "foo_bar"),
	("", "x12y345", "//", "<->", Some("N"), "xNyN"),
	("", "x12y345", "//", "<1-99>", Some("N"), "xNyNN"),
	("S", "abcabc", "/", "(#s)b", Some("X"), "abcabc"),
	("S", "abcabc", "//", "b(#e)", Some("X"), "abcabc"),
	("", "abcabc", "//", "c(#e)", Some("X"), "abcabX"),
	// D02glob and D04parameter.
	("", "this string has a : colon in it", "%%", " #:*", None, "this string has a"),
	("", "ac", "//", "[ab-z]", Some("x"), "xx"),
	("", "bcdef", "#", "[a-z]", None, "cdef"),
	("", "o this is so, so so very dull", "//", "o*", Some("Please no"), "Please no"),
	(
		"S",
		"o this is so, so so very dull",
		"//",
		"o*",
		Some("Please no"),
		"Please no this is sPlease no, sPlease no sPlease no very dull",
	),
	(
		"S",
		"where is the white windmill, whispered walter wisely",
		"#",
		"h*e",
		None,
		"wre is the white windmill, whispered walter wisely",
	),
	("S", "where is the white windmill, whispered walter wisely", "##", "h*e", None, "wly"),
	(
		"S",
		"where is the white windmill, whispered walter wisely",
		"%",
		"h*e",
		None,
		"where is the white windmill, wred walter wisely",
	),
	(
		"S",
		"where is the white windmill, whispered walter wisely",
		"%%",
		"h*e",
		None,
		"where is the white windmill, wly",
	),
	(
		"SI:3:",
		"where is the white windmill, whispered walter wisely",
		"##",
		"w[^[:space:]]# ",
		None,
		"where is the white whispered walter wisely",
	),
	(
		"MSI:1:",
		"where is the white windmill, whispered walter wisely",
		"##",
		"w[^[:space:]]# ",
		None,
		"where ",
	),
	(
		"R",
		"where is the white windmill, whispered walter wisely",
		"//",
		"w[a-z]# #",
		None,
		"is the , ",
	),
	("BES", "where is the white windmill, whispered walter wisely", "##", "white", None, "14 19"),
	("NS", "where is the white windmill, whispered walter wisely", "##", "white", None, "5"),
	("SNBE", "abcdef", "#", "abcd", None, "1 5 4"),
];

#[test]
fn getmatch_flags_match_zsh() {
	let o = opts("");
	for &(zf, v, op, p, r, want) in GETMATCH {
		assert_eq!(gm(&o, zf, v, op, p, r).unwrap(), want, "${{({zf})x{op}{p}/{r:?}}} x={v:?}");
	}
	let o = Opts { multibyte: false, ..o };
	assert_eq!(gm(&o, "BES", "where is the white", "##", "white", None).unwrap(), "14 19");
}

#[test]
fn getmatch_multibyte_indices() {
	let mb = opts("mb");
	let x = "aéb€c";
	assert_eq!(gm(&mb, "B", x, "#", "*é", None).unwrap(), "1");
	assert_eq!(gm(&mb, "E", x, "#", "*é", None).unwrap(), "3");
	assert_eq!(gm(&mb, "N", x, "%%", "€*", None).unwrap(), "2");
	assert_eq!(gm(&mb, "BEN", x, "%%", "€*", None).unwrap(), "4 6 2");
	assert_eq!(gm(&mb, "", x, "//", "?", Some(".")).unwrap(), ".....");
	assert_eq!(gm(&mb, "N", x, "##", "*", None).unwrap(), "5");
	let bytes = opts("");
	assert_eq!(gm(&bytes, "N", x, "##", "*", None).unwrap(), "8");
	assert_eq!(gm(&bytes, "", x, "//", "?", Some(".")).unwrap(), "........");
	assert_eq!(gm(&mb, "", "aƃb", "/", "ƃ", Some("Z")).unwrap(), "aZb");
	assert_eq!(gm(&mb, "", "aƃb", "#", "a?", None).unwrap(), "b");
}

#[test]
fn getmatch_bad_pattern_and_arrays() {
	let o = opts("");
	assert_eq!(gm(&o, "", "x", "#", "(#c0)x", None), Err(BadPattern));
	let arr = ["arthur", "boldly", "claws", "dogs", "every", "fight"];
	let run = |fl: SubFlags| {
		let mut c = Captures::default();
		getmatcharr(arr, &tok("[aeiou]*", &o), fl, 1, None, &o, &CharEnv::DEFAULT, &mut c)
			.unwrap()
			.into_iter()
			.map(|v| String::from_utf8(v).unwrap())
			.collect::<Vec<_>>()
	};
	assert_eq!(run(SubFlags::ALL | SubFlags::REST), ["boldly", "claws", "dogs", "fight"]);
	assert_eq!(run(SubFlags::ALL | SubFlags::MATCH), ["arthur", "every"]);
	let mut y = |_: &Captures, out: &mut Vec<u8>| out.push(b'Y');
	let mut c = Captures::default();
	let fl = SubFlags::SUBSTR | SubFlags::GLOBAL | SubFlags::REST;
	let r =
		getmatcharr(arr, &tok("[aeiou]*", &o), fl, 1, Some(&mut y), &o, &CharEnv::DEFAULT, &mut c)
			.unwrap();
	assert_eq!(r, [&b"YrthYr"[..], b"bYldly", b"clYws", b"dYgs", b"YvYry", b"fYght"]);
}

/// `${x//p/r}` (or the given flags) with `r` built from the captures of
/// each match by `f`.
fn gm_refs(
	v: &str,
	p: &str,
	fl: SubFlags,
	o: &Opts,
	f: impl Fn(&[u8], &Captures) -> String,
) -> (String, Captures) {
	let meta = metafy(v.as_bytes());
	let mut caps = Captures::default();
	let mut repl = |c: &Captures, out: &mut Vec<u8>| out.extend_from_slice(f(&meta, c).as_bytes());
	let r =
		getmatch(&meta, &tok(p, o), fl, 1, Some(&mut repl), o, &CharEnv::DEFAULT, &mut caps).unwrap();
	(String::from_utf8(unmetafy(&r.value)).unwrap(), caps)
}

/// Text of a span of the metafied subject.
fn text(meta: &[u8], s: Span) -> String {
	String::from_utf8(unmetafy(&meta[s.byte_begin..s.byte_end])).unwrap()
}

#[test]
fn replacement_expands_per_match_with_captures() {
	let o = opts("");
	let global = SubFlags::LONG | SubFlags::GLOBAL | SubFlags::SUBSTR | SubFlags::REST;
	let (r, _) = gm_refs("abcbcd", "(#m)b?", global, &o, |m, c| {
		let w = c.whole.unwrap();
		format!("<{}:{}:{}>", text(m, w), w.begin + 1, w.end)
	});
	assert_eq!(r, "a<bc:2:3><bc:4:5>d");
	let (r, _) = gm_refs("abcbcd", "(#b)(b)(c|d)", global, &o, |m, c| {
		let g = c.groups.unwrap();
		let (a, b) = (g.get(0).unwrap(), g.get(1).unwrap());
		format!("<{}{}:{}:{}>", text(m, a), text(m, b), b.begin + 1, b.end)
	});
	assert_eq!(r, "a<bc:3:3><bc:5:5>d");
	// The pure-string path sets (#m) too.
	let (r, _) = gm_refs("this is a string", "(#m)s", global, &o, |m, c| {
		let w = c.whole.unwrap();
		format!("{} {} {}", text(m, w), w.begin + 1, w.end)
	});
	assert_eq!(r, "this 4 4 is 7 7 a s 11 11tring");
	let (r, _) = gm_refs("aaa", "(#b)(a)", global, &o, |_, c| {
		(c.groups.unwrap().get(0).unwrap().begin + 1).to_string()
	});
	assert_eq!(r, "123");
	// ${(S)x/(#b)X(?)/[$match[1]:$mbegin[1]]}
	let (r, _) = gm_refs("aXbXc", "(#b)X(?)", SubFlags::SUBSTR | SubFlags::REST, &o, |m, c| {
		let g = c.groups.unwrap().get(0).unwrap();
		format!("[{}:{}]", text(m, g), g.begin + 1)
	});
	assert_eq!(r, "a[b:3]Xc");
	// ${x/%(#m)ab/<$MBEGIN>}
	let tail = SubFlags::LONG | SubFlags::END | SubFlags::REST;
	let (r, _) =
		gm_refs("abab", "(#m)ab", tail, &o, |_, c| format!("<{}>", c.whole.unwrap().begin + 1));
	assert_eq!(r, "ab<3>");
	// ${file//(#b)(*)left/${match/a/andsome}}
	let (r, _) = gm_refs("aleftkept", "(#b)(*)left", global, &o, |m, c| {
		text(m, c.groups.unwrap().get(0).unwrap()).replacen('a', "andsome", 1)
	});
	assert_eq!(r, "andsomekept");
}

#[test]
fn captures_after_getmatch_are_the_last_success() {
	let o = opts("");
	let mut c = Captures::default();
	let s = metafy(b"abcbcd");
	let fl = SubFlags::END | SubFlags::LONG | SubFlags::SUBSTR | SubFlags::REST;
	getmatch(&s, &tok("(#b)(b)c*", &o), fl, 1, None, &o, &CharEnv::DEFAULT, &mut c).unwrap();
	let g = c.groups.unwrap().get(0).unwrap();
	assert_eq!((g.begin + 1, g.end), (4, 4));
	let mut c = Captures::default();
	getmatch(
		&s,
		&tok("(#b)(b)*", &o),
		SubFlags::END | SubFlags::REST,
		1,
		None,
		&o,
		&CharEnv::DEFAULT,
		&mut c,
	)
	.unwrap();
	let g = c.groups.unwrap().get(0).unwrap();
	assert_eq!((g.begin + 1, g.end), (4, 4));
	// (#S)%%(#m)M*H in "and look for a MATCH in here".
	let s = metafy(b"and look for a MATCH in here");
	let mut c = Captures::default();
	let r = getmatch(&s, &tok("(#m)M*H", &o), fl, 1, None, &o, &CharEnv::DEFAULT, &mut c).unwrap();
	assert_eq!(r.value, b"and look for a  in here");
	let w = c.whole.unwrap();
	assert_eq!((w.begin + 1, w.end, &s[w.byte_begin..w.byte_end]), (16, 20, &b"MATCH"[..]));
}

#[test]
fn counts_backtrack_through_closures() {
	let o = opts("");
	assert_eq!(m(&o, "1_2_", "(*_)(#c1)"), Some(true));
	assert_eq!(m(&o, "1_2_", "(*_)(#c2)"), Some(true));
	assert_eq!(m(&o, "1_2_", "(*_)(#c3)"), Some(false));
	assert_eq!(m(&opts("mb"), "é€é", "(é)#(#c0)€?"), None);
}

#[test]
fn glob_qualifiers_are_ignored_in_conditions() {
	let o = opts("");
	// [[ "ce fichier n'existe pas" = (#b)ce\ (f[^ ]#)\ *s(#q./) ]]
	let mut p = metafy(b"(#b)ce\\ (f[^ ]#)\\ *s(#q./)");
	tokenize(&mut p);
	for c in &mut p {
		if *c == b'\\' {
			*c = BNULL;
		}
	}
	let pat = Pattern::compile(&p, PatFlags::NONE, &o).unwrap();
	let mut c = Captures::default();
	let s = b"ce fichier n'existe pas";
	assert!(pat.try_match(s, &CharEnv::DEFAULT, Some(&mut c)).is_some());
	let g = c.groups.unwrap().get(0).unwrap();
	assert_eq!(&s[g.byte_begin..g.byte_end], b"fichier");
}

#[test]
fn noanch_reports_prefix_length() {
	let o = opts("");
	let pat = |p: &str| Pattern::compile(&tok(p, &o), PatFlags::NOANCH, &o).unwrap();
	let env = &CharEnv::DEFAULT;
	assert_eq!(pat("ab*").try_match(b"abcd", env, None), Some(4));
	assert_eq!(pat("a?").try_match(b"abc", env, None), Some(2));
	assert_eq!(pat("abc").try_match(b"abcd", env, None), Some(3));
	assert_eq!(pat("b").try_match(b"abc", env, None), None);
	// Lengths count metafied bytes.
	assert_eq!(pat("?").try_match(&metafy(&[0x83, b'x']), env, None), Some(2));
}

#[test]
fn pure_strings_and_quoted_empty_subject() {
	let o = opts("");
	let pat = |p: &str| Pattern::compile(&tok(p, &o), PatFlags::NONE, &o).unwrap();
	assert_eq!(pat("abc").pure(), Some(&b"abc"[..]));
	assert_eq!(pat("a*").pure(), None);
	assert_eq!(pat("foo(#b)bar").pure(), Some(&b"foo"[..]));
	// A quoted empty string is a lone Nularg on both sides.
	let empty = Pattern::compile(&[SNULL, SNULL], PatFlags::NONE, &o).unwrap();
	assert!(empty.matches(&[NULARG], &CharEnv::DEFAULT));
	assert!(empty.matches(b"", &CharEnv::DEFAULT));
	assert!(!empty.matches(b"x", &CharEnv::DEFAULT));
}

#[test]
fn file_segments() {
	let o = Opts { extended_glob: true, ..Opts::default() };
	let mut st = FileGlobState::start(&o);
	let text = tok("*.c/foo", &o);
	let (p, end) = Pattern::compile_segment(&text, PatFlags::NOGLD, &o, &mut st).unwrap();
	assert_eq!(end, 3);
	let env = &CharEnv::DEFAULT;
	let mut ap = Approx::START;
	assert!(p.try_file(b"x.c", b"", env, &mut ap));
	assert!(!p.try_file(b".x.c", b"", env, &mut ap));
	let (foo, end2) =
		Pattern::compile_segment(&text[end + 1..], PatFlags::NONE, &o, &mut st).unwrap();
	assert_eq!((foo.pure(), end2), (Some(&b"foo"[..]), 3));
	// Without CASE_GLOB file patterns ignore case; a pure string stays.
	let nocase = Opts { case_glob: false, ..o };
	let mut st = FileGlobState::start(&nocase);
	let (p, _) =
		Pattern::compile_segment(&tok("abc*", &o), PatFlags::NONE, &nocase, &mut st).unwrap();
	assert!(p.try_file(b"ABCd", b"", env, &mut ap));
	// Flags at the end of a segment carry over to the next.
	let mut st = FileGlobState::start(&o);
	let text = tok("(#i)/abc", &o);
	let (_, end) = Pattern::compile_segment(&text, PatFlags::NONE, &o, &mut st).unwrap();
	let (p, _) = Pattern::compile_segment(&text[end + 1..], PatFlags::NONE, &o, &mut st).unwrap();
	assert!(p.try_file(b"ABC", b"", env, &mut ap));
	// PAT_ANY: anything but a leading dot.
	let any = Pattern::compile_segment(b"", PatFlags::ANY | PatFlags::NOGLD, &o, &mut st)
		.unwrap()
		.0;
	assert!(any.try_file(b"x", b"", env, &mut ap));
	assert!(!any.try_file(b".x", b"", env, &mut ap));
}

#[test]
fn top_level_file_exclusion_sees_the_whole_path() {
	let o = opts("");
	let mut st = FileGlobState::start(&o);
	let text = tok("*~foo/x", &o);
	let (p, end) = Pattern::compile_segment(&text, PatFlags::FILET, &o, &mut st).unwrap();
	assert_eq!(end, text.len());
	assert!(p.flags().contains(PatFlags::HAS_EXCLUDP));
	let env = &CharEnv::DEFAULT;
	let mut ap = Approx::START;
	assert!(p.try_file(b"bar", b"foo/", env, &mut ap));
	assert!(!p.try_file(b"x", b"foo/", env, &mut ap));
	assert!(p.try_file(b"x", b"baz/", env, &mut ap));
}

#[test]
fn tokenize_marks_pattern_characters() {
	let mut s = b"a\\*b<1-5>c<1-x".to_vec();
	tokenize(&mut s);
	// The scan for <n-m> steps over its - and digits.
	assert_eq!(s, [
		b'a', BNULL, b'*', b'b', INANG, b'1', b'-', b'5', OUTANG, b'c', b'<', b'1', b'-', b'x'
	]);
	let mut s = b"a-b".to_vec();
	tokenize(&mut s);
	assert_eq!(s, [b'a', crate::bash::syntax::zsh::tok::DASH, b'b']);
	let mut s = b"\\[x".to_vec();
	shtokenize(&mut s, false);
	assert_eq!(s, [BNULLKEEP, b'[', b'x']);
	// SH_GLOB keeps ( | ) and the <, but - and > are still tokens (zsh
	// zshtokenize only skips the <n-m> scan).
	let mut s = b"(a|b)<1-2>".to_vec();
	shtokenize(&mut s, true);
	assert_eq!(s, [
		b'(',
		b'a',
		b'|',
		b'b',
		b')',
		b'<',
		b'1',
		crate::bash::syntax::zsh::tok::DASH,
		b'2',
		OUTANG
	]);
	// A backslash before an ordinary character stays.
	let mut s = b"\\a".to_vec();
	tokenize(&mut s);
	assert_eq!(s, b"\\a");
}

#[test]
fn remnulargs_drops_quotes_and_keeps_an_empty_marker() {
	let mut s = vec![SNULL, b'a', SNULL];
	remnulargs(&mut s);
	assert_eq!(s, b"a");
	let mut s = vec![DNULL, DNULL];
	remnulargs(&mut s);
	assert_eq!(s, [NULARG]);
	let mut s = vec![BNULLKEEP, b'a', DNULL, BNULLKEEP, b'b'];
	remnulargs(&mut s);
	assert_eq!(s, [BNULLKEEP, b'a', b'\\', b'b']);
	let mut s = vec![BNULLKEEP, b'a'];
	remnulargs(&mut s);
	assert_eq!(s, [BNULLKEEP, b'a']);
}

#[test]
fn haswilds_follows_options() {
	let o = Opts::default();
	let w = |s: &str, o: &Opts| haswilds(&mut tok(s, &Opts::default()), o);
	assert!(!w("[", &o));
	assert!(w("a*", &o));
	assert!(w("[ab]", &o));
	assert!(!w("a#", &o));
	assert!(w("a#", &opts("")));
	assert!(w("(a)", &o));
	assert!(!w("(a)", &Opts { sh_glob: true, ..o }));
	assert!(w("?(a)", &Opts { sh_glob: true, ksh_glob: true, ..o }));
	assert!(!w("plain", &o));
	let mut job = tok("%?foo", &o);
	assert!(!haswilds(&mut job, &o));
	assert_eq!(job[1], b'?');
	let off = Opts { disables: Disables::from_name(b"*").unwrap(), ..o };
	assert!(!w("a*", &off));
}
