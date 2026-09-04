//! Resource-owned local and special-source I/O for `read@1`.

use std::{
	borrow::Cow,
	fmt, fs,
	future::{Future, ready},
	io,
	path::{Component, Path, PathBuf},
	sync::{
		Arc, LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::{Bytes, BytesMut};
use futures::StreamExt as _;
use http::{
	HeaderMap, HeaderName, HeaderValue, StatusCode,
	header::{ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, CONTENT_TYPE, RETRY_AFTER, USER_AGENT},
};
use omp_cache::document_cache::{DocumentCache, DocumentCacheKey};
use omp_core::{Hash32, Str, dirs::home_dir, sf, shorten_home_path};
use omp_tools::read::{
	DirectoryEntry, DirectorySource, Fault, ReadLease, ReadSources, SNAPSHOT_MAX_BYTES,
	SnapshotRecord, SourceKind, SourceStat,
	markit::Conversion,
	web::types::{
		CachedDocument, DocumentCacheLocation, DocumentCacheRequest, HttpClient, HttpRequest,
		HttpResponse, MAX_BYTES, USER_AGENTS, WebError,
	},
};
use omp_walker::{FileType, WalkDetail, WalkOrder, WalkRequest};
use tokio::{io::AsyncReadExt as _, time};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	docs::{DocumentHost, DocumentLease},
	tool_document::{read_document_metadata, read_whole, resolve_read_document, snapshot_text},
	workspace::WorkspaceHost,
};

const MAX_REDIRECTS: usize = 20;
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(1);
static READ_CLIENT: LazyLock<omp_http::Client> = LazyLock::new(|| {
	omp_http::client_builder()
		.redirect(redirect::Policy::limited(MAX_REDIRECTS))
		.referer(false)
		.build()
		.expect("build read HTTP client")
		.into()
});

use omp_cache::atomic;
use reqwest::redirect;
use thiserror::Error;
use tokio::task;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
static MEDIA_COMMIT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Failure while committing one extracted document-media directory.
#[derive(Debug, Error)]
pub enum DocumentMediaCommitError {
	/// The destination already exists and cannot be atomically replaced as an
	/// unrelated caller-owned directory.
	#[error("document media destination already exists")]
	DestinationExists,
	/// A storage commit failed.
	#[error("document media file commit failed")]
	Atomic(#[from] atomic::Error),
	/// Directory creation, cleanup, or rename failed.
	#[error("document media directory transaction failed")]
	Io(#[from] io::Error),
}

/// Atomically commits extracted DOCX/PPTX media and rewrites image
/// placeholders to the committed local paths.
///
/// The destination must not exist: callers select a fresh conversion-owned
/// directory, preventing this transaction from deleting unrelated files.
pub fn commit_document_media(
	destination: &Path,
	conversion: &mut Conversion,
) -> Result<(), DocumentMediaCommitError> {
	if conversion.attachments.is_empty() {
		return Ok(());
	}
	if destination.exists() {
		return Err(DocumentMediaCommitError::DestinationExists);
	}
	let parent = destination.parent().unwrap_or_else(|| Path::new("."));
	fs::create_dir_all(parent)?;
	let sequence = MEDIA_COMMIT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
	let stage = parent.join(format!(".omp-document-media-{sequence:016x}.tmp"));
	if stage.exists() {
		fs::remove_dir_all(&stage)?;
	}
	fs::create_dir(&stage)?;
	let committed = (|| {
		for attachment in &conversion.attachments {
			omp_cache::atomic::commit(
				&stage.join(attachment.name.as_str()),
				&attachment.bytes,
				|| true,
			)?;
		}
		fs::rename(&stage, destination)?;
		Ok::<_, DocumentMediaCommitError>(())
	})();
	if let Err(error) = committed {
		let _ = fs::remove_dir_all(&stage);
		return Err(error);
	}
	rewrite_document_media_links(destination, conversion);
	Ok(())
}

fn rewrite_document_media_links(destination: &Path, conversion: &mut Conversion) {
	let mut text = conversion.text.to_string();
	let mut cursor = 0;
	let mut attachment_index = 0_usize;
	while let Some(start) = text[cursor..].find("<!-- image") {
		let start = cursor + start;
		let Some(end) = text[start..].find("-->") else {
			break;
		};
		let end = start + end + 3;
		let attachment = &conversion.attachments
			[attachment_index.min(conversion.attachments.len().saturating_sub(1))];
		let link = destination.join(attachment.name.as_str());
		let replacement = format!("![{}]({})", attachment.name, link.display());
		text.replace_range(start..end, &replacement);
		cursor = start + replacement.len();
		attachment_index = attachment_index.saturating_add(1);
	}
	conversion.text = Str::new(text);
}

#[derive(Clone)]
struct SystemHttpClient {
	inner: omp_http::Client,
}

impl SystemHttpClient {
	fn new() -> Self {
		Self { inner: READ_CLIENT.clone() }
	}

	async fn request(&self, request: HttpRequest) -> Result<HttpResponse, WebError> {
		let mut authored_url = Url::parse(&request.url)
			.map_err(|error| WebError::InvalidUrl(error.to_string().into()))?;
		validate_http_url(&authored_url)?;
		authored_url.set_fragment(None);
		time::timeout(HTTP_TIMEOUT, self.request_with_retries(authored_url, request))
			.await
			.map_err(|_| WebError::request("request timed out after 30s"))?
	}

	async fn request_with_retries(
		&self,
		authored_url: Url,
		request: HttpRequest,
	) -> Result<HttpResponse, WebError> {
		let max_bytes = request.max_bytes.min(MAX_BYTES);
		let caller_headers = parse_request_headers(&request.headers)?;
		let mut retried_429 = false;
		let mut last_error = None;

		for (attempt, user_agent) in USER_AGENTS.iter().enumerate() {
			loop {
				let response = match self
					.inner
					.get(authored_url.as_str())
					.headers(request_headers(user_agent, &caller_headers))
					.send()
					.await
				{
					Ok(response) => response,
					Err(error) => {
						last_error = Some(WebError::request(error.to_string()));
						break;
					},
				};
				if response.status() == StatusCode::TOO_MANY_REQUESTS && !retried_429 {
					retried_429 = true;
					let delay = retry_after(response.headers().get(RETRY_AFTER));
					drop(response);
					time::sleep(delay).await;
					continue;
				}

				let final_url = Str::from(response.url().to_string());
				let status = response.status().as_u16();
				let headers = response.headers().clone();
				let body = match read_bounded(response, max_bytes).await {
					Ok(body) => body,
					Err(error @ WebError::ResponseTooLarge { .. }) => return Err(error),
					Err(error) => {
						last_error = Some(error);
						break;
					},
				};
				if is_bot_blocked(status, &headers, &body) && attempt + 1 < USER_AGENTS.len() {
					break;
				}
				return Ok(build_http_response(final_url, status, headers, body));
			}
		}

		Err(last_error.unwrap_or_else(|| WebError::request("HTTP request failed")))
	}
}

impl fmt::Debug for SystemHttpClient {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("SystemHttpClient(..)")
	}
}

impl Default for SystemHttpClient {
	fn default() -> Self {
		Self::new()
	}
}

impl HttpClient for SystemHttpClient {
	fn get(
		&self,
		request: HttpRequest,
	) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
		self.request(request)
	}
}

fn validate_http_url(url: &Url) -> Result<(), WebError> {
	if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
		return Err(WebError::InvalidUrl(url.as_str().into()));
	}
	Ok(())
}

