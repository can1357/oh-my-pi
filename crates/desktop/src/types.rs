use bytes::Bytes;

/// Monitor geometry in both global logical desktop coordinates and composite
/// screenshot pixels.
#[derive(Debug, Clone)]
pub struct DesktopDisplay {
	/// Backend-defined opaque display identifier used by
	/// [`DesktopSessionOptions`].
	pub id:           String,
	/// Human-readable display name reported by the backend.
	pub name:         String,
	/// Left edge in global logical desktop points.
	pub x:            i32,
	/// Top edge in global logical desktop points.
	pub y:            i32,
	/// Width in global logical desktop points.
	pub width:        u32,
	/// Height in global logical desktop points.
	pub height:       u32,
	/// Backend-reported ratio of native pixels to logical desktop points.
	pub scale:        f64,
	/// Left edge in pixels within the returned composite screenshot.
	pub pixel_x:      u32,
	/// Top edge in pixels within the returned composite screenshot.
	pub pixel_y:      u32,
	/// Width in pixels within the returned composite screenshot.
	pub pixel_width:  u32,
	/// Height in pixels within the returned composite screenshot.
	pub pixel_height: u32,
	/// Whether the backend identifies this as the primary display.
	pub is_primary:   bool,
}

/// One capturable top-level window in global logical desktop coordinates.
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
	/// Left edge in global logical desktop points.
	pub x:       i32,
	/// Top edge in global logical desktop points.
	pub y:       i32,
	/// Width in global logical desktop points.
	pub width:   u32,
	/// Height in global logical desktop points.
	pub height:  u32,
	/// Whether the window currently holds input focus.
	pub focused: bool,
}

/// A PNG screenshot and the metadata needed to map its pixels back to the
/// desktop.
#[derive(Clone, Debug)]
pub struct DesktopCapture {
	/// PNG-encoded screenshot bytes.
	pub data:           Bytes,
	/// Returned image width in pixels after applying [`CaptureCaps`].
	pub width:          u32,
	/// Returned image height in pixels after applying [`CaptureCaps`].
	pub height:         u32,
	/// Pre-scaling capture width in native pixels; equals `width` when unscaled.
	pub source_width:   u32,
	/// Pre-scaling capture height in native pixels; equals `height` when
	/// unscaled.
	pub source_height:  u32,
	/// Canonical target key: `desktop` or the backend-defined window id.
	pub target:         String,
	/// Display regions mapping global logical points to pixels in this
	/// screenshot.
	pub displays:       Vec<DesktopDisplay>,
	/// Name reported by the backend that produced the screenshot.
	pub backend:        String,
	/// Display-server name reported by the backend, when applicable.
	pub display_server: Option<String>,
}

