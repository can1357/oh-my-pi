//! zsh/datetime (port of zsh 5.9 `Src/Modules/datetime.c` and `ztrftime`)
//! and zsh/langinfo. Expected output comes from `/bin/zsh -f -c` 5.9 (BSD
//! libc, `TZ=UTC`).

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// `strftime` after `zmodload zsh/datetime; TZ=UTC`.
fn dt(src: &str) -> (String, String, i32) {
	zsh(&format!("zmodload zsh/datetime; TZ=UTC; {src}"))
}

#[test]
fn strftime_zsh_and_c_conversions() {
	let (out, err, st) = dt(
		r#"strftime "%Y-%m-%d %H:%M:%S %N %. %3. %6. %-3. %f %K %L %e %k %l %-d %-m %-H %-M %-S %-y %y %a %b %p %Z %z %j %s" 1700000005 123456789"#,
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"2023-11-14 22:13:25 123456789 123 123 123457 123 14 22 10 14 22 10 14 11 22 13 25 23 23 \
		 Tue Nov PM UTC +0000 318 1700000005\n"
	);
	assert_eq!(st, 0);
	let (out, ..) = dt(r#"strftime "%5d|%-5d|%Ey|%_H|%010N|%9.|%12.|%0.|%%|%" 86400 999999999"#);
	assert_eq!(out, "5d|5d|70| 0|10N|999999999|999999999||%|%\n");
}

#[test]
fn strftime_libc_conversions() {
	let (out, ..) = dt("for f in %x %X %c %D %F %R %r %T %v %+ %P %G %g %V %U %W %u %w %C %h %A \
	                    %B %j %-j %_j %0e %-Y %_y %Ok %^a %s %I %-e; do print -rn -- \"$(strftime \
	                    $f 1700000005)|$(strftime $f 1609459200) \"; done");
	assert_eq!(
		out,
		"11/14/23|01/01/21 22:13:25|00:00:00 Tue Nov 14 22:13:25 2023|Fri Jan  1 00:00:00 2021 \
		 11/14/23|01/01/21 2023-11-14|2021-01-01 22:13|00:00 10:13:25 PM|12:00:00 AM \
		 22:13:25|00:00:00 14-Nov-2023| 1-Jan-2021 Tue Nov 14 22:13:25 UTC 2023|Fri Jan  1 00:00:00 \
		 UTC 2021 P|P 2023|2020 23|20 46|53 46|00 46|00 2|5 2|5 20|20 Nov|Jan Tuesday|Friday \
		 November|January 318|001 318|1 318|  1 14|01 2023|2021 23|21 22| 0 ^a|^a \
		 1700000005|1609459200 10|12 14|1 "
	);
}

#[test]
#[cfg_attr(
	not(target_os = "macos"),
	ignore = "expects macOS `%x` and an installed en_US.UTF-8 locale"
)]
fn strftime_options() {
	let (out, ..) = dt("strftime -s v '%s' 5; print -r $v; strftime -n x 0; echo .");
	assert_eq!(out, "5\nx.\n");
	let (out, ..) = dt("strftime x -1; strftime x ' 5'");
	assert_eq!(out, "x\nx\n");
	let (out, ..) = dt("strftime %x 1200000000; LC_TIME=en_US.UTF-8; strftime %x 1200000000; \
	                    strftime -r %x 01/10/2008");
	assert_eq!(out, "01/10/08\n01/10/2008\n1199923200\n");
}

#[test]
fn strftime_errors() {
	for (args, msg) in [
		("x abc", "zsh:strftime:1: abc: invalid argument\n"),
		("x ''", "zsh:strftime:1: : invalid argument\n"),
		("x 99999999999999999999", "zsh:strftime:1: 99999999999999999999: result too large\n"),
		("x 1 1000000000", "zsh:strftime:1: 1000000000: invalid nanosecond value\n"),
		("x 1 -1", "zsh:strftime:1: -1: invalid nanosecond value\n"),
		("x 1 1x", "zsh:strftime:1: 1x: invalid decimal number\n"),
		("x 5x", "zsh:strftime:1: 5x: invalid decimal number\n"),
		("x 67768036191676800", "zsh:strftime:1: 67768036191676800: unable to convert to time\n"),
		("-s 1a x", "zsh:strftime:1: not an identifier: 1a\n"),
		("-r %Y", "zsh:strftime:1: timestring expected\n"),
		("", "zsh:strftime:1: not enough arguments\n"),
		("a b c d", "zsh:strftime:1: too many arguments\n"),
		("-r '%Y-%m-%d' junk", "zsh:strftime:1: format not matched\n"),
	] {
		let (out, err, st) = dt(&format!("strftime {args}"));
		assert_eq!((out.as_str(), err.as_str(), st), ("", msg, 1), "{args}");
	}
	let (out, err, st) = dt("strftime -qr '%Y-%m-%d' junk");
	assert_eq!((out.as_str(), err.as_str(), st), ("", "", 1));
}