fn parse_request_headers(headers: &[(Str, Str)]) -> Result<HeaderMap, WebError> {
	let mut parsed = HeaderMap::with_capacity(headers.len());
	for (name, value) in headers {
		let name = HeaderName::from_bytes(name.as_bytes())
			.map_err(|error| WebError::request(format!("invalid request header '{name}': {error}")))?;
		let value = HeaderValue::from_str(value)
			.map_err(|error| WebError::request(format!("invalid request header value: {error}")))?;
		parsed.insert(name, value);
	}
	Ok(parsed)
}

fn request_headers(user_agent: &'static str, caller: &HeaderMap) -> HeaderMap {
	let mut headers = HeaderMap::with_capacity(caller.len() + 4);
	headers.insert(USER_AGENT, HeaderValue::from_static(user_agent));
	headers.insert(
		ACCEPT,
		HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
	);
	headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.5"));
	headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
	for (name, value) in caller {
		headers.insert(name.clone(), value.clone());
	}
	headers
}

async fn read_bounded(response: reqwest::Response, max_bytes: usize) -> Result<Bytes, WebError> {
	let content_length = response.content_length();
	if content_length.is_some_and(|length| length > u64::try_from(max_bytes).unwrap_or(u64::MAX)) {
		return Err(WebError::ResponseTooLarge { max_bytes });
	}
	let initial_capacity = content_length
		.and_then(|length| usize::try_from(length).ok())
		.unwrap_or_default()
		.min(max_bytes);
	let mut bytes = BytesMut::with_capacity(initial_capacity);
	let mut stream = response.bytes_stream();
	while let Some(chunk) = stream.next().await {
		let chunk = chunk.map_err(|error| WebError::request(error.to_string()))?;
		if bytes.len().saturating_add(chunk.len()) > max_bytes {
			return Err(WebError::ResponseTooLarge { max_bytes });
		}
		bytes.extend_from_slice(&chunk);
	}
	Ok(bytes.freeze())
}

