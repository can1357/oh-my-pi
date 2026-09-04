//! Whole-file writes over the session document host.

use std::{
	collections::BTreeMap,
	fmt::Write as _,
	future,
	sync::{
		Arc,
		atomic::{AtomicU8, Ordering},
	},
};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt as _, Stream, pin_mut, select_biased};
use omp_core::{Str, sf};
use omp_edit::modes::hashline::format::format_hashline_header;
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Diag, DiagKind, DocEffects, Effects, Ev,
	IncomingParams, InterruptWaitError, ParamError, Part, PromptCaps, Rev, Tool, ToolSpec,
	ToolTerminal, Unit,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
	edit::FormatPolicy,
	path::{HostPaths, normalize_target},
	read::{
		conflicts::{
			ConflictRegistry, ConflictReplacement, RegisteredConflict, parse_bulk_directives,
			parse_conflict_address, parse_replacement,
		},
		mutation::{ResourceMutationReceipt, ResourceMutationRequest, route_resource_mutation},
		resolver::Scheme,
		selector,
		selector::{LiteralPathProbe, parse_uri},
	},
	render::TextProjection,
};

/// Archive and SQLite write seams.
pub mod backends;

const DESCRIPTION: &str =
	"Creates or overwrites file at specified path.\n\n<conditions>\n- Creating new files \
	 explicitly required by task\n- Replacing entire file contents when editing would be more \
	 complex\n- Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, \
	 `.tar.gz`/`.tgz`, and `.tar.zst` archive entries via `archive.ext:path/inside/archive`; other \
	 archive formats (including `.asar`) are read-only\n- Supports SQLite row operations via \
	 `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with \
	 empty content)\n- Supports whole-file writes to configured or Obsidian-discovered \
	 `vault://<name>/path` resources; Obsidian operations use `?op=create[&overwrite]`, \
	 `?op=move&to=<path>`, `?op=delete[&permanent]`, or `?op=open[&newtab]` (the latter three \
	 require empty content); partial selectors remain read-only\n- Supports registered \
	 merge-conflict splices via `conflict://<id>` and \
	 `@ours`/`@base`/`@theirs`/`@both`\n</conditions>\n\n<critical>\n- You SHOULD use Edit tool \
	 for modifying existing files\n- You NEVER create documentation files (*.md, README) unless \
	 explicitly requested\n- You NEVER use emojis unless requested\n</critical>";

/// Model arguments for `write@2`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// file path
	#[schemars(description = "file path")]
	pub path:    Str,
	/// file content
	#[schemars(description = "file content")]
	pub content: Str,
}

/// Ephemeral write progress. Plain writes do not emit speculative updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Whether the committed plain write created or replaced its target.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, strum::Display)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum WriteDisposition {
	/// The target did not exist before the transaction.
	Created,
	/// The target existed and was atomically replaced.
	#[strum(to_string = "updated")]
	Overwrote,
}

/// Mutation family used to project exact special-write response text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteOperation {
	/// Plain whole-file create or overwrite.
	Plain,
	/// Capability-checked internal resource mutation.
	Resource {
		/// Canonical committed URI.
		uri:      Str,
		/// Resource revision after commitment.
		revision: u64,
	},
	/// Registered merge-conflict splice.
	ConflictSplice {
		/// Session-local conflict ID.
		id:           usize,
		/// One-based marker range replaced.
		start_line:   usize,
		/// One-based final marker line replaced.
		end_line:     usize,
		/// Adjacent-context echo lines removed from the authored replacement.
		echo_trimmed: usize,
	},
	/// Bulk conflict resolution outcomes committed atomically per file.
	ConflictBulk {
		/// Total registrations resolved.
		resolved:     usize,
		/// Files committed successfully.
		succeeded:    Vec<Str>,
		/// Files left unchanged with their preflight/commit failure.
		failed:       Vec<ConflictBulkFailure>,
		/// Adjacent-context echo lines removed across successful files.
		echo_trimmed: usize,
	},
	/// ZIP/TAR member create or replacement.
	ArchiveMember,
	/// SQLite row insertion.
	SqliteInsert {
		/// Mutated table.
		table: Str,
	},
	/// SQLite row update, including a no-match result.
	SqliteUpdate {
		/// Mutated table.
		table:   Str,
		/// Authored row key.
		key:     Str,
		/// Whether a row matched.
		changed: bool,
	},
	/// SQLite row deletion, including a no-match result.
	SqliteDelete {
		/// Mutated table.
		table:   Str,
		/// Authored row key.
		key:     Str,
		/// Whether a row matched.
		changed: bool,
	},
}

/// Fully validated whole-file request passed to the document owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlainWriteRequest {
	/// Authored local path, after strict hashline-header unwrapping.
	pub path:            Str,
	/// Exact text to persist, after display-prefix stripping.
	pub content:         Str,
	/// Frozen formatter policy for this transaction.
	pub format_policy:   FormatPolicy,
	/// Whether the document owner must reject generated files.
	pub guard_generated: bool,
}

/// Resource-owned truth returned after one atomic plain-file transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlainWriteResult {
	/// Canonical absolute path committed by the document owner.
	pub resolved_path:   Str,
	/// Stable workspace-relative or shortened model-facing path.
	pub display_path:    Str,
	/// Exact number of UTF-8 bytes persisted.
	pub byte_len:        u64,
	/// Whether the transaction created or replaced the target.
	pub disposition:     WriteDisposition,
	/// Whether a shebang caused at least one execute bit to be added.
	pub made_executable: bool,
	/// Four-character tag recorded in the shared session snapshot store.
	/// Absent for oversized or otherwise untaggable text.
	pub snapshot_tag:    Option<Str>,
}

/// Resource request for one revision-checked conflict splice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictSpliceRequest {
	/// Registered path and marker sides.
	pub entry:       RegisteredConflict,
	/// Selected side directive or exact custom text.
	pub replacement: ConflictReplacement,
}

/// Resource-owned truth returned after a conflict splice transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictSpliceResult {
	/// Standard committed-document receipt.
	pub write:        PlainWriteResult,
	/// One-based marker range replaced in the committed base.
	pub range:        (usize, usize),
	/// Leading and trailing authored lines removed as adjacent-context echoes.
	pub echo_trimmed: usize,
}
/// One preflighted per-file bulk conflict request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictBulkFileRequest {
	/// Display path shared by every entry.
	pub display_path: Str,
	/// Selected registrations and per-entry replacements.
	pub entries:      Vec<(RegisteredConflict, ConflictReplacement)>,
}

