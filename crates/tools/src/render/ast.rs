//! Native structural search and rewrite renderers.

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::view::El;
use crate::{
	ast_edit::{Fault as AstEditFault, Payload as AstEditPayload, Update as AstEditUpdate},
	ast_grep::{Fault as AstGrepFault, Payload as AstGrepPayload, Update as AstGrepUpdate},
	gallery::RendererGalleryFixture,
	view,
};

const AST_PREVIEW_ROWS: usize = 40;

#[derive(Default)]
pub(super) struct AstGrepState {
	pattern: Option<Str>,
	scope:   Option<Str>,
}

pub(super) struct AstGrepRenderer;

impl RenderFold for AstGrepRenderer {
	type Outcome = CallOutcome<AstGrepPayload, AstGrepFault>;
	type State = AstGrepState;
	type Update = AstGrepUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		state.pattern = args
			.get("pat")
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new);
		state.scope = args
			.get("path")
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new)
			.or_else(|| complete.then(|| Str::new(".")));
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_ast_grep_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_ast_grep_payload(payload).into()),
			Some(CallOutcome::Faulted(fault)) => {
				Some(render_ast_fault("ast_grep", &fault.to_string()).into())
			},
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

#[derive(Default)]
pub(super) struct AstEditState {
	pattern:     Option<Str>,
	replacement: Option<Str>,
	scope:       Option<Str>,
}

pub(super) struct AstEditRenderer;

impl RenderFold for AstEditRenderer {
	type Outcome = CallOutcome<AstEditPayload, AstEditFault>;
	type State = AstEditState;
	type Update = AstEditUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		let operation = args
			.get("ops")
			.and_then(omp_core::slopjson::Value::as_array)
			.and_then(|operations| operations.first());
		state.pattern = operation
			.and_then(|operation| operation.get("pat"))
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new);
		state.replacement = operation
			.and_then(|operation| operation.get("out"))
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new);
		state.scope = args
			.get("paths")
			.and_then(omp_core::slopjson::Value::as_array)
			.and_then(joined_slop_strings);
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_ast_edit_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_ast_edit_payload(payload).into()),
			Some(CallOutcome::Faulted(fault)) => {
				Some(render_ast_fault("ast_edit", &fault.to_string()).into())
			},
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn joined_slop_strings(values: &[omp_core::slopjson::Value]) -> Option<Str> {
	let capacity = values
		.iter()
		.filter_map(omp_core::slopjson::Value::as_str)
		.map(str::len)
		.sum::<usize>()
		.saturating_add(values.len().saturating_sub(1).saturating_mul(2));
	let mut output = String::with_capacity(capacity);
	for value in values {
		let Some(value) = value.as_str() else {
			continue;
		};
		if !output.is_empty() {
			output.push_str(", ");
		}
		output.push_str(value);
	}
	(!output.is_empty()).then(|| Str::new(output))
}

fn render_ast_grep_live(state: &AstGrepState) -> El {
	view! {
		<row gap=1>
			<state status="running"/>
			<text bold>{state.pattern.as_deref().unwrap_or("matching syntax")}</text>
			if let Some(scope) = &state.scope {
				<text fg=muted>{"in "}{scope}</text>
			}
		</row>
	}
}

fn render_ast_edit_live(state: &AstEditState) -> El {
	view! {
		<col gap=0>
			<row gap=1>
				<state status="running"/>
				<text bold>{state.pattern.as_deref().unwrap_or("preparing rewrite")}</text>
				if let Some(replacement) = &state.replacement {
					<text fg=muted>{"→"}</text>
					<text bold>{replacement}</text>
				}
			</row>
			if let Some(scope) = &state.scope {
				<text fg=muted>{"in "}{scope}</text>
			}
		</col>
	}
}

