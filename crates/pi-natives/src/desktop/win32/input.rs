use std::time::Duration;

use enigo::{Axis, Button, Direction, Enigo, Keyboard, Mouse, Settings};

use super::{
	super::{
		backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
		error::{CoreResult, DesktopError},
		keys::KeyName,
		types::Target,
	},
	ax::Win32Ax,
	window,
};

pub(super) fn create_global_input() -> CoreResult<Enigo> {
	use windows_sys::Win32::UI::HiDpi::{
		DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE, SetThreadDpiAwarenessContext,
	};

	let _ = enigo::set_dpi_awareness();
	// SAFETY: the constant is a valid DPI context. Backend initialization runs
	// on the dedicated desktop worker, whose Win32 queries must stay physical
	// even when the embedding process has already fixed a different DPI mode.
	if unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE) }.is_null() {
		return Err(DesktopError::input_failed("cannot enable physical desktop coordinates on the input worker"));
	}
	Enigo::new(&Settings { open_prompt_to_get_permissions: false, ..Settings::default() }).map_err(
		|error| DesktopError::input_failed(format!("Win32 input initialization failed: {error}")),
	)
}

fn enigo_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("Win32 global input failed: {error}"))
}

/// Retains cleanup failures even when delivery itself already failed.
fn completed(result: CoreResult<()>, cleanup: CoreResult<()>) -> CoreResult<()> {
	match (result, cleanup) {
		(Err(mut error), Err(cleanup)) => {
			error.message.push_str("; cleanup also failed: ");
			error.message.push_str(&cleanup.message);
			Err(error)
		},
		(Err(error), _) | (_, Err(error)) => Err(error),
		(Ok(()), Ok(())) => Ok(()),
	}
}

const fn button_to_enigo(button: MouseButton) -> Button {
	match button {
		MouseButton::Left => Button::Left,
		MouseButton::Right => Button::Right,
		MouseButton::Middle => Button::Middle,
	}
}

fn modifier_keys(modifiers: Modifiers) -> impl Iterator<Item = KeyName> {
	[
		modifiers.ctrl.then_some(KeyName::Ctrl),
		modifiers.alt.then_some(KeyName::Alt),
		modifiers.shift.then_some(KeyName::Shift),
		modifiers.meta.then_some(KeyName::Meta),
	]
	.into_iter()
	.flatten()
}

fn with_global_modifiers(
	input: &mut Enigo,
	modifiers: Modifiers,
	operation: impl FnOnce(&mut Enigo) -> CoreResult<()>,
) -> CoreResult<()> {
	let keys = modifier_keys(modifiers).collect::<Vec<_>>();
	let mut held: Vec<KeyName> = Vec::with_capacity(keys.len());
	for key in keys {
		if let Err(error) = input.key(key.to_enigo(), Direction::Press) {
			for held_key in held.into_iter().rev() {
				let _ = input.key(held_key.to_enigo(), Direction::Release);
			}
			return Err(enigo_error(error));
		}
		held.push(key);
	}
	let operation_result = operation(input);
	let mut release_result = Ok(());
	for key in held.into_iter().rev() {
		if let Err(error) = input.key(key.to_enigo(), Direction::Release)
			&& release_result.is_ok()
		{
			release_result = Err(enigo_error(error));
		}
	}
	operation_result.and(release_result)
}

fn scroll_steps(delta: f64) -> i32 {
	if delta.abs() < f64::EPSILON {
		0
	} else {
		let magnitude = ((delta.abs() + 50.0) / 100.0).floor().max(1.0);
		delta.signum() as i32 * magnitude.min(f64::from(i32::MAX)) as i32
	}
}

fn global_pointer(input: &mut Enigo, event: PointerEvent) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			with_global_modifiers(input, modifiers, |input| {
				foreground::move_pointer(x, y)?;
				for _ in 0..count {
					input
						.button(button_to_enigo(button), Direction::Click)
						.map_err(enigo_error)?;
				}
				Ok(())
			})
		},
		PointerEvent::Move { x, y } => foreground::move_pointer(x, y),
		PointerEvent::Drag { path, button, modifiers } => {
			let Some(&(start_x, start_y)) = path.first() else {
				return Err(DesktopError::input_failed("drag path is empty"));
			};
			with_global_modifiers(input, modifiers, |input| {
				foreground::move_pointer(start_x, start_y)?;
				input
					.button(button_to_enigo(button), Direction::Press)
					.map_err(enigo_error)?;
				let movement = path.iter().skip(1).try_for_each(|&(x, y)| foreground::move_pointer(x, y));
				let release = input
					.button(button_to_enigo(button), Direction::Release)
					.map_err(enigo_error);
				movement.and(release)
			})
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			foreground::move_pointer(x, y)?;
			let horizontal = scroll_steps(dx);
			let vertical = scroll_steps(dy);
			if horizontal != 0 {
				input
					.scroll(horizontal, Axis::Horizontal)
					.map_err(enigo_error)?;
			}
			if vertical != 0 {
				input
					.scroll(vertical, Axis::Vertical)
					.map_err(enigo_error)?;
			}
			Ok(())
		},
	}
}

fn global_key_chord(input: &mut Enigo, keys: &[KeyName]) -> CoreResult<()> {
	if keys.len() == 1 {
		return input
			.key(keys[0].to_enigo(), Direction::Click)
			.map_err(enigo_error);
	}
	let mut held: Vec<KeyName> = Vec::with_capacity(keys.len());
	for &key in keys {
		if let Err(error) = input.key(key.to_enigo(), Direction::Press) {
			for held_key in held.into_iter().rev() {
				let _ = input.key(held_key.to_enigo(), Direction::Release);
			}
			return Err(enigo_error(error));
		}
		held.push(key);
	}
	let mut result = Ok(());
	for key in held.into_iter().rev() {
		if let Err(error) = input.key(key.to_enigo(), Direction::Release)
			&& result.is_ok()
		{
			result = Err(enigo_error(error));
		}
	}
	result
}

mod background {
	use std::{ffi::c_void, thread, time::Duration};

