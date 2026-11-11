//! Where the user's clicks went, read off each press and release as the
//! session's user-input tap sees it: the process `WindowServer` routed the
//! press to, and for a release that ends a drag-and-drop session, the owner
//! of the window it was released over. Nothing here waits on another app, so
//! a click in an app too busy to answer accessibility is placed as it
//! happens.

use std::{
	collections::VecDeque,
	time::{Duration, Instant},
};

use libc::pid_t;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication};
use parking_lot::Mutex;

use super::{
	input::drag_pasteboard_count,
	permission::responsible_pid,
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
	/// window a drag-and-drop session was released over; with the app a
	/// press's process draws for, when it is no app of its own.
	To(pid_t, Option<pid_t>),
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
	base:    [u32; 6],
	/// Button events of each [`MOUSE_BUTTON_EVENTS`] type the tap has seen
	/// that the HID counters count too.
	seen:    [u32; 6],
	/// What a click older than every one in `recent` counts as: in the
	/// user's app once the journal starts, since nothing from before then
	/// can be read any more, and after the tap missed events that a tool
	/// swallowed before the session's tap, which kept them from every app;
	/// unknown after macOS disabled the tap, when they reached apps unseen.
	before:  Option<bool>,
	/// macOS disabled the tap since the record started.
	lost:    bool,
	/// The user's button events of each type the HID counters never
	/// counted, such as a remote tool's posts to the session tap, and when
	/// the tap delivered the latest; kept across restarts, so readings only
	/// ever count up.
	skipped: ([u32; 6], Option<Instant>),
	/// Counted events of each type the tap had not delivered when the record
	/// gave up on them, kept across restarts: the next ones of that type the
	/// tap delivers beyond the counters pay these off rather than count as
	/// skipped, since one delivered late was counted already. One a tool
	/// swallowed stays owed, so the next post the counters skip goes unseen.
	owed:    [u32; 6],
	recent:  VecDeque<Button>,
}