fn build_http_response(
	final_url: Str,
	status: u16,
	headers: HeaderMap,
	body: Bytes,
) -> HttpResponse {
	let content_type = headers
		.get(CONTENT_TYPE)
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.split(';').next())
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| value.to_ascii_lowercase().into());
	let headers = headers
		.iter()
		.map(|(name, value)| {
			(
				Str::from(name.as_str()),
				Str::from(String::from_utf8_lossy(value.as_bytes()).into_owned()),
			)
		})
		.collect();
	HttpResponse { final_url, status, content_type, headers, body }
}

fn is_bot_blocked(status: u16, headers: &HeaderMap, body: &[u8]) -> bool {
	if status != 403 && status != 503 {
		return false;
	}
	let content = decode_response_text(headers, body);
	["cloudflare", "captcha", "challenge", "blocked", "access denied", "bot detection"]
		.iter()
		.any(|marker| contains_ascii_case_insensitive(content.as_bytes(), marker.as_bytes()))
}

fn decode_response_text<'a>(headers: &HeaderMap, body: &'a [u8]) -> Cow<'a, str> {
	let label = headers
		.get(CONTENT_TYPE)
		.and_then(|value| value.to_str().ok())
		.and_then(charset_from_content_type)
		.or_else(|| charset_from_meta(body));
	let encoding = label
		.as_deref()
		.and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
		.unwrap_or(encoding_rs::UTF_8);
	encoding.decode(body).0
}

fn charset_from_content_type(content_type: &str) -> Option<String> {
	content_type.split(';').skip(1).find_map(|parameter| {
		let (name, value) = parameter.split_once('=')?;
		name.trim().eq_ignore_ascii_case("charset").then(|| {
			value
				.trim()
				.trim_matches(|character| character == '"' || character == '\'')
				.to_owned()
		})
	})
}

fn charset_from_meta(body: &[u8]) -> Option<String> {
	let prefix = &body[..body.len().min(2048)];
	let lower = prefix
		.iter()
		.map(u8::to_ascii_lowercase)
		.collect::<Vec<_>>();
	let mut offset = 0;
	while let Some(relative) = find_bytes(&lower[offset..], b"<meta") {
		let start = offset + relative + 5;
		let end = lower[start..]
			.iter()
			.position(|byte| *byte == b'>')
			.map_or(lower.len(), |relative| start + relative);
		if let Some(relative) = find_bytes(&lower[start..end], b"charset") {
			let mut cursor = start + relative + b"charset".len();
			while lower.get(cursor).is_some_and(u8::is_ascii_whitespace) {
				cursor += 1;
			}
			if lower.get(cursor) != Some(&b'=') {
				offset = end.saturating_add(1);
				continue;
			}
			cursor += 1;
			while lower.get(cursor).is_some_and(u8::is_ascii_whitespace) {
				cursor += 1;
			}
			if matches!(lower.get(cursor), Some(b'"' | b'\'')) {
				cursor += 1;
			}
			let label_start = cursor;
			while lower
				.get(cursor)
				.is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
			{
				cursor += 1;
			}
			if cursor > label_start {
				return String::from_utf8(lower[label_start..cursor].to_vec()).ok();
			}
		}
		offset = end.saturating_add(1);
	}
	None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
	haystack
		.windows(needle.len())
		.any(|window| window.eq_ignore_ascii_case(needle))
}

