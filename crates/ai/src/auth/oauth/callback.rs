use std::{
	io, mem,
	net::{Ipv4Addr, Ipv6Addr, SocketAddr},
	str,
	time::Duration,
};

use omp_core::{ExposeSecret as _, SecretString, Str};
use serde::Serialize;
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	net::{TcpListener, TcpStream},
	sync::watch::Receiver,
	time,
};
use zeroize::Zeroizing;

use super::{OAuthError, callback_code, decode_form_component};
use crate::{auth::login::LoginDriver, call::AuthInput};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const OAUTH_HTML: &str = include_str!("oauth.html");
const STATE_MARKER: &str = "__OAUTH_STATE__";

mod callback_server {
	use std::net::{IpAddr, SocketAddr};

	use flume::Receiver;
	use tokio::sync::watch;
	use url::{Host, Url};

	use super::{CallbackBindError, CallbackListeners, CallbackOutcome, OAuthError, Str, serve};

	/// A successfully bound loopback callback listener.
	pub(in crate::auth::oauth) struct CallbackServer {
		result:            Receiver<CallbackOutcome>,
		shutdown:          watch::Sender<()>,
		authorization_url: watch::Sender<Option<Str>>,
		launch_url:        Str,
	}

	impl CallbackServer {
		/// Binds the HTTP redirect URI when it addresses the local loopback.
		///
		/// An empty expected state supports providers whose callback omits state;
		/// the PKCE verifier remains the authorization-code binding.
		pub(in crate::auth::oauth) async fn bind(
			redirect_uri: &str,
			expected_state: &str,
		) -> Result<Option<Self>, CallbackBindError> {
			let mut url = Url::parse(redirect_uri).map_err(|_| CallbackBindError::InvalidRedirect)?;
			if url.scheme() != "http" {
				return Ok(None);
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
				_ => return Ok(None),
			};
			let bound_port = listeners.port()?;
			url.set_port(Some(bound_port))
				.map_err(|()| CallbackBindError::InvalidRedirect)?;
			let callback_path = url.path().to_owned();
			let callback_origin = url.origin().ascii_serialization();
			url.set_path("/launch");
			url.set_query(None);
			url.set_fragment(None);
			let launch_url = Str::new(url.as_str());
			let expected_state = expected_state.to_owned();
			let (sender, result) = flume::bounded(1);
			let (shutdown, shutdown_receiver) = watch::channel(());
			let (authorization_url, authorization_url_receiver) = watch::channel(None);
			tokio::spawn(async move {
				serve(
					listeners,
					&callback_path,
					&callback_origin,
					&expected_state,
					&sender,
					shutdown_receiver,
					authorization_url_receiver,
				)
				.await;
			});
			Ok(Some(Self { result, shutdown, authorization_url, launch_url }))
		}

		pub(in crate::auth::oauth) fn arm(&self, authorization_url: Str) {
			self.authorization_url.send_replace(Some(authorization_url));
		}

		pub(in crate::auth::oauth) fn launch_url(&self) -> Str {
			self.launch_url.clone()
		}

		pub(super) async fn receive(&self) -> Result<CallbackOutcome, OAuthError> {
			self
				.result
				.recv_async()
				.await
				.map_err(|_| OAuthError::CallbackUnavailable)
		}
	}

	impl Drop for CallbackServer {
		fn drop(&mut self) {
			let _ = self.shutdown.send(());
		}
	}
}

pub(super) use callback_server::CallbackServer;

/// Loopback callback bind failure. Callers deliberately degrade to manual
/// paste.
#[derive(Debug, thiserror::Error)]
pub(super) enum CallbackBindError {
	/// Redirect URI has no usable HTTP socket address.
	#[error("OAuth callback redirect URI is invalid")]
	InvalidRedirect,
	/// The callback socket could not be bound.
	#[error("OAuth callback socket could not be bound")]
	Bind {
		#[source]
		source: io::Error,
	},
}

