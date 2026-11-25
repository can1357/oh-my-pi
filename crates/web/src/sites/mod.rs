//! Site handlers: sans-I/O readers for sites whose API gives better content
//! than their HTML (package registries, forums, code hosts).
//!
//! # How a handler works
//!
//! A handler is one file, `sites/<name>.rs`, exporting `pub const SITE: Site`
//! (a `const`, so the static table can copy it).
//! [`Reader::open`](crate::reader::Reader::open) asks every entry of [`SITES`],
//! in order, unless the read is raw or `Options::sites` is off. The first
//! handler whose `open` returns `Some(action)` owns the read:
//!
//! - [`Action::Fetch`] asks the caller for one request; its continuation gets
//!   the [`Fetched`] reply and returns the next action. Requests run one at a
//!   time, so prefer APIs that answer in one request (a whole comment tree, a
//!   batch query) over one request per item.
//! - [`Action::Done`] ends the read with Markdown ([`Done`]).
//! - A continuation returning `None` declines: the reader forgets the handler
//!   and reads the page normally. Use `?` on every lookup that can fail.
//!
//! `open` must decide from the URL alone and return `None` for URLs it does
//! not own; it must never fetch speculatively before knowing the URL is its.
//!
//! # Porting a TypeScript scraper
//!
//! 1. Copy `sites/crates_io.rs` (one API request plus an optional second one)
//!    or `sites/hackernews.rs` (several URL shapes, two-step listing) to
//!    `sites/<name>.rs` (snake case of the TS file name).
//! 2. Port the URL match into `open`, the `loadPage` calls into [`Fetch`] +
//!    [`fetch`] continuations, and the Markdown building into a plain `String`
//!    with the helpers below. Keep the TS `method` name as `Done::new(_,
//!    "<method>")`, and its notes.
//! 3. Where the TS handler returned `null` after a failed request, return
//!    `None`; where it built an "Error fetching" page, return `None` too (the
//!    page read is the better fallback).
//! 4. Register: add `mod <name>;` in alphabetical order below and
//!    `<name>::SITE` to [`SITES`] in the position the TS handler had in
//!    `scrapers/index.ts` (order matters: `github_gist` before `github`).
//! 5. Delete the TS scraper and its `index.ts` entry.
//! 6. Test with `testing::run`: a URL and a closure answering each [`Fetch`]
//!    with [`Fetched::json`], [`Fetched::text`] or [`Fetched::status`]; assert
//!    on the returned [`Done`] (`None` means the handler declined). Cover one
//!    match, one non-match and one declined API failure. `testing::run_with`
//!    takes a closure configuring a `testing::Setup` (`now_ms`, `settings`,
//!    `credentials`, `remote`, `cache`) first; `testing::context` plus
//!    `testing::run_in` reuse one context across reads. Every setup starts with
//!    its own empty cache; share one with [`Cache::isolated`] clones.
//!
//! # Helpers
//!
//! - Requests: [`Fetch::get`], [`Fetch::post_json`], [`Fetch::header`],
//!   [`Fetch::accept_json`], [`Fetch::bearer`], [`Fetch::max_bytes`];
//!   [`segment`] percent-encodes a path segment or query value.
//! - Replies: [`Fetched::ok`], [`Fetched::json_value`], [`Fetched::body_text`],
//!   [`Fetched::content_type`].
//! - JSON: [`str_of`], [`u64_of`], [`i64_of`], [`f64_of`], [`arr_of`],
//!   [`strs_of`].
//! - Formatting: [`format_number`] (`12.3K`), [`iso_date`] (`YYYY-MM-DD` prefix
//!   of an ISO string), [`unix_date`], [`unix_datetime`] (UTC), and
//!   [`html_to_markdown`] for HTML fragments (comment bodies, READMEs).
//! - Bodies: [`gunzip`] and [`unzstd`] decode a compressed download (a rustdoc
//!   JSON archive) within a byte bound.
//!
//! # Clock, settings and cache
//!
//! - [`Context::now_ms`] is the caller's wall clock when the reader was created
//!   (`nowMs` from TS). Use it for TTLs and relative ages the TS handler
//!   computed from `Date.now()`; tests pin it with `Setup::now_ms`.
//! - [`Context::setting`] reads a caller setting (`siteSettings` from TS: `{
//!   key, value }` pairs such as `x.model`, `x.baseUrl` or `providers.fetch`);
//!   [`Context::settings_with_prefix`] lists a family of them (`x.header.`).
//!   Whatever the TS handler read from settings, the model registry or agent
//!   storage, `tools/fetch.ts` resolves and passes as settings and credentials;
//!   handlers never resolve secrets themselves.
//! - [`Context::remote`] is the configured remote reader of a kind (a usable
//!   Parallel backend), for handlers that prefer one for their URLs.
//! - [`Context::cache_get`] / [`Context::cache_put`] reach a process-wide
//!   in-memory cache shared by every reader: string values with a TTL in
//!   seconds (`u64::MAX` never expires), at most 8 MB per entry and 64 MB in
//!   total, least recently used entries evicted first. Namespace keys by
//!   handler (`docs.rs:<crate>@<version>`). It replaces the TS handlers'
//!   module-level maps and disk caches.
//!
//! # Credentials and identity
//!
//! The TS side passes `siteCredentials: [{ site, token }]` (for example
//! `{ site: "github", token: $GITHUB_TOKEN }`); a handler reads its token with
//! [`Context::credential`] and adds it with [`Fetch::bearer`] or its own
//! header. Every request without its own `User-Agent` gets
//! `Options::api_user_agent` (`omp/<version>` from TS), which registries like
//! crates.io require.

