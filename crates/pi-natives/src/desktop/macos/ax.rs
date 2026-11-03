mod enablement;
pub(crate) mod menus;
pub(super) mod open_menu;
mod popup;
mod selection;

use std::{
	collections::VecDeque,
	ffi::c_void,
	hash::{DefaultHasher, Hash, Hasher},
	mem,
	ops::Range,
	ptr::{self, NonNull},
	sync::LazyLock,
	time::Duration,
};

use objc2_application_services::{
	AXCopyMultipleAttributeOptions, AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
	CFArray, CFBoolean, CFDate, CFIndex, CFNull, CFNumber, CFRange, CFRetained, CFString,
	CFTimeZone, CFType, CFURL, CGPoint, CGSize, Type,
};

use super::{
	super::{
		ax::{AxBounds, AxHandle, AxProps, WalkBounds, normalize_role_macos},
		backend::{AxBackend, KeyboardFocus, is_raise_action, native_action_name},
		control,
		error::{CoreResult, DesktopError},
		text_range::{TextSelectRequest, Utf16Range, utf16_byte_range, utf16_slice},
		types::{AxTextSelection, DesktopWindow},
	},
	capture, date, input, permission, process,
	release_guard::{self, Presses},
	skylight,
};

const AX_TIMEOUT_SECONDS: f32 = 2.0;
/// Messaging timeout for the focus and hit-test probes made around input
/// delivery, so a hung application cannot stall the action itself.
const PROBE_TIMEOUT_SECONDS: f32 = 0.5;
/// Bounded `AXParent` ascent when an element does not expose `AXWindow`.
const MAX_ANCESTRY_DEPTH: usize = 40;
/// The action that scrolls an element into its view.
const SCROLL_TO_VISIBLE: &str = "AXScrollToVisible";
/// Bounds the search for a sheet, popover, or open menu that `AXWindows` does
/// not list, matching the snapshot walk's own node and depth budget.
const MAX_ATTACHED_SEARCH_NODES: usize = 5_000;
const MAX_ATTACHED_SEARCH_DEPTH: usize = 24;

/// The attributes read of every element a tree walk or `props` visits, all in
/// one `AXUIElementCopyMultipleAttributeValues` round trip rather than one
/// message each. Ordered so every [`NodeRead`] is a contiguous range: a walk
/// that skips bounds drops the last two, and `props` drops `AXChildren`,
/// whose count `AXUIElementGetAttributeValueCount` reads without copying the
/// array.
const NODE_ATTRIBUTES: [&str; 17] = [
	"AXChildren",
	"AXRole",
	"AXTitle",
	"AXValue",
	"AXDescription",
	"AXEnabled",
	"AXFocused",
	"AXSelected",
	"AXSubrole",
	"AXRoleDescription",
	"AXValueDescription",
	"AXHelp",
	"AXIdentifier",
	"AXURL",
	"AXPlaceholderValue",
	"AXPosition",
	"AXSize",
];
const CHILDREN: usize = 0;
const ROLE: usize = 1;
const TITLE: usize = 2;
const VALUE: usize = 3;
const DESCRIPTION: usize = 4;
const ENABLED: usize = 5;
const FOCUSED: usize = 6;
const SELECTED: usize = 7;
const SUBROLE: usize = 8;
const ROLE_DESCRIPTION: usize = 9;
const VALUE_DESCRIPTION: usize = 10;
const HELP: usize = 11;
const IDENTIFIER: usize = 12;
const URL: usize = 13;
const PLACEHOLDER: usize = 14;
const POSITION: usize = 15;
const SIZE: usize = 16;

/// The [`NODE_ATTRIBUTES`] read only to tell an element apart in its window
/// ([`read_identity`]) or to name a field by its placeholder. A batch that
/// fails as a whole skips them, so a hung app costs no more lone reads, each
/// with its own timeout, than the element's role, labels, state and children;
/// the element then has no identity, and a field without a label no name.
const IDENTITY_ONLY: Range<usize> = SUBROLE..POSITION;

/// Which slice of [`NODE_ATTRIBUTES`] one element read requests.
#[derive(Clone, Copy)]
enum NodeRead {
	Walk,
	WalkWithBounds,
	Props,
}

impl NodeRead {
	const ALL: [Self; 3] = [Self::Walk, Self::WalkWithBounds, Self::Props];

	const fn attributes(self) -> Range<usize> {
		match self {
			Self::Walk => CHILDREN..POSITION,
			Self::WalkWithBounds => CHILDREN..NODE_ATTRIBUTES.len(),
			Self::Props => ROLE..NODE_ATTRIBUTES.len(),
		}
	}
}

thread_local! {
	/// Each [`NodeRead`]'s attribute names as the `CFArray` it sends, indexed by
	/// the read and built once per session thread.
	static NODE_REQUESTS: [CFRetained<CFArray<CFString>>; 3] = NodeRead::ALL.map(|read| {
		let names: Vec<_> = NODE_ATTRIBUTES[read.attributes()]
			.iter()
			.map(|name| CFString::from_static_str(name))
			.collect();
		CFArray::from_retained_objects(&names)
	});
}

/// One element's [`NODE_ATTRIBUTES`] from a single batched read.
struct NodeValues {
	values: NodeBatch,
	/// [`NODE_ATTRIBUTES`] index of the first value.
	first:  usize,
}

enum NodeBatch {
	/// The values in request order.
	Read(CFRetained<CFArray<CFType>>),
	/// One lone read per requested attribute, in request order.
	Lone(Vec<Result<Option<CFRetained<CFType>>, AXError>>),
	/// The element is gone, so every attribute fails with this error.
	Gone(AXError),
}

impl NodeValues {
	fn read(element: &AXUIElement, read: NodeRead) -> Self {
		let mut output: *const CFArray = ptr::null();
		let error = NODE_REQUESTS.with(|requests| {
			// SAFETY: The request is a CFArray of CFString attribute names and
			// `output` is writable; a successful call stores a +1 CFArray there.
			unsafe {
				element.copy_multiple_attribute_values(
					requests[read as usize].as_opaque(),
					AXCopyMultipleAttributeOptions::empty(),
					NonNull::from(&mut output),
				)
			}
		});
		let batch = if error == AXError::Success {
			NonNull::new(output.cast_mut())
				.ok_or(AXError::Failure)
				.map(|pointer| {
					// SAFETY: The successful copy returned this array at +1; its
					// entries are attribute values or AXError-typed AXValues.
					let array: CFRetained<CFArray> = unsafe { CFRetained::from_raw(pointer) };
					// SAFETY: Every entry is a CF object.
					unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) }
				})
		} else {
			Err(error)
		};
		Self::from_batch(batch, read.attributes(), |index| {
			copy_attribute_result(element, NODE_ATTRIBUTES[index])
		})
	}

	/// The batch's values, or `lone` reads of each attribute outside
	/// [`IDENTITY_ONLY`] when the batch failed as a whole for a live element:
	/// a messaging timeout gives the batch one deadline for every attribute,
	/// and one slow attribute must not lose the element's role and children.
	fn from_batch(
		batch: Result<CFRetained<CFArray<CFType>>, AXError>,
		attributes: Range<usize>,
		mut lone: impl FnMut(usize) -> Result<Option<CFRetained<CFType>>, AXError>,
	) -> Self {
		let first = attributes.start;
		let values = match batch {
			Ok(values) => NodeBatch::Read(values),
			Err(error) if error == AXError::InvalidUIElement => NodeBatch::Gone(error),
			Err(_) => NodeBatch::Lone(
				attributes
					.map(|index| {
						if IDENTITY_ONLY.contains(&index) {
							Err(AXError::CannotComplete)
						} else {
							lone(index)
						}
					})
					.collect(),
			),
		};
		Self { values, first }
	}

	/// `NODE_ATTRIBUTES[index]` as a lone `AXUIElementCopyAttributeValue`
	/// reports it: the attribute's error, or `None` when it has no value.
	fn get(&self, index: usize) -> Result<Option<CFRetained<CFType>>, AXError> {
		let offset = index.checked_sub(self.first);
		let values = match &self.values {
			NodeBatch::Read(values) => values,
			NodeBatch::Lone(values) => {
				return offset
					.and_then(|offset| values.get(offset))
					.cloned()
					.unwrap_or(Err(AXError::Failure));
			},
			NodeBatch::Gone(error) => return Err(*error),
		};
		let value = offset
			.and_then(|offset| values.get(offset))
			.ok_or(AXError::Failure)?;
		if value.downcast_ref::<CFNull>().is_some() {
			return Ok(None);
		}
		if let Some(ax_value) = value.downcast_ref::<AXValue>()
			// SAFETY: Reading the type of a live AXValue has no preconditions.
			&& unsafe { ax_value.r#type() } == AXValueType::AXError
		{
			let mut error = AXError::Failure;
			// SAFETY: An AXError-typed AXValue holds exactly one AXError, which
			// `error` has room for.
			unsafe { ax_value.value(AXValueType::AXError, NonNull::from(&mut error).cast()) };
			return Err(error);
		}
		Ok(Some(value))
	}
}

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
		let root = Self::window_element(window)?;
		self.perform(&root, "AXRaise")
	}

	/// `window`'s element for an operation on the window itself, such as
	/// raising it or reading its menus: unlike
	/// [`AxBackend::window_root`], it never waits for web content, so the
	/// session's first read of the app still does.
	pub(super) fn window_element(window: &DesktopWindow) -> CoreResult<AxHandle> {
		let (_, _, element) = window_parts(window)?;
		set_timeout(&element)?;
		Ok(AxHandle::Mac(element))
	}
}

/// One accessibility top-level window of an application, mapped to its
/// `WindowServer` id.
pub(super) struct AxWindowRecord {
	/// `None` when `_AXUIElementGetWindow` cannot map the entry, as for
	/// Finder's desktop, which `AXWindows` lists as an `AXScrollArea`.
	pub(super) id:        Option<u32>,
	/// `AXMinimized`; `None` when the attribute could not be read.
	pub(super) minimized: Option<bool>,
}

/// The owner of the hit-testable surface at a global point.
pub(super) struct PointOwner {
	pub(super) pid:    libc::pid_t,
	/// `WindowServer` id of the surface's top-level window, when AX exposes it.
	pub(super) window: Option<u32>,
}

/// `WindowServer` id of `pid`'s `AXFocusedWindow`.
pub(super) fn focused_window_id(pid: libc::pid_t) -> Option<u32> {
	let app = probe_application(pid)?;
	let window = copy_element(&app, "AXFocusedWindow")?;
	window_id(&window)
}

/// An application's `AXFocusedWindow`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum FocusedWindow {
	/// The application reports none.
	#[default]
	Unreported,
	/// `_AXUIElementGetWindow` cannot map the window it reports.
	Unmapped,
	/// The read failed, such as an application that did not answer in time,
	/// so nothing is known about its focused window.
	Unreadable,
	Id(u32),
}

/// Where an application sends keystrokes: its focused window and the element
/// holding keyboard focus.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct KeyFocus {
	pub(super) window:         FocusedWindow,
	/// The window holding `AXFocusedUIElement`: the first id
	/// `_AXUIElementGetWindow` maps on the element or its nearest ancestor, so
	/// a field in a sheet maps to the sheet, not to the window it is attached
	/// to.
	pub(super) element_window: Option<u32>,
	/// Whether that id is the focused element's own, not an ancestor's. The
	/// fields of an Open panel's Go to Folder sheet map to no window: another
	/// process draws them.
	pub(super) element_mapped: bool,
}

/// Where keystrokes posted for window `wid` would go now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum KeyDestination {
	/// Into `wid`, posted to this process.
	Target(libc::pid_t),
	/// Into another window the application reports as focused; `None` when
	/// that window cannot be mapped to an id.
	Other(Option<u32>),
	/// The application reports no focused window, and its focused element is
	/// not in `wid` or in a window attached to it.
	Unreported,
}

impl KeyFocus {
	/// Where keystrokes for window `wid` of process `pid` would go.
	///
	/// The focused window decides when the application reports one; a sheet
	/// or panel it reports is another window, even when attached to `wid`.
	/// When it reports `wid`'s parent while the focused element is in `wid`,
	/// as Reminders does for a field in its details popover, keys reach `wid`.
	/// When it reports none, as Finder does while its inline rename field (an
	/// overlay window of its own) has focus, the focused element's window
	/// decides: `wid` itself, or a window `parent_of` says is attached to it.
	pub(super) fn destination(
		&self,
		pid: libc::pid_t,
		wid: u32,
		parent_of: impl Fn(u32) -> Option<u32>,
	) -> KeyDestination {
		match self.window {
			FocusedWindow::Id(id) if id == wid => KeyDestination::Target(pid),
			FocusedWindow::Id(_) if self.holds_overlay_focus(wid, &parent_of) => {
				KeyDestination::Target(pid)
			},
			FocusedWindow::Id(id) => KeyDestination::Other(Some(id)),
			FocusedWindow::Unmapped | FocusedWindow::Unreadable => KeyDestination::Other(None),
			FocusedWindow::Unreported => match self.element_window {
				Some(id) if [Some(id), parent_of(id)].contains(&Some(wid)) => {
					KeyDestination::Target(pid)
				},
				_ => KeyDestination::Unreported,
			},
		}
	}

	/// Whether `wid` is an overlay attached to the reported focused window
	/// and the focused element is in it, such as a field in a popover.
	fn holds_overlay_focus(&self, wid: u32, parent_of: impl Fn(u32) -> Option<u32>) -> bool {
		let FocusedWindow::Id(focused) = self.window else {
			return false;
		};
		focused != wid && self.element_window == Some(wid) && parent_of(wid) == Some(focused)
	}

	/// Whether text inserted into the focused element lands in `wid`: the
	/// element is in `wid`, or keys for `wid` would reach it.
	pub(super) fn holds_text_for(
		&self,
		pid: libc::pid_t,
		wid: u32,
		parent_of: impl Fn(u32) -> Option<u32>,
	) -> bool {
		self.element_window == Some(wid)
			|| matches!(self.destination(pid, wid, parent_of), KeyDestination::Target(_))
	}

	/// Whether keyboard focus sits in an overlay window, such as Finder's
	/// inline rename field or a popover: one attached to `wid` while the
	/// application reports `wid`, or nothing, as its focused window, or `wid`
	/// itself while it reports the window `wid` is attached to, or nothing.
	pub(super) fn in_overlay_of(&self, wid: u32, parent_of: impl Fn(u32) -> Option<u32>) -> bool {
		if self.holds_overlay_focus(wid, &parent_of) {
			return true;
		}
		if self.window == FocusedWindow::Unreported && self.element_window == Some(wid) {
			return parent_of(wid).is_some();
		}
		let reported = match self.window {
			FocusedWindow::Unreported => true,
			FocusedWindow::Id(id) => id == wid,
			FocusedWindow::Unmapped | FocusedWindow::Unreadable => false,
		};
		let overlay = self.element_window.filter(|&id| id != wid);
		reported && overlay.is_some_and(|id| parent_of(id) == Some(wid))
	}

