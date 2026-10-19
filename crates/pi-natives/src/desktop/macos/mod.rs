mod ax;
mod capture;
mod date;
mod input;
mod key_reroute;
mod keymap;
mod permission;
mod process;
#[allow(dead_code, reason = "shared with the input-release helper, which uses the rest")]
mod release;
mod release_guard;
mod route;
mod session;
mod skylight;
mod spaces;

#[cfg(test)]
pub(super) use ax::application_handle;
pub(super) use ax::{ax_window_ids, has_open_window, menus};
pub(super) use capture::{application_windows, has_onscreen_window};
use image::RgbaImage;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
pub(super) use process::started as process_started;
pub(super) use session::screen_state;
pub(super) use skylight::front_pid;
pub(super) use spaces::window_on_another_space;

use self::{ax::MacAx, capture::MacCapture, input::MacInput, release_guard::Presses};
use super::{
	ax::AxHandle,
	backend::{
		AxBackend, Backend, DeliveryMode, DisplayAwakeHold, ElementDelivery, ElementInput,
		PointerEvent,
	},
	control::OperationToken,
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector,
		ScreenState, Target,
	},
};

pub struct MacosBackend {
	capture: MacCapture,
	input:   MacInput,
	ax:      MacAx,
}

impl MacosBackend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		Ok(Self {
			capture: MacCapture::new(display),
			input:   MacInput::new()?,
			ax:      MacAx::new(),
		})
	}

	fn require_input_permission() -> CoreResult<()> {
		if ax::is_trusted() {
			Ok(())
		} else {
			Err(permission::denied("Accessibility"))
		}
	}
}

impl Backend for MacosBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let capture_permission = capture::capture_permission();
		let ax_trusted = ax::is_trusted();
		let display_count = if capture_permission {
			self
				.capture
				.displays()
				.map_or(0, |displays| u32::try_from(displays.len()).unwrap_or(u32::MAX))
		} else {
			0
		};
		let screen = session::screen_state(self.capture.selector());
		DesktopCapabilities {
			backend: "quartz".to_string(),
			display_server: Some("Quartz WindowServer".to_string()),
			capture: capture::capture_available() && capture_permission && display_count > 0,
			input: ax_trusted,
			ax: ax_trusted,
			background_window_input: ax_trusted && skylight::is_available(),
			takeover: skylight::takeover_available(),
			applications: super::applications::supported(),
			menus: ax_trusted,
			held_input: ax_trusted,
			spaces: spaces::supported(),
			global_escape: permission::listen_events(),
			capture_permission: permission_label(capture_permission),
			input_permission: permission_label(permission::post_events()),
			ax_permission: permission_label(ax_trusted),
			display_count,
			screen_locked: screen.locked,
			display_asleep: screen.display_asleep,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		self.capture.displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self.capture.windows()
	}

	fn window_app(&mut self, id: &str) -> Option<libc::pid_t> {
		window_owner(id, skylight::window_owner_pid, || {
			self
				.capture
				.window(id)
				.ok()?
				.pid
				.and_then(|pid| libc::pid_t::try_from(pid).ok())
		})
	}

	fn app_name(&mut self, pid: libc::pid_t) -> String {
		NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			.and_then(|app| app.localizedName())
			.map_or_else(|| format!("process {pid}"), |name| name.to_string())
	}

	fn window_input(&mut self, id: &str, pid: libc::pid_t) -> libc::pid_t {
		match self
			.capture
			.window(id)
			.map(|window| ax::window_content(pid, &window))
		{
			Ok(ax::WindowContent::Remote { pid: owner, .. }) => owner,
			_ => pid,
		}
	}

	fn screen_state(&mut self, display: Option<&DisplaySelector>) -> ScreenState {
		session::screen_state(display.unwrap_or_else(|| self.capture.selector()))
	}

	fn hold_display_awake(&mut self) -> Option<DisplayAwakeHold> {
		session::hold_display_awake().map(|hold| Box::new(hold) as DisplayAwakeHold)
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		self.capture.capture(target, selector)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		release_guard::scope(pointer_presses(&event, target, mode), || {
			self.input.pointer(target, event, None, mode, &self.capture)
		})
	}

	fn pointer_menu(
		&mut self,
		target: &Target,
		event: PointerEvent,
		path: &[String],
		_frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		release_guard::scope(pointer_presses(&event, target, mode), || {
			self
				.input
				.pointer(target, event, Some(path), mode, &self.capture)
		})
	}

	fn refuse_menu_press(&mut self, target: &Target, event: &PointerEvent) -> CoreResult<()> {
		input::refuse_menu_press(target, event, &self.capture)
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		release_guard::scope(presses(target, mode), || {
			self.input.type_text(target, text, mode, &self.capture)
		})
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		release_guard::scope(presses(target, mode), || {
			self.input.key_chord(target, keys, mode, &self.capture)
		})
	}

	fn element_input(
		&mut self,
		target: &Target,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		Self::require_input_permission()?;
		let Target::Window(id) = target else {
			return Err(DesktopError::invalid_target("element input needs the element's window"));
		};
		release_guard::scope(presses(target, mode), || {
			self
				.input
				.element_input(id, ax::mac_handle(element)?, input, mode, &self.capture)
		})
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		release_guard::scope(presses(target, mode), || {
			self
				.input
				.hold_keys(target, keys, duration, mode, &self.capture)
		})
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<super::menus::DesktopMenuItem>> {
		Self::require_input_permission()?;
		menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		// The window's activating click is the only input a menu command posts.
		release_guard::scope(Presses::Process, || menus::select(window, path))
	}

	fn bring_to_current_space(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		spaces::bring_to_current_space(id)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		Self::require_input_permission()?;
		let window = self.capture.window(id)?;
		self.ax.raise(&window)?;
		token.check()?;
		let pid = window.pid.ok_or_else(|| {
			DesktopError::input_failed(format!("window {id} has no owning process id"))
		})?;
		let pid = i32::try_from(pid).map_err(|_| {
			DesktopError::input_failed(format!("window {id} has an invalid process id"))
		})?;
		let app =
			NSRunningApplication::runningApplicationWithProcessIdentifier(pid).ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"application for window '{id}' is no longer running"
				))
			})?;
		token.check()?;
		if !app.activateWithOptions(NSApplicationActivationOptions::empty()) {
			return Err(DesktopError::input_failed(format!(
				"activation request for window '{id}' was rejected"
			)));
		}
		Ok(())
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}

