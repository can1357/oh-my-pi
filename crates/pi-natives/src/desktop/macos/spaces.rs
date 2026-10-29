//! Runtime-resolved `WindowServer` Space movement. No activation, Space switch,
//! Dock injection, or security-setting changes are used as a substitute.

use std::{
	ptr::NonNull,
	sync::LazyLock,
	time::{Duration, Instant},
};

use objc2_core_foundation::{CFArray, CFNumber, CFRetained, CFString, CFType};

use super::{route, skylight};
use crate::desktop::{
	control,
	error::{CoreResult, DesktopError, ErrorCode},
};

// Native ABI reference (not an implementation dependency):
// https://raw.githubusercontent.com/koekeishiya/yabai/master/src/misc/extern.h
// In particular, SLSMoveWindowsToManagedSpace returns void, not CGError.
type MainConnection = unsafe extern "C" fn() -> i32;
type ActiveSpace = unsafe extern "C" fn(i32) -> u64;
type CopySpaces = unsafe extern "C" fn(i32, i32, &CFArray) -> *const CFArray;
type MoveWindows = unsafe extern "C" fn(i32, &CFArray, u64);
type WindowOwner = unsafe extern "C" fn(i32, u32, *mut i32) -> i32;
type ConnectionPid = unsafe extern "C" fn(i32, *mut libc::pid_t) -> i32;
type SpaceType = unsafe extern "C" fn(i32, u64) -> i32;
type CopyDisplays = unsafe extern "C" fn(i32) -> *const CFArray;
type DisplaySpace = unsafe extern "C" fn(i32, &CFString) -> u64;

struct SpaceSpi {
	connection:     MainConnection,
	active:         ActiveSpace,
	copy_spaces:    CopySpaces,
	move_windows:   MoveWindows,
	window_owner:   WindowOwner,
	connection_pid: ConnectionPid,
	space_type:     SpaceType,
	copy_displays:  CopyDisplays,
	display_space:  DisplaySpace,
}

static SPI: LazyLock<Option<SpaceSpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(SpaceSpi {
		connection:     route::symbol(c"SLSMainConnectionID")
			.or_else(|| route::symbol(c"CGSMainConnectionID"))?,
		active:         route::symbol(c"SLSGetActiveSpace")
			.or_else(|| route::symbol(c"CGSGetActiveSpace"))?,
		copy_spaces:    route::symbol(c"SLSCopySpacesForWindows")?,
		move_windows:   route::symbol(c"SLSMoveWindowsToManagedSpace")?,
		window_owner:   route::symbol(c"SLSGetWindowOwner")?,
		connection_pid: route::symbol(c"SLSConnectionGetPID")?,
		space_type:     route::symbol(c"SLSSpaceGetType")?,
		copy_displays:  route::symbol(c"SLSCopyManagedDisplays")?,
		display_space:  route::symbol(c"SLSManagedDisplayGetCurrentSpace")?,
	})
});

pub(super) fn supported() -> bool {
	SPI.is_some() && skylight::takeover_available()
}

fn denied(message: impl Into<String>) -> DesktopError {
	DesktopError::new(ErrorCode::SpaceMoveDenied, message)
}

pub(super) fn bring_to_current_space(id: &str) -> CoreResult<()> {
	control::check()?;
	let spi = SPI.as_ref().ok_or_else(|| {
		DesktopError::new(
			ErrorCode::SpaceUnsupported,
			"this macOS version does not expose the required window Space-movement and verification \
			 APIs; move the window manually with Mission Control",
		)
	})?;
	let wid = id
		.parse::<u32>()
		.ok()
		.filter(|id| *id != 0)
		.ok_or_else(|| DesktopError::invalid_target("invalid native window id for Space movement"))?;
	// SAFETY: The runtime symbol has the exact no-argument connection ABI.
	let connection = unsafe { (spi.connection)() };
	if connection <= 0 {
		return Err(denied("WindowServer did not provide a valid connection for Space movement"));
	}
	// Resolve through WindowServer, not capturable windows: the target is
	// normally off the current Space and therefore absent from capture lists.
	let pid = owner_pid(spi, connection, wid)?;
	let current = active_space(spi, connection)?;
	// Moving another application's window into a fullscreen/system Space is
	// not an ordinary desktop move and can violate its ownership semantics.
	// SAFETY: The connection and Space id were read from WindowServer.
	if unsafe { (spi.space_type)(connection, current) } != 0 {
		return Err(denied(
			"the current Space is fullscreen or system-managed; leave fullscreen or choose a desktop \
			 Space, then retry",
		));
	}
	let number = CFNumber::new_i64(i64::from(wid));
	let windows = CFArray::from_objects(&[&*number]);
	let before = memberships(spi, connection, windows.as_opaque())?;
	if before.contains(&current) {
		// Already visible here (including windows pinned to all Spaces).
		return Ok(());
	}
	let focus = skylight::front_window_context().ok_or_else(|| {
		denied(
			"cannot establish the user's current focus; grant Accessibility access before moving a \
			 background window",
		)
	})?;
	let displays = display_spaces(spi, connection)?;
	let result = skylight::with_background_guard(pid, || {
		verify_owner(spi, connection, wid, pid)?;
		if active_space(spi, connection)? != current || display_spaces(spi, connection)? != displays {
			return Err(denied(
				"the active Space changed before dispatch; no move was requested, retry from the \
				 intended desktop Space",
			));
		}
		control::check()?;
		// SAFETY: The array contains precisely one retained CFNumber window id;
		// the function is runtime-resolved with its void-returning native ABI.
		unsafe { (spi.move_windows)(connection, windows.as_opaque(), current) };
		let deadline = Instant::now() + Duration::from_millis(1200);
		loop {
			control::check()?;
			verify_owner(spi, connection, wid, pid)?;
			let observed = memberships(spi, connection, windows.as_opaque())?;
			if verified_move(current, &observed) {
				return Ok(());
			}
			if Instant::now() >= deadline {
				return Err(denied(format!(
					"WindowServer did not move window {wid} to Space {current} (memberships: \
					 {observed:?}); macOS may prohibit this window or this process from moving it. \
					 Move it manually in Mission Control; no security settings were changed"
				)));
			}
			control::wait(Duration::from_millis(25))?;
		}
	});
	// Check after the bounded focus guard has finished, not merely after the
	// SPI call. Never restore a Space or override a newer user focus choice.
	let unchanged = active_space(spi, connection)? == current
		&& display_spaces(spi, connection)? == displays
		&& skylight::front_window_context() == Some(focus);
	if !unchanged {
		return Err(denied(format!(
			"the user's Space or focus changed during movement of window {wid}; the window may \
			 already have moved. Inspect the desktop before retrying; no Space switch was requested"
		)));
	}
	result
}

