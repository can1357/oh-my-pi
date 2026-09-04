//! CDP driver for user-installed Chromium-family browsers.
//!
//! Speaks flattened-session Chrome `DevTools` Protocol over the browser-level
//! websocket advertised in `<profile>/DevToolsActivePort`. One driver owns one
//! page target: `frames` surfaces render in `--headless=new` and stream
//! `Page.screencastFrame` PNGs, `window` surfaces run a visible `--app`
//! window the user can interact with directly.

use std::{
	collections::HashSet,
	ffi::OsString,
	fs,
	path::{Path, PathBuf},
	process::Stdio,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant},
};

use bytes::{Bytes, BytesMut};
use flume::Receiver;
use http::{Request, StatusCode, header::CONTENT_LENGTH};
use http_body_util::{BodyExt as _, Empty};
use hyper::body::Incoming;
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
	client::legacy::{Client, connect::HttpConnector},
	rt::TokioExecutor,
};
use omp_core::{IntoStr, Str, encoding::base64, sf};
use rustls::crypto::ring;
use serde_json::{Value, json};
use tokio::{
	process,
	process::Child,
	time::{sleep, timeout},
};

use crate::{
	CdpDiscoveryError, Error, Result,
	event::{SharedState, WebViewEvent},
	input::{Input, Key, Modifiers},
	options::{FrameConfig, FrameFormat, PageOptions, WindowConfig},
	remote::{
		Command, DriverCtx, ProfileDir, damage_rect, data_url, decode_frame, resolve_profile,
		ws::WsLink,
	},
};

/// How long to wait for the browser to publish `DevToolsActivePort` and for
/// the `--app` window's page target to appear.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// Cadence for polling the port file and the target list during startup.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Upper bound on a single CDP command round-trip.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Hard ceiling for the Chromium discovery document.
const MAX_CDP_DISCOVERY_RESPONSE_BYTES: usize = 1024 * 1024;

type CdpDiscoveryHttpClient = Client<HttpsConnector<HttpConnector>, Empty<Bytes>>;

/// Grace for the polite `Browser.close` request during shutdown.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// Grace for the child process to exit after `Browser.close`.
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);

/// Runtime binding backing `window.ipc.postMessage`.
const IPC_BINDING: &str = "__ompIpc";

/// Shim installed before any user init script so pages can call
/// `window.ipc.postMessage(string)` regardless of engine.
const IPC_SHIM: &str = "window.ipc={postMessage:m=>window.__ompIpc(String(m))}";

/// Identity of a foreign Chromium endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttachedKind {
	/// An ordinary Chromium-compatible CDP endpoint.
	Cdp,
	/// The OMP Chromium relay.
	Relay,
}

/// Screenshot focus handling for an attached page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ScreenshotFocus {
	/// Preserve existing behavior for owned browsers and ordinary CDP.
	#[default]
	None,
	/// Explicit relay targets may be activated before capture.
	Activate,
	/// Implicit relay targets must still be the visible user tab.
	RequireVisible,
}

/// Drive a headless pixel-stream session; see the module docs.
pub async fn drive_frames(binary: PathBuf, config: FrameConfig, ctx: DriverCtx) -> Result<()> {
	let DriverCtx { commands, cancelled, events, state, page, ready } = ctx;
	match connect_frames(&binary, config, &page, events, state, cancelled).await {
		Ok((cdp, child, profile)) => {
			let _ = ready.send(Ok(()));
			let result = cdp.run(commands, child).await;
			drop(profile);
			result
		},
		Err(err) => {
			let _ = ready.send(Err(err));
			Ok(())
		},
	}
}

/// Drive a visible `--app` window session; see the module docs.
pub async fn drive_window(binary: PathBuf, config: WindowConfig, ctx: DriverCtx) -> Result<()> {
	let DriverCtx { commands, cancelled, events, state, page, ready } = ctx;
	match connect_window(&binary, config, &page, events, state, cancelled).await {
		Ok((cdp, child, profile)) => {
			let _ = ready.send(Ok(()));
			let result = cdp.run(commands, child).await;
			drop(profile);
			result
		},
		Err(err) => {
			let _ = ready.send(Err(err));
			Ok(())
		},
	}
}

/// Attach to one existing Chromium-compatible CDP page without taking
/// ownership of either the browser process or the target.
pub async fn drive_attached(
	endpoint: Str,
	target: Option<Str>,
	config: FrameConfig,
	ctx: DriverCtx,
) -> Result<()> {
	drive_attached_kind(endpoint, target, config, ctx, AttachedKind::Cdp).await
}

/// Attach through an explicitly identified OMP Chromium relay.
pub(crate) async fn drive_relay_attached(
	endpoint: Str,
	target: Option<Str>,
	config: FrameConfig,
	ctx: DriverCtx,
) -> Result<()> {
	drive_attached_kind(endpoint, target, config, ctx, AttachedKind::Relay).await
}

async fn drive_attached_kind(
	endpoint: Str,
	target: Option<Str>,
	config: FrameConfig,
	ctx: DriverCtx,
	kind: AttachedKind,
) -> Result<()> {
	let DriverCtx { commands, cancelled, events, state, page, ready } = ctx;
	match connect_attached(
		&endpoint,
		target.as_deref(),
		config,
		&page,
		events,
		state,
		cancelled,
		kind,
	)
	.await
	{
		Ok(cdp) => {
			let _ = ready.send(Ok(()));
			cdp.run_attached(commands).await
		},
		Err(err) => {
			let _ = ready.send(Err(err));
			Ok(())
		},
	}
}

async fn connect_attached(
	endpoint: &str,
	target_matcher: Option<&str>,
	config: FrameConfig,
	page: &PageOptions,
	events: flume::Sender<WebViewEvent>,
	state: SharedState,
	cancelled: Arc<AtomicBool>,
	kind: AttachedKind,
) -> Result<Cdp> {
	let websocket =
		resolve_cdp_websocket(endpoint, page.connect_timeout.unwrap_or(Duration::from_secs(35)))
			.await?;
	let link =
		timeout(page.connect_timeout.unwrap_or(Duration::from_secs(35)), WsLink::connect(&websocket))
			.await
			.map_err(|_| Error::Timeout("connecting to the CDP endpoint"))??;
	let mut cdp = Cdp::new(link, events, state, None, cancelled, Some(kind));
	wire_attached(&mut cdp, target_matcher, config, page).await?;
	Ok(cdp)
}

