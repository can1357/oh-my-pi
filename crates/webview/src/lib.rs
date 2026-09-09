//! Modular embedded-browser surfaces for omp.
//!
//! `omp-webview` follows [wry](https://github.com/tauri-apps/wry)'s footsteps —
//! embed real web content without shipping a browser engine — and generalizes
//! it: the engine is pluggable, including the browsers the user already has
//! installed.
//!
//! # Engines
//!
//! - **system** — the platform webview, in-process (`WKWebView` on macOS).
//! - **chromium** — any installed Chromium-family browser (Chrome, Edge, Brave,
//!   Chromium, Vivaldi, ...), spawned and driven over the Chrome `DevTools`
//!   Protocol, or a non-owned browser/relay attached through an existing CDP
//!   discovery or websocket endpoint.
//! - **firefox** — any installed Gecko-family browser (Firefox, `LibreWolf`,
//!   ...), spawned and driven over `WebDriver` `BiDi`.
//!
//! # Surfaces
//!
//! - **child** — a native subview embedded in a host window (wry's model). The
//!   OS composites it *above* the host's own rendering.
//! - **frames** — a stream of RGBA frames the host composites itself, with
//!   input forwarded explicitly. Remote engines run headless; the macOS system
//!   engine renders in an invisible window and captures via `ScreenCaptureKit`
//!   (with Screen Recording permission) or `takeSnapshot` polling.
//! - **window** — an engine-owned OS window (`chrome --app`-style shell).
//!
//! # Capability matrix
//!
//! | engine   | child | frames       | window |
//! |----------|-------|--------------|--------|
//! | system   | yes   | yes (macOS)  | no     |
//! | chromium | no    | yes          | yes    |
//! | firefox  | no    | yes          | yes    |
//!
//! Unsupported combinations fail with [`Error::Unsupported`] at build time.
//!
//! # Example
//!
//! ```ignore
//! use omp_webview::{Engine, FrameConfig, WebViewBuilder, WebViewEvent};
//!
//! let view = WebViewBuilder::new(Engine::find(omp_webview::SurfaceKind::Frames)?)
//!    .url("https://example.com")
//!    .build_frames(FrameConfig::default())?;
//! while let Ok(event) = view.events().recv() {
//!    if let WebViewEvent::Frame(frame) = event {
//!       // upload frame.data (RGBA8) as a texture
//!    }
//! }
//! ```
//!
//! # Remote-engine profiles
//!
//! Owned remote engines never touch the user's daily browsing profile: modern
//! Chrome refuses automation on the default profile, and clobbering user
//! state would be hostile anyway. By default each owned view gets an ephemeral
//! profile deleted on close; pass [`WebViewBuilder::profile`] for a
//! persistent one (cookies and logins survive across views). Attached CDP
//! views adopt exactly one caller-selected page and detach without closing it.
//!
//! The `OMP_WEBVIEW_BROWSER` environment variable (path to a browser binary)
//! overrides [`Engine::find`]'s discovery for remote surfaces.

pub mod automation;
mod discover;
mod error;
mod event;
mod geometry;
mod input;
mod options;
mod remote;
#[cfg(target_os = "macos")]
mod wk;

use std::{env, path::PathBuf};

use flume::Receiver;
use omp_core::{IntoStr, Str};
/// Re-exported so hosts don't need a direct dependency to hand windows over.
pub use raw_window_handle;
use raw_window_handle::HasWindowHandle;
#[cfg(target_os = "macos")]
use wk::frames::WkFrames;
#[cfg(target_os = "macos")]
pub use wk::request_screen_capture;

pub use crate::{
	discover::{BrowserKind, EngineFamily, InstalledBrowser, discover},
	error::{CdpDiscoveryError, Error, Result},
	event::{Frame, WebViewEvent},
	geometry::Rect,
	input::{Input, Key, Modifiers, MouseButton},
	options::{EngineKind, FrameConfig, FrameFormat, SurfaceKind, WindowConfig},
	remote::CloseHandle,
};
use crate::{
	event::SharedState,
	options::PageOptions,
	remote::{Command, RemoteView, chromium, firefox},
};
pub(crate) fn navigation_scheme(url: &str) -> &'static str {
	let Some((scheme, _)) = url.split_once(':') else {
		return "none";
	};
	if scheme.eq_ignore_ascii_case("http") {
		"http"
	} else if scheme.eq_ignore_ascii_case("https") {
		"https"
	} else if scheme.eq_ignore_ascii_case("file") {
		"file"
	} else if scheme.eq_ignore_ascii_case("about") {
		"about"
	} else if scheme.eq_ignore_ascii_case("data") {
		"data"
	} else if scheme.eq_ignore_ascii_case("blob") {
		"blob"
	} else if scheme.eq_ignore_ascii_case("ws") {
		"ws"
	} else if scheme.eq_ignore_ascii_case("wss") {
		"wss"
	} else {
		"other"
	}
}

