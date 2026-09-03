use std::sync::Arc;

use image::{RgbaImage, imageops};
use x11rb::{
	connection::Connection,
	errors::ReplyError,
	protocol::{
		ErrorKind,
		randr::ConnectionExt as _,
		xproto::{
			Atom, AtomEnum, ConnectionExt as _, ImageFormat, ImageOrder, MapState, VisualClass, Window,
		},
	},
	rust_connection::RustConnection,
};

use crate::desktop::{
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
};

const MAX_WINDOWS: usize = 48;
const MIN_WINDOW_EDGE: u32 = 16;

#[derive(Clone, Copy)]
struct ColorMasks {
	red:   u32,
	green: u32,
	blue:  u32,
}

#[derive(Clone, Copy)]
struct ComponentMask {
	mask:  u32,
	shift: u32,
	max:   u32,
}

impl ComponentMask {
	fn new(name: &str, mask: u32) -> CoreResult<Self> {
		if mask == 0 {
			return Err(DesktopError::capture_failed(format!("X11 TrueColor {name} mask is zero")));
		}
		let shift = mask.trailing_zeros();
		let max = mask >> shift;
		if max & max.wrapping_add(1) != 0 {
			return Err(DesktopError::capture_failed(format!(
				"X11 TrueColor {name} mask {mask:#x} is not contiguous"
			)));
		}
		Ok(Self { mask, shift, max })
	}

	fn decode(self, pixel: u32) -> u8 {
		let component = (pixel & self.mask) >> self.shift;
		((u64::from(component) * 255 + u64::from(self.max) / 2) / u64::from(self.max)) as u8
	}
}

pub struct X11Capture {
	conn:        Arc<RustConnection>,
	root:        Window,
	root_width:  u32,
	root_height: u32,
	masks:       ColorMasks,
	selector:    DisplaySelector,
}

impl X11Capture {
	pub(crate) fn new(selector: DisplaySelector) -> CoreResult<Self> {
		let (conn, screen_num) = x11rb::connect(None).map_err(|error| {
			DesktopError::capture_failed(format!(
				"X11 connection failed; ensure DISPLAY points at a reachable X server: {error}"
			))
		})?;
		let conn = Arc::new(conn);
		let screen = conn
			.setup()
			.roots
			.get(screen_num)
			.ok_or_else(|| DesktopError::capture_failed("X11 setup reported no default screen"))?;
		let visual = screen
			.allowed_depths
			.iter()
			.flat_map(|depth| &depth.visuals)
			.find(|visual| visual.visual_id == screen.root_visual)
			.ok_or_else(|| {
				DesktopError::capture_failed("X11 setup does not describe the root visual")
			})?;
		if visual.class != VisualClass::TRUE_COLOR {
			return Err(DesktopError::capture_failed(format!(
				"unsupported X11 root visual class {:?}; TrueColor is required",
				visual.class
			)));
		}
		let masks =
			ColorMasks { red: visual.red_mask, green: visual.green_mask, blue: visual.blue_mask };
		let root = screen.root;
		let root_width = u32::from(screen.width_in_pixels);
		let root_height = u32::from(screen.height_in_pixels);
		let capture = Self { conn, root, root_width, root_height, masks, selector };
		capture.capture_root(0, 0, 1, 1)?;
		Ok(capture)
	}

	pub(crate) fn connection(&self) -> Arc<RustConnection> {
		Arc::clone(&self.conn)
	}

	pub(crate) const fn root(&self) -> Window {
		self.root
	}