	use windows_sys::Win32::{
		Foundation::{ERROR_ACCESS_DENIED, GetLastError, HWND, LPARAM, POINT, WPARAM},
		UI::{
			Input::KeyboardAndMouse::{
				IsWindowEnabled, MAPVK_VK_TO_VSC, MapVirtualKeyW, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DELETE, VK_DOWN,
				VK_END, VK_ESCAPE, VK_F1, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9,
				VK_F10, VK_F11, VK_F12, VK_F13, VK_F14, VK_F15, VK_F16, VK_F17, VK_F18, VK_F19, VK_F20,
				VK_F21, VK_F22, VK_F23, VK_F24, VK_HOME, VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT,
				VK_NUMLOCK, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SNAPSHOT, VK_SPACE, VK_TAB,
				VK_UP, VkKeyScanW,
			},
			WindowsAndMessaging::{
				CS_DBLCLKS, GCL_STYLE, GetClassLongW, IsWindow, PostMessageW, SMTO_ABORTIFHUNG,
				SendMessageTimeoutW, WM_CHAR, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
				WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
				WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCHITTEST, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN,
				WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
			},
		},
	};

	use super::{CoreResult, DesktopError, KeyName, Modifiers, MouseButton, PointerEvent};
	use crate::desktop::win32::{
		ax::Win32Ax,
		delivery::{
			EventKind, TargetTraits, TextUnit, is_chromium_class, non_client_drag_region,
			posts_double_click, text_input_unsupported, text_units, would_be_silently_dropped,
		},
		window,
	};

	const MK_LBUTTON: usize = 0x0001;
	const MK_RBUTTON: usize = 0x0002;
	const MK_SHIFT: usize = 0x0004;
	const MK_CONTROL: usize = 0x0008;
	const MK_MBUTTON: usize = 0x0010;
	const WHEEL_DELTA: i32 = 120;

	/// Time between a posted button press and its release.
	const CLICK_HOLD: Duration = Duration::from_millis(35);
	/// Time between the clicks of a posted multi-click.
	const CLICK_GAP: Duration = Duration::from_millis(80);
	/// Time between posted drag moves.
	const DRAG_STEP: Duration = Duration::from_millis(16);
	/// Time between posted key transitions and typed characters.
	const KEY_GAP: Duration = Duration::from_millis(4);
	/// Extra time after a posted Return while rich editors build a paragraph.
	const ENTER_SETTLE: Duration = Duration::from_millis(20);

	pub(super) fn hwnd(id: &str) -> CoreResult<HWND> {
		let address = id
			.parse::<usize>()
			.map_err(|_| DesktopError::invalid_target(format!("invalid Win32 window id '{id}'")))?;
		let hwnd = std::ptr::with_exposed_provenance_mut::<c_void>(address);
		// SAFETY: IsWindow validates the opaque value before it is used.
		if unsafe { IsWindow(hwnd) } == 0 {
			return Err(DesktopError::window_not_found(format!(
				"target window '{id}' is no longer present"
			)));
		}
		Ok(hwnd)
	}

	/// Refuses higher-integrity targets and unreadable privilege state before
	/// relying on a Win32 enqueue result.
	pub(super) fn ensure_integrity(id: &str, root: HWND) -> CoreResult<()> {
		// SAFETY: IsWindowEnabled validates the target handle.
		if unsafe { IsWindowEnabled(root) } == 0 {
			return Err(DesktopError::input_failed(format!(
				"window {id} is disabled; target its active dialog instead"
			)));
		}
		window::uipi_block(root).map_or(Ok(()), |reason| {
			Err(DesktopError::permission_denied(format!(
				"window {id} cannot receive synthetic input: {reason}"
			)))
		})
	}

