//! The only outbound HTTP/TLS boundary. No HTTP status retries, redirects,
//! decompression defaults, Mozilla-root fallback, or verification bypasses.
use std::{io, pin::Pin, time::Duration};

use async_compression::tokio::bufread::GzipDecoder;
use bytes::Bytes;
use futures_util::{TryStreamExt, stream};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use tokio::io::{AsyncBufRead, AsyncReadExt, BufReader};
use tokio_util::io::StreamReader;
use url::Url;
use wreq::{
	Client, NoProxy, Proxy,
	header::OrigHeaderMap,
	tls::trust::{CertStore, Certificate},
};

use crate::{Result, tls};

pub type BodyReader = Pin<Box<dyn AsyncBufRead + Send>>;

#[derive(Clone)]
pub struct OutboundRequest {
	pub method:  Method,
	pub url:     Url,
	pub headers: HeaderMap,
}

pub struct UpstreamResponse {
	pub status:  StatusCode,
	pub headers: HeaderMap,
	pub body:    BodyReader,
}

impl UpstreamResponse {
	pub fn is_gzip(&self) -> bool {
		self
			.headers
			.get(header::CONTENT_ENCODING)
			.is_some_and(|value| value == "gzip")
	}

	pub async fn decoded_body(mut self) -> io::Result<BodyReader> {
		if !self.is_gzip() {
			return Ok(self.body);
		}
		// Go gzip.NewReader validates only the header before the bridge sends
		// the upstream status. Do not prefetch decoded payload here: body CRC
		// failures must still abort the body after headers have been sent.
		let header = gzip_header(&mut self.body).await?;
		let input = io::Cursor::new(header).chain(self.body);
		let mut decoder = GzipDecoder::new(input);
		decoder.multiple_members(true);
		Ok(Box::pin(BufReader::new(decoder)))
	}
}

async fn append_header(
	reader: &mut BodyReader,
	header: &mut Vec<u8>,
	count: usize,
) -> io::Result<()> {
	let start = header.len();
	header.resize(start + count, 0);
	reader.read_exact(&mut header[start..]).await?;
	Ok(())
}

async fn gzip_header(reader: &mut BodyReader) -> io::Result<Vec<u8>> {
	let invalid = || io::Error::new(io::ErrorKind::InvalidData, "gzip: invalid header");
	let mut header = Vec::with_capacity(10);
	append_header(reader, &mut header, 10).await?;
	if header[..3] != [0x1f, 0x8b, 8] {
		return Err(invalid());
	}
	let flags = header[3];
	if flags & 4 != 0 {
		append_header(reader, &mut header, 2).await?;
		let count = u16::from_le_bytes([header[10], header[11]]) as usize;
		append_header(reader, &mut header, count).await?;
	}
	for flag in [8, 16] {
		if flags & flag == 0 {
			continue;
		}
		let mut terminated = false;
		// Match Go gzip.Reader's fixed-size name/comment buffer.
		for _ in 0..512 {
			append_header(reader, &mut header, 1).await?;
			if header.last() == Some(&0) {
				terminated = true;
				break;
			}
		}
		if !terminated {
			return Err(invalid());
		}
	}
	if flags & 2 != 0 {
		let checksum = crc32fast::hash(&header) as u16;
		let offset = header.len();
		append_header(reader, &mut header, 2).await?;
		if u16::from_le_bytes([header[offset], header[offset + 1]]) != checksum {
			return Err(invalid());
		}
	}
	Ok(header)
}

pub struct Transport {
	client: Client,
}

