//! Behavior tests, largely ported from GoAWK's `interp/interp_test.go` table
//! (MIT).

use std::path::Path;

use super::Awk;
use crate::host::run_util;

/// Runs `awk args` in `cwd` with `stdin`: (status, stdout, stderr).
fn awk_in(cwd: &Path, args: &[&str], stdin: &str) -> (i32, String, String) {
	let (code, capture) = run_util::<Awk>(args, stdin, cwd);
	(code, capture.out(), capture.err())
}

fn awk(args: &[&str], stdin: &str) -> (i32, String, String) {
	awk_in(&std::env::temp_dir(), args, stdin)
}

/// Stdout of a successful `awk prog` run.
fn run(prog: &str, stdin: &str) -> String {
	let (code, out, err) = awk(&[prog], stdin);
	assert_eq!(code, 0, "awk {prog:?} failed: {err}");
	assert_eq!(err, "", "awk {prog:?} wrote to stderr");
	out
}

/// Programs from GoAWK's table: (program, input, expected output).
const TABLE: &[(&str, &str, &str)] = &[
	("1", "foo", "foo\n"),
	("{}", "foo", ""),
	("0 {}", "foo", ""),
	("$0", "foo\n\nbar", "foo\nbar\n"),
	("{ print $0 }", "foo\n\nbar", "foo\n\nbar\n"),
	("/foo/", "foo\nx\nfood\nxfooz\nbar", "foo\nfood\nxfooz\n"),
	("/foo/ { print NR }  /foo/", "foo\nx\nfood\n", "1\nfoo\n3\nfood\n"),
	("NR==2, NR==4", "1\n2\n3\n4\n5\n6\n", "2\n3\n4\n"),
	("{ print $1 }", "a b c\nd e f\n", "a\nd\n"),
	("NR>=2 && NR<=3", "1\n2\n3\n4\n", "2\n3\n"),
	("{ print $(NF-1) }", "a b c\n", "b\n"),
	(r#"BEGIN {FS = "[^,]*"} {for (i=1;i<=NF;i++) print i, "<"$i">"}"#, "x,,z", "1 <>\n2 <,,>\n3 <>\n"),
	(r#"BEGIN { FS = "," } { print $2 }"#, "a,b,c\n", "b\n"),
	(r#"BEGIN { FS = "\t" } { print $2 }"#, "a b\tc\n", "c\n"),
	("{ print NF }", "  a   b  \n\n", "2\n0\n"),
	(r#"BEGIN { printf "%% %d %x %c %f %s", 42, 42, 42, 42, 42 }"#, "", "% 42 2a * 42.000000 42"),
	(r#"BEGIN { printf "%d %i %o %u %x %X", 42, 42, 42, 42, 42, 42 }"#, "", "42 42 52 42 2a 2A"),
	(r#"BEGIN { printf "%3d|%3s|%-3s|", 42, "x", "x" }"#, "", " 42|  x|x  |"),
	(
		r#"BEGIN { printf "%5.2f|%-5d|%05d|%e|%g|%c|%s\n", 3.14159, 42, 42, 1234.5, 0.0001, "hello", "x" }"#,
		"",
		" 3.14|42   |00042|1.234500e+03|0.0001|h|x\n",
	),
	(r#"BEGIN { printf("%%%dd", 4) }"#, "", "%4d"),
	(r#"BEGIN { printf "%*d|%.*f\n", 5, 42, 1, 2.26 }"#, "", "   42|2.3\n"),
	("{ if (NR==2) next; print }", "a\nb\nc", "a\nc\n"),
	(r#"BEGIN { a["x"] = 3; print "x" in a, "y" in a }"#, "", "1 0\n"),
	("!seen[$0]++", "1\n2\n3\n2\n3\n3\n", "1\n2\n3\n"),
	("{ print !$0 }", "0\n1\n", "1\n0\n"),
	("{ print ($1>2) }", "1\n1.0\n+1", "0\n0\n0\n"),
	(r#"BEGIN { print (0>=1, 1>=1, 2>=1, "12">="2") }"#, "", "0 1 1 0\n"),
	("{ print ($1 == 10) }", "10.0\n", "1\n"),
	(r#"{ print ($1 == "10") }"#, "10.0\n", "0\n"),
	("{ print ($1 < $2) }", "10 9\nabc abd\n", "0\n1\n"),
	(r#"BEGIN { print x+0, x "", (x == 0), (x == "") }"#, "", "0  1 1\n"),
	("{ print ($5 == 0), ($5 == \"\") }", "a b\n", "1 1\n"),
	(r#"BEGIN { x = "a" "b" 1+2; print x }"#, "", "ab3\n"),
	("BEGIN { x = 2; x ^= 3; print x, 2**3**2, -2^2 }", "", "8 512 -4\n"),
	("BEGIN { i = 5; print i++, i, ++i, i--, i }", "", "5 6 7 7 6\n"),
	("BEGIN { print 7%3, -7%3, int(-3.9), int(\"4.5x\") }", "", "1 -1 -3 4\n"),
	(r#"{ n = gsub(/o/, "0"); print n, $0 }"#, "foo boo\n", "4 f00 b00\n"),
	(r#"{ sub(/o+/, "[&]"); print }"#, "foo\n", "f[oo]\n"),
	(r#"{ gsub(/o/, "\\&"); print }"#, "foo\n", "f&&\n"),
	(r#"{ sub(/b/, "X", $2); print; print NF }"#, "a b c\n", "a X c\n3\n"),
	(r#"{ gsub(/x*/, "-"); print }"#, "abc\n", "-a-b-c-\n"),
	(r#"{ sub(/b|bc/, "X"); print }"#, "abcd\n", "aXd\n"),
	(r#"BEGIN { print match("foobar", /o+/), RSTART, RLENGTH }"#, "", "2 2 2\n"),
	(r#"BEGIN { print match("abc", /z/), RSTART, RLENGTH }"#, "", "0 0 -1\n"),
	(r#"BEGIN { print match("héllo", "l+"), RSTART, RLENGTH }"#, "", "3 3 2\n"),
	(r#"BEGIN { n = split("a:b:c", arr, ":"); print n, arr[1], arr[3] }"#, "", "3 a c\n"),
	(r#"BEGIN { n = split("a1b22c", arr, /[0-9]+/); print n, arr[1], arr[2], arr[3] }"#, "", "3 a b c\n"),
	(r#"BEGIN { print split("  a  b ", arr), arr[1] arr[2], split("", arr), length(arr) }"#, "", "2 ab 0 0\n"),
	(r#"BEGIN { n = split("abc", chars, ""); print n, chars[1], chars[3] }"#, "", "3 a c\n"),
	(
		"BEGIN { a[1]; a[2]; a[3]; delete a[2]; n = 0; for (k in a) n++; print n, (2 in a), length(a); delete a; print length(a) }",
		"",
		"2 0 2\n0\n",
	),
	(
		"BEGIN { a[1,2] = 3; for (k in a) { split(k, p, SUBSEP); print p[1], p[2], a[k] }; print ((1,2) in a), ((2,1) in a) }",
		"",
		"1 2 3\n1 0\n",
	),
	(
		"function fill(arr, n,   i) { for (i = 1; i <= n; i++) arr[i] = i * i }
		 function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }
		 BEGIN { fill(sq, 3); print sq[1], sq[2], sq[3]; print fact(10) }",
		"",
		"1 4 9\n3628800\n",
	),
	("function f(x) { x = 5 } BEGIN { y = 1; f(y); print y }", "", "1\n"),
	(
		r#"function g(a) { a["k"] = 1 } function f(   loc) { g(loc); return length(loc) } BEGIN { print f() }"#,
		"",
		"1\n",
	),
	("function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2) } BEGIN { print fib(20) }", "", "6765\n"),
	(r#"NR == 1 { getline; print "after", $0, NR }"#, "a\nb\nc\n", "after b 2\n"),
	(r#"{ getline line; print $0 "-" line, NR }"#, "1\n2\n3\n4\n", "1-2 2\n3-4 4\n"),
	("BEGIN { while ((getline line) > 0) n++; print n, NR }", "a\nb\n", "2 2\n"),
	(r#"BEGIN { RS = "" } { print NR": "$1"|"$NF }"#, "a b\nc\n\n\nd\ne f\n", "1: a|c\n2: d|f\n"),
	(r#"BEGIN { RS = ""; FS = ":" } { print NF }"#, "\n\na:b\nc\n\nd\n", "3\n1\n"),
	(r#"BEGIN { RS = ";" } { print NR, $0 }"#, "a;b;c", "1 a\n2 b\n3 c\n"),
	("{ NF = 2; print; print NF }", "a b c d\n", "a b\n2\n"),
	(r#"{ $5 = "e"; print; print NF }"#, "a b\n", "a b   e\n5\n"),
	(r#"BEGIN { OFS = "-" } { $1 = $1; print }"#, "a b c\n", "a-b-c\n"),
	(r#"{ $0 = "x y z"; print NF, $2 }"#, "a\n", "3 y\n"),
	("{ print length, length() }", "héllo\n", "5 5\n"),
	(r#"BEGIN { print length("héllo"), substr("héllo", 2, 3), index("héllo", "l") }"#, "", "5 éll 3\n"),
	(r#"BEGIN { print substr("hello", 0, 3), substr("hello", 4), substr("hello", 2, 100) }"#, "", "he lo ello\n"),
	(r#"BEGIN { print toupper("abc"), tolower("ÀB") }"#, "", "ABC àb\n"),
	(r#"BEGIN { x = 3.14159265; y = x ""; print y; OFMT = "%.2f"; print x, 10 }"#, "", "3.14159\n3.14 10\n"),
	(r#"BEGIN { CONVFMT = "%.2g"; a[0.123456] = 1; for (k in a) print k }"#, "", "0.12\n"),
	(r#"{ print ($0 ~ "^a.c$"), ($0 !~ /b/) }"#, "abc\nadd\n", "1 0\n0 1\n"),
	(r#"{ print ($0 ~ /a\/b/), /[[:digit:]]{2}/ }"#, "a/b\nx12\n", "1 0\n0 1\n"),
	("BEGIN { srand(1); a = rand(); srand(1); b = rand(); print (a == b), (a >= 0 && a < 1), srand(5) }", "", "1 1 1\n"),
	(r#"BEGIN { print strftime("%Y-%m-%d %H:%M:%S", 0, 1), (systime() > 1000000000) }"#, "", "1970-01-01 00:00:00 1\n"),
	(r#"BEGIN { s = sprintf("%s=%d", "x", 7); print s, length(s) }"#, "", "x=7 3\n"),
	("BEGIN { while (1) { if (++i > 3) break; if (i == 2) continue; print i } }", "", "1\n3\n"),
	("BEGIN { do { print \"once\" } while (0) }", "", "once\n"),
	("BEGIN { for (;;) { print \"x\"; break } }", "", "x\n"),
	("BEGIN { print 1==1 ? \"yes\" : \"no\" }", "", "yes\n"),
	("BEGIN { print 1 > \"/dev/stdout\" }", "", "1\n"),
	(r#"BEGIN { print length(12345), length(1/4) }"#, "", "5 4\n"),
	(r#"BEGIN { x["a"] = 1; f(x); print x["a"] } function f(arr) { arr["a"]++ }"#, "", "2\n"),
	(r#"BEGIN { print index("abc", "c"), index("abc", "z") }"#, "", "3 0\n"),
	(r#"BEGIN { print 1e3, 0.1 + 0.2, 2^53, -0.5 }"#, "", "1000 0.3 9007199254740992 -0.5\n"),
	(r#"BEGIN { printf "%s %s\n", "a" > "/dev/stderr" }"#, "", ""),
];

#[test]
fn goawk_table() {
	for &(prog, input, expected) in TABLE {
		let (code, out, err) = awk(&[prog], input);
		if prog.contains("/dev/stderr") {
			// Too few printf arguments: a runtime error.
			assert_eq!(code, 2, "{prog}");
			assert!(err.starts_with("awk: format error"), "{prog}: {err}");
			continue;
		}
		assert_eq!((code, err.as_str()), (0, ""), "{prog}");
		assert_eq!(out, expected, "{prog}");
	}
}

#[test]
fn field_separator_option_forms() {
	assert_eq!(awk(&["-F:", "{ print $2 }"], "a:b:c\n").1, "b\n");
	assert_eq!(awk(&["-F", ",", "{ print $3 }"], "a,b,c\n").1, "c\n");
	assert_eq!(awk(&["-F", "\\t", "{ print $2 }"], "a b\tc\n").1, "c\n");
	assert_eq!(awk(&["-Ft", "{ print $2 }"], "a\tb\n").1, "b\n");
	assert_eq!(awk(&["-F", "[0-9]+", "{ print $2 }"], "a12b345c\n").1, "b\n");
	assert_eq!(awk(&["-F", "|", "{ print $2 }"], "a|b\n").1, "b\n");
}

#[test]
fn variable_assignments_process_escapes() {
	let (code, out, _) = awk(&["-v", "x=hello", "-v", "y=a\\tb", "BEGIN { print x; print y }"], "");
	assert_eq!((code, out.as_str()), (0, "hello\na\tb\n"));
	assert_eq!(awk(&["-vn=3", "BEGIN { print n + 1 }"], "").1, "4\n");
	// -v values are numeric strings.
	assert_eq!(awk(&["-v", "n=10", "BEGIN { print (n < 9) }"], "").1, "0\n");
	assert_eq!(awk(&["--", "BEGIN { print \"dashdash\" }"], "").1, "dashdash\n");
}

#[test]
fn operand_assignments_apply_when_reached() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("f1"), "a\n").unwrap();
	std::fs::write(dir.path().join("f2"), "b\n").unwrap();
	let (code, out, err) = awk_in(dir.path(), &["{ print v, FILENAME, FNR, NR, $0 }", "v=1", "f1", "v=2", "f2"], "");
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, "1 f1 1 1 a\n2 f2 1 2 b\n");
	// An assignment after the last file is seen by END.
	let (_, out, _) = awk_in(dir.path(), &["END { print v }", "f1", "v=end"], "");
	assert_eq!(out, "end\n");
	// "-" is stdin.
	let (_, out, _) = awk_in(dir.path(), &["{ print FILENAME \":\" $0 }", "f1", "-"], "x\n");
	assert_eq!(out, "f1:a\n-:x\n");
}

#[test]
fn argv_is_modifiable_before_input() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("a.txt"), "from a\n").unwrap();
	std::fs::write(dir.path().join("b.txt"), "from b\n").unwrap();
	let (_, out, _) = awk_in(dir.path(), &["BEGIN { ARGV[1] = \"b.txt\" } { print }", "a.txt"], "");
	assert_eq!(out, "from b\n");
	let (_, out, _) = awk_in(dir.path(), &["BEGIN { print ARGC, ARGV[0], ARGV[1] }", "a.txt"], "");
	assert_eq!(out, "2 awk a.txt\n");
}

#[test]
fn missing_input_file_is_reported_and_skipped() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("ok"), "fine\n").unwrap();
	let (code, out, err) = awk_in(dir.path(), &["{ print }", "missing", "ok"], "");
	assert_eq!(code, 2);
	assert_eq!(out, "fine\n");
	assert!(err.starts_with("awk: can't open file missing"), "{err}");
}

#[test]
fn program_files() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("prog.awk"), "{ print NR \": \" $0 }\n").unwrap();
	std::fs::write(dir.path().join("lib.awk"), "function twice(x) { return x * 2 }\n").unwrap();
	let (code, out, _) = awk_in(dir.path(), &["-f", "prog.awk"], "x\ny\n");
	assert_eq!((code, out.as_str()), (0, "1: x\n2: y\n"));
	std::fs::write(dir.path().join("main.awk"), "BEGIN { print twice(21) }\n").unwrap();
	let (code, out, _) = awk_in(dir.path(), &["-f", "lib.awk", "-f", "main.awk"], "");
	assert_eq!((code, out.as_str()), (0, "42\n"));
	std::fs::write(dir.path().join("bad.awk"), "BEGIN {\n  x = \n}\n").unwrap();
	let (code, _, err) = awk_in(dir.path(), &["-f", "bad.awk"], "");
	assert_eq!(code, 2);
	assert!(err.starts_with("awk: bad.awk:2:7: expected expression instead of <newline>\n"), "{err}");
}

#[test]
fn output_redirection_to_files() {
	let dir = tempfile::tempdir().unwrap();
	let prog = r#"{ print $0 > "out.txt" } END { close("out.txt"); while ((getline l < "out.txt") > 0) print "got", l }"#;
	let (code, out, err) = awk_in(dir.path(), &[prog], "a\nb\n");
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, "got a\ngot b\n");
	assert_eq!(std::fs::read_to_string(dir.path().join("out.txt")).unwrap(), "a\nb\n");
	let (code, ..) = awk_in(dir.path(), &[r#"{ print "more" >> "out.txt" }"#], "x\n");
	assert_eq!(code, 0);
	assert_eq!(std::fs::read_to_string(dir.path().join("out.txt")).unwrap(), "a\nb\nmore\n");
	let (code, out, _) = awk_in(dir.path(), &[r#"BEGIN { getline < "out.txt"; print $0, NF; print close("out.txt"), close("nope") }"#], "");
	assert_eq!((code, out.as_str()), (0, "a 1\n0 -1\n"));
	let (_, out, _) = awk_in(dir.path(), &[r#"BEGIN { print (getline line < "absent") }"#], "");
	assert_eq!(out, "-1\n");
}

#[test]
fn exit_status_and_end_rules() {
	assert_eq!(awk(&["BEGIN { exit 3 }"], "").0, 3);
	let (code, out, _) = awk(&["{ exit 1 } END { print \"end\", NR }"], "a\nb\n");
	assert_eq!((code, out.as_str()), (1, "end 1\n"));
	assert_eq!(awk(&["BEGIN { exit 4 } END { exit }"], "").0, 4);
	let (code, out, _) = awk(&["BEGIN { exit } END { print \"ran\" }"], "");
	assert_eq!((code, out.as_str()), (0, "ran\n"));
	assert_eq!(awk(&["END { print $0, NF }"], "a b\nc d e\n").1, "c d e 3\n");
}

#[test]
fn errors_exit_2() {
	let (code, out, err) = awk(&["BEGIN { x = }"], "");
	assert_eq!((code, out.as_str()), (2, ""));
	assert!(err.starts_with("awk: 1:13: expected expression instead of }\n"), "{err}");
	let (code, _, err) = awk(&["BEGIN { print 1/0 }"], "");
	assert_eq!((code, err.as_str()), (2, "awk: division by zero\n"));
	let (code, _, err) = awk(&["BEGIN { nextfile }"], "");
	assert_eq!(code, 2);
	assert!(err.contains("nextfile can't be inside BEGIN or END"), "{err}");
	let (code, _, err) = awk(&["function f(a) { a[1] = 1 } BEGIN { x = 1; f(x) }"], "");
	assert_eq!(code, 2);
	assert!(err.contains("can't pass scalar \"x\" as array param"), "{err}");
	let (code, _, err) = awk(&["BEGIN { print undefined_fn(1) }"], "");
	assert_eq!(code, 2);
	assert!(err.contains("undefined function"), "{err}");
	let (code, _, err) = awk(&["-x", "1"], "");
	assert_eq!(code, 2);
	assert!(err.starts_with("awk: unknown option -x"), "{err}");
	assert_eq!(awk(&[], "").0, 2);
	let (code, _, err) = awk(&["/[/"], "");
	assert_eq!(code, 2);
	assert!(err.contains("unterminated ["), "{err}");
}

#[test]
fn version_flag() {
	let (code, out, _) = awk(&["--version"], "");
	assert_eq!(code, 0);
	assert!(out.starts_with("awk "), "{out}");
}

#[test]
fn non_ascii_input_counts_characters() {
	let out = run("{ print length($0), toupper($0) }", "a\u{fffd}b\n");
	assert_eq!(out, "3 A\u{fffd}B\n");
}

#[test]
fn nextfile_moves_to_the_next_file() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("a"), "1\n2\n").unwrap();
	std::fs::write(dir.path().join("b"), "3\n4\n").unwrap();
	let (_, out, _) = awk_in(dir.path(), &["{ print; nextfile }", "a", "b"], "");
	assert_eq!(out, "1\n3\n");
}

/// Command tests go through the test command runner, which runs command
/// lines as `sh -c`.
#[cfg(unix)]
mod commands {
	async fn awk(args: &[&str], stdin: &str) -> (i32, String, String) {
		let dir = std::env::temp_dir();
		let argv: Vec<&str> = std::iter::once("awk").chain(args.iter().copied()).collect();
		crate::host::run_extra(&argv, stdin, &dir, &[]).await
	}

	#[tokio::test]
	async fn system_returns_status_after_flushing_output() {
		let (code, out, _) = awk(&[r#"BEGIN { printf "a"; r = system("echo b; exit 3"); print "c", r }"#], "").await;
		assert_eq!((code, out.as_str()), (0, "ab\nc 3\n"));
	}

	#[tokio::test]
	async fn print_to_a_pipe_runs_the_command_on_close() {
		let prog = r#"BEGIN { print "z" | "sort"; print "a" | "sort"; r = close("sort"); print "done", r }"#;
		let (code, out, _) = awk(&[prog], "").await;
		assert_eq!((code, out.as_str()), (0, "a\nz\ndone 0\n"));
		let (code, out, _) = awk(&[r#"{ print "x" $0 | "cat" }"#], "1\n2\n").await;
		assert_eq!((code, out.as_str()), (0, "x1\nx2\n"));
	}

	#[tokio::test]
	async fn command_getline_reads_command_output() {
		let prog = r#"BEGIN { "echo hi there" | getline; print $2, NR; "echo a b" | getline v; print v; print close("echo a b") }"#;
		let (code, out, err) = awk(&[prog], "").await;
		assert_eq!((code, err.as_str()), (0, ""));
		assert_eq!(out, "there 1\na b\n0\n");
		let prog = r#"BEGIN { while (("printf '1\\n2\\n3\\n'" | getline n) > 0) s += n; print s }"#;
		assert_eq!(awk(&[prog], "").await.1, "6\n");
	}
}
