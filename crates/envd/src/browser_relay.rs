//! Native Chrome-extension browser relay and CDP façade.
//!
//! The relay binds loopback, exposes Chrome-compatible discovery endpoints,
//! and multiplexes downstream CDP clients over one `chrome.debugger`
//! attachment per tab owned by the companion extension.

use std::{
	convert::Infallible,
	io::{Read as _, Write as _},
	net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener, TcpStream},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use bytes::Bytes;
use futures::{SinkExt as _, StreamExt as _, stream};
use http::{HeaderMap, Method, Request, Response, StatusCode, header};
use http_body_util::Full;
use hyper::{body::Incoming, server::conn::http1, service::service_fn, upgrade::Upgraded};
use hyper_util::rt::TokioIo;
use omp_core::{FastHashMap, FastHashSet, Str, dirs::user_config_root};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tokio::{
	io::AsyncReadExt as _,
	net::TcpListener,
	sync::{Semaphore, oneshot},
	time,
};
use tokio_tungstenite::{
	WebSocketStream,
	tungstenite::{
		Message,
		handshake::derive_accept_key,
		protocol::{Role, WebSocketConfig},
	},
};
use tokio_util::sync::CancellationToken;

const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(20);
const KEEPALIVE: Duration = Duration::from_secs(30);
const SOCKET_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const SOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_OUTBOUND_CAPACITY: usize = 64;
const MAX_PARALLEL_SOCKET_RPCS: usize = 16;
const DEFAULT_GROUP_TITLE: &str = "omp";
const DEFAULT_GROUP_COLOR: &str = "cyan";
const DEFAULT_PORT: u16 = 9224;
const LEASE_PATH: &str = "/__omp/browser-relay/lease";
const LEASE_PROTOCOL: &str = "omp-browser-relay-lease";

