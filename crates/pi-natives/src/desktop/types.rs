use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

/// Monitor geometry in both global logical desktop coordinates and composite
/// screenshot pixels.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopDisplay {
	pub id:           String,
	pub name:         String,
	pub x:            i32,
	pub y:            i32,
	pub width:        u32,
	pub height:       u32,
	pub scale:        f64,
	pub pixel_x:      u32,
	pub pixel_y:      u32,
	pub pixel_width:  u32,
	pub pixel_height: u32,
	pub is_primary:   bool,
}

/// One capturable top-level window in global logical desktop coordinates.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopWindow {
	/// Backend-defined opaque window id, valid as a capture target while the
	/// window lives. Numeric on X11/Win32/macOS; a composite AT-SPI string on
	/// Wayland (e.g. `atspi::1.31:/org/a11y/atspi/accessible/1`). Never parse
	/// it.
	pub id:      String,
	/// Window title; may be empty for untitled windows.
	pub title:   String,
	/// Owning application name.
	pub app:     String,
	/// Owning process id when the platform exposes it.
	pub pid:     Option<u32>,
	pub x:       i32,
	pub y:       i32,
	pub width:   u32,
	pub height:  u32,
	/// Whether the window currently holds input focus.
	pub focused: bool,
}

#[napi(object)]
pub struct DesktopCapture {
	pub data:              Uint8Array,
	pub width:             u32,
	pub height:            u32,
	/// Pre-scaling capture width in native pixels; equals `width` when unscaled.
	pub source_width:      u32,
	/// Pre-scaling capture height in native pixels; equals `height` when
	/// unscaled.
	pub source_height:     u32,
	/// Dimensions of the full screenshot coordinate frame used by pointer input.
	pub coordinate_width:  u32,
	pub coordinate_height: u32,
	/// Region in the full screenshot's coordinates; zoom pixels are not input
	/// coordinates.
	pub region:            Option<CaptureRegion>,
	pub target:            String,
	pub displays:          Vec<DesktopDisplay>,
	pub backend:           String,
	pub display_server:    Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopCapabilities {
	pub backend: String,
	pub display_server: Option<String>,
	pub capture: bool,
	pub input: bool,
	pub ax: bool,
	pub background_window_input: bool,
	/// Whether window input accepts `takeover: true` (briefly activate the
	/// target and post real input).
	pub takeover: bool,
	pub applications: bool,
	pub menus: bool,
	pub held_input: bool,
	pub spaces: bool,
	/// Native global Escape cancellation while input/control ownership is held.
	/// Wayland requires the host interrupt action instead.
	pub global_escape: bool,
	pub capture_permission: String,
	pub input_permission: String,
	pub ax_permission: String,
	pub display_count: u32,
}

impl DesktopCapabilities {
	pub(crate) fn unavailable() -> Self {
		Self {
			backend: "unavailable".to_string(),
			display_server: None,
			capture: false,
			input: false,
			ax: false,
			background_window_input: false,
			takeover: false,
			applications: super::applications::supported(),
			menus: false,
			held_input: false,
			spaces: false,
			global_escape: false,
			capture_permission: "unavailable".to_string(),
			input_permission: "unavailable".to_string(),
			ax_permission: "unavailable".to_string(),
			display_count: 0,
		}
	}
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct DesktopSessionOptions {
	pub display: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct CaptureCaps {
	pub max_width:  Option<u32>,
	pub max_height: Option<u32>,
}

/// Rectangle in pixels of the most recent full screenshot of the same target.
#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureRegion {
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct PointerOptions {
	pub button:       Option<String>,
	pub count:        Option<u32>,
	pub modifiers:    Option<Vec<String>>,
	/// Arbitrary keys held for the duration of a drag.
	pub keys:         Option<Vec<String>>,
	/// Briefly activate the target window and post real input instead of the
	/// default background delivery.
	pub takeover:     Option<bool>,
	/// With `takeover`, hand focus back to the user's app even if they typed
	/// or clicked during the action; only a third app they switched to keeps
	/// it. The host sets this when it reruns a refused background action.
	pub return_focus: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct HoldOptions {
	/// Duration in seconds, from zero through 100.
	pub duration:     f64,
	pub button:       Option<String>,
	pub keys:         Option<Vec<String>>,
	pub takeover:     Option<bool>,
	/// With `takeover`, hand focus back to the user's app even after their
	/// input during the hold; see `PointerOptions.returnFocus`.
	pub return_focus: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct DesktopControlState {
	pub active: bool,
}

#[napi(object)]
pub struct DesktopObservation {
	pub capture:       DesktopCapture,
	pub accessibility: AxSnapshot,
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct DesktopPoint {
	pub x: f64,
	pub y: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct AxNode {
	#[napi(js_name = "ref")]
	pub ref_:        String,
	pub role:        String,
	pub native_role: String,
	pub title:       Option<String>,
	pub value:       Option<String>,
	pub description: Option<String>,
	pub enabled:     bool,
	pub focused:     bool,
	pub x:           Option<f64>,
	pub y:           Option<f64>,
	pub width:       Option<f64>,
	pub height:      Option<f64>,
	pub actions:     Option<Vec<String>>,
	pub child_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct AxSnapshot {
	pub text:       String,
	pub node_count: u32,
	pub truncated:  bool,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct AxSnapshotOptions {
	pub max_depth: Option<u32>,
	pub max_nodes: Option<u32>,
	pub all:       Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct AxQuery {
	pub role:  Option<String>,
	pub title: Option<String>,
	pub value: Option<String>,
	pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
	Desktop,
	/// Canonical target key, including the reserved `display:` prefix.
	Display(String),
	Window(String),
}

impl Target {
	pub(crate) fn parse(value: &str) -> Self {
		if value.eq_ignore_ascii_case("desktop") {
			Self::Desktop
		} else if let Some(selector) = value.strip_prefix("display:") {
			let selector = selector.trim();
			let selector = if selector.eq_ignore_ascii_case("active") || selector.is_empty() {
				"active"
			} else if selector.eq_ignore_ascii_case("all") {
				"all"
			} else {
				selector
			};
			Self::Display(format!("display:{selector}"))
		} else {
			Self::Window(value.to_string())
		}
	}

	pub(crate) fn key(&self) -> &str {
		match self {
			Self::Desktop => "desktop",
			Self::Window(id) | Self::Display(id) => id,
		}
	}

	pub(crate) fn display_selector(&self) -> Option<DisplaySelector> {
		match self {
			Self::Display(key) => {
				Some(DisplaySelector::parse(Some(key["display:".len()..].to_string())))
			},
			_ => None,
		}
	}
}

#[derive(Debug, Clone)]
pub enum DisplaySelector {
	Active,
	All,
	Id(String),
}

impl DisplaySelector {
	pub(crate) fn parse(display: Option<String>) -> Self {
		match display.as_deref().map(str::trim) {
			None | Some("") => Self::Active,
			Some(value) if value.eq_ignore_ascii_case("active") => Self::Active,
			Some(value) if value.eq_ignore_ascii_case("all") => Self::All,
			Some(id) => Self::Id(id.to_string()),
		}
	}

	pub(crate) fn select(
		&self,
		mut displays: Vec<DesktopDisplay>,
		focused: Option<&DesktopWindow>,
	) -> super::error::CoreResult<Vec<DesktopDisplay>> {
		match self {
			Self::All => {},
			Self::Id(id) => displays.retain(|display| display.id == *id),
			Self::Active => {
				let selected = focused
					.and_then(|window| {
						displays
							.iter()
							.enumerate()
							.map(|(index, display)| {
								let left = i64::from(window.x).max(i64::from(display.x));
								let top = i64::from(window.y).max(i64::from(display.y));
								let right = (i64::from(window.x) + i64::from(window.width))
									.min(i64::from(display.x) + i64::from(display.width));
								let bottom = (i64::from(window.y) + i64::from(window.height))
									.min(i64::from(display.y) + i64::from(display.height));
								let area = (right - left).max(0) as u64 * (bottom - top).max(0) as u64;
								(index, area, display.is_primary)
							})
							.filter(|(_, area, _)| *area > 0)
							.max_by_key(|(_, area, primary)| (*area, *primary))
							.map(|(index, ..)| index)
					})
					.or_else(|| displays.iter().position(|display| display.is_primary))
					.or_else(|| (!displays.is_empty()).then_some(0));
				if let Some(index) = selected {
					let display = displays.swap_remove(index);
					displays.clear();
					displays.push(display);
				}
			},
		}
		if displays.is_empty() {
			return Err(match self {
				Self::Id(id) => super::error::DesktopError::invalid_target(format!(
					"selected display id '{id}' is not active"
				)),
				Self::Active | Self::All => {
					super::error::DesktopError::capture_failed("no active displays were found")
				},
			});
		}
		Ok(displays)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn display(id: &str, x: i32, primary: bool) -> DesktopDisplay {
		DesktopDisplay {
			id: id.to_string(),
			name: id.to_string(),
			x,
			y: 0,
			width: 100,
			height: 100,
			scale: 1.0,
			pixel_x: 0,
			pixel_y: 0,
			pixel_width: 100,
			pixel_height: 100,
			is_primary: primary,
		}
	}

	#[test]
	fn display_keys_never_alias_windows_or_the_root_desktop() {
		assert!(matches!(Target::parse("display:active"), Target::Display(_)));
		assert_eq!(Target::parse("display:ACTIVE").key(), "display:active");
		assert_eq!(Target::parse("display:all").key(), "display:all");
		assert_eq!(Target::parse("display:screen-1").key(), "display:screen-1");
		assert_eq!(Target::parse("screen-1").key(), "screen-1");
		assert!(matches!(Target::parse("screen-1"), Target::Window(_)));
		assert_ne!(Target::parse("display:active"), Target::parse("desktop"));
	}

	#[test]
	fn active_default_selects_largest_focused_window_intersection_with_primary_fallback() {
		assert!(matches!(DisplaySelector::parse(None), DisplaySelector::Active));
		assert!(matches!(DisplaySelector::parse(Some("active".into())), DisplaySelector::Active));
		let displays = vec![display("left", -100, true), display("right", 0, false)];
		let window = DesktopWindow {
			id:      "window".into(),
			title:   String::new(),
			app:     String::new(),
			pid:     None,
			x:       -10,
			y:       10,
			width:   70,
			height:  50,
			focused: true,
		};
		let selected = DisplaySelector::Active
			.select(displays.clone(), Some(&window))
			.unwrap();
		assert_eq!(selected[0].id, "right");
		let selected = DisplaySelector::Active
			.select(displays.clone(), None)
			.unwrap();
		assert_eq!(selected[0].id, "left");
		let offscreen = DesktopWindow { x: 1000, ..window };
		assert_eq!(
			DisplaySelector::Active
				.select(displays.clone(), Some(&offscreen))
				.unwrap()[0]
				.id,
			"left"
		);
		assert_eq!(
			DisplaySelector::parse(Some("all".into()))
				.select(displays.clone(), None)
				.unwrap()
				.len(),
			2
		);
		assert_eq!(
			DisplaySelector::parse(Some("right".into()))
				.select(displays.clone(), None)
				.unwrap()[0]
				.id,
			"right"
		);
		assert!(
			DisplaySelector::Id("missing".into())
				.select(displays, None)
				.is_err()
		);
	}
}