fn retry_after(value: Option<&HeaderValue>) -> Duration {
	let Some(value) = value.and_then(|value| value.to_str().ok()) else {
		return DEFAULT_RETRY_AFTER;
	};
	if let Ok(seconds) = value.trim().parse::<f64>()
		&& seconds.is_finite()
	{
		let seconds = seconds.clamp(0.0, MAX_RETRY_AFTER.as_secs_f64());
		return Duration::from_secs_f64(seconds);
	}
	let Some(time) = parse_http_date(value) else {
		return DEFAULT_RETRY_AFTER;
	};
	time
		.duration_since(SystemTime::now())
		.unwrap_or(Duration::ZERO)
		.min(MAX_RETRY_AFTER)
}

fn parse_http_date(value: &str) -> Option<SystemTime> {
	let fields = value.split_ascii_whitespace().collect::<Vec<_>>();
	if fields.len() != 6 || !fields[0].ends_with(',') || !fields[5].eq_ignore_ascii_case("GMT") {
		return None;
	}
	let day = fields[1].parse::<u32>().ok()?;
	let month = match fields[2].to_ascii_lowercase().as_str() {
		"jan" => 1,
		"feb" => 2,
		"mar" => 3,
		"apr" => 4,
		"may" => 5,
		"jun" => 6,
		"jul" => 7,
		"aug" => 8,
		"sep" => 9,
		"oct" => 10,
		"nov" => 11,
		"dec" => 12,
		_ => return None,
	};
	let year = fields[3].parse::<i64>().ok()?;
	let mut time = fields[4].split(':');
	let hour = time.next()?.parse::<u32>().ok()?;
	let minute = time.next()?.parse::<u32>().ok()?;
	let second = time.next()?.parse::<u32>().ok()?;
	let max_day = match month {
		2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
		2 => 28,
		4 | 6 | 9 | 11 => 30,
		_ => 31,
	};
	if time.next().is_some()
		|| !(1601..=9999).contains(&year)
		|| !(1..=max_day).contains(&day)
		|| hour > 23
		|| minute > 59
		|| second > 60
	{
		return None;
	}
	let days = days_from_civil(year, month, day);
	let seconds = days
		.checked_mul(86_400)?
		.checked_add(i64::from(hour) * 3_600)?
		.checked_add(i64::from(minute) * 60)?
		.checked_add(i64::from(second.min(59)))?;
	(seconds >= 0).then(|| UNIX_EPOCH + Duration::from_secs(seconds as u64))
}

fn days_from_civil(mut year: i64, month: u32, day: u32) -> i64 {
	if month <= 2 {
		year -= 1;
	}
	let era = year.div_euclid(400);
	let year_of_era = year - era * 400;
	let adjusted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
	let day_of_year = (153 * adjusted_month + 2) / 5 + i64::from(day) - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
}

/// App-owned source adapter joining document leases and canonical workspace
/// I/O.
#[derive(Clone, Debug)]
pub struct ReadSourceAdapter {
	documents:      DocumentHost,
	workspace:      WorkspaceHost,
	http:           SystemHttpClient,
	document_cache: Arc<DocumentCache>,
}

impl ReadSourceAdapter {
	/// Creates a source adapter over one project environment's shared resources
	/// and the user-wide document-conversion cache.
	pub(crate) fn new(
		documents: DocumentHost,
		workspace: WorkspaceHost,
		document_cache: DocumentCache,
	) -> Self {
		Self {
			documents,
			workspace,
			http: SystemHttpClient::new(),
			document_cache: Arc::new(document_cache),
		}
	}

