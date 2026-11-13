//! Which windows background input left behind the target's.
//!
//! A pointer click delivered to a background window, the activating press that
//! lets one take keys, and an accessibility action that opens a pop-up's menu
//! order that window in front of every other window, the user's included, and
//! macOS leaves it there. The background guard puts the user's key window back
//! in front of the target. Only that one: raising any other window of theirs
//! through accessibility makes it key, and what they type meanwhile lands
//! there, so their other windows the target covered stay behind it. Another
//! background app's window cannot be put back either: raising it through
//! accessibility leaves the stacking as it is, without activating that app.

use libc::pid_t;

/// An on-screen normal-layer window as `WindowServer` stacks it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Stacked {
	pub(super) id:  u32,
	pub(super) pid: pid_t,
}

/// The user's key window, in front of the target when background input began.
#[derive(Debug)]
pub(super) struct EntryOrder {
	target:     pid_t,
	user:       pid_t,
	key:        u32,
	/// Every window on screen then.
	seen:       Vec<u32>,
	/// Accessibility cannot raise the key window: it is no longer kept.
	unraisable: bool,
}

impl EntryOrder {
	/// From a front-to-back snapshot; `None` when the user's app has no key
	/// window, the key window was not in front of every window of the target
	/// application, or another window of the user's was in front of the key
	/// window: raising the key window would then reorder their own windows,
	/// so their ordering is left alone.
	pub(super) fn new(
		target: pid_t,
		user: pid_t,
		key: Option<u32>,
		stack: &[Stacked],
	) -> Option<Self> {
		let key = key?;
		let top = stack.iter().position(|window| window.pid == target)?;
		let at = stack[..top]
			.iter()
			.position(|window| window.id == key && window.pid == user)?;
		(!stack[..at].iter().any(|window| window.pid == user)).then(|| Self {
			target,
			user,
			key,
			seen: stack.iter().map(|window| window.id).collect(),
			unraisable: false,
		})
	}

	/// The key window, when a window of the target, or one that appeared
	/// during the input, is `now` in front of it; `None` otherwise, when it is
	/// gone, or when another window of the user's is in front of it: they
	/// brought that one forward themselves, and raising theirs over it would
	/// undo their choice and take its keys.
	///
	/// Windows of the target are never moved: a sheet or menu the input opened
	/// stays above its own parent. A window that appeared counts as the
	/// input's unless the user's app opened it.
	pub(super) fn to_raise(&self, now: &[Stacked]) -> Option<Stacked> {
		let moved = |window: &Stacked| {
			window.pid == self.target || (window.pid != self.user && !self.seen.contains(&window.id))
		};
		let at = now.iter().position(|window| window.id == self.key)?;
		let above = &now[..at];
		(!self.unraisable
			&& !above.iter().any(|window| window.pid == self.user)
			&& above.iter().any(moved))
		.then_some(now[at])
	}

	/// Stops keeping the key window, which accessibility cannot raise.
	const fn forget(&mut self) {
		self.unraisable = true;
	}
}

/// What raising one window did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Raised {
	/// The raise was asked for; a later reading shows whether it held.
	Asked,
	/// Accessibility has no such window to raise: it is not kept any more.
	Unraisable,
}

/// How many times one background action raises the user's key window again
/// during the action: a target that keeps ordering itself in front is left
/// there until the last pass.
const RAISE_TRIES: u8 = 3;

/// How many readings a pass takes for its raise to show: the window list
/// catches up with `AXRaise` a little after it returns, and a pass that read
/// it too early would raise again, or report a raise that held.
const SHOW_READS: usize = 5;

