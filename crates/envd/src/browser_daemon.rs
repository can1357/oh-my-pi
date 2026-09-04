//! Supervised, session-owned browser automation over `omp-webview`.

use std::{
	collections::HashMap,
	io::Read as _,
	path::PathBuf,
	process::{Child, ChildStderr, ChildStdin, Command, ExitStatus, Stdio},
	sync::{
		Arc, LazyLock, Weak,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use async_trait::async_trait;
use flume::Receiver;
use omp_con::Ctx;
use omp_core::{IntoStr as _, Str, encoding::base64, sf};
use omp_tools::browser::{
	Action, Artifact, BrowserHost, Fault, Params, Payload, Update, WaitUntil, mode_name,
};
use omp_webview::{
	Engine, FrameConfig, SurfaceKind, WebView, WebViewBuilder, WindowConfig,
	automation::{ExtractFormat, ObserveOptions, Selector},
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
	SV_BROWSER_CDP_URL, SV_BROWSER_RELAY, SV_BROWSER_RELAY_URL,
	blobs::BlobHost,
	browser_relay::{
		RelayEndpoint, RelayLease, acquire_relay_lease_address, parse_relay_endpoint,
		probe_relay_ready_address_with_timeout, probe_relay_serving_address_with_timeout,
	},
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TIMEOUT: Duration = Duration::from_mins(5);
const POLL: Duration = Duration::from_millis(25);
const DEFAULT_RELAY_URL: &str = "http://127.0.0.1:9224";
/// Covers one complete 30-second MV3 extension alarm cycle plus reconnection.
const RELAY_EXTENSION_TIMEOUT: Duration = Duration::from_secs(35);
const RELAY_START_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_ADOPTION_TIMEOUT: Duration = Duration::from_secs(1);
const RELAY_PROBE_TIMEOUT: Duration = Duration::from_millis(150);
const MAX_RELAY_STDERR_BYTES: usize = 64 * 1024;
const MAX_DOWNLOAD_BYTES: usize = 32 * 1024 * 1024;

/// Process cache only: weak protocol leases prevent redundant connections.
/// Each strong lease is also counted by the machine-global relay process.
static RELAYS: LazyLock<Mutex<HashMap<Str, Weak<RelayLease>>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

omp_con::var! {
	/// Enable the browser eval prelude for scripted Chromium automation (Puppeteer).
	pub static SV_BROWSER_ENABLED = sv_browser_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Available Tools",
			"ui.label": "Browser",
			"legacy.path": "browser.enabled",
		},
	};
	/// Launch browser in headless mode (disable to show browser UI).
	pub static SV_BROWSER_HEADLESS = sv_browser_headless: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Grep & Browser",
			"ui.label": "Headless Browser",
			"legacy.path": "browser.headless",
		},
	};
}

/// Browser-tool availability and presentation mode.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserSettings {
	/// Enables the browser automation tool.
	pub enabled:   bool,
	/// Uses an offscreen frame surface instead of an engine-owned window.
	pub headless:  bool,
	/// Default existing CDP endpoint.
	pub cdp_url:   Str,
	/// Prefer the local browser relay.
	pub relay:     bool,
	/// Relay CDP discovery endpoint.
	pub relay_url: Str,
}

impl BrowserSettings {
	/// Resolves browser policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		let mut settings = Self {
			enabled:   SV_BROWSER_ENABLED.get(ctx),
			headless:  SV_BROWSER_HEADLESS.get(ctx),
			cdp_url:   SV_BROWSER_CDP_URL.get(ctx),
			relay:     SV_BROWSER_RELAY.get(ctx),
			relay_url: SV_BROWSER_RELAY_URL.get(ctx),
		};
		let environment = std::env::var("OMP_BROWSER_RELAY").ok();
		let resolved = resolve_relay(&settings, environment.as_deref());
		settings.relay = resolved.is_some();
		if let Some(endpoint) = resolved {
			settings.relay_url = endpoint;
		}
		settings
	}
}

/// Resolves relay enablement and its normalized endpoint.
///
/// An exact `0` or `1` environment value is the final override in either
/// direction. Other values defer to the typed setting.
#[must_use]
pub fn resolve_relay(settings: &BrowserSettings, env_override: Option<&str>) -> Option<Str> {
	let enabled = match env_override.map(str::trim) {
		Some("0") => false,
		Some("1") => true,
		_ => settings.relay,
	};
	enabled.then(|| normalize_relay_url(&settings.relay_url))
}

fn normalize_relay_url(configured: &str) -> Str {
	let configured = configured.trim().trim_end_matches('/');
	if configured.is_empty() {
		Str::new_static(DEFAULT_RELAY_URL)
	} else {
		Str::new(configured)
	}
}

impl Default for BrowserSettings {
	fn default() -> Self {
		Self {
			enabled:   true,
			headless:  true,
			cdp_url:   Str::default(),
			relay:     false,
			relay_url: Str::default(),
		}
	}
}

#[cfg(test)]
mod settings_tests {
	use super::*;

	#[test]
	fn browser_settings_project_from_con() {
		let ctx = Ctx::new();
		SV_BROWSER_ENABLED.set(&ctx, false).expect("set enabled");
		SV_BROWSER_HEADLESS.set(&ctx, false).expect("set headless");
		SV_BROWSER_CDP_URL
			.set(&ctx, sf!("http://127.0.0.1:9333"))
			.expect("set cdp");
		SV_BROWSER_RELAY.set(&ctx, true).expect("set relay");
		SV_BROWSER_RELAY_URL
			.set(&ctx, sf!("http://127.0.0.1:9444"))
			.expect("set relay url");
		assert_eq!(BrowserSettings::from_con(&ctx), BrowserSettings {
			enabled:   false,
			headless:  false,
			cdp_url:   sf!("http://127.0.0.1:9333"),
			relay:     true,
			relay_url: sf!("http://127.0.0.1:9444"),
		});
	}

	#[test]
	fn relay_kind_resolution_honors_both_override_directions() {
		let disabled = BrowserSettings::default();
		assert_eq!(resolve_relay(&disabled, None), None);
		assert_eq!(resolve_relay(&disabled, Some("1")), Some(Str::new_static(DEFAULT_RELAY_URL)));

		let enabled = BrowserSettings {
			relay: true,
			relay_url: sf!("http://127.0.0.1:9333///"),
			..BrowserSettings::default()
		};
		assert_eq!(resolve_relay(&enabled, Some("0")), None);
		assert_eq!(resolve_relay(&enabled, None), Some(sf!("http://127.0.0.1:9333")));
		assert_eq!(
			resolve_relay(&BrowserSettings { relay_url: sf!("  "), ..enabled }, None),
			Some(Str::new_static(DEFAULT_RELAY_URL))
		);
	}
}

enum Request {
	Execute {
		owner:        Str,
		params:       Params,
		cancellation: CancellationToken,
		updates:      flume::Sender<Update>,
		reply:        flume::Sender<Result<Payload, Fault>>,
	},
	ReleaseOwner {
		owner: Str,
	},
	Restart {
		headless: bool,
		reply:    flume::Sender<Result<(), Fault>>,
	},
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TabKey {
	owner: Str,
	name:  Str,
}

struct TabSession {
	view:    WebView,
	backend: Str,
}

/// Process-local browser supervisor. One actor owns every webview handle and
/// tears the complete tab set down when its request channel closes.
pub(crate) struct BrowserDaemon {
	requests: flume::Sender<Request>,
}

impl BrowserDaemon {
	/// Starts one daemon actor with content-addressed artifact storage and its
	/// initial typed backend settings.
	pub(crate) fn start(blobs: BlobHost, settings: BrowserSettings) -> Arc<Self> {
		let (requests, receiver) = flume::unbounded::<Request>();
		thread::Builder::new()
			.name("omp-browser-daemon".to_owned())
			.spawn(move || run(receiver, blobs, settings))
			.expect("browser daemon actor starts");
		Arc::new(Self { requests })
	}
}

#[async_trait]
impl BrowserHost for BrowserDaemon {
	#[tracing::instrument(
		name = "browser_request",
		level = "debug",
		skip_all,
		fields(action = ?params.action, tab = ?params.name),
	)]
	async fn execute(
		&self,
		owner: Str,
		params: Params,
		cancellation: CancellationToken,
		updates: flume::Sender<Update>,
	) -> Result<Payload, Fault> {
		let (reply, response) = flume::bounded(1);
		self
			.requests
			.send_async(Request::Execute { owner, params, cancellation, updates, reply })
			.await
			.map_err(|_| daemon_closed())?;
		response.recv_async().await.map_err(|_| daemon_closed())?
	}

	fn release_owner(&self, owner: &str) {
		let _ = self
			.requests
			.send(Request::ReleaseOwner { owner: owner.to_str() });
	}

	async fn restart_for_mode_change(&self, headless: bool) -> Result<(), Fault> {
		let (reply, response) = flume::bounded(1);
		self
			.requests
			.send_async(Request::Restart { headless, reply })
			.await
			.map_err(|_| daemon_closed())?;
		response.recv_async().await.map_err(|_| daemon_closed())?
	}
}

