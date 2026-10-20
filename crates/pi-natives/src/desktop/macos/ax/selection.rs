//! Selecting text in an element's value through `AXSelectedTextRange`.
//!
//! The selection is written as a range, so the value, the user's focus and
//! the pointer stay as they were, and no key is sent. Typing or AX insertion
//! into the app's focused element then replaces the selection. A background
//! drag across native text is made the same way ([`select_dragged`]).

use std::{ptr::NonNull, time::Duration};

use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{CFRange, CFString, CGPoint, CGRect};
use unicode_bidi::{BidiClass, bidi_class};

use super::{
	AxTextSelection, CoreResult, DesktopError, TextSelectRequest, TextSurface, Utf16Range,
	attribute_settable, ax_result, control, copy_bool, copy_held_attribute, copy_parameterized,
	copy_range, copy_string, element_pid, innermost_window_id, may_borrow_focus, open_menu,
	popup::poll, probe_application, process, skylight, text_surface, utf16_slice,
};

const SELECTED_RANGE: &str = "AXSelectedTextRange";
/// How long a written selection has to show up in the read-back. Native
/// fields answer on the first read; web content updates its AX selection
/// asynchronously after the DOM selection has already moved.
const SELECTION_SETTLE_WAIT: Duration = Duration::from_millis(500);

pub(super) fn select(
	element: &AXUIElement,
	request: &TextSelectRequest,
) -> CoreResult<AxTextSelection> {
	let pid = element_pid(element)?;
	// Selecting moves the caret that typing into a focused field replaces, so
	// an app the user brings forward during the call is left to them.
	let started_in_background = may_borrow_focus(skylight::front_pid(), pid);
	// A destroyed element throws `StaleRef` here, as from every element
	// operation, rather than reading as an unsettable one.
	let role = copy_held_attribute(element, "AXRole")?
		.and_then(|value| value.downcast::<CFString>().ok())
		.map_or_else(|| "element".to_owned(), |role| role.to_string());
	if !attribute_settable(element, SELECTED_RANGE) {
		return Err(DesktopError::ax_failed(format!(
			"{SELECTED_RANGE} is not settable on this {role}, so its text cannot be selected by \
			 accessibility; nothing was selected"
		)));
	}
	let Some(before) = copy_string(element, "AXValue") else {
		return Err(DesktopError::ax_failed(format!(
			"this {role} has no text AXValue to search; nothing was selected"
		)));
	};
	let wanted = request.locate(&before)?;
	write_selection(element, pid, started_in_background, &before, wanted)
}

/// Writes `wanted` as the selection of `element` of `pid`, whose value read
/// `before`, and returns the selection read back. `started_in_background`
/// says `pid` was behind the user's app when the call began.
fn write_selection(
	element: &AXUIElement,
	pid: libc::pid_t,
	started_in_background: bool,
	before: &str,
	wanted: Utf16Range,
) -> CoreResult<AxTextSelection> {
	let applied = apply(
		before,
		wanted,
		|action| skylight::with_background_guard(pid, action),
		|| started_in_background && !may_borrow_focus(skylight::front_pid(), pid),
		|| write_range(element, wanted),
		|| read_range(element),
		|| copy_string(element, "AXValue"),
		SELECTION_SETTLE_WAIT,
	)?;
	let to_u32 = |units: usize| {
		u32::try_from(units).map_err(|_| DesktopError::internal("selection offset exceeds u32"))
	};
	Ok(AxTextSelection {
		start:   to_u32(applied.start)?,
		length:  to_u32(applied.length)?,
		text:    utf16_slice(before, applied).unwrap_or_default().to_owned(),
		focused: copy_bool(element, "AXFocused").unwrap_or(false),
	})
}

