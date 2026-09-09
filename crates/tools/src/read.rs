//! Reads of local and special resources.

use std::{borrow::Cow, collections::HashMap, future::Future, path::Path, str, sync::Arc};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt as _, Stream, pin_mut, select_biased};
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, BlobRef, CallOutcome, CommitError, Constraint, Diag, DiagKind,
	DocEffects, Effects, Ev, IncomingParams, LiftedCall, ParamError, Part, PromptCaps, RecordedCall,
	Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use tracing::Instrument as _;

use crate::{
	path::{HostPaths, normalize_target, tracing_path_metadata},
	render::TextProjection,
};

pub mod archive;
pub mod conflicts;
pub mod dirtree;
pub mod format;
pub mod image;
pub mod json_query;
pub mod markit;
pub mod mutation;
pub mod notebook;
pub mod pdf;
pub mod profile;
pub mod resolver;
pub mod selector;
pub mod sqlite;

use std::time;

pub use sqlite::looks_like_sqlite;
use tokio::task;
pub mod web;
use resolver::ResolverTable;
use web::types::WebError;

const DESCRIPTION: &str = r"Read files, directories, archives, SQLite, images, documents, and web URLs via `path`. For an image, optional `question` sends the materialized image and question through the active model's vision route without adding another tool.

<instruction>
- SHOULD parallelize independent reads.
- SHOULD use `read` (not browser) for web content; browser only when `read` can't deliver.
</instruction>

## Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`)
- `:50` / `:50-` — from line 50 | `:50-200` — inclusive | `:50+150` — 150 lines from 50 | `:5-16,960-973` — multiple ranges
- `:raw` — verbatim, no anchors/prefixes | `:2-4:raw` / `:raw:2-4` — range + verbatim
- `:conflicts` — one line per unresolved git merge conflict block
- `:img` — rasterize a local `.svg`/`.svgz` as a PNG image; use when visual layout matters
- Multiple local paths: semicolon/comma lists or a JSON string array. An existing literal path always wins over splitting.

## Source kinds
- Parseable code, no selector → structural summary (declarations only, body elided). Summary diagnostic names the exact recovery selector.
- File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.
- Directory → deterministic alphabetical depth-limited entries; directories end in / and listings are edit-locked.
- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db` (tables), `file.db:table` (schema+rows), `file.db:table:key` (by PK), `?limit=`/`?where=`/`?q=SELECT`.
- Archives (`.zip` family incl. `.jar`/`.apk`/`.whl`, `.tar` incl. `.tar.{gz,bz2,xz,zst}`, `.rar`, `.7z`, `.iso`, `.cab`, `.deb`/`.rpm`/`.cpio`/`.ar`, `.lzh`/`.arj`, `.asar`; single-stream `.gz`/`.bz2`/`.xz`/`.zst`): `archive.ext:path/inside/archive` reads a member.
- Documents → extracted text. Notebooks → editable cells. Images → decoded inline. SVGs read as text unless `:img` is specified. `:raw` bypasses converters.
- URLs → reader-mode clean text/markdown; `:raw` → untouched HTML. Bare `host:port` needs trailing slash.
- Internal resources enforce owner byte/entry ceilings; path-only resolution returns metadata without content. Binary/oversized resources return selector or materialized-path guidance rather than inline bytes.
- `ssh://host/<path>` reads remote files/directories; bare `ssh://` lists hosts; specific remote files are searchable with `grep`.
  Literal `:`, `?`, `#` → percent-encode (`%3A`/`%3F`/`%23`). For remote operations unsupported by `ssh://`, use `bash` with a remote SSH command or mount with `sshfs`.
- `vault://<name>/<path>` reads configured or Obsidian-discovered vault files/directories; bare `vault://` lists effective roots. `?op=read` uses Obsidian's CLI and `?op=search&q=…` searches a vault. Create/move/delete/open operations route through `write`.
- Literal `:`, `?`, `#` in other URI-like member paths → percent-encode (`%3A`/`%3F`/`%23`).

<critical>
Summary diagnostic names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>";
const VISION_UNAVAILABLE: &str =
	"Image question unavailable: the active model route does not accept image input.";
const MAX_SUMMARY_BYTES: u64 = 2 * 1024 * 1024;
const REPEAT_READ_HINT_THRESHOLD: u32 = 3;
const REPEAT_READ_TRACKER_CAP: usize = 64;
const MIN_SUMMARY_LINES: usize = 100;
const MAX_SUMMARY_LINES: usize = 20_000;
/// Maximum editable whole-file snapshot retained across read and write.
pub const SNAPSHOT_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Header window sniffed for the binary heuristic; mirrors git's 8000-byte
/// scan.
///
/// Callers holding the whole file in memory sniff the identical prefix
/// through [`is_probably_binary_header`] instead of reopening.
pub const BINARY_SNIFF_BYTES: usize = 8192;

/// Arguments accepted by `read@2`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Local path, internal URI (e.g. skill://), or URL. Inline selectors are
	/// supported.
	#[schemars(
		description = "Local path, internal URI (e.g. skill://), or URL. Inline selectors are \
		               supported.",
		with = "String"
	)]
	pub path:     Str,
	/// Optional question to answer from one materialized image. The active
	/// inference route must accept image input.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		description = "Optional question about one image. The active model vision route receives \
		               the question and materialized image together.",
		with = "String"
	)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub question: Option<Str>,
}

/// Ephemeral read progress.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Update {
	/// Progress phase description.
	pub phase: Str,
}

/// A local source's filesystem classification.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
	/// A regular file.
	File,
	/// A directory.
	Directory,
	/// A symbolic link whose target is classified by the resource owner.
	Symlink,
}

/// Metadata resolved by the app-owned source adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceStat {
	/// Canonical local path used for subsequent resource calls.
	pub canonical_path: Str,
	/// Stable model-facing path relative to the workspace when possible.
	pub display_path:   Str,
	/// Source classification.
	pub kind:           SourceKind,
	/// Exact byte length for files.
	pub byte_len:       u64,
	/// Milliseconds since the Unix epoch, when available.
	pub modified_ms:    Option<u64>,
}

/// One recursive directory entry supplied to the pure directory renderer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DirectoryEntry {
	/// Path relative to the listed directory.
	pub path:        Str,
	/// Entry classification.
	pub kind:        SourceKind,
	/// Exact file byte length, or zero for directories.
	pub byte_len:    u64,
	/// Milliseconds since the Unix epoch, when available.
	pub modified_ms: Option<u64>,
}

/// Depth-bounded directory metadata returned by the resource owner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DirectorySource {
	/// Canonical listed root.
	pub root:      Str,
	/// Entries at depth one or two, relative to `root`.
	pub entries:   Vec<DirectoryEntry>,
	/// Whether the resource owner stopped before visiting every entry.
	pub truncated: bool,
}

/// One inclusive span whose text was shown to the model.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SeenRange {
	/// First shown one-based line.
	pub start_line: u64,
	/// Last shown one-based line.
	pub end_line:   u64,
}

/// Snapshot information recorded alongside a revision-pinned plain-file read.
#[derive(Clone, Debug)]
pub struct SnapshotRecord {
	/// Canonical path key.
	pub path:     Str,
	/// Pinned document revision.
	pub revision: Str,
	/// Complete pinned bytes used to compute the hashline tag.
	pub bytes:    Bytes,
	/// Exact source line spans exposed by this result.
	pub seen:     Vec<SeenRange>,
}

/// An opaque revision-pinned lease for one plain file.
pub trait ReadLease: Send + Sync {
	/// Returns the pinned revision identity.
	fn revision(&self) -> &Str;
	/// Returns the canonical path represented by the lease.
	fn canonical_path(&self) -> &Str;
	/// Reads the complete pinned file bytes.
	fn read_all(&self) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_;
}

