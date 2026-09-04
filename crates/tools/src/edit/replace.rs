//! The historical replacement dialect and its lossless lift data.

use std::marker::PhantomData;

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt, Stream, pin_mut, select_biased};
use omp_core::{Str, sf};
use omp_edit::{
	diff_string::{
		BlockContextSource, CompactDiffOptions, build_compact_diff_preview, generate_diff_string,
	},
	fuzzy::{DEFAULT_FUZZY_THRESHOLD, replace_text},
	modes::hashline::format::format_hashline_header,
	span_edits,
	store::file_hash,
};
use omp_tool::{
	Abort, Constraint, Diag, DocEffects, Effects, Ev, IncomingParams, InterruptWaitError, Part,
	PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tracing::Instrument as _;

use super::{
	AppliedOp, CommittedSection, EditAction, EditCommitError, EditDocuments, EditPrepared,
	EditProposal, EditUpdate, Fault, FormatPolicy, NoopResult, Payload, PrepareRequest,
	RejectionReason, ResolvedEdit, SectionOp, SectionPayload, StalePolicy, commit_event,
	document_text, done_fault,
	observer::{AppliedEditSnapshot, EditObserver, PendingBlackbox},
	param_event, path_recovery_diag, restore_text, utf8, warn_edit_rejection,
};
use crate::render::TextProjection;

const DESCRIPTION: &str = "Replace exact or uniquely recoverable text in a file. The matcher \
                           preserves BOM and line endings, adapts uniform indentation, and \
                           rejects ambiguous matches with previews.";

/// Arguments emitted by the current `edit@rep.2` dialect.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceParams {
	/// Workspace-relative document path.
	pub path:        Str,
	/// Exact or uniquely recoverable text to replace.
	pub old_string:  Str,
	/// Replacement text.
	pub new_string:  Str,
	/// Replace every independently safe occurrence.
	#[serde(default)]
	pub replace_all: bool,
}

/// Historical batch arguments retained only for durable `edit@rep.1` replay.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyReplaceParams {
	/// One replacement per document snapshot.
	pub edits: Vec<LegacyReplaceOperation>,
}

/// Historical `edit@rep.1` operation.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyReplaceOperation {
	/// Workspace-relative document path.
	pub path:        Str,
	/// Text to locate using the progressive fallback ladder.
	pub old:         Str,
	/// Text replacing the selected match.
	pub new:         Str,
	/// Replace every independently safe occurrence.
	#[serde(default)]
	pub replace_all: bool,
	/// Request fuzzy fallback after exact normalization.
	#[serde(default = "default_allow_fuzzy")]
	pub allow_fuzzy: bool,
	/// Historical fuzzy similarity threshold override.
	pub threshold:   Option<f64>,
}

#[derive(Clone, Debug)]
struct ReplaceOperation {
	path:        Str,
	old:         Str,
	new:         Str,
	replace_all: bool,
	allow_fuzzy: bool,
	threshold:   Option<f64>,
}

trait ReplaceArguments: serde::de::DeserializeOwned + Serialize + Send + Sync + 'static {
	fn into_operations(self) -> Vec<ReplaceOperation>;
}

impl ReplaceArguments for ReplaceParams {
	fn into_operations(self) -> Vec<ReplaceOperation> {
		vec![ReplaceOperation {
			path:        self.path,
			old:         self.old_string,
			new:         self.new_string,
			replace_all: self.replace_all,
			allow_fuzzy: true,
			threshold:   None,
		}]
	}
}

impl ReplaceArguments for LegacyReplaceParams {
	fn into_operations(self) -> Vec<ReplaceOperation> {
		self
			.edits
			.into_iter()
			.map(|operation| ReplaceOperation {
				path:        operation.path,
				old:         operation.old,
				new:         operation.new,
				replace_all: operation.replace_all,
				allow_fuzzy: operation.allow_fuzzy,
				threshold:   operation.threshold,
			})
			.collect()
	}
}

