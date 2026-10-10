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
	let applied = skylight::with_background_guard(element_pid(element)?, || {
		write_range(element, wanted)?;
		let mut last = None;
		poll(SELECTION_SETTLE_WAIT, || {
			last = read_range(element);
			(last == Some(wanted)).then_some(())
		});
		last.ok_or_else(|| {
			DesktopError::ax_failed(format!(
				"AX accepted the selection but {SELECTED_RANGE} could not be read back; inspect the \
				 element before typing"
			))
		})
	})?;
	if copy_string(element, "AXValue").as_deref() != Some(before.as_str()) {
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
			utf16_slice(&before, applied).unwrap_or_default()
		)));
	}
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
