//! System-`WKWebView` backends (macOS).
//!
//! Two surfaces share one in-process engine: [`child`] embeds a `WKWebView`
//! as a native subview of the host window (wry's model) and [`frames`]
//! renders into an invisible window and streams captured RGBA frames.
//! Everything here is main-thread-only: `AppKit` requires it, and the surface
//! types are `!Send` because they hold `Retained` Objective-C objects.
//!
//! This module owns the pieces both surfaces share: the
//! `WKWebViewConfiguration` build (IPC shim, user init scripts, incognito
//! data store, devtools preference), per-instance page styling (transparency,
//! background, user agent, inspectability), the navigation delegate and title
//! KVO observer, the basic navigation/eval operations, and the JSON
//! conversion for `eval` replies.

pub mod child;
pub mod frames;

use std::{iter, ptr};

use objc2::{
	AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
	rc::Retained,
	runtime::{AnyObject, NSObject, ProtocolObject},
	sel,
};
use objc2_app_kit::NSColor;
use objc2_foundation::{
	NSDictionary, NSJSONSerialization, NSJSONWritingOptions, NSKeyValueChangeKey,
	NSKeyValueObservingOptions, NSNumber, NSObjectNSKeyValueCoding,
	NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSString, NSURL, NSURLRequest,
	NSUTF8StringEncoding, ns_string,
};
use objc2_web_kit::{
	WKNavigation, WKNavigationDelegate, WKScriptMessage, WKScriptMessageHandler,
	WKUserContentController, WKUserScript, WKUserScriptInjectionTime, WKWebView,
	WKWebViewConfiguration, WKWebsiteDataStore,
};
use omp_core::{Str, sf};
use parking_lot::Mutex;

pub use self::child::WkView;
use crate::{
	error::{Error, Result},
	event::{SharedState, WebViewEvent},
	options::PageOptions,
};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	/// Returns whether the process holds Screen Recording permission without
	/// prompting the user.
	fn CGPreflightScreenCaptureAccess() -> bool;
	/// Requests Screen Recording permission, showing the system TCC prompt
	/// when the process has not been decided on yet.
	fn CGRequestScreenCaptureAccess() -> bool;
}

/// Whether this process already holds the Screen Recording permission,
/// checked silently — never shows the system prompt.
pub fn preflight_screen_capture() -> bool {
	// SAFETY: argument-less CoreGraphics query with no preconditions.
	unsafe { CGPreflightScreenCaptureAccess() }
}

/// Ask macOS for the Screen Recording permission backing the system engine's
/// `ScreenCaptureKit` frames path.
///
/// May show the system TCC prompt (or silently return `false` when the user
/// already denied it). A fresh grant only takes effect for `ScreenCaptureKit`
/// after the app restarts; until then frames surfaces keep using the
/// `takeSnapshot` polling fallback. Returns whether the permission is held.
pub fn request_screen_capture() -> bool {
	// SAFETY: argument-less CoreGraphics call; may display the TCC prompt.
	unsafe { CGRequestScreenCaptureAccess() }
}

/// JS shim that routes `window.ipc.postMessage` onto the `WebKit`
/// script-message handler registered as `ipc`, fulfilling the crate-wide IPC
/// contract.
const IPC_SHIM: &str = "Object.defineProperty(window, 'ipc', { value: Object.freeze({ \
                        postMessage: function(s) { \
                        window.webkit.messageHandlers.ipc.postMessage(s) } }) });";

/// Fails with [`Error::MainThread`] unless called on the main thread.
///
/// Belt-and-suspenders: the surface types are already `!Send`, so reaching
/// this off the main thread requires unsafe caller code.
pub fn check_main() -> Result<MainThreadMarker> {
	debug_assert!(MainThreadMarker::new().is_some(), "system webview used off the main thread");
	MainThreadMarker::new().ok_or(Error::MainThread)
}

/// Last committed URL of `webview` as a `Str`, empty when nothing is loaded.
fn current_url(webview: &WKWebView) -> Str {
	// SAFETY: `WKWebView::URL` only reads the webview's current navigation state.
	unsafe { webview.URL() }
		.and_then(|url| url.absoluteString())
		.map(|s| sf!("{s}"))
		.unwrap_or_default()
}

/// Current document title of `webview` as a `Str`, empty when absent.
fn current_title(webview: &WKWebView) -> Str {
	// SAFETY: `WKWebView::title` only reads the webview's current document title.
	unsafe { webview.title() }
		.map(|s| sf!("{s}"))
		.unwrap_or_default()
}

