//! Where the user's clicks went, read off each press and release as the
//! session's user-input tap sees it: the process `WindowServer` routed the
//! press to, and for a release that ends a drag-and-drop session, the owner
//! of the window it was released over. Nothing here waits on another app, so
//! a click in an app too busy to answer accessibility is placed as it
//! happens.

use std::{collections::VecDeque, time::Duration};

use libc::pid_t;
use objc2::rc::autoreleasepool;
use parking_lot::Mutex;

use super::{
	input::drag_pasteboard_count,
	skylight::{MOUSE_BUTTON_EVENTS, hid_buttons, since_last_click, window_owner_pid},
};

/// How many of the latest presses and releases the journal keeps: enough to
/// find the press of the latest release.
const RECENT: usize = 8;

/// How long after `WindowServer` last counted a button event the tap may
/// still be delivering it; one it has not delivered by then it missed.
const DELIVERY: Duration = Duration::from_millis(50);

/// Where one of the user's presses or releases went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Went {
	/// To this process: the one a press was routed to, or the owner of the
	/// window a drag-and-drop session was released over.
	To(pid_t),
	/// To no process: a press `WindowServer` named no target for.
	Nowhere,
	/// Where a click from before the journal's record went: a release whose
	/// press is not in it.
	Before,
}

#[derive(Clone, Copy)]
struct Button {
	/// Index of the event's type in [`MOUSE_BUTTON_EVENTS`]; even for a
	/// press, odd for its release.
	kind:  usize,
	went:  Went,
	/// The drag pasteboard's change count when it happened.
	drags: isize,
}

/// The session's record of the user's mouse button presses and releases,
/// next to how many button events of each type its tap has seen.
pub(crate) struct ClickJournal(Mutex<Journal>);

struct Journal {
	/// `WindowServer`'s HID button counters at the start of `seen`.
	base:   [u32; 6],
	/// Button events of each [`MOUSE_BUTTON_EVENTS`] type the tap has seen
	/// that the HID counters count too.
	seen:   [u32; 6],
	/// What a click older than every one in `recent` counts as: in the
	/// user's app once the journal starts, since nothing from before then
	/// can be read any more, and after the tap missed events that a tool
	/// swallowed before the session's tap, which kept them from every app;
	/// unknown after macOS disabled the tap, when they reached apps unseen.
	before: Option<bool>,
	/// macOS disabled the tap since the record started.
	lost:   bool,
	recent: VecDeque<Button>,
}

impl Default for ClickJournal {
	fn default() -> Self {
		Self(Mutex::new(Journal {
			base:   [0; 6],
			seen:   [0; 6],
			before: None,
			lost:   false,
			recent: VecDeque::with_capacity(RECENT),
		}))
	}
}

impl ClickJournal {
	/// Starts the record as the session's tap starts.
	pub(crate) fn start(&self) {
		self.0.lock().start(hid_buttons());
	}

	/// macOS disabled the session's tap, which then missed every event until
	/// it was enabled again.
	pub(crate) fn lost(&self) {
		self.0.lock().lost = true;
	}

	/// A button event of `kind` the HID counters count that is not the
	/// user's: one this process posted to the HID event tap.
	pub(crate) fn count(&self, kind: u32) {
		if let Some(kind) = index(kind) {
			let mut journal = self.0.lock();
			journal.see(kind, hid_buttons());
		}
	}

	/// The user's press or release of `kind`, routed to process `target`,
	/// with `window` under the pointer.
	pub(crate) fn record(&self, kind: u32, target: i64, window: i64) {
		let Some(kind) = index(kind) else {
			return;
		};
		// The tap's thread has no autorelease pool of its own.
		let drags = autoreleasepool(|_| drag_pasteboard_count());
		// Asked outside the lock, which a reading must not wait on
		// `WindowServer` for.
		let dropped = self.0.lock().dropped(kind, drags);
		let owner = dropped
			.then(|| u32::try_from(window).ok().and_then(window_owner_pid))
			.flatten();
		let mut journal = self.0.lock();
		// Read under the lock, after `WindowServer` counted this event.
		let hid = hid_buttons();
		journal.record(kind, target, drags, owner, hid);
	}

