use std::sync::Arc;

use image::{Rgba, RgbaImage};
use x11rb::{
	connection::{Connection, RequestConnection as _},
	cookie::Cookie,
	errors::ReplyError,
	protocol::{
		ErrorKind,
		composite::{self, ConnectionExt as _},
		randr::ConnectionExt as _,
		render::{ConnectionExt as _, QueryPictFormatsReply},
		shape::{self, ConnectionExt as _, GetRectanglesReply, QueryExtentsReply},
		xproto::{
			Atom, AtomEnum, ConnectionExt as _, Drawable, GetImageReply, ImageFormat, ImageOrder,
			MapState, Pixmap, Rectangle, VisualClass, Visualid, Window, WindowClass,
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

/// `client`'s ancestry and what stacks above it ([`X11Capture::tree`]).
struct Tree {
	/// `client`, its parent, and so on up to a child of the root.
	chain:    Vec<Window>,
	/// Every window stacked above the chain, with the index in `chain` of the
	/// window it is a sibling of.
	siblings: Vec<(usize, Window)>,
}

/// A window of [`Tree::siblings`] over the capture area.
struct Over {
	/// Index in [`Tree::chain`] of the window it is a sibling of.
	level:  usize,
	window: Window,
	/// The part of the area its rectangle, border included, covers.
	part:   Area,
	/// Its origin inside the border, in root coordinates.
	origin: (i32, i32),
	border: i32,
}

/// What stacks above a window over its area ([`X11Capture::above`]).
struct Above {
	/// Other clients' windows.
	covers: Vec<Over>,
	/// The window's own override-redirect popups.
	popups: Vec<Over>,
}

/// A window's bounding shape, requested ([`X11Capture::request_shape`]).
struct ShapeRequest<'a> {
	extents:    Cookie<'a, RustConnection, QueryExtentsReply>,
	rectangles: Cookie<'a, RustConnection, GetRectanglesReply>,
}

impl ShapeRequest<'_> {
	/// The shape's rectangles, relative to the window's origin inside its
	/// border; `None` for a window with the default shape, its rectangle. The X
	/// server lists that default without the right and bottom border, so it is
	/// never read.
	fn reply(self) -> Result<Option<Vec<Rectangle>>, ReplyError> {
		let shaped = self.extents.reply()?.bounding_shaped;
		let rectangles = self.rectangles.reply()?.rectangles;
		Ok(shaped.then_some(rectangles))
	}
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
	/// The server names a window's pixmap (`CompositeNameWindowPixmap`).
	composite:   bool,
	/// The server keeps window shapes (the Shape extension).
	shape:       bool,
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
		let composite = conn
			.extension_information(composite::X11_EXTENSION_NAME)
			.map_err(request_failed)?
			.is_some()
			&& {
				let version = conn
					.composite_query_version(0, 2)
					.map_err(request_failed)?
					.reply()
					.map_err(request_failed)?;
				(version.major_version, version.minor_version) >= (0, 2)
			};
		let shape = conn
			.extension_information(shape::X11_EXTENSION_NAME)
			.map_err(request_failed)?
			.is_some();
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
		let capture = Self {
			conn,
			root,
			root_width,
			root_height,
			masks,
			selector,
			composite,
			shape,
			pictformats,
		};
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
				let (image, (x, y, width, height)) = self.capture_held(client, id, || {})?;
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
		self.request_root(x, y, width, height)?.finish(self)
	}

	/// The root rectangle at `x, y`, requested now and read by
	/// [`ImageRead::finish`].
	fn request_root(&self, x: i32, y: i32, width: u32, height: u32) -> CoreResult<ImageRead<'_>> {
		let (x, y) = x11_origin(x, y)?;
		let cookie = self
			.conn
			.as_ref()
			.get_image(ImageFormat::Z_PIXMAP, self.root, x, y, edge(width)?, edge(height)?, !0)
			.map_err(request_failed)?;
		Ok(ImageRead { cookie, masks: self.masks, width, height, drawable: None })
	}

	/// `client`'s pixels, with the server held from the stacking check until
	/// the reads are queued, so nothing maps, raises or moves over the window
	/// in between: from the pixmap a compositing manager keeps of it, which
	/// nothing over the window reaches, and else from the screen, the only
	/// copy. `between` runs there, after the check (a no-op but in tests).
	fn capture_held(
		&self,
		client: Window,
		id: &str,
		between: impl Fn(),
	) -> CoreResult<(RgbaImage, Area)> {
		let grab = ServerGrab::new(&self.conn)?;
		let pending = match self.capture_named(client, id, &between)? {
			Some(pending) => pending,
			None => self.capture_screen(client, id, between)?,
		};
		// The server runs this connection's queued reads before the ungrab
		// behind them, so other clients wait for the reads only, not for the
		// pixels to reach this process and be decoded.
		drop(grab);
		pending.finish(self, id)
	}

	/// `client` and its own popups, each read from the pixmap the server keeps
	/// for it while it is redirected, and cut to its shape; `None` when no
	/// window from `client` up to the root is redirected, or when one of its
	/// popups over it is not.
	fn capture_named(
		&self,
		client: Window,
		id: &str,
		between: &dyn Fn(),
	) -> CoreResult<Option<PendingCapture<'_>>> {
		if !self.composite {
			return Ok(None);
		}
		let tree = self.tree(client, id)?;
		let Some((level, pixmap)) = self.name_innermost(&tree.chain, id)? else {
			return Ok(None);
		};
		// The holder's pixmap holds `client` and whatever inside the holder is
		// drawn over it; its origin is the holder's outer (border) corner. A
		// client of another depth than its parent is redirected by itself, so
		// below the holder every window has its depth and the client's pixel
		// values are stored as they are, in the client's visual.
		let holder = tree.chain[level];
		let inner = &tree.chain[..=level];
		let holder_geometry = self.conn.get_geometry(holder).map_err(request_failed)?;
		let attributes = self
			.conn
			.get_window_attributes(client)
			.map_err(request_failed)?;
		let geometry = self.conn.get_geometry(client).map_err(request_failed)?;
		let origins = inner
			.iter()
			.map(|&window| self.conn.translate_coordinates(window, self.root, 0, 0))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let shapes = inner
			.iter()
			.map(|&window| self.request_shape(window))
			.collect::<CoreResult<Vec<_>>>()?;
		let failed = |error| window_reply_failed(id, error);
		let holder_border = i32::from(holder_geometry.reply().map_err(failed)?.border_width);
		let visual = attributes.reply().map_err(failed)?.visual;
		let geometry = geometry.reply().map_err(failed)?;
		let origins = origins
			.into_iter()
			.map(|cookie| {
				cookie
					.reply()
					.map(|origin| (i32::from(origin.dst_x), i32::from(origin.dst_y)))
			})
			.collect::<Result<Vec<_>, _>>()
			.map_err(failed)?;
		let area = self.root_area(id, origins[0], geometry.width, geometry.height)?;
		let (x, y, width, height) = area;
		let above = self.above(client, area, &tree.siblings)?;
		if self.covered(above.covers.iter().filter(|over| over.level < level), area)? {
			return Err(DesktopError::capture_failed(format!(
				"window {id} is covered by another window inside its own frame"
			)));
		}
		between();
		// A popup inside the holder is in its pixmap already. A viewable one the
		// server keeps no pixmap for means nobody redirects the root's children,
		// the client being in a pixmap only for its depth: the screen then holds
		// both, so it is read instead. Decided before the window's own read, so
		// that fallback reads no pixels twice.
		let mut popups = Vec::new();
		for popup in above.popups.iter().filter(|popup| popup.level >= level) {
			match self.request_popup((x, y), popup)? {
				PopupRead::Gone => {},
				PopupRead::Unredirected => return Ok(None),
				PopupRead::Read(popup) => popups.push(popup),
			}
		}
		let (holder_x, holder_y) = origins[level];
		let image = self.request_drawable(
			pixmap.1,
			visual,
			x - (holder_x - holder_border),
			y - (holder_y - holder_border),
			width,
			height,
		)?;
		drop(pixmap);
		let clips = origins
			.into_iter()
			.zip(shapes)
			.filter_map(|(origin, shape)| Some((origin, shape?)))
			.collect();
		Ok(Some(PendingCapture { area, image, clips, popups }))
	}

	/// Where no window from `client` up to the root is redirected, the screen
	/// is the only copy of its pixels: a root crop, refused where the server
	/// stacks another client's window over it.
	fn capture_screen(
		&self,
		client: Window,
		id: &str,
		between: impl FnOnce(),
	) -> CoreResult<PendingCapture<'_>> {
		let attributes = self
			.conn
			.get_window_attributes(client)
			.map_err(request_failed)?;
		let geometry = self.conn.get_geometry(client).map_err(request_failed)?;
		let origin = self
			.conn
			.translate_coordinates(client, self.root, 0, 0)
			.map_err(request_failed)?;
		let failed = |error| window_reply_failed(id, error);
		if attributes.reply().map_err(failed)?.map_state != MapState::VIEWABLE {
			return Err(DesktopError::window_not_found(format!("window {id} was not found")));
		}
		let geometry = geometry.reply().map_err(failed)?;
		let origin = origin.reply().map_err(failed)?;
		let area = self.root_area(
			id,
			(i32::from(origin.dst_x), i32::from(origin.dst_y)),
			geometry.width,
			geometry.height,
		)?;
		let tree = self.tree(client, id)?;
		let above = self.above(client, area, &tree.siblings)?;
		if self.covered(above.covers.iter(), area)? {
			return Err(DesktopError::capture_failed(format!(
				"window {id} is covered by another window, and no compositing manager keeps an image \
				 of it, so the X server holds no pixels for its covered part; win.ax() still reads \
				 it, and a screenshot of its display shows what is on top"
			)));
		}
		between();
		let (x, y, width, height) = area;
		Ok(PendingCapture {
			area,
			image: self.request_root(x, y, width, height)?,
			clips: Vec::new(),
			popups: Vec::new(),
		})
	}

	fn root_area(&self, id: &str, (x, y): (i32, i32), width: u16, height: u16) -> CoreResult<Area> {
		clip_to_root(x, y, u32::from(width), u32::from(height), self.root_width, self.root_height)
			.ok_or_else(|| {
				DesktopError::capture_failed(format!("window {id} has no visible root area"))
			})
	}

	/// `client`'s ancestry up to a child of the root, and what stacks above it
	/// at every level, frames and virtual-root containers included.
	fn tree(&self, client: Window, id: &str) -> CoreResult<Tree> {
		let mut chain = vec![client];
		let mut siblings = Vec::new();
		let mut tree = self
			.conn
			.query_tree(client)
			.map_err(request_failed)?
			.reply()
			.map_err(|error| window_reply_failed(id, error))?;
		while tree.parent != x11rb::NONE {
			let parent = tree.parent;
			let level = chain.len() - 1;
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
				.position(|&window| window == chain[level])
				.map_or(tree.children.len(), |index| index + 1);
			siblings.extend(tree.children[start..].iter().map(|&window| (level, window)));
			if tree.parent != x11rb::NONE {
				chain.push(parent);
			}
		}
		Ok(Tree { chain, siblings })
	}

	/// The pixmap the server keeps for the innermost window of `chain` it
	/// redirects, named for this connection, with that window's index; `None`
	/// when it redirects none of them.
	fn name_innermost(
		&self,
		chain: &[Window],
		id: &str,
	) -> CoreResult<Option<(usize, NamedPixmap<'_>)>> {
		let mut cookies = Vec::with_capacity(chain.len());
		for &window in chain {
			let pixmap = self.conn.generate_id().map_err(request_failed)?;
			let cookie = self
				.conn
				.composite_name_window_pixmap(window, pixmap)
				.map_err(request_failed)?;
			cookies.push((pixmap, cookie));
		}
		let mut found = None;
		let mut failed = None;
		for (level, (pixmap, cookie)) in cookies.into_iter().enumerate() {
			match cookie.check() {
				Ok(()) => {
					let named = NamedPixmap(&self.conn, pixmap);
					if found.is_none() && failed.is_none() {
						found = Some((level, named));
					}
				},
				// Not redirected, or not viewable.
				Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Match => {},
				Err(error) => {
					if found.is_none() {
						failed.get_or_insert(error);
					}
				},
			}
		}
		match failed {
			Some(error) => Err(window_reply_failed(id, error)),
			None => Ok(found),
		}
	}

	/// The bounding shape of `window`, read later; `None` without the Shape
	/// extension, where every window is its rectangle.
	fn request_shape(&self, window: Window) -> CoreResult<Option<ShapeRequest<'_>>> {
		if !self.shape {
			return Ok(None);
		}
		let conn = self.conn.as_ref();
		Ok(Some(ShapeRequest {
			extents:    conn.shape_query_extents(window).map_err(request_failed)?,
			rectangles: conn
				.shape_get_rectangles(window, shape::SK::BOUNDING)
				.map_err(request_failed)?,
		}))
	}

	/// The windows of `siblings` whose rectangle meets `area`: another
	/// client's, and `client`'s own override-redirect popups. A window of the
	/// server's own, such as the compositing overlay, covers nothing; an
	/// override-redirect window `client`'s own process made belongs to it
	/// unless it says it is another window's ([`X11Capture::popup_of`]).
	fn above(&self, client: Window, area: Area, siblings: &[(usize, Window)]) -> CoreResult<Above> {
		let attributes = siblings
			.iter()
			.map(|&(_, window)| self.conn.get_window_attributes(window))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let geometries = siblings
			.iter()
			.map(|&(_, window)| self.conn.get_geometry(window))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let origins = siblings
			.iter()
			.map(|&(_, window)| self.conn.translate_coordinates(window, self.root, 0, 0))
			.collect::<Result<Vec<_>, _>>()
			.map_err(request_failed)?;
		let owner = |window: Window| window & !self.conn.setup().resource_id_mask;
		let mut above = Above { covers: Vec::new(), popups: Vec::new() };
		for (((&(level, window), attributes), geometry), origin) in
			siblings.iter().zip(attributes).zip(geometries).zip(origins)
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
			let border = i32::from(geometry.border_width);
			let origin = (i32::from(origin.dst_x), i32::from(origin.dst_y));
			let outer = (
				origin.0 - border,
				origin.1 - border,
				u32::from(geometry.width) + 2 * u32::from(geometry.border_width),
				u32::from(geometry.height) + 2 * u32::from(geometry.border_width),
			);
			let Some(part) = intersect(area, outer) else {
				continue;
			};
			let over = Over { level, window, part, origin, border };
			if attributes.override_redirect
				&& owner(window) == owner(client)
				&& self.popup_of(window, client)?
			{
				above.popups.push(over);
			} else {
				above.covers.push(over);
			}
		}
		Ok(above)
	}

	/// Whether `popup`, from `client`'s connection, is `client`'s. A menu or
	/// tooltip names the window it is for in `WM_TRANSIENT_FOR` (GTK and Qt
	/// set it), directly or through the menu it opened from: it is `client`'s
	/// only if that reaches `client`. One that names no window is taken to
	/// be `client`'s, as the connection made it.
	fn popup_of(&self, popup: Window, client: Window) -> CoreResult<bool> {
		let mut window = popup;
		// Longer than any menu chain: a loop.
		for _ in 0..8 {
			let next = self
				.property(window, AtomEnum::WM_TRANSIENT_FOR.into(), AtomEnum::WINDOW, 1)
				.and_then(|reply| reply.value32()?.next())
				.filter(|&next| next != x11rb::NONE && next != self.root);
			let Some(next) = next else {
				// A chain that ends at a popup naming nothing is that popup's.
				let attributes = self
					.conn
					.get_window_attributes(window)
					.map_err(request_failed)?;
				return Ok(window == popup || attributes.reply().is_ok_and(|a| a.override_redirect));
			};
			if next == client {
				return Ok(true);
			}
			window = next;
		}
		Ok(false)
	}

	/// Whether any of `covers` puts part of its bounding shape over `area`.
	fn covered<'a>(&self, covers: impl Iterator<Item = &'a Over>, area: Area) -> CoreResult<bool> {
		let shapes = covers
			.map(|over| Ok((over.origin, self.request_shape(over.window)?)))
			.collect::<CoreResult<Vec<_>>>()?;
		for (origin, shape) in shapes {
			// Without the Shape extension a window is its rectangle.
			let Some(shape) = shape else {
				return Ok(true);
			};
			// A window destroyed since it was listed covers nothing.
			let Ok(shape) = shape.reply() else {
				continue;
			};
			let Some(shape) = shape else {
				return Ok(true);
			};
			if shape
				.iter()
				.any(|rectangle| intersect(area, rectangle_at(origin, rectangle)).is_some())
			{
				return Ok(true);
			}
		}
		Ok(false)
	}

	/// Requests `popup`'s pixels from its own pixmap, to be drawn over the
	/// image whose top-left is `(x, y)` on the root and cut to its shape. A
	/// popup unmapped or destroyed since the tree was read is
	/// [`PopupRead::Gone`]; a viewable one that is not redirected,
	/// [`PopupRead::Unredirected`]; any other failure fails.
	fn request_popup(&self, (x, y): (i32, i32), popup: &Over) -> CoreResult<PopupRead<'_>> {
		let pixmap = self.conn.generate_id().map_err(request_failed)?;
		let named = self
			.conn
			.composite_name_window_pixmap(popup.window, pixmap)
			.map_err(request_failed)?;
		let attributes = self
			.conn
			.get_window_attributes(popup.window)
			.map_err(request_failed)?;
		let shape = self.request_shape(popup.window)?;
		let named = named.check().map(|()| NamedPixmap(&self.conn, pixmap));
		let attributes = match attributes.reply() {
			Ok(attributes) => attributes,
			Err(error) if gone(&error) => return Ok(PopupRead::Gone),
			Err(error) => return Err(request_failed(error)),
		};
		let pixmap = match named {
			Ok(pixmap) => pixmap,
			Err(error) if gone(&error) || attributes.map_state != MapState::VIEWABLE => {
				return Ok(PopupRead::Gone);
			},
			Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Match => {
				return Ok(PopupRead::Unredirected);
			},
			Err(error) => return Err(request_failed(error)),
		};
		let (part_x, part_y, width, height) = popup.part;
		let (origin_x, origin_y) = popup.origin;
		let read = self.request_drawable(
			pixmap.1,
			attributes.visual,
			part_x - (origin_x - popup.border),
			part_y - (origin_y - popup.border),
			width,
			height,
		)?;
		Ok(PopupRead::Read(PendingPopup {
			read,
			shape,
			clip: (part_x - origin_x, part_y - origin_y),
			at: ((part_x - x) as u32, (part_y - y) as u32),
		}))
	}

	/// Requests the rectangle at `x, y` inside `drawable`, a window or pixmap
	/// holding pixels of `visual`, to be read by [`ImageRead::finish`].
	fn request_drawable(
		&self,
		drawable: Drawable,
		visual: Visualid,
		x: i32,
		y: i32,
		width: u32,
		height: u32,
	) -> CoreResult<ImageRead<'_>> {
		let (x, y) = x11_origin(x, y)?;
		let visual_type = self
			.conn
			.setup()
			.roots
			.iter()
			.flat_map(|screen| &screen.allowed_depths)
			.flat_map(|depth| &depth.visuals)
			.find(|candidate| candidate.visual_id == visual)
			.ok_or_else(|| {
				DesktopError::capture_failed("X11 setup does not describe the window's visual")
			})?;
		if visual_type.class != VisualClass::TRUE_COLOR {
			return Err(DesktopError::capture_failed(
				"X11 window capture requires a TrueColor visual; colormap-based visuals are \
				 unsupported",
			));
		}
		// Core visual masks say nothing about alpha, including at depth 32.
		let masks = ColorMasks {
			red:   visual_type.red_mask,
			green: visual_type.green_mask,
			blue:  visual_type.blue_mask,
			alpha: self
				.pictformats
				.as_deref()
				.map_or(0, |formats| visual_alpha(formats, visual)),
		};
		let cookie = self
			.conn
			.as_ref()
			.get_image(ImageFormat::Z_PIXMAP, drawable, x, y, edge(width)?, edge(height)?, !0)
			.map_err(request_failed)?;
		Ok(ImageRead { cookie, masks, width, height, drawable: Some(drawable) })
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

