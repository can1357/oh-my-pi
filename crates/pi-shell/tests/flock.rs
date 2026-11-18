//! `flock` in the shell: its descriptor form locks the shell's own open
//! files, its command runs in a subshell of the caller under the lock, and a
//! wait for a held lock ends with the run. Expected statuses and messages are
//! util-linux 2.42's.
#![cfg(unix)]

use std::{
	collections::HashMap,
	fs::File,
	path::Path,
	time::{Duration, Instant},
};

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

/// Runs `script` in a fresh shell in `dir`, returning its exit status and
/// everything it wrote. `timeout_ms` cancels the run.
async fn run_for(dir: &Path, script: &str, timeout_ms: u32) -> (Option<i32>, bool, String) {
	let shell = Shell::new(Some(ShellOptions {
		session_env: Some(HashMap::from([("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into())])),
		..Default::default()
	}));
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.to_string_lossy().into_owned()),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(timeout_ms)),
		)
		.await
		.expect("shell execution");
	(result.exit_code, result.timed_out, rx.drain().collect())
}

/// [`run_for`] for a script that ends on its own.
async fn run(dir: &Path, script: &str) -> (Option<i32>, String) {
	let (status, timed_out, output) = run_for(dir, script, 30_000).await;
	assert!(!timed_out, "`{script}` did not end: {output:?}");
	(status, output)
}

/// Contract: `flock N` locks the file the shell has open on descriptor N,
/// the shell keeps the lock afterwards, and `-u` or closing the descriptor
/// drops it.
#[tokio::test(flavor = "multi_thread")]
async fn descriptor_form_locks_the_shells_own_file() {
	let dir = tempfile::tempdir().expect("tempdir");
	let script = r#"
exec 9>lock
flock -n 9; echo "first $?"
flock -n lock true; echo "contender $?"
flock -n -s lock true; echo "shared contender $?"
flock -s 9; echo "converted $?"
flock -n -s lock true; echo "shared with shared $?"
flock -u 9; echo "unlock $?"
flock -n lock true; echo "after unlock $?"
flock 9
exec 9>&-
flock -n lock true; echo "after close $?"
flock 9 2>err; echo "closed $?"
cat err
"#;
	let (status, output) = run(dir.path(), script).await;
	assert_eq!(
		output,
		"first 0\ncontender 1\nshared contender 1\nconverted 0\nshared with shared 0\nunlock \
		 0\nafter unlock 0\nafter close 0\nclosed 65\nflock: 9: Bad file descriptor\n"
	);
	assert_eq!(status, Some(0));
}

/// The man page's idiom, and bash's allocated descriptors.
#[tokio::test(flavor = "multi_thread")]
async fn descriptor_form_in_a_subshell_and_through_a_variable() {
	let dir = tempfile::tempdir().expect("tempdir");
	let script = r#"
(
  flock -n 9 || exit 1
  echo inside
  flock -n lock true; echo "nested $?"
  ( flock -n 9 || exit 1; echo "same file $?" )
) 9>lock
echo "subshell $?"
flock -n lock true; echo "released $?"
exec {held}>named
flock -x "$held"; echo "named $?"
flock -n -E 4 named true; echo "contender $?"
flock --fd "$held" -c 'echo wrapped'; echo "wrap $?"
"#;
	let (_, output) = run(dir.path(), script).await;
	assert_eq!(
		output,
		"inside\nnested 1\nsame file 0\nsubshell 0\nreleased 0\nnamed 0\ncontender 4\nwrapped\nwrap \
		 0\n"
	);
}

/// Contract: while one `flock` runs its command, another on the same file
/// fails with `-n`, times out with `-w`, and otherwise waits its turn.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_invocations_contend() {
	let dir = tempfile::tempdir().expect("tempdir");
	let script = r#"
flock lock -c 'touch held; until [ -e release ]; do sleep 0.01; done; echo first >> order' &
until [ -e held ]; do sleep 0.01; done
flock -n lock true; echo "nonblocking $?"
flock -n -E 7 lock true; echo "conflict code $?"
flock -w 0.05 lock true; echo "timed out $?"
flock -s -w 0.05 -E 9 lock true; echo "shared timed out $?"
flock lock -c 'echo second >> order' &
waiter=$!
sleep 0.1
touch release
wait "$waiter"; echo "waited $?"
wait
cat order
flock -s lock -c 'touch reading; until [ -e finish ]; do sleep 0.01; done' &
until [ -e reading ]; do sleep 0.01; done
flock -s -n lock true; echo "shared together $?"
flock -x -n lock true; echo "exclusive against shared $?"
touch finish
wait
flock -x -n lock true; echo "exclusive after shared $?"
"#;
	let (_, output) = run(dir.path(), script).await;
	assert_eq!(
		output,
		"nonblocking 1\nconflict code 7\ntimed out 1\nshared timed out 9\nwaited \
		 0\nfirst\nsecond\nshared together 0\nexclusive against shared 1\nexclusive after shared 0\n"
	);
}

/// Contract: the command's status is `flock`'s; one that cannot be run is
/// status 69 in util-linux's words.
#[tokio::test(flavor = "multi_thread")]
async fn command_status_propagates() {
	let dir = tempfile::tempdir().expect("tempdir");
	let script = r#"
flock lock -c 'exit 5'; echo "line $?"
flock lock false; echo "builtin $?"
flock lock /bin/sh -c 'exit 3'; echo "external $?"
flock lock /bin/sh -c 'kill -TERM $$'; echo "signal $?"
flock lock -- /bin/sh -c 'exit 6'; echo "separator $?"
flock lock no-such-command-flock 2>err; echo "missing $?"
cat err
flock --verbose lock echo done | sed 's/took [0-9.]*/took N/'
"#;
	let (_, output) = run(dir.path(), script).await;
	assert_eq!(
		output,
		"line 5\nbuiltin 1\nexternal 3\nsignal 143\nseparator 6\nmissing 69\nflock: failed to execute \
		 no-such-command-flock: No such file or directory\nflock: getting lock took N \
		 seconds\nflock: executing echo\ndone\n"
	);
}

/// Contract: cancelling the run ends a `flock` that waits for a lock, and
/// the cancelled `flock` neither took the lock nor ran its command.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_run_stops_waiting_for_the_lock() {
	let dir = tempfile::tempdir().expect("tempdir");
	let holder = File::create(dir.path().join("lock")).expect("lock file");
	holder.try_lock().expect("hold the lock");

	let started = Instant::now();
	let (status, timed_out, output) = run_for(dir.path(), "flock lock echo ran; echo after", 300).await;
	let elapsed = started.elapsed();
	assert!(elapsed < Duration::from_secs(5), "the wait took {elapsed:?}");
	assert_eq!((status, timed_out), (None, true));
	assert!(!output.contains("ran") && !output.contains("after"), "{output:?}");

	drop(holder);
	let (_, output) = run(dir.path(), "flock -n lock echo free").await;
	assert_eq!(output, "free\n");
}
