use std::{
	collections::HashSet,
	ffi::c_void,
	mem,
	ptr::{self, NonNull},
	sync::{LazyLock, Mutex},
	thread,
	time::Duration,
};

use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
	CFArray, CFBoolean, CFRange, CFRetained, CFString, CFType, CGPoint, CGSize, Type,
};

use super::super::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_macos},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

use super::{process, skylight};

const AX_TIMEOUT_SECONDS: f32 = 2.0;
/// Messaging timeout for the focus and hit-test probes made around input
/// delivery, so a hung application cannot stall the action itself.
const PROBE_TIMEOUT_SECONDS: f32 = 0.5;
/// Bounded `AXParent` ascent when an element does not expose `AXWindow`.
const MAX_ANCESTRY_DEPTH: usize = 40;

type GetWindowIdFn = unsafe extern "C" fn(&AXUIElement, *mut u32) -> AXError;

static GET_WINDOW_ID: LazyLock<Option<GetWindowIdFn>> = LazyLock::new(|| {
	// SAFETY: The symbol name is a static NUL-terminated string for process-wide
	// lookup.
	let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
	if symbol.is_null() {
		None
	} else {
		// SAFETY: `_AXUIElementGetWindow` has the exact AXUIElementRef,
		// CGWindowID* -> AXError ABI above.
		Some(unsafe { mem::transmute::<*mut c_void, GetWindowIdFn>(symbol) })
	}
});

/// Processes already asked to expose their renderer accessibility tree.
static MANUAL_ACCESSIBILITY: LazyLock<Mutex<HashSet<libc::pid_t>>> =
	LazyLock::new(|| Mutex::new(HashSet::new()));

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn AXUIElementCreateApplication(pid: libc::pid_t) -> *mut AXUIElement;
}

pub(super) fn is_trusted() -> bool {
	// SAFETY: This non-prompting TCC query takes no arguments and only reads
	// current trust state.
	unsafe { AXIsProcessTrusted() }
}

#[derive(Default)]
pub(super) struct MacAx;

impl MacAx {
	pub(super) const fn new() -> Self {
		Self
	}

	pub(super) fn raise(&mut self, window: &DesktopWindow) -> CoreResult<()> {
		let root = self.window_root(window)?;
		self.perform(&root, "AXRaise")
	}
}

/// One accessibility top-level window of an application, mapped to its
/// `WindowServer` id.
pub(super) struct AxWindowRecord {
	pub(super) id:        u32,
	/// `AXMinimized`; `None` when the attribute could not be read.
	pub(super) minimized: Option<bool>,
}

/// The owner of the hit-testable surface at a global point.
pub(super) struct PointOwner {
	pub(super) pid:             libc::pid_t,
	/// `WindowServer` id of the surface's top-level window, when AX exposes it.
	pub(super) window:          Option<u32>,
}

/// `WindowServer` id of `pid`'s `AXFocusedWindow`.
pub(super) fn focused_window_id(pid: libc::pid_t) -> Option<u32> {
	let app = probe_application(pid)?;
	let window = copy_element(&app, "AXFocusedWindow")?;
	window_id(&window)
}

/// The window that should regain key status when `pid` is handed keyboard
/// focus back: its focused window, else its main window.
pub(super) fn key_window_id(pid: libc::pid_t) -> Option<u32> {
	let app = probe_application(pid)?;
	["AXFocusedWindow", "AXMainWindow"]
		.into_iter()
		.find_map(|attribute| {
			let window = copy_element(&app, attribute)?;
			window_id(&window)
		})
}

/// The application's `AXWindows`, mapped through `_AXUIElementGetWindow`.
///
/// Unlike `WindowServer`'s window list, this omits the extra layer-0
/// compositor surfaces Chromium, Electron, and `WebKit` hosts create per
/// native window, which can never independently become the key window.
/// `None` when the window-id SPI or the application's accessibility tree is
/// unavailable, so nothing can be proven about the process's windows.
pub(super) fn window_records(pid: libc::pid_t) -> Option<Vec<AxWindowRecord>> {
	(*GET_WINDOW_ID)?;
	let app = probe_application(pid)?;
	enable_web_accessibility(pid, &app);
	let windows = copy_elements_optional(&app, "AXWindows")?;
	// An unmappable sibling is still a possible keyboard destination. Dropping
	// it would turn an incomplete AX tree into false proof of exclusivity.
	windows
		.iter()
		.map(|window| {
			Some(AxWindowRecord {
				id:        window_id(window)?,
				minimized: copy_bool(window, "AXMinimized"),
			})
		})
		.collect()
}