/// Resource-owned truth for one atomically committed bulk-conflict file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictBulkFileResult {
	/// Standard committed-document receipt.
	pub write:        PlainWriteResult,
	/// Registration IDs removed after the commit.
	pub resolved_ids: Vec<usize>,
	/// Adjacent-context echo lines removed.
	pub echo_trimmed: usize,
}

/// Durable failure for a file left unchanged during a bulk resolution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConflictBulkFailure {
	/// File whose whole-file preflight or commit failed.
	pub path:    Str,
	/// Resource-owned failure explanation.
	pub message: Str,
}

/// Durable successful `write@2` result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Canonical absolute committed path.
	pub resolved_path:      Str,
	/// Stable model-facing committed path.
	pub display_path:       Str,
	/// Authored-to-canonical mapping when the target required lexical
	/// normalization.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub canonical_recovery: Option<Str>,
	/// Exact UTF-8 byte length persisted.
	pub byte_len:           u64,
	/// JavaScript string length (UTF-16 code units) reported in the model-facing
	/// success line.
	pub reported_len:       u64,
	/// Whether the transaction created or replaced the target.
	pub disposition:        WriteDisposition,
	/// Whether the content-copy guard stripped read/hashline decoration.
	pub stripped_wrapper:   bool,
	/// Whether the host added execute bits for a leading shebang.
	pub made_executable:    bool,
	/// Four-character shared-session snapshot tag, when taggable.
	pub snapshot_tag:       Option<Str>,
	/// Typed mutation family and SQLite outcome details.
	pub operation:          WriteOperation,
}

/// Durable typed `write@2` failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// A URI scheme has no writable resource implementation yet.
	#[error("{scheme}:// targets are not supported yet")]
	UnsupportedScheme {
		/// Lowercase URI scheme without punctuation.
		scheme: Str,
	},
	/// A malformed URI-like path was refused instead of becoming a local file.
	#[error("{message}")]
	UriLikeTarget {
		/// Exact model-facing diagnostic.
		message: Str,
	},
	/// An empty write was accidentally addressed to a read range.
	#[error(
		"write target '{target}' ends with a read-tool selector ':{selector}' and no such file \
		 exists — refusing to create a literal file by that name. If you meant to read it, use \
		 read({{ path: \"{target}\" }}). If you truly intend to create this file, pass its contents \
		 in `content` (a non-empty write is never blocked)."
	)]
	ReadSelectorMisfire {
		/// Original authored target.
		target:   Str,
		/// Selector without its leading colon.
		selector: Str,
	},
	/// A semicolon-joined multi-read expression was passed as one write target.
	#[error(
		"write target '{target}' is a semicolon-joined list of {count} read-tool selectors, not a \
		 filesystem path — refusing to create it. write creates a single file; issue one read() per \
		 path to read these ranges (e.g. read({{ path: \"<one path>:<range>\" }}))."
	)]
	ReadSelectorListMisfire {
		/// Original authored target.
		target: Str,
		/// Number of selector-bearing segments.
		count:  usize,
	},
	/// The document resource rejected the request without changing the target.
	#[error("{message}")]
	Document {
		/// Exact resource-owned explanation.
		message: Str,
	},
}

/// Resource failure classification for the effectful whole-file transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WriteCommitError {
	/// The resource proves the target was not changed.
	Rejected(Fault),
	/// The resource cannot prove whether the effect landed.
	EffectsUnknown {
		/// Stable explanation of the uncertainty.
		reason: Str,
	},
}

const SPECIAL_WRITE_PENDING: u8 = 0;
const SPECIAL_WRITE_STARTED: u8 = 1;
const SPECIAL_WRITE_CANCELLED: u8 = 2;

/// Effect truth observed when a special write is interrupted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpecialWriteCancellation {
	/// Cancellation won before the resource began any externally visible
	/// mutation.
	BeforeEffects,
	/// The resource had begun a mutation, so its durable outcome is not yet
	/// known.
	EffectsUnknown,
}

/// Cancellation and effect-phase handshake for an archive or SQLite write.
///
/// The tool owns cancellation. The resource must call [`Self::begin_effects`]
/// immediately before its first externally visible mutation. The atomic
/// transition makes cancellation truthful even when the blocking worker and
/// invocation interrupt race.
#[derive(Clone, Debug)]
pub struct SpecialWriteControl {
	state:  Arc<AtomicU8>,
	cancel: CancellationToken,
}

impl SpecialWriteControl {
	/// Creates a pending special-write control.
	pub fn new() -> Self {
		Self {
			state:  Arc::new(AtomicU8::new(SPECIAL_WRITE_PENDING)),
			cancel: CancellationToken::new(),
		}
	}

	/// Requests cancellation and reports whether mutation had already begun.
	pub fn cancel(&self) -> SpecialWriteCancellation {
		let phase = match self.state.compare_exchange(
			SPECIAL_WRITE_PENDING,
			SPECIAL_WRITE_CANCELLED,
			Ordering::AcqRel,
			Ordering::Acquire,
		) {
			Ok(_) | Err(SPECIAL_WRITE_CANCELLED) => SpecialWriteCancellation::BeforeEffects,
			Err(_) => SpecialWriteCancellation::EffectsUnknown,
		};
		self.cancel.cancel();
		phase
	}

	/// Marks the exact boundary before the first external mutation.
	///
	/// Returns `false` when cancellation won the race, in which case the
	/// resource must return without mutating anything.
	pub fn begin_effects(&self) -> bool {
		self
			.state
			.compare_exchange(
				SPECIAL_WRITE_PENDING,
				SPECIAL_WRITE_STARTED,
				Ordering::AcqRel,
				Ordering::Acquire,
			)
			.is_ok()
	}

	/// Returns whether cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.cancel.is_cancelled()
	}

	/// Waits until cancellation is requested.
	pub async fn cancelled(&self) {
		self.cancel.cancelled().await;
	}
}

impl Default for SpecialWriteControl {
	fn default() -> Self {
		Self::new()
	}
}

