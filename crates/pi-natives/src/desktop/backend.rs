use std::time::Duration;

use image::RgbaImage;

use super::{
	ax::{AxHandle, AxProps, WalkBounds},
	control::OperationToken,
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	menus::DesktopMenuItem,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
		UiQuiet,
	},
};

/// How window-targeted input reaches its target.
///
/// `Background` avoids deliberate activation and physical pointer movement;
/// unsupported routes refuse, and detected focus side effects surface as
/// potentially delivered input. `Foreground` is the explicit `takeover: true`
/// escalation: it activates the target and restores state where the OS allows,
/// without overwriting a newer user focus choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeliveryMode {
	#[default]
	Background,
	Foreground,
}

impl DeliveryMode {
	pub(crate) const fn from_takeover(takeover: Option<bool>) -> Self {
		if matches!(takeover, Some(true)) {
			Self::Foreground
		} else {
			Self::Background
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
	#[default]
	Left,
	Right,
	Middle,
}

impl MouseButton {
	pub(crate) fn parse(value: Option<&str>) -> CoreResult<Self> {
		match value.map(str::trim) {
			None => Ok(Self::Left),
			Some(value) if value.eq_ignore_ascii_case("left") => Ok(Self::Left),
			Some(value) if value.eq_ignore_ascii_case("right") => Ok(Self::Right),
			Some(value) if value.eq_ignore_ascii_case("middle") => Ok(Self::Middle),
			Some(value) => Err(DesktopError::input_failed(format!("unknown button '{value}'"))),
		}
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
	pub ctrl:  bool,
	pub alt:   bool,
	pub shift: bool,
	pub meta:  bool,
}

#[derive(Debug, Clone)]
pub enum PointerEvent {
	Click {
		x:         f64,
		y:         f64,
		button:    MouseButton,
		count:     u32,
		modifiers: Modifiers,
	},
	Move {
		x: f64,
		y: f64,
	},
	Drag {
		path:      Vec<(f64, f64)>,
		button:    MouseButton,
		modifiers: Modifiers,
		keys:      Vec<KeyName>,
	},
	Hold {
		x:        f64,
		y:        f64,
		button:   MouseButton,
		keys:     Vec<KeyName>,
		duration: Duration,
	},
	Scroll {
		x:  f64,
		y:  f64,
		dx: f64,
		dy: f64,
	},
}

pub trait Backend: Send {
	fn capabilities(&mut self) -> DesktopCapabilities;
	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>>;
	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>>;
	/// Explicit display keyboard input must establish the focused surface's
	/// real global monitor, not infer it from window-relative coordinates.
	fn focused_keyboard_window(&mut self) -> CoreResult<DesktopWindow> {
		self
			.windows()?
			.into_iter()
			.find(|window| window.focused)
			.ok_or_else(|| {
				DesktopError::invalid_target("no focused window was found for display keyboard input")
			})
	}
	fn validate_frame_layout(&mut self, frame: &FrameGeometry) -> CoreResult<()> {
		let displays = self.displays().map_err(|error| {
			DesktopError::invalid_coordinate_frame(format!(
				"cannot establish current display layout: {error}"
			))
		})?;
		frame.validate_layout(&displays)
	}
	fn capture(
		&mut self,
		target: &Target,
		caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)>;
	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()>;
	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()>;
	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()>;
	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: Duration,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()>;
	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<DesktopMenuItem>>;
	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()>;
	fn bring_to_current_space(&mut self, _id: &str, _token: &OperationToken) -> CoreResult<()> {
		Err(DesktopError::new(
			super::error::ErrorCode::SpaceUnsupported,
			"moving windows between Spaces is available only on macOS",
		))
	}
	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()>;
	/// Blocks until none of `pids` has emitted a counted accessibility
	/// notification for `quiet`, giving up after `cap`. Backends without
	/// notification support report nothing watched so callers fall back to a
	/// fixed delay.
	fn wait_for_ui_quiet(
		&mut self,
		_pids: &[u32],
		_quiet: Duration,
		_cap: Duration,
		_token: &OperationToken,
	) -> CoreResult<UiQuiet> {
		Ok(UiQuiet::unwatched())
	}
	fn ax(&mut self) -> Option<&mut dyn AxBackend>;
}

pub trait AxBackend {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle>;
	/// Resolves an element's owning top-level window for coordinate input.
	/// Refuses missing or ambiguous ownership instead of hit-testing unrelated
	/// windows.
	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String>;
	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps>;
	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>>;
	/// Reads an element and its children for a tree walk, letting a backend
	/// share one children read and skip bounds the walk does not need.
	fn walk_node(
		&mut self,
		h: &AxHandle,
		_bounds: WalkBounds,
	) -> CoreResult<(AxProps, Vec<AxHandle>)> {
		Ok((self.props(h)?, self.children(h)?))
	}
	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>>;
	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()>;
	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()>;
	fn focus(&mut self, h: &AxHandle) -> CoreResult<()>;
	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>>;
	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>>;
	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>>;
	/// Whether the element `h` was read from still exists. Backends whose
	/// identities a later element can take over once the first is gone check
	/// it, so a ref is never renewed onto the newcomer.
	fn alive(&mut self, _h: &AxHandle) -> bool {
		true
	}
}