	/// The HID button counters now, and whether the latest click they count
	/// went to `user`'s app; `None` while the tap has not delivered it yet or
	/// missed it.
	pub(in crate::desktop) fn place(&self, user: pid_t) -> ([u32; 6], Option<bool>) {
		let mut journal = self.0.lock();
		// Read under the lock, after `seen`.
		let hid = hid_buttons();
		let idle = since_last_click().is_some_and(|since| since > DELIVERY);
		(hid, journal.place(user, hid, idle))
	}
}

impl Journal {
	/// Starts the record at HID counters `hid`: a click from before it counts
	/// as in the user's app.
	fn start(&mut self, hid: [u32; 6]) {
		self.base = hid;
		self.seen = [0; 6];
		self.before = Some(true);
		self.lost = false;
		self.recent.clear();
	}

	/// Counts a button event of `kind` the tap delivers, with the HID
	/// counters `hid` read after `WindowServer` counted it. The tap then
	/// never counts more than `WindowServer` did: an event beyond that is one
	/// the HID counters skip, or one counted before the record started, and
	/// moves `base` on rather than stand in for an event still on its way.
	const fn see(&mut self, kind: usize, hid: [u32; 6]) {
		self.seen[kind] = self.seen[kind].wrapping_add(1);
		let counted = hid[kind].wrapping_sub(self.base[kind]);
		// Wrapping difference: positive when the tap saw more.
		if self.seen[kind].wrapping_sub(counted) as i32 > 0 {
			self.base[kind] = hid[kind].wrapping_sub(self.seen[kind]);
		}
	}

	/// The press a release of `kind` ends, if the journal has it.
	fn press(&self, kind: usize) -> Option<&Button> {
		if kind % 2 == 0 {
			return None;
		}
		self
			.recent
			.iter()
			.rev()
			.find(|button| button.kind + 1 == kind)
	}

	/// Whether a release of `kind` ends a drag-and-drop session: the drag
	/// pasteboard's count moved on since its press.
	fn dropped(&self, kind: usize, drags: isize) -> bool {
		self.press(kind).is_some_and(|press| press.drags != drags)
	}

	/// Records a press routed to `target`, or a release: one ends the click
	/// its press began, wherever the pointer is, unless it [`Self::dropped`]
	/// on the app whose window it is released over (`owner`). A text
	/// selection, a resize, a window move or a drag across the menu bar
	/// carries nothing to another app.
	fn record(
		&mut self,
		kind: usize,
		target: i64,
		drags: isize,
		owner: Option<pid_t>,
		hid: [u32; 6],
	) {
		self.see(kind, hid);
		let went = if kind % 2 == 0 {
			match pid_t::try_from(target) {
				Ok(pid) if pid > 0 => Went::To(pid),
				_ => Went::Nowhere,
			}
		} else {
			match self.press(kind) {
				Some(press) if press.drags != drags => owner.map_or(press.went, Went::To),
				Some(press) => press.went,
				None => Went::Before,
			}
		};
		if self.recent.len() == RECENT {
			self.recent.pop_front();
		}
		self.recent.push_back(Button { kind, went, drags });
	}

	/// Whether the latest click the HID counters `hid` count went to
	/// `user`'s app; `None` while the tap trails `WindowServer`. Once no
	/// button event has come for [`DELIVERY`] (`idle`), an event the tap
	/// still has not delivered is lost: the record starts again. What it
	/// missed counts as in the user's app, since a tool that swallows a
	/// button before the session's tap, as remappers do, delivers it to no
	/// app; after macOS disabled the tap it is unknown, as those events
	/// reached apps.
	fn place(&mut self, user: pid_t, hid: [u32; 6], idle: bool) -> Option<bool> {
		let behind =
			(0..hid.len()).any(|kind| self.seen[kind] != hid[kind].wrapping_sub(self.base[kind]));
		if behind {
			if idle {
				let lost = self.lost;
				self.start(hid);
				if lost {
					self.before = None;
				}
			}
			return None;
		}
		match self
			.recent
			.back()
			.map_or(Went::Before, |button| button.went)
		{
			Went::To(pid) => Some(pid == user),
			Went::Nowhere => Some(false),
			Went::Before => self.before,
		}
	}
}

