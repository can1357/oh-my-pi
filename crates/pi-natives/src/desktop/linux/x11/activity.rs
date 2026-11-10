//! The user's own key and button presses, so a takeover neither starts while
//! the user is typing or clicking nor carries on once they do: from then on
//! the target holds the keyboard, and the user's keys would land in it.
//!
//! XI2 raw events report every press with the slave device it came from.
//! OMP's virtual (MPX) devices carry background input and are never the
//! user's. The core XTEST devices carry takeover's own presses, and also
//! those of tools that type for a remote or scripted user (x11vnc, xdotool):
//! a press there beyond the ones this session sent is someone else's.
use std::{
	collections::HashMap,
	os::{fd::AsRawFd, unix::net::UnixStream},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};
use x11rb::{
	connection::Connection,
	protocol::{
		Event,
		xinput::{ConnectionExt as _, Device, DeviceType, EventMask, XIEventMask},
	},
	rust_connection::RustConnection,
};

use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
};

/// How long the user leaves the keyboard and pointer alone before a takeover
/// starts; macOS waits as long for the user to pause in the target app.
const QUIET: Duration = Duration::from_secs(5);
/// Time left before the run's deadline for the refusal to reach the caller.
const DEADLINE_MARGIN: Duration = Duration::from_millis(250);
const READ_AGAIN: &str =
	"read the window again (win.ax(), win.observe() or win.screenshot()) before acting on it";

#[derive(Default)]
struct Presses {
	count:    AtomicU64,
	last:     Mutex<Option<Instant>>,
	/// Signalled at each press, for callers waiting to see one.
	recorded: Condvar,
}

impl Presses {
	fn record(&self, at: Instant) {
		let mut last = self.last.lock();
		*last = Some(at);
		self.count.fetch_add(1, Ordering::AcqRel);
		self.recorded.notify_all();
	}
}

/// Session-lived listener for the user's presses.
pub(super) struct UserActivity {
	presses: Arc<Presses>,
	/// Key and button presses this session sent through XTEST.
	sent:    Arc<AtomicU64>,
	stop:    Option<UnixStream>,
	thread:  Option<JoinHandle<()>>,
}

impl UserActivity {
	pub(super) fn start(display: Option<&str>) -> CoreResult<Self> {
		let conn = listen(display)?;
		let (stop, stopped) = UnixStream::pair().map_err(failed)?;
		let presses = Arc::<Presses>::default();
		let sent = Arc::new(AtomicU64::new(0));
		let thread = {
			let (presses, sent) = (Arc::clone(&presses), Arc::clone(&sent));
			thread::Builder::new()
				.name("desktop-user-activity".into())
				.spawn(move || run(&conn, &stopped, &presses, &sent))
				.map_err(failed)?
		};
		Ok(Self { presses, sent, stop: Some(stop), thread: Some(thread) })
	}

	/// Counts one press this session is about to send through XTEST; `undo`
	/// takes it back when the request failed.
	pub(super) fn sending(&self, undo: bool) {
		if undo {
			self.sent.fetch_sub(1, Ordering::AcqRel);
		} else {
			self.sent.fetch_add(1, Ordering::AcqRel);
		}
	}

	/// Waits until the user has pressed nothing for [`QUIET`], then returns
	/// the press count a takeover compares against ([`Self::check`]). Fails
	/// without sending anything when the user is still active shortly before
	/// the run's deadline (one quiet period without one).
	pub(super) fn admit(&self) -> CoreResult<u64> {
		let deadline = control::current_token().and_then(|token| token.deadline());
		self.admit_with(admission_limit(Instant::now(), deadline), Instant::now, control::wait)
	}

	fn admit_with(
		&self,
		limit: Instant,
		now: impl Fn() -> Instant,
		mut wait: impl FnMut(Duration) -> CoreResult<()>,
	) -> CoreResult<u64> {
		loop {
			let count = self.presses.count.load(Ordering::Acquire);
			let last = *self.presses.last.lock();
			match admission(last, now(), limit) {
				Admission::Start => return Ok(count),
				Admission::Wait(duration) => wait(duration)?,
				Admission::Refuse(idle) => {
					return Err(DesktopError::user_intervened(format!(
						"the user is still typing or clicking (last press {:.1} s ago), so no takeover \
						 started; nothing was sent; try again once they pause",
						idle.as_secs_f64(),
					)));
				},
			}
		}
	}

	/// Refuses once the user has pressed a key or button since `baseline`.
	pub(super) fn check(&self, baseline: u64) -> CoreResult<()> {
		check_presses(baseline, self.presses.count.load(Ordering::Acquire))
	}

