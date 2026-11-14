//! One unfiltered `WindowServer` pass over the on-screen windows.
//!
//! The capture snapshot answers "what can be captured and driven": it drops
//! unshared, tiny and title-less records and reports no layer. Popup menus,
//! pickers and the system's permission and password panels are exactly such
//! records, so a caller asking "what just appeared" needs every row.
#![cfg_attr(test, allow(dead_code, reason = "reached only from JavaScript, through napi"))]

use objc2_core_foundation::{
	CFArray, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CGRect,
};
use objc2_core_graphics::{
	CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
	kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
	kCGWindowOwnerName, kCGWindowOwnerPID,
};

use super::{
	super::{
		error::{CoreResult, DesktopError},
		roster::DesktopRosterWindow,
	},
	capture::{
		WindowDictionary, capture_permission, listed, window_number, window_string, window_value,
	},
};

/// Reads every on-screen window, front to back. Needs no Screen Recording
/// permission: without it titles are empty while owner, layer and bounds stay
/// exact.
pub(in crate::desktop) fn window_roster() -> CoreResult<Vec<DesktopRosterWindow>> {
	let snapshot = CGWindowListCopyWindowInfo(
		CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
		0,
	)
	.ok_or_else(|| DesktopError::capture_failed("Quartz window enumeration failed"))?;
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	let capture_granted = capture_permission();
	let mut windows = Vec::with_capacity(snapshot.len());
	// SAFETY: This copy-rule snapshot remains alive and is never mutated.
	for dictionary in unsafe { snapshot.iter_unchecked() } {
		if let Some(window) = roster_window(dictionary, capture_granted) {
			windows.push(window);
		}
	}
	Ok(windows)
}

fn roster_window(
	dictionary: &WindowDictionary,
	capture_granted: bool,
) -> Option<DesktopRosterWindow> {
	// SAFETY: The CoreGraphics key constants are process-lived. Typed
	// downcasts below reject absent or malformed window metadata.
	unsafe {
		let id = u32::try_from(window_number(dictionary, kCGWindowNumber)?).ok()?;
		let pid = u32::try_from(window_number(dictionary, kCGWindowOwnerPID)?).ok()?;
		let layer = i32::try_from(window_number(dictionary, kCGWindowLayer)?).ok()?;
		let alpha = double(dictionary, kCGWindowAlpha).unwrap_or(1.0);
		let rect = window_value(dictionary, kCGWindowBounds)?.downcast_ref::<CFDictionary>()?;
		let mut bounds = CGRect::default();
		if !CGRectMakeWithDictionaryRepresentation(Some(rect), &mut bounds) {
			return None;
		}
		let app = window_string(dictionary, kCGWindowOwnerName);
		let title = window_string(dictionary, kCGWindowName);
		// The capture snapshot's own rule, so `listWindows` and
		// `computer.window(id)` find exactly the windows marked listed.
		let listed = listed(dictionary, capture_granted, &title, &app);
		Some(DesktopRosterWindow {
			id: id.to_string(),
			pid,
			app,
			title,
			x: bounds.origin.x,
			y: bounds.origin.y,
			width: bounds.size.width,
			height: bounds.size.height,
			layer,
			alpha,
			listed,
		})
	}
}

fn double(dictionary: &WindowDictionary, key: &CFString) -> Option<f64> {
	let number = window_value(dictionary, key)?.downcast_ref::<CFNumber>()?;
	let mut out = 0f64;
	// SAFETY: The output is writable storage for the requested double type.
	unsafe { number.value(CFNumberType::Float64Type, (&raw mut out).cast()) }.then_some(out)
}
