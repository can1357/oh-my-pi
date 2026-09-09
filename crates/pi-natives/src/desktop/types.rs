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
	pub data:           Uint8Array,
	pub width:          u32,
	pub height:         u32,
	/// Pre-scaling capture width in native pixels; equals `width` when unscaled.
	pub source_width:   u32,
	/// Pre-scaling capture height in native pixels; equals `height` when
	/// unscaled.
	pub source_height:  u32,
	pub target:         String,
	pub displays:       Vec<DesktopDisplay>,
	pub backend:        String,
	pub display_server: Option<String>,
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
	pub delivery_modes: Vec<String>,
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
			delivery_modes: Vec::new(),
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

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct PointerOptions {
	pub button:        Option<String>,
	pub count:         Option<u32>,
	pub modifiers:     Option<Vec<String>>,
	pub delivery_mode: Option<String>,
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
	Window(String),
}

impl Target {
	pub(crate) fn parse(value: &str) -> Self {
		if value.eq_ignore_ascii_case("desktop") {
			Self::Desktop
		} else {
			Self::Window(value.to_string())
		}
	}

	pub(crate) fn key(&self) -> &str {
		match self {
			Self::Desktop => "desktop",
			Self::Window(id) => id,
		}
	}
}

#[derive(Debug, Clone)]
pub enum DisplaySelector {
	All,
	Id(String),
}

impl DisplaySelector {
	pub(crate) fn parse(display: Option<String>) -> Self {
		match display {
			Some(id) if !id.trim().is_empty() && !id.eq_ignore_ascii_case("all") => Self::Id(id),
			_ => Self::All,
		}
	}
}