const fn default_allow_fuzzy() -> bool {
	true
}

/// Current replacement executor. `P` is historical only for durable replay.
pub struct ReplaceTool<D, P = ReplaceParams> {
	documents:       D,
	format_policy:   FormatPolicy,
	observer:        EditObserver,
	guard_generated: bool,
	allow_fuzzy:     bool,
	fuzzy_threshold: f64,
	require_seen:    bool,
	spec:            ToolSpec,
	params:          PhantomData<fn() -> P>,
}

/// Returns the host-free `edit@rep.2` specification.
pub fn replace_spec() -> ToolSpec {
	replace_spec_for::<ReplaceParams>(2)
}

/// Returns the historical `edit@rep.1` specification.
pub fn legacy_replace_spec() -> ToolSpec {
	replace_spec_for::<LegacyReplaceParams>(1)
}

fn replace_spec_for<P: JsonSchema>(revision: u16) -> ToolSpec {
	ToolSpec {
		name:            sf!("edit"),
		rev:             Rev { family: sf!("rep"), n: revision },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<P>(),
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
			include_bytes!("replace.rs"),
		)
		.into(),
	}
}

/// Constructs the current old-text/new-text replacement dialect.
pub fn replace_tool<D: EditDocuments>(documents: D, format_policy: FormatPolicy) -> ReplaceTool<D> {
	replace_tool_with_observer(documents, format_policy, EditObserver::default(), true, true, false)
}

/// Constructs the current replacement dialect with host policy.
pub fn replace_tool_with_observer<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
	allow_fuzzy: bool,
	require_seen: bool,
) -> ReplaceTool<D> {
	ReplaceTool {
		documents,
		format_policy,
		observer,
		guard_generated,
		allow_fuzzy,
		fuzzy_threshold: DEFAULT_FUZZY_THRESHOLD,
		require_seen,
		spec: replace_spec(),
		params: PhantomData,
	}
}

/// Constructs the historical replacement revision for durable replay.
pub fn legacy_replace_tool_with_observer<D: EditDocuments>(
	documents: D,
	format_policy: FormatPolicy,
	observer: EditObserver,
	guard_generated: bool,
	allow_fuzzy: bool,
	require_seen: bool,
) -> ReplaceTool<D, LegacyReplaceParams> {
	ReplaceTool {
		documents,
		format_policy,
		observer,
		guard_generated,
		allow_fuzzy,
		fuzzy_threshold: DEFAULT_FUZZY_THRESHOLD,
		require_seen,
		spec: legacy_replace_spec(),
		params: PhantomData,
	}
}

impl<D, P> ReplaceTool<D, P> {
	/// Overrides the host-wide fuzzy similarity threshold used when a call
	/// does not carry a historical per-operation override.
	#[must_use]
	pub const fn with_fuzzy_threshold(mut self, threshold: f64) -> Self {
		self.fuzzy_threshold = threshold.clamp(0.0, 1.0);
		self
	}
}

struct Work<P> {
	op:       ReplaceOperation,
	prepared: P,
}

struct Projection {
	after:    Bytes,
	resolved: Vec<ResolvedEdit>,
	diags:    Vec<Diag>,
}

