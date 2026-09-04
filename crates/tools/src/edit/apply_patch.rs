//! Apply-patch, patch, and sloppy edit revisions over `EditDocuments`.

use std::{fmt::Write as _, marker::PhantomData, path::Path};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt, Stream, pin_mut, select_biased};
use omp_core::{Str, sf};
use omp_edit::{
	EditMode,
	diff_string::{
		BlockContextSource, CompactDiffOptions, build_compact_diff_preview, generate_diff_string,
		normalize_create_content, parse_diff_hunks,
	},
	fuzzy::DEFAULT_FUZZY_THRESHOLD,
	grammar,
	modes::{
		apply_patch::{ApplyPatchEntry, parse_apply_patch},
		patch::{Operation, apply_hunks},
		sloppy::{
			apply::{ApplyContext, apply_sloppy},
			parse::split_sloppy_sections,
		},
	},
	store::EditStore,
};
use omp_tool::{
	Abort, Constraint, Diag, DiagKind, Dialect, DocEffects, Effects, Ev, IncomingParams,
	InterruptWaitError, Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tracing::Instrument as _;

use super::{
	AppliedOp, CommittedSection, EditAction, EditCommitError, EditDocuments, EditPrepared,
	EditProposal, EditUpdate, Fault, FormatPolicy, Payload, PrepareRequest, ResolvedEdit, SectionOp,
	SectionPayload, StalePolicy, commit_event, document_text, done_fault,
	observer::{AppliedEditSnapshot, EditObserver, PendingBlackbox},
	param_event, path_recovery_diag, rejection_text, restore_text, warn_edit_rejection,
};
use crate::{
	path::{HostPaths, normalize_target},
	render::TextProjection,
};
const SLOPPY_DESCRIPTION: &str = include_str!("../sloppy_prompt.txt");

/// Freeform arguments shared by patch-envelope and sloppy revisions.
///
/// Unknown provider-attached keys are deliberately ignored; only `input` is
/// canonicalized into the recorded tool call.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct FreeformEditParams {
	/// Complete dialect input.
	pub input: Str,
}

/// Current structured `edit@patch.2` arguments.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PatchParams {
	/// Workspace-relative path targeted by every entry.
	pub path:  Str,
	/// Ordered edits against that path.
	pub edits: Vec<PatchEditEntry>,
}

/// One structured patch entry.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PatchEditEntry {
	/// File operation; omitted means update.
	#[serde(default)]
	pub op:     Option<PatchOp>,
	/// Destination path for an update-and-rename.
	#[serde(default)]
	pub rename: Option<Str>,
	/// Create body or update hunk.
	#[serde(default)]
	pub diff:   Option<Str>,
}

/// Structured patch file operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchOp {
	/// Create the target file.
	Create,
	/// Delete the target file.
	Delete,
	/// Update the target file.
	Update,
}

trait EditInputParams: serde::de::DeserializeOwned + Serialize + Send + Sync + 'static {
	fn into_input(self) -> Result<Str, Str>;
}

impl EditInputParams for FreeformEditParams {
	fn into_input(self) -> Result<Str, Str> {
		Ok(self.input)
	}
}

impl EditInputParams for PatchParams {
	fn into_input(self) -> Result<Str, Str> {
		render_structured_patch(self)
	}
}

