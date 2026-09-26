use std::ptr::with_exposed_provenance_mut;

use uiautomation::{
	UIAutomation, UIElement,
	patterns::{
		UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UIScrollItemPattern,
		UISelectionItemPattern, UITogglePattern, UIValuePattern,
	},
	types::{ControlType, ExpandCollapseState, Handle, Point, UIProperty},
};
use windows_sys::Win32::{
	Foundation::{HWND, POINT},
	UI::WindowsAndMessaging::{GetDesktopWindow, IsWindow, WindowFromPoint},
};

use super::{
	super::{
		ax::{AxBounds, AxHandle, AxProps, normalize_role_uia},
		backend::AxBackend,
		error::{CoreResult, DesktopError},
		types::DesktopWindow,
	},
	window,
};

/// Ancestors of a hit-tested element searched for the control that owns it.
const MAX_PRESS_ANCESTORS: usize = 8;

pub(super) struct Win32Ax {
	automation_initialized: bool,
}

impl Win32Ax {
	pub(super) const fn new() -> Self {
		Self { automation_initialized: false }
	}

	fn automation(&mut self) -> CoreResult<UIAutomation> {
		if self.automation_initialized {
			UIAutomation::new_direct().map_err(ax_error)
		} else {
			let automation = UIAutomation::new().map_err(ax_error)?;
			self.automation_initialized = true;
			Ok(automation)
		}
	}

	#[allow(
		clippy::missing_const_for_fn,
		clippy::unnecessary_wraps,
		reason = "in test configuration handle matching can return an error"
	)]
	fn element(handle: &AxHandle) -> CoreResult<&UIElement> {
		match handle {
			AxHandle::Uia(element) => Ok(element),
			#[cfg(test)]
			_ => Err(DesktopError::ax_failed("accessibility handle does not belong to UI Automation")),
		}
	}

	fn walker(&mut self) -> CoreResult<uiautomation::UITreeWalker> {
		self.automation()?.get_raw_view_walker().map_err(ax_error)
	}

	/// Top-level window hosting `element`, found through the nearest ancestor
	/// that owns a native window; `None` for the desktop itself.
	fn host_root(&mut self, element: &UIElement) -> Option<HWND> {
		let walker = self.walker().ok()?;
		let mut current = element.clone();
		for _ in 0..64 {
			if let Some(hwnd) = native_window(&current) {
				let root = window::root(hwnd);
				// SAFETY: GetDesktopWindow has no preconditions.
				return (root != unsafe { GetDesktopWindow() }).then_some(root);
			}
			current = walker.get_parent(&current).ok()?;
		}
		None
	}

	/// Refuses known self-activating providers rather than disabling a foreign
	/// window or trying to undo a foreground steal after the action.
	fn contained(
		&mut self,
		element: &UIElement,
		call: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		let root = self.host_root(element).ok_or_else(|| {
			DesktopError::ax_failed("cannot establish the native window hosting this UIA element")
		})?;
		window::ensure_pattern_safe(root)?;
		call()
	}

	/// Presses the control under a physical screen point through UI
	/// Automation, for toolkits that drop posted clicks (WPF, `WinUI` 3, Tk,
	/// GTK). Returns whether a pattern ran.
	///
	/// Only controls whose click does the same thing wherever it lands inside
	/// them qualify, so canvases and panes keep pixel semantics and stay
	/// refused. The point must hit `root`'s visible window tree, so an
	/// occluding window is never pressed.
	pub(super) fn invoke_at_point(&mut self, root: HWND, point: POINT) -> CoreResult<bool> {
		// SAFETY: WindowFromPoint takes a scalar point.
		let visible = unsafe { WindowFromPoint(point) };
		if visible.is_null() || window::root(visible) != root {
			return Ok(false);
		}
		let automation = self.automation()?;
		let walker = automation.get_raw_view_walker().map_err(ax_error)?;
		let mut element = automation
			.element_from_point(Point::new(point.x, point.y))
			.map_err(ax_error)?;
		// A process can own several independent top-level windows. Process ID
		// equality (or an overlapping rectangle) cannot prove this membership.
		if self.host_root(&element) != Some(root) {
			return Ok(false);
		}
		for _ in 0..MAX_PRESS_ANCESTORS {
			let control_type = element.get_control_type().map_err(ax_error)?;
			if let Some(press) = positionless_press(&element) {
				let rect = element.get_bounding_rectangle().map_err(ax_error)?;
				if point.x < rect.get_left()
					|| point.x >= rect.get_right()
					|| point.y < rect.get_top()
					|| point.y >= rect.get_bottom()
					|| !element.is_enabled().map_err(ax_error)?
					|| element.is_offscreen().map_err(ax_error)?
					|| self.host_root(&element) != Some(root)
				{
					return Ok(false);
				}
				// Recheck occlusion after provider queries, before any action.
				// SAFETY: WindowFromPoint takes a scalar point.
				if window::root(unsafe { WindowFromPoint(point) }) != root {
					return Ok(false);
				}
				window::ensure_pattern_safe(root)?;
				press.run().map_err(|error| {
					DesktopError::ax_failed(format!(
						"UIA coordinate action failed and may already have taken effect; \
						 do not replay it automatically: {error}"
					))
				})?;
				return Ok(true);
			}
			// Only decorative content may inherit a parent's primary click.
			// Never climb from a canvas/list/tree/split button into an outer
			// invokable container and silently lose the requested coordinates.
			if native_window(&element) == Some(root)
				|| !matches!(control_type, ControlType::Text | ControlType::Image)
			{
				break;
			}
			element = walker.get_parent(&element).map_err(ax_error)?;
		}
		Ok(false)
	}
}

