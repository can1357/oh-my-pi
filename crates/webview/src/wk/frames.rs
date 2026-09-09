//! `WKWebView` frames surface: invisible window + capture (macOS).
//!
//! The webview renders inside a borderless, never-focusable `NSWindow` and
//! the host receives RGBA frames plus explicit input forwarding. Two capture
//! tiers, decided once when the first navigation finishes (recorded in
//! [`WkFrames::capture`]):
//!
//! - **`ScreenCaptureKit`** when the process already holds Screen Recording
//!   permission (`CGPreflightScreenCaptureAccess`; creation never prompts — see
//!   [`request_screen_capture`](super::request_screen_capture)): an `SCStream`
//!   over `SCContentFilter(desktopIndependentWindow:)` delivers BGRA pixel
//!   buffers on a dispatch queue; frames are swizzled to RGBA and diffed for
//!   damage. Any setup failure silently falls back to polling. SCK self-gates:
//!   it only emits frames when the window content changes, so static pages cost
//!   nothing. Captured pixels are color-managed by the window server (CSS
//!   `#ff0000` arrives as the display profile's rendition, e.g. `(234, 51,
//!   35)`), consistently across frames.
//! - **`takeSnapshot` polling** otherwise: an `NSTimer` on the main run loop
//!   drives `takeSnapshotWithConfiguration`, gated by an injected
//!   dirty-detector script (the firefox backend's policy): full rate only while
//!   the page signals changes or captures keep differing, with a 1 Hz safety
//!   net for silent changes (canvas, video). Unchanged captures are suppressed
//!   entirely by the frame diff.
//!
//! Capture arms only after the first finished navigation clears a two-stage
//! paint barrier (see `arm_capture`), so the first delivered frame shows the
//! loaded page — matching the remote engines, whose capture also starts after
//! the initial navigation.
//!
//! # Window arrangement (empirical)
//!
//! Probed on macOS 26 (Apple Silicon), same findings for both capture paths:
//!
//! - **Ordered out entirely** (never ordered): dead. `SCShareableContent` does
//!   not list the window and `takeSnapshot` produces no image — zero frames
//!   delivered.
//! - **Positioned fully offscreen (far negative coordinates) and ordered via
//!   `orderFrontRegardless`** — the arrangement used here: the window server
//!   knows the window, `SCShareableContent` lists it (with
//!   `onScreenWindowsOnly: false`), `desktopIndependentWindow` streams it, and
//!   `takeSnapshot` returns real content. One caveat, handled in `create`:
//!   `WebKit`'s window-occlusion detection treats the offscreen window as
//!   invisible and suspends painting ~1 s after activity, blanking both capture
//!   paths; the private-but-stable `_setWindowOcclusionDetectionEnabled:`
//!   toggle (set via KVC, presence checked first) disables that.
//! - **Zero `alphaValue`** (ordered, offscreen or not): broken for SCK — the
//!   window server stops publishing updates for fully transparent windows, so
//!   the stream emits its start frame and then nothing.
//!
//! Ordering the borderless window in a background (non-activated) process
//! never activates the app or steals focus; combined with
//! `ignoresMouseEvents`, exclusion from window cycling and Mission Control,
//! and the offscreen position, the window is never visible to or focusable
//! by the user.
//!
//! # Hosting contract
//!
//! [`WkFrames::create`] must run on the main thread and the host must keep
//! pumping the main run loop (a winit event loop, or explicit
//! `NSRunLoop::runMode:beforeDate:` pumping): `WebKit` delivers delegate
//! callbacks, snapshot completions, and timer ticks there.

use std::{
	cell::{Cell, RefCell},
	ptr,
	rc::Rc,
	slice,
	sync::Arc,
	time::{Duration, Instant},
};