impl<D: EditDocuments, P: ReplaceArguments> Tool for ReplaceTool<D, P> {
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
			let replace_params = match params.whole::<P>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			let observer_args = serde_json::to_value(&replace_params).unwrap_or_default();
			let journal_input = if let Ok(input) = serde_json::to_vec(&replace_params) { Bytes::from(input) } else { yield done_fault(Fault::invalid("Replacement arguments could not be journaled.")); return; };
			let operations = replace_params.into_operations();
			if operations.is_empty() {
				yield done_fault(Fault::invalid("No replacement operations found in edits."));
				return;
			}
			span.record("path_count", operations.len());
			if let Some(operation) = operations.first() {
				span.record("path", tracing::field::display(&operation.path));
			}
			let mut works = Vec::with_capacity(operations.len());
			for op in operations {
				let prepared = match self.documents.prepare(PrepareRequest {
					path: op.path.clone(),
					file_hash: None,
					anchor_lines: Vec::new(),
					allow_unpinned: !self.require_seen,
					allow_missing: false,
					guard_generated: self.guard_generated,
				}).instrument(span.clone()).await {
					Ok(prepared) => prepared,
					Err(fault) => { yield done_fault(fault); return; },
				};
				if works.iter().any(|work: &Work<D::Prepared>| work.prepared.path() == prepared.path()) {
					yield done_fault(Fault::invalid("Multiple replacement operations resolve to the same file; combine their context into one operation."));
					return;
				}
				works.push(Work { op, prepared });
			}

			let mut proposals = Vec::with_capacity(works.len());
			let mut projections = Vec::with_capacity(works.len());
			let mut pending_blackbox = Vec::<PendingBlackbox>::new();
			for work in &works {
				let authored = match document_text(work.prepared.authored_bytes(), "authored document") {
					Ok(text) => text,
					Err(fault) => { yield done_fault(fault); return; },
				};
				let base = match document_text(work.prepared.base_bytes(), "current document") {
					Ok(text) => text,
					Err(fault) => { yield done_fault(fault); return; },
				};
				let allow_fuzzy = self.allow_fuzzy && work.op.allow_fuzzy;
				let threshold = Some(work.op.threshold.unwrap_or(self.fuzzy_threshold));
				let result = match replace_text(
					&authored.text,
					&work.op.old,
					&work.op.new,
					allow_fuzzy,
					work.op.replace_all,
					threshold,
				) {
					Ok(result) => result,
					Err(error) => { yield done_fault(Fault::invalid(error.to_string())); return; },
				};
				let resolved = span_edits(&authored.text, &result.content)
					.into_iter()
					.map(|edit| ResolvedEdit {
						start: line_at(&authored.text, edit.start),
						end: line_at_end(&authored.text, edit.start, edit.end),
						body: replacement_body(edit.replacement),
					})
					.collect();
				let authored_stale = work.prepared.authored_bytes() != work.prepared.base_bytes();
				let after = if authored_stale {
					match replace_text(
						&base.text,
						&work.op.old,
						&work.op.new,
						allow_fuzzy,
						work.op.replace_all,
						threshold,
					) {
						Ok(rebased) if rebased.content != base.text => {
							restore_text(&rebased.content, &base)
						},
						Ok(_) | Err(_) => {
							tracing::warn!(
								parent: &span,
								path = %work.prepared.display_path(),
								"replacement rebase overlapped a concurrent change",
							);
							yield done_fault(Fault::stale("The source snapshot changed and the replacement overlaps intervening edits; re-read the document."));
							return;
						},
					}
				} else {
					restore_text(&result.content, &authored)
				};
				if authored_stale {
					tracing::warn!(
						parent: &span,
						path = %work.prepared.display_path(),
						strategy = "exact_recovery",
						"replacement rebased over a changed document",
					);
				}
				let inspected = self.observer.inspect(
					AppliedEditSnapshot {
						path: work.prepared.path().clone(),
						before: work.prepared.base_bytes().clone(),
						after,
					},
					"replace",
					&observer_args,
				).instrument(span.clone()).await;
				let after = inspected.content;
				if let Err(fault) = utf8(&after, "edited document") {
					yield done_fault(fault);
					return;
				}
				let mut diags = work
					.prepared
					.path_recoveries()
					.iter()
					.map(path_recovery_diag)
					.collect::<Vec<_>>();
				diags.extend(inspected.diag);
				pending_blackbox.extend(inspected.pending);
				proposals.push(EditProposal {
					action: EditAction::Write { content: after.clone() },
					base_revision: work.prepared.base_revision().clone(),
					stale_policy: StalePolicy::RebaseNonOverlapping,
					format_policy: self.format_policy,
				});
				projections.push(Projection { after, resolved, diags });
			}