fn ax_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("UI Automation failed: {error}"))
}

/// Native window handle `element` represents, if any.
fn native_window(element: &UIElement) -> Option<HWND> {
	let raw: isize = element.get_native_window_handle().ok()?.into();
	(raw != 0).then(|| with_exposed_provenance_mut(raw as usize))
}

/// UI Automation pattern performing a control's position-independent click.
enum PositionlessPress {
	Invoke(UIInvokePattern),
	Expand(UIExpandCollapsePattern),
	Collapse(UIExpandCollapsePattern),
	Toggle(UITogglePattern),
	Select(UISelectionItemPattern),
}

impl PositionlessPress {
	fn run(&self) -> Result<(), uiautomation::Error> {
		match self {
			Self::Invoke(pattern) => pattern.invoke(),
			Self::Expand(pattern) => pattern.expand(),
			Self::Collapse(pattern) => pattern.collapse(),
			Self::Toggle(pattern) => pattern.toggle(),
			Self::Select(pattern) => pattern.select(),
		}
	}
}

/// The press for a control whose click does the same thing wherever it lands
/// inside it. Menu items with a submenu toggle it through `ExpandCollapse`,
/// where `Invoke` does nothing.
fn positionless_press(element: &UIElement) -> Option<PositionlessPress> {
	let control_type = element.get_control_type().ok()?;
	if !coordinate_click_supported(control_type) {
		return None;
	}
	if control_type == ControlType::MenuItem
		&& let Ok(pattern) = element.get_pattern::<UIExpandCollapsePattern>()
	{
		match pattern.get_state() {
			Ok(ExpandCollapseState::Collapsed | ExpandCollapseState::PartiallyExpanded) => {
				return Some(PositionlessPress::Expand(pattern));
			},
			Ok(ExpandCollapseState::Expanded) => return Some(PositionlessPress::Collapse(pattern)),
			Ok(ExpandCollapseState::LeafNode) | Err(_) => {},
		}
	}
	if control_type == ControlType::CheckBox {
		return element.get_pattern::<UITogglePattern>().ok().map(PositionlessPress::Toggle);
	}
	if matches!(control_type, ControlType::TabItem | ControlType::RadioButton) {
		return element
			.get_pattern::<UISelectionItemPattern>()
			.ok()
			.map(PositionlessPress::Select);
	}
	element
		.get_pattern::<UIInvokePattern>()
		.ok()
		.map(PositionlessPress::Invoke)
}

/// Split buttons, trees and list rows have independently clickable subregions;
/// their default action cannot substitute for a pixel-addressed click.
const fn coordinate_click_supported(control_type: ControlType) -> bool {
	matches!(
		control_type,
		ControlType::Button
			| ControlType::MenuItem
			| ControlType::Hyperlink
			| ControlType::CheckBox
			| ControlType::RadioButton
			| ControlType::TabItem
	)
}

fn optional(value: Result<String, uiautomation::Error>) -> Option<String> {
	value.ok().filter(|value| !value.is_empty())
}

