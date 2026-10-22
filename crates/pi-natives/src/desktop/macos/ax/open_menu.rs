//! A menu that a press opened.
//!
//! `AppKit` tracks an open menu modally, and `WindowServer` sends the keyboard
//! to it: a menu opened in a background application takes every key from the
//! user's frontmost application until it closes, with no change of front
//! application to show for it. A press that can open one (a right-click or
//! Control-click, a click or `AXPress` on a menu button or popup button,
//! `AXShowMenu`) therefore never returns with that menu open. Given an item
//! path, the call presses that item and ends the menu with `AXCancel` at once,
//! since a pressed item flashes and its menu fades out for about 340 ms with
//! the keyboard; otherwise it closes the menu with nothing chosen and reports
//! the menu's items, so the next call can name one.
//!
//! The open menu is found where it shows: a hit-test inside its window yields
//! one of its items, whose parent is the menu. A submenu's items are children
//! of their item and can be read and pressed without opening the submenu.

use std::{
	ptr::{self, NonNull},
	time::{Duration, Instant},
};

use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::CFRetained;

use super::{
	super::{capture, input, skylight},
	copy_bool, copy_element, copy_elements_optional, copy_string, create_application, element_pid,
	menus::bounded_children,
	perform_action, probe_application, retained_element, set_timeout,
};
use crate::desktop::{
	control,
	error::{CoreResult, DesktopError, ErrorCode},
	menus::{DesktopMenuItem, match_index, require_enabled},
	types::DesktopWindow,
};

/// How long a context menu may take to appear after the right-click or
/// Control-click that opens it; menus in Chrome and `AppKit` appeared within
/// 40 ms.
pub(crate) const CONTEXT_MENU_TIMEOUT: Duration = Duration::from_millis(250);
/// How long the menu of a menu button or popup button may take to appear
/// after its press: Finder's Action menu, validated for an application made
/// active for it, appeared 450 ms after `AXPress` returned.
pub(crate) const CONTROL_MENU_TIMEOUT: Duration = Duration::from_millis(1000);
/// How long a menu may take to close after Escape; it fades out for about
/// 270 ms.
const MENU_CLOSE_TIMEOUT: Duration = Duration::from_millis(600);
const MENU_POLL: Duration = Duration::from_millis(5);
/// Most items an error lists, submenus included; a submenu that would pass it
/// is listed by its title alone.
const MAX_LISTED_ITEMS: usize = 60;
/// Submenu levels an error lists below the menu's own items.
const MAX_LISTED_DEPTH: usize = 2;
/// Hops from a hit-tested element up to its menu, or up to the control that
/// owns a hit-tested label or image.
const MAX_ASCENT: usize = 4;

/// Whether `action`, the element's own spelling of the action to perform, can
/// open a menu: `AXShowMenu` on any element, `AXPress` on a menu button or
/// popup button, in any case. `role` is read only for a press, so other
/// actions pay nothing for the check.
pub(crate) fn may_open(action: &str, role: impl FnOnce() -> Option<String>) -> bool {
	if action.eq_ignore_ascii_case("AXShowMenu") {
		return true;
	}
	action.eq_ignore_ascii_case("AXPress") && opens_menu(role().as_deref())
}

/// Whether a control of `role` opens a menu when pressed.
fn opens_menu(role: Option<&str>) -> bool {
	matches!(role, Some("AXMenuButton" | "AXPopUpButton"))
}

/// Whether a click at global point `(x, y)` lands on a menu button or popup
/// button of `pid`, or on a label or image inside one.
pub(crate) fn opens_menu_at(pid: libc::pid_t, x: f64, y: f64) -> bool {
	let Some(app) = probe_application(pid) else {
		return false;
	};
	let Some(mut element) = hit_test(&app, x, y) else {
		return false;
	};
	for _ in 0..MAX_ASCENT {
		match copy_string(&element, "AXRole").as_deref() {
			role if opens_menu(role) => return true,
			Some("AXStaticText" | "AXImage" | "AXGroup") => {},
			_ => return false,
		}
		let Some(parent) = copy_element(&element, "AXParent") else {
			return false;
		};
		element = parent;
	}
	false
}

/// The accessibility role of the element of `pid` at global point `(x, y)`,
/// or `None` when it cannot be read.
pub(crate) fn role_at(pid: libc::pid_t, x: f64, y: f64) -> Option<String> {
	let app = probe_application(pid)?;
	let element = hit_test(&app, x, y)?;
	copy_string(&element, "AXRole")
}

/// The element of `app` at global point `(x, y)`.
fn hit_test(app: &AXUIElement, x: f64, y: f64) -> Option<CFRetained<AXUIElement>> {
	let mut output: *const AXUIElement = ptr::null();
	// SAFETY: `output` is writable and the retained application element
	// remains valid through the synchronous hit-test.
	let error =
		unsafe { app.copy_element_at_position(x as f32, y as f32, NonNull::from(&mut output)) };
	if error != AXError::Success {
		return None;
	}
	retained_element(output).ok()
}

/// A press that may open a menu, as errors name it.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Press<'a> {
	/// A pointer gesture of `kind`, such as "click", delivered to `window`.
	Pointer { kind: &'a str, window: &'a DesktopWindow },
	/// An accessibility action, such as `AXPress`.
	Action(&'a str),
}

/// What became of a menu a press may have opened.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settled {
	/// No new menu appeared.
	NoMenu,
	/// The requested item was pressed and the menu closed.
	Chosen,
	/// A menu opened and was closed with nothing chosen.
	Unchosen {
		/// Why the requested path chose nothing; `None` when none was given.
		refusal: Option<String>,
		/// The items of the menu level the call stopped at, as errors list them.
		items:   String,
		/// Whether the menu closed.
		closed:  bool,
	},
}