			let mut preview = String::new();
			let mut added_lines = 0;
			let mut removed_lines = 0;
			for (work, projection) in works.iter().zip(&projections) {
				let Ok(base) = document_text(work.prepared.base_bytes(), "current document") else { continue };
				let Ok(after) = document_text(&projection.after, "edited document") else { continue };
				let diff = generate_diff_string(&base.text, &after.text, None, &BlockContextSource {
					path: Some(work.prepared.display_path().as_str()),
					lang: None,
				});
				let compact = build_compact_diff_preview(&diff.diff, &CompactDiffOptions::default());
				if !preview.is_empty() && !compact.preview.is_empty() { preview.push('\n'); }
				preview.push_str(&compact.preview);
				added_lines += compact.added_lines;
				removed_lines += compact.removed_lines;
			}
			yield Ev::Update(EditUpdate { applied_ops: projections.iter().map(|projection| projection.resolved.len()).sum(), paths: works.iter().map(|work| work.prepared.display_path().clone()).collect(), preview: preview.into(), added_lines, removed_lines });
			match params.committed().await {
				Ok(_) => {},
				Err(error) => { yield commit_event(error); return; },
			}
			if let Some(index) = works.iter().zip(&projections).position(|(work, projection)| work.prepared.base_bytes() == &projection.after) {
				let work = &works[index];
				let NoopResult { diagnostic, escalate } = self.documents.record_noop(work.prepared.path(), work.prepared.display_path(), journal_input);
				if escalate || works.len() != 1 { yield done_fault(Fault::invalid(diagnostic)); return; }
				for diag in &projections[index].diags {
					yield Ev::Diag(diag.clone());
				}
				yield Ev::Done(ToolTerminal::Done { result: Ok(payload(&works, &projections, None)), useless: true });
				return;
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
					for work in &works { self.documents.reset_noop(work.prepared.path()); }
					for pending in pending_blackbox {
						self.observer.record_committed(pending).await;
					}
					for projection in &projections {
						for diag in &projection.diags {
							yield Ev::Diag(diag.clone());
						}
					}
					yield Ev::Done(ToolTerminal::Done { result: Ok(payload(&works, &projections, Some(&result.sections))), useless: false });
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
					let status = if section.op == SectionOp::Noop {
						"matched but changed no bytes"
					} else {
						"updated"
					};
					let _ = out.push(&format!("Replacement {status}: {}", section.path));
				}
			},
			Err(fault) => match &fault.reason {
				RejectionReason::Conflict => {
					let _ = out.push("Edit rejected: conflict");
				},
				RejectionReason::StaleUnrecoverable { message }
				| RejectionReason::Format { message }
				| RejectionReason::InvalidPatch { message } => {
					let _ = out.push(message);
				},
			},
		}
		out.finish()
	}
}