	fn drop_reason(root: HWND, class: &str, kind: EventKind) -> Option<&'static str> {
		would_be_silently_dropped(
			TargetTraits {
				class,
				chromium_descendant: window::has_chromium_descendant(root),
				foreground: window::owns_foreground(root),
				xaml_host: window::is_xaml_host(root),
			},
			kind,
		)
	}

	/// Refuses typed text that no delivery mode can land on `root`.
	pub(super) fn ensure_text_supported(id: &str, root: HWND) -> CoreResult<()> {
		let class = window::class_name(root);
		text_input_unsupported(&class, cfg!(target_arch = "aarch64")).map_or(Ok(()), |reason| {
			Err(DesktopError::input_failed(format!(
				"window {id} ({class}) cannot take typed text: {reason}"
			)))
		})
	}

	fn refusal(id: &str, class: &str, kind: EventKind, reason: &str) -> DesktopError {
		DesktopError::background_unavailable(format!(
			"window {id} ({class}) drops background {} events: {reason}; retry with takeover:true or \
			 use ax actions",
			kind.name()
		))
	}

	fn ensure_delivery(id: &str, root: HWND, kind: EventKind) -> CoreResult<()> {
		ensure_integrity(id, root)?;
		let class = window::class_name(root);
		drop_reason(root, &class, kind)
			.map_or(Ok(()), |reason| Err(refusal(id, &class, kind, reason)))
	}

	fn post(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> CoreResult<()> {
		// SAFETY: Win32 copies these scalar message parameters into the validated
		// target's queue and retains no borrowed memory.
		if unsafe { PostMessageW(hwnd, message, wparam, lparam) } != 0 {
			Ok(())
		} else {
			// SAFETY: GetLastError has no preconditions and is read immediately.
			let error = unsafe { GetLastError() };
			let message = format!("PostMessageW failed with Win32 error {error}");
			Err(if error == ERROR_ACCESS_DENIED {
				DesktopError::permission_denied(message)
			} else {
				DesktopError::input_failed(message)
			})
		}
	}

	fn packed_point(x: i32, y: i32) -> CoreResult<LPARAM> {
		let x = i16::try_from(x)
			.map_err(|_| DesktopError::input_failed(format!("window x coordinate {x} exceeds i16")))?;
		let y = i16::try_from(y)
			.map_err(|_| DesktopError::input_failed(format!("window y coordinate {y} exceeds i16")))?;
		let bits = u32::from(u16::from_ne_bytes(x.to_ne_bytes()))
			| (u32::from(u16::from_ne_bytes(y.to_ne_bytes())) << 16);
		Ok(i32::from_ne_bytes(bits.to_ne_bytes()) as isize)
	}

	/// Window, display and AX coordinates all use physical desktop pixels.
	fn screen_point(x: f64, y: f64) -> POINT {
		POINT { x: x.round() as i32, y: y.round() as i32 }
	}

	/// Deepest child of `root` under a physical screen point, with the point in
	/// that child's client coordinates.
	fn child_under(root: HWND, point: POINT) -> CoreResult<(HWND, POINT)> {
		window::deepest_child(root, point)
			.ok_or_else(|| DesktopError::background_unavailable(
				"cannot map this point into an enabled target client area; use ax actions or takeover:true",
			))
	}

	/// Deepest child of `root` under a physical desktop coordinate, with the
	/// packed client-coordinate `LPARAM` for that child.
	fn child_at(root: HWND, x: f64, y: f64) -> CoreResult<(HWND, LPARAM)> {
		let (child, client) = child_under(root, screen_point(x, y))?;
		Ok((child, packed_point(client.x, client.y)?))
	}

	fn client_point(hwnd: HWND, x: f64, y: f64) -> CoreResult<LPARAM> {
		let point = window::client_point(hwnd, screen_point(x, y)).ok_or_else(|| {
			DesktopError::input_failed("cannot map physical coordinates to the target window's DPI")
		})?;
		packed_point(point.x, point.y)
	}

	/// `WM_NCHITTEST` code of `root` at a physical screen point, or `None` when
	/// the window does not answer within 200 ms.
	fn hit_test(root: HWND, point: POINT) -> Option<isize> {
		let point = window::logical_screen_point(root, point)?;
		let location = packed_point(point.x, point.y).ok()?;
		let mut hit = 0;
		// SAFETY: scalar message parameters and a writable result; the timeout
		// and SMTO_ABORTIFHUNG bound the wait on an unresponsive window.
		let answered = unsafe {
			SendMessageTimeoutW(root, WM_NCHITTEST, 0, location, SMTO_ABORTIFHUNG, 200, &mut hit)
		} != 0;
		answered.then_some(hit as isize)
	}

	const fn mouse_flags(modifiers: Modifiers) -> usize {
		(if modifiers.ctrl { MK_CONTROL } else { 0 }) | (if modifiers.shift { MK_SHIFT } else { 0 })
	}

	const fn mouse_messages(button: MouseButton) -> (u32, u32, u32, usize) {
		match button {
			MouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
			MouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
			MouseButton::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
		}
	}

	fn wheel_wparam(delta: i32) -> CoreResult<WPARAM> {
		let delta = i16::try_from(delta).map_err(|_| {
			DesktopError::input_failed(format!("scroll delta {delta} exceeds Win32 range"))
		})?;
		Ok(usize::from(u16::from_ne_bytes(delta.to_ne_bytes())) << 16)
	}

	/// Posts pointer input to the deepest child window under the point.
	///
	/// Toolkits that drop posted clicks still get a single unmodified left
	/// click when UI Automation can invoke the control under the point, except
	/// Chromium, whose Invoke reports success without acting.
	pub(super) fn pointer(ax: &mut Win32Ax, id: &str, event: PointerEvent) -> CoreResult<()> {
		let root = hwnd(id)?;
		ensure_integrity(id, root)?;
		let kind = match event {
			PointerEvent::Click { .. } => EventKind::MouseClick,
			PointerEvent::Move { .. } | PointerEvent::Drag { .. } => EventKind::MouseMove,
			PointerEvent::Scroll { .. } => EventKind::MouseScroll,
		};
		let class = window::class_name(root);
		if let Some(reason) = drop_reason(root, &class, kind) {
			if let PointerEvent::Click { x, y, button: MouseButton::Left, count: 1, modifiers } = event
				&& modifiers == Modifiers::default()
				&& !is_chromium_class(&class)
				&& ax.invoke_at_point(root, screen_point(x, y))?
			{
				return Ok(());
			}
			return Err(refusal(id, &class, kind, reason));
		}
		match event {
			PointerEvent::Click { x, y, button, count, modifiers } => {
				let (target, point) = child_at(root, x, y)?;
				ensure_delivery(id, target, kind)?;
				let (down, up, double, button_flag) = mouse_messages(button);
				let flags = mouse_flags(modifiers);
				// SAFETY: GetClassLongW reads the class style of a live window.
				let wants_double = unsafe { GetClassLongW(target, GCL_STYLE) } & CS_DBLCLKS != 0;
				with_modifiers(target, modifiers, || {
					for index in 0..count {
						if index > 0 {
							thread::sleep(CLICK_GAP);
						}
						let press = if posts_double_click(index, wants_double) { double } else { down };
						post(target, WM_MOUSEMOVE, flags, point)?;
						post(target, press, flags | button_flag, point)?;
						thread::sleep(CLICK_HOLD);
						post(target, up, flags, point)?;
					}
					Ok(())
				})
			},
			PointerEvent::Move { x, y } => {
				let (target, point) = child_at(root, x, y)?;
				ensure_delivery(id, target, kind)?;
				post(target, WM_MOUSEMOVE, 0, point)
			},
			PointerEvent::Drag { path, button, modifiers } => {
				let Some(&(x, y)) = path.first() else {
					return Err(DesktopError::input_failed("drag path is empty"));
				};
				let start = screen_point(x, y);
				let hit = hit_test(root, start).ok_or_else(|| {
					DesktopError::background_unavailable(
						"cannot establish the drag start region; use ax actions or takeover:true",
					)
				})?;
				if let Some(region) = non_client_drag_region(hit) {
					return Err(DesktopError::background_unavailable(format!(
						"window {id} drag starts on its {region}, where only real pointer input drives \
						 the system move/size loop; retry with takeover:true or use ax actions"
					)));
				}
				let (target, client) = child_under(root, start)?;
				ensure_delivery(id, target, kind)?;
				let start = packed_point(client.x, client.y)?;
				let (down, up, _, button_flag) = mouse_messages(button);
				let flags = mouse_flags(modifiers);
				with_modifiers(target, modifiers, || {
					post(target, WM_MOUSEMOVE, flags, start)?;
					post(target, down, flags | button_flag, start)?;
					thread::sleep(CLICK_HOLD);
					let mut end = start;
					let movement = path.iter().skip(1).try_for_each(|&(x, y)| {
						let next = client_point(target, x, y)?;
						post(target, WM_MOUSEMOVE, flags | button_flag, next)?;
						end = next;
						thread::sleep(DRAG_STEP);
						Ok(())
					});
					let release = post(target, up, flags, end);
					super::completed(movement, release)
				})
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				let point = screen_point(x, y);
				// Wheel messages carry screen coordinates; unhandled wheel input
				// bubbles from the child up its parent chain.
				let (target, _) = child_under(root, point)?;
				ensure_delivery(id, target, kind)?;
				let point = window::logical_screen_point(target, point).ok_or_else(|| {
					DesktopError::input_failed("cannot map wheel coordinates to the target's DPI")
				})?;
				let location = packed_point(point.x, point.y)?;
				let horizontal = super::scroll_steps(dx).saturating_mul(WHEEL_DELTA);
				let vertical = super::scroll_steps(dy).saturating_mul(-WHEEL_DELTA);
				if horizontal != 0 {
					post(target, WM_MOUSEHWHEEL, wheel_wparam(horizontal)?, location)?;
				}
				if vertical != 0 {
					post(target, WM_MOUSEWHEEL, wheel_wparam(vertical)?, location)?;
				}
				Ok(())
			},
		}
	}

	pub(super) fn virtual_key(key: KeyName) -> CoreResult<(u16, u8)> {
		let value = match key {
			KeyName::Ctrl => (VK_CONTROL, 0),
			KeyName::Alt => (VK_MENU, 0),
			KeyName::Shift => (VK_SHIFT, 0),
			KeyName::Meta => (VK_LWIN, 0),
			KeyName::Enter => (VK_RETURN, 0),
			KeyName::Escape => (VK_ESCAPE, 0),
			KeyName::Tab => (VK_TAB, 0),
			KeyName::Space => (VK_SPACE, 0),
			KeyName::Backspace => (VK_BACK, 0),
			KeyName::Delete => (VK_DELETE, 0),
			KeyName::Insert => (VK_INSERT, 0),
			KeyName::Home => (VK_HOME, 0),
			KeyName::End => (VK_END, 0),
			KeyName::PageUp => (VK_PRIOR, 0),
			KeyName::PageDown => (VK_NEXT, 0),
			KeyName::Up => (VK_UP, 0),
			KeyName::Down => (VK_DOWN, 0),
			KeyName::Left => (VK_LEFT, 0),
			KeyName::Right => (VK_RIGHT, 0),
			KeyName::CapsLock => (VK_CAPITAL, 0),
			KeyName::NumLock => (VK_NUMLOCK, 0),
			KeyName::PrintScreen => (VK_SNAPSHOT, 0),
			KeyName::F1 => (VK_F1, 0),
			KeyName::F2 => (VK_F2, 0),
			KeyName::F3 => (VK_F3, 0),
			KeyName::F4 => (VK_F4, 0),
			KeyName::F5 => (VK_F5, 0),
			KeyName::F6 => (VK_F6, 0),
			KeyName::F7 => (VK_F7, 0),
			KeyName::F8 => (VK_F8, 0),
			KeyName::F9 => (VK_F9, 0),
			KeyName::F10 => (VK_F10, 0),
			KeyName::F11 => (VK_F11, 0),
			KeyName::F12 => (VK_F12, 0),
			KeyName::F13 => (VK_F13, 0),
			KeyName::F14 => (VK_F14, 0),
			KeyName::F15 => (VK_F15, 0),
			KeyName::F16 => (VK_F16, 0),
			KeyName::F17 => (VK_F17, 0),
			KeyName::F18 => (VK_F18, 0),
			KeyName::F19 => (VK_F19, 0),
			KeyName::F20 => (VK_F20, 0),
			KeyName::F21 => (VK_F21, 0),
			KeyName::F22 => (VK_F22, 0),
			KeyName::F23 => (VK_F23, 0),
			KeyName::F24 => (VK_F24, 0),
			KeyName::Char(character) => {
				let mut units = [0; 2];
				let encoded = character.encode_utf16(&mut units);
				if encoded.len() != 1 {
					return Err(DesktopError::input_failed(format!(
						"{character:?} has no Win32 virtual key"
					)));
				}
				// SAFETY: VkKeyScanW performs a scalar lookup in the active layout.
				let mapped = unsafe { VkKeyScanW(units[0]) };
				if mapped == -1 {
					return Err(DesktopError::input_failed(format!(
						"{character:?} is absent from the active keyboard layout"
					)));
				}
				let bytes = mapped.to_ne_bytes();
				(u16::from(bytes[0]), bytes[1])
			},
		};
		Ok(value)
	}

	/// Keys whose hardware scan code carries the `E0` extended prefix.
	pub(super) const fn is_extended(vk: u16) -> bool {
		matches!(
			vk,
			VK_INSERT
				| VK_DELETE
				| VK_HOME
				| VK_END | VK_PRIOR
				| VK_NEXT
				| VK_LEFT
				| VK_RIGHT
				| VK_UP | VK_DOWN
				| VK_LWIN
				| VK_NUMLOCK
				| VK_SNAPSHOT
		)
	}

	struct KeyEmitter {
		hwnd:      HWND,
		alt_depth: u8,
	}
	impl KeyEmitter {
		/// Only an established focus target may receive posted text/keys.
		/// Falling back to the frame would report success for dropped input.
		fn focused(root: HWND) -> CoreResult<Self> {
			let hwnd = window::focused_descendant(root).ok_or_else(|| {
				DesktopError::background_unavailable(
					"no unambiguous focused control in the target window; use ax actions or takeover:true",
				)
			})?;
			Ok(Self { hwnd, alt_depth: 0 })
		}

		fn transition(&mut self, vk: u16, down: bool) -> CoreResult<()> {
			// SAFETY: MapVirtualKeyW is a pure scalar lookup.
			let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } & 0xff;
			let mut bits = 1u32 | (scan << 16);
			if is_extended(vk) {
				bits |= 1 << 24;
			}
			if self.alt_depth > 0 || vk == VK_MENU {
				bits |= 1 << 29;
			}
			if !down {
				bits |= (1 << 30) | (1 << 31);
			}
			let system = self.alt_depth > 0 || vk == VK_MENU;
			post(
				self.hwnd,
				if down {
					if system { WM_SYSKEYDOWN } else { WM_KEYDOWN }
				} else if system {
					WM_SYSKEYUP
				} else {
					WM_KEYUP
				},
				usize::from(vk),
				i32::from_ne_bytes(bits.to_ne_bytes()) as isize,
			)?;
			if vk == VK_MENU {
				self.alt_depth = if down {
					self.alt_depth.saturating_add(1)
				} else {
					self.alt_depth.saturating_sub(1)
				};
			}
			Ok(())
		}

		fn key(&mut self, key: KeyName, down: bool) -> CoreResult<()> {
			let (vk, implicit) = virtual_key(key)?;
			let modifiers = [
				(implicit & 1 != 0).then_some(VK_SHIFT),
				(implicit & 2 != 0).then_some(VK_CONTROL),
				(implicit & 4 != 0).then_some(VK_MENU),
			];
			if down {
				for (index, modifier) in modifiers.iter().enumerate() {
					if let Some(modifier) = modifier
						&& let Err(error) = self.transition(*modifier, true)
					{
						let mut cleanup = Ok(());
						for &held in modifiers[..index].iter().flatten().rev() {
							cleanup = super::completed(cleanup, self.transition(held, false));
						}
						return super::completed(Err(error), cleanup);
					}
				}
			}
			let result = self.transition(vk, down);
			if !down || result.is_err() {
				let mut cleanup = Ok(());
				for modifier in modifiers.into_iter().flatten().rev() {
					cleanup = super::completed(cleanup, self.transition(modifier, false));
				}
				return super::completed(result, cleanup);
			}
			result
		}
	}

	fn with_modifiers(
		hwnd: HWND,
		modifiers: Modifiers,
		operation: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		let mut emitter = KeyEmitter { hwnd, alt_depth: 0 };
		let mut held = Vec::with_capacity(4);
		for key in super::modifier_keys(modifiers) {
			if let Err(error) = emitter.key(key, true) {
				let mut cleanup = Ok(());
				for held_key in held.into_iter().rev() {
					cleanup = super::completed(cleanup, emitter.key(held_key, false));
				}
				return super::completed(Err(error), cleanup);
			}
			held.push(key);
		}
		let operation_result = operation();
		let mut release_result = Ok(());
		for key in held.into_iter().rev() {
			release_result = super::completed(release_result, emitter.key(key, false));
		}
		super::completed(operation_result, release_result)
	}

	pub(super) fn key_chord(id: &str, keys: &[KeyName]) -> CoreResult<()> {
		let root = hwnd(id)?;
		let kind = if keys.len() > 1 || keys.iter().any(|key| key.is_modifier()) {
			EventKind::KeyCombo
		} else {
			EventKind::Keystroke
		};
		ensure_delivery(id, root, kind)?;
		let mut emitter = KeyEmitter::focused(root)?;
		ensure_delivery(id, emitter.hwnd, kind)?;
		let mut held = Vec::with_capacity(keys.len());
		for &key in keys {
			if let Err(error) = emitter.key(key, true) {
				let mut cleanup = Ok(());
				for held_key in held.into_iter().rev() {
					cleanup = super::completed(cleanup, emitter.key(held_key, false));
				}
				return super::completed(Err(error), cleanup);
			}
			held.push(key);
		}
		thread::sleep(KEY_GAP);
		let mut result = Ok(());
		for key in held.into_iter().rev() {
			result = super::completed(result, emitter.key(key, false));
		}
		result
	}

	pub(super) fn type_text(id: &str, text: &str) -> CoreResult<()> {
		let root = hwnd(id)?;
		ensure_text_supported(id, root)?;
		ensure_delivery(id, root, EventKind::TextInput)?;
		let mut emitter = KeyEmitter::focused(root)?;
		ensure_delivery(id, emitter.hwnd, EventKind::TextInput)?;
		for unit in text_units(text) {
			match unit {
				TextUnit::Enter => {
					emitter.transition(VK_RETURN, true)?;
					thread::sleep(KEY_GAP);
					emitter.transition(VK_RETURN, false)?;
					thread::sleep(KEY_GAP + ENTER_SETTLE);
				},
				TextUnit::Char(character) => {
					let mut units = [0; 2];
					for &unit in character.encode_utf16(&mut units).iter() {
						post(emitter.hwnd, WM_CHAR, usize::from(unit), 1)?;
					}
					thread::sleep(KEY_GAP);
				},
			}
		}
		Ok(())
	}
}

