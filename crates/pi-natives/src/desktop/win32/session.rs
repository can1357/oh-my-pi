#[derive(Clone, Copy)]
struct SessionState {
	active: bool,
	locked: bool,
}

fn screen_locked(session: Option<SessionState>, desktop_name: Option<&[u16]>) -> bool {
	if session.is_some_and(|state| !state.active || state.locked) {
		return true;
	}
	desktop_name.is_none_or(|name| {
		!name.iter().copied().map(|ch| {
			if (65..=90).contains(&ch) { ch + 32 } else { ch }
		}).eq("default".encode_utf16())
	})
}

#[cfg(target_os = "windows")]
pub(super) fn screen_state(_: &super::super::types::DisplaySelector) -> super::super::types::ScreenState {
	use windows_sys::Win32::System::StationsAndDesktops::{
		CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
	};

	let session = session_state();
	let mut name = [0_u16; 256];
	let mut needed = 0;
	// Request only the access needed to read the input desktop's name.
	let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
	let desktop_name = if desktop.is_null() {
		None
	} else {
		let read = unsafe {
			GetUserObjectInformationW(desktop, UOI_NAME, name.as_mut_ptr().cast(), size_of_val(&name) as u32, &mut needed)
		};
		unsafe { CloseDesktop(desktop) };
		if read == 0 {
			None
		} else {
			name.iter().position(|ch| *ch == 0).map(|end| &name[..end])
		}
	};
	super::super::types::ScreenState {
		locked: screen_locked(session, desktop_name),
		display_asleep: false,
	}
}

#[cfg(target_os = "windows")]
fn session_state() -> Option<SessionState> {
	use windows_sys::Win32::System::RemoteDesktop::{
		WTSActive, WTSConnectState, WTSFreeMemory, WTSINFOEXW, WTSQuerySessionInformationW,
		WTSSessionInfoEx, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
	};

	let mut buffer = std::ptr::null_mut();
	let mut bytes = 0;
	let queried = unsafe {
		WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buffer, &mut bytes)
	};
	if queried != 0 {
		let result = if bytes as usize >= size_of::<WTSINFOEXW>() && !buffer.is_null() {
			let info = unsafe { &*buffer.cast::<WTSINFOEXW>() };
			(info.Level == 1).then(|| {
				let state = unsafe { info.Data.WTSInfoExLevel1 };
				SessionState { active: state.SessionState == WTSActive, locked: state.SessionFlags == WTS_SESSIONSTATE_LOCK as i32 }
			})
		} else {
			None
		};
		unsafe { WTSFreeMemory(buffer.cast()) };
		if result.is_some() {
			return result;
		}
	}
	// A failed extended query can still leave the connection state available.
	let queried = unsafe {
		WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSConnectState, &mut buffer, &mut bytes)
	};
	if queried == 0 {
		return None;
	}
	let result = if bytes as usize >= size_of::<i32>() && !buffer.is_null() {
		Some(SessionState { active: unsafe { *buffer.cast::<i32>() } == WTSActive, locked: false })
	} else {
		None
	};
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