/// A concrete engine choice for [`WebViewBuilder::new`].
#[derive(Clone, Debug)]
pub enum Engine {
	/// The platform webview (in-process, `child` surfaces only).
	#[cfg(target_os = "macos")]
	System,
	/// An installed Chromium-family browser, driven over CDP.
	Chromium {
		/// Path to the browser binary.
		binary: PathBuf,
	},
	/// An existing Chromium-compatible CDP endpoint. Dropping a view detaches
	/// from its target but never closes the foreign browser or page.
	ChromiumCdp {
		/// Browser HTTP discovery URL or browser websocket URL.
		endpoint: Str,
		/// Optional URL/title substring selecting an existing page target.
		target:   Option<Str>,
	},
	/// An OMP Chromium relay endpoint. Relay identity is explicit so generic
	/// CDP proxies are never sent relay-private commands.
	ChromiumRelay {
		/// Relay HTTP discovery URL or websocket URL.
		endpoint: Str,
		/// Optional URL/title substring selecting an existing page target.
		target:   Option<Str>,
	},
	/// An installed Gecko-family browser, driven over `WebDriver` `BiDi`.
	Firefox {
		/// Path to the browser binary.
		binary: PathBuf,
	},
}

impl Engine {
	/// The platform webview.
	#[cfg(target_os = "macos")]
	pub const fn system() -> Self {
		Self::System
	}

	/// A Chromium-family browser at `binary`.
	pub fn chromium(binary: impl Into<PathBuf>) -> Self {
		Self::Chromium { binary: binary.into() }
	}

	/// Attach to an existing Chromium-compatible CDP endpoint.
	pub fn chromium_cdp(endpoint: impl IntoStr, target: Option<Str>) -> Self {
		Self::ChromiumCdp { endpoint: endpoint.to_str(), target }
	}

	/// Attach through an OMP Chromium relay.
	///
	/// Unlike [`Self::chromium_cdp`], this explicitly enables the relay
	/// handshake and user-tab focus protections independently of URL shape.
	pub fn chromium_relay(endpoint: impl IntoStr, target: Option<Str>) -> Self {
		Self::ChromiumRelay { endpoint: endpoint.to_str(), target }
	}

	/// A Gecko-family browser at `binary`.
	pub fn firefox(binary: impl Into<PathBuf>) -> Self {
		Self::Firefox { binary: binary.into() }
	}

	/// An engine for an [`InstalledBrowser`] found by [`discover`].
	pub fn installed(browser: &InstalledBrowser) -> Self {
		match browser.family {
			EngineFamily::Chromium => Self::chromium(&browser.path),
			EngineFamily::Gecko => Self::firefox(&browser.path),
		}
	}

	/// Pick the best available engine for `surface`.
	///
	/// `child` prefers the system webview. Remote surfaces honor the
	/// `OMP_WEBVIEW_BROWSER` override, then prefer Chromium-family installs
	/// (full-rate screencast) over Gecko (screenshot polling).
	///
	/// # Errors
	///
	/// [`Error::NoEngine`] when nothing installed can present `surface`.
	pub fn find(surface: SurfaceKind) -> Result<Self> {
		if surface == SurfaceKind::Child {
			#[cfg(target_os = "macos")]
			return Ok(Self::System);
			#[cfg(not(target_os = "macos"))]
			return Err(Error::NoEngine(surface));
		}
		if let Some(path) = env::var_os("OMP_WEBVIEW_BROWSER") {
			if path == "system" {
				#[cfg(target_os = "macos")]
				return Ok(Self::System);
				#[cfg(not(target_os = "macos"))]
				return Err(Error::NoEngine(surface));
			}
			let path = PathBuf::from(path);
			return Ok(if discover::gecko_like(&path) {
				Self::Firefox { binary: path }
			} else {
				Self::Chromium { binary: path }
			});
		}
		let installed = discover();
		installed
			.iter()
			.find(|b| b.family == EngineFamily::Chromium)
			.or_else(|| installed.first())
			.map(Self::installed)
			.ok_or(Error::NoEngine(surface))
	}