/// App-owned local-source I/O boundary.
///
/// Rendering, document conversion, web fetching policy, and dispatch remain in
/// `omp-tools`; implementations provide local resources plus the low-level HTTP
/// transport inherited from [`HttpClient`].
pub trait ReadSources: web::types::HttpClient + Send + Sync + 'static {
	/// Revision-pinned plain-file lease type.
	type Lease: ReadLease;

	/// Stats an authored or canonical local path.
	fn stat(&self, path: Str) -> impl Future<Output = Result<SourceStat, Fault>> + Send + '_;
	/// Attempts unique workspace-suffix recovery for a missing authored path.
	fn resolve_suffix(
		&self,
		path: Str,
	) -> impl Future<Output = Result<Option<SourceStat>, Fault>> + Send + '_;
	/// Opens a revision-pinned lease for a plain file.
	fn open(&self, path: Str) -> impl Future<Output = Result<Self::Lease, Fault>> + Send + '_;
	/// Reads complete bytes for a special local source.
	fn read_bytes(&self, path: Str) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_;
	/// Lists a directory recursively to the requested maximum depth.
	fn list_directory(
		&self,
		path: Str,
		max_depth: usize,
	) -> impl Future<Output = Result<DirectorySource, Fault>> + Send + '_;
	/// Atomically commits extracted document media and rewrites conversion
	/// links.
	///
	/// Implementations that support local document conversion MUST preserve the
	/// attachment transaction or reject media extraction rather than emit links
	/// to files that do not exist.
	fn commit_document_media(
		&self,
		_source: &SourceStat,
		conversion: &mut markit::Conversion,
	) -> Result<(), Fault> {
		if conversion.attachments.is_empty() {
			return Ok(());
		}
		Err(Fault::Unsupported {
			message: Str::new("document media extraction is unavailable for this source"),
		})
	}

	/// Reads a bounded prefix for magic-byte classification.
	fn read_prefix(
		&self,
		path: Str,
		max_bytes: usize,
	) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		async move {
			let bytes = self.read_bytes(path).await?;
			Ok(bytes.slice(..bytes.len().min(max_bytes)))
		}
	}
	/// Records a hashline snapshot and its exposed line spans.
	fn record_snapshot(&self, record: SnapshotRecord) -> Result<Option<Str>, Fault>;
}

/// Stores binary bytes in the durable environment blob namespace.
pub trait ReadBlobs: Send + Sync + 'static {
	/// Stores bytes and returns a durable blob reference.
	fn store(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<BlobRef, Fault>> + Send + '_;
	/// Stores bytes and adopts them into the active session artifact catalog.
	fn store_artifact(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<StoredArtifact, Fault>> + Send + '_;
}
/// Blob storage plus the resolver-valid session artifact address adopted for
/// it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredArtifact {
	/// Content-addressed bytes backing the artifact.
	pub blob: BlobRef,
	/// Resolver-valid `artifact://` address in the active session.
	pub uri:  Str,
}

/// A question paired with an image for the active model's vision route.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VisionRequest {
	/// Exact caller-authored question.
	pub question: Str,
}

/// One deterministic read result part.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PayloadPart {
	/// Model-visible UTF-8 text.
	Text {
		/// Complete text after read-level formatting; never truncated here.
		text: Str,
	},
	/// Durable binary media with a textual fallback.
	Blob {
		/// Stored media bytes.
		blob:   BlobRef,
		/// Model-facing fallback and media description.
		alt:    Str,
		/// Image question routed with this blob when the active model accepts
		/// vision input.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		vision: Option<VisionRequest>,
	},
}

/// Durable, deterministic read truth.
///
/// Parts are complete. The dispatcher bounds the rendered result once and
/// spills the full text to an artifact; Read never truncates its own output.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Ordered text and blob parts.
	pub parts: Vec<PayloadPart>,
}

struct ReadExecution {
	payload: Payload,
	diags:   Vec<Diag>,
}

struct ReadSection {
	parts: Vec<PayloadPart>,
	diags: SmallVec<Diag, 2>,
}

impl ReadSection {
	const fn new(parts: Vec<PayloadPart>) -> Self {
		Self { parts, diags: SmallVec::new() }
	}

	fn text(text: impl Into<Str>) -> Self {
		Self::new(vec![PayloadPart::Text { text: text.into() }])
	}

	fn rendered(rendered: format::Rendered) -> Self {
		Self { parts: vec![PayloadPart::Text { text: rendered.text }], diags: rendered.diags }
	}

	fn with_diags(mut self, diags: impl IntoIterator<Item = Diag>) -> Self {
		self.diags.extend(diags);
		self
	}

	fn recovered(mut self, from: Option<&str>, to: &str) -> Self {
		if let Some(from) = from {
			self
				.diags
				.push(Diag::info(DiagKind::PathRecovered, sf!("{from} -> {to}")));
		}
		self
	}
}

/// Typed read failure with an exact model-facing message.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Invalid selector or target syntax.
	Invalid {
		/// Exact diagnostic.
		message: Str,
	},
	/// Missing or unreadable local source.
	Source {
		/// Exact diagnostic.
		message: Str,
	},
	/// A syntactically valid scheme outside the built-in vocabulary.
	UnknownScheme {
		/// Caller spelling of the unknown scheme.
		scheme:  Str,
		/// Exact diagnostic.
		message: Str,
	},
	/// A known scheme with no resolver in this deployment.
	SchemeNotReadable {
		/// Known scheme that could not be dispatched.
		scheme:  resolver::Scheme,
		/// Exact diagnostic.
		message: Str,
	},
	/// Unsupported operation on an otherwise readable source.
	Unsupported {
		/// Exact diagnostic.
		message: Str,
	},
	/// Web transport, decoding, or rendering failure.
	Web {
		/// Exact diagnostic.
		message: Str,
	},
	/// Durable blob storage failure.
	Blob {
		/// Exact diagnostic.
		message: Str,
	},
}

impl Fault {
	/// Constructs a source failure.
	pub fn source(message: impl Into<Str>) -> Self {
		Self::Source { message: message.into() }
	}

	/// Returns the exact model-facing diagnostic.
	pub const fn message(&self) -> &Str {
		match self {
			Self::Invalid { message }
			| Self::Source { message }
			| Self::UnknownScheme { message, .. }
			| Self::SchemeNotReadable { message, .. }
			| Self::Unsupported { message }
			| Self::Web { message }
			| Self::Blob { message } => message,
		}
	}
}

/// Invocation-frozen read behavior selected by the production registry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReadPolicy {
	/// Permit HTTP(S) dispatch.
	pub fetch_enabled:      bool,
	/// Convert supported documents into Markdown.
	pub render_markdown:    bool,
	/// Decode and resize images for model bounds.
	pub auto_resize_images: bool,
	/// Replace eligible whole-file source with a structural summary.
	pub summarize:          bool,
	/// Include source line numbers when no hashline snapshot is emitted.
	pub line_numbers:       bool,
	/// Record snapshots and expose hashline headers for editable local text.
	pub hashline_headers:   bool,
}

impl Default for ReadPolicy {
	fn default() -> Self {
		Self {
			fetch_enabled:      true,
			render_markdown:    true,
			auto_resize_images: true,
			summarize:          true,
			line_numbers:       true,
			hashline_headers:   true,
		}
	}
}

/// `read@2` executor over unboxed app resource adapters.
pub struct ReadTool<S, B, R = resolver::NoResolver> {
	sources:      S,
	blobs:        B,
	resolvers:    Arc<ResolverTable<R>>,
	conflicts:    Arc<conflicts::ConflictRegistry>,
	policy:       ReadPolicy,
	repeat_reads: Mutex<RepeatReadTracker>,
	spec:         ToolSpec,
}
#[derive(Clone, Copy)]
struct RepeatedRead {
	hash:  u64,
	count: u32,
}

#[derive(Default)]
struct RepeatReadTracker {
	reads: HashMap<Str, RepeatedRead>,
}

impl RepeatReadTracker {
	fn observe(&mut self, path: &str, text: &str) -> Option<u32> {
		let hash = omp_core::fast_hash64(text);
		if let Some(read) = self.reads.get_mut(path) {
			if read.hash != hash {
				*read = RepeatedRead { hash, count: 1 };
				return None;
			}
			read.count = read.count.saturating_add(1);
			return (read.count >= REPEAT_READ_HINT_THRESHOLD).then_some(read.count);
		}
		if self.reads.len() >= REPEAT_READ_TRACKER_CAP {
			self.reads.clear();
		}
		self
			.reads
			.insert(Str::new(path), RepeatedRead { hash, count: 1 });
		None
	}
}

#[cfg(test)]
mod repeat_read_tests {
	use super::*;

