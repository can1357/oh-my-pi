//! Cancellation and exclusive task/operation ownership of desktop mutations.
//!
//! Explicit control keeps the kernel lease between operations. Revocation
//! stops fresh work immediately, but an in-flight operation retains ownership
//! until its held input and focus have been restored.
use std::{
	cell::{Cell, RefCell},
	marker::PhantomData,
	rc::Rc,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};

use super::error::{CoreResult, DesktopError};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
pub(crate) use macos::SYNTHETIC_EVENT_TAG;

#[derive(Default)]
struct CancellationState {
	generation: AtomicU64,
	state:      Mutex<Option<Arc<ControlLease>>>,
	wake:       Condvar,
	#[cfg(target_os = "linux")]
	async_wake: tokio::sync::Notify,
}

#[derive(Clone, Default)]
pub(crate) struct CancellationSource(Arc<CancellationState>);

impl CancellationSource {
	pub(crate) fn token(&self) -> OperationToken {
		OperationToken {
			source:     self.clone(),
			generation: self.0.generation.load(Ordering::Acquire),
		}
	}

	/// Ends a successful run without surrendering an explicitly granted task
	/// lease.
	pub(crate) fn retire(&self) {
		let _state = self.0.state.lock();
		self.0.generation.fetch_add(1, Ordering::AcqRel);
		self.0.wake.notify_all();
		#[cfg(target_os = "linux")]
		self.0.async_wake.notify_waiters();
	}

	/// Aborts current/queued work and revokes any explicit task ownership.
	pub(crate) fn cancel(&self) {
		let lease = {
			let mut state = self.0.state.lock();
			self.0.generation.fetch_add(1, Ordering::AcqRel);
			self.0.wake.notify_all();
			#[cfg(target_os = "linux")]
			self.0.async_wake.notify_waiters();
			state.take()
		};
		drop(lease);
	}

	pub(crate) fn acquire_control(&self, token: &OperationToken) -> CoreResult<()> {
		let mut state = self.0.state.lock();
		token.check()?;
		if !Arc::ptr_eq(&self.0, &token.source.0) {
			return Err(busy());
		}
		if state.is_none() {
			*state = Some(Arc::new(ControlLease::acquire(self)?));
		}
		Ok(())
	}

	pub(crate) fn release_control(&self) {
		// A release is also a generation boundary: queued work authorized by the
		// relinquished grant must never execute under a later acquisition.
		self.cancel();
	}

	pub(crate) fn control_active(&self) -> bool {
		self.0.state.lock().is_some()
	}
}

/// Weak callback ownership avoids a lease -> monitor -> source -> lease cycle.
#[derive(Clone)]
pub(super) struct EmergencyStop(Weak<CancellationState>);

impl EmergencyStop {
	fn cancel(&self) {
		if let Some(source) = self.0.upgrade() {
			CancellationSource(source).cancel();
		}
	}
}

#[derive(Clone)]
pub(crate) struct OperationToken {
	source:     CancellationSource,
	generation: u64,
}

impl OperationToken {
	pub(crate) fn control_active(&self) -> bool {
		self.source.control_active()
	}

	pub(crate) fn enter(&self) -> OperationScope {
		let previous = CURRENT.with_borrow_mut(|current| current.replace(self.clone()));
		OperationScope { previous, _thread: PhantomData }
	}

	pub(crate) fn check(&self) -> CoreResult<()> {
		if self.source.0.generation.load(Ordering::Acquire) == self.generation {
			Ok(())
		} else {
			Err(DesktopError::cancelled(
				"desktop operation cancelled; input may be partial; inspect before retrying",
			))
		}
	}

	#[cfg(target_os = "linux")]
	pub(crate) async fn cancelled(&self) -> DesktopError {
		loop {
			let notified = self.source.0.async_wake.notified();
			let mut notified = std::pin::pin!(notified);
			notified.as_mut().enable();
			if let Err(error) = self.check() {
				return error;
			}
			notified.await;
		}
	}

	pub(crate) fn wait(&self, duration: Duration) -> CoreResult<()> {
		let deadline = Instant::now() + duration;
		let mut state = self.source.0.state.lock();
		loop {
			self.check()?;
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(());
			}
			self.source.0.wake.wait_for(&mut state, remaining);
		}
	}
}