	/// Which [`EngineKind`] this engine is.
	pub const fn kind(&self) -> EngineKind {
		match self {
			#[cfg(target_os = "macos")]
			Self::System => EngineKind::System,
			Self::Chromium { .. } | Self::ChromiumCdp { .. } | Self::ChromiumRelay { .. } => {
				EngineKind::Chromium
			},
			Self::Firefox { .. } => EngineKind::Firefox,
		}
	}
}

/// Configures and creates a [`WebView`].
///
/// Mirrors wry's builder where the concepts carry over (url/html, user
/// agent, transparency, init scripts, IPC) and adds the surface choice at
/// build time.
pub struct WebViewBuilder {
	engine: Engine,
	page:   PageOptions,
}

impl WebViewBuilder {
	/// Start configuring a view on `engine`.
	pub fn new(engine: Engine) -> Self {
		Self { engine, page: PageOptions::default() }
	}

	/// Initial URL to load (wins over [`html`](Self::html)).
	pub fn url(mut self, url: impl IntoStr) -> Self {
		self.page.url = Some(url.to_str());
		self
	}

	/// Initial HTML document (loaded with a null origin).
	pub fn html(mut self, html: impl IntoStr) -> Self {
		self.page.html = Some(html.to_str());
		self
	}

	/// Custom user-agent string.
	pub fn user_agent(mut self, ua: impl IntoStr) -> Self {
		self.page.user_agent = Some(ua.to_str());
		self
	}

	/// Add a public HTTP header to remote page navigations.
	pub fn header(mut self, name: impl IntoStr, value: impl IntoStr) -> Self {
		self.page.headers.push((name.to_str(), value.to_str()));
		self
	}

	/// Render the page on a transparent background.
	pub const fn transparent(mut self, transparent: bool) -> Self {
		self.page.transparent = transparent;
		self
	}

	/// Solid page background color (RGBA); ignored when transparent.
	pub const fn background(mut self, rgba: [u8; 4]) -> Self {
		self.page.background = Some(rgba);
		self
	}

	/// Add a script injected before `window.onload` on every new document.
	///
	/// Pages can post messages to the host with
	/// `window.ipc.postMessage("...")`, delivered as [`WebViewEvent::Ipc`].
	pub fn init_script(mut self, script: impl IntoStr) -> Self {
		self.page.init_scripts.push(script.to_str());
		self
	}

	/// Leave no browsing data behind (remote engines force an ephemeral
	/// profile; the system webview uses a non-persistent data store).
	pub const fn incognito(mut self, incognito: bool) -> Self {
		self.page.incognito = incognito;
		self
	}

	/// Persistent browsing-profile directory for remote engines.
	pub fn profile(mut self, dir: impl Into<PathBuf>) -> Self {
		self.page.profile = Some(dir.into());
		self
	}

	/// Allow opening the engine's devtools.
	pub const fn devtools(mut self, devtools: bool) -> Self {
		self.page.devtools = devtools;
		self
	}

	/// Add one argument to an owned remote browser process.
	///
	/// Attached CDP endpoints ignore process arguments because the host does
	/// not own that process.
	pub fn argument(mut self, argument: impl IntoStr) -> Self {
		self.page.arguments.push(argument.to_str());
		self
	}

	/// Add arguments to an owned remote browser process.
	pub fn arguments(mut self, arguments: impl IntoIterator<Item = impl IntoStr>) -> Self {
		self
			.page
			.arguments
			.extend(arguments.into_iter().map(|argument| argument.to_str()));
		self
	}

	/// Bound connection and readiness work for an attached automation endpoint.
	pub const fn connect_timeout(mut self, timeout: std::time::Duration) -> Self {
		self.page.connect_timeout = Some(timeout);
		self
	}

	/// Mark the frame viewport as explicitly requested by the caller.
	///
	/// OMP relay attachments otherwise preserve the viewport of the
	/// user-owned tab. Other engines continue to apply their normal viewport
	/// behavior.
	pub const fn viewport_explicit(mut self, explicit: bool) -> Self {
		self.page.viewport_explicit = explicit;
		self
	}

