//! Streaming hashline edits over one revision-pinned multi-document
//! transaction.

pub mod apply_patch;
pub mod observer;
pub mod projection;
pub mod replace;
use std::{fmt::Write as _, future, future::Future, ops};

pub use apply_patch::{
	FreeformEditParams, FreeformEditTool, PatchEditEntry, PatchOp, PatchParams, apply_patch_tool,
	apply_patch_tool_with_observer, legacy_patch_tool_with_observer, patch_tool,
	patch_tool_with_observer, sloppy_tool, sloppy_tool_with_observer,
};
use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt, Stream, pin_mut, select_biased};
use observer::{AppliedEditSnapshot, EditObserver, PendingBlackbox};
use omp_core::{IntoStr, Str, sf};
use omp_edit::{
	EditMode,
	diff_string::{
		BlockContextSource, CompactDiffOptions, build_compact_diff_preview, generate_diff_string,
	},
	grammar,
	modes::hashline::{
		apply::{ApplyOptions, EmptyPaste, apply_edits, is_head_tail_only},
		format::format_hashline_header,
		input::{Parsed, Patch, SplitOptions},
		messages::HEADTAIL_DRIFT_WARNING,
		mismatch::{MismatchDetails, format_mismatch_message},
		recovery::{RecoveryChain, recover_text},
		types::{BlockOpKind, Edit, FileOp},
	},
	store::{Clipboard, file_hash},
	text::{LineEnding, detect_line_ending, normalize_to_lf, restore_line_endings, strip_bom},
};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, ArgPath, CallOutcome, CommitError, Constraint, Diag, DiagKind,
	Dialect, DocEffects, Effects, Ev, IncomingParams, InterruptWaitError, LiftedCall, ParamError,
	Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec, ToolTerminal,
};
pub use replace::{
	LegacyReplaceOperation, LegacyReplaceParams, ReplaceParams, ReplaceTool,
	legacy_replace_tool_with_observer, replace_tool, replace_tool_with_observer,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tracing::Instrument as _;

use crate::{
	path::{HostPaths, normalize_target},
	render::TextProjection,
};

/// One registered edit argument dialect.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EditDialectRegistration {
	/// Revision family.
	pub family:   &'static str,
	/// Revision number within `family`.
	pub revision: u16,
	/// Capability dialect advertised to a model.
	pub dialect:  Dialect,
}

/// Every built-in edit revision retained for current selection or historical
/// replay.
pub const EDIT_DIALECTS: &[EditDialectRegistration] = &[
	EditDialectRegistration { family: "rep", revision: 1, dialect: Dialect::Replace },
	EditDialectRegistration { family: "rep", revision: 2, dialect: Dialect::Replace },
	EditDialectRegistration { family: "hl", revision: 1, dialect: Dialect::Hashline },
	EditDialectRegistration { family: "patch", revision: 1, dialect: Dialect::Patch },
	EditDialectRegistration { family: "patch", revision: 2, dialect: Dialect::Patch },
	EditDialectRegistration { family: "apply_patch", revision: 1, dialect: Dialect::ApplyPatch },
	EditDialectRegistration { family: "sloppy", revision: 1, dialect: Dialect::Sloppy },
];

/// Provenance of an edit revision decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EditRevisionSource {
	/// An embedder fixed the tool dialect for its protocol bridge.
	EmbedderPin,
	/// Native strict-edit compatibility forced hashline.
	OperatorStrict,
	/// The model catalog selected a known-compatible dialect.
	ModelRule,
	/// The process-level `OMP_EDIT_DIALECT` selection won.
	Environment,
	/// The layered `edit.revision` setting won.
	Setting,
	/// The built-in hashline dialect won.
	Default,
}

/// Inputs for the data-only edit dialect cascade.
///
/// Model classification stays outside this module: callers resolve their
/// catalog rule to a registered `family.rev`, then this cascade validates and
/// records its precedence without coupling edit behavior to model names.
#[derive(Clone, Copy, Debug, Default)]
pub struct EditRevisionCandidates<'a> {
	/// Catalog-selected revision such as `rep.2`.
	pub model_rule:     Option<&'a Rev>,
	/// Optional `OMP_EDIT_DIALECT` value.
	pub environment:    Option<&'a str>,
	/// Optional layered `edit.revision` value.
	pub setting:        Option<&'a str>,
	/// Embedder-fixed revision, which cannot be overridden.
	pub pin:            Option<&'a Rev>,
	/// Force hashline regardless of catalog, environment, or layered setting.
	pub force_hashline: bool,
	/// Reject an unrecognized configured revision instead of falling through.
	pub strict:         bool,
}

/// One validated result from [`resolve_edit_revision`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedEditRevision {
	/// Selected registered revision.
	pub revision: Rev,
	/// Winning source in the cascade.
	pub source:   EditRevisionSource,
}

/// Resolves edit mode as a registered revision, never as a mutable mode flag.
///
/// The caller may then derive [`PromptCaps::dialect`] with
/// `PromptCaps::for_tool`; [`revision_matches_caps`] validates that no
/// projection was paired with an incompatible dialect.
pub fn resolve_edit_revision(
	candidates: EditRevisionCandidates<'_>,
) -> Result<ResolvedEditRevision, Str> {
	if let Some(pin) = candidates.pin {
		return registered_revision(pin, EditRevisionSource::EmbedderPin);
	}
	if candidates.force_hashline {
		return registered_revision(
			&Rev { family: sf!("hl"), n: 1 },
			EditRevisionSource::OperatorStrict,
		);
	}
	if let Some(rule) = candidates.model_rule {
		return registered_revision(rule, EditRevisionSource::ModelRule);
	}
	for (value, source) in [
		(candidates.environment, EditRevisionSource::Environment),
		(candidates.setting, EditRevisionSource::Setting),
	] {
		let Some(value) = value else { continue };
		match value.parse::<Rev>() {
			Ok(revision) if is_selectable_edit_revision(&revision) => {
				return Ok(ResolvedEditRevision { revision, source });
			},
			_ if candidates.strict => {
				return Err(
					format!(
						"unknown edit revision {value:?}; use hl.1, rep.2, patch.2, apply_patch.1, or \
						 sloppy.1"
					)
					.into(),
				);
			},
			_ => {},
		}
	}
	registered_revision(&Rev { family: sf!("hl"), n: 1 }, EditRevisionSource::Default)
}

/// Checks that projection capabilities came from the selected dialect family.
pub fn revision_matches_caps(revision: &Rev, caps: &PromptCaps) -> bool {
	is_registered_edit_revision(revision) && Dialect::for_rev(revision) == caps.dialect
}

fn registered_revision(
	revision: &Rev,
	source: EditRevisionSource,
) -> Result<ResolvedEditRevision, Str> {
	if is_selectable_edit_revision(revision) {
		Ok(ResolvedEditRevision { revision: revision.clone(), source })
	} else {
		Err(format!("edit revision {revision} is historical and cannot be selected").into())
	}
}

fn is_selectable_edit_revision(revision: &Rev) -> bool {
	is_registered_edit_revision(revision)
		&& !matches!((revision.family.as_str(), revision.n), ("rep" | "patch", 1))
}

fn is_registered_edit_revision(revision: &Rev) -> bool {
	EDIT_DIALECTS
		.iter()
		.any(|entry| entry.family == revision.family.as_str() && entry.revision == revision.n)
}
const DESCRIPTION: &str = include_str!("edit_prompt.txt");