fn run(receiver: Receiver<Request>, blobs: BlobHost, mut settings: BrowserSettings) {
	tracing::info!(headless = settings.headless, "browser daemon started");
	let mut tabs = HashMap::<TabKey, TabSession>::new();
	let mut released_spawned = Vec::<TabSession>::new();
	let mut relay = None::<Arc<RelayLease>>;
	while let Ok(request) = receiver.recv() {
		match request {
			Request::Execute { owner, params, cancellation, updates, reply } => {
				let result = execute(
					&mut tabs,
					&blobs,
					&settings,
					&mut relay,
					&mut released_spawned,
					owner,
					params,
					&cancellation,
					&updates,
				);
				let _ = reply.send(result);
			},
			Request::ReleaseOwner { owner } => {
				tabs.retain(|key, _| key.owner != owner);
			},
			Request::Restart { headless, reply } => {
				let tabs_closed = tabs.len();
				tabs.clear();
				settings.headless = headless;
				tracing::info!(headless, tabs_closed, "browser daemon restarted for mode change");
				let _ = reply.send(Ok(()));
			},
		}
	}
	tracing::info!(tabs_closed = tabs.len(), "browser daemon stopped");
}

fn execute(
	tabs: &mut HashMap<TabKey, TabSession>,
	blobs: &BlobHost,
	settings: &BrowserSettings,
	relay: &mut Option<Arc<RelayLease>>,
	released_spawned: &mut Vec<TabSession>,
	owner: Str,
	params: Params,
	cancellation: &CancellationToken,
	updates: &flume::Sender<Update>,
) -> Result<Payload, Fault> {
	if cancellation.is_cancelled() {
		return Err(cancelled("browser request"));
	}
	validate(&params)?;
	let name = params.name.clone().unwrap_or_else(|| sf!("main"));
	let key = TabKey { owner, name: name.clone() };
	match params.action {
		Action::Open => open(tabs, key, settings, relay, params, cancellation, updates),
		Action::Close => close(tabs, released_spawned, key, params, settings),
		Action::Run => run_tab(tabs, &key, blobs, params, cancellation, updates),
	}
}

fn open(
	tabs: &mut HashMap<TabKey, TabSession>,
	key: TabKey,
	settings: &BrowserSettings,
	relay: &mut Option<Arc<RelayLease>>,
	params: Params,
	cancellation: &CancellationToken,
	updates: &flume::Sender<Update>,
) -> Result<Payload, Fault> {
	let (engine, surface, backend) = resolve_backend(settings, &params)?;
	if backend == "relay" {
		let endpoint = normalize_relay_url(&settings.relay_url);
		ensure_relay(&endpoint, relay, cancellation)?;
	}
	let deadline = Instant::now() + timeout(&params);
	let _ = updates.send(Update::Started {
		name:    key.name.clone(),
		action:  Action::Open,
		browser: backend.clone(),
	});
	let mut builder = WebViewBuilder::new(engine)
		.incognito(true)
		.viewport_explicit(params.viewport.is_some())
		.connect_timeout(deadline.saturating_duration_since(Instant::now()));
	if let Some(url) = params.url.as_ref() {
		builder = builder.url(url.clone());
	}
	if let Some(args) = params.app.as_ref().and_then(|app| app.args.as_ref()) {
		builder = builder.arguments(args.iter().cloned());
	}
	let width = params
		.viewport
		.map_or(1280, |viewport| viewport.width)
		.clamp(320, 4096);
	let height = params
		.viewport
		.map_or(800, |viewport| viewport.height)
		.clamp(240, 4096);
	let view = match surface {
		SurfaceKind::Frames => builder.build_frames(FrameConfig {
			width,
			height,
			scale: params
				.viewport
				.and_then(|viewport| viewport.scale)
				.unwrap_or(1.0)
				.clamp(0.5, 4.0),
			..FrameConfig::default()
		}),
		SurfaceKind::Window => builder.build_window(WindowConfig { width, height }),
		SurfaceKind::Child => unreachable!("browser tool never creates child surfaces"),
	}
	.map_err(|error| browser_fault("open", error))?;
	let open_watch =
		SurfaceWatch::start(&view, cancellation.clone(), Some(deadline), Duration::ZERO);
	if cancellation.is_cancelled() {
		drop(view);
		return Err(cancelled("opening browser tab"));
	}
	if Instant::now() >= deadline {
		drop(view);
		return Err(timed_out("opening browser tab"));
	}
	wait_for_navigation(
		&view,
		params.wait_until,
		deadline.saturating_duration_since(Instant::now()),
	)
	.map_err(|fault| tab_fault(fault, &key.name, &view, &backend))?;
	let url = view.url();
	let title = view.title();
	drop(open_watch);
	tabs.insert(key.clone(), TabSession { view, backend: backend.clone() });
	Ok(Payload {
		action:    Action::Open,
		name:      key.name,
		url:       Some(url),
		title:     Some(title),
		display:   Vec::new(),
		result:    None,
		artifacts: Vec::new(),
		browser:   Some(backend),
	})
}

fn close(
	tabs: &mut HashMap<TabKey, TabSession>,
	released_spawned: &mut Vec<TabSession>,
	key: TabKey,
	params: Params,
	settings: &BrowserSettings,
) -> Result<Payload, Fault> {
	let backend = if params.all {
		if params.kill {
			released_spawned.clear();
		}
		let owned = tabs
			.keys()
			.filter(|candidate| candidate.owner == key.owner)
			.cloned()
			.collect::<Vec<_>>();
		let mut removed = Vec::with_capacity(owned.len());
		for candidate in owned {
			if let Some(session) = tabs.remove(&candidate) {
				removed.push(session.backend.clone());
				if session.backend == "spawned" && !params.kill {
					released_spawned.push(session);
				}
			}
		}
		removed.sort();
		removed.dedup();
		match removed.as_slice() {
			[] => mode_name(settings.headless),
			[backend] => backend.clone(),
			_ => sf!("mixed"),
		}
	} else {
		let session = tabs.remove(&key).ok_or_else(|| not_found(&key.name))?;
		let backend = session.backend.clone();
		if backend == "spawned" && !params.kill {
			released_spawned.push(session);
		}
		backend
	};
	let remaining = tabs
		.keys()
		.filter(|candidate| candidate.owner == key.owner)
		.count();
	Ok(Payload {
		action:    Action::Close,
		name:      key.name,
		url:       None,
		title:     None,
		display:   Vec::new(),
		result:    Some(json!({ "remaining_tabs": remaining, "kill_requested": params.kill })),
		artifacts: Vec::new(),
		browser:   Some(backend),
	})
}

struct SpawnedRelay {
	child:     Child,
	bootstrap: Option<ChildStdin>,
	stderr:    Arc<Mutex<Vec<u8>>>,
	reader:    Option<thread::JoinHandle<()>>,
}

impl SpawnedRelay {
	fn start(endpoint: &RelayEndpoint) -> Result<Self, Fault> {
		let executable = std::env::current_exe()
			.map_err(|error| relay_fault_owned(sf!("could not locate the omp executable: {error}")))?;
		let bind = endpoint
			.auto_bind
			.expect("managed relay spawn is restricted to loopback");
		let mut arguments = vec![
			"browser-relay".to_owned(),
			"serve".to_owned(),
			"--managed".to_owned(),
			"--bind".to_owned(),
			bind.to_string(),
			"--port".to_owned(),
			endpoint.port.to_string(),
		];
		if let Some(token) = &endpoint.token {
			arguments.extend(["--token".to_owned(), token.clone()]);
		}
		let mut command = Command::new(executable);
		command
			.args(arguments)
			.stdin(Stdio::piped())
			.stdout(Stdio::null())
			.stderr(Stdio::piped());
		#[cfg(unix)]
		{
			use std::os::unix::process::CommandExt as _;
			command.process_group(0);
		}
		let child = command
			.spawn()
			.map_err(|error| relay_fault_owned(sf!("browser relay failed to start: {error}")))?;
		Self::observe(child)
	}

	fn observe(mut child: Child) -> Result<Self, Fault> {
		let bootstrap = child.stdin.take();
		let stderr = child
			.stderr
			.take()
			.ok_or_else(|| relay_fault("browser relay stderr was not captured"))?;
		let captured = Arc::new(Mutex::new(Vec::new()));
		let reader_capture = Arc::clone(&captured);
		let reader = thread::Builder::new()
			.name("omp-relay-stderr".to_owned())
			.spawn(move || capture_relay_stderr(stderr, &reader_capture))
			.map_err(|error| relay_fault_owned(sf!("could not observe browser relay: {error}")))?;
		Ok(Self { child, bootstrap, stderr: captured, reader: Some(reader) })
	}

