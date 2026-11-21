//! macOS: `open` through `NSWorkspace`.
//!
//! `NSWorkspace` carries everything `open` documents except what Launch
//! Services only takes through its private interface: `-F`, the header search
//! (`-h`, `-H`, `-s`), `--stdin`/`--stdout`/`--stderr` and `--arch`. A request
//! using one of those runs `/usr/bin/open`, with the operands this shell
//! resolved.
//!
//! An application launched here gets the shell's exported environment, as one
//! launched by `open` gets its caller's.

use std::{
	collections::HashMap,
	ffi::c_void,
	io,
	os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd},
	process::Stdio,
	ptr,
	sync::mpsc,
	time::Duration,
};

use block2::{DynBlock, RcBlock};
use objc2::rc::{Retained, autoreleasepool};
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSString, NSURL, ns_string};

use super::{CANCELLED_STATUS, Opener, Request, Target};
use crate::{host::Host, openfile::Fd};

/// How often a wait looks for the shell's cancellation.
const POLL: Duration = Duration::from_millis(50);

const SYSTEM_OPEN: &str = "/usr/bin/open";

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
	/// Launch Services' default application for a uniform type identifier: a
	/// `CFURLRef` the caller owns (toll-free bridged to `NSURL`), or null.
	fn LSCopyDefaultApplicationURLForContentType(
		content_type: *const NSString,
		roles: u32,
		error: *mut *mut c_void,
	) -> *mut NSURL;
}

/// `kLSRolesAll`.
const LS_ROLES_ALL: u32 = u32::MAX;

/// Carries out `request`, reporting failures on the command's stderr, and
/// returns the exit status.
pub(super) fn run(request: &Request, host: &mut Host) -> i32 {
	if request.header.is_some()
		|| request.fresh
		|| request.arch.is_some()
		|| request.stdio.iter().any(Option::is_some)
	{
		return system_open(request, host);
	}
	autoreleasepool(|_| workspace_open(request, host))
}

fn workspace_open(request: &Request, host: &mut Host) -> i32 {
	let workspace = NSWorkspace::sharedWorkspace();
	let application = match application(&workspace, &request.opener, host) {
		Ok(application) => application,
		Err(message) => return super::fail(host, message, 1),
	};
	let mut urls = Vec::with_capacity(request.targets.len());
	for target in &request.targets {
		let Some(url) = url(target) else {
			return super::fail(host, format!("Unable to interpret '{target}' as a URL"), 1);
		};
		urls.push(url);
	}
	if request.reveal {
		workspace.activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&urls));
		return 0;
	}
	let configuration = configuration(request, host);
	let mut pids = Vec::new();
	let mut status = 0;
	let mut settle = |host: &mut Host,
	                  what: &dyn std::fmt::Display,
	                  launched: Result<libc::pid_t, Failure>| match launched {
		Ok(pid) => {
			pids.push(pid);
			true
		},
		Err(Failure::Cancelled) => false,
		Err(Failure::Refused(reason)) => {
			host.error(format!("{what}: {reason}"), 1);
			status = 1;
			true
		},
	};
	match &application {
		Some(application) => {
			let launched = launch(host, |completion| {
				if urls.is_empty() {
					workspace.openApplicationAtURL_configuration_completionHandler(
						application,
						&configuration,
						Some(completion),
					);
				} else {
					workspace.openURLs_withApplicationAtURL_configuration_completionHandler(
						&NSArray::from_retained_slice(&urls),
						application,
						&configuration,
						Some(completion),
					);
				}
			});
			let name = application.path().map(|path| path.to_string()).unwrap_or_default();
			if !settle(host, &name, launched) {
				return CANCELLED_STATUS;
			}
		},
		None => {
			for (target, url) in request.targets.iter().zip(&urls) {
				let launched = launch(host, |completion| {
					workspace.openURL_configuration_completionHandler(
						url,
						&configuration,
						Some(completion),
					);
				});
				if !settle(host, target, launched) {
					return CANCELLED_STATUS;
				}
			}
		},
	}
	if request.wait {
		match wait_for_exit(host, &mut pids) {
			Ok(true) => {},
			Ok(false) => return CANCELLED_STATUS,
			Err(err) => return super::fail(host, format!("Unable to block on applications: {err}"), 1),
		}
	}
	status
}

