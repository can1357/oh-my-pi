//! Native edit renderer: streaming diff previews and settled per-file diffs.

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::view::El;
use crate::{
	edit::{EditUpdate, Fault as EditFault, Payload as EditPayload, SectionPayload as EditSection},
	gallery::RendererGalleryFixture,
	view,
};

#[derive(Default)]
pub(super) struct EditState {
	latest: Option<EditUpdate>,
	input:  Option<Str>,
}

pub(super) struct EditRenderer;

impl RenderFold for EditRenderer {
	type Outcome = CallOutcome<EditPayload, EditFault>;
	type State = EditState;
	type Update = EditUpdate;

	fn fold(&self, state: &mut Self::State, update: Self::Update) {
		state.latest = Some(update);
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(input) = args
			.get("input")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.input = Some(Str::new(input));
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_edit_live(state.latest.as_ref(), state.input.as_deref()).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_edit_payload(payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(render_edit_fault(fault).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

const COLLAPSED_EDIT_DIFF_ROWS: u16 = omp_edit::COLLAPSED_DIFF_ROWS;

fn render_edit_live(update: Option<&EditUpdate>, input: Option<&str>) -> El {
	if let Some(update) = update {
		return view! {
			<col gap=0>
				<row gap=1>
					if let Some(path) = update.paths.first() {
						<text bold>{path}</text>
						if update.paths.len() > 1 {
							<text fg=muted>{sf!("+{} more files", update.paths.len() - 1)}</text>
						}
					}
					<diffstat
						added={update.added_lines}
						removed={update.removed_lines}
						ops={update.applied_ops}
					/>
				</row>
				<diff max-rows={COLLAPSED_EDIT_DIFF_ROWS} overflow="diff rows">
					{&update.preview}
				</diff>
				<row gap=1>
					<spinner color=accent/>
					<text fg=muted>{"preview"}</text>
				</row>
			</col>
		};
	}

	let Some(input) = input else {
		return view! { <spinner color=accent label="Preparing diff"/> };
	};
	let (ops, added, removed) = input_stats(input);
	let preview = input_preview(input);
	view! {
		<col gap=0>
			<row gap=1>
				if let Some(path) = input_path(input) {
					<text bold>{path}</text>
				}
				<diffstat added={added} removed={removed} ops={ops}/>
			</row>
			<diff max-rows={COLLAPSED_EDIT_DIFF_ROWS} overflow="diff rows">{preview}</diff>
			<row gap=1>
				<spinner color=accent/>
				<text fg=muted>{"streaming arguments"}</text>
			</row>
		</col>
	}
}

fn input_preview(input: &str) -> String {
	let mut preview = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if trimmed.starts_with("PUT ")
			|| trimmed.starts_with("CUT ")
			|| trimmed == "REM"
			|| trimmed.starts_with("MV ")
		{
			preview.push_str("@@ ");
			preview.push_str(trimmed);
			preview.push_str(" @@\n");
		} else if line.starts_with('+') {
			preview.push_str(line);
			preview.push('\n');
		}
	}
	if preview.ends_with('\n') {
		preview.pop();
	}
	preview
}

fn input_path(input: &str) -> Option<&str> {
	let header = input.lines().next()?.trim().strip_prefix('[')?;
	let path = header.split_once('#').map_or(header, |(path, _)| path);
	Some(path.trim_end_matches(']'))
}

fn input_stats(input: &str) -> (usize, usize, usize) {
	let mut ops = 0;
	let mut added = 0;
	let mut removed = 0;
	for line in input.lines() {
		let trimmed = line.trim_start();
		if trimmed.starts_with("PUT ") {
			ops += 1;
			removed += replaced_line_count(trimmed);
		} else if trimmed.starts_with("CUT ") {
			ops += 1;
			removed += replaced_line_count(trimmed);
		} else if trimmed == "REM" || trimmed.starts_with("MV ") {
			ops += 1;
		} else if line.starts_with('+') {
			added += 1;
		}
	}
	(ops, added, removed)
}

fn replaced_line_count(op: &str) -> usize {
	let Some(range) = op.split_ascii_whitespace().nth(1) else {
		return 0;
	};
	let range = range.trim_end_matches([':', '*']);
	let Some((start, end)) = range.split_once(".=") else {
		return 0;
	};
	let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) else {
		return 0;
	};
	end.saturating_sub(start).saturating_add(1)
}

fn render_edit_payload(payload: &EditPayload) -> El {
	view! {
		<col gap=1>
			for section in &payload.sections {
				{render_edit_section(section)}
			}
		</col>
	}
}

fn render_edit_section(section: &EditSection) -> El {
	let (added, removed) = diff_stats(&section.diff);
	view! {
		<col gap=0>
			<row gap=1>
				<text bold>{&section.path}</text>
				<diffstat added={added} removed={removed} ops={section.applied_ops.len()}/>
				if section.rebased {
					<text fg=warn>{"rebased"}</text>
				}
			</row>
			<diff max-rows={COLLAPSED_EDIT_DIFF_ROWS} overflow="diff rows">
				{&section.diff}
				for (index, diagnostic) in section.diagnostics.iter().enumerate() {
					if !section.diff.is_empty() || index > 0 { {"\n"} }
					{"! "}
					if !diagnostic.source.is_empty() {
						{&diagnostic.source}
						if !diagnostic.code.is_empty() {
							{"["}{&diagnostic.code}{"]"}
						}
						{": "}
					}
					{&diagnostic.message}
				}
				if !section.diagnostics_complete {
					if !section.diff.is_empty() || !section.diagnostics.is_empty() { {"\n"} }
					{"! Additional LSP diagnostics are still settling"}
				}
			</diff>
		</col>
	}
}

fn diff_stats(diff: &str) -> (usize, usize) {
	diff.lines().fold((0, 0), |(added, removed), line| {
		(
			added + usize::from(line.starts_with('+') && !line.starts_with("+++")),
			removed + usize::from(line.starts_with('-') && !line.starts_with("---")),
		)
	})
}

fn render_edit_fault(fault: &EditFault) -> El {
	use crate::edit::RejectionReason;

	view! {
		<col gap=1>
			<callout kind="error" title="Edit could not be applied">
				match &fault.reason {
					RejectionReason::Conflict => {
						{"The file changed after this edit was prepared. Re-read the affected lines and retry against the current contents."}
					},
					RejectionReason::StaleUnrecoverable { message }
					| RejectionReason::Format { message }
					| RejectionReason::InvalidPatch { message } => {
						{message}
					},
				}
			</callout>
			if !fault.conflicts.is_empty() {
				<fact label="Conflicting ranges">
					<col gap=0>
						for conflict in &fault.conflicts {
							<row sep=" · ">
								<text bold>{sf!("lines {}-{}", conflict.start_line, conflict.end_line)}</text>
								<text>{&conflict.message}</text>
							</row>
						}
					</col>
				</fact>
			}
		</col>
	}
}

/// Native edit renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(edit: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: edit,
			streaming_args: r#"{"input":"[packages/coding-agent/src/tools/read.ts#7F18]\nPUT 82.=82:\n+function readTextSli"#,
			args: r#"{"input":"[packages/coding-agent/src/tools/read.ts#7F18]\nPUT 82.=82:\n+function readTextSlice(raw: string, offset: number, limit: number): string {\nPUT 212.=212:\n+\tconst content = readTextSlice(raw, offset, limit);"}"#,
			progress_update: Some(
				br#"{"applied_ops":2,"paths":["packages/coding-agent/src/tools/read.ts"],"preview":"@@ -80,5 +80,5 @@\n-function readFileSlice(raw: string, offset: number, limit: number): string {\n+function readTextSlice(raw: string, offset: number, limit: number): string {\n \treturn raw.split(\"\\n\").slice(offset - 1, offset - 1 + limit).join(\"\\n\");\n@@ -210,5 +210,5 @@\n-\tconst content = readFileSlice(raw, offset, limit);\n+\tconst content = readTextSlice(raw, offset, limit);","added_lines":2,"removed_lines":2}"#,
			),
			success_outcome: r#"{"kind":"ok","value":{"sections":[{"path":"packages/coding-agent/src/tools/read.ts","canonical_path":"/work/omp/packages/coding-agent/src/tools/read.ts","op":"update","move_dest":null,"old_revision":"sha256:7f18a2","new_revision":"sha256:c2e940","applied_ops":[{"kind":"replace","patch_line":3,"index":0},{"kind":"replace","patch_line":8,"index":1}],"rebased":true,"before":[],"after":[],"header":"packages/coding-agent/src/tools/read.ts#c2e9","diff":"@@ -80,7 +80,7 @@\n  80│type ReadWindow = { offset: number; limit: number };\n  81│\n- 82│function readFileSlice(raw: string, offset: number, limit: number): string {\n+ 82│function readTextSlice(raw: string, offset: number, limit: number): string {\n  83│\treturn raw.split(\"\\n\").slice(offset - 1, offset - 1 + limit).join(\"\\n\");\n  84│}\n@@ -210,5 +210,5 @@\n 210│\tconst offset = args.offset ?? 1;\n 211│\tconst limit = args.limit ?? 4000;\n-212│\tconst content = readFileSlice(raw, offset, limit);\n+212│\tconst content = readTextSlice(raw, offset, limit);\n 213│\treturn { content, offset, limit };","preview":"@@ -80,7 +80,7 @@\n-function readFileSlice(raw: string, offset: number, limit: number): string {\n+function readTextSlice(raw: string, offset: number, limit: number): string {\n@@ -210,5 +210,5 @@\n-\tconst content = readFileSlice(raw, offset, limit);\n+\tconst content = readTextSlice(raw, offset, limit);","first_changed_line":82,"block_resolutions":[],"warnings":[],"diagnostics":[],"diagnostics_complete":true}]}}"#.as_bytes(),
			error_outcome: br#"{"kind":"faulted","value":{"reason":{"kind":"invalid_patch","message":"No match for the expected context near `function readFileSlice`. The file now declares `function readTextSlice`; re-read the file and retry with its current contents."},"conflicts":[{"start_line":82,"end_line":84,"message":"Function declaration no longer matches the submitted hunk context"},{"start_line":210,"end_line":213,"message":"Callsite range changed after the edit was prepared"}]}}"#,
		},
	]
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_core::sf;
	use omp_tool::{CallOutcome, render::ViewState};

	use super::{gallery_fixtures, render_edit_fault, render_edit_payload};
	use crate::{
		edit::{EditUpdate, Fault as EditFault, Payload as EditPayload},
		render::test_support::{identities, registry},
	};

	#[test]
	fn edit_update_reduces_to_compact_live_diff() {
		let (registry, identities) = registry(identities());
		let update = EditUpdate {
			applied_ops:   2,
			paths:         vec![sf!("src/lib.rs"), sf!("src/other.rs")],
			preview:       sf!("+&lt;already-markup"),
			added_lines:   3,
			removed_lines: 1,
		};
		let mut state = ViewState::new();
		registry
			.fold(
				identities.edit.as_ref().unwrap(),
				&mut state,
				Bytes::from(serde_json::to_vec(&update).expect("update serializes")),
			)
			.expect("typed update folds");
		assert_eq!(state.raw_update_count(), 0);
		assert_eq!(
			registry
				.view(identities.edit.as_ref().unwrap(), &state, None)
				.expect("live edit renders")
				.as_str(),
			"<col gap=0><row gap=1><text bold>src/lib.rs</text><text fg=muted>+1 more \
			 files</text><diffstat added=3 removed=1 ops=2/></row><diff max-rows=40 overflow=\"diff \
			 rows\">+&amp;lt;already-markup</diff><row gap=1><spinner color=accent/><text \
			 fg=muted>preview</text></row></col>",
		);
	}

	#[test]
	fn edit_streaming_args_render_partial_hashline_preview() {
		let (registry, identities) = registry(identities());
		let identity = identities.edit.as_ref().expect("edit identity");
		let args = omp_core::slopjson::parse_streaming(
			r#"{"input":"[src/read.rs#1234]\nPUT 4.=4:\n+fn new_name("#,
		);
		let mut state = ViewState::new();
		registry
			.fold_args(identity, &mut state, &args, false)
			.expect("partial args fold");
		assert_eq!(
			registry
				.view(identity, &state, None)
				.expect("streaming args render")
				.as_str(),
			"<col gap=0><row gap=1><text bold>src/read.rs</text><diffstat added=1 removed=1 \
			 ops=1/></row><diff max-rows=40 overflow=\"diff rows\">@@ PUT 4.=4: @@\n+fn \
			 new_name(</diff><row gap=1><spinner color=accent/><text fg=muted>streaming \
			 arguments</text></row></col>",
		);
	}

	#[test]
	fn edit_success_renders_numbered_hunks_diagnostics_and_annotations() {
		let payload: EditPayload = serde_json::from_slice(
			r#"{"sections":[{"path":"src/read.rs","canonical_path":"/work/omp/src/read.rs","op":"update","move_dest":null,"old_revision":"old","new_revision":"new","applied_ops":[{"kind":"replace","patch_line":3,"index":0},{"kind":"replace","patch_line":8,"index":1}],"rebased":true,"before":[],"after":[],"header":"src/read.rs#1234","diff":"@@ -4,2 +4,2 @@\n- 4│old_name();\n+ 4│new_name();","preview":"","first_changed_line":4,"block_resolutions":[],"warnings":[],"diagnostics":[{"range":null,"severity":"error","code":"E0425","source":"rust-analyzer","message":"cannot find function `old_name`"}],"diagnostics_complete":true}]}"#.as_bytes(),
		)
		.expect("payload decodes");
		assert_eq!(
			render_edit_payload(&payload).to_tml(),
			"<col gap=1><col gap=0><row gap=1><text bold>src/read.rs</text><diffstat added=1 \
			 removed=1 ops=2/><text fg=warn>rebased</text></row><diff max-rows=40 overflow=\"diff \
			 rows\">@@ -4,2 +4,2 @@\n- 4│old_name();\n+ 4│new_name();\n! rust-analyzer[E0425]: \
			 cannot find function `old_name`</diff></col></col>",
		);
	}

	#[test]
	fn edit_failure_explains_context_mismatch_and_ranges() {
		let fault: EditFault = serde_json::from_slice(
			br#"{"reason":{"kind":"invalid_patch","message":"No match for the expected context near `old_name`."},"conflicts":[{"start_line":4,"end_line":6,"message":"The function was renamed before this edit ran"}]}"#,
		)
		.expect("fault decodes");
		assert_eq!(
			render_edit_fault(&fault).to_tml(),
			"<col gap=1><callout kind=error title=\"Edit could not be applied\">No match for the \
			 expected context near `old_name`.</callout><fact label=\"Conflicting ranges\"><col \
			 gap=0><row sep=\" · \"><text bold>lines 4-6</text><text>The function was renamed before \
			 this edit ran</text></row></col></fact></col>",
		);
	}

	#[test]
	fn edit_gallery_fixtures_decode_through_typed_contracts() {
		let identity = identities().edit.expect("edit identity");
		let fixture = gallery_fixtures(identity).pop().expect("edit fixture");
		serde_json::from_slice::<EditUpdate>(fixture.progress_update.expect("progress update"))
			.expect("progress update decodes");
		serde_json::from_slice::<CallOutcome<EditPayload, EditFault>>(fixture.success_outcome)
			.expect("success outcome decodes");
		serde_json::from_slice::<CallOutcome<EditPayload, EditFault>>(fixture.error_outcome)
			.expect("error outcome decodes");
	}
}