/// A background left drag from global point `start` to `end` in an app of
/// `pid`, made as a text selection when both points lie on the text of one
/// native text element mapping to window `wid` (an attached sheet's, or for a
/// `remote` view such as a system Open or Save panel, the drawing process's
/// window): the element at both points, whose `AXSelectedTextRange` is
/// settable and which places each point on a character (`AXRangeForPosition`,
/// `AXBoundsForRange`), outside web content and terminal grids. The selection
/// runs between the carets a press and a release there would leave, so no
/// mouse event is posted and no drag-and-drop session can begin. `None`, with
/// nothing written, for any other drag, for one pressing where it could pick
/// up an item (on selected text or on an attachment), and in text holding
/// right-to-left script.
pub(in crate::desktop::macos) fn select_dragged(
	pid: libc::pid_t,
	wid: u32,
	remote: bool,
	start: (f64, f64),
	end: (f64, f64),
) -> CoreResult<Option<AxTextSelection>> {
	// Read before the probes below, which can block: an app the user brings
	// forward meanwhile is left to them, as in `select`.
	let started_in_background = may_borrow_focus(skylight::front_pid(), pid);
	if shows_terminal_grid(remote, || process::is_terminal(pid)) {
		return Ok(None);
	}
	let Some(app) = probe_application(pid) else {
		return Ok(None);
	};
	let Some(element) = open_menu::hit_test(&app, start.0, start.1) else {
		return Ok(None);
	};
	if open_menu::hit_test(&app, end.0, end.1).is_none_or(|other| *other != *element)
		|| !attribute_settable(&element, SELECTED_RANGE)
		|| innermost_window_id(&element).map(|(id, _)| id) != Some(wid)
		|| text_surface(&element) != TextSurface::Native
	{
		return Ok(None);
	}
	let Some(before) = copy_string(&element, "AXValue") else {
		return Ok(None);
	};
	let caret = |(x, y)| {
		let character = range_at(&element, x, y)?;
		character_caret(x, y, character, bounds_of(&element, character)?)
	};
	let (Some(press), Some(release)) = (caret(start), caret(end)) else {
		return Ok(None);
	};
	let Some(wanted) = dragged_range(&before, press, release, read_range(&element)) else {
		return Ok(None);
	};
	write_selection(&element, pid, started_in_background, &before, wanted).map(Some)
}

/// Whether the text under a drag in an app is a terminal's rendered grid
/// (`is_terminal`, read only when needed): never for a `remote` view, such as
/// a terminal app's Save panel, whose fields `openAndSavePanelService` draws.
fn shows_terminal_grid(remote: bool, is_terminal: impl FnOnce() -> bool) -> bool {
	!remote && is_terminal()
}

/// Where a press or release lands in an element's text: the character
/// `AXRangeForPosition` names there, and the caret it leaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Caret {
	character: Utf16Range,
	offset:    usize,
}

/// The caret a press at `(x, y)` leaves beside `character`, whose bounds are
/// `bounds`: before it on its left half, after it on its right half, as
/// `AppKit` text views place it in left-to-right text ([`dragged_range`] keeps
/// right-to-left text out). `None` when the bounds are empty or the point lies
/// off the character's line by more than half a line, as when an app answers
/// `AXRangeForPosition` without placing the point.
fn character_caret(x: f64, y: f64, character: Utf16Range, bounds: CGRect) -> Option<Caret> {
	let (top, height) = (bounds.origin.y, bounds.size.height);
	if height <= 0.0 || y < height.mul_add(-0.5, top) || y > height.mul_add(1.5, top) {
		return None;
	}
	let offset = if x < bounds.origin.x + bounds.size.width / 2.0 {
		character.start
	} else {
		character.start + character.length
	};
	Some(Caret { character, offset })
}

/// The selection a drag from `press` to `release` leaves in `value`, or
/// `None` when its press would pick up an item instead of selecting (a press
/// on the `current` selection drags the selected text, and a press on an
/// attachment drags the attachment), or when `value` holds right-to-left
/// script, where the half of a character a caret lands on depends on the
/// direction of its run.
fn dragged_range(
	value: &str,
	press: Caret,
	release: Caret,
	current: Option<Utf16Range>,
) -> Option<Utf16Range> {
	let on_selection = current.is_some_and(|selected| {
		selected.length > 0
			&& press.character.start < selected.start + selected.length
			&& selected.start < press.character.start + press.character.length.max(1)
	});
	utf16_slice(value, release.character)?;
	if on_selection
		|| utf16_slice(value, press.character)?.contains(OBJECT_REPLACEMENT)
		|| value.chars().any(right_to_left)
	{
		return None;
	}
	let start = press.offset.min(release.offset);
	Some(Utf16Range { start, length: press.offset.max(release.offset) - start })
}

/// The character an attachment (an image, a file) stands in as in its text
/// view's value.
const OBJECT_REPLACEMENT: char = '\u{FFFC}';

/// Whether `c` is right-to-left script, or a mark opening a right-to-left run.
fn right_to_left(c: char) -> bool {
	matches!(
		bidi_class(c),
		BidiClass::R | BidiClass::AL | BidiClass::RLE | BidiClass::RLO | BidiClass::RLI
	)
}

