mod ax;
mod capture;
mod date;
mod input;
pub(super) mod permission;
mod process;
mod session;
mod skylight;
mod spaces;

pub(super) use ax::menus;
pub(super) use capture::application_windows;
use image::RgbaImage;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
pub(super) use process::started as process_started;
pub(super) use session::screen_state;
pub(super) use skylight::front_pid;

use self::{ax::MacAx, capture::MacCapture, input::MacInput, session::DisplayAwake};
use super::{
	ax::AxHandle,
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
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
	capture:       MacCapture,
	input:         MacInput,
	ax:            MacAx,
	display_awake: DisplayAwake,
}

impl MacosBackend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		Ok(Self {
			capture:       MacCapture::new(display),
			input:         MacInput::new()?,
			ax:            MacAx::new(),
			display_awake: DisplayAwake::default(),
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

	fn window_app(&mut self, id: &str) -> Option<(libc::pid_t, String)> {
		let pid = skylight::window_owner_pid(id.parse().ok()?)?;
		Some((pid, app_name(pid)))
	}

	fn screen_state(&mut self, display: Option<&DisplaySelector>) -> ScreenState {
		session::screen_state(display.unwrap_or_else(|| self.capture.selector()))
	}

	fn keep_display_awake(&mut self, awake: bool) {
		self.display_awake.set(awake);
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
		self.input.pointer(target, event, mode, &self.capture)
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
		self.input.type_text(target, text, mode, &self.capture)
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
		self.input.key_chord(target, keys, mode, &self.capture)
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
		self
			.input
			.hold_keys(target, keys, duration, mode, &self.capture)
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
		menus::select(window, path)
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

/// The process owning the element `h` names, with its application's name.
pub(super) fn element_app(h: &AxHandle) -> CoreResult<(libc::pid_t, String)> {
	let pid = ax::handle_pid(h)?;
	Ok((pid, app_name(pid)))
}

fn app_name(pid: libc::pid_t) -> String {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.localizedName())
		.map_or_else(|| format!("process {pid}"), |name| name.to_string())
}

fn permission_label(granted: bool) -> String {
	if granted {
		"granted".to_string()
	} else {
		"denied".to_string()
	}
}