	/// Whether the focused element itself maps to window `wid`, which proves
	/// that `wid`'s own process holds the focus there.
	pub(super) fn element_maps_to(&self, wid: u32) -> bool {
		self.element_mapped && self.element_window == Some(wid)
	}
}

/// Reads where `pid` sends keystrokes; every part it cannot read is `None`,
/// and a focused window that cannot be read is [`FocusedWindow::Unreadable`].
pub(super) fn key_focus(pid: libc::pid_t) -> KeyFocus {
	let Some(app) = probe_application(pid) else {
		return KeyFocus { window: FocusedWindow::Unreadable, ..KeyFocus::default() };
	};
	read_key_focus(&app).0
}

fn read_focused_window(app: &AXUIElement) -> FocusedWindow {
	let read = copy_attribute_result(app, "AXFocusedWindow")
		.map(|window| window.and_then(|window| window.downcast::<AXUIElement>().ok()));
	focused_window(read, |window| window_id(window))
}

/// An `AXFocusedWindow` `read`, its element mapped through `id_of`. Only an
/// answer that there is no value says the application has no focused
/// window; any other failure leaves it unknown.
fn focused_window<E>(
	read: Result<Option<E>, AXError>,
	id_of: impl FnOnce(&E) -> Option<u32>,
) -> FocusedWindow {
	match read {
		Ok(Some(window)) => id_of(&window).map_or(FocusedWindow::Unmapped, FocusedWindow::Id),
		Ok(None) | Err(AXError::NoValue | AXError::AttributeUnsupported) => FocusedWindow::Unreported,
		Err(_) => FocusedWindow::Unreadable,
	}
}

fn read_key_focus(app: &AXUIElement) -> (KeyFocus, Option<CFRetained<AXUIElement>>) {
	let window = read_focused_window(app);
	let element = copy_element(app, "AXFocusedUIElement");
	let (element_window, element_mapped) = element
		.as_deref()
		.and_then(innermost_window_id)
		.map_or((None, false), |(id, own)| (Some(id), own));
	(KeyFocus { window, element_window, element_mapped }, element)
}

/// The first window id `_AXUIElementGetWindow` maps on `element` or, through
/// a bounded `AXParent` ascent, its nearest ancestor, and whether it is the
/// element's own.
fn innermost_window_id(element: &AXUIElement) -> Option<(u32, bool)> {
	let mut current = element.retain();
	for depth in 0..MAX_ANCESTRY_DEPTH {
		if let Some(id) = window_id(&current) {
			return Some((id, depth == 0));
		}
		current = copy_element(&current, "AXParent")?;
	}
	None
}

/// Which process draws a window's content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WindowContent {
	/// The window's own process, or nothing shows another one.
	Own,
	/// Another process: the window is a remote view of `window`, a window of
	/// process `pid` that `WindowServer` keeps off its window list. System
	/// Open and Save panels, and the sheets they open, are drawn this way by
	/// `openAndSavePanelService`.
	Remote { pid: libc::pid_t, window: u32 },
}

/// Who draws window `wid` of process `pid`, from the window ids its
/// accessibility children map to (`None` for a child that maps to none) and
/// `owner_of`, which reads a window's `WindowServer` owner.
///
/// A remote view's elements report the host's pid, but `_AXUIElementGetWindow`
/// maps them to the drawing process's own window. The content counts as
/// remote only while no child maps to a window of `pid`, so a window that
/// embeds a remote view among controls of its own stays the host's.
fn content_owner(
	pid: libc::pid_t,
	wid: u32,
	children: impl IntoIterator<Item = Option<u32>>,
	owner_of: impl Fn(u32) -> Option<libc::pid_t>,
) -> WindowContent {
	let mut remote = None;
	for id in children.into_iter().flatten() {
		if id == wid {
			return WindowContent::Own;
		}
		if matches!(remote, Some(WindowContent::Remote { window, .. }) if window == id) {
			continue;
		}
		match owner_of(id) {
			Some(owner) if owner != pid => {
				remote.get_or_insert(WindowContent::Remote { pid: owner, window: id });
			},
			_ => return WindowContent::Own,
		}
	}
	remote.unwrap_or(WindowContent::Own)
}

/// Who draws `window` of process `pid`, read from its accessibility window
/// whether or not it is the focused one, so that a system panel behind
/// another window of its application still shows its drawing process;
/// [`WindowContent::Own`] when that window cannot be found or read.
pub(super) fn window_content(pid: libc::pid_t, window: &DesktopWindow) -> WindowContent {
	let (Ok(wid), Some(app)) = (window.id.parse::<u32>(), probe_application(pid)) else {
		return WindowContent::Own;
	};
	let focused = copy_element(&app, "AXFocusedWindow");
	let Some(element) =
		target_window(wid, focused, |focused| window_id(focused), || find_window(&app, window).ok())
	else {
		return WindowContent::Own;
	};
	let children = copy_elements_optional(&element, "AXChildren").unwrap_or_default();
	content_owner(
		pid,
		wid,
		children.iter().map(|child| window_id(child)),
		skylight::window_owner_pid,
	)
}

/// Window `wid`'s accessibility element: the application's `focused` window
/// when that is `wid`, which spares the search through its windows and
/// sheets, else what `find` finds.
fn target_window<E>(
	wid: u32,
	focused: Option<E>,
	id_of: impl Fn(&E) -> Option<u32>,
	find: impl FnOnce() -> Option<E>,
) -> Option<E> {
	focused
		.filter(|focused| id_of(focused) == Some(wid))
		.or_else(find)
}

/// How an error names a window: its id, title and, for anything but a
/// standard window, its AX subrole or role (`AXDialog`, `AXSheet`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WindowLabel {
	pub(super) id:    Option<u32>,
	pub(super) title: Option<String>,
	pub(super) kind:  Option<String>,
}