	#[test]
	fn warns_on_third_identical_read_and_resets_when_output_changes() {
		let mut tracker = RepeatReadTracker::default();
		assert_eq!(tracker.observe("src/lib.rs", "one"), None);
		assert_eq!(tracker.observe("src/lib.rs", "one"), None);
		assert_eq!(tracker.observe("src/lib.rs", "one"), Some(3));
		assert_eq!(tracker.observe("src/lib.rs", "two"), None);
		assert_eq!(tracker.observe("src/lib.rs", "two"), None);
		assert_eq!(tracker.observe("src/lib.rs", "two"), Some(3));
	}

	#[test]
	fn paged_reads_are_tracked_by_their_exact_selector() {
		let mut tracker = RepeatReadTracker::default();
		for path in ["src/lib.rs:1-100", "src/lib.rs:101-200"] {
			assert_eq!(tracker.observe(path, "page"), None);
			assert_eq!(tracker.observe(path, "page"), None);
		}
		assert_eq!(tracker.observe("src/lib.rs:1-100", "page"), Some(3));
		assert_eq!(tracker.observe("src/lib.rs:101-200", "page"), Some(3));
	}

	#[test]
	fn tracker_discards_old_keys_at_the_session_cap() {
		let mut tracker = RepeatReadTracker::default();
		for index in 0..REPEAT_READ_TRACKER_CAP {
			assert_eq!(tracker.observe(&format!("file-{index}"), "same"), None);
		}
		assert_eq!(tracker.reads.len(), REPEAT_READ_TRACKER_CAP);
		assert_eq!(tracker.observe("overflow", "same"), None);
		assert_eq!(tracker.reads.len(), 1);
	}

	#[test]
	fn ssh_guidance_names_the_live_tools_and_fallbacks() {
		assert!(DESCRIPTION.contains("searchable with `grep`"));
		assert!(DESCRIPTION.contains("use `bash` with a remote SSH command"));
		assert!(DESCRIPTION.contains("mount with `sshfs`"));
		assert!(!DESCRIPTION.contains("`search`"));
		assert!(!DESCRIPTION.contains("`ssh` tool"));
	}
}

struct InterruptSqliteOnDrop(Option<Arc<sqlite::QueryInterrupt>>);

impl InterruptSqliteOnDrop {
	fn disarm(&mut self) {
		self.0 = None;
	}
}

impl Drop for InterruptSqliteOnDrop {
	fn drop(&mut self) {
		if let Some(interrupt) = self.0.take() {
			interrupt.interrupt();
		}
	}
}

/// Returns the host-free `read@2` specification for a frozen projection policy.
pub fn spec(policy: ReadPolicy) -> ToolSpec {
	let description = if policy.hashline_headers {
		sf!(DESCRIPTION)
	} else {
		let selector_description = if policy.line_numbers {
			"- File + selector → numbered lines. This registry projection is read-only or has no \
			 compatible hashline edit revision, so snapshot headers are suppressed."
		} else {
			"- File + selector → selected text without line prefixes. This registry projection is \
			 read-only or has no compatible hashline edit revision, so snapshot headers are \
			 suppressed."
		};
		Str::new(DESCRIPTION.replace(
			"- File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy \
			 `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.",
			selector_description,
		))
	};
	ToolSpec {
		name: sf!("read"),
		rev: Rev { family: Default::default(), n: 2 },
		description,
		schema: omp_tool::schema::<Params>(),
		constraint: Constraint::Schema {
			priority:       10,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects: Effects {
			documents: Some(DocEffects { read: true, write_globs: Arc::default() }),
			exec:      None,
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("read.rs"),
		)
		.into(),
	}
}

/// Constructs the `read@2` tool without internal URL resolvers.
pub fn tool<S: ReadSources, B: ReadBlobs>(
	sources: S,
	blobs: B,
) -> ReadTool<S, B, resolver::NoResolver> {
	tool_with_resolvers_and_conflicts(
		sources,
		blobs,
		Arc::new(ResolverTable::default()),
		Arc::new(conflicts::ConflictRegistry::default()),
	)
}

/// Constructs `read@2` with concrete, constructor-owned internal URL
/// resolvers.
pub fn tool_with_resolvers<S: ReadSources, B: ReadBlobs, R: resolver::Resolve>(
	sources: S,
	blobs: B,
	resolvers: Arc<ResolverTable<R>>,
) -> ReadTool<S, B, R> {
	tool_with_resolvers_and_conflicts(
		sources,
		blobs,
		resolvers,
		Arc::new(conflicts::ConflictRegistry::default()),
	)
}

/// Constructs `read@2` with internal URL resolvers and the session conflict
/// registry shared with its `conflict://` resolver and splice writer.
pub fn tool_with_resolvers_and_conflicts<S: ReadSources, B: ReadBlobs, R: resolver::Resolve>(
	sources: S,
	blobs: B,
	resolvers: Arc<ResolverTable<R>>,
	conflicts: Arc<conflicts::ConflictRegistry>,
) -> ReadTool<S, B, R> {
	tool_with_policy(sources, blobs, resolvers, conflicts, ReadPolicy::default())
}

/// Constructs `read@2` with one frozen registry-projection policy.
pub fn tool_with_policy<S: ReadSources, B: ReadBlobs, R: resolver::Resolve>(
	sources: S,
	blobs: B,
	resolvers: Arc<ResolverTable<R>>,
	conflicts: Arc<conflicts::ConflictRegistry>,
	policy: ReadPolicy,
) -> ReadTool<S, B, R> {
	ReadTool {
		sources,
		blobs,
		resolvers,
		conflicts,
		policy,
		repeat_reads: Mutex::default(),
		spec: spec(policy),
	}
}

impl<S: ReadSources, B: ReadBlobs, R: resolver::Resolve> Tool for ReadTool<S, B, R> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		let span = tracing::debug_span!("read_execution", path = tracing::field::Empty);
		stream! {
			let pulled = incoming.pull(|mut document| async move {
				let mut root = document.json().object();
				let _path = root.key("path").string().finish().await?;
				root.collect().await.map(|value| value.to_string())
			}).await;
			let raw = match pulled {
				Ok(value) => value,
				Err(ParamError::Args(issue)) if issue.kind == ArgIssueKind::Aborted => { yield Ev::Aborted(Abort::InputDropped); return; },
				Err(ParamError::Args(issue)) => { yield Ev::Args(*issue); return; },
				Err(ParamError::Interrupted(interrupt)) => { yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }); return; },
				Err(ParamError::Protocol(reason)) => { yield Ev::Args(protocol_issue(reason)); return; },
			};
			let params: Params = if let Ok(value) = omp_tool::decode_params(&raw) { value } else { yield Ev::Args(args_issue()); return; };
			match incoming.committed().await {
				Ok(_) => {},
				Err(CommitError::Aborted) => { yield Ev::Aborted(Abort::InputDropped); return; },
				Err(CommitError::Interrupted(interrupt)) => { yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }); return; },
				Err(CommitError::Protocol(reason)) => { yield Ev::Args(protocol_issue(reason)); return; },
			}
			let path = params.path;
			span.record("path", tracing::field::display(tracing_path_metadata(&path)));
			let work = self.execute(path.clone(), params.question).instrument(span.clone()).fuse();
			let cancel = incoming.next_interrupt().fuse();
			pin_mut!(work, cancel);
			let result = select_biased! {
				interrupt = cancel => {
					let reason = interrupt.map_or_else(|_| sf!("invocation owner dropped"), |value| value.reason);
					yield Ev::Aborted(Abort::Interrupted { reason });
					return;
				},
				value = work => value,
			};
			match result {
				Ok(execution) => {
					let repeat_diag = self.repeat_read_diag(&path, &execution.payload);
					for diag in execution.diags {
						yield Ev::Diag(diag);
					}
					if let Some(diag) = repeat_diag {
						yield Ev::Diag(diag);
					}
					yield done(Ok(execution.payload));
				},
				Err(fault) => yield done(Err(fault)),
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		let payload = match view {
			Ok(payload) => payload,
			Err(fault) => {
				let Some(mut projection) = TextProjection::new(*caps) else {
					return Vec::new();
				};
				projection.push(fault.message());
				return projection.finish();
			},
		};
		let mut output = Vec::new();
		for part in &payload.parts {
			if output.len() >= usize::from(caps.maximum_parts) {
				break;
			}
			match part {
				PayloadPart::Text { text } if caps.maximum_text_bytes != 0 => {
					output.push(Part::Text { text: text.clone() });
				},
				PayloadPart::Blob { blob, alt, .. } if caps.media => {
					output.push(Part::Blob { blob: blob.clone(), alt: Some(alt.clone()) });
				},
				PayloadPart::Blob { vision: Some(_), .. } if caps.maximum_text_bytes != 0 => {
					output.push(Part::Text { text: Str::new_static(VISION_UNAVAILABLE) });
				},
				PayloadPart::Blob { alt, .. } if caps.maximum_text_bytes != 0 => {
					output.push(Part::Text { text: alt.clone() });
				},
				_ => {},
			}
		}
		output
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_rev1(from, call)
	}
}

