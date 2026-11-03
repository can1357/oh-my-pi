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

/// The variable naming the test whose body runs with Linux 6.9's
/// `PIDFD_SIGNAL_PROCESS_GROUP` refused, as kernels 5.3 to 6.8 refuse it.
const OLD_KERNEL_TEST: &str = "PI_SHELL_OLD_KERNEL_TEST";

/// Whether the test `name` in `module` runs its body now. Otherwise this
/// re-runs that test of this binary under a seccomp filter that makes
/// `pidfd_send_signal(..., PIDFD_SIGNAL_PROCESS_GROUP)` fail with `EINVAL`,
/// checks that the re-run passed, and returns false. The filter is inherited
/// by every thread and child the re-run starts, so the shell's cancellation
/// path sees what an older kernel returns.
pub fn without_kernel_group_signal(module: &str, name: &str) -> bool {
	if std::env::var(OLD_KERNEL_TEST).as_deref() == Ok(name) {
		refuse_kernel_group_signal();
		return true;
	}
	let (_, module) = module
		.split_once("::")
		.expect("module path below the crate");
	let output = process::Command::new(std::env::current_exe().expect("test binary path"))
		.args(["--exact", &format!("{module}::{name}"), "--nocapture"])
		.env(OLD_KERNEL_TEST, name)
		.output()
		.expect("re-run the test without kernel group signals");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains("test result: ok. 1 passed"),
		"{name} without PIDFD_SIGNAL_PROCESS_GROUP: {}\n{stdout}\n{}",
		output.status,
		String::from_utf8_lossy(&output.stderr),
	);
	false
}

/// Installs the seccomp filter for [`without_kernel_group_signal`].
fn refuse_kernel_group_signal() {
	const PIDFD_SIGNAL_PROCESS_GROUP: u32 = 1 << 2;
	const ARGUMENT_3: u32 = 16 + 3 * 8;
	let mut filter = [
		libc::sock_filter {
			code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
			jt:   0,
			jf:   0,
			k:    0,
		},
		libc::sock_filter {
			code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
			jt:   0,
			jf:   3,
			k:    libc::SYS_pidfd_send_signal as u32,
		},
		libc::sock_filter {
			code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
			jt:   0,
			jf:   0,
			k:    ARGUMENT_3,
		},
		libc::sock_filter {
			code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
			jt:   0,
			jf:   1,
			k:    PIDFD_SIGNAL_PROCESS_GROUP,
		},
		libc::sock_filter {
			code: (libc::BPF_RET | libc::BPF_K) as u16,
			jt:   0,
			jf:   0,
			k:    libc::SECCOMP_RET_ERRNO | libc::EINVAL as u32,
		},
		libc::sock_filter {
			code: (libc::BPF_RET | libc::BPF_K) as u16,
			jt:   0,
			jf:   0,
			k:    libc::SECCOMP_RET_ALLOW,
		},
	];
	let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
	// SAFETY: prctl takes scalar arguments. seccomp(2) reads the filter
	// program, valid for the duration of the call; TSYNC applies it to every
	// thread of this process, including the test runtime's workers, which
	// already exist when the test body runs.
	unsafe {
		assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0, "no_new_privs");
		assert_eq!(
			libc::syscall(
				libc::SYS_seccomp,
				libc::SECCOMP_SET_MODE_FILTER,
				libc::SECCOMP_FILTER_FLAG_TSYNC,
				&raw const program,
			),
			0,
			"install seccomp filter: {}",
			std::io::Error::last_os_error(),
		);
	}
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
	eprintln!("recycle_pid: wanted pid {pid}, the new process got {}", sleeper.id());
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