use block2::RcBlock;
use bytes::Bytes;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::{
	AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
	rc::Retained,
	runtime::{AnyObject, NSObject, ProtocolObject},
	sel,
};
use objc2_app_kit::{
	NSApplication, NSBackingStoreType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSEvent,
	NSEventModifierFlags, NSEventType, NSGraphicsContext, NSImage, NSWindow,
	NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_core_video::{
	CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
	CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
	CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelFormatType_32BGRA,
};
use objc2_foundation::{
	NSDefaultRunLoopMode, NSError, NSNumber, NSObjectNSKeyValueCoding, NSObjectProtocol, NSPoint,
	NSProcessInfo, NSRect, NSRunLoop, NSSize, NSString, NSTimer, ns_string,
};
use objc2_screen_capture_kit::{
	SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate,
	SCStreamOutput, SCStreamOutputType, SCWindow,
};
use objc2_web_kit::{
	WKContentWorld, WKScriptMessage, WKScriptMessageHandler, WKSnapshotConfiguration,
	WKUserContentController, WKWebView,
};
use omp_core::{Str, sf};
use parking_lot::Mutex;

use super::{
	ConfiguredPage, IpcHandler, NavDelegate, TitleObserver, add_user_script, check_main,
	configure_page, eval, initial_load, install_observers, load_html, navigate,
	preflight_screen_capture, style_webview,
};
use crate::{
	error::{Error, Result},
	event::{Frame, SharedState, WebViewEvent},
	input::{Input, Key, Modifiers, MouseButton},
	options::{FrameConfig, PageOptions},
	remote::damage_rect,
};

/// Dirty-detector script (the firefox backend's `DIRTY_SCRIPT`, retargeted at
/// the `WebKit` message handler registered as `omp_dirty`): marks the page
/// dirty on mutations, scroll, input, and animation starts, throttled
/// page-side. Long-running animations need no repeat signals — a capture that
/// finds damage keeps the poller hot.
const DIRTY_SCRIPT: &str =
	"(()=>{const chan=s=>window.webkit.messageHandlers.omp_dirty.postMessage(s);let last=0;const \
	 mark=()=>{const t=Date.now();if(t-last>40){last=t;chan('d')}};new \
	 MutationObserver(mark).observe(document,{subtree:true,childList:true,attributes:true,\
	 characterData:true});for(const ev of \
	 ['scroll','input','pointermove','pointerdown','keydown','wheel','transitionrun','\
	 animationstart','load','resize'])addEventListener(ev,mark,{capture:true,passive:true})})();";

/// Invariant wheel-event setup surrounding the event coordinates and deltas.
const SCROLL_EVENT_TEMPLATE: &str =
	"||document.documentElement;if(t.dispatchEvent(new WheelEvent('wheel',{clientX:";
/// Invariant wheel-event tail and default scrolling action.
const SCROLL_ACTION_TEMPLATE: &str = ",bubbles:true,cancelable:true})))window.scrollBy(";

/// Idle safety-net poll period for the snapshot path, catching silent changes
/// (canvas, WebGL, video) that fire no DOM events; one damaged capture
/// re-arms full rate. Mirrors the firefox backend.
const IDLE_POLL: Duration = Duration::from_secs(1);

/// Bounded wait for `ScreenCaptureKit`'s asynchronous setup steps (shareable
/// content enumeration, stream start). The completions run on internal
/// queues — never the main queue — so blocking the main thread here cannot
/// deadlock; expiry just falls back to snapshot polling.
const SCK_TIMEOUT: Duration = Duration::from_secs(5);

/// How far offscreen the invisible host window sits (logical points, below
/// the primary screen's bottom-left origin). Far enough that no plausible
/// display arrangement reaches it.
const OFFSCREEN: f64 = -20_000.0;

/// Cross-thread frame fan-out shared by both capture paths: suppresses
/// identical frames and tightens the damage rect against the previously
/// delivered frame (full rect on the first frame and after a resize, which
/// [`reset`](Self::reset)s the comparison base).
struct FrameSink {
	/// View event channel; send failures mean the host hung up and are ignored.
	events: flume::Sender<WebViewEvent>,
	/// Last delivered frame pixels, for duplicate suppression.
	last:   Mutex<Option<Bytes>>,
}

impl FrameSink {
	/// Diff `data` (tight RGBA8 rows) against the last delivered frame and
	/// emit a [`WebViewEvent::Frame`] unless nothing changed; returns whether
	/// a frame was delivered.
	fn deliver(&self, width: u32, height: u32, data: Vec<u8>) -> bool {
		let data = Bytes::from(data);
		let mut last = self.last.lock();
		let mut damage = [0, 0, width, height];
		if let Some(prev) = last.as_ref()
			&& prev.len() == data.len()
		{
			match damage_rect(prev, &data, width) {
				Some(rect) => damage = rect,
				None => return false,
			}
		}
		*last = Some(data.clone());
		let _ = self
			.events
			.send(WebViewEvent::Frame(Frame { width, height, data, damage }));
		true
	}

	/// Forget the comparison base so the next frame carries full damage.
	fn reset(&self) {
		*self.last.lock() = None;
	}
}

/// Ivars of [`DirtyHandler`]: the flag flipped on every page dirty ping.
struct DirtyHandlerIvars {
	/// Set when the page signals a likely visual change; consumed by the
	/// snapshot poll loop (ignored under `ScreenCaptureKit`, which self-gates).
	dirty: Rc<Cell<bool>>,
}

define_class!(
	/// `WKScriptMessageHandler` for [`DIRTY_HANDLER`] pings.
	#[unsafe(super(NSObject))]
	#[thread_kind = MainThreadOnly]
	#[ivars = DirtyHandlerIvars]
	struct DirtyHandler;

	unsafe impl NSObjectProtocol for DirtyHandler {}

	unsafe impl WKScriptMessageHandler for DirtyHandler {
		/// Entry point for `webkit.messageHandlers.omp_dirty` pings.
		#[unsafe(method(userContentController:didReceiveScriptMessage:))]
		fn did_receive(&self, _controller: &WKUserContentController, _msg: &WKScriptMessage) {
			self.ivars().dirty.set(true);
		}
	}
);

impl DirtyHandler {
	/// Allocates the handler and registers it on `controller` under
	/// [`DIRTY_HANDLER`].
	fn new(
		controller: &WKUserContentController,
		dirty: Rc<Cell<bool>>,
		mtm: MainThreadMarker,
	) -> Retained<Self> {
		let this = mtm.alloc::<Self>().set_ivars(DirtyHandlerIvars { dirty });
		// SAFETY: plain NSObject `init` on a freshly allocated instance.
		let this: Retained<Self> = unsafe { msg_send![super(this), init] };
		// SAFETY: `this` conforms to WKScriptMessageHandler; the controller
		// retains it and `WkFrames::drop` removes it again by name.
		unsafe {
			controller.addScriptMessageHandler_name(
				ProtocolObject::from_ref(&*this),
				ns_string!("omp_dirty"),
			);
		}
		this
	}
}

/// Ivars of [`FrameTap`]: the shared frame sink.
struct FrameTapIvars {
	/// Fan-out for swizzled frames; `Send + Sync` (called from the stream's
	/// dispatch queue).
	sink: Arc<FrameSink>,
}

define_class!(
	/// `SCStreamOutput` receiving BGRA sample buffers on a dispatch queue and
	/// forwarding RGBA frames through the [`FrameSink`].
	#[unsafe(super(NSObject))]
	#[ivars = FrameTapIvars]
	struct FrameTap;

	unsafe impl NSObjectProtocol for FrameTap {}

	unsafe impl SCStreamOutput for FrameTap {
		/// One captured sample: swizzle BGRA→RGBA and hand off to the sink.
		#[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
		fn did_output(&self, _stream: &SCStream, buffer: &CMSampleBuffer, kind: SCStreamOutputType) {
			if kind != SCStreamOutputType::Screen {
				return;
			}
			// SAFETY: `buffer` is a live sample buffer delivered by
			// ScreenCaptureKit; status-only buffers yield None and are skipped.
			let Some(pixels) = (unsafe { buffer.image_buffer() }) else {
				return;
			};
			if CVPixelBufferGetPixelFormatType(&pixels) != kCVPixelFormatType_32BGRA {
				return;
			}
			// SAFETY: read-only lock on a live pixel buffer; unlocked below.
			if unsafe { CVPixelBufferLockBaseAddress(&pixels, CVPixelBufferLockFlags::ReadOnly) } != 0
			{
				return;
			}
			let width = CVPixelBufferGetWidth(&pixels);
			let height = CVPixelBufferGetHeight(&pixels);
			let stride = CVPixelBufferGetBytesPerRow(&pixels);
			let base = CVPixelBufferGetBaseAddress(&pixels)
				.cast_const()
				.cast::<u8>();
			if !base.is_null() && stride >= width * 4 {
				let mut rgba = vec![0u8; width * height * 4];
				for row in 0..height {
					// SAFETY: the base address is locked and covers `height`
					// rows of `stride` bytes each; `stride >= width * 4` was
					// checked above.
					let src = unsafe { std::slice::from_raw_parts(base.add(row * stride), width * 4) };
					let dst = &mut rgba[row * width * 4..][..width * 4];
					for (d, s) in dst
						.as_chunks_mut::<4>()
						.0
						.iter_mut()
						.zip(src.as_chunks::<4>().0)
					{
						*d = [s[2], s[1], s[0], s[3]];
					}
				}
				#[allow(clippy::cast_possible_truncation, reason = "capture dims fit u32")]
				self.ivars().sink.deliver(width as u32, height as u32, rgba);
			}
			// SAFETY: undoes the read-only lock taken above.
			unsafe { CVPixelBufferUnlockBaseAddress(&pixels, CVPixelBufferLockFlags::ReadOnly) };
		}
	}
);

impl FrameTap {
	/// Allocates a tap forwarding frames into `sink`.
	fn new(sink: Arc<FrameSink>) -> Retained<Self> {
		let this = Self::alloc().set_ivars(FrameTapIvars { sink });
		// SAFETY: plain NSObject `init` on a freshly allocated instance.
		unsafe { msg_send![super(this), init] }
	}
}

/// Ivars of [`StreamDelegate`]: the event channel for stream failures.
struct StreamDelegateIvars {
	/// View event channel; send failures mean the host hung up and are ignored.
	events: flume::Sender<WebViewEvent>,
}

define_class!(
	/// `SCStreamDelegate` translating stream termination into
	/// [`WebViewEvent::Crashed`].
	#[unsafe(super(NSObject))]
	#[ivars = StreamDelegateIvars]
	struct StreamDelegate;

	unsafe impl NSObjectProtocol for StreamDelegate {}

	unsafe impl SCStreamDelegate for StreamDelegate {
		/// The stream died (window gone, capture revoked, ...).
		#[unsafe(method(stream:didStopWithError:))]
		fn did_stop(&self, _stream: &SCStream, error: &NSError) {
			tracing::warn!("screen capture device stopped unexpectedly");
			let _ = self
				.ivars()
				.events
				.send(WebViewEvent::Crashed(sf!("{}", error.localizedDescription())));
		}
	}
);

impl StreamDelegate {
	/// Allocates a delegate reporting failures onto `events`.
	fn new(events: flume::Sender<WebViewEvent>) -> Retained<Self> {
		let this = Self::alloc().set_ivars(StreamDelegateIvars { events });
		// SAFETY: plain NSObject `init` on a freshly allocated instance.
		unsafe { msg_send![super(this), init] }
	}
}

/// Everything the `ScreenCaptureKit` capture path retains.
struct Sck {
	/// The live capture stream.
	stream:    Retained<SCStream>,
	/// Stream configuration, updated in place on resize.
	config:    Retained<SCStreamConfiguration>,
	/// Frame tap; removed from the stream on drop.
	tap:       Retained<FrameTap>,
	/// Stream delegate (`didStopWithError` → `Crashed`); SCK holds it weakly.
	_delegate: Retained<StreamDelegate>,
	/// Serial delivery queue for the tap.
	_queue:    DispatchRetained<DispatchQueue>,
}

/// Main-thread state driving the `takeSnapshot` polling loop.
struct SnapState {
	/// The captured webview.
	webview:      Retained<WKWebView>,
	/// Frame fan-out (dedupe + damage).
	sink:         Arc<FrameSink>,
	/// Page signalled a likely change since the last capture (shared with
	/// [`DirtyHandler`]).
	dirty:        Rc<Cell<bool>>,
	/// A snapshot is in flight; ticks are skipped until it completes.
	pending:      Cell<bool>,
	/// When the last snapshot was requested (idle safety-net pacing).
	last_capture: Cell<Option<Instant>>,
	/// Requested frame pixel dimensions, kept current by `resize`.
	px:           Cell<(u32, u32)>,
}

/// How captured pixels leave the invisible window; decided once when the
/// first navigation finishes (see [`start_capture`]) and recorded here.
enum CaptureMode {
	/// `ScreenCaptureKit` window stream (Screen Recording permission held and
	/// setup succeeded). Self-gating: SCK only delivers changed frames.
	Sck(Sck),
	/// Main-run-loop `takeSnapshot` polling (no permission, or SCK setup
	/// failed), dirty-gated per the module docs.
	Snapshot {
		/// Repeating poll timer on the main run loop.
		timer: Retained<NSTimer>,
		/// Poll pacing/dedup state shared with the timer block.
		state: Rc<SnapState>,
	},
}

/// The capture tier, armed by the first finished navigation. Capture starts
/// only then — matching the remote engines, whose screencast/polling begins
/// after the initial navigation — so the first delivered frame shows the
/// loaded page rather than the blank pre-load webview.
type SharedCapture = Rc<RefCell<Option<CaptureMode>>>;

/// A `WKWebView` rendering in an invisible window, streaming captured RGBA
/// frames with explicit input forwarding.
///
/// `!Send` by construction (holds `Retained` `AppKit` objects); every method
/// additionally verifies the main thread and fails with [`Error::MainThread`].
pub struct WkFrames {
	/// The captured webview (the window's content view).
	webview:   Retained<WKWebView>,
	/// The invisible host window.
	window:    Retained<NSWindow>,
	/// The configuration's user-content controller (scripts + handlers).
	manager:   Retained<WKUserContentController>,
	/// Keeps the IPC handler alive; unregistered by name in `Drop`.
	_ipc:      Retained<IpcHandler>,
	/// Keeps the dirty handler alive; unregistered by name in `Drop`.
	_dirty:    Retained<DirtyHandler>,
	/// Keeps the navigation delegate alive (`WebKit` only holds a weak ref).
	_nav:      Retained<NavDelegate>,
	/// Keeps the title KVO observer alive; unregisters itself on drop.
	_title:    Retained<TitleObserver>,
	/// Frame fan-out shared with the active capture path.
	sink:      Arc<FrameSink>,
	/// The capture tier once armed; `None` until the first load finishes.
	capture:   SharedCapture,
	/// Device scale factor frames are captured at.
	scale:     f64,
	/// Monotonic event number for synthesized mouse events.
	event_seq: Cell<isize>,
}

impl WkFrames {
	/// Builds the webview per `page` inside an invisible window sized
	/// `config.width x config.height` logical points, picks the capture tier
	/// (see module docs), wires delegates/observers to `events` and `state`,
	/// and starts the initial load.
	///
	/// Must run on the main thread ([`Error::MainThread`] otherwise) and the
	/// host must keep pumping the main run loop afterwards.
	pub(crate) fn create(
		page: &PageOptions,
		config: FrameConfig,
		events: flume::Sender<WebViewEvent>,
		state: SharedState,
	) -> Result<Self> {
		let mtm = MainThreadMarker::new().ok_or(Error::MainThread)?;
		// Make AppKit usable from a plain CLI process (idempotent). Never
		// touch the activation policy or run state: winit hosts own NSApp.
		let _app = NSApplication::sharedApplication(mtm);

		let ConfiguredPage { config: wk_config, manager, ipc } =
			configure_page(page, events.clone(), mtm);
		let dirty = Rc::new(Cell::new(true));
		let dirty_handler = DirtyHandler::new(&manager, dirty.clone(), mtm);
		add_user_script(&manager, DIRTY_SCRIPT, mtm);

		let (width, height) = (f64::from(config.width), f64::from(config.height));
		let content =
			CGRect { origin: CGPoint::new(OFFSCREEN, OFFSCREEN), size: CGSize::new(width, height) };
		// SAFETY: designated NSWindow initializer on the main thread with a
		// finite content rect.
		let window = unsafe {
			NSWindow::initWithContentRect_styleMask_backing_defer(
				mtm.alloc::<NSWindow>(),
				content,
				NSWindowStyleMask::Borderless,
				NSBackingStoreType::Buffered,
				false,
			)
		};
		// We hold the only strong reference; AppKit's implicit release on
		// `close` would double-free it.
		// SAFETY: flipping the retain policy before the window can close.
		unsafe { window.setReleasedWhenClosed(false) };
		window.setIgnoresMouseEvents(true);
		window.setAcceptsMouseMovedEvents(true);
		window.setHasShadow(false);
		window.setExcludedFromWindowsMenu(true);
		window.setCollectionBehavior(
			NSWindowCollectionBehavior::CanJoinAllSpaces
				| NSWindowCollectionBehavior::Stationary
				| NSWindowCollectionBehavior::IgnoresCycle
				| NSWindowCollectionBehavior::FullScreenAuxiliary,
		);

		// SAFETY: designated WKWebView initializer with a finite frame and
		// the fully configured `wk_config`, on the main thread.
		let webview = unsafe {
			WKWebView::initWithFrame_configuration(
				mtm.alloc::<WKWebView>(),
				CGRect { origin: CGPoint::new(0.0, 0.0), size: CGSize::new(width, height) },
				&wk_config,
			)
		};
		// The window lives offscreen, which WebKit's occlusion detection
		// treats as "not visible": ~1s after activity it suspends painting
		// and drops the layer contents, blanking both capture paths. Disable
		// the detection via the private-but-stable `WKWebView` toggle (KVC
		// resolves the key onto `_setWindowOcclusionDetectionEnabled:`).
		// SAFETY: selector presence is checked before the KVC write.
		unsafe {
			if webview.respondsToSelector(sel!(_setWindowOcclusionDetectionEnabled:)) {
				let no = NSNumber::numberWithBool(false);
				webview.setValue_forKey(Some(&no), ns_string!("windowOcclusionDetectionEnabled"));
			}
		}
		let scale = if config.scale.is_finite() && config.scale > 0.0 {
			config.scale
		} else {
			1.0
		};
		let sink = Arc::new(FrameSink { events: events.clone(), last: Mutex::new(None) });

		// Capture arms on the first finished navigation (idempotent); the
		// hook runs on the main thread from the navigation delegate.
		let capture: SharedCapture = Rc::new(RefCell::new(None));
		let spec = Rc::new(ArmSpec {
			webview: webview.clone(),
			window: window.clone(),
			scale,
			fps_cap: config.fps_cap,
			sink: sink.clone(),
			events: events.clone(),
			dirty,
			capture: Rc::clone(&capture),
		});
		let armed = Cell::new(false);
		let arm: Box<dyn Fn()> = Box::new(move || {
			if !armed.replace(true) {
				arm_capture(&spec);
			}
		});
		style_webview(&webview, page);

		window.setContentView(Some(&webview));
		let _ = window.makeFirstResponder(Some(&webview));
		// Order the window (offscreen) so the window server knows it: WKWebView
		// keeps painting and ScreenCaptureKit can find it. Does not activate
		// the app or steal focus (borderless + background process).
		window.orderFrontRegardless();

		let (nav, title) = install_observers(&webview, events, state, Some(arm), mtm);

		let view = Self {
			webview,
			window,
			manager,
			_ipc: ipc,
			_dirty: dirty_handler,
			_nav: nav,
			_title: title,
			sink,
			capture,
			scale,
			event_seq: Cell::new(0),
		};
		initial_load(&view.webview, page)?;
		Ok(view)
	}

	/// Navigate to `url`.
	pub(crate) fn navigate(&self, url: &str) -> Result<()> {
		check_main()?;
		navigate(&self.webview, url)
	}

	/// Replace the document with `html` (null origin).
	pub(crate) fn load_html(&self, html: &str) -> Result<()> {
		check_main()?;
		load_html(&self.webview, html);
		Ok(())
	}

	/// Evaluate `js`; when `reply` is set it receives the JSON-encoded result
	/// on the main thread.
	pub(crate) fn eval(&self, js: &str, reply: Option<Box<dyn FnOnce(Str) + Send>>) -> Result<()> {
		check_main()?;
		eval(&self.webview, js, reply);
		Ok(())
	}

	/// Reload the current page.
	pub(crate) fn reload(&self) -> Result<()> {
		check_main()?;
		// SAFETY: reloads the current page; navigation token unused.
		let _ = unsafe { self.webview.reload() };
		Ok(())
	}

	/// History back.
	pub(crate) fn back(&self) -> Result<()> {
		check_main()?;
		// SAFETY: no-op when there is no back item; navigation token unused.
		let _ = unsafe { self.webview.goBack() };
		Ok(())
	}

	/// History forward.
	pub(crate) fn forward(&self) -> Result<()> {
		check_main()?;
		// SAFETY: no-op when there is no forward item; navigation token unused.
		let _ = unsafe { self.webview.goForward() };
		Ok(())
	}

	/// Make the webview the invisible window's first responder.
	///
	/// The window itself stays unfocusable (borderless, offscreen, background
	/// process); this only affects in-page focus for forwarded input.
	pub(crate) fn focus(&self) -> Result<()> {
		check_main()?;
		let _ = self.window.makeFirstResponder(Some(&self.webview));
		Ok(())
	}

	/// Resize the surface to `width x height` logical points; the next frame
	/// carries full damage.
	pub(crate) fn resize(&self, width: u32, height: u32) -> Result<()> {
		check_main()?;
		self
			.window
			.setContentSize(NSSize::new(f64::from(width), f64::from(height)));
		let px = pixel_dims(width, height, self.scale);
		self.sink.reset();
		match &*self.capture.borrow() {
			Some(CaptureMode::Sck(sck)) => {
				// SAFETY: adjusting the retained configuration's output size,
				// then pushing it to the live stream (fire-and-forget: a
				// failed update keeps the previous size, which the sink's
				// length check treats as a full-damage change later).
				unsafe {
					sck.config.setWidth(px.0 as usize);
					sck.config.setHeight(px.1 as usize);
					sck.stream
						.updateConfiguration_completionHandler(&sck.config, None);
				}
			},
			Some(CaptureMode::Snapshot { state, .. }) => {
				state.px.set(px);
				state.dirty.set(true);
			},
			// Not armed yet: capture start reads the fresh window size.
			None => {},
		}
		Ok(())
	}

	/// Forward one synthetic input event to the page.
	///
	/// All paths verified against a live page (see the module docs' probe):
	///
	/// - **Mouse**: real `NSEvent`s dispatched through `window.sendEvent` (with
	///   the `AppKit` bottom-left y-flip); clicks hit-test, focus, and fire DOM
	///   handlers.
	/// - **Keys/text**: real `NSEvent`s delivered straight to the webview
	///   responder (`keyDown:`/`keyUp:`) — `NSWindow::sendEvent` is bypassed
	///   because it drops key events for non-key windows and this window can
	///   never become key. Characters commit into focused inputs, including
	///   [`Input::Text`], which sends the whole string as `characters` and
	///   commits via `WebKit`'s interpret-key-events path (the page observes one
	///   `keydown` whose `key` is the full string, then the text lands).
	/// - **Scroll**: a JS `WheelEvent` at the point plus `window.scrollBy` when
	///   not `preventDefault`ed. A real `NSEvent` would require wrapping a
	///   `CGEvent` scroll (`objc2-core-graphics` is not a dependency) whose
	///   location is screen-space and cannot hit-test against a window parked
	///   offscreen, so the JS path is the reliable one here; both `wheel`
	///   listeners and scrolling were verified.
	pub(crate) fn input(&self, input: Input) -> Result<()> {
		check_main()?;
		match input {
			Input::MouseMove { x, y } => {
				self.send_mouse(NSEventType::MouseMoved, x, y, 1, 0.0)?;
			},
			Input::MouseDown { button, x, y, clicks } => {
				let kind = match button {
					MouseButton::Left => NSEventType::LeftMouseDown,
					MouseButton::Middle => NSEventType::OtherMouseDown,
					MouseButton::Right => NSEventType::RightMouseDown,
				};
				self.send_mouse(kind, x, y, isize::from(clicks.max(1)), 1.0)?;
			},
			Input::MouseUp { button, x, y } => {
				let kind = match button {
					MouseButton::Left => NSEventType::LeftMouseUp,
					MouseButton::Middle => NSEventType::OtherMouseUp,
					MouseButton::Right => NSEventType::RightMouseUp,
				};
				self.send_mouse(kind, x, y, 1, 0.0)?;
			},
			Input::Scroll { x, y, dx, dy } => {
				// Scroll is one event per host gesture update. Keep all dynamic
				// values in one format pass; pointer movement takes a different path.
				let js = sf!(
					"(()=>{{const \
					 t=document.elementFromPoint({x},{y}){SCROLL_EVENT_TEMPLATE}{x},clientY:{y},deltaX:\
					 {dx},deltaY:{dy}{SCROLL_ACTION_TEMPLATE}{dx},{dy})}})()"
				);
				eval(&self.webview, &js, None);
			},
			Input::KeyDown { key, modifiers } => {
				let (code, chars) = key_params(key);
				self.send_key(NSEventType::KeyDown, &chars, code, modifier_flags(modifiers));
			},
			Input::KeyUp { key, modifiers } => {
				let (code, chars) = key_params(key);
				self.send_key(NSEventType::KeyUp, &chars, code, modifier_flags(modifiers));
			},
			Input::Text(text) => {
				// A key event whose `characters` is the whole string: WebKit's
				// interpret-key-events path inserts it like IME-committed text.
				self.send_key(NSEventType::KeyDown, &text, 0, NSEventModifierFlags::empty());
				self.send_key(NSEventType::KeyUp, &text, 0, NSEventModifierFlags::empty());
			},
		}
		Ok(())
	}

	/// Synthesize one mouse `NSEvent` at CSS-pixel `(x, y)` (top-left origin)
	/// and dispatch it through the window's normal event routing.
	fn send_mouse(
		&self,
		kind: NSEventType,
		x: f64,
		y: f64,
		clicks: isize,
		pressure: f32,
	) -> Result<()> {
		// AppKit windows have a bottom-left origin: flip y within the content
		// height (CSS px == logical points; scale only affects capture).
		let height = self.webview.frame().size.height;
		let location = NSPoint::new(x, height - y);
		let seq = self.event_seq.get() + 1;
		self.event_seq.set(seq);
		let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
			kind,
			location,
			NSEventModifierFlags::empty(),
			NSProcessInfo::processInfo().systemUptime(),
			self.window.windowNumber(),
			None,
			seq,
			clicks,
			pressure,
		)
		.ok_or(Error::Protocol(Str::new("failed to synthesize mouse event")))?;
		self.window.sendEvent(&event);
		Ok(())
	}

	/// Synthesize one key `NSEvent` and deliver it directly to the webview
	/// responder (bypasses the key-window check in `NSWindow::sendEvent`).
	fn send_key(&self, kind: NSEventType, chars: &str, code: u16, flags: NSEventModifierFlags) {
		let chars = NSString::from_str(chars);
		let Some(event) =
			NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
				kind,
				NSPoint::new(0.0, 0.0),
				flags,
				NSProcessInfo::processInfo().systemUptime(),
				self.window.windowNumber(),
				None,
				&chars,
				&chars,
				false,
				code,
			)
		else {
			return;
		};
		// SAFETY: NSResponder keyDown:/keyUp: with a fully formed key event
		// on the main thread; WKWebView handles both.
		unsafe {
			if kind == NSEventType::KeyDown {
				let () = msg_send![&*self.webview, keyDown: &*event];
			} else {
				let () = msg_send![&*self.webview, keyUp: &*event];
			}
		}
	}
}