/// Hit-tests the global point `(x, y)` the way the pointer would, returning
/// the process and window that own the frontmost surface there.
pub(super) fn point_owner(x: f64, y: f64) -> Option<PointOwner> {
	if !x.is_finite() || !y.is_finite() {
		return None;
	}
	let system = create_system_wide();
	// SAFETY: The retained system-wide element is valid for the timeout update.
	let _ = unsafe { system.set_messaging_timeout(PROBE_TIMEOUT_SECONDS) };
	let mut output: *const AXUIElement = ptr::null();
	let slot = NonNull::from(&mut output);
	// SAFETY: `slot` is writable and the system-wide element remains retained
	// through the synchronous hit-test.
	if unsafe { system.copy_element_at_position(x as f32, y as f32, slot) } != AXError::Success {
		return None;
	}
	let element = retained_element(output).ok()?;
	let mut pid: libc::pid_t = 0;
	// SAFETY: `pid` is writable and the retained element outlives the call.
	if unsafe { element.pid(NonNull::from(&mut pid)) } != AXError::Success {
		return None;
	}
	let window = element_window(&element);
	Some(PointOwner {
		pid,
		window: window.as_deref().and_then(window_id),
	})
}

/// Raises a known window for explicit takeover or restoration.
pub(super) fn raise_window_id(pid: libc::pid_t, wid: u32) -> CoreResult<()> {
	let app = probe_application(pid)
		.ok_or_else(|| DesktopError::ax_failed(format!("cannot inspect process {pid} for AXRaise")))?;
	let windows = copy_elements(&app, "AXWindows")?;
	let window = windows
		.into_iter()
		.find(|window| window_id(window) == Some(wid))
		.ok_or_else(|| DesktopError::window_not_found(format!("window {wid} is no longer available for AXRaise")))?;
	MacAx::new().perform(&AxHandle::Mac(window), "AXRaise")
}

fn probe_application(pid: libc::pid_t) -> Option<CFRetained<AXUIElement>> {
	let app = create_application(pid).ok()?;
	// SAFETY: The retained application element is valid for the timeout update.
	let _ = unsafe { app.set_messaging_timeout(PROBE_TIMEOUT_SECONDS) };
	Some(app)
}

fn window_id(window: &AXUIElement) -> Option<u32> {
	let get_id = (*GET_WINDOW_ID)?;
	let mut id = 0u32;
	// SAFETY: `id` is writable and the retained window element outlives the
	// call.
	(unsafe { get_id(window, &mut id) } == AXError::Success && id != 0).then_some(id)
}

/// The top-level window containing `element`: its `AXWindow`, else the first
/// window found by a bounded `AXParent` ascent.
fn element_window(element: &AXUIElement) -> Option<CFRetained<AXUIElement>> {
	if let Some(window) = copy_element(element, "AXWindow") {
		return Some(window);
	}
	let mut current = element.retain();
	for _ in 0..MAX_ANCESTRY_DEPTH {
		match copy_string(&current, "AXRole").as_deref() {
			Some("AXWindow") => return Some(current),
			Some("AXApplication") | None => return None,
			Some(_) => current = copy_element(&current, "AXParent")?,
		}
	}
	None
}