/// Index of mouse button event `kind` in [`MOUSE_BUTTON_EVENTS`].
fn index(kind: u32) -> Option<usize> {
	MOUSE_BUTTON_EVENTS
		.iter()
		.position(|&button| button == kind)
}

#[cfg(test)]
mod tests {
	use super::*;

	const USER: pid_t = 10;
	const TARGET: pid_t = 20;
	const WINDOW_SERVER: pid_t = 30;
	const LEFT_DOWN: usize = 0;
	const LEFT_UP: usize = 1;
	const OTHER_DOWN: usize = 4;

	/// A journal started at `WindowServer`'s HID counters `hid`, which the
	/// tests move on as `WindowServer` counts events, before or after the
	/// tap delivers them.
	struct Session {
		journal: Journal,
		hid:     [u32; 6],
	}

	impl Session {
		fn started() -> Self {
			let hid = [5, 5, 0, 0, 0, 0];
			let mut journal = ClickJournal::default().0.into_inner();
			journal.start(hid);
			Self { journal, hid }
		}

		/// `WindowServer` counts an event of `kind`.
		fn counted(&mut self, kind: usize) {
			self.hid[kind] += 1;
		}

		/// The tap delivers the user's event of `kind`, routed to `target`,
		/// with the drag pasteboard at `drags` and `owner` under the pointer.
		fn delivered(&mut self, kind: usize, target: pid_t, drags: isize, owner: Option<pid_t>) {
			self
				.journal
				.record(kind, i64::from(target), drags, owner, self.hid);
		}

		/// A user's event `WindowServer` counted and the tap delivered.
		fn user(&mut self, kind: usize, target: pid_t, drags: isize, owner: Option<pid_t>) {
			self.counted(kind);
			self.delivered(kind, target, drags, owner);
		}

		/// The user's left click, a press routed to `target` and its release
		/// over `owner`'s window, with the drag pasteboard at each.
		fn click(&mut self, target: pid_t, drags: (isize, isize), owner: Option<pid_t>) {
			self.user(LEFT_DOWN, target, drags.0, None);
			self.user(LEFT_UP, 0, drags.1, owner);
		}

		fn place(&mut self, idle: bool) -> Option<bool> {
			self.journal.place(USER, self.hid, idle)
		}
	}

	#[test]
	fn a_click_goes_where_its_press_was_routed_unless_it_ends_a_drag_and_drop() {
		// A press in the user's app, its release wherever the pointer is: a
		// text selection or resize ending over the target, or a drag across
		// the user's own menu bar, which `WindowServer` draws.
		for owner in [Some(USER), Some(TARGET), Some(WINDOW_SERVER), None] {
			let mut session = Session::started();
			session.click(USER, (3, 3), owner);
			assert_eq!(session.place(false), Some(true));
		}
		let mut session = Session::started();
		session.click(TARGET, (3, 3), Some(USER));
		assert_eq!(session.place(false), Some(false), "a press on the target picks it");
		// A drag-and-drop session from the user's app drops on the window it
		// is released over, or ends with its press where none is known.
		for (owner, placed) in [(Some(TARGET), false), (Some(USER), true), (None, true)] {
			let mut session = Session::started();
			assert!(!session.journal.dropped(LEFT_UP, 4), "nothing pressed yet");
			session.user(LEFT_DOWN, USER, 3, None);
			assert!(session.journal.dropped(LEFT_UP, 4));
			session.user(LEFT_UP, 0, 4, owner);
			assert_eq!(session.place(false), Some(placed));
		}
		// A press `WindowServer` named no target for is not the user's app.
		let mut session = Session::started();
		session.user(LEFT_DOWN, 0, 3, None);
		assert_eq!(session.place(false), Some(false));
	}

