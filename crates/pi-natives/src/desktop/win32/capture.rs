use std::{collections::HashSet, ffi::c_void};

use image::{RgbaImage, imageops};
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use xcap::{Monitor, Window};

use super::super::{
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
};

const MAX_COMPOSITE_PIXELS: u64 = 268_435_456;
const MAX_LISTED_WINDOWS: usize = 48;
const MIN_WINDOW_EDGE: u32 = 16;

struct MonitorSnapshot {
	monitor: Monitor,
	display: DesktopDisplay,
}

fn metadata_error(what: &str, error: impl std::fmt::Display) -> DesktopError {
	DesktopError::capture_failed(format!("Win32 {what} query failed: {error}"))
}

fn monitor_name(monitor: &Monitor) -> String {
	monitor
		.friendly_name()
		.or_else(|_| monitor.name())
		.unwrap_or_else(|_| "Unknown display".to_string())
}

fn monitor_snapshots(selector: &DisplaySelector) -> CoreResult<Vec<MonitorSnapshot>> {
	let monitors = Monitor::all().map_err(|error| metadata_error("display enumeration", error))?;
	let mut snapshots = Vec::with_capacity(monitors.len());
	for monitor in monitors {
		let id = monitor
			.id()
			.map_err(|error| metadata_error("display id", error))?
			.to_string();
		if matches!(selector, DisplaySelector::Id(selected) if selected != &id) {
			continue;
		}
		let physical_x = monitor
			.x()
			.map_err(|error| metadata_error("display x", error))?;
		let physical_y = monitor
			.y()
			.map_err(|error| metadata_error("display y", error))?;
		let physical_width = monitor
			.width()
			.map_err(|error| metadata_error("display width", error))?;
		let physical_height = monitor
			.height()
			.map_err(|error| metadata_error("display height", error))?;
		let scale = f64::from(
			monitor
				.scale_factor()
				.map_err(|error| metadata_error("display scale", error))?,
		);
		if !scale.is_finite() || scale <= 0.0 {
			return Err(DesktopError::capture_failed(format!(
				"display '{id}' has invalid scale {scale}"
			)));
		}
		let x = (f64::from(physical_x) / scale).round() as i32;
		let y = (f64::from(physical_y) / scale).round() as i32;
		let width = (f64::from(physical_width) / scale).round().max(1.0) as u32;
		let height = (f64::from(physical_height) / scale).round().max(1.0) as u32;
		let is_primary = monitor
			.is_primary()
			.map_err(|error| metadata_error("primary display", error))?;
		snapshots.push(MonitorSnapshot {
			display: DesktopDisplay {
				id,
				name: monitor_name(&monitor),
				x,
				y,
				width,
				height,
				scale,
				pixel_x: 0,
				pixel_y: 0,
				pixel_width: 0,
				pixel_height: 0,
				is_primary,
			},
			monitor,
		});
	}
	if snapshots.is_empty() {
		return Err(match selector {
			DisplaySelector::All => DesktopError::capture_failed("Win32 reported no active displays"),
			DisplaySelector::Id(id) => {
				DesktopError::invalid_target(format!("selected display '{id}' is not active"))
			},
		});
	}
	snapshots.sort_by(|a, b| {
		(a.display.y, a.display.x, &a.display.id).cmp(&(b.display.y, b.display.x, &b.display.id))
	});
	Ok(snapshots)
}