/// A built `WKWebViewConfiguration` plus the retained pieces the owning
/// surface must keep alive (and unregister on drop).
pub struct ConfiguredPage {
	/// The configuration, ready for `WKWebView` initialization.
	pub(super) config:  Retained<WKWebViewConfiguration>,
	/// The configuration's user-content controller (scripts + IPC handler).
	pub(super) manager: Retained<WKUserContentController>,
	/// The registered IPC handler; unregistered by name on surface drop.
	pub(super) ipc:     Retained<IpcHandler>,
}

/// Builds the shared `WKWebViewConfiguration` for `page`: non-persistent data
/// store when incognito, config-level background suppression, the devtools
/// preference, and the IPC shim plus user init scripts (document start, all
/// frames) with the IPC handler registered under `ipc`.
pub fn configure_page(
	page: &PageOptions,
	events: flume::Sender<WebViewEvent>,
	mtm: MainThreadMarker,
) -> ConfiguredPage {
	// SAFETY: creating a fresh configuration on the main thread.
	let config = unsafe { WKWebViewConfiguration::new(mtm) };
	if page.incognito {
		// SAFETY: swapping the fresh config's data store for an in-memory
		// one before the webview is created.
		unsafe {
			config.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
		}
	}

	// Suppress the opaque white page background before the first paint;
	// `drawsBackground` is the same private KVC key wry relies on.
	if page.transparent || page.background.is_some() {
		let no = NSNumber::numberWithBool(false);
		// SAFETY: `drawsBackground` is a boolean KVC key WKWebViewConfiguration
		// understands (private but stable; wry ships the same call).
		unsafe { config.setValue_forKey(Some(&no), ns_string!("drawsBackground")) };
	}

	if page.devtools {
		let yes = NSNumber::numberWithBool(true);
		// SAFETY: `developerExtrasEnabled` is a boolean KVC key WKPreferences
		// understands (private but stable; wry ships the same call).
		unsafe {
			config
				.preferences()
				.setValue_forKey(Some(&yes), ns_string!("developerExtrasEnabled"));
		}
	}

	// IPC shim first, then user init scripts in order — all at document
	// start, all frames — so `window.ipc` exists before any of them run.
	// SAFETY: reading the fresh config's controller on the main thread.
	let manager = unsafe { config.userContentController() };
	let ipc = IpcHandler::new(&manager, events, mtm);
	for script in iter::once(IPC_SHIM).chain(page.init_scripts.iter().map(Str::as_str)) {
		add_user_script(&manager, script, mtm);
	}

	ConfiguredPage { config, manager, ipc }
}

/// Appends `script` to `manager` (document start, all frames).
pub fn add_user_script(manager: &WKUserContentController, script: &str, mtm: MainThreadMarker) {
	// SAFETY: designated WKUserScript initializer with a valid source string
	// on the main thread.
	let user_script = unsafe {
		WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
			WKUserScript::alloc(mtm),
			&NSString::from_str(script),
			WKUserScriptInjectionTime::AtDocumentStart,
			false,
		)
	};
	// SAFETY: appending the freshly created script to the controller.
	unsafe { manager.addUserScript(&user_script) };
}

/// Applies per-instance page styling shared by both surfaces: transparency
/// or a solid background color, a custom user agent, and inspectability.
pub fn style_webview(webview: &WKWebView, page: &PageOptions) {
	if page.transparent {
		// Runtime half of the transparency dance: the instance-level
		// `drawsBackground` KVC key plus a clear overscroll color.
		// SAFETY: same private-but-stable `drawsBackground` KVC key as on
		// the config; `setOpaque:`/`setUnderPageBackgroundColor:` are only
		// sent after respondsToSelector confirms the receiver handles them.
		unsafe {
			let no = NSNumber::numberWithBool(false);
			webview.setValue_forKey(Some(&no), ns_string!("drawsBackground"));
			if webview.respondsToSelector(sel!(setOpaque:)) {
				let () = msg_send![webview, setOpaque: false];
			}
			if webview.respondsToSelector(sel!(setUnderPageBackgroundColor:)) {
				webview.setUnderPageBackgroundColor(Some(&NSColor::clearColor()));
			}
		}
	} else if let Some([r, g, b, a]) = page.background {
		// Solid background: paint the overscroll/under-page area since
		// `drawsBackground` is already disabled on the config.
		let color = NSColor::colorWithSRGBRed_green_blue_alpha(
			f64::from(r) / 255.0,
			f64::from(g) / 255.0,
			f64::from(b) / 255.0,
			f64::from(a) / 255.0,
		);
		if webview.respondsToSelector(sel!(setUnderPageBackgroundColor:)) {
			// SAFETY: selector presence checked on the line above.
			unsafe { webview.setUnderPageBackgroundColor(Some(&color)) };
		}
	}

	if let Some(user_agent) = &page.user_agent {
		// SAFETY: overriding the UA string with a valid NSString.
		unsafe { webview.setCustomUserAgent(Some(&NSString::from_str(user_agent))) };
	}

	// `isInspectable` (macOS 13.3+) gates Safari Web Inspector access; the
	// config-level `developerExtrasEnabled` key is set in `configure_page`.
	if page.devtools && webview.respondsToSelector(sel!(setInspectable:)) {
		// SAFETY: selector presence checked on the line above (macOS 13.3+).
		unsafe { webview.setInspectable(true) };
	}
}

