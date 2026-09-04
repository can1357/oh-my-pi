//! `WebDriver` `BiDi` driver for user-installed Gecko-family browsers.
//!
//! Firefox is spawned with `--remote-debugging-port 0` and the `BiDi` websocket
//! endpoint is discovered from `<profile>/WebDriverBiDiServer.json` (written
//! by the browser once the server is listening). Two `BiDi` limitations shape
//! this driver:
//!
//! - There is no screencast API, so `frames` surfaces poll
//!   `browsingContext.captureScreenshot` — dirty-driven, not blind: a preload
//!   script signals page changes over a `BiDi` channel and polling runs at full
//!   rate (fps cap, default 10) only while captures keep changing, falling back
//!   to a 1 Hz safety net for silent changes (canvas, video). A client-side
//!   diff suppresses unchanged frames and attaches tight damage rects.
//! - There is no `chrome --app` equivalent, so `window` surfaces show a normal
//!   Firefox window including its browser chrome.
//!
//! `BiDi` also has no title-change event; the title is refreshed once per
//! `browsingContext.load`, so mid-session `document.title` writes are only
//! observed on the next load.

use std::{
	fmt::Write,
	fs,
	path::{Path, PathBuf},
	process::Stdio,
	time::{Duration, Instant},
};

use bytes::Bytes;
use omp_core::{IntoStr, Str, encoding::base64, sf};
use serde_json::{Value, json};
use tokio::{
	process, time,
	time::{MissedTickBehavior, timeout},
};

use crate::{
	Error, Result,
	event::{SharedState, WebViewEvent},
	input::{Input, Key, Modifiers, MouseButton},
	options::{FrameConfig, FrameFormat, PageOptions, WindowConfig},
	remote::{
		Command, DriverCtx, ProfileDir, damage_rect, data_url, decode_frame, resolve_profile,
		ws::WsLink,
	},
};

/// How long to wait for the `BiDi` port file after spawning the browser.
const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(20);

/// Per-command response deadline. Commands answer quickly because
/// navigations are requested with `wait: "none"`.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Consecutive screenshot failures tolerated before the session is declared
/// dead; individual failures happen transiently mid-navigation.
const MAX_SHOT_FAILURES: u32 = 10;

/// Preload-script channel name carrying `window.ipc.postMessage` payloads.
const IPC_CHANNEL: &str = "omp-ipc";

/// Preload-script channel signalling likely page changes (frames surfaces).
const DIRTY_CHANNEL: &str = "omp-dirty";

/// Preload script marking the page dirty on mutations, scroll, input, and
/// animation starts (throttled page-side). Long-running animations need no
/// repeat signals: a capture that finds damage keeps the poller hot.
const DIRTY_SCRIPT: &str =
	"(chan)=>{let last=0;const mark=()=>{const t=Date.now();if(t-last>40){last=t;chan('d')}};new \
	 MutationObserver(mark).observe(document,{subtree:true,childList:true,attributes:true,\
	 characterData:true});for(const ev of \
	 ['scroll','input','pointermove','pointerdown','keydown','wheel','transitionrun','\
	 animationstart','load','resize'])addEventListener(ev,mark,{capture:true,passive:true});}";

/// Idle safety-net poll period, catching silent changes (canvas, WebGL,
/// video) that fire no DOM events; one damaged capture re-arms full rate.
const IDLE_POLL: Duration = Duration::from_secs(1);

/// `WebDriver` modifier codepoints (left-hand variants; the right-hand set at
/// `\u{e050}..` normalizes to the same modifier keys).
const SHIFT: char = '\u{e008}';
/// Control modifier codepoint.
const CONTROL: char = '\u{e009}';
/// Alt / Option modifier codepoint.
const ALT: char = '\u{e00a}';
/// Meta / Command modifier codepoint.
const META: char = '\u{e03d}';

/// Which surface the session renders to.
enum Surface {
	/// Headless engine polled for screenshots.
	Frames(FrameConfig),
	/// Visible engine-owned window (normal Firefox chrome).
	Window(WindowConfig),
}

