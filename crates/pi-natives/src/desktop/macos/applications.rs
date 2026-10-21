use std::{
	cell::RefCell,
	collections::{HashMap, HashSet},
	ffi::c_void,
	mem::size_of,
	path::{Path, PathBuf},
	ptr::{self, NonNull},
	time::{Duration, Instant},
};

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFBoolean, CFRetained, CFString, CFType};
use objc2_foundation::{NSBundle, NSError, NSString, NSURL, ns_string};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
		macos::{
			application_windows, ax_window_ids, has_onscreen_window, has_open_window,
			window_on_another_space,
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
	if !path
		.extension()
		.is_some_and(|extension| extension.as_encoded_bytes().eq_ignore_ascii_case(b"app"))
	{
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

fn running_application(running: &NSRunningApplication) -> Option<Application> {
	let path = running.bundleURL()?.path()?.to_string();
	let path = Path::new(&path)
		.canonicalize()
		.ok()
		.and_then(|path| path.into_os_string().into_string().ok())
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
	let wait = || {
		control::check()?;
		std::thread::sleep(FIRST_WINDOW_POLL);
		Ok(())
	};
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

fn launch(path: &str, activate: bool) -> CoreResult<Application> {
	autoreleasepool(|_| {
		// Validate explicit paths as bundles, never as shell commands or
		// arbitrary document URLs. NSWorkspace applies Launch Services
		// policy/Gatekeeper.
		let app = read_bundle(Path::new(path))?;
		let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&app.path), true);
		let configuration = NSWorkspaceOpenConfiguration::configuration();
		configuration.setActivates(activate);
		configuration.setCreatesNewApplicationInstance(false);
		configuration.setAddsToRecentItems(false);
		configuration.setPromptsUserIfNeeded(false);
		let (sender, receiver) = flume::bounded(1);
		let completion =
			RcBlock::new(move |running: *mut NSRunningApplication, error: *mut NSError| {
				// SAFETY: AppKit supplies borrowed live objects for this callback.
				// Only owned Rust values leave the callback; pointers
				// are never retained.
				let result = unsafe {
					if let Some(error) = error.as_ref() {
						let domain = error.domain().to_string();
						let message = format!(
							"Launch Services could not open the application ({} {}): {}",
							domain,
							error.code(),
							error.localizedDescription(),
						);
						Err(
							if (domain == "NSCocoaErrorDomain" && matches!(error.code(), 257 | 513))
								|| (domain == "NSOSStatusErrorDomain"
									&& matches!(error.code(), -54 | -5000))
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
		NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
			&url,
			&configuration,
			Some(&completion),
		);
		let deadline = Instant::now() + Duration::from_secs(30);
		loop {
			control::check()?;
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Err(DesktopError::timeout(
					"Launch Services did not confirm launch within 30 seconds; the application may \
					 still launch",
				));
			}
			match receiver.recv_timeout(remaining.min(Duration::from_millis(20))) {
				Ok(result) => return result,
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => {
					return Err(DesktopError::internal("Launch Services completion channel closed"));
				},
			}
		}
	})
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
				polls.set(polls.get() + 1);
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
				polls.set(polls.get() + 1);
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
}