fn render_structured_patch(params: PatchParams) -> Result<Str, Str> {
	if params.path.trim().is_empty() || params.path.contains('\n') || params.path.contains('\r') {
		return Err(sf!("patch path must be one non-empty line"));
	}
	let Some(first) = params.edits.first() else {
		return Err(sf!("No structured patch entries found."));
	};
	let operation = first.op.unwrap_or(PatchOp::Update);
	if params
		.edits
		.iter()
		.any(|entry| entry.op.unwrap_or(PatchOp::Update) != operation)
	{
		return Err(sf!("structured patch entries for one path must use the same operation"));
	}
	let mut input = String::from("*** Begin Patch\n");
	match operation {
		PatchOp::Create => {
			if params.edits.iter().any(|entry| entry.rename.is_some()) {
				return Err(sf!("create entries cannot rename the target"));
			}
			let _ = writeln!(input, "*** Add File: {}", params.path);
			for entry in params.edits {
				let diff = entry
					.diff
					.ok_or_else(|| sf!("create entries require diff content"))?;
				for line in diff.lines() {
					let _ = writeln!(input, "+{line}");
				}
			}
		},
		PatchOp::Delete => {
			if params
				.edits
				.iter()
				.any(|entry| entry.rename.is_some() || entry.diff.is_some())
			{
				return Err(sf!("delete entries cannot carry rename or diff"));
			}
			let _ = writeln!(input, "*** Delete File: {}", params.path);
		},
		PatchOp::Update => {
			let mut rename = None;
			let _ = writeln!(input, "*** Update File: {}", params.path);
			for entry in &params.edits {
				if let Some(destination) = &entry.rename {
					if destination.trim().is_empty()
						|| destination.contains('\n')
						|| destination.contains('\r')
					{
						return Err(sf!("patch rename must be one non-empty line"));
					}
					if rename.replace(destination).is_some() {
						return Err(sf!("structured patch accepts at most one rename"));
					}
				}
			}
			if let Some(destination) = rename {
				let _ = writeln!(input, "*** Move to: {destination}");
			}
			for entry in params.edits {
				let diff = entry
					.diff
					.ok_or_else(|| sf!("update entries require diff content"))?;
				input.push_str(&diff);
				if !diff.ends_with('\n') {
					input.push('\n');
				}
			}
		},
	}
	input.push_str("*** End Patch\n");
	Ok(input.into())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FreeformKind {
	PatchLegacy,
	Patch,
	ApplyPatch,
	Sloppy,
}

impl FreeformKind {
	const fn family(self) -> &'static str {
		match self {
			Self::PatchLegacy | Self::Patch => "patch",
			Self::ApplyPatch => "apply_patch",
			Self::Sloppy => "sloppy",
		}
	}

	const fn dialect(self) -> Dialect {
		match self {
			Self::PatchLegacy | Self::Patch => Dialect::Patch,
			Self::ApplyPatch => Dialect::ApplyPatch,
			Self::Sloppy => Dialect::Sloppy,
		}
	}

	const fn description(self) -> &'static str {
		match self {
			Self::PatchLegacy => {
				"Apply a Codex begin/add/update/move/delete patch envelope atomically."
			},
			Self::Patch => "Apply structured create/update/move/delete edits atomically.",
			Self::ApplyPatch => {
				"Apply a Codex begin/add/update/move/delete patch envelope atomically."
			},
			Self::Sloppy => SLOPPY_DESCRIPTION,
		}
	}
}

/// A freeform or structured patch edit revision.
pub struct FreeformEditTool<D, P = FreeformEditParams> {
	documents:       D,
	format_policy:   FormatPolicy,
	kind:            FreeformKind,
	observer:        EditObserver,
	guard_generated: bool,
	require_seen:    bool,
	spec:            ToolSpec,
	params:          PhantomData<fn() -> P>,
}

/// Returns the host-free current `edit@patch.2` specification.
pub fn patch_spec() -> ToolSpec {
	freeform_spec::<PatchParams>(FreeformKind::Patch, 2)
}

/// Returns the historical `edit@patch.1` specification.
pub fn legacy_patch_spec() -> ToolSpec {
	freeform_spec::<FreeformEditParams>(FreeformKind::PatchLegacy, 1)
}

/// Returns the host-free `edit@apply_patch.1` specification.
pub fn apply_patch_spec() -> ToolSpec {
	freeform_spec::<FreeformEditParams>(FreeformKind::ApplyPatch, 1)
}

/// Returns the host-free `edit@sloppy.1` specification.
pub fn sloppy_spec() -> ToolSpec {
	freeform_spec::<FreeformEditParams>(FreeformKind::Sloppy, 1)
}

