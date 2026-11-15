use std::{collections::BTreeMap, convert::Infallible, io, sync::Arc, time::Duration};

use bytes::Bytes;
use futures_util::{StreamExt, stream};
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
	body::{Frame, Incoming},
	server::conn::http1,
	service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::mpsc, task::JoinSet};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use url::Url;

use crate::{
	Result,
	continuation::{self, CcpaError},
	serialize::CcpaSerializer,
	transport::{OutboundRequest, Transport, target_is_https},
};

pub struct Bridge {
	pub token:         String,
	pub transport:     Transport,
	pub serializer:    CcpaSerializer,
	pub user_agent:    HeaderValue,
	pub quota_project: Option<HeaderValue>,
}

type ResponseBody = UnsyncBoxBody<Bytes, io::Error>;

fn full(bytes: impl Into<Bytes>) -> ResponseBody {
	Full::new(bytes.into())
		.map_err(|never: Infallible| match never {})
		.boxed_unsync()
}
fn error_response(
	code: StatusCode,
	category: &'static str,
	message: impl AsRef<str>,
) -> Response<ResponseBody> {
	let mut response = Response::new(full(format!("{}\n", message.as_ref())));
	*response.status_mut() = code;
	response
		.headers_mut()
		.insert("x-agy-bridge-error", HeaderValue::from_static(category));
	response
		.headers_mut()
		.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
	response
		.headers_mut()
		.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
	response
}
fn validation(message: impl AsRef<str>) -> Response<ResponseBody> {
	error_response(StatusCode::BAD_REQUEST, "validation", message)
}

pub async fn serve(
	listener: TcpListener,
	bridge: Arc<Bridge>,
	shutdown: CancellationToken,
) -> Result<()> {
	let mut connections = JoinSet::new();
	loop {
		tokio::select! {
			 biased;
			 _ = shutdown.cancelled() => break,
			 accepted = listener.accept() => {
				  let (socket, _) = accepted?;
				  let bridge = bridge.clone();
				  let shutdown = shutdown.clone();
				  connections.spawn(async move {
						let service = service_fn(move |request| {
							 let bridge = bridge.clone();
							 async move { Ok::<_, Infallible>(bridge.handle(request).await) }
						});
						let mut builder = http1::Builder::new();
						builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10));
						tokio::select! {
							 _ = shutdown.cancelled() => {},
							 _ = builder.serve_connection(TokioIo::new(socket), service) => {},
						}
				  });
			 }
			 _ = connections.join_next(), if !connections.is_empty() => {},
		}
	}
	connections.abort_all();
	while connections.join_next().await.is_some() {}
	Ok(())
}