mod artifacthub;
mod arxiv;
mod aur;
mod biorxiv;
mod bluesky;
mod brew;
mod cheatsh;
mod chocolatey;
mod choosealicense;
mod cisa_kev;
mod clojars;
mod coingecko;
mod crates_io;
mod crossref;
mod devto;
mod discogs;
mod discourse;
mod dockerhub;
mod docs_rs;
mod fdroid;
mod firefox_addons;
mod flathub;
mod github;
mod github_gist;
mod gitlab;
mod go_pkg;
mod hackage;
mod hackernews;
mod hex;
mod huggingface;
mod iacr;
mod jetbrains_marketplace;
mod lemmy;
mod lobsters;
mod mastodon;
mod maven;
mod mdn;
mod metacpan;
mod musicbrainz;
mod npm;
mod nuget;
mod nvd;
mod ollama;
mod open_vsx;
mod opencorporates;
mod openlibrary;
mod orcid;
mod osv;
mod packagist;
mod pub_dev;
mod pubmed;
mod pypi;
mod rawg;
mod readthedocs;
mod reddit;
mod repology;
mod rfc;
mod rubygems;
mod searchcode;
mod sec_edgar;
mod semantic_scholar;
mod snapcraft;
mod sourcegraph;
mod spdx;
mod spotify;
mod stackoverflow;
mod terraform;
mod tldr;
mod twitter;
mod vimeo;
mod vscode_marketplace;
mod w3c;
mod wikidata;
mod wikipedia;
mod youtube;

use std::{
	borrow::Cow,
	collections::HashMap,
	fmt::{self, Write as _},
	io::Read,
	sync::{Arc, LazyLock, Mutex, PoisonError},
};

use serde_json::Value;
use url::Url;

use crate::{
	Hidden, decode, remote,
	render::{self, Format, Mode},
	strategy::{self, header},
};

