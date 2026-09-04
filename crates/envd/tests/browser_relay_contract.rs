//! End-to-end native browser-relay protocol, security, and lifetime contracts.

use std::{
	collections::VecDeque,
	io::{BufRead as _, BufReader, Read as _, Write as _},
	net::{TcpListener, TcpStream},
	process::{Child, Command, ExitStatus, Stdio},
	sync::{
		Arc,
		atomic::{AtomicU64, AtomicUsize, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use futures::{SinkExt as _, StreamExt as _};
use omp_core::Str;
use omp_envd::{
	browser_daemon::{BrowserSettings, resolve_relay},
	browser_relay::{RelayOptions, RelayServer, acquire_relay_lease, probe_relay_server},
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream, connect_async,
	tungstenite::{
		Error as WsError, Message,
		client::IntoClientRequest as _,
		http::{HeaderValue, header::ORIGIN},
	},
};

const IO_BOUND: Duration = Duration::from_secs(2);
const CHILD_BOUND: Duration = Duration::from_secs(5);
const QUIET_BOUND: Duration = Duration::from_millis(250);
const RPC_TIMEOUT_BOUND: Duration = Duration::from_secs(22);
static COMMAND_ID: AtomicU64 = AtomicU64::new(100);

type ClientSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Peer {
	socket:   ClientSocket,
	buffered: VecDeque<Value>,
}

impl Peer {
	async fn send(&mut self, value: Value) {
		self
			.socket
			.send(Message::Text(value.to_string().into()))
			.await
			.expect("send websocket JSON");
	}

	async fn recv_json_for(&mut self, bound: Duration) -> Value {
		loop {
			let message = tokio::time::timeout(bound, self.socket.next())
				.await
				.expect("bounded websocket receive")
				.expect("websocket remains open")
				.expect("valid websocket frame");
			match message {
				Message::Text(text) => return serde_json::from_str(&text).expect("JSON text frame"),
				Message::Binary(bytes) => {
					return serde_json::from_slice(&bytes).expect("JSON binary frame");
				},
				Message::Ping(bytes) => {
					self
						.socket
						.send(Message::Pong(bytes))
						.await
						.expect("answer relay ping");
				},
				Message::Pong(_) => {},
				Message::Close(frame) => panic!("websocket closed unexpectedly: {frame:?}"),
				Message::Frame(_) => {},
			}
		}
	}

	async fn matching_for(
		&mut self,
		bound: Duration,
		predicate: impl Fn(&Value) -> bool,
	) -> Value {
		if let Some(index) = self.buffered.iter().position(&predicate) {
			return self.buffered.remove(index).expect("buffered match");
		}
		let deadline = Instant::now() + bound;
		loop {
			let remaining = deadline.checked_duration_since(Instant::now()).expect("bounded matching receive");
			let value = self.recv_json_for(remaining).await;
			if predicate(&value) {
				return value;
			}
			self.buffered.push_back(value);
		}
	}

	async fn matching(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
		self.matching_for(IO_BOUND, predicate).await
	}

	async fn rpc(&mut self, op: &str) -> Value {
		self
			.matching(|value| value["t"] == "rpc" && value["op"] == op)
			.await
	}

	async fn reply(&mut self, id: u64) -> Value {
		self.matching(|value| value["id"] == id).await
	}

	async fn reply_for(&mut self, id: u64, bound: Duration) -> Value {
		self.matching_for(bound, |value| value["id"] == id).await
	}

	async fn assert_no_match(&mut self, predicate: impl Fn(&Value) -> bool) {
		assert!(!self.buffered.iter().any(&predicate), "unexpected buffered websocket message");
		let deadline = Instant::now() + QUIET_BOUND;
		loop {
			let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
				return;
			};
			match tokio::time::timeout(remaining, self.socket.next()).await {
				Err(_) => return,
				Ok(Some(Ok(Message::Text(text)))) => {
					let value: Value = serde_json::from_str(&text).expect("JSON text frame");
					assert!(!predicate(&value), "unexpected websocket message: {value}");
					self.buffered.push_back(value);
				},
				Ok(Some(Ok(Message::Binary(bytes)))) => {
					let value: Value = serde_json::from_slice(&bytes).expect("JSON binary frame");
					assert!(!predicate(&value), "unexpected websocket message: {value}");
					self.buffered.push_back(value);
				},
				Ok(Some(Ok(Message::Ping(bytes)))) => {
					self
						.socket
						.send(Message::Pong(bytes))
						.await
						.expect("answer relay ping");
				},
				Ok(Some(Ok(Message::Pong(_)))) => {},
				Ok(Some(Ok(Message::Close(frame)))) => {
					panic!("websocket closed unexpectedly: {frame:?}")
				},
				Ok(Some(Ok(Message::Frame(_)))) => {},
				Ok(Some(Err(error))) => panic!("websocket receive failed: {error}"),
				Ok(None) => panic!("websocket closed unexpectedly"),
			}
		}
	}
}

struct Harness {
	_server: RelayServer,
	port:    u16,
	ext:     Peer,
}

fn reserve_port() -> u16 {
	TcpListener::bind(("127.0.0.1", 0))
		.expect("reserve loopback port")
		.local_addr()
		.expect("reserved address")
		.port()
}

fn wait_child(child: &mut Child, bound: Duration) -> ExitStatus {
	let deadline = Instant::now() + bound;
	loop {
		if let Some(status) = child.try_wait().expect("poll child") {
			return status;
		}
		if Instant::now() >= deadline {
			child.kill().expect("kill timed-out child");
			let _ = child.wait();
			panic!("child process exceeded {bound:?}");
		}
		thread::sleep(Duration::from_millis(5));
	}
}

fn start_server(mut options: RelayOptions) -> RelayServer {
	for _ in 0..16 {
		options.port = reserve_port();
		match RelayServer::start(options.clone()) {
			Ok(server) => return server,
			Err(error) if error.is_addr_in_use() => continue,
			Err(error) => panic!("start relay: {error}"),
		}
	}
	panic!("could not win a reserved loopback port after bounded retries")
}

async fn connect_peer(port: u16, path: &str) -> Peer {
	let (socket, _) = connect_async(format!("ws://127.0.0.1:{port}{path}"))
		.await
		.expect("connect relay websocket");
	Peer { socket, buffered: VecDeque::new() }
}

fn tab(tab_id: i64) -> Value {
	tab_with(tab_id, false, -1)
}

fn tab_with(tab_id: i64, pinned: bool, group_id: i64) -> Value {
	json!({
		"tabId": tab_id,
		"url": format!("https://example.com/{tab_id}"),
		"title": format!("Example {tab_id}"),
		"active": false,
		"windowId": 1,
		"pinned": pinned,
		"groupId": group_id,
	})
}

async fn hello(ext: &mut Peer, tabs: Vec<Value>, attached: &[i64]) {
	ext.send(json!({
		"t": "hello",
		"userAgent": "test-agent",
		"browserVersion": "Chrome/151.0.0.0",
		"tabs": tabs,
		"attachedTabIds": attached,
	}))
	.await;
}

async fn start_harness(group: bool, tabs: Vec<Value>) -> Harness {
	let server = start_server(RelayOptions { group, ..RelayOptions::default() });
	let port = server.port();
	let mut ext = connect_peer(port, "/ext").await;
	hello(&mut ext, tabs, &[]).await;
	let deadline = Instant::now() + IO_BOUND;
	while !server.ready() {
		assert!(Instant::now() < deadline, "extension hello did not make relay ready");
		tokio::task::yield_now().await;
	}
	Harness { _server: server, port, ext }
}

fn next_id() -> u64 {
	COMMAND_ID.fetch_add(1, Ordering::Relaxed)
}

async fn ack(ext: &mut Peer, rpc: &Value, result: Value) {
	ext.send(json!({"t":"rpcResult", "id":rpc["id"], "ok":true, "result":result}))
		.await;
}

async fn nack(ext: &mut Peer, rpc: &Value, error: &str) {
	ext.send(json!({"t":"rpcResult", "id":rpc["id"], "ok":false, "error":error}))
		.await;
}

async fn attach_page(ext: &mut Peer, cdp: &mut Peer, tab_id: i64) -> String {
	let id = next_id();
	cdp.send(json!({
		"id": id,
		"method": "Target.attachToTarget",
		"params": {"targetId": format!("PAGE{tab_id}"), "flatten": true},
	}))
	.await;
	let request = ext.rpc("attach").await;
	assert_eq!(request["tabId"], tab_id);
	ack(ext, &request, json!({})).await;
	cdp.reply(id).await["result"]["sessionId"]
		.as_str()
		.expect("page session id")
		.to_owned()
}

async fn attach_existing_page(cdp: &mut Peer, tab_id: i64) -> String {
	let id = next_id();
	cdp.send(json!({
		"id": id,
		"method": "Target.attachToTarget",
		"params": {"targetId": format!("PAGE{tab_id}"), "flatten": true},
	}))
	.await;
	cdp.reply(id).await["result"]["sessionId"]
		.as_str()
		.expect("page session id")
		.to_owned()
}

async fn claim_tab(ext: &mut Peer, cdp: &mut Peer, tab_id: i64) -> String {
	let session = attach_page(ext, cdp, tab_id).await;
	let id = next_id();
	cdp.send(json!({"id":id, "sessionId":session, "method":"OMP.claimTarget"}))
		.await;
	assert!(cdp.reply(id).await.get("result").is_some());
	session
}

async fn claim_existing_tab(cdp: &mut Peer, tab_id: i64) -> String {
	let session = attach_existing_page(cdp, tab_id).await;
	let id = next_id();
	cdp.send(json!({"id":id, "sessionId":session, "method":"OMP.claimTarget"}))
		.await;
	assert!(cdp.reply(id).await.get("result").is_some());
	session
}

async fn settle() {
	tokio::time::sleep(Duration::from_millis(10)).await;
}

fn relay_settings(enabled: bool, url: &str) -> BrowserSettings {
	BrowserSettings { relay: enabled, relay_url: Str::new(url), ..BrowserSettings::default() }
}

#[test]
fn relay_kind_is_disabled_by_default() {
	assert_eq!(resolve_relay(&BrowserSettings::default(), None), None);
}

#[test]
fn relay_kind_uses_default_endpoint_when_enabled() {
	assert_eq!(
		resolve_relay(&relay_settings(true, ""), None).as_deref(),
		Some("http://127.0.0.1:9224")
	);
}

#[test]
fn relay_kind_uses_configured_url_without_trailing_slashes() {
	assert_eq!(
		resolve_relay(&relay_settings(true, "http://127.0.0.1:9333///"), None).as_deref(),
		Some("http://127.0.0.1:9333")
	);
}

#[test]
fn relay_kind_blank_url_falls_back_to_default() {
	assert_eq!(
		resolve_relay(&relay_settings(true, "   "), None).as_deref(),
		Some("http://127.0.0.1:9224")
	);
}

#[test]
fn relay_kind_zero_environment_override_disables_setting() {
	assert_eq!(resolve_relay(&relay_settings(true, ""), Some("0")), None);
}

#[test]
fn relay_kind_one_environment_override_enables_setting() {
	assert_eq!(
		resolve_relay(&relay_settings(false, ""), Some("1")).as_deref(),
		Some("http://127.0.0.1:9224")
	);
}

fn raw_http(port: u16, request: &str) -> String {
	let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect relay HTTP");
	stream
		.set_read_timeout(Some(IO_BOUND))
		.expect("set HTTP read bound");
	stream
		.write_all(request.as_bytes())
		.expect("write HTTP request");
	let mut response = Vec::new();
	stream
		.read_to_end(&mut response)
		.expect("read HTTP response");
	String::from_utf8(response).expect("relay HTTP is UTF-8")
}

fn version_url(response: &str) -> String {
	assert!(
		response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"),
		"{response}"
	);
	let (_, body) = response
		.split_once("\r\n\r\n")
		.expect("HTTP response boundary");
	serde_json::from_str::<Value>(body).expect("version JSON")["webSocketDebuggerUrl"]
		.as_str()
		.expect("websocket URL")
		.to_owned()
}

#[tokio::test]
async fn discovery_advertises_requested_host_authority() {
	let harness = start_harness(true, vec![]).await;
	let response = raw_http(
		harness.port,
		"GET /json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n",
	);
	assert_eq!(version_url(&response), "ws://100.100.92.97:12803/cdp");
}

#[tokio::test]
async fn discovery_without_http10_host_uses_loopback() {
	let harness = start_harness(true, vec![]).await;
	let response = raw_http(harness.port, "GET /json/version HTTP/1.0\r\n\r\n");
	assert_eq!(version_url(&response), format!("ws://127.0.0.1:{}/cdp", harness.port));
}

#[tokio::test]
async fn discovery_with_empty_host_uses_loopback() {
	let harness = start_harness(true, vec![]).await;
	let response =
		raw_http(harness.port, "GET /json/version HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
	assert_eq!(version_url(&response), format!("ws://127.0.0.1:{}/cdp", harness.port));
}

#[tokio::test]
async fn discovery_with_unusable_host_uses_loopback() {
	let harness = start_harness(true, vec![]).await;
	let response = raw_http(
		harness.port,
		"GET /json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n",
	);
	assert_eq!(version_url(&response), format!("ws://127.0.0.1:{}/cdp", harness.port));
}

#[test]
fn discovery_is_503_until_extension_hello() {
	let server = start_server(RelayOptions::default());
	let response = raw_http(
		server.port(),
		&format!(
			"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
			server.port()
		),
	);
	assert!(response.starts_with("HTTP/1.1 503"), "{response}");
}

#[test]
fn proxy_bypassed_probe() {
	if let Ok(endpoint) = std::env::var("OMP_TEST_RELAY_PROBE_CHILD") {
		assert!(probe_relay_server(&endpoint));
		return;
	}
	let server = start_server(RelayOptions::default());
	let proxy = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake proxy");
	proxy.set_nonblocking(true).expect("nonblocking fake proxy");
	let proxy_port = proxy.local_addr().expect("proxy address").port();
	let hits = Arc::new(AtomicUsize::new(0));
	let observed = Arc::clone(&hits);
	let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
	let worker_done = Arc::clone(&done);
	let worker = thread::spawn(move || {
		while !worker_done.load(Ordering::Acquire) {
			match proxy.accept() {
				Ok((_stream, _)) => {
					observed.fetch_add(1, Ordering::Relaxed);
				},
				Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
					thread::sleep(Duration::from_millis(2))
				},
				Err(error) => panic!("fake proxy accept: {error}"),
			}
		}
	});
	let mut child = Command::new(std::env::current_exe().expect("current test executable"))
		.args(["--exact", "proxy_bypassed_probe", "--nocapture"])
		.env(
			"OMP_TEST_RELAY_PROBE_CHILD",
			format!("http://127.0.0.1:{}", server.port()),
		)
		.env("HTTP_PROXY", format!("http://127.0.0.1:{proxy_port}"))
		.env("http_proxy", format!("http://127.0.0.1:{proxy_port}"))
		.env("NO_PROXY", "")
		.env("no_proxy", "")
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("run isolated probe process");
	let status = wait_child(&mut child, CHILD_BOUND);
	let mut stderr = Vec::new();
	child.stderr.take().expect("probe stderr").read_to_end(&mut stderr).expect("read probe stderr");
	done.store(true, Ordering::Release);
	worker.join().expect("fake proxy worker");
	assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
	assert_eq!(hits.load(Ordering::Relaxed), 0, "probe must bypass proxy variables");
}

#[test]
fn startup_child_exit_surfaces_stderr_and_operating_system_cause() {
	if let Ok(port) = std::env::var("OMP_TEST_RELAY_BIND_CHILD") {
		let port = port.parse().expect("relay port");
		let error = RelayServer::start(RelayOptions { port, ..RelayOptions::default() })
			.err()
			.expect("occupied port must fail");
		eprintln!("{error}");
		panic!("relay startup child exited before readiness");
	}
	let occupied = TcpListener::bind(("127.0.0.1", 0)).expect("occupy relay port");
	let port = occupied.local_addr().expect("occupied address").port();
	let started = Instant::now();
	let mut child = Command::new(std::env::current_exe().expect("current test executable"))
		.args([
			"--exact",
			"startup_child_exit_surfaces_stderr_and_operating_system_cause",
			"--nocapture",
		])
		.env("OMP_TEST_RELAY_BIND_CHILD", port.to_string())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("run failing relay consumer");
	let status = wait_child(&mut child, CHILD_BOUND);
	assert!(!status.success(), "startup child must report failure");
	assert!(started.elapsed() < CHILD_BOUND, "early child exit must not consume the readiness budget");
	let mut stderr = Vec::new();
	child.stderr.take().expect("startup stderr").read_to_end(&mut stderr).expect("read startup stderr");
	let stderr = String::from_utf8_lossy(&stderr);
	assert!(stderr.contains("browser relay could not bind"), "{stderr}");
	assert!(stderr.contains(&port.to_string()), "{stderr}");
}

#[tokio::test]
async fn managed_relay_lives_until_last_cross_project_lease_closes() {
	if let Ok(endpoint) = std::env::var("OMP_TEST_RELAY_LEASE_CHILD") {
		let _lease = acquire_relay_lease(&endpoint, IO_BOUND).expect("second project lease");
		println!("OMP_RELAY_LEASE_READY");
		std::io::stdout().flush().expect("flush lease readiness");
		let mut held = Vec::new();
		std::io::stdin().read_to_end(&mut held).expect("hold lease until parent closes pipe");
		return;
	}
	let server = start_server(RelayOptions { managed: true, ..RelayOptions::default() });
	let endpoint = format!("http://127.0.0.1:{}", server.port());
	let first = acquire_relay_lease(&endpoint, IO_BOUND).expect("first project lease");
	let mut child = Command::new(std::env::current_exe().expect("current test executable"))
		.args(["--exact", "managed_relay_lives_until_last_cross_project_lease_closes", "--nocapture"])
		.env("OMP_TEST_RELAY_LEASE_CHILD", &endpoint)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("start second project consumer");
	let mut output = BufReader::new(child.stdout.take().expect("child stdout"));
	let mut line = String::new();
	loop {
		line.clear();
		assert_ne!(
			output.read_line(&mut line).expect("read child readiness"),
			0,
			"lease child exited before ready"
		);
		if line.contains("OMP_RELAY_LEASE_READY") {
			break;
		}
	}
	drop(first);
	assert!(!server.managed_shutdown_requested(), "one project cannot stop a shared relay");
	drop(child.stdin.take());
	let status = wait_child(&mut child, CHILD_BOUND);
	assert!(status.success(), "second project lease process failed");
	tokio::time::timeout(IO_BOUND, server.wait_for_managed_shutdown())
		.await
		.expect("last lease requests managed shutdown");
}

async fn rejected_upgrade(port: u16, path: &str, origin: Option<&str>) -> u16 {
	let mut request = format!("ws://127.0.0.1:{port}{path}")
		.into_client_request()
		.expect("websocket request");
	if let Some(origin) = origin {
		request
			.headers_mut()
			.insert(ORIGIN, HeaderValue::from_str(origin).expect("origin header"));
	}
	match connect_async(request).await {
		Err(WsError::Http(response)) => response.status().as_u16(),
		other => panic!("expected rejected websocket handshake, got {other:?}"),
	}
}

#[tokio::test]
async fn websocket_security_rejects_origins_tokens_and_non_upgrades() {
	let server = start_server(RelayOptions {
		token: Some(Str::new_static("secret")),
		..RelayOptions::default()
	});
	let port = server.port();
	assert_eq!(rejected_upgrade(port, "/cdp", Some("https://evil.example")).await, 403);
	assert_eq!(rejected_upgrade(port, "/ext?token=secret", Some("https://evil.example")).await, 403);
	assert_eq!(rejected_upgrade(port, "/ext", Some("chrome-extension://trusted")).await, 401);
	assert_eq!(
		rejected_upgrade(port, "/ext?token=wrong", Some("chrome-extension://trusted")).await,
		401
	);
	let mut extension = {
		let mut request = format!("ws://127.0.0.1:{port}/ext?token=secret")
			.into_client_request()
			.unwrap();
		request
			.headers_mut()
			.insert(ORIGIN, HeaderValue::from_static("chrome-extension://trusted"));
		let (socket, _) = connect_async(request)
			.await
			.expect("authenticated extension handshake");
		Peer { socket, buffered: VecDeque::new() }
	};
	hello(&mut extension, vec![], &[]).await;
	let response = raw_http(
		port,
		&format!(
			"POST /cdp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: \
			 close\r\n\r\n"
		),
	);
	assert!(response.starts_with("HTTP/1.1 426"), "{response}");
	let response = raw_http(
		port,
		&format!("GET /cdp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
	);
	assert!(response.starts_with("HTTP/1.1 426"), "{response}");
}

#[tokio::test]
async fn websocket_payload_limit_closes_oversized_frame_without_allocating_payload() {
	let server = start_server(RelayOptions::default());
	let port = server.port();
	let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
		.await
		.expect("raw websocket TCP");
	let request = format!(
		"GET /ext HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\nUpgrade: \
		 websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \
		 dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
	);
	stream
		.write_all(request.as_bytes())
		.await
		.expect("websocket handshake");
	let mut response = Vec::new();
	while !response.ends_with(b"\r\n\r\n") {
		response.push(
			tokio::time::timeout(IO_BOUND, stream.read_u8())
				.await
				.expect("handshake bound")
				.expect("handshake byte"),
		);
	}
	assert!(response.starts_with(b"HTTP/1.1 101"));
	let declared = (256_u64 * 1024 * 1024 + 1).to_be_bytes();
	let mut header = vec![0x82, 0xff];
	header.extend_from_slice(&declared);
	header.extend_from_slice(&[1, 2, 3, 4]);
	stream
		.write_all(&header)
		.await
		.expect("oversized frame header");
	let closed = tokio::time::timeout(IO_BOUND, async {
		let mut byte = [0_u8; 1];
		loop {
			if stream.read(&mut byte).await.expect("read relay close") == 0 {
				break;
			}
		}
	})
	.await;
	assert!(
		closed.is_ok(),
		"relay must reject a declared frame above 256 MiB before reading its payload"
	);
}

#[tokio::test]
async fn websocket_keepalive_ticks_immediately_and_answers_ping() {
	let server = start_server(RelayOptions::default());
	let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{}/ext", server.port()))
		.await
		.expect("connect extension");
	let first = tokio::time::timeout(IO_BOUND, socket.next())
		.await
		.expect("immediate keepalive bound")
		.expect("keepalive frame")
		.expect("valid keepalive");
	assert!(
		matches!(first, Message::Ping(_)),
		"first interval tick must keep a dormant extension alive"
	);
	socket
		.send(Message::Ping(vec![4, 2].into()))
		.await
		.expect("client ping");
	loop {
		let frame = tokio::time::timeout(IO_BOUND, socket.next())
			.await
			.expect("pong bound")
			.expect("pong frame")
			.expect("valid pong");
		if let Message::Pong(payload) = frame {
			assert_eq!(payload.as_ref(), &[4, 2]);
			break;
		}
	}
}

#[tokio::test]
async fn grouping_occurs_only_after_a_claim_not_hello_or_lifecycle() {
	let mut harness = start_harness(true, vec![tab(1), tab(2), tab(3)]).await;
	harness
		.ext
		.send(json!({"t":"tabCreated", "tab":tab(9)}))
		.await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "group")
		.await;
}

#[tokio::test]
async fn discovery_command_traffic_never_groups_tabs() {
	let mut harness = start_harness(true, vec![tab(1), tab(2)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	for tab_id in [1, 2] {
		let session = attach_page(&mut harness.ext, &mut cdp, tab_id).await;
		for method in ["Page.enable", "Page.getFrameTree"] {
			let id = next_id();
			cdp.send(json!({"id":id,"sessionId":session,"method":method}))
				.await;
			let request = harness.ext.rpc("send").await;
			ack(&mut harness.ext, &request, json!({})).await;
			assert!(cdp.reply(id).await.get("result").is_some());
		}
	}
	harness
		.ext
		.assert_no_match(|value| value["op"] == "group")
		.await;
}

#[tokio::test]
async fn claim_groups_exact_tab_with_canonical_group_identity() {
	let mut harness = start_harness(true, vec![tab(1), tab(2)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	claim_tab(&mut harness.ext, &mut cdp, 1).await;
	let group = harness.ext.rpc("group").await;
	assert_eq!(group["tabIds"], json!([1]));
	assert_eq!(group["title"], "omp");
	assert_eq!(group["color"], "cyan");
}

#[tokio::test]
async fn claim_never_groups_pinned_or_user_grouped_tabs() {
	let mut harness = start_harness(true, vec![tab_with(3, true, -1), tab_with(4, false, 77)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	claim_tab(&mut harness.ext, &mut cdp, 3).await;
	claim_tab(&mut harness.ext, &mut cdp, 4).await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "group")
		.await;
}

#[tokio::test]
async fn grouping_disabled_issues_no_group_rpc() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	claim_tab(&mut harness.ext, &mut cdp, 1).await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "group")
		.await;
}

#[tokio::test]
async fn target_create_auto_claims_created_tab() {
	let mut harness = start_harness(true, vec![]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let id = next_id();
	cdp.send(
		json!({"id":id,"method":"Target.createTarget","params":{"url":"https://example.com/"}}),
	)
	.await;
	let create = harness.ext.rpc("createTab").await;
	ack(&mut harness.ext, &create, json!({"tab":tab(9)})).await;
	assert_eq!(cdp.reply(id).await["result"]["targetId"], "PAGE9");
	assert_eq!(harness.ext.rpc("group").await["tabIds"], json!([9]));
}

#[tokio::test]
async fn user_group_opt_out_prevents_regroup() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	claim_tab(&mut harness.ext, &mut cdp, 1).await;
	let group = harness.ext.rpc("group").await;
	ack(&mut harness.ext, &group, json!({"grouped":{"1":42}})).await;
	settle().await;
	harness
		.ext
		.send(json!({"t":"tabUpdated","tab":tab_with(1,false,42)}))
		.await;
	harness
		.ext
		.send(json!({"t":"tabUpdated","tab":tab(1)}))
		.await;
	let mut navigated = tab(1);
	navigated["url"] = json!("https://example.com/other");
	harness
		.ext
		.send(json!({"t":"tabUpdated","tab":navigated}))
		.await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "group")
		.await;
}

#[tokio::test]
async fn claimant_disconnect_ungroups_even_with_another_session_holder() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut registry = connect_peer(harness.port, "/cdp").await;
	attach_page(&mut harness.ext, &mut registry, 1).await;
	let mut worker = connect_peer(harness.port, "/cdp").await;
	claim_existing_tab(&mut worker, 1).await;
	let group = harness.ext.rpc("group").await;
	ack(&mut harness.ext, &group, json!({"grouped":{"1":42}})).await;
	settle().await;
	worker.socket.close(None).await.expect("close claimant");
	assert_eq!(harness.ext.rpc("ungroup").await["tabIds"], json!([1]));
}

#[tokio::test]
async fn group_rpcs_are_serialized() {
	let mut harness = start_harness(true, vec![tab(1), tab(2)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	claim_tab(&mut harness.ext, &mut cdp, 1).await;
	let first = harness.ext.rpc("group").await;
	claim_tab(&mut harness.ext, &mut cdp, 2).await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "group")
		.await;
	ack(&mut harness.ext, &first, json!({"grouped":{"1":42}})).await;
	assert_eq!(harness.ext.rpc("group").await["tabIds"], json!([2]));
}

#[tokio::test]
async fn extension_reconnect_regroups_claimed_tabs() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	claim_tab(&mut harness.ext, &mut cdp, 1).await;
	let first = harness.ext.rpc("group").await;
	ack(&mut harness.ext, &first, json!({"grouped":{"1":42}})).await;
	settle().await;
	harness.ext.socket.close(None).await.expect("close first extension");
	let deadline = Instant::now() + IO_BOUND;
	while harness._server.ready() {
		assert!(Instant::now() < deadline, "relay did not observe extension disconnect");
		tokio::task::yield_now().await;
	}
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[]).await;
	assert_eq!(replacement.rpc("group").await["tabIds"], json!([1]));
	harness.ext = replacement;
}

#[tokio::test]
async fn runtime_enable_state_is_virtualized_and_contexts_replayed_per_session() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut first = connect_peer(harness.port, "/cdp").await;
	let first_session = attach_page(&mut harness.ext, &mut first, 1).await;
	let enable_first = next_id();
	first
		.send(json!({"id":enable_first,"sessionId":first_session,"method":"Runtime.enable"}))
		.await;
	for method in ["Runtime.disable", "Runtime.enable"] {
		let request = harness.ext.rpc("send").await;
		assert_eq!(request["method"], method);
		ack(&mut harness.ext, &request, json!({})).await;
	}
	assert!(first.reply(enable_first).await.get("result").is_some());
	let context = json!({"context":{"id":17,"uniqueId":"context-17"}});
	harness
		.ext
		.send(
			json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":context}),
		)
		.await;
	assert_eq!(
		first
			.matching(|value| value["method"] == "Runtime.executionContextCreated")
			.await["params"]["context"]["id"],
		17
	);
	let mut second = connect_peer(harness.port, "/cdp").await;
	let second_session = attach_existing_page(&mut second, 1).await;
	let enable_second = next_id();
	second
		.send(json!({"id":enable_second,"sessionId":second_session,"method":"Runtime.enable"}))
		.await;
	assert_eq!(
		second
			.matching(|value| value["method"] == "Runtime.executionContextCreated")
			.await["params"]["context"]["id"],
		17
	);
	assert!(second.reply(enable_second).await.get("result").is_some());
	harness
		.ext
		.assert_no_match(|value| value["op"] == "send")
		.await;
	let disable_second = next_id();
	second
		.send(json!({"id":disable_second,"sessionId":second_session,"method":"Runtime.disable"}))
		.await;
	second.reply(disable_second).await;
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":18}}})).await;
	first
		.matching(|value| {
			value["method"] == "Runtime.executionContextCreated"
				&& value["params"]["context"]["id"] == 18
		})
		.await;
	second
		.assert_no_match(|value| {
			value["method"] == "Runtime.executionContextCreated"
				&& value["params"]["context"]["id"] == 18
		})
		.await;
}

#[tokio::test]
async fn pipelined_runtime_disable_remains_authoritative() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let enable = next_id();
	cdp.send(json!({"id":enable,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	let root_disable = harness.ext.rpc("send").await;
	let disable = next_id();
	cdp.send(json!({"id":disable,"sessionId":session,"method":"Runtime.disable"}))
		.await;
	assert!(cdp.reply(disable).await.get("result").is_some());
	ack(&mut harness.ext, &root_disable, json!({})).await;
	let root_enable = harness.ext.rpc("send").await;
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":19}}})).await;
	ack(&mut harness.ext, &root_enable, json!({})).await;
	cdp.reply(enable).await;
	cdp.assert_no_match(|value| value["method"] == "Runtime.executionContextCreated")
		.await;
}

#[tokio::test]
async fn extension_reconnect_refreshes_runtime_contexts() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut first = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut first, 1).await;
	let enable = next_id();
	first
		.send(json!({"id":enable,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	for _ in 0..2 {
		let request = harness.ext.rpc("send").await;
		ack(&mut harness.ext, &request, json!({})).await;
	}
	first.reply(enable).await;
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":17}}})).await;
	first
		.matching(|value| value["method"] == "Runtime.executionContextCreated")
		.await;
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[1]).await;
	let mut second = connect_peer(harness.port, "/cdp").await;
	let second_session = attach_existing_page(&mut second, 1).await;
	let second_enable = next_id();
	second
		.send(json!({"id":second_enable,"sessionId":second_session,"method":"Runtime.enable"}))
		.await;
	let disable = replacement.rpc("send").await;
	assert_eq!(disable["method"], "Runtime.disable");
	ack(&mut replacement, &disable, json!({})).await;
	let enable = replacement.rpc("send").await;
	assert_eq!(enable["method"], "Runtime.enable");
	replacement.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":18}}})).await;
	ack(&mut replacement, &enable, json!({})).await;
	second.reply(second_enable).await;
	assert_eq!(
		second
			.matching(|value| value["method"] == "Runtime.executionContextCreated")
			.await["params"]["context"]["id"],
		18
	);
	second
		.assert_no_match(|value| {
			value["method"] == "Runtime.executionContextCreated"
				&& value["params"]["context"]["id"] == 17
		})
		.await;
}

#[tokio::test]
async fn explicit_last_session_detach_allows_clean_reattach() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let detach_id = next_id();
	cdp.send(
		json!({"id":detach_id,"method":"Target.detachFromTarget","params":{"sessionId":session}}),
	)
	.await;
	let detach = harness.ext.rpc("detach").await;
	harness
		.ext
		.send(json!({"t":"detached","tabId":1,"reason":"target_closed","relayInitiated":true}))
		.await;
	ack(&mut harness.ext, &detach, json!({})).await;
	cdp.reply(detach_id).await;
	let replacement = attach_page(&mut harness.ext, &mut cdp, 1).await;
	assert!(replacement.starts_with("SP1."));
	cdp.assert_no_match(|value| value["method"] == "Target.targetDestroyed")
		.await;
}

#[tokio::test]
async fn immediate_reattach_waits_for_detach_rpc_and_echo() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let detach_id = next_id();
	cdp.send(
		json!({"id":detach_id,"method":"Target.detachFromTarget","params":{"sessionId":session}}),
	)
	.await;
	let detach = harness.ext.rpc("detach").await;
	let attach_id = next_id();
	cdp.send(json!({"id":attach_id,"method":"Target.attachToTarget","params":{"targetId":"PAGE1"}}))
		.await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "attach")
		.await;
	harness
		.ext
		.send(json!({"t":"detached","tabId":1,"reason":"target_closed","relayInitiated":true}))
		.await;
	ack(&mut harness.ext, &detach, json!({})).await;
	let attach = harness.ext.rpc("attach").await;
	ack(&mut harness.ext, &attach, json!({})).await;
	assert!(cdp.reply(attach_id).await["result"]["sessionId"].is_string());
}