impl Bridge {
	async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Response<ResponseBody> {
		let supplied = request
			.headers()
			.get("x-agy-bridge-token")
			.map(HeaderValue::as_bytes)
			.unwrap_or_default();
		if !bool::from(supplied.ct_eq(self.token.as_bytes())) {
			return error_response(
				StatusCode::UNAUTHORIZED,
				"validation",
				"unauthorized local bridge request",
			);
		}
		let target = request
			.headers()
			.get("x-agy-bridge-target")
			.and_then(|value| value.to_str().ok())
			.unwrap_or("");
		let authority = target
			.split_once("://")
			.map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""))
			.unwrap_or("");
		let target = match Url::parse(target) {
			Ok(target) if target_is_https(&target) && !authority.contains('@') => target,
			_ => return validation("absolute HTTPS target required"),
		};
		let encoded = request
			.headers()
			.get("x-agy-bridge-headers")
			.map(HeaderValue::as_bytes)
			.unwrap_or_default();
		let pairs = match serde_json::from_slice::<Option<Vec<[String; 2]>>>(encoded) {
			Ok(headers) => headers.unwrap_or_default(),
			Err(_) => return validation("invalid outbound headers"),
		};
		let (parts, body) = request.into_parts();
		let mut input = match body.collect().await {
			Ok(body) => body.to_bytes(),
			Err(error) => return validation(error.to_string()),
		};
		let generation = matches!(
			target.path(),
			"/v1internal:streamGenerateContent" | "/v1internal:generateContent"
		);
		let streaming = target.path() == "/v1internal:streamGenerateContent";
		let ccpa = target.path().starts_with("/v1internal:");
		if generation {
			input = match self.serializer.marshal(&input) {
				Ok(bytes) => bytes.into(),
				Err(error) => {
					return error_response(StatusCode::BAD_REQUEST, "serialization", error.to_string());
				},
			};
		}
		let mut headers = HeaderMap::new();
		let mut normalized_form = false;
		for [name, mut value] in pairs {
			if matches!(
				name.to_ascii_lowercase().as_str(),
				"content-length"
					| "transfer-encoding"
					| "connection"
					| "proxy-authorization"
					| "proxy-connection"
			) {
				return validation("transport-owned header");
			}
			if !ccpa
				&& !normalized_form
				&& name.eq_ignore_ascii_case("content-type")
				&& value.starts_with("application/x-www-form-urlencoded")
			{
				input = match canonical_form(&input) {
					Ok(bytes) => bytes.into(),
					Err(_) => return validation("invalid OAuth form body"),
				};
				value = "application/x-www-form-urlencoded".into();
				normalized_form = true;
			}
			let name = match HeaderName::from_bytes(name.as_bytes()) {
				Ok(name) => name,
				Err(error) => return validation(error.to_string()),
			};
			let value = match HeaderValue::from_str(&value) {
				Ok(value) => value,
				Err(error) => return validation(error.to_string()),
			};
			if name == header::HOST {
				headers.insert(name, value);
			} else {
				headers.append(name, value);
			}
		}
		if ccpa {
			headers.insert(header::USER_AGENT, self.user_agent.clone());
			if parts.method == Method::POST {
				headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
			}
			headers.remove(header::ACCEPT);
			headers.remove(header::ACCEPT_ENCODING);
			if let Some(project) = &self.quota_project {
				headers.insert("x-goog-user-project", project.clone());
			}
		} else if !headers.contains_key(header::USER_AGENT) {
			headers.insert(header::USER_AGENT, HeaderValue::from_static("Go-http-client/1.1"));
		}
		let outgoing = OutboundRequest { method: parts.method, url: target, headers };
		let first_body = if streaming {
			input.clone()
		} else {
			std::mem::take(&mut input)
		};
		let response = match self.transport.send(&outgoing, first_body, streaming).await {
			Ok(response) => response,
			Err(error) => {
				return error_response(StatusCode::BAD_GATEWAY, "transport", error.to_string());
			},
		};
		let has_body = outgoing.method != Method::HEAD
			&& !matches!(
				response.status,
				StatusCode::NO_CONTENT | StatusCode::RESET_CONTENT | StatusCode::NOT_MODIFIED
			);
		let continue_stream = streaming && has_body && response.status.is_success();
		let gzip = has_body && response.is_gzip();
		let mut status_response = Response::new(full(Bytes::new()));
		*status_response.status_mut() = response.status;
		for (name, value) in &response.headers {
			if matches!(
				name.as_str(),
				"connection"
					| "transfer-encoding"
					| "keep-alive"
					| "proxy-authenticate"
					| "proxy-authorization"
					| "te"
					| "trailer"
					| "upgrade"
			) {
				continue;
			}
			if (continue_stream || gzip)
				&& (name == header::CONTENT_LENGTH || name == header::CONTENT_ENCODING)
			{
				continue;
			}
			status_response.headers_mut().append(name, value.clone());
		}
		let target_header = match HeaderValue::from_str(outgoing.url.as_str()) {
			Ok(value) => value,
			Err(error) => return validation(error.to_string()),
		};
		status_response
			.headers_mut()
			.insert("x-agy-bridge-url", target_header);
		if !has_body {
			return status_response;
		}
		let (sender, receiver) = mpsc::channel::<io::Result<Bytes>>(1);
		*status_response.body_mut() =
			StreamBody::new(stream::unfold(receiver, |mut receiver| async move {
				receiver
					.recv()
					.await
					.map(|item| (item.map(Frame::data), receiver))
			}))
			.boxed_unsync();
		if continue_stream {
			tokio::spawn(async move {
				if let Err(error) = continuation::stream_ccpa(
					&self.transport,
					&outgoing,
					response,
					&input,
					&self.serializer,
					&sender,
				)
				.await
				{
					if !sender.is_closed() {
						let _ = continuation::write_error(&sender, CcpaError {
							message: format!("CCPA stream failed: {error}"),
							..CcpaError::default()
						})
						.await;
					}
				}
			});
		} else {
			let reader = match response.decoded_body().await {
				Ok(reader) => reader,
				Err(error) => {
					return error_response(StatusCode::BAD_GATEWAY, "gzip", error.to_string());
				},
			};
			tokio::spawn(async move {
				let copy = async {
					let mut chunks = ReaderStream::with_capacity(reader, 32 * 1024);
					while let Some(chunk) = chunks.next().await {
						let failed = chunk.is_err();
						if sender.send(chunk).await.is_err() || failed {
							return;
						}
					}
				};
				tokio::select! { biased; _ = sender.closed() => {}, _ = copy => {} }
			});
		}
		status_response
	}
}

