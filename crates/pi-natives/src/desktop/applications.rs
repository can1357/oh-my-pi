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

/// How `apps.open` opens its target.
///
/// `activate` deliberately brings the application forward. On macOS a file,
/// folder or URL target opens in its default application, or in `app` (an
/// application ID, name or path); `reveal` instead shows the file or folder
/// selected in Finder, which comes to the front.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct ApplicationOpenOptions {
	pub activate: Option<bool>,
	pub reveal:   Option<bool>,
	pub app:      Option<String>,
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

/// The scheme of a URL such as `https://…` or `x-apple.systempreferences:…`;
/// never a Windows drive letter (`C:`), which is one character.
fn url_scheme(input: &str) -> Option<&str> {
	let (scheme, _) = input.split_once(':')?;
	(scheme.len() > 1
		&& scheme.starts_with(|c: char| c.is_ascii_alphabetic())
		&& scheme
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
	.then_some(scheme)
}

/// Whether `path` names a macOS application bundle (`.app`).
fn is_app_bundle(path: &Path) -> bool {
	path
		.extension()
		.is_some_and(|extension| extension.as_encoded_bytes().eq_ignore_ascii_case(b"app"))
}

/// Whether `apps.open` takes `input` as a document rather than an application:
/// a URL, or on macOS an existing file or folder that is not an `.app` bundle.
fn opens_as_document(input: &str) -> bool {
	let path = Path::new(input);
	if path.exists() {
		return cfg!(target_os = "macos") && !is_app_bundle(path);
	}
	url_scheme(input).is_some()
}

/// What `apps.open` opens.
#[derive(Debug, PartialEq, Eq)]
enum Route {
	Application,
	Document,
}

/// `app` and `reveal` ask for a document. Otherwise an exact inventory ID or
/// native path is an application, so neither a same-named file nor a
/// URL-shaped package path (`shell:AppsFolder\…` on Windows) shadows it; then
/// [`opens_as_document`] decides.
fn route(apps: &[Application], input: &str, options: &ApplicationOpenOptions) -> Route {
	if options.reveal.unwrap_or(false) || options.app.is_some() {
		return Route::Document;
	}
	if apps.iter().any(|app| app.id == input || app.path == input) {
		return Route::Application;
	}
	if opens_as_document(input) {
		Route::Document
	} else {
		Route::Application
	}
}

pub(crate) fn open(input: &str, options: ApplicationOpenOptions) -> CoreResult<OpenedApplication> {
	if input.is_empty() || input.contains('\0') {
		return Err(DesktopError::invalid_target(
			"application identity must be nonempty and contain no NUL",
		));
	}
	if options.reveal.unwrap_or(false) && options.app.is_some() {
		return Err(DesktopError::invalid_target(
			"apps.open takes reveal or app, not both: reveal shows the item in Finder",
		));
	}
	#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
	{
		let apps = platform::list()?;
		if route(&apps, input, &options) == Route::Document {
			return open_document(&apps, input, &options);
		}
		let app = application(&apps, input)?;
		let activate = options.activate.unwrap_or(false);
		#[cfg(target_os = "macos")]
		return platform::open(app, activate);
		#[cfg(not(target_os = "macos"))]
		return platform::open(app, activate)
			.map(|application| OpenedApplication::new(application, None));
	}
	#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
	{
		if route(&[], input, &options) == Route::Document {
			return open_document(&[], input, &options);
		}
		Err(DesktopError::invalid_target(
			"native application launch is unsupported on this operating system",
		))
	}
}

/// The installed application `input` names among `apps`: an ID or native
/// path, then a display name.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn application(apps: &[Application], input: &str) -> CoreResult<Application> {
	// Native paths are checked before display names so a real package path is
	// never mistaken for a similarly named installed application.
	if apps.iter().any(|app| app.id == input || app.path == input) {
		resolve(apps, input)?
			.cloned()
			.ok_or_else(|| DesktopError::invalid_target("application disappeared"))
	} else if Path::new(input).is_absolute()
		|| input.contains(std::path::MAIN_SEPARATOR)
		|| Path::new(input).exists()
	{
		Ok(with_listed_state(apps, platform::from_path(Path::new(input))?))
	} else {
		resolve(apps, input)?.cloned().ok_or_else(|| {
			DesktopError::invalid_target(format!(
				"application {input:?} was not found; use apps.list() or an existing native \
				 application path"
			))
		})
	}
}