/// A failed reply about the window being captured: `WindowNotFound` once it is
/// destroyed.
fn window_reply_failed(id: &str, error: ReplyError) -> DesktopError {
	if let ReplyError::X11Error(x11) = &error
		&& x11.error_kind == ErrorKind::Window
	{
		DesktopError::window_not_found(format!("window {id} was not found"))
	} else {
		request_failed(error)
	}
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
	if !(15..=32).contains(&depth) {
		return Err(DesktopError::capture_failed(format!(
			"unsupported X11 image depth {depth}; TrueColor depth 15 through 32 is required"
		)));
	}
	let bytes_per_pixel = match bits_per_pixel {
		16 => 2usize,
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

/// A shape rectangle, relative to a window's origin at `origin`, in root
/// coordinates.
fn rectangle_at((x, y): (i32, i32), rectangle: &Rectangle) -> Area {
	(
		x + i32::from(rectangle.x),
		y + i32::from(rectangle.y),
		u32::from(rectangle.width),
		u32::from(rectangle.height),
	)
}

/// Draws `part` over `image` with its top-left at `(left, top)` the way a
/// compositing manager does: in premultiplied alpha, each product rounded to
/// the nearest step, so a menu's translucent shadow comes out as on screen.
fn draw_over(image: &mut RgbaImage, part: &RgbaImage, (left, top): (u32, u32)) {
	let scale = |value: u32, alpha: u32| (value * alpha + 127) / 255;
	let (width, height) = image.dimensions();
	for (column, row, source) in part.enumerate_pixels() {
		let (column, row) = (left + column, top + row);
		if column >= width || row >= height {
			continue;
		}
		let target = image.get_pixel_mut(column, row);
		let [red, green, blue, opacity] = source.0.map(u32::from);
		match opacity {
			0 => {},
			255 => *target = *source,
			_ => {
				let [below_red, below_green, below_blue, below_opacity] = target.0.map(u32::from);
				let keep = 255 - opacity;
				let alpha = opacity + scale(below_opacity, keep);
				let channel = |source: u32, below: u32| {
					let premultiplied =
						scale(source, opacity) + scale(scale(below, below_opacity), keep);
					((premultiplied * 255 + alpha / 2) / alpha).min(255) as u8
				};
				*target = Rgba([
					channel(red, below_red),
					channel(green, below_green),
					channel(blue, below_blue),
					alpha as u8,
				]);
			},
		}
	}
}

/// Clears the pixels of `image` outside `shape`, rectangles relative to the
/// window's origin, where `origin` is the window coordinate of the image's
/// top-left pixel. Nothing draws there, so what a pixmap holds there is not
/// the window's.
fn clip_to_shape(image: &mut RgbaImage, origin: (i32, i32), shape: &[Rectangle]) {
	let (width, height) = image.dimensions();
	let whole = (0, 0, width, height);
	let at = (-origin.0, -origin.1);
	if shape
		.iter()
		.any(|rectangle| intersect(whole, rectangle_at(at, rectangle)) == Some(whole))
	{
		return;
	}
	let mut inside = vec![false; width as usize * height as usize];
	for rectangle in shape {
		let Some((left, top, columns, rows)) = intersect(whole, rectangle_at(at, rectangle)) else {
			continue;
		};
		for row in top as usize..top as usize + rows as usize {
			let start = row * width as usize + left as usize;
			inside[start..start + columns as usize].fill(true);
		}
	}
	for (pixel, inside) in image.pixels_mut().zip(inside) {
		if !inside {
			*pixel = Rgba([0; 4]);
		}
	}
}

/// `x, y` in the protocol's signed 16-bit coordinates.
fn x11_origin(x: i32, y: i32) -> CoreResult<(i16, i16)> {
	let outside =
		|_| DesktopError::capture_failed("capture origin exceeds the X11 coordinate space");
	Ok((i16::try_from(x).map_err(outside)?, i16::try_from(y).map_err(outside)?))
}

/// Whether `error` says the window was unmapped or destroyed.
fn gone(error: &ReplyError) -> bool {
	matches!(error, ReplyError::X11Error(error) if error.error_kind == ErrorKind::Window)
}

/// A `GetImage` already sent, read and decoded by [`Self::finish`].
struct ImageRead<'a> {
	cookie:   Cookie<'a, RustConnection, GetImageReply>,
	masks:    ColorMasks,
	width:    u32,
	height:   u32,
	/// The window or pixmap read; `None` for the root.
	drawable: Option<Drawable>,
}

impl ImageRead<'_> {
	fn finish(self, capture: &X11Capture) -> CoreResult<RgbaImage> {
		let reply = self.cookie.reply().map_err(|error| match self.drawable {
			None => root_capture_failed(error),
			Some(drawable) => {
				DesktopError::capture_failed(format!("X11 GetImage of {drawable} failed: {error}"))
			},
		})?;
		capture.decode(&reply, self.width, self.height, self.masks)
	}
}