fn freeform_spec<P: JsonSchema>(kind: FreeformKind, revision: u16) -> ToolSpec {
	ToolSpec {
		name:            sf!("edit"),
		rev:             Rev { family: Str::new_static(kind.family()), n: revision },
		description:     Str::new_static(kind.description()),
		schema:          omp_tool::schema::<P>(),
		constraint:      if kind == FreeformKind::Patch {
			Constraint::Schema { priority: 100, on_unsupported: omp_tool::Fallback::Unspecified }
		} else {
			Constraint::Grammar {
				priority:       100,
				syntax:         omp_tool::GrammarSyntax::Lark,
				definition:     Str::new_static(match kind.dialect() {
					Dialect::Patch | Dialect::ApplyPatch => {
						grammar(EditMode::ApplyPatch).expect("apply-patch mode ships a grammar")
					},
					Dialect::Sloppy => grammar(EditMode::Sloppy).expect("sloppy mode ships a grammar"),
					Dialect::Hashline | Dialect::Replace | Dialect::Native => "",
				}),
				on_unsupported: omp_tool::Fallback::Unspecified,
			}
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
			include_bytes!("apply_patch.rs"),
		)
		.into(),
	}
}

/// Constructs current `edit@patch.2`.
pub fn patch_tool<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
) -> FreeformEditTool<D, PatchParams> {
	patch_tool_with_observer(documents, format_policy, EditObserver::default(), true, false)
}

/// Constructs current `edit@patch.2` with host policy.
pub fn patch_tool_with_observer<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
	require_seen: bool,
) -> FreeformEditTool<D, PatchParams> {
	new_tool(
		documents,
		format_policy,
		FreeformKind::Patch,
		observer,
		guard_generated,
		require_seen,
		patch_spec(),
	)
}

/// Constructs historical `edit@patch.1` for durable replay.
pub fn legacy_patch_tool_with_observer<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
	require_seen: bool,
) -> FreeformEditTool<D> {
	new_tool(
		documents,
		format_policy,
		FreeformKind::PatchLegacy,
		observer,
		guard_generated,
		require_seen,
		legacy_patch_spec(),
	)
}

/// Constructs `edit@apply_patch.1`.
pub fn apply_patch_tool<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
) -> FreeformEditTool<D> {
	apply_patch_tool_with_observer(documents, format_policy, EditObserver::default(), true, false)
}

/// Constructs `edit@apply_patch.1` with syntax observation.
pub fn apply_patch_tool_with_observer<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
	require_seen: bool,
) -> FreeformEditTool<D> {
	new_tool(
		documents,
		format_policy,
		FreeformKind::ApplyPatch,
		observer,
		guard_generated,
		require_seen,
		apply_patch_spec(),
	)
}

/// Constructs `edit@sloppy.1`.
pub fn sloppy_tool<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
) -> FreeformEditTool<D> {
	sloppy_tool_with_observer(documents, format_policy, EditObserver::default(), true, false)
}

/// Constructs `edit@sloppy.1` with syntax observation.
pub fn sloppy_tool_with_observer<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
	require_seen: bool,
) -> FreeformEditTool<D> {
	new_tool(
		documents,
		format_policy,
		FreeformKind::Sloppy,
		observer,
		guard_generated,
		require_seen,
		sloppy_spec(),
	)
}

fn new_tool<D: EditDocuments, P>(
	documents: D,
	format_policy: FormatPolicy,
	kind: FreeformKind,
	observer: EditObserver,
	guard_generated: bool,
	require_seen: bool,
	spec: ToolSpec,
) -> FreeformEditTool<D, P> {
	FreeformEditTool {
		documents,
		format_policy,
		kind,
		observer,
		guard_generated,
		require_seen,
		spec,
		params: PhantomData,
	}
}

#[derive(Clone, Debug)]
enum AuthoredOperation {
	Foreign(ApplyPatchEntry),
	Sloppy { path: Str, input: Str },
}

impl AuthoredOperation {
	fn path(&self) -> &str {
		match self {
			Self::Foreign(operation) => &operation.path,
			Self::Sloppy { path, .. } => path,
		}
	}
}