fn lift_rev1(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || from.n != 1 {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<serde_json::Value>(call.raw_args).ok()?;
	raw_args.as_object_mut()?.remove("i");
	serde_json::from_value::<Params>(raw_args).ok()?;
	serde_json::from_slice::<CallOutcome<Payload, Fault>>(call.verdict).ok()?;
	Some(LiftedCall {
		raw_args: Bytes::copy_from_slice(call.raw_args),
		verdict:  Bytes::copy_from_slice(call.verdict),
	})
}

impl<S: ReadSources, B: ReadBlobs, R: resolver::Resolve> ReadTool<S, B, R> {
	fn repeat_read_diag(&self, path: &str, payload: &Payload) -> Option<Diag> {
		let text = payload.parts.iter().find_map(|part| match part {
			PayloadPart::Text { text } if !text.is_empty() => Some(text),
			_ => None,
		})?;
		let count = self.repeat_reads.lock().observe(path, text)?;
		Some(Diag::warn(
			DiagKind::Advisory,
			sf!("Identical output returned {count} times for '{path}'."),
		))
	}

	async fn execute(&self, authored: Str, question: Option<Str>) -> Result<ReadExecution, Fault> {
		if question
			.as_ref()
			.is_some_and(|question| question.trim().is_empty())
		{
			return Err(Fault::Invalid {
				message: Str::new_static("Image question must not be empty."),
			});
		}
		let targets = self.split_targets(&authored).await?;
		if question.is_some() && targets.len() != 1 {
			return Err(Fault::Invalid {
				message: Str::new_static("An image question requires exactly one read target."),
			});
		}
		let multiple = targets.len() > 1;
		let mut parts = Vec::new();
		let mut diags = Vec::new();
		if multiple {
			let names = targets
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(", ");
			diags.push(Diag::info(
				DiagKind::Advisory,
				sf!("Interpreted as {} paths: {names}", targets.len()),
			));
		}
		for target in &targets {
			match self.execute_target(target).await {
				Ok(mut section) => {
					if let Some(question) = &question {
						Self::attach_vision_question(&mut section.parts, question)?;
					}
					diags.extend(section.diags);
					for part in section.parts {
						push_payload_part(&mut parts, part);
					}
				},
				Err(fault) if multiple => {
					push_payload_part(&mut parts, PayloadPart::Text {
						text: sf!("[Could not read {}: {}]", target, fault.message()),
					});
				},
				Err(fault) => return Err(fault),
			}
		}
		Ok(ReadExecution { payload: Payload { parts }, diags })
	}

	fn attach_vision_question(parts: &mut Vec<PayloadPart>, question: &Str) -> Result<(), Fault> {
		let Some(blob_index) = parts
			.iter()
			.position(|part| matches!(part, PayloadPart::Blob { .. }))
		else {
			return Err(Fault::Unsupported {
				message: Str::new_static(
					"Image questions require a supported PNG, JPEG, GIF, WebP, or rasterized SVG/PDF \
					 image.",
				),
			});
		};
		if let Some(PayloadPart::Text { text }) = parts[..blob_index]
			.iter_mut()
			.rev()
			.find(|part| matches!(part, PayloadPart::Text { .. }))
		{
			*text = sf!("{text}\n\nImage question: {question}\nAnswer using the attached image.");
		} else {
			parts.insert(blob_index, PayloadPart::Text {
				text: sf!("Image question: {question}\nAnswer using the attached image."),
			});
		}
		let vision = VisionRequest { question: question.clone() };
		let Some(PayloadPart::Blob { vision: request, .. }) = parts
			.iter_mut()
			.find(|part| matches!(part, PayloadPart::Blob { .. }))
		else {
			unreachable!("blob position was checked above");
		};
		*request = Some(vision);
		Ok(())
	}

	async fn split_targets(&self, authored: &str) -> Result<Vec<Str>, Fault> {
		// An exact file name always wins over syntactic target-list encodings.
		if self.sources.stat(Str::new(authored)).await.is_ok() {
			return Ok(vec![Str::new(authored)]);
		}
		if let Some(paths) = selector::parse_json_path_array(authored)
			.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })?
		{
			return Ok(paths);
		}
		if selector::parse_uri(authored)
			.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })?
			.is_some()
			|| !matches!(web::parse_target(authored), Ok(None))
		{
			return Ok(vec![Str::new(authored)]);
		}
		if !authored.contains([';', ',']) {
			return Ok(vec![Str::new(authored)]);
		}
		let targets = selector::split_delimited_targets(authored);
		if targets.is_empty() {
			return Err(Fault::Invalid { message: sf!("Path must not be empty") });
		}
		// Delimiters only become a list when every member resolves directly,
		// with an inline selector resolved against its underlying local path.
		// Otherwise retain the authored text as one literal path.
		if futures::future::try_join_all(targets.iter().cloned().map(|target| async move {
			if self.sources.stat(target.clone()).await.is_ok() {
				return Ok(());
			}
			let split = selector::split_path_and_selector(&target);
			self.sources.stat(Str::new(split.path)).await.map(|_| ())
		}))
		.await
		.is_ok()
		{
			Ok(targets)
		} else {
			Ok(vec![Str::new(authored)])
		}
	}

	async fn execute_target(&self, authored: &str) -> Result<ReadSection, Fault> {
		let normalized = normalize_target(authored, None, HostPaths::current());
		let normalization_from = normalized
			.recovered()
			.then_some(normalized.authored.as_str());
		let recovery_candidates = normalized.recovery_candidates();
		let authored = normalized.canonical.as_str();
		if let Some(target) = web::parse_target(authored).map_err(|error| match error {
			WebError::InvalidUrl(message) => Fault::Invalid { message },
			other => Fault::Web { message: other.message() },
		})? {
			if !self.policy.fetch_enabled {
				return Err(Fault::Unsupported {
					message: sf!("URL reads are disabled by tools.fetch.enabled"),
				});
			}
			return self.read_web(target).await;
		}

		let file_authored = match selector::parse_uri(authored)
			.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })?
		{
			Some(uri) if uri.scheme == resolver::Scheme::File => {
				let mut path = uri.resource.to_owned();
				if let Some(selector) = uri.selector_text {
					path.push(':');
					path.push_str(selector);
				}
				Some(path)
			},
			Some(uri) if uri.scheme == resolver::Scheme::Unknown => {
				let Some(result) = self
					.resolvers
					.read_unknown_with_diags(authored, &uri.selector)
					.await
				else {
					return Err(Fault::UnknownScheme {
						scheme:  Str::new(uri.raw_scheme),
						message: sf!("Unknown URL scheme '{}'", uri.raw_scheme),
					});
				};
				let resolved = result?;
				let bytes = resolved.data;
				if !uri.selector.is_raw()
					&& image::sniff_metadata(&bytes[..bytes.len().min(256 * 1024)]).is_some()
					&& let Some(loaded) = Self::process_image_async(
						bytes.clone().into_bytes(),
						self.policy.auto_resize_images,
					)
					.await?
				{
					let blob = self
						.blobs
						.store(loaded.data, loaded.media_type.clone())
						.await?;
					return Ok(ReadSection::new(vec![
						PayloadPart::Text { text: loaded.description.clone() },
						PayloadPart::Blob { blob, alt: loaded.description, vision: None },
					])
					.with_diags(resolved.diags));
				}
				let text = str::from_utf8(&bytes).map_err(|_| Fault::Invalid {
					message: sf!("{}:// did not resolve to UTF-8 text", uri.raw_scheme),
				})?;
				return Ok(ReadSection::text(text).with_diags(resolved.diags));
			},
			Some(uri) => {
				if matches!(uri.selector, selector::ParsedSelector::Image)
					&& uri.scheme != resolver::Scheme::Local
				{
					return Err(svg_image_selector_fault());
				}
				let Some(result) = self
					.resolvers
					.read_query_with_diags(uri.scheme, uri.resource, uri.query, &uri.selector)
					.await
				else {
					return Err(Fault::SchemeNotReadable {
						scheme:  uri.scheme,
						message: sf!(
							"{}:// is not readable in this deployment",
							uri.raw_scheme.to_ascii_lowercase()
						),
					});
				};
				let resolved = result?;
				let bytes = resolved.data;
				if matches!(uri.selector, selector::ParsedSelector::Image) {
					let gzip =
						svg_gzip_path(Path::new(uri.resource)).ok_or_else(svg_image_selector_fault)?;
					return self
						.read_svg_image(bytes.into_bytes(), gzip)
						.await
						.map(|section| section.with_diags(resolved.diags));
				}
				if !uri.selector.is_raw()
					&& image::sniff_metadata(&bytes[..bytes.len().min(256 * 1024)]).is_some()
					&& let Some(loaded) = Self::process_image_async(
						bytes.clone().into_bytes(),
						self.policy.auto_resize_images,
					)
					.await?
				{
					let blob = self
						.blobs
						.store(loaded.data, loaded.media_type.clone())
						.await?;
					return Ok(ReadSection::new(vec![
						PayloadPart::Text { text: loaded.description.clone() },
						PayloadPart::Blob { blob, alt: loaded.description, vision: None },
					])
					.with_diags(resolved.diags));
				}
				let text = str::from_utf8(&bytes).map_err(|_| Fault::Invalid {
					message: sf!("{}://{} did not resolve to UTF-8 text", uri.raw_scheme, uri.resource),
				})?;
				return Ok(ReadSection::text(text).with_diags(resolved.diags));
			},
			None => None,
		};
		let authored = file_authored.as_deref().unwrap_or(authored);

		let literal = self.sources.stat(Str::new(authored)).await.ok();
		let parsed_split = selector::split_path_and_selector(authored);
		let literal_wins = literal.is_some() && parsed_split.selector.is_some();
		let split = if literal_wins {
			selector::SplitPath { path: authored, selector: None }
		} else {
			parsed_split
		};
		if !literal_wins {
			for candidate in archive::parse_archive_path_candidates(authored) {
				let archive_path = candidate.archive_path.as_str();
				let (stat, suffix_from) = match self.sources.stat(Str::new(archive_path)).await {
					Ok(stat) => (Some(stat), normalization_from),
					Err(_) => {
						(self.sources.resolve_suffix(Str::new(archive_path)).await?, Some(archive_path))
					},
				};
				if let Some(stat) = stat {
					return self
						.read_archive(archive_path, &candidate.sub_path, &stat, suffix_from)
						.await;
				}
			}
		}

		let parsed = selector::parse_selector(split.selector)
			.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })?;

		if !literal_wins {
			for candidate in sqlite::parse_path_candidates(authored) {
				let database = candidate.sqlite_path.to_string_lossy();
				let (stat, suffix_from) = match self.sources.stat(Str::new(database.as_ref())).await {
					Ok(stat) => (Some(stat), normalization_from),
					Err(_) => (
						self
							.sources
							.resolve_suffix(Str::new(database.as_ref()))
							.await?,
						Some(database.as_ref()),
					),
				};
				let Some(stat) = stat else {
					continue;
				};
				let prefix = self
					.sources
					.read_prefix(stat.canonical_path.clone(), 16)
					.await?;
				if sqlite::looks_like_sqlite(&prefix) {
					return self.read_sqlite(authored, &stat, suffix_from).await;
				}
			}
			if let Some(stat) = literal
				.as_ref()
				.filter(|stat| stat.kind == SourceKind::File)
			{
				let prefix = self
					.sources
					.read_prefix(stat.canonical_path.clone(), 16)
					.await?;
				if sqlite::is_sqlite_target(&stat.display_path, &prefix) {
					return self.read_sqlite(authored, stat, None).await;
				}
			}
			if let Some(pdf) = pdf_image_member(split.path) {
				let stat = match self.sources.stat(Str::new(pdf.path)).await {
					Ok(stat) => stat,
					Err(_) => self
						.sources
						.resolve_suffix(Str::new(pdf.path))
						.await?
						.ok_or_else(|| Fault::Source {
							message: sf!("PDF does not exist: {}", pdf.path),
						})?,
				};
				let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
				let page = pdf.page;
				let raster = task::spawn_blocking(move || pdf::rasterize_page(bytes, page))
					.await
					.map_err(|_| Fault::Source {
						message: Str::new_static("PDF image raster task failed"),
					})?
					.map_err(|error| Fault::Source { message: Str::new(error.to_string()) })?;
				let blob = self.blobs.store(raster.data, raster.media_type).await?;
				return Ok(ReadSection::new(vec![
					PayloadPart::Text {
						text: sf!(
							"Rendered PDF page {} of {} from {} ({}x{} PNG).",
							raster.page,
							raster.total_pages,
							stat.display_path,
							raster.width,
							raster.height
						),
					},
					PayloadPart::Blob {
						blob,
						alt: sf!(
							"PDF page {} of {}: {}",
							raster.page,
							raster.total_pages,
							stat.display_path
						),
						vision: None,
					},
				]));
			}
		}

		let mut recovered_from = normalization_from;
		let mut stat = if literal_wins {
			literal.expect("literal path was checked above")
		} else if let Ok(stat) = self.sources.stat(Str::new(split.path)).await {
			stat
		} else {
			let mut repaired = None;
			for candidate in recovery_candidates {
				if let Ok(stat) = self.sources.stat(candidate).await {
					repaired = Some(stat);
					break;
				}
			}
			if let Some(stat) = repaired {
				recovered_from = Some(normalized.authored.as_str());
				stat
			} else {
				let stat = self
					.sources
					.resolve_suffix(Str::new(split.path))
					.await?
					.ok_or_else(|| Fault::source(format!("Path '{}' not found", split.path)))?;
				recovered_from = Some(split.path);
				stat
			}
		};
		let suffix_from = recovered_from;

		if stat.kind == SourceKind::Symlink {
			let authored_display_path = stat.display_path.clone();
			stat = self.sources.stat(stat.canonical_path.clone()).await?;
			stat.display_path = authored_display_path;
		}
		if stat.kind == SourceKind::Directory {
			if matches!(parsed, selector::ParsedSelector::Image) {
				return Err(svg_image_selector_fault());
			}
			return self.read_directory(&stat, &parsed, suffix_from).await;
		}
		if matches!(parsed, selector::ParsedSelector::Conflicts) {
			let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
			let text = String::from_utf8_lossy(&bytes);
			let registered = self.conflicts.refresh(stat.display_path.clone(), &text);
			let entries = registered
				.into_iter()
				.map(|entry| conflicts::ConflictEntry::new(entry.id, entry.block))
				.collect::<Vec<_>>();
			let rendered = conflicts::RenderedConflicts {
				text:  conflicts::format_conflict_summary(&entries, &stat.display_path, false),
				diags: SmallVec::new(),
				count: entries.len(),
			};
			return Ok(ReadSection::text(rendered.text).recovered(suffix_from, &stat.display_path));
		}

		if matches!(parsed, selector::ParsedSelector::Image) {
			let path = Path::new(stat.canonical_path.as_str());
			let gzip = svg_gzip_path(path).ok_or_else(svg_image_selector_fault)?;
			if stat.byte_len > image::MAX_IMAGE_INPUT_BYTES as u64 {
				return Err(Fault::Source {
					message: sf!(
						"SVG file too large: {} bytes exceeds {} byte limit.",
						stat.byte_len,
						image::MAX_IMAGE_INPUT_BYTES
					),
				});
			}
			let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
			return self
				.read_svg_image(bytes, gzip)
				.await
				.map(|section| section.recovered(suffix_from, &stat.display_path));
		}

		let raw = parsed.is_raw();
		let path = Path::new(stat.canonical_path.as_str());
		if !raw
			&& stat.byte_len <= profile::MAX_PROFILE_SUMMARY_BYTES
			&& (profile::is_cpu_profile_path(path) || profile::is_sample_profile_path(path))
		{
			let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
			if let Ok(text) = str::from_utf8(&bytes)
				&& let Some(summary) = profile::render_profile(path, text)
			{
				return self.text_parts(&stat, &summary, &parsed, None, suffix_from);
			}
		}
		let image_by_extension = image::is_supported_extension(path);
		let image_by_magic = if image_by_extension {
			true
		} else {
			let prefix = self
				.sources
				.read_prefix(stat.canonical_path.clone(), 256 * 1024)
				.await?;
			image::sniff_metadata(&prefix).is_some()
		};
		if image_by_magic && let Some(section) = self.read_image(&stat).await? {
			return Ok(section.recovered(suffix_from, &stat.display_path));
		}
		if !raw
			&& path
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("ipynb"))
		{
			let lease = self.sources.open(stat.display_path.clone()).await?;
			let source_bytes = lease.read_all().await?;
			let rendered = notebook::render(&source_bytes, &stat.display_path)
				.map_err(|error| Fault::Source { message: Str::new(error.message()) })?;
			let rendered_bytes = Bytes::copy_from_slice(rendered.text.as_bytes());
			return self.text_parts(
				&stat,
				&rendered.text,
				&parsed,
				Some((lease.canonical_path(), lease.revision(), &rendered_bytes)),
				suffix_from,
			);
		}
		if self.policy.render_markdown && markit::supports_path(path) {
			let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
			let extract_media = path.extension().is_some_and(|extension| {
				extension.eq_ignore_ascii_case("docx") || extension.eq_ignore_ascii_case("pptx")
			});
			match markit::convert_cached(
				&self.sources,
				markit::DocumentMetadata::from_path(path),
				&bytes,
				markit::ConversionOptions { extract_media },
			)
			.await
			{
				Ok(Some(converted)) => {
					let mut converted = converted.conversion;
					self.sources.commit_document_media(&stat, &mut converted)?;
					let mut text = format!("Content-Type: text/markdown\n{}", converted.text);
					if let Some(note) = converted.note {
						text = format!("{note}\n{text}");
					}
					return self.text_parts(&stat, &text, &parsed, None, suffix_from);
				},
				Ok(None) => {},
				Err(_) => {
					return Ok(ReadSection::text(binary_notice(&stat))
						.recovered(suffix_from, &stat.display_path));
				},
			}
		}

		let lease = self.sources.open(stat.display_path.clone()).await?;
		let bytes = lease.read_all().await?;
		// Sniff the leading bytes before deriving any text view: a binary file
		// (font, object, archive, packed blob) is refused for one read and no
		// decode, and NUL-padded UTF-16-style content that would pass strict
		// UTF-8 validation is refused instead of rendering as mojibake. `:raw`
		// stays the explicit escape hatch for reading bytes verbatim.
		if !raw && is_probably_binary_header(&bytes[..bytes.len().min(BINARY_SNIFF_BYTES)]) {
			return Err(Fault::Source { message: Str::new(binary_notice(&stat)) });
		}
		let text: Cow<'_, str> = match str::from_utf8(&bytes) {
			Ok(text) => Cow::Borrowed(text),
			Err(_) if raw => String::from_utf8_lossy(&bytes),
			Err(_) => {
				return Err(Fault::Source { message: Str::new(binary_notice(&stat)) });
			},
		};
		if !raw
			&& self.policy.summarize
			&& matches!(parsed, selector::ParsedSelector::None)
			&& stat.byte_len <= MAX_SUMMARY_BYTES
			&& (MIN_SUMMARY_LINES..=MAX_SUMMARY_LINES).contains(&text.lines().count())
			&& let Some(summary) = structural_summary(&stat.display_path, &text)
		{
			return self.structural_parts(
				&stat,
				summary,
				lease.canonical_path(),
				lease.revision(),
				&bytes,
				suffix_from,
			);
		}
		self.text_parts(
			&stat,
			&text,
			&parsed,
			Some((lease.canonical_path(), lease.revision(), &bytes)),
			suffix_from,
		)
	}

	async fn read_web(&self, target: web::ParsedTarget) -> Result<ReadSection, Fault> {
		let fetched = web::read_resource(&self.sources, &target.url, target.selector.is_raw())
			.await
			.map_err(|error| Fault::Web { message: error.message() })?;
		let framed = format!(
			"URL: {}\nContent-Type: {}\nMethod: {}\n\n---\n\n{}",
			fetched.final_url,
			fetched.render.content_type.as_deref().unwrap_or("unknown"),
			fetched.render.method,
			fetched.render.content
		);
		let mut section = if matches!(
			&target.selector,
			selector::ParsedSelector::None | selector::ParsedSelector::Raw
		) {
			ReadSection::text(framed)
		} else {
			Self::virtual_text_parts(&framed, &target.selector)
		};
		section.diags.extend(fetched.render.diags);
		if let Some(image) = fetched.image {
			let blob = self.blobs.store(image.data, image.media_type).await?;
			section
				.parts
				.push(PayloadPart::Blob { blob, alt: image.description, vision: None });
		}
		Ok(section)
	}

	async fn read_directory(
		&self,
		stat: &SourceStat,
		parsed: &selector::ParsedSelector,
		suffix_from: Option<&str>,
	) -> Result<ReadSection, Fault> {
		if parsed.is_multi_range() {
			return Err(Fault::Invalid {
				message: sf!("Multi-range line selectors are not supported for directory listings.",),
			});
		}
		let source = self
			.sources
			.list_directory(stat.canonical_path.clone(), dirtree::MAX_DEPTH)
			.await?;
		let entries = source
			.entries
			.iter()
			.map(|entry| dirtree::DirEntry {
				relative_path: entry.path.clone(),
				is_dir:        entry.kind == SourceKind::Directory,
				size:          entry.byte_len,
				modified_ms:   entry.modified_ms.unwrap_or(0),
			})
			.collect::<Vec<_>>();
		let (offset, limit) = parsed.offset_limit();
		let offset = offset.and_then(|value| usize::try_from(value).ok());
		let limit = limit.and_then(|value| usize::try_from(value).ok());
		let now_ms = time::SystemTime::now()
			.duration_since(time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as u64;
		let rendered = dirtree::render_directory(
			stat.display_path.clone(),
			&entries,
			source.truncated,
			now_ms,
			offset,
			limit,
		);
		Ok(ReadSection {
			parts: vec![PayloadPart::Text { text: rendered.text }],
			diags: rendered.diags,
		}
		.recovered(suffix_from, &stat.display_path))
	}

	async fn read_archive(
		&self,
		archive_path: &str,
		target: &str,
		stat: &SourceStat,
		suffix_from: Option<&str>,
	) -> Result<ReadSection, Fault> {
		let hinted_format = archive::archive_format_from_path(archive_path);
		let result = if hinted_format == Some(archive::ArchiveFormat::Asar) {
			match archive::read_archive_path(stat.canonical_path.as_str(), target) {
				Ok(result) => result,
				Err(archive::ArchiveError::Io { .. }) => {
					let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
					archive::read_archive_bytes(bytes, archive::ArchiveFormat::Asar, target)
						.map_err(|error| Fault::Source { message: Str::new(error.to_string()) })?
				},
				Err(error) => {
					return Err(Fault::Source { message: Str::new(error.to_string()) });
				},
			}
		} else {
			let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
			let archive_format = hinted_format
				.or_else(|| archive::sniff_archive_format(&bytes))
				.ok_or_else(|| Fault::source(format!("Unsupported archive format: {archive_path}")))?;
			archive::read_archive_bytes(bytes, archive_format, target)
				.map_err(|error| Fault::Source { message: Str::new(error.to_string()) })?
		};
		let section = match result.content {
			archive::ArchiveContent::Directory(listing) => ReadSection::rendered(listing.render()),
			archive::ArchiveContent::Text(member_text) => {
				let display_path = if member_text.node.path.is_empty() {
					stat.display_path.clone()
				} else {
					sf!("{}:{}", stat.display_path, member_text.node.path)
				};
				let member_stat = SourceStat { display_path, ..stat.clone() };
				self.text_parts(&member_stat, &member_text.text, &result.selector, None, None)?
			},
			archive::ArchiveContent::Binary(member_binary) => {
				if image::sniff_metadata(
					&member_binary.bytes[..member_binary.bytes.len().min(256 * 1024)],
				)
				.is_some()
				{
					let loaded =
						Self::process_image_async(member_binary.bytes, self.policy.auto_resize_images)
							.await?
							.expect("sniffed archive image remains supported");
					let description = sf!(
						"Archive image {}:{}\n{}",
						stat.display_path,
						member_binary.member.node.path,
						loaded.description
					);
					let blob = self
						.blobs
						.store(loaded.data, loaded.media_type.clone())
						.await?;
					ReadSection::new(vec![
						PayloadPart::Text { text: description.clone() },
						PayloadPart::Blob { blob, alt: description, vision: None },
					])
				} else {
					ReadSection::text(member_binary.member.notice)
				}
			},
		};
		Ok(section.recovered(suffix_from, &stat.display_path))
	}

	async fn read_sqlite(
		&self,
		authored: &str,
		stat: &SourceStat,
		suffix_from: Option<&str>,
	) -> Result<ReadSection, Fault> {
		let path = Path::new(stat.canonical_path.as_str()).to_owned();
		let authored = authored.to_owned();
		let interrupt = Arc::new(sqlite::QueryInterrupt::default());
		let task_interrupt = interrupt.clone();
		let operation =
			task::spawn_blocking(move || sqlite::read_interruptible(&path, &authored, task_interrupt));
		let mut interrupt_on_drop = InterruptSqliteOnDrop(Some(interrupt));
		let result = operation.await;
		interrupt_on_drop.disarm();
		let rendered = result
			.map_err(|error| Fault::source(format!("SQLite read task failed: {error}")))?
			.map_err(|error| Fault::Source { message: Str::new(error.to_string()) })?;
		Ok(ReadSection::rendered(rendered).recovered(suffix_from, &stat.display_path))
	}

	async fn read_image(&self, stat: &SourceStat) -> Result<Option<ReadSection>, Fault> {
		let bytes = self.sources.read_bytes(stat.canonical_path.clone()).await?;
		let Some(loaded) = Self::process_image_async(bytes, self.policy.auto_resize_images).await?
		else {
			return Ok(None);
		};
		let blob = self
			.blobs
			.store(loaded.data, loaded.media_type.clone())
			.await?;
		Ok(Some(ReadSection::new(vec![
			PayloadPart::Text { text: loaded.description.clone() },
			PayloadPart::Blob { blob, alt: loaded.description, vision: None },
		])))
	}

	async fn read_svg_image(&self, source: Bytes, gzip: bool) -> Result<ReadSection, Fault> {
		let png = task::spawn_blocking(move || image::rasterize_svg(&source, gzip))
			.await
			.map_err(|_| Fault::Source { message: Str::new_static("SVG image raster task failed") })?
			.map_err(|error| Fault::Source { message: Str::new(error.to_string()) })?;
		let loaded = Self::process_image_async(png, false)
			.await?
			.expect("SVG rasterizer always returns PNG bytes");
		let blob = self
			.blobs
			.store(loaded.data, loaded.media_type.clone())
			.await?;
		Ok(ReadSection::new(vec![
			PayloadPart::Text { text: loaded.description.clone() },
			PayloadPart::Blob { blob, alt: loaded.description, vision: None },
		]))
	}

	async fn process_image_async(
		bytes: Bytes,
		auto_resize: bool,
	) -> Result<Option<image::ProcessedImage>, Fault> {
		task::spawn_blocking(move || image::process_image_with_policy(bytes, auto_resize))
			.await
			.map_err(|_| Fault::Source { message: Str::new_static("Image processing task failed") })?
			.map_err(|error| Fault::Source { message: error.message() })
	}

	fn structural_parts(
		&self,
		stat: &SourceStat,
		mut summary: StructuralRender,
		path: &Str,
		revision: &Str,
		bytes: &Bytes,
		suffix_from: Option<&str>,
	) -> Result<ReadSection, Fault> {
		if !self.policy.hashline_headers {
			return Ok(ReadSection {
				parts: vec![PayloadPart::Text { text: Str::new(summary.text) }],
				diags: summary.diags,
			}
			.recovered(suffix_from, &stat.display_path));
		}
		let placeholder = format::format_read_hashline_header(&stat.display_path, "0000");
		summary.text = format!("{}\n{}", placeholder, summary.text);
		summary.source_lines.insert(0, format::SourceLines::new());
		let seen = retained_source_lines(&summary.source_lines);
		let tag = self.sources.record_snapshot(SnapshotRecord {
			path:     path.clone(),
			revision: revision.clone(),
			bytes:    bytes.clone(),
			seen:     seen_ranges(&seen),
		})?;
		if let Some(tag) = tag {
			debug_assert_eq!(tag.len(), 4, "snapshot tags must remain four characters");
			summary.text = summary.text.replacen(
				&format!("[{}#0000]", stat.display_path),
				&format!("[{}#{tag}]", stat.display_path),
				1,
			);
		} else if let Some(header_at) = summary.text.find(placeholder.as_str()) {
			let end = header_at + placeholder.len();
			let remove_end = end + usize::from(summary.text.as_bytes().get(end) == Some(&b'\n'));
			summary.text.replace_range(header_at..remove_end, "");
		}
		Ok(ReadSection {
			parts: vec![PayloadPart::Text { text: Str::new(summary.text) }],
			diags: summary.diags,
		}
		.recovered(suffix_from, &stat.display_path))
	}

	fn text_parts(
		&self,
		stat: &SourceStat,
		text: &str,
		parsed: &selector::ParsedSelector,
		pinned: Option<(&Str, &Str, &Bytes)>,
		suffix_from: Option<&str>,
	) -> Result<ReadSection, Fault> {
		let pinned = pinned.filter(|_| self.policy.hashline_headers);
		let placeholder_tag = pinned.filter(|_| !parsed.is_raw()).map(|_| "0000");
		let mut formatted =
			format_read_projection(stat, text, parsed, placeholder_tag, self.policy.line_numbers);
		append_visible_conflict_warning(
			&mut formatted,
			text,
			&stat.display_path,
			parsed,
			&self.conflicts,
		);
		let candidate_seen = retained_source_lines(&formatted.source_lines);
		let tag = if let Some((path, revision, bytes)) = pinned {
			self.sources.record_snapshot(SnapshotRecord {
				path:     path.clone(),
				revision: revision.clone(),
				bytes:    bytes.clone(),
				seen:     seen_ranges(&candidate_seen),
			})?
		} else {
			None
		};

		if placeholder_tag.is_some() && tag.is_none() {
			formatted = format_read_projection(stat, text, parsed, None, self.policy.line_numbers);
			append_visible_conflict_warning(
				&mut formatted,
				text,
				&stat.display_path,
				parsed,
				&self.conflicts,
			);
		}
		let mut projection = formatted.text;
		let diags = formatted.diags;
		if let Some(tag) = tag
			&& placeholder_tag.is_some()
		{
			debug_assert_eq!(tag.len(), 4, "snapshot tags must remain four characters");
			projection = projection.replacen(
				&format!("[{}#0000]", stat.display_path),
				&format!("[{}#{tag}]", stat.display_path),
				1,
			);
		}
		Ok(ReadSection { parts: vec![PayloadPart::Text { text: Str::new(projection) }], diags }
			.recovered(suffix_from, &stat.display_path))
	}

	fn virtual_text_parts(text: &str, parsed: &selector::ParsedSelector) -> ReadSection {
		let formatted =
			format::format_text(text, parsed, format::TextFormatOptions::new("URL output"));
		ReadSection {
			parts: vec![PayloadPart::Text { text: Str::new(formatted.text) }],
			diags: formatted.diags,
		}
	}
}
fn format_read_projection<'a>(
	stat: &'a SourceStat,
	text: &str,
	parsed: &selector::ParsedSelector,
	tag: Option<&'a str>,
	line_numbers: bool,
) -> format::FormattedText {
	let mut options = format::TextFormatOptions::new("file");
	options.block_context =
		format::BlockContextSource { path: Some(&stat.display_path), language: None };
	options.snapshot = tag.map(|tag| format::SnapshotHeader { anchor: &stat.display_path, tag });
	options.line_numbers = line_numbers;
	format::format_text(text, parsed, options)
}

