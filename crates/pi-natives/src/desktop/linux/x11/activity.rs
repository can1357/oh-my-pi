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
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use parking_lot::Mutex;
use x11rb::{
	connection::Connection as _,
	protocol::{Event, screensaver::ConnectionExt as _},
	rust_connection::RustConnection,
};

use super::listener::{Listener, Source, source_of};
use crate::desktop::{
	control::{self, USER_QUIET as QUIET},
	error::{CoreResult, DesktopError},
};

const READ_AGAIN: &str =
	"read the window again (win.ax(), win.observe() or win.screenshot()) before acting on it";

#[derive(Default)]
struct Presses {
	count: AtomicU64,
	last:  Mutex<Option<Instant>>,
}

impl Presses {
	fn record(&self, at: Instant) {
		let mut last = self.last.lock();
		*last = Some(at);
		self.count.fetch_add(1, Ordering::AcqRel);
	}
}

/// Session-lived listener for the user's presses.
pub(super) struct UserActivity {
	presses:  Arc<Presses>,
	/// Key and button presses this session sent through XTEST.
	sent:     Arc<AtomicU64>,
	listener: Option<Listener>,
	started:  Instant,
}

impl UserActivity {
	pub(super) fn start(display: Option<&str>) -> CoreResult<Self> {
		let conn = Listener::connect(display)?;
		let started = Instant::now();
		// Presses before the listener started are unseen; the server's idle time
		// says how long the user has left input alone, so the first takeover
		// need not wait a whole QUIET period from here.
		let presses = Arc::new(Presses {
			count: AtomicU64::new(0),
			last:  Mutex::new(user_idle(&conn).and_then(|idle| started.checked_sub(idle))),
		});
		let sent = Arc::new(AtomicU64::new(0));
		let listener = {
			let (presses, sent) = (Arc::clone(&presses), Arc::clone(&sent));
			let mut sources = Sources::default();
			Listener::start(
				conn,
				"desktop-user-activity",
				move |conn, event| {
					if sources
						.step(&event, sent.load(Ordering::Acquire), |device| source_of(conn, device))?
					{
						presses.record(Instant::now());
					}
					Ok(())
				},
				|| {},
			)?
		};
		Ok(Self { presses, sent, listener: Some(listener), started })
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
			let held = self.inputs_held()?;
			let count = self.presses.count.load(Ordering::Acquire);
			let now = now();
			let last = if held {
				now
			} else {
				self.presses.last.lock().unwrap_or(self.started)
			};
			match admission(last, now, limit) {
				Admission::Start => return Ok(count),
				Admission::Wait(duration) => wait(duration)?,
				Admission::Refuse(idle) => return Err(control::still_active_refusal(idle)),
			}
		}
	}

	/// Refuses once the user has pressed a key or button since `baseline`.
	pub(super) fn check(&self, baseline: u64) -> CoreResult<()> {
		self.sync()?;
		check_presses(baseline, self.presses.count.load(Ordering::Acquire))
	}

	pub(super) fn check_admission(&self, baseline: u64) -> CoreResult<()> {
		if self.inputs_held()? {
			return Err(DesktopError::user_intervened(
				"the user is holding a key or button, so no takeover started; nothing was sent",
			));
		}
		check_presses(baseline, self.presses.count.load(Ordering::Acquire))
	}

	fn inputs_held(&self) -> CoreResult<bool> {
		self
			.listener
			.as_ref()
			.map_or(Ok(false), Listener::inputs_held)
	}

	pub(super) fn sync(&self) -> CoreResult<()> {
		if let Some(listener) = &self.listener {
			listener.sync()?;
		}
		Ok(())
	}

	#[cfg(test)]
	pub(super) fn presses(&self) -> u64 {
		self.presses.count.load(Ordering::Acquire)
	}

	#[cfg(test)]
	pub(super) fn disconnect(&mut self, conn: &x11rb::rust_connection::RustConnection) {
		self.listener.as_mut().expect("listening").disconnect(conn);
	}
}

/// How long ago the server last saw user input from any device, when it
/// reports it (MIT-SCREEN-SAVER).
fn user_idle(conn: &RustConnection) -> Option<Duration> {
	let root = conn.setup().roots.first()?.root;
	let info = conn.screensaver_query_info(root).ok()?.reply().ok()?;
	Some(Duration::from_millis(info.ms_since_user_input.into()))
}

fn admission_limit(now: Instant, deadline: Option<Instant>) -> Instant {
	deadline.map_or(now + QUIET, |deadline| {
		deadline
			.checked_sub(control::DEADLINE_MARGIN)
			.unwrap_or(deadline)
	})
}

#[derive(Debug, PartialEq, Eq)]
enum Admission {
	Start,
	Wait(Duration),
	/// Still active at the limit, last press this long ago.
	Refuse(Duration),
}

