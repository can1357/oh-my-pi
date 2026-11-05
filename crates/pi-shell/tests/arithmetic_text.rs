//! Literal stdout, stderr-presence and status goldens recorded with Bash 5.3.0
//! via `bash --noprofile --norc -c`, not a script file. Bash 5.2.21 agrees.
#![cfg(unix)]

use std::time::Duration;

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

async fn run(script: &str, stdout: &str, stderr: bool, status: i32) {
	let dir = tempfile::tempdir().expect("tempdir");
	let (stdout_tx, stdout_rx) = flume::unbounded();
	let (stderr_tx, stderr_rx) = flume::unbounded();
	let result = tokio::time::timeout(
		Duration::from_secs(10),
		execute_shell_streams(
			ShellExecuteOptions {
				command: script.to_string(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(5_000),
				..Default::default()
			},
			StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) },
			CancelToken::new(None),
		),
	)
	.await
	.expect("arithmetic script exceeded its deadline")
	.expect("shell execution");
	let collect = |rx: flume::Receiver<bytes::Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect()).expect("utf-8")
	};
	assert!(!result.timed_out, "{script:?} timed out");
	assert_eq!(collect(stdout_rx), stdout, "{script:?}");
	assert_eq!(!collect(stderr_rx).is_empty(), stderr, "{script:?}");
	assert_eq!(result.exit_code, Some(status), "{script:?}");
}