impl Drop for WkFrames {
	fn drop(&mut self) {
		// `WkFrames` is !Send, so Drop runs on the main thread. Stop capture,
		// break the controller → handler retain edges, then close the window;
		// the title observer unregisters its KVO in its own Drop.
		match self.capture.borrow_mut().take() {
			Some(CaptureMode::Sck(sck)) => {
				// SAFETY: stopping our own live stream (fire-and-forget) and
				// removing the output we added in `try_sck`.
				unsafe {
					sck.stream.stopCaptureWithCompletionHandler(None);
					let _ = sck.stream.removeStreamOutput_type_error(
						ProtocolObject::from_ref(&*sck.tap),
						SCStreamOutputType::Screen,
					);
				}
			},
			Some(CaptureMode::Snapshot { timer, .. }) => timer.invalidate(),
			None => {},
		}
		// SAFETY: the handlers were registered under these names in `create`.
		unsafe {
			self
				.manager
				.removeScriptMessageHandlerForName(ns_string!("ipc"));
			self
				.manager
				.removeScriptMessageHandlerForName(ns_string!("omp_dirty"));
		}
		self.window.close();
	}
}

/// Frame pixel dimensions for a logical size at `scale`.
fn pixel_dims(width: u32, height: u32, scale: f64) -> (u32, u32) {
	#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "dims are small")]
	((f64::from(width) * scale).round() as u32, (f64::from(height) * scale).round() as u32)
}