/// Session document boundary used by `write@2`.
///
/// Implementations MUST use the same transaction coordinator and hashline
/// snapshot store as read/edit. A successful `write_plain` atomically creates
/// parent directories and the target or replaces it while preserving existing
/// mode bits. For a new shebang file it applies the platform default mode and
/// adds `a+x`; for an existing shebang file it adds only missing execute bits.
pub trait WriteDocuments: Send + Sync + 'static {
	/// Commits an explicitly routed SSH, vault, or attachment mutation after
	/// the Environment has checked the request's capability.
	fn write_resource(
		&self,
		_request: ResourceMutationRequest,
	) -> impl Future<Output = Result<Option<ResourceMutationReceipt>, WriteCommitError>> + Send + '_
	{
		future::ready(Ok(None))
	}

	/// Probe the exact literal spelling without following a trailing read
	/// selector. Ambiguous errors return [`LiteralPathProbe::Unknown`].
	fn probe_literal(
		&self,
		path: Str,
	) -> impl Future<Output = Result<LiteralPathProbe, Fault>> + Send + '_;

	/// Atomically commit a plain whole-file request and record its fresh
	/// snapshot in the session-shared store before returning.
	fn write_plain(
		&self,
		request: PlainWriteRequest,
	) -> impl Future<Output = Result<PlainWriteResult, WriteCommitError>> + Send + '_;

	/// Attempts a revision-checked `conflict://<id>` splice.
	///
	/// The implementation must read and commit through the document authority,
	/// use [`crate::read::conflicts::splice_registered`] against the pinned
	/// bytes, and reject a moved/ambiguous/stale region without mutation.
	fn splice_conflict(
		&self,
		_request: ConflictSpliceRequest,
	) -> impl Future<Output = Result<Option<ConflictSpliceResult>, WriteCommitError>> + Send + '_ {
		future::ready(Ok(None))
	}

	/// Preflights every selected block for one file and commits the resulting
	/// whole document once.
	fn splice_conflict_file(
		&self,
		_request: ConflictBulkFileRequest,
	) -> impl Future<Output = Result<Option<ConflictBulkFileResult>, WriteCommitError>> + Send + '_
	{
		future::ready(Ok(None))
	}
	/// Attempts an archive-member write after commitment. Implementations MUST
	/// honor `control` and call [`SpecialWriteControl::begin_effects`] before
	/// creating directories, temporary files, or replacing the archive.
	fn write_archive_member(
		&self,
		_display_path: Str,
		_content: Bytes,
		_control: SpecialWriteControl,
	) -> impl Future<Output = Result<Option<backends::ResultPayload>, backends::Fault>> + Send + '_
	{
		future::ready(Ok(None))
	}

	/// Attempts a SQLite-row mutation after archive dispatch. Implementations
	/// MUST honor `control`, publish any available database interrupt handle,
	/// and call [`SpecialWriteControl::begin_effects`] before opening the
	/// database read-write or starting a transaction.
	fn write_sqlite_row(
		&self,
		_display_path: Str,
		_content: Str,
		_control: SpecialWriteControl,
	) -> impl Future<Output = Result<Option<backends::ResultPayload>, backends::Fault>> + Send + '_
	{
		future::ready(Ok(None))
	}
}

/// `write@2` executor.
pub struct WriteTool<D> {
	documents:       D,
	conflicts:       Arc<ConflictRegistry>,
	format_policy:   FormatPolicy,
	guard_generated: bool,
	spec:            ToolSpec,
}

/// Returns the host-free `write@2` specification.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("write"),
		rev:             Rev { family: Str::new(""), n: 2 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: Some(DocEffects {
				read:        true,
				write_globs: [sf!("**")].into_iter().collect(),
			}),
			exec:      None,
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("write.rs"),
		)
		.into(),
	}
}

/// Construct the built-in whole-file write tool.
pub fn tool<D: WriteDocuments>(documents: D) -> WriteTool<D> {
	tool_with_conflicts(documents, Arc::new(ConflictRegistry::default()))
}

/// Construct `write@2` sharing conflict registrations with `read@2`.
pub fn tool_with_conflicts<D: WriteDocuments>(
	documents: D,
	conflicts: Arc<ConflictRegistry>,
) -> WriteTool<D> {
	tool_with_policy_and_conflicts(documents, conflicts, FormatPolicy::BestEffort, true)
}

/// Constructs `write@2` with frozen formatting policy and shared conflicts.
pub fn tool_with_policy_and_conflicts<D: WriteDocuments>(
	documents: D,
	conflicts: Arc<ConflictRegistry>,
	format_policy: FormatPolicy,
	guard_generated: bool,
) -> WriteTool<D> {
	WriteTool { documents, conflicts, format_policy, guard_generated, spec: spec() }
}