fn admission(last: Instant, now: Instant, limit: Instant) -> Admission {
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
	fn step(
		&mut self,
		event: &Event,
		sent: u64,
		read: impl FnOnce(u16) -> CoreResult<Source>,
	) -> CoreResult<bool> {
		let source = match event {
			Event::XinputRawKeyPress(event) => event.sourceid,
			Event::XinputRawButtonPress(event) => event.sourceid,
			Event::XinputRawKeyRelease(_) => return Ok(false),
			Event::XinputHierarchy(_) => {
				self.devices.clear();
				return Ok(false);
			},
			_ => return Ok(false),
		};
		if let std::collections::hash_map::Entry::Vacant(entry) = self.devices.entry(source) {
			entry.insert(read(source)?);
		}
		Ok(match self.devices[&source] {
			Source::User => true,
			Source::Other => false,
			// This session counts a press before sending it, so a press there
			// while some of its own are unseen is one of them.
			Source::Xtest if self.own < sent => {
				self.own += 1;
				false
			},
			Source::Xtest => true,
		})
	}
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::xinput::{
		HierarchyEvent, KeyEventFlags, RawButtonPressEvent, RawKeyPressEvent,
	};

	use super::*;

	fn key(sourceid: u16) -> Event {
		Event::XinputRawKeyPress(RawKeyPressEvent { sourceid, ..Default::default() })
	}

	#[test]
	fn named_change_raw_flags_do_not_change_own_press_accounting() {
		let mut sources = Sources::default();
		// Raw presses do not carry KEY_REPEAT. Even an otherwise flagged
		// raw event must consume the outstanding own press, not invent one.
		let event = Event::XinputRawKeyPress(RawKeyPressEvent {
			sourceid: 2,
			flags: KeyEventFlags::KEY_REPEAT,
			..Default::default()
		});
		assert!(!sources.step(&event, 1, |_| Ok(Source::Xtest)).unwrap());
		assert!(
			sources
				.step(&key(2), 1, |_| unreachable!("cached"))
				.unwrap()
		);
	}

	#[test]
	fn a_takeover_waits_for_the_user_to_pause_and_refuses_at_the_limit() {
		let start = Instant::now();
		let limit = start + Duration::from_secs(30);
		let activity = UserActivity {
			presses:  Arc::default(),
			sent:     Arc::default(),
			listener: None,
			started:  start,
		};
		let clock = std::cell::Cell::new(start);
		let mut waits = Vec::new();
		assert_eq!(
			activity
				.admit_with(
					limit,
					|| clock.get(),
					|duration| {
						waits.push(duration);
						clock.set(clock.get() + duration);
						Ok(())
					}
				)
				.unwrap(),
			0
		);
		assert_eq!(waits, [QUIET], "a fresh listener must observe a full quiet period");
		assert_eq!(admission(start, start + QUIET, limit), Admission::Start);
		assert_eq!(
			admission(start, start + Duration::from_secs(1), limit),
			Admission::Wait(Duration::from_secs(4)),
		);
		// The wait ends at the limit, where a user still pressing refuses it.
		let near = start + Duration::from_secs(28);
		assert_eq!(admission(near, near, limit), Admission::Wait(Duration::from_secs(2)));
		assert_eq!(admission(near, limit, limit), Admission::Refuse(Duration::from_secs(2)));
		// Without a run deadline, one quiet period.
		assert_eq!(admission_limit(start, None), start + QUIET);
	}

	#[test]
	fn presses_during_the_wait_are_counted_and_extend_it() {
		let activity = UserActivity {
			presses:  Arc::default(),
			sent:     Arc::default(),
			listener: None,
			started:  Instant::now(),
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
	fn only_the_users_presses_count() {
		let mut sources = Sources::default();
		let kinds = |device| {
			Ok(match device {
				9 => Source::User,
				2 => Source::Xtest,
				_ => Source::Other,
			})
		};
		assert!(sources.step(&key(9), 0, kinds).unwrap());
		assert!(!sources.step(&key(4), 0, kinds).unwrap());
		assert!(
			sources
				.step(
					&Event::XinputRawButtonPress(RawButtonPressEvent {
						sourceid: 9,
						..Default::default()
					}),
					0,
					|_| unreachable!("cached"),
				)
				.unwrap()
		);
		// XTEST presses up to the session's own count are its own, and
		// another client's press there does not make later own ones count.
		assert!(!sources.step(&key(2), 1, kinds).unwrap());
		assert!(!sources.step(&key(2), 2, kinds).unwrap());
		assert!(sources.step(&key(2), 2, kinds).unwrap());
		assert!(!sources.step(&key(2), 3, kinds).unwrap());
		// A new hierarchy may give a removed device's id to another device.
		assert!(
			!sources
				.step(&Event::XinputHierarchy(HierarchyEvent::default()), 0, kinds)
				.unwrap()
		);
		assert!(!sources.step(&key(9), 3, |_| Ok(Source::Other)).unwrap());
	}
}