mod foreground {
	use std::{mem::size_of, thread, time::Duration};

	use windows_sys::Win32::{
		Foundation::{HWND, POINT},
		UI::{
			Input::KeyboardAndMouse::{
				INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
				KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSEEVENTF_ABSOLUTE,
				MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
				MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
				MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW, SendInput,
				VK_RETURN,
			},
			WindowsAndMessaging::{
				GA_ROOTOWNER, GetAncestor, GetCursorPos, GetForegroundWindow, GetSystemMetrics,
				IsWindow, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
				SM_YVIRTUALSCREEN, SetCursorPos, WindowFromPoint,
			},
		},
	};

	use super::{
		CoreResult, DesktopError, KeyName, Modifiers, MouseButton, PointerEvent, background,
	};
	use crate::desktop::win32::{
		delivery::{TextUnit, text_units},
		window,
	};

	/// Time the target keeps the foreground after pointer input, so
	/// retained-mode toolkits finish press/capture handling before focus and
	/// cursor return.
	const POINTER_SETTLE: Duration = Duration::from_millis(120);
	/// Time the target keeps the foreground after keyboard input.
	const KEY_SETTLE: Duration = Duration::from_millis(40);
	/// Longest wait for Windows to confirm the target as foreground.
	const ACTIVATION_TIMEOUT: Duration = Duration::from_millis(500);
	/// Time between drag moves.
	const DRAG_STEP: Duration = Duration::from_millis(16);