fn payload<P: EditPrepared>(
	works: &[Work<P>],
	projections: &[Projection],
	committed: Option<&[CommittedSection]>,
) -> Payload {
	Payload {
		sections: works
			.iter()
			.zip(projections)
			.enumerate()
			.map(|(index, (work, projection))| {
				let committed = committed.and_then(|sections| sections.get(index));
				let after = committed
					.and_then(|section| section.content.clone())
					.unwrap_or_else(|| projection.after.clone());
				let before_text = document_text(work.prepared.base_bytes(), "current document")
					.expect("prepared replacement document was validated as UTF-8");
				let after_text = document_text(&after, "replacement document")
					.expect("replacement document was validated as UTF-8");
				let numbered = generate_diff_string(
					&before_text.text,
					&after_text.text,
					None,
					&BlockContextSource {
						path: Some(work.prepared.display_path().as_str()),
						lang: None,
					},
				);
				let diff = Str::from(numbered.diff);
				let preview = build_compact_diff_preview(&diff, &CompactDiffOptions::default())
					.preview
					.into();
				SectionPayload {
					path: work.prepared.display_path().clone(),
					canonical_path: work.prepared.path().clone(),
					op: if work.prepared.base_bytes() == &projection.after {
						SectionOp::Noop
					} else {
						SectionOp::Update
					},
					move_dest: None,
					old_revision: work.prepared.base_revision().clone(),
					new_revision: committed.and_then(|section| section.new_revision.clone()),
					applied_ops: projection
						.resolved
						.iter()
						.enumerate()
						.map(|(index, edit)| AppliedOp {
							kind: sf!("replace"),
							patch_line: edit.start,
							index,
						})
						.collect(),
					resolved_edits: projection.resolved.clone(),
					rebased: committed.is_some_and(|section| section.rebased),
					before: work.prepared.base_bytes().clone(),
					before_blob: None,
					after,
					after_blob: None,
					header: Some(
						format_hashline_header(
							work.prepared.display_path(),
							&file_hash(&after_text.text),
						)
						.into(),
					),
					diff,
					preview,
					first_changed_line: projection.resolved.first().map(|edit| edit.start),
					block_resolutions: Vec::new(),
					diagnostics: committed.map_or_else(Vec::new, |section| section.diagnostics.clone()),
					diagnostics_complete: committed.is_none_or(|section| section.diagnostics_complete),
				}
			})
			.collect(),
	}
}

fn line_at(text: &str, offset: usize) -> usize {
	text.as_bytes()[..offset]
		.iter()
		.filter(|byte| **byte == b'\n')
		.count()
		+ 1
}

fn line_at_end(text: &str, start: usize, end: usize) -> usize {
	let mut line = line_at(text, end);
	if end > start && text.as_bytes().get(end.saturating_sub(1)) == Some(&b'\n') {
		line = line.saturating_sub(1);
	}
	line.max(line_at(text, start))
}

fn replacement_body(text: &str) -> Vec<Str> {
	if text.is_empty() {
		return Vec::new();
	}
	let text = text.replace("\r\n", "\n");
	text
		.strip_suffix('\n')
		.unwrap_or(&text)
		.split('\n')
		.map(Str::new)
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ladder_handles_unicode_bom_crlf_and_indentation() {
		let unicode = replace_text(
			"\u{feff}say “hello”\r\n",
			"say \"hello\"\n",
			"say \"goodbye\"\n",
			true,
			false,
			None,
		)
		.expect("unicode fallback");
		assert_eq!(unicode.content, "\u{feff}say \"goodbye\"\n");
		assert_eq!(
			omp_edit::text::adjust_indentation("foo\nbar", "    foo\n    bar", "foo\nbaz\nbar",),
			"    foo\n    baz\n    bar"
		);
	}

	#[test]
	fn host_fuzzy_threshold_overrides_the_library_default() {
		let make = || ReplaceTool::<()> {
			documents:       (),
			format_policy:   FormatPolicy::Disabled,
			observer:        EditObserver::default(),
			guard_generated: true,
			allow_fuzzy:     true,
			fuzzy_threshold: DEFAULT_FUZZY_THRESHOLD,
			require_seen:    false,
			spec:            replace_spec(),
			params:          PhantomData,
		};
		assert_eq!(make().with_fuzzy_threshold(0.87).fuzzy_threshold, 0.87);
		assert_eq!(make().with_fuzzy_threshold(2.0).fuzzy_threshold, 1.0);
	}

	#[test]
	fn ambiguous_and_noop_replacements_remain_actionable() {
		let ambiguous = replace_text("same\nsame\n", "same", "changed", false, false, None)
			.expect_err("ambiguous exact matches must not select arbitrarily");
		assert!(ambiguous.to_string().contains("Found 2 occurrences"));
		let noop = replace_text("same\n", "same", "same", false, false, None)
			.expect("identical replacement is represented by unchanged content");
		assert_eq!(noop.content, "same\n");
	}
}