impl Transport {
	pub fn new(reference: &[u8], additional_ca: Option<&str>) -> Result<Self> {
		let native = rustls_native_certs::load_native_certs();
		if !native.errors.is_empty() {
			return Err(
				format!("unable to load complete system CA store: {:?}", native.errors).into(),
			);
		}
		if native.certs.is_empty() {
			return Err("system CA store contains no certificates".into());
		}
		let mut roots = CertStore::builder();
		// Use strict single-cert insertion: add_der_certs intentionally ignores
		// parsing errors and would silently weaken parity with SystemCertPool.
		for certificate in native.certs {
			roots = roots.add_der_cert(certificate.as_ref());
		}
		if let Some(ca) = additional_ca.filter(|value| !value.is_empty()) {
			let inline = ca.replace("\\n", "\n");
			let pem = if inline.contains("-----BEGIN CERTIFICATE-----") {
				inline.into_bytes()
			} else {
				std::fs::read(ca)?
			};
			let certificates = Certificate::stack_from_pem(&pem)?;
			if certificates.is_empty() {
				return Err("CA file contains no certificates".into());
			}
			for certificate in certificates {
				roots = roots.add_pem_cert(certificate);
			}
		}
		let mut builder = Client::builder()
			.tls_options(tls::options(reference)?)
			.tls_cert_store(roots.build()?)
			.tls_cert_verification(true)
			.tls_verify_hostname(true)
			.http1_only()
			.connect_timeout(Duration::from_secs(30))
			.tcp_keepalive(Duration::from_secs(30))
			.pool_idle_timeout(Duration::from_secs(90))
			.pool_max_idle_per_host(100)
			.redirect(wreq::redirect::Policy::none())
			.retry(wreq::retry::Policy::never())
			.no_gzip()
			.no_brotli()
			.no_deflate()
			.no_zstd()
			.no_proxy();
		// Go ProxyFromEnvironment uses HTTPS_PROXY for HTTPS targets, not
		// ALL_PROXY or OS registry settings. Preserve its loopback exemption.
		if let Some(proxy) = environment("HTTPS_PROXY", "https_proxy") {
			let proxy_url = if proxy.contains("://") {
				Url::parse(&proxy)?
			} else {
				Url::parse(&format!("http://{proxy}"))?
			};
			if !matches!(proxy_url.scheme(), "http" | "https") {
				return Err(format!("unsupported proxy scheme {:?}", proxy_url.scheme()).into());
			}
			let mut bypass = environment("NO_PROXY", "no_proxy").unwrap_or_default();
			if !bypass.is_empty() {
				bypass.push(',');
			}
			bypass.push_str("localhost,127.0.0.0/8,::1");
			builder = builder
				.proxy(Proxy::https(proxy_url.as_str())?.no_proxy(NoProxy::from_string(&bypass)));
		}
		Ok(Self { client: builder.build()? })
	}

	pub async fn send(
		&self,
		request: &OutboundRequest,
		body: Bytes,
		chunked: bool,
	) -> Result<UpstreamResponse> {
		let mut headers = request.headers.clone();
		if headers
			.get(header::ACCEPT_ENCODING)
			.is_none_or(HeaderValue::is_empty)
			&& headers.get(header::RANGE).is_none_or(HeaderValue::is_empty)
			&& request.method != Method::HEAD
		{
			headers.insert(header::ACCEPT_ENCODING, http::HeaderValue::from_static("gzip"));
		}
		if headers
			.get(header::USER_AGENT)
			.is_some_and(HeaderValue::is_empty)
		{
			headers.remove(header::USER_AGENT);
		}
		// Go's HTTP/1.1 writer emits Host, User-Agent, framing headers, then
		// lexically sorted canonical MIME names. Transport adds gzip last.
		// wreq's default lower-case HeaderMap iteration is observably different.
		let mut order = OrigHeaderMap::new();
		for name in ["Host", "User-Agent", "Content-Length", "Transfer-Encoding"] {
			order.insert(name);
		}
		let mut names: Vec<_> = headers
			.keys()
			.filter(|name| {
				!matches!(
					*name,
					&header::HOST
						| &header::USER_AGENT
						| &header::ACCEPT_ENCODING
						| &header::CONTENT_LENGTH
						| &header::TRANSFER_ENCODING
				)
			})
			.collect();
		names.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
		for name in names {
			let mut canonical = String::with_capacity(name.as_str().len());
			let mut upper = true;
			for byte in name.as_str().bytes() {
				canonical.push(if upper {
					byte.to_ascii_uppercase()
				} else {
					byte
				} as char);
				upper = byte == b'-';
			}
			order.insert(canonical);
		}
		order.insert("Accept-Encoding");
		let body = if chunked {
			// Streaming generation has unknown length in Go even when buffered:
			// force a non-replayable stream and HTTP/1.1 chunked transfer coding.
			wreq::Body::wrap_stream(stream::once(async move { Ok::<_, io::Error>(body) }))
		} else {
			wreq::Body::from(body)
		};
		let response = self
			.client
			.request(request.method.clone(), request.url.as_str())
			.default_headers(false)
			.headers(headers)
			.orig_headers(order)
			.body(body)
			.version(http::Version::HTTP_11)
			.send()
			.await?;
		let status = response.status();
		let headers = response.headers().clone();
		let stream = response.bytes_stream().map_err(io::Error::other);
		let body: BodyReader = Box::pin(StreamReader::new(Box::pin(stream)));
		Ok(UpstreamResponse { status, headers, body })
	}
}

