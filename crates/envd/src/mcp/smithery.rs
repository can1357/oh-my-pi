//! Authenticated Smithery registry, device login, and managed-connection
//! authority.
//!
//! Secret bytes remain in [`SecretString`] values and sensitive HTTP headers.
//! Public errors carry only an operation and status class; response bodies and
//! credentials are never surfaced to the chat actor or tracing.

#[cfg(unix)]
use std::fs::File;
use std::{
	collections::{BTreeMap, BTreeSet},
	fs::{self, OpenOptions},
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use futures::{StreamExt as _, stream};
use omp_core::{ExposeSecret as _, SecretString, Str};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::{Zeroize as _, Zeroizing};

use super::oauth::{BrowserLauncher, SystemBrowserLauncher};

const REGISTRY_URL: &str = "https://registry.smithery.ai/";
const API_URL: &str = "https://api.smithery.ai/";
const WEB_URL: &str = "https://smithery.ai/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_SEARCH_PAGES: u32 = 3;
const MAX_QUERY_BYTES: usize = 512;
const MAX_METADATA_BYTES: usize = 16 * 1024;
const MAX_DEFINITION_ITEMS: usize = 256;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const AUTH_FILENAME: &str = "smithery.json";

/// Smithery operation names retained in typed, redacted failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "kebab-case")]
pub enum SmitheryOperation {
	/// Registry search page.
	Search,
	/// Registry server details.
	Details,
	/// Device login session creation.
	LoginStart,
	/// Device login polling.
	LoginPoll,
	/// Namespace listing.
	ListNamespaces,
	/// Namespace creation.
	CreateNamespace,
	/// Managed connection listing.
	ListConnections,
	/// Managed connection creation.
	CreateConnection,
	/// Managed connection status polling.
	GetConnection,
	/// Best-effort rollback of a newly created connection.
	DeleteConnection,
}

/// Secret-safe Smithery failure.
#[derive(thiserror::Error)]
pub enum SmitheryError {
	/// Caller cancelled the operation.
	#[error("Smithery operation was cancelled")]
	Cancelled,
	/// One bounded network operation expired.
	#[error("Smithery {operation} timed out")]
	TimedOut {
		/// Operation that timed out.
		operation: SmitheryOperation,
	},
	/// HTTP transport failed before a response was available.
	#[error("Smithery {operation} request failed")]
	Request {
		/// Operation that failed.
		operation: SmitheryOperation,
		/// Typed transport cause. Request debug output redacts sensitive headers.
		#[source]
		source:    reqwest::Error,
	},
	/// Smithery returned a non-success status. The response body is deliberately
	/// discarded.
	#[error("Smithery {operation} returned HTTP {status}")]
	Status {
		/// Operation that failed.
		operation: SmitheryOperation,
		/// Public HTTP status only.
		status:    StatusCode,
	},
	/// Response exceeded the registry protocol bound.
	#[error("Smithery {operation} response exceeded its size limit")]
	ResponseTooLarge {
		/// Operation whose response exceeded the bound.
		operation: SmitheryOperation,
	},
	/// A success response did not satisfy Smithery's typed schema.
	#[error("Smithery {operation} returned an invalid response")]
	Decode {
		/// Operation whose response was invalid.
		operation: SmitheryOperation,
		/// Typed JSON cause; response bytes are not retained.
		#[source]
		source:    serde_json::Error,
	},
	/// Configured endpoint URL was invalid.
	#[error("Smithery endpoint configuration is invalid")]
	Endpoint(#[source] url::ParseError),
	/// No environment or persisted credential is available.
	#[error("Smithery authentication is required; run /mcp smithery-login")]
	AuthenticationRequired,
	/// A key or device response supplied an empty credential.
	#[error("Smithery returned an empty API key")]
	EmptyApiKey,
	/// Registry query exceeded the public request bound.
	#[error("Smithery search query exceeds 512 bytes")]
	QueryTooLong,
	/// Smithery supplied a browser URL outside the accepted HTTPS/loopback
	/// boundary.
	#[error("Smithery returned an invalid authorization URL")]
	InvalidAuthorizationUrl,
	/// Device session expired at Smithery.
	#[error("Smithery login session expired; run /mcp smithery-login again")]
	LoginExpired,
	/// Device authorization completed unsuccessfully.
	#[error("Smithery authorization failed")]
	AuthorizationFailed,
	/// Managed connection could not become ready.
	#[error("Smithery managed connection failed")]
	ConnectionFailed,
	/// Selected registry server requires values that this non-interactive
	/// command cannot guess.
	#[error(
		"Smithery server requires configuration values; configure it in Smithery or add it manually"
	)]
	ConfigurationRequired,
	/// Namespace discovery returned neither an existing nor a newly created
	/// namespace.
	#[error("Smithery returned an empty namespace")]
	EmptyNamespace,
	/// Credential store I/O failed.
	#[error("Smithery credential store operation failed")]
	CredentialIo(#[source] io::Error),
	/// Credential JSON was malformed.
	#[error("Smithery credential file is invalid")]
	CredentialDecode(#[source] serde_json::Error),
	/// Credential JSON could not be encoded.
	#[error("Smithery credential could not be encoded")]
	CredentialEncode(#[source] serde_json::Error),
}

impl std::fmt::Debug for SmitheryError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		// `reqwest::Error` may retain a URL, including a managed MCP query.
		// Debug therefore uses only thiserror's intentionally redacted display.
		std::fmt::Display::fmt(self, formatter)
	}
}

impl SmitheryError {
	/// Whether a fresh login can repair this failure.
	#[must_use]
	pub fn needs_login(&self) -> bool {
		matches!(
			self,
			Self::AuthenticationRequired
				| Self::Status { status: StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, .. }
		)
	}

	/// Whether Smithery asked the client to back off rather than exposing a
	/// provider diagnostic.
	#[must_use]
	pub fn is_rate_limited(&self) -> bool {
		matches!(self, Self::Status { status: StatusCode::TOO_MANY_REQUESTS, .. })
	}
}

#[derive(Deserialize)]
struct StoredCredential {
	#[serde(rename = "apiKey")]
	api_key: String,
}

impl Drop for StoredCredential {
	fn drop(&mut self) {
		self.api_key.zeroize();
	}
}

#[derive(Serialize)]
struct StoredCredentialRef<'a> {
	#[serde(rename = "apiKey")]
	api_key: &'a str,
}