impl From<io::Error> for CallbackBindError {
	fn from(source: io::Error) -> Self {
		Self::Bind { source }
	}
}

enum CallbackOutcome {
	Callback(SecretString),
	Denied,
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
		let companion_address =
			SocketAddr::new(Ipv6Addr::LOCALHOST.into(), primary.local_addr()?.port());
		let companion = match TcpListener::bind(companion_address).await {
			Ok(listener) => Some(listener),
			Err(error) if error.kind() == io::ErrorKind::AddrInUse => return Err(error.into()),
			Err(_) => None,
		};
		Ok(Self { primary, companion })
	}

	fn port(&self) -> io::Result<u16> {
		self.primary.local_addr().map(|address| address.port())
	}

	async fn accept(&self, shutdown: &mut Receiver<()>) -> Option<io::Result<TcpStream>> {
		if let Some(companion) = &self.companion {
			tokio::select! {
				biased;
				_ = shutdown.changed() => None,
				accepted = self.primary.accept() => Some(accepted.map(|(stream, _)| stream)),
				accepted = companion.accept() => Some(accepted.map(|(stream, _)| stream)),
			}
		} else {
			tokio::select! {
				biased;
				_ = shutdown.changed() => None,
				accepted = self.primary.accept() => Some(accepted.map(|(stream, _)| stream)),
			}
		}
	}
}

async fn serve(
	listeners: CallbackListeners,
	callback_path: &str,
	callback_origin: &str,
	expected_state: &str,
	result: &flume::Sender<CallbackOutcome>,
	mut shutdown: Receiver<()>,
	authorization_url: Receiver<Option<Str>>,
) {
	while let Some(accepted) = listeners.accept(&mut shutdown).await {
		let Ok(mut stream) = accepted else {
			continue;
		};
		let Ok(request_target) = read_request_target(&mut stream).await else {
			let _ = write_plain(&mut stream, 400, "Bad Request").await;
			continue;
		};
		let path = request_target
			.split_once('?')
			.map_or(request_target.as_str(), |(path, _)| path);
		if path == "/launch" {
			let authorization_url = authorization_url.borrow().clone();
			if let Some(authorization_url) = authorization_url {
				let _ = write_redirect(&mut stream, &authorization_url).await;
			} else {
				let _ = write_plain(&mut stream, 503, "Authorization URL is not ready").await;
			}
			continue;
		}
		if path != callback_path {
			let _ = write_plain(&mut stream, 404, "Not Found").await;
			continue;
		}

		let mut callback =
			Zeroizing::new(String::with_capacity(callback_origin.len() + request_target.len()));
		callback.push_str(callback_origin);
		callback.push_str(&request_target);
		let callback = SecretString::from(mem::take(&mut *callback));
		let decision = callback_decision(&callback, expected_state);
		let (status, page, outcome) = match decision {
			CallbackDecision::Success { code, state } => (
				200,
				render_page(&PageState::Success {
					ok:    true,
					code:  code.expose_secret(),
					state: state.as_str(),
				}),
				Some(CallbackOutcome::Callback(callback)),
			),
			CallbackDecision::Denied { message, trusted } => (
				500,
				render_page(&PageState::Failure { ok: false, error: &message }),
				trusted.then_some(CallbackOutcome::Denied),
			),
			CallbackDecision::Invalid(message) => {
				(500, render_page(&PageState::Failure { ok: false, error: message }), None)
			},
		};
		if write_html(&mut stream, status, &page).await.is_err() {
			continue;
		}
		if let Some(outcome) = outcome {
			let _ = result.send(outcome);
			return;
		}
	}
}

