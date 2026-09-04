use std::{
	collections::{HashMap, VecDeque},
	io, str,
	sync::Arc,
	time::{Duration, Instant},
};

use async_trait::async_trait;
use bytes::Bytes;
use omp_core::{Str, sf};
use omp_proto::lsp::{PositionEncoding, Range};
use omp_walker::glob::{CompiledPattern, PatternBuilder};
use parking_lot::Mutex;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	DocumentId, DocumentKind, DocumentSnapshot, LanguageId, Revision,
	lsp_process::LspFrameError,
	position::{PositionError, TextEdit, apply_text_edits, offset_to_position},
};

const DID_OPEN: &str = "textDocument/didOpen";
const DID_CHANGE: &str = "textDocument/didChange";
const WILL_SAVE: &str = "textDocument/willSave";
const WILL_SAVE_WAIT_UNTIL: &str = "textDocument/willSaveWaitUntil";
const DID_SAVE: &str = "textDocument/didSave";
const DID_CLOSE: &str = "textDocument/didClose";
const VERSION_HISTORY_LIMIT: usize = 128;
const FORMATTING: &str = "textDocument/formatting";

/// A structured failure from the JSON-RPC transport boundary.
#[derive(Clone, Debug, Error)]
pub enum LspTransportError {
	/// The operation was cancelled before a response was available.
	#[error("LSP operation was cancelled")]
	Cancelled,
	/// The server returned a JSON-RPC error response.
	#[error("LSP JSON-RPC error {code}: {message}")]
	JsonRpc {
		/// JSON-RPC error code.
		code:    i32,
		/// Server-provided error message.
		message: Str,
		/// Exact raw JSON error data, when present.
		data:    Option<Bytes>,
	},
	/// The underlying process or multiplexed connection closed.
	#[error("LSP transport closed: {message}")]
	Closed {
		/// Transport-specific diagnostic.
		message: Str,
	},
	/// Reading or writing the process transport failed.
	#[error("{operation}: {source}")]
	Io {
		/// The transport operation that failed.
		operation: &'static str,
		/// The underlying I/O failure.
		#[source]
		source:    Arc<io::Error>,
	},
	/// Reading an LSP frame failed.
	#[error("LSP transport closed: {source}")]
	Frame {
		/// The frame decoding failure.
		#[source]
		source: Arc<LspFrameError>,
	},
	/// The peer returned malformed JSON where raw JSON was required.
	#[error("invalid LSP response JSON")]
	InvalidJson {
		/// The JSON decoding failure.
		#[source]
		source: Arc<serde_json::Error>,
	},
	/// The peer returned an invalid response that was not a JSON decoding
	/// failure.
	#[error("invalid LSP response JSON: {message}")]
	InvalidResponse {
		/// Parsing diagnostic.
		message: Str,
	},
}

/// Raw, cancellable JSON transport used by [`LspServer`].
///
/// `params` and successful request results contain exact UTF-8 JSON values,
/// without a JSON-RPC envelope. Implementations may represent a process, mux,
/// or another ordered connection.
#[async_trait]
pub trait LspTransport: Send + Sync + 'static {
	/// Sends a request and returns its exact raw JSON result.
	async fn request(
		&self,
		method: &str,
		params: Bytes,
		cancel: CancellationToken,
	) -> Result<Bytes, LspTransportError>;

	/// Sends a notification after it reaches the transport's write path.
	async fn notify(
		&self,
		method: &str,
		params: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspTransportError>;
}

/// LSP text synchronization mode.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TextDocumentSyncKind {
	/// The server cannot be synchronized through text lifecycle messages.
	#[default]
	None,
	/// Every change carries the complete document.
	Full,
	/// Changes carry ranges in the negotiated position encoding.
	Incremental,
}

impl TextDocumentSyncKind {
	fn from_json(value: Option<&Value>) -> Self {
		match value.and_then(Value::as_i64) {
			Some(1) => Self::Full,
			Some(2) => Self::Incremental,
			_ => Self::None,
		}
	}
}

/// Resolved synchronization behavior for one document.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SyncPolicy {
	/// Change notification representation.
	pub change:               TextDocumentSyncKind,
	/// Whether balanced open and close notifications are advertised.
	pub open_close:           bool,
	/// Whether `willSave` is advertised.
	pub will_save:            bool,
	/// Whether `willSaveWaitUntil` is advertised.
	pub will_save_wait_until: bool,
	/// Whether `didSave` is advertised.
	pub save:                 bool,
	/// Whether `didSave` requests the complete text.
	pub save_include_text:    bool,
	/// Negotiated text position encoding.
	pub position_encoding:    PositionEncoding,
}

impl Default for SyncPolicy {
	fn default() -> Self {
		Self {
			change:               TextDocumentSyncKind::None,
			open_close:           false,
			will_save:            false,
			will_save_wait_until: false,
			save:                 false,
			save_include_text:    false,
			position_encoding:    PositionEncoding::Utf16,
		}
	}
}

#[derive(Clone, Copy, Debug)]
struct ResolvedPolicy {
	public:     SyncPolicy,
	formatting: bool,
}

/// Parsed server capabilities with their original JSON retained exactly.
#[derive(Debug)]
pub struct LspCapabilities {
	raw:           Bytes,
	base:          SyncPolicy,
	formatting:    bool,
	registrations: Vec<DynamicRegistration>,
}

impl LspCapabilities {
	/// Parses an `InitializeResult.capabilities` JSON object without discarding
	/// its bytes.
	pub fn parse(raw: Bytes) -> Result<Self, LspError> {
		let value: Value = serde_json::from_slice(&raw).map_err(invalid_json)?;
		let object = value
			.as_object()
			.ok_or_else(|| LspError::InvalidCapabilities {
				reason: sf!("server capabilities must be a JSON object"),
			})?;
		let mut base = SyncPolicy::default();
		if let Some(sync) = object.get("textDocumentSync") {
			if sync.is_number() {
				base.change = TextDocumentSyncKind::from_json(Some(sync));
				if base.change != TextDocumentSyncKind::None {
					base.open_close = true;
				}
			} else if let Some(sync) = sync.as_object() {
				base.change = TextDocumentSyncKind::from_json(sync.get("change"));
				base.open_close = sync
					.get("openClose")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				base.will_save = sync
					.get("willSave")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				base.will_save_wait_until = sync
					.get("willSaveWaitUntil")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				match sync.get("save") {
					Some(Value::Bool(enabled)) => base.save = *enabled,
					Some(Value::Object(save)) => {
						base.save = true;
						base.save_include_text = save
							.get("includeText")
							.and_then(Value::as_bool)
							.unwrap_or(false);
					},
					_ => {},
				}
			}
		}
		base.position_encoding = match object.get("positionEncoding").and_then(Value::as_str) {
			None | Some("utf-16") => PositionEncoding::Utf16,
			Some("utf-8") => PositionEncoding::Utf8,
			Some("utf-32") => PositionEncoding::Utf32,
			Some(encoding) => {
				return Err(LspError::InvalidCapabilities {
					reason: sf!("unsupported position encoding {encoding}"),
				});
			},
		};
		let formatting = capability_enabled(object.get("documentFormattingProvider"));
		Ok(Self { raw, base, formatting, registrations: Vec::new() })
	}

	/// Returns the exact capability JSON supplied at construction.
	pub const fn raw_json(&self) -> &Bytes {
		&self.raw
	}

	/// Resolves static and dynamic capabilities for a URI and language.
	pub fn policy_for(&self, uri: &Url, language: Option<&str>) -> SyncPolicy {
		self.resolve(uri, language).public
	}

	fn resolve(&self, uri: &Url, language: Option<&str>) -> ResolvedPolicy {
		let mut policy = self.base;
		let mut formatting = self.formatting;
		let mut dynamic_open = false;
		let mut dynamic_close = false;
		for registration in &self.registrations {
			if !registration.selector.matches(uri, language) {
				continue;
			}
			match registration.method.as_str() {
				DID_OPEN => dynamic_open = true,
				DID_CLOSE => dynamic_close = true,
				DID_CHANGE => policy.change = registration.change,
				WILL_SAVE => policy.will_save = true,
				WILL_SAVE_WAIT_UNTIL => policy.will_save_wait_until = true,
				DID_SAVE => {
					policy.save = true;
					policy.save_include_text |= registration.include_text;
				},
				FORMATTING => formatting = true,
				_ => {},
			}
		}
		policy.open_close |= dynamic_open && dynamic_close;
		ResolvedPolicy { public: policy, formatting }
	}