/// Streaming arguments for `edit@hl.1`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Complete hashline input, including every `[PATH#TAG]` section header.
	#[schemars(description = "")]
	pub input: Str,
}

/// A dry-run projection emitted whenever another complete section becomes
/// applicable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditUpdate {
	/// Number of parsed low-level operations currently applied.
	pub applied_ops:   usize,
	/// Canonical target paths discovered from the streamed arguments.
	#[serde(default)]
	pub paths:         Vec<Str>,
	/// Compact, numbered preview of the current candidate.
	pub preview:       Str,
	/// Added rows represented by the preview source diff.
	pub added_lines:   usize,
	/// Removed rows represented by the preview source diff.
	pub removed_lines: usize,
}

/// One durable applied hashline operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AppliedOp {
	/// Stable operation family.
	pub kind:       Str,
	/// One-indexed line in the submitted section body.
	pub patch_line: usize,
	/// Authored operation sequence index.
	pub index:      usize,
}

/// The durable operation performed for one section.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionOp {
	/// Existing file content changed in place.
	Update,
	/// The section parsed and applied but changed no bytes.
	Noop,
	/// The file was removed.
	Delete,
	/// The file was moved, optionally after its content changed.
	Move,
}

/// One syntax-aware block resolution retained for projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolvedBlock {
	/// Authored source anchor.
	pub anchor_line: usize,
	/// Resolved first source line.
	pub start:       usize,
	/// Resolved last source line.
	pub end:         usize,
	/// Stable operation label used by the renderer.
	pub operation:   Str,
}

/// One resolved replacement retained independently of its authored dialect.
///
/// Byte-oriented engines retain these concrete line ranges and bodies so a
/// historical call can be re-expressed in another edit dialect without
/// guessing from model-authored search text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolvedEdit {
	/// Inclusive one-indexed source line.
	pub start: usize,
	/// Inclusive one-indexed source line.
	pub end:   usize,
	/// Replacement body without dialect sigils.
	pub body:  Vec<Str>,
}

/// Maximum total old/new snapshot bytes retained inline in one edit outcome.
pub const MAX_EDIT_SNAPSHOT_INLINE_BYTES: usize = 32_768;

/// Failure to durably retain an oversized edit snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SnapshotFault {
	/// No Environment blob authority was supplied.
	#[error("oversized edit snapshots require an Environment blob authority")]
	Unavailable,
	/// The Environment blob authority rejected durable placement.
	#[error("the Environment blob authority could not retain an edit snapshot")]
	Store,
}

/// Environment-owned durable storage for oversized snapshot bytes.
pub trait EditSnapshotStore: Send + Sync + 'static {
	/// Stores exact bytes and returns their typed content identity.
	fn store_snapshot(
		&self,
		bytes: Bytes,
	) -> impl Future<Output = Result<omp_tool::BlobRef, SnapshotFault>> + Send + '_;
}

/// Store used only by direct embeddings which do not supply an Environment
/// blob authority. Inline outcomes remain available; oversized ones fail.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSnapshotStore;

impl EditSnapshotStore for NoSnapshotStore {
	fn store_snapshot(
		&self,
		_bytes: Bytes,
	) -> impl Future<Output = Result<omp_tool::BlobRef, SnapshotFault>> + Send + '_ {
		future::ready(Err(SnapshotFault::Unavailable))
	}
}

/// Durable successful truth for one file section.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SectionPayload {
	/// Authored source path.
	pub path:                 Str,
	/// Canonical source path used for duplicate and snapshot checks.
	pub canonical_path:       Str,
	/// Operation performed by this section.
	pub op:                   SectionOp,
	/// Move destination when `op` is [`SectionOp::Move`].
	pub move_dest:            Option<Str>,
	/// Pinned document base revision.
	pub old_revision:         Str,
	/// Committed target revision, absent after deletion.
	pub new_revision:         Option<Str>,
	/// Sequence of applied operations.
	pub applied_ops:          Vec<AppliedOp>,
	/// Concrete edits sufficient to lift this outcome into another dialect.
	#[serde(default)]
	pub resolved_edits:       Vec<ResolvedEdit>,
	/// Whether the document host rebased the committed transition.
	pub rebased:              bool,
	/// Exact pre-edit bytes when retained inline.
	pub before:               Bytes,
	/// Blob identity of exact pre-edit bytes when the inline budget was
	/// exceeded.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub before_blob:          Option<omp_tool::BlobRef>,
	/// Exact post-edit bytes when retained inline, empty after deletion or
	/// spill.
	pub after:                Bytes,
	/// Blob identity of exact post-edit bytes when the inline budget was
	/// exceeded.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub after_blob:           Option<omp_tool::BlobRef>,
	/// Hashline header for the resulting file, absent after deletion.
	pub header:               Option<Str>,
	/// Complete numbered diff.
	pub diff:                 Str,
	/// Compact current-file preview.
	pub preview:              Str,
	/// First changed source line when known.
	pub first_changed_line:   Option<usize>,
	/// Syntax-aware block resolutions.
	pub block_resolutions:    Vec<ResolvedBlock>,
	/// Revision-bound LSP diagnostics for this committed section.
	#[serde(default)]
	pub diagnostics:          Vec<EditDiagnostic>,
	/// Whether the diagnostic batch reached quiescence inline.
	#[serde(default)]
	pub diagnostics_complete: bool,
}

/// Durable successful multi-file transaction truth.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Results in authored section order.
	pub sections: Vec<SectionPayload>,
}

/// Formatting requested of the document transaction coordinator.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
#[derive(Default)]
pub enum FormatPolicy {
	/// Never invoke a formatter.
	Disabled,
	/// Use a formatter when available, retaining committed bytes on formatter
	/// absence or failure.
	#[default]
	BestEffort,
	/// Require formatter availability and successful completion.
	Required,
}

omp_con::con_enum!(FormatPolicy);

/// Stale-base behavior requested of the transaction coordinator.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StalePolicy {
	/// Rebase only edits whose base spans do not overlap intervening changes.
	RebaseNonOverlapping,
}

/// Facts needed to prepare one authored section against shared session state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrepareRequest {
	/// Authored path from the section header.
	pub path:            Str,
	/// Optional four-hex snapshot tag from the section header.
	pub file_hash:       Option<Str>,
	/// Concrete one-indexed anchors used for stale mismatch context.
	pub anchor_lines:    Vec<usize>,
	/// Whether this dialect may operate against the current document without a
	/// displayed snapshot tag.
	pub allow_unpinned:  bool,
	/// Whether a missing final path may be leased for a create operation.
	pub allow_missing:   bool,
	/// Whether the document owner must reject generated files.
	pub guard_generated: bool,
}

/// How a missing authored edit path was recovered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathRecoveryHow {
	/// A retained snapshot matched both the filename and authored snapshot tag.
	FilenameSnapshotTag,
	/// Exactly one workspace path ended with the authored path components.
	WorkspaceSuffix,
}

/// Typed recovery facts retained by a prepared edit lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathRecovery {
	/// Missing path supplied by the model.
	pub authored: Str,
	/// Canonical path selected by the document host.
	pub resolved: Str,
	/// Recovery strategy which established the unique match.
	pub how:      PathRecoveryHow,
}

