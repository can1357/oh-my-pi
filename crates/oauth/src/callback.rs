use std::{
	fmt, io, mem,
	net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
	str,
	time::Duration,
};

use omp_core::{SecretString, Str, ct_eq};
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	net::{TcpListener, TcpStream},
	time,
};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};
use zeroize::Zeroizing;

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// Validates a browser redirect against its local HTTP callback listener.
///
/// HTTPS redirects are permitted only as TLS-terminator frontends with an
/// exact path match and a distinct externally terminated socket.
pub fn validate_redirect_pair(
	redirect_uri: &str,
	listener_uri: &str,
) -> Result<(), CallbackBindError> {
	let redirect = Url::parse(redirect_uri).map_err(|_| CallbackBindError::InvalidRedirect)?;
	let listener = Url::parse(listener_uri).map_err(|_| CallbackBindError::InvalidRedirect)?;
	if listener.scheme() != "http"
		|| !is_loopback_host(listener.host())
		|| !listener.username().is_empty()
		|| listener.password().is_some()
		|| !redirect.username().is_empty()
		|| redirect.password().is_some()
		|| listener.fragment().is_some()
		|| redirect.fragment().is_some()
		|| !matches!(redirect.scheme(), "http" | "https")
		|| redirect.path() != listener.path()
	{
		return Err(CallbackBindError::InvalidRedirect);
	}
	if redirect.scheme() == "http" {
		if !is_loopback_host(redirect.host()) || redirect != listener {
			return Err(CallbackBindError::InvalidRedirect);
		}
	} else if is_loopback_host(redirect.host())
		&& redirect.port_or_known_default() == listener.port_or_known_default()
	{
		return Err(CallbackBindError::InvalidRedirect);
	}
	Ok(())
}

const fn is_loopback_host(host: Option<Host<&str>>) -> bool {
	match host {
		Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
		Some(Host::Ipv4(address)) => address.is_loopback(),
		Some(Host::Ipv6(address)) => address.is_loopback(),
		None => false,
	}
}

/// A validated authorization code returned by a loopback callback.
pub struct CallbackGrant {
	/// Authorization code.
	pub code:  SecretString,
	/// Validated public state value.
	pub state: Str,
}

impl fmt::Debug for CallbackGrant {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CallbackGrant")
			.field("code", &"[REDACTED]")
			.field("state", &"[REDACTED]")
			.finish()
	}
}

/// Bound loopback callback listener for one authorization attempt.
pub struct LoopbackCallback {
	listeners: CallbackListeners,
	path:      Str,
	state:     Str,
	timeout:   Duration,
}

impl LoopbackCallback {
	/// Binds an exact loopback HTTP redirect URI. HTTPS callbacks must be
	/// terminated externally and forwarded to a separately configured HTTP URI.
	pub async fn bind(redirect_uri: &str, expected_state: &str) -> Result<Self, CallbackBindError> {
		let url = Url::parse(redirect_uri).map_err(|_| CallbackBindError::InvalidRedirect)?;
		if url.scheme() != "http" {
			return Err(CallbackBindError::InvalidRedirect);
		}
		let port = url
			.port_or_known_default()
			.ok_or(CallbackBindError::InvalidRedirect)?;
		let host = url.host().ok_or(CallbackBindError::InvalidRedirect)?;
		let listeners = match host {
			Host::Domain(host) if host.eq_ignore_ascii_case("localhost") => {
				CallbackListeners::localhost(port).await?
			},
			Host::Ipv4(address) if address.is_loopback() => {
				CallbackListeners::one(SocketAddr::new(IpAddr::V4(address), port)).await?
			},
			Host::Ipv6(address) if address.is_loopback() => {
				CallbackListeners::one(SocketAddr::new(IpAddr::V6(address), port)).await?
			},
			_ => return Err(CallbackBindError::InvalidRedirect),
		};
		Ok(Self {
			listeners,
			path: Str::from(url.path()),
			state: Str::from(expected_state),
			timeout: CALLBACK_TIMEOUT,
		})
	}

	/// Overrides the bounded callback deadline for an embedding application.
	pub const fn with_timeout(mut self, timeout: Duration) -> Self {
		self.timeout = timeout;
		self
	}

	/// Waits for one valid callback, caller cancellation, or the five-minute
	/// protocol deadline. Invalid paths and malformed requests are rejected and
	/// do not consume the authorization attempt.
	pub async fn receive(self, cancel: &CancellationToken) -> Result<CallbackGrant, CallbackError> {
		let deadline = time::sleep(self.timeout);
		tokio::pin!(deadline);
		loop {
			let mut stream = tokio::select! {
				biased;
				() = cancel.cancelled() => return Err(CallbackError::Cancelled),
				() = &mut deadline => return Err(CallbackError::TimedOut),
				accepted = self.listeners.accept() => accepted?,
			};
			let target = if let Ok(target) = read_request_target(&mut stream).await {
				target
			} else {
				let _ = write_response(&mut stream, 400, "Bad Request").await;
				continue;
			};
			let (path, query) = target.split_once('?').unwrap_or((&target, ""));
			if path != self.path.as_str() {
				write_response(&mut stream, 404, "Not Found").await?;
				continue;
			}
			let mut code = query_value(query, "code")?.ok_or(CallbackError::MissingCode)?;
			let state = query_value(query, "state")?.ok_or(CallbackError::StateMismatch)?;
			if !ct_eq(state.as_bytes(), self.state.as_bytes()) {
				write_response(&mut stream, 400, "State mismatch").await?;
				return Err(CallbackError::StateMismatch);
			}
			write_response(&mut stream, 200, "Authorization complete. You may close this window.")
				.await?;
			return Ok(CallbackGrant {
				code:  SecretString::from(mem::take(&mut *code)),
				state: Str::from(state.as_str()),
			});
		}
	}
}

