//! Windows session and input-desktop availability.

#[cfg(target_os = "windows")]
use super::super::types::{DisplaySelector, ScreenState};

#[derive(Clone, Copy)]
struct SessionState {
	active: bool,
	locked: bool,
}

/// Unavailable desktops count as locked, including access-denied and
/// non-interactive sessions. A failed WTS query defers to the input-desktop
/// probe.
fn screen_locked(session: Option<SessionState>, desktop_name: Option<&[u16]>) -> bool {
	if session.is_some_and(|state| !state.active || state.locked) {
		return true;
	}
	desktop_name.is_none_or(|name| {
		!(name.len() == 7
			&& name
				.iter()
				.zip(b"default")
				.all(|(&ch, byte)| u8::try_from(ch).is_ok_and(|ch| ch.eq_ignore_ascii_case(byte))))
	})
}

#[cfg(target_os = "windows")]
pub(in super::super) fn screen_state(_: &DisplaySelector) -> ScreenState {
	use windows_sys::Win32::System::StationsAndDesktops::{
		CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
	};

	let session = session_state();
	let mut name = [0_u16; 256];
	let mut needed = 0;
	// SAFETY: no borrowed pointers; the returned desktop is closed below.
	let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
	let desktop_name = if desktop.is_null() {
		None
	} else {
		// SAFETY: the desktop is open and name is writable for the supplied size.
		let read = unsafe {
			GetUserObjectInformationW(
				desktop,
				UOI_NAME,
				name.as_mut_ptr().cast(),
				size_of_val(&name) as u32,
				&mut needed,
			)
		};
		// SAFETY: this function owns the open desktop and no longer uses it.
		unsafe { CloseDesktop(desktop) };
		if read == 0 {
			None
		} else {
			name.iter().position(|ch| *ch == 0).map(|end| &name[..end])
		}
	};
	ScreenState { locked: screen_locked(session, desktop_name), display_asleep: false }
}

#[cfg(target_os = "windows")]
fn session_state() -> Option<SessionState> {
	use windows_sys::Win32::System::RemoteDesktop::{
		WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK, WTSActive,
		WTSConnectState, WTSFreeMemory, WTSINFOEXW, WTSQuerySessionInformationW, WTSSessionInfoEx,
	};

	let mut buffer = std::ptr::null_mut();
	let mut bytes = 0;
	// SAFETY: both output pointers are valid; WTS owns the returned allocation.
	let queried = unsafe {
		WTSQuerySessionInformationW(
			WTS_CURRENT_SERVER_HANDLE,
			WTS_CURRENT_SESSION,
			WTSSessionInfoEx,
			&mut buffer,
			&mut bytes,
		)
	};
	if queried != 0 {
		let result = if bytes as usize >= size_of::<WTSINFOEXW>() && !buffer.is_null() {
			// SAFETY: the successful query returned enough bytes for WTSINFOEXW.
			let info = unsafe { &*buffer.cast::<WTSINFOEXW>() };
			(info.Level == 1).then(|| {
				// SAFETY: Level selects the level-one member of the union.
				let state = unsafe { info.Data.WTSInfoExLevel1 };
				SessionState {
					active: state.SessionState == WTSActive,
					locked: state.SessionFlags == WTS_SESSIONSTATE_LOCK as i32,
				}
			})
		} else {
			None
		};
		// SAFETY: buffer came from the successful WTS query and is no longer
		// read.
		unsafe { WTSFreeMemory(buffer.cast()) };
		if result.is_some() {
			return result;
		}
	}
	// A failed extended query can still leave the connection state available.
	// SAFETY: both output pointers are valid; WTS owns the returned allocation.
	let queried = unsafe {
		WTSQuerySessionInformationW(
			WTS_CURRENT_SERVER_HANDLE,
			WTS_CURRENT_SESSION,
			WTSConnectState,
			&mut buffer,
			&mut bytes,
		)
	};
	if queried == 0 {
		return None;
	}
	let result = if bytes as usize >= size_of::<i32>() && !buffer.is_null() {
		// SAFETY: the successful query returned enough bytes for the state.
		let active = unsafe { *buffer.cast::<i32>() } == WTSActive;
		Some(SessionState { active, locked: false })
	} else {
		None
	};
	// SAFETY: buffer came from the successful WTS query and is no longer read.
	unsafe { WTSFreeMemory(buffer.cast()) };
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn windows_screen_locked_verdict() {
		let default: Vec<_> = "Default".encode_utf16().collect();
		let secure: Vec<_> = "Winlogon".encode_utf16().collect();
		let active = Some(SessionState { active: true, locked: false });
		assert!(!screen_locked(active, Some(&default)));
		assert!(!screen_locked(None, Some(&default)));
		assert!(screen_locked(Some(SessionState { active: false, locked: false }), Some(&default)));
		assert!(screen_locked(Some(SessionState { active: true, locked: true }), Some(&default)));
		assert!(screen_locked(active, Some(&secure)));
		assert!(screen_locked(active, None));
	}
}
