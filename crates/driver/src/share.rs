//! Irreversible share-snapshot projection boundary.
//!
//! Share transports and persistence accept [`ShareProjection`], never a secret
//! session transform. This keeps placeholder keys and restoration mappings out
//! of payloads, receipts, URLs, and transport diagnostics.

use std::{fmt, future::Future, io, io::Write as _, mem, sync};

use bytes::BytesMut;
use flate2::{Compression, write::GzEncoder};
use futures::StreamExt as _;
use http::{
	HeaderMap, HeaderValue, StatusCode,
	header::{ACCEPT, CONTENT_TYPE, USER_AGENT},
};
use omp_ai::auth::HeaderPlacement;
use omp_core::{Str, base64};
use omp_envd::github_url::GithubCredentialBridge;
use omp_secrets::redact::SecretRedactor;
use ring::{
	aead,
	rand::{SecureRandom as _, SystemRandom},
};
use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;
use url::Url;
use zeroize::Zeroizing;

use crate::{secrets::session::SecretSessionSnapshot, settings::ExportSettings};

/// A materialized share snapshot after the configured leakage policy ran.
///
/// The inner value is intentionally private so callers cannot accidentally
/// mutate the projection with unredacted material before serialization.
pub struct ShareProjection(Value);
const SHARE_ENVELOPE_VERSION: u8 = 1;
/// Maximum sealed payload accepted by the primary HTTP store.
pub const HTTP_MAX_SEALED_BYTES: usize = 1_000_000;
/// Maximum sealed payload accepted by the Gist store before base64 expansion.
pub const GIST_MAX_SEALED_BYTES: usize = 5_000_000;
const STORE_RESPONSE_MAX_BYTES: usize = 64 * 1024;
const GITHUB_GIST_API: &str = "https://api.github.com/gists";
/// Self-contained zero-knowledge viewer loader. The blob location comes from
/// `?source=` while the AES key is read only from the URL fragment.
pub const SHARE_LOADER_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OMP encrypted session</title><style>
:root{color-scheme:light dark}body{font:15px system-ui;max-width:72rem;margin:3rem auto;padding:0 1rem}
#error{color:#d33;white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><p id="status">Decrypting private session…</p><pre id="error"></pre><main id="viewer"></main>
<script type="module">
const status=document.querySelector('#status'),error=document.querySelector('#error'),viewer=document.querySelector('#viewer');
const fail=message=>{status.hidden=true;error.textContent=message instanceof Error?message.message:String(message)};
const decode=value=>{value=value.replace(/-/g,'+').replace(/_/g,'/');value+='='.repeat((4-value.length%4)%4);
 return Uint8Array.from(atob(value),character=>character.charCodeAt(0))};
try {
 if(!globalThis.crypto?.subtle) throw new Error('This browser does not support WebCrypto.');
 if(typeof DecompressionStream==='undefined') throw new Error('This browser does not support gzip decompression.');
 const source=new URL(location.href).searchParams.get('source');
 const fragment=location.hash.slice(1);
 if(!source||!fragment) throw new Error('The encrypted share link is incomplete.');
 const keyBytes=decode(fragment); if(keyBytes.length!==32) throw new Error('The share key is invalid.');
 history.replaceState(null,'',location.pathname+location.search);
 const response=await fetch(source,{credentials:'omit',referrerPolicy:'no-referrer'});
 if(!response.ok) throw new Error(`Encrypted share download failed (${response.status}).`);
 const envelope=await response.json();
 if(envelope.version!==1||!Array.isArray(envelope.nonce)||!Array.isArray(envelope.ciphertext))
   throw new Error('The encrypted share envelope is unsupported.');
 const key=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['decrypt']);
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(envelope.nonce),
   additionalData:Uint8Array.of(envelope.version),tagLength:128},key,new Uint8Array(envelope.ciphertext));
 keyBytes.fill(0);
 const decompressed=new Response(new Blob([plaintext]).stream().pipeThrough(new DecompressionStream('gzip')));
 const session=await decompressed.json();
 status.hidden=true; const pre=document.createElement('pre');pre.textContent=JSON.stringify(session,null,2);viewer.append(pre);
} catch(cause) { fail(cause); }
</script></body></html>"#;
const GIST_FILENAME: &str = "session.ompshare.txt";