	fn release_bootstrap(&mut self) {
		self.bootstrap = None;
	}

	fn poll_exit(&mut self) -> Result<Option<ExitStatus>, Fault> {
		self
			.child
			.try_wait()
			.map_err(|error| relay_fault_owned(sf!("could not observe browser relay: {error}")))
	}

	fn exit_fault(&mut self, status: ExitStatus) -> Fault {
		if let Some(reader) = self.reader.take() {
			let _ = reader.join();
		}
		let stderr = String::from_utf8_lossy(&self.stderr.lock())
			.trim()
			.to_owned();
		if stderr.is_empty() {
			relay_fault_owned(sf!("browser relay exited during startup ({status})"))
		} else {
			relay_fault_owned(sf!(
				"browser relay exited during startup ({status}): {}",
				redact(&stderr)
			))
		}
	}
}

fn capture_relay_stderr(mut stderr: ChildStderr, captured: &Mutex<Vec<u8>>) {
	let mut buffer = [0_u8; 4096];
	while let Ok(count) = stderr.read(&mut buffer) {
		if count == 0 {
			break;
		}
		let mut captured = captured.lock();
		let available = MAX_RELAY_STDERR_BYTES.saturating_sub(captured.len());
		captured.extend_from_slice(&buffer[..count.min(available)]);
	}
}

fn ensure_relay(
	endpoint: &str,
	relay: &mut Option<Arc<RelayLease>>,
	cancellation: &CancellationToken,
) -> Result<(), Fault> {
	let endpoint =
		parse_relay_endpoint(endpoint).ok_or_else(|| invalid("browser relay URL is invalid"))?;
	let cache_key = relay_cache_key(&endpoint);
	if let Some(existing) = RELAYS.lock().get(&cache_key).and_then(Weak::upgrade) {
		*relay = Some(existing);
		let result = wait_for_relay(&endpoint, cancellation, None);
		if result.is_err() {
			*relay = None;
			RELAYS.lock().remove(&cache_key);
		}
		return result;
	}
	RELAYS.lock().remove(&cache_key);

	if let Some(acquired) = try_acquire_relay(&endpoint) {
		return hold_relay_lease(&endpoint, relay, acquired, cancellation, None);
	}
	let serving = endpoint.addresses.iter().any(|address| {
		probe_relay_serving_address_with_timeout(
			*address,
			&endpoint.host,
			endpoint.port,
			&endpoint.base_path,
			RELAY_PROBE_TIMEOUT,
		)
	});
	if endpoint.auto_bind.is_none() {
		return wait_for_relay(&endpoint, cancellation, None);
	}
	if serving {
		if let Some(acquired) = wait_for_relay_lease(
			&endpoint,
			cancellation,
			Instant::now() + RELAY_ADOPTION_TIMEOUT,
		)? {
			return hold_relay_lease(&endpoint, relay, acquired, cancellation, None);
		}
		return Err(relay_fault(
			"the loopback relay does not expose the required machine-global lease channel",
		));
	}

	let mut spawned = SpawnedRelay::start(&endpoint)?;
	let startup_deadline = Instant::now() + RELAY_START_TIMEOUT;
	loop {
		if cancellation.is_cancelled() {
			return Err(cancelled("starting browser relay"));
		}
		if let Some(acquired) = try_acquire_relay(&endpoint) {
			spawned.release_bootstrap();
			return hold_relay_lease(
				&endpoint,
				relay,
				acquired,
				cancellation,
				Some(&mut spawned),
			);
		}
		if let Some(status) = spawned.poll_exit()? {
			// A concurrent launcher may have won the bind after our last
			// attempt. Adopt its lease before surfacing this child's failure.
			if let Some(acquired) = try_acquire_relay(&endpoint) {
				return hold_relay_lease(&endpoint, relay, acquired, cancellation, None);
			}
			if endpoint.addresses.iter().any(|address| {
				probe_relay_serving_address_with_timeout(
					*address,
					&endpoint.host,
					endpoint.port,
					&endpoint.base_path,
					RELAY_PROBE_TIMEOUT,
				)
			}) {
				if let Some(acquired) = wait_for_relay_lease(
					&endpoint,
					cancellation,
					Instant::now() + RELAY_ADOPTION_TIMEOUT,
				)? {
					return hold_relay_lease(&endpoint, relay, acquired, cancellation, None);
				}
				return Err(relay_fault(
					"a concurrent loopback relay won the port but did not expose a managed lease",
				));
			}
			return Err(spawned.exit_fault(status));
		}
		if Instant::now() >= startup_deadline {
			return Err(relay_fault("browser relay did not open its lease channel"));
		}
		thread::sleep(Duration::from_millis(100));
	}
}

fn hold_relay_lease(
	endpoint: &RelayEndpoint,
	relay: &mut Option<Arc<RelayLease>>,
	acquired: RelayLease,
	cancellation: &CancellationToken,
	spawned: Option<&mut SpawnedRelay>,
) -> Result<(), Fault> {
	let acquired = Arc::new(acquired);
	let key = relay_cache_key(endpoint);
	RELAYS.lock().insert(key.clone(), Arc::downgrade(&acquired));
	*relay = Some(acquired);
	let result = wait_for_relay(endpoint, cancellation, spawned);
	if result.is_err() {
		*relay = None;
		RELAYS.lock().remove(&key);
	}
	result
}

fn relay_cache_key(endpoint: &RelayEndpoint) -> Str {
	sf!("{}:{}{}", endpoint.host, endpoint.port, endpoint.base_path)
}

fn try_acquire_relay(endpoint: &RelayEndpoint) -> Option<RelayLease> {
	endpoint.addresses.iter().find_map(|address| {
		acquire_relay_lease_address(
			*address,
			&endpoint.host,
			endpoint.port,
			&endpoint.base_path,
			RELAY_PROBE_TIMEOUT,
		)
	})
}

fn wait_for_relay_lease(
	endpoint: &RelayEndpoint,
	cancellation: &CancellationToken,
	deadline: Instant,
) -> Result<Option<RelayLease>, Fault> {
	loop {
		if cancellation.is_cancelled() {
			return Err(cancelled("starting browser relay"));
		}
		if let Some(lease) = try_acquire_relay(endpoint) {
			return Ok(Some(lease));
		}
		if Instant::now() >= deadline {
			return Ok(None);
		}
		thread::sleep(Duration::from_millis(50));
	}
}

fn wait_for_relay(
	endpoint: &RelayEndpoint,
	cancellation: &CancellationToken,
	mut spawned: Option<&mut SpawnedRelay>,
) -> Result<(), Fault> {
	let deadline = Instant::now() + RELAY_EXTENSION_TIMEOUT;
	let mut serving = false;
	loop {
		if cancellation.is_cancelled() {
			return Err(cancelled("starting browser relay"));
		}
		if endpoint.addresses.iter().any(|address| {
			probe_relay_ready_address_with_timeout(
				*address,
				&endpoint.host,
				endpoint.port,
				&endpoint.base_path,
				RELAY_PROBE_TIMEOUT,
			)
		}) {
			return Ok(());
		}
		if !serving {
			serving = endpoint.addresses.iter().any(|address| {
				probe_relay_serving_address_with_timeout(
					*address,
					&endpoint.host,
					endpoint.port,
					&endpoint.base_path,
					RELAY_PROBE_TIMEOUT,
				)
			});
		}
		if let Some(child) = spawned.as_deref_mut()
			&& let Some(status) = child.poll_exit()?
		{
			if endpoint.addresses.iter().any(|address| {
				probe_relay_ready_address_with_timeout(
					*address,
					&endpoint.host,
					endpoint.port,
					&endpoint.base_path,
					RELAY_PROBE_TIMEOUT,
				)
			}) {
				return Ok(());
			}
			return Err(child.exit_fault(status));
		}
		if Instant::now() >= deadline {
			return Err(if serving {
				relay_fault(
					"browser relay is serving but its extension did not connect within 35 seconds",
				)
			} else {
				relay_fault("browser relay endpoint was not reachable within 35 seconds")
			});
		}
		thread::sleep(Duration::from_millis(100));
	}
}