	/// Activates the target for foreground input and hands the foreground back
	/// to the user's window once the target has consumed it.
	struct ForegroundGuard {
		previous: HWND,
		target:   HWND,
		settle:   Duration,
		armed:    bool,
	}

	impl ForegroundGuard {
		fn activate(id: &str, settle: Duration) -> CoreResult<Self> {
			let target = background::hwnd(id)?;
			background::ensure_integrity(id, target)?;
			// SAFETY: GetForegroundWindow has no preconditions.
			let previous = unsafe { GetForegroundWindow() };
			if previous.is_null() {
				return Err(DesktopError::input_failed(
					"cannot save the current foreground window; no input was sent",
				));
			}
			let mut guard = Self { previous, target, settle, armed: true };
			if previous != target {
				window::activate(target);
				if !window::wait_for_foreground(target, ACTIVATION_TIMEOUT) {
					let error = DesktopError::input_failed(format!(
						"Windows refused to activate the exact target window {id}; no input was sent"
					));
					return super::completed(Err(error), guard.restore()).map(|()| guard);
				}
				thread::sleep(Duration::from_millis(20));
			}
			Ok(guard)
		}

		fn run(mut self, operation: impl FnOnce(HWND) -> CoreResult<()>) -> CoreResult<()> {
			let result = operation(self.target);
			thread::sleep(self.settle);
			super::completed(result, self.restore())
		}

