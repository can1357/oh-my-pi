use std::{
	collections::HashSet,
	ffi::c_void,
	mem,
	process::{Command, Stdio},
	ptr::NonNull,
	sync::LazyLock,
	thread,
	time::{Duration, Instant},
};

use image::{DynamicImage, Rgba, RgbaImage, imageops::FilterType};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use xcap::{Monitor, Window};

use super::{
	super::{
		error::{CoreResult, DesktopError},
		frame::{FrameGeometry, MAX_COMPOSITE_PIXELS},
		types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
	},
	ax,
};
const MAX_LISTED_WINDOWS: usize = 48;
const MIN_WINDOW_EDGE: u32 = 16;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGPreflightScreenCaptureAccess() -> bool;
}

pub(super) fn capture_permission() -> bool {
	// SAFETY: This non-prompting TCC preflight has no arguments and is available
	// on supported macOS versions.
	unsafe { CGPreflightScreenCaptureAccess() }
}

type CreateDisplayInfoFn = unsafe extern "C" fn(display_id: u32) -> *const CFDictionary;

/// `CoreDisplay_DisplayCreateInfoDictionary`, resolved once per process.
static CREATE_DISPLAY_INFO: LazyLock<Option<CreateDisplayInfoFn>> = LazyLock::new(|| {
	let path = c"/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay";
	// SAFETY: `path` is a static NUL-terminated framework path; the handle is
	// intentionally process-lived.
	let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) };
	if handle.is_null() {
		return None;
	}
	// SAFETY: `handle` is a live dlopen handle and the name is NUL-terminated.
	let raw = unsafe { libc::dlsym(handle, c"CoreDisplay_DisplayCreateInfoDictionary".as_ptr()) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: CoreDisplay exports this symbol as
	// `CFDictionaryRef (*)(CGDirectDisplayID)`, which `CreateDisplayInfoFn` spells.
	Some(unsafe { mem::transmute::<*mut c_void, CreateDisplayInfoFn>(raw) })
});

/// The product name the system records for a display, such as "Color LCD".
///
/// xcap's `Monitor::friendly_name` reads `NSScreen.localizedName` instead. The
/// first `NSScreen` call initializes `AppKit`, and `AppKit` registers an
/// unbundled process like omp as a regular application, so every session
/// that listed displays gained a Dock icon until it exited. `CoreDisplay`
/// reads the same display records without `AppKit`.
fn display_product_name(display_id: u32) -> Option<String> {
	let create = (*CREATE_DISPLAY_INFO)?;
	// SAFETY: `create` has the exported signature and accepts any display ID;
	// unknown IDs return NULL.
	let info = NonNull::new(unsafe { create(display_id) }.cast_mut())?;
	// SAFETY: A `Create` function returns a +1 reference, adopted exactly once.
	let info = unsafe { CFRetained::from_raw(info) };
	// SAFETY: The info dictionary is keyed by CFString; values are checked below.
	let info = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(info) };
	let names = info
		.get(&CFString::from_str("DisplayProductName"))?
		.downcast::<CFDictionary>()
		.ok()?;
	// SAFETY: `DisplayProductName` maps locale identifiers to localized names.
	let names = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFString>>(names) };
	// Agents read these names; keep them in one language instead of the
	// session user's locale.
	if let Some(name) = names.get(&CFString::from_str("en_US")) {
		return Some(name.to_string());
	}
	let (_, localized) = names.to_vecs();
	localized.first().map(ToString::to_string)
}

#[derive(Debug, Clone)]
pub(super) struct MacCapture {
	selector: DisplaySelector,
}

impl MacCapture {
	pub(super) const fn new(selector: DisplaySelector) -> Self {
		Self { selector }
	}

