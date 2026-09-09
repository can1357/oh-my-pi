//! Session-owned, policy-enforcing forward proxy for scoped sandbox networking.

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
use std::{
	io::{self, BufRead, BufReader, Read, Write},
	net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

use omp_core::{FastHashMap, Str, Ulid, encoding::base64};
use parking_lot::Mutex;
#[cfg(target_os = "linux")]
use tempfile::TempDir;
use url::Url;

use crate::exec_settings::SandboxSettings;

const MAX_CONNECTIONS: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_HEADER_COUNT: usize = 128;
const MAX_TLS_CLIENT_HELLO_BYTES: usize = 64 * 1024;
const MAX_TLS_RECORD_BYTES: usize = 16 * 1024;
const MAX_ATTEMPTS: usize = 64;

/// A session-owned scoped egress broker. It exposes a loopback listener on
/// macOS and an owned Unix socket on Linux, so an untrusted command can reach
/// it only through its platform-specific sandbox relay.
pub(crate) struct ScopedProxy {
	port:     u16,
	#[cfg(target_os = "linux")]
	socket:   PathBuf,
	shutdown: Arc<AtomicBool>,
	attempts: Arc<Mutex<FastHashMap<Str, Option<(Str, u16)>>>>,
	listener: Option<JoinHandle<()>>,
	#[cfg(target_os = "linux")]
	_temp:    TempDir,
}

impl ScopedProxy {
	/// Starts a broker whose policy is immutable for this execution session.
	pub(crate) fn start(settings: &SandboxSettings) -> io::Result<Self> {
		Self::start_with_amendment(settings, None)
	}

	/// Starts a fresh one-shot broker that additionally allows one exact
	/// approved endpoint without broadening its base policy.
	pub(crate) fn start_with_amendment(
		settings: &SandboxSettings,
		amendment: Option<(&Str, u16)>,
	) -> io::Result<Self> {
		let shutdown = Arc::new(AtomicBool::new(false));
		let attempts = Arc::new(Mutex::new(FastHashMap::default()));
		let policy = ProxyPolicy::from_settings(settings, amendment, Arc::clone(&attempts));
		let live = Arc::new(AtomicUsize::new(0));

		#[cfg(target_os = "linux")]
		{
			let temp = tempfile::Builder::new()
				.prefix("omp-scoped-proxy-")
				.tempdir()?;
			let socket = temp.path().join("broker.sock");
			let listener = UnixListener::bind(&socket)?;
			use std::os::unix::fs::PermissionsExt as _;
			std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
			listener.set_nonblocking(true)?;
			// A port is scoped to Bubblewrap's private network namespace. Reserving one
			// on the host selects a nonzero port without granting host reachability.
			let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
				.local_addr()?
				.port();
			let stop = Arc::clone(&shutdown);
			let wake = socket.clone();
			let listener = spawn_listener("omp-scoped-proxy", listener, policy, live, stop)?;
			return Ok(Self {
				port,
				socket: wake,
				shutdown,
				attempts,
				listener: Some(listener),
				_temp: temp,
			});
		}

		#[cfg(not(target_os = "linux"))]
		{
			let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
			let port = listener.local_addr()?.port();
			listener.set_nonblocking(true)?;
			let listener =
				spawn_listener("omp-scoped-proxy", listener, policy, live, Arc::clone(&shutdown))?;
			Ok(Self { port, shutdown, attempts, listener: Some(listener) })
		}
	}

	/// Registers a unique execution attempt capability and returns its opaque
	/// token.
	pub(crate) fn begin_attempt(&self) -> Str {
		let token = Str::from(Ulid::generate().to_string());
		let mut attempts = self.attempts.lock();
		if attempts.len() >= MAX_ATTEMPTS
			&& let Some(expired) = attempts.keys().next().cloned()
		{
			attempts.remove(&expired);
		}
		attempts.insert(token.clone(), None);
		token
	}

	/// Consumes this capability's denial and invalidates it.
	pub(crate) fn finish_attempt(&self, token: &Str) -> Option<(Str, u16)> {
		self.attempts.lock().remove(token).flatten()
	}

	/// Returns an HTTP proxy URL carrying this attempt capability.
	pub(crate) fn http_url(&self, token: &Str) -> String {
		format!("http://omp:{token}@127.0.0.1:{}", self.port)
	}

	/// Returns a SOCKS5 proxy URL carrying this attempt capability.
	pub(crate) fn socks_url(&self, token: &Str) -> String {
		format!("socks5h://omp:{token}@127.0.0.1:{}", self.port)
	}

	/// Returns the loopback TCP port a sandboxed command must proxy through.
	pub(crate) const fn port(&self) -> u16 {
		self.port
	}

	/// Returns the owned Unix broker endpoint used by the Linux namespace relay.
	#[cfg(target_os = "linux")]
	pub(crate) fn socket(&self) -> &Path {
		&self.socket
	}
}

impl Drop for ScopedProxy {
	fn drop(&mut self) {
		self.shutdown.store(true, Ordering::Release);
		#[cfg(target_os = "linux")]
		let _ = UnixStream::connect(&self.socket);
		#[cfg(not(target_os = "linux"))]
		let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port));
		if let Some(listener) = self.listener.take() {
			let _ = listener.join();
		}
	}
}

trait ClientStream: Read + Write + Send + 'static + Sized {
	fn duplicate(&self) -> io::Result<Self>;
	fn set_idle_timeout(&self) -> io::Result<()>;
	fn close(&self) -> io::Result<()>;
}

impl ClientStream for TcpStream {
	fn duplicate(&self) -> io::Result<Self> {
		self.try_clone()
	}

	fn set_idle_timeout(&self) -> io::Result<()> {
		self.set_read_timeout(Some(IDLE_TIMEOUT))?;
		self.set_write_timeout(Some(IDLE_TIMEOUT))
	}

	fn close(&self) -> io::Result<()> {
		self.shutdown(std::net::Shutdown::Both)
	}
}

#[cfg(unix)]
impl ClientStream for UnixStream {
	fn duplicate(&self) -> io::Result<Self> {
		self.try_clone()
	}

	fn set_idle_timeout(&self) -> io::Result<()> {
		self.set_read_timeout(Some(IDLE_TIMEOUT))?;
		self.set_write_timeout(Some(IDLE_TIMEOUT))
	}

	fn close(&self) -> io::Result<()> {
		self.shutdown(std::net::Shutdown::Both)
	}
}

trait BrokerListener: Send + 'static {
	type Stream: ClientStream;
	fn accept(&self) -> io::Result<Self::Stream>;
}

impl BrokerListener for TcpListener {
	type Stream = TcpStream;

	fn accept(&self) -> io::Result<Self::Stream> {
		TcpListener::accept(self).map(|(stream, _)| stream)
	}
}

#[cfg(unix)]
impl BrokerListener for UnixListener {
	type Stream = UnixStream;