/// Runs `press`, then, when `before` lists the target's menu windows from
/// before it, `settle`s a menu the press opened: it chooses `path` there, or
/// closes the menu with nothing chosen. Settling runs whatever the press
/// returned, cancellation included, because an open menu takes the keyboard
/// from the user's app until it closes; a press that failed only has its menu
/// closed. A press whose menu was closed unchosen reports `InputFailed`: it
/// was delivered and may have taken effect, and rerunning it in takeover would
/// not help, since handing focus back closes the menu again.
pub(crate) fn guard(
	press: Press<'_>,
	before: Option<&[u32]>,
	path: Option<&[String]>,
	run: impl FnOnce() -> CoreResult<()>,
	settle: impl FnOnce(&[u32], Option<&[String]>) -> CoreResult<Settled>,
) -> CoreResult<()> {
	let delivered = run();
	let Some(before) = before else {
		return delivered;
	};
	let path = if delivered.is_ok() { path } else { None };
	let settled = control::cleanup(|| settle(before, path));
	match (delivered, settled) {
		(_, Ok(Settled::Unchosen { closed: false, items, .. })) => {
			Err(DesktopError::input_failed(left_open_message(press, &items)))
		},
		(Ok(()), Ok(Settled::Unchosen { refusal, items, .. })) => {
			Err(DesktopError::input_failed(unchosen_message(press, refusal.as_deref(), &items)))
		},
		(Ok(()), Ok(Settled::NoMenu)) if path.is_some() => {
			Err(DesktopError::input_failed(no_menu_message(press)))
		},
		(delivered, Ok(_)) => delivered,
		// Settling stopped before pressing an item because the call was
		// cancelled, or the user came to or used the app; the menu was closed.
		(_, Err(error)) if stops_the_call(&error) => Err(error),
		(delivered, Err(error)) => skylight::after_cleanup(delivered, Err(error)),
	}
}

/// Whether settling stopped for a reason that ends the whole call rather than
/// refusing the menu path: the agent was stopped, or the user came to the app
/// or pressed a key or clicked in it.
const fn stops_the_call(error: &DesktopError) -> bool {
	matches!(error.code, ErrorCode::Cancelled | ErrorCode::UserIntervened)
}

fn opened(press: Press<'_>) -> String {
	match press {
		Press::Pointer { kind, window } => {
			format!("the {kind} reached window {} ({}) and opened a menu", window.id, window.app)
		},
		Press::Action(action) => format!("{action} opened a menu"),
	}
}

fn aftermath(press: Press<'_>) -> String {
	match press {
		Press::Pointer { kind, .. } => {
			format!(
				"; the {kind} may already have taken effect, so inspect the window before retrying"
			)
		},
		Press::Action(_) => String::new(),
	}
}

fn listed(items: &str) -> String {
	if items.is_empty() {
		String::new()
	} else {
		format!(" Items: {items}.")
	}
}

fn unchosen_message(press: Press<'_>, refusal: Option<&str>, items: &str) -> String {
	let (opened, aftermath, listed) = (opened(press), aftermath(press), listed(items));
	match refusal {
		None => format!(
			"{opened}, which takes the keyboard from the user's app, so it was closed with nothing \
			 chosen{aftermath}. To choose an item in the background, pass its path as the menu \
			 option, e.g. menu: [\"<item>\", \"<subitem>\"].{listed}"
		),
		Some(refusal) => format!(
			"{opened}, but {refusal}, so nothing was chosen and the menu was \
			 closed{aftermath}.{listed}"
		),
	}
}

fn left_open_message(press: Press<'_>, items: &str) -> String {
	format!(
		"{} that is still open after Escape, which keeps the keyboard from the user's app; inspect \
		 the desktop before retrying.{}",
		opened(press),
		listed(items)
	)
}

fn no_menu_message(press: Press<'_>) -> String {
	match press {
		Press::Pointer { kind, window } => format!(
			"the {kind} reached window {} ({}) but opened no menu, so nothing was chosen{}",
			window.id,
			window.app,
			aftermath(press)
		),
		Press::Action(action) => format!(
			"{action} opened no menu, so nothing was chosen; the action may already have taken effect"
		),
	}
}

/// One titled item of an open menu; separators are left out.
#[derive(Clone, Debug)]
struct Entry<N> {
	node:    N,
	title:   String,
	enabled: bool,
	submenu: Option<N>,
}

/// The reads and posts that settle a menu; tests replace them.
trait Menus {
	type Node: Clone;
	/// Ids of the application's on-screen menu windows; `None` when the
	/// window list cannot be read.
	fn windows(&mut self) -> Option<Vec<u32>>;
	/// The open menu showing in menu window `window`.
	fn locate(&mut self, window: u32) -> Option<Self::Node>;
	/// The titled items of `menu`, in order.
	fn items(&mut self, menu: &Self::Node) -> CoreResult<Vec<Entry<Self::Node>>>;
	fn press(&mut self, item: &Self::Node) -> CoreResult<()>;
	/// Ends `menu`'s tracking through accessibility (`AXCancel`).
	fn cancel(&mut self, menu: &Self::Node) -> CoreResult<()>;
	/// Posts Escape to the application, which closes its open menu.
	fn escape(&mut self) -> CoreResult<()>;
}