fn environment(upper: &str, lower: &str) -> Option<String> {
	std::env::var(upper)
		.ok()
		.filter(|value| !value.is_empty())
		.or_else(|| std::env::var(lower).ok().filter(|value| !value.is_empty()))
}

pub fn recoverable_read_error(error: &io::Error) -> bool {
	if matches!(
		error.kind(),
		io::ErrorKind::UnexpectedEof
			| io::ErrorKind::TimedOut
			| io::ErrorKind::ConnectionReset
			| io::ErrorKind::ConnectionAborted
			| io::ErrorKind::BrokenPipe
	) {
		return true;
	}
	let mut source: Option<&(dyn std::error::Error + 'static)> =
		error.get_ref().map(|error| error as _);
	while let Some(error) = source {
		if let Some(error) = error.downcast_ref::<io::Error>() {
			if matches!(
				error.kind(),
				io::ErrorKind::UnexpectedEof
					| io::ErrorKind::TimedOut
					| io::ErrorKind::ConnectionReset
					| io::ErrorKind::ConnectionAborted
					| io::ErrorKind::BrokenPipe
			) {
				return true;
			}
		}
		if let Some(error) = error.downcast_ref::<wreq::Error>() {
			if error.is_timeout() || error.is_connection_reset() {
				return true;
			}
		}
		if let Some(error) = error.downcast_ref::<wreq_proto::Error>() {
			if error.is_incomplete_message() {
				return true;
			}
		}
		source = error.source();
	}
	false
}

/// Used by bridge target validation, including bracketed IPv6 hosts.
pub fn target_is_https(target: &Url) -> bool {
	target.scheme() == "https"
		&& target.host().is_some()
		&& target.username().is_empty()
		&& target.password().is_none()
		&& target.fragment().is_none()
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn errors_do_not_retry_schema_or_compression_failures() {
		assert!(recoverable_read_error(&io::Error::from(io::ErrorKind::UnexpectedEof)));
		assert!(recoverable_read_error(&io::Error::from(io::ErrorKind::ConnectionReset)));
		assert!(!recoverable_read_error(&io::Error::new(
			io::ErrorKind::InvalidData,
			"gzip checksum mismatch"
		)));
		assert!(!recoverable_read_error(&io::Error::other("bad provider JSON")));
	}

	#[tokio::test]
	async fn gzip_header_validation_does_not_prefetch_payload() {
		let mut headers = HeaderMap::new();
		headers.insert(header::CONTENT_ENCODING, http::HeaderValue::from_static("gzip"));
		let response = UpstreamResponse {
			status: StatusCode::OK,
			headers,
			body: Box::pin(io::Cursor::new(vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0])),
		};
		let mut reader = response.decoded_body().await.unwrap();
		assert!(reader.read_to_end(&mut Vec::new()).await.is_err());
		let mut invalid: BodyReader = Box::pin(io::Cursor::new(vec![0; 10]));
		assert_eq!(gzip_header(&mut invalid).await.unwrap_err().kind(), io::ErrorKind::InvalidData);
	}
}