	fn accept(&self) -> io::Result<Self::Stream> {
		UnixListener::accept(self).map(|(stream, _)| stream)
	}
}

fn spawn_listener<L>(
	name: &str,
	listener: L,
	policy: ProxyPolicy,
	live: Arc<AtomicUsize>,
	shutdown: Arc<AtomicBool>,
) -> io::Result<JoinHandle<()>>
where
	L: BrokerListener,
{
	thread::Builder::new().name(name.into()).spawn(move || {
		while !shutdown.load(Ordering::Acquire) {
			match listener.accept() {
				Ok(_stream) if shutdown.load(Ordering::Acquire) => break,
				Ok(stream) if live.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS => {
					live.fetch_sub(1, Ordering::AcqRel);
					let _ = http_deny(stream);
				},
				Ok(stream) => {
					let policy = policy.clone();
					let worker_live = Arc::clone(&live);
					let stop = Arc::clone(&shutdown);
					if thread::Builder::new()
						.name("omp-scoped-proxy-client".into())
						.spawn(move || {
							let _ = serve(stream, &policy, &stop);
							worker_live.fetch_sub(1, Ordering::AcqRel);
						})
						.is_err()
					{
						live.fetch_sub(1, Ordering::AcqRel);
					}
				},
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
					thread::sleep(Duration::from_millis(10));
				},
				Err(_) => break,
			}
		}
	})
}

#[derive(Clone)]
struct ProxyPolicy {
	allow:     Arc<[Str]>,
	deny:      Arc<[Str]>,
	ports:     Arc<[u16]>,
	localhost: bool,
	amendment: Option<(Str, u16)>,
	attempts:  Arc<Mutex<FastHashMap<Str, Option<(Str, u16)>>>>,
}

impl ProxyPolicy {
	fn from_settings(
		settings: &SandboxSettings,
		amendment: Option<(&Str, u16)>,
		attempts: Arc<Mutex<FastHashMap<Str, Option<(Str, u16)>>>>,
	) -> Self {
		Self {
			allow: settings.allow_domains.clone().into(),
			deny: settings.deny_domains.clone().into(),
			ports: settings.allow_ports.clone().into(),
			localhost: settings.allow_localhost,
			amendment: amendment.map(|(host, port)| (host.clone(), port)),
			attempts,
		}
	}

	fn attempt_is_active(&self, token: &Str) -> bool {
		self.attempts.lock().contains_key(token)
	}

	fn authorize(&self, token: &Str, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
		if !self.attempt_is_active(token) {
			return Err(policy_blocked());
		}
		let host = host.trim_end_matches('.').to_ascii_lowercase();
		let amended = self
			.amendment
			.as_ref()
			.is_some_and(|(allowed, allowed_port)| {
				*allowed_port == port && allowed.trim_end_matches('.').eq_ignore_ascii_case(&host)
			});
		if host.is_empty()
			|| !amended
				&& (!self.ports.contains(&port)
					|| self
						.deny
						.iter()
						.any(|rule| domain_matches(rule.as_str(), &host))
					|| !self
						.allow
						.iter()
						.any(|rule| domain_matches(rule.as_str(), &host)))
		{
			if let Some(denial) = self.attempts.lock().get_mut(token) {
				*denial = Some((Str::from(host.as_str()), port));
			}
			return Err(policy_blocked());
		}
		let candidates = (host.as_str(), port).to_socket_addrs()?.collect::<Vec<_>>();
		if candidates.is_empty()
			|| candidates
				.iter()
				.any(|address| !authorized_address(address.ip(), self.localhost))
		{
			return Err(policy_blocked());
		}
		Ok(candidates)
	}
}

fn policy_blocked() -> io::Error {
	io::Error::new(io::ErrorKind::PermissionDenied, "scoped proxy policy blocked request")
}

fn domain_matches(rule: &str, host: &str) -> bool {
	let rule = rule.trim().trim_end_matches('.');
	if let Some(suffix) = rule.strip_prefix("*.") {
		let suffix = suffix.to_ascii_lowercase();
		host.len() > suffix.len()
			&& host.ends_with(&suffix)
			&& host.as_bytes().get(host.len() - suffix.len() - 1) == Some(&b'.')
	} else {
		rule.eq_ignore_ascii_case(host)
	}
}

fn authorized_address(ip: IpAddr, allow_localhost: bool) -> bool {
	globally_routable(ip) || allow_localhost && ip.is_loopback()
}

fn globally_routable(ip: IpAddr) -> bool {
	match ip {
		IpAddr::V4(value) => {
			!(value.is_private()
				|| value.is_loopback()
				|| value.is_link_local()
				|| value.is_multicast()
				|| value.is_unspecified()
				|| value.is_broadcast()
				|| value.octets()[0] == 0
				|| matches!(
					value.octets(),
					[100, 64..=127, _, _]
						| [192, 0, 0, _]
						| [192, 0, 2, _]
						| [198, 18..=19, _, _]
						| [198, 51, 100, _]
						| [203, 0, 113, _]
						| [240..=255, _, _, _]
						| [168, 63, 129, 16]
				))
		},
		IpAddr::V6(value) => {
			if let Some(mapped) = value.to_ipv4_mapped() {
				return globally_routable(IpAddr::V4(mapped));
			}
			!(value.is_loopback()
				|| value.is_multicast()
				|| value.is_unspecified()
				|| value.is_unique_local()
				|| value.is_unicast_link_local())
		},
	}
}

fn connect(policy: &ProxyPolicy, token: &Str, host: &str, port: u16) -> io::Result<TcpStream> {
	let candidates = policy.authorize(token, host, port)?;
	let mut last = None;
	for address in candidates {
		match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
			Ok(stream) => {
				stream.set_read_timeout(Some(IDLE_TIMEOUT))?;
				stream.set_write_timeout(Some(IDLE_TIMEOUT))?;
				return Ok(stream);
			},
			Err(error) => last = Some(error),
		}
	}
	Err(last.unwrap_or_else(policy_blocked))
}

fn serve<S: ClientStream>(
	mut client: S,
	policy: &ProxyPolicy,
	shutdown: &AtomicBool,
) -> io::Result<()> {
	client.set_idle_timeout()?;
	let mut first = [0_u8; 1];
	client.read_exact(&mut first)?;
	if shutdown.load(Ordering::Acquire) {
		return Ok(());
	}
	if first[0] == 5 {
		return socks(client, policy, shutdown);
	}
	let reader_stream = client.duplicate()?;
	let mut reader = BufReader::new(reader_stream);
	let mut request = Vec::with_capacity(512);
	request.push(first[0]);
	read_line(&mut reader, &mut request, MAX_HEADER_BYTES)?;
	http(client, &mut reader, request, policy, shutdown)
}