/// Site handlers in match order.
pub static SITES: &[Site] = &[
	youtube::SITE,
	twitter::SITE,
	mastodon::SITE,
	discourse::SITE,
	docs_rs::SITE,
	github_gist::SITE,
	github::SITE,
	gitlab::SITE,
	vimeo::SITE,
	spotify::SITE,
	discogs::SITE,
	musicbrainz::SITE,
	rawg::SITE,
	bluesky::SITE,
	lemmy::SITE,
	hackernews::SITE,
	lobsters::SITE,
	reddit::SITE,
	stackoverflow::SITE,
	devto::SITE,
	mdn::SITE,
	readthedocs::SITE,
	searchcode::SITE,
	sourcegraph::SITE,
	tldr::SITE,
	cheatsh::SITE,
	npm::SITE,
	firefox_addons::SITE,
	vscode_marketplace::SITE,
	nuget::SITE,
	chocolatey::SITE,
	clojars::SITE,
	brew::SITE,
	pypi::SITE,
	crates_io::SITE,
	dockerhub::SITE,
	fdroid::SITE,
	flathub::SITE,
	go_pkg::SITE,
	hex::SITE,
	packagist::SITE,
	pub_dev::SITE,
	maven::SITE,
	jetbrains_marketplace::SITE,
	open_vsx::SITE,
	artifacthub::SITE,
	rubygems::SITE,
	terraform::SITE,
	aur::SITE,
	hackage::SITE,
	metacpan::SITE,
	repology::SITE,
	snapcraft::SITE,
	huggingface::SITE,
	ollama::SITE,
	arxiv::SITE,
	biorxiv::SITE,
	crossref::SITE,
	iacr::SITE,
	orcid::SITE,
	semantic_scholar::SITE,
	pubmed::SITE,
	rfc::SITE,
	cisa_kev::SITE,
	nvd::SITE,
	osv::SITE,
	coingecko::SITE,
	opencorporates::SITE,
	sec_edgar::SITE,
	openlibrary::SITE,
	choosealicense::SITE,
	w3c::SITE,
	spdx::SITE,
	wikidata::SITE,
	wikipedia::SITE,
];

/// A registered site handler.
#[derive(Clone, Copy)]
pub struct Site {
	/// Handler name (diagnostics only).
	pub name: &'static str,
	/// Claim a URL: `None` when the handler does not own it.
	pub open: fn(&Url, &Context) -> Option<Action>,
}

/// What a handler can learn about the read besides the URL.
#[derive(Debug, Clone, Default)]
pub struct Context {
	/// `(site, token)` pairs from the caller.
	pub credentials: Vec<(String, String)>,
	/// Caller's wall clock at reader creation, in ms since the Unix epoch.
	pub now_ms:      u64,
	/// `(key, value)` settings from the caller.
	pub settings:    Vec<(String, String)>,
	/// Configured remote readers.
	pub remote:      Vec<remote::Backend>,
	/// Cache reached by [`Self::cache_get`] and [`Self::cache_put`].
	pub cache:       Cache,
}

impl Context {
	/// The caller's token for `site`, if any.
	pub fn credential(&self, site: &str) -> Option<&str> {
		self
			.credentials
			.iter()
			.find(|(name, _)| name == site)
			.map(|(_, token)| token.as_str())
			.filter(|token| !token.is_empty())
	}

	/// Caller's wall clock at reader creation, in ms since the Unix epoch.
	pub const fn now_ms(&self) -> u64 {
		self.now_ms
	}

	/// The caller's non-empty setting `key`, if any.
	pub fn setting(&self, key: &str) -> Option<&str> {
		self
			.settings
			.iter()
			.find(|(name, _)| name == key)
			.map(|(_, value)| value.as_str())
			.filter(|value| !value.is_empty())
	}

	/// Settings whose key starts with `prefix`, as `(key without prefix,
	/// value)`.
	pub fn settings_with_prefix<'a>(
		&'a self,
		prefix: &'a str,
	) -> impl Iterator<Item = (&'a str, &'a str)> {
		self
			.settings
			.iter()
			.filter_map(move |(key, value)| Some((key.strip_prefix(prefix)?, value.as_str())))
	}

	/// The configured remote reader of `kind`, when usable: Jina always,
	/// Firecrawl and Parallel only with an API key.
	pub fn remote(&self, kind: remote::Kind) -> Option<&remote::Backend> {
		self.remote.iter().find(|backend| {
			backend.kind == kind
				&& (kind == remote::Kind::Jina
					|| backend
						.api_key
						.as_deref()
						.is_some_and(|key| !key.trim().is_empty()))
		})
	}

	/// The unexpired cached value at `key`.
	pub fn cache_get(&self, key: &str) -> Option<String> {
		self.cache.get(key, self.now_ms)
	}

	/// Cache `value` at `key` for `ttl_secs` seconds (`u64::MAX`: no
	/// expiry); a value over the entry cap is not cached.
	pub fn cache_put(&self, key: &str, value: String, ttl_secs: u64) {
		self.cache.put(key, value, self.now_ms, ttl_secs);
	}
}