/// Drive a headless Firefox and stream screenshot-polled frames.
pub async fn drive_frames(binary: PathBuf, config: FrameConfig, ctx: DriverCtx) -> Result<()> {
	drive(binary, Surface::Frames(config), ctx).await
}

/// Drive a visible Firefox window; see the module docs for chrome caveats.
pub async fn drive_window(binary: PathBuf, config: WindowConfig, ctx: DriverCtx) -> Result<()> {
	drive(binary, Surface::Window(config), ctx).await
}

/// Shared driver body: launch, set up, signal readiness, then pump until a
/// shutdown condition and terminate the browser.
async fn drive(binary: PathBuf, surface: Surface, ctx: DriverCtx) -> Result<()> {
	let DriverCtx { commands, cancelled: _, events, state, page, ready } = ctx;
	// `_profile` lives past the child so an ephemeral dir outlasts the process.
	let (_profile, mut child, mut link, mut driver) =
		match setup(binary, &surface, page, events, state).await {
			Ok(parts) => {
				let _ = ready.send(Ok(()));
				parts
			},
			Err(err) => {
				// The failure reaches the caller through `ready`; the spawned
				// child (if any) dies via kill-on-drop.
				let _ = ready.send(Err(err));
				return Ok(());
			},
		};

	let frames = matches!(surface, Surface::Frames(_));
	let fps = match &surface {
		Surface::Frames(config) => f64::from(config.fps_cap.unwrap_or(10.0).clamp(0.2, 30.0)),
		Surface::Window(_) => 1.0,
	};
	let mut ticker = time::interval(Duration::from_secs_f64(1.0 / fps));
	ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

	// Whether the socket is still up for a polite `browser.close`.
	let mut graceful = true;
	loop {
		if driver.closed {
			break;
		}
		tokio::select! {
			cmd = commands.recv_async() => match cmd {
				Err(_) | Ok(Command::Close) => break,
				// User commands are best-effort: a rejected navigation or bad
				// script must not kill the session. Transport errors still do.
				Ok(cmd) => match driver.handle(&mut link, cmd).await {
					Ok(()) | Err(Error::Protocol(_)) => {},
					Err(err) => return Err(err),
				},
			},
			msg = link.recv_json() => if let Some(msg) = msg? { driver.dispatch(&msg) } else {
						graceful = false;
						break;
					},
			_ = ticker.tick(), if frames => {
				// Capture only when the page signalled a change (or on the idle
				// safety-net cadence); a changed capture keeps the rate hot.
				let due = driver.dirty
					|| driver.last_capture.is_none_or(|at| at.elapsed() >= IDLE_POLL);
				if due {
					driver.last_capture = Some(Instant::now());
					driver.dirty = driver.capture(&mut link).await?;
				}
			},
		}
		// Load events request a title refresh instead of issuing a nested
		// command from event dispatch; service it between pump iterations.
		if driver.title_refresh {
			driver.title_refresh = false;
			if let Err(err @ (Error::WebSocket(_) | Error::Closed)) =
				driver.refresh_title(&mut link).await
			{
				return Err(err);
			}
		}
	}

	shutdown(&mut driver, &mut link, &mut child, graceful).await;
	Ok(())
}