impl<D: WriteDocuments> Tool for WriteTool<D> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let arguments = match params.whole::<Params>().await {
				Ok(arguments) => arguments,
				Err(error) => {
					yield param_event(error);
					return;
				},
			};
			let authored_path = unwrap_hashline_header_path(&arguments.path);
			let normalized = normalize_target(authored_path, None, HostPaths::current());
			let path = normalized.canonical.clone();
			let canonical_recovery = normalized
				.recovered()
				.then(|| sf!("{} -> {}", normalized.authored, normalized.canonical));
			let conflict_request = match parse_uri(&path) {
				Ok(Some(uri))
				if uri.scheme == Scheme::Conflict && uri.resource == "*" =>
				{
					None
				},
				Ok(Some(uri)) if uri.scheme == Scheme::Conflict => {
					if uri.selector_text.is_some() || uri.resource.contains('/') {
						yield done(Err(Fault::UriLikeTarget {
							message: sf!(
								"Conflict splices target conflict://<id> without a scope or read selector",
							),
						}));
						return;
					}
					let address = match parse_conflict_address(uri.resource) {
						Ok(address) => address,
						Err(fault) => {
							yield done(Err(Fault::Document { message: fault.message().clone() }));
							return;
						},
					};
					let Some(entry) = self.conflicts.get(address.id) else {
						yield done(Err(Fault::Document {
							message: sf!(
								"Conflict #{} is no longer registered",
								address.id
							),
						}));
						return;
					};
					Some(ConflictSpliceRequest {
						entry,
						replacement: parse_replacement(arguments.content.clone()),
					})
				},
				Ok(_) => None,
				Err(error) => {
					yield done(Err(Fault::UriLikeTarget { message: Str::new(error.to_string()) }));
					return;
				},
			};
			let stripped = strip_write_content(&arguments.content);
			let reported_len =
				u64::try_from(stripped.text.encode_utf16().count()).unwrap_or(u64::MAX);

			match params.interruptable().committed().await {
				Ok(_) => {},
				Err(error) => {
					yield commit_event(error);
					return;
				},
			}


			if path == "conflict://*" {
				let entries = self.conflicts.entries();
				if entries.is_empty() {
					yield done(Err(Fault::Document {
						message: sf!("conflict://* has no registered conflicts to resolve"),
					}));
					return;
				}
				let directives = match parse_bulk_directives(&arguments.content) {
					Ok(directives) => directives,
					Err(fault) => {
						yield done(Err(Fault::Document { message: fault.message().clone() }));
						return;
					},
				};
				if let Some(directives) = &directives {
					let unknown = directives
						.keys()
						.filter(|id| !entries.iter().any(|entry| entry.id == **id))
						.copied()
						.collect::<Vec<_>>();
					if !unknown.is_empty() {
						yield done(Err(Fault::Document {
							message: sf!(
								"Bulk directive references unknown conflict ids: {:?}",
								unknown
							),
						}));
						return;
					}
				}
				let uniform = parse_replacement(stripped.text.clone());
				let mut by_file = BTreeMap::<Str, Vec<_>>::new();
				for entry in entries {
					let replacement = match &directives {
						Some(directives) => {
							let Some(replacement) = directives.get(&entry.id) else {
								continue;
							};
							replacement.clone()
						},
						None => uniform.clone(),
					};
					by_file
						.entry(entry.display_path.clone())
						.or_default()
						.push((entry, replacement));
				}
				if by_file.is_empty() {
					yield done(Err(Fault::Document {
						message: sf!("conflict://* directive block selected no conflicts"),
					}));
					return;
				}
				let mut succeeded = Vec::new();
				let mut failed = Vec::new();
				let mut resolved = 0usize;
				let mut echo_trimmed = 0usize;
				let mut byte_len = 0u64;
				for (display_path, entries) in by_file {
					let request =
						ConflictBulkFileRequest { display_path: display_path.clone(), entries };
					match self.documents.splice_conflict_file(request).await {
						Ok(Some(result)) => {
							for id in &result.resolved_ids {
								self.conflicts.remove(*id);
							}
							resolved = resolved.saturating_add(result.resolved_ids.len());
							echo_trimmed =
								echo_trimmed.saturating_add(result.echo_trimmed);
							byte_len = byte_len.saturating_add(result.write.byte_len);
							succeeded.push(display_path);
						},
						Ok(None) => {
							failed.push(ConflictBulkFailure {
								path: display_path,
								message: sf!(
									"bulk conflict splices are unavailable in this deployment"
								),
							});
						},
						Err(WriteCommitError::Rejected(fault)) => {
							failed.push(ConflictBulkFailure {
								path: display_path,
								message: Str::new(fault.to_string()),
							});
						},
						Err(WriteCommitError::EffectsUnknown { reason }) => {
							yield Ev::Aborted(Abort::EffectsUnknown {
								reason: sf!(
									"bulk conflict resolution committed {} files before \
													 an uncertain outcome for {display_path}: {reason}",
									succeeded.len()
								),
							});
							return;
						},
					}
				}
				if succeeded.is_empty() {
					let mut message =
						String::from("conflict://* left every file unchanged:");
					for failure in &failed {
						write!(message, "\n  {}: {}", failure.path, failure.message)
							.expect("writing to String cannot fail");
					}
					yield done(Err(Fault::Document { message: Str::new(message) }));
					return;
				}
				let payload = Payload {
					resolved_path: path.clone(),
					display_path: path.clone(),
					canonical_recovery,
					byte_len,
					reported_len,
					disposition: WriteDisposition::Overwrote,
					stripped_wrapper: stripped.stripped,
					made_executable: false,
					snapshot_tag: None,
					operation: WriteOperation::ConflictBulk {
						resolved,
						succeeded,
						failed,
						echo_trimmed,
					},
				};
				for diag in diags(&payload) {
					yield Ev::Diag(diag);
				}
				yield done(Ok(payload));
				return;
			}
			let resource_request = match route_resource_mutation(&path, stripped.text.clone()) {
				Ok(request) => request,
				Err(error) => {
					yield done(Err(Fault::Document { message: Str::new(error.to_string()) }));
					return;
				},
			};
			if let Some(request) = resource_request {
				let operation = self.documents.write_resource(request).fuse();
				let interruption = params.next_interrupt().fuse();
				pin_mut!(operation, interruption);
				select_biased! {
					result = operation => match result {
						Ok(Some(receipt)) => {
							let payload = Payload {
								resolved_path: receipt.canonical_uri.clone(),
								display_path: receipt.canonical_uri.clone(),
								canonical_recovery,
								byte_len: receipt.byte_len,
								reported_len,
								disposition: WriteDisposition::Overwrote,
								stripped_wrapper: stripped.stripped,
								made_executable: false,
								snapshot_tag: None,
								operation: WriteOperation::Resource {
									uri: receipt.canonical_uri,
									revision: receipt.revision,
								},
							};
							for diag in diags(&payload) {
								yield Ev::Diag(diag);
							}
							yield done(Ok(payload));
							return;
						},
						Ok(None) => {
							yield done(Err(Fault::UnsupportedScheme {
								scheme: Str::new(path.split_once(':').map_or("resource", |(scheme, _)| scheme)),
							}));
							return;
						},
						Err(WriteCommitError::Rejected(fault)) => {
							yield done(Err(fault));
							return;
						},
						Err(WriteCommitError::EffectsUnknown { reason }) => {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
							return;
						},
					},
					interrupt = interruption => {
						yield interrupt_event(interrupt, true);
						return;
					},
				}
			}
			if conflict_request.is_none() && let Some(fault) = reject_uri_like_target(&path) {
				yield done(Err(fault));
				return;
			}
			if let Some(request) = conflict_request {
				let id = request.entry.id;
				let operation = self.documents.splice_conflict(request).fuse();
				let interruption = params.next_interrupt().fuse();
				pin_mut!(operation, interruption);
				select_biased! {
					result = operation => match result {
						Ok(Some(result)) => {
							self.conflicts.remove(id);
							let payload = Payload {
								resolved_path: result.write.resolved_path,
								display_path: result.write.display_path,
								canonical_recovery: canonical_recovery.clone(),
								byte_len: result.write.byte_len,
								reported_len,
								disposition: result.write.disposition,
								stripped_wrapper: stripped.stripped,
								made_executable: result.write.made_executable,
								snapshot_tag: result.write.snapshot_tag,
								operation: WriteOperation::ConflictSplice {
									id,
									start_line: result.range.0,
									end_line: result.range.1,
									echo_trimmed: result.echo_trimmed,
								},
							};
							for diag in diags(&payload) {
								yield Ev::Diag(diag);
							}
							yield done(Ok(payload));
						},
						Ok(None) => yield done(Err(Fault::Document {
							message: sf!(
								"conflict:// writes are unavailable in this deployment",
							),
						})),
						Err(WriteCommitError::Rejected(fault)) => yield done(Err(fault)),
						Err(WriteCommitError::EffectsUnknown { reason }) => {
							yield Ev::Aborted(Abort::EffectsUnknown { reason });
						},
					},
					interrupt = interruption => {
						yield interrupt_event(interrupt, true);
					},
				}
				return;
			}

			let archive_result = {
				let control = SpecialWriteControl::new();
				let operation = self.documents.write_archive_member(
					path.clone(),
					Bytes::copy_from_slice(stripped.text.as_bytes()),
					control.clone(),
				).fuse();
				let interruption = params.next_interrupt().fuse();
				pin_mut!(operation, interruption);
				select_biased! {
					result = operation => match result {
						Ok(result) => result,
						Err(fault) => {
							yield done(Err(Fault::Document { message: fault.message }));
							return;
						},
					},
					interrupt = interruption => {
						let effects_started =
							control.cancel() == SpecialWriteCancellation::EffectsUnknown;
						yield interrupt_event(interrupt, effects_started);
						return;
					},
				}
			};
			if let Some(result) = archive_result {
				let payload = special_payload(
					result,
					stripped.stripped,
					reported_len,
					canonical_recovery.clone(),
				);
				for diag in diags(&payload) {
					yield Ev::Diag(diag);
				}
				yield done(Ok(payload));
				return;
			}

			let sqlite_result = {
				let control = SpecialWriteControl::new();
				let operation = self.documents.write_sqlite_row(
					path.clone(),
					stripped.text.clone(),
					control.clone(),
				).fuse();
				let interruption = params.next_interrupt().fuse();
				pin_mut!(operation, interruption);
				select_biased! {
					result = operation => match result {
						Ok(result) => result,
						Err(fault) => {
							yield done(Err(Fault::Document { message: fault.message }));
							return;
						},
					},
					interrupt = interruption => {
						let effects_started =
							control.cancel() == SpecialWriteCancellation::EffectsUnknown;
						yield interrupt_event(interrupt, effects_started);
						return;
					},
				}
			};
			if let Some(result) = sqlite_result {
				let payload = special_payload(
					result,
					stripped.stripped,
					reported_len,
					canonical_recovery.clone(),
				);
				for diag in diags(&payload) {
					yield Ev::Diag(diag);
				}
				yield done(Ok(payload));
				return;
			}

			let literal = {
				let probe = self.documents.probe_literal(path.clone()).fuse();
				let interruption = params.next_interrupt().fuse();
				pin_mut!(probe, interruption);
				select_biased! {
					result = probe => match result {
						Ok(result) => result,
						Err(fault) => {
							yield done(Err(fault));
							return;
						},
					},
					interrupt = interruption => {
						yield interrupt_event(interrupt, false);
						return;
					},
				}
			};
			if literal == LiteralPathProbe::Missing {
				if let Some(count) = read_selector_list_misfire(&path) {
					yield done(Err(Fault::ReadSelectorListMisfire { target: path, count }));
					return;
				}
				if stripped.text.is_empty() {
					let split = crate::read::selector::split_path_and_selector(&path);
					if let Some(selector) = split.selector.map(Str::new) {
						yield done(Err(Fault::ReadSelectorMisfire {
							target: path.clone(),
							selector,
						}));
						return;
					}
				}
			}

			let request = PlainWriteRequest {
				path,
				content: stripped.text,
				format_policy: self.format_policy,
				guard_generated: self.guard_generated,
			};
			let operation = self.documents.write_plain(request).fuse();
			let interruption = params.next_interrupt().fuse();
			pin_mut!(operation, interruption);
			select_biased! {
				result = operation => match result {
					Ok(result) => {
						let payload = Payload {
							resolved_path: result.resolved_path,
							display_path: result.display_path,
							canonical_recovery,
							byte_len: result.byte_len,
							reported_len,
							disposition: result.disposition,
							stripped_wrapper: stripped.stripped,
							made_executable: result.made_executable,
							snapshot_tag: result.snapshot_tag,
							operation: WriteOperation::Plain,
						};
						for diag in diags(&payload) {
							yield Ev::Diag(diag);
						}
						yield done(Ok(payload));
					},
					Err(WriteCommitError::Rejected(fault)) => yield done(Err(fault)),
					Err(WriteCommitError::EffectsUnknown { reason }) => {
						yield Ev::Aborted(Abort::EffectsUnknown { reason });
					},
				},
				interrupt = interruption => {
					yield interrupt_event(interrupt, true);
				},
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		let Some(mut output) = TextProjection::new(*caps) else {
			return Vec::new();
		};
		match view {
			Ok(payload) => {
				let rendered = render_payload(payload);
				output.push(&rendered);
			},
			Err(fault) => {
				let rendered = fault.to_string();
				output.push(&rendered);
			},
		}
		output.finish()
	}
}