/// Share projection, sealing, or store failure.
#[derive(Debug, Error)]
pub enum ShareError {
	/// Projection or store response JSON was invalid.
	#[error("share JSON processing failed")]
	Json(#[from] serde_json::Error),
	/// Gzip compression failed.
	#[error("share compression failed")]
	Compress(#[from] io::Error),
	/// Cryptographic randomness was unavailable.
	#[error("operating system randomness is unavailable")]
	Random,
	/// AES-256-GCM sealing failed.
	#[error("share encryption failed")]
	Encrypt,
	/// Store endpoint syntax was invalid.
	#[error("invalid share store URL")]
	Url(#[from] url::ParseError),
	/// Store endpoint violated HTTPS/loopback and secret-free base rules.
	#[error("invalid share store endpoint")]
	InvalidEndpoint,
	/// Store transport failed.
	#[error("share store transport failed")]
	Http(#[from] reqwest::Error),
	/// Store returned a non-success response.
	#[error("share store returned HTTP {status}")]
	HttpStatus {
		/// Returned HTTP status.
		status: StatusCode,
	},
	/// Store response exceeded its small metadata ceiling.
	#[error("share store response exceeded 64 KiB")]
	ResponseTooLarge,
	/// Store response omitted its required identifier or raw URL.
	#[error("share store response was missing required fields")]
	InvalidResponse,
	/// Explicit Gist mode had no usable GitHub credential.
	#[error("GitHub authentication is unavailable for Gist sharing")]
	GithubUnauthenticated,
	/// Selected store cannot accept this sealed payload.
	#[error("sealed share is {actual} bytes; {store:?} limit is {limit} bytes")]
	PayloadTooLarge {
		/// Selected store.
		store:  ShareStoreKind,
		/// Actual sealed byte count.
		actual: usize,
		/// Store ceiling.
		limit:  usize,
	},
	/// Extension stores require an extension-owned implementation.
	#[error("extension share store is unavailable")]
	ExtensionUnavailable,
}

/// Opaque gzip/AES-256-GCM payload. The key is deliberately not serializable.
#[derive(Clone, Serialize)]
pub struct ShareEnvelope {
	/// Envelope schema revision.
	pub version:    u8,
	/// Unique AES-GCM nonce.
	pub nonce:      [u8; 12],
	/// Gzipped ciphertext with appended authentication tag.
	pub ciphertext: Vec<u8>,
}

/// Selected encrypted-share persistence backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareStoreKind {
	/// Primary bounded HTTP blob store.
	Http,
	/// Secret GitHub Gist store.
	Gist,
	/// Extension-provided store.
	Extension,
}

/// Recorded fallback from an unusable selected store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShareFallback {
	/// Failed selected store.
	pub from:    ShareStoreKind,
	/// Store used after fallback.
	pub to:      ShareStoreKind,
	/// Redacted user-facing fallback reason.
	pub message: Str,
}

/// Settled encrypted-share viewer link and persistence facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShareStoreResult {
	/// Viewer URL with key material only in its fragment.
	pub url:      Str,
	/// Store that accepted the payload.
	pub store:    ShareStoreKind,
	/// Explicit fallback fact, when Gist did not succeed.
	pub fallback: Option<ShareFallback>,
}

/// Upload boundary implemented by the environment HTTP capability.
pub trait ShareStore {
	/// Uploads one already-sealed opaque payload.
	fn upload(
		&self,
		store: ShareStoreKind,
		payload: &[u8],
	) -> impl Future<Output = Result<Str, ShareError>> + Send;
}
/// Daemon-owned direct HTTP/GitHub store using the combined credential
/// authority. This never shells out to `gh`.
pub struct DirectShareStore {
	http_base:   Url,
	credentials: sync::Arc<GithubCredentialBridge>,
	client:      omp_http::Client,
}

impl DirectShareStore {
	/// Constructs the production store from a validated HTTP(S) share base.
	pub fn new(
		http_base: &str,
		credentials: sync::Arc<GithubCredentialBridge>,
	) -> Result<Self, ShareError> {
		let mut http_base = Url::parse(http_base.trim())?;
		if !matches!(http_base.scheme(), "http" | "https")
			|| http_base.host_str().is_none()
			|| (http_base.scheme() == "http"
				&& !matches!(http_base.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
			|| !http_base.username().is_empty()
			|| http_base.password().is_some()
			|| http_base.query().is_some()
			|| http_base.fragment().is_some()
		{
			return Err(ShareError::InvalidEndpoint);
		}
		let path = http_base.path().trim_end_matches('/').to_owned();
		http_base.set_path(&path);
		let client = omp_http::no_redirect_client();
		Ok(Self { http_base, credentials, client })
	}

	async fn upload_http(&self, payload: &[u8]) -> Result<Str, ShareError> {
		enforce_ceiling(ShareStoreKind::Http, payload.len())?;
		let response = self
			.client
			.post(self.http_base.as_str())
			.header(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))
			.body(payload.to_vec())
			.send()
			.await?;
		let status = response.status();
		if !status.is_success() {
			return Err(ShareError::HttpStatus { status });
		}
		let body = read_bounded(response).await?;
		let response: HttpUploadResponse = serde_json::from_slice(&body)?;
		if response.id.is_empty() || response.id.contains(['/', '#', '?']) {
			return Err(ShareError::InvalidResponse);
		}
		let mut url = self.http_base.clone();
		let mut path = url.path().trim_end_matches('/').to_owned();
		path.push('/');
		path.push_str(&response.id);
		url.set_path(&path);
		Ok(Str::from(url.as_str()))
	}

	async fn upload_gist(&self, payload: &[u8]) -> Result<Str, ShareError> {
		enforce_ceiling(ShareStoreKind::Gist, payload.len())?;
		let lease = self
			.credentials
			.lease()
			.await
			.map_err(|_| ShareError::GithubUnauthenticated)?
			.ok_or(ShareError::GithubUnauthenticated)?;
		let mut headers = HeaderMap::new();
		headers.insert(USER_AGENT, HeaderValue::from_static("omp-share"));
		headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
		headers.insert("x-github-api-version", HeaderValue::from_static("2022-11-28"));
		lease
			.apply_header(&HeaderPlacement::bearer(), &mut headers)
			.map_err(|_| ShareError::GithubUnauthenticated)?;
		let encoded = base64::encode(payload).into_string();
		let request = serde_json::json!({
			"public": false,
			"description": "Encrypted OMP session share",
			"files": { (GIST_FILENAME): { "content": encoded } },
		});
		let response = self
			.client
			.post(GITHUB_GIST_API)
			.headers(headers)
			.json(&request)
			.send()
			.await?;
		let status = response.status();
		if !status.is_success() {
			return Err(ShareError::HttpStatus { status });
		}
		let body = read_bounded(response).await?;
		let response: Value = serde_json::from_slice(&body)?;
		let raw_url = response
			.get("files")
			.and_then(|files| files.get(GIST_FILENAME))
			.and_then(|file| file.get("raw_url"))
			.and_then(Value::as_str)
			.ok_or(ShareError::InvalidResponse)?;
		let raw_url = Url::parse(raw_url)?;
		if raw_url.scheme() != "https" {
			return Err(ShareError::InvalidResponse);
		}
		Ok(Str::from(raw_url.as_str()))
	}
}

impl ShareStore for DirectShareStore {
	fn upload(
		&self,
		store: ShareStoreKind,
		payload: &[u8],
	) -> impl Future<Output = Result<Str, ShareError>> + Send {
		async move {
			match store {
				ShareStoreKind::Http => self.upload_http(payload).await,
				ShareStoreKind::Gist => self.upload_gist(payload).await,
				ShareStoreKind::Extension => Err(ShareError::ExtensionUnavailable),
			}
		}
	}
}

#[derive(serde::Deserialize)]
struct HttpUploadResponse {
	id: String,
}
fn enforce_ceiling(store: ShareStoreKind, actual: usize) -> Result<(), ShareError> {
	let limit = match store {
		ShareStoreKind::Http => HTTP_MAX_SEALED_BYTES,
		ShareStoreKind::Gist => GIST_MAX_SEALED_BYTES,
		ShareStoreKind::Extension => return Err(ShareError::ExtensionUnavailable),
	};
	if actual > limit {
		return Err(ShareError::PayloadTooLarge { store, actual, limit });
	}
	Ok(())
}

async fn read_bounded(response: reqwest::Response) -> Result<BytesMut, ShareError> {
	let mut body = BytesMut::new();
	let mut stream = response.bytes_stream();
	while let Some(chunk) = stream.next().await {
		let chunk = chunk?;
		if body.len().saturating_add(chunk.len()) > STORE_RESPONSE_MAX_BYTES {
			return Err(ShareError::ResponseTooLarge);
		}
		body.extend_from_slice(&chunk);
	}
	Ok(body)
}

/// Sealed share material whose key is accessible only as a URL fragment.
pub struct SealedShare {
	/// Serialized opaque envelope uploaded to a selected store.
	pub envelope: ShareEnvelope,
	key:          Zeroizing<[u8; 32]>,
}

impl SealedShare {
	/// Returns the unpadded base64url key fragment.
	pub fn fragment(&self) -> String {
		base64url(&self.key[..])
	}