fn http<S: ClientStream>(
	mut client: S,
	reader: &mut BufReader<S>,
	request: Vec<u8>,
	policy: &ProxyPolicy,
	shutdown: &AtomicBool,
) -> io::Result<()> {
	let request = std::str::from_utf8(&request).map_err(invalid_data)?;
	let mut words = request.trim_end().split_ascii_whitespace();
	let method = words.next().ok_or_else(policy_blocked)?;
	let target = words.next().ok_or_else(policy_blocked)?;
	let version = words.next().ok_or_else(policy_blocked)?;
	if words.next().is_some() || !version.starts_with("HTTP/") {
		return http_deny(client);
	}

	let (host, port, origin) = if method.eq_ignore_ascii_case("CONNECT") {
		let (host, port) = authority(target, 443).ok_or_else(policy_blocked)?;
		(host, port, None)
	} else {
		let url = Url::parse(target).map_err(invalid_data)?;
		let host = url.host_str().ok_or_else(policy_blocked)?;
		let port = url.port_or_known_default().ok_or_else(policy_blocked)?;
		let mut origin = url.path().to_owned();
		if origin.is_empty() {
			origin.push('/');
		}
		if let Some(query) = url.query() {
			origin.push('?');
			origin.push_str(query);
		}
		(host.to_owned(), port, Some(origin))
	};

	let mut headers = Vec::new();
	let mut connection_tokens = Vec::new();
	let mut content_length = None;
	let mut header_bytes = request.len();
	loop {
		let mut line = Vec::new();
		let remaining = MAX_HEADER_BYTES
			.checked_sub(header_bytes)
			.ok_or_else(policy_blocked)?;
		read_line(reader, &mut line, remaining)?;
		header_bytes += line.len();
		if line == b"\r\n" || line == b"\n" {
			break;
		}
		if headers.len() >= MAX_HEADER_COUNT {
			return http_deny(client);
		}
		let line = std::str::from_utf8(&line).map_err(invalid_data)?;
		let Some((name, value)) = line.trim_end().split_once(':') else {
			return http_deny(client);
		};
		if name.eq_ignore_ascii_case("Connection") {
			connection_tokens.extend(value.split(',').map(str::trim).map(str::to_ascii_lowercase));
		}
		if name.eq_ignore_ascii_case("Content-Length") {
			content_length = Some(value.trim().parse::<usize>().map_err(invalid_data)?);
		}
		if name.eq_ignore_ascii_case("Transfer-Encoding") {
			return http_deny(client);
		}
		headers.push((name.to_owned(), value.trim().to_owned()));
	}
	let Some(token) = headers
		.iter()
		.find(|(name, _)| name.eq_ignore_ascii_case("Proxy-Authorization"))
		.and_then(|(_, value)| http_token(value))
		.filter(|token| policy.attempt_is_active(token))
	else {
		return http_deny(client);
	};

	let mut upstream = match connect(policy, &token, &host, port) {
		Ok(stream) => stream,
		Err(_) => return http_policy_deny(client, &host, port),
	};
	if origin.is_none() {
		client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
	} else {
		write!(upstream, "{method} {} {version}\r\n", origin.as_deref().unwrap_or_default())?;
		for (name, value) in headers {
			if !name.eq_ignore_ascii_case("Host") && !is_hop_header(&name, &connection_tokens) {
				write!(upstream, "{name}: {value}\r\n")?;
			}
		}
		if host.contains(':') {
			write!(upstream, "Host: [{host}]:{port}\r\n")?;
		} else {
			write!(upstream, "Host: {host}:{port}\r\n")?;
		}
		upstream.write_all(b"\r\n")?;
		if let Some(length) = content_length {
			copy_exact(reader, &mut upstream, length)?;
		}
	}
	if origin.is_none() && !shutdown.load(Ordering::Acquire) {
		gate_tls_tunnel(reader, &mut upstream, &host, port)?;
		forward_buffered(reader, &mut upstream)?;
		relay(client, upstream)?;
	} else if origin.is_some() && !shutdown.load(Ordering::Acquire) {
		relay(client, upstream)?;
	}
	Ok(())
}

fn authority(target: &str, default_port: u16) -> Option<(String, u16)> {
	if let Some(bracketed) = target.strip_prefix('[') {
		let (host, tail) = bracketed.split_once(']')?;
		let port = tail
			.strip_prefix(':')
			.map_or(Ok(default_port), str::parse)
			.ok()?;
		return Some((host.to_owned(), port));
	}
	match target.rsplit_once(':') {
		Some((host, port)) if !host.contains(':') => Some((host.to_owned(), port.parse().ok()?)),
		_ => Some((target.to_owned(), default_port)),
	}
}

fn http_token(value: &str) -> Option<Str> {
	let encoded = value.strip_prefix("Basic ")?.trim();
	let mut decoded = vec![0; base64::STD.decode_len(encoded.len())];
	let length = base64::STD
		.decode_mut(encoded.as_bytes(), &mut decoded)
		.ok()?;
	let credential = std::str::from_utf8(&decoded[..length]).ok()?;
	let token = credential.strip_prefix("omp:")?;
	(!token.is_empty()).then(|| Str::from(token))
}

fn is_hop_header(name: &str, connection_tokens: &[String]) -> bool {
	name.eq_ignore_ascii_case("Connection")
		|| name.eq_ignore_ascii_case("Keep-Alive")
		|| name.eq_ignore_ascii_case("Proxy-Authenticate")
		|| name.eq_ignore_ascii_case("Proxy-Authorization")
		|| name.eq_ignore_ascii_case("Proxy-Connection")
		|| name.eq_ignore_ascii_case("TE")
		|| name.eq_ignore_ascii_case("Trailer")
		|| name.eq_ignore_ascii_case("Transfer-Encoding")
		|| name.eq_ignore_ascii_case("Upgrade")
		|| connection_tokens
			.iter()
			.any(|token| name.eq_ignore_ascii_case(token))
}