struct Work<P> {
	op:       AuthoredOperation,
	prepared: P,
	diags:    Vec<Diag>,
}

struct Projection {
	after:     Option<Bytes>,
	operation: SectionOp,
	move_dest: Option<Str>,
	resolved:  Vec<ResolvedEdit>,
	diags:     Vec<Diag>,
}

impl<D: EditDocuments, P: EditInputParams> Tool for FreeformEditTool<D, P> {
	type Fault = Fault;
	type Params = P;
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
			revision = %self.spec.rev,
			path_count = tracing::field::Empty,
			path = tracing::field::Empty,
		);
		stream! {
			let authored_params = match params.whole::<P>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			let observer_args = serde_json::to_value(&authored_params).unwrap_or_default();
			let input = match authored_params.into_input() {
				Ok(input) => input,
				Err(error) => { yield done_fault(Fault::invalid(error)); return; },
			};
			let operations = match parse_operations(self.kind, &input) {
				Ok(operations) if !operations.is_empty() => operations,
				Ok(_) => { yield done_fault(Fault::invalid("No edit operations found.")); return; },
				Err(error) => { yield done_fault(Fault::invalid(error)); return; },
			};
			span.record("path_count", operations.len());
			if let Some(operation) = operations.first() {
				span.record("path", tracing::field::display(operation.path()));
			}
			let mut works = Vec::with_capacity(operations.len());
			for mut op in operations {
				let normalized = normalize_target(op.path(), None, HostPaths::current());
				let mut diags = normalized.recovered().then(|| {
					Diag::info(
						DiagKind::PathRecovered,
						sf!("{} -> {}", normalized.authored, normalized.canonical),
					)
				}).into_iter().collect::<Vec<_>>();
				match &mut op {
					AuthoredOperation::Foreign(operation) => {
						operation.path = normalized.canonical.to_string();
					},
					AuthoredOperation::Sloppy { path, .. } => *path = normalized.canonical,
				}
				let prepared = match self.documents.prepare(PrepareRequest {
					path: Str::new(op.path()),
					file_hash: None,
					anchor_lines: Vec::new(),
					allow_unpinned: !self.require_seen,
					allow_missing: matches!(
						op,
						AuthoredOperation::Foreign(ApplyPatchEntry {
							op: Operation::Create,
							..
						})
					),
					guard_generated: self.guard_generated,
				}).instrument(span.clone()).await {
					Ok(prepared) => prepared,
					Err(fault) => { yield done_fault(fault); return; },
				};
				if works.iter().any(|work: &Work<D::Prepared>| work.prepared.path() == prepared.path()) {
					yield done_fault(Fault::invalid("Multiple operations resolve to the same file; merge repeated sloppy sections or use one apply-patch file hunk."));
					return;
				}
				diags.extend(prepared.path_recoveries().iter().map(path_recovery_diag));
				works.push(Work { op, prepared, diags });
			}

			let mut proposals = Vec::with_capacity(works.len());
			let mut projections = Vec::with_capacity(works.len());
			let mut pending_blackbox = Vec::<Option<PendingBlackbox>>::with_capacity(works.len());
			for work in &works {
				let source = match document_text(work.prepared.authored_bytes(), "authored document") {
					Ok(source) => source,
					Err(fault) => { yield done_fault(fault); return; },
				};
				if let Err(fault) = document_text(work.prepared.base_bytes(), "current document") {
					yield done_fault(fault);
					return;
				}
				let (mut after, operation, move_dest, warnings) = match &work.op {
					AuthoredOperation::Sloppy { input, path } => {
						let store = EditStore::new();
						let mut notes = Vec::new();
						match apply_sloppy(&source.text, input, ApplyContext {
							path,
							notes: &mut notes,
							store: &store,
							canonical: Path::new(work.prepared.path().as_str()),
						}) {
							Ok(content) => (
								Some(restore_text(&content, &source)),
								SectionOp::Update,
								None,
								notes,
							),
							Err(error) => { yield done_fault(Fault::invalid(error.to_string())); return; },
						}
					},
					AuthoredOperation::Foreign(entry) => {
						let result = match entry.op {
							Operation::Create => {
								if work.prepared.exists() {
									yield done_fault(Fault::invalid(format!(
										"Cannot create {}: file already exists. Use *** Update File to modify it in place.",
										entry.path
									)));
									return;
								}
								let Some(diff) = entry.diff.as_deref() else {
									yield done_fault(Fault::invalid("Create operation requires diff (file content)"));
									return;
								};
								let mut content = normalize_create_content(diff);
								if !content.ends_with('\n') {
									content.push('\n');
								}
								Ok((Some(restore_text(&content, &source)), Vec::new()))
							},
							Operation::Delete => Ok((None, Vec::new())),
							Operation::Update => {
								let Some(diff) = entry.diff.as_deref() else {
									yield done_fault(Fault::invalid("Update operation requires diff (hunks)"));
									return;
								};
								let hunks = match parse_diff_hunks(diff) {
									Ok(hunks) if !hunks.is_empty() => hunks,
									Ok(_) => {
										yield done_fault(Fault::invalid("Diff contains no hunks"));
										return;
									},
									Err(error) => {
										yield done_fault(Fault::invalid(error.to_string()));
										return;
									},
								};
								apply_hunks(
									&source.text,
									&entry.path,
									&hunks,
									DEFAULT_FUZZY_THRESHOLD,
									false,
								)
								.map(|(content, warnings)| {
									(Some(restore_text(&content, &source)), warnings)
								})
							},
						};
						match result {
							Ok((after, warnings)) => {
								let section_op = if entry.op == Operation::Delete {
									SectionOp::Delete
								} else if entry.rename.is_some() {
									SectionOp::Move
								} else {
									SectionOp::Update
								};
								(after, section_op, entry.rename.as_deref().map(Str::new), warnings)
							},
							Err(error) => {
								yield done_fault(Fault::invalid(error.to_string()));
								return;
							},
						}
					},
				};
				let mut diags = work.diags.clone();
				diags.extend(
					warnings
						.into_iter()
						.map(|warning| Diag::warn(DiagKind::Advisory, Str::from(warning))),
				);
				let mut pending = None;
				if work.prepared.exists() && operation != SectionOp::Delete
					&& let Some(content) = after.take()
				{
					let target = move_dest.clone().unwrap_or_else(|| work.prepared.path().clone());
					let inspected = self.observer.inspect(
						AppliedEditSnapshot {
							path: target,
							before: work.prepared.base_bytes().clone(),
							after: content,
						},
						self.kind.family(),
						&observer_args,
					).instrument(span.clone()).await;
					if let Err(fault) = super::utf8(&inspected.content, "edited document") {
						yield done_fault(fault);
						return;
					}
					after = Some(inspected.content);
					diags.extend(inspected.diag);
					pending = inspected.pending;
				}
				pending_blackbox.push(pending);
				let action = match (operation, after.clone(), move_dest.clone()) {
					(SectionOp::Delete, _, _) => EditAction::Delete,
					(SectionOp::Move, Some(content), Some(destination)) => EditAction::Move { destination, content },
					(_, Some(content), _) => EditAction::Write { content },
					_ => { yield done_fault(Fault::invalid("invalid edit operation state")); return; },
				};
				proposals.push(EditProposal {
					action: action.clone(),
					base_revision: work.prepared.base_revision().clone(),
					stale_policy: StalePolicy::RebaseNonOverlapping,
					format_policy: self.format_policy,
				});
				let resolved = after.as_ref().map_or_else(Vec::new, |after| vec![ResolvedEdit {
					start: 1,
					end: source.text.lines().count().max(1),
					body: document_text(after, "edited document")
						.expect("edited document was validated as UTF-8")
						.text
						.lines()
						.map(Str::new)
						.collect(),
				}]);
				projections.push(Projection { after, operation, move_dest, resolved, diags });
			}

			let (preview, added_lines, removed_lines) = preview(&works, &projections);
			yield Ev::Update(EditUpdate { applied_ops: projections.len(), paths: works.iter().map(|work| work.prepared.display_path().clone()).collect(), preview, added_lines, removed_lines });
			match params.committed().await {
				Ok(_) => {},
				Err(error) => { yield commit_event(error); return; },
			}

			let result = {
				let clipboard = self.documents.start_clipboard_batch();
				let prepared = works.iter_mut().map(|work| &mut work.prepared).collect();
				let commit = self.documents.commit(prepared, proposals, clipboard).instrument(span.clone()).fuse();
				let interrupt = params.next_interrupt().fuse();
				pin_mut!(commit, interrupt);
				select_biased! {
					result = commit => Some(result),
					interrupted = interrupt => { yield Ev::Aborted(match interrupted {
						Ok(value) => Abort::EffectsUnknown { reason: value.reason },
						Err(InterruptWaitError::Closed) => Abort::EffectsUnknown { reason: sf!("invocation owner disappeared during transaction") },
						Err(InterruptWaitError::Protocol(reason)) => Abort::EffectsUnknown { reason },
					}); None },
				}
			};
			let Some(result) = result else { return; };
			match result {
				Ok(result) if result.sections.len() == works.len() => {
					for (work, committed) in works.iter().zip(&result.sections) {
						if let Some(content) = &committed.content
							&& let Err(fault) = super::utf8(content, "committed document")
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
					for work in &works { self.documents.reset_noop(work.prepared.path()); }
					for pending in pending_blackbox.into_iter().flatten() {
						self.observer.record_committed(pending).await;
					}
					for projection in &projections {
						for diag in &projection.diags {
							yield Ev::Diag(diag.clone());
						}
					}
					yield Ev::Done(ToolTerminal::Done { result: Ok(payload(&works, &projections, &result.sections)), useless: false });
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
				for section in &payload.sections {
					let _ =
						out.push(&format!("{} edit completed: {}", self.kind.family(), section.path));
				}
			},
			Err(fault) => {
				let _ = out.push(&rejection_text(fault));
			},
		}
		out.finish()
	}
}