/// Largest cache entry (key plus value bytes).
const CACHE_ENTRY_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Total cache size (key plus value bytes of every entry).
const CACHE_TOTAL_MAX_BYTES: usize = 64 * 1024 * 1024;

/// TTL of a negative platform probe (a host that is not Mastodon or
/// Discourse).
pub(crate) const NEGATIVE_PROBE_TTL_SECS: u64 = 600;

/// True when a probe reply says what the host is: a server error, a
/// transport error, a refusal or a rate limit says nothing.
pub(crate) const fn is_conclusive_probe_status(status: u16) -> bool {
	status != 0 && status < 500 && !matches!(status, 401 | 403 | 408 | 429)
}

/// Handle to a handler cache: the process-wide one by default, or an isolated
/// one ([`Cache::isolated`]) shared by its clones.
#[derive(Clone, Default)]
pub struct Cache(Option<Arc<Mutex<Store>>>);

/// The process-wide cache shared by every reader.
static SHARED_CACHE: LazyLock<Mutex<Store>> = LazyLock::new(Mutex::default);

impl Cache {
	/// A new empty cache, separate from the process-wide one.
	pub fn isolated() -> Self {
		Self(Some(Arc::default()))
	}

	fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
		let store = self.0.as_deref().unwrap_or(&SHARED_CACHE);
		f(&mut store.lock().unwrap_or_else(PoisonError::into_inner))
	}

	fn get(&self, key: &str, now_ms: u64) -> Option<String> {
		self.with(|store| store.get(key, now_ms))
	}

	fn put(&self, key: &str, value: String, now_ms: u64, ttl_secs: u64) {
		self.with(|store| store.put(key, value, now_ms, ttl_secs));
	}
}

impl fmt::Debug for Cache {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(if self.0.is_some() {
			"Cache(isolated)"
		} else {
			"Cache(shared)"
		})
	}
}

/// Bounded TTL map with least-recently-used eviction.
#[derive(Default)]
struct Store {
	entries: HashMap<String, Entry>,
	/// Key plus value bytes of every entry.
	bytes:   usize,
	/// Use counter stamping entries for LRU order.
	tick:    u64,
}

struct Entry {
	value:      String,
	expires_ms: u64,
	used:       u64,
}

impl Store {
	fn get(&mut self, key: &str, now_ms: u64) -> Option<String> {
		let entry = self.entries.get_mut(key)?;
		if entry.expires_ms <= now_ms {
			self.remove(key);
			return None;
		}
		self.tick += 1;
		entry.used = self.tick;
		Some(entry.value.clone())
	}

	fn put(&mut self, key: &str, value: String, now_ms: u64, ttl_secs: u64) {
		self.remove(key);
		let size = key.len() + value.len();
		if size > CACHE_ENTRY_MAX_BYTES || ttl_secs == 0 {
			return;
		}
		if self.bytes + size > CACHE_TOTAL_MAX_BYTES {
			self.entries.retain(|_, entry| entry.expires_ms > now_ms);
			self.bytes = self
				.entries
				.iter()
				.map(|(key, entry)| key.len() + entry.value.len())
				.sum();
		}
		while self.bytes + size > CACHE_TOTAL_MAX_BYTES {
			let Some(oldest) = self
				.entries
				.iter()
				.min_by_key(|(_, entry)| entry.used)
				.map(|(key, _)| key.clone())
			else {
				break;
			};
			self.remove(&oldest);
		}
		self.tick += 1;
		self.bytes += size;
		self.entries.insert(key.to_owned(), Entry {
			value,
			expires_ms: now_ms.saturating_add(ttl_secs.saturating_mul(1000)),
			used: self.tick,
		});
	}