fn lay_out(snapshots: &mut [MonitorSnapshot]) -> CoreResult<(u32, u32)> {
	let min_x = snapshots
		.iter()
		.map(|item| item.display.x)
		.min()
		.unwrap_or(0);
	let min_y = snapshots
		.iter()
		.map(|item| item.display.y)
		.min()
		.unwrap_or(0);
	let max_x = snapshots
		.iter()
		.map(|item| i64::from(item.display.x) + i64::from(item.display.width))
		.max()
		.unwrap_or(0);
	let max_y = snapshots
		.iter()
		.map(|item| i64::from(item.display.y) + i64::from(item.display.height))
		.max()
		.unwrap_or(0);
	let scale = snapshots
		.iter()
		.map(|item| item.display.scale)
		.fold(1.0f64, f64::max);
	if !scale.is_finite() || scale <= 0.0 {
		return Err(DesktopError::capture_failed("Win32 returned an invalid display scale"));
	}
	let width = ((max_x - i64::from(min_x)) as f64 * scale).ceil().max(1.0) as u32;
	let height = ((max_y - i64::from(min_y)) as f64 * scale).ceil().max(1.0) as u32;
	if u64::from(width) * u64::from(height) > MAX_COMPOSITE_PIXELS {
		return Err(DesktopError::capture_failed(format!(
			"Win32 composite {width}x{height} exceeds the native safety limit"
		)));
	}
	for item in snapshots {
		item.display.pixel_x = (f64::from(item.display.x - min_x) * scale).round().max(0.0) as u32;
		item.display.pixel_y = (f64::from(item.display.y - min_y) * scale).round().max(0.0) as u32;
		item.display.pixel_width = (f64::from(item.display.width) * scale).round().max(1.0) as u32;
		item.display.pixel_height = (f64::from(item.display.height) * scale).round().max(1.0) as u32;
	}
	Ok((width, height))
}

pub(super) fn displays(selector: &DisplaySelector) -> CoreResult<Vec<DesktopDisplay>> {
	let mut snapshots = monitor_snapshots(selector)?;
	let _ = lay_out(&mut snapshots)?;
	Ok(snapshots.into_iter().map(|item| item.display).collect())
}

fn hwnd_from_id(id: u32) -> *mut c_void {
	std::ptr::with_exposed_provenance_mut(id as usize)
}

fn process_id(id: u32) -> Option<u32> {
	let mut pid = 0;
	// SAFETY: The HWND comes from xcap's current top-level window enumeration;
	// this call only reads its owning process id and tolerates a teardown race.
	unsafe { GetWindowThreadProcessId(hwnd_from_id(id), &mut pid) };
	(pid != 0).then_some(pid)
}

pub(super) fn windows() -> CoreResult<Vec<DesktopWindow>> {
	let native = Window::all().map_err(|error| metadata_error("window enumeration", error))?;
	let monitor_layout = displays(&DisplaySelector::All)?;
	let mut result = Vec::new();
	let mut seen = HashSet::new();
	for window in native {
		if result.len() == MAX_LISTED_WINDOWS {
			break;
		}
		let Ok(id) = window.id() else { continue };
		if !seen.insert(id) || window.is_minimized().unwrap_or(true) {
			continue;
		}
		let (Ok(physical_x), Ok(physical_y), Ok(physical_width), Ok(physical_height)) =
			(window.x(), window.y(), window.width(), window.height())
		else {
			continue;
		};
		let scale = monitor_layout
			.iter()
			.find(|display| {
				let left = f64::from(display.x) * display.scale;
				let top = f64::from(display.y) * display.scale;
				f64::from(physical_x) >= left
					&& f64::from(physical_x) < left + f64::from(display.width) * display.scale
					&& f64::from(physical_y) >= top
					&& f64::from(physical_y) < top + f64::from(display.height) * display.scale
			})
			.map_or(1.0, |display| display.scale)
			.max(f64::EPSILON);
		let x = (f64::from(physical_x) / scale).round() as i32;
		let y = (f64::from(physical_y) / scale).round() as i32;
		let width = (f64::from(physical_width) / scale).round().max(1.0) as u32;
		let height = (f64::from(physical_height) / scale).round().max(1.0) as u32;
		if width < MIN_WINDOW_EDGE || height < MIN_WINDOW_EDGE {
			continue;
		}
		let title = window.title().unwrap_or_default();
		let app = window.app_name().unwrap_or_default();
		if title.is_empty() && app.is_empty() {
			continue;
		}
		result.push(DesktopWindow {
			id: id.to_string(),
			title,
			app,
			pid: process_id(id),
			x,
			y,
			width,
			height,
			focused: window.is_focused().unwrap_or(false),
		});
	}
	Ok(result)
}