	async fn stat_path(&self, authored: &str) -> Result<SourceStat, Fault> {
		let candidate = resolve_authored_path(self.workspace.root(), authored);
		let authored_metadata = tokio::fs::symlink_metadata(&candidate)
			.await
			.map_err(|error| source_io("stat", authored, error))?;
		let canonical = tokio::fs::canonicalize(&candidate)
			.await
			.map_err(|error| source_io("canonicalize", authored, error))?;
		let metadata = tokio::fs::metadata(&canonical)
			.await
			.map_err(|error| source_io("stat", authored, error))?;
		let kind = if authored_metadata.file_type().is_symlink() {
			SourceKind::Symlink
		} else if metadata.is_dir() {
			SourceKind::Directory
		} else {
			SourceKind::File
		};
		let canonical_path = utf8_path(&canonical)?;
		let display_path = display_path(self.workspace.root(), &candidate)?;
		Ok(SourceStat {
			canonical_path,
			display_path,
			kind,
			byte_len: metadata.len(),
			modified_ms: modified_ms(&metadata),
		})
	}
}

impl HttpClient for ReadSourceAdapter {
	fn get(
		&self,
		request: HttpRequest,
	) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
		self.http.get(request)
	}

	async fn document_cache_get(&self, request: DocumentCacheRequest) -> Option<CachedDocument> {
		let cache = self.document_cache.clone();
		let result = task::spawn_blocking(move || {
			let key = document_cache_key(request)?;
			let entry = cache.get(key, SystemTime::now())?;
			Ok::<_, omp_cache::document_cache::DocumentCacheError>(entry.map(|entry| CachedDocument {
				content:  entry.content,
				location: DocumentCacheLocation {
					key:  entry.metadata.key.digest(),
					blob: entry.metadata.blob,
				},
			}))
		})
		.await;
		match result {
			Ok(Ok(cached)) => cached,
			Ok(Err(error)) => {
				tracing::debug!(%error, "document conversion cache lookup failed");
				None
			},
			Err(error) => {
				tracing::debug!(%error, "document conversion cache lookup task failed");
				None
			},
		}
	}

	async fn document_cache_put(
		&self,
		request: DocumentCacheRequest,
		content: Bytes,
	) -> Option<CachedDocument> {
		let cache = self.document_cache.clone();
		let published = content.clone();
		let result = task::spawn_blocking(move || {
			let key = document_cache_key(request)?;
			let metadata = cache.put(key, &published, SystemTime::now(), None)?;
			Ok::<_, omp_cache::document_cache::DocumentCacheError>(DocumentCacheLocation {
				key:  metadata.key.digest(),
				blob: metadata.blob,
			})
		})
		.await;
		match result {
			Ok(Ok(location)) => Some(CachedDocument { content, location }),
			Ok(Err(error)) => {
				tracing::debug!(%error, "document conversion cache publication failed");
				None
			},
			Err(error) => {
				tracing::debug!(%error, "document conversion cache publication task failed");
				None
			},
		}
	}
}

fn document_cache_key(
	request: DocumentCacheRequest,
) -> Result<DocumentCacheKey, omp_cache::document_cache::DocumentCacheError> {
	DocumentCacheKey::derive(
		request.source_digest,
		request.converter,
		request.converter_version,
		&serde_json::json!({ "options_digest": request.options_digest }),
	)
}

/// One app-owned lease whose bytes remain stable until drop.
#[derive(Debug)]
pub struct ReadDocumentLease {
	backing:        ReadLeaseBacking,
	revision:       Str,
	canonical_path: Str,
}

#[derive(Debug)]
enum ReadLeaseBacking {
	Document { host: DocumentHost, lease: DocumentLease },
	File(Bytes),
}

impl ReadLease for ReadDocumentLease {
	fn revision(&self) -> &Str {
		&self.revision
	}

	fn canonical_path(&self) -> &Str {
		&self.canonical_path
	}

	async fn read_all(&self) -> Result<Bytes, Fault> {
		match &self.backing {
			ReadLeaseBacking::Document { host, lease } => read_whole(host, lease)
				.await
				.map_err(|error| Fault::source(error.to_string())),
			ReadLeaseBacking::File(bytes) => Ok(bytes.clone()),
		}
	}
}

async fn open_filesystem_lease(io_path: Str, source_path: Str) -> Result<ReadDocumentLease, Fault> {
	let bytes = tokio::fs::read(io_path.as_str())
		.await
		.map(Bytes::from)
		.map_err(|error| source_io("read", &io_path, error))?;
	let revision = Str::from(format!("fs:{}", Hash32::sum(&bytes).to_hex()));
	Ok(ReadDocumentLease {
		backing: ReadLeaseBacking::File(bytes),
		revision,
		canonical_path: source_path,
	})
}