/// [`open`] for a file, folder or URL: opened by its default application or
/// `options.app` (one of `apps`), or with `reveal` shown selected in Finder.
fn open_document(
	apps: &[Application],
	input: &str,
	options: &ApplicationOpenOptions,
) -> CoreResult<OpenedApplication> {
	#[cfg(target_os = "macos")]
	{
		let app = options
			.app
			.as_deref()
			.map(|app| application(apps, app))
			.transpose()?;
		platform::open_document(
			input,
			app,
			options.reveal.unwrap_or(false),
			options.activate.unwrap_or(false),
		)
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (apps, input, options);
		Err(DesktopError::unsupported(
			"apps.open opens files, folders and URLs (app, reveal) on macOS only; here it takes an \
			 application ID, name or path",
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

	#[test]
	fn url_schemes_never_take_a_drive_letter_or_bundle_id() {
		assert_eq!(url_scheme("https://example.com"), Some("https"));
		assert_eq!(
			url_scheme("x-apple.systempreferences:com.apple.Sound-Settings.extension"),
			Some("x-apple.systempreferences")
		);
		assert_eq!(url_scheme(r"C:\Users\me\notes.txt"), None);
		assert_eq!(url_scheme("com.apple.TextEdit"), None);
		assert_eq!(url_scheme("TextEdit"), None);
		assert_eq!(url_scheme("1password:open"), None);
	}

	#[test]
	fn existing_files_and_folders_open_as_documents_on_macos_only() {
		let dir = std::env::temp_dir().join(format!("pi-natives-open-{}", std::process::id()));
		let bundle = dir.join("Editor.app");
		std::fs::create_dir_all(&bundle).unwrap();
		let file = dir.join("notes.txt");
		std::fs::write(&file, "x").unwrap();
		let as_document = |path: &Path| opens_as_document(path.to_str().unwrap());
		assert_eq!(as_document(&file), cfg!(target_os = "macos"));
		assert_eq!(as_document(&dir), cfg!(target_os = "macos"));
		assert!(!as_document(&bundle), "an .app bundle stays an application");
		assert!(!as_document(&dir.join("missing.txt")));
		assert!(opens_as_document("https://example.com"));
		assert!(!opens_as_document("com.apple.TextEdit"));
		std::fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn an_exact_inventory_identity_is_never_shadowed_by_a_url_or_a_file() {
		let dir = std::env::temp_dir().join(format!("pi-natives-route-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let file = dir.join("com.example.Editor");
		std::fs::write(&file, "x").unwrap();
		let shadowed = file.to_str().unwrap();
		let packaged = r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
		let apps = [app("calc", "Calculator", packaged), app(shadowed, "Editor", "/E.app")];
		let none = ApplicationOpenOptions::default();
		assert_eq!(route(&apps, packaged, &none), Route::Application);
		assert_eq!(route(&apps, shadowed, &none), Route::Application);
		// Unlisted, the same inputs are a URL and, on macOS, a file.
		assert_eq!(route(&[], packaged, &none), Route::Document);
		assert_eq!(route(&[], shadowed, &none) == Route::Document, cfg!(target_os = "macos"));
		assert_eq!(route(&apps, "https://example.com", &none), Route::Document);
		assert_eq!(route(&apps, "Calculator", &none), Route::Application);
		let reveal = ApplicationOpenOptions { reveal: Some(true), ..Default::default() };
		assert_eq!(route(&apps, shadowed, &reveal), Route::Document);
		std::fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn reveal_and_app_together_are_refused_before_anything_opens() {
		let options = ApplicationOpenOptions {
			reveal: Some(true),
			app: Some("TextEdit".into()),
			..Default::default()
		};
		let error = open("/tmp", options).unwrap_err();
		assert!(error.message.contains("reveal or app, not both"), "{}", error.message);
	}

	#[cfg(not(target_os = "macos"))]
	#[test]
	fn documents_and_reveal_are_unsupported_off_macos() {
		for (input, options) in [
			("https://example.com", ApplicationOpenOptions::default()),
			(".", ApplicationOpenOptions { reveal: Some(true), ..Default::default() }),
			(".", ApplicationOpenOptions { app: Some("Editor".into()), ..Default::default() }),
		] {
			let error = open(input, options).unwrap_err();
			assert_eq!(error.code, super::super::error::ErrorCode::Unsupported, "{input}");
			assert!(error.message.contains("on macOS only"), "{}", error.message);
		}
		// A file or folder path alone is still read as an application, as before.
		let error = open(".", ApplicationOpenOptions::default()).unwrap_err();
		assert_ne!(error.code, super::super::error::ErrorCode::Unsupported);
	}
}