	pub(crate) fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
		let reply = self
			.conn
			.randr_get_monitors(self.root, true)
			.map_err(request_failed)?
			.reply()
			.map_err(|error| {
				DesktopError::capture_failed(format!("RandR monitor enumeration failed: {error}"))
			})?;
		let mut displays = Vec::with_capacity(reply.monitors.len().max(1));
		for monitor in reply.monitors {
			let name = self
				.conn
				.get_atom_name(monitor.name)
				.ok()
				.and_then(|cookie| cookie.reply().ok())
				.map_or_else(
					|| format!("Monitor {}", monitor.name),
					|atom| String::from_utf8_lossy(&atom.name).into_owned(),
				);
			displays.push(DesktopDisplay {
				id: monitor.name.to_string(),
				name,
				x: i32::from(monitor.x),
				y: i32::from(monitor.y),
				width: u32::from(monitor.width),
				height: u32::from(monitor.height),
				scale: 1.0,
				pixel_x: 0,
				pixel_y: 0,
				pixel_width: u32::from(monitor.width),
				pixel_height: u32::from(monitor.height),
				is_primary: monitor.primary,
			});
		}
		if displays.is_empty() {
			displays.push(DesktopDisplay {
				id:           "0".into(),
				name:         "Screen".into(),
				x:            0,
				y:            0,
				width:        self.root_width,
				height:       self.root_height,
				scale:        1.0,
				pixel_x:      0,
				pixel_y:      0,
				pixel_width:  self.root_width,
				pixel_height: self.root_height,
				is_primary:   true,
			});
		}
		let mut selected = match &self.selector {
			DisplaySelector::All => displays,
			DisplaySelector::Id(wanted) => displays
				.into_iter()
				.filter(|display| display.id == *wanted || display.name == *wanted)
				.collect(),
		};
		if selected.is_empty() {
			return Err(DesktopError::capture_failed("configured X11 display was not found"));
		}
		let min_x = selected.iter().map(|display| display.x).min().unwrap_or(0);
		let min_y = selected.iter().map(|display| display.y).min().unwrap_or(0);
		for display in &mut selected {
			display.pixel_x = u32::try_from(display.x - min_x).map_err(|_| {
				DesktopError::capture_failed("X11 monitor layout exceeds composite coordinate space")
			})?;
			display.pixel_y = u32::try_from(display.y - min_y).map_err(|_| {
				DesktopError::capture_failed("X11 monitor layout exceeds composite coordinate space")
			})?;
		}
		Ok(selected)
	}

	pub(crate) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		let stacking = self.intern("_NET_CLIENT_LIST_STACKING")?;
		let fallback = self.intern("_NET_CLIENT_LIST")?;
		let clients = self
			.property(self.root, stacking, AtomEnum::WINDOW, 4096)
			.or_else(|| self.property(self.root, fallback, AtomEnum::WINDOW, 4096));
		let Some(clients) = clients else {
			return Ok(Vec::new());
		};
		let Some(ids) = clients.value32() else {
			return Ok(Vec::new());
		};
		let mut ids: Vec<Window> = ids.collect();
		ids.reverse();

		let active_atom = self.intern("_NET_ACTIVE_WINDOW")?;
		let active = self
			.property(self.root, active_atom, AtomEnum::WINDOW, 1)
			.and_then(|reply| reply.value32()?.next());
		let name_atom = self.intern("_NET_WM_NAME")?;
		let utf8_atom = self.intern("UTF8_STRING")?;
		let state_atom = self.intern("_NET_WM_STATE")?;
		let hidden_atom = self.intern("_NET_WM_STATE_HIDDEN")?;
		let pid_atom = self.intern("_NET_WM_PID")?;

		let mut windows = Vec::with_capacity(ids.len().min(MAX_WINDOWS));
		for id in ids {
			if windows.len() == MAX_WINDOWS {
				break;
			}
			let Some(attributes) = self
				.conn
				.get_window_attributes(id)
				.ok()
				.and_then(|c| c.reply().ok())
			else {
				continue;
			};
			let Some(geometry) = self.conn.get_geometry(id).ok().and_then(|c| c.reply().ok()) else {
				continue;
			};
			let Some(origin) = self
				.conn
				.translate_coordinates(id, self.root, 0, 0)
				.ok()
				.and_then(|c| c.reply().ok())
			else {
				continue;
			};
			let width = u32::from(geometry.width);
			let height = u32::from(geometry.height);
			if width < MIN_WINDOW_EDGE || height < MIN_WINDOW_EDGE {
				continue;
			}
			let x = i32::from(origin.dst_x);
			let y = i32::from(origin.dst_y);
			if x >= i32::try_from(self.root_width).unwrap_or(i32::MAX)
				|| y >= i32::try_from(self.root_height).unwrap_or(i32::MAX)
				|| x.saturating_add(i32::try_from(width).unwrap_or(i32::MAX)) <= 0
				|| y.saturating_add(i32::try_from(height).unwrap_or(i32::MAX)) <= 0
			{
				continue;
			}
			let hidden = self
				.property(id, state_atom, AtomEnum::ATOM, 64)
				.and_then(|reply| Some(reply.value32()?.any(|state| state == hidden_atom)))
				.unwrap_or(false);
			if attributes.map_state != MapState::VIEWABLE || hidden {
				continue;
			}
			let title = self
				.property(id, name_atom, utf8_atom, 1024)
				.or_else(|| self.property(id, AtomEnum::WM_NAME.into(), AtomEnum::ANY, 1024))
				.map(|reply| String::from_utf8_lossy(&reply.value).into_owned())
				.unwrap_or_default();
			let app = self
				.property(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING, 1024)
				.map(|reply| parse_wm_class(&reply.value))
				.unwrap_or_default();
			let pid = self
				.property(id, pid_atom, AtomEnum::CARDINAL, 1)
				.and_then(|reply| reply.value32()?.next());
			windows.push(DesktopWindow {
				id: id.to_string(),
				title,
				app,
				pid,
				x,
				y,
				width,
				height,
				focused: active == Some(id),
			});
		}
		Ok(windows)
	}

	pub(crate) fn capture(&self, target: &Target) -> CoreResult<(RgbaImage, FrameGeometry)> {
		match target {
			Target::Desktop => {
				let displays = self.displays()?;
				let width = displays
					.iter()
					.map(|display| display.pixel_x.saturating_add(display.pixel_width))
					.max()
					.unwrap_or(1);
				let height = displays
					.iter()
					.map(|display| display.pixel_y.saturating_add(display.pixel_height))
					.max()
					.unwrap_or(1);
				let mut composite = RgbaImage::new(width, height);
				for display in &displays {
					let image =
						self.capture_root(display.x, display.y, display.width, display.height)?;
					imageops::replace(
						&mut composite,
						&image,
						i64::from(display.pixel_x),
						i64::from(display.pixel_y),
					);
				}
				let frame = FrameGeometry::for_displays(&displays);
				Ok((composite, frame))
			},
			Target::Window(id) => {
				let window = self
					.windows()?
					.into_iter()
					.find(|window| window.id == *id)
					.ok_or_else(|| {
						DesktopError::window_not_found(format!("window {id} was not found"))
					})?;
				let (x, y, width, height) = clip_to_root(
					window.x,
					window.y,
					window.width,
					window.height,
					self.root_width,
					self.root_height,
				)
				.ok_or_else(|| {
					DesktopError::capture_failed(format!("window {id} has no visible root area"))
				})?;
				let image = self.capture_root(x, y, width, height)?;
				let frame_window = DesktopWindow { x, y, width, height, ..window };
				let frame = FrameGeometry::for_window(&frame_window, image.width(), image.height());
				Ok((image, frame))
			},
		}
	}

	fn intern(&self, name: &str) -> CoreResult<Atom> {
		self
			.conn
			.intern_atom(false, name.as_bytes())
			.map_err(request_failed)?
			.reply()
			.map(|reply| reply.atom)
			.map_err(request_failed)
	}

	fn property(
		&self,
		window: Window,
		property: Atom,
		type_: impl Into<Atom>,
		length: u32,
	) -> Option<x11rb::protocol::xproto::GetPropertyReply> {
		let reply = self
			.conn
			.get_property(false, window, property, type_, 0, length)
			.ok()?
			.reply()
			.ok()?;
		(reply.value_len > 0).then_some(reply)
	}

	fn capture_root(&self, x: i32, y: i32, width: u32, height: u32) -> CoreResult<RgbaImage> {
		let x = i16::try_from(x).map_err(|_| {
			DesktopError::capture_failed("capture origin exceeds the X11 coordinate space")
		})?;
		let y = i16::try_from(y).map_err(|_| {
			DesktopError::capture_failed("capture origin exceeds the X11 coordinate space")
		})?;
		let width16 = u16::try_from(width).map_err(|_| {
			DesktopError::capture_failed("capture width exceeds the X11 coordinate space")
		})?;
		let height16 = u16::try_from(height).map_err(|_| {
			DesktopError::capture_failed("capture height exceeds the X11 coordinate space")
		})?;
		let reply = self
			.conn
			.get_image(ImageFormat::Z_PIXMAP, self.root, x, y, width16, height16, !0)
			.map_err(request_failed)?
			.reply()
			.map_err(root_capture_failed)?;
		let setup = self.conn.setup();
		let format = setup
			.pixmap_formats
			.iter()
			.find(|format| format.depth == reply.depth)
			.ok_or_else(|| {
				DesktopError::capture_failed(format!(
					"X server advertises no pixmap format for depth {}",
					reply.depth
				))
			})?;
		zpixmap_to_rgba(
			&reply.data,
			width,
			height,
			reply.depth,
			format.bits_per_pixel,
			format.scanline_pad,
			setup.image_byte_order == ImageOrder::LSB_FIRST,
			self.masks,
		)
	}
}