fn socks<S: ClientStream>(
	mut client: S,
	policy: &ProxyPolicy,
	shutdown: &AtomicBool,
) -> io::Result<()> {
	let mut count = [0_u8; 1];
	client.read_exact(&mut count)?;
	let mut methods = vec![0; usize::from(count[0])];
	client.read_exact(&mut methods)?;
	if !methods.contains(&2) {
		return client.write_all(&[5, 255]);
	}
	client.write_all(&[5, 2])?;
	let mut auth_version = [0_u8; 2];
	client.read_exact(&mut auth_version)?;
	if auth_version[0] != 1 {
		return socks_deny(client);
	}
	let username_length = usize::from(auth_version[1]);
	let mut username = vec![0; username_length];
	client.read_exact(&mut username)?;
	let mut password_length = [0_u8; 1];
	client.read_exact(&mut password_length)?;
	let mut password = vec![0; usize::from(password_length[0])];
	client.read_exact(&mut password)?;
	let token = match (std::str::from_utf8(&username).ok(), std::str::from_utf8(&password).ok()) {
		(Some("omp"), Some(token)) if !token.is_empty() => Str::from(token),
		_ => return client.write_all(&[1, 1]),
	};
	if !policy.attempt_is_active(&token) {
		return client.write_all(&[1, 1]);
	}
	client.write_all(&[1, 0])?;
	let mut head = [0_u8; 4];
	client.read_exact(&mut head)?;
	if head[0] != 5 || head[1] != 1 || head[2] != 0 {
		return socks_deny(client);
	}
	let host = match head[3] {
		1 => {
			let mut bytes = [0_u8; 4];
			client.read_exact(&mut bytes)?;
			Ipv4Addr::from(bytes).to_string()
		},
		3 => {
			let mut length = [0_u8; 1];
			client.read_exact(&mut length)?;
			let mut bytes = vec![0; usize::from(length[0])];
			client.read_exact(&mut bytes)?;
			String::from_utf8(bytes).map_err(invalid_data)?
		},
		4 => {
			let mut bytes = [0_u8; 16];
			client.read_exact(&mut bytes)?;
			std::net::Ipv6Addr::from(bytes).to_string()
		},
		_ => return socks_deny(client),
	};
	let mut port = [0_u8; 2];
	client.read_exact(&mut port)?;
	let mut upstream = match connect(policy, &token, &host, u16::from_be_bytes(port)) {
		Ok(stream) => stream,
		Err(_) => return socks_deny(client),
	};
	client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])?;
	if !shutdown.load(Ordering::Acquire) {
		gate_tls_tunnel(&mut client, &mut upstream, &host, u16::from_be_bytes(port))?;
		relay(client, upstream)?;
	}
	Ok(())
}

fn relay<S: ClientStream>(mut client: S, mut upstream: TcpStream) -> io::Result<()> {
	let mut client_to_upstream = client.duplicate()?;
	let closer = client_to_upstream.duplicate()?;
	let mut upstream_copy = upstream.try_clone()?;
	let copied = thread::Builder::new()
		.name("omp-scoped-proxy-copy".into())
		.spawn(move || io::copy(&mut client_to_upstream, &mut upstream_copy));
	let down = io::copy(&mut upstream, &mut client);
	let _ = closer.close();
	if let Ok(copied) = copied {
		let _ = copied.join();
	}
	down.map(|_| ())
}
fn gate_tls_tunnel(
	client: &mut impl Read,
	upstream: &mut TcpStream,
	host: &str,
	port: u16,
) -> io::Result<()> {
	let mut first = [0_u8; 1];
	client.read_exact(&mut first)?;
	if first[0] != 22 {
		if port == 443 {
			return Err(policy_blocked());
		}
		if !(20..=23).contains(&first[0]) {
			return upstream.write_all(&first);
		}
		let mut prefix = [first[0], 0, 0, 0, 0];
		client.read_exact(&mut prefix[1..])?;
		let version = u16::from_be_bytes([prefix[1], prefix[2]]);
		if (0x0301..=0x0304).contains(&version) {
			return Err(policy_blocked());
		}
		return upstream.write_all(&prefix);
	}

	let mut records = Vec::with_capacity(1024);
	let mut handshake_bytes: usize = 0;
	let mut client_hello_bytes = None;
	let mut first_record = true;
	loop {
		let mut header = [0_u8; 5];
		if first_record {
			header[0] = 22;
			client.read_exact(&mut header[1..])?;
			first_record = false;
		} else {
			client.read_exact(&mut header)?;
		}
		let version = u16::from_be_bytes([header[1], header[2]]);
		let length = usize::from(u16::from_be_bytes([header[3], header[4]]));
		if header[0] != 22
			|| !(0x0301..=0x0304).contains(&version)
			|| length == 0
			|| length > MAX_TLS_RECORD_BYTES
			|| records
				.len()
				.saturating_add(header.len())
				.saturating_add(length)
				> MAX_TLS_CLIENT_HELLO_BYTES
		{
			return Err(policy_blocked());
		}
		records.extend_from_slice(&header);
		let start = records.len();
		records.resize(start + length, 0);
		client.read_exact(&mut records[start..])?;
		handshake_bytes = handshake_bytes
			.checked_add(length)
			.filter(|bytes| *bytes <= MAX_TLS_CLIENT_HELLO_BYTES)
			.ok_or_else(policy_blocked)?;

		if client_hello_bytes.is_none() && handshake_bytes >= 4 {
			let mut cursor = TlsCursor::new(&records, 4)?;
			if cursor.byte()? != 1 {
				return Err(policy_blocked());
			}
			let length = (usize::from(cursor.byte()?) << 16)
				| (usize::from(cursor.byte()?) << 8)
				| usize::from(cursor.byte()?);
			let length = length
				.checked_add(4)
				.filter(|bytes| *bytes <= MAX_TLS_CLIENT_HELLO_BYTES)
				.ok_or_else(policy_blocked)?;
			client_hello_bytes = Some(length);
		}
		if let Some(length) = client_hello_bytes.filter(|length| handshake_bytes >= *length) {
			validate_tls_client_hello(&records, length, host)?;
			return upstream.write_all(&records);
		}
	}
}

fn forward_buffered<S: ClientStream>(
	reader: &mut BufReader<S>,
	upstream: &mut TcpStream,
) -> io::Result<()> {
	let length = reader.buffer().len();
	if length != 0 {
		upstream.write_all(reader.buffer())?;
		reader.consume(length);
	}
	Ok(())
}

struct TlsCursor<'a> {
	records:        &'a [u8],
	record_offset:  usize,
	payload_offset: usize,
	payload_end:    usize,
	remaining:      usize,
}

impl<'a> TlsCursor<'a> {
	fn new(records: &'a [u8], remaining: usize) -> io::Result<Self> {
		let mut cursor =
			Self { records, record_offset: 0, payload_offset: 0, payload_end: 0, remaining };
		if remaining != 0 {
			cursor.next_record()?;
		}
		Ok(cursor)
	}

	fn byte(&mut self) -> io::Result<u8> {
		if self.remaining == 0 {
			return Err(policy_blocked());
		}
		if self.payload_offset == self.payload_end {
			self.next_record()?;
		}
		let byte = self.records[self.payload_offset];
		self.payload_offset += 1;
		self.remaining -= 1;
		Ok(byte)
	}

	fn u16(&mut self) -> io::Result<usize> {
		Ok((usize::from(self.byte()?) << 8) | usize::from(self.byte()?))
	}

	fn skip(&mut self, length: usize) -> io::Result<()> {
		if length > self.remaining {
			return Err(policy_blocked());
		}
		for _ in 0..length {
			let _ = self.byte()?;
		}
		Ok(())
	}

	fn remaining(&self) -> usize {
		self.remaining
	}