	pub(super) fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
		if !capture_permission() {
			return Err(DesktopError::permission_denied(
				"macOS Screen Recording permission is not granted for this process",
			));
		}
		let monitors = Monitor::all().map_err(|error| {
			DesktopError::capture_failed(format!("Quartz monitor enumeration failed: {error}"))
		})?;
		let mut displays = Vec::with_capacity(monitors.len());
		for monitor in monitors {
			let display_id = monitor.id().map_err(metadata_error)?;
			let id = display_id.to_string();
			if matches!(&self.selector, DisplaySelector::Id(selected) if selected != &id) {
				continue;
			}
			let x = monitor.x().map_err(metadata_error)?;
			let y = monitor.y().map_err(metadata_error)?;
			let width = monitor.width().map_err(metadata_error)?;
			let height = monitor.height().map_err(metadata_error)?;
			let scale = f64::from(monitor.scale_factor().map_err(metadata_error)?);
			let name = display_product_name(display_id)
				.or_else(|| monitor.name().ok())
				.unwrap_or_else(|| format!("Display {id}"));
			displays.push(DesktopDisplay {
				id,
				name,
				x,
				y,
				width,
				height,
				scale,
				pixel_x: 0,
				pixel_y: 0,
				pixel_width: scaled_edge(width, scale),
				pixel_height: scaled_edge(height, scale),
				is_primary: monitor.is_primary().map_err(metadata_error)?,
			});
		}
		if displays.is_empty() {
			return Err(match &self.selector {
				DisplaySelector::All => {
					DesktopError::capture_failed("Quartz reported no active displays")
				},
				DisplaySelector::Id(id) => {
					DesktopError::invalid_target(format!("selected display id '{id}' is not active"))
				},
			});
		}
		displays
			.sort_by(|left, right| (left.y, left.x, &left.id).cmp(&(right.y, right.x, &right.id)));
		Ok(displays)
	}

	// Discovery stays on the capture object for backend symmetry; Quartz needs
	// no selector state.
	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		if !capture_permission() {
			return Err(DesktopError::permission_denied(
				"macOS Screen Recording permission is not granted for this process",
			));
		}
		let windows = Window::all().map_err(|error| {
			DesktopError::capture_failed(format!("native window enumeration failed: {error}"))
		})?;
		let mut result = Vec::new();
		let mut seen = HashSet::new();
		// The active application's listed windows, front to back.
		let mut active = Vec::new();
		let mut active_pid = None;
		for window in windows {
			if result.len() >= MAX_LISTED_WINDOWS {
				break;
			}
			let Ok(id) = window.id() else { continue };
			if !seen.insert(id) || window.is_minimized().unwrap_or(true) {
				continue;
			}
			let (Ok(x), Ok(y), Ok(width), Ok(height)) =
				(window.x(), window.y(), window.width(), window.height())
			else {
				continue;
			};
			if width < MIN_WINDOW_EDGE || height < MIN_WINDOW_EDGE {
				continue;
			}
			let title = window.title().unwrap_or_default();
			let app = window.app_name().unwrap_or_default();
			if title.is_empty() && app.is_empty() {
				continue;
			}
			let pid = window.pid().ok();
			// xcap's `is_focused` only says the owner is the active application.
			if window.is_focused().unwrap_or(false) {
				active.push(id);
				active_pid = active_pid.or(pid);
			}
			result.push(DesktopWindow {
				id: id.to_string(),
				title,
				app,
				pid,
				x,
				y,
				width,
				height,
				focused: false,
			});
		}
		let ax_focused = active_pid
			.and_then(|pid| libc::pid_t::try_from(pid).ok())
			.and_then(ax::focused_window_id);
		if let Some(key) = key_window(&active, ax_focused).map(|id| id.to_string())
			&& let Some(window) = result.iter_mut().find(|window| window.id == key)
		{
			window.focused = true;
		}
		Ok(result)
	}

	pub(super) fn window(&self, id: &str) -> CoreResult<DesktopWindow> {
		self
			.windows()?
			.into_iter()
			.find(|window| window.id == id)
			.ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"window '{id}' was not found; it may be closed or minimized"
				))
			})
	}

	pub(super) fn capture(&self, target: &Target) -> CoreResult<(RgbaImage, FrameGeometry)> {
		match target {
			Target::Desktop => self.capture_displays(),
			Target::Window(id) => self.capture_window(id),
		}
	}

	fn capture_window(&self, id: &str) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let window = self.window(id)?;
		let window_id = id
			.parse::<u32>()
			.map_err(|_| DesktopError::invalid_target(format!("invalid macOS window id '{id}'")))?;
		let image = run_screencapture(&[
			"-x".to_string(),
			"-o".to_string(),
			"-l".to_string(),
			window_id.to_string(),
		])?;
		if image.width() == 0 || image.height() == 0 {
			return Err(DesktopError::capture_failed(format!(
				"capture of window '{id}' returned an empty image"
			)));
		}
		let geometry = FrameGeometry::for_window(&window, image.width(), image.height());
		Ok((image, geometry))
	}

	fn capture_displays(&self) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let displays = self.displays()?;
		let mut regions = Vec::with_capacity(displays.len());
		let mut render_scale = 1.0f64;
		for display in displays {
			let rect = format!("-R{},{},{},{}", display.x, display.y, display.width, display.height);
			let image = run_screencapture(&["-x".to_string(), rect])?;
			if image.width() == 0 || image.height() == 0 {
				return Err(DesktopError::capture_failed(format!(
					"capture of display '{}' returned an empty image",
					display.id
				)));
			}
			render_scale = render_scale
				.max(f64::from(image.width()) / f64::from(display.width))
				.max(f64::from(image.height()) / f64::from(display.height));
			regions.push((display, image));
		}
		let min_x = regions
			.iter()
			.map(|(display, _)| i64::from(display.x))
			.min()
			.unwrap_or(0);
		let min_y = regions
			.iter()
			.map(|(display, _)| i64::from(display.y))
			.min()
			.unwrap_or(0);
		let max_x = regions
			.iter()
			.map(|(display, _)| i64::from(display.x) + i64::from(display.width))
			.max()
			.unwrap_or(0);
		let max_y = regions
			.iter()
			.map(|(display, _)| i64::from(display.y) + i64::from(display.height))
			.max()
			.unwrap_or(0);
		let logical_width = u32::try_from(max_x - min_x)
			.map_err(|_| DesktopError::capture_failed("desktop logical width overflow"))?;
		let logical_height = u32::try_from(max_y - min_y)
			.map_err(|_| DesktopError::capture_failed("desktop logical height overflow"))?;
		let target_width = scaled_edge(logical_width, render_scale).max(1);
		let target_height = scaled_edge(logical_height, render_scale).max(1);
		if u64::from(target_width) * u64::from(target_height) > MAX_COMPOSITE_PIXELS {
			return Err(DesktopError::capture_failed(format!(
				"composite {target_width}x{target_height} exceeds the native safety limit",
			)));
		}
		let mut composite = RgbaImage::from_pixel(target_width, target_height, Rgba([0, 0, 0, 255]));
		let mut metadata = Vec::with_capacity(regions.len());
		for (mut display, image) in regions {
			let offset_x = u32::try_from(i64::from(display.x) - min_x)
				.map_err(|_| DesktopError::capture_failed("display x offset overflow"))?;
			let offset_y = u32::try_from(i64::from(display.y) - min_y)
				.map_err(|_| DesktopError::capture_failed("display y offset overflow"))?;
			display.pixel_x = scaled_edge(offset_x, render_scale);
			display.pixel_y = scaled_edge(offset_y, render_scale);
			display.pixel_width = scaled_edge(display.width, render_scale).max(1);
			display.pixel_height = scaled_edge(display.height, render_scale).max(1);
			let rendered =
				if image.width() == display.pixel_width && image.height() == display.pixel_height {
					image
				} else {
					image::imageops::resize(
						&image,
						display.pixel_width,
						display.pixel_height,
						FilterType::Triangle,
					)
				};
			image::imageops::replace(
				&mut composite,
				&rendered,
				i64::from(display.pixel_x),
				i64::from(display.pixel_y),
			);
			metadata.push(display);
		}
		let geometry = FrameGeometry::for_displays(&metadata);
		Ok((composite, geometry))
	}
}