	fn remove(&mut self, key: &str) {
		if let Some(entry) = self.entries.remove(key) {
			self.bytes -= key.len() + entry.value.len();
		}
	}
}

/// Decode a gzip body (members concatenated); `None` when it is malformed or
/// decodes to more than `max_bytes`.
pub fn gunzip(bytes: &[u8], max_bytes: usize) -> Option<Vec<u8>> {
	read_bounded(flate2::read::MultiGzDecoder::new(bytes), max_bytes)
}

/// Decode a zstd body; `None` when it is malformed or decodes to more than
/// `max_bytes`.
pub fn unzstd(bytes: &[u8], max_bytes: usize) -> Option<Vec<u8>> {
	read_bounded(zstd::stream::read::Decoder::with_buffer(bytes).ok()?, max_bytes)
}

fn read_bounded(reader: impl Read, max_bytes: usize) -> Option<Vec<u8>> {
	let mut out = Vec::new();
	reader
		.take(u64::try_from(max_bytes).ok()?.saturating_add(1))
		.read_to_end(&mut out)
		.ok()?;
	(out.len() <= max_bytes).then_some(out)
}

/// Continuation of a handler after a reply; `None` declines.
pub type Next = Box<dyn FnOnce(Fetched, &Context) -> Option<Action> + Send>;

/// The next thing a handler wants.
pub enum Action {
	/// Perform a request and continue with its reply.
	Fetch(Fetch, Next),
	/// The read is over.
	Done(Done),
}

/// Ask for `request`, then continue with `next`.
pub fn fetch(
	request: Fetch,
	next: impl FnOnce(Fetched, &Context) -> Option<Action> + Send + 'static,
) -> Option<Action> {
	Some(Action::Fetch(request, Box::new(next)))
}

/// A request a handler asks for. Redirects and cookies are the caller's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetch {
	/// Absolute URL.
	pub url:       String,
	/// HTTP method.
	pub method:    &'static str,
	/// Request headers.
	pub headers:   Vec<(String, String)>,
	/// Request body.
	pub body:      Option<Vec<u8>>,
	/// Body read bound.
	pub max_bytes: usize,
}

impl Fetch {
	/// A GET request.
	pub fn get(url: impl Into<String>) -> Self {
		Self {
			url:       url.into(),
			method:    "GET",
			headers:   Vec::new(),
			body:      None,
			max_bytes: strategy::MAX_BYTES,
		}
	}

	/// A POST request with a JSON body.
	pub fn post_json(url: impl Into<String>, body: &Value) -> Self {
		Self { method: "POST", body: Some(body.to_string().into_bytes()), ..Self::get(url) }
			.header("Content-Type", "application/json")
			.accept_json()
	}

	/// Add a header.
	pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
		self.headers.push((name.to_owned(), value.into()));
		self
	}

	/// Ask for JSON.
	pub fn accept_json(self) -> Self {
		self.header("Accept", "application/json")
	}

	/// Add `Authorization: Bearer <token>` when a token is present.
	pub fn bearer(self, token: Option<&str>) -> Self {
		match token {
			Some(token) => self.header("Authorization", format!("Bearer {token}")),
			None => self,
		}
	}

	/// Bound the body read.
	pub const fn max_bytes(mut self, max_bytes: usize) -> Self {
		self.max_bytes = max_bytes;
		self
	}
}

/// A reply to a [`Fetch`].
#[derive(Debug, Clone, Default)]
pub struct Fetched {
	/// HTTP status; 0 for a transport error.
	pub status:    u16,
	/// Final URL.
	pub url:       String,
	/// Response headers.
	pub headers:   Vec<(String, String)>,
	/// Body bytes.
	pub body:      Vec<u8>,
	/// True when the body was cut.
	pub truncated: bool,
}

impl Fetched {
	/// True for a 2xx status.
	pub fn ok(&self) -> bool {
		(200..300).contains(&self.status)
	}

