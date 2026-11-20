use std::{
	cmp::Ordering,
	ptr::with_exposed_provenance_mut,
	time::{Duration, Instant},
};

use uiautomation::{
	UIAutomation, UIElement, UITreeWalker,
	patterns::{
		UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UIScrollItemPattern,
		UIScrollPattern, UISelectionItemPattern, UITogglePattern, UIValuePattern,
	},
	types::{ControlType, ExpandCollapseState, Handle, Point, ScrollAmount, UIProperty},
	variants::Value,
};
use windows_sys::Win32::{
	Foundation::{HWND, POINT},
	UI::WindowsAndMessaging::{
		GA_PARENT, GetAncestor, GetDesktopWindow, IsWindow, SPI_GETWHEELSCROLLCHARS,
		SPI_GETWHEELSCROLLLINES, SystemParametersInfoW, WindowFromPoint,
	},
};

use super::{
	super::{
		ax::{AxBounds, AxHandle, AxProps, normalize_role_uia},
		backend::AxBackend,
		control,
		error::{CoreResult, DesktopError, ErrorCode},
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

	/// Uses the COM apartment already initialized and owned by the caller.
	pub(super) const fn new_initialized() -> Self {
		Self { automation_initialized: true }
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
			AxHandle::Uia(element, _) => Ok(element),
			#[cfg(test)]
			_ => Err(DesktopError::ax_failed("accessibility handle does not belong to UI Automation")),
		}
	}

	/// The control window `handle` is itself, such as a classic edit box's;
	/// `None` for a windowless element drawn inside a parent's window.
	pub(super) fn own_window(handle: &AxHandle) -> CoreResult<Option<HWND>> {
		Ok(native_window(Self::element(handle)?))
	}

	fn walker(&mut self) -> CoreResult<uiautomation::UITreeWalker> {
		self.automation()?.get_raw_view_walker().map_err(ax_error)
	}

	/// Top-level window hosting `element`, found through the nearest ancestor
	/// that owns a native window; `None` for the desktop itself.
	pub(super) fn host_root(&mut self, element: &UIElement) -> Option<HWND> {
		let walker = self.walker().ok()?;
		Self::host_root_from(element, &walker, native_window(element))
	}

	fn host_root_from(
		element: &UIElement,
		walker: &uiautomation::UITreeWalker,
		mut direct: Option<HWND>,
	) -> Option<HWND> {
		let mut current = element.clone();
		for depth in 0..64 {
			if let Some(hwnd) = direct {
				let root = window::root(hwnd);
				// SAFETY: GetDesktopWindow has no preconditions.
				return (root != unsafe { GetDesktopWindow() }).then_some(root);
			}
			current = walker.get_parent(&current).ok()?;
			if depth < 63 {
				direct = native_window(&current);
			}
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
		Self::contained_root(self.host_root(element), call)
	}

	fn contained_root(root: Option<HWND>, call: impl FnOnce() -> CoreResult<()>) -> CoreResult<()> {
		let root = root.ok_or_else(|| {
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
						"UIA coordinate action failed and may already have taken effect; do not replay \
						 it automatically: {error}"
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

	/// WPF drops posted wheels, and `ScrollPattern` can activate its window.
	/// Only a foreground container under the point may receive these steps.
	/// `Ok(false)` and `BackgroundUnavailable` send nothing: the caller refuses
	/// the scroll so the background fallback can rerun it with a real wheel.
	pub(super) fn scroll_at_point(
		&mut self,
		root: HWND,
		point: POINT,
		horizontal: i32,
		vertical: i32,
	) -> CoreResult<bool> {
		let axes = [
			(true, horizontal, wheel_setting(SPI_GETWHEELSCROLLCHARS)),
			(false, vertical, wheel_setting(SPI_GETWHEELSCROLLLINES)),
		];
		// The takeover wheel still scrolls WPF with these settings at 0 (measured
		// on Windows 10), so this refusal leaves the scroll to the fallback.
		if axes
			.iter()
			.all(|&(_, notches, per_notch)| notches == 0 || per_notch == 0)
		{
			return Err(DesktopError::background_unavailable(
				"Windows wheel scrolling is set to 0 lines or characters per notch, so UI Automation \
				 has no step size for this scroll; no input was sent",
			));
		}
		let mut run =
			ScrollRun { cutoff: control::reply_deadline(), now: Instant::now, sent: false };
		if !window::owns_foreground(root) || !shows_at(root, point) {
			return Ok(false);
		}
		let automation = run.call(|| self.automation())?;
		let walker = run.call(|| automation.get_raw_view_walker())?;
		let Ok(hit) = run.call(|| {
			Ok::<_, DesktopError>(automation.element_from_point(Point::new(point.x, point.y)))
		})?
		else {
			return Ok(false);
		};
		let mut eligible = false;
		for (across, notches, per_notch) in axes {
			let (amount, steps) = wheel_amount(notches, per_notch);
			if steps == 0 {
				continue;
			}
			let mut element = run.call(|| Ok::<_, DesktopError>(hit.clone()))?;
			let mut found = None;
			for _ in 0..MAX_SCROLL_DEPTH {
				if let Ok(pattern) =
					run.call(|| Ok::<_, DesktopError>(element.get_pattern::<UIScrollPattern>()))?
					&& run.call(|| {
						if across {
							pattern.is_horizontally_scrollable()
						} else {
							pattern.is_vertically_scrollable()
						}
					})? {
					let container = run.call(|| Ok::<_, DesktopError>(element.clone()))?;
					found =
						bind_scroll_candidate((pattern, container), root.expose_provenance(), || {
							let raw: isize = run.call(|| element.get_native_window_handle())?.into();
							if raw != 0 {
								return Ok(Some(
									window::root(with_exposed_provenance_mut(raw as usize))
										.expose_provenance(),
								));
							}
							let Ok(parent) =
								run.call(|| Ok::<_, DesktopError>(walker.get_parent(&element)))?
							else {
								return Ok(Some(0));
							};
							element = parent;
							Ok(None)
						})?;
					break;
				}
				let raw: isize = run.call(|| element.get_native_window_handle())?.into();
				if raw != 0 && with_exposed_provenance_mut::<std::ffi::c_void>(raw as usize) == root {
					break;
				}
				let Ok(parent) = run.call(|| Ok::<_, DesktopError>(walker.get_parent(&element)))?
				else {
					break;
				};
				element = parent;
			}
			let Some((pattern, container)) = found else {
				continue;
			};
			eligible = true;
			let mut anchor = None;
			for _ in 0..steps {
				if !run.step(
					notches > 0,
					|run, fresh| {
						let position = run.call(|| {
							if across {
								pattern.get_horizontal_scroll_percent()
							} else {
								pattern.get_vertical_scroll_percent()
							}
						})?;
						if fresh {
							anchor = content_child(run, &automation, &walker, &container, point)?;
						}
						let offset = match &anchor {
							Some(anchor) => {
								let rect = run.call(|| anchor.get_bounding_rectangle())?;
								let edge = if across {
									rect.get_left()
								} else {
									rect.get_top()
								};
								(rect.get_width() > 0 && rect.get_height() > 0).then(|| -f64::from(edge))
							},
							None => None,
						};
						if !window::owns_foreground(root) || !shows_at(root, point) {
							return Err(run.failure(
								ErrorCode::BackgroundUnavailable,
								"the WPF window is no longer in front under the point",
							));
						}
						Ok(Sample { position, offset })
					},
					|| {
						if across {
							pattern.scroll(amount, ScrollAmount::NoAmount)
						} else {
							pattern.scroll(ScrollAmount::NoAmount, amount)
						}
					},
					control::wait,
				)? {
					break;
				}
			}
		}
		run.finish(eligible)
	}
}

fn bind_scroll_candidate<T>(
	candidate: T,
	root: usize,
	mut next_host: impl FnMut() -> CoreResult<Option<usize>>,
) -> CoreResult<Option<T>> {
	for _ in 0..16 {
		if let Some(host) = next_host()? {
			return Ok((host == root).then_some(candidate));
		}
	}
	Ok(None)
}

/// The most ancestors walked from a hit-tested element, both to find its scroll
/// container and back to that container from a step's anchor, so any point a
/// container was found for also yields its anchor.
const MAX_SCROLL_DEPTH: usize = 16;

/// The container's child under `point`: content that a scroll moves by what
/// it moves the view, and that rows added or removed past it and a resized
/// view leave in place. `None` when the point shows no such content, such as
/// the container's own scroll bar or a column header, which do not scroll.
fn content_child<N: Fn() -> Instant>(
	run: &ScrollRun<N>,
	automation: &UIAutomation,
	walker: &UITreeWalker,
	container: &UIElement,
	point: POINT,
) -> CoreResult<Option<UIElement>> {
	let Ok(hit) = run.call(|| {
		Ok::<_, DesktopError>(automation.element_from_point(Point::new(point.x, point.y)))
	})?
	else {
		return Ok(None);
	};
	let Some(child) = child_of(
		hit,
		|element| {
			Ok(run
				.call(|| Ok::<_, DesktopError>(walker.get_parent(element)))?
				.ok())
		},
		|parent| run.call(|| automation.compare_elements(parent, container)),
	)?
	else {
		return Ok(None);
	};
	let kind = run.call(|| child.get_control_type())?;
	Ok((!matches!(kind, ControlType::ScrollBar | ControlType::Header)).then_some(child))
}

/// `start` or its ancestor whose parent is the container, within
/// [`MAX_SCROLL_DEPTH`] parents.
fn child_of<T>(
	start: T,
	mut parent: impl FnMut(&T) -> CoreResult<Option<T>>,
	mut is_container: impl FnMut(&T) -> CoreResult<bool>,
) -> CoreResult<Option<T>> {
	let mut element = start;
	for _ in 0..MAX_SCROLL_DEPTH {
		let Some(up) = parent(&element)? else {
			return Ok(None);
		};
		if is_container(&up)? {
			return Ok(Some(element));
		}
		element = up;
	}
	Ok(None)
}

#[derive(Clone, Copy)]
struct Sample {
	/// `ScrollPattern`'s percent, read only to skip a step at the end: rows
	/// added or removed and a resized view move it too.
	position: f64,
	/// How far the step's anchor moved back: its leading edge, negated, so a
	/// forward step raises it. `None` with no anchor or an anchor not drawn.
	offset:   Option<f64>,
}

/// Every provider call, including lookups and each property read, shares
/// one operation cutoff. A late reply cannot confirm an already sent step.
struct ScrollRun<N> {
	cutoff: Option<Instant>,
	now:    N,
	sent:   bool,
}

impl<N: Fn() -> Instant> ScrollRun<N> {
	/// An unsent failure ends with the closing clause `worker.ts` drops when it
	/// reruns a `BackgroundUnavailable` refusal in takeover.
	fn failure(&self, code: ErrorCode, reason: impl std::fmt::Display) -> DesktopError {
		if self.sent {
			return DesktopError::new(
				ErrorCode::AxUnconfirmed,
				format!("{reason}; scroll sent, not confirmed; inspect before retrying"),
			);
		}
		DesktopError::new(code, format!("{reason}; nothing was sent"))
	}

	fn finish(&self, eligible: bool) -> CoreResult<bool> {
		if eligible && !self.sent {
			return Err(DesktopError::input_failed("already at the end; nothing was sent"));
		}
		Ok(self.sent)
	}

	fn check(&self) -> CoreResult<()> {
		if self.cutoff.is_some_and(|cutoff| (self.now)() >= cutoff) {
			return Err(self.failure(ErrorCode::Timeout, "the operation's time ran out"));
		}
		control::check().map_err(|error| self.failure(error.code, error.message))
	}

	fn call<T, E: std::fmt::Display>(&self, call: impl FnOnce() -> Result<T, E>) -> CoreResult<T> {
		self.check()?;
		let result = call();
		self.check()?;
		result.map_err(|error| {
			self.failure(
				ErrorCode::BackgroundUnavailable,
				format!("UI Automation unavailable ({error})"),
			)
		})
	}

	fn step(
		&mut self,
		forward: bool,
		mut sample: impl FnMut(&Self, bool) -> CoreResult<Sample>,
		send: impl FnOnce() -> uiautomation::Result<()>,
		mut wait: impl FnMut(Duration) -> CoreResult<()>,
	) -> CoreResult<bool> {
		self.check()?;
		let before = sample(self, true)?;
		self.check()?;
		if before.position < 0.0 {
			return Err(self.failure(ErrorCode::BackgroundUnavailable, "no WPF scroll position"));
		}
		if (forward && before.position >= 100.0) || (!forward && before.position <= 0.0) {
			return Ok(false);
		}
		self.sent = true;
		let result = send();
		self.check()?;
		result.map_err(|error| self.failure(ErrorCode::AxFailed, error))?;
		let Some(from) = before.offset.filter(|from| from.is_finite()) else {
			return Err(self.failure(ErrorCode::AxUnconfirmed, "no scroll offset to read back"));
		};
		let until = (self.now)() + Duration::from_millis(500);
		loop {
			let after = sample(self, false)?;
			self.check()?;
			match after
				.offset
				.filter(|to| to.is_finite())
				.map(|to| to.total_cmp(&from))
			{
				Some(Ordering::Equal) => {},
				Some(Ordering::Greater) if forward => return Ok(true),
				Some(Ordering::Less) if !forward => return Ok(true),
				_ => {
					return Err(self.failure(
						ErrorCode::AxUnconfirmed,
						"the scroll offset read back moved the other way or could not be read",
					));
				},
			}
			let now = (self.now)();
			if now >= until {
				return Err(DesktopError::input_failed(
					"a sent scroll step left the scroll offset where it was; inspect before retrying",
				));
			}
			let end = self.cutoff.map_or(until, |cutoff| cutoff.min(until));
			wait(
				end.saturating_duration_since(now)
					.min(Duration::from_millis(10)),
			)
			.map_err(|error| self.failure(error.code, error.message))?;
		}
	}
}

fn shows_at(root: HWND, point: POINT) -> bool {
	// SAFETY: WindowFromPoint takes a scalar point.
	let visible = unsafe { WindowFromPoint(point) };
	!visible.is_null() && window::root(visible) == root
}

fn wheel_setting(action: u32) -> u32 {
	let mut value = 3_u32;
	// SAFETY: these actions write one u32 to the pointer given.
	let read = unsafe { SystemParametersInfoW(action, 0, (&raw mut value).cast(), 0) };
	if read == 0 { 3 } else { value }
}

const fn wheel_amount(notches: i32, per_notch: u32) -> (ScrollAmount, u32) {
	let steps = notches.unsigned_abs();
	match (notches > 0, per_notch == u32::MAX) {
		(true, true) => (ScrollAmount::LargeIncrement, steps),
		(false, true) => (ScrollAmount::LargeDecrement, steps),
		(true, false) => (ScrollAmount::SmallIncrement, steps.saturating_mul(per_notch)),
		(false, false) => (ScrollAmount::SmallDecrement, steps.saturating_mul(per_notch)),
	}
}

fn ax_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("UI Automation failed: {error}"))
}

/// Handle for `element` carrying the `RuntimeId` that identifies it across
/// reads, or none when the element reports none. Read as a property:
/// `UIElement::get_runtime_id` leaks the array UI Automation returns.
fn uia_handle(element: UIElement) -> AxHandle {
	let runtime_id = match element
		.get_property_value(UIProperty::RuntimeId)
		.and_then(|value| value.get_value())
	{
		Ok(Value::ArrayI4(id)) if !id.is_empty() => Some(id.into_boxed_slice()),
		_ => None,
	};
	AxHandle::Uia(element, runtime_id)
}

/// Native window handle `element` represents, if any.
fn native_window(element: &UIElement) -> Option<HWND> {
	let raw: isize = element.get_native_window_handle().ok()?.into();
	(raw != 0).then(|| with_exposed_provenance_mut(raw as usize))
}

/// Presses the enabled native button `element` represents through `BM_CLICK`
/// ([`window::click_button`]) while it stays inside `top`. A `WinForms` check
/// box draws itself and keeps its state out of `BM_GETCHECK`, so its Toggle
/// state shows whether the click changed it: unread or unchanged, the click is
/// reported as unconfirmed (an app may manage the box's state itself and leave
/// it as it was).
fn press_button(element: &UIElement, button: HWND, top: HWND) -> CoreResult<()> {
	if window::native_auto_button(button) {
		return window::click_button(button, top);
	}
	let toggle = match element.get_pattern::<UITogglePattern>() {
		Ok(toggle) => toggle,
		Err(error) => {
			let kind = element.get_control_type().map_err(|error| {
				DesktopError::input_failed(format!(
					"the button's control type could not be read ({error}); nothing was clicked"
				))
			})?;
			if kind == ControlType::CheckBox {
				return Err(DesktopError::input_failed(format!(
					"the check box's Toggle pattern could not be read ({error}); nothing was clicked"
				)));
			}
			return window::click_button(button, top);
		},
	};
	let before = toggle.get_toggle_state().map_err(|error| {
		DesktopError::input_failed(format!(
			"the check box's state could not be read ({error}); nothing was clicked"
		))
	})?;
	window::click_button(button, top)?;
	match toggle.get_toggle_state() {
		Ok(after) if after != before => Ok(()),
		Ok(_) => Err(DesktopError::ax_unconfirmed(
			"the check box processed its click but its state did not change; the app may manage it \
			 itself or have refused the click; inspect the target before pressing again",
		)),
		// Not `AxUnconfirmed`: naming the target would query the same,
		// possibly unresponsive, provider again.
		Err(error) => Err(DesktopError::input_failed(format!(
			"the check box processed its click and may have changed, but its state could not be read \
			 afterwards ({error}); inspect the target before pressing again"
		))),
	}
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
		return element
			.get_pattern::<UITogglePattern>()
			.ok()
			.map(PositionlessPress::Toggle);
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
	if can_invoke
		|| can_toggle
		|| can_select
		|| can_legacy_press
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

fn pattern_value(element: &UIElement) -> Option<String> {
	element
		.get_pattern::<UIValuePattern>()
		.and_then(|pattern| pattern.get_value())
		.ok()
}

fn legacy_value(element: &UIElement) -> Option<String> {
	element
		.get_pattern::<UILegacyIAccessiblePattern>()
		.and_then(|pattern| pattern.get_value())
		.ok()
}

fn value(element: &UIElement) -> Option<String> {
	pattern_value(element)
		.filter(|value| !value.is_empty())
		.or_else(|| legacy_value(element).filter(|value| !value.is_empty()))
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
			.map(uia_handle)
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
			x:      f64::from(rect.get_left()),
			y:      f64::from(rect.get_top()),
			width:  f64::from(rect.get_right()) - f64::from(rect.get_left()),
			height: f64::from(rect.get_bottom()) - f64::from(rect.get_top()),
		});
		Ok(AxProps {
			#[cfg(test)]
			read_as_fingerprint: None,
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
			identity: None,
			partial: false,
			label_complete: false,
			selected: false,
			role_name: None,
			unread_children: 0,
		})
	}

	fn children(&mut self, handle: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let element = Self::element(handle)?;
		Ok(self
			.walker()?
			.get_children(element)
			.unwrap_or_default()
			.into_iter()
			.map(uia_handle)
			.collect())
	}

	fn parent(&mut self, handle: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let element = Self::element(handle)?;
		Ok(self.walker()?.get_parent(element).ok().map(uia_handle))
	}

	fn perform(&mut self, handle: &AxHandle, action: &str) -> CoreResult<()> {
		let element = Self::element(handle)?;
		let action = action.trim().to_ascii_lowercase();
		// Preserve containment's walker-then-HWND query order, retaining even
		// an absent direct handle so the fallback never queries it twice.
		let walker = self.walker().ok();
		let direct = walker.as_ref().and_then(|_| native_window(element));
		// A native-button candidate's Invoke lookup, made before containment and
		// reused after it: asking a provider again could reach the Invoke this
		// route avoids, which takes the foreground.
		let mut invoke = None;
		if matches!(action.as_str(), "press" | "invoke")
			&& let Some((hwnd, button)) =
				direct.and_then(|hwnd| window::native_button(hwnd).map(|state| (hwnd, state)))
		{
			// The top-level window now, before any provider call runs app code.
			let top = window::root(hwnd);
			// Only native-button candidates query Invoke before containment.
			// Other controls keep the containment guard ahead of provider calls.
			if action == "press"
				|| invoke
					.insert(element.get_pattern::<UIInvokePattern>())
					.is_ok()
			{
				return match button {
					window::NativeButton::Disabled => Err(DesktopError::input_failed(format!(
						"button {} is disabled, or its window is (behind a dialog, for instance); \
						 nothing was clicked",
						hwnd.expose_provenance()
					))),
					window::NativeButton::Enabled => press_button(element, hwnd, top),
				};
			}
		}
		let root = walker.and_then(|walker| Self::host_root_from(element, &walker, direct));
		Self::contained_root(root, || match action.as_str() {
			"press" => {
				if let Some(pattern) = positionless_press(element) {
					control::dispatching()?;
					return pattern.run().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UIInvokePattern>() {
					control::dispatching()?;
					return pattern.invoke().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UITogglePattern>() {
					control::dispatching()?;
					return pattern.toggle().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UISelectionItemPattern>() {
					control::dispatching()?;
					return pattern.select().map_err(ax_error);
				}
				let pattern = element
					.get_pattern::<UILegacyIAccessiblePattern>()
					.map_err(ax_error)?;
				if pattern.get_default_action().map_err(ax_error)?.is_empty() {
					return Err(DesktopError::ax_failed("UIA element has no default press action"));
				}
				control::dispatching()?;
				pattern.do_default_action().map_err(ax_error)
			},
			"invoke" => {
				let pattern = invoke
					.unwrap_or_else(|| element.get_pattern::<UIInvokePattern>())
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.invoke().map_err(ax_error)
			},
			"toggle" => {
				let pattern = element.get_pattern::<UITogglePattern>().map_err(ax_error)?;
				control::dispatching()?;
				pattern.toggle().map_err(ax_error)
			},
			"expand" => {
				let pattern = element
					.get_pattern::<UIExpandCollapsePattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.expand().map_err(ax_error)
			},
			"collapse" => {
				let pattern = element
					.get_pattern::<UIExpandCollapsePattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.collapse().map_err(ax_error)
			},
			"select" => {
				let pattern = element
					.get_pattern::<UISelectionItemPattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.select().map_err(ax_error)
			},
			"scrollintoview" => {
				let pattern = element
					.get_pattern::<UIScrollItemPattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.scroll_into_view().map_err(ax_error)
			},
			other => {
				Err(DesktopError::ax_failed(format!("unsupported UI Automation action '{other}'")))
			},
		})
	}

	fn set_value(&mut self, handle: &AxHandle, text: &str) -> CoreResult<()> {
		let element = Self::element(handle)?;
		let password = element.is_password().ok();
		let secure = password.unwrap_or(true);
		let hwnd = native_window(element).map(super::value_write::combo_target);
		let class = hwnd.map_or_default(window::class_name);
		let parent_class = hwnd.map_or_default(|hwnd| {
			// SAFETY: GetAncestor only queries the native control's true parent.
			window::class_name(unsafe { GetAncestor(hwnd, GA_PARENT) })
		});
		match super::value_write::route(&class, &parent_class) {
			super::value_write::ValueRoute::Combo => {
				return super::value_write::set_combo(
					hwnd.ok_or_else(|| {
						DesktopError::ax_failed(
							"combo box has no native window; select the item via press/click instead",
						)
					})?,
					text,
					element.is_enabled().map_err(ax_error)?,
					secure,
				);
			},
			super::value_write::ValueRoute::RefuseCombo => {
				return Err(DesktopError::ax_failed(
					"this combo box cannot notify the app through setValue; select the item via \
					 press/click instead",
				));
			},
			super::value_write::ValueRoute::Edit => {
				return super::value_write::set_edit(
					hwnd.ok_or_else(|| DesktopError::ax_failed("text field has no native window"))?,
					text,
					element.is_enabled().map_err(ax_error)?,
					password,
				);
			},
			super::value_write::ValueRoute::Pattern => self.contained(element, || {
				element
					.get_pattern::<UIValuePattern>()
					.and_then(|pattern| pattern.set_value(text))
					.map_err(ax_error)
			})?,
		}
		// Password providers cannot supply evidence, so do not query hidden
		// or protected representations just to discard them.
		let pattern = if password == Some(true) {
			None
		} else {
			pattern_value(element)
		};
		let legacy = if password != Some(true) && pattern.is_none() {
			legacy_value(element)
		} else {
			None
		};
		let read = pattern.as_deref().or(legacy.as_deref());
		if read.is_some_and(|read| super::value_write::rich_edit_holds(&class, text, read)) {
			return Ok(());
		}
		super::value_write::verdict(text, pattern.as_deref(), legacy.as_deref(), password)
	}

	fn focus(&mut self, handle: &AxHandle) -> CoreResult<()> {
		Self::element(handle)?.set_focus().map_err(ax_error)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		self
			.automation()?
			.element_from_point(Point::new(x.round() as i32, y.round() as i32))
			.map(uia_handle)
			.map(Some)
			.map_err(ax_error)
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self
			.automation()?
			.get_focused_element()
			.map(uia_handle)
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

	/// `RuntimeId`s are only unique among live elements. Any failure to read
	/// the stored element counts as gone: a needless new ref is harmless, a ref
	/// renewed onto another element is not.
	fn alive(&mut self, handle: &AxHandle) -> bool {
		Self::element(handle).is_ok_and(|element| element.get_process_id().is_ok())
	}
}

#[cfg(test)]
mod tests {
	use windows_sys::Win32::UI::{
		Input::KeyboardAndMouse::EnableWindow,
		WindowsAndMessaging::{BS_PUSHBUTTON, DestroyWindow},
	};

	use super::{
		super::{
			super::error::ErrorCode,
			window::tests::{ButtonThread, button, button_parent, click_messages, clicks, record},
		},
		*,
	};

	#[test]
	fn native_buttons_are_pressed_by_their_click_message_and_never_behind_a_dialog() {
		let fixture = ButtonThread::new();
		let (parent_id, pushed_id) = fixture.run(|| {
			let parent = button_parent();
			let pushed = button(parent, "BUTTON", BS_PUSHBUTTON as u32);
			record(pushed);
			(parent as usize, pushed as usize)
		});
		let parent = parent_id as HWND;
		let pushed = pushed_id as HWND;
		let mut ax = Win32Ax::new();
		let element = ax
			.automation()
			.unwrap()
			.element_from_handle(Handle::from(pushed.expose_provenance() as isize))
			.unwrap();
		let handle = uia_handle(element);

		// The button's own synchronous click must finish before the action
		// returns.
		ax.perform(&handle, "press").unwrap();
		assert_eq!(fixture.run(|| (clicks(), click_messages())), (1, 1));
		ax.perform(&handle, "invoke").unwrap();
		assert_eq!(fixture.run(|| (clicks(), click_messages())), (2, 2));

		// A form behind its modal dialog: refused with nothing sent, never
		// handed on to UI Automation.
		// SAFETY: the fixture keeps the window alive.
		unsafe { EnableWindow(parent, 0) };
		let error = ax.perform(&handle, "press").unwrap_err();
		assert!(matches!(error.code, ErrorCode::InputFailed), "{error:?}");
		assert_eq!(fixture.run(|| (clicks(), click_messages())), (2, 2));
		// SAFETY: the fixture thread owns the window.
		fixture.run(move || unsafe { DestroyWindow(parent_id as HWND) });
	}

	#[test]
	fn scroll_candidate_rejects_foreign_and_unknown_hosts() {
		for (hosts, expected) in [
			(&[None, Some(1)][..], Some("pattern")),
			(&[None, Some(2)][..], None),
			(&[Some(0)][..], None),
			(&[None; 16][..], None),
		] {
			let mut hosts = hosts.iter().copied();
			assert_eq!(
				bind_scroll_candidate("pattern", 1, || Ok(hosts.next().flatten())).unwrap(),
				expected
			);
		}
	}

	#[test]
	fn anchor_walk_reaches_any_container_the_container_walk_finds() {
		// Element `n`'s parent is `n + 1`; the container is `depth` parents
		// above the hit, as under a nested tree item.
		for (depth, expected) in [
			(1, Some(0)),
			(12, Some(11)),
			(MAX_SCROLL_DEPTH, Some(MAX_SCROLL_DEPTH - 1)),
			(MAX_SCROLL_DEPTH + 1, None),
		] {
			let child = child_of(0, |element| Ok(Some(element + 1)), |parent| Ok(*parent == depth));
			assert_eq!(child.unwrap(), expected, "container {depth} parents up");
		}
	}

	#[test]
	fn wpf_provider_failure_before_send_leaves_the_scroll_to_the_fallback() {
		let run = ScrollRun { cutoff: None, now: Instant::now, sent: false };
		let error = run
			.call(|| Err::<(), _>("provider disappeared"))
			.unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		// `worker.ts` drops this closing clause from the takeover notice.
		assert!(error.message.ends_with("; nothing was sent"), "{error}");
	}

	#[test]
	fn wpf_scroll_deadline_and_offset_readback() {
		use std::cell::Cell;

		use super::super::super::error::ErrorCode::{AxUnconfirmed, InputFailed, Timeout};

		// A list that scrolls by item, in rows: (offset, rows shown, rows). A
		// reading takes `ScrollPattern`'s percent from one layout, and the view
		// size from another, as separate getters can; then how far the anchor
		// row moved back, which is the offset in rows, if there is an anchor.
		type Layout = (f64, f64, f64);
		let coherent = |layout: Layout| (layout, layout, Some(layout.0));
		let percent = |(offset, shown, rows): Layout| 100.0 * offset / (rows - shown);
		let top = coherent((2.0, 4.0, 400.0));
		// The anchor is arbitrary; all decisions use the injected clock.
		let start = Instant::now();
		for (case, before, after, expected, reads, sends) in [
			("expired", top, top, Err(Timeout), 0, 0),
			("late", top, coherent((3.0, 4.0, 400.0)), Err(AxUnconfirmed), 3, 1),
			// A tall row leaves and five short rows fit: the same percent and view
			// size as the removal below.
			(
				"moved, one more row shown",
				coherent((4.0, 4.0, 400.0)),
				coherent((5.0, 5.0, 400.0)),
				Ok(true),
				4,
				1,
			),
			(
				"rows removed",
				coherent((4.0, 4.0, 400.0)),
				coherent((4.0, 4.0, 320.0)),
				Err(InputFailed),
				6,
				1,
			),
			(
				"rows removed, view shrank",
				coherent((10.0, 4.0, 400.0)),
				coherent((10.0, 3.0, 200.0)),
				Err(InputFailed),
				6,
				1,
			),
			(
				"torn: rows appended between the getters",
				coherent((10.0, 4.0, 400.0)),
				((10.0, 4.0, 400.0), (10.0, 4.0, 800.0), Some(10.0)),
				Err(InputFailed),
				6,
				1,
			),
			(
				"offset moved back",
				coherent((5.0, 4.0, 400.0)),
				coherent((4.0, 4.0, 400.0)),
				Err(AxUnconfirmed),
				4,
				1,
			),
			(
				"no anchor",
				((2.0, 4.0, 400.0), (2.0, 4.0, 400.0), None),
				((3.0, 4.0, 400.0), (3.0, 4.0, 400.0), None),
				Err(AxUnconfirmed),
				1,
				1,
			),
			("end", coherent((396.0, 4.0, 400.0)), top, Err(InputFailed), 2, 0),
		] {
			let cutoff = start + Duration::from_secs(1);
			let clock = Cell::new(if case == "expired" { cutoff } else { start });
			let (read_count, send_count) = (Cell::new(0), Cell::new(0));
			let mut run = ScrollRun { cutoff: Some(cutoff), now: || clock.get(), sent: false };
			let result = run.step(
				true,
				|run, _anchor| {
					let (position, _view, offset) = if run.sent { after } else { before };
					let read = |value: f64| {
						read_count.set(read_count.get() + 1);
						if run.sent && case == "late" {
							clock.set(cutoff);
						}
						Ok::<_, DesktopError>(value)
					};
					Ok(Sample {
						position: run.call(|| read(percent(position)))?,
						offset:   offset.map(|offset| run.call(|| read(offset))).transpose()?,
					})
				},
				|| {
					send_count.set(send_count.get() + 1);
					Ok(())
				},
				|_| {
					clock.set(clock.get() + Duration::from_millis(600));
					Ok(())
				},
			);
			let result = result.and_then(|moved| if moved { Ok(true) } else { run.finish(true) });
			assert_eq!(result.map_err(|error| error.code), expected, "{case}");
			assert_eq!((read_count.get(), send_count.get()), (reads, sends), "{case}");
		}
	}

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
