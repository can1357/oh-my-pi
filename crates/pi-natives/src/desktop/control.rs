//! Cancellation and exclusive task/operation ownership of desktop mutations.
//!
//! Explicit control keeps the kernel lease between operations. Revocation
//! stops fresh work immediately, but an in-flight operation retains ownership
//! until its held input and focus have been restored.
use std::{
	cell::{Cell, RefCell},
	collections::HashMap,
	marker::PhantomData,
	rc::Rc,
	sync::{
		Arc, LazyLock, Weak,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};

use super::{
	error::{CoreResult, DesktopError},
	types::DesktopFocusReturn,
};

#[cfg(target_os = "macos")]
pub(crate) mod intervention;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
pub(crate) use macos::{
	MONITORED_TYPES, POINTER_PRESS_TYPES, SYNTHETIC_EVENT_TAG, add_live_tap, invalidate_live_tap,
	is_pointer_press, monitor_seen, uptime_ns,
};

#[derive(Default)]
struct CancellationState {
	generation:   AtomicU64,
	state:        Mutex<Option<Arc<ControlLease>>>,
	wake:         Condvar,
	/// Takeover input stopped by the user's physical Escape. Host cancels,
	/// retirement and release never count, so the host can tell the user's
	/// stop from its own. Shared with every session under the same key.
	escape_stops: Arc<AtomicU32>,
	/// When the current computer run ends; input waiting for the user to
	/// pause stops shortly before it.
	#[cfg(target_os = "macos")]
	deadline:     Mutex<Option<Instant>>,
	#[cfg(target_os = "linux")]
	async_wake:   tokio::sync::Notify,
}

#[derive(Clone, Default)]
pub(crate) struct CancellationSource(Arc<CancellationState>);

impl CancellationSource {
	/// A source whose physical-Escape stops count into `stops`.
	pub(crate) fn counting_escapes(stops: Arc<AtomicU32>) -> Self {
		Self(Arc::new(CancellationState { escape_stops: stops, ..CancellationState::default() }))
	}

	pub(crate) fn token(&self) -> OperationToken {
		OperationToken {
			source: self.clone(),
			generation: self.0.generation.load(Ordering::Acquire),
			#[cfg(target_os = "macos")]
			reply_by: None,
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
			*state = Some(Arc::new(ControlLease::acquire(self, true)?));
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

	/// How many times the user's physical Escape has stopped this session.
	pub(crate) fn escape_stops(&self) -> u32 {
		self.0.escape_stops.load(Ordering::Acquire)
	}

	/// Sets when the current computer run ends, `None` for no deadline. Each
	/// run sets it before its first call.
	#[cfg(target_os = "macos")]
	pub(crate) fn set_deadline(&self, deadline: Option<Instant>) {
		*self.0.deadline.lock() = deadline;
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

	/// The user's physical Escape: counted before the cancel, so a host that
	/// sees the cancelled operation already sees the stop that caused it.
	fn escape(&self) {
		if let Some(source) = self.0.upgrade() {
			source.escape_stops.fetch_add(1, Ordering::AcqRel);
			CancellationSource(source).cancel();
		}
	}
}

#[derive(Clone)]
pub(crate) struct OperationToken {
	source:     CancellationSource,
	generation: u64,
	/// When the caller stops waiting for this request's reply.
	#[cfg(target_os = "macos")]
	reply_by:   Option<Instant>,
}

impl OperationToken {
	/// When this operation must have answered: the run's end or the caller's
	/// reply timeout, whichever comes first.
	#[cfg(target_os = "macos")]
	pub(crate) fn deadline(&self) -> Option<Instant> {
		let run = *self.source.0.deadline.lock();
		match (run, self.reply_by) {
			(Some(run), Some(reply)) => Some(run.min(reply)),
			(run, reply) => run.or(reply),
		}
	}

	/// This token for a request whose caller waits for its reply until `at`.
	#[cfg(target_os = "macos")]
	pub(crate) fn replying_by(self, at: Instant) -> Self {
		Self { reply_by: Some(at), ..self }
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
	static FOCUS_RETURN: Cell<Option<DesktopFocusReturn>> = const { Cell::new(None) };
}

/// Records where the current operation's takeover left focus.
#[cfg(target_os = "macos")]
pub(crate) fn report_focus_return(report: DesktopFocusReturn) {
	FOCUS_RETURN.set(Some(report));
}

/// Takes the focus report of the operation running on this thread, leaving
/// none for the next.
pub(crate) fn take_focus_return() -> Option<DesktopFocusReturn> {
	FOCUS_RETURN.take()
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

/// [`check`] for a step that would send new input from inside [`cleanup`],
/// such as pressing an item of a menu that cleanup is settling: cleanup lets
/// releases through after cancellation, never fresh input.
#[cfg(target_os = "macos")]
pub(crate) fn check_new_input() -> CoreResult<()> {
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

/// Waits after a call's input went out, for the target to take it in before
/// the call goes on. A cancel neither cuts it short nor fails the call: the
/// input already landed, so the call reports it, and the cancel stops the next
/// call instead.
pub(crate) fn settle(duration: Duration) {
	thread::sleep(duration);
}

/// The pause `gap` after a press. Once a call's last press is out (`sent`)
/// it is a [`settle`]; before that a cancel ends it.
pub(crate) fn sent_gap_wait(gap: Duration, sent: bool) -> CoreResult<()> {
	if sent {
		settle(gap);
		Ok(())
	} else {
		wait(gap)
	}
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

/// Physical-Escape stop counts by host-chosen key. A count outlives the
/// session that observed it, so a host that replaces a hung worker's session
/// still sees a stop the old session never reported.
static ESCAPE_STOPS: LazyLock<Mutex<HashMap<String, Arc<AtomicU32>>>> =
	LazyLock::new(Mutex::default);

/// The shared count for `key`; a session without a key counts alone.
pub(crate) fn escape_stop_counter(key: Option<&str>) -> Arc<AtomicU32> {
	key.map_or_else(Arc::default, |key| {
		Arc::clone(ESCAPE_STOPS.lock().entry(key.to_owned()).or_default())
	})
}

pub(crate) fn escape_stops(key: &str) -> u32 {
	ESCAPE_STOPS
		.lock()
		.get(key)
		.map_or(0, |stops| stops.load(Ordering::Acquire))
}

pub(crate) fn forget_escape_stops(key: &str) {
	ESCAPE_STOPS.lock().remove(key);
}

/// Invalidates this process's event taps before it exits
/// (`macos::close_taps`); only macOS taps are known to need it.
#[cfg_attr(
	not(target_os = "macos"),
	allow(clippy::missing_const_for_fn, reason = "only macOS closes taps")
)]
pub(crate) fn close_event_taps() {
	#[cfg(target_os = "macos")]
	macos::close_taps();
}

#[cfg(target_os = "macos")]
static USER_CHOICES: AtomicU64 = AtomicU64::new(0);

/// Mouse buttons and shortcuts (any key press but plain typing: Command-Tab,
/// Control-Up, F3) the user pressed while the takeover monitor ran: the input
/// that may pick an app, window, Space or menu, so takeover leaves the front
/// application to the user.
#[cfg(target_os = "macos")]
pub(crate) fn user_choices() -> u64 {
	USER_CHOICES.load(Ordering::Acquire)
}

#[cfg(target_os = "macos")]
static LAST_USER_TYPING: AtomicU64 = AtomicU64::new(0);

/// When (`CLOCK_UPTIME_RAW` nanoseconds) the takeover monitor last saw the
/// user type a key or modifier that picks nothing; 0 if it never has, as
/// without Input Monitoring.
#[cfg(target_os = "macos")]
pub(crate) fn last_user_typing() -> u64 {
	LAST_USER_TYPING.load(Ordering::Acquire)
}

static OWNED: AtomicBool = AtomicBool::new(false);

/// Serializes tests that take this process's input ownership, which is one
/// per process: the ownership tests here and worker tests that send input.
#[cfg(test)]
pub(crate) static OWNERSHIP_TEST: Mutex<()> = Mutex::new(());

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
	/// Physical Escape anywhere stops takeover input only. A background
	/// operation leaves the user's keyboard alone, so an Escape they press in
	/// their own app cancels nothing; the host interrupt still cancels it.
	#[cfg(target_os = "macos")]
	fn acquire(source: &CancellationSource, takeover: bool) -> CoreResult<Self> {
		#[cfg(not(test))]
		let start = macos::EscapeMonitor::start;
		// Tests start the stand-in; naming the real monitor keeps it, and
		// everything its tap uses, compiled and linted in test builds too.
		#[cfg(test)]
		let start = {
			let _real = macos::EscapeMonitor::start;
			test_escape::start
		};
		Self::acquire_arming(source, takeover, start)
	}

	#[cfg(target_os = "macos")]
	fn acquire_arming(
		source: &CancellationSource,
		takeover: bool,
		start: impl FnOnce(EmergencyStop) -> CoreResult<macos::EscapeMonitor>,
	) -> CoreResult<Self> {
		if !takeover {
			return Self::background();
		}
		let kernel = KernelOwner::acquire()?;
		let escape = start(EmergencyStop(Arc::downgrade(&source.0)))?;
		Ok(Self { _escape: Some(escape), _kernel: kernel, running: AtomicBool::new(false) })
	}

	#[cfg(not(target_os = "macos"))]
	fn acquire(source: &CancellationSource, takeover: bool) -> CoreResult<Self> {
		if takeover {
			Self::acquire_takeover(source)
		} else {
			Self::background()
		}
	}

	fn background() -> CoreResult<Self> {
		Ok(Self { _escape: None, _kernel: KernelOwner::acquire()?, running: AtomicBool::new(false) })
	}

	#[cfg(not(target_os = "macos"))]
	fn acquire_takeover(source: &CancellationSource) -> CoreResult<Self> {
		let kernel = KernelOwner::acquire()?;
		#[cfg(windows)]
		let escape = windows::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		#[cfg(target_os = "linux")]
		let escape = linux::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		Ok(Self {
			#[cfg(windows)]
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
					Ok((kernel, process)) => {
						// Withdrawn from release helpers before the lock is released.
						#[cfg(target_os = "macos")]
						let kernel = SharedOwnership::publish(kernel);
						let _ = ready.send(Ok(()));
						let _ = stopped.recv();
						drop(kernel);
						drop(process);
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

/// A duplicate of the kernel ownership lock while this process holds it. A
/// macOS input-release helper keeps one open (`macos/release_guard.rs`), so a
/// host that dies mid-input keeps other hosts out until the helper has
/// released what the host held.
#[cfg(target_os = "macos")]
static SHARED_OWNERSHIP: Mutex<Option<SharedLock>> = Mutex::new(None);

/// Tells apart the leases `SHARED_OWNERSHIP` publishes, so a helper reaped
/// after its lease ended counts against none.
#[cfg(target_os = "macos")]
static SHARED_LEASES: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
struct SharedLock {
	file:     std::fs::File,
	lease:    u64,
	/// Helpers handed a duplicate that have not been reaped.
	unreaped: usize,
}

/// The kernel lease while its lock is published to release helpers.
#[cfg(target_os = "macos")]
struct SharedOwnership {
	lease: KernelLease,
}

#[cfg(target_os = "macos")]
impl SharedOwnership {
	fn publish(lease: KernelLease) -> Self {
		*SHARED_OWNERSHIP.lock() = lease.file.try_clone().ok().map(|file| SharedLock {
			file,
			lease: SHARED_LEASES.fetch_add(1, Ordering::Relaxed),
			unreaped: 0,
		});
		Self { lease }
	}
}

#[cfg(target_os = "macos")]
impl Drop for SharedOwnership {
	fn drop(&mut self) {
		let published = SHARED_OWNERSHIP.lock().take();
		self.lease.shared = published.is_some_and(|published| published.unreaped > 0);
	}
}

/// A release helper's share of the kernel ownership lock, dropped once the
/// helper is reaped: the lease unlocks on drop again once every helper it
/// handed the lock to has exited.
#[cfg(target_os = "macos")]
pub(crate) struct HandedOwnership {
	lease: u64,
}

#[cfg(target_os = "macos")]
impl Drop for HandedOwnership {
	fn drop(&mut self) {
		if let Some(published) = SHARED_OWNERSHIP.lock().as_mut()
			&& published.lease == self.lease
		{
			published.unreaped -= 1;
		}
	}
}

/// A new close-on-exec descriptor for the kernel ownership lock, while this
/// process holds it, for a helper that holds the returned share until it is
/// reaped.
#[cfg(target_os = "macos")]
pub(crate) fn shared_ownership() -> Option<(std::os::fd::OwnedFd, HandedOwnership)> {
	let mut published = SHARED_OWNERSHIP.lock();
	let published = published.as_mut()?;
	let duplicate = published.file.try_clone().ok()?;
	published.unreaped += 1;
	Some((duplicate.into(), HandedOwnership { lease: published.lease }))
}

/// Whether a release helper handed this process's ownership has not been
/// reaped: one an earlier operation stopped waiting for may still post its
/// releases, which would cut short what a new operation presses.
#[cfg(target_os = "macos")]
fn release_helper_running() -> bool {
	SHARED_OWNERSHIP
		.lock()
		.as_ref()
		.is_some_and(|published| published.unreaped > 0)
}

#[cfg(not(target_os = "macos"))]
const fn release_helper_running() -> bool {
	false
}

pub(crate) struct InputLease {
	_scope:  OperationScope,
	owner:   Arc<ControlLease>,
	_thread: PhantomData<Rc<()>>,
}

impl InputLease {
	/// `takeover` arms the physical-Escape stop for this operation; held control
	/// keeps the stop it armed when it was granted.
	pub(crate) fn acquire(token: &OperationToken, takeover: bool) -> CoreResult<Self> {
		token.check()?;
		let owner = {
			let state = token.source.0.state.lock();
			token.check()?;
			match state.as_ref() {
				Some(owner) => owner.clone(),
				None => Arc::new(ControlLease::acquire(&token.source, takeover)?),
			}
		};
		owner
			.running
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		let lease = Self { _scope: token.enter(), owner, _thread: PhantomData };
		// Held control keeps ownership between operations, so the kernel lock
		// a lingering helper shares does not keep the next one out.
		if release_helper_running() {
			return Err(busy());
		}
		token.check()?;
		Ok(lease)
	}
}

impl Drop for InputLease {
	fn drop(&mut self) {
		self.owner.running.store(false, Ordering::Release);
	}
}

/// The `flock` belongs to the open file: every descriptor of it holds the lock
/// until all of them close, or until one unlocks it for all.
#[cfg(unix)]
struct KernelLease {
	file:   std::fs::File,
	/// A macOS release helper that was handed a duplicate
	/// (`SharedOwnership`) may still run, so the lease releases by closing its
	/// descriptor and the lock lasts until the helper's closes too.
	shared: bool,
}

#[cfg(unix)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		Self::at(&Self::path())
	}

	/// A fixed per-login-user inode coordinates independently launched hosts.
	/// Never unlink it: unlinking a locked inode would create two lock domains.
	#[cfg(not(test))]
	fn path() -> std::path::PathBuf {
		// SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		std::path::PathBuf::from(format!("/tmp/pi-desktop-input-{uid}.lock"))
	}

	/// nextest runs every test in its own process; a per-process inode keeps
	/// concurrent test processes and a live host from contending for input.
	#[cfg(test)]
	fn path() -> std::path::PathBuf {
		std::env::temp_dir().join(format!("pi-desktop-input-test-{}.lock", std::process::id()))
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
		Ok(Self { file, shared: false })
	}
}

#[cfg(unix)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		// Unlocked rather than closed when nothing else should hold it: a
		// process another thread is spawning keeps a copy of the descriptor
		// until it execs.
		if !self.shared {
			use std::os::fd::AsRawFd;
			// SAFETY: this guard owns the live locked descriptor.
			unsafe {
				libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
			}
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
		let name = Self::name();
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

	/// Nul-terminated mutex name shared by every host in the login session.
	#[cfg(not(test))]
	fn name() -> Vec<u16> {
		"Local\\PiDesktopInput-v1\0".encode_utf16().collect()
	}

	/// nextest runs every test in its own process; a per-process mutex keeps
	/// concurrent test processes and a live host from contending for input.
	#[cfg(test)]
	fn name() -> Vec<u16> {
		format!("Local\\PiDesktopInput-test-{}\0", std::process::id())
			.encode_utf16()
			.collect()
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

/// Real ownership without OS event monitoring: lifecycle regressions must
/// not depend on an interactive desktop or Accessibility permissions.
///
/// Under a runner that runs every test in one process (bazel, `cargo test`)
/// the previous test can still be dropping a source that holds the
/// process's one lease after it released `OWNERSHIP_TEST`, as a test's
/// locals outlive the worker that held the lock. Waiting for that release
/// keeps the grant from failing on a neighbour's teardown.
#[cfg(test)]
pub(crate) fn grant_for_test(source: &CancellationSource) {
	let deadline = std::time::Instant::now() + Duration::from_secs(10);
	let kernel = loop {
		match KernelOwner::acquire() {
			Ok(kernel) => break kernel,
			Err(error)
				if error.code == crate::desktop::error::ErrorCode::InputBusy
					&& std::time::Instant::now() < deadline =>
			{
				thread::sleep(Duration::from_millis(5));
			},
			Err(error) => panic!("test kernel owner: {error:?}"),
		}
	};
	let owner = ControlLease { _escape: None, _kernel: kernel, running: AtomicBool::new(false) };
	*source.0.state.lock() = Some(Arc::new(owner));
}

/// The Escape monitor's stand-in in tests, where no event tap can start: a
/// takeover lease is refused as it is without the permission, and the
/// [`EmergencyStop`] the monitor's tap would cancel through on a physical
/// Escape is kept for [`press_escape_for_test`].
#[cfg(all(test, target_os = "macos"))]
mod test_escape {
	use std::cell::RefCell;

	use super::{CoreResult, DesktopError, EmergencyStop, macos};

	thread_local! {
		pub(super) static ARMED: RefCell<Vec<EmergencyStop>> = const { RefCell::new(Vec::new()) };
	}

	pub(super) fn start(stop: EmergencyStop) -> CoreResult<macos::EscapeMonitor> {
		ARMED.with_borrow_mut(|armed| armed.push(stop));
		Err(DesktopError::permission_denied("no event tap in tests"))
	}
}

/// Presses a physical Escape for every Escape stop a lease armed on this
/// thread since the last press, as the monitor's tap would; returns how many
/// there were.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn press_escape_for_test() -> usize {
	let armed = test_escape::ARMED.with_borrow_mut(std::mem::take);
	for stop in &armed {
		stop.cancel();
	}
	armed.len()
}

/// Real kernel ownership alone, as each mutation without explicit control
/// takes and drops it.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn own_for_test() -> CoreResult<impl Sized> {
	KernelOwner::acquire()
}

/// Whether this is the child test process that runs `test` alone. Otherwise
/// runs it so and asserts that it passed: under cargo test, the worker tests
/// in this process take its one input ownership to send input.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn alone(test: &str) -> bool {
	const ALONE: &str = "PI_DESKTOP_TEST_ALONE";
	if std::env::var_os(ALONE).is_some() {
		return true;
	}
	let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
		.args(["--exact", test])
		.env(ALONE, "1")
		.output()
		.expect("child test");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains(" 1 passed;"),
		"{stdout}{}",
		String::from_utf8_lossy(&output.stderr)
	);
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Removes this process's private kernel lock (see `KernelLease::path`).
	fn remove_test_lock() {
		#[cfg(unix)]
		let _ = std::fs::remove_file(KernelLease::path());
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
			let _operation = InputLease::acquire(&old, false).expect("reuse task ownership");
			assert!(InputLease::acquire(&source.token(), false).is_err());
			assert!(InputLease::acquire(&CancellationSource::default().token(), false).is_err());
		}
		source.retire();
		assert!(source.control_active());
		assert!(old.check().is_err());
		let fresh = source.token();
		let running = InputLease::acquire(&fresh, false).expect("fresh run reuses ownership");
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
		remove_test_lock();
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
		remove_test_lock();
	}

	#[test]
	fn only_the_users_escape_counts_as_an_escape_stop() {
		let source = CancellationSource::default();
		let emergency = EmergencyStop(Arc::downgrade(&source.0));
		source.retire();
		source.cancel();
		source.release_control();
		emergency.cancel();
		assert_eq!(source.escape_stops(), 0, "host and monitor-failure stops are not the user's");
		let running = source.token();
		emergency.escape();
		assert_eq!(source.escape_stops(), 1);
		assert!(running.check().is_err(), "the user's Escape cancels running input");
		source.cancel();
		assert_eq!(source.escape_stops(), 1);
	}

	#[test]
	fn escape_stops_outlive_the_session_under_its_key() {
		let key = format!("escape-key-test-{}", std::process::id());
		let first = CancellationSource::counting_escapes(escape_stop_counter(Some(&key)));
		EmergencyStop(Arc::downgrade(&first.0)).escape();
		drop(first);
		assert_eq!(escape_stops(&key), 1, "the host reads a stop after its session is gone");
		let replacement = CancellationSource::counting_escapes(escape_stop_counter(Some(&key)));
		assert_eq!(replacement.escape_stops(), 1, "a replacement session keeps the count");
		let keyless = CancellationSource::counting_escapes(escape_stop_counter(None));
		EmergencyStop(Arc::downgrade(&keyless.0)).escape();
		assert_eq!(escape_stops(&key), 1, "a session without the key counts alone");
		forget_escape_stops(&key);
		assert_eq!(escape_stops(&key), 0);
	}

	#[test]
	fn the_host_interrupt_still_cancels_background_input() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		let token = source.token();
		let lease =
			InputLease::acquire(&token, false).expect("background input needs no Escape stop");
		source.cancel();
		assert!(token.check().is_err(), "the host interrupt still cancels background input");
		drop(lease);
		drop(KernelOwner::acquire().expect("background input releases kernel ownership"));
		remove_test_lock();
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn physical_escape_stops_takeover_input_but_not_background_input() {
		let _serial = OWNERSHIP_TEST.lock();
		press_escape_for_test();
		let source = CancellationSource::default();
		let background = source.token();
		drop(InputLease::acquire(&background, false).expect("background lease"));
		assert_eq!(press_escape_for_test(), 0, "background input arms no Escape stop");
		assert!(background.check().is_ok(), "the user's Escape leaves background input running");
		let takeover = source.token();
		assert!(
			InputLease::acquire(&takeover, true).is_err(),
			"a takeover whose Escape stop cannot start is refused"
		);
		assert_eq!(press_escape_for_test(), 1);
		assert!(takeover.check().is_err(), "physical Escape stops takeover input");
		drop(KernelOwner::acquire().expect("takeover input releases kernel ownership"));
		remove_test_lock();
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

	/// Asserts in a separate process whether the kernel lock at `path` is free.
	#[cfg(unix)]
	fn child_probe(path: &std::path::Path, free: bool) {
		let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
		command
			.args(["--exact", "desktop::control::tests::kernel_child_probe"])
			.env("PI_CONTROL_TEST_LOCK", path)
			.env_remove("PI_CONTROL_TEST_FREE");
		if free {
			command.env("PI_CONTROL_TEST_FREE", "1");
		}
		assert!(command.status().expect("child probe").success());
	}

	#[cfg(unix)]
	#[test]
	fn independent_processes_contend_and_release() {
		let path =
			std::env::temp_dir().join(format!("pi-control-process-test-{}.lock", std::process::id()));
		let first = KernelLease::at(&path).expect("parent lease");
		child_probe(&path, false);
		drop(first);
		child_probe(&path, true);
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

	#[cfg(unix)]
	#[test]
	fn a_lease_releases_while_a_process_spawned_under_it_still_holds_its_descriptor() {
		let path =
			std::env::temp_dir().join(format!("pi-control-copy-test-{}.lock", std::process::id()));
		let lease = KernelLease::at(&path).expect("lease");
		// A process spawned while the lease is held carries a copy of its
		// descriptor until it execs; this one keeps it.
		let mut copy = std::process::Command::new("/bin/cat")
			.stdin(std::process::Stdio::piped())
			.stdout(lease.file.try_clone().expect("descriptor copy"))
			.spawn()
			.expect("process holding a copy");
		drop(lease);
		child_probe(&path, true);
		drop(copy.stdin.take());
		assert!(copy.wait().expect("copy exits").success());
		std::fs::remove_file(path).expect("remove copy test lock");
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn a_helper_holding_the_shared_lock_keeps_other_hosts_out_until_it_exits() {
		if !alone(
			"desktop::control::tests::a_helper_holding_the_shared_lock_keeps_other_hosts_out_until_it_exits",
		) {
			return;
		}
		assert!(shared_ownership().is_none());
		let owner = KernelOwner::acquire().expect("test kernel owner");
		let (ownership, _handed) = shared_ownership().expect("held lock is shared");
		// Started as the release helper is: the shared lock is its standard
		// output, and it exits when its standard input ends.
		let mut helper = std::process::Command::new("/bin/cat")
			.stdin(std::process::Stdio::piped())
			.stdout(ownership)
			.spawn()
			.expect("helper stand-in");
		drop(owner);
		assert!(shared_ownership().is_none());
		child_probe(&KernelLease::path(), false);
		drop(helper.stdin.take());
		assert!(helper.wait().expect("helper exits").success());
		child_probe(&KernelLease::path(), true);
		remove_test_lock();
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn a_lease_whose_helpers_were_reaped_releases_while_a_spawning_process_holds_its_descriptor() {
		if !alone(
			"desktop::control::tests::a_lease_whose_helpers_were_reaped_releases_while_a_spawning_process_holds_its_descriptor",
		) {
			return;
		}
		let owner = KernelOwner::acquire().expect("test kernel owner");
		let (ownership, handed) = shared_ownership().expect("held lock is shared");
		let mut helper = std::process::Command::new("/bin/cat")
			.stdin(std::process::Stdio::piped())
			.stdout(ownership)
			.spawn()
			.expect("helper stand-in");
		drop(helper.stdin.take());
		assert!(helper.wait().expect("helper exits").success());
		drop(handed);
		// A process spawned while the lease is held carries a copy of its
		// descriptor until it execs; this one keeps it.
		let copy = SHARED_OWNERSHIP
			.lock()
			.as_ref()
			.expect("published lock")
			.file
			.try_clone()
			.expect("descriptor copy");
		let mut copy = std::process::Command::new("/bin/cat")
			.stdin(std::process::Stdio::piped())
			.stdout(copy)
			.spawn()
			.expect("process holding a copy");
		drop(owner);
		child_probe(&KernelLease::path(), true);
		drop(copy.stdin.take());
		assert!(copy.wait().expect("copy exits").success());
		remove_test_lock();
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn held_control_refuses_input_until_an_earlier_operations_helper_is_reaped() {
		use crate::desktop::error::ErrorCode;

		if !alone(
			"desktop::control::tests::held_control_refuses_input_until_an_earlier_operations_helper_is_reaped",
		) {
			return;
		}
		let source = CancellationSource::default();
		grant_for_test(&source);
		// An earlier operation stopped waiting for its helper, which still holds
		// its share of ownership.
		let (_descriptor, handed) = shared_ownership().expect("held lock is shared");
		let refused = InputLease::acquire(&source.token(), false).map(drop);
		assert_eq!(refused.map_err(|error| error.code), Err(ErrorCode::InputBusy));
		drop(handed);
		drop(InputLease::acquire(&source.token(), false).expect("input once the helper is reaped"));
		source.release_control();
		remove_test_lock();
	}
}
