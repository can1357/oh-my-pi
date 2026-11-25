//! When the session last had input, so a takeover does not start while the
//! user is typing, clicking or moving the pointer: once the target is in front
//! it holds the keyboard, and the user's keys would land in it.
//!
//! Windows dates only the session's newest input, of any kind and from any
//! program (`GetLastInputInfo`), this process's own `SendInput` included. So
//! each of OMP's sends first reads the date it is about to overwrite, keeping
//! the input from before it, then records its window on the timer: from that
//! reading to the end of the send. A date inside OMP's newest window of at most
//! [`MAX_SEND`] is OMP's. Nothing is registered and no hook or thread is added.
#[cfg(target_os = "windows")]
use std::cell::Cell;
use std::time::Duration;

#[cfg(target_os = "windows")]
use parking_lot::{Mutex, MutexGuard};
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
	System::SystemInformation::GetTickCount64,
	UI::Input::KeyboardAndMouse::{
		GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LBUTTON, VK_LWIN,
		VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
	},
};

#[cfg(target_os = "windows")]
use crate::desktop::control;
use crate::desktop::{
	control::USER_QUIET as QUIET,
	error::{CoreResult, DesktopError},
};

/// How often an admission waiting on a held button or modifier checks whether
/// it was let go.
const HELD_POLL: Duration = Duration::from_millis(50);
/// A send window that took longer may have been descheduled while the user
/// typed, so input dated inside it counts as the user's.
const MAX_SEND: Duration = Duration::from_millis(50);

/// What the session's input dates say, on `GetTickCount64`'s clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct History {
	/// The newest input that was not OMP's.
	user: Option<Duration>,
	/// OMP's newest send window: from its reading to the end of the send.
	own:  Option<(Duration, Duration)>,
	/// The last input tick read, and the clock then.
	seen: Option<(u32, Duration)>,
}

impl History {
	/// Folds in one reading of the session's last input `tick` (`GetTickCount`
	/// time, the low 32 bits of `GetTickCount64`) taken before `now`.
	fn read(&mut self, tick: u32, now: Duration) {
		let previous = self.seen.replace((tick, now));
		if previous.is_some_and(|(seen, _)| seen == tick) {
			return;
		}
		let ago = (now.as_millis() as u32).wrapping_sub(tick);
		// More than half the tick range back is a date ahead of the clock.
		let dated =
			(ago <= u32::MAX / 2).then(|| now.saturating_sub(Duration::from_millis(ago.into())));
		// A send window explains one new date, its own: once that date is read,
		// or one after the window, the send's date can no longer come. An older
		// date read right after the send (input Windows registered late) leaves
		// it waiting; read later, the send's own date would have shown by then.
		let Some((before, after)) = self.own.filter(|(before, after)| {
			after.saturating_sub(*before) <= MAX_SEND && dated.is_some_and(|at| at <= *after)
		}) else {
			self.own = None;
			return self.count(dated, previous, now);
		};
		if dated.is_some_and(|at| at >= before) {
			self.own = None;
			return;
		}
		if now > after + MAX_SEND {
			self.own = None;
		}
		self.count(dated, previous, now);
	}

	/// Counts a new date that was not OMP's: `dated` (none when ahead of the
	/// clock), read at `now` after the `previous` reading.
	fn count(&mut self, dated: Option<Duration>, previous: Option<(u32, Duration)>, now: Duration) {
		// Programs may date their injected input: a date ahead of the clock, or
		// before the previous reading of another date, is input since then.
		let at = match (dated, previous) {
			(Some(at), Some((_, read))) if at >= read => at,
			(Some(at), None) => at,
			_ => now,
		};
		self.user = self.user.max(Some(at));
	}

	/// Before OMP sends: reads the session's last input (`tick`, between two
	/// `clock` readings), which the send is about to overwrite, and returns
	/// where the send's window starts: before that reading, so input from then
	/// until the send falls inside the window. Without a reading the send
	/// may have overwritten unseen input, so it gets no window.
	fn sending(
		&mut self,
		tick: impl FnOnce() -> Option<u32>,
		mut clock: impl FnMut() -> Duration,
	) -> Option<Duration> {
		let before = clock();
		let tick = tick()?;
		self.read(tick, clock());
		Some(before)
	}

