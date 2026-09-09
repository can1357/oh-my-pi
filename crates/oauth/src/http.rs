use std::{fmt, time::Duration};

use bytes::{Bytes, BytesMut};
use futures::{FutureExt as _, future::BoxFuture};
use http::{
	HeaderMap, HeaderValue, Method, Request,
	header::{ACCEPT, CONTENT_TYPE},
};
use http_body_util::{BodyExt as _, Full};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
	client::legacy::{Client, connect::HttpConnector},
	rt::TokioExecutor,
};
use omp_core::{ExposeSecret as _, SecretString};
use rustls::crypto::ring;
use tokio::time;
use tokio_util::sync::CancellationToken;
use url::Url;

const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
/// Hard ceiling for a single OAuth response body.
pub const MAX_OAUTH_RESPONSE_BYTES: usize = 1024 * 1024;
/// Default end-to-end deadline for one OAuth HTTP exchange.
pub const DEFAULT_OAUTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A secret-bearing OAuth request handed directly to an injected transport.
pub struct OAuthHttpRequest {
	method:       Method,
	url:          Url,
	headers:      HeaderMap,
	body:         Option<SecretString>,
	cancellation: CancellationToken,
}

impl OAuthHttpRequest {
	/// Creates a bounded OAuth request.
	pub fn new(
		method: Method,
		url: &str,
		headers: HeaderMap,
		body: Option<SecretString>,
	) -> Result<Self, OAuthRequestError> {
		let url = Url::parse(url).map_err(|_| OAuthRequestError::InvalidUrl)?;
		if !matches!(url.scheme(), "http" | "https")
			|| url.host().is_none()
			|| !url.username().is_empty()
			|| url.password().is_some()
			|| url.fragment().is_some()
		{
			return Err(OAuthRequestError::InvalidUrl);
		}
		Ok(Self { method, url, headers, body, cancellation: CancellationToken::new() })
	}

	/// Binds caller cancellation to this request.
	pub fn with_cancellation(mut self, cancellation: CancellationToken) -> Self {
		self.cancellation = cancellation;
		self
	}

	/// Creates a form-encoded secret POST request.
	pub fn secret_form(url: &str, body: SecretString) -> Result<Self, OAuthRequestError> {
		let mut headers = HeaderMap::new();
		headers.insert(CONTENT_TYPE, HeaderValue::from_static(FORM_CONTENT_TYPE));
		headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
		Self::new(Method::POST, url, headers, Some(body))
	}

	/// Consumes the request into transport-ready parts.
	pub fn into_parts(self) -> (Method, Url, HeaderMap, Option<SecretString>) {
		(self.method, self.url, self.headers, self.body)
	}

	fn into_transport_parts(
		self,
	) -> (Method, Url, HeaderMap, Option<SecretString>, CancellationToken) {
		(self.method, self.url, self.headers, self.body, self.cancellation)
	}
}

/// OAuth request construction failed before any I/O.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum OAuthRequestError {
	/// URL is not an absolute HTTP(S) URL.
	#[error("OAuth endpoint URL is invalid")]
	InvalidUrl,
}

/// Secret-bearing bounded OAuth response.
pub struct OAuthHttpResponse {
	/// HTTP status code.
	pub status:  u16,
	/// Response headers.
	pub headers: HeaderMap,
	/// Bounded response body.
	pub body:    SecretString,
}

/// Cold OAuth I/O boundary.
pub trait OAuthHttpClient: Send + Sync {
	/// Executes one request without exposing its secret body.
	fn execute(
		&self,
		request: OAuthHttpRequest,
	) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>>;
}

/// OAuth transport failed, was cancelled, exceeded its deadline, or exceeded
/// its bounded response ceiling.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("OAuth HTTP transport failed or was bounded")]
pub struct OAuthTransportError;

type PooledOAuthClient = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

/// Production rustls OAuth transport with a one-MiB response ceiling.
#[derive(Clone)]
pub struct SystemOAuthHttpClient {
	inner:   PooledOAuthClient,
	timeout: Duration,
}