/// One pass of the background guard keeping `order`: raises the key window
/// when [`EntryOrder::to_raise`] finds it behind in `stack`'s reading, for at
/// most [`RAISE_TRIES`] passes during the action; the `last` pass always
/// raises. Just before raising, `still_kept` is asked again, since the user
/// may have switched or come to the target after the caller's check. After
/// raising it reads the stacking again, `wait`ing between readings up to
/// [`SHOW_READS`] times, until the raise shows; the last pass returns the
/// window if it is still behind.
pub(super) fn keep(
	order: &mut EntryOrder,
	tries: &mut u8,
	stack: impl Fn() -> Option<Vec<Stacked>>,
	still_kept: impl Fn() -> bool,
	mut raise: impl FnMut(&Stacked) -> Raised,
	wait: impl Fn(),
	last: bool,
) -> Result<(), Stacked> {
	let Some(window) = stack().and_then(|now| order.to_raise(&now)) else {
		return Ok(());
	};
	if (!last && *tries >= RAISE_TRIES) || !still_kept() {
		return Ok(());
	}
	*tries = tries.saturating_add(1);
	if raise(&window) == Raised::Unraisable {
		order.forget();
	}
	let mut behind = None;
	for read in 0..SHOW_READS {
		if read > 0 {
			wait();
		}
		behind = stack().and_then(|now| order.to_raise(&now));
		if behind.is_none() {
			return Ok(());
		}
	}
	match behind {
		Some(window) if last => Err(window),
		_ => Ok(()),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const USER: pid_t = 10;
	const TARGET: pid_t = 20;
	const THIRD: pid_t = 30;

	const fn w(id: u32, pid: pid_t) -> Stacked {
		Stacked { id, pid }
	}

	#[test]
	fn only_the_users_key_window_is_put_back_in_front_of_the_target() {
		let (key, other, target) = (w(1, USER), w(2, USER), w(3, TARGET));
		let entry = EntryOrder::new(TARGET, USER, Some(1), &[key, other, target]).unwrap();
		assert_eq!(entry.to_raise(&[key, other, target]), None);
		// The click ordered the target in front of both: the key window goes
		// back; raising the other would make it key and take the user's typing.
		assert_eq!(entry.to_raise(&[target, key, other]), Some(key));
		assert_eq!(entry.to_raise(&[key, target, other]), None);
	}

	#[test]
	fn a_key_window_behind_another_of_the_users_windows_is_left_alone() {
		let (other, key, target) = (w(2, USER), w(1, USER), w(3, TARGET));
		// Raising the key window over their other one would reorder their own
		// windows: their ordering is left as it is.
		assert!(EntryOrder::new(TARGET, USER, Some(1), &[other, key, target]).is_none());
	}

	#[test]
	fn the_users_own_reordering_meanwhile_is_kept() {
		let (key, other, target) = (w(1, USER), w(2, USER), w(3, TARGET));
		let entry = EntryOrder::new(TARGET, USER, Some(1), &[key, other, target]).unwrap();
		// They brought their other window forward, then the target came in
		// front of the key window: theirs stays on top.
		assert_eq!(entry.to_raise(&[other, target, key]), None);
		assert_eq!(entry.to_raise(&[target, other, key]), None);
	}

	#[test]
	fn only_the_users_windows_are_kept_in_front() {
		let (user, third, target) = (w(1, USER), w(4, THIRD), w(3, TARGET));
		// Another background app's window is not the user's to keep.
		let entry = EntryOrder::new(TARGET, USER, Some(1), &[third, user, target]).unwrap();
		assert_eq!(
			entry
				.to_raise(&[target, third, user])
				.map(|window| window.id),
			Some(1)
		);
		assert!(EntryOrder::new(TARGET, USER, Some(1), &[third, target, user]).is_none());
	}

	#[test]
	fn a_window_the_input_opened_counts_but_one_the_users_app_opened_does_not() {
		let (user, target) = (w(1, USER), w(3, TARGET));
		let entry = EntryOrder::new(TARGET, USER, Some(1), &[user, target]).unwrap();
		// An Open panel served by another process.
		assert_eq!(
			entry
				.to_raise(&[w(9, THIRD), user, target])
				.map(|window| window.id),
			Some(1)
		);
		assert_eq!(entry.to_raise(&[w(9, USER), user, target]), None);
	}

	#[test]
	fn a_key_window_that_is_gone_or_was_behind_the_target_is_not_kept() {
		let (key, other, target) = (w(1, USER), w(2, USER), w(3, TARGET));
		// The key window was behind the target at entry.
		assert!(EntryOrder::new(TARGET, USER, Some(1), &[other, target, key]).is_none());
		// The key window closed.
		let entry = EntryOrder::new(TARGET, USER, Some(1), &[key, other, target]).unwrap();
		assert_eq!(entry.to_raise(&[target, other]), None);
	}

	#[test]
	fn a_target_in_the_users_own_app_keeps_no_order() {
		// A takeover of another window of the user's own application: raising
		// their old key window would take the keyboard back from the window
		// the takeover made key.
		let (one, two) = (w(1, USER), w(2, USER));
		assert!(EntryOrder::new(USER, USER, Some(1), &[one, two]).is_none());
		assert!(EntryOrder::new(USER, USER, Some(2), &[one, two]).is_none());
	}

	#[test]
	fn nothing_is_kept_when_nothing_covered_the_target() {
		let (user, target) = (w(1, USER), w(3, TARGET));
		assert!(EntryOrder::new(TARGET, USER, Some(1), &[target, user]).is_none());
		assert!(EntryOrder::new(TARGET, USER, Some(1), &[user]).is_none());
		// An app with no key window has nothing to put back.
		assert!(EntryOrder::new(TARGET, USER, None, &[user, target]).is_none());
	}

	#[test]
	fn the_guard_raises_until_the_order_holds_and_names_what_stayed_behind() {
		use std::cell::{Cell, RefCell};
		let (user, target) = (w(1, USER), w(3, TARGET));
		let fresh = || EntryOrder::new(TARGET, USER, Some(1), &[user, target]).unwrap();
		// A raise that works: one pass puts the user's window back, and the
		// last pass finds nothing to do.
		let stack = RefCell::new(vec![target, user]);
		let raised = Cell::new(0);
		let (mut order, mut tries) = (fresh(), 0);
		let raise = |_: &Stacked| {
			raised.set(raised.get() + 1);
			*stack.borrow_mut() = vec![user, target];
			Raised::Asked
		};
		let read = || Some(stack.borrow().clone());
		assert_eq!(keep(&mut order, &mut tries, read, || true, raise, || {}, false), Ok(()));
		assert_eq!(keep(&mut order, &mut tries, read, || true, |_| panic!(), || {}, true), Ok(()));
		assert_eq!(raised.get(), 1);
		// A target that orders itself in front again on every reading: three
		// passes raise during the action, later ones leave it, and the last
		// raises once more, reads again, and names the window.
		let (mut order, mut tries) = (fresh(), 0);
		let raised = Cell::new(0);
		let again = || Some(vec![target, user]);
		let count = |_: &Stacked| {
			raised.set(raised.get() + 1);
			Raised::Asked
		};
		for _ in 0..5 {
			assert_eq!(keep(&mut order, &mut tries, again, || true, count, || {}, false), Ok(()));
		}
		assert_eq!(raised.get(), 3);
		let waits = Cell::new(0);
		let waited = || waits.set(waits.get() + 1);
		assert_eq!(keep(&mut order, &mut tries, again, || true, count, waited, true), Err(user));
		assert_eq!((raised.get(), waits.get()), (4, SHOW_READS - 1));
		// The last pass after the budget is spent still repairs, and a raise
		// that shows only on a later reading counts.
		let (mut order, mut tries) = (fresh(), RAISE_TRIES);
		let reads = Cell::new(0);
		let late = || {
			reads.set(reads.get() + 1);
			Some(if reads.get() < 3 {
				vec![target, user]
			} else {
				vec![user, target]
			})
		};
		assert_eq!(
			keep(&mut order, &mut tries, late, || true, |_| Raised::Asked, || {}, true),
			Ok(())
		);
		// A window accessibility cannot raise is dropped, not reported.
		let (mut order, mut tries) = (fresh(), 0);
		assert_eq!(
			keep(&mut order, &mut tries, again, || true, |_| Raised::Unraisable, || {}, true),
			Ok(())
		);
		// The user switched or came to the target after the caller's check:
		// nothing is raised.
		let (mut order, mut tries) = (fresh(), 0);
		assert_eq!(keep(&mut order, &mut tries, again, || false, |_| panic!(), || {}, true), Ok(()));
		// Unreadable stacking: nothing raised, nothing claimed.
		assert_eq!(keep(&mut fresh(), &mut 0, || None, || true, |_| panic!(), || {}, true), Ok(()));
	}
}