	/// Records OMP's send from `before` ([`Self::sending`]) to `after`.
	const fn sent(&mut self, before: Duration, after: Duration) {
		self.own = Some((before, after));
	}
}

/// A takeover's admission: the user's last input then.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Admission {
	user: Option<Duration>,
}

impl Admission {
	/// Whether the session has had no input but OMP's since, and nothing is
	/// `held`.
	fn holds(self, last_input: Option<Duration>, held: bool) -> bool {
		last_input == self.user && !held
	}
}

#[cfg(target_os = "windows")]
static HISTORY: Mutex<History> = Mutex::new(History { user: None, own: None, seen: None });

#[cfg(target_os = "windows")]
thread_local! {
	/// The admission of the takeover this worker thread is about to run.
	static ADMITTED: Cell<Option<Admission>> = const { Cell::new(None) };
}

#[cfg(target_os = "windows")]
fn now() -> Duration {
	// SAFETY: GetTickCount64 has no preconditions and is monotonic.
	Duration::from_millis(unsafe { GetTickCount64() })
}

/// The session's last input tick, from any source.
#[cfg(target_os = "windows")]
fn last_input_tick() -> Option<u32> {
	let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
	// SAFETY: `info` is writable and its size is set.
	(unsafe { GetLastInputInfo(&raw mut info) } != 0).then_some(info.dwTime)
}

/// OMP's input on its way out. It holds the history until [`Sending::sent`],
/// so no reading of this process falls between a send and its record.
#[cfg(target_os = "windows")]
pub(super) struct Sending {
	history: MutexGuard<'static, History>,
	before:  Option<Duration>,
}

/// Before OMP sends input: keeps the input the send is about to overwrite.
#[cfg(target_os = "windows")]
pub(super) fn sending() -> Sending {
	let mut history = HISTORY.lock();
	let before = history.sending(last_input_tick, now);
	Sending { history, before }
}

#[cfg(target_os = "windows")]
impl Sending {
	/// Ends the send, recording it when Windows `inserted` any of it and its
	/// window started with a reading.
	pub(super) fn sent(mut self, inserted: bool) {
		if let Some(before) = self.before.filter(|_| inserted) {
			self.history.sent(before, now());
		}
	}
}

/// The newest input that was not OMP's.
#[cfg(target_os = "windows")]
fn last_input() -> CoreResult<Option<Duration>> {
	let mut history = HISTORY.lock();
	let tick = last_input_tick().ok_or_else(|| {
		DesktopError::input_failed(
			"cannot read the session's last input time, so no takeover started; nothing was sent",
		)
	})?;
	history.read(tick, now());
	Ok(history.user)
}

/// Whether a mouse button or modifier reads as held down, which would change
/// what the takeover's own input does.
#[cfg(target_os = "windows")]
fn input_held() -> bool {
	[
		VK_LBUTTON,
		VK_RBUTTON,
		VK_MBUTTON,
		VK_XBUTTON1,
		VK_XBUTTON2,
		VK_SHIFT,
		VK_CONTROL,
		VK_MENU,
		VK_LWIN,
		VK_RWIN,
	]
	.into_iter()
	// SAFETY: GetAsyncKeyState takes a scalar virtual key.
	.any(|key| unsafe { GetAsyncKeyState(key.into()) } < 0)
}

/// Before a window or element takeover takes the input lease: waits until the
/// session has had no input but OMP's for [`QUIET`] and no button or modifier
/// is held, at most until shortly before the call's deadline.
#[cfg(target_os = "windows")]
pub(super) fn admit() -> CoreResult<()> {
	ADMITTED.set(None);
	let limit = now() + control::time_left().unwrap_or(QUIET);
	let user = admit_with(limit, now, last_input, input_held, control::wait)?;
	ADMITTED.set(Some(Admission { user }));
	Ok(())
}

/// With the input lease held: whether the session has had no input but OMP's
/// since [`admit`], and nothing is held.
#[cfg(target_os = "windows")]
pub(super) fn admitted() -> CoreResult<bool> {
	let Some(admission) = ADMITTED.get() else {
		return Ok(false);
	};
	Ok(admission.holds(last_input()?, input_held()))
}

/// As a takeover brings its target forward, after it found its target: fails,
/// with nothing sent, once the session has had input since [`admit`] or a
/// button or modifier is held, or then the call has no time left. A takeover
/// without an admission on this thread (the native tests' direct calls) goes
/// ahead.
#[cfg(target_os = "windows")]
pub(super) fn activating() -> CoreResult<()> {
	activating_with(ADMITTED.take(), last_input, input_held, control::time_left)
}

