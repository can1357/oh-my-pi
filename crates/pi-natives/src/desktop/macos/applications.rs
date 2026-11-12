use std::{
	cell::RefCell,
	collections::{HashMap, HashSet},
	ffi::c_void,
	path::{Path, PathBuf},
	ptr::{self, NonNull},
	time::{Duration, Instant},
};

use block2::{DynBlock, RcBlock};
use objc2::rc::{Retained, autoreleasepool};
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFBoolean, CFRetained, CFString, CFType};
use objc2_foundation::{NSArray, NSBundle, NSError, NSFileManager, NSString, NSURL, ns_string};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
		macos::{
			application_windows, ax_window_ids, has_onscreen_window, has_open_window,
			is_standard_window, window_on_another_space, window_titles,
		},
		types::DesktopWindow,
	},
	Application, OpenedApplication,
};

/// How long `open` waits for an application's first window. On a macOS 26.5
/// VM, launches showed it 0.2–1.3 s after Launch Services confirmed them
/// (Contacts, Notes, `TextEdit`, Calendar, Font Book, Reminders, Automator) and
/// one cold Automator launch at 3.6 s; Preview without a document never shows
/// one and costs the whole wait, about one model turn.
const FIRST_WINDOW_WAIT: Duration = Duration::from_secs(3);
const FIRST_WINDOW_POLL: Duration = Duration::from_millis(50);
/// How many polls in a row ([`FIRST_WINDOW_POLL`] apart, plus the time a
/// window list takes: about 0.7 s) a window that changed its title for an
/// opened page must keep that title before it is returned. A browser shows a
/// new tab as "Untitled", or titled with its URL, until the page's own title
/// arrives: on a macOS 26.5 VM Safari showed "Untitled" for 0.1 to 0.4 s
/// before a local page's title, and for as long as a slow page took.
const SETTLE_POLLS: u32 = 10;
/// How long a reveal waits for Finder to be running: one that was quit starts
/// only after `activateFileViewerSelectingURLs` returns. Launch Services'
/// own launches are given 30 s ([`launch_services`]).
const FINDER_LAUNCH_WAIT: Duration = Duration::from_secs(30);

#[link(name = "proc")]
unsafe extern "C" {
	fn proc_listpids(kind: u32, info: u32, buffer: *mut c_void, bytes: i32) -> i32;
}

fn running_pids() -> CoreResult<Vec<libc::pid_t>> {
	const ALL_PIDS: u32 = 1;
	// SAFETY: A null buffer requests the required byte count.
	let bytes = unsafe { proc_listpids(ALL_PIDS, 0, ptr::null_mut(), 0) };
	if bytes <= 0 {
		return Err(DesktopError::internal("libproc could not enumerate running applications"));
	}
	let mut capacity = usize::try_from(bytes).unwrap_or(0) / size_of::<libc::pid_t>() + 64;
	loop {
		control::check()?;
		if capacity > 262_144 {
			return Err(DesktopError::internal("native process inventory exceeds its safety limit"));
		}
		let mut pids = Vec::<libc::pid_t>::with_capacity(capacity);
		let bytes = i32::try_from(capacity * size_of::<libc::pid_t>())
			.map_err(|_| DesktopError::internal("native process inventory size overflow"))?;
		// SAFETY: libproc writes at most `bytes` initialized pid_t values into
		// this exclusively owned allocation and returns their byte count.
		let written = unsafe { proc_listpids(ALL_PIDS, 0, pids.as_mut_ptr().cast(), bytes) };
		if written < 0 {
			return Err(DesktopError::internal("libproc failed to read running applications"));
		}
		if written >= bytes {
			capacity *= 2;
			continue;
		}
		let count = usize::try_from(written).unwrap_or(0) / size_of::<libc::pid_t>();
		// SAFETY: The successful byte count above is strictly within the
		// allocation; libproc initializes every complete returned pid_t.
		unsafe { pids.set_len(count) };
		pids.retain(|pid| *pid > 0);
		return Ok(pids);
	}
}

pub(super) fn list() -> CoreResult<Vec<Application>> {
	autoreleasepool(|_| {
		let mut apps = HashMap::<String, Application>::new();
		let mut roots = vec![
			PathBuf::from("/Applications"),
			PathBuf::from("/System/Applications"),
			PathBuf::from("/System/Library/CoreServices"),
			PathBuf::from("/Network/Applications"),
		];
		if let Some(home) = std::env::var_os("HOME") {
			roots.push(PathBuf::from(home).join("Applications"));
		}
		let mut visited = HashSet::new();
		while let Some(directory) = roots.pop() {
			control::check()?;
			let Ok(canonical) = directory.canonicalize() else {
				continue;
			};
			if !visited.insert(canonical.clone()) {
				continue;
			}
			let Ok(entries) = std::fs::read_dir(canonical) else {
				continue;
			};
			for entry in entries.flatten() {
				control::check()?;
				let path = entry.path();
				if path
					.extension()
					.is_some_and(|extension| extension.as_encoded_bytes().eq_ignore_ascii_case(b"app"))
				{
					if let Ok(app) = read_bundle(&path) {
						apps.entry(app.path.clone()).or_insert(app);
					}
				} else if entry.file_type().is_ok_and(|kind| kind.is_dir())
					&& !entry.file_name().to_string_lossy().starts_with('.')
				{
					roots.push(path);
				}
			}
		}
		// Running apps outside standard installation roots (including development
		// fixtures) are part of the inventory too. Preserve real process
		// identity. NSWorkspace's runningApplications cache depends on its
		// main run loop. Desktop requests run on a native worker, so query
		// current process IDs instead of returning a stale pre-launch
		// inventory.
		for pid in running_pids()? {
			control::check()?;
			let Some(running) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			else {
				continue;
			};
			if running.isTerminated() {
				continue;
			}
			let Some(app) = running_application(&running) else {
				continue;
			};
			apps.insert(app.path.clone(), app);
		}
		Ok(apps.into_values().collect())
	})
}