/// Borrowed view exposed by an opaque, revision-pinned prepared lease.
pub trait EditPrepared: Send + Sync {
	/// Canonical path pinned by this lease.
	fn path(&self) -> &Str;
	/// Model-facing path after any host path recovery.
	fn display_path(&self) -> &Str {
		self.path()
	}
	/// Opaque pinned live revision.
	fn base_revision(&self) -> &Str;
	/// Exact bytes at the pinned live revision.
	fn base_bytes(&self) -> &Bytes;
	/// Whether the pinned base revision names a present document.
	fn exists(&self) -> bool {
		true
	}
	/// Typed missing-path recoveries discovered while preparing this lease.
	fn path_recoveries(&self) -> &[PathRecovery] {
		&[]
	}
	/// Exact retained bytes named by the authored tag, or live bytes when
	/// untagged.
	fn authored_bytes(&self) -> &Bytes;
}

/// The final filesystem transition for one prepared section.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditAction {
	/// Replace the source file with these exact bytes.
	Write {
		/// Final file contents.
		content: Bytes,
	},
	/// Remove the source file.
	Delete,
	/// Move the source identity and persist the supplied final bytes.
	Move {
		/// New path for the source identity.
		destination: Str,
		/// Final contents persisted at the destination.
		content:     Bytes,
	},
}

/// One fully preflighted proposal in authored section order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditProposal {
	/// Final filesystem transition.
	pub action:        EditAction,
	/// Pinned base revision string.
	pub base_revision: Str,
	/// Configured stale-base handling policy.
	pub stale_policy:  StalePolicy,
	/// Configured code formatting policy.
	pub format_policy: FormatPolicy,
}

/// Severity of one revision-bound LSP diagnostic.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditDiagnosticSeverity {
	/// Error diagnostic.
	Error,
	/// Warning diagnostic.
	Warning,
	/// Informational diagnostic.
	Information,
	/// Hint diagnostic.
	Hint,
}

/// One LSP diagnostic proven to belong to the committed document revision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditDiagnostic {
	/// Committed byte range when the LSP position could be converted.
	pub range:    Option<ops::Range<u64>>,
	/// Diagnostic severity.
	pub severity: EditDiagnosticSeverity,
	/// Optional provider code.
	pub code:     Str,
	/// LSP source name.
	pub source:   Str,
	/// Human-readable diagnostic.
	pub message:  Str,
}

/// Resource-owned commit result for one authored section.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedSection {
	/// Committed target revision, absent after deletion.
	pub new_revision:         Option<Str>,
	/// Whether the resource rebased this section.
	pub rebased:              bool,
	/// Exact committed view bytes after formatting, absent after deletion.
	pub content:              Option<Bytes>,
	/// Revision-bound LSP diagnostics collected during the commit window.
	pub diagnostics:          Vec<EditDiagnostic>,
	/// Whether the LSP stream reached quiescence inside the inline deadline.
	pub diagnostics_complete: bool,
}

/// Structured successful response from the atomic transaction owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitResult {
	/// Results in authored section order.
	pub sections: Vec<CommittedSection>,
}

/// One conflicting base/current range retained from transaction rejection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Conflict {
	/// One-based starting line number of the conflicting range.
	pub start_line: usize,
	/// One-based ending line number of the conflicting range.
	pub end_line:   usize,
	/// Explanation of the line-range conflict.
	pub message:    Str,
}

/// Typed transaction rejection reason.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RejectionReason {
	/// Edit collided with intervening workspace edits.
	Conflict,
	/// Base revision is stale and cannot be automatically recovered.
	StaleUnrecoverable {
		/// Exact stale-snapshot diagnostic.
		message: Str,
	},
	/// Formatter execution failed on the edited document.
	Format {
		/// Exact formatter diagnostic.
		message: Str,
	},
	/// Submitted patch syntax or structure was invalid.
	InvalidPatch {
		/// Exact patch diagnostic.
		message: Str,
	},
}

/// Durable typed edit failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Fault {
	/// Transaction rejection classification.
	pub reason:    RejectionReason,
	/// List of conflicting line ranges, if applicable.
	pub conflicts: Vec<Conflict>,
}

impl Fault {
	fn invalid(message: impl IntoStr) -> Self {
		Self {
			reason:    RejectionReason::InvalidPatch { message: message.into_str() },
			conflicts: Vec::new(),
		}
	}

	fn stale(message: impl IntoStr) -> Self {
		Self {
			reason:    RejectionReason::StaleUnrecoverable { message: message.into_str() },
			conflicts: Vec::new(),
		}
	}
}

/// Session loop-guard result for one byte-identical edit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoopResult {
	/// Exact soft or hard diagnostic.
	pub diagnostic: Str,
	/// Whether this attempt reached the mandatory hard-failure threshold.
	pub escalate:   bool,
}

/// Truthful resource-owned commit failure classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditCommitError {
	/// Atomic transaction rejection; no section or clipboard state landed.
	Rejected(Fault),
	/// The resource cannot prove whether effects landed.
	EffectsUnknown {
		/// Why the document owner cannot determine the final state.
		reason: Str,
	},
}

/// Resource boundary implemented by the environment's document host.
pub trait EditDocuments: Send + Sync + 'static {
	/// Concrete owner of one pinned resource; values are moved together to
	/// commit.
	type Prepared: EditPrepared;

	/// Opens a section and resolves its authored snapshot through session state.
	fn prepare(
		&self,
		request: PrepareRequest,
	) -> impl Future<Output = Result<Self::Prepared, Fault>> + Send + '_;

	/// Starts a call-local clipboard retaining named session registers only.
	fn start_clipboard_batch(&self) -> Clipboard;

	/// Records one byte-identical result under canonical identity.
	fn record_noop(&self, canonical_path: &str, display_path: &str, input: Bytes) -> NoopResult;

	/// Clears one path's no-op streak after a real commit.
	fn reset_noop(&self, canonical_path: &str);

	/// Commits every proposal as one resource transaction and publishes named
	/// registers only if that transaction commits completely.
	fn commit<'a>(
		&'a self,
		prepared: Vec<&'a mut Self::Prepared>,
		proposals: Vec<EditProposal>,
		clipboard: Clipboard,
	) -> impl Future<Output = Result<CommitResult, EditCommitError>> + Send + 'a;
}

/// `edit@hl.1` executor.
pub struct EditTool<D, S = NoSnapshotStore> {
	documents:       D,
	snapshots:       S,
	format_policy:   FormatPolicy,
	observer:        EditObserver,
	guard_generated: bool,
	spec:            ToolSpec,
}

/// Returns the host-free `edit@hl.1` specification.
pub fn hashline_spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("edit"),
		rev:             Rev { family: sf!("hl"), n: 1 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Grammar {
			syntax:         omp_tool::GrammarSyntax::Lark,
			definition:     Str::new_static(
				grammar(EditMode::Hashline).expect("hashline mode ships a grammar"),
			),
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
			include_bytes!("edit.rs"),
		)
		.into(),
	}
}

/// Constructs the built-in hashline edit tool.
pub fn tool<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
) -> EditTool<D, NoSnapshotStore> {
	tool_with_snapshots(documents, NoSnapshotStore, format_policy)
}