/// Launch the browser, connect `BiDi`, and prepare the page; returns the live
/// session parts in declaration (= reverse drop) order.
async fn setup(
	binary: PathBuf,
	surface: &Surface,
	page: PageOptions,
	events: flume::Sender<WebViewEvent>,
	state: SharedState,
) -> Result<(ProfileDir, process::Child, WsLink, Driver)> {
	let profile = resolve_profile(&page)?;
	write_prefs(profile.path(), &page)?;
	// A persistent profile may hold a stale port file from a previous run.
	let port_file = profile.path().join("WebDriverBiDiServer.json");
	let _ = fs::remove_file(&port_file);

	let mut cmd = process::Command::new(&binary);
	cmd.arg("--remote-debugging-port")
		.arg("0")
		.arg("-profile")
		.arg(profile.path())
		.arg("-no-remote")
		.arg("-new-instance");
	match surface {
		Surface::Frames(_) => {
			cmd.arg("-headless");
		},
		Surface::Window(config) => {
			cmd.arg("-width")
				.arg(config.width.to_string())
				.arg("-height")
				.arg(config.height.to_string());
		},
	}
	// Explicit start page keeps a fresh profile off about:home/about:welcome.
	cmd.arg("about:blank")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.kill_on_drop(true);
	let mut child = cmd
		.spawn()
		.map_err(|source| Error::Launch { source, binary })?;

	let endpoint = discover_endpoint(&port_file, &mut child).await?;
	let mut link = timeout(Duration::from_secs(5), WsLink::connect(&endpoint))
		.await
		.map_err(|_| Error::Timeout("connecting to the firefox BiDi endpoint"))??;

	let mut driver = Driver {
		events,
		state,
		top: Str::default(),
		next_id: 0,
		scale: 1.0,
		format: FrameFormat::Png,
		closed: false,
		dirty: true,
		last_capture: None,
		title_refresh: false,
		last_frame: None,
		shot_failures: 0,
	};

	driver
		.call(&mut link, "session.new", json!({ "capabilities": {} }))
		.await?;
	driver
		.call(
			&mut link,
			"session.subscribe",
			json!({
				"events": [
					"browsingContext.navigationStarted",
					"browsingContext.load",
					"browsingContext.contextDestroyed",
					"script.message",
				],
			}),
		)
		.await?;

	let tree = driver
		.call(&mut link, "browsingContext.getTree", json!({}))
		.await?;
	driver.top = tree["contexts"][0]["context"]
		.as_str()
		.ok_or_else(|| Error::Protocol(Str::new("no top-level browsing context")))?
		.to_str();

	// IPC shim first, then user init scripts in order; preload scripts run in
	// registration order before any document script.
	driver
		.call(
			&mut link,
			"script.addPreloadScript",
			json!({
				"functionDeclaration": "(chan)=>{window.ipc={postMessage:m=>chan(String(m))}}",
				"arguments": [{ "type": "channel", "value": { "channel": IPC_CHANNEL } }],
				"contexts": [&*driver.top],
			}),
		)
		.await?;
	for script in &page.init_scripts {
		// `addPreloadScript` takes a function, so statement scripts are
		// wrapped; their top-level `let`/`const` become function-local.
		driver
			.call(
				&mut link,
				"script.addPreloadScript",
				json!({
					"functionDeclaration": sf!("()=>{{{script}}}"),
					"contexts": [&*driver.top],
				}),
			)
			.await?;
	}

	if let Surface::Frames(config) = surface {
		driver.scale = config.scale;
		driver.format = config.format;
		// Dirty-signal preload: lets the poller idle on static pages instead
		// of burning a Gecko snapshot + JPEG encode per tick.
		driver
			.call(
				&mut link,
				"script.addPreloadScript",
				json!({
					"functionDeclaration": DIRTY_SCRIPT,
					"arguments": [{ "type": "channel", "value": { "channel": DIRTY_CHANNEL } }],
					"contexts": [&*driver.top],
				}),
			)
			.await?;
		driver
			.call(
				&mut link,
				"browsingContext.setViewport",
				json!({
					"context": driver.top,
					"viewport": { "width": config.width, "height": config.height },
					"devicePixelRatio": config.scale,
				}),
			)
			.await?;
	}

	let url = match (&page.url, &page.html) {
		(Some(url), _) => url.clone(),
		(None, Some(html)) => data_url(html),
		(None, None) => Str::new("about:blank"),
	};
	driver.navigate(&mut link, &url).await?;

	Ok((profile, child, link, driver))
}