/// Every source line exposed by a complete projection, sorted and deduplicated.
fn retained_source_lines(source_lines: &[format::SourceLines]) -> Vec<usize> {
	let mut retained = source_lines
		.iter()
		.flat_map(|lines| lines.iter().copied())
		.collect::<Vec<_>>();
	retained.sort_unstable();
	retained.dedup();
	retained
}

fn append_visible_conflict_warning(
	formatted: &mut format::FormattedText,
	source: &str,
	display_path: &str,
	parsed: &selector::ParsedSelector,
	registry: &conflicts::ConflictRegistry,
) {
	if parsed.is_raw() {
		return;
	}
	let retained = retained_source_lines(&formatted.source_lines);
	if retained.is_empty() {
		return;
	}
	let source_lines = source.split('\n').collect::<Vec<_>>();
	let mut visible_blocks = Vec::new();
	let mut run_start = retained[0];
	let mut run_end = run_start;
	for &line in &retained[1..] {
		if line == run_end.saturating_add(1) {
			run_end = line;
			continue;
		}
		if run_start <= source_lines.len() {
			visible_blocks.extend(conflicts::scan_conflict_lines(
				source_lines[run_start - 1..run_end.min(source_lines.len())]
					.iter()
					.copied(),
				run_start,
			));
		}
		run_start = line;
		run_end = line;
	}
	if run_start <= source_lines.len() {
		visible_blocks.extend(conflicts::scan_conflict_lines(
			source_lines[run_start - 1..run_end.min(source_lines.len())]
				.iter()
				.copied(),
			run_start,
		));
	}
	if visible_blocks.is_empty() {
		return;
	}
	let registered = registry.refresh(Str::new(display_path), source);
	let total = registered.len();
	let visible = visible_blocks
		.into_iter()
		.filter_map(|block| {
			registered
				.iter()
				.find(|candidate| {
					candidate.block.start_line == block.start_line
						&& candidate.block.end_line == block.end_line
				})
				.map(|entry| conflicts::ConflictEntry::new(entry.id, block))
		})
		.collect::<Vec<_>>();
	if visible.is_empty() {
		return;
	}
	formatted.diags.extend(conflicts::format_conflict_warning(
		&visible,
		conflicts::ConflictWarningOptions {
			total_in_file:  Some(total),
			display_path:   Some(display_path),
			scan_truncated: false,
		},
	));
}