/// Constructs hashline edit with the Environment's durable snapshot authority.
pub fn tool_with_snapshots<D: EditDocuments, S: EditSnapshotStore>(
	documents: D,
	snapshots: S,
	format_policy: FormatPolicy,
) -> EditTool<D, S> {
	tool_with_observer(documents, snapshots, format_policy, EditObserver::default(), true)
}

/// Constructs hashline edit with snapshot storage and syntax observation.
pub fn tool_with_observer<D: EditDocuments, S: EditSnapshotStore>(
	documents: D,
	snapshots: S,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
) -> EditTool<D, S> {
	EditTool {
		documents,
		snapshots,
		format_policy,
		observer,
		guard_generated,
		spec: hashline_spec(),
	}
}

impl<D: EditDocuments, S: EditSnapshotStore> Tool for EditTool<D, S> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = EditUpdate;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<EditUpdate, Payload, Fault>> + Send + 'c {
		let span = tracing::debug_span!(
			"edit_execution",
			revision = "hl.1",
			path_count = tracing::field::Empty,
			path = tracing::field::Empty,
		);
		stream! {
			let Params { input } = match params.whole::<Params>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};

			if input.trim().is_empty() {
				yield done_fault(Fault::invalid("No hashline sections found in input."));
				return;
			}

			let patch = match Patch::parse(&input, &SplitOptions::default()) {
				Ok(patch) if !patch.sections.is_empty() => patch,
				Ok(_) => {
					yield done_fault(Fault::invalid("No hashline sections found in input."));
					return;
				},
				Err(error) => {
					yield Ev::Args(ArgIssue {
						path: vec![ArgPath::Key(sf!("input"))],
						expected: sf!("complete hashline input beginning with [PATH#TAG]"),
						kind: ArgIssueKind::Malformed,
						example: Some(sf!("[src/a.rs#1A2B]\nPUT 1.=1:\n+replacement")),
						found: Some(error.to_string().into()),
					});
					return;
				},
			};
			span.record("path_count", patch.sections.len());
			if let Some(section) = patch.sections.first() {
				span.record("path", tracing::field::display(&section.path));
			}

			let mut parsed_sections = Vec::with_capacity(patch.sections.len());
			for section in patch.sections {
				let normalized = normalize_target(&section.path, None, HostPaths::current());
				let mut diags = normalized.recovered().then(|| {
					Diag::info(
						DiagKind::PathRecovered,
						sf!("{} -> {}", normalized.authored, normalized.canonical),
					)
				}).into_iter().collect::<Vec<_>>();
				let mut parsed = match section.parse() {
					Ok(parsed) => parsed.clone(),
					Err(error) => { yield done_fault(Fault::invalid(error.to_string())); return; },
				};
				if let Some(FileOp::Move { dest }) = &mut parsed.file_op {
					let normalized = normalize_target(dest, None, HostPaths::current());
					if normalized.recovered() {
						diags.push(Diag::info(
							DiagKind::PathRecovered,
							sf!("{} -> {}", normalized.authored, normalized.canonical),
						));
					}
					*dest = normalized.canonical.to_string();
				}
				let anchors = match section.collect_anchor_lines() {
					Ok(anchors) => anchors.into_iter().map(|line| line as usize).collect(),
					Err(error) => { yield done_fault(Fault::invalid(error.to_string())); return; },
				};
				let request = PrepareRequest {
					path: normalized.canonical,
					file_hash: section.file_hash.as_deref().map(Str::new),
					anchor_lines: anchors,
					allow_unpinned: false,
					allow_missing: false,
					guard_generated: self.guard_generated,
				};
				let prepared = match self.documents.prepare(request).instrument(span.clone()).await {
					Ok(prepared) => prepared,
					Err(fault) => { yield done_fault(fault); return; },
				};
				if let Some(previous) = parsed_sections.iter().find(|entry: &&PreparedWork<D::Prepared>| entry.prepared.path() == prepared.path()) {
					yield done_fault(Fault::invalid(format!(
						"Multiple hashline sections resolve to the same file ({} and {}). Merge their ops under one header before applying.",
						previous.section_path, section.path
					)));
					return;
				}
				parsed_sections.push(PreparedWork {
					section_path: prepared.display_path().clone(),
					file_hash: section.file_hash.map(Into::into),
					parsed,
					prepared,
					diags,
				});
			}

			let mut clipboard = self.documents.start_clipboard_batch();
			let mut proposals = Vec::with_capacity(parsed_sections.len());
			let mut projections = Vec::with_capacity(parsed_sections.len());
			let mut pending_blackbox = Vec::<PendingBlackbox>::new();
			let observer_args =
				serde_json::to_value(Params { input: input.clone() }).unwrap_or_default();
			for work in &parsed_sections {
				let authored = match document_text(work.prepared.authored_bytes(), "authored document") {
					Ok(text) => text,
					Err(fault) => { yield done_fault(fault); return; },
				};
				let base = match document_text(work.prepared.base_bytes(), "current document") {
					Ok(text) => text,
					Err(fault) => { yield done_fault(fault); return; },
				};
				let applied = match apply_edits(&authored.text, &work.parsed.edits, ApplyOptions {
					clipboard: Some(&mut clipboard),
					path: Some(work.prepared.path()),
					on_empty_paste: EmptyPaste::Throw,
				}) {
					Ok(applied) => applied,
					Err(error) => { yield done_fault(Fault::invalid(error.to_string())); return; },
				};

				let stale = work.prepared.authored_bytes() != work.prepared.base_bytes();
				let mut head_tail_drift = false;
				let mut recovery_warnings = Vec::new();
				let mut first_changed_line = applied.first_changed_line;
				let mut after = if !stale {
					restore_text(&applied.text, &authored)
				} else if is_head_tail_only(&work.parsed.edits) {
					match apply_edits(&base.text, &work.parsed.edits, ApplyOptions {
						clipboard: None,
						path: Some(work.prepared.path()),
						on_empty_paste: EmptyPaste::Throw,
					}) {
						Ok(live) => {
							head_tail_drift = true;
							first_changed_line = live.first_changed_line;
							restore_text(&live.text, &base)
						},
						Err(error) => {
							tracing::warn!(
								parent: &span,
								path = %work.prepared.display_path(),
								"edit head-tail rebase failed",
							);
							yield done_fault(Fault::invalid(error.to_string()));
							return;
						},
					}
				} else if let Ok(Some(recovered)) = recover_text(
					&authored.text,
					&base.text,
					&work.parsed.edits,
					Some(&mut clipboard),
					Some(work.prepared.path()),
					RecoveryChain::Session,
				) {
					first_changed_line = recovered.first_changed_line;
					recovery_warnings = recovered.warnings;
					restore_text(&recovered.text, &base)
				} else {
					tracing::warn!(
						parent: &span,
						path = %work.prepared.display_path(),
						"edit rebase overlapped a concurrent change",
					);
					yield done_fault(Fault::stale(stale_message(work, true)));
					return;
				};
				if stale {
					tracing::warn!(
						parent: &span,
						path = %work.prepared.display_path(),
						strategy = if head_tail_drift { "head_tail" } else { "non_overlapping" },
						"edit rebased over a changed document",
					);
				}

				let mut diags = work.diags.clone();
				diags.extend(work.prepared.path_recoveries().iter().map(path_recovery_diag));
				diags.extend(
					work.parsed
						.warnings
						.iter()
						.chain(&applied.warnings)
						.map(|warning| Diag::warn(DiagKind::Advisory, Str::new(warning))),
				);
				diags.extend(
					recovery_warnings
						.iter()
						.map(|warning| Diag::warn(DiagKind::AnchorDrift, Str::new(warning))),
				);
				if head_tail_drift {
					diags.push(Diag::warn(
						DiagKind::AnchorDrift,
						Str::new_static(HEADTAIL_DRIFT_WARNING),
					));
				}
				if !matches!(&work.parsed.file_op, Some(FileOp::Rem)) {
					let target = match &work.parsed.file_op {
						Some(FileOp::Move { dest }) => Str::new(dest),
						Some(FileOp::Rem) | None => work.prepared.path().clone(),
					};
					let inspected = self.observer.inspect(
						AppliedEditSnapshot {
							path: target,
							before: work.prepared.base_bytes().clone(),
							after: after.clone(),
						},
						"hashline",
						&observer_args,
					).instrument(span.clone()).await;
					after = inspected.content;
					if let Err(fault) = utf8(&after, "edited document") {
						yield done_fault(fault);
						return;
					}
					diags.extend(inspected.diag);
					pending_blackbox.extend(inspected.pending);
				}
				let action = match &work.parsed.file_op {
					Some(FileOp::Rem) => EditAction::Delete,
					Some(FileOp::Move { dest }) => EditAction::Move {
						destination: Str::new(dest), content: after.clone(),
					},
					None => EditAction::Write { content: after.clone() },
				};
				proposals.push(EditProposal {
					action, base_revision: work.prepared.base_revision().clone(),
					stale_policy: StalePolicy::RebaseNonOverlapping, format_policy: self.format_policy,
				});
				projections.push(ProjectionWork {
					after,
					applied_ops: op_details(&work.parsed.edits),
					first_changed_line: first_changed_line.map(|line| line as usize),
					block_resolutions: applied.block_resolutions.into_iter().map(|resolution| ResolvedBlock {
						anchor_line: resolution.anchor_line as usize,
						start: resolution.start as usize,
						end: resolution.end as usize,
						operation: Str::new_static(match resolution.op {
							BlockOpKind::Replace => "replace",
							BlockOpKind::InsertAfter => "insert_after",
							BlockOpKind::Cut => "cut",
							BlockOpKind::PasteAfter => "paste_after",
						}),
					}).collect(),
					diags,
				});
			}

			let mut preview = String::new();
			let mut added_lines = 0;
			let mut removed_lines = 0;
			for (work, projection) in parsed_sections.iter().zip(&projections) {
				let Ok(base) = document_text(work.prepared.base_bytes(), "current document") else {
					continue;
				};
				let Ok(after) = document_text(&projection.after, "edited document") else {
					continue;
				};
				let diff = generate_diff_string(&base.text, &after.text, None, &BlockContextSource {
					path: Some(work.section_path.as_str()),
					lang: None,
				});
				let compact =
					build_compact_diff_preview(diff.diff.as_str(), &CompactDiffOptions::default());
				if !preview.is_empty() && !compact.preview.is_empty() {
					preview.push('\n');
				}
				preview.push_str(compact.preview.as_str());
				added_lines += compact.added_lines;
				removed_lines += compact.removed_lines;
			}
			yield Ev::Update(EditUpdate {
				applied_ops: projections.iter().map(|projection| projection.applied_ops.len()).sum(),
				paths: parsed_sections.iter().map(|work| work.section_path.clone()).collect(),
				preview: preview.into(),
				added_lines,
				removed_lines,
			});

			match params.committed().await {
				Ok(_) => {},
				Err(error) => { yield commit_event(error); return; },
			}

			let noop_index = parsed_sections.iter().zip(&projections).position(|(work, projection)| {
				work.parsed.file_op.is_none() && work.prepared.base_bytes() == &projection.after
			});
			if parsed_sections.len() == 1 && noop_index.is_some() {
				let work = &parsed_sections[0];
				let noop = self.documents.record_noop(
					work.prepared.path(), &work.section_path,
					Bytes::copy_from_slice(input.as_bytes()),
				);
				if noop.escalate {
					yield done_fault(Fault::invalid(noop.diagnostic));
				} else {
					let payload = match build_payload(
						&self.snapshots,
						&parsed_sections,
						&projections,
						None,
					).await {
						Ok(payload) => payload,
						Err(fault) => {
							yield Ev::Aborted(Abort::EffectsUnknown {
								reason: snapshot_fault_reason(fault),
							});
							return;
						},
					};
					for diag in &projections[0].diags {
						yield Ev::Diag(diag.clone());
					}
					yield Ev::Done(ToolTerminal::Done { result: Ok(payload), useless: true });
				}
				return;
			}
			if let Some(index) = noop_index {
				let work = &parsed_sections[index];
				let noop = self.documents.record_noop(
					work.prepared.path(), &work.section_path,
					Bytes::copy_from_slice(input.as_bytes()),
				);
				yield done_fault(Fault::invalid(noop.diagnostic));
				return;
			}

			let result = {
				let prepared =
					parsed_sections.iter_mut().map(|work| &mut work.prepared).collect();
				let commit = self.documents.commit(prepared, proposals, clipboard).instrument(span.clone()).fuse();
				let interrupt = params.next_interrupt().fuse();
				pin_mut!(commit, interrupt);
				let result = select_biased! {
					result = commit => Some(result),
					interrupted = interrupt => {
						yield Ev::Aborted(match interrupted {
							Ok(value) => Abort::EffectsUnknown { reason: value.reason },
							Err(InterruptWaitError::Closed) => Abort::EffectsUnknown { reason: sf!("invocation owner disappeared during transaction") },
							Err(InterruptWaitError::Protocol(reason)) => Abort::EffectsUnknown { reason },
						});
						None
					},
				};
				result
			};
			let Some(result) = result else { return; };
			match result {
				Ok(result) if result.sections.len() == parsed_sections.len() => {
					for (work, committed) in parsed_sections.iter().zip(&result.sections) {
						if let Some(content) = &committed.content
							&& let Err(fault) = utf8(content, "committed document")
						{
							yield done_fault(fault);
							return;
						}
						if committed.rebased {
							tracing::warn!(
								parent: &span,
								path = %work.prepared.display_path(),
								"edit transaction rebased a concurrent change",
							);
						}
					}
					for work in &parsed_sections {
						self.documents.reset_noop(work.prepared.path());
					}
					let payload = match build_payload(
						&self.snapshots,
						&parsed_sections,
						&projections,
						Some(&result.sections),
					).await {
						Ok(payload) => payload,
						Err(fault) => {
							yield Ev::Aborted(Abort::EffectsUnknown {
								reason: snapshot_fault_reason(fault),
							});
							return;
						},
					};
					for pending in pending_blackbox {
						self.observer.record_committed(pending).await;
					}
					for projection in &projections {
						for diag in &projection.diags {
							yield Ev::Diag(diag.clone());
						}
					}
					yield Ev::Done(ToolTerminal::Done { result: Ok(payload), useless: false });
				},
				Ok(_) => yield Ev::Aborted(Abort::EffectsUnknown { reason: sf!("document transaction returned the wrong section count") }),
				Err(EditCommitError::Rejected(fault)) => {
					warn_edit_rejection(&span, &fault);
					yield done_fault(fault);
				},
				Err(EditCommitError::EffectsUnknown { reason }) => {
					tracing::warn!(parent: &span, "edit commit result is unknown");
					yield Ev::Aborted(Abort::EffectsUnknown { reason });
				},
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		let Some(mut out) = TextProjection::new(*caps) else {
			return Vec::new();
		};
		match view {
			Ok(payload) => {
				let rendered = payload
					.sections
					.iter()
					.map(|section| {
						let noop_diagnostic = format!(
							"Edits to {} parsed and applied cleanly, but produced no change: your body \
							 row(s) are byte-identical to the file at the targeted lines. The bug is \
							 somewhere else — re-read the file before issuing another edit. Do NOT widen \
							 the payload or add lines; verify the anchor first.",
							section.path
						);
						projection::render_section(projection::SectionView {
							op:                match section.op {
								SectionOp::Delete => projection::SectionOp::Delete,
								SectionOp::Noop => projection::SectionOp::Noop,
								SectionOp::Update | SectionOp::Move => projection::SectionOp::Update,
							},
							path:              &section.path,
							header:            section.header.as_deref().unwrap_or_default(),
							noop_diagnostic:   &noop_diagnostic,
							move_dest:         section.move_dest.as_deref(),
							preview:           &section.preview,
							block_resolutions: &section.block_resolutions,
						})
					})
					.collect::<Vec<_>>();
				let _ = out.push(&projection::render_sections(&rendered));
			},
			Err(fault) => {
				let _ = out.push(&rejection_text(fault));
			},
		}
		out.finish()
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_replace_to_hashline(from, call)
	}
}