/// `NSEventModifierFlags` for held [`Modifiers`].
fn modifier_flags(modifiers: Modifiers) -> NSEventModifierFlags {
	let mut flags = NSEventModifierFlags::empty();
	if modifiers.alt {
		flags |= NSEventModifierFlags::Option;
	}
	if modifiers.ctrl {
		flags |= NSEventModifierFlags::Control;
	}
	if modifiers.meta {
		flags |= NSEventModifierFlags::Command;
	}
	if modifiers.shift {
		flags |= NSEventModifierFlags::Shift;
	}
	flags
}

/// Virtual key code (`kVK_*`) and `characters` payload for a key identity.
///
/// Non-printing keys use the `NSEvent` function-key Unicode points (U+F700
/// block) `WebKit` expects in `characters`.
fn key_params(key: Key) -> (u16, Str) {
	/// `kVK_F1..kVK_F12` in order.
	const F_CODES: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
	match key {
		Key::Char(c) => (0, char_str(c)),
		Key::Enter => (36, Str::new("\r")),
		Key::Tab => (48, Str::new("\t")),
		Key::Backspace => (51, Str::new("\u{7f}")),
		Key::Delete => (117, Str::new("\u{f728}")),
		Key::Escape => (53, Str::new("\u{1b}")),
		Key::ArrowUp => (126, Str::new("\u{f700}")),
		Key::ArrowDown => (125, Str::new("\u{f701}")),
		Key::ArrowLeft => (123, Str::new("\u{f702}")),
		Key::ArrowRight => (124, Str::new("\u{f703}")),
		Key::Home => (115, Str::new("\u{f729}")),
		Key::End => (119, Str::new("\u{f72b}")),
		Key::PageUp => (116, Str::new("\u{f72c}")),
		Key::PageDown => (121, Str::new("\u{f72d}")),
		Key::F(n) => {
			let index = usize::from(n.clamp(1, 12) - 1);
			let chars = char::from_u32(0xf704 + u32::from(n.clamp(1, 12)) - 1)
				.map(char_str)
				.unwrap_or_default();
			(F_CODES[index], chars)
		},
	}
}