/// `pid`'s `AXFocusedWindow`, labelled for an error message.
pub(super) fn focused_window_label(pid: libc::pid_t) -> Option<WindowLabel> {
	let app = probe_application(pid)?;
	let window = copy_element(&app, "AXFocusedWindow")?;
	let kind = copy_string(&window, "AXSubrole")
		.filter(|subrole| subrole != "AXStandardWindow")
		.or_else(|| copy_string(&window, "AXRole").filter(|role| role != "AXWindow"));
	Some(WindowLabel {
		id: window_id(&window),
		title: nonempty(copy_string(&window, "AXTitle")),
		kind,
	})
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

/// `AXFrontmost` as `pid`'s application reports it. `AppKit` answers from the
/// application's own active state, which an `AppKit`-defined activation event
/// sets while `WindowServer`'s front process stays the user's app.
pub(super) fn reports_active(pid: libc::pid_t) -> Option<bool> {
	let app = probe_application(pid)?;
	copy_bool(&app, "AXFrontmost")
}

/// Whether `pid` stopped answering: an accessibility request got no reply
/// within `timeout` seconds while the process still exists. Other AX errors,
/// such as missing trust, prove nothing about the application and do not count.
pub(super) fn stopped_answering(pid: libc::pid_t, timeout: f32) -> bool {
	let Ok(app) = create_application(pid) else {
		return false;
	};
	// SAFETY: The retained application element is valid for the timeout update.
	let _ = unsafe { app.set_messaging_timeout(timeout) };
	matches!(copy_attribute_result(&app, "AXFocusedWindow"), Err(AXError::CannotComplete))
		// SAFETY: Signal 0 only checks that the process exists.
		&& unsafe { libc::kill(pid, 0) } == 0
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
	// As on every window lookup, the role query switches on Chromium's web
	// accessibility; only the first content read waits for it.
	enablement::activate(&app);
	let windows = copy_elements_optional(&app, "AXWindows")?;
	Some(window_records_of(&windows))
}

/// An entry `_AXUIElementGetWindow` cannot map is still a possible keyboard
/// destination, so it stays as a record with no id: dropping it would turn an
/// incomplete AX tree into false proof of exclusivity.
fn window_records_of(windows: &[CFRetained<AXUIElement>]) -> Vec<AxWindowRecord> {
	windows
		.iter()
		.map(|window| AxWindowRecord {
			id:        window_id(window),
			minimized: copy_bool(window, "AXMinimized"),
		})
		.collect()
}

/// Whether `pid` has a window, among its `AXWindows`, that is not minimized:
/// one that unhiding the application shows. `None` when nothing can be read.
pub(in crate::desktop) fn has_open_window(pid: libc::pid_t) -> Option<bool> {
	let records = window_records(pid)?;
	Some(
		records
			.iter()
			.any(|record| record.id.is_some() && record.minimized != Some(true)),
	)
}

/// The window ids of `pid`'s `AXWindows`: windows that can be key, without
/// the compositor surfaces Chromium, Electron and `WebKit` add to Quartz's
/// list. `None` when nothing can be read.
pub(in crate::desktop) fn ax_window_ids(pid: libc::pid_t) -> Option<Vec<u32>> {
	Some(
		window_records(pid)?
			.into_iter()
			.filter_map(|record| record.id)
			.collect(),
	)
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
	Some(PointOwner { pid, window: window.as_deref().and_then(window_id) })
}

/// Raises a known window for explicit takeover or restoration.
pub(super) fn raise_window_id(pid: libc::pid_t, wid: u32) -> CoreResult<()> {
	let app = probe_application(pid).ok_or_else(|| {
		DesktopError::ax_failed(format!("cannot inspect process {pid} for AXRaise"))
	})?;
	let windows = copy_elements(&app, "AXWindows")?;
	let window = windows
		.into_iter()
		.find(|window| window_id(window) == Some(wid))
		.ok_or_else(|| {
			DesktopError::window_not_found(format!("window {wid} is no longer available for AXRaise"))
		})?;
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

/// The window id of `element` when it is itself one of `pid`'s `AXWindows`
/// though not an `AXWindow`, as Finder's inline rename field is: such an
/// element has no window above it and stands for its own.
fn listed_window_id(pid: libc::pid_t, element: &AXUIElement) -> Option<u32> {
	let app = probe_application(pid)?;
	let windows = copy_elements(&app, "AXWindows").ok()?;
	windows
		.iter()
		.any(|window| **window == *element)
		.then(|| window_id(element))
		.flatten()
}

/// An element that stands for its own `WindowServer` window but is absent
/// from `AXWindows`, with what can identify that window.
#[derive(Clone, Copy, Debug)]
enum AttachedCandidate {
	/// An `AXSheet` or `AXPopover`: `_AXUIElementGetWindow` reports its own
	/// window id.
	OwnWindow(Option<u32>),
	/// An open `AXMenu`: it reports no window id, or the id of the window it
	/// was opened from, so only its frame can identify it.
	Menu { frame_matches: bool },
}

/// Picks the candidate that represents native window `expected`: the sheet
/// or popover reporting that exact id, else the one menu whose frame matches.
///
/// A sheet or popover reporting another id is a different window and never
/// inherits the target by frame. Ambiguity refuses rather than guessing.
fn select_attached(candidates: &[AttachedCandidate], expected: u32) -> CoreResult<Option<usize>> {
	let unique = |is_match: &dyn Fn(&AttachedCandidate) -> bool, what: &str| {
		let mut matches = (0..candidates.len()).filter(|&index| is_match(&candidates[index]));
		match (matches.next(), matches.next()) {
			(None, _) => Ok(None),
			(Some(index), None) => Ok(Some(index)),
			(Some(_), Some(_)) => Err(DesktopError::ax_failed(format!(
				"native window {expected} matches more than one accessibility {what}"
			))),
		}
	};
	let exact = unique(
		&|candidate| matches!(candidate, AttachedCandidate::OwnWindow(Some(id)) if *id == expected),
		"sheet or popover",
	)?;
	if exact.is_some() {
		return Ok(exact);
	}
	unique(
		&|candidate| matches!(candidate, AttachedCandidate::Menu { frame_matches: true }),
		"menu frame",
	)
}

/// Outcome of the bounded search for an attached window.
enum AttachedSearch {
	Found(CFRetained<AXUIElement>),
	/// Nothing matched; `truncated` is set when the node or depth budget cut
	/// the walk short, so the window may still exist deeper in the tree.
	Missing {
		truncated: bool,
	},
}

/// The accessibility window of `app` that represents `win`: matched by native
/// window id, among `AXWindows` and then its sheets, popovers and open menus,
/// or, without the window-id SPI, by a unique title and frame.
fn find_window(app: &AXUIElement, win: &DesktopWindow) -> CoreResult<CFRetained<AXUIElement>> {
	let windows = copy_elements(app, "AXWindows")?;
	let expected_id = win.id.parse::<u32>().ok();
	if let (Some(get_id), Some(expected_id)) = (*GET_WINDOW_ID, expected_id) {
		for element in windows {
			let mut actual_id = 0u32;
			// SAFETY: `actual_id` is writable and this retained AX element
			// remains alive for the call.
			if unsafe { get_id(&element, &mut actual_id) } == AXError::Success
				&& actual_id == expected_id
			{
				return Ok(element);
			}
		}
		// Sheets, popovers, and open menus are separate native windows that
		// `AXWindows` omits.
		let truncated = match attached_window(app, expected_id, win)? {
			AttachedSearch::Found(element) => return Ok(element),
			AttachedSearch::Missing { truncated } => truncated,
		};
		let scope = if truncated {
			format!(
				"; the search stopped at its limit of {MAX_ATTACHED_SEARCH_NODES} nodes or depth \
				 {MAX_ATTACHED_SEARCH_DEPTH}, so the window may be nested deeper"
			)
		} else {
			String::new()
		};
		return Err(DesktopError::ax_failed(format!(
			"native window {expected_id} was not found in the application's accessibility windows, \
			 sheets, popovers, or open menus{scope}"
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
	Ok(element)
}

/// Finds the sheet, popover, or open menu of `app` that represents `win`,
/// by a bounded breadth-first walk of the application's accessibility tree.
/// `AppKit` gives each its own `WindowServer` window but lists only standard
/// windows in `AXWindows`.
///
/// A sheet or popover reporting `expected` ends the walk at once: a window id
/// names one window, so no later candidate can compete with it. Only menus,
/// which match by frame, need the whole walk to prove uniqueness. The walk
/// stops with `Cancelled` once the current operation is cancelled.
fn attached_window(
	app: &AXUIElement,
	expected: u32,
	win: &DesktopWindow,
) -> CoreResult<AttachedSearch> {
	let mut queue: VecDeque<_> = copy_elements_optional(app, "AXChildren")
		.unwrap_or_default()
		.into_iter()
		.map(|element| (element, 1usize))
		.collect();
	let mut elements = Vec::new();
	let mut candidates = Vec::new();
	let mut visited = 0usize;
	let mut truncated = false;
	while let Some((element, depth)) = queue.pop_front() {
		control::check()?;
		visited += 1;
		if visited > MAX_ATTACHED_SEARCH_NODES {
			truncated = true;
			break;
		}
		let (candidate, descend) = match copy_string(&element, "AXRole").as_deref() {
			Some("AXSheet" | "AXPopover") => {
				let id = window_id(&element);
				if id == Some(expected) {
					return Ok(AttachedSearch::Found(element));
				}
				(Some(AttachedCandidate::OwnWindow(id)), true)
			},
			Some("AXMenu") => {
				// A closed menu keeps its items in the tree at zero size; only
				// an open menu can hold an open submenu.
				let frame = bounds(&element).filter(|b| b.width > 0.0 && b.height > 0.0);
				let frame_matches = frame.is_some_and(|b| bounds_matches_window(b, win));
				(Some(AttachedCandidate::Menu { frame_matches }), frame.is_some())
			},
			_ => (None, true),
		};
		if descend {
			let children = copy_elements_optional(&element, "AXChildren").unwrap_or_default();
			if depth < MAX_ATTACHED_SEARCH_DEPTH {
				queue.extend(children.into_iter().map(|child| (child, depth + 1)));
			} else if !children.is_empty() {
				truncated = true;
			}
		}
		if let Some(candidate) = candidate {
			candidates.push(candidate);
			elements.push(element);
		}
	}
	Ok(match select_attached(&candidates, expected)? {
		Some(index) => AttachedSearch::Found(elements.swap_remove(index)),
		None => AttachedSearch::Missing { truncated },
	})
}

/// `win`'s owning process, its application element (role queried, which
/// switches on Chromium's web accessibility) and its window element.
fn window_parts(
	win: &DesktopWindow,
) -> CoreResult<(libc::pid_t, CFRetained<AXUIElement>, CFRetained<AXUIElement>)> {
	ensure_trusted()?;
	let pid = win.pid.ok_or_else(|| {
		DesktopError::ax_failed(format!("window {} has no owning process id", win.id))
	})?;
	let pid = i32::try_from(pid).map_err(|_| {
		DesktopError::ax_failed(format!("window {} has an invalid process id", win.id))
	})?;
	let app = create_application(pid)?;
	set_timeout(&app)?;
	enablement::activate(&app);
	let element = find_window(&app, win)?;
	Ok((pid, app, element))
}

impl AxBackend for MacAx {
	/// For a read of the window's content: the session's first read of a
	/// Chromium-family app waits for its web content ([`enablement`]).
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		let (pid, app, element) = window_parts(win)?;
		enablement::before_first_read(pid, &app, &element)?;
		// The wait gives the window's requests shorter timeouts.
		set_timeout(&element)?;
		Ok(AxHandle::Mac(element))
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let element = mac_handle(h)?;
		let pid = element_pid(element)?;
		let wid = if let Some(window) = element_window(element) {
			window_id(&window).ok_or_else(|| {
				DesktopError::ax_failed("AX element's native window id is unavailable")
			})?
		} else if let Some(wid) = listed_window_id(pid, element) {
			wid
		} else {
			// A destroyed element has no window either: say so as the
			// `StaleRef` every element operation gives.
			copy_held_attribute(element, "AXRole")?;
			return Err(DesktopError::ax_failed("AX element has no identifiable owning window"));
		};
		windows
			.iter()
			.find(|candidate| {
				candidate.id.parse::<u32>() == Ok(wid)
					&& candidate.pid.and_then(|pid| i32::try_from(pid).ok()) == Some(pid)
			})
			.map(|candidate| candidate.id.clone())
			.ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"AX element's window {wid} is not an available window of process {pid}"
				))
			})
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let element = mac_handle(h)?;
		let values = NodeValues::read(element, NodeRead::Props);
		let mut count: CFIndex = 0;
		// SAFETY: `count` is writable and the retained element outlives the
		// query.
		let counted = unsafe {
			element.attribute_value_count(
				&CFString::from_static_str("AXChildren"),
				NonNull::from(&mut count),
			)
		};
		let child_count = if counted == AXError::Success {
			usize::try_from(count).unwrap_or(0)
		} else {
			0
		};
		element_props(element, &values, child_count, WalkBounds::Read)
	}

	fn walk_node(
		&mut self,
		h: &AxHandle,
		read_bounds: WalkBounds,
	) -> CoreResult<(AxProps, Vec<AxHandle>)> {
		let element = mac_handle(h)?;
		let read = match read_bounds {
			WalkBounds::Read => NodeRead::WalkWithBounds,
			WalkBounds::Skip => NodeRead::Walk,
		};
		let values = NodeValues::read(element, read);
		let children = values.get(CHILDREN);
		let children_read = answered(&children);
		let children = children
			.ok()
			.flatten()
			.and_then(element_array)
			.unwrap_or_default();
		let mut props = element_props(element, &values, children.len(), read_bounds)?;
		props.partial |= !children_read;
		Ok((props, children.into_iter().map(AxHandle::Mac).collect()))
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		Ok(copy_held_attribute(mac_handle(h)?, "AXChildren")?
			.and_then(element_array)
			.unwrap_or_default()
			.into_iter()
			.map(AxHandle::Mac)
			.collect())
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		Ok(copy_held_attribute(mac_handle(h)?, "AXParent")?
			.and_then(|value| value.downcast::<AXUIElement>().ok())
			.map(AxHandle::Mac))
	}

	/// An action that may open a menu can post the press that makes its window
	/// key and the Escape that closes the menu; their release helper starts
	/// only then.
	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		release_guard::scope(Presses::Nothing, || perform_choosing(mac_handle(h)?, action, None))
	}

	/// A menu path always waits for a menu, so the helper starts up front.
	fn perform_menu(&mut self, h: &AxHandle, action: &str, path: &[String]) -> CoreResult<()> {
		release_guard::scope(Presses::Process, || {
			perform_choosing(mac_handle(h)?, action, Some(path))
		})
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		// A popup's value is chosen from its menu, not written. This runs before
		// the text-target refusals: nothing is typed or written, and the verdict
		// is the popup's own read-back after a real menu press.
		let role = copy_held_attribute(element, "AXRole")?
			.and_then(|value| value.downcast::<CFString>().ok());
		if role.is_some_and(|role| role.to_string() == "AXPopUpButton") {
			// Choosing opens the popup's menu, so the release helper starts
			// up front.
			return release_guard::scope(Presses::Process, || {
				skylight::with_background_guard(element_pid(element)?, || popup::choose(element, value))
			});
		}
		// Web AXValue can echo a write without the renderer accepting it. The
		// API has no "unverified" outcome, so refuse before mutating that
		// surface.
		ensure_native_text_target(element)?;
		if !attribute_settable(element, "AXValue") {
			return Err(DesktopError::ax_failed(
				"AXValue is not settable; no typing fallback was attempted",
			));
		}
		if let Some(current) = copy_date(element, "AXValue") {
			return set_date_value(element, value, current);
		}
		let pid = element_pid(element)?;
		// Focus is borrowed only from an app already in the background as the
		// call starts: only then does the guard below watch for the user
		// and restore the front app.
		let started_in_background = may_borrow_focus(skylight::front_pid(), pid);
		skylight::with_background_guard(pid, || {
			// Apps commit what reaches their field editor; several (Contacts,
			// Font Book, System Settings search) echo an AXValue write without
			// ever taking it, so replace the text the way `typeText` inserts it.
			if replace_native_text(element, pid, started_in_background, value)? {
				return Ok(());
			}
			// The probes above can block; a run cancelled meanwhile, or an app
			// the user used meanwhile ([`control::intervention::check_press`]),
			// gets nothing written.
			control::check()?;
			control::intervention::check_press()?;
			set_string_value(element, "AXValue", value)?;
			verify_text_value(element, value, value)
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let element = mac_handle(h)?;
		skylight::with_background_guard(element_pid(element)?, || {
			control::intervention::check_press()?;
			set_focused(element)
		})
	}

	fn select_text(
		&mut self,
		h: &AxHandle,
		request: &TextSelectRequest,
	) -> CoreResult<AxTextSelection> {
		selection::select(mac_handle(h)?, request)
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

	/// The app answers `InvalidUIElement` only for an element it no longer
	/// has; a busy or slow app answers otherwise.
	fn destroyed(&mut self, h: &AxHandle) -> bool {
		mac_handle(h).is_ok_and(|element| {
			copy_attribute_result(element, "AXRole").err() == Some(AXError::InvalidUIElement)
		})
	}

	fn focused_within(&mut self, h: &AxHandle) -> Option<AxHandle> {
		let app = probe_application(element_pid(mac_handle(h).ok()?).ok()?)?;
		copy_element(&app, "AXFocusedUIElement").map(AxHandle::Mac)
	}

	fn value_settable(&mut self, h: &AxHandle) -> Option<bool> {
		attribute_settable_answer(mac_handle(h).ok()?, "AXValue")
	}
}

fn element_props(
	element: &AXUIElement,
	values: &NodeValues,
	child_count: usize,
	read_bounds: WalkBounds,
) -> CoreResult<AxProps> {
	let native_role = required_string(values.get(ROLE), "AXRole")?;
	let actions = copy_strings_from_action_names(element).unwrap_or_default();
	let read = |index| values.get(index).ok().flatten();
	let string = |index| {
		read(index)
			.and_then(|value| value.downcast::<CFString>().ok())
			.map(|value| value.to_string())
	};
	let boolean = |index| {
		read(index)
			.and_then(|value| value.downcast::<CFBoolean>().ok())
			.map(|value| value.as_bool())
	};
	let title = nonempty(string(TITLE));
	let value = nonempty(read(VALUE).map(|value| stringify_value(&value)));
	// A field with no label of its own is named by its placeholder ("Add
	// Date"), as an accessible name falls back to it.
	let description = nonempty(string(DESCRIPTION))
		.or_else(|| nonempty(string(PLACEHOLDER)).filter(|_| title.is_none()));
	let identity = read_identity(values, &native_role, [&title, &value, &description]);
	let role_name = window_control_name(&native_role, [&title, &description], string(SUBROLE));
	let selected = selected(values, &native_role);
	Ok(AxProps {
		role: normalize_role_macos(&native_role),
		native_role,
		title,
		value,
		description,
		enabled: boolean(ENABLED).unwrap_or(true),
		focused: boolean(FOCUSED).unwrap_or(false),
		bounds: match read_bounds {
			WalkBounds::Read => read(POSITION)
				.zip(read(SIZE))
				.and_then(|(position, size)| frame(&position, &size)),
			WalkBounds::Skip => None,
		},
		actions,
		child_count: u32::try_from(child_count).unwrap_or(u32::MAX),
		partial: identity.is_none(),
		identity,
		selected,
		role_name: role_name.map(str::to_owned),
	})
}

/// Whether the element reports itself selected. Only list and table rows and
/// cells, buttons, and the file icons of Finder's icon view count: Finder's
/// icon list reports a section rather than the icons as its selected
/// children.
fn selected(values: &NodeValues, native_role: &str) -> bool {
	matches!(native_role, "AXRow" | "AXCell" | "AXButton" | "AXImage")
		&& values
			.get(SELECTED)
			.ok()
			.flatten()
			.and_then(|value| value.downcast::<CFBoolean>().ok())
			.is_some_and(|value| value.as_bool())
}

/// The name a window's own button, which has no title or description, takes
/// from its subrole.
fn window_control_name(
	native_role: &str,
	labels: [&Option<String>; 2],
	subrole: Option<String>,
) -> Option<&'static str> {
	let unlabeled = labels
		.into_iter()
		.flatten()
		.all(|label| label.trim().is_empty());
	if !unlabeled || native_role != "AXButton" {
		return None;
	}
	match subrole?.as_str() {
		"AXCloseButton" => Some("close"),
		"AXMinimizeButton" => Some("minimize"),
		"AXZoomButton" => Some("zoom"),
		"AXFullScreenButton" => Some("full screen"),
		_ => None,
	}
}

/// The [`NODE_ATTRIBUTES`] that, with `AXRole`, tell an element apart in its
/// window.
const IDENTIFYING: [usize; 10] = [
	SUBROLE,
	ROLE_DESCRIPTION,
	TITLE,
	DESCRIPTION,
	VALUE,
	VALUE_DESCRIPTION,
	HELP,
	IDENTIFIER,
	URL,
	PLACEHOLDER,
];

/// The element's [`AxProps::identity`], hashed from its role and
/// [`IDENTIFYING`] attributes, its title, value and description as
/// [`element_props`] reads them. `None` when the app did not get to answer
/// one of them, as when it was too busy to reply: the walk that met it then
/// can't vouch for any identity. A read that fails outright counts as its own
/// value, since `AppKit` fails some attributes on every read, a checkbox's
/// `AXSubrole` among them.
fn read_identity(
	values: &NodeValues,
	native_role: &str,
	[title, value, description]: [&Option<String>; 3],
) -> Option<u64> {
	let mut hasher = DefaultHasher::new();
	native_role.hash(&mut hasher);
	for index in IDENTIFYING {
		let read = values.get(index);
		if read.as_ref().err() == Some(&AXError::Failure) {
			hasher.write_u8(0);
			continue;
		}
		if !answered(&read) {
			return None;
		}
		hasher.write_u8(1);
		match index {
			TITLE => title.hash(&mut hasher),
			VALUE => value.hash(&mut hasher),
			DESCRIPTION => description.hash(&mut hasher),
			URL => nonempty(read.ok().flatten().map(|url| stringify_value(&url))).hash(&mut hasher),
			_ => nonempty(
				read
					.ok()
					.flatten()
					.and_then(|value| value.downcast::<CFString>().ok())
					.map(|value| value.to_string()),
			)
			.hash(&mut hasher),
		}
	}
	Some(hasher.finish())
}

/// Whether an attribute read got the element's answer: a value, or the
/// element saying it has none. Any other error leaves the value unknown.
fn answered<T>(read: &Result<Option<T>, AXError>) -> bool {
	read
		.as_ref()
		.err()
		.is_none_or(|error| *error == AXError::NoValue || *error == AXError::AttributeUnsupported)
}

/// Performs `action` on `element`; with `path`, chooses that item path in the
/// menu the action opens.
fn perform_choosing(
	element: &AXUIElement,
	action: &str,
	path: Option<&[String]>,
) -> CoreResult<()> {
	// Read before any probe of the target, as for background input
	// ([`input::EntryFront`]).
	let entry_front = input::EntryFront::now();
	let actions = copy_strings_from_action_names(element)?;
	let Some(native) = supported_action(&actions, action).cloned() else {
		return Err(unsupported_action(&native_action_name(action), &actions));
	};
	// AXRaise is an explicit request to change stacking, including the
	// takeover preparation path. Other semantic actions must stay background.
	if is_raise_action(action) {
		if path.is_some() {
			return Err(DesktopError::invalid_target("AXRaise opens no menu to choose an item from"));
		}
		return element_action_result(&native, send_action(element, &native));
	}
	let pid = element_pid(element)?;
	let scroll = scroll_before_press(&native, &actions, || process::is_uikit(pid));
	let perform = || press_into_view(&native, scroll, |action| send_action(element, action));
	// A menu that a background application opens takes the keyboard from the
	// user's app, so it is closed before the action returns; a frontmost
	// application's menu stays open for the next call unless an item is asked
	// for.
	let background = entry_front.behind(pid);
	let watch = path.is_some()
		|| (background && open_menu::may_open(&native, || copy_string(element, "AXRole")));
	skylight::with_background_watch(pid, |visit| {
		// A popup in a system Open or Save panel opens its menu in the
		// process that draws the panel.
		let drawn = if watch {
			innermost_window_id(element).map(|(id, _)| id)
		} else {
			None
		};
		let menu_pid = open_menu::menu_process(pid, drawn, skylight::window_owner_pid);
		let before = if watch {
			let before = capture::menu_windows(menu_pid).ok_or_else(|| {
				DesktopError::ax_failed(format!(
					"cannot list the open menus of process {menu_pid}, so a menu that {native} opens \
					 could not be closed; nothing was performed"
				))
			})?;
			if background {
				activate_for_menu(element, pid, entry_front, visit)?;
			}
			Some(before)
		} else {
			None
		};
		open_menu::guard(
			open_menu::Press::Action(&native),
			before.as_deref(),
			path,
			perform,
			|before, path| {
				// The user may have brought the target forward while its menu
				// appeared.
				let holds = || {
					input::recheck_background(
						background,
						pid,
						drawn.unwrap_or_default(),
						skylight::front_pid,
						|| visit.happened(),
						|| Ok(()),
					)
				};
				open_menu::settle(menu_pid, pid, before, path, open_menu::CONTROL_MENU_TIMEOUT, holds)
			},
		)
	})
}

/// The refusal of `native`, an action the element does not list among
/// `actions`; nothing was sent. A control without a press action still takes
/// a click, `menu` path included.
fn unsupported_action(native: &str, actions: &[String]) -> DesktopError {
	let instead = if native == "AXPress" {
		"; nothing was sent: if this is the control you meant, click() it instead, passing the same \
		 menu option if you gave one"
	} else {
		""
	};
	DesktopError::ax_failed(format!(
		"AX action '{native}' is not supported by this element; available actions: {}{instead}",
		actions.join(", "),
	))
}

/// Makes the window holding `element` key within its background
/// application, as a background click does, before an action that opens a
/// menu: `AppKit` validates a menu's items when it opens, and an inactive
/// Finder read every Action-menu command but three as disabled. An element
/// whose window cannot be resolved is acted on as it is. An element in a
/// sheet or popover is in that window ([`menu_window`]); on the focused
/// window it gets only the activation, as a background click into it does,
/// since the press that makes a window key would close a popover.
fn activate_for_menu(
	element: &AXUIElement,
	pid: libc::pid_t,
	entry_front: input::EntryFront,
	visit: skylight::TargetVisit<'_>,
) -> CoreResult<()> {
	let Some(attached_to) = element_window(element).as_deref().and_then(window_id) else {
		return Ok(());
	};
	let drawn = innermost_window_id(element).map(|(id, _)| id);
	let wid = menu_window(attached_to, drawn, skylight::window_parent);
	let Ok(window) = capture::window_by_id(&wid.to_string()) else {
		return Ok(());
	};
	let in_overlay = input::takes_overlay_focus(wid, key_focus(pid), skylight::window_parent);
	let prepared = input::make_key_in_background(
		&input::source()?,
		pid,
		wid,
		&window,
		entry_front,
		in_overlay,
		visit,
	)?;
	// The press that makes the window key waits in the application's event
	// queue, while the action that follows is handled as soon as it arrives:
	// `AXShowMenu` sent right behind the press opened its menu first, and the
	// press, landing outside the menu, closed it again.
	if prepared && !in_overlay {
		control::wait(input::POINTER_SETTLE)?;
	}
	// A popover never becomes the focused window; the one it is on already is.
	if !in_overlay {
		input::await_key_window(pid, wid)?;
	}
	input::recheck_background(
		prepared,
		pid,
		wid,
		skylight::front_pid,
		|| visit.happened(),
		|| Ok(()),
	)
}

/// The window an element's menu action is aimed at: `drawn`, the window
/// `_AXUIElementGetWindow` maps the element to, when it is a sheet or popover
/// attached to `attached_to`, the element's `AXWindow`, which a sheet's or
/// popover's controls report; otherwise `attached_to`.
fn menu_window(
	attached_to: u32,
	drawn: Option<u32>,
	parent_of: impl Fn(u32) -> Option<u32>,
) -> u32 {
	drawn
		.filter(|&id| {
			id != attached_to && input::attached_under(id, parent_of, |parent| parent == attached_to)
		})
		.unwrap_or(attached_to)
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
			"terminal AX text represents its rendered grid, not terminal input; use win.type instead",
		));
	}
	if text_surface(element) != TextSurface::Native {
		return Err(DesktopError::ax_failed(
			"AX text writes cannot be verified in web content or an incomplete AX ancestry; use a \
			 pixel click followed by win.type instead",
		));
	}
	Ok(())
}