fn parse_operations(kind: FreeformKind, input: &str) -> Result<Vec<AuthoredOperation>, String> {
	match kind {
		FreeformKind::PatchLegacy | FreeformKind::Patch | FreeformKind::ApplyPatch => {
			parse_apply_patch(input)
				.map(|operations| {
					operations
						.into_iter()
						.map(AuthoredOperation::Foreign)
						.collect()
				})
				.map_err(|error| error.to_string())
		},
		FreeformKind::Sloppy => {
			let mut merged = Vec::<AuthoredOperation>::new();
			for section in split_sloppy_sections(input) {
				if let Some(AuthoredOperation::Sloppy { input, .. }) = merged
					.iter_mut()
					.find(|operation| operation.path() == section.path)
				{
					*input = sf!("{}\n{}", input, section.body);
				} else {
					merged.push(AuthoredOperation::Sloppy {
						path:  section.path.into(),
						input: section.body.into(),
					});
				}
			}
			Ok(merged)
		},
	}
}

fn preview<P: EditPrepared>(works: &[Work<P>], projections: &[Projection]) -> (Str, usize, usize) {
	let mut text = String::new();
	let mut added = 0;
	let mut removed = 0;
	for (work, projection) in works.iter().zip(projections) {
		let after = projection.after.clone().unwrap_or_default();
		let Ok(base) = document_text(work.prepared.base_bytes(), "current document") else {
			continue;
		};
		let Ok(after) = document_text(&after, "edited document") else {
			continue;
		};
		let diff = generate_diff_string(&base.text, &after.text, None, &BlockContextSource {
			path: Some(work.prepared.display_path().as_str()),
			lang: None,
		});
		let compact = build_compact_diff_preview(&diff.diff, &CompactDiffOptions::default());
		if !text.is_empty() && !compact.preview.is_empty() {
			text.push('\n');
		}
		text.push_str(&compact.preview);
		added += compact.added_lines;
		removed += compact.removed_lines;
	}
	(text.into(), added, removed)
}

