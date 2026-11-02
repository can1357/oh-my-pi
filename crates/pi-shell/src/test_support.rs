//! Helpers for tests that need a pid recycled on purpose: a private pid
//! namespace to run in, and a way to hand a freed pid to a new process.

use std::{os::unix::process::CommandExt as _, path::Path, process, thread, time::Duration};

/// The variable naming the test whose body runs in the private pid namespace
/// [`in_private_pid_namespace`] re-runs it in.
const PID_NAMESPACE_TEST: &str = "PI_SHELL_PID_NAMESPACE_TEST";

/// Whether the test `name` in `module` (its `module_path!()`) runs its body
/// now. Outside a namespace this re-runs that test of this binary as the first
/// process of a private pid namespace, checks that the re-run passed, and
/// returns false; in the re-run it returns true.
///
/// In its own pid namespace a test can make the kernel give a freed pid to a
/// process it starts ([`recycle_pid`]), as an unrelated program taking a
/// recycled pid would. The namespace comes from an unprivileged user
/// namespace, else from `sudo -n`; with neither, the test is skipped and
/// prints why.
pub fn in_private_pid_namespace(module: &str, name: &str) -> bool {
	if std::env::var(PID_NAMESPACE_TEST).as_deref() == Ok(name) {
		assert_eq!(process::id(), 1, "{name} must run as its namespace's first process");
		// The re-run is in a process group outside the namespace, which it
		// cannot name; lead one of its own, as a host does.
		// SAFETY: `setsid` takes no arguments and only changes this process.
		assert!(unsafe { libc::setsid() } > 0, "setsid: {}", std::io::Error::last_os_error());
		return true;
	}
	let wrappers: [&[&str]; 2] =
		[&["unshare", "-Urpf", "--mount-proc"], &["sudo", "-n", "unshare", "-pf", "--mount-proc"]];
	let works = |wrapper: &[&str]| {
		process::Command::new(wrapper[0])
			.args(&wrapper[1..])
			.arg("/bin/true")
			.stderr(process::Stdio::null())
			.status()
			.is_ok_and(|status| status.success())
	};
	let Some(wrapper) = wrappers.into_iter().find(|wrapper| works(wrapper)) else {
		eprintln!(
			"skipped {name}: it needs a private pid namespace, and neither unprivileged user \
			 namespaces (`unshare -Urpf`) nor `sudo -n unshare` are available"
		);
		return false;
	};
	let (_, module) = module
		.split_once("::")
		.expect("module path below the crate");
	let output = process::Command::new(wrapper[0])
		.args(&wrapper[1..])
		.arg("env")
		.arg(format!("{PID_NAMESPACE_TEST}={name}"))
		.arg(std::env::current_exe().expect("test binary path"))
		.args(["--exact", &format!("{module}::{name}"), "--nocapture"])
		.output()
		.expect("re-run the test in a pid namespace");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains("test result: ok. 1 passed"),
		"{name} in a private pid namespace ({}): {}\n{stdout}\n{}",
		wrapper.join(" "),
		output.status,
		String::from_utf8_lossy(&output.stderr),
	);
	false
}

/// Hands `pid`, freed by a process that exited, to a new `/bin/sleep` leading
/// a process group of its own: an unrelated program that took the recycled
/// pid, and with it the number of the group the exited process led. Waits for
/// the pid to leave the process table first. `None` when another process took
/// the pid first. Needs the private pid namespace of
/// [`in_private_pid_namespace`].
pub fn recycle_pid(pid: i32) -> Option<process::Child> {
	let deadline = std::time::Instant::now() + Duration::from_secs(5);
	while Path::new(&format!("/proc/{pid}")).exists() {
		assert!(std::time::Instant::now() < deadline, "pid {pid} was never freed");
		thread::sleep(Duration::from_millis(5));
	}
	std::fs::write("/proc/sys/kernel/ns_last_pid", (pid - 1).to_string())
		.expect("set the namespace's last pid");
	let mut sleeper = process::Command::new("/bin/sleep")
		.arg("600")
		.process_group(0)
		.spawn()
		.expect("start the unrelated process");
	if i32::try_from(sleeper.id()) == Ok(pid) {
		return Some(sleeper);
	}
	let _ = sleeper.kill();
	let _ = sleeper.wait();
	None
}

/// How `process`, which the test started and nothing may signal, ended, or
/// `None` while it runs, after a late signal had time to land: a process sent
/// SIGKILL still runs for a moment after `kill(2)` returns. Ends it.
pub async fn how_it_ended(process: &mut process::Child) -> Option<process::ExitStatus> {
	tokio::time::sleep(Duration::from_millis(300)).await;
	let ended = process.try_wait().expect("poll the unrelated process");
	let _ = process.kill();
	let _ = process.wait();
	ended
}