fn attribute_settable(element: &AXUIElement, name: &str) -> bool {
	attribute_settable_answer(element, name) == Some(true)
}

/// `AXUIElementIsAttributeSettable`'s answer; `None` when the query failed.
fn attribute_settable_answer(element: &AXUIElement, name: &str) -> Option<bool> {
	let attribute = CFString::from_str(name);
	let mut settable = 0;
	// SAFETY: The Boolean out parameter is writable and all CF objects outlive
	// the synchronous AX query.
	(unsafe { element.is_attribute_settable(&attribute, NonNull::from(&mut settable)) }
		== AXError::Success)
		.then_some(settable != 0)
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

fn verify_text_value(element: &AXUIElement, sent: &str, expected: &str) -> CoreResult<()> {
	text_readback(sent, expected, copy_string(element, "AXValue").as_deref(), is_secure(element))
}

fn is_secure(element: &AXUIElement) -> bool {
	secure_subrole(copy_attribute_result(element, "AXSubrole").map(|value| {
		match value {
			None => Subrole::Absent,
			Some(value) => value
				.downcast::<CFString>()
				.map_or(Subrole::Malformed, |value| Subrole::Named(value.to_string())),
		}
	}))
}

/// What an element answered for `AXSubrole`.
enum Subrole {
	Absent,
	Named(String),
	/// A value that is not a string.
	Malformed,
}

/// A subrole that could not be read, or was not a string, counts as secure, so
/// neither a timeout nor a malformed answer lets a password into an error; a
/// field without one is not secure.
fn secure_subrole(read: Result<Subrole, AXError>) -> bool {
	match read {
		Ok(Subrole::Absent) | Err(AXError::NoValue | AXError::AttributeUnsupported) => false,
		Ok(Subrole::Named(subrole)) => subrole == "AXSecureTextField",
		Ok(Subrole::Malformed) | Err(_) => true,
	}
}

/// Exact equality is the verdict: a field that shows a rewritten value has
/// not been shown to hold what was sent (Contacts regroups a phone number in
/// the field and stores none of it). The error names what the field reads so
/// the next step needs no extra read, except in a secure field, whose text
/// never enters an error.
fn text_readback(sent: &str, expected: &str, actual: Option<&str>, secure: bool) -> CoreResult<()> {
	const SHOWN: usize = 200;
	if actual == Some(expected) {
		return Ok(());
	}
	if secure {
		return Err(DesktopError::ax_failed(
			"the secure text field's value could not be confirmed after the write; inspect the \
			 target before writing again",
		));
	}
	let quote = |text: &str| format!("{:?}", truncate_chars(text.to_owned(), SHOWN));
	let Some(actual) = actual else {
		return Err(DesktopError::ax_failed(format!(
			"wrote {}, but the field's value could not be read back; inspect the target before \
			 writing again",
			quote(sent),
		)));
	};
	let whole = if sent == expected {
		String::new()
	} else {
		format!(" instead of {}", quote(expected))
	};
	Err(DesktopError::ax_failed(format!(
		"wrote {}; the field now reads {}{whole}. The app may have reformatted it or not taken it: \
		 inspect the target before writing again",
		quote(sent),
		quote(actual),
	)))
}

/// The system time zone, re-read each call: CF caches it per process, and the
/// target app follows changes to it.
fn system_zone() -> Option<CFRetained<CFTimeZone>> {
	CFTimeZone::reset_system();
	CFTimeZone::system()
}

/// Date and time controls publish `AXValue` as a `CFDate` and refuse the same
/// date written as a `CFString`, so an ISO-8601 value is written as a `CFDate`
/// in the system time zone the control displays, then read back as one.
fn set_date_value(element: &AXUIElement, text: &str, current: f64) -> CoreResult<()> {
	let zone = system_zone()
		.ok_or_else(|| DesktopError::ax_failed("the system time zone is unavailable"))?;
	let offset_at = |at: f64| zone.seconds_from_gmt(at) as i64;
	let Some(request) = date::parse(text) else {
		return Err(DesktopError::ax_failed(format!(
			"AXValue is a date and {text:?} is not ISO-8601: write {}; it reads {} now; nothing was \
			 written",
			date::ACCEPTED_FORMS,
			date::format_local(current, offset_at),
		)));
	};
	let target = request
		.absolute_time(current, offset_at)
		.map_err(|reason| DesktopError::ax_failed(format!("{reason}; nothing was written")))?;
	let value = CFDate::new(None, target)
		.ok_or_else(|| DesktopError::ax_failed("creating the CFDate to write failed"))?;
	let attribute = CFString::from_str("AXValue");
	skylight::with_background_guard(element_pid(element)?, || {
		// The probes before can block; an app the user used meanwhile is theirs.
		control::intervention::check_press()?;
		// SAFETY: The element, attribute and date remain retained for the setter.
		let error = unsafe { element.set_attribute_value(&attribute, &value) };
		ax_result(error, "setting AXValue to a date failed")?;
		match copy_date(element, "AXValue") {
			Some(actual) if (actual - target).abs() < 1e-3 => Ok(()),
			actual => Err(DesktopError::ax_failed(format!(
				"AX accepted the date write but the control reads {} instead of {}",
				actual.map_or_else(|| "no date".to_owned(), |at| date::format_local(at, offset_at)),
				date::format_local(target, offset_at),
			))),
		}
	})
}

/// Sets `AXFocused` on `element`; the caller holds the background guard.
pub(super) fn set_focused(element: &AXUIElement) -> CoreResult<()> {
	ax_result(focus_element(element), "setting AXFocused=true failed")
}

/// Whether `pid` reports `element` as its `AXFocusedUIElement`, waiting at
/// most `within` for the application's reply.
pub(super) fn holds_keyboard_focus(
	pid: libc::pid_t,
	element: &AXUIElement,
	within: Duration,
) -> bool {
	let Ok(app) = create_application(pid) else {
		return false;
	};
	// A zero timeout restores the system default, so the bound stays positive.
	let timeout = within.as_secs_f32().clamp(0.001, PROBE_TIMEOUT_SECONDS);
	// SAFETY: The retained application element is valid for the timeout update.
	let _ = unsafe { app.set_messaging_timeout(timeout) };
	copy_element(&app, "AXFocusedUIElement").is_some_and(|focused| *focused == *element)
}

/// Where `pid` has keyboard focus now: its focused window, else the window
/// its focused element maps to, and that element.
pub(super) fn keyboard_focus(pid: libc::pid_t) -> KeyboardFocus {
	let Some(app) = probe_application(pid) else {
		return KeyboardFocus::default();
	};
	let (focus, element) = read_key_focus(&app);
	let window = match focus.window {
		FocusedWindow::Id(id) => Some(id),
		FocusedWindow::Unreported | FocusedWindow::Unmapped | FocusedWindow::Unreadable => {
			focus.element_window
		},
	};
	KeyboardFocus { window: window.map(|id| id.to_string()), element: element.map(AxHandle::Mac) }
}

/// Inserts into a native field only when its focused element belongs to this
/// exact window: a field in a sheet belongs to the sheet, not to the window
/// the sheet is attached to. `false` means no write was attempted; an
/// attempted write never falls through to keystrokes, including timeouts or
/// partial delivery. `behind_user` runs after the probes, right before the
/// write: the user may have brought the application forward while a probe
/// blocked, and the write would then land in the field they just took over.
/// Nor is anything written once the user has pressed a key or clicked in the
/// application since the call was admitted
/// ([`control::intervention::check_press`]).
pub(super) fn insert_native_text(
	pid: libc::pid_t,
	wid: u32,
	text: &str,
	behind_user: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<bool> {
	let Some(app) = probe_application(pid) else {
		return Ok(false);
	};
	let (focus, Some(element)) = read_key_focus(&app) else {
		return Ok(false);
	};
	if !focus.holds_text_for(pid, wid, skylight::window_parent) {
		return Ok(false);
	}
	insert_selected_text(pid, &element, text, behind_user)
}

/// Inserts at `element`'s own selection, whichever element holds keyboard
/// focus; `false` means no write was attempted, and `behind_user` runs right
/// before the write, as for [`insert_native_text`].
pub(super) fn insert_into_element(
	element: &AXUIElement,
	text: &str,
	behind_user: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<bool> {
	insert_selected_text(element_pid(element)?, element, text, behind_user)
}

fn insert_selected_text(
	pid: libc::pid_t,
	element: &AXUIElement,
	text: &str,
	behind_user: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<bool> {
	if !takes_inserted_text(
		|| text_surface(element),
		copy_string(element, "AXRole").as_deref(),
		|| attribute_settable(element, "AXSelectedText"),
	) {
		return Ok(false);
	}
	let Some(before) = copy_string(element, "AXValue") else {
		return Ok(false);
	};
	let Some(range) = copy_range(element, "AXSelectedTextRange") else {
		return Ok(false);
	};
	let Some(expected) = replace_utf16_selection(&before, range.location, range.length, text) else {
		return Ok(false);
	};
	behind_user()?;
	skylight::with_background_guard(pid, || {
		control::intervention::check_press()?;
		set_string_value(element, "AXSelectedText", text)?;
		verify_text_value(element, text, &expected)
	})?;
	Ok(true)
}

/// Replaces a native text field's whole value through `AXSelectedText`, the
/// path `typeText` uses, after focusing the field and selecting all of it.
/// `false` means nothing was written and the caller may write `AXValue`.
fn replace_native_text(
	element: &AXUIElement,
	pid: libc::pid_t,
	may_borrow: bool,
	text: &str,
) -> CoreResult<bool> {
	if !matches!(
		copy_string(element, "AXRole").as_deref(),
		Some("AXTextField" | "AXTextArea" | "AXComboBox")
	) || is_secure(element)
	{
		return Ok(false);
	}
	replace_whole_value(&LiveField { element, pid, may_borrow }, text)
}

/// The AX steps of a whole-value replacement, kept apart so the order of its
/// foreground checks can be tested without a live app.
trait TextField {
	type Element;
	/// Whether the field holds its app's focus, which is app-local.
	fn focused(&self) -> Option<bool>;
	/// The element that holds the app's focus.
	fn focus_owner(&self) -> Option<Self::Element>;
	/// Whether another app is frontmost (`may_borrow_focus`).
	fn in_background(&self) -> bool;
	/// Whether an app that was in the background as the call started has since
	/// come to the front, which means the user is working in it.
	fn brought_forward(&self) -> bool;
	fn focus(&self) -> AXError;
	fn hand_focus_to(&self, owner: &Self::Element) -> AXError;
	/// The whole value's UTF-16 length, when its selection is settable.
	fn selectable_length(&self) -> Option<isize>;
	fn select(&self, length: isize) -> AXError;
	fn insert(&self, text: &str) -> CoreResult<()>;
}

fn replace_whole_value<F: TextField>(field: &F, text: &str) -> CoreResult<bool> {
	// A setter the app did not answer may still apply, like `set_string_value`'s
	// partial delivery: the `AXValue` fallback is skipped rather than written
	// over a focus or selection that may have moved.
	let mut unanswered = None;
	// An unfocused Cocoa field has no field editor, so it publishes no
	// settable selection until it is focused. Focus is borrowed only when the
	// element that holds it is known, so it can be handed back.
	let previous = if field.focused() == Some(true) {
		None
	} else {
		let Some(owner) = field.focus_owner() else {
			return Ok(false);
		};
		// Checked after the probes, which can block, and right before focusing.
		if !field.in_background() {
			return Ok(false);
		}
		// A run cancelled, or an app the user used, while the probes blocked
		// changes nothing.
		control::check()?;
		control::intervention::check_press()?;
		match field.focus() {
			AXError::Success => {},
			AXError::CannotComplete => unanswered = Some("AXFocused"),
			_ => return Ok(false),
		}
		Some(owner)
	};
	// Focusing can swap in the field editor, so the length is read afterward.
	// The user may bring the app forward while those reads or the selection
	// write block: a borrowed caret is theirs again, and a field the app had
	// focused is theirs to type in, so neither is selected or typed over. Nor
	// does a run cancelled meanwhile go on to write, nor one whose app the user
	// pressed a key or clicked in.
	let still_borrowed = || {
		(if previous.is_none() {
			!field.brought_forward()
		} else {
			field.in_background()
		}) && control::check().is_ok()
			&& control::intervention::check_press().is_ok()
	};
	let selected = unanswered.is_none()
		&& field.selectable_length().is_some_and(|length| {
			still_borrowed()
				&& match field.select(length) {
					AXError::Success => still_borrowed(),
					AXError::CannotComplete => {
						unanswered = Some("AXSelectedTextRange");
						false
					},
					_ => false,
				}
		});
	if !selected {
		// Nothing was written: hand focus back before the `AXValue` fallback,
		// unless the user has since moved it off the borrowed field.
		if let Some(previous) = previous
			&& field.focused() == Some(true)
		{
			let error = field.hand_focus_to(&previous);
			if error != AXError::Success {
				return Err(DesktopError::ax_failed(format!(
					"focused the field to replace its text, then could not hand focus back \
					 ({error:?}); nothing was written"
				)));
			}
		}
		control::check()?;
		control::intervention::check_press()?;
		if let Some(attribute) = unanswered {
			return Err(DesktopError::ax_unconfirmed(format!(
				"setting {attribute} to replace the field's text got no reply in time \
				 (CannotComplete) and may still apply, so nothing was written: observe the window \
				 before retrying"
			)));
		}
		return Ok(false);
	}
	field.insert(text)?;
	Ok(true)
}

struct LiveField<'a> {
	element:    &'a AXUIElement,
	pid:        libc::pid_t,
	/// The app was in the background as the call started; see
	/// `MacAx::set_value`.
	may_borrow: bool,
}

impl TextField for LiveField<'_> {
	type Element = CFRetained<AXUIElement>;

	fn focused(&self) -> Option<bool> {
		copy_bool(self.element, "AXFocused")
	}

	fn focus_owner(&self) -> Option<Self::Element> {
		probe_application(self.pid).and_then(|app| copy_element(&app, "AXFocusedUIElement"))
	}

	fn in_background(&self) -> bool {
		self.may_borrow && may_borrow_focus(skylight::front_pid(), self.pid)
	}

	fn brought_forward(&self) -> bool {
		self.may_borrow && !may_borrow_focus(skylight::front_pid(), self.pid)
	}

	fn focus(&self) -> AXError {
		focus_element(self.element)
	}

	fn hand_focus_to(&self, owner: &Self::Element) -> AXError {
		focus_element(owner)
	}

	fn selectable_length(&self) -> Option<isize> {
		if !attribute_settable(self.element, "AXSelectedText")
			|| !attribute_settable(self.element, "AXSelectedTextRange")
		{
			return None;
		}
		Some(copy_string(self.element, "AXValue")?.encode_utf16().count() as isize)
	}

	fn select(&self, length: isize) -> AXError {
		let mut all = CFRange { location: 0, length };
		// SAFETY: `all` is a live CFRange matching the requested AXValue type.
		let Some(range) =
			(unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&mut all).cast()) })
		else {
			return AXError::Failure;
		};
		let attribute = CFString::from_str("AXSelectedTextRange");
		// SAFETY: The element, attribute and range remain retained for the
		// setter.
		unsafe { self.element.set_attribute_value(&attribute, &range) }
	}

	fn insert(&self, text: &str) -> CoreResult<()> {
		set_string_value(self.element, "AXSelectedText", text)?;
		verify_text_value(self.element, text, text)
	}
}