/// User-scoped Smithery API-key store. `OMP_SMITHERY_API_KEY`, then the
/// vendor-standard `SMITHERY_API_KEY`, has precedence over the file.
#[derive(Clone, Debug)]
pub struct SmitheryCredentialStore {
	path: PathBuf,
}

impl SmitheryCredentialStore {
	/// Creates a store rooted under OMP's user configuration directory.
	#[must_use]
	pub fn new(config_root: &Path) -> Self {
		Self { path: config_root.join(AUTH_FILENAME) }
	}

	/// Exact credential path, useful for user-facing logout diagnostics without
	/// reading the key.
	#[must_use]
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Loads the OMP override, vendor-standard environment key, then private
	/// persisted key.
	pub fn load(&self) -> Result<Option<SecretString>, SmitheryError> {
		if let Some(key) = ["OMP_SMITHERY_API_KEY", "SMITHERY_API_KEY"]
			.into_iter()
			.find_map(|name| {
				std::env::var_os(name)
					.and_then(|value| value.into_string().ok())
					.and_then(normalize_key)
			}) {
			return Ok(Some(SecretString::from(key)));
		}
		let bytes = match fs::read(&self.path) {
			Ok(bytes) => Zeroizing::new(bytes),
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(error) => return Err(SmitheryError::CredentialIo(error)),
		};
		let stored = serde_json::from_slice::<StoredCredential>(&bytes)
			.map_err(SmitheryError::CredentialDecode)?;
		Ok(normalize_key(&stored.api_key).map(SecretString::from))
	}

	/// Atomically saves one non-empty key with owner-only permissions.
	pub fn save(&self, key: SecretString) -> Result<(), SmitheryError> {
		let normalized =
			Zeroizing::new(normalize_key(key.expose_secret()).ok_or(SmitheryError::EmptyApiKey)?);
		let mut encoded = Zeroizing::new(
			serde_json::to_vec_pretty(&StoredCredentialRef { api_key: normalized.as_str() })
				.map_err(SmitheryError::CredentialEncode)?,
		);
		encoded.push(b'\n');
		let parent = self.path.parent().ok_or_else(|| {
			SmitheryError::CredentialIo(io::Error::new(
				io::ErrorKind::InvalidInput,
				"credential path has no parent",
			))
		})?;
		fs::create_dir_all(parent).map_err(SmitheryError::CredentialIo)?;
		let temporary = self.path.with_extension(format!(
			"json.tmp-{}-{}",
			std::process::id(),
			omp_core::Ulid::generate()
		));
		let mut options = OpenOptions::new();
		options.write(true).create(true).truncate(true);
		#[cfg(unix)]
		{
			use std::os::unix::fs::OpenOptionsExt as _;
			options.mode(0o600);
		}
		let write = (|| -> io::Result<()> {
			let mut file = options.open(&temporary)?;
			file.write_all(&encoded)?;
			file.sync_all()?;
			fs::rename(&temporary, &self.path)?;
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt as _;
				fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
				File::open(parent)?.sync_all()?;
			}
			Ok(())
		})();
		if write.is_err() {
			let _ = fs::remove_file(&temporary);
		}
		write.map_err(SmitheryError::CredentialIo)
	}

	/// Deletes only the persisted credential. An environment key remains
	/// authoritative.
	pub fn clear(&self) -> Result<bool, SmitheryError> {
		match fs::remove_file(&self.path) {
			Ok(()) => {
				#[cfg(unix)]
				if let Some(parent) = self.path.parent() {
					File::open(parent)
						.and_then(|directory| directory.sync_all())
						.map_err(SmitheryError::CredentialIo)?;
				}
				Ok(true)
			},
			Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
			Err(error) => Err(SmitheryError::CredentialIo(error)),
		}
	}
}

fn normalize_key(value: impl AsRef<str>) -> Option<String> {
	let value = value.as_ref().trim();
	(!value.is_empty()).then(|| value.to_owned())
}

/// Search mode accepted by Smithery's registry.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SmitherySearchMode {
	/// Filter by display or qualified identity and sort popular entries first.
	#[default]
	Identity,
	/// Preserve Smithery's semantic relevance order.
	Semantic,
}

/// Scalar type accepted by one Smithery connection input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SmitheryInputKind {
	/// Text or an unknown JSON-schema type.
	String,
	/// Integer or floating-point number.
	Number,
	/// Boolean.
	Boolean,
}

/// One safe registry input descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmitheryInput {
	/// Schema key.
	pub key:           Str,
	/// Scalar value type.
	pub kind:          SmitheryInputKind,
	/// Whether connection requires it.
	pub required:      bool,
	/// Whether UI input must be masked.
	pub sensitive:     bool,
	/// Public description.
	pub description:   Option<Str>,
	/// Public default serialized as a scalar.
	pub default_value: Option<Str>,
}

/// One registry tool summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmitheryTool {
	/// Tool name.
	pub name:        Str,
	/// Optional short description.
	pub description: Option<Str>,
	/// Input property names.
	pub parameters:  Vec<Str>,
}

/// Connection recipe produced from Smithery details.
#[derive(Clone, Eq, PartialEq)]
pub enum SmitheryTransport {
	/// Direct or managed Streamable-HTTP endpoint.
	Http {
		/// MCP endpoint.
		url: Str,
	},
	/// Smithery CLI package bridge.
	Stdio {
		/// Executable name.
		command: Str,
		/// Executable arguments.
		args:    Vec<Str>,
	},
}

impl std::fmt::Debug for SmitheryTransport {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Http { .. } => formatter
				.debug_struct("Http")
				.field("url", &"[REDACTED URL]")
				.finish(),
			Self::Stdio { command, .. } => formatter
				.debug_struct("Stdio")
				.field("command", command)
				.field("args", &"[REDACTED ARGS]")
				.finish(),
		}
	}
}