impl SystemOAuthHttpClient {
	/// Constructs a pooled HTTP/1.1 and HTTP/2 client.
	pub fn new() -> Self {
		let _ = ring::default_provider().install_default();
		let connector = HttpsConnectorBuilder::new()
			.with_webpki_roots()
			.https_or_http()
			.enable_http1()
			.enable_http2()
			.build();
		Self {
			inner:   Client::builder(TokioExecutor::new()).build(connector),
			timeout: DEFAULT_OAUTH_REQUEST_TIMEOUT,
		}
	}

	/// Constructs a pooled client with one end-to-end request deadline.
	pub fn with_timeout(timeout: Duration) -> Self {
		let mut client = Self::new();
		client.timeout = timeout;
		client
	}
}

impl Default for SystemOAuthHttpClient {
	fn default() -> Self {
		Self::new()
	}
}

impl fmt::Debug for SystemOAuthHttpClient {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("SystemOAuthHttpClient(..)")
	}
}

impl OAuthHttpClient for SystemOAuthHttpClient {
	fn execute(
		&self,
		request: OAuthHttpRequest,
	) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
		let client = self.inner.clone();
		let timeout = self.timeout;
		async move {
			let (method, url, headers, body, cancellation) = request.into_transport_parts();
			let exchange = async move {
				let body = body.as_ref().map_or_else(Bytes::new, |body| {
					Bytes::copy_from_slice(body.expose_secret().as_bytes())
				});
				let mut outbound = Request::builder()
					.method(method)
					.uri(url.as_str())
					.body(Full::new(body))
					.map_err(|_| OAuthTransportError)?;
				*outbound.headers_mut() = headers;
				let response = client
					.request(outbound)
					.await
					.map_err(|_| OAuthTransportError)?;
				let status = response.status().as_u16();
				let headers = response.headers().clone();
				let mut incoming = response.into_body();
				let mut bytes = BytesMut::new();
				while let Some(frame) = incoming.frame().await {
					let frame = frame.map_err(|_| OAuthTransportError)?;
					if let Some(data) = frame.data_ref() {
						if bytes.len().saturating_add(data.len()) > MAX_OAUTH_RESPONSE_BYTES {
							return Err(OAuthTransportError);
						}
						bytes.extend_from_slice(data);
					}
				}
				let body = String::from_utf8(bytes.to_vec()).map_err(|_| OAuthTransportError)?;
				Ok(OAuthHttpResponse { status, headers, body: SecretString::from(body) })
			};
			tokio::select! {
				biased;
				() = cancellation.cancelled() => Err(OAuthTransportError),
				result = time::timeout(timeout, exchange) => {
					result.map_err(|_| OAuthTransportError)?
				},
			}
		}
		.boxed()
	}
}
#[cfg(test)]
mod tests {
	use std::time::Duration;

	use http::{HeaderMap, Method};
	use tokio::net::TcpListener;
	use tokio_util::sync::CancellationToken;

	use super::{OAuthHttpClient, OAuthHttpRequest, OAuthTransportError, SystemOAuthHttpClient};

	#[tokio::test]
	async fn system_transport_observes_caller_cancellation() {
		let cancellation = CancellationToken::new();
		cancellation.cancel();
		let client = SystemOAuthHttpClient::with_timeout(Duration::from_secs(30));
		let request =
			OAuthHttpRequest::new(Method::GET, "http://127.0.0.1:9/token", HeaderMap::new(), None)
				.expect("valid local URL")
				.with_cancellation(cancellation);
		assert!(matches!(client.execute(request).await, Err(OAuthTransportError)));
	}

	#[tokio::test]
	async fn system_transport_deadline_bounds_hung_request() {
		let listener = TcpListener::bind("127.0.0.1:0")
			.await
			.expect("loopback listener");
		let address = listener.local_addr().expect("listener address");
		let server = tokio::spawn(async move {
			let (_socket, _) = listener.accept().await.expect("accepted OAuth request");
			futures::future::pending::<()>().await;
		});
		let client = SystemOAuthHttpClient::with_timeout(Duration::from_millis(10));
		let request = OAuthHttpRequest::new(
			Method::GET,
			&format!("http://{address}/token"),
			HeaderMap::new(),
			None,
		)
		.expect("valid local URL");
		assert!(matches!(client.execute(request).await, Err(OAuthTransportError)));
		server.abort();
	}
}