	#[test]
	fn a_click_waits_for_the_tap_to_deliver_every_button_event_counted() {
		let mut session = Session::started();
		// `WindowServer` counted a press the tap has not delivered yet.
		session.counted(LEFT_DOWN);
		assert_eq!(session.place(false), None);
		session.delivered(LEFT_DOWN, TARGET, 3, None);
		assert_eq!(session.place(false), Some(false));
		// Its release, counted but still on its way, leaves the click unknown:
		// it may end a drag-and-drop elsewhere.
		session.counted(LEFT_UP);
		assert_eq!(session.place(false), None);
		session.delivered(LEFT_UP, 0, 3, None);
		// So does this process's own press posted to the HID event tap until
		// the tap has seen it too.
		session.counted(LEFT_DOWN);
		assert_eq!(session.place(false), None);
		session.journal.see(LEFT_DOWN, session.hid);
		assert_eq!(session.place(false), Some(false));
	}

	#[test]
	fn an_event_the_counters_skip_does_not_stand_in_for_one_on_its_way() {
		// A press counted just before the record started and delivered after
		// it, or another tool's post to the session that the HID counters
		// skip: the tap sees one more than `WindowServer` counted.
		let mut session = Session::started();
		session.delivered(LEFT_DOWN, USER, 3, None);
		assert_eq!(session.place(false), Some(true));
		// The user's next press, counted but not delivered yet, is unknown
		// rather than placed where that one went.
		session.counted(LEFT_DOWN);
		assert_eq!(session.place(false), None);
		session.delivered(LEFT_DOWN, TARGET, 3, None);
		assert_eq!(session.place(false), Some(false));
		// So with a wrapped counter.
		let mut session = Session::started();
		session.hid = [u32::MAX, 0, 0, 0, 0, 0];
		session.journal.start(session.hid);
		session.delivered(LEFT_DOWN, USER, 3, None);
		session.hid[LEFT_DOWN] = 0;
		assert_eq!(session.place(false), None);
		session.delivered(LEFT_DOWN, TARGET, 3, None);
		assert_eq!(session.place(false), Some(false));
	}

	#[test]
	fn an_event_the_tap_never_delivers_counts_as_the_users_once_no_button_event_comes() {
		// A remapping tool swallows a side-button press in the user's app
		// that `WindowServer` counted: no app got it, so once it is given up
		// it counts as in the user's app, and later clicks are placed again.
		let mut session = Session::started();
		session.counted(OTHER_DOWN);
		assert_eq!(session.place(false), None);
		assert_eq!(session.place(true), None);
		assert_eq!(session.place(false), Some(true), "what the tap missed picked nothing");
		session.click(TARGET, (3, 3), None);
		assert_eq!(session.place(false), Some(false));
		session.click(USER, (3, 3), None);
		assert_eq!(session.place(false), Some(true));
	}

	#[test]
	fn a_click_missed_while_macos_disabled_the_tap_stays_unknown() {
		// While macOS had disabled the tap for a slow callback, the user's
		// clicks reached their apps unseen, the target's included: what the
		// tap missed then is unknown, not the user's app.
		let mut session = Session::started();
		session.counted(LEFT_DOWN);
		session.counted(LEFT_UP);
		session.journal.lost = true;
		assert_eq!(session.place(true), None);
		assert_eq!(session.place(false), None);
		session.click(USER, (3, 3), None);
		assert_eq!(session.place(false), Some(true));
	}

	#[test]
	fn a_click_from_before_the_record_counts_as_the_users() {
		let mut session = Session::started();
		// A click just before the tap started: its release comes without its
		// press, and nothing places either.
		assert_eq!(session.place(false), Some(true));
		session.user(LEFT_UP, 0, 3, Some(TARGET));
		assert_eq!(session.place(false), Some(true));
	}
}