/// Complete, presentation-neutral Smithery result card.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmitherySearchResult {
	/// Registry identity.
	pub id:              Str,
	/// Qualified name without a leading `@`.
	pub name:            Str,
	/// Display title.
	pub display_name:    Str,
	/// Safe one-line description.
	pub description:     Str,
	/// Registry use count.
	pub use_count:       u64,
	/// Verified publisher marker.
	pub verified:        bool,
	/// Registry deployment marker.
	pub deployed:        bool,
	/// Connection recipe.
	pub transport:       SmitheryTransport,
	/// Advertised tool summaries.
	pub tools:           Vec<SmitheryTool>,
	/// Inputs declared by Smithery's connection schema.
	pub required_inputs: Vec<SmitheryInput>,
	/// Public project homepage.
	pub homepage:        Option<Str>,
}

#[derive(Clone)]
/// Production Smithery client using OMP's shared HTTP pool.
pub struct SmitheryClient {
	http:        omp_http::Client,
	registry:    Url,
	api:         Url,
	web:         Url,
	credentials: SmitheryCredentialStore,
	browser:     Arc<dyn BrowserLauncher>,
}

impl std::fmt::Debug for SmitheryClient {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("SmitheryClient")
			.field("registry", &self.registry)
			.field("api", &self.api)
			.field("web", &self.web)
			.field("credentials", &self.credentials)
			.field("browser", &"BrowserLauncher(..)")
			.finish()
	}
}

impl SmitheryClient {
	/// Creates the production client. `OMP_SMITHERY_*_URL` overrides exist for
	/// private mirrors and deterministic integration tests; credential bytes
	/// never enter those URLs.
	pub fn production(config_root: &Path) -> Result<Self, SmitheryError> {
		let registry = endpoint("OMP_SMITHERY_REGISTRY_URL", REGISTRY_URL)?;
		let api = endpoint("OMP_SMITHERY_API_URL", API_URL)?;
		let web = endpoint("OMP_SMITHERY_URL", WEB_URL)?;
		Ok(Self {
			http: omp_http::no_redirect_client(),
			registry,
			api,
			web,
			credentials: SmitheryCredentialStore::new(config_root),
			browser: Arc::new(SystemBrowserLauncher),
		})
	}

	/// Creates a client around explicit endpoints and browser authority.
	#[must_use]
	pub fn with_parts(
		config_root: &Path,
		http: omp_http::Client,
		registry: Url,
		api: Url,
		web: Url,
		browser: Arc<dyn BrowserLauncher>,
	) -> Self {
		Self {
			http,
			registry: trailing_slash(registry),
			api: trailing_slash(api),
			web: trailing_slash(web),
			credentials: SmitheryCredentialStore::new(config_root),
			browser,
		}
	}

	/// Credential authority used by authenticated registry and connect calls.
	#[must_use]
	pub const fn credentials(&self) -> &SmitheryCredentialStore {
		&self.credentials
	}

	/// Loads the currently effective API key.
	pub fn api_key(&self) -> Result<SecretString, SmitheryError> {
		self
			.credentials
			.load()?
			.ok_or(SmitheryError::AuthenticationRequired)
	}

	/// Searches and hydrates registry result cards under explicit cancellation.
	pub async fn search(
		&self,
		query: &str,
		limit: usize,
		mode: SmitherySearchMode,
		cancel: &CancellationToken,
	) -> Result<Vec<SmitherySearchResult>, SmitheryError> {
		let query = query.trim();
		if query.is_empty() {
			return Ok(Vec::new());
		}
		if query.len() > MAX_QUERY_BYTES {
			return Err(SmitheryError::QueryTooLong);
		}
		if cancel.is_cancelled() {
			return Err(SmitheryError::Cancelled);
		}
		let key = self.api_key()?;
		let limit = limit.clamp(1, 100);
		let page_size = (limit.saturating_mul(2)).max(20);
		let mut entries = Vec::new();
		for page in 1..=MAX_SEARCH_PAGES {
			let mut url = self
				.registry
				.join("servers")
				.map_err(SmitheryError::Endpoint)?;
			{
				let mut pairs = url.query_pairs_mut();
				pairs.append_pair("q", query);
				pairs.append_pair("pageSize", &page_size.to_string());
				if page > 1 {
					pairs.append_pair("page", &page.to_string());
				}
			}
			let payload: SearchResponse = self
				.send_json(
					SmitheryOperation::Search,
					self.http.get(url).bearer_auth(key.expose_secret()),
					REQUEST_TIMEOUT,
					cancel,
				)
				.await?;
			let count = payload.servers.len();
			entries.extend(payload.servers);
			let identity_count = entries
				.iter()
				.filter(|entry| mode == SmitherySearchMode::Semantic || identity_match(query, entry))
				.count();
			if count == 0 || count < page_size || identity_count >= limit.saturating_mul(2) {
				break;
			}
		}
		if mode == SmitherySearchMode::Identity {
			entries.retain(|entry| identity_match(query, entry));
			entries.sort_by_key(|entry| std::cmp::Reverse(entry.use_count.unwrap_or_default()));
		}
		let mut identities = BTreeSet::new();
		let mut unique = Vec::with_capacity(limit.saturating_mul(2).min(entries.len()));
		for entry in entries {
			let candidates = detail_candidates(&entry);
			let Some(identity) = candidates.first().cloned().or_else(|| entry.id.clone()) else {
				continue;
			};
			if identities.insert(identity) {
				unique.push(entry);
			}
			if unique.len() >= limit.saturating_mul(2) {
				break;
			}
		}
		let mut hydrated = stream::iter(unique.into_iter().enumerate())
			.map(|(index, entry)| {
				let key = &key;
				async move { (index, self.hydrate(entry, key, cancel).await) }
			})
			.buffer_unordered(8)
			.collect::<Vec<_>>()
			.await;
		hydrated.sort_by_key(|(index, _)| *index);
		let mut results = Vec::with_capacity(limit.min(hydrated.len()));
		let mut first_failure = None;
		for (_, result) in hydrated {
			match result {
				Ok(Some(result)) => {
					results.push(result);
					if results.len() >= limit {
						break;
					}
				},
				Ok(None) => {},
				Err(error @ SmitheryError::Cancelled) => return Err(error),
				Err(error) if error.needs_login() || error.is_rate_limited() => return Err(error),
				Err(error) => {
					if first_failure.is_none() {
						first_failure = Some(error);
					}
				},
			}
		}
		if results.is_empty()
			&& let Some(error) = first_failure
		{
			return Err(error);
		}
		Ok(results)
	}