	fn register(&mut self, params: &[u8]) -> Result<(), LspError> {
		let value: Value = serde_json::from_slice(params).map_err(invalid_json)?;
		let registrations = value
			.get("registrations")
			.and_then(Value::as_array)
			.ok_or_else(|| LspError::InvalidRegistration {
				reason: sf!("registerCapability requires a registrations array"),
			})?;
		let mut compiled = Vec::with_capacity(registrations.len());
		for registration in registrations {
			let id = required_string(registration, "id")?;
			if self.registrations.iter().any(|existing| existing.id == id)
				|| compiled
					.iter()
					.any(|existing: &DynamicRegistration| existing.id == id)
			{
				return Err(LspError::InvalidRegistration {
					reason: Str::new("duplicate registration id"),
				});
			}
			let method = required_string(registration, "method")?;
			let options = registration.get("registerOptions").unwrap_or(&Value::Null);
			compiled.push(DynamicRegistration {
				id,
				method,
				selector: DocumentSelector::compile(options.get("documentSelector"))?,
				change: TextDocumentSyncKind::from_json(options.get("syncKind")),
				include_text: options
					.get("includeText")
					.and_then(Value::as_bool)
					.unwrap_or(false),
			});
		}
		self.registrations.extend(compiled);
		Ok(())
	}

	fn unregister(&mut self, params: &[u8]) -> Result<(), LspError> {
		let value: Value = serde_json::from_slice(params).map_err(invalid_json)?;
		let entries = value
			.get("unregistrations")
			.or_else(|| value.get("unregisterations"))
			.and_then(Value::as_array)
			.ok_or_else(|| LspError::InvalidRegistration {
				reason: sf!("unregisterCapability requires an unregistrations array"),
			})?;
		let removals = entries
			.iter()
			.map(|entry| Ok((required_string(entry, "id")?, required_string(entry, "method")?)))
			.collect::<Result<Vec<_>, LspError>>()?;
		for (id, method) in &removals {
			if !self.registrations.iter().any(|registration| {
				registration.id.as_str() == id.as_str()
					&& registration.method.as_str() == method.as_str()
			}) {
				return Err(LspError::InvalidRegistration {
					reason: Str::new("unknown registration id and method"),
				});
			}
		}
		self.registrations.retain(|registration| {
			!removals.iter().any(|(id, method)| {
				registration.id.as_str() == id.as_str()
					&& registration.method.as_str() == method.as_str()
			})
		});
		Ok(())
	}
}

const fn capability_enabled(value: Option<&Value>) -> bool {
	matches!(value, Some(Value::Bool(true) | Value::Object(_)))
}

fn required_string(value: &Value, field: &'static str) -> Result<Str, LspError> {
	value
		.get(field)
		.and_then(Value::as_str)
		.map(Str::new)
		.ok_or_else(|| LspError::InvalidRegistration {
			reason: sf!("registration field {field} must be a string"),
		})
}

#[derive(Debug)]
struct DynamicRegistration {
	id:           Str,
	method:       Str,
	selector:     DocumentSelector,
	change:       TextDocumentSyncKind,
	include_text: bool,
}

#[derive(Debug)]
enum DocumentSelector {
	All,
	Any(Vec<SelectorFilter>),
}

impl DocumentSelector {
	fn compile(value: Option<&Value>) -> Result<Self, LspError> {
		let Some(value) = value else {
			return Ok(Self::All);
		};
		if value.is_null() {
			return Ok(Self::All);
		}
		let entries = value
			.as_array()
			.ok_or_else(|| LspError::InvalidRegistration {
				reason: sf!("documentSelector must be an array or null"),
			})?;
		let mut filters = Vec::with_capacity(entries.len());
		for entry in entries {
			let object = entry
				.as_object()
				.ok_or_else(|| LspError::InvalidRegistration {
					reason: sf!("document selector entries must be objects"),
				})?;
			let language = object.get("language").and_then(Value::as_str).map(Str::new);
			let scheme = object.get("scheme").and_then(Value::as_str).map(Str::new);
			let pattern = object
				.get("pattern")
				.map(SelectorPattern::compile)
				.transpose()?;
			filters.push(SelectorFilter { language, scheme, pattern });
		}
		Ok(Self::Any(filters))
	}

	fn matches(&self, uri: &Url, language: Option<&str>) -> bool {
		match self {
			Self::All => true,
			Self::Any(filters) => filters.iter().any(|filter| filter.matches(uri, language)),
		}
	}
}

#[derive(Debug)]
struct SelectorFilter {
	language: Option<Str>,
	scheme:   Option<Str>,
	pattern:  Option<SelectorPattern>,
}

impl SelectorFilter {
	fn matches(&self, uri: &Url, language: Option<&str>) -> bool {
		self
			.language
			.as_deref()
			.is_none_or(|wanted| language == Some(wanted))
			&& self
				.scheme
				.as_deref()
				.is_none_or(|wanted| uri.scheme() == wanted)
			&& self
				.pattern
				.as_ref()
				.is_none_or(|pattern| pattern.matches(uri))
	}
}

#[derive(Debug)]
struct SelectorPattern {
	matcher:  CompiledPattern,
	base_uri: Option<Url>,
}

impl SelectorPattern {
	fn compile(value: &Value) -> Result<Self, LspError> {
		let (pattern, base_uri) = match value {
			Value::String(pattern) => (pattern.as_str(), None),
			Value::Object(relative) => {
				let pattern = relative
					.get("pattern")
					.and_then(Value::as_str)
					.ok_or_else(|| LspError::InvalidRegistration {
						reason: sf!("relative pattern requires a string pattern"),
					})?;
				let base = relative
					.get("baseUri")
					.ok_or_else(|| LspError::InvalidRegistration {
						reason: sf!("relative pattern requires baseUri"),
					})?;
				let base = base
					.as_str()
					.or_else(|| base.get("uri").and_then(Value::as_str))
					.ok_or_else(|| LspError::InvalidRegistration {
						reason: sf!("relative pattern baseUri must contain a URI"),
					})?;
				let base = Url::parse(base).map_err(|error| LspError::InvalidRegistration {
					reason: Str::new(error.to_string()),
				})?;
				(pattern, Some(base))
			},
			_ => {
				return Err(LspError::InvalidRegistration {
					reason: sf!("selector pattern must be a string or relative pattern"),
				});
			},
		};
		let matcher = PatternBuilder::new(pattern)
			.literal_separator(false)
			.build()
			.map_err(|error| LspError::InvalidRegistration { reason: Str::new(error.to_string()) })?;
		Ok(Self { matcher, base_uri })
	}

	fn matches(&self, uri: &Url) -> bool {
		if let Some(base) = &self.base_uri {
			if base.scheme() != uri.scheme()
				|| base.username() != uri.username()
				|| base.password() != uri.password()
				|| base.host_str() != uri.host_str()
				|| base.port() != uri.port()
			{
				return false;
			}
			let Some(relative) = uri.path().strip_prefix(base.path()) else {
				return false;
			};
			if !relative.is_empty() && !base.path().ends_with('/') && !relative.starts_with('/') {
				return false;
			}
			return self.matcher.matches(relative.trim_start_matches('/'));
		}
		self.matcher.matches(uri.as_str())
			|| self.matcher.matches(uri.path())
			|| self.matcher.matches(uri.path().trim_start_matches('/'))
			|| uri
				.to_file_path()
				.is_ok_and(|path| self.matcher.matches_path(&path))
	}
}

/// LSP watched-file change kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum LspWatchedFileKind {
	/// File creation.
	Created = 1,
	/// File content change.
	Changed = 2,
	/// File deletion.
	Deleted = 3,
}

/// One committed filesystem change broadcast to language servers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LspWatchedFileChange {
	/// Canonical file URI.
	pub uri:  Url,
	/// Change kind.
	pub kind: LspWatchedFileKind,
}

/// Borrowed exact document input for synchronization-sensitive operations.
#[derive(Clone, Copy)]
pub struct LspDocument<'a> {
	/// Exact document snapshot to install at the server.
	pub snapshot:    &'a DocumentSnapshot,
	/// Current canonical document URI.
	pub uri:         &'a Url,
	/// LSP language id, when classified.
	pub language_id: Option<&'a LanguageId>,
}

/// A raw request outcome returned by an LSP server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LspResponseOutcome {
	/// Exact successful JSON result.
	Result(Bytes),
	/// JSON-RPC application error returned by the server.
	Error {
		/// JSON-RPC error code.
		code:    i32,
		/// Server-provided diagnostic.
		message: Str,
		/// Exact JSON error data, when present.
		data:    Option<Bytes>,
	},
}

/// A raw request outcome tagged with the exact synchronized revision, when
/// document-scoped.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LspResponse {
	/// Successful result or JSON-RPC application error.
	pub outcome:  LspResponseOutcome,
	/// Revision installed immediately before the request.
	pub revision: Option<Revision>,
}
#[derive(Debug)]
struct VersionRevision {
	uri:      Str,
	version:  i32,
	revision: Revision,
}

#[derive(Debug)]
struct TrackedDocument {
	uri:             Str,
	language:        Option<Str>,
	revision:        Revision,
	content:         Bytes,
	version:         i32,
	opened:          bool,
	generation:      u64,
	leases:          usize,
	version_history: VecDeque<VersionRevision>,
}

#[derive(Debug)]
struct ServerState {
	capabilities: LspCapabilities,
	documents:    HashMap<DocumentId, TrackedDocument>,
}