#[derive(Debug)]
struct StrippedContent {
	text:     Str,
	stripped: bool,
}

fn strip_write_content(content: &str) -> StrippedContent {
	let lines: Vec<&str> = content.split('\n').collect();
	if let Some(cleaned) = strip_hashline_prefixes(&lines) {
		return StrippedContent { text: Str::new(cleaned.join("\n")), stripped: true };
	}
	let Some(header_index) = lines.iter().position(|line| !line.trim().is_empty()) else {
		return StrippedContent { text: Str::new(content), stripped: false };
	};
	if !is_loose_hashline_header(lines[header_index]) {
		return StrippedContent { text: Str::new(content), stripped: false };
	}
	let mut without_header = Vec::with_capacity(lines.len().saturating_sub(1));
	without_header.extend_from_slice(&lines[..header_index]);
	without_header.extend_from_slice(&lines[header_index + 1..]);
	if let Some(cleaned) = strip_hashline_prefixes(&without_header) {
		return StrippedContent { text: Str::new(cleaned.join("\n")), stripped: true };
	}
	StrippedContent { text: Str::new(content), stripped: false }
}

fn strip_hashline_prefixes(lines: &[&str]) -> Option<Vec<String>> {
	let mut content_lines = 0usize;
	let mut prefixed_lines = 0usize;
	for line in lines {
		if line.is_empty() || is_read_metadata_line(line) || is_strict_hashline_header(line) {
			continue;
		}
		content_lines += 1;
		if strip_one_hashline_prefix(line).is_some() {
			prefixed_lines += 1;
		}
	}
	if content_lines == 0 || content_lines != prefixed_lines {
		return None;
	}
	Some(
		lines
			.iter()
			.filter(|line| !is_read_metadata_line(line) && !is_strict_hashline_header(line))
			.map(|line| {
				let mut current = *line;
				while let Some(stripped) = strip_one_hashline_prefix(current) {
					current = stripped;
				}
				current.to_owned()
			})
			.collect(),
	)
}