		fn restore(&mut self) -> CoreResult<()> {
			self.armed = false;
			// SAFETY: these functions validate scalar handles. Owned modal
			// windows qualify for restoration, never for input targeting.
			let current = unsafe { GetForegroundWindow() };
			if current == self.previous {
				return Ok(());
			}
			if current != self.target
				&& unsafe { GetAncestor(current, GA_ROOTOWNER) } != self.target
			{
				return Err(DesktopError::input_failed(
					"foreground changed during takeover; left the newly active window untouched",
				));
			}
			// SAFETY: IsWindow validates the previously observed handle.
			if unsafe { IsWindow(self.previous) } == 0 {
				return Err(DesktopError::input_failed("the previous foreground window no longer exists"));
			}
			window::activate(self.previous);
			if window::wait_for_foreground(self.previous, ACTIVATION_TIMEOUT) {
				Ok(())
			} else {
				Err(DesktopError::input_failed("Windows refused to restore the previous foreground window"))
			}
		}
	}

	impl Drop for ForegroundGuard {
		fn drop(&mut self) {
			if self.armed {
				// Unwinding fallback only; normal returns report restoration
				// failures through run/restore instead of hiding them in Drop.
				let _ = self.restore();
			}
		}
	}

	/// Returns the user's pointer to where it was once foreground pointer input,
	/// which must travel the real cursor, has been consumed.
	struct CursorGuard(Option<POINT>);

	impl CursorGuard {
		fn save() -> CoreResult<Self> {
			let mut point = POINT { x: 0, y: 0 };
			// SAFETY: `point` is writable for the call.
			if unsafe { GetCursorPos(&mut point) } == 0 {
				return Err(DesktopError::input_failed("cannot save the pointer position; no input was sent"));
			}
			Ok(Self(Some(point)))
		}

		fn restore(&mut self) -> CoreResult<()> {
			let Some(point) = self.0.take() else { return Ok(()) };
			// SAFETY: coordinates were returned by GetCursorPos.
			if unsafe { SetCursorPos(point.x, point.y) } == 0 {
				return Err(DesktopError::input_failed("Windows refused to restore the pointer position"));
			}
			Ok(())
		}
	}

	impl Drop for CursorGuard {
		fn drop(&mut self) {
			if let Some(point) = self.0 {
				// SAFETY: scalar coordinates previously reported by GetCursorPos.
				unsafe { SetCursorPos(point.x, point.y) };
			}
		}
	}

	/// Every delivery batch rechecks the exact HWND so user focus changes or
	/// newly opened sibling/modal windows never become silent input targets.
	fn send_to(target: HWND, events: &[INPUT]) -> CoreResult<()> {
		// SAFETY: GetForegroundWindow has no preconditions.
		if unsafe { GetForegroundWindow() } != target {
			return Err(DesktopError::input_failed(
				"the exact target lost foreground; stopped sending takeover input",
			));
		}
		send(events)
	}

	fn send(events: &[INPUT]) -> CoreResult<()> {
		if events.is_empty() {
			return Ok(());
		}
		// SAFETY: `events` is an initialized INPUT slice copied synchronously by
		// Win32.
		let sent =
			unsafe { SendInput(events.len() as u32, events.as_ptr(), size_of::<INPUT>() as i32) };
		if sent as usize == events.len() {
			Ok(())
		} else {
			// Only release transitions actually inserted by this call. Never
			// release uninserted modifiers or replay clicks/text after a short send.
			let releases = pending_releases(&events[..(sent as usize).min(events.len())]);
			let mut cleanup = Ok(());
			for release in releases.iter().rev() {
				// SAFETY: release is one initialized INPUT copied synchronously.
				if unsafe { SendInput(1, release, size_of::<INPUT>() as i32) } != 1 {
					cleanup = Err(DesktopError::input_failed("SendInput could not release inserted input"));
				}
			}
			super::completed(
				Err(DesktopError::input_failed(format!(
					"Win32 SendInput inserted {sent} of {} events; the action may be partially applied",
					events.len()
				))),
				cleanup,
			)
		}
	}

	/// Reconstructs unmatched key/button downs from the accepted prefix.
	/// Allocation occurs only after a short SendInput, never on successful sends.
	fn pending_releases(events: &[INPUT]) -> Vec<INPUT> {
		let mut pending = Vec::new();
		for event in events {
			let Some((down, release)) = release_transition(event) else { continue };
			let previous = pending.iter().position(|held| same_release(held, &release));
			if down {
				if previous.is_none() {
					pending.push(release);
				}
			} else if let Some(index) = previous {
				pending.remove(index);
			}
		}
		pending
	}

	fn release_transition(event: &INPUT) -> Option<(bool, INPUT)> {
		// SAFETY: INPUT's type tag selects the initialized union member. All
		// packets come from this module's typed keyboard/mouse constructors.
		unsafe {
			match event.r#type {
				INPUT_KEYBOARD => {
					let key = event.Anonymous.ki;
					Some((
						key.dwFlags & KEYEVENTF_KEYUP == 0,
						keyboard_input(key.wVk, key.wScan, key.dwFlags | KEYEVENTF_KEYUP),
					))
				},
				INPUT_MOUSE => {
					let flags = event.Anonymous.mi.dwFlags;
					for (down, up) in [
						(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
						(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
						(MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
					] {
						if flags & (down | up) != 0 {
							return Some((flags & down != 0, mouse_event(up, 0)));
						}
					}
					None
				},
				_ => None,
			}
		}
	}

	fn same_release(left: &INPUT, right: &INPUT) -> bool {
		if left.r#type != right.r#type {
			return false;
		}
		// SAFETY: matching type tags select initialized members produced by
		// release_transition; only keyboard and mouse packets enter pending.
		unsafe {
			if left.r#type == INPUT_KEYBOARD {
				let a = left.Anonymous.ki;
				let b = right.Anonymous.ki;
				a.wVk == b.wVk && a.wScan == b.wScan && a.dwFlags == b.dwFlags
			} else {
				left.Anonymous.mi.dwFlags == right.Anonymous.mi.dwFlags
			}
		}
	}

	const fn mouse_event(flags: u32, data: u32) -> INPUT {
		INPUT {
			r#type:    INPUT_MOUSE,
			Anonymous: INPUT_0 {
				mi: MOUSEINPUT {
					dx:          0,
					dy:          0,
					mouseData:   data,
					dwFlags:     flags,
					time:        0,
					dwExtraInfo: 0,
				},
			},
		}
	}

	/// Desktop-root input intentionally moves the real cursor without restoring
	/// it. Enigo's Windows absolute move normalizes only to the primary display;
	/// use the same virtual-desktop packet as window takeover on every monitor.
	pub(super) fn move_pointer(x: f64, y: f64) -> CoreResult<()> {
		send(&[move_event(x, y)?])
	}