fn svg_gzip_path(path: &Path) -> Option<bool> {
	let extension = path.extension()?.to_str()?;
	if extension.eq_ignore_ascii_case("svg") {
		Some(false)
	} else if extension.eq_ignore_ascii_case("svgz") {
		Some(true)
	} else {
		None
	}
}

const fn svg_image_selector_fault() -> Fault {
	Fault::Invalid {
		message: Str::new_static("The ':img' selector only supports local .svg and .svgz files."),
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PdfImageMember<'a> {
	path: &'a str,
	page: usize,
}

fn pdf_image_member(input: &str) -> Option<PdfImageMember<'_>> {
	let lower = input.to_ascii_lowercase();
	let index = lower.find(".pdf:")?;
	let member = &lower[index + 5..];
	let stem = [".png", ".jpg", ".jpeg", ".webp"]
		.into_iter()
		.find_map(|extension| member.strip_suffix(extension))?;
	let page = stem.strip_prefix('p')?.parse().ok()?;
	(page > 0).then_some(PdfImageMember { path: &input[..index + 4], page })
}

/// Classifies an in-memory byte header as binary (non-UTF-8 text).
///
/// Binary when the header contains a NUL byte (true binary, plus UTF-16/UTF-32
/// text whose ASCII range is NUL-padded) or when it is not valid UTF-8. A
/// multibyte sequence truncated at the sniff boundary is tolerated, while any
/// genuinely invalid byte still fails — matching the strict whole-file decode
/// the plain-text read path performs afterwards.
pub fn is_probably_binary_header(header: &[u8]) -> bool {
	if header.contains(&0) {
		return true;
	}
	match str::from_utf8(header) {
		Ok(_) => false,
		// `error_len()` is `None` only for an unexpected end of input: an
		// incomplete trailing sequence cut off by the sniff window.
		Err(error) => error.error_len().is_some(),
	}
}