	/// Serializes the versioned envelope without exposing its key.
	pub fn envelope_bytes(&self) -> Result<Vec<u8>, ShareError> {
		serde_json::to_vec(&self.envelope).map_err(Into::into)
	}
}

/// Gzips and AES-256-GCM seals one already-redacted projection.
pub fn seal(projection: &ShareProjection) -> Result<SealedShare, ShareError> {
	let json = serde_json::to_vec(projection)?;
	let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
	gzip.write_all(&json)?;
	let mut ciphertext = gzip.finish()?;
	let random = SystemRandom::new();
	let mut key = Zeroizing::new([0_u8; 32]);
	let mut nonce = [0_u8; 12];
	random.fill(&mut key[..]).map_err(|_| ShareError::Random)?;
	random.fill(&mut nonce).map_err(|_| ShareError::Random)?;
	let unbound =
		aead::UnboundKey::new(&aead::AES_256_GCM, &key[..]).map_err(|_| ShareError::Encrypt)?;
	aead::LessSafeKey::new(unbound)
		.seal_in_place_append_tag(
			aead::Nonce::assume_unique_for_key(nonce),
			aead::Aad::from([SHARE_ENVELOPE_VERSION]),
			&mut ciphertext,
		)
		.map_err(|_| ShareError::Encrypt)?;
	Ok(SealedShare {
		envelope: ShareEnvelope { version: SHARE_ENVELOPE_VERSION, nonce, ciphertext },
		key,
	})
}

/// Uploads to the selected store. Gist failure explicitly falls back to HTTP.
pub async fn upload(
	store: &impl ShareStore,
	selected: ShareStoreKind,
	sealed: &SealedShare,
	viewer_url: &str,
) -> Result<ShareStoreResult, ShareError> {
	let payload = sealed.envelope_bytes()?;
	let (blob_url, actual, fallback) = match store.upload(selected, &payload).await {
		Ok(url) => (url, selected, None),
		Err(error) if selected == ShareStoreKind::Gist => {
			let message = fallback_message(&error);
			let url = store.upload(ShareStoreKind::Http, &payload).await?;
			(
				url,
				ShareStoreKind::Http,
				Some(ShareFallback { from: ShareStoreKind::Gist, to: ShareStoreKind::Http, message }),
			)
		},
		Err(error) => return Err(error),
	};
	let url = Str::from(format!(
		"{viewer_url}?source={}#{}",
		percent_encode(blob_url.as_str()),
		sealed.fragment(),
	));
	Ok(ShareStoreResult { url, store: actual, fallback })
}

fn base64url(bytes: &[u8]) -> String {
	omp_core::base64_url::encode_raw(bytes).into_string()
}
fn fallback_message(error: &ShareError) -> Str {
	let message = match error {
		ShareError::GithubUnauthenticated => "GitHub authentication is unavailable",
		ShareError::PayloadTooLarge { .. } => "sealed share exceeds the Gist limit",
		ShareError::HttpStatus { .. } => "GitHub rejected the Gist upload",
		ShareError::Http(_) => "GitHub transport failed",
		ShareError::ResponseTooLarge | ShareError::InvalidResponse | ShareError::Json(_) => {
			"GitHub returned an unusable Gist response"
		},
		ShareError::Url(_) | ShareError::InvalidEndpoint => "GitHub returned an invalid Gist URL",
		ShareError::Compress(_)
		| ShareError::Random
		| ShareError::Encrypt
		| ShareError::ExtensionUnavailable => "Gist upload was unavailable",
	};
	Str::new_static(message)
}

fn percent_encode(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
			out.push(char::from(byte));
		} else {
			use fmt::Write as _;
			let _ = write!(out, "%{byte:02X}");
		}
	}
	out
}