/// Convert one character to inline `Str` storage without invoking a formatter.
fn char_str(c: char) -> Str {
	let mut buf = [0; 4];
	Str::new(c.encode_utf8(&mut buf))
}

/// Everything the deferred capture start needs, captured by the arming hook.
struct ArmSpec {
	/// The captured webview.
	webview: Retained<WKWebView>,
	/// The invisible host window (for the window number and content size).
	window:  Retained<NSWindow>,
	/// Device scale factor frames are captured at.
	scale:   f64,
	/// Requested frame-rate cap.
	fps_cap: Option<f32>,
	/// Frame fan-out shared with the surface.
	sink:    Arc<FrameSink>,
	/// View event channel (stream-death reporting).
	events:  flume::Sender<WebViewEvent>,
	/// Dirty flag shared with the injected detector script.
	dirty:   Rc<Cell<bool>>,
	/// Where the started capture tier lands.
	capture: SharedCapture,
}

/// Arm capture behind a two-stage paint barrier so the first delivered frame
/// shows the loaded page rather than the blank pre-paint webview:
///
/// 1. a double `requestAnimationFrame` promise (raced with a 250 ms timeout in
///    case rendering-update callbacks are throttled) waits for the web process
///    to render the finished page, then
/// 2. a throwaway `takeSnapshot(afterScreenUpdates: true)` waits for that
///    rendering to be committed to the window backing store, where
///    `ScreenCaptureKit` reads from. The snapshot itself is discarded —
///    delivering it would seed damage diffing with a differently scaled
///    pipeline's pixels.
fn arm_capture(spec: &Rc<ArmSpec>) {
	let Some(mtm) = MainThreadMarker::new() else {
		return;
	};
	let painted_spec = Rc::clone(spec);
	let painted = RcBlock::new(move |_value: *mut AnyObject, _error: *mut NSError| {
		barrier_snapshot(&painted_spec);
	});
	// SAFETY: running a self-contained promise-returning function body in the
	// isolated client world of our own live webview; WebKit copies the block
	// and calls it once on the main thread (immediately with an error when
	// the page cannot run script — capture still starts, just unbarriered).
	unsafe {
		spec
			.webview
			.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
				ns_string!(
					"return new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(r)); \
					 setTimeout(r, 250); });"
				),
				None,
				None,
				&WKContentWorld::defaultClientWorld(mtm),
				Some(&painted),
			);
	}
}