/// A window capture whose reads were queued while the server was held:
/// the window's image, the shapes to cut it to, and its popups.
struct PendingCapture<'a> {
	area:   Area,
	image:  ImageRead<'a>,
	/// Origins on the root of the windows whose bounding shapes cut the image.
	clips:  Vec<((i32, i32), ShapeRequest<'a>)>,
	popups: Vec<PendingPopup<'a>>,
}

impl PendingCapture<'_> {
	fn finish(self, capture: &X11Capture, id: &str) -> CoreResult<(RgbaImage, Area)> {
		let (x, y, ..) = self.area;
		let mut image = self.image.finish(capture)?;
		for ((window_x, window_y), shape) in self.clips {
			if let Some(shape) = shape
				.reply()
				.map_err(|error| window_reply_failed(id, error))?
			{
				clip_to_shape(&mut image, (x - window_x, y - window_y), &shape);
			}
		}
		for popup in self.popups {
			popup.draw(capture, &mut image)?;
		}
		Ok((image, self.area))
	}
}

/// What [`X11Capture::request_popup`] found.
enum PopupRead<'a> {
	/// Unmapped or destroyed since the tree was read: nothing to draw.
	Gone,
	/// Viewable but not redirected: only the screen holds its pixels.
	Unredirected,
	Read(PendingPopup<'a>),
}