fn binary_notice(stat: &SourceStat) -> String {
	format!(
		"[Cannot read binary file '{}' ({}); not valid UTF-8 text. Use ':raw' to read bytes \
		 verbatim.]",
		stat.display_path,
		format::format_bytes(stat.byte_len),
	)
}

struct StructuralRender {
	text:         String,
	diags:        SmallVec<Diag, 2>,
	source_lines: Vec<format::SourceLines>,
}

fn structural_summary(path: &str, text: &str) -> Option<StructuralRender> {
	enum Unit {
		Line { number: usize, text: String },
		Elided { start: usize, end: usize },
	}

	let summary = omp_ast::summary::summarize_source(text, omp_ast::summary::SummarySettings {
		path: Some(path),
		..Default::default()
	})
	.ok()?;
	if !summary.parsed || !summary.elided {
		return None;
	}
	let mut units = Vec::new();
	for segment in summary.segments {
		let start = segment.start_line as usize;
		let end = segment.end_line as usize;
		if segment.kind == "kept" {
			for (offset, line) in segment.text.unwrap_or_default().lines().enumerate() {
				units.push(Unit::Line { number: start + offset, text: line.to_owned() });
			}
		} else {
			units.push(Unit::Elided { start, end });
		}
	}

	let mut rows = Vec::new();
	let mut source_lines: Vec<format::SourceLines> = Vec::new();
	let mut elided = Vec::new();
	let mut elided_lines = 0;
	let mut index = 0;
	while index < units.len() {
		if let (
			Some(Unit::Line { number: start, text: head }),
			Some(Unit::Elided { .. }),
			Some(Unit::Line { number: end, text: tail }),
		) = (units.get(index), units.get(index + 1), units.get(index + 2))
			&& format::can_merge_brace_pair(head, tail)
		{
			rows.push(format::format_merged_brace_line(*start, *end, head, tail).model);
			source_lines.push(smallvec::smallvec![*start, *end]);
			if end.saturating_sub(*start) > 1 {
				elided.push(format::ElidedRange { start: *start + 1, end: *end - 1 });
			}
			elided_lines += end.saturating_sub(*start).saturating_sub(1);
			index += 3;
			continue;
		}
		match &units[index] {
			Unit::Line { number, text } => {
				rows.push(format!("{number}:{text}"));
				source_lines.push(smallvec::smallvec![*number]);
			},
			Unit::Elided { start, end } => {
				rows.push("…".to_owned());
				source_lines.push(format::SourceLines::new());
				elided.push(format::ElidedRange { start: *start, end: *end });
				elided_lines += end - start + 1;
			},
		}
		index += 1;
	}
	let mut diags = SmallVec::new();
	if let Some(diag) = format::summary_elision_diag(path, &elided, elided_lines) {
		diags.push(diag);
	}
	Some(StructuralRender { text: rows.join("\n"), diags, source_lines })
}