enum CallbackDecision {
	Success { code: SecretString, state: Zeroizing<String> },
	Denied { message: String, trusted: bool },
	Invalid(&'static str),
}

fn callback_decision(callback: &SecretString, expected_state: &str) -> CallbackDecision {
	let query = callback
		.expose_secret()
		.split_once('?')
		.map_or("", |(_, query)| query.split('#').next().unwrap_or_default());
	let error = query_value(query, "error")
		.ok()
		.flatten()
		.filter(|value| !value.is_empty());
	let state = query_value(query, "state").ok().flatten();
	if let Some(error) = error {
		let description = query_value(query, "error_description")
			.ok()
			.flatten()
			.filter(|value| !value.is_empty())
			.unwrap_or(error);
		let trusted = expected_state.is_empty()
			|| state
				.as_ref()
				.is_some_and(|state| state.as_str() == expected_state);
		return CallbackDecision::Denied {
			message: format!("Authorization failed: {}", description.as_str()),
			trusted,
		};
	}
	match callback_code(callback, expected_state) {
		Ok(code) => CallbackDecision::Success {
			code,
			state: state.unwrap_or_else(|| Zeroizing::new(String::new())),
		},
		Err(OAuthError::StateMismatch) => {
			CallbackDecision::Invalid("State mismatch - possible CSRF attack")
		},
		Err(_) => CallbackDecision::Invalid("Missing authorization code"),
	}
}

fn query_value(query: &str, wanted: &str) -> Result<Option<Zeroizing<String>>, OAuthError> {
	for field in query.split('&').filter(|field| !field.is_empty()) {
		let (name, value) = field.split_once('=').unwrap_or((field, ""));
		if decode_form_component(name)?.as_str() == wanted {
			return decode_form_component(value).map(Some);
		}
	}
	Ok(None)
}

#[derive(Serialize)]
#[serde(untagged)]
enum PageState<'a> {
	Success { ok: bool, code: &'a str, state: &'a str },
	Failure { ok: bool, error: &'a str },
}

fn render_page(state: &PageState<'_>) -> String {
	let state = serde_json::to_string(state).expect("OAuth page state is always serializable");
	OAUTH_HTML.replacen(STATE_MARKER, &state, 1)
}

async fn read_request_target(stream: &mut TcpStream) -> io::Result<String> {
	let mut request = [0_u8; MAX_REQUEST_BYTES];
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
	let mut request_line = request
		.lines()
		.next()
		.unwrap_or_default()
		.split_ascii_whitespace();
	if request_line.next() != Some("GET") {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "request method is not GET"));
	}
	let target = request_line
		.next()
		.filter(|target| target.starts_with('/'))
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "request target is invalid"))?;
	Ok(target.to_owned())
}

async fn write_plain(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
	write_response(stream, status, "text/plain; charset=utf-8", body).await
}

async fn write_html(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
	write_response(stream, status, "text/html; charset=utf-8", body).await
}

async fn write_redirect(stream: &mut TcpStream, location: &str) -> io::Result<()> {
	use std::fmt::Write as _;

	let mut header = String::with_capacity(128 + location.len());
	write!(
		header,
		"HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: \
		 close\r\nCache-Control: no-store\r\n\r\n"
	)
	.expect("writing to a String cannot fail");
	stream.write_all(header.as_bytes()).await?;
	stream.shutdown().await
}

async fn write_response(
	stream: &mut TcpStream,
	status: u16,
	content_type: &str,
	body: &str,
) -> io::Result<()> {
	use std::fmt::Write as _;

	let reason = match status {
		200 => "OK",
		400 => "Bad Request",
		404 => "Not Found",
		503 => "Service Unavailable",
		_ => "Internal Server Error",
	};
	let mut header = String::with_capacity(128);
	write!(
		header,
		"HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: \
		 {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
		body.len()
	)
	.expect("writing to a String cannot fail");
	stream.write_all(header.as_bytes()).await?;
	stream.write_all(body.as_bytes()).await?;
	stream.shutdown().await
}