fn lift_replace_to_hashline(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if from.family.as_str() != "rep" || !matches!(from.n, 1 | 2) {
		return None;
	}
	// Decode the source revision to prove the dialect. Anchors come from the
	// dialect-neutral resolved outcome, never from old search strings, which
	// may have matched fuzzily.
	if from.n == 1 {
		serde_json::from_slice::<LegacyReplaceParams>(call.raw_args).ok()?;
	} else {
		serde_json::from_slice::<ReplaceParams>(call.raw_args).ok()?;
	}
	let outcome = serde_json::from_slice::<CallOutcome<Payload, Fault>>(call.verdict).ok()?;
	let input = match outcome {
		CallOutcome::Ok(payload) => payload
			.sections
			.iter()
			.filter(|section| !section.resolved_edits.is_empty())
			.map(|section| {
				let before = document_text(&section.before, "replacement outcome source")
					.expect("replacement outcome source is UTF-8");
				let mut section_input =
					format!("{}\n", format_hashline_header(&section.path, &file_hash(&before.text)));
				for edit in &section.resolved_edits {
					if edit.body.is_empty() {
						let _ = writeln!(section_input, "CUT {}.={}", edit.start, edit.end);
					} else {
						let _ = writeln!(section_input, "PUT {}.={}:", edit.start, edit.end);
						for line in &edit.body {
							let _ = writeln!(section_input, "+{line}");
						}
					}
				}
				section_input
			})
			.collect::<String>(),
		CallOutcome::Faulted(_) | CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. } => {
			String::new()
		},
	};
	Some(LiftedCall {
		raw_args: Bytes::from(serde_json::to_vec(&Params { input: input.into() }).ok()?),
		verdict:  Bytes::copy_from_slice(call.verdict),
	})
}