	async fn hydrate(
		&self,
		entry: SearchEntry,
		key: &SecretString,
		cancel: &CancellationToken,
	) -> Result<Option<SmitherySearchResult>, SmitheryError> {
		let mut last_failure = None;
		for candidate in detail_candidates(&entry) {
			let path = format!("servers/{candidate}");
			let url = self.registry.join(&path).map_err(SmitheryError::Endpoint)?;
			match self
				.send_optional_json(
					SmitheryOperation::Details,
					self.http.get(url).bearer_auth(key.expose_secret()),
					REQUEST_TIMEOUT,
					cancel,
				)
				.await
			{
				Ok(Some(details)) => return Ok(make_result(&entry, details)),
				Ok(None) => {},
				Err(error @ SmitheryError::Cancelled) => return Err(error),
				Err(error) if error.needs_login() || error.is_rate_limited() => return Err(error),
				Err(error) => last_failure = Some(error),
			}
		}
		match last_failure {
			Some(error) => Err(error),
			None => Ok(None),
		}
	}

	/// Runs Smithery's browser/device grant, validates the returned key, and
	/// persists it privately.
	pub async fn login<F>(&self, cancel: &CancellationToken, on_url: F) -> Result<(), SmitheryError>
	where
		F: FnOnce(&str),
	{
		if cancel.is_cancelled() {
			return Err(SmitheryError::Cancelled);
		}
		let url = self
			.web
			.join("api/auth/cli/session")
			.map_err(SmitheryError::Endpoint)?;
		let session: AuthSession = self
			.send_json(SmitheryOperation::LoginStart, self.http.post(url), REQUEST_TIMEOUT, cancel)
			.await?;
		if !valid_api_id(&session.session_id) {
			return Err(SmitheryError::AuthorizationFailed);
		}
		let auth_url = authorized_browser_url(&session.auth_url)?;
		on_url(auth_url);
		// The public URL is already delivered to the actor, so a platform opener
		// failure must not cancel a device flow the user can complete manually.
		tokio::select! {
			() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
			_ = tokio::time::timeout(REQUEST_TIMEOUT, self.browser.open(auth_url)) => {},
		}
		let deadline = tokio::time::Instant::now() + LOGIN_TIMEOUT;
		loop {
			if tokio::time::Instant::now() >= deadline {
				return Err(SmitheryError::TimedOut { operation: SmitheryOperation::LoginPoll });
			}
			let path = format!("api/auth/cli/poll/{}", session.session_id);
			let url = self.web.join(&path).map_err(SmitheryError::Endpoint)?;
			match self
				.send_optional_json::<AuthPoll>(
					SmitheryOperation::LoginPoll,
					self.http.get(url),
					POLL_REQUEST_TIMEOUT,
					cancel,
				)
				.await
			{
				Ok(Some(AuthPoll { status: AuthStatus::Success, api_key: Some(key) })) => {
					let key = normalize_key(key).ok_or(SmitheryError::EmptyApiKey)?;
					let key = SecretString::from(key);
					self.validate_key(&key, cancel).await?;
					return self.credentials.save(key);
				},
				Ok(Some(AuthPoll { status: AuthStatus::Error, .. })) => {
					return Err(SmitheryError::AuthorizationFailed);
				},
				Ok(_) | Err(SmitheryError::TimedOut { .. }) => {},
				Err(error) => return Err(error),
			}
			tokio::select! {
				() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
				() = tokio::time::sleep(POLL_INTERVAL) => {},
			}
		}
	}

	/// Resolves a namespace, reuses or creates a managed Smithery connection,
	/// and waits until it is ready. The returned URL is safe to persist as an
	/// MCP endpoint; the API key is not embedded.
	pub async fn connect(
		&self,
		mcp_url: &str,
		name: Option<&str>,
		cancel: &CancellationToken,
		on_authorize: impl Fn(&str),
	) -> Result<SmitheryConnection, SmitheryError> {
		if cancel.is_cancelled() {
			return Err(SmitheryError::Cancelled);
		}
		if !valid_remote_mcp_url(mcp_url) || name.is_some_and(|name| !safe_schema_key(name)) {
			return Err(SmitheryError::ConnectionFailed);
		}
		let key = self.api_key()?;
		let namespace = self.resolve_namespace(&key, cancel).await?;
		let connections = self
			.list_connections(&key, &namespace, mcp_url, cancel)
			.await?;
		let (connection, created) = match connections.into_iter().next() {
			Some(connection) => (connection, false),
			None => {
				let url = self
					.api
					.join(&format!("connect/{namespace}"))
					.map_err(SmitheryError::Endpoint)?;
				let body = CreateConnection { mcp_url, name };
				let connection = self
					.send_json(
						SmitheryOperation::CreateConnection,
						authenticated(self.http.request(Method::POST, url), &key).json(&body),
						REQUEST_TIMEOUT,
						cancel,
					)
					.await?;
				(connection, true)
			},
		};
		let connection_id = connection.connection_id.clone();
		let result = self
			.wait_for_connection(&key, &namespace, connection, cancel, on_authorize)
			.await;
		if created && result.is_err() && valid_api_id(&connection_id) {
			let rollback = CancellationToken::new();
			let path = format!("connect/{namespace}/{connection_id}");
			if let Ok(url) = self.api.join(&path) {
				let _ = self
					.send_empty(
						SmitheryOperation::DeleteConnection,
						authenticated(self.http.delete(url), &key),
						REQUEST_TIMEOUT,
						&rollback,
					)
					.await;
			}
		}
		result
	}