fn run_tab(
	tabs: &mut HashMap<TabKey, TabSession>,
	key: &TabKey,
	blobs: &BlobHost,
	params: Params,
	cancellation: &CancellationToken,
	updates: &flume::Sender<Update>,
) -> Result<Payload, Fault> {
	let result = {
		let session = tabs.get(key).ok_or_else(|| not_found(&key.name))?;
		let _ = updates.send(Update::Started {
			name:    key.name.clone(),
			action:  Action::Run,
			browser: session.backend.clone(),
		});
		if let Some(url) = params.url.as_ref() {
			session
				.view
				.automation()
				.goto(url, timeout(&params))
				.map_err(|error| {
					tab_fault(browser_fault("goto", error), &key.name, &session.view, &session.backend)
				})?;
			wait_for_condition(&session.view, params.wait_until, timeout(&params))
				.map_err(|fault| tab_fault(fault, &key.name, &session.view, &session.backend))?;
		}
		install_dialog_policy(&session.view, params.dialogs)?;
		let code = required(params.code.as_deref(), "run requires `code`")?;
		let result =
			run_code(session, blobs, &key.name, code, timeout(&params), cancellation, updates);
		cleanup_interception(&session.view);
		match result {
			Ok((display, result, artifacts)) => Ok(Payload {
				action: Action::Run,
				name: key.name.clone(),
				url: Some(session.view.url()),
				title: Some(session.view.title()),
				display,
				result,
				artifacts,
				browser: Some(session.backend.clone()),
			}),
			Err(mut fault) => {
				fault.name = Some(key.name.clone());
				fault.url = Some(redact_url(&session.view.url()));
				fault.title = Some(session.view.title());
				fault.browser = Some(session.backend.clone());
				Err(fault)
			},
		}
	};
	if result
		.as_ref()
		.is_err_and(|fault| fault.code == "browser_cancelled")
	{
		tabs.remove(key);
	}
	result
}

fn resolve_backend(
	settings: &BrowserSettings,
	params: &Params,
) -> Result<(Engine, SurfaceKind, Str), Fault> {
	let app = params.app.as_ref();
	if let Some(endpoint) = app.and_then(|value| value.cdp_url.as_ref()) {
		return Ok((
			Engine::chromium_cdp(endpoint.clone(), app.and_then(|value| value.target.clone())),
			SurfaceKind::Frames,
			sf!("cdp"),
		));
	}
	let explicit_relay = app.and_then(|value| value.relay);
	if explicit_relay == Some(true) || (explicit_relay != Some(false) && settings.relay) {
		let endpoint = normalize_relay_url(&settings.relay_url);
		return Ok((
			Engine::chromium_relay(endpoint, app.and_then(|value| value.target.clone())),
			SurfaceKind::Frames,
			sf!("relay"),
		));
	}
	if let Some(path) = app.and_then(|value| value.path.as_ref()) {
		return Ok((Engine::chromium(PathBuf::from(&**path)), SurfaceKind::Window, sf!("spawned")));
	}
	if !settings.cdp_url.trim().is_empty() {
		return Ok((
			Engine::chromium_cdp(settings.cdp_url.clone(), app.and_then(|value| value.target.clone())),
			SurfaceKind::Frames,
			sf!("cdp"),
		));
	}
	let surface = if settings.headless {
		SurfaceKind::Frames
	} else {
		SurfaceKind::Window
	};
	let engine = Engine::find(surface).map_err(|error| browser_fault("discover", error))?;
	Ok((engine, surface, mode_name(settings.headless)))
}

fn run_code(
	session: &TabSession,
	blobs: &BlobHost,
	name: &str,
	code: &str,
	budget: Duration,
	cancellation: &CancellationToken,
	updates: &flume::Sender<Update>,
) -> Result<(Vec<Value>, Option<Value>, Vec<Artifact>), Fault> {
	let deadline = Instant::now() + budget;
	let _target_watch =
		SurfaceWatch::start(&session.view, cancellation.clone(), None, Duration::from_millis(500));
	let engine =
		Engine::find(SurfaceKind::Frames).map_err(|error| browser_fault("runtime", error))?;
	let runtime = WebViewBuilder::new(engine)
		.html("<!doctype html><meta charset=utf-8><title>omp browser run</title>")
		.incognito(true)
		.connect_timeout(deadline.saturating_duration_since(Instant::now()))
		.build_frames(FrameConfig { width: 320, height: 240, ..FrameConfig::default() })
		.map_err(|error| browser_fault("runtime", error))?;
	let _runtime_watch =
		SurfaceWatch::start(&runtime, cancellation.clone(), Some(deadline), Duration::ZERO);
	runtime
		.automation()
		.wait_for_navigation(deadline.saturating_duration_since(Instant::now()))
		.map_err(|error| browser_fault("runtime", error))?;
	runtime
		.automation()
		.evaluate(RUN_RUNTIME, deadline.saturating_duration_since(Instant::now()))
		.map_err(|error| browser_fault("runtime", error))?;
	let code =
		serde_json::to_string(code).map_err(|_| invalid("browser code is not serializable"))?;
	let name_json =
		serde_json::to_string(name).map_err(|_| invalid("tab name is not serializable"))?;
	let url_json = serde_json::to_string(session.view.url().as_str())
		.map_err(|_| invalid("tab URL is not serializable"))?;
	runtime
		.automation()
		.evaluate(
			&format!("globalThis.__ompStart({code},{name_json},{url_json})"),
			deadline.saturating_duration_since(Instant::now()),
		)
		.map_err(|error| browser_fault("runtime", error))?;

	let mut artifacts = Vec::new();
	let mut activity = 0_u64;
	let mut pending = Vec::<PendingCall>::new();
	loop {
		if cancellation.is_cancelled() {
			drop(runtime);
			return Err(cancelled("browser code execution"));
		}
		if Instant::now() >= deadline {
			drop(runtime);
			return Err(timed_out("browser code execution"));
		}
		let requests = runtime
			.automation()
			.evaluate("globalThis.__ompTake()", Duration::from_secs(1))
			.map_err(|error| browser_fault("runtime", error))?;
		for request in requests.as_array().into_iter().flatten() {
			let id = request
				.get("id")
				.and_then(Value::as_u64)
				.ok_or_else(|| invalid("runtime request omitted id"))?;
			let op = request
				.get("op")
				.and_then(Value::as_str)
				.ok_or_else(|| invalid("runtime request omitted op"))?;
			let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
			let _ = updates.send(Update::Helper { operation: sf!("tab.{op}") });
			match dispatch_helper(&session.view, blobs, op, &args, deadline, activity, &mut artifacts)?
			{
				HelperReply::Ready(value) => reply_runtime(&runtime, id, Ok(value))?,
				HelperReply::Pending(kind) => pending.push(PendingCall { id, kind }),
			}
			if mutates_page(op) {
				activity = activity.saturating_add(1);
			}
		}
		for index in (0..pending.len()).rev() {
			let ready = match &pending[index].kind {
				PendingKind::Navigation { url, activity: observed } => {
					if activity > *observed || session.view.url() != *url {
						wait_for_navigation(
							&session.view,
							None,
							deadline.saturating_duration_since(Instant::now()),
						)?;
						Some(json!(session.view.url()))
					} else {
						None
					}
				},
				PendingKind::Response { pattern } => session
					.view
					.automation()
					.wait_for_response(pattern, Duration::from_millis(1))
					.ok()
					.map(|url| json!(url)),
			};
			if let Some(value) = ready {
				let call = pending.swap_remove(index);
				reply_runtime(&runtime, call.id, Ok(value))?;
			}
		}
		let state = runtime
			.automation()
			.evaluate("globalThis.__ompState", Duration::from_secs(1))
			.map_err(|error| browser_fault("runtime", error))?;
		match state.get("status").and_then(Value::as_str) {
			Some("done") if pending.is_empty() && requests.as_array().is_none_or(Vec::is_empty) => {
				let display = state
					.get("display")
					.and_then(Value::as_array)
					.cloned()
					.unwrap_or_default();
				let result = state
					.get("result")
					.cloned()
					.filter(|value| !value.is_null());
				for artifact in &artifacts {
					let _ = updates.send(Update::Artifact {
						uri:  artifact.uri.clone(),
						mime: artifact.mime.clone(),
					});
				}
				return Ok((display, result, artifacts));
			},
			Some("error") => {
				let message = state
					.get("error")
					.and_then(Value::as_str)
					.unwrap_or("browser code failed");
				return Err(code_fault(message));
			},
			_ => thread::sleep(POLL),
		}
	}
}

struct SurfaceWatch {
	stopped: Arc<AtomicBool>,
	thread:  Option<thread::JoinHandle<()>>,
}

impl SurfaceWatch {
	fn start(
		view: &WebView,
		cancellation: CancellationToken,
		deadline: Option<Instant>,
		grace: Duration,
	) -> Self {
		let stopped = Arc::new(AtomicBool::new(false));
		let thread = view.close_handle().map(|close| {
			let watch_stopped = Arc::clone(&stopped);
			thread::spawn(move || {
				while !watch_stopped.load(Ordering::Acquire) {
					if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
						let _ = close.close();
						return;
					}
					if cancellation.is_cancelled() {
						let grace_deadline = Instant::now() + grace;
						while Instant::now() < grace_deadline {
							if watch_stopped.load(Ordering::Acquire) {
								return;
							}
							thread::sleep(POLL);
						}
						let _ = close.close();
						return;
					}
					thread::sleep(POLL);
				}
			})
		});
		Self { stopped, thread }
	}
}