impl AxBackend for MacAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		ensure_trusted()?;
		let pid = win.pid.ok_or_else(|| {
			DesktopError::ax_failed(format!("window {} has no owning process id", win.id))
		})?;
		let pid = i32::try_from(pid).map_err(|_| {
			DesktopError::ax_failed(format!("window {} has an invalid process id", win.id))
		})?;
		let app = create_application(pid)?;
		set_timeout(&app)?;
		enable_web_accessibility(pid, &app);
		let windows = copy_elements(&app, "AXWindows")?;
		let expected_id = win.id.parse::<u32>().ok();
		if let (Some(get_id), Some(expected_id)) = (*GET_WINDOW_ID, expected_id) {
			for element in &windows {
				let mut actual_id = 0u32;
				// SAFETY: `actual_id` is writable and this retained AX element
				// remains alive for the call.
				if unsafe { get_id(element, &mut actual_id) } == AXError::Success
					&& actual_id == expected_id
				{
					set_timeout(element)?;
					return Ok(AxHandle::Mac(element.clone()));
				}
			}
			return Err(DesktopError::ax_failed(format!(
				"native window {expected_id} was not found in the application's accessibility windows"
			)));
		}
		// Without the native id SPI, require a unique title AND frame match.
		// A same-title replacement window must never inherit a stale target.
		let mut matches = windows.into_iter().filter(|element| {
			copy_string(element, "AXTitle").as_deref() == Some(win.title.as_str())
				&& bounds(element).is_some_and(|bounds| bounds_matches_window(bounds, win))
		});
		let element = matches.next().ok_or_else(|| {
			DesktopError::ax_failed(format!(
				"accessibility window for native window {} ('{}') was not found",
				win.id, win.title,
			))
		})?;
		if matches.next().is_some() {
			return Err(DesktopError::ax_failed("accessibility window title/frame match is ambiguous"));
		}
		set_timeout(&element)?;
		Ok(AxHandle::Mac(element))
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let element = mac_handle(h)?;
		let pid = element_pid(element)?;
		let window = element_window(element)
			.ok_or_else(|| DesktopError::ax_failed("AX element has no identifiable owning window"))?;
		let wid = window_id(&window)
			.ok_or_else(|| DesktopError::ax_failed("AX element's native window id is unavailable"))?;
		windows
			.iter()
			.find(|candidate| {
				candidate.id.parse::<u32>() == Ok(wid)
					&& candidate.pid.and_then(|pid| i32::try_from(pid).ok()) == Some(pid)
			})
			.map(|candidate| candidate.id.clone())
			.ok_or_else(|| DesktopError::window_not_found(format!(
				"AX element's window {wid} is not an available window of process {pid}"
			)))
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let element = mac_handle(h)?;
		let native_role = copy_required_string(element, "AXRole")?;
		let actions = copy_strings_from_action_names(element).unwrap_or_default();
		let child_count = copy_elements_optional(element, "AXChildren")
			.map_or(0, |children| u32::try_from(children.len()).unwrap_or(u32::MAX));
		Ok(AxProps {
			role: normalize_role_macos(&native_role),
			native_role,
			title: nonempty(copy_string(element, "AXTitle")),
			value: nonempty(copy_value_string(element, "AXValue")),
			description: nonempty(copy_string(element, "AXDescription")),
			enabled: copy_bool(element, "AXEnabled").unwrap_or(true),
			focused: copy_bool(element, "AXFocused").unwrap_or(false),
			bounds: bounds(element),
			actions,
			child_count,
		})
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		Ok(copy_elements_optional(mac_handle(h)?, "AXChildren")
			.unwrap_or_default()
			.into_iter()
			.map(AxHandle::Mac)
			.collect())
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		Ok(copy_element(mac_handle(h)?, "AXParent").map(AxHandle::Mac))
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let native = action_name(action);
		let actions = copy_strings_from_action_names(element)?;
		if !actions.contains(&native) {
			return Err(DesktopError::ax_failed(format!(
				"AX action '{native}' is not supported by this element; available actions: {}",
				actions.join(", "),
			)));
		}
		let action = CFString::from_str(&native);
		let perform = || {
			// SAFETY: The retained element and action CFString remain valid for the
			// synchronous AX request.
			let error = unsafe { element.perform_action(&action) };
			ax_result(error, format!("AX action '{native}' failed"))
		};
		// AXRaise is an explicit request to change stacking, including the
		// takeover preparation path. Other semantic actions must stay background.
		if native == "AXRaise" {
			perform()
		} else {
			skylight::with_background_guard(element_pid(element)?, perform)
		}
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		// Web AXValue can echo a write without the renderer accepting it. The
		// API has no "unverified" outcome, so refuse before mutating that surface.
		ensure_native_text_target(element)?;
		if !attribute_settable(element, "AXValue") {
			return Err(DesktopError::ax_failed("AXValue is not settable; no typing fallback was attempted"));
		}
		skylight::with_background_guard(element_pid(element)?, || {
			set_string_value(element, "AXValue", value)?;
			verify_text_value(element, value)
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let attribute = CFString::from_str("AXFocused");
		skylight::with_background_guard(element_pid(element)?, || {
			// SAFETY: The singleton CFBoolean and retained element remain valid for
			// the synchronous setter call.
			let error = unsafe { element.set_attribute_value(&attribute, CFBoolean::new(true)) };
			ax_result(error, "setting AXFocused=true failed")
		})
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		ensure_trusted()?;
		if !x.is_finite()
			|| !y.is_finite()
			|| x < f64::from(f32::MIN)
			|| x > f64::from(f32::MAX)
			|| y < f64::from(f32::MIN)
			|| y > f64::from(f32::MAX)
		{
			return Err(DesktopError::ax_failed(format!(
				"AX hit-test point ({x}, {y}) is outside the platform range"
			)));
		}
		let system = create_system_wide();
		set_timeout(&system)?;
		let mut output: *const AXUIElement = ptr::null();
		let slot = NonNull::from(&mut output);
		// SAFETY: `slot` is writable and the system-wide element remains retained
		// through the synchronous hit-test.
		let error = unsafe { system.copy_element_at_position(x as f32, y as f32, slot) };
		if error == AXError::NoValue {
			return Ok(None);
		}
		ax_result(error, format!("AX hit-test at ({x}, {y}) failed"))?;
		retained_element(output).map(|element| Some(AxHandle::Mac(element)))
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		ensure_trusted()?;
		let system = create_system_wide();
		set_timeout(&system)?;
		Ok(copy_element(&system, "AXFocusedUIElement").map(AxHandle::Mac))
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let element = mac_handle(h)?;
		let names = copy_attribute_names(element)?;
		let mut result = Vec::with_capacity(names.len());
		for name in names {
			let Some(name) = name
				.downcast::<CFString>()
				.ok()
				.map(|name| name.to_string())
			else {
				continue;
			};
			let value = copy_attribute(element, &name)
				.map_or_else(|| "<no value>".to_string(), |value| stringify_value(&value));
			result.push((name, truncate_chars(value, 200)));
		}
		Ok(result)
	}
}