	/// Absolute move to a physical desktop coordinate across the virtual desktop.
	fn move_event(x: f64, y: f64) -> CoreResult<INPUT> {
		let (x, y) = (x.round() as i32, y.round() as i32);
		// SAFETY: GetSystemMetrics has no preconditions.
		let (origin_x, origin_y, width, height) = unsafe {
			(
				GetSystemMetrics(SM_XVIRTUALSCREEN),
				GetSystemMetrics(SM_YVIRTUALSCREEN),
				GetSystemMetrics(SM_CXVIRTUALSCREEN),
				GetSystemMetrics(SM_CYVIRTUALSCREEN),
			)
		};
		if width <= 1 || height <= 1 {
			return Err(DesktopError::input_failed("Win32 virtual desktop geometry is unavailable"));
		}
		let nx = (((i64::from(x) - i64::from(origin_x)) * 65_535) / i64::from(width - 1)).clamp(0, 65_535) as i32;
		let ny = (((i64::from(y) - i64::from(origin_y)) * 65_535) / i64::from(height - 1)).clamp(0, 65_535) as i32;
		let mut event =
			mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0);
		event.Anonymous.mi.dx = nx;
		event.Anonymous.mi.dy = ny;
		Ok(event)
	}

	const fn button_flags(button: MouseButton) -> (u32, u32) {
		match button {
			MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
			MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
			MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
		}
	}

	pub(super) fn pointer(id: &str, event: PointerEvent) -> CoreResult<()> {
		// Declared first so it drops last: the cursor returns after the
		// foreground has been handed back.
		let mut cursor = CursorGuard::save()?;
		let foreground = match ForegroundGuard::activate(id, POINTER_SETTLE) {
			Ok(foreground) => foreground,
			Err(error) => {
				// Activation sent no pointer input; do not overwrite movement
				// the user made while Windows decided the focus request.
				cursor.0 = None;
				return Err(error);
			},
		};
		let result = foreground.run(|target| pointer_active(target, event));
		super::completed(result, cursor.restore())
	}

	fn pointer_active(target: HWND, event: PointerEvent) -> CoreResult<()> {
		let (x, y) = match &event {
			PointerEvent::Click { x, y, .. }
			| PointerEvent::Move { x, y }
			| PointerEvent::Scroll { x, y, .. } => (*x, *y),
			PointerEvent::Drag { path, .. } => *path
				.first()
				.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?,
		};
		let (x, y) = (x.round() as i32, y.round() as i32);
		// SAFETY: WindowFromPoint takes a scalar physical screen point.
		if window::root(unsafe { WindowFromPoint(POINT { x, y }) }) != target {
			return Err(DesktopError::input_failed(
				"the pointer location is occluded or outside the exact target; no pointer input was sent",
			));
		}
		match event {
			PointerEvent::Click { x, y, button, count, modifiers } => {
				let at = move_event(x, y)?;
				let (down, up) = button_flags(button);
				with_modifiers(target, modifiers, || {
					(0..count).try_for_each(|_| send_to(target, &[at, mouse_event(down, 0), mouse_event(up, 0)]))
				})
			},
			PointerEvent::Move { x, y } => send_to(target, &[move_event(x, y)?]),
			PointerEvent::Drag { path, button, modifiers } => {
				let Some(&(x, y)) = path.first() else {
					return Err(DesktopError::input_failed("drag path is empty"));
				};
				let start = move_event(x, y)?;
				let (down, up) = button_flags(button);
				with_modifiers(target, modifiers, || {
					send_to(target, &[start, mouse_event(down, 0)])?;
					let movement = path.iter().skip(1).try_for_each(|&(x, y)| {
						thread::sleep(DRAG_STEP);
						send_to(target, &[move_event(x, y)?])
					});
					// Releases must still reach the system input state when
					// focus changed during a drag.
					let release = send(&[mouse_event(up, 0)]);
					super::completed(movement, release)
				})
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				// Windows routes the wheel to the window under the cursor.
				send_to(target, &[move_event(x, y)?])?;
				let horizontal = super::scroll_steps(dx).saturating_mul(120);
				let vertical = super::scroll_steps(dy).saturating_mul(-120);
				if horizontal != 0 {
					send_to(target, &[mouse_event(MOUSEEVENTF_HWHEEL, horizontal as u32)])?;
				}
				if vertical != 0 {
					send_to(target, &[mouse_event(MOUSEEVENTF_WHEEL, vertical as u32)])?;
				}
				Ok(())
			},
		}
	}

	const fn keyboard_input(vk: u16, scan: u16, flags: u32) -> INPUT {
		INPUT {
			r#type:    INPUT_KEYBOARD,
			Anonymous: INPUT_0 {
				ki: KEYBDINPUT {
					wVk:         vk,
					wScan:       scan,
					dwFlags:     flags,
					time:        0,
					dwExtraInfo: 0,
				},
			},
		}
	}

	/// Virtual-key transition carrying the hardware scan code and extended
	/// flag, for applications that read scan codes rather than virtual keys.
	fn key_event(vk: u16, up: bool) -> INPUT {
		// SAFETY: MapVirtualKeyW is a pure scalar lookup.
		let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
		let mut flags = if up { KEYEVENTF_KEYUP } else { 0 };
		if background::is_extended(vk) {
			flags |= KEYEVENTF_EXTENDEDKEY;
		}
		keyboard_input(vk, scan, flags)
	}

	const fn unicode_event(unit: u16, up: bool) -> INPUT {
		keyboard_input(
			0,
			unit,
			if up {
				KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
			} else {
				KEYEVENTF_UNICODE
			},
		)
	}

	/// Sends `presses`, runs `operation`, and releases the inserted transitions.
	/// A short press batch cleans up its accepted prefix inside send.
	fn holding(
		target: HWND,
		presses: &[INPUT],
		releases: &[INPUT],
		operation: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		// send cleans up only the accepted prefix if presses is short.
		send_to(target, presses)?;
		let result = operation();
		let mut released = Ok(());
		for release in releases {
			released = super::completed(released, send(std::slice::from_ref(release)));
		}
		super::completed(result, released)
	}

	fn with_modifiers(
		target: HWND,
		modifiers: Modifiers,
		operation: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		let mut keys = Vec::with_capacity(4);
		for key in super::modifier_keys(modifiers) {
			keys.push(background::virtual_key(key)?.0);
		}
		let presses = keys
			.iter()
			.map(|&vk| key_event(vk, false))
			.collect::<Vec<_>>();
		let releases = keys
			.iter()
			.rev()
			.map(|&vk| key_event(vk, true))
			.collect::<Vec<_>>();
		holding(target, &presses, &releases, operation)
	}

	pub(super) fn key_chord(id: &str, keys: &[KeyName]) -> CoreResult<()> {
		let mut virtual_keys = Vec::with_capacity(keys.len().saturating_mul(2));
		for &key in keys {
			let (vk, implicit) = background::virtual_key(key)?;
			if implicit & 1 != 0 {
				virtual_keys.push(background::virtual_key(KeyName::Shift)?.0);
			}
			if implicit & 2 != 0 {
				virtual_keys.push(background::virtual_key(KeyName::Ctrl)?.0);
			}
			if implicit & 4 != 0 {
				virtual_keys.push(background::virtual_key(KeyName::Alt)?.0);
			}
			virtual_keys.push(vk);
		}
		let presses = virtual_keys
			.iter()
			.map(|&vk| key_event(vk, false))
			.collect::<Vec<_>>();
		let releases = virtual_keys
			.iter()
			.rev()
			.map(|&vk| key_event(vk, true))
			.collect::<Vec<_>>();
		ForegroundGuard::activate(id, KEY_SETTLE)?
			.run(|target| holding(target, &presses, &releases, || Ok(())))
	}

	pub(super) fn type_text(id: &str, text: &str) -> CoreResult<()> {
		let mut events = Vec::with_capacity(text.len().saturating_mul(2));
		for unit in text_units(text) {
			match unit {
				TextUnit::Enter => {
					events.extend([key_event(VK_RETURN, false), key_event(VK_RETURN, true)]);
				},
				TextUnit::Char(character) => {
					let mut units = [0; 2];
					for &unit in character.encode_utf16(&mut units).iter() {
						events.extend([unicode_event(unit, false), unicode_event(unit, true)]);
					}
				},
			}
		}
		background::ensure_text_supported(id, background::hwnd(id)?)?;
		if events.is_empty() {
			return Ok(());
		}
		ForegroundGuard::activate(id, KEY_SETTLE)?.run(|target| send_to(target, &events))
	}

	#[cfg(test)]
	mod tests {
		use super::*;

		#[test]
		fn short_click_releases_only_an_inserted_button_down() {
			let click = [
				mouse_event(MOUSEEVENTF_MOVE, 0),
				mouse_event(MOUSEEVENTF_LEFTDOWN, 0),
				mouse_event(MOUSEEVENTF_LEFTUP, 0),
			];
			assert!(pending_releases(&click[..1]).is_empty());
			let pending = pending_releases(&click[..2]);
			assert_eq!(pending.len(), 1);
			assert!(same_release(&pending[0], &mouse_event(MOUSEEVENTF_LEFTUP, 0)));
			assert!(pending_releases(&click).is_empty());
		}

		#[test]
		fn short_unicode_batch_does_not_replay_completed_characters() {
			let text = [
				unicode_event(0x41, false),
				unicode_event(0x41, true),
				unicode_event(0xd83d, false),
				unicode_event(0xd83d, true),
				unicode_event(0xde00, false),
				unicode_event(0xde00, true),
			];
			let pending = pending_releases(&text[..5]);
			assert_eq!(pending.len(), 1);
			assert!(same_release(&pending[0], &unicode_event(0xde00, true)));
			assert!(pending_releases(&text).is_empty());
		}

		#[test]
		fn short_chord_tracks_repeats_and_completed_releases() {
			let ctrl_down = keyboard_input(0x11, 0x1d, 0);
			let ctrl_up = keyboard_input(0x11, 0x1d, KEYEVENTF_KEYUP);
			let letter_down = keyboard_input(0x41, 0x1e, 0);
			let letter_up = keyboard_input(0x41, 0x1e, KEYEVENTF_KEYUP);
			let chord = [ctrl_down, letter_down, letter_down, letter_up, ctrl_up];
			let pending = pending_releases(&chord[..3]);
			assert_eq!(pending.len(), 2);
			assert!(same_release(&pending[1], &letter_up));
			assert!(same_release(&pending[0], &ctrl_up));
			let pending = pending_releases(&chord[..4]);
			assert_eq!(pending.len(), 1);
			assert!(same_release(&pending[0], &ctrl_up));
			assert!(pending_releases(&chord).is_empty());
		}
	}
}