/// Write quiet-startup prefs (plus any user-agent override) into the
/// profile's `user.js` before launch.
fn write_prefs(profile: &Path, page: &PageOptions) -> Result<()> {
	let mut prefs = String::from(concat!(
		"user_pref(\"browser.shell.checkDefaultBrowser\", false);\n",
		"user_pref(\"browser.aboutwelcome.enabled\", false);\n",
		"user_pref(\"datareporting.policy.dataSubmissionEnabled\", false);\n",
		"user_pref(\"app.update.disabledForTesting\", true);\n",
		"user_pref(\"remote.active-protocols\", 1);\n",
	));
	if let Some(ua) = &page.user_agent {
		let escaped = ua.replace('\\', "\\\\").replace('"', "\\\"");
		writeln!(prefs, "user_pref(\"general.useragent.override\", \"{escaped}\");")
			.expect("writing to a String cannot fail");
	}
	fs::write(profile.join("user.js"), prefs)?;
	Ok(())
}

/// Poll for the `BiDi` port file and build the `/session` websocket URL.
///
/// The file appears once the server listens and holds
/// `{"ws_host": "...", "ws_port": <port>}`; an early child exit or the
/// [`ENDPOINT_TIMEOUT`] deadline aborts the wait.
async fn discover_endpoint(port_file: &Path, child: &mut process::Child) -> Result<Str> {
	use tokio::time::Instant;
	let deadline = Instant::now() + ENDPOINT_TIMEOUT;
	loop {
		// Tolerate a partially written file: retry until it parses.
		if let Ok(text) = fs::read_to_string(port_file)
			&& let Ok(value) = serde_json::from_str::<Value>(&text)
			&& let Some(port) = value["ws_port"].as_u64()
			&& port != 0
		{
			let host = value["ws_host"].as_str().unwrap_or("127.0.0.1");
			return Ok(sf!("ws://{host}:{port}/session"));
		}
		if let Some(status) = child.try_wait()? {
			return Err(Error::Protocol(sf!("firefox exited during startup: {status}")));
		}
		if Instant::now() >= deadline {
			return Err(Error::Timeout("waiting for the firefox BiDi endpoint"));
		}
		time::sleep(Duration::from_millis(100)).await;
	}
}

/// Session state shared by the pump, command handlers, and event dispatch.
struct Driver {
	/// Event sink towards the host.
	events:        flume::Sender<WebViewEvent>,
	/// Shared url/title cache kept current from `BiDi` events.
	state:         SharedState,
	/// Top-level browsing-context id.
	top:           Str,
	/// Last issued `BiDi` command id.
	next_id:       u64,
	/// Device scale factor reapplied on [`Command::Resize`].
	scale:         f64,
	/// Wire encoding for polled screenshots.
	format:        FrameFormat,
	/// Set once the top context is destroyed; the pump exits on it.
	closed:        bool,
	/// A page change was signalled; capture at full rate until a poll comes
	/// back unchanged.
	dirty:         bool,
	/// When the last screenshot was requested (idle safety-net pacing).
	last_capture:  Option<Instant>,
	/// Set by load events; the pump refreshes the title between iterations.
	title_refresh: bool,
	/// Last delivered frame pixels, for duplicate suppression.
	last_frame:    Option<Bytes>,
	/// Consecutive `captureScreenshot` failures.
	shot_failures: u32,
}

impl Driver {
	/// Send one `BiDi` command and await its response, dispatching interleaved
	/// events; a `BiDi` `error` response maps to [`Error::Protocol`].
	async fn call(&mut self, link: &mut WsLink, method: &str, params: Value) -> Result<Value> {
		self.next_id += 1;
		let id = self.next_id;
		link
			.send_json(&json!({ "id": id, "method": method, "params": params }))
			.await?;
		loop {
			let mut msg = timeout(CALL_TIMEOUT, link.recv_json())
				.await
				.map_err(|_| Error::Timeout("awaiting a BiDi response"))??
				.ok_or(Error::Closed)?;
			if msg["type"].as_str() == Some("event") {
				self.on_event(msg["method"].as_str().unwrap_or(""), &msg["params"]);
				continue;
			}
			if msg["id"].as_u64() != Some(id) {
				// Only one command is ever in flight; drop strays.
				continue;
			}
			return match msg["type"].as_str() {
				Some("success") => Ok(msg.get_mut("result").map_or(Value::Null, Value::take)),
				_ => Err(Error::Protocol(sf!(
					"{method}: {}: {}",
					msg["error"].as_str().unwrap_or("unknown error"),
					msg["message"].as_str().unwrap_or(""),
				))),
			};
		}
	}