	async fn validate_key(
		&self,
		key: &SecretString,
		cancel: &CancellationToken,
	) -> Result<(), SmitheryError> {
		let mut url = self
			.registry
			.join("servers")
			.map_err(SmitheryError::Endpoint)?;
		url.query_pairs_mut()
			.append_pair("q", "mcp")
			.append_pair("pageSize", "1");
		let _: SearchResponse = self
			.send_json(
				SmitheryOperation::Search,
				self.http.get(url).bearer_auth(key.expose_secret()),
				REQUEST_TIMEOUT,
				cancel,
			)
			.await?;
		Ok(())
	}

	async fn resolve_namespace(
		&self,
		key: &SecretString,
		cancel: &CancellationToken,
	) -> Result<Str, SmitheryError> {
		let url = self
			.api
			.join("namespaces")
			.map_err(SmitheryError::Endpoint)?;
		let listed: Namespaces = self
			.send_json(
				SmitheryOperation::ListNamespaces,
				authenticated(self.http.get(url.clone()), key),
				REQUEST_TIMEOUT,
				cancel,
			)
			.await?;
		if let Some(namespace) = listed
			.namespaces
			.into_iter()
			.find(|row| valid_api_id(&row.name))
		{
			return Ok(namespace.name);
		}
		let created: Namespace = self
			.send_json(
				SmitheryOperation::CreateNamespace,
				authenticated(self.http.post(url), key),
				REQUEST_TIMEOUT,
				cancel,
			)
			.await?;
		if !valid_api_id(&created.name) {
			return Err(SmitheryError::EmptyNamespace);
		}
		Ok(created.name)
	}

	async fn list_connections(
		&self,
		key: &SecretString,
		namespace: &str,
		mcp_url: &str,
		cancel: &CancellationToken,
	) -> Result<Vec<SmitheryConnection>, SmitheryError> {
		let mut url = self
			.api
			.join(&format!("connect/{namespace}"))
			.map_err(SmitheryError::Endpoint)?;
		url.query_pairs_mut().append_pair("mcpUrl", mcp_url);
		let response: Connections = self
			.send_json(
				SmitheryOperation::ListConnections,
				authenticated(self.http.get(url), key),
				REQUEST_TIMEOUT,
				cancel,
			)
			.await?;
		Ok(response.connections)
	}

	async fn wait_for_connection(
		&self,
		key: &SecretString,
		namespace: &str,
		mut connection: SmitheryConnection,
		cancel: &CancellationToken,
		on_authorize: impl Fn(&str),
	) -> Result<SmitheryConnection, SmitheryError> {
		let deadline = tokio::time::Instant::now() + LOGIN_TIMEOUT;
		let mut announced = BTreeSet::new();
		loop {
			match &connection.status {
				Some(ConnectionStatus::Connected) | None => {
					if valid_remote_mcp_url(&connection.mcp_url) {
						return Ok(connection);
					}
					return Err(SmitheryError::ConnectionFailed);
				},
				Some(ConnectionStatus::AuthRequired { authorization_url: Some(url) }) => {
					let url = authorized_browser_url(url)?;
					if announced.insert(url.to_owned()) {
						on_authorize(url);
						// Keep polling when the platform opener is unavailable; the actor
						// has the same URL for manual authorization.
						tokio::select! {
							() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
							_ = tokio::time::timeout(REQUEST_TIMEOUT, self.browser.open(url)) => {},
						}
					}
				},
				Some(ConnectionStatus::Error) => return Err(SmitheryError::ConnectionFailed),
				Some(ConnectionStatus::AuthRequired { authorization_url: None })
				| Some(ConnectionStatus::Pending) => {},
			}
			if tokio::time::Instant::now() >= deadline {
				return Err(SmitheryError::TimedOut { operation: SmitheryOperation::GetConnection });
			}
			tokio::select! {
				() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
				() = tokio::time::sleep(POLL_INTERVAL) => {},
			}
			if !valid_api_id(&connection.connection_id) {
				return Err(SmitheryError::ConnectionFailed);
			}
			let path = format!("connect/{namespace}/{}", connection.connection_id);
			let url = self.api.join(&path).map_err(SmitheryError::Endpoint)?;
			connection = self
				.send_json(
					SmitheryOperation::GetConnection,
					authenticated(self.http.get(url), key),
					REQUEST_TIMEOUT,
					cancel,
				)
				.await?;
		}
	}

	async fn send_empty(
		&self,
		operation: SmitheryOperation,
		request: RequestBuilder,
		timeout: Duration,
		cancel: &CancellationToken,
	) -> Result<(), SmitheryError> {
		let response = tokio::select! {
			() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
			result = tokio::time::timeout(timeout, request.send()) => match result {
				Ok(Ok(response)) => response,
				Ok(Err(source)) => return Err(SmitheryError::Request { operation, source }),
				Err(_) => return Err(SmitheryError::TimedOut { operation }),
			},
		};
		if response.status().is_success() {
			Ok(())
		} else {
			Err(SmitheryError::Status { operation, status: response.status() })
		}
	}

	async fn send_json<T: DeserializeOwned>(
		&self,
		operation: SmitheryOperation,
		request: RequestBuilder,
		timeout: Duration,
		cancel: &CancellationToken,
	) -> Result<T, SmitheryError> {
		self
			.send_optional_json(operation, request, timeout, cancel)
			.await?
			.ok_or_else(|| SmitheryError::Status { operation, status: StatusCode::NOT_FOUND })
	}