/// Focus moves only inside a background app: in the front app it would move
/// the user's caret, and an unknown front process counts as the target's.
fn may_borrow_focus(front: Option<libc::pid_t>, target: libc::pid_t) -> bool {
	front.is_some_and(|front| front != target)
}

fn focus_element(element: &AXUIElement) -> AXError {
	let attribute = CFString::from_str("AXFocused");
	// SAFETY: The singleton CFBoolean and retained element remain valid for the
	// synchronous setter call.
	unsafe { element.set_attribute_value(&attribute, CFBoolean::new(true)) }
}

/// Whether text goes in by writing `AXSelectedText`: a native text field,
/// text area or combo box whose selection is settable. Web content can echo
/// a write its renderer never accepted, so it takes keystrokes instead.
fn takes_inserted_text(
	surface: impl FnOnce() -> TextSurface,
	role: Option<&str>,
	selection_settable: impl FnOnce() -> bool,
) -> bool {
	matches!(role, Some("AXTextField" | "AXTextArea" | "AXComboBox"))
		&& surface() == TextSurface::Native
		&& selection_settable()
}

/// AX text ranges use UTF-16 offsets, not UTF-8 byte or Unicode scalar indices.
fn replace_utf16_selection(
	before: &str,
	location: isize,
	length: isize,
	text: &str,
) -> Option<String> {
	let range =
		Utf16Range { start: usize::try_from(location).ok()?, length: usize::try_from(length).ok()? };
	let bytes = utf16_byte_range(before, range)?;
	let mut result = String::with_capacity(before.len() - bytes.len() + text.len());
	result.push_str(&before[..bytes.start]);
	result.push_str(text);
	result.push_str(&before[bytes.end..]);
	Some(result)
}

/// In a Mac Catalyst (`UIKit`) app, pressing a row scrolled out of its view
/// reports success and does nothing. Scrolling it into view first lets the
/// press land; for an element already in view the scroll changes nothing.
/// The element's own spelling of [`SCROLL_TO_VISIBLE`] when `native`, its
/// own spelling of the action to perform, is a press that scrolls first.
fn scroll_before_press<'a>(
	native: &str,
	actions: &'a [String],
	uikit: impl FnOnce() -> bool,
) -> Option<&'a str> {
	if !native.eq_ignore_ascii_case("AXPress") {
		return None;
	}
	let scroll = actions
		.iter()
		.find(|action| action.eq_ignore_ascii_case(SCROLL_TO_VISIBLE))?;
	uikit().then_some(scroll.as_str())
}

/// Sends `native`, after `scroll` when given. A failed scroll leaves the
/// action to report its own outcome; a run cancelled during the scroll sends
/// nothing more, and nothing is sent once the user has pressed a key or
/// clicked in the app since the call was admitted
/// ([`control::intervention::check_press`]).
fn press_into_view(
	native: &str,
	scroll: Option<&str>,
	mut send: impl FnMut(&str) -> AXError,
) -> CoreResult<()> {
	control::intervention::check_press()?;
	if let Some(scroll) = scroll {
		let _ = send(scroll);
		control::check()?;
		control::intervention::check_press()?;
	}
	element_action_result(native, send(native))
}

fn perform_action(element: &AXUIElement, action: &str) -> CoreResult<()> {
	ax_result(send_action(element, action), format!("AX action '{action}' failed"))
}

fn send_action(element: &AXUIElement, action: &str) -> AXError {
	let name = CFString::from_str(action);
	// SAFETY: The retained element and action CFString remain valid for the
	// synchronous AX request.
	unsafe { element.perform_action(&name) }
}

/// `CannotComplete` from `AXPerformAction` means messaging failed or the app
/// did not reply in time, e.g. while the action runs a modal dialog. The
/// request was made, so its outcome is unknown rather than failed.
/// `AttributeUnsupported` names no attribute an action reads; Preview answers
/// it after following a PDF link's `AXPressAction` and Finder after carrying
/// out an icon's `AXOpen`, so it is no proof of failure either.
fn element_action_result(action: &str, error: AXError) -> CoreResult<()> {
	if matches!(error, AXError::CannotComplete | AXError::AttributeUnsupported) {
		return Err(DesktopError::ax_unconfirmed(format!(
			"AX action '{action}' was requested, but its outcome could not be confirmed: the app did \
			 not reply in time, messaging failed or the app answered with an unrelated error \
			 ({error:?}), for example because the action opened a modal dialog. It may already have \
			 taken effect: observe the window before retrying"
		)));
	}
	ax_result(error, format!("AX action '{action}' failed"))
}

fn ensure_trusted() -> CoreResult<()> {
	is_trusted().ok_or_else(|| permission::denied("Accessibility"))
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

/// Process `pid`'s application element, for tests that need an element a real
/// process owns.
#[cfg(test)]
pub(in crate::desktop) fn application_handle(pid: libc::pid_t) -> CoreResult<AxHandle> {
	create_application(pid).map(AxHandle::Mac)
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

/// Reads an optional attribute of an element a ref names: a destroyed element
/// is a stale ref, any other failure reads as no value.
fn copy_held_attribute(
	element: &AXUIElement,
	attribute: &str,
) -> CoreResult<Option<CFRetained<CFType>>> {
	match copy_attribute_result(element, attribute) {
		Err(AXError::InvalidUIElement) => Err(element_gone()),
		result => Ok(result.ok().flatten()),
	}
}

/// The attribute's value as a `CFAbsoluteTime`, when it is a `CFDate`.
fn copy_date(element: &AXUIElement, attribute: &str) -> Option<f64> {
	let value = copy_attribute(element, attribute)?
		.downcast::<CFDate>()
		.ok()?;
	Some(value.absolute_time())
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
	required_string(copy_attribute_result(element, attribute), attribute)
}

/// A read of `attribute` that must be a string.
fn required_string(
	value: Result<Option<CFRetained<CFType>>, AXError>,
	attribute: &str,
) -> CoreResult<String> {
	value
		.map_err(|error| ax_error(error, format!("copying {attribute} failed")))?
		.ok_or_else(|| DesktopError::ax_failed(format!("copying {attribute} returned no value")))?
		.downcast::<CFString>()
		.map(|value| value.to_string())
		.map_err(|_| DesktopError::ax_failed(format!("{attribute} was not a string")))
}

fn copy_bool(element: &AXUIElement, attribute: &str) -> Option<bool> {
	copy_attribute(element, attribute)?
		.downcast::<CFBoolean>()
		.ok()
		.map(|value| value.as_bool())
}

fn copy_range(element: &AXUIElement, attribute: &str) -> Option<CFRange> {
	let value = copy_attribute(element, attribute)?
		.downcast::<AXValue>()
		.ok()?;
	let mut range = CFRange { location: 0, length: 0 };
	// SAFETY: The output is a live CFRange and the AXValue accessor validates
	// the requested type before writing it.
	unsafe { value.value(AXValueType::CFRange, NonNull::from(&mut range).cast()) }.then_some(range)
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
	element_array(copy_attribute(element, attribute)?)
}

fn element_array(value: CFRetained<CFType>) -> Option<Vec<CFRetained<AXUIElement>>> {
	let array = value.downcast::<CFArray>().ok()?;
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
	let position = copy_attribute(element, "AXPosition")?;
	let size = copy_attribute(element, "AXSize")?;
	frame(&position, &size)
}

/// The bounds an `AXPosition` and `AXSize` value pair describe.
fn frame(position: &CFType, size: &CFType) -> Option<AxBounds> {
	let position = position.downcast_ref::<AXValue>()?;
	let size = size.downcast_ref::<AXValue>()?;
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

// The test-only handle variants make this fallible under `cfg(test)`; keep one
// call contract.
#[cfg_attr(
	not(test),
	allow(clippy::unnecessary_wraps, reason = "the test-only handle variants are fallible")
)]
pub(super) fn mac_handle(handle: &AxHandle) -> CoreResult<&AXUIElement> {
	match handle {
		AxHandle::Mac(element) => Ok(element),
		#[cfg(test)]
		_ => Err(DesktopError::ax_failed("non-macOS AX handle passed to MacAx")),
	}
}

/// The process owning the element `h` names.
pub(super) fn handle_pid(h: &AxHandle) -> CoreResult<libc::pid_t> {
	element_pid(mac_handle(h)?)
}

fn bounds_matches_window(bounds: AxBounds, window: &DesktopWindow) -> bool {
	(bounds.x - f64::from(window.x)).abs() <= 2.0
		&& (bounds.y - f64::from(window.y)).abs() <= 2.0
		&& (bounds.width - f64::from(window.width)).abs() <= 2.0
		&& (bounds.height - f64::from(window.height)).abs() <= 2.0
}

/// The element's own name for `action`, matched regardless of case: `ax()`
/// lists actions in lowercase.
fn supported_action<'a>(available: &'a [String], action: &str) -> Option<&'a String> {
	let requested = native_action_name(action);
	available
		.iter()
		.find(|name| name.eq_ignore_ascii_case(&requested))
}