	/// Route one incoming `BiDi` message from the pump; command responses only
	/// arrive inside [`Self::call`], so anything else here is dropped.
	fn dispatch(&mut self, msg: &Value) {
		if msg["type"].as_str() == Some("event") {
			self.on_event(msg["method"].as_str().unwrap_or(""), &msg["params"]);
		}
	}

	/// Translate one subscribed `BiDi` event into [`WebViewEvent`]s and state
	/// updates; events for foreign contexts (e.g. about:newtab) are ignored.
	fn on_event(&mut self, method: &str, params: &Value) {
		let ours = params["context"].as_str() == Some(self.top.as_str());
		match method {
			"browsingContext.navigationStarted" if ours => {
				if let Some(url) = params["url"].as_str() {
					tracing::debug!(
						scheme = crate::navigation_scheme(url),
						"webview navigation observed"
					);
					let url = url.to_str();
					self.state.lock().url = url.clone();
					let _ = self.events.send(WebViewEvent::LoadStarted(url.clone()));
					let _ = self.events.send(WebViewEvent::Navigated(url));
				}
			},
			"browsingContext.load" if ours => {
				if let Some(url) = params["url"].as_str() {
					let _ = self.events.send(WebViewEvent::LoadFinished(url.to_str()));
				}
				self.title_refresh = true;
				self.dirty = true;
			},
			"browsingContext.contextDestroyed" if ours => self.closed = true,
			"script.message" => {
				if !script_message_is_from_top(params, self.top.as_str()) {
					return;
				}
				match params["channel"].as_str() {
					Some(IPC_CHANNEL) => {
						if let Some(payload) = params["data"]["value"].as_str() {
							let _ = self.events.send(WebViewEvent::Ipc(payload.to_str()));
						}
					},
					Some(DIRTY_CHANNEL) => self.dirty = true,
					_ => {},
				}
			},
			_ => {},
		}
	}

	/// Request a navigation without waiting for it to complete.
	async fn navigate(&mut self, link: &mut WsLink, url: &str) -> Result<()> {
		self
			.call(
				link,
				"browsingContext.navigate",
				json!({ "context": self.top, "url": url, "wait": "none" }),
			)
			.await
			.map(drop)
	}

	/// Execute one command from the public handle.
	async fn handle(&mut self, link: &mut WsLink, cmd: Command) -> Result<()> {
		// Every command can change what the page shows; poll promptly.
		self.dirty = true;
		match cmd {
			Command::Navigate(url) => self.navigate(link, &url).await,
			Command::LoadHtml(html) => self.navigate(link, &data_url(&html)).await,
			Command::Eval { js, reply } => self.eval(link, &js, reply).await,
			Command::AccessibilityTree { reply } => {
				let _ = reply
					.send(Err(Error::Unsupported("native accessibility snapshots require Chromium")));
				Ok(())
			},
			Command::UploadFiles { reply, .. } => {
				let _ = reply.send(Err(Error::Unsupported("file upload requires Chromium CDP")));
				Ok(())
			},
			Command::Screenshot { reply, .. } => {
				let _ =
					reply.send(Err(Error::Unsupported("direct PNG screenshots require Chromium CDP")));
				Ok(())
			},
			Command::Back => self.traverse(link, -1).await,
			Command::Forward => self.traverse(link, 1).await,
			Command::Reload => self
				.call(link, "browsingContext.reload", json!({ "context": self.top }))
				.await
				.map(drop),
			Command::Focus => self
				.call(link, "browsingContext.activate", json!({ "context": self.top }))
				.await
				.map(drop),
			Command::Resize { width, height } => {
				// The viewport changed; the next capture is a full redraw.
				self.last_frame = None;
				self
					.call(
						link,
						"browsingContext.setViewport",
						json!({
							"context": self.top,
							"viewport": { "width": width, "height": height },
							"devicePixelRatio": self.scale,
						}),
					)
					.await
					.map(drop)
			},
			Command::Input(input) => self.input(link, input).await,
			// The pump breaks on Close before dispatching here.
			Command::Close => Ok(()),
		}
	}

