//! Behaviour tests: every expectation below is what glibc 2.36's
//! `regcomp(REG_EXTENDED [| REG_ICASE])` + `regexec` report (offsets as
//! `regmatch_t`, `-1` for an unset group), i.e. what bash puts in
//! `BASH_REMATCH` on Linux.

use crate::bash::pattern::ere::{Regex, RegexErrorKind as K};

enum Want {
	Match(&'static [(isize, isize)]),
	NoMatch,
	Fails(K),
}

use Want::*;

type Case = (bool, &'static [u8], &'static [u8], Want);

fn check(utf8: bool, cases: &[Case]) {
	for (icase, pattern, subject, want) in cases {
		let shown = (String::from_utf8_lossy(pattern), String::from_utf8_lossy(subject), icase);
		let re = Regex::with_utf8(pattern, *icase, utf8);
		match want {
			Fails(kind) => assert_eq!(re.map(|_| ()).map_err(|e| e.kind()), Err(*kind), "{shown:?}"),
			NoMatch => assert_eq!(re.expect("compiles").captures(subject), None, "{shown:?}"),
			Match(groups) => {
				let got = re.expect("compiles").captures(subject);
				let want: Vec<_> = groups
					.iter()
					.map(|&(so, eo)| (so >= 0).then_some(so as usize..eo as usize))
					.collect();
				assert_eq!(got, Some(want), "{shown:?}");
			},
		}
	}
}

/// bash's own `=~` tests (cond.tests, cond-regexp1..3.sub), leftmost-longest
/// selection, glibc's submatch choices, intervals, back-references, anchors,
/// GNU escapes, bracket corners, `REG_ICASE` quirks and every compile error.
#[test]
fn matches_glibc_in_the_c_locale() {
	check(false, &[
		(
			false,
			br"([^-]+)-([^-]+)-([^-]+)-0*([1-9][0-9]*)\.tgz",
			br"jbig2dec-0.9-i586-001.tgz",
			Match(&[(0, 25), (0, 8), (9, 12), (13, 17), (20, 21)]),
		),
		(
			false,
			br"\([^-]+\)-\([^-]+\)-\([^-]+\)-0*\([1-9][0-9]*\)\.tgz",
			br"jbig2dec-0.9-i586-001.tgz",
			NoMatch,
		),
		(false, br"libc", br"linux-vdso.so.1 libc.so.6 => /lib/libc.so.6", Match(&[(16, 20)])),
		(false, br"[[:alpha:]]", br"a", Match(&[(0, 1)])),
		(false, br"[[:space:]]*(a)?b", br"  xb", Match(&[(3, 4), (-1, -1)])),
		(false, br"([[:alpha:][:blank:]]*)- ([[:digit:]]*) - (.*)$", br"Dog 01 - Wiggles", NoMatch),
		(false, br"(one two)", br"one two three", Match(&[(0, 7), (0, 7)])),
		(false, br"one two", br"one two", Match(&[(0, 7)])),
		(false, br"world$", br"helloworld", Match(&[(5, 10)])),
		(false, br"oworld$", br"helloworld", Match(&[(4, 10)])),
		(false, br"", br"helloworld", Match(&[(0, 0)])),
		(false, br"", br"", Match(&[(0, 0)])),
		(false, br"[.]", br"\", NoMatch),
		(false, br"[\.", br"\", Fails(K::Bracket)),
		(false, br"[\.]", br"\", Match(&[(0, 1)])),
		(false, br"[\\]", br"\", Match(&[(0, 1)])),
		(false, br"[z-a]", br"x", Fails(K::Range)),
		(false, br"[[:invalid:]abc]", br"x", Fails(K::CharClass)),
		(false, br"x\", br"x", Fails(K::Escape)),
		(false, br"a(xb", br"x", Fails(K::Paren)),
		(false, br"[[=d=]]..", br"dog", Match(&[(0, 3)])),
		(false, br"[[=d=]].[[=G=][=g=]]", br"dog", Match(&[(0, 3)])),
		(false, br"[[=d=]].[\[=G=][=g=]]", br"dog", Match(&[(0, 3)])),
		(false, br"[[.d.][.D.]]o.", br"dog", Match(&[(0, 3)])),
		(false, br"([[.d.][.D.]])o(.)", br"dog", Match(&[(0, 3), (0, 1), (2, 3)])),
		(false, br"d([[.o.][.O.]])(.)", br"dog", Match(&[(0, 3), (1, 2), (2, 3)])),
		(false, br"[]]", br"]", Match(&[(0, 1)])),
		(false, br"[a]]", br"a", NoMatch),
		(false, br"[^]\.]", br"\", NoMatch),
		(false, br"[^]\.]", br"x", Match(&[(0, 1)])),
		(false, br"\[", br"[", Match(&[(0, 1)])),
		(false, br"\x", br"x", Match(&[(0, 1)])),
		(false, br"\\x", br"x", NoMatch),
		(false, br"a\-b", br"a-b", Match(&[(0, 3)])),
		(false, br"(a|ab)(c|bcd)(d*)", br"abcd", Match(&[(0, 4), (0, 1), (1, 4), (4, 4)])),
		(false, br"(|a)b", br"xabcx", Match(&[(1, 3), (1, 2)])),
		(false, br"(a|)b", br"xabcx", Match(&[(1, 3), (1, 2)])),
		(false, br"(|a|b)c", br"bc", Match(&[(0, 2), (0, 1)])),
		(false, br"(a*)*", br"aaa", Match(&[(0, 3), (0, 3)])),
		(false, br"(a*)*", br"", Match(&[(0, 0), (0, 0)])),
		(false, br"(a*)*", br"b", Match(&[(0, 0), (0, 0)])),
		(false, br"(a?)*b", br"ab", Match(&[(0, 2), (0, 1)])),
		(false, br"(a?)*", br"aa", Match(&[(0, 2), (1, 2)])),
		(false, br"((a?))*", br"aa", Match(&[(0, 2), (1, 2), (1, 2)])),
		(false, br"(a*)+", br"aaa", Match(&[(0, 3), (0, 3)])),
		(false, br"(a*)+b", br"b", Match(&[(0, 1), (0, 0)])),
		(false, br"(ab)+", br"abab", Match(&[(0, 4), (2, 4)])),
		(false, br"(a|b)*c", br"abac", Match(&[(0, 4), (2, 3)])),
		(false, br"(a|b)*", br"abba", Match(&[(0, 4), (3, 4)])),
		(false, br"(a|ab)*c", br"abac", Match(&[(0, 4), (2, 3)])),
		(false, br"(a+|b+)*", br"aabbba", Match(&[(0, 6), (5, 6)])),
		(false, br"(a|ab)(bc|c)", br"abc", Match(&[(0, 3), (0, 1), (1, 3)])),
		(false, br"(ab|a)(bc|c)", br"abc", Match(&[(0, 3), (0, 2), (2, 3)])),
		(false, br"(a|ab)(c|bcd)", br"abcd", Match(&[(0, 4), (0, 1), (1, 4)])),
		(false, br"(.*)(.*)", br"abc", Match(&[(0, 3), (0, 3), (3, 3)])),
		(false, br"(.*?)x", br"abxcx", Match(&[(0, 5), (0, 4)])),
		(false, br"x(.*)", br"axbxc", Match(&[(1, 5), (2, 5)])),
		(false, br"(a)|b", br"b", Match(&[(0, 1), (-1, -1)])),
		(false, br"(a)|(b)", br"b", Match(&[(0, 1), (-1, -1), (0, 1)])),
		(false, br"(a)(b)?", br"a", Match(&[(0, 1), (0, 1), (-1, -1)])),
		(false, br"((a)|b)+", br"ab", Match(&[(0, 2), (1, 2), (0, 1)])),
		(false, br"((a)|b)+", br"ba", Match(&[(0, 2), (1, 2), (1, 2)])),
		(false, br"(a(b)?)+", br"aba", Match(&[(0, 3), (2, 3), (1, 2)])),
		(false, br"(a(b)?)+", br"abab", Match(&[(0, 4), (2, 4), (3, 4)])),
		(false, br"(a{2})*", br"aaaaa", Match(&[(0, 4), (2, 4)])),
		(false, br"a{2,3}", br"aaaa", Match(&[(0, 3)])),
		(false, br"(a{2,3})", br"xaaaay", Match(&[(1, 4), (1, 4)])),
		(false, br"(a){2,3}", br"aaaa", Match(&[(0, 3), (2, 3)])),
		(false, br"(a){0,2}", br"aaa", Match(&[(0, 2), (1, 2)])),
		(false, br"(a){,2}", br"aaa", Match(&[(0, 2), (1, 2)])),
		(false, br"(a){2,}", br"aaaaa", Match(&[(0, 5), (4, 5)])),
		(false, br"(a){0}b", br"ab", Match(&[(1, 2), (-1, -1)])),
		(false, br"a{0}", br"a", Match(&[(0, 0)])),
		(false, br"a{,}", br"aaa", Match(&[(0, 3)])),
		(false, br"a{1", br"a", Fails(K::Brace)),
		(false, br"a{1,", br"a", Fails(K::Brace)),
		(false, br"a{x}", br"a", Fails(K::BadBrace)),
		(false, br"a{1x}", br"a", Fails(K::BadBrace)),
		(false, br"a{}", br"a", Fails(K::BadBrace)),
		(false, br"a{2,1}", br"a", Fails(K::BadBrace)),
		(false, br"a{32767}", br"a", NoMatch),
		(false, br"a{32768}", br"a", Fails(K::Size)),
		(false, br"a{99999}", br"a", Fails(K::Size)),
		(false, br"{1}", br"a", Fails(K::BadRepeat)),
		(false, br"*a", br"a", Fails(K::BadRepeat)),
		(false, br"+a", br"a", Fails(K::BadRepeat)),
		(false, br"?a", br"a", Fails(K::BadRepeat)),
		(false, br"^*", br"a", Fails(K::BadRepeat)),
		(false, br"$*", br"a", Fails(K::BadRepeat)),
		(false, br"a|*b", br"b", Fails(K::BadRepeat)),
		(false, br"(*a)", br"a", Fails(K::BadRepeat)),
		(false, br"a**", br"aaa", Match(&[(0, 3)])),
		(false, br"a+?", br"aaa", Match(&[(0, 3)])),
		(false, br"a||b", br"b", Match(&[(0, 1)])),
		(false, br"a||b", br"x", Match(&[(0, 0)])),
		(false, br"()", br"x", Match(&[(0, 0), (0, 0)])),
		(false, br"(|)", br"x", Match(&[(0, 0), (0, 0)])),
		(false, br")", br")", Match(&[(0, 1)])),
		(false, br"a)", br"a)", Match(&[(0, 2)])),
		(false, br"}", br"}", Match(&[(0, 1)])),
		(false, br"a}", br"a}", Match(&[(0, 2)])),
		(false, br"(", br"x", Fails(K::Paren)),
		(false, br"[", br"x", Fails(K::BadPattern)),
		(false, br"[^", br"x", Fails(K::BadPattern)),
		(false, br"[a", br"x", Fails(K::Bracket)),
		(false, br"[]", br"x", Fails(K::Bracket)),
		(false, br"[]a", br"x", Fails(K::Bracket)),
		(false, br"[^]", br"x", Fails(K::Bracket)),
		(false, br"[[:alpha:]", br"x", Fails(K::Bracket)),
		(false, br"[[:alpha", br"x", Fails(K::Bracket)),
		(false, br"[[.", br"x", Fails(K::Bracket)),
		(false, br"[[.a.]-c]", br"b", Match(&[(0, 1)])),
		(false, br"[a-[.c.]]", br"b", Match(&[(0, 1)])),
		(false, br"[[.ab.]]", br"a", Fails(K::Collate)),
		(false, br"[[=ab=]]", br"a", Fails(K::Collate)),
		(false, br"[[..]]", br"a", Fails(K::Collate)),
		(false, br"[a-[:alpha:]]", br"a", Fails(K::Range)),
		(false, br"[[:alpha:]-z]", br"a", Fails(K::Range)),
		(false, br"[[=a=]-z]", br"a", Fails(K::Range)),
		(false, br"[a-]", br"-", Match(&[(0, 1)])),
		(false, br"[-a]", br"-", Match(&[(0, 1)])),
		(false, br"[a-c-e]", br"-", Fails(K::Range)),
		(false, br"[--0]", br"/", Match(&[(0, 1)])),
		(false, br"[]-a]", br"^", Match(&[(0, 1)])),
		(false, br"[^a-z]", br"A", Match(&[(0, 1)])),
		(false, br"[^a-z]", br"\n", Match(&[(0, 1)])),
		(false, br"[[:word:]]", br"a", Fails(K::CharClass)),
		(false, br"[[:upper:]]", br"a", NoMatch),
		(false, br"[[:punct:]]+", br"a!@#b", Match(&[(1, 4)])),
		(false, br"[[:xdigit:]]+", br"xFe9g", Match(&[(1, 4)])),
		(false, br"[[:cntrl:]]", br"a", NoMatch),
		(false, br"[[:print:]]+", br" ab", Match(&[(0, 3)])),
		(false, br"[[:graph:]]+", br" ab", Match(&[(1, 3)])),
		(false, br"[[:blank:]]+", br"a  b", Match(&[(1, 3)])),
		(false, br"\1", br"a", Fails(K::BackRef)),
		(false, br"(a)\2", br"a", Fails(K::BackRef)),
		(false, br"(a\1)", br"aa", Fails(K::BackRef)),
		(false, br"(a)\1", br"aa", Match(&[(0, 2), (0, 1)])),
		(false, br"(a)\1", br"ab", NoMatch),
		(false, br"(a*)b\1", br"aaabaa", Match(&[(1, 6), (1, 3)])),
		(false, br"(a*)b\1", br"aaaba", Match(&[(2, 5), (2, 3)])),
		(false, br"(a|b)*\1", br"abb", Match(&[(0, 3), (1, 2)])),
		(false, br"(a+)(b+)\2\1", br"xaabbbbaay", Match(&[(1, 9), (1, 3), (3, 5)])),
		(false, br"([a-c]*)\1", br"abcabc", Match(&[(0, 6), (0, 3)])),
		(false, br"([a-c]*)\1", br"abcab", Match(&[(0, 0), (0, 0)])),
		(false, br"(.)\1", br"abccd", Match(&[(2, 4), (2, 3)])),
		(false, br"(a)|\1", br"a", Fails(K::BackRef)),
		(false, br"(a)|b\1", br"b", Fails(K::BackRef)),
		(false, br"(a*)\1x", br"aaaax", Match(&[(0, 5), (0, 2)])),
		(false, br"(.*)\1", br"abab", Match(&[(0, 4), (0, 2)])),
		(false, br"^(.+)\1$", br"abcabc", Match(&[(0, 6), (0, 3)])),
		(false, br"^(.+)\1$", br"abcab", NoMatch),
		(false, br"\(a\)", br"(a)", Match(&[(0, 3)])),
		(false, br"a\|b", br"a|b", Match(&[(0, 3)])),
		(false, br"\w+", br"  foo_1 bar", Match(&[(2, 7)])),
		(false, br"\W+", br"foo, bar", Match(&[(3, 5)])),
		(false, br"\s+", br"a  b", Match(&[(1, 3)])),
		(false, br"\S+", br"  ab", Match(&[(2, 4)])),
		(false, br"\bfoo\b", br"a foo b", Match(&[(2, 5)])),
		(false, br"\bfoo\b", br"afoo b", NoMatch),
		(false, br"\Boo\B", br"foob", Match(&[(1, 3)])),
		(false, br"\<b", br"ab b", Match(&[(3, 4)])),
		(false, br"b\>", br"bb a", Match(&[(1, 2)])),
		(false, br"\`a", br"ab", Match(&[(0, 1)])),
		(false, br"b\'", br"ab", Match(&[(1, 2)])),
		(false, br"a^b", br"a^b", NoMatch),
		(false, br"a$b", br"a$b", NoMatch),
		(false, br"(^a)", br"ba", NoMatch),
		(false, br"(^a|b)", br"ba", Match(&[(0, 1), (0, 1)])),
		(false, br"(a$|b)", br"ab", Match(&[(1, 2), (1, 2)])),
		(false, br"x*", br"ab", Match(&[(0, 0)])),
		(false, br"x*", br"", Match(&[(0, 0)])),
		(false, br"a*", br"baaa", Match(&[(0, 0)])),
		(false, br"(a|b)*", br"cab", Match(&[(0, 0), (-1, -1)])),
		(false, br".", br"\n", Match(&[(0, 1)])),
		(false, br"^$", br"", Match(&[(0, 0)])),
		(false, br"^", br"abc", Match(&[(0, 0)])),
		(false, br"$", br"abc", Match(&[(3, 3)])),
		(false, br"(^|x)a", br"xa", Match(&[(0, 2), (0, 1)])),
		(false, br"(a$)|(b)", br"ba", Match(&[(0, 1), (-1, -1), (0, 1)])),
		(false, br"ab|abc", br"abcd", Match(&[(0, 3)])),
		(false, br"abc|ab", br"abcd", Match(&[(0, 3)])),
		(false, br"(a|b|c|d|e)f", br"ef", Match(&[(0, 2), (0, 1)])),
		(false, br"[0-9]+", br"foo1bar22", Match(&[(3, 4)])),
		(false, br"h.*o", br"hello world foo", Match(&[(0, 15)])),
		(false, br"(foo|foobar)(bar)?", br"foobar", Match(&[(0, 6), (0, 3), (3, 6)])),
		(false, br"(foobar|foo)(bar)?", br"foobar", Match(&[(0, 6), (0, 6), (-1, -1)])),
		(false, br"(a.*z|b.*y)", br"azbazbyc", Match(&[(0, 5), (0, 5)])),
		(false, br"(a.*z|b.*y)*", br"azbazbyc", Match(&[(0, 7), (5, 7)])),
		(false, br"(a|ab)*bc", br"abc", Match(&[(0, 3), (0, 1)])),
		(
			false,
			br"(.)(.)(.)(.)(.)(.)(.)(.)(.)(.)\9",
			br"abcdefghijii",
			Match(&[
				(0, 11),
				(0, 1),
				(1, 2),
				(2, 3),
				(3, 4),
				(4, 5),
				(5, 6),
				(6, 7),
				(7, 8),
				(8, 9),
				(9, 10),
			]),
		),
		(false, br"((a)(b))*", br"abab", Match(&[(0, 4), (2, 4), (2, 3), (3, 4)])),
		(false, br"(a)*(b)", br"aab", Match(&[(0, 3), (1, 2), (2, 3)])),
		(false, br"((a)*b)*", br"abaab", Match(&[(0, 5), (2, 5), (3, 4)])),
		(false, br"(a*)(b*)", br"aabbcc", Match(&[(0, 4), (0, 2), (2, 4)])),
		(false, br"(a*)|(b*)", br"bb", Match(&[(0, 2), (-1, -1), (0, 2)])),
		(false, br"(a+)|(b+)", br"bb", Match(&[(0, 2), (-1, -1), (0, 2)])),
		(false, br"(()|a)+", br"aa", Match(&[(0, 2), (1, 2), (0, 0)])),
		(false, br"(a|())+", br"aa", Match(&[(0, 2), (1, 2), (-1, -1)])),
		(false, br"((a)|())+", br"aa", Match(&[(0, 2), (1, 2), (1, 2), (-1, -1)])),
		(false, br"()+", br"x", Match(&[(0, 0), (0, 0)])),
		(false, br"(()*)*", br"x", Match(&[(0, 0), (0, 0), (0, 0)])),
		(false, br"(a*)*(b)", br"b", Match(&[(0, 1), (0, 0), (0, 1)])),
		(false, br"(a?){3}", br"aa", Match(&[(0, 2), (2, 2)])),
		(false, br"(a?){2,3}", br"a", Match(&[(0, 1), (0, 1)])),
		(false, br"a{1,2}b{2,3}", br"aaabbbb", Match(&[(1, 6)])),
		(true, br"abc", br"xABCy", Match(&[(1, 4)])),
		(true, br"[a-z]+", br"XYZ", Match(&[(0, 3)])),
		(true, br"[A-Z]+", br"xyz", Match(&[(0, 3)])),
		(true, br"[[:lower:]]+", br"ABC", Match(&[(0, 3)])),
		(true, br"[[:upper:]]+", br"abc", Match(&[(0, 3)])),
		(true, br"[Z-a]", br"z", Fails(K::Range)),
		(true, br"[_-a]", br"a", Fails(K::Range)),
		(true, br"[a-Z]", br"q", Match(&[(0, 1)])),
		(false, br"[a-Z]", br"q", Fails(K::Range)),
		(true, br"\a", br"a", NoMatch),
		(true, br"\a", br"A", NoMatch),
		(true, br"\.", br".", Match(&[(0, 1)])),
		(true, br"(A)\1", br"aa", Match(&[(0, 2), (0, 1)])),
		(true, br"(a)\1", br"aA", Match(&[(0, 2), (0, 1)])),
		(true, br"[^a]", br"A", NoMatch),
		(true, br"[[=a=]]", br"A", Match(&[(0, 1)])),
		(true, br"[[.a.]]", br"A", Match(&[(0, 1)])),
		(true, br"\w+", br"ABC", Match(&[(0, 3)])),
		(true, br"FOO|bar", br"xBARy", Match(&[(1, 4)])),
	]);
}

/// UTF-8 mode: `.` and brackets take whole characters, offsets stay bytes.
#[test]
fn matches_glibc_in_a_utf8_locale() {
	check(true, &[
		(false, br".", r"é".as_bytes(), Match(&[(0, 2)])),
		(false, br"^.$", r"é".as_bytes(), Match(&[(0, 2)])),
		(false, br"^..$", r"é".as_bytes(), NoMatch),
		(false, r"[é]".as_bytes(), r"xé".as_bytes(), Match(&[(1, 3)])),
		(false, br"[^a]", r"é".as_bytes(), Match(&[(0, 2)])),
		(false, br"[[:alpha:]]+", r"1éa2".as_bytes(), Match(&[(1, 4)])),
		(false, br"\w+", r"-héllo-".as_bytes(), Match(&[(1, 7)])),
		(false, br"(.)(.)", r"aé".as_bytes(), Match(&[(0, 3), (0, 1), (1, 3)])),
		(false, br"[a-z]", r"é".as_bytes(), NoMatch),
		(true, r"É".as_bytes(), r"é".as_bytes(), Match(&[(0, 2)])),
		(true, r"(é)\1".as_bytes(), r"éÉ".as_bytes(), Match(&[(0, 4), (0, 2)])),
		(false, r"\bé".as_bytes(), r"aé é".as_bytes(), Match(&[(4, 6)])),
	]);
}

/// Byte mode cuts the same text into bytes, as the C locale does.
#[test]
fn byte_mode_matches_bytes() {
	check(false, &[
		(false, br"^.$", r"é".as_bytes(), NoMatch),
		(false, br"^..$", r"é".as_bytes(), Match(&[(0, 2)])),
		(false, r"[é]".as_bytes(), r"é".as_bytes(), Match(&[(0, 1)])),
		(true, r"É".as_bytes(), r"é".as_bytes(), NoMatch),
	]);
}

#[test]
fn errors_display_as_regerror() {
	let err = Regex::new(b"(", false).unwrap_err();
	assert_eq!(err.to_string(), r"Unmatched ( or \(");
	assert_eq!(Regex::new(b"a{1,", false).unwrap_err().to_string(), r"Unmatched \{");
	assert_eq!(Regex::new(b"a{x}", false).unwrap_err().to_string(), r"Invalid content of \{\}");
}

#[test]
fn groups_counts_every_parenthesis() {
	assert_eq!(Regex::new(b"(a(b)|(c))d", false).unwrap().groups(), 3);
	assert_eq!(Regex::new(b"abc", false).unwrap().captures(b"abc"), Some(vec![Some(0..3)]));
}

/// Nested quantifiers stay linear: no exponential backtracking.
#[test]
fn nested_repetition_on_long_input_terminates() {
	let text = vec![b'x'; 4000];
	assert_eq!(Regex::new(b"(x+x+)+y", false).unwrap().captures(&text), None);
	let re = Regex::new(b"((x*)*)*$", false).unwrap();
	assert_eq!(re.captures(&text).map(|g| g[0].clone()), Some(Some(0..4000)));
}

/// Back-reference searches are bounded and report no match when the budget
/// runs out instead of hanging.
#[test]
fn backreference_search_is_bounded() {
	let mut text = vec![b'a'; 40];
	text.extend_from_slice(b"bx");
	let re = Regex::new(b"^(a+)+\\1x$", false).unwrap();
	assert_eq!(re.captures(&text), None);
}
