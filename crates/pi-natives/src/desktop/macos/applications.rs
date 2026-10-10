use std::{
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
		macos::application_windows,
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
		let window = first_window(
			true,
			FIRST_WINDOW_WAIT,
			|| application_windows(pid).ok(),
			|| show_in_background(pid, &app.path),
			wait,
		)?;
		return Ok(OpenedApplication { application: app, window });
	}
	let application = launch(&app.path, activate)?;
	let window = match application.pid {
		Some(pid) => {
			first_window(false, FIRST_WINDOW_WAIT, || application_windows(pid).ok(), || false, wait)?
		},
		None => None,
	};
	Ok(OpenedApplication { application, window })
}

/// The application's frontmost window, given until `timeout` to show its
/// first one. With `show`, a running application without a window is asked to
/// show one first; when it cannot be asked, none is awaited. Without a window
/// list (no Screen Recording permission) no window is returned.
fn first_window(
	show: bool,
	timeout: Duration,
	mut windows: impl FnMut() -> Option<Vec<DesktopWindow>>,
	request_window: impl FnOnce() -> bool,
	mut wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<Option<DesktopWindow>> {
	let deadline = Instant::now() + timeout;
	let Some(mut shown) = windows() else {
		return Ok(None);
	};
	if shown.is_empty() && show && !request_window() {
		return Ok(None);
	}
	while shown.is_empty() && Instant::now() < deadline {
		wait()?;
		shown = windows().unwrap_or_default();
	}
	Ok(shown.into_iter().next())
}

/// Asks a running application without a window on screen to show one, without
/// activating it. A hidden application (`AppleScript` launches them hidden) is
/// unhidden through AX; any other gets Launch Services' reopen event, which
/// needs no Automation consent. On a macOS 26.5 VM both showed the window of
/// Contacts, Notes, `TextEdit`, Calendar and Font Book in 0.1–0.4 s, and no
/// application came to the front. `false` when neither could be requested.
fn show_in_background(pid: u32, path: &str) -> bool {
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
	if is_hidden {
		// SAFETY: The retained element, attribute name and singleton CFBoolean
		// stay valid for the synchronous setter.
		unsafe { app.set_attribute_value(&hidden, CFBoolean::new(false)) == AXError::Success }
	} else {
		launch(path, false).is_ok()
	}
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
		// The frontmost of the application's windows, without waiting.
		let found = first_window(
			true,
			Duration::from_secs(60),
			|| Some(vec![window("12"), window("11")]),
			no_reopen,
			no_wait,
		);
		assert_eq!(id(found.expect("window")).as_deref(), Some("12"));
		// An application that never shows a window is not awaited past the bound.
		let found = first_window(false, Duration::ZERO, || Some(vec![]), no_reopen, no_wait);
		assert!(found.expect("no window").is_none());
		// An application that could not be asked brings no window to wait for.
		let found = first_window(true, Duration::from_secs(60), || Some(vec![]), || false, no_wait);
		assert!(found.expect("no window").is_none());
		// Without a window list there is nothing to decide or return.
		let found = first_window(true, Duration::from_secs(60), || None, no_reopen, no_wait);
		assert!(found.expect("no window").is_none());
	}
}
