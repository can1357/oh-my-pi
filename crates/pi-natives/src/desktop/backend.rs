use std::time::Duration;

use image::RgbaImage;

use super::{
	ax::{AxHandle, AxProps, WalkBounds},
	control::OperationToken,
	error::{CoreResult, DesktopError, ErrorCode},
	frame::FrameGeometry,
	keys::KeyName,
	menus::DesktopMenuItem,
	text_range::TextSelectRequest,
	types::{
		AxTextSelection, CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow,
		DisplaySelector, ScreenState, Target,
	},
};

/// Whether an AX `perform` action names a raise: `raise` in any case, or the
/// native `AXRaise`. Matches the macOS action naming, so a raise that arms the
/// physical-Escape stop is exactly a raise that runs as `AXRaise`.
pub(crate) fn is_raise_action(action: &str) -> bool {
	action.trim().eq_ignore_ascii_case("raise") || action == "AXRaise"
}

/// How window-targeted input reaches its target.
///
/// `Background` avoids deliberate activation and physical pointer movement;
/// unsupported routes refuse, and detected focus side effects surface as
/// potentially delivered input. `Foreground` is the explicit `takeover: true`
/// escalation: it activates the target and restores state where the OS allows,
/// without overwriting a newer user focus choice. `ForegroundReturnFocus`
/// (`takeover` with `returnFocus`) is the host's own rerun of a refused
/// background action: it hands focus back to the user's app even after the user
/// clicked or pressed a shortcut meanwhile, and leaves it only on a third app
/// the user switched to. Backends that cannot tell the two apart treat it as
/// `Foreground`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeliveryMode {
	#[default]
	Background,
	Foreground,
	ForegroundReturnFocus,
}

impl DeliveryMode {
	pub(crate) const fn from_takeover(takeover: Option<bool>) -> Self {
		if matches!(takeover, Some(true)) {
			Self::Foreground
		} else {
			Self::Background
		}
	}

	/// Upgrades a foreground mode to return focus; background stays background.
	pub(crate) const fn returning_focus(self, return_focus: bool) -> Self {
		match self {
			Self::Foreground if return_focus => Self::ForegroundReturnFocus,
			mode => mode,
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

/// A held prevent-idle-display-sleep assertion; dropping it releases it.
pub type DisplayAwakeHold = Box<dyn Send>;

/// Keyboard input addressed to one accessibility element.
#[derive(Debug, Clone)]
pub enum ElementInput {
	Text(String),
	Chord(Vec<KeyName>),
}

/// Where an application's keyboard focus is, read when an element it was
/// given to did not report holding it.
#[derive(Clone, Default)]
pub struct KeyboardFocus {
	/// The window holding keyboard focus, when it can be identified.
	pub window:  Option<String>,
	/// The application's focused element, when it reports one.
	pub element: Option<AxHandle>,
}

/// Outcome of keyboard input addressed to an element.
pub enum ElementDelivery {
	Delivered,
	/// The element never reported keyboard focus; nothing was sent.
	#[cfg_attr(
		not(target_os = "macos"),
		allow(dead_code, reason = "only macOS reads which element holds keyboard focus")
	)]
	Unfocused(KeyboardFocus),
}

pub trait Backend: Send {
	fn capabilities(&mut self) -> DesktopCapabilities;
	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>>;
	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>>;
	/// The process owning window `id`, found even when the window is off the
	/// current Space, without listing every window.
	#[cfg(target_os = "macos")]
	fn window_app(&mut self, id: &str) -> Option<libc::pid_t>;
	/// The name of process `pid`'s application.
	#[cfg(target_os = "macos")]
	fn app_name(&mut self, pid: libc::pid_t) -> String;
	/// The process that draws window `id` of process `pid` and takes the
	/// user's input there, such as `openAndSavePanelService` for a system Open
	/// or Save panel; `pid` itself when the window draws its own content or
	/// cannot be read.
	#[cfg(target_os = "macos")]
	fn window_input(&mut self, id: &str, pid: libc::pid_t) -> libc::pid_t;
	/// Live lock and display-sleep state; `display` narrows the sleep check to
	/// the display a request targets, else the session's. Backends that cannot
	/// tell report both as false.
	fn screen_state(&mut self, _display: Option<&DisplaySelector>) -> ScreenState {
		ScreenState::default()
	}
	/// Start the platform's prevent-idle-display-sleep assertion, held until the
	/// returned guard drops. Backends without one return `None`.
	fn hold_display_awake(&mut self) -> Option<DisplayAwakeHold> {
		None
	}
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
	/// [`Self::pointer`] for a click that opens a menu, then chooses the item
	/// at `path` in that menu before returning.
	fn pointer_menu(
		&mut self,
		_target: &Target,
		_ev: PointerEvent,
		_path: &[String],
		_frame: &FrameGeometry,
		_mode: DeliveryMode,
		_token: &OperationToken,
	) -> CoreResult<()> {
		Err(DesktopError::new(
			ErrorCode::Unsupported,
			"choosing a menu item in the click that opens the menu is available only on macOS",
		))
	}
	/// Refuses, before anything is sent, background pointer input `ev` on
	/// `target` whose left press would open a control's menu: a click that
	/// lands on one, or a mouse hold or drag that starts there. Only macOS opens
	/// one for a plain background press (a menu button or popup button), so
	/// other backends accept every press.
	fn refuse_menu_press(&mut self, _target: &Target, _ev: &PointerEvent) -> CoreResult<()> {
		Ok(())
	}
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
	/// Types or presses `input` into `element`, a live element of window
	/// `target`. Backends that cannot read which element holds keyboard focus
	/// focus it and send through the window's keyboard path.
	fn element_input(
		&mut self,
		target: &Target,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		self
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)?
			.focus(element)?;
		match input {
			ElementInput::Text(text) => self.type_text(target, text, mode, token)?,
			ElementInput::Chord(keys) => self.key_chord(target, keys, mode, token)?,
		}
		Ok(ElementDelivery::Delivered)
	}
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
	/// [`Self::perform`] for an action that opens a menu, then chooses the item
	/// at `path` in that menu before returning.
	fn perform_menu(&mut self, _h: &AxHandle, _action: &str, _path: &[String]) -> CoreResult<()> {
		Err(DesktopError::new(
			ErrorCode::Unsupported,
			"choosing a menu item in the action that opens the menu is available only on macOS",
		))
	}
	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()>;
	fn focus(&mut self, h: &AxHandle) -> CoreResult<()>;
	/// Selects the text `request` names in the element's value, leaving the
	/// value unchanged, and returns the selection read back.
	fn select_text(
		&mut self,
		_h: &AxHandle,
		_request: &TextSelectRequest,
	) -> CoreResult<AxTextSelection> {
		Err(DesktopError::new(
			super::error::ErrorCode::Unsupported,
			"selecting text by accessibility is available only on macOS",
		))
	}
	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>>;
	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>>;
	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>>;
	/// Whether the element `h` was read from still exists. Backends whose
	/// identities a later element can take over once the first is gone check
	/// it, so a ref is never renewed onto the newcomer.
	fn alive(&mut self, _h: &AxHandle) -> bool {
		true
	}
	/// Whether the app has provably destroyed the element `h` was read from,
	/// rather than a request on it failing on another element. Only then does
	/// a `StaleRef` name the one element left with its fields.
	fn destroyed(&mut self, _h: &AxHandle) -> bool {
		false
	}
}