fn element_pid(element: &AXUIElement) -> CoreResult<libc::pid_t> {
	let mut pid = 0;
	// SAFETY: `pid` is writable and the retained element outlives the query.
	ax_result(unsafe { element.pid(NonNull::from(&mut pid)) }, "reading AX element owner failed")?;
	if pid <= 0 {
		return Err(DesktopError::ax_failed("AX element has no application owner"));
	}
	Ok(pid)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TextSurface {
	Native,
	Web,
	Unknown,
}

fn text_surface(element: &AXUIElement) -> TextSurface {
	let mut current = element.retain();
	for _ in 0..MAX_ANCESTRY_DEPTH {
		match copy_string(&current, "AXRole").as_deref() {
			Some("AXWebArea") => return TextSurface::Web,
			Some("AXWindow" | "AXApplication") => return TextSurface::Native,
			None => return TextSurface::Unknown,
			Some(_) => {},
		}
		let Some(parent) = copy_element(&current, "AXParent") else {
			return TextSurface::Unknown;
		};
		current = parent;
	}
	TextSurface::Unknown
}

fn ensure_native_text_target(element: &AXUIElement) -> CoreResult<()> {
	if process::is_terminal(element_pid(element)?) {
		return Err(DesktopError::ax_failed(
			"terminal AX text represents its rendered grid, not terminal input; use typeText or takeover:true instead",
		));
	}
	if text_surface(element) != TextSurface::Native {
		return Err(DesktopError::ax_failed(
			"AX text writes cannot be verified in web content or an incomplete AX ancestry; use a \
			 pixel click followed by typeText, or takeover:true input instead",
		));
	}
	Ok(())
}

fn attribute_settable(element: &AXUIElement, name: &str) -> bool {
	let attribute = CFString::from_str(name);
	let mut settable = 0;
	// SAFETY: The Boolean out parameter is writable and all CF objects outlive
	// the synchronous AX query.
	(unsafe { element.is_attribute_settable(&attribute, NonNull::from(&mut settable)) }
		== AXError::Success) && settable != 0
}

fn set_string_value(element: &AXUIElement, name: &str, text: &str) -> CoreResult<()> {
	let attribute = CFString::from_str(name);
	let value = CFString::from_str(text);
	// SAFETY: The element, attribute and string remain retained for the setter.
	ax_result(
		unsafe { element.set_attribute_value(&attribute, &value) },
		format!("setting {name} failed; delivery may be partial, do not blindly repeat the text"),
	)
}

fn verify_text_value(element: &AXUIElement, expected: &str) -> CoreResult<()> {
	if copy_string(element, "AXValue").as_deref() == Some(expected) {
		Ok(())
	} else {
		Err(DesktopError::ax_failed(
			"AX accepted the text write but its complete value could not be confirmed; delivery may \
			 be partial, inspect the target before retrying; no typing fallback was attempted",
		))
	}
}

/// Inserts into a native field only when its focused element belongs to this
/// exact window. `false` means no write was attempted; an attempted write never
/// falls through to keystrokes, including timeouts or partial delivery.
pub(super) fn insert_native_text(pid: libc::pid_t, wid: u32, text: &str) -> CoreResult<bool> {
	let Some(app) = probe_application(pid) else {
		return Ok(false);
	};
	let Some(element) = copy_element(&app, "AXFocusedUIElement") else {
		return Ok(false);
	};
	if element_window(&element).as_deref().and_then(window_id) != Some(wid)
		|| text_surface(&element) != TextSurface::Native
		|| !matches!(copy_string(&element, "AXRole").as_deref(), Some("AXTextField" | "AXTextArea" | "AXComboBox"))
		|| !attribute_settable(&element, "AXSelectedText")
	{
		return Ok(false);
	}
	let Some(before) = copy_string(&element, "AXValue") else {
		return Ok(false);
	};
	let Some(selection) = copy_attribute(&element, "AXSelectedTextRange")
		.and_then(|value| value.downcast::<AXValue>().ok())
	else {
		return Ok(false);
	};
	let mut range = CFRange { location: 0, length: 0 };
	// SAFETY: The output is a live CFRange and the AXValue accessor validates
	// the requested type before writing it.
	if !unsafe { selection.value(AXValueType::CFRange, NonNull::from(&mut range).cast()) } {
		return Ok(false);
	}
	let Some(expected) = replace_utf16_selection(&before, range.location, range.length, text) else {
		return Ok(false);
	};
	skylight::with_background_guard(pid, || {
		set_string_value(&element, "AXSelectedText", text)?;
		verify_text_value(&element, &expected)
	})?;
	Ok(true)
}

/// AX text ranges use UTF-16 offsets, not UTF-8 byte or Unicode scalar indices.
fn replace_utf16_selection(before: &str, location: isize, length: isize, text: &str) -> Option<String> {
	let start = usize::try_from(location).ok()?;
	let end = start.checked_add(usize::try_from(length).ok()?)?;
	let mut units = 0;
	let mut start_byte = None;
	let mut end_byte = None;
	for (byte, character) in before.char_indices() {
		if units == start {
			start_byte = Some(byte);
		}
		if units == end {
			end_byte = Some(byte);
			break;
		}
		units += character.len_utf16();
	}
	if units == start && start_byte.is_none() {
		start_byte = Some(before.len());
	}
	if units == end && end_byte.is_none() {
		end_byte = Some(before.len());
	}
	let (start_byte, end_byte) = (start_byte?, end_byte?);
	let mut result = String::with_capacity(before.len() - (end_byte - start_byte) + text.len());
	result.push_str(&before[..start_byte]);
	result.push_str(text);
	result.push_str(&before[end_byte..]);
	Some(result)
}

fn ensure_trusted() -> CoreResult<()> {
	if is_trusted() {
		Ok(())
	} else {
		Err(DesktopError::permission_denied(
			"macOS Accessibility permission is not granted for this process",
		))
	}
}

fn create_application(pid: libc::pid_t) -> CoreResult<CFRetained<AXUIElement>> {
	// SAFETY: AXUIElementCreateApplication accepts any process id and returns a
	// +1 retained CF object.
	let raw = unsafe { AXUIElementCreateApplication(pid) };
	let pointer = NonNull::new(raw).ok_or_else(|| {
		DesktopError::ax_failed(format!("AXUIElementCreateApplication({pid}) returned null"))
	})?;
	// SAFETY: Create-rule ownership transfers the +1 AXUIElement reference into
	// CFRetained.
	Ok(unsafe { CFRetained::from_raw(pointer) })
}

/// Chromium-family apps build their renderer accessibility tree lazily. Reading
/// the application role activates modern Chrome's native AX mode, while older
/// Chromium/Electron builds also honor `AXManualAccessibility`. A process that
/// rejects the manual setter incurs no readiness delay.
fn enable_web_accessibility(pid: libc::pid_t, app: &AXUIElement) {
	// Modern Chromium treats an assistive client's role query as the activation
	// signal. Older Chromium/Electron builds use the manual setter below.
	let _ = copy_string(app, "AXRole");
	{
		let mut enabled = MANUAL_ACCESSIBILITY
			.lock()
			.unwrap_or_else(|error| error.into_inner());
		if !enabled.insert(pid) {
			return;
		}
		let attribute = CFString::from_str("AXManualAccessibility");
		// SAFETY: The retained element, attribute, and singleton CFBoolean remain
		// valid for the synchronous setter call.
		let error = unsafe { app.set_attribute_value(&attribute, CFBoolean::new(true)) };
		if error != AXError::Success {
			// Manual activation is unsupported; leave no stale pid marker.
			enabled.remove(&pid);
			return;
		}
	}
	// The renderers publish their trees over IPC after the switch flips, so the
	// first snapshot would otherwise race a still-empty web area.
	thread::sleep(Duration::from_millis(500));
}

fn create_system_wide() -> CFRetained<AXUIElement> {
	// SAFETY: The framework constructor returns a valid create-rule retained
	// system-wide element.
	unsafe { AXUIElement::new_system_wide() }
}

fn set_timeout(element: &AXUIElement) -> CoreResult<()> {
	// SAFETY: The retained AX element remains valid for the synchronous timeout
	// update.
	let error = unsafe { element.set_messaging_timeout(AX_TIMEOUT_SECONDS) };
	ax_result(error, "AXUIElementSetMessagingTimeout(2.0) failed")
}

fn copy_attribute_result(
	element: &AXUIElement,
	attribute: &str,
) -> Result<Option<CFRetained<CFType>>, AXError> {
	let attribute = CFString::from_str(attribute);
	let mut output: *const CFType = ptr::null();
	let slot = NonNull::from(&mut output);
	// SAFETY: `slot` is writable and receives a create-rule retained CF object
	// on success.
	let error = unsafe { element.copy_attribute_value(&attribute, slot) };
	if error != AXError::Success {
		return Err(error);
	}
	let Some(pointer) = NonNull::new(output.cast_mut()) else {
		return Ok(None);
	};
	// SAFETY: AXUIElementCopyAttributeValue returns a +1 object on success.
	Ok(Some(unsafe { CFRetained::from_raw(pointer) }))
}

fn copy_attribute(element: &AXUIElement, attribute: &str) -> Option<CFRetained<CFType>> {
	copy_attribute_result(element, attribute).ok().flatten()
}

fn copy_string(element: &AXUIElement, attribute: &str) -> Option<String> {
	let value = copy_attribute(element, attribute)?;
	if let Ok(value) = value.downcast::<CFString>() {
		Some(value.to_string())
	} else {
		None
	}
}
fn copy_required_string(element: &AXUIElement, attribute: &str) -> CoreResult<String> {
	let value = copy_attribute_result(element, attribute)
		.map_err(|error| DesktopError::ax_failed(format!("copying {attribute} failed ({error:?})")))?
		.ok_or_else(|| DesktopError::ax_failed(format!("copying {attribute} returned no value")))?;
	value
		.downcast::<CFString>()
		.map(|value| value.to_string())
		.map_err(|_| DesktopError::ax_failed(format!("{attribute} was not a string")))
}

fn copy_value_string(element: &AXUIElement, attribute: &str) -> Option<String> {
	copy_attribute(element, attribute).map(|value| stringify_value(&value))
}

fn copy_bool(element: &AXUIElement, attribute: &str) -> Option<bool> {
	copy_attribute(element, attribute)?
		.downcast::<CFBoolean>()
		.ok()
		.map(|value| value.as_bool())
}

fn copy_element(element: &AXUIElement, attribute: &str) -> Option<CFRetained<AXUIElement>> {
	copy_attribute(element, attribute)?
		.downcast::<AXUIElement>()
		.ok()
}

fn copy_elements(
	element: &AXUIElement,
	attribute: &str,
) -> CoreResult<Vec<CFRetained<AXUIElement>>> {
	copy_elements_optional(element, attribute)
		.ok_or_else(|| DesktopError::ax_failed(format!("copying {attribute} failed")))
}

fn copy_elements_optional(
	element: &AXUIElement,
	attribute: &str,
) -> Option<Vec<CFRetained<AXUIElement>>> {
	let array = copy_attribute(element, attribute)?
		.downcast::<CFArray>()
		.ok()?;
	// SAFETY: AXWindows/AXChildren are documented CFArray<AXUIElement> values.
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Some(
		array
			.iter()
			.filter_map(|value| value.downcast::<AXUIElement>().ok())
			.collect(),
	)
}

fn copy_attribute_names(element: &AXUIElement) -> CoreResult<Vec<CFRetained<CFType>>> {
	let mut output: *const CFArray = ptr::null();
	let slot = NonNull::from(&mut output);
	// SAFETY: `slot` is writable and receives a create-rule retained CFArray on
	// success.
	let error = unsafe { element.copy_attribute_names(slot) };
	ax_result(error, "AXUIElementCopyAttributeNames failed")?;
	let pointer = NonNull::new(output.cast_mut())
		.ok_or_else(|| DesktopError::ax_failed("AX attribute names returned null"))?;
	// SAFETY: The successful copy call returned this array at +1 retain count.
	let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };
	// SAFETY: AXUIElementCopyAttributeNames returns a CFArray of CFString
	// CFTypes.
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Ok(array.iter().collect())
}