	fn next_record(&mut self) -> io::Result<()> {
		let header_end = self
			.record_offset
			.checked_add(5)
			.filter(|end| *end <= self.records.len())
			.ok_or_else(policy_blocked)?;
		let header = &self.records[self.record_offset..header_end];
		let version = u16::from_be_bytes([header[1], header[2]]);
		let length = usize::from(u16::from_be_bytes([header[3], header[4]]));
		let payload_end = header_end
			.checked_add(length)
			.filter(|end| *end <= self.records.len())
			.ok_or_else(policy_blocked)?;
		if header[0] != 22 || !(0x0301..=0x0304).contains(&version) || length == 0 {
			return Err(policy_blocked());
		}
		self.record_offset = payload_end;
		self.payload_offset = header_end;
		self.payload_end = payload_end;
		Ok(())
	}
}

fn validate_tls_client_hello(records: &[u8], length: usize, host: &str) -> io::Result<()> {
	let mut cursor = TlsCursor::new(records, length)?;
	if cursor.byte()? != 1 {
		return Err(policy_blocked());
	}
	let declared = (usize::from(cursor.byte()?) << 16)
		| (usize::from(cursor.byte()?) << 8)
		| usize::from(cursor.byte()?);
	if declared.checked_add(4) != Some(length) {
		return Err(policy_blocked());
	}
	let version = cursor.u16()?;
	if !(0x0301..=0x0303).contains(&version) {
		return Err(policy_blocked());
	}
	cursor.skip(32)?;
	let session_id = usize::from(cursor.byte()?);
	if session_id > 32 {
		return Err(policy_blocked());
	}
	cursor.skip(session_id)?;
	let cipher_suites = cursor.u16()?;
	if cipher_suites == 0 || cipher_suites % 2 != 0 {
		return Err(policy_blocked());
	}
	cursor.skip(cipher_suites)?;
	let compression = usize::from(cursor.byte()?);
	if compression == 0 {
		return Err(policy_blocked());
	}
	cursor.skip(compression)?;
	let extensions = cursor.u16()?;
	if extensions != cursor.remaining() {
		return Err(policy_blocked());
	}

	let mut has_sni = false;
	while cursor.remaining() != 0 {
		let kind = cursor.u16()?;
		let extension_length = cursor.u16()?;
		if extension_length > cursor.remaining() {
			return Err(policy_blocked());
		}
		if kind != 0 {
			cursor.skip(extension_length)?;
			continue;
		}
		if has_sni {
			return Err(policy_blocked());
		}
		has_sni = true;
		validate_server_name(&mut cursor, extension_length, host)?;
	}
	if has_sni {
		Ok(())
	} else {
		Err(policy_blocked())
	}
}

fn validate_server_name(cursor: &mut TlsCursor<'_>, length: usize, host: &str) -> io::Result<()> {
	if length < 5 || length > cursor.remaining() {
		return Err(policy_blocked());
	}
	let extension_end = cursor.remaining() - length;
	let list_length = cursor.u16()?;
	if list_length != cursor.remaining() - extension_end {
		return Err(policy_blocked());
	}
	if cursor.byte()? != 0 {
		return Err(policy_blocked());
	}
	let name_length = cursor.u16()?;
	if name_length == 0 || name_length > 253 || name_length != cursor.remaining() - extension_end {
		return Err(policy_blocked());
	}

	let expected = host.trim_end_matches('.').as_bytes();
	let mut matched = expected.len() == name_length;
	let mut label_length = 0;
	let mut previous_hyphen = false;
	let mut numeric_or_dot = true;
	for index in 0..name_length {
		let byte = cursor.byte()?;
		if !byte.is_ascii() {
			return Err(policy_blocked());
		}
		if byte == b'.' {
			if label_length == 0 || previous_hyphen {
				return Err(policy_blocked());
			}
			label_length = 0;
			previous_hyphen = false;
		} else if byte.is_ascii_alphanumeric() || byte == b'-' {
			label_length += 1;
			if label_length > 63 || label_length == 1 && byte == b'-' {
				return Err(policy_blocked());
			}
			previous_hyphen = byte == b'-';
		} else {
			return Err(policy_blocked());
		}
		numeric_or_dot &= byte.is_ascii_digit() || byte == b'.';
		matched &= expected
			.get(index)
			.is_some_and(|expected| byte.eq_ignore_ascii_case(expected));
	}
	if label_length == 0 || previous_hyphen || numeric_or_dot || !matched {
		return Err(policy_blocked());
	}
	Ok(())
}

fn read_line(reader: &mut impl BufRead, line: &mut Vec<u8>, limit: usize) -> io::Result<()> {
	loop {
		let available = reader.fill_buf()?;
		if available.is_empty() {
			return Err(policy_blocked());
		}
		let consumed = available
			.iter()
			.position(|byte| *byte == b'\n')
			.map_or(available.len(), |index| index + 1);
		if line.len().saturating_add(consumed) > limit {
			return Err(policy_blocked());
		}
		line.extend_from_slice(&available[..consumed]);
		reader.consume(consumed);
		if line.last() == Some(&b'\n') {
			return Ok(());
		}
	}
}

fn copy_exact(
	reader: &mut impl Read,
	writer: &mut impl Write,
	mut remaining: usize,
) -> io::Result<()> {
	let mut buffer = [0_u8; 16 * 1024];
	while remaining != 0 {
		let chunk = remaining.min(buffer.len());
		let read = reader.read(&mut buffer[..chunk])?;
		if read == 0 {
			return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated HTTP request body"));
		}
		writer.write_all(&buffer[..read])?;
		remaining -= read;
	}
	Ok(())
}

fn invalid_data<E>(_error: E) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, "malformed proxy request")
}

fn http_deny(mut stream: impl Write) -> io::Result<()> {
	stream.write_all(
		b"HTTP/1.1 403 Forbidden\r\nX-Omp-Policy-Blocked: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
	)
}

fn http_policy_deny(mut stream: impl Write, host: &str, port: u16) -> io::Result<()> {
	write!(
		stream,
		"HTTP/1.1 403 Forbidden\r\nX-Omp-Policy-Blocked: {host}:{port}\r\nContent-Length: \
		 0\r\nConnection: close\r\n\r\n"
	)
}

fn socks_deny(mut stream: impl Write) -> io::Result<()> {
	stream.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0])
}

#[cfg(test)]
mod tests {
	use super::*;

	fn test_token() -> Str {
		Str::new_static("test-token")
	}

	fn test_attempts() -> Arc<Mutex<FastHashMap<Str, Option<(Str, u16)>>>> {
		let mut attempts = FastHashMap::default();
		attempts.insert(test_token(), None);
		Arc::new(Mutex::new(attempts))
	}

	fn socks_auth(client: &mut TcpStream) {
		client
			.write_all(&[
				1, 3, b'o', b'm', b'p', 10, b't', b'e', b's', b't', b'-', b't', b'o', b'k', b'e', b'n',
			])
			.expect("SOCKS credentials");
		let mut status = [0; 2];
		client
			.read_exact(&mut status)
			.expect("SOCKS credential status");
		assert_eq!(status, [1, 0]);
	}