fn seen_ranges(lines: &[usize]) -> Vec<SeenRange> {
	let mut ranges = Vec::new();
	let mut iter = lines.iter().copied();
	let Some(mut start) = iter.next() else {
		return ranges;
	};
	let mut end = start;
	for line in iter {
		if line != end.saturating_add(1) {
			ranges.push(SeenRange { start_line: start as u64, end_line: end as u64 });
			start = line;
		}
		end = line;
	}
	ranges.push(SeenRange { start_line: start as u64, end_line: end as u64 });
	ranges
}

fn push_payload_part(parts: &mut Vec<PayloadPart>, part: PayloadPart) {
	match (parts.last_mut(), part) {
		(Some(PayloadPart::Text { text: previous }), PayloadPart::Text { text }) => {
			let mut combined = String::with_capacity(previous.len() + text.len() + 2);
			combined.push_str(previous);
			combined.push_str("\n\n");
			combined.push_str(&text);
			*previous = Str::new(combined);
		},
		(_, part) => parts.push(part),
	}
}

const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}

const fn args_issue() -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("read@2 arguments"),
		kind:     ArgIssueKind::Malformed,
		example:  None,
		found:    None,
	}
}

const fn protocol_issue(reason: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("linear invocation frames"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(reason),
		found:    None,
	}
}