fn actions(element: &UIElement) -> Vec<String> {
	let can_invoke = element.get_pattern::<UIInvokePattern>().is_ok();
	let can_toggle = element.get_pattern::<UITogglePattern>().is_ok();
	let can_select = element.get_pattern::<UISelectionItemPattern>().is_ok();
	let can_expand = element.get_pattern::<UIExpandCollapsePattern>().is_ok();
	let can_legacy_press = element
		.get_pattern::<UILegacyIAccessiblePattern>()
		.and_then(|pattern| pattern.get_default_action())
		.is_ok_and(|action| !action.is_empty());
	let mut actions = Vec::with_capacity(8);
	if can_invoke || can_toggle || can_select || can_legacy_press
		|| (can_expand && element.get_control_type().ok() == Some(ControlType::MenuItem))
	{
		actions.push("press".to_string());
	}
	if can_invoke {
		actions.push("invoke".to_string());
	}
	if can_toggle {
		actions.push("toggle".to_string());
	}
	if can_expand {
		actions.push("expand".to_string());
		actions.push("collapse".to_string());
	}
	if can_select {
		actions.push("select".to_string());
	}
	if element.get_pattern::<UIScrollItemPattern>().is_ok() {
		actions.push("scrollintoview".to_string());
	}
	actions
}

fn value(element: &UIElement) -> Option<String> {
	element
		.get_pattern::<UIValuePattern>()
		.and_then(|pattern| pattern.get_value())
		.ok()
		.filter(|value| !value.is_empty())
		.or_else(|| {
			element
				.get_pattern::<UILegacyIAccessiblePattern>()
				.and_then(|pattern| pattern.get_value())
				.ok()
				.filter(|value| !value.is_empty())
		})
}

fn truncate(value: impl ToString) -> String {
	let value = value.to_string();
	if value.chars().count() <= 200 {
		value
	} else {
		value
			.chars()
			.take(199)
			.chain(std::iter::once('…'))
			.collect()
	}
}

impl AxBackend for Win32Ax {
	fn window_id(&mut self, handle: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let root = self.host_root(Self::element(handle)?).ok_or_else(|| {
			DesktopError::ax_failed("cannot establish the native window hosting this UIA element")
		})?;
		// SAFETY: IsWindow validates the provider-supplied native handle.
		if unsafe { IsWindow(root) } == 0 {
			return Err(DesktopError::window_not_found("the UIA element's window no longer exists"));
		}
		let address = root.expose_provenance();
		windows
			.iter()
			.find(|window| window.id.parse::<usize>().ok() == Some(address))
			.map(|window| window.id.clone())
			.ok_or_else(|| {
				DesktopError::window_not_found(
					"the UIA element's exact native window is not an available target",
				)
			})
	}

	fn window_root(&mut self, window: &DesktopWindow) -> CoreResult<AxHandle> {
		let address = window.id.parse::<usize>().map_err(|_| {
			DesktopError::ax_failed(format!("invalid Win32 window id '{}'", window.id))
		})?;
		let handle = Handle::from(address as isize);
		self
			.automation()?
			.element_from_handle(handle)
			.map(AxHandle::Uia)
			.map_err(ax_error)
	}

	fn props(&mut self, handle: &AxHandle) -> CoreResult<AxProps> {
		let element = Self::element(handle)?;
		let control_type = element.get_control_type().map_err(ax_error)?;
		let native_role = control_type.to_string();
		let walker = self.walker()?;
		let child_count = walker
			.get_children(element)
			.map_or(0, |children| children.len().min(u32::MAX as usize) as u32);
		// UIA rectangles already use physical desktop pixels, the same
		// native coordinate space as window metadata and capture geometry.
		let bounds = element.get_bounding_rectangle().ok().map(|rect| AxBounds {
			x: f64::from(rect.get_left()),
			y: f64::from(rect.get_top()),
			width: f64::from(rect.get_right()) - f64::from(rect.get_left()),
			height: f64::from(rect.get_bottom()) - f64::from(rect.get_top()),
		});
		Ok(AxProps {
			role: normalize_role_uia(&native_role),
			native_role,
			title: optional(element.get_name()),
			value: value(element),
			description: optional(element.get_help_text()),
			enabled: element.is_enabled().unwrap_or(false),
			focused: element.has_keyboard_focus().unwrap_or(false),
			bounds,
			actions: actions(element),
			child_count,
		})
	}

	fn children(&mut self, handle: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let element = Self::element(handle)?;
		Ok(self
			.walker()?
			.get_children(element)
			.unwrap_or_default()
			.into_iter()
			.map(AxHandle::Uia)
			.collect())
	}

	fn parent(&mut self, handle: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let element = Self::element(handle)?;
		Ok(self.walker()?.get_parent(element).ok().map(AxHandle::Uia))
	}