#[test]
fn strftime_reverse() {
	let (out, err, st) =
		dt("strftime -r '%Y-%m-%d' 2023-11-14; strftime -qr '%Y-%m-%d' 2023-11-14xx; strftime -r \
		    '%Y %j' '2023 100'; strftime -r '%d %b %Y' '5 MARCH 2020'; strftime -r \
		    '%Y-%m-%dT%H:%M:%S%z' 2020-03-05T10:00:00+0130; strftime -r '%Y %Z' '2020 GMT'; \
		    strftime -r '%Y %U %a' '2020 10 Mon'; strftime -r %y 68; strftime -r %y 69; strftime \
		    -r '%I %p' '11 pm'; strftime -r '%D %T' '03/05/20 01:02:03'; strftime -r %c 'Thu Mar  \
		    5 10:00:00 2020'; strftime -r '%Y-%m-%d' 2020-02-31; strftime -r '%C%y' 1999; strftime \
		    -r %Y 1899; strftime -r %s -5; strftime -r '%Y %W %a' '2020 0 Sun'");
	assert_eq!(err, "");
	assert_eq!(
		out,
		concat!(
			"1699920000\n",
			"1699920000\n",
			"1681084800\n",
			"1583366400\n",
			"1583397000\n",
			"1577836800\n",
			"1583712000\n",
			"3092601600\n",
			"-31536000\n",
			"-2208906000\n",
			"1583370123\n",
			"1583402400\n",
			"1583107200\n",
			"915148800\n",
			"-1\n",
			"-5\n",
			"1578182400\n",
		)
	);
	assert_eq!(st, 0);
	let (out, err, _) = dt("strftime -r '%Y-%m-%d' 2023-11-14xx; strftime -r %Y 123456");
	assert_eq!(out, "1699920000\n-1\n");
	assert_eq!(
		err,
		"zsh:strftime:1: warning: input string not completely matched\nzsh:strftime:1: warning: \
		 input string not completely matched\n"
	);
	let (out, ..) = dt("strftime -s v -r '%H:%M' 10:30; print $v; typeset -p v");
	assert_eq!(out, "-2208951000\ntypeset -i v=-2208951000\n");
	let (_, err, _) =
		dt("strftime -r '%Y %U' '2020 0'; strftime -r %z +01; strftime -r '%Y %Z' '2020 EST'");
	assert_eq!(err, "zsh:strftime:1: format not matched\n".repeat(3));
}

#[test]
fn datetime_parameters() {
	let (out, err, _) = zsh(
		"print ${+EPOCHSECONDS}; zmodload zsh/datetime; (( EPOCHSECONDS >= 1700000000 )) && print \
		 ok; (( EPOCHREALTIME >= 1700000000 )) && print ok; print ${#epochtime}; print \
		 ${(t)EPOCHREALTIME} ${(t)EPOCHSECONDS} ${(t)epochtime}; typeset -p EPOCHSECONDS \
		 EPOCHREALTIME epochtime",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"0\nok\nok\n2\nfloat-readonly-hide-hideval-special integer-readonly-hide-hideval-special \
		 array-readonly-hide-hideval-special\ntypeset -ir EPOCHSECONDS\ntypeset -Fr \
		 EPOCHREALTIME\ntypeset -ar epochtime\n"
	);
	let (_, err, st) = zsh("zmodload zsh/datetime; EPOCHSECONDS=3");
	assert_eq!((err.as_str(), st), ("zsh:1: read-only variable: EPOCHSECONDS\n", 1));
}

#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "C-locale `nl_langinfo` values are macOS libc's")]
fn langinfo_in_the_c_locale() {
	let (out, err, _) = zsh(
		"LC_ALL=C; zmodload zsh/langinfo; for k in ${(k)langinfo}; do print -rn -- \
		 \"$k=${langinfo[$k]};\"; done; print; print ${(t)langinfo}; print -r -- $langinfo[nope]x",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		concat!(
			"CODESET=US-ASCII;D_T_FMT=%a %b %e %H:%M:%S %Y;D_FMT=%m/%d/%y;T_FMT=%H:%M:%S;",
			"RADIXCHAR=.;THOUSEP=;YESEXPR=^[yY];NOEXPR=^[nN];CRNCYSTR=;ABDAY_1=Sun;ABDAY_2=Mon;",
			"ABDAY_3=Tue;ABDAY_4=Wed;ABDAY_5=Thu;ABDAY_6=Fri;ABDAY_7=Sat;DAY_1=Sunday;",
			"DAY_2=Monday;DAY_3=Tuesday;DAY_4=Wednesday;DAY_5=Thursday;DAY_6=Friday;",
			"DAY_7=Saturday;ABMON_1=Jan;ABMON_2=Feb;ABMON_3=Mar;ABMON_4=Apr;ABMON_5=May;",
			"ABMON_6=Jun;ABMON_7=Jul;ABMON_8=Aug;ABMON_9=Sep;ABMON_10=Oct;ABMON_11=Nov;",
			"ABMON_12=Dec;MON_1=January;MON_2=February;MON_3=March;MON_4=April;MON_5=May;",
			"MON_6=June;MON_7=July;MON_8=August;MON_9=September;MON_10=October;MON_11=November;",
			"MON_12=December;T_FMT_AMPM=%I:%M:%S %p;AM_STR=AM;PM_STR=PM;ERA=;ERA_D_FMT=;",
			"ERA_D_T_FMT=;ERA_T_FMT=;ALT_DIGITS=;\n",
			"association-hide-hideval-special\n",
			"x\n",
		)
	);
	let (out, ..) = zsh(
		"zmodload zsh/langinfo; LC_ALL=en_US.UTF-8; print -r -- $langinfo[CODESET] $langinfo[D_FMT] \
		 $langinfo[THOUSEP]; LC_ALL=; LANG=C; LC_CTYPE=en_US.UTF-8; print -r -- $langinfo[CODESET] \
		 $langinfo[THOUSEP]x",
	);
	assert_eq!(out, "UTF-8 %m/%d/%Y ,\nUTF-8 x\n");
}