	fn policy(port: u16) -> ProxyPolicy {
		ProxyPolicy {
			allow:     Arc::from([Str::from("127.0.0.1")]),
			deny:      Arc::from([]),
			ports:     Arc::from([port]),
			localhost: true,
			amendment: None,
			attempts:  test_attempts(),
		}
	}
	fn host_policy(host: &str, port: u16) -> ProxyPolicy {
		ProxyPolicy {
			allow:     Arc::from([Str::from(host)]),
			deny:      Arc::from([]),
			ports:     Arc::from([port]),
			localhost: true,
			amendment: None,
			attempts:  test_attempts(),
		}
	}

	fn client_hello(sni: Option<&str>) -> Vec<u8> {
		let mut extensions = Vec::new();
		if let Some(sni) = sni {
			let name = sni.as_bytes();
			let list_length = 3 + name.len();
			extensions.extend_from_slice(&0_u16.to_be_bytes());
			extensions.extend_from_slice(&(2 + list_length as u16).to_be_bytes());
			extensions.extend_from_slice(&(list_length as u16).to_be_bytes());
			extensions.push(0);
			extensions.extend_from_slice(&(name.len() as u16).to_be_bytes());
			extensions.extend_from_slice(name);
		}
		let mut body = Vec::new();
		body.extend_from_slice(&0x0303_u16.to_be_bytes());
		body.extend_from_slice(&[0; 32]);
		body.push(0);
		body.extend_from_slice(&2_u16.to_be_bytes());
		body.extend_from_slice(&0x1301_u16.to_be_bytes());
		body.extend_from_slice(&[1, 0]);
		body.extend_from_slice(&(extensions.len() as u16).to_be_bytes());
		body.extend_from_slice(&extensions);

		let mut handshake =
			vec![1, (body.len() >> 16) as u8, (body.len() >> 8) as u8, body.len() as u8];
		handshake.extend_from_slice(&body);
		let mut record = vec![22, 3, 3, (handshake.len() >> 8) as u8, handshake.len() as u8];
		record.extend_from_slice(&handshake);
		record
	}
	fn fragmented_client_hello(sni: &str) -> Vec<u8> {
		let hello = client_hello(Some(sni));
		let payload = &hello[5..];
		let split = 3;
		let mut records = vec![22, 3, 3, 0, split as u8];
		records.extend_from_slice(&payload[..split]);
		records.extend_from_slice(&[22, 3, 3, 0, (payload.len() - split) as u8]);
		records.extend_from_slice(&payload[split..]);
		records
	}

	fn assert_tunnel_rejected(payload: &[u8]) {
		let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("upstream");
		let address = listener.local_addr().expect("upstream address");
		let mut upstream = TcpStream::connect(address).expect("upstream connection");
		assert!(
			gate_tls_tunnel(&mut io::Cursor::new(payload), &mut upstream, "localhost", 443).is_err()
		);
		drop(upstream);
		let (mut peer, _) = listener.accept().expect("upstream peer");
		peer
			.set_read_timeout(Some(Duration::from_secs(1)))
			.expect("read timeout");
		assert_tunnel_closed(&mut peer);
	}

	fn assert_tunnel_closed(stream: &mut TcpStream) {
		let mut received = [0_u8; 1];
		match stream.read(&mut received) {
			Ok(0) => {},
			Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {},
			Ok(_) => panic!("tunnel forwarded a payload byte"),
			Err(error) => panic!("tunnel close: {error}"),
		}
	}

	fn serve_once(policy: ProxyPolicy) -> (TcpStream, thread::JoinHandle<()>) {
		let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("proxy listener");
		let address = listener.local_addr().expect("proxy address");
		let task = thread::spawn(move || {
			let (stream, _) = listener.accept().expect("proxy client");
			let _ = serve(stream, &policy, &AtomicBool::new(false));
		});
		(TcpStream::connect(address).expect("connect proxy"), task)
	}

	#[test]
	fn domain_rules_are_case_insensitive_and_wildcards_exclude_the_apex() {
		assert!(domain_matches("*.Example.test", "api.example.test"));
		assert!(!domain_matches("*.example.test", "example.test"));
		assert!(domain_matches("EXAMPLE.test", "example.test"));
	}

	#[test]
	fn deny_rules_and_ports_precede_resolution() {
		let policy = ProxyPolicy {
			allow:     Arc::from([Str::from("example.test")]),
			deny:      Arc::from([Str::from("example.test")]),
			ports:     Arc::from([443]),
			localhost: false,
			amendment: None,
			attempts:  test_attempts(),
		};
		assert_eq!(
			policy
				.authorize(&test_token(), "example.test", 443)
				.expect_err("deny")
				.kind(),
			io::ErrorKind::PermissionDenied
		);
		assert_eq!(
			policy
				.authorize(&test_token(), "example.test", 80)
				.expect_err("port")
				.kind(),
			io::ErrorKind::PermissionDenied
		);
	}