struct PreparedWork<P> {
	section_path: Str,
	file_hash:    Option<Str>,
	parsed:       Parsed,
	prepared:     P,
	diags:        Vec<Diag>,
}

struct ProjectionWork {
	after:              Bytes,
	applied_ops:        Vec<AppliedOp>,
	first_changed_line: Option<usize>,
	block_resolutions:  Vec<ResolvedBlock>,
	diags:              Vec<Diag>,
}

fn path_recovery_diag(recovery: &PathRecovery) -> Diag {
	Diag::info(DiagKind::PathRecovered, sf!("{} -> {}", recovery.authored, recovery.resolved))
}

fn utf8<'a>(bytes: &'a Bytes, what: &str) -> Result<&'a str, Fault> {
	std::str::from_utf8(bytes).map_err(|_| Fault::invalid(format!("{what} is not valid UTF-8")))
}

struct DocumentText {
	text:   String,
	bom:    &'static str,
	ending: LineEnding,
}

fn document_text(bytes: &Bytes, what: &str) -> Result<DocumentText, Fault> {
	let raw = utf8(bytes, what)?;
	let (bom, body) = strip_bom(raw);
	Ok(DocumentText {
		text: normalize_to_lf(body).into_owned(),
		bom,
		ending: detect_line_ending(body),
	})
}

fn restore_text(text: &str, shape: &DocumentText) -> Bytes {
	let body = restore_line_endings(text, shape.ending);
	let mut restored = String::with_capacity(shape.bom.len() + body.len());
	restored.push_str(shape.bom);
	restored.push_str(&body);
	Bytes::from(restored)
}

fn stale_message<P: EditPrepared>(work: &PreparedWork<P>, recognized: bool) -> Str {
	let current = document_text(work.prepared.base_bytes(), "current document")
		.expect("current edit document was validated as UTF-8");
	let lines = current.text.lines().map(str::to_owned).collect();
	let anchors = work
		.parsed
		.edits
		.iter()
		.filter_map(|edit| match edit {
			Edit::Delete { anchor, .. } | Edit::Block { anchor, .. } => Some(anchor.line),
			Edit::Cut { range, .. } => Some(range.start.line),
			Edit::Paste { .. } | Edit::Insert { .. } => None,
		})
		.collect();
	format_mismatch_message(&MismatchDetails {
		path:               Some(work.section_path.to_string()),
		expected_file_hash: work.file_hash.as_deref().unwrap_or_default().to_owned(),
		actual_file_hash:   file_hash(&current.text),
		file_lines:         lines,
		anchor_lines:       anchors,
		hash_recognized:    recognized,
	})
	.into()
}