	/// Lowercased MIME type without parameters.
	pub fn content_type(&self) -> String {
		strategy::mime(header(&self.headers, "content-type").unwrap_or_default())
	}

	/// The decoded body of a 2xx reply.
	pub fn body_text(&self) -> Option<String> {
		self
			.ok()
			.then(|| decode::decode(&self.body, header(&self.headers, "content-type"), false))
	}

	/// The parsed JSON body of a 2xx reply.
	pub fn json_value(&self) -> Option<Value> {
		serde_json::from_slice(
			self
				.body
				.strip_prefix(b"\xef\xbb\xbf")
				.unwrap_or(&self.body),
		)
		.ok()
		.filter(|_| self.ok())
	}

	/// A scripted 200 JSON reply (tests).
	pub fn json(body: &Value) -> Self {
		Self::with("application/json", body.to_string())
	}

	/// A scripted 200 reply of `content_type` (tests).
	pub fn text(content_type: &str, body: impl Into<String>) -> Self {
		Self::with(content_type, body.into())
	}

	/// A scripted bodyless reply with `status` (tests; 0 is a transport error).
	pub fn status(status: u16) -> Self {
		Self { status, ..Self::default() }
	}

	fn with(content_type: &str, body: String) -> Self {
		Self {
			status: 200,
			headers: vec![("content-type".to_owned(), content_type.to_owned())],
			body: body.into_bytes(),
			..Self::default()
		}
	}
}

/// A finished site read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
	/// Markdown content (finalized by the reader).
	pub markdown:     String,
	/// Method name reported as the page strategy (the TS handler's `method`).
	pub method:       &'static str,
	/// MIME type of `markdown` (`text/markdown`; `text/plain` for a raw file).
	pub content_type: &'static str,
	/// Page title.
	pub title:        Option<String>,
	/// URL the content stands for; the requested URL when `None`.
	pub url:          Option<String>,
	/// What the handler did.
	pub notes:        Vec<String>,
	/// True when the content embeds a cut body verbatim.
	pub truncated:    bool,
}

impl Done {
	/// Markdown read by `method`.
	pub const fn new(markdown: String, method: &'static str) -> Self {
		Self {
			markdown,
			method,
			content_type: "text/markdown",
			title: None,
			url: None,
			notes: Vec::new(),
			truncated: false,
		}
	}

	/// Set the MIME type of the content (`text/plain` for a raw file).
	pub const fn content_type(mut self, content_type: &'static str) -> Self {
		self.content_type = content_type;
		self
	}

	/// Set the URL the content stands for.
	pub fn url(mut self, url: impl Into<String>) -> Self {
		self.url = Some(url.into());
		self
	}

	/// Add a note.
	pub fn note(mut self, note: impl Into<String>) -> Self {
		self.notes.push(note.into());
		self
	}

	/// Set the title.
	pub fn title(mut self, title: impl Into<String>) -> Self {
		self.title = Some(title.into());
		self
	}

	/// Finish the read with this content.
	pub const fn finish(self) -> Option<Action> {
		Some(Action::Done(self))
	}
}

/// Trimmed non-empty string at `key`.
pub fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value
		.get(key)?
		.as_str()
		.map(str::trim)
		.filter(|s| !s.is_empty())
}

/// Unsigned integer at `key` (also from a numeric string).
pub fn u64_of(value: &Value, key: &str) -> Option<u64> {
	let field = value.get(key)?;
	field
		.as_u64()
		.or_else(|| field.as_str()?.trim().parse().ok())
}

/// Signed integer at `key` (also from a numeric string).
pub fn i64_of(value: &Value, key: &str) -> Option<i64> {
	let field = value.get(key)?;
	field
		.as_i64()
		.or_else(|| field.as_str()?.trim().parse().ok())
}

/// Number at `key` (also from a numeric string).
pub fn f64_of(value: &Value, key: &str) -> Option<f64> {
	let field = value.get(key)?;
	field
		.as_f64()
		.or_else(|| field.as_str()?.trim().parse().ok())
}