fn metadata_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::capture_failed(format!("failed to read native display metadata: {error}"))
}

fn scaled_edge(value: u32, scale: f64) -> u32 {
	(f64::from(value) * scale)
		.round()
		.clamp(0.0, f64::from(u32::MAX)) as u32
}

/// The window holding input focus among the active application's listed
/// windows (front to back): its `AXFocusedWindow`, or the frontmost when
/// accessibility cannot name one (for example without the Accessibility
/// permission). A focused window that was not listed marks nothing.
fn key_window(active: &[u32], ax_focused: Option<u32>) -> Option<u32> {
	match ax_focused {
		Some(id) => active.contains(&id).then_some(id),
		None => active.first().copied(),
	}
}

fn run_screencapture(args: &[String]) -> CoreResult<RgbaImage> {
	let file = tempfile::Builder::new()
		.prefix("omp-computer-")
		.suffix(".png")
		.tempfile()
		.map_err(|error| {
			DesktopError::capture_failed(format!(
				"failed to create temporary screenshot file: {error}"
			))
		})?;
	let mut child = Command::new("/usr/sbin/screencapture")
		.args(args)
		.arg(file.path())
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|error| {
			DesktopError::capture_failed(format!("failed to start macOS screen capture: {error}"))
		})?;
	let deadline = Instant::now() + CAPTURE_TIMEOUT;
	let status = loop {
		match child.try_wait() {
			Ok(Some(status)) => break status,
			Ok(None) => {},
			Err(error) => {
				let _ = child.kill();
				let _ = child.wait();
				return Err(DesktopError::capture_failed(format!(
					"failed while waiting for macOS screen capture: {error}"
				)));
			},
		}
		if Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			return Err(DesktopError::capture_failed(
				"macOS screen capture exceeded its five-second deadline",
			));
		}
		thread::sleep(Duration::from_millis(10));
	};
	if !status.success() {
		return Err(if capture_permission() {
			DesktopError::capture_failed(format!("macOS screen capture exited with {status}"))
		} else {
			DesktopError::permission_denied(
				"macOS Screen Recording permission is not granted for this process",
			)
		});
	}
	image::open(file.path())
		.map_err(|error| {
			DesktopError::capture_failed(format!("failed to decode macOS screenshot: {error}"))
		})
		.map(DynamicImage::into_rgba8)
}

#[cfg(test)]
mod tests {
	use super::key_window;

	#[test]
	fn key_window_is_the_accessibility_focused_window_not_the_frontmost() {
		assert_eq!(key_window(&[41, 42, 43], Some(42)), Some(42));
	}

	#[test]
	fn key_window_falls_back_to_the_frontmost_window_without_accessibility() {
		assert_eq!(key_window(&[41, 42], None), Some(41));
		assert_eq!(key_window(&[], None), None);
	}

	#[test]
	fn key_window_marks_nothing_when_the_focused_window_is_not_listed() {
		assert_eq!(key_window(&[41, 42], Some(99)), None);
	}
}
