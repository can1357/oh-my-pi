//! Builder option payloads shared across engine backends.

use std::{path::PathBuf, time::Duration};

use omp_core::Str;

/// How web content reaches the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum SurfaceKind {
	/// A native subview embedded in a host window (wry-style).
	Child,
	/// A pixel stream the host composites itself; input is forwarded
	/// explicitly via [`WebView::input`](crate::WebView::input).
	Frames,
	/// An engine-owned OS window (e.g. `chrome --app`).
	Window,
}

/// Which engine renders the content.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum EngineKind {
	/// The platform webview (`WKWebView` on macOS).
	System,
	/// An installed Chromium-family browser driven over CDP.
	Chromium,
	/// An installed Gecko-family browser driven over `WebDriver` `BiDi`.
	Firefox,
}

/// Page configuration accumulated by [`WebViewBuilder`](crate::WebViewBuilder)
/// and interpreted by each backend.
#[derive(Debug, Default)]
pub struct PageOptions {
	/// Initial URL (wins over `html`).
	pub url:               Option<Str>,
	/// Initial HTML document (loaded with a null origin).
	pub html:              Option<Str>,
	/// Custom user-agent string.
	pub user_agent:        Option<Str>,
	/// Public HTTP headers applied to remote page navigations.
	pub headers:           Vec<(Str, Str)>,
	/// Transparent page background.
	pub transparent:       bool,
	/// Solid background color (RGBA), ignored when `transparent`.
	pub background:        Option<[u8; 4]>,
	/// Scripts injected before `window.onload` on every new document.
	pub init_scripts:      Vec<Str>,
	/// Do not persist browsing data.
	pub incognito:         bool,
	/// Remote engines: browsing-profile directory (cookies, cache, storage).
	/// `None` uses an ephemeral directory removed when the view closes.
	pub profile:           Option<PathBuf>,
	/// Allow opening the engine's devtools.
	pub devtools:          bool,
	/// Extra arguments for an owned remote browser process.
	pub arguments:         Vec<Str>,
	/// Upper bound for attaching to an existing automation endpoint.
	pub connect_timeout:   Option<Duration>,
	/// Whether the caller explicitly requested the supplied frame viewport.
	///
	/// Native relay attachments leave user-owned tabs at their existing
	/// viewport unless this is `true`.
	pub viewport_explicit: bool,
}

/// Wire encoding for captured frames.
///
/// The engine compresses every frame before it crosses the automation
/// socket; the codec choice trades pixel exactness against encode/decode
/// cost and wire size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameFormat {
	/// Lossless; markedly more expensive to encode in-engine and to decode.
	Png,
	/// Lossy DCT compression; the fast path for live compositing.
	Jpeg {
		/// Quality in `1..=100`.
		quality: u8,
	},
}

impl Default for FrameFormat {
	/// Quality 80 — Chromium's own screencast default — is visually clean
	/// for UI content at a fraction of PNG's cost and ~2.5x smaller than
	/// quality 90.
	fn default() -> Self {
		Self::Jpeg { quality: 80 }
	}
}

/// Configuration for a [`frames`](crate::WebViewBuilder::build_frames) surface.
#[derive(Clone, Copy, Debug)]
pub struct FrameConfig {
	/// Viewport width in CSS pixels.
	pub width:   u32,
	/// Viewport height in CSS pixels.
	pub height:  u32,
	/// Device scale factor; frame pixel dimensions are `width/height * scale`.
	pub scale:   f64,
	/// Upper bound on delivered frames per second. `None` lets the backend
	/// choose: Chromium delivers every compositor frame; Firefox (which has no
	/// screencast and is polled via screenshots) defaults to 10 fps.
	pub fps_cap: Option<f32>,
	/// Frame wire encoding; see [`FrameFormat`].
	pub format:  FrameFormat,
}

impl Default for FrameConfig {
	fn default() -> Self {
		Self {
			width:   1280,
			height:  800,
			scale:   1.0,
			fps_cap: None,
			format:  FrameFormat::default(),
		}
	}
}

/// Configuration for a [`window`](crate::WebViewBuilder::build_window) surface.
#[derive(Clone, Copy, Debug)]
pub struct WindowConfig {
	/// Initial window width in logical points.
	pub width:  u32,
	/// Initial window height in logical points.
	pub height: u32,
}

impl Default for WindowConfig {
	fn default() -> Self {
		Self { width: 1024, height: 768 }
	}
}