impl Drop for SurfaceWatch {
	fn drop(&mut self) {
		self.stopped.store(true, Ordering::Release);
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

struct PendingCall {
	id:   u64,
	kind: PendingKind,
}

enum PendingKind {
	Navigation { url: Str, activity: u64 },
	Response { pattern: Str },
}

enum HelperReply {
	Ready(Value),
	Pending(PendingKind),
}

fn dispatch_helper(
	view: &WebView,
	blobs: &BlobHost,
	op: &str,
	args: &Value,
	deadline: Instant,
	activity: u64,
	artifacts: &mut Vec<Artifact>,
) -> Result<HelperReply, Fault> {
	let values = args
		.as_array()
		.ok_or_else(|| invalid("browser helper args must be an array"))?;
	let remaining = deadline
		.saturating_duration_since(Instant::now())
		.max(Duration::from_millis(1));
	let tab = view.automation();
	let document = tab.document();
	let ready = match op {
		"url" => json!(view.url()),
		"title" => json!(view.title()),
		"goto" => {
			tab.goto(arg_str(values, 0, "goto requires a URL")?, remaining)
				.map_err(|error| browser_fault("tab.goto", error))?;
			let wait_until = values
				.get(1)
				.and_then(Value::as_object)
				.and_then(|options| options.get("waitUntil"))
				.and_then(Value::as_str)
				.map(parse_wait_until)
				.transpose()?;
			wait_for_condition(view, wait_until, remaining)?;
			json!(view.url())
		},
		"observe" => {
			let options = values.first().and_then(Value::as_object);
			let observation = document
				.observe(ObserveOptions {
					include_all:   options
						.and_then(|value| value.get("includeAll"))
						.and_then(Value::as_bool)
						.unwrap_or(false),
					viewport_only: options
						.and_then(|value| value.get("viewportOnly"))
						.and_then(Value::as_bool)
						.unwrap_or(true),
					limit:         500,
				})
				.map_err(|error| browser_fault("tab.observe", error))?;
			json!({
				"url": observation.url,
				"title": observation.title,
				"text": observation.text,
				"elements": observation.elements.into_iter().map(|element| json!({
					"id": element.id,
					"ref": element.reference,
					"role": element.role,
					"name": element.name,
					"value": element.value,
					"bounds": element.bounds,
					"visible": element.visible,
				})).collect::<Vec<_>>(),
				"truncated": observation.truncated,
			})
		},
		"ariaSnapshot" => {
			let selector = values
				.first()
				.and_then(Value::as_str)
				.map(Selector::parse)
				.transpose()
				.map_err(|error| browser_fault("tab.ariaSnapshot", error))?;
			json!(
				document
					.aria_snapshot(selector)
					.map_err(|error| browser_fault("tab.ariaSnapshot", error))?
			)
		},
		"screenshot" => {
			let options = values.first().and_then(Value::as_object);
			let selector = options
				.and_then(|value| value.get("selector"))
				.and_then(Value::as_str)
				.map(Selector::parse)
				.transpose()
				.map_err(|error| browser_fault("tab.screenshot", error))?;
			let full_page = options
				.and_then(|value| value.get("fullPage"))
				.and_then(Value::as_bool)
				.unwrap_or(false);
			let screenshot = tab
				.screenshot(selector, full_page, remaining)
				.map_err(|error| browser_fault("tab.screenshot", error))?;
			let uri = store_artifact(blobs, &screenshot.data)?;
			artifacts.push(Artifact {
				uri:      uri.clone(),
				mime:     sf!("image/png"),
				kind:     sf!("screenshot"),
				visible:  !options
					.and_then(|value| value.get("silent"))
					.and_then(Value::as_bool)
					.unwrap_or(false),
				byte_len: u64::try_from(screenshot.data.len()).unwrap_or(u64::MAX),
			});
			json!(uri)
		},
		"extract" => {
			let format = values.first().and_then(Value::as_str).unwrap_or("text");
			let extracted = tab
				.extract(if format == "text" {
					ExtractFormat::Text
				} else {
					ExtractFormat::Html
				})
				.map_err(|error| browser_fault("tab.extract", error))?;
			if format == "markdown" {
				let converted = omp_tools::read::web::html_to_markdown(&extracted)
					.map_err(|_| invalid("readable Markdown extraction failed"))?;
				json!(converted)
			} else {
				json!(extracted)
			}
		},
		"click" => {
			document
				.resolve(selector(values, 0)?)
				.map_err(|error| browser_fault("tab.click", error))?
				.click()
				.map_err(|error| browser_fault("tab.click", error))?;
			Value::Null
		},
		"type" => {
			document
				.resolve(selector(values, 0)?)
				.map_err(|error| browser_fault("tab.type", error))?
				.type_text(arg_str(values, 1, "type requires text")?)
				.map_err(|error| browser_fault("tab.type", error))?;
			Value::Null
		},
		"fill" => {
			document
				.resolve(selector(values, 0)?)
				.map_err(|error| browser_fault("tab.fill", error))?
				.fill(arg_str(values, 1, "fill requires a value")?)
				.map_err(|error| browser_fault("tab.fill", error))?;
			Value::Null
		},
		"press" => {
			let key = arg_str(values, 0, "press requires a key")?;
			if let Some(selector) = values.get(1).and_then(Value::as_str) {
				document
					.resolve(
						Selector::parse(selector).map_err(|error| browser_fault("tab.press", error))?,
					)
					.map_err(|error| browser_fault("tab.press", error))?
					.press(key)
					.map_err(|error| browser_fault("tab.press", error))?;
			} else {
				let key =
					serde_json::to_string(key).map_err(|_| invalid("press key is not serializable"))?;
				tab.evaluate(
					&format!(
						"(()=>{{const el=document.activeElement||document.body;el.dispatchEvent(new \
						 KeyboardEvent('keydown',{{key:{key},bubbles:true}}));el.dispatchEvent(new \
						 KeyboardEvent('keyup',{{key:{key},bubbles:true}}));return true}})()"
					),
					remaining,
				)
				.map_err(|error| browser_fault("tab.press", error))?;
			}
			Value::Null
		},
		"scroll" => {
			let dx = values.first().and_then(Value::as_f64).unwrap_or(0.0);
			let dy = values.get(1).and_then(Value::as_f64).unwrap_or(0.0);
			tab.evaluate(&format!("(()=>{{window.scrollBy({dx},{dy});return true}})()"), remaining)
				.map_err(|error| browser_fault("tab.scroll", error))?;
			Value::Null
		},
		"scrollIntoView" => {
			document
				.resolve(selector(values, 0)?)
				.map_err(|error| browser_fault("tab.scrollIntoView", error))?
				.scroll_into_view()
				.map_err(|error| browser_fault("tab.scrollIntoView", error))?;
			Value::Null
		},
		"drag" => {
			if values.first().is_some_and(Value::is_string)
				&& values.get(1).is_some_and(Value::is_string)
			{
				let from = document
					.resolve(selector(values, 0)?)
					.map_err(|error| browser_fault("tab.drag", error))?;
				let to = document
					.resolve(selector(values, 1)?)
					.map_err(|error| browser_fault("tab.drag", error))?;
				from
					.drag_to(&to)
					.map_err(|error| browser_fault("tab.drag", error))?;
			} else {
				let point = |value: &Value| -> Result<(f64, f64), Fault> {
					let object = value
						.as_object()
						.ok_or_else(|| invalid("drag points require x and y"))?;
					Ok((
						object
							.get("x")
							.and_then(Value::as_f64)
							.ok_or_else(|| invalid("drag point requires x"))?,
						object
							.get("y")
							.and_then(Value::as_f64)
							.ok_or_else(|| invalid("drag point requires y"))?,
					))
				};
				let (from_x, from_y) = point(
					values
						.first()
						.ok_or_else(|| invalid("drag requires a source"))?,
				)?;
				let (to_x, to_y) = point(
					values
						.get(1)
						.ok_or_else(|| invalid("drag requires a target"))?,
				)?;
				tab.evaluate(
					&format!(
						"(()=>{{const \
						 from=document.elementFromPoint({from_x},{from_y}),to=document.\
						 elementFromPoint({to_x},{to_y});if(!from||!to)throw new Error('drag point did \
						 not resolve');const data=new DataTransfer();from.dispatchEvent(new \
						 DragEvent('dragstart',{{bubbles:true,dataTransfer:data}}));to.\
						 dispatchEvent(new \
						 DragEvent('dragenter',{{bubbles:true,dataTransfer:data}}));to.\
						 dispatchEvent(new \
						 DragEvent('dragover',{{bubbles:true,dataTransfer:data}}));to.dispatchEvent(new \
						 DragEvent('drop',{{bubbles:true,dataTransfer:data}}));from.dispatchEvent(new \
						 DragEvent('dragend',{{bubbles:true,dataTransfer:data}}));return true}})()"
					),
					remaining,
				)
				.map_err(|error| browser_fault("tab.drag", error))?;
			}
			Value::Null
		},
		"select" => {
			let handle = document
				.resolve(selector(values, 0)?)
				.map_err(|error| browser_fault("tab.select", error))?;
			let selected = values
				.iter()
				.skip(1)
				.filter_map(Value::as_str)
				.map(Str::new)
				.collect::<Vec<_>>();
			handle
				.select(&selected)
				.map_err(|error| browser_fault("tab.select", error))?;
			json!(selected)
		},
		"uploadFile" => {
			let paths = values
				.iter()
				.skip(1)
				.filter_map(Value::as_str)
				.map(PathBuf::from)
				.collect::<Vec<_>>();
			tab.upload_files(selector(values, 0)?, &paths, remaining)
				.map_err(|error| browser_fault("tab.uploadFile", error))?;
			Value::Null
		},
		"evaluate" => {
			let source = arg_str(values, 0, "evaluate requires code")?;
			let call_args = values.get(1).cloned().unwrap_or_else(|| json!([]));
			let args_json = serde_json::to_string(&call_args)
				.map_err(|_| invalid("evaluate args are not serializable"))?;
			let script = if values.get(2).and_then(Value::as_bool).unwrap_or(false) {
				format!("(async()=>await ({source})(...{args_json}))()")
			} else {
				format!("(async()=>{{ {source} }})()")
			};
			tab.evaluate(&script, remaining)
				.map_err(|error| browser_fault("tab.evaluate", error))?
		},
		"waitFor" | "waitForSelector" => {
			let handle = document
				.wait_for_selector(selector(values, 0)?, remaining)
				.map_err(|error| browser_fault("tab.waitForSelector", error))?;
			json!({ "selector": values.first(), "metadata": {
				"id": handle.metadata().map_err(|error| browser_fault("tab.waitForSelector", error))?.id
			} })
		},
		"waitForUrl" => json!(
			tab.wait_for_url(arg_str(values, 0, "waitForUrl requires a pattern")?, remaining)
				.map_err(|error| browser_fault("tab.waitForUrl", error))?
		),
		"waitForResponse" => {
			return Ok(HelperReply::Pending(PendingKind::Response {
				pattern: arg_str(values, 0, "waitForResponse requires a pattern")?.to_str(),
			}));
		},
		"waitForNavigation" => {
			return Ok(HelperReply::Pending(PendingKind::Navigation { url: view.url(), activity }));
		},
		"download" => {
			let url = arg_str(values, 0, "download requires a URL")?;
			let encoded_url =
				serde_json::to_string(url).map_err(|_| invalid("download URL is not serializable"))?;
			let downloaded = tab.evaluate(&format!(r#"(async()=>{{const r=await fetch({encoded_url},{{credentials:'include'}});if(!r.ok)throw new Error(`download HTTP ${{r.status}}`);const b=new Uint8Array(await r.arrayBuffer());if(b.length>{MAX_DOWNLOAD_BYTES})throw new Error('download exceeds byte limit');let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return {{data:btoa(s),mime:r.headers.get('content-type')||'application/octet-stream'}};}})()"#), remaining).map_err(|error| browser_fault("tab.download", error))?;
			let data = downloaded
				.get("data")
				.and_then(Value::as_str)
				.ok_or_else(|| invalid("download returned no bytes"))?;
			let bytes = base64::decode(data.as_bytes())
				.into_vec()
				.map_err(|_| invalid("download returned invalid base64"))?;
			if bytes.len() > MAX_DOWNLOAD_BYTES {
				return Err(invalid("download exceeds byte limit"));
			}
			let uri = store_artifact(blobs, &bytes)?;
			let mime = downloaded
				.get("mime")
				.and_then(Value::as_str)
				.unwrap_or("application/octet-stream")
				.to_str();
			artifacts.push(Artifact {
				uri:      uri.clone(),
				mime:     mime.clone(),
				kind:     sf!("download"),
				visible:  true,
				byte_len: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
			});
			json!({ "artifact": uri, "mime": mime, "bytes": bytes.len() })
		},
		"setRequestInterception" => {
			set_interception(view, values.first().and_then(Value::as_bool).unwrap_or(false))?;
			Value::Null
		},
		"onRequest" => {
			install_request_handler(view, arg_str(values, 0, "request handler source is required")?)?;
			Value::Null
		},
		"clearRequestHandlers" => {
			clear_request_handlers(view)?;
			Value::Null
		},
		_ => {
			return Err(invalid_owned(
				sf!("unsupported browser helper `tab.{op}`"),
				Some(sf!("tab.{op}")),
			));
		},
	};
	Ok(HelperReply::Ready(ready))
}

fn reply_runtime(runtime: &WebView, id: u64, result: Result<Value, Fault>) -> Result<(), Fault> {
	let envelope = match result {
		Ok(value) => json!({ "ok": true, "value": value }),
		Err(fault) => json!({ "ok": false, "error": fault.message }),
	};
	let envelope =
		serde_json::to_string(&envelope).map_err(|_| invalid("runtime reply is not serializable"))?;
	runtime
		.automation()
		.evaluate(&format!("globalThis.__ompReply({id},{envelope})"), Duration::from_secs(1))
		.map(drop)
		.map_err(|error| browser_fault("runtime", error))
}

fn install_dialog_policy(
	view: &WebView,
	policy: Option<omp_tools::browser::Dialogs>,
) -> Result<(), Fault> {
	let Some(policy) = policy else {
		return Ok(());
	};
	let accept = matches!(policy, omp_tools::browser::Dialogs::Accept);
	let prompt = if accept { "''" } else { "null" };
	let script = format!(
		"(()=>{{window.alert=()=>undefined;window.confirm=()=>{accept};window.prompt=()=>{prompt};\
		 return true}})()"
	);
	view
		.automation()
		.evaluate(&script, Duration::from_secs(2))
		.map(drop)
		.map_err(|error| browser_fault("dialogs", error))
}

fn set_interception(view: &WebView, enabled: bool) -> Result<(), Fault> {
	let script = if enabled {
		INTERCEPTION_INSTALL
	} else {
		INTERCEPTION_CLEANUP
	};
	view
		.automation()
		.evaluate(script, Duration::from_secs(2))
		.map(drop)
		.map_err(|error| browser_fault("page.setRequestInterception", error))
}

fn install_request_handler(view: &WebView, source: &str) -> Result<(), Fault> {
	let source =
		serde_json::to_string(source).map_err(|_| invalid("request handler is not serializable"))?;
	let script = format!(
		"(()=>{{const source={source};if(!globalThis.__ompIntercept)throw new Error('request \
		 interception is not \
		 enabled');globalThis.__ompIntercept.handlers.push((0,eval)('('+source+')'));return \
		 true}})()"
	);
	view
		.automation()
		.evaluate(&script, Duration::from_secs(2))
		.map(drop)
		.map_err(|error| browser_fault("page.on(request)", error))
}

fn clear_request_handlers(view: &WebView) -> Result<(), Fault> {
	view
		.automation()
		.evaluate(
			"(()=>{if(globalThis.__ompIntercept)globalThis.__ompIntercept.handlers=[];return true})()",
			Duration::from_secs(2),
		)
		.map(drop)
		.map_err(|error| browser_fault("page.removeAllListeners", error))
}

fn cleanup_interception(view: &WebView) {
	let _ = view
		.automation()
		.evaluate(INTERCEPTION_CLEANUP, Duration::from_millis(500));
}

fn wait_for_navigation(
	view: &WebView,
	mode: Option<WaitUntil>,
	timeout: Duration,
) -> Result<(), Fault> {
	view
		.automation()
		.wait_for_navigation(timeout)
		.map_err(|error| browser_fault("waitForNavigation", error))?;
	wait_for_condition(view, mode, timeout)
}

fn wait_for_condition(
	view: &WebView,
	mode: Option<WaitUntil>,
	timeout: Duration,
) -> Result<(), Fault> {
	let mode = mode.unwrap_or(WaitUntil::Load);
	let deadline = Instant::now() + timeout;
	let mut last_resources = None;
	let mut quiet_since = Instant::now();
	loop {
		let state = view
			.automation()
			.evaluate(
				"({ready:document.readyState,resources:performance.getEntriesByType('resource').\
				 length})",
				Duration::from_secs(2),
			)
			.map_err(|error| browser_fault("waitForNavigation", error))?;
		let ready = state
			.get("ready")
			.and_then(Value::as_str)
			.unwrap_or_default();
		let resources = state
			.get("resources")
			.and_then(Value::as_u64)
			.unwrap_or_default();
		if last_resources != Some(resources) {
			last_resources = Some(resources);
			quiet_since = Instant::now();
		}
		let settled = match mode {
			WaitUntil::Domcontentloaded => ready != "loading",
			WaitUntil::Load => ready == "complete",
			WaitUntil::Networkidle0 => {
				ready == "complete" && quiet_since.elapsed() >= Duration::from_millis(500)
			},
			WaitUntil::Networkidle2 => {
				ready != "loading" && quiet_since.elapsed() >= Duration::from_millis(500)
			},
		};
		if settled {
			return Ok(());
		}
		if Instant::now() >= deadline {
			return Err(timed_out("waiting for navigation condition"));
		}
		thread::sleep(Duration::from_millis(50));
	}
}

fn parse_wait_until(value: &str) -> Result<WaitUntil, Fault> {
	match value {
		"load" => Ok(WaitUntil::Load),
		"domcontentloaded" => Ok(WaitUntil::Domcontentloaded),
		"networkidle0" => Ok(WaitUntil::Networkidle0),
		"networkidle2" => Ok(WaitUntil::Networkidle2),
		_ => Err(invalid("invalid waitUntil value")),
	}
}

fn mutates_page(op: &str) -> bool {
	matches!(op, "goto" | "click" | "press" | "drag")
}

fn selector(values: &[Value], index: usize) -> Result<Selector, Fault> {
	Selector::parse(arg_str(values, index, "selector is required")?)
		.map_err(|error| browser_fault("selector", error))
}

fn arg_str<'a>(values: &'a [Value], index: usize, message: &'static str) -> Result<&'a str, Fault> {
	values
		.get(index)
		.and_then(Value::as_str)
		.ok_or_else(|| invalid(message))
}

fn store_artifact(blobs: &BlobHost, bytes: &[u8]) -> Result<Str, Fault> {
	let id = blobs.put(bytes).map_err(|_| artifact_fault())?;
	let hash = id
		.hash
		.iter()
		.map(|byte| format!("{byte:02x}"))
		.collect::<String>();
	Ok(sf!("artifact://sha256/{hash}"))
}

fn validate(params: &Params) -> Result<(), Fault> {
	if let Some(app) = &params.app {
		let choices = usize::from(app.path.is_some())
			+ usize::from(app.cdp_url.is_some())
			+ usize::from(app.relay == Some(true));
		if choices > 1 {
			return Err(invalid("app.path, app.cdp_url, and app.relay are mutually exclusive"));
		}
		if app.args.is_some() && app.path.is_none() {
			return Err(invalid("app.args requires app.path"));
		}
	}
	match params.action {
		Action::Open if params.code.is_some() => Err(invalid("open does not accept code")),
		Action::Run if params.code.is_none() => Err(invalid("run requires `code`")),
		Action::Close if params.code.is_some() || params.url.is_some() || params.app.is_some() => {
			Err(invalid("close accepts only name, all, and kill"))
		},
		_ => Ok(()),
	}
}

fn timeout(params: &Params) -> Duration {
	Duration::from_secs_f64(
		params
			.timeout
			.unwrap_or(DEFAULT_TIMEOUT.as_secs_f64())
			.clamp(0.001, MAX_TIMEOUT.as_secs_f64()),
	)
}

fn required<'a>(value: Option<&'a str>, message: &'static str) -> Result<&'a str, Fault> {
	value.ok_or_else(|| invalid(message))
}

fn invalid(message: &'static str) -> Fault {
	invalid_owned(Str::new_static(message), None)
}

fn invalid_owned(message: Str, operation: Option<Str>) -> Fault {
	Fault {
		code: sf!("invalid_browser_request"),
		message,
		name: None,
		url: None,
		title: None,
		browser: None,
		operation,
	}
}

fn not_found(name: &str) -> Fault {
	Fault {
		code:      sf!("browser_tab_not_found"),
		message:   sf!("browser tab `{name}` is not open"),
		name:      Some(name.to_str()),
		url:       None,
		title:     None,
		browser:   None,
		operation: None,
	}
}

fn daemon_closed() -> Fault {
	Fault {
		code:      sf!("browser_daemon_closed"),
		message:   sf!("browser daemon is not available"),
		name:      None,
		url:       None,
		title:     None,
		browser:   None,
		operation: None,
	}
}

fn cancelled(operation: &'static str) -> Fault {
	Fault {
		code:      sf!("browser_cancelled"),
		message:   sf!("browser operation was cancelled"),
		name:      None,
		url:       None,
		title:     None,
		browser:   None,
		operation: Some(Str::new_static(operation)),
	}
}

fn timed_out(operation: &'static str) -> Fault {
	Fault {
		code:      sf!("browser_timeout"),
		message:   sf!("browser operation timed out while {operation}"),
		name:      None,
		url:       None,
		title:     None,
		browser:   None,
		operation: Some(Str::new_static(operation)),
	}
}

fn code_fault(message: &str) -> Fault {
	Fault {
		code:      sf!("browser_code_failed"),
		message:   redact(message),
		name:      None,
		url:       None,
		title:     None,
		browser:   None,
		operation: Some(sf!("run")),
	}
}

fn artifact_fault() -> Fault {
	Fault {
		code:      sf!("browser_artifact_failed"),
		message:   sf!("browser output could not be retained"),
		name:      None,
		url:       None,
		title:     None,
		browser:   None,
		operation: Some(sf!("artifact")),
	}
}

fn relay_fault(message: &'static str) -> Fault {
	relay_fault_owned(Str::new_static(message))
}

fn relay_fault_owned(message: Str) -> Fault {
	Fault {
		code: sf!("browser_relay_failed"),
		message,
		name: None,
		url: None,
		title: None,
		browser: Some(sf!("relay")),
		operation: Some(sf!("open")),
	}
}

fn browser_fault(operation: &'static str, error: omp_webview::Error) -> Fault {
	let (code, message) = match &error {
		omp_webview::Error::NoEngine(_) => {
			(sf!("browser_engine_unavailable"), sf!("no supported browser engine is installed"))
		},
		omp_webview::Error::CdpDiscovery(_) => {
			(sf!("browser_cdp_unavailable"), sf!("CDP endpoint discovery failed"))
		},
		omp_webview::Error::Launch { .. } => {
			(sf!("browser_launch_failed"), sf!("browser process failed to launch"))
		},
		omp_webview::Error::Timeout(_) => (sf!("browser_timeout"), redact(&error.to_string())),
		omp_webview::Error::Closed => (sf!("browser_closed"), sf!("browser connection closed")),
		omp_webview::Error::Protocol(_) => {
			(sf!("browser_protocol_failed"), redact(&error.to_string()))
		},
		omp_webview::Error::Unsupported(_) => {
			(sf!("browser_unsupported"), redact(&error.to_string()))
		},
		_ => (sf!("browser_automation_failed"), redact(&error.to_string())),
	};
	Fault {
		code,
		message,
		name: None,
		url: None,
		title: None,
		browser: None,
		operation: Some(Str::new_static(operation)),
	}
}

fn tab_fault(mut fault: Fault, name: &Str, view: &WebView, backend: &Str) -> Fault {
	fault.name = Some(name.clone());
	fault.url = Some(redact_url(&view.url()));
	fault.title = Some(view.title());
	fault.browser = Some(backend.clone());
	fault
}

fn redact_url(raw: &str) -> Str {
	let Ok(mut url) = url::Url::parse(raw) else {
		return Str::new_static("<redacted-url>");
	};
	let _ = url.set_username("");
	let _ = url.set_password(None);
	url.set_query(None);
	url.set_fragment(None);
	Str::new(url.to_string())
}

fn redact(message: &str) -> Str {
	let mut words = message
		.split_whitespace()
		.map(str::to_owned)
		.collect::<Vec<_>>();
	for word in &mut words {
		if (word.starts_with("http://")
			|| word.starts_with("https://")
			|| word.starts_with("ws://")
			|| word.starts_with("wss://"))
			&& (word.contains('?') || word.contains('@'))
		{
			*word = "<redacted-url>".to_owned();
		} else if word.to_ascii_lowercase().contains("token=")
			|| word.to_ascii_lowercase().contains("authorization")
		{
			*word = "<redacted>".to_owned();
		}
	}
	Str::new(words.join(" "))
}

const RUN_RUNTIME: &str = r#"
(()=>{
 const queue=[], pending=new Map(); let next=1,currentUrl='';
 const clone=v=>{try{return structuredClone(v)}catch{} try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}};
 const rpc=(op,args=[])=>new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});queue.push({id,op,args:clone(args)})});
 const fire=(op,args=[])=>{queue.push({id:next++,op,args:clone(args)});return page};
 const element=selector=>({
   click:()=>rpc('click',[selector]), type:text=>rpc('type',[selector,text]), fill:value=>rpc('fill',[selector,value]),
   press:key=>rpc('press',[key,selector]), scrollIntoView:()=>rpc('scrollIntoView',[selector]),
   drag:target=>rpc('drag',[selector,target?.selector??target]), evaluate:(fn,...args)=>rpc('evaluate',[String(fn),args,typeof fn==='function']),
   select:(...values)=>rpc('select',[selector,...values]), uploadFile:(...paths)=>rpc('uploadFile',[selector,...paths]), selector
 });
 const tab={
   url:()=>currentUrl, title:()=>rpc('title'), goto:async(url,opts)=>{currentUrl=await rpc('goto',[url,opts]);return undefined}, observe:opts=>rpc('observe',[opts]),
   ariaSnapshot:(selector,opts)=>rpc('ariaSnapshot',[selector,opts]), screenshot:opts=>rpc('screenshot',[opts]), extract:format=>rpc('extract',[format]),
   click:selector=>rpc('click',[selector]), type:(selector,text)=>rpc('type',[selector,text]), fill:(selector,value)=>rpc('fill',[selector,value]),
   press:(key,opts)=>rpc('press',[key,opts?.selector]), scroll:(dx,dy)=>rpc('scroll',[dx,dy]), scrollIntoView:selector=>rpc('scrollIntoView',[selector]),
   drag:(from,to)=>rpc('drag',[from,to]), select:(selector,...values)=>rpc('select',[selector,...values]), uploadFile:(selector,...paths)=>rpc('uploadFile',[selector,...paths]),
   evaluate:(fn,...args)=>rpc('evaluate',[String(fn),args,typeof fn==='function']), waitFor:async selector=>{await rpc('waitFor',[selector]);return element(selector)},
   waitForSelector:async selector=>{await rpc('waitForSelector',[selector]);return element(selector)}, waitForUrl:async(pattern,opts)=>{currentUrl=await rpc('waitForUrl',[String(pattern),opts]);return currentUrl},
   waitForResponse:(pattern,opts)=>rpc('waitForResponse',[String(pattern),opts]), waitForNavigation:async opts=>{currentUrl=await rpc('waitForNavigation',[opts]);return currentUrl},
   id:async id=>element(`aria-ref=e${id}`), ref:async ref=>element(ref.startsWith('e')?`aria-ref=${ref}`:ref),
   download:url=>rpc('download',[url])
 };
 const page=Object.assign(tab,{
   setRequestInterception:enabled=>rpc('setRequestInterception',[enabled]),
   on:(event,handler)=>event==='request'?fire('onRequest',[String(handler)]):page,
   once:(event,handler)=>event==='request'?fire('onRequest',[String(handler)]):page,
   removeAllListeners:event=>event==='request'?fire('clearRequestHandlers'):page
 });
 const browser={pages:async()=>[page]};
 globalThis.__ompTake=()=>queue.splice(0);
 globalThis.__ompReply=(id,envelope)=>{const p=pending.get(id);if(!p)return false;pending.delete(id);envelope.ok?p.resolve(envelope.value):p.reject(new Error(envelope.error));return true};
 globalThis.__ompStart=(code,name,url)=>{const display=[];globalThis.__ompState={status:'running',display};tab.name=name;currentUrl=url;
   const show=value=>display.push(clone(value));globalThis.print=(...values)=>show(values.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' '));
   for(const level of ['log','info','warn','error'])console[level]=(...values)=>globalThis.print(...values);
   const assert=(condition,message='Assertion failed')=>{if(!condition)throw new Error(message);return condition};
   const wait=async(value,opts={})=>{const timeout=typeof opts==='number'?opts:(opts.timeout??8000);if(typeof value==='number'){await new Promise(r=>setTimeout(r,value));return}if(typeof value!=='function')throw new TypeError('wait expects milliseconds or a predicate');const end=Date.now()+timeout;while(Date.now()<end){const result=await value();if(result)return result;await new Promise(r=>setTimeout(r,100))}throw new Error('wait predicate timed out')};
   const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
   Promise.resolve(new AsyncFunction('page','browser','tab','display','assert','wait',code)(page,browser,tab,v=>display.push(clone(v)),assert,wait))
    .then(result=>{globalThis.__ompState={status:'done',display,result:clone(result)}})
    .catch(error=>{globalThis.__ompState={status:'error',display,error:String(error?.stack||error)}});
   return true
 };
 return true
})()
"#;

