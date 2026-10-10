//! Selecting text in an element's value through `AXSelectedTextRange`.
//!
//! The selection is written as a range, so the value, the user's focus and
//! the pointer stay as they were, and no key is sent. Typing or AX insertion
//! into the app's focused element then replaces the selection.

use std::{ptr::NonNull, time::Duration};

use objc2_application_services::{AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{CFRange, CFString};

use super::{
	AxTextSelection, CoreResult, DesktopError, TextSelectRequest, Utf16Range, attribute_settable,
	ax_result, copy_bool, copy_range, copy_string, element_pid, popup::poll, skylight, utf16_slice,
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
	let role = copy_string(element, "AXRole").unwrap_or_else(|| "element".to_owned());
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
	let pid = element_pid(element)?;
	let applied = apply(
		&before,
		wanted,
		|action| skylight::with_background_guard(pid, action),
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
		text:    utf16_slice(&before, applied).unwrap_or_default().to_owned(),
		focused: copy_bool(element, "AXFocused").unwrap_or(false),
	})
}

/// Writes `wanted` inside `guard`, lets the read-back settle there, then
/// confirms the selection and value once the guard has finished, so the
/// verdict reflects the element after the guard's own post-action settle.
fn apply(
	before: &str,
	wanted: Utf16Range,
	guard: impl FnOnce(&mut dyn FnMut() -> CoreResult<()>) -> CoreResult<()>,
	write: impl Fn() -> CoreResult<()>,
	read_range: impl Fn() -> Option<Utf16Range>,
	read_value: impl Fn() -> Option<String>,
	settle: Duration,
) -> CoreResult<Utf16Range> {
	guard(&mut || {
		write()?;
		poll(settle, || (read_range() == Some(wanted)).then_some(()));
		Ok(())
	})?;
	let applied = read_range().ok_or_else(|| {
		DesktopError::ax_failed(format!(
			"AX accepted the selection but {SELECTED_RANGE} could not be read back; inspect the \
			 element before typing"
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
	let error = unsafe { element.set_attribute_value(&attribute, &value) };
	ax_result(error, format!("setting {SELECTED_RANGE} failed; nothing was selected"))
}

#[cfg(test)]
mod tests {
	use std::{cell::Cell, time::Duration};

	use super::{CoreResult, Utf16Range, apply};

	const VALUE: &str = "alpha beta gamma";
	const WANTED: Utf16Range = Utf16Range { start: 6, length: 4 };

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
			|| {
				writes.set(writes.get() + 1);
				Ok(())
			},
			|| {
				reads.set(reads.get() + 1);
				range(reads.get(), settled.get())
			},
			|| Some(value.to_owned()),
			Duration::from_millis(200),
		);
		assert_eq!(writes.get(), 1, "the selection is written exactly once");
		result
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
		assert!(error.message.contains("could not be read back"), "{error}");
	}

	#[test]
	fn a_value_changed_while_selecting_is_reported() {
		let error = run(|_, _| Some(WANTED), "alpha beta gamma!").unwrap_err();
		assert!(error.message.contains("value changed"), "{error}");
	}
}