fn copy_strings_from_action_names(element: &AXUIElement) -> CoreResult<Vec<String>> {
	let mut output: *const CFArray = ptr::null();
	let slot = NonNull::from(&mut output);
	// SAFETY: `slot` is writable and receives a create-rule retained CFArray on
	// success.
	ax_result(unsafe { element.copy_action_names(slot) }, "reading AX action names failed")?;
	let pointer = NonNull::new(output.cast_mut())
		.ok_or_else(|| DesktopError::ax_failed("AX action names returned a null array"))?;
	// SAFETY: The successful copy call returned this array at +1 retain count.
	let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };
	// SAFETY: AXUIElementCopyActionNames returns a CFArray of CFString CFTypes.
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Ok(array
		.iter()
		.filter_map(|value| {
			value
				.downcast::<CFString>()
				.ok()
				.map(|value| value.to_string())
		})
		.collect())
}

fn bounds(element: &AXUIElement) -> Option<AxBounds> {
	let position = copy_attribute(element, "AXPosition")?
		.downcast::<AXValue>()
		.ok()?;
	let size = copy_attribute(element, "AXSize")?
		.downcast::<AXValue>()
		.ok()?;
	let mut point = CGPoint { x: 0.0, y: 0.0 };
	let mut dimensions = CGSize { width: 0.0, height: 0.0 };
	// SAFETY: The output pointer targets a live CGPoint and the requested type
	// matches AXPosition.
	let got_point =
		unsafe { position.value(AXValueType::CGPoint, NonNull::from(&mut point).cast()) };
	// SAFETY: The output pointer targets a live CGSize and the requested type
	// matches AXSize.
	let got_size = unsafe { size.value(AXValueType::CGSize, NonNull::from(&mut dimensions).cast()) };
	if !got_point || !got_size {
		return None;
	}
	Some(AxBounds {
		x:      point.x,
		y:      point.y,
		width:  dimensions.width,
		height: dimensions.height,
	})
}