async fn resolve_cdp_websocket(endpoint: &str, connect_timeout: Duration) -> Result<Str> {
	let endpoint = endpoint.trim().trim_end_matches('/');
	if endpoint.starts_with("ws://") || endpoint.starts_with("wss://") {
		return Ok(endpoint.to_str());
	}
	if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
		return Err(Error::Protocol("CDP endpoint must use http, https, ws, or wss".to_str()));
	}
	let mut discovery = url::Url::parse(endpoint)
		.map_err(|source| Error::CdpDiscovery(CdpDiscoveryError::InvalidUrl { source }))?;
	let base = discovery.path().trim_end_matches('/').to_owned();
	discovery.set_path(&format!("{base}/json/version"));
	discovery.set_fragment(None);
	let uri: http::Uri = discovery
		.as_str()
		.parse()
		.map_err(|source| Error::CdpDiscovery(CdpDiscoveryError::InvalidHttpUri { source }))?;
	let _ = ring::default_provider().install_default();
	let connector = HttpsConnectorBuilder::new()
		.with_webpki_roots()
		.https_or_http()
		.enable_http1()
		.enable_http2()
		.build();
	let client: CdpDiscoveryHttpClient = Client::builder(TokioExecutor::new()).build(connector);
	let request_timeout = connect_timeout.max(Duration::from_millis(1));
	let deadline = Instant::now() + connect_timeout;
	loop {
		if Instant::now() >= deadline {
			return Err(Error::Timeout("waiting for the CDP endpoint"));
		}
		let request = Request::get(uri.clone())
			.body(Empty::<Bytes>::new())
			.expect("GET request with a parsed URI is valid");
		let request_started = Instant::now();
		let response = timeout(request_timeout, client.request(request))
			.await
			.map_err(|source| Error::CdpDiscovery(CdpDiscoveryError::HttpTimeout { source }))?
			.map_err(|source| Error::CdpDiscovery(CdpDiscoveryError::HttpRequest { source }))?;
		let status = response.status();
		if status == StatusCode::SERVICE_UNAVAILABLE && Instant::now() < deadline {
			sleep(Duration::from_millis(250)).await;
			continue;
		}
		if status.is_client_error() || status.is_server_error() {
			return Err(Error::CdpDiscovery(CdpDiscoveryError::HttpStatus {
				status: status.as_u16(),
			}));
		}
		let declared_length = response
			.headers()
			.get(CONTENT_LENGTH)
			.and_then(|value| value.to_str().ok())
			.and_then(|value| value.parse::<u64>().ok());
		if declared_length.is_some_and(|length| length > MAX_CDP_DISCOVERY_RESPONSE_BYTES as u64) {
			return Err(Error::CdpDiscovery(CdpDiscoveryError::ResponseTooLarge {
				limit: MAX_CDP_DISCOVERY_RESPONSE_BYTES,
			}));
		}
		let remaining = request_timeout.saturating_sub(request_started.elapsed());
		let body = timeout(remaining, collect_cdp_discovery_body(response.into_body()))
			.await
			.map_err(|source| Error::CdpDiscovery(CdpDiscoveryError::HttpTimeout { source }))?
			.map_err(Error::CdpDiscovery)?;
		let value = serde_json::from_slice::<Value>(&body)
			.map_err(|source| Error::CdpDiscovery(CdpDiscoveryError::MalformedJson { source }))?;
		return value
			.get("webSocketDebuggerUrl")
			.and_then(Value::as_str)
			.map(Str::new)
			.ok_or_else(|| Error::Protocol("CDP discovery omitted webSocketDebuggerUrl".to_str()));
	}
}

async fn collect_cdp_discovery_body(mut body: Incoming) -> Result<Bytes, CdpDiscoveryError> {
	let mut bytes = BytesMut::new();
	while let Some(frame) = body.frame().await {
		let frame = frame.map_err(|source| CdpDiscoveryError::HttpBody { source })?;
		if let Ok(data) = frame.into_data() {
			if bytes.len().saturating_add(data.len()) > MAX_CDP_DISCOVERY_RESPONSE_BYTES {
				return Err(CdpDiscoveryError::ResponseTooLarge {
					limit: MAX_CDP_DISCOVERY_RESPONSE_BYTES,
				});
			}
			bytes.extend_from_slice(&data);
		}
	}
	Ok(bytes.freeze())
}

/// Launch the browser, wire a headless screencast target, and hand back the
/// live session with the child and its profile directory.
async fn connect_frames(
	binary: &Path,
	config: FrameConfig,
	page: &PageOptions,
	events: flume::Sender<WebViewEvent>,
	state: SharedState,
	cancelled: Arc<AtomicBool>,
) -> Result<(Cdp, Child, ProfileDir)> {
	let profile = resolve_profile(page)?;
	let extra = ["--headless=new".to_str(), "about:blank".to_str()];
	let (link, mut child) = connect(binary, profile.path(), page, &extra).await?;
	let mut cdp = Cdp::new(link, events, state, Some(config), cancelled, None);
	if let Err(err) = wire_frames(&mut cdp, config, page).await {
		let _ = child.start_kill();
		return Err(err);
	}
	Ok((cdp, child, profile))
}

/// Launch the browser with a visible `--app` window, attach to it, and hand
/// back the live session with the child and its profile directory.
async fn connect_window(
	binary: &Path,
	config: WindowConfig,
	page: &PageOptions,
	events: flume::Sender<WebViewEvent>,
	state: SharedState,
	cancelled: Arc<AtomicBool>,
) -> Result<(Cdp, Child, ProfileDir)> {
	let profile = resolve_profile(page)?;
	let initial = match (&page.url, &page.html) {
		(Some(url), _) => url.clone(),
		(None, Some(html)) => data_url(html),
		(None, None) => "about:blank".to_str(),
	};
	let mut extra = Vec::with_capacity(3);
	if page.incognito {
		extra.push("--incognito".to_str());
	}
	extra.push(sf!("--window-size={},{}", config.width, config.height));
	extra.push(sf!("--app={initial}"));
	let (link, mut child) = connect(binary, profile.path(), page, &extra).await?;
	let mut cdp = Cdp::new(link, events, state, None, cancelled, None);
	if let Err(err) = wire_window(&mut cdp, page).await {
		let _ = child.start_kill();
		return Err(err);
	}
	Ok((cdp, child, profile))
}

/// Spawn the browser and open the `DevTools` browser-level websocket.
async fn connect(
	binary: &Path,
	profile: &Path,
	page: &PageOptions,
	extra: &[Str],
) -> Result<(WsLink, Child)> {
	// A stale port file from a previous session in a persistent profile would
	// win the poll below and point at a dead (or foreign) endpoint.
	let _ = fs::remove_file(profile.join("DevToolsActivePort"));
	let mut child = spawn_browser(binary, profile, page, extra)?;
	let connected = async {
		let startup_timeout = page.connect_timeout.unwrap_or(STARTUP_TIMEOUT);
		let url = wait_devtools_port(profile, startup_timeout).await?;
		timeout(startup_timeout, WsLink::connect(&url))
			.await
			.map_err(|_| Error::Timeout("connecting to the owned browser"))?
	}
	.await;
	match connected {
		Ok(link) => Ok((link, child)),
		Err(err) => {
			let _ = child.start_kill();
			Err(err)
		},
	}
}

/// Spawn the browser process with the shared automation flags plus `extra`.
fn spawn_browser(
	binary: &Path,
	profile: &Path,
	page: &PageOptions,
	extra: &[Str],
) -> Result<Child> {
	let mut user_data = OsString::from("--user-data-dir=");
	user_data.push(profile);
	let mut cmd = process::Command::new(binary);
	cmd.arg("--remote-debugging-port=0").arg(user_data).args([
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-sync",
		"--mute-audio",
		"--disable-session-crashed-bubble",
		"--hide-crash-restore-bubble",
	]);
	if let Some(ua) = &page.user_agent {
		cmd.arg(&*sf!("--user-agent={ua}"));
	}
	for arg in &page.arguments {
		cmd.arg(&**arg);
	}
	for arg in extra {
		cmd.arg(&**arg);
	}
	cmd.kill_on_drop(true)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	cmd.spawn()
		.map_err(|source| Error::Launch { source, binary: binary.to_path_buf() })
}