	#[cfg(test)]
	pub(super) fn presses(&self) -> u64 {
		self.presses.count.load(Ordering::Acquire)
	}

	/// Waits until the listener has recorded `count` presses.
	#[cfg(test)]
	pub(super) fn wait_for_presses(&self, count: u64) {
		let mut last = self.presses.last.lock();
		self
			.presses
			.recorded
			.wait_while(&mut last, |_| self.presses() < count);
	}
}

impl Drop for UserActivity {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("cannot watch the user's X11 input: {error}"))
}

fn admission_limit(now: Instant, deadline: Option<Instant>) -> Instant {
	deadline
		.map_or(now + QUIET, |deadline| deadline.checked_sub(DEADLINE_MARGIN).unwrap_or(deadline))
}

#[derive(Debug, PartialEq, Eq)]
enum Admission {
	Start,
	Wait(Duration),
	/// Still active at the limit, last press this long ago.
	Refuse(Duration),
}

fn admission(last: Option<Instant>, now: Instant, limit: Instant) -> Admission {
	let Some(last) = last else {
		return Admission::Start;
	};
	let idle = now.saturating_duration_since(last);
	if idle >= QUIET {
		Admission::Start
	} else if now >= limit {
		Admission::Refuse(idle)
	} else {
		Admission::Wait((last + QUIET).min(limit).saturating_duration_since(now))
	}
}

fn check_presses(baseline: u64, count: u64) -> CoreResult<()> {
	if count == baseline {
		return Ok(());
	}
	Err(DesktopError::user_intervened(format!(
		"the user pressed a key or clicked during this takeover; input sent before that may already \
		 have landed, and nothing more was sent; {READ_AGAIN}"
	)))
}

fn listen(display: Option<&str>) -> CoreResult<RustConnection> {
	let (conn, screen) = x11rb::connect(display).map_err(failed)?;
	// XI 2.0 clients get no raw events while another client grabs the device,
	// as an open menu or a launcher does.
	conn
		.xinput_xi_query_version(2, 2)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	let root = conn.setup().roots[screen].root;
	conn
		.xinput_xi_select_events(root, &[
			EventMask {
				deviceid: Device::ALL_MASTER.into(),
				mask:     vec![XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_BUTTON_PRESS],
			},
			EventMask { deviceid: Device::ALL.into(), mask: vec![XIEventMask::HIERARCHY] },
		])
		.map_err(failed)?
		.check()
		.map_err(failed)?;
	conn.flush().map_err(failed)?;
	Ok(conn)
}

/// Records presses until `stopped` closes. A broken connection ends the
/// listener, leaving the count where it was.
fn run(conn: &RustConnection, stopped: &UnixStream, presses: &Presses, sent: &AtomicU64) {
	let mut sources = Sources::default();
	let mut descriptors =
		[libc::pollfd { fd: stopped.as_raw_fd(), events: libc::POLLIN, revents: 0 }, libc::pollfd {
			fd:      conn.stream().as_raw_fd(),
			events:  libc::POLLIN,
			revents: 0,
		}];
	loop {
		loop {
			match conn.poll_for_event() {
				Ok(Some(event)) => {
					let sent = sent.load(Ordering::Acquire);
					if sources.step(&event, sent, |device| source_of(conn, device)) {
						presses.record(Instant::now());
					}
				},
				Ok(None) => break,
				Err(_) => return,
			}
		}
		// SAFETY: both descriptors are borrowed live for this blocking call.
		let polled =
			unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as libc::nfds_t, -1) };
		if polled < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
			return;
		}
		if descriptors[0].revents != 0
			|| descriptors[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
		{
			return;
		}
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
	/// A device of the user's own.
	User,
	/// The core XTEST keyboard or pointer.
	Xtest,
	/// OMP's virtual devices and other masters' XTEST devices, whose keys do
	/// not follow the user's keyboard focus.
	Other,
}

#[derive(Default)]
struct Sources {
	/// Per source device until the device hierarchy changes, since a removed
	/// device's id is reused.
	devices: HashMap<u16, Source>,
	/// Presses from the core XTEST devices taken as this session's own.
	own:     u64,
}

impl Sources {
	/// Whether `event` is a press of the user's, given the `sent` presses this
	/// session has sent through XTEST so far.
	fn step(&mut self, event: &Event, sent: u64, read: impl FnOnce(u16) -> Source) -> bool {
		let source = match event {
			Event::XinputRawKeyPress(event) => event.sourceid,
			Event::XinputRawButtonPress(event) => event.sourceid,
			Event::XinputHierarchy(_) => {
				self.devices.clear();
				return false;
			},
			_ => return false,
		};
		match *self.devices.entry(source).or_insert_with(|| read(source)) {
			Source::User => true,
			Source::Other => false,
			// This session counts a press before sending it, so a press there
			// while some of its own are unseen is one of them.
			Source::Xtest if self.own < sent => {
				self.own += 1;
				false
			},
			Source::Xtest => true,
		}
	}
}