/// Settles a menu that a press of `app_pid` opened, within `timeout`, since
/// the menu windows of `menu_pid`, the process that shows its menus
/// ([`menu_process`]), were `before`: chooses `path` in it, or closes it; see
/// [`guard`]. Right before a path's item is pressed, the call must not have
/// been cancelled ([`control::check_new_input`]: settling runs under cleanup,
/// where [`control::check`] lets everything through), the user must not have
/// pressed a key or clicked in the app since the call was admitted
/// ([`control::intervention::check_press`]), and `holds` must pass: the menu
/// can take the whole timeout to appear, and the user may have stopped the
/// agent, used the app, or brought the target forward meanwhile, which
/// [`input::recheck_background`] tells. When any refuses, the menu is closed
/// and nothing is pressed: a cancelled call reports `Cancelled`, the user's
/// input `UserIntervened`, and a target that no longer holds is a refusal of
/// the path, reported as delivered ([`guard`]), since the press that opened
/// the menu went out.
pub(crate) fn settle(
	menu_pid: libc::pid_t,
	app_pid: libc::pid_t,
	before: &[u32],
	path: Option<&[String]>,
	timeout: Duration,
	holds: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<Settled> {
	settle_with(&mut AxMenus { pid: menu_pid, app_pid, app: None }, before, path, timeout, holds)
}

/// The process that shows the menus of an element of `app_pid` whose window
/// maps to `drawn`: the window's owner (`owner_of`), which for a system Open
/// or Save panel is `openAndSavePanelService`, or else `app_pid`.
pub(crate) fn menu_process(
	app_pid: libc::pid_t,
	drawn: Option<u32>,
	owner_of: impl FnOnce(u32) -> Option<libc::pid_t>,
) -> libc::pid_t {
	drawn.and_then(owner_of).unwrap_or(app_pid)
}

/// Whether a menu element reporting process `owner`, hit-tested in a menu
/// window of `menu_pid`, is the target's: a remote view's service shows the
/// menu, but its elements report `app_pid`, the application hosting the view.
const fn owns_menu(owner: libc::pid_t, menu_pid: libc::pid_t, app_pid: libc::pid_t) -> bool {
	owner == menu_pid || owner == app_pid
}

fn settle_with<M: Menus>(
	menus: &mut M,
	before: &[u32],
	path: Option<&[String]>,
	timeout: Duration,
	holds: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<Settled> {
	let mut read = false;
	let opened = poll(timeout, || {
		let now = menus.windows()?;
		read = true;
		new_menu(before, &now)
	})?;
	let Some(window) = opened else {
		return if read {
			Ok(Settled::NoMenu)
		} else {
			Err(DesktopError::input_failed(
				"cannot list the target's open menus after the input, so a menu it opened may still \
				 be open",
			))
		};
	};
	let menu = menus.locate(window);
	let (refusal, items) = match (path, &menu) {
		(Some(path), Some(menu)) => match choose(menus, menu, path) {
			Ok(leaf) => match control::check_new_input()
				.and_then(|()| control::intervention::check_press())
				.and_then(|()| holds())
			{
				Err(error) if stops_the_call(&error) => {
					close(menus, window, Some(menu))?;
					return Err(error);
				},
				Err(error) => (Some(error.message), String::new()),
				Ok(()) => match menus.press(&leaf.node) {
					Ok(()) if end_chosen(menus, window, menu)? => return Ok(Settled::Chosen),
					Ok(()) => (
						Some(format!("the menu stayed open after {} was pressed", quote_path(path))),
						String::new(),
					),
					Err(error) => (
						Some(format!(
							"pressing menu item '{}' failed ({}), and it may already have taken effect",
							leaf.path, error.message
						)),
						String::new(),
					),
				},
			},
			Err(refusal) => (Some(refusal.message), refusal.items),
		},
		(Some(_), None) => {
			(Some("its items could not be read through accessibility".to_string()), String::new())
		},
		(None, Some(menu)) => (None, listing(menus, menu)),
		(None, None) => (None, String::new()),
	};
	let closed = close(menus, window, menu.as_ref())?;
	Ok(Settled::Unchosen { refusal, items, closed })
}

/// Ends the menu showing in `window` after an item of `menu` was pressed:
/// `true` once it is closed. The pressed item flashes and the menu fades out
/// for about 340 ms, and until it is gone `WindowServer` sends the user's keys
/// to the target, which types them into its own key window once the menu
/// closes. `AXCancel` right behind the press ends it within a few
/// milliseconds, and `AppKit` still sends the item's action. A menu that
/// refuses the cancel closes after its fade.
fn end_chosen<M: Menus>(menus: &mut M, window: u32, menu: &M::Node) -> CoreResult<bool> {
	let _ = menus.cancel(menu);
	await_closed(menus, window)
}

/// Closes menu window `window`, showing `menu`, unless it already closed;
/// whether it is closed afterwards. `AXCancel` closes it at once. Escape, the
/// fallback, leaves it fading out for about 270 ms, and until the fade ends
/// the keyboard stays with the target, which types the user's keys into its
/// own key window once the menu is gone.
fn close<M: Menus>(menus: &mut M, window: u32, menu: Option<&M::Node>) -> CoreResult<bool> {
	if !is_open(menus, window) {
		return Ok(true);
	}
	if let Some(menu) = menu
		&& menus.cancel(menu).is_ok()
		&& await_closed(menus, window)?
	{
		return Ok(true);
	}
	menus.escape()?;
	await_closed(menus, window)
}

fn await_closed<M: Menus>(menus: &mut M, window: u32) -> CoreResult<bool> {
	Ok(poll(MENU_CLOSE_TIMEOUT, || (!is_open(menus, window)).then_some(()))?.is_some())
}

fn is_open<M: Menus>(menus: &mut M, window: u32) -> bool {
	menus.windows().is_none_or(|now| now.contains(&window))
}

/// Why a path chose nothing, and the items of the level where it stopped.
#[derive(Debug, PartialEq, Eq)]
struct Refusal {
	message: String,
	items:   String,
}

/// The command item a path ends at, and its path as errors name it.
struct Leaf<N> {
	node: N,
	path: String,
}

/// Walks `path` from `menu` to the item to press. Labels match as in
/// `win.menu.select`: case-insensitively, a trailing ellipsis tolerated, and
/// a label matching two items refuses. Each item on the way must be enabled,
/// and the leaf must be a command rather than a submenu.
fn choose<M: Menus>(
	menus: &mut M,
	menu: &M::Node,
	path: &[String],
) -> Result<Leaf<M::Node>, Refusal> {
	let mut menu = menu.clone();
	let mut walked: Vec<String> = Vec::with_capacity(path.len());
	for (depth, label) in path.iter().enumerate() {
		let entries = menus.items(&menu).map_err(|error| Refusal {
			message: format!("its items could not be read ({})", error.message),
			items:   String::new(),
		})?;
		let items: Vec<DesktopMenuItem> = entries
			.iter()
			.map(|entry| DesktopMenuItem {
				title:       entry.title.clone(),
				path:        walked.iter().chain([&entry.title]).cloned().collect(),
				enabled:     entry.enabled,
				checked:     false,
				has_submenu: entry.submenu.is_some(),
				shortcut:    None,
			})
			.collect();
		let refuse = |menus: &mut M, message: String| {
			let mut budget = MAX_LISTED_ITEMS.saturating_sub(entries.len());
			Refusal { message, items: render(menus, &entries, 0, &mut budget) }
		};
		let index = match match_index(&items, label) {
			Ok(index) => index,
			Err(error) => return Err(refuse(menus, error.message)),
		};
		let (entry, item) = (&entries[index], &items[index]);
		if let Err(error) = require_enabled(item) {
			return Err(refuse(menus, error.message));
		}
		if depth + 1 < path.len() {
			let Some(submenu) = &entry.submenu else {
				return Err(refuse(menus, format!("menu item '{}' has no submenu", entry.title)));
			};
			menu = submenu.clone();
			walked.push(entry.title.clone());
			continue;
		}
		if let Some(submenu) = &entry.submenu {
			return Err(Refusal {
				message: format!(
					"menu item '{}' opens a submenu, and the path must end at one of its items",
					item.path.join(" > ")
				),
				items:   listing(menus, submenu),
			});
		}
		return Ok(Leaf { node: entry.node.clone(), path: item.path.join(" > ") });
	}
	Err(Refusal { message: "the menu path is empty".to_string(), items: String::new() })
}

fn quote_path(path: &[String]) -> String {
	path
		.iter()
		.map(|label| format!("'{label}'"))
		.collect::<Vec<_>>()
		.join(" > ")
}

/// The items of `menu` as errors list them: titles in menu order, disabled
/// ones marked, and an enabled submenu followed by its own items while
/// [`MAX_LISTED_ITEMS`] allows.
fn listing<M: Menus>(menus: &mut M, menu: &M::Node) -> String {
	match menus.items(menu) {
		Ok(entries) => {
			let mut budget = MAX_LISTED_ITEMS.saturating_sub(entries.len());
			render(menus, &entries, 0, &mut budget)
		},
		Err(_) => String::new(),
	}
}

/// Renders `entries`, already charged to `budget`, expanding the submenus
/// above [`MAX_LISTED_DEPTH`] that fit in what remains.
fn render<M: Menus>(
	menus: &mut M,
	entries: &[Entry<M::Node>],
	depth: usize,
	budget: &mut usize,
) -> String {
	let mut parts = Vec::with_capacity(entries.len());
	for entry in entries {
		let mut part = format!("\"{}\"", entry.title);
		if !entry.enabled {
			part.push_str(" (disabled)");
		}
		if let Some(submenu) = &entry.submenu {
			part.push_str(" ▸");
			if entry.enabled
				&& depth < MAX_LISTED_DEPTH
				&& let Ok(children) = menus.items(submenu)
				&& !children.is_empty()
				&& children.len() <= *budget
			{
				*budget -= children.len();
				part.push_str(" [");
				part.push_str(&render(menus, &children, depth + 1, budget));
				part.push(']');
			}
		}
		parts.push(part);
	}
	parts.join(", ")
}

/// Calls `probe` every [`MENU_POLL`] until it yields a value or `timeout`
/// passes.
pub(crate) fn poll<T>(
	timeout: Duration,
	mut probe: impl FnMut() -> Option<T>,
) -> CoreResult<Option<T>> {
	let deadline = Instant::now() + timeout;
	loop {
		if let Some(value) = probe() {
			return Ok(Some(value));
		}
		if Instant::now() >= deadline {
			return Ok(None);
		}
		control::wait(MENU_POLL)?;
	}
}

/// A menu window listed in `now` that was not open `before`.
pub(crate) fn new_menu(before: &[u32], now: &[u32]) -> Option<u32> {
	now.iter().copied().find(|menu| !before.contains(menu))
}

/// [`Menus`] on a live application through accessibility: `pid` shows the
/// menu windows, and its menus belong to `pid` or `app_pid` ([`owns_menu`]).
struct AxMenus {
	pid:     libc::pid_t,
	app_pid: libc::pid_t,
	app:     Option<CFRetained<AXUIElement>>,
}

impl Menus for AxMenus {
	type Node = CFRetained<AXUIElement>;

	fn windows(&mut self) -> Option<Vec<u32>> {
		capture::menu_windows(self.pid)
	}

	fn locate(&mut self, window: u32) -> Option<Self::Node> {
		let frame = capture::window_frame(window)?;
		if self.app.is_none() {
			let app = create_application(self.pid).ok()?;
			set_timeout(&app).ok()?;
			self.app = Some(app);
		}
		let app = self.app.as_deref()?;
		let x = frame.origin.x + frame.size.width / 2.0;
		let y = frame.origin.y + frame.size.height / 2.0;
		let mut element = hit_test(app, x, y)?;
		for _ in 0..MAX_ASCENT {
			if copy_string(&element, "AXRole").as_deref() == Some("AXMenu") {
				return owns_menu(element_pid(&element).ok()?, self.pid, self.app_pid)
					.then_some(element);
			}
			element = copy_element(&element, "AXParent")?;
		}
		None
	}

	fn items(&mut self, menu: &Self::Node) -> CoreResult<Vec<Entry<Self::Node>>> {
		let mut entries = Vec::new();
		for child in bounded_children(menu, true)? {
			if copy_string(&child, "AXRole").as_deref() != Some("AXMenuItem") {
				continue;
			}
			let Some(title) = copy_string(&child, "AXTitle").filter(|title| !title.is_empty()) else {
				continue;
			};
			let submenu = copy_elements_optional(&child, "AXChildren")
				.unwrap_or_default()
				.into_iter()
				.find(|item| copy_string(item, "AXRole").as_deref() == Some("AXMenu"));
			entries.push(Entry {
				enabled: copy_bool(&child, "AXEnabled").unwrap_or(false),
				node: child,
				title,
				submenu,
			});
		}
		Ok(entries)
	}

	fn press(&mut self, item: &Self::Node) -> CoreResult<()> {
		perform_action(item, "AXPress")
	}

	fn cancel(&mut self, menu: &Self::Node) -> CoreResult<()> {
		perform_action(menu, "AXCancel")
	}

	fn escape(&mut self) -> CoreResult<()> {
		input::post_escape(self.pid)
	}
}

#[cfg(test)]
mod tests {
	use std::{cell::RefCell, collections::HashMap};

	use super::*;

	/// One fake menu item: title, whether it is enabled, and its submenu's id.
	type Item = (&'static str, bool, Option<u32>);

	/// A scripted application: its menu tree, which window shows it from which
	/// poll on, and a log of every press, `AXCancel` and Escape. Item `i` of
	/// menu `m` is node `m * 100 + i`.
	#[derive(Default)]
	struct Fake {
		/// Menu id → its items.
		tree:         HashMap<u32, Vec<Item>>,
		/// Menu windows open now.
		open:         Vec<u32>,
		/// The menu window the press opens, and the poll that first lists it.
		opens:        Option<(u32, usize)>,
		polls:        usize,
		/// Whether pressing an item, `AXCancel` or Escape closes the menu; a
		/// pressed item's menu that stays open models `AppKit`'s flash and
		/// fade, and a menu that does not take `AXCancel` refuses it.
		press_closes: bool,
		cancel_works: bool,
		escape_works: bool,
		log:          RefCell<Vec<String>>,
	}

	impl Menus for Fake {
		type Node = u32;

		fn windows(&mut self) -> Option<Vec<u32>> {
			self.polls += 1;
			if let Some((window, from)) = self.opens
				&& self.polls >= from
			{
				self.open.push(window);
				self.opens = None;
			}
			Some(self.open.clone())
		}

		fn locate(&mut self, window: u32) -> Option<u32> {
			self.tree.contains_key(&window).then_some(window)
		}

		fn items(&mut self, menu: &u32) -> CoreResult<Vec<Entry<u32>>> {
			Ok((0u32..)
				.zip(&self.tree[menu])
				.map(|(index, &(title, enabled, submenu))| Entry {
					node: menu * 100 + index,
					title: title.to_string(),
					enabled,
					submenu,
				})
				.collect())
		}

		fn press(&mut self, item: &u32) -> CoreResult<()> {
			let (title, ..) = self.tree[&(item / 100)][(item % 100) as usize];
			self.log.borrow_mut().push(format!("press {title}"));
			if self.press_closes {
				self.open.clear();
			}
			Ok(())
		}

		fn cancel(&mut self, _: &u32) -> CoreResult<()> {
			self.log.borrow_mut().push("cancel".to_string());
			if !self.cancel_works {
				return Err(DesktopError::ax_failed("AXCancel is not supported"));
			}
			self.open.clear();
			Ok(())
		}

		fn escape(&mut self) -> CoreResult<()> {
			self.log.borrow_mut().push("escape".to_string());
			if self.escape_works {
				self.open.clear();
			}
			Ok(())
		}
	}

	/// Font Book's context menu: "Add to" ▸ two collections, a disabled
	/// command, and an enabled one.
	fn font_book() -> Fake {
		Fake {
			tree: HashMap::from([
				(9, vec![
					("Add to", true, Some(20)),
					("Remove", false, None),
					("Show in Finder", true, None),
				]),
				(20, vec![("Bench Holdout", true, None), ("Serif…", true, None)]),
			]),
			opens: Some((9, 3)),
			press_closes: true,
			cancel_works: true,
			escape_works: true,
			..Fake::default()
		}
	}

	fn path(labels: &[&str]) -> Vec<String> {
		labels.iter().map(ToString::to_string).collect()
	}

	/// The target still holds at every recheck.
	#[allow(clippy::unnecessary_wraps, reason = "stands in for a recheck, which can refuse")]
	fn held() -> CoreResult<()> {
		Ok(())
	}

	#[test]
	fn a_menu_the_press_opened_is_closed_and_its_items_listed() {
		let mut app = font_book();
		let settled = settle_with(&mut app, &[], None, CONTEXT_MENU_TIMEOUT, held).expect("settled");
		assert_eq!(settled, Settled::Unchosen {
			refusal: None,
			items:   "\"Add to\" ▸ [\"Bench Holdout\", \"Serif…\"], \"Remove\" (disabled), \"Show in \
			          Finder\""
				.to_string(),
			closed:  true,
		});
		// Escape would leave the menu fading out with the keyboard.
		assert_eq!(*app.log.borrow(), ["cancel"]);
	}

	#[test]
	fn escape_closes_a_menu_that_refuses_cancel() {
		let mut app = font_book();
		app.cancel_works = false;
		let settled = settle_with(&mut app, &[], None, CONTEXT_MENU_TIMEOUT, held).expect("settled");
		assert!(matches!(settled, Settled::Unchosen { closed: true, .. }), "{settled:?}");
		assert_eq!(*app.log.borrow(), ["cancel", "escape"]);
	}

	#[test]
	fn a_path_presses_its_leaf_through_submenus_and_cancels_the_fading_menu() {
		let mut app = font_book();
		// `AppKit` flashes the pressed item and fades the menu out for about
		// 340 ms, with the user's keyboard; the cancel ends it at once.
		app.press_closes = false;
		let wanted = path(&["add TO", "serif..."]);
		let settled = settle_with(&mut app, &[], Some(&wanted), CONTEXT_MENU_TIMEOUT, held);
		assert_eq!(settled.expect("settled"), Settled::Chosen);
		assert_eq!(*app.log.borrow(), ["press Serif…", "cancel"]);
	}

	#[test]
	fn a_path_presses_nothing_once_the_target_no_longer_holds() {
		// The user brought the target forward while its menu took its time to
		// appear: the recheck right before the press refuses, and the menu is
		// closed with nothing pressed.
		let mut app = font_book();
		let wanted = path(&["Show in Finder"]);
		let refused =
			|| Err(DesktopError::background_unavailable("window 42's application came to the front"));
		let settled = settle_with(&mut app, &[], Some(&wanted), CONTEXT_MENU_TIMEOUT, refused);
		// The press that opened the menu went out, so this is a delivered
		// call whose path chose nothing, not a refusal before any input.
		assert_eq!(settled.expect("settled"), Settled::Unchosen {
			refusal: Some("window 42's application came to the front".to_string()),
			items:   String::new(),
			closed:  true,
		});
		assert_eq!(*app.log.borrow(), ["cancel"]);
		assert!(app.open.is_empty());
		// A path that matches nothing refuses without the recheck.
		let mut app = font_book();
		let wanted = path(&["Sans"]);
		let unasked = || -> CoreResult<()> { panic!("nothing is pressed, so nothing is rechecked") };
		let settled = settle_with(&mut app, &[], Some(&wanted), CONTEXT_MENU_TIMEOUT, unasked);
		assert!(matches!(settled, Ok(Settled::Unchosen { closed: true, .. })), "{settled:?}");
	}

	#[test]
	fn a_path_presses_nothing_once_the_call_was_cancelled() {
		// The agent was stopped after the click went out and before its menu
		// appeared: the menu is settled under cleanup, which lets releases
		// through, but its item is new input and is not pressed.
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let wanted = path(&["Show in Finder"]);
		let (error, log) = control::with_token_for_test(&token, || {
			let press = Press::Action("AXPress");
			let mut app = font_book();
			let error = guard(
				press,
				Some(&[]),
				Some(&wanted),
				|| {
					cancellation.cancel();
					Ok(())
				},
				|before, path| settle_with(&mut app, before, path, CONTEXT_MENU_TIMEOUT, held),
			)
			.expect_err("cancelled");
			(error, app.log.borrow().clone())
		});
		assert_eq!(error.code.as_str(), "Cancelled");
		assert_eq!(log, ["cancel"]);
	}

	#[test]
	fn a_path_presses_nothing_once_the_user_used_the_app() {
		// The user typed in the target's app while the menu its click opened
		// took its time to appear: the call stops as the user's, the menu is
		// closed, and its item is not pressed.
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "Font Book".to_string());
		let token = control::CancellationSource::default().token();
		let _watch = listener
			.admit(7, &token)
			.expect("the user has not used Font Book");
		let wanted = path(&["Show in Finder"]);
		let mut app = font_book();
		let error = guard(
			Press::Action("AXPress"),
			Some(&[]),
			Some(&wanted),
			|| {
				listener.record_for_test(7, Instant::now());
				Ok(())
			},
			|before, path| settle_with(&mut app, before, path, CONTEXT_MENU_TIMEOUT, held),
		)
		.expect_err("the user stepped in");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(*app.log.borrow(), ["cancel"]);
	}

	#[test]
	fn a_path_that_chooses_nothing_closes_the_menu_and_lists_its_level() {
		let refused = |labels: &[&str]| {
			let mut app = font_book();
			let wanted = path(labels);
			let settled = settle_with(&mut app, &[], Some(&wanted), CONTEXT_MENU_TIMEOUT, held);
			assert_eq!(*app.log.borrow(), ["cancel"], "{labels:?}");
			match settled.expect("settled") {
				Settled::Unchosen { refusal: Some(refusal), items, closed: true } => (refusal, items),
				other => panic!("{labels:?}: {other:?}"),
			}
		};
		let (refusal, items) = refused(&["Add to", "Sans"]);
		assert_eq!(refusal, "menu item 'Sans' was not found");
		assert_eq!(items, "\"Bench Holdout\", \"Serif…\"");
		let (refusal, items) = refused(&["Remove"]);
		assert_eq!(refusal, "menu item 'Remove' is disabled; no command was dispatched");
		assert!(items.starts_with("\"Add to\" ▸ ["), "{items}");
		let (refusal, items) = refused(&["Add to"]);
		assert!(refusal.contains("'Add to' opens a submenu"), "{refusal}");
		assert_eq!(items, "\"Bench Holdout\", \"Serif…\"");
		let (refusal, _) = refused(&["Show in Finder", "Desktop"]);
		assert_eq!(refusal, "menu item 'Show in Finder' has no submenu");
	}

	#[test]
	fn a_pressed_item_whose_menu_stays_open_is_closed_and_reported() {
		let mut app = font_book();
		app.press_closes = false;
		app.cancel_works = false;
		let wanted = path(&["Show in Finder"]);
		let settled = settle_with(&mut app, &[], Some(&wanted), CONTEXT_MENU_TIMEOUT, held);
		match settled.expect("settled") {
			Settled::Unchosen { refusal: Some(refusal), closed: true, .. } => {
				assert!(
					refusal.contains("stayed open after 'Show in Finder' was pressed"),
					"{refusal}"
				);
			},
			other => panic!("{other:?}"),
		}
		assert_eq!(*app.log.borrow(), ["press Show in Finder", "cancel", "cancel", "escape"]);
	}

	#[test]
	fn only_a_menu_the_press_opened_is_closed() {
		// A menu open before the press (another menu of the app) is not the
		// press's menu.
		let mut app = font_book();
		app.open = vec![9];
		app.opens = None;
		let settled =
			settle_with(&mut app, &[9], None, Duration::from_millis(30), held).expect("settled");
		assert_eq!(settled, Settled::NoMenu);
		assert!(app.log.borrow().is_empty());
		assert_eq!(new_menu(&[5], &[5]), None);
		assert_eq!(new_menu(&[5], &[5, 9]), Some(9));
		assert_eq!(new_menu(&[], &[]), None);
		// No menu: the press returns once the timeout passes.
		let started = Instant::now();
		assert_eq!(poll(Duration::from_millis(30), || new_menu(&[5], &[5])).expect("poll"), None);
		assert!(started.elapsed() >= Duration::from_millis(30));
	}

	#[test]
	fn a_menu_that_ignores_cancel_and_escape_is_reported_open() {
		let mut app = font_book();
		app.cancel_works = false;
		app.escape_works = false;
		let settled = settle_with(&mut app, &[], None, CONTEXT_MENU_TIMEOUT, held).expect("settled");
		assert!(matches!(settled, Settled::Unchosen { closed: false, .. }), "{settled:?}");
	}

	#[test]
	fn listing_stops_expanding_submenus_at_its_budget() {
		let many = vec![("Font", true, None); MAX_LISTED_ITEMS];
		let mut app = Fake {
			tree: HashMap::from([
				(9, vec![("Add to", true, Some(20)), ("Open", true, None)]),
				(20, many),
			]),
			..Fake::default()
		};
		assert_eq!(listing(&mut app, &9), "\"Add to\" ▸, \"Open\"");
	}

	fn finder_window() -> DesktopWindow {
		DesktopWindow {
			id:      "42".to_string(),
			title:   String::new(),
			app:     "Finder".to_string(),
			pid:     Some(7),
			x:       0,
			y:       0,
			width:   100,
			height:  100,
			focused: false,
		}
	}

	#[test]
	fn a_press_whose_menu_was_closed_reports_delivery_and_the_items() {
		let window = finder_window();
		let closed = |_: &[u32], _: Option<&[String]>| {
			Ok(Settled::Unchosen {
				refusal: None,
				items:   "\"New Folder\"".to_string(),
				closed:  true,
			})
		};
		// The page's handlers already ran, and a drag ran its whole stroke, so
		// the caller must inspect rather than take the error for "nothing sent".
		for kind in ["click", "drag"] {
			let press = Press::Pointer { kind, window: &window };
			let error = guard(press, Some(&[]), None, || Ok(()), closed).expect_err("closed");
			assert_eq!(error.code.as_str(), "InputFailed", "{kind}");
			assert!(
				error
					.message
					.contains(&format!("the {kind} may already have taken effect"))
			);
			assert!(error.message.contains("inspect the window before retrying"));
			assert!(error.message.ends_with("Items: \"New Folder\"."), "{}", error.message);
		}
		let error =
			guard(Press::Action("AXPress"), Some(&[]), None, || Ok(()), closed).expect_err("closed");
		assert_eq!(error.code.as_str(), "InputFailed");
		assert!(
			error
				.message
				.starts_with("AXPress opened a menu, which takes the keyboard from the user's app"),
			"{}",
			error.message
		);
		assert!(
			error
				.message
				.contains("so it was closed with nothing chosen")
		);
		assert!(error.message.contains("pass its path as the menu option"));
		// A menu still open fails whatever the press returned.
		let open = |_: &[u32], _: Option<&[String]>| {
			Ok(Settled::Unchosen { refusal: None, items: String::new(), closed: false })
		};
		let error =
			guard(Press::Action("AXShowMenu"), Some(&[]), None, || Ok(()), open).expect_err("open");
		assert!(error.message.contains("still open after Escape"), "{}", error.message);
		let cancelled = || Err(DesktopError::cancelled("cancelled"));
		let error =
			guard(Press::Action("AXPress"), Some(&[]), None, cancelled, open).expect_err("open");
		assert_eq!(error.code.as_str(), "InputFailed");
		let none = |_: &[u32], _: Option<&[String]>| Ok(Settled::NoMenu);
		assert!(guard(Press::Action("AXPress"), Some(&[]), None, || Ok(()), none).is_ok());
	}

	#[test]
	fn a_path_succeeds_only_when_its_item_was_chosen() {
		let window = finder_window();
		let press = Press::Pointer { kind: "click", window: &window };
		let wanted = path(&["Add to", "Bench Holdout"]);
		let chosen = |_: &[u32], path: Option<&[String]>| {
			assert_eq!(path, Some(wanted.as_slice()));
			Ok(Settled::Chosen)
		};
		assert!(guard(press, Some(&[]), Some(&wanted), || Ok(()), chosen).is_ok());
		// No menu to choose from fails as delivered.
		let none = |_: &[u32], _: Option<&[String]>| Ok(Settled::NoMenu);
		let error = guard(press, Some(&[]), Some(&wanted), || Ok(()), none).expect_err("no menu");
		assert_eq!(error.code.as_str(), "InputFailed");
		assert!(
			error
				.message
				.contains("opened no menu, so nothing was chosen"),
			"{}",
			error.message
		);
		// A refused path names why and lists the level it stopped at.
		let refused = |_: &[u32], _: Option<&[String]>| {
			Ok(Settled::Unchosen {
				refusal: Some("menu item 'Sans' was not found".to_string()),
				items:   "\"Bench Holdout\"".to_string(),
				closed:  true,
			})
		};
		let error = guard(press, Some(&[]), Some(&wanted), || Ok(()), refused).expect_err("refused");
		assert_eq!(error.code.as_str(), "InputFailed");
		assert!(
			error
				.message
				.contains("opened a menu, but menu item 'Sans' was not found, so nothing was chosen"),
			"{}",
			error.message
		);
		assert!(error.message.ends_with("Items: \"Bench Holdout\"."), "{}", error.message);
		// A press that failed only has its menu closed, never an item chosen.
		let failed = guard(
			Press::Action("AXPress"),
			Some(&[]),
			Some(&wanted),
			|| Err(DesktopError::ax_failed("press failed")),
			|_, path| {
				assert_eq!(path, None);
				Ok(Settled::Unchosen { refusal: None, items: String::new(), closed: true })
			},
		);
		assert_eq!(failed.expect_err("failed").message, "press failed");
	}

	#[test]
	fn a_menu_is_closed_even_when_the_press_is_cancelled() {
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let mut settled = Vec::new();
		// The press opened a menu, then the user cancelled before it returned:
		// the menu is still closed, under cleanup, and the cancellation is
		// what the call reports.
		let result = control::with_token_for_test(&token, || {
			guard(
				Press::Action("AXPress"),
				Some(&[5]),
				None,
				|| {
					cancellation.cancel();
					control::wait(Duration::from_secs(100))
				},
				|before, _| {
					control::check()?;
					control::wait(Duration::from_millis(1))?;
					settled.push(before.to_vec());
					Ok(Settled::Unchosen { refusal: None, items: String::new(), closed: true })
				},
			)
		});
		assert_eq!(settled, [vec![5]]);
		assert_eq!(result.expect_err("cancelled").code.as_str(), "Cancelled");
		// No snapshot from before: no menu handling at all.
		let unread =
			|_: &[u32], _: Option<&[String]>| -> CoreResult<Settled> { panic!("no menu handling") };
		assert!(guard(Press::Action("AXPress"), None, None, || Ok(()), unread).is_ok());
		// The user came to the target before the item was pressed: the menu
		// was closed, and the call says why rather than a failed restoration.
		let intervened = guard(
			Press::Action("AXPress"),
			Some(&[5]),
			Some(&["Show in Finder".to_string()]),
			|| Ok(()),
			|_, _| Err(DesktopError::user_intervened("window 42's application came to the front")),
		);
		assert_eq!(intervened.expect_err("refused").code.as_str(), "UserIntervened");
		let unreadable = guard(
			Press::Action("AXPress"),
			Some(&[]),
			None,
			|| Ok(()),
			|_, _| Err(DesktopError::input_failed("unread")),
		);
		assert_eq!(unreadable.expect_err("unread").code.as_str(), "InputFailed");
	}

	#[test]
	fn only_menu_opening_actions_watch_for_a_menu() {
		let unread = || -> Option<String> { panic!("the role is read only for AXPress") };
		assert!(may_open("AXShowMenu", unread));
		assert!(!may_open("AXIncrement", unread));
		assert!(!may_open("AXConfirm", unread));
		assert!(may_open("AXPress", || Some("AXMenuButton".to_string())));
		assert!(may_open("AXPress", || Some("AXPopUpButton".to_string())));
		assert!(!may_open("AXPress", || Some("AXButton".to_string())));
		assert!(!may_open("AXPress", || None));
		// An element's own spelling in another case means the same action.
		assert!(may_open("axshowmenu", unread));
		assert!(may_open("axpress", || Some("AXPopUpButton".to_string())));
	}

	#[test]
	fn a_menu_opened_by_an_action_the_element_spells_in_another_case_is_closed() {
		// The element advertises its actions in lowercase, and `perform` sends
		// the spelling it advertised.
		let available = ["axshowmenu", "axpress"].map(String::from);
		for (call, role) in [("showmenu", None), ("press", Some("AXPopUpButton"))] {
			let native = super::super::supported_action(&available, call).expect("advertised");
			let watch = may_open(native, || role.map(str::to_string));
			let before: Option<&[u32]> = watch.then_some(&[]);
			let mut app = font_book();
			let error = guard(
				Press::Action(native),
				before,
				None,
				|| Ok(()),
				|before, path| settle_with(&mut app, before, path, CONTEXT_MENU_TIMEOUT, held),
			)
			.expect_err("the menu was closed unchosen");
			assert_eq!(error.code.as_str(), "InputFailed", "{call}");
			assert!(
				error
					.message
					.starts_with(&format!("{native} opened a menu")),
				"{}",
				error.message
			);
			assert_eq!(*app.log.borrow(), ["cancel"], "{call}: the menu was closed");
			assert!(app.open.is_empty(), "{call}");
		}
	}

	#[test]
	fn a_menu_of_a_remote_panel_is_watched_in_its_service_and_belongs_to_the_host() {
		// Automator (pid 71991) shows its Save sheet's controls in window 26086
		// of openAndSavePanelService (pid 71995); the Where: popup's menu is a
		// window of the service, and its AXMenu reports Automator.
		let owners = |window| match window {
			26086 => Some(71995),
			26072 => Some(71991),
			_ => None,
		};
		assert_eq!(menu_process(71991, Some(26086), owners), 71995);
		assert_eq!(menu_process(71991, Some(26072), owners), 71991);
		assert_eq!(menu_process(71991, Some(9), owners), 71991);
		assert_eq!(menu_process(71991, None, |_| panic!("no window to look up")), 71991);
		assert!(owns_menu(71991, 71995, 71991));
		assert!(owns_menu(71995, 71995, 71991));
		assert!(owns_menu(7581, 7581, 7581));
		// A menu another application shows over the point is not the target's.
		assert!(!owns_menu(512, 71995, 71991));
	}
}