impl fmt::Debug for ShareProjection {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ShareProjection")
			.finish_non_exhaustive()
	}
}

impl Serialize for ShareProjection {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		self.0.serialize(serializer)
	}
}

impl ShareProjection {
	/// Applies the authoritative export policy to a fully materialized snapshot.
	///
	/// Redaction is independent of reversible provider obfuscation. Only
	/// `export.shareRedactSecrets = false` bypasses this walk.
	pub fn materialize(
		mut snapshot: Value,
		policy: ExportSettings,
		secrets: &SecretSessionSnapshot,
	) -> Self {
		if policy.share_redact_secrets {
			let mut redactor = SecretRedactor::new(secrets.rules().iter().cloned());
			redact_value(&mut snapshot, &mut redactor);
		}
		Self(snapshot)
	}

	/// Applies the leakage policy and progressively trims the projection to a
	/// deterministic serialization budget.
	pub fn materialize_bounded(
		snapshot: Value,
		policy: ExportSettings,
		secrets: &SecretSessionSnapshot,
		max_json_bytes: usize,
	) -> Self {
		let mut projection = Self::materialize(snapshot, policy, secrets);
		projection.trim_to_budget(max_json_bytes);
		projection
	}

	/// Progressively removes high-weight share-only material, caps text, then
	/// prunes oldest conversation entries until the serialized payload fits.
	pub fn trim_to_budget(&mut self, max_json_bytes: usize) {
		strip_opaque_payloads(&mut self.0);
		if serialized_len(&self.0) <= max_json_bytes {
			return;
		}
		strip_inline_images(&mut self.0);
		for cap in [64 * 1024, 16 * 1024, 4 * 1024] {
			if serialized_len(&self.0) <= max_json_bytes {
				return;
			}
			cap_strings(&mut self.0, cap);
		}
		while serialized_len(&self.0) > max_json_bytes && prune_oldest_entry(&mut self.0) {}
	}
}