const INTERCEPTION_INSTALL: &str = r#"
(()=>{
 if(globalThis.__ompIntercept)return true;
 const original=globalThis.fetch.bind(globalThis), state={original,handlers:[],timer:null}; globalThis.__ompIntercept=state;
 state.timer=setTimeout(()=>{if(globalThis.__ompIntercept!==state)return;globalThis.fetch=state.original;state.handlers=[];delete globalThis.__ompIntercept},300000);
 globalThis.fetch=async(input,init={})=>{let decision=null;const url=typeof input==='string'?input:input.url;
   const request={url:()=>url,method:()=>init.method||'GET',headers:()=>init.headers||{},
     continue:override=>{decision={kind:'continue',override}},abort:()=>{decision={kind:'abort'}},respond:value=>{decision={kind:'respond',value}}};
   for(const handler of state.handlers)await handler(request);
   if(decision?.kind==='abort')throw new DOMException('Request aborted','AbortError');
   if(decision?.kind==='respond')return new Response(decision.value?.body||'',{status:decision.value?.status||200,headers:decision.value?.headers||{}});
   return original(input,decision?.override?{...init,...decision.override}:init)
 }; return true
})()
"#;

const INTERCEPTION_CLEANUP: &str = r#"
(()=>{const state=globalThis.__ompIntercept;if(!state)return true;clearTimeout(state.timer);globalThis.fetch=state.original;state.handlers=[];delete globalThis.__ompIntercept;return true})()
"#;