pub(super) fn pointer(
	global: &mut Enigo,
	ax: &mut Win32Ax,
	target: &Target,
	event: PointerEvent,
	mode: DeliveryMode,
) -> CoreResult<()> {
	match target {
		Target::Desktop => global_pointer(global, event),
		Target::Window(id) if mode == DeliveryMode::Background => background::pointer(ax, id, event),
		Target::Window(id) => foreground::pointer(id, event),
	}
}

pub(super) fn type_text(
	global: &mut Enigo,
	target: &Target,
	text: &str,
	mode: DeliveryMode,
) -> CoreResult<()> {
	match target {
		Target::Desktop => global.text(text).map_err(enigo_error),
		Target::Window(id) if mode == DeliveryMode::Background => background::type_text(id, text),
		Target::Window(id) => foreground::type_text(id, text),
	}
}

pub(super) fn key_chord(
	global: &mut Enigo,
	target: &Target,
	keys: &[KeyName],
	mode: DeliveryMode,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::input_failed("key chord is empty"));
	}
	match target {
		Target::Desktop => global_key_chord(global, keys),
		Target::Window(id) if mode == DeliveryMode::Background => background::key_chord(id, keys),
		Target::Window(id) => foreground::key_chord(id, keys),
	}
}

/// Restores a minimized window and makes it the foreground window.
pub(super) fn raise_window(id: &str) -> CoreResult<()> {
	use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, SW_RESTORE, ShowWindow};
	let hwnd = background::hwnd(id)?;
	// SAFETY: hwnd was validated; these functions do not retain borrowed state.
	unsafe {
		if IsIconic(hwnd) != 0 {
			ShowWindow(hwnd, SW_RESTORE);
		}
	}
	window::activate(hwnd);
	if window::wait_for_foreground(hwnd, Duration::from_millis(500)) {
		Ok(())
	} else {
		Err(DesktopError::input_failed(format!(
			"Windows refused to raise window {id} (foreground lock)"
		)))
	}
}