impl Default for ClickJournal {
	fn default() -> Self {
		Self(Mutex::new(Journal {
			base:    [0; 6],
			seen:    [0; 6],
			before:  None,
			lost:    false,
			skipped: ([0; 6], None),
			owed:    [0; 6],
			recent:  VecDeque::with_capacity(RECENT),
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
		let at = Instant::now();
		// The tap's thread has no autorelease pool of its own.
		let drags = autoreleasepool(|_| drag_pasteboard_count());
		let host = if kind % 2 == 0 {
			pid_t::try_from(target)
				.ok()
				.filter(|&pid| pid > 0)
				.and_then(service_host)
		} else {
			None
		};
		// Asked outside the lock, which a reading must not wait on
		// `WindowServer` for.
		let dropped = self.0.lock().dropped(kind, drags);
		let owner = dropped
			.then(|| u32::try_from(window).ok().and_then(window_owner_pid))
			.flatten();
		let mut journal = self.0.lock();
		// Read under the lock, after `WindowServer` counted this event.
		let hid = hid_buttons();
		journal.record(kind, Routed { target, host }, drags, owner, hid, at);
	}

	/// What a reading of the user's clicks sees now: the HID button counters
	/// plus the user's presses and releases they skipped, and when the latest
	/// skipped one came. It also says whether the latest click went to the
	/// user's app rather than the target: `None` while the tap has not
	/// delivered it yet or missed it.
	pub(in crate::desktop) fn place(&self, apps: Apps) -> Reading {
		let mut journal = self.0.lock();
		// Read under the lock, after `seen`.
		let hid = hid_buttons();
		let idle = since_last_click().is_some_and(|since| since > DELIVERY);
		journal.reading(apps, hid, idle)
	}
}

/// The user's app and the target of an action, as a reading tells their
/// clicks apart.
#[derive(Clone, Copy, Debug)]
pub(in crate::desktop) struct Apps {
	user:    pid_t,
	target:  pid_t,
	/// A press routed to a process that is no app of its own counts for the
	/// app macOS holds responsible for it.
	helpers: bool,
}

impl Apps {
	pub(in crate::desktop) fn new(user: pid_t, target: pid_t) -> Self {
		Self::hosted(user, target, responsible_pid(user), responsible_pid(target))
	}

	/// The two apps, with the processes macOS holds responsible for each.
	/// Helpers count for their app only while those differ: responsibility
	/// is inherited, so a target started from the user's terminal has the
	/// terminal responsible for it and for the services drawing its panels,
	/// as a user's app started from the target has the target.
	fn hosted(
		user: pid_t,
		target: pid_t,
		user_host: Option<pid_t>,
		target_host: Option<pid_t>,
	) -> Self {
		Self { user, target, helpers: user_host != target_host }
	}
}

/// One reading of the journal, as [`ClickJournal::place`] returns it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::desktop) struct Reading {
	/// `WindowServer`'s HID button counters, plus the user's button events
	/// they never counted, such as a remote tool's posts to the session tap.
	pub buttons: [u32; 6],
	/// Whether the latest click went to the user's app.
	pub placed:  Option<bool>,
	/// When the tap delivered the latest event the counters never counted.
	pub skipped: Option<Instant>,
}

/// The process a press was routed to, as the tap reads it.
#[derive(Clone, Copy)]
struct Routed {
	/// `kCGEventTargetUnixProcessID`.
	target: i64,
	/// The app the process works for, when it is no app of its own.
	host:   Option<pid_t>,
}

/// The app `pid` draws for, when it is not a regular app itself: a view
/// service such as `openAndSavePanelService` draws a sandboxed app's Open
/// panel, and macOS holds that app responsible for it. A regular app is
/// never mapped: one started from a terminal has the terminal responsible
/// for it, yet a click on it is a click on it.
fn service_host(pid: pid_t) -> Option<pid_t> {
	let regular = autoreleasepool(|_| {
		NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			.is_some_and(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
	});
	if regular {
		return None;
	}
	responsible_pid(pid).filter(|&host| host != pid)
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
	/// Returns how many events beyond `WindowServer`'s count that was, less
	/// any [`Self::owed`] it pays off.
	fn see(&mut self, kind: usize, hid: [u32; 6]) -> u32 {
		self.seen[kind] = self.seen[kind].wrapping_add(1);
		let counted = hid[kind].wrapping_sub(self.base[kind]);
		let beyond = self.seen[kind].wrapping_sub(counted);
		// Wrapping difference: positive when the tap saw more.
		if beyond as i32 > 0 {
			self.base[kind] = hid[kind].wrapping_sub(self.seen[kind]);
			let late = beyond.min(self.owed[kind]);
			self.owed[kind] -= late;
			return beyond - late;
		}
		0
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
		routed: Routed,
		drags: isize,
		owner: Option<pid_t>,
		hid: [u32; 6],
		at: Instant,
	) {
		let beyond = self.see(kind, hid);
		if beyond > 0 {
			self.skipped.0[kind] = self.skipped.0[kind].wrapping_add(beyond);
			self.skipped.1 = Some(at);
		}
		let went = if kind % 2 == 0 {
			match pid_t::try_from(routed.target) {
				Ok(pid) if pid > 0 => Went::To(pid, routed.host),
				_ => Went::Nowhere,
			}
		} else {
			match self.press(kind) {
				Some(press) if press.drags != drags => {
					owner.map_or(press.went, |owner| Went::To(owner, None))
				},
				Some(press) => press.went,
				None => Went::Before,
			}
		};
		if self.recent.len() == RECENT {
			self.recent.pop_front();
		}
		self.recent.push_back(Button { kind, went, drags });
	}

	/// Whether the latest click the HID counters `hid` count went to the
	/// user's app; `None` while the tap trails `WindowServer`. Once no
	/// button event has come for [`DELIVERY`] (`idle`), an event the tap
	/// still has not delivered is lost: the record starts again. What it
	/// missed counts as in the user's app, since a tool that swallows a
	/// button before the session's tap, as remappers do, delivers it to no
	/// app; after macOS disabled the tap it is unknown, as those events
	/// reached apps.
	///
	/// A press routed to the target goes to it; one routed to the user's
	/// app, or while `apps.helpers` to a process that is no app of its
	/// own and draws for the user's app, such as the service that draws a
	/// sandboxed app's Open panel, goes to the user's app.
	fn place(&mut self, apps: Apps, hid: [u32; 6], idle: bool) -> Option<bool> {
		let behind =
			(0..hid.len()).any(|kind| self.seen[kind] != hid[kind].wrapping_sub(self.base[kind]));
		if behind {
			if idle {
				let lost = self.lost;
				for (kind, owed) in self.owed.iter_mut().enumerate() {
					let counted = hid[kind].wrapping_sub(self.base[kind]);
					*owed = owed.wrapping_add(counted.wrapping_sub(self.seen[kind]));
				}
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
			Went::To(pid, _) if pid == apps.target => Some(false),
			Went::To(pid, host) => Some(pid == apps.user || (apps.helpers && host == Some(apps.user))),
			Went::Nowhere => Some(false),
			Went::Before => self.before,
		}
	}

	/// A reading at HID counters `hid`: see [`ClickJournal::place`].
	fn reading(&mut self, apps: Apps, hid: [u32; 6], idle: bool) -> Reading {
		let placed = self.place(apps, hid, idle);
		let mut buttons = hid;
		for (button, skipped) in buttons.iter_mut().zip(self.skipped.0) {
			*button = button.wrapping_add(skipped);
		}
		Reading { buttons, placed, skipped: self.skipped.1 }
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
	const PANEL_SERVICE: pid_t = 40;
	const OTHER_APP: pid_t = 50;
	const LEFT_DOWN: usize = 0;
	const LEFT_UP: usize = 1;
	const OTHER_DOWN: usize = 4;

	/// A journal started at `WindowServer`'s HID counters `hid`, which the
	/// tests move on as `WindowServer` counts events, before or after the
	/// tap delivers them; read for `apps`, by default the user's app and the
	/// target each launched on its own.
	struct Session {
		journal: Journal,
		hid:     [u32; 6],
		apps:    Apps,
	}

	impl Session {
		fn started() -> Self {
			let hid = [5, 5, 0, 0, 0, 0];
			let mut journal = ClickJournal::default().0.into_inner();
			journal.start(hid);
			Self { journal, hid, apps: Apps::hosted(USER, TARGET, Some(USER), Some(TARGET)) }
		}

		/// `WindowServer` counts an event of `kind`.
		fn counted(&mut self, kind: usize) {
			self.hid[kind] += 1;
		}

		/// The tap delivers the user's event of `kind`, routed to `target`,
		/// with the drag pasteboard at `drags` and `owner` under the pointer.
		fn delivered(&mut self, kind: usize, target: pid_t, drags: isize, owner: Option<pid_t>) {
			self.routed(kind, Routed { target: i64::from(target), host: None }, drags, owner);
		}

		/// As [`Self::delivered`], with the press's process as the tap reads it.
		fn routed(&mut self, kind: usize, routed: Routed, drags: isize, owner: Option<pid_t>) {
			self
				.journal
				.record(kind, routed, drags, owner, self.hid, Instant::now());
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
			self.reading(idle).placed
		}

		fn reading(&mut self, idle: bool) -> Reading {
			self.journal.reading(self.apps, self.hid, idle)
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

	#[test]
	fn a_press_the_counters_skip_reaches_a_reading_as_a_click_with_its_time() {
		// A remote tool's click on the target, posted to the session tap:
		// the tap delivers it, the HID counters never count it.
		let mut session = Session::started();
		let before = session.reading(false);
		assert_eq!(before.skipped, None);
		let posted = Instant::now();
		session.delivered(LEFT_DOWN, TARGET, 3, None);
		let pressed = session.reading(false);
		assert_eq!(pressed.buttons, [6, 5, 0, 0, 0, 0], "a reading sees the press");
		assert_eq!(pressed.placed, Some(false));
		assert!(pressed.skipped.is_some_and(|at| at >= posted));
		session.delivered(LEFT_UP, 0, 3, None);
		assert_eq!(session.reading(false).buttons, [6, 6, 0, 0, 0, 0]);
		// A restart after a missed event keeps the count, so readings never
		// go back.
		session.counted(OTHER_DOWN);
		session.reading(true);
		assert_eq!(session.reading(false).buttons, [6, 6, 0, 0, 1, 0]);
	}

	#[test]
	fn a_press_the_tap_delivers_after_a_reading_gave_up_on_it_counts_once() {
		// The user's press in their own app, which `WindowServer` counted, comes
		// through the tap only after a reading gave up waiting for it.
		let mut session = Session::started();
		session.counted(LEFT_DOWN);
		assert_eq!(session.reading(true).placed, None);
		session.delivered(LEFT_DOWN, USER, 3, None);
		let late = session.reading(false);
		assert_eq!(late.buttons, [6, 5, 0, 0, 0, 0], "one press, read once");
		assert_eq!(late.skipped, None);
		assert_eq!(late.placed, Some(true));
		// Paid off: the next press the counters skip reaches readings again.
		session.delivered(LEFT_DOWN, TARGET, 3, None);
		assert_eq!(session.reading(false).buttons, [7, 5, 0, 0, 0, 0]);
	}

	#[test]
	fn a_press_the_counters_skip_after_a_swallowed_one_goes_unseen() {
		// A press a remapping tool swallowed stays owed once given up, so a
		// remote tool's next press on the target, posted to the session tap,
		// pays it off instead of reaching readings as a click.
		let mut session = Session::started();
		session.counted(LEFT_DOWN);
		session.reading(true);
		assert_eq!(session.place(false), Some(true));
		session.delivered(LEFT_DOWN, TARGET, 3, None);
		let posted = session.reading(false);
		assert_eq!(posted.buttons, [6, 5, 0, 0, 0, 0], "no new press");
		assert_eq!(posted.skipped, None);
		assert_eq!(posted.placed, Some(false));
	}

	#[test]
	fn a_press_goes_to_the_target_then_the_user_then_the_app_a_service_draws_for() {
		let press = |target: pid_t, host: Option<pid_t>| {
			let mut session = Session::started();
			let routed = Routed { target: i64::from(target), host };
			session.counted(LEFT_DOWN);
			session.routed(LEFT_DOWN, routed, 3, None);
			session.place(false)
		};
		// The target, even when it works for the user's app.
		assert_eq!(press(TARGET, Some(USER)), Some(false));
		assert_eq!(press(USER, None), Some(true));
		// The service drawing the user's app's Open panel.
		assert_eq!(press(PANEL_SERVICE, Some(USER)), Some(true));
		assert_eq!(press(PANEL_SERVICE, Some(OTHER_APP)), Some(false));
		// A regular app, which `service_host` never maps.
		assert_eq!(press(OTHER_APP, None), Some(false));
	}

	#[test]
	fn a_service_counts_for_its_app_only_while_the_two_apps_have_different_hosts() {
		let press = |apps: Apps| {
			let mut session = Session { apps, ..Session::started() };
			let routed = Routed { target: i64::from(PANEL_SERVICE), host: Some(USER) };
			session.counted(LEFT_DOWN);
			session.routed(LEFT_DOWN, routed, 3, None);
			session.place(false)
		};
		// Each app launched on its own.
		assert_eq!(press(Apps::hosted(USER, TARGET, Some(USER), Some(TARGET))), Some(true));
		// The target started from the user's terminal, which macOS then holds
		// responsible for the service drawing the target's own Open panel;
		// the user's app started from the target; both started from one
		// terminal. Nothing is mapped.
		for host in [USER, TARGET, OTHER_APP] {
			assert_eq!(press(Apps::hosted(USER, TARGET, Some(host), Some(host))), Some(false));
		}
	}
}