/// Wires the shared navigation delegate and title KVO observer of `webview`
/// to `events` and `state`; the caller keeps both retained. `finished`, when
/// set, additionally runs on the main thread after every finished navigation
/// (the frames surface uses it to defer capture start until the initial page
/// is up).
pub fn install_observers(
	webview: &Retained<WKWebView>,
	events: flume::Sender<WebViewEvent>,
	state: SharedState,
	finished: Option<Box<dyn Fn()>>,
	mtm: MainThreadMarker,
) -> (Retained<NavDelegate>, Retained<TitleObserver>) {
	let nav = NavDelegate::new(events.clone(), state.clone(), finished, mtm);
	// SAFETY: `nav` conforms to WKNavigationDelegate; WebKit holds it weakly
	// and the surface keeps it retained for the webview's lifetime.
	unsafe { webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*nav))) };
	let title = TitleObserver::new(webview.clone(), events, state);
	(nav, title)
}

/// Navigate `webview` to `url`.
pub fn navigate(webview: &WKWebView, url: &str) -> Result<()> {
	let ns_url = NSURL::URLWithString(&NSString::from_str(url))
		.ok_or_else(|| Error::Protocol(sf!("invalid url: {url}")))?;
	let request = NSURLRequest::requestWithURL(&ns_url);
	// SAFETY: starting a load with a valid request; returned navigation
	// token is unused.
	let _ = unsafe { webview.loadRequest(&request) };
	Ok(())
}

/// Replace the document of `webview` with `html` (null origin).
pub fn load_html(webview: &WKWebView, html: &str) {
	// SAFETY: loading a valid HTML string with a nil base URL (null origin).
	let _ = unsafe { webview.loadHTMLString_baseURL(&NSString::from_str(html), None) };
}

/// Start the initial load per `page` precedence: url > html > `about:blank`.
pub fn initial_load(webview: &WKWebView, page: &PageOptions) -> Result<()> {
	match (&page.url, &page.html) {
		(Some(url), _) => navigate(webview, url),
		(None, Some(html)) => {
			load_html(webview, html);
			Ok(())
		},
		(None, None) => navigate(webview, "about:blank"),
	}
}

/// Evaluate `js` on `webview`; when `reply` is set it receives the
/// JSON-encoded result (string results quoted, everything else via
/// `NSJSONSerialization` with fragments allowed) on the main thread.
pub fn eval(webview: &WKWebView, js: &str, reply: Option<Box<dyn FnOnce(Str) + Send>>) {
	let js = NSString::from_str(js);
	match reply {
		// SAFETY: evaluating a valid script with no completion handler.
		None => unsafe { webview.evaluateJavaScript_completionHandler(&js, None) },
		Some(reply) => {
			// The completion block is `Fn`, our callback `FnOnce`: park it
			// in a Mutex<Option<..>> and take it on the single invocation.
			let reply = Mutex::new(Some(reply));
			let handler = block2::RcBlock::new(
				move |val: *mut AnyObject, _err: *mut objc2_foundation::NSError| {
					let Some(reply) = reply.lock().take() else {
						return;
					};
					// SAFETY: WebKit passes null or a valid result object
					// to the completion block, exactly the contract of
					// `json_of_eval_result`.
					reply(unsafe { json_of_eval_result(val) });
				},
			);
			// SAFETY: evaluating a valid script; the RcBlock is copied by
			// WebKit and outlives this scope.
			unsafe {
				webview.evaluateJavaScript_completionHandler(&js, Some(&handler));
			};
		},
	}
}

/// Ivars of [`IpcHandler`]: the channel IPC payloads are forwarded onto.
pub struct IpcHandlerIvars {
	/// View event channel; send failures mean the host hung up and are ignored.
	events: flume::Sender<WebViewEvent>,
}