/// Waits for either a browser callback or typed manual input.
pub(super) async fn receive_callback(
	driver: &LoginDriver,
	server: Option<CallbackServer>,
) -> Result<AuthInput, OAuthError> {
	let timeout = time::sleep(CALLBACK_TIMEOUT);
	tokio::pin!(timeout);
	let Some(server) = server else {
		return tokio::select! {
			biased;
			input = driver.receive() => input.map_err(Into::into),
			() = &mut timeout => Err(OAuthError::Cancelled),
		};
	};
	tokio::select! {
		biased;
		outcome = server.receive() => match outcome? {
			CallbackOutcome::Callback(callback) => Ok(AuthInput::CallbackUrl(callback)),
			CallbackOutcome::Denied => Err(OAuthError::AuthorizationDenied),
		},
		input = driver.receive() => input.map_err(Into::into),
		() = &mut timeout => Err(OAuthError::Cancelled),
	}
}
#[cfg(test)]
mod tests {
	use omp_core::{ExposeSecret as _, Str};
	use tokio::{
		io::{AsyncReadExt as _, AsyncWriteExt as _},
		net::TcpStream,
	};
	use url::Url;

	use super::{CallbackOutcome, CallbackServer};

	async fn callback_server() -> CallbackServer {
		CallbackServer::bind("http://localhost:0/callback", "expected-state")
			.await
			.expect("valid callback address")
			.expect("loopback callback server")
	}

	async fn get(url: &str) -> String {
		let url = Url::parse(url).expect("valid request URL");
		let host = url.host_str().expect("request host");
		let port = url.port_or_known_default().expect("request port");
		let mut stream = TcpStream::connect((host, port))
			.await
			.expect("connect to callback server");
		let target = match url.query() {
			Some(query) => format!("{}?{query}", url.path()),
			None => url.path().to_owned(),
		};
		let request =
			format!("GET {target} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
		stream
			.write_all(request.as_bytes())
			.await
			.expect("write request");
		let mut response = Vec::new();
		stream
			.read_to_end(&mut response)
			.await
			.expect("read response");
		String::from_utf8(response).expect("UTF-8 response")
	}

	#[tokio::test]
	async fn launch_before_arming_is_unavailable() {
		let server = callback_server().await;

		let response = get(&server.launch_url()).await;

		assert_eq!(response.lines().next(), Some("HTTP/1.1 503 Service Unavailable"));
		assert!(!response.lines().any(|line| line.starts_with("Location:")));
	}

	#[tokio::test]
	async fn launch_redirects_to_the_armed_authorization_url() {
		let server = callback_server().await;
		let authorization_url =
			Str::new("https://auth.example/authorize?client_id=public&challenge=pkce");
		server.arm(authorization_url.clone());

		let response = get(&server.launch_url()).await;

		assert_eq!(response.lines().next(), Some("HTTP/1.1 302 Found"));
		assert_eq!(
			response.lines().find(|line| line.starts_with("Location:")),
			Some("Location: https://auth.example/authorize?client_id=public&challenge=pkce")
		);
		assert!(
			response
				.lines()
				.any(|line| line == "Cache-Control: no-store")
		);
	}

	#[tokio::test]
	async fn launch_does_not_consume_the_pending_callback() {
		let server = callback_server().await;
		server.arm(Str::new("https://auth.example/authorize"));
		assert_eq!(get(&server.launch_url()).await.lines().next(), Some("HTTP/1.1 302 Found"));
		let mut callback_url = Url::parse(&server.launch_url()).expect("valid launch URL");
		callback_url.set_path("/callback");
		callback_url.set_query(Some("code=accepted&state=expected-state"));

		assert_eq!(get(callback_url.as_str()).await.lines().next(), Some("HTTP/1.1 200 OK"));
		let CallbackOutcome::Callback(callback) =
			server.receive().await.expect("callback remains pending")
		else {
			panic!("expected successful callback");
		};
		assert!(callback.expose_secret().contains("code=accepted"));
	}
}