/// Poll `<profile>/DevToolsActivePort` until the browser publishes its
/// debugging endpoint; line 1 is the port, line 2 the websocket path.
async fn wait_devtools_port(profile: &Path, startup_timeout: Duration) -> Result<Str> {
	let file = profile.join("DevToolsActivePort");
	let deadline = Instant::now() + startup_timeout;
	loop {
		if let Ok(text) = fs::read_to_string(&file) {
			let mut lines = text.lines();
			if let (Some(port), Some(path)) = (lines.next(), lines.next())
				&& let Ok(port) = port.trim().parse::<u16>()
			{
				return Ok(sf!("ws://127.0.0.1:{port}{}", path.trim()));
			}
		}
		if Instant::now() >= deadline {
			return Err(Error::Timeout("waiting for the DevTools port"));
		}
		sleep(POLL_INTERVAL).await;
	}
}

/// Create, attach, and configure the headless screencast target.
async fn wire_frames(cdp: &mut Cdp, config: FrameConfig, page: &PageOptions) -> Result<()> {
	let created = cdp
		.browser("Target.createTarget", json!({ "url": "about:blank" }))
		.await?;
	let target = created
		.get("targetId")
		.and_then(Value::as_str)
		.ok_or_else(|| Error::Protocol("createTarget: missing targetId".to_str()))?
		.to_str();
	cdp.attach(target).await?;
	wire_page(cdp, page).await?;
	cdp.set_metrics(&config).await?;
	if page.transparent {
		cdp.set_background([0, 0, 0, 0]).await?;
	} else if let Some(color) = page.background {
		cdp.set_background(color).await?;
	}
	let url = match (&page.url, &page.html) {
		(Some(url), _) => Some(url.clone()),
		(None, Some(html)) => Some(data_url(html)),
		// The fresh target already shows about:blank.
		(None, None) => None,
	};
	if let Some(url) = url {
		cdp.cmd("Page.navigate", json!({ "url": &*url })).await?;
	}
	// Headless targets start hidden and `Page.startScreencast` rejects
	// inactive pages ("Not attached to an active page"). Activation also
	// races the renderer-process swap a cross-origin navigation triggers, so
	// retry the activate + start pair briefly instead of failing the launch.
	let target = cdp.target.clone();
	let mut last = Ok(());
	for _ in 0..20 {
		cdp.browser("Target.activateTarget", json!({ "targetId": &*target }))
			.await?;
		last = cdp.start_screencast(&config).await;
		match &last {
			Ok(()) => return Ok(()),
			Err(Error::Protocol(_)) => sleep(Duration::from_millis(100)).await,
			Err(_) => break,
		}
	}
	last
}

/// Attach to the best existing page target. A matcher is compared against both
/// title and URL; an implicit relay attachment prefers the visible eligible
/// page so it adopts the user's foreground tab.
async fn wire_attached(
	cdp: &mut Cdp,
	target_matcher: Option<&str>,
	config: FrameConfig,
	page: &PageOptions,
) -> Result<()> {
	let kind = cdp
		.attached
		.ok_or_else(|| Error::Protocol("attached CDP identity is missing".to_str()))?;
	let targets = cdp.browser("Target.getTargets", json!({})).await?;
	let infos = targets
		.get("targetInfos")
		.and_then(Value::as_array)
		.ok_or_else(|| Error::Protocol("getTargets: missing targetInfos".to_str()))?;
	let eligible = infos
		.iter()
		.enumerate()
		.filter_map(|(index, info)| target_is_eligible(info, target_matcher).then_some(index))
		.collect::<Vec<_>>();
	let mut selected = *eligible.first().ok_or_else(|| {
		Error::Protocol("no eligible CDP page matched the requested target".to_str())
	})?;
	if kind == AttachedKind::Relay && target_matcher.is_none() && eligible.len() > 1 {
		for index in eligible {
			let Some(target) = infos[index].get("targetId").and_then(Value::as_str) else {
				continue;
			};
			if cdp.probe_target_visible(target).await {
				selected = index;
				break;
			}
		}
	}
	let info = &infos[selected];
	let target = info
		.get("targetId")
		.and_then(Value::as_str)
		.ok_or_else(|| Error::Protocol("getTargets: missing targetId".to_str()))?
		.to_str();
	let url = info
		.get("url")
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_str();
	let title = info
		.get("title")
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_str();
	cdp.screenshot_focus = screenshot_focus(kind, target_matcher.is_some());
	cdp.attach(target).await?;
	if should_claim_target(kind) {
		cdp.cmd("OMP.claimTarget", json!({})).await?;
	}
	wire_page(cdp, page).await?;
	if should_override_attached_viewport(kind, page.viewport_explicit) {
		cdp.set_metrics(&config).await?;
	}
	{
		let mut state = cdp.state.lock();
		state.url = url;
		state.title = title;
	}
	if let Some(url) = page.url.as_ref() {
		cdp.cmd("Page.navigate", json!({ "url": &**url })).await?;
	}
	Ok(())
}

fn target_is_eligible(info: &Value, target_matcher: Option<&str>) -> bool {
	if info.get("type").and_then(Value::as_str) != Some("page") {
		return false;
	}
	let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
	if url.starts_with("devtools:") || url.starts_with("chrome-extension:") {
		return false;
	}
	target_matcher.is_none_or(|matcher| {
		url.contains(matcher)
			|| info
				.get("title")
				.and_then(Value::as_str)
				.is_some_and(|title| title.contains(matcher))
	})
}

const fn should_claim_target(kind: AttachedKind) -> bool {
	matches!(kind, AttachedKind::Relay)
}

const fn should_override_attached_viewport(kind: AttachedKind, explicit: bool) -> bool {
	matches!(kind, AttachedKind::Cdp) || explicit
}

const fn screenshot_focus(kind: AttachedKind, target_explicit: bool) -> ScreenshotFocus {
	match (kind, target_explicit) {
		(AttachedKind::Relay, true) => ScreenshotFocus::Activate,
		(AttachedKind::Relay, false) => ScreenshotFocus::RequireVisible,
		(AttachedKind::Cdp, _) => ScreenshotFocus::None,
	}
}