/// The character `element` places at global point `(x, y)`.
fn range_at(element: &AXUIElement, x: f64, y: f64) -> Option<Utf16Range> {
	let point = CGPoint { x, y };
	// SAFETY: `point` is a live CGPoint, the type AXValueCreate is told to copy.
	let point = unsafe { AXValue::new(AXValueType::CGPoint, NonNull::from(&point).cast()) }?;
	let value = copy_parameterized(element, "AXRangeForPosition", &point)?
		.downcast::<AXValue>()
		.ok()?;
	let mut range = CFRange { location: 0, length: 0 };
	// SAFETY: The output is a live CFRange and the AXValue accessor validates
	// the requested type before writing it.
	if !unsafe { value.value(AXValueType::CFRange, NonNull::from(&mut range).cast()) } {
		return None;
	}
	Some(Utf16Range {
		start:  usize::try_from(range.location).ok()?,
		length: usize::try_from(range.length).ok()?,
	})
}

/// The global bounds of `range` in `element`'s text.
fn bounds_of(element: &AXUIElement, range: Utf16Range) -> Option<CGRect> {
	let range = CFRange {
		location: isize::try_from(range.start).ok()?,
		length:   isize::try_from(range.length).ok()?,
	};
	// SAFETY: `range` is a live CFRange, the type AXValueCreate is told to copy.
	let range = unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&range).cast()) }?;
	let value = copy_parameterized(element, "AXBoundsForRange", &range)?
		.downcast::<AXValue>()
		.ok()?;
	let mut rect = CGRect::default();
	// SAFETY: The output is a live CGRect and the AXValue accessor validates
	// the requested type before writing it.
	unsafe { value.value(AXValueType::CGRect, NonNull::from(&mut rect).cast()) }.then_some(rect)
}

/// Writes `wanted` inside `guard`, lets the read-back settle there, then
/// confirms the selection and value once the guard has finished, so the
/// verdict reflects the element after the guard's own post-action settle.
fn apply(
	before: &str,
	wanted: Utf16Range,
	guard: impl FnOnce(&mut dyn FnMut() -> CoreResult<()>) -> CoreResult<()>,
	brought_forward: impl Fn() -> bool,
	write: impl Fn() -> CoreResult<()>,
	read_range: impl Fn() -> Option<Utf16Range>,
	read_value: impl Fn() -> Option<String>,
	settle: Duration,
) -> CoreResult<Utf16Range> {
	guard(&mut || {
		// The probes before the write can block, the front-app read included.
		// The selection is not moved in an app the user brought forward or used
		// ([`control::intervention::check_press`]), nor by a run cancelled
		// meanwhile.
		if brought_forward() {
			return Err(DesktopError::ax_failed(
				"the app came to the front during the call, so its caret is the user's; nothing was \
				 selected",
			));
		}
		control::check()?;
		control::intervention::check_press()?;
		write()?;
		poll(settle, || (read_range() == Some(wanted)).then_some(()));
		Ok(())
	})?;
	// The write was accepted, so a selection that cannot be read back, as when
	// the app does not reply in time, may already be in place: unconfirmed,
	// not failed.
	let applied = read_range().ok_or_else(|| {
		DesktopError::ax_unconfirmed(format!(
			"AX accepted the selection but {SELECTED_RANGE} could not be read back, so it may \
			 already apply: inspect the element's selection before retrying or typing"
		))
	})?;
	if read_value().as_deref() != Some(before) {
		return Err(DesktopError::ax_failed(format!(
			"the element's value changed while selecting; the selection reads back at UTF-16 {} \
			 length {}; inspect the element before typing",
			applied.start, applied.length
		)));
	}
	if applied != wanted {
		return Err(DesktopError::ax_failed(format!(
			"asked to select UTF-16 {} length {} but the element reads back {} length {} ({:?}); a \
			 following type would not replace the requested text",
			wanted.start,
			wanted.length,
			applied.start,
			applied.length,
			utf16_slice(before, applied).unwrap_or_default()
		)));
	}
	Ok(applied)
}

/// The element's selection, or `None` when it has none or reports a
/// negative offset.
fn read_range(element: &AXUIElement) -> Option<Utf16Range> {
	let range = copy_range(element, SELECTED_RANGE)?;
	Some(Utf16Range {
		start:  usize::try_from(range.location).ok()?,
		length: usize::try_from(range.length).ok()?,
	})
}

fn write_range(element: &AXUIElement, range: Utf16Range) -> CoreResult<()> {
	let to_isize = |units: usize| {
		isize::try_from(units).map_err(|_| DesktopError::internal("selection offset exceeds isize"))
	};
	let range = CFRange { location: to_isize(range.start)?, length: to_isize(range.length)? };
	// SAFETY: `range` is a live CFRange, the type AXValueCreate is told to copy.
	let value = unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&range).cast()) }
		.ok_or_else(|| DesktopError::ax_failed("creating the AXValue range failed"))?;
	let attribute = CFString::from_str(SELECTED_RANGE);
	// SAFETY: The element, attribute and range value remain retained for the
	// setter.
	write_result(unsafe { element.set_attribute_value(&attribute, &value) })
}