/// A popup's pixels requested from its own pixmap.
struct PendingPopup<'a> {
	read:  ImageRead<'a>,
	shape: Option<ShapeRequest<'a>>,
	/// Where the read part starts inside the popup's shape.
	clip:  (i32, i32),
	/// Where the part goes in the window's image.
	at:    (u32, u32),
}

impl PendingPopup<'_> {
	fn draw(self, capture: &X11Capture, image: &mut RgbaImage) -> CoreResult<()> {
		let mut part = self.read.finish(capture)?;
		if let Some(shape) = self.shape {
			match shape.reply() {
				Ok(Some(shape)) => clip_to_shape(&mut part, self.clip, &shape),
				Ok(None) => {},
				Err(error) if gone(&error) => return Ok(()),
				Err(error) => return Err(request_failed(error)),
			}
		}
		draw_over(image, &part, self.at);
		Ok(())
	}
}

/// A pixmap named for a window's storage, freed on drop.
struct NamedPixmap<'a>(&'a RustConnection, Pixmap);

impl Drop for NamedPixmap<'_> {
	fn drop(&mut self) {
		if let Ok(cookie) = self.0.free_pixmap(self.1) {
			cookie.ignore_error();
		}
	}
}

/// The server grabbed: no other client's request runs until drop.
struct ServerGrab<'a>(&'a RustConnection);