/// Find the `--app` window's page target, attach, and configure it.
async fn wire_window(cdp: &mut Cdp, page: &PageOptions) -> Result<()> {
	// The window's page target may not exist yet right after connect.
	let deadline = Instant::now() + STARTUP_TIMEOUT;
	let (target, url, title) = loop {
		let targets = cdp.browser("Target.getTargets", json!({})).await?;
		let found = targets
			.get("targetInfos")
			.and_then(Value::as_array)
			.and_then(|infos| {
				infos
					.iter()
					.find(|info| info.get("type").and_then(Value::as_str) == Some("page"))
			});
		if let Some(info) = found {
			break (
				info
					.get("targetId")
					.and_then(Value::as_str)
					.ok_or_else(|| Error::Protocol("getTargets: missing targetId".to_str()))?
					.to_str(),
				info
					.get("url")
					.and_then(Value::as_str)
					.unwrap_or_default()
					.to_str(),
				info
					.get("title")
					.and_then(Value::as_str)
					.unwrap_or_default()
					.to_str(),
			);
		}
		if Instant::now() >= deadline {
			return Err(Error::Timeout("waiting for the app window target"));
		}
		sleep(POLL_INTERVAL).await;
	};
	cdp.attach(target).await?;
	wire_page(cdp, page).await?;
	if let Some(color) = page.background {
		cdp.set_background(color).await?;
	}
	// The initial document can outrun `addScriptToEvaluateOnNewDocument`;
	// install the shim into the live context too (best-effort, idempotent).
	let shim = json!({ "expression": IPC_SHIM, "returnByValue": true });
	let _ = cdp.cmd("Runtime.evaluate", shim).await;
	let mut state = cdp.state.lock();
	state.url = url;
	state.title = title;
	drop(state);
	Ok(())
}

/// Session wiring shared by both surfaces: IPC binding + shim, user init
/// scripts (in order, before document scripts), then page-domain events.
async fn wire_page(cdp: &mut Cdp, page: &PageOptions) -> Result<()> {
	cdp.cmd("Runtime.enable", json!({})).await?;
	cdp.cmd("Runtime.addBinding", json!({ "name": IPC_BINDING }))
		.await?;
	cdp.cmd("Page.addScriptToEvaluateOnNewDocument", json!({ "source": IPC_SHIM }))
		.await?;
	if !page.headers.is_empty() {
		let headers = page
			.headers
			.iter()
			.map(|(name, value)| (name.to_string(), Value::String(value.to_string())))
			.collect::<serde_json::Map<_, _>>();
		cdp.cmd("Network.enable", json!({})).await?;
		cdp.cmd("Network.setExtraHTTPHeaders", json!({ "headers": headers }))
			.await?;
	}
	for script in &page.init_scripts {
		cdp.cmd("Page.addScriptToEvaluateOnNewDocument", json!({ "source": &**script }))
			.await?;
	}
	cdp.cmd("Page.enable", json!({})).await?;
	let frame_tree = cdp.cmd("Page.getFrameTree", json!({})).await?;
	cdp.main_frame = frame_tree
		.pointer("/frameTree/frame/id")
		.and_then(Value::as_str)
		.ok_or_else(|| Error::Protocol("Page.getFrameTree: missing main frame id".to_str()))?
		.to_str();
	cdp.cmd("DOM.enable", json!({})).await?;
	cdp.cmd("Accessibility.enable", json!({})).await.map(drop)
}

/// Live CDP connection driving one page target.
struct Cdp {
	/// Browser-level websocket carrying flattened sessions.
	link:             WsLink,
	/// Monotonically increasing command id.
	next_id:          u64,
	/// Flat session id of the attached page target; empty until attached.
	session:          Str,
	/// Target id of the page.
	target:           Str,
	/// Explicit identity of a foreign endpoint; `None` for owned browsers.
	attached:         Option<AttachedKind>,
	/// Focus policy applied immediately before screenshots.
	screenshot_focus: ScreenshotFocus,
	/// Current top-level frame id reported by `Page.frameNavigated`.
	main_frame:       Str,
	/// Default execution contexts belonging to the current top-level frame.
	main_contexts:    HashSet<u64>,
	/// Event sink towards the host.
	events:           flume::Sender<WebViewEvent>,
	/// Shared url/title cache kept current from protocol events.
	state:            SharedState,
	/// Frames surface config; `None` for window surfaces.
	frame_cfg:        Option<FrameConfig>,
	/// Minimum interval between emitted frames (`fps_cap`).
	frame_interval:   Option<Duration>,
	/// When the last frame was emitted to the host.
	last_frame:       Option<Instant>,
	/// Pixels of the last delivered frame, for damage-rect computation.
	last_pixels:      Option<bytes::Bytes>,
	/// The page target or the socket is gone; the session is over.
	closed:           bool,
	/// A load finished; the main loop should re-read `document.title`.
	title_dirty:      bool,
	/// Out-of-band forced close observed while protocol calls are pending.
	cancelled:        Arc<AtomicBool>,
}

impl Cdp {
	/// Wrap a fresh browser-level connection; targets attach later.
	fn new(
		link: WsLink,
		events: flume::Sender<WebViewEvent>,
		state: SharedState,
		frame_cfg: Option<FrameConfig>,
		cancelled: Arc<AtomicBool>,
		attached: Option<AttachedKind>,
	) -> Self {
		let frame_interval = frame_cfg
			.and_then(|cfg| cfg.fps_cap)
			.filter(|fps| *fps > 0.0)
			.map(|fps| Duration::from_secs_f64(1.0 / f64::from(fps)));
		Self {
			link,
			next_id: 1,
			session: Str::default(),
			target: Str::default(),
			attached,
			screenshot_focus: ScreenshotFocus::None,
			main_frame: Str::default(),
			main_contexts: HashSet::new(),
			events,
			state,
			frame_cfg,
			frame_interval,
			last_frame: None,
			last_pixels: None,
			closed: false,
			title_dirty: false,
			cancelled,
		}
	}

	/// Attach to `target` with a flat session and subscribe to target
	/// lifecycle events (`targetInfoChanged` carries title updates).
	async fn attach(&mut self, target: Str) -> Result<()> {
		let attached = self
			.browser("Target.attachToTarget", json!({ "targetId": &*target, "flatten": true }))
			.await?;
		let session = attached
			.get("sessionId")
			.and_then(Value::as_str)
			.ok_or_else(|| Error::Protocol("attachToTarget: missing sessionId".to_str()))?
			.to_str();
		self.target = target;
		self.session = session;
		self
			.browser("Target.setDiscoverTargets", json!({ "discover": true }))
			.await
			.map(drop)
	}

	/// Best-effort foreground probe used only to rank implicit relay targets.
	async fn probe_target_visible(&mut self, target: &str) -> bool {
		let attached = self
			.browser("Target.attachToTarget", json!({ "targetId": target, "flatten": true }))
			.await;
		let Some(session) = attached
			.ok()
			.and_then(|value| value.get("sessionId").and_then(Value::as_str).map(Str::new))
		else {
			return false;
		};
		let visible = self
			.call(
				"Runtime.evaluate",
				json!({
					"expression": "document.visibilityState === 'visible'",
					"returnByValue": true,
				}),
				Some(session.clone()),
			)
			.await
			.ok()
			.and_then(|value| value.pointer("/result/value").and_then(Value::as_bool))
			.unwrap_or(false);
		let _ = self
			.browser("Target.detachFromTarget", json!({ "sessionId": &*session }))
			.await;
		visible
	}

	/// Browser-scoped call (no session id).
	async fn browser(&mut self, method: &str, params: Value) -> Result<Value> {
		self.call(method, params, None).await
	}

	/// Session-scoped call to the attached page target.
	async fn cmd(&mut self, method: &str, params: Value) -> Result<Value> {
		self.call(method, params, Some(self.session.clone())).await
	}