/// Array at `key`, empty when absent.
pub fn arr_of<'a>(value: &'a Value, key: &str) -> &'a [Value] {
	value
		.get(key)
		.and_then(Value::as_array)
		.map_or(&[], Vec::as_slice)
}

/// Non-empty strings of the array at `key`.
pub fn strs_of<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
	arr_of(value, key)
		.iter()
		.filter_map(Value::as_str)
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.collect()
}

/// Percent-encode a path segment or query value.
pub fn segment(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for byte in text.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
			out.push(byte as char);
		} else {
			let _ = write!(out, "%{byte:02X}");
		}
	}
	out
}

/// Percent-decode a path segment: strict `%HH` escapes, UTF-8 result, `+`
/// kept as is. `None` for a malformed escape or invalid UTF-8.
pub fn decode_segment(text: &str) -> Option<Cow<'_, str>> {
	if !text.contains('%') {
		return Some(Cow::Borrowed(text));
	}
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' {
			let hex = text.get(i + 1..i + 3)?;
			if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
				return None;
			}
			out.push(u8::from_str_radix(hex, 16).ok()?);
			i += 3;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	String::from_utf8(out).ok().map(Cow::Owned)
}

/// Compact count: `999`, `1.2K`, `45K`, `3.4M`, `120M`, `1.5B`.
pub fn format_number(n: f64) -> String {
	fn one_decimal(n: f64) -> String {
		let s = format!("{n:.1}");
		s.strip_suffix(".0")
			.map_or_else(|| s.clone(), str::to_owned)
	}
	if n < 1_000.0 {
		return if n.fract() == 0.0 {
			format!("{n:.0}")
		} else {
			one_decimal(n)
		};
	}
	if n < 10_000.0 {
		return format!("{}K", one_decimal(n / 1_000.0));
	}
	if n < 1_000_000.0 {
		return format!("{:.0}K", (n / 1_000.0).round());
	}
	if n < 10_000_000.0 {
		return format!("{}M", one_decimal(n / 1_000_000.0));
	}
	if n < 1_000_000_000.0 {
		return format!("{:.0}M", (n / 1_000_000.0).round());
	}
	if n < 10_000_000_000.0 {
		return format!("{}B", one_decimal(n / 1_000_000_000.0));
	}
	format!("{:.0}B", (n / 1_000_000_000.0).round())
}

/// The `YYYY-MM-DD` prefix of an ISO-8601 date or timestamp.
pub fn iso_date(text: &str) -> Option<&str> {
	let date = text.trim().get(..10)?;
	let bytes = date.as_bytes();
	let shape = bytes.iter().enumerate().all(|(i, b)| {
		if i == 4 || i == 7 {
			*b == b'-'
		} else {
			b.is_ascii_digit()
		}
	});
	shape.then_some(date)
}

/// Civil date of days since 1970-01-01 (proleptic Gregorian).
const fn civil(days: i64) -> (i64, i64, i64) {
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = doy - (153 * mp + 2) / 5 + 1;
	let month = if mp < 10 { mp + 3 } else { mp - 9 };
	(yoe + era * 400 + (month <= 2) as i64, month, day)
}

/// `YYYY-MM-DD` of a Unix timestamp in seconds (UTC).
pub fn unix_date(secs: i64) -> String {
	let (year, month, day) = civil(secs.div_euclid(86_400));
	format!("{year:04}-{month:02}-{day:02}")
}

/// `YYYY-MM-DD HH:MM UTC` of a Unix timestamp in seconds.
pub fn unix_datetime(secs: i64) -> String {
	let minutes = secs.rem_euclid(86_400) / 60;
	format!("{} {:02}:{:02} UTC", unix_date(secs), minutes / 60, minutes % 60)
}

/// Markdown of an HTML fragment (a comment body, a rendered README), with
/// links resolved against `base`.
pub fn html_to_markdown(html: &str, base: Option<&Url>) -> String {
	let options = render::Options {
		format: Format::Markdown,
		mode:   Mode::Full,
		hidden: Hidden::Drop,
		images: true,
		width:  250,
	};
	strategy::finalize(&render::render(html, base, &options).content)
}