fn capture_desktop(selector: &DisplaySelector) -> CoreResult<(RgbaImage, FrameGeometry)> {
	let mut snapshots = monitor_snapshots(selector)?;
	let (width, height) = lay_out(&mut snapshots)?;
	let mut composite = RgbaImage::new(width, height);
	for snapshot in &snapshots {
		let mut image = snapshot.monitor.capture_image().map_err(|error| {
			DesktopError::capture_failed(format!(
				"capture of display '{}' failed: {error}",
				snapshot.display.id
			))
		})?;
		if image.width() == 0 || image.height() == 0 {
			return Err(DesktopError::capture_failed(format!(
				"capture of display '{}' returned an empty image",
				snapshot.display.id
			)));
		}
		if image.width() != snapshot.display.pixel_width
			|| image.height() != snapshot.display.pixel_height
		{
			image = imageops::resize(
				&image,
				snapshot.display.pixel_width,
				snapshot.display.pixel_height,
				imageops::FilterType::Triangle,
			);
		}
		imageops::overlay(
			&mut composite,
			&image,
			i64::from(snapshot.display.pixel_x),
			i64::from(snapshot.display.pixel_y),
		);
	}
	let display_data = snapshots
		.into_iter()
		.map(|item| item.display)
		.collect::<Vec<_>>();
	let geometry = FrameGeometry::for_displays(&display_data);
	Ok((composite, geometry))
}

fn capture_window(id: &str) -> CoreResult<(RgbaImage, FrameGeometry)> {
	let numeric_id = id
		.parse::<u32>()
		.map_err(|_| DesktopError::invalid_target(format!("invalid Win32 window id '{id}'")))?;
	let native = Window::all().map_err(|error| metadata_error("window enumeration", error))?;
	let mut target = None;
	for window in native {
		if window.id().ok() == Some(numeric_id) {
			target = Some(window);
			break;
		}
	}
	let window = target.ok_or_else(|| {
		DesktopError::window_not_found(format!(
			"target window '{id}' was not found; refresh windows()"
		))
	})?;
	let image = window.capture_image().map_err(|error| {
		DesktopError::capture_failed(format!("capture of window '{id}' failed: {error}"))
	})?;
	if image.width() == 0 || image.height() == 0 {
		return Err(DesktopError::capture_failed(format!(
			"capture of window '{id}' returned an empty image"
		)));
	}
	let descriptor = windows()?
		.into_iter()
		.find(|item| item.id == id)
		.ok_or_else(|| DesktopError::window_not_found(format!("target window '{id}' disappeared")))?;
	let geometry = FrameGeometry::for_window(&descriptor, image.width(), image.height());
	Ok((image, geometry))
}

pub(super) fn capture(
	selector: &DisplaySelector,
	target: &Target,
) -> CoreResult<(RgbaImage, FrameGeometry)> {
	match target {
		Target::Desktop => capture_desktop(selector),
		Target::Window(id) => capture_window(id),
	}
}

fn all_displays() -> CoreResult<Vec<DesktopDisplay>> {
	displays(&DisplaySelector::All)
}

pub(super) fn logical_to_physical(x: f64, y: f64) -> CoreResult<(i32, i32)> {
	let displays = all_displays()?;
	let display = displays
		.iter()
		.find(|display| {
			x >= f64::from(display.x)
				&& x < f64::from(display.x) + f64::from(display.width)
				&& y >= f64::from(display.y)
				&& y < f64::from(display.y) + f64::from(display.height)
		})
		.or_else(|| displays.first())
		.ok_or_else(|| DesktopError::capture_failed("Win32 reported no active displays"))?;
	let px = x * display.scale;
	let py = y * display.scale;
	Ok((px.round() as i32, py.round() as i32))
}