fn activating_with(
	admission: Option<Admission>,
	last_input: impl FnOnce() -> CoreResult<Option<Duration>>,
	held: impl FnOnce() -> bool,
	time_left: impl FnOnce() -> Option<Duration>,
) -> CoreResult<()> {
	let Some(admission) = admission else {
		return Ok(());
	};
	if !admission.holds(last_input()?, held()) {
		return Err(DesktopError::user_intervened(
			"the session had input from any source (a key, click or pointer move), or a mouse button \
			 or modifier read as held, after this takeover was admitted, so it did not start; \
			 nothing was sent; try again once the user pauses",
		));
	}
	// Read last: the checks above can wait on OMP's own sends.
	if time_left().is_some_and(|left| left.is_zero()) {
		return Err(DesktopError::timeout(
			"the call's deadline passed before its takeover target could come forward; nothing was \
			 sent",
		));
	}
	Ok(())
}

fn admit_with(
	limit: Duration,
	now: impl Fn() -> Duration,
	mut last_input: impl FnMut() -> CoreResult<Option<Duration>>,
	held: impl Fn() -> bool,
	mut wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<Option<Duration>> {
	// The newest input seen dated before the deadline: a later reading can show
	// only input after it.
	let mut before_limit = None;
	loop {
		let user = last_input()?;
		let holding = held();
		let now = now();
		let active = if holding { Some(now) } else { user };
		before_limit = before_limit.max(user.filter(|&user| user < limit));
		let idle = active.map_or(Duration::MAX, |active| now.saturating_sub(active));
		if idle >= QUIET && now <= limit {
			return Ok(user);
		}
		if now >= limit {
			if holding {
				return Err(DesktopError::user_intervened(
					"a mouse button or modifier read as held down, so no takeover started; nothing was \
					 sent; try again once it is released",
				));
			}
			// Input within the quiet period before the deadline stopped it;
			// otherwise the deadline did, whatever came after it.
			return Err(match before_limit.filter(|&active| active + QUIET > limit) {
				Some(active) => DesktopError::user_intervened(format!(
					"the session's last input from any source (a key, click or pointer move) before \
					 the call's deadline was {:.1} s before it, so no takeover started; nothing was \
					 sent; try again once the user pauses",
					limit.saturating_sub(active).as_secs_f64(),
				)),
				None => DesktopError::timeout(
					"the call's deadline passed before its takeover was admitted; nothing was sent",
				),
			});
		}
		let active = active.unwrap_or(now);
		let quiet = (active + QUIET).min(limit).saturating_sub(now);
		wait(if holding { HELD_POLL.min(quiet) } else { quiet })?;
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;
	use crate::desktop::error::ErrorCode;

	const fn ms(value: u64) -> Duration {
		Duration::from_millis(value)
	}

	/// A history whose newest send ran from `before` to `after` ms, read at
	/// `tick` (`GetTickCount` time) when the clock shows `now` ms.
	fn user_after(own: Option<(u64, u64)>, tick: u32, now: u64) -> Option<Duration> {
		let mut history = History::default();
		if let Some((before, after)) = own {
			history.sent(ms(before), ms(after));
		}
		history.read(tick, ms(now));
		history.user
	}

	#[test]
	fn only_input_dated_inside_omps_newest_short_send_is_omps() {
		const WRAP: u64 = 1 << 32;
		let rows = [
			("no send yet", None, 1_000, 3_000, Some(1_000)),
			("inside the send", Some((990, 1_010)), 1_000, 3_000, None),
			("at its first tick", Some((990, 1_010)), 990, 3_000, None),
			("at its last tick", Some((990, 1_010)), 1_010, 3_000, None),
			("one tick before it", Some((990, 1_010)), 989, 3_000, Some(989)),
			("one tick after it", Some((990, 1_010)), 1_011, 3_000, Some(1_011)),
			("inside a send too long to be sure", Some((990, 1_041)), 1_000, 3_000, Some(1_000)),
			// The send straddles GetTickCount's wrap; the tick is past it.
			("inside a send across the wrap", Some((WRAP - 5, WRAP + 5)), 2, WRAP + 100, None),
			(
				"after a send across the wrap",
				Some((WRAP - 5, WRAP + 5)),
				6,
				WRAP + 100,
				Some(WRAP + 6),
			),
			// Dated ahead of the clock: input as of this reading.
			("ahead of the clock", None, 3_010, 3_000, Some(3_000)),
		];
		for (case, own, tick, now, user) in rows {
			assert_eq!(user_after(own, tick, now), user.map(ms), "{case}");
		}
	}

	#[test]
	fn a_send_window_runs_from_before_its_reading_and_keeps_the_input_before_it() {
		// The user's input was at 8_000, already read at 9_000. A send starts
		// its clock at 10_000, reads the last input, reads the clock again
		// `stall` ms later, and its input goes `gap` ms after that; Windows
		// dates it then. `read` says whether the pre-send reading worked.
		let send = |stall: u64, gap: u64, read: bool| {
			let mut history = History::default();
			history.read(8_000, ms(9_000));
			let mut clock = [ms(10_000), ms(10_000 + stall)].into_iter();
			let before =
				history.sending(|| read.then_some(8_000), || clock.next().expect("two readings"));
			let at = 10_000 + stall + gap;
			if let Some(before) = before {
				history.sent(before, ms(at + 1));
			}
			history.read(at as u32, ms(at + 100));
			history.user
		};
		// A short send: its input is OMP's and the user's 8_000 stands. A key
		// pressed within it would be dated inside it too, and go unseen.
		assert_eq!(send(0, 20, true), Some(ms(8_000)));
		// Descheduled after the reading, or between the last-input reading and
		// the clock: a key pressed then was overwritten, so the window is too
		// long to be sure, and counts.
		assert_eq!(send(0, 70, true), Some(ms(10_070)));
		assert_eq!(send(80, 0, true), Some(ms(10_080)));
		// No pre-send reading: the send may have overwritten unseen input.
		assert_eq!(send(0, 20, false), Some(ms(10_020)));
	}

	#[test]
	fn a_new_date_older_than_the_last_reading_is_input_since_it() {
		let mut history = History::default();
		history.read(9_000, ms(10_000));
		// The same date read again is no new input.
		history.read(9_000, ms(20_000));
		assert_eq!(history.user, Some(ms(9_000)));
		// Another program's input dated 8_000 arrived after the 20_000 reading.
		history.read(8_000, ms(21_000));
		assert_eq!(history.user, Some(ms(21_000)));
		// OMP's send window explains its own date, read once; another
		// program's later input dated inside that window does not hide.
		let mut history = History::default();
		history.sent(ms(990), ms(1_010));
		history.read(1_000, ms(1_020));
		assert_eq!(history.user, None);
		history.read(1_001, ms(20_000));
		assert_eq!(history.user, Some(ms(20_000)));
		// An older date Windows registered late, read right after the send:
		// it counts, and the send's date is still OMP's when it shows.
		let mut history = History::default();
		history.read(900, ms(999));
		history.sent(ms(1_000), ms(1_010));
		history.read(990, ms(1_011));
		assert_eq!(history.user, Some(ms(1_011)));
		history.read(1_005, ms(1_012));
		assert_eq!(history.user, Some(ms(1_011)));
		// Read long after the send, an older date means the send's own date is
		// past: a later date inside the window is another program's.
		let mut history = History::default();
		history.read(900, ms(999));
		history.sent(ms(1_000), ms(1_010));
		history.read(990, ms(20_000));
		history.read(1_005, ms(26_000));
		assert_eq!(history.user, Some(ms(26_000)));
		// The send's own date read first, long after it, is still OMP's.
		let mut history = History::default();
		history.read(900, ms(999));
		history.sent(ms(1_000), ms(1_010));
		history.read(1_005, ms(60_000));
		assert_eq!(history.user, Some(ms(900)));
	}

	#[test]
	fn activation_refuses_input_a_held_button_or_no_time_left_since_admission() {
		// The deadline is at 12_000; reading the last input takes `read` ms
		// from 11_990.
		let activate = |admission, user: u64, held, read: u64| {
			let clock = Cell::new(ms(11_990));
			activating_with(
				admission,
				|| {
					clock.set(clock.get() + ms(read));
					Ok(Some(ms(user)))
				},
				|| held,
				|| Some(ms(12_000).saturating_sub(clock.get())),
			)
			.map_err(|error| error.code)
		};
		let admitted = Some(Admission { user: Some(ms(5_000)) });
		assert_eq!(activate(admitted, 5_000, false, 0), Ok(()));
		assert_eq!(activate(admitted, 10_050, false, 0), Err(ErrorCode::UserIntervened));
		assert_eq!(activate(admitted, 5_000, true, 0), Err(ErrorCode::UserIntervened));
		assert_eq!(activate(admitted, 5_000, false, 20), Err(ErrorCode::Timeout));
		assert_eq!(activate(None, 10_050, false, 20), Ok(()));
	}

	/// Runs an admission from `start` ms with a deadline at `limit` ms, the
	/// user's last input `user`, a button held until `held_until` ms, whose
	/// release Windows dates as input, and input dated `late` ms showing once
	/// the clock reaches it; each wait runs `overshoot` ms long.
	fn admit(
		start: u64,
		limit: u64,
		user: Option<u64>,
		held_until: u64,
		late: u64,
		overshoot: u64,
	) -> (CoreResult<Option<Duration>>, Vec<Duration>) {
		let clock = Cell::new(ms(start));
		let mut waits = Vec::new();
		let after = |at: u64, now: Duration| (at != 0 && now >= ms(at)).then(|| ms(at));
		let result = admit_with(
			ms(limit),
			|| clock.get(),
			|| {
				Ok(user
					.map(ms)
					.max(after(held_until, clock.get()))
					.max(after(late, clock.get())))
			},
			|| clock.get() < ms(held_until),
			|duration| {
				waits.push(duration);
				clock.set(clock.get() + duration + ms(overshoot));
				Ok(())
			},
		);
		(result, waits)
	}

	#[test]
	fn admission_waits_for_quiet_bounded_by_the_deadline() {
		// Idle for longer than the quiet period, or never seen: no wait.
		let (result, waits) = admit(10_000, 30_000, Some(4_000), 0, 0, 0);
		assert_eq!((result.unwrap(), waits), (Some(ms(4_000)), vec![]));
		let (result, waits) = admit(10_000, 30_000, None, 0, 0, 0);
		assert_eq!((result.unwrap(), waits), (None, vec![]));
		// Input 1 s ago: waits the 4 s left of the quiet period.
		let (result, waits) = admit(10_000, 30_000, Some(9_000), 0, 0, 0);
		assert_eq!((result.unwrap(), waits), (Some(ms(9_000)), vec![ms(4_000)]));
		// A held button is polled until let go; quiet runs from the release.
		let (result, waits) = admit(10_000, 30_000, None, 10_120, 0, 0);
		assert_eq!(
			(result.unwrap(), waits),
			(Some(ms(10_120)), vec![ms(50), ms(50), ms(50), ms(4_970)])
		);
		// Quiet exactly at the deadline admits.
		let (result, waits) = admit(10_000, 12_000, Some(7_000), 0, 0, 0);
		assert_eq!((result.unwrap(), waits), (Some(ms(7_000)), vec![ms(2_000)]));
		// The deadline comes first: refused once it is reached, nothing sent.
		let (result, waits) = admit(10_000, 12_000, Some(9_000), 0, 0, 0);
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		assert_eq!(waits, [ms(2_000)]);
		// A wait that overran the deadline: quiet came only after it.
		let (result, waits) = admit(10_000, 12_000, Some(7_016), 0, 0, 32);
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		assert_eq!(waits, [ms(2_000)]);
		// Quiet long before, but first read after the deadline: too late.
		let (result, waits) = admit(12_100, 12_000, Some(4_000), 0, 0, 0);
		assert_eq!(result.unwrap_err().code, ErrorCode::Timeout);
		assert!(waits.is_empty());
		// Quiet by the deadline, but the wait overran it and then read input
		// dated after it: the deadline stopped it, not that input.
		let (result, waits) = admit(10_000, 12_000, Some(7_000), 0, 12_016, 32);
		assert_eq!(result.unwrap_err().code, ErrorCode::Timeout);
		assert_eq!(waits, [ms(2_000)]);
		// Input 3 s before the deadline, then input after the overrun
		// overwrites it: the earlier input still stopped it.
		let (result, waits) = admit(10_000, 12_000, Some(9_000), 0, 12_016, 32);
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		assert_eq!(waits, [ms(2_000)]);
	}
}