fn render_ast_grep_payload(payload: &AstGrepPayload) -> El {
	view! {
		<col gap=0>
			<row gap=1>
				<text bold fg=accent>
					{sf!(
						"{} matches · {} files · {} searched",
						payload.total,
						payload.files_with_matches,
						payload.files_searched
					)}
				</text>
			</row>
			<col gap=0 max-rows={AST_PREVIEW_ROWS} overflow="matches">
				for (index, matched) in payload.matches.iter().enumerate() {
					if index == 0 || payload.matches[index - 1].path != matched.path {
						<text bold fg=accent>{"# "}{&matched.path}</text>
					}
					<pre numbers start={matched.line}>{&matched.text}</pre>
					if !matched.bindings.is_empty() {
						<fact label="Bindings"><text fg=muted>{&matched.bindings}</text></fact>
					}
				}
			</col>
			if let Some(skip) = payload.next_skip {
				<fact label="Next skip">{skip.to_string()}</fact>
			}
			for advisory in &payload.advisories {
				<callout kind="warn">{&advisory.path}{": "}{&advisory.message}</callout>
			}
			if payload.advisories_total > payload.advisories.len() {
				<callout kind="warn">
					{sf!(
						"{} additional advisories omitted",
						payload.advisories_total - payload.advisories.len()
					)}
				</callout>
			}
			for error in &payload.parse_errors {
				<callout kind="warn">{error}</callout>
			}
			if payload.parse_errors_total > payload.parse_errors.len() {
				<callout kind="warn">
					{sf!(
						"{} additional parse issues omitted",
						payload.parse_errors_total - payload.parse_errors.len()
					)}
				</callout>
			}
		</col>
	}
}

fn render_ast_edit_payload(payload: &AstEditPayload) -> El {
	view! {
		<col gap=1>
			<row gap=1>
				<text bold fg=accent>
					{sf!(
						"{} replacements · {} files",
						payload.total_replacements,
						payload.files_touched
					)}
				</text>
			</row>
			for (file, (added, removed)) in payload
				.files
				.iter()
				.map(|file| (file, diff_line_counts(&file.diff)))
			{
				<col gap=0>
					<text bold>{&file.path}</text>
					<diffstat added={added} removed={removed} ops={file.replacements}/>
					<diff max-rows=40 overflow="diff rows">{&file.diff}</diff>
				</col>
			}
			if let Some(proposal) = &payload.pending_proposal {
				<row gap=1>
					<state status="active"/>
					<text bold>{"proposed"}</text>
					<fact label="Proposal">{proposal}</fact>
					<text fg=muted>{"resolve or reject this exact id"}</text>
				</row>
			} else if let Some(recovery_root) = &payload.recovery_root {
				<row gap=1>
					<state status="completed"/>
					<text bold>{"applied"}</text>
					<fact label="Recovery">{recovery_root}</fact>
				</row>
			}
			for advisory in &payload.advisories {
				<callout kind="warn">{&advisory.path}{": "}{&advisory.message}</callout>
			}
			if payload.advisories_total > payload.advisories.len() {
				<callout kind="warn">
					{sf!(
						"{} additional advisories omitted",
						payload.advisories_total - payload.advisories.len()
					)}
				</callout>
			}
			for error in &payload.parse_errors {
				<callout kind="warn">{error}</callout>
			}
			if payload.parse_errors_total > payload.parse_errors.len() {
				<callout kind="warn">
					{sf!(
						"{} additional parse issues omitted",
						payload.parse_errors_total - payload.parse_errors.len()
					)}
				</callout>
			}
		</col>
	}
}

fn diff_line_counts(diff: &str) -> (usize, usize) {
	let mut added = 0usize;
	let mut removed = 0usize;
	for line in diff.lines() {
		if line.starts_with('+') && !line.starts_with("+++") {
			added += 1;
		} else if line.starts_with('-') && !line.starts_with("---") {
			removed += 1;
		}
	}
	(added, removed)
}

fn render_ast_fault(name: &str, message: &str) -> El {
	view! {
		<callout kind="error">{name}{": "}{message}</callout>
	}
}