define_class!(
	/// `WKScriptMessageHandler` receiving `window.ipc.postMessage` payloads and
	/// forwarding them as [`WebViewEvent::Ipc`].
	#[unsafe(super(NSObject))]
	#[thread_kind = MainThreadOnly]
	#[ivars = IpcHandlerIvars]
	pub(super) struct IpcHandler;

	unsafe impl NSObjectProtocol for IpcHandler {}

	unsafe impl WKScriptMessageHandler for IpcHandler {
		/// Entry point for messages posted to `webkit.messageHandlers.ipc`.
		#[unsafe(method(userContentController:didReceiveScriptMessage:))]
		fn did_receive(&self, _controller: &WKUserContentController, msg: &WKScriptMessage) {
			// Only string bodies participate in the IPC contract; other types
			// (numbers, objects) are silently dropped like in wry.
			// SAFETY: `msg` is a live WKScriptMessage delivered by WebKit on
			// the main thread; `body` returns a retained plist object.
			let body = unsafe { msg.body() };
			if let Ok(body) = body.downcast::<NSString>() {
				let _ = self.ivars().events.send(WebViewEvent::Ipc(sf!("{body}")));
			}
		}
	}
);

impl IpcHandler {
	/// Allocates the handler and registers it on `controller` under `ipc`.
	fn new(
		controller: &WKUserContentController,
		events: flume::Sender<WebViewEvent>,
		mtm: MainThreadMarker,
	) -> Retained<Self> {
		let this = mtm.alloc::<Self>().set_ivars(IpcHandlerIvars { events });
		// SAFETY: plain NSObject `init` on a freshly allocated instance.
		let this: Retained<Self> = unsafe { msg_send![super(this), init] };
		// SAFETY: `this` conforms to WKScriptMessageHandler; the controller
		// retains it and the owning surface removes it again by name on drop.
		unsafe {
			controller
				.addScriptMessageHandler_name(ProtocolObject::from_ref(&*this), ns_string!("ipc"));
		}
		this
	}
}

/// Ivars of [`NavDelegate`]: event channel plus the shared url/title cache.
pub struct NavDelegateIvars {
	/// View event channel; send failures mean the host hung up and are ignored.
	events:   flume::Sender<WebViewEvent>,
	/// Shared url/title state kept current as navigations progress.
	state:    SharedState,
	/// Optional main-thread hook run after every finished navigation.
	finished: Option<Box<dyn Fn()>>,
}

define_class!(
	/// `WKNavigationDelegate` translating WebKit navigation callbacks into
	/// [`WebViewEvent`]s and keeping [`SharedState`] current.
	#[unsafe(super(NSObject))]
	#[thread_kind = MainThreadOnly]
	#[ivars = NavDelegateIvars]
	pub(super) struct NavDelegate;

	unsafe impl NSObjectProtocol for NavDelegate {}

	unsafe impl WKNavigationDelegate for NavDelegate {
		/// A page began loading.
		#[unsafe(method(webView:didStartProvisionalNavigation:))]
		fn did_start(&self, webview: &WKWebView, _navigation: &WKNavigation) {
			let _ = self
				.ivars()
				.events
				.send(WebViewEvent::LoadStarted(current_url(webview)));
		}

		/// A navigation committed: the new document is now current.
		#[unsafe(method(webView:didCommitNavigation:))]
		fn did_commit(&self, webview: &WKWebView, _navigation: &WKNavigation) {
			let url = current_url(webview);
			tracing::debug!(scheme = crate::navigation_scheme(&url), "webview navigation committed");
			self.ivars().state.lock().url = url.clone();
			let _ = self.ivars().events.send(WebViewEvent::Navigated(url));
		}

		/// The page finished loading; also refresh the cached title, since the
		/// title KVO may fire before the final document title settles.
		#[unsafe(method(webView:didFinishNavigation:))]
		fn did_finish(&self, webview: &WKWebView, _navigation: &WKNavigation) {
			self.ivars().state.lock().title = current_title(webview);
			let _ = self
				.ivars()
				.events
				.send(WebViewEvent::LoadFinished(current_url(webview)));
			if let Some(finished) = &self.ivars().finished {
				finished();
			}
		}
	}
);