/// Renders an AX attribute value as stable, agent-readable text for
/// [`AxProps::value`] and `attributes()`.
///
/// Numbers print as numbers (checkbox/radio state, slider position), a date
/// as the local ISO-8601 time the control shows and `setValue` takes back, and
/// an element reference (a radio group's selected button) prints as that
/// element's title or description, so snapshots never carry CF debug text
/// whose pointer addresses change between otherwise identical reads.
fn stringify_value(value: &CFType) -> String {
	if let Some(string) = value.downcast_ref::<CFString>() {
		return string.to_string();
	}
	if let Some(boolean) = value.downcast_ref::<CFBoolean>() {
		return boolean.as_bool().to_string();
	}
	if let Some(number) = value.downcast_ref::<CFNumber>() {
		return stringify_number(number);
	}
	if let Some(date) = value.downcast_ref::<CFDate>() {
		// Without the zone a read still names the right instant, in UTC.
		let zone = system_zone();
		return date::format_local(date.absolute_time(), |at| {
			zone
				.as_ref()
				.map_or(0, |zone| zone.seconds_from_gmt(at) as i64)
		});
	}
	if let Some(element) = value.downcast_ref::<AXUIElement>() {
		return nonempty(copy_string(element, "AXTitle"))
			.or_else(|| nonempty(copy_string(element, "AXDescription")))
			.unwrap_or_default();
	}
	// A URL's description carries its object's address, so two reads of one
	// link would never compare equal.
	if let Some(url) = value.downcast_ref::<CFURL>() {
		return url.string().to_string();
	}
	format!("{value:?}")
}

/// Formats a `CFNumber` at its stored precision: `Float32` values read back
/// as `f32` so `0.185` does not widen to `0.18500000238418579`.
fn stringify_number(number: &CFNumber) -> String {
	let text = if !number.is_float_type() {
		number.as_i64().map(|value| value.to_string())
	} else if number.byte_size() <= 4 {
		number.as_f32().map(|value| value.to_string())
	} else {
		number.as_f64().map(|value| value.to_string())
	};
	text.unwrap_or_default()
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
	(error == AXError::Success).ok_or_else(|| ax_error(error, context))
}

/// `InvalidUIElement` means the element itself is gone (its view was removed
/// or its window closed), so the ref that named it is stale.
fn ax_error(error: AXError, context: impl Into<String>) -> DesktopError {
	if error == AXError::InvalidUIElement {
		element_gone()
	} else {
		DesktopError::ax_failed(format!("{} ({error:?})", context.into()))
	}
}

fn element_gone() -> DesktopError {
	DesktopError::stale_ref("the element no longer exists; re-run ax()/find()")
}

#[cfg(test)]
mod tests {
	use std::{
		cell::{Cell, RefCell},
		ptr::NonNull,
	};

	use objc2_application_services::{AXError, AXValue, AXValueType};
	use objc2_core_foundation::{CFArray, CFNumber, CFString, CFType, CFURL, Type, kCFNull};

	use super::{
		AttachedCandidate, AxWindowRecord, CHILDREN, DESCRIPTION, ENABLED, FocusedWindow,
		KeyDestination, KeyFocus, NodeRead, NodeValues, ROLE, TITLE, TextField, TextSurface, VALUE,
		WindowContent, ax_result, content_owner, create_system_wide, element_action_result,
		focused_window, may_borrow_focus, menu_window, perform_choosing, replace_utf16_selection,
		replace_whole_value, required_string, secure_subrole, select_attached, stringify_value,
		takes_inserted_text, target_window, text_readback, window_records_of,
	};
	use crate::desktop::error::{CoreResult, ErrorCode};

	#[test]
	fn batched_values_read_like_lone_reads() {
		let mut no_value = AXError::NoValue;
		// SAFETY: An AXError-typed AXValue copies the one AXError it points at.
		let error =
			unsafe { AXValue::new(AXValueType::AXError, NonNull::from(&mut no_value).cast()) }
				.unwrap();
		let title = CFString::from_static_str("Save");
		// SAFETY: kCFNull is a process-lifetime constant.
		let null = unsafe { kCFNull }.unwrap();
		let entries: [&CFType; 3] = [&title, &error, null];
		let values =
			NodeValues::from_batch(Ok(CFArray::from_objects(&entries)), TITLE..ENABLED, |_| {
				unreachable!("an answered batch needs no lone reads")
			});
		let title = values
			.get(TITLE)
			.unwrap()
			.unwrap()
			.downcast::<CFString>()
			.unwrap();
		assert_eq!(title.to_string(), "Save");
		assert_eq!(values.get(VALUE).unwrap_err(), AXError::NoValue);
		assert!(values.get(DESCRIPTION).unwrap().is_none());
		assert_eq!(values.get(CHILDREN).unwrap_err(), AXError::Failure);

		let gone = NodeValues::from_batch(
			Err(AXError::InvalidUIElement),
			NodeRead::Walk.attributes(),
			|_| unreachable!("a destroyed element needs no lone reads"),
		);
		assert_eq!(gone.get(TITLE).unwrap_err(), AXError::InvalidUIElement);
		let role = required_string(gone.get(ROLE), "AXRole").unwrap_err();
		assert_eq!(role.code, ErrorCode::StaleRef);
	}

	#[test]
	fn unanswered_batch_falls_back_to_lone_reads() {
		let role = CFString::from_static_str("AXTextArea");
		let role: &CFType = &role;
		let mut asked = Vec::new();
		let values = NodeValues::from_batch(
			Err(AXError::CannotComplete),
			NodeRead::Walk.attributes(),
			|index| {
				asked.push(index);
				match index {
					ROLE => Ok(Some(role.retain())),
					VALUE => Err(AXError::CannotComplete),
					_ => Ok(None),
				}
			},
		);
		let mut expected: Vec<_> = NodeRead::Walk.attributes().collect();
		expected.retain(|index| !super::IDENTITY_ONLY.contains(index));
		assert_eq!(asked, expected);
		assert_eq!(asked.len(), 8);
		assert_eq!(required_string(values.get(ROLE), "AXRole").unwrap(), "AXTextArea");
		assert_eq!(values.get(VALUE).unwrap_err(), AXError::CannotComplete);
		assert!(values.get(TITLE).unwrap().is_none());
	}

	#[test]
	fn only_an_element_whose_app_answered_every_identifying_attribute_has_an_identity() {
		use super::{HELP, answered, read_identity};

		let error = |mut code: AXError| {
			// SAFETY: An AXError-typed AXValue copies the one AXError it points
			// at.
			unsafe { AXValue::new(AXValueType::AXError, NonNull::from(&mut code).cast()) }.unwrap()
		};
		let role = CFString::from_static_str("AXButton");
		let title = CFString::from_static_str("Go");
		let no_value = error(AXError::NoValue);
		let unsupported = error(AXError::AttributeUnsupported);
		let busy = error(AXError::CannotComplete);
		let failed = error(AXError::Failure);
		// SAFETY: kCFNull is a process-lifetime constant.
		let null = unsafe { kCFNull }.unwrap();
		// One walk read, in `NODE_ATTRIBUTES` order, with `help` as its `AXHelp`.
		let walk = |help: &CFType| {
			let entries: [&CFType; 15] = [
				null,
				&role,
				&title,
				&no_value,
				null,
				null,
				null,
				null,
				&unsupported,
				null,
				null,
				help,
				null,
				null,
				null,
			];
			NodeValues::from_batch(
				Ok(CFArray::from_objects(&entries)),
				NodeRead::Walk.attributes(),
				|_| unreachable!("an answered batch needs no lone reads"),
			)
		};
		let go = Some("Go".to_string());
		let identity = |values: &NodeValues| read_identity(values, "AXButton", [&go, &None, &None]);
		// Missing and unsupported attributes are the same answer.
		let answered_none = identity(&walk(&no_value)).unwrap();
		assert_eq!(identity(&walk(&unsupported)), Some(answered_none));
		assert!(answered(&walk(&no_value).get(CHILDREN)));
		// A read that failed outright is an answer of its own, the same on
		// every read.
		let failing = identity(&walk(&failed)).unwrap();
		assert_ne!(failing, answered_none);
		assert_eq!(identity(&walk(&failed)), Some(failing));
		// One the app was too busy to answer leaves no identity.
		assert!(identity(&walk(&busy)).is_none());

		// A batch that fails as a whole falls back to lone reads without the
		// identity-only attributes, so the element has no identity.
		let role: &CFType = &role;
		let lone = NodeValues::from_batch(
			Err(AXError::CannotComplete),
			NodeRead::Walk.attributes(),
			|index| match index {
				ROLE => Ok(Some(role.retain())),
				HELP => unreachable!("the fallback skips identity-only attributes"),
				CHILDREN => Err(AXError::Failure),
				_ => Err(AXError::NoValue),
			},
		);
		assert!(identity(&lone).is_none());
		assert!(!answered(&lone.get(CHILDREN)));
	}

	#[test]
	fn a_field_without_a_label_is_named_by_its_placeholder() {
		use super::{PLACEHOLDER, WalkBounds, element_props};

		let role = CFString::from_static_str("AXTextField");
		let role: &CFType = &role;
		let due = CFString::from_static_str("Due");
		let due: &CFType = &due;
		let add_date = CFString::from_static_str("Add Date");
		let add_date: &CFType = &add_date;
		let mut busy = AXError::CannotComplete;
		// SAFETY: An AXError-typed AXValue copies the one AXError it points at.
		let busy =
			unsafe { AXValue::new(AXValueType::AXError, NonNull::from(&mut busy).cast()) }.unwrap();
		// SAFETY: kCFNull is a process-lifetime constant.
		let null: &CFType = unsafe { kCFNull }.unwrap();
		// One walk read of a Reminders date field, with `title` and
		// `description` as its own labels.
		let field = |title: &CFType, description: &CFType, placeholder: &CFType| {
			let mut entries = [null; 15];
			entries[ROLE] = role;
			entries[TITLE] = title;
			entries[DESCRIPTION] = description;
			entries[PLACEHOLDER] = placeholder;
			let values = NodeValues::from_batch(
				Ok(CFArray::from_objects(&entries)),
				NodeRead::Walk.attributes(),
				|_| unreachable!("an answered batch needs no lone reads"),
			);
			element_props(&create_system_wide(), &values, 0, WalkBounds::Skip).unwrap()
		};
		let unlabeled = field(null, null, add_date);
		assert_eq!(unlabeled.description.as_deref(), Some("Add Date"));
		assert!(!unlabeled.partial);
		// A label of its own wins.
		assert_eq!(field(null, due, add_date).description.as_deref(), Some("Due"));
		let titled = field(due, null, add_date);
		assert_eq!(titled.title.as_deref(), Some("Due"));
		assert_eq!(titled.description, None);
		// A placeholder the app was too busy to answer leaves the field
		// unnamed and without an identity, so no ref is matched by its name.
		let unanswered = field(null, null, &busy);
		assert_eq!(unanswered.description, None);
		assert!(unanswered.partial);
	}

	#[test]
	fn destroyed_element_is_a_stale_ref() {
		let code = |error| {
			ax_result(error, "AX action 'AXPress' failed")
				.unwrap_err()
				.code
		};
		assert_eq!(code(AXError::InvalidUIElement), ErrorCode::StaleRef);
		assert_eq!(code(AXError::CannotComplete), ErrorCode::AxFailed);
		assert_eq!(code(AXError::ActionUnsupported), ErrorCode::AxFailed);
	}

	#[test]
	fn cannot_complete_reports_the_action_as_unconfirmed_not_failed() {
		let unconfirmed = element_action_result("AXPress", AXError::CannotComplete).unwrap_err();
		assert_eq!(unconfirmed.code, ErrorCode::AxUnconfirmed);
		assert!(unconfirmed.message.contains("could not be confirmed"), "{}", unconfirmed.message);
		assert!(unconfirmed.message.contains("before retrying"), "{}", unconfirmed.message);
		let code = |error| element_action_result("AXPress", error).unwrap_err().code;
		assert_eq!(code(AXError::InvalidUIElement), ErrorCode::StaleRef);
		assert_eq!(code(AXError::ActionUnsupported), ErrorCode::AxFailed);
		assert!(element_action_result("AXPress", AXError::Success).is_ok());
	}

	#[test]
	fn an_unrelated_attribute_error_from_an_action_is_unconfirmed() {
		let error =
			element_action_result("AXPressAction", AXError::AttributeUnsupported).unwrap_err();
		assert_eq!(error.code, ErrorCode::AxUnconfirmed);
		assert!(error.message.contains("observe the window"), "{}", error.message);
	}