struct ServerInner {
	transport: Arc<dyn LspTransport>,
	lane:      AsyncMutex<()>,
	state:     Mutex<ServerState>,
	activity:  Mutex<ServerActivity>,
}

struct ServerActivity {
	last:    Instant,
	pending: usize,
}

/// Current request activity used by readiness and idle reaping.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LspActivity {
	/// Time since the most recent request or notification began/completed.
	pub idle_for:         Duration,
	/// Requests currently waiting for a server response.
	pub pending_requests: usize,
}

struct RequestActivity<'a> {
	server: &'a LspServer,
}

impl Drop for RequestActivity<'_> {
	fn drop(&mut self) {
		let mut activity = self.server.inner.activity.lock();
		activity.pending = activity.pending.saturating_sub(1);
		activity.last = Instant::now();
	}
}

/// Ordered LSP synchronization and raw-request coordinator.
#[derive(Clone)]
pub struct LspServer {
	inner: Arc<ServerInner>,
}

enum SyncPlan {
	Complete(i32),
	Notify { method: &'static str, params: Value, transition: SyncTransition },
}

enum SyncTransition {
	Insert { document_id: DocumentId, version: i32, opened: bool },
	Close { document_id: DocumentId, generation: u64 },
	Install { document_id: DocumentId, generation: u64, version: i32, opened: bool },
}

impl LspServer {
	/// Creates a server lane from raw initialize capabilities and a transport.
	pub fn new(
		transport: Arc<dyn LspTransport>,
		capabilities_json: Bytes,
	) -> Result<Self, LspError> {
		let capabilities = LspCapabilities::parse(capabilities_json)?;
		Ok(Self {
			inner: Arc::new(ServerInner {
				transport,
				lane: AsyncMutex::new(()),
				state: Mutex::new(ServerState { capabilities, documents: HashMap::new() }),
				activity: Mutex::new(ServerActivity { last: Instant::now(), pending: 0 }),
			}),
		})
	}

	/// Returns an owned copy of the exact initialize capability JSON.
	pub fn capabilities_json(&self) -> Bytes {
		self.inner.state.lock().capabilities.raw_json().clone()
	}

	/// Returns the current pending-request count and inactivity duration.
	pub fn activity(&self) -> LspActivity {
		let activity = self.inner.activity.lock();
		LspActivity { idle_for: activity.last.elapsed(), pending_requests: activity.pending }
	}

	fn begin_request(&self) -> RequestActivity<'_> {
		let mut activity = self.inner.activity.lock();
		activity.pending = activity.pending.saturating_add(1);
		activity.last = Instant::now();
		RequestActivity { server: self }
	}

	fn mark_activity(&self) {
		self.inner.activity.lock().last = Instant::now();
	}

	/// Resolves the current selector-scoped synchronization policy.
	pub fn sync_policy(&self, uri: &Url, language: Option<&LanguageId>) -> SyncPolicy {
		self
			.inner
			.state
			.lock()
			.capabilities
			.policy_for(uri, language.map(LanguageId::as_str))
	}

	/// Reports whether document formatting is currently advertised for a URI and
	/// language.
	pub fn supports_formatting(&self, uri: &Url, language: Option<&LanguageId>) -> bool {
		self
			.inner
			.state
			.lock()
			.capabilities
			.resolve(uri, language.map(LanguageId::as_str))
			.formatting
	}

	/// Installs registrations from `client/registerCapability` without waiting
	/// for outbound requests.
	pub fn register_capabilities(&self, params_json: Bytes) -> Result<(), LspError> {
		self.inner.state.lock().capabilities.register(&params_json)
	}

	/// Removes registrations from `client/unregisterCapability` without waiting
	/// for outbound requests.
	pub fn unregister_capabilities(&self, params_json: Bytes) -> Result<(), LspError> {
		self
			.inner
			.state
			.lock()
			.capabilities
			.unregister(&params_json)
	}

	/// Resolves a versioned inbound event to the daemon revision installed for
	/// the same URI and LSP version.
	///
	/// `None` is returned when the version was never emitted, aged out, or is
	/// ambiguous across tracked documents.
	pub fn revision_for_version(&self, uri: &Url, version: i32) -> Option<Revision> {
		let state = self.inner.state.lock();
		let mut resolved = None;
		for revision in state
			.documents
			.values()
			.flat_map(|document| document.version_history.iter())
			.filter(|entry| entry.uri.as_str() == uri.as_str() && entry.version == version)
			.map(|entry| entry.revision)
		{
			if resolved.is_some_and(|existing| existing != revision) {
				return None;
			}
			resolved = Some(revision);
		}
		resolved
	}

	/// Returns the current LSP version and daemon revision for a tracked
	/// document.
	pub fn tracked_version_revision(&self, document_id: DocumentId) -> Option<(i32, Revision)> {
		self
			.inner
			.state
			.lock()
			.documents
			.get(&document_id)
			.map(|document| (document.version, document.revision))
	}

	/// Synchronizes the server to an exact snapshot, assigning a newer LSP
	/// version when needed.
	pub async fn synchronize(
		&self,
		document: LspDocument<'_>,
		cancel: CancellationToken,
	) -> Result<i32, LspError> {
		let _lane = self.enter_lane(&cancel).await?;
		self.synchronize_in_lane(document, cancel).await
	}

	/// Adds another active lease for an already tracked document.
	pub async fn retain_document(&self, document_id: DocumentId) -> Result<(), LspError> {
		let _lane = self.inner.lane.lock().await;
		let mut state = self.inner.state.lock();
		let document = state
			.documents
			.get_mut(&document_id)
			.ok_or(LspError::DocumentNotTracked { document_id })?;
		document.leases = document
			.leases
			.checked_add(1)
			.ok_or(LspError::LeaseOverflow { document_id })?;
		document.generation = document
			.generation
			.checked_add(1)
			.ok_or(LspError::StateGenerationOverflow { document_id })?;
		Ok(())
	}

	pub(crate) async fn abandon_document_lease(&self, document_id: DocumentId) {
		let _lane = self.inner.lane.lock().await;
		let mut state = self.inner.state.lock();
		let Some(document) = state.documents.get_mut(&document_id) else {
			return;
		};
		if document.leases > 1 {
			document.leases -= 1;
			document.generation = document.generation.saturating_add(1);
		} else {
			state.documents.remove(&document_id);
		}
	}

	/// Releases one lease and sends a balancing `didClose` after the last lease.
	pub async fn release_document(
		&self,
		document_id: DocumentId,
		cancel: CancellationToken,
	) -> Result<(), LspError> {
		let _lane = self.enter_lane(&cancel).await?;
		let close = {
			let mut state = self.inner.state.lock();
			let close_advertised = {
				let document = state
					.documents
					.get(&document_id)
					.ok_or(LspError::DocumentNotTracked { document_id })?;
				tracked_policy(&state.capabilities, document)
					.is_some_and(|policy| policy.public.open_close)
			};
			let document = state
				.documents
				.get_mut(&document_id)
				.expect("checked above");
			if document.leases > 1 {
				document.leases -= 1;
				document.generation = document
					.generation
					.checked_add(1)
					.ok_or(LspError::StateGenerationOverflow { document_id })?;
				return Ok(());
			}
			if document.opened && close_advertised {
				Some((document.generation, document.uri.clone()))
			} else {
				state.documents.remove(&document_id);
				None
			}
		};
		let Some((generation, uri)) = close else {
			return Ok(());
		};
		self
			.send_notification(DID_CLOSE, json!({ "textDocument": { "uri": uri.as_str() } }), cancel)
			.await?;
		let mut state = self.inner.state.lock();
		let document = state
			.documents
			.get(&document_id)
			.ok_or(LspError::StateChanged { document_id })?;
		if document.generation != generation {
			return Err(LspError::StateChanged { document_id });
		}
		state.documents.remove(&document_id);
		Ok(())
	}

	/// Sends an advertised `willSave` after exact synchronization.
	pub async fn will_save(
		&self,
		document: LspDocument<'_>,
		reason: i32,
		cancel: CancellationToken,
	) -> Result<(), LspError> {
		let _lane = self.enter_lane(&cancel).await?;
		self
			.synchronize_in_lane(document, cancel.child_token())
			.await?;
		let policy = {
			let state = self.inner.state.lock();
			resolved_for(&state, document)
		};
		if !policy.public.will_save {
			return Err(LspError::CapabilityNotAdvertised { method: sf!(WILL_SAVE) });
		}
		self
			.send_notification(
				WILL_SAVE,
				json!({ "textDocument": { "uri": document.uri.as_str() }, "reason": reason }),
				cancel,
			)
			.await
	}

