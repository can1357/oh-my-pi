use std::{fmt, mem, time::Duration};

use omp_core::{ExposeSecret as _, SecretString, Str};
use serde::Deserialize;
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use url::{Url, form_urlencoded};
use zeroize::Zeroizing;

use crate::{
	OAuthHttpClient, OAuthHttpRequest, OAuthRequestError, OAuthTransportError, TokenError,
	TokenGrant, TokenRequest, parse_token_response,
};

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_DEVICE_LIFETIME: Duration = Duration::from_secs(600);
const MAX_DEVICE_LIFETIME: Duration = Duration::from_mins(15);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Inputs for an RFC 8628 device authorization request.
pub struct DeviceAuthorizationRequest<'a> {
	/// Device authorization endpoint from validated server metadata.
	pub endpoint:      &'a str,
	/// Public or dynamically registered client identifier.
	pub client_id:     &'a str,
	/// Optional confidential-client secret.
	pub client_secret: Option<&'a SecretString>,
	/// Requested scopes.
	pub scopes:        &'a [Str],
	/// Optional RFC 8707 protected-resource indicator.
	pub resource:      Option<&'a str>,
}

/// Pending RFC 8628 grant with bounded polling policy.
pub struct PendingDeviceAuthorization {
	device_code:        SecretString,
	browser_url:        Url,
	user_code:          SecretString,
	user_code_embedded: bool,
	interval:           Duration,
	lifetime:           Duration,
}

impl PendingDeviceAuthorization {
	/// URL the user must open to approve this grant.
	pub fn browser_url(&self) -> &str {
		self.browser_url.as_str()
	}

	/// One-time code to display when the verification URL cannot embed it.
	pub fn user_code(&self) -> &str {
		self.user_code.expose_secret()
	}

	/// Whether the selected browser URL already carries the one-time code.
	pub const fn user_code_embedded(&self) -> bool {
		self.user_code_embedded
	}
}

impl fmt::Debug for PendingDeviceAuthorization {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PendingDeviceAuthorization")
			.field("device_code", &"[REDACTED]")
			.field("browser_url", &"[REDACTED]")
			.field("user_code", &"[REDACTED]")
			.field("user_code_embedded", &self.user_code_embedded)
			.field("interval", &self.interval)
			.field("lifetime", &self.lifetime)
			.finish()
	}
}

#[derive(Deserialize)]
struct RawDeviceAuthorization {
	device_code:               Option<String>,
	user_code:                 Option<String>,
	verification_uri:          Option<String>,
	verification_url:          Option<String>,
	verification_uri_complete: Option<String>,
	expires_in:                Option<u64>,
	interval:                  Option<u64>,
}

#[derive(Deserialize)]
struct RawDeviceError {
	error: Option<String>,
}