	#[test]
	fn listed_actions_perform_whatever_their_case() {
		let available = ["AXOpen", "AXShowMenu", "AXPressAction", "AXRaise"].map(String::from);
		let native = |action| super::supported_action(&available, action).map(String::as_str);
		assert_eq!(native("open"), Some("AXOpen"));
		assert_eq!(native("pressaction"), Some("AXPressAction"));
		assert_eq!(native("showmenu"), Some("AXShowMenu"));
		assert_eq!(native("AXOpen"), Some("AXOpen"));
		assert_eq!(native("press"), None);
		assert_eq!(native("axopen"), Some("AXOpen"));
		assert_eq!(native("axOpen"), Some("AXOpen"));
		assert_eq!(native(" open "), Some("AXOpen"));
		assert_eq!(native("AxShowMenu"), Some("AXShowMenu"));
		// A raise by any spelling is the raise the Escape stop arms for.
		for raise in ["axraise", "AxRaise", " Raise "] {
			assert_eq!(native(raise), Some("AXRaise"));
			assert!(super::is_raise_action(raise), "{raise}");
		}
		// Unicode White_Space trims (U+0085 does, U+FEFF does not), and only
		// ASCII letters fold; the tool's refusals name actions by the same rule.
		assert_eq!(native("\u{85}open"), Some("AXOpen"));
		assert_eq!(native("open\u{85}"), Some("AXOpen"));
		assert_eq!(native("\u{feff}open"), None);
		assert_eq!(native("open\u{feff}"), None);
		let custom = ["AXÖffnen".to_owned()];
		assert_eq!(
			super::supported_action(&custom, "axÖffnen").map(String::as_str),
			Some("AXÖffnen")
		);
		assert_eq!(super::supported_action(&custom, "axöffnen"), None);
		// An element advertising another case is answered with its own spelling.
		let lower = ["axshowmenu", "axpress", "axopen"].map(String::from);
		let native = |action| super::supported_action(&lower, action).map(String::as_str);
		assert_eq!(native("showmenu"), Some("axshowmenu"));
		assert_eq!(native("press"), Some("axpress"));
		assert_eq!(native("AXOpen"), Some("axopen"));
		// `ax()` lists only `open` for a button that also presses; the press
		// runs.
		let both = ["AXPress", "AXOpen"].map(String::from);
		assert_eq!(super::supported_action(&both, "press").map(String::as_str), Some("AXPress"));
	}

	#[test]
	fn rows_cells_buttons_and_icons_report_their_selection() {
		use super::{SELECTED, selected};

		// SAFETY: kCFNull is a process-lifetime constant.
		let null: &CFType = unsafe { kCFNull }.unwrap();
		let yes: &CFType = objc2_core_foundation::CFBoolean::new(true);
		let walk = |slot: &CFType| {
			let mut entries = [null; 15];
			entries[SELECTED] = slot;
			NodeValues::from_batch(
				Ok(CFArray::from_objects(&entries)),
				NodeRead::Walk.attributes(),
				|_| unreachable!("an answered batch needs no lone reads"),
			)
		};
		let marked = walk(yes);
		for role in ["AXRow", "AXCell", "AXButton", "AXImage"] {
			assert!(selected(&marked, role), "{role}");
		}
		assert!(!selected(&marked, "AXStaticText"));
		assert!(!selected(&walk(null), "AXRow"));
	}

	#[test]
	fn only_an_unlabeled_window_button_takes_its_subrole_name() {
		use super::window_control_name;

		let name = |role, title: Option<&str>, subrole: &str| {
			window_control_name(role, [&title.map(str::to_owned), &None], Some(subrole.to_owned()))
		};
		assert_eq!(name("AXButton", None, "AXCloseButton"), Some("close"));
		assert_eq!(name("AXButton", None, "AXMinimizeButton"), Some("minimize"));
		assert_eq!(name("AXButton", None, "AXZoomButton"), Some("zoom"));
		assert_eq!(name("AXButton", None, "AXFullScreenButton"), Some("full screen"));
		assert_eq!(name("AXButton", Some(" "), "AXCloseButton"), Some("close"));
		assert_eq!(name("AXButton", Some("Close tab"), "AXCloseButton"), None);
		assert_eq!(name("AXButton", None, "AXSortButton"), None);
		assert_eq!(name("AXCheckBox", None, "AXCloseButton"), None);
	}

	#[test]
	fn a_menu_action_in_a_popover_or_sheet_is_aimed_at_that_window() {
		// Calendar's Repeat popup reports window 25567 as its AXWindow and maps
		// to its event popover 25579; a field in Automator's Save sheet 25670
		// maps to the sheet, attached to window 25656.
		let parents = |id| match id {
			25579 => Some(25567),
			25670 => Some(25656),
			_ => None,
		};
		assert_eq!(menu_window(25567, Some(25579), parents), 25579);
		assert_eq!(menu_window(25656, Some(25670), parents), 25670);
		// The window itself, an unmapped element, and a window that is not
		// attached to the element's AXWindow, such as the one
		// openAndSavePanelService draws a panel's controls in, keep AXWindow.
		assert_eq!(menu_window(25567, Some(25567), parents), 25567);
		assert_eq!(menu_window(25567, None, parents), 25567);
		assert_eq!(menu_window(25656, Some(25579), parents), 25656);
		assert_eq!(menu_window(25656, Some(31000), parents), 25656);
	}

	#[test]
	fn numeric_values_render_as_numbers_at_stored_precision() {
		assert_eq!(stringify_value(&CFNumber::new_i32(1)), "1");
		assert_eq!(stringify_value(&CFNumber::new_i64(-3)), "-3");
		assert_eq!(stringify_value(&CFNumber::new_f64(0.185)), "0.185");
		assert_eq!(stringify_value(&CFNumber::new_f32(0.185)), "0.185");
	}

	#[test]
	fn a_url_value_reads_as_its_text_on_every_read() {
		let url =
			|| CFURL::from_string(None, &CFString::from_str("https://example.com/a"), None).unwrap();
		let (first, second) = (url(), url());
		assert_eq!(stringify_value(&first), "https://example.com/a");
		assert_eq!(stringify_value(&first), stringify_value(&second));
	}

	#[test]
	fn dates_render_as_the_local_time_set_value_takes_back() {
		let at = 813_499_200.0;
		let text = stringify_value(&objc2_core_foundation::CFDate::new(None, at).unwrap());
		assert_eq!(&text[10..11], "T", "{text}");
		assert_eq!(super::date::parse(&text), Some(super::date::DateRequest::Instant(at)), "{text}");
	}

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

	#[test]
	fn an_element_without_a_press_action_is_pointed_at_click() {
		// The system-wide element lists no actions, as a Chrome page's button
		// lists no AXPress.
		let element = create_system_wide();
		let press = perform_choosing(&element, "press", None).unwrap_err();
		assert_eq!(press.code, ErrorCode::AxFailed);
		assert!(press.message.contains("'AXPress' is not supported"), "{}", press.message);
		assert!(press.message.contains("click()"), "{}", press.message);
		let other = perform_choosing(&element, "AXIncrement", None).unwrap_err();
		assert!(other.message.contains("'AXIncrement' is not supported"), "{}", other.message);
		assert!(!other.message.contains("click()"), "{}", other.message);
	}