/// Stage two of [`arm_capture`]: commit barrier, then capture start.
fn barrier_snapshot(spec: &Rc<ArmSpec>) {
	let Some(mtm) = MainThreadMarker::new() else {
		return;
	};
	// SAFETY: default snapshot configuration on the main thread; the barrier
	// only cares about `afterScreenUpdates`.
	let config = unsafe {
		let config = WKSnapshotConfiguration::new(mtm);
		config.setAfterScreenUpdates(true);
		config
	};
	let block_spec = Rc::clone(spec);
	let done = RcBlock::new(move |_image: *mut NSImage, error: *mut NSError| {
		// Start capture even when the barrier snapshot failed: a transient
		// snapshot error must not leave the surface frameless.
		if !error.is_null() {
			tracing::warn!("webview paint-barrier capture failed; continuing");
		}
		*block_spec.capture.borrow_mut() = Some(start_capture(&block_spec));
	});
	// SAFETY: snapshotting our own live webview; WebKit copies the block and
	// calls it once on the main thread.
	unsafe {
		spec
			.webview
			.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done);
	}
}

/// Pick and start the capture tier once the paint barrier cleared:
/// `ScreenCaptureKit` when the Screen Recording permission is already held
/// (preflight only — never prompts) and setup succeeds, `takeSnapshot`
/// polling otherwise. Pixel dimensions come from the webview's current size
/// so resizes before arming are honored.
fn start_capture(spec: &ArmSpec) -> CaptureMode {
	let size = spec.webview.frame().size;
	#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "dims are small")]
	let px = pixel_dims(size.width.max(1.0) as u32, size.height.max(1.0) as u32, spec.scale);
	let screen_capture_available = preflight_screen_capture();
	let sck = screen_capture_available
		.then(|| {
			try_sck(
				spec.window.windowNumber(),
				px,
				spec.fps_cap,
				spec.sink.clone(),
				spec.events.clone(),
			)
		})
		.flatten();
	if let Some(sck) = sck {
		CaptureMode::Sck(sck)
	} else {
		if screen_capture_available {
			tracing::warn!("screen capture device initialization failed; using snapshot fallback");
		} else {
			tracing::debug!("screen capture permission unavailable; using snapshot fallback");
		}
		let state = Rc::new(SnapState {
			webview:      spec.webview.clone(),
			sink:         spec.sink.clone(),
			dirty:        spec.dirty.clone(),
			pending:      Cell::new(false),
			last_capture: Cell::new(None),
			px:           Cell::new(px),
		});
		let timer = start_snapshot_timer(&state, spec.fps_cap);
		CaptureMode::Snapshot { timer, state }
	}
}