impl ReadSources for ReadSourceAdapter {
	type Lease = ReadDocumentLease;

	async fn stat(&self, path: Str) -> Result<SourceStat, Fault> {
		self.stat_path(&path).await
	}

	async fn resolve_suffix(&self, path: Str) -> Result<Option<SourceStat>, Fault> {
		let Some(suffix) = normalized_suffix(&path) else {
			return Ok(None);
		};
		let request = self
			.workspace
			.request()
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.skip_node_modules(true)
			.detail(WalkDetail::Minimal)
			.order(WalkOrder::Path)
			.depth(1, usize::MAX);
		let deadline = Instant::now() + Duration::from_secs(5);
		let Ok(outcome) = request.collect_with_heartbeat(|| {
			(Instant::now() < deadline)
				.then_some(())
				.ok_or("suffix resolution timed out")
		}) else {
			return Ok(None);
		};
		let mut matched = None;
		for entry in outcome.entries {
			if path_has_suffix(&entry.path, &suffix) {
				if matched.is_some() {
					return Ok(None);
				}
				matched = Some(entry.path);
			}
		}
		let Some(relative) = matched else {
			return Ok(None);
		};
		let absolute = self.workspace.root().join(&relative);
		let absolute = utf8_path(&absolute)?;
		let Ok(mut stat) = self.stat_path(&absolute).await else {
			return Ok(None);
		};
		stat.display_path = Str::from(relative);
		Ok(Some(stat))
	}

	async fn open(&self, path: Str) -> Result<Self::Lease, Fault> {
		let authored_path = resolve_authored_path(self.workspace.root(), &path);
		let authored_display = display_path(self.workspace.root(), &authored_path)?;
		let acp_path = utf8_path(&authored_path)?;
		if let Some(result) = self.documents.read_acp_text(acp_path.clone()).await {
			match result {
				Ok(text) => {
					let bytes = Bytes::copy_from_slice(text.as_bytes());
					let revision = Str::from(format!("acp:{}", Hash32::sum(&bytes).to_hex()));
					return Ok(ReadDocumentLease {
						backing: ReadLeaseBacking::File(bytes),
						revision,
						canonical_path: authored_display.clone(),
					});
				},
				Err(error) => {
					tracing::debug!(%error, path = %acp_path, "ACP document read fell back to document authority");
				},
			}
		}
		let stat = self.stat_path(&path).await?;
		let canonical = Path::new(stat.canonical_path.as_str());
		let Ok(relative) = canonical.strip_prefix(self.workspace.root()) else {
			return open_filesystem_lease(stat.canonical_path, stat.display_path).await;
		};
		let relative = utf8_path(relative)?;
		let resolved = resolve_read_document(&self.documents, &relative).map_err(Fault::source)?;
		let cancel = CancellationToken::new();
		let lease = DocumentHost::open(&self.documents, resolved.uri, None, &cancel)
			.await
			.map_err(|error| Fault::source(error.to_string()))?;
		let (revision, _canonical_path) =
			read_document_metadata(lease.head()).map_err(Fault::source)?;
		Ok(ReadDocumentLease {
			backing: ReadLeaseBacking::Document { host: self.documents.clone(), lease },
			revision,
			canonical_path: stat.display_path,
		})
	}

	async fn read_bytes(&self, path: Str) -> Result<Bytes, Fault> {
		tokio::fs::read(path.as_str())
			.await
			.map(Bytes::from)
			.map_err(|error| source_io("read", &path, error))
	}

	async fn read_prefix(&self, path: Str, max_bytes: usize) -> Result<Bytes, Fault> {
		if max_bytes == 0 {
			return Ok(Bytes::new());
		}
		let file = tokio::fs::File::open(path.as_str())
			.await
			.map_err(|error| source_io("read", &path, error))?;
		let mut prefix = Vec::with_capacity(max_bytes);
		file
			.take(u64::try_from(max_bytes).unwrap_or(u64::MAX))
			.read_to_end(&mut prefix)
			.await
			.map_err(|error| source_io("read", &path, error))?;
		Ok(Bytes::from(prefix))
	}

