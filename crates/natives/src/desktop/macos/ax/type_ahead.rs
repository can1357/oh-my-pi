//! Letters typed on a closed popup button, and the read after them.
//!
//! Typing on a focused popup button chooses the first option that starts with
//! the typed letters. `AppKit` (and `SwiftUI`'s menu pickers, which are
//! `AppKit` popups) collects the letters and commits the choice only once the
//! typing pauses, about 1 s after the last key; only then does the popup's
//! `AXValue` change. A web `<select>`, also an `AXPopUpButton`, takes each key
//! at once, so only a popup outside web content is watched. So the keys are
//! sent as on any control, with nothing waited for, and the popup is marked as
//! pending; the session's next read of that popup (a tree walk that reaches
//! it, its props or its attributes) first waits until its value differs from
//! the one before the latest keys, or until a choice would have shown. Each
//! session runs on its own worker thread, which holds its marks.

use std::{
	cell::RefCell,
	time::{Duration, Instant},
};

use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFRetained, Type};

use super::{TextSurface, copy_element, copy_string, probe_application, text_surface};
use crate::desktop::{control, error::CoreResult, keys::KeyName};

/// How long after the last key a popup's choice may take to show:
/// `AppKit` and `SwiftUI` popups changed 1.00 to 1.03 s after a letter, web
/// selects at once.
const CHOICE_TIMEOUT: Duration = Duration::from_millis(1500);
const CHOICE_POLL: Duration = Duration::from_millis(10);

/// A popup button about to receive type-ahead, with its value before the keys
/// and when their sending ended.
pub(crate) struct Pending {
	popup:  CFRetained<AXUIElement>,
	before: Option<String>,
	sent:   Option<Instant>,
}

/// A popup whose type-ahead may not show yet: its value before the latest
/// keys, and when a choice would have shown.
struct Mark {
	popup:    CFRetained<AXUIElement>,
	before:   Option<String>,
	deadline: Instant,
}

thread_local! {
	static MARKS: RefCell<Vec<Mark>> = const { RefCell::new(Vec::new()) };
}

/// Whether `keys` are type-ahead: printable characters other than a space
/// (which opens the menu), with Shift at most.
pub(crate) fn chord_types_ahead(keys: &[KeyName]) -> bool {
	keys.iter().any(|key| matches!(key, KeyName::Char(_)))
		&& keys.iter().all(|key| match key {
			KeyName::Char(character) => types_ahead(*character),
			KeyName::Shift => true,
			_ => false,
		})
}

/// Whether `text` is type-ahead: printable characters, none a space.
pub(crate) fn text_types_ahead(text: &str) -> bool {
	!text.is_empty() && text.chars().all(types_ahead)
}

const fn types_ahead(character: char) -> bool {
	!character.is_whitespace() && !character.is_control()
}

/// The popup button about to receive type-ahead: `element`, or else the
/// element of `pid` that holds keyboard focus, when its role is
/// `AXPopUpButton` outside web content ([`defers_choice`]); `None` for anything
/// else. Called only for keys that type ahead, so other keys read nothing.
pub(crate) fn watch(element: Option<&AXUIElement>, pid: libc::pid_t) -> Option<Pending> {
	let popup = if let Some(element) = element {
		element.retain()
	} else {
		let app: CFRetained<AXUIElement> = probe_application(pid)?;
		let focused: CFRetained<AXUIElement> = copy_element(&app, "AXFocusedUIElement")?;
		// The timeout on the application does not apply to returned elements.
		// SAFETY: The retained focused element is valid for the timeout update.
		let _ = unsafe { focused.set_messaging_timeout(super::PROBE_TIMEOUT_SECONDS) };
		focused
	};
	defers_choice(copy_string(&popup, "AXRole").as_deref(), || text_surface(&popup))
		.then(|| Pending { before: copy_string(&popup, "AXValue"), popup, sent: None })
}

/// Runs `deliver`, which watches the popup about to take type-ahead into its
/// argument ([`watch`]) and sends the keys, then marks that popup however
/// `deliver` ended: letters that went out commit in the popup even when the
/// call fails after them.
pub(crate) fn marking<T>(
	deliver: impl FnOnce(&mut Option<Pending>) -> CoreResult<T>,
) -> CoreResult<T> {
	let mut pending = None;
	let delivered = deliver(&mut pending);
	if let Some(pending) = pending {
		pending.mark();
	}
	delivered
}