fn payload<P: EditPrepared>(
	works: &[Work<P>],
	projections: &[Projection],
	committed: &[CommittedSection],
) -> Payload {
	Payload {
		sections: works
			.iter()
			.zip(projections)
			.zip(committed)
			.map(|((work, projection), committed)| {
				let after = committed
					.content
					.clone()
					.or_else(|| projection.after.clone())
					.unwrap_or_default();
				let before_text = document_text(work.prepared.base_bytes(), "current document")
					.expect("prepared edit document was validated as UTF-8");
				let after_text = document_text(&after, "edited document")
					.expect("edited document was validated as UTF-8");
				let diff = generate_diff_string(
					&before_text.text,
					&after_text.text,
					None,
					&BlockContextSource {
						path: Some(work.prepared.display_path().as_str()),
						lang: None,
					},
				);
				let compact = build_compact_diff_preview(&diff.diff, &CompactDiffOptions::default());
				SectionPayload {
					path: work.prepared.display_path().clone(),
					canonical_path: work.prepared.path().clone(),
					op: projection.operation,
					move_dest: projection.move_dest.clone(),
					old_revision: work.prepared.base_revision().clone(),
					new_revision: committed.new_revision.clone(),
					applied_ops: vec![AppliedOp {
						kind:       Str::new_static("rewrite"),
						patch_line: 1,
						index:      0,
					}],
					resolved_edits: projection.resolved.clone(),
					rebased: committed.rebased,
					before: work.prepared.base_bytes().clone(),
					before_blob: None,
					after,
					after_blob: None,
					header: None,
					diff: diff.diff.into(),
					preview: compact.preview.into(),
					first_changed_line: Some(1),
					block_resolutions: Vec::new(),
					diagnostics: committed.diagnostics.clone(),
					diagnostics_complete: committed.diagnostics_complete,
				}
			})
			.collect(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn freeform_schemas_ignore_provider_extras() {
		let params: FreeformEditParams =
			serde_json::from_str(r#"{"input":"x","provider_cache":true}"#).expect("extras ignored");
		assert_eq!(params.input, "x");
	}

	#[test]
	fn structured_patch_renders_create_update_rename_and_delete_envelopes() {
		let update = render_structured_patch(PatchParams {
			path:  "src/a.rs".into(),
			edits: vec![PatchEditEntry {
				op:     Some(PatchOp::Update),
				rename: Some("src/b.rs".into()),
				diff:   Some("@@\n-old\n+new\n".into()),
			}],
		})
		.expect("update");
		assert_eq!(
			update,
			"*** Begin Patch\n*** Update File: src/a.rs\n*** Move to: src/b.rs\n@@\n-old\n+new\n*** \
			 End Patch\n"
		);
		let create = render_structured_patch(PatchParams {
			path:  "new.txt".into(),
			edits: vec![PatchEditEntry {
				op:     Some(PatchOp::Create),
				rename: None,
				diff:   Some("one\ntwo\n".into()),
			}],
		})
		.expect("create");
		assert!(create.contains("*** Add File: new.txt\n+one\n+two\n"));
		let delete = render_structured_patch(PatchParams {
			path:  "old.txt".into(),
			edits: vec![PatchEditEntry { op: Some(PatchOp::Delete), rename: None, diff: None }],
		})
		.expect("delete");
		assert!(delete.contains("*** Delete File: old.txt\n"));
	}

	#[test]
	fn repeated_sloppy_sections_merge_in_authored_order() {
		let operations =
			parse_operations(FreeformKind::Sloppy, "§a\nx\n»\ny\n§a\ny\n»\nz").expect("parse");
		assert_eq!(operations.len(), 1);
		let AuthoredOperation::Sloppy { input, .. } = &operations[0] else {
			panic!("sloppy")
		};
		assert!(input.contains("y\n»\nz"));
	}
}