	fn list_directory(
		&self,
		path: Str,
		max_depth: usize,
	) -> impl Future<Output = Result<DirectorySource, Fault>> + Send + '_ {
		ready((|| {
			let root = PathBuf::from(path.as_str());
			let request = WalkRequest::new(root.clone())
				.hidden(true)
				.gitignore(false)
				.skip_git(true)
				.skip_node_modules(true)
				.detail(WalkDetail::Full)
				.order(WalkOrder::Path)
				.emit_root(false)
				.depth(1, max_depth);
			let outcome = if root.starts_with(self.workspace.root()) {
				self
					.workspace
					.walk(&request, &CancellationToken::new())
					.map_err(|error| Fault::source(format!("Cannot read directory: {error}")))?
			} else {
				request
					.collect()
					.map_err(|error| Fault::source(format!("Cannot read directory: {error}")))?
			};
			let entries = outcome
				.entries
				.into_iter()
				.map(|entry| DirectoryEntry {
					path:        Str::from(entry.path),
					kind:        walker_kind(entry.file_type),
					byte_len:    entry.size.map_or(0, float_to_u64),
					modified_ms: entry.mtime.map(float_to_u64),
				})
				.collect();
			Ok(DirectorySource {
				root: utf8_path(&root)?,
				entries,
				truncated: outcome.stats.limited_entries != 0,
			})
		})())
	}

	fn commit_document_media(
		&self,
		source: &SourceStat,
		conversion: &mut Conversion,
	) -> Result<(), Fault> {
		if conversion.attachments.is_empty() {
			return Ok(());
		}
		let source = Path::new(source.canonical_path.as_str());
		let parent = source
			.parent()
			.ok_or_else(|| Fault::source("document media source has no parent directory"))?;
		let name = source
			.file_name()
			.and_then(|name| name.to_str())
			.ok_or_else(|| Fault::source("document media source filename is not UTF-8"))?;
		let sequence = MEDIA_COMMIT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let destination = parent.join(format!(".{name}.media-{sequence:016x}"));
		commit_document_media(&destination, conversion)
			.map_err(|error| Fault::source(error.to_string()))
	}

	fn record_snapshot(&self, record: SnapshotRecord) -> Result<Option<Str>, Fault> {
		if record.bytes.len() > SNAPSHOT_MAX_BYTES {
			return Ok(None);
		}
		let snapshot_path = if record.path.contains("://") {
			record.path
		} else {
			let authored = resolve_authored_path(self.workspace.root(), &record.path);
			let canonical = fs::canonicalize(&authored).unwrap_or(authored);
			Str::from(canonical.to_string_lossy().into_owned())
		};
		let text = snapshot_text(&record.bytes)
			.ok_or_else(|| Fault::source("snapshot content is not UTF-8"))?;
		let seen = record
			.seen
			.into_iter()
			.flat_map(|range| range.start_line..=range.end_line)
			.filter_map(|line| u32::try_from(line).ok())
			.collect::<Vec<_>>();
		Ok(Some(
			self
				.documents
				.snapshot_store()
				.record(Path::new(snapshot_path.as_str()), &text, Some(&seen))
				.into(),
		))
	}
}

fn resolve_authored_path(root: &Path, authored: &str) -> PathBuf {
	let expanded = if authored == "~" {
		home_dir()
	} else if let Some(rest) = authored.strip_prefix("~/") {
		home_dir().map(|home| home.join(rest))
	} else {
		None
	};
	let path = expanded.unwrap_or_else(|| PathBuf::from(authored));
	if path.is_absolute() {
		path
	} else {
		root.join(path)
	}
}

fn display_path(root: &Path, canonical: &Path) -> Result<Str, Fault> {
	if let Ok(relative) = canonical.strip_prefix(root) {
		return if relative.as_os_str().is_empty() {
			Ok(sf!("."))
		} else {
			utf8_slash_path(relative)
		};
	}
	if let Some(home) = home_dir()
		&& let Some(shortened) =
			shorten_home_path(canonical.to_string_lossy().as_ref(), home.to_string_lossy().as_ref())
	{
		return Ok(Str::from(shortened));
	}
	utf8_path(canonical)
}

fn utf8_path(path: &Path) -> Result<Str, Fault> {
	path
		.to_str()
		.map(Str::new)
		.ok_or_else(|| Fault::source("Local path is not valid UTF-8"))
}