	async fn send_optional_json<T: DeserializeOwned>(
		&self,
		operation: SmitheryOperation,
		request: RequestBuilder,
		timeout: Duration,
		cancel: &CancellationToken,
	) -> Result<Option<T>, SmitheryError> {
		let response = tokio::select! {
			() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
			result = tokio::time::timeout(timeout, request.send()) => match result {
				Ok(Ok(response)) => response,
				Ok(Err(source)) => return Err(SmitheryError::Request { operation, source }),
				Err(_) => return Err(SmitheryError::TimedOut { operation }),
			},
		};
		if response.status() == StatusCode::NOT_FOUND || response.status() == StatusCode::GONE {
			if operation == SmitheryOperation::LoginPoll {
				return Err(SmitheryError::LoginExpired);
			}
			return Ok(None);
		}
		if !response.status().is_success() {
			return Err(SmitheryError::Status { operation, status: response.status() });
		}
		let read_body = async {
			let mut stream = response.bytes_stream();
			let mut bytes = Zeroizing::new(Vec::new());
			while let Some(chunk) = stream.next().await {
				let chunk = chunk.map_err(|source| SmitheryError::Request { operation, source })?;
				if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
					return Err(SmitheryError::ResponseTooLarge { operation });
				}
				bytes.extend_from_slice(&chunk);
			}
			Ok::<_, SmitheryError>(bytes)
		};
		let bytes = tokio::select! {
			() = cancel.cancelled() => return Err(SmitheryError::Cancelled),
			result = tokio::time::timeout(timeout, read_body) => match result {
				Ok(result) => result?,
				Err(_) => return Err(SmitheryError::TimedOut { operation }),
			},
		};
		serde_json::from_slice(&bytes)
			.map(Some)
			.map_err(|source| SmitheryError::Decode { operation, source })
	}
}

fn valid_remote_mcp_url(value: &str) -> bool {
	value.len() <= 8 * 1024
		&& Url::parse(value).is_ok_and(|url| {
			matches!(url.scheme(), "https" | "http")
				&& url.host_str().is_some()
				&& url.username().is_empty()
				&& url.password().is_none()
		})
}