async fn build_payload<P: EditPrepared, S: EditSnapshotStore>(
	snapshots: &S,
	works: &[PreparedWork<P>],
	projections: &[ProjectionWork],
	committed: Option<&[CommittedSection]>,
) -> Result<Payload, SnapshotFault> {
	let mut sections = Vec::with_capacity(works.len());
	let mut inline_remaining = MAX_EDIT_SNAPSHOT_INLINE_BYTES;
	for (index, (work, projection)) in works.iter().zip(projections).enumerate() {
		let move_dest = match &work.parsed.file_op {
			Some(FileOp::Move { dest }) => Some(Str::new(dest)),
			_ => None,
		};
		let op = match &work.parsed.file_op {
			Some(FileOp::Rem) => SectionOp::Delete,
			Some(FileOp::Move { .. }) => SectionOp::Move,
			None if work.prepared.base_bytes() == &projection.after => SectionOp::Noop,
			None => SectionOp::Update,
		};
		let output_path = move_dest.as_ref().unwrap_or(&work.section_path);
		let committed_section = committed.and_then(|sections| sections.get(index));
		let exact_after = if op == SectionOp::Delete {
			Bytes::new()
		} else {
			committed_section
				.and_then(|section| section.content.clone())
				.unwrap_or_else(|| projection.after.clone())
		};
		let before_text = document_text(work.prepared.base_bytes(), "current document")
			.expect("prepared edit document was validated as UTF-8");
		let after_text = document_text(&exact_after, "edited document")
			.expect("edited document was validated as UTF-8");
		let header = (op != SectionOp::Delete)
			.then(|| format_hashline_header(output_path, &file_hash(&after_text.text)).into());
		let numbered =
			generate_diff_string(&before_text.text, &after_text.text, None, &BlockContextSource {
				path: Some(output_path.as_str()),
				lang: None,
			});
		let diff = Str::from(numbered.diff);
		let preview = build_compact_diff_preview(&diff, &CompactDiffOptions::default())
			.preview
			.into();
		let exact_before = work.prepared.base_bytes().clone();
		let (before, before_blob, after, after_blob) =
			retain_snapshot_pair(snapshots, exact_before, exact_after, &mut inline_remaining).await?;
		sections.push(SectionPayload {
			path: work.section_path.clone(),
			canonical_path: work.prepared.path().clone(),
			op,
			move_dest,
			old_revision: work.prepared.base_revision().clone(),
			new_revision: committed_section.and_then(|section| section.new_revision.clone()),
			applied_ops: projection.applied_ops.clone(),
			resolved_edits: Vec::new(),
			rebased: committed_section.is_some_and(|section| section.rebased),
			before,
			before_blob,
			after,
			after_blob,
			header,
			diff,
			preview,
			first_changed_line: projection.first_changed_line,
			block_resolutions: projection.block_resolutions.clone(),
			diagnostics: committed_section
				.map_or_else(Vec::new, |section| section.diagnostics.clone()),
			diagnostics_complete: committed_section.is_none_or(|section| section.diagnostics_complete),
		});
	}
	Ok(Payload { sections })
}

async fn retain_snapshot_pair<S: EditSnapshotStore>(
	snapshots: &S,
	before: Bytes,
	after: Bytes,
	inline_remaining: &mut usize,
) -> Result<(Bytes, Option<omp_tool::BlobRef>, Bytes, Option<omp_tool::BlobRef>), SnapshotFault> {
	let snapshot_bytes = before.len().saturating_add(after.len());
	if snapshot_bytes <= *inline_remaining {
		*inline_remaining -= snapshot_bytes;
		return Ok((before, None, after, None));
	}
	let before_blob = if before.is_empty() {
		None
	} else {
		Some(snapshots.store_snapshot(before).await?)
	};
	let after_blob = if after.is_empty() {
		None
	} else {
		Some(snapshots.store_snapshot(after).await?)
	};
	Ok((Bytes::new(), before_blob, Bytes::new(), after_blob))
}

fn snapshot_fault_reason(fault: SnapshotFault) -> Str {
	match fault {
		SnapshotFault::Unavailable => {
			sf!("oversized edit snapshots require an Environment blob authority")
		},
		SnapshotFault::Store => {
			sf!("the Environment blob authority could not retain an edit snapshot")
		},
	}
}

fn op_details(edits: &[Edit]) -> Vec<AppliedOp> {
	edits
		.iter()
		.map(|edit| AppliedOp {
			kind:       Str::new_static(edit.into()),
			patch_line: edit.line_num() as usize,
			index:      edit.index() as usize,
		})
		.collect()
}

const fn done_fault(fault: Fault) -> Ev<EditUpdate, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false })
}
pub(super) fn warn_edit_rejection(span: &tracing::Span, fault: &Fault) {
	let reason = match &fault.reason {
		RejectionReason::Conflict => "conflict",
		RejectionReason::StaleUnrecoverable { .. } => "stale_unrecoverable",
		RejectionReason::Format { .. } => "format",
		RejectionReason::InvalidPatch { .. } => "invalid_patch",
	};
	tracing::warn!(
		parent: span,
		reason = reason,
		conflict_count = fault.conflicts.len(),
		"edit transaction rejected",
	);
}

fn param_event(error: ParamError) -> Ev<EditUpdate, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(value) => Ev::Aborted(Abort::Interrupted { reason: value.reason }),
		ParamError::Protocol(reason) => Ev::Aborted(Abort::Skipped { reason }),
	}
}

fn commit_event(error: CommitError) -> Ev<EditUpdate, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(value) => Ev::Aborted(Abort::Interrupted { reason: value.reason }),
		CommitError::Protocol(reason) => Ev::Aborted(Abort::Skipped { reason }),
	}
}

fn rejection_text(fault: &Fault) -> Str {
	match &fault.reason {
		RejectionReason::Conflict => {
			let mut text =
				format!("Edit rejected: conflict ({} overlapping range(s))", fault.conflicts.len());
			for conflict in &fault.conflicts {
				write!(text, "\n{}-{}: {}", conflict.start_line, conflict.end_line, conflict.message)
					.expect("writing to String cannot fail");
			}
			text.into()
		},
		RejectionReason::StaleUnrecoverable { message }
		| RejectionReason::Format { message }
		| RejectionReason::InvalidPatch { message } => message.clone(),
	}
}

#[cfg(test)]
mod tests {

	use parking_lot::Mutex;

	use super::*;

	#[derive(Default)]
	struct RecordingSnapshots(Mutex<Vec<Bytes>>);

	impl EditSnapshotStore for RecordingSnapshots {
		async fn store_snapshot(&self, bytes: Bytes) -> Result<omp_tool::BlobRef, SnapshotFault> {
			let byte_len = u64::try_from(bytes.len()).expect("fixture length");
			self.0.lock().push(bytes);
			Ok(omp_tool::BlobRef {
				hash: sf!("fixture-{byte_len}"),
				media_type: sf!("application/octet-stream"),
				byte_len,
			})
		}
	}

	#[tokio::test]
	async fn oversized_snapshots_route_to_typed_blob_refs() {
		let store = RecordingSnapshots::default();
		let before = Bytes::from(vec![b'a'; MAX_EDIT_SNAPSHOT_INLINE_BYTES]);
		let after = Bytes::from_static(b"new");
		let mut remaining = MAX_EDIT_SNAPSHOT_INLINE_BYTES;
		let (inline_before, before_blob, inline_after, after_blob) =
			retain_snapshot_pair(&store, before.clone(), after.clone(), &mut remaining)
				.await
				.expect("spill");
		assert!(inline_before.is_empty());
		assert!(inline_after.is_empty());
		assert_eq!(before_blob.expect("old ref").byte_len, before.len() as u64);
		assert_eq!(after_blob.expect("new ref").byte_len, after.len() as u64);
		assert_eq!(&*store.0.lock(), &[before, after]);
	}