	/// Requests advertised `willSaveWaitUntil` edits and applies them exactly.
	pub async fn will_save_wait_until(
		&self,
		document: LspDocument<'_>,
		reason: i32,
		cancel: CancellationToken,
	) -> Result<Bytes, LspError> {
		let _lane = self.enter_lane(&cancel).await?;
		self
			.synchronize_in_lane(document, cancel.child_token())
			.await?;
		let policy = {
			let state = self.inner.state.lock();
			resolved_for(&state, document)
		};
		if !policy.public.will_save_wait_until {
			return Err(LspError::CapabilityNotAdvertised { method: sf!(WILL_SAVE_WAIT_UNTIL) });
		}
		let result = self
			.send_request(
				WILL_SAVE_WAIT_UNTIL,
				json!({ "textDocument": { "uri": document.uri.as_str() }, "reason": reason }),
				cancel,
			)
			.await?;
		apply_edit_result(document.snapshot.content(), result, policy.public.position_encoding)
	}

	/// Sends an advertised `didSave`, including text only when requested.
	pub async fn did_save(
		&self,
		document: LspDocument<'_>,
		cancel: CancellationToken,
	) -> Result<(), LspError> {
		let _lane = self.enter_lane(&cancel).await?;
		self
			.synchronize_in_lane(document, cancel.child_token())
			.await?;
		let policy = {
			let state = self.inner.state.lock();
			resolved_for(&state, document)
		};
		if !policy.public.save {
			return Err(LspError::CapabilityNotAdvertised { method: sf!(DID_SAVE) });
		}
		let mut params = json!({ "textDocument": { "uri": document.uri.as_str() } });
		if policy.public.save_include_text {
			params["text"] = Value::String(document_text(document.snapshot)?.to_owned());
		}
		self.send_notification(DID_SAVE, params, cancel).await
	}

	/// Synchronizes provisional text, formats it, and returns the exact
	/// formatted bytes.
	pub async fn format_document(
		&self,
		document: LspDocument<'_>,
		options_json: Bytes,
		cancel: CancellationToken,
	) -> Result<Bytes, LspError> {
		let options: Value = serde_json::from_slice(&options_json).map_err(invalid_json)?;
		if !options.is_object() {
			return Err(LspError::InvalidJson { reason: sf!("formatting options must be an object") });
		}
		let _lane = self.enter_lane(&cancel).await?;
		self
			.synchronize_in_lane(document, cancel.child_token())
			.await?;
		let policy = {
			let state = self.inner.state.lock();
			resolved_for(&state, document)
		};
		if !policy.formatting {
			return Err(LspError::CapabilityNotAdvertised { method: sf!(FORMATTING) });
		}
		let result = self
			.send_request(
				FORMATTING,
				json!({ "textDocument": { "uri": document.uri.as_str() }, "options": options }),
				cancel,
			)
			.await?;
		apply_edit_result(document.snapshot.content(), result, policy.public.position_encoding)
	}

	/// Broadcasts committed workspace file changes after document
	/// synchronization and save notifications.
	pub async fn did_change_watched_files(
		&self,
		changes: &[LspWatchedFileChange],
		cancel: CancellationToken,
	) -> Result<(), LspError> {
		let changes = changes
			.iter()
			.map(|change| {
				json!({
					"uri": change.uri.as_str(),
					"type": change.kind as u8,
				})
			})
			.collect::<Vec<_>>();
		self
			.notification(
				"workspace/didChangeWatchedFiles",
				encode_json(&json!({ "changes": changes }))?,
				cancel,
			)
			.await
	}

	/// Sends an arbitrary request after exact document synchronization when
	/// provided.
	#[tracing::instrument(
		name = "lsp_request",
		level = "debug",
		skip_all,
		fields(method = %method)
	)]
	pub async fn request(
		&self,
		method: &str,
		params_json: Bytes,
		document: Option<LspDocument<'_>>,
		cancel: CancellationToken,
	) -> Result<LspResponse, LspError> {
		if is_lifecycle_method(method) {
			return Err(LspError::LifecyclePassthrough { method: Str::new(method) });
		}
		ensure_json(&params_json)?;
		let _lane = self.enter_lane(&cancel).await?;
		let revision = if let Some(document) = document {
			self
				.synchronize_in_lane(document, cancel.child_token())
				.await?;
			Some(document.snapshot.head().revision())
		} else {
			None
		};
		if cancel.is_cancelled() {
			return Err(LspTransportError::Cancelled.into());
		}
		let _activity = self.begin_request();
		let outcome = match self
			.inner
			.transport
			.request(method, params_json, cancel)
			.await
		{
			Ok(result_json) => {
				ensure_json(&result_json).map_err(|error| match error {
					LspError::InvalidJson { reason } => {
						LspError::Transport(LspTransportError::InvalidResponse { message: reason })
					},
					other => other,
				})?;
				LspResponseOutcome::Result(result_json)
			},
			Err(LspTransportError::JsonRpc { code, message, data }) => {
				LspResponseOutcome::Error { code, message, data }
			},
			Err(error) => return Err(error.into()),
		};
		Ok(LspResponse { outcome, revision })
	}

	/// Enqueues a non-lifecycle notification in the same ordered lane.
	pub async fn notification(
		&self,
		method: &str,
		params_json: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspError> {
		if is_lifecycle_method(method) {
			return Err(LspError::LifecyclePassthrough { method: Str::new(method) });
		}
		ensure_json(&params_json)?;
		let _lane = self.enter_lane(&cancel).await?;
		if cancel.is_cancelled() {
			return Err(LspTransportError::Cancelled.into());
		}
		self.mark_activity();
		self
			.inner
			.transport
			.notify(method, params_json, cancel)
			.await?;
		self.mark_activity();
		Ok(())
	}

	async fn enter_lane<'a>(
		&'a self,
		cancel: &CancellationToken,
	) -> Result<AsyncMutexGuard<'a, ()>, LspError> {
		tokio::select! {
			guard = self.inner.lane.lock() => Ok(guard),
			() = cancel.cancelled() => Err(LspTransportError::Cancelled.into()),
		}
	}

	async fn synchronize_in_lane(
		&self,
		document: LspDocument<'_>,
		cancel: CancellationToken,
	) -> Result<i32, LspError> {
		loop {
			let plan = {
				let mut state = self.inner.state.lock();
				Self::plan_synchronization(&mut state, document)?
			};
			match plan {
				SyncPlan::Complete(version) => return Ok(version),
				SyncPlan::Notify { method, params, transition } => {
					if cancel.is_cancelled() {
						return Err(LspTransportError::Cancelled.into());
					}
					self
						.send_notification(method, params, cancel.child_token())
						.await?;
					let mut state = self.inner.state.lock();
					Self::apply_transition(&mut state, transition, document)?;
				},
			}
		}
	}

	fn plan_synchronization(
		state: &mut ServerState,
		document: LspDocument<'_>,
	) -> Result<SyncPlan, LspError> {
		let text = document_text(document.snapshot)?;
		let document_id = document.snapshot.head().document_id();
		let revision = document.snapshot.head().revision();
		let uri = document.uri.as_str();
		let language = document_language(document);
		loop {
			let policy = state.capabilities.resolve(document.uri, language);
			if !state.documents.contains_key(&document_id) {
				if policy.public.change == TextDocumentSyncKind::None && !policy.public.open_close {
					return Err(LspError::SynchronizationUnavailable { document_id, revision });
				}
				let (method, params, opened) = if policy.public.open_close {
					(
						DID_OPEN,
						json!({ "textDocument": {
							"uri": uri,
							"languageId": language.unwrap_or(""),
							"version": 1,
							"text": text
						} }),
						true,
					)
				} else {
					(DID_CHANGE, initial_change_params(uri, 1, text, policy.public.change)?, false)
				};
				return Ok(SyncPlan::Notify {
					method,
					params,
					transition: SyncTransition::Insert { document_id, version: 1, opened },
				});
			}

			{
				let tracked = state.documents.get(&document_id).expect("checked above");
				if tracked.uri.as_str() == uri && tracked.language.as_deref() != language {
					return Err(LspError::LanguageChanged {
						document_id,
						tracked: tracked.language.clone(),
						requested: language.map(Str::new),
					});
				}
			}

			let old_open_close = {
				let tracked = state.documents.get(&document_id).expect("checked above");
				tracked_policy(&state.capabilities, tracked)
					.is_some_and(|policy| policy.public.open_close)
			};
			let tracked = state
				.documents
				.get_mut(&document_id)
				.expect("checked above");
			if tracked.uri.as_str() != uri {
				if tracked.opened {
					if old_open_close {
						return Ok(SyncPlan::Notify {
							method:     DID_CLOSE,
							params:     json!({ "textDocument": { "uri": tracked.uri.as_str() } }),
							transition: SyncTransition::Close {
								document_id,
								generation: tracked.generation,
							},
						});
					}
					tracked.opened = false;
					tracked.generation = tracked
						.generation
						.checked_add(1)
						.ok_or(LspError::StateGenerationOverflow { document_id })?;
					continue;
				}
				let version = match tracked.version.checked_add(1) {
					Some(version) => version,
					None if policy.public.open_close => 1,
					None => return Err(LspError::VersionOverflow { document_id }),
				};
				let (method, params, opened) = if policy.public.open_close {
					(
						DID_OPEN,
						json!({ "textDocument": {
							"uri": uri,
							"languageId": language.unwrap_or(""),
							"version": version,
							"text": text
						} }),
						true,
					)
				} else if policy.public.change != TextDocumentSyncKind::None {
					(DID_CHANGE, initial_change_params(uri, version, text, policy.public.change)?, false)
				} else {
					return Err(LspError::SynchronizationUnavailable { document_id, revision });
				};
				return Ok(SyncPlan::Notify {
					method,
					params,
					transition: SyncTransition::Install {
						document_id,
						generation: tracked.generation,
						version,
						opened,
					},
				});
			}

			if tracked.opened && !policy.public.open_close {
				if old_open_close {
					return Ok(SyncPlan::Notify {
						method:     DID_CLOSE,
						params:     json!({ "textDocument": { "uri": uri } }),
						transition: SyncTransition::Close { document_id, generation: tracked.generation },
					});
				}
				tracked.opened = false;
				tracked.generation = tracked
					.generation
					.checked_add(1)
					.ok_or(LspError::StateGenerationOverflow { document_id })?;
				continue;
			}
			if !tracked.opened && policy.public.open_close {
				let version = tracked.version.checked_add(1).unwrap_or(1);
				return Ok(SyncPlan::Notify {
					method:     DID_OPEN,
					params:     json!({ "textDocument": {
						"uri": uri,
						"languageId": language.unwrap_or(""),
						"version": version,
						"text": text
					} }),
					transition: SyncTransition::Install {
						document_id,
						generation: tracked.generation,
						version,
						opened: true,
					},
				});
			}
			if tracked.content.as_ref() == document.snapshot.content().as_ref() {
				if tracked.revision != revision || tracked.language.as_deref() != language {
					tracked.revision = revision;
					tracked.language = language.map(Str::new);
					record_version_revision(tracked, uri, tracked.version, revision);
					tracked.generation = tracked
						.generation
						.checked_add(1)
						.ok_or(LspError::StateGenerationOverflow { document_id })?;
				}
				return Ok(SyncPlan::Complete(tracked.version));
			}
			if policy.public.change == TextDocumentSyncKind::None {
				return Err(LspError::SynchronizationUnavailable { document_id, revision });
			}
			let Some(version) = tracked.version.checked_add(1) else {
				if policy.public.open_close && tracked.opened {
					return Ok(SyncPlan::Notify {
						method:     DID_CLOSE,
						params:     json!({ "textDocument": { "uri": uri } }),
						transition: SyncTransition::Close { document_id, generation: tracked.generation },
					});
				}
				return Err(LspError::VersionOverflow { document_id });
			};
			return Ok(SyncPlan::Notify {
				method:     DID_CHANGE,
				params:     change_params(
					uri,
					version,
					&tracked.content,
					document.snapshot.content(),
					policy.public,
				)?,
				transition: SyncTransition::Install {
					document_id,
					generation: tracked.generation,
					version,
					opened: tracked.opened,
				},
			});
		}
	}

	fn apply_transition(
		state: &mut ServerState,
		transition: SyncTransition,
		document: LspDocument<'_>,
	) -> Result<(), LspError> {
		match transition {
			SyncTransition::Insert { document_id, version, opened } => {
				if state.documents.contains_key(&document_id) {
					return Err(LspError::StateChanged { document_id });
				}
				state.documents.insert(document_id, TrackedDocument {
					uri: Str::new(document.uri.as_str()),
					language: document_language(document).map(Str::new),
					revision: document.snapshot.head().revision(),
					content: document.snapshot.content().clone(),
					version,
					opened,
					generation: 0,
					leases: 1,
					version_history: VecDeque::from([VersionRevision {
						uri: Str::new(document.uri.as_str()),
						version,
						revision: document.snapshot.head().revision(),
					}]),
				});
			},
			SyncTransition::Close { document_id, generation } => {
				let tracked = checked_document_mut(state, document_id, generation)?;
				tracked.opened = false;
				tracked.generation = tracked
					.generation
					.checked_add(1)
					.ok_or(LspError::StateGenerationOverflow { document_id })?;
			},
			SyncTransition::Install { document_id, generation, version, opened } => {
				let tracked = checked_document_mut(state, document_id, generation)?;
				install_tracked(tracked, document, version);
				tracked.opened = opened;
				tracked.generation = tracked
					.generation
					.checked_add(1)
					.ok_or(LspError::StateGenerationOverflow { document_id })?;
			},
		}
		Ok(())
	}

	async fn send_notification(
		&self,
		method: &str,
		params: Value,
		cancel: CancellationToken,
	) -> Result<(), LspError> {
		if cancel.is_cancelled() {
			return Err(LspTransportError::Cancelled.into());
		}
		self.mark_activity();
		self
			.inner
			.transport
			.notify(method, encode_json(&params)?, cancel)
			.await?;
		self.mark_activity();
		Ok(())
	}

	async fn send_request(
		&self,
		method: &str,
		params: Value,
		cancel: CancellationToken,
	) -> Result<Bytes, LspError> {
		if cancel.is_cancelled() {
			return Err(LspTransportError::Cancelled.into());
		}
		let _activity = self.begin_request();
		let result = self
			.inner
			.transport
			.request(method, encode_json(&params)?, cancel)
			.await?;
		ensure_json(&result)?;
		Ok(result)
	}
}

