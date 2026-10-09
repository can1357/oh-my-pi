use std::{
	collections::{HashMap, HashSet},
	ffi::c_void,
	mem::size_of,
	path::{Path, PathBuf},
	ptr,
	time::{Duration, Instant},
};

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSBundle, NSError, NSString, NSURL, ns_string};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
	},
	Application,
};

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

pub(super) fn open(app: Application, activate: bool) -> CoreResult<Application> {
	autoreleasepool(|_| {
		// Validate explicit paths as bundles, never as shell commands or
		// arbitrary document URLs. NSWorkspace applies Launch Services
		// policy/Gatekeeper.
		let app = read_bundle(Path::new(&app.path))?;
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
