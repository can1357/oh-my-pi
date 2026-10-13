mod screen_capture_kit;

use std::{
	collections::HashMap,
	ffi::c_void,
	mem,
	ptr::{self, NonNull},
	sync::LazyLock,
};

use image::{Rgba, RgbaImage, imageops::FilterType};
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{
	CFArray, CFBoolean, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CFType, CGPoint,
	CGRect, CGSize,
};
use objc2_core_graphics::{
	CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayIsMain, CGDisplayMode, CGDisplayModelNumber,
	CGError, CGGetActiveDisplayList, CGRectMakeWithDictionaryRepresentation,
	CGWindowListCopyWindowInfo, CGWindowListOption, kCGWindowBounds, kCGWindowIsOnscreen,
	kCGWindowLayer, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
	kCGWindowSharingState,
};
use screen_capture_kit::{CaptureRequest, CaptureTarget};

use super::{
	super::{
		error::{CoreResult, DesktopError},
		frame::{FrameGeometry, MAX_COMPOSITE_PIXELS, compose},
		types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
	},
	ax, permission,
};

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

fn require_capture_permission() -> CoreResult<()> {
	capture_permission().ok_or_else(|| permission::denied(permission::screen_recording_pane()))
}

pub(super) fn capture_available() -> bool {
	screen_capture_kit::available()
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
	// `CFDictionaryRef (*)(CGDirectDisplayID)`, which `CreateDisplayInfoFn`
	// spells.
	Some(unsafe { mem::transmute::<*mut c_void, CreateDisplayInfoFn>(raw) })
});