fn retained_element(pointer: *const AXUIElement) -> CoreResult<CFRetained<AXUIElement>> {
	let pointer = NonNull::new(pointer.cast_mut())
		.ok_or_else(|| DesktopError::ax_failed("AX operation returned a null element"))?;
	// SAFETY: Successful AX copy operations return their output element at +1
	// retain count.
	Ok(unsafe { CFRetained::from_raw(pointer) })
}

// The test-only handle variant makes this fallible under `cfg(test)`; keep one
// call contract.
#[cfg_attr(
	not(test),
	allow(clippy::unnecessary_wraps, reason = "the test-only handle variant is fallible")
)]
fn mac_handle(handle: &AxHandle) -> CoreResult<&AXUIElement> {
	match handle {
		AxHandle::Mac(element) => Ok(element),
		#[cfg(test)]
		AxHandle::Test(_) => Err(DesktopError::ax_failed("non-macOS AX handle passed to MacAx")),
	}
}

fn bounds_matches_window(bounds: AxBounds, window: &DesktopWindow) -> bool {
	(bounds.x - f64::from(window.x)).abs() <= 2.0
		&& (bounds.y - f64::from(window.y)).abs() <= 2.0
		&& (bounds.width - f64::from(window.width)).abs() <= 2.0
		&& (bounds.height - f64::from(window.height)).abs() <= 2.0
}

