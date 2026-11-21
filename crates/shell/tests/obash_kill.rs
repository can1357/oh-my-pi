//! Native-host process signaling through the `kill` builtin.

#![cfg(unix)]

mod obash_support;

use std::os::unix::process::ExitStatusExt;

#[test]
fn kill_sends_signal_to_real_process() {
	let mut child = obash_support::command("/bin/sleep")
		.arg("60")
		.spawn()
		.unwrap();
	let script = format!("kill -0 {0}; kill -TERM {0}", child.id());
	let result = obash_support::output(obash_support::obash().args(["-c", &script]));
	if !result.status.success() {
		obash_support::kill_all(&mut child);
		let _ = child.wait();
		panic!("{}", String::from_utf8_lossy(&result.stderr));
	}
	let sleep = obash_support::finish(child, obash_support::LIMIT);
	assert_eq!(sleep.status.signal(), Some(libc::SIGTERM));
}