#[cfg(test)]
mod tests {
	use super::*;

	fn params(action: Action) -> Params {
		Params {
			action,
			name: None,
			url: None,
			app: None,
			viewport: None,
			wait_until: None,
			dialogs: None,
			code: None,
			timeout: None,
			all: false,
			kill: false,
			restart_for_mode_change: None,
		}
	}

	#[test]
	fn relay_failure_subprocess_helper() {
		if std::env::var_os("OMP_RELAY_FAILURE_HELPER").is_some() {
			eprintln!("synthetic relay startup failure");
			std::process::exit(17);
		}
	}

	#[test]
	fn spawned_relay_surfaces_bounded_early_stderr() {
		let child = Command::new(std::env::current_exe().expect("test executable"))
			.args(["relay_failure_subprocess_helper", "--nocapture"])
			.env("OMP_RELAY_FAILURE_HELPER", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::piped())
			.spawn()
			.expect("failure helper");
		let mut observed = SpawnedRelay::observe(child).expect("observe child");
		let deadline = Instant::now() + Duration::from_secs(2);
		let status = loop {
			if let Some(status) = observed.poll_exit().expect("poll helper") {
				break status;
			}
			assert!(Instant::now() < deadline, "helper did not exit");
			thread::sleep(Duration::from_millis(5));
		};
		let fault = observed.exit_fault(status);
		assert!(fault.message.contains("synthetic relay startup failure"));
		assert!(fault.message.len() <= MAX_RELAY_STDERR_BYTES + 256);
	}