fn utf8_slash_path(path: &Path) -> Result<Str, Fault> {
	let mut output = String::new();
	for component in path.components() {
		let value = match component {
			Component::Normal(value) => value
				.to_str()
				.ok_or_else(|| Fault::source("Local path is not valid UTF-8"))?,
			Component::CurDir => ".",
			Component::ParentDir => "..",
			Component::RootDir | Component::Prefix(_) => continue,
		};
		if !output.is_empty() {
			output.push('/');
		}
		output.push_str(value);
	}
	Ok(Str::from(output))
}

fn normalized_suffix(path: &str) -> Option<String> {
	let normalized = path.replace('\\', "/");
	let normalized = normalized
		.strip_prefix("./")
		.unwrap_or(&normalized)
		.trim_end_matches('/')
		.to_owned();
	(!normalized.is_empty() && !Path::new(&normalized).is_absolute()).then_some(normalized)
}

fn path_has_suffix(candidate: &str, suffix: &str) -> bool {
	candidate == suffix
		|| candidate
			.strip_suffix(suffix)
			.is_some_and(|prefix| prefix.ends_with('/'))
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
	metadata
		.modified()
		.ok()?
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

const fn walker_kind(kind: FileType) -> SourceKind {
	match kind {
		FileType::File => SourceKind::File,
		FileType::Dir => SourceKind::Directory,
		FileType::Symlink => SourceKind::Symlink,
	}
}

fn float_to_u64(value: f64) -> u64 {
	if value.is_finite() && value > 0.0 {
		value.min(u64::MAX as f64) as u64
	} else {
		0
	}
}

fn source_io(action: &str, path: &str, error: io::Error) -> Fault {
	Fault::source(format!("Cannot {action} '{path}': {error}"))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod external_path_tests {
	use super::*;

	#[tokio::test]
	async fn absolute_filesystem_lease_keeps_opened_bytes_pinned() {
		let sandbox = tempfile::tempdir().expect("sandbox");
		let path = sandbox.path().join("plain.txt");
		fs::write(&path, b"before").expect("write file");
		let canonical = fs::canonicalize(&path).expect("canonical file");
		let lease = open_filesystem_lease(
			utf8_path(&canonical).expect("UTF-8 path"),
			utf8_path(&path).expect("source path"),
		)
		.await
		.expect("open external lease");
		fs::write(&path, b"after").expect("replace file");
		assert_eq!(lease.read_all().await.expect("read pinned bytes"), Bytes::from_static(b"before"));
	}

	#[tokio::test]
	async fn parent_relative_external_path_resolves_to_filesystem_lease() {
		let sandbox = tempfile::tempdir().expect("sandbox");
		let root = sandbox.path().join("root");
		fs::create_dir(&root).expect("workspace root");
		let path = sandbox.path().join("outside.txt");
		fs::write(&path, b"outside").expect("write file");
		let authored = resolve_authored_path(&root, "../outside.txt");
		let canonical = fs::canonicalize(authored).expect("canonical file");
		let lease = open_filesystem_lease(
			utf8_path(&canonical).expect("UTF-8 path"),
			utf8_path(&path).expect("source path"),
		)
		.await
		.expect("open parent-relative lease");
		assert_eq!(
			lease.read_all().await.expect("read pinned bytes"),
			Bytes::from_static(b"outside")
		);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn symlink_lease_keeps_authored_alias_as_its_snapshot_key() {
		let workspace = tempfile::tempdir().expect("workspace");
		let target = workspace.path().join("target.txt");
		let alias = workspace.path().join("authored.txt");
		fs::write(&target, b"contents").expect("write target");
		std::os::unix::fs::symlink(&target, &alias).expect("create alias");
		let canonical = fs::canonicalize(&alias).expect("canonical target");
		let source = display_path(workspace.path(), &alias).expect("display alias");
		let lease =
			open_filesystem_lease(utf8_path(&canonical).expect("canonical path"), source.clone())
				.await
				.expect("open lease");

		assert_eq!(source.as_str(), "authored.txt");
		assert_eq!(lease.canonical_path(), &source);
		assert_eq!(lease.read_all().await.expect("read alias"), Bytes::from_static(b"contents"));
	}
}