impl<'a> ServerGrab<'a> {
	fn new(conn: &'a RustConnection) -> CoreResult<Self> {
		conn.grab_server().map_err(request_failed)?.ignore_error();
		Ok(Self(conn))
	}
}

impl Drop for ServerGrab<'_> {
	fn drop(&mut self) {
		if let Ok(cookie) = self.0.ungrab_server() {
			cookie.ignore_error();
		}
		let _ = self.0.flush();
	}
}

#[cfg(test)]
mod tests {
	//! The Xvfb tests start their own server and play its window manager:
	//! `cargo test -p pi-natives desktop::linux::x11::capture --
	//! --include-ignored`

	use std::{
		io::{BufRead, BufReader},
		process::{Child, Command, Stdio},
	};

	use x11rb::{
		CURRENT_TIME,
		protocol::{
			composite::Redirect,
			shape::SO,
			xproto::{
				ClipOrdering, ColormapAlloc, ConfigureWindowAux, CreateWindowAux, PropMode, StackMode,
			},
		},
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

	/// A visual of `class`, at `depth` when given, and a colormap for it.
	fn visual(conn: &RustConnection, class: VisualClass, depth: Option<u8>) -> (u8, Visualid, u32) {
		let screen = &conn.setup().roots[0];
		let (depth, visual) = screen
			.allowed_depths
			.iter()
			.filter(|allowed| depth.is_none_or(|depth| allowed.depth == depth))
			.find_map(|allowed| {
				allowed
					.visuals
					.iter()
					.find(|visual| visual.class == class)
					.map(|visual| (allowed.depth, visual.visual_id))
			})
			.expect("Xvfb provides the visual");
		let colormap = conn.generate_id().expect("colormap id");
		conn
			.create_colormap(ColormapAlloc::NONE, colormap, screen.root, visual)
			.expect("create colormap")
			.check()
			.expect("colormap accepted");
		(depth, visual, colormap)
	}

	fn window_of(
		conn: &RustConnection,
		parent: Window,
		(x, y, width, height): (i16, i16, u16, u16),
		(depth, visual, colormap): (u8, Visualid, u32),
		background: u32,
	) -> Window {
		let id = conn.generate_id().expect("window id");
		conn
			.create_window(
				depth,
				id,
				parent,
				x,
				y,
				width,
				height,
				0,
				WindowClass::INPUT_OUTPUT,
				visual,
				&CreateWindowAux::new()
					.colormap(colormap)
					.background_pixel(background)
					.border_pixel(0),
			)
			.expect("create window")
			.check()
			.expect("window accepted");
		conn.map_window(id).expect("map window");
		id
	}

	/// Lists `windows` in `_NET_CLIENT_LIST_STACKING`, as a window manager does.
	fn list_windows(conn: &RustConnection, windows: &[Window]) {
		let root = conn.setup().roots[0].root;
		let stacking = conn
			.intern_atom(false, b"_NET_CLIENT_LIST_STACKING")
			.expect("intern")
			.reply()
			.expect("atom")
			.atom;
		conn
			.change_property32(PropMode::REPLACE, root, stacking, AtomEnum::WINDOW, windows)
			.expect("list windows");
		conn.sync().expect("sync");
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
		let popup = window(
			conn,
			root,
			(10, 10, 40, 30),
			&CreateWindowAux::new()
				.background_pixel(YELLOW)
				.border_pixel(BLUE)
				.override_redirect(1),
		);
		conn
			.configure_window(popup, &ConfigureWindowAux::new().border_width(3))
			.expect("popup border");
		list_windows(conn, &[red, blue]);
		(red, blue, frame)
	}

	fn pixel(image: &RgbaImage, (x, y): (u32, u32)) -> [u8; 4] {
		image.get_pixel(x, y).0
	}

	/// Does the first half of what a compositing manager does on start:
	/// redirects every top-level into a pixmap of its own.
	fn redirect_top_levels(conn: &RustConnection) {
		let root = conn.setup().roots[0].root;
		conn
			.composite_redirect_subwindows(root, Redirect::MANUAL)
			.expect("redirect")
			.check()
			.expect("redirect accepted");
	}

	/// The second half: takes the screen's `_NET_WM_CM_S0`.
	fn own_compositor_selection(conn: &RustConnection) {
		let root = conn.setup().roots[0].root;
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

	fn become_compositing_manager(conn: &RustConnection) {
		redirect_top_levels(conn);
		own_compositor_selection(conn);
	}

	fn set_shape(conn: &RustConnection, window: Window, rectangles: &[Rectangle]) {
		conn
			.shape_rectangles(
				SO::SET,
				shape::SK::BOUNDING,
				ClipOrdering::UNSORTED,
				window,
				0,
				0,
				rectangles,
			)
			.expect("shape")
			.check()
			.expect("shape accepted");
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn covered_window_nobody_redirects_is_reported_covered() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		// The selection is owned, as by a manager that stopped redirecting.
		own_compositor_selection(&wm);
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
	fn window_with_a_directcolor_visual_is_rejected() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let root = wm.setup().roots[0].root;
		let direct = visual(&wm, VisualClass::DIRECT_COLOR, None);
		become_compositing_manager(&wm);
		// One in a pixmap of its own, and one inside a TrueColor frame's.
		let target = window_of(&wm, root, (0, 0, 200, 150), direct, RED);
		let frame =
			window(&wm, root, (0, 160, 200, 160), &CreateWindowAux::new().background_pixel(GREY));
		let framed = window_of(&wm, frame, (0, 10, 200, 150), direct, RED);
		window(&wm, root, (100, 100, 200, 150), &CreateWindowAux::new().background_pixel(BLUE));
		list_windows(&wm, &[target, framed]);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		for window in [target, framed] {
			let error = capture
				.capture(&Target::Window(window.to_string()), None)
				.expect_err("DirectColor indexes cannot be decoded as RGB components");
			assert_eq!(error.code, ErrorCode::CaptureFailed);
			assert!(error.message.contains("TrueColor"), "{}", error.message);
			assert!(error.message.contains("colormap"), "{}", error.message);
		}
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

	#[test]
	#[ignore = "starts Xvfb"]
	fn redirected_window_is_read_from_its_own_pixels_covered_or_not() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		// Redirected, and nobody owns the manager's selection.
		redirect_top_levels(&wm);
		let (red, _, frame) = covered_pair(&wm);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("covered window");
		assert_eq!(image.dimensions(), (200, 150));
		assert_eq!(pixel(&image, STRIP), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, POPUP), [255, 255, 0, 255]);
		for corner in [(10, 10), (55, 10), (10, 45), (55, 45)] {
			assert_eq!(pixel(&image, corner), [0, 0, 255, 255], "popup border at {corner:?}");
		}

		// Uncovered, the screen still holds only what this manager painted:
		// nothing. The pixmap holds the window.
		wm.configure_window(frame, &ConfigureWindowAux::new().x(210))
			.expect("move cover away");
		wm.sync().expect("sync");
		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("uncovered window");
		assert_eq!(pixel(&image, STRIP), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, POPUP), [255, 255, 0, 255]);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn framed_window_is_read_from_its_frames_pixmap() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		redirect_top_levels(&wm);
		let (_, blue, frame) = covered_pair(&wm);
		wm.configure_window(frame, &ConfigureWindowAux::new().border_width(4))
			.expect("frame border");
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let id = blue.to_string();

		let (image, _) = capture
			.capture(&Target::Window(id.clone()), None)
			.expect("framed window");
		assert_eq!(image.dimensions(), (200, 150));
		assert_eq!(pixel(&image, (0, 0)), [0, 0, 255, 255]);
		assert_eq!(pixel(&image, (199, 149)), [0, 0, 255, 255]);

		// The frame's shape cuts its left 50 pixels, and blue's with them.
		set_shape(&wm, frame, &[Rectangle { x: 50, y: -4, width: 154, height: 168 }]);
		wm.sync().expect("sync");
		let (image, _) = capture
			.capture(&Target::Window(id.clone()), None)
			.expect("framed window in a shaped frame");
		assert_eq!(pixel(&image, (10, 50)), [0, 0, 0, 0]);
		assert_eq!(pixel(&image, (100, 50)), [0, 0, 255, 255]);

		// A window the frame puts over blue is in the frame's pixmap too.
		window(&wm, frame, (60, 20, 50, 50), &CreateWindowAux::new().background_pixel(YELLOW));
		wm.sync().expect("sync");
		let error = capture
			.capture(&Target::Window(id), None)
			.expect_err("covered inside its frame");
		assert!(error.message.contains("covered"), "{}", error.message);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn popup_unmapped_after_stacking_is_read_does_not_fail_capture() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		become_compositing_manager(&wm);
		let (red, ..) = covered_pair(&wm);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let area = (0, 0, 200, 150);
		let tree = capture.tree(red, &red.to_string()).expect("tree");
		let above = capture.above(red, area, &tree.siblings).expect("stacking");
		assert_eq!(above.popups.len(), 1);
		let popup = above.popups[0].window;

		wm.unmap_window(popup).expect("unmap popup");
		wm.sync().expect("popup is unmapped before it is read");
		let read = capture
			.request_popup((0, 0), &above.popups[0])
			.expect("capture without vanished popup");
		assert!(matches!(read, PopupRead::Gone));

		wm.map_window(popup).expect("remap popup");
		wm.sync().expect("popup is mapped");
		let above = capture
			.above(red, area, &tree.siblings)
			.expect("stacking before destroy");
		assert_eq!(above.popups.len(), 1);
		wm.destroy_window(popup).expect("destroy popup");
		wm.sync().expect("popup is destroyed before it is read");
		let read = capture
			.request_popup((0, 0), &above.popups[0])
			.expect("capture without destroyed popup");
		assert!(matches!(read, PopupRead::Gone));
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn shaped_window_is_clear_outside_its_shape() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		become_compositing_manager(&wm);
		let (red, ..) = covered_pair(&wm);
		set_shape(&wm, red, &[Rectangle { x: 0, y: 0, width: 100, height: 150 }]);
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("shaped window");
		assert_eq!(pixel(&image, (80, 100)), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, (150, 20)), [0, 0, 0, 0]);
		assert_eq!(pixel(&image, STRIP), [0, 0, 0, 0]);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn shaped_popup_is_drawn_only_inside_its_shape() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		become_compositing_manager(&wm);
		let (red, ..) = covered_pair(&wm);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let tree = capture.tree(red, &red.to_string()).expect("tree");
		let popup = capture
			.above(red, (0, 0, 200, 150), &tree.siblings)
			.expect("stacking")
			.popups[0]
			.window;
		// The popup's left half and left border; its rectangle is 46x36 at 10,10.
		set_shape(&wm, popup, &[Rectangle { x: -3, y: -3, width: 23, height: 36 }]);
		wm.sync().expect("sync");

		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("window with a shaped popup");
		assert_eq!(pixel(&image, POPUP), [255, 255, 0, 255]);
		assert_eq!(pixel(&image, (10, 10)), [0, 0, 255, 255]);
		assert_eq!(pixel(&image, (45, 25)), [255, 0, 0, 255]);
		assert_eq!(pixel(&image, (55, 45)), [255, 0, 0, 255]);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn shaped_window_covers_only_where_its_shape_is() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let (red, _, frame) = covered_pair(&wm);
		// The frame's title bar, the part over red, is cut away.
		set_shape(&wm, frame, &[Rectangle { x: 0, y: 15, width: 200, height: 145 }]);
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(red.to_string()), None)
			.expect("nothing's shape is over red");
		assert_eq!(pixel(&image, STRIP), [255, 0, 0, 255]);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn window_in_a_pixmap_for_its_depth_with_an_unredirected_popup_is_read_from_the_screen() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let root = wm.setup().roots[0].root;
		// No manager: the server keeps a 32-bit window in a pixmap by itself,
		// and not the 24-bit popup over it.
		let argb = visual(&wm, VisualClass::TRUE_COLOR, Some(32));
		let target = window_of(&wm, root, (0, 0, 200, 150), argb, 0xffff_0000);
		window(
			&wm,
			root,
			(10, 10, 40, 30),
			&CreateWindowAux::new()
				.background_pixel(YELLOW)
				.override_redirect(1),
		);
		list_windows(&wm, &[target]);
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");

		let (image, _) = capture
			.capture(&Target::Window(target.to_string()), None)
			.expect("the screen holds both");
		assert_eq!(pixel(&image, POPUP), [255, 255, 0, 255]);
		assert_eq!(pixel(&image, (100, 100)), [255, 0, 0, 255]);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn window_destroyed_before_capture_is_not_found() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let root = wm.setup().roots[0].root;
		let gone = window(&wm, root, (0, 0, 100, 100), &CreateWindowAux::new().background_pixel(RED));
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		wm.destroy_window(gone).expect("destroy");
		wm.sync().expect("destroyed");

		let error = capture
			.capture_named(gone, &gone.to_string(), &|| {})
			.map(|_| ())
			.expect_err("nothing to read");
		assert_eq!(error.code, ErrorCode::WindowNotFound);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn window_mapped_by_another_client_waits_for_the_screen_read() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		let (red, _, frame) = covered_pair(&wm);
		wm.configure_window(frame, &ConfigureWindowAux::new().x(210))
			.expect("move cover away");
		let root = wm.setup().roots[0].root;
		let (other, _) = x11rb::connect(Some(&display)).expect("second client");
		let cover =
			window(&other, root, (50, 50, 100, 60), &CreateWindowAux::new().background_pixel(BLUE));
		other.unmap_window(cover).expect("unmap cover");
		other.sync().expect("sync");
		wm.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let id = red.to_string();

		// The cover's map reaches the server between the check and the read,
		// and waits there for the grab to end.
		let (image, _) = capture
			.capture_held(red, &id, || {
				other.map_window(cover).expect("map cover");
				other.flush().expect("map sent");
			})
			.expect("nothing was over red when it was checked");
		assert_eq!(pixel(&image, (60, 60)), [255, 0, 0, 255]);

		other.sync().expect("cover mapped");
		let error = capture
			.capture(&Target::Window(id), None)
			.expect_err("the cover is mapped now");
		assert!(error.message.contains("covered"), "{}", error.message);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn child_mapped_in_the_frame_by_another_client_waits_for_the_pixmap_read() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		redirect_top_levels(&wm);
		let (_, blue, frame) = covered_pair(&wm);
		let (other, _) = x11rb::connect(Some(&display)).expect("second client");
		let child =
			window(&other, frame, (60, 20, 50, 50), &CreateWindowAux::new().background_pixel(YELLOW));
		other.unmap_window(child).expect("unmap child");
		other.sync().expect("sync");
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let id = blue.to_string();

		// The child's map reaches the server between the check and the read of
		// the frame's pixmap, and waits there for the grab to end.
		let (image, _) = capture
			.capture_held(blue, &id, || {
				other.map_window(child).expect("map child");
				other.flush().expect("map sent");
			})
			.expect("nothing was over blue when it was checked");
		assert_eq!(pixel(&image, (70, 20)), [0, 0, 255, 255]);

		other.sync().expect("child mapped");
		let error = capture
			.capture(&Target::Window(id), None)
			.expect_err("the child is mapped now");
		assert!(error.message.contains("covered"), "{}", error.message);
	}

	#[test]
	#[ignore = "starts Xvfb"]
	fn popup_for_another_window_of_the_same_client_is_left_out() {
		let (_server, display) = start_server();
		let (wm, _) = x11rb::connect(Some(&display)).expect("connect");
		redirect_top_levels(&wm);
		let (red, blue, _) = covered_pair(&wm);
		let root = wm.setup().roots[0].root;
		let capture = X11Capture::connect(Some(&display), DisplaySelector::All).expect("capture");
		let tree = capture.tree(red, &red.to_string()).expect("tree");
		let popup = capture
			.above(red, (0, 0, 200, 150), &tree.siblings)
			.expect("stacking")
			.popups[0]
			.window;
		// A menu, off red, that the popup opened from.
		let menu = window(
			&wm,
			root,
			(250, 0, 40, 30),
			&CreateWindowAux::new()
				.background_pixel(YELLOW)
				.override_redirect(1),
		);
		let transient_for = |window: Window, of: Window| {
			wm.change_property32(
				PropMode::REPLACE,
				window,
				AtomEnum::WM_TRANSIENT_FOR,
				AtomEnum::WINDOW,
				&[of],
			)
			.expect("transient for");
			wm.sync().expect("sync");
		};
		let popup_pixel = || {
			let (image, _) = capture
				.capture(&Target::Window(red.to_string()), None)
				.expect("covered window");
			pixel(&image, POPUP)
		};

		transient_for(popup, red);
		assert_eq!(popup_pixel(), [255, 255, 0, 255]);
		transient_for(popup, blue);
		assert_eq!(popup_pixel(), [255, 0, 0, 255], "blue's popup");
		transient_for(popup, menu);
		transient_for(menu, blue);
		assert_eq!(popup_pixel(), [255, 0, 0, 255], "the popup of blue's menu");
		wm.delete_property(menu, AtomEnum::WM_TRANSIENT_FOR.into())
			.expect("unnamed menu");
		wm.sync().expect("sync");
		assert_eq!(popup_pixel(), [255, 255, 0, 255], "the popup of a menu naming no window");
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

	#[test]
	fn sixteen_bit_pixels_decode() {
		let masks = ColorMasks { red: 0xf800, green: 0x07e0, blue: 0x001f, alpha: 0 };
		// Three 16-bit pixels and the padding to a 32-bit scanline.
		let data = [0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0, 0];
		let image = zpixmap_to_rgba(&data, 3, 1, 16, 16, 32, true, masks).expect("decode");
		assert_eq!(image.as_raw().as_slice(), [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
	}

	#[test]
	fn translucent_popup_pixels_land_as_a_compositor_draws_them() {
		// pixman's OVER onto an opaque window: source + destination * (255 -
		// alpha) / 255, in premultiplied alpha, each product rounded to nearest.
		let mul = |a: u32, b: u32| {
			let t = a * b + 0x80;
			((t >> 8) + t) >> 8
		};
		for alpha in 1..255u32 {
			for premultiplied in (0..=alpha).step_by(7) {
				let masks =
					ColorMasks { red: 0xff_0000, green: 0xff00, blue: 0xff, alpha: 0xff00_0000 };
				let raw = (alpha << 24 | premultiplied << 16).to_le_bytes();
				let popup = zpixmap_to_rgba(&raw, 1, 1, 32, 32, 32, true, masks).expect("decode");
				for below in (0..=255u32).step_by(15) {
					let mut image = RgbaImage::from_pixel(1, 1, Rgba([below as u8, 0, 0, 255]));
					draw_over(&mut image, &popup, (0, 0));
					let expected = premultiplied + mul(below, 255 - alpha);
					assert_eq!(
						pixel(&image, (0, 0)),
						[expected as u8, 0, 0, 255],
						"alpha {alpha}, source {premultiplied}, below {below}"
					);
				}
			}
		}
	}
}
