#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(any(target_os = "windows", test))]
mod geometry;
#[cfg(target_os = "windows")]
mod input;
#[cfg(target_os = "windows")]
mod menus;
#[cfg(target_os = "windows")]
mod window;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::ax::AxHandle;
#[cfg(target_os = "windows")]
use super::backend::{
	AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent,
};
#[cfg(target_os = "windows")]
use super::control::OperationToken;
#[cfg(target_os = "windows")]
use super::error::{CoreResult, DesktopError};
#[cfg(target_os = "windows")]
use super::frame::FrameGeometry;
#[cfg(target_os = "windows")]
use super::keys::KeyName;
#[cfg(target_os = "windows")]
use super::types::{
	CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
};

#[cfg(target_os = "windows")]
pub(crate) struct Win32Backend {
	display:      DisplaySelector,
	global_input: Enigo,
	ax:           Win32Ax,
}

#[cfg(target_os = "windows")]
impl Win32Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		// Initialize DPI awareness before xcap or input observes desktop
		// geometry, keeping both APIs in the same per-monitor physical
		// coordinate regime.
		let global_input = input::create_global_input()?;
		let _ = capture::displays()?;
		Ok(Self { display, global_input, ax: Win32Ax::new() })
	}
}

#[cfg(target_os = "windows")]
impl Backend for Win32Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let display_count =
			capture::displays().map_or(0, |displays| displays.len().min(u32::MAX as usize) as u32);
		DesktopCapabilities {
			backend: "win32".to_string(),
			display_server: Some("win32".to_string()),
			capture: display_count > 0,
			input: true,
			ax: true,
			background_window_input: true,
			takeover: true,
			applications: super::applications::supported(),
			menus: true,
			held_input: true,
			spaces: false,
			global_escape: true,
			capture_permission: if display_count > 0 {
				"granted"
			} else {
				"unknown"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "granted".to_string(),
			display_count,
			screen_locked: false,
			display_asleep: false,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let explicit = target.display_selector();
		capture::capture(selector.or(explicit.as_ref()).unwrap_or(&self.display), target)
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
		input::pointer(&mut self.global_input, &mut self.ax, target, event, mode)
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::type_text(target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::key_chord(&mut self.global_input, target, keys, mode)
	}

	/// Background keys go straight to the element's own control window,
	/// leaving the window's focus and the foreground alone: UI Automation's
	/// `SetFocus` would bring the window to the front, taking the user's
	/// keyboard. A windowless element (WPF, `WinUI`, web content) has no
	/// window to post to, so background input refuses. Takeover focuses the
	/// element and types through the foreground route.
	fn element_input(
		&mut self,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		let windows = capture::windows()?;
		let id = self.ax.window_id(element, &windows)?;
		match mode {
			DeliveryMode::Background => {
				let own = Win32Ax::own_window(element)?.ok_or_else(|| {
					DesktopError::background_unavailable(format!(
						"this element of window {id} is drawn without a control window of its own, so \
						 background keys cannot address it, and focusing it would bring the window to \
						 the front; nothing was sent"
					))
				})?;
				input::element_background(&id, own, input)?;
			},
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
				let target = Target::Window(id);
				self.ax.focus(element)?;
				match input {
					ElementInput::Text(text) => input::type_text(&target, text, mode)?,
					ElementInput::Chord(keys) => {
						input::key_chord(&mut self.global_input, &target, keys, mode)?;
					},
				}
			},
		}
		Ok(ElementDelivery::Delivered)
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
		input::hold_keys(&mut self.global_input, target, keys, duration, mode)
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<super::menus::DesktopMenuItem>> {
		menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		menus::select(window, path)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		input::raise_window(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}
