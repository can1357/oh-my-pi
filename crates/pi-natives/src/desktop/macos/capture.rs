mod screen_capture_kit;

use std::ptr;

use image::{Rgba, RgbaImage, imageops::FilterType};
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{
	CFArray, CFBoolean, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CFType, CGPoint,
	CGRect, CGSize,
};
use objc2_core_graphics::{
	CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
	kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
	kCGWindowOwnerName, kCGWindowOwnerPID, kCGWindowSharingState,
};
use screen_capture_kit::{CaptureRequest, CaptureTarget};
use xcap::Monitor;

use super::{
	super::{
		error::{CoreResult, DesktopError},
		frame::{FrameGeometry, MAX_COMPOSITE_PIXELS, compose},
		types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
	},
	ax,
};

const MAX_LISTED_WINDOWS: usize = 48;
const MIN_WINDOW_EDGE: u32 = 16;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGPreflightScreenCaptureAccess() -> bool;
}

pub(super) fn capture_permission() -> bool {
	// SAFETY: This non-prompting TCC preflight has no arguments and is available
	// on supported macOS versions.
	unsafe { CGPreflightScreenCaptureAccess() }
}

pub(super) fn capture_available() -> bool {
	screen_capture_kit::available()
}

#[derive(Debug, Clone)]
pub(super) struct MacCapture {
	selector: DisplaySelector,
}

impl MacCapture {
	pub(super) const fn new(selector: DisplaySelector) -> Self {
		Self { selector }
	}

	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
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
			let id = monitor.id().map_err(metadata_error)?.to_string();
			let x = monitor.x().map_err(metadata_error)?;
			let y = monitor.y().map_err(metadata_error)?;
			let width = monitor.width().map_err(metadata_error)?;
			let height = monitor.height().map_err(metadata_error)?;
			let scale = f64::from(monitor.scale_factor().map_err(metadata_error)?);
			// xcap's macOS friendly_name path matches CGDirectDisplayID to
			// NSScreenNumber, then returns NSScreen.localizedName(). Keep the
			// model-number name as fallback.
			let name = monitor
				.friendly_name()
				.or_else(|_| monitor.name())
				.unwrap_or_else(|_| format!("Display {id}"));
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
			return Err(DesktopError::capture_failed("Quartz reported no active displays"));
		}
		displays
			.sort_by(|left, right| (left.y, left.x, &left.id).cmp(&(right.y, right.x, &right.id)));
		Ok(displays)
	}

	// Discovery stays on the capture object for backend symmetry; Quartz needs
	// no selector state.
	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		window_snapshot(None)
	}

	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn window(&self, id: &str) -> CoreResult<DesktopWindow> {
		window_by_id(id)
	}

	pub(super) fn capture(
		&self,
		target: &Target,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		match target {
			Target::Desktop | Target::Display(_) => {
				let explicit = target.display_selector();
				self.capture_displays(selector.or(explicit.as_ref()).unwrap_or(&self.selector))
			},
			Target::Window(id) => self.capture_window(id),
		}
	}

	fn capture_window(&self, id: &str) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let mut window = self.window(id)?;
		let window_id = id
			.parse::<u32>()
			.map_err(|_| DesktopError::invalid_target(format!("invalid macOS window id '{id}'")))?;
		let capture = screen_capture_kit::capture(vec![CaptureRequest {
			target: CaptureTarget::Window(window_id),
			bounds: capture_bounds(window.x, window.y, window.width, window.height),
		}])?
		.pop()
		.ok_or_else(|| DesktopError::capture_failed("native window capture returned no image"))?;
		(window.x, window.y, window.width, window.height) = logical_bounds(capture.bounds)?;
		let geometry =
			FrameGeometry::for_window(&window, capture.image.width(), capture.image.height());
		Ok((capture.image, geometry))
	}

	fn capture_displays(
		&self,
		selector: &DisplaySelector,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let focused = if matches!(selector, DisplaySelector::Active) {
			self.windows()?.into_iter().find(|window| window.focused)
		} else {
			None
		};
		let displays = selector.select(self.displays()?, focused.as_ref())?;
		let requests = displays
			.iter()
			.map(|display| {
				let id = display
					.id
					.parse::<u32>()
					.map_err(|_| DesktopError::invalid_target("invalid macOS display id"))?;
				Ok(CaptureRequest {
					target: CaptureTarget::Display(id),
					bounds: capture_bounds(display.x, display.y, display.width, display.height),
				})
			})
			.collect::<CoreResult<Vec<_>>>()?;
		let captures = screen_capture_kit::capture(requests)?;
		let mut regions = Vec::with_capacity(displays.len());
		let mut render_scale = 1.0f64;
		for (mut display, capture) in displays.into_iter().zip(captures) {
			(display.x, display.y, display.width, display.height) = logical_bounds(capture.bounds)?;
			let image = capture.image;
			display.pixel_width = image.width();
			display.pixel_height = image.height();
			display.scale = (f64::from(image.width()) / f64::from(display.width))
				.max(f64::from(image.height()) / f64::from(display.height));
			render_scale = render_scale.max(display.scale);
			regions.push((display, image));
		}
		if regions.len() == 1 {
			let (display, image) = regions.pop().ok_or_else(|| {
				DesktopError::capture_failed("native display capture returned no image")
			})?;
			let geometry = FrameGeometry::for_displays(std::slice::from_ref(&display));
			return Ok((image, geometry));
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
		let mut metadata = Vec::with_capacity(regions.len());
		let composite = compose(
			target_width,
			target_height,
			Rgba([0, 0, 0, 255]),
			regions.into_iter().map(|(mut display, image)| {
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
				let placement = (rendered, display.pixel_x, display.pixel_y);
				metadata.push(display);
				Ok(placement)
			}),
		)?;
		let geometry = FrameGeometry::for_displays(&metadata);
		Ok((composite, geometry))
	}
}

