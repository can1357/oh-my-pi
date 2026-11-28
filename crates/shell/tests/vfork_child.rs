//! The vfork child of the Linux spawn path (`src/sys/spawn/unix/vfork.rs`,
//! included here as it is) run on its own: under an allocator another thread
//! holds locked, so an allocation or a lock taken by the spawning thread,
//! its launcher or the child before the spawn returns waits for that thread,
//! and with an fd installed onto its own number.

#![cfg(target_os = "linux")]

use std::{
	alloc::{GlobalAlloc, Layout, System},
	ffi::{CString, c_char, c_int},
	fs::File,
	io::Read as _,
	os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd},
	ptr,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

#[path = "../src/sys/spawn/unix/vfork.rs"]
#[allow(dead_code, reason = "the spawner's API this test does not call")]
mod vfork;

/// The allocator lock: `System`'s calls one at a time, and a test thread
/// can hold it ([`Guard`]).
static LOCK: AtomicBool = AtomicBool::new(false);

/// [`LOCK`], held until dropped.
struct Guard;

impl Guard {
	fn lock() -> Self {
		while LOCK
			.compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
			.is_err()
		{
			thread::yield_now();
		}
		Self
	}
}

impl Drop for Guard {
	fn drop(&mut self) {
		LOCK.store(false, Ordering::Release);
	}
}

/// `System` behind [`LOCK`].
struct Locked;

// SAFETY: `System`'s allocator, its calls serialized by the lock.
unsafe impl GlobalAlloc for Locked {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		let _guard = Guard::lock();
		// SAFETY: the caller's layout, as `GlobalAlloc::alloc` requires.
		unsafe { System.alloc(layout) }
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		let _guard = Guard::lock();
		// SAFETY: a block of this allocator with its layout, as the caller
		// guarantees.
		unsafe { System.dealloc(ptr, layout) }
	}
}

#[global_allocator]
static ALLOCATOR: Locked = Locked;

/// How long a spawn may take before the test calls it stuck on the lock.
const STUCK: Duration = Duration::from_secs(10);

/// Run `step` while another thread holds the allocator lock, released once
/// `step` returned or after [`STUCK`]; fails when `step` outlasted it.
fn with_allocator_locked<R>(step: impl FnOnce() -> R) -> R {
	let held = Arc::new(AtomicBool::new(false));
	let done = Arc::new(AtomicBool::new(false));
	let holder = {
		let (held, done) = (Arc::clone(&held), Arc::clone(&done));
		thread::spawn(move || {
			let guard = Guard::lock();
			held.store(true, Ordering::Release);
			let deadline = Instant::now() + STUCK;
			while !done.load(Ordering::Acquire) && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(1));
			}
			let finished = done.load(Ordering::Acquire);
			drop(guard);
			finished
		})
	};
	while !held.load(Ordering::Acquire) {
		thread::yield_now();
	}
	let result = step();
	done.store(true, Ordering::Release);
	assert!(
		holder.join().unwrap(),
		"the spawn waited for the allocator lock: it allocated or took the lock"
	);
	result
}

/// The exit status of our child `pid`, once it exited.
fn exit_status(pid: c_int) -> c_int {
	let mut status = 0;
	// SAFETY: `status` is writable; `pid` is our child.
	assert_eq!(unsafe { libc::waitpid(pid, &raw mut status, 0) }, pid);
	assert!(libc::WIFEXITED(status), "{status:#x}");
	libc::WEXITSTATUS(status)
}

/// A child of `argv` (NULL-terminated) with an empty environment, cwd `/`,
/// nothing else set up.
fn plain<'a>(argv: &'a [*const c_char], envp: &'a [*const c_char]) -> vfork::Child<'a> {
	vfork::Child {
		path:    argv[0],
		argv:    argv.as_ptr(),
		envp:    envp.as_ptr(),
		cwd:     c"/".as_ptr(),
		session: false,
		group:   None,
		tty:     None,
		umask:   0o022,
		fds:     &[],
		closed:  &[],
		ignored: 0,
		limits:  &[],
	}
}

/// Failure mode: the spawning thread, its launcher, the clone, the child's
/// setup or the report of the child's exit or failure allocates or takes a
/// lock. In the host that waits on whatever thread holds the allocator's
/// lock while the spawning thread cannot go on, and a lock the child takes
/// is the host's (a deadlock, or a heap changed under the host). Every step
/// runs here, the exec succeeding, then failing.
#[test]
fn spawns_neither_allocate_nor_lock() {
	let null = File::open("/dev/null").unwrap();
	let fds = [(0, null.as_raw_fd()), (1, null.as_raw_fd())];
	let closed = [2];
	let limits = [(libc::RLIMIT_CORE, libc::rlimit { rlim_cur: 0, rlim_max: 0 })];
	let envp = [ptr::null()];
	// The launcher's start allocates: before the lock.
	vfork::prepare().unwrap();
	for (program, expected) in [(c"/bin/sh", Ok(7)), (c"/nonexistent/program", Err(libc::ENOENT))] {
		let argv = [program.as_ptr(), c"-c".as_ptr(), c"exit 7".as_ptr(), ptr::null()];
		let child = vfork::Child {
			session: true,
			umask: 0o077,
			fds: &fds,
			closed: &closed,
			ignored: 1 << (libc::SIGPIPE - 1),
			limits: &limits,
			..plain(&argv, &envp)
		};
		// SAFETY: `child`'s strings and arrays outlive the spawn.
		let spawned = with_allocator_locked(|| unsafe { vfork::spawn(&child) });
		let got = spawned.map(exit_status).map_err(|failure| failure.errno());
		assert_eq!(got, expected, "{program:?}");
	}
}

/// Failure mode: an fd installed onto its own number keeps its close-on-exec
/// flag, so the program never gets it (`posix_spawn_file_actions_adddup2`
/// clears it), or the child's change reaches the caller's fd table.
#[test]
fn an_fd_installed_onto_itself_reaches_the_program() {
	let mut ends = [0; 2];
	// SAFETY: `ends` is a writable array of two descriptors.
	assert_eq!(unsafe { libc::pipe2(ends.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
	let [read, write] = ends;
	// SAFETY: a successful pipe2 returned two descriptors we own.
	let (read, write_end) = unsafe { (File::from_raw_fd(read), OwnedFd::from_raw_fd(write)) };
	let script = CString::new(format!("echo through >&{write}")).unwrap();
	let argv = [c"/bin/sh".as_ptr(), c"-c".as_ptr(), script.as_ptr(), ptr::null()];
	let envp = [ptr::null()];
	let fds = [(write, write)];
	let child = vfork::Child { fds: &fds, ..plain(&argv, &envp) };
	// SAFETY: `child`'s strings and arrays outlive the spawn.
	let pid = unsafe { vfork::spawn(&child) }.unwrap();
	assert_eq!(exit_status(pid), 0);
	// SAFETY: fcntl on a descriptor we own, without pointer arguments.
	let flags = unsafe { libc::fcntl(write, libc::F_GETFD) };
	assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC, "the caller's fd changed");
	drop(write_end);
	let mut said = String::new();
	(&read).read_to_string(&mut said).unwrap();
	assert_eq!(said, "through\n");
}
