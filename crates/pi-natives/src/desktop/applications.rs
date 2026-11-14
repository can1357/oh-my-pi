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
	resolve_by(apps, input, is_helper)
}

/// [`resolve`], with `is_helper` naming the inventory entries no one opens by
/// name. A display name that one regular app and only helpers share names the
/// regular app: macOS calls both Contacts and its `PeopleViewService`
/// "Contacts", and Messages and its running assistant extension "Messages".
fn resolve_by<'a>(
	apps: &'a [Application],
	input: &str,
	is_helper: impl Fn(&Application) -> bool,
) -> CoreResult<Option<&'a Application>> {
	let mut exact = apps
		.iter()
		.filter(|app| app.id == input || app.path == input);
	if let Some(first) = exact.next() {
		return unique(first, exact.next(), input).map(Some);
	}
	let folded = input.to_lowercase();
	let mut names = apps.iter().filter(|app| app.name.to_lowercase() == folded);
	let Some(first) = names.next() else {
		return Ok(None);
	};
	let Some(second) = names.next() else {
		return Ok(Some(first));
	};
	// Bundle flags are read only once a name ties, and only for its matches.
	let mut regular = [first, second]
		.into_iter()
		.chain(names)
		.filter(|app| !is_helper(app));
	match (regular.next(), regular.next()) {
		(Some(only), None) => Ok(Some(only)),
		// The error names two apps the caller could mean, never a helper.
		(Some(one), Some(other)) => unique(one, Some(other), input).map(Some),
		(None, _) => unique(first, Some(second), input).map(Some),
	}
}

/// Whether `app` is a helper rather than an application a user opens: an
/// agent (`LSUIElement`), a background-only app (`LSBackgroundOnly`) or a
/// running bundle that is not an `.app`, such as an app extension.
#[cfg(target_os = "macos")]
fn is_helper(app: &Application) -> bool {
	platform::is_helper(Path::new(&app.path))
}

/// Other platforms list no helpers apart from their applications.
#[cfg(not(target_os = "macos"))]
const fn is_helper(_: &Application) -> bool {
	false
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
	// Off macOS no document route exists, and `reveal`/`app` always ask for one:
	// refuse before the inventory listing, which can fail on its own.
	#[cfg(not(target_os = "macos"))]
	if options.reveal.unwrap_or(false) || options.app.is_some() {
		return open_document(&[], input, &options);
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
	fn a_name_shared_with_helpers_names_the_regular_app() {
		let helper = app("helper", "Contacts", "/H.app");
		let contacts = app("contacts", "Contacts", "/C.app");
		let is_helper = |app: &Application| app.id == "helper";
		let apps = [helper.clone(), contacts.clone()];
		assert_eq!(
			resolve_by(&apps, "contacts", is_helper)
				.unwrap()
				.unwrap()
				.path,
			"/C.app"
		);
		// Helpers alone still need a path; two regular apps do too, and the
		// error names those two, not the helper.
		assert!(resolve_by(&apps, "Contacts", |_| true).is_err());
		let apps = [helper, contacts, app("copy", "Contacts", "/D.app")];
		let error = resolve_by(&apps, "Contacts", is_helper).unwrap_err();
		assert!(
			error.message.contains("/C.app") && error.message.contains("/D.app"),
			"{}",
			error.message
		);
		assert!(!error.message.contains("/H.app"), "{}", error.message);
	}

	/// Bundles whose Info.plist declares `flags`, under a fresh temporary
	/// directory.
	#[cfg(target_os = "macos")]
	fn bundles(test: &str, entries: &[(&str, &str)]) -> (std::path::PathBuf, Vec<String>) {
		let root = std::env::temp_dir().join(format!("pi-natives-{test}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		let paths = entries
			.iter()
			.map(|(name, flags)| {
				let contents = root.join(name).join("Contents");
				std::fs::create_dir_all(&contents).unwrap();
				std::fs::write(
					contents.join("Info.plist"),
					format!(
						"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist \
						 version=\"1.0\"><dict>{flags}</dict></plist>\n"
					),
				)
				.unwrap();
				root.join(name).to_str().unwrap().to_owned()
			})
			.collect();
		(root, paths)
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn agents_background_apps_and_extensions_lose_a_shared_name_to_the_app() {
		let (root, paths) = bundles("helpers", &[
			("Notes.app", "<key>LSUIElement</key><false/>"),
			("Agent.app", "<key>LSUIElement</key><string>1</string>"),
			("Daemon.app", "<key>LSBackgroundOnly</key><true/>"),
			("Notes.appex", ""),
			("Other.app", ""),
		]);
		let named = |path: &String| app(path, "Notes", path);
		let helpers_and_app: Vec<_> = paths[..4].iter().map(named).collect();
		assert_eq!(resolve(&helpers_and_app, "Notes").unwrap().unwrap().path, paths[0]);
		let two_apps = [named(&paths[0]), named(&paths[4])];
		assert!(resolve(&two_apps, "Notes").is_err());
		std::fs::remove_dir_all(root).unwrap();
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
		// `reveal` and `app` refuse before the inventory listing.
		for options in [
			ApplicationOpenOptions { reveal: Some(true), ..Default::default() },
			ApplicationOpenOptions { app: Some("Editor".into()), ..Default::default() },
		] {
			let error = open(".", options).unwrap_err();
			assert_eq!(error.code, super::super::error::ErrorCode::Unsupported);
			assert!(error.message.contains("on macOS only"), "{}", error.message);
		}
		// A URL routes to the document path, which refuses; `open` reaches it
		// only after an inventory listing, which some hosts cannot produce.
		let url = ApplicationOpenOptions::default();
		assert_eq!(route(&[], "https://example.com", &url), Route::Document);
		let error = open_document(&[], "https://example.com", &url).unwrap_err();
		assert_eq!(error.code, super::super::error::ErrorCode::Unsupported);
		// A file or folder path alone is still read as an application, as before.
		let error = open(".", ApplicationOpenOptions::default()).unwrap_err();
		assert_ne!(error.code, super::super::error::ErrorCode::Unsupported);
	}
}