/// Native AST renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(
	ast_grep: ToolIdentity,
	ast_edit: ToolIdentity,
) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity:       ast_grep,
			streaming_args: r#"{"pat":"console.$METHOD($AR"#,
			args:           r#"{"pat":"console.$METHOD($ARG)","path":"packages/tui/src/**/*.ts"}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"matches":[{"path":"packages/tui/src/runtime/logger.ts","line":38,"column":2,"end_line":38,"end_column":48,"text":"console.warn(\"slow render\", durationMs)","bindings":"$ARG=durationMs, $METHOD=warn"},{"path":"packages/tui/src/runtime/session.ts","line":91,"column":3,"end_line":91,"end_column":37,"text":"console.error(\"session failed\", error)","bindings":"$ARG=error, $METHOD=error"},{"path":"packages/tui/src/views/DebugPanel.ts","line":24,"column":4,"end_line":24,"end_column":35,"text":"console.log(\"state\", nextState)","bindings":"$ARG=nextState, $METHOD=log"}],"advisories":[],"advisories_total":0,"parse_errors":[],"parse_errors_total":0,"total":3,"files_with_matches":3,"files_searched":17,"skip":0,"limit":50,"limit_reached":false,"next_skip":null}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"pattern parse error: expected a complete call expression after `console.`"}}"#,
		},
		RendererGalleryFixture {
			identity:       ast_edit,
			streaming_args: r#"{"ops":[{"pat":"$A && $A.$B","out":"$A?."#,
			args:           r#"{"ops":[{"pat":"$A && $A.$B","out":"$A?.$B"}],"paths":["packages/tui/src/**/*.ts"]}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"files":[{"path":"packages/tui/src/components/Message.ts","replacements":2,"before_hash":"a71c9d3b245e","after_hash":"9d21b8f4430a","diff":" 40|export function authorName(message: Message) {\n-41|  return message.author && message.author.name;\n+41|  return message.author?.name;\n 42|}\n-67|  const avatar = user && user.avatar;\n+67|  const avatar = user?.avatar;"},{"path":"packages/tui/src/runtime/session.ts","replacements":1,"before_hash":"52f6a77e8c03","after_hash":"e048bfc91d77","diff":" 88|  const active = sessions.get(id);\n-89|  return active && active.transport;\n+89|  return active?.transport;\n 90|}"}],"advisories":[],"advisories_total":0,"parse_errors":[],"parse_errors_total":0,"files_searched":17,"files_touched":2,"total_replacements":3,"recovery_root":null,"pending_proposal":"proposal-ast-edit-7"}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"operation 1 pattern parse error: unmatched `(`"}}"#,
		},
	]
}

#[cfg(test)]
mod tests {
	use omp_tool::Rev;

	use super::*;

	fn identity(name: &str) -> ToolIdentity {
		ToolIdentity { name: Str::new(name), rev: Rev { family: Str::new(""), n: 1 } }
	}

	#[test]
	fn ast_grep_fixture_uses_running_state_and_retained_match_primitives() {
		let fixture = gallery_fixtures(identity("ast_grep"), identity("ast_edit")).remove(0);
		let outcome: CallOutcome<AstGrepPayload, AstGrepFault> =
			serde_json::from_slice(fixture.success_outcome).unwrap();
		let mut state = AstGrepState::default();
		AstGrepRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(fixture.streaming_args),
			false,
		);
		let live = AstGrepRenderer
			.view(&state, None)
			.expect("streaming ast_grep renders");
		assert!(live.contains("<state status=running/>"));
		assert!(live.contains("console.$METHOD($AR"));

		AstGrepRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(fixture.args),
			true,
		);
		let view = AstGrepRenderer
			.view(&state, Some(&outcome))
			.expect("ast_grep renders");

		assert!(view.contains("3 matches · 3 files"));
		assert!(view.contains("<col gap=0 max-rows=40 overflow=matches>"));
		assert!(view.contains("# packages/tui/src/runtime/logger.ts"));
		assert!(view.contains("<pre numbers start=38>"));
		assert!(view.contains("<fact label=Bindings><text fg=muted>$ARG=durationMs, $METHOD=warn"));
		assert!(!view.contains("<row gap=0>"));
		assert!(!view.contains("ctrl+o"));
	}

	#[test]
	fn ast_grep_multiline_match_preserves_body_cursor_advisory_and_escaping() {
		let payload: AstGrepPayload = serde_json::from_str(
			r#"{"matches":[{"path":"src/<tree>.rs","line":7,"column":1,"end_line":9,"end_column":2,"text":"if (ready) {\n  run(<node> & value);\n}","bindings":"$A=<node>&"}],"advisories":[{"path":"src/<bad>.rs","message":"cannot parse <syntax> & input"}],"advisories_total":1,"parse_errors":[],"parse_errors_total":0,"total":19,"files_with_matches":4,"files_searched":12,"skip":11,"limit":1,"limit_reached":true,"next_skip":12}"#,
		)
		.unwrap();
		let view = render_ast_grep_payload(&payload).to_tml();

		assert!(view.contains("# src/&lt;tree&gt;.rs"));
		assert!(
			view.contains(
				"<pre numbers start=7>if (ready) {\n  run(&lt;node&gt; &amp; value);\n}</pre>"
			)
		);
		assert!(view.contains("$A=&lt;node&gt;&amp;"));
		assert!(view.contains("<fact label=\"Next skip\">12</fact>"));
		assert!(view.contains(
			"<callout kind=warn>src/&lt;bad&gt;.rs: cannot parse &lt;syntax&gt; &amp; input</callout>"
		));
	}

	#[test]
	fn ast_edit_fixture_uses_bounded_diffstat_and_active_proposal_state() {
		let fixture = gallery_fixtures(identity("ast_grep"), identity("ast_edit")).remove(1);
		let outcome: CallOutcome<AstEditPayload, AstEditFault> =
			serde_json::from_slice(fixture.success_outcome).unwrap();
		let mut state = AstEditState::default();
		AstEditRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(fixture.streaming_args),
			false,
		);
		let live = AstEditRenderer
			.view(&state, None)
			.expect("streaming ast_edit renders");
		assert!(live.contains("<state status=running/>"));
		assert!(live.contains("$A?."));

		AstEditRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(fixture.args),
			true,
		);
		let view = AstEditRenderer
			.view(&state, Some(&outcome))
			.expect("ast_edit renders");

		assert!(view.contains("3 replacements · 2 files"));
		assert!(view.contains("<diffstat added=2 removed=2 ops=2/>"));
		assert!(view.contains("<diffstat added=1 removed=1 ops=1/>"));
		assert!(view.contains("<diff max-rows=40 overflow=\"diff rows\">"));
		assert!(view.contains("-41|"));
		assert!(view.contains("+41|"));
		assert!(view.contains("<state status=active/><text bold>proposed</text>"));
		assert!(view.contains("<fact label=Proposal>proposal-ast-edit-7</fact>"));
		assert!(!view.contains("⟨proposed⟩"));
	}

	#[test]
	fn ast_edit_applied_state_preserves_recovery_and_advisory() {
		let payload: AstEditPayload = serde_json::from_str(
			r#"{"files":[{"path":"src/main.rs","replacements":1,"before_hash":"000000000000","after_hash":"111111111111","diff":"-1|old\n+1|new"}],"advisories":[{"path":"src/<skip>.rs","message":"unsupported <language> & encoding"}],"advisories_total":1,"parse_errors":["src/<broken>.rs: parse error & recovered"],"parse_errors_total":2,"files_searched":2,"files_touched":1,"total_replacements":1,"recovery_root":".omp/recovery/<snapshot>&","pending_proposal":null}"#,
		)
		.unwrap();
		let view = render_ast_edit_payload(&payload).to_tml();

		assert!(view.contains("<state status=completed/><text bold>applied</text>"));
		assert!(view.contains("<fact label=Recovery>.omp/recovery/&lt;snapshot&gt;&amp;</fact>"));
		assert!(view.contains(
			"<callout kind=warn>src/&lt;skip&gt;.rs: unsupported &lt;language&gt; &amp; \
			 encoding</callout>"
		));
		assert!(view.contains(
			"<callout kind=warn>src/&lt;broken&gt;.rs: parse error &amp; recovered</callout>"
		));
		assert!(view.contains("<callout kind=warn>1 additional parse issues omitted</callout>"));
	}

	#[test]
	fn ast_faults_use_error_callouts_with_escaped_facts() {
		let grep_fixture = gallery_fixtures(identity("ast_grep"), identity("ast_edit")).remove(0);
		let grep_fault: CallOutcome<AstGrepPayload, AstGrepFault> =
			serde_json::from_slice(grep_fixture.error_outcome).unwrap();
		let grep_view = AstGrepRenderer
			.view(&AstGrepState::default(), Some(&grep_fault))
			.expect("ast_grep fault renders");
		assert!(grep_view.starts_with("<callout kind=error>ast_grep: "));
		assert!(grep_view.ends_with("</callout>"));

		let edit_fixture = gallery_fixtures(identity("ast_grep"), identity("ast_edit")).remove(1);
		let edit_fault: CallOutcome<AstEditPayload, AstEditFault> =
			serde_json::from_slice(edit_fixture.error_outcome).unwrap();
		let edit_view = AstEditRenderer
			.view(&AstEditState::default(), Some(&edit_fault))
			.expect("ast_edit fault renders");
		assert!(edit_view.starts_with("<callout kind=error>ast_edit: "));
		assert!(edit_view.ends_with("</callout>"));
		assert_eq!(
			render_ast_fault("ast<&>", "bad <pattern> & input").to_tml(),
			"<callout kind=error>ast&lt;&amp;&gt;: bad &lt;pattern&gt; &amp; input</callout>"
		);
	}
}