fn action_name(action: &str) -> String {
	match action.trim().to_ascii_lowercase().as_str() {
		"press" => "AXPress".to_string(),
		"raise" => "AXRaise".to_string(),
		"showmenu" | "show_menu" => "AXShowMenu".to_string(),
		_ if action.starts_with("AX") => action.to_string(),
		_ => format!("AX{action}"),
	}
}

fn stringify_value(value: &CFType) -> String {
	if let Some(string) = value.downcast_ref::<CFString>() {
		return string.to_string();
	}
	if let Some(boolean) = value.downcast_ref::<CFBoolean>() {
		return boolean.as_bool().to_string();
	}
	format!("{value:?}")
}

fn nonempty(value: Option<String>) -> Option<String> {
	value.filter(|value| !value.is_empty())
}

fn truncate_chars(value: String, max: usize) -> String {
	if value.chars().count() <= max {
		return value;
	}
	let mut result: String = value.chars().take(max.saturating_sub(1)).collect();
	result.push('…');
	result
}

fn ax_result(error: AXError, context: impl Into<String>) -> CoreResult<()> {
	if error == AXError::Success {
		Ok(())
	} else {
		Err(DesktopError::ax_failed(format!("{} ({error:?})", context.into())))
	}
}

#[cfg(test)]
mod tests {
	use super::replace_utf16_selection;

	#[test]
	fn selected_text_replaces_utf16_selection_without_losing_surrounding_text() {
		assert_eq!(replace_utf16_selection("a😀bc", 1, 2, "é").as_deref(), Some("aébc"));
		assert_eq!(replace_utf16_selection("a😀bc", 3, 0, "X").as_deref(), Some("a😀Xbc"));
		assert_eq!(replace_utf16_selection("a😀bc", 0, 5, "").as_deref(), Some(""));
		assert_eq!(replace_utf16_selection("", 0, 0, "hi").as_deref(), Some("hi"));
	}

	#[test]
	fn invalid_or_surrogate_splitting_selections_never_become_writes() {
		for (start, length) in [(-1, 0), (0, -1), (2, 0), (1, 1), (4, 9), (6, 0)] {
			assert_eq!(replace_utf16_selection("a😀bc", start, length, "X"), None);
		}
	}
}