/// The outcome of the selection write. `CannotComplete` means the app did not
/// reply in time or messaging failed: the write was made and the caret may
/// already have moved, so the outcome is unconfirmed rather than failed.
fn write_result(error: AXError) -> CoreResult<()> {
	if error == AXError::CannotComplete {
		return Err(DesktopError::ax_unconfirmed(format!(
			"setting {SELECTED_RANGE} got no reply in time (CannotComplete) and may still apply: \
			 inspect the element's selection before retrying or typing"
		)));
	}
	ax_result(error, format!("setting {SELECTED_RANGE} failed; nothing was selected"))
}

#[cfg(test)]
mod tests {
	use std::{
		cell::Cell,
		time::{Duration, Instant},
	};

	use objc2_application_services::AXError;
	use objc2_core_foundation::{CGPoint, CGRect, CGSize};

	use super::{
		Caret, CoreResult, Utf16Range, apply, character_caret, dragged_range, shows_terminal_grid,
		write_result,
	};
	use crate::desktop::{control, error::ErrorCode};

	const VALUE: &str = "alpha beta gamma";
	const WANTED: Utf16Range = Utf16Range { start: 6, length: 4 };

	#[test]
	fn a_drag_point_lands_on_the_caret_beside_the_nearer_half_of_its_character() {
		let character = Utf16Range { start: 5, length: 1 };
		let bounds = CGRect::new(CGPoint::new(10.0, 100.0), CGSize::new(10.0, 14.0));
		let at = |x, y| character_caret(x, y, character, bounds).map(|caret| caret.offset);
		assert_eq!(at(12.0, 107.0), Some(5));
		assert_eq!(at(18.0, 107.0), Some(6));
		// Between lines still counts; a point well off the character's line,
		// or a character with no extent, is not placed.
		assert_eq!(at(18.0, 94.0), Some(6));
		assert_eq!(at(12.0, 90.0), None);
		assert_eq!(at(12.0, 130.0), None);
		let empty = CGRect::new(CGPoint::new(0.0, 1200.0), CGSize::new(0.0, 0.0));
		assert_eq!(character_caret(0.0, 1200.0, Utf16Range { start: 0, length: 0 }, empty), None);
	}

	#[test]
	fn a_terminal_app_s_remote_panel_is_not_its_grid() {
		assert!(shows_terminal_grid(false, || true));
		assert!(!shows_terminal_grid(false, || false));
		assert!(!shows_terminal_grid(true, || panic!("a remote panel is never the grid")));
	}

	#[test]
	fn a_drag_selects_between_its_carets_unless_its_press_would_pick_up_an_item() {
		let caret = |start, offset| Caret { character: Utf16Range { start, length: 1 }, offset };
		let value = "The quick brown fox";
		let (press, release) = (caret(4, 4), caret(8, 9));
		let quick = Some(Utf16Range { start: 4, length: 5 });
		assert_eq!(dragged_range(value, press, release, None), quick);
		assert_eq!(dragged_range(value, release, press, None), quick);
		// A caret is no selection to drag.
		let caret_only = Some(Utf16Range { start: 6, length: 0 });
		assert_eq!(dragged_range(value, press, release, caret_only), quick);
		// A press on selected text drags that text.
		let selected = Some(Utf16Range { start: 0, length: 5 });
		assert_eq!(dragged_range(value, press, release, selected), None);
		let before = Some(Utf16Range { start: 0, length: 4 });
		assert_eq!(dragged_range(value, press, release, before), quick);
		// A press on an attachment drags the attachment.
		let attached = "a\u{FFFC}b";
		assert_eq!(dragged_range(attached, caret(1, 1), caret(2, 3), None), None);
		assert_eq!(
			dragged_range(attached, caret(2, 3), caret(0, 0), None),
			Some(Utf16Range { start: 0, length: 3 })
		);
		// A release the app places past the end of the text is not trusted.
		assert_eq!(dragged_range(value, press, caret(19, 20), None), None);
		// In right-to-left text the caret's side of a character flips, so it
		// keeps the refusal, even for a drag across a left-to-right run
		// beside it.
		assert_eq!(dragged_range("The quick שלום", press, release, None), None);
		assert_eq!(dragged_range("The quick مرحبا", press, release, None), None);
		assert_eq!(dragged_range("The quick\u{202E}brown", press, release, None), None);
	}