	/// Send one command and pump the socket until its reply arrives,
	/// dispatching interleaved events so none are dropped mid-call.
	async fn call(&mut self, method: &str, params: Value, session: Option<Str>) -> Result<Value> {
		let id = self.next_id;
		self.next_id += 1;
		let mut msg = json!({ "id": id, "method": method, "params": params });
		if let Some(session) = session {
			msg["sessionId"] = json!(&*session);
		}
		self.link.send_json(&msg).await?;
		let deadline = Instant::now() + CALL_TIMEOUT;
		loop {
			if self.cancelled.load(Ordering::Acquire) {
				self.closed = true;
				return Err(Error::Closed);
			}
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Err(Error::Timeout("waiting for a CDP reply"));
			}
			let reply =
				match timeout(remaining.min(Duration::from_millis(25)), self.link.recv_json()).await {
					Ok(reply) => reply?,
					Err(_) => continue,
				};
			let Some(reply) = reply else {
				self.closed = true;
				return Err(Error::Closed);
			};
			match reply.get("id").and_then(Value::as_u64) {
				Some(reply_id) if reply_id == id => {
					if let Some(err) = reply.get("error") {
						let text = err
							.get("message")
							.and_then(Value::as_str)
							.unwrap_or("unknown");
						return Err(Error::Protocol(sf!("{method}: {text}")));
					}
					return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
				},
				// Reply to a fire-and-forget message (frame ack); drop it.
				Some(_) => {},
				None => self.handle_event(&reply).await?,
			}
		}
	}

	/// Send a command without waiting for its reply (screencast acks).
	async fn send_note(&mut self, method: &str, params: Value) -> Result<()> {
		let id = self.next_id;
		self.next_id += 1;
		let msg =
			json!({ "id": id, "method": method, "params": params, "sessionId": &*self.session });
		self.link.send_json(&msg).await
	}

	/// Pump commands and protocol traffic until the session ends.
	async fn run(mut self, commands: Receiver<Command>, child: Child) -> Result<()> {
		loop {
			if self.cancelled.load(Ordering::Acquire) {
				self.closed = true;
			}
			if self.closed {
				// Target destroyed or socket gone: reap without protocol.
				return self.shutdown(child).await;
			}
			if self.title_dirty {
				self.refresh_title().await?;
				continue;
			}
			tokio::select! {
				cmd = commands.recv_async() => match cmd {
					Ok(Command::Close) | Err(_) => return self.shutdown(child).await,
					Ok(cmd) => self.handle_command(cmd).await?,
				},
				msg = self.link.recv_json() => match msg? {
					Some(msg) => self.handle_event(&msg).await?,
					None => self.closed = true,
				},
			}
		}
	}

	/// Pump an attached target until the handle closes, then detach without
	/// closing the foreign page or browser.
	async fn run_attached(mut self, commands: Receiver<Command>) -> Result<()> {
		loop {
			if self.cancelled.load(Ordering::Acquire) {
				self.closed = true;
			}
			if self.closed {
				return Ok(());
			}
			if self.title_dirty {
				self.refresh_title().await?;
				continue;
			}
			tokio::select! {
				cmd = commands.recv_async() => match cmd {
					Ok(Command::Close) | Err(_) => return self.detach().await,
					Ok(cmd) => self.handle_command(cmd).await?,
				},
				msg = self.link.recv_json() => match msg? {
					Some(msg) => self.handle_event(&msg).await?,
					None => self.closed = true,
				},
			}
		}
	}

	async fn detach(&mut self) -> Result<()> {
		if self.closed || self.session.is_empty() {
			return Ok(());
		}
		let session = self.session.clone();
		let _ = timeout(
			CLOSE_TIMEOUT,
			self.browser("Target.detachFromTarget", json!({ "sessionId": &*session })),
		)
		.await;
		Ok(())
	}

	/// Politely close the browser, then reap the child within a bounded grace.
	async fn shutdown(mut self, mut child: Child) -> Result<()> {
		if !self.closed {
			if self.frame_cfg.is_some() {
				let _ = timeout(CLOSE_TIMEOUT, self.cmd("Page.stopScreencast", json!({}))).await;
			}
			let _ = timeout(CLOSE_TIMEOUT, self.browser("Browser.close", json!({}))).await;
		}
		if timeout(EXIT_TIMEOUT, child.wait()).await.is_err() {
			let _ = child.kill().await;
		}
		Ok(())
	}

	/// Execute one host command; user commands are best-effort, so a protocol
	/// rejection (bad URL, ...) never kills the session, transport loss does.
	async fn handle_command(&mut self, cmd: Command) -> Result<()> {
		let result = match cmd {
			Command::Navigate(url) => self
				.cmd("Page.navigate", json!({ "url": &*url }))
				.await
				.map(drop),
			Command::LoadHtml(html) => self
				.cmd("Page.navigate", json!({ "url": &*data_url(&html) }))
				.await
				.map(drop),
			Command::Eval { js, reply } => return self.eval(&js, reply).await,
			Command::AccessibilityTree { reply } => return self.accessibility_tree(reply).await,
			Command::UploadFiles { element, paths, reply } => {
				return self.upload_files(&element, &paths, reply).await;
			},
			Command::Screenshot { clip, full_page, reply } => {
				return self.screenshot(clip, full_page, reply).await;
			},
			Command::Back => self.history_step(-1).await,
			Command::Forward => self.history_step(1).await,
			Command::Reload => self.cmd("Page.reload", json!({})).await.map(drop),
			Command::Focus => self.cmd("Page.bringToFront", json!({})).await.map(drop),
			Command::Resize { width, height } => self.resize(width, height).await,
			Command::Input(input) => self.dispatch_input(input).await,
			// Handled by `run` before dispatch; unreachable here.
			Command::Close => Ok(()),
		};
		match result {
			Err(Error::Protocol(_)) => Ok(()),
			other => other,
		}
	}

	/// Evaluate JS in the page, feeding `reply` the JSON-encoded value or, on
	/// a thrown exception, its description (the session stays alive).
	async fn eval(&mut self, js: &str, reply: Option<Box<dyn FnOnce(Str) + Send>>) -> Result<()> {
		let result = self
			.cmd(
				"Runtime.evaluate",
				json!({ "expression": js, "returnByValue": true, "awaitPromise": true }),
			)
			.await;
		let Some(reply) = reply else {
			return match result {
				Err(Error::Protocol(_)) | Ok(_) => Ok(()),
				Err(other) => Err(other),
			};
		};
		match result {
			Ok(value) => {
				let text = if let Some(details) = value.get("exceptionDetails") {
					exception_text(details)
				} else {
					sf!("{}", value.pointer("/result/value").unwrap_or(&Value::Null))
				};
				reply(text);
				Ok(())
			},
			Err(Error::Protocol(text)) => {
				reply(text);
				Ok(())
			},
			Err(other) => Err(other),
		}
	}

	/// Step through session history; a no-op at either history edge.
	async fn accessibility_tree(&mut self, reply: flume::Sender<Result<Value>>) -> Result<()> {
		match self
			.cmd("Accessibility.getFullAXTree", json!({ "depth": -1 }))
			.await
		{
			Ok(value) => {
				let _ = reply.send(Ok(value));
				Ok(())
			},
			Err(Error::Protocol(message)) => {
				let _ = reply.send(Err(Error::Protocol(message)));
				Ok(())
			},
			Err(error) => Err(error),
		}
	}

	async fn upload_files(
		&mut self,
		element: &str,
		paths: &[PathBuf],
		reply: flume::Sender<Result<()>>,
	) -> Result<()> {
		let result = async {
			let evaluated = self
				.cmd(
					"Runtime.evaluate",
					json!({
						"expression": element,
						"returnByValue": false,
						"awaitPromise": true,
					}),
				)
				.await?;
			let object_id = evaluated
				.pointer("/result/objectId")
				.and_then(Value::as_str)
				.ok_or_else(|| Error::Protocol("file input selector did not resolve".to_str()))?;
			let described = self
				.cmd("DOM.describeNode", json!({ "objectId": object_id }))
				.await?;
			let backend_node_id = described
				.pointer("/node/backendNodeId")
				.and_then(Value::as_u64)
				.ok_or_else(|| Error::Protocol("file input has no backend node id".to_str()))?;
			let files = paths
				.iter()
				.map(|path| path.to_string_lossy().into_owned())
				.collect::<Vec<_>>();
			self
				.cmd(
					"DOM.setFileInputFiles",
					json!({ "files": files, "backendNodeId": backend_node_id }),
				)
				.await
				.map(drop)
		}
		.await;
		match result {
			Ok(()) => {
				let _ = reply.send(Ok(()));
				Ok(())
			},
			Err(Error::Protocol(message)) => {
				let _ = reply.send(Err(Error::Protocol(message)));
				Ok(())
			},
			Err(error) => Err(error),
		}
	}

	async fn screenshot(
		&mut self,
		mut clip: Option<[f64; 4]>,
		full_page: bool,
		reply: flume::Sender<Result<bytes::Bytes>>,
	) -> Result<()> {
		let result = async {
			self.prepare_screenshot_target().await?;
			if full_page {
				let metrics = self.cmd("Page.getLayoutMetrics", json!({})).await?;
				let size = metrics
					.get("cssContentSize")
					.or_else(|| metrics.get("contentSize"))
					.ok_or_else(|| Error::Protocol("layout metrics omitted content size".to_str()))?;
				clip = Some([
					size.get("x").and_then(Value::as_f64).unwrap_or_default(),
					size.get("y").and_then(Value::as_f64).unwrap_or_default(),
					size
						.get("width")
						.and_then(Value::as_f64)
						.unwrap_or_default(),
					size
						.get("height")
						.and_then(Value::as_f64)
						.unwrap_or_default(),
				]);
			}
			let mut params = json!({
				"format": "png",
				"captureBeyondViewport": full_page || clip.is_some(),
				"fromSurface": true,
			});
			if let Some([x, y, width, height]) = clip {
				params["clip"] = json!({
					"x": x,
					"y": y,
					"width": width,
					"height": height,
					"scale": 1,
				});
			}
			let captured = self.cmd("Page.captureScreenshot", params).await?;
			let data = captured
				.get("data")
				.and_then(Value::as_str)
				.ok_or_else(|| Error::Protocol("screenshot omitted image data".to_str()))?;
			base64::decode(data)
				.into_vec()
				.map(bytes::Bytes::from)
				.map_err(|source| Error::ScreencastFrameBase64 { source })
		}
		.await;
		match result {
			Ok(bytes) => {
				let _ = reply.send(Ok(bytes));
				Ok(())
			},
			Err(Error::Protocol(message)) => {
				let _ = reply.send(Err(Error::Protocol(message)));
				Ok(())
			},
			Err(error) => Err(error),
		}
	}

	/// Prevent compositor capture from returning pixels for a sibling tab.
	async fn prepare_screenshot_target(&mut self) -> Result<()> {
		match self.screenshot_focus {
			ScreenshotFocus::None => Ok(()),
			ScreenshotFocus::Activate => self.cmd("Page.bringToFront", json!({})).await.map(drop),
			ScreenshotFocus::RequireVisible => {
				let visible = self
					.cmd(
						"Runtime.evaluate",
						json!({
							"expression": "document.visibilityState === 'visible'",
							"returnByValue": true,
						}),
					)
					.await
					.ok()
					.and_then(|value| value.pointer("/result/value").and_then(Value::as_bool))
					.unwrap_or(false);
				if visible {
					Ok(())
				} else {
					Err(Error::Protocol(
						"The attached browser tab is not visible; switch to it before taking a \
						 screenshot"
							.to_str(),
					))
				}
			},
		}
	}

	async fn history_step(&mut self, delta: i64) -> Result<()> {
		let history = self.cmd("Page.getNavigationHistory", json!({})).await?;
		let current = history
			.get("currentIndex")
			.and_then(Value::as_i64)
			.unwrap_or(0);
		let Some(entries) = history.get("entries").and_then(Value::as_array) else {
			return Ok(());
		};
		let index = current + delta;
		if index < 0 || index as usize >= entries.len() {
			return Ok(());
		}
		let Some(entry) = entries[index as usize].get("id").and_then(Value::as_i64) else {
			return Ok(());
		};
		self
			.cmd("Page.navigateToHistoryEntry", json!({ "entryId": entry }))
			.await
			.map(drop)
	}

	/// Resize the emulated viewport and restart the screencast to match.
	/// Facade-gated to frames surfaces; a window surface ignores it.
	async fn resize(&mut self, width: u32, height: u32) -> Result<()> {
		let Some(cfg) = self.frame_cfg.as_mut() else {
			return Ok(());
		};
		cfg.width = width;
		cfg.height = height;
		let cfg = *cfg;
		self.set_metrics(&cfg).await?;
		// The viewport changed; the next frame is a full redraw.
		self.last_pixels = None;
		self.cmd("Page.stopScreencast", json!({})).await?;
		self.start_screencast(&cfg).await
	}

	/// Forward one synthetic input event. Facade-gated to frames surfaces.
	async fn dispatch_input(&mut self, input: Input) -> Result<()> {
		match input {
			Input::MouseMove { x, y } => {
				self
					.cmd("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }))
					.await
			},
			Input::MouseDown { button, x, y, clicks } => {
				let button: &'static str = button.into();
				self
					.cmd(
						"Input.dispatchMouseEvent",
						json!({
							"type": "mousePressed", "x": x, "y": y,
							"button": button, "clickCount": clicks,
						}),
					)
					.await
			},
			Input::MouseUp { button, x, y } => {
				let button: &'static str = button.into();
				self
					.cmd(
						"Input.dispatchMouseEvent",
						json!({
							"type": "mouseReleased", "x": x, "y": y,
							"button": button, "clickCount": 1,
						}),
					)
					.await
			},
			// CDP wheel deltas share our convention: positive dy scrolls down.
			Input::Scroll { x, y, dx, dy } => {
				self
					.cmd(
						"Input.dispatchMouseEvent",
						json!({
							"type": "mouseWheel", "x": x, "y": y,
							"deltaX": dx, "deltaY": dy,
						}),
					)
					.await
			},
			Input::KeyDown { key, modifiers } => {
				let mut params = json!({
					"type": "keyDown",
					"key": &*key_name(key),
					"modifiers": modifier_bits(modifiers),
				});
				// Printable keys carry text so the page sees a keypress,
				// except in shortcut chords where no text is produced.
				if let Key::Char(c) = key
					&& !modifiers.ctrl
					&& !modifiers.meta
				{
					params["text"] = json!(c);
				}
				self.cmd("Input.dispatchKeyEvent", params).await
			},
			Input::KeyUp { key, modifiers } => {
				self
					.cmd(
						"Input.dispatchKeyEvent",
						json!({
							"type": "keyUp",
							"key": &*key_name(key),
							"modifiers": modifier_bits(modifiers),
						}),
					)
					.await
			},
			Input::Text(text) => {
				self
					.cmd("Input.insertText", json!({ "text": &*text }))
					.await
			},
		}
		.map(drop)
	}

	/// Apply the emulated viewport metrics for a frames surface.
	async fn set_metrics(&mut self, cfg: &FrameConfig) -> Result<()> {
		self
			.cmd(
				"Emulation.setDeviceMetricsOverride",
				json!({
					"width": cfg.width, "height": cfg.height,
					"deviceScaleFactor": cfg.scale, "mobile": false,
				}),
			)
			.await
			.map(drop)
	}

	/// Override the default page background (CDP alpha is 0..=1).
	async fn set_background(&mut self, [r, g, b, a]: [u8; 4]) -> Result<()> {
		self
			.cmd(
				"Emulation.setDefaultBackgroundColorOverride",
				json!({ "color": { "r": r, "g": g, "b": b, "a": f64::from(a) / 255.0 } }),
			)
			.await
			.map(drop)
	}

	/// Start the screencast sized to the device-pixel viewport, encoded per
	/// the configured [`FrameFormat`].
	async fn start_screencast(&mut self, cfg: &FrameConfig) -> Result<()> {
		let mut params = json!({
			"format": match cfg.format {
				FrameFormat::Png => "png",
				FrameFormat::Jpeg { .. } => "jpeg",
			},
			"maxWidth": (f64::from(cfg.width) * cfg.scale).ceil() as u32,
			"maxHeight": (f64::from(cfg.height) * cfg.scale).ceil() as u32,
			"everyNthFrame": 1,
		});
		if let FrameFormat::Jpeg { quality } = cfg.format {
			params["quality"] = json!(u32::from(quality.clamp(1, 100)));
		}
		self.cmd("Page.startScreencast", params).await.map(drop)
	}

	/// Re-read `document.title` after a load; static HTML titles do not
	/// always produce a `Target.targetInfoChanged`.
	async fn refresh_title(&mut self) -> Result<()> {
		self.title_dirty = false;
		let result = self
			.cmd("Runtime.evaluate", json!({ "expression": "document.title", "returnByValue": true }))
			.await;
		match result {
			Ok(value) => {
				if let Some(title) = value.pointer("/result/value").and_then(Value::as_str) {
					self.set_title(title);
				}
				Ok(())
			},
			// Best-effort: a navigation race here is not fatal.
			Err(Error::Protocol(_)) => Ok(()),
			Err(other) => Err(other),
		}
	}

	/// Dispatch one protocol event; shared by the main loop and the in-call
	/// pump so no traffic is dropped while a reply is pending.
	async fn handle_event(&mut self, msg: &Value) -> Result<()> {
		let Some(method) = msg.get("method").and_then(Value::as_str) else {
			return Ok(());
		};
		if is_foreign_page_session_event(msg, method, &self.session) {
			return Ok(());
		}
		let params = msg.get("params").unwrap_or(&Value::Null);
		match method {
			"Page.screencastFrame" => return self.on_screencast_frame(params).await,
			"Page.frameNavigated" => {
				// Only the main frame (no parentId) commits a view navigation.
				let frame = &params["frame"];
				if frame.get("parentId").is_none() {
					if let Some(frame_id) = frame.get("id").and_then(Value::as_str) {
						self.main_frame = frame_id.to_str();
						self.main_contexts.clear();
					}
					if let Some(url) = frame.get("url").and_then(Value::as_str) {
						self.set_url(url);
					}
				}
			},
			"Runtime.executionContextCreated" => {
				let context = &params["context"];
				let auxiliary = &context["auxData"];
				if auxiliary.get("isDefault").and_then(Value::as_bool) == Some(true)
					&& auxiliary.get("frameId").and_then(Value::as_str) == Some(self.main_frame.as_str())
					&& let Some(id) = context.get("id").and_then(Value::as_u64)
				{
					self.main_contexts.insert(id);
				}
			},
			"Runtime.executionContextDestroyed" => {
				if let Some(id) = params.get("executionContextId").and_then(Value::as_u64) {
					self.main_contexts.remove(&id);
				}
			},
			"Runtime.executionContextsCleared" => self.main_contexts.clear(),
			"Page.navigatedWithinDocument" => {
				if let Some(url) = params.get("url").and_then(Value::as_str) {
					self.set_url(url);
				}
			},
			"Page.frameStartedLoading" => {
				if event_is_for_main_frame(params, &self.main_frame) {
					let url = self.state.lock().url.clone();
					let _ = self.events.send(WebViewEvent::LoadStarted(url));
				}
			},
			"Page.loadEventFired" => {
				self.title_dirty = true;
				let url = self.state.lock().url.clone();
				let _ = self.events.send(WebViewEvent::LoadFinished(url));
			},
			"Runtime.bindingCalled" => {
				if params.get("name").and_then(Value::as_str) == Some(IPC_BINDING)
					&& binding_is_from_main_context(params, &self.main_contexts)
					&& let Some(payload) = params.get("payload").and_then(Value::as_str)
				{
					let _ = self.events.send(WebViewEvent::Ipc(payload.to_str()));
				}
			},
			// Arrives on the browser session (via setDiscoverTargets) and
			// carries title updates for attached pages.
			"Target.targetInfoChanged" => {
				let info = &params["targetInfo"];
				if info.get("targetId").and_then(Value::as_str) == Some(&*self.target)
					&& let Some(title) = info.get("title").and_then(Value::as_str)
				{
					self.set_title(title);
				}
			},
			"Target.targetDestroyed" => {
				if params.get("targetId").and_then(Value::as_str) == Some(&*self.target) {
					self.closed = true;
				}
			},
			"Target.detachedFromTarget" | "Inspector.detached" => {
				// Inspector.detached is session-scoped; detachedFromTarget
				// names the detached session in its params.
				let session = msg
					.get("sessionId")
					.or_else(|| params.get("sessionId"))
					.and_then(Value::as_str);
				if session == Some(&*self.session) {
					self.closed = true;
				}
			},
			_ => {},
		}
		Ok(())
	}

	/// Ack, rate-limit, decode, and emit one screencast frame.
	async fn on_screencast_frame(&mut self, params: &Value) -> Result<()> {
		// Always ack first: the screencast stalls without flow-control acks.
		if let Some(ack) = params.get("sessionId").cloned() {
			self
				.send_note("Page.screencastFrameAck", json!({ "sessionId": ack }))
				.await?;
		}
		let Some(data) = params.get("data").and_then(Value::as_str) else {
			return Ok(());
		};
		if let Some(interval) = self.frame_interval
			&& let Some(last) = self.last_frame
			&& last.elapsed() < interval
		{
			return Ok(());
		}
		let bytes = base64::decode(data)
			.into_vec()
			.map_err(|source| Error::ScreencastFrameBase64 { source })?;
		let format = self.frame_cfg.map_or(FrameFormat::Png, |cfg| cfg.format);
		let mut frame = decode_frame(format, &bytes)?;
		match &self.last_pixels {
			Some(prev) if prev.len() == frame.data.len() => {
				// Screencast damage is whole-frame granular; tighten it (and
				// drop frames that decoded identical despite the signal).
				match damage_rect(prev, &frame.data, frame.width) {
					Some(rect) => frame.damage = rect,
					None => return Ok(()),
				}
			},
			// First frame or a size change: full damage (decoder default).
			_ => {},
		}
		self.last_pixels = Some(frame.data.clone());
		self.last_frame = Some(Instant::now());
		let _ = self.events.send(WebViewEvent::Frame(frame));
		Ok(())
	}

	/// Record a committed URL and notify the host.
	fn set_url(&self, url: &str) {
		tracing::debug!(scheme = crate::navigation_scheme(url), "webview navigation committed");
		let url = url.to_str();
		self.state.lock().url = url.clone();
		let _ = self.events.send(WebViewEvent::Navigated(url));
	}

	/// Record a title and notify the host, deduplicating repeats.
	fn set_title(&self, title: &str) {
		let mut state = self.state.lock();
		if &*state.title == title {
			return;
		}
		state.title = title.to_str();
		let title = state.title.clone();
		drop(state);
		let _ = self.events.send(WebViewEvent::TitleChanged(title));
	}
}

