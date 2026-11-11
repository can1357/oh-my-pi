use std::sync::Arc;

use image::{Rgba, RgbaImage};
use x11rb::{
	connection::{Connection, RequestConnection as _},
	errors::ReplyError,
	protocol::{
		ErrorKind,
		randr::ConnectionExt as _,
		render::{ConnectionExt as _, QueryPictFormatsReply},
		xproto::{
			Atom, AtomEnum, ConnectionExt as _, GetImageReply, ImageFormat, ImageOrder, MapState,
			VisualClass, Window, WindowClass,
		},
	},
	rust_connection::RustConnection,
};

use crate::desktop::{
	error::{CoreResult, DesktopError},
	frame::{FrameGeometry, compose},
	linux::ax::{NativeGeometry, NativeWindows},
	types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target},
};

const MAX_WINDOWS: usize = 48;
const MIN_WINDOW_EDGE: u32 = 16;

/// A rectangle in root coordinates: x, y, width, height.
type Area = (i32, i32, u32, u32);

/// What stacks above a window ([`X11Capture::above`]).
struct Above {
	/// Another client's window overlaps it.
	covered: bool,
	/// The window's own popups over it: each window, the part of the area it
	/// covers, and its origin.
	popups:  Vec<(Window, Area, (i32, i32))>,
}

#[derive(Clone, Copy)]
struct ColorMasks {
	red:   u32,
	green: u32,
	blue:  u32,
	/// Premultiplied alpha of a 32-bit ARGB visual; 0 for opaque visuals.
	alpha: u32,
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

#[derive(Clone)]
pub struct X11Capture {
	conn:        Arc<RustConnection>,
	root:        Window,
	root_width:  u32,
	root_height: u32,
	masks:       ColorMasks,
	selector:    DisplaySelector,
	/// The selection a compositing manager owns on this screen (EWMH).
	compositor:  Atom,
	/// Render defines alpha independently of the core `TrueColor` RGB masks.
	pictformats: Option<Arc<QueryPictFormatsReply>>,
}

impl X11Capture {
	pub(crate) fn new(selector: DisplaySelector) -> CoreResult<Self> {
		Self::connect(None, selector)
	}

