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
	collections::{HashMap, HashSet},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};
use x11rb::protocol::{Event, xinput::KeyEventFlags};

use super::listener::{Listener, Source, source_of};
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
		let presses = Arc::<Presses>::default();
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
			self.healthy()?;
			let count = self.presses.count.load(Ordering::Acquire);
			let last = self.presses.last.lock().unwrap_or(self.started);
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
		self.healthy()?;
		check_presses(baseline, self.presses.count.load(Ordering::Acquire))
	}

	fn healthy(&self) -> CoreResult<()> {
		if let Some(listener) = &self.listener {
			listener.check()?;
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
	held:    HashSet<(u16, u32)>,
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
			Event::XinputRawKeyRelease(event) => {
				self.held.remove(&(event.sourceid, event.detail));
				return Ok(false);
			},
			Event::XinputHierarchy(_) => {
				self.devices.clear();
				self.held.clear();
				return Ok(false);
			},
			_ => return Ok(false),
		};
		if let std::collections::hash_map::Entry::Vacant(entry) = self.devices.entry(source) {
			entry.insert(read(source)?);
		}
		let key = match event {
			Event::XinputRawKeyPress(event) => Some((source, event.detail)),
			_ => None,
		};
		let repeat = matches!(event, Event::XinputRawKeyPress(event)
			if event.flags.contains(KeyEventFlags::KEY_REPEAT));
		Ok(match self.devices[&source] {
			Source::User => true,
			Source::Other => false,
			Source::Xtest if repeat => !key.is_some_and(|key| self.held.contains(&key)),
			// This session counts a press before sending it, so a press there
			// while some of its own are unseen is one of them.
			Source::Xtest if self.own < sent => {
				if let Some(key) = key {
					self.held.insert(key);
				}
				self.own += 1;
				false
			},
			Source::Xtest => {
				if let Some(key) = key {
					self.held.remove(&key);
				}
				true
			},
		})
	}
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::xinput::{HierarchyEvent, RawButtonPressEvent, RawKeyPressEvent};

	use super::*;

	fn key(sourceid: u16) -> Event {
		Event::XinputRawKeyPress(RawKeyPressEvent { sourceid, ..Default::default() })
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
		let repeat = Event::XinputRawKeyPress(RawKeyPressEvent {
			sourceid: 2,
			flags: KeyEventFlags::KEY_REPEAT,
			..Default::default()
		});
		assert!(!sources.step(&repeat, 2, kinds).unwrap(), "our held key repeats");
		assert!(sources.step(&key(2), 2, kinds).unwrap());
		assert!(sources.step(&repeat, 2, kinds).unwrap(), "a remote user's held key repeats");
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