/// The application `opener` names; `None` leaves each target to its default.
fn application(
	workspace: &NSWorkspace,
	opener: &Opener,
	host: &Host,
) -> Result<Option<Retained<NSURL>>, String> {
	let text_edit = || workspace.URLForApplicationWithBundleIdentifier(ns_string!("com.apple.TextEdit"));
	let found = match opener {
		Opener::Default => return Ok(None),
		Opener::Named(name) => named_application(workspace, name, host)
			.ok_or_else(|| format!("Unable to find application named '{name}'"))?,
		Opener::Bundle(id) => workspace
			.URLForApplicationWithBundleIdentifier(&NSString::from_str(id))
			.ok_or_else(|| format!("Unable to find application with bundle identifier '{id}'"))?,
		Opener::TextEdit => text_edit().ok_or("Unable to find TextEdit")?,
		Opener::TextEditor => default_text_editor()
			.or_else(text_edit)
			.ok_or("Unable to find a text editor")?,
	};
	Ok(Some(found))
}

/// `-a`: a path to an application bundle, else an application Launch Services
/// knows by that name (with or without `.app`).
fn named_application(workspace: &NSWorkspace, name: &str, host: &Host) -> Option<Retained<NSURL>> {
	if name.contains('/') || name.ends_with(".app") {
		let path = host.resolve(name);
		if path.exists() {
			return Some(NSURL::fileURLWithPath_isDirectory(
				&NSString::from_str(&path.to_string_lossy()),
				true,
			));
		}
	}
	// `open` itself looks names up with this selector; its replacements take
	// only bundle identifiers.
	#[allow(deprecated, reason = "the only by-name application lookup AppKit offers")]
	let path = workspace.fullPathForApplication(&NSString::from_str(name))?;
	Some(NSURL::fileURLWithPath_isDirectory(&path, true))
}

/// `-t`: the application Launch Services opens plain text with.
fn default_text_editor() -> Option<Retained<NSURL>> {
	// SAFETY: the content type is a live `NSString` (a `CFString`), the error
	// out-pointer may be null, and the result is an owned `CFURL` or null.
	unsafe {
		let url = LSCopyDefaultApplicationURLForContentType(
			ns_string!("public.plain-text"),
			LS_ROLES_ALL,
			ptr::null_mut(),
		);
		Retained::from_raw(url)
	}
}

fn url(target: &Target) -> Option<Retained<NSURL>> {
	match target {
		Target::File(path) => Some(NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))),
		Target::Url(url) => NSURL::URLWithString(&NSString::from_str(url)),
	}
}

/// The launch options of `request`: `-g`, `-j`, `-n`, `--args`, and the
/// shell's exported environment with `--env`'s additions.
fn configuration(request: &Request, host: &Host) -> Retained<NSWorkspaceOpenConfiguration> {
	let configuration = NSWorkspaceOpenConfiguration::configuration();
	configuration.setActivates(!request.background);
	configuration.setHides(request.hide);
	configuration.setCreatesNewApplicationInstance(request.new_instance);
	if !request.args.is_empty() {
		let arguments: Vec<_> = request.args.iter().map(|arg| NSString::from_str(arg)).collect();
		configuration.setArguments(&NSArray::from_retained_slice(&arguments));
	}
	let mut environment: HashMap<&str, &str> = host.env().collect();
	environment.extend(request.env.iter().map(|(name, value)| (name.as_str(), value.as_str())));
	let names: Vec<_> = environment.keys().map(|name| NSString::from_str(name)).collect();
	let names: Vec<&NSString> = names.iter().map(|name| &**name).collect();
	let values: Vec<_> = environment.values().map(|value| NSString::from_str(value)).collect();
	configuration.setEnvironment(&NSDictionary::from_retained_objects(&names, &values));
	configuration
}

/// Why a launch did not report an application.
enum Failure {
	/// The shell cancelled the command while Launch Services was working.
	Cancelled,
	/// Launch Services' own reason.
	Refused(String),
}

type Completion = DynBlock<dyn Fn(*mut NSRunningApplication, *mut NSError)>;

/// Makes the Launch Services request `start` hands its completion handler to
/// and waits for the answer: the process ID of the application that opened
/// (or already had open) what was asked.
fn launch(host: &Host, start: impl FnOnce(&Completion)) -> Result<libc::pid_t, Failure> {
	let (sender, receiver) = mpsc::sync_channel(1);
	let completion: RcBlock<dyn Fn(*mut NSRunningApplication, *mut NSError)> =
		RcBlock::new(move |running: *mut NSRunningApplication, error: *mut NSError| {
			// SAFETY: AppKit passes live objects, or null, for the duration of the
			// callback; only owned values leave it.
			let outcome = unsafe {
				match (error.as_ref(), running.as_ref()) {
					(Some(error), _) => Err(format!(
						"{} ({} {})",
						error.localizedDescription(),
						error.domain(),
						error.code()
					)),
					(None, Some(running)) => Ok(running.processIdentifier()),
					(None, None) => Err("Launch Services reported neither an application nor an error".to_owned()),
				}
			};
			let _ = sender.try_send(outcome);
		});
	start(&completion);
	loop {
		match receiver.recv_timeout(POLL) {
			Ok(outcome) => return outcome.map_err(Failure::Refused),
			Err(mpsc::RecvTimeoutError::Timeout) if host.is_cancelled() => return Err(Failure::Cancelled),
			Err(mpsc::RecvTimeoutError::Timeout) => {},
			Err(mpsc::RecvTimeoutError::Disconnected) => {
				return Err(Failure::Refused("Launch Services dropped the request".to_owned()));
			},
		}
	}
}