/// Native relay startup and extension-installation failure.
#[derive(Debug, Error)]
pub enum RelayError {
	/// A non-loopback bind address was rejected.
	#[error("browser relay bind address must be loopback, got {address}")]
	NonLoopbackBind {
		/// Rejected bind address.
		address: IpAddr,
	},
	/// The loopback listener could not be created.
	#[error("browser relay could not bind loopback port {port}")]
	Bind {
		/// Requested loopback port.
		port:   u16,
		/// Operating-system bind failure.
		#[source]
		source: std::io::Error,
	},
	/// The relay async runtime could not be created.
	#[error("browser relay async runtime could not start")]
	Runtime(#[source] std::io::Error),
	/// The bound listener could not be registered with the async runtime.
	#[error("browser relay listener could not start")]
	Listener(#[source] std::io::Error),
	/// The relay service thread could not be created.
	#[error("browser relay service thread could not start")]
	Thread(#[source] std::io::Error),
	/// The profile-aware user configuration root could not be resolved.
	#[error("browser relay extension configuration root could not be resolved")]
	ConfigRoot(#[source] omp_core::dirs::DataDirError),
	/// An explicit relative installation path could not be resolved.
	#[error("browser relay extension installation directory could not be resolved")]
	ResolveInstallDirectory {
		/// Current-directory resolution failure.
		#[source]
		source: std::io::Error,
	},
	/// An extension asset directory could not be created.
	#[error("browser relay extension directory could not be created at {path}")]
	CreateDirectory {
		/// Destination directory.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: std::io::Error,
	},
	/// An embedded extension asset could not be written.
	#[error("browser relay extension asset could not be written to {path}")]
	WriteAsset {
		/// Destination file.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: std::io::Error,
	},
}

impl RelayError {
	/// Returns whether startup lost the port to another listener.
	#[must_use]
	pub fn is_addr_in_use(&self) -> bool {
		matches!(self, Self::Bind { source, .. } if source.kind() == std::io::ErrorKind::AddrInUse)
	}
}

/// Relay server configuration.
#[derive(Clone, Debug)]
pub struct RelayOptions {
	/// Loopback address accepting relay connections.
	pub bind:    IpAddr,
	/// Loopback TCP port.
	pub port:    u16,
	/// Optional shared secret required by `/ext`.
	pub token:   Option<Str>,
	/// Whether claimed tabs are gathered into the OMP group.
	pub group:   bool,
	/// Emits protocol lifecycle diagnostics through tracing.
	pub verbose: bool,
	/// Exits the server after its last machine-global consumer lease closes.
	pub managed: bool,
}

impl Default for RelayOptions {
	fn default() -> Self {
		Self {
			bind:    IpAddr::V4(Ipv4Addr::LOCALHOST),
			port:    DEFAULT_PORT,
			token:   None,
			group:   true,
			verbose: false,
			managed: false,
		}
	}
}

/// Running native relay service.
pub struct RelayServer {
	port:     u16,
	bridge:   Arc<RelayBridge>,
	leases:   Arc<RelayLeaseState>,
	shutdown: CancellationToken,
	thread:   Option<thread::JoinHandle<()>>,
}

impl RelayServer {
	/// Binds and starts a native relay service on the loopback interface.
	pub fn start(options: RelayOptions) -> Result<Self, RelayError> {
		if !options.bind.is_loopback() {
			return Err(RelayError::NonLoopbackBind { address: options.bind });
		}
		let address = SocketAddr::new(options.bind, options.port);
		let listener = StdTcpListener::bind(address)
			.map_err(|source| RelayError::Bind { port: options.port, source })?;
		let port = listener
			.local_addr()
			.map_err(|source| RelayError::Bind { port: options.port, source })?
			.port();
		listener
			.set_nonblocking(true)
			.map_err(|source| RelayError::Bind { port, source })?;
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(RelayError::Runtime)?;
		let listener = {
			let _runtime = runtime.enter();
			TcpListener::from_std(listener).map_err(RelayError::Listener)?
		};
		let bridge = Arc::new(RelayBridge::new(options.group, options.verbose));
		let shutdown = CancellationToken::new();
		let leases = Arc::new(RelayLeaseState::new(options.managed, shutdown.clone()));
		let service_bridge = Arc::clone(&bridge);
		let service_leases = Arc::clone(&leases);
		let service_shutdown = shutdown.clone();
		let token = options.token.filter(|token| !token.is_empty());
		let thread = thread::Builder::new()
			.name("omp-browser-relay".to_owned())
			.spawn(move || {
				runtime.block_on(serve(
					listener,
					port,
					token,
					service_bridge,
					service_leases,
					service_shutdown,
				));
			})
			.map_err(RelayError::Thread)?;
		Ok(Self { port, bridge, leases, shutdown, thread: Some(thread) })
	}

	/// Bound loopback port.
	#[must_use]
	pub const fn port(&self) -> u16 {
		self.port
	}

	/// True after the extension completed its hello handshake.
	#[must_use]
	pub fn ready(&self) -> bool {
		self.bridge.ready.load(Ordering::Acquire)
	}

	/// True while at least one machine-global consumer lease is connected.
	#[must_use]
	pub fn has_consumer_lease(&self) -> bool {
		self.leases.active.load(Ordering::Acquire) > 0
	}

	/// True after the final managed consumer lease requested shutdown.
	#[must_use]
	pub fn managed_shutdown_requested(&self) -> bool {
		self.leases.managed_shutdown_requested()
	}

	/// Waits until the final managed consumer lease closes.
	pub async fn wait_for_managed_shutdown(&self) {
		self.shutdown.cancelled().await;
	}

	/// Stops the listener and all websocket connections.
	pub fn stop(mut self) {
		self.stop_inner();
	}

	fn stop_inner(&mut self) {
		self.bridge.shutting_down.store(true, Ordering::Release);
		let mut pending = Vec::new();
		let deadline = Instant::now() + SOCKET_CLOSE_TIMEOUT;
		while Instant::now() < deadline {
			pending.retain_mut(|reply: &mut oneshot::Receiver<Result<Value, RpcError>>| {
				matches!(reply.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty))
			});
			let available = MAX_PARALLEL_SOCKET_RPCS.saturating_sub(pending.len());
			if available > 0 {
				pending.extend(self.bridge.begin_shutdown_detach(available));
			}
			if pending.is_empty() {
				break;
			}
			thread::sleep(Duration::from_millis(1));
		}
		self.shutdown.cancel();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

impl Drop for RelayServer {
	fn drop(&mut self) {
		self.stop_inner();
	}
}

struct RelayLeaseState {
	managed:  bool,
	active:   AtomicUsize,
	acquired: AtomicBool,
	shutdown: CancellationToken,
}

impl RelayLeaseState {
	fn new(managed: bool, shutdown: CancellationToken) -> Self {
		Self { managed, active: AtomicUsize::new(0), acquired: AtomicBool::new(false), shutdown }
	}

	fn acquire(self: &Arc<Self>) -> RelayLeaseGuard {
		self.active.fetch_add(1, Ordering::AcqRel);
		self.acquired.store(true, Ordering::Release);
		RelayLeaseGuard { state: Arc::clone(self) }
	}

	fn managed_shutdown_requested(&self) -> bool {
		self.managed
			&& self.acquired.load(Ordering::Acquire)
			&& self.active.load(Ordering::Acquire) == 0
	}
}

struct RelayLeaseGuard {
	state: Arc<RelayLeaseState>,
}

impl Drop for RelayLeaseGuard {
	fn drop(&mut self) {
		if self.state.active.fetch_sub(1, Ordering::AcqRel) == 1 && self.state.managed {
			self.state.shutdown.cancel();
		}
	}
}

/// A machine-global relay consumer lease.
///
/// Dropping the lease only closes its private loopback connection. It never
/// signals or kills the relay process.
#[derive(Debug)]
pub struct RelayLease {
	_stream: TcpStream,
}

#[derive(Clone, Debug)]
pub(crate) struct RelayEndpoint {
	pub(crate) host:      String,
	pub(crate) port:      u16,
	pub(crate) base_path: String,
	pub(crate) addresses: Vec<SocketAddr>,
	pub(crate) auto_bind: Option<IpAddr>,
	pub(crate) token:     Option<String>,
}

pub(crate) fn parse_relay_endpoint(endpoint: &str) -> Option<RelayEndpoint> {
	let url = url::Url::parse(endpoint).ok()?;
	if url.scheme() != "http" {
		return None;
	}
	let port = url.port_or_known_default()?;
	let (host, auto_bind) = match url.host()? {
		url::Host::Domain(host) => (
			host.to_owned(),
			host
				.eq_ignore_ascii_case("localhost")
				.then_some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
		),
		url::Host::Ipv4(address) => {
			(address.to_string(), address.is_loopback().then_some(IpAddr::V4(address)))
		},
		url::Host::Ipv6(address) => {
			(address.to_string(), address.is_loopback().then_some(IpAddr::V6(address)))
		},
	};
	let addresses = url.socket_addrs(|| None).ok()?;
	if addresses.is_empty() {
		return None;
	}
	let base_path = url.path().trim_end_matches('/').to_owned();
	let token = url
		.query_pairs()
		.find_map(|(key, value)| (key == "token").then(|| value.into_owned()));
	Some(RelayEndpoint { host, port, base_path, addresses, auto_bind, token })
}

/// Acquires and holds a machine-global consumer lease from a native relay.
///
/// `None` means the endpoint was unreachable or is not an OMP native relay.
#[must_use]
pub fn acquire_relay_lease(endpoint: &str, timeout: Duration) -> Option<RelayLease> {
	let endpoint = parse_relay_endpoint(endpoint)?;
	endpoint.addresses.iter().find_map(|address| {
		acquire_relay_lease_address(
			*address,
			&endpoint.host,
			endpoint.port,
			&endpoint.base_path,
			timeout,
		)
	})
}

pub(crate) fn acquire_relay_lease_address(
	address: SocketAddr,
	host: &str,
	port: u16,
	base_path: &str,
	timeout: Duration,
) -> Option<RelayLease> {
	let mut stream = TcpStream::connect_timeout(&address, timeout).ok()?;
	stream.set_read_timeout(Some(timeout)).ok()?;
	stream.set_write_timeout(Some(timeout)).ok()?;
	let authority = relay_authority(host, port);
	let request = format!(
		"GET {base_path}{LEASE_PATH} HTTP/1.1\r\nHost: {authority}\r\nConnection: \
		 Upgrade\r\nUpgrade: {LEASE_PROTOCOL}\r\n\r\n"
	);
	stream.write_all(request.as_bytes()).ok()?;
	let mut response = [0_u8; 1024];
	let mut read = 0;
	while read < response.len()
		&& !response[..read]
			.windows(4)
			.any(|bytes| bytes == b"\r\n\r\n")
	{
		let count = stream.read(&mut response[read..]).ok()?;
		if count == 0 {
			return None;
		}
		read += count;
	}
	let response = &response[..read];
	if !response.starts_with(b"HTTP/1.1 101") && !response.starts_with(b"HTTP/1.0 101") {
		return None;
	}
	stream.set_read_timeout(None).ok()?;
	stream.set_write_timeout(None).ok()?;
	Some(RelayLease { _stream: stream })
}

/// Writes the four embedded Chrome extension assets and returns their
/// directory.
pub fn install_extension(dir: Option<&Path>) -> Result<PathBuf, RelayError> {
	let destination = match dir {
		Some(path) => std::path::absolute(path)
			.map_err(|source| RelayError::ResolveInstallDirectory { source })?,
		None => user_config_root()
			.map_err(RelayError::ConfigRoot)?
			.join("browser-relay/extension"),
	};
	std::fs::create_dir_all(&destination)
		.map_err(|source| RelayError::CreateDirectory { path: destination.clone(), source })?;
	const ASSETS: [(&str, &[u8]); 4] = [
		("background.js", include_bytes!("../assets/browser-relay/background.js")),
		("manifest.json", include_bytes!("../assets/browser-relay/manifest.json")),
		("options.html", include_bytes!("../assets/browser-relay/options.html")),
		("options.js", include_bytes!("../assets/browser-relay/options.js")),
	];
	for (name, contents) in ASSETS {
		let path = destination.join(name);
		std::fs::write(&path, contents).map_err(|source| RelayError::WriteAsset { path, source })?;
	}
	Ok(destination)
}

/// Probes a relay discovery endpoint directly, deliberately bypassing proxy
/// variables.
#[must_use]
pub fn probe_relay_server(endpoint: &str) -> bool {
	let Some(endpoint) = parse_relay_endpoint(endpoint) else {
		return false;
	};
	endpoint.addresses.iter().any(|address| {
		matches!(
			probe_relay_status_with_timeout(
				*address,
				&endpoint.host,
				endpoint.port,
				&endpoint.base_path,
				Duration::from_millis(1_500),
			),
			Some(200 | 503)
		)
	})
}

pub(crate) fn probe_relay_ready_address_with_timeout(
	address: SocketAddr,
	host: &str,
	port: u16,
	base_path: &str,
	timeout: Duration,
) -> bool {
	probe_relay_status_with_timeout(address, host, port, base_path, timeout) == Some(200)
}

pub(crate) fn probe_relay_serving_address_with_timeout(
	address: SocketAddr,
	host: &str,
	port: u16,
	base_path: &str,
	timeout: Duration,
) -> bool {
	matches!(
		probe_relay_status_with_timeout(address, host, port, base_path, timeout),
		Some(200 | 503)
	)
}

fn probe_relay_status_with_timeout(
	address: SocketAddr,
	host: &str,
	port: u16,
	base_path: &str,
	timeout: Duration,
) -> Option<u16> {
	let mut stream = TcpStream::connect_timeout(&address, timeout).ok()?;
	stream.set_read_timeout(Some(timeout)).ok()?;
	stream.set_write_timeout(Some(timeout)).ok()?;
	let authority = relay_authority(host, port);
	let request = format!(
		"GET {base_path}/json/version HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
	);
	stream.write_all(request.as_bytes()).ok()?;
	let mut prefix = [0_u8; 32];
	let mut read = 0;
	while read < prefix.len() && !prefix[..read].contains(&b'\n') {
		let count = stream.read(&mut prefix[read..]).ok()?;
		if count == 0 {
			break;
		}
		read += count;
	}
	let status = std::str::from_utf8(&prefix[..read])
		.ok()?
		.split_whitespace()
		.nth(1)?
		.parse()
		.ok()?;
	Some(status)
}

fn relay_authority(host: &str, port: u16) -> String {
	if host.contains(':') {
		format!("[{host}]:{port}")
	} else {
		format!("{host}:{port}")
	}
}

async fn serve(
	listener: TcpListener,
	port: u16,
	token: Option<Str>,
	bridge: Arc<RelayBridge>,
	leases: Arc<RelayLeaseState>,
	shutdown: CancellationToken,
) {
	loop {
		tokio::select! {
			_ = shutdown.cancelled() => break,
			accepted = listener.accept() => {
				let Ok((stream, peer)) = accepted else { continue };
				let bridge = Arc::clone(&bridge);
				let leases = Arc::clone(&leases);
				let token = token.clone();
				let shutdown = shutdown.clone();
				tokio::spawn(async move {
					let service = service_fn(move |request| {
						handle_http(
							request,
							port,
							token.clone(),
							Arc::clone(&bridge),
							Arc::clone(&leases),
							shutdown.clone(),
							peer.ip().is_loopback(),
						)
					});
					let _ = http1::Builder::new()
						.serve_connection(TokioIo::new(stream), service)
						.with_upgrades()
						.await;
				});
			},
		}
	}
}

async fn handle_http(
	mut request: Request<Incoming>,
	port: u16,
	token: Option<Str>,
	bridge: Arc<RelayBridge>,
	leases: Arc<RelayLeaseState>,
	shutdown: CancellationToken,
	peer_is_loopback: bool,
) -> Result<Response<Full<Bytes>>, Infallible> {
	let path = request.uri().path().trim_end_matches('/');
	let path = if path.is_empty() { "/" } else { path };
	if path == LEASE_PATH {
		if request.method() != Method::GET
			|| !peer_is_loopback
			|| !is_lease_upgrade(request.headers())
		{
			return Ok(text_response(StatusCode::NOT_FOUND, "Not found"));
		}
		let upgrade = hyper::upgrade::on(&mut request);
		let lease = leases.acquire();
		tokio::spawn(async move {
			let _lease = lease;
			let Ok(upgraded) = upgrade.await else {
				return;
			};
			let mut upgraded = TokioIo::new(upgraded);
			let mut byte = [0_u8; 1];
			loop {
				tokio::select! {
					_ = shutdown.cancelled() => break,
					read = upgraded.read(&mut byte) => {
						if !matches!(read, Ok(1)) {
							break;
						}
					},
				}
			}
		});
		return Ok(Response::builder()
			.status(StatusCode::SWITCHING_PROTOCOLS)
			.header(header::CONNECTION, "Upgrade")
			.header(header::UPGRADE, LEASE_PROTOCOL)
			.body(Full::new(Bytes::new()))
			.expect("static lease response"));
	}
	if path == "/cdp" || path == "/ext" {
		let role = if path == "/ext" {
			SocketRole::Extension
		} else {
			SocketRole::Cdp
		};
		if role == SocketRole::Cdp
			&& request
				.headers()
				.get(header::ORIGIN)
				.is_some_and(|origin| !origin.is_empty())
		{
			return Ok(text_response(StatusCode::FORBIDDEN, "Forbidden"));
		}
		if role == SocketRole::Extension {
			if let Some(origin) = request.headers().get(header::ORIGIN)
				&& !origin.is_empty()
				&& !origin
					.to_str()
					.is_ok_and(|value| value.starts_with("chrome-extension://"))
			{
				return Ok(text_response(StatusCode::FORBIDDEN, "Forbidden"));
			}
			if let Some(required) = token.as_deref() {
				let supplied = request.uri().query().and_then(|query| {
					url::form_urlencoded::parse(query.as_bytes())
						.find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
				});
				if supplied.as_deref() != Some(required) {
					return Ok(text_response(StatusCode::UNAUTHORIZED, "Unauthorized"));
				}
			}
		}
		if request.method() != Method::GET {
			return Ok(text_response(StatusCode::UPGRADE_REQUIRED, "websocket upgrade required"));
		}
		let Some(key) = websocket_key(request.headers()) else {
			return Ok(text_response(StatusCode::UPGRADE_REQUIRED, "websocket upgrade required"));
		};
		let accept = derive_accept_key(key.as_bytes());
		let upgrade = hyper::upgrade::on(&mut request);
		tokio::spawn(async move {
			if let Ok(upgraded) = upgrade.await {
				serve_websocket(upgraded, role, bridge, shutdown).await;
			}
		});
		let response = Response::builder()
			.status(StatusCode::SWITCHING_PROTOCOLS)
			.header(header::CONNECTION, "Upgrade")
			.header(header::UPGRADE, "websocket")
			.header(header::SEC_WEBSOCKET_ACCEPT, accept)
			.body(Full::new(Bytes::new()))
			.expect("static websocket response");
		return Ok(response);
	}
	if request.method() != Method::GET {
		return Ok(text_response(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"));
	}
	match path {
		"/json/version" if !bridge.ready.load(Ordering::Acquire) => Ok(json_response(
			StatusCode::SERVICE_UNAVAILABLE,
			&json!({ "error": "relay extension is not connected" }),
		)),
		"/json/version" => {
			let authority = websocket_authority(request.headers(), port);
			Ok(json_response(StatusCode::OK, &bridge.version_info(&format!("ws://{authority}/cdp"))))
		},
		"/json" | "/json/list" => Ok(json_response(StatusCode::OK, &bridge.list_targets())),
		_ => Ok(text_response(StatusCode::NOT_FOUND, "Not found")),
	}
}

fn is_lease_upgrade(headers: &HeaderMap) -> bool {
	headers
		.get(header::CONNECTION)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| {
			value
				.split(',')
				.any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
		}) && headers
		.get(header::UPGRADE)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| value.eq_ignore_ascii_case(LEASE_PROTOCOL))
}

fn websocket_key(headers: &HeaderMap) -> Option<&str> {
	let connection = headers.get(header::CONNECTION)?.to_str().ok()?;
	let upgrade = headers.get(header::UPGRADE)?.to_str().ok()?;
	if !connection
		.split(',')
		.any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
		|| !upgrade.eq_ignore_ascii_case("websocket")
	{
		return None;
	}
	headers.get(header::SEC_WEBSOCKET_KEY)?.to_str().ok()
}

fn websocket_authority(headers: &HeaderMap, port: u16) -> String {
	let fallback = format!("127.0.0.1:{port}");
	let Some(raw) = headers
		.get(header::HOST)
		.and_then(|value| value.to_str().ok())
		.map(str::trim)
	else {
		return fallback;
	};
	if raw.is_empty()
		|| raw
			.bytes()
			.any(|byte| byte <= 0x20 || matches!(byte, b'/' | b'\\' | b'@' | b'#' | b'?'))
	{
		return fallback;
	}
	match url::Url::parse(&format!("ws://{raw}")) {
		Ok(url)
			if url.host_str().is_some()
				&& url.path() == "/"
				&& url.query().is_none()
				&& url.fragment().is_none() =>
		{
			raw.to_owned()
		},
		_ => fallback,
	}
}

fn text_response(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
	Response::builder()
		.status(status)
		.header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
		.body(Full::new(Bytes::from_static(text.as_bytes())))
		.expect("static HTTP response")
}

fn json_response(status: StatusCode, value: &Value) -> Response<Full<Bytes>> {
	let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
	Response::builder()
		.status(status)
		.header(header::CONTENT_TYPE, "application/json")
		.body(Full::new(Bytes::from(bytes)))
		.expect("static JSON response")
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SocketRole {
	Extension,
	Cdp,
}

#[derive(Clone)]
struct SocketSender {
	output: flume::Sender<Message>,
	failed: CancellationToken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SocketSendError {
	Encode,
	Full,
	Disconnected,
}

impl SocketSender {
	fn send(&self, message: Message) -> Result<(), SocketSendError> {
		if self.failed.is_cancelled() {
			return Err(SocketSendError::Disconnected);
		}
		match self.output.try_send(message) {
			Ok(()) => Ok(()),
			Err(flume::TrySendError::Full(_)) => {
				self.failed.cancel();
				Err(SocketSendError::Full)
			},
			Err(flume::TrySendError::Disconnected(_)) => {
				self.failed.cancel();
				Err(SocketSendError::Disconnected)
			},
		}
	}

	async fn send_async(&self, message: Message) -> Result<(), SocketSendError> {
		if self.failed.is_cancelled() {
			return Err(SocketSendError::Disconnected);
		}
		match time::timeout(SOCKET_SEND_TIMEOUT, self.output.send_async(message)).await {
			Ok(Ok(())) => Ok(()),
			Ok(Err(_)) => {
				self.failed.cancel();
				Err(SocketSendError::Disconnected)
			},
			Err(_) => {
				self.failed.cancel();
				Err(SocketSendError::Full)
			},
		}
	}

	fn close(&self) {
		let _ = self.output.try_send(Message::Close(None));
		self.failed.cancel();
	}
}

async fn serve_websocket(
	upgraded: Upgraded,
	role: SocketRole,
	bridge: Arc<RelayBridge>,
	shutdown: CancellationToken,
) {
	let mut config = WebSocketConfig::default();
	config.max_message_size = Some(MAX_PAYLOAD_BYTES);
	config.max_frame_size = Some(MAX_PAYLOAD_BYTES);
	let socket =
		WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
	let (mut sink, mut stream) = socket.split();
	let (output, receiver) = flume::bounded(SOCKET_OUTBOUND_CAPACITY);
	let outbound_failed = CancellationToken::new();
	let outgoing = SocketSender { output, failed: outbound_failed.clone() };
	let id = match role {
		SocketRole::Extension => bridge.ext_connected(outgoing.clone()),
		SocketRole::Cdp => bridge.cdp_connected(outgoing),
	};
	let mut keepalive = time::interval(KEEPALIVE);
	loop {
		tokio::select! {
			_ = shutdown.cancelled() => break,
			_ = outbound_failed.cancelled() => break,
			_ = keepalive.tick() => {
				let sent = tokio::select! {
					_ = shutdown.cancelled() => false,
					_ = outbound_failed.cancelled() => false,
					result = sink.send(Message::Ping(Bytes::new())) => result.is_ok(),
				};
				if !sent { break; }
			},
			message = receiver.recv_async() => {
				let Ok(message) = message else { break };
				let sent = tokio::select! {
					_ = shutdown.cancelled() => false,
					_ = outbound_failed.cancelled() => false,
					result = sink.send(message) => result.is_ok(),
				};
				if !sent { break; }
			},
			incoming = stream.next() => match incoming {
				Some(Ok(Message::Text(text))) => dispatch_socket_text(&bridge, role, id, text.as_str()),
				Some(Ok(Message::Binary(bytes))) => {
					let text = String::from_utf8_lossy(&bytes);
					dispatch_socket_text(&bridge, role, id, &text);
				},
				Some(Ok(Message::Ping(bytes))) => {
					let sent = tokio::select! {
						_ = shutdown.cancelled() => false,
						_ = outbound_failed.cancelled() => false,
						result = sink.send(Message::Pong(bytes)) => result.is_ok(),
					};
					if !sent { break; }
				},
				Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
				_ => {},
			},
		}
	}
	match role {
		SocketRole::Extension => bridge.ext_closed(id),
		SocketRole::Cdp => bridge.cdp_closed(id),
	}
	let _ = time::timeout(SOCKET_CLOSE_TIMEOUT, sink.close()).await;
}

fn dispatch_socket_text(bridge: &Arc<RelayBridge>, role: SocketRole, id: u64, text: &str) {
	match role {
		SocketRole::Extension => bridge.ext_message(id, text),
		SocketRole::Cdp => {
			let bridge = Arc::clone(bridge);
			let text = text.to_owned();
			tokio::spawn(async move { bridge.cdp_message(id, &text).await });
		},
	}
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabSnapshot {
	tab_id:    i64,
	url:       Str,
	title:     Str,
	active:    bool,
	window_id: i64,
	pinned:    bool,
	group_id:  i64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum ExtMessage {
	#[serde(rename = "hello")]
	Hello {
		#[serde(rename = "userAgent")]
		user_agent:       Str,
		#[serde(rename = "browserVersion")]
		browser_version:  Str,
		tabs:             Vec<TabSnapshot>,
		#[serde(rename = "attachedTabIds")]
		attached_tab_ids: Vec<i64>,
	},
	#[serde(rename = "cdpEvent")]
	CdpEvent {
		#[serde(rename = "tabId")]
		tab_id:     i64,
		#[serde(rename = "sessionId")]
		session_id: Option<Str>,
		method:     Str,
		params:     Option<Map<String, Value>>,
	},
	#[serde(rename = "detached")]
	Detached {
		#[serde(rename = "tabId")]
		tab_id:          i64,
		reason:          Str,
		#[serde(rename = "relayInitiated", default)]
		relay_initiated: bool,
	},
	#[serde(rename = "tabCreated")]
	TabCreated { tab: TabSnapshot },
	#[serde(rename = "tabUpdated")]
	TabUpdated { tab: TabSnapshot },
	#[serde(rename = "tabRemoved")]
	TabRemoved {
		#[serde(rename = "tabId")]
		tab_id: i64,
	},
	#[serde(rename = "rpcResult")]
	RpcResult { id: u64, ok: bool, result: Option<Value>, error: Option<Str> },
	#[serde(rename = "ping")]
	Ping,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "op")]
enum RpcRequest {
	#[serde(rename = "attach")]
	Attach {
		#[serde(rename = "tabId")]
		tab_id: i64,
	},
	#[serde(rename = "detach")]
	Detach {
		#[serde(rename = "tabId")]
		tab_id: i64,
	},
	#[serde(rename = "send")]
	Send {
		#[serde(rename = "tabId")]
		tab_id:     i64,
		#[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
		session_id: Option<Str>,
		method:     Str,
		#[serde(skip_serializing_if = "Option::is_none")]
		params:     Option<Map<String, Value>>,
	},
	#[serde(rename = "createTab")]
	CreateTab { url: Str },
	#[serde(rename = "removeTab")]
	RemoveTab {
		#[serde(rename = "tabId")]
		tab_id: i64,
	},
	#[serde(rename = "activateTab")]
	ActivateTab {
		#[serde(rename = "tabId")]
		tab_id: i64,
	},
	#[serde(rename = "group")]
	Group {
		#[serde(rename = "tabIds")]
		tab_ids: Vec<i64>,
		title:   Str,
		color:   Str,
	},
	#[serde(rename = "ungroup")]
	Ungroup {
		#[serde(rename = "tabIds")]
		tab_ids: Vec<i64>,
	},
}

#[derive(Serialize)]
#[serde(tag = "t")]
enum RelayMessage {
	#[serde(rename = "rpc")]
	Rpc {
		id:      u64,
		#[serde(flatten)]
		request: RpcRequest,
	},
	#[serde(rename = "pong")]
	Pong,
}

#[derive(Clone, Debug, Deserialize)]
struct CdpCommand {
	id:         u64,
	method:     Str,
	params:     Option<Map<String, Value>>,
	#[serde(rename = "sessionId")]
	session_id: Option<Str>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RuntimeState {
	Default,
	Enabled,
	Disabled,
}

enum SessionRuntimeEnable {
	Reply,
	Wait(oneshot::Receiver<Result<(), RpcError>>),
	Start { previous: RuntimeState, epoch: u64 },
}

enum RootRuntimeEnable {
	Reply,
	Wait(oneshot::Receiver<Result<(), RpcError>>),
	Start { cycle: u64, generation: u64 },
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SessionKind {
	Tab,
	Page,
}

struct SessionRef {
	kind:             SessionKind,
	tab_id:           i64,
	runtime_state:    RuntimeState,
	runtime_contexts: FastHashSet<i64>,
	runtime_enabling: Option<u64>,
	runtime_waiters:  FastHashMap<u64, Vec<oneshot::Sender<Result<(), RpcError>>>>,
	runtime_epoch:    u64,
}

struct CdpConnection {
	socket:      SocketSender,
	discover:    bool,
	auto_attach: bool,
	sessions:    FastHashMap<Str, SessionRef>,
	claims:      FastHashSet<i64>,
}

struct TabState {
	tab_id:                  i64,
	url:                     Str,
	title:                   Str,
	active:                  bool,
	window_id:               i64,
	pinned:                  bool,
	group_id:                i64,
	attached:                bool,
	banned:                  bool,
	announced:               bool,
	attaching:               Option<u64>,
	attach_epoch:            u64,
	detaching:               Option<u64>,
	detach_epoch:            u64,
	detach_pending:          bool,
	reattached_after_detach: bool,
	grouped:                 bool,
	grouping:                bool,
	omp_group_id:            Option<i64>,
	group_opt_out:           bool,
	real_sessions:           FastHashSet<Str>,
	runtime_contexts:        FastHashMap<i64, Map<String, Value>>,
	root_runtime_enabled:    bool,
	root_runtime_enabling:   Option<u64>,
	root_runtime_waiters:    FastHashMap<u64, Vec<oneshot::Sender<Result<(), RpcError>>>>,
	root_runtime_cycle:      u64,
	runtime_generation:      u64,
}

impl TabState {
	fn new(snapshot: TabSnapshot) -> Self {
		Self {
			tab_id:                  snapshot.tab_id,
			url:                     snapshot.url,
			title:                   snapshot.title,
			active:                  snapshot.active,
			window_id:               snapshot.window_id,
			pinned:                  snapshot.pinned,
			group_id:                snapshot.group_id,
			attached:                false,
			banned:                  false,
			announced:               false,
			attaching:               None,
			attach_epoch:            0,
			detaching:               None,
			detach_epoch:            0,
			detach_pending:          false,
			reattached_after_detach: false,
			grouped:                 false,
			grouping:                false,
			omp_group_id:            None,
			group_opt_out:           false,
			real_sessions:           FastHashSet::default(),
			runtime_contexts:        FastHashMap::default(),
			root_runtime_enabled:    false,
			root_runtime_enabling:   None,
			root_runtime_waiters:    FastHashMap::default(),
			root_runtime_cycle:      0,
			runtime_generation:      0,
		}
	}

	fn update(&mut self, snapshot: TabSnapshot) {
		self.url = snapshot.url;
		self.title = snapshot.title;
		self.active = snapshot.active;
		self.window_id = snapshot.window_id;
		self.pinned = snapshot.pinned;
		self.group_id = snapshot.group_id;
	}
}

struct ExtensionSocket {
	id:     u64,
	socket: SocketSender,
}
struct ExtensionInfo {
	user_agent:      Str,
	browser_version: Str,
}
struct PendingRpc {
	reply: oneshot::Sender<Result<Value, RpcError>>,
}

#[derive(Clone, Debug)]
enum RpcError {
	Replaced,
	Disconnected,
	Timeout,
	Remote(Str),
}

struct BridgeState {
	tabs:              FastHashMap<i64, TabState>,
	tab_order:         Vec<i64>,
	connections:       FastHashMap<u64, CdpConnection>,
	connection_seq:    u64,
	session_seq:       u64,
	rpc_seq:           u64,
	socket_seq:        u64,
	extension:         Option<ExtensionSocket>,
	extension_info:    Option<ExtensionInfo>,
	pending_rpc:       FastHashMap<u64, PendingRpc>,
	real_session_tabs: FastHashMap<Str, i64>,
	group_queue:       Vec<i64>,
	group_draining:    bool,
	group_generation:  u64,
}

struct RelayBridge {
	state:         Mutex<BridgeState>,
	ready:         AtomicBool,
	shutting_down: AtomicBool,
	rpc_limit:     Arc<Semaphore>,
	group:         bool,
	verbose:       bool,
}

impl RelayBridge {
	fn new(group: bool, verbose: bool) -> Self {
		Self {
			state: Mutex::new(BridgeState {
				tabs:              FastHashMap::default(),
				tab_order:         Vec::new(),
				connections:       FastHashMap::default(),
				connection_seq:    0,
				session_seq:       0,
				rpc_seq:           0,
				socket_seq:        0,
				extension:         None,
				extension_info:    None,
				pending_rpc:       FastHashMap::default(),
				real_session_tabs: FastHashMap::default(),
				group_queue:       Vec::new(),
				group_draining:    false,
				group_generation:  0,
			}),
			ready: AtomicBool::new(false),
			shutting_down: AtomicBool::new(false),
			rpc_limit: Arc::new(Semaphore::new(MAX_PARALLEL_SOCKET_RPCS)),
			group,
			verbose,
		}
	}

	fn log(&self, message: &'static str) {
		if self.verbose {
			eprintln!("[relay] {message}");
		}
	}

	fn begin_shutdown_detach(
		&self,
		limit: usize,
	) -> Vec<oneshot::Receiver<Result<Value, RpcError>>> {
		let mut state = self.state.lock();
		let Some(socket) = state
			.extension
			.as_ref()
			.map(|extension| extension.socket.clone())
		else {
			return Vec::new();
		};
		let tabs = state
			.tabs
			.values()
			.filter_map(|tab| tab.attached.then_some(tab.tab_id))
			.take(limit)
			.collect::<Vec<_>>();
		let mut replies = Vec::with_capacity(tabs.len());
		for tab_id in tabs {
			state.rpc_seq += 1;
			let id = state.rpc_seq;
			let (reply, receiver) = oneshot::channel();
			state.pending_rpc.insert(id, PendingRpc { reply });
			if send_json(&socket, &RelayMessage::Rpc { id, request: RpcRequest::Detach { tab_id } })
				.is_ok()
			{
				if let Some(tab) = state.tabs.get_mut(&tab_id) {
					tab.attached = false;
					tab.detach_pending = true;
				}
				replies.push(receiver);
			} else {
				state.pending_rpc.remove(&id);
			}
		}
		replies
	}

	fn version_info(&self, websocket_url: &str) -> Value {
		let state = self.state.lock();
		let (browser, user_agent) = state
			.extension_info
			.as_ref()
			.map_or(("Chrome/unknown", ""), |info| {
				(info.browser_version.as_str(), info.user_agent.as_str())
			});
		json!({
			"Browser": browser, "Protocol-Version": "1.3", "User-Agent": user_agent,
			"V8-Version": "", "WebKit-Version": "", "webSocketDebuggerUrl": websocket_url,
		})
	}

	fn list_targets(&self) -> Value {
		let state = self.state.lock();
		Value::Array(
			state
				.tab_order
				.iter()
				.filter_map(|tab_id| state.tabs.get(tab_id))
				.filter(|tab| eligible(tab))
				.map(|tab| {
					json!({
						"id": page_target_id(tab.tab_id), "type": "page", "title": tab.title, "url": tab.url,
					})
				})
				.collect(),
		)
	}

	fn ext_connected(self: &Arc<Self>, socket: SocketSender) -> u64 {
		let mut state = self.state.lock();
		state.socket_seq += 1;
		let id = state.socket_seq;
		if let Some(previous) = state.extension.replace(ExtensionSocket { id, socket }) {
			self.log("replacing extension socket");
			previous.socket.close();
			reset_all_runtime(&mut state);
			reset_group_drain(&mut state);
			reject_pending(&mut state, RpcError::Replaced);
		}
		id
	}

	fn ext_closed(&self, id: u64) {
		let mut state = self.state.lock();
		if state
			.extension
			.as_ref()
			.is_none_or(|extension| extension.id != id)
		{
			return;
		}
		self.log("extension disconnected");
		state.extension = None;
		state.extension_info = None;
		self.ready.store(false, Ordering::Release);
		reject_pending(&mut state, RpcError::Disconnected);
		for tab in state.tabs.values_mut() {
			tab.attached = false;
			reset_attaching(tab);
			reset_detaching(tab);
		}
		reset_all_runtime(&mut state);
		reset_all_grouping(&mut state);
	}

	fn ext_message(self: &Arc<Self>, socket_id: u64, raw: &str) {
		let Ok(message) = serde_json::from_str::<ExtMessage>(raw) else {
			self.log("dropping malformed extension message");
			return;
		};
		if self
			.state
			.lock()
			.extension
			.as_ref()
			.is_none_or(|extension| extension.id != socket_id)
		{
			return;
		}
		match message {
			ExtMessage::Hello { user_agent, browser_version, tabs, attached_tab_ids } => {
				self.on_hello(user_agent, browser_version, tabs, attached_tab_ids);
			},
			ExtMessage::RpcResult { id, ok, result, error } => {
				let pending = self.state.lock().pending_rpc.remove(&id);
				if let Some(pending) = pending {
					let value = if ok {
						Ok(result.unwrap_or(Value::Null))
					} else {
						Err(RpcError::Remote(
							error.unwrap_or_else(|| Str::new_static("extension rpc failed")),
						))
					};
					let _ = pending.reply.send(value);
				}
			},
			ExtMessage::CdpEvent { tab_id, session_id, method, params } => {
				self.on_cdp_event(tab_id, session_id, method, params)
			},
			ExtMessage::Detached { tab_id, reason, relay_initiated } => {
				self.on_tab_detached(tab_id, &reason, relay_initiated)
			},
			ExtMessage::TabCreated { tab } | ExtMessage::TabUpdated { tab } => {
				self.on_tab_upsert(tab, false)
			},
			ExtMessage::TabRemoved { tab_id } => self.on_tab_removed(tab_id),
			ExtMessage::Ping => {
				let state = self.state.lock();
				if let Some(extension) = &state.extension {
					let _ = send_json(&extension.socket, &RelayMessage::Pong);
				}
			},
		}
	}

	fn on_hello(
		self: &Arc<Self>,
		user_agent: Str,
		browser_version: Str,
		tabs: Vec<TabSnapshot>,
		attached: Vec<i64>,
	) {
		let mut restore = Vec::new();
		let mut restore_runtime = Vec::new();
		let mut detach = Vec::new();
		{
			let mut state = self.state.lock();
			state.extension_info = Some(ExtensionInfo { user_agent, browser_version });
			let seen: FastHashSet<i64> = tabs.iter().map(|tab| tab.tab_id).collect();
			for snapshot in tabs {
				upsert_locked(&mut state, snapshot);
			}
			let removed: Vec<i64> = state
				.tabs
				.keys()
				.copied()
				.filter(|id| !seen.contains(id))
				.collect();
			for id in removed {
				retract_tab_locked(&mut state, id);
				state.tabs.remove(&id);
			}
			state.tab_order.retain(|id| seen.contains(id));
			let attached: FastHashSet<i64> = attached.into_iter().collect();
			let holders: FastHashSet<i64> = state
				.connections
				.values()
				.flat_map(|conn| conn.sessions.values().map(|session| session.tab_id))
				.collect();
			for tab in state.tabs.values_mut() {
				tab.attached = attached.contains(&tab.tab_id);
				reset_attaching(tab);
				reset_detaching(tab);
				if !tab.attached {
					tab.detach_pending = false;
					if holders.contains(&tab.tab_id) {
						restore.push(tab.tab_id);
					}
				} else if !holders.contains(&tab.tab_id) {
					detach.push(tab.tab_id);
				} else {
					restore_runtime.push(tab.tab_id);
				}
			}
		}
		self.ready.store(true, Ordering::Release);
		self.log("extension connected");
		if self.shutting_down.load(Ordering::Acquire) {
			return;
		}
		for tab_id in restore {
			let bridge = Arc::clone(self);
			tokio::spawn(async move {
				if bridge.ensure_attached(tab_id).await {
					bridge.restore_runtime_sessions(tab_id).await;
				} else {
					bridge.on_tab_detached(tab_id, "reattach_failed", false);
				}
			});
		}
		for tab_id in restore_runtime {
			let bridge = Arc::clone(self);
			tokio::spawn(async move {
				bridge.restore_runtime_sessions(tab_id).await;
			});
		}
		for tab_id in detach {
			self.detach_if_unheld(tab_id);
		}
		self.sync_grouping();
	}

	fn cdp_connected(&self, socket: SocketSender) -> u64 {
		let mut state = self.state.lock();
		state.connection_seq += 1;
		let id = state.connection_seq;
		state.connections.insert(id, CdpConnection {
			socket,
			discover: false,
			auto_attach: false,
			sessions: FastHashMap::default(),
			claims: FastHashSet::default(),
		});
		drop(state);
		self.log("cdp client connected");
		id
	}

	fn cdp_closed(self: &Arc<Self>, id: u64) {
		let (claims, touched) = {
			let mut state = self.state.lock();
			let Some(connection) = state.connections.remove(&id) else {
				return;
			};
			let touched = connection
				.sessions
				.values()
				.map(|session| session.tab_id)
				.collect::<FastHashSet<_>>();
			(connection.claims, touched)
		};
		for tab_id in claims {
			self.sync_tab_grouping(tab_id);
		}
		for tab_id in touched {
			self.detach_if_unheld(tab_id);
		}
		self.log("cdp client disconnected");
	}

	async fn cdp_message(self: Arc<Self>, connection_id: u64, raw: &str) {
		let Ok(command) = serde_json::from_str::<CdpCommand>(raw) else {
			return;
		};
		if !self.state.lock().connections.contains_key(&connection_id) {
			return;
		}
		if let Err(error) = self
			.handle_cdp_command(connection_id, command.clone())
			.await
		{
			self.reply_error(connection_id, &command, rpc_error_message(&error), -32000);
		}
	}

	async fn handle_cdp_command(
		self: &Arc<Self>,
		connection_id: u64,
		command: CdpCommand,
	) -> Result<(), RpcError> {
		let Some(session_id) = command.session_id.clone() else {
			return self.handle_browser_command(connection_id, command).await;
		};
		let session = {
			let state = self.state.lock();
			state
				.connections
				.get(&connection_id)
				.and_then(|conn| conn.sessions.get(&session_id))
				.map(|session| (session.kind, session.tab_id))
		};
		match session {
			Some((SessionKind::Tab, tab_id)) => {
				self.handle_tab_command(connection_id, &command, tab_id);
				Ok(())
			},
			Some((SessionKind::Page, tab_id)) if command.method == "Runtime.enable" => {
				self
					.enable_session_runtime(connection_id, command, session_id, tab_id)
					.await
			},
			Some((SessionKind::Page, _)) if command.method == "Runtime.disable" => {
				let mut state = self.state.lock();
				if let Some(session) = state
					.connections
					.get_mut(&connection_id)
					.and_then(|conn| conn.sessions.get_mut(&session_id))
				{
					session.runtime_state = RuntimeState::Disabled;
					session.runtime_epoch += 1;
					session.runtime_contexts.clear();
					session.runtime_enabling = None;
				}
				drop(state);
				self.reply(connection_id, &command, json!({}));
				Ok(())
			},
			Some((SessionKind::Page, tab_id)) => {
				self
					.forward_to_tab(connection_id, &command, tab_id, None)
					.await
			},
			None => {
				let tab_id = self
					.state
					.lock()
					.real_session_tabs
					.get(&session_id)
					.copied();
				if let Some(tab_id) = tab_id {
					self
						.forward_to_tab(connection_id, &command, tab_id, Some(session_id))
						.await
				} else {
					self.reply_error(
						connection_id,
						&command,
						&format!("Unknown session id {session_id}"),
						-32000,
					);
					Ok(())
				}
			},
		}
	}

	async fn handle_browser_command(
		self: &Arc<Self>,
		connection_id: u64,
		command: CdpCommand,
	) -> Result<(), RpcError> {
		match command.method.as_str() {
			"Browser.getVersion" => {
				let state = self.state.lock();
				let (product, user_agent) = state
					.extension_info
					.as_ref()
					.map_or(("Chrome/unknown", ""), |info| {
						(info.browser_version.as_str(), info.user_agent.as_str())
					});
				let result = json!({ "protocolVersion": "1.3", "product": product, "revision": "", "userAgent": user_agent, "jsVersion": "" });
				drop(state);
				self.reply(connection_id, &command, result);
			},
			"Target.getBrowserContexts" => {
				self.reply(connection_id, &command, json!({ "browserContextIds": [] }))
			},
			"Target.getTargets" => {
				let state = self.state.lock();
				let target_infos = state
					.tab_order
					.iter()
					.filter_map(|tab_id| state.tabs.get(tab_id))
					.filter(|tab| eligible(tab))
					.flat_map(|tab| [tab_info(tab, tab.attached), page_info(tab, tab.attached)])
					.collect::<Vec<_>>();
				drop(state);
				self.reply(connection_id, &command, json!({ "targetInfos": target_infos }));
			},
			"Target.setDiscoverTargets" => {
				let (socket, events) = {
					let mut state = self.state.lock();
					let Some(connection) = state.connections.get_mut(&connection_id) else {
						return Ok(());
					};
					connection.discover = true;
					let socket = connection.socket.clone();
					let order = state.tab_order.clone();
					let mut events = Vec::new();
					for tab_id in order {
						let Some(tab) = state.tabs.get_mut(&tab_id) else {
							continue;
						};
						if eligible(tab) {
							tab.announced = true;
							events.push(cdp_event(
								"Target.targetCreated",
								json!({"targetInfo":tab_info(tab,tab.attached)}),
								None,
							));
							events.push(cdp_event(
								"Target.targetCreated",
								json!({"targetInfo":page_info(tab,tab.attached)}),
								None,
							));
						}
					}
					(socket, events)
				};
				for event in events {
					send_value_async(&socket, &event)
						.await
						.map_err(socket_rpc_error)?;
				}
				send_value_async(
					&socket,
					&cdp_reply(command.id, command.session_id.as_deref(), "result", json!({})),
				)
				.await
				.map_err(socket_rpc_error)?;
			},
			"Target.setAutoAttach" => {
				let tabs = {
					let mut state = self.state.lock();
					if let Some(connection) = state.connections.get_mut(&connection_id) {
						connection.auto_attach = true;
					}
					state
						.tab_order
						.iter()
						.filter_map(|tab_id| state.tabs.get(tab_id))
						.filter(|tab| eligible(tab))
						.map(|tab| tab.tab_id)
						.collect::<Vec<_>>()
				};
				let attached = stream::iter(tabs.iter().copied())
					.map(|tab_id| {
						let bridge = Arc::clone(self);
						async move { bridge.ensure_attached(tab_id).await }
					})
					.buffered(MAX_PARALLEL_SOCKET_RPCS)
					.collect::<Vec<_>>()
					.await;
				if !self.state.lock().connections.contains_key(&connection_id) {
					for (tab_id, attached) in tabs.into_iter().zip(attached) {
						if attached {
							self.detach_if_unheld(tab_id);
						}
					}
					return Ok(());
				}
				for (tab_id, attached) in tabs.into_iter().zip(attached) {
					if attached {
						self.emit_tab_attached(connection_id, tab_id).await;
					} else {
						self.retract_tab(tab_id);
					}
				}
				self
					.reply_async(connection_id, &command, json!({}))
					.await
					.map_err(socket_rpc_error)?;
			},
			"Target.attachToTarget" => {
				let raw = command
					.params
					.as_ref()
					.and_then(|params| params.get("targetId"))
					.and_then(Value::as_str);
				let Some((kind, tab_id)) = raw.and_then(parse_target_id) else {
					self.reply_error(
						connection_id,
						&command,
						&format!("No target with id {}", raw.unwrap_or("undefined")),
						-32000,
					);
					return Ok(());
				};
				if !self.state.lock().tabs.contains_key(&tab_id) {
					self.reply_error(
						connection_id,
						&command,
						&format!("No target with id {}", raw.unwrap_or("undefined")),
						-32000,
					);
					return Ok(());
				}
				if !self.ensure_attached(tab_id).await {
					self.reply_error(
						connection_id,
						&command,
						&format!("Cannot attach to tab {tab_id}"),
						-32000,
					);
					return Ok(());
				}
				let Some(session) = self.mint_session(connection_id, kind, tab_id) else {
					self.detach_if_unheld(tab_id);
					return Ok(());
				};
				let info = {
					let state = self.state.lock();
					let tab = &state.tabs[&tab_id];
					if kind == SessionKind::Tab {
						tab_info(tab, true)
					} else {
						page_info(tab, true)
					}
				};
				self.emit(
					connection_id,
					"Target.attachedToTarget",
					json!({"sessionId": session, "targetInfo": info, "waitingForDebugger": false}),
					None,
				);
				self.reply(connection_id, &command, json!({"sessionId": session}));
			},
			"Target.detachFromTarget" => {
				if let Some(session) = command
					.params
					.as_ref()
					.and_then(|params| params.get("sessionId"))
					.and_then(Value::as_str)
				{
					self.release_session(connection_id, session, None);
				}
				self.reply(connection_id, &command, json!({}));
			},
			"Target.createTarget" => {
				let url = command
					.params
					.as_ref()
					.and_then(|params| params.get("url"))
					.and_then(Value::as_str)
					.filter(|url| !url.is_empty())
					.unwrap_or("about:blank");
				let result = self
					.rpc(RpcRequest::CreateTab { url: Str::new(url) })
					.await?;
				let snapshot = serde_json::from_value::<CreateTabResult>(result)
					.map_err(|_| RpcError::Remote(Str::new_static("invalid createTab response")))?
					.tab;
				let tab_id = snapshot.tab_id;
				self.on_tab_upsert(snapshot, false);
				self.claim_tab(connection_id, tab_id);
				self.reply(connection_id, &command, json!({"targetId": page_target_id(tab_id)}));
			},
			"Target.closeTarget" => {
				let target = command
					.params
					.as_ref()
					.and_then(|params| params.get("targetId"))
					.and_then(Value::as_str);
				let Some((_, tab_id)) = target.and_then(parse_target_id) else {
					self.reply_error(connection_id, &command, "No target with that id", -32000);
					return Ok(());
				};
				self.rpc(RpcRequest::RemoveTab { tab_id }).await?;
				self.reply(connection_id, &command, json!({"success": true}));
			},
			"Target.activateTarget" => {
				if let Some((_, tab_id)) = command
					.params
					.as_ref()
					.and_then(|params| params.get("targetId"))
					.and_then(Value::as_str)
					.and_then(parse_target_id)
				{
					self.rpc(RpcRequest::ActivateTab { tab_id }).await?;
				}
				self.reply(connection_id, &command, json!({}));
			},
			"Target.getTargetInfo" => {
				let target = command
					.params
					.as_ref()
					.and_then(|params| params.get("targetId"))
					.and_then(Value::as_str);
				let info = target.and_then(parse_target_id).and_then(|(kind, tab_id)| self.state.lock().tabs.get(&tab_id).map(|tab| if kind == SessionKind::Tab { tab_info(tab, tab.attached) } else { page_info(tab, tab.attached) })).unwrap_or_else(|| json!({"targetId":"relay-browser","type":"browser","title":"","url":"","attached":true,"canAccessOpener":false}));
				self.reply(connection_id, &command, json!({"targetInfo": info}));
			},
			"Browser.close" | "Browser.setDownloadBehavior" => {
				self.reply(connection_id, &command, json!({}))
			},
			"Target.createBrowserContext" => self.reply_error(
				connection_id,
				&command,
				"Browser contexts are not supported by the omp browser relay",
				-32000,
			),
			_ => self.reply_error(
				connection_id,
				&command,
				&format!("'{}' wasn't found", command.method),
				-32601,
			),
		}
		Ok(())
	}

	fn handle_tab_command(self: &Arc<Self>, connection_id: u64, command: &CdpCommand, tab_id: i64) {
		match command.method.as_str() {
			"Target.setAutoAttach" => {
				if !self.state.lock().tabs.contains_key(&tab_id) {
					self.reply_error(connection_id, command, &format!("Tab {tab_id} is gone"), -32000);
					return;
				}
				let Some(page) = self.mint_session(connection_id, SessionKind::Page, tab_id) else {
					self.detach_if_unheld(tab_id);
					return;
				};
				self.emit(connection_id, "Target.attachedToTarget", json!({"sessionId":page,"targetInfo":self.state.lock().tabs.get(&tab_id).map(|tab| page_info(tab,true)).unwrap_or(Value::Null),"waitingForDebugger":false}), command.session_id.clone());
				self.reply(connection_id, command, json!({}));
			},
			"Runtime.runIfWaitingForDebugger" => self.reply(connection_id, command, json!({})),
			"Target.detachFromTarget" => {
				if let Some(child) = command
					.params
					.as_ref()
					.and_then(|params| params.get("sessionId"))
					.and_then(Value::as_str)
				{
					self.release_session(connection_id, child, command.session_id.clone());
				}
				self.reply(connection_id, command, json!({}));
			},
			_ => self.reply_error(
				connection_id,
				command,
				&format!("'{}' is not supported on a tab target", command.method),
				-32601,
			),
		}
	}

	async fn forward_to_tab(
		self: &Arc<Self>,
		connection_id: u64,
		command: &CdpCommand,
		tab_id: i64,
		real_session: Option<Str>,
	) -> Result<(), RpcError> {
		if command.method == "Browser.close" {
			self.reply(connection_id, command, json!({}));
			return Ok(());
		}
		if command.method == "OMP.claimTarget" {
			self.claim_tab(connection_id, tab_id);
			self.reply(connection_id, command, json!({}));
			return Ok(());
		}
		match self
			.rpc(RpcRequest::Send {
				tab_id,
				session_id: real_session,
				method: command.method.clone(),
				params: command.params.clone(),
			})
			.await
		{
			Ok(Value::Null) => self.reply(connection_id, command, json!({})),
			Ok(value) => self.reply(connection_id, command, value),
			Err(error) => self.reply_error(connection_id, command, rpc_error_message(&error), -32000),
		}
		Ok(())
	}

	async fn rpc(&self, request: RpcRequest) -> Result<Value, RpcError> {
		let _permit = Arc::clone(&self.rpc_limit)
			.acquire_owned()
			.await
			.map_err(|_| RpcError::Disconnected)?;
		let (id, receiver) = {
			let mut state = self.state.lock();
			let Some(socket) = state
				.extension
				.as_ref()
				.map(|extension| extension.socket.clone())
			else {
				return Err(RpcError::Disconnected);
			};
			state.rpc_seq += 1;
			let id = state.rpc_seq;
			let (reply, receiver) = oneshot::channel();
			state.pending_rpc.insert(id, PendingRpc { reply });
			if let Err(error) = send_json(&socket, &RelayMessage::Rpc { id, request }) {
				state.pending_rpc.remove(&id);
				return Err(match error {
					SocketSendError::Encode => {
						RpcError::Remote(Str::new_static("extension rpc could not be encoded"))
					},
					SocketSendError::Full | SocketSendError::Disconnected => RpcError::Disconnected,
				});
			}
			(id, receiver)
		};
		match time::timeout(RPC_TIMEOUT, receiver).await {
			Ok(Ok(result)) => result,
			_ => {
				self.state.lock().pending_rpc.remove(&id);
				Err(RpcError::Timeout)
			},
		}
	}

	async fn ensure_attached(self: &Arc<Self>, tab_id: i64) -> bool {
		loop {
			let attempt = {
				let mut state = self.state.lock();
				let extension_present = state.extension.is_some();
				let Some(tab) = state.tabs.get_mut(&tab_id) else {
					return false;
				};
				if tab.detaching.is_some() || tab.attaching.is_some() {
					None
				} else if tab.attached {
					return true;
				} else if tab.banned || !extension_present {
					return false;
				} else {
					tab.attach_epoch += 1;
					tab.attaching = Some(tab.attach_epoch);
					Some(tab.attach_epoch)
				}
			};
			let Some(attempt) = attempt else {
				time::sleep(Duration::from_millis(1)).await;
				continue;
			};
			let result = self.rpc(RpcRequest::Attach { tab_id }).await;
			let outcome = {
				let mut state = self.state.lock();
				let Some(tab) = state.tabs.get_mut(&tab_id) else {
					return false;
				};
				if tab.attaching != Some(attempt) {
					None
				} else {
					tab.attaching = None;
					let success = result.is_ok();
					if success {
						tab.attached = true;
						tab.detach_pending = false;
						tab.reattached_after_detach = true;
					} else if !matches!(result, Err(RpcError::Replaced)) {
						tab.banned = true;
						self.log("tab attachment failed");
					}
					Some(success)
				}
			};
			let Some(success) = outcome else {
				continue;
			};
			return success;
		}
	}

	fn detach_if_unheld(self: &Arc<Self>, tab_id: i64) {
		let bridge = Arc::clone(self);
		tokio::spawn(async move {
			bridge.detach_unheld(tab_id).await;
		});
	}

	async fn detach_unheld(self: &Arc<Self>, tab_id: i64) {
		let epoch = {
			let mut state = self.state.lock();
			let held = state.connections.values().any(|conn| {
				conn
					.sessions
					.values()
					.any(|session| session.tab_id == tab_id)
			});
			let Some(tab) = state.tabs.get_mut(&tab_id) else {
				return;
			};
			if held || !tab.attached || tab.detaching.is_some() {
				return;
			}
			tab.attached = false;
			tab.detach_epoch += 1;
			tab.detaching = Some(tab.detach_epoch);
			tab.detach_pending = true;
			tab.reattached_after_detach = false;
			reset_runtime(tab);
			tab.detach_epoch
		};
		let detached = self.rpc(RpcRequest::Detach { tab_id }).await.is_ok();
		let mut state = self.state.lock();
		if let Some(tab) = state.tabs.get_mut(&tab_id)
			&& tab.detaching == Some(epoch)
		{
			tab.detaching = None;
			if detached {
				tab.detach_pending = false;
			}
		}
	}

	fn mint_session(&self, connection_id: u64, kind: SessionKind, tab_id: i64) -> Option<Str> {
		let mut state = self.state.lock();
		if !state.connections.contains_key(&connection_id) {
			return None;
		}
		state.session_seq += 1;
		let prefix = if kind == SessionKind::Tab { "ST" } else { "SP" };
		let session_id = Str::new(format!("{prefix}{tab_id}.{connection_id}.{}", state.session_seq));
		state
			.connections
			.get_mut(&connection_id)
			.expect("connection checked")
			.sessions
			.insert(session_id.clone(), SessionRef {
				kind,
				tab_id,
				runtime_state: RuntimeState::Default,
				runtime_contexts: FastHashSet::default(),
				runtime_enabling: None,
				runtime_waiters: FastHashMap::default(),
				runtime_epoch: 0,
			});
		Some(session_id)
	}

	fn release_session(self: &Arc<Self>, connection_id: u64, session_id: &str, parent: Option<Str>) {
		let released = {
			let mut state = self.state.lock();
			state
				.connections
				.get_mut(&connection_id)
				.and_then(|conn| conn.sessions.remove(session_id))
		};
		if let Some(session) = released {
			let target = if session.kind == SessionKind::Tab {
				tab_target_id(session.tab_id)
			} else {
				page_target_id(session.tab_id)
			};
			self.emit(
				connection_id,
				"Target.detachedFromTarget",
				json!({"sessionId":session_id,"targetId":target}),
				parent,
			);
			self.detach_if_unheld(session.tab_id);
		}
	}

	async fn emit_tab_attached(self: &Arc<Self>, connection_id: u64, tab_id: i64) {
		let exists = self
			.state
			.lock()
			.connections
			.get(&connection_id)
			.is_some_and(|conn| {
				conn
					.sessions
					.values()
					.any(|session| session.tab_id == tab_id && session.kind == SessionKind::Tab)
			});
		if exists {
			return;
		}
		let Some(session) = self.mint_session(connection_id, SessionKind::Tab, tab_id) else {
			self.detach_if_unheld(tab_id);
			return;
		};
		let info = self
			.state
			.lock()
			.tabs
			.get(&tab_id)
			.map(|tab| tab_info(tab, true))
			.unwrap_or(Value::Null);
		let socket = self
			.state
			.lock()
			.connections
			.get(&connection_id)
			.map(|connection| connection.socket.clone());
		let Some(socket) = socket else {
			self.detach_if_unheld(tab_id);
			return;
		};
		let event = cdp_event(
			"Target.attachedToTarget",
			json!({"sessionId":session,"targetInfo":info,"waitingForDebugger":false}),
			None,
		);
		let _ = send_value_async(&socket, &event).await;
	}

	fn claim_tab(self: &Arc<Self>, connection_id: u64, tab_id: i64) {
		if let Some(connection) = self.state.lock().connections.get_mut(&connection_id) {
			connection.claims.insert(tab_id);
		}
		self.log("tab claimed");
		self.sync_tab_grouping(tab_id);
	}

	fn sync_grouping(self: &Arc<Self>) {
		let ids = self.state.lock().tab_order.clone();
		for id in ids {
			self.sync_tab_grouping(id);
		}
	}

	fn sync_tab_grouping(self: &Arc<Self>, tab_id: i64) {
		if !self.group {
			return;
		}
		let mut ungroup = false;
		let mut drain_generation = None;
		{
			let mut state = self.state.lock();
			let claimed = state
				.connections
				.values()
				.any(|connection| connection.claims.contains(&tab_id));
			let Some(tab) = state.tabs.get_mut(&tab_id) else {
				return;
			};
			let worthy = claimed
				&& eligible(tab)
				&& !tab.pinned
				&& !tab.group_opt_out
				&& (tab.grouped || tab.group_id == -1);
			if worthy && !tab.grouped && !tab.grouping {
				tab.grouping = true;
				state.group_queue.push(tab_id);
				if !state.group_draining {
					state.group_draining = true;
					drain_generation = Some(state.group_generation);
				}
			} else if !worthy && tab.grouped {
				tab.grouped = false;
				tab.omp_group_id = None;
				ungroup = true;
			}
		}
		if ungroup {
			let bridge = Arc::clone(self);
			tokio::spawn(async move {
				let _ = bridge
					.rpc(RpcRequest::Ungroup { tab_ids: vec![tab_id] })
					.await;
			});
		}
		if let Some(generation) = drain_generation {
			let bridge = Arc::clone(self);
			tokio::spawn(async move {
				bridge.drain_group_queue(generation).await;
			});
		}
	}

	async fn drain_group_queue(self: Arc<Self>, generation: u64) {
		loop {
			let batch = {
				let mut state = self.state.lock();
				if state.group_generation != generation {
					return;
				}
				if state.group_queue.is_empty() {
					state.group_draining = false;
					return;
				}
				std::mem::take(&mut state.group_queue)
			};
			let result = self
				.rpc(RpcRequest::Group {
					tab_ids: batch.clone(),
					title:   Str::new_static(DEFAULT_GROUP_TITLE),
					color:   Str::new_static(DEFAULT_GROUP_COLOR),
				})
				.await;
			if result.is_ok() {
				self.log("grouped claimed tabs");
			} else {
				self.log("tab grouping failed");
			}
			let grouped = result
				.ok()
				.and_then(|value| value.get("grouped").and_then(Value::as_object).cloned())
				.unwrap_or_default();
			let mut completed = Vec::new();
			{
				let mut state = self.state.lock();
				if state.group_generation != generation {
					return;
				}
				for tab_id in &batch {
					if let Some(tab) = state.tabs.get_mut(tab_id) {
						tab.grouping = false;
						if let Some(group_id) = grouped.get(&tab_id.to_string()).and_then(Value::as_i64) {
							tab.grouped = true;
							tab.omp_group_id = Some(group_id);
							completed.push(*tab_id);
						}
					}
				}
			}
			for tab_id in completed {
				self.sync_tab_grouping(tab_id);
			}
		}
	}

	async fn enable_session_runtime(
		self: &Arc<Self>,
		connection_id: u64,
		command: CdpCommand,
		session_id: Str,
		tab_id: i64,
	) -> Result<(), RpcError> {
		let action = {
			let mut state = self.state.lock();
			let Some(session) = state
				.connections
				.get_mut(&connection_id)
				.and_then(|conn| conn.sessions.get_mut(&session_id))
			else {
				return Ok(());
			};
			if let Some(epoch) = session.runtime_enabling {
				let (reply, receiver) = oneshot::channel();
				session
					.runtime_waiters
					.entry(epoch)
					.or_default()
					.push(reply);
				SessionRuntimeEnable::Wait(receiver)
			} else if session.runtime_state == RuntimeState::Enabled {
				SessionRuntimeEnable::Reply
			} else {
				let previous = session.runtime_state;
				session.runtime_state = RuntimeState::Enabled;
				session.runtime_epoch += 1;
				let epoch = session.runtime_epoch;
				session.runtime_enabling = Some(epoch);
				session.runtime_waiters.entry(epoch).or_default();
				SessionRuntimeEnable::Start { previous, epoch }
			}
		};
		let (previous, epoch) = match action {
			SessionRuntimeEnable::Reply => {
				self.reply(connection_id, &command, json!({}));
				return Ok(());
			},
			SessionRuntimeEnable::Wait(receiver) => {
				receiver.await.map_err(|_| RpcError::Disconnected)??;
				self.reply(connection_id, &command, json!({}));
				return Ok(());
			},
			SessionRuntimeEnable::Start { previous, epoch } => (previous, epoch),
		};

		let result = self.ensure_runtime_enabled(tab_id).await;
		let mut replay = Vec::new();
		let waiters = {
			let mut state = self.state.lock();
			let contexts = state
				.tabs
				.get(&tab_id)
				.map(|tab| tab.runtime_contexts.clone())
				.unwrap_or_default();
			let Some(session) = state
				.connections
				.get_mut(&connection_id)
				.and_then(|conn| conn.sessions.get_mut(&session_id))
			else {
				return result;
			};
			if result.is_err() && session.runtime_epoch == epoch {
				session.runtime_state = previous;
				session.runtime_contexts.clear();
			}
			if result.is_ok()
				&& session.runtime_epoch == epoch
				&& session.runtime_state == RuntimeState::Enabled
			{
				for (id, params) in contexts {
					if session.runtime_contexts.insert(id) {
						replay.push(params);
					}
				}
			}
			if session.runtime_enabling == Some(epoch) {
				session.runtime_enabling = None;
			}
			session.runtime_waiters.remove(&epoch).unwrap_or_default()
		};
		if result.is_ok() {
			for params in replay {
				let _ = self
					.emit_async(
						connection_id,
						"Runtime.executionContextCreated",
						Value::Object(params),
						Some(session_id.clone()),
					)
					.await;
			}
		}
		for waiter in waiters {
			let _ = waiter.send(result.clone());
		}
		result?;
		self
			.reply_async(connection_id, &command, json!({}))
			.await
			.map_err(socket_rpc_error)?;
		Ok(())
	}

	async fn restore_runtime_sessions(self: &Arc<Self>, tab_id: i64) {
		let required = {
			let state = self.state.lock();
			state.connections.values().any(|connection| {
				connection.sessions.values().any(|session| {
					session.kind == SessionKind::Page
						&& session.tab_id == tab_id
						&& session.runtime_state == RuntimeState::Enabled
						&& session.runtime_enabling.is_none()
				})
			})
		};
		if !required {
			return;
		}
		if self.ensure_runtime_enabled(tab_id).await.is_err() {
			self.log("Runtime restore failed");
			self.retract_tab(tab_id);
			self.detach_if_unheld(tab_id);
			return;
		}
		let replay = {
			let mut state = self.state.lock();
			let contexts = state
				.tabs
				.get(&tab_id)
				.map(|tab| tab.runtime_contexts.clone())
				.unwrap_or_default();
			let mut replay = Vec::new();
			for (connection_id, connection) in &mut state.connections {
				for (session_id, session) in &mut connection.sessions {
					if session.kind != SessionKind::Page
						|| session.tab_id != tab_id
						|| session.runtime_state != RuntimeState::Enabled
					{
						continue;
					}
					for (context_id, params) in &contexts {
						if session.runtime_contexts.insert(*context_id) {
							replay.push((*connection_id, session_id.clone(), params.clone()));
						}
					}
				}
			}
			replay
		};
		for (connection_id, session_id, params) in replay {
			let _ = self
				.emit_async(
					connection_id,
					"Runtime.executionContextCreated",
					Value::Object(params),
					Some(session_id),
				)
				.await;
		}
	}

	async fn ensure_runtime_enabled(self: &Arc<Self>, tab_id: i64) -> Result<(), RpcError> {
		let action = {
			let mut state = self.state.lock();
			let Some(tab) = state.tabs.get_mut(&tab_id) else {
				return Err(RpcError::Remote(Str::new_static("tab is gone")));
			};
			if tab.root_runtime_enabled {
				RootRuntimeEnable::Reply
			} else if let Some(cycle) = tab.root_runtime_enabling {
				let (reply, receiver) = oneshot::channel();
				tab.root_runtime_waiters
					.entry(cycle)
					.or_default()
					.push(reply);
				RootRuntimeEnable::Wait(receiver)
			} else {
				tab.root_runtime_cycle += 1;
				let cycle = tab.root_runtime_cycle;
				tab.root_runtime_enabling = Some(cycle);
				tab.root_runtime_waiters.entry(cycle).or_default();
				RootRuntimeEnable::Start { cycle, generation: tab.runtime_generation }
			}
		};
		let (cycle, generation) = match action {
			RootRuntimeEnable::Reply => return Ok(()),
			RootRuntimeEnable::Wait(receiver) => {
				return receiver.await.map_err(|_| RpcError::Disconnected)?;
			},
			RootRuntimeEnable::Start { cycle, generation } => (cycle, generation),
		};

		let disabled = self
			.rpc(RpcRequest::Send {
				tab_id,
				session_id: None,
				method: Str::new_static("Runtime.disable"),
				params: None,
			})
			.await;
		let result = match disabled {
			Ok(_) => self
				.rpc(RpcRequest::Send {
					tab_id,
					session_id: None,
					method: Str::new_static("Runtime.enable"),
					params: None,
				})
				.await
				.map(drop),
			Err(error) => Err(error),
		};
		let waiters = {
			let mut state = self.state.lock();
			let Some(tab) = state.tabs.get_mut(&tab_id) else {
				return result;
			};
			if tab.root_runtime_enabling == Some(cycle) {
				if result.is_ok() && tab.runtime_generation == generation {
					tab.root_runtime_enabled = true;
				}
				tab.root_runtime_enabling = None;
			}
			tab.root_runtime_waiters.remove(&cycle).unwrap_or_default()
		};
		for waiter in waiters {
			let _ = waiter.send(result.clone());
		}
		result
	}

	fn on_cdp_event(
		&self,
		tab_id: i64,
		source_session: Option<Str>,
		method: Str,
		params: Option<Map<String, Value>>,
	) {
		let mut state = self.state.lock();
		if !state.tabs.contains_key(&tab_id) {
			return;
		}
		if method == "Target.attachedToTarget" {
			if let Some(child) = params
				.as_ref()
				.and_then(|params| params.get("sessionId"))
				.and_then(Value::as_str)
			{
				let child = Str::new(child);
				state
					.tabs
					.get_mut(&tab_id)
					.expect("tab checked")
					.real_sessions
					.insert(child.clone());
				state.real_session_tabs.insert(child, tab_id);
			}
		} else if method == "Target.detachedFromTarget"
			&& let Some(child) = params
				.as_ref()
				.and_then(|params| params.get("sessionId"))
				.and_then(Value::as_str)
		{
			state
				.tabs
				.get_mut(&tab_id)
				.expect("tab checked")
				.real_sessions
				.remove(child);
			state.real_session_tabs.remove(child);
		}
		if let Some(source_session) = source_session {
			let payload = json!({"sessionId":source_session,"method":method,"params":params});
			for connection in state.connections.values() {
				if connection
					.sessions
					.values()
					.any(|session| session.tab_id == tab_id && session.kind == SessionKind::Page)
				{
					send_value(&connection.socket, &payload);
				}
			}
			return;
		}
		if method.starts_with("Runtime.") {
			let created = (method == "Runtime.executionContextCreated")
				.then(|| {
					params
						.as_ref()
						.and_then(|params| params.get("context"))
						.and_then(|context| context.get("id"))
						.and_then(Value::as_i64)
				})
				.flatten();
			let destroyed = (method == "Runtime.executionContextDestroyed")
				.then(|| {
					params
						.as_ref()
						.and_then(|params| params.get("executionContextId"))
						.and_then(Value::as_i64)
				})
				.flatten();
			{
				let tab = state.tabs.get_mut(&tab_id).expect("tab checked");
				if let Some(id) = created
					&& let Some(params) = params.clone()
				{
					tab.runtime_contexts.insert(id, params);
				}
				if let Some(id) = destroyed {
					tab.runtime_contexts.remove(&id);
				}
				if method == "Runtime.executionContextsCleared" {
					tab.runtime_contexts.clear();
				}
			}
			for connection in state.connections.values_mut() {
				let socket = connection.socket.clone();
				for (session_id, session) in &mut connection.sessions {
					if session.kind != SessionKind::Page || session.tab_id != tab_id {
						continue;
					}
					if let Some(id) = destroyed {
						session.runtime_contexts.remove(&id);
					}
					if method == "Runtime.executionContextsCleared" {
						session.runtime_contexts.clear();
					}
					if session.runtime_state == RuntimeState::Disabled {
						continue;
					}
					if let Some(id) = created
						&& !session.runtime_contexts.insert(id)
					{
						continue;
					}
					send_value(
						&socket,
						&json!({"sessionId":session_id,"method":method,"params":params}),
					);
				}
			}
			return;
		}
		for connection in state.connections.values() {
			for (session_id, session) in &connection.sessions {
				if session.kind == SessionKind::Page && session.tab_id == tab_id {
					send_value(
						&connection.socket,
						&json!({"sessionId":session_id,"method":method,"params":params}),
					);
				}
			}
		}
	}

	fn on_tab_detached(self: &Arc<Self>, tab_id: i64, _reason: &str, relay_initiated: bool) {
		self.log("tab debugger detached");
		if relay_initiated {
			let restore = {
				let mut state = self.state.lock();
				let held = state.connections.values().any(|connection| {
					connection
						.sessions
						.values()
						.any(|session| session.tab_id == tab_id)
				});
				let Some(tab) = state.tabs.get_mut(&tab_id) else {
					return;
				};
				let detached = !tab.reattached_after_detach;
				if detached {
					tab.detach_pending = false;
					reset_detaching(tab);
					tab.attached = false;
					reset_runtime(tab);
				}
				if detached {
					for connection in state.connections.values_mut() {
						for session in connection.sessions.values_mut() {
							if session.tab_id == tab_id {
								session.runtime_contexts.clear();
							}
						}
					}
				}
				detached && held && !self.shutting_down.load(Ordering::Acquire)
			};
			if restore {
				let bridge = Arc::clone(self);
				tokio::spawn(async move {
					if bridge.ensure_attached(tab_id).await {
						bridge.restore_runtime_sessions(tab_id).await;
					} else {
						bridge.on_tab_detached(tab_id, "reattach_failed", false);
					}
				});
			}
			return;
		}
		{
			let mut state = self.state.lock();
			let Some(tab) = state.tabs.get_mut(&tab_id) else {
				return;
			};
			tab.attached = false;
			tab.detach_pending = false;
			reset_attaching(tab);
			reset_runtime(tab);
			tab.banned = true;
		}
		self.sync_tab_grouping(tab_id);
		self.retract_tab(tab_id);
	}

	fn on_tab_upsert(self: &Arc<Self>, snapshot: TabSnapshot, silent: bool) {
		let tab_id = snapshot.tab_id;
		let (eligible_now, announced, discovering, auto_attach) = {
			let mut state = self.state.lock();
			if let Some(tab) = state.tabs.get_mut(&tab_id) {
				if tab.url != snapshot.url {
					tab.banned = false;
				}
				if tab.grouped && tab.omp_group_id.is_some_and(|id| snapshot.group_id != id) {
					tab.grouped = false;
					tab.group_opt_out = true;
				}
				tab.update(snapshot);
			} else {
				state.tabs.insert(tab_id, TabState::new(snapshot));
				state.tab_order.push(tab_id);
			}
			let tab = &state.tabs[&tab_id];
			(
				eligible(tab),
				tab.announced,
				state
					.connections
					.iter()
					.filter_map(|(id, conn)| conn.discover.then_some(*id))
					.collect::<Vec<_>>(),
				state
					.connections
					.iter()
					.filter_map(|(id, conn)| conn.auto_attach.then_some(*id))
					.collect::<Vec<_>>(),
			)
		};
		if silent {
			return;
		}
		self.sync_tab_grouping(tab_id);
		if eligible_now && !announced {
			let mut state = self.state.lock();
			if let Some(tab) = state.tabs.get_mut(&tab_id) {
				tab.announced = true;
				let tab_target = tab_info(tab, tab.attached);
				let page_target = page_info(tab, tab.attached);
				for id in discovering {
					emit_locked(
						&state,
						id,
						"Target.targetCreated",
						json!({"targetInfo":tab_target}),
						None,
					);
					emit_locked(
						&state,
						id,
						"Target.targetCreated",
						json!({"targetInfo":page_target}),
						None,
					);
				}
			}
			drop(state);
			for id in auto_attach {
				let bridge = Arc::clone(self);
				tokio::spawn(async move {
					if bridge.ensure_attached(tab_id).await {
						bridge.emit_tab_attached(id, tab_id).await;
					}
				});
			}
		} else if !eligible_now && announced {
			self.retract_tab(tab_id);
		} else if eligible_now && announced {
			let state = self.state.lock();
			if let Some(tab) = state.tabs.get(&tab_id) {
				for id in discovering {
					emit_locked(
						&state,
						id,
						"Target.targetInfoChanged",
						json!({"targetInfo":tab_info(tab,tab.attached)}),
						None,
					);
					emit_locked(
						&state,
						id,
						"Target.targetInfoChanged",
						json!({"targetInfo":page_info(tab,tab.attached)}),
						None,
					);
				}
			}
		}
	}

	fn on_tab_removed(&self, tab_id: i64) {
		let mut state = self.state.lock();
		retract_tab_locked(&mut state, tab_id);
		state.tabs.remove(&tab_id);
		state.tab_order.retain(|id| *id != tab_id);
		for connection in state.connections.values_mut() {
			connection.claims.remove(&tab_id);
		}
	}

	fn retract_tab(&self, tab_id: i64) {
		retract_tab_locked(&mut self.state.lock(), tab_id);
	}

	fn reply(&self, id: u64, command: &CdpCommand, result: Value) {
		let state = self.state.lock();
		if let Some(connection) = state.connections.get(&id) {
			send_value(
				&connection.socket,
				&cdp_reply(command.id, command.session_id.as_deref(), "result", result),
			);
		}
	}

	fn reply_error(&self, id: u64, command: &CdpCommand, message: &str, code: i64) {
		let state = self.state.lock();
		if let Some(connection) = state.connections.get(&id) {
			send_value(
				&connection.socket,
				&cdp_reply(
					command.id,
					command.session_id.as_deref(),
					"error",
					json!({"code":code,"message":message}),
				),
			);
		}
	}

	fn emit(&self, id: u64, method: &str, params: Value, session: Option<Str>) {
		emit_locked(&self.state.lock(), id, method, params, session);
	}

	async fn reply_async(
		&self,
		id: u64,
		command: &CdpCommand,
		result: Value,
	) -> Result<(), SocketSendError> {
		let socket = self
			.state
			.lock()
			.connections
			.get(&id)
			.map(|connection| connection.socket.clone())
			.ok_or(SocketSendError::Disconnected)?;
		send_value_async(
			&socket,
			&cdp_reply(command.id, command.session_id.as_deref(), "result", result),
		)
		.await
	}

	async fn emit_async(
		&self,
		id: u64,
		method: &str,
		params: Value,
		session: Option<Str>,
	) -> Result<(), SocketSendError> {
		let socket = self
			.state
			.lock()
			.connections
			.get(&id)
			.map(|connection| connection.socket.clone())
			.ok_or(SocketSendError::Disconnected)?;
		send_value_async(&socket, &cdp_event(method, params, session.as_deref())).await
	}
}

#[derive(Deserialize)]
struct CreateTabResult {
	tab: TabSnapshot,
}

fn reject_pending(state: &mut BridgeState, error: RpcError) {
	for (_, pending) in state.pending_rpc.drain() {
		let _ = pending.reply.send(Err(error.clone()));
	}
}
fn reset_attaching(tab: &mut TabState) {
	tab.attach_epoch += 1;
	tab.attaching = None;
}
fn reset_detaching(tab: &mut TabState) {
	tab.detach_epoch += 1;
	tab.detaching = None;
}
fn reset_runtime(tab: &mut TabState) {
	tab.runtime_contexts.clear();
	tab.root_runtime_enabled = false;
	tab.root_runtime_enabling = None;
	tab.root_runtime_cycle += 1;
	tab.runtime_generation += 1;
}
fn reset_all_runtime(state: &mut BridgeState) {
	for tab in state.tabs.values_mut() {
		reset_runtime(tab);
	}
	for connection in state.connections.values_mut() {
		for session in connection.sessions.values_mut() {
			session.runtime_contexts.clear();
		}
	}
}
fn reset_group_drain(state: &mut BridgeState) {
	state.group_generation += 1;
	state.group_queue.clear();
	state.group_draining = false;
	for tab in state.tabs.values_mut() {
		tab.grouping = false;
	}
}
fn reset_all_grouping(state: &mut BridgeState) {
	reset_group_drain(state);
	for tab in state.tabs.values_mut() {
		tab.grouped = false;
		tab.omp_group_id = None;
	}
}
fn eligible(tab: &TabState) -> bool {
	if tab.banned {
		return false;
	}
	let Some((scheme, _)) = tab.url.split_once(':') else {
		return true;
	};
	![
		"chrome",
		"devtools",
		"edge",
		"view-source",
		"chrome-extension",
		"chrome-untrusted",
		"chrome-search",
	]
	.iter()
	.any(|ineligible| scheme.eq_ignore_ascii_case(ineligible))
}
fn tab_target_id(id: i64) -> String {
	format!("TAB{id}")
}
fn page_target_id(id: i64) -> String {
	format!("PAGE{id}")
}
fn parse_target_id(raw: &str) -> Option<(SessionKind, i64)> {
	fn parse_id(raw: &str) -> Option<i64> {
		(!raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()))
			.then(|| raw.parse().ok())
			.flatten()
	}

	raw.strip_prefix("TAB")
		.and_then(parse_id)
		.map(|id| (SessionKind::Tab, id))
		.or_else(|| {
			raw.strip_prefix("PAGE")
				.and_then(parse_id)
				.map(|id| (SessionKind::Page, id))
		})
}
fn tab_info(tab: &TabState, attached: bool) -> Value {
	json!({"targetId":tab_target_id(tab.tab_id),"type":"tab","title":tab.title,"url":if tab.url.is_empty(){"about:blank"}else{tab.url.as_str()},"attached":attached,"canAccessOpener":false})
}
fn page_info(tab: &TabState, attached: bool) -> Value {
	json!({"targetId":page_target_id(tab.tab_id),"type":"page","title":tab.title,"url":if tab.url.is_empty(){"about:blank"}else{tab.url.as_str()},"attached":attached,"canAccessOpener":false})
}
fn upsert_locked(state: &mut BridgeState, snapshot: TabSnapshot) {
	let tab_id = snapshot.tab_id;
	if let Some(tab) = state.tabs.get_mut(&tab_id) {
		if tab.url != snapshot.url {
			tab.banned = false;
		}
		if tab.grouped && tab.omp_group_id.is_some_and(|id| snapshot.group_id != id) {
			tab.grouped = false;
			tab.group_opt_out = true;
		}
		tab.update(snapshot);
	} else {
		state.tabs.insert(tab_id, TabState::new(snapshot));
		state.tab_order.push(tab_id);
	}
}
fn emit_locked(state: &BridgeState, id: u64, method: &str, params: Value, session: Option<Str>) {
	if let Some(connection) = state.connections.get(&id) {
		send_value(&connection.socket, &cdp_event(method, params, session.as_deref()));
	}
}
fn cdp_reply(id: u64, session: Option<&str>, field: &'static str, payload: Value) -> Value {
	let mut message = Map::new();
	message.insert("id".to_owned(), Value::from(id));
	if let Some(session) = session {
		message.insert("sessionId".to_owned(), Value::from(session));
	}
	message.insert(field.to_owned(), payload);
	Value::Object(message)
}
fn cdp_event(method: &str, params: Value, session: Option<&str>) -> Value {
	let mut message = Map::new();
	if let Some(session) = session {
		message.insert("sessionId".to_owned(), Value::from(session));
	}
	message.insert("method".to_owned(), Value::from(method));
	message.insert("params".to_owned(), params);
	Value::Object(message)
}
fn send_json<T: Serialize>(socket: &SocketSender, value: &T) -> Result<(), SocketSendError> {
	let text = serde_json::to_string(value).map_err(|_| SocketSendError::Encode)?;
	socket.send(Message::Text(text.into()))
}
fn send_value(socket: &SocketSender, value: &Value) {
	let _ = send_json(socket, value);
}
async fn send_value_async(socket: &SocketSender, value: &Value) -> Result<(), SocketSendError> {
	let text = serde_json::to_string(value).map_err(|_| SocketSendError::Encode)?;
	socket.send_async(Message::Text(text.into())).await
}
fn socket_rpc_error(error: SocketSendError) -> RpcError {
	match error {
		SocketSendError::Encode => {
			RpcError::Remote(Str::new_static("socket message could not be encoded"))
		},
		SocketSendError::Full | SocketSendError::Disconnected => RpcError::Disconnected,
	}
}
fn rpc_error_message(error: &RpcError) -> &str {
	match error {
		RpcError::Replaced => "relay extension was replaced",
		RpcError::Disconnected => "relay extension is not connected",
		RpcError::Timeout => "extension rpc timed out",
		RpcError::Remote(message) => message.as_str(),
	}
}

fn retract_tab_locked(state: &mut BridgeState, tab_id: i64) {
	let Some(tab) = state.tabs.get_mut(&tab_id) else {
		return;
	};
	let announced = tab.announced;
	tab.announced = false;
	let real_sessions = tab.real_sessions.drain().collect::<Vec<_>>();
	for session in real_sessions {
		state.real_session_tabs.remove(&session);
	}
	for connection in state.connections.values_mut() {
		let tab_sessions = connection
			.sessions
			.iter()
			.filter_map(|(id, session)| {
				(session.tab_id == tab_id && session.kind == SessionKind::Tab).then(|| id.clone())
			})
			.collect::<Vec<_>>();
		let page_sessions = connection
			.sessions
			.iter()
			.filter_map(|(id, session)| {
				(session.tab_id == tab_id && session.kind == SessionKind::Page).then(|| id.clone())
			})
			.collect::<Vec<_>>();
		for page in page_sessions {
			connection.sessions.remove(&page);
			send_value(
				&connection.socket,
				&cdp_event(
					"Target.detachedFromTarget",
					json!({"sessionId":page,"targetId":page_target_id(tab_id)}),
					tab_sessions.first().map(Str::as_str),
				),
			);
		}
		for tab_session in tab_sessions {
			connection.sessions.remove(&tab_session);
			send_value(
				&connection.socket,
				&json!({"method":"Target.detachedFromTarget","params":{"sessionId":tab_session,"targetId":tab_target_id(tab_id)}}),
			);
		}
		if connection.discover && announced {
			send_value(
				&connection.socket,
				&json!({"method":"Target.targetDestroyed","params":{"targetId":page_target_id(tab_id)}}),
			);
			send_value(
				&connection.socket,
				&json!({"method":"Target.targetDestroyed","params":{"targetId":tab_target_id(tab_id)}}),
			);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn socket_pair(capacity: usize) -> (SocketSender, flume::Receiver<Message>) {
		let (output, receiver) = flume::bounded(capacity);
		(SocketSender { output, failed: CancellationToken::new() }, receiver)
	}

	#[test]
	fn relay_endpoint_classification_supports_loopback_ipv4_localhost_ipv6_and_remote() {
		let ipv4 = parse_relay_endpoint("http://127.0.0.1:9224").expect("IPv4 endpoint");
		assert_eq!(ipv4.auto_bind, Some(IpAddr::V4(Ipv4Addr::LOCALHOST)));
		let localhost = parse_relay_endpoint("http://localhost:9224").expect("localhost endpoint");
		assert_eq!(localhost.auto_bind, Some(IpAddr::V4(Ipv4Addr::LOCALHOST)));
		assert!(!localhost.addresses.is_empty());
		let ipv6 = parse_relay_endpoint("http://[::1]:9224").expect("IPv6 endpoint");
		assert_eq!(ipv6.auto_bind, Some(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)));
		assert!(ipv6.addresses.iter().any(SocketAddr::is_ipv6));
		let remote = parse_relay_endpoint("http://192.0.2.1:9224").expect("remote endpoint");
		assert_eq!(remote.auto_bind, None);
	}

	#[test]
	fn relay_server_rejects_non_loopback_binds() {
		let error = RelayServer::start(RelayOptions {
			bind: IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, 1)),
			..RelayOptions::default()
		})
		.err()
		.expect("remote bind must be rejected");
		assert!(matches!(error, RelayError::NonLoopbackBind { .. }));
	}

	#[test]
	fn ipv6_loopback_relay_accepts_probes_and_consumer_leases() {
		let relay = match RelayServer::start(RelayOptions {
			bind: IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
			port: 0,
			..RelayOptions::default()
		}) {
			Ok(relay) => relay,
			Err(RelayError::Bind { source, .. })
				if source.kind() == std::io::ErrorKind::AddrNotAvailable =>
			{
				return;
			},
			Err(error) => panic!("IPv6 loopback relay: {error}"),
		};
		let endpoint = format!("http://[::1]:{}", relay.port());
		assert!(probe_relay_server(&endpoint));
		let _lease =
			acquire_relay_lease(&endpoint, Duration::from_secs(1)).expect("IPv6 consumer lease");
	}

	#[test]
	fn managed_relay_stays_up_until_its_last_consumer_lease_closes() {
		let relay = RelayServer::start(RelayOptions {
			port: 0,
			managed: true,
			..RelayOptions::default()
		})
		.expect("managed relay");
		let endpoint = format!("http://127.0.0.1:{}", relay.port());
		let first =
			acquire_relay_lease(&endpoint, Duration::from_secs(1)).expect("first consumer lease");
		let second =
			acquire_relay_lease(&endpoint, Duration::from_secs(1)).expect("second consumer lease");
		let count_deadline = Instant::now() + Duration::from_secs(1);
		while relay.leases.active.load(Ordering::Acquire) != 2 && Instant::now() < count_deadline {
			thread::sleep(Duration::from_millis(5));
		}
		assert_eq!(relay.leases.active.load(Ordering::Acquire), 2);
		drop(first);
		thread::sleep(Duration::from_millis(20));
		assert!(!relay.managed_shutdown_requested());
		drop(second);
		let shutdown_deadline = Instant::now() + Duration::from_secs(1);
		while !relay.managed_shutdown_requested() && Instant::now() < shutdown_deadline {
			thread::sleep(Duration::from_millis(5));
		}
		assert!(relay.managed_shutdown_requested());
	}

	#[test]
	fn manual_relay_remains_signal_owned_after_leases_close() {
		let relay =
			RelayServer::start(RelayOptions { port: 0, ..RelayOptions::default() })
				.expect("manual relay");
		let endpoint = format!("http://127.0.0.1:{}", relay.port());
		let lease =
			acquire_relay_lease(&endpoint, Duration::from_secs(1)).expect("consumer lease");
		drop(lease);
		thread::sleep(Duration::from_millis(20));
		assert!(!relay.managed_shutdown_requested());
		assert!(probe_relay_server(&endpoint));
	}

	#[test]
	fn relay_probe_subprocess_helper() {
		let Ok(endpoint) = std::env::var("OMP_RELAY_PROBE_HELPER_URL") else {
			return;
		};
		assert!(probe_relay_server(&endpoint));
	}

	#[test]
	fn relay_probe_bypasses_proxy_environment() {
		let relay =
			RelayServer::start(RelayOptions { port: 0, ..RelayOptions::default() })
				.expect("relay");
		let endpoint = format!("http://127.0.0.1:{}", relay.port());
		let proxy = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("unused proxy listener");
		let proxy_url = format!("http://{}", proxy.local_addr().expect("proxy address"));
		let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
			.args(["relay_probe_subprocess_helper", "--nocapture"])
			.env("OMP_RELAY_PROBE_HELPER_URL", endpoint)
			.env("HTTP_PROXY", &proxy_url)
			.env("http_proxy", &proxy_url)
			.env("NO_PROXY", "")
			.env("no_proxy", "")
			.status()
			.expect("probe helper");
		assert!(status.success());
	}

	#[test]
	fn validates_discovery_host_authority() {
		let mut headers = HeaderMap::new();
		headers.insert(header::HOST, "100.100.92.97:12803".parse().unwrap());
		assert_eq!(websocket_authority(&headers, 9224), "100.100.92.97:12803");
		headers.insert(header::HOST, "bad/host@evil".parse().unwrap());
		assert_eq!(websocket_authority(&headers, 9224), "127.0.0.1:9224");
	}

	#[test]
	fn hides_ineligible_browser_pages() {
		let mut tab = TabState::new(TabSnapshot {
			tab_id:    1,
			url:       Str::new_static("chrome://settings"),
			title:     Str::default(),
			active:    false,
			window_id: 1,
			pinned:    false,
			group_id:  -1,
		});
		assert!(!eligible(&tab));
		tab.url = Str::new_static("https://example.com");
		assert!(eligible(&tab));
	}

	#[test]
	fn target_ids_round_trip() {
		assert!(matches!(parse_target_id("TAB42"), Some((SessionKind::Tab, 42))));
		assert!(matches!(parse_target_id("PAGE7"), Some((SessionKind::Page, 7))));
		assert!(parse_target_id("PAGE").is_none());
		assert!(parse_target_id("PAGE-1").is_none());
		assert!(parse_target_id("TAB+1").is_none());
	}

	#[test]
	fn slow_socket_overflow_fails_the_connection_without_reordering() {
		let (socket, messages) = socket_pair(1);
		assert_eq!(socket.send(Message::Text("first".into())), Ok(()));
		assert_eq!(socket.send(Message::Text("overflow".into())), Err(SocketSendError::Full));
		assert!(socket.failed.is_cancelled());
		assert_eq!(
			socket.send(Message::Text("after failure".into())),
			Err(SocketSendError::Disconnected)
		);
		assert!(matches!(
			messages.try_recv(),
			Ok(Message::Text(text)) if text.as_str() == "first"
		));
		assert!(messages.try_recv().is_err());
	}

	#[tokio::test]
	async fn discovery_backpressures_without_overflowing_a_small_socket_queue() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (cdp, messages) = socket_pair(4);
		let connection = bridge.cdp_connected(cdp);
		{
			let mut state = bridge.state.lock();
			for tab_id in 1..=40 {
				state.tabs.insert(
					tab_id,
					TabState::new(TabSnapshot {
						tab_id,
						url: Str::new(format!("https://example.com/{tab_id}")),
						title: Str::default(),
						active: false,
						window_id: 1,
						pinned: false,
						group_id: -1,
					}),
				);
				state.tab_order.push(tab_id);
			}
		}
		let discover = tokio::spawn({
			let bridge = Arc::clone(&bridge);
			async move {
				bridge
					.cdp_message(
						connection,
						r#"{"id":1,"method":"Target.setDiscoverTargets","params":{}}"#,
					)
					.await;
			}
		});
		let mut received = Vec::new();
		for _ in 0..81 {
			let message = time::timeout(Duration::from_secs(1), messages.recv_async())
				.await
				.expect("discovery message")
				.expect("CDP channel");
			received.push(message);
		}
		discover.await.unwrap();
		assert!(matches!(received.last(), Some(Message::Text(text)) if {
			serde_json::from_str::<Value>(text.as_str())
				.is_ok_and(|message| message["id"] == 1)
		}));
		assert!(
			!bridge.state.lock().connections[&connection]
				.socket
				.failed
				.is_cancelled()
		);
	}

	#[test]
	fn shutdown_queues_detach_for_each_live_attachment() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (extension, messages) = socket_pair(4);
		let socket_id = bridge.ext_connected(extension);
		let mut tab = TabState::new(TabSnapshot {
			tab_id:    1,
			url:       Str::new_static("https://example.com/"),
			title:     Str::new_static("Example"),
			active:    false,
			window_id: 1,
			pinned:    false,
			group_id:  -1,
		});
		tab.attached = true;
		bridge.state.lock().tabs.insert(1, tab);
		let mut replies = bridge.begin_shutdown_detach(MAX_PARALLEL_SOCKET_RPCS);
		assert_eq!(replies.len(), 1);
		let message = messages.try_recv().expect("shutdown detach request");
		let Message::Text(message) = message else {
			panic!("expected shutdown detach RPC")
		};
		let message: Value = serde_json::from_str(message.as_str()).unwrap();
		assert_eq!(message["op"], "detach");
		assert_eq!(message["tabId"], 1);
		bridge.ext_message(
			socket_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": message["id"].as_u64().unwrap(),
				"ok": true, "result": {}
			}))
			.unwrap(),
		);
		assert!(matches!(replies[0].try_recv(), Ok(Ok(_))));
	}

	#[test]
	fn relay_start_reports_listener_bind_failure() {
		let occupied = StdTcpListener::bind(("127.0.0.1", 0)).unwrap();
		let port = occupied.local_addr().unwrap().port();
		let Err(error) = RelayServer::start(RelayOptions { port, ..RelayOptions::default() }) else {
			panic!("second listener unexpectedly started")
		};
		assert!(matches!(
			error,
			RelayError::Bind { source, .. }
				if source.kind() == std::io::ErrorKind::AddrInUse
		));
	}

	#[test]
	fn replacing_extension_rejects_pending_rpcs_without_banning_state() {
		let bridge = Arc::new(RelayBridge::new(true, false));
		let (first, first_messages) = socket_pair(4);
		bridge.ext_connected(first);
		let (reply, mut result) = oneshot::channel();
		{
			let mut state = bridge.state.lock();
			state.pending_rpc.insert(7, PendingRpc { reply });
			let mut tab = TabState::new(TabSnapshot {
				tab_id:    1,
				url:       Str::new_static("https://example.com/"),
				title:     Str::new_static("Example"),
				active:    false,
				window_id: 1,
				pinned:    false,
				group_id:  42,
			});
			tab.grouped = true;
			tab.grouping = true;
			tab.omp_group_id = Some(42);
			state.tabs.insert(1, tab);
			state.group_queue.push(1);
			state.group_draining = true;
		}
		let (second, _second_messages) = socket_pair(4);
		bridge.ext_connected(second);
		assert!(matches!(result.try_recv(), Ok(Err(RpcError::Replaced))));
		assert!(matches!(first_messages.try_recv(), Ok(Message::Close(_))));
		let state = bridge.state.lock();
		let tab = &state.tabs[&1];
		assert!(!tab.banned);
		assert!(tab.grouped);
		assert_eq!(tab.omp_group_id, Some(42));
		assert!(!tab.grouping);
		assert!(state.group_queue.is_empty());
		assert!(!state.group_draining);
	}

	#[tokio::test]
	async fn replacement_attach_attempt_cannot_clear_its_successor() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (extension, extension_messages) = socket_pair(4);
		let extension_id = bridge.ext_connected(extension);
		let hello = serde_json::to_string(&json!({
			"t": "hello",
			"userAgent": "test",
			"browserVersion": "Chrome/151.0.0.0",
			"tabs": [{
				"tabId": 1, "url": "https://example.com/", "title": "Example",
				"active": false, "windowId": 1, "pinned": false, "groupId": -1
			}],
			"attachedTabIds": []
		}))
		.unwrap();
		bridge.ext_message(extension_id, &hello);
		let attaching = tokio::spawn({
			let bridge = Arc::clone(&bridge);
			async move { bridge.ensure_attached(1).await }
		});
		let first = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("first attach request")
			.expect("extension channel");
		let Message::Text(first) = first else {
			panic!("expected first attach RPC")
		};
		let first: Value = serde_json::from_str(first.as_str()).unwrap();
		assert_eq!(first["op"], "attach");

		let (replacement, replacement_messages) = socket_pair(4);
		let replacement_id = bridge.ext_connected(replacement);
		bridge.ext_message(replacement_id, &hello);
		let second = time::timeout(Duration::from_secs(1), replacement_messages.recv_async())
			.await
			.expect("replacement attach request")
			.expect("replacement extension channel");
		let Message::Text(second) = second else {
			panic!("expected replacement attach RPC")
		};
		let second: Value = serde_json::from_str(second.as_str()).unwrap();
		assert_eq!(second["op"], "attach");
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": second["id"].as_u64().unwrap(),
				"ok": true, "result": {}
			}))
			.unwrap(),
		);
		assert!(attaching.await.unwrap());
		let state = bridge.state.lock();
		let tab = &state.tabs[&1];
		assert!(tab.attached);
		assert!(!tab.banned);
		assert!(tab.attaching.is_none());
	}

	#[tokio::test]
	async fn reconnect_restores_an_attachment_held_by_a_live_session() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (extension, _extension_messages) = socket_pair(4);
		let extension_id = bridge.ext_connected(extension);
		let hello = |attached: &[i64]| {
			serde_json::to_string(&json!({
				"t": "hello",
				"userAgent": "test",
				"browserVersion": "Chrome/151.0.0.0",
				"tabs": [{
					"tabId": 1, "url": "https://example.com/", "title": "Example",
					"active": false, "windowId": 1, "pinned": false, "groupId": -1
				}],
				"attachedTabIds": attached
			}))
			.unwrap()
		};
		bridge.ext_message(extension_id, &hello(&[]));
		let (cdp, messages) = socket_pair(4);
		let connection = bridge.cdp_connected(cdp);
		let session = bridge
			.mint_session(connection, SessionKind::Page, 1)
			.expect("live connection");
		{
			let mut state = bridge.state.lock();
			let params = json!({"context":{"id":17}}).as_object().unwrap().clone();
			state.tabs.get_mut(&1).unwrap().attached = true;
			state.tabs.get_mut(&1).unwrap().root_runtime_enabled = true;
			state
				.tabs
				.get_mut(&1)
				.unwrap()
				.runtime_contexts
				.insert(17, params);
			let session = state
				.connections
				.get_mut(&connection)
				.unwrap()
				.sessions
				.get_mut(&session)
				.unwrap();
			session.runtime_state = RuntimeState::Enabled;
			session.runtime_contexts.insert(17);
		}

		bridge.ext_closed(extension_id);
		let (replacement, replacement_messages) = socket_pair(4);
		let replacement_id = bridge.ext_connected(replacement);
		bridge.ext_message(replacement_id, &hello(&[]));
		let attach = time::timeout(Duration::from_secs(1), replacement_messages.recv_async())
			.await
			.expect("reattach request")
			.expect("replacement extension channel");
		let Message::Text(attach) = attach else {
			panic!("expected reattach RPC")
		};
		let attach: Value = serde_json::from_str(attach.as_str()).unwrap();
		assert_eq!(attach["op"], "attach");
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": attach["id"].as_u64().unwrap(),
				"ok": true, "result": {}
			}))
			.unwrap(),
		);
		let disable_runtime =
			time::timeout(Duration::from_secs(1), replacement_messages.recv_async())
				.await
				.expect("Runtime.disable restore request")
				.expect("replacement extension channel");
		let Message::Text(disable_runtime) = disable_runtime else {
			panic!("expected Runtime.disable restore RPC")
		};
		let disable_runtime: Value = serde_json::from_str(disable_runtime.as_str()).unwrap();
		assert_eq!(disable_runtime["method"], "Runtime.disable");
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": disable_runtime["id"].as_u64().unwrap(),
				"ok": true, "result": {}
			}))
			.unwrap(),
		);
		let enable_runtime = time::timeout(Duration::from_secs(1), replacement_messages.recv_async())
			.await
			.expect("Runtime.enable restore request")
			.expect("replacement extension channel");
		let Message::Text(enable_runtime) = enable_runtime else {
			panic!("expected Runtime.enable restore RPC")
		};
		let enable_runtime: Value = serde_json::from_str(enable_runtime.as_str()).unwrap();
		assert_eq!(enable_runtime["method"], "Runtime.enable");
		bridge.on_cdp_event(
			1,
			None,
			Str::new_static("Runtime.executionContextCreated"),
			Some(json!({"context":{"id":18}}).as_object().unwrap().clone()),
		);
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": enable_runtime["id"].as_u64().unwrap(),
				"ok": true, "result": {}
			}))
			.unwrap(),
		);
		let context = time::timeout(Duration::from_secs(1), messages.recv_async())
			.await
			.expect("refreshed Runtime context")
			.expect("CDP channel");
		let Message::Text(context) = context else {
			panic!("expected Runtime context event")
		};
		let context: Value = serde_json::from_str(context.as_str()).unwrap();
		assert_eq!(context["params"]["context"]["id"], 18);
		let state = bridge.state.lock();
		let session = &state.connections[&connection].sessions[&session];
		assert!(state.tabs[&1].attached);
		assert!(session.runtime_state == RuntimeState::Enabled);
		assert!(!session.runtime_contexts.contains(&17));
		assert!(session.runtime_contexts.contains(&18));
	}

	#[tokio::test]
	async fn reconnect_reissues_an_unconfirmed_managed_detach() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (extension, extension_messages) = socket_pair(4);
		let extension_id = bridge.ext_connected(extension);
		let hello = |attached: &[i64]| {
			serde_json::to_string(&json!({
				"t": "hello",
				"userAgent": "test",
				"browserVersion": "Chrome/151.0.0.0",
				"tabs": [{
					"tabId": 1, "url": "https://example.com/", "title": "Example",
					"active": false, "windowId": 1, "pinned": false, "groupId": -1
				}],
				"attachedTabIds": attached
			}))
			.unwrap()
		};
		bridge.ext_message(extension_id, &hello(&[]));
		let (cdp, _messages) = socket_pair(4);
		let connection = bridge.cdp_connected(cdp);
		let session = bridge
			.mint_session(connection, SessionKind::Page, 1)
			.expect("live connection");
		bridge.state.lock().tabs.get_mut(&1).unwrap().attached = true;
		bridge.release_session(connection, &session, None);
		let first = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("initial detach request")
			.expect("extension channel");
		let Message::Text(first) = first else {
			panic!("expected initial detach RPC")
		};
		let first: Value = serde_json::from_str(first.as_str()).unwrap();
		assert_eq!(first["op"], "detach");

		bridge.ext_closed(extension_id);
		let (replacement, replacement_messages) = socket_pair(4);
		let replacement_id = bridge.ext_connected(replacement);
		bridge.ext_message(replacement_id, &hello(&[1]));
		let second = time::timeout(Duration::from_secs(1), replacement_messages.recv_async())
			.await
			.expect("replacement detach request")
			.expect("replacement extension channel");
		let Message::Text(second) = second else {
			panic!("expected replacement detach RPC")
		};
		let second: Value = serde_json::from_str(second.as_str()).unwrap();
		assert_eq!(second["op"], "detach");
		assert_eq!(second["tabId"], 1);
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": second["id"].as_u64().unwrap(),
				"ok": true, "result": {}
			}))
			.unwrap(),
		);
		time::timeout(Duration::from_secs(1), async {
			loop {
				let pending = bridge.state.lock().tabs[&1].detach_pending;
				if !pending {
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.expect("managed detach completion");
	}

	#[tokio::test]
	async fn runtime_events_reach_default_sessions_but_respect_explicit_disable() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (cdp, messages) = socket_pair(8);
		let connection = bridge.cdp_connected(cdp);
		let session = bridge
			.mint_session(connection, SessionKind::Page, 1)
			.expect("live connection");
		bridge.state.lock().tabs.insert(
			1,
			TabState::new(TabSnapshot {
				tab_id:    1,
				url:       Str::new_static("https://example.com/"),
				title:     Str::new_static("Example"),
				active:    false,
				window_id: 1,
				pinned:    false,
				group_id:  -1,
			}),
		);
		bridge.on_cdp_event(
			1,
			None,
			Str::new_static("Runtime.executionContextCreated"),
			Some(json!({"context":{"id":17}}).as_object().unwrap().clone()),
		);
		let first = messages
			.recv_async()
			.await
			.expect("default-session Runtime event");
		let Message::Text(first) = first else {
			panic!("expected Runtime event")
		};
		let first: Value = serde_json::from_str(first.as_str()).unwrap();
		assert_eq!(first["sessionId"], session.as_str());
		assert_eq!(first["params"]["context"]["id"], 17);

		Arc::clone(&bridge)
			.cdp_message(
				connection,
				&serde_json::to_string(&json!({
					"id": 9, "sessionId": session, "method": "Runtime.disable"
				}))
				.unwrap(),
			)
			.await;
		let disabled = messages.recv_async().await.expect("disable response");
		let Message::Text(disabled) = disabled else {
			panic!("expected disable response")
		};
		let disabled: Value = serde_json::from_str(disabled.as_str()).unwrap();
		assert_eq!(disabled["id"], 9);

		bridge.on_cdp_event(
			1,
			None,
			Str::new_static("Runtime.executionContextCreated"),
			Some(json!({"context":{"id":18}}).as_object().unwrap().clone()),
		);
		assert!(
			time::timeout(Duration::from_millis(10), messages.recv_async())
				.await
				.is_err()
		);
	}

	#[tokio::test]
	async fn runtime_disable_wins_while_duplicate_enable_awaits_its_original_cycle() {
		let bridge = Arc::new(RelayBridge::new(false, false));
		let (extension, extension_messages) = socket_pair(8);
		let extension_id = bridge.ext_connected(extension);
		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "hello",
				"userAgent": "test",
				"browserVersion": "Chrome/151.0.0.0",
				"tabs": [{
					"tabId": 1, "url": "https://example.com/", "title": "Example",
					"active": false, "windowId": 1, "pinned": false, "groupId": -1
				}],
				"attachedTabIds": []
			}))
			.unwrap(),
		);
		let (cdp, messages) = socket_pair(8);
		let connection = bridge.cdp_connected(cdp);
		let session = bridge
			.mint_session(connection, SessionKind::Page, 1)
			.expect("live connection");
		let enable = serde_json::to_string(&json!({
			"id": 1, "sessionId": session, "method": "Runtime.enable"
		}))
		.unwrap();
		let enabling = tokio::spawn({
			let bridge = Arc::clone(&bridge);
			async move {
				bridge.cdp_message(connection, &enable).await;
			}
		});

		let disable_root = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("root Runtime.disable request")
			.expect("extension channel");
		let Message::Text(disable_root) = disable_root else {
			panic!("expected root Runtime.disable RPC")
		};
		let disable_root: Value = serde_json::from_str(disable_root.as_str()).unwrap();
		assert_eq!(disable_root["method"], "Runtime.disable");
		let disable_root_id = disable_root["id"].as_u64().unwrap();
		let duplicate_enable = serde_json::to_string(&json!({
			"id": 2, "sessionId": session, "method": "Runtime.enable"
		}))
		.unwrap();
		let duplicate = tokio::spawn({
			let bridge = Arc::clone(&bridge);
			async move {
				bridge.cdp_message(connection, &duplicate_enable).await;
			}
		});
		time::timeout(Duration::from_secs(1), async {
			loop {
				let waiting = {
					let state = bridge.state.lock();
					state.connections[&connection].sessions[&session]
						.runtime_waiters
						.values()
						.any(|waiters| !waiters.is_empty())
				};
				if waiting {
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.expect("duplicate Runtime.enable joined the original cycle");
		Arc::clone(&bridge)
			.cdp_message(
				connection,
				&serde_json::to_string(&json!({
					"id": 3, "sessionId": session, "method": "Runtime.disable"
				}))
				.unwrap(),
			)
			.await;
		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": disable_root_id, "ok": true, "result": {}
			}))
			.unwrap(),
		);

		let enable_root = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("root Runtime.enable request")
			.expect("extension channel");
		let Message::Text(enable_root) = enable_root else {
			panic!("expected root Runtime.enable RPC")
		};
		let enable_root: Value = serde_json::from_str(enable_root.as_str()).unwrap();
		assert_eq!(enable_root["method"], "Runtime.enable");
		let enable_root_id = enable_root["id"].as_u64().unwrap();
		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": enable_root_id, "ok": true, "result": {}
			}))
			.unwrap(),
		);
		enabling.await.unwrap();
		duplicate.await.unwrap();

		let responses = messages
			.try_iter()
			.filter_map(|message| {
				let Message::Text(text) = message else {
					return None;
				};
				serde_json::from_str::<Value>(text.as_str()).ok()
			})
			.collect::<Vec<_>>();
		for id in [1, 2, 3] {
			assert!(
				responses
					.iter()
					.any(|response| response["id"] == id && response.get("result").is_some())
			);
		}
		let state = bridge.state.lock();
		let session = &state.connections[&connection].sessions[&session];
		assert!(session.runtime_state == RuntimeState::Disabled);
		assert!(session.runtime_enabling.is_none());
		assert!(session.runtime_waiters.is_empty());
		assert!(session.runtime_contexts.is_empty());
	}

	#[tokio::test]
	async fn completed_group_is_ungrouped_when_its_last_claim_disappeared_inflight() {
		let bridge = Arc::new(RelayBridge::new(true, false));
		let (extension, extension_messages) = socket_pair(8);
		let extension_id = bridge.ext_connected(extension);
		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "hello",
				"userAgent": "test",
				"browserVersion": "Chrome/151.0.0.0",
				"tabs": [{
					"tabId": 1, "url": "https://example.com/", "title": "Example",
					"active": false, "windowId": 1, "pinned": false, "groupId": -1
				}],
				"attachedTabIds": []
			}))
			.unwrap(),
		);
		let (cdp, _messages) = socket_pair(4);
		let connection = bridge.cdp_connected(cdp);
		bridge.claim_tab(connection, 1);
		let grouped = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("group request")
			.expect("extension channel");
		let Message::Text(grouped) = grouped else {
			panic!("expected group RPC")
		};
		let grouped: Value = serde_json::from_str(grouped.as_str()).unwrap();
		assert_eq!(grouped["op"], "group");
		bridge.cdp_closed(connection);
		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": grouped["id"].as_u64().unwrap(),
				"ok": true, "result": {"grouped": {"1": 42}}
			}))
			.unwrap(),
		);
		let ungrouped = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("ungroup request")
			.expect("extension channel");
		let Message::Text(ungrouped) = ungrouped else {
			panic!("expected ungroup RPC")
		};
		let ungrouped: Value = serde_json::from_str(ungrouped.as_str()).unwrap();
		assert_eq!(ungrouped["op"], "ungroup");
		assert_eq!(ungrouped["tabIds"], json!([1]));
	}

	#[tokio::test]
	async fn groups_only_claimed_tabs_and_regroups_after_socket_replacement() {
		let bridge = Arc::new(RelayBridge::new(true, false));
		let (extension, extension_messages) = socket_pair(8);
		let extension_id = bridge.ext_connected(extension);
		assert!(!bridge.ready.load(Ordering::Acquire), "socket open is not a completed handshake");
		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "hello",
				"userAgent": "test",
				"browserVersion": "Chrome/151.0.0.0",
				"tabs": [{
					"tabId": 1, "url": "https://example.com/", "title": "Example",
					"active": false, "windowId": 1, "pinned": false, "groupId": -1
				}],
				"attachedTabIds": []
			}))
			.unwrap(),
		);
		assert!(bridge.ready.load(Ordering::Acquire), "hello completes discovery readiness");
		assert!(extension_messages.try_recv().is_err(), "hello alone must not group tabs");

		let (cdp, _cdp_messages) = socket_pair(8);
		let connection = bridge.cdp_connected(cdp);
		bridge.claim_tab(connection, 1);
		let first = time::timeout(Duration::from_secs(1), extension_messages.recv_async())
			.await
			.expect("group request")
			.expect("extension channel");
		let Message::Text(first) = first else {
			panic!("expected group RPC")
		};
		let first: Value = serde_json::from_str(first.as_str()).unwrap();
		assert_eq!(first["op"], "group");
		assert_eq!(first["tabIds"], json!([1]));
		let stale_rpc_id = first["id"].as_u64().unwrap();
		let (replacement, replacement_messages) = socket_pair(8);
		let replacement_id = bridge.ext_connected(replacement);
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "hello",
				"userAgent": "test",
				"browserVersion": "Chrome/151.0.0.0",
				"tabs": [{
					"tabId": 1, "url": "https://example.com/", "title": "Example",
					"active": false, "windowId": 1, "pinned": false, "groupId": -1
				}],
				"attachedTabIds": []
			}))
			.unwrap(),
		);
		let regroup = time::timeout(Duration::from_secs(1), replacement_messages.recv_async())
			.await
			.expect("regroup request")
			.expect("replacement extension channel");
		let Message::Text(regroup) = regroup else {
			panic!("expected regroup RPC")
		};
		let regroup: Value = serde_json::from_str(regroup.as_str()).unwrap();
		assert_eq!(regroup["op"], "group");
		assert_eq!(regroup["tabIds"], json!([1]));
		let regroup_rpc_id = regroup["id"].as_u64().unwrap();

		bridge.ext_message(
			extension_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": stale_rpc_id, "ok": true,
				"result": {"grouped": {"1": 41}}
			}))
			.unwrap(),
		);
		bridge.ext_message(
			replacement_id,
			&serde_json::to_string(&json!({
				"t": "rpcResult", "id": regroup_rpc_id, "ok": true,
				"result": {"grouped": {"1": 42}}
			}))
			.unwrap(),
		);
		time::timeout(Duration::from_secs(1), async {
			loop {
				let grouped = {
					let state = bridge.state.lock();
					state.tabs[&1].omp_group_id == Some(42)
				};
				if grouped {
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.expect("replacement grouping completion");
		let state = bridge.state.lock();
		let tab = &state.tabs[&1];
		assert!(tab.grouped);
		assert_eq!(tab.omp_group_id, Some(42));
	}
}
