//! The cut keeps upstream's signal range and recipient decisions. Real
//! observers distinguish native delivery from a virtual shell's wait status.
#![cfg(target_os = "linux")]

use std::{fs, process::Command};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

async fn assert_cut_row(start: &str, signal: &str, target: &str, expected: &str, roles: &[&str]) {
	let scratch = tempfile::tempdir().unwrap();
	let observer = scratch.path().join("signal-recipient");
	let compiled = Command::new("cc")
		.args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2"])
		.arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/signal-recipient.c"))
		.arg("-o")
		.arg(&observer)
		.output()
		.expect("compile signal observer");
	assert!(compiled.status.success(), "{}", String::from_utf8_lossy(&compiled.stderr));
	let ready = roles
		.iter()
		.map(|role| format!("[ -s \"$d/{role}-ready\" ]"))
		.collect::<Vec<_>>()
		.join(" && ");
	let events = roles
		.iter()
		.map(|role| format!("[ -s \"$d/{role}-events\" ]"))
		.collect::<Vec<_>>()
		.join(" && ");
	let command = format!(
		r#"exec 2>/dev/null
observer='{}'
d='{}'
{start}
p=$!
until {ready}; do /bin/sleep .01; done
kill {signal} {target}
printf 'kill=%s\n' "$?"
: > "$d/release"
wait "$p"
printf 'wait=%s\n' "$?"
until {events}; do /bin/sleep .01; done
"#,
		observer.display(),
		scratch.path().display(),
	);
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command, ..Default::default() },
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("run cut row");
	let mut output: String = rx.drain().collect();
	for role in roles {
		output.push_str(&format!("{role}: "));
		output.push_str(&fs::read_to_string(scratch.path().join(format!("{role}-events"))).unwrap());
	}
	assert_eq!((result.exit_code, output.as_str()), (Some(0), expected));
}

#[tokio::test(flavor = "multi_thread")]
async fn nested_parentheses_keep_upstreams_job_recipient() {
	assert_cut_row(
		"set -m; ( ( \"$observer\" \"$d\" right ) ) &",
		"-TERM",
		"%1",
		"kill=0\nwait=0\nright: 15=1 32=0 33=0 34=0 wrong=0\n",
		&["right"],
	)
	.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unsupported_numeric_signal_sends_no_term() {
	assert_cut_row(
		"set -m; f(){ \"$observer\" \"$d\" right; }; ( f ) &",
		"-32",
		"%1",
		"kill=1\nwait=0\nright: 15=0 32=0 33=0 34=0 wrong=0\n",
		&["right"],
	)
	.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lastpipe_keeps_upstreams_native_recipient_and_status() {
	assert_cut_row(
		"shopt -s lastpipe; set +m; \"$observer\" \"$d\" left | \"$observer\" \"$d\" right &",
		"-TERM",
		"\"$p\"",
		"kill=0\nwait=143\nleft: 15=0 32=0 33=0 34=0 wrong=0\nright: 15=1 32=0 33=0 34=0 wrong=0\n",
		&["left", "right"],
	)
	.await;
}