/// Test harness for handlers.
#[cfg(test)]
pub mod testing {
	use super::*;

	/// What a test read starts from.
	pub struct Setup {
		/// Wall clock in ms; defaults to 2026-01-01T00:00:00Z.
		pub now_ms:      u64,
		/// `(key, value)` settings.
		pub settings:    Vec<(String, String)>,
		/// `(site, token)` credentials; defaults to a `github` token.
		pub credentials: Vec<(String, String)>,
		/// Remote readers.
		pub remote:      Vec<remote::Backend>,
		/// Handler cache; defaults to a fresh isolated one.
		pub cache:       Cache,
	}

	impl Default for Setup {
		fn default() -> Self {
			Self {
				now_ms:      1_767_225_600_000,
				settings:    Vec::new(),
				credentials: vec![("github".to_owned(), "token".to_owned())],
				remote:      Vec::new(),
				cache:       Cache::isolated(),
			}
		}
	}

	/// A context from the default [`Setup`] changed by `setup`.
	pub fn context(setup: impl FnOnce(&mut Setup)) -> Context {
		let mut config = Setup::default();
		setup(&mut config);
		Context {
			credentials: config.credentials,
			now_ms:      config.now_ms,
			settings:    config.settings,
			remote:      config.remote,
			cache:       config.cache,
		}
	}

	/// Drive the handler owning `url` with scripted replies; `None` when no
	/// handler claims the URL or the claiming handler declines.
	pub fn run(url: &str, serve: impl FnMut(&Fetch) -> Fetched) -> Option<Done> {
		run_with(url, |_| {}, serve)
	}

	/// [`run`] in a context configured by `setup`.
	pub fn run_with(
		url: &str,
		setup: impl FnOnce(&mut Setup),
		serve: impl FnMut(&Fetch) -> Fetched,
	) -> Option<Done> {
		run_in(url, &context(setup), serve)
	}

	/// [`run`] in `context` (reused across reads to share its cache).
	pub fn run_in(
		url: &str,
		context: &Context,
		mut serve: impl FnMut(&Fetch) -> Fetched,
	) -> Option<Done> {
		let url = Url::parse(url).unwrap();
		let mut action = SITES.iter().find_map(|site| (site.open)(&url, context))?;
		for _ in 0..64 {
			action = match action {
				Action::Done(done) => return Some(done),
				Action::Fetch(request, next) => {
					let mut reply = serve(&request);
					if reply.url.is_empty() {
						reply.url.clone_from(&request.url);
					}
					next(reply, context)?
				},
			};
		}
		panic!("handler did not finish");
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn formatting() {
		assert_eq!(format_number(999.0), "999");
		assert_eq!(format_number(1_234.0), "1.2K");
		assert_eq!(format_number(45_600.0), "46K");
		assert_eq!(format_number(3_400_000.0), "3.4M");
		assert_eq!(format_number(2_000_000_000.0), "2B");
		assert_eq!(iso_date("2024-01-02T03:04:05Z"), Some("2024-01-02"));
		assert_eq!(iso_date("Jan 2"), None);
		assert_eq!(unix_date(0), "1970-01-01");
		assert_eq!(unix_datetime(1_160_418_111), "2006-10-09 18:21 UTC");
		assert_eq!(unix_date(951_782_400), "2000-02-29");
		assert_eq!(segment("a b/ü"), "a%20b%2F%C3%BC");
		assert_eq!(decode_segment("a%20b%2F%C3%BC+c").as_deref(), Some("a b/ü+c"));
		assert_eq!(decode_segment("plain"), Some(Cow::Borrowed("plain")));
		assert_eq!(decode_segment("bad%2"), None);
		assert_eq!(decode_segment("bad%zz"), None);
		assert_eq!(decode_segment("%FF"), None);
	}

	#[test]
	fn unclaimed_urls_run_no_handler() {
		assert_eq!(testing::run("https://example.test/", |_| panic!("no fetch expected")), None);
	}
}
