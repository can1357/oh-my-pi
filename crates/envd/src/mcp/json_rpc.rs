//! Typed JSON-RPC utilities shared by MCP transports.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::{HeaderMap, HeaderValue, Method, header::CONTENT_TYPE};
use omp_core::{ExposeSecret as _, SecretString, Str};
use omp_oauth::{OAuthHttpClient, OAuthHttpRequest, OAuthRequestError, OAuthTransportError};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use strum::{EnumString, IntoStaticStr};
use tokio::time;
use url::Url;
use zeroize::Zeroizing;

const MCP_ONE_OFF_TIMEOUT: Duration = Duration::from_secs(60);
const SNOWFLAKE_EPOCH_MS: u64 = 1_420_070_400_000;
const SNOWFLAKE_MAX_SEQUENCE: u32 = 0x3f_ffff;

/// JSON-RPC request identifier accepted by MCP.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
	/// Ecosystem-compatible per-transport integer.
	Number(u64),
	/// Sixteen-character collision-resistant snowflake.
	String(Str),
}

/// Outbound MCP request-id representation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum RequestIdFormat {
	/// Monotone integer starting at one.
	#[default]
	Number,
	/// Collision-resistant snowflake hex string.
	String,
}

/// Per-transport request identifier allocator.
pub struct RequestIdAllocator {
	previous_numeric: u64,
	snowflake_seq:    u32,
}

impl RequestIdAllocator {
	/// Creates an allocator. Snowflake sequence entropy never enters logs.
	pub fn new() -> Self {
		let mut bytes = [0_u8; 4];
		let snowflake_seq = if SystemRandom::new().fill(&mut bytes).is_ok() {
			u32::from_ne_bytes(bytes) & SNOWFLAKE_MAX_SEQUENCE
		} else {
			0
		};
		Self { previous_numeric: 0, snowflake_seq }
	}

	/// Allocates the next request identifier.
	pub fn next(&mut self, format: RequestIdFormat) -> Result<RequestId, RequestIdError> {
		match format {
			RequestIdFormat::Number => {
				self.previous_numeric = self
					.previous_numeric
					.checked_add(1)
					.ok_or(RequestIdError::Exhausted)?;
				Ok(RequestId::Number(self.previous_numeric))
			},
			RequestIdFormat::String => {
				self.snowflake_seq = self.snowflake_seq.wrapping_add(1) & SNOWFLAKE_MAX_SEQUENCE;
				let now = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_err(|_| RequestIdError::InvalidClock)?;
				let millis =
					u64::try_from(now.as_millis()).map_err(|_| RequestIdError::InvalidClock)?;
				let delta = millis
					.checked_sub(SNOWFLAKE_EPOCH_MS)
					.ok_or(RequestIdError::InvalidClock)?;
				let value = delta.checked_shl(22).ok_or(RequestIdError::InvalidClock)?
					| u64::from(self.snowflake_seq);
				Ok(RequestId::String(Str::from(format!("{value:016x}"))))
			},
		}
	}
}

impl Default for RequestIdAllocator {
	fn default() -> Self {
		Self::new()
	}
}

/// Request-id allocation failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RequestIdError {
	/// Numeric request ids exhausted.
	#[error("MCP request identifier space is exhausted")]
	Exhausted,
	/// Wall clock cannot produce a snowflake.
	#[error("system clock cannot produce an MCP snowflake identifier")]
	InvalidClock,
}

/// Typed JSON-RPC 2.0 request envelope.
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest<'a, P> {
	jsonrpc:    &'static str,
	/// Correlation identifier.
	pub id:     RequestId,
	/// MCP method name.
	pub method: &'a str,
	/// Typed parameters.
	pub params: P,
}

impl<'a, P> JsonRpcRequest<'a, P> {
	/// Creates a JSON-RPC 2.0 request.
	pub const fn new(id: RequestId, method: &'a str, params: P) -> Self {
		Self { jsonrpc: "2.0", id, method, params }
	}
}

/// Typed JSON-RPC 2.0 response envelope.
#[derive(Debug, Deserialize)]
pub struct JsonRpcResponse<T> {
	jsonrpc:    Str,
	/// Correlation identifier.
	pub id:     RequestId,
	/// Successful result.
	pub result: Option<T>,
	/// Protocol error.
	pub error:  Option<JsonRpcError>,
}

impl<T> JsonRpcResponse<T> {
	/// Validates the envelope version and mutually-exclusive result/error
	/// fields.
	pub fn validate(self) -> Result<Self, JsonRpcCallError> {
		if self.jsonrpc != "2.0" || self.result.is_some() == self.error.is_some() {
			return Err(JsonRpcCallError::MalformedEnvelope);
		}
		Ok(self)
	}
}

/// JSON-RPC error object.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct JsonRpcError {
	/// Standard or server-defined numeric code.
	pub code:    i64,
	/// Human-readable protocol message.
	pub message: Str,
	/// Optional structured evidence.
	pub data:    Option<Value>,
}