	/// Embed as a native child view of `parent` at `bounds` (system engine).
	///
	/// # Errors
	///
	/// [`Error::Unsupported`] on remote engines, [`Error::MainThread`] off
	/// the main thread, [`Error::WindowHandle`] for foreign handles.
	#[tracing::instrument(
		name = "webview_initialize",
		level = "debug",
		skip_all,
		fields(engine = %self.engine.kind(), surface = %SurfaceKind::Child)
	)]
	pub fn build_child(self, parent: &impl HasWindowHandle, bounds: Rect) -> Result<WebView> {
		match self.engine {
			#[cfg(target_os = "macos")]
			Engine::System => {
				let (events_tx, events) = flume::unbounded();
				let state = SharedState::default();
				let handle = parent.window_handle().map_err(|_| Error::WindowHandle)?;
				let view =
					wk::WkView::create(&self.page, handle.as_raw(), bounds, events_tx, state.clone())
						.inspect_err(|error| {
							tracing::warn!(
								engine = "system",
								surface = "child",
								error = error.kind(),
								"webview initialization failed"
							);
						})?;
				Ok(WebView {
					inner: Inner::Wk(view),
					events,
					state,
					engine: EngineKind::System,
					surface: SurfaceKind::Child,
				})
			},
			_ => {
				let _ = parent;
				Err(Error::Unsupported("child surfaces require the system engine"))
			},
		}
	}

	/// Run the engine headless (system engine: in an invisible window) and
	/// stream frames to the host.
	///
	/// The system engine captures via `ScreenCaptureKit` when the process has
	/// Screen Recording permission (see [`request_screen_capture`]), falling
	/// back to `takeSnapshot` polling otherwise, and requires the caller to
	/// be on the main thread with a running main run loop.
	///
	/// # Errors
	///
	/// Launch/connect/capture-setup failures from the engine;
	/// [`Error::MainThread`] off the main thread on the system engine.
	#[tracing::instrument(
		name = "webview_initialize",
		level = "debug",
		skip_all,
		fields(engine = %self.engine.kind(), surface = %SurfaceKind::Frames)
	)]
	pub fn build_frames(self, config: FrameConfig) -> Result<WebView> {
		let engine = self.engine.kind();
		let (view, events, state) = match self.engine {
			Engine::Chromium { binary } => {
				remote::spawn(self.page, move |ctx| chromium::drive_frames(binary, config, ctx))
					.inspect_err(|error| {
						tracing::warn!(
							engine = %engine,
							surface = "frames",
							error = error.kind(),
							"webview initialization failed"
						);
					})?
			},
			Engine::ChromiumCdp { endpoint, target } => remote::spawn(self.page, move |ctx| {
				chromium::drive_attached(endpoint, target, config, ctx)
			})
			.inspect_err(|error| {
				tracing::warn!(
					engine = %engine,
					surface = "frames",
					error = error.kind(),
					"attached webview initialization failed"
				);
			})?,
			Engine::ChromiumRelay { endpoint, target } => remote::spawn(self.page, move |ctx| {
				chromium::drive_relay_attached(endpoint, target, config, ctx)
			})
			.inspect_err(|error| {
				tracing::warn!(
					engine = %engine,
					surface = "frames",
					error = error.kind(),
					"relay webview initialization failed"
				);
			})?,
			Engine::Firefox { binary } => {
				remote::spawn(self.page, move |ctx| firefox::drive_frames(binary, config, ctx))
					.inspect_err(|error| {
						tracing::warn!(
							engine = %engine,
							surface = "frames",
							error = error.kind(),
							"webview initialization failed"
						);
					})?
			},
			#[cfg(target_os = "macos")]
			Engine::System => {
				let (events_tx, events) = flume::unbounded();
				let state = SharedState::default();
				let view = WkFrames::create(&self.page, config, events_tx, state.clone()).inspect_err(
					|error| {
						tracing::warn!(
							engine = %engine,
							surface = "frames",
							error = error.kind(),
							"webview initialization failed"
						);
					},
				)?;
				return Ok(WebView {
					inner: Inner::WkFrames(view),
					events,
					state,
					engine,
					surface: SurfaceKind::Frames,
				});
			},
		};
		Ok(WebView {
			inner: Inner::Remote(view),
			events,
			state,
			engine,
			surface: SurfaceKind::Frames,
		})
	}

	/// Open an engine-owned OS window.
	///
	/// # Errors
	///
	/// [`Error::Unsupported`] on the system engine; launch/connect failures
	/// from the remote engine.
	#[tracing::instrument(
		name = "webview_initialize",
		level = "debug",
		skip_all,
		fields(engine = %self.engine.kind(), surface = %SurfaceKind::Window)
	)]
	pub fn build_window(self, config: WindowConfig) -> Result<WebView> {
		let engine = self.engine.kind();
		let (view, events, state) = match self.engine {
			Engine::Chromium { binary } => {
				remote::spawn(self.page, move |ctx| chromium::drive_window(binary, config, ctx))
					.inspect_err(|error| {
						tracing::warn!(
							engine = %engine,
							surface = "window",
							error = error.kind(),
							"webview initialization failed"
						);
					})?
			},
			Engine::ChromiumCdp { endpoint, target } => remote::spawn(self.page, move |ctx| {
				chromium::drive_attached(
					endpoint,
					target,
					FrameConfig { width: config.width, height: config.height, ..FrameConfig::default() },
					ctx,
				)
			})
			.inspect_err(|error| {
				tracing::warn!(
					engine = %engine,
					surface = "window",
					error = error.kind(),
					"attached webview initialization failed"
				);
			})?,
			Engine::ChromiumRelay { endpoint, target } => remote::spawn(self.page, move |ctx| {
				chromium::drive_relay_attached(
					endpoint,
					target,
					FrameConfig { width: config.width, height: config.height, ..FrameConfig::default() },
					ctx,
				)
			})
			.inspect_err(|error| {
				tracing::warn!(
					engine = %engine,
					surface = "window",
					error = error.kind(),
					"relay webview initialization failed"
				);
			})?,
			Engine::Firefox { binary } => {
				remote::spawn(self.page, move |ctx| firefox::drive_window(binary, config, ctx))
					.inspect_err(|error| {
						tracing::warn!(
							engine = %engine,
							surface = "window",
							error = error.kind(),
							"webview initialization failed"
						);
					})?
			},
			#[cfg(target_os = "macos")]
			Engine::System => {
				return Err(Error::Unsupported("window surfaces require a remote engine"));
			},
		};
		Ok(WebView {
			inner: Inner::Remote(view),
			events,
			state,
			engine,
			surface: SurfaceKind::Window,
		})
	}
}