fn install_tracked(tracked: &mut TrackedDocument, document: LspDocument<'_>, version: i32) {
	tracked.uri = Str::new(document.uri.as_str());
	tracked.language = document_language(document).map(Str::new);
	tracked.revision = document.snapshot.head().revision();
	tracked.content = document.snapshot.content().clone();
	tracked.version = version;
	record_version_revision(
		tracked,
		document.uri.as_str(),
		version,
		document.snapshot.head().revision(),
	);
}

fn record_version_revision(
	tracked: &mut TrackedDocument,
	uri: &str,
	version: i32,
	revision: Revision,
) {
	if let Some(last) = tracked.version_history.back_mut()
		&& last.uri.as_str() == uri
		&& last.version == version
	{
		last.revision = revision;
		return;
	}
	if tracked.version_history.len() == VERSION_HISTORY_LIMIT {
		tracked.version_history.pop_front();
	}
	tracked
		.version_history
		.push_back(VersionRevision { uri: Str::new(uri), version, revision });
}

fn checked_document_mut(
	state: &mut ServerState,
	document_id: DocumentId,
	generation: u64,
) -> Result<&mut TrackedDocument, LspError> {
	let tracked = state
		.documents
		.get_mut(&document_id)
		.ok_or(LspError::StateChanged { document_id })?;
	if tracked.generation != generation {
		return Err(LspError::StateChanged { document_id });
	}
	Ok(tracked)
}