	#[test]
	fn localhost_grant_only_allows_literal_loopback_addresses() {
		for address in [
			IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
			IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
			IpAddr::V4(Ipv4Addr::new(100, 100, 100, 200)),
			IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
			IpAddr::V4(Ipv4Addr::new(168, 63, 129, 16)),
			IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
			IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1)),
			IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
			IpAddr::V4(Ipv4Addr::UNSPECIFIED),
			IpAddr::V6("fd00::1".parse().expect("unique local")),
			IpAddr::V6("fe80::1".parse().expect("link local")),
			IpAddr::V6("ff00::1".parse().expect("multicast")),
			IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED),
		] {
			assert!(!globally_routable(address));
			assert!(!authorized_address(address, true));
		}
		assert!(authorized_address(IpAddr::V4(Ipv4Addr::LOCALHOST), true));
		assert!(authorized_address(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST), true));
		assert!(!authorized_address(IpAddr::V4(Ipv4Addr::LOCALHOST), false));
		assert!(authorized_address(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), false));
	}

	#[test]
	fn authority_parses_bracketed_ipv6_without_reresolution_shape() {
		assert_eq!(authority("[2001:db8::1]:8443", 443), Some(("2001:db8::1".into(), 8443)));
	}

	#[test]
	fn proxy_headers_are_removed() {
		assert!(is_hop_header("Proxy-Authorization", &[]));
		assert!(is_hop_header("X-Connection-Scoped", &["x-connection-scoped".into()]));
	}

	#[test]
	fn http_forward_rewrites_host_from_authorized_target() {
		let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("upstream");
		let port = upstream.local_addr().expect("upstream address").port();
		let upstream_task = thread::spawn(move || {
			let (stream, _) = upstream.accept().expect("upstream client");
			let mut reader = BufReader::new(stream.try_clone().expect("clone"));
			let mut request = String::new();
			loop {
				let mut line = String::new();
				reader.read_line(&mut line).expect("request line");
				if line == "\r\n" {
					break;
				}
				request.push_str(&line);
			}
			assert!(request.starts_with("GET /path?q=1 HTTP/1.1"));
			assert!(!request.to_ascii_lowercase().contains("proxy-authorization"));
			assert_eq!(
				request
					.lines()
					.filter(|line| line.to_ascii_lowercase().starts_with("host:"))
					.count(),
				1
			);
			assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
			assert!(!request.contains("Host: denied.example"));
			let mut stream = stream;
			stream
				.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
				.expect("response");
		});
		let (mut client, proxy) = serve_once(policy(port));
		write!(
			client,
			"GET http://127.0.0.1:{port}/path?q=1 HTTP/1.1\r\nProxy-Authorization: Basic \
			 b21wOnRlc3QtdG9rZW4=\r\nHost: denied.example\r\nHOST: another-denied.example\r\n\r\n"
		)
		.expect("request");
		let mut response = String::new();
		client.read_to_string(&mut response).expect("response");
		assert!(response.starts_with("HTTP/1.1 204"));
		drop(client);
		upstream_task.join().expect("upstream task");
		proxy.join().expect("proxy task");
	}

	#[test]
	fn socks_policy_rejection_uses_rule_denied_reply() {
		let (mut client, proxy) = serve_once(policy(443));
		client.write_all(&[5, 1, 2]).expect("socks greeting");
		let mut selected = [0; 2];
		client.read_exact(&mut selected).expect("socks selection");
		assert_eq!(selected, [5, 2]);
		socks_auth(&mut client);
		client
			.write_all(&[5, 1, 0, 3, 9, b'1', b'2', b'7', b'.', b'0', b'.', b'0', b'.', b'1', 0, 80])
			.expect("socks request");
		let mut reply = [0; 10];
		client.read_exact(&mut reply).expect("socks denial");
		assert_eq!(reply[1], 2);
		drop(client);
		proxy.join().expect("proxy task");
	}

	#[test]
	fn connect_and_socks5_tunnel_only_after_policy_approval() {
		let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("upstream");
		let port = upstream.local_addr().expect("upstream address").port();
		let upstream_task = thread::spawn(move || {
			for expected in [b"connect".as_slice(), b"socks".as_slice()] {
				let (mut stream, _) = upstream.accept().expect("upstream client");
				let mut received = vec![0; expected.len()];
				stream.read_exact(&mut received).expect("tunnel bytes");
				assert_eq!(received, expected);
				stream.write_all(expected).expect("tunnel reply");
			}
		});

		let (mut connect, proxy) = serve_once(policy(port));
		write!(
			connect,
			"CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic \
			 b21wOnRlc3QtdG9rZW4=\r\nHost: 127.0.0.1:{port}\r\n\r\n"
		)
		.expect("connect request");
		let mut reply = [0; 39];
		connect.read_exact(&mut reply).expect("connect reply");
		assert!(
			std::str::from_utf8(&reply)
				.expect("reply text")
				.starts_with("HTTP/1.1 200")
		);
		connect.write_all(b"connect").expect("connect tunnel");
		let mut echoed = [0; 7];
		connect.read_exact(&mut echoed).expect("connect echo");
		assert_eq!(&echoed, b"connect");
		drop(connect);
		proxy.join().expect("connect proxy");

		let (mut socks, proxy) = serve_once(policy(port));
		socks.write_all(&[5, 1, 2]).expect("socks greeting");
		let mut selected = [0; 2];
		socks.read_exact(&mut selected).expect("socks selection");
		assert_eq!(selected, [5, 2]);
		socks_auth(&mut socks);
		socks
			.write_all(&[
				5,
				1,
				0,
				3,
				9,
				b'1',
				b'2',
				b'7',
				b'.',
				b'0',
				b'.',
				b'0',
				b'.',
				b'1',
				(port >> 8) as u8,
				port as u8,
			])
			.expect("socks connect");
		let mut accepted = [0; 10];
		socks.read_exact(&mut accepted).expect("socks reply");
		assert_eq!(accepted[1], 0);
		socks.write_all(b"socks").expect("socks tunnel");
		let mut echoed = [0; 5];
		socks.read_exact(&mut echoed).expect("socks echo");
		assert_eq!(&echoed, b"socks");
		drop(socks);
		proxy.join().expect("socks proxy");
		upstream_task.join().expect("upstream task");
	}

	#[test]
	fn connect_tunnel_accepts_a_fragmented_matching_tls_client_hello() {
		let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("upstream");
		let port = upstream.local_addr().expect("upstream address").port();
		let hello = fragmented_client_hello("LoCaLhOsT");
		let expected = hello.clone();
		let upstream_task = thread::spawn(move || {
			let (mut stream, _) = upstream.accept().expect("upstream client");
			let mut received = vec![0; expected.len()];
			stream.read_exact(&mut received).expect("TLS ClientHello");
			assert_eq!(received, expected);
			stream.write_all(b"ok").expect("upstream reply");
		});

		let (mut client, proxy) = serve_once(host_policy("localhost", port));
		write!(
			client,
			"CONNECT localhost:{port} HTTP/1.1\r\nProxy-Authorization: Basic \
			 b21wOnRlc3QtdG9rZW4=\r\nHost: localhost:{port}\r\n\r\n"
		)
		.expect("CONNECT request");
		let mut reply = [0; 39];
		client.read_exact(&mut reply).expect("CONNECT success");
		let split = hello.len() / 2;
		client.write_all(&hello[..split]).expect("first fragment");
		thread::sleep(Duration::from_millis(10));
		client.write_all(&hello[split..]).expect("second fragment");
		let mut echoed = [0; 2];
		client.read_exact(&mut echoed).expect("upstream reply");
		assert_eq!(&echoed, b"ok");
		drop(client);
		proxy.join().expect("proxy task");
		upstream_task.join().expect("upstream task");
	}

	#[test]
	fn socks_tunnel_accepts_a_matching_tls_client_hello() {
		let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("upstream");
		let port = upstream.local_addr().expect("upstream address").port();
		let hello = client_hello(Some("localhost"));
		let expected = hello.clone();
		let upstream_task = thread::spawn(move || {
			let (mut stream, _) = upstream.accept().expect("upstream client");
			let mut received = vec![0; expected.len()];
			stream.read_exact(&mut received).expect("TLS ClientHello");
			assert_eq!(received, expected);
			stream.write_all(b"ok").expect("upstream reply");
		});

		let (mut client, proxy) = serve_once(host_policy("localhost", port));
		client.write_all(&[5, 1, 2]).expect("SOCKS greeting");
		let mut selected = [0; 2];
		client.read_exact(&mut selected).expect("SOCKS selection");
		assert_eq!(selected, [5, 2]);
		socks_auth(&mut client);
		client
			.write_all(&[
				5,
				1,
				0,
				3,
				9,
				b'l',
				b'o',
				b'c',
				b'a',
				b'l',
				b'h',
				b'o',
				b's',
				b't',
				(port >> 8) as u8,
				port as u8,
			])
			.expect("SOCKS request");
		let mut accepted = [0; 10];
		client.read_exact(&mut accepted).expect("SOCKS success");
		assert_eq!(accepted[1], 0);
		client.write_all(&hello).expect("TLS ClientHello");
		let mut echoed = [0; 2];
		client.read_exact(&mut echoed).expect("upstream reply");
		assert_eq!(&echoed, b"ok");
		drop(client);
		proxy.join().expect("proxy task");
		upstream_task.join().expect("upstream task");
	}

	#[test]
	fn mismatched_tunnel_sni_reaches_the_shared_address_with_no_payload() {
		let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("upstream");
		let port = upstream.local_addr().expect("upstream address").port();
		let upstream_task = thread::spawn(move || {
			for _ in 0..2 {
				let (mut stream, _) = upstream.accept().expect("upstream client");
				stream
					.set_read_timeout(Some(Duration::from_secs(1)))
					.expect("read timeout");
				assert_tunnel_closed(&mut stream);
			}
		});
		let hello = client_hello(Some("denied.localhost"));

		let (mut connect, proxy) = serve_once(host_policy("localhost", port));
		write!(
			connect,
			"CONNECT localhost:{port} HTTP/1.1\r\nProxy-Authorization: Basic \
			 b21wOnRlc3QtdG9rZW4=\r\nHost: localhost:{port}\r\n\r\n"
		)
		.expect("CONNECT request");
		let mut reply = [0; 39];
		connect.read_exact(&mut reply).expect("CONNECT success");
		connect.write_all(&hello).expect("mismatched ClientHello");
		assert_tunnel_closed(&mut connect);
		drop(connect);
		proxy.join().expect("CONNECT proxy");

		let (mut socks, proxy) = serve_once(host_policy("localhost", port));
		socks.write_all(&[5, 1, 2]).expect("SOCKS greeting");
		let mut selected = [0; 2];
		socks.read_exact(&mut selected).expect("SOCKS selection");
		assert_eq!(selected, [5, 2]);
		socks_auth(&mut socks);
		socks
			.write_all(&[
				5,
				1,
				0,
				3,
				9,
				b'l',
				b'o',
				b'c',
				b'a',
				b'l',
				b'h',
				b'o',
				b's',
				b't',
				(port >> 8) as u8,
				port as u8,
			])
			.expect("SOCKS request");
		let mut accepted = [0; 10];
		socks.read_exact(&mut accepted).expect("SOCKS success");
		socks.write_all(&hello).expect("mismatched ClientHello");
		assert_tunnel_closed(&mut socks);
		drop(socks);
		proxy.join().expect("SOCKS proxy");
		upstream_task.join().expect("upstream task");
	}

	#[test]
	fn missing_malformed_and_oversized_tls_client_hellos_are_not_forwarded() {
		assert_tunnel_rejected(b"opaque");
		assert_tunnel_rejected(&client_hello(None));
		assert_tunnel_rejected(&client_hello(Some("127.0.0.1")));
		assert_tunnel_rejected(&[22, 3, 3, 0, 4, 1, 0, 0, 0]);
		assert_tunnel_rejected(&[22, 3, 3, 0, 4, 1, 1, 0, 0]);
	}

	#[test]
	fn headers_are_bounded_cumulatively_and_by_count() {
		let (mut client, proxy) = serve_once(policy(80));
		let path = "x".repeat(MAX_HEADER_BYTES - 48);
		write!(
			client,
			"GET http://127.0.0.1:80/{path} HTTP/1.1\r\nX-Overflow: retained-never\r\n\r\n"
		)
		.expect("oversized aggregate request");
		let mut response = Vec::new();
		let _ = client.read_to_end(&mut response);
		assert!(response.is_empty());
		drop(client);
		proxy.join().expect("aggregate proxy");

		let (mut client, proxy) = serve_once(policy(80));
		write!(client, "GET http://127.0.0.1:80/ HTTP/1.1\r\n").expect("request line");
		for index in 0..=MAX_HEADER_COUNT {
			write!(client, "X-{index}: value\r\n").expect("header");
		}
		client.write_all(b"\r\n").expect("header terminator");
		let mut response = String::new();
		client
			.read_to_string(&mut response)
			.expect("header count response");
		assert!(response.starts_with("HTTP/1.1 403"));
		drop(client);
		proxy.join().expect("header count proxy");
	}

	#[test]
	fn http_basic_auth_requires_the_omp_capability_shape() {
		assert_eq!(http_token("Basic b21wOnRlc3Q=").as_deref(), Some("test"));
		assert_eq!(http_token("Basic b3RoZXI6dGVzdA="), None);
		assert_eq!(http_token("Basic not-base64"), None);
		assert_eq!(http_token("Bearer token"), None);
	}

	#[test]
	fn attempt_registry_is_bounded_and_invalidates_evicted_capabilities() {
		let proxy = ScopedProxy::start(&SandboxSettings::default()).expect("broker");
		for _ in 0..=MAX_ATTEMPTS {
			proxy.begin_attempt();
		}
		assert!(proxy.attempts.lock().len() <= MAX_ATTEMPTS);
	}

	#[test]
	fn broker_denials_are_scoped_to_one_attempt() {
		let proxy = ScopedProxy::start(&SandboxSettings::default()).expect("broker");
		let first = proxy.begin_attempt();
		let second = proxy.begin_attempt();
		let policy =
			ProxyPolicy::from_settings(&SandboxSettings::default(), None, Arc::clone(&proxy.attempts));
		assert!(policy.authorize(&first, "blocked.example", 443).is_err());
		assert_eq!(proxy.finish_attempt(&first), Some((Str::from("blocked.example"), 443)));
		assert!(policy.authorize(&first, "delayed.example", 443).is_err());
		assert!(policy.authorize(&second, "current.example", 443).is_err());
		assert_eq!(proxy.finish_attempt(&second), Some((Str::from("current.example"), 443)));
	}

	#[test]
	fn broker_owns_its_listener_lifetime() {
		let settings = SandboxSettings::default();
		let proxy = ScopedProxy::start(&settings).expect("broker");
		assert_ne!(proxy.port(), 0);
		#[cfg(target_os = "linux")]
		let endpoint = proxy.socket().to_path_buf();
		#[cfg(target_os = "linux")]
		assert!(endpoint.exists());
		drop(proxy);
		#[cfg(target_os = "linux")]
		assert!(!endpoint.exists());
	}

	#[test]
	fn connection_limit_is_bounded() {
		assert_eq!(MAX_CONNECTIONS, 32);
		assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(30));
		assert_eq!(IDLE_TIMEOUT, Duration::from_secs(30));
	}
}