	fn connect(display: Option<&str>, selector: DisplaySelector) -> CoreResult<Self> {
		let (conn, screen_num) = x11rb::connect(display).map_err(|error| {
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
		let masks = ColorMasks {
			red:   visual.red_mask,
			green: visual.green_mask,
			blue:  visual.blue_mask,
			alpha: 0,
		};
		let root = screen.root;
		let root_width = u32::from(screen.width_in_pixels);
		let root_height = u32::from(screen.height_in_pixels);
		let compositor = conn
			.intern_atom(false, format!("_NET_WM_CM_S{screen_num}").as_bytes())
			.map_err(request_failed)?
			.reply()
			.map_err(request_failed)?
			.atom;
		let pictformats = if conn
			.extension_information("RENDER")
			.map_err(request_failed)?
			.is_some()
		{
			Some(Arc::new(
				conn
					.render_query_pict_formats()
					.map_err(request_failed)?
					.reply()
					.map_err(request_failed)?,
			))
		} else {
			None
		};
		let capture =
			Self { conn, root, root_width, root_height, masks, selector, compositor, pictformats };
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
					|atom| String::from_utf8_lossy_owned(atom.name),
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
		let min_x = displays.iter().map(|display| display.x).min().unwrap_or(0);
		let min_y = displays.iter().map(|display| display.y).min().unwrap_or(0);
		for display in &mut displays {
			display.pixel_x = u32::try_from(display.x - min_x).map_err(|_| {
				DesktopError::capture_failed("X11 monitor layout exceeds composite coordinate space")
			})?;
			display.pixel_y = u32::try_from(display.y - min_y).map_err(|_| {
				DesktopError::capture_failed("X11 monitor layout exceeds composite coordinate space")
			})?;
		}
		Ok(displays)
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
				.map_or_default(|reply| String::from_utf8_lossy_owned(reply.value));
			let app = self
				.property(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING, 1024)
				.map_or_default(|reply| parse_wm_class(&reply.value));
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

	pub(crate) fn capture(
		&self,
		target: &Target,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		match target {
			Target::Desktop | Target::Display(_) => {
				let explicit = target.display_selector();
				let selector = selector.or(explicit.as_ref()).unwrap_or(&self.selector);
				let focused = if matches!(selector, DisplaySelector::Active) {
					self.windows()?.into_iter().find(|window| window.focused)
				} else {
					None
				};
				let mut displays = selector.select(self.displays()?, focused.as_ref())?;
				let min_x = displays.iter().map(|display| display.x).min().unwrap_or(0);
				let min_y = displays.iter().map(|display| display.y).min().unwrap_or(0);
				for display in &mut displays {
					display.pixel_x = u32::try_from(display.x - min_x).map_err(|_| {
						DesktopError::capture_failed(
							"X11 monitor layout exceeds composite coordinate space",
						)
					})?;
					display.pixel_y = u32::try_from(display.y - min_y).map_err(|_| {
						DesktopError::capture_failed(
							"X11 monitor layout exceeds composite coordinate space",
						)
					})?;
				}
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
				let composite = compose(
					width,
					height,
					Rgba([0; 4]),
					displays.iter().map(|display| {
						let image =
							self.capture_root(display.x, display.y, display.width, display.height)?;
						Ok((image, display.pixel_x, display.pixel_y))
					}),
				)?;
				let frame = FrameGeometry::for_displays(&displays);
				Ok((composite, frame))
			},
			Target::Window(id) => {
				let client = id.parse::<Window>().map_err(|_| {
					DesktopError::window_not_found(format!("invalid X11 window id {id}"))
				})?;
				let window = self
					.windows()?
					.into_iter()
					.find(|window| window.id == *id)
					.ok_or_else(|| {
						DesktopError::window_not_found(format!("window {id} was not found"))
					})?;
				let area = clip_to_root(
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
				let (x, y, width, height) = area;
				// The root holds what is on screen, which is this window only where
				// nothing covers it. A window's own drawable holds its covered part
				// too only while a compositing manager redirects it into a pixmap.
				let above = self.above(client, area)?;
				let image = if !above.covered {
					self.capture_root(x, y, width, height)?
				} else if self.compositing()? {
					let mut image =
						self.capture_window(client, x - window.x, y - window.y, width, height)?;
					self.overlay_popups(&mut image, (x, y), above)?;
					image
				} else {
					return Err(DesktopError::capture_failed(format!(
						"window {id} is covered by another window, and without a compositing manager \
						 the X server keeps no image of its covered part; win.ax() still reads it, and \
						 a screenshot of its display shows what is on top"
					)));
				};
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
		let reply = self
			.conn
			.get_image(ImageFormat::Z_PIXMAP, self.root, x, y, edge(width)?, edge(height)?, !0)
			.map_err(request_failed)?
			.reply()
			.map_err(root_capture_failed)?;
		self.decode(&reply, width, height, self.masks)
	}

	/// A compositing manager owns this screen's `_NET_WM_CM_S<n>` selection.
	fn compositing(&self) -> CoreResult<bool> {
		let owner = self
			.conn
			.get_selection_owner(self.compositor)
			.map_err(request_failed)?
			.reply()
			.map_err(request_failed)?
			.owner;
		Ok(owner != x11rb::NONE)
	}

	/// What the server stacks above `client` at every level of its ancestry
	/// inside `area`, frames and virtual-root containers included. A window of
	/// the server's own, such as the compositing overlay, covers nothing; an
	/// override-redirect window `client`'s own process made belongs to it.
	fn above(&self, client: Window, area: Area) -> CoreResult<Above> {
		let mut child = client;
		let mut tree = self
			.conn
			.query_tree(child)
			.map_err(request_failed)?
			.reply()
			.map_err(request_failed)?;
		let mut children = Vec::new();
		while tree.parent != x11rb::NONE {
			let parent = tree.parent;
			tree = self
				.conn
				.query_tree(parent)
				.map_err(request_failed)?
				.reply()
				.map_err(request_failed)?;
			// QueryTree lists siblings bottom to top, even inside a virtual root.
			let start = tree
				.children
				.iter()
				.position(|&window| window == child)
				.map_or(tree.children.len(), |index| index + 1);
			children.extend_from_slice(&tree.children[start..]);
			child = parent;
		}
		let attributes = children
			.iter()
			.map(|&window| self.conn.get_window_attributes(window))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let geometries = children
			.iter()
			.map(|&window| self.conn.get_geometry(window))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let origins = children
			.iter()
			.map(|&window| self.conn.translate_coordinates(window, self.root, 0, 0))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let owner = |window: Window| window & !self.conn.setup().resource_id_mask;
		let mut above = Above { covered: false, popups: Vec::new() };
		for (((&window, attributes), geometry), origin) in
			children.iter().zip(attributes).zip(geometries).zip(origins)
		{
			// A window destroyed since the tree was read covers nothing.
			let (Ok(attributes), Ok(geometry)) = (attributes.reply(), geometry.reply()) else {
				continue;
			};
			if attributes.map_state != MapState::VIEWABLE
				|| attributes.class != WindowClass::INPUT_OUTPUT
				|| owner(window) == 0
			{
				continue;
			}
			let Ok(origin) = origin.reply() else {
				continue;
			};
			let border = u32::from(geometry.border_width);
			let outer = (
				i32::from(origin.dst_x) - i32::from(geometry.border_width),
				i32::from(origin.dst_y) - i32::from(geometry.border_width),
				u32::from(geometry.width) + 2 * border,
				u32::from(geometry.height) + 2 * border,
			);
			if attributes.override_redirect && owner(window) == owner(client) {
				let origin = (i32::from(origin.dst_x), i32::from(origin.dst_y));
				let inner = (origin.0, origin.1, u32::from(geometry.width), u32::from(geometry.height));
				if let Some(part) = intersect(area, inner) {
					above.popups.push((window, part, origin));
				}
			} else if intersect(area, outer).is_some() {
				above.covered = true;
			}
		}
		Ok(above)
	}

	fn overlay_popups(
		&self,
		image: &mut RgbaImage,
		(x, y): (i32, i32),
		above: Above,
	) -> CoreResult<()> {
		for (popup, (px, py, pw, ph), (ox, oy)) in above.popups {
			let part = match self.capture_window(popup, px - ox, py - oy, pw, ph) {
				Ok(part) => part,
				Err(error) => {
					// A popup unmapped or destroyed since above() covers nothing.
					match self
						.conn
						.get_window_attributes(popup)
						.map_err(request_failed)?
						.reply()
					{
						Ok(attributes) if attributes.map_state != MapState::VIEWABLE => continue,
						Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Window => {
							continue;
						},
						_ => return Err(error),
					}
				},
			};
			image::imageops::overlay(image, &part, i64::from(px - x), i64::from(py - y));
		}
		Ok(())
	}

	/// The rectangle at `x, y` inside `window`, read from its own drawable.
	fn capture_window(
		&self,
		window: Window,
		x: i32,
		y: i32,
		width: u32,
		height: u32,
	) -> CoreResult<RgbaImage> {
		let x = i16::try_from(x).map_err(|_| {
			DesktopError::capture_failed("capture origin exceeds the X11 coordinate space")
		})?;
		let y = i16::try_from(y).map_err(|_| {
			DesktopError::capture_failed("capture origin exceeds the X11 coordinate space")
		})?;
		let reply = self
			.conn
			.get_image(ImageFormat::Z_PIXMAP, window, x, y, edge(width)?, edge(height)?, !0)
			.map_err(request_failed)?
			.reply()
			.map_err(|error| {
				DesktopError::capture_failed(format!("X11 GetImage of window {window} failed: {error}"))
			})?;
		let visual = self
			.conn
			.setup()
			.roots
			.iter()
			.flat_map(|screen| &screen.allowed_depths)
			.flat_map(|depth| &depth.visuals)
			.find(|visual| visual.visual_id == reply.visual)
			.ok_or_else(|| {
				DesktopError::capture_failed("X11 setup does not describe the window's visual")
			})?;
		if visual.class != VisualClass::TRUE_COLOR {
			return Err(DesktopError::capture_failed(
				"X11 window capture requires a TrueColor visual; colormap-based visuals are \
				 unsupported",
			));
		}
		// Core visual masks say nothing about alpha, including at depth 32.
		let masks = ColorMasks {
			red:   visual.red_mask,
			green: visual.green_mask,
			blue:  visual.blue_mask,
			alpha: self
				.pictformats
				.as_deref()
				.map_or(0, |formats| visual_alpha(formats, reply.visual)),
		};
		self.decode(&reply, width, height, masks)
	}

	fn decode(
		&self,
		reply: &GetImageReply,
		width: u32,
		height: u32,
		masks: ColorMasks,
	) -> CoreResult<RgbaImage> {
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
			masks,
		)
	}
}

fn visual_alpha(formats: &QueryPictFormatsReply, visual: u32) -> u32 {
	let format = formats
		.screens
		.iter()
		.flat_map(|screen| &screen.depths)
		.flat_map(|depth| &depth.visuals)
		.find(|entry| entry.visual == visual)
		.and_then(|entry| {
			formats
				.formats
				.iter()
				.find(|format| format.id == entry.format)
		});
	format.map_or(0, |format| {
		u32::from(format.direct.alpha_mask)
			.checked_shl(u32::from(format.direct.alpha_shift))
			.unwrap_or(0)
	})
}

impl NativeWindows for X11Capture {
	fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		Self::windows(self)
	}

	fn geometry(&self, id: &str) -> Option<NativeGeometry> {
		let id = id.parse::<Window>().ok()?;
		// As `windows` lists them: a minimized or unmapped window is nowhere.
		let attributes = self.conn.get_window_attributes(id).ok()?.reply().ok()?;
		let state = self.intern("_NET_WM_STATE").ok()?;
		let hidden = self.intern("_NET_WM_STATE_HIDDEN").ok()?;
		if attributes.map_state != MapState::VIEWABLE
			|| self
				.property(id, state, AtomEnum::ATOM, 64)
				.and_then(|reply| Some(reply.value32()?.any(|item| item == hidden)))
				.unwrap_or(false)
		{
			return None;
		}
		let geometry = self.conn.get_geometry(id).ok()?.reply().ok()?;
		let origin = self
			.conn
			.translate_coordinates(id, self.root, 0, 0)
			.ok()?
			.reply()
			.ok()?;
		let shadow = self
			.intern("_GTK_FRAME_EXTENTS")
			.ok()
			.and_then(|atom| self.property(id, atom, AtomEnum::CARDINAL, 4))
			.and_then(|reply| {
				let mut extents = reply.value32()?;
				Some([extents.next()?, extents.next()?, extents.next()?, extents.next()?])
			})
			.unwrap_or_default();
		Some(NativeGeometry {
			x: i32::from(origin.dst_x),
			y: i32::from(origin.dst_y),
			width: u32::from(geometry.width),
			height: u32::from(geometry.height),
			shadow,
		})
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

fn edge(length: u32) -> CoreResult<u16> {
	u16::try_from(length)
		.map_err(|_| DesktopError::capture_failed("capture size exceeds the X11 coordinate space"))
}

fn intersect(a: Area, b: Area) -> Option<Area> {
	let left = a.0.max(b.0);
	let top = a.1.max(b.1);
	let right = (i64::from(a.0) + i64::from(a.2)).min(i64::from(b.0) + i64::from(b.2));
	let bottom = (i64::from(a.1) + i64::from(a.3)).min(i64::from(b.1) + i64::from(b.3));
	(right > i64::from(left) && bottom > i64::from(top))
		.then(|| (left, top, (right - i64::from(left)) as u32, (bottom - i64::from(top)) as u32))
}

fn parse_wm_class(value: &[u8]) -> String {
	let mut parts = value
		.split(|&byte| byte == 0)
		.filter(|part| !part.is_empty());
	let instance = parts.next();
	parts
		.next()
		.or(instance)
		.map_or_default(|part| String::from_utf8_lossy(part).into_owned())
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
	let alpha = (masks.alpha != 0)
		.then(|| ComponentMask::new("alpha", masks.alpha))
		.transpose()?;
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
			let [r, g, b] = [red.decode(value), green.decode(value), blue.decode(value)];
			match alpha.map(|alpha| alpha.decode(value)) {
				None | Some(255) => rgba.extend_from_slice(&[r, g, b, 255]),
				Some(0) => rgba.extend_from_slice(&[0; 4]),
				// ARGB visuals hold premultiplied colour; PNG wants it straight.
				Some(a) => {
					let a16 = u16::from(a);
					let straight = |c: u8| ((u16::from(c) * 255 + a16 / 2) / a16).min(255) as u8;
					rgba.extend_from_slice(&[straight(r), straight(g), straight(b), a]);
				},
			}
		}
	}
	RgbaImage::from_raw(width, height, rgba)
		.ok_or_else(|| DesktopError::capture_failed("X11 image dimensions are inconsistent"))
}

#[cfg(test)]
mod tests {
	//! The Xvfb tests start their own server and play its window manager:
	//! `cargo test -p pi-natives desktop::linux::x11::capture -- --ignored`

	use std::{
		io::{BufRead, BufReader, IoSlice},
		process::{Child, Command, Stdio},
	};

	use x11rb::{
		CURRENT_TIME,
		protocol::xproto::{ColormapAlloc, ConfigureWindowAux, CreateWindowAux, PropMode, StackMode},
		wrapper::ConnectionExt as _,
	};

	use super::*;
	use crate::desktop::error::ErrorCode;

	const RED: u32 = 0x00ff_0000;
	const BLUE: u32 = 0x0000_00ff;
	const GREY: u32 = 0x0080_8080;
	const YELLOW: u32 = 0x00ff_ff00;
	/// In red's frame-covered strip.
	const STRIP: (u32, u32) = (150, 145);
	/// Under red's own popup.
	const POPUP: (u32, u32) = (20, 20);

	struct Server(Child);

	impl Drop for Server {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	fn start_server() -> (Server, String) {
		let mut child = Command::new("Xvfb")
			.args(["-displayfd", "1", "-screen", "0", "320x320x24", "-nolisten", "tcp"])
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.expect("Xvfb starts");
		let mut number = String::new();
		BufReader::new(child.stdout.take().expect("Xvfb stdout"))
			.read_line(&mut number)
			.expect("Xvfb reports its display");
		(Server(child), format!(":{}", number.trim()))
	}

	fn window(
		conn: &RustConnection,
		parent: Window,
		(x, y, width, height): (i16, i16, u16, u16),
		aux: &CreateWindowAux,
	) -> Window {
		let id = conn.generate_id().expect("window id");
		conn
			.create_window(
				x11rb::COPY_DEPTH_FROM_PARENT,
				id,
				parent,
				x,
				y,
				width,
				height,
				0,
				WindowClass::INPUT_OUTPUT,
				x11rb::COPY_FROM_PARENT,
				aux,
			)
			.expect("create window");
		conn.map_window(id).expect("map window");
		id
	}

	/// A red window whose bottom strip only the grey title bar of a framed
	/// blue window covers, both listed in `_NET_CLIENT_LIST_STACKING`, and a
	/// yellow override-redirect popup of red's client over red.
	fn covered_pair(conn: &RustConnection) -> (Window, Window, Window) {
		let root = conn.setup().roots[0].root;
		let red = window(conn, root, (0, 0, 200, 150), &CreateWindowAux::new().background_pixel(RED));
		let frame =
			window(conn, root, (100, 140, 200, 160), &CreateWindowAux::new().background_pixel(GREY));
		let blue =
			window(conn, frame, (0, 10, 200, 150), &CreateWindowAux::new().background_pixel(BLUE));
		window(
			conn,
			root,
			(10, 10, 40, 30),
			&CreateWindowAux::new()
				.background_pixel(YELLOW)
				.override_redirect(1),
		);
		let stacking = conn
			.intern_atom(false, b"_NET_CLIENT_LIST_STACKING")
			.expect("intern")
			.reply()
			.expect("atom")
			.atom;
		conn
			.change_property32(PropMode::REPLACE, root, stacking, AtomEnum::WINDOW, &[red, blue])
			.expect("list windows");
		conn.sync().expect("sync");
		(red, blue, frame)
	}

	fn pixel(image: &RgbaImage, (x, y): (u32, u32)) -> [u8; 4] {
		image.get_pixel(x, y).0
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn covered_window_without_a_compositing_manager_is_reported_covered() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let (red, blue, _) = covered_pair(&wm);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(blue.to_string()), None)
			.expect("uncovered window");
		assert_eq!(pixel(&image, (50, 50)), [0, 0, 255, 255]);

		let error = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect_err("a window under another's frame");
		assert_eq!(error.code, ErrorCode::CaptureFailed);
		assert!(error.message.contains("covered"), "{}", error.message);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn covered_window_inside_a_virtual_root_is_reported_covered() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let (red, ..) = covered_pair(&wm);
		let root = wm.setup().roots[0].root;
		let children = wm
			.query_tree(root)
			.expect("root tree")
			.reply()
			.expect("root children")
			.children;
		let virtual_root =
			window(&wm, root, (30, 40, 290, 280), &CreateWindowAux::new().background_pixel(0));
		for child in children {
			let geometry = wm
				.get_geometry(child)
				.expect("geometry")
				.reply()
				.expect("child geometry");
			wm.reparent_window(child, virtual_root, geometry.x, geometry.y)
				.expect("reparent");
			wm.map_window(child).expect("remap");
		}
		let atom = wm
			.intern_atom(false, b"_NET_VIRTUAL_ROOTS")
			.expect("intern")
			.reply()
			.expect("atom")
			.atom;
		wm.change_property32(PropMode::REPLACE, root, atom, AtomEnum::WINDOW, &[virtual_root])
			.expect("virtual roots");
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let error = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect_err("a sibling inside the virtual root covers red");
		assert_eq!(error.code, ErrorCode::CaptureFailed);
		assert!(error.message.contains("covered"), "{}", error.message);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn covered_window_with_a_directcolor_visual_is_rejected() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let root = wm.setup().roots[0].root;
		let (depth, visual) = wm.setup().roots[0]
			.allowed_depths
			.iter()
			.find_map(|depth| {
				depth
					.visuals
					.iter()
					.find(|visual| visual.class == VisualClass::DIRECT_COLOR)
					.map(|visual| (depth.depth, visual.visual_id))
			})
			.expect("Xvfb provides a DirectColor visual");
		let colormap = wm.generate_id().expect("colormap id");
		wm.create_colormap(ColormapAlloc::NONE, colormap, root, visual)
			.expect("create colormap")
			.check()
			.expect("colormap accepted");
		become_compositing_manager(&wm);
		let target = wm.generate_id().expect("window id");
		wm.create_window(
			depth,
			target,
			root,
			0,
			0,
			200,
			150,
			0,
			WindowClass::INPUT_OUTPUT,
			visual,
			&CreateWindowAux::new()
				.colormap(colormap)
				.background_pixel(RED)
				.border_pixel(0),
		)
		.expect("create DirectColor window")
		.check()
		.expect("DirectColor window accepted");
		wm.map_window(target).expect("map target");
		window(&wm, root, (100, 100, 200, 150), &CreateWindowAux::new().background_pixel(BLUE));
		let stacking = wm
			.intern_atom(false, b"_NET_CLIENT_LIST_STACKING")
			.expect("intern")
			.reply()
			.expect("atom")
			.atom;
		wm.change_property32(PropMode::REPLACE, root, stacking, AtomEnum::WINDOW, &[target])
			.expect("list target");
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let error = capture
			.capture(&Target::Window(target.to_string()), None)
			.expect_err("DirectColor indexes cannot be decoded as RGB components");
		assert_eq!(error.code, ErrorCode::CaptureFailed);
		assert!(error.message.contains("TrueColor"), "{}", error.message);
		assert!(error.message.contains("colormap"), "{}", error.message);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn covered_window_follows_the_servers_stacking_and_keeps_its_popups() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let (red, _, frame) = covered_pair(&wm);
		// Blue moved over red but stacked below it, while the stacking list still
		// says blue is on top.
		wm.configure_window(frame, &ConfigureWindowAux::new().y(60).stack_mode(StackMode::BELOW))
			.expect("lower");
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("a window on top");
		assert_eq!(pixel(&image, STRIP), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, POPUP), [255, 255, 0, 255]);
	}

	/// Does what a compositing manager does on start: redirects every top-level
	/// into a pixmap of its own and takes the screen's `_NET_WM_CM_S0`.
	fn become_compositing_manager(conn: &RustConnection) {
		let root = conn.setup().roots[0].root;
		let opcode = conn
			.extension_information("Composite")
			.expect("query Composite")
			.expect("Xvfb has Composite")
			.major_opcode;
		// CompositeRedirectSubwindows(root, Manual): minor opcode 2, three words.
		let mut request = vec![opcode, 2];
		request.extend_from_slice(&3u16.to_ne_bytes());
		request.extend_from_slice(&root.to_ne_bytes());
		request.extend_from_slice(&[1, 0, 0, 0]);
		conn
			.send_request_without_reply(&[IoSlice::new(&request)], Vec::new())
			.expect("redirect")
			.check()
			.expect("redirect accepted");
		let owner = conn.generate_id().expect("owner id");
		conn
			.create_window(
				0,
				owner,
				root,
				0,
				0,
				1,
				1,
				0,
				WindowClass::INPUT_ONLY,
				x11rb::COPY_FROM_PARENT,
				&CreateWindowAux::new(),
			)
			.expect("owner window");
		let selection = conn
			.intern_atom(false, b"_NET_WM_CM_S0")
			.expect("intern")
			.reply()
			.expect("atom")
			.atom;
		conn
			.set_selection_owner(owner, selection, CURRENT_TIME)
			.expect("own selection");
		conn.sync().expect("sync");
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn covered_window_under_a_compositing_manager_is_read_from_its_own_pixels() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		become_compositing_manager(&wm);
		let (red, ..) = covered_pair(&wm);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("covered window");
		assert_eq!(image.dimensions(), (200, 150));
		assert_eq!(pixel(&image, STRIP), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, POPUP), [255, 255, 0, 255]);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn popup_unmapped_after_stacking_is_read_does_not_fail_capture() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		become_compositing_manager(&wm);
		let (red, ..) = covered_pair(&wm);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let above = capture.above(red, (0, 0, 200, 150)).expect("stacking");
		assert!(above.covered);
		assert_eq!(above.popups.len(), 1);
		let popup = above.popups[0].0;
		let mut image = capture
			.capture_window(red, 0, 0, 200, 150)
			.expect("target pixels");

		wm.unmap_window(popup).expect("unmap popup");
		wm.sync().expect("popup is unmapped before GetImage");
		capture
			.overlay_popups(&mut image, (0, 0), above)
			.expect("capture without vanished popup");

		assert_eq!(image.dimensions(), (200, 150));
		assert_eq!(pixel(&image, STRIP), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, POPUP), [255, 0, 0, 255]);

		wm.map_window(popup).expect("remap popup");
		wm.sync().expect("popup is mapped");
		let above = capture
			.above(red, (0, 0, 200, 150))
			.expect("stacking before destroy");
		assert_eq!(above.popups.len(), 1);
		wm.destroy_window(popup).expect("destroy popup");
		wm.sync().expect("popup is destroyed before GetImage");
		capture
			.overlay_popups(&mut image, (0, 0), above)
			.expect("capture without destroyed popup");
		assert_eq!(pixel(&image, POPUP), [255, 0, 0, 255]);
	}

	#[test]
	fn render_format_controls_alpha_not_unused_rgb_bits() {
		use x11rb::protocol::render::{
			Directformat, Pictdepth, Pictforminfo, Pictscreen, Pictvisual,
		};

		let mut formats = QueryPictFormatsReply {
			formats: vec![Pictforminfo {
				id: 1,
				direct: Directformat { alpha_shift: 28, alpha_mask: 0xf, ..Default::default() },
				..Default::default()
			}],
			screens: vec![Pictscreen {
				fallback: 0,
				depths:   vec![Pictdepth {
					depth:   32,
					visuals: vec![Pictvisual { visual: 7, format: 1 }],
				}],
			}],
			..Default::default()
		};
		let mut masks = ColorMasks {
			red:   0x00ff_0000,
			green: 0x0000_ff00,
			blue:  0x0000_00ff,
			alpha: visual_alpha(&formats, 7),
		};
		assert_eq!(masks.alpha, 0xf000_0000);
		let image = zpixmap_to_rgba(&0xfaff_0000u32.to_le_bytes(), 1, 1, 32, 32, 32, true, masks)
			.expect("padding does not affect alpha");
		assert_eq!(pixel(&image, (0, 0)), [255, 0, 0, 255]);
		formats.formats[0].direct.alpha_mask = 0;
		masks.alpha = visual_alpha(&formats, 7);
		let image = zpixmap_to_rgba(&RED.to_le_bytes(), 1, 1, 32, 32, 32, true, masks)
			.expect("opaque depth-32 format");
		assert_eq!(pixel(&image, (0, 0)), [255, 0, 0, 255]);
		assert_eq!(visual_alpha(&formats, 99), 0);
	}

	#[test]
	fn argb_pixels_come_out_with_straight_alpha() {
		let masks = ColorMasks {
			red:   0x00ff_0000,
			green: 0x0000_ff00,
			blue:  0x0000_00ff,
			alpha: 0xff00_0000,
		};
		let data: Vec<u8> = [0x8080_0000u32, 0, 0xffff_0000]
			.iter()
			.flat_map(|pixel| pixel.to_le_bytes())
			.collect();
		let image = zpixmap_to_rgba(&data, 3, 1, 32, 32, 32, true, masks).expect("decode");
		assert_eq!(image.as_raw().as_slice(), [255, 0, 0, 128, 0, 0, 0, 0, 255, 0, 0, 255]);
	}
}