fn read_bundle(path: &Path) -> CoreResult<Application> {
	if !super::is_app_bundle(path) {
		return Err(DesktopError::invalid_target(
			"macOS application paths must identify an existing .app bundle",
		));
	}
	let path = path.canonicalize().map_err(|error| {
		if error.kind() == std::io::ErrorKind::PermissionDenied {
			DesktopError::permission_denied(format!(
				"cannot access application {}: {error}",
				path.display()
			))
		} else {
			DesktopError::invalid_target(format!(
				"cannot find application {}: {error}",
				path.display()
			))
		}
	})?;
	let path = path
		.to_str()
		.ok_or_else(|| DesktopError::invalid_target("application path is not valid UTF-8"))?;
	let bundle = NSBundle::bundleWithPath(&NSString::from_str(path)).ok_or_else(|| {
		DesktopError::invalid_target(format!("{path:?} is not a valid application bundle"))
	})?;
	if !bundle
		.executablePath()
		.is_some_and(|executable| Path::new(&executable.to_string()).is_file())
	{
		return Err(DesktopError::invalid_target(format!(
			"application bundle {path:?} has no accessible executable"
		)));
	}
	let name = bundle_string(&bundle, ns_string!("CFBundleDisplayName"))
		.or_else(|| bundle_string(&bundle, ns_string!("CFBundleName")))
		.unwrap_or_else(|| {
			Path::new(path)
				.file_stem()
				.unwrap_or_default()
				.to_string_lossy()
				.into_owned()
		});
	Ok(Application {
		id: bundle
			.bundleIdentifier()
			.map_or_else(|| path.to_owned(), |id| id.to_string()),
		name,
		path: path.to_owned(),
		running: false,
		pid: None,
	})
}

fn bundle_string(bundle: &NSBundle, key: &NSString) -> Option<String> {
	bundle
		.objectForInfoDictionaryKey(key)?
		.downcast::<NSString>()
		.ok()
		.map(|value| value.to_string())
}

/// Whether the bundle at `path` is a helper: not an `.app` (a running app
/// extension or XPC service), or an app that declares `LSUIElement` or
/// `LSBackgroundOnly`.
pub(super) fn is_helper(path: &Path) -> bool {
	if !path
		.extension()
		.is_some_and(|extension| extension.as_encoded_bytes().eq_ignore_ascii_case(b"app"))
	{
		return true;
	}
	autoreleasepool(|_| {
		let Some(bundle) = path
			.to_str()
			.and_then(|path| NSBundle::bundleWithPath(&NSString::from_str(path)))
		else {
			return false;
		};
		[ns_string!("LSUIElement"), ns_string!("LSBackgroundOnly")]
			.into_iter()
			.any(|key| {
				// Info.plist files spell the flag as a Boolean, a number or a
				// string such as "1".
				bundle.objectForInfoDictionaryKey(key).is_some_and(|value| {
					match value.downcast::<objc2_foundation::NSNumber>() {
						Ok(number) => number.boolValue(),
						Err(value) => value
							.downcast::<NSString>()
							.is_ok_and(|text| text.boolValue()),
					}
				})
			})
	})
}

fn running_application(running: &NSRunningApplication) -> Option<Application> {
	let path = running.bundleURL()?.path()?.to_string();
	let path = Path::new(&path)
		.canonicalize()
		.ok()
		.and_then(|path| path.into_string().ok())
		.unwrap_or(path);
	let name = running.localizedName().map_or_else(
		|| {
			Path::new(&path)
				.file_stem()
				.unwrap_or_default()
				.to_string_lossy()
				.into_owned()
		},
		|name| name.to_string(),
	);
	let pid = u32::try_from(running.processIdentifier())
		.ok()
		.filter(|pid| *pid != 0);
	Some(Application {
		id: running
			.bundleIdentifier()
			.map_or_else(|| path.clone(), |id| id.to_string()),
		name,
		path,
		running: !running.isTerminated(),
		pid,
	})
}

pub(super) fn from_path(path: &Path) -> CoreResult<Application> {
	autoreleasepool(|_| read_bundle(path))
}

/// Opens `app` and returns it with its frontmost window, given
/// [`FIRST_WINDOW_WAIT`] to show the first one. A running application is not
/// opened again while it shows a window: Launch Services would send it the
/// reopen event, which Notes and Contacts answer by activating themselves.
/// One without a window on screen is shown without activation instead
/// ([`show_in_background`]). `activate` always goes through Launch Services,
/// which activates, unhides and reopens.
pub(super) fn open(app: Application, activate: bool) -> CoreResult<OpenedApplication> {
	let wait = poll_window;
	if let Some(pid) = app.pid.filter(|_| app.running && !activate) {
		let path = app.path.clone();
		return open_running(
			app,
			pid,
			key_capable_windows,
			|| {
				libc::pid_t::try_from(pid)
					.ok()
					.and_then(has_onscreen_window)
					== Some(true)
			},
			|relaunched| show_in_background(pid, &path, relaunched),
			wait,
		);
	}
	let application = launch(&app.path, activate)?;
	let window = match application.pid {
		Some(pid) => first_window(
			false,
			FIRST_WINDOW_WAIT,
			|| key_capable_windows(pid),
			|| false,
			|| false,
			wait,
		)?,
		None => None,
	};
	Ok(OpenedApplication::new(application, window))
}

/// `pid`'s on-screen windows, front to back, that can be key: Quartz lists
/// Chromium's, Electron's and `WebKit`'s compositor surfaces as windows of
/// their own, and a handle to one refuses keys and menus and misplaces
/// clicks. `None` without a window list.
fn key_capable_windows(pid: u32) -> Option<Vec<DesktopWindow>> {
	let windows = application_windows(pid).ok()?;
	let ax_ids = libc::pid_t::try_from(pid).ok().and_then(ax_window_ids);
	Some(in_ax_windows(windows, ax_ids.as_deref()))
}

/// The `windows` among the application's accessibility windows (`ax_ids`);
/// all of them when those cannot be read, which proves nothing either way.
fn in_ax_windows(mut windows: Vec<DesktopWindow>, ax_ids: Option<&[u32]>) -> Vec<DesktopWindow> {
	if let Some(ids) = ax_ids {
		windows.retain(|window| window.id.parse::<u32>().is_ok_and(|id| ids.contains(&id)));
	}
	windows
}