fn is_foreign_page_session_event(msg: &Value, method: &str, root_session: &str) -> bool {
	(method.starts_with("Page.") || method.starts_with("Runtime."))
		&& msg
			.get("sessionId")
			.and_then(Value::as_str)
			.is_some_and(|session| session != root_session)
}

fn event_is_for_main_frame(params: &Value, main_frame: &str) -> bool {
	params.get("frameId").and_then(Value::as_str) == Some(main_frame)
}

fn binding_is_from_main_context(params: &Value, main_contexts: &HashSet<u64>) -> bool {
	params
		.get("executionContextId")
		.and_then(Value::as_u64)
		.is_some_and(|id| main_contexts.contains(&id))
}

/// Extract a human-readable message from `Runtime.evaluate` exception details.
fn exception_text(details: &Value) -> Str {
	if let Some(text) = details
		.pointer("/exception/description")
		.and_then(Value::as_str)
	{
		return text.to_str();
	}
	details
		.get("text")
		.and_then(Value::as_str)
		.unwrap_or("uncaught exception")
		.to_str()
}

/// CDP `Input.dispatchKeyEvent` name for a key identity.
fn key_name(key: Key) -> Str {
	const F_KEYS: [&str; 24] = [
		"F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14",
		"F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
	];
	match key {
		Key::Char(c) => {
			let mut buf = [0; 4];
			Str::new(c.encode_utf8(&mut buf))
		},
		Key::Enter => "Enter".to_str(),
		Key::Tab => "Tab".to_str(),
		Key::Backspace => "Backspace".to_str(),
		Key::Delete => "Delete".to_str(),
		Key::Escape => "Escape".to_str(),
		Key::ArrowUp => "ArrowUp".to_str(),
		Key::ArrowDown => "ArrowDown".to_str(),
		Key::ArrowLeft => "ArrowLeft".to_str(),
		Key::ArrowRight => "ArrowRight".to_str(),
		Key::Home => "Home".to_str(),
		Key::End => "End".to_str(),
		Key::PageUp => "PageUp".to_str(),
		Key::PageDown => "PageDown".to_str(),
		Key::F(n) => sf!(F_KEYS[usize::from(n.clamp(1, 24) - 1)]),
	}
}