thread_local! {
	static CURRENT: RefCell<Option<OperationToken>> = const { RefCell::new(None) };
	static CLEANUP: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct OperationScope {
	previous: Option<OperationToken>,
	_thread:  PhantomData<Rc<()>>,
}

impl Drop for OperationScope {
	fn drop(&mut self) {
		CURRENT.with_borrow_mut(|current| *current = self.previous.take());
	}
}

#[cfg(target_os = "linux")]
pub(crate) fn is_cleaning_up() -> bool {
	CLEANUP.get()
}

#[cfg(target_os = "linux")]
pub(crate) fn current_token() -> Option<OperationToken> {
	if CLEANUP.get() {
		None
	} else {
		CURRENT.with_borrow(Clone::clone)
	}
}

pub(crate) fn check() -> CoreResult<()> {
	if CLEANUP.get() {
		return Ok(());
	}
	CURRENT.with_borrow(|token| token.as_ref().map_or(Ok(()), OperationToken::check))
}

pub(crate) fn wait(duration: Duration) -> CoreResult<()> {
	if CLEANUP.get() {
		thread::sleep(duration);
		return Ok(());
	}
	CURRENT.with_borrow(|token| {
		if let Some(token) = token {
			token.wait(duration)
		} else {
			thread::sleep(duration);
			Ok(())
		}
	})
}

/// Cleanup must release already-held input even after cancellation. This does
/// not clear a token or authorize any later operation. Nested cleanup is safe.
pub(crate) fn cleanup<T>(action: impl FnOnce() -> T) -> T {
	struct Restore(bool);
	impl Drop for Restore {
		fn drop(&mut self) {
			CLEANUP.set(self.0);
		}
	}
	let _restore = Restore(CLEANUP.replace(true));
	action()
}

/// Owns one bounded button hold. An attempted press can be partially delivered,
/// so release is mandatory even when that press reports an error.
pub(crate) fn bounded_hold(
	duration: Duration,
	mut transition: impl FnMut(bool) -> CoreResult<()>,
) -> CoreResult<()> {
	check()?;
	let result = transition(true).and_then(|()| wait(duration));
	let released = cleanup(|| transition(false));
	match (result, released) {
		(Err(mut error), Err(release)) => {
			error.message.push_str("; input release also failed: ");
			error.message.push_str(&release.message);
			Err(error)
		},
		(Err(error), _) | (_, Err(error)) => Err(error),
		(Ok(()), Ok(())) => Ok(()),
	}
}

pub(crate) fn key_modifiers(keys: &[super::keys::KeyName]) -> super::backend::Modifiers {
	use super::keys::KeyName;
	super::backend::Modifiers {
		ctrl:  keys.contains(&KeyName::Ctrl),
		alt:   keys.contains(&KeyName::Alt),
		shift: keys.contains(&KeyName::Shift),
		meta:  keys.contains(&KeyName::Meta),
	}
}

/// Merge modifier options into the already-owned arbitrary-key gesture list.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn add_modifiers(
	keys: &mut Vec<super::keys::KeyName>,
	modifiers: super::backend::Modifiers,
) {
	use super::keys::KeyName;
	for (enabled, key) in [
		(modifiers.ctrl, KeyName::Ctrl),
		(modifiers.alt, KeyName::Alt),
		(modifiers.shift, KeyName::Shift),
		(modifiers.meta, KeyName::Meta),
	] {
		if enabled && !keys.contains(&key) {
			keys.push(key);
		}
	}
}

#[cfg(test)]
pub(crate) fn with_token_for_test<T>(token: &OperationToken, action: impl FnOnce() -> T) -> T {
	let _scope = token.enter();
	action()
}

#[cfg(target_os = "macos")]
static USER_ACTIVITY: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
pub(crate) fn user_activity() -> u64 {
	USER_ACTIVITY.load(Ordering::Acquire)
}

static OWNED: AtomicBool = AtomicBool::new(false);

struct ProcessLease;
impl ProcessLease {
	fn acquire() -> CoreResult<Self> {
		OWNED
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		Ok(Self)
	}
}
impl Drop for ProcessLease {
	fn drop(&mut self) {
		OWNED.store(false, Ordering::Release);
	}
}

fn busy() -> DesktopError {
	DesktopError::input_busy("another desktop operation owns input/focus control; no input was sent")
}