fn strip_one_hashline_prefix(line: &str) -> Option<&str> {
	let mut rest = line.trim_start();
	if let Some(after) = rest.strip_prefix(">>>").or_else(|| rest.strip_prefix(">>")) {
		rest = after.trim_start();
	}
	if matches!(rest.as_bytes().first(), Some(b'+' | b'*' | b'-')) {
		rest = rest[1..].trim_start();
	}
	let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 || !matches!(rest.as_bytes().get(digits), Some(b':' | b'|')) {
		return None;
	}
	Some(&rest[digits + 1..])
}

fn is_strict_hashline_header(line: &str) -> bool {
	let Some(inner) = line
		.trim()
		.strip_prefix('[')
		.and_then(|line| line.strip_suffix(']'))
	else {
		return false;
	};
	let Some((path, tag)) = inner.rsplit_once('#') else {
		return false;
	};
	!path.is_empty()
		&& !path.contains(['#', '\r', '\n'])
		&& tag.len() == 4
		&& tag.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_loose_hashline_header(line: &str) -> bool {
	let Some(inner) = line
		.trim()
		.strip_prefix('[')
		.and_then(|line| line.strip_suffix(']'))
	else {
		return false;
	};
	let Some((path, tag)) = inner.rsplit_once('#') else {
		return false;
	};
	!path.is_empty()
		&& !path.contains(['#', '\r', '\n'])
		&& !tag.bytes().any(|byte| byte.is_ascii_whitespace())
}

fn is_read_metadata_line(line: &str) -> bool {
	let trimmed = line.trim();
	if matches!(trimmed, "…" | "...") {
		return true;
	}
	if trimmed.starts_with('[') && trimmed.ends_with(']') {
		let inner = &trimmed[1..trimmed.len() - 1];
		if (inner.starts_with("Showing lines ") || inner.contains("ln elided;"))
			&& (inner.contains("Use :") || inner.contains("re-read needed ranges"))
		{
			return true;
		}
	}
	let Some((range, body)) = trimmed.split_once(':') else {
		return false;
	};
	let Some((start, end)) = range.split_once('-') else {
		return false;
	};
	start.trim().bytes().all(|byte| byte.is_ascii_digit())
		&& end.trim().bytes().all(|byte| byte.is_ascii_digit())
		&& (body.contains('…') || body.contains("..."))
}

fn unwrap_hashline_header_path(path: &str) -> &str {
	let trimmed = path.trim_end();
	let Some(inner) = trimmed
		.strip_prefix('[')
		.and_then(|value| value.strip_suffix(']'))
	else {
		return path;
	};
	if inner.is_empty() {
		return path;
	}
	if let Some((path_part, tag)) = inner.rsplit_once('#') {
		if path_part.is_empty()
			|| path_part.contains('#')
			|| tag.len() != 4
			|| !tag.bytes().all(|byte| byte.is_ascii_hexdigit())
		{
			return path;
		}
		return path_part;
	}
	if inner.contains('#') { path } else { inner }
}

fn read_selector_list_misfire(target: &str) -> Option<usize> {
	if !target.contains(';') {
		return None;
	}
	let mut count = 0usize;
	for segment in target.split(';') {
		let trimmed = segment.trim();
		if trimmed.is_empty()
			|| selector::split_path_and_selector(trimmed)
				.selector
				.is_none()
		{
			return None;
		}
		count += 1;
	}
	(count >= 2).then_some(count)
}

fn reject_uri_like_target(target: &str) -> Option<Fault> {
	let trimmed = target.trim();
	if windows_absolute(trimmed) {
		return None;
	}
	let colon = trimmed.find(':')?;
	let scheme = &trimmed[..colon];
	if !valid_uri_scheme(scheme) {
		return None;
	}
	let suffix = &trimmed[colon + 1..];
	if suffix.starts_with("//") {
		return Some(Fault::UnsupportedScheme { scheme: Str::new(scheme.to_ascii_lowercase()) });
	}
	if !suffix.starts_with('/') {
		return None;
	}
	let rest = suffix.trim_start_matches('/');
	let guidance = device_guidance(Some(rest));
	Some(Fault::UriLikeTarget {
		message: sf!(
			"Unknown URI-like write target '{trimmed}'.{guidance} Prefix the path with './' to write \
			 it as a filesystem path."
		),
	})
}

fn device_guidance(tool_path: Option<&str>) -> String {
	match tool_path.filter(|path| !path.is_empty()) {
		Some(path) => format!(
			" `dyn` runs in the bash tool: `dyn` lists devices, `dyn {path} --help` shows usage, \
			 `dyn {path} [args…]` invokes."
		),
		None => " `dyn` runs in the bash tool: `dyn` lists devices, `dyn <device> --help` shows \
		         usage, `dyn <device> [args…]` invokes."
			.to_owned(),
	}
}

fn valid_uri_scheme(scheme: &str) -> bool {
	let mut bytes = scheme.bytes();
	matches!(bytes.next(), Some(first) if first.is_ascii_alphabetic())
		&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
}

fn windows_absolute(path: &str) -> bool {
	path.as_bytes().get(1) == Some(&b':')
		&& path
			.as_bytes()
			.get(2)
			.is_some_and(|byte| matches!(byte, b'/' | b'\\'))
		&& path.as_bytes()[0].is_ascii_alphabetic()
}

fn special_payload(
	result: backends::ResultPayload,
	stripped_wrapper: bool,
	reported_len: u64,
	canonical_recovery: Option<Str>,
) -> Payload {
	Payload {
		resolved_path: result.resolved_path,
		display_path: result.display_path,
		canonical_recovery,
		byte_len: result.byte_len,
		reported_len,
		disposition: result.disposition,
		stripped_wrapper,
		made_executable: false,
		snapshot_tag: result.snapshot_tag,
		operation: result.operation,
	}
}

fn diags(payload: &Payload) -> impl Iterator<Item = Diag> {
	let echo_trimmed = match &payload.operation {
		WriteOperation::ConflictSplice { echo_trimmed, .. }
		| WriteOperation::ConflictBulk { echo_trimmed, .. } => *echo_trimmed,
		_ => 0,
	};
	[
		payload
			.canonical_recovery
			.as_ref()
			.map(|recovery| Diag::info(DiagKind::PathRecovered, recovery.clone())),
		payload.stripped_wrapper.then(|| {
			Diag::info(DiagKind::ContentNormalized, "stripped hashline display prefixes from content")
		}),
		payload
			.made_executable
			.then(|| Diag::info(DiagKind::MadeExecutable, "added execute bits for the shebang")),
		(echo_trimmed > 0).then(|| {
			Diag::info(
				DiagKind::ContentNormalized,
				"dropped duplicated echo lines next to the conflict region",
			)
			.omitted(u64::try_from(echo_trimmed).unwrap_or(u64::MAX), Unit::Lines)
		}),
	]
	.into_iter()
	.flatten()
}

fn render_payload(payload: &Payload) -> String {
	let mut output = String::new();
	if let Some(tag) = &payload.snapshot_tag {
		output.push_str(&format_hashline_header(&payload.display_path, tag));
		output.push('\n');
	}
	match &payload.operation {
		WriteOperation::Resource { uri, revision } => {
			write!(output, "Wrote {} bytes to {uri} (revision {revision})", payload.byte_len)
				.expect("writing to String cannot fail");
		},
		WriteOperation::Plain | WriteOperation::ArchiveMember => write!(
			output,
			"Successfully wrote {} bytes to {}",
			payload.reported_len, payload.display_path
		)
		.expect("writing to String cannot fail"),
		WriteOperation::ConflictSplice { id, start_line, end_line, .. } => {
			write!(
				output,
				"Resolved conflict #{id} at {}:L{start_line}-L{end_line}",
				payload.display_path
			)
			.expect("writing to String cannot fail");
		},
		WriteOperation::ConflictBulk { resolved, succeeded, failed, .. } => {
			write!(output, "Resolved {resolved} conflicts across {} files", succeeded.len())
				.expect("writing to String cannot fail");
			for path in succeeded {
				write!(output, "\n  {path}: committed").expect("writing to String cannot fail");
			}
			if !failed.is_empty() {
				output.push_str("\nFiles left unchanged for retry:");
				for failure in failed {
					write!(output, "\n  {}: {}", failure.path, failure.message)
						.expect("writing to String cannot fail");
				}
			}
		},
		WriteOperation::SqliteInsert { table } => {
			write!(output, "Inserted row into {table}").expect("writing to String cannot fail");
		},
		WriteOperation::SqliteUpdate { table, key, changed } => {
			if *changed {
				write!(output, "Updated row '{key}' in {table}")
					.expect("writing to String cannot fail");
			} else {
				write!(output, "No row updated in {table} for key '{key}'")
					.expect("writing to String cannot fail");
			}
		},
		WriteOperation::SqliteDelete { table, key, changed } => {
			if *changed {
				write!(output, "Deleted row '{key}' from {table}")
					.expect("writing to String cannot fail");
			} else {
				write!(output, "No row deleted from {table} for key '{key}'")
					.expect("writing to String cannot fail");
			}
		},
	}
	output
}

const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}

fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) if issue.kind == ArgIssueKind::Aborted => {
			Ev::Aborted(Abort::InputDropped)
		},
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn interrupt_event(
	interrupt: Result<omp_tool::Interrupt, InterruptWaitError>,
	effects_started: bool,
) -> Ev<Update, Payload, Fault> {
	let reason = match interrupt {
		Ok(interrupt) => interrupt.reason,
		Err(InterruptWaitError::Closed) if effects_started => {
			sf!("invocation owner disappeared during write transaction")
		},
		Err(InterruptWaitError::Closed) => sf!("write resource owner disappeared"),
		Err(InterruptWaitError::Protocol(message)) => return Ev::Args(protocol_issue(message)),
	};
	if effects_started {
		Ev::Aborted(Abort::EffectsUnknown { reason })
	} else {
		Ev::Aborted(Abort::Interrupted { reason })
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"path":"src/main.rs","content":"fn main() {{}}\n"}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use omp_tool::{Omitted, Severity};

	use super::*;

	#[test]
	fn strips_strict_hashline_read_echo() {
		let stripped = strip_write_content("[src/a.rs#A1B2]\n1:fn main() {\n2:}\n");
		assert!(stripped.stripped);
		assert_eq!(stripped.text, "fn main() {\n}\n");
	}

	#[test]
	fn strips_loose_header_only_when_body_is_prefixed() {
		let stripped = strip_write_content("[src/a.rs#stale]\n10:first\n11:second");
		assert!(stripped.stripped);
		assert_eq!(stripped.text, "first\nsecond");
		let literal = strip_write_content("[src/a.rs#stale]\nfirst\nsecond");
		assert!(!literal.stripped);
	}

	#[test]
	fn preserves_literal_numbered_content_when_not_uniform() {
		let stripped = strip_write_content("1:first\nliteral\n3:third");
		assert!(!stripped.stripped);
		assert_eq!(stripped.text, "1:first\nliteral\n3:third");
	}

	#[test]
	fn selector_misfire_messages_match_pi() {
		assert_eq!(
			Fault::ReadSelectorMisfire { target: "a.rs:1-2".into(), selector: "1-2".into() }
				.to_string(),
			"write target 'a.rs:1-2' ends with a read-tool selector ':1-2' and no such file exists — \
			 refusing to create a literal file by that name. If you meant to read it, use read({ \
			 path: \"a.rs:1-2\" }). If you truly intend to create this file, pass its contents in \
			 `content` (a non-empty write is never blocked)."
		);
		assert_eq!(
			Fault::ReadSelectorListMisfire { target: "a:1-2;b:3-4".into(), count: 2 }.to_string(),
			"write target 'a:1-2;b:3-4' is a semicolon-joined list of 2 read-tool selectors, not a \
			 filesystem path — refusing to create it. write creates a single file; issue one read() \
			 per path to read these ranges (e.g. read({ path: \"<one path>:<range>\" }))."
		);
	}

	#[test]
	fn renders_plain_write_without_structured_diags() {
		let payload = Payload {
			resolved_path:      "/repo/bin/run".into(),
			display_path:       "bin/run".into(),
			canonical_recovery: None,
			byte_len:           10,
			reported_len:       10,
			disposition:        WriteDisposition::Created,
			stripped_wrapper:   true,
			made_executable:    true,
			snapshot_tag:       Some("A1B2".into()),
			operation:          WriteOperation::Plain,
		};
		assert_eq!(
			render_payload(&payload),
			"[bin/run#A1B2]\nSuccessfully wrote 10 bytes to bin/run"
		);
		let diags = diags(&payload).collect::<Vec<_>>();
		assert_eq!(diags.len(), 2);
		assert_eq!(diags[0].native_kind(), Some(DiagKind::ContentNormalized));
		assert_eq!(diags[0].severity, Severity::Info);
		assert_eq!(diags[0].continuation, None);
		assert_eq!(diags[0].artifact, None);
		assert_eq!(diags[0].omitted, None);
		assert_eq!(diags[1].native_kind(), Some(DiagKind::MadeExecutable));
		assert_eq!(diags[1].severity, Severity::Info);
		assert_eq!(diags[1].continuation, None);
		assert_eq!(diags[1].artifact, None);
		assert_eq!(diags[1].omitted, None);
	}

	#[test]
	fn conflict_echo_and_path_recovery_are_structured_diags() {
		let payload = Payload {
			resolved_path:      "/repo/src/a.rs".into(),
			display_path:       "src/a.rs".into(),
			canonical_recovery: Some("\"src/a.rs\" -> src/a.rs".into()),
			byte_len:           10,
			reported_len:       10,
			disposition:        WriteDisposition::Overwrote,
			stripped_wrapper:   false,
			made_executable:    false,
			snapshot_tag:       None,
			operation:          WriteOperation::ConflictSplice {
				id:           3,
				start_line:   4,
				end_line:     8,
				echo_trimmed: 2,
			},
		};
		assert_eq!(render_payload(&payload), "Resolved conflict #3 at src/a.rs:L4-L8");
		let diags = diags(&payload).collect::<Vec<_>>();
		assert_eq!(diags.len(), 2);
		assert_eq!(diags[0].native_kind(), Some(DiagKind::PathRecovered));
		assert_eq!(diags[0].severity, Severity::Info);
		assert_eq!(diags[0].continuation, None);
		assert_eq!(diags[0].artifact, None);
		assert_eq!(diags[0].omitted, None);
		assert_eq!(diags[1].native_kind(), Some(DiagKind::ContentNormalized));
		assert_eq!(diags[1].severity, Severity::Info);
		assert_eq!(diags[1].continuation, None);
		assert_eq!(diags[1].artifact, None);
		assert_eq!(diags[1].omitted, Some(Omitted { count: 2, unit: Unit::Lines }));
	}

	#[test]
	fn renders_archive_count_with_pi_utf16_length() {
		let payload = Payload {
			resolved_path:      "/repo/a.zip".into(),
			display_path:       "a.zip:x.txt".into(),
			canonical_recovery: None,
			byte_len:           "é😀".len() as u64,
			reported_len:       "é😀".encode_utf16().count() as u64,
			disposition:        WriteDisposition::Created,
			stripped_wrapper:   false,
			made_executable:    false,
			snapshot_tag:       None,
			operation:          WriteOperation::ArchiveMember,
		};
		assert_eq!(render_payload(&payload), "Successfully wrote 3 bytes to a.zip:x.txt");
	}

	#[test]
	fn renders_sqlite_row_outcomes_exactly() {
		let payload = Payload {
			resolved_path:      "/repo/data.db".into(),
			display_path:       "data.db:items:7".into(),
			canonical_recovery: None,
			byte_len:           14,
			reported_len:       14,
			disposition:        WriteDisposition::Overwrote,
			stripped_wrapper:   false,
			made_executable:    false,
			snapshot_tag:       None,
			operation:          WriteOperation::SqliteUpdate {
				table:   "items".into(),
				key:     "7".into(),
				changed: false,
			},
		};
		assert_eq!(render_payload(&payload), "No row updated in items for key '7'");
	}

	#[test]
	fn rejects_uri_shapes_without_blocking_windows_paths() {
		assert_eq!(
			reject_uri_like_target("skill://x")
				.expect("fault")
				.to_string(),
			"skill:// targets are not supported yet"
		);
		assert!(reject_uri_like_target("C:\\tmp\\x").is_none());

		let fault = reject_uri_like_target("device:/custom")
			.expect("fault rejected")
			.to_string();
		assert!(fault.contains("`dyn` runs in the bash tool"));
		assert!(fault.contains("`dyn` lists devices"));
		assert!(fault.contains("`dyn custom --help` shows usage"));
		assert!(fault.contains("`dyn custom [args…]` invokes"));
	}
}