/// Starts a bounded RFC 8628 device authorization grant.
pub async fn begin_device_authorization(
	http: &dyn OAuthHttpClient,
	request: &DeviceAuthorizationRequest<'_>,
	cancel: &CancellationToken,
) -> Result<PendingDeviceAuthorization, DeviceAuthorizationError> {
	if request.client_id.trim().is_empty() {
		return Err(DeviceAuthorizationError::Malformed);
	}
	let scope = request
		.scopes
		.iter()
		.map(Str::as_str)
		.filter(|scope| !scope.is_empty())
		.collect::<Vec<_>>()
		.join(" ");
	let mut fields = vec![("client_id", request.client_id)];
	if let Some(client_secret) = request.client_secret {
		fields.push(("client_secret", client_secret.expose_secret()));
	}
	if !scope.is_empty() {
		fields.push(("scope", scope.as_str()));
	}
	if let Some(resource) = request.resource {
		fields.push(("resource", resource));
	}
	let operation_cancel = cancel.child_token();
	let operation = http.execute(
		OAuthHttpRequest::secret_form(request.endpoint, encoded_form(&fields))?
			.with_cancellation(operation_cancel.clone()),
	);
	tokio::pin!(operation);
	let response = tokio::select! {
		biased;
		() = cancel.cancelled() => {
			operation_cancel.cancel();
			return Err(DeviceAuthorizationError::Cancelled);
		},
		response = &mut operation => response?,
	};
	if !(200..300).contains(&response.status) {
		return Err(DeviceAuthorizationError::Rejected { status: response.status });
	}
	let parsed: RawDeviceAuthorization = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| DeviceAuthorizationError::Malformed)?;
	let device_code = parsed
		.device_code
		.filter(|value| !value.is_empty())
		.ok_or(DeviceAuthorizationError::Malformed)?;
	let user_code = parsed
		.user_code
		.filter(|value| !value.is_empty())
		.ok_or(DeviceAuthorizationError::Malformed)?;
	let user_code_embedded = parsed.verification_uri_complete.is_some();
	let browser_url = parsed
		.verification_uri_complete
		.or(parsed.verification_uri)
		.or(parsed.verification_url)
		.ok_or(DeviceAuthorizationError::Malformed)?;
	let browser_url = checked_browser_url(&browser_url)?;
	let lifetime = Duration::from_secs(
		parsed
			.expires_in
			.unwrap_or(DEFAULT_DEVICE_LIFETIME.as_secs()),
	)
	.max(Duration::from_secs(1))
	.min(MAX_DEVICE_LIFETIME);
	let interval = Duration::from_secs(parsed.interval.unwrap_or(DEFAULT_POLL_INTERVAL.as_secs()))
		.max(Duration::from_secs(1))
		.min(MAX_POLL_INTERVAL);
	Ok(PendingDeviceAuthorization {
		device_code: SecretString::from(device_code),
		browser_url,
		user_code: SecretString::from(user_code),
		user_code_embedded,
		interval,
		lifetime,
	})
}

/// Polls a pending RFC 8628 grant until approval, denial, expiry, or caller
/// cancellation. Provider `slow_down` replies increase the interval without
/// exceeding the fixed upper bound.
pub async fn poll_device_token(
	http: &dyn OAuthHttpClient,
	request: &TokenRequest<'_>,
	mut pending: PendingDeviceAuthorization,
	cancel: &CancellationToken,
) -> Result<TokenGrant, DeviceAuthorizationError> {
	let deadline = Instant::now() + pending.lifetime;
	loop {
		let now = Instant::now();
		if now >= deadline {
			return Err(DeviceAuthorizationError::Expired);
		}
		tokio::select! {
			biased;
			() = cancel.cancelled() => return Err(DeviceAuthorizationError::Cancelled),
			() = time::sleep(pending.interval.min(deadline.saturating_duration_since(now))) => {},
		}
		if Instant::now() >= deadline {
			return Err(DeviceAuthorizationError::Expired);
		}
		let mut fields =
			vec![("grant_type", DEVICE_GRANT), ("device_code", pending.device_code.expose_secret())];
		if let Some(client_id) = request.client_id {
			fields.push(("client_id", client_id));
		}
		if let Some(client_secret) = request.client_secret {
			fields.push(("client_secret", client_secret.expose_secret()));
		}
		if let Some(resource) = request.resource {
			fields.push(("resource", resource));
		}
		let operation_cancel = cancel.child_token();
		let operation = http.execute(
			OAuthHttpRequest::secret_form(request.endpoint, encoded_form(&fields))?
				.with_cancellation(operation_cancel.clone()),
		);
		tokio::pin!(operation);
		let response = tokio::select! {
			biased;
			() = cancel.cancelled() => {
				operation_cancel.cancel();
				return Err(DeviceAuthorizationError::Cancelled);
			},
			() = time::sleep_until(deadline) => {
				operation_cancel.cancel();
				return Err(DeviceAuthorizationError::Expired);
			},
			response = &mut operation => response?,
		};
		let provider_error = serde_json::from_str::<RawDeviceError>(response.body.expose_secret())
			.ok()
			.and_then(|error| error.error);
		match provider_error.as_deref() {
			Some("authorization_pending") => continue,
			Some("slow_down") => {
				pending.interval = pending
					.interval
					.saturating_add(Duration::from_secs(5))
					.min(MAX_POLL_INTERVAL);
				continue;
			},
			Some("access_denied") => return Err(DeviceAuthorizationError::Denied),
			Some("expired_token") => return Err(DeviceAuthorizationError::Expired),
			Some("temporarily_unavailable" | "server_error") => {
				return Err(DeviceAuthorizationError::Unavailable);
			},
			Some(_) => return Err(DeviceAuthorizationError::Provider),
			None if !(200..300).contains(&response.status) => {
				return Err(DeviceAuthorizationError::Rejected { status: response.status });
			},
			None => {},
		}
		return parse_token_response(response.body.expose_secret(), None)
			.map_err(DeviceAuthorizationError::Token);
	}
}