/// CDP modifier bitmask: alt=1, ctrl=2, meta=4, shift=8.
fn modifier_bits(m: Modifiers) -> u32 {
	u32::from(m.alt)
		| (u32::from(m.ctrl) << 1)
		| (u32::from(m.meta) << 2)
		| (u32::from(m.shift) << 3)
}
#[cfg(test)]
mod ipc_tests {
	use super::*;

	#[test]
	fn binding_requires_current_top_level_execution_context() {
		let contexts = HashSet::from([41]);
		assert!(binding_is_from_main_context(&json!({ "executionContextId": 41 }), &contexts,));
		assert!(!binding_is_from_main_context(&json!({ "executionContextId": 42 }), &contexts,));
		assert!(!binding_is_from_main_context(&json!({}), &contexts));
	}

	#[test]
	fn relay_protocol_is_selected_by_identity_not_url_shape() {
		assert!(!should_claim_target(AttachedKind::Cdp));
		assert!(should_claim_target(AttachedKind::Relay));
	}

	#[test]
	fn relay_preserves_user_viewport_unless_explicit() {
		assert!(!PageOptions::default().viewport_explicit);
		assert!(!should_override_attached_viewport(AttachedKind::Relay, false));
		assert!(should_override_attached_viewport(AttachedKind::Relay, true));
		assert!(should_override_attached_viewport(AttachedKind::Cdp, false));
	}