#[tokio::test]
async fn releasing_one_of_two_connection_sessions_preserves_attachment() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut first = connect_peer(harness.port, "/cdp").await;
	attach_page(&mut harness.ext, &mut first, 1).await;
	let mut second = connect_peer(harness.port, "/cdp").await;
	let session = attach_existing_page(&mut second, 1).await;
	let id = next_id();
	second
		.send(json!({"id":id,"method":"Target.detachFromTarget","params":{"sessionId":session}}))
		.await;
	second.reply(id).await;
	harness
		.ext
		.assert_no_match(|value| value["op"] == "detach")
		.await;
}

#[tokio::test]
async fn final_tab_and_page_session_release_detaches_once() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let auto_id = next_id();
	cdp.send(json!({"id":auto_id,"method":"Target.setAutoAttach"}))
		.await;
	let attach_tab = harness.ext.rpc("attach").await;
	ack(&mut harness.ext, &attach_tab, json!({})).await;
	cdp.reply(auto_id).await;
	let tab_session = cdp
		.matching(|value| value["method"] == "Target.attachedToTarget")
		.await["params"]["sessionId"]
		.as_str()
		.unwrap()
		.to_owned();
	let page_session = attach_existing_page(&mut cdp, 1).await;
	for (index, session) in [page_session, tab_session].into_iter().enumerate() {
		let id = next_id();
		cdp.send(json!({"id":id,"method":"Target.detachFromTarget","params":{"sessionId":session}}))
			.await;
		cdp.reply(id).await;
		if index == 0 {
			harness
				.ext
				.assert_no_match(|value| value["op"] == "detach")
				.await;
		}
	}
	assert_eq!(harness.ext.rpc("detach").await["tabId"], 1);
}