	fn perform(&mut self, handle: &AxHandle, action: &str) -> CoreResult<()> {
		let element = Self::element(handle)?;
		let action = action.trim().to_ascii_lowercase();
		self.contained(element, || match action.as_str() {
			"press" => {
				if let Some(pattern) = positionless_press(element) {
					return pattern.run().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UIInvokePattern>() {
					return pattern.invoke().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UITogglePattern>() {
					return pattern.toggle().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UISelectionItemPattern>() {
					return pattern.select().map_err(ax_error);
				}
				let pattern = element.get_pattern::<UILegacyIAccessiblePattern>().map_err(ax_error)?;
				if pattern.get_default_action().map_err(ax_error)?.is_empty() {
					return Err(DesktopError::ax_failed("UIA element has no default press action"));
				}
				pattern.do_default_action().map_err(ax_error)
			},
			"invoke" => element
				.get_pattern::<UIInvokePattern>()
				.and_then(|pattern| pattern.invoke())
				.map_err(ax_error),
			"toggle" => element
				.get_pattern::<UITogglePattern>()
				.and_then(|pattern| pattern.toggle())
				.map_err(ax_error),
			"expand" => element
				.get_pattern::<UIExpandCollapsePattern>()
				.and_then(|pattern| pattern.expand())
				.map_err(ax_error),
			"collapse" => element
				.get_pattern::<UIExpandCollapsePattern>()
				.and_then(|pattern| pattern.collapse())
				.map_err(ax_error),
			"select" => element
				.get_pattern::<UISelectionItemPattern>()
				.and_then(|pattern| pattern.select())
				.map_err(ax_error),
			"scrollintoview" => element
				.get_pattern::<UIScrollItemPattern>()
				.and_then(|pattern| pattern.scroll_into_view())
				.map_err(ax_error),
			other => {
				Err(DesktopError::ax_failed(format!("unsupported UI Automation action '{other}'")))
			},
		})
	}

	fn set_value(&mut self, handle: &AxHandle, value: &str) -> CoreResult<()> {
		let element = Self::element(handle)?;
		self.contained(element, || {
			element
				.get_pattern::<UIValuePattern>()
				.and_then(|pattern| pattern.set_value(value))
				.map_err(ax_error)
		})
	}

	fn focus(&mut self, handle: &AxHandle) -> CoreResult<()> {
		Self::element(handle)?.set_focus().map_err(ax_error)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		self
			.automation()?
			.element_from_point(Point::new(x.round() as i32, y.round() as i32))
			.map(AxHandle::Uia)
			.map(Some)
			.map_err(ax_error)
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self
			.automation()?
			.get_focused_element()
			.map(AxHandle::Uia)
			.map(Some)
			.map_err(ax_error)
	}

	fn attributes(&mut self, handle: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let element = Self::element(handle)?;
		let properties = [
			UIProperty::RuntimeId,
			UIProperty::BoundingRectangle,
			UIProperty::ProcessId,
			UIProperty::ControlType,
			UIProperty::LocalizedControlType,
			UIProperty::Name,
			UIProperty::AcceleratorKey,
			UIProperty::AccessKey,
			UIProperty::HasKeyboardFocus,
			UIProperty::IsKeyboardFocusable,
			UIProperty::IsEnabled,
			UIProperty::AutomationId,
			UIProperty::ClassName,
			UIProperty::HelpText,
			UIProperty::ClickablePoint,
			UIProperty::Culture,
			UIProperty::IsControlElement,
			UIProperty::IsContentElement,
			UIProperty::IsPassword,
			UIProperty::NativeWindowHandle,
			UIProperty::ItemType,
			UIProperty::IsOffscreen,
			UIProperty::Orientation,
			UIProperty::FrameworkId,
			UIProperty::IsRequiredForForm,
			UIProperty::ItemStatus,
			UIProperty::AriaRole,
			UIProperty::AriaProperties,
			UIProperty::ProviderDescription,
			UIProperty::FullDescription,
		];
		let mut attributes = Vec::with_capacity(properties.len());
		for property in properties {
			if let Ok(value) = element.get_property_value(property)
				&& !value.is_null()
			{
				attributes.push((property.to_string(), truncate(value)));
			}
		}
		Ok(attributes)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn coordinate_click_rejects_controls_with_position_dependent_subregions() {
		for role in [
			ControlType::SplitButton,
			ControlType::TreeItem,
			ControlType::ListItem,
			ControlType::Pane,
			ControlType::Custom,
			ControlType::Document,
		] {
			assert!(!coordinate_click_supported(role), "{role:?}");
		}
		for role in [
			ControlType::Button,
			ControlType::CheckBox,
			ControlType::RadioButton,
			ControlType::TabItem,
		] {
			assert!(coordinate_click_supported(role), "{role:?}");
		}
	}
}