/// Loopback callback bind failure.
#[derive(Debug, thiserror::Error)]
pub enum CallbackBindError {
	/// Redirect is not an exact loopback HTTP URI.
	#[error("OAuth callback redirect URI is invalid")]
	InvalidRedirect,
	/// Callback socket could not be bound.
	#[error("OAuth callback socket could not be bound")]
	Bind {
		/// Socket error.
		#[source]
		source: io::Error,
	},
}

impl From<io::Error> for CallbackBindError {
	fn from(source: io::Error) -> Self {
		Self::Bind { source }
	}
}

/// Callback attempt failed with secret-free evidence.
#[derive(Debug, thiserror::Error)]
pub enum CallbackError {
	/// Callback was cancelled by its caller.
	#[error("OAuth callback was cancelled")]
	Cancelled,
	/// Callback exceeded the bounded authorization deadline.
	#[error("OAuth callback timed out")]
	TimedOut,
	/// Request omitted an authorization code.
	#[error("OAuth callback omitted the authorization code")]
	MissingCode,
	/// Callback state did not match the authorization attempt.
	#[error("OAuth callback state did not match")]
	StateMismatch,
	/// Callback query was malformed.
	#[error("OAuth callback query is malformed")]
	MalformedQuery,
	/// Callback socket failed.
	#[error(transparent)]
	Io(#[from] io::Error),
}

struct CallbackListeners {
	primary:   TcpListener,
	companion: Option<TcpListener>,
}

impl CallbackListeners {
	async fn one(address: SocketAddr) -> Result<Self, CallbackBindError> {
		Ok(Self { primary: TcpListener::bind(address).await?, companion: None })
	}

	async fn localhost(port: u16) -> Result<Self, CallbackBindError> {
		let primary = TcpListener::bind(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)).await?;
		let companion = TcpListener::bind(SocketAddr::new(Ipv6Addr::LOCALHOST.into(), port))
			.await
			.ok();
		Ok(Self { primary, companion })
	}

	async fn accept(&self) -> io::Result<TcpStream> {
		if let Some(companion) = &self.companion {
			tokio::select! {
				accepted = self.primary.accept() => accepted.map(|(stream, _)| stream),
				accepted = companion.accept() => accepted.map(|(stream, _)| stream),
			}
		} else {
			self.primary.accept().await.map(|(stream, _)| stream)
		}
	}
}

fn query_value(query: &str, wanted: &str) -> Result<Option<Zeroizing<String>>, CallbackError> {
	for field in query.split('&').filter(|field| !field.is_empty()) {
		let (name, value) = field.split_once('=').unwrap_or((field, ""));
		let name = decode_form_component(name)?;
		if name.as_str() == wanted {
			return decode_form_component(value).map(Some);
		}
	}
	Ok(None)
}

fn decode_form_component(value: &str) -> Result<Zeroizing<String>, CallbackError> {
	let decoded = url::form_urlencoded::parse(value.as_bytes())
		.next()
		.map(|(value, _)| value.into_owned())
		.ok_or(CallbackError::MalformedQuery)?;
	Ok(Zeroizing::new(decoded))
}

async fn read_request_target(stream: &mut TcpStream) -> io::Result<Zeroizing<String>> {
	let mut request = Zeroizing::new([0_u8; MAX_REQUEST_BYTES]);
	let mut length = 0;
	loop {
		if length == request.len() {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "request headers too large"));
		}
		let read = stream.read(&mut request[length..]).await?;
		if read == 0 {
			return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "incomplete request"));
		}
		length += read;
		if request[..length]
			.windows(4)
			.any(|window| window == b"\r\n\r\n")
		{
			break;
		}
	}
	let request = str::from_utf8(&request[..length])
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request is not UTF-8"))?;
	let mut line = request
		.lines()
		.next()
		.unwrap_or_default()
		.split_ascii_whitespace();
	if line.next() != Some("GET") {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "request method is not GET"));
	}
	line
		.next()
		.filter(|target| target.starts_with('/'))
		.map(|target| Zeroizing::new(target.to_owned()))
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "request target is invalid"))
}

async fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
	use fmt::Write as _;
	let reason = if status == 200 {
		"OK"
	} else if status == 404 {
		"Not Found"
	} else {
		"Bad Request"
	};
	let mut response = String::with_capacity(body.len() + 128);
	write!(
		response,
		"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \
		 {}\r\nConnection: close\r\n\r\n{body}",
		body.len()
	)
	.map_err(io::Error::other)?;
	stream.write_all(response.as_bytes()).await?;
	stream.shutdown().await
}