fn serialized_len(value: &Value) -> usize {
	serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn strip_opaque_payloads(value: &mut Value) {
	match value {
		Value::Array(values) => values.iter_mut().for_each(strip_opaque_payloads),
		Value::Object(object) => {
			object.retain(|key, _| {
				!matches!(
					key.as_str(),
					"raw"
						| "opaque" | "signature"
						| "provider_metadata"
						| "providerMetadata"
						| "replay_capsule"
						| "replayCapsule"
						| "encrypted_content"
						| "encryptedContent"
				)
			});
			object.values_mut().for_each(strip_opaque_payloads);
		},
		Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {},
	}
}

fn strip_inline_images(value: &mut Value) {
	match value {
		Value::String(text) if text.starts_with("data:image/") => {
			*text = "[inline image removed from share]".to_owned();
		},
		Value::Array(values) => values.iter_mut().for_each(strip_inline_images),
		Value::Object(object) => {
			let image = object
				.get("mime")
				.or_else(|| object.get("mime_type"))
				.or_else(|| object.get("media_type"))
				.and_then(Value::as_str)
				.is_some_and(|mime| mime.starts_with("image/"));
			if image {
				for key in ["data", "bytes", "base64", "payload", "content"] {
					if object.contains_key(key) {
						object.insert(
							key.to_owned(),
							Value::String("[inline image removed from share]".to_owned()),
						);
					}
				}
			}
			object.values_mut().for_each(strip_inline_images);
		},
		Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {},
	}
}

fn cap_strings(value: &mut Value, cap: usize) {
	match value {
		Value::String(text) if text.len() > cap => {
			let mut end = cap.min(text.len());
			while !text.is_char_boundary(end) {
				end -= 1;
			}
			let removed = text.len().saturating_sub(end);
			text.truncate(end);
			text.push_str("\n… [");
			text.push_str(&removed.to_string());
			text.push_str(" bytes removed from share]");
		},
		Value::Array(values) => values.iter_mut().for_each(|value| cap_strings(value, cap)),
		Value::Object(object) => object
			.values_mut()
			.for_each(|value| cap_strings(value, cap)),
		Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {},
	}
}

fn prune_oldest_entry(value: &mut Value) -> bool {
	match value {
		Value::Object(object) => {
			for key in ["entries", "messages", "conversation"] {
				if let Some(Value::Array(entries)) = object.get_mut(key)
					&& entries.len() > 1
				{
					entries.remove(0);
					return true;
				}
			}
			object.values_mut().any(prune_oldest_entry)
		},
		Value::Array(values) => values.iter_mut().any(prune_oldest_entry),
		Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
	}
}

fn redact_value(value: &mut Value, redactor: &mut SecretRedactor) {
	match value {
		Value::String(text) => *text = redactor.redact(text),
		Value::Array(values) => {
			for value in values {
				redact_value(value, redactor);
			}
		},
		Value::Object(object) => {
			let mut redacted = Map::with_capacity(object.len());
			for (key, mut value) in mem::take(object) {
				redact_value(&mut value, redactor);
				redacted.insert(redactor.redact(&key), value);
			}
			*object = redacted;
		},
		Value::Null | Value::Bool(_) | Value::Number(_) => {},
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

	struct FakeStore {
		gist_fails: bool,
		http_calls: AtomicUsize,
		gist_calls: AtomicUsize,
	}

	impl ShareStore for FakeStore {
		fn upload(
			&self,
			store: ShareStoreKind,
			_: &[u8],
		) -> impl Future<Output = Result<Str, ShareError>> + Send {
			async move {
				match store {
					ShareStoreKind::Http => {
						self.http_calls.fetch_add(1, Ordering::Relaxed);
						Ok(Str::new_static("https://share.example/blob"))
					},
					ShareStoreKind::Gist => {
						self.gist_calls.fetch_add(1, Ordering::Relaxed);
						if self.gist_fails {
							Err(ShareError::GithubUnauthenticated)
						} else {
							Ok(Str::new_static("https://gist.example/raw"))
						}
					},
					ShareStoreKind::Extension => Err(ShareError::ExtensionUnavailable),
				}
			}
		}
	}

	#[tokio::test]
	async fn explicit_gist_failure_falls_back_to_http() {
		let store = FakeStore {
			gist_fails: true,
			http_calls: AtomicUsize::new(0),
			gist_calls: AtomicUsize::new(0),
		};
		let sealed = seal(&ShareProjection(Value::Null)).expect("seal");
		let result = upload(&store, ShareStoreKind::Gist, &sealed, "https://viewer.example")
			.await
			.expect("fallback upload");
		assert_eq!(result.store, ShareStoreKind::Http);
		assert!(result.fallback.is_some());
		assert_eq!(store.gist_calls.load(Ordering::Relaxed), 1);
		assert_eq!(store.http_calls.load(Ordering::Relaxed), 1);
		let (request_target, fragment) = result.url.split_once('#').expect("fragment");
		assert!(!fragment.is_empty());
		assert!(!request_target.contains(fragment));
	}

	#[tokio::test]
	async fn explicit_gist_success_does_not_touch_http() {
		let store = FakeStore {
			gist_fails: false,
			http_calls: AtomicUsize::new(0),
			gist_calls: AtomicUsize::new(0),
		};
		let sealed = seal(&ShareProjection(Value::Null)).expect("seal");
		let result = upload(&store, ShareStoreKind::Gist, &sealed, "https://viewer.example")
			.await
			.expect("gist upload");
		assert_eq!(result.store, ShareStoreKind::Gist);
		assert!(result.fallback.is_none());
		assert_eq!(store.http_calls.load(Ordering::Relaxed), 0);
	}

	#[test]
	fn store_ceilings_match_pi() {
		assert!(enforce_ceiling(ShareStoreKind::Http, HTTP_MAX_SEALED_BYTES).is_ok());
		assert!(enforce_ceiling(ShareStoreKind::Http, HTTP_MAX_SEALED_BYTES + 1).is_err());
		assert!(enforce_ceiling(ShareStoreKind::Gist, GIST_MAX_SEALED_BYTES).is_ok());
	}
}