/// Try to set up the `ScreenCaptureKit` tier for the window numbered
/// `window_number` at `px` pixel dimensions; `None` on any failure (the
/// caller falls back to snapshot polling).
fn try_sck(
	window_number: isize,
	px: (u32, u32),
	fps_cap: Option<f32>,
	sink: Arc<FrameSink>,
	events: flume::Sender<WebViewEvent>,
) -> Option<Sck> {
	let window = shareable_window(window_number)?;
	// SAFETY: filter over a valid SCWindow snapshot; desktop-independent so
	// the offscreen window keeps streaming.
	let filter = unsafe {
		SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
	};

	let fps = f64::from(fps_cap.unwrap_or(60.0).clamp(1.0, 120.0));
	// SAFETY: configuring a fresh SCStreamConfiguration before stream creation.
	let config = unsafe {
		let config = SCStreamConfiguration::new();
		config.setWidth(px.0 as usize);
		config.setHeight(px.1 as usize);
		config.setPixelFormat(kCVPixelFormatType_32BGRA);
		#[allow(clippy::cast_possible_truncation, reason = "fps is clamped to 1..=120")]
		config.setMinimumFrameInterval(CMTime {
			value:     1000,
			timescale: (fps * 1000.0) as i32,
			flags:     CMTimeFlags::Valid,
			epoch:     0,
		});
		config.setQueueDepth(3);
		config.setShowsCursor(false);
		config
	};

	let delegate = StreamDelegate::new(events);
	// SAFETY: designated SCStream initializer with a valid filter/config;
	// the delegate is retained by `Sck` for the stream's lifetime.
	let stream = unsafe {
		SCStream::initWithFilter_configuration_delegate(
			SCStream::alloc(),
			&filter,
			&config,
			Some(ProtocolObject::from_ref(&*delegate)),
		)
	};
	let tap = FrameTap::new(sink);
	let queue = DispatchQueue::new("omp-webview-sck", None);
	// SAFETY: adding our tap for screen samples on a fresh serial queue.
	unsafe {
		stream.addStreamOutput_type_sampleHandlerQueue_error(
			ProtocolObject::from_ref(&*tap),
			SCStreamOutputType::Screen,
			Some(&queue),
		)
	}
	.ok()?;

	// Start and wait (bounded) for the completion, which runs off-main.
	let (tx, rx) = flume::bounded::<bool>(1);
	let done = RcBlock::new(move |error: *mut NSError| {
		let _ = tx.send(error.is_null());
	});
	// SAFETY: starting the configured stream; the block is heap-allocated and
	// retained by ScreenCaptureKit until invoked.
	unsafe { stream.startCaptureWithCompletionHandler(Some(&done)) };
	if rx.recv_timeout(SCK_TIMEOUT) != Ok(true) {
		// SAFETY: tearing the half-started stream back down (fire-and-forget).
		unsafe { stream.stopCaptureWithCompletionHandler(None) };
		return None;
	}

	Some(Sck { stream, config, tap, _delegate: delegate, _queue: queue })
}