fn encoded_form(fields: &[(&str, &str)]) -> SecretString {
	let mut serializer = form_urlencoded::Serializer::new(String::new());
	for (name, value) in fields {
		serializer.append_pair(name, value);
	}
	let mut encoded = Zeroizing::new(serializer.finish());
	SecretString::from(mem::take(&mut *encoded))
}

fn checked_browser_url(value: &str) -> Result<Url, DeviceAuthorizationError> {
	let url = Url::parse(value).map_err(|_| DeviceAuthorizationError::InvalidVerificationUrl)?;
	if !matches!(url.scheme(), "http" | "https")
		|| url.host().is_none()
		|| !url.username().is_empty()
		|| url.password().is_some()
		|| url.fragment().is_some()
	{
		return Err(DeviceAuthorizationError::InvalidVerificationUrl);
	}
	Ok(url)
}

/// Secret-free RFC 8628 failure evidence.
#[derive(Debug, thiserror::Error)]
pub enum DeviceAuthorizationError {
	/// Request construction failed.
	#[error(transparent)]
	Request(#[from] OAuthRequestError),
	/// Bounded OAuth transport failed.
	#[error(transparent)]
	Transport(#[from] OAuthTransportError),
	/// Device endpoint rejected the request.
	#[error("OAuth device endpoint rejected the request with HTTP {status}")]
	Rejected {
		/// HTTP status.
		status: u16,
	},
	/// Device endpoint returned malformed data.
	#[error("OAuth device endpoint response is malformed")]
	Malformed,
	/// Verification URL was unsafe to present.
	#[error("OAuth device verification URL is invalid")]
	InvalidVerificationUrl,
	/// User denied the device grant.
	#[error("OAuth device authorization was denied")]
	Denied,
	/// Device grant expired before approval.
	#[error("OAuth device authorization expired")]
	Expired,
	/// Caller cancelled the device grant.
	#[error("OAuth device authorization was cancelled")]
	Cancelled,
	/// No actor was available to display a required one-time code.
	#[error("OAuth device authorization requires an interactive presenter")]
	PresentationUnavailable,
	/// Provider reported a retryable outage.
	#[error("OAuth device authorization is temporarily unavailable")]
	Unavailable,
	/// Provider returned a secret-redacted terminal OAuth error.
	#[error("OAuth device authorization failed")]
	Provider,
	/// Token response was malformed after approval.
	#[error(transparent)]
	Token(#[from] TokenError),
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pending_debug_redacts_codes_and_browser_url() {
		let pending = PendingDeviceAuthorization {
			device_code:        SecretString::from("device-secret"),
			browser_url:        Url::parse("https://auth.example/device?user_code=ABCD").expect("URL"),
			user_code:          SecretString::from("ABCD"),
			user_code_embedded: true,
			interval:           Duration::from_secs(5),
			lifetime:           Duration::from_secs(600),
		};
		let debug = format!("{pending:?}");
		assert!(!debug.contains("device-secret"));
		assert!(!debug.contains("ABCD"));
		assert!(!debug.contains("auth.example"));
	}

	#[test]
	fn verification_urls_reject_embedded_credentials() {
		assert!(checked_browser_url("https://auth.example/device").is_ok());
		assert!(checked_browser_url("https://user:secret@auth.example/device").is_err());
	}
}