#[tokio::test]
async fn failed_reconnect_reattach_retracts_held_sessions() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[]).await;
	let attach = replacement.rpc("attach").await;
	nack(&mut replacement, &attach, "debugger unavailable").await;
	let detached = cdp
		.matching(|value| value["method"] == "Target.detachedFromTarget")
		.await;
	assert_eq!(detached["params"]["sessionId"], session);
}

#[tokio::test]
async fn delayed_detach_after_replacement_is_reconciled_before_reattach() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let detach_id = next_id();
	cdp.send(
		json!({"id":detach_id,"method":"Target.detachFromTarget","params":{"sessionId":session}}),
	)
	.await;
	harness.ext.rpc("detach").await;
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[1]).await;
	replacement
		.send(json!({"t":"detached","tabId":1,"reason":"target_closed","relayInitiated":true}))
		.await;
	let attach_id = next_id();
	cdp.send(json!({"id":attach_id,"method":"Target.attachToTarget","params":{"targetId":"PAGE1"}}))
		.await;
	let attach = replacement.rpc("attach").await;
	ack(&mut replacement, &attach, json!({})).await;
	assert!(cdp.reply(attach_id).await["result"]["sessionId"].is_string());
}

#[tokio::test]
async fn replacement_during_attach_does_not_ban_tab() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let interrupted = next_id();
	cdp.send(
		json!({"id":interrupted,"method":"Target.attachToTarget","params":{"targetId":"PAGE1"}}),
	)
	.await;
	harness.ext.rpc("attach").await;
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[]).await;
	let retry_id = next_id();
	cdp.send(json!({"id":retry_id,"method":"Target.attachToTarget","params":{"targetId":"PAGE1"}}))
		.await;
	let retry = replacement.rpc("attach").await;
	ack(&mut replacement, &retry, json!({})).await;
	assert!(cdp.reply(retry_id).await["result"]["sessionId"].is_string());
}