/// Window `id` as the window list reports it.
pub(super) fn window_by_id(id: &str) -> CoreResult<DesktopWindow> {
	let missing = || {
		DesktopError::window_not_found(format!(
			"window '{id}' was not found; it may be closed or minimized"
		))
	};
	let id = id.parse::<u32>().map_err(|_| missing())?;
	window_snapshot(Some(id))?
		.into_iter()
		.next()
		.ok_or_else(missing)
}

type WindowDictionary = CFDictionary<CFString, CFType>;

/// Reads each window from one immutable Quartz snapshot; individual xcap
/// property getters would re-enumerate the whole desktop for every field.
fn window_snapshot(target: Option<u32>) -> CoreResult<Vec<DesktopWindow>> {
	if !capture_permission() {
		return Err(DesktopError::permission_denied(
			"macOS Screen Recording permission is not granted for this process",
		));
	}
	let options = if target.is_some() {
		CGWindowListOption::OptionIncludingWindow
	} else {
		CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements
	};
	let snapshot = CGWindowListCopyWindowInfo(options, target.unwrap_or(0))
		.ok_or_else(|| DesktopError::capture_failed("Quartz window enumeration failed"))?;
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	let active_pid = NSWorkspace::sharedWorkspace()
		.frontmostApplication()
		.and_then(|app| u32::try_from(app.processIdentifier()).ok());
	let mut result = Vec::with_capacity(snapshot.len().min(MAX_LISTED_WINDOWS));
	let mut active = Vec::new();
	// SAFETY: This copy-rule snapshot remains alive and is never mutated.
	for dictionary in unsafe { snapshot.iter_unchecked() } {
		if result.len() == MAX_LISTED_WINDOWS {
			break;
		}
		let Some((id, window)) = window_metadata(dictionary) else {
			continue;
		};
		if window.pid.is_some() && window.pid == active_pid {
			active.push(id);
		}
		result.push(window);
	}
	let focused = active_pid
		.and_then(|pid| libc::pid_t::try_from(pid).ok())
		.and_then(ax::focused_window_id);
	// A targeted snapshot cannot infer front-to-back ordering of sibling
	// windows when AX cannot identify the application's focused window.
	let focused = if target.is_some() {
		focused
	} else {
		key_window(&active, focused)
	};
	if let Some(focused) = focused {
		let id = focused.to_string();
		if let Some(window) = result.iter_mut().find(|window| window.id == id) {
			window.focused = true;
		}
	}
	Ok(result)
}

/// `kCGPopUpMenuWindowLevel`, the window level of open menus, context menus
/// included.
const POP_UP_MENU_LAYER: i64 = 101;

/// Ids of the on-screen menu windows `pid` shows, such as an open context
/// menu, or `None` when the window list cannot be read. Owner and level need
/// no Screen Recording permission.
pub(super) fn menu_windows(pid: libc::pid_t) -> Option<Vec<u32>> {
	let snapshot = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, 0)?;
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	let mut menus = Vec::new();
	// SAFETY: This copy-rule snapshot remains alive and is never mutated.
	for dictionary in unsafe { snapshot.iter_unchecked() } {
		// SAFETY: The CoreGraphics key constants are process-lived.
		let (owner, layer, id) = unsafe {
			(
				window_number(dictionary, kCGWindowOwnerPID),
				window_number(dictionary, kCGWindowLayer),
				window_number(dictionary, kCGWindowNumber),
			)
		};
		if owner == Some(i64::from(pid))
			&& layer == Some(POP_UP_MENU_LAYER)
			&& let Some(id) = id.and_then(|id| u32::try_from(id).ok())
		{
			menus.push(id);
		}
	}
	Some(menus)
}

