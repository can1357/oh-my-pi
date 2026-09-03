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
use objc2_core_foundation::{CFArray, CFBoolean, CFRetained, CFString, CFType, CGPoint, CGSize};

use super::super::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_macos},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

const AX_TIMEOUT_SECONDS: f32 = 2.0;

type GetWindowIdFn = unsafe extern "C" fn(&AXUIElement, *mut u32) -> AXError;

static GET_WINDOW_ID: LazyLock<Option<GetWindowIdFn>> = LazyLock::new(|| {
	// SAFETY: The symbol name is a static NUL-terminated string for process-wide
	// lookup.
	let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
	if symbol.is_null() {
		None
	} else {
		// SAFETY: `_AXUIElementGetWindow` has the exact AXUIElementRef, CGWindowID* ->
		// AXError ABI above.
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
/// Make the addressed window the app's main/focused window while foreground
/// delivery has deliberately activated the app. This is best-effort at the
/// input callsite because keyboard delivery must still work without AX trust.
pub(super) fn prepare_foreground_input(window: &DesktopWindow) -> CoreResult<()> {
	let mut backend = MacAx::new();
	let root = backend.window_root(window)?;
	let element = mac_handle(&root)?;
	for attribute in ["AXMain", "AXFocused"] {
		let attribute = CFString::from_str(attribute);
		// SAFETY: The retained element, attribute, and singleton CFBoolean remain
		// valid for the synchronous setter call.
		let _ = unsafe { element.set_attribute_value(&attribute, CFBoolean::new(true)) };
	}
	backend.perform(&root, "AXRaise")
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
				// SAFETY: `actual_id` is writable and this retained AX element remains alive
				// for the call.
				if unsafe { get_id(element, &mut actual_id) } == AXError::Success
					&& actual_id == expected_id
				{
					set_timeout(element)?;
					return Ok(AxHandle::Mac(element.clone()));
				}
			}
		}
		// Older systems may hide the private window-id SPI. Match title and global
		// frame together, then title alone only when it is unique.
		let mut title_match = None;
		for element in windows {
			let title = copy_string(&element, "AXTitle").unwrap_or_default();
			if title != win.title {
				continue;
			}
			if bounds(&element).is_some_and(|bounds| bounds_matches_window(bounds, win)) {
				set_timeout(&element)?;
				return Ok(AxHandle::Mac(element));
			}
			if title_match.is_some() {
				title_match = None;
				break;
			}
			title_match = Some(element);
		}
		let element = title_match.ok_or_else(|| {
			DesktopError::ax_failed(format!(
				"accessibility window for native window {} ('{}') was not found",
				win.id, win.title,
			))
		})?;
		set_timeout(&element)?;
		Ok(AxHandle::Mac(element))
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let element = mac_handle(h)?;
		let native_role = copy_required_string(element, "AXRole")?;
		let actions = copy_strings_from_action_names(element);
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
		let action = CFString::from_str(&native);
		// SAFETY: The retained element and action CFString remain valid for the
		// synchronous AX request.
		let error = unsafe { element.perform_action(&action) };
		ax_result(error, format!("AX action '{native}' failed"))
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let attribute = CFString::from_str("AXValue");
		let value = CFString::from_str(value);
		// SAFETY: The element, attribute, and value remain retained for the synchronous
		// setter call.
		let error = unsafe { element.set_attribute_value(&attribute, &value) };
		ax_result(error, "AXValue is not settable; no typing fallback was attempted")
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let attribute = CFString::from_str("AXFocused");
		// SAFETY: The singleton CFBoolean and retained element remain valid for the
		// synchronous setter call.
		let error = unsafe { element.set_attribute_value(&attribute, CFBoolean::new(true)) };
		ax_result(error, "setting AXFocused=true failed")
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
	// SAFETY: AXUIElementCreateApplication accepts any process id and returns a +1
	// retained CF object.
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
	// SAFETY: `slot` is writable and receives a create-rule retained CF object on
	// success.
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
	// SAFETY: AXUIElementCopyAttributeNames returns a CFArray of CFString CFTypes.
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	Ok(array.iter().collect())
}

fn copy_strings_from_action_names(element: &AXUIElement) -> Vec<String> {
	let mut output: *const CFArray = ptr::null();
	let slot = NonNull::from(&mut output);
	// SAFETY: `slot` is writable and receives a create-rule retained CFArray on
	// success.
	if unsafe { element.copy_action_names(slot) } != AXError::Success {
		return Vec::new();
	}
	let Some(pointer) = NonNull::new(output.cast_mut()) else {
		return Vec::new();
	};
	// SAFETY: The successful copy call returned this array at +1 retain count.
	let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };
	// SAFETY: AXUIElementCopyActionNames returns a CFArray of CFString CFTypes.
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	array
		.iter()
		.filter_map(|value| {
			value
				.downcast::<CFString>()
				.ok()
				.map(|value| value.to_string())
		})
		.collect()
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
