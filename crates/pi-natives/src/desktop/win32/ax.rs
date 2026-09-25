use uiautomation::{
	UIAutomation, UIElement,
	patterns::{
		UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UIScrollItemPattern,
		UISelectionItemPattern, UITogglePattern, UIValuePattern,
	},
	types::{Handle, Point, UIProperty},
};

use super::{
	super::{
		ax::{AxBounds, AxHandle, AxProps, normalize_role_uia},
		backend::AxBackend,
		error::{CoreResult, DesktopError},
		types::{DesktopDisplay, DesktopWindow, DisplaySelector},
	},
	capture,
};

pub(super) struct Win32Ax {
	automation_initialized: bool,
	displays:               Option<Vec<DesktopDisplay>>,
}

impl Win32Ax {
	pub(super) const fn new() -> Self {
		Self { automation_initialized: false, displays: None }
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

	fn refresh_displays(&mut self) {
		self.displays = capture::displays(&DisplaySelector::All).ok();
	}

	fn display_layout(&mut self) -> Option<&[DesktopDisplay]> {
		if self.displays.is_none() {
			self.refresh_displays();
		}
		self.displays.as_deref()
	}

	#[allow(clippy::suboptimal_flops, reason = "clarity of physical coordinate calculation")]
	fn logical_bounds(&mut self, left: i32, top: i32, right: i32, bottom: i32) -> Option<AxBounds> {
		let displays = self.display_layout()?;
		let display = displays
			.iter()
			.find(|display| {
				let physical_x = f64::from(display.x) * display.scale;
				let physical_y = f64::from(display.y) * display.scale;
				f64::from(left) >= physical_x
					&& f64::from(left) < physical_x + f64::from(display.width) * display.scale
					&& f64::from(top) >= physical_y
					&& f64::from(top) < physical_y + f64::from(display.height) * display.scale
			})
			.or_else(|| displays.first())?;
		let scale = display.scale.max(f64::EPSILON);
		Some(AxBounds {
			x:      f64::from(left) / scale,
			y:      f64::from(top) / scale,
			width:  f64::from(right - left) / scale,
			height: f64::from(bottom - top) / scale,
		})
	}
}

fn ax_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("UI Automation failed: {error}"))
}

fn optional(value: Result<String, uiautomation::Error>) -> Option<String> {
	value.ok().filter(|value| !value.is_empty())
}

fn actions(element: &UIElement) -> Vec<String> {
	let can_invoke = element.get_pattern::<UIInvokePattern>().is_ok();
	let can_toggle = element.get_pattern::<UITogglePattern>().is_ok();
	let can_legacy_press = element.get_pattern::<UILegacyIAccessiblePattern>().is_ok();
	let mut actions = Vec::with_capacity(8);
	if can_invoke || can_toggle || can_legacy_press {
		actions.push("press".to_string());
	}
	if can_invoke {
		actions.push("invoke".to_string());
	}
	if can_toggle {
		actions.push("toggle".to_string());
	}
	if element.get_pattern::<UIExpandCollapsePattern>().is_ok() {
		actions.push("expand".to_string());
		actions.push("collapse".to_string());
	}
	if element.get_pattern::<UISelectionItemPattern>().is_ok() {
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
	fn window_root(&mut self, window: &DesktopWindow) -> CoreResult<AxHandle> {
		self.refresh_displays();
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
		let bounds = element.get_bounding_rectangle().ok().and_then(|rect| {
			self.logical_bounds(rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom())
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
		match action.trim().to_ascii_lowercase().as_str() {
			"press" => {
				if let Ok(pattern) = element.get_pattern::<UIInvokePattern>() {
					return pattern.invoke().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UITogglePattern>() {
					return pattern.toggle().map_err(ax_error);
				}
				element
					.get_pattern::<UILegacyIAccessiblePattern>()
					.and_then(|pattern| pattern.do_default_action())
					.map_err(ax_error)
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
		}
	}

	fn set_value(&mut self, handle: &AxHandle, value: &str) -> CoreResult<()> {
		Self::element(handle)?
			.get_pattern::<UIValuePattern>()
			.and_then(|pattern| pattern.set_value(value))
			.map_err(ax_error)
	}

	fn focus(&mut self, handle: &AxHandle) -> CoreResult<()> {
		Self::element(handle)?.set_focus().map_err(ax_error)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let (x, y) = capture::logical_to_physical(x, y)
			.map_err(|error| DesktopError::ax_failed(error.message))?;
		self
			.automation()?
			.element_from_point(Point::new(x, y))
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