/// The kernel owner lives on its own thread: Windows mutex release must happen
/// on the same thread that acquired it, even when the session is disposed from
/// another host thread. Closing/crashing the process releases the OS resource.
struct ControlLease {
	#[cfg(target_os = "macos")]
	_escape: Option<macos::EscapeMonitor>,
	#[cfg(windows)]
	_escape: Option<windows::EscapeMonitor>,
	#[cfg(target_os = "linux")]
	_escape: Option<linux::EscapeMonitor>,
	_kernel: KernelOwner,
	running: AtomicBool,
}

impl ControlLease {
	fn acquire(source: &CancellationSource) -> CoreResult<Self> {
		let kernel = KernelOwner::acquire()?;
		#[cfg(target_os = "macos")]
		let escape = macos::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		#[cfg(windows)]
		let escape = windows::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		#[cfg(target_os = "linux")]
		let escape = linux::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		Ok(Self {
			#[cfg(any(target_os = "macos", windows))]
			_escape: Some(escape),
			#[cfg(target_os = "linux")]
			_escape: escape,
			_kernel: kernel,
			running: AtomicBool::new(false),
		})
	}
}

struct KernelOwner {
	stop:   Option<flume::Sender<()>>,
	thread: Option<thread::JoinHandle<()>>,
}

impl KernelOwner {
	fn acquire() -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let (stop, stopped) = flume::bounded(1);
		let thread = thread::Builder::new()
			.name("desktop-owner".into())
			.spawn(move || {
				let leases = ProcessLease::acquire()
					.and_then(|process| KernelLease::acquire().map(|kernel| (kernel, process)));
				match leases {
					Ok(_leases) => {
						let _ = ready.send(Ok(()));
						let _ = stopped.recv();
					},
					Err(error) => {
						let _ = ready.send(Err(error));
					},
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start desktop owner: {error}"))
			})?;
		let owner = Self { stop: Some(stop), thread: Some(thread) };
		receive.recv().map_err(|_| {
			DesktopError::input_failed("desktop owner stopped before acquiring input")
		})??;
		Ok(owner)
	}
}

impl Drop for KernelOwner {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

pub(crate) struct InputLease {
	_scope:  OperationScope,
	owner:   Arc<ControlLease>,
	_thread: PhantomData<Rc<()>>,
}

impl InputLease {
	pub(crate) fn acquire(token: &OperationToken) -> CoreResult<Self> {
		token.check()?;
		let owner = {
			let state = token.source.0.state.lock();
			token.check()?;
			match state.as_ref() {
				Some(owner) => owner.clone(),
				None => Arc::new(ControlLease::acquire(&token.source)?),
			}
		};
		owner
			.running
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		let lease = Self { _scope: token.enter(), owner, _thread: PhantomData };
		token.check()?;
		Ok(lease)
	}
}

impl Drop for InputLease {
	fn drop(&mut self) {
		self.owner.running.store(false, Ordering::Release);
	}
}

#[cfg(unix)]
struct KernelLease(std::fs::File);

#[cfg(unix)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		// A fixed per-login-user inode coordinates independently launched hosts.
		// Never unlink it: unlinking a locked inode would create two lock
		// domains. SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		Self::at(&std::path::PathBuf::from(format!("/tmp/pi-desktop-input-{uid}.lock")))
	}

	fn at(path: &std::path::Path) -> CoreResult<Self> {
		use std::os::unix::{
			fs::{MetadataExt, OpenOptionsExt},
			io::AsRawFd,
		};
		let file = std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.mode(0o600)
			.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
			.open(path)
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot acquire desktop ownership: {error}"))
			})?;
		let metadata = file.metadata().map_err(|error| {
			DesktopError::input_failed(format!("cannot inspect desktop ownership: {error}"))
		})?;
		// SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		if !metadata.is_file()
			|| metadata.uid() != uid
			|| metadata.nlink() != 1
			|| metadata.mode() & 0o077 != 0
		{
			return Err(DesktopError::input_failed(
				"desktop ownership file is not a private regular file",
			));
		}
		// SAFETY: the descriptor remains owned by `file`; flock is nonblocking.
		if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
			let error = std::io::Error::last_os_error();
			if error.kind() == std::io::ErrorKind::WouldBlock {
				return Err(busy());
			}
			return Err(DesktopError::input_failed(format!("cannot lock desktop ownership: {error}")));
		}
		Ok(Self(file))
	}
}