	/// Evaluate JS in the page.
	///
	/// With a reply the script is wrapped as
	/// `JSON.stringify((()=>{ return (<js>); })())` so the caller receives
	/// the JSON-encoded result as a single string; the wrapper requires `js`
	/// to be an expression, and a thrown exception replies with its text.
	async fn eval(
		&mut self,
		link: &mut WsLink,
		js: &str,
		reply: Option<Box<dyn FnOnce(Str) + Send>>,
	) -> Result<()> {
		let expression = match reply {
			Some(_) => sf!("JSON.stringify((()=>{{ return ({js}); }})())"),
			None => js.to_str(),
		};
		let result = self
			.call(
				link,
				"script.evaluate",
				json!({
					"expression": expression,
					"target": { "context": self.top },
					"awaitPromise": true,
				}),
			)
			.await?;
		if let Some(reply) = reply {
			let value = match result["type"].as_str() {
				// `JSON.stringify(undefined)` yields a non-string result;
				// report it as JSON null.
				Some("success") => result["result"]["value"]
					.as_str()
					.unwrap_or("null")
					.to_str(),
				_ => result["exceptionDetails"]["text"]
					.as_str()
					.unwrap_or("evaluation failed")
					.to_str(),
			};
			reply(value);
		}
		Ok(())
	}

	/// Step through session history; stepping past an edge is a no-op
	/// (Firefox answers `no such history entry`).
	async fn traverse(&mut self, link: &mut WsLink, delta: i64) -> Result<()> {
		let result = self
			.call(
				link,
				"browsingContext.traverseHistory",
				json!({ "context": self.top, "delta": delta }),
			)
			.await;
		match result {
			Ok(_) | Err(Error::Protocol(_)) => Ok(()),
			Err(err) => Err(err),
		}
	}

	/// Fetch `document.title` after a load and emit
	/// [`WebViewEvent::TitleChanged`] when it moved; evaluation failures
	/// mid-navigation are transient and skipped.
	async fn refresh_title(&mut self, link: &mut WsLink) -> Result<()> {
		let result = self
			.call(
				link,
				"script.evaluate",
				json!({
					"expression": "document.title",
					"target": { "context": self.top },
					"awaitPromise": true,
				}),
			)
			.await;
		let result = match result {
			Ok(result) => result,
			Err(Error::Protocol(_)) => return Ok(()),
			Err(err) => return Err(err),
		};
		if result["type"].as_str() == Some("success")
			&& let Some(title) = result["result"]["value"].as_str()
		{
			{
				let mut state = self.state.lock();
				if state.title.as_str() == title {
					return Ok(());
				}
				state.title = title.to_str();
			}
			let _ = self.events.send(WebViewEvent::TitleChanged(title.to_str()));
		}
		Ok(())
	}