fn request_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::capture_failed(format!("X11 request failed: {error}"))
}

fn root_capture_failed(error: ReplyError) -> DesktopError {
	if let ReplyError::X11Error(x11) = &error
		&& matches!(x11.error_kind, ErrorKind::Match | ErrorKind::Drawable)
	{
		DesktopError::capture_failed(
			"X11 root window is not a readable drawable; rootless XWayland capture requires the \
			 Wayland portal backend",
		)
	} else {
		DesktopError::capture_failed(format!("X11 GetImage failed: {error}"))
	}
}

fn clip_to_root(
	x: i32,
	y: i32,
	width: u32,
	height: u32,
	root_width: u32,
	root_height: u32,
) -> Option<(i32, i32, u32, u32)> {
	let left = i64::from(x).max(0);
	let top = i64::from(y).max(0);
	let right = (i64::from(x) + i64::from(width)).min(i64::from(root_width));
	let bottom = (i64::from(y) + i64::from(height)).min(i64::from(root_height));
	(right > left && bottom > top).then_some((
		left as i32,
		top as i32,
		(right - left) as u32,
		(bottom - top) as u32,
	))
}

fn parse_wm_class(value: &[u8]) -> String {
	let mut parts = value
		.split(|&byte| byte == 0)
		.filter(|part| !part.is_empty());
	let instance = parts.next();
	parts
		.next()
		.or(instance)
		.map(|part| String::from_utf8_lossy(part).into_owned())
		.unwrap_or_default()
}