/// `-W`: blocks until every process in `pids` has exited. `Ok(false)` once the
/// shell cancels the command.
fn wait_for_exit(host: &Host, pids: &mut Vec<libc::pid_t>) -> io::Result<bool> {
	pids.retain(|&pid| pid > 0);
	pids.sort_unstable();
	pids.dedup();
	// SAFETY: `kqueue` takes no arguments; a non-negative result is a new
	// descriptor this function owns.
	let queue = unsafe {
		let queue = libc::kqueue();
		if queue < 0 {
			return Err(io::Error::last_os_error());
		}
		OwnedFd::from_raw_fd(queue)
	};
	let mut running = 0usize;
	for &pid in pids.iter() {
		let watch = libc::kevent {
			ident:  pid as usize,
			filter: libc::EVFILT_PROC,
			flags:  libc::EV_ADD | libc::EV_ONESHOT,
			fflags: libc::NOTE_EXIT,
			data:   0,
			udata:  ptr::null_mut(),
		};
		// SAFETY: one initialized change record, no event buffer.
		let added =
			unsafe { libc::kevent(queue.as_raw_fd(), &raw const watch, 1, ptr::null_mut(), 0, ptr::null()) };
		// A process that already exited (`ESRCH`) needs no waiting for.
		if added == 0 {
			running += 1;
		}
	}
	let slice = libc::timespec { tv_sec: 0, tv_nsec: POLL.subsec_nanos().into() };
	while running > 0 {
		if host.is_cancelled() {
			return Ok(false);
		}
		let mut exited = libc::kevent {
			ident:  0,
			filter: 0,
			flags:  0,
			fflags: 0,
			data:   0,
			udata:  ptr::null_mut(),
		};
		// SAFETY: no changes, one writable event record, a live timeout.
		let events = unsafe {
			libc::kevent(queue.as_raw_fd(), ptr::null(), 0, &raw mut exited, 1, &raw const slice)
		};
		match events {
			0 => {},
			1.. => running -= 1,
			_ => {
				let err = io::Error::last_os_error();
				if err.kind() != io::ErrorKind::Interrupted {
					return Err(err);
				}
			},
		}
	}
	Ok(true)
}

#[cfg(test)]
mod tests {
	use std::{fs, os::unix::fs::PermissionsExt as _, path::Path};

	use super::super::run_open;

	/// A background-only application whose program waits a second, then
	/// writes its arguments and `$PROBE_EXTRA` to `$PROBE_OUT`.
	fn probe_application(dir: &Path) -> std::path::PathBuf {
		let app = dir.join("Probe.app");
		let programs = app.join("Contents/MacOS");
		fs::create_dir_all(&programs).expect("bundle");
		fs::write(
			app.join("Contents/Info.plist"),
			format!(
				r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>dev.omp.open-test.p{}</string>
<key>CFBundleName</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
"#,
				std::process::id()
			),
		)
		.expect("Info.plist");
		let program = programs.join("probe");
		fs::write(
			&program,
			"#!/bin/sh\nsleep 1\n{ printf '%s\\n' \"$@\"; printf '%s\\n' \"$PROBE_EXTRA\" \"$PROBE_SHELL\"; } > \"$PROBE_OUT\"\n",
		)
		.expect("program");
		fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).expect("chmod");
		app
	}

	/// Failure mode: the application starts without its `--args`, `--env` or
	/// the shell's exported variables, or `-W` returns before it has exited.
	#[test]
	#[ignore = "launches an application through Launch Services: needs a GUI login session"]
	fn an_application_gets_its_arguments_and_environment_and_is_waited_for() {
		let dir = tempfile::tempdir().expect("tempdir");
		let dir = dir.path().canonicalize().expect("canonical tempdir");
		let app = probe_application(&dir);
		let out = dir.join("out.txt");
		let (code, err) = run_open(
			&[
				"-n",
				"-g",
				"-W",
				"-a",
				app.to_str().expect("utf-8 path"),
				"--env",
				&format!("PROBE_OUT={}", out.display()),
				"--env",
				"PROBE_EXTRA=from --env",
				"--args",
				"one",
				"two words",
				"-n",
			],
			&[("PROBE_SHELL", "from the shell"), ("PROBE_EXTRA", "overridden")],
			&dir,
		);
		assert_eq!((code, err.as_str()), (0, ""));
		// The program writes only after a second: the file exists because `-W` waited.
		assert_eq!(
			fs::read_to_string(&out).expect("probe output"),
			"one\ntwo words\n-n\nfrom --env\nfrom the shell\n"
		);
	}

	/// Failure mode: a mistyped application name launches something else, or
	/// nothing, and still succeeds.
	#[test]
	fn an_unknown_application_is_reported() {
		let (code, err) = run_open(&["-a", "No Such Application 5f3a", "/"], &[], Path::new("/"));
		assert_eq!((code, err.as_str()), (1, "open: Unable to find application named 'No Such Application 5f3a'\n"));
		let (code, err) = run_open(&["-b", "dev.omp.no-such-bundle-5f3a"], &[], Path::new("/"));
		assert_eq!(
			(code, err.as_str()),
			(1, "open: Unable to find application with bundle identifier 'dev.omp.no-such-bundle-5f3a'\n")
		);
	}
}