/// The product name the system records for a display, such as "Color LCD".
///
/// `NSScreen.localizedName` could provide a friendly name instead, but the
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
	// SAFETY: The info dictionary is keyed by CFString; values are checked
	// below.
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

	pub(super) const fn selector(&self) -> &DisplaySelector {
		&self.selector
	}

	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
		require_capture_permission()?;
		// Keep the existing 16-display snapshot limit. One call avoids a
		// count/fill race when monitors are connected or disconnected.
		let mut active_displays = [0; 16];
		let mut display_count = 0;
		// SAFETY: The output array holds `max_displays` display IDs and the
		// count points to a live u32 for the duration of this synchronous call.
		let error = unsafe {
			CGGetActiveDisplayList(
				active_displays.len() as u32,
				active_displays.as_mut_ptr(),
				&mut display_count,
			)
		};
		if error != CGError::Success {
			return Err(DesktopError::capture_failed(format!(
				"Quartz monitor enumeration failed: CGGetActiveDisplayList failed: {error:?}"
			)));
		}
		let mut displays = Vec::with_capacity(display_count as usize);
		for &display_id in &active_displays[..display_count as usize] {
			let id = display_id.to_string();
			let bounds = CGDisplayBounds(display_id);
			let x = bounds.origin.x as i32;
			let y = bounds.origin.y as i32;
			let width = bounds.size.width as u32;
			let height = bounds.size.height as u32;
			let mode = CGDisplayCopyDisplayMode(display_id);
			// Preserve the previous f32 scale calculation and nullable mode
			// handling if a display disappears after enumeration.
			let scale = f64::from(CGDisplayMode::pixel_width(mode.as_deref()) as f32 / width as f32);
			let name = display_product_name(display_id)
				.unwrap_or_else(|| format!("Display #{}", CGDisplayModelNumber(display_id)));
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
				is_primary: CGDisplayIsMain(display_id),
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
		window_snapshot(None, None)
	}

	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn window(&self, id: &str) -> CoreResult<DesktopWindow> {
		window_by_id(id)
	}

	/// `pid`'s on-screen normal-layer windows, front to back.
	#[allow(clippy::unused_self, reason = "keeps discovery on the backend capture object")]
	pub(super) fn windows_of(&self, pid: libc::pid_t) -> CoreResult<Vec<DesktopWindow>> {
		let owner = u32::try_from(pid).map_err(|_| {
			DesktopError::input_failed(format!("process id {pid} cannot own a window"))
		})?;
		window_snapshot(None, Some(owner))
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
		require_capture_permission()?;
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

/// The windows `pid` has on screen at the normal window layer, front to back,
/// as `windows()` lists them; its status items and other system-layer
/// surfaces are left out.
pub(in crate::desktop) fn application_windows(pid: u32) -> CoreResult<Vec<DesktopWindow>> {
	window_snapshot(None, Some(pid))
}

/// Window `id` as the window list reports it.
pub(super) fn window_by_id(id: &str) -> CoreResult<DesktopWindow> {
	let missing = || {
		DesktopError::window_not_found(format!(
			"window '{id}' was not found; it may be closed or minimized"
		))
	};
	let id = id.parse::<u32>().map_err(|_| missing())?;
	window_snapshot(Some(id), None)?
		.into_iter()
		.next()
		.ok_or_else(missing)
}

type WindowDictionary = CFDictionary<CFString, CFType>;

/// Reads each window from one immutable Quartz snapshot; individual xcap
/// property getters would re-enumerate the whole desktop for every field.
/// Window metadata needs no Screen Recording permission; without it, macOS
/// leaves other applications' window titles empty and reports their sharing
/// state as none, so that state filters windows only when capture is granted.
fn window_snapshot(target: Option<u32>, owner: Option<u32>) -> CoreResult<Vec<DesktopWindow>> {
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
	let capture_granted = capture_permission();
	let mut result = Vec::with_capacity(snapshot.len());
	let mut active = Vec::new();
	// SAFETY: This copy-rule snapshot remains alive and is never mutated.
	for dictionary in unsafe { snapshot.iter_unchecked() } {
		if !shared(dictionary, capture_granted) {
			continue;
		}
		let Some((id, window)) = window_metadata(dictionary) else {
			continue;
		};
		if owner.is_some() && window.pid != owner {
			continue;
		}
		// SAFETY: The CoreGraphics key constant is process-lived.
		if owner.is_some() && window_number(dictionary, unsafe { kCGWindowLayer }) != Some(0) {
			continue;
		}
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

/// Whether `pid` owns an on-screen window in the normal window layer, from
/// Quartz's window list; owner and layer need no Screen Recording permission.
/// `None` when the list cannot be read.
pub(in crate::desktop) fn has_onscreen_window(pid: libc::pid_t) -> Option<bool> {
	let snapshot = CGWindowListCopyWindowInfo(
		CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
		0,
	)?;
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	let pid = i64::from(pid);
	// SAFETY: This copy-rule snapshot remains alive and is never mutated; the
	// CoreGraphics key constants are process-lived.
	Some(unsafe { snapshot.iter_unchecked() }.any(|dictionary| unsafe {
		window_number(dictionary, kCGWindowOwnerPID) == Some(pid)
			&& window_number(dictionary, kCGWindowLayer) == Some(0)
	}))
}

/// `pid`'s normal-layer window ids, on screen or not: windows on other Spaces,
/// minimized ones and ones the application keeps ordered out. `None` when the
/// list cannot be read.
pub(in crate::desktop) fn normal_window_ids(pid: libc::pid_t) -> Option<Vec<u32>> {
	normal_windows(Some(pid), |id, _| id)
}

/// Titles of normal-layer windows across all Spaces, including hidden and
/// minimized windows, so becoming visible is not mistaken for creation.
pub(in crate::desktop) fn window_titles() -> Option<HashMap<String, String>> {
	normal_windows(None, |id, dictionary| {
		// SAFETY: The CoreGraphics key constant is process-lived.
		(id.to_string(), window_string(dictionary, unsafe { kCGWindowName }))
	})
}

/// Reads the normal-layer snapshot once, optionally restricted to an owner.
/// Both the identity and title views share the same filtering and checked ids.
fn normal_windows<T, C: FromIterator<T>>(
	owner: Option<libc::pid_t>,
	mut read: impl FnMut(u32, &WindowDictionary) -> T,
) -> Option<C> {
	let snapshot = CGWindowListCopyWindowInfo(CGWindowListOption::OptionAll, 0)?;
	// SAFETY: CoreGraphics returns an immutable array of dictionaries whose
	// documented window keys are CFStrings and whose values are CFTypes.
	let snapshot = unsafe { CFRetained::cast_unchecked::<CFArray<WindowDictionary>>(snapshot) };
	// SAFETY: This copy-rule snapshot remains alive and is never mutated;
	// the CoreGraphics key constants are process-lived.
	Some(
		unsafe { snapshot.iter_unchecked() }
			.filter_map(|dictionary| unsafe {
				if window_number(dictionary, kCGWindowLayer) != Some(0)
					|| owner.is_some_and(|pid| {
						window_number(dictionary, kCGWindowOwnerPID) != Some(i64::from(pid))
					}) {
					return None;
				}
				let id = u32::try_from(window_number(dictionary, kCGWindowNumber)?).ok()?;
				Some(read(id, dictionary))
			})
			.collect(),
	)
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

/// Whether capture sees the record. Without Screen Recording permission,
/// macOS reports every window's sharing state as none, so the state leaves
/// windows out only once capture is granted.
fn shared(dictionary: &WindowDictionary, capture_granted: bool) -> bool {
	// SAFETY: The CoreGraphics key constant is process-lived.
	let sharing = window_number(dictionary, unsafe { kCGWindowSharingState });
	!(capture_granted && matches!(sharing, None | Some(0)))
}

/// Whether `listWindows` reports the record, whose `title` and `app` the
/// caller has read already: the window roster marks its rows with this.
pub(super) fn listed(
	dictionary: &WindowDictionary,
	capture_granted: bool,
	title: &str,
	app: &str,
) -> bool {
	shared(dictionary, capture_granted) && listable(dictionary).is_some() && named(title, app)
}

/// The id and logical bounds of an on-screen record at least
/// [`MIN_WINDOW_EDGE`] on each side.
fn listable(dictionary: &WindowDictionary) -> Option<(u32, (i32, i32, u32, u32))> {
	// SAFETY: The CoreGraphics key constants are process-lived. Typed
	// downcasts below reject absent or malformed window metadata.
	unsafe {
		let onscreen = window_value(dictionary, kCGWindowIsOnscreen)?
			.downcast_ref::<CFBoolean>()?
			.value();
		if !onscreen {
			return None;
		}
		let id = u32::try_from(window_number(dictionary, kCGWindowNumber)?).ok()?;
		let bounds = window_value(dictionary, kCGWindowBounds)?.downcast_ref::<CFDictionary>()?;
		let mut rect = CGRect::default();
		if !CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect) {
			return None;
		}
		let logical = logical_bounds(rect).ok()?;
		(logical.2 >= MIN_WINDOW_EDGE && logical.3 >= MIN_WINDOW_EDGE).then_some((id, logical))
	}
}

/// Whether the record has a name to list it by, other than the window
/// server's status indicator.
fn named(title: &str, app: &str) -> bool {
	!((title.is_empty() && app.is_empty()) || (title == "StatusIndicator" && app == "Window Server"))
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
	let (id, (x, y, width, height)) = listable(dictionary)?;
	// SAFETY: The CoreGraphics key constants are process-lived.
	let (title, app, pid) = unsafe {
		(
			window_string(dictionary, kCGWindowName),
			window_string(dictionary, kCGWindowOwnerName),
			window_number(dictionary, kCGWindowOwnerPID),
		)
	};
	if !named(&title, &app) {
		return None;
	}
	Some((id, DesktopWindow {
		id: id.to_string(),
		title,
		app,
		pid: pid.and_then(|pid| u32::try_from(pid).ok()),
		x,
		y,
		width,
		height,
		focused: false,
	}))
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
	use objc2_core_foundation::{
		CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize,
	};
	use objc2_core_graphics::{
		CGRectCreateDictionaryRepresentation, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowName,
		kCGWindowNumber, kCGWindowOwnerName, kCGWindowSharingState,
	};

	use super::{WindowDictionary, key_window, listed, shared, window_metadata};

	struct Record {
		onscreen: bool,
		size:     f64,
		sharing:  Option<i64>,
		title:    &'static str,
		app:      &'static str,
	}

	const ORDINARY: Record = Record {
		onscreen: true,
		size:     200.0,
		sharing:  Some(1),
		title:    "Notes",
		app:      "TextEdit",
	};

	fn dictionary(record: &Record) -> CFRetained<WindowDictionary> {
		let bounds = CGRectCreateDictionaryRepresentation(CGRect::new(
			CGPoint::new(10.0, 20.0),
			CGSize::new(record.size, record.size),
		));
		let number = CFNumber::new_i64(41);
		let sharing = record.sharing.map(CFNumber::new_i64);
		let title = CFString::from_str(record.title);
		let app = CFString::from_str(record.app);
		// SAFETY: The CoreGraphics key constants are process-lived.
		let mut keys: Vec<&CFString> = unsafe {
			vec![
				kCGWindowIsOnscreen,
				kCGWindowNumber,
				kCGWindowBounds,
				kCGWindowName,
				kCGWindowOwnerName,
			]
		};
		let mut values: Vec<&CFType> =
			vec![CFBoolean::new(record.onscreen), &number, &bounds, &title, &app];
		if let Some(sharing) = &sharing {
			// SAFETY: As above.
			keys.push(unsafe { kCGWindowSharingState });
			values.push(sharing);
		}
		CFDictionary::from_slices(&keys, &values)
	}

	/// The roster's `listed` must be exactly the capture snapshot's own rule, so
	/// `listWindows` and `computer.window(id)` find every window the roster
	/// marks listed and no other.
	#[test]
	fn listed_is_the_capture_snapshot_rule() {
		let records = [
			ORDINARY,
			Record { sharing: Some(0), ..ORDINARY },
			Record { sharing: None, ..ORDINARY },
			Record { onscreen: false, ..ORDINARY },
			Record { size: 10.0, ..ORDINARY },
			Record { title: "", app: "", ..ORDINARY },
			Record { title: "StatusIndicator", app: "Window Server", ..ORDINARY },
		];
		let expected = [
			// capture granted, not granted
			(true, true),
			(false, true),
			(false, true),
			(false, false),
			(false, false),
			(false, false),
			(false, false),
		];
		for (record, (granted, ungranted)) in records.iter().zip(expected) {
			let dictionary = dictionary(record);
			for (capture_granted, want) in [(true, granted), (false, ungranted)] {
				let captured =
					shared(&dictionary, capture_granted) && window_metadata(&dictionary).is_some();
				assert_eq!(captured, want, "capture rule, granted={capture_granted}, {}", record.title);
				assert_eq!(
					listed(&dictionary, capture_granted, record.title, record.app),
					captured,
					"roster rule, granted={capture_granted}, {}",
					record.title,
				);
			}
		}
	}

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
