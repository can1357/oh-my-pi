pub(crate) mod menus;
pub(super) mod open_menu;
mod popup;

use std::{
	collections::{HashSet, VecDeque},
	ffi::c_void,
	mem,
	ptr::{self, NonNull},
	sync::{LazyLock, Mutex},
	thread,
	time::Duration,
};

use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
	CFArray, CFBoolean, CFDate, CFNumber, CFRange, CFRetained, CFString, CFTimeZone, CFType,
	CGPoint, CGSize, Type,
};

use super::{
	super::{
		ax::{AxBounds, AxHandle, AxProps, normalize_role_macos},
		backend::AxBackend,
		error::{CoreResult, DesktopError},
		types::DesktopWindow,
	},
	capture, date, input, process, skylight,
};

const AX_TIMEOUT_SECONDS: f32 = 2.0;
/// Messaging timeout for the focus and hit-test probes made around input
/// delivery, so a hung application cannot stall the action itself.
const PROBE_TIMEOUT_SECONDS: f32 = 0.5;
/// Bounded `AXParent` ascent when an element does not expose `AXWindow`.
const MAX_ANCESTRY_DEPTH: usize = 40;
/// Bounds the search for a sheet, popover, or open menu that `AXWindows` does
/// not list, matching the snapshot walk's own node and depth budget.
const MAX_ATTACHED_SEARCH_NODES: usize = 5_000;
const MAX_ATTACHED_SEARCH_DEPTH: usize = 24;

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