/// [`open`] for application `app`, running as `pid`: its first window
/// ([`first_window`]), asking for one through `request_window` when it shows
/// none. The application may have exited since it was listed, and the reopen
/// event then launches it again under a new pid, which `request_window`
/// passes to its argument: the windows are then read, and the application
/// returned, as that process.
fn open_running(
	app: Application,
	pid: u32,
	mut windows_of: impl FnMut(u32) -> Option<Vec<DesktopWindow>>,
	unlisted_window: impl FnOnce() -> bool,
	request_window: impl FnOnce(&mut dyn FnMut(Application)) -> bool,
	wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<OpenedApplication> {
	let relaunched = RefCell::new(None::<Application>);
	let current = || {
		relaunched
			.borrow()
			.as_ref()
			.and_then(|app| app.pid)
			.unwrap_or(pid)
	};
	let window = first_window(
		true,
		FIRST_WINDOW_WAIT,
		|| windows_of(current()),
		unlisted_window,
		|| request_window(&mut |launched| *relaunched.borrow_mut() = Some(launched)),
		wait,
	)?;
	Ok(OpenedApplication::new(relaunched.into_inner().unwrap_or(app), window))
}

/// The application's frontmost window, given until `timeout` to show its
/// first one. With `show`, a running application without a window is asked to
/// show one first; when it cannot be asked, none is awaited. When the window
/// list cannot be read, no window is returned. An application
/// whose on-screen windows the list leaves out (`unlisted_window`), such as
/// one that does not allow capture, is not asked: it already shows one, and
/// the reopen event can make it activate itself.
fn first_window(
	show: bool,
	timeout: Duration,
	mut windows: impl FnMut() -> Option<Vec<DesktopWindow>>,
	unlisted_window: impl FnOnce() -> bool,
	request_window: impl FnOnce() -> bool,
	mut wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<Option<DesktopWindow>> {
	let deadline = Instant::now() + timeout;
	let Some(mut shown) = windows() else {
		return Ok(None);
	};
	if shown.is_empty() && show && (unlisted_window() || !request_window()) {
		return Ok(None);
	}
	while shown.is_empty() && Instant::now() < deadline {
		wait()?;
		shown = windows().unwrap_or_default();
	}
	Ok(shown.into_iter().next())
}

/// Asks a running application without a window on screen to show one, without
/// activating it ([`ask_for_window`]). A hidden application (`AppleScript`
/// launches them hidden) is unhidden through AX; any other gets Launch
/// Services' reopen event, which needs no Automation consent. On a macOS 26.5
/// VM both showed the window of Contacts, Notes, `TextEdit`, Calendar and Font
/// Book in 0.1–0.4 s, and no application came to the front. `false` when
/// neither could be requested.
fn show_in_background(pid: u32, path: &str, relaunched: &mut dyn FnMut(Application)) -> bool {
	let Ok(pid) = libc::pid_t::try_from(pid) else {
		return false;
	};
	// SAFETY: AXUIElementCreateApplication accepts any process id.
	let app = unsafe { AXUIElement::new_application(pid) };
	let hidden = CFString::from_static_str("AXHidden");
	let mut value: *const CFType = ptr::null();
	// SAFETY: `value` is writable and receives a +1 CF object on success.
	let read = unsafe { app.copy_attribute_value(&hidden, NonNull::from(&mut value)) };
	// SAFETY: A successful copy transfers one retained object to the caller.
	let is_hidden = (read == AXError::Success)
		.then(|| NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) }))
		.flatten()
		.and_then(|value| value.downcast::<CFBoolean>().ok())
		.is_some_and(|value| value.as_bool());
	ask_for_window(
		is_hidden,
		// SAFETY: The retained element, attribute name and singleton CFBoolean
		// stay valid for the synchronous setter.
		|| unsafe { app.set_attribute_value(&hidden, CFBoolean::new(false)) == AXError::Success },
		|| has_open_window(pid) != Some(false),
		// A window elsewhere that cannot be ruled out counts.
		|| window_on_another_space(pid) != Some(false),
		|| launch(path, false).map(&mut *relaunched).is_ok(),
	)
}

/// Asks for a window: a `hidden` application is unhidden through `unhide`,
/// which shows only the windows it still has open (`open_window`); one whose
/// last window was closed, or whose windows are all minimized, also gets the
/// reopen event (`reopen`), as an application that is not hidden does. One
/// with a window on another Space (`elsewhere`), which on-screen window lists
/// leave out, already has a window: the reopen event would only risk
/// bringing it to the front, so `false`.
fn ask_for_window(
	hidden: bool,
	unhide: impl FnOnce() -> bool,
	open_window: impl FnOnce() -> bool,
	elsewhere: impl FnOnce() -> bool,
	reopen: impl FnOnce() -> bool,
) -> bool {
	if hidden {
		if !unhide() {
			return false;
		}
		if open_window() {
			return true;
		}
	}
	if elsewhere() {
		return false;
	}
	reopen()
}

/// One poll of [`first_window`]'s wait for an application's first window.
fn poll_window() -> CoreResult<()> {
	control::check()?;
	std::thread::sleep(FIRST_WINDOW_POLL);
	Ok(())
}

fn launch(path: &str, activate: bool) -> CoreResult<Application> {
	autoreleasepool(|_| {
		// Validate explicit paths as bundles, never as shell commands or
		// arbitrary document URLs. NSWorkspace applies Launch Services
		// policy/Gatekeeper.
		let app = read_bundle(Path::new(path))?;
		let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&app.path), true);
		let configuration = open_configuration(activate);
		launch_services("the application", |completion| {
			NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
				&url,
				&configuration,
				Some(completion),
			);
		})
	})
}

/// Opens the file, folder or URL `target` in `app`, or else its default
/// application, and returns that application with the window showing it, as
/// [`open`] does. Without `activate`, Launch Services opens it behind the
/// user's app. `reveal` instead shows the file or folder selected in Finder,
/// which `NSWorkspace` always brings to the front.
pub(super) fn open_document(
	target: &str,
	app: Option<Application>,
	reveal: bool,
	activate: bool,
) -> CoreResult<OpenedApplication> {
	// The titles on screen just before the open, to see which window changes.
	let mut before = HashMap::new();
	let opened = autoreleasepool(|_| {
		let url = document_url(target, reveal)?;
		let workspace = NSWorkspace::sharedWorkspace();
		let urls = NSArray::from_retained_slice(std::slice::from_ref(&url));
		if reveal {
			workspace.activateFileViewerSelectingURLs(&urls);
			// The call reports nothing back, and a Finder that was not running
			// starts after it returns.
			return wait_for(FINDER_LAUNCH_WAIT, || autoreleasepool(|_| finder()), poll_window)?
				.ok_or_else(|| {
					DesktopError::internal("Finder did not start after revealing the item")
				});
		}
		let application = match &app {
			Some(app) => NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&app.path), true),
			None => workspace.URLForApplicationToOpenURL(&url).ok_or_else(|| {
				DesktopError::invalid_target(format!("no application opens {target:?}"))
			})?,
		};
		before = window_titles().unwrap_or_default();
		let configuration = open_configuration(activate);
		launch_services(target, |completion| {
			workspace.openURLs_withApplicationAtURL_configuration_completionHandler(
				&urls,
				&application,
				&configuration,
				Some(completion),
			);
		})
	})?;
	let path = document_path(target, reveal);
	let window = match opened.pid {
		// Finder's window titled with the revealed item's folder.
		Some(pid) if reveal => {
			let name = shown_name(path.as_deref(), reveal);
			first_window(
				false,
				FIRST_WINDOW_WAIT,
				|| key_capable_windows(pid).map(|windows| showing(windows, name.as_deref())),
				|| false,
				|| false,
				poll_window,
			)?
		},
		Some(pid) => shown_window(
			FIRST_WINDOW_WAIT,
			&path.as_deref().map_or_default(item_names),
			&before,
			|| key_capable_windows(pid),
			is_standard_window,
			poll_window,
		)?,
		None => None,
	};
	Ok(OpenedApplication::new(opened, window))
}