/// Whether `pid` has a normal window on a Space no display shows now, which
/// on-screen window lists leave out. `None` when the window list or a
/// window's Space membership cannot be read.
pub(in crate::desktop) fn window_on_another_space(pid: libc::pid_t) -> Option<bool> {
	let windows = super::capture::normal_window_ids(pid)?;
	let spi = SPI.as_ref()?;
	// SAFETY: The runtime symbol has the exact no-argument connection ABI.
	let connection = unsafe { (spi.connection)() };
	if connection <= 0 {
		return None;
	}
	// With "Displays have separate Spaces", each display shows its own.
	let shown: Vec<u64> = display_spaces(spi, connection)
		.ok()?
		.into_iter()
		.map(|(_, space)| space)
		.collect();
	on_another_space(
		&shown,
		windows
			.iter()
			.map(|&wid| window_spaces(spi, connection, wid)),
	)
}

/// Whether one of the windows whose Space memberships are `memberships`
/// belongs only to Spaces no display shows (`shown`); a window
/// `WindowServer` keeps ordered out belongs to none, and one on every Space
/// belongs to a shown one too. `None` once a membership is unknown and none
/// seen so far is elsewhere.
fn on_another_space(
	shown: &[u64],
	memberships: impl IntoIterator<Item = Option<Vec<u64>>>,
) -> Option<bool> {
	for spaces in memberships {
		let spaces = spaces?;
		if !spaces.is_empty() && !spaces.iter().any(|space| shown.contains(space)) {
			return Some(true);
		}
	}
	Some(false)
}

/// Window `wid`'s Space memberships, empty for none; `None` when
/// `WindowServer` does not say.
fn window_spaces(spi: &SpaceSpi, connection: i32, wid: u32) -> Option<Vec<u64>> {
	let number = CFNumber::new_i64(i64::from(wid));
	let window = CFArray::from_objects(&[&*number]);
	// SAFETY: The window array remains alive; selector 7 includes all Spaces.
	let spaces = retain_array(
		unsafe { (spi.copy_spaces)(connection, 7, window.as_opaque()) },
		"window Space memberships",
	)
	.ok()?;
	spaces
		.iter()
		.map(|space| {
			space
				.downcast_ref::<CFNumber>()
				.and_then(CFNumber::as_i64)
				.and_then(|id| u64::try_from(id).ok())
		})
		.collect()
}

fn verified_move(current: u64, observed: &[u64]) -> bool {
	current != 0 && observed == [current]
}

fn active_space(spi: &SpaceSpi, connection: i32) -> CoreResult<u64> {
	// SAFETY: The connection is live and the symbol's ABI was resolved above.
	let current = unsafe { (spi.active)(connection) };
	if current == 0 {
		Err(denied(
			"WindowServer did not identify the current Space; retry after Mission Control or a Space \
			 transition finishes",
		))
	} else {
		Ok(current)
	}
}

fn verify_owner(
	spi: &SpaceSpi,
	connection: i32,
	wid: u32,
	expected: libc::pid_t,
) -> CoreResult<()> {
	if owner_pid(spi, connection, wid)? != expected {
		return Err(DesktopError::window_not_found(format!(
			"window {wid} no longer belongs to process {expected}; Space move refused"
		)));
	}
	Ok(())
}