	/// Runs `apply` with a guard that marks when its own post-action settle has
	/// finished, and a selection read that `range` answers from the number of
	/// reads so far and whether the guard is done.
	fn run(
		range: impl Fn(usize, bool) -> Option<Utf16Range>,
		value: &str,
	) -> CoreResult<Utf16Range> {
		let settled = Cell::new(false);
		let reads = Cell::new(0);
		let writes = Cell::new(0);
		let result = apply(
			VALUE,
			WANTED,
			|action| {
				let result = action();
				settled.set(true);
				result
			},
			|| false,
			|| {
				writes.update(|v| v + 1);
				Ok(())
			},
			|| {
				reads.update(|v| v + 1);
				range(reads.get(), settled.get())
			},
			|| Some(value.to_owned()),
			Duration::from_millis(200),
		);
		assert_eq!(writes.get(), 1, "the selection is written exactly once");
		result
	}

	#[test]
	fn a_selection_write_without_a_reply_is_unconfirmed_not_failed() {
		assert!(write_result(AXError::Success).is_ok());
		let error = write_result(AXError::CannotComplete).unwrap_err();
		assert_eq!(error.code, ErrorCode::AxUnconfirmed, "{error}");
		assert!(error.message.contains("inspect the element"), "{error}");
		let error = write_result(AXError::IllegalArgument).unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed, "{error}");
		assert!(error.message.contains("nothing was selected"), "{error}");
	}

	#[test]
	fn a_selection_that_settles_after_the_write_is_confirmed() {
		let lagging = |reads: usize, _| {
			Some(if reads < 3 {
				Utf16Range { start: 16, length: 0 }
			} else {
				WANTED
			})
		};
		assert_eq!(run(lagging, VALUE).unwrap(), WANTED);
	}

	#[test]
	fn a_selection_moved_during_the_guard_settle_is_reported_not_returned() {
		let moved = |_, settled: bool| {
			Some(if settled {
				Utf16Range { start: 0, length: 0 }
			} else {
				WANTED
			})
		};
		let error = run(moved, VALUE).unwrap_err();
		assert!(error.message.contains("reads back 0 length 0"), "{error}");
	}

	#[test]
	fn a_selection_lost_during_the_guard_settle_is_reported() {
		let lost = |_, settled: bool| (!settled).then_some(WANTED);
		let error = run(lost, VALUE).unwrap_err();
		assert_eq!(error.code, ErrorCode::AxUnconfirmed, "{error}");
		assert!(error.message.contains("could not be read back"), "{error}");
	}

	#[test]
	fn a_value_changed_while_selecting_is_reported() {
		let error = run(|_, _| Some(WANTED), "alpha beta gamma!").unwrap_err();
		assert!(error.message.contains("value changed"), "{error}");
	}

	/// Runs `apply` with a write that would succeed, cancelling the run during
	/// the front-app read, the last probe before the write, and returns the
	/// outcome and whether the selection was written.
	fn checked(cancel: bool, brought_forward: bool) -> (Result<Utf16Range, ErrorCode>, bool) {
		let source = control::CancellationSource::default();
		let token = source.token();
		let wrote = Cell::new(false);
		let result = control::with_token_for_test(&token, || {
			apply(
				VALUE,
				WANTED,
				|action| action(),
				|| {
					if cancel {
						source.cancel();
					}
					brought_forward
				},
				|| {
					wrote.set(true);
					Ok(())
				},
				|| Some(WANTED),
				|| Some(VALUE.to_owned()),
				Duration::ZERO,
			)
		});
		(result.map_err(|error| error.code), wrote.get())
	}

	#[test]
	fn a_run_cancelled_before_the_write_selects_nothing() {
		assert_eq!(checked(false, false), (Ok(WANTED), true));
		assert_eq!(checked(true, false), (Err(ErrorCode::Cancelled), false));
	}

	#[test]
	fn an_app_brought_forward_during_the_call_keeps_its_caret() {
		assert_eq!(checked(false, true), (Err(ErrorCode::AxFailed), false));
	}

	#[test]
	fn a_user_typing_in_the_app_during_the_probes_keeps_its_caret() {
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let _watch = listener.admit(7, &token).unwrap();
		let wrote = Cell::new(false);
		let result = apply(
			VALUE,
			WANTED,
			|action| action(),
			|| {
				// The user types into the field during the front-app read.
				listener.record_for_test(7, Instant::now());
				false
			},
			|| {
				wrote.set(true);
				Ok(())
			},
			|| Some(WANTED),
			|| Some(VALUE.to_owned()),
			Duration::ZERO,
		);
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		assert!(!wrote.get(), "the selection was written after the user's input");
	}
}