/// The title of the window that shows `path`: its name, or for `reveal` its
/// folder's. `None` for a URL.
fn shown_name(path: Option<&Path>, reveal: bool) -> Option<String> {
	let shown = if reveal { path?.parent() } else { path };
	shown
		.and_then(Path::file_name)
		.map(|name| name.to_string_lossy().into_owned())
}

/// The `windows` whose title names the opened item (`name`): all of them for a
/// URL, or when no title can be read (without Screen Recording other apps'
/// titles are empty), since nothing then tells the windows apart.
fn showing(windows: Vec<DesktopWindow>, name: Option<&str>) -> Vec<DesktopWindow> {
	match name {
		Some(name) if windows.iter().any(|window| !window.title.is_empty()) => windows
			.into_iter()
			.filter(|window| title_names(&window.title, name))
			.collect(),
		_ => windows,
	}
}

/// The names a window showing the file or folder at `path` can be titled
/// with: its file name, and the name Finder shows when that differs (Pages
/// titles `Budget.pages`, its extension hidden, as "Budget"). A root has no
/// file name, so its Finder display name is the primary name.
fn item_names(path: &Path) -> Vec<String> {
	let mut names: Vec<String> = path
		.file_name()
		.map(|name| name.to_string_lossy().into_owned())
		.into_iter()
		.collect();
	if let Some(path) = path.to_str() {
		let shown = autoreleasepool(|_| {
			NSFileManager::defaultManager()
				.displayNameAtPath(&NSString::from_str(path))
				.to_string()
		});
		if !shown.is_empty() && names.first() != Some(&shown) {
			names.push(shown);
		}
	}
	names
}