fn authorized_browser_url(value: &str) -> Result<&str, SmitheryError> {
	if value.len() > 8 * 1024 {
		return Err(SmitheryError::InvalidAuthorizationUrl);
	}
	let url = Url::parse(value).map_err(|_| SmitheryError::InvalidAuthorizationUrl)?;
	let allowed = url.scheme() == "https"
		|| (url.scheme() == "http"
			&& url
				.host_str()
				.is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1")));
	if !allowed || url.username() != "" || url.password().is_some() {
		return Err(SmitheryError::InvalidAuthorizationUrl);
	}
	Ok(value)
}

fn authenticated(request: RequestBuilder, key: &SecretString) -> RequestBuilder {
	request
		.bearer_auth(key.expose_secret())
		.header(reqwest::header::CONTENT_TYPE, "application/json")
}

fn endpoint(environment: &str, fallback: &str) -> Result<Url, SmitheryError> {
	let value = std::env::var(environment).unwrap_or_else(|_| fallback.to_owned());
	Url::parse(&value)
		.map(trailing_slash)
		.map_err(SmitheryError::Endpoint)
}

fn trailing_slash(mut url: Url) -> Url {
	if !url.path().ends_with('/') {
		let mut path = url.path().to_owned();
		path.push('/');
		url.set_path(&path);
	}
	url
}

#[derive(Deserialize)]
struct SearchResponse {
	#[serde(default)]
	servers: Vec<SearchEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchEntry {
	id:             Option<String>,
	qualified_name: Option<String>,
	namespace:      Option<String>,
	slug:           Option<String>,
	display_name:   Option<String>,
	description:    Option<String>,
	use_count:      Option<u64>,
	homepage:       Option<String>,
	verified:       Option<bool>,
	is_deployed:    Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerDetails {
	qualified_name: Option<String>,
	display_name:   Option<String>,
	description:    Option<String>,
	remote:         Option<bool>,
	deployment_url: Option<String>,
	#[serde(default)]
	connections:    Vec<ConnectionRecipe>,
	#[serde(default)]
	tools:          Vec<ToolDefinition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRecipe {
	#[serde(rename = "type")]
	kind:           Option<String>,
	deployment_url: Option<String>,
	config_schema:  Option<ConfigSchema>,
}

#[derive(Deserialize)]
struct ConfigSchema {
	#[serde(default)]
	required:   Vec<String>,
	#[serde(default)]
	properties: BTreeMap<String, ConfigProperty>,
}

#[derive(Deserialize)]
struct ConfigProperty {
	#[serde(rename = "type")]
	kind:        Option<String>,
	description: Option<String>,
	default:     Option<serde_json::Value>,
	format:      Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolDefinition {
	name:         Option<String>,
	description:  Option<String>,
	input_schema: Option<ToolInputSchema>,
}

#[derive(Deserialize)]
struct ToolInputSchema {
	#[serde(default)]
	properties: BTreeMap<String, serde_json::Value>,
}

fn identity_match(query: &str, entry: &SearchEntry) -> bool {
	let query = query.to_ascii_lowercase();
	entry
		.display_name
		.as_deref()
		.into_iter()
		.chain(entry.qualified_name.as_deref())
		.any(|value| value.to_ascii_lowercase().contains(&query))
}

fn detail_candidates(entry: &SearchEntry) -> Vec<String> {
	let mut out = Vec::with_capacity(3);
	if let (Some(namespace), Some(slug)) = (&entry.namespace, &entry.slug) {
		out.push(format!("{namespace}/{slug}"));
	}
	if let Some(slug) = &entry.slug
		&& !out.contains(slug)
	{
		out.push(slug.clone());
	}
	if let Some(name) = entry
		.qualified_name
		.as_deref()
		.map(|name| name.trim_start_matches('@'))
		&& !out.iter().any(|candidate| candidate == name)
	{
		out.push(name.to_owned());
	}
	out
}

fn make_result(entry: &SearchEntry, details: ServerDetails) -> Option<SmitherySearchResult> {
	let id = entry.id.as_deref()?;
	let qualified = details
		.qualified_name
		.as_deref()
		.map(ToOwned::to_owned)
		.or_else(|| entry.qualified_name.clone())
		.or_else(|| match (&entry.namespace, &entry.slug) {
			(Some(namespace), Some(slug)) => Some(format!("{namespace}/{slug}")),
			_ => None,
		})?;
	let qualified = qualified.trim_start_matches('@').to_owned();
	if !valid_qualified_name(&qualified) {
		return None;
	}
	let http = details
		.connections
		.iter()
		.find(|recipe| recipe.kind.as_deref() == Some("http") && recipe.deployment_url.is_some());
	let stdio = details
		.connections
		.iter()
		.find(|recipe| recipe.kind.as_deref() == Some("stdio"));
	let selected = http.or(stdio)?;
	let inputs = schema_inputs(selected.config_schema.as_ref());
	let direct_http = selected.kind.as_deref() == Some("http") && inputs.is_empty();
	let transport = if direct_http {
		let url = selected.deployment_url.as_deref()?;
		if !valid_remote_mcp_url(url) {
			return None;
		}
		SmitheryTransport::Http { url: Str::new(url) }
	} else {
		SmitheryTransport::Stdio {
			command: Str::new_static("bunx"),
			args:    vec![
				Str::new_static("-y"),
				Str::new_static("@smithery/cli"),
				Str::new_static("run"),
				Str::new(format!("@{qualified}")),
				Str::new_static("--config"),
				Str::new_static("{}"),
			],
		}
	};
	let display_name = safe_text(
		details
			.display_name
			.as_deref()
			.or(entry.display_name.as_deref())
			.unwrap_or(&qualified),
	)
	.unwrap_or_else(|| qualified.clone());
	let description = safe_text(
		details
			.description
			.as_deref()
			.or(entry.description.as_deref())
			.unwrap_or("No description"),
	)
	.unwrap_or_else(|| "No description".to_owned());
	let tools = details
		.tools
		.into_iter()
		.take(MAX_DEFINITION_ITEMS)
		.filter_map(|tool| {
			let name = safe_text(tool.name.as_deref()?)?;
			Some(SmitheryTool {
				name:        Str::new(name),
				description: tool
					.description
					.as_deref()
					.and_then(safe_text)
					.map(Str::new),
				parameters:  tool
					.input_schema
					.map(|schema| {
						schema
							.properties
							.into_keys()
							.take(MAX_DEFINITION_ITEMS)
							.filter(|key| safe_schema_key(key))
							.map(Str::new)
							.collect()
					})
					.unwrap_or_default(),
			})
		})
		.collect();
	let _remote = details.remote.unwrap_or(false);
	let _legacy_deployment = details.deployment_url;
	Some(SmitherySearchResult {
		id: Str::new(id),
		name: Str::new(qualified),
		display_name: Str::new(display_name),
		description: Str::new(description),
		use_count: entry.use_count.unwrap_or_default(),
		verified: entry.verified.unwrap_or(false),
		deployed: entry.is_deployed.unwrap_or(false),
		transport,
		tools,
		required_inputs: inputs,
		homepage: entry.homepage.as_deref().and_then(safe_public_url),
	})
}

fn safe_public_url(value: &str) -> Option<Str> {
	let mut url = Url::parse(value).ok()?;
	if !matches!(url.scheme(), "https" | "http")
		|| url.host_str().is_none()
		|| !url.username().is_empty()
		|| url.password().is_some()
	{
		return None;
	}
	url.set_query(None);
	url.set_fragment(None);
	Some(Str::new(url.as_str()))
}

fn schema_inputs(schema: Option<&ConfigSchema>) -> Vec<SmitheryInput> {
	let Some(schema) = schema else {
		return Vec::new();
	};
	let required = schema.required.iter().collect::<BTreeSet<_>>();
	schema
		.properties
		.iter()
		.take(MAX_DEFINITION_ITEMS)
		.filter_map(|(key, property)| {
			if !safe_schema_key(key) {
				return None;
			}
			let sensitive = property
				.format
				.as_deref()
				.is_some_and(|format| format.eq_ignore_ascii_case("password"))
				|| sensitive_key(key);
			Some(SmitheryInput {
				key: Str::new(key),
				kind: match property.kind.as_deref() {
					Some("number" | "integer") => SmitheryInputKind::Number,
					Some("boolean") => SmitheryInputKind::Boolean,
					_ => SmitheryInputKind::String,
				},
				required: required.contains(key),
				sensitive,
				description: property
					.description
					.as_deref()
					.and_then(safe_text)
					.map(Str::new),
				default_value: if sensitive {
					None
				} else {
					property
						.default
						.as_ref()
						.and_then(scalar_text)
						.map(Str::new)
				},
			})
		})
		.collect()
}

fn valid_api_id(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= 256
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_schema_key(value: &str) -> bool {
	!value.is_empty() && value.len() <= 256 && !value.bytes().any(|byte| byte.is_ascii_control())
}

fn valid_qualified_name(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= 200
		&& !value
			.split('/')
			.any(|part| part.is_empty() || matches!(part, "." | ".."))
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

fn sensitive_key(key: &str) -> bool {
	let key = key.to_ascii_lowercase().replace('-', "_");
	["api_key", "apikey", "token", "secret", "password"]
		.iter()
		.any(|marker| key.contains(marker))
}

fn scalar_text(value: &serde_json::Value) -> Option<String> {
	match value {
		serde_json::Value::String(value) if value.len() <= MAX_METADATA_BYTES => Some(value.clone()),
		serde_json::Value::Number(value) => Some(value.to_string()),
		serde_json::Value::Bool(value) => Some(value.to_string()),
		_ => None,
	}
}

fn safe_text(value: &str) -> Option<String> {
	if value.len() > MAX_METADATA_BYTES {
		return None;
	}
	let value = value
		.chars()
		.map(|character| {
			if character.is_ascii_control() {
				' '
			} else {
				character
			}
		})
		.collect::<String>();
	let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
	(!value.is_empty()).then_some(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
	session_id: String,
	auth_url:   String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthStatus {
	Pending,
	Success,
	Error,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthPoll {
	status:  AuthStatus,
	api_key: Option<String>,
}

#[derive(Deserialize)]
struct Namespace {
	name: Str,
}

#[derive(Deserialize)]
struct Namespaces {
	#[serde(default)]
	namespaces: Vec<Namespace>,
}

/// Smithery-managed remote connection.
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmitheryConnection {
	/// Stable Smithery connection id.
	pub connection_id: Str,
	/// Proxy MCP endpoint without embedded credentials.
	pub mcp_url:       Str,
	/// Display name.
	pub name:          Str,
	/// Current connection state.
	pub status:        Option<ConnectionStatus>,
	/// Creation timestamp, when returned.
	pub created_at:    Option<Str>,
}

impl std::fmt::Debug for SmitheryConnection {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("SmitheryConnection")
			.field("connection_id", &self.connection_id)
			.field("mcp_url", &"[REDACTED URL]")
			.field("name", &self.name)
			.field(
				"status",
				&self.status.as_ref().map(|status| {
					let label: &'static str = status.into();
					label
				}),
			)
			.field("created_at", &self.created_at)
			.finish()
	}
}

/// Public managed-connection state. Smithery's remote diagnostic body is
/// deliberately omitted.
#[derive(Clone, Deserialize, Eq, PartialEq, strum::IntoStaticStr)]
#[serde(tag = "state", rename_all = "snake_case")]
#[strum(serialize_all = "kebab-case")]
pub enum ConnectionStatus {
	/// Ready to mount.
	Connected,
	/// User authorization is required.
	AuthRequired {
		/// Public browser URL.
		#[serde(rename = "authorizationUrl")]
		authorization_url: Option<String>,
	},
	/// Smithery reported a terminal failure; message intentionally discarded.
	Error,
	/// Forward-compatible non-terminal state.
	#[serde(other)]
	Pending,
}

impl std::fmt::Debug for ConnectionStatus {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let label: &'static str = self.into();
		formatter.write_str(label)
	}
}

#[derive(Deserialize)]
struct Connections {
	#[serde(default)]
	connections: Vec<SmitheryConnection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateConnection<'a> {
	mcp_url: &'a str,
	#[serde(skip_serializing_if = "Option::is_none")]
	name:    Option<&'a str>,
}

/// Stable config name derived from a Smithery qualified name.
#[must_use]
pub fn smithery_config_name(candidate: &str) -> Str {
	let mut out = String::with_capacity(candidate.len());
	let mut dash = false;
	for byte in candidate.trim_start_matches('@').bytes() {
		let normalized = match byte {
			b'A'..=b'Z' => byte + (b'a' - b'A'),
			b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' => byte,
			b'/' | b'-' => b'-',
			_ => b'-',
		};
		if normalized == b'-' {
			if dash || out.is_empty() {
				continue;
			}
			dash = true;
		} else {
			dash = false;
		}
		out.push(char::from(normalized));
	}
	while out.ends_with('-') {
		out.pop();
	}
	if out.is_empty() {
		Str::new_static("mcp-server")
	} else {
		Str::new(out)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn credential_debug_and_errors_never_reveal_secret_bytes() {
		let root = tempfile::tempdir().expect("tempdir");
		let store = SmitheryCredentialStore::new(root.path());
		store
			.save(SecretString::from("smithery-super-secret".to_owned()))
			.expect("save");
		assert!(!format!("{store:?}").contains("smithery-super-secret"));
		assert!(
			!SmitheryError::AuthenticationRequired
				.to_string()
				.contains("secret")
		);
		let persisted = fs::read_to_string(store.path()).expect("persisted credential");
		assert!(persisted.contains("\"apiKey\": \"smithery-super-secret\""));
		assert!(store.clear().expect("clear"));
		assert!(!store.clear().expect("idempotent clear"));
	}

	#[cfg(unix)]
	#[test]
	fn credential_file_is_owner_only() {
		use std::os::unix::fs::PermissionsExt as _;
		let root = tempfile::tempdir().expect("tempdir");
		let store = SmitheryCredentialStore::new(root.path());
		store
			.save(SecretString::from("key".to_owned()))
			.expect("save");
		assert_eq!(
			fs::metadata(store.path())
				.expect("metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);
	}

	#[tokio::test]
	async fn cancellation_precedes_credentials_and_network() {
		let root = tempfile::tempdir().expect("tempdir");
		let client = SmitheryClient::with_parts(
			root.path(),
			omp_http::no_redirect_client(),
			Url::parse(REGISTRY_URL).expect("registry"),
			Url::parse(API_URL).expect("api"),
			Url::parse(WEB_URL).expect("web"),
			Arc::new(SystemBrowserLauncher),
		);
		let cancel = CancellationToken::new();
		cancel.cancel();
		assert!(matches!(
			client
				.search("filesystem", 1, SmitherySearchMode::Identity, &cancel)
				.await,
			Err(SmitheryError::Cancelled)
		));
	}

	#[test]
	fn browser_authorization_rejects_credentials_and_unsafe_schemes() {
		assert!(authorized_browser_url("https://smithery.ai/auth").is_ok());
		assert!(authorized_browser_url("http://127.0.0.1:43123/callback").is_ok());
		assert!(authorized_browser_url("file:///tmp/token").is_err());
		assert!(authorized_browser_url("https://user:pass@smithery.ai/auth").is_err());
		assert!(valid_remote_mcp_url("https://mcp.example/api"));
		assert!(!valid_remote_mcp_url("https://key@mcp.example/api"));
	}

	#[test]
	fn config_names_are_stable_and_safe() {
		assert_eq!(smithery_config_name("@Smithery-AI/File System"), "smithery-ai-file-system");
		assert_eq!(smithery_config_name("***"), "mcp-server");
		assert!(valid_qualified_name("smithery-ai/filesystem"));
		assert!(!valid_qualified_name("../filesystem"));
		assert!(!valid_qualified_name("smithery-ai/\u{1b}[31mfilesystem"));
	}

	#[test]
	fn required_secret_inputs_are_typed_without_values() {
		let schema = ConfigSchema {
			required:   vec!["apiKey".to_owned()],
			properties: BTreeMap::from([("apiKey".to_owned(), ConfigProperty {
				kind:        Some("string".to_owned()),
				description: Some("Credential".to_owned()),
				default:     Some(serde_json::Value::String("must-not-project".to_owned())),
				format:      Some("password".to_owned()),
			})]),
		};
		let inputs = schema_inputs(Some(&schema));
		assert!(inputs[0].required);
		assert!(inputs[0].sensitive);
		assert!(inputs[0].default_value.is_none());
	}
}
