//! Bounded HTTP authority for local and configured model discovery.

use bytes::{Bytes, BytesMut};
use futures::StreamExt as _;
use omp_ai::discovery::{
	DiscoveryHttpClient, ProbeError, ProbeHttpFuture, ProbeHttpRequest, ProbeTransportError,
};
use tokio_util::sync::CancellationToken;

const MAX_DISCOVERY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Redirect-disabled host HTTP client for model discovery probes.
#[derive(Clone)]
pub struct ModelDiscoveryHttpHost {
	client: omp_http::Client,
}

impl ModelDiscoveryHttpHost {
	/// Creates a host client whose transport never forwards credentials across
	/// redirects.
	pub fn new() -> Self {
		Self { client: omp_http::no_redirect_client() }
	}
}

impl Default for ModelDiscoveryHttpHost {
	fn default() -> Self {
		Self::new()
	}
}

impl std::fmt::Debug for ModelDiscoveryHttpHost {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.write_str("ModelDiscoveryHttpHost(..)")
	}
}

impl DiscoveryHttpClient for ModelDiscoveryHttpHost {
	fn request(
		&self,
		request: ProbeHttpRequest,
		cancellation: CancellationToken,
	) -> ProbeHttpFuture {
		let client = self.client.clone();
		Box::pin(async move {
			let response = tokio::select! {
				() = cancellation.cancelled() => return Err(ProbeError::Cancelled),
				response = client
					.request(request.method, request.url.as_str())
					.headers(request.headers)
					.body(request.body)
					.send() => response
						.map_err(|_| ProbeError::Transport(ProbeTransportError::Request))?,
			};
			if !response.status().is_success() {
				return Err(ProbeError::HttpStatus { status: response.status().as_u16() });
			}
			if response
				.content_length()
				.is_some_and(|length| length > MAX_DISCOVERY_RESPONSE_BYTES as u64)
			{
				return Err(ProbeError::ResponseTooLarge);
			}
			let mut stream = response.bytes_stream();
			let mut body = BytesMut::new();
			loop {
				let chunk = tokio::select! {
					() = cancellation.cancelled() => return Err(ProbeError::Cancelled),
					chunk = stream.next() => chunk,
				};
				let Some(chunk) = chunk else {
					break;
				};
				let chunk = chunk.map_err(|_| ProbeError::Transport(ProbeTransportError::Response))?;
				if body.len().saturating_add(chunk.len()) > MAX_DISCOVERY_RESPONSE_BYTES {
					return Err(ProbeError::ResponseTooLarge);
				}
				body.extend_from_slice(&chunk);
			}
			Ok(Bytes::from(body))
		})
	}
}