fn owner_pid(spi: &SpaceSpi, connection: i32, wid: u32) -> CoreResult<libc::pid_t> {
	let mut owner = 0;
	let mut pid = 0;
	// SAFETY: Both output pointers are initialized writable scalars. The second
	// lookup only runs when WindowServer returned the owner connection.
	let valid = unsafe {
		(spi.window_owner)(connection, wid, &mut owner) == 0
			&& (spi.connection_pid)(owner, &mut pid) == 0
	};
	if !valid || pid <= 0 {
		return Err(DesktopError::window_not_found(format!(
			"window {wid} has no identifiable owning process; Space move refused"
		)));
	}
	Ok(pid)
}

fn retain_array(raw: *const CFArray, operation: &str) -> CoreResult<CFRetained<CFArray<CFType>>> {
	let pointer = NonNull::new(raw.cast_mut()).ok_or_else(|| {
		denied(format!("WindowServer returned no {operation}; cannot verify Space movement"))
	})?;
	// SAFETY: The caller supplies a Copy-rule CFArray returned at +1. These
	// WindowServer APIs return arrays of CoreFoundation objects.
	let array = unsafe { CFRetained::from_raw(pointer) };
	// SAFETY: These WindowServer copy APIs return arrays containing only CF
	// objects.
	Ok(unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) })
}

fn memberships(spi: &SpaceSpi, connection: i32, windows: &CFArray) -> CoreResult<Vec<u64>> {
	// SAFETY: The window array remains alive; selector 7 includes all Spaces.
	let array = retain_array(
		unsafe { (spi.copy_spaces)(connection, 7, windows) },
		"window Space memberships",
	)?;
	let mut spaces = Vec::with_capacity(array.len());
	for value in array.iter() {
		let id = value
			.downcast_ref::<CFNumber>()
			.and_then(CFNumber::as_i64)
			.and_then(|id| u64::try_from(id).ok())
			.filter(|id| *id != 0)
			.ok_or_else(|| {
				denied("WindowServer returned malformed Space membership; move cannot be verified")
			})?;
		spaces.push(id);
	}
	if spaces.is_empty() {
		return Err(denied(
			"the target window has no readable Space membership; it may have closed or be \
			 system-managed",
		));
	}
	spaces.sort_unstable();
	spaces.dedup();
	Ok(spaces)
}

fn display_spaces(spi: &SpaceSpi, connection: i32) -> CoreResult<Vec<(String, u64)>> {
	// SAFETY: The live connection is the only argument to this Copy-rule API.
	let displays = retain_array(unsafe { (spi.copy_displays)(connection) }, "managed displays")?;
	let mut result = Vec::with_capacity(displays.len());
	for display in displays.iter() {
		let display = display
			.downcast_ref::<CFString>()
			.ok_or_else(|| denied("WindowServer returned malformed managed displays"))?;
		// SAFETY: The retained display identifier and live connection outlive the
		// call.
		let space = unsafe { (spi.display_space)(connection, display) };
		if space == 0 {
			return Err(denied("cannot establish the current Space for every display"));
		}
		result.push((display.to_string(), space));
	}
	if result.is_empty() {
		return Err(denied("WindowServer returned no managed displays"));
	}
	result.sort_unstable();
	Ok(result)
}

#[cfg(test)]
mod tests {
	use super::{on_another_space, verified_move};

	#[test]
	fn ignored_or_partial_native_move_is_not_success() {
		assert!(!verified_move(9, &[3]));
		assert!(!verified_move(9, &[3, 9]));
		assert!(!verified_move(9, &[]));
		assert!(!verified_move(0, &[0]));
		assert!(verified_move(9, &[9]));
	}

	#[test]
	fn an_unknown_space_membership_is_not_proof_of_no_window_elsewhere() {
		// Space 9 is current. A window on Space 4 is elsewhere; one kept
		// ordered out belongs to no Space.
		assert_eq!(on_another_space(&[9], [Some(vec![9]), Some(vec![4])]), Some(true));
		assert_eq!(on_another_space(&[9], [Some(vec![9]), Some(vec![])]), Some(false));
		assert_eq!(on_another_space(&[9], []), Some(false));
		// A window whose membership WindowServer did not give may be elsewhere.
		assert_eq!(on_another_space(&[9], [Some(vec![9]), None]), None);
	}

	#[test]
	fn a_window_on_any_displays_shown_space_is_not_elsewhere() {
		// Displays have separate Spaces: the main display shows 9, the second
		// 4, so a window on 4 is on screen there, not on another Space.
		assert_eq!(on_another_space(&[9, 4], [Some(vec![4])]), Some(false));
		// A window on every Space belongs to a shown one too.
		assert_eq!(on_another_space(&[9, 4], [Some(vec![3, 9])]), Some(false));
		assert_eq!(on_another_space(&[9, 4], [Some(vec![3])]), Some(true));
	}
}