fn initial_change_params(
	uri: &str,
	version: i32,
	text: &str,
	kind: TextDocumentSyncKind,
) -> Result<Value, LspError> {
	let changes = match kind {
		TextDocumentSyncKind::Full => json!([{ "text": text }]),
		TextDocumentSyncKind::Incremental => json!([{
			"range": {
				"start": { "line": 0, "character": 0 },
				"end": { "line": 0, "character": 0 }
			},
			"text": text
		}]),
		TextDocumentSyncKind::None => {
			return Err(LspError::CapabilityNotAdvertised { method: sf!(DID_CHANGE) });
		},
	};
	Ok(json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": changes }))
}

fn change_params(
	uri: &str,
	version: i32,
	old: &Bytes,
	new: &Bytes,
	policy: SyncPolicy,
) -> Result<Value, LspError> {
	let changes = match policy.change {
		TextDocumentSyncKind::Full => json!([{ "text": bytes_text(new)? }]),
		TextDocumentSyncKind::Incremental => {
			let old = bytes_text(old)?;
			let new = bytes_text(new)?;
			let (start, old_end, new_end) = changed_span(old, new);
			let range = Range {
				start: offset_to_position(policy.position_encoding, old, start)?,
				end:   offset_to_position(policy.position_encoding, old, old_end)?,
			};
			json!([{ "range": range, "text": &new[start..new_end] }])
		},
		TextDocumentSyncKind::None => {
			return Err(LspError::CapabilityNotAdvertised { method: sf!(DID_CHANGE) });
		},
	};
	Ok(json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": changes }))
}

fn resolved_for(state: &ServerState, document: LspDocument<'_>) -> ResolvedPolicy {
	state
		.capabilities
		.resolve(document.uri, document_language(document))
}

fn tracked_policy(
	capabilities: &LspCapabilities,
	document: &TrackedDocument,
) -> Option<ResolvedPolicy> {
	let uri = Url::parse(document.uri.as_str()).ok()?;
	Some(capabilities.resolve(&uri, document.language.as_deref()))
}

fn document_language(document: LspDocument<'_>) -> Option<&str> {
	if let Some(language) = document.language_id {
		return Some(language.as_str());
	}
	match document.snapshot.head().kind() {
		DocumentKind::Text(Some(language)) => Some(language.as_str()),
		DocumentKind::Text(None) | DocumentKind::Binary => None,
	}
}

fn document_text(snapshot: &DocumentSnapshot) -> Result<&str, LspError> {
	if !matches!(snapshot.head().kind(), DocumentKind::Text(_)) {
		return Err(LspError::NonTextDocument { document_id: snapshot.head().document_id() });
	}
	bytes_text(snapshot.content())
}

fn bytes_text(content: &Bytes) -> Result<&str, LspError> {
	str::from_utf8(content).map_err(|_| LspError::InvalidUtf8)
}

fn changed_span(old: &str, new: &str) -> (usize, usize, usize) {
	let max_prefix = old.len().min(new.len());
	let mut prefix = old
		.as_bytes()
		.iter()
		.zip(new.as_bytes())
		.take_while(|(left, right)| left == right)
		.count();
	while prefix > 0 && (!old.is_char_boundary(prefix) || !new.is_char_boundary(prefix)) {
		prefix -= 1;
	}
	while crlf_is_bisected(old, prefix) || crlf_is_bisected(new, prefix) {
		prefix -= 1;
	}
	let max_suffix = old.len().min(new.len()) - prefix;
	let mut suffix = old.as_bytes()[old.len() - max_suffix..]
		.iter()
		.rev()
		.zip(new.as_bytes()[new.len() - max_suffix..].iter().rev())
		.take_while(|(left, right)| left == right)
		.count();
	while suffix > 0
		&& (!old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix))
	{
		suffix -= 1;
	}
	while suffix > 0
		&& (crlf_is_bisected(old, old.len() - suffix) || crlf_is_bisected(new, new.len() - suffix))
	{
		suffix -= 1;
	}
	debug_assert!(prefix <= max_prefix);
	(prefix, old.len() - suffix, new.len() - suffix)
}

const fn crlf_is_bisected(text: &str, offset: usize) -> bool {
	offset > 0
		&& offset < text.len()
		&& text.as_bytes()[offset - 1] == b'\r'
		&& text.as_bytes()[offset] == b'\n'
}

fn apply_edit_result(
	content: &Bytes,
	result: Bytes,
	encoding: PositionEncoding,
) -> Result<Bytes, LspError> {
	let value: Value = serde_json::from_slice(&result).map_err(invalid_json)?;
	if value.is_null() {
		return Ok(content.clone());
	}
	let edits: Vec<TextEdit> = serde_json::from_value(value).map_err(invalid_json)?;
	Ok(apply_text_edits(bytes_text(content)?, &edits, encoding)?)
}

fn encode_json(value: &Value) -> Result<Bytes, LspError> {
	serde_json::to_vec(value)
		.map(Bytes::from)
		.map_err(invalid_json)
}

fn ensure_json(bytes: &[u8]) -> Result<(), LspError> {
	serde_json::from_slice::<Value>(bytes)
		.map(|_| ())
		.map_err(invalid_json)
}

fn invalid_json(error: serde_json::Error) -> LspError {
	LspError::InvalidJson { reason: Str::new(error.to_string()) }
}

fn is_lifecycle_method(method: &str) -> bool {
	matches!(
		method,
		"initialize"
			| "initialized"
			| "shutdown"
			| "exit"
			| DID_OPEN
			| DID_CHANGE
			| DID_SAVE
			| DID_CLOSE
			| WILL_SAVE
			| WILL_SAVE_WAIT_UNTIL
	)
}

/// A synchronization, capability, or LSP operation failure.
#[derive(Debug, Error)]
pub enum LspError {
	/// The raw transport failed.
	#[error(transparent)]
	Transport(#[from] LspTransportError),
	/// Initialize capabilities were not a usable object.
	#[error("invalid LSP capabilities: {reason}")]
	InvalidCapabilities {
		/// Validation diagnostic.
		reason: Str,
	},
	/// A dynamic registration was malformed or inconsistent.
	#[error("invalid LSP dynamic registration: {reason}")]
	InvalidRegistration {
		/// Validation diagnostic.
		reason: Str,
	},
	/// Raw JSON could not be parsed or encoded.
	#[error("invalid LSP JSON: {reason}")]
	InvalidJson {
		/// JSON diagnostic.
		reason: Str,
	},
	/// Position conversion or edit application failed.
	#[error(transparent)]
	Position(#[from] PositionError),
	/// The document is not UTF-8 text.
	#[error("document {document_id} is not a text document")]
	NonTextDocument {
		/// Document identity.
		document_id: DocumentId,
	},
	/// Text bytes unexpectedly failed UTF-8 validation.
	#[error("document content is not valid UTF-8")]
	InvalidUtf8,
	/// No advertised lifecycle can install the exact revision.
	#[error("LSP cannot synchronize document {document_id} to revision {revision}")]
	SynchronizationUnavailable {
		/// Document identity.
		document_id: DocumentId,
		/// Required exact revision.
		revision:    Revision,
	},
	/// A lifecycle method was rejected from arbitrary passthrough.
	#[error("LSP lifecycle method {method} cannot be passed through")]
	LifecyclePassthrough {
		/// Rejected method.
		method: Str,
	},
	/// A tracked URI was synchronized with a conflicting language
	/// classification.
	#[error(
		"document {document_id} language changed from {tracked:?} to {requested:?} without a URI \
		 change"
	)]
	LanguageChanged {
		/// Document identity.
		document_id: DocumentId,
		/// Language classification previously installed in the shared server.
		tracked:     Option<Str>,
		/// Conflicting language classification requested by this synchronization.
		requested:   Option<Str>,
	},
	/// An operation required a capability the server did not advertise.
	#[error("LSP server did not advertise {method}")]
	CapabilityNotAdvertised {
		/// Required method.
		method: Str,
	},
	/// The requested document has no state in this server lane.
	#[error("document {document_id} is not tracked by this LSP server")]
	DocumentNotTracked {
		/// Document identity.
		document_id: DocumentId,
	},
	/// A document lease count cannot be represented.
	#[error("document {document_id} has too many LSP leases")]
	LeaseOverflow {
		/// Document identity.
		document_id: DocumentId,
	},
	/// State changed between an outbound action and its acknowledgement.
	#[error("LSP state changed while synchronizing document {document_id}")]
	StateChanged {
		/// Document identity.
		document_id: DocumentId,
	},
	/// An internal action generation cannot be represented.
	#[error("LSP state generation overflow for document {document_id}")]
	StateGenerationOverflow {
		/// Document identity.
		document_id: DocumentId,
	},
	/// The daemon-owned LSP version overflowed without an advertised reset
	/// lifecycle.
	#[error("LSP version overflow for document {document_id}")]
	VersionOverflow {
		/// Document identity.
		document_id: DocumentId,
	},
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicBool, Ordering};

	use tokio::{sync::Notify, time};

	use super::*;
	use crate::docserver::{DocumentHead, DocumentPresence};

	#[derive(Default)]
	struct RecordingTransport {
		messages:   Mutex<Vec<(Str, Str, Bytes)>>,
		responses:  Mutex<HashMap<Str, Bytes>>,
		block_next: AtomicBool,
		started:    Notify,
		release:    Notify,
	}

	#[async_trait]
	impl LspTransport for RecordingTransport {
		async fn request(
			&self,
			method: &str,
			params: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			self
				.messages
				.lock()
				.push((sf!("request"), Str::new(method), params));
			if self.block_next.swap(false, Ordering::SeqCst) {
				self.started.notify_one();
				self.release.notified().await;
			}
			Ok(self
				.responses
				.lock()
				.get(method)
				.cloned()
				.unwrap_or_else(|| Bytes::from_static(b"null")))
		}

		async fn notify(
			&self,
			method: &str,
			params: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			self
				.messages
				.lock()
				.push((sf!("notify"), Str::new(method), params));
			if self.block_next.swap(false, Ordering::SeqCst) {
				self.started.notify_one();
				self.release.notified().await;
			}
			Ok(())
		}
	}

	struct ErrorTransport;

	#[async_trait]
	impl LspTransport for ErrorTransport {
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Err(LspTransportError::JsonRpc {
				code:    -32_601,
				message: sf!("application failure"),
				data:    Some(Bytes::from_static(br#"{"retry":false}"#)),
			})
		}

		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			Ok(())
		}
	}

	struct CancelAfterNotify {
		cancel: CancellationToken,
	}

	#[async_trait]
	impl LspTransport for CancelAfterNotify {
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Ok(Bytes::from_static(b"null"))
		}

		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			self.cancel.cancel();
			Ok(())
		}
	}

	fn snapshot(sequence: u64, text: &'static str) -> DocumentSnapshot {
		let content = Bytes::from_static(text.as_bytes());
		let revision = Revision::for_content(sequence, &content);
		let head = DocumentHead::new(
			DocumentId::from_bytes([7; 16]),
			revision,
			DocumentPresence::Present,
			DocumentKind::Text(None),
			content.len() as u64,
		)
		.unwrap();
		DocumentSnapshot::new(head, content).unwrap()
	}

	#[test]
	fn parses_omitted_numeric_and_object_sync() {
		let omitted = LspCapabilities::parse(Bytes::from_static(b"{}")).unwrap();
		assert_eq!(omitted.base, SyncPolicy::default());
		let numeric =
			LspCapabilities::parse(Bytes::from_static(br#"{"textDocumentSync":2}"#)).unwrap();
		assert_eq!(numeric.base.change, TextDocumentSyncKind::Incremental);
		assert!(numeric.base.open_close && !numeric.base.save && !numeric.base.save_include_text);
		let object = LspCapabilities::parse(Bytes::from_static(
			br#"{"positionEncoding":"utf-8","textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":true},"willSave":true,"willSaveWaitUntil":true}}"#,
		)).unwrap();
		assert_eq!(object.base.change, TextDocumentSyncKind::Full);
		assert!(object.base.open_close && object.base.save && object.base.save_include_text);
		assert_eq!(object.base.position_encoding, PositionEncoding::Utf8);
	}

	#[tokio::test]
	async fn numeric_sync_does_not_advertise_or_emit_did_save() {
		let transport = Arc::new(RecordingTransport::default());
		let server =
			LspServer::new(transport.clone(), Bytes::from_static(br#"{"textDocumentSync":1}"#))
				.unwrap();
		let uri = Url::parse("file:///work/numeric.txt").unwrap();
		let saved = snapshot(1, "saved");
		let document = LspDocument { snapshot: &saved, uri: &uri, language_id: None };
		server
			.synchronize(document, CancellationToken::new())
			.await
			.unwrap();

		assert!(matches!(
			server.did_save(document, CancellationToken::new()).await,
			Err(LspError::CapabilityNotAdvertised { ref method }) if method == DID_SAVE
		));
		assert!(
			transport
				.messages
				.lock()
				.iter()
				.all(|(_, method, _)| method.as_str() != DID_SAVE)
		);
	}

	#[tokio::test]
	async fn cancellation_after_completed_transition_returns_the_installed_version() {
		let cancellation = CancellationToken::new();
		let server = LspServer::new(
			Arc::new(CancelAfterNotify { cancel: cancellation.clone() }),
			Bytes::from_static(br#"{"textDocumentSync":1}"#),
		)
		.unwrap();
		let uri = Url::parse("file:///work/cancelled-after-open.txt").unwrap();
		let first = snapshot(1, "installed");

		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &first, uri: &uri, language_id: None },
					cancellation.clone(),
				)
				.await
				.unwrap(),
			1
		);
		assert!(cancellation.is_cancelled());
		assert_eq!(
			server.tracked_version_revision(first.head().document_id()),
			Some((1, first.head().revision()))
		);
	}

	#[test]
	fn incremental_ranges_never_bisect_changed_crlf_delimiters() {
		let policy =
			SyncPolicy { change: TextDocumentSyncKind::Incremental, ..SyncPolicy::default() };
		let cases = [
			("a\r\nb", "a\nb", "\n", json!({ "line": 1, "character": 0 })),
			("a\nb", "a\r\nb", "\r\n", json!({ "line": 1, "character": 0 })),
			("a\r\nb", "a\rXb", "\rX", json!({ "line": 1, "character": 0 })),
			("a\rXb", "a\r\nb", "\r\n", json!({ "line": 1, "character": 1 })),
		];
		for (old, new, expected_text, expected_end) in cases {
			let params = change_params(
				"file:///work/crlf.txt",
				2,
				&Bytes::copy_from_slice(old.as_bytes()),
				&Bytes::copy_from_slice(new.as_bytes()),
				policy,
			)
			.unwrap();
			let change = &params["contentChanges"][0];
			assert_eq!(change["range"]["start"], json!({ "line": 0, "character": 1 }));
			assert_eq!(change["range"]["end"], expected_end);
			assert_eq!(change["text"].as_str(), Some(expected_text));
		}
	}

	#[tokio::test]
	async fn json_rpc_errors_retain_the_synchronized_revision() {
		let server =
			LspServer::new(Arc::new(ErrorTransport), Bytes::from_static(br#"{"textDocumentSync":1}"#))
				.unwrap();
		let snapshot = snapshot(3, "current");
		let uri = Url::parse("file:///work/current.txt").unwrap();
		let response = server
			.request(
				"textDocument/hover",
				Bytes::from_static(b"{}"),
				Some(LspDocument { snapshot: &snapshot, uri: &uri, language_id: None }),
				CancellationToken::new(),
			)
			.await
			.expect("JSON-RPC application error is a response");
		assert_eq!(response.revision, Some(snapshot.head().revision()));
		assert!(matches!(
			&response.outcome,
			LspResponseOutcome::Error {
				code: -32_601,
				message,
				data: Some(data),
			} if message == "application failure" && data.as_ref() == br#"{"retry":false}"#
		));
	}

	#[tokio::test]
	async fn selectors_and_unregistration_are_independent() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(transport, Bytes::from_static(b"{}")).unwrap();
		server.register_capabilities(Bytes::from_static(br#"{"registrations":[{"id":"rust","method":"textDocument/didChange","registerOptions":{"documentSelector":[{"language":"rust","pattern":"**/*.rs"}],"syncKind":2}},{"id":"py","method":"textDocument/didChange","registerOptions":{"documentSelector":[{"language":"python"}],"syncKind":1}}]}"#)).unwrap();
		let rust = LanguageId::new("rust").unwrap();
		let python = LanguageId::new("python").unwrap();
		let rust_uri = Url::parse("file:///work/main.rs").unwrap();
		let py_uri = Url::parse("file:///work/main.py").unwrap();
		assert_eq!(
			server.sync_policy(&rust_uri, Some(&rust)).change,
			TextDocumentSyncKind::Incremental
		);
		assert_eq!(server.sync_policy(&py_uri, Some(&python)).change, TextDocumentSyncKind::Full);
		server
			.unregister_capabilities(Bytes::from_static(
				br#"{"unregistrations":[{"id":"rust","method":"textDocument/didChange"}]}"#,
			))
			.unwrap();
		assert_eq!(server.sync_policy(&rust_uri, Some(&rust)).change, TextDocumentSyncKind::None);
		assert_eq!(server.sync_policy(&py_uri, Some(&python)).change, TextDocumentSyncKind::Full);
	}

	#[tokio::test]
	async fn dynamic_registration_does_not_wait_for_a_pending_transport_request() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(transport.clone(), Bytes::from_static(b"{}")).unwrap();
		transport.block_next.store(true, Ordering::SeqCst);
		let request_server = server.clone();
		let pending = tokio::spawn(async move {
			request_server
				.request("workspace/symbol", Bytes::from_static(b"{}"), None, CancellationToken::new())
				.await
		});
		transport.started.notified().await;

		time::timeout(Duration::from_secs(1), async {
			server.register_capabilities(Bytes::from_static(br#"{"registrations":[{"id":"during","method":"textDocument/didChange","registerOptions":{"documentSelector":null,"syncKind":2}}]}"#)).unwrap();
			server.unregister_capabilities(Bytes::from_static(br#"{"unregistrations":[{"id":"during","method":"textDocument/didChange"}]}"#)).unwrap();
			server.register_capabilities(Bytes::from_static(br#"{"registrations":[{"id":"after","method":"textDocument/didChange","registerOptions":{"documentSelector":null,"syncKind":1}}]}"#)).unwrap();
		}).await.unwrap();

		transport.release.notify_one();
		pending.await.unwrap().unwrap();
		let uri = Url::parse("file:///work/pending.txt").unwrap();
		assert_eq!(server.sync_policy(&uri, None).change, TextDocumentSyncKind::Full);
	}

	#[tokio::test]
	async fn cancelled_lane_wait_does_not_wait_for_the_active_request() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		let uri = Arc::new(Url::parse("file:///work/pending.txt").unwrap());
		let first = Arc::new(snapshot(1, "first"));
		transport.block_next.store(true, Ordering::SeqCst);
		let pending_server = server.clone();
		let pending_uri = Arc::clone(&uri);
		let pending_snapshot = Arc::clone(&first);
		let pending = tokio::spawn(async move {
			pending_server
				.synchronize(
					LspDocument {
						snapshot:    pending_snapshot.as_ref(),
						uri:         pending_uri.as_ref(),
						language_id: None,
					},
					CancellationToken::new(),
				)
				.await
		});
		transport.started.notified().await;

		let cancellation = CancellationToken::new();
		cancellation.cancel();
		let result = time::timeout(
			Duration::from_secs(1),
			server.synchronize(
				LspDocument { snapshot: &first, uri: &uri, language_id: None },
				cancellation,
			),
		)
		.await
		.expect("cancelled lane admission returns promptly");
		assert!(matches!(result, Err(LspError::Transport(LspTransportError::Cancelled))));

		transport.release.notify_one();
		pending.await.unwrap().unwrap();
	}

	#[tokio::test]
	async fn stale_sync_completion_cannot_overwrite_a_newer_document_generation() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		let old_uri = Arc::new(Url::parse("file:///work/old.txt").unwrap());
		let first = Arc::new(snapshot(1, "first"));
		server
			.synchronize(
				LspDocument {
					snapshot:    first.as_ref(),
					uri:         old_uri.as_ref(),
					language_id: None,
				},
				CancellationToken::new(),
			)
			.await
			.unwrap();

		transport.block_next.store(true, Ordering::SeqCst);
		let second = Arc::new(snapshot(2, "second"));
		let sync_server = server.clone();
		let sync_uri = Arc::clone(&old_uri);
		let sync_snapshot = Arc::clone(&second);
		let pending = tokio::spawn(async move {
			sync_server
				.synchronize(
					LspDocument {
						snapshot:    sync_snapshot.as_ref(),
						uri:         sync_uri.as_ref(),
						language_id: None,
					},
					CancellationToken::new(),
				)
				.await
		});
		transport.started.notified().await;

		let newer_uri = Url::parse("file:///work/newer.txt").unwrap();
		let newer = snapshot(3, "newer");
		{
			let mut state = server.inner.state.lock();
			let tracked = state
				.documents
				.get_mut(&first.head().document_id())
				.unwrap();
			tracked.uri = Str::new(newer_uri.as_str());
			tracked.revision = newer.head().revision();
			tracked.content = newer.content().clone();
			tracked.version = 77;
			tracked.generation += 1;
		}
		transport.release.notify_one();

		assert!(matches!(pending.await.unwrap(), Err(LspError::StateChanged { .. })));
		let state = server.inner.state.lock();
		let tracked = state.documents.get(&first.head().document_id()).unwrap();
		assert_eq!(tracked.uri.as_str(), newer_uri.as_str());
		assert_eq!(tracked.revision, newer.head().revision());
		assert_eq!(tracked.content.as_ref(), newer.content().as_ref());
		assert_eq!(tracked.version, 77);
	}

	#[tokio::test]
	async fn versions_advance_for_stale_resynchronization() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		let uri = Url::parse("file:///work/a.txt").unwrap();
		let first = snapshot(1, "old");
		let second = snapshot(2, "new");
		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &first, uri: &uri, language_id: None },
					CancellationToken::new()
				)
				.await
				.unwrap(),
			1
		);
		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &second, uri: &uri, language_id: None },
					CancellationToken::new()
				)
				.await
				.unwrap(),
			2
		);
		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &first, uri: &uri, language_id: None },
					CancellationToken::new()
				)
				.await
				.unwrap(),
			3
		);
		let messages = transport.messages.lock();
		let versions: Vec<i64> = messages
			.iter()
			.filter(|(_, method, _)| method.as_str() == DID_CHANGE)
			.map(|(_, _, params)| {
				serde_json::from_slice::<Value>(params).unwrap()["textDocument"]["version"]
					.as_i64()
					.unwrap()
			})
			.collect();
		assert_eq!(versions, vec![2, 3]);
	}

	#[tokio::test]
	async fn formatting_uses_encoding_and_can_be_rolled_back() {
		let transport = Arc::new(RecordingTransport::default());
		transport.responses.lock().insert(
			sf!(FORMATTING),
			Bytes::from_static(br#"[{"range":{"start":{"line":0,"character":1},"end":{"line":0,"character":3}},"newText":"!"}]"#),
		);
		let server = LspServer::new(transport.clone(), Bytes::from_static(br#"{"positionEncoding":"utf-16","documentFormattingProvider":true,"textDocumentSync":{"openClose":true,"change":2}}"#)).unwrap();
		let uri = Url::parse("file:///work/a.txt").unwrap();
		let committed = snapshot(1, "a😀z");
		let provisional = snapshot(2, "a😀x");
		let formatted = server
			.format_document(
				LspDocument { snapshot: &provisional, uri: &uri, language_id: None },
				Bytes::from_static(br#"{"tabSize":4,"insertSpaces":true}"#),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		assert_eq!(formatted, Bytes::from_static(b"a!x"));
		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &committed, uri: &uri, language_id: None },
					CancellationToken::new()
				)
				.await
				.unwrap(),
			2
		);
	}

	#[tokio::test]
	async fn leases_balance_open_close_and_save_includes_requested_text() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(
				br#"{"textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":true}}}"#,
			),
		)
		.unwrap();
		let uri = Url::parse("file:///work/a.txt").unwrap();
		let saved = snapshot(1, "saved");
		let input = LspDocument { snapshot: &saved, uri: &uri, language_id: None };
		server
			.synchronize(input, CancellationToken::new())
			.await
			.unwrap();
		server
			.did_save(input, CancellationToken::new())
			.await
			.unwrap();
		server
			.retain_document(saved.head().document_id())
			.await
			.unwrap();
		server
			.release_document(saved.head().document_id(), CancellationToken::new())
			.await
			.unwrap();
		server
			.release_document(saved.head().document_id(), CancellationToken::new())
			.await
			.unwrap();

		let messages = transport.messages.lock();
		assert_eq!(
			messages
				.iter()
				.filter(|(_, method, _)| method.as_str() == DID_OPEN)
				.count(),
			1
		);
		assert_eq!(
			messages
				.iter()
				.filter(|(_, method, _)| method.as_str() == DID_CLOSE)
				.count(),
			1
		);
		let save = messages
			.iter()
			.find(|(_, method, _)| method.as_str() == DID_SAVE)
			.unwrap();
		assert_eq!(serde_json::from_slice::<Value>(&save.2).unwrap()["text"].as_str(), Some("saved"));
	}

	#[tokio::test]
	async fn lifecycle_passthrough_is_rejected_on_both_paths() {
		let server =
			LspServer::new(Arc::new(RecordingTransport::default()), Bytes::from_static(b"{}"))
				.unwrap();
		let methods = [
			"initialize",
			"initialized",
			"shutdown",
			"exit",
			DID_OPEN,
			DID_CHANGE,
			WILL_SAVE,
			WILL_SAVE_WAIT_UNTIL,
			DID_SAVE,
			DID_CLOSE,
		];
		for method in methods {
			assert!(matches!(
				server
					.notification(method, Bytes::from_static(b"{}"), CancellationToken::new())
					.await,
				Err(LspError::LifecyclePassthrough { .. })
			));
			assert!(matches!(
				server
					.request(method, Bytes::from_static(b"{}"), None, CancellationToken::new())
					.await,
				Err(LspError::LifecyclePassthrough { .. })
			));
		}
	}
	#[tokio::test]
	async fn conflicting_language_for_a_tracked_uri_is_rejected_without_state_drift() {
		let transport = Arc::new(RecordingTransport::default());
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		let uri = Url::parse("file:///work/classified.txt").unwrap();
		let first = snapshot(1, "same");
		let rust = LanguageId::new("rust").unwrap();
		let python = LanguageId::new("python").unwrap();
		server
			.synchronize(
				LspDocument { snapshot: &first, uri: &uri, language_id: Some(&rust) },
				CancellationToken::new(),
			)
			.await
			.unwrap();
		server
			.retain_document(first.head().document_id())
			.await
			.unwrap();

		assert!(matches!(
			server
				.synchronize(
					LspDocument { snapshot: &first, uri: &uri, language_id: Some(&python) },
					CancellationToken::new(),
				)
				.await,
			Err(LspError::LanguageChanged {
				ref tracked,
				ref requested,
				..
			}) if tracked.as_deref() == Some("rust") && requested.as_deref() == Some("python")
		));
		let state = server.inner.state.lock();
		let tracked = state.documents.get(&first.head().document_id()).unwrap();
		assert_eq!(tracked.language.as_deref(), Some("rust"));
		assert_eq!(tracked.leases, 2);
		assert_eq!(
			transport
				.messages
				.lock()
				.iter()
				.filter(|(_, method, _)| method.as_str() == DID_OPEN)
				.count(),
			1
		);
	}
	#[tokio::test]
	async fn version_history_tags_current_historical_and_renamed_uris() {
		let server = LspServer::new(
			Arc::new(RecordingTransport::default()),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		let old_uri = Url::parse("file:///work/old.txt").unwrap();
		let new_uri = Url::parse("file:///work/new.txt").unwrap();
		let first = snapshot(1, "one");
		let second = snapshot(2, "two");
		let third = snapshot(3, "three");

		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &first, uri: &old_uri, language_id: None },
					CancellationToken::new(),
				)
				.await
				.unwrap(),
			1
		);
		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &second, uri: &old_uri, language_id: None },
					CancellationToken::new(),
				)
				.await
				.unwrap(),
			2
		);
		assert_eq!(
			server
				.synchronize(
					LspDocument { snapshot: &third, uri: &new_uri, language_id: None },
					CancellationToken::new(),
				)
				.await
				.unwrap(),
			3
		);

		assert_eq!(server.revision_for_version(&old_uri, 1), Some(first.head().revision()));
		assert_eq!(server.revision_for_version(&old_uri, 2), Some(second.head().revision()));
		assert_eq!(server.revision_for_version(&new_uri, 3), Some(third.head().revision()));
		assert_eq!(
			server.tracked_version_revision(third.head().document_id()),
			Some((3, third.head().revision())),
		);
	}
}