/// Find our invisible window in the shareable-content snapshot by window
/// number, waiting (bounded) for the off-main completion handler.
fn shareable_window(window_number: isize) -> Option<Retained<SCWindow>> {
	let (tx, rx) = flume::bounded::<usize>(1);
	let block = RcBlock::new(move |content: *mut SCShareableContent, _error: *mut NSError| {
		let mut found = 0usize;
		if !content.is_null() {
			// SAFETY: ScreenCaptureKit passes null or a valid content
			// snapshot; nullness was checked above.
			let content = unsafe { &*content };
			// SAFETY: reading the immutable window list of the snapshot.
			for window in unsafe { content.windows() } {
				// SAFETY: `windowID` reads an immutable property.
				let id = unsafe { window.windowID() };
				if u32::try_from(window_number).is_ok_and(|number| number == id) {
					// Transfer the +1 retain to the waiting thread as a raw
					// pointer; rebuilt with `Retained::from_raw` below.
					found = Retained::into_raw(window) as usize;
					break;
				}
			}
		}
		let _ = tx.send(found);
	});
	// SAFETY: enumerating shareable content (`onScreenWindowsOnly: false` so
	// the offscreen window is included); the completion runs once on an
	// internal non-main queue, so the bounded main-thread wait below cannot
	// deadlock.
	unsafe {
		SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
			true, false, &block,
		);
	}
	let raw = rx.recv_timeout(SCK_TIMEOUT).ok()?;
	if raw == 0 {
		return None;
	}
	// SAFETY: `raw` is the +1 retained SCWindow pointer minted by `into_raw`
	// in the block; SCK snapshot objects are immutable and safe to move
	// across threads.
	unsafe { Retained::from_raw(raw as *mut SCWindow) }
}

/// Start the snapshot poll timer on the main run loop at the capped rate,
/// dirty-gated per the module docs.
fn start_snapshot_timer(state: &Rc<SnapState>, fps_cap: Option<f32>) -> Retained<NSTimer> {
	let interval = 1.0 / f64::from(fps_cap.unwrap_or(10.0).clamp(0.2, 30.0));
	let tick_state = Rc::clone(state);
	let tick = RcBlock::new(move |_timer: ptr::NonNull<NSTimer>| {
		if tick_state.pending.get() {
			return;
		}
		// Capture only when the page signalled a change (or on the idle
		// safety-net cadence); a changed capture keeps the rate hot.
		let due = tick_state.dirty.get()
			|| tick_state
				.last_capture
				.get()
				.is_none_or(|at| at.elapsed() >= IDLE_POLL);
		if !due {
			return;
		}
		tick_state.dirty.set(false);
		tick_state.pending.set(true);
		tick_state.last_capture.set(Some(Instant::now()));
		take_snapshot(&tick_state);
	});
	// SAFETY: creating a repeating block timer and scheduling it on the main
	// run loop from the main thread; the block only touches main-thread state.
	unsafe {
		let timer = NSTimer::timerWithTimeInterval_repeats_block(interval, true, &tick);
		NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSDefaultRunLoopMode);
		timer
	}
}

/// Request one snapshot; the completion (main thread) converts, diffs, and
/// emits the frame, re-arming the dirty flag when content changed.
fn take_snapshot(state: &Rc<SnapState>) {
	let Some(mtm) = MainThreadMarker::new() else {
		return;
	};
	let (width, _) = state.px.get();
	// SAFETY: configuring a fresh snapshot configuration on the main thread.
	// `snapshotWidth` is in points and maps 1:1 to output pixels, so passing
	// the pixel width bakes the scale factor into the image.
	let config = unsafe {
		let config = WKSnapshotConfiguration::new(mtm);
		config.setSnapshotWidth(Some(&NSNumber::numberWithDouble(f64::from(width))));
		config.setAfterScreenUpdates(true);
		config
	};
	let done_state = Rc::clone(state);
	let done = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
		done_state.pending.set(false);
		if image.is_null() {
			// Snapshots fail transiently mid-navigation; retry promptly.
			done_state.dirty.set(true);
			return;
		}
		// SAFETY: non-null per the check above; WebKit passes a valid image.
		let image = unsafe { &*image };
		let (width, height) = done_state.px.get();
		let Some(rgba) = rgba_of_image(image, width, height) else {
			return;
		};
		if done_state.sink.deliver(width, height, rgba) {
			done_state.dirty.set(true);
		}
	});
	// SAFETY: snapshotting our own live webview; WebKit copies the block and
	// calls it once on the main thread.
	unsafe {
		state
			.webview
			.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done);
	}
}

/// Renders `image` into a fresh tightly packed `width x height` RGBA8 buffer.
///
/// Drawing goes through an `NSBitmapImageRep`-backed graphics context (the
/// `AppKit` face of `CGBitmapContext`) in the rep's default
/// premultiplied-last format; snapshot web content is opaque (alpha 255), so
/// premultiplication is the identity.
fn rgba_of_image(image: &NSImage, width: u32, height: u32) -> Option<Vec<u8>> {
	let (w, h) = (width as usize, height as usize);
	// SAFETY: allocating a packed 8-bit RGBA rep; NSDeviceRGBColorSpace is a
	// constant colorspace name, and null planes make the rep own its buffer.
	let rep = unsafe {
		NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
			NSBitmapImageRep::alloc(),
			ptr::null_mut(),
			w as isize,
			h as isize,
			8,
			4,
			true,
			false,
			NSDeviceRGBColorSpace,
			(w * 4) as isize,
			32,
		)
	}?;
	let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
	// Swap in the bitmap context for the draw, then restore whatever the
	// caller had current (usually nothing on a bare run loop turn).
	let previous = NSGraphicsContext::currentContext();
	NSGraphicsContext::setCurrentContext(Some(&ctx));
	// Fills the whole rep, scaling the (point-sized) image to pixel dims.
	image.drawInRect(NSRect {
		origin: CGPoint::new(0.0, 0.0),
		size:   CGSize::new(w as f64, h as f64),
	});
	ctx.flushGraphics();
	NSGraphicsContext::setCurrentContext(previous.as_deref());

	let data = rep.bitmapData();
	if data.is_null() {
		return None;
	}
	let stride = usize::try_from(rep.bytesPerRow()).ok()?;
	if stride < w * 4 {
		return None;
	}
	let mut rgba = vec![0u8; w * h * 4];
	for row in 0..h {
		// SAFETY: `bitmapData` covers `h` rows of `stride` bytes each (row 0
		// is the top row); the stride bound was checked above.
		let src = unsafe { slice::from_raw_parts(data.add(row * stride).cast_const(), w * 4) };
		rgba[row * w * 4..][..w * 4].copy_from_slice(src);
	}
	Some(rgba)
}