#[tokio::test]
async fn replacement_clears_pending_detach_without_retracting_successor() {
	let mut harness = start_harness(true, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let detach_id = next_id();
	cdp.send(
		json!({"id":detach_id,"method":"Target.detachFromTarget","params":{"sessionId":session}}),
	)
	.await;
	harness.ext.rpc("detach").await;
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[]).await;
	let attach_id = next_id();
	cdp.send(json!({"id":attach_id,"method":"Target.attachToTarget","params":{"targetId":"PAGE1"}}))
		.await;
	let attach = replacement.rpc("attach").await;
	ack(&mut replacement, &attach, json!({})).await;
	let successor = cdp.reply(attach_id).await["result"]["sessionId"]
		.as_str()
		.unwrap()
		.to_owned();
	replacement
		.send(json!({"t":"detached","tabId":1,"reason":"target_closed","relayInitiated":true}))
		.await;
	cdp.assert_no_match(|value| {
		value["method"] == "Target.detachedFromTarget" && value["params"]["sessionId"] == successor
	})
	.await;
	replacement
		.send(json!({"t":"detached","tabId":1,"reason":"canceled_by_user"}))
		.await;
	assert_eq!(
		cdp.matching(|value| {
			value["method"] == "Target.detachedFromTarget"
				&& value["params"]["sessionId"] == successor
		})
		.await["params"]["sessionId"],
		successor
	);
}