impl NavDelegate {
	/// Allocates the delegate; the caller installs it via
	/// `setNavigationDelegate`.
	fn new(
		events: flume::Sender<WebViewEvent>,
		state: SharedState,
		finished: Option<Box<dyn Fn()>>,
		mtm: MainThreadMarker,
	) -> Retained<Self> {
		let this = mtm
			.alloc::<Self>()
			.set_ivars(NavDelegateIvars { events, state, finished });
		// SAFETY: plain NSObject `init` on a freshly allocated instance.
		unsafe { msg_send![super(this), init] }
	}
}

/// Ivars of [`TitleObserver`]: the observed webview (retained so the KVO
/// registration can always be undone) plus event channel and state cache.
pub struct TitleObserverIvars {
	/// The observed webview; retained until the observer unregisters in `Drop`.
	webview: Retained<WKWebView>,
	/// View event channel; send failures mean the host hung up and are ignored.
	events:  flume::Sender<WebViewEvent>,
	/// Shared url/title state kept current as the title changes.
	state:   SharedState,
}

define_class!(
	/// KVO observer on the webview's `title` key path (wry's
	/// `DocumentTitleChangedObserver`), emitting [`WebViewEvent::TitleChanged`].
	#[unsafe(super(NSObject))]
	#[ivars = TitleObserverIvars]
	pub(super) struct TitleObserver;

	unsafe impl NSObjectProtocol for TitleObserver {}

	/// NSKeyValueObserving callback.
	impl TitleObserver {
		/// Fires whenever the observed `title` key path changes.
		#[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
		fn observe_value(
			&self,
			key_path: Option<&NSString>,
			of_object: Option<&AnyObject>,
			_change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
			_context: *mut std::ffi::c_void,
		) {
			let observed = key_path.is_some_and(|k| k.isEqualToString(ns_string!("title")));
			if observed && of_object.is_some() {
				let title = current_title(&self.ivars().webview);
				self.ivars().state.lock().title = title.clone();
				let _ = self.ivars().events.send(WebViewEvent::TitleChanged(title));
			}
		}
	}
);

impl TitleObserver {
	/// Allocates the observer and registers it for `title` changes on `webview`.
	fn new(
		webview: Retained<WKWebView>,
		events: flume::Sender<WebViewEvent>,
		state: SharedState,
	) -> Retained<Self> {
		let this = Self::alloc().set_ivars(TitleObserverIvars { webview, events, state });
		// SAFETY: plain NSObject `init` on a freshly allocated instance.
		let this: Retained<Self> = unsafe { msg_send![super(this), init] };
		// SAFETY: KVO on the retained webview's `title` key with a null
		// context; the registration is undone in `Drop` before either side
		// deallocates.
		unsafe {
			this.ivars().webview.addObserver_forKeyPath_options_context(
				&this,
				ns_string!("title"),
				NSKeyValueObservingOptions::New,
				ptr::null_mut(),
			);
		}
		this
	}
}

impl Drop for TitleObserver {
	fn drop(&mut self) {
		// Unregister before the retained webview goes away; a live KVO
		// registration on a deallocating object aborts the process.
		// SAFETY: removes the registration made in `new`; `self` and the
		// retained webview are both still alive here.
		unsafe {
			self
				.ivars()
				.webview
				.removeObserver_forKeyPath(self, ns_string!("title"));
		};
	}
}

/// Converts an `evaluateJavaScript` completion value into JSON text matching
/// the remote engines' `eval` replies: `nil` as `null`, `NSString` results
/// JSON-encoded (quoted), anything else serialized with `NSJSONSerialization`
/// allowing fragments (numbers, booleans, null).
///
/// # Safety
///
/// `val` must be null or a valid Objective-C object pointer, as delivered by
/// `WebKit` to the completion handler.
unsafe fn json_of_eval_result(val: *mut AnyObject) -> Str {
	if val.is_null() {
		return Str::new("null");
	}
	// SAFETY: non-null per the check above; validity per this fn's contract.
	let val = unsafe { &*val };
	if let Some(s) = val.downcast_ref::<NSString>() {
		// JSON-encode so string results arrive quoted, like CDP/BiDi replies.
		return serde_json::to_string(&*s.to_string())
			.map(Str::new)
			.unwrap_or_default();
	}
	// SAFETY: `val` is a valid object; non-plist objects yield Err, not UB.
	let Ok(data) = (unsafe {
		NSJSONSerialization::dataWithJSONObject_options_error(
			val,
			NSJSONWritingOptions::FragmentsAllowed,
		)
	}) else {
		return Str::default();
	};
	NSString::initWithData_encoding(NSString::alloc(), &data, NSUTF8StringEncoding)
		.map(|s| sf!("{s}"))
		.unwrap_or_default()
}
