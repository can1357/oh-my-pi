//! Typed inference-to-browser-daemon escalation boundary.
//!
//! Implementations live at the application composition boundary. Inference
//! receives bounded bytes and metadata and never imports, constructs, or owns
//! an embedded browser engine or page handle.

use std::{future::Future, pin::Pin, time::Duration};

use omp_core::Str;
use url::Url;

use crate::codec::Cancellation;

/// Maximum body returned by a browser escalation.
pub const MAX_BROWSER_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Maximum navigation lifetime accepted by the daemon contract.
pub const MAX_BROWSER_DEADLINE: Duration = Duration::from_secs(30);

/// One public navigation header selected by the search engine profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserHeader {
	/// Lower-case HTTP header name.
	pub name:  Str,
	/// Public header value; credentials are forbidden at this boundary.
	pub value: Str,
}

/// Bounded browser navigation request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserFetchRequest {
	/// Absolute HTTP(S) destination.
	pub url:       Str,
	/// Public navigation headers.
	pub headers:   Box<[BrowserHeader]>,
	/// Maximum response bytes.
	pub max_bytes: usize,
	/// Navigation and DOM-settle deadline.
	pub deadline:  Duration,
}

impl BrowserFetchRequest {
	/// Validates limits before crossing into the browser daemon.
	pub fn validate(&self) -> Result<(), BrowserFetchError> {
		let url = Url::parse(self.url.as_str()).map_err(|_| BrowserFetchError::InvalidUrl)?;
		if !matches!(url.scheme(), "http" | "https")
			|| url.username() != ""
			|| url.password().is_some()
		{
			return Err(BrowserFetchError::InvalidUrl);
		}
		if self.max_bytes == 0 || self.max_bytes > MAX_BROWSER_BODY_BYTES {
			return Err(BrowserFetchError::InvalidLimit);
		}
		if self.deadline.is_zero() || self.deadline > MAX_BROWSER_DEADLINE {
			return Err(BrowserFetchError::InvalidDeadline);
		}
		Ok(())
	}
}

/// Sanitized browser navigation result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserFetchResponse {
	/// Final URL after redirects.
	pub final_url:    Str,
	/// Origin HTTP status when observable.
	pub status:       Option<u16>,
	/// Serialized settled DOM, bounded by the request.
	pub body:         bytes::Bytes,
	/// Browser-reported content type.
	pub content_type: Option<Str>,
}

/// Browser-daemon rejection visible to inference policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum BrowserFetchError {
	/// Destination is not an absolute credential-free HTTP(S) URL.
	#[error("browser fetch URL is invalid")]
	InvalidUrl,
	/// Requested body bound is outside the daemon contract.
	#[error("browser fetch byte limit is invalid")]
	InvalidLimit,
	/// Requested deadline is outside the daemon contract.
	#[error("browser fetch deadline is invalid")]
	InvalidDeadline,
	/// Caller cancelled navigation.
	#[error("browser fetch was cancelled")]
	Cancelled,
	/// Browser daemon is unavailable.
	#[error("browser fetch daemon is unavailable")]
	Unavailable,
	/// Navigation exceeded its deadline.
	#[error("browser fetch timed out")]
	TimedOut,
	/// The bounded page response exceeded the negotiated limit.
	#[error("browser fetch response is too large")]
	ResponseTooLarge,
	/// Embedded page navigation failed.
	#[error("browser fetch navigation failed")]
	Navigation,
}

/// Future returned by the application-owned browser boundary.
///
/// This allocation occurs once per challenged network navigation at the
/// dynamic application/inference boundary.
pub type BrowserFetchFuture<'a> =
	Pin<Box<dyn Future<Output = Result<BrowserFetchResponse, BrowserFetchError>> + Send + 'a>>;

/// Supervised browser-daemon client supplied by the application.
pub trait BrowserFetch: Send + Sync + 'static {
	/// Navigates one page. Cancellation must close its page before resolving.
	fn fetch(
		&self,
		request: BrowserFetchRequest,
		cancellation: Cancellation,
	) -> BrowserFetchFuture<'_>;
}