fn source_of(conn: &RustConnection, device: u16) -> Source {
	let info = conn
		.xinput_xi_query_device(device)
		.ok()
		.and_then(|cookie| cookie.reply().ok())
		.and_then(|reply| reply.infos.into_iter().next());
	let Some(info) = info else {
		return Source::Other;
	};
	let name = String::from_utf8_lossy(&info.name);
	if !matches!(info.type_, DeviceType::SLAVE_KEYBOARD | DeviceType::SLAVE_POINTER)
		|| name.starts_with("OMP MPX ")
	{
		Source::Other
	} else if name.starts_with("Virtual core XTEST ") {
		Source::Xtest
	} else if name.contains("XTEST") {
		Source::Other
	} else {
		Source::User
	}
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::xinput::{HierarchyEvent, RawButtonPressEvent, RawKeyPressEvent};

	use super::*;
	use crate::desktop::error::ErrorCode;

	fn key(sourceid: u16) -> Event {
		Event::XinputRawKeyPress(RawKeyPressEvent { sourceid, ..Default::default() })
	}

	#[test]
	fn a_takeover_waits_for_the_user_to_pause_and_refuses_at_the_limit() {
		let start = Instant::now();
		let limit = start + Duration::from_secs(30);
		assert_eq!(admission(None, start, limit), Admission::Start);
		assert_eq!(admission(Some(start), start + QUIET, limit), Admission::Start);
		assert_eq!(
			admission(Some(start), start + Duration::from_secs(1), limit),
			Admission::Wait(Duration::from_secs(4)),
		);
		// The wait ends at the limit, where a user still pressing refuses it.
		let near = start + Duration::from_secs(28);
		assert_eq!(admission(Some(near), near, limit), Admission::Wait(Duration::from_secs(2)));
		assert_eq!(admission(Some(near), limit, limit), Admission::Refuse(Duration::from_secs(2)));
		// Without a run deadline, one quiet period.
		assert_eq!(admission_limit(start, None), start + QUIET);
	}

	#[test]
	fn presses_during_the_wait_are_counted_and_extend_it() {
		let activity = UserActivity {
			presses: Arc::default(),
			sent:    Arc::default(),
			stop:    None,
			thread:  None,
		};
		let start = Instant::now();
		activity.presses.record(start);
		let clock = std::cell::Cell::new(start);
		let mut waits = Vec::new();
		let baseline = activity
			.admit_with(
				start + Duration::from_secs(60),
				|| clock.get(),
				|duration| {
					waits.push(duration);
					// The user presses again one second into the first wait.
					if waits.len() == 1 {
						activity
							.presses
							.record(clock.get() + Duration::from_secs(1));
					}
					clock.set(clock.get() + duration);
					Ok(())
				},
			)
			.expect("admitted once the user paused");
		assert_eq!(baseline, 2);
		assert_eq!(waits, [QUIET, Duration::from_secs(1)]);
	}

	#[test]
	fn a_press_during_the_takeover_stops_it_as_user_intervened() {
		assert!(check_presses(3, 3).is_ok());
		let error = check_presses(3, 4).expect_err("the user pressed");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("nothing more was sent"), "{}", error.message);
	}

	#[test]
	fn only_the_users_presses_count() {
		let mut sources = Sources::default();
		let kinds = |device| match device {
			9 => Source::User,
			2 => Source::Xtest,
			_ => Source::Other,
		};
		assert!(sources.step(&key(9), 0, kinds));
		assert!(!sources.step(&key(4), 0, kinds));
		assert!(sources.step(
			&Event::XinputRawButtonPress(RawButtonPressEvent { sourceid: 9, ..Default::default() }),
			0,
			|_| unreachable!("cached"),
		));
		// XTEST presses up to the session's own count are its own, and
		// another client's press there does not make later own ones count.
		assert!(!sources.step(&key(2), 1, kinds));
		assert!(!sources.step(&key(2), 2, kinds));
		assert!(sources.step(&key(2), 2, kinds));
		assert!(!sources.step(&key(2), 3, kinds));
		// A new hierarchy may give a removed device's id to another device.
		assert!(!sources.step(&Event::XinputHierarchy(HierarchyEvent::default()), 0, kinds));
		assert!(!sources.step(&key(9), 3, |_| Source::Other));
	}
}