	#[test]
	fn run_requires_code_and_app_backends_are_exclusive() {
		assert_eq!(
			validate(&params(Action::Run))
				.expect_err("missing code")
				.code,
			"invalid_browser_request"
		);
		let mut request = params(Action::Open);
		request.app = Some(omp_tools::browser::App {
			path:    Some(sf!("/Applications/Browser")),
			cdp_url: Some(sf!("http://127.0.0.1:9222")),
			relay:   None,
			args:    None,
			target:  None,
		});
		assert!(validate(&request).is_err());
	}

	#[test]
	fn errors_redact_url_credentials_and_query_values() {
		assert_eq!(
			redact_url("https://user:pass@example.test/path?token=secret#frag"),
			"https://example.test/path"
		);
		assert_eq!(
			redact("failed at https://example.test/a?token=secret authorization=secret"),
			"failed at <redacted-url> <redacted>"
		);
	}

	#[test]
	fn runtime_lifts_the_complete_bounded_helper_vocabulary() {
		for helper in [
			"observe",
			"ariaSnapshot",
			"screenshot",
			"download",
			"uploadFile",
			"waitForNavigation",
			"waitForResponse",
			"setRequestInterception",
			"clearRequestHandlers",
		] {
			assert!(RUN_RUNTIME.contains(helper), "missing {helper}");
		}
		assert!(INTERCEPTION_CLEANUP.contains("state.handlers=[]"));
		assert!(INTERCEPTION_CLEANUP.contains("delete globalThis.__ompIntercept"));
	}
}