	#[test]
	fn relay_screenshot_policy_preserves_or_activates_focus() {
		assert_eq!(screenshot_focus(AttachedKind::Relay, false), ScreenshotFocus::RequireVisible);
		assert_eq!(screenshot_focus(AttachedKind::Relay, true), ScreenshotFocus::Activate);
		assert_eq!(screenshot_focus(AttachedKind::Cdp, false), ScreenshotFocus::None);
	}

	#[test]
	fn child_page_and_runtime_events_do_not_reach_root_state() {
		let child_page = json!({
			"sessionId": "child",
			"method": "Page.frameNavigated",
			"params": {},
		});
		let child_runtime = json!({
			"sessionId": "child",
			"method": "Runtime.executionContextsCleared",
			"params": {},
		});
		let root_page = json!({
			"sessionId": "root",
			"method": "Page.frameNavigated",
			"params": {},
		});
		let browser_event = json!({
			"sessionId": "child",
			"method": "Target.detachedFromTarget",
			"params": {},
		});
		assert!(is_foreign_page_session_event(&child_page, "Page.frameNavigated", "root"));
		assert!(is_foreign_page_session_event(
			&child_runtime,
			"Runtime.executionContextsCleared",
			"root",
		));
		assert!(!is_foreign_page_session_event(&root_page, "Page.frameNavigated", "root"));
		assert!(!is_foreign_page_session_event(&browser_event, "Target.detachedFromTarget", "root",));
	}

	#[test]
	fn load_start_matches_the_captured_main_frame_not_target_id() {
		let event = json!({ "frameId": "real-main-frame" });
		assert!(event_is_for_main_frame(&event, "real-main-frame"));
		assert!(!event_is_for_main_frame(&event, "PAGE42"));
	}
}
