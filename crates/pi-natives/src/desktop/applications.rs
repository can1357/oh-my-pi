//! Installed application discovery does not require capture or input
//! permission.

use std::path::Path;

use napi_derive::napi;

use super::{
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

#[cfg(target_os = "linux")]
#[path = "linux/applications.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "macos/applications.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "win32/applications.rs"]
mod platform;

/// Installed application identity with currently observable process
/// information.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct Application {
	pub id:      String,
	pub name:    String,
	pub path:    String,
	pub running: bool,
	pub pid:     Option<u32>,
}

/// Filters the native application inventory without requiring screen access.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct ApplicationQuery {
	pub query:        Option<String>,
	pub running_only: Option<bool>,
}

/// Controls whether launching an application deliberately activates it.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct ApplicationOpenOptions {
	pub activate: Option<bool>,
}

/// An opened application: its [`Application`] fields and the window it
/// shows. On macOS `window` is its frontmost window once one is on screen;
/// other platforms report none.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct OpenedApplication {
	pub id:      String,
	pub name:    String,
	pub path:    String,
	pub running: bool,
	pub pid:     Option<u32>,
	pub window:  Option<DesktopWindow>,
}

impl OpenedApplication {
	pub(crate) fn new(application: Application, window: Option<DesktopWindow>) -> Self {
		let Application { id, name, path, running, pid } = application;
		Self { id, name, path, running, pid, window }
	}
}

pub(crate) const fn supported() -> bool {
	cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux"))
}

pub(crate) fn list(options: ApplicationQuery) -> CoreResult<Vec<Application>> {
	#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
	let mut apps = platform::list()?;
	#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
	let mut apps: Vec<Application> = return Err(DesktopError::invalid_target(
		"installed application discovery is unsupported on this operating system",
	));
	let query = options.query.as_deref().unwrap_or_default().to_lowercase();
	apps.retain(|app| {
		(!options.running_only.unwrap_or(false) || app.running)
			&& (query.is_empty()
				|| app.name.to_lowercase().contains(&query)
				|| app.id.to_lowercase().contains(&query)
				|| app.path.to_lowercase().contains(&query))
	});
	apps.sort_by(|a, b| {
		a.name
			.cmp(&b.name)
			.then(a.id.cmp(&b.id))
			.then(a.path.cmp(&b.path))
	});
	Ok(apps)
}

/// Resolve identity before display name; ambiguity never launches an arbitrary
/// app.
fn resolve<'a>(apps: &'a [Application], input: &str) -> CoreResult<Option<&'a Application>> {
	let mut exact = apps
		.iter()
		.filter(|app| app.id == input || app.path == input);
	if let Some(first) = exact.next() {
		return unique(first, exact.next(), input).map(Some);
	}
	let folded = input.to_lowercase();
	let mut names = apps.iter().filter(|app| app.name.to_lowercase() == folded);
	names
		.next()
		.map(|first| unique(first, names.next(), input))
		.transpose()
}

fn unique<'a>(
	first: &'a Application,
	second: Option<&Application>,
	input: &str,
) -> CoreResult<&'a Application> {
	if let Some(second) = second {
		return Err(DesktopError::invalid_target(format!(
			"application {input:?} is ambiguous; use an exact native path (matches include {:?} and \
			 {:?})",
			first.path, second.path,
		)));
	}
	Ok(first)
}

/// `app`, read from an explicit path, with the running state of the listed
/// application at its resolved bundle path: a bundle read alone says it is
/// not running, so a symlink to a running application would be launched
/// again, which reopens it.
fn with_listed_state(apps: &[Application], app: Application) -> Application {
	apps
		.iter()
		.find(|listed| listed.path == app.path)
		.cloned()
		.unwrap_or(app)
}

pub(crate) fn open(input: &str, options: ApplicationOpenOptions) -> CoreResult<OpenedApplication> {
	if input.is_empty() || input.contains('\0') {
		return Err(DesktopError::invalid_target(
			"application identity must be nonempty and contain no NUL",
		));
	}
	#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
	{
		let apps = platform::list()?;
		// Native paths are checked before display names so a real package path is
		// never mistaken for a similarly named installed application.
		let app = if apps.iter().any(|app| app.id == input || app.path == input) {
			resolve(&apps, input)?
				.cloned()
				.ok_or_else(|| DesktopError::invalid_target("application disappeared"))?
		} else if Path::new(input).is_absolute()
			|| input.contains(std::path::MAIN_SEPARATOR)
			|| Path::new(input).exists()
		{
			with_listed_state(&apps, platform::from_path(Path::new(input))?)
		} else {
			resolve(&apps, input)?.cloned().ok_or_else(|| {
				DesktopError::invalid_target(format!(
					"application {input:?} was not found; use apps.list() or an existing native \
					 application path"
				))
			})?
		};
		let activate = options.activate.unwrap_or(false);
		#[cfg(target_os = "macos")]
		return platform::open(app, activate);
		#[cfg(not(target_os = "macos"))]
		return platform::open(app, activate)
			.map(|application| OpenedApplication::new(application, None));
	}
	#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
	{
		let _ = options;
		Err(DesktopError::invalid_target(
			"native application launch is unsupported on this operating system",
		))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn app(id: &str, name: &str, path: &str) -> Application {
		Application {
			id:      id.into(),
			name:    name.into(),
			path:    path.into(),
			running: false,
			pid:     None,
		}
	}

	#[test]
	fn identity_precedes_name_and_names_are_case_insensitive() {
		let apps = [
			app("org.example.Editor", "Edit", "/A.app"),
			app("other", "org.example.Editor", "/B.app"),
		];
		assert_eq!(resolve(&apps, "org.example.Editor").unwrap().unwrap().path, "/A.app");
		assert_eq!(resolve(&apps, "eDiT").unwrap().unwrap().id, "org.example.Editor");
		assert!(resolve(&apps, "missing").unwrap().is_none());
	}

	#[test]
	fn duplicate_names_and_bundle_id_copies_require_path() {
		let apps = [app("same", "Editor", "/A.app"), app("same", "editor", "/B.app")];
		assert!(resolve(&apps, "EDITOR").is_err());
		assert!(resolve(&apps, "same").is_err());
		assert_eq!(resolve(&apps, "/B.app").unwrap().unwrap().path, "/B.app");
	}

	#[test]
	fn an_explicit_path_to_a_running_application_keeps_its_running_state() {
		// A symlink resolved to /Applications/Notes.app, which is running.
		let running = Application { running: true, pid: Some(42), ..app("notes", "Notes", "/N.app") };
		let apps = [app("other", "Other", "/O.app"), running];
		let opened = with_listed_state(&apps, app("notes", "Notes", "/N.app"));
		assert_eq!((opened.running, opened.pid), (true, Some(42)));
		let unlisted = with_listed_state(&apps, app("x", "X", "/X.app"));
		assert_eq!((unlisted.running, unlisted.pid), (false, None));
	}
}