/// The window of the application that opened a file or URL which shows it,
/// given until `timeout`. A window titled with the file name shows it at
/// once; a display-name alias must belong to a new or changed window. The
/// frontmost window is returned when no title can be read. A browser shows
/// a page in an existing window whose title changes, or a new document
/// window (not an Open dialog when AX can classify it), so either is a
/// candidate, returned once its title has held for [`SETTLE_POLLS`] polls, or
/// at `timeout` with whatever it changed to. For a URL (no `names`) the
/// frontmost window is returned at `timeout` if none changed, as for a page
/// that kept the old tab's title; for a file, none is.
fn shown_window(
	timeout: Duration,
	names: &[String],
	before: &HashMap<String, String>,
	mut windows: impl FnMut() -> Option<Vec<DesktopWindow>>,
	mut classify: impl FnMut(&DesktopWindow) -> Option<bool>,
	mut wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<Option<DesktopWindow>> {
	let deadline = Instant::now() + timeout;
	let Some(mut shown) = windows() else {
		return Ok(None);
	};
	// The first title of each window that opened since, to see it change.
	let mut first_titles = HashMap::new();
	// A window's AX role does not change while it waits: ask once per window.
	let mut kinds = HashMap::new();
	let mut is_document = |window: &DesktopWindow| {
		*kinds
			.entry(window.id.clone())
			.or_insert_with(|| classify(window))
	};
	// The window that changed, and for how many more polls it kept its title.
	let mut changed: Option<(DesktopWindow, u32)> = None;
	loop {
		if !shown.is_empty() && shown.iter().all(|window| window.title.is_empty()) {
			return Ok(shown.into_iter().next());
		}
		if let Some(window) = shown.iter().find(|window| {
			names.iter().enumerate().any(|(index, name)| {
				title_names(&window.title, name)
					&& (index == 0 || before.get(&window.id) != Some(&window.title))
			})
		}) {
			return Ok(Some(window.clone()));
		}
		changed = match (
			changed_window(&shown, names.is_empty(), before, &mut first_titles, &mut is_document),
			changed,
		) {
			(Some(window), Some((held, polls)))
				if held.id == window.id && held.title == window.title =>
			{
				if polls + 1 >= SETTLE_POLLS {
					return Ok(Some(window));
				}
				Some((window, polls + 1))
			},
			(window, _) => window.map(|window| (window, 0)),
		};
		if Instant::now() >= deadline {
			return Ok(match changed {
				Some((window, _)) => Some(window),
				None if names.is_empty() => shown.into_iter().next(),
				None => None,
			});
		}
		wait()?;
		shown = windows().unwrap_or_default();
	}
}

/// The first window whose title changed, or a new URL or document window.
/// Without Accessibility, a new identity is the available evidence; otherwise
/// other new windows must change title, so an unchanged Open dialog does not
/// count.
/// An unknown AX role leaves a new identity eligible, but does not prove key
/// capability: without AX a Quartz compositor surface cannot be ruled out.
fn changed_window(
	windows: &[DesktopWindow],
	url: bool,
	before: &HashMap<String, String>,
	first_titles: &mut HashMap<String, String>,
	is_document: &mut impl FnMut(&DesktopWindow) -> Option<bool>,
) -> Option<DesktopWindow> {
	let mut changed = None;
	for window in windows {
		let was: Option<&str> = match before.get(&window.id) {
			Some(title) => Some(title),
			None if url || is_document(window).unwrap_or(true) => None,
			None => Some(
				first_titles
					.entry(window.id.clone())
					.or_insert_with(|| window.title.clone()),
			),
		};
		if changed.is_none() && was.is_none_or(|was| was != window.title) {
			changed = Some(window.clone());
		}
	}
	changed
}

/// Whether `title` names `name` as a whole part, as in `notes.txt`,
/// `notes.txt — Edited` or `Preview: notes.txt`, never inside a longer name
/// (`data.txt` does not name `a.txt`, nor `a.txt.bak`).
fn title_names(title: &str, name: &str) -> bool {
	let edge =
		|c: Option<char>| c.is_none_or(|c| c.is_whitespace() || "—–()[]{}\"'“”‘’«»:,|".contains(c));
	title.match_indices(name).any(|(at, _)| {
		edge(title[..at].chars().next_back()) && edge(title[at + name.len()..].chars().next())
	})
}

/// The absolute path of an existing `target`, naming the entry itself: a
/// symlink stays the link, so Finder selects the entry the caller named
/// rather than what it points to. To reveal, a link whose target is gone
/// counts too, since Finder still shows and selects it.
fn document_path(target: &str, reveal: bool) -> Option<PathBuf> {
	let path = Path::new(target);
	let exists = if reveal {
		path.symlink_metadata().is_ok()
	} else {
		path.exists()
	};
	if exists {
		std::path::absolute(path).ok()
	} else {
		None
	}
}

/// The URL [`open_document`] opens: an existing file or folder, or, unless
/// revealing, a URL with a scheme.
fn document_url(target: &str, reveal: bool) -> CoreResult<Retained<NSURL>> {
	if let Some(path) = document_path(target, reveal) {
		let path = path
			.to_str()
			.ok_or_else(|| DesktopError::invalid_target(format!("{target:?} is not valid UTF-8")))?;
		return Ok(NSURL::fileURLWithPath(&NSString::from_str(path)));
	}
	if !reveal && super::url_scheme(target).is_some() {
		return NSURL::URLWithString(&NSString::from_str(target))
			.ok_or_else(|| DesktopError::invalid_target(format!("{target:?} is not a valid URL")));
	}
	Err(DesktopError::invalid_target(if reveal {
		format!("cannot find {target:?}; reveal shows an existing file or folder")
	} else {
		format!(
			"cannot find {target:?}; apps.open opens an application, an existing file or folder, or \
			 a URL"
		)
	}))
}

/// Polls `find` until it returns a value or `timeout` passes, calling `wait`
/// between polls.
fn wait_for<T>(
	timeout: Duration,
	mut find: impl FnMut() -> Option<T>,
	mut wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<Option<T>> {
	let deadline = Instant::now() + timeout;
	loop {
		if let Some(found) = find() {
			return Ok(Some(found));
		}
		if Instant::now() >= deadline {
			return Ok(None);
		}
		wait()?;
	}
}

/// Finder, which `activateFileViewerSelectingURLs` reveals items in, if it is
/// running.
fn finder() -> Option<Application> {
	NSRunningApplication::runningApplicationsWithBundleIdentifier(ns_string!("com.apple.finder"))
		.firstObject()
		.and_then(|running| running_application(&running))
}

/// Launch Services options shared by every `apps.open` launch: no new
/// instance, recent-items entry or prompt, and activation only when asked.
fn open_configuration(activate: bool) -> Retained<NSWorkspaceOpenConfiguration> {
	let configuration = NSWorkspaceOpenConfiguration::configuration();
	configuration.setActivates(activate);
	configuration.setCreatesNewApplicationInstance(false);
	configuration.setAddsToRecentItems(false);
	configuration.setPromptsUserIfNeeded(false);
	configuration
}

type LaunchCompletion = DynBlock<dyn Fn(*mut NSRunningApplication, *mut NSError)>;

/// Waits up to 30 seconds for the Launch Services request `start` makes with
/// the completion handler it is given, and returns the application that
/// opened `what`.
fn launch_services(what: &str, start: impl FnOnce(&LaunchCompletion)) -> CoreResult<Application> {
	let (sender, receiver) = flume::bounded(1);
	let subject = what.to_owned();
	let completion: RcBlock<dyn Fn(*mut NSRunningApplication, *mut NSError)> =
		RcBlock::new(move |running: *mut NSRunningApplication, error: *mut NSError| {
			// SAFETY: AppKit supplies borrowed live objects for this callback.
			// Only owned Rust values leave the callback; pointers
			// are never retained.
			let result = unsafe {
				if let Some(error) = error.as_ref() {
					let domain = error.domain().to_string();
					let message = format!(
						"Launch Services could not open {} ({} {}): {}",
						subject,
						domain,
						error.code(),
						error.localizedDescription(),
					);
					Err(
						if (domain == "NSCocoaErrorDomain" && matches!(error.code(), 257 | 513))
							|| (domain == "NSOSStatusErrorDomain" && matches!(error.code(), -54 | -5000))
						{
							DesktopError::permission_denied(message)
						} else {
							DesktopError::input_failed(message)
						},
					)
				} else if let Some(running) = running.as_ref() {
					running_application(running).ok_or_else(|| {
						DesktopError::invalid_target(
							"Launch Services returned an application without a bundle path",
						)
					})
				} else {
					Err(DesktopError::internal(
						"Launch Services returned neither an application nor an error",
					))
				}
			};
			let _ = sender.send(result);
		});
	start(&completion);
	let deadline = Instant::now() + Duration::from_secs(30);
	loop {
		control::check()?;
		let remaining = deadline.saturating_duration_since(Instant::now());
		if remaining.is_zero() {
			return Err(DesktopError::timeout(format!(
				"Launch Services did not confirm opening {what} within 30 seconds; it may still open"
			)));
		}
		match receiver.recv_timeout(remaining.min(Duration::from_millis(20))) {
			Ok(result) => return result,
			Err(flume::RecvTimeoutError::Timeout) => {},
			Err(flume::RecvTimeoutError::Disconnected) => {
				return Err(DesktopError::internal("Launch Services completion channel closed"));
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;

	fn window(id: &str) -> DesktopWindow {
		DesktopWindow {
			id:      id.into(),
			title:   String::new(),
			app:     "Contacts".into(),
			pid:     Some(4105),
			x:       0,
			y:       0,
			width:   800,
			height:  600,
			focused: false,
		}
	}

	fn id(found: Option<DesktopWindow>) -> Option<String> {
		found.map(|window| window.id)
	}

	#[test]
	fn a_running_application_without_a_window_is_asked_once_and_its_first_window_returned() {
		// Contacts launched by AppleScript runs hidden: no window comes until
		// it is unhidden, then one appears two polls later.
		let reopened = Cell::new(false);
		let polls = Cell::new(0);
		let found = first_window(
			true,
			Duration::from_secs(60),
			|| {
				polls.update(|v| v + 1);
				Some(if reopened.get() && polls.get() > 2 {
					vec![window("187")]
				} else {
					vec![]
				})
			},
			|| false,
			|| {
				assert!(!reopened.replace(true), "the application is asked once");
				true
			},
			|| Ok(()),
		)
		.expect("first window");
		assert!(reopened.get());
		assert_eq!(id(found).as_deref(), Some("187"));
	}

	#[test]
	fn a_launch_is_awaited_for_its_first_window_without_asking_for_one() {
		let polls = Cell::new(0);
		let found = first_window(
			false,
			Duration::from_secs(60),
			|| {
				polls.update(|v| v + 1);
				Some(if polls.get() > 3 {
					vec![window("90")]
				} else {
					vec![]
				})
			},
			|| false,
			|| panic!("a launch shows its first window itself"),
			|| Ok(()),
		)
		.expect("first window");
		assert_eq!(id(found).as_deref(), Some("90"));
	}

	#[test]
	fn a_shown_window_returns_at_once_and_a_missing_one_only_waits_out_the_bound() {
		let no_reopen = || -> bool { panic!("an application with a window is not asked again") };
		let no_wait = || -> CoreResult<()> { panic!("no poll interval is slept") };
		let unlisted = || false;
		// The frontmost of the application's windows, without waiting.
		let found = first_window(
			true,
			Duration::from_secs(60),
			|| Some(vec![window("12"), window("11")]),
			unlisted,
			no_reopen,
			no_wait,
		);
		assert_eq!(id(found.expect("window")).as_deref(), Some("12"));
		// An application that never shows a window is not awaited past the bound.
		let found =
			first_window(false, Duration::ZERO, || Some(vec![]), unlisted, no_reopen, no_wait);
		assert!(found.expect("no window").is_none());
		// An application that could not be asked brings no window to wait for.
		let found =
			first_window(true, Duration::from_secs(60), || Some(vec![]), unlisted, || false, no_wait);
		assert!(found.expect("no window").is_none());
		// Without a window list there is nothing to decide or return.
		let found =
			first_window(true, Duration::from_secs(60), || None, unlisted, no_reopen, no_wait);
		assert!(found.expect("no window").is_none());
	}

	#[test]
	fn an_application_showing_only_a_window_capture_leaves_out_is_not_asked_for_one() {
		// With Screen Recording granted, a window that does not allow capture
		// is left out of the list, yet it is on screen: asking the application
		// to show a window would send the reopen event for nothing.
		let found = first_window(
			true,
			Duration::from_secs(60),
			|| Some(vec![]),
			|| true,
			|| panic!("an application showing a window is not asked for one"),
			|| panic!("no window is awaited"),
		);
		assert!(found.expect("no window").is_none());
	}

	#[test]
	fn a_hidden_application_with_no_open_window_is_reopened_after_unhiding() {
		// A hidden app whose last window was closed shows nothing when unhidden.
		let reopened = Cell::new(false);
		let reopen = || {
			reopened.set(true);
			true
		};
		let here = || false;
		assert!(ask_for_window(true, || true, || false, here, reopen));
		assert!(reopened.get());
		// One with a window open shows it; the reopen event is not sent.
		reopened.set(false);
		assert!(ask_for_window(true, || true, || true, here, reopen));
		assert!(!reopened.get());
		// An app that is not hidden gets the reopen event at once.
		assert!(ask_for_window(false, || panic!("not hidden"), || panic!("not read"), here, reopen));
		assert!(reopened.get());
	}

	#[test]
	fn an_application_with_a_window_on_another_space_is_not_reopened() {
		// Notes with its only window on another Space shows nothing on screen
		// here, but the reopen event could bring it in front of the user.
		let reopen = || -> bool { panic!("the reopen event was sent") };
		assert!(!ask_for_window(
			false,
			|| panic!("not hidden"),
			|| panic!("not read"),
			|| true,
			reopen
		));
		// Hidden, unhiding shows no window here: the one elsewhere still stands.
		assert!(!ask_for_window(true, || true, || false, || true, reopen));
	}

	#[test]
	fn an_application_that_exited_since_it_was_listed_is_read_as_its_new_process() {
		// Contacts was listed as pid 4105 but quit before apps.open asked it for
		// a window; the reopen event launched it again as 4200.
		let contacts = Application {
			id:      "com.apple.AddressBook".into(),
			name:    "Contacts".into(),
			path:    "/System/Applications/Contacts.app".into(),
			running: true,
			pid:     Some(4105),
		};
		let relaunched = Application { pid: Some(4200), ..contacts.clone() };
		let opened = open_running(
			contacts,
			4105,
			|pid| {
				Some(if pid == 4200 {
					vec![window("187")]
				} else {
					vec![]
				})
			},
			|| false,
			|launched| {
				launched(relaunched);
				true
			},
			|| Ok(()),
		)
		.expect("opened");
		assert_eq!(opened.pid, Some(4200));
		assert_eq!(opened.window.map(|window| window.id).as_deref(), Some("187"));
	}

	#[test]
	fn an_opened_window_is_never_a_compositor_surface() {
		// Chrome's compositor surface 501 sits in front of its window 500 in
		// Quartz's list; only 500 is among its AXWindows.
		let listed = vec![window("501"), window("500")];
		let kept = in_ax_windows(listed.clone(), Some(&[500]));
		assert_eq!(kept.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["500"]);
		// Without accessibility windows nothing is dropped.
		assert_eq!(in_ax_windows(listed, None).len(), 2);
	}

	#[test]
	fn an_opened_document_returns_the_window_titled_with_its_name() {
		let titled = |id: &str, title: &str| DesktopWindow { title: title.into(), ..window(id) };
		// TextEdit launched by a document shows its Open panel first.
		let listed = vec![titled("1", "Open"), titled("2", "notes.txt")];
		let ids = |windows: Vec<DesktopWindow>| windows.into_iter().map(|w| w.id).collect::<Vec<_>>();
		assert_eq!(ids(showing(listed.clone(), Some("notes.txt"))), ["2"]);
		// Until it appears there is none, so the wait goes on.
		assert!(showing(vec![titled("1", "Open")], Some("notes.txt")).is_empty());
		// A URL, or titles nobody can read, leave the frontmost window.
		assert_eq!(ids(showing(listed, None)), ["1", "2"]);
		assert_eq!(ids(showing(vec![window("3"), window("4")], Some("notes.txt"))), ["3", "4"]);
	}

	#[test]
	fn a_window_titled_with_a_longer_name_does_not_show_the_opened_document() {
		let titled = |id: &str, title: &str| DesktopWindow { title: title.into(), ..window(id) };
		let ids = |windows: Vec<DesktopWindow>| windows.into_iter().map(|w| w.id).collect::<Vec<_>>();
		// `data.txt` and `a.txt.bak` were open in front; only `a.txt`'s own
		// window counts.
		let listed = vec![
			titled("1", "data.txt"),
			titled("2", "a.txt.bak — Edited"),
			titled("3", "a.txt — Edited"),
		];
		assert_eq!(ids(showing(listed, Some("a.txt"))), ["3"]);
		assert!(showing(vec![titled("1", "data.txt")], Some("a.txt")).is_empty());
		for title in ["a.txt", "Preview: a.txt", "a.txt (page 1 of 2)", "project | a.txt"] {
			assert!(title_names(title, "a.txt"), "{title}");
		}
	}

	fn titled(id: &str, title: &str) -> DesktopWindow {
		DesktopWindow { title: title.into(), ..window(id) }
	}

	fn titles(windows: &[(&str, &str)]) -> HashMap<String, String> {
		windows
			.iter()
			.map(|(id, title)| ((*id).to_owned(), (*title).to_owned()))
			.collect()
	}

	/// [`shown_window`] for an item titled `names`, over `polls`: one window
	/// list per poll, the last repeating. The wait gives up after 100 polls
	/// rather than running out the 60 s bound.
	fn shown_after(
		names: &[&str],
		before: &[(&str, &str)],
		polls: &[&[(&str, &str)]],
	) -> Option<(String, String)> {
		let names = names
			.iter()
			.map(|name| (*name).to_owned())
			.collect::<Vec<_>>();
		let poll = Cell::new(0_usize);
		shown_window(
			Duration::from_secs(60),
			&names,
			&titles(before),
			|| {
				let listed = polls[poll.get().min(polls.len() - 1)];
				Some(listed.iter().map(|(id, title)| titled(id, title)).collect())
			},
			|window| Some(window.title != "Open"),
			|| {
				poll.set(poll.get() + 1);
				assert!(poll.get() < 100, "the window never settled");
				Ok(())
			},
		)
		.expect("no failure")
		.map(|window| (window.id, window.title))
	}

	#[test]
	fn a_new_file_window_settles_without_accessibility_even_with_its_final_first_title() {
		let polls = Cell::new(0);
		let found = shown_window(
			Duration::from_secs(60),
			&["page.html".to_owned()],
			&titles(&[]),
			|| Some(vec![titled("7", "The page title")]),
			|_| None,
			|| {
				polls.set(polls.get() + 1);
				assert!(polls.get() <= SETTLE_POLLS, "the new window never settled");
				Ok(())
			},
		)
		.expect("no failure");
		assert_eq!(id(found).as_deref(), Some("7"));
		assert_eq!(polls.get(), SETTLE_POLLS);
	}

	#[test]
	fn a_display_name_in_an_unchanged_window_waits_for_the_opened_file() {
		assert_eq!(
			shown_after(&["Budget.pages", "Budget"], &[("1", "Annual Budget")], &[
				&[("1", "Annual Budget")],
				&[("1", "Annual Budget"), ("2", "Budget")],
			],),
			shown("2", "Budget")
		);
		assert_eq!(
			shown_after(&["Budget.pages", "Budget"], &[("1", "Annual Budget")], &[&[("1", "Budget")]],),
			shown("1", "Budget")
		);
	}

	#[allow(clippy::unnecessary_wraps, reason = "compared with what `shown_after` returns")]
	fn shown(id: &str, title: &str) -> Option<(String, String)> {
		Some((id.into(), title.into()))
	}

	#[test]
	fn a_page_opened_in_a_browser_returns_the_window_it_shows_in_with_its_title() {
		// An HTML file titled `<title>Delta</title>` opened in Chrome's front
		// window never shows its file name.
		let file =
			shown_after(&["d.html"], &[("53", "e.html")], &[&[("53", "e.html")], &[("53", "Delta")]]);
		assert_eq!(file, shown("53", "Delta"));
		// A URL: the window kept the old tab's title, then Safari showed the
		// new tab as "Untitled" for a few polls before the page's own title.
		let mut polls: Vec<&[(&str, &str)]> = vec![&[("91", "Alpha")]];
		polls.extend([&[("91", "Untitled")] as &[_]; SETTLE_POLLS as usize - 1]);
		polls.push(&[("91", "Bravo")]);
		assert_eq!(shown_after(&[], &[("91", "Alpha")], &polls), shown("91", "Bravo"));
		// A hidden window becoming visible keeps its old title longer than
		// the settle period; the all-Space baseline keeps it from counting
		// as newly created before the requested page arrives.
		let mut visible: Vec<&[(&str, &str)]> = vec![&[("91", "Alpha")]; SETTLE_POLLS as usize + 2];
		visible.push(&[("91", "Bravo")]);
		assert_eq!(shown_after(&[], &[("91", "Alpha")], &visible), shown("91", "Bravo"));
		// The page went to the front window, though another one is listed.
		let front = shown_after(&[], &[("62", "New Tab"), ("53", "e.html")], &[&[
			("62", "Charlie"),
			("53", "e.html"),
		]]);
		assert_eq!(front, shown("62", "Charlie"));
	}

	#[test]
	fn a_launched_browser_returns_its_new_window_once_it_shows_the_page() {
		// Chrome was not running: its first window reads "Untitled" until the
		// page has loaded.
		let file = shown_after(&["d.html"], &[("9", "Finder")], &[
			&[],
			&[("71", "Untitled")],
			&[("71", "Untitled")],
			&[("71", "Delta")],
		]);
		assert_eq!(file, shown("71", "Delta"));
		// The page can already have its final title at the very first poll.
		let loaded = shown_after(&["d.html"], &[], &[&[("71", "Delta")]]);
		assert_eq!(loaded, shown("71", "Delta"));
		// For a URL a new window counts at once, already titled with the page.
		let url = shown_after(&[], &[("9", "Finder")], &[&[], &[("101", "Alpha")]]);
		assert_eq!(url, shown("101", "Alpha"));
	}

	#[test]
	fn an_opened_file_is_found_by_its_name_at_once_and_never_as_its_open_panel() {
		let no_wait = || -> CoreResult<()> { panic!("no poll interval is slept") };
		let names = ["Budget.pages".to_owned(), "Budget".to_owned()];
		// Pages titles Budget.pages, its extension hidden, as Finder shows it.
		let pages = shown_window(
			Duration::from_secs(60),
			&names,
			&titles(&[]),
			|| Some(vec![titled("7", "Budget")]),
			|_| Some(true),
			no_wait,
		);
		assert_eq!(
			pages
				.expect("no failure")
				.map(|window| window.id)
				.as_deref(),
			Some("7")
		);
		// TextEdit launched by a document shows its Open panel first.
		let launched = shown_after(&["notes.txt"], &[], &[&[("1", "Open")], &[
			("1", "Open"),
			("2", "notes.txt"),
		]]);
		assert_eq!(launched, shown("2", "notes.txt"));
		// An Open panel left alone at the deadline is not the document.
		let panel = shown_window(
			Duration::ZERO,
			&["notes.txt".to_owned()],
			&titles(&[]),
			|| Some(vec![titled("1", "Open")]),
			|_| Some(false),
			|| Ok(()),
		);
		assert!(panel.expect("no failure").is_none());
		// Titles nobody can read (no Screen Recording) leave the frontmost
		// window at once.
		let unread = shown_window(
			Duration::from_secs(60),
			&["notes.txt".to_owned()],
			&titles(&[("3", ""), ("4", "")]),
			|| Some(vec![window("3"), window("4")]),
			|_| Some(false),
			no_wait,
		);
		assert_eq!(
			unread
				.expect("no failure")
				.map(|window| window.id)
				.as_deref(),
			Some("3")
		);
	}

	#[test]
	fn an_opened_root_folder_keeps_file_semantics() {
		let root = Path::new("/");
		let display_name = autoreleasepool(|_| {
			NSFileManager::defaultManager()
				.displayNameAtPath(&NSString::from_str("/"))
				.to_string()
		});
		assert!(!display_name.is_empty());
		let names = item_names(root);
		assert_eq!(names.first(), Some(&display_name));
		let found = shown_window(
			Duration::from_secs(60),
			&names,
			&titles(&[("1", &display_name)]),
			|| Some(vec![titled("1", &display_name)]),
			|_| Some(true),
			|| -> CoreResult<()> { panic!("an unchanged root folder matches immediately") },
		)
		.expect("no failure");
		assert_eq!(found.map(|window| window.id).as_deref(), Some("1"));
		let unrelated = shown_window(
			Duration::ZERO,
			&names,
			&titles(&[("2", "unrelated")]),
			|| Some(vec![titled("2", "unrelated")]),
			|_| Some(true),
			|| Ok(()),
		)
		.expect("no failure");
		assert!(unrelated.is_none(), "a root folder must not use the URL fallback");
	}

	#[test]
	fn a_url_whose_window_never_changes_returns_the_frontmost_at_the_deadline() {
		let at_deadline = |names: &[String], listed: Vec<DesktopWindow>| {
			shown_window(
				Duration::ZERO,
				names,
				&titles(&[("53", "Alpha")]),
				|| Some(listed.clone()),
				|_| Some(true),
				|| Ok(()),
			)
			.expect("no failure")
			.map(|window| (window.id, window.title))
		};
		// The same page again: the new tab has the old tab's title.
		assert_eq!(at_deadline(&[], vec![titled("53", "Alpha")]), shown("53", "Alpha"));
		// A page still loading at the deadline: its window, as titled then.
		assert_eq!(at_deadline(&[], vec![titled("53", "Untitled")]), shown("53", "Untitled"));
		// A file nothing shows: none.
		assert_eq!(at_deadline(&["d.html".to_owned()], vec![titled("53", "Alpha")]), None);
		// Without a window list there is nothing to return.
		let unlisted =
			shown_window(Duration::ZERO, &[], &titles(&[]), || None, |_| Some(false), || Ok(()));
		assert!(unlisted.expect("no failure").is_none());
	}

	#[test]
	fn waits_for_an_application_that_starts_after_the_request() {
		let mut polls = 0;
		let found = wait_for(
			Duration::from_secs(5),
			|| {
				polls += 1;
				(polls == 3).then_some("Finder")
			},
			|| Ok(()),
		);
		assert_eq!(found.unwrap(), Some("Finder"));
		assert_eq!(polls, 3);
		// One that never starts gives up at the deadline.
		let never = wait_for(
			Duration::from_millis(20),
			|| None::<()>,
			|| {
				std::thread::sleep(Duration::from_millis(5));
				Ok(())
			},
		);
		assert_eq!(never.unwrap(), None);
	}

	#[test]
	fn a_revealed_symlink_is_selected_as_the_link_in_its_own_folder() {
		let root = std::env::temp_dir().join(format!("pi-natives-reveal-{}", std::process::id()));
		let (work, archive) = (root.join("work"), root.join("archive"));
		std::fs::create_dir_all(&work).unwrap();
		std::fs::create_dir_all(&archive).unwrap();
		let original = archive.join("original.pdf");
		std::fs::write(&original, "x").unwrap();
		let link = work.join("link.pdf");
		std::os::unix::fs::symlink(&original, &link).unwrap();
		let url_path = |target: &Path| {
			document_url(target.to_str().unwrap(), true)
				.unwrap()
				.path()
				.unwrap()
				.to_string()
		};
		assert_eq!(url_path(&link), link.to_str().unwrap());
		assert_eq!(
			shown_name(document_path(link.to_str().unwrap(), true).as_deref(), true).as_deref(),
			Some("work")
		);
		// A plain file names itself, and its own name when opened.
		assert_eq!(url_path(&original), original.to_str().unwrap());
		assert_eq!(
			shown_name(document_path(original.to_str().unwrap(), false).as_deref(), false).as_deref(),
			Some("original.pdf")
		);
		assert!(document_path(root.join("missing.pdf").to_str().unwrap(), true).is_none());
		// A link whose target is gone is still an entry Finder selects, though
		// nothing opens it.
		let dangling = work.join("dangling.pdf");
		std::os::unix::fs::symlink(archive.join("gone.pdf"), &dangling).unwrap();
		assert_eq!(url_path(&dangling), dangling.to_str().unwrap());
		assert!(document_path(dangling.to_str().unwrap(), false).is_none());
		std::fs::remove_dir_all(&root).unwrap();
	}
}