enum Inner {
	#[cfg(target_os = "macos")]
	Wk(wk::WkView),
	#[cfg(target_os = "macos")]
	WkFrames(WkFrames),
	Remote(RemoteView),
}

/// A live web surface.
///
/// Dropping the view tears the surface down: child views detach from the
/// parent window; remote engines are shut down with a bounded grace period.
///
/// On macOS a system-engine view is bound to the main thread and the handle
/// is not `Send`; the [`events`](Self::events) receiver can be cloned and
/// consumed from any thread regardless of engine.
pub struct WebView {
	inner:   Inner,
	events:  Receiver<WebViewEvent>,
	state:   SharedState,
	engine:  EngineKind,
	surface: SurfaceKind,
}

impl WebView {
	/// Navigate to `url`.
	pub fn navigate(&self, url: &str) -> Result<()> {
		tracing::debug!(
			engine = %self.engine,
			surface = %self.surface,
			scheme = navigation_scheme(url),
			"webview navigation requested"
		);
		let result = match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.navigate(url),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.navigate(url),
			Inner::Remote(view) => view.send(Command::Navigate(url.to_str())),
		};
		if let Err(error) = &result {
			tracing::warn!(
				engine = %self.engine,
				surface = %self.surface,
				scheme = navigation_scheme(url),
				error = error.kind(),
				"webview navigation rejected"
			);
		}
		result
	}

	/// Replace the document with `html` (null origin).
	pub fn load_html(&self, html: &str) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.load_html(html),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.load_html(html),
			Inner::Remote(view) => view.send(Command::LoadHtml(html.to_str())),
		}
	}

	/// Evaluate JavaScript, discarding the result.
	pub fn eval(&self, js: &str) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.eval(js, None),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.eval(js, None),
			Inner::Remote(view) => view.send(Command::Eval { js: js.to_str(), reply: None }),
		}
	}

	/// Evaluate JavaScript; `reply` receives the JSON-encoded result on the
	/// engine's driver/main thread.
	pub fn eval_with(&self, js: &str, reply: impl FnOnce(Str) + Send + 'static) -> Result<()> {
		let reply = Some(Box::new(reply) as Box<dyn FnOnce(Str) + Send>);
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.eval(js, reply),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.eval(js, reply),
			Inner::Remote(view) => view.send(Command::Eval { js: js.to_str(), reply }),
		}
	}

	/// Reload the current page.
	pub fn reload(&self) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.reload(),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.reload(),
			Inner::Remote(view) => view.send(Command::Reload),
		}
	}

	/// History back.
	pub fn back(&self) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.back(),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.back(),
			Inner::Remote(view) => view.send(Command::Back),
		}
	}

	/// History forward.
	pub fn forward(&self) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.forward(),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.forward(),
			Inner::Remote(view) => view.send(Command::Forward),
		}
	}

	/// Move focus to the surface (child) or raise the window (window).
	pub fn focus(&self) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.focus(),
			#[cfg(target_os = "macos")]
			Inner::WkFrames(view) => view.focus(),
			Inner::Remote(view) => view.send(Command::Focus),
		}
	}

	/// Reposition a child surface within its parent window.
	///
	/// # Errors
	///
	/// [`Error::Unsupported`] on non-child surfaces.
	pub fn set_bounds(&self, bounds: Rect) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.set_bounds(bounds),
			_ => Err(Error::Unsupported("set_bounds applies to child surfaces")),
		}
	}

	/// Show or hide a child surface.
	///
	/// # Errors
	///
	/// [`Error::Unsupported`] on non-child surfaces.
	pub fn set_visible(&self, visible: bool) -> Result<()> {
		match &self.inner {
			#[cfg(target_os = "macos")]
			Inner::Wk(view) => view.set_visible(visible),
			_ => Err(Error::Unsupported("set_visible applies to child surfaces")),
		}
	}

	/// Resize the viewport of a frames surface (CSS pixels).
	///
	/// # Errors
	///
	/// [`Error::Unsupported`] on non-frames surfaces.
	pub fn resize(&self, width: u32, height: u32) -> Result<()> {
		match (&self.inner, self.surface) {
			(Inner::Remote(view), SurfaceKind::Frames) => view.send(Command::Resize { width, height }),
			#[cfg(target_os = "macos")]
			(Inner::WkFrames(view), _) => view.resize(width, height),
			_ => Err(Error::Unsupported("resize applies to frames surfaces")),
		}
	}

	/// Forward a synthetic input event to a frames surface.
	///
	/// # Errors
	///
	/// [`Error::Unsupported`] on non-frames surfaces.
	pub fn input(&self, input: Input) -> Result<()> {
		match (&self.inner, self.surface) {
			(Inner::Remote(view), SurfaceKind::Frames) => view.send(Command::Input(input)),
			#[cfg(target_os = "macos")]
			(Inner::WkFrames(view), _) => view.input(input),
			_ => Err(Error::Unsupported("input applies to frames surfaces")),
		}
	}

	/// Last committed URL.
	pub fn url(&self) -> Str {
		self.state.lock().url.clone()
	}

	/// Last observed document title.
	pub fn title(&self) -> Str {
		self.state.lock().title.clone()
	}

	/// Return a cross-thread cancellation handle for a remote surface.
	pub fn close_handle(&self) -> Option<CloseHandle> {
		match &self.inner {
			Inner::Remote(view) => Some(view.close_handle()),
			#[cfg(target_os = "macos")]
			Inner::Wk(_) | Inner::WkFrames(_) => None,
		}
	}

	/// Event stream; clone the receiver to consume from another thread.
	pub const fn events(&self) -> &Receiver<WebViewEvent> {
		&self.events
	}

	/// Which engine renders this view.
	pub const fn engine(&self) -> EngineKind {
		self.engine
	}

	/// How this view is presented.
	pub const fn surface(&self) -> SurfaceKind {
		self.surface
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn relay_identity_is_explicit_and_independent_of_endpoint_path() {
		let generic = Engine::chromium_cdp("ws://proxy.example/cdp", None);
		let relay = Engine::chromium_relay("wss://proxy.example/rewritten/browser", None);

		assert!(matches!(generic, Engine::ChromiumCdp { .. }));
		assert!(matches!(relay, Engine::ChromiumRelay { .. }));
	}
}