/// Notes on a watched popup (`pending`) that its keys' sending ended now, how
/// ever it ended (`sent`), which the read's wait counts from. When no key
/// reached its posting (`posted`: a guard refused the first), nothing can
/// commit, so the popup is not marked.
pub(crate) fn keys_sent<T>(pending: &mut Option<Pending>, posted: bool, sent: T) -> T {
	if !posted {
		*pending = None;
	} else if let Some(pending) = pending {
		pending.keys_sent();
	}
	sent
}

/// Whether `element` is a popup whose type-ahead may not show yet, so a read
/// of it would wait ([`settle_read`]).
pub(crate) fn pending(element: &AXUIElement) -> bool {
	let now = Instant::now();
	MARKS.with_borrow(|marks| {
		marks
			.iter()
			.any(|mark| mark.deadline > now && *mark.popup == *element)
	})
}

/// Whether an element of `role` commits typed letters late: a native popup
/// button does, about 1 s after the last key, while a web `<select>` (an
/// `AXPopUpButton` too, in an `AXWebArea`) commits each key at once. The
/// `surface` is read only for a popup button, and one of unknown surface is
/// not watched.
fn defers_choice(role: Option<&str>, surface: impl FnOnce() -> TextSurface) -> bool {
	role == Some("AXPopUpButton") && surface() == TextSurface::Native
}

impl Pending {
	/// Notes that the keys' sending ended now, however it ended.
	fn keys_sent(&mut self) {
		self.sent = Some(Instant::now());
	}

	/// Marks the popup for the next read of it ([`settle_read`]), which waits
	/// at most [`CHOICE_TIMEOUT`] from the last key.
	fn mark(self) {
		self.mark_at(Instant::now());
	}

	/// [`Self::mark`] at `now`. A popup already marked takes these keys'
	/// value from before them: unchanged while its earlier letters are still
	/// uncommitted, and their choice once they committed.
	fn mark_at(self, now: Instant) {
		let deadline = self.sent.unwrap_or(now) + CHOICE_TIMEOUT;
		MARKS.with_borrow_mut(|marks| {
			marks.retain(|mark| mark.deadline > now);
			match marks.iter_mut().find(|mark| *mark.popup == *self.popup) {
				Some(mark) => {
					mark.before = self.before;
					mark.deadline = deadline;
				},
				None => marks.push(Mark { popup: self.popup, before: self.before, deadline }),
			}
		});
	}
}

/// Before a read of `element`: when it is a popup with pending type-ahead,
/// waits until its value differs from the one before the keys or the choice's
/// deadline passes, then clears the mark. A cancel stops the wait and keeps
/// the mark for the next read. Without marks it only checks that none exist.
/// A read made while the call holds the input lease (an element click finding
/// its point, a refusal naming the element) never waits, since that would
/// keep every other session's input out: it reads at once and keeps the mark.
pub(crate) fn settle_read(element: &AXUIElement) -> CoreResult<()> {
	if control::input_held() {
		return Ok(());
	}
	settle_read_with(
		element,
		Instant::now,
		|popup| copy_string(popup, "AXValue"),
		|left| control::wait(CHOICE_POLL.min(left)),
	)
}