#[tokio::test]
async fn newline_condition_is_zero_not_an_omitted_condition() {
	// `break` bounds a regression independently of the execution deadline.
	run(
		concat!(
			"echo \"[$((\n))]\"\n",
			"for ((i=0;\n;i++)); do echo unexpected; break; done\n",
			"echo \"newline=$?\"\n",
			"for ((i=0; \t\n \t;i++)); do echo unexpected; break; done\n",
			"echo \"mixed=$?\"\n",
			"for ((;;)); do echo empty; break; done\n",
			"for ((; \t;)); do echo blanks; break; done\n",
			"for ((;\\\n;)); do echo continued; break; done\n",
		),
		"[0]\nnewline=0\nmixed=0\nempty\nblanks\ncontinued\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn non_bash_whitespace_in_for_clauses_reports_an_arithmetic_error() {
	for ch in ['\r', '\u{000b}', '\u{000c}'] {
		let script = format!(
			"for (({ch};0;)); do echo unexpected; break; done\necho init=$?\nfor ((;{ch};)); do echo \
			 unexpected; break; done\necho cond=$?\nfor ((i=0;i++<1;{ch})); do echo body; done\necho \
			 step=$?\n"
		);
		run(&script, "init=1\ncond=1\nbody\nstep=1\n", true, 0).await;
	}
}

#[tokio::test]
async fn non_bash_whitespace_is_not_ignored_by_arithmetic_evaluation() {
	for ch in ['\r', '\u{000b}', '\u{000c}'] {
		let script = format!(
			"(({ch})); echo empty=$?\n((1{ch})); echo number=$?\n((1{ch}+1)); echo \
			 operator=$?\nv='{ch}'; ((v)); echo variable=$?\n"
		);
		run(&script, "empty=1\nnumber=1\noperator=1\nvariable=1\n", true, 0).await;
	}
}

#[tokio::test]
async fn continued_opening_parentheses_still_start_arithmetic() {
	run(
		"for (\\\n(i=0;;i++)); do echo for=$i; break; done\n(\\\n(x=2))\necho x=$x\n",
		"for=0\nx=2\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn parameter_word_semicolons_do_not_split_arithmetic_for_clauses() {
	run(
		concat!(
			"v=0\nfor ((i=${v:-;};0;)); do :; done\necho unused=$?\nunset v\n",
			"for ((i=${v:-0;0};0;)); do echo never; break; done\necho init=$?\n",
			"for ((i=0;${v:-0;1};)); do echo never; break; done\necho cond=$?\n",
			"for ((i=0;0;${v:-;})); do :; done\necho unused_step=$?\n",
		),
		"unused=0\ninit=1\ncond=1\nunused_step=0\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn invalid_arithmetic_lookahead_prevents_unfinished_assignments() {
	run(
		concat!(
			"unset x\n((x=1 #c\n)); echo \"hash=${x-unset}:$?\"\n",
			"((x=1;2)); echo \"semi=${x-unset}:$?\"\n",
			"((x=1 @)); echo \"at=${x-unset}:$?\"\n",
			"x=0; ((x++ #c)); echo \"post=$x:$?\"\n",
			"x=0; ((++x #c)); echo \"pre=$x:$?\"\n",
			"x=0; ((x++ + 1 #c)); echo \"prior=$x:$?\"\n",
			"x=0; ((x=1, x=2 #c)); echo \"comma=$x:$?\"\n",
		),
		"hash=unset:1\nsemi=unset:1\nat=unset:1\npost=1:1\npre=0:1\nprior=1:1\ncomma=1:1\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn arithmetic_for_errors_end_the_loop_not_the_command_list() {
	run(
		concat!(
			"echo \"$(for ((i=0; #c\n;i++)); do echo never; done; echo rc=$?)\"\n",
			"echo before; for (((i=0;j=1);)); do break; done; echo \"after=$?\"\n",
		),
		"rc=1\nbefore\nafter=1\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn malformed_arithmetic_fallback_reports_its_substitution_error() {
	run(
		concat!(
			"v=1; printf \"[%s]\\n\" \"$(( ${v-'('1)} ))\"; echo after\n",
			"echo \"${v-$(( ${v-'('1)} ))}\"; echo lazy\n",
		),
		"[)]\nafter\n1\nlazy\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn bracket_arithmetic_expands_ansi_c_quotes() {
	run(
		"v=1; echo \"$[ ${v+$'('1)} ]\"\necho \"$[ $'1' ]\"\necho after\n",
		"1\n1\nafter\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn arithmetic_parse_errors_in_command_substitutions_use_bash_c_status() {
	run(
		concat!(
			"echo \"$( for ((x=${v:-$(( ${w:?(} ))};0;)); do :; done; echo x=$x )\"\n",
			"echo after\n",
		),
		"",
		true,
		127,
	)
	.await;
}

#[tokio::test]
async fn grouped_conditional_function_definitions_inside_here_documents_do_not_abort() {
	run(
		concat!(
			"cat <<DOC\n$(\nv=1\nf() [[ (( a == @(a) )) ]]\n",
			"printf \"rc=%s\\n\" \"$?\"\n)\nDOC\n",
		),
		"rc=0\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn regexp_groups_count_parentheses_inside_parameter_words() {
	run("v=1\n[[ a =~ (a|(( ${v:-(} ))) ]]\necho rc=$?\n", "", true, 2).await;
	for script in [
		"v=a\n[[ forab =~ for((${v:-(}))) ]]\necho rc=$?\n",
		"v=a\n[[ forab =~ for((${v:-${w:-(}}))) ]]\necho rc=$?\n",
		"v=a\n[[ forab =~ for\\\n((${v:-(}))) ]]\necho rc=$?\n",
		"v=a\n[[ forab =~ for\\\n((${v:-${w:-(}}))) ]]\necho rc=$?\n",
	] {
		run(script, "rc=1\n", false, 0).await;
	}
}

#[tokio::test]
async fn arithmetic_substitutions_use_current_parser_options() {
	run(
		concat!(
			"shopt -s extglob\n",
			"(( x = $(case a in @(a|b)) printf 1;; esac) << 2 ))\n",
			"echo x=$x rc=$?\n",
			"touch one two\n",
			"(( y = $(printf '%s\\n' @(one|two) | wc -l) << 2 ))\n",
			"echo y=$y rc=$?\n",
		),
		"x=4 rc=0\ny=8 rc=0\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn parameter_arithmetic_offsets_end_at_the_parameter_brace() {
	run("v=1; printf \"<%s>\\n\" \"${v:(}\"\necho after\n", "after\n", true, 0).await;
	run(
		"unset v w\nx=0\nprintf \"<%s>\\n\" \"$((x=${v:)(}))\"\nprintf \"after x=%s rc=%s\\n\" \
		 \"$x\" \"$?\"\n",
		"<>\nafter x=0 rc=0\n",
		false,
		0,
	)
	.await;
}

/// Every present/absent combination of an arithmetic `for` header's three
/// sections, including the adjacent-semicolon forms (`for ((i=0;;i++))`,
/// `for ((;;))`). Each header parses as three empty-able clauses rather than
/// a syntax error, an omitted condition is true, and every loop runs the
/// number of times Bash 5.2.21 runs it.
#[tokio::test]
async fn arithmetic_for_header_empty_section_matrix() {
	run(
		concat!(
			// Initialisation, condition and step all present.
			"i=9\nfor ((i=0;i<3;i++)); do echo PPP$i; done\necho PPP=$?\n",
			// Step absent: the body advances the counter.
			"i=9\nfor ((i=0;i<3;)); do echo PPx$i; i=$((i+1)); done\necho PPx=$?\n",
			// Condition absent between adjacent semicolons: true, so `break`
			// is what ends the loop.
			"i=9\nfor ((i=0;;i++)); do echo PxP$i; [ $i -ge 2 ] && break; done\necho PxP=$?\n",
			// Condition and step both absent.
			"i=9\nfor ((i=0;;)); do echo Pxx$i; break; done\necho Pxx=$?\n",
			// Initialisation absent: the counter keeps the value it had.
			"i=0\nfor ((;i<3;i++)); do echo xPP$i; done\necho xPP=$?\n",
			"i=0\nfor ((;i<3;)); do echo xPx$i; i=$((i+1)); done\necho xPx=$?\n",
			"i=0\nfor ((;;i++)); do echo xxP$i; [ $i -ge 2 ] && break; done\necho xxP=$?\n",
			// All three absent.
			"i=0\nfor ((;;)); do echo xxx$i; break; done\necho xxx=$?\n",
		),
		concat!(
			"PPP0\nPPP1\nPPP2\nPPP=0\n",
			"PPx0\nPPx1\nPPx2\nPPx=0\n",
			"PxP0\nPxP1\nPxP2\nPxP=0\n",
			"Pxx0\nPxx=0\n",
			"xPP0\nxPP1\nxPP2\nxPP=0\n",
			"xPx0\nxPx1\nxPx2\nxPx=0\n",
			"xxP0\nxxP1\nxxP2\nxxP=0\n",
			"xxx0\nxxx=0\n",
		),
		false,
		0,
	)
	.await;
}