	/// Poll one screenshot, decode it, and emit a frame unless nothing
	/// changed; returns whether the page content changed (or the capture
	/// transiently failed and should be retried promptly).
	async fn capture(&mut self, link: &mut WsLink) -> Result<bool> {
		let result = self
			.call(
				link,
				"browsingContext.captureScreenshot",
				json!({
					"context": self.top,
					"origin": "viewport",
					"format": match self.format {
						FrameFormat::Png => json!({ "type": "image/png" }),
						FrameFormat::Jpeg { quality } => json!({
							"type": "image/jpeg",
							"quality": f64::from(quality.clamp(1, 100)) / 100.0,
						}),
					},
				}),
			)
			.await;
		let result = match result {
			Ok(result) => result,
			Err(Error::Protocol(err)) => {
				// Screenshots fail transiently mid-navigation; only a streak
				// of failures is fatal.
				self.shot_failures += 1;
				if self.shot_failures >= MAX_SHOT_FAILURES {
					return Err(Error::Protocol(err));
				}
				tracing::warn!(
					attempt = self.shot_failures,
					max_attempts = MAX_SHOT_FAILURES,
					"webview frame capture failed; retrying"
				);
				return Ok(true);
			},
			Err(err) => return Err(err),
		};
		self.shot_failures = 0;
		let Some(data) = result["data"].as_str() else {
			return Err(Error::Protocol(Str::new("captureScreenshot: missing image data")));
		};
		let raw = base64::decode(data.as_bytes())
			.into_vec()
			.map_err(|source| Error::ScreenshotBase64 { source })?;
		let mut frame = decode_frame(self.format, &raw)?;
		match &self.last_frame {
			Some(prev) if prev.len() == frame.data.len() => {
				// Polling has no damage signal at all; the diff both drops
				// unchanged captures and tightens the upload hint.
				match damage_rect(prev, &frame.data, frame.width) {
					Some(rect) => frame.damage = rect,
					None => return Ok(false),
				}
			},
			// First capture or a size change: full damage (decoder default).
			_ => {},
		}
		self.last_frame = Some(frame.data.clone());
		let _ = self.events.send(WebViewEvent::Frame(frame));
		Ok(true)
	}

	/// Forward one synthetic input event via `input.performActions`.
	///
	/// Sources use fixed ids so pointer position and key state persist
	/// across calls; button events re-assert the pointer position first
	/// because `BiDi` presses fire wherever the pointer currently rests.
	async fn input(&mut self, link: &mut WsLink, input: Input) -> Result<()> {
		let source = match input {
			Input::MouseMove { x, y } => pointer_source(vec![pointer_move(x, y)]),
			Input::MouseDown { button, x, y, .. } => pointer_source(vec![
				pointer_move(x, y),
				json!({ "type": "pointerDown", "button": button_index(button) }),
			]),
			Input::MouseUp { button, x, y } => pointer_source(vec![
				pointer_move(x, y),
				json!({ "type": "pointerUp", "button": button_index(button) }),
			]),
			// Wheel coordinates and deltas must be integers (Gecko rejects
			// fractions), unlike pointer coordinates.
			Input::Scroll { x, y, dx, dy } => json!({
				"type": "wheel",
				"id": "omp-wheel",
				"actions": [{
					"type": "scroll",
					"x": x.round() as i64,
					"y": y.round() as i64,
					"deltaX": dx.round() as i64,
					"deltaY": dy.round() as i64,
					"duration": 0,
				}],
			}),
			Input::KeyDown { key, modifiers } => key_source(key_actions(key, modifiers, "keyDown")),
			Input::KeyUp { key, modifiers } => key_source(key_actions(key, modifiers, "keyUp")),
			Input::Text(text) => {
				let mut actions = Vec::with_capacity(text.chars().count() * 2);
				for c in text.chars() {
					actions.push(key_action("keyDown", c));
					actions.push(key_action("keyUp", c));
				}
				key_source(actions)
			},
		};
		self
			.call(link, "input.performActions", json!({ "context": self.top, "actions": [source] }))
			.await
			.map(drop)
	}
}

/// Politely close the browser, then make sure the child is gone.
async fn shutdown(
	driver: &mut Driver,
	link: &mut WsLink,
	child: &mut process::Child,
	graceful: bool,
) {
	if graceful {
		let _ = timeout(Duration::from_secs(1), driver.call(link, "browser.close", json!({}))).await;
	}
	if timeout(Duration::from_secs(3), child.wait()).await.is_err() {
		let _ = child.start_kill();
		let _ = timeout(Duration::from_secs(1), child.wait()).await;
	}
}