fn settle_read_with(
	element: &AXUIElement,
	now: impl Fn() -> Instant,
	read: impl Fn(&AXUIElement) -> Option<String>,
	wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<()> {
	let Some(mark) = MARKS.with_borrow_mut(|marks| {
		if marks.is_empty() {
			return None;
		}
		let at = now();
		marks.retain(|mark| mark.deadline > at);
		let index = marks.iter().position(|mark| *mark.popup == *element)?;
		Some(marks.swap_remove(index))
	}) else {
		return Ok(());
	};
	let waited = await_change(
		mark.before.as_deref(),
		|| read(&mark.popup),
		|| mark.deadline.saturating_duration_since(now()),
		wait,
	);
	if waited.is_err() {
		MARKS.with_borrow_mut(|marks| marks.push(mark));
	}
	waited.map(drop)
}

/// Reads the value (`read`) until it differs from `before` or no time is
/// `left`; `wait` pauses for at most the time left, and its error (a cancel)
/// ends the wait. Returns the value it ended on.
fn await_change(
	before: Option<&str>,
	mut read: impl FnMut() -> Option<String>,
	mut left: impl FnMut() -> Duration,
	mut wait: impl FnMut(Duration) -> CoreResult<()>,
) -> CoreResult<Option<String>> {
	loop {
		let value = read();
		if value.as_deref() != before {
			return Ok(value);
		}
		let left = left();
		if left.is_zero() {
			return Ok(value);
		}
		wait(left)?;
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;
	use crate::desktop::error::DesktopError;

	#[test]
	fn characters_with_shift_at_most_and_no_space_type_ahead() {
		for keys in
			[&[KeyName::Char('r')][..], &[KeyName::Shift, KeyName::Char('R')], &[KeyName::Char('7')]]
		{
			assert!(chord_types_ahead(keys), "{keys:?}");
		}
		for keys in [
			&[KeyName::Char(' ')][..],
			&[KeyName::Space],
			&[KeyName::Down],
			&[KeyName::Enter],
			&[KeyName::Tab],
			&[KeyName::Meta, KeyName::Char('a')],
			&[KeyName::Alt, KeyName::Char('r')],
			&[KeyName::Shift],
		] {
			assert!(!chord_types_ahead(keys), "{keys:?}");
		}
		assert!(text_types_ahead("Research"));
		assert!(!text_types_ahead("Office Supplies"));
		assert!(!text_types_ahead(""));
	}

	#[test]
	fn only_a_native_popup_button_defers_its_choice() {
		assert!(defers_choice(Some("AXPopUpButton"), || TextSurface::Native));
		// A web `<select>` commits each key at once, so a letter matching
		// nothing there is read at once, as before.
		assert!(!defers_choice(Some("AXPopUpButton"), || TextSurface::Web));
		assert!(!defers_choice(Some("AXPopUpButton"), || TextSurface::Unknown));
		for role in [Some("AXTextField"), Some("AXComboBox"), None] {
			assert!(!defers_choice(role, || panic!("only a popup button's surface is read")));
		}
	}

	/// Two marks never collide with a real application's elements: the pids are
	/// not running, and nothing reads their attributes.
	fn popups() -> (CFRetained<AXUIElement>, CFRetained<AXUIElement>) {
		(
			super::super::create_application(4242).expect("element"),
			super::super::create_application(4243).expect("element"),
		)
	}

	/// A clock that only `wait` moves, starting at `start`.
	fn clock(start: Instant) -> Cell<Instant> {
		Cell::new(start)
	}

	#[test]
	fn a_later_key_takes_its_own_value_from_before_and_the_deadline_counts_from_the_last_key() {
		MARKS.with_borrow_mut(Vec::clear);
		let (popup, _) = popups();
		let start = Instant::now();
		let pending = |before: &str| Pending {
			popup:  popup.clone(),
			before: Some(before.to_string()),
			sent:   None,
		};
		pending("Alpha").mark_at(start);
		MARKS.with_borrow(|marks| assert_eq!(marks[0].deadline, start + CHOICE_TIMEOUT));
		// The first letter committed before the second key went out.
		let key = start + Duration::from_millis(700);
		// The call returned 0.5 s after its last key: the wait counts from the
		// key.
		let later = key + Duration::from_millis(500);
		Pending { sent: Some(key), ..pending("Mediocre") }.mark_at(later);
		MARKS.with_borrow(|marks| {
			assert_eq!(marks.len(), 1);
			assert_eq!(marks[0].before.as_deref(), Some("Mediocre"));
			assert_eq!(marks[0].deadline, key + CHOICE_TIMEOUT);
		});
		MARKS.with_borrow_mut(Vec::clear);
	}

	#[test]
	fn a_read_of_the_marked_popup_waits_for_its_choice_then_clears_the_mark() {
		MARKS.with_borrow_mut(Vec::clear);
		let (popup, other) = popups();
		let start = Instant::now();
		Pending { popup: popup.clone(), before: Some("Choose a team".to_string()), sent: None }
			.mark_at(start);
		let now = clock(start);
		let unread =
			|_: &AXUIElement| -> Option<String> { panic!("another element's read never waits") };
		settle_read_with(&other, || now.get(), unread, |_| panic!("no wait")).expect("read");
		MARKS.with_borrow(|marks| {
			assert_eq!(marks.len(), 1, "a read of another element keeps the mark");
		});
		// The popup commits the letter 1 s after it was marked.
		let commit = start + Duration::from_secs(1);
		settle_read_with(
			&popup,
			|| now.get(),
			|_| {
				Some(
					if now.get() >= commit {
						"Research"
					} else {
						"Choose a team"
					}
					.to_string(),
				)
			},
			|pause| {
				now.set(now.get() + CHOICE_POLL.min(pause));
				Ok(())
			},
		)
		.expect("read");
		assert_eq!(now.get(), commit);
		MARKS.with_borrow(|marks| assert!(marks.is_empty()));
		// A value that already changed is read at once, with no wait.
		Pending { popup: popup.clone(), before: Some("Bravo".to_string()), sent: None }
			.mark_at(now.get());
		settle_read_with(&popup, || now.get(), |_| Some("Delta".to_string()), |_| panic!("no wait"))
			.expect("read");
		MARKS.with_borrow(|marks| assert!(marks.is_empty()));
	}

	#[test]
	fn an_unchanged_popup_is_read_at_the_deadline_and_a_cancel_keeps_the_mark() {
		MARKS.with_borrow_mut(Vec::clear);
		let (popup, _) = popups();
		let start = Instant::now();
		let now = clock(start);
		let same = |_: &AXUIElement| Some("Bravo".to_string());
		Pending { popup: popup.clone(), before: Some("Bravo".to_string()), sent: None }
			.mark_at(start);
		settle_read_with(
			&popup,
			|| now.get(),
			same,
			|pause| {
				now.set(now.get() + CHOICE_POLL.min(pause));
				Ok(())
			},
		)
		.expect("read");
		assert_eq!(now.get(), start + CHOICE_TIMEOUT);
		Pending { popup: popup.clone(), before: Some("Bravo".to_string()), sent: None }
			.mark_at(now.get());
		let waits = Cell::new(0);
		let cancelled = settle_read_with(
			&popup,
			|| now.get(),
			same,
			|_| {
				waits.set(waits.get() + 1);
				Err(DesktopError::cancelled("cancelled"))
			},
		);
		assert_eq!(cancelled.expect_err("cancelled").code.as_str(), "Cancelled");
		assert_eq!(waits.get(), 1, "a cancel ends the wait at once");
		MARKS.with_borrow(|marks| assert_eq!(marks.len(), 1, "the next read still waits"));
		// Past its deadline the mark is dropped without a read.
		now.set(now.get() + CHOICE_TIMEOUT);
		settle_read_with(&popup, || now.get(), |_| panic!("no read"), |_| panic!("no wait"))
			.expect("read");
		MARKS.with_borrow(|marks| assert!(marks.is_empty()));
	}

	#[test]
	fn keys_that_fail_after_a_letter_went_out_still_mark_their_popup() {
		MARKS.with_borrow_mut(Vec::clear);
		let (popup, other) = popups();
		let failed = marking(|pending| -> CoreResult<()> {
			*pending = Some(Pending {
				popup:  popup.clone(),
				before: Some("Alpha".to_string()),
				sent:   None,
			});
			// A key release failed after the letter's press went out.
			keys_sent(pending, true, Err(DesktopError::input_failed("key release failed")))
		});
		assert!(
			failed
				.expect_err("failed")
				.message
				.contains("key release failed")
		);
		assert!(pending(&popup), "the next read of the popup waits for its choice");
		assert!(!pending(&other));
		MARKS.with_borrow_mut(Vec::clear);
	}

	#[test]
	fn a_popup_whose_first_key_was_refused_is_not_marked() {
		MARKS.with_borrow_mut(Vec::clear);
		let (popup, _) = popups();
		let refused = marking(|pending| -> CoreResult<()> {
			*pending = Some(Pending {
				popup:  popup.clone(),
				before: Some("Alpha".to_string()),
				sent:   None,
			});
			// The guard refused the first press, so nothing was posted.
			keys_sent(pending, false, Err(DesktopError::user_intervened("nothing was sent")))
		});
		assert!(refused.is_err());
		assert!(!pending(&popup), "a read after a refused key waits for nothing");
	}

	#[test]
	fn a_read_under_the_input_lease_never_waits_and_keeps_the_mark() {
		MARKS.with_borrow_mut(Vec::clear);
		let (popup, _) = popups();
		Pending { popup: popup.clone(), before: Some("Bravo".to_string()), sent: None }
			.mark_at(Instant::now());
		let source = control::CancellationSource::default();
		control::grant_for_test(&source);
		let lease = control::InputLease::acquire(&source.token(), false).expect("lease");
		// An element click finds its point with the lease held.
		settle_read(&popup).expect("read");
		MARKS.with_borrow(|marks| assert_eq!(marks.len(), 1, "the read under the lease settled"));
		drop(lease);
		// The popup is not running, so its value reads as changed: the read
		// after the call settles and clears the mark.
		settle_read(&popup).expect("read");
		MARKS.with_borrow(|marks| assert!(marks.is_empty()));
	}
}