/// Current feature and permission status reported by the selected desktop
/// backend.
#[derive(Debug, Clone)]
pub struct DesktopCapabilities {
	/// Backend implementation name such as `quartz`, `wayland`, `x11`, or
	/// `win32`.
	pub backend: String,
	/// Active display-server name or connection reported by the backend.
	pub display_server: Option<String>,
	/// Whether screenshot capture is currently available.
	pub capture: bool,
	/// Whether pointer and keyboard injection are currently available.
	pub input: bool,
	/// Whether accessibility-tree operations are currently available.
	pub ax: bool,
	/// Whether the backend can target input at a window without foregrounding
	/// it.
	pub background_window_input: bool,
	/// Backend-reported delivery modes accepted by pointer and keyboard
	/// operations.
	pub delivery_modes: Vec<String>,
	/// Backend-reported capture permission status label.
	pub capture_permission: String,
	/// Backend-reported input permission status label.
	pub input_permission: String,
	/// Backend-reported accessibility permission status label.
	pub ax_permission: String,
	/// Number of displays the backend can currently enumerate.
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

/// Options selecting the display set used by a desktop session.
#[derive(Debug, Clone, Default)]
pub struct DesktopSessionOptions {
	/// Opaque display id to select, or `None`, empty, or `all` to use every
	/// display.
	pub display: Option<String>,
}

/// Optional pixel bounds that downscale a capture while preserving its aspect
/// ratio.
#[derive(Debug, Clone, Default)]
pub struct CaptureCaps {
	/// Maximum returned width in pixels, or no width bound when absent.
	pub max_width:  Option<u32>,
	/// Maximum returned height in pixels, or no height bound when absent.
	pub max_height: Option<u32>,
}

/// Optional button, modifier, and routing controls for pointer operations.
#[derive(Debug, Clone, Default)]
pub struct PointerOptions {
	/// Mouse button name; defaults to `left`.
	pub button:        Option<String>,
	/// Click count; defaults to one and treats zero as one.
	pub count:         Option<u32>,
	/// Modifier key names held while delivering the pointer event.
	pub modifiers:     Option<Vec<String>>,
	/// Requested backend delivery mode, defaulting to `background`.
	pub delivery_mode: Option<String>,
}

/// A point in pixels within the most recent screenshot of an operation's
/// target.
#[derive(Debug, Clone, Copy)]
pub struct DesktopPoint {
	/// Horizontal screenshot coordinate in pixels.
	pub x: f64,
	/// Vertical screenshot coordinate in pixels.
	pub y: f64,
}

/// A normalized accessibility element and an ephemeral reference for later
/// operations.
#[derive(Debug, Clone)]
pub struct AxNode {
	/// Session-local ephemeral reference, invalidated as newer snapshots evict
	/// its generation.
	pub ref_:        String,
	/// Cross-platform normalized accessibility role.
	pub role:        String,
	/// Platform accessibility role reported by the backend.
	pub native_role: String,
	/// Element title reported by the backend, when present.
	pub title:       Option<String>,
	/// Element value rendered as text, when present.
	pub value:       Option<String>,
	/// Element description reported by the backend, when present.
	pub description: Option<String>,
	/// Whether the accessibility backend reports the element as enabled.
	pub enabled:     bool,
	/// Whether the accessibility backend reports the element as focused.
	pub focused:     bool,
	/// Left edge in global logical desktop points, when the backend reports
	/// bounds.
	pub x:           Option<f64>,
	/// Top edge in global logical desktop points, when the backend reports
	/// bounds.
	pub y:           Option<f64>,
	/// Width in global logical desktop points, when the backend reports bounds.
	pub width:       Option<f64>,
	/// Height in global logical desktop points, when the backend reports bounds.
	pub height:      Option<f64>,
	/// Backend-supported accessibility action names, omitted when there are
	/// none.
	pub actions:     Option<Vec<String>>,
	/// Number of direct children reported by the accessibility backend.
	pub child_count: u32,
}

/// A text rendering of a window's filtered accessibility tree.
#[derive(Debug, Clone)]
pub struct AxSnapshot {
	/// Indented tree text containing normalized roles, labels, values, and
	/// references.
	pub text:       String,
	/// Number of nodes emitted into `text`, excluding skipped and filtered
	/// nodes.
	pub node_count: u32,
	/// Whether traversal stopped at a configured depth or node limit.
	pub truncated:  bool,
}

/// Traversal and filtering controls for an accessibility snapshot.
#[derive(Debug, Clone, Default)]
pub struct AxSnapshotOptions {
	/// Maximum root-relative traversal depth; defaults to 24.
	pub max_depth: Option<u32>,
	/// Maximum elements visited before truncation; defaults to 800 and treats
	/// zero as one.
	pub max_nodes: Option<u32>,
	/// Whether to retain all readable nodes instead of filtering to useful
	/// structure and controls.
	pub all:       Option<bool>,
}

/// Case-insensitive substring filters for finding accessibility elements in a
/// window.
#[derive(Debug, Clone, Default)]
pub struct AxQuery {
	/// Normalized role substring to match, or any role when absent.
	pub role:  Option<String>,
	/// Title-or-description substring to match, or any label when absent.
	pub title: Option<String>,
	/// Value substring to match, or any value when absent.
	pub value: Option<String>,
	/// Maximum results to return; defaults to 100 and is capped at 5,000.
	pub limit: Option<u32>,
}

/// Capture or input destination within a desktop session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
	/// The composite desktop spanning the session's selected displays.
	Desktop,
	/// A top-level window identified by its backend-defined opaque id.
	Window(String),
}

impl Target {
	/// Parses case-insensitive `desktop` as the whole desktop and anything else
	/// as a window id.
	pub fn parse(value: &str) -> Self {
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

	pub(crate) const fn kind(&self) -> &'static str {
		match self {
			Self::Desktop => "desktop",
			Self::Window(_) => "window",
		}
	}
}

/// Display subset selected when constructing a backend.
#[derive(Debug, Clone)]
pub enum DisplaySelector {
	/// Every display available to the backend.
	All,
	/// One display identified by its backend-defined opaque id.
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