/// The process owning the element `h` names.
pub(super) fn element_app(h: &AxHandle) -> CoreResult<libc::pid_t> {
	ax::handle_pid(h)
}

/// The process owning window `id`: its `WindowServer` owner (`server_owner`),
/// which answers for a window off the current Space too, else the owner the
/// window list names (`listed_owner`), so a missing owner lookup fails only
/// for a window that is gone.
fn window_owner(
	id: &str,
	server_owner: impl FnOnce(u32) -> Option<libc::pid_t>,
	listed_owner: impl FnOnce() -> Option<libc::pid_t>,
) -> Option<libc::pid_t> {
	id.parse().ok().and_then(server_owner).or_else(listed_owner)
}

/// How input to `target` in `mode` presses: on the HID route, which the
/// user's own keyboard and mouse share, or to the target's process.
const fn presses(target: &Target, mode: DeliveryMode) -> Presses {
	if matches!(target, Target::Desktop | Target::Display(_))
		|| !matches!(mode, DeliveryMode::Background)
	{
		Presses::Hid
	} else {
		Presses::Process
	}
}

/// How `event` presses: as other input to `target` does if it presses a
/// button, and not at all if it only moves or scrolls.
const fn pointer_presses(event: &PointerEvent, target: &Target, mode: DeliveryMode) -> Presses {
	if matches!(
		event,
		PointerEvent::Click { .. } | PointerEvent::Drag { .. } | PointerEvent::Hold { .. }
	) {
		presses(target, mode)
	} else {
		Presses::Nothing
	}
}

fn permission_label(granted: bool) -> String {
	if granted {
		"granted".to_string()
	} else {
		"denied".to_string()
	}
}

#[cfg(test)]
mod tests {
	use super::window_owner;

	#[test]
	fn a_window_owner_the_server_cannot_name_comes_from_the_window_list() {
		let unasked = || -> Option<libc::pid_t> { panic!("the window list is not read") };
		assert_eq!(window_owner("42", |_| Some(7), unasked), Some(7));
		// `SLSGetWindowOwner` unavailable: the listed window still names its app.
		assert_eq!(window_owner("42", |_| None, || Some(8)), Some(8));
		// Only a window neither knows is gone.
		assert_eq!(window_owner("42", |_| None, || None), None);
		assert_eq!(window_owner("not-a-window", |_| Some(7), || None), None);
	}
}