	#[test]
	fn rewritten_readback_fails_and_names_what_the_field_reads() {
		let error =
			text_readback("555-789-0123", "555-789-0123", Some("(555) 789-0123"), false).unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed);
		assert!(error.message.contains(r#""555-789-0123""#), "{}", error.message);
		assert!(error.message.contains(r#""(555) 789-0123""#), "{}", error.message);
		assert!(text_readback("555-789-0123", "555-789-0123", Some("555-789-0123"), false).is_ok());
	}

	#[test]
	fn inserted_readback_names_the_whole_value_it_expected() {
		let error = text_readback("b", "abc", Some("ac"), false).unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed);
		for quoted in [r#""b""#, r#""ac""#, r#""abc""#] {
			assert!(error.message.contains(quoted), "{quoted}: {}", error.message);
		}
		let unread = text_readback("b", "abc", None, false).unwrap_err();
		assert_eq!(unread.code, ErrorCode::AxFailed);
		assert!(unread.message.contains(r#""b""#), "{}", unread.message);
	}

	#[test]
	fn long_readbacks_are_cut() {
		let long = "x".repeat(500);
		let error = text_readback("y", "y", Some(&long), false).unwrap_err();
		assert!(error.message.len() < 400, "{}", error.message.len());
		assert!(error.message.contains('…'), "{}", error.message);
	}

	#[test]
	fn secure_readbacks_never_quote_the_text() {
		for actual in [None, Some("••••"), Some("")] {
			let error = text_readback("hunter2", "sk-hunter2", actual, true).unwrap_err();
			assert_eq!(error.code, ErrorCode::AxFailed);
			assert!(!error.message.contains("hunter2"), "{}", error.message);
			assert!(error.message.contains("secure"), "{}", error.message);
		}
		assert!(text_readback("hunter2", "hunter2", Some("hunter2"), true).is_ok());
	}

	#[test]
	fn an_unreadable_or_malformed_subrole_counts_as_secure() {
		use super::Subrole;

		assert!(secure_subrole(Ok(Subrole::Named("AXSecureTextField".to_owned()))));
		assert!(!secure_subrole(Ok(Subrole::Named("AXSearchField".to_owned()))));
		assert!(secure_subrole(Ok(Subrole::Malformed)));
		assert!(!secure_subrole(Ok(Subrole::Absent)));
		assert!(!secure_subrole(Err(AXError::NoValue)));
		assert!(!secure_subrole(Err(AXError::AttributeUnsupported)));
		assert!(secure_subrole(Err(AXError::CannotComplete)));
	}

	#[test]
	fn focus_is_borrowed_only_from_a_known_background_app() {
		assert!(may_borrow_focus(Some(10), 20));
		assert!(!may_borrow_focus(Some(20), 20));
		assert!(!may_borrow_focus(None, 20));
	}

	/// A background field whose user, while the selection probes block, brings
	/// its app forward and, with `takes_focus`, clicks another control in it.
	struct ScriptedField {
		focused:            Cell<bool>,
		switches:           bool,
		switches_on_select: bool,
		takes_focus:        bool,
		switched:           Cell<bool>,
		/// What the focus and selection setters answer after applying.
		focus_reply:        AXError,
		select_reply:       AXError,
		calls:              RefCell<Vec<&'static str>>,
		/// Cancelled while the selection write blocks, as a run stopped then
		/// would be.
		cancel_on_select:   Option<crate::desktop::control::CancellationSource>,
		/// The user types into the field's app (process 7) while the selection
		/// write blocks.
		types_on_select:    Option<crate::desktop::control::intervention::Listener>,
	}

	impl ScriptedField {
		fn new(switches: bool, takes_focus: bool) -> Self {
			Self {
				focused: Cell::new(false),
				switches,
				switches_on_select: false,
				takes_focus,
				switched: Cell::new(false),
				focus_reply: AXError::Success,
				select_reply: AXError::Success,
				calls: RefCell::default(),
				cancel_on_select: None,
				types_on_select: None,
			}
		}

		fn calls(&self) -> Vec<&'static str> {
			self.calls.borrow().clone()
		}
	}

	impl TextField for ScriptedField {
		type Element = ();

		fn focused(&self) -> Option<bool> {
			Some(self.focused.get())
		}

		fn focus_owner(&self) -> Option<()> {
			Some(())
		}

		fn in_background(&self) -> bool {
			!self.switched.get()
		}

		fn brought_forward(&self) -> bool {
			self.switched.get()
		}

		fn focus(&self) -> AXError {
			self.calls.borrow_mut().push("focus");
			self.focused.set(true);
			self.focus_reply
		}

		fn hand_focus_to(&self, (): &()) -> AXError {
			self.calls.borrow_mut().push("hand back");
			self.focused.set(false);
			AXError::Success
		}

		fn selectable_length(&self) -> Option<isize> {
			if self.switches {
				self.switched.set(true);
				if self.takes_focus {
					self.focused.set(false);
				}
			}
			Some(3)
		}

		fn select(&self, _: isize) -> AXError {
			self.calls.borrow_mut().push("select");
			if self.switches_on_select {
				self.switched.set(true);
			}
			if let Some(source) = &self.cancel_on_select {
				source.cancel();
			}
			if let Some(listener) = &self.types_on_select {
				listener.record_for_test(7, std::time::Instant::now());
			}
			self.select_reply
		}

		fn insert(&self, _: &str) -> CoreResult<()> {
			self.calls.borrow_mut().push("insert");
			Ok(())
		}
	}

	#[test]
	fn a_background_field_is_focused_selected_and_replaced() {
		let field = ScriptedField::new(false, false);
		assert!(replace_whole_value(&field, "abc").unwrap());
		assert_eq!(field.calls(), ["focus", "select", "insert"]);
	}

	#[test]
	fn a_focused_field_whose_app_comes_forward_during_the_probes_is_not_typed_over() {
		let field = ScriptedField { focused: Cell::new(true), ..ScriptedField::new(true, false) };
		assert!(!replace_whole_value(&field, "abc").unwrap());
		assert!(field.calls().is_empty(), "{:?}", field.calls());
	}

	#[test]
	fn bringing_the_app_forward_during_the_probes_leaves_its_selection_alone() {
		let field = ScriptedField::new(true, false);
		assert!(!replace_whole_value(&field, "abc").unwrap());
		assert_eq!(field.calls(), ["focus", "hand back"]);
	}

	#[test]
	fn focus_the_user_moved_during_the_probes_is_not_taken_back() {
		let field = ScriptedField::new(true, true);
		assert!(!replace_whole_value(&field, "abc").unwrap());
		assert_eq!(field.calls(), ["focus"]);
	}

	#[test]
	fn bringing_the_app_forward_during_the_selection_write_is_not_typed_over() {
		let field = ScriptedField { switches_on_select: true, ..ScriptedField::new(false, false) };
		assert!(!replace_whole_value(&field, "abc").unwrap());
		assert_eq!(field.calls(), ["focus", "select", "hand back"]);
	}

	#[test]
	fn an_unanswered_focus_that_applied_is_handed_back_and_nothing_is_written() {
		let field =
			ScriptedField { focus_reply: AXError::CannotComplete, ..ScriptedField::new(false, false) };
		let error = replace_whole_value(&field, "abc").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxUnconfirmed);
		assert_eq!(field.calls(), ["focus", "hand back"]);
		assert!(!field.focused.get());
	}

	#[test]
	fn an_unanswered_selection_hands_focus_back_and_skips_the_value_write() {
		let field = ScriptedField {
			select_reply: AXError::CannotComplete,
			..ScriptedField::new(false, false)
		};
		let error = replace_whole_value(&field, "abc").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxUnconfirmed);
		assert_eq!(field.calls(), ["focus", "select", "hand back"]);
	}

	#[test]
	fn a_run_cancelled_during_the_selection_write_hands_focus_back_and_writes_nothing() {
		use crate::desktop::control::{self, CancellationSource};

		let source = CancellationSource::default();
		let field = ScriptedField {
			cancel_on_select: Some(source.clone()),
			..ScriptedField::new(false, false)
		};
		let result =
			control::with_token_for_test(&source.token(), || replace_whole_value(&field, "abc"));
		assert_eq!(result.map_err(|error| error.code), Err(ErrorCode::Cancelled));
		assert_eq!(field.calls(), ["focus", "select", "hand back"]);
	}

	#[test]
	fn a_refused_selection_still_falls_back_to_the_value_write() {
		let field = ScriptedField {
			select_reply: AXError::AttributeUnsupported,
			..ScriptedField::new(false, false)
		};
		assert!(!replace_whole_value(&field, "abc").unwrap());
		assert_eq!(field.calls(), ["focus", "select", "hand back"]);
	}

	#[test]
	fn a_user_typing_during_the_selection_write_gets_the_field_handed_back_and_nothing_written() {
		use crate::desktop::control::{CancellationSource, intervention::Listener};

		let field = ScriptedField {
			types_on_select: Some(Listener::simulated()),
			..ScriptedField::new(false, false)
		};
		let listener = field.types_on_select.as_ref().unwrap();
		listener.touch(7, Some(1), || "Contacts".to_string());
		let _watch = listener
			.admit(7, &CancellationSource::default().token())
			.unwrap();
		let result = replace_whole_value(&field, "abc");
		assert_eq!(result.map_err(|error| error.code), Err(ErrorCode::UserIntervened));
		assert_eq!(field.calls(), ["focus", "select", "hand back"]);
	}

	#[test]
	fn only_a_settable_native_text_field_takes_inserted_text() {
		let settable = || true;
		for role in ["AXTextField", "AXTextArea", "AXComboBox"] {
			assert!(takes_inserted_text(|| TextSurface::Native, Some(role), settable), "{role}");
		}
		// A web field can echo a write its renderer never accepted.
		assert!(!takes_inserted_text(|| TextSurface::Web, Some("AXTextField"), settable));
		assert!(!takes_inserted_text(|| TextSurface::Unknown, Some("AXTextArea"), settable));
		assert!(!takes_inserted_text(|| TextSurface::Native, Some("AXTextField"), || false));
		assert!(!takes_inserted_text(|| TextSurface::Native, Some("AXButton"), settable));
		assert!(!takes_inserted_text(|| TextSurface::Native, None, settable));
	}

	#[test]
	fn sheet_or_popover_window_id_beats_a_menu_at_the_same_frame() {
		let candidates =
			[AttachedCandidate::Menu { frame_matches: true }, AttachedCandidate::OwnWindow(Some(51))];
		assert_eq!(select_attached(&candidates, 51).unwrap(), Some(1));
	}

	#[test]
	fn open_menu_resolves_by_its_unique_matching_frame() {
		let candidates = [
			AttachedCandidate::OwnWindow(Some(69)),
			AttachedCandidate::Menu { frame_matches: false },
			AttachedCandidate::Menu { frame_matches: true },
		];
		assert_eq!(select_attached(&candidates, 57).unwrap(), Some(2));
	}

	#[test]
	fn sheet_reporting_another_window_id_never_inherits_the_target() {
		let candidates = [AttachedCandidate::OwnWindow(Some(60)), AttachedCandidate::OwnWindow(None)];
		assert_eq!(select_attached(&candidates, 51).unwrap(), None);
	}

	#[test]
	fn ambiguous_menu_frames_are_refused() {
		let candidates = [AttachedCandidate::Menu { frame_matches: true }, AttachedCandidate::Menu {
			frame_matches: true,
		}];
		assert!(select_attached(&candidates, 57).is_err());
	}

	#[test]
	fn only_a_uikit_press_scrolls_its_element_into_view_first() {
		use super::scroll_before_press;

		let actions = |names: &[&str]| {
			names
				.iter()
				.map(|name| (*name).to_owned())
				.collect::<Vec<_>>()
		};
		let row = actions(&["AXPress", "AXScrollToVisible", "AXShowMenu"]);
		assert_eq!(scroll_before_press("AXPress", &row, || true), Some("AXScrollToVisible"));
		// An element advertising its actions in another case scrolls by its own
		// spelling.
		let lower = actions(&["axpress", "axscrolltovisible"]);
		assert_eq!(scroll_before_press("axpress", &lower, || true), Some("axscrolltovisible"));
		// An AppKit app, another action, or an element that cannot scroll: press
		// as is.
		assert_eq!(scroll_before_press("AXPress", &row, || false), None);
		assert_eq!(scroll_before_press("AXShowMenu", &row, || true), None);
		assert_eq!(scroll_before_press("AXPress", &actions(&["AXPress"]), || true), None);
		// The app is only classified when the press could scroll.
		assert_eq!(scroll_before_press("AXShowMenu", &row, || unreachable!()), None);
	}

	#[test]
	fn a_press_follows_its_scroll_unless_the_run_was_cancelled() {
		use super::{press_into_view, scroll_before_press, supported_action};
		use crate::desktop::control;

		// `available` as the element advertises it, pressed through
		// `perform("press")`.
		let run = |available: &[&str], scroll_result: AXError, cancel: bool| {
			let available: Vec<String> = available.iter().map(|name| (*name).to_owned()).collect();
			let native = supported_action(&available, "press")
				.expect("a press")
				.clone();
			let scroll = scroll_before_press(&native, &available, || true);
			let source = control::CancellationSource::default();
			let token = source.token();
			let mut sent = Vec::new();
			let result = control::with_token_for_test(&token, || {
				press_into_view(&native, scroll, |action| {
					sent.push(action.to_owned());
					if Some(action) != scroll {
						return AXError::Success;
					}
					if cancel {
						source.cancel();
					}
					scroll_result
				})
			});
			(result.map_err(|error| error.code), sent)
		};
		let sent = |names: &[&str]| {
			names
				.iter()
				.map(|name| (*name).to_owned())
				.collect::<Vec<_>>()
		};
		let canonical = ["AXPress", "AXScrollToVisible"];
		let both = sent(&["AXScrollToVisible", "AXPress"]);
		assert_eq!(run(&canonical, AXError::Success, false), (Ok(()), both.clone()));
		// A failed scroll still presses.
		assert_eq!(run(&canonical, AXError::Failure, false), (Ok(()), both));
		assert_eq!(run(&["AXPress"], AXError::Success, false), (Ok(()), sent(&["AXPress"])));
		// Cancelled while scrolling: the press is never sent.
		assert_eq!(
			run(&canonical, AXError::Success, true),
			(Err(ErrorCode::Cancelled), sent(&["AXScrollToVisible"]))
		);
		// An element advertising both in another case gets its own spellings:
		// the scroll, then one press, and no press once cancelled.
		let lower = ["axpress", "axscrolltovisible"];
		assert_eq!(
			run(&lower, AXError::Success, false),
			(Ok(()), sent(&["axscrolltovisible", "axpress"]))
		);
		assert_eq!(
			run(&lower, AXError::Success, true),
			(Err(ErrorCode::Cancelled), sent(&["axscrolltovisible"]))
		);
	}

	#[test]
	fn no_action_is_sent_once_the_user_used_the_app() {
		use super::{SCROLL_TO_VISIBLE, press_into_view};
		use crate::desktop::control::{CancellationSource, intervention::Listener};

		let run = |used_before: bool| {
			let listener = Listener::simulated();
			listener.touch(7, Some(1), || "Music".to_string());
			let _watch = listener
				.admit(7, &CancellationSource::default().token())
				.unwrap();
			if used_before {
				listener.record_for_test(7, std::time::Instant::now());
			}
			let mut sent = Vec::new();
			let result = press_into_view("AXPress", Some(SCROLL_TO_VISIBLE), |action| {
				sent.push(action.to_owned());
				// The user clicks in the app while the scroll runs.
				listener.record_for_test(7, std::time::Instant::now());
				AXError::Success
			});
			(result.map_err(|error| error.code), sent)
		};
		assert_eq!(run(true), (Err(ErrorCode::UserIntervened), vec![]));
		assert_eq!(run(false), (Err(ErrorCode::UserIntervened), vec![SCROLL_TO_VISIBLE.to_owned()]));
	}

	#[test]
	fn ax_windows_without_a_window_id_stay_as_records() {
		// Finder lists its desktop in AXWindows, and `_AXUIElementGetWindow`
		// cannot map it; the system-wide element is unmappable the same way.
		let records = window_records_of(&[create_system_wide()]);
		assert!(matches!(records.as_slice(), [AxWindowRecord { id: None, .. }]));
	}

	#[test]
	fn a_focused_sheet_is_not_the_window_it_is_attached_to() {
		// Finder's Go to Folder sheet 41740 on window 41732: its path field
		// reports 41732 as its AXWindow but lives in the sheet's own window.
		let focus = KeyFocus {
			window:         FocusedWindow::Id(41740),
			element_window: Some(41740),
			element_mapped: true,
		};
		let attached = |id| (id == 41740).then_some(41732);
		assert_eq!(focus.destination(7, 41732, attached), KeyDestination::Other(Some(41740)));
		assert!(!focus.holds_text_for(7, 41732, attached));
		assert_eq!(focus.destination(7, 41740, attached), KeyDestination::Target(7));
		assert!(focus.holds_text_for(7, 41740, attached));
	}

	#[test]
	fn a_failed_focused_window_read_is_not_an_app_without_one() {
		let none = |_: &u32| -> Option<u32> { None };
		// Only "no value" says the application has no focused window.
		assert_eq!(focused_window(Ok(None), none), FocusedWindow::Unreported);
		assert_eq!(focused_window(Err(AXError::NoValue), none), FocusedWindow::Unreported);
		assert_eq!(focused_window(Ok(Some(5)), |&id| Some(id)), FocusedWindow::Id(5));
		// An application that did not answer in time may have a new modal or
		// sibling focused: keys must not go out as if the target were its only
		// possible key window.
		let unread = focused_window(Err(AXError::CannotComplete), none);
		assert_eq!(unread, FocusedWindow::Unreadable);
		let focus = KeyFocus { window: unread, ..KeyFocus::default() };
		assert_eq!(focus.destination(7, 42, |_| None), KeyDestination::Other(None));
	}

	#[test]
	fn an_editor_overlay_attached_to_the_target_holds_its_focus() {
		// Finder's inline rename field is overlay window 41743, attached to
		// window 41732; while it has focus Finder reports no focused window.
		let focus = KeyFocus {
			window:         FocusedWindow::Unreported,
			element_window: Some(41743),
			element_mapped: true,
		};
		let attached = |id| (id == 41743).then_some(41732);
		assert_eq!(focus.destination(7, 41732, attached), KeyDestination::Target(7));
		assert!(focus.holds_text_for(7, 41732, attached));
		assert!(focus.in_overlay_of(41732, attached));
		// Keys addressed to the overlay window itself reach the field too.
		assert_eq!(focus.destination(7, 41743, attached), KeyDestination::Target(7));
		assert!(focus.in_overlay_of(41743, attached));
		// A top-level window holding the focus is no overlay.
		let top_level = KeyFocus { element_window: Some(41732), ..focus };
		assert!(!top_level.in_overlay_of(41732, attached));
		// The same overlay in another Finder window is not this window's.
		assert_eq!(focus.destination(7, 35240, attached), KeyDestination::Unreported);
		assert!(!focus.holds_text_for(7, 35240, attached));
		assert!(!focus.in_overlay_of(35240, attached));
		// A popover attached to its focused window (Reminders' details popover
		// is window 90 on window 79) is an overlay too; the window itself is not.
		let popover = KeyFocus {
			window:         FocusedWindow::Id(79),
			element_window: Some(90),
			element_mapped: true,
		};
		assert!(popover.in_overlay_of(79, |id| (id == 90).then_some(79)));
		let window = KeyFocus {
			window:         FocusedWindow::Id(79),
			element_window: Some(79),
			element_mapped: true,
		};
		assert!(!window.in_overlay_of(79, |_| None));
	}

	#[test]
	fn a_popover_holding_focus_takes_its_own_keys() {
		// Reminders reports its window 79 as focused while a date field in
		// its details popover, window 90 attached to 79, has focus.
		let focus = KeyFocus {
			window:         FocusedWindow::Id(79),
			element_window: Some(90),
			element_mapped: true,
		};
		let attached = |id| (id == 90).then_some(79);
		assert_eq!(focus.destination(7, 90, attached), KeyDestination::Target(7));
		assert!(focus.in_overlay_of(90, attached));
		assert_eq!(focus.destination(7, 79, attached), KeyDestination::Target(7));
		// The popover does not take keys while focus is elsewhere in window 79,
		// nor does a window that is not attached to the focused one.
		let elsewhere = KeyFocus { element_window: Some(79), ..focus };
		assert_eq!(elsewhere.destination(7, 90, attached), KeyDestination::Other(Some(79)));
		assert!(!elsewhere.in_overlay_of(90, attached));
		assert_eq!(focus.destination(7, 90, |_| None), KeyDestination::Other(Some(79)));
		assert!(!focus.in_overlay_of(90, |_| None));
	}

	#[test]
	fn a_system_panel_is_drawn_by_the_process_its_children_map_to() {
		// TextEdit (pid 7581) shows its Open panel as window 554, whose one
		// child maps to window 556 of openAndSavePanelService (pid 7592). Its
		// Go to Folder sheet 561 has three children that map to no window and
		// one in the service's window 559.
		let owners = |id| match id {
			556 | 559 => Some(7592),
			543 | 554 | 561 => Some(7581),
			_ => None,
		};
		let remote = |window| WindowContent::Remote { pid: 7592, window };
		assert_eq!(content_owner(7581, 554, [Some(556)], owners), remote(556));
		assert_eq!(content_owner(7581, 561, [None, None, None, Some(559)], owners), remote(559));
		// A document window's children map to the window itself.
		assert_eq!(content_owner(7581, 543, [Some(543), Some(543)], owners), WindowContent::Own);
		// A remote view embedded beside the window's own controls is not the
		// window's content.
		assert_eq!(content_owner(7581, 543, [Some(556), Some(543)], owners), WindowContent::Own);
		// A child in another window of the same process, an owner that cannot
		// be read, or no mapped child at all shows no other process.
		assert_eq!(content_owner(7581, 561, [Some(554), Some(559)], owners), WindowContent::Own);
		assert_eq!(content_owner(7581, 554, [Some(999)], owners), WindowContent::Own);
		assert_eq!(content_owner(7581, 554, [None, None], owners), WindowContent::Own);
	}

	#[test]
	fn a_panel_behind_another_window_is_read_from_its_own_window() {
		// TextEdit's document window 543 is focused while its Open panel 554
		// is not: the panel's content still comes from window 554.
		let found = Cell::new(false);
		let find = || {
			found.set(true);
			Some(554)
		};
		assert_eq!(target_window(554, Some(543), |&id| Some(id), find), Some(554));
		assert!(found.get());
		// The focused window answers for itself without a search.
		found.set(false);
		assert_eq!(target_window(554, Some(554), |&id| Some(id), find), Some(554));
		assert!(!found.get());
		// Neither the focused window nor a search shows the window.
		assert_eq!(target_window(554, Some(543), |&id| Some(id), || None::<u32>), None);
	}
}