/// net/url.Values.Encode orders keys but retains duplicate-value order. Decode
/// as bytes, not lossy UTF-8, and reject malformed percent escapes/semicolons.
fn canonical_form(input: &[u8]) -> Result<Vec<u8>> {
	let mut values: BTreeMap<Vec<u8>, Vec<Vec<u8>>> = BTreeMap::new();
	for pair in input
		.split(|byte| *byte == b'&')
		.filter(|pair| !pair.is_empty())
	{
		if pair.contains(&b';') {
			return Err("invalid semicolon separator".into());
		}
		let split = pair
			.iter()
			.position(|byte| *byte == b'=')
			.unwrap_or(pair.len());
		let key = decode_form(&pair[..split])?;
		let value = decode_form(if split == pair.len() {
			&[]
		} else {
			&pair[split + 1..]
		})?;
		values.entry(key).or_default().push(value);
	}
	let mut output = Vec::with_capacity(input.len());
	for (key, values) in values {
		for value in values {
			if !output.is_empty() {
				output.push(b'&');
			}
			encode_form(&mut output, &key);
			output.push(b'=');
			encode_form(&mut output, &value);
		}
	}
	Ok(output)
}
fn decode_form(input: &[u8]) -> Result<Vec<u8>> {
	fn hex(byte: u8) -> Option<u8> {
		match byte {
			b'0'..=b'9' => Some(byte - b'0'),
			b'a'..=b'f' => Some(byte - b'a' + 10),
			b'A'..=b'F' => Some(byte - b'A' + 10),
			_ => None,
		}
	}
	let mut bytes = Vec::with_capacity(input.len());
	let mut index = 0;
	while index < input.len() {
		match input[index] {
			b'+' => bytes.push(b' '),
			b'%' => {
				let high = input
					.get(index + 1)
					.and_then(|byte| hex(*byte))
					.ok_or("invalid query escape")?;
				let low = input
					.get(index + 2)
					.and_then(|byte| hex(*byte))
					.ok_or("invalid query escape")?;
				bytes.push(high << 4 | low);
				index += 2;
			},
			byte => bytes.push(byte),
		}
		index += 1;
	}
	Ok(bytes)
}
fn encode_form(output: &mut Vec<u8>, input: &[u8]) {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	for byte in input {
		match byte {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => output.push(*byte),
			b' ' => output.push(b'+'),
			_ => {
				output.push(b'%');
				output.push(HEX[(byte >> 4) as usize]);
				output.push(HEX[(byte & 15) as usize]);
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn oauth_encoding_matches_go_sorting_and_escaping() {
		assert_eq!(
			canonical_form(b"z=last&a=x%20y&a=%2b&star=*&empty&badutf8=%FF").unwrap(),
			b"a=x+y&a=%2B&badutf8=%FF&empty=&star=%2A&z=last"
		);
		for body in [b"a=%".as_slice(), b"a=%xx", b"a=x;y=z"] {
			assert!(canonical_form(body).is_err());
		}
	}
	#[test]
	fn bridge_errors_are_classified_and_newline_terminated() {
		let response = error_response(StatusCode::BAD_REQUEST, "serialization", "bad protobuf JSON");
		assert_eq!(response.status(), StatusCode::BAD_REQUEST);
		assert_eq!(response.headers()["x-agy-bridge-error"], "serialization");
		assert_eq!(response.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
	}
}