	#[test]
	fn revision_cascade_is_registered_and_caps_derived() {
		let model = Rev { family: "rep".into(), n: 2 };
		let pinned = Rev { family: "hl".into(), n: 1 };
		let resolved = resolve_edit_revision(EditRevisionCandidates {
			model_rule:     Some(&model),
			environment:    Some("hl.1"),
			setting:        Some("rep.2"),
			pin:            Some(&pinned),
			force_hashline: false,
			strict:         true,
		})
		.expect("registered pinned revision");
		assert_eq!(resolved.revision, pinned);
		assert_eq!(resolved.source, EditRevisionSource::EmbedderPin);
		let strict = resolve_edit_revision(EditRevisionCandidates {
			model_rule: Some(&model),
			environment: Some("sloppy.1"),
			force_hashline: true,
			..EditRevisionCandidates::default()
		})
		.expect("strict hashline");
		assert_eq!(strict.revision, Rev { family: sf!("hl"), n: 1 });
		assert_eq!(strict.source, EditRevisionSource::OperatorStrict);
		assert_eq!(
			resolve_edit_revision(EditRevisionCandidates {
				model_rule: Some(&model),
				environment: Some("hl.1"),
				setting: Some("hl.1"),
				..EditRevisionCandidates::default()
			})
			.expect("model rule"),
			ResolvedEditRevision { revision: model.clone(), source: EditRevisionSource::ModelRule }
		);
		assert_eq!(
			resolve_edit_revision(EditRevisionCandidates {
				environment: Some("rep.2"),
				setting: Some("hl.1"),
				..EditRevisionCandidates::default()
			})
			.expect("environment revision")
			.source,
			EditRevisionSource::Environment
		);
		assert_eq!(
			resolve_edit_revision(EditRevisionCandidates {
				setting: Some("rep.2"),
				..EditRevisionCandidates::default()
			})
			.expect("setting revision")
			.source,
			EditRevisionSource::Setting
		);
		let caps = PromptCaps::for_tool(
			omp_tool::CapsBase {
				maximum_parts:      1,
				maximum_text_bytes: 1024,
				media:              false,
				model_class:        omp_tool::ModelClass::Standard,
			},
			&resolved.revision,
		);
		assert!(revision_matches_caps(&resolved.revision, &caps));
		assert_eq!(
			resolve_edit_revision(EditRevisionCandidates {
				environment: Some("unknown.7"),
				strict: true,
				..EditRevisionCandidates::default()
			}),
			Err(
				"unknown edit revision \"unknown.7\"; use hl.1, rep.2, patch.2, apply_patch.1, or \
				 sloppy.1"
					.into()
			)
		);
	}

	#[test]
	fn replace_outcome_lifts_to_hashline_from_resolved_edits() {
		let before = Bytes::from_static(b"one\ntwo\n");
		let payload = Payload {
			sections: vec![SectionPayload {
				path:                 "a.txt".into(),
				canonical_path:       "a.txt".into(),
				op:                   SectionOp::Update,
				move_dest:            None,
				old_revision:         "r1".into(),
				new_revision:         Some("r2".into()),
				applied_ops:          vec![AppliedOp {
					kind:       "replace".into(),
					patch_line: 2,
					index:      0,
				}],
				resolved_edits:       vec![ResolvedEdit {
					start: 2,
					end:   2,
					body:  vec!["TWO".into()],
				}],
				rebased:              false,
				before:               before.clone(),
				before_blob:          None,
				after:                Bytes::from_static(b"one\nTWO\n"),
				after_blob:           None,
				header:               Some(
					format_hashline_header("a.txt", &file_hash("one\nTWO\n")).into(),
				),
				diff:                 Str::default(),
				preview:              Str::default(),
				first_changed_line:   Some(2),
				block_resolutions:    Vec::new(),
				diagnostics:          Vec::new(),
				diagnostics_complete: true,
			}],
		};
		let args = LegacyReplaceParams {
			edits: vec![LegacyReplaceOperation {
				path:        "a.txt".into(),
				old:         "two".into(),
				new:         "TWO".into(),
				replace_all: false,
				allow_fuzzy: true,
				threshold:   None,
			}],
		};
		let verdict = serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(payload))
			.expect("serializable dialect-neutral outcome");
		let lifted = lift_replace_to_hashline(&Rev { family: "rep".into(), n: 1 }, RecordedCall {
			raw_args: &serde_json::to_vec(&args).expect("serializable replacement args"),
			verdict:  &verdict,
		})
		.expect("registered replacement revision lifts to hashline");
		let lifted_args: Params =
			serde_json::from_slice(&lifted.raw_args).expect("hashline lift arguments");
		assert_eq!(
			lifted_args.input,
			format!("[a.txt#{}]\nPUT 2.=2:\n+TWO\n", file_hash("one\ntwo\n"))
		);
		assert_eq!(lifted.verdict.as_ref(), verdict.as_slice());
	}

	struct NoDocuments;
	struct NoPrepared;

	impl EditPrepared for NoPrepared {
		fn path(&self) -> &Str {
			panic!("registry lift never prepares documents")
		}

		fn base_revision(&self) -> &Str {
			panic!("registry lift never prepares documents")
		}

		fn base_bytes(&self) -> &Bytes {
			panic!("registry lift never prepares documents")
		}

		fn authored_bytes(&self) -> &Bytes {
			panic!("registry lift never prepares documents")
		}
	}

	impl EditDocuments for NoDocuments {
		type Prepared = NoPrepared;

		fn prepare(
			&self,
			_request: PrepareRequest,
		) -> impl Future<Output = Result<Self::Prepared, Fault>> + Send + '_ {
			future::ready(Err(Fault::invalid("not invoked by registry lift test")))
		}

		fn start_clipboard_batch(&self) -> Clipboard {
			Clipboard::default()
		}

		fn record_noop(
			&self,
			_canonical_path: &str,
			_display_path: &str,
			_input: Bytes,
		) -> NoopResult {
			NoopResult { diagnostic: "not invoked".into(), escalate: false }
		}

		fn reset_noop(&self, _canonical_path: &str) {}

		fn commit<'a>(
			&'a self,
			_prepared: Vec<&'a mut Self::Prepared>,
			_proposals: Vec<EditProposal>,
			_clipboard: Clipboard,
		) -> impl Future<Output = Result<CommitResult, EditCommitError>> + Send + 'a {
			future::ready(Err(EditCommitError::EffectsUnknown {
				reason: "not invoked by registry lift test".into(),
			}))
		}
	}

	#[test]
	fn registry_lifts_registered_replace_history_into_live_hashline() {
		use omp_tool::{
			Claims, Precedence, Presentation, ProjectedCall, RecordedCallOwned, Registry, ToolIdentity,
		};

		let claims =
			Claims { precedence: Precedence::CORE, claimant: "omp/core".into(), replaces: None };
		let mut registry = Registry::new();
		registry
			.register(
				legacy_replace_tool_with_observer(
					NoDocuments,
					FormatPolicy::BestEffort,
					EditObserver::default(),
					true,
					true,
					false,
				),
				Presentation::Slot,
				claims.clone(),
			)
			.expect("register replacement lift source");
		registry
			.register(tool(NoDocuments, FormatPolicy::BestEffort), Presentation::Slot, claims)
			.expect("register live hashline destination");
		let source_args = serde_json::to_vec(&LegacyReplaceParams { edits: Vec::new() })
			.expect("serialize replacement source args");
		let source_verdict =
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Faulted(Fault::invalid("no match")))
				.expect("serialize dialect-neutral outcome");
		let ProjectedCall::Live(lifted) = registry.project(RecordedCallOwned {
			identity: ToolIdentity { name: "edit".into(), rev: Rev { family: "rep".into(), n: 1 } },
			raw_args: Bytes::from(source_args),
			verdict:  Bytes::from(source_verdict.clone()),
		}) else {
			panic!("registered rep.1 must lift through live hl.1");
		};
		assert_eq!(lifted.identity.rev, Rev { family: "hl".into(), n: 1 });
		assert_eq!(lifted.verdict.as_ref(), source_verdict.as_slice());
		assert_eq!(
			serde_json::from_slice::<Params>(&lifted.raw_args)
				.expect("hashline dialect arguments after registry lift")
				.input,
			""
		);
	}
}