/// One-off JSON-RPC call failure.
#[derive(Debug, thiserror::Error)]
pub enum JsonRpcCallError {
	/// Request URL is invalid.
	#[error(transparent)]
	Request(#[from] OAuthRequestError),
	/// HTTP transport failed.
	#[error(transparent)]
	Transport(#[from] OAuthTransportError),
	/// Hard one-off deadline elapsed.
	#[error("one-off MCP request timed out")]
	TimedOut,
	/// Server returned an unsuccessful HTTP status.
	#[error("one-off MCP request returned HTTP {status}")]
	Http {
		/// HTTP status.
		status: u16,
	},
	/// Request or response JSON was malformed.
	#[error("one-off MCP JSON-RPC envelope is malformed")]
	MalformedEnvelope,
}

/// Performs one stateless JSON-RPC POST with a hard sixty-second ceiling.
pub async fn call_mcp<P: Serialize, T: DeserializeOwned>(
	http: &dyn OAuthHttpClient,
	url: &str,
	request: &JsonRpcRequest<'_, P>,
) -> Result<JsonRpcResponse<T>, JsonRpcCallError> {
	let body = Zeroizing::new(
		serde_json::to_string(request).map_err(|_| JsonRpcCallError::MalformedEnvelope)?,
	);
	let mut headers = HeaderMap::new();
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert("accept", HeaderValue::from_static("application/json, text/event-stream"));
	let operation = http.execute(OAuthHttpRequest::new(
		Method::POST,
		url,
		headers,
		Some(SecretString::from(body.as_str().to_owned())),
	)?);
	let response = time::timeout(MCP_ONE_OFF_TIMEOUT, operation)
		.await
		.map_err(|_| JsonRpcCallError::TimedOut)??;
	if !(200..300).contains(&response.status) {
		return Err(JsonRpcCallError::Http { status: response.status });
	}
	let value =
		parse_sse(response.body.expose_secret()).ok_or(JsonRpcCallError::MalformedEnvelope)?;
	serde_json::from_value::<JsonRpcResponse<T>>(value)
		.map_err(|_| JsonRpcCallError::MalformedEnvelope)?
		.validate()
}

/// Parses the first JSON `data: ` payload, skipping keep-alives and `[DONE]`,
/// then falls back to parsing the complete response as JSON.
pub fn parse_sse(text: &str) -> Option<Value> {
	for line in text.lines() {
		let Some(data) = line.strip_prefix("data: ") else {
			continue;
		};
		let data = data.trim();
		if data == "[DONE]" {
			continue;
		}
		if let Ok(value) = serde_json::from_str::<Value>(data)
			&& !value.is_null()
		{
			return Some(value);
		}
	}
	serde_json::from_str(text).ok()
}

/// Redacts credential-shaped query parameters without altering non-sensitive
/// parameters. Unparseable URLs lose their complete query string.
pub fn redact_url_for_log(url: &str) -> Str {
	let Ok(mut parsed) = Url::parse(url) else {
		return Str::from(url.split_once('?').map_or(url, |(base, _)| base));
	};
	if !parsed.username().is_empty() {
		let _ = parsed.set_username("[redacted]");
	}
	if parsed.password().is_some() {
		let _ = parsed.set_password(Some("[redacted]"));
	}
	let values = parsed
		.query_pairs()
		.map(|(name, value)| (name.into_owned(), value.into_owned()))
		.collect::<Vec<_>>();
	if values.is_empty() {
		return Str::from(parsed.as_str());
	}
	let mut redacted = Map::new();
	for (name, value) in values {
		let folded = name.to_ascii_lowercase();
		let sensitive = ["key", "token", "secret", "auth"]
			.iter()
			.any(|needle| folded.contains(needle));
		redacted.insert(
			name,
			Value::String(if sensitive {
				"[redacted]".to_owned()
			} else {
				value
			}),
		);
	}
	parsed.set_query(None);
	{
		let mut pairs = parsed.query_pairs_mut();
		for (name, value) in redacted {
			if let Value::String(value) = value {
				pairs.append_pair(&name, &value);
			}
		}
	}
	Str::from(parsed.as_str())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn allocator_defaults_to_sequential_numbers() {
		let mut allocator = RequestIdAllocator::new();
		assert_eq!(allocator.next(RequestIdFormat::Number).expect("id"), RequestId::Number(1));
		assert_eq!(allocator.next(RequestIdFormat::Number).expect("id"), RequestId::Number(2));
	}

	#[test]
	fn string_ids_are_fixed_width_unique_snowflakes_and_numbers_do_not_wrap() {
		let mut allocator = RequestIdAllocator::new();
		let first = allocator.next(RequestIdFormat::String).expect("first");
		let second = allocator.next(RequestIdFormat::String).expect("second");
		assert_ne!(first, second);
		for id in [first, second] {
			let RequestId::String(id) = id else {
				panic!("string request ID");
			};
			assert_eq!(id.len(), 16);
			assert!(
				id.bytes()
					.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
			);
		}
		allocator.previous_numeric = u64::MAX;
		assert_eq!(allocator.next(RequestIdFormat::Number), Err(RequestIdError::Exhausted));
	}

	#[test]
	fn sse_skips_keepalive_and_redacts_credentials() {
		let value = parse_sse("data: ping\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n")
			.expect("JSON data");
		assert_eq!(value["id"], 1);
		let redacted =
			redact_url_for_log("https://user:password@mcp.example/mcp?apiKey=secret&foo=bar");
		assert!(!redacted.contains("secret"));
		assert!(!redacted.contains("password"));
		assert!(!redacted.contains("user"));
		assert!(redacted.contains("foo=bar"));
	}
}