/// `WebDriver` button index for a mouse button.
const fn button_index(button: MouseButton) -> u64 {
	match button {
		MouseButton::Left => 0,
		MouseButton::Middle => 1,
		MouseButton::Right => 2,
	}
}

/// A zero-duration pointer move in viewport CSS pixels.
fn pointer_move(x: f64, y: f64) -> Value {
	json!({ "type": "pointerMove", "x": x, "y": y, "duration": 0 })
}

/// Checks the source browsing context carried by a `BiDi` script message.
fn script_message_is_from_top(params: &Value, top: &str) -> bool {
	params.pointer("/source/context").and_then(Value::as_str) == Some(top)
}

/// Wrap pointer actions in the persistent mouse input source.

fn pointer_source(actions: Vec<Value>) -> Value {
	json!({
		"type": "pointer",
		"id": "omp-mouse",
		"parameters": { "pointerType": "mouse" },
		"actions": actions,
	})
}

/// Wrap key actions in the persistent keyboard input source.
fn key_source(actions: Vec<Value>) -> Value {
	json!({ "type": "key", "id": "omp-keyboard", "actions": actions })
}

/// Key action list for one key transition, wrapped in presses/releases of
/// the requested modifiers so the transition carries them.
fn key_actions(key: Key, modifiers: Modifiers, kind: &str) -> Vec<Value> {
	let mods = [
		(modifiers.shift, SHIFT),
		(modifiers.ctrl, CONTROL),
		(modifiers.alt, ALT),
		(modifiers.meta, META),
	];
	let mut actions = Vec::new();
	for (held, c) in mods {
		if held {
			actions.push(key_action("keyDown", c));
		}
	}
	actions.push(key_action(kind, key_value(key)));
	for (held, c) in mods.into_iter().rev() {
		if held {
			actions.push(key_action("keyUp", c));
		}
	}
	actions
}

/// One key action on a single codepoint value.
fn key_action(kind: &str, c: char) -> Value {
	let mut buf = [0u8; 4];
	json!({ "type": kind, "value": c.encode_utf8(&mut buf) })
}

/// `WebDriver` codepoint for a key, per the spec's normalized-key table as
/// shipped in Gecko's `KeyData.sys.mjs` (`\u{e006}` is the main Enter key's
/// code; `\u{e007}` maps to `NumpadEnter` — both normalize to key `Enter`).
fn key_value(key: Key) -> char {
	match key {
		Key::Char(c) => c,
		Key::Enter => '\u{e007}',
		Key::Tab => '\u{e004}',
		Key::Backspace => '\u{e003}',
		Key::Delete => '\u{e017}',
		Key::Escape => '\u{e00c}',
		Key::ArrowUp => '\u{e013}',
		Key::ArrowDown => '\u{e015}',
		Key::ArrowLeft => '\u{e012}',
		Key::ArrowRight => '\u{e014}',
		Key::Home => '\u{e011}',
		Key::End => '\u{e010}',
		Key::PageUp => '\u{e00e}',
		Key::PageDown => '\u{e00f}',
		// F1..=F12 occupy \u{e031}..=\u{e03c}; out-of-range input clamps.
		Key::F(n) => char::from_u32(0xe030 + u32::from(n.clamp(1, 12))).unwrap_or('\u{e031}'),
	}
}
#[cfg(test)]
mod ipc_tests {
	use super::*;

	#[test]
	fn script_message_requires_top_level_source_context() {
		assert!(script_message_is_from_top(&json!({ "source": { "context": "top" } }), "top",));
		assert!(!script_message_is_from_top(&json!({ "source": { "context": "iframe" } }), "top",));
		assert!(!script_message_is_from_top(&json!({}), "top"));
	}
}