/// Frame of on-screen window `id` in global points, or `None` once it is gone.
/// Bounds need no Screen Recording permission.
pub(super) fn window_frame(id: u32) -> Option<CGRect> {
	let snapshot = CGWindowListCopyWindowInfo(CGWindowListOption::OptionIncludingWindow, id)?;
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	// SAFETY: This copy-rule snapshot remains alive and is never mutated.
	let dictionary = unsafe { snapshot.iter_unchecked() }.next()?;
	// SAFETY: The CoreGraphics key constants are process-lived. Typed
	// downcasts reject absent or malformed window metadata.
	unsafe {
		if window_number(dictionary, kCGWindowNumber)? != i64::from(id) {
			return None;
		}
		let bounds = window_value(dictionary, kCGWindowBounds)?.downcast_ref::<CFDictionary>()?;
		let mut rect = CGRect::default();
		CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect).then_some(rect)
	}
}

fn window_value<'a>(dictionary: &'a WindowDictionary, key: &CFString) -> Option<&'a CFType> {
	// SAFETY: All callers borrow an immutable copy-rule Quartz snapshot.
	unsafe { dictionary.get_unchecked(key) }
}

fn window_number(dictionary: &WindowDictionary, key: &CFString) -> Option<i64> {
	let number = window_value(dictionary, key)?.downcast_ref::<CFNumber>()?;
	let mut value = 0i64;
	// SAFETY: The output is writable storage for the requested signed 64-bit
	// type.
	unsafe { number.value(CFNumberType::SInt64Type, ptr::from_mut(&mut value).cast()) }
		.then_some(value)
}

fn window_string(dictionary: &WindowDictionary, key: &CFString) -> String {
	window_value(dictionary, key)
		.and_then(CFType::downcast_ref::<CFString>)
		.map_or_default(ToString::to_string)
}

fn window_metadata(dictionary: &WindowDictionary) -> Option<(u32, DesktopWindow)> {
	// SAFETY: The CoreGraphics key constants are process-lived. Typed
	// downcasts below reject absent or malformed window metadata.
	unsafe {
		let onscreen = window_value(dictionary, kCGWindowIsOnscreen)?
			.downcast_ref::<CFBoolean>()?
			.value();
		if !onscreen || window_number(dictionary, kCGWindowSharingState)? == 0 {
			return None;
		}
		let id = u32::try_from(window_number(dictionary, kCGWindowNumber)?).ok()?;
		let bounds = window_value(dictionary, kCGWindowBounds)?.downcast_ref::<CFDictionary>()?;
		let mut rect = CGRect::default();
		if !CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect) {
			return None;
		}
		let (x, y, width, height) = logical_bounds(rect).ok()?;
		if width < MIN_WINDOW_EDGE || height < MIN_WINDOW_EDGE {
			return None;
		}
		let title = window_string(dictionary, kCGWindowName);
		let app = window_string(dictionary, kCGWindowOwnerName);
		if (title.is_empty() && app.is_empty())
			|| (title == "StatusIndicator" && app == "Window Server")
		{
			return None;
		}
		let pid =
			window_number(dictionary, kCGWindowOwnerPID).and_then(|pid| u32::try_from(pid).ok());
		Some((id, DesktopWindow {
			id: id.to_string(),
			title,
			app,
			pid,
			x,
			y,
			width,
			height,
			focused: false,
		}))
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

fn capture_bounds(x: i32, y: i32, width: u32, height: u32) -> CGRect {
	CGRect::new(
		CGPoint::new(f64::from(x), f64::from(y)),
		CGSize::new(f64::from(width), f64::from(height)),
	)
}

fn logical_bounds(bounds: CGRect) -> CoreResult<(i32, i32, u32, u32)> {
	let x = bounds.origin.x.round();
	let y = bounds.origin.y.round();
	let width = bounds.size.width.round();
	let height = bounds.size.height.round();
	if !x.is_finite()
		|| !y.is_finite()
		|| !width.is_finite()
		|| !height.is_finite()
		|| x < f64::from(i32::MIN)
		|| x > f64::from(i32::MAX)
		|| y < f64::from(i32::MIN)
		|| y > f64::from(i32::MAX)
		|| width < 1.0
		|| width > f64::from(u32::MAX)
		|| height < 1.0
		|| height > f64::from(u32::MAX)
	{
		return Err(DesktopError::capture_failed("native capture returned invalid logical bounds"));
	}
	Ok((x as i32, y as i32, width as u32, height as u32))
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