/// Runs `/usr/bin/open` for `request` in the shell's working directory and
/// environment, wired to the command's standard streams.
fn system_open(request: &Request, host: &mut Host) -> i32 {
	let env = host.child_env();
	let mut command = match env.command(SYSTEM_OPEN) {
		Ok(command) => command,
		Err(err) => return super::fail(host, format!("{SYSTEM_OPEN}: {err}"), 1),
	};
	match &request.opener {
		Opener::Default => {},
		Opener::Named(name) => {
			command.arg("-a").arg(name);
		},
		Opener::Bundle(id) => {
			command.arg("-b").arg(id);
		},
		Opener::TextEdit => {
			command.arg("-e");
		},
		Opener::TextEditor => {
			command.arg("-t");
		},
	}
	for (flag, set) in [
		("-F", request.fresh),
		("-W", request.wait),
		("-R", request.reveal),
		("-n", request.new_instance),
		("-g", request.background),
		("-j", request.hide),
	] {
		if set {
			command.arg(flag);
		}
	}
	if let Some(arch) = &request.arch {
		command.arg("--arch").arg(arch);
	}
	for (flag, path) in ["--stdin", "--stdout", "--stderr"].into_iter().zip(&request.stdio) {
		if let Some(path) = path {
			command.arg(flag).arg(path);
		}
	}
	for (name, value) in &request.env {
		command.arg("--env").arg(format!("{name}={value}"));
	}
	if let Some(header) = &request.header {
		command.arg(if header.all { "-H" } else { "-h" });
		if let Some(sdk) = &header.sdk {
			command.arg("-s").arg(sdk);
		}
		command.args(&header.names);
	}
	for target in &request.targets {
		match target {
			Target::File(path) => command.arg(path),
			Target::Url(url) => command.arg("-u").arg(url),
		};
	}
	if !request.args.is_empty() {
		command.arg("--args").args(&request.args);
	}
	// The header search asks which of several matches to open.
	let stdin = match host.stdin.file().to_fd() {
		Ok(Fd::File(file)) => Stdio::from(file),
		_ => Stdio::null(),
	};
	let mut child = match command.stdin(stdin).stdout(Stdio::piped()).spawn() {
		Ok(child) => child,
		Err(err) => return super::fail(host, format!("{SYSTEM_OPEN}: {err}"), 1),
	};
	// Both are piped (stderr by `ChildEnv::command`).
	let stderr = child.stderr.take().map(|stderr| env.forward_stderr(stderr));
	let stdout = child.stdout.take().zip(host.stdout.try_clone().ok()).map(|(mut from, mut to)| {
		std::thread::spawn(move || {
			let _ = io::copy(&mut from, &mut to);
		})
	});
	let status = loop {
		match child.try_wait() {
			Ok(Some(status)) => break status.code().unwrap_or(1),
			Ok(None) if host.is_cancelled() => {
				let _ = child.kill();
				let _ = child.wait();
				break CANCELLED_STATUS;
			},
			Ok(None) => std::thread::sleep(POLL),
			Err(err) => break super::fail(host, format!("{SYSTEM_OPEN}: {err}"), 1),
		}
	};
	for forwarder in [stdout, stderr].into_iter().flatten() {
		let _ = forwarder.join();
	}
	status
}