/// An application's `AXFocusedWindow`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum FocusedWindow {
	/// The application reports none.
	#[default]
	Unreported,
	/// `_AXUIElementGetWindow` cannot map the window it reports.
	Unmapped,
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
			FocusedWindow::Unmapped => KeyDestination::Other(None),
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
	/// itself while it reports the window `wid` is attached to.
	pub(super) fn in_overlay_of(&self, wid: u32, parent_of: impl Fn(u32) -> Option<u32>) -> bool {
		if self.holds_overlay_focus(wid, &parent_of) {
			return true;
		}
		let reported = match self.window {
			FocusedWindow::Unreported => true,
			FocusedWindow::Id(id) => id == wid,
			FocusedWindow::Unmapped => false,
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

/// Reads where `pid` sends keystrokes; every part it cannot read is `None`.
pub(super) fn key_focus(pid: libc::pid_t) -> KeyFocus {
	probe_application(pid).map_or_else(KeyFocus::default, |app| read_key_focus(&app).0)
}

fn read_key_focus(app: &AXUIElement) -> (KeyFocus, Option<CFRetained<AXUIElement>>) {
	let window = copy_element(app, "AXFocusedWindow").map_or(FocusedWindow::Unreported, |window| {
		window_id(&window).map_or(FocusedWindow::Unmapped, FocusedWindow::Id)
	});
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

/// Who draws `pid`'s focused window when that is `wid`; [`WindowContent::Own`]
/// when it is another window or nothing can be read.
pub(super) fn focused_window_content(pid: libc::pid_t, wid: u32) -> WindowContent {
	let Some(window) = probe_application(pid).and_then(|app| copy_element(&app, "AXFocusedWindow"))
	else {
		return WindowContent::Own;
	};
	if window_id(&window) != Some(wid) {
		return WindowContent::Own;
	}
	let children = copy_elements_optional(&window, "AXChildren").unwrap_or_default();
	content_owner(
		pid,
		wid,
		children.iter().map(|child| window_id(child)),
		skylight::window_owner_pid,
	)
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
	enable_web_accessibility(pid, &app);
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

/// Finds the sheet, popover, or open menu of `app` that represents `win`,
/// by a bounded breadth-first walk of the application's accessibility tree.
/// `AppKit` gives each its own `WindowServer` window but lists only standard
/// windows in `AXWindows`.
///
/// A sheet or popover reporting `expected` ends the walk at once: a window id
/// names one window, so no later candidate can compete with it. Only menus,
/// which match by frame, need the whole walk to prove uniqueness.
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
			// Sheets, popovers, and open menus are separate native windows that
			// `AXWindows` omits.
			let truncated = match attached_window(&app, expected_id, win)? {
				AttachedSearch::Found(element) => {
					set_timeout(&element)?;
					return Ok(AxHandle::Mac(element));
				},
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
				"native window {expected_id} was not found in the application's accessibility \
				 windows, sheets, popovers, or open menus{scope}"
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
			return Err(DesktopError::ax_failed(
				"accessibility window title/frame match is ambiguous",
			));
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
			.ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"AX element's window {wid} is not an available window of process {pid}"
				))
			})
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
		perform_choosing(mac_handle(h)?, action, None)
	}

	fn perform_menu(&mut self, h: &AxHandle, action: &str, path: &[String]) -> CoreResult<()> {
		perform_choosing(mac_handle(h)?, action, Some(path))
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let element = mac_handle(h)?;
		// A popup's value is chosen from its menu, not written. This runs before
		// the text-target refusals: nothing is typed or written, and the verdict
		// is the popup's own read-back after a real menu press.
		if copy_string(element, "AXRole").as_deref() == Some("AXPopUpButton") {
			return skylight::with_background_guard(element_pid(element)?, || {
				popup::choose(element, value)
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
		skylight::with_background_guard(element_pid(element)?, || {
			set_string_value(element, "AXValue", value)?;
			verify_text_value(element, value)
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let element = mac_handle(h)?;
		let attribute = CFString::from_str("AXFocused");
		skylight::with_background_guard(element_pid(element)?, || {
			// SAFETY: The singleton CFBoolean and retained element remain valid
			// for the synchronous setter call.
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

/// Performs `action` on `element`; with `path`, chooses that item path in the
/// menu the action opens.
fn perform_choosing(
	element: &AXUIElement,
	action: &str,
	path: Option<&[String]>,
) -> CoreResult<()> {
	let native = action_name(action);
	let actions = copy_strings_from_action_names(element)?;
	if !actions.contains(&native) {
		return Err(DesktopError::ax_failed(format!(
			"AX action '{native}' is not supported by this element; available actions: {}",
			actions.join(", "),
		)));
	}
	let perform = || perform_action(element, &native);
	// AXRaise is an explicit request to change stacking, including the
	// takeover preparation path. Other semantic actions must stay background.
	if native == "AXRaise" {
		if path.is_some() {
			return Err(DesktopError::invalid_target("AXRaise opens no menu to choose an item from"));
		}
		return perform();
	}
	let pid = element_pid(element)?;
	// A menu that a background application opens takes the keyboard from the
	// user's app, so it is closed before the action returns; a frontmost
	// application's menu stays open for the next call unless an item is asked
	// for.
	let entry_front = skylight::front_pid();
	let background = entry_front != Some(pid);
	let watch = path.is_some()
		|| (background && open_menu::may_open(&native, || copy_string(element, "AXRole")));
	skylight::with_background_guard(pid, || {
		let before = if watch {
			let before = capture::menu_windows(pid).ok_or_else(|| {
				DesktopError::ax_failed(format!(
					"cannot list the open menus of process {pid}, so a menu that {native} opens could \
					 not be closed; nothing was performed"
				))
			})?;
			if background {
				activate_for_menu(element, pid, entry_front)?;
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
			|before, path| open_menu::settle(pid, before, path, open_menu::CONTROL_MENU_TIMEOUT),
		)
	})
}

/// Makes the window holding `element` key within its background
/// application, as a background click does, before an action that opens a
/// menu: `AppKit` validates a menu's items when it opens, and an inactive
/// Finder read every Action-menu command but three as disabled. An element
/// whose window cannot be resolved is acted on as it is.
fn activate_for_menu(
	element: &AXUIElement,
	pid: libc::pid_t,
	entry_front: Option<libc::pid_t>,
) -> CoreResult<()> {
	let Some(wid) = element_window(element).as_deref().and_then(window_id) else {
		return Ok(());
	};
	let Ok(window) = capture::window_by_id(&wid.to_string()) else {
		return Ok(());
	};
	let prepared =
		input::make_key_in_background(&input::source()?, pid, wid, &window, entry_front, false)?;
	input::await_key_window(pid, wid)?;
	if prepared {
		input::still_behind_user(pid, wid)?;
	}
	Ok(())
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
			"terminal AX text represents its rendered grid, not terminal input; use typeText instead",
		));
	}
	if text_surface(element) != TextSurface::Native {
		return Err(DesktopError::ax_failed(
			"AX text writes cannot be verified in web content or an incomplete AX ancestry; use a \
			 pixel click followed by typeText instead",
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
		== AXError::Success)
		&& settable != 0
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

/// Date and time controls publish `AXValue` as a `CFDate` and refuse the same
/// date written as a `CFString`, so an ISO-8601 value is written as a `CFDate`
/// in the system time zone the control displays, then read back as one.
fn set_date_value(element: &AXUIElement, text: &str, current: f64) -> CoreResult<()> {
	// CF caches the system zone per process; the target app follows changes to
	// it.
	CFTimeZone::reset_system();
	let zone = CFTimeZone::system()
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

/// Inserts into a native field only when its focused element belongs to this
/// exact window: a field in a sheet belongs to the sheet, not to the window
/// the sheet is attached to. `false` means no write was attempted; an
/// attempted write never falls through to keystrokes, including timeouts or
/// partial delivery.
pub(super) fn insert_native_text(pid: libc::pid_t, wid: u32, text: &str) -> CoreResult<bool> {
	let Some(app) = probe_application(pid) else {
		return Ok(false);
	};
	let (focus, Some(element)) = read_key_focus(&app) else {
		return Ok(false);
	};
	if !focus.holds_text_for(pid, wid, skylight::window_parent)
		|| text_surface(&element) != TextSurface::Native
		|| !matches!(
			copy_string(&element, "AXRole").as_deref(),
			Some("AXTextField" | "AXTextArea" | "AXComboBox")
		)
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
fn replace_utf16_selection(
	before: &str,
	location: isize,
	length: isize,
	text: &str,
) -> Option<String> {
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

fn perform_action(element: &AXUIElement, action: &str) -> CoreResult<()> {
	let name = CFString::from_str(action);
	// SAFETY: The retained element and action CFString remain valid for the
	// synchronous AX request.
	let error = unsafe { element.perform_action(&name) };
	ax_result(error, format!("AX action '{action}' failed"))
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

// The test-only handle variants make this fallible under `cfg(test)`; keep one
// call contract.
#[cfg_attr(
	not(test),
	allow(clippy::unnecessary_wraps, reason = "the test-only handle variants are fallible")
)]
fn mac_handle(handle: &AxHandle) -> CoreResult<&AXUIElement> {
	match handle {
		AxHandle::Mac(element) => Ok(element),
		#[cfg(test)]
		_ => Err(DesktopError::ax_failed("non-macOS AX handle passed to MacAx")),
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

/// Renders an AX attribute value as stable, agent-readable text for
/// [`AxProps::value`] and `attributes()`.
///
/// Numbers print as numbers (checkbox/radio state, slider position) and an
/// element reference (a radio group's selected button) prints as that
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
	if let Some(element) = value.downcast_ref::<AXUIElement>() {
		return nonempty(copy_string(element, "AXTitle"))
			.or_else(|| nonempty(copy_string(element, "AXDescription")))
			.unwrap_or_default();
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
	if error == AXError::Success {
		Ok(())
	} else {
		Err(DesktopError::ax_failed(format!("{} ({error:?})", context.into())))
	}
}

#[cfg(test)]
mod tests {
	use objc2_core_foundation::CFNumber;

	use super::{
		AttachedCandidate, AxWindowRecord, FocusedWindow, KeyDestination, KeyFocus, WindowContent,
		content_owner, create_system_wide, replace_utf16_selection, select_attached, stringify_value,
		window_records_of,
	};

	#[test]
	fn numeric_values_render_as_numbers_at_stored_precision() {
		assert_eq!(stringify_value(&CFNumber::new_i32(1)), "1");
		assert_eq!(stringify_value(&CFNumber::new_i64(-3)), "-3");
		assert_eq!(stringify_value(&CFNumber::new_f64(0.185)), "0.185");
		assert_eq!(stringify_value(&CFNumber::new_f32(0.185)), "0.185");
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
}