#[tokio::test]
async fn default_runtime_fanout_stops_after_explicit_disable() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":42}}})).await;
	assert_eq!(
		cdp.matching(|value| value["method"] == "Runtime.executionContextCreated")
			.await["sessionId"],
		session
	);
	let disable = next_id();
	cdp.send(json!({"id":disable,"sessionId":session,"method":"Runtime.disable"}))
		.await;
	cdp.reply(disable).await;
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":43}}})).await;
	cdp.assert_no_match(|value| {
		value["method"] == "Runtime.executionContextCreated" && value["params"]["context"]["id"] == 43
	})
	.await;
}

#[tokio::test]
async fn duplicate_runtime_enable_waits_for_shared_root_cycle() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let first = next_id();
	let second = next_id();
	cdp.send(json!({"id":first,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	let root_disable = harness.ext.rpc("send").await;
	cdp.send(json!({"id":second,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	cdp.assert_no_match(|value| value["id"] == first || value["id"] == second)
		.await;
	ack(&mut harness.ext, &root_disable, json!({})).await;
	let root_enable = harness.ext.rpc("send").await;
	ack(&mut harness.ext, &root_enable, json!({})).await;
	assert!(cdp.reply(first).await.get("result").is_some());
	assert!(cdp.reply(second).await.get("result").is_some());
}

#[tokio::test]
async fn duplicate_runtime_enable_shares_root_failure() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let first = next_id();
	let second = next_id();
	cdp.send(json!({"id":first,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	let root_disable = harness.ext.rpc("send").await;
	cdp.send(json!({"id":second,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	nack(&mut harness.ext, &root_disable, "root enable failed").await;
	assert!(cdp.reply(first).await.get("error").is_some());
	assert!(cdp.reply(second).await.get("error").is_some());
}

#[tokio::test]
async fn latest_runtime_disable_survives_failed_enables() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let old_enable = next_id();
	cdp.send(json!({"id":old_enable,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	let root = harness.ext.rpc("send").await;
	let disable = next_id();
	cdp.send(json!({"id":disable,"sessionId":session,"method":"Runtime.disable"}))
		.await;
	cdp.reply(disable).await;
	let latest = next_id();
	cdp.send(json!({"id":latest,"sessionId":session,"method":"Runtime.enable"}))
		.await;
	nack(&mut harness.ext, &root, "failed root cycle").await;
	assert!(cdp.reply(latest).await.get("error").is_some());
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"method":"Runtime.executionContextCreated","params":{"context":{"id":91}}})).await;
	cdp.assert_no_match(|value| value["method"] == "Runtime.executionContextCreated")
		.await;
}

#[tokio::test]
async fn extension_replacement_rejects_pending_rpc_and_new_socket_serves_next_command() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let pending = next_id();
	cdp.send(json!({"id":pending,"sessionId":session,"method":"Page.getFrameTree"}))
		.await;
	harness.ext.rpc("send").await;
	let mut replacement = connect_peer(harness.port, "/ext").await;
	hello(&mut replacement, vec![tab(1)], &[1]).await;
	assert!(cdp.reply(pending).await.get("error").is_some());
	let next = next_id();
	cdp.send(json!({"id":next,"sessionId":session,"method":"Page.getFrameTree"}))
		.await;
	let request = replacement.rpc("send").await;
	ack(&mut replacement, &request, json!({"frameTree":{"frame":{"id":"f"}}})).await;
	assert_eq!(cdp.reply(next).await["result"]["frameTree"]["frame"]["id"], "f");
}

#[tokio::test]
async fn extension_rpc_timeout_is_bounded_and_correlated() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let id = next_id();
	cdp.send(json!({"id":id,"sessionId":session,"method":"Page.getFrameTree"}))
		.await;
	let request = harness.ext.rpc("send").await;
	assert_eq!(request["method"], "Page.getFrameTree");
	let response = cdp.reply_for(id, RPC_TIMEOUT_BOUND).await;
	assert!(
		response["error"]["message"]
			.as_str()
			.unwrap()
			.contains("timed out")
	);
}

#[tokio::test]
async fn real_child_sessions_route_commands_and_events_without_pseudo_session_rewrite() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	attach_page(&mut harness.ext, &mut cdp, 1).await;
	let mut foreign = connect_peer(harness.port, "/cdp").await;
	harness
		.ext
		.send(json!({
			"t":"cdpEvent","tabId":1,"method":"Target.attachedToTarget",
			"params":{"sessionId":"REAL-WORKER","targetInfo":{"targetId":"worker-1","type":"worker"}}
		}))
		.await;
	cdp.matching(|value| {
		value["method"] == "Target.attachedToTarget" && value["params"]["sessionId"] == "REAL-WORKER"
	})
	.await;
	let id = next_id();
	cdp.send(json!({"id":id,"sessionId":"REAL-WORKER","method":"Runtime.evaluate","params":{"expression":"40+2"}})).await;
	let send = harness.ext.rpc("send").await;
	assert_eq!(send["sessionId"], "REAL-WORKER");
	assert_eq!(send["tabId"], 1);
	ack(&mut harness.ext, &send, json!({"result":{"value":42}})).await;
	assert_eq!(cdp.reply(id).await["result"]["result"]["value"], 42);
	harness.ext.send(json!({"t":"cdpEvent","tabId":1,"sessionId":"REAL-WORKER","method":"Runtime.consoleAPICalled","params":{"type":"log"}})).await;
	let event = cdp
		.matching(|value| {
			value["sessionId"] == "REAL-WORKER" && value["method"] == "Runtime.consoleAPICalled"
		})
		.await;
	assert_eq!(event["params"]["type"], "log");
	foreign
		.assert_no_match(|value| {
			value["sessionId"] == "REAL-WORKER" || value["method"] == "Target.attachedToTarget"
		})
		.await;
}

#[tokio::test]
async fn target_operation_matrix_matches_chromium_cdp_observables() {
	let mut harness = start_harness(false, vec![tab(1)]).await;
	let mut cdp = connect_peer(harness.port, "/cdp").await;
	let version = next_id();
	cdp.send(json!({"id":version,"method":"Browser.getVersion"}))
		.await;
	assert_eq!(cdp.reply(version).await["result"]["product"], "Chrome/151.0.0.0");
	let contexts = next_id();
	cdp.send(json!({"id":contexts,"method":"Target.getBrowserContexts"}))
		.await;
	assert_eq!(cdp.reply(contexts).await["result"]["browserContextIds"], json!([]));
	let targets = next_id();
	cdp.send(json!({"id":targets,"method":"Target.getTargets"}))
		.await;
	assert_eq!(
		cdp.reply(targets).await["result"]["targetInfos"]
			.as_array()
			.unwrap()
			.len(),
		2
	);
	let discover = next_id();
	cdp.send(json!({"id":discover,"method":"Target.setDiscoverTargets","params":{"discover":true}}))
		.await;
	let created = cdp
		.matching(|value| value["method"] == "Target.targetCreated")
		.await;
	assert!(
		created["params"]["targetInfo"]["targetId"]
			.as_str()
			.unwrap()
			.starts_with("TAB")
			|| created["params"]["targetInfo"]["targetId"]
				.as_str()
				.unwrap()
				.starts_with("PAGE")
	);
	cdp.reply(discover).await;
	let page_session = attach_page(&mut harness.ext, &mut cdp, 1).await;
	let attach_tab = next_id();
	cdp.send(json!({
		"id": attach_tab,
		"method": "Target.attachToTarget",
		"params": {"targetId": "TAB1", "flatten": true},
	}))
	.await;
	let tab_session = cdp.reply(attach_tab).await["result"]["sessionId"]
		.as_str()
		.expect("tab session")
		.to_owned();
	let tab_auto = next_id();
	cdp.send(json!({"id":tab_auto,"sessionId":tab_session,"method":"Target.setAutoAttach"}))
		.await;
	cdp.reply(tab_auto).await;
	let nested_page = cdp
		.matching(|value| {
			value["sessionId"] == tab_session && value["method"] == "Target.attachedToTarget"
		})
		.await["params"]["sessionId"]
		.as_str()
		.expect("nested page session")
		.to_owned();
	let resume = next_id();
	cdp.send(json!({"id":resume,"sessionId":tab_session,"method":"Runtime.runIfWaitingForDebugger"}))
		.await;
	assert!(cdp.reply(resume).await.get("result").is_some());
	let nested_detach = next_id();
	cdp.send(json!({
		"id": nested_detach,
		"sessionId": tab_session,
		"method": "Target.detachFromTarget",
		"params": {"sessionId": nested_page},
	}))
	.await;
	assert!(cdp.reply(nested_detach).await.get("result").is_some());
	let invalid_attach = next_id();
	cdp.send(json!({
		"id": invalid_attach,
		"method": "Target.attachToTarget",
		"params": {"targetId": "PAGE404"},
	}))
	.await;
	assert_eq!(cdp.reply(invalid_attach).await["error"]["code"], -32000);
	let info = next_id();
	cdp.send(json!({"id":info,"method":"Target.getTargetInfo","params":{"targetId":"PAGE1"}}))
		.await;
	assert_eq!(cdp.reply(info).await["result"]["targetInfo"]["targetId"], "PAGE1");
	let browser_info = next_id();
	cdp.send(json!({"id":browser_info,"method":"Target.getTargetInfo"}))
		.await;
	assert_eq!(
		cdp.reply(browser_info).await["result"]["targetInfo"]["targetId"],
		"relay-browser"
	);
	let activate = next_id();
	cdp.send(json!({"id":activate,"method":"Target.activateTarget","params":{"targetId":"PAGE1"}}))
		.await;
	let activate_rpc = harness.ext.rpc("activateTab").await;
	ack(&mut harness.ext, &activate_rpc, json!({})).await;
	assert!(cdp.reply(activate).await.get("result").is_some());
	let close = next_id();
	cdp.send(json!({"id":close,"method":"Target.closeTarget","params":{"targetId":"PAGE1"}}))
		.await;
	let remove = harness.ext.rpc("removeTab").await;
	ack(&mut harness.ext, &remove, json!({})).await;
	assert_eq!(cdp.reply(close).await["result"]["success"], true);
	for method in ["Browser.close", "Browser.setDownloadBehavior"] {
		let id = next_id();
		cdp.send(json!({"id":id,"method":method})).await;
		assert!(cdp.reply(id).await.get("result").is_some());
	}
	let browser_context = next_id();
	cdp.send(json!({"id":browser_context,"method":"Target.createBrowserContext"}))
		.await;
	assert!(
		cdp.reply(browser_context).await["error"]["message"]
			.as_str()
			.unwrap()
			.contains("not supported")
	);
	let unknown = next_id();
	cdp.send(json!({"id":unknown,"method":"NoSuch.method"}))
		.await;
	assert_eq!(cdp.reply(unknown).await["error"]["code"], -32601);
	let page_close = next_id();
	cdp.send(json!({"id":page_close,"sessionId":page_session,"method":"Browser.close"}))
		.await;
	assert!(cdp.reply(page_close).await.get("result").is_some());
}