#[cfg(unix)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		use std::os::fd::AsRawFd;
		// SAFETY: this guard owns the live locked descriptor.
		unsafe {
			libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
		}
	}
}

#[cfg(windows)]
struct KernelLease(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		use windows_sys::Win32::{
			Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
			System::Threading::{CreateMutexW, WaitForSingleObject},
		};
		let name: Vec<u16> = "Local\\PiDesktopInput-v1\0".encode_utf16().collect();
		// SAFETY: nul-terminated name and default security descriptor are valid.
		let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
		if handle.is_null() {
			return Err(DesktopError::input_failed("cannot open desktop ownership mutex"));
		}
		// SAFETY: handle is live; zero timeout never queues or retries input.
		let status = unsafe { WaitForSingleObject(handle, 0) };
		if status == WAIT_OBJECT_0 || status == WAIT_ABANDONED {
			return Ok(Self(handle));
		}
		// SAFETY: the failed acquisition still owns its opened handle.
		unsafe {
			CloseHandle(handle);
		}
		if status == WAIT_TIMEOUT {
			return Err(busy());
		}
		Err(DesktopError::input_failed("cannot acquire desktop ownership mutex"))
	}
}

#[cfg(windows)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		// SAFETY: this thread owns both the mutex and its handle.
		unsafe {
			windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
			windows_sys::Win32::Foundation::CloseHandle(self.0);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	static OWNERSHIP_TEST: Mutex<()> = Mutex::new(());

	/// Real ownership without OS event monitoring: lifecycle regressions must
	/// not depend on an interactive desktop or Accessibility permissions.
	fn grant_for_test(source: &CancellationSource) {
		let owner = ControlLease {
			_escape: None,
			_kernel: KernelOwner::acquire().expect("test kernel owner"),
			running: AtomicBool::new(false),
		};
		*source.0.state.lock() = Some(Arc::new(owner));
	}

	#[test]
	fn task_lease_survives_retirement_but_abort_and_release_revoke_it() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		source
			.acquire_control(&source.token())
			.expect("idempotent acquisition");
		let old = source.token();
		{
			let _operation = InputLease::acquire(&old).expect("reuse task ownership");
			assert!(InputLease::acquire(&source.token()).is_err());
			assert!(InputLease::acquire(&CancellationSource::default().token()).is_err());
		}
		source.retire();
		assert!(source.control_active());
		assert!(old.check().is_err());
		let fresh = source.token();
		let running = InputLease::acquire(&fresh).expect("fresh run reuses ownership");
		source.cancel();
		assert!(!source.control_active());
		assert!(fresh.check().is_err());
		assert!(KernelOwner::acquire().is_err(), "cleanup still owns the kernel");
		drop(running);
		drop(KernelOwner::acquire().expect("cleanup releases ownership"));
		grant_for_test(&source);
		let queued = source.token();
		source.release_control();
		assert!(!source.control_active());
		assert!(queued.check().is_err());
		assert!(source.acquire_control(&queued).is_err(), "stale acquisition cannot grant ownership");
		assert!(!source.control_active());
		grant_for_test(&source);
		assert!(queued.check().is_err(), "reacquiring cannot revive queued input");
		drop((old, fresh, queued));
		drop(source);
		drop(KernelOwner::acquire().expect("session destruction releases ownership"));
	}

	#[test]
	fn emergency_stop_revokes_idle_task_control_after_retirement() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		let emergency = EmergencyStop(Arc::downgrade(&source.0));
		source.retire();
		let fresh = source.token();
		emergency.cancel();
		assert!(!source.control_active());
		assert!(fresh.check().is_err());
		drop(KernelOwner::acquire().expect("idle Escape releases kernel ownership"));
	}

	#[test]
	fn bounded_button_hold_releases_on_success_cancel_and_partial_press() {
		let mut events = Vec::new();
		bounded_hold(Duration::ZERO, |down| {
			events.push(down);
			Ok(())
		})
		.unwrap();
		assert_eq!(events, [true, false]);

		events.clear();
		let source = CancellationSource::default();
		let token = source.token();
		let result = with_token_for_test(&token, || {
			bounded_hold(Duration::from_secs(100), |down| {
				events.push(down);
				if down {
					source.cancel();
				}
				Ok(())
			})
		});
		assert!(result.is_err());
		assert_eq!(events, [true, false]);
		assert!(token.check().is_err());

		events.clear();
		let result = bounded_hold(Duration::from_secs(100), |down| {
			events.push(down);
			Err(DesktopError::input_failed(if down {
				"partial press"
			} else {
				"release failed"
			}))
		});
		let message = result.unwrap_err().message;
		assert!(message.contains("partial press") && message.contains("release failed"));
		assert_eq!(events, [true, false]);
	}

	#[test]
	fn cancellation_wakes_a_bounded_hold_without_polling() {
		let source = CancellationSource::default();
		let token = source.token();
		let (ready, waiting) = flume::bounded(1);
		let worker = thread::spawn(move || {
			ready.send(()).unwrap();
			token.wait(Duration::from_secs(100))
		});
		waiting.recv().unwrap();
		source.cancel();
		assert!(worker.join().unwrap().is_err());
	}

	#[test]
	fn cancellation_never_revives_queued_generations() {
		let source = CancellationSource::default();
		let running = source.token();
		let queued = source.token();
		source.cancel();
		let later = source.token();
		assert!(running.check().is_err());
		assert!(queued.check().is_err());
		assert!(later.check().is_ok());
		source.cancel();
		assert!(later.check().is_err());
		assert!(source.token().check().is_ok());
		assert!(running.check().is_err());
	}

	#[test]
	fn newer_scope_cannot_revive_an_older_operation() {
		let source = CancellationSource::default();
		let old = source.token();
		let _scope = old.enter();
		source.cancel();
		{
			let _later = source.token().enter();
			assert!(check().is_ok());
		}
		assert!(check().is_err());
	}

	#[test]
	fn cleanup_does_not_clear_cancellation() {
		let source = CancellationSource::default();
		CURRENT.with_borrow_mut(|current| *current = Some(source.token()));
		source.cancel();
		cleanup(|| {
			assert!(check().is_ok());
			cleanup(|| assert!(check().is_ok()));
		});
		assert!(check().is_err());
		CURRENT.with_borrow_mut(|current| *current = None);
	}

	#[test]
	fn process_ownership_fails_closed_and_releases() {
		let _serial = OWNERSHIP_TEST.lock();
		let first = ProcessLease::acquire().expect("first lease");
		assert!(ProcessLease::acquire().is_err());
		drop(first);
		assert!(ProcessLease::acquire().is_ok());
	}

	#[cfg(unix)]
	#[test]
	fn kernel_child_probe() {
		let Some(path) = std::env::var_os("PI_CONTROL_TEST_LOCK") else {
			return;
		};
		let acquired = KernelLease::at(std::path::Path::new(&path));
		assert_eq!(acquired.is_ok(), std::env::var_os("PI_CONTROL_TEST_FREE").is_some());
		if acquired.is_ok() {
			// Deliberately skip Rust destructors, as on a crashed host.
			std::process::exit(0);
		}
	}

	#[cfg(unix)]
	#[test]
	fn independent_processes_contend_and_release() {
		let path =
			std::env::temp_dir().join(format!("pi-control-process-test-{}.lock", std::process::id()));
		let first = KernelLease::at(&path).expect("parent lease");
		let child = |free: bool| {
			let mut command =
				std::process::Command::new(std::env::current_exe().expect("test binary"));
			command
				.args(["--exact", "desktop::control::tests::kernel_child_probe"])
				.env("PI_CONTROL_TEST_LOCK", &path)
				.env_remove("PI_CONTROL_TEST_FREE");
			if free {
				command.env("PI_CONTROL_TEST_FREE", "1");
			}
			assert!(command.status().expect("child probe").success());
		};
		child(false);
		drop(first);
		child(true);
		let recovered =
			KernelLease::at(&path).expect("kernel releases ownership after abrupt child exit");
		drop(recovered);
		std::fs::remove_file(path).expect("remove process test lock");
	}

	#[cfg(unix)]
	#[test]
	fn independent_kernel_handles_contend_and_release() {
		let path = std::env::temp_dir().join(format!("pi-control-test-{}.lock", std::process::id()));
		let first = KernelLease::at(&path).expect("first kernel lease");
		assert!(KernelLease::at(&path).is_err());
		drop(first);
		let second = KernelLease::at(&path).expect("lease after release");
		drop(second);
		std::fs::remove_file(path).expect("remove test lock");
	}
}