fn zpixmap_to_rgba(
	data: &[u8],
	width: u32,
	height: u32,
	depth: u8,
	bits_per_pixel: u8,
	scanline_pad: u8,
	lsb_first: bool,
	masks: ColorMasks,
) -> CoreResult<RgbaImage> {
	if !(24..=32).contains(&depth) {
		return Err(DesktopError::capture_failed(format!(
			"unsupported X11 image depth {depth}; TrueColor depth 24 through 32 is required"
		)));
	}
	let bytes_per_pixel = match bits_per_pixel {
		24 => 3usize,
		32 => 4usize,
		other => {
			return Err(DesktopError::capture_failed(format!(
				"unsupported X11 pixel size of {other} bits per pixel"
			)));
		},
	};
	let red = ComponentMask::new("red", masks.red)?;
	let green = ComponentMask::new("green", masks.green)?;
	let blue = ComponentMask::new("blue", masks.blue)?;
	if masks.red & masks.green != 0 || masks.red & masks.blue != 0 || masks.green & masks.blue != 0 {
		return Err(DesktopError::capture_failed("X11 TrueColor masks overlap"));
	}
	let pad_bits = usize::from(scanline_pad).max(8);
	let stride = ((width as usize) * usize::from(bits_per_pixel)).div_ceil(pad_bits) * pad_bits / 8;
	let needed = stride.saturating_mul(height as usize);
	if needed > data.len() {
		return Err(DesktopError::capture_failed(format!(
			"X11 image data is truncated: expected {needed} bytes, got {}",
			data.len()
		)));
	}
	let mut rgba = Vec::with_capacity(
		(width as usize)
			.saturating_mul(height as usize)
			.saturating_mul(4),
	);
	for row in data.chunks_exact(stride).take(height as usize) {
		for pixel in row[..(width as usize) * bytes_per_pixel].chunks_exact(bytes_per_pixel) {
			let value = if lsb_first {
				pixel
					.iter()
					.rev()
					.fold(0u32, |acc, &byte| acc << 8 | u32::from(byte))
			} else {
				pixel
					.iter()
					.fold(0u32, |acc, &byte| acc << 8 | u32::from(byte))
			};
			rgba.extend_from_slice(&[red.decode(value), green.decode(value), blue.decode(value), 255]);
		}
	}
	RgbaImage::from_raw(width, height, rgba)
		.ok_or_else(|| DesktopError::capture_failed("X11 image dimensions are inconsistent"))
}
